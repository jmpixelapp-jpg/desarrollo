import test from "node:test";
import assert from "node:assert/strict";
import { bindLiveAuthorMonitorEditorChanges } from "../dist/motor-literario.js";

function sourceFixture() {
  const listeners = new Set();
  return {
    listeners,
    source: {
      subscribeChanges(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    },
    emit(change) {
      for (const listener of [...listeners]) listener(change);
    }
  };
}
function change(sequence = 1) {
  return {
    documentId: "chapter-1",
    sequence,
    baseRevision: sequence - 1,
    start: 0,
    end: 0,
    replacement: "A"
  };
}

test("envía cada delta recibido una sola vez por HostEngineApi y reporta su ticket", () => {
  const f = sourceFixture();
  const submitted = [];
  const admissions = [];
  const admission = { status: "queued", ticketId: "ticket-1" };
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: { onEditorChange: value => { submitted.push(value); return admission; } },
    onAdmission: (value, result) => admissions.push({ value, result }),
    onError: error => { throw error; }
  });
  const delta = change();
  f.emit(delta);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0], delta);
  assert.deepEqual(admissions, [{ value: delta, result: admission }]);
  stop();
});

test("entrega rechazos y conserva el mismo delta para contrapresión del anfitrión", () => {
  const f = sourceFixture();
  const retained = [];
  const delta = change();
  const rejected = { status: "rejected", reason: "queue_full" };
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: { onEditorChange: () => rejected },
    onAdmission: (value, admission) => {
      if (admission.status === "rejected") retained.push({ value, reason: admission.reason });
    },
    onError: error => { throw error; }
  });
  f.emit(delta);
  assert.deepEqual(retained, [{ value: delta, reason: "queue_full" }]);
  stop();
});

test("el desmontaje cancela la fuente una sola vez e ignora notificaciones tardías", () => {
  const f = sourceFixture();
  const received = [];
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: { onEditorChange: delta => { received.push(delta); return { status: "queued", ticketId: "x" }; } },
    onAdmission: () => {},
    onError: error => { throw error; }
  });
  const staleListener = [...f.listeners][0];
  stop();
  stop();
  f.emit(change());
  staleListener(change(2));
  assert.equal(received.length, 0);
  assert.equal(f.listeners.size, 0);
});

test("retiene los deltas tras un error de envío y reintenta el stream en orden", () => {
  const f = sourceFixture();
  const errors = [];
  const submitted = [];
  let shouldThrow = true;
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: {
      onEditorChange(value) {
        submitted.push(value);
        if (shouldThrow) throw new Error("submit_failed");
        return { status: "queued", ticketId: "ticket-ok-" + value.sequence };
      }
    },
    onAdmission() { throw new Error("handler_failed"); },
    onError: (error, delta) => errors.push({ message: error.message, delta })
  });
  const first = change(1);
  const second = change(2);
  f.emit(first);
  shouldThrow = false;
  f.emit(second);
  assert.deepEqual(submitted, [first]);
  assert.deepEqual(stop.getPendingChanges(), [first, second]);

  stop.retryPending();
  assert.deepEqual(submitted, [first, first, second]);
  assert.deepEqual(stop.getPendingChanges(), []);
  assert.deepEqual(errors, [
    { message: "submit_failed", delta: first },
    { message: "handler_failed", delta: first },
    { message: "handler_failed", delta: second }
  ]);
  stop();
});

test("queue_full retiene el delta rechazado y bloquea deltas posteriores hasta el reintento", () => {
  const f = sourceFixture();
  const attempts = [];
  const admissions = [];
  let capacityAvailable = false;
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: {
      onEditorChange(value) {
        attempts.push(value.sequence);
        return capacityAvailable
          ? { status: "queued", ticketId: "ticket-" + value.sequence }
          : { status: "rejected", reason: "queue_full" };
      }
    },
    onAdmission: (value, result) => admissions.push([value.sequence, result.status]),
    onError: error => { throw error; }
  });

  f.emit(change(1));
  f.emit(change(2));
  f.emit(change(3));
  assert.deepEqual(attempts, [1]);
  assert.deepEqual(stop.getPendingChanges().map(value => value.sequence), [1, 2, 3]);
  assert.deepEqual(admissions, [[1, "rejected"]]);

  capacityAvailable = true;
  stop.retryPending();
  assert.deepEqual(attempts, [1, 1, 2, 3]);
  assert.deepEqual(stop.getPendingChanges(), []);
  assert.deepEqual(admissions, [
    [1, "rejected"],
    [1, "queued"],
    [2, "queued"],
    [3, "queued"]
  ]);
  stop();
});

test("valida contratos y callbacks antes de registrar el stream", () => {
  const f = sourceFixture();
  const sink = { onEditorChange: () => ({ status: "rejected", reason: "invalid_change" }) };
  assert.throws(() => bindLiveAuthorMonitorEditorChanges({
    source: {},
    sink,
    onAdmission: () => {},
    onError: () => {}
  }), /subscribeChanges/);
  assert.throws(() => bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink,
    onAdmission: () => {},
    onError: undefined
  }), /callbacks obligatorias/);
  assert.equal(f.listeners.size, 0);
});

test("reintenta automáticamente en FIFO cuando HostEngineApi publica una señal de commit", () => {
  const f = sourceFixture();
  const attempts = [];
  const admissions = [];
  const retryListeners = new Set();
  let capacityAvailable = false;

  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: {
      onEditorChange(value) {
        attempts.push(value.sequence);
        return capacityAvailable
          ? { status: "queued", ticketId: "ticket-" + value.sequence }
          : { status: "rejected", reason: "queue_full" };
      }
    },
    subscribeRetrySignal(listener) {
      retryListeners.add(listener);
      return () => retryListeners.delete(listener);
    },
    onAdmission: (value, admission) => admissions.push([value.sequence, admission.status]),
    onError: error => { throw error; }
  });

  f.emit(change(1));
  f.emit(change(2));
  assert.deepEqual(attempts, [1]);
  assert.equal(retryListeners.size, 1);
  assert.deepEqual(stop.getPendingChanges().map(value => value.sequence), [1, 2]);

  // Simula la publicación de métricas al confirmar un commit.
  capacityAvailable = true;
  for (const listener of [...retryListeners]) listener();

  assert.deepEqual(attempts, [1, 1, 2]);
  assert.deepEqual(stop.getPendingChanges(), []);
  assert.deepEqual(admissions, [
    [1, "rejected"],
    [1, "queued"],
    [2, "queued"]
  ]);

  stop();
  assert.equal(retryListeners.size, 0);
  assert.equal(f.listeners.size, 0);
});

test("las señales de reintento reentrantes no duplican el mismo delta", () => {
  const f = sourceFixture();
  const retryListeners = new Set();
  const attempts = [];
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: {
      onEditorChange(value) {
        attempts.push(value.sequence);
        for (const listener of [...retryListeners]) listener();
        return { status: "queued", ticketId: "ticket-" + value.sequence };
      }
    },
    subscribeRetrySignal(listener) {
      retryListeners.add(listener);
      return () => retryListeners.delete(listener);
    },
    onAdmission: () => {},
    onError: error => { throw error; }
  });

  f.emit(change(1));
  f.emit(change(2));
  assert.deepEqual(attempts, [1, 2]);
  stop();
});

test("libera la suscripción de reintento si falla el montaje de la fuente", () => {
  const retryListeners = new Set();
  assert.throws(() => bindLiveAuthorMonitorEditorChanges({
    source: {
      subscribeChanges() { throw new Error("source_unavailable"); }
    },
    sink: { onEditorChange: () => ({ status: "rejected", reason: "queue_full" }) },
    subscribeRetrySignal(listener) {
      retryListeners.add(listener);
      return () => retryListeners.delete(listener);
    },
    onAdmission: () => {},
    onError: () => {}
  }), /source_unavailable/);
  assert.equal(retryListeners.size, 0);
});


test("publica snapshots inmutables del backlog al entrar en contrapresión y al recuperarse", () => {
  const f = sourceFixture();
  const states = [];
  let capacityAvailable = false;
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: {
      onEditorChange(value) {
        return capacityAvailable
          ? { status: "queued", ticketId: "ticket-" + value.sequence }
          : { status: "rejected", reason: "queue_full" };
      }
    },
    onAdmission: () => {},
    onBackpressure: snapshot => states.push(snapshot),
    onError: error => { throw error; }
  });

  f.emit(change(1));
  f.emit(change(2));
  assert.deepEqual(states.map(state => [state.status, state.pendingCount, state.reason]), [
    ["backpressured", 1, "queue_full"],
    ["backpressured", 2, "queue_full"]
  ]);
  assert.equal(states[0].firstPendingSequence, 1);
  assert.equal(states[1].lastPendingSequence, 2);
  assert.equal(Object.isFrozen(states[0]), true);

  capacityAvailable = true;
  stop.retryPending();
  assert.deepEqual(states.map(state => [state.status, state.pendingCount]), [
    ["backpressured", 1],
    ["backpressured", 2],
    ["backpressured", 1],
    ["clear", 0]
  ]);
  assert.equal(states.at(-1).reason, undefined);
  stop();
});

test("limpia el indicador de contrapresión solo al descartar el backlog tras resincronizar", () => {
  const f = sourceFixture();
  const states = [];
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: { onEditorChange: () => ({ status: "rejected", reason: "resync_required" }) },
    onAdmission: () => {},
    onBackpressure: snapshot => states.push(snapshot),
    onError: error => { throw error; }
  });

  f.emit(change(4));
  assert.equal(states.at(-1).status, "backpressured");
  assert.equal(stop.getPendingChanges().length, 1);
  stop.discardPendingAfterResynchronization();
  assert.deepEqual(states.at(-1), { status: "clear", pendingCount: 0 });
  assert.deepEqual(stop.getPendingChanges(), []);
  stop();
});
