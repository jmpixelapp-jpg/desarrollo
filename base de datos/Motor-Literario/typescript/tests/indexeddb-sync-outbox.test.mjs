import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { IndexedDbProjectStore } from "../dist/motor-literario.js";

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;

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
    /ConstraintError|constraint|clave/i
  );
  assert.equal((await store.loadPendingSyncOperations("project-a")).length, 1);
});

test("la outbox pagina por proyecto, conserva pendientes y registra reintentos", async () => {
  const store = new IndexedDbProjectStore();
  await store.enqueueSyncOperation(operation({ operationId: "op-later", projectId: "project-b", deviceId: "device-b", sequence: 2, createdAt: 300 }));
  await store.enqueueSyncOperation(operation({ operationId: "op-first", projectId: "project-b", deviceId: "device-b", sequence: 1, createdAt: 100 }));
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

  assert.equal(await store.recordSyncOperationAttempt("op-first", 500, "network unavailable"), true);
  const retried = await store.loadPendingSyncOperations("project-b");
  assert.equal(retried[0].attemptCount, 1);
  assert.equal(retried[0].lastAttemptAt, 500);
  assert.equal(retried[0].lastError, "network unavailable");
  assert.equal(await store.recordSyncOperationAttempt("missing", 600), false);
});

test("el acuse elimina únicamente la operación confirmada y valida el payload", async () => {
  const store = new IndexedDbProjectStore();
  await assert.rejects(
    store.enqueueSyncOperation(operation({ projectId: "project-c", deviceId: "device-c", payload: "{invalid-json" })),
    /JSON válido/
  );
  await assert.rejects(
    store.enqueueSyncOperation(operation({ projectId: "project-c", deviceId: "device-c", payload: "[]" })),
    /objeto JSON/
  );

  await store.enqueueSyncOperation(operation({ operationId: "op-3", projectId: "project-c", deviceId: "device-c" }));
  assert.equal(await store.acknowledgeSyncOperation("op-3"), true);
  assert.equal(await store.acknowledgeSyncOperation("op-3"), false);
  assert.deepEqual(await store.loadPendingSyncOperations("project-c"), []);
});
