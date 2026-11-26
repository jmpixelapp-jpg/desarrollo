import test from "node:test";
import assert from "node:assert/strict";
// La lane focalizada construye dist-monitor; npm test solo genera dist.
const monitorModule = await import("../dist-monitor/live-author-monitor.js")
  .catch(() => import("../dist/motor-literario.js"));
const {
  LiveAuthorMonitor,
  mountLiveAuthorMonitorPanel,
  mountLiveAuthorMonitorWorkspace,
  readLiveAuthorMonitorPersistenceDiagnosticsSafely,
  scheduleLiveAuthorMonitorWhileVisible
} = monitorModule;

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.listeners = new Map();
    this.className = "";
    this._textContent = "";
    this.parentElement = undefined;
    this.hidden = false;
    this.type = "";
  }
  set textContent(value) {
    this._textContent = String(value);
    for (const child of this.children) child.parentElement = undefined;
    this.children = [];
  }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(""); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, callback) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(callback);
    this.listeners.set(name, listeners);
  }
  append(...children) {
    for (const child of children) {
      child.parentElement?.removeChild(child);
      child.parentElement = this;
      this.children.push(child);
    }
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentElement = undefined;
    }
    return child;
  }
  remove() { this.parentElement?.removeChild(this); }
}
class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, callback) { const listeners = this.listeners.get(name) ?? []; listeners.push(callback); this.listeners.set(name, listeners); }
  removeEventListener(name, callback) { const listeners = this.listeners.get(name) ?? []; this.listeners.set(name, listeners.filter(item => item !== callback)); }
  dispatch(name) { for (const listener of [...(this.listeners.get(name) ?? [])]) listener(); }
  listenerCount(name) { return (this.listeners.get(name) ?? []).length; }
}
class FakeDocument extends FakeEventTarget {
  constructor() { super(); this.hidden = false; this.defaultView = new FakeEventTarget(); }
  createElement(tagName) { return new FakeElement(tagName, this); }
  setHidden(hidden) { this.hidden = hidden; this.dispatch("visibilitychange"); }
  visibilityListenerCount() { return this.listenerCount("visibilitychange"); }
  lifecycleListenerCount() { return this.listenerCount("freeze") + this.listenerCount("resume") + this.defaultView.listenerCount("pagehide") + this.defaultView.listenerCount("pageshow"); }
}
function findNode(root, predicate) {
  if (!root) return undefined;
  if (predicate(root)) return root;
  for (const child of root.children) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return undefined;
}
function fixture(documentIds = ["chapter-1"]) {
  let now = 0;
  const monitor = new LiveAuthorMonitor({ idleAfterMs: 100, now: () => now });
  for (const documentId of documentIds) {
    monitor.openDocument({
      documentId, text: "contenido privado", revision: 0, sequence: 0
    }, "book-1");
  }
  const document = new FakeDocument();
  const container = document.createElement("div");
  return { monitor, document, container, setTime(value) { now = value; } };
}
function recordPending(monitor, documentId, ticketId) {
  monitor.recordAdmission({
    documentId, sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "A"
  }, { status: "queued", ticketId });
}
function metric(root, key) {
  return findNode(root, node => node.getAttribute("data-metric") === key);
}
function diagnostic(root, key) {
  return findNode(root, node => node.getAttribute("data-diagnostic") === key);
}
function documentCard(root, documentId) {
  return findNode(root, node => node.getAttribute("data-document-id") === documentId);
}

test("un error del diagnóstico no detiene las métricas del panel y se recupera sin remontarlo", () => {
  const f = fixture();
  let shouldThrow = true;
  let refresh;
  const api = {
    getLiveAuthorMonitorSnapshot: id => f.monitor.getSnapshot(id),
    getLiveAuthorMonitorSnapshots: () => f.monitor.getSnapshots(),
    getLiveAuthorMonitorPersistenceDiagnostics(id) {
      if (shouldThrow) throw new Error("contenido privado del adaptador");
      return {
        documentId: id,
        checkpointState: "saved",
        lastCheckpointAt: 1_800_000_000_000,
        leaseState: "owner"
      };
    },
    subscribeLiveAuthorMonitor: (listener, id) => f.monitor.subscribe(listener, id)
  };
  const unmount = mountLiveAuthorMonitorPanel(f.container, api, {
    documentId: "chapter-1",
    schedule(callback) { refresh = callback; return () => {}; }
  });
  const root = f.container.children[0];
  assert.match(diagnostic(root, "checkpoint").textContent, /diagnóstico no disponible/);
  assert.equal(diagnostic(root, "checkpoint").getAttribute("data-level"), "warning");
  assert.equal(diagnostic(root, "lease").getAttribute("data-level"), "warning");
  assert.equal(root.textContent.includes("contenido privado del adaptador"), false);

  recordPending(f.monitor, "chapter-1", "panel-ticket");
  assert.equal(metric(root, "pending").textContent, "1");
  f.monitor.recordCommit({ ticketId: "panel-ticket", status: "applied", revision: 1 });
  assert.equal(metric(root, "revision").textContent, "1 / 1");

  shouldThrow = false;
  refresh();
  assert.match(diagnostic(root, "checkpoint").textContent, /checkpoint guardado/);
  assert.match(diagnostic(root, "lease").textContent, /esta pestaña posee el lease/);
  unmount();
});

test("el workspace aísla fallos de diagnóstico por documento y mantiene las demás tarjetas", () => {
  const f = fixture(["chapter-1", "chapter-2"]);
  let firstDocumentFails = true;
  let refresh;
  const api = {
    getLiveAuthorMonitorSnapshot: id => f.monitor.getSnapshot(id),
    getLiveAuthorMonitorSnapshots: () => f.monitor.getSnapshots(),
    getLiveAuthorMonitorPersistenceDiagnostics(id) {
      if (id === "chapter-1" && firstDocumentFails) {
        throw new Error("contenido privado del diagnóstico");
      }
      return {
        documentId: id,
        checkpointState: "saved",
        lastCheckpointAt: 1_800_000_000_000,
        leaseState: "owner"
      };
    },
    subscribeLiveAuthorMonitor: (listener, id) => f.monitor.subscribe(listener, id)
  };
  const unmount = mountLiveAuthorMonitorWorkspace(f.container, api, {
    schedule(callback) { refresh = callback; return () => {}; }
  });
  const root = f.container.children[0];
  const first = documentCard(root, "chapter-1");
  const second = documentCard(root, "chapter-2");
  assert.ok(first);
  assert.ok(second);
  assert.equal(diagnostic(first, "checkpoint").getAttribute("data-level"), "warning");
  assert.match(diagnostic(second, "checkpoint").textContent, /checkpoint guardado/);

  recordPending(f.monitor, "chapter-1", "workspace-ticket");
  assert.equal(metric(first, "pending").textContent, "1");
  assert.match(diagnostic(second, "lease").textContent, /esta pestaña posee el lease/);
  assert.equal(root.textContent.includes("contenido privado del diagnóstico"), false);

  firstDocumentFails = false;
  refresh();
  assert.match(diagnostic(first, "checkpoint").textContent, /checkpoint guardado/);
  assert.equal(diagnostic(first, "checkpoint").getAttribute("data-level"), "info");
  unmount();
});

test("ignora diagnósticos cruzados de otro documento", () => {
  const f = fixture();
  const api = {
    getLiveAuthorMonitorSnapshot: id => f.monitor.getSnapshot(id),
    getLiveAuthorMonitorSnapshots: () => f.monitor.getSnapshots(),
    getLiveAuthorMonitorPersistenceDiagnostics: () => ({
      documentId: "chapter-other",
      checkpointState: "saved",
      leaseState: "owner"
    }),
    subscribeLiveAuthorMonitor: (listener, id) => f.monitor.subscribe(listener, id)
  };
  const unmount = mountLiveAuthorMonitorPanel(f.container, api, {
    documentId: "chapter-1",
    schedule: () => () => {}
  });
  const root = f.container.children[0];
  assert.match(diagnostic(root, "checkpoint").textContent, /diagnóstico no disponible/);
  assert.equal(diagnostic(root, "checkpoint").getAttribute("data-level"), "warning");
  unmount();
});


test("rechaza listas dispersas de métricas antes de montar panel o workspace", () => {
  const f = fixture();
  const sparseMetrics = new Array(2);
  sparseMetrics[1] = "paste";

  assert.throws(() => mountLiveAuthorMonitorPanel(f.container, {
    getLiveAuthorMonitorSnapshot: id => f.monitor.getSnapshot(id),
    getLiveAuthorMonitorSnapshots: () => f.monitor.getSnapshots(),
    getLiveAuthorMonitorPersistenceDiagnostics: () => undefined,
    subscribeLiveAuthorMonitor: (listener, id) => f.monitor.subscribe(listener, id)
  }, {
    documentId: "chapter-1",
    visibleMetrics: sparseMetrics,
    schedule: () => () => {}
  }), /posiciones vacías/);
  assert.equal(f.container.children.length, 0);

  assert.throws(() => mountLiveAuthorMonitorWorkspace(f.container, {
    getLiveAuthorMonitorSnapshot: id => f.monitor.getSnapshot(id),
    getLiveAuthorMonitorSnapshots: () => f.monitor.getSnapshots(),
    getLiveAuthorMonitorPersistenceDiagnostics: () => undefined,
    subscribeLiveAuthorMonitor: (listener, id) => f.monitor.subscribe(listener, id)
  }, {
    visibleMetrics: sparseMetrics,
    schedule: () => () => {}
  }), /posiciones vacías/);
  assert.equal(f.container.children.length, 0);
});

test("rechaza valores undefined explícitos en visibleMetrics sin crear vistas parciales", () => {
  const f = fixture();
  const api = {
    getLiveAuthorMonitorSnapshot: id => f.monitor.getSnapshot(id),
    getLiveAuthorMonitorSnapshots: () => f.monitor.getSnapshots(),
    getLiveAuthorMonitorPersistenceDiagnostics: () => undefined,
    subscribeLiveAuthorMonitor: (listener, id) => f.monitor.subscribe(listener, id)
  };
  assert.throws(() => mountLiveAuthorMonitorPanel(f.container, api, {
    documentId: "chapter-1",
    visibleMetrics: [undefined],
    schedule: () => () => {}
  }), /Métrica de panel desconocida/);
  assert.equal(f.container.children.length, 0);
  assert.throws(() => mountLiveAuthorMonitorWorkspace(f.container, api, {
    visibleMetrics: [undefined],
    schedule: () => () => {}
  }), /Métrica de workspace desconocida/);
  assert.equal(f.container.children.length, 0);
});


test("clona y congela diagnósticos para que el panel no dependa del objeto mutable del anfitrión", () => {
  const source = {
    documentId: "chapter-1",
    checkpointState: "saved",
    lastCheckpointAt: 1_800_000_000_000,
    leaseState: "owner",
    fencingToken: 7,
    leaseExpiresAt: 1_800_000_030_000
  };
  const f = fixture();
  const safe = readLiveAuthorMonitorPersistenceDiagnosticsSafely({
    getLiveAuthorMonitorPersistenceDiagnostics: () => source,
    getLiveAuthorMonitorSnapshot: id => f.monitor.getSnapshot(id),
    getLiveAuthorMonitorSnapshots: () => f.monitor.getSnapshots(),
    subscribeLiveAuthorMonitor: (listener, id) => f.monitor.subscribe(listener, id)
  }, "chapter-1");

  assert.ok(safe);
  assert.equal(Object.isFrozen(safe), true);
  source.checkpointState = "error";
  source.fencingToken = 99;
  assert.equal(safe.checkpointState, "saved");
  assert.equal(safe.fencingToken, 7);
});

test("convierte getters defectuosos del diagnóstico en estado no disponible sin detener métricas", () => {
  const f = fixture();
  let refresh;
  const diagnosticPayload = {
    documentId: "chapter-1",
    leaseState: "owner"
  };
  Object.defineProperty(diagnosticPayload, "checkpointState", {
    enumerable: true,
    get() { throw new Error("contenido privado del getter"); }
  });
  const api = {
    getLiveAuthorMonitorSnapshot: id => f.monitor.getSnapshot(id),
    getLiveAuthorMonitorSnapshots: () => f.monitor.getSnapshots(),
    getLiveAuthorMonitorPersistenceDiagnostics: () => diagnosticPayload,
    subscribeLiveAuthorMonitor: (listener, id) => f.monitor.subscribe(listener, id)
  };
  const unmount = mountLiveAuthorMonitorPanel(f.container, api, {
    documentId: "chapter-1",
    schedule(callback) { refresh = callback; return () => {}; }
  });
  const root = f.container.children[0];
  assert.match(diagnostic(root, "checkpoint").textContent, /diagnóstico no disponible/);
  assert.equal(diagnostic(root, "checkpoint").getAttribute("data-level"), "warning");
  recordPending(f.monitor, "chapter-1", "getter-ticket");
  assert.equal(metric(root, "pending").textContent, "1");
  assert.equal(root.textContent.includes("contenido privado del getter"), false);
  unmount();
});

test("rechaza estados desconocidos y metadatos fuera de rango del adaptador", () => {
  const f = fixture();
  let supplied = {
    documentId: "chapter-1",
    checkpointState: "future-state",
    leaseState: "owner"
  };
  const api = {
    getLiveAuthorMonitorPersistenceDiagnostics: () => supplied,
    getLiveAuthorMonitorSnapshot: id => f.monitor.getSnapshot(id),
    getLiveAuthorMonitorSnapshots: () => f.monitor.getSnapshots(),
    subscribeLiveAuthorMonitor: (listener, id) => f.monitor.subscribe(listener, id)
  };
  assert.equal(readLiveAuthorMonitorPersistenceDiagnosticsSafely(api, "chapter-1"), undefined);

  supplied = {
    documentId: "chapter-1",
    checkpointState: "saved",
    leaseState: "owner",
    fencingToken: -1
  };
  assert.equal(readLiveAuthorMonitorPersistenceDiagnosticsSafely(api, "chapter-1"), undefined);

  supplied = {
    documentId: "chapter-1",
    checkpointState: "saved",
    leaseState: "owner",
    checkpointErrorCode: "X".repeat(65)
  };
  assert.equal(readLiveAuthorMonitorPersistenceDiagnosticsSafely(api, "chapter-1"), undefined);
});


test("panel y workspace suspenden el polling en segundo plano y refrescan al volver a primer plano", () => {
  const f = fixture(["chapter-1", "chapter-2"]);
  f.document.setHidden(true);
  const scheduleCalls = [];
  let cancellations = 0;
  const schedule = (callback, intervalMs) => {
    const item = { callback, intervalMs, cancelled: false };
    scheduleCalls.push(item);
    return () => { if (item.cancelled) return; item.cancelled = true; cancellations += 1; };
  };
  const api = {
    getLiveAuthorMonitorSnapshot: id => f.monitor.getSnapshot(id),
    getLiveAuthorMonitorSnapshots: () => f.monitor.getSnapshots(),
    getLiveAuthorMonitorPersistenceDiagnostics: () => undefined,
    subscribeLiveAuthorMonitor: (listener, id) => f.monitor.subscribe(listener, id)
  };
  const unmountPanel = mountLiveAuthorMonitorPanel(f.container, api, { documentId: "chapter-1", intervalMs: 250, schedule });
  const workspaceContainer = f.document.createElement("div");
  const unmountWorkspace = mountLiveAuthorMonitorWorkspace(workspaceContainer, api, { intervalMs: 500, schedule });
  assert.equal(f.document.visibilityListenerCount(), 2);
  assert.equal(scheduleCalls.length, 0, "no se crean intervalos mientras la pestaña ya está oculta");
  f.document.setHidden(false);
  assert.equal(scheduleCalls.length, 2);
  assert.equal(scheduleCalls[0].intervalMs, 250);
  assert.equal(scheduleCalls[1].intervalMs, 500);
  f.document.setHidden(true);
  assert.equal(cancellations, 2);
  assert.equal(scheduleCalls.every(item => item.cancelled), true);
  f.document.setHidden(false);
  assert.equal(scheduleCalls.length, 4, "cada vista programa un nuevo intervalo al reanudarse");
  scheduleCalls[2].callback();
  scheduleCalls[3].callback();
  f.document.setHidden(true);
  assert.equal(cancellations, 4);
  unmountPanel();
  unmountWorkspace();
  assert.equal(f.document.visibilityListenerCount(), 0);
  f.document.setHidden(false);
  assert.equal(scheduleCalls.length, 4, "no hay reactivación después del desmontaje");
});

test("el scheduler visible actualiza de inmediato y cancela de forma idempotente", () => {
  const f = fixture();
  const scheduleCalls = [];
  let cancellations = 0;
  let refreshes = 0;
  const cancel = scheduleLiveAuthorMonitorWhileVisible(f.document, () => { refreshes += 1; }, 750, (callback, intervalMs) => {
    scheduleCalls.push({ callback, intervalMs });
    return () => { cancellations += 1; };
  });
  assert.equal(scheduleCalls.length, 1);
  f.document.setHidden(true);
  assert.equal(cancellations, 1);
  scheduleCalls[0].callback();
  assert.equal(refreshes, 0, "un callback que quedó encolado no se ejecuta mientras la pestaña está oculta");
  f.document.setHidden(false);
  assert.equal(refreshes, 1);
  assert.equal(scheduleCalls.length, 2);
  cancel();
  cancel();
  scheduleCalls[1].callback();
  assert.equal(refreshes, 1, "un callback antiguo tampoco se ejecuta después del desmontaje");
  assert.equal(cancellations, 2);
  assert.equal(f.document.visibilityListenerCount(), 0);
});

test("reanuda desde pagehide/pageshow y freeze/resume sin duplicar intervalos", () => {
  const f = fixture();
  const scheduleCalls = []; let cancellations = 0; let refreshes = 0;
  const dispose = scheduleLiveAuthorMonitorWhileVisible(f.document, () => { refreshes += 1; }, 400, (callback, intervalMs) => {
    scheduleCalls.push({ callback, intervalMs }); return () => { cancellations += 1; };
  });
  assert.equal(scheduleCalls.length, 1); assert.equal(f.document.lifecycleListenerCount(), 4);
  f.document.defaultView.dispatch("pagehide"); assert.equal(cancellations, 1);
  scheduleCalls[0].callback(); assert.equal(refreshes, 0, "no se ejecuta un tick encolado después de pagehide");
  f.document.defaultView.dispatch("pageshow"); assert.equal(refreshes, 1); assert.equal(scheduleCalls.length, 2);
  f.document.dispatch("freeze"); assert.equal(cancellations, 2);
  scheduleCalls[1].callback(); assert.equal(refreshes, 1, "freeze invalida el callback anterior");
  f.document.dispatch("resume"); assert.equal(refreshes, 2); assert.equal(scheduleCalls.length, 3);
  f.document.setHidden(true); assert.equal(cancellations, 3);
  f.document.defaultView.dispatch("pageshow"); f.document.dispatch("resume");
  assert.equal(scheduleCalls.length, 3, "una señal de reanudación no vence el estado hidden");
  f.document.setHidden(false); assert.equal(refreshes, 3); assert.equal(scheduleCalls.length, 4);
  dispose(); assert.equal(f.document.lifecycleListenerCount(), 0);
  assert.equal(f.document.visibilityListenerCount(), 0);
  assert.equal(f.document.defaultView.listenerCount("pagehide"), 0);
  assert.equal(f.document.defaultView.listenerCount("pageshow"), 0);
  scheduleCalls[3].callback(); assert.equal(refreshes, 3);
});

test("el fallback sin Page Visibility invalida ticks encolados y cancela una sola vez", () => {
  const scheduled = [];
  let refreshes = 0;
  let cancellations = 0;
  const dispose = scheduleLiveAuthorMonitorWhileVisible(
    { hidden: undefined },
    () => { refreshes += 1; },
    625,
    (callback, intervalMs) => {
      scheduled.push({ callback, intervalMs });
      return () => { cancellations += 1; };
    }
  );

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].intervalMs, 625);
  scheduled[0].callback();
  assert.equal(refreshes, 1);

  dispose();
  dispose();
  scheduled[0].callback();
  assert.equal(refreshes, 1, "un tick ya encolado no debe refrescar una vista desmontada");
  assert.equal(cancellations, 1, "la cancelación del planificador debe ser idempotente");
});

test("el fallback rechaza un planificador sin cancelación e invalida su callback", () => {
  let queuedCallback;
  let refreshes = 0;
  assert.throws(() => scheduleLiveAuthorMonitorWhileVisible(
    { hidden: undefined },
    () => { refreshes += 1; },
    500,
    callback => {
      queuedCallback = callback;
      return undefined;
    }
  ), /función de cancelación/);

  queuedCallback();
  assert.equal(refreshes, 0, "un scheduler inválido no debe dejar callbacks activos");
});


test("los ticks de una generación anterior quedan invalidados después de reanudar", () => {
  const f = fixture();
  const scheduled = [];
  let refreshes = 0;
  const dispose = scheduleLiveAuthorMonitorWhileVisible(
    f.document,
    () => { refreshes += 1; },
    400,
    callback => {
      const item = { callback, cancelled: false };
      scheduled.push(item);
      return () => { item.cancelled = true; };
    }
  );

  assert.equal(scheduled.length, 1);
  f.document.defaultView.dispatch("pagehide");
  f.document.defaultView.dispatch("pageshow");
  assert.equal(refreshes, 1, "la reanudación realiza una lectura inmediata");
  assert.equal(scheduled.length, 2);

  scheduled[0].callback();
  assert.equal(refreshes, 1, "un tick antiguo no revive al volver a active");
  scheduled[1].callback();
  assert.equal(refreshes, 2, "el intervalo vigente sigue funcionando");
  dispose();
});

test("un fallo al reprogramar invalida callbacks huérfanos y permite reintentar", () => {
  const f = fixture();
  const scheduled = [];
  let scheduleCalls = 0;
  let refreshes = 0;
  const dispose = scheduleLiveAuthorMonitorWhileVisible(
    f.document,
    () => { refreshes += 1; },
    400,
    callback => {
      scheduleCalls += 1;
      const item = { callback, cancelled: false };
      scheduled.push(item);
      if (scheduleCalls === 2) throw new Error("scheduler temporalmente no disponible");
      return () => { item.cancelled = true; };
    }
  );

  f.document.defaultView.dispatch("pagehide");
  assert.throws(() => f.document.defaultView.dispatch("pageshow"), /scheduler temporalmente no disponible/);
  assert.equal(refreshes, 1);
  scheduled[1].callback();
  assert.equal(refreshes, 1, "el callback del intento fallido queda cercado");

  f.document.defaultView.dispatch("pageshow");
  assert.equal(refreshes, 2, "un evento posterior puede recuperar el refresco inmediato");
  assert.equal(scheduleCalls, 3);
  scheduled[1].callback();
  assert.equal(refreshes, 2, "el callback huérfano sigue inválido tras un reintento");
  scheduled[2].callback();
  assert.equal(refreshes, 3, "solo el callback de la generación nueva puede ejecutarse");
  dispose();
});

test("un fallo durante el montaje invalida ticks encolados y retira listeners", () => {
  const f = fixture();
  let queuedCallback;
  let refreshes = 0;
  assert.throws(() => scheduleLiveAuthorMonitorWhileVisible(
    f.document,
    () => { refreshes += 1; },
    400,
    callback => {
      queuedCallback = callback;
      throw new Error("fallo tras encolar");
    }
  ), /fallo tras encolar/);

  queuedCallback();
  assert.equal(refreshes, 0, "el tick no debe sobrevivir a un montaje fallido");
  assert.equal(f.document.visibilityListenerCount(), 0);
  assert.equal(f.document.lifecycleListenerCount(), 0);
});


test("dispose intenta retirar todos los listeners y cancelar el intervalo aunque fallen limpiezas individuales", () => {
  const f = fixture();
  const attempts = [];
  const originalViewRemove = f.document.defaultView.removeEventListener.bind(f.document.defaultView);
  const originalDocumentRemove = f.document.removeEventListener.bind(f.document);
  f.document.defaultView.removeEventListener = (name, listener) => {
    attempts.push("window:" + name);
    originalViewRemove(name, listener);
    if (name === "pagehide") throw new Error("fallo al retirar pagehide");
  };
  f.document.removeEventListener = (name, listener) => {
    attempts.push("document:" + name);
    originalDocumentRemove(name, listener);
    if (name === "freeze") throw new Error("fallo al retirar freeze");
  };

  let intervalCancelled = false;
  const dispose = scheduleLiveAuthorMonitorWhileVisible(
    f.document,
    () => {},
    400,
    () => () => { intervalCancelled = true; }
  );

  assert.throws(dispose, /fallo al retirar pagehide/);
  assert.deepEqual(attempts, [
    "window:pagehide",
    "window:pageshow",
    "document:visibilitychange",
    "document:freeze",
    "document:resume"
  ], "un error no debe interrumpir el intento de retirar listeners posteriores");
  assert.equal(intervalCancelled, true, "el timer se cancela incluso si falla la limpieza de listeners");
  assert.equal(f.document.visibilityListenerCount(), 0);
  assert.equal(f.document.lifecycleListenerCount(), 0);

  dispose();
  assert.equal(attempts.length, 5, "dispose permanece idempotente después de reportar un error");
});
