import test from "node:test";
import assert from "node:assert/strict";
import {
  LiveAuthorMonitor,
  mountLiveAuthorMonitorPanel,
  mountLiveAuthorMonitorWorkspace
} from "../dist-monitor/live-author-monitor.js";

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
