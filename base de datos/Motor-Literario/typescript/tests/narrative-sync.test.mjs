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
    async recordSyncOperationAttempt(id, at, error, nextAttemptAt) {
      attempts.push({ id, at, ...(error !== undefined ? { error } : {}),
        ...(nextAttemptAt !== undefined ? { nextAttemptAt } : {}) });
      const item = pending.find(candidate => candidate.operationId === id);
      if (!item) throw new Error("missing operation");
      delete item.lastError;
      delete item.nextAttemptAt;
      item.attemptCount++;
      item.lastAttemptAt = at;
      if (error !== undefined) item.lastError = error;
      if (nextAttemptAt !== undefined) item.nextAttemptAt = nextAttemptAt;
    },
    async countPendingSyncOperations(projectId) {
      return pending.filter(item => item.projectId === projectId).length;
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
  }, {
    now: () => 55,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 1_000,
    random: () => 1
  });
  await assert.rejects(coordinator.syncOnce("project-a"), /offline/);
  assert.equal(outbox.pending.length, 1);
  assert.deepEqual(outbox.attempts, [
    { id: "op-1", at: 55, error: "offline", nextAttemptAt: 1_055 }
  ]);
  assert.equal(outbox.pending[0].attemptCount, 1);
  assert.equal(outbox.pending[0].nextAttemptAt, 1_055);
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


test("aplica backoff exponencial persistente y no reintenta antes de la fecha programada", async () => {
  const outbox = createOutbox([operation("op-1", 1)]);
  let now = 500;
  let pushes = 0;
  const coordinator = new NarrativeSyncCoordinator(outbox, {
    async push() {
      pushes++;
      if (pushes === 1) throw new Error("offline");
      return { acknowledgedOperationIds: ["op-1"], conflicts: [], retryableOperationIds: [] };
    }
  }, {
    now: () => now,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 4_000,
    random: () => 1
  });

  await assert.rejects(coordinator.syncOnce("project-a"), /offline/);
  assert.equal(outbox.pending[0].nextAttemptAt, 1_500);

  const deferred = await coordinator.syncOnce("project-a");
  assert.deepEqual(deferred, {
    projectId: "project-a", sent: 0, acknowledged: 0,
    conflicted: 0, retryable: 0, remaining: 1
  });
  assert.equal(pushes, 1, "no debe enviar durante el backoff");

  now = 1_500;
  const retried = await coordinator.syncOnce("project-a");
  assert.equal(retried.acknowledged, 1);
  assert.equal(retried.remaining, 0);
  assert.equal(pushes, 2);
  assert.equal(outbox.pending.length, 0);
});

test("una operación retrasada bloquea la cola para conservar el orden de secuencia", async () => {
  const outbox = createOutbox([
    operation("op-1", 1, { nextAttemptAt: 2_000 }),
    operation("op-2", 2)
  ]);
  let pushes = 0;
  const coordinator = new NarrativeSyncCoordinator(outbox, {
    async push() {
      pushes++;
      return { acknowledgedOperationIds: ["op-1", "op-2"], conflicts: [], retryableOperationIds: [] };
    }
  }, { now: () => 1_000 });

  const result = await coordinator.syncOnce("project-a");
  assert.equal(result.sent, 0);
  assert.equal(result.remaining, 2);
  assert.equal(pushes, 0);
});


test("el backoff de un dispositivo no bloquea escritores independientes", async () => {
  const outbox = createOutbox([
    operation("op-a-1", 1, { deviceId: "device-a", nextAttemptAt: 2_000 }),
    operation("op-a-2", 2, { deviceId: "device-a" }),
    operation("op-b-1", 1, { deviceId: "device-b" }),
    operation("op-b-2", 2, { deviceId: "device-b" })
  ]);
  let sentIds = [];
  const coordinator = new NarrativeSyncCoordinator(outbox, {
    async push(_projectId, operations) {
      sentIds = operations.map(item => item.operationId);
      return {
        acknowledgedOperationIds: sentIds,
        conflicts: [], retryableOperationIds: []
      };
    }
  }, { now: () => 1_000 });

  const result = await coordinator.syncOnce("project-a");
  assert.deepEqual(sentIds, ["op-b-1", "op-b-2"]);
  assert.equal(result.sent, 2);
  assert.equal(result.acknowledged, 2);
  assert.deepEqual(outbox.pending.map(item => item.operationId), ["op-a-1", "op-a-2"]);
});

test("recupera un fallo durante el borrado parcial de acuses sin reenviar lo ya retirado", async () => {
  const outbox = createOutbox([operation("op-ack-1", 1), operation("op-ack-2", 2)]);
  const originalAcknowledge = outbox.acknowledgeSyncOperation;
  let failSecondAck = true;
  outbox.acknowledgeSyncOperation = async id => {
    if (id === "op-ack-2" && failSecondAck) {
      failSecondAck = false;
      throw new Error("indexeddb interrupted");
    }
    return originalAcknowledge(id);
  };
  const pushedBatches = [];
  const coordinator = new NarrativeSyncCoordinator(outbox, {
    async push(_projectId, operations) {
      const ids = operations.map(item => item.operationId);
      pushedBatches.push(ids);
      return { acknowledgedOperationIds: ids, conflicts: [], retryableOperationIds: [] };
    }
  }, { now: () => 10 });

  await assert.rejects(coordinator.syncOnce("project-a"), /indexeddb interrupted/);
  assert.deepEqual(outbox.pending.map(item => item.operationId), ["op-ack-2"]);

  const recovered = await coordinator.syncOnce("project-a");
  assert.equal(recovered.acknowledged, 1);
  assert.equal(recovered.remaining, 0);
  assert.deepEqual(pushedBatches, [["op-ack-1", "op-ack-2"], ["op-ack-2"]]);
  assert.deepEqual(outbox.acknowledged, ["op-ack-1", "op-ack-2"]);
});

test("rechaza códigos de conflicto excesivos y conserva la operación", async () => {
  const outbox = createOutbox([operation("op-oversized-code", 1)]);
  const coordinator = new NarrativeSyncCoordinator(outbox, {
    async push() {
      return {
        acknowledgedOperationIds: [],
        conflicts: [{ operationId: "op-oversized-code", code: "x".repeat(129) }],
        retryableOperationIds: []
      };
    }
  }, { now: () => 100, retryBaseDelayMs: 1_000, retryMaxDelayMs: 1_000, random: () => 1 });

  await assert.rejects(coordinator.syncOnce("project-a"), /código del conflicto supera el límite/);
  assert.equal(outbox.pending.length, 1, "una respuesta inválida no puede retirar la operación");
  assert.equal(outbox.acknowledged.length, 0);
  assert.equal(outbox.attempts.length, 1);
  assert.equal(outbox.attempts[0].error, "El código del conflicto supera el límite permitido.");
});


test("acepta el código de conflicto en el límite contractual de 128 caracteres", async () => {
  const outbox = createOutbox([operation("op-boundary-code", 1)]);
  const coordinator = new NarrativeSyncCoordinator(outbox, {
    async push() {
      return {
        acknowledgedOperationIds: [],
        conflicts: [{ operationId: "op-boundary-code", code: "c".repeat(128) }],
        retryableOperationIds: []
      };
    }
  }, { now: () => 200, retryBaseDelayMs: 1_000, retryMaxDelayMs: 1_000, random: () => 1 });

  const result = await coordinator.syncOnce("project-a");
  assert.equal(result.conflicted, 1);
  assert.equal(result.remaining, 1);
  assert.equal(outbox.pending.length, 1);
  assert.match(outbox.pending[0].lastError, /^conflict: /);
});

test("rechaza mensajes de conflicto que exceden 2.048 caracteres", async () => {
  const outbox = createOutbox([operation("op-oversized-message", 1)]);
  const coordinator = new NarrativeSyncCoordinator(outbox, {
    async push() {
      return {
        acknowledgedOperationIds: [],
        conflicts: [{
          operationId: "op-oversized-message",
          code: "revision_conflict",
          message: "m".repeat(2049)
        }],
        retryableOperationIds: []
      };
    }
  }, { now: () => 300, retryBaseDelayMs: 1_000, retryMaxDelayMs: 1_000, random: () => 1 });

  await assert.rejects(coordinator.syncOnce("project-a"), /mensaje del conflicto supera el límite/);
  assert.equal(outbox.pending.length, 1);
  assert.equal(outbox.acknowledged.length, 0);
  assert.equal(outbox.attempts.length, 1);
  assert.match(outbox.attempts[0].error, /mensaje del conflicto supera el límite/);
});


test("dos coordinadores comparten exclusión mutua por proyecto mediante el lock del anfitrión", async () => {
  const outbox = createOutbox([operation("op-cross-instance", 1)]);
  const tails = new Map();
  const lock = {
    async runExclusive(key, task) {
      const previous = tails.get(key) ?? Promise.resolve();
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const tail = previous.then(() => gate);
      tails.set(key, tail);
      await previous;
      try { return await task(); }
      finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    }
  };
  let pushes = 0;
  const transport = {
    async push(_projectId, operations) {
      pushes++;
      assert.deepEqual(operations.map(item => item.operationId), ["op-cross-instance"]);
      await new Promise(resolve => setImmediate(resolve));
      return { acknowledgedOperationIds: ["op-cross-instance"], conflicts: [], retryableOperationIds: [] };
    }
  };
  const first = new NarrativeSyncCoordinator(outbox, transport, { executionLock: lock, now: () => 100 });
  const second = new NarrativeSyncCoordinator(outbox, transport, { executionLock: lock, now: () => 100 });
  const results = await Promise.all([first.syncOnce("project-a"), second.syncOnce("project-a")]);
  assert.equal(pushes, 1);
  assert.equal(results.reduce((sum, result) => sum + result.acknowledged, 0), 1);
  assert.equal(outbox.pending.length, 0);
});
