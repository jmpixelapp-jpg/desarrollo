import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLiteraryFragment } from "../dist/motor-literario.js";

const projectId = "idea-graph-depth-test";

test("el grafo dirigido procesa cadenas profundas sin recursión y conserva métricas globales", () => {
  const ideaCount = 10_500;
  const ideas = Array.from({ length: ideaCount }, (_, index) => ({
    projectId,
    ideaId: `idea-${String(index).padStart(5, "0")}`,
    status: "IDEA",
    relatedIdeaIds: index + 1 < ideaCount
      ? [`idea-${String(index + 1).padStart(5, "0")}`]
      : [],
    evidenceCount: 0,
    staleEvidenceCount: 0,
    statusHistory: [{ status: "IDEA", reason: "initial" }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  }));

  const result = analyzeLiteraryFragment({
    projectId,
    documentId: "deep-chain",
    revision: 1,
    text: "Una idea conduce a la siguiente.",
    knownProjectIdeas: ideas
  });
  const graph = result.ideaGraph;

  assert.equal(graph.ideaCount, ideaCount);
  assert.equal(graph.referenceCount, ideaCount - 1);
  assert.equal(graph.includedReferenceCount, ideaCount - 1);
  assert.equal(graph.cycleCount, 0);
  assert.equal(graph.weakComponentCount, 1);
  assert.equal(graph.largestWeakComponentSize, ideaCount);
  assert.equal(graph.sourceNodeCount, 1);
  assert.equal(graph.terminalWithinSnapshotNodeCount, 1);
  assert.equal(graph.terminalReachableNodeCount, ideaCount);

  const first = graph.nodes[0];
  const middle = graph.nodes[Math.floor(ideaCount / 2)];
  const last = graph.nodes[ideaCount - 1];

  assert.equal(first.ideaId, "idea-00000");
  assert.equal(first.minimumDirectedHopsToTerminal, ideaCount - 1);
  assert.equal(first.terminalReachabilityStatus, "reaches-terminal-within-snapshot");
  assert.equal(middle.articulationPointStatus, "connector");
  assert.equal(middle.weakComponentPiecesAfterRemoval, 2);
  assert.equal(last.ideaId, `idea-${String(ideaCount - 1).padStart(5, "0")}`);
  assert.equal(last.minimumDirectedHopsToTerminal, 0);
});

test("mantiene métricas completas cuando el catálogo supera el límite de muestras de referencias", () => {
  const ideaCount = 6_002;
  const ideas = Array.from({ length: ideaCount }, (_, index) => ({
    projectId,
    ideaId: `catalog-${String(index).padStart(5, "0")}`,
    status: "IDEA",
    relatedIdeaIds: index + 1 < ideaCount
      ? [`catalog-${String(index + 1).padStart(5, "0")}`]
      : [],
    evidenceCount: 0,
    staleEvidenceCount: 0,
    statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  }));

  const graph = analyzeLiteraryFragment({
    projectId,
    documentId: "reference-sample-budget",
    revision: 1,
    text: "El catálogo excede el presupuesto de muestras.",
    knownProjectIdeas: ideas
  }).ideaGraph;

  assert.equal(graph.ideaCount, ideaCount);
  assert.equal(graph.referenceCount, ideaCount - 1);
  assert.equal(graph.includedReferenceCount, ideaCount - 1);
  assert.equal(graph.referenceSampleCount, 5_000);
  assert.equal(graph.omittedReferenceSampleCount, ideaCount - 1 - 5_000);
  assert.equal(graph.referencesTruncated, true);
  assert.equal(graph.cycleCount, 0);
  assert.equal(graph.weakComponentCount, 1);
  assert.equal(graph.articulationPointCount, ideaCount - 2);
  assert.equal(graph.articulationPointIdeaIds.length, 100);
  assert.equal(graph.omittedArticulationPointCount, ideaCount - 2 - 100);
  assert.equal(graph.terminalReachableNodeCount, ideaCount);
});

test("ordena de forma estable los ciclos y conserva el total al limitar sus muestras", () => {
  const cycleCount = 120;
  const ideas = Array.from({ length: cycleCount }, (_, index) => {
    const ideaId = `cycle-${String(index).padStart(3, "0")}`;
    return {
      projectId,
      ideaId,
      status: "IDEA",
      relatedIdeaIds: [ideaId],
      evidenceCount: 0,
      staleEvidenceCount: 0,
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }],
      writerDecisionCount: 0,
      omittedStatusHistoryCount: 0
    };
  });

  const analyze = knownProjectIdeas => analyzeLiteraryFragment({
    projectId,
    documentId: "cycle-sample-budget",
    revision: 1,
    text: "Ciclos independientes para validar el muestreo.",
    knownProjectIdeas
  }).ideaGraph;
  const graph = analyze(ideas);
  const reordered = analyze([...ideas].reverse());

  assert.deepEqual(reordered, graph);
  assert.equal(graph.ideaCount, cycleCount);
  assert.equal(graph.referenceCount, cycleCount);
  assert.equal(graph.includedReferenceCount, cycleCount);
  assert.equal(graph.cycleCount, cycleCount);
  assert.equal(graph.omittedCycleCount, cycleCount - 100);
  assert.equal(graph.cycles.length, 100);
  assert.deepEqual(
    graph.cycles.map(cycle => cycle.ideaIds),
    ideas.slice(0, 100).map(idea => [idea.ideaId])
  );
  assert.equal(graph.weakComponentCount, cycleCount);
  assert.equal(graph.largestWeakComponentSize, 1);
});
