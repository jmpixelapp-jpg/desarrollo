import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { IndexedDbProjectStore, IndexedDbSyncExecutionLock, NarrativeSyncCoordinator } from "../dist/motor-literario.js";

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

    await store.recordSyncOperationAttempt(first.operationId, 300, "Red no disponible", 600);
    pending = await store.loadPendingSyncOperations("sync-outbox-project");
    assert.equal(pending[0].attemptCount, 1);
    assert.equal(pending[0].lastAttemptAt, 300);
    assert.equal(pending[0].lastError, "Red no disponible");
    assert.equal(pending[0].nextAttemptAt, 600);
    assert.equal(await store.countPendingSyncOperations("sync-outbox-project"), 2);

    assert.equal(await store.acknowledgeSyncOperation(first.operationId), true);
    assert.equal(await store.acknowledgeSyncOperation(first.operationId), false);
    pending = await store.loadPendingSyncOperations("sync-outbox-project");
    assert.deepEqual(pending.map(item => item.operationId), ["op-device-a-2"]);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});

test("la recuperación respeta secuencias del escritor aunque createdAt llegue desordenado", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  try {
    await store.enqueueSyncOperation(operation({
      operationId: "op-sequence-1", sequence: 1, createdAt: 900
    }));
    await store.enqueueSyncOperation(operation({
      operationId: "op-sequence-2", sequence: 2, createdAt: 100
    }));
    await store.enqueueSyncOperation(operation({
      operationId: "op-other-device-1", deviceId: "device-b",
      sequence: 1, createdAt: 50
    }));

    const pending = await store.loadPendingSyncOperations("sync-outbox-project");
    assert.deepEqual(
      pending.map(item => [item.deviceId, item.sequence]),
      [["device-a", 1], ["device-a", 2], ["device-b", 1]]
    );
  } finally {
    await store.close();
    await deleteDatabase();
  }
});

test("la idempotencia ignora metadatos mutables y orden de claves del payload", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  try {
    const original = operation({
      payload: JSON.stringify({ ideaId: "idea-1", text: "La memoria persiste." })
    });
    await store.enqueueSyncOperation(original);
    await store.recordSyncOperationAttempt(original.operationId, 300, "timeout", 600);

    // Repetir la misma operación tras un intento es seguro aunque el payload
    // llegue con las propiedades en otro orden.
    await store.enqueueSyncOperation({
      ...original,
      payload: JSON.stringify({ text: "La memoria persiste.", ideaId: "idea-1" })
    });

    const pending = await store.loadPendingSyncOperations("sync-outbox-project");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].attemptCount, 1);
    assert.equal(pending[0].lastError, "timeout");
    assert.equal(pending[0].nextAttemptAt, 600);
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

test("el coordinador usa la bandeja IndexedDB real y conserva conflictos hasta su acuse", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  try {
    const first = operation({ operationId: "op-sync-1", sequence: 1 });
    const second = operation({ operationId: "op-sync-2", sequence: 2 });
    await store.enqueueSyncOperation(first);
    await store.enqueueSyncOperation(second);

    let pushCount = 0;
    let now = 500;
    const coordinator = new NarrativeSyncCoordinator(store, {
      async push(projectId, operations) {
        pushCount++;
        assert.equal(projectId, "sync-outbox-project");
        if (pushCount === 1) {
          return {
            acknowledgedOperationIds: ["op-sync-1"],
            conflicts: [{ operationId: "op-sync-2", code: "revision_conflict" }],
            retryableOperationIds: []
          };
        }
        return {
          acknowledgedOperationIds: ["op-sync-2"],
          conflicts: [],
          retryableOperationIds: []
        };
      }
    }, {
      now: () => now,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 1_000,
      random: () => 1
    });

    const firstResult = await coordinator.syncOnce("sync-outbox-project");
    assert.equal(firstResult.acknowledged, 1);
    assert.equal(firstResult.conflicted, 1);
    let pending = await store.loadPendingSyncOperations("sync-outbox-project");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].operationId, "op-sync-2");
    assert.equal(pending[0].attemptCount, 1);
    assert.equal(pending[0].lastAttemptAt, 500);
    assert.equal(pending[0].nextAttemptAt, 1_500);

    const deferred = await coordinator.syncOnce("sync-outbox-project");
    assert.equal(deferred.sent, 0);
    assert.equal(deferred.remaining, 1);
    assert.equal(pushCount, 1);

    now = 1_500;
    const secondResult = await coordinator.syncOnce("sync-outbox-project");
    assert.equal(secondResult.acknowledged, 1);
    assert.equal((await store.loadPendingSyncOperations("sync-outbox-project")).length, 0);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});


test("el adaptador IndexedDB serializa coordinadores con propietarios distintos", async () => {
  await deleteDatabase();
  const firstStore = new IndexedDbProjectStore();
  const secondStore = new IndexedDbProjectStore();
  const firstLock = new IndexedDbSyncExecutionLock(firstStore, {
    ownerId: "tab-owner-one", leaseDurationMs: 1_000, pollIntervalMs: 25
  });
  const secondLock = new IndexedDbSyncExecutionLock(secondStore, {
    ownerId: "tab-owner-two", leaseDurationMs: 1_000, pollIntervalMs: 25
  });
  let active = 0;
  let maximumActive = 0;
  const order = [];
  const run = (lock, label) => lock.runExclusive("narrative-sync:lease-project", async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    order.push(label + ":start");
    await new Promise(resolve => setTimeout(resolve, 60));
    order.push(label + ":end");
    active--;
  });
  try {
    await Promise.all([run(firstLock, "first"), run(secondLock, "second")]);
    assert.equal(maximumActive, 1);
    assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
  } finally {
    await deleteDatabase();
  }
});


test("un mismo adaptador no permite reentrada concurrente del mismo propietario", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  const lock = new IndexedDbSyncExecutionLock(store, {
    ownerId: "single-tab-owner", leaseDurationMs: 1_000, pollIntervalMs: 25
  });
  let active = 0;
  let maximumActive = 0;
  try {
    await Promise.all(["a", "b"].map(label => lock.runExclusive(
      "narrative-sync:local-queue-project",
      async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, 35));
        active--;
        return label;
      }
    )));
    assert.equal(maximumActive, 1);
  } finally {
    await deleteDatabase();
  }
});
