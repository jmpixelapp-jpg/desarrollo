import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi, IndexedDbProjectStore } from "../dist/motor-literario.js";

const DATABASE_NAME = "motor-literario-local";
const writerId = "writer-library-pagination";
const firstProjectId = "library-book-a";
const secondProjectId = "library-book-b";
const foreignProjectId = "library-book-foreign";

function idea(projectId, id, extra = {}) {
  return {
    projectId,
    id,
    text: `Idea persistente ${id}.`,
    status: "IDEA",
    originDocumentId: "chapter-1",
    sourceProjectName: projectId === firstProjectId ? "Libro A"
      : projectId === secondProjectId ? "Libro B" : "Libro externo",
    evidence: [{
      documentId: "chapter-1",
      revision: 1,
      start: 0,
      end: 8,
      excerpt: "Fragmento"
    }],
    relatedEntityIds: [],
    relatedIdeaIds: [],
    statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }],
    ...extra
  };
}

function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("No se pudo limpiar IndexedDB."));
    request.onblocked = () => reject(new Error("La limpieza de IndexedDB quedó bloqueada."));
  });
}

test("biblioteca personal pagina por clave compuesta, valida vínculos externos y reinicia al cambiar la generación", {
  skip: typeof indexedDB === "undefined" ? "Este runtime no expone IndexedDB." : false
}, async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({
    projectId: firstProjectId,
    projectName: "Libro A",
    writerId
  });

  try {
    // La primera idea apunta a otra idea que quedará en la página siguiente.
    await store.saveIdea(idea(firstProjectId, "idea-b"));
    await store.saveIdea(idea(firstProjectId, "idea-a", {
      relatedIdeaIds: ["idea-b"]
    }));
    await store.archiveUnincorporatedIdeas(firstProjectId, writerId, "Libro A", 100);

    const firstPage = await api.getPersonalIdeaLibraryPage(null, 1);
    assert.deepEqual(firstPage.items.map(entry => entry.idea.id), ["idea-a"]);
    assert.equal(firstPage.libraryVersion, 1);
    assert.deepEqual(firstPage.items[0].idea.relatedIdeaIds, ["idea-b"]);
    assert.deepEqual(firstPage.nextCursor, {
      writerId,
      sourceProjectId: firstProjectId,
      ideaId: "idea-a",
      libraryVersion: 1
    });

    // La API valida que idea-b exista aunque no pertenezca a la página actual.
    const secondPage = await api.getPersonalIdeaLibraryPage(firstPage.nextCursor, 1);
    assert.deepEqual(secondPage.items.map(entry => entry.idea.id), ["idea-b"]);
    assert.equal(secondPage.libraryVersion, 1);
    assert.equal(secondPage.nextCursor, null);

    const grouped = await store.loadPersonalIdeasByKeys(writerId, [{
      sourceProjectId: firstProjectId,
      ideaId: "idea-b"
    }]);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].idea.id, "idea-b");

    // Una transferencia posterior aumenta la generación en la misma transacción.
    await store.saveIdea(idea(secondProjectId, "idea-c"));
    await store.archiveUnincorporatedIdeas(secondProjectId, writerId, "Libro B", 200);

    const staleContinuation = await api.getPersonalIdeaLibraryPage(firstPage.nextCursor, 1);
    assert.deepEqual(staleContinuation.items, []);
    assert.equal(staleContinuation.nextCursor, null);
    assert.equal(staleContinuation.libraryVersion, 2);
    assert.equal(staleContinuation.restartRequired, true);

    const restarted = await api.getPersonalIdeaLibraryPage(null, 2);
    assert.deepEqual(
      restarted.items.map(entry => [entry.sourceProjectId, entry.idea.id]),
      [[firstProjectId, "idea-a"], [firstProjectId, "idea-b"]]
    );
    assert.equal(restarted.libraryVersion, 2);
    assert.ok(restarted.nextCursor);

    // Un escritor diferente puede usar los mismos IDs sin contaminar esta biblioteca.
    await store.saveIdea(idea(foreignProjectId, "idea-a"));
    await store.archiveUnincorporatedIdeas(
      foreignProjectId, "writer-library-foreign", "Libro externo", 300
    );
    const ownLibrary = await api.getPersonalIdeaLibraryPage(null, 20);
    assert.equal(ownLibrary.items.some(entry =>
      entry.sourceProjectId === foreignProjectId
    ), false);

    await assert.rejects(
      api.getPersonalIdeaLibraryPage({
        ...restarted.nextCursor,
        writerId: "writer-library-foreign"
      }, 2),
      /Parámetros de paginación/
    );
    await assert.rejects(
      store.loadPersonalIdeasPage(writerId, restarted.nextCursor, 201),
      /Parámetros inválidos/
    );
  } finally {
    api.dispose();
    await store.close();
    await deleteDatabase();
  }
});
