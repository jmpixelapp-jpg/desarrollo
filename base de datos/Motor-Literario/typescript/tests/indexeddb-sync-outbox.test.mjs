import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { HostEngineApi, IndexedDbProjectStore, IndexedDbSyncExecutionLock, NarrativeSyncCoordinator } from "../dist/motor-literario.js";

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
    await Promise.all([firstStore.close(), secondStore.close()]);
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
    await store.close();
    await deleteDatabase();
  }
});


test("el adaptador recupera un lease vencido tras el cierre del propietario anterior", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  const now = Date.now();
  try {
    const abandoned = await store.acquireLiveAuthorMonitorLease(
      "expired-lease-project", "__narrative_sync_project__", "crashed-tab",
      now - 5_000, 1_000
    );
    assert.ok(abandoned);
    let ran = false;
    const lock = new IndexedDbSyncExecutionLock(store, {
      ownerId: "recovery-tab", now: () => now, leaseDurationMs: 1_000, pollIntervalMs: 25
    });
    await lock.runExclusive("narrative-sync:expired-lease-project", async () => {
      ran = true;
    });
    assert.equal(ran, true);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});


test("dos coordinadores completos comparten la bandeja y el lease antes de enviar", async () => {
  await deleteDatabase();
  const writerStore = new IndexedDbProjectStore();
  const firstStore = new IndexedDbProjectStore();
  const secondStore = new IndexedDbProjectStore();
  try {
    await writerStore.enqueueSyncOperation(operation({
      operationId: "op-real-shared-lock", projectId: "sync-outbox-project"
    }));
    const firstLock = new IndexedDbSyncExecutionLock(firstStore, {
      ownerId: "coordinator-one", leaseDurationMs: 1_000, pollIntervalMs: 25
    });
    const secondLock = new IndexedDbSyncExecutionLock(secondStore, {
      ownerId: "coordinator-two", leaseDurationMs: 1_000, pollIntervalMs: 25
    });
    let pushes = 0;
    const transport = {
      async push(_projectId, operations) {
        pushes++;
        assert.deepEqual(operations.map(item => item.operationId), ["op-real-shared-lock"]);
        await new Promise(resolve => setTimeout(resolve, 50));
        return {
          acknowledgedOperationIds: ["op-real-shared-lock"],
          conflicts: [],
          retryableOperationIds: []
        };
      }
    };
    const first = new NarrativeSyncCoordinator(firstStore, transport, { executionLock: firstLock });
    const second = new NarrativeSyncCoordinator(secondStore, transport, { executionLock: secondLock });
    const results = await Promise.all([
      first.syncOnce("sync-outbox-project"),
      second.syncOnce("sync-outbox-project")
    ]);
    assert.equal(pushes, 1);
    assert.equal(results.reduce((sum, result) => sum + result.acknowledged, 0), 1);
    assert.equal(await writerStore.countPendingSyncOperations("sync-outbox-project"), 0);
  } finally {
    await Promise.all([writerStore.close(), firstStore.close(), secondStore.close()]);
    await deleteDatabase();
  }
});


test("un lease antiguo no puede renovar ni liberar la titularidad tras el fencing takeover", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  const projectId = "fencing-project";
  const documentId = "__narrative_sync_project__";
  try {
    const stale = await store.acquireLiveAuthorMonitorLease(
      projectId, documentId, "old-owner", 10_000, 1_000
    );
    assert.ok(stale);
    const current = await store.acquireLiveAuthorMonitorLease(
      projectId, documentId, "new-owner", 11_001, 1_000
    );
    assert.ok(current);
    assert.ok(current.fencingToken > stale.fencingToken);
    assert.equal(await store.renewLiveAuthorMonitorLease(stale, 11_002, 1_000), undefined);
    assert.equal(await store.releaseLiveAuthorMonitorLease(stale, 11_003), false);
    const renewed = await store.renewLiveAuthorMonitorLease(current, 11_004, 1_000);
    assert.ok(renewed);
    assert.equal(renewed.ownerId, "new-owner");
  } finally {
    await store.close();
    await deleteDatabase();
  }
});


test("el heartbeat renueva el lease durante tareas que superan su duración inicial", async () => {
  await deleteDatabase();
  const firstStore = new IndexedDbProjectStore();
  const secondStore = new IndexedDbProjectStore();
  const firstLock = new IndexedDbSyncExecutionLock(firstStore, {
    ownerId: "heartbeat-owner", leaseDurationMs: 1_000, pollIntervalMs: 25
  });
  const secondLock = new IndexedDbSyncExecutionLock(secondStore, {
    ownerId: "waiting-owner", leaseDurationMs: 1_000, pollIntervalMs: 25
  });
  const order = [];
  try {
    const first = firstLock.runExclusive("narrative-sync:heartbeat-project", async () => {
      order.push("first:start");
      await new Promise(resolve => setTimeout(resolve, 1_250));
      order.push("first:end");
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    const second = secondLock.runExclusive("narrative-sync:heartbeat-project", async () => {
      order.push("second:start");
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
  } finally {
    await Promise.all([firstStore.close(), secondStore.close()]);
    await deleteDatabase();
  }
});


test("el lease se libera aunque falle la tarea y permite continuar a otro propietario", async () => {
  await deleteDatabase();
  const firstStore = new IndexedDbProjectStore();
  const secondStore = new IndexedDbProjectStore();
  const firstLock = new IndexedDbSyncExecutionLock(firstStore, {
    ownerId: "failing-owner", leaseDurationMs: 1_000, pollIntervalMs: 25
  });
  const secondLock = new IndexedDbSyncExecutionLock(secondStore, {
    ownerId: "recovery-owner", leaseDurationMs: 1_000, pollIntervalMs: 25
  });
  try {
    await assert.rejects(
      firstLock.runExclusive("narrative-sync:failure-release-project", async () => {
        throw new Error("simulated task failure");
      }),
      /simulated task failure/
    );
    let continued = false;
    await secondLock.runExclusive("narrative-sync:failure-release-project", async () => {
      continued = true;
    });
    assert.equal(continued, true);
  } finally {
    await Promise.all([firstStore.close(), secondStore.close()]);
    await deleteDatabase();
  }
});


test("el acuse por lote elimina operaciones en una transacción y es idempotente", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  try {
    await store.enqueueSyncOperation(operation({ operationId: "op-bulk-1", sequence: 1 }));
    await store.enqueueSyncOperation(operation({ operationId: "op-bulk-2", sequence: 2 }));
    assert.equal(await store.acknowledgeSyncOperations(["op-bulk-1", "op-bulk-2"]), 2);
    assert.equal(await store.acknowledgeSyncOperations(["op-bulk-1", "op-bulk-2"]), 0);
    assert.equal(await store.countPendingSyncOperations("sync-outbox-project"), 0);
    await assert.rejects(
      store.acknowledgeSyncOperations(["op-bulk-1", "op-bulk-1"]),
      /no contener duplicados/
    );
  } finally {
    await store.close();
    await deleteDatabase();
  }
});


test("el coordinador usa acuse atómico del almacén cuando el puerto lo ofrece", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  try {
    await store.enqueueSyncOperation(operation({ operationId: "op-coordinator-bulk-1", sequence: 1 }));
    await store.enqueueSyncOperation(operation({ operationId: "op-coordinator-bulk-2", sequence: 2 }));
    const coordinator = new NarrativeSyncCoordinator(store, {
      async push(_projectId, operations) {
        return {
          acknowledgedOperationIds: operations.map(item => item.operationId),
          conflicts: [],
          retryableOperationIds: []
        };
      }
    }, { now: () => 500 });
    const result = await coordinator.syncOnce("sync-outbox-project");
    assert.equal(result.acknowledged, 2);
    assert.equal(result.remaining, 0);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});


test("recupera aceptación remota cuando falla el commit local del lote de acuses", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  try {
    await store.enqueueSyncOperation(operation({
      operationId: "op-remote-committed-local-failed", sequence: 1
    }));
    const acceptedByServer = new Set();
    let pushes = 0;
    const transport = {
      async push(_projectId, operations) {
        pushes++;
        const ids = operations.map(item => item.operationId);
        for (const id of ids) acceptedByServer.add(id);
        return {
          acknowledgedOperationIds: ids.filter(id => acceptedByServer.has(id)),
          conflicts: [],
          retryableOperationIds: []
        };
      }
    };
    const originalAcknowledge = store.acknowledgeSyncOperations.bind(store);
    let failOnce = true;
    store.acknowledgeSyncOperations = async ids => {
      if (failOnce) {
        failOnce = false;
        throw new Error("local transaction aborted");
      }
      return originalAcknowledge(ids);
    };
    const coordinator = new NarrativeSyncCoordinator(store, transport, { now: () => 700 });
    await assert.rejects(
      coordinator.syncOnce("sync-outbox-project"),
      /local transaction aborted/
    );
    assert.equal(acceptedByServer.size, 1);
    assert.equal(await store.countPendingSyncOperations("sync-outbox-project"), 1);

    const recovered = await coordinator.syncOnce("sync-outbox-project");
    assert.equal(pushes, 2);
    assert.equal(recovered.acknowledged, 1);
    assert.equal(recovered.remaining, 0);
    assert.equal(acceptedByServer.size, 1);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});

test("IndexedDB conserva un conflicto entre ciclos y lo retira solo tras una aceptación posterior", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  try {
    const original = operation({
      operationId: "op-indexeddb-conflict-recovery",
      sequence: 1,
      payload: JSON.stringify({ ideaId: "idea-conflict", text: "Texto original" })
    });
    await store.enqueueSyncOperation(original);
    let now = 10_000;
    let pushes = 0;
    const sent = [];
    const coordinator = new NarrativeSyncCoordinator(store, {
      async push(_projectId, operations) {
        pushes++;
        sent.push(operations.map(item => ({
          operationId: item.operationId,
          payload: item.payload,
          attemptCount: item.attemptCount
        })));
        if (pushes === 1) {
          return {
            acknowledgedOperationIds: [],
            conflicts: [{ operationId: original.operationId, code: "revision_conflict", message: "Revisión remota distinta" }],
            retryableOperationIds: []
          };
        }
        return {
          acknowledgedOperationIds: [original.operationId],
          conflicts: [],
          retryableOperationIds: []
        };
      }
    }, {
      now: () => now,
      retryBaseDelayMs: 2_000,
      retryMaxDelayMs: 2_000,
      random: () => 1
    });

    const first = await coordinator.syncOnce(original.projectId);
    assert.equal(first.conflicted, 1);
    let pending = await store.loadPendingSyncOperations(original.projectId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].lastError, "conflict: revision_conflict: Revisión remota distinta");
    assert.equal(pending[0].nextAttemptAt, 12_000);
    assert.equal(pending[0].attemptCount, 1);

    now = 11_999;
    const held = await coordinator.syncOnce(original.projectId);
    assert.equal(held.sent, 0);
    assert.equal(pushes, 1);

    now = 12_000;
    const recovered = await coordinator.syncOnce(original.projectId);
    assert.equal(recovered.acknowledged, 1);
    assert.equal(recovered.remaining, 0);
    assert.equal(pushes, 2);
    assert.deepEqual(sent, [
      [{ operationId: original.operationId, payload: original.payload, attemptCount: 0 }],
      [{ operationId: original.operationId, payload: original.payload, attemptCount: 1 }]
    ]);
    pending = await store.loadPendingSyncOperations(original.projectId);
    assert.equal(pending.length, 0);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});


test("una propuesta local nueva no sobrescribe ni retira la operación que originó el conflicto", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  try {
    const conflicted = operation({
      operationId: "op-conflicted-original",
      sequence: 1,
      payload: JSON.stringify({ ideaId: "idea-merge", text: "Versión enviada" })
    });
    await store.enqueueSyncOperation(conflicted);
    await store.recordSyncOperationAttempt(
      conflicted.operationId, 500, "conflict: revision_conflict", 1_500
    );

    // Una edición/reconciliación manual debe producir otra identidad y otra
    // secuencia; no reutiliza el ID ni modifica el payload original.
    const replacement = operation({
      operationId: "op-manual-replacement",
      sequence: 2,
      payload: JSON.stringify({ ideaId: "idea-merge", text: "Versión revisada" }),
      createdAt: 600
    });
    await store.enqueueSyncOperation(replacement);

    const pending = await store.loadPendingSyncOperations(conflicted.projectId);
    assert.equal(pending.length, 2);
    assert.deepEqual(
      pending.map(item => [item.operationId, item.sequence, item.payload]),
      [
        [conflicted.operationId, 1, conflicted.payload],
        [replacement.operationId, 2, replacement.payload]
      ]
    );
    assert.equal(pending[0].lastError, "conflict: revision_conflict");
    assert.equal(pending[0].nextAttemptAt, 1_500);
    assert.notEqual(pending[0].operationId, pending[1].operationId);
    assert.notEqual(pending[0].payload, pending[1].payload);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});


test("dos instancias IndexedDB no pueden asignar la misma secuencia al mismo dispositivo", async () => {
  await deleteDatabase();
  const firstStore = new IndexedDbProjectStore();
  const secondStore = new IndexedDbProjectStore();
  try {
    const first = operation({
      operationId: "op-sequence-race-a", deviceId: "shared-device",
      sequence: 7, payload: JSON.stringify({ writer: "tab-a" })
    });
    const second = operation({
      operationId: "op-sequence-race-b", deviceId: "shared-device",
      sequence: 7, payload: JSON.stringify({ writer: "tab-b" })
    });
    const results = await Promise.allSettled([
      firstStore.enqueueSyncOperation(first),
      secondStore.enqueueSyncOperation(second)
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    const pending = await firstStore.loadPendingSyncOperations(first.projectId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].deviceId, "shared-device");
    assert.equal(pending[0].sequence, 7);
  } finally {
    await Promise.all([firstStore.close(), secondStore.close()]);
    await deleteDatabase();
  }
});


test("asigna secuencias consecutivas de forma atómica entre dos instancias IndexedDB", async () => {
  await deleteDatabase();
  const firstStore = new IndexedDbProjectStore();
  const secondStore = new IndexedDbProjectStore();
  try {
    await firstStore.enqueueSyncOperation(operation({
      operationId: "legacy-sequence-4", deviceId: "shared-device", sequence: 4
    }));
    const draft = (operationId, text) => ({
      operationId,
      projectId: "sync-outbox-project",
      deviceId: "shared-device",
      kind: "narrative-idea-upsert",
      payload: JSON.stringify({ text }),
      createdAt: 500,
      attemptCount: 0
    });
    const [a, b] = await Promise.all([
      firstStore.enqueueNextSyncOperation(draft("allocated-a", "A")),
      secondStore.enqueueNextSyncOperation(draft("allocated-b", "B"))
    ]);
    assert.deepEqual([a.sequence, b.sequence].sort((x, y) => x - y), [5, 6]);

    const replay = await firstStore.enqueueNextSyncOperation(draft("allocated-a", "A"));
    assert.equal(replay.sequence, a.sequence);
    await assert.rejects(
      secondStore.enqueueNextSyncOperation(draft("allocated-a", "payload diferente")),
      /Colisión de idempotencia/
    );
    const pending = await firstStore.loadPendingSyncOperations("sync-outbox-project");
    assert.deepEqual(
      pending.filter(item => item.deviceId === "shared-device").map(item => item.sequence),
      [4, 5, 6]
    );
  } finally {
    await Promise.all([firstStore.close(), secondStore.close()]);
    await deleteDatabase();
  }
});


test("dos instancias concurrentes recuperan la misma secuencia para un operationId idempotente", async () => {
  await deleteDatabase();
  const firstStore = new IndexedDbProjectStore();
  const secondStore = new IndexedDbProjectStore();
  try {
    const base = {
      projectId: "sync-outbox-project",
      deviceId: "same-operation-device",
      kind: "narrative-idea-upsert",
      createdAt: 700,
      attemptCount: 0
    };
    const [first, second] = await Promise.all([
      firstStore.enqueueNextSyncOperation({
        ...base, operationId: "same-allocated-operation",
        payload: JSON.stringify({ ideaId: "idea-7", text: "Persistente" })
      }),
      secondStore.enqueueNextSyncOperation({
        ...base, operationId: "same-allocated-operation",
        payload: JSON.stringify({ text: "Persistente", ideaId: "idea-7" })
      })
    ]);
    assert.equal(first.sequence, second.sequence);
    assert.equal(first.operationId, second.operationId);
    assert.equal(await firstStore.countPendingSyncOperations("sync-outbox-project"), 1);
  } finally {
    await Promise.all([firstStore.close(), secondStore.close()]);
    await deleteDatabase();
  }
});


test("HostEngineApi encola operaciones narrativas con proyecto activo y secuencia asignada", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  const api = new HostEngineApi({ store });
  try {
    api.initializeProject({ projectId: "host-sync-project", projectName: "Proyecto de sincronización" });
    const input = {
      operationId: "host-narrative-op-1",
      deviceId: "host-device-1",
      kind: "narrative-idea-upsert",
      payload: { ideaId: "idea-host-1", text: "Una idea confirmada." },
      createdAt: 900
    };
    const first = await api.enqueueNarrativeSyncOperation(input);
    const retry = await api.enqueueNarrativeSyncOperation(input);
    assert.equal(first.projectId, "host-sync-project");
    assert.equal(first.sequence, 1);
    assert.equal(retry.sequence, first.sequence);
    assert.equal(JSON.parse(first.payload).ideaId, "idea-host-1");
    assert.equal(await store.countPendingSyncOperations("host-sync-project"), 1);
  } finally {
    api.dispose();
    await store.close();
    await deleteDatabase();
  }
});

test("HostEngineApi no calcula secuencias si el almacén carece del asignador atómico", async () => {
  const api = new HostEngineApi({ store: {} });
  try {
    api.initializeProject({ projectId: "host-sync-no-allocator", projectName: "Proyecto sin asignador" });
    await assert.rejects(
      api.enqueueNarrativeSyncOperation({
        operationId: "must-not-fallback",
        deviceId: "device-1",
        kind: "narrative-change",
        payload: { revision: 1 },
        createdAt: 1
      }),
      /no implementa asignación atómica/
    );
  } finally {
    api.dispose();
  }
});
