import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrativeInformationInterpretations } from "../dist/motor-literario.js";

const entities = [
  {projectId:"book-1",id:"mara",kind:"character",canonicalName:"Mara",normalizedName:"mara",aliases:[],evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1},
  {projectId:"book-1",id:"elian",kind:"character",canonicalName:"Elian",normalizedName:"elian",aliases:[],evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1}
];
const prior = [{
  id:"prior:mara:bridge",projectId:"book-1",
  informationHolderEntityId:"mara",sourceEntityId:"elian",
  channel:"reported-speech",status:"reported",
  content:"el puente había caído",reviewStatus:"candidate",
  evidence:{documentId:"chapter-1",revision:1,start:0,end:40,excerpt:"Elian le contó a Mara que el puente había caído."},
  contentEvidence:{documentId:"chapter-1",revision:1,start:28,end:50,excerpt:"el puente había caído"}
}];
const context = {projectId:"book-1",documentId:"chapter-2",revision:2,entities,priorInformation:prior};

test("reconoce una interpretación que coincide literalmente con lo recibido", () => {
  const text = "Mara entendió que el puente había caído.";
  const found = extractNarrativeInformationInterpretations({...context,text});
  assert.equal(found.length,1);
  assert.equal(found[0].interpreterEntityId,"mara");
  assert.equal(found[0].signal,"understood");
  assert.equal(found[0].comparison,"exact-content-match");
  assert.equal(found[0].priorInformationId,"prior:mara:bridge");
});

test("registra una interpretación diferente sin declarar automáticamente que sea errónea", () => {
  const text = "Mara interpretó que el puente seguía en pie.";
  const found = extractNarrativeInformationInterpretations({...context,text});
  assert.equal(found.length,1);
  assert.equal(found[0].signal,"interpreted");
  assert.equal(found[0].comparison,"different-content");
  assert.equal(found[0].priorInformationId,"prior:mara:bridge");
});

test("solo marca deformación explícita cuando el texto la califica como error", () => {
  const text = "Mara entendió mal que el puente seguía en pie.";
  const found = extractNarrativeInformationInterpretations({...context,text});
  assert.equal(found.length,1);
  assert.equal(found[0].signal,"explicit-misinterpretation");
  assert.equal(found[0].comparison,"different-content");
});

test("mantiene ambigüedad si el personaje recibió varias informaciones previas", () => {
  const other = {...prior[0],id:"prior:mara:other",content:"la torre estaba vacía"};
  const found = extractNarrativeInformationInterpretations({
    ...context,priorInformation:[...prior,other],
    text:"Mara interpretó que el puente seguía en pie."
  });
  assert.equal(found[0].comparison,"ambiguous-prior-information");
  assert.equal(found[0].priorInformationId,undefined);
});

test("no inventa antecedentes y conserva offsets absolutos", () => {
  const text = "Mara entendió que la puerta estaba abierta.";
  const found = extractNarrativeInformationInterpretations({
    ...context,priorInformation:[],text,baseOffset:900
  });
  assert.equal(found[0].comparison,"no-prior-information");
  assert.equal(found[0].evidence.start,900);
  assert.equal(found[0].evidence.documentId,"chapter-2");
});

test("rechaza información previa de otro proyecto", () => {
  assert.throws(() => extractNarrativeInformationInterpretations({
    ...context,priorInformation:[{...prior[0],projectId:"other"}],
    text:"Mara entendió que el puente había caído."
  }));
});
