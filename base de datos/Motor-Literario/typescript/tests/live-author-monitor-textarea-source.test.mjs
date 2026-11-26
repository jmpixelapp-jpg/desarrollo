import test from "node:test";
import assert from "node:assert/strict";
const monitorModule = await import("../dist-monitor/live-author-monitor.js")
  .catch(() => import("../dist/motor-literario.js"));
const { LiveAuthorMonitorTextAreaSource } = monitorModule;

class FakeTextArea {
  value;
  selectionStart = 0;
  selectionEnd = 0;
  listeners = new Map();

  constructor(value) { this.value = value; }

  addEventListener(type, listener) {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emitBeforeInput(inputType, isComposing = false) {
    const event = { defaultPrevented: false, inputType, isComposing };
    for (const listener of [...(this.listeners.get("beforeinput") ?? [])]) listener(event);
  }

  emitInput(isComposing = false, inputType = "") {
    const event = { inputType, isComposing };
    for (const listener of [...(this.listeners.get("input") ?? [])]) listener(event);
  }

  emitCompositionStart() {
    for (const listener of [...(this.listeners.get("compositionstart") ?? [])]) listener({});
  }

  emitCompositionEnd() {
    for (const listener of [...(this.listeners.get("compositionend") ?? [])]) listener({});
  }

  edit({ start, end, nextValue, inputType = "insertText", isComposing = false }) {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.emitBeforeInput(inputType, isComposing);
    this.value = nextValue;
    this.emitInput(isComposing);
  }
}

function fixture(text = "hello", revision = 4, sequence = 9) {
  const element = new FakeTextArea(text);
  const errors = [];
  const source = new LiveAuthorMonitorTextAreaSource({
    element,
    initialSnapshot: {
      documentId: "chapter-1",
      text,
      revision,
      sequence
    },
    onError: error => errors.push(error)
  });
  const changes = [];
  const stop = source.subscribeChanges(change => changes.push(change));
  return { element, source, errors, changes, stop };
}

test("convierte escritura y reemplazo de selección en deltas UTF-16 consecutivos", () => {
  const f = fixture("hello");
  f.element.edit({ start: 5, end: 5, nextValue: "hello!", inputType: "insertText" });
  f.element.edit({ start: 1, end: 3, nextValue: "hXlo!", inputType: "insertText" });

  assert.deepEqual(f.changes, [
    {
      documentId: "chapter-1",
      sequence: 10,
      baseRevision: 4,
      start: 5,
      end: 5,
      replacement: "!",
      activityKind: "typing"
    },
    {
      documentId: "chapter-1",
      sequence: 11,
      baseRevision: 5,
      start: 1,
      end: 3,
      replacement: "X",
      activityKind: "typing"
    }
  ]);
  assert.deepEqual(f.source.getState(), {
    documentId: "chapter-1",
    revision: 6,
    sequence: 11,
    documentLength: 5,
    compositionActive: false,
    needsResync: false
  });
  f.stop();
  f.source.dispose();
});

test("reconstruye eliminaciones hacia atrás y hacia delante", () => {
  const f = fixture("abcd", 0, 0);
  f.element.edit({
    start: 3,
    end: 3,
    nextValue: "abd",
    inputType: "deleteContentBackward"
  });
  f.element.edit({
    start: 1,
    end: 1,
    nextValue: "ad",
    inputType: "deleteContentForward"
  });

  assert.deepEqual(f.changes.map(change => ({
    start: change.start,
    end: change.end,
    replacement: change.replacement
  })), [
    { start: 2, end: 3, replacement: "" },
    { start: 1, end: 2, replacement: "" }
  ]);
  f.stop();
  f.source.dispose();
});

test("maneja reemplazo de selección por pegado y conserva longitudes UTF-16", () => {
  const f = fixture("A😀B", 0, 0);
  f.element.edit({
    start: 1,
    end: 3,
    nextValue: "AéB",
    inputType: "insertFromPaste"
  });

  assert.equal(f.changes[0].start, 1);
  assert.equal(f.changes[0].end, 3);
  assert.equal(f.changes[0].replacement, "é");
  assert.equal(f.changes[0].activityKind, "paste");
  assert.equal(f.source.getState().documentLength, 3);
  f.stop();
  f.source.dispose();
});

test("exige resincronización para undo/redo y no emite deltas inventados", () => {
  const f = fixture("alpha", 2, 5);
  f.element.edit({
    start: 2,
    end: 2,
    nextValue: "alha",
    inputType: "historyUndo"
  });
  assert.equal(f.changes.length, 0);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.errors[0].code, "unsupported-input-type");

  assert.throws(() => f.source.resynchronize({
    documentId: "chapter-1",
    text: "alpha",
    revision: 3,
    sequence: 6
  }), error => error.code === "document-mismatch");

  const state = f.source.resynchronize({
    documentId: "chapter-1",
    text: "alha",
    revision: 3,
    sequence: 6
  });
  assert.equal(state.needsResync, false);
  assert.equal(state.revision, 3);
  assert.equal(state.sequence, 6);

  f.element.edit({ start: 4, end: 4, nextValue: "alha!", inputType: "insertText" });
  assert.equal(f.changes[0].sequence, 7);
  assert.equal(f.changes[0].baseRevision, 3);
  f.stop();
  f.source.dispose();
});

test("marca como no confiable un input sin beforeinput previo", () => {
  const f = fixture();
  f.element.value = "hello!";
  f.element.emitInput();
  assert.equal(f.changes.length, 0);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.errors[0].code, "missing-beforeinput");
  f.stop();
  f.source.dispose();
});

test("rechaza snapshots iniciales distintos del contenido visible", () => {
  const element = new FakeTextArea("visible");
  assert.throws(() => new LiveAuthorMonitorTextAreaSource({
    element,
    initialSnapshot: {
      documentId: "chapter-1",
      text: "authoritative",
      revision: 0,
      sequence: 0
    }
  }), error => error.code === "document-mismatch");
});

test("desmonta listeners al retirar la última suscripción y al disponer el adaptador", () => {
  const f = fixture();
  assert.equal(f.element.listeners.get("beforeinput").size, 1);
  assert.equal(f.element.listeners.get("input").size, 1);
  assert.equal(f.element.listeners.get("compositionstart").size, 1);
  assert.equal(f.element.listeners.get("compositionend").size, 1);
  f.stop();
  assert.equal(f.element.listeners.get("beforeinput").size, 0);
  assert.equal(f.element.listeners.get("input").size, 0);
  assert.equal(f.element.listeners.get("compositionstart").size, 0);
  assert.equal(f.element.listeners.get("compositionend").size, 0);

  // Retirar la última suscripción no dispone el adaptador; permite remontarlo.
  const stopAgain = f.source.subscribeChanges(() => {});
  assert.equal(f.element.listeners.get("beforeinput").size, 1);
  stopAgain();
  assert.equal(f.element.listeners.get("input").size, 0);

  f.source.dispose();
  assert.throws(() => f.source.subscribeChanges(() => {}), /ya dispuesto/);
});

test("aísla errores lanzados por consumidores del stream", () => {
  const f = fixture();
  const received = [];
  const stopThrowing = f.source.subscribeChanges(() => { throw new Error("detached consumer"); });
  const stopHealthy = f.source.subscribeChanges(change => received.push(change));
  f.element.edit({ start: 5, end: 5, nextValue: "hello!", inputType: "insertText" });
  assert.equal(received.length, 1);
  assert.equal(f.errors[0].message, "detached consumer");
  stopThrowing();
  stopHealthy();
  f.stop();
  f.source.dispose();
});

test("rechaza inputType vacío o ajeno a inserción/eliminación sin inventar un delta", () => {
  const f = fixture("hello");
  f.element.edit({
    start: 5,
    end: 5,
    nextValue: "hello!",
    inputType: ""
  });
  assert.equal(f.changes.length, 0);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.errors[0].code, "unsupported-input-type");
  f.stop();
  f.source.dispose();
});


test("captura actualizaciones IME sucesivas como deltas consecutivos y cierra el estado de composición", () => {
  const f = fixture("abc", 2, 7);
  f.element.emitCompositionStart();
  assert.equal(f.source.getState().compositionActive, true);

  // Primera representación provisional compuesta.
  f.element.edit({
    start: 3,
    end: 3,
    nextValue: "abcに",
    inputType: "insertCompositionText",
    isComposing: true
  });
  // El IME reemplaza el texto provisional anterior por una forma candidata nueva.
  f.element.edit({
    start: 3,
    end: 4,
    nextValue: "abc日本",
    inputType: "insertCompositionText",
    isComposing: true
  });

  assert.deepEqual(f.changes, [
    {
      documentId: "chapter-1",
      sequence: 8,
      baseRevision: 2,
      start: 3,
      end: 3,
      replacement: "に",
      activityKind: "typing"
    },
    {
      documentId: "chapter-1",
      sequence: 9,
      baseRevision: 3,
      start: 3,
      end: 4,
      replacement: "日本",
      activityKind: "typing"
    }
  ]);
  assert.equal(f.source.getState().compositionActive, true);
  assert.equal(f.source.getState().documentLength, 5);

  f.element.emitCompositionEnd();
  assert.equal(f.source.getState().compositionActive, false);
  assert.equal(f.source.getState().needsResync, false);

  f.element.edit({
    start: 5,
    end: 5,
    nextValue: "abc日本!",
    inputType: "insertText"
  });
  assert.equal(f.changes[2].sequence, 10);
  assert.equal(f.changes[2].baseRevision, 4);
  f.stop();
  f.source.dispose();
});

test("rechaza insertCompositionText fuera de composición y no inventa un rango", () => {
  const f = fixture("abc");
  f.element.edit({
    start: 3,
    end: 3,
    nextValue: "abcx",
    inputType: "insertCompositionText",
    isComposing: false
  });

  assert.equal(f.changes.length, 0);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.source.getState().compositionActive, false);
  assert.equal(f.errors[0].code, "composition-state-mismatch");
  f.stop();
  f.source.dispose();
});

test("detecta una composición incompleta cuando llega otra operación antes del input final", () => {
  const f = fixture("abc");
  f.element.emitCompositionStart();
  f.element.selectionStart = 3;
  f.element.selectionEnd = 3;
  f.element.emitBeforeInput("insertCompositionText", true);
  f.element.emitCompositionEnd();

  // compositionend no invalida por sí solo el beforeinput: el input final aún puede llegar.
  assert.equal(f.changes.length, 0);
  assert.equal(f.source.getState().needsResync, false);
  assert.equal(f.source.getState().compositionActive, false);

  // Un nuevo beforeinput antes del input anterior demuestra que se perdió el emparejamiento.
  f.element.selectionStart = 3;
  f.element.selectionEnd = 3;
  f.element.emitBeforeInput("insertText", false);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.errors[0].code, "missing-input");

  // El input tardío se ignora hasta resincronizar.
  f.element.value = "abcx";
  f.element.emitInput(false);
  assert.equal(f.changes.length, 0);
  f.stop();
  f.source.dispose();
});

test("no confunde arrastrar/soltar ni yank con pegado o corrección", () => {
  const f = fixture("abcd", 0, 0);
  f.element.edit({ start: 4, end: 4, nextValue: "abcdD", inputType: "insertFromDrop" });
  f.element.edit({ start: 5, end: 5, nextValue: "abcdDY", inputType: "insertFromYank" });
  f.element.edit({ start: 1, end: 2, nextValue: "aRcdDY", inputType: "insertReplacementText" });
  assert.deepEqual(f.changes.map(change => change.activityKind), ["other", "other", "correction"]);
  assert.equal(f.source.getState().needsResync, false);
  f.stop();
  f.source.dispose();
});

test("reconstruye exactamente deltas con límites UTF-16, incluidos pares sustitutos", () => {
  const f = fixture("A😀e\u0301Z", 0, 0);
  let previous = f.element.value;
  const operations = [[2, 2, "x"], [1, 3, "🧪"], [2, 2, "\u200d"], [0, 1, "á"], [2, 4, ""], [0, 0, "😀e\u0301"]];
  for (const [start, end, replacement] of operations) {
    const nextValue = previous.slice(0, start) + replacement + previous.slice(end);
    f.element.edit({ start, end, nextValue, inputType: "insertText" });
    const change = f.changes.at(-1);
    assert.ok(change, "cada edición válida debe producir exactamente un delta");
    assert.equal(change.start, start);
    assert.equal(change.end, end);
    assert.equal(change.replacement, replacement);
    assert.equal(previous.slice(0, change.start) + change.replacement + previous.slice(change.end), nextValue);
    previous = nextValue;
  }
  assert.equal(f.changes.length, operations.length);
  assert.equal(f.source.getState().documentLength, previous.length);
  assert.equal(f.source.getState().needsResync, false);
  f.stop();
  f.source.dispose();
});

test("exige resincronización si llega otro beforeinput sin completar el input anterior", () => {
  const f = fixture("abc");
  f.element.selectionStart = 3;
  f.element.selectionEnd = 3;
  f.element.emitBeforeInput("insertText");
  f.element.selectionStart = 3;
  f.element.selectionEnd = 3;
  f.element.emitBeforeInput("insertText");
  f.element.value = "abcx";
  f.element.emitInput(false, "insertText");

  assert.equal(f.changes.length, 0);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.errors[0].code, "missing-input");
  f.stop();
  f.source.dispose();
});

test("rechaza input cuyo inputType no coincide con el beforeinput asociado", () => {
  const f = fixture("abc");
  f.element.selectionStart = 3;
  f.element.selectionEnd = 3;
  f.element.emitBeforeInput("insertText");
  f.element.value = "abcx";
  f.element.emitInput(false, "insertFromPaste");
  assert.equal(f.changes.length, 0);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.errors[0].code, "input-type-mismatch");
  f.stop();
  f.source.dispose();
});


test("acepta el input final cuando compositionend precede al input en el navegador", () => {
  const f = fixture("abc", 0, 0);
  f.element.emitCompositionStart();
  f.element.selectionStart = 3;
  f.element.selectionEnd = 3;
  f.element.emitBeforeInput("insertCompositionText", true);
  // Orden observado en algunos navegadores: compositionend antes del input final.
  f.element.value = "abc日本";
  f.element.emitCompositionEnd();
  assert.equal(f.source.getState().compositionActive, false);
  assert.equal(f.source.getState().needsResync, false);
  f.element.emitInput(false, "insertCompositionText");

  assert.equal(f.changes.length, 1);
  assert.deepEqual({
    start: f.changes[0].start,
    end: f.changes[0].end,
    replacement: f.changes[0].replacement,
    sequence: f.changes[0].sequence,
    baseRevision: f.changes[0].baseRevision
  }, {
    start: 3,
    end: 3,
    replacement: "日本",
    sequence: 1,
    baseRevision: 0
  });
  assert.equal(f.source.getState().needsResync, false);
  f.stop();
  f.source.dispose();
});


test("detecta mutación externa de igual longitud fuera del rango anunciado", () => {
  const f = fixture("abcde", 0, 0);
  f.element.selectionStart = 2;
  f.element.selectionEnd = 2;
  f.element.emitBeforeInput("insertText");
  // Simula una mutación programática concurrente en otra posición, sin cambiar longitud.
  f.element.value = "aZcde";

  f.element.emitInput(false, "insertText");

  assert.equal(f.changes.length, 0);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.errors[0].code, "inconsistent-length");
  assert.match(f.errors[0].message, /fuera del rango/);
  f.stop();
  f.source.dispose();
});

test("acepta inserción legítima cuando hay caracteres repetidos alrededor del cursor", () => {
  const f = fixture("aaaa", 0, 0);
  f.element.edit({
    start: 2,
    end: 2,
    nextValue: "aaXaa",
    inputType: "insertText"
  });

  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].start, 2);
  assert.equal(f.changes[0].end, 2);
  assert.equal(f.changes[0].replacement, "X");
  assert.equal(f.source.getState().needsResync, false);
  f.stop();
  f.source.dispose();
});

test("no clasifica como corrección una sustitución de selección mediante insertText", () => {
  const f = fixture("abcd", 0, 0);

  // El autor selecciona texto y escribe encima: el navegador informa insertText.
  f.element.edit({
    start: 1,
    end: 3,
    nextValue: "aXd",
    inputType: "insertText"
  });
  // Solo el inputType específico insertReplacementText activa la categoría correction.
  f.element.edit({
    start: 1,
    end: 2,
    nextValue: "aYd",
    inputType: "insertReplacementText"
  });
  // Los mecanismos de inserción no reconocidos no se elevan a escritura manual.
  f.element.edit({
    start: 1,
    end: 2,
    nextValue: "aZd",
    inputType: "insertFromDictation"
  });

  assert.deepEqual(f.changes.map(change => change.activityKind), [
    "typing",
    "correction",
    "other"
  ]);
  assert.equal(f.source.getState().needsResync, false);
  f.stop();
  f.source.dispose();
});
