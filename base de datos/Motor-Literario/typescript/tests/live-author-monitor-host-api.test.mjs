import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi } from "../dist/motor-literario.js";

class MemoryDocumentStore {
  documents = new Map();

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
