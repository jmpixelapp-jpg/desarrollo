import { performance } from "node:perf_hooks";
import { createServer } from "vite";

const runs = Number.parseInt(process.env.RUNS ?? "12", 10);
if (!Number.isSafeInteger(runs) || runs < 3 || runs > 100) {
  throw new RangeError("RUNS debe ser un entero entre 3 y 100.");
}

const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  server: { middlewareMode: true },
  appType: "custom",
});

try {
  const { analyzeLiteraryText } = await vite.ssrLoadModule("/src/analysis/index.ts");
  const paragraph = [
    "Mara tenía los ojos verdes y el cabello negro.",
    "La exploradora recorrió la ciudad antigua antes del amanecer.",
    "Recordó que Luis era su hermano y que conocía el camino.",
    "La expedición llegó a Valdoria después de la tormenta.",
  ].join(" ");
  const text = Array.from({ length: 700 }, () => paragraph).join("\n");
  const document = {
    documentId: "synthetic-benchmark",
    revision: 1,
    text,
    language: "es",
  };
  const context = {
    projectId: "synthetic-benchmark-project",
    characters: [
      { characterId: "mara", canonicalName: "Mara", aliases: ["la exploradora"] },
      { characterId: "luis", canonicalName: "Luis", aliases: [] },
    ],
    entities: [
      { entityId: "valdoria", entityType: "place", canonicalName: "Valdoria" },
    ],
    events: [],
    chronologyMode: "unknown",
  };
  const options = {
    orthography: true,
    grammar: true,
    punctuation: true,
    repetition: true,
    style: true,
    characters: true,
    entities: true,
    contradictions: true,
    continuity: false,
    maxFindings: 300,
  };
  const fullRequest = {
    projectId: context.projectId,
    document,
    context,
    options,
  };
  const changedToken = "amanecer";
  const changedAt = text.lastIndexOf(changedToken);
  const incrementalRequest = {
    ...fullRequest,
    range: { start: changedAt, end: changedAt + changedToken.length },
  };

  function percentile(values, ratio) {
    const ordered = [...values].sort((a, b) => a - b);
    const index = Math.min(ordered.length - 1, Math.ceil(ratio * ordered.length) - 1);
    return ordered[Math.max(0, index)] ?? 0;
  }

  function measure(request) {
    const startedAt = performance.now();
    const result = analyzeLiteraryText(request);
    const elapsedMs = performance.now() - startedAt;
    return { elapsedMs, result };
  }

  // Calentamiento del JIT y de cachés internas; no se incluye en las estadísticas.
  for (let index = 0; index < 2; index += 1) {
    analyzeLiteraryText(fullRequest);
    analyzeLiteraryText(incrementalRequest);
  }

  const fullTimes = [];
  const incrementalTimes = [];
  let fullResult;
  let incrementalResult;
  for (let index = 0; index < runs; index += 1) {
    const full = measure(fullRequest);
    const incremental = measure(incrementalRequest);
    fullTimes.push(full.elapsedMs);
    incrementalTimes.push(incremental.elapsedMs);
    fullResult = full.result;
    incrementalResult = incremental.result;
  }

  const summary = values => ({
    samples: values.length,
    p50Ms: Number(percentile(values, 0.50).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    minMs: Number(Math.min(...values).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3)),
  });

  console.log(JSON.stringify({
    benchmark: "literary-analysis",
    environment: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      runs,
    },
    input: {
      documentId: document.documentId,
      revision: document.revision,
      utf16Length: text.length,
      wordCount: text.trim().split(/\s+/u).length,
      projectId: context.projectId,
    },
    fullDocument: {
      latency: summary(fullTimes),
      findings: fullResult?.summary.total ?? 0,
      mentions: fullResult?.summary.mentions ?? 0,
      assertions: fullResult?.summary.assertions ?? 0,
      relations: fullResult?.summary.relations ?? 0,
      scope: fullResult?.scope ?? "unknown",
    },
    incremental: {
      latency: summary(incrementalTimes),
      findings: incrementalResult?.summary.total ?? 0,
      mentions: incrementalResult?.summary.mentions ?? 0,
      assertions: incrementalResult?.summary.assertions ?? 0,
      relations: incrementalResult?.summary.relations ?? 0,
      scope: incrementalResult?.scope ?? "unknown",
      range: incrementalRequest.range,
    },
    note: "Corpus sintético; estos resultados no representan manuscritos reales ni sustituyen pruebas en dispositivos objetivo.",
  }, null, 2));
} finally {
  await vite.close();
}
