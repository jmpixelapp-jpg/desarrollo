import test from "node:test";
import assert from "node:assert/strict";
import {
  LiveAuthorMonitorEditorTransactionBridge,
  LiveAuthorMonitorEditorTransactionSource
} from "../dist/motor-literario.js";

class NativeEditorState {
  snapshot;
  constructor(text = "abc") {
    this.snapshot = { documentId: "chapter-1", text, revision: 0, sequence: 0 };
  }

  getSnapshot(documentId) {
    return documentId === this.snapshot.documentId ? { ...this.snapshot } : undefined;
  }

  getDocumentState(documentId) {
    const snapshot = this.getSnapshot(documentId);
    return snapshot ? {
      documentId: snapshot.documentId,
      revision: snapshot.revision,
      sequence: snapshot.sequence,
      documentLength: snapshot.text.length
    } : undefined;
  }

  apply(kind, transactionId, { start, end, replacement }) {
    const previous = this.snapshot;
    const transaction = {
      transactionId,
      kind,
      change: {
        documentId: previous.documentId,
        sequence: previous.sequence + 1,
        baseRevision: previous.revision,
        start,
        end,
        replacement
      }
    };
    this.snapshot = {
      documentId: previous.documentId,
      text: previous.text.slice(0, start) + replacement + previous.text.slice(end),
      revision: previous.revision + 1,
      sequence: previous.sequence + 1
    };
    return transaction;
  }
}

test("conecta snapshot y metadatos nativos y entrega edit/undo/redo en el orden aplicado", () => {
  const native = new NativeEditorState();
  const bridge = new LiveAuthorMonitorEditorTransactionBridge({
    getSnapshot: documentId => native.getSnapshot(documentId),
    getDocumentState: documentId => native.getDocumentState(documentId)
  });
  const source = new LiveAuthorMonitorEditorTransactionSource({
    documentId: "chapter-1",
    initialSnapshot: native.getSnapshot("chapter-1"),
    provider: bridge
  });
  const changes = [];
  const stop = source.subscribeChanges(change => changes.push(change));

  const edit = native.apply("edit", "native-edit", {
    start: 3, end: 3, replacement: "!"
  });
  assert.equal(bridge.publishAppliedTransaction("chapter-1", edit), 1);

  const undo = native.apply("undo", "native-undo", {
    start: 3, end: 4, replacement: ""
  });
  assert.equal(bridge.publishAppliedTransaction("chapter-1", undo), 1);

  const redo = native.apply("redo", "native-redo", {
    start: 3, end: 3, replacement: "!"
  });
  assert.equal(bridge.publishAppliedTransaction("chapter-1", redo), 1);

  assert.deepEqual(changes.map(change => change.sequence), [1, 2, 3]);
  assert.equal(source.getState().lastTransactionKind, "redo");
  assert.equal(native.snapshot.text, "abc!");
  assert.equal(source.getState().documentLength, native.snapshot.text.length);

  stop();
  source.dispose();
  assert.equal(bridge.getSubscriberCount(), 0);
  bridge.dispose();
});

test("un listener defectuoso no impide entregar la transacción a los demás", () => {
  const native = new NativeEditorState();
  const listenerErrors = [];
  const bridge = new LiveAuthorMonitorEditorTransactionBridge({
    getSnapshot: documentId => native.getSnapshot(documentId),
    getDocumentState: documentId => native.getDocumentState(documentId),
    onListenerError: (error, documentId) => listenerErrors.push({ error, documentId })
  });
  const calls = [];
  const stopFailing = bridge.subscribeTransactions("chapter-1", () => {
    throw new Error("observer_failed");
  });
  const stopHealthy = bridge.subscribeTransactions("chapter-1", transaction => {
    calls.push(transaction);
  });

  const transaction = native.apply("edit", "native-edit", {
    start: 3, end: 3, replacement: "!"
  });
  assert.equal(bridge.publishAppliedTransaction("chapter-1", transaction), 1);
  assert.equal(calls.length, 1);
  assert.equal(Object.isFrozen(calls[0]), true);
  assert.equal(Object.isFrozen(calls[0].change), true);
  assert.equal(listenerErrors.length, 1);
  assert.equal(listenerErrors[0].documentId, "chapter-1");

  stopFailing();
  stopHealthy();
  bridge.dispose();
});

test("el puente separa documentos, hace disposer idempotente y no publica tras dispose", () => {
  const native = new NativeEditorState();
  const bridge = new LiveAuthorMonitorEditorTransactionBridge({
    getSnapshot: documentId => native.getSnapshot(documentId),
    getDocumentState: documentId => native.getDocumentState(documentId)
  });
  let calls = 0;
  const stop = bridge.subscribeTransactions("chapter-1", () => calls++);
  assert.equal(bridge.getSubscriberCount(), 1);
  assert.equal(bridge.getSubscriberCount("another-document"), 0);

  const transaction = native.apply("edit", "native-edit", {
    start: 3, end: 3, replacement: "!"
  });
  assert.equal(bridge.publishAppliedTransaction("another-document", transaction), 0);
  assert.equal(bridge.publishAppliedTransaction("chapter-1", transaction), 1);
  assert.equal(calls, 1);

  stop();
  stop();
  assert.equal(bridge.getSubscriberCount(), 0);
  assert.equal(bridge.publishAppliedTransaction("chapter-1", transaction), 0);
  bridge.dispose();
  bridge.dispose();
  assert.equal(bridge.publishAppliedTransaction("chapter-1", transaction), 0);
  assert.throws(() => bridge.getSnapshot("chapter-1"), /dispuesto/);
  assert.throws(() => bridge.subscribeTransactions("chapter-1", () => {}), /dispuesto/);
});
