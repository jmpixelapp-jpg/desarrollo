import test from "node:test";
import assert from "node:assert/strict";
import {discoverNarrativeObjectDescriptionReferences as discover} from "../dist/motor-literario.js";
const sword={projectId:"p",id:"sword",kind:"object",canonicalName:"Espada",normalizedName:"espada",aliases:[],evidence:[],firstSeenAt:0,lastSeenAt:0,extractionVersion:1};
const relic={...sword,id:"relic",canonicalName:"Reliquia",normalizedName:"reliquia"};
const label=(text,status)=>({text,evidence:{documentId:"profile",revision:1,start:0,end:text.length,excerpt:text,...(status?{status}:{})}});
const input=(text,profiles,entities=[sword])=>({projectId:"p",documentId:"ch1",revision:2,text,profiles,entities});
test("reconoce una descripción exacta previamente revisada",()=>{
 const [m]=discover(input("El arma brilló.",[{entityId:"sword",labels:[label("el arma")]}]));
 assert.equal(m.status,"single-candidate");assert.equal(m.candidates[0].entityId,"sword");assert.equal(m.mentionEvidence.excerpt,"El arma");
});
test("mantiene ambigüedad si dos objetos comparten descripción",()=>{
 const [m]=discover(input("La reliquia apareció.",[{entityId:"sword",labels:[label("la reliquia")]},{entityId:"relic",labels:[label("la reliquia")]}],[sword,relic]));
 assert.equal(m.status,"ambiguous");assert.equal(m.candidates.length,2);
});
test("no inventa equivalencias léxicas no registradas",()=>{
 assert.deepEqual(discover(input("La joya desapareció.",[{entityId:"sword",labels:[label("el arma")]}])),[]);
});
test("respeta límites de palabra, unicode y offsets absolutos",()=>{
 const prefix="😀 ",text="El arma cayó.";
 const [m]=discover({...input(text,[{entityId:"sword",labels:[label("el arma")]}]),baseOffset:prefix.length});
 assert.equal(m.mentionEvidence.start,prefix.length);assert.equal(m.mentionEvidence.excerpt,"El arma");
 assert.deepEqual(discover(input("desarmado",[{entityId:"sword",labels:[label("arma")]}])),[]);
});
test("ignora evidencia descriptiva obsoleta",()=>{
 assert.deepEqual(discover(input("El arma cayó.",[{entityId:"sword",labels:[label("el arma","stale")]}])),[]);
});
test("rechaza perfiles de personajes y entidades de otro proyecto",()=>{
 const character={...sword,id:"ana",kind:"character"};
 assert.throws(()=>discover(input("La heredera llegó.",[{entityId:"ana",labels:[label("la heredera")]}],[character])));
 assert.throws(()=>discover(input("El arma cayó.",[{entityId:"sword",labels:[label("el arma")]}],[{...sword,projectId:"other"}])));
});
test("rechaza etiquetas duplicadas y evidencia inconsistente",()=>{
 assert.throws(()=>discover(input("El arma.",[{entityId:"sword",labels:[label("el arma"),label(" EL   ARMA ")]}])));
 assert.throws(()=>discover(input("El arma.",[{entityId:"sword",labels:[{text:"el arma",evidence:{}}]}])));
});
test("aplica límites de perfiles y resultados",()=>{
 assert.throws(()=>discover({...input("El arma.",[{entityId:"sword",labels:[label("el arma")]}]),maxMatches:5_001}));
});
