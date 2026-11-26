import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeCharacterKnowledgeCandidates as discover } from "../dist/motor-literario.js";
const ana={projectId:"book-1",id:"character:ana",kind:"character",canonicalName:"Ana",normalizedName:"ana",aliases:[],evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1};
const bruno={...ana,id:"character:bruno",canonicalName:"Bruno",normalizedName:"bruno"};
const context={projectId:"book-1",documentId:"chapter-1",revision:3,entities:[ana,bruno]};

test("extrae conocimiento adquirido con proposición literal y offsets absolutos",()=>{
 const text="Ana se enteró de que Bruno había mentido.",r=discover({...context,text,baseOffset:50});
 assert.equal(r.length,1);assert.equal(r[0].kind,"learned");assert.equal(r[0].holderEntityId,ana.id);
 assert.equal(r[0].propositionEvidence.excerpt,"Bruno había mentido");assert.equal(r[0].triggerEvidence.excerpt,"se enteró");
 assert.equal(text.slice(r[0].propositionEvidence.start-50,r[0].propositionEvidence.end-50),r[0].propositionEvidence.excerpt);
});
test("distingue sospecha, creencia y recuerdo",()=>{
 const r=discover({...context,text:"Ana sospechó que Bruno mentía. Ana creyó que la puerta estaba abierta. Ana recordó que Bruno había llegado."});
 assert.deepEqual(r.map(x=>[x.kind,x.certainty]),[["suspected","uncertain-claim"],["believed","uncertain-claim"],["remembered","explicit-claim"]]);
});
test("registra transferencia solo con emisor y destinatario nombrados",()=>{
 const r=discover({...context,text:"Bruno reveló a Ana que el mapa era falso."})[0];
 assert.equal(r.kind,"reported");assert.equal(r.sourceEntityId,bruno.id);assert.equal(r.holderEntityId,ana.id);
 assert.equal(r.sourceEvidence.excerpt,"Bruno");assert.equal(r.holderEvidence.excerpt,"Ana");
 assert.equal(r.propositionEvidence.excerpt,"el mapa era falso");
});
test("no resuelve destinatarios pronominales ni emisores ambiguos",()=>{
 assert.deepEqual(discover({...context,text:"Bruno le contó que el mapa era falso."}),[]);
 const other={...ana,id:"character:alicia",canonicalName:"Alicia",normalizedName:"alicia"};
 assert.deepEqual(discover({...context,entities:[ana,bruno,other],text:"Bruno contó que el mapa era falso."}),[]);
});
test("no atribuye conocimiento a varios personajes posibles",()=>{
 assert.deepEqual(discover({...context,text:"Ana y Bruno supieron que el mapa era falso."}),[]);
});
test("conserva negación y no convierte creencia en certeza",()=>{
 const r=discover({...context,text:"Ana no creyó que Bruno hubiera mentido."})[0];
 assert.equal(r.kind,"believed");assert.equal(r.polarity,"negated");assert.equal(r.certainty,"uncertain-claim");
});
test("no extrae proposición ausente ni nombres parciales",()=>{
 assert.deepEqual(discover({...context,text:"Ana supo la verdad."}),[]);
 assert.deepEqual(discover({...context,text:"La ventana estaba abierta."}),[]);
});
test("rechaza entidades duplicadas, alias vacíos y offsets inválidos",()=>{
 assert.throws(()=>discover({...context,entities:[ana,ana],text:"Ana supo que Bruno mentía."}));
 assert.throws(()=>discover({...context,entities:[{...ana,aliases:[" "]}],text:"Ana supo que Bruno mentía."}));
 assert.throws(()=>discover({...context,baseOffset:-1,text:"Ana supo que Bruno mentía."}));
});
test("respeta presupuesto y máximo de candidatos",()=>{
 const many=Array.from({length:5000},(_,i)=>({...ana,id:"c:"+i,canonicalName:"Personaje"+i,normalizedName:"personaje"+i}));
 assert.throws(()=>discover({...context,entities:many,text:"x".repeat(10000)}),/presupuesto/);
 const dense="Ana supo que Bruno mentía. ".repeat(501);
 assert.throws(()=>discover({...context,text:dense}),/límite de afirmaciones/);
});

test("distingue conocimiento ya poseído, información oída e información leída",()=>{
 const r=discover({...context,text:"Ana sabía que Bruno mentía. Ana escuchó que el puente cayó. Ana leyó que la guerra había terminado."});
 assert.deepEqual(r.map(x=>x.kind),["known","heard","read"]);
});
