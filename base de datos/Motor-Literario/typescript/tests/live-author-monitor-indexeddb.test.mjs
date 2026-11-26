import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { IDBFactory } from "fake-indexeddb";

globalThis.indexedDB = new IDBFactory();
const { IndexedDbProjectStore } = await import("../dist/motor-literario.js");

async function acquireLease(store, projectId, documentId, ownerId = "owner-" + randomUUID(), now = Date.now(), durationMs = 30_000) {
  const lease = await store.acquireLiveAuthorMonitorLease(
    projectId,
    documentId,
    ownerId,
    now,
    durationMs
  );
  assert.ok(lease, "el lease debe quedar adquirido por este propietario");
  return lease;
}

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
    const lease = await acquireLease(store, projectId, documentId);
    const first = checkpoint(projectId, documentId, Date.now());
    await store.saveLiveAuthorMonitorCheckpoint(first, lease);

    const loaded = await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId);
    assert.deepEqual(loaded, first);
    assert.notEqual(loaded, first);
    assert.notEqual(loaded.commitLatencies, first.commitLatencies);

    // La lectura devuelve una copia aislada, no una referencia viva del almacén.
    loaded.commitLatencies[0] = 999;
    const reread = await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId);
    assert.deepEqual(reread.commitLatencies, [5]);

    await assert.rejects(
      store.saveLiveAuthorMonitorCheckpoint(checkpoint(projectId, documentId, first.savedAt - 1), lease),
      /checkpoint anterior/
    );

    const newer = checkpoint(projectId, documentId, Date.now() + 1, {
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
    await store.saveLiveAuthorMonitorCheckpoint(newer, lease);
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


test("migra IndexedDB v22 a v24 creando checkpoints y leases sin perder documentos", async () => {
  globalThis.indexedDB = new IDBFactory();
  const databaseName = "motor-literario-local";
  const projectId = "monitor-migration-" + randomUUID();
  const documentId = "chapter-" + randomUUID();
  const mappingUrl = new URL("../../MLDB/storage_mapping_v0.4.2.json", import.meta.url);
  const mapping = JSON.parse(await readFile(mappingUrl, "utf8"));
  const existingStores = mapping.runtime.object_stores.filter(
    descriptor => descriptor.name !== "live-author-monitor-checkpoints" &&
      descriptor.name !== "live-author-monitor-leases"
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
    const lease = await acquireLease(store, projectId, documentId);
    await store.saveLiveAuthorMonitorCheckpoint(
      checkpoint(projectId, documentId, Date.now()),
      lease
    );
    const restoredCheckpoint = await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId);
    assert.equal(restoredCheckpoint.sequence, 1);
    await store.close();

    const migratedDatabase = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      assert.equal(migratedDatabase.version, 24);
      assert.equal(migratedDatabase.objectStoreNames.contains("live-author-monitor-checkpoints"), true);
      assert.equal(migratedDatabase.objectStoreNames.contains("live-author-monitor-leases"), true);

      const leaseStore = migratedDatabase.transaction(
        "live-author-monitor-leases",
        "readonly"
      ).objectStore("live-author-monitor-leases");
      assert.deepEqual(leaseStore.keyPath, ["projectId", "documentId"]);
      assert.equal(leaseStore.indexNames.contains("by-project"), true);

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


test("rechaza checkpoints atrasados por revisión/secuencia aunque tengan timestamp más reciente", async () => {
  const store = new IndexedDbProjectStore();
  const projectId = "live-author-monitor-order-" + randomUUID();
  const documentId = "chapter-" + randomUUID();

  try {
    const lease = await acquireLease(store, projectId, documentId);
    const durable = checkpoint(projectId, documentId, Date.now(), {
      sessionDurationMs: 300,
      activeDurationMs: 180,
      idleDurationMs: 120,
      acceptedChanges: 5,
      committedChanges: 5,
      insertedCharacters: 15,
      currentDocumentLength: 20,
      revision: 5,
      sequence: 5,
      totalCommitLatencyMs: 25,
      commitLatencies: [5, 5, 5, 5, 5]
    });
    await store.saveLiveAuthorMonitorCheckpoint(durable, lease);

    await assert.rejects(
      store.saveLiveAuthorMonitorCheckpoint(checkpoint(projectId, documentId, Date.now() + 1, {
        revision: 4,
        sequence: 4,
        acceptedChanges: 99,
        committedChanges: 99
      }), lease),
      /revisión o secuencia durable anterior/
    );

    await assert.rejects(
      store.saveLiveAuthorMonitorCheckpoint(checkpoint(projectId, documentId, Date.now() + 2, {
        sessionId: durable.sessionId,
        sessionDurationMs: 200,
        activeDurationMs: 100,
        idleDurationMs: 100,
        acceptedChanges: 4,
        committedChanges: 4,
        insertedCharacters: 10,
        revision: 5,
        sequence: 5,
        totalCommitLatencyMs: 20,
        commitLatencies: [5, 5, 5, 5]
      }), lease),
      /hace retroceder la métrica/
    );

    const preserved = await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId);
    assert.deepEqual(preserved, durable);
  } finally {
    await store.close();
  }
});

test("permite iniciar una nueva identidad de sesión en el mismo snapshot durable", async () => {
  const store = new IndexedDbProjectStore();
  const projectId = "live-author-monitor-new-session-" + randomUUID();
  const documentId = "chapter-" + randomUUID();

  try {
    const lease = await acquireLease(store, projectId, documentId);
    const previous = checkpoint(projectId, documentId, Date.now());
    await store.saveLiveAuthorMonitorCheckpoint(previous, lease);

    const nextSession = checkpoint(projectId, documentId, Date.now() + 1, {
      sessionId: "new-session-" + randomUUID(),
      sessionDurationMs: 0,
      activeDurationMs: 0,
      idleDurationMs: 0,
      lastActivityAgeMs: null,
      pauseCount: 0,
      acceptedChanges: 0,
      rejectedChanges: 0,
      committedChanges: 0,
      failedChanges: 0,
      insertedCharacters: 0,
      deletedCharacters: 0,
      resynchronizations: 0,
      lastCommitLatencyMs: 0,
      totalCommitLatencyMs: 0,
      commitLatencies: []
    });
    await store.saveLiveAuthorMonitorCheckpoint(nextSession, lease);
    assert.deepEqual(
      await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId),
      nextSession
    );
  } finally {
    await store.close();
  }
});


test("dos pestañas compiten atómicamente y solo una adquiere el lease", async () => {
  const store = new IndexedDbProjectStore();
  const projectId = "live-author-monitor-race-" + randomUUID();
  const documentId = "chapter-" + randomUUID();
  const now = Date.now();

  try {
    const contenders = await Promise.all([
      store.acquireLiveAuthorMonitorLease(projectId, documentId, "tab-a", now, 30_000),
      store.acquireLiveAuthorMonitorLease(projectId, documentId, "tab-b", now, 30_000)
    ]);
    assert.equal(contenders.filter(Boolean).length, 1);
    const winner = contenders.find(Boolean);
    const loser = contenders[0] ? "tab-b" : "tab-a";
    assert.ok(winner);
    assert.equal(winner.fencingToken, 1);

    const lost = await store.acquireLiveAuthorMonitorLease(
      projectId,
      documentId,
      loser,
      now + 1,
      30_000
    );
    assert.equal(lost, undefined);

    const renewed = await store.renewLiveAuthorMonitorLease(winner, now + 2, 30_000);
    assert.ok(renewed);
    assert.equal(renewed.ownerId, winner.ownerId);
    assert.equal(renewed.fencingToken, winner.fencingToken);
    assert.ok(renewed.expiresAt > winner.expiresAt);

    const released = await store.releaseLiveAuthorMonitorLease(renewed, now + 3);
    assert.equal(released, true);
    const next = await store.acquireLiveAuthorMonitorLease(
      projectId,
      documentId,
      loser,
      now + 4,
      30_000
    );
    assert.ok(next);
    assert.equal(next.fencingToken, renewed.fencingToken + 1);
  } finally {
    await store.close();
  }
});

test("el fencing token invalida escrituras del propietario anterior tras expirar el lease", async () => {
  const store = new IndexedDbProjectStore();
  const projectId = "live-author-monitor-fence-" + randomUUID();
  const documentId = "chapter-" + randomUUID();
  const now = Date.now();

  try {
    const firstLease = await acquireLease(store, projectId, documentId, "tab-old", now, 30_000);
    const initial = checkpoint(projectId, documentId, now);
    await store.saveLiveAuthorMonitorCheckpoint(initial, firstLease);

    // Simula el instante exacto de expiración; el segundo propietario obtiene el fence siguiente.
    const takeover = await store.acquireLiveAuthorMonitorLease(
      projectId,
      documentId,
      "tab-new",
      firstLease.expiresAt,
      30_000
    );
    assert.ok(takeover);
    assert.equal(takeover.fencingToken, firstLease.fencingToken + 1);

    await assert.rejects(
      store.saveLiveAuthorMonitorCheckpoint(
        checkpoint(projectId, documentId, Date.now() + 1, {
          sessionId: "stale-session",
          revision: 1,
          sequence: 1
        }),
        firstLease
      ),
      /fencing token/
    );

    const nextCheckpoint = checkpoint(projectId, documentId, Date.now() + 2, {
      sessionId: "fresh-session",
      revision: 1,
      sequence: 1
    });
    await store.saveLiveAuthorMonitorCheckpoint(nextCheckpoint, takeover);
    assert.deepEqual(
      await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId),
      nextCheckpoint
    );

    assert.equal(await store.releaseLiveAuthorMonitorLease(firstLease, Date.now()), false);
    assert.equal(await store.releaseLiveAuthorMonitorLease(takeover, Date.now()), true);
  } finally {
    await store.close();
  }
});


test("un snapshot de lease anterior sigue válido mientras el fencing token persista y el lease se haya renovado", async () => {
  const store = new IndexedDbProjectStore();
  const projectId = "live-author-monitor-renewed-lease-" + randomUUID();
  const documentId = "chapter-" + randomUUID();
  const now = Date.now();

  try {
    const originalLease = await acquireLease(
      store,
      projectId,
      documentId,
      "same-tab",
      now,
      30_000
    );
    const renewedLease = await store.renewLiveAuthorMonitorLease(
      originalLease,
      now + 15_000,
      30_000
    );
    assert.ok(renewedLease);
    assert.equal(renewedLease.fencingToken, originalLease.fencingToken);

    // El snapshot original ya expiró según su expiresAt, pero el registro fue
    // renovado por el mismo propietario sin cambiar el fencing token.
    const renewedAgain = await store.renewLiveAuthorMonitorLease(
      originalLease,
      now + 31_000,
      30_000
    );
    assert.ok(renewedAgain);
    assert.equal(renewedAgain.fencingToken, originalLease.fencingToken);

    const currentCheckpoint = checkpoint(projectId, documentId, now + 32_000);
    await store.saveLiveAuthorMonitorCheckpoint(currentCheckpoint, originalLease);
    assert.deepEqual(
      await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId),
      currentCheckpoint
    );
  } finally {
    await store.close();
  }
});

test("rechaza una apertura IndexedDB bloqueada y vuelve a abrir al cerrar la conexión externa", async () => {
  globalThis.indexedDB = new IDBFactory();
  const databaseName = "motor-literario-local";
  const blocker = await new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 23);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const store = new IndexedDbProjectStore();

  try {
    await assert.rejects(
      store.loadLiveAuthorMonitorCheckpoint("blocked-project", "chapter-1"),
      /bloqueada por otra conexión/
    );
    blocker.close();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(
      await store.loadLiveAuthorMonitorCheckpoint("blocked-project", "chapter-1"),
      undefined,
      "una operación nueva debe abrir IndexedDB cuando desaparezca el bloqueo"
    );
  } finally {
    blocker.close();
    await store.close();
  }
});
