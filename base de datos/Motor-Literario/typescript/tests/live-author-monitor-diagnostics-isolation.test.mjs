import test from "node:test";
import assert from "node:assert/strict";
// La lane focalizada construye dist-monitor; npm test solo genera dist.
const monitorModule = await import("../dist-monitor/live-author-monitor.js")
  .catch(() => import("../dist/motor-literario.js"));
const {
  LiveAuthorMonitor,
  mountLiveAuthorMonitorPanel,
  mountLiveAuthorMonitorWorkspace,
  readLiveAuthorMonitorPersistenceDiagnosticsSafely
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
class FakeDocument {
  createElement(tagName) { return new FakeElement(tagName, this); }
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
  return { monitor, container, setTime(value) { now = value; } };
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
