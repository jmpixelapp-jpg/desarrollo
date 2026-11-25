import test from "node:test";
import assert from "node:assert/strict";
import { IndexedDbProjectStore } from "../dist/motor-literario.js";

const DATABASE_NAME = "motor-literario-local";
const projectId = "indexeddb-narrative-reference-integrity";

const entity = {
  projectId,
  id: "entity-origin",
  kind: "character",
  canonicalName: "Elena",
  normalizedName: "elena",
  aliases: [],
  evidence: [],
  firstSeenAt: 1,
  lastSeenAt: 1,
  extractionVersion: 1
};

const relation = (extra = {}) => ({
  projectId,
  id: "relation-origin-target",
  fromEntityId: entity.id,
  toEntityId: "entity-missing",
  relationType: "conoce",
  evidence: [],
  ...extra
});

const event = (extra = {}) => ({
  projectId,
  id: "event-meeting",
  label: "El encuentro",
  participants: ["entity-missing"],
  evidence: [],
  ...extra
});

const assertion = (extra = {}) => ({
  projectId,
  id: "assertion-age",
  entityId: "entity-missing",
  entityName: "Elena",
  attribute: "age",
  value: 28,
  evidence: {
    documentId: "chapter-1",
    revision: 1,
    start: 0,
    end: 12,
    excerpt: "Elena tiene 28 años."
  },
  capturedAt: 1,
  ...extra
});

function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("No se pudo limpiar IndexedDB."));
    request.onblocked = () => reject(new Error("La limpieza de IndexedDB quedó bloqueada."));
  });
}

test("IndexedDB valida referencias de relaciones, acontecimientos y afirmaciones en escrituras atómicas", {
  skip: typeof indexedDB === "undefined" ? "Este runtime no expone IndexedDB." : false
}, async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();

  try {
    await assert.rejects(store.saveRelation(relation()), /Referencia narrativa inválida/);
    await assert.rejects(store.saveEvent(event()), /Referencia narrativa inválida/);
    await assert.rejects(store.saveAssertion(assertion()), /Referencia narrativa inválida/);

    assert.deepEqual(await store.loadRelations(projectId), []);
    assert.deepEqual(await store.loadEvents(projectId), []);
    assert.deepEqual(await store.loadAssertions(projectId), []);

    await store.saveEntity(entity);

    const validRelation = relation({ toEntityId: entity.id });
    const validEvent = event({ participants: [entity.id] });
    const validAssertion = assertion({ entityId: entity.id });

    await store.saveRelation(validRelation);
    await store.saveEvent(validEvent);
    await store.saveAssertion(validAssertion);

    assert.deepEqual(await store.loadRelations(projectId), [validRelation]);
    assert.deepEqual(await store.loadEvents(projectId), [validEvent]);
    assert.deepEqual(await store.loadAssertions(projectId), [validAssertion]);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});
