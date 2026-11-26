import test from "node:test";
import assert from "node:assert/strict";
import { detectNarrativeBehaviorEvolution } from "../dist/motor-literario.js";

const entities=[
  {id:"mara",projectId:"novel",kind:"character",canonicalName:"Mara",aliases:[]},
  {id:"elian",projectId:"novel",kind:"character",canonicalName:"Elian",aliases:[]}
];
const evidence=(documentId,excerpt,start=0,revision=1)=>({
  documentId,revision,start,end:start+excerpt.length,excerpt
});
const action=(id,verb,doc,start=0,overrides={})=>({
  id,projectId:"novel",actorEntityId:"mara",action:verb,targetEntityId:"elian",
  polarity:"affirmed",reviewStatus:"candidate",evidence:evidence(doc,`Mara ${verb} a Elian.`,start),...overrides
});

test("detecta una inversión de conducta dentro de la misma revisión",()=>{
  const [shift]=detectNarrativeBehaviorEvolution({
    projectId:"novel",entities,
    priorActions:[action("a1","atacó","chapter-1",0)],
    currentActions:[action("a2","protegió","chapter-1",40)]
  });
  assert.equal(shift.shift,"hostile-to-supportive");
  assert.equal(shift.chronology,"same-document-position");
  assert.equal(shift.previousActionId,"a1");
  assert.equal(shift.currentActionId,"a2");
});

test("solo compara capítulos distintos cuando se declara su orden",()=>{
  const prior=action("a1","atacó","chapter-1");
  const current=action("a2","ayudó","chapter-2");
  assert.deepEqual(detectNarrativeBehaviorEvolution({
    projectId:"novel",entities,priorActions:[prior],currentActions:[current]
  }),[]);
  const [shift]=detectNarrativeBehaviorEvolution({
    projectId:"novel",entities,priorActions:[prior],currentActions:[current],
    orderedDocumentIds:["chapter-1","chapter-2"]
  });
  assert.equal(shift.chronology,"explicit-document-order");
  assert.equal(shift.shift,"hostile-to-supportive");
});

test("ignora acciones negadas y no registra una repetición idéntica como cambio",()=>{
  assert.deepEqual(detectNarrativeBehaviorEvolution({
    projectId:"novel",entities,
    priorActions:[action("a1","atacó","chapter-1")],
    currentActions:[action("a2","protegió","chapter-1",40,{polarity:"negated"})]
  }),[]);
  assert.deepEqual(detectNarrativeBehaviorEvolution({
    projectId:"novel",entities,
    priorActions:[action("a1","protegió","chapter-1")],
    currentActions:[action("a2","protegió","chapter-1",40)]
  }),[]);
});

test("registra cambios de patrón aunque la valencia tentativa se mantenga",()=>{
  const [shift]=detectNarrativeBehaviorEvolution({
    projectId:"novel",entities,
    priorActions:[action("a1","ayudó","chapter-1")],
    currentActions:[action("a2","protegió","chapter-1",40)]
  });
  assert.equal(shift.shift,"action-pattern-change");
  assert.equal(shift.fromValence,"supportive");
  assert.equal(shift.toValence,"supportive");
});

test("asocia evidencia contextual al comportamiento nuevo sin declararla causa",()=>{
  const current=action("a2","ayudó","chapter-2",40);
  const [shift]=detectNarrativeBehaviorEvolution({
    projectId:"novel",entities,
    priorActions:[action("a1","atacó","chapter-1")],
    currentActions:[current],orderedDocumentIds:["chapter-1","chapter-2"],
    knowledgeActionLinks:[{
      id:"knowledge-action:info-1:a2",projectId:"novel",characterEntityId:"mara",
      informationId:"info-1",actionId:"a2",relation:"knowledge-precedes-action",
      chronology:"same-document-position",knowledgeAssessment:"unassessed",
      knowledgeChannel:"visual-observation",knowledgeStatus:"observed",
      knowledgeEvidence:evidence("chapter-2","Mara vio la herida.",0),
      actionEvidence:current.evidence,reviewStatus:"candidate"
    }],
    decisionContexts:[{
      id:"decision-context:info-1:intent-1:a2",projectId:"novel",
      characterEntityId:"mara",actionId:"a2",informationId:"info-1",intentId:"intent-1",
      alignment:"supports-intent",
      chronology:{knowledgeBeforeAction:"same-document-position",intentBeforeAction:"same-document-position"},
      knowledgeEvidence:evidence("chapter-2","Mara vio la herida.",0),
      intentEvidence:evidence("chapter-2","Mara quiso ayudar a Elian.",20),
      actionEvidence:current.evidence,reviewStatus:"candidate"
    }],
    memoryActionLinks:[{
      id:"memory-action:a2:memory-1",projectId:"novel",characterEntityId:"mara",
      memoryEventIds:["memory-1"],actionId:"a2",relation:"explicit-causal-link",
      connectorEvidence:evidence("chapter-2","por eso",35),
      memoryEvidence:[evidence("chapter-2","Mara recordó la promesa.",0)],
      actionEvidence:current.evidence,reviewStatus:"candidate"
    }],
    intentEvolution:[{
      id:"intent-evolution:intent-1",projectId:"novel",characterEntityId:"mara",
      currentIntentId:"intent-1",priorIntentIds:["intent-0"],transition:"replaced",
      reviewStatus:"candidate",currentEvidence:evidence("chapter-2","Mara quiso ayudar a Elian.",20),
      priorEvidence:[evidence("chapter-1","Mara quiso vengarse.",0)]
    }]
  });
  assert.equal(shift.context.interpretation,"explicit-memory-connector-present");
  assert.deepEqual(shift.context.knowledgeActionLinkIds,["knowledge-action:info-1:a2"]);
  assert.deepEqual(shift.context.decisionContextIds,["decision-context:info-1:intent-1:a2"]);
  assert.deepEqual(shift.context.memoryActionLinkIds,["memory-action:a2:memory-1"]);
  assert.deepEqual(shift.context.intentEvolution,[{id:"intent-evolution:intent-1",transition:"replaced"}]);
  assert.equal(shift.reviewStatus,"candidate");
});

test("rechaza enlaces de contexto cuya evidencia no coincide con la acción",()=>{
  const current=action("a2","ayudó","chapter-1",40);
  assert.throws(()=>detectNarrativeBehaviorEvolution({
    projectId:"novel",entities,
    priorActions:[action("a1","atacó","chapter-1")],currentActions:[current],
    knowledgeActionLinks:[{
      id:"k1",projectId:"novel",characterEntityId:"mara",informationId:"info-1",
      actionId:"a2",relation:"knowledge-precedes-action",chronology:"same-document-position",
      knowledgeAssessment:"unassessed",knowledgeChannel:"visual",knowledgeStatus:"observed",
      knowledgeEvidence:evidence("chapter-1","Mara vio algo.",0),
      actionEvidence:evidence("chapter-1","Otra acción.",100),reviewStatus:"candidate"
    }]
  }),/no coincide con la evidencia/);
});

test("rechaza IDs de acciones duplicados y actores no caracterizados",()=>{
  const duplicate=action("same","atacó","chapter-1");
  assert.throws(()=>detectNarrativeBehaviorEvolution({
    projectId:"novel",entities,priorActions:[duplicate],currentActions:[duplicate]
  }));
  assert.throws(()=>detectNarrativeBehaviorEvolution({
    projectId:"novel",entities,
    currentActions:[action("a1","atacó","chapter-1",0,{actorEntityId:"unknown"})]
  }));
});
