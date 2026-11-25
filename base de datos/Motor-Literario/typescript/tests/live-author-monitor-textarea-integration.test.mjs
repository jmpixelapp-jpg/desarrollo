import test from "node:test";
import assert from "node:assert/strict";
import {
  LiveAuthorMonitor,
  mountLiveAuthorMonitorTextArea
} from "../dist/motor-literario.js";

class FakeTextArea {
  value;
  selectionStart = 0;
  selectionEnd = 0;
  listeners = new Map();

  constructor(value) { this.value = value; }

  addEventListener(type, listener) {
    const entries = this.listeners.get(type) ?? new Set();
    entries.add(listener);
    this.listeners.set(type, entries);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  beforeInput(inputType = "insertText") {
    const event = { defaultPrevented: false, inputType };
    for (const listener of [...(this.listeners.get("beforeinput") ?? [])]) listener(event);
  }

  input() {
    for (const listener of [...(this.listeners.get("input") ?? [])]) listener({ inputType: "" });
  }

  edit(start, end, nextValue, inputType = "insertText") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.beforeInput(inputType);
    this.value = nextValue;
    this.input();
  }
}

function fixture(text = "hello") {
  const element = new FakeTextArea(text);
  let snapshot = { documentId: "chapter-1", text, revision: 0, sequence: 0 };
  let sync = { sequence: 0, pendingSequence: 0, needsResync: false };
  let rejectNext = false;
  const monitor = new LiveAuthorMonitor({ now: () => 100 });
  monitor.openDocument(snapshot, "book-1");
  const changes = [];
  const admissions = [];
  const errors = [];
  const retryListeners = new Set();

  const hostApi = {
    getSnapshot: documentId => documentId === snapshot.documentId ? { ...snapshot } : undefined,
    getDocumentSyncState: documentId => documentId === snapshot.documentId ? { ...sync } : undefined,
    getLiveAuthorMonitorSnapshot: documentId => monitor.getSnapshot(documentId),
    ensureLiveAuthorMonitorDocument: documentId => {
      const existing = monitor.getSnapshot(documentId);
      return existing ?? monitor.openDocument(snapshot, "book-1");
    },
    subscribeLiveAuthorMonitor(listener) {
      const unsubscribe = monitor.subscribe(listener);
      retryListeners.add(listener);
      return () => {
        unsubscribe();
        retryListeners.delete(listener);
      };
    },
    resynchronizeLiveAuthorMonitor(next) {
      return monitor.resynchronizeDocument(next);
    },
    onEditorChange(change) {
      changes.push(change);
      if (rejectNext) {
        rejectNext = false;
        const rejected = { status: "rejected", reason: "queue_full" };
        monitor.recordAdmission(change, rejected);
        return rejected;
      }

      const admission = { status: "queued", ticketId: "ticket-" + change.sequence };
      monitor.recordAdmission(change, admission);
      snapshot = {
        documentId: change.documentId,
        text: snapshot.text.slice(0, change.start) + change.replacement + snapshot.text.slice(change.end),
        revision: change.baseRevision + 1,
        sequence: change.sequence
      };
      sync = {
        sequence: snapshot.sequence,
        pendingSequence: snapshot.sequence,
        needsResync: false
      };
      monitor.recordCommit({
        ticketId: admission.ticketId,
        status: "applied",
        revision: snapshot.revision
      });
      return admission;
    }
  };

  const integration = mountLiveAuthorMonitorTextArea({
    element,
    documentId: "chapter-1",
    hostApi,
    onAdmission: (_change, admission) => admissions.push(admission),
    onError: (error, change) => errors.push({ error, change })
  });

  return {
    element,
    monitor,
    hostApi,
    integration,
    changes,
    admissions,
    errors,
    retryListeners,
    setRejectNext(value) { rejectNext = value; },
    setSnapshot(next, nextSync = {
      sequence: next.sequence,
      pendingSequence: next.sequence,
      needsResync: false
    }) {
      snapshot = { ...next };
      sync = { ...nextSync };
    },
    publishRetrySignal() {
      const current = monitor.getSnapshot("chapter-1");
      for (const listener of [...retryListeners]) listener(current);
    }
  };
}

test("monta el textarea directamente contra HostEngineApi y entrega deltas únicos", () => {
  const f = fixture();
  f.element.edit(5, 5, "hello world");

  assert.equal(f.changes.length, 1);
  assert.deepEqual(f.changes[0], {
    documentId: "chapter-1",
    sequence: 1,
    baseRevision: 0,
    start: 5,
    end: 5,
    replacement: " world"
  });
  assert.equal(f.admissions[0].status, "queued");
  assert.equal(f.integration.getState().revision, 1);
  assert.equal(f.integration.getState().documentLength, 11);
  assert.equal(f.monitor.getSnapshot("chapter-1").durableSequence, 1);

  f.integration.dispose();
  assert.equal(f.retryListeners.size, 0);
  assert.equal(f.element.listeners.get("beforeinput").size, 0);
  assert.equal(f.element.listeners.get("input").size, 0);
});

test("reintenta automáticamente queue_full cuando el motor emite otra señal", () => {
  const f = fixture();
  f.setRejectNext(true);
  f.element.edit(5, 5, "hello!");
  f.element.edit(6, 6, "hello!!");

  assert.equal(f.changes.length, 1);
  assert.deepEqual(f.integration.getPendingChanges().map(change => change.sequence), [1, 2]);

  // La señal equivale a una publicación del monitor al terminar un commit.
  f.publishRetrySignal();
  assert.deepEqual(f.changes.map(change => change.sequence), [1, 1, 2]);
  assert.deepEqual(f.integration.getPendingChanges(), []);
  assert.equal(f.monitor.getSnapshot("chapter-1").durableSequence, 2);
  f.integration.dispose();
});

test("resincroniza motor, métricas y textarea desde un snapshot durable", () => {
  const f = fixture();
  f.element.value = "hello?";
  f.element.input(); // Sin beforeinput: suspende el stream por seguridad.

  assert.equal(f.integration.getState().needsResync, true);
  assert.equal(f.errors[0].error.code, "missing-beforeinput");

  const authoritative = {
    documentId: "chapter-1",
    text: "hello?",
    revision: 1,
    sequence: 1
  };
  f.setSnapshot(authoritative);
  const resumed = f.integration.resynchronize();

  assert.equal(resumed.needsResync, false);
  assert.equal(resumed.revision, 1);
  assert.equal(resumed.sequence, 1);
  assert.equal(f.monitor.getSnapshot("chapter-1").currentDocumentLength, 6);

  f.element.edit(6, 6, "hello?!");
  assert.equal(f.changes.at(-1).sequence, 2);
  assert.equal(f.changes.at(-1).baseRevision, 1);
  f.integration.dispose();
});

test("no descarta backlog ni reinicia el adaptador mientras el motor tiene cambios pendientes", () => {
  const f = fixture();
  f.element.value = "hello?";
  f.element.input();
  f.setSnapshot(
    { documentId: "chapter-1", text: "hello?", revision: 1, sequence: 1 },
    { sequence: 1, pendingSequence: 0, needsResync: false }
  );

  assert.throws(() => f.integration.resynchronize(), /durable y sin cambios pendientes/);
  assert.equal(f.integration.getState().needsResync, true);
  f.integration.dispose();
});

test("rechaza montar sobre un documento inexistente", () => {
  const element = new FakeTextArea("hello");
  const invalidHost = {
    getSnapshot: () => undefined,
    getDocumentSyncState: () => undefined,
    onEditorChange: () => ({ status: "rejected", reason: "unknown_document" }),
    getLiveAuthorMonitorSnapshot: () => undefined,
    ensureLiveAuthorMonitorDocument: () => { throw new Error("must not open"); },
    subscribeLiveAuthorMonitor: () => () => {},
    resynchronizeLiveAuthorMonitor: () => { throw new Error("must not resync"); }
  };

  assert.throws(() => mountLiveAuthorMonitorTextArea({
    element,
    documentId: "missing",
    hostApi: invalidHost
  }), /documento no está abierto/);
  assert.equal(element.listeners.size, 0);
});
