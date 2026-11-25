import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi } from "../dist/motor-literario.js";

class MemoryDocumentStore {
  documents = new Map();
  monitorCheckpoints = new Map();

  async saveLiveAuthorMonitorCheckpoint(checkpoint) {
    this.monitorCheckpoints.set(
      checkpoint.projectId + ":" + checkpoint.documentId,
      structuredClone(checkpoint)
    );
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
