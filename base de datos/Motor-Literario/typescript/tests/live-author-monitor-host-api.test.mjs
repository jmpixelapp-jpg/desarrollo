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
