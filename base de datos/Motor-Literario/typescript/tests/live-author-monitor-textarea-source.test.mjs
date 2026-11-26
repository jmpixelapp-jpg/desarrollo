import test from "node:test";
import assert from "node:assert/strict";
const monitorModule = await import("../dist-monitor/live-author-monitor.js")
  .catch(() => import("../dist/motor-literario.js"));
const { LiveAuthorMonitorTextAreaSource } = monitorModule;

class FakeEventTarget {
  listeners = new Map();
  defaultView;
  hidden = false;

  addEventListener(type, listener) {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  listenerCount(type) { return this.listeners.get(type)?.size ?? 0; }
}

class FakeTextArea extends FakeEventTarget {
  value;
  selectionStart = 0;
  selectionEnd = 0;
  ownerDocument;

  constructor(value) {
    super();
    this.value = value;
    this.ownerDocument = new FakeEventTarget();
    this.ownerDocument.defaultView = new FakeEventTarget();
  }

  emitBeforeInput(inputType, isComposing = false, isTrusted = true, data = null) {
    const event = { defaultPrevented: false, inputType, isComposing, isTrusted, data };
    for (const listener of [...(this.listeners.get("beforeinput") ?? [])]) listener(event);
    return event;
  }

  emitInput(isComposing = false, inputType = "", isTrusted = true, data = null) {
    const event = { inputType, isComposing, isTrusted, data };
    for (const listener of [...(this.listeners.get("input") ?? [])]) listener(event);
  }

  emitCompositionStart() {
    for (const listener of [...(this.listeners.get("compositionstart") ?? [])]) listener({ isTrusted: true });
  }

  emitCompositionEnd() {
    for (const listener of [...(this.listeners.get("compositionend") ?? [])]) listener({ isTrusted: true });
  }

  emitBlur() { this.emit("blur"); }

  edit({ start, end, nextValue, inputType = "insertText", isComposing = false, data = null, inputData = null }) {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.emitBeforeInput(inputType, isComposing, true, data);
    this.value = nextValue;
    this.emitInput(isComposing, inputType, true, inputData);
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
    pendingInput: false,
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

test("libera after-dispatch un beforeinput cancelado por un listener posterior", async () => {
  const f = fixture("abc", 0, 0);
  const cancelLater = event => {
    event.defaultPrevented = true;
    // Simula el caso reentrante: el mismo listener que cancela cambia el foco
    // antes de que termine la propagación de beforeinput.
    f.element.emitBlur();
  };
  f.element.addEventListener("beforeinput", cancelLater);
  f.element.selectionStart = 3;
  f.element.selectionEnd = 3;

  const observed = f.element.emitBeforeInput("insertText", false, true, "x");
  assert.equal(observed.defaultPrevented, true);
  assert.ok(f.source.pendingInput,
    "el adaptador registra provisionalmente antes de que se ejecuten los listeners posteriores");

  // La microtarea comprueba el resultado final de la propagación síncrona.
  await Promise.resolve();
  assert.equal(f.source.pendingInput, undefined,
    "un evento cancelado no debe quedarse esperando un input que el navegador no emitirá");
  assert.equal(f.source.getState().needsResync, false);
  assert.equal(f.changes.length, 0);
  assert.equal(f.errors.length, 0);

  f.element.emitBlur();
  assert.equal(f.source.getState().needsResync, false,
    "el blur posterior no debe confundir una cancelación voluntaria con una operación incompleta");

  f.element.removeEventListener("beforeinput", cancelLater);
  f.element.edit({
    start: 3,
    end: 3,
    nextValue: "abcx",
    inputType: "insertText",
    data: "x"
  });
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].replacement, "x");
  assert.equal(f.source.getState().needsResync, false);

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

test("desmonta listeners y exige snapshot autoritativo tras un intervalo sin observación", () => {
  const f = fixture();
  assert.equal(f.element.listeners.get("beforeinput").size, 1);
  assert.equal(f.element.listeners.get("input").size, 1);
  assert.equal(f.element.listeners.get("blur").size, 1);
  assert.equal(f.element.listeners.get("compositionstart").size, 1);
  assert.equal(f.element.listeners.get("compositionend").size, 1);

  f.stop();
  assert.equal(f.element.listeners.get("beforeinput").size, 0);
  assert.equal(f.element.listeners.get("input").size, 0);
  assert.equal(f.element.listeners.get("blur").size, 0);
  assert.equal(f.element.listeners.get("compositionstart").size, 0);
  assert.equal(f.element.listeners.get("compositionend").size, 0);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.errors.at(-1).code, "resync-required");
  assert.equal(f.source.previousText, "",
    "la copia temporal se libera cuando termina la última suscripción");

  // Simula una edición no observada y de igual longitud durante el intervalo.
  f.element.value = "hXllo";
  assert.throws(() => f.source.resynchronize({
    documentId: "chapter-1",
    text: "hXllo",
    revision: 5,
    sequence: 10
  }), error => error.code === "resync-required",
  "no debe reanudarse con cero observadores: la captura abriría otra ventana ciega");

  const stopAgain = f.source.subscribeChanges(change => f.changes.push(change));
  assert.equal(f.element.listeners.get("beforeinput").size, 1);
  assert.equal(f.element.listeners.get("input").size, 1);
  assert.equal(f.source.getState().needsResync, true);

  f.element.edit({
    start: 5,
    end: 5,
    nextValue: "hXllo!",
    inputType: "insertText",
    data: "!"
  });
  assert.equal(f.changes.length, 0,
    "la nueva suscripción no debe aceptar cambios antes del snapshot autoritativo");

  const recovered = f.source.resynchronize({
    documentId: "chapter-1",
    text: "hXllo!",
    revision: 5,
    sequence: 10
  });
  assert.equal(recovered.needsResync, false);

  f.element.edit({
    start: 6,
    end: 6,
    nextValue: "hXllo!?",
    inputType: "insertText",
    data: "?"
  });
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].sequence, 11);
  assert.equal(f.changes[0].baseRevision, 5);

  stopAgain();
  assert.equal(f.element.ownerDocument.listenerCount("freeze"), 0);
  assert.equal(f.element.ownerDocument.listenerCount("visibilitychange"), 0);
  assert.equal(f.element.ownerDocument.defaultView.listenerCount("pagehide"), 0);
  f.source.dispose();
  assert.throws(() => f.source.subscribeChanges(() => {}), /ya dispuesto/);
});

test("visibilitychange oculta suspende una composición abierta sin reanudar al volver", () => {
  const f = fixture("abc", 0, 0);
  const documentTarget = f.element.ownerDocument;

  f.element.emitCompositionStart();
  documentTarget.hidden = true;
  documentTarget.emit("visibilitychange");

  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.source.getState().compositionActive, false);
  assert.equal(f.source.previousText, "");
  assert.equal(f.errors[0].code, "resync-required");

  documentTarget.emit("visibilitychange");
  assert.equal(f.errors.length, 1, "eventos visibilitychange repetidos no duplican el error");

  documentTarget.hidden = false;
  documentTarget.emit("visibilitychange");
  assert.equal(f.source.getState().needsResync, true,
    "volver a mostrar la pestaña no demuestra que la composición se completó");

  f.element.value = "abc日本";
  const recovered = f.source.resynchronize({
    documentId: "chapter-1",
    text: "abc日本",
    revision: 3,
    sequence: 4
  });
  assert.equal(recovered.needsResync, false);
  f.element.edit({
    start: 5,
    end: 5,
    nextValue: "abc日本!",
    inputType: "insertText",
    data: "!"
  });
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].sequence, 5);

  f.stop();
  assert.equal(documentTarget.listenerCount("visibilitychange"), 0);
  f.source.dispose();
});

test("blur suspende operaciones incompletas pero no interrumpe un editor inactivo", async () => {
  const idle = fixture("abc", 0, 0);
  idle.element.emitBlur();
  assert.equal(idle.source.getState().needsResync, false,
    "perder el foco sin una operación abierta no rompe la continuidad");
  idle.stop();
  idle.source.dispose();

  const composing = fixture("abc", 0, 0);
  composing.element.emitCompositionStart();
  composing.element.emitBlur();
  assert.equal(composing.source.getState().needsResync, true);
  assert.equal(composing.source.getState().compositionActive, false);
  assert.equal(composing.source.previousText, "");
  assert.equal(composing.errors[0].code, "resync-required");
  composing.stop();
  composing.source.dispose();

  const pending = fixture("abc", 0, 0);
  pending.element.selectionStart = 3;
  pending.element.selectionEnd = 3;
  pending.element.emitBeforeInput("insertText");
  pending.element.emitBlur();
  await Promise.resolve();
  assert.equal(pending.source.getState().needsResync, false,
    "blur no debe adelantarse a un input que el navegador puede entregar en una tarea posterior");
  assert.equal(pending.source.getState().pendingInput, true);
  assert.equal(pending.errors.length, 0);

  // El input tardío completa correctamente el par aunque el textarea ya perdió foco.
  pending.element.value = "abcx";
  pending.element.emitInput(false, "insertText", true, "x");
  assert.equal(pending.changes.length, 1);
  assert.equal(pending.changes[0].replacement, "x");
  assert.equal(pending.source.getState().pendingInput, false);
  assert.equal(pending.source.getState().needsResync, false);
  pending.stop();
  pending.source.dispose();

  // Si no llega input, un nuevo beforeinput confirma la discontinuidad.
  const lost = fixture("abc", 0, 0);
  lost.element.selectionStart = 3;
  lost.element.selectionEnd = 3;
  lost.element.emitBeforeInput("insertText");
  lost.element.emitBlur();
  await Promise.resolve();
  assert.equal(lost.source.getState().pendingInput, true);
  lost.element.selectionStart = 3;
  lost.element.selectionEnd = 3;
  lost.element.emitBeforeInput("insertText");
  assert.equal(lost.source.getState().needsResync, true);
  assert.equal(lost.source.getState().pendingInput, false);
  assert.equal(lost.errors[0].code, "missing-input");
  lost.stop();
  lost.source.dispose();
});

test("pagehide y freeze suspenden la captura y exigen snapshot tras volver", () => {
  const f = fixture("abc", 0, 0);
  const documentTarget = f.element.ownerDocument;
  const viewTarget = documentTarget.defaultView;

  assert.equal(documentTarget.listenerCount("freeze"), 1);
  assert.equal(documentTarget.listenerCount("visibilitychange"), 1);
  assert.equal(viewTarget.listenerCount("pagehide"), 1);

  // Simula una composición abierta cuando la página entra en BFCache.
  f.element.emitCompositionStart();
  assert.equal(f.source.getState().compositionActive, true);
  viewTarget.emit("pagehide", { persisted: true });

  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.source.getState().compositionActive, false);
  assert.equal(f.source.previousText, "");
  assert.equal(f.errors[0].code, "resync-required");

  // freeze duplicado no emite diagnósticos repetidos ni reanuda la fuente.
  documentTarget.emit("freeze");
  viewTarget.emit("pageshow", { persisted: true });
  documentTarget.emit("resume");
  assert.equal(f.errors.length, 1);
  assert.equal(f.source.getState().needsResync, true,
    "pageshow/resume solo restauran el contexto de página, no la continuidad del documento");

  f.element.value = "abc日本";
  f.element.selectionStart = 5;
  f.element.selectionEnd = 5;
  f.element.emitBeforeInput("insertText");
  f.element.value = "abc日本!";
  f.element.emitInput(false, "insertText");
  assert.equal(f.changes.length, 0,
    "la página restaurada no captura hasta recibir un snapshot autoritativo");

  const recovered = f.source.resynchronize({
    documentId: "chapter-1",
    text: "abc日本!",
    revision: 7,
    sequence: 12
  });
  assert.equal(recovered.needsResync, false);

  f.element.edit({
    start: 6,
    end: 6,
    nextValue: "abc日本!?",
    inputType: "insertText",
    data: "?"
  });
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].sequence, 13);
  assert.equal(f.changes[0].baseRevision, 7);

  f.stop();
  assert.equal(documentTarget.listenerCount("freeze"), 0);
  assert.equal(documentTarget.listenerCount("visibilitychange"), 0);
  assert.equal(viewTarget.listenerCount("pagehide"), 0);
  f.source.dispose();
});

test("no inicia la primera suscripción si el textarea ya difiere del snapshot", () => {
  const element = new FakeTextArea("abc");
  const errors = [];
  const source = new LiveAuthorMonitorTextAreaSource({
    element,
    initialSnapshot: {
      documentId: "chapter-1",
      text: "abc",
      revision: 0,
      sequence: 0
    },
    onError: error => errors.push(error)
  });

  // Mutación programática de igual longitud antes de conectar el observador.
  element.value = "aZc";
  const stop = source.subscribeChanges(() => {});

  assert.equal(source.getState().needsResync, true);
  assert.equal(errors[0].code, "resync-required");
  assert.equal(source.previousText, "");
  stop();
  source.dispose();
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
      activityKind: "composition"
    },
    {
      documentId: "chapter-1",
      sequence: 9,
      baseRevision: 3,
      start: 3,
      end: 4,
      replacement: "日本",
      activityKind: "composition"
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
  f.element.emitBeforeInput("insertCompositionText", true, true, "日本");
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


test("rechaza una mutación de igual longitud dentro de la selección antes de capturar beforeinput", () => {
  const f = fixture("abcde", 0, 0);

  // El texto cambia en el mismo rango que el autor va a reemplazar: una
  // comprobación que solo compare prefijo/sufijo al final no basta.
  f.element.value = "aZcde";
  f.element.edit({
    start: 1,
    end: 2,
    nextValue: "aYcde",
    inputType: "insertText",
    data: "Y"
  });

  assert.equal(f.changes.length, 0);
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.errors[0].code, "resync-required");
  assert.match(f.errors[0].message, /fuera de una secuencia observada completa/);
  assert.equal(f.source.previousText, "");
  f.stop();
  f.source.dispose();
});

test("contrasta beforeinput.data con el reemplazo real y detecta mutaciones dentro de la selección", () => {
  const accepted = fixture("abcd", 0, 0);
  accepted.element.edit({
    start: 1,
    end: 3,
    nextValue: "aXYd",
    inputType: "insertText",
    data: "XY"
  });
  assert.equal(accepted.changes.length, 1);
  assert.equal(accepted.changes[0].replacement, "XY");
  assert.equal(accepted.source.getState().needsResync, false);
  accepted.stop();
  accepted.source.dispose();

  // Si beforeinput.data no está disponible, input.data puede aportar la
  // comprobación del contenido sin inventar el payload esperado.
  const inputOnly = fixture("abcd", 0, 0);
  inputOnly.element.edit({
    start: 1,
    end: 3,
    nextValue: "aXYd",
    inputType: "insertText",
    inputData: "XY"
  });
  assert.equal(inputOnly.changes.length, 1);
  assert.equal(inputOnly.source.getState().needsResync, false);
  inputOnly.stop();
  inputOnly.source.dispose();

  // Las dos declaraciones deben concordar, incluso si el valor del textarea
  // coincide con beforeinput.data.
  const contradictoryEvents = fixture("abcd", 0, 0);
  contradictoryEvents.element.selectionStart = 1;
  contradictoryEvents.element.selectionEnd = 3;
  contradictoryEvents.element.emitBeforeInput("insertText", false, true, "XY");
  contradictoryEvents.element.value = "aXYd";
  contradictoryEvents.element.emitInput(false, "insertText", true, "XZ");
  assert.equal(contradictoryEvents.changes.length, 0);
  assert.equal(contradictoryEvents.source.getState().needsResync, true);
  assert.equal(contradictoryEvents.errors[0].code, "input-data-mismatch");
  assert.match(contradictoryEvents.errors[0].message, /beforeinput e input no coinciden/);
  contradictoryEvents.stop();
  contradictoryEvents.source.dispose();

  // input.data también protege cuando beforeinput.data es null.
  const inputOnlyMismatch = fixture("abcd", 0, 0);
  inputOnlyMismatch.element.selectionStart = 1;
  inputOnlyMismatch.element.selectionEnd = 3;
  inputOnlyMismatch.element.emitBeforeInput("insertText", false, true, null);
  inputOnlyMismatch.element.value = "aZZd";
  inputOnlyMismatch.element.emitInput(false, "insertText", true, "XY");
  assert.equal(inputOnlyMismatch.changes.length, 0);
  assert.equal(inputOnlyMismatch.source.getState().needsResync, true);
  assert.equal(inputOnlyMismatch.errors[0].code, "input-data-mismatch");
  inputOnlyMismatch.stop();
  inputOnlyMismatch.source.dispose();

  const rejected = fixture("abcd", 0, 0);
  rejected.element.selectionStart = 1;
  rejected.element.selectionEnd = 3;
  rejected.element.emitBeforeInput("insertText", false, true, "XY");
  // Mutación externa dentro del rango seleccionado: misma longitud, prefijo y
  // sufijo intactos, por lo que solo la comparación con beforeinput.data la detecta.
  rejected.element.value = "aZZd";
  rejected.element.emitInput(false, "insertText");

  assert.equal(rejected.changes.length, 0);
  assert.equal(rejected.source.getState().needsResync, true);
  assert.equal(rejected.errors[0].code, "input-data-mismatch");
  assert.match(rejected.errors[0].message, /no coincide/);
  assert.doesNotMatch(rejected.errors[0].message, /XY|ZZ/,
    "el diagnóstico no debe repetir el texto manuscrito ni el payload esperado");
  assert.equal(rejected.source.pendingInput, undefined,
    "el dato esperado debe liberarse al suspender la captura");
  assert.equal(rejected.source.previousText, "",
    "el snapshot del manuscrito debe liberarse al suspender la captura");
  rejected.stop();
  rejected.source.dispose();
});

test("rechaza eventos de edición sintéticos aunque imiten inputType y cambien el valor", () => {
  const beforeSynthetic = fixture("abc");
  beforeSynthetic.element.selectionStart = 3;
  beforeSynthetic.element.selectionEnd = 3;
  beforeSynthetic.element.emitBeforeInput("insertText", false, false);
  beforeSynthetic.element.value = "abcx";
  beforeSynthetic.element.emitInput(false, "insertText", false);

  assert.equal(beforeSynthetic.changes.length, 0);
  assert.equal(beforeSynthetic.source.getState().needsResync, true);
  assert.equal(beforeSynthetic.errors[0].code, "untrusted-event");
  beforeSynthetic.stop();
  beforeSynthetic.source.dispose();

  const inputSynthetic = fixture("abc");
  inputSynthetic.element.selectionStart = 3;
  inputSynthetic.element.selectionEnd = 3;
  inputSynthetic.element.emitBeforeInput("insertText");
  inputSynthetic.element.value = "abcx";
  inputSynthetic.element.emitInput(false, "insertText", false);

  assert.equal(inputSynthetic.changes.length, 0);
  assert.equal(inputSynthetic.source.getState().needsResync, true);
  assert.equal(inputSynthetic.errors[0].code, "untrusted-event");
  inputSynthetic.stop();
  inputSynthetic.source.dispose();
});

test("una misma discontinuidad solicita resincronización una sola vez", () => {
  const f = fixture("PRIVATE_TEXT_FOR_RESYNC");
  f.source.requireResynchronization("first reason");
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].code, "resync-required");
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.source.previousText, "");

  // El binding puede repetir la solicitud durante el mismo rechazo permanente.
  f.source.requireResynchronization("duplicate reason");
  f.element.emitBlur();
  f.element.ownerDocument.emit("freeze");
  f.element.ownerDocument.defaultView.emit("pagehide");

  assert.equal(f.errors.length, 1,
    "un solo incidente debe producir un diagnóstico y una limpieza");
  assert.equal(f.source.previousText, "");
  assert.equal(f.source.pendingInput, undefined);
  f.stop();
  f.source.dispose();
});

test("libera la copia temporal del manuscrito al suspender y al disponer la captura", () => {
  const f = fixture("PRIVATE_MANUSCRIPT_SENTINEL");
  f.source.requireResynchronization("test privacy release");
  assert.equal(f.source.getState().needsResync, true);
  assert.equal(f.source.previousText, "");

  // Solo un snapshot autoritativo válido vuelve a introducir el texto efímero.
  const recovered = f.source.resynchronize({
    documentId: "chapter-1",
    text: "PRIVATE_MANUSCRIPT_SENTINEL",
    revision: 5,
    sequence: 10
  });
  assert.equal(recovered.needsResync, false);
  assert.equal(f.source.previousText, "PRIVATE_MANUSCRIPT_SENTINEL");

  f.source.dispose();
  assert.equal(f.source.previousText, "");
  f.stop();
});
