import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi } from "../dist/motor-literario.js";

const projectId = "complete-idea-graph";
const store = {
  documents: new Map(),
  ideas: [
    { projectId, id:"origin", text:"Idea origin", status:"IDEA", originDocumentId:"chapter",
      sourceProjectName:"Book", evidence:[], relatedIdeaIds:["bridge"], relatedEntityIds:[],
      statusHistory:[{status:"IDEA",reason:"initial",changedAt:1}] },
    { projectId, id:"bridge", text:"Idea bridge", status:"IDEA", originDocumentId:"chapter",
      sourceProjectName:"Book", evidence:[], relatedIdeaIds:["finish"], relatedEntityIds:[],
      statusHistory:[{status:"IDEA",reason:"initial",changedAt:1}] },
    { projectId, id:"finish", text:"Idea finish", status:"IDEA", originDocumentId:"chapter",
      sourceProjectName:"Book", evidence:[], relatedIdeaIds:["origin"], relatedEntityIds:[],
      statusHistory:[{status:"IDEA",reason:"initial",changedAt:1}] },
    { projectId, id:"solo", text:"Independent idea", status:"IDEA", originDocumentId:"chapter",
      sourceProjectName:"Book", evidence:[], relatedIdeaIds:["ghost"], relatedEntityIds:[],
      statusHistory:[{status:"IDEA",reason:"initial",changedAt:1}] }
  ],
  async saveDocument(doc) { this.documents.set(doc.projectId+":"+doc.documentId,structuredClone(doc)); },
  async loadDocument(project,id) {
    const value=this.documents.get(project+":"+id); return value?structuredClone(value):undefined;
  },
  async loadDocumentWithChanges(project,id) { return {document:await this.loadDocument(project,id),changes:[]}; },
  async loadIdeas(project) { return this.ideas.filter(item=>item.projectId===project).map(item=>structuredClone(item)); },
  async loadEntities(project) { return []; }
};

test("el grafo literario incluye ideas sin vínculos a personajes", async () => {
  const api = new HostEngineApi({store});
  assert.equal(api.getCapabilities().projectWideNarrativeIdeaGraph, true);
  assert.equal(api.getCapabilities().authorMarkedIdeaCapture, false);
  assert.equal(api.getCapabilities().explicitIdeaLinks, false);
  api.initializeProject({projectId,projectName:"Book",writerId:"writer-graph"});
  await api.openDocument({documentId:"chapter",text:"Escena 1\nLa tarde avanza.",revision:0,sequence:0});
  try {
    const result=await api.analyzeLiteraryDocument("chapter");
    assert.equal(result.characterNarrativeTrajectories.linkedIdeaCount,0);
    assert.equal(result.ideaGraph.catalogScope,"project");
    assert.equal(result.ideaGraph.ideaCount,4);
    assert.equal(result.ideaGraph.referenceCount,4);
    assert.equal(result.ideaGraph.includedReferenceCount,3);
    assert.equal(result.ideaGraph.notIncludedReferenceCount,1);
    assert.equal(result.ideaGraph.missingFromProjectReferenceCount,1);
    assert.equal(
      result.ideaGraph.references.find(reference => reference.toIdeaId === "ghost").resolution,
      "missing-from-project"
    );
    assert.equal(result.ideaGraph.cycleCount,1);
    assert.deepEqual(result.ideaGraph.cycles[0].ideaIds,["bridge","finish","origin"]);
    assert.equal(result.ideaGraph.weakComponentCount,2);
    assert.equal(result.ideaGraph.largestWeakComponentSize,3);
  } finally { api.dispose(); }
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
    assert.equal(graph.ideaCount, 2_000);
    assert.equal(graph.omittedIdeaCount, 5);
    assert.equal(graph.weakComponentCount, 1_462);
    assert.equal(graph.omittedWeakComponentCount, 1_362);
    assert.equal(graph.weakComponents.length, 100);
    assert.equal(graph.largestWeakComponentSize, 539);
    assert.equal(graph.isolatedWithinSnapshotNodeCount, 1_461);
    assert.equal(graph.referenceCount, 10_000);
    assert.equal(graph.includedReferenceCount, 9_999);
    assert.equal(graph.notIncludedReferenceCount, 1);
    assert.equal(graph.missingFromProjectReferenceCount, 0);
    assert.equal(graph.referenceSampleCount, 5_000);
    assert.equal(graph.omittedReferenceSampleCount, 5_000);
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
