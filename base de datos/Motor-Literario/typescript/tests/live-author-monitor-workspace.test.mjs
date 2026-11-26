import test from "node:test";
import assert from "node:assert/strict";
const monitorModule = await import("../dist-monitor/live-author-monitor.js")
  .catch(() => import("../dist/motor-literario.js"));
const { LiveAuthorMonitor, mountLiveAuthorMonitorWorkspace } = monitorModule;

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
function findCards(root) {
  const found = [];
  const walk = node => {
    if (node.getAttribute("role") === "listitem" &&
        node.getAttribute("data-document-id") !== null) found.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return found;
}
function fixture() {
  let time = 0;
  const monitor = new LiveAuthorMonitor({ idleAfterMs: 100, now: () => time });
  const document = new FakeDocument();
  const container = document.createElement("div");
  monitor.openDocument({ documentId: "chapter-1", text: "uno", revision: 0, sequence: 0 }, "book-1");
  const diagnostics = new Map();
  const api = {
    getLiveAuthorMonitorSnapshot: id => monitor.getSnapshot(id),
    getLiveAuthorMonitorSnapshots: () => monitor.getSnapshots(),
    getLiveAuthorMonitorPersistenceDiagnostics: id => diagnostics.get(id),
    subscribeLiveAuthorMonitor: (listener, id) => monitor.subscribe(listener, id)
  };
  return {
    monitor, container, api,
    setTime(value) { time = value; },
    setDiagnostics(id, value) { diagnostics.set(id, value); }
  };
}
function cardFor(root, documentId) {
  return findNode(root, node =>
    node.getAttribute("role") === "listitem" &&
    node.getAttribute("data-document-id") === documentId
  );
}
function metric(card, key) {
  return findNode(card, node => node.getAttribute("data-metric") === key);
}
function status(card) {
  return findNode(card, node => node.getAttribute("role") === "status");
}

test("muestra y actualiza varios documentos abiertos sin mostrar contenido privado", () => {
  const f = fixture();
  f.monitor.openDocument({ documentId: "chapter-2", text: "texto privado", revision: 3, sequence: 3 }, "book-1");
  let refresh;
  const unmount = mountLiveAuthorMonitorWorkspace(f.container, f.api, {
    intervalMs: 250,
    schedule(callback, intervalMs) {
      assert.equal(intervalMs, 250);
      refresh = callback;
      return () => {};
    }
  });
  const root = f.container.children[0];
  assert.equal(findCards(root).length, 2);
  assert.equal(root.textContent.includes("texto privado"), false);
  assert.match(root.textContent, /2 documentos observados/);
  assert.ok(cardFor(root, "chapter-1"));
  assert.ok(cardFor(root, "chapter-2"));

  f.setTime(10);
  f.monitor.recordAdmission({
    documentId: "chapter-1", sequence: 1, baseRevision: 0,
    start: 3, end: 3, replacement: "!"
  }, { status: "queued", ticketId: "ticket-1" });
  assert.equal(status(cardFor(root, "chapter-1")).textContent, "Escribiendo");
  assert.equal(metric(cardFor(root, "chapter-1"), "pending").textContent, "1");
  assert.equal(status(cardFor(root, "chapter-2")).textContent, "En pausa");
  f.monitor.recordCommit({ ticketId: "ticket-1", status: "applied", revision: 1 });
  assert.equal(metric(cardFor(root, "chapter-1"), "revision").textContent, "1 / 1");

  // El resumen del capítulo también refleja pausas acumuladas al reanudar.
  f.setTime(20_000);
  f.monitor.recordAdmission({
    documentId: "chapter-1", sequence: 2, baseRevision: 1,
    start: 4, end: 4, replacement: "?"
  }, { status: "queued", ticketId: "ticket-2" });
  assert.equal(metric(cardFor(root, "chapter-1"), "pauses").textContent, "1");
  assert.equal(metric(cardFor(root, "chapter-1"), "idle").textContent, "00:19");
  refresh();
  assert.equal(findCards(root).length, 2);
  unmount();
  assert.equal(f.container.children.length, 0);
});

test("descubre documentos nuevos y elimina tarjetas de sesiones cerradas al reconciliar", () => {
  const f = fixture();
  let refresh;
  const unmount = mountLiveAuthorMonitorWorkspace(f.container, f.api, {
    schedule(callback) {
      refresh = callback;
      return () => {};
    }
  });
  const root = f.container.children[0];
  assert.equal(findCards(root).length, 1);

  f.monitor.openDocument({ documentId: "chapter-2", text: "dos", revision: 0, sequence: 0 }, "book-1");
  assert.ok(cardFor(root, "chapter-2"));
  assert.equal(findCards(root).length, 2);

  f.monitor.closeDocument("chapter-1");
  refresh();
  assert.equal(cardFor(root, "chapter-1"), undefined);
  assert.ok(cardFor(root, "chapter-2"));
  assert.equal(findCards(root).length, 1);
  unmount();
});

test("ofrece selección explícita de capítulo y cancela eventos al desmontar", () => {
  const f = fixture();
  const selected = [];
  let refresh;
  let canceled = false;
  const unmount = mountLiveAuthorMonitorWorkspace(f.container, f.api, {
    onSelectDocument: id => selected.push(id),
    schedule(callback) {
      refresh = callback;
      return () => { canceled = true; };
    }
  });
  const root = f.container.children[0];
  const open = findNode(root, node => node.tagName === "BUTTON" && node.textContent === "Abrir documento");
  assert.ok(open);
  open.click();
  assert.deepEqual(selected, ["chapter-1"]);

  unmount();
  const countAfterUnmount = root.textContent;
  f.monitor.openDocument({ documentId: "chapter-2", text: "two", revision: 0, sequence: 0 }, "book-1");
  refresh();
  assert.equal(root.textContent, countAfterUnmount);
  assert.equal(canceled, true);
  assert.equal(f.container.children.length, 0);
});

test("valida el intervalo y limpia el contenedor si falla el planificador", () => {
  const f = fixture();
  assert.throws(() => mountLiveAuthorMonitorWorkspace(f.container, f.api, { intervalMs: 0 }), /intervalMs/);
  assert.equal(f.container.children.length, 0);
  assert.throws(() => mountLiveAuthorMonitorWorkspace(f.container, f.api, {
    schedule: () => undefined
  }), /cancelación/);
  assert.equal(f.container.children.length, 0);
});

test("muestra errores de persistencia y lease por capítulo sin datos privados", () => {
  const f = fixture();
  let refresh;
  f.setDiagnostics("chapter-1", {
    documentId: "chapter-1",
    checkpointState: "error",
    checkpointErrorCode: "QuotaExceededError",
    leaseState: "lost"
  });
  const unmount = mountLiveAuthorMonitorWorkspace(f.container, f.api, {
    schedule(callback) { refresh = callback; return () => {}; }
  });
  const root = f.container.children[0];
  const card = cardFor(root, "chapter-1");
  const checkpoint = findNode(card, node => node.getAttribute("data-diagnostic") === "checkpoint");
  const lease = findNode(card, node => node.getAttribute("data-diagnostic") === "lease");
  assert.match(checkpoint.textContent, /cuota de almacenamiento/);
  assert.match(lease.textContent, /se perdió el lease/);
  assert.equal(root.textContent.includes("contenido privado"), false);

  f.setDiagnostics("chapter-1", {
    documentId: "chapter-1",
    checkpointState: "saved",
    lastCheckpointAt: 1_800_000_000_000,
    leaseState: "owner"
  });
  refresh();
  assert.match(checkpoint.textContent, /checkpoint guardado/);
  assert.match(lease.textContent, /esta pestaña posee el lease/);
  unmount();
});

test("muestra fallos de suscriptores en la tarjeta correcta sin detener otras sesiones", () => {
  const f = fixture();
  let refresh;
  f.monitor.openDocument({ documentId: "chapter-2", text: "dos", revision: 0, sequence: 0 }, "book-1");
  f.monitor.subscribe(() => { throw new Error("private listener error"); }, "chapter-1");
  const unmount = mountLiveAuthorMonitorWorkspace(f.container, f.api, {
    schedule(callback) { refresh = callback; return () => {}; }
  });
  const root = f.container.children[0];
  const firstCard = cardFor(root, "chapter-1");
  const secondCard = cardFor(root, "chapter-2");
  const firstDiagnostic = findNode(firstCard, node => node.getAttribute("data-diagnostic") === "listeners");
  const secondDiagnostic = findNode(secondCard, node => node.getAttribute("data-diagnostic") === "listeners");
  assert.match(firstDiagnostic.textContent, /sin errores/);
  assert.match(secondDiagnostic.textContent, /sin errores/);

  f.monitor.recordAdmission({
    documentId: "chapter-1", sequence: 1, baseRevision: 0,
    start: 3, end: 3, replacement: "!"
  }, { status: "queued", ticketId: "workspace-listener-error" });
  refresh();
  assert.match(firstDiagnostic.textContent, /1 fallo/);
  assert.match(secondDiagnostic.textContent, /sin errores/);
  assert.equal(root.textContent.includes("private listener error"), false);
  unmount();
});

test("muestra y conserva el aviso si falla temporalmente getDocumentLabel durante la reconciliación", () => {
  const f = fixture();
  f.monitor.openDocument({ documentId: "chapter-2", text: "dos", revision: 0, sequence: 0 }, "book-1");
  let refresh;
  let failNextLabel = false;
  const unmount = mountLiveAuthorMonitorWorkspace(f.container, f.api, {
    getDocumentLabel(documentId) {
      if (documentId === "chapter-1" && failNextLabel) {
        failNextLabel = false;
        throw new Error("private workspace label exception");
      }
      return "Capítulo " + documentId;
    },
    schedule(callback) { refresh = callback; return () => {}; }
  });
  const root = f.container.children[0];
  const firstCard = cardFor(root, "chapter-1");
  const secondCard = cardFor(root, "chapter-2");
  const firstDiagnostic = findNode(firstCard, node => node.getAttribute("data-diagnostic") === "listeners");
  const secondDiagnostic = findNode(secondCard, node => node.getAttribute("data-diagnostic") === "listeners");

  failNextLabel = true;
  refresh();

  assert.match(firstDiagnostic.textContent, /1 fallo/);
  assert.match(secondDiagnostic.textContent, /sin errores/);
  assert.equal(root.textContent.includes("private workspace label exception"), false);

  refresh();
  const firstHeading = findNode(firstCard, node => node.tagName === "H3");
  assert.equal(firstHeading.textContent, "Capítulo chapter-1");
  assert.match(firstDiagnostic.textContent, /1 fallo/,
    "el aviso local permanece visible después de que la tarjeta se recupera");
  assert.equal(f.monitor.getSnapshot("chapter-1").listenerErrors, 0,
    "el callback interno del workspace se aísla sin contabilizarse como listener externo");
  unmount();
});

test("presenta las siete categorías de actividad en la tarjeta del capítulo correcto", () => {
  const f = fixture();
  let length = "uno".length;
  const operations = [
    { activityKind: "typing", start: () => [length, length], replacement: "x" },
    { activityKind: "composition", start: () => [length, length], replacement: "に" },
    { activityKind: "paste", start: () => [length, length], replacement: "yy" },
    { activityKind: "deletion", start: () => [length - 1, length], replacement: "" },
    { activityKind: "correction", start: () => [0, 1], replacement: "Z" },
    { activityKind: "undo", start: () => [0, 1], replacement: "" },
    { activityKind: "redo", start: () => [0, 0], replacement: "Z" },
    { activityKind: "other", start: () => [length, length], replacement: "!" }
  ];
  operations.forEach((operation, index) => {
    const [start, end] = operation.start();
    const ticketId = "workspace-activity-" + index;
    f.monitor.recordAdmission({
      documentId: "chapter-1",
      sequence: index + 1,
      baseRevision: index,
      start,
      end,
      replacement: operation.replacement,
      activityKind: operation.activityKind
    }, { status: "queued", ticketId });
    f.monitor.recordCommit({ ticketId, status: "applied", revision: index + 1 });
    length += operation.replacement.length - (end - start);
  });

  const unmount = mountLiveAuthorMonitorWorkspace(f.container, f.api, {
    schedule: () => () => {}
  });
  const root = f.container.children[0];
  const chapter = cardFor(root, "chapter-1");
  for (const key of ["typing", "composition", "paste", "deletion", "correction", "undo", "redo", "other"]) {
    assert.equal(metric(chapter, key).textContent, "1", "la tarjeta del capítulo debe presentar " + key);
  }
  assert.equal(root.textContent.includes("texto privado"), false);
  unmount();
});

test("permite configurar métricas compactas por tarjeta de documento", () => {
  const f = fixture();
  f.monitor.openDocument({ documentId: "chapter-2", text: "dos", revision: 0, sequence: 0 }, "book-1");
  const unmount = mountLiveAuthorMonitorWorkspace(f.container, f.api, {
    visibleMetrics: ["typing", "composition", "redo", "pending"]
  });
  const root = f.container.children[0];
  const card = cardFor(root, "chapter-1");
  assert.equal(metric(card, "typing").getAttribute("data-metric"), "typing");
  assert.equal(metric(card, "composition").getAttribute("data-metric"), "composition");
  assert.equal(metric(card, "redo").getAttribute("data-metric"), "redo");
  assert.equal(metric(card, "pending").getAttribute("data-metric"), "pending");
  assert.equal(metric(card, "wordsPerMinute"), undefined);
  assert.equal(metric(card, "paste"), undefined);
  const secondCard = cardFor(root, "chapter-2");
  assert.ok(secondCard);
  assert.equal(metric(secondCard, "typing").getAttribute("data-metric"), "typing");
  unmount();
});

test("rechaza selección de métricas inválidas antes de crear el workspace", () => {
  const f = fixture();
  assert.throws(() => mountLiveAuthorMonitorWorkspace(f.container, f.api, {
    visibleMetrics: ["typing", "typing"]
  }), /no puede repetir/);
  assert.equal(f.container.children.length, 0);
  assert.throws(() => mountLiveAuthorMonitorWorkspace(f.container, f.api, {
    visibleMetrics: ["unknown"]
  }), /desconocida/);
  assert.equal(f.container.children.length, 0);
});
