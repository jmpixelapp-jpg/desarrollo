import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeInformationReceptionCandidates as discover } from "../dist/motor-literario.js";
const ana={projectId:"book",id:"ana",kind:"character",canonicalName:"Ana",normalizedName:"ana",aliases:[],evidence:[],firstSeenAt:0,lastSeenAt:0,extractionVersion:1};
const bruno={...ana,id:"bruno",canonicalName:"Bruno",normalizedName:"bruno"};
const base={projectId:"book",documentId:"chapter-1",revision:2,entities:[ana,bruno]};
test("oír una proposición registra exposición, no comprensión",()=>{
 const [r]=discover({...base,text:"Ana oyó que Bruno había regresado."});
 assert.equal(r.stage,"exposure");assert.equal(r.signal,"heard-proposition");
 assert.equal(r.comprehensionEstablished,false);assert.equal(r.acceptanceEstablished,false);
 assert.equal(r.propositionEvidence.excerpt,"Bruno había regresado");
});
test("leer información explícita no equivale a aceptarla",()=>{
 const [r]=discover({...base,text:"Ana leyó que Bruno había mentido."});
 assert.equal(r.signal,"read-proposition");assert.equal(r.acceptanceEstablished,false);
});
test("recibir una noticia no prueba que se haya leído ni comprendido",()=>{
 const [r]=discover({...base,text:"Ana recibió la noticia de que Bruno había vuelto."});
 assert.equal(r.stage,"exposure");assert.equal(r.comprehensionEstablished,false);
});
test("comprender se separa de creer",()=>{
 const [r]=discover({...base,text:"Ana comprendió que Bruno mentía."});
 assert.equal(r.stage,"comprehension");assert.equal(r.comprehensionEstablished,true);
 assert.equal(r.acceptanceEstablished,false);
});
test("la falta explícita de comprensión queda registrada como tal",()=>{
 const [r]=discover({...base,text:"Ana no entendió que Bruno había partido."});
 assert.equal(r.signal,"failed-to-understand-proposition");assert.equal(r.polarity,"negated");
 assert.equal(r.comprehensionEstablished,false);
});
test("creencia y aceptación se registran en una dimensión separada",()=>{
 const r=discover({...base,text:"Ana creyó que Bruno decía la verdad. Ana aceptó que el trato había terminado."});
 assert.deepEqual(r.map(x=>x.stage),["acceptance","acceptance"]);
 assert.deepEqual(r.map(x=>x.signal),["believed-proposition","accepted-proposition"]);
});
test("detecta una interpretación errónea explícita sin afirmar la verdad de la proposición",()=>{
 const [r]=discover({...base,text:"Ana interpretó erróneamente que Bruno había huido."});
 assert.equal(r.stage,"misunderstanding");assert.equal(r.interpretation,"explicit-misinterpretation");
});
test("no atribuye pronombres ni menciones ambiguas",()=>{
 assert.deepEqual(discover({...base,text:"Ella oyó que Bruno había vuelto."}),[]);
 assert.deepEqual(discover({...base,text:"Ana y Bruno entendieron que la puerta estaba abierta."}),[]);
});
test("preserva offsets absolutos y revisión",()=>{
 const text="Ana oyó que Bruno había vuelto.";
 const [r]=discover({...base,text,baseOffset:90});
 assert.equal(r.triggerEvidence.start,90+text.indexOf("oyó"));
 assert.equal(r.propositionEvidence.excerpt,"Bruno había vuelto");
 assert.equal(r.evidence.revision,2);
});
test("no interpreta recepción de un objeto como recepción de su contenido",()=>{
 assert.deepEqual(discover({...base,text:"Ana recibió la carta de Bruno."}),[]);
});
test("valida entidades y límites de entrada",()=>{
 assert.throws(()=>discover({...base,entities:[ana,ana],text:"Ana oyó que Bruno volvió."}));
 assert.throws(()=>discover({...base,baseOffset:Number.MAX_SAFE_INTEGER,text:"Ana oyó que Bruno volvió."}));
});
test("no genera candidatos cuando falta la proposición explícita",()=>{
 assert.deepEqual(discover({...base,text:"Ana entendió la situación."}),[]);
});

test("conserva la negación de creencias sin registrarlas como aceptación",()=>{
 const [r]=discover({...base,text:"Ana no creyó que Bruno hubiera regresado."});
 assert.equal(r.stage,"acceptance");assert.equal(r.polarity,"negated");
 assert.equal(r.acceptanceEstablished,false);
});
test("no convierte una falta de escucha en exposición afirmada",()=>{
 const [r]=discover({...base,text:"Ana nunca oyó que Bruno había vuelto."});
 assert.equal(r.polarity,"negated");assert.equal(r.comprehensionEstablished,false);
});
