import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { IDBFactory } from "fake-indexeddb";

globalThis.indexedDB = new IDBFactory();
const { IndexedDbProjectStore } = await import("../dist/motor-literario.js");

function checkpoint(projectId, documentId, savedAt, overrides = {}) {
  return {
    version: 1,
    projectId,
    documentId,
    sessionId: "session-" + projectId,
    savedAt,
    sessionDurationMs: 100,
    activeDurationMs: 50,
    idleDurationMs: 50,
    lastActivityAgeMs: 20,
    pauseCount: 1,
    acceptedChanges: 1,
    rejectedChanges: 0,
    committedChanges: 1,
    failedChanges: 0,
    insertedCharacters: 5,
    deletedCharacters: 0,
    currentDocumentLength: 5,
    revision: 1,
    sequence: 1,
    resynchronizations: 0,
    lastCommitLatencyMs: 5,
    totalCommitLatencyMs: 5,
    commitLatencies: [5],
    ...overrides
  };
}

test("IndexedDB persiste, clona, ordena por timestamp y elimina checkpoints del monitor", async () => {
  const store = new IndexedDbProjectStore();
  const projectId = "live-author-monitor-" + randomUUID();
  const documentId = "chapter-" + randomUUID();

  try {
    const first = checkpoint(projectId, documentId, 1000);
    await store.saveLiveAuthorMonitorCheckpoint(first);

    const loaded = await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId);
    assert.deepEqual(loaded, first);
    assert.notEqual(loaded, first);
    assert.notEqual(loaded.commitLatencies, first.commitLatencies);

    // La lectura devuelve una copia aislada, no una referencia viva del almacén.
    loaded.commitLatencies[0] = 999;
    const reread = await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId);
    assert.deepEqual(reread.commitLatencies, [5]);

    await assert.rejects(
      store.saveLiveAuthorMonitorCheckpoint(checkpoint(projectId, documentId, 999)),
      /checkpoint anterior/
    );

    const newer = checkpoint(projectId, documentId, 2000, {
      sessionDurationMs: 250,
      activeDurationMs: 120,
      idleDurationMs: 130,
      committedChanges: 2,
      acceptedChanges: 2,
      insertedCharacters: 9,
      currentDocumentLength: 9,
      revision: 2,
      sequence: 2,
      lastCommitLatencyMs: 7,
      totalCommitLatencyMs: 12,
      commitLatencies: [5, 7]
    });
    await store.saveLiveAuthorMonitorCheckpoint(newer);
    assert.deepEqual(
      await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId),
      newer
    );
    assert.equal(
      await store.loadLiveAuthorMonitorCheckpoint(projectId + "-other", documentId),
      undefined
    );

    // close() no invalida la instancia: su próxima operación vuelve a abrir IndexedDB.
    await store.close();
    assert.deepEqual(
      await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId),
      newer
    );

    await store.deleteLiveAuthorMonitorCheckpoint(projectId, documentId);
    assert.equal(
      await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId),
      undefined
    );
  } finally {
    await store.close();
  }
});


test("migra IndexedDB v22 a v23 creando el almacén de checkpoints sin perder documentos", async () => {
  globalThis.indexedDB = new IDBFactory();
  const databaseName = "motor-literario-local";
  const projectId = "monitor-migration-" + randomUUID();
  const documentId = "chapter-" + randomUUID();
  const mappingUrl = new URL("../../MLDB/storage_mapping_v0.4.2.json", import.meta.url);
  const mapping = JSON.parse(await readFile(mappingUrl, "utf8"));
  const existingStores = mapping.runtime.object_stores.filter(
    descriptor => descriptor.name !== "live-author-monitor-checkpoints"
  );

  const legacyDatabase = await new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 22);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const descriptor of existingStores) {
        const objectStore = db.createObjectStore(descriptor.name, {
          keyPath: descriptor.keyPath
        });
        for (const [indexName, keyPath, unique = false] of descriptor.indexes ?? []) {
          objectStore.createIndex(indexName, keyPath, { unique });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const seedTransaction = legacyDatabase.transaction("documents", "readwrite");
  seedTransaction.objectStore("documents").put({
    projectId,
    documentId,
    text: "documento anterior a la migración",
    revision: 0,
    sequence: 0,
    updatedAt: 1
  });
  await new Promise((resolve, reject) => {
    seedTransaction.oncomplete = resolve;
    seedTransaction.onerror = () => reject(seedTransaction.error);
    seedTransaction.onabort = () => reject(seedTransaction.error);
  });
  assert.equal(legacyDatabase.version, 22);
  legacyDatabase.close();

  const store = new IndexedDbProjectStore();
  try {
    await store.saveLiveAuthorMonitorCheckpoint(checkpoint(projectId, documentId, 3000));
    const restoredCheckpoint = await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId);
    assert.equal(restoredCheckpoint.sequence, 1);
    await store.close();

    const migratedDatabase = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      assert.equal(migratedDatabase.version, 23);
      assert.equal(migratedDatabase.objectStoreNames.contains("live-author-monitor-checkpoints"), true);

      const checkpointStore = migratedDatabase.transaction(
        "live-author-monitor-checkpoints",
        "readonly"
      ).objectStore("live-author-monitor-checkpoints");
      assert.deepEqual(checkpointStore.keyPath, ["projectId", "documentId"]);
      assert.equal(checkpointStore.indexNames.contains("by-project"), true);
      assert.equal(checkpointStore.index("by-project").keyPath, "projectId");

      const document = await new Promise((resolve, reject) => {
        const transaction = migratedDatabase.transaction("documents", "readonly");
        const request = transaction.objectStore("documents").get([projectId, documentId]);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      assert.equal(document.text, "documento anterior a la migración");
      assert.equal(document.revision, 0);
    } finally {
      migratedDatabase.close();
    }
  } finally {
    await store.close();
  }
});
