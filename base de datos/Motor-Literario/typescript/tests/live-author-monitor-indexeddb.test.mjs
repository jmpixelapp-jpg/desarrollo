import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { IndexedDbProjectStore } from "../dist/motor-literario.js";

function checkpoint(projectId, documentId, savedAt, overrides = {}) {
  return {
    version: 1,
    projectId,
    documentId,
    sessionId: "session-" + projectId,
    savedAt,
    sessionDurationMs: 100,
    activeDurationMs: 50,
    idleDurationMs: 50,
    lastActivityAgeMs: 20,
    pauseCount: 1,
    acceptedChanges: 1,
    rejectedChanges: 0,
    committedChanges: 1,
    failedChanges: 0,
    insertedCharacters: 5,
    deletedCharacters: 0,
    currentDocumentLength: 5,
    revision: 1,
    sequence: 1,
    resynchronizations: 0,
    lastCommitLatencyMs: 5,
    totalCommitLatencyMs: 5,
    commitLatencies: [5],
    ...overrides
  };
}

test("IndexedDB persiste, clona, ordena por timestamp y elimina checkpoints del monitor", async () => {
  assert.ok(globalThis.indexedDB, "Node 22.13+ debe proporcionar IndexedDB nativo");

  const store = new IndexedDbProjectStore();
  const projectId = "live-author-monitor-" + randomUUID();
  const documentId = "chapter-" + randomUUID();

  try {
    const first = checkpoint(projectId, documentId, 1000);
    await store.saveLiveAuthorMonitorCheckpoint(first);

    const loaded = await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId);
    assert.deepEqual(loaded, first);
    assert.notEqual(loaded, first);
    assert.notEqual(loaded.commitLatencies, first.commitLatencies);

    // La lectura devuelve una copia aislada, no una referencia viva del almacén.
    loaded.commitLatencies[0] = 999;
    const reread = await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId);
    assert.deepEqual(reread.commitLatencies, [5]);

    await assert.rejects(
      store.saveLiveAuthorMonitorCheckpoint(checkpoint(projectId, documentId, 999)),
      /checkpoint anterior/
    );

    const newer = checkpoint(projectId, documentId, 2000, {
      sessionDurationMs: 250,
      activeDurationMs: 120,
      idleDurationMs: 130,
      committedChanges: 2,
      acceptedChanges: 2,
      insertedCharacters: 9,
      currentDocumentLength: 9,
      revision: 2,
      sequence: 2,
      lastCommitLatencyMs: 7,
      totalCommitLatencyMs: 12,
      commitLatencies: [5, 7]
    });
    await store.saveLiveAuthorMonitorCheckpoint(newer);
    assert.deepEqual(
      await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId),
      newer
    );
    assert.equal(
      await store.loadLiveAuthorMonitorCheckpoint(projectId + "-other", documentId),
      undefined
    );

    await store.deleteLiveAuthorMonitorCheckpoint(projectId, documentId);
    assert.equal(
      await store.loadLiveAuthorMonitorCheckpoint(projectId, documentId),
      undefined
    );
  } finally {
    await store.close();
  }
});
