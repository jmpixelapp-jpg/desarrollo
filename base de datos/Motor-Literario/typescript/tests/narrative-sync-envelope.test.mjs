import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalizeNarrativeSyncPayload,
  createNarrativeSyncEnvelope,
  verifyNarrativeSyncEnvelope,
  validateNarrativeSyncEnvelopeBatch
} from "../dist/motor-literario.js";

function input(extra = {}) {
  return {
    operationId: "op-device-a-1",
    projectId: "book-a",
    deviceId: "device-a",
    sequence: 1,
    kind: "idea-upsert",
    createdAt: 1_800_000_000_000,
    payload: { ideaId: "idea-1", text: "La memoria persiste." },
    ...extra
  };
}

test("crea sobres v1 con SHA-256 independiente y copia el payload", async () => {
  const payload = { text: "La memoria persiste.", ideaId: "idea-1" };
  const envelope = await createNarrativeSyncEnvelope(input({ payload }));
  const body = {
    protocol: "motor-literario-sync",
    protocolVersion: 1,
    operationId: envelope.operationId,
    projectId: envelope.projectId,
    deviceId: envelope.deviceId,
    sequence: envelope.sequence,
    kind: envelope.kind,
    createdAt: envelope.createdAt,
    payload: envelope.payload
  };
  const expected = createHash("sha256")
    .update(canonicalizeNarrativeSyncPayload(body), "utf8")
    .digest("hex");
  assert.equal(envelope.envelopeSha256, expected);
  payload.text = "cambiado después de crear el sobre";
  assert.equal(envelope.payload.text, "La memoria persiste.");
});

test("el SHA-256 no depende del orden de inserción de las claves", async () => {
  const first = await createNarrativeSyncEnvelope(input({
    payload: { idea: { text: "Luz", status: "IDEA" }, project: "book-a" }
  }));
  const reordered = await createNarrativeSyncEnvelope(input({
    payload: { project: "book-a", idea: { status: "IDEA", text: "Luz" } }
  }));
  assert.equal(first.envelopeSha256, reordered.envelopeSha256);
});

test("verifica un sobre recibido y devuelve una copia congelada", async () => {
  const created = await createNarrativeSyncEnvelope(input());
  const verified = await verifyNarrativeSyncEnvelope(created);
  assert.deepEqual(verified, created);
  assert.ok(Object.isFrozen(verified));
  assert.ok(Object.isFrozen(verified.payload));
  assert.throws(() => { verified.payload.text = "alteración"; }, TypeError);
});

test("rechaza contenido o metadatos modificados después de calcular el digest", async () => {
  const created = await createNarrativeSyncEnvelope(input());
  const changedPayload = { ...created, payload: { ...created.payload, text: "otra historia" } };
  const changedSequence = { ...created, sequence: 2 };
  await assert.rejects(verifyNarrativeSyncEnvelope(changedPayload), /SHA-256/u);
  await assert.rejects(verifyNarrativeSyncEnvelope(changedSequence), /SHA-256/u);
});

test("rechaza versiones, campos adicionales y digest malformado", async () => {
  const created = await createNarrativeSyncEnvelope(input());
  await assert.rejects(
    verifyNarrativeSyncEnvelope({ ...created, protocolVersion: 2 }),
    /versión/u
  );
  await assert.rejects(
    verifyNarrativeSyncEnvelope({ ...created, privateField: "not allowed" }),
    /propiedades ausentes, adicionales/u
  );
  await assert.rejects(
    verifyNarrativeSyncEnvelope({ ...created, envelopeSha256: "xyz" }),
    /64 dígitos/u
  );
});

test("valida identidades, secuencias, fechas y tipos de operación", async () => {
  for (const invalid of [
    input({ operationId: " " }),
    input({ projectId: " book-a " }),
    input({ deviceId: "" }),
    input({ sequence: 0 }),
    input({ sequence: Number.MAX_SAFE_INTEGER + 1 }),
    input({ createdAt: -1 }),
    input({ createdAt: 1.5 }),
    input({ kind: "IDEA-UPSERT" }),
    input({ kind: "idea upsert" }),
    input({ payload: [] }),
    input({ payload: null })
  ]) {
    await assert.rejects(createNarrativeSyncEnvelope(invalid));
  }
});

test("no ejecuta getters al leer los campos del sobre", async () => {
  let calls = 0;
  const candidate = input();
  Object.defineProperty(candidate, "payload", {
    enumerable: true,
    get() { calls++; return { text: "secreto" }; }
  });
  await assert.rejects(createNarrativeSyncEnvelope(candidate), /accessors/u);
  assert.equal(calls, 0);
});

test("valida lotes de un proyecto con IDs únicos y secuencias crecientes por dispositivo", async () => {
  const batch = await validateNarrativeSyncEnvelopeBatch([
    await createNarrativeSyncEnvelope(input({ sequence: 1 })),
    await createNarrativeSyncEnvelope(input({
      operationId: "op-device-a-2", sequence: 3
    })),
    await createNarrativeSyncEnvelope(input({
      operationId: "op-device-b-1", deviceId: "device-b", sequence: 1
    }))
  ], { expectedProjectId: "book-a" });
  assert.equal(batch.length, 3);
  assert.ok(Object.isFrozen(batch));
});

test("rechaza proyectos mezclados, IDs repetidos y secuencias repetidas o regresivas", async () => {
  const first = await createNarrativeSyncEnvelope(input({ sequence: 2 }));
  const projectB = await createNarrativeSyncEnvelope(input({
    operationId: "op-book-b", projectId: "book-b"
  }));
  const repeatedId = await createNarrativeSyncEnvelope(input({
    sequence: 3
  }));
  const regressed = await createNarrativeSyncEnvelope(input({
    operationId: "op-device-a-0", sequence: 1
  }));
  await assert.rejects(validateNarrativeSyncEnvelopeBatch([first, projectB]), /proyectos distintos/u);
  await assert.rejects(validateNarrativeSyncEnvelopeBatch([first, repeatedId]), /operationId duplicados/u);
  await assert.rejects(validateNarrativeSyncEnvelopeBatch([first, regressed]), /secuencias/u);
});

test("rechaza lotes con huecos, propiedades adicionales y tamaños excesivos", async () => {
  const first = await createNarrativeSyncEnvelope(input());
  const sparse = [];
  sparse.length = 1;
  await assert.rejects(validateNarrativeSyncEnvelopeBatch(sparse), /huecos/u);
  const extra = [first];
  extra.metadata = "not allowed";
  await assert.rejects(validateNarrativeSyncEnvelopeBatch(extra), /huecos/u);
  await assert.rejects(
    validateNarrativeSyncEnvelopeBatch([first, first], { maxBatchSize: 1 }),
    /máximo permitido/u
  );
  await assert.rejects(
    validateNarrativeSyncEnvelopeBatch([], { maxBatchSize: 501 }),
    /maxBatchSize/u
  );
});

test("aplica límites de canonicalización al sobre completo", async () => {
  await assert.rejects(
    createNarrativeSyncEnvelope(input(), { maxBytes: 64 }),
    /UTF-8/u
  );
});
