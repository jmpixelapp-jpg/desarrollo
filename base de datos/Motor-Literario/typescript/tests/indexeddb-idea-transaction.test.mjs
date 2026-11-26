import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbProjectStore } from "../dist/motor-literario.js";

globalThis.indexedDB ??= new IDBFactory();

const DATABASE_NAME = "motor-literario-local";
const projectId = "indexeddb-idea-transaction";

const idea = (extra = {}) => ({
  projectId,
  id: "idea-source",
  text: "La memoria transforma la ausencia.",
  status: "IDEA",
  originDocumentId: "chapter-1",
  sourceProjectName: "Libro transaccional",
  evidence: [],
  relatedEntityIds: [],
  relatedIdeaIds: [],
  statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }],
  ...extra
});

const entity = {
  projectId,
  id: "entity-memory",
  kind: "character",
  canonicalName: "Memoria",
  normalizedName: "memoria",
  aliases: [],
  evidence: [],
  firstSeenAt: 1,
  lastSeenAt: 1,
  extractionVersion: 1
};

function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("No se pudo limpiar IndexedDB."));
    request.onblocked = () => reject(new Error("La limpieza de IndexedDB quedó bloqueada."));
  });
}

test("IndexedDB revierte una idea inválida y conserva CAS frente a instantáneas obsoletas", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  const original = idea();

  try {
    await store.saveIdea(original);

    await assert.rejects(
      store.saveIdeaIfUnchanged(
        idea({ relatedEntityIds: ["entity-missing"] }),
        original
      ),
      /Referencia narrativa inválida/
    );

    assert.deepEqual(await store.loadIdeas(projectId), [original]);

    await store.saveEntity(entity);
    const linked = idea({ relatedEntityIds: [entity.id] });
    await store.saveIdeaIfUnchanged(linked, original);
    assert.deepEqual(await store.loadIdeas(projectId), [linked]);

    await assert.rejects(
      store.saveIdeaIfUnchanged(
        idea({ text: "Una edición obsoleta intenta imponerse." }),
        original
      ),
      /cambió en otra instancia/
    );
    assert.deepEqual(await store.loadIdeas(projectId), [linked]);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});


test("IndexedDB serializa dos CAS concurrentes sobre la misma idea y confirma solo uno", async () => {
  await deleteDatabase();
  const firstStore = new IndexedDbProjectStore();
  const secondStore = new IndexedDbProjectStore();
  const original = idea();

  try {
    await firstStore.saveIdea(original);
    const first = idea({ text: "Primera edición concurrente." });
    const second = idea({ text: "Segunda edición concurrente." });

    const outcomes = await Promise.allSettled([
      firstStore.saveIdeaIfUnchanged(first, original),
      secondStore.saveIdeaIfUnchanged(second, original)
    ]);

    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(result => result.status === "rejected").length, 1);
    const rejected = outcomes.find(result => result.status === "rejected");
    assert.match(String(rejected.reason?.message), /cambió en otra instancia/);

    const [durable] = await firstStore.loadIdeas(projectId);
    assert.ok([first.text, second.text].includes(durable.text));
  } finally {
    await Promise.all([firstStore.close(), secondStore.close()]);
    await deleteDatabase();
  }
});

test("IndexedDB valida destinos idea dentro del proyecto y revierte referencias inválidas", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  const original = idea();

  const relatedIdea = idea({
    id: "idea-related",
    text: "La ausencia conserva una forma.",
    relatedIdeaIds: []
  });
  const foreignIdea = idea({
    projectId: "indexeddb-idea-transaction-foreign",
    id: relatedIdea.id,
    text: "Mismo identificador, otro proyecto.",
    relatedIdeaIds: []
  });

  try {
    await store.saveIdea(original);
    await store.saveEntity(entity);

    await assert.rejects(
      store.saveIdeaIfUnchanged(
        idea({ relatedEntityIds: [entity.id], relatedIdeaIds: ["idea-missing"] }),
        original
      ),
      /Referencia narrativa inválida/
    );
    assert.deepEqual(await store.loadIdeas(projectId), [original]);

    await store.saveIdea(foreignIdea);
    await assert.rejects(
      store.saveIdeaIfUnchanged(
        idea({ relatedIdeaIds: [relatedIdea.id] }),
        original
      ),
      /Referencia narrativa inválida/
    );
    assert.deepEqual(await store.loadIdeas(projectId), [original]);

    await store.saveIdea(relatedIdea);
    const linked = idea({
      relatedEntityIds: [entity.id],
      relatedIdeaIds: [relatedIdea.id]
    });
    await store.saveIdeaIfUnchanged(linked, original);
    assert.deepEqual(
      (await store.loadIdeas(projectId)).find(record => record.id === original.id),
      linked
    );
  } finally {
    await store.close();
    await deleteDatabase();
  }
});
