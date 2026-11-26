import test from "node:test";
import assert from "node:assert/strict";
import {discoverNarrativeObjectIdentityCandidates as discover} from "../dist/motor-literario.js";
const entity=(id,name)=>({projectId:"p",id,kind:"object",canonicalName:name,normalizedName:name.toLowerCase(),aliases:[],evidence:[],firstSeenAt:0,lastSeenAt:0,extractionVersion:1});
const sword=entity("sword","Espada"),blade=entity("blade","Hoja"),key=entity("key","Llave");
const ev=(documentId,start,excerpt)=>({documentId,revision:1,start,end:start+excerpt.length,excerpt});
const label=(text,documentId)=>({text,evidence:ev(documentId,0,text)});
test("propone identidad candidata por descripción explícita compartida sin fusionar",()=>{
 const [c]=discover({projectId:"p",entities:[sword,blade],profiles:[
  {entityId:"sword",labels:[label("el arma legendaria","ch1")]},
  {entityId:"blade",labels:[label("El arma legendaria","ch4")]}
 ]});
 assert.equal(c.reason,"shared-reviewed-description");assert.equal(c.ambiguity,"pair-only");
 assert.equal(c.mergePerformed,false);assert.deepEqual(c.evidence.map(x=>x.documentId),["ch1","ch4"]);
});
test("marca una descripción compartida por tres objetos como ambigua",()=>{
 const r=discover({projectId:"p",entities:[sword,blade,key],profiles:[
  {entityId:"sword",labels:[label("la reliquia","a")]},
  {entityId:"blade",labels:[label("la reliquia","b")]},
  {entityId:"key",labels:[label("la reliquia","c")]}
 ]});
 assert.equal(r.length,3);assert.ok(r.every(x=>x.ambiguity==="shared-by-three-or-more-objects"));
 assert.ok(r.every(x=>x.descriptionUsedByEntityIds.length===3));
});
test("no infiere identidad por sinonimia ni semejanza",()=>{
 assert.deepEqual(discover({projectId:"p",entities:[sword,blade],profiles:[
  {entityId:"sword",labels:[label("la espada","a")]},
  {entityId:"blade",labels:[label("el arma","b")]}
 ]}),[]);
});
test("ignora etiquetas obsoletas y no duplica dueño por descripción",()=>{
 const stale={...label("la reliquia","a"),evidence:{...ev("a",0,"la reliquia"),status:"stale"}};
 assert.deepEqual(discover({projectId:"p",entities:[sword,blade],profiles:[
  {entityId:"sword",labels:[stale]}, {entityId:"blade",labels:[label("la reliquia","b")]}
 ]}),[]);
});
test("rechaza entidades ajenas, perfiles duplicados y evidencia inválida",()=>{
 assert.throws(()=>discover({projectId:"p",entities:[{...sword,projectId:"q"}],profiles:[]}));
 assert.throws(()=>discover({projectId:"p",entities:[sword],profiles:[
  {entityId:"sword",labels:[]},{entityId:"sword",labels:[]}
 ]}));
 assert.throws(()=>discover({projectId:"p",entities:[sword],profiles:[
  {entityId:"sword",labels:[{text:"x",evidence:{}}]}
 ]}));
});
test("respeta límites de entidades, etiquetas y resultados",()=>{
 assert.throws(()=>discover({projectId:"p",entities:[sword],profiles:[],maxCandidates:20_001}));
});
