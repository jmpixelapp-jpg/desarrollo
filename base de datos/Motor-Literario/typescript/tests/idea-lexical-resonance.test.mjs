import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLiteraryFragment } from "../dist/motor-literario.js";

const projectId = "idea-lexical-resonance";

function idea(id, text) {
  return {
    projectId,
    ideaId: id,
    ...(text === undefined ? {} : { text }),
    status: "IDEA",
    originDocumentId: "chapter-1",
    sourceProjectName: "Book",
    relatedEntityIds: [],
    relatedIdeaIds: [],
    evidence: [],
    evidenceCount: 0,
    staleEvidenceCount: 0,
    statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  };
}

function analyze(ideas) {
  return analyzeLiteraryFragment({
    projectId,
    documentId: "chapter-1",
    revision: 1,
    text: "Fragmento narrativo de prueba.",
    knownProjectIdeas: ideas
  }).ideaGraph.lexicalResonances;
}

function analyzeGraph(ideas, options = {}) {
  return analyzeLiteraryFragment({
    projectId,
    documentId: "chapter-1",
    revision: 1,
    text: "Fragmento narrativo de prueba.",
    ...(options.projectCatalog === false
      ? { knownIdeas: ideas }
      : { knownProjectIdeas: ideas }),
    ...(options.projectCatalog === false
      ? { knownIdeasOmittedCount: options.omittedIdeaCount ?? 0 }
      : { knownProjectIdeasOmittedCount: options.omittedIdeaCount ?? 0 })
  }).ideaGraph;
}

test("analiza el límite de 2.000 ideas conectadas sin perder la topología", () => {
  const count = 2_000;
  const ideas = Array.from({ length: count }, (_, index) => ({
    ...idea("stress-" + String(index).padStart(4, "0")),
    relatedIdeaIds: [
      "stress-" + String((index + 1) % count).padStart(4, "0")
    ]
  }));

  const graph = analyzeGraph(ideas);
  assert.equal(graph.ideaCount, count);
  assert.equal(graph.referenceCount, count);
  assert.equal(graph.includedReferenceCount, count);
  assert.equal(graph.notIncludedReferenceCount, 0);
  assert.equal(graph.cycleCount, 1);
  assert.equal(graph.cycles[0].ideaIds.length, count);
  assert.equal(graph.weakComponentCount, 1);
  assert.equal(graph.largestWeakComponentSize, count);
  assert.equal(graph.sourceNodeCount, 0);
  assert.equal(graph.terminalWithinSnapshotNodeCount, 0);
  assert.equal(graph.isolatedWithinSnapshotNodeCount, 0);
});

test("recorre iterativamente una cadena profunda sin clasificarla como ciclo", () => {
  const count = 2_000;
  const ideas = Array.from({ length: count }, (_, index) => ({
    ...idea("chain-" + String(index).padStart(4, "0")),
    relatedIdeaIds: index + 1 < count
      ? ["chain-" + String(index + 1).padStart(4, "0")]
      : []
  }));

  const graph = analyzeGraph(ideas);
  assert.equal(graph.ideaCount, count);
  assert.equal(graph.referenceCount, count - 1);
  assert.equal(graph.includedReferenceCount, count - 1);
  assert.equal(graph.cycleCount, 0);
  assert.deepEqual(graph.cycles, []);
  assert.equal(graph.weakComponentCount, 1);
  assert.equal(graph.largestWeakComponentSize, count);
  assert.equal(graph.sourceNodeCount, 1);
  assert.equal(graph.terminalWithinSnapshotNodeCount, 1);
  assert.equal(graph.isolatedWithinSnapshotNodeCount, 0);
});

test("separa componentes cíclicos aunque existan aristas entre ellos", () => {
  const ideas = [
    { ...idea("scc-a"), relatedIdeaIds: ["scc-b"] },
    { ...idea("scc-b"), relatedIdeaIds: ["scc-a", "scc-c"] },
    { ...idea("scc-c"), relatedIdeaIds: ["scc-d"] },
    { ...idea("scc-d"), relatedIdeaIds: ["scc-c", "scc-e"] },
    { ...idea("scc-e"), relatedIdeaIds: [] },
    { ...idea("scc-f"), relatedIdeaIds: ["scc-g"] },
    { ...idea("scc-g"), relatedIdeaIds: ["scc-f"] },
    idea("scc-isolated")
  ];

  const graph = analyzeGraph(ideas);
  assert.equal(graph.cycleCount, 3);
  assert.deepEqual(graph.cycles.map(cycle => cycle.ideaIds), [
    ["scc-a", "scc-b"],
    ["scc-c", "scc-d"],
    ["scc-f", "scc-g"]
  ]);
  assert.equal(graph.weakComponentCount, 3);
  assert.equal(graph.largestWeakComponentSize, 5);
  assert.equal(graph.isolatedWithinSnapshotNodeCount, 1);
});

test("conserva ciclos, reciprocidad y orden estable con índices compactos", () => {
  const ideas = [
    { ...idea("a", "memoria espejo luz"), relatedIdeaIds: ["á", "z", "ghost"] },
    { ...idea("á", "memoria espejo destino"), relatedIdeaIds: ["z"] },
    { ...idea("z", "memoria horizonte origen"), relatedIdeaIds: ["a"] }
  ];
  const graph = analyzeGraph(ideas);
  const reordered = analyzeGraph([...ideas].reverse());

  assert.deepEqual(reordered, graph);
  assert.equal(graph.referenceCount, 5);
  assert.equal(graph.includedReferenceCount, 4);
  assert.equal(graph.notIncludedReferenceCount, 1);
  assert.equal(graph.missingFromProjectReferenceCount, 1);
  assert.equal(graph.reciprocalReferencePairCount, 1);
  assert.equal(graph.cycleCount, 1);
  assert.deepEqual(graph.cycles[0].ideaIds, ["a", "á", "z"]);
  assert.equal(graph.weakComponentCount, 1);
  assert.equal(graph.largestWeakComponentSize, 3);
  assert.deepEqual(graph.references[0], {
    fromIdeaId: "a",
    toIdeaId: "á",
    resolution: "included-in-snapshot"
  });
  assert.equal(
    graph.references.find(reference => reference.toIdeaId === "ghost").resolution,
    "missing-from-project"
  );
});

test("rechaza una auto-referencia en el catálogo persistible de ideas", () => {
  assert.throws(
    () => analyzeGraph([
      { ...idea("self-loop"), relatedIdeaIds: ["self-loop"] },
      idea("no-loop")
    ]),
    /catálogo global de ideas del análisis literario es inválido/
  );
});

test("memoiza el grafo completo, aísla las respuestas e invalida cambios estructurales", () => {
  const ideas = [
    { ...idea("graph-a", "memoria espejo luz"), relatedIdeaIds: ["graph-b"] },
    { ...idea("graph-b", "memoria espejo destino"), relatedIdeaIds: ["graph-a"] }
  ];
  const first = analyzeGraph(ideas);
  assert.equal(first.cycleCount, 1);
  assert.equal(first.referenceCount, 2);
  const expected = structuredClone(first);

  first.nodes[0].statusHistory[0].reason = "mutación externa";
  first.cycles[0].ideaIds.pop();
  first.references[0].resolution = "external-mutation";
  first.statusProfiles[0].ideaCount = 999;
  const repeated = analyzeGraph(ideas);
  assert.deepEqual(repeated, expected);

  const changed = analyzeGraph([
    ideas[0],
    {
      ...ideas[1],
      status: "incorporated",
      relatedIdeaIds: [],
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 1 },
        { status: "incorporated", reason: "writer", changedAt: 2 }
      ],
      writerDecisionCount: 1
    }
  ]);
  assert.equal(changed.cycleCount, 0);
  assert.equal(changed.referenceCount, 1);
  assert.equal(changed.nodes.find(node => node.ideaId === "graph-b").status, "incorporated");
  assert.equal(changed.statusProfiles.find(profile => profile.status === "incorporated").ideaCount, 1);
});

test("invalida la caché ante cambios de evidencia y decisiones editoriales", () => {
  const original = {
    ...idea("metadata-a", "memoria espejo luz"),
    status: "incorporated",
    statusHistory: [
      { status: "IDEA", reason: "initial", changedAt: 1 },
      { status: "incorporated", reason: "writer", changedAt: 2 }
    ],
    evidenceCount: 1,
    staleEvidenceCount: 0,
    writerDecisionCount: 1
  };
  const initial = analyzeGraph([original]);
  assert.equal(initial.nodes[0].activeEvidenceCount, 1);
  assert.equal(initial.nodes[0].writerDecisionCount, 1);
  assert.equal(initial.statusProfiles[0].activeEvidenceCount, 1);
  assert.equal(initial.statusProfiles[0].statusHistoryRecordCount, 2);

  const revised = analyzeGraph([{
    ...original,
    evidenceCount: 4,
    staleEvidenceCount: 2,
    status: "IDEA",
    writerDecisionCount: 2,
    omittedStatusHistoryCount: 1,
    statusHistory: [
      { status: "incorporated", reason: "writer", changedAt: 2 },
      { status: "IDEA", reason: "writer", changedAt: 3 }
    ]
  }]);
  assert.equal(revised.nodes[0].activeEvidenceCount, 4);
  assert.equal(revised.nodes[0].staleEvidenceCount, 2);
  assert.equal(revised.nodes[0].writerDecisionCount, 2);
  assert.equal(revised.nodes[0].omittedStatusHistoryCount, 1);
  assert.equal(revised.nodes[0].statusHistory.length, 2);
  assert.equal(revised.statusProfiles[0].activeEvidenceCount, 4);
  assert.equal(revised.statusProfiles[0].staleEvidenceCount, 2);
  assert.equal(revised.statusProfiles[0].writerDecisionCount, 2);
  assert.equal(revised.statusProfiles[0].statusHistoryRecordCount, 2);
  assert.equal(revised.statusProfiles[0].omittedStatusHistoryCount, 1);
});

test("invalida la caché al cambiar el alcance o la integridad del catálogo", () => {
  const ideas = [
    { ...idea("scope-a", "memoria espejo luz"), relatedIdeaIds: ["outside"] }
  ];

  const fallback = analyzeGraph(ideas, { projectCatalog: false });
  assert.equal(fallback.catalogScope, "character-linked-fallback");
  assert.equal(fallback.projectCatalogComplete, false);
  assert.equal(fallback.missingFromProjectReferenceCount, 0);

  const complete = analyzeGraph(ideas, { projectCatalog: true });
  assert.equal(complete.catalogScope, "project");
  assert.equal(complete.projectCatalogComplete, true);
  assert.equal(complete.missingFromProjectReferenceCount, 1);
  assert.equal(complete.references[0].resolution, "missing-from-project");

  const incomplete = analyzeGraph(ideas, {
    projectCatalog: true,
    omittedIdeaCount: 1
  });
  assert.equal(incomplete.catalogScope, "project");
  assert.equal(incomplete.projectCatalogComplete, false);
  assert.equal(incomplete.omittedIdeaCount, 1);
  assert.equal(incomplete.missingFromProjectReferenceCount, 0);
  assert.equal(incomplete.references[0].resolution, "not-in-snapshot");
});

test("agrega métricas globales y por estado de forma coherente", () => {
  const ideas = [
    {
      ...idea("aggregate-a", "memoria espejo"),
      relatedIdeaIds: ["aggregate-b", "outside-snapshot"],
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 1 },
        { status: "incorporated", reason: "writer", changedAt: 2 },
        { status: "IDEA", reason: "writer", changedAt: 3 }
      ],
      writerDecisionCount: 2,
      evidenceCount: 3,
      staleEvidenceCount: 1
    },
    {
      ...idea("aggregate-b", "destino horizonte"),
      status: "incorporated",
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 1 },
        { status: "incorporated", reason: "writer", changedAt: 2 }
      ],
      writerDecisionCount: 1,
      staleEvidenceCount: 2
    },
    {
      ...idea("aggregate-c", "ceniza bruma"),
      status: "discarded",
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 1 },
        { status: "discarded", reason: "writer", changedAt: 2 }
      ],
      writerDecisionCount: 1,
      evidenceCount: 1
    }
  ];
  const graph = analyzeGraph(ideas);
  const profile = status => graph.statusProfiles.find(item => item.status === status);

  assert.equal(graph.referenceCount, 2);
  assert.equal(graph.includedReferenceCount, 1);
  assert.equal(graph.notIncludedReferenceCount, 1);
  assert.equal(graph.sourceNodeCount, 2);
  assert.equal(graph.terminalWithinSnapshotNodeCount, 2);
  assert.equal(graph.isolatedWithinSnapshotNodeCount, 1);
  const ideaProfile = profile("IDEA");
  assert.deepEqual({
    ideaCount: ideaProfile.ideaCount,
    sourceIdeaCount: ideaProfile.sourceIdeaCount,
    terminalWithinSnapshotIdeaCount: ideaProfile.terminalWithinSnapshotIdeaCount,
    isolatedWithinSnapshotIdeaCount: ideaProfile.isolatedWithinSnapshotIdeaCount,
    incomingReferenceCount: ideaProfile.incomingReferenceCount,
    includedOutgoingReferenceCount: ideaProfile.includedOutgoingReferenceCount,
    notIncludedOutgoingReferenceCount: ideaProfile.notIncludedOutgoingReferenceCount,
    statusHistoryRecordCount: ideaProfile.statusHistoryRecordCount,
    omittedStatusHistoryCount: ideaProfile.omittedStatusHistoryCount,
    writerDecisionCount: ideaProfile.writerDecisionCount,
    activeEvidenceCount: ideaProfile.activeEvidenceCount,
    staleEvidenceCount: ideaProfile.staleEvidenceCount,
    ideasWithActiveEvidenceCount: ideaProfile.ideasWithActiveEvidenceCount,
    ideasWithStaleEvidenceCount: ideaProfile.ideasWithStaleEvidenceCount,
    ideasWithoutActiveEvidenceCount: ideaProfile.ideasWithoutActiveEvidenceCount
  }, {
    ideaCount: 1,
    sourceIdeaCount: 1,
    terminalWithinSnapshotIdeaCount: 0,
    isolatedWithinSnapshotIdeaCount: 0,
    incomingReferenceCount: 0,
    includedOutgoingReferenceCount: 1,
    notIncludedOutgoingReferenceCount: 1,
    statusHistoryRecordCount: 3,
    omittedStatusHistoryCount: 0,
    writerDecisionCount: 2,
    activeEvidenceCount: 3,
    staleEvidenceCount: 1,
    ideasWithActiveEvidenceCount: 1,
    ideasWithStaleEvidenceCount: 1,
    ideasWithoutActiveEvidenceCount: 0
  });
  assert.equal(profile("incorporated").ideaCount, 1);
  assert.equal(profile("incorporated").incomingReferenceCount, 1);
  assert.equal(profile("incorporated").terminalWithinSnapshotIdeaCount, 1);
  assert.equal(profile("incorporated").statusHistoryRecordCount, 2);
  assert.equal(profile("incorporated").activeEvidenceCount, 0);
  assert.equal(profile("incorporated").ideasWithoutActiveEvidenceCount, 1);
  assert.equal(profile("discarded").isolatedWithinSnapshotIdeaCount, 1);
  assert.equal(profile("discarded").activeEvidenceCount, 1);
});

test("detecta resonancias por términos literales compartidos sin alterar el grafo", () => {
  const ideas = [
    idea("idea-a", "La luz revela la memoria del espejo"),
    idea("idea-b", "El espejo conserva la memoria y la luz"),
    idea("idea-c", "La tormenta golpea las ventanas cerradas")
  ];
  const result = analyze(ideas);

  assert.equal(result.inputIdeaCount, 3);
  assert.equal(result.analyzedIdeaCount, 3);
  assert.equal(result.candidatePairCount, 1);
  assert.equal(result.resonances.length, 1);
  assert.equal(result.resonances[0].leftIdeaId, "idea-a");
  assert.equal(result.resonances[0].rightIdeaId, "idea-b");
  assert.equal(result.resonances[0].sharedTermCount, 3);
  assert.equal(result.resonances[0].jaccardSimilarity, 0.6);
  assert.equal(result.resonances[0].overlapCoefficient, 0.75);
  assert.deepEqual(result.resonances[0].sharedTerms, ["espejo", "luz", "memoria"]);
  assert.deepEqual(ideas.map(item => item.relatedIdeaIds), [[], [], []]);
});

test("reutiliza una instantánea léxica exacta sin exponer el objeto interno de caché", () => {
  const ideas = [
    idea("cache-a", "memoria espejo luz"),
    idea("cache-b", "memoria espejo destino")
  ];
  const first = analyze(ideas);
  assert.equal(first.resonances.length, 1);
  first.resonances[0].sharedTerms[0] = "mutación externa";

  const repeated = analyze(ideas);
  assert.deepEqual(repeated.resonances[0].sharedTerms, ["espejo", "memoria"]);

  const changed = analyze([
    ideas[0],
    idea("cache-b", "tormenta ventanas cerradas")
  ]);
  assert.equal(changed.candidatePairCount, 0);
  assert.deepEqual(changed.resonances, []);
});

test("excluye términos ubicuos para evitar coincidencias poco informativas", () => {
  const ideas = Array.from({ length: 41 }, (_, index) => idea(
    "idea-" + String(index).padStart(2, "0"),
    "secreto misterio concepto" + String(index).padStart(2, "0")
  ));
  const result = analyze(ideas);

  assert.equal(result.inputIdeaCount, 41);
  assert.equal(result.maxTermDocumentFrequency, 17);
  assert.equal(result.ignoredHighFrequencyTermCount, 2);
  assert.equal(result.candidatePairCount, 0);
  assert.deepEqual(result.resonances, []);
});

test("adapta el filtro de términos ubicuos a catálogos pequeños", () => {
  const ideas = Array.from({ length: 10 }, (_, index) => idea(
    "small-" + String(index).padStart(2, "0"),
    "memoria concepto" + String(index).padStart(2, "0")
  ));
  const result = analyze(ideas);

  assert.equal(result.maxTermDocumentFrequency, 4);
  assert.equal(result.ignoredHighFrequencyTermCount, 1);
  assert.equal(result.candidatePairCount, 0);
});

test("conserva términos de alfabetos Unicode sin distinción de mayúsculas", () => {
  const result = analyze([
    idea("idea-a", "月光 森林 静寂"),
    idea("idea-b", "月光 森林 海辺")
  ]);

  assert.equal(result.candidatePairCount, 1);
  assert.equal(result.resonances[0].sharedTerms.length, 2);
  assert.ok(result.resonances[0].sharedTerms.includes("月光"));
  assert.ok(result.resonances[0].sharedTerms.includes("森林"));
});

test("normaliza Unicode compuesto y conserva las marcas diacríticas", () => {
  const result = analyze([
    idea("idea-a", "CAFÉ memoria energía bosque"),
    idea("idea-b", "cafe\u0301 MEMORIA energi\u0301a BOSQUE")
  ]);

  assert.equal(result.candidatePairCount, 1);
  assert.equal(result.resonances[0].sharedTermCount, 4);
  assert.ok(result.resonances[0].sharedTerms.includes("café"));
  assert.ok(result.resonances[0].sharedTerms.includes("energía"));
});

test("limita la muestra de términos sin alterar las métricas completas", () => {
  const shared = [
    "alborada","bruma","ceniza","destello","enigma",
    "fragilidad","horizonte","instante","lumbre","memoria",
    "nostalgia","origen","penumbra","quietud","refugio"
  ].join(" ");
  const result = analyze([
    idea("idea-a", shared + " aurora"),
    idea("idea-b", shared + " travesía")
  ]);

  assert.equal(result.candidatePairCount, 1);
  assert.equal(result.resonances[0].sharedTermCount, 15);
  assert.equal(result.resonances[0].sharedTerms.length, 12);
  assert.equal(result.resonances[0].omittedSharedTermCount, 3);
  assert.equal(result.resonances[0].jaccardSimilarity, 0.882);
});

test("ordena los candidatos de forma determinista aunque cambie el orden de entrada", () => {
  const ideas = [
    idea("idea-c", "alborada bruma horizonte"),
    idea("idea-a", "memoria espejo luz"),
    idea("idea-b", "ceniza viento destino"),
    idea("idea-d", "memoria espejo destino")
  ];

  const forward = analyze(ideas);
  const reversed = analyze([...ideas].reverse());
  assert.deepEqual(forward, reversed);
  assert.equal(forward.candidatePairCount, 1);
  assert.equal(forward.resonances[0].leftIdeaId, "idea-a");
  assert.equal(forward.resonances[0].rightIdeaId, "idea-d");
});

test("limita la salida a los cien pares mejor clasificados y declara el excedente", () => {
  const ideas = Array.from({ length: 101 }, (_, index) => {
    const suffix = String(index).padStart(3, "0");
    return [
      idea("idea-a-" + suffix, "memoria" + suffix + " simbolo" + suffix + " origen" + suffix),
      idea("idea-b-" + suffix, "memoria" + suffix + " simbolo" + suffix + " destino" + suffix)
    ];
  }).flat();
  const result = analyze(ideas);

  assert.equal(result.maxTermDocumentFrequency, 40);
  assert.equal(result.candidatePairCount, 101);
  assert.equal(result.resonances.length, 100);
  assert.equal(result.omittedCandidatePairCount, 1);
  assert.equal(result.resonances[0].leftIdeaId, "idea-a-000");
  assert.equal(result.resonances[99].leftIdeaId, "idea-a-099");
});

test("ordena por Jaccard completo cuando los valores presentados redondean igual", () => {
  const words = (prefix, count) => Array.from({ length: count }, (_, index) =>
    prefix + String(index).padStart(3, "0")
  ).join(" ");
  const result = analyze([
    idea("a-left", "commonalpha commonbeta " + words("alefttoken", 98)),
    idea("a-right", "commonalpha commonbeta " + words("arighttoken", 98)),
    idea("b-left", "commoncharlie commondelta " + words("blefttoken", 98)),
    idea("b-right", "commoncharlie commondelta " + words("brighttoken", 97))
  ]);

  assert.equal(result.candidatePairCount, 2);
  assert.equal(result.resonances[0].leftIdeaId, "b-left");
  assert.equal(result.resonances[0].rightIdeaId, "b-right");
  assert.equal(result.resonances[0].jaccardSimilarity, 0.01);
  assert.equal(result.resonances[1].leftIdeaId, "a-left");
  assert.equal(result.resonances[1].jaccardSimilarity, 0.01);
});

test("respeta el presupuesto global de texto sin dividir una idea a medias", () => {
  const repeatedIdeaText = "memoria ".repeat(12_500);
  const ideas = Array.from({ length: 21 }, (_, index) => idea(
    "idea-" + String(index).padStart(2, "0"),
    repeatedIdeaText
  ));
  const result = analyze(ideas);

  assert.equal(result.inputIdeaCount, 21);
  assert.equal(result.analyzedIdeaCount, 20);
  assert.equal(result.omittedTextBudgetIdeaCount, 1);
  assert.equal(result.tokenizedTextUnitCount, 2_000_000);
  assert.equal(result.candidatePairCount, 0);
});

test("rechaza metadatos de omisión incompatibles con el contrato", () => {
  assert.throws(
    () => analyze([{ ...idea("idea-invalid"), textOmitted: "unknown" }]),
    /catálogo global de ideas del análisis literario es inválido/
  );
  assert.throws(
    () => analyze([{ ...idea("idea-invalid-text", "memoria"), textOmitted: "budget" }]),
    /catálogo global de ideas del análisis literario es inválido/
  );
});

test("distingue textos omitidos por presupuesto de textos ausentes en adaptadores antiguos", () => {
  const result = analyze([{ ...idea("idea-budget"), textOmitted: "budget" }]);

  assert.equal(result.inputIdeaCount, 1);
  assert.equal(result.analyzedIdeaCount, 0);
  assert.equal(result.ideasWithoutTextCount, 0);
  assert.equal(result.omittedTextBudgetIdeaCount, 1);
});

test("mantiene compatibilidad con catálogos antiguos que no transfieren el texto", () => {
  const result = analyze([idea("idea-legacy")]);

  assert.equal(result.inputIdeaCount, 1);
  assert.equal(result.analyzedIdeaCount, 0);
  assert.equal(result.ideasWithoutTextCount, 1);
  assert.equal(result.candidatePairCount, 0);
  assert.deepEqual(result.resonances, []);
});

test("filtra palabras funcionales portuguesas y conserva los términos narrativos", () => {
  const result = analyze([
    idea("pt-a", "A casa do menino e da menina"),
    idea("pt-b", "O menino da casa com a menina")
  ]);
  assert.equal(result.candidatePairCount, 1);
  assert.deepEqual(result.resonances[0].sharedTerms, ["casa", "menina", "menino"]);
  assert.equal(result.resonances[0].sharedTermCount, 3);
});
