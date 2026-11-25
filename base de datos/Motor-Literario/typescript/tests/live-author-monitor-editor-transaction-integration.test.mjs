import test from "node:test";
import assert from "node:assert/strict";
import {
  mountLiveAuthorMonitorEditorTransactions
} from "../dist/motor-literario.js";

class FakeTransactionalEditor {
  snapshot;
  listeners = new Set();
  subscribeCount = 0;
  onSubscribe;

  constructor(snapshot) { this.snapshot = { ...snapshot }; }

  getSnapshot(documentId) {
    return documentId === this.snapshot.documentId ? { ...this.snapshot } : undefined;
  }

  subscribeTransactions(documentId, listener) {
    if (documentId !== this.snapshot.documentId) throw new Error("unknown_document");
    this.listeners.add(listener);
    this.subscribeCount++;
    this.onSubscribe?.(this, listener, this.subscribeCount);
    return () => this.listeners.delete(listener);
  }

  apply(kind, transactionId, { start, end, replacement }) {
    const previous = this.snapshot;
    const change = {
      documentId: previous.documentId,
      sequence: previous.sequence + 1,
      baseRevision: previous.revision,
      start,
      end,
      replacement
    };
    this.snapshot = {
      documentId: previous.documentId,
      text: previous.text.slice(0, start) + replacement + previous.text.slice(end),
      revision: previous.revision + 1,
      sequence: previous.sequence + 1
    };
    const transaction = { transactionId, kind, change };
    for (const listener of [...this.listeners]) listener(transaction);
    return change;
  }
}

function fixture(text = "abc") {
  const documentId = "chapter-1";
  const initial = { documentId, text, revision: 0, sequence: 0 };
  const editor = new FakeTransactionalEditor(initial);
  let hostSnapshot = { ...initial };
  let sync = { sequence: 0, pendingSequence: 0, needsResync: false };
  let monitorSnapshot = {
    needsResync: false,
    latestRevision: 0,
    latestSequence: 0,
    currentDocumentLength: text.length
  };
  let rejectNext;
  const changes = [];
  const admissions = [];
  const errors = [];
  const retryListeners = new Set();

  const hostApi = {
    getSnapshot: id => id === documentId ? { ...hostSnapshot } : undefined,
    getDocumentSyncState: id => id === documentId ? { ...sync } : undefined,
    onEditorChange(change) {
      changes.push(change);
      if (rejectNext) {
        const reason = rejectNext;
        rejectNext = undefined;
        const rejected = { status: "rejected", reason };
        admissions.push(rejected);
        return rejected;
      }

      const admission = { status: "queued", ticketId: "ticket-" + change.sequence };
      admissions.push(admission);
      hostSnapshot = {
        documentId,
        text: hostSnapshot.text.slice(0, change.start) +
          change.replacement + hostSnapshot.text.slice(change.end),
        revision: hostSnapshot.revision + 1,
        sequence: change.sequence
      };
      sync = {
        sequence: hostSnapshot.sequence,
        pendingSequence: hostSnapshot.sequence,
        needsResync: false
      };
      monitorSnapshot = {
        needsResync: false,
        latestRevision: hostSnapshot.revision,
        latestSequence: hostSnapshot.sequence,
        currentDocumentLength: hostSnapshot.text.length
      };
      publishRetrySignal();
      return admission;
    },
    getLiveAuthorMonitorSnapshot: id => id === documentId ? monitorSnapshot : undefined,
    ensureLiveAuthorMonitorDocument: id => {
      if (id !== documentId) throw new Error("unknown_document");
      monitorSnapshot = {
        needsResync: false,
        latestRevision: hostSnapshot.revision,
        latestSequence: hostSnapshot.sequence,
        currentDocumentLength: hostSnapshot.text.length
      };
      return monitorSnapshot;
    },
    subscribeLiveAuthorMonitor(listener) {
      retryListeners.add(listener);
      return () => retryListeners.delete(listener);
    },
    resynchronizeLiveAuthorMonitor(snapshot) {
      monitorSnapshot = {
        needsResync: false,
        latestRevision: snapshot.revision,
        latestSequence: snapshot.sequence,
        currentDocumentLength: snapshot.text.length
      };
      return monitorSnapshot;
    }
  };

  function publishRetrySignal() {
    for (const listener of [...retryListeners]) listener(monitorSnapshot);
  }

  const pressureStates = [];
  const integration = mountLiveAuthorMonitorEditorTransactions({
    documentId,
    editor,
    hostApi,
    onAdmission: (_change, admission) => admissions.push(admission),
    onBackpressure: state => pressureStates.push(state),
    onError: (error, change) => errors.push({ error, change })
  });

  return {
    editor,
    hostApi,
    integration,
    changes,
    admissions,
    errors,
    pressureStates,
    retryListeners,
    getHostSnapshot: () => ({ ...hostSnapshot }),
    rejectNext(reason) { rejectNext = reason; },
    setHostSnapshot(snapshot) {
      hostSnapshot = { ...snapshot };
      sync = {
        sequence: snapshot.sequence,
        pendingSequence: snapshot.sequence,
        needsResync: false
      };
    },
    publishRetrySignal
  };
}

test("monta el adaptador nativo y entrega edición, undo y redo al motor en orden", () => {
  const f = fixture();
  f.editor.apply("edit", "tx-edit", { start: 3, end: 3, replacement: "!" });
  f.editor.apply("undo", "tx-undo", { start: 3, end: 4, replacement: "" });
  f.editor.apply("redo", "tx-redo", { start: 3, end: 3, replacement: "!" });

  assert.deepEqual(f.changes.map(change => [
    change.sequence, change.baseRevision, change.start, change.end, change.replacement
  ]), [
    [1, 0, 3, 3, "!"],
    [2, 1, 3, 4, ""],
    [3, 2, 3, 3, "!"]
  ]);
  assert.equal(f.integration.getState().lastTransactionKind, "redo");
  assert.equal(f.getHostSnapshot().text, "abc!");
  assert.equal(f.getHostSnapshot().sequence, 3);
  assert.equal(f.integration.getPendingChanges().length, 0);

  f.integration.dispose();
  assert.equal(f.editor.listeners.size, 0);
  assert.equal(f.retryListeners.size, 0);
});

test("retiene undo/redo detrás de queue_full y reintenta las transacciones en FIFO", () => {
  const f = fixture();
  f.rejectNext("queue_full");
  f.editor.apply("edit", "tx-edit", { start: 3, end: 3, replacement: "!" });
  f.editor.apply("undo", "tx-undo", { start: 3, end: 4, replacement: "" });

  assert.deepEqual(f.integration.getPendingChanges().map(change => change.sequence), [1, 2]);
  assert.deepEqual(f.changes.map(change => change.sequence), [1]);
  assert.deepEqual(f.pressureStates.map(state => [state.status, state.pendingCount]), [
    ["backpressured", 1],
    ["backpressured", 2]
  ]);

  f.publishRetrySignal();
  assert.deepEqual(f.changes.map(change => change.sequence), [1, 1, 2]);
  assert.equal(f.getHostSnapshot().text, "abc");
  assert.equal(f.getHostSnapshot().sequence, 2);
  assert.deepEqual(f.integration.getPendingChanges(), []);
  assert.deepEqual(f.pressureStates.map(state => [state.status, state.pendingCount]), [
    ["backpressured", 1],
    ["backpressured", 2],
    ["backpressured", 1],
    ["clear", 0]
  ]);
  f.integration.dispose();
});

test("requiere que motor y editor compartan snapshot durable para descartar backlog", () => {
  const f = fixture();
  f.rejectNext("queue_full");
  f.editor.apply("edit", "tx-edit", { start: 3, end: 3, replacement: "!" });
  assert.equal(f.integration.getPendingChanges().length, 1);

  assert.throws(() => f.integration.resynchronize(), /editor debe coincidir/);
  assert.equal(f.integration.getPendingChanges().length, 1);

  f.setHostSnapshot(f.editor.getSnapshot("chapter-1"));
  const state = f.integration.resynchronize();
  assert.equal(state.needsResync, false);
  assert.equal(state.sequence, 1);
  assert.equal(f.integration.getPendingChanges().length, 0);
  assert.deepEqual(f.pressureStates.at(-1), { status: "clear", pendingCount: 0 });
  f.integration.dispose();
});

test("suspende el proveedor para rechazos no recuperables y permite reanudar tras reconciliar", () => {
  const f = fixture();
  f.rejectNext("invalid_change");
  f.editor.apply("edit", "tx-invalid", { start: 3, end: 3, replacement: "!" });

  assert.equal(f.integration.getState().needsResync, true);
  assert.equal(f.editor.listeners.size, 0);
  assert.equal(f.errors[0].error.code, "resync-required");

  f.setHostSnapshot(f.editor.getSnapshot("chapter-1"));
  const state = f.integration.resynchronize();
  assert.equal(state.needsResync, false);
  assert.equal(f.editor.listeners.size, 1);

  f.editor.apply("undo", "tx-undo", { start: 3, end: 4, replacement: "" });
  assert.equal(f.changes.at(-1).sequence, 2);
  f.integration.dispose();
});


test("no permite desmontar transacciones nativas mientras existan deltas sin admitir", () => {
  const f = fixture();
  f.rejectNext("queue_full");
  f.editor.apply("edit", "tx-pending-dispose", {
    start: 3, end: 3, replacement: "!"
  });

  assert.deepEqual(f.integration.getPendingChanges().map(change => change.sequence), [1]);
  assert.throws(() => f.integration.dispose(), /cambios sin admitir/);
  assert.equal(f.editor.listeners.size, 1);
  assert.equal(f.retryListeners.size, 1);
  assert.deepEqual(f.integration.getPendingChanges().map(change => change.sequence), [1]);

  f.publishRetrySignal();
  assert.deepEqual(f.integration.getPendingChanges(), []);
  assert.equal(f.getHostSnapshot().sequence, 1);

  f.integration.dispose();
  assert.equal(f.editor.listeners.size, 0);
  assert.equal(f.retryListeners.size, 0);
});


test("preserva transacciones nuevas reproducidas sincrónicamente al resincronizar", () => {
  const f = fixture();
  f.rejectNext("invalid_change");
  f.editor.apply("edit", "tx-included-in-snapshot", {
    start: 3, end: 3, replacement: "!"
  });

  assert.equal(f.integration.getState().needsResync, true);
  assert.deepEqual(f.integration.getPendingChanges().map(change => change.sequence), [1]);

  // El snapshot autoritativo ya contiene el cambio antiguo retenido.
  f.setHostSnapshot(f.editor.getSnapshot("chapter-1"));
  f.editor.onSubscribe = (editor, _listener, subscribeCount) => {
    if (subscribeCount === 2) {
      // El editor reproduce un cambio posterior mientras se registra el listener.
      editor.apply("edit", "tx-emitted-during-resubscribe", {
        start: 4, end: 4, replacement: "?"
      });
    }
  };

  const state = f.integration.resynchronize();
  assert.equal(state.needsResync, false);
  assert.equal(state.sequence, 2);
  assert.equal(f.editor.subscribeCount, 2);
  assert.equal(f.getHostSnapshot().sequence, 2);
  assert.equal(f.getHostSnapshot().revision, 2);
  assert.equal(f.getHostSnapshot().text, "abc!?");
  assert.deepEqual(f.integration.getPendingChanges(), []);
  assert.deepEqual(f.pressureStates.at(-1), { status: "clear", pendingCount: 0 });

  f.integration.dispose();
  assert.equal(f.editor.listeners.size, 0);
  assert.equal(f.retryListeners.size, 0);
});

test("rechaza montar cuando el editor nativo no coincide con HostEngineApi", () => {
  const initial = { documentId: "chapter-1", text: "abc", revision: 0, sequence: 0 };
  const editor = new FakeTransactionalEditor({ ...initial, text: "other" });
  const hostApi = {
    getSnapshot: () => initial,
    getDocumentSyncState: () => ({ sequence: 0, pendingSequence: 0, needsResync: false }),
    onEditorChange: () => ({ status: "rejected", reason: "unknown_document" }),
    getLiveAuthorMonitorSnapshot: () => undefined,
    ensureLiveAuthorMonitorDocument: () => { throw new Error("must not mount"); },
    subscribeLiveAuthorMonitor: () => () => {},
    resynchronizeLiveAuthorMonitor: () => { throw new Error("must not resync"); }
  };

  assert.throws(() => mountLiveAuthorMonitorEditorTransactions({
    documentId: "chapter-1",
    editor,
    hostApi
  }), /deben compartir el mismo snapshot/);
  assert.equal(editor.listeners.size, 0);
});
