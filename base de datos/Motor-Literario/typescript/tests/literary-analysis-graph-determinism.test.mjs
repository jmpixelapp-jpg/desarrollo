import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLiteraryFragment } from "../dist/motor-literario.js";

const projectId = "idea-graph-determinism-test";

function idea(ideaId, relatedIdeaIds = []) {
  return {
    projectId,
    ideaId,
    text: "Idea " + ideaId,
    status: "IDEA",
    relatedIdeaIds,
    evidenceCount: 0,
    staleEvidenceCount: 0,
    statusHistory: [{ status: "IDEA", reason: "initial" }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  };
}

function analyze(knownProjectIdeas) {
  return analyzeLiteraryFragment({
    projectId,
    documentId: "chapter-graph",
    revision: 1,
    text: "Escena 1\nLas ideas se conectan en distintas direcciones.",
    knownProjectIdeas,
    knownProjectIdeasOmittedCount: 0
  }).ideaGraph;
}

test("el grafo de ideas es determinista ante permutaciones del catálogo y sus referencias", () => {
  const catalog = [
    idea("root", ["left", "right"]),
    idea("left", ["shared", "left-only"]),
    idea("right", ["shared", "right-only"]),
    idea("shared"),
    idea("left-only"),
    idea("right-only"),
    idea("cycle-a", ["cycle-b"]),
    idea("cycle-b", ["cycle-a"]),
    idea("isolated")
  ];

  const baseline = analyze(catalog);
  const permuted = analyze(
    [...catalog].reverse().map(item => ({
      ...item,
      relatedIdeaIds: [...item.relatedIdeaIds].reverse()
    }))
  );

  assert.deepEqual(permuted, baseline);
  assert.deepEqual(
    baseline.nodes.map(node => node.ideaId),
    [...baseline.nodes.map(node => node.ideaId)].sort()
  );
  assert.equal(baseline.twoHopConvergentSourceCount, 1);
  assert.equal(baseline.twoHopSharedDestinationCount, 1);
  assert.equal(baseline.twoHopExclusiveDestinationCount, 2);
  assert.equal(baseline.twoHopIndependentBranchSourceCount, 1);
  assert.equal(baseline.cycleCount, 1);
  assert.equal(baseline.isolatedWithinSnapshotNodeCount, 1);
  assert.equal(baseline.twoHopConvergenceAnalysisStatus, "complete");
});

test("el grafo conserva la distinción entre destino compartido y destinos exclusivos", () => {
  const graph = analyze([
    idea("origin", ["branch-a", "branch-b"]),
    idea("branch-a", ["shared", "exclusive-a", "exclusive-a"]),
    idea("branch-b", ["shared"]),
    idea("shared"),
    idea("exclusive-a")
  ]);

  assert.equal(graph.twoHopConvergentSourceCount, 1);
  assert.equal(graph.twoHopSharedDestinationCount, 1);
  assert.equal(graph.twoHopExclusiveDestinationCount, 1);
  assert.equal(graph.twoHopIndependentBranchSourceCount, 0);
  assert.equal(graph.twoHopConvergenceAnalysisStatus, "complete");
});
