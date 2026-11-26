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
