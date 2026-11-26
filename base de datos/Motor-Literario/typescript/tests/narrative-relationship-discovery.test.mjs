import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeRelationships } from "../dist/motor-literario.js";

const ana={projectId:"p",id:"ana",kind:"character",canonicalName:"Ana",normalizedName:"ana",aliases:[],evidence:[],firstSeenAt:0,lastSeenAt:0,extractionVersion:1};
const bruno={...ana,id:"bruno",canonicalName:"Bruno",normalizedName:"bruno"};
const carla={...ana,id:"carla",canonicalName:"Carla",normalizedName:"carla"};
const label={text:"el hermano",evidence:{documentId:"profile",revision:1,start:0,end:10,excerpt:"el hermano"}};

function run(text, entities=[ana,bruno], profiles=[], extra={}) {
 return discoverNarrativeRelationships({projectId:"p",documentId:"chapter",revision:2,text,entities,descriptiveProfiles:profiles,...extra});
}

test("detecta relación nominal explícita entre dos personajes",()=>{
 const [r]=run("Ana es hermana de Bruno.");
 assert.equal(r.fromEntityId,"ana"); assert.equal(r.toEntityId,"bruno");
 assert.equal(r.relationType,"sibling-of"); assert.equal(r.status,"single-candidate");
 assert.equal(r.relationEvidence.excerpt,"hermana");
});
test("vincula descriptor registrado con entidad nombrada",()=>{
 const [r]=run("El hermano de Ana llegó.",[ana,bruno],[{entityId:"bruno",labels:[label]}]);
 assert.equal(r.fromEntityId,"bruno"); assert.equal(r.toEntityId,"ana");
 assert.equal(r.relationType,"sibling-of");
});
test("no inventa relación para posesivo su sin antecedente resuelto",()=>{
 assert.deepEqual(run("Su hermano llegó.",[ana,bruno],[{entityId:"bruno",labels:[label]}]),[]);
});
test("no crea relación cuando el descriptor no tiene perfil validado",()=>{
 assert.deepEqual(run("El hermano de Ana llegó."),[]);
});
test("no relaciona una entidad consigo misma",()=>{
 assert.deepEqual(run("Ana es hermana de Ana.",[ana]),[]);
});
test("conserva offsets UTF-16 absolutos con emoji",()=>{
 const [r]=run("Ana es hermana de Bruno.",[ana,bruno],[],{baseOffset:3});
 assert.equal(r.relationEvidence.start,3+"Ana es ".length);
 assert.equal(r.toEvidence.start,3+"Ana es hermana de ".length);
});
test("excluye etiquetas descriptivas obsoletas",()=>{
 assert.deepEqual(run("El hermano de Ana llegó.",[ana,bruno],[{entityId:"bruno",labels:[{...label,evidence:{...label.evidence,status:"stale"}}]}]),[]);
});
test("rechaza entidades de otro proyecto y perfiles duplicados",()=>{
 assert.throws(()=>run("Ana es hermana de Bruno.",[{...ana,projectId:"other"},bruno]),/mismo proyecto/);
 assert.throws(()=>run("El hermano de Ana.",[ana,bruno],[{entityId:"bruno",labels:[label]},{entityId:"bruno",labels:[label]}]),/Perfil descriptivo/);
});
test("respeta presupuesto máximo y no produce autorrelaciones",()=>{
 const results=run("Ana es hermana de Bruno. Ana es hermana de Bruno.",[ana,bruno],[],{maxCandidates:1});
 assert.equal(results.length,1); assert.notEqual(results[0].fromEntityId,results[0].toEntityId);
});
