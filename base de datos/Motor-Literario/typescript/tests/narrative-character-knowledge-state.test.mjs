import test from "node:test";
import assert from "node:assert/strict";
import { buildNarrativeCharacterKnowledgeStates } from "../dist/motor-literario.js";

const entities = [
  {projectId:"story",id:"mara",kind:"character",canonicalName:"Mara",normalizedName:"mara",aliases:[],evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1},
  {projectId:"story",id:"elian",kind:"character",canonicalName:"Elian",normalizedName:"elian",aliases:[],evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1},
  {projectId:"story",id:"bridge",kind:"place",canonicalName:"Puente",normalizedName:"puente",aliases:[],evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1}
];
const ev = (documentId,start,excerpt) => ({
  documentId,revision:1,start,end:start+excerpt.length,excerpt
});
const received = {
  id:"info:mara:bridge",projectId:"story",informationHolderEntityId:"mara",
  sourceEntityId:"elian",channel:"reported-speech",status:"reported",
  content:"el puente había caído",reviewStatus:"candidate",
  evidence:ev("chapter-1",0,"Elian le contó a Mara que el puente había caído.")
};
const interpretation = {
  id:"interpretation:mara:bridge",projectId:"story",interpreterEntityId:"mara",
  signal:"explicit-misinterpretation",interpretedContent:"el puente seguía en pie",
  comparison:"different-content",reviewStatus:"candidate",
  evidence:ev("chapter-2",0,"Mara entendió mal que el puente seguía en pie.")
};
const evaluation = {
  id:"evaluation:mara:bridge",projectId:"story",evaluatorEntityId:"mara",
  evaluation:"uncertain",content:"el puente había caído",
  matchStatus:"exact-match",reviewStatus:"candidate",
  evidence:ev("chapter-3",0,"Mara dudó que el puente había caído.")
};

test("construye estado por personaje sin convertir interpretación en información recibida", () => {
  const states = buildNarrativeCharacterKnowledgeStates({
    projectId:"story",entities,information:[received],
    interpretations:[interpretation],evaluations:[evaluation],
    orderedDocumentIds:["chapter-1","chapter-2","chapter-3"]
  });
  const mara = states.find(item => item.characterEntityId === "mara");
  assert.equal(mara.summary.recordedInformationCount,1);
  assert.equal(mara.summary.interpretedInformationCount,1);
  assert.equal(mara.summary.explicitMisinterpretationCount,1);
  assert.equal(mara.summary.evaluationCount,1);
  assert.equal(mara.items[0].sourceEntityId,"elian");
  assert.equal(mara.items[0].chronology,"explicit-document-order");
  assert.equal(states.find(item => item.characterEntityId === "elian").items.length,0);
});

test("no inventa orden entre capítulos cuando no se proporciona cronología", () => {
  const states = buildNarrativeCharacterKnowledgeStates({
    projectId:"story",entities,information:[received]
  });
  assert.equal(states.find(item => item.characterEntityId === "mara").items[0].chronology,
    "cross-document-order-unknown");
});

test("ignora rumores impersonales al crear estados individuales sin rechazarlos", () => {
  const rumor = {
    id:"rumor:1",projectId:"story",channel:"rumor",status:"rumored",
    content:"el rey ha muerto",reviewStatus:"candidate",
    evidence:ev("chapter-1",60,"Se rumorea que el rey ha muerto.")
  };
  const states = buildNarrativeCharacterKnowledgeStates({
    projectId:"story",entities,information:[received,rumor]
  });
  assert.equal(states.find(item => item.characterEntityId === "mara").items.length,1);
});

test("rechaza datos de otro proyecto y evidencia inválida", () => {
  assert.throws(() => buildNarrativeCharacterKnowledgeStates({
    projectId:"story",entities,information:[{...received,projectId:"other"}]
  }));
  assert.throws(() => buildNarrativeCharacterKnowledgeStates({
    projectId:"story",entities,information:[{...received,evidence:{...received.evidence,start:-1}}]
  }));
});


test("mantiene el historial de evaluaciones y selecciona la última solo con orden demostrable", () => {
  const first = {...evaluation,id:"eval:uncertain",evaluation:"uncertain",
    evidence:ev("chapter-1",70,"Mara dudó que el puente había caído.")};
  const later = {...evaluation,id:"eval:refuted",evaluation:"refuted",
    evidence:ev("chapter-1",120,"Mara refutó que el puente había caído.")};
  const states = buildNarrativeCharacterKnowledgeStates({
    projectId:"story",entities,information:[received],
    evaluations:[first,later]
  });
  const item = states.find(state => state.characterEntityId === "mara").items[0];
  assert.equal(item.evaluations.length,2);
  assert.equal(item.currentAssessment,"refuted-by-character");
});

test("no decide qué evaluación es más reciente entre capítulos sin orden explícito", () => {
  const first = {...evaluation,id:"eval:uncertain",evaluation:"uncertain",
    evidence:ev("chapter-2",10,"Mara dudó que el puente había caído.")};
  const later = {...evaluation,id:"eval:refuted",evaluation:"refuted",
    evidence:ev("chapter-3",10,"Mara refutó que el puente había caído.")};
  const states = buildNarrativeCharacterKnowledgeStates({
    projectId:"story",entities,information:[received],
    evaluations:[first,later]
  });
  const item = states.find(state => state.characterEntityId === "mara").items[0];
  assert.equal(item.evaluations.length,2);
  assert.equal(item.currentAssessment,"chronology-unresolved");
});

test("el orden de capítulos permite reconstruir la evaluación posterior", () => {
  const first = {...evaluation,id:"eval:uncertain",evaluation:"uncertain",
    evidence:ev("chapter-2",10,"Mara dudó que el puente había caído.")};
  const later = {...evaluation,id:"eval:refuted",evaluation:"refuted",
    evidence:ev("chapter-3",10,"Mara refutó que el puente había caído.")};
  const states = buildNarrativeCharacterKnowledgeStates({
    projectId:"story",entities,information:[received],
    evaluations:[later,first],
    orderedDocumentIds:["chapter-1","chapter-2","chapter-3"]
  });
  const item = states.find(state => state.characterEntityId === "mara").items[0];
  assert.equal(item.currentAssessment,"refuted-by-character");
});


test("una evaluación anterior a la recepción no modifica el estado posterior", () => {
  const before = {...evaluation,id:"eval:before",evaluation:"refuted",
    evidence:ev("chapter-1",0,"Mara refutó que el puente había caído.")};
  const states = buildNarrativeCharacterKnowledgeStates({
    projectId:"story",entities,
    information:[{...received,evidence:ev("chapter-1",90,"Elian le contó a Mara que el puente había caído.")}],
    evaluations:[before]
  });
  const item = states.find(state => state.characterEntityId === "mara").items[0];
  assert.equal(item.evaluations.length,1);
  assert.equal(item.currentAssessment,"unassessed");
});
