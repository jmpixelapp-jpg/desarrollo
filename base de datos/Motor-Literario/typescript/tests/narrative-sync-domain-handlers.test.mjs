import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createNarrativeSyncOperationEnvelope,
  createNarrativeSyncJournalConsumer,
  createNarrativeIdeaUpsertHandler,
  IndexedDbNarrativeSyncJournal
} from "../dist/motor-literario.js";

function createIdeaStore() {
  const ideas = new Map();
  return {
    ideas,
    async loadIdeas(projectId) {
      return [...ideas.values()].filter(idea => idea.projectId === projectId)
        .map(idea => structuredClone(idea));
    },
    async saveIdeaIfUnchanged(next, expected) {
      const current = ideas.get(next.id);
      assert.deepEqual(current, expected, "la escritura de idea debe respetar CAS");
      ideas.set(next.id, structuredClone(next));
    }
  };
}

function idea(overrides = {}) {
  return {
    projectId: "project-ideas",
    id: "idea:chapter-1:0",
    text: "Una ciudad recuerda los sueños de sus habitantes.",
    status: "IDEA",
    originDocumentId: "chapter-1",
    sourceProjectName: "La ciudad sumergida",
    evidence: [{
      documentId: "chapter-1", revision: 1, start: 6, end: 55,
      excerpt: "IDEA: Una ciudad recuerda los sueños de sus habitantes."
    }],
    statusHistory: [{ status: "IDEA", changedAt: 100, reason: "initial" }],
    ...overrides
  };
}

function journal() {
  return new IndexedDbNarrativeSyncJournal({
    databaseName: "narrative-idea-handler-" + Math.random().toString(36).slice(2)
  });
}

test("idea-upsert persiste una idea con CAS a través del consumidor durable", async () => {
  const store = createIdeaStore();
  const syncJournal = journal();
  const candidate = idea();
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "idea-operation-1",
    projectId: "project-ideas",
    writerId: "writer-1",
    sequence: 1,
    kind: "idea-upsert",
    payload: { idea: candidate }
  });
  await syncJournal.accept(envelope);

  const consume = createNarrativeSyncJournalConsumer(
    syncJournal, [createNarrativeIdeaUpsertHandler(store)]
  );
  assert.deepEqual(await consume("project-ideas", "writer-1"), {
    processed: 1, remaining: 0
  });
  assert.deepEqual(store.ideas.get(candidate.id), candidate);
  syncJournal.close();
});

test("idea-upsert es idempotente tras una caída entre CAS y acuse", async () => {
  const store = createIdeaStore();
  const syncJournal = journal();
  const candidate = idea();
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "idea-operation-retry",
    projectId: "project-ideas",
    writerId: "writer-1",
    sequence: 1,
    kind: "idea-upsert",
    payload: { idea: candidate }
  });
  await syncJournal.accept(envelope);

  let failAfterApply = true;
  const handler = createNarrativeIdeaUpsertHandler(store);
  const consumer = createNarrativeSyncJournalConsumer(syncJournal, [{
    ...handler,
    async apply(operation) {
      await handler.apply(operation);
      if (failAfterApply) {
        failAfterApply = false;
        throw new Error("simulated crash before journal acknowledgement");
      }
    }
  }]);

  const first = await consumer("project-ideas", "writer-1");
  assert.equal(first.processed, 0);
  assert.equal(first.remaining, 1);
  assert.deepEqual(store.ideas.get(candidate.id), candidate);

  assert.deepEqual(await consumer("project-ideas", "writer-1"), {
    processed: 1, remaining: 0
  });
  assert.equal(store.ideas.size, 1);
  syncJournal.close();
});

test("idea-upsert rechaza cruces de proyecto y conserva el registro previo ante conflicto CAS", async () => {
  const store = createIdeaStore();
  const syncJournal = journal();
  const existing = idea({ text: "Versión local", statusHistory: [
    { status: "IDEA", changedAt: 100, reason: "initial" }
  ] });
  store.ideas.set(existing.id, structuredClone(existing));
  const incoming = idea({ text: "Versión remota" });
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "idea-operation-conflict",
    projectId: "project-ideas",
    writerId: "writer-2",
    sequence: 1,
    kind: "idea-upsert",
    payload: { idea: incoming }
  });
  await syncJournal.accept(envelope);

  const conflictStore = {
    async loadIdeas() { return [structuredClone(existing)]; },
    async saveIdeaIfUnchanged() { throw new Error("CAS conflict"); }
  };
  const consume = createNarrativeSyncJournalConsumer(
    syncJournal, [createNarrativeIdeaUpsertHandler(conflictStore)]
  );
  const result = await consume("project-ideas", "writer-2");
  assert.equal(result.processed, 0);
  assert.equal(result.remaining, 1);
  assert.deepEqual(store.ideas.get(existing.id), existing);
  syncJournal.close();
});

test("validador del handler rechaza payloads incompletos", () => {
  const handler = createNarrativeIdeaUpsertHandler(createIdeaStore());
  assert.equal(handler.validate({ idea: idea() }), true);
  assert.equal(handler.validate({ idea: { ...idea(), evidence: "invalid" } }), false);
  assert.equal(handler.validate({ idea: null }), false);
});


test("idea-upsert rechaza referencias duplicadas e historiales de estado inválidos", () => {
  const handler = createNarrativeIdeaUpsertHandler(createIdeaStore());
  const base = idea();
  assert.equal(handler.validate({ idea: { ...base, relatedEntityIds: ["entity-1", "entity-1"] } }), false);
  assert.equal(handler.validate({ idea: { ...base, statusHistory: [
    { status: "unknown", reason: "writer", changedAt: 10 }
  ] } }), false);
  assert.equal(handler.validate({ idea: { ...base, evidence: [{
    documentId: "chapter-1", revision: -1, start: 0, end: 1, excerpt: "x"
  }] } }), false);
});

test("idea-upsert no permite que un sobre escriba en un proyecto distinto", async () => {
  const store = createIdeaStore();
  const handler = createNarrativeIdeaUpsertHandler(store);
  const candidate = idea({ projectId: "other-project" });
  await assert.rejects(handler.apply({
    projectId: "project-ideas",
    operationId: "wrong-project-op",
    writerId: "writer-1",
    sequence: 1,
    schemaVersion: 1,
    algorithm: "SHA-256",
    createdAt: 1,
    kind: "idea-upsert",
    payload: { idea: candidate },
    digest: "sha256:" + "0".repeat(64)
  }), /otro proyecto/u);
  assert.equal(store.ideas.size, 0);
});
