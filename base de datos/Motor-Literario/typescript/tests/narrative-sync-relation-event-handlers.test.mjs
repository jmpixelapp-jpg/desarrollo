import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createNarrativeSyncOperationEnvelope,
  createNarrativeSyncJournalConsumer,
  createNarrativeRelationUpsertHandler,
  createNarrativeEventUpsertHandler,
  IndexedDbNarrativeSyncJournal
} from "../dist/motor-literario.js";

function createStore() {
  const relations = new Map();
  const events = new Map();
  const makeMethods = map => ({
    async load(projectId) {
      return [...map.values()].filter(item => item.projectId === projectId)
        .map(item => structuredClone(item));
    },
    async save(next, expected) {
      assert.deepEqual(map.get(next.id), expected);
      map.set(next.id, structuredClone(next));
    }
  });
  const relationMethods = makeMethods(relations);
  const eventMethods = makeMethods(events);
  return {
    relations, events,
    loadRelations: relationMethods.load,
    saveRelationIfUnchanged: relationMethods.save,
    loadEvents: eventMethods.load,
    saveEventIfUnchanged: eventMethods.save
  };
}

function evidence(documentId = "chapter-1") {
  return { documentId, revision: 3, start: 10, end: 28, excerpt: "Ana encuentra la llave." };
}

function relation(overrides = {}) {
  return {
    projectId: "novel-relations", id: "relation:ana:llave",
    fromEntityId: "character-ana", toEntityId: "object-key",
    relationType: "finds", evidence: [evidence()], ...overrides
  };
}

function event(overrides = {}) {
  return {
    projectId: "novel-relations", id: "event:ana-finds-key",
    label: "Ana encuentra la llave",
    participants: ["character-ana"],
    evidence: [evidence()],
    timeReference: { basis: "story-day", precision: "day-index", raw: "día 3", orderValue: 3 },
    ...overrides
  };
}

function journal() {
  return new IndexedDbNarrativeSyncJournal({
    databaseName: "narrative-rel-event-" + Math.random().toString(36).slice(2)
  });
}

test("relation-upsert aplica relación mediante CAS y confirma el diario", async () => {
  const store = createStore();
  const syncJournal = journal();
  const candidate = relation();
  await syncJournal.accept(await createNarrativeSyncOperationEnvelope({
    operationId: "relation-op-1", projectId: "novel-relations",
    writerId: "writer-1", sequence: 1, kind: "relation-upsert",
    payload: { relation: candidate }
  }));
  const consume = createNarrativeSyncJournalConsumer(
    syncJournal, [createNarrativeRelationUpsertHandler(store)]
  );
  assert.deepEqual(await consume("novel-relations", "writer-1"), {
    processed: 1, remaining: 0
  });
  assert.deepEqual(store.relations.get(candidate.id), candidate);
  syncJournal.close();
});

test("event-upsert aplica acontecimiento y conserva referencia temporal explícita", async () => {
  const store = createStore();
  const syncJournal = journal();
  const candidate = event();
  await syncJournal.accept(await createNarrativeSyncOperationEnvelope({
    operationId: "event-op-1", projectId: "novel-relations",
    writerId: "writer-1", sequence: 1, kind: "event-upsert",
    payload: { event: candidate }
  }));
  const consume = createNarrativeSyncJournalConsumer(
    syncJournal, [createNarrativeEventUpsertHandler(store)]
  );
  assert.deepEqual(await consume("novel-relations", "writer-1"), {
    processed: 1, remaining: 0
  });
  assert.deepEqual(store.events.get(candidate.id), candidate);
  syncJournal.close();
});

test("handlers de relación y acontecimiento rechazan referencias inválidas", () => {
  const store = createStore();
  const relationHandler = createNarrativeRelationUpsertHandler(store);
  const eventHandler = createNarrativeEventUpsertHandler(store);
  assert.equal(relationHandler.validate({ relation: relation() }), true);
  assert.equal(relationHandler.validate({ relation: relation({
    evidence: [{ ...evidence(), end: -1 }]
  }) }), false);
  assert.equal(eventHandler.validate({ event: event() }), true);
  assert.equal(eventHandler.validate({ event: event({
    participants: ["character-ana", "character-ana"]
  }) }), false);
  assert.equal(eventHandler.validate({ event: event({
    timeReference: { basis: "calendar", precision: "day-index", raw: "día 3", orderValue: 3 }
  }) }), false);
});
