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

function analyze(knownProjectIdeas, knownProjectIdeasOmittedCount = 0) {
  return analyzeLiteraryFragment({
    projectId,
    documentId: "chapter-graph",
    revision: 1,
    text: "Escena 1\nLas ideas se conectan en distintas direcciones.",
    knownProjectIdeas,
    knownProjectIdeasOmittedCount
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


test("las instantáneas cacheadas del grafo no se contaminan al mutar resultados previos", () => {
  const catalog = [
    idea("alpha", ["beta"]),
    idea("beta", ["alpha", "terminal"]),
    idea("terminal")
  ];
  const first = analyze(catalog);
  const expected = structuredClone(first);

  first.nodes[0].ideaId = "mutated-node";
  first.references[0].toIdeaId = "mutated-reference";
  first.cycles[0].ideaIds[0] = "mutated-cycle-member";

  const second = analyze(catalog);
  assert.deepEqual(second, expected);
  assert.equal(second.nodes.some(node => node.ideaId === "mutated-node"), false);
  assert.equal(second.references.some(reference => reference.toIdeaId === "mutated-reference"), false);
});


test("la caché invalida el grafo cuando cambia una referencia de la misma instantánea", () => {
  const catalog = [
    idea("source", ["first-target"]),
    idea("first-target"),
    idea("second-target")
  ];

  const before = analyze(catalog);
  assert.equal(before.includedReferenceCount, 1);

  catalog[0].relatedIdeaIds.splice(0, 1, "second-target");
  const after = analyze(catalog);

  assert.equal(after.includedReferenceCount, 1);
  assert.deepEqual(
    after.references.map(reference => [reference.fromIdeaId, reference.toIdeaId]),
    [["source", "second-target"]]
  );
  assert.notDeepEqual(after, before);
});

test("la caché separa catálogos completos de snapshots con ideas omitidas", () => {
  const catalog = [
    idea("source", ["external"]),
    idea("target")
  ];

  const complete = analyze(catalog, 0);
  const incomplete = analyze(catalog, 3);

  assert.equal(complete.projectCatalogComplete, true);
  assert.equal(incomplete.projectCatalogComplete, false);
  assert.equal(
    complete.references[0].resolution,
    "missing-from-project"
  );
  assert.equal(
    incomplete.references[0].resolution,
    "not-in-snapshot"
  );
});


test("el historial de estados distingue pares temporales comparables e incomparables", () => {
  const graph = analyze([{
    ...idea("history"),
    status: "incorporated",
    statusHistory: [
      { status: "IDEA", reason: "initial", changedAt: 10 },
      { status: "incorporated", reason: "writer" },
      { status: "discarded", reason: "writer", changedAt: 8 },
      { status: "incorporated", reason: "text-revised", changedAt: 8 }
    ]
  }]);
  const node = graph.nodes[0];

  assert.equal(node.observedStatusTransitionCount, 3);
  assert.equal(node.statusReversalCount, 1);
  assert.equal(node.comparableStatusTimestampPairCount, 1);
  assert.equal(node.uncomparableStatusTimestampPairCount, 2);
  assert.equal(node.nonMonotonicStatusTimestampCount, 0);
  assert.equal(node.earliestKnownStatusChangeAt, 8);
  assert.equal(node.latestKnownStatusChangeAt, 10);
  assert.equal(node.knownStatusHistorySpanMs, 2);
  assert.equal(node.currentStatusHistoryConsistency, "consistent");
});

test("el historial acepta marcas temporales iguales y detecta retrocesos adyacentes", () => {
  const graph = analyze([{
    ...idea("history"),
    status: "discarded",
    statusHistory: [
      { status: "IDEA", reason: "initial", changedAt: 100 },
      { status: "incorporated", reason: "writer", changedAt: 100 },
      { status: "discarded", reason: "writer", changedAt: 99 }
    ]
  }]);
  const node = graph.nodes[0];

  assert.equal(node.comparableStatusTimestampPairCount, 2);
  assert.equal(node.uncomparableStatusTimestampPairCount, 0);
  assert.equal(node.nonMonotonicStatusTimestampCount, 1);
  assert.equal(node.earliestKnownStatusChangeAt, 99);
  assert.equal(node.latestKnownStatusChangeAt, 100);
  assert.equal(node.knownStatusHistorySpanMs, 1);
});

test("un historial truncado conserva métricas observadas pero no certifica su consistencia", () => {
  const graph = analyze([{
    ...idea("history"),
    status: "discarded",
    statusHistory: [
      { status: "IDEA", reason: "initial", changedAt: 10 },
      { status: "incorporated", reason: "writer", changedAt: 20 }
    ],
    omittedStatusHistoryCount: 4
  }]);
  const node = graph.nodes[0];

  assert.equal(node.observedStatusTransitionCount, 1);
  assert.equal(node.observedWriterStatusChangeCount, 1);
  assert.equal(node.omittedStatusHistoryCount, 4);
  assert.equal(node.currentStatusHistoryConsistency, "unknown");
  assert.equal(graph.statusHistoryConsistency.consistentIdeaCount, 0);
  assert.equal(graph.statusHistoryConsistency.mismatchIdeaCount, 0);
  assert.equal(graph.statusHistoryConsistency.unknownIdeaCount, 1);
  assert.equal(graph.statusHistoryConsistency.verificationCoverage, 0);
});


test("el historial completo informa divergencias y contabiliza solo cambios de estado efectivos", () => {
  const graph = analyze([{
    ...idea("history"),
    status: "discarded",
    statusHistory: [
      { status: "IDEA", reason: "initial", changedAt: 50 },
      { status: "IDEA", reason: "initial", changedAt: 50 },
      { status: "incorporated", reason: "writer", changedAt: 60 },
      { status: "discarded", reason: "text-revised", changedAt: 55 },
      { status: "incorporated", reason: "writer", changedAt: 70 }
    ]
  }]);
  const node = graph.nodes[0];

  assert.equal(node.observedStatusTransitionCount, 3);
  assert.equal(node.statusReversalCount, 1);
  assert.equal(node.observedInitialStatusRecordCount, 2);
  assert.equal(node.observedWriterStatusChangeCount, 2);
  assert.equal(node.observedTextRevisionStatusChangeCount, 1);
  assert.equal(node.comparableStatusTimestampPairCount, 4);
  assert.equal(node.uncomparableStatusTimestampPairCount, 0);
  assert.equal(node.nonMonotonicStatusTimestampCount, 1);
  assert.equal(node.currentStatusHistoryConsistency, "mismatch");
  assert.equal(graph.statusHistoryConsistency.mismatchIdeaCount, 1);
  assert.equal(graph.statusHistoryConsistency.consistentIdeaCount, 0);
  assert.equal(graph.statusHistoryConsistency.verificationCoverage, 1);
  assert.equal(node.knownStatusHistorySpanMs, 20);
});

test("una idea sin historial no se clasifica como coherente ni divergente", () => {
  const graph = analyze([{
    ...idea("history"),
    status: "incorporated",
    statusHistory: []
  }]);
  const node = graph.nodes[0];

  assert.equal(node.currentStatusHistoryConsistency, "unknown");
  assert.equal(graph.statusHistoryConsistency.unknownIdeaCount, 1);
  assert.equal(graph.statusHistoryConsistency.verifiableIdeaCount, 0);
  assert.equal(graph.statusHistoryConsistency.verificationCoverage, 0);
});
