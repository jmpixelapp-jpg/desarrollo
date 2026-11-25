import test from "node:test";
import assert from "node:assert/strict";
import { LiveAuthorMonitor, mountLiveAuthorMonitorPanel } from "../dist/motor-literario.js";

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.className = "";
    this._textContent = "";
    this.parentElement = undefined;
  }
  set textContent(value) {
    this._textContent = String(value);
    for (const child of this.children) child.parentElement = undefined;
    this.children = [];
  }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(""); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
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
  if (predicate(root)) return root;
  for (const child of root.children) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return undefined;
}
function fixture() {
  let time = 0;
  const monitor = new LiveAuthorMonitor({ idleAfterMs: 100, now: () => time });
  const document = new FakeDocument();
  const container = document.createElement("div");
  monitor.openDocument({ documentId: "chapter-1", text: "contenido privado", revision: 0, sequence: 0 }, "book-1");
  const api = {
    getLiveAuthorMonitorSnapshot: id => monitor.getSnapshot(id),
    getLiveAuthorMonitorSnapshots: () => monitor.getSnapshots(),
    subscribeLiveAuthorMonitor: (listener, id) => monitor.subscribe(listener, id)
  };
  return { monitor, container, api, setTime(value) { time = value; } };
}
function metric(root, key) {
  return findNode(root, node => node.getAttribute("data-metric") === key);
}
function status(root) {
  return findNode(root, node => node.getAttribute("role") === "status");
}

test("monta un panel accesible con métricas sin exponer el texto del manuscrito", () => {
  const f = fixture();
  const unmount = mountLiveAuthorMonitorPanel(f.container, f.api, {
    documentId: "chapter-1",
    schedule: () => () => {}
  });
  const panel = f.container.children[0];
  assert.ok(panel);
  assert.equal(panel.getAttribute("role"), "region");
  assert.equal(panel.getAttribute("aria-label"), "Actividad del autor");
  assert.equal(status(panel).textContent, "En pausa");
  assert.equal(metric(panel, "session").textContent, "00:00");
  assert.equal(metric(panel, "revision").textContent, "0 / 0");
  assert.equal(panel.textContent.includes("contenido privado"), false);
  unmount();
  assert.equal(f.container.children.length, 0);
});

test("actualiza escritura, pausa y durabilidad mediante eventos y refresco", () => {
  const f = fixture();
  let refresh;
  let canceled = false;
  const unmount = mountLiveAuthorMonitorPanel(f.container, f.api, {
    documentId: "chapter-1",
    intervalMs: 50,
    schedule(callback, intervalMs) {
      assert.equal(intervalMs, 50);
      refresh = callback;
      return () => { canceled = true; };
    }
  });
  const panel = f.container.children[0];
  f.setTime(10);
  f.monitor.recordAdmission({
    documentId: "chapter-1", sequence: 1, baseRevision: 0,
    start: 17, end: 17, replacement: "!"
  }, { status: "queued", ticketId: "ticket-1" });
  assert.equal(status(panel).textContent, "Escribiendo");
  assert.equal(metric(panel, "inserted").textContent, "1");
  assert.equal(metric(panel, "pending").textContent, "1");
  assert.equal(metric(panel, "revision").textContent, "0 / 1");
  f.setTime(111);
  refresh();
  assert.equal(status(panel).textContent, "En pausa");
  f.setTime(120);
  f.monitor.recordCommit({ ticketId: "ticket-1", status: "applied", revision: 1 });
  assert.equal(metric(panel, "committed").textContent, "1");
  assert.equal(metric(panel, "pending").textContent, "0");
  assert.equal(metric(panel, "revision").textContent, "1 / 1");
  assert.match(findNode(panel, node => node.className === "ml-author-monitor__durability").textContent, /confirmados/);
  unmount();
  const previous = status(panel).textContent;
  f.setTime(1_000);
  refresh();
  assert.equal(status(panel).textContent, previous);
  assert.equal(canceled, true);
  assert.equal(f.container.children.length, 0);
});

test("muestra la resincronización cuando un commit falla", () => {
  const f = fixture();
  const unmount = mountLiveAuthorMonitorPanel(f.container, f.api, {
    documentId: "chapter-1",
    schedule: () => () => {}
  });
  const panel = f.container.children[0];
  f.monitor.recordAdmission({
    documentId: "chapter-1", sequence: 1, baseRevision: 0,
    start: 17, end: 17, replacement: "!"
  }, { status: "queued", ticketId: "ticket-failed" });
  f.monitor.recordCommit({ ticketId: "ticket-failed", status: "rejected" });
  assert.equal(status(panel).textContent, "Requiere resincronización");
  assert.match(findNode(panel, node => node.className === "ml-author-monitor__durability").textContent, /resincronizarse/);
  unmount();
});

test("rechaza un documento inválido antes de insertar elementos DOM", () => {
  const f = fixture();
  assert.throws(() => mountLiveAuthorMonitorPanel(f.container, f.api, { documentId: " " }), /documentId/);
  assert.equal(f.container.children.length, 0);
});
