import test from "node:test";
import assert from "node:assert/strict";
import { createNarrativeEntityMergeHandler } from "../dist/motor-literario.js";

test("entity-merge delega la consolidación en la primitiva atómica del store", async () => {
  const calls = [];
  const store = {
    async mergeNarrativeEntityIdentity(...args) { calls.push(args); }
  };
  const handler = createNarrativeEntityMergeHandler(store);
  const operation = {
    projectId: "novel-merge",
    payload: {
      targetEntityId: "entity:ana",
      sourceEntityId: "entity:ana-maria",
      writerId: "writer-1"
    }
  };
  assert.equal(handler.validate(operation.payload), true);
  await handler.apply(operation);
  assert.deepEqual(calls, [[
    "novel-merge", "entity:ana", "entity:ana-maria", "writer-1"
  ]]);
});

test("entity-merge rechaza identidad vacía, origen igual al destino y escritor inválido", () => {
  const handler = createNarrativeEntityMergeHandler({
    async mergeNarrativeEntityIdentity() {}
  });
  assert.equal(handler.validate({
    targetEntityId: "entity:a", sourceEntityId: "entity:b"
  }), true);
  assert.equal(handler.validate({
    targetEntityId: "entity:a", sourceEntityId: "entity:a"
  }), false);
  assert.equal(handler.validate({
    targetEntityId: " ", sourceEntityId: "entity:b"
  }), false);
  assert.equal(handler.validate({
    targetEntityId: "entity:a", sourceEntityId: "entity:b", writerId: " "
  }), false);
});

test("entity-merge exige soporte atómico explícito del ProjectStore", () => {
  assert.throws(
    () => createNarrativeEntityMergeHandler({}),
    /mergeNarrativeEntityIdentity atómico/
  );
});
