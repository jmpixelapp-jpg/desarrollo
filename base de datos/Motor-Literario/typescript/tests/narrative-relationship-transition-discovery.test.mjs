import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeRelationshipTransitionCandidates } from "../dist/motor-literario.js";
const ana={projectId:"p",id:"ana",kind:"character",canonicalName:"Ana",normalizedName:"ana",aliases:[],evidence:[],firstSeenAt:0,lastSeenAt:0,extractionVersion:1};
const bruno={...ana,id:"bruno",canonicalName:"Bruno",normalizedName:"bruno"};
const carla={...ana,id:"carla",canonicalName:"Carla",normalizedName:"carla"};
function run(text,entities=[ana,bruno],extra={}){return discoverNarrativeRelationshipTransitionCandidates({projectId:"p",documentId:"chapter",revision:3,text,entities,...extra});}
test("detecta inicio explícito de amistad",()=>{const [c]=run("Ana y Bruno se hicieron amigos después del viaje.");assert.equal(c.family,"friendship");assert.equal(c.transition,"formed");assert.equal(c.firstEntityId,"ana");assert.equal(c.secondEntityId,"bruno");assert.equal(c.trigger,"se hicieron amigos");});
test("detecta ruptura de amistad",()=>{const [c]=run("Ana rompió su amistad con Bruno.");assert.equal(c.family,"friendship");assert.equal(c.transition,"ended");});
test("detecta reconciliación",()=>{const [c]=run("Bruno y Ana se reconciliaron al amanecer.");assert.equal(c.family,"friendship");assert.equal(c.transition,"reconciled");});
test("detecta formación y terminación de matrimonio",()=>{const [a]=run("Ana se casó con Bruno.");const [b]=run("Ana se divorció de Bruno.");assert.equal(a.family,"marriage");assert.equal(a.transition,"formed");assert.equal(b.transition,"ended");});
test("conserva offsets UTF-16 absolutos",()=>{const prefix="😀 ";const text="Ana y Bruno se hicieron amigos.";const [c]=run(text,[ana,bruno],{baseOffset:prefix.length});assert.equal(c.firstEntityEvidence.start,prefix.length);assert.equal(c.triggerEvidence.start,prefix.length+text.indexOf("se hicieron"));});
test("no cruza oraciones ni vincula objetivo no mencionado",()=>{assert.deepEqual(run("Ana sonrió. Bruno se hizo amigo de Carla.",[ana,bruno]),[]);});
test("no genera autorrelaciones",()=>{assert.deepEqual(run("Ana se hizo amiga de Ana.",[ana]),[]);});
test("rechaza entidades y alias malformados",()=>{assert.throws(()=>run("Ana y Bruno se hicieron amigos.",[{...ana,projectId:"otro"},bruno]),/únicos y válidos/);assert.throws(()=>run("Ana y Bruno se hicieron amigos.",[{...ana,aliases:[""]},bruno]),/únicos y válidos/);});
test("no devuelve resultados parciales al superar máximo",()=>{assert.throws(()=>run("Ana y Bruno se hicieron amigos. Ana y Bruno se reconciliaron.",[ana,bruno],{maxCandidates:1}),/no se devuelve un resultado parcial/);});
test("ordena cronológicamente independientemente del orden de entidades",()=>{const text="Ana y Bruno se hicieron amigos. Carla y Ana se reconciliaron.";const a=run(text,[ana,bruno,carla]);const b=run(text,[carla,bruno,ana]);assert.deepEqual(a.map(x=>x.triggerEvidence.start),b.map(x=>x.triggerEvidence.start));});

test("no crea vínculos cuando ambos IDs comparten exactamente el mismo nombre ambiguo",()=>{
 const duplicate={...ana,id:"ana-2"};
 assert.deepEqual(run("Ana y Ana se hicieron amigas.",[ana,duplicate]),[]);
});
test("solo admite entidades de tipo personaje",()=>{
 const object={...bruno,kind:"object"};
 assert.throws(()=>run("Ana y Bruno se hicieron amigos.",[ana,object]),/únicos y válidos/);
});
