import test from "node:test";
import assert from "node:assert/strict";
import {
  areNarrativeSyncPayloadsEquivalent,
  canonicalizeNarrativeSyncPayload,
  fingerprintNarrativeSyncPayload
} from "../dist/motor-literario.js";

test("canonicaliza objetos independientemente del orden de inserción", () => {
  const left = { projectId: "libro-1", operation: { sequence: 4, kind: "idea-upsert" } };
  const right = { operation: { kind: "idea-upsert", sequence: 4 }, projectId: "libro-1" };
  assert.equal(canonicalizeNarrativeSyncPayload(left), canonicalizeNarrativeSyncPayload(right));
  assert.equal(fingerprintNarrativeSyncPayload(left), fingerprintNarrativeSyncPayload(right));
  assert.equal(areNarrativeSyncPayloadsEquivalent(left, right), true);
});

test("conserva el orden de arrays y no normaliza Unicode de forma implícita", () => {
  assert.notEqual(
    canonicalizeNarrativeSyncPayload(["idea-a", "idea-b"]),
    canonicalizeNarrativeSyncPayload(["idea-b", "idea-a"])
  );
  assert.notEqual(
    fingerprintNarrativeSyncPayload({ text: "café" }),
    fingerprintNarrativeSyncPayload({ text: "cafe\u0301" })
  );
});

test("produce la misma huella para payloads equivalentes y distinta al cambiar contenido", () => {
  const first = { id: "idea-7", text: "La memoria persiste.", tags: ["memoria", "tiempo"] };
  const reordered = { tags: ["memoria", "tiempo"], text: "La memoria persiste.", id: "idea-7" };
  const changed = { ...first, text: "La memoria desaparece." };
  assert.equal(fingerprintNarrativeSyncPayload(first), fingerprintNarrativeSyncPayload(reordered));
  assert.notEqual(fingerprintNarrativeSyncPayload(first), fingerprintNarrativeSyncPayload(changed));
  assert.match(fingerprintNarrativeSyncPayload(first), /^fnv1a64:[0-9a-f]{16}$/u);
});

test("admite objetos sin prototipo y canoniza -0 como JSON 0", () => {
  const value = Object.create(null);
  value.count = -0;
  value.label = "idea";
  assert.equal(canonicalizeNarrativeSyncPayload(value), '{"count":0,"label":"idea"}');
});

test("rechaza valores no representables en JSON sin transformarlos silenciosamente", () => {
  for (const value of [undefined, 1n, Symbol("x"), () => 1, NaN, Infinity, -Infinity]) {
    assert.throws(() => canonicalizeNarrativeSyncPayload(value));
  }
  assert.throws(() => canonicalizeNarrativeSyncPayload({ value: undefined }));
  assert.throws(() => canonicalizeNarrativeSyncPayload({ value: Number.NaN }));
});

test("rechaza ciclos, arrays dispersos y prototipos personalizados", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeNarrativeSyncPayload(cyclic), /circular/u);

  const sparse = [];
  sparse.length = 2;
  sparse[1] = "idea";
  assert.throws(() => canonicalizeNarrativeSyncPayload(sparse), /disperso/u);

  const hiddenProperty = ["idea"];
  Object.defineProperty(hiddenProperty, "private", { value: "ignored", enumerable: false });
  assert.throws(() => canonicalizeNarrativeSyncPayload(hiddenProperty), /propiedades adicionales/u);

  const custom = Object.create({ inherited: true });
  custom.id = "idea";
  assert.throws(() => canonicalizeNarrativeSyncPayload(custom), /prototipo/u);
});

test("rechaza accessors sin ejecutarlos y propiedades Symbol", () => {
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "text", {
    enumerable: true,
    get() { getterCalls++; return "secret"; }
  });
  assert.throws(() => canonicalizeNarrativeSyncPayload(accessor), /accessor/u);
  assert.equal(getterCalls, 0);

  const symbolKeyed = { id: "idea", [Symbol("private")]: "value" };
  assert.throws(() => canonicalizeNarrativeSyncPayload(symbolKeyed), /Symbol/u);
});

test("aplica límites explícitos de profundidad, nodos y bytes UTF-8", () => {
  assert.throws(
    () => canonicalizeNarrativeSyncPayload({ a: { b: 1 } }, { maxDepth: 1 }),
    /profundidad/u
  );
  assert.throws(
    () => canonicalizeNarrativeSyncPayload({ a: 1, b: 2 }, { maxNodes: 2 }),
    /nodos/u
  );
  assert.throws(
    () => canonicalizeNarrativeSyncPayload({ text: "narrativa" }, { maxBytes: 8 }),
    /UTF-8/u
  );
  assert.throws(
    () => canonicalizeNarrativeSyncPayload({ id: "x" }, { maxBytes: 0 }),
    /entero positivo/u
  );
});


test("crea y verifica envolturas de operación con SHA-256", async () => {
  const { createNarrativeSyncOperationEnvelope, verifyNarrativeSyncOperationEnvelope } =
    await import("../dist/motor-literario.js");
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "op-01",
    projectId: "libro-1",
    writerId: "writer-a",
    sequence: 1,
    createdAt: 1_800_000_000_000,
    kind: "idea-upsert",
    payload: { id: "idea-1", text: "La memoria persiste." }
  });
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.algorithm, "SHA-256");
  assert.match(envelope.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(await verifyNarrativeSyncOperationEnvelope(envelope), true);
});

test("rechaza envolturas alteradas, incompletas o con secuencia inválida", async () => {
  const { createNarrativeSyncOperationEnvelope, verifyNarrativeSyncOperationEnvelope } =
    await import("../dist/motor-literario.js");
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "op-02",
    projectId: "libro-1",
    writerId: "writer-a",
    sequence: 2,
    kind: "document-revision",
    payload: { revision: 4 }
  });
  assert.equal(await verifyNarrativeSyncOperationEnvelope({
    ...envelope, payload: { revision: 5 }
  }), false);
  assert.equal(await verifyNarrativeSyncOperationEnvelope({
    ...envelope, sequence: 3
  }), false);
  assert.equal(await verifyNarrativeSyncOperationEnvelope({
    ...envelope, algorithm: "FNV-1a"
  }), false);
  assert.equal(await verifyNarrativeSyncOperationEnvelope({
    ...envelope, digest: "sha256:invalid"
  }), false);
  await assert.rejects(() => createNarrativeSyncOperationEnvelope({
    operationId: "op-03", projectId: "libro-1", writerId: "writer-a",
    sequence: 0, kind: "idea-upsert", payload: {}
  }), /secuencia/u);
});

test("la envoltura no confunde integridad con autenticación", async () => {
  const { createNarrativeSyncOperationEnvelope, verifyNarrativeSyncOperationEnvelope } =
    await import("../dist/motor-literario.js");
  const original = await createNarrativeSyncOperationEnvelope({
    operationId: "op-04", projectId: "libro-1", writerId: "writer-a",
    sequence: 4, kind: "idea-upsert", payload: { id: "idea-4" }
  });
  const forgedByRehashing = await createNarrativeSyncOperationEnvelope({
    ...original,
    writerId: "writer-b",
    payload: original.payload
  });
  assert.equal(await verifyNarrativeSyncOperationEnvelope(forgedByRehashing), true);
  assert.notEqual(forgedByRehashing.digest, original.digest);
});


test("diario IndexedDB acepta una secuencia, deduplica y sobrevive al reinicio", async () => {
  const { indexedDB } = await import("fake-indexeddb");
  const {
    createNarrativeSyncOperationEnvelope
  } = await import("../dist/motor-literario.js");
  const { IndexedDbNarrativeSyncJournal } = await import("../dist/motor-literario.js");
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = indexedDB;
  const databaseName = "sync-journal-test-" + Math.random().toString(36).slice(2);
  try {
    const journal = new IndexedDbNarrativeSyncJournal({ databaseName });
    const first = await createNarrativeSyncOperationEnvelope({
      operationId: "journal-op-1", projectId: "project-a", writerId: "writer-a",
      sequence: 1, createdAt: 100, kind: "idea-upsert", payload: { id: "idea-1" }
    });
    assert.deepEqual(await journal.accept(first), { status: "accepted", nextSequence: 2 });
    assert.deepEqual(await journal.accept(first), { status: "duplicate", nextSequence: 2 });
    assert.equal(await journal.getLastSequence("project-a", "writer-a"), 1);
    journal.close();

    const reopened = new IndexedDbNarrativeSyncJournal({ databaseName });
    assert.equal(await reopened.getLastSequence("project-a", "writer-a"), 1);
    const recovered = await reopened.loadOperations("project-a", "writer-a");
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].operationId, "journal-op-1");
    assert.deepEqual(await reopened.loadOperation("project-a", "journal-op-1"), recovered[0]);
    const second = await createNarrativeSyncOperationEnvelope({
      operationId: "journal-op-2", projectId: "project-a", writerId: "writer-a",
      sequence: 2, createdAt: 101, kind: "idea-upsert", payload: { id: "idea-2" }
    });
    assert.deepEqual(await reopened.accept(second), { status: "accepted", nextSequence: 3 });
    assert.deepEqual((await reopened.loadOperations("project-a", "writer-a")).map(item => item.sequence), [1, 2]);
    reopened.close();
  } finally {
    globalThis.indexedDB = previous;
    await new Promise(resolve => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }
});

test("diario rechaza huecos, replay y colisión de operationId sin avanzar cursor", async () => {
  const { indexedDB } = await import("fake-indexeddb");
  const { createNarrativeSyncOperationEnvelope, IndexedDbNarrativeSyncJournal } =
    await import("../dist/motor-literario.js");
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = indexedDB;
  const databaseName = "sync-journal-reject-" + Math.random().toString(36).slice(2);
  try {
    const journal = new IndexedDbNarrativeSyncJournal({ databaseName });
    const make = (operationId, sequence, payload = { value: sequence }) =>
      createNarrativeSyncOperationEnvelope({
        operationId, projectId: "project-b", writerId: "writer-b",
        sequence, createdAt: 200 + sequence, kind: "event-upsert", payload
      });
    const second = await make("op-2", 2);
    await assert.rejects(() => journal.accept(second), /Hueco de secuencia/u);
    assert.equal(await journal.getLastSequence("project-b", "writer-b"), 0);

    const first = await make("op-1", 1);
    await journal.accept(first);
    await assert.rejects(async () => journal.accept(await make("op-old", 1)), /Replay/u);
    await assert.rejects(async () => journal.accept(await make("op-1", 2, { changed: true })), /Conflicto/u);
    assert.equal(await journal.getLastSequence("project-b", "writer-b"), 1);
    journal.close();
  } finally {
    globalThis.indexedDB = previous;
    await new Promise(resolve => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }
});

test("diario mantiene secuencias aisladas por proyecto y escritor", async () => {
  const { indexedDB } = await import("fake-indexeddb");
  const { createNarrativeSyncOperationEnvelope, IndexedDbNarrativeSyncJournal } =
    await import("../dist/motor-literario.js");
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = indexedDB;
  const databaseName = "sync-journal-isolation-" + Math.random().toString(36).slice(2);
  try {
    const journal = new IndexedDbNarrativeSyncJournal({ databaseName });
    const envelope = await createNarrativeSyncOperationEnvelope({
      operationId: "isolated-op", projectId: "project-c", writerId: "writer-c",
      sequence: 1, kind: "idea-upsert", payload: { id: "idea-c" }
    });
    await journal.accept(envelope);
    assert.equal(await journal.getLastSequence("project-c", "writer-c"), 1);
    assert.equal(await journal.getLastSequence("project-c", "writer-d"), 0);
    assert.equal(await journal.getLastSequence("project-d", "writer-c"), 0);
    journal.close();
  } finally {
    globalThis.indexedDB = previous;
    await new Promise(resolve => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }
});


test("diario serializa recepciones concurrentes para una misma secuencia", async () => {
  const { indexedDB } = await import("fake-indexeddb");
  const { createNarrativeSyncOperationEnvelope, IndexedDbNarrativeSyncJournal } =
    await import("../dist/motor-literario.js");
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = indexedDB;
  const databaseName = "sync-journal-race-" + Math.random().toString(36).slice(2);
  try {
    const journal = new IndexedDbNarrativeSyncJournal({ databaseName });
    const make = operationId => createNarrativeSyncOperationEnvelope({
      operationId, projectId: "project-race", writerId: "writer-race",
      sequence: 1, createdAt: 300, kind: "idea-upsert", payload: { id: operationId }
    });
    const [left, right] = await Promise.all([make("race-left"), make("race-right")]);
    const results = await Promise.allSettled([journal.accept(left), journal.accept(right)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    assert.equal(await journal.getLastSequence("project-race", "writer-race"), 1);
    assert.equal((await journal.loadOperations("project-race", "writer-race")).length, 1);
    journal.close();
  } finally {
    globalThis.indexedDB = previous;
    await new Promise(resolve => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }
});
