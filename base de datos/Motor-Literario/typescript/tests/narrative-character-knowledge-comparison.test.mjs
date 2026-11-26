import test from "node:test";
import assert from "node:assert/strict";
import { compareNarrativeCharacterKnowledge as compare } from "../dist/motor-literario.js";
const ev=(doc,rev,start,excerpt)=>({documentId:doc,revision:rev,start,end:start+excerpt.length,excerpt});
const item=(id,doc,rev,start,kind="believed",mode="uncertain-cognition",polarity="affirmed",proposition="Bruno había mentido")=>{
 const full="Ana "+kind+" que "+proposition;
 return {id,projectId:"book",documentId:doc,revision:rev,kind,mode,holderEntityId:"ana",
  holderEvidence:ev(doc,rev,start,"Ana"),triggerEvidence:ev(doc,rev,start+4,kind),
  propositionEvidence:ev(doc,rev,start+4+kind.length+4,proposition),
  evidence:ev(doc,rev,start,full),polarity,certainty:mode==="uncertain-cognition"?"uncertain-claim":"explicit-claim",reviewStatus:"candidate"};
};
test("detecta discrepancia de polaridad sobre la misma proposición literal",()=>{
 const r=compare({projectId:"book",candidates:[
  item("a","ch1",1,0,"believed","uncertain-cognition","affirmed"),
  item("b","ch1",1,80,"believed","uncertain-cognition","negated")]});
 assert.equal(r.length,1);assert.equal(r[0].kind,"polarity-disagreement");
 assert.equal(r[0].ordering,"same-document-text-order");assert.equal(r[0].interpretation,"candidate-only");
});
test("distingue cambio de estatus epistémico de contradicción de polaridad",()=>{
 const r=compare({projectId:"book",candidates:[
  item("a","ch1",1,0,"believed","uncertain-cognition"),
  item("b","ch1",1,80,"known","asserted-cognition")]});
 assert.equal(r.length,1);assert.equal(r[0].kind,"epistemic-status-shift");
});
test("detecta cambios entre recordar y olvidar sin declarar mentira",()=>{
 const r=compare({projectId:"book",candidates:[
  item("a","ch1",1,0,"remembered","asserted-cognition"),
  item("b","ch1",1,80,"forgotten","asserted-cognition")]});
 assert.equal(r.length,1);assert.equal(r[0].kind,"knowledge-kind-shift");
});
test("no compara documentos distintos sin orden explícito y conserva el estado unordered",()=>{
 const r=compare({projectId:"book",candidates:[
  item("a","ch2",1,0),item("b","ch1",1,0,"known","asserted-cognition")]});
 assert.equal(r.length,1);assert.equal(r[0].ordering,"unordered");
});
test("usa el orden documental solo cuando se proporciona explícitamente",()=>{
 const r=compare({projectId:"book",candidates:[
  item("a","ch2",1,0),item("b","ch1",1,0,"known","asserted-cognition")],
  documentOrder:[{documentId:"ch1",order:1},{documentId:"ch2",order:2}]});
 assert.equal(r[0].firstCandidateId,"b");assert.equal(r[0].ordering,"explicit-document-order");
});
test("no equipara proposiciones distintas ni personajes distintos",()=>{
 const r=compare({projectId:"book",candidates:[
  item("a","ch1",1,0),item("b","ch1",1,80,"known","asserted-cognition","affirmed","Bruno había llegado"),
  {...item("c","ch1",1,160,"known","asserted-cognition"),holderEntityId:"bruno"}]});
 assert.deepEqual(r,[]);
});
test("rechaza evidencia auxiliar fuera del fragmento y proyectos mezclados",()=>{
 const a=item("a","ch1",1,0);
 assert.throws(()=>compare({projectId:"book",candidates:[{...a,triggerEvidence:ev("ch1",1,200,"supo") }]}));
 assert.throws(()=>compare({projectId:"book",candidates:[{...a,projectId:"other"}]}));
});
test("rechaza identificadores y órdenes duplicados",()=>{
 const a=item("a","ch1",1,0);
 assert.throws(()=>compare({projectId:"book",candidates:[a,a]}));
 assert.throws(()=>compare({projectId:"book",candidates:[a],documentOrder:[
  {documentId:"ch1",order:1},{documentId:"ch2",order:1}]}));
});

test("normaliza mayúsculas, puntuación final y espacios sin equiparar sinónimos",()=>{
 const r=compare({projectId:"book",candidates:[
  item("a","ch1",1,0,"believed","uncertain-cognition","affirmed","Bruno había mentido"),
  item("b","ch1",1,80,"known","asserted-cognition","negated","BRUNO HABÍA MENTIDO.")]});
 assert.equal(r.length,1);assert.equal(r[0].kind,"polarity-disagreement");
 assert.equal(r[0].propositionKey,"bruno había mentido");
});
test("no duplica un mismo fragmento ni acepta estados o fuentes malformados",()=>{
 const a=item("a","ch1",1,0);
 assert.deepEqual(compare({projectId:"book",candidates:[a,{...a,id:"b"}]}),[]);
 assert.throws(()=>compare({projectId:"book",candidates:[{...a,kind:"unknown"}]}));
 assert.throws(()=>compare({projectId:"book",candidates:[{...a,sourceEntityId:"speaker"}]}));
});
