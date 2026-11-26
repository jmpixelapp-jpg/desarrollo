import test from "node:test";
import assert from "node:assert/strict";
import { reconstructNarrativeInformationChain } from "../dist/motor-literario.js";

const evidence = (documentId, start, excerpt) => ({
  documentId, revision:1, start, end:start+excerpt.length, excerpt
});
const acquiredByElian = {
  id:"information:chapter-1:0:visual-observation:elian",
  projectId:"book-1", informationHolderEntityId:"elian",
  channel:"visual-observation", status:"observed",
  content:"el puente había caído", reviewStatus:"candidate",
  evidence:evidence("chapter-1",0,"Elian vio que el puente había caído."),
  contentEvidence:evidence("chapter-1",14,"el puente había caído")
};
const elianTellsMara = {
  id:"information:chapter-2:0:reported-speech:mara",
  projectId:"book-1", sourceEntityId:"elian", informationHolderEntityId:"mara",
  channel:"reported-speech", status:"reported",
  content:"el puente había caído", reviewStatus:"candidate",
  evidence:evidence("chapter-2",0,"Elian le contó a Mara que el puente había caído."),
  contentEvidence:evidence("chapter-2",29,"el puente había caído"),
  sourceEvidence:evidence("chapter-2",0,"Elian"),
  holderEvidence:evidence("chapter-2",18,"Mara")
};
const maraTellsIvo = {
  id:"information:chapter-3:0:reported-speech:ivo",
  projectId:"book-1", sourceEntityId:"mara", informationHolderEntityId:"ivo",
  channel:"reported-speech", status:"reported",
  content:"el puente había caído", reviewStatus:"candidate",
  evidence:evidence("chapter-3",0,"Mara le contó a Ivo que el puente había caído."),
  contentEvidence:evidence("chapter-3",27,"el puente había caído"),
  sourceEvidence:evidence("chapter-3",0,"Mara"),
  holderEvidence:evidence("chapter-3",17,"Ivo")
};

test("reconstruye dos transmisiones sucesivas conservando cada evidencia", () => {
  const first = reconstructNarrativeInformationChain({
    projectId:"book-1", priorRecords:[acquiredByElian],
    currentRecords:[elianTellsMara]
  });
  assert.equal(first[0].linkStatus,"linked");
  assert.equal(first[0].predecessorRecordId,acquiredByElian.id);
  assert.equal(first[0].sourceEntityId,"elian");
  assert.equal(first[0].recipientEntityId,"mara");

  const second = reconstructNarrativeInformationChain({
    projectId:"book-1",
    priorRecords:[acquiredByElian,elianTellsMara],
    currentRecords:[maraTellsIvo]
  });
  assert.equal(second[0].linkStatus,"linked");
  assert.equal(second[0].predecessorRecordId,elianTellsMara.id);
  assert.equal(second[0].sourceEntityId,"mara");
  assert.equal(second[0].recipientEntityId,"ivo");
  assert.equal(second[0].predecessorEvidence.documentId,"chapter-2");
});

test("no enlaza una paráfrasis como transmisión demostrada", () => {
  const changed = {...elianTellsMara,content:"la estructura se derrumbó"};
  const result = reconstructNarrativeInformationChain({
    projectId:"book-1",priorRecords:[acquiredByElian],currentRecords:[changed]
  });
  assert.equal(result[0].linkStatus,"no-predecessor");
  assert.equal(result[0].predecessorRecordId,undefined);
});

test("marca antecedentes duplicados como ambiguos", () => {
  const duplicate = {...acquiredByElian,id:"information:chapter-x:0:visual-observation:elian"};
  const result = reconstructNarrativeInformationChain({
    projectId:"book-1",
    priorRecords:[acquiredByElian,duplicate],
    currentRecords:[elianTellsMara]
  });
  assert.equal(result[0].linkStatus,"ambiguous-predecessor");
  assert.equal(result[0].predecessorRecordId,undefined);
});

test("no inventa origen para rumores ni acepta registros de otro proyecto", () => {
  const rumor = {
    ...elianTellsMara,id:"rumor:chapter-2",sourceEntityId:undefined,
    informationHolderEntityId:undefined,channel:"rumor",status:"rumored"
  };
  const result = reconstructNarrativeInformationChain({
    projectId:"book-1",currentRecords:[rumor]
  });
  assert.equal(result[0].linkStatus,"no-predecessor");
  assert.equal(result[0].sourceEntityId,undefined);
  assert.throws(() => reconstructNarrativeInformationChain({
    projectId:"book-1",currentRecords:[{...rumor,projectId:"other"}]
  }));
});


test("enlaza transmisiones sucesivas dentro del mismo fragmento en orden textual", () => {
  const first = {...elianTellsMara, evidence:evidence("chapter-4",0,"Elian le contó a Mara que el puente había caído.")};
  const second = {...maraTellsIvo, evidence:evidence("chapter-4",60,"Mara le contó a Ivo que el puente había caído.")};
  const result = reconstructNarrativeInformationChain({
    projectId:"book-1",currentRecords:[first,second]
  });
  assert.equal(result[0].linkStatus,"no-predecessor");
  assert.equal(result[1].linkStatus,"linked");
  assert.equal(result[1].predecessorRecordId,first.id);
});
