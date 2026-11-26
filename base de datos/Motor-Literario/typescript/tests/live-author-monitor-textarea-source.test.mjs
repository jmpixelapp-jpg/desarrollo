import test from "node:test";
import assert from "node:assert/strict";
import { LiveAuthorMonitorTextAreaSource } from "../dist/motor-literario.js";

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

  emitInput(isComposing = false) {
    const event = { inputType: "", isComposing };
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
      replacement: "!"
    },
    {
      documentId: "chapter-1",
      sequence: 11,
      baseRevision: 5,
      start: 1,
      end: 3,
      replacement: "X"
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
      replacement: "に"
    },
    {
      documentId: "chapter-1",
      sequence: 9,
      baseRevision: 3,
      start: 3,
      end: 4,
      replacement: "日本"
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

test("exige resincronización si la composición termina sin el input asociado", () => {
  const f = fixture("abc");
  f.element.emitCompositionStart();
  f.element.selectionStart = 3;
  f.element.selectionEnd = 3;
  f.element.emitBeforeInput("insertCompositionText", true);
  f.element.emitCompositionEnd();

  assert.equal(f.changes.length, 0);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.source.getState().compositionActive, false);
  assert.equal(f.errors[0].code, "composition-state-mismatch");

  // El input tardío se ignora hasta resincronizar.
  f.element.value = "abcx";
  f.element.emitInput(false);
  assert.equal(f.changes.length, 0);
  f.stop();
  f.source.dispose();
});
