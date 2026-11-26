import { LiveAuthorMonitorTextAreaSource } from "../../src/live-author-monitor-textarea-source.ts";

const editor = document.querySelector("#editor");
const startButton = document.querySelector("#start");
const exportButton = document.querySelector("#export");
const statusNode = document.querySelector("#status");
const metricsNode = document.querySelector("#metrics");
const traceNode = document.querySelector("#trace");

if (!(editor instanceof HTMLTextAreaElement) ||
    !(startButton instanceof HTMLButtonElement) ||
    !(exportButton instanceof HTMLButtonElement) ||
    !(statusNode instanceof HTMLElement) ||
    !(metricsNode instanceof HTMLElement) ||
    !(traceNode instanceof HTMLElement)) {
  throw new Error("No se pudo inicializar la página de prueba IME.");
}

const MAX_TRACE_ITEMS = 2_000;
const events = [];
const deltas = [];
let eventCountTotal = 0;
let droppedEventCount = 0;
let source;
let baselineLengthUtf16 = 0;
let startedAt;
let disposed = false;

function safeDataLength(event) {
  return typeof event.data === "string" ? event.data.length : null;
}

function recordEvent(event) {
  eventCountTotal += 1;
  const target = event.currentTarget;
  const entry = {
    index: eventCountTotal,
    atMs: Number(performance.now().toFixed(3)),
    type: event.type,
    inputType: typeof event.inputType === "string" ? event.inputType : null,
    isTrusted: event.isTrusted === true,
    isComposing: typeof event.isComposing === "boolean" ? event.isComposing : null,
    dataLengthUtf16: safeDataLength(event),
    selectionStart: target instanceof HTMLTextAreaElement ? target.selectionStart : null,
    selectionEnd: target instanceof HTMLTextAreaElement ? target.selectionEnd : null
  };
  if (events.length === MAX_TRACE_ITEMS) {
    events.shift();
    droppedEventCount += 1;
  }
  events.push(entry);
  render();
}

function recordError(error) {
  eventCountTotal += 1;
  const entry = {
    index: eventCountTotal,
    atMs: Number(performance.now().toFixed(3)),
    type: "monitor-error",
    code: error.code
  };
  if (events.length === MAX_TRACE_ITEMS) {
    events.shift();
    droppedEventCount += 1;
  }
  events.push(entry);
  render();
}

function render() {
  const state = source?.getState();
  const compositionBeforeInputCount = events.filter(entry =>
    entry.type === "beforeinput" && entry.inputType === "insertCompositionText"
  ).length;
  const compositionInputCount = events.filter(entry =>
    entry.type === "input" && entry.inputType === "insertCompositionText"
  ).length;
  const compositionStarts = events.filter(entry => entry.type === "compositionstart").length;
  const compositionUpdates = events.filter(entry => entry.type === "compositionupdate").length;
  const compositionEnds = events.filter(entry => entry.type === "compositionend").length;
  const errorCodes = events.filter(entry => entry.type === "monitor-error").map(entry => entry.code);
  metricsNode.textContent = JSON.stringify({
    elapsedMs: startedAt === undefined ? 0 : Math.round(performance.now() - startedAt),
    baselineLengthUtf16,
    currentLengthUtf16: editor.value.length,
    totalEventCount: eventCountTotal,
    retainedEventCount: events.length,
    droppedOldestEvents: droppedEventCount,
    compositionStarts,
    compositionUpdates,
    compositionEnds,
    compositionBeforeInputCount,
    compositionInputCount,
    compositionDeltas: deltas.filter(delta => delta.activityKind === "composition").length,
    typingDeltas: deltas.filter(delta => delta.activityKind === "typing").length,
    errorCodes,
    state: state ? {
      revision: state.revision,
      sequence: state.sequence,
      documentLength: state.documentLength,
      compositionActive: state.compositionActive,
      needsResync: state.needsResync
    } : null
  }, null, 2);
  traceNode.textContent = events.slice(-80).map(entry => JSON.stringify(entry)).join("\n") ||
    "Aún no hay eventos registrados.";
  statusNode.textContent = !source
    ? "Captura sin iniciar."
    : state?.needsResync
      ? "CAPTURA SUSPENDIDA: se necesita resincronización. Exporta la traza."
      : state?.compositionActive
        ? "Composición activa: cambia candidatos o confirma/cancela el IME."
        : "Captura activa. Prueba el IME y revisa el resultado final.";
}

startButton.addEventListener("click", () => {
  if (source) return;
  baselineLengthUtf16 = editor.value.length;
  startedAt = performance.now();
  source = new LiveAuthorMonitorTextAreaSource({
    element: editor,
    initialSnapshot: {
      documentId: "manual-ime-test",
      text: editor.value,
      revision: 0,
      sequence: 0
    },
    onError: recordError
  });
  source.subscribeChanges(change => {
    deltas.push({
      sequence: change.sequence,
      baseRevision: change.baseRevision,
      start: change.start,
      end: change.end,
      replacementLengthUtf16: change.replacement.length,
      activityKind: change.activityKind ?? "other"
    });
    render();
  });
  for (const type of [
    "compositionstart", "compositionupdate", "compositionend", "beforeinput", "input"
  ]) {
    editor.addEventListener(type, recordEvent);
  }
  startButton.disabled = true;
  exportButton.disabled = false;
  render();
});

exportButton.addEventListener("click", () => {
  if (!source || disposed) return;
  const report = {
    format: "live-author-monitor-ime-trace-v1",
    exportedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startedAt),
    environment: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language
    },
    privacy: {
      manuscriptContentIncluded: false,
      inputEventDataIncluded: false,
      keystrokesIncluded: false,
      localOnlyDownload: true
    },
    baselineLengthUtf16,
    finalLengthUtf16: editor.value.length,
    eventCountTotal,
    droppedEventCount,
    events,
    deltas,
    state: source.getState()
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "live-author-monitor-ime-trace.json";
  link.click();
  URL.revokeObjectURL(url);
});

window.addEventListener("pagehide", () => {
  if (source && !disposed) {
    disposed = true;
    source.dispose();
  }
});

render();
