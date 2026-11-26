import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createNarrativeEntityMergeHandler,
  IndexedDbProjectStore
} from "../dist/motor-literario.js";

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


test("entity-merge tolera replay tras confirmar la transacción IndexedDB", async () => {
  const store = new IndexedDbProjectStore();
  const projectId = "merge-replay-" + Math.random().toString(36).slice(2);
  const makeEntity = (id, canonicalName, evidenceStart) => ({
    projectId, id, kind: "character", canonicalName,
    normalizedName: canonicalName.toLocaleLowerCase("es"),
    aliases: [], evidence: [{
      documentId: "chapter-1", revision: 1, start: evidenceStart,
      end: evidenceStart + canonicalName.length, excerpt: canonicalName
    }],
    firstSeenAt: evidenceStart, lastSeenAt: evidenceStart,
    extractionVersion: 1
  });
  await store.saveEntityIfUnchanged(makeEntity("entity:main", "Ana", 0));
  await store.saveEntityIfUnchanged(makeEntity("entity:duplicate", "Ana María", 10));
  const handler = createNarrativeEntityMergeHandler(store);
  const operation = {
    projectId,
    payload: {
      targetEntityId: "entity:main",
      sourceEntityId: "entity:duplicate"
    }
  };
  await handler.apply(operation);
  await assert.doesNotReject(() => handler.apply(operation));
  const entities = await store.loadEntities(projectId);
  assert.equal(entities.length, 1);
  assert.equal(entities[0].id, "entity:main");
  assert.deepEqual(entities[0].mergedFromIds, ["entity:duplicate"]);
  await store.close();
});
