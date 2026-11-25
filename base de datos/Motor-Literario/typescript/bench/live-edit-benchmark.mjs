import { performance } from "node:perf_hooks";
import { HostEngineApi } from "../dist/motor-literario.js";

class BenchmarkStore {
  entities = new Map();
  async saveDocument() {}
  async loadDocument() { return undefined; }
  async loadDocumentWithChanges() { return { document: undefined, changes: [] }; }
  async appendChange() {}
  async compactChanges() {}
  async saveEntity(entity) { this.entities.set(entity.projectId + ":" + entity.id, entity); }
  async loadEntities(projectId) {
    return [...this.entities.values()].filter(entity => entity.projectId === projectId);
  }
}

const SIZES = [10_000, 100_000, 500_000];
const EDITS_PER_SIZE = Number(process.env.EDITS_PER_SIZE ?? 40);
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};

function makeManuscript(wordCount) {
  const vocabulary = "La historia avanza mientras los personajes descubren nuevas relaciones y conflictos".split(/\s+/u);
  const paragraphs = [];
  for (let offset = 0; offset < wordCount; offset += 100) {
    const count = Math.min(100, wordCount - offset);
    const words = Array.from({ length: count }, (_, index) =>
      vocabulary[(offset + index) % vocabulary.length]
    );
    paragraphs.push(words.join(" "));
  }
  return paragraphs.join("\n\n");
}

for (const wordCount of SIZES) {
  const text = makeManuscript(wordCount);
  const submittedAt = new Map();
  const latencies = [];
  const api = new HostEngineApi({
    store: new BenchmarkStore(),
    queueCapacity: EDITS_PER_SIZE + 8,
    callbacks: {
      onCommit(result) {
        const started = submittedAt.get(result.ticketId);
        if (started !== undefined) latencies.push(performance.now() - started);
      }
    }
  });

  api.initializeProject({ projectId: `benchmark-${wordCount}`, projectName: "Benchmark local" });
  const openingStart = performance.now();
  await api.openDocument({
    documentId: "manuscript",
    text,
    revision: 0,
    sequence: 0
  });
  const openingMs = performance.now() - openingStart;
  const heapBefore = process.memoryUsage().heapUsed;
  const admissionStart = performance.now();

  for (let index = 1; index <= EDITS_PER_SIZE; index++) {
    const position = text.length + index - 1;
    const admission = api.onEditorChange({
      documentId: "manuscript",
      sequence: index,
      baseRevision: index - 1,
      start: position,
      end: position,
      replacement: "x"
    });
    if (admission.status !== "queued") {
      throw new Error(`Edit ${index} rejected: ${admission.reason}`);
    }
    submittedAt.set(admission.ticketId, performance.now());
  }

  await api.flushPendingChanges();
  const admissionMs = performance.now() - admissionStart;
  const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
  const snapshot = api.getSnapshot("manuscript");
  const liveMetrics = api.getLiveAnalysisMetrics();

  console.log(JSON.stringify({
    words: wordCount,
    characters: text.length,
    edits: EDITS_PER_SIZE,
    openMs: Number(openingMs.toFixed(2)),
    batchMs: Number(admissionMs.toFixed(2)),
    commitLatencyP50Ms: Number(percentile(latencies, 0.50).toFixed(2)),
    commitLatencyP95Ms: Number(percentile(latencies, 0.95).toFixed(2)),
    endToEndLatencyP50Ms: Number(liveMetrics.endToEndP50Ms.toFixed(2)),
    endToEndLatencyP95Ms: Number(liveMetrics.endToEndP95Ms.toFixed(2)),
    endToEndSamples: liveMetrics.endToEndWindowSamples,
    heapDeltaMb: Number(heapDeltaMb.toFixed(2)),
    finalRevision: snapshot?.revision,
    finalCharacters: snapshot?.text.length
  }));
}


// Caso de estrés: un único párrafo/línea largo, que obliga al análisis a
// dividir el fragmento y ceder el hilo entre bloques.
const longLineWords = Number(process.env.LONG_LINE_WORDS ?? 20_000);
const longLineEdits = Number(process.env.LONG_LINE_EDITS ?? 5);
if (!Number.isSafeInteger(longLineWords) || longLineWords < 1 ||
    !Number.isSafeInteger(longLineEdits) || longLineEdits < 1) {
  throw new Error("LONG_LINE_WORDS y LONG_LINE_EDITS deben ser enteros positivos.");
}
const longLineText = makeManuscript(longLineWords).replace(/\n\n/gu, " ");
const longLineSubmittedAt = new Map();
const longLineLatencies = [];
const longLineApi = new HostEngineApi({
  store: new BenchmarkStore(),
  queueCapacity: longLineEdits + 8,
  callbacks: {
    onCommit(result) {
      const started = longLineSubmittedAt.get(result.ticketId);
      if (started !== undefined) longLineLatencies.push(performance.now() - started);
    }
  }
});
longLineApi.initializeProject({ projectId: "benchmark-single-line", projectName: "Benchmark línea extensa" });
const longLineOpenStart = performance.now();
await longLineApi.openDocument({
  documentId: "manuscript",
  text: longLineText,
  revision: 0,
  sequence: 0
});
const longLineOpenMs = performance.now() - longLineOpenStart;
const longLineHeapBefore = process.memoryUsage().heapUsed;
const longLineBatchStart = performance.now();
for (let index = 1; index <= longLineEdits; index++) {
  const position = longLineText.length + index - 1;
  const admission = longLineApi.onEditorChange({
    documentId: "manuscript",
    sequence: index,
    baseRevision: index - 1,
    start: position,
    end: position,
    replacement: "x"
  });
  if (admission.status !== "queued") {
    throw new Error(`Single-line edit ${index} rejected: ${admission.reason}`);
  }
  longLineSubmittedAt.set(admission.ticketId, performance.now());
}
await longLineApi.flushPendingChanges();
const longLineBatchMs = performance.now() - longLineBatchStart;
const longLineHeapDeltaMb = (process.memoryUsage().heapUsed - longLineHeapBefore) / (1024 * 1024);
const longLineSnapshot = longLineApi.getSnapshot("manuscript");
const longLineMetrics = longLineApi.getLiveAnalysisMetrics();
console.log(JSON.stringify({
  scenario: "single-line",
  words: longLineWords,
  characters: longLineText.length,
  edits: longLineEdits,
  openMs: Number(longLineOpenMs.toFixed(2)),
  batchMs: Number(longLineBatchMs.toFixed(2)),
  commitLatencyP50Ms: Number(percentile(longLineLatencies, 0.50).toFixed(2)),
  commitLatencyP95Ms: Number(percentile(longLineLatencies, 0.95).toFixed(2)),
  endToEndLatencyP50Ms: Number(longLineMetrics.endToEndP50Ms.toFixed(2)),
  endToEndLatencyP95Ms: Number(longLineMetrics.endToEndP95Ms.toFixed(2)),
  endToEndSamples: longLineMetrics.endToEndWindowSamples,
  heapDeltaMb: Number(longLineHeapDeltaMb.toFixed(2)),
  finalRevision: longLineSnapshot?.revision,
  finalCharacters: longLineSnapshot?.text.length
}));

// Caso concurrente: varios documentos reciben ediciones sostenidas a la vez.
// El motor debe mantener FIFO por documento sin bloquear los documentos vecinos.
const concurrentDocuments = Number(process.env.CONCURRENT_DOCUMENTS ?? 4);
const concurrentEditsPerDocument = Number(process.env.CONCURRENT_EDITS_PER_DOCUMENT ?? 10);
if (!Number.isSafeInteger(concurrentDocuments) || concurrentDocuments < 1 || concurrentDocuments > 8 ||
    !Number.isSafeInteger(concurrentEditsPerDocument) || concurrentEditsPerDocument < 1) {
  throw new Error("CONCURRENT_DOCUMENTS debe estar entre 1 y 8 y CONCURRENT_EDITS_PER_DOCUMENT debe ser positivo.");
}
const concurrentText = "La historia avanza mientras los personajes descubren nuevas relaciones.";
const concurrentApi = new HostEngineApi({
  store: new BenchmarkStore(),
  queueCapacity: concurrentDocuments * concurrentEditsPerDocument + 8,
  maxConcurrentDocuments: concurrentDocuments
});
concurrentApi.initializeProject({
  projectId: "benchmark-concurrent-documents",
  projectName: "Benchmark de documentos concurrentes"
});
for (let documentIndex = 0; documentIndex < concurrentDocuments; documentIndex++) {
  await concurrentApi.openDocument({
    documentId: `chapter-${documentIndex + 1}`,
    text: concurrentText,
    revision: 0,
    sequence: 0
  });
}
const concurrentBatchStart = performance.now();
for (let documentIndex = 0; documentIndex < concurrentDocuments; documentIndex++) {
  const documentId = `chapter-${documentIndex + 1}`;
  for (let sequence = 1; sequence <= concurrentEditsPerDocument; sequence++) {
    const position = concurrentText.length + sequence - 1;
    const admission = concurrentApi.onEditorChange({
      documentId,
      sequence,
      baseRevision: sequence - 1,
      start: position,
      end: position,
      replacement: "x"
    });
    if (admission.status !== "queued") {
      throw new Error(`Concurrent edit ${documentId}#${sequence} rejected: ${admission.reason}`);
    }
  }
}
await concurrentApi.flushPendingChanges();
const concurrentBatchMs = performance.now() - concurrentBatchStart;
const concurrentMetrics = concurrentApi.getLiveAnalysisMetrics();
console.log(JSON.stringify({
  scenario: "concurrent-documents",
  documents: concurrentDocuments,
  editsPerDocument: concurrentEditsPerDocument,
  totalEdits: concurrentDocuments * concurrentEditsPerDocument,
  batchMs: Number(concurrentBatchMs.toFixed(2)),
  maxActiveDocuments: concurrentMetrics.maxActiveDocuments,
  maxActiveChangesCompatibilityAlias: concurrentMetrics.maxActiveChanges,
  endToEndLatencyP50Ms: Number(concurrentMetrics.endToEndP50Ms.toFixed(2)),
  endToEndLatencyP95Ms: Number(concurrentMetrics.endToEndP95Ms.toFixed(2)),
  endToEndSamples: concurrentMetrics.endToEndSamples
}));
