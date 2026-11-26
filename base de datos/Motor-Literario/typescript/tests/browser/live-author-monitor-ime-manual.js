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
let traceEntryCount = 0;
let droppedEventCount = 0;
let droppedDeltaCount = 0;
let source;
let baselineLengthUtf16 = 0;
let startedAt;
let disposed = false;
let beforeInputSequence = 0;
let pendingBeforeInput;

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
const pairingCounters = {
  pairedInputCount: 0,
  pairedWithoutInputTypeCount: 0,
  unmatchedBeforeInputCount: 0,
  orphanInputCount: 0,
  inputTypeMismatchCount: 0,
  defaultPreventedBeforeInputCount: 0,
  inputDataMatchCount: 0,
  inputDataMismatchCount: 0,
  inputDataOneSidedCount: 0,
  inputDataUnavailableCount: 0
};

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

function correlateInputEvent(entry, event) {
  if (entry.type === "beforeinput") {
    eventCounters.beforeInputCount += 1;
    if (entry.inputType === "insertCompositionText") {
      eventCounters.compositionBeforeInputCount += 1;
    }
    if (pendingBeforeInput) {
      pairingCounters.unmatchedBeforeInputCount += 1;
      pendingBeforeInput.entry.pairStatus = "superseded-by-next-beforeinput";
      pendingBeforeInput.inputData = null;
    }

    const pairId = ++beforeInputSequence;
    entry.pairId = pairId;
    if (entry.defaultPrevented === true) {
      entry.pairStatus = "default-prevented";
      entry.dataComparison = "not-applicable";
      pairingCounters.defaultPreventedBeforeInputCount += 1;
      pendingBeforeInput = undefined;
    } else {
      entry.pairStatus = "awaiting-input";
      pendingBeforeInput = {
        pairId,
        inputType: entry.inputType,
        inputData: typeof event.data === "string" ? event.data : null,
        entry
      };
    }
    return;
  }

  if (entry.type !== "input") return;
  eventCounters.inputCount += 1;
  if (entry.inputType === "insertCompositionText") {
    eventCounters.compositionInputCount += 1;
  }
  if (!pendingBeforeInput) {
    pairingCounters.orphanInputCount += 1;
    entry.pairStatus = "orphan-input";
    return;
  }

  const pending = pendingBeforeInput;
  entry.pairId = pending.pairId;
  pending.entry.pairStatus = "paired";
  const hasCurrentInputType = typeof entry.inputType === "string" && entry.inputType.length > 0;
  const hasPreviousInputType = typeof pending.inputType === "string" && pending.inputType.length > 0;
  if (hasCurrentInputType && hasPreviousInputType && entry.inputType !== pending.inputType) {
    entry.pairStatus = "inputtype-mismatch";
    pending.entry.pairStatus = "inputtype-mismatch";
    pairingCounters.inputTypeMismatchCount += 1;
  } else {
    pairingCounters.pairedInputCount += 1;
    if (!hasCurrentInputType) {
      pairingCounters.pairedWithoutInputTypeCount += 1;
      entry.pairStatus = "paired-inputtype-unavailable";
      pending.entry.pairStatus = "paired-inputtype-unavailable";
    } else {
      entry.pairStatus = "paired";
      pending.entry.pairStatus = "paired";
    }
  }

  // Se comparan los valores exactos en memoria, pero solo se exporta el
  // resultado de la comparación. Los strings se liberan al cerrar el par.
  const inputData = typeof event.data === "string" ? event.data : null;
  if (pending.inputData !== null && inputData !== null) {
    const matches = pending.inputData === inputData;
    entry.dataComparison = matches ? "match" : "mismatch";
    pending.entry.dataComparison = entry.dataComparison;
    if (matches) pairingCounters.inputDataMatchCount += 1;
    else pairingCounters.inputDataMismatchCount += 1;
  } else if (pending.inputData !== null || inputData !== null) {
    entry.dataComparison = "one-sided";
    pending.entry.dataComparison = "one-sided";
    pairingCounters.inputDataOneSidedCount += 1;
  } else {
    entry.dataComparison = "unavailable";
    pending.entry.dataComparison = "unavailable";
    pairingCounters.inputDataUnavailableCount += 1;
  }
  pending.inputData = null;
  pendingBeforeInput = undefined;
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

  correlateInputEvent(entry, event);
  appendTraceEntry(entry);
  render();
}

function recordError(error) {
  traceEntryCount += 1;
  eventCounters.monitorErrorCount += 1;
  errorCodeCounts[error.code] = (errorCodeCounts[error.code] ?? 0) + 1;
  appendTraceEntry({
    index: traceEntryCount,
    atMs: Number(performance.now().toFixed(3)),
    type: "monitor-error",
    code: error.code
  });
  render();
}

function currentPairingSummary() {
  return {
    ...pairingCounters,
    pendingBeforeInputCount: pendingBeforeInput ? 1 : 0,
    pendingBeforeInputPairId: pendingBeforeInput?.pairId ?? null
  };
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
  traceNode.textContent = events.slice(-80).map(entry => JSON.stringify(entry)).join("\\n") ||
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
  if (pendingBeforeInput) {
    pendingBeforeInput.inputData = null;
    pendingBeforeInput = undefined;
  }
});

render();
