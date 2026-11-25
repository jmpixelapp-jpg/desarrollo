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


test("los totales globales de coherencia cubren exactamente todos los nodos del catálogo", () => {
  const graph = analyze([
    {
      ...idea("consistent"),
      status: "incorporated",
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 10 },
        { status: "incorporated", reason: "writer", changedAt: 20 }
      ]
    },
    {
      ...idea("mismatch"),
      status: "discarded",
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 10 },
        { status: "incorporated", reason: "writer", changedAt: 20 }
      ]
    },
    {
      ...idea("truncated"),
      status: "discarded",
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 10 }
      ],
      omittedStatusHistoryCount: 1
    },
    {
      ...idea("empty-history"),
      statusHistory: []
    }
  ]);

  const totals = graph.statusHistoryConsistency;
  assert.equal(graph.ideaCount, 4);
  assert.equal(totals.consistentIdeaCount, 1);
  assert.equal(totals.mismatchIdeaCount, 1);
  assert.equal(totals.unknownIdeaCount, 2);
  assert.equal(
    totals.consistentIdeaCount + totals.mismatchIdeaCount + totals.unknownIdeaCount,
    graph.ideaCount
  );
  assert.equal(totals.verifiableIdeaCount, 2);
  assert.equal(totals.verificationCoverage, 0.5);

  const profileTotals = graph.statusProfiles.reduce((sum, profile) => ({
    consistent: sum.consistent + profile.statusHistoryConsistentIdeaCount,
    mismatch: sum.mismatch + profile.statusHistoryMismatchIdeaCount,
    unknown: sum.unknown + profile.statusHistoryConsistencyUnknownIdeaCount
  }), { consistent: 0, mismatch: 0, unknown: 0 });
  assert.deepEqual(profileTotals, {
    consistent: totals.consistentIdeaCount,
    mismatch: totals.mismatchIdeaCount,
    unknown: totals.unknownIdeaCount
  });
});


test("el grafo distingue aristas explícitas repetidas, vecinos únicos y destinos fuera del snapshot", () => {
  const graph = analyze([
    {
      ...idea("source-a", ["inside", "inside", "outside"]),
      status: "incorporated"
    },
    {
      ...idea("source-b", ["inside", "inside"]),
      status: "discarded"
    },
    idea("inside")
  ], 2);

  const sourceA = graph.nodes.find(node => node.ideaId === "source-a");
  const sourceB = graph.nodes.find(node => node.ideaId === "source-b");
  const inside = graph.nodes.find(node => node.ideaId === "inside");

  assert.equal(graph.referenceCount, 5);
  assert.equal(graph.includedReferenceCount, 4);
  assert.equal(graph.notIncludedReferenceCount, 1);
  assert.equal(graph.missingFromProjectReferenceCount, 0);
  assert.equal(graph.referencesTruncated, false);

  assert.equal(sourceA.includedOutgoingReferenceCount, 2);
  assert.equal(sourceA.notIncludedOutgoingReferenceCount, 1);
  assert.equal(sourceA.distinctOutgoingIdeaCount, 1);
  assert.deepEqual(sourceA.directReferenceStatusCounts, {
    IDEA: 2,
    incorporated: 0,
    discarded: 0,
    notInSnapshot: 1
  });
  assert.equal(sourceA.directReferenceStatusAlignment, "unknown-incomplete-snapshot");

  assert.equal(sourceB.includedOutgoingReferenceCount, 2);
  assert.equal(sourceB.distinctOutgoingIdeaCount, 1);
  assert.equal(sourceB.directReferenceStatusCounts.IDEA, 2);
  assert.equal(sourceB.directReferenceStatusAlignment, "same-status");

  assert.equal(inside.incomingReferenceCount, 4);
  assert.equal(inside.distinctIncomingIdeaCount, 2);
  assert.equal(
    graph.nodes.reduce((sum, node) => sum + node.includedOutgoingReferenceCount, 0),
    graph.includedReferenceCount
  );
  assert.equal(
    graph.nodes.reduce((sum, node) => sum + node.notIncludedOutgoingReferenceCount, 0),
    graph.notIncludedReferenceCount
  );
  assert.equal(
    graph.nodes.reduce((sum, node) => sum + node.incomingReferenceCount, 0),
    graph.includedReferenceCount
  );
});


test("la resolución de referencias respeta el alcance real del catálogo", () => {
  const source = idea("source", ["included", "absent"]);
  const included = idea("included");

  const complete = analyze([source, included]);
  assert.equal(complete.catalogScope, "project");
  assert.equal(complete.projectCatalogComplete, true);
  assert.equal(complete.missingFromProjectReferenceCount, 1);
  assert.deepEqual(
    complete.references.map(reference => reference.resolution),
    ["included-in-snapshot", "missing-from-project"]
  );

  const partial = analyze([source, included], 3);
  assert.equal(partial.catalogScope, "project");
  assert.equal(partial.projectCatalogComplete, false);
  assert.equal(partial.missingFromProjectReferenceCount, 0);
  assert.deepEqual(
    partial.references.map(reference => reference.resolution),
    ["included-in-snapshot", "not-in-snapshot"]
  );

  const legacy = analyzeLiteraryFragment({
    projectId,
    documentId: "chapter-graph",
    revision: 1,
    text: "Escena 1\nLas ideas se conectan en distintas direcciones.",
    knownIdeas: [source, included]
  }).ideaGraph;
  assert.equal(legacy.catalogScope, "character-linked-fallback");
  assert.equal(legacy.projectCatalogComplete, false);
  assert.equal(legacy.missingFromProjectReferenceCount, 0);
  assert.deepEqual(
    legacy.references.map(reference => reference.resolution),
    ["included-in-snapshot", "not-in-snapshot"]
  );
});

test("los perfiles por estado conservan los totales de nodos y referencias dirigidas", () => {
  const graph = analyze([
    {
      ...idea("idea-a", ["idea-b", "idea-c"]),
      status: "IDEA"
    },
    {
      ...idea("idea-b", ["idea-c"]),
      status: "incorporated"
    },
    {
      ...idea("idea-c", ["idea-a"]),
      status: "discarded"
    },
    {
      ...idea("isolated"),
      status: "discarded"
    }
  ]);

  assert.equal(
    graph.statusProfiles.reduce((sum, profile) => sum + profile.ideaCount, 0),
    graph.ideaCount
  );
  assert.equal(
    graph.statusTransitionProfiles.reduce((sum, profile) => sum + profile.referenceCount, 0),
    graph.includedReferenceCount
  );
  assert.deepEqual(
    graph.statusTransitionProfiles.map(profile => [
      profile.fromStatus,
      profile.toStatus,
      profile.referenceCount
    ]),
    [
      ["IDEA", "incorporated", 1],
      ["IDEA", "discarded", 1],
      ["incorporated", "discarded", 1],
      ["discarded", "IDEA", 1]
    ]
  );
});


test("las auto-referencias forman ciclos unitarios sin inflar pares recíprocos", () => {
  const graph = analyze([
    idea("self", ["self"]),
    idea("pair-a", ["pair-b"]),
    idea("pair-b", ["pair-a"]),
    idea("terminal")
  ]);

  assert.equal(graph.selfReferenceCount, 1);
  assert.equal(graph.reciprocalReferencePairCount, 1);
  assert.equal(graph.cycleCount, 2);
  assert.deepEqual(
    graph.cycles.map(cycle => cycle.ideaIds),
    [["pair-a", "pair-b"], ["self"]]
  );

  const self = graph.nodes.find(node => node.ideaId === "self");
  const pairA = graph.nodes.find(node => node.ideaId === "pair-a");
  const terminal = graph.nodes.find(node => node.ideaId === "terminal");
  assert.equal(self.cycleMembership, "cyclic-component");
  assert.equal(self.cycleComponentSize, 1);
  assert.equal(self.minimumDirectedHopsToTerminal, null);
  assert.equal(pairA.cycleMembership, "cyclic-component");
  assert.equal(pairA.cycleComponentSize, 2);
  assert.equal(terminal.terminalReachabilityStatus, "reaches-terminal-within-snapshot");
  assert.equal(graph.terminalWithinSnapshotNodeCount, 1);
  assert.equal(graph.terminalReachableNodeCount, 1);
});


test("las distancias a terminales usan rutas mínimas y el límite del snapshot", () => {
  const graph = analyze([
    idea("start", ["middle", "terminal"]),
    idea("middle", ["terminal"]),
    idea("terminal"),
    idea("cycle-a", ["cycle-b"]),
    idea("cycle-b", ["cycle-a"]),
    idea("external-only", ["not-loaded"])
  ], 1);

  const byId = new Map(graph.nodes.map(node => [node.ideaId, node]));
  assert.equal(byId.get("terminal").minimumDirectedHopsToTerminal, 0);
  assert.equal(byId.get("middle").minimumDirectedHopsToTerminal, 1);
  assert.equal(byId.get("start").minimumDirectedHopsToTerminal, 1);
  assert.equal(byId.get("cycle-a").minimumDirectedHopsToTerminal, null);
  assert.equal(byId.get("cycle-b").minimumDirectedHopsToTerminal, null);
  assert.equal(byId.get("external-only").minimumDirectedHopsToTerminal, 0);
  assert.equal(byId.get("external-only").terminalReachabilityStatus, "reaches-terminal-within-snapshot");
  assert.equal(byId.get("external-only").notIncludedOutgoingReferenceCount, 1);
  assert.equal(graph.terminalWithinSnapshotNodeCount, 2);
  assert.equal(graph.terminalReachableNodeCount, 4);
  assert.equal(graph.terminalUnreachableNodeCount, 2);
  assert.equal(graph.terminalReachabilityCoverage, 4 / 6);
});
