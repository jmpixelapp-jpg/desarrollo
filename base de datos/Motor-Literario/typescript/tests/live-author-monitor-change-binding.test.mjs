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

test("envía errores del sink o del manejador al callback de error sin romper el stream", () => {
  const f = sourceFixture();
  const errors = [];
  let shouldThrow = true;
  const stop = bindLiveAuthorMonitorEditorChanges({
    source: f.source,
    sink: {
      onEditorChange() {
        if (shouldThrow) throw new Error("submit_failed");
        return { status: "queued", ticketId: "ticket-ok" };
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
  assert.deepEqual(errors, [
    { message: "submit_failed", delta: first },
    { message: "handler_failed", delta: second }
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
