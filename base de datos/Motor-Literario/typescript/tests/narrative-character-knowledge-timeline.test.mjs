import test from "node:test";
import assert from "node:assert/strict";
import { buildNarrativeCharacterKnowledgeTimeline as build } from "../dist/motor-literario.js";
const evidence=(documentId,revision,start,excerpt)=>({documentId,revision,start,end:start+excerpt.length,excerpt});
const candidate=(id,documentId,revision,start,holder="ana")=>{
 const text="Ana supo que Bruno mentía.";
 return {id,projectId:"book",documentId,revision,kind:"learned",mode:"asserted-cognition",
  holderEntityId:holder,holderEvidence:evidence(documentId,revision,start,"Ana"),
  triggerEvidence:evidence(documentId,revision,start+4,"supo"),
  propositionEvidence:evidence(documentId,revision,start+13,"Bruno mentía"),
  evidence:evidence(documentId,revision,start,text),polarity:"affirmed",certainty:"explicit-claim",reviewStatus:"candidate"};
};
const temporal=(id,documentId,revision,start,surface="ayer")=>({
 id,projectId:"book",documentId,revision,kind:"relative-order",surface,relation:"before",
 anchorRequired:true,absoluteResolution:"unresolved-relative",
 evidence:evidence(documentId,revision,start,surface),reviewStatus:"candidate"
});
test("asocia referencia temporal solo cuando cae dentro de la misma evidencia",()=>{
 const c=candidate("k1","ch1",1,100), t=temporal("t1","ch1",1,100,"ayer");
 const r=build({projectId:"book",candidates:[c],temporalReferences:[t]});
 assert.equal(r.entries[0].temporalAssociation,"same-evidence-span");
 assert.equal(r.entries[0].explicitTemporalReference.id,"t1");
 assert.equal(r.chronologyResolved,false);
});
test("no propaga anclas temporales a afirmaciones cercanas ni a otras revisiones",()=>{
 const c=candidate("k1","ch1",1,100);
 const outside=temporal("t1","ch1",1,200,"ayer");
 const stale=temporal("t2","ch1",2,100,"ayer");
 const r=build({projectId:"book",candidates:[c],temporalReferences:[outside,stale]});
 assert.equal(r.entries[0].temporalAssociation,"none");
 assert.equal(r.entries[0].explicitTemporalReference,undefined);
});
test("respeta el orden de capítulos solo cuando el proyecto lo proporciona",()=>{
 const a=candidate("k2","chapter-b",1,10), b=candidate("k1","chapter-a",1,10);
 const inferred=build({projectId:"book",candidates:[a,b],temporalReferences:[]});
 assert.equal(inferred.orderingBasis,"document-local-text-offset");
 const explicit=build({projectId:"book",candidates:[a,b],temporalReferences:[],
  documentOrder:[{documentId:"chapter-b",order:2},{documentId:"chapter-a",order:1}]});
 assert.deepEqual(explicit.entries.map(x=>x.candidate.id),["k1","k2"]);
 assert.equal(explicit.orderingBasis,"explicit-document-order-then-text-offset");
});
test("ordena posiciones dentro del mismo documento por offset de evidencia",()=>{
 const later=candidate("k2","ch1",1,200), earlier=candidate("k1","ch1",1,20);
 const r=build({projectId:"book",candidates:[later,earlier],temporalReferences:[]});
 assert.deepEqual(r.entries.map(x=>x.candidate.id),["k1","k2"]);
});
test("rechaza evidencia fuera de rango, revisiones cruzadas y órdenes duplicados",()=>{
 const bad={...candidate("k1","ch1",1,10),triggerEvidence:evidence("ch1",1,1,"supo")};
 assert.throws(()=>build({projectId:"book",candidates:[bad],temporalReferences:[]}));
 assert.throws(()=>build({projectId:"book",candidates:[candidate("k1","ch1",1,10)],temporalReferences:[],
  documentOrder:[{documentId:"ch1",order:1},{documentId:"ch2",order:1}]}));
 assert.throws(()=>build({projectId:"book",candidates:[candidate("k1","ch1",1,10)],temporalReferences:[temporal("t","ch1",2,10)]}));
});
test("rechaza proyectos mezclados e identificadores duplicados",()=>{
 assert.throws(()=>build({projectId:"book",candidates:[candidate("k","ch1",1,10),candidate("k","ch1",1,30)],temporalReferences:[]}));
 assert.throws(()=>build({projectId:"book",candidates:[{...candidate("k","ch1",1,10),projectId:"other"}],temporalReferences:[]}));
});
