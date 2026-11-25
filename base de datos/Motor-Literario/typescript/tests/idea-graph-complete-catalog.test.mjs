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
      sourceProjectName:"Book", evidence:[], relatedIdeaIds:[], relatedEntityIds:[],
      statusHistory:[{status:"IDEA",reason:"initial",changedAt:1}] },
    { projectId, id:"solo", text:"Independent idea", status:"IDEA", originDocumentId:"chapter",
      sourceProjectName:"Book", evidence:[], relatedIdeaIds:[], relatedEntityIds:[],
      statusHistory:[{status:"IDEA",reason:"initial",changedAt:1}] }
  ],
  async saveDocument(doc) { this.documents.set(doc.projectId+":"+doc.documentId,structuredClone(doc)); },
  async loadDocument(project,id) {
    const value=this.documents.get(project+":"+id); return value?structuredClone(value):undefined;
  },
  async loadDocumentWithChanges(project,id) { return {document:await this.loadDocument(project,id),changes:[]}; },
  async loadIdeas(project) { return this.ideas.filter(item=>item.projectId===project).map(item=>structuredClone(item)); }
};

test("el grafo literario incluye ideas sin vínculos a personajes", async () => {
  const api = new HostEngineApi({store});
  api.initializeProject({projectId,projectName:"Book",writerId:"writer-graph"});
  await api.openDocument({documentId:"chapter",text:"Escena 1\nLa tarde avanza.",revision:0,sequence:0});
  try {
    const result=await api.analyzeLiteraryDocument("chapter");
    assert.equal(result.characterNarrativeTrajectories.linkedIdeaCount,0);
    assert.equal(result.ideaGraph.ideaCount,4);
    assert.equal(result.ideaGraph.referenceCount,2);
    assert.equal(result.ideaGraph.includedReferenceCount,2);
    assert.equal(result.ideaGraph.weakComponentCount,2);
    assert.equal(result.ideaGraph.largestWeakComponentSize,3);
  } finally { api.dispose(); }
});
