import test from "node:test";
import assert from "node:assert/strict";
import {discoverNarrativePronounKnowledgeCandidates as discover} from "../dist/motor-literario.js";
const text="Ana llegó tarde. Ella sabía que Bruno había escapado.";
const ref={id:"pr1",projectId:"book",documentId:"ch1",revision:1,pronoun:"Ella",
 pronounEvidence:{documentId:"ch1",revision:1,start:17,end:21,excerpt:"Ella"},
 antecedentCandidates:[{entityId:"ana",entityKind:"character",antecedentEvidence:{documentId:"ch1",revision:1,start:0,end:3,excerpt:"Ana"},distance:14,mentionType:"canonical-name",sentenceDistance:1,paragraphDistance:0}],
 status:"single-candidate",reviewStatus:"candidate",searchWindowStart:0,searchWindowEnd:17};
const base={projectId:"book",documentId:"ch1",revision:1,text,pronounReferences:[ref]};
test("extrae conocimiento desde pronombre con antecedente único",()=>{
 const [x]=discover(base);assert.equal(x.holderEntityId,"ana");assert.equal(x.kind,"known");
 assert.equal(x.holderEvidence.excerpt,"Ella");assert.equal(x.propositionEvidence.excerpt,"Bruno había escapado");
});
test("no fuerza referencias ambiguas ni sin antecedente",()=>{
 assert.deepEqual(discover({...base,pronounReferences:[{...ref,status:"ambiguous",antecedentCandidates:[...ref.antecedentCandidates,{...ref.antecedentCandidates[0],entityId:"bea"}]}]}),[]);
 assert.deepEqual(discover({...base,pronounReferences:[{...ref,status:"no-antecedent",antecedentCandidates:[]}]}),[]);
});
test("no atribuye pronombre cuyo único antecedente no es personaje",()=>{
 assert.deepEqual(discover({...base,pronounReferences:[{...ref,antecedentCandidates:[{...ref.antecedentCandidates[0],entityKind:"object"}]}]}),[]);
});
test("conserva negación y marcos de creencia",()=>{
 const [x]=discover({...base,text:"Ana llegó. Ella no creía que Bruno escapara.",pronounReferences:[{...ref,pronounEvidence:{...ref.pronounEvidence,start:11,end:15}}]});
 assert.equal(x.kind,"believed");assert.equal(x.polarity,"negated");assert.equal(x.mode,"uncertain-cognition");
});
test("rechaza evidencia de pronombre que no coincide con la fuente",()=>{
 assert.throws(()=>discover({...base,pronounReferences:[{...ref,pronounEvidence:{...ref.pronounEvidence,excerpt:"Él"}}]}));
});
test("respeta offsets absolutos",()=>{
 const [x]=discover({...base,baseOffset:100,pronounReferences:[{...ref,pronounEvidence:{...ref.pronounEvidence,start:117,end:121},antecedentCandidates:[{...ref.antecedentCandidates[0],antecedentEvidence:{...ref.antecedentCandidates[0].antecedentEvidence,start:100,end:103}}]}]});
 assert.equal(x.holderEvidence.start,117);assert.equal(x.evidence.start,100);
});
