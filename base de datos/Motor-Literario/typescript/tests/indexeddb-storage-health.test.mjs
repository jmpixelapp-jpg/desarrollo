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
    assert.equal(report.databaseVersion, 25);
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

test("la migración desde IndexedDB v24 conserva documentos existentes y crea la bandeja v25", async () => {
  await deleteDatabase();
  const legacy = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 24);
    request.onupgradeneeded = () => {
      const db = request.result;
      const documents = db.createObjectStore("documents", { keyPath: ["projectId", "documentId"] });
      documents.createIndex("by-project", "projectId", { unique: false });
      const changes = db.createObjectStore("changes", { keyPath: ["projectId", "documentId", "sequence"] });
      changes.createIndex("by-document-sequence", ["projectId", "documentId", "sequence"], { unique: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("No se pudo crear la base heredada."));
  });
  const original = {
    projectId: "migration-project",
    documentId: "chapter-before-upgrade",
    text: "Este manuscrito debe sobrevivir a la migración.",
    revision: 7,
    sequence: 12,
    updatedAt: 700
  };
  await new Promise((resolve, reject) => {
    const tx = legacy.transaction("documents", "readwrite");
    tx.objectStore("documents").put(original);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error ?? new Error("No se pudo preparar el documento heredado."));
    tx.onabort = () => reject(tx.error ?? new Error("Se canceló la preparación del documento heredado."));
  });
  legacy.close();

  const store = new IndexedDbProjectStore();
  try {
    const migrated = await store.loadDocument("migration-project", "chapter-before-upgrade");
    assert.deepEqual(migrated, original);
    const report = await store.inspectStorageHealth();
    assert.equal(report.databaseVersion, 25);
    assert.equal(report.recordCounts.documents, 1);
    assert.equal(report.recordCounts["sync-outbox"], 0);
    const pending = operationForMigration();
    await store.enqueueSyncOperation(pending);
    assert.equal((await store.loadPendingSyncOperations("migration-project")).length, 1);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});

function operationForMigration() {
  return {
    operationId: "migration-device-op-1",
    projectId: "migration-project",
    deviceId: "migration-device",
    sequence: 1,
    kind: "document-snapshot",
    payload: JSON.stringify({ documentId: "chapter-before-upgrade", revision: 7 }),
    createdAt: 701,
    attemptCount: 0
  };
}
