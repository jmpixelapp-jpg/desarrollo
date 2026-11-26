import test from "node:test";
import assert from "node:assert/strict";
import { NarrativeSyncCoordinator } from "../dist/motor-literario.js";

function operation(operationId, sequence, extra = {}) {
  return {
    operationId, projectId: "project-a", deviceId: "device-a", sequence,
    kind: "idea-upsert", payload: JSON.stringify({ id: operationId }),
    createdAt: sequence * 10, attemptCount: 0, ...extra
  };
}

function createOutbox(initial) {
  const pending = [...initial];
  const attempts = [];
  const acknowledged = [];
  return {
    pending, attempts, acknowledged,
    async loadPendingSyncOperations(projectId, limit) {
      return pending.filter(item => item.projectId === projectId).slice(0, limit);
    },
    async recordSyncOperationAttempt(id, at, error) {
      attempts.push({ id, at, error });
    },
    async acknowledgeSyncOperation(id) {
      const index = pending.findIndex(item => item.operationId === id);
      if (index < 0) return false;
      pending.splice(index, 1);
      acknowledged.push(id);
      return true;
    }
  };
}

test("solo retira operaciones aceptadas explícitamente y conserva conflictos/reintentos", async () => {
  const outbox = createOutbox([operation("op-1", 1), operation("op-2", 2), operation("op-3", 3)]);
  const coordinator = new NarrativeSyncCoordinator(outbox, {
    async push(projectId, operations) {
      assert.equal(projectId, "project-a");
      assert.deepEqual(operations.map(item => item.sequence), [1, 2, 3]);
      return {
        acknowledgedOperationIds: ["op-1"],
        conflicts: [{ operationId: "op-2", code: "revision_conflict" }],
        retryableOperationIds: ["op-3"]
      };
    }
  }, { now: () => 1234 });

  const result = await coordinator.syncOnce("project-a");
  assert.deepEqual(result, {
    projectId: "project-a", sent: 3, acknowledged: 1,
    conflicted: 1, retryable: 1, remaining: 2
  });
  assert.deepEqual(outbox.acknowledged, ["op-1"]);
  assert.equal(outbox.pending.length, 2);
  assert.equal(outbox.attempts.length, 3);
  assert.ok(outbox.attempts.every(item => item.at === 1234));
});

test("rechaza acuses de operaciones que no fueron enviadas sin borrar la bandeja", async () => {
  const outbox = createOutbox([operation("op-1", 1)]);
  const coordinator = new NarrativeSyncCoordinator(outbox, {
    async push() {
      return { acknowledgedOperationIds: ["foreign-op"], conflicts: [], retryableOperationIds: [] };
    }
  });
  await assert.rejects(coordinator.syncOnce("project-a"), /operación no enviada/);
  assert.equal(outbox.pending.length, 1);
  assert.equal(outbox.acknowledged.length, 0);
  assert.equal(outbox.attempts.length, 1);
});

test("coalesce envíos concurrentes del mismo proyecto", async () => {
  const outbox = createOutbox([operation("op-1", 1)]);
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const coordinator = new NarrativeSyncCoordinator(outbox, {
    async push() {
      calls++;
      await gate;
      return { acknowledgedOperationIds: ["op-1"], conflicts: [], retryableOperationIds: [] };
    }
  });
  const first = coordinator.syncOnce("project-a");
  const second = coordinator.syncOnce("project-a");
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("un fallo de transporte registra el intento y conserva las operaciones", async () => {
  const outbox = createOutbox([operation("op-1", 1)]);
  const coordinator = new NarrativeSyncCoordinator(outbox, {
    async push() { throw new Error("offline"); }
  }, { now: () => 55 });
  await assert.rejects(coordinator.syncOnce("project-a"), /offline/);
  assert.equal(outbox.pending.length, 1);
  assert.deepEqual(outbox.attempts, [{ id: "op-1", at: 55, error: "offline" }]);
});

test("valida el aislamiento del proyecto y los límites del lote", async () => {
  const outbox = createOutbox([operation("wrong-project", 1, { projectId: "project-b" })]);
  outbox.loadPendingSyncOperations = async () => outbox.pending;
  const coordinator = new NarrativeSyncCoordinator(outbox, {
    async push() { throw new Error("no debe enviar"); }
  });
  await assert.rejects(coordinator.syncOnce("project-a"), /fuera de contrato/);
  assert.throws(() => new NarrativeSyncCoordinator(outbox, { async push() {
    return { acknowledgedOperationIds: [], conflicts: [], retryableOperationIds: [] };
  } }, { batchSize: 501 }), /batchSize/);
});

test("permite sincronizar proyectos distintos en paralelo", async () => {
  const outbox = createOutbox([
    operation("op-a", 1, { projectId: "project-a" }),
    operation("op-b", 1, { projectId: "project-b", deviceId: "device-b" })
  ]);
  const started = new Set();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const coordinator = new NarrativeSyncCoordinator(outbox, {
    async push(projectId, operations) {
      started.add(projectId);
      await gate;
      return {
        acknowledgedOperationIds: operations.map(item => item.operationId),
        conflicts: [], retryableOperationIds: []
      };
    }
  });
  const a = coordinator.syncOnce("project-a");
  const b = coordinator.syncOnce("project-b");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual([...started].sort(), ["project-a", "project-b"]);
  release();
  await Promise.all([a, b]);
  assert.deepEqual(outbox.acknowledged.sort(), ["op-a", "op-b"]);
});

test("rechaza respuestas parciales que dejan operaciones sin clasificar", async () => {
  const outbox = createOutbox([operation("op-1", 1), operation("op-2", 2)]);
  const coordinator = new NarrativeSyncCoordinator(outbox, {
    async push() {
      return { acknowledgedOperationIds: ["op-1"], conflicts: [], retryableOperationIds: [] };
    }
  });
  await assert.rejects(coordinator.syncOnce("project-a"), /sin clasificar/);
  assert.equal(outbox.pending.length, 2);
  assert.equal(outbox.acknowledged.length, 0);
});

test("rechaza payloads que no sean objetos JSON antes de llamar al transporte", async () => {
  const outbox = createOutbox([operation("op-invalid", 1, { payload: "[]" })]);
  let pushed = false;
  const coordinator = new NarrativeSyncCoordinator(outbox, {
    async push() {
      pushed = true;
      return { acknowledgedOperationIds: [], conflicts: [], retryableOperationIds: [] };
    }
  });
  await assert.rejects(coordinator.syncOnce("project-a"), /objeto JSON/);
  assert.equal(pushed, false);
  assert.equal(outbox.pending.length, 1);
  assert.equal(outbox.attempts.length, 0);
});
