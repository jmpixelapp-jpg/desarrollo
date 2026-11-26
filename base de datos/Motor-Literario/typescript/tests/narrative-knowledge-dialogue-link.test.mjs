import test from "node:test";
import assert from "node:assert/strict";
import { linkNarrativeKnowledgeToDialogue as link } from "../dist/motor-literario.js";
const ev=(doc,rev,start,excerpt)=>({documentId:doc,revision:rev,start,end:start+excerpt.length,excerpt});
const transfer=(id="t1",doc="ch1",rev=1,start=0,source="bruno",recipient="ana",proposition="La llave está bajo la mesa")=>({
 id,projectId:"book",documentId:doc,revision:rev,kind:"reported",mode:"reported-transfer",
 holderEntityId:recipient,sourceEntityId:source,
 holderEvidence:ev(doc,rev,start+4,"Ana"),sourceEvidence:ev(doc,rev,start,"Bruno"),
 triggerEvidence:ev(doc,rev,start+6,"confesó"),
 propositionEvidence:ev(doc,rev,start+15,proposition),
 evidence:ev(doc,rev,start,"Bruno confesó a Ana que "+proposition),
 polarity:"affirmed",certainty:"explicit-claim",reviewStatus:"candidate"
});
const dialogue=(id,status="explicit-single",speaker="bruno",utterance="La llave está bajo la mesa",doc="ch1",rev=1,start=0)=>{
 const segment="«"+utterance+"»";
 const speakers=status==="unattributed"?[]:(status==="ambiguous"?["bruno","ana"]:[speaker]).map((entityId,i)=>({
  entityId,entityKind:"character",nameEvidence:ev(doc,rev,start+segment.length+2+i*5,entityId==="bruno"?"Bruno":"Ana"),
  speechVerbEvidence:ev(doc,rev,start+segment.length+10+i*5,"dijo")
 }));
 return {id,projectId:"book",documentId:doc,revision:rev,format:"guillemets",
  utteranceEvidence:ev(doc,rev,start+1,utterance),segmentEvidence:ev(doc,rev,start,segment),
  speakerCandidates:speakers,speakerStatus:status,reviewStatus:"candidate"};
};
test("enlaza una revelación cuando hablante y proposición coinciden",()=>{
 const r=link({projectId:"book",knowledgeCandidates:[transfer()],dialogueSegments:[dialogue("d1")]});
 assert.equal(r.length,1);assert.equal(r[0].status,"speaker-matches-source");
 assert.equal(r[0].recipientEntityId,"ana");assert.equal(r[0].recipientComprehension,"not-established");
});
test("distingue hablante que contradice al emisor registrado",()=>{
 const r=link({projectId:"book",knowledgeCandidates:[transfer()],dialogueSegments:[dialogue("d1","explicit-single","ana")]});
 assert.equal(r[0].status,"speaker-conflicts-with-source");
});
test("conserva atribución ambigua y ausencia de hablante",()=>{
 const a=link({projectId:"book",knowledgeCandidates:[transfer()],dialogueSegments:[dialogue("d1","ambiguous")]});
 const b=link({projectId:"book",knowledgeCandidates:[transfer()],dialogueSegments:[dialogue("d2","unattributed")]});
 assert.equal(a[0].status,"speaker-ambiguous");assert.equal(b[0].status,"speaker-unattributed");
});
test("no equipara una intervención con una proposición diferente",()=>{
 const r=link({projectId:"book",knowledgeCandidates:[transfer()],dialogueSegments:[dialogue("d1","explicit-single","bruno","La puerta está abierta")]});
 assert.equal(r[0].status,"utterance-does-not-repeat-proposition");
});
test("no enlaza documentos ni revisiones distintas",()=>{
 const r=link({projectId:"book",knowledgeCandidates:[transfer()],dialogueSegments:[
  dialogue("d1","explicit-single","bruno","La llave está bajo la mesa","ch2",1),
  dialogue("d2","explicit-single","bruno","La llave está bajo la mesa","ch1",2)]});
 assert.deepEqual(r,[]);
});
test("ignora afirmaciones cognitivas que no son transferencias explícitas",()=>{
 const item={...transfer(),kind:"known",mode:"asserted-cognition",sourceEntityId:undefined,sourceEvidence:undefined};
 const r=link({projectId:"book",knowledgeCandidates:[item],dialogueSegments:[dialogue("d1")]});
 assert.deepEqual(r,[]);
});
test("rechaza evidencias fuera de fragmento y estado de hablante incoherente",()=>{
 const bad={...transfer(),holderEvidence:ev("ch1",1,500,"Ana")};
 assert.throws(()=>link({projectId:"book",knowledgeCandidates:[bad],dialogueSegments:[]}));
 const d={...dialogue("d1"),speakerStatus:"explicit-single",speakerCandidates:[]};
 assert.throws(()=>link({projectId:"book",knowledgeCandidates:[transfer()],dialogueSegments:[d]}));
});
test("rechaza duplicados y proyectos ajenos",()=>{
 const t=transfer();
 assert.throws(()=>link({projectId:"book",knowledgeCandidates:[t,t],dialogueSegments:[]}));
 assert.throws(()=>link({projectId:"book",knowledgeCandidates:[t],dialogueSegments:[{...dialogue("d1"),projectId:"other"}]}));
});
