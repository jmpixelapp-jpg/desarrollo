import test from "node:test";
import assert from "node:assert/strict";
const monitorModule = await import("../dist-monitor/live-author-monitor.js")
  .catch(() => import("../dist/motor-literario.js"));
const { LiveAuthorMonitor, mountLiveAuthorMonitorEditorIntegration } = monitorModule;

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
    const callbacks = this.listeners.get(name) ?? [];
    callbacks.push(callback);
    this.listeners.set(name, callbacks);
  }
  click() {
    for (const callback of this.listeners.get("click") ?? []) callback({ type: "click" });
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
  if (predicate(root)) return root;
  for (const child of root.children) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return undefined;
}
function fixture() {
  let now = 0;
  const monitor = new LiveAuthorMonitor({ idleAfterMs: 100, now: () => now });
  const document = new FakeDocument();
  const workspaceContainer = document.createElement("div");
  const activeDocumentContainer = document.createElement("div");
  const snapshots = new Map([
    ["chapter-1", { documentId: "chapter-1", text: "one", revision: 0, sequence: 0 }],
    ["chapter-2", { documentId: "chapter-2", text: "two", revision: 0, sequence: 0 }]
  ]);
  monitor.openDocument(snapshots.get("chapter-1"), "book");
  monitor.openDocument(snapshots.get("chapter-2"), "book");
  const hostApi = {
    getLiveAuthorMonitorSnapshot: id => monitor.getSnapshot(id),
    getLiveAuthorMonitorSnapshots: () => monitor.getSnapshots(),
    subscribeLiveAuthorMonitor: (listener, id) => monitor.subscribe(listener, id),
    ensureLiveAuthorMonitorDocument(id) {
      return monitor.getSnapshot(id) ?? monitor.openDocument(snapshots.get(id), "book");
    }
  };
  let activeDocumentId = "chapter-1";
  const listeners = new Set();
  const editor = {
    getActiveDocumentId: () => activeDocumentId,
    subscribeActiveDocument(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    activateDocument(id) {
      activeDocumentId = id;
      for (const listener of listeners) listener(id);
    }
  };
  return {
    monitor, workspaceContainer, activeDocumentContainer, hostApi, editor,
    listeners,
    setTime(value) { now = value; }
  };
}
function activePanel(container) {
  return findNode(container, node => node.className === "ml-author-monitor");
}
function workspace(container) {
  return findNode(container, node => node.className === "ml-author-workspace");
}

test("sincroniza panel detallado con pestaña activa y conserva el tablero global", () => {
  const f = fixture();
  let canceled = 0;
  const unmount = mountLiveAuthorMonitorEditorIntegration({
    hostApi: f.hostApi,
    editor: f.editor,
    workspaceContainer: f.workspaceContainer,
    activeDocumentContainer: f.activeDocumentContainer,
    getDocumentLabel: id => id.toUpperCase(),
    schedule: () => () => { canceled++; }
  });

  const firstPanel = activePanel(f.activeDocumentContainer);
  assert.ok(firstPanel);
  assert.equal(firstPanel.getAttribute("aria-label"), "Actividad del capítulo activo");
  assert.ok(workspace(f.workspaceContainer));
  assert.match(workspace(f.workspaceContainer).textContent, /2 documentos observados/);

  f.editor.activateDocument("chapter-2");
  const secondPanel = activePanel(f.activeDocumentContainer);
  assert.ok(secondPanel);
  assert.notEqual(secondPanel, firstPanel);
  assert.equal(f.activeDocumentContainer.children.length, 1);
  assert.match(workspace(f.workspaceContainer).textContent, /CHAPTER-1/);
  assert.match(workspace(f.workspaceContainer).textContent, /CHAPTER-2/);

  const chapterOneButton = findNode(workspace(f.workspaceContainer), node =>
    node.tagName === "BUTTON" &&
    node.parentElement?.getAttribute("data-document-id") === "chapter-1"
  );
  assert.ok(chapterOneButton);
  chapterOneButton.click();
  assert.equal(f.editor.getActiveDocumentId(), "chapter-1");
  assert.notEqual(activePanel(f.activeDocumentContainer), secondPanel);

  unmount();
  assert.equal(f.workspaceContainer.children.length, 0);
  assert.equal(f.activeDocumentContainer.children.length, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(canceled, 4);
});

test("oculta el panel detallado cuando el editor no tiene capítulo activo", () => {
  const f = fixture();
  let unmount;
  unmount = mountLiveAuthorMonitorEditorIntegration({
    hostApi: f.hostApi,
    editor: f.editor,
    workspaceContainer: f.workspaceContainer,
    activeDocumentContainer: f.activeDocumentContainer,
    schedule: () => () => {}
  });
  assert.ok(activePanel(f.activeDocumentContainer));
  f.editor.activateDocument(undefined);
  assert.equal(activePanel(f.activeDocumentContainer), undefined);
  assert.equal(f.workspaceContainer.children.length, 1);
  unmount();
});

test("rechaza contenedores compartidos antes de registrar suscripciones", () => {
  const f = fixture();
  assert.throws(() => mountLiveAuthorMonitorEditorIntegration({
    hostApi: f.hostApi,
    editor: f.editor,
    workspaceContainer: f.workspaceContainer,
    activeDocumentContainer: f.workspaceContainer
  }), /contenedores separados/);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.workspaceContainer.children.length, 0);
});

test("reanuda una sesión de monitoreo cerrada al volver a seleccionar el documento", () => {
  const f = fixture();
  let refresh;
  const unmount = mountLiveAuthorMonitorEditorIntegration({
    hostApi: f.hostApi,
    editor: f.editor,
    workspaceContainer: f.workspaceContainer,
    activeDocumentContainer: f.activeDocumentContainer,
    schedule(callback) {
      refresh = callback;
      return () => {};
    }
  });
  const originalSessionId = f.monitor.getSnapshot("chapter-2").sessionId;
  f.monitor.closeDocument("chapter-2");
  assert.equal(f.monitor.getSnapshot("chapter-2"), undefined);

  f.editor.activateDocument("chapter-2");
  const resumed = f.monitor.getSnapshot("chapter-2");
  assert.ok(resumed);
  assert.notEqual(resumed.sessionId, originalSessionId);
  assert.ok(activePanel(f.activeDocumentContainer));
  refresh();
  assert.match(workspace(f.workspaceContainer).textContent, /2 documentos observados/);
  unmount();
});
