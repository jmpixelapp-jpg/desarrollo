import { LiveAuthorMonitorTextAreaSource } from "../../src/live-author-monitor-textarea-source.ts";
import { LiveAuthorMonitorImePairing } from "./live-author-monitor-ime-pairing.js";

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
let traceEntryCount = 0;
let droppedEventCount = 0;
let droppedDeltaCount = 0;
let source;
let baselineLengthUtf16 = 0;
let startedAt;
let disposed = false;
const inputPairing = new LiveAuthorMonitorImePairing();

const eventCounters = {
  beforeInputCount: 0,
  inputCount: 0,
  compositionStartCount: 0,
  compositionUpdateCount: 0,
  compositionEndCount: 0,
  compositionBeforeInputCount: 0,
  compositionInputCount: 0,
  trustedEventCount: 0,
  untrustedEventCount: 0,
  monitorErrorCount: 0
};
const deltaCounters = {
  total: 0,
  composition: 0,
  typing: 0,
  paste: 0,
  deletion: 0,
  correction: 0,
  undo: 0,
  redo: 0,
  other: 0
};
const errorCodeCounts = Object.create(null);
function safeDataLength(event) {
  return typeof event.data === "string" ? event.data.length : null;
}

function appendTraceEntry(entry) {
  if (events.length === MAX_TRACE_ITEMS) {
    events.shift();
    droppedEventCount += 1;
  }
  events.push(entry);
}

function recordEvent(event) {
  traceEntryCount += 1;
  if (event.isTrusted === true) eventCounters.trustedEventCount += 1;
  else eventCounters.untrustedEventCount += 1;

  const target = event.currentTarget;
  const entry = {
    index: traceEntryCount,
    atMs: Number(performance.now().toFixed(3)),
    type: event.type,
    inputType: typeof event.inputType === "string" ? event.inputType : null,
    isTrusted: event.isTrusted === true,
    isComposing: typeof event.isComposing === "boolean" ? event.isComposing : null,
    cancelable: typeof event.cancelable === "boolean" ? event.cancelable : null,
    defaultPrevented: typeof event.defaultPrevented === "boolean" ? event.defaultPrevented : null,
    dataLengthUtf16: safeDataLength(event),
    valueLengthUtf16: target instanceof HTMLTextAreaElement ? target.value.length : null,
    selectionStart: target instanceof HTMLTextAreaElement ? target.selectionStart : null,
    selectionEnd: target instanceof HTMLTextAreaElement ? target.selectionEnd : null
  };

  if (event.type === "compositionstart") eventCounters.compositionStartCount += 1;
  else if (event.type === "compositionupdate") eventCounters.compositionUpdateCount += 1;
  else if (event.type === "compositionend") eventCounters.compositionEndCount += 1;

  if (entry.type === "beforeinput") inputPairing.recordBeforeInput(entry, event);
  else if (entry.type === "input") inputPairing.recordInput(entry, event);
  appendTraceEntry(entry);
  render();
}

function recordError(error) {
  traceEntryCount += 1;
  eventCounters.monitorErrorCount += 1;
  errorCodeCounts[error.code] = (errorCodeCounts[error.code] ?? 0) + 1;
  inputPairing.interrupt("monitor-error-before-input");
  appendTraceEntry({
    index: traceEntryCount,
    atMs: Number(performance.now().toFixed(3)),
    type: "monitor-error",
    code: error.code
  });
  render();
}

function currentPairingSummary() {
  return inputPairing.snapshot();
}

function render() {
  const state = source?.getState();
  metricsNode.textContent = JSON.stringify({
    elapsedMs: startedAt === undefined ? 0 : Math.round(performance.now() - startedAt),
    baselineLengthUtf16,
    currentLengthUtf16: editor.value.length,
    traceEntryCount,
    retainedEventCount: events.length,
    droppedOldestEvents: droppedEventCount,
    droppedOldestDeltas: droppedDeltaCount,
    eventCounters,
    deltaCounters,
    pairing: currentPairingSummary(),
    errorCodeCounts,
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
    if (deltas.length === MAX_TRACE_ITEMS) {
      deltas.shift();
      droppedDeltaCount += 1;
    }
    deltaCounters.total += 1;
    const kind = change.activityKind ?? "other";
    if (Object.prototype.hasOwnProperty.call(deltaCounters, kind) && kind !== "total") {
      deltaCounters[kind] += 1;
    } else {
      deltaCounters.other += 1;
    }
    deltas.push({
      sequence: change.sequence,
      baseRevision: change.baseRevision,
      start: change.start,
      end: change.end,
      replacementLengthUtf16: change.replacement.length,
      activityKind: kind
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
    format: "live-author-monitor-ime-trace-v2",
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
    traceEntryCount,
    retainedEventCount: events.length,
    droppedEventCount,
    totalDeltaCount: deltaCounters.total,
    droppedDeltaCount,
    eventCounters,
    deltaCounters,
    pairing: currentPairingSummary(),
    errorCodeCounts,
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
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
});

window.addEventListener("pagehide", () => {
  if (source && !disposed) {
    disposed = true;
    source.dispose();
  }
  inputPairing.dispose();
});

render();
