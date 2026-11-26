import test from "node:test";
import assert from "node:assert/strict";
import { linkNarrativeReceptionToKnowledge as link } from "../dist/motor-literario.js";
const ev=(doc,rev,start,excerpt)=>({documentId:doc,revision:rev,start,end:start+excerpt.length,excerpt});
const reception=(id,character,doc,rev,start,proposition,stage="exposure")=>{
 const evidence=ev(doc,rev,start,"Ana oyó que "+proposition+".");
 return {id,projectId:"book",documentId:doc,revision:rev,characterEntityId:character,stage,
 signal:"heard-proposition",propositionEvidence:ev(doc,rev,start+12,proposition),
 characterEvidence:ev(doc,rev,start,"Ana"),triggerEvidence:ev(doc,rev,start+4,"oyó"),
 evidence,polarity:"affirmed",interpretation:"contact-does-not-establish-comprehension",
 comprehensionEstablished:false,acceptanceEstablished:false,reviewStatus:"candidate"};
};
const knowledge=(id,holder,doc,rev,start,proposition)=>{
 const evidence=ev(doc,rev,start,"Ana supo que "+proposition+".");
 return {id,projectId:"book",documentId:doc,revision:rev,kind:"learned",mode:"asserted-cognition",
 holderEntityId:holder,propositionEvidence:ev(doc,rev,start+13,proposition),
 holderEvidence:ev(doc,rev,start,"Ana"),triggerEvidence:ev(doc,rev,start+4,"supo"),
 evidence,polarity:"affirmed",certainty:"explicit-claim",reviewStatus:"candidate"};
};
test("enlaza misma persona y proposición literal sin inferir comprensión",()=>{
 const r=reception("r1","ana","ch1",1,0,"Bruno había vuelto");
 const k=knowledge("k1","ana","ch1",1,50,"Bruno había vuelto");
 const [x]=link({projectId:"book",receptionCandidates:[r],knowledgeCandidates:[k]});
 assert.equal(x.position,"reception-before-knowledge");
 assert.equal(x.comprehensionInferred,false);assert.equal(x.knowledgeTruthEstablished,false);
});
test("no enlaza personajes diferentes aunque la proposición coincida",()=>{
 assert.deepEqual(link({projectId:"book",receptionCandidates:[reception("r1","ana","ch1",1,0,"Bruno volvió")],
 knowledgeCandidates:[knowledge("k1","bruno","ch1",1,50,"Bruno volvió")]}),[]);
});
test("no equipara paráfrasis con proposición literal",()=>{
 assert.deepEqual(link({projectId:"book",receptionCandidates:[reception("r1","ana","ch1",1,0,"Bruno volvió")],
 knowledgeCandidates:[knowledge("k1","ana","ch1",1,50,"Bruno regresó")]}),[]);
});
test("mantiene sin orden revisiones distintas del mismo documento",()=>{
 const [x]=link({projectId:"book",receptionCandidates:[reception("r1","ana","ch1",1,0,"Bruno volvió")],
 knowledgeCandidates:[knowledge("k1","ana","ch1",2,50,"Bruno volvió")]});
 assert.equal(x.position,"unordered");
});
test("usa orden explícito solo como orden documental",()=>{
 const [x]=link({projectId:"book",receptionCandidates:[reception("r1","ana","ch1",1,0,"Bruno volvió")],
 knowledgeCandidates:[knowledge("k1","ana","ch2",1,0,"Bruno volvió")],
 documentOrder:[{documentId:"ch1",order:1},{documentId:"ch2",order:2}]});
 assert.equal(x.position,"document-order-only");
});
test("preserva polaridades distintas como candidato de revisión",()=>{
 const r={...reception("r1","ana","ch1",1,0,"Bruno volvió"),polarity:"negated"};
 const k=knowledge("k1","ana","ch1",1,50,"Bruno volvió");
 const [x]=link({projectId:"book",receptionCandidates:[r],knowledgeCandidates:[k]});
 assert.equal(x.receptionPolarity,"negated");assert.equal(x.knowledgePolarity,"affirmed");
});
test("rechaza evidencia incoherente y orden documental duplicado",()=>{
 const r=reception("r1","ana","ch1",1,0,"Bruno volvió");
 const k=knowledge("k1","ana","ch1",1,50,"Bruno volvió");
 assert.throws(()=>link({projectId:"book",receptionCandidates:[r],knowledgeCandidates:[k],
 documentOrder:[{documentId:"ch1",order:1},{documentId:"ch2",order:1}]}));
 assert.throws(()=>link({projectId:"book",receptionCandidates:[{...r,propositionEvidence:ev("ch2",1,0,"Bruno volvió")}],knowledgeCandidates:[k]}));
});
