import test from "node:test";
import assert from "node:assert/strict";
const monitorModule = await import("../dist-monitor/live-author-monitor.js")
  .catch(() => import("../dist/motor-literario.js"));
const { LiveAuthorMonitorEditorTransactionBridge, LiveAuthorMonitorEditorTransactionSource } = monitorModule;

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

  apply(kind, transactionId, { start, end, replacement, activityKind, inputType }) {
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
        replacement,
        ...(activityKind === undefined ? {} : { activityKind }),
        ...(inputType === undefined ? {} : { inputType })
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
    start: 3, end: 3, replacement: "!", activityKind: "typing", inputType: "insertText"
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
  assert.equal(changes[0].inputType, "insertText",
    "el puente debe conservar el identificador nativo exacto sin leer el payload del evento");
  assert.equal(source.getState().lastTransactionKind, "redo");
  assert.equal(native.snapshot.text, "abc!");
  assert.equal(source.getState().documentLength, native.snapshot.text.length);
  assert.deepEqual(bridge.getDocumentState("chapter-1"), {
    documentId: "chapter-1",
    revision: 3,
    sequence: 3,
    documentLength: 4
  });

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
  assert.equal(
    bridge.publishAppliedTransaction("chapter-1", transaction),
    2,
    "el retorno cuenta los listeners seleccionados aunque uno falle"
  );
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


test("serializa publicaciones reentrantes para que todos los listeners vean el mismo orden", () => {
  const native = new NativeEditorState();
  const bridge = new LiveAuthorMonitorEditorTransactionBridge({
    getSnapshot: documentId => native.getSnapshot(documentId),
    getDocumentState: documentId => native.getDocumentState(documentId)
  });
  const order = [];
  let nestedPublished = false;

  bridge.subscribeTransactions("chapter-1", transaction => {
    order.push("first:" + transaction.change.sequence);
    if (transaction.change.sequence === 1 && !nestedPublished) {
      nestedPublished = true;
      const nested = native.apply("edit", "nested-edit", {
        start: 4, end: 4, replacement: "?"
      });
      assert.equal(bridge.publishAppliedTransaction("chapter-1", nested), 2);
    }
  });
  bridge.subscribeTransactions("chapter-1", transaction => {
    order.push("second:" + transaction.change.sequence);
  });

  const outer = native.apply("edit", "outer-edit", {
    start: 3, end: 3, replacement: "!"
  });
  assert.equal(bridge.publishAppliedTransaction("chapter-1", outer), 2);
  assert.deepEqual(order, ["first:1", "second:1", "first:2", "second:2"]);
  assert.equal(native.snapshot.text, "abc!?");
  bridge.dispose();
});


test("cuarentena payloads runtime nulos sin lanzar al callback nativo", () => {
  const native = new NativeEditorState();
  const bridge = new LiveAuthorMonitorEditorTransactionBridge({
    getSnapshot: documentId => native.getSnapshot(documentId),
    getDocumentState: documentId => native.getDocumentState(documentId)
  });
  const errors = [];
  const source = new LiveAuthorMonitorEditorTransactionSource({
    documentId: "chapter-1",
    initialSnapshot: native.getSnapshot("chapter-1"),
    provider: bridge,
    onError: error => errors.push(error)
  });
  source.subscribeChanges(() => {});

  assert.doesNotThrow(() => {
    bridge.publishAppliedTransaction("chapter-1", null);
  });
  assert.equal(source.getState().needsResync, true);
  assert.equal(errors.at(-1).code, "invalid-transaction");

  source.dispose();
  bridge.dispose();
});

  const nativeWithProxy = new NativeEditorState();
  const proxyBridge = new LiveAuthorMonitorEditorTransactionBridge({
    getSnapshot: documentId => nativeWithProxy.getSnapshot(documentId),
    getDocumentState: documentId => nativeWithProxy.getDocumentState(documentId)
  });
  const proxyErrors = [];
  const proxySource = new LiveAuthorMonitorEditorTransactionSource({
    documentId: "chapter-1",
    initialSnapshot: nativeWithProxy.getSnapshot("chapter-1"),
    provider: proxyBridge,
    onError: error => proxyErrors.push(error)
  });
  proxySource.subscribeChanges(() => {});
  const throwingPayload = new Proxy({}, {
    get() {
      throw new Error("bridge_transaction_getter_failed");
    }
  });
  assert.doesNotThrow(() => {
    proxyBridge.publishAppliedTransaction("chapter-1", throwingPayload);
  });
  assert.equal(proxySource.getState().needsResync, true);
  assert.equal(proxyErrors.at(-1).code, "invalid-transaction");
  proxySource.dispose();
  proxyBridge.dispose();


test("drena mil publicaciones reentrantes del editor sin recursión y en FIFO para todos los listeners", () => {
  const native = new NativeEditorState();
  const bridge = new LiveAuthorMonitorEditorTransactionBridge({
    getSnapshot: documentId => native.getSnapshot(documentId),
    getDocumentState: documentId => native.getDocumentState(documentId)
  });
  const firstOrder = [];
  const secondOrder = [];
  const publicationCounts = [];
  const total = 1_000;

  bridge.subscribeTransactions("chapter-1", transaction => {
    const sequence = transaction.change.sequence;
    firstOrder.push(sequence);
    if (sequence !== 1) return;

    for (let next = 2; next <= total; next++) {
      const change = native.apply("edit", "burst-" + next, {
        start: native.snapshot.text.length,
        end: native.snapshot.text.length,
        replacement: "x"
      });
      publicationCounts.push(bridge.publishAppliedTransaction("chapter-1", change) === 2);
    }
  });
  bridge.subscribeTransactions("chapter-1", transaction => {
    secondOrder.push(transaction.change.sequence);
  });

  const initial = native.apply("edit", "burst-1", {
    start: 3, end: 3, replacement: "!"
  });
  assert.equal(bridge.publishAppliedTransaction("chapter-1", initial), 2);

  const expected = Array.from({ length: total }, (_, index) => index + 1);
  assert.deepEqual(firstOrder, expected);
  assert.deepEqual(secondOrder, expected);
  assert.equal(publicationCounts.length, total - 1);
  assert.equal(publicationCounts.every(Boolean), true);
  assert.equal(native.snapshot.sequence, total);
  assert.equal(bridge.getSubscriberCount("chapter-1"), 2);
  bridge.dispose();
});
