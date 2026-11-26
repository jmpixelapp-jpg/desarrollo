import test from "node:test";
import assert from "node:assert/strict";
import { linkNarrativeKnowledgeToActions } from "../dist/motor-literario.js";

const entities = [
  { projectId:"book-1", id:"mara", kind:"character", canonicalName:"Mara", normalizedName:"mara", aliases:[], evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1 },
  { projectId:"book-1", id:"elian", kind:"character", canonicalName:"Elian", normalizedName:"elian", aliases:[], evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1 }
];
const evidence = (documentId, revision, start, end, excerpt, status) => ({
  documentId, revision, start, end, excerpt, ...(status ? {status} : {})
});
const item = (informationId, documentId, revision, start, end, status) => ({
  informationId, content:"el puente ha caído", channel:"visual-observation",
  status:"observed", evidence:evidence(documentId,revision,start,end,"Mara vio que el puente ha caído.",status),
  interpretations:[], evaluations:[], currentAssessment:"unassessed",
  chronology:"same-document-position"
});
const state = (characterEntityId, items) => ({
  projectId:"book-1", characterEntityId, items,
  summary:{recordedInformationCount:items.length,interpretedInformationCount:0,
    explicitMisinterpretationCount:0,evaluationCount:0},
  reviewStatus:"candidate"
});
const action = (id, actorEntityId, start, polarity="affirmed", documentId="chapter-1", revision=1) => ({
  id, projectId:"book-1", actorEntityId, action:"protegió", targetEntityId:"elian",
  polarity, reviewStatus:"candidate",
  evidence:evidence(documentId,revision,start,start+20,"Mara protegió a Elian.")
});

test("enlaza información previa del mismo personaje sin afirmar causalidad",()=>{
  const links=linkNarrativeKnowledgeToActions({
    projectId:"book-1",entities,
    knowledgeStates:[state("mara",[item("info-1","chapter-1",1,0,35)])],
    actions:[action("action-1","mara",60)]
  });
  assert.equal(links.length,1);
  assert.equal(links[0].relation,"knowledge-precedes-action");
  assert.equal(links[0].chronology,"same-document-position");
  assert.equal(links[0].informationId,"info-1");
  assert.equal(links[0].actionId,"action-1");
  assert.equal(links[0].knowledgeEvidence.excerpt,"Mara vio que el puente ha caído.");
  assert.equal(links[0].actionEvidence.excerpt,"Mara protegió a Elian.");
});

test("requiere orden explícito para relacionar documentos distintos",()=>{
  const knowledge=state("mara",[item("info-prior","chapter-1",1,10,40)]);
  const later=action("action-later","mara",0,"affirmed","chapter-2",1);
  assert.deepEqual(linkNarrativeKnowledgeToActions({
    projectId:"book-1",entities,knowledgeStates:[knowledge],actions:[later]
  }),[]);
  const links=linkNarrativeKnowledgeToActions({
    projectId:"book-1",entities,knowledgeStates:[knowledge],actions:[later],
    orderedDocumentIds:["chapter-1","chapter-2"]
  });
  assert.equal(links.length,1);
  assert.equal(links[0].chronology,"explicit-document-order");
});

test("no enlaza conocimiento obsoleto, acciones negadas ni acciones de otro personaje",()=>{
  const knowledge=state("mara",[item("stale-info","chapter-1",1,0,35,"stale")]);
  const links=linkNarrativeKnowledgeToActions({
    projectId:"book-1",entities,knowledgeStates:[knowledge],
    actions:[
      action("negated","mara",60,"negated"),
      action("other-actor","elian",70),
      action("valid-but-stale-source","mara",80)
    ]
  });
  assert.deepEqual(links,[]);
});

test("rechaza estados de otro proyecto, acciones duplicadas e IDs de información duplicados",()=>{
  const validState=state("mara",[item("info-1","chapter-1",1,0,35)]);
  assert.throws(()=>linkNarrativeKnowledgeToActions({
    projectId:"book-1",entities,
    knowledgeStates:[{...validState,projectId:"other"}],actions:[action("a","mara",60)]
  }));
  assert.throws(()=>linkNarrativeKnowledgeToActions({
    projectId:"book-1",entities,knowledgeStates:[validState],
    actions:[action("a","mara",60),action("a","mara",80)]
  }));
  assert.throws(()=>linkNarrativeKnowledgeToActions({
    projectId:"book-1",entities,
    knowledgeStates:[state("mara",[
      item("duplicate","chapter-1",1,0,20),item("duplicate","chapter-1",1,25,35)
    ])],actions:[action("a","mara",60)]
  }));
});

test("rechaza estados repetidos del mismo personaje e IDs globales de información repetidos",()=>{
  const first=state("mara",[item("shared-info","chapter-1",1,0,35)]);
  const second=state("mara",[item("other-info","chapter-1",1,5,35)]);
  assert.throws(()=>linkNarrativeKnowledgeToActions({
    projectId:"book-1",entities,knowledgeStates:[first,second],
    actions:[action("a","mara",60)]
  }));
  const otherCharacter=state("elian",[item("shared-info","chapter-1",1,0,35)]);
  assert.throws(()=>linkNarrativeKnowledgeToActions({
    projectId:"book-1",entities,knowledgeStates:[first,otherCharacter],
    actions:[action("a","mara",60)]
  }));
});
