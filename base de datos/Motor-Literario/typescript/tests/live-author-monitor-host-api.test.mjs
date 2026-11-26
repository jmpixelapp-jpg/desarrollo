import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi } from "../dist/motor-literario.js";

class MemoryDocumentStore {
  documents = new Map();
  monitorCheckpoints = new Map();
  monitorLeases = new Map();

  async acquireLiveAuthorMonitorLease(projectId, documentId, ownerId, now, leaseDurationMs) {
    const key = projectId + ":" + documentId;
    const existing = this.monitorLeases.get(key);
    if (existing && existing.expiresAt > now && existing.ownerId !== ownerId) return undefined;
    const sameOwner = existing && existing.expiresAt > now && existing.ownerId === ownerId;
    const lease = {
      version: 1,
      projectId,
      documentId,
      ownerId,
      fencingToken: sameOwner ? existing.fencingToken : existing ? existing.fencingToken + 1 : 1,
      acquiredAt: sameOwner ? existing.acquiredAt : now,
      expiresAt: now + leaseDurationMs,
      updatedAt: now
    };
    this.monitorLeases.set(key, structuredClone(lease));
    return structuredClone(lease);
  }

  async renewLiveAuthorMonitorLease(lease, now, leaseDurationMs) {
    const key = lease.projectId + ":" + lease.documentId;
    const existing = this.monitorLeases.get(key);
    if (!existing || existing.ownerId !== lease.ownerId ||
        existing.fencingToken !== lease.fencingToken ||
        existing.expiresAt <= now || lease.expiresAt <= now) return undefined;
    const renewed = { ...existing, expiresAt: now + leaseDurationMs, updatedAt: now };
    this.monitorLeases.set(key, structuredClone(renewed));
    return structuredClone(renewed);
  }

  async releaseLiveAuthorMonitorLease(lease, now) {
    const key = lease.projectId + ":" + lease.documentId;
    const existing = this.monitorLeases.get(key);
    if (!existing || existing.ownerId !== lease.ownerId ||
        existing.fencingToken !== lease.fencingToken) return false;
    this.monitorLeases.set(key, {
      ...existing,
      expiresAt: now,
      updatedAt: Math.max(existing.acquiredAt, now)
    });
    return true;
  }

  async saveLiveAuthorMonitorCheckpoint(checkpoint, lease) {
    const key = checkpoint.projectId + ":" + checkpoint.documentId;
    const currentLease = this.monitorLeases.get(key);
    if (!lease || !currentLease || currentLease.ownerId !== lease.ownerId ||
        currentLease.fencingToken !== lease.fencingToken ||
        currentLease.expiresAt <= Date.now() || lease.expiresAt <= Date.now()) {
      throw new Error("lease/fencing token inválido para checkpoint");
    }
    const existing = this.monitorCheckpoints.get(key);
    if (existing && (existing.revision > checkpoint.revision ||
        existing.sequence > checkpoint.sequence ||
        existing.savedAt > checkpoint.savedAt)) {
      throw new Error("checkpoint atrasado");
    }
    this.monitorCheckpoints.set(key, structuredClone(checkpoint));
  }

  async loadLiveAuthorMonitorCheckpoint(projectId, documentId) {
    const checkpoint = this.monitorCheckpoints.get(projectId + ":" + documentId);
    return checkpoint ? structuredClone(checkpoint) : undefined;
  }

  async deleteLiveAuthorMonitorCheckpoint(projectId, documentId) {
    this.monitorCheckpoints.delete(projectId + ":" + documentId);
  }

  async loadDocumentWithChanges(projectId, documentId) {
    const document = this.documents.get(projectId + ":" + documentId);
    return { document: document ? structuredClone(document) : undefined, changes: [] };
  }

  async saveDocument(document) {
    this.documents.set(document.projectId + ":" + document.documentId, structuredClone(document));
  }
}

test("reanuda las métricas desde el snapshot durable sin reabrir el documento del motor", async () => {
  const api = new HostEngineApi({ store: new MemoryDocumentStore() });
  api.initializeProject({ projectId: "monitor-reopen", projectName: "Monitor reopen" });
  await api.openDocument({ documentId: "chapter-1", text: "A", revision: 0, sequence: 0 });
  await api.flushPendingChanges();

  const original = api.getLiveAuthorMonitorSnapshot("chapter-1");
  assert.ok(original);
  assert.equal(api.closeLiveAuthorMonitorDocument("chapter-1").pendingChanges, 0);
  assert.equal(api.getLiveAuthorMonitorSnapshot("chapter-1"), undefined);

  const admission = api.onEditorChange({
    documentId: "chapter-1",
    sequence: 1,
    baseRevision: 0,
    start: 1,
    end: 1,
    replacement: "B"
  });
  assert.equal(admission.status, "queued");
  assert.throws(() => api.ensureLiveAuthorMonitorDocument("chapter-1"), /durable y sincronizado/);

  await api.flushPendingChanges();
  const reopened = api.ensureLiveAuthorMonitorDocument("chapter-1");
  assert.equal(reopened.latestRevision, 1);
  assert.equal(reopened.durableRevision, 1);
  assert.equal(reopened.currentDocumentLength, 2);
  assert.notEqual(reopened.sessionId, original.sessionId);

  const repeated = api.ensureLiveAuthorMonitorDocument("chapter-1");
  assert.equal(repeated.sessionId, reopened.sessionId);
  assert.equal(repeated.currentDocumentLength, 2);
  api.dispose();
});

test("no abre métricas para un documento que no existe en la instancia", () => {
  const api = new HostEngineApi({ store: new MemoryDocumentStore() });
  api.initializeProject({ projectId: "monitor-missing", projectName: "Monitor missing" });
  assert.throws(() => api.ensureLiveAuthorMonitorDocument("unknown"), /no está abierto/);
  api.dispose();
});


test("persiste y restaura métricas de sesión junto con el documento recuperado", async () => {
  const store = new MemoryDocumentStore();
  const first = new HostEngineApi({ store });
  first.initializeProject({ projectId: "monitor-checkpoint", projectName: "Monitor checkpoint" });
  await first.openDocument({
    documentId: "chapter-1",
    text: "A",
    revision: 0,
    sequence: 0
  });
  await first.flushPendingChanges();

  const admission = first.onEditorChange({
    documentId: "chapter-1",
    sequence: 1,
    baseRevision: 0,
    start: 1,
    end: 1,
    replacement: "B"
  });
  assert.equal(admission.status, "queued");
  await first.closeLiveAuthorMonitorDocumentSafely("chapter-1");

  const checkpoint = store.monitorCheckpoints.get("monitor-checkpoint:chapter-1");
  assert.ok(checkpoint);
  assert.equal(checkpoint.sequence, 1);
  assert.equal(checkpoint.revision, 1);
  assert.equal(checkpoint.acceptedChanges, 1);
  assert.equal(checkpoint.committedChanges, 1);
  assert.equal(Object.hasOwn(checkpoint, "text"), false);

  await first.disposeSafely();

  const second = new HostEngineApi({ store });
  second.initializeProject({ projectId: "monitor-checkpoint", projectName: "Monitor checkpoint" });
  await second.recoverDocument("chapter-1");

  const restored = second.getLiveAuthorMonitorSnapshot("chapter-1");
  assert.ok(restored);
  assert.equal(restored.sessionId, checkpoint.sessionId);
  assert.equal(restored.latestSequence, 1);
  assert.equal(restored.durableSequence, 1);
  assert.equal(restored.acceptedChanges, 1);
  assert.equal(restored.committedChanges, 1);
  assert.equal(restored.insertedCharacters, 1);
  assert.equal(restored.currentDocumentLength, 2);
  assert.equal(restored.pendingChanges, 0);

  await second.disposeSafely();
});

test("descarta un checkpoint obsoleto cuando el documento recuperado avanzó a otra revisión", async () => {
  const store = new MemoryDocumentStore();
  const first = new HostEngineApi({ store });
  first.initializeProject({ projectId: "monitor-stale-checkpoint", projectName: "Stale checkpoint" });
  await first.openDocument({
    documentId: "chapter-1",
    text: "A",
    revision: 0,
    sequence: 0
  });
  await first.closeLiveAuthorMonitorDocumentSafely("chapter-1");
  const stale = store.monitorCheckpoints.get("monitor-stale-checkpoint:chapter-1");
  assert.ok(stale);
  await first.disposeSafely();

  // Simula un avance durable en el motor sin actualizar el checkpoint antiguo.
  await store.saveDocument({
    projectId: "monitor-stale-checkpoint",
    documentId: "chapter-1",
    text: "AB",
    revision: 1,
    sequence: 1,
    updatedAt: Date.now()
  });

  const second = new HostEngineApi({ store });
  second.initializeProject({ projectId: "monitor-stale-checkpoint", projectName: "Stale checkpoint" });
  await second.recoverDocument("chapter-1");

  const restored = second.getLiveAuthorMonitorSnapshot("chapter-1");
  assert.equal(restored.latestRevision, 1);
  assert.equal(restored.latestSequence, 1);
  assert.notEqual(restored.sessionId, stale.sessionId);
  const refreshed = store.monitorCheckpoints.get("monitor-stale-checkpoint:chapter-1");
  assert.ok(refreshed);
  assert.equal(refreshed.revision, 1);
  assert.equal(refreshed.sequence, 1);
  assert.notEqual(refreshed.sessionId, stale.sessionId);
  await second.disposeSafely();
});


test("guarda checkpoints automáticamente al completar commits y al disponer de forma segura", async () => {
  const store = new MemoryDocumentStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "monitor-auto-checkpoint", projectName: "Automatic checkpoint" });
  await api.openDocument({
    documentId: "chapter-1",
    text: "A",
    revision: 0,
    sequence: 0
  });

  const admission = api.onEditorChange({
    documentId: "chapter-1",
    sequence: 1,
    baseRevision: 0,
    start: 1,
    end: 1,
    replacement: "B"
  });
  assert.equal(admission.status, "queued");
  await api.disposeSafely();

  const checkpoint = store.monitorCheckpoints.get("monitor-auto-checkpoint:chapter-1");
  assert.ok(checkpoint);
  assert.equal(checkpoint.revision, 1);
  assert.equal(checkpoint.sequence, 1);
  assert.equal(checkpoint.acceptedChanges, 1);
  assert.equal(checkpoint.committedChanges, 1);
  assert.equal(checkpoint.currentDocumentLength, 2);
});


test("no dispone el HostEngineApi cuando un checkpoint automático falla al persistirse", async () => {
  class FailingCheckpointStore extends MemoryDocumentStore {
    async saveLiveAuthorMonitorCheckpoint() {
      throw new Error("quota_exceeded");
    }
  }

  const api = new HostEngineApi({ store: new FailingCheckpointStore() });
  api.initializeProject({ projectId: "monitor-checkpoint-failure", projectName: "Checkpoint failure" });
  await api.openDocument({
    documentId: "chapter-1",
    text: "A",
    revision: 0,
    sequence: 0
  });

  await assert.rejects(api.disposeSafely(), /quota_exceeded|checkpoints.*no pudieron persistirse/);
  assert.ok(api.getLiveAuthorMonitorSnapshot("chapter-1"));
  api.dispose();
});


test("solo una pestaña publica métricas compartidas y la siguiente toma el lease al liberarse", async () => {
  const store = new MemoryDocumentStore();
  const first = new HostEngineApi({ store });
  first.initializeProject({ projectId: "monitor-multitab", projectName: "Monitor multitab" });
  await first.openDocument({
    documentId: "chapter-1",
    text: "A",
    revision: 0,
    sequence: 0
  });

  const key = "monitor-multitab:chapter-1";
  const initialCheckpoint = store.monitorCheckpoints.get(key);
  assert.ok(initialCheckpoint);
  const firstLease = store.monitorLeases.get(key);
  assert.ok(firstLease);

  const second = new HostEngineApi({ store });
  second.initializeProject({ projectId: "monitor-multitab", projectName: "Monitor multitab" });
  await second.recoverDocument("chapter-1");

  const secondSession = second.getLiveAuthorMonitorSnapshot("chapter-1");
  assert.ok(secondSession);
  assert.notEqual(secondSession.sessionId, initialCheckpoint.sessionId);
  await assert.rejects(
    second.closeLiveAuthorMonitorDocumentSafely("chapter-1"),
    /no posee el lease/
  );
  assert.equal(store.monitorCheckpoints.get(key).sessionId, initialCheckpoint.sessionId);
  assert.equal(store.monitorLeases.get(key).fencingToken, firstLease.fencingToken);

  await first.closeLiveAuthorMonitorDocumentSafely("chapter-1");
  const releasedLease = store.monitorLeases.get(key);
  assert.equal(releasedLease.expiresAt <= Date.now(), true);

  // La pestaña que estaba en espera puede adquirir un nuevo token al cerrar de forma segura.
  await second.closeLiveAuthorMonitorDocumentSafely("chapter-1");
  const handedOffCheckpoint = store.monitorCheckpoints.get(key);
  const handedOffLease = store.monitorLeases.get(key);
  assert.equal(handedOffCheckpoint.sessionId, secondSession.sessionId);
  assert.equal(handedOffLease.fencingToken, firstLease.fencingToken + 1);
  assert.equal(handedOffLease.expiresAt <= Date.now(), true);

  await first.disposeSafely();
  await second.disposeSafely();
});


test("cerrar un documento no detiene el lease ni el checkpoint de otros documentos abiertos", async () => {
  const store = new MemoryDocumentStore();
  const api = new HostEngineApi({ store });
  const projectId = "monitor-independent-open-documents";
  const documentA = "chapter-a";
  const documentB = "chapter-b";
  const keyA = projectId + ":" + documentA;
  const keyB = projectId + ":" + documentB;

  api.initializeProject({ projectId, projectName: "Independent open documents" });

  try {
    await api.openDocument({
      documentId: documentA,
      text: "A",
      revision: 0,
      sequence: 0
    });
    await api.openDocument({
      documentId: documentB,
      text: "B",
      revision: 0,
      sequence: 0
    });
    await api.flushPendingChanges();

    const initialA = store.monitorCheckpoints.get(keyA);
    const initialB = store.monitorCheckpoints.get(keyB);
    const leaseA = store.monitorLeases.get(keyA);
    const leaseB = store.monitorLeases.get(keyB);
    assert.ok(initialA);
    assert.ok(initialB);
    assert.ok(leaseA);
    assert.ok(leaseB);
    assert.equal(api.liveMonitorLeases.has(documentA), true);
    assert.equal(api.liveMonitorLeases.has(documentB), true);
    assert.equal(api.liveMonitorLeaseHeartbeats.has(documentA), true);
    assert.equal(api.liveMonitorLeaseHeartbeats.has(documentB), true);

    await api.closeLiveAuthorMonitorDocumentSafely(documentA);

    assert.equal(api.getLiveAuthorMonitorSnapshot(documentA), undefined);
    assert.equal(api.liveMonitorLeases.has(documentA), false);
    assert.equal(api.liveMonitorLeaseHeartbeats.has(documentA), false);
    assert.equal(store.monitorLeases.get(keyA).expiresAt <= Date.now(), true);

    assert.ok(api.getLiveAuthorMonitorSnapshot(documentB));
    assert.equal(api.liveMonitorLeases.has(documentB), true,
      "cerrar A no debe eliminar la titularidad local de B");
    assert.equal(api.liveMonitorLeaseHeartbeats.has(documentB), true,
      "el heartbeat de B debe continuar activo");
    assert.equal(store.monitorLeases.get(keyB).ownerId, leaseB.ownerId);
    assert.equal(store.monitorLeases.get(keyB).fencingToken, leaseB.fencingToken);
    assert.ok(store.monitorLeases.get(keyB).expiresAt > Date.now());

    const editB = api.onEditorChange({
      documentId: documentB,
      sequence: 1,
      baseRevision: 0,
      start: 1,
      end: 1,
      replacement: "2"
    });
    assert.equal(editB.status, "queued");
    await api.flushPendingChanges();
    const pendingCheckpointB = api.liveMonitorCheckpointTails.get(documentB);
    if (pendingCheckpointB) await pendingCheckpointB;

    const savedA = store.monitorCheckpoints.get(keyA);
    const savedB = store.monitorCheckpoints.get(keyB);
    assert.equal(savedA.sessionId, initialA.sessionId,
      "el cierre de A conserva su último checkpoint");
    assert.equal(savedB.sessionId, initialB.sessionId,
      "la sesión de B no debe reiniciarse al cerrar A");
    assert.equal(savedB.revision, 1);
    assert.equal(savedB.sequence, 1);
    assert.equal(savedB.currentDocumentLength, 2);
    assert.equal(api.getLiveAuthorMonitorPersistenceDiagnostics(documentB).checkpointState, "saved");

    await api.closeLiveAuthorMonitorDocumentSafely(documentB);
    assert.equal(store.monitorLeases.get(keyB).expiresAt <= Date.now(), true);
  } finally {
    api.dispose();
  }
});

test("conserva la titularidad local y permite reintentar si falla la liberación del lease", async () => {
  class FailingReleaseStore extends MemoryDocumentStore {
    failRelease = true;

    async releaseLiveAuthorMonitorLease(lease, now) {
      if (this.failRelease) {
        this.failRelease = false;
        throw new Error("lease_release_temporarily_failed");
      }
      return super.releaseLiveAuthorMonitorLease(lease, now);
    }
  }

  const store = new FailingReleaseStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "monitor-release-retry", projectName: "Lease release retry" });
  await api.openDocument({
    documentId: "chapter-1",
    text: "A",
    revision: 0,
    sequence: 0
  });

  await assert.rejects(
    api.closeLiveAuthorMonitorDocumentSafely("chapter-1"),
    /lease_release_temporarily_failed/
  );
  assert.ok(api.getLiveAuthorMonitorSnapshot("chapter-1"));
  assert.ok(store.monitorLeases.get("monitor-release-retry:chapter-1").expiresAt > Date.now());

  await api.closeLiveAuthorMonitorDocumentSafely("chapter-1");
  assert.equal(api.getLiveAuthorMonitorSnapshot("chapter-1"), undefined);
  assert.equal(
    store.monitorLeases.get("monitor-release-retry:chapter-1").expiresAt <= Date.now(),
    true
  );
  await api.disposeSafely();
});


test("una renovación de heartbeat tardía no restaura el lease después del cierre seguro", async () => {
  class DelayedHeartbeatStore extends MemoryDocumentStore {
    delayNextRenew = false;
    resolveDelayedRenewal;

    async renewLiveAuthorMonitorLease(lease, now, durationMs) {
      const renewed = await super.renewLiveAuthorMonitorLease(lease, now, durationMs);
      if (this.delayNextRenew && renewed) {
        this.delayNextRenew = false;
        return await new Promise(resolve => {
          this.resolveDelayedRenewal = () => resolve(renewed);
        });
      }
      return renewed;
    }
  }

  const store = new DelayedHeartbeatStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "monitor-heartbeat-race", projectName: "Heartbeat race" });
  await api.openDocument({
    documentId: "chapter-1",
    text: "A",
    revision: 0,
    sequence: 0
  });

  store.delayNextRenew = true;
  // Método privado invocado directamente para controlar el orden de la carrera.
  const heartbeat = api.renewLiveAuthorMonitorLeaseFromHeartbeat("chapter-1");
  for (let attempt = 0; attempt < 20 && !store.resolveDelayedRenewal; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof store.resolveDelayedRenewal, "function");

  await api.closeLiveAuthorMonitorDocumentSafely("chapter-1");
  assert.equal(api.getLiveAuthorMonitorSnapshot("chapter-1"), undefined);
  assert.equal(api.liveMonitorLeases.has("chapter-1"), false);

  store.resolveDelayedRenewal();
  await heartbeat;
  assert.equal(
    api.liveMonitorLeases.has("chapter-1"),
    false,
    "la respuesta tardía del heartbeat no debe volver a insertar el lease local"
  );
  assert.equal(
    store.monitorLeases.get("monitor-heartbeat-race:chapter-1").expiresAt <= Date.now(),
    true,
    "el registro persistido debe permanecer liberado"
  );

  await api.disposeSafely();
});


test("dispose durante una adquisición pendiente libera el lease y no inicia heartbeat", async () => {
  class DelayedAcquireStore extends MemoryDocumentStore {
    delayNextAcquire = true;
    resolvePendingAcquire;

    async acquireLiveAuthorMonitorLease(projectId, documentId, ownerId, now, durationMs) {
      const lease = await super.acquireLiveAuthorMonitorLease(
        projectId,
        documentId,
        ownerId,
        now,
        durationMs
      );
      if (this.delayNextAcquire && lease) {
        this.delayNextAcquire = false;
        return await new Promise(resolve => {
          this.resolvePendingAcquire = () => resolve(lease);
        });
      }
      return lease;
    }
  }

  const store = new DelayedAcquireStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "monitor-dispose-acquire-race", projectName: "Dispose acquire race" });
  const opening = api.openDocument({
    documentId: "chapter-1",
    text: "A",
    revision: 0,
    sequence: 0
  });

  for (let attempt = 0; attempt < 20 && !store.resolvePendingAcquire; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof store.resolvePendingAcquire, "function");
  assert.ok(store.monitorLeases.get("monitor-dispose-acquire-race:chapter-1"));

  api.dispose();
  store.resolvePendingAcquire();
  await opening;

  const persistedLease = store.monitorLeases.get("monitor-dispose-acquire-race:chapter-1");
  assert.ok(persistedLease);
  assert.equal(persistedLease.expiresAt <= Date.now(), true,
    "un lease adquirido tarde debe liberarse en cuanto detecta dispose()");
  assert.equal(api.liveMonitorLeases.size, 0);
  assert.equal(api.liveMonitorLeaseHeartbeats.size, 0);
  assert.equal(api.getLiveAuthorMonitorSnapshot("chapter-1"), undefined);

  api.dispose();
});


test("una renovación genérica tardía no restaura el lease después del cierre seguro", async () => {
  class DelayedRenewStore extends MemoryDocumentStore {
    delayNextRenew = false;
    resolveDelayedRenewal;

    async renewLiveAuthorMonitorLease(lease, now, durationMs) {
      const renewed = await super.renewLiveAuthorMonitorLease(lease, now, durationMs);
      if (this.delayNextRenew && renewed) {
        this.delayNextRenew = false;
        return await new Promise(resolve => {
          this.resolveDelayedRenewal = () => resolve(renewed);
        });
      }
      return renewed;
    }
  }

  const store = new DelayedRenewStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "monitor-generic-lease-race", projectName: "Generic lease race" });
  await api.openDocument({
    documentId: "chapter-1",
    text: "A",
    revision: 0,
    sequence: 0
  });

  const pendingCheckpoint = api.liveMonitorCheckpointTails.get("chapter-1");
  if (pendingCheckpoint) await pendingCheckpoint;

  store.delayNextRenew = true;
  // Esta ruta es usada también por guardados y adquisiciones, no solo heartbeat.
  const renewal = api.acquireOrRenewLiveAuthorMonitorLease("chapter-1");
  for (let attempt = 0; attempt < 20 && !store.resolveDelayedRenewal; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof store.resolveDelayedRenewal, "function");

  await api.closeLiveAuthorMonitorDocumentSafely("chapter-1");
  assert.equal(api.getLiveAuthorMonitorSnapshot("chapter-1"), undefined);
  assert.equal(api.liveMonitorLeases.has("chapter-1"), false);
  assert.equal(api.liveMonitorLeaseHeartbeats.has("chapter-1"), false);

  store.resolveDelayedRenewal();
  const staleResult = await renewal;
  assert.equal(staleResult, undefined,
    "una respuesta de una generación invalidada no debe devolver titularidad");
  assert.equal(api.liveMonitorLeases.has("chapter-1"), false,
    "la respuesta atrasada no debe restaurar el lease local");
  assert.equal(api.liveMonitorLeaseHeartbeats.has("chapter-1"), false,
    "la respuesta atrasada no debe reactivar el heartbeat");
  assert.equal(
    store.monitorLeases.get("monitor-generic-lease-race:chapter-1").expiresAt <= Date.now(),
    true,
    "el lease persistido debe continuar liberado"
  );

  await api.disposeSafely();
});

test("una renovación antigua no rebaja la expiración de una renovación más reciente", async () => {
  class ReorderedRenewStore extends MemoryDocumentStore {
    delayFirstRenewal = false;
    resolveFirstRenewal;

    async renewLiveAuthorMonitorLease(lease, now, durationMs) {
      const renewed = await super.renewLiveAuthorMonitorLease(lease, now, durationMs);
      if (this.delayFirstRenewal && renewed) {
        this.delayFirstRenewal = false;
        return await new Promise(resolve => {
          this.resolveFirstRenewal = () => resolve(renewed);
        });
      }
      return renewed;
    }
  }

  const store = new ReorderedRenewStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "monitor-renewal-order", projectName: "Renewal order" });
  await api.openDocument({
    documentId: "chapter-1",
    text: "A",
    revision: 0,
    sequence: 0
  });
  const pendingCheckpoint = api.liveMonitorCheckpointTails.get("chapter-1");
  if (pendingCheckpoint) await pendingCheckpoint;

  store.delayFirstRenewal = true;
  const olderRenewal = api.acquireOrRenewLiveAuthorMonitorLease("chapter-1");
  for (let attempt = 0; attempt < 20 && !store.resolveFirstRenewal; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof store.resolveFirstRenewal, "function");

  await new Promise(resolve => setTimeout(resolve, 2));
  const newerResult = await api.acquireOrRenewLiveAuthorMonitorLease("chapter-1");
  assert.ok(newerResult);
  const newerExpiry = api.liveMonitorLeases.get("chapter-1").expiresAt;
  const newerUpdatedAt = api.liveMonitorLeases.get("chapter-1").updatedAt;

  store.resolveFirstRenewal();
  const olderResult = await olderRenewal;
  assert.ok(olderResult);
  const finalLease = api.liveMonitorLeases.get("chapter-1");
  assert.ok(finalLease);
  assert.equal(finalLease.fencingToken, newerResult.fencingToken);
  assert.ok(finalLease.expiresAt >= newerExpiry,
    "una respuesta antigua no debe hacer retroceder expiresAt");
  assert.ok(finalLease.updatedAt >= newerUpdatedAt,
    "una respuesta antigua no debe hacer retroceder updatedAt");

  await api.closeLiveAuthorMonitorDocumentSafely("chapter-1");
  await api.disposeSafely();
});

test("una pestaña observadora toma el lease expirado sin necesitar una nueva edición", async () => {
  const store = new MemoryDocumentStore();
  const owner = new HostEngineApi({ store });
  owner.initializeProject({ projectId: "monitor-expired-takeover", projectName: "Expired takeover" });
  await owner.openDocument({
    documentId: "chapter-1",
    text: "A",
    revision: 0,
    sequence: 0
  });

  const key = "monitor-expired-takeover:chapter-1";
  const originalLease = structuredClone(store.monitorLeases.get(key));
  assert.ok(originalLease);

  const observer = new HostEngineApi({ store });
  observer.initializeProject({ projectId: "monitor-expired-takeover", projectName: "Expired takeover" });
  await observer.recoverDocument("chapter-1");
  assert.equal(observer.liveMonitorLeases.has("chapter-1"), false);
  assert.equal(observer.liveMonitorLeaseHeartbeats.has("chapter-1"), true,
    "la pestaña observadora debe mantener el reintento de lease");

  // Simula que el propietario se cerró abruptamente y no ejecutó release().
  store.monitorLeases.set(key, {
    ...store.monitorLeases.get(key),
    expiresAt: Date.now() - 1
  });

  await observer.renewLiveAuthorMonitorLeaseFromHeartbeat("chapter-1");
  const pendingCheckpoint = observer.liveMonitorCheckpointTails.get("chapter-1");
  if (pendingCheckpoint) await pendingCheckpoint;

  const takeoverLease = store.monitorLeases.get(key);
  assert.ok(observer.liveMonitorLeases.has("chapter-1"));
  assert.equal(takeoverLease.ownerId, observer.liveMonitorOwnerId);
  assert.equal(takeoverLease.fencingToken, originalLease.fencingToken + 1);

  const checkpoint = store.monitorCheckpoints.get(key);
  assert.ok(checkpoint);
  assert.equal(checkpoint.sessionId, observer.getLiveAuthorMonitorSnapshot("chapter-1").sessionId);

  owner.dispose();
  await observer.closeLiveAuthorMonitorDocumentSafely("chapter-1");
  assert.equal(store.monitorLeases.get(key).expiresAt <= Date.now(), true);
  await observer.disposeSafely();
});


test("una escritura en vuelo del propietario anterior no sobrescribe el checkpoint tras el takeover", async () => {
  let notifyDelayedSave;
  let releaseDelayedSave;
  const delayedSaveEntered = new Promise(resolve => { notifyDelayedSave = resolve; });
  const delayedSaveResponse = new Promise(resolve => { releaseDelayedSave = resolve; });

  class DelayedCheckpointStore extends MemoryDocumentStore {
    delayNextCheckpoint = false;

    async saveLiveAuthorMonitorCheckpoint(checkpoint, lease) {
      if (this.delayNextCheckpoint) {
        this.delayNextCheckpoint = false;
        notifyDelayedSave();
        await delayedSaveResponse;
      }
      return super.saveLiveAuthorMonitorCheckpoint(checkpoint, lease);
    }
  }

  const store = new DelayedCheckpointStore();
  const owner = new HostEngineApi({ store });
  const observer = new HostEngineApi({ store });
  const projectId = "monitor-takeover-inflight-write";
  const documentId = "chapter-1";
  const key = projectId + ":" + documentId;

  owner.initializeProject({ projectId, projectName: "Takeover inflight write" });
  observer.initializeProject({ projectId, projectName: "Takeover inflight write" });

  try {
    await owner.openDocument({
      documentId,
      text: "A",
      revision: 0,
      sequence: 0
    });
    await owner.flushPendingChanges();

    const firstDurable = store.monitorCheckpoints.get(key);
    const oldLease = structuredClone(store.monitorLeases.get(key));
    assert.ok(firstDurable);
    assert.ok(oldLease);

    store.delayNextCheckpoint = true;
    const admission = owner.onEditorChange({
      documentId,
      sequence: 1,
      baseRevision: 0,
      start: 1,
      end: 1,
      replacement: "B"
    });
    assert.equal(admission.status, "queued");

    await delayedSaveEntered;
    const delayedOwnerCheckpoint = owner.liveMonitorCheckpointTails.get(documentId);
    assert.ok(delayedOwnerCheckpoint, "el guardado del propietario anterior debe seguir en vuelo");

    // El propietario anterior desaparece sin release y su lease vence mientras
    // su llamada a saveLiveAuthorMonitorCheckpoint está suspendida.
    const expiredAt = Date.now() - 1;
    store.monitorLeases.set(key, {
      ...oldLease,
      expiresAt: expiredAt,
      updatedAt: Math.max(oldLease.acquiredAt, expiredAt)
    });

    await observer.recoverDocument(documentId);
    const observerSession = observer.getLiveAuthorMonitorSnapshot(documentId);
    assert.ok(observerSession);
    await observer.renewLiveAuthorMonitorLeaseFromHeartbeat(documentId);

    const observerCheckpoint = observer.liveMonitorCheckpointTails.get(documentId);
    if (observerCheckpoint) await observerCheckpoint;
    const takeoverLease = store.monitorLeases.get(key);
    const takeoverCheckpoint = store.monitorCheckpoints.get(key);
    assert.ok(takeoverLease);
    assert.ok(takeoverCheckpoint);
    assert.equal(takeoverLease.ownerId, observer.liveMonitorOwnerId);
    assert.equal(takeoverLease.fencingToken, oldLease.fencingToken + 1);
    assert.equal(takeoverCheckpoint.sessionId, observerSession.sessionId);

    // La escritura del propietario anterior solo continúa después de que el
    // observador confirmó el nuevo fencing token y publicó su checkpoint.
    releaseDelayedSave();
    await assert.rejects(
      delayedOwnerCheckpoint,
      /lease\/fencing token inválido para checkpoint/
    );

    assert.deepEqual(
      store.monitorCheckpoints.get(key),
      takeoverCheckpoint,
      "la respuesta tardía del antiguo propietario no debe reemplazar el checkpoint del observador"
    );
    const ownerDiagnostics = owner.getLiveAuthorMonitorPersistenceDiagnostics(documentId);
    assert.equal(ownerDiagnostics.checkpointState, "error");
    assert.equal(ownerDiagnostics.checkpointErrorCode, "Error");
    assert.equal(store.monitorLeases.get(key).fencingToken, oldLease.fencingToken + 1);
  } finally {
    releaseDelayedSave();
    owner.dispose();
    await observer.disposeSafely();
  }
});

test("dispose durante la lectura de checkpoint no restaura métricas después del cierre", async () => {
  class DelayedCheckpointLoadStore extends MemoryDocumentStore {
    delayNextLoad = false;
    resolvePendingLoad;

    async loadLiveAuthorMonitorCheckpoint(projectId, documentId) {
      const checkpoint = await super.loadLiveAuthorMonitorCheckpoint(projectId, documentId);
      if (this.delayNextLoad) {
        this.delayNextLoad = false;
        return await new Promise(resolve => {
          this.resolvePendingLoad = () => resolve(checkpoint);
        });
      }
      return checkpoint;
    }
  }

  const store = new DelayedCheckpointLoadStore();
  const first = new HostEngineApi({ store });
  first.initializeProject({ projectId: "monitor-dispose-read-race", projectName: "Dispose read race" });
  await first.openDocument({
    documentId: "chapter-1",
    text: "A",
    revision: 0,
    sequence: 0
  });
  await first.closeLiveAuthorMonitorDocumentSafely("chapter-1");
  await first.disposeSafely();

  store.delayNextLoad = true;
  const second = new HostEngineApi({ store });
  second.initializeProject({ projectId: "monitor-dispose-read-race", projectName: "Dispose read race" });
  const recovery = second.recoverDocument("chapter-1");

  for (let attempt = 0; attempt < 20 && !store.resolvePendingLoad; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof store.resolvePendingLoad, "function");
  second.dispose();
  store.resolvePendingLoad();
  await recovery;

  assert.equal(second.getLiveAuthorMonitorSnapshot("chapter-1"), undefined);
  assert.equal(second.liveMonitorLeases.size, 0);
  assert.equal(second.liveMonitorLeaseHeartbeats.size, 0);
  second.dispose();
});

test("publica el error de cuota del checkpoint sin exponer el texto interno", async () => {
  class QuotaExceededCheckpointStore extends MemoryDocumentStore {
    async saveLiveAuthorMonitorCheckpoint() {
      throw new DOMException("PRIVATE_MANUSCRIPT_TEXT", "QuotaExceededError");
    }
  }

  const api = new HostEngineApi({ store: new QuotaExceededCheckpointStore() });
  api.initializeProject({ projectId: "monitor-diagnostics-quota", projectName: "Monitor diagnostics quota" });
  await api.openDocument({
    documentId: "chapter-1",
    text: "PRIVATE_MANUSCRIPT_TEXT",
    revision: 0,
    sequence: 0
  });

  const diagnostics = api.getLiveAuthorMonitorPersistenceDiagnostics("chapter-1");
  assert.equal(diagnostics.checkpointState, "error");
  assert.equal(diagnostics.checkpointErrorCode, "QuotaExceededError");
  assert.equal(diagnostics.leaseState, "owner");
  assert.equal(JSON.stringify(diagnostics).includes("PRIVATE_MANUSCRIPT_TEXT"), false);
  api.dispose();
});

test("limpia el diagnóstico QuotaExceededError cuando una escritura posterior se recupera", async () => {
  let rejectFirstAttempt;
  let resolveRecoveredAttempt;
  const firstAttempt = new Promise(resolve => { rejectFirstAttempt = resolve; });
  const recoveredAttempt = new Promise(resolve => { resolveRecoveredAttempt = resolve; });

  class RecoveringQuotaStore extends MemoryDocumentStore {
    failNext = true;

    async saveLiveAuthorMonitorCheckpoint(checkpoint, lease) {
      if (this.failNext) {
        this.failNext = false;
        rejectFirstAttempt();
        throw new DOMException("PRIVATE_MANUSCRIPT_TEXT", "QuotaExceededError");
      }
      await super.saveLiveAuthorMonitorCheckpoint(checkpoint, lease);
      resolveRecoveredAttempt();
    }
  }

  const store = new RecoveringQuotaStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "monitor-quota-recovery", projectName: "Quota recovery" });

  try {
    await api.openDocument({
      documentId: "chapter-1",
      text: "A",
      revision: 0,
      sequence: 0
    });
    await firstAttempt;

    const failed = api.getLiveAuthorMonitorPersistenceDiagnostics("chapter-1");
    assert.equal(failed.checkpointState, "error");
    assert.equal(failed.checkpointErrorCode, "QuotaExceededError");

    const admission = api.onEditorChange({
      documentId: "chapter-1",
      sequence: 1,
      baseRevision: 0,
      start: 1,
      end: 1,
      replacement: "B"
    });
    assert.equal(admission.status, "queued");
    await api.flushPendingChanges();
    await recoveredAttempt;
    await new Promise(resolve => setImmediate(resolve));

    const recovered = api.getLiveAuthorMonitorPersistenceDiagnostics("chapter-1");
    assert.equal(recovered.checkpointState, "saved");
    assert.equal(recovered.checkpointErrorCode, undefined);
    assert.equal(store.monitorCheckpoints.get("monitor-quota-recovery:chapter-1").revision, 1);
    assert.equal(api.getLiveAuthorMonitorSnapshot("chapter-1").committedChanges, 1);
  } finally {
    api.dispose();
  }
});

test("informa pérdida del lease cuando otra pestaña sustituye el fencing token", async () => {
  const store = new MemoryDocumentStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "monitor-diagnostics-lease", projectName: "Monitor diagnostics lease" });
  await api.openDocument({
    documentId: "chapter-1",
    text: "private",
    revision: 0,
    sequence: 0
  });

  const key = "monitor-diagnostics-lease:chapter-1";
  const current = store.monitorLeases.get(key);
  assert.ok(current);
  store.monitorLeases.set(key, {
    ...current,
    ownerId: "replacement-tab",
    fencingToken: current.fencingToken + 1
  });
  await api.renewLiveAuthorMonitorLeaseFromHeartbeat("chapter-1");

  const diagnostics = api.getLiveAuthorMonitorPersistenceDiagnostics("chapter-1");
  assert.equal(diagnostics.leaseState, "lost");
  assert.equal(diagnostics.fencingToken, undefined);
  api.dispose();
});

test("al volver a visible recupera de inmediato un lease expirado durante suspensión", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const documentListeners = new Map();
  const windowListeners = new Map();
  const fakeDocument = {
    visibilityState: "hidden",
    addEventListener(type, listener) {
      const set = documentListeners.get(type) ?? new Set();
      set.add(listener);
      documentListeners.set(type, set);
    },
    removeEventListener(type, listener) {
      documentListeners.get(type)?.delete(listener);
    }
  };
  const fakeWindow = {
    addEventListener(type, listener) {
      const set = windowListeners.get(type) ?? new Set();
      set.add(listener);
      windowListeners.set(type, set);
    },
    removeEventListener(type, listener) {
      windowListeners.get(type)?.delete(listener);
    }
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });

  const store = new MemoryDocumentStore();
  const api = new HostEngineApi({ store });
  try {
    api.initializeProject({ projectId: "monitor-resume-lease", projectName: "Monitor resume lease" });
    await api.openDocument({
      documentId: "chapter-1",
      text: "resume",
      revision: 0,
      sequence: 0
    });
    const key = "monitor-resume-lease:chapter-1";
    const originalLease = store.monitorLeases.get(key);
    assert.ok(originalLease);
    const expiredAt = Date.now() - 1;
    store.monitorLeases.set(key, {
      ...originalLease,
      acquiredAt: expiredAt - 60_000,
      expiresAt: expiredAt,
      updatedAt: expiredAt
    });

    fakeDocument.visibilityState = "visible";
    for (const listener of [...(documentListeners.get("visibilitychange") ?? [])]) listener();
    await new Promise(resolve => setTimeout(resolve, 0));

    const diagnostics = api.getLiveAuthorMonitorPersistenceDiagnostics("chapter-1");
    assert.equal(diagnostics.leaseState, "owner");
    assert.equal(diagnostics.fencingToken, originalLease.fencingToken + 1);
    assert.equal(documentListeners.get("visibilitychange")?.size, 1);
  } finally {
    api.dispose();
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
});

test("configura retención de checkpoints, la ejecuta al inicializar y permite desactivarla", async () => {
  class RetentionStore extends MemoryDocumentStore {
    cleanupCalls = [];
    async cleanupLiveAuthorMonitorCheckpoints(projectId, olderThan, now) {
      this.cleanupCalls.push({ projectId, olderThan, now });
      return 3;
    }
  }

  const store = new RetentionStore();
  const api = new HostEngineApi({
    store,
    liveAuthorMonitorCheckpointRetentionMs: 24 * 60 * 60 * 1_000
  });
  api.initializeProject({ projectId: "monitor-retention-config", projectName: "Monitor retention config" });

  assert.equal(store.cleanupCalls.length, 1, "la limpieza automática se programa al inicializar el proyecto");
  assert.equal(store.cleanupCalls[0].projectId, "monitor-retention-config");
  assert.equal(store.cleanupCalls[0].now - store.cleanupCalls[0].olderThan, 24 * 60 * 60 * 1_000);

  const removed = await api.cleanupLiveAuthorMonitorCheckpoints(store.cleanupCalls[0].now + 10);
  assert.equal(removed, 3);
  assert.equal(store.cleanupCalls.length, 2);
  api.dispose();

  const disabledStore = new RetentionStore();
  const disabled = new HostEngineApi({
    store: disabledStore,
    liveAuthorMonitorCheckpointRetentionMs: 0
  });
  disabled.initializeProject({ projectId: "monitor-retention-disabled", projectName: "Monitor retention disabled" });
  assert.equal(await disabled.cleanupLiveAuthorMonitorCheckpoints(), 0);
  assert.equal(disabledStore.cleanupCalls.length, 0);
  disabled.dispose();

  assert.throws(
    () => new HostEngineApi({
      store: new RetentionStore(),
      liveAuthorMonitorCheckpointRetentionMs: -1
    }),
    /entre 0 y 3650 días/
  );
});
