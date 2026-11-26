import test from "node:test";
import assert from "node:assert/strict";
import { LiteraryEngine } from "../dist/motor-literario.js";

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("mantiene la última secuencia admitida mientras IndexedDB confirma una escritura lenta", async () => {
  const firstAppendStarted = deferred();
  const releaseFirstAppend = deferred();
  let appendCount = 0;
  const store = {
    async loadDocumentWithChanges() {
      return { document: undefined, changes: [] };
    },
    async saveDocument() {},
    appendChange() {
      appendCount += 1;
      if (appendCount === 1) {
        firstAppendStarted.resolve();
        return releaseFirstAppend.promise;
      }
      return Promise.resolve();
    }
  };

  const engine = new LiteraryEngine({
    store,
    queueCapacity: 64,
    maxConcurrentDocuments: 2
  });
  engine.initializeProject({
    projectId: "pending-sequence-race",
    projectName: "Regresión de secuencia pendiente"
  });
  await engine.openDocument({
    documentId: "chapter",
    text: "",
    revision: 0,
    sequence: 0
  });

  const ticketIds = [];
  const editCount = 40;
  for (let sequence = 1; sequence <= editCount; sequence += 1) {
    const admission = engine.submitChange({
      documentId: "chapter",
      sequence,
      baseRevision: sequence - 1,
      start: sequence - 1,
      end: sequence - 1,
      replacement: "x"
    });
    assert.equal(admission.status, "queued", "la edición " + sequence + " debe ser admitida");
    ticketIds.push(admission.ticketId);
  }

  await firstAppendStarted.promise;
  const whilePersisting = engine.getSyncState("chapter");
  assert.equal(whilePersisting.sequence, 0);
  assert.equal(whilePersisting.pendingSequence, editCount);
  assert.equal(whilePersisting.needsResync, false);

  releaseFirstAppend.resolve();
  await engine.waitForIdle();

  const completed = engine.getSyncState("chapter");
  assert.equal(completed.sequence, editCount);
  assert.equal(completed.pendingSequence, editCount);
  assert.equal(completed.needsResync, false);
  assert.equal(engine.getSnapshot("chapter").text, "x".repeat(editCount));
  assert.equal(engine.getMetrics().appliedChanges, editCount);
  for (const ticketId of ticketIds) {
    assert.equal(engine.getCommit(ticketId).status, "applied");
  }
});
