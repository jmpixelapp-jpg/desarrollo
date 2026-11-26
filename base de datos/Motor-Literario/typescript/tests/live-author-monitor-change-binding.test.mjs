import test from "node:test";
import assert from "node:assert/strict";
import {
  bindLiveAuthorMonitorEditorChanges,
  LiveAuthorMonitorBackpressureOverflowError
} from "../dist/motor-literario.js";

function sourceFixture() {
  const listeners = new Set();
  const resynchronizationRequests = [];
  return {
    listeners,
    resynchronizationRequests,
    source: {
      subscribeChanges(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      requireResynchronization(reason) {
        resynchronizationRequests.push(reason);
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
  let capacityAvailable = false;
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: {
      onEditorChange: () => capacityAvailable
        ? { status: "queued", ticketId: "ticket-1" }
        : { status: "rejected", reason: "queue_full" }
    },
    onAdmission: (value, admission) => {
      if (admission.status === "rejected") retained.push({ value, reason: admission.reason });
    },
    onError: error => { throw error; }
  });
  f.emit(delta);
  assert.deepEqual(retained, [{ value: delta, reason: "queue_full" }]);
  assert.throws(() => stop(), /cambios pendientes/);
  assert.deepEqual(stop.getPendingChanges(), [delta]);
  assert.equal(f.listeners.size, 1, "el stream sigue activo mientras el backlog no se resuelva");

  capacityAvailable = true;
  stop.retryPending();
  assert.deepEqual(stop.getPendingChanges(), []);
  stop();
  assert.equal(f.listeners.size, 0);
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
  assert.equal(states.length, 4, "el desmontaje no debe repetir el estado clear");
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

test("expone sink_error, aísla fallos de la vista y conserva el FIFO durante la recuperación", () => {
  const f = sourceFixture();
  const attempts = [];
  const states = [];
  const errors = [];
  let shouldThrow = true;
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: {
      onEditorChange(value) {
        attempts.push(value.sequence);
        if (shouldThrow) throw new Error("temporary_sink_failure");
        return { status: "queued", ticketId: "ticket-" + value.sequence };
      }
    },
    onAdmission: () => {},
    onBackpressure: snapshot => {
      states.push(snapshot);
      throw new Error("visual_indicator_failure");
    },
    onError: error => errors.push(error.message)
  });

  f.emit(change(1));
  f.emit(change(2));
  assert.deepEqual(states.map(state => [state.status, state.pendingCount, state.reason]), [
    ["backpressured", 1, "sink_error"],
    ["backpressured", 2, "sink_error"]
  ]);
  assert.deepEqual(errors, ["temporary_sink_failure"]);

  shouldThrow = false;
  stop.retryPending();
  assert.deepEqual(attempts, [1, 1, 2]);
  assert.deepEqual(stop.getPendingChanges(), []);
  assert.deepEqual(states.map(state => [state.status, state.pendingCount]), [
    ["backpressured", 1],
    ["backpressured", 2],
    ["backpressured", 1],
    ["clear", 0]
  ]);
  assert.deepEqual(errors, ["temporary_sink_failure"]);
  stop();
  assert.equal(states.length, 4);
});


test("acota el backlog y pausa la fuente al desbordarse hasta resincronizar el snapshot común", () => {
  const f = sourceFixture();
  const attempts = [];
  const admissions = [];
  const states = [];
  const errors = [];
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: {
      onEditorChange(value) {
        attempts.push(value.sequence);
        return value.sequence === 4
          ? { status: "queued", ticketId: "ticket-4" }
          : { status: "rejected", reason: "queue_full" };
      }
    },
    maxPendingChanges: 2,
    onAdmission: (value, admission) => admissions.push([value.sequence, admission.status]),
    onBackpressure: state => states.push(state),
    onError: (error, value) => errors.push({ error, sequence: value.sequence })
  });

  f.emit(change(1));
  f.emit(change(2));
  f.emit(change(3));

  assert.deepEqual(attempts, [1], "no se intenta reenviar mientras hay backlog");
  assert.deepEqual(stop.getPendingChanges().map(value => value.sequence), [1, 2]);
  assert.equal(stop.getPendingChanges().length, 2, "el buffer nunca supera su límite");
  assert.deepEqual(admissions, [[1, "rejected"]]);
  assert.equal(f.listeners.size, 0, "la fuente queda desuscrita al requerir snapshot común");
  assert.equal(f.resynchronizationRequests.length, 1);
  assert.equal(states.at(-1).status, "resync-required");
  assert.equal(states.at(-1).pendingCount, 2);
  assert.equal(states.at(-1).overflowSequence, 3);
  assert.equal(states.at(-1).reason, "resync_required");
  assert.equal(errors.at(-1).sequence, 3);
  assert.equal(errors.at(-1).error instanceof LiveAuthorMonitorBackpressureOverflowError, true);
  assert.equal(errors.at(-1).error.code, "pending-buffer-overflow");

  stop.retryPending();
  assert.deepEqual(attempts, [1], "retryPending no puede saltarse la resincronización");

  // El anfitrión ya reconcilió editor y motor con un snapshot durable común.
  stop.discardPendingAfterResynchronization();
  assert.deepEqual(stop.getPendingChanges(), []);
  assert.equal(f.listeners.size, 1, "la fuente se vuelve a suscribir después del snapshot común");
  assert.equal(states.at(-1).status, "clear");

  f.emit(change(4));
  assert.equal(attempts.at(-1), 4);
  assert.equal(f.listeners.size, 1);
  stop();
  assert.equal(f.listeners.size, 0);
});

test("valida maxPendingChanges antes de instalar listeners", () => {
  const f = sourceFixture();
  for (const maxPendingChanges of [0, -1, 1.5, 65537, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => bindLiveAuthorMonitorEditorChanges({
      source: f.source,
      sink: { onEditorChange: () => ({ status: "queued", ticketId: "ticket" }) },
      maxPendingChanges,
      onAdmission: () => {},
      onError: () => {}
    }), /maxPendingChanges/);
    assert.equal(f.listeners.size, 0);
  }
});
