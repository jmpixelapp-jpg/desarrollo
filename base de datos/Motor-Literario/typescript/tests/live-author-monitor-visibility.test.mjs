import test from "node:test";
import assert from "node:assert/strict";

const monitorModule = await import("../dist-monitor/live-author-monitor.js")
  .catch(() => import("../dist/motor-literario.js"));
const { scheduleLiveAuthorMonitorWhileVisible } = monitorModule;

class FakeEventTarget {
  listeners = new Map();
  addFailure;
  removeFailure;

  addEventListener(type, listener) {
    if (this.addFailure === type) throw new Error("add listener failed: " + type);
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type, listener) {
    const current = this.listeners.get(type);
    current?.delete(listener);
    if (current?.size === 0) this.listeners.delete(type);
    if (this.removeFailure === type) throw new Error("remove listener failed: " + type);
  }

  dispatch(type) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ type });
    }
  }

  listenerCount() {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }
}

class FakeDocument extends FakeEventTarget {
  hidden = false;
  defaultView = new FakeEventTarget();
}

function createScheduler(onSchedule) {
  const entries = [];
  const schedule = (callback, intervalMs) => {
    const entry = { callback, intervalMs, cancellations: 0 };
    entries.push(entry);
    onSchedule?.(entry, entries.length);
    return () => { entry.cancellations++; };
  };
  return { entries, schedule };
}

test("suspende y reanuda el polling con visibilidad y Page Lifecycle sin revivir ticks antiguos", () => {
  const document = new FakeDocument();
  const { entries, schedule } = createScheduler();
  let refreshes = 0;
  const dispose = scheduleLiveAuthorMonitorWhileVisible(
    document, () => { refreshes++; }, 250, schedule
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].intervalMs, 250);
  assert.equal(refreshes, 0);

  document.hidden = true;
  document.dispatch("visibilitychange");
  assert.equal(entries[0].cancellations, 1);
  entries[0].callback();
  document.defaultView.dispatch("pageshow");
  document.dispatch("resume");
  assert.equal(refreshes, 0);
  assert.equal(entries.length, 1);

  document.hidden = false;
  document.dispatch("visibilitychange");
  assert.equal(refreshes, 1);
  assert.equal(entries.length, 2);
  entries[0].callback();
  assert.equal(refreshes, 1, "un tick de una generación cancelada no debe ejecutarse");

  entries[1].callback();
  assert.equal(refreshes, 2);
  document.dispatch("freeze");
  assert.equal(entries[1].cancellations, 1);
  entries[1].callback();
  assert.equal(refreshes, 2);

  document.dispatch("resume");
  assert.equal(refreshes, 3);
  assert.equal(entries.length, 3);
  dispose();
  assert.equal(entries[2].cancellations, 1);
  entries[2].callback();
  document.defaultView.dispatch("pageshow");
  document.dispatch("resume");
  document.dispatch("visibilitychange");
  dispose();

  assert.equal(refreshes, 3);
  assert.equal(document.listenerCount(), 0);
  assert.equal(document.defaultView.listenerCount(), 0);
});

test("no inicia intervalos en una página oculta y pageshow no vence a visibility oculta", () => {
  const document = new FakeDocument();
  document.hidden = true;
  const { entries, schedule } = createScheduler();
  let refreshes = 0;
  const dispose = scheduleLiveAuthorMonitorWhileVisible(
    document, () => { refreshes++; }, 500, schedule
  );

  assert.equal(entries.length, 0);
  document.defaultView.dispatch("pageshow");
  document.dispatch("resume");
  assert.equal(entries.length, 0);
  assert.equal(refreshes, 0);

  document.hidden = false;
  document.dispatch("visibilitychange");
  assert.equal(entries.length, 1);
  assert.equal(refreshes, 1);

  document.hidden = true;
  document.dispatch("visibilitychange");
  document.defaultView.dispatch("pageshow");
  document.dispatch("resume");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].cancellations, 1);
  assert.equal(refreshes, 1);
  dispose();
});

test("cancela el intervalo si el scheduler provoca pagehide sincrónicamente al instalarlo", () => {
  const document = new FakeDocument();
  const { entries, schedule } = createScheduler((_entry, count) => {
    if (count === 1) document.defaultView.dispatch("pagehide");
  });
  let refreshes = 0;
  const dispose = scheduleLiveAuthorMonitorWhileVisible(
    document, () => { refreshes++; }, 300, schedule
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].cancellations, 1,
    "la cancelación se recibe después de que la transición haya invalidado la generación");
  entries[0].callback();
  assert.equal(refreshes, 0);

  document.defaultView.dispatch("pageshow");
  assert.equal(refreshes, 1);
  assert.equal(entries.length, 2);
  entries[1].callback();
  assert.equal(refreshes, 2);
  dispose();
});

test("limpia todos los listeners si falla el registro parcial de Page Lifecycle", () => {
  const document = new FakeDocument();
  document.addFailure = "freeze";
  const { entries, schedule } = createScheduler();
  assert.throws(() => scheduleLiveAuthorMonitorWhileVisible(
    document, () => {}, 1_000, schedule
  ), /add listener failed: freeze/);

  assert.equal(entries.length, 0, "el scheduler no debe iniciarse tras fallar el registro");
  assert.equal(document.listenerCount(), 0);
  assert.equal(document.defaultView.listenerCount(), 0);
});

test("invalida callbacks encolados cuando el scheduler no devuelve cancelación", () => {
  const document = new FakeDocument();
  let queuedCallback;
  const invalidScheduler = callback => {
    queuedCallback = callback;
    return undefined;
  };

  assert.throws(() => scheduleLiveAuthorMonitorWhileVisible(
    document, () => assert.fail("no debe ejecutarse"), 1_000, invalidScheduler
  ), /función de cancelación/);

  assert.equal(document.listenerCount(), 0);
  assert.equal(document.defaultView.listenerCount(), 0);
  queuedCallback();
});

test("completa la limpieza y cancela el intervalo aunque falle un removeEventListener", () => {
  const document = new FakeDocument();
  const { entries, schedule } = createScheduler();
  let refreshes = 0;
  const dispose = scheduleLiveAuthorMonitorWhileVisible(
    document, () => { refreshes++; }, 400, schedule
  );
  document.removeFailure = "visibilitychange";

  assert.throws(dispose, /remove listener failed: visibilitychange/);
  assert.equal(document.listenerCount(), 0);
  assert.equal(document.defaultView.listenerCount(), 0);
  assert.equal(entries[0].cancellations, 1);
  entries[0].callback();
  assert.equal(refreshes, 0);
  dispose();
});


test("usa polling básico si Page Visibility no está disponible y lo invalida al desmontar", () => {
  const document = { hidden: undefined };
  const { entries, schedule } = createScheduler();
  let refreshes = 0;
  const dispose = scheduleLiveAuthorMonitorWhileVisible(
    document, () => { refreshes++; }, 750, schedule
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].intervalMs, 750);
  entries[0].callback();
  assert.equal(refreshes, 1);
  dispose();
  assert.equal(entries[0].cancellations, 1);
  entries[0].callback();
  dispose();
  assert.equal(refreshes, 1);
});

test("revierte el montaje e invalida el primer tick si el scheduler lanza", () => {
  const document = new FakeDocument();
  let queuedCallback;
  const schedule = callback => {
    queuedCallback = callback;
    throw new Error("scheduler setup failed");
  };

  assert.throws(() => scheduleLiveAuthorMonitorWhileVisible(
    document, () => assert.fail("un tick parcial no puede sobrevivir al rollback"), 1_000, schedule
  ), /scheduler setup failed/);

  assert.equal(document.listenerCount(), 0);
  assert.equal(document.defaultView.listenerCount(), 0);
  queuedCallback();
});
