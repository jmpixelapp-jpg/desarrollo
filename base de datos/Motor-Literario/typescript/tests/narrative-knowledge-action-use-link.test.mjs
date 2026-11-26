import test from "node:test";
import assert from "node:assert/strict";
import { linkNarrativeKnowledgeToActionUse as link } from "../dist/motor-literario.js";
const ev=(doc,rev,start,excerpt)=>({documentId:doc,revision:rev,start,end:start+excerpt.length,excerpt});
const knowledge=(id,holder,proposition)=>{
 const text="Ana supo que "+proposition+".";
 return {id,projectId:"book",documentId:"ch1",revision:1,kind:"learned",mode:"asserted-cognition",
 holderEntityId:holder,propositionEvidence:ev("ch1",1,13,proposition),holderEvidence:ev("ch1",1,0,"Ana"),
 triggerEvidence:ev("ch1",1,4,"supo"),evidence:ev("ch1",1,0,text),
 polarity:"affirmed",certainty:"explicit-claim",reviewStatus:"candidate"};
};
const action=(id,subject,text,actionWord)=>{
 const start=100;
 return {id,projectId:"book",documentId:"ch1",revision:1,kind:"action",action:"huir",surface:"huyó",
 grammaticalTense:"past-preterite",grammaticalSubjectCandidate:{entityId:subject,voice:"active",evidence:ev("ch1",1,start,"Ana")},
 mentionedCharacterIds:[subject],mentionedEntityIds:[],entityMentionEvidence:[],entityMentionOccurrences:[],
 epistemicFrame:"narrator-asserted",polarity:"affirmed",confidence:"medium",reviewStatus:"candidate",
 actionEvidence:ev("ch1",1,start+text.indexOf(actionWord),actionWord),evidence:ev("ch1",1,start,text)};
};
test("enlaza conocimiento cuando la acción incluye marcador explícito y proposición",()=>{
 const k=knowledge("k1","ana","Bruno había regresado");
 const a=action("a1","ana","Sabiendo que Bruno había regresado, Ana huyó.","huyó");
 const [x]=link({projectId:"book",knowledgeCandidates:[k],observations:[a]});
 assert.equal(x.marker,"knowing-that");assert.equal(x.knowledgeUseEstablished,false);
 assert.equal(x.actionCausationEstablished,false);
});
test("no enlaza por simple proximidad entre saber y acción",()=>{
 const k=knowledge("k1","ana","Bruno había regresado");
 const a=action("a1","ana","Ana huyó después de saberlo.","huyó");
 assert.deepEqual(link({projectId:"book",knowledgeCandidates:[k],observations:[a]}),[]);
});
test("no enlaza cuando el actor de la acción no es el titular del conocimiento",()=>{
 const k=knowledge("k1","ana","Bruno había regresado");
 const a=action("a1","bruno","Sabiendo que Bruno había regresado, Bruno huyó.","huyó");
 assert.deepEqual(link({projectId:"book",knowledgeCandidates:[k],observations:[a]}),[]);
});
test("no enlaza creencias inciertas ni afirmaciones negadas",()=>{
 const k=knowledge("k1","ana","Bruno había regresado");
 const a=action("a1","ana","Sabiendo que Bruno había regresado, Ana huyó.","huyó");
 assert.deepEqual(link({projectId:"book",knowledgeCandidates:[{...k,mode:"uncertain-cognition"}],observations:[a]}),[]);
 assert.deepEqual(link({projectId:"book",knowledgeCandidates:[{...k,polarity:"negated"}],observations:[a]}),[]);
});
test("reconoce recuerdo explícito como contexto de la acción",()=>{
 const k=knowledge("k1","ana","Bruno había regresado");
 const a=action("a1","ana","Recordando que Bruno había regresado, Ana huyó.","huyó");
 const [x]=link({projectId:"book",knowledgeCandidates:[k],observations:[a]});
 assert.equal(x.marker,"remembering-that");
});
test("exige sujeto gramatical activo explícito",()=>{
 const k=knowledge("k1","ana","Bruno había regresado");
 const a=action("a1","ana","Sabiendo que Bruno había regresado, Ana huyó.","huyó");
 const {grammaticalSubjectCandidate,...without}=a;
 assert.deepEqual(link({projectId:"book",knowledgeCandidates:[k],observations:[without]}),[]);
});
test("rechaza evidencia inconsistente",()=>{
 const k=knowledge("k1","ana","Bruno había regresado");
 const a=action("a1","ana","Sabiendo que Bruno había regresado, Ana huyó.","huyó");
 assert.throws(()=>link({projectId:"book",knowledgeCandidates:[k],observations:[{...a,actionEvidence:ev("ch2",1,0,"huyó")}]}));
});
