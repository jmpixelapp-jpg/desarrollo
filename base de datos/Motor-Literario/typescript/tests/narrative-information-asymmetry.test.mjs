import test from "node:test";
import assert from "node:assert/strict";
import { compareNarrativeInformationAsymmetry as compare } from "../dist/motor-literario.js";
const ev=(doc,rev,start,excerpt)=>({documentId:doc,revision:rev,start,end:start+excerpt.length,excerpt});
const exposure=(doc="c1",rev=1,start=0,proposition="Bruno había regresado")=>{
 const text="sin que Ana supiera que "+proposition;
 const trigger="sin que Ana supiera que";
 return {id:"x:"+doc+":"+start,projectId:"book",documentId:doc,revision:rev,
 signal:"character-unaware-that",subjectEntityId:"ana",
 subjectEvidence:ev(doc,rev,start+8,"Ana"),triggerEvidence:ev(doc,rev,start,trigger),
 propositionEvidence:ev(doc,rev,start+trigger.length,proposition),
 evidence:ev(doc,rev,start,text),presentation:"proposition-explicitly-presented-in-narrative-text",
 readerKnowledge:"not-established",focalization:"unresolved",reviewStatus:"candidate"};
};
const knowledge=(doc="c1",rev=1,start=80,proposition="Bruno había regresado",polarity="affirmed")=>{
 const text="Ana sabía que "+proposition;
 return {id:"k:"+doc+":"+start,projectId:"book",documentId:doc,revision:rev,
 kind:"known",mode:"asserted-cognition",holderEntityId:"ana",
 holderEvidence:ev(doc,rev,start,"Ana"),triggerEvidence:ev(doc,rev,start+4,"sabía"),
 propositionEvidence:ev(doc,rev,start+10,proposition),evidence:ev(doc,rev,start,text),
 polarity,certainty:"explicit-claim",reviewStatus:"candidate"};
};
test("detecta afirmación de conocimiento anterior a exposición explícita de desconocimiento",()=>{
 const [r]=compare({projectId:"book",exposures:[exposure()],knowledgeCandidates:[knowledge("c1",1,80)]});
 assert.equal(r.relation,"knowledge-claim-before-unawareness-exposure");
 assert.equal(r.contradictionEstablished,false);
});
test("detecta afirmación posterior sin convertirla en error automático",()=>{
 const [r]=compare({projectId:"book",exposures:[exposure("c1",1,80)],knowledgeCandidates:[knowledge("c1",1,0)]});
 assert.equal(r.relation,"knowledge-claim-after-unawareness-exposure");
});
test("mantiene como irresuelta la evidencia temporalmente solapada",()=>{
 const [r]=compare({projectId:"book",exposures:[exposure("c1",1,20)],knowledgeCandidates:[knowledge("c1",1,25)]});
 assert.equal(r.relation,"same-position-unresolved");
});
test("no compara paráfrasis ni proposiciones distintas",()=>{
 assert.deepEqual(compare({projectId:"book",exposures:[exposure()],knowledgeCandidates:[
  knowledge("c1",1,80,"Bruno volvió")
 ]}),[]);
});
test("no convierte ausencia de conocimiento registrado en ignorancia",()=>{
 const nonUnaware={...exposure(),signal:"truth-is-that",subjectEntityId:undefined,subjectEvidence:undefined};
 assert.deepEqual(compare({projectId:"book",exposures:[nonUnaware],knowledgeCandidates:[knowledge()]}),[]);
});
test("no mezcla revisiones ni documentos sin orden explícito",()=>{
 assert.deepEqual(compare({projectId:"book",exposures:[exposure("c1",1)],knowledgeCandidates:[knowledge("c1",2)]}),[]);
 assert.deepEqual(compare({projectId:"book",exposures:[exposure("c2",1)],knowledgeCandidates:[knowledge("c1",1)]}),[]);
});
test("usa orden documental solo cuando está definido",()=>{
 const [r]=compare({projectId:"book",exposures:[exposure("c2",1)],knowledgeCandidates:[knowledge("c1",1)],
 documentOrder:[{documentId:"c1",order:1},{documentId:"c2",order:2}]});
 assert.equal(r.relation,"knowledge-claim-before-unawareness-exposure");
});
test("rechaza evidencia obsoleta, inconsistente y proyectos ajenos",()=>{
 const stale={...knowledge(),evidence:{...knowledge().evidence,status:"stale"}};
 assert.throws(()=>compare({projectId:"book",exposures:[exposure()],knowledgeCandidates:[stale]}));
 assert.throws(()=>compare({projectId:"book",exposures:[{...exposure(),projectId:"other"}],knowledgeCandidates:[]}));
});
test("rechaza identificadores duplicados y orden documental duplicado",()=>{
 assert.throws(()=>compare({projectId:"book",exposures:[exposure(),exposure()],knowledgeCandidates:[]}));
 assert.throws(()=>compare({projectId:"book",exposures:[exposure("c2")],knowledgeCandidates:[],
 documentOrder:[{documentId:"c1",order:1},{documentId:"c2",order:1}]}));
});
