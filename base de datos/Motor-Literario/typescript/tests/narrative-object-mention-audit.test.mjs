import test from "node:test";
import assert from "node:assert/strict";
import {auditNarrativeObjectMentionCoverage as audit} from "../dist/motor-literario.js";
const text="Ana encontró la espada. Después la escondió.";
const ev=(start,excerpt)=>({documentId:"ch1",revision:1,start,end:start+excerpt.length,excerpt});
const observations=[
 {id:"o1",projectId:"p",documentId:"ch1",revision:1,kind:"action",action:"encontrar",surface:"encontró",actionEvidence:ev(4,"encontró"),evidence:ev(0,"Ana encontró la espada."),entityMentionOccurrences:[{entityId:"sword",entityKind:"object",evidence:ev(13,"la espada")}]},
 {id:"o2",projectId:"p",documentId:"ch1",revision:1,kind:"action",action:"esconder",surface:"escondió",actionEvidence:ev(34,"escondió"),evidence:ev(25,"Después la escondió."),entityMentionOccurrences:[{entityId:"sword",entityKind:"object",evidence:ev(33,"la")}]}];
const transition={id:"t1",projectId:"p",documentId:"ch1",revision:1,observationId:"o1",objectEntityId:"sword",transition:"discovered",polarity:"affirmed",grammaticalTense:"past-preterite",effectStatus:"candidate",actionEvidence:ev(4,"encontró"),objectEvidence:ev(13,"la espada"),contextEvidence:ev(0,"Ana encontró la espada."),reviewStatus:"candidate"};
const input={projectId:"p",documentId:"ch1",revision:1,text,observations,transitions:[transition]};
test("marca menciones cubiertas y menciones de objeto sin transición extraída",()=>{
 const result=audit(input);assert.equal(result.length,2);
 assert.equal(result[0].status,"transition-evidence-matched");
 assert.equal(result[1].status,"object-mention-without-transition");
 assert.equal(result[1].interpretation,"coverage-gap-not-semantic-absence");
});
test("no enlaza por identidad sola si la evidencia textual no coincide",()=>{
 const result=audit({...input,transitions:[{...transition,objectEvidence:ev(13,"espada")}]});
 assert.equal(result[0].status,"object-mention-without-transition");
});
test("separa entidades distintas aunque compartan una misma oración",()=>{
 const result=audit({...input,observations:[{...observations[0],entityMentionOccurrences:[...observations[0].entityMentionOccurrences,{entityId:"key",entityKind:"object",evidence:ev(13,"la espada")}]}]});
 assert.deepEqual(result.map(x=>x.entityId),["sword","key"]);
 assert.equal(result[1].status,"object-mention-without-transition");
});
test("valida proyecto, revisión, extracto y pertenencia de transición",()=>{
 assert.throws(()=>audit({...input,observations:[{...observations[0],projectId:"other"}]}));
 assert.throws(()=>audit({...input,observations:[{...observations[0],entityMentionOccurrences:[{entityId:"sword",entityKind:"object",evidence:ev(13,"objeto")}]}]}));
 assert.throws(()=>audit({...input,transitions:[{...transition,observationId:"unknown"}]}));
});
test("respeta offsets absolutos",()=>{
 const base=100,shift=e=>({...e,start:e.start+base,end:e.end+base});
 const shifted={...input,baseOffset:base,observations:observations.map(o=>({...o,evidence:shift(o.evidence),actionEvidence:shift(o.actionEvidence),entityMentionOccurrences:o.entityMentionOccurrences.map(m=>({...m,evidence:shift(m.evidence)}))})),transitions:[{...transition,actionEvidence:shift(transition.actionEvidence),objectEvidence:shift(transition.objectEvidence),contextEvidence:shift(transition.contextEvidence)}]};
 assert.equal(audit(shifted)[0].mentionEvidence.start,113);
});
test("rechaza límites de recursos excedidos",()=>{
 assert.throws(()=>audit({...input,transitions:Array(20_001).fill(transition)}));
});
