import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createNarrativeSyncOperationEnvelope,
  createNarrativeSyncJournalConsumer,
  createNarrativeAssertionUpsertHandler,
  IndexedDbNarrativeSyncJournal
} from "../dist/motor-literario.js";

function createStore() {
  const assertions = new Map();
  return {
    assertions,
    async loadAssertions(projectId) {
      return [...assertions.values()].filter(item => item.projectId === projectId)
        .map(item => structuredClone(item));
    },
    async saveAssertionIfUnchanged(next, expected) {
      assert.deepEqual(assertions.get(next.id), expected);
      assertions.set(next.id, structuredClone(next));
    }
  };
}

function assertion(overrides = {}) {
  return {
    projectId: "novel-assertions",
    id: "assertion:character-ana:chapter-1:1:0:age",
    entityId: "character-ana",
    entityName: "Ana",
    attribute: "age",
    value: 27,
    evidence: {
      documentId: "chapter-1",
      revision: 1,
      start: 0,
      end: 18,
      excerpt: "Ana tiene 27 años."
    },
    capturedAt: 100,
    ...overrides
  };
}

function createJournal() {
  return new IndexedDbNarrativeSyncJournal({
    databaseName: "narrative-assertion-handler-" + Math.random().toString(36).slice(2)
  });
}

test("assertion-upsert persiste afirmaciones con CAS", async () => {
  const store = createStore();
  const journal = createJournal();
  const candidate = assertion();
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "assertion-operation-1",
    projectId: "novel-assertions",
    writerId: "writer-1",
    sequence: 1,
    kind: "assertion-upsert",
    payload: { assertion: candidate }
  });
  await journal.accept(envelope);
  const consume = createNarrativeSyncJournalConsumer(
    journal, [createNarrativeAssertionUpsertHandler(store)]
  );
  assert.deepEqual(await consume("novel-assertions", "writer-1"), {
    processed: 1, remaining: 0
  });
  assert.deepEqual(store.assertions.get(candidate.id), candidate);
  journal.close();
});

test("assertion-upsert es idempotente después de aplicar pero antes del acuse", async () => {
  const store = createStore();
  const journal = createJournal();
  const candidate = assertion();
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "assertion-operation-retry",
    projectId: "novel-assertions",
    writerId: "writer-1",
    sequence: 1,
    kind: "assertion-upsert",
    payload: { assertion: candidate }
  });
  await journal.accept(envelope);
  const handler = createNarrativeAssertionUpsertHandler(store);
  let shouldFail = true;
  const consume = createNarrativeSyncJournalConsumer(journal, [{
    ...handler,
    async apply(operation) {
      await handler.apply(operation);
      if (shouldFail) {
        shouldFail = false;
        throw new Error("simulated failure before ack");
      }
    }
  }]);
  assert.deepEqual(await consume("novel-assertions", "writer-1"), {
    processed: 0, remaining: 1, failure: "apply-or-ack-failed"
  });
  assert.deepEqual(await consume("novel-assertions", "writer-1"), {
    processed: 1, remaining: 0
  });
  assert.equal(store.assertions.size, 1);
  journal.close();
});

test("assertion-upsert rechaza evidencia inválida y cruces de proyecto", async () => {
  const store = createStore();
  const handler = createNarrativeAssertionUpsertHandler(store);
  assert.equal(handler.validate({ assertion: assertion() }), true);
  assert.equal(handler.validate({ assertion: assertion({
    evidence: { documentId: "chapter-1", revision: -1, start: 0, end: 1, excerpt: "x" }
  }) }), false);
  assert.equal(handler.validate({ assertion: assertion({
    timeReference: { basis: "calendar", precision: "day-index", raw: "día 4", orderValue: 4 }
  }) }), false);
  await assert.rejects(handler.apply({
    projectId: "another-project",
    operationId: "wrong-project",
    writerId: "writer-1",
    sequence: 1,
    schemaVersion: 1,
    algorithm: "SHA-256",
    createdAt: 100,
    kind: "assertion-upsert",
    payload: { assertion: assertion() },
    digest: "sha256:" + "0".repeat(64)
  }), /otro proyecto/u);
  assert.equal(store.assertions.size, 0);
});
