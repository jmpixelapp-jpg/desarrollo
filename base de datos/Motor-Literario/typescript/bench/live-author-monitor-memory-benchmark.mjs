import { performance } from "node:perf_hooks";
const monitorModule = await import("../dist-monitor/live-author-monitor.js")
  .catch(() => import("../dist/motor-literario.js"));
const { LiveAuthorMonitor } = monitorModule;

const DOCUMENT_COUNT = Number(process.env.MONITOR_BENCH_DOCUMENTS ?? 8);
const CHANGES_PER_DOCUMENT = Number(process.env.MONITOR_BENCH_CHANGES_PER_DOCUMENT ?? 12_500);
const DOCUMENT_CODE_UNITS = Number(process.env.MONITOR_BENCH_DOCUMENT_CODE_UNITS ?? 1_048_576);
const SAMPLE_WINDOW = Number(process.env.MONITOR_BENCH_SAMPLE_WINDOW ?? 64);

for (const [name, value, minimum, maximum] of [
  ["MONITOR_BENCH_DOCUMENTS", DOCUMENT_COUNT, 1, 64],
  ["MONITOR_BENCH_CHANGES_PER_DOCUMENT", CHANGES_PER_DOCUMENT, 1, 1_000_000],
  ["MONITOR_BENCH_DOCUMENT_CODE_UNITS", DOCUMENT_CODE_UNITS, 1, 50 * 1024 * 1024],
  ["MONITOR_BENCH_SAMPLE_WINDOW", SAMPLE_WINDOW, 1, 4096]
]) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(name + " debe ser un entero entre " + minimum + " y " + maximum + ".");
  }
}

if (typeof globalThis.gc !== "function") {
  throw new Error("Ejecuta este benchmark con node --expose-gc para medir el heap después de GC.");
}

const megabytes = bytes => Number((bytes / (1024 * 1024)).toFixed(2));
const collectGarbage = () => {
  globalThis.gc();
  globalThis.gc();
};
const memory = () => process.memoryUsage();

collectGarbage();
const heapBefore = memory().heapUsed;
let logicalTime = 0;
const monitor = new LiveAuthorMonitor({
  now: () => logicalTime,
  maxOpenDocuments: DOCUMENT_COUNT,
  commitSampleWindow: SAMPLE_WINDOW
});

let initialText = "x".repeat(DOCUMENT_CODE_UNITS);
const lengths = new Array(DOCUMENT_COUNT).fill(DOCUMENT_CODE_UNITS);
const sequences = new Array(DOCUMENT_COUNT).fill(0);
const revisions = new Array(DOCUMENT_COUNT).fill(0);
const documentIds = Array.from({ length: DOCUMENT_COUNT }, (_, index) => "monitor-memory-" + index);

for (const documentId of documentIds) {
  monitor.openDocument({
    documentId,
    text: initialText,
    revision: 0,
    sequence: 0
  }, "monitor-memory-benchmark");
}
initialText = "";
collectGarbage();
const heapAfterOpen = memory().heapUsed;

const startedAt = performance.now();
const halfPoint = Math.floor(CHANGES_PER_DOCUMENT / 2);
let heapAtHalf = heapAfterOpen;
for (let changeIndex = 0; changeIndex < CHANGES_PER_DOCUMENT; changeIndex += 1) {
  for (let documentIndex = 0; documentIndex < DOCUMENT_COUNT; documentIndex += 1) {
    const documentId = documentIds[documentIndex];
    const sequence = ++sequences[documentIndex];
    const revision = revisions[documentIndex];
    const ticketId = documentId + "-ticket-" + sequence;
    const start = lengths[documentIndex];

    logicalTime += 1;
    const admission = monitor.recordAdmission({
      documentId,
      sequence,
      baseRevision: revision,
      start,
      end: start,
      replacement: "x",
      activityKind: "typing"
    }, { status: "queued", ticketId });
    if (admission.pendingChanges !== 1) {
      throw new Error("El monitor no registró exactamente un cambio pendiente para " + documentId + ".");
    }

    logicalTime += 1;
    const committed = monitor.recordCommit({
      ticketId,
      status: "applied",
      revision: revision + 1
    });
    if (!committed || committed.pendingChanges !== 0) {
      throw new Error("El commit no cerró su ticket para " + documentId + ".");
    }
    lengths[documentIndex] += 1;
    revisions[documentIndex] = revision + 1;
  }

  if (changeIndex + 1 === halfPoint) {
    collectGarbage();
    heapAtHalf = memory().heapUsed;
  }
}

const elapsedMs = performance.now() - startedAt;
collectGarbage();
const afterMemory = memory();
const snapshots = monitor.getSnapshots();
for (const snapshot of snapshots) {
  if (snapshot.acceptedChanges !== CHANGES_PER_DOCUMENT ||
      snapshot.committedChanges !== CHANGES_PER_DOCUMENT ||
      snapshot.pendingChanges !== 0 ||
      snapshot.failedChanges !== 0 ||
      snapshot.commitLatencySamples !== Math.min(CHANGES_PER_DOCUMENT, SAMPLE_WINDOW) ||
      snapshot.currentDocumentLength !== DOCUMENT_CODE_UNITS + CHANGES_PER_DOCUMENT) {
    throw new Error("Los invariantes de métricas/ventana no se cumplieron para " + snapshot.documentId + ".");
  }
}

const output = {
  scenario: "live-author-monitor-bounded-heap",
  runtime: "node",
  nodeVersion: process.version,
  documents: DOCUMENT_COUNT,
  initialCodeUnitsPerDocument: DOCUMENT_CODE_UNITS,
  changesPerDocument: CHANGES_PER_DOCUMENT,
  totalCommits: DOCUMENT_COUNT * CHANGES_PER_DOCUMENT,
  latencySampleWindow: SAMPLE_WINDOW,
  elapsedMs: Number(elapsedMs.toFixed(2)),
  commitsPerSecond: Number((DOCUMENT_COUNT * CHANGES_PER_DOCUMENT * 1_000 / elapsedMs).toFixed(2)),
  heapBeforeMb: megabytes(heapBefore),
  heapAfterOpenMb: megabytes(heapAfterOpen),
  heapAtHalfLoadMb: megabytes(heapAtHalf),
  heapAfterFullLoadMb: megabytes(afterMemory.heapUsed),
  heapRetainedByOpenSessionsMb: megabytes(afterMemory.heapUsed - heapBefore),
  heapGrowthFromHalfToFullMb: megabytes(afterMemory.heapUsed - heapAtHalf),
  rssAfterFullLoadMb: megabytes(afterMemory.rss),
  finalCommittedPerDocument: snapshots.map(snapshot => snapshot.committedChanges),
  finalPendingPerDocument: snapshots.map(snapshot => snapshot.pendingChanges),
  privacy: "snapshots contain metrics and lengths only; manuscript text is not stored"
};

console.log(JSON.stringify(output));
monitor.dispose();
