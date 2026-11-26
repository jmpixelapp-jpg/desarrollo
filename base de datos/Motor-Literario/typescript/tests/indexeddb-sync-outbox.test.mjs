import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { IndexedDbProjectStore } from "../dist/motor-literario.js";

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;

const DATABASE_NAME = "motor-literario-local";
const operation = (extra = {}) => ({
  operationId: "op-device-a-1",
  projectId: "sync-outbox-project",
  deviceId: "device-a",
  sequence: 1,
  kind: "narrative-idea-upsert",
  payload: JSON.stringify({ ideaId: "idea-1", text: "La memoria persiste." }),
  createdAt: 100,
  attemptCount: 0,
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

test("la bandeja durable es idempotente, ordenada y conserva operaciones hasta el acuse", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  try {
    const first = operation();
    await store.enqueueSyncOperation(first);
    await store.enqueueSyncOperation(first);
    await store.enqueueSyncOperation(operation({
      operationId: "op-device-a-2", sequence: 2, createdAt: 200
    }));

    await assert.rejects(
      store.enqueueSyncOperation(operation({ payload: JSON.stringify({ ideaId: "different" }) })),
      /Colisión de idempotencia/
    );
    await assert.rejects(
      store.enqueueSyncOperation(operation({
        operationId: "op-device-bad-sequence",
        deviceId: "device-a",
        sequence: 1
      })),
      /Constraint|constraint|unique|already exists/i
    );

    let pending = await store.loadPendingSyncOperations("sync-outbox-project");
    assert.equal(pending.length, 2);
    assert.deepEqual(pending.map(item => item.sequence), [1, 2]);

    await store.recordSyncOperationAttempt(first.operationId, 300, "Red no disponible");
    pending = await store.loadPendingSyncOperations("sync-outbox-project");
    assert.equal(pending[0].attemptCount, 1);
    assert.equal(pending[0].lastAttemptAt, 300);
    assert.equal(pending[0].lastError, "Red no disponible");

    assert.equal(await store.acknowledgeSyncOperation(first.operationId), true);
    assert.equal(await store.acknowledgeSyncOperation(first.operationId), false);
    pending = await store.loadPendingSyncOperations("sync-outbox-project");
    assert.deepEqual(pending.map(item => item.operationId), ["op-device-a-2"]);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});

test("la bandeja aísla proyectos y valida el payload antes de persistir", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  try {
    await assert.rejects(
      store.enqueueSyncOperation(operation({ payload: "not-json" })),
      /JSON válido/
    );
    await assert.rejects(
      store.enqueueSyncOperation(operation({ payload: "[]" })),
      /objeto JSON/
    );
    await store.enqueueSyncOperation(operation());
    assert.equal((await store.loadPendingSyncOperations("another-project")).length, 0);
    assert.equal((await store.loadPendingSyncOperations("sync-outbox-project")).length, 1);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});
