import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
const { IndexedDbProjectStore, HostEngineApi, dispatchPendingNarrativeSyncOperations } = await import("../dist/motor-literario.js");

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

test("la migración DB27 → DB28 conserva datos anteriores y crea las dos estructuras de sincronización", async () => {
  const oldRequest = indexedDB.open("motor-literario-local", 27);
  const oldDatabase = await new Promise((resolve, reject) => {
    oldRequest.onupgradeneeded = () => oldRequest.result.createObjectStore("migration-sentinel");
    oldRequest.onsuccess = () => resolve(oldRequest.result);
    oldRequest.onerror = () => reject(oldRequest.error);
  });
  const seedTransaction = oldDatabase.transaction("migration-sentinel", "readwrite");
  seedTransaction.objectStore("migration-sentinel").put("dato-preservado", "key");
  await new Promise((resolve, reject) => {
    seedTransaction.oncomplete = resolve;
    seedTransaction.onerror = () => reject(seedTransaction.error);
    seedTransaction.onabort = () => reject(seedTransaction.error);
  });
  oldDatabase.close();

  const store = new IndexedDbProjectStore();
  assert.equal(await store.loadLastSyncOperationSequence("migration-project", "migration-device"), 0);
  const migratedRequest = indexedDB.open("motor-literario-local");
  const migrated = await new Promise((resolve, reject) => {
    migratedRequest.onsuccess = () => resolve(migratedRequest.result);
    migratedRequest.onerror = () => reject(migratedRequest.error);
  });
  assert.equal(migrated.version, 28);
  assert.equal(migrated.objectStoreNames.contains("migration-sentinel"), true);
  assert.equal(migrated.objectStoreNames.contains("sync-outbox"), true);
  assert.equal(migrated.objectStoreNames.contains("sync-device-sequences"), true);
  assert.equal(migrated.objectStoreNames.contains("narrative-reference-repair-audits"), true);
  assert.equal(migrated.objectStoreNames.contains("narrative-reference-repair-pending"), true);
  const preserved = await new Promise((resolve, reject) => {
    const request = migrated.transaction("migration-sentinel", "readonly")
      .objectStore("migration-sentinel").get("key");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  assert.equal(preserved, "dato-preservado");
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
  await store.enqueueSyncOperation(operation({
    operationId: "op-device-b",
    deviceId: "device-b",
    sequence: 1
  }));
  assert.equal(await store.loadLastSyncOperationSequence("project-a", "device-a"), 1);
  assert.equal(await store.loadLastSyncOperationSequence("project-a", "device-b"), 1);
  assert.equal((await store.loadPendingSyncOperations("project-a")).length, 2);
});

test("el journal y la outbox se confirman o revierten juntos ante una colisión", async () => {
  const store = new IndexedDbProjectStore();
  const projectId = "atomic-outbox-project";
  await store.saveDocument({
    projectId, documentId: "chapter", text: "", revision: 0, sequence: 0, updatedAt: 1
  });
  const firstChange = {
    projectId, documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "a", committedRevision: 1, committedAt: 10
  };
  const reusedOperation = {
    operationId: "atomic-operation", projectId, deviceId: "device-atomic",
    kind: "document.change", payload: JSON.stringify({ change: firstChange }), createdAt: 10
  };
  await store.appendChangeAndEnqueueSyncOperation(firstChange, reusedOperation);

  const secondChange = {
    projectId, documentId: "chapter", sequence: 2, baseRevision: 1,
    start: 1, end: 1, replacement: "b", committedRevision: 2, committedAt: 20
  };
  await assert.rejects(
    store.appendChangeAndEnqueueSyncOperation(secondChange, reusedOperation)
  );
  assert.deepEqual(await store.loadChanges(projectId, "chapter", 0), [firstChange]);
  assert.equal(await store.loadLastSyncOperationSequence(projectId, "device-atomic"), 1);
  assert.equal((await store.loadPendingSyncOperations(projectId)).length, 1);

  await store.appendChangeAndEnqueueSyncOperation(secondChange, {
    ...reusedOperation,
    operationId: "atomic-operation-2",
    payload: JSON.stringify({ change: secondChange }),
    createdAt: 20
  });
  assert.deepEqual((await store.loadChanges(projectId, "chapter", 0)).map(item => item.sequence), [1, 2]);
  assert.equal(await store.loadLastSyncOperationSequence(projectId, "device-atomic"), 2);
});

test("HostEngineApi conecta cada edición confirmada a la outbox con secuencia por dispositivo", async () => {
  const store = new IndexedDbProjectStore();
  const api = new HostEngineApi({ store });
  const projectId = "editor-outbox-bridge-project";
  api.initializeProject({
    projectId, projectName: "Libro sincronizable", deviceId: "stable-installation-id"
  });
  await api.openDocument({ documentId: "chapter-a", text: "A", revision: 0, sequence: 0 });
  await api.openDocument({ documentId: "chapter-b", text: "X", revision: 0, sequence: 0 });

  assert.equal(api.onEditorChange({
    documentId: "chapter-a", sequence: 1, baseRevision: 0, start: 1, end: 1, replacement: "B"
  }).status, "queued");
  assert.equal(api.onEditorChange({
    documentId: "chapter-b", sequence: 1, baseRevision: 0, start: 1, end: 1, replacement: "Y"
  }).status, "queued");
  await api.flushPendingChanges();

  const pending = [...await store.loadPendingSyncOperations(projectId)]
    .sort((left, right) => left.sequence - right.sequence);
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map(item => item.sequence), [1, 2]);
  assert.deepEqual(new Set(pending.map(item => item.deviceId)), new Set(["stable-installation-id"]));
  assert.deepEqual(new Set(pending.map(item => JSON.parse(item.payload).change.documentId)),
    new Set(["chapter-a", "chapter-b"]));
  assert.ok(pending.every(item => item.kind === "document.change"));
  assert.equal((await store.loadChanges(projectId, "chapter-a", 0)).length, 1);
  assert.equal((await store.loadChanges(projectId, "chapter-b", 0)).length, 1);
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

test("el despachador envuelve y envía la outbox en orden de secuencia por dispositivo", async () => {
  const store = new IndexedDbProjectStore();
  const projectId = "outbox-dispatch-project";
  const make = (operationId, deviceId, sequence, createdAt) => ({
    operationId, projectId, deviceId, sequence, kind: "document.change",
    payload: JSON.stringify({ version: 1, change: { documentId: "chapter", sequence } }),
    createdAt, attemptCount: 0
  });
  await store.enqueueSyncOperation(make("dispatch-a-1", "device-a", 1, 300));
  await store.enqueueSyncOperation(make("dispatch-a-2", "device-a", 2, 100));
  await store.enqueueSyncOperation(make("dispatch-b-1", "device-b", 1, 200));

  const sent = [];
  const result = await dispatchPendingNarrativeSyncOperations({
    store, projectId, batchSize: 10, now: () => 500,
    transport: {
      async send(envelope) {
        sent.push(envelope);
        return {
          status: "accepted", durable: true, projectId: envelope.projectId,
          operationId: envelope.operationId, writerId: envelope.writerId,
          sequence: envelope.sequence, digest: envelope.digest
        };
      }
    }
  });

  assert.deepEqual(result, { processed: 3, remaining: 0, hasMore: false });
  assert.deepEqual(sent.map(item => [item.writerId, item.sequence]), [
    ["device-a", 1], ["device-a", 2], ["device-b", 1]
  ]);
  assert.ok(sent.every(item => /^sha256:[a-f0-9]{64}$/.test(item.digest)));
  assert.equal((await store.loadPendingSyncOperations(projectId)).length, 0);
  assert.equal(await store.loadLastSyncOperationSequence(projectId, "device-a"), 2);
  assert.equal(await store.loadLastSyncOperationSequence(projectId, "device-b"), 1);
});

test("el despachador conserva pendientes si falla el transporte o el acuse no es durable y exacto", async () => {
  const store = new IndexedDbProjectStore();
  const projectId = "outbox-dispatch-failure-project";
  await store.enqueueSyncOperation(operation({
    operationId: "dispatch-retry-1", projectId, deviceId: "device-retry",
    sequence: 1, createdAt: 100, attemptCount: 0
  }));
  const invalidAck = await dispatchPendingNarrativeSyncOperations({
    store, projectId, now: () => 200,
    transport: { async send(envelope) {
      return { status: "accepted", durable: true, projectId,
        operationId: envelope.operationId, writerId: envelope.writerId,
        sequence: envelope.sequence, digest: "sha256:" + "0".repeat(64) };
    } }
  });
  assert.equal(invalidAck.failure, "invalid-remote-acknowledgement");
  let pending = await store.loadPendingSyncOperations(projectId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attemptCount, 1);
  assert.equal(pending[0].lastErrorCode, "INVALID_REMOTE_ACK");

  const transportFailure = await dispatchPendingNarrativeSyncOperations({
    store, projectId, now: () => 300,
    transport: { async send() { throw new Error("secreto de transporte que no debe persistirse"); } }
  });
  assert.equal(transportFailure.failure, "transport-error");
  pending = await store.loadPendingSyncOperations(projectId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attemptCount, 2);
  assert.equal(pending[0].lastErrorCode, "TRANSPORT_ERROR");
  assert.equal(await store.loadLastSyncOperationSequence(projectId, "device-retry"), 1);
});

test("el CAS de entidad y su outbox se confirman juntos y una colisión revierte ambos", async () => {
  const store = new IndexedDbProjectStore();
  assert.equal(store.supportsAtomicNarrativeSyncOutbox, true);
  const projectId = "atomic-entity-outbox-project";
  const deviceId = "atomic-entity-device";
  const original = {
    projectId, id: "entity-ada", kind: "character",
    canonicalName: "Ada", normalizedName: "ada", aliases: [],
    evidence: [{ documentId: "chapter-1", revision: 1, start: 0, end: 3, excerpt: "Ada" }],
    firstSeenAt: 10, lastSeenAt: 10, extractionVersion: 1
  };
  await store.saveEntity(original);
  const updated = {
    ...original, lastSeenAt: 20,
    evidence: [{ documentId: "chapter-1", revision: 2, start: 0, end: 3, excerpt: "Ada" }]
  };
  const draft = {
    operationId: "entity-outbox-op-1", projectId, deviceId,
    kind: "entity-upsert", payload: JSON.stringify({ entity: updated }), createdAt: 20
  };
  await store.saveEntityIfUnchanged(updated, original, draft);
  assert.deepEqual(await store.loadEntities(projectId), [updated]);
  let pending = await store.loadPendingSyncOperations(projectId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "entity-upsert");
  assert.equal(pending[0].sequence, 1);
  assert.deepEqual(JSON.parse(pending[0].payload), { entity: updated });

  await store.enqueueSyncOperation({
    operationId: "entity-outbox-collision", projectId, deviceId, sequence: 2,
    kind: "entity-upsert", payload: JSON.stringify({ entity: updated }),
    createdAt: 21, attemptCount: 0
  });
  const rejected = {
    ...updated, lastSeenAt: 30,
    evidence: [{ documentId: "chapter-1", revision: 3, start: 0, end: 3, excerpt: "Ada" }]
  };
  await assert.rejects(store.saveEntityIfUnchanged(rejected, updated, {
    operationId: "entity-outbox-collision", projectId, deviceId,
    kind: "entity-upsert", payload: JSON.stringify({ entity: rejected }), createdAt: 30
  }));
  assert.deepEqual(await store.loadEntities(projectId), [updated]);
  assert.equal(await store.loadLastSyncOperationSequence(projectId, deviceId), 2);
  pending = await store.loadPendingSyncOperations(projectId);
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map(item => item.operationId).sort(), [
    "entity-outbox-collision", "entity-outbox-op-1"
  ]);
});
