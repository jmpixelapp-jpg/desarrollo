import test from "node:test";
import assert from "node:assert/strict";
import {
  LiveAuthorMonitorEditorTransactionSource
} from "../dist/motor-literario.js";

class FakeTransactionalEditor {
  snapshot;
  listeners = new Set();
  subscribeCount = 0;
  unsubscribeCount = 0;

  constructor(snapshot) { this.snapshot = { ...snapshot }; }

  getSnapshot(documentId) {
    return documentId === this.snapshot.documentId ? { ...this.snapshot } : undefined;
  }

  subscribeTransactions(documentId, listener) {
    if (documentId !== this.snapshot.documentId) throw new Error("unknown_document");
    this.subscribeCount++;
    this.listeners.add(listener);
    return () => {
      if (this.listeners.delete(listener)) this.unsubscribeCount++;
    };
  }

  apply(kind, transactionId, { start, end, replacement }, sequence = this.snapshot.sequence + 1) {
    const previous = this.snapshot;
    const change = {
      documentId: previous.documentId,
      sequence,
      baseRevision: previous.revision,
      start,
      end,
      replacement
    };
    const nextText = previous.text.slice(0, start) + replacement + previous.text.slice(end);
    this.snapshot = {
      documentId: previous.documentId,
      text: nextText,
      revision: previous.revision + 1,
      sequence
    };
    const transaction = { transactionId, kind, change };
    for (const listener of [...this.listeners]) listener(transaction);
    return transaction;
  }

  publish(transaction) {
    for (const listener of [...this.listeners]) listener(transaction);
  }

  replaceSnapshot(snapshot) { this.snapshot = { ...snapshot }; }
}

function fixture(text = "abc", revision = 0, sequence = 0, options = {}) {
  const snapshot = { documentId: "chapter-1", text, revision, sequence };
  const editor = new FakeTransactionalEditor(snapshot);
  const errors = [];
  const changes = [];
  const source = new LiveAuthorMonitorEditorTransactionSource({
    documentId: snapshot.documentId,
    initialSnapshot: snapshot,
    provider: editor,
    ...(options.duplicateWindowSize ? { duplicateWindowSize: options.duplicateWindowSize } : {}),
    ...(options.maxQueuedTransactions ? { maxQueuedTransactions: options.maxQueuedTransactions } : {}),
    onError: error => errors.push(error)
  });
  const stop = source.subscribeChanges(change => changes.push(change));
  return { editor, source, errors, changes, stop, snapshot };
}

test("convierte edición, undo y redo del editor en deltas autoritativos consecutivos", () => {
  const f = fixture("abc");

  const edit = f.editor.apply("edit", "tx-edit-1", {
    start: 3, end: 3, replacement: "!"
  });
  const undo = f.editor.apply("undo", "tx-undo-1", {
    start: 3, end: 4, replacement: ""
  });
  const redo = f.editor.apply("redo", "tx-redo-1", {
    start: 3, end: 3, replacement: "!"
  });

  assert.deepEqual(f.changes, [edit.change, undo.change, redo.change]);
  assert.deepEqual(f.changes.map(change => [change.sequence, change.baseRevision]), [
    [1, 0], [2, 1], [3, 2]
  ]);
  assert.equal(f.source.getState().lastTransactionKind, "redo");
  assert.equal(f.source.getState().documentLength, 4);
  assert.equal(f.source.getState().needsResync, false);
  f.stop();
  f.source.dispose();
});

test("ignora una notificación repetida del mismo transactionId y secuencia", () => {
  const f = fixture();
  const transaction = f.editor.apply("edit", "tx-duplicate", {
    start: 3, end: 3, replacement: "x"
  });
  // El proveedor puede reconstruir el objeto al retransmitir el mismo evento.
  f.editor.publish(structuredClone(transaction));

  assert.equal(f.changes.length, 1);
  assert.equal(f.source.getState().sequence, 1);
  assert.equal(f.source.getState().needsResync, false);
  f.stop();
  f.source.dispose();
});

test("suspende el stream si un transactionId se reutiliza con otra secuencia", () => {
  const f = fixture();
  f.editor.apply("edit", "tx-reused", {
    start: 3, end: 3, replacement: "x"
  });
  f.editor.apply("undo", "tx-reused", {
    start: 3, end: 4, replacement: ""
  });

  assert.equal(f.changes.length, 1);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.errors.at(-1).code, "transaction-id-reused");
  assert.equal(f.editor.listeners.size, 0);
  f.stop();
  f.source.dispose();
});

test("rechaza huecos de secuencia y revisiones base no consecutivas", () => {
  const f = fixture();
  f.editor.apply("edit", "tx-gap", {
    start: 3, end: 3, replacement: "x"
  }, 2);

  assert.equal(f.changes.length, 0);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.errors[0].code, "sequence-gap");
  assert.equal(f.editor.listeners.size, 0);
  f.stop();
  f.source.dispose();
});

test("rechaza el montaje cuando el snapshot local del editor difiere del motor", () => {
  const snapshot = { documentId: "chapter-1", text: "abc", revision: 0, sequence: 0 };
  const editor = new FakeTransactionalEditor({ ...snapshot, text: "different" });
  assert.throws(() => new LiveAuthorMonitorEditorTransactionSource({
    documentId: snapshot.documentId,
    initialSnapshot: snapshot,
    provider: editor
  }), error => error.code === "editor-snapshot-mismatch");
  assert.equal(editor.listeners.size, 0);
});

test("resincroniza desde el snapshot común y restaura la suscripción de transacciones", () => {
  const f = fixture("abc");
  f.editor.apply("edit", "tx-gap", {
    start: 3, end: 3, replacement: "x"
  }, 2);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.editor.listeners.size, 0);

  const authoritative = f.editor.getSnapshot("chapter-1");
  const state = f.source.resynchronize(authoritative);
  assert.equal(state.needsResync, false);
  assert.equal(state.sequence, 2);
  assert.equal(f.editor.listeners.size, 1);
  assert.equal(f.editor.subscribeCount, 2);

  const next = f.editor.apply("undo", "tx-undo-after-resync", {
    start: 3, end: 4, replacement: ""
  });
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].sequence, next.change.sequence);
  f.stop();
  f.source.dispose();
});

test("no resincroniza si el snapshot entregado no coincide con el editor nativo", () => {
  const f = fixture();
  assert.throws(() => f.source.resynchronize({
    documentId: "chapter-1",
    text: "not-the-editor",
    revision: 3,
    sequence: 3
  }), error => error.code === "editor-snapshot-mismatch");
  f.stop();
  f.source.dispose();
});

test("retira la suscripción nativa al desmontar la última fuente", () => {
  const f = fixture();
  assert.equal(f.editor.listeners.size, 1);
  f.stop();
  assert.equal(f.editor.listeners.size, 0);
  assert.equal(f.editor.unsubscribeCount, 1);
  f.editor.apply("edit", "tx-after-stop", {
    start: 3, end: 3, replacement: "!"
  });
  assert.equal(f.changes.length, 0);
  f.source.dispose();
});

test("acota la ventana de IDs de transacción duplicados", () => {
  const f = fixture("abc", 0, 0, { duplicateWindowSize: 1 });
  const first = f.editor.apply("edit", "tx-1", {
    start: 3, end: 3, replacement: "x"
  });
  f.editor.apply("undo", "tx-2", {
    start: 3, end: 4, replacement: ""
  });
  f.editor.publish(first);

  assert.equal(f.changes.length, 2);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.errors.at(-1).code, "sequence-gap");
  f.stop();
  f.source.dispose();
});

test("no acepta una transacción antes de que el snapshot nativo refleje el cambio", () => {
  const f = fixture("abc");
  f.editor.publish({
    transactionId: "tx-not-applied",
    kind: "edit",
    change: {
      documentId: "chapter-1",
      sequence: 1,
      baseRevision: 0,
      start: 3,
      end: 3,
      replacement: "!"
    }
  });

  assert.equal(f.changes.length, 0);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.errors.at(-1).code, "editor-state-mismatch");
  assert.equal(f.editor.listeners.size, 0);
  f.stop();
  f.source.dispose();
});

test("retira una suscripción cuando el editor emite un evento inválido de forma síncrona al suscribirse", () => {
  const snapshot = { documentId: "chapter-1", text: "abc", revision: 0, sequence: 0 };
  const editor = new FakeTransactionalEditor(snapshot);
  const provider = {
    getSnapshot: documentId => editor.getSnapshot(documentId),
    subscribeTransactions(documentId, listener) {
      const unsubscribe = editor.subscribeTransactions(documentId, listener);
      listener({
        transactionId: "tx-wrong-document",
        kind: "edit",
        change: {
          documentId: "another-document",
          sequence: 1,
          baseRevision: 0,
          start: 0,
          end: 0,
          replacement: "x"
        }
      });
      return unsubscribe;
    }
  };
  const errors = [];
  const source = new LiveAuthorMonitorEditorTransactionSource({
    documentId: snapshot.documentId,
    initialSnapshot: snapshot,
    provider,
    onError: error => errors.push(error)
  });

  source.subscribeChanges(() => {});
  assert.equal(source.getState().needsResync, true);
  assert.equal(errors.at(-1).code, "document-mismatch");
  assert.equal(editor.listeners.size, 0);
  assert.equal(editor.unsubscribeCount, 1);
  source.dispose();
});

test("retira la suscripción si un listener dispone el source durante una emisión síncrona de montaje", () => {
  const snapshot = { documentId: "chapter-1", text: "abc", revision: 0, sequence: 0 };
  const editor = new FakeTransactionalEditor(snapshot);
  let source;
  const provider = {
    getSnapshot: documentId => editor.getSnapshot(documentId),
    subscribeTransactions(documentId, listener) {
      const unsubscribe = editor.subscribeTransactions(documentId, listener);
      editor.apply("edit", "tx-during-subscribe", {
        start: 3, end: 3, replacement: "!"
      });
      return unsubscribe;
    }
  };
  source = new LiveAuthorMonitorEditorTransactionSource({
    documentId: snapshot.documentId,
    initialSnapshot: snapshot,
    provider
  });

  source.subscribeChanges(() => source.dispose());
  assert.equal(source.getState().sequence, 1);
  assert.equal(editor.listeners.size, 0);
  assert.equal(editor.unsubscribeCount, 1);
});

test("convierte un error al leer el snapshot en pausa segura sin propagarlo al editor", () => {
  const snapshot = { documentId: "chapter-1", text: "abc", revision: 0, sequence: 0 };
  const editor = new FakeTransactionalEditor(snapshot);
  let snapshotUnavailable = false;
  const provider = {
    getSnapshot(documentId) {
      if (snapshotUnavailable) throw new Error("snapshot_temporarily_unavailable");
      return editor.getSnapshot(documentId);
    },
    subscribeTransactions(documentId, listener) {
      return editor.subscribeTransactions(documentId, listener);
    }
  };
  const errors = [];
  const source = new LiveAuthorMonitorEditorTransactionSource({
    documentId: snapshot.documentId,
    initialSnapshot: snapshot,
    provider,
    onError: error => errors.push(error)
  });
  source.subscribeChanges(() => {});

  snapshotUnavailable = true;
  assert.doesNotThrow(() => editor.apply("edit", "tx-snapshot-error", {
    start: 3, end: 3, replacement: "!"
  }));
  assert.equal(source.getState().needsResync, true);
  assert.equal(errors.at(-1).code, "editor-state-unavailable");
  assert.equal(editor.listeners.size, 0);
  source.dispose();
});


test("mantiene orden FIFO y snapshot coherente entre suscriptores ante reentrada síncrona", () => {
  const f = fixture("abc");
  const firstSeen = [];
  const secondSeen = [];
  let emittedNested = false;

  const stopFirst = f.source.subscribeChanges(change => {
    firstSeen.push([change.sequence, f.source.getState().sequence]);
    if (change.sequence === 1 && !emittedNested) {
      emittedNested = true;
      f.editor.apply("edit", "tx-reentrant", {
        start: 4, end: 4, replacement: "?"
      });
    }
  });
  const stopSecond = f.source.subscribeChanges(change => {
    secondSeen.push([change.sequence, f.source.getState().sequence]);
  });

  f.editor.apply("edit", "tx-outer", {
    start: 3, end: 3, replacement: "!"
  });

  assert.deepEqual(firstSeen, [[1, 1], [2, 2]]);
  assert.deepEqual(secondSeen, [[1, 1], [2, 2]]);
  assert.equal(f.source.getState().sequence, 2);
  assert.equal(f.source.getState().needsResync, false);

  stopSecond();
  stopFirst();
  f.stop();
  f.source.dispose();
});


test("limita transacciones reentrantes pendientes y exige resincronización sin perderlas silenciosamente", () => {
  const f = fixture("abc", 0, 0, { maxQueuedTransactions: 1 });
  const observed = [];
  const stopReentrant = f.source.subscribeChanges(change => {
    observed.push(change.sequence);
    if (change.sequence === 1) {
      f.editor.apply("edit", "tx-backlog-2", {
        start: 4, end: 4, replacement: "?"
      });
      f.editor.apply("edit", "tx-backlog-3", {
        start: 5, end: 5, replacement: "#"
      });
    }
  });

  f.editor.apply("edit", "tx-backlog-1", {
    start: 3, end: 3, replacement: "!"
  });

  assert.deepEqual(observed, [1]);
  assert.equal(f.source.getState().sequence, 1);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.errors.at(-1).code, "transaction-backlog-overflow");
  assert.equal(f.editor.listeners.size, 0);

  // El snapshot local incorpora las transacciones que no se entregaron al source.
  const recovered = f.source.resynchronize(f.editor.getSnapshot("chapter-1"));
  assert.equal(recovered.needsResync, false);
  assert.equal(recovered.sequence, 3);
  assert.equal(f.editor.listeners.size, 1);

  f.editor.apply("edit", "tx-after-overflow-recovery", {
    start: 6, end: 6, replacement: "$"
  });
  assert.deepEqual(observed, [1, 4]);
  assert.equal(f.source.getState().sequence, 4);
  assert.equal(f.source.getState().needsResync, false);

  stopReentrant();
  f.stop();
  f.source.dispose();
});


test("valida el rango entero de maxQueuedTransactions y admite sus límites", () => {
  const snapshot = { documentId: "chapter-1", text: "abc", revision: 0, sequence: 0 };
  const invalidLimits = [0, -1, 1.5, 65537, Number.NaN, Number.POSITIVE_INFINITY];

  for (const maxQueuedTransactions of invalidLimits) {
    const editor = new FakeTransactionalEditor(snapshot);
    assert.throws(() => new LiveAuthorMonitorEditorTransactionSource({
      documentId: snapshot.documentId,
      initialSnapshot: snapshot,
      provider: editor,
      maxQueuedTransactions
    }), /maxQueuedTransactions/);
    assert.equal(editor.listeners.size, 0);
  }

  for (const maxQueuedTransactions of [1, 65536, undefined]) {
    const editor = new FakeTransactionalEditor(snapshot);
    const source = new LiveAuthorMonitorEditorTransactionSource({
      documentId: snapshot.documentId,
      initialSnapshot: snapshot,
      provider: editor,
      ...(maxQueuedTransactions === undefined ? {} : { maxQueuedTransactions })
    });
    source.dispose();
    assert.equal(editor.listeners.size, 0);
  }
});


test("valida transacciones con metadatos UTF-16 sin volver a leer el manuscrito completo", () => {
  const snapshot = { documentId: "chapter-1", text: "hola", revision: 0, sequence: 0 };
  const editor = new FakeTransactionalEditor(snapshot);
  let snapshotReads = 0;
  let metadataReads = 0;
  let blockFullSnapshot = false;
  const provider = {
    getSnapshot(documentId) {
      snapshotReads += 1;
      if (blockFullSnapshot) throw new Error("full_snapshot_must_not_be_read_per_keystroke");
      return editor.getSnapshot(documentId);
    },
    getDocumentState(documentId) {
      metadataReads += 1;
      const current = editor.getSnapshot(documentId);
      if (!current) return undefined;
      return {
        documentId: current.documentId,
        revision: current.revision,
        sequence: current.sequence,
        documentLength: current.text.length
      };
    },
    subscribeTransactions(documentId, listener) {
      return editor.subscribeTransactions(documentId, listener);
    }
  };
  const changes = [];
  const source = new LiveAuthorMonitorEditorTransactionSource({
    documentId: snapshot.documentId,
    initialSnapshot: snapshot,
    provider
  });
  const stop = source.subscribeChanges(change => changes.push(change));
  assert.equal(snapshotReads, 1, "el snapshot completo solo se necesita al montar");

  blockFullSnapshot = true;
  editor.apply("edit", "tx-metadata-only", {
    start: 4,
    end: 4,
    replacement: "🙂"
  });

  assert.equal(snapshotReads, 1, "una edición no debe volver a materializar el manuscrito");
  assert.equal(metadataReads, 1);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].sequence, 1);
  assert.equal(source.getState().documentLength, 6,
    "la longitud se mide en unidades UTF-16, no en puntos de código");
  assert.equal(source.getState().needsResync, false);

  stop();
  source.dispose();
});

test("suspende captura si getDocumentState devuelve metadatos inválidos", () => {
  const snapshot = { documentId: "chapter-1", text: "abc", revision: 0, sequence: 0 };
  const editor = new FakeTransactionalEditor(snapshot);
  const provider = {
    getSnapshot: documentId => editor.getSnapshot(documentId),
    getDocumentState: documentId => ({
      documentId,
      revision: 1,
      sequence: 1,
      documentLength: Number.NaN
    }),
    subscribeTransactions: (documentId, listener) =>
      editor.subscribeTransactions(documentId, listener)
  };
  const errors = [];
  const source = new LiveAuthorMonitorEditorTransactionSource({
    documentId: snapshot.documentId,
    initialSnapshot: snapshot,
    provider,
    onError: error => errors.push(error)
  });
  source.subscribeChanges(() => {});
  editor.apply("edit", "tx-invalid-metadata", {
    start: 3, end: 3, replacement: "x"
  });

  assert.equal(source.getState().needsResync, true);
  assert.equal(errors.at(-1).code, "editor-state-unavailable");
  assert.equal(editor.listeners.size, 0);
  source.dispose();
});


test("exige resincronización si el mismo ID y secuencia reaparecen con otro delta", () => {
  const f = fixture();
  const accepted = f.editor.apply("edit", "tx-payload-reused", {
    start: 3, end: 3, replacement: "x"
  });
  f.editor.publish({
    transactionId: accepted.transactionId,
    kind: accepted.kind,
    change: {
      ...accepted.change,
      replacement: "y"
    }
  });

  assert.equal(f.changes.length, 1);
  assert.equal(f.source.getState().sequence, 1);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.errors.at(-1).code, "transaction-id-reused");
  assert.equal(f.editor.listeners.size, 0);
  f.stop();
  f.source.dispose();
});
