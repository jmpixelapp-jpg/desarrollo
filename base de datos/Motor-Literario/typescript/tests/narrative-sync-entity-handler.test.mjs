import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createNarrativeSyncOperationEnvelope,
  createNarrativeSyncJournalConsumer,
  createNarrativeEntityUpsertHandler,
  IndexedDbNarrativeSyncJournal
} from "../dist/motor-literario.js";

function createStore() {
  const entities = new Map();
  return {
    entities,
    async loadEntities(projectId) {
      return [...entities.values()].filter(item => item.projectId === projectId)
        .map(item => structuredClone(item));
    },
    async saveEntityIfUnchanged(next, expected) {
      assert.deepEqual(entities.get(next.id), expected);
      entities.set(next.id, structuredClone(next));
    }
  };
}

function entity(overrides = {}) {
  return {
    projectId: "novel-entities",
    id: "entity:ana",
    kind: "character",
    canonicalName: "Ana María",
    normalizedName: "ana maría",
    aliases: ["Ana"],
    evidence: [{
      documentId: "chapter-1", revision: 2, start: 0, end: 12,
      excerpt: "Ana María llegó."
    }],
    firstSeenAt: 10,
    lastSeenAt: 20,
    extractionVersion: 1,
    ...overrides
  };
}

function createJournal() {
  return new IndexedDbNarrativeSyncJournal({
    databaseName: "narrative-entity-handler-" + Math.random().toString(36).slice(2)
  });
}

test("entity-upsert persiste ficha mediante CAS", async () => {
  const store = createStore();
  const journal = createJournal();
  const candidate = entity();
  await journal.accept(await createNarrativeSyncOperationEnvelope({
    operationId: "entity-operation-1",
    projectId: "novel-entities",
    writerId: "writer-1",
    sequence: 1,
    kind: "entity-upsert",
    payload: { entity: candidate }
  }));
  const consume = createNarrativeSyncJournalConsumer(
    journal, [createNarrativeEntityUpsertHandler(store)]
  );
  assert.deepEqual(await consume("novel-entities", "writer-1"), {
    processed: 1, remaining: 0
  });
  assert.deepEqual(store.entities.get(candidate.id), candidate);
  journal.close();
});

test("entity-upsert es idempotente después de persistir antes del acuse", async () => {
  const store = createStore();
  const journal = createJournal();
  const candidate = entity();
  await journal.accept(await createNarrativeSyncOperationEnvelope({
    operationId: "entity-operation-retry",
    projectId: "novel-entities",
    writerId: "writer-1",
    sequence: 1,
    kind: "entity-upsert",
    payload: { entity: candidate }
  }));
  const handler = createNarrativeEntityUpsertHandler(store);
  let fail = true;
  const consume = createNarrativeSyncJournalConsumer(journal, [{
    ...handler,
    async apply(operation) {
      await handler.apply(operation);
      if (fail) {
        fail = false;
        throw new Error("simulated failure before ack");
      }
    }
  }]);
  assert.deepEqual(await consume("novel-entities", "writer-1"), {
    processed: 0, remaining: 1, stoppedAtOperationId: "entity-operation-retry", failure: "apply-or-ack-failed"
  });
  assert.deepEqual(await consume("novel-entities", "writer-1"), {
    processed: 1, remaining: 0
  });
  assert.equal(store.entities.size, 1);
  journal.close();
});

test("entity-upsert rechaza nombres normalizados incoherentes y rangos inválidos", () => {
  const handler = createNarrativeEntityUpsertHandler(createStore());
  assert.equal(handler.validate({ entity: entity() }), true);
  assert.equal(handler.validate({ entity: entity({ normalizedName: "ana" }) }), false);
  assert.equal(handler.validate({ entity: entity({
    evidence: [{ documentId: "chapter-1", revision: 2, start: 9, end: 2, excerpt: "x" }]
  }) }), false);
  assert.equal(handler.validate({ entity: entity({ lastSeenAt: 1 }) }), false);
  assert.equal(handler.validate({ entity: entity({ aliases: ["Ana", " ana "] }) }), false);
});
