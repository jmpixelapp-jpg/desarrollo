import test from "node:test";
import assert from "node:assert/strict";
import {auditNarrativeExtractionByDomain as audit} from "../dist/motor-literario.js";
const ev=(doc,rev,start,excerpt)=>({documentId:doc,revision:rev,start,end:start+excerpt.length,excerpt});
test("mide cobertura separada por tipo de extracción",()=>{
 const text="Ana supo que Bruno volvió. La puerta estaba abierta.";
 const r=audit({documentId:"ch1",revision:1,text,evidenceByDomain:{
 "character-knowledge":[{evidence:ev("ch1",1,0,"Ana supo que Bruno volvió.")}],
 "actions":[]
 }});
 const knowledge=r.domains.find(x=>x.domain==="character-knowledge");
 const actions=r.domains.find(x=>x.domain==="actions");
 assert.equal(knowledge.coveredSentences,1);assert.equal(knowledge.uncoveredSentences,1);
 assert.equal(actions.coveredSentences,0);assert.equal(actions.uncoveredSentences,2);
 assert.equal(r.interpretation,"evidence-coverage-not-semantic-completeness");
});
test("valida offsets y extractos contra texto original",()=>{
 assert.throws(()=>audit({documentId:"ch1",revision:1,text:"Ana llegó.",evidenceByDomain:{
 actions:[{evidence:ev("ch1",1,0,"Ana salió.")}]
 }}));
});
test("respeta offsets absolutos de bloques y revisiones",()=>{
 const text="Ana supo que Bruno volvió.";
 const r=audit({documentId:"ch1",revision:2,text,baseOffset:100,evidenceByDomain:{
 "character-knowledge":[{evidence:ev("ch1",2,100,text)}]
 }});
 assert.equal(r.domains.find(x=>x.domain==="character-knowledge").coveredSentences,1);
});
test("rechaza fuentes obsoletas, revisiones mezcladas y dominios desconocidos",()=>{
 const text="Ana llegó.";
 assert.throws(()=>audit({documentId:"ch1",revision:1,text,evidenceByDomain:{actions:[{evidence:{...ev("ch1",1,0,text),status:"stale"}}]}}));
 assert.throws(()=>audit({documentId:"ch1",revision:1,text,evidenceByDomain:{actions:[{evidence:ev("ch1",2,0,text)}]}}));
 assert.throws(()=>audit({documentId:"ch1",revision:1,text,evidenceByDomain:{mystery:[]}}));
});
test("devuelve todos los dominios incluso si aún no hay extractores conectados",()=>{
 const r=audit({documentId:"ch1",revision:1,text:"Ana llegó.",evidenceByDomain:{}});
 assert.equal(r.domains.length,9);assert.equal(r.domains.every(x=>x.coveredSentences===0),true);
});
