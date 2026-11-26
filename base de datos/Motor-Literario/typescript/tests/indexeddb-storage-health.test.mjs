import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbProjectStore } from "../dist/motor-literario.js";

globalThis.indexedDB = new IDBFactory();

const DATABASE_NAME = "motor-literario-local";

function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("No se pudo limpiar IndexedDB."));
    request.onblocked = () => reject(new Error("La limpieza de IndexedDB quedó bloqueada."));
  });
}

test("la inspección de almacenamiento informa versión y conteos sin modificar los datos", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  try {
    await store.saveDocument({
      projectId: "storage-health-project",
      documentId: "chapter-1",
      text: "Texto durable",
      revision: 0,
      sequence: 0,
      updatedAt: 10
    });
    await store.saveIdea({
      projectId: "storage-health-project",
      id: "idea-1",
      text: "Una idea persistente.",
      status: "IDEA",
      originDocumentId: "chapter-1",
      sourceProjectName: "Libro",
      evidence: [],
      relatedEntityIds: [],
      relatedIdeaIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 10 }]
    });

    const report = await store.inspectStorageHealth();
    assert.equal(report.databaseName, DATABASE_NAME);
    assert.equal(report.databaseVersion, 24);
    assert.equal(report.recordCounts.documents, 1);
    assert.equal(report.recordCounts["narrative-ideas"], 1);
    assert.equal(report.recordCounts.changes, 0);
    assert.ok(report.usageBytes === null || (Number.isFinite(report.usageBytes) && report.usageBytes >= 0));
    assert.ok(report.quotaBytes === null || (Number.isFinite(report.quotaBytes) && report.quotaBytes >= 0));
    assert.ok(report.persistentStorage === null || typeof report.persistentStorage === "boolean");

    // La inspección es estrictamente de solo lectura.
    assert.equal((await store.loadDocument("storage-health-project", "chapter-1")).text, "Texto durable");
    assert.equal((await store.loadIdeas("storage-health-project")).length, 1);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});

test("solicitar almacenamiento persistente devuelve una decisión booleana", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  try {
    const result = await store.requestPersistentStorage();
    assert.equal(typeof result, "boolean");
  } finally {
    await store.close();
    await deleteDatabase();
  }
});
