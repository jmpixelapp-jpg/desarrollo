import test from "node:test";
import assert from "node:assert/strict";
import {
  bindLiveAuthorMonitorEditorChanges,
  LiveAuthorMonitorBackpressureOverflowError,
  LiveAuthorMonitorAdmissionResynchronizationError
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

test("un rechazo resync_required pausa la fuente sin reintentar y se limpia tras el snapshot común", () => {
  const f = sourceFixture();
  const states = [];
  const errors = [];
  let admissions = 0;
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: {
      onEditorChange: () => {
        admissions += 1;
        return { status: "rejected", reason: "resync_required" };
      }
    },
    onAdmission: () => {},
    onBackpressure: snapshot => states.push(snapshot),
    onError: error => errors.push(error)
  });

  f.emit(change(4));
  assert.equal(states.at(-1).status, "resync-required");
  assert.equal(states.at(-1).reason, "resync_required");
  assert.equal(states.at(-1).resyncSequence, 4);
  assert.equal(stop.getPendingChanges().length, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.resynchronizationRequests.length, 1);
  assert.equal(errors.at(-1) instanceof LiveAuthorMonitorAdmissionResynchronizationError, true);
  f.emit(change(5));
  assert.equal(admissions, 1, "la fuente pausada no genera nuevos intentos");

  stop.discardPendingAfterResynchronization();
  assert.deepEqual(states.at(-1), { status: "clear", pendingCount: 0 });
  assert.equal(f.listeners.size, 1, "la fuente solo vuelve a activarse después del snapshot común");
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

test("retira la suscripción si el buffer se desborda por emisiones síncronas durante el montaje", () => {
  const listeners = new Set();
  const resynchronizationRequests = [];
  let subscriptionCount = 0;
  const source = {
    subscribeChanges(listener) {
      listeners.add(listener);
      subscriptionCount += 1;
      if (subscriptionCount === 1) {
        // El proveedor emite antes de devolver la función unsubscribe.
        listener(change(1));
        listener(change(2));
      }
      return () => listeners.delete(listener);
    },
    requireResynchronization(reason) {
      resynchronizationRequests.push(reason);
    }
  };
  const attempts = [];
  const states = [];
  const stop = bindLiveAuthorMonitorEditorChanges({
    source,
    sink: {
      onEditorChange(value) {
        attempts.push(value.sequence);
        return { status: "rejected", reason: "queue_full" };
      }
    },
    maxPendingChanges: 1,
    onAdmission: () => {},
    onBackpressure: state => states.push(state),
    onError: () => {}
  });

  assert.deepEqual(attempts, [1]);
  assert.equal(stop.getPendingChanges().length, 1);
  assert.equal(states.at(-1).status, "resync-required");
  assert.equal(states.at(-1).overflowSequence, 2);
  assert.equal(resynchronizationRequests.length, 1);
  assert.equal(listeners.size, 0,
    "attachSource debe cerrar el listener que todavía no había recibido su disposer");

  // Tras aplicar el snapshot común, la segunda suscripción no emite eventos históricos.
  stop.discardPendingAfterResynchronization();
  assert.equal(listeners.size, 1);
  stop();
  assert.equal(listeners.size, 0);
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


test("no crea una suscripción duplicada si falla la desuscripción durante el overflow", () => {
  const listeners = new Set();
  const attempts = [];
  const errors = [];
  let unsubscribeAttempts = 0;
  let subscriptionCount = 0;
  const source = {
    subscribeChanges(listener) {
      listeners.add(listener);
      subscriptionCount += 1;
      return () => {
        unsubscribeAttempts += 1;
        if (unsubscribeAttempts === 1) throw new Error("unsubscribe_temporarily_failed");
        listeners.delete(listener);
      };
    },
    requireResynchronization() {}
  };
  const stop = bindLiveAuthorMonitorEditorChanges({
    source,
    sink: {
      onEditorChange(value) {
        attempts.push(value.sequence);
        return value.sequence === 1
          ? { status: "rejected", reason: "queue_full" }
          : { status: "queued", ticketId: "ticket-" + value.sequence };
      }
    },
    maxPendingChanges: 1,
    onAdmission: () => {},
    onError: error => errors.push(error)
  });

  for (const listener of [...listeners]) listener(change(1));
  for (const listener of [...listeners]) listener(change(2));
  assert.equal(listeners.size, 1, "la primera liberación falla y la fuente queda en pausa lógica");
  assert.equal(unsubscribeAttempts, 1);
  assert.ok(errors.some(error => error.message === "unsubscribe_temporarily_failed"));

  // Mientras se requiere snapshot común, cualquier callback antiguo queda ignorado.
  for (const listener of [...listeners]) listener(change(3));
  assert.deepEqual(attempts, [1]);

  stop.discardPendingAfterResynchronization();
  assert.equal(unsubscribeAttempts, 2, "la resincronización vuelve a intentar cerrar el listener anterior");
  assert.equal(subscriptionCount, 2);
  assert.equal(listeners.size, 1, "solo queda instalada la suscripción nueva");

  for (const listener of [...listeners]) listener(change(4));
  assert.deepEqual(attempts, [1, 4], "el siguiente delta se entrega exactamente una vez");
  stop();
  assert.equal(listeners.size, 0);
});

test("stop puede reintentar una desuscripción fallida sin procesar notificaciones tardías", () => {
  const listeners = new Set();
  let unsubscribeAttempts = 0;
  const received = [];
  const source = {
    subscribeChanges(listener) {
      listeners.add(listener);
      return () => {
        unsubscribeAttempts += 1;
        if (unsubscribeAttempts === 1) throw new Error("source_close_failed_once");
        listeners.delete(listener);
      };
    }
  };
  const stop = bindLiveAuthorMonitorEditorChanges({
    source,
    sink: {
      onEditorChange(value) {
        received.push(value.sequence);
        return { status: "queued", ticketId: "ticket-" + value.sequence };
      }
    },
    onAdmission: () => {},
    onError: () => {}
  });
  const staleListener = [...listeners][0];

  assert.throws(stop, /source_close_failed_once/);
  assert.equal(listeners.size, 1);
  staleListener(change(1));
  assert.deepEqual(received, [], "disposed bloquea los callbacks aunque el host no haya podido desuscribirse");

  stop();
  assert.equal(unsubscribeAttempts, 2);
  assert.equal(listeners.size, 0);
  stop();
  assert.equal(unsubscribeAttempts, 2, "una limpieza completada ya no se repite");
});


test("getPendingChanges devuelve copias congeladas también a nivel de cada delta", () => {
  const f = sourceFixture();
  const original = change(1);
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: { onEditorChange: () => ({ status: "rejected", reason: "queue_full" }) },
    onAdmission: () => {},
    onError: () => {}
  });
  f.emit(original);

  const snapshot = stop.getPendingChanges();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(snapshot.length, 1);
  assert.equal(Object.isFrozen(snapshot[0]), true);
  assert.notEqual(snapshot[0], original, "la vista de diagnóstico no comparte referencias mutables");
  assert.deepEqual(snapshot[0], original);
  assert.throws(() => { snapshot[0].replacement = "contenido alterado"; }, TypeError);
  assert.equal(stop.getPendingChanges()[0].replacement, "A",
    "una modificación intentada sobre la copia no puede alterar el delta pendiente");
  assert.equal(original.replacement, "A", "la inspección tampoco modifica el objeto del editor");
  stop.discardPendingAfterResynchronization();
  stop();
});


test("el backlog conserva deltas congelados aunque el callback o la fuente muten sus objetos originales", () => {
  const f = sourceFixture();
  const first = change(1);
  const second = change(2);
  const attempts = [];
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: {
      onEditorChange(value) {
        attempts.push([value.sequence, value.replacement, Object.isFrozen(value)]);
        return value.sequence === 1 && attempts.length === 1
          ? { status: "rejected", reason: "queue_full" }
          : { status: "queued", ticketId: "ticket-" + value.sequence };
      }
    },
    onAdmission(value, admission) {
      if (admission.status === "rejected") {
        // La observabilidad recibe el objeto de origen, pero no debe poder
        // alterar la copia ya retenida para el siguiente intento.
        value.replacement = "alterado-por-observabilidad";
      }
    },
    onError: () => {}
  });

  f.emit(first);
  assert.equal(first.replacement, "alterado-por-observabilidad");
  assert.deepEqual(stop.getPendingChanges().map(value => value.replacement), ["A"]);

  f.emit(second);
  second.replacement = "alterado-por-la-fuente";
  assert.deepEqual(stop.getPendingChanges().map(value => value.replacement), ["A", "A"]);
  assert.deepEqual(stop.getPendingChanges().map(Object.isFrozen), [true, true]);

  stop.retryPending();
  assert.deepEqual(attempts, [
    [1, "A", false],
    [1, "A", true],
    [2, "A", true]
  ], "los reintentos deben recibir las copias inmutables, no las referencias externas");
  assert.deepEqual(stop.getPendingChanges(), []);
  stop();
});


test("los rechazos permanentes pausan la fuente y exigen snapshot en vez de bloquear el FIFO", () => {
  const permanentReasons = ["change_too_large", "unknown_document", "invalid_change", "resync_required"];
  for (const reason of permanentReasons) {
    const f = sourceFixture();
    const states = [];
    const errors = [];
    const attempts = [];
    const admissions = [];
    let first = true;
    const stop = bindLiveAuthorMonitorEditorChanges({
      source: f.source,
      sink: {
        onEditorChange(value) {
          attempts.push(value.sequence);
          if (first) {
            first = false;
            return { status: "rejected", reason };
          }
          return { status: "queued", ticketId: "ticket-" + value.sequence };
        }
      },
      onAdmission: (_value, admission) => admissions.push(admission.status),
      onBackpressure: state => states.push(state),
      onError: error => errors.push(error)
    });

    f.emit(change(10));
    assert.deepEqual(attempts, [10], reason + ": no reintenta el rechazo permanente");
    assert.deepEqual(admissions, ["rejected"]);
    assert.equal(f.listeners.size, 0, reason + ": pausa la fuente");
    assert.equal(states.at(-1).status, "resync-required");
    assert.equal(states.at(-1).reason, reason);
    assert.equal(states.at(-1).resyncSequence, 10);
    assert.equal(states.at(-1).pendingCount, 0);
    assert.equal(errors.at(-1) instanceof LiveAuthorMonitorAdmissionResynchronizationError, true);
    assert.equal(errors.at(-1).reason, reason);

    f.emit(change(11));
    assert.deepEqual(attempts, [10], reason + ": ignora eventos posteriores mientras requiere snapshot");
    stop.discardPendingAfterResynchronization();
    assert.equal(f.listeners.size, 1);
    f.emit(change(11));
    assert.deepEqual(attempts, [10, 11], reason + ": admite cambios después de reconciliar");
    stop();
    assert.equal(f.listeners.size, 0);
  }
});

test("un rechazo permanente durante retryPending pausa y conserva todo el backlog FIFO", () => {
  const f = sourceFixture();
  const attempts = [];
  const states = [];
  const errors = [];
  let capacity = false;
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: {
      onEditorChange(value) {
        attempts.push(value.sequence);
        if (!capacity) return { status: "rejected", reason: "queue_full" };
        return { status: "rejected", reason: "invalid_change" };
      }
    },
    onAdmission: () => {},
    onBackpressure: state => states.push(state),
    onError: error => errors.push(error)
  });

  f.emit(change(1));
  f.emit(change(2));
  assert.deepEqual(stop.getPendingChanges().map(value => value.sequence), [1, 2]);
  assert.equal(f.listeners.size, 1);

  capacity = true;
  stop.retryPending();
  assert.deepEqual(attempts, [1, 1]);
  assert.deepEqual(stop.getPendingChanges().map(value => value.sequence), [1, 2],
    "un rechazo permanente no elimina ni reordena el backlog");
  assert.equal(f.listeners.size, 0);
  assert.equal(states.at(-1).status, "resync-required");
  assert.equal(states.at(-1).reason, "invalid_change");
  assert.equal(states.at(-1).resyncSequence, 1);
  assert.equal(errors.at(-1) instanceof LiveAuthorMonitorAdmissionResynchronizationError, true);

  stop.discardPendingAfterResynchronization();
  assert.deepEqual(stop.getPendingChanges(), []);
  assert.equal(f.listeners.size, 1);
  stop();
});


test("un onAdmission reentrante no puede adelantar cambios a un rechazo permanente inicial", () => {
  const f = sourceFixture();
  const attempts = [];
  let emitFromAdmission = false;
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: {
      onEditorChange(value) {
        attempts.push(value.sequence);
        return value.sequence === 1
          ? { status: "rejected", reason: "invalid_change" }
          : { status: "queued", ticketId: "ticket-" + value.sequence };
      }
    },
    onAdmission(_value, admission) {
      if (emitFromAdmission && admission.status === "rejected") f.emit(change(2));
    },
    onError: () => {}
  });

  emitFromAdmission = true;
  f.emit(change(1));
  assert.deepEqual(attempts, [1], "la fuente se desacopla antes de llamar al callback reentrante");
  assert.equal(stop.getPendingChanges().length, 0);
  assert.equal(f.listeners.size, 0);
  stop.discardPendingAfterResynchronization();
  f.emit(change(3));
  assert.deepEqual(attempts, [1, 3]);
  stop();
});

test("un onAdmission reentrante no puede adelantar cambios al rechazo permanente durante retryPending", () => {
  const f = sourceFixture();
  const attempts = [];
  const admissions = [];
  let capacity = false;
  let emitFromAdmission = false;
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: {
      onEditorChange(value) {
        attempts.push(value.sequence);
        if (!capacity) return { status: "rejected", reason: "queue_full" };
        return { status: "rejected", reason: "unknown_document" };
      }
    },
    onAdmission(_value, admission) {
      admissions.push(admission);
      if (emitFromAdmission && admission.status === "rejected" &&
          admission.reason === "unknown_document") f.emit(change(3));
    },
    onError: () => {}
  });

  f.emit(change(1));
  f.emit(change(2));
  capacity = true;
  emitFromAdmission = true;
  stop.retryPending();
  assert.deepEqual(attempts, [1, 1]);
  assert.deepEqual(stop.getPendingChanges().map(value => value.sequence), [1, 2]);
  assert.equal(f.listeners.size, 0, "la fuente ya está pausada cuando se ejecuta onAdmission");
  assert.equal(admissions.at(-1).reason, "unknown_document");

  stop.discardPendingAfterResynchronization();
  f.emit(change(4));
  assert.deepEqual(attempts, [1, 1, 4]);
  stop();
});
