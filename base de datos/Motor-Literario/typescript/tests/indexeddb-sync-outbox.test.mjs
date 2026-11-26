import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { readFile } from "node:fs/promises";

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
const { IndexedDbProjectStore, HostEngineApi, dispatchPendingNarrativeSyncOperations, createNarrativeSyncOperationEnvelope } = await import("../dist/motor-literario.js");

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

test("migra una DB27 existente a DB28 sin perder documentos ni la recuperación de reparaciones", async () => {
  const databaseName = "motor-literario-local";
  const projectId = "migration-project";
  const documentId = "chapter-before-db28";
  const repairOperationId = "repair-pending-before-db28";
  const auditOperationId = "repair-audit-before-db28";
  const mappingUrl = new URL("../../MLDB/storage_mapping_v0.4.2.json", import.meta.url);
  const mapping = JSON.parse(await readFile(mappingUrl, "utf8"));
  const existingStores = mapping.runtime.object_stores.filter(
    descriptor => !["sync-outbox", "sync-device-sequences"].includes(descriptor.name)
  );
  const oldRequest = indexedDB.open(databaseName, 27);
  const oldDatabase = await new Promise((resolve, reject) => {
    oldRequest.onupgradeneeded = () => {
      const db = oldRequest.result;
      for (const descriptor of existingStores) {
        const objectStore = db.createObjectStore(descriptor.name, { keyPath: descriptor.keyPath });
        for (const [indexName, keyPath, unique = false] of descriptor.indexes ?? []) {
          objectStore.createIndex(indexName, keyPath, { unique });
        }
      }
    };
    oldRequest.onsuccess = () => resolve(oldRequest.result);
    oldRequest.onerror = () => reject(oldRequest.error);
  });
  assert.equal(oldDatabase.version, 27);
  const seedTransaction = oldDatabase.transaction(
    ["documents", "narrative-reference-repair-pending", "narrative-reference-repair-audits"],
    "readwrite"
  );
  seedTransaction.objectStore("documents").put({
    projectId, documentId, text: "capítulo persistido antes de DB28",
    revision: 0, sequence: 0, updatedAt: 1
  });
  seedTransaction.objectStore("narrative-reference-repair-pending").put({
    projectId, operationId: repairOperationId, marker: "pending-repair-preserved"
  });
  seedTransaction.objectStore("narrative-reference-repair-audits").put({
    projectId, operationId: auditOperationId, marker: "repair-audit-preserved"
  });
  await new Promise((resolve, reject) => {
    seedTransaction.oncomplete = resolve;
    seedTransaction.onerror = () => reject(seedTransaction.error);
    seedTransaction.onabort = () => reject(seedTransaction.error);
  });
  oldDatabase.close();

  const store = new IndexedDbProjectStore();
  assert.equal(await store.loadLastSyncOperationSequence(projectId, "migration-device"), 0);
  const migratedRequest = indexedDB.open(databaseName);
  const migrated = await new Promise((resolve, reject) => {
    migratedRequest.onsuccess = () => resolve(migratedRequest.result);
    migratedRequest.onerror = () => reject(migratedRequest.error);
  });
  assert.equal(migrated.version, 28);
  assert.equal(migrated.objectStoreNames.contains("sync-outbox"), true);
  assert.equal(migrated.objectStoreNames.contains("sync-device-sequences"), true);
  assert.equal(migrated.objectStoreNames.contains("narrative-reference-repair-audits"), true);
  assert.equal(migrated.objectStoreNames.contains("narrative-reference-repair-pending"), true);
  assert.equal(
    migrated.transaction("narrative-reference-repair-pending", "readonly")
      .objectStore("narrative-reference-repair-pending").index("by-project").keyPath,
    "projectId"
  );
  const preserved = await new Promise((resolve, reject) => {
    const transaction = migrated.transaction(
      ["documents", "narrative-reference-repair-pending", "narrative-reference-repair-audits"],
      "readonly"
    );
    const results = {};
    const requests = [
      ["document", transaction.objectStore("documents").get([projectId, documentId])],
      ["pending", transaction.objectStore("narrative-reference-repair-pending").get([projectId, repairOperationId])],
      ["audit", transaction.objectStore("narrative-reference-repair-audits").get([projectId, auditOperationId])]
    ];
    for (const [name, request] of requests) request.onsuccess = () => { results[name] = request.result; };
    transaction.oncomplete = () => resolve(results);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  assert.equal(preserved.document.text, "capítulo persistido antes de DB28");
  assert.equal(preserved.pending.marker, "pending-repair-preserved");
  assert.equal(preserved.audit.marker, "repair-audit-preserved");
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

  const pendingOperation = operation({ operationId: "op-3", projectId: "project-d", deviceId: "device-c" });
  await store.enqueueSyncOperation(pendingOperation);
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: pendingOperation.operationId,
    projectId: pendingOperation.projectId,
    writerId: pendingOperation.deviceId,
    sequence: pendingOperation.sequence,
    createdAt: pendingOperation.createdAt,
    kind: pendingOperation.kind,
    payload: JSON.parse(pendingOperation.payload)
  });
  const acknowledgement = {
    status: "accepted", durable: true, projectId: envelope.projectId,
    operationId: envelope.operationId, writerId: envelope.writerId,
    sequence: envelope.sequence, digest: envelope.digest
  };
  assert.equal(await store.acknowledgeSyncOperation({
    ...acknowledgement, projectId: "other-project"
  }), false);
  assert.equal(await store.acknowledgeSyncOperation({
    ...acknowledgement, durable: false
  }), false);
  assert.equal(await store.acknowledgeSyncOperation({
    ...acknowledgement, digest: "sha256:" + "0".repeat(64)
  }), false);
  assert.equal((await store.loadPendingSyncOperations("project-d")).length, 1);
  assert.equal(await store.acknowledgeSyncOperation(acknowledgement), true);
  assert.equal(await store.loadLastSyncOperationSequence("project-d", "device-c"), 1);
  assert.equal(await store.acknowledgeSyncOperation(acknowledgement), false);
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


test("el acuse no elimina una operación si el contenido local cambió después del envío", async () => {
  const store = new IndexedDbProjectStore();
  const pendingOperation = operation({
    operationId: "ack-stale-content",
    projectId: "ack-stale-project",
    deviceId: "ack-stale-device"
  });
  await store.enqueueSyncOperation(pendingOperation);
  const sentEnvelope = await createNarrativeSyncOperationEnvelope({
    operationId: pendingOperation.operationId,
    projectId: pendingOperation.projectId,
    writerId: pendingOperation.deviceId,
    sequence: pendingOperation.sequence,
    createdAt: pendingOperation.createdAt,
    kind: pendingOperation.kind,
    payload: JSON.parse(pendingOperation.payload)
  });
  const acknowledgement = {
    status: "accepted", durable: true, projectId: sentEnvelope.projectId,
    operationId: sentEnvelope.operationId, writerId: sentEnvelope.writerId,
    sequence: sentEnvelope.sequence, digest: sentEnvelope.digest
  };

  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("motor-literario-local");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const transaction = database.transaction("sync-outbox", "readwrite");
    const outbox = transaction.objectStore("sync-outbox");
    const request = outbox.get(pendingOperation.operationId);
    request.onsuccess = () => outbox.put({
      ...request.result,
      payload: JSON.stringify({ recordId: "different-content", revision: 99 })
    });
    request.onerror = () => reject(request.error);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();

  assert.equal(await store.acknowledgeSyncOperation(acknowledgement), false);
  const [stillPending] = await store.loadPendingSyncOperations(pendingOperation.projectId);
  assert.equal(stillPending.operationId, pendingOperation.operationId);
  assert.deepEqual(JSON.parse(stillPending.payload), {
    recordId: "different-content", revision: 99
  });
});


test("el despachador saliente no envía si otra pestaña mantiene el lock del proyecto", async () => {
  const pending = operation({
    operationId: "outbox-lock-busy",
    projectId: "outbox-lock-project",
    deviceId: "outbox-lock-device"
  });
  let sent = 0;
  let lockName = "";
  const store = {
    async loadPendingSyncOperations() { return [pending]; },
    async recordSyncOperationAttempt() { throw new Error("No debe registrar intentos"); },
    async acknowledgeSyncOperation() { throw new Error("No debe confirmar"); }
  };
  const result = await dispatchPendingNarrativeSyncOperations({
    store,
    projectId: pending.projectId,
    lockManager: {
      async request(name, options, callback) {
        lockName = name;
        assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
        return callback(null);
      }
    },
    transport: { async send() { sent++; throw new Error("No debe enviar"); } }
  });
  assert.deepEqual(result, {
    processed: 0, remaining: 1, hasMore: false, failure: "already-running"
  });
  assert.equal(lockName, "motor-literario:narrative-outbox:outbox-lock-project");
  assert.equal(sent, 0);
});

test("un error de Web Locks bloquea el despacho saliente sin fallback inseguro", async () => {
  const pending = operation({
    operationId: "outbox-lock-error",
    projectId: "outbox-lock-error-project",
    deviceId: "outbox-lock-error-device"
  });
  let sent = 0;
  const store = {
    async loadPendingSyncOperations() { return [pending]; },
    async recordSyncOperationAttempt() { throw new Error("No debe registrar intentos"); },
    async acknowledgeSyncOperation() { throw new Error("No debe confirmar"); }
  };
  const result = await dispatchPendingNarrativeSyncOperations({
    store,
    projectId: pending.projectId,
    lockManager: { async request() { throw new Error("lock backend unavailable"); } },
    transport: { async send() { sent++; throw new Error("No debe enviar"); } }
  });
  assert.deepEqual(result, {
    processed: 0, remaining: 1, hasMore: false, failure: "lock-failed"
  });
  assert.equal(sent, 0);
});

test("el despachador mantiene el lock durante transporte y acuse local", async () => {
  const pending = operation({
    operationId: "outbox-lock-held",
    projectId: "outbox-lock-held-project",
    deviceId: "outbox-lock-held-device"
  });
  let lockHeld = false;
  const store = {
    async loadPendingSyncOperations() { return [pending]; },
    async recordSyncOperationAttempt() {
      assert.equal(lockHeld, true);
      return true;
    },
    async acknowledgeSyncOperation(acknowledgement) {
      assert.equal(lockHeld, true);
      assert.equal(acknowledgement.operationId, pending.operationId);
      return true;
    }
  };
  const result = await dispatchPendingNarrativeSyncOperations({
    store,
    projectId: pending.projectId,
    lockManager: {
      async request(_name, options, callback) {
        assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
        lockHeld = true;
        try { return await callback({ name: "outbox-lock" }); }
        finally { lockHeld = false; }
      }
    },
    transport: {
      async send(envelope) {
        assert.equal(lockHeld, true);
        return {
          status: "accepted", durable: true, projectId: envelope.projectId,
          operationId: envelope.operationId, writerId: envelope.writerId,
          sequence: envelope.sequence, digest: envelope.digest
        };
      }
    },
    now: () => 500
  });
  assert.deepEqual(result, { processed: 1, remaining: 0, hasMore: false });
  assert.equal(lockHeld, false);
});
