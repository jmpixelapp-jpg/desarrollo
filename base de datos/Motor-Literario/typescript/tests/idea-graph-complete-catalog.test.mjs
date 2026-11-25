import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi } from "../dist/motor-literario.js";

const projectId = "complete-idea-graph";
const store = {
  documents: new Map(),
  entities: [{
    projectId, id:"character-ana", kind:"character", canonicalName:"Ana",
    normalizedName:"ana", aliases:[], evidence:[], firstSeenAt:1, lastSeenAt:1,
    extractionVersion:1
  }],
  ideas: [
    { projectId, id:"origin", text:"La luz revela la memoria del espejo", status:"IDEA", originDocumentId:"chapter",
      sourceProjectName:"Book", evidence:[], relatedIdeaIds:["bridge"], relatedEntityIds:["character-ana"],
      statusHistory:[{status:"IDEA",reason:"initial",changedAt:1}] },
    { projectId, id:"bridge", text:"El espejo conserva la memoria y la luz", status:"IDEA", originDocumentId:"chapter",
      sourceProjectName:"Book", evidence:[], relatedIdeaIds:["finish","origin"], relatedEntityIds:[],
      statusHistory:[{status:"IDEA",reason:"initial",changedAt:1}] },
    { projectId, id:"finish", text:"Idea finish", status:"IDEA", originDocumentId:"chapter",
      sourceProjectName:"Book", evidence:[], relatedIdeaIds:["origin"], relatedEntityIds:[],
      statusHistory:[{status:"IDEA",reason:"initial",changedAt:1}] },
    { projectId, id:"solo", text:"Independent idea", status:"IDEA", originDocumentId:"chapter",
      sourceProjectName:"Book", evidence:[], relatedIdeaIds:["ghost","solo"], relatedEntityIds:[],
      statusHistory:[{status:"IDEA",reason:"initial",changedAt:1}] }
  ],
  async saveDocument(doc) { this.documents.set(doc.projectId+":"+doc.documentId,structuredClone(doc)); },
  async loadDocument(project,id) {
    const value=this.documents.get(project+":"+id); return value?structuredClone(value):undefined;
  },
  async loadDocumentWithChanges(project,id) { return {document:await this.loadDocument(project,id),changes:[]}; },
  async loadIdeas(project) { return this.ideas.filter(item=>item.projectId===project).map(item=>structuredClone(item)); },
  async loadEntities(project) { return this.entities.filter(item=>item.projectId===project).map(item=>structuredClone(item)); }
};

test("el grafo incluye ideas independientes y reutiliza texto de ideas vinculadas", async () => {
  const api = new HostEngineApi({store});
  assert.equal(api.getCapabilities().projectWideNarrativeIdeaGraph, true);
  assert.equal(api.getCapabilities().authorMarkedIdeaCapture, false);
  assert.equal(api.getCapabilities().explicitIdeaLinks, false);
  api.initializeProject({projectId,projectName:"Book",writerId:"writer-graph"});
  await api.openDocument({documentId:"chapter",text:"Escena 1\nLa tarde avanza.",revision:0,sequence:0});
  try {
    const result=await api.analyzeLiteraryDocument("chapter");
    assert.equal(result.characterNarrativeTrajectories.linkedIdeaCount,1);
    assert.equal(result.ideaGraph.catalogScope,"project");
    assert.equal(result.ideaGraph.projectCatalogComplete,true);
    assert.equal(result.ideaGraph.ideaCount,4);
    assert.equal(result.ideaGraph.lexicalResonances.analyzedIdeaCount,4);
    assert.equal(result.ideaGraph.lexicalResonances.ideasWithoutTextCount,0);
    assert.equal(result.ideaGraph.lexicalResonances.candidatePairCount,1);
    assert.deepEqual(
      result.ideaGraph.lexicalResonances.resonances[0].sharedTerms,
      ["espejo","luz","memoria"]
    );
    assert.equal(result.ideaGraph.referenceCount,6);
    assert.equal(result.ideaGraph.includedReferenceCount,5);
    assert.equal(result.ideaGraph.notIncludedReferenceCount,1);
    assert.equal(result.ideaGraph.reciprocalReferencePairCount,1);
    assert.equal(result.ideaGraph.selfReferenceCount,1);
    assert.equal(result.ideaGraph.missingFromProjectReferenceCount,1);
    assert.equal(
      result.ideaGraph.references.find(reference => reference.toIdeaId === "ghost").resolution,
      "missing-from-project"
    );
    assert.equal(result.ideaGraph.cycleCount,2);
    assert.deepEqual(result.ideaGraph.cycles.map(cycle => cycle.ideaIds),[
      ["bridge","finish","origin"], ["solo"]
    ]);
    assert.equal(result.ideaGraph.weakComponentCount,2);
    assert.equal(result.ideaGraph.largestWeakComponentSize,3);

    // La respuesta es propiedad del consumidor: mutarla no debe envenenar la caché.
    result.ideaGraph.cycles[0].ideaIds[0] = "corrupted";
    result.ideaGraph.references[0].fromIdeaId = "corrupted";
    result.ideaGraph.weakComponents[0].ideaIds[0] = "corrupted";
    result.ideaGraph.nodes[0].statusHistory[0].status = "discarded";
    const repeated = (await api.analyzeLiteraryDocument("chapter")).ideaGraph;
    assert.deepEqual(repeated.cycles.map(cycle => cycle.ideaIds), [
      ["bridge","finish","origin"], ["solo"]
    ]);
    assert.equal(repeated.references[0].fromIdeaId, "bridge");
    assert.equal(repeated.weakComponents[0].ideaIds[0], "bridge");
    assert.equal(repeated.nodes[0].statusHistory[0].status, "IDEA");
  } finally { api.dispose(); }
});


test("separa componentes cíclicos ante aristas cruzadas entre subgrafos", async () => {
  const links = {
    a: ["b"],
    b: ["c", "d"],
    c: ["a"],
    d: ["e"],
    e: ["d", "f"],
    f: ["f"],
    g: ["a"],
    h: ["g"]
  };
  const ideas = Object.entries(links).map(([id, relatedIdeaIds]) => ({
    projectId,
    id,
    text: "Idea " + id,
    status: "IDEA",
    originDocumentId: "chapter",
    sourceProjectName: "Book",
    evidence: [],
    relatedIdeaIds,
    relatedEntityIds: [],
    statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
  }));
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-scc" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\nLa estructura se conecta.",
    revision: 0,
    sequence: 0
  });
  try {
    const graph = (await api.analyzeLiteraryDocument("chapter")).ideaGraph;
    assert.equal(graph.ideaCount, 8);
    assert.equal(graph.referenceCount, 10);
    assert.equal(graph.includedReferenceCount, 10);
    assert.equal(graph.cycleCount, 3);
    assert.deepEqual(graph.cycles.map(cycle => cycle.ideaIds), [
      ["a", "b", "c"],
      ["d", "e"],
      ["f"]
    ]);
    assert.equal(graph.weakComponentCount, 1);
    assert.equal(graph.largestWeakComponentSize, 8);
  } finally {
    api.dispose();
  }
});

test("el anfitrión respeta el presupuesto de texto del catálogo global", async () => {
  const budgetStore = {
    documents: new Map(),
    ideas: Array.from({ length: 21 }, (_, index) => ({
      projectId,
      id: "budget-idea-" + String(index).padStart(2, "0"),
      text: "memoria ".repeat(12_500),
      status: "IDEA",
      originDocumentId: "chapter",
      sourceProjectName: "Book",
      evidence: [],
      relatedIdeaIds: [],
      relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    })),
    async saveDocument(doc) { this.documents.set(doc.projectId + ":" + doc.documentId, structuredClone(doc)); },
    async loadDocument(project, id) {
      const value = this.documents.get(project + ":" + id);
      return value ? structuredClone(value) : undefined;
    },
    async loadDocumentWithChanges(project, id) {
      return { document: await this.loadDocument(project, id), changes: [] };
    },
    async loadIdeas(project) {
      return this.ideas.filter(item => item.projectId === project).map(item => structuredClone(item));
    },
    async loadEntities() { return []; }
  };
  const api = new HostEngineApi({ store: budgetStore });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-budget" });
  await api.openDocument({
    documentId: "chapter", text: "Escena 1\\nLa tarde avanza.", revision: 0, sequence: 0
  });
  try {
    const result = await api.analyzeLiteraryDocument("chapter");
    assert.equal(result.ideaGraph.ideaCount, 21);
    assert.equal(result.ideaGraph.lexicalResonances.analyzedIdeaCount, 20);
    assert.equal(result.ideaGraph.lexicalResonances.ideasWithoutTextCount, 0);
    assert.equal(result.ideaGraph.lexicalResonances.omittedTextBudgetIdeaCount, 1);
    assert.equal(result.ideaGraph.lexicalResonances.tokenizedTextUnitCount, 2_000_000);
  } finally {
    api.dispose();
  }
});

test("declara la capacidad de grafo global solo cuando puede leer ideas y fichas", () => {
  for (const incompleteStore of [
    { ...store, loadIdeas: undefined },
    { ...store, loadEntities: undefined }
  ]) {
    const api = new HostEngineApi({ store: incompleteStore });
    assert.equal(api.getCapabilities().projectWideNarrativeIdeaGraph, false);
    api.dispose();
  }
});



test("no presenta como catálogo global completo un almacenamiento sin lectura de ideas", async () => {
  const api = new HostEngineApi({ store: { ...store, loadIdeas: undefined } });
  assert.equal(api.getCapabilities().projectWideNarrativeIdeaGraph, false);
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-graph" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\nLa tarde avanza.",
    revision: 0,
    sequence: 0
  });
  try {
    const graph = (await api.analyzeLiteraryDocument("chapter")).ideaGraph;
    assert.equal(graph.catalogScope, "character-linked-fallback");
    assert.equal(graph.projectCatalogComplete, false);
    assert.equal(graph.ideaCount, 0);
    assert.equal(graph.missingFromProjectReferenceCount, 0);
  } finally {
    api.dispose();
  }
});

test("limita la muestra y clasifica referencias a ideas fuera del snapshot", async () => {
  const largeStore = {
    ...store,
    documents: new Map(),
    ideas: Array.from({ length: 2_005 }, (_, index) => ({
      projectId,
      id: "idea-" + String(index).padStart(4, "0"),
      text: "Idea independiente " + index,
      status: "IDEA",
      originDocumentId: "chapter",
      sourceProjectName: "Book",
      evidence: [],
      relatedIdeaIds: index < 20
        ? index === 0
          ? [
              ...Array.from({ length: 499 }, (_, targetIndex) =>
                "idea-" + String(targetIndex + 20).padStart(4, "0")
              ),
              "idea-2004"
            ]
          : Array.from({ length: 500 }, (_, targetIndex) =>
              "idea-" + String(targetIndex + index + 20).padStart(4, "0")
            )
        : index >= 539 && index < 749
          ? ["idea-" + String(index % 2 === 1 ? index + 1 : index - 1).padStart(4, "0")]
          : [],
      relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    }))
  };
  const api = new HostEngineApi({ store: largeStore });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-graph" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\nLa tarde avanza.",
    revision: 0,
    sequence: 0
  });
  try {
    const graph = (await api.analyzeLiteraryDocument("chapter")).ideaGraph;
    assert.equal(graph.catalogScope, "project");
    assert.equal(graph.projectCatalogComplete, false);
    assert.equal(graph.ideaCount, 2_000);
    assert.equal(graph.omittedIdeaCount, 5);
    assert.equal(graph.weakComponentCount, 1_357);
    assert.equal(graph.omittedWeakComponentCount, 1_257);
    assert.equal(graph.weakComponents.length, 100);
    assert.equal(graph.largestWeakComponentSize, 539);
    assert.equal(graph.isolatedWithinSnapshotNodeCount, 1_251);
    assert.equal(graph.referenceCount, 10_210);
    assert.equal(graph.includedReferenceCount, 10_209);
    assert.equal(graph.notIncludedReferenceCount, 1);
    assert.equal(graph.missingFromProjectReferenceCount, 0);
    assert.equal(graph.referenceSampleCount, 5_000);
    assert.equal(graph.omittedReferenceSampleCount, 5_210);
    assert.equal(graph.cycleCount, 105);
    assert.equal(graph.omittedCycleCount, 5);
    assert.equal(graph.cycles.length, 100);
    assert.deepEqual(graph.cycles[99].ideaIds, ["idea-0737", "idea-0738"]);
    assert.equal(graph.referencesTruncated, true);
    assert.deepEqual(graph.references[499], {
      fromIdeaId: "idea-0000",
      toIdeaId: "idea-2004",
      resolution: "not-in-snapshot"
    });
    assert.deepEqual(graph.references[500], {
      fromIdeaId: "idea-0001",
      toIdeaId: "idea-0021",
      resolution: "included-in-snapshot"
    });
    assert.equal(graph.nodes[0].notIncludedOutgoingReferenceCount, 1);
  } finally {
    api.dispose();
  }
});

test("procesa una cadena dirigida de 2.000 ideas sin clasificarla como ciclo", async () => {
  const chainStore = {
    ...store,
    documents: new Map(),
    ideas: Array.from({ length: 2_000 }, (_, index) => ({
      projectId,
      id: "chain-" + String(index).padStart(4, "0"),
      text: "Idea en cadena " + index,
      status: "IDEA",
      originDocumentId: "chapter",
      sourceProjectName: "Book",
      evidence: [],
      relatedIdeaIds: index < 1_999
        ? ["chain-" + String(index + 1).padStart(4, "0")]
        : [],
      relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    }))
  };
  const api = new HostEngineApi({ store: chainStore });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-chain" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\nLa cadena avanza.",
    revision: 0,
    sequence: 0
  });
  try {
    const graph = (await api.analyzeLiteraryDocument("chapter")).ideaGraph;
    assert.equal(graph.ideaCount, 2_000);
    assert.equal(graph.referenceCount, 1_999);
    assert.equal(graph.includedReferenceCount, 1_999);
    assert.equal(graph.notIncludedReferenceCount, 0);
    assert.equal(graph.sourceNodeCount, 1);
    assert.equal(graph.terminalWithinSnapshotNodeCount, 1);
    assert.equal(graph.isolatedWithinSnapshotNodeCount, 0);
    assert.equal(graph.weakComponentCount, 1);
    assert.equal(graph.largestWeakComponentSize, 2_000);
    assert.equal(graph.cycleCount, 0);
  } finally {
    api.dispose();
  }
});

test("agrupa referencias densas sin perder la cobertura ni duplicar ciclos", async () => {
  const denseStore = {
    ...store,
    documents: new Map(),
    ideas: Array.from({ length: 2_000 }, (_, index) => ({
      projectId,
      id: "dense-" + String(index).padStart(4, "0"),
      text: "Idea densa " + index,
      status: "IDEA",
      originDocumentId: "chapter",
      sourceProjectName: "Book",
      evidence: [],
      relatedIdeaIds: Array.from({ length: 50 }, (_, offset) =>
        "dense-" + String((index + offset + 1) % 2_000).padStart(4, "0")
      ),
      relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    }))
  };
  const api = new HostEngineApi({ store: denseStore });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-dense" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\nLa red se expande.",
    revision: 0,
    sequence: 0
  });
  try {
    const graph = (await api.analyzeLiteraryDocument("chapter")).ideaGraph;
    assert.equal(graph.projectCatalogComplete, true);
    assert.equal(graph.ideaCount, 2_000);
    assert.equal(graph.referenceCount, 100_000);
    assert.equal(graph.includedReferenceCount, 100_000);
    assert.equal(graph.notIncludedReferenceCount, 0);
    assert.equal(graph.referenceSampleCount, 5_000);
    assert.equal(graph.omittedReferenceSampleCount, 95_000);
    assert.equal(graph.referencesTruncated, true);
    assert.equal(graph.sourceNodeCount, 0);
    assert.equal(graph.terminalWithinSnapshotNodeCount, 0);
    assert.equal(graph.reciprocalReferencePairCount, 0);
    assert.equal(graph.weakComponentCount, 1);
    assert.equal(graph.largestWeakComponentSize, 2_000);
    assert.equal(graph.cycleCount, 1);
    assert.equal(graph.omittedCycleCount, 0);
    assert.equal(graph.cycles[0].ideaIds.length, 2_000);
  } finally {
    api.dispose();
  }
});

test("el anfitrión recorta IDs Unicode colacionados de forma determinista", async () => {
  const makeIdea = id => ({
    projectId,
    id,
    text: "Idea " + id,
    status: "IDEA",
    originDocumentId: "chapter",
    sourceProjectName: "Book",
    evidence: [],
    relatedIdeaIds: [],
    relatedEntityIds: [],
    statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
  });
  const prefixIdeas = Array.from({ length: 1_999 }, (_, index) =>
    makeIdea("0-" + String(index).padStart(4, "0"))
  );
  const composedIdea = makeIdea("á");
  const decomposedIdea = makeIdea("a\u0301");

  const analyzeIdeas = async ideas => {
    const api = new HostEngineApi({
      store: { ...store, documents: new Map(), ideas }
    });
    api.initializeProject({ projectId, projectName: "Book", writerId: "writer-unicode" });
    await api.openDocument({
      documentId: "chapter",
      text: "Escena 1\nEl catálogo se ordena.",
      revision: 0,
      sequence: 0
    });
    try {
      return (await api.analyzeLiteraryDocument("chapter")).ideaGraph;
    } finally {
      api.dispose();
    }
  };

  const first = await analyzeIdeas([...prefixIdeas, composedIdea, decomposedIdea]);
  const second = await analyzeIdeas([...prefixIdeas, decomposedIdea, composedIdea]);
  assert.deepEqual(second, first);
  assert.equal(first.ideaCount, 2_000);
  assert.equal(first.omittedIdeaCount, 1);
  assert.ok(first.nodes.some(node => node.ideaId === decomposedIdea.id));
  assert.equal(first.nodes.some(node => node.ideaId === composedIdea.id), false);
});


test("contrasta los componentes de Tarjan con un oráculo de alcanzabilidad en grafos deterministas", async () => {
  const graphCount = 16;
  const nodesPerGraph = 7;
  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const ideas = [];
  const expectedCycles = [];

  for (let graphIndex = 0; graphIndex < graphCount; graphIndex++) {
    const ids = Array.from({ length: nodesPerGraph }, (_, nodeIndex) =>
      "oracle-" + String(graphIndex).padStart(2, "0") + "-node-" + nodeIndex
    );
    const links = ids.map(() => []);
    for (let from = 0; from < nodesPerGraph; from++) {
      for (let to = 0; to < nodesPerGraph; to++) {
        if (random() < 0.24) links[from].push(ids[to]);
      }
    }

    // Cierre transitivo independiente: dos nodos comparten SCC si se alcanzan
    // mutuamente. No reutiliza Tarjan ni la lógica de componentes del producto.
    const reachable = links.map((targets, from) =>
      ids.map((_, to) => from === to || targets.includes(ids[to]))
    );
    for (let pivot = 0; pivot < nodesPerGraph; pivot++) {
      for (let from = 0; from < nodesPerGraph; from++) {
        for (let to = 0; to < nodesPerGraph; to++) {
          reachable[from][to] ||= reachable[from][pivot] && reachable[pivot][to];
        }
      }
    }

    const assigned = new Set();
    for (let node = 0; node < nodesPerGraph; node++) {
      if (assigned.has(node)) continue;
      const component = [];
      for (let candidate = 0; candidate < nodesPerGraph; candidate++) {
        if (reachable[node][candidate] && reachable[candidate][node]) {
          component.push(ids[candidate]);
          assigned.add(candidate);
        }
      }
      if (component.length > 1 || links[node].includes(ids[node])) {
        expectedCycles.push(component.sort());
      }
    }

    for (let node = 0; node < nodesPerGraph; node++) {
      ideas.push({
        projectId,
        id: ids[node],
        text: "Idea " + ids[node],
        status: "IDEA",
        originDocumentId: "chapter",
        sourceProjectName: "Book",
        evidence: [],
        relatedIdeaIds: links[node],
        relatedEntityIds: [],
        statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
      });
    }
  }

  const compareIds = (left, right) => left.localeCompare(right, "en") ||
    (left === right ? 0 : left < right ? -1 : 1);
  expectedCycles.sort((left, right) => compareIds(left[0], right[0]));
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-oracle" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nEl grafo se contrasta.",
    revision: 0,
    sequence: 0
  });
  try {
    const graph = (await api.analyzeLiteraryDocument("chapter")).ideaGraph;
    assert.deepEqual(
      graph.cycles.map(cycle => cycle.ideaIds),
      expectedCycles
    );
    assert.equal(graph.cycleCount, expectedCycles.length);
    assert.equal(graph.ideaCount, graphCount * nodesPerGraph);
  } finally {
    api.dispose();
  }
});


test("la resonancia léxica descarta términos ubicuos sin perder coincidencias específicas", async () => {
  const ideas = Array.from({ length: 20 }, (_, index) => {
    const isPair = index < 2;
    return {
      projectId,
      id: "lexical-frequency-" + String(index).padStart(2, "0"),
      text: isPair
        ? "amber mirror chapter uniqueleft" + index
        : "chapter isolatedterm" + index,
      status: "IDEA",
      originDocumentId: "chapter",
      sourceProjectName: "Book",
      evidence: [],
      relatedIdeaIds: [],
      relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    };
  });
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-frequency" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nLa frecuencia de términos se contrasta.",
    revision: 0,
    sequence: 0
  });
  try {
    const lexical = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(lexical.analyzedIdeaCount, 20);
    assert.equal(lexical.maxTermDocumentFrequency, 8);
    assert.equal(lexical.ignoredHighFrequencyTermCount, 1);
    assert.equal(lexical.candidatePairCount, 1);
    assert.equal(lexical.omittedCandidatePairCount, 0);
    assert.equal(lexical.resonances.length, 1);
    assert.deepEqual(lexical.resonances[0].sharedTerms, ["amber", "mirror"]);
    assert.equal(lexical.resonances[0].sharedTermCount, 2);
    assert.equal(lexical.resonances[0].leftTermCount, 4);
    assert.equal(lexical.resonances[0].rightTermCount, 4);
    assert.equal(lexical.resonances[0].jaccardSimilarity, 0.333);
    assert.equal(lexical.resonances[0].overlapCoefficient, 0.5);
  } finally {
    api.dispose();
  }
});


test("la resonancia léxica normaliza Unicode de compatibilidad y mayúsculas", async () => {
  const ideas = [
    {
      projectId, id: "unicode-normalization-a",
      text: "ＭＥＭＯＲＩＡ ＥＳＰＥＪＯ aurora horizonte",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    },
    {
      projectId, id: "unicode-normalization-b",
      text: "memoria espejo bosque silencio",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    }
  ];
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-unicode-normalization" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nLa normalización conserva el sentido.",
    revision: 0,
    sequence: 0
  });
  try {
    const lexical = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(lexical.candidatePairCount, 1);
    assert.deepEqual(lexical.resonances[0].sharedTerms, ["espejo", "memoria"]);
    assert.equal(lexical.resonances[0].sharedTermCount, 2);
  } finally {
    api.dispose();
  }
});


test("la resonancia léxica limita a cien pares y conserva el ranking determinista", async () => {
  const ids = Array.from({ length: 15 }, (_, index) =>
    "lexical-top-" + String(index).padStart(2, "0")
  );
  const termsByIdea = ids.map(() => []);
  const encode = value => {
    let result = "";
    do {
      result = String.fromCharCode(97 + value % 26) + result;
      value = Math.floor(value / 26) - 1;
    } while (value >= 0);
    return result;
  };
  let pairIndex = 0;
  const expectedPairs = [];
  for (let left = 0; left < ids.length; left++) {
    for (let right = left + 1; right < ids.length; right++) {
      const suffix = encode(pairIndex++);
      const firstTerm = "resonancealpha" + suffix;
      const secondTerm = "resonancebeta" + suffix;
      termsByIdea[left].push(firstTerm, secondTerm);
      termsByIdea[right].push(firstTerm, secondTerm);
      expectedPairs.push([ids[left], ids[right]]);
    }
  }
  const ideas = ids.map((id, index) => ({
    projectId, id, text: termsByIdea[index].join(" "),
    status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
    evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
    statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
  }));
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-top-limit" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nEl ranking de resonancias se limita.",
    revision: 0,
    sequence: 0
  });
  try {
    const lexical = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(lexical.candidatePairCount, 105);
    assert.equal(lexical.resonances.length, 100);
    assert.equal(lexical.omittedCandidatePairCount, 5);
    assert.deepEqual(
      lexical.resonances.map(pair => [pair.leftIdeaId, pair.rightIdeaId]),
      expectedPairs.slice(0, 100)
    );
    assert.ok(lexical.resonances.every(pair => pair.sharedTermCount === 2));
  } finally {
    api.dispose();
  }
});


test("la resonancia léxica limita las muestras de términos sin alterar sus métricas", async () => {
  const sharedTerms = Array.from({ length: 15 }, (_, index) =>
    "sharedresonance" + String(index).padStart(2, "0")
  );
  const ideas = [
    {
      projectId, id: "lexical-shared-a",
      text: [...sharedTerms, "exclusiveleft"].join(" "),
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    },
    {
      projectId, id: "lexical-shared-b",
      text: [...sharedTerms, "exclusiveright"].join(" "),
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    }
  ];
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-shared-limit" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nLa muestra de términos se limita.",
    revision: 0,
    sequence: 0
  });
  try {
    const lexical = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(lexical.candidatePairCount, 1);
    assert.equal(lexical.resonances.length, 1);
    const resonance = lexical.resonances[0];
    assert.equal(resonance.sharedTermCount, 15);
    assert.equal(resonance.leftTermCount, 16);
    assert.equal(resonance.rightTermCount, 16);
    assert.equal(resonance.jaccardSimilarity, 0.882);
    assert.equal(resonance.overlapCoefficient, 0.938);
    assert.deepEqual(resonance.sharedTerms, sharedTerms.slice(0, 12));
    assert.equal(resonance.omittedSharedTermCount, 3);
  } finally {
    api.dispose();
  }
});


test("la resonancia léxica aplica el límite de términos por idea según frecuencia", async () => {
  const shared = ["sharedlexicalalpha", "sharedlexicalbeta"];
  const ideas = ["lexical-term-cap-a", "lexical-term-cap-b"].map((id, index) => {
    const unique = Array.from({ length: 100 }, (_, termIndex) =>
      "exclusivelexical" + index + "term" + String(termIndex).padStart(3, "0")
    );
    return {
      projectId,
      id,
      text: [
        shared[0], shared[0], shared[0], shared[1], shared[1],
        ...unique
      ].join(" "),
      status: "IDEA",
      originDocumentId: "chapter",
      sourceProjectName: "Book",
      evidence: [],
      relatedIdeaIds: [],
      relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    };
  });
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-term-cap" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nEl vocabulario se limita por idea.",
    revision: 0,
    sequence: 0
  });
  try {
    const lexical = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(lexical.analyzedIdeaCount, 2);
    assert.equal(lexical.omittedDistinctTermCount, 4);
    assert.equal(lexical.candidatePairCount, 1);
    assert.equal(lexical.resonances.length, 1);
    assert.equal(lexical.resonances[0].leftTermCount, 100);
    assert.equal(lexical.resonances[0].rightTermCount, 100);
    assert.deepEqual(lexical.resonances[0].sharedTerms, shared);
    assert.equal(lexical.resonances[0].sharedTermCount, 2);
  } finally {
    api.dispose();
  }
});


test("la resonancia léxica excluye stopwords en español, inglés y portugués", async () => {
  const ideas = [
    {
      projectId, id: "lexical-stopwords-a",
      text: "the and la de uma para memoria espejo",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    },
    {
      projectId, id: "lexical-stopwords-b",
      text: "the la uma para memoria espejo",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    }
  ];
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-stopwords" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nSe filtran palabras funcionales multilingües.",
    revision: 0,
    sequence: 0
  });
  try {
    const lexical = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(lexical.candidatePairCount, 1);
    assert.equal(lexical.resonances.length, 1);
    assert.equal(lexical.resonances[0].leftTermCount, 2);
    assert.equal(lexical.resonances[0].rightTermCount, 2);
    assert.deepEqual(lexical.resonances[0].sharedTerms, ["espejo", "memoria"]);
  } finally {
    api.dispose();
  }
});


test("el límite léxico prioriza frecuencia antes del orden alfabético", async () => {
  const frequent = ["memoria", "memoria", "memoria", "espejo", "espejo"];
  const unique = Array.from({ length: 98 }, (_, index) =>
    "unicoa" + String(index).padStart(3, "0")
  );
  const ideas = [
    {
      projectId, id: "lexical-frequency-a",
      text: [...frequent, ...unique, "zzdiscard"].join(" "),
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    },
    {
      projectId, id: "lexical-frequency-b",
      text: "memoria espejo zzdiscard",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    }
  ];
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-frequency" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nLa frecuencia determina la selección léxica.",
    revision: 0,
    sequence: 0
  });
  try {
    const lexical = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(lexical.omittedDistinctTermCount, 1);
    assert.equal(lexical.candidatePairCount, 1);
    assert.equal(lexical.resonances[0].leftTermCount, 100);
    assert.equal(lexical.resonances[0].rightTermCount, 3);
    assert.equal(lexical.resonances[0].sharedTermCount, 2);
    assert.deepEqual(lexical.resonances[0].sharedTerms, ["espejo", "memoria"]);
  } finally {
    api.dispose();
  }
});


test("la caché de resonancia léxica no expone referencias mutables", async () => {
  const ideas = ["memoria espejo destino", "memoria espejo destino"].map((text, index) => ({
    projectId,
    id: "lexical-cache-" + index,
    text,
    status: "IDEA",
    originDocumentId: "chapter",
    sourceProjectName: "Book",
    evidence: [],
    relatedIdeaIds: [],
    relatedEntityIds: [],
    statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
  }));
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-cache" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nLa caché debe aislar sus resultados.",
    revision: 0,
    sequence: 0
  });
  try {
    const first = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.deepEqual(first.resonances[0].sharedTerms, ["destino", "espejo", "memoria"]);
    first.resonances[0].sharedTerms.push("alteracion externa");
    first.resonances[0].leftIdeaId = "mutated";
    first.resonances.push({ leftIdeaId: "injected" });

    const second = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(second.resonances.length, 1);
    assert.equal(second.resonances[0].leftIdeaId, "lexical-cache-0");
    assert.deepEqual(second.resonances[0].sharedTerms, ["destino", "espejo", "memoria"]);
  } finally {
    api.dispose();
  }
});


test("la caché léxica se invalida cuando cambia el texto de una idea", async () => {
  const ideas = ["memoria espejo destino", "memoria espejo destino"].map((text, index) => ({
    projectId,
    id: "lexical-invalidation-" + index,
    text,
    status: "IDEA",
    originDocumentId: "chapter",
    sourceProjectName: "Book",
    evidence: [],
    relatedIdeaIds: [],
    relatedEntityIds: [],
    statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
  }));
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-invalidation" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nLa actualización debe invalidar la caché.",
    revision: 0,
    sequence: 0
  });
  try {
    const before = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.deepEqual(before.resonances[0].sharedTerms, ["destino", "espejo", "memoria"]);

    ideas[1] = { ...ideas[1], text: "memoria destino" };
    const after = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(after.candidatePairCount, 1);
    assert.equal(after.resonances.length, 1);
    assert.equal(after.resonances[0].leftTermCount, 3);
    assert.equal(after.resonances[0].rightTermCount, 2);
    assert.equal(after.resonances[0].sharedTermCount, 2);
    assert.deepEqual(after.resonances[0].sharedTerms, ["destino", "memoria"]);
  } finally {
    api.dispose();
  }
});


test("la resonancia léxica excluye stopwords frecuentes en francés", async () => {
  const ideas = [
    {
      projectId, id: "lexical-french-stopwords-a",
      text: "le miroir et la mémoire avec une lumière",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    },
    {
      projectId, id: "lexical-french-stopwords-b",
      text: "la mémoire du miroir dans une nuit",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    }
  ];
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-french-stopwords" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nLes mots fonctionnels français doivent être exclus.",
    revision: 0,
    sequence: 0
  });
  try {
    const lexical = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(lexical.analyzedIdeaCount, 2);
    assert.equal(lexical.candidatePairCount, 1);
    assert.equal(lexical.resonances.length, 1);
    assert.equal(lexical.resonances[0].leftTermCount, 3);
    assert.equal(lexical.resonances[0].rightTermCount, 3);
    assert.equal(lexical.resonances[0].sharedTermCount, 2);
    assert.deepEqual(lexical.resonances[0].sharedTerms, ["mémoire", "miroir"]);
  } finally {
    api.dispose();
  }
});


test("la resonancia léxica excluye stopwords frecuentes en italiano", async () => {
  const ideas = [
    {
      projectId, id: "lexical-italian-stopwords-a",
      text: "la memoria e lo specchio con una luce",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    },
    {
      projectId, id: "lexical-italian-stopwords-b",
      text: "la memoria dello specchio nella notte",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    }
  ];
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-italian-stopwords" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nLe parole funzionali italiane devono essere escluse.",
    revision: 0,
    sequence: 0
  });
  try {
    const lexical = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(lexical.analyzedIdeaCount, 2);
    assert.equal(lexical.candidatePairCount, 1);
    assert.equal(lexical.resonances.length, 1);
    assert.equal(lexical.resonances[0].leftTermCount, 3);
    assert.equal(lexical.resonances[0].rightTermCount, 3);
    assert.equal(lexical.resonances[0].sharedTermCount, 2);
    assert.deepEqual(lexical.resonances[0].sharedTerms, ["memoria", "specchio"]);
  } finally {
    api.dispose();
  }
});

test("la resonancia léxica excluye stopwords frecuentes en alemán", async () => {
  const ideas = [
    {
      projectId, id: "lexical-german-stopwords-a",
      text: "die erinnerung und der spiegel mit einer nacht",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    },
    {
      projectId, id: "lexical-german-stopwords-b",
      text: "der spiegel in der erinnerung ohne nacht",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    }
  ];
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-german-stopwords" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nDeutsche Funktionswörter sollen ausgeschlossen werden.",
    revision: 0,
    sequence: 0
  });
  try {
    const lexical = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(lexical.analyzedIdeaCount, 2);
    assert.equal(lexical.candidatePairCount, 1);
    assert.equal(lexical.resonances.length, 1);
    assert.equal(lexical.resonances[0].leftTermCount, 3);
    assert.equal(lexical.resonances[0].rightTermCount, 3);
    assert.equal(lexical.resonances[0].sharedTermCount, 3);
    assert.deepEqual(lexical.resonances[0].sharedTerms, ["erinnerung", "nacht", "spiegel"]);
  } finally {
    api.dispose();
  }
});

test("la resonancia léxica excluye stopwords frecuentes en neerlandés", async () => {
  const ideas = [
    {
      projectId, id: "lexical-dutch-stopwords-a",
      text: "de herinnering en de spiegel met een nacht",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    },
    {
      projectId, id: "lexical-dutch-stopwords-b",
      text: "de spiegel in de herinnering zonder nacht",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    }
  ];
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-dutch-stopwords" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nNederlandse functiewoorden moeten worden uitgesloten.",
    revision: 0,
    sequence: 0
  });
  try {
    const lexical = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(lexical.analyzedIdeaCount, 2);
    assert.equal(lexical.candidatePairCount, 1);
    assert.equal(lexical.resonances.length, 1);
    assert.equal(lexical.resonances[0].leftTermCount, 3);
    assert.equal(lexical.resonances[0].rightTermCount, 3);
    assert.equal(lexical.resonances[0].sharedTermCount, 3);
    assert.deepEqual(lexical.resonances[0].sharedTerms, ["herinnering", "nacht", "spiegel"]);
  } finally {
    api.dispose();
  }
});

test("la resonancia léxica excluye stopwords frecuentes en sueco", async () => {
  const ideas = [
    {
      projectId, id: "lexical-swedish-stopwords-a",
      text: "en minne och en spegel med ett ljus",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    },
    {
      projectId, id: "lexical-swedish-stopwords-b",
      text: "en spegel i ett minne utan natt",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    }
  ];
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-swedish-stopwords" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nSvenska funktionsord ska filtreras bort.",
    revision: 0,
    sequence: 0
  });
  try {
    const lexical = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(lexical.analyzedIdeaCount, 2);
    assert.equal(lexical.candidatePairCount, 1);
    assert.equal(lexical.resonances.length, 1);
    assert.equal(lexical.resonances[0].leftTermCount, 3);
    assert.equal(lexical.resonances[0].rightTermCount, 3);
    assert.equal(lexical.resonances[0].sharedTermCount, 3);
    assert.deepEqual(lexical.resonances[0].sharedTerms, ["minne", "natt", "spegel"]);
  } finally {
    api.dispose();
  }
});

test("la resonancia léxica excluye stopwords frecuentes en danés", async () => {
  const ideas = [
    {
      projectId, id: "lexical-danish-stopwords-a",
      text: "en erindring og et spejl med en nat",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    },
    {
      projectId, id: "lexical-danish-stopwords-b",
      text: "et spejl i en erindring uden nat",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    }
  ];
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-danish-stopwords" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nDanske funktionsord skal filtreres fra.",
    revision: 0,
    sequence: 0
  });
  try {
    const lexical = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(lexical.analyzedIdeaCount, 2);
    assert.equal(lexical.candidatePairCount, 1);
    assert.equal(lexical.resonances.length, 1);
    assert.equal(lexical.resonances[0].leftTermCount, 3);
    assert.equal(lexical.resonances[0].rightTermCount, 3);
    assert.equal(lexical.resonances[0].sharedTermCount, 3);
    assert.deepEqual(lexical.resonances[0].sharedTerms, ["erindring", "nat", "spejl"]);
  } finally {
    api.dispose();
  }
});

test("la resonancia léxica excluye stopwords frecuentes en noruego", async () => {
  const ideas = [
    {
      projectId, id: "lexical-norwegian-stopwords-a",
      text: "et minne og et speil med en natt",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    },
    {
      projectId, id: "lexical-norwegian-stopwords-b",
      text: "et speil i et minne uten natt",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    }
  ];
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-norwegian-stopwords" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nNorske funksjonsord skal filtreres bort.",
    revision: 0,
    sequence: 0
  });
  try {
    const lexical = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(lexical.analyzedIdeaCount, 2);
    assert.equal(lexical.candidatePairCount, 1);
    assert.equal(lexical.resonances.length, 1);
    assert.equal(lexical.resonances[0].leftTermCount, 3);
    assert.equal(lexical.resonances[0].rightTermCount, 3);
    assert.equal(lexical.resonances[0].sharedTermCount, 3);
    assert.deepEqual(lexical.resonances[0].sharedTerms, ["minne", "natt", "speil"]);
  } finally {
    api.dispose();
  }
});


test("la resonancia léxica conserva la frecuencia de los motivos compartidos", async () => {
  const ideas = [
    {
      projectId, id: "lexical-frequency-a",
      text: "memoria memoria espejo espejo luz",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    },
    {
      projectId, id: "lexical-frequency-b",
      text: "memoria espejo luz luz luz",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Book",
      evidence: [], relatedIdeaIds: [], relatedEntityIds: [],
      statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }]
    }
  ];
  const api = new HostEngineApi({
    store: { ...store, documents: new Map(), ideas }
  });
  api.initializeProject({ projectId, projectName: "Book", writerId: "writer-lexical-frequency" });
  await api.openDocument({
    documentId: "chapter",
    text: "Escena 1\\nLa frecuencia de los motivos importa.",
    revision: 0,
    sequence: 0
  });
  try {
    const lexical = (await api.analyzeLiteraryDocument("chapter")).ideaGraph.lexicalResonances;
    assert.equal(lexical.resonances.length, 1);
    assert.deepEqual(lexical.resonances[0].sharedTerms, ["espejo", "luz", "memoria"]);
    assert.deepEqual(lexical.resonances[0].sharedTermFrequencies, [
      { term: "espejo", leftFrequency: 2, rightFrequency: 1 },
      { term: "luz", leftFrequency: 1, rightFrequency: 3 },
      { term: "memoria", leftFrequency: 2, rightFrequency: 1 }
    ]);
  } finally {
    api.dispose();
  }
});
