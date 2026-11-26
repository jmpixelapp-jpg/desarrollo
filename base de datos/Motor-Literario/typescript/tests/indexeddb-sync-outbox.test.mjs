import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
const { IndexedDbProjectStore } = await import("../dist/motor-literario.js");

const operation = (overrides = {}) => ({
  operationId: "op-1",
  projectId: "project-a",
  deviceId: "device-a",
  sequence: 1,
  kind: "narrative.record.updated",
  payload: JSON.stringify({ recordId: "character-1", revision: 2 }),
  createdAt: 100,
  attemptCount: 0,
  ...overrides
});

test("la migración DB25 → DB26 conserva datos anteriores y crea las dos estructuras de sincronización", async () => {
  const oldRequest = indexedDB.open("motor-literario-local", 25);
  const oldDatabase = await new Promise((resolve, reject) => {
    oldRequest.onupgradeneeded = () => oldRequest.result.createObjectStore("migration-sentinel");
    oldRequest.onsuccess = () => resolve(oldRequest.result);
    oldRequest.onerror = () => reject(oldRequest.error);
  });
  oldDatabase.close();

  const store = new IndexedDbProjectStore();
  assert.equal(await store.loadLastSyncOperationSequence("migration-project", "migration-device"), 0);
  const migratedRequest = indexedDB.open("motor-literario-local");
  const migrated = await new Promise((resolve, reject) => {
    migratedRequest.onsuccess = () => resolve(migratedRequest.result);
    migratedRequest.onerror = () => reject(migratedRequest.error);
  });
  assert.equal(migrated.version, 26);
  assert.equal(migrated.objectStoreNames.contains("migration-sentinel"), true);
  assert.equal(migrated.objectStoreNames.contains("sync-outbox"), true);
  assert.equal(migrated.objectStoreNames.contains("sync-device-sequences"), true);
  migrated.close();
});
test("la outbox es idempotente, rechaza colisiones y aísla secuencias por dispositivo", async () => {
  const store = new IndexedDbProjectStore();
  await store.enqueueSyncOperation(operation());
  await store.enqueueSyncOperation(operation());

  assert.equal((await store.loadPendingSyncOperations("project-a")).length, 1);
  await assert.rejects(
    store.enqueueSyncOperation(operation({ payload: JSON.stringify({ recordId: "other" }) })),
    /Colisión/
  );
  await assert.rejects(
    store.enqueueSyncOperation(operation({
      operationId: "op-2",
      kind: "narrative.record.updated"
    })),
    /Secuencia fuera de orden/
  );
  assert.equal((await store.loadPendingSyncOperations("project-a")).length, 1);
});

test("la outbox pagina por proyecto, conserva pendientes y registra reintentos", async () => {
  const store = new IndexedDbProjectStore();
  await store.enqueueSyncOperation(operation({ operationId: "op-first", projectId: "project-b", deviceId: "device-b", sequence: 1, createdAt: 100 }));
  await store.enqueueSyncOperation(operation({ operationId: "op-later", projectId: "project-b", deviceId: "device-b", sequence: 2, createdAt: 300 }));
  await store.enqueueSyncOperation(operation({
    operationId: "op-other-project",
    projectId: "project-c",
    sequence: 1,
    createdAt: 50
  }));

  const firstPage = await store.loadPendingSyncOperations("project-b", 1);
  assert.deepEqual(firstPage.map(item => item.operationId), ["op-first"]);
  assert.deepEqual(
    (await store.loadPendingSyncOperations("project-b")).map(item => item.operationId),
    ["op-first", "op-later"]
  );

  assert.equal(await store.recordSyncOperationAttempt("op-first", 500, "NETWORK_UNAVAILABLE"), true);
  const retried = await store.loadPendingSyncOperations("project-b");
  assert.equal(retried[0].attemptCount, 1);
  assert.equal(retried[0].lastAttemptAt, 500);
  assert.equal(retried[0].lastErrorCode, "NETWORK_UNAVAILABLE");
  // Reintentar el mismo cambio tras actualizar metadatos no debe producir una colisión.
  await store.enqueueSyncOperation(operation({
    operationId: "op-first",
    projectId: "project-b",
    deviceId: "device-b",
    sequence: 1,
    createdAt: 100
  }));
  assert.equal((await store.loadPendingSyncOperations("project-b"))[0].attemptCount, 1);
  assert.equal(await store.recordSyncOperationAttempt("missing", 600), false);
});

test("el acuse elimina únicamente la operación confirmada y valida el payload", async () => {
  const store = new IndexedDbProjectStore();
  await assert.rejects(
    store.enqueueSyncOperation(operation({ projectId: "project-d", deviceId: "device-c", payload: "{invalid-json" })),
    /JSON válido/
  );
  await assert.rejects(
    store.enqueueSyncOperation(operation({ projectId: "project-d", deviceId: "device-c", payload: "[]" })),
    /objeto JSON/
  );

  await store.enqueueSyncOperation(operation({ operationId: "op-3", projectId: "project-d", deviceId: "device-c" }));
  assert.equal(await store.acknowledgeSyncOperation("op-3"), true);
  assert.equal(await store.loadLastSyncOperationSequence("project-d", "device-c"), 1);
  assert.equal(await store.acknowledgeSyncOperation("op-3"), false);
  assert.deepEqual(await store.loadPendingSyncOperations("project-d"), []);
  await assert.rejects(
    store.enqueueSyncOperation(operation({ operationId: "op-4", projectId: "project-d", deviceId: "device-c" })),
    /Secuencia fuera de orden/
  );
});
