import test from "node:test";
import assert from "node:assert/strict";
import {
 discoverNarrativeCharacterKnowledgeCandidates,
 discoverNarrativeInformationConcealmentCandidates,
 linkNarrativeKnowledgeToConcealment
} from "../dist/motor-literario.js";
const ana={projectId:"book",id:"ana",kind:"character",canonicalName:"Ana",normalizedName:"ana",aliases:[],evidence:[],firstSeenAt:0,lastSeenAt:0,extractionVersion:1};
const bruno={...ana,id:"bruno",canonicalName:"Bruno",normalizedName:"bruno"};
const entities=[ana,bruno];
const knowledge=(text,documentId="chapter-1",revision=1)=>discoverNarrativeCharacterKnowledgeCandidates({
 projectId:"book",documentId,revision,text,entities
});
const concealment=(text,documentId="chapter-1",revision=1)=>discoverNarrativeInformationConcealmentCandidates({
 projectId:"book",documentId,revision,text,entities
});
test("enlaza conocimiento explícito anterior con ocultación de la misma proposición",()=>{
 const known=knowledge("Ana sabía que la carta estaba en el cajón.");
 const hidden=concealment("Ana ocultó a Bruno que la carta estaba en el cajón.","chapter-1");
 const links=linkNarrativeKnowledgeToConcealment({projectId:"book",knowledgeCandidates:known,concealmentCandidates:hidden});
 assert.equal(links.length,1);
 assert.equal(links[0].relation,"prior-knowledge-before-concealment");
 assert.equal(links[0].chronologyBasis,"same-document-revision-offset");
 assert.equal(links[0].deceptionEstablished,false);
});
test("enlaza mentira explícita sin certificar falsedad o intención",()=>{
 const known=knowledge("Ana sabía que Bruno había vuelto.");
 const lied=concealment("Ana mintió a Bruno diciendo que Bruno había vuelto.");
 const links=linkNarrativeKnowledgeToConcealment({projectId:"book",knowledgeCandidates:known,concealmentCandidates:lied});
 assert.equal(links.length,1);
 assert.equal(links[0].relation,"prior-knowledge-before-lie");
 assert.equal(links[0].intentEstablished,false);
});
test("exige coincidencia literal normalizada de la proposición",()=>{
 const known=knowledge("Ana sabía que la carta estaba en el cajón.");
 const hidden=concealment("Ana ocultó que la carta estaba sobre la mesa.");
 assert.deepEqual(linkNarrativeKnowledgeToConcealment({projectId:"book",knowledgeCandidates:known,concealmentCandidates:hidden}),[]);
});
test("no utiliza sospechas, creencias ni transferencias como conocimiento cierto previo",()=>{
 const candidates=[
  ...knowledge("Ana sospechó que Bruno había vuelto."),
  ...knowledge("Ana creyó que Bruno había vuelto."),
  ...knowledge("Ana oyó que Bruno había vuelto.")
 ];
 const hidden=concealment("Ana ocultó que Bruno había vuelto.");
 const links=linkNarrativeKnowledgeToConcealment({projectId:"book",knowledgeCandidates:candidates,concealmentCandidates:hidden});
 assert.equal(links.length,1);
 assert.equal(links[0].knowledgeKind,"heard");
});
test("no enlaza conocimiento posterior al acto de ocultación",()=>{
 const hidden=concealment("Ana ocultó que Bruno había vuelto.");
 const known=knowledge("Ana supo que Bruno había vuelto.");
 assert.deepEqual(linkNarrativeKnowledgeToConcealment({projectId:"book",knowledgeCandidates:known,concealmentCandidates:hidden}),[]);
});
test("solo ordena documentos distintos con orden explícito",()=>{
 const known=knowledge("Ana sabía que Bruno había vuelto.","chapter-a");
 const hidden=concealment("Ana ocultó que Bruno había vuelto.","chapter-b");
 assert.deepEqual(linkNarrativeKnowledgeToConcealment({projectId:"book",knowledgeCandidates:known,concealmentCandidates:hidden}),[]);
 const links=linkNarrativeKnowledgeToConcealment({projectId:"book",knowledgeCandidates:known,concealmentCandidates:hidden,
  documentOrder:[{documentId:"chapter-a",order:1},{documentId:"chapter-b",order:2}]});
 assert.equal(links.length,1);
 assert.equal(links[0].chronologyBasis,"explicit-document-order");
});
test("no compara revisiones diferentes del mismo documento como si fueran cronología",()=>{
 const known=knowledge("Ana sabía que Bruno había vuelto.","chapter-1",1);
 const hidden=concealment("Ana ocultó que Bruno había vuelto.","chapter-1",2);
 assert.deepEqual(linkNarrativeKnowledgeToConcealment({projectId:"book",knowledgeCandidates:known,concealmentCandidates:hidden,
  documentOrder:[{documentId:"chapter-1",order:1}]}),[]);
});
test("no enlaza afirmaciones negadas ni actos de ocultación negados",()=>{
 const known=knowledge("Ana no sabía que Bruno había vuelto.");
 const hidden=concealment("Ana no ocultó que Bruno había vuelto.");
 assert.deepEqual(linkNarrativeKnowledgeToConcealment({projectId:"book",knowledgeCandidates:known,concealmentCandidates:hidden}),[]);
});
test("rechaza evidencia modificada y proyectos ajenos",()=>{
 const known=knowledge("Ana sabía que Bruno había vuelto.");
 const hidden=concealment("Ana ocultó que Bruno había vuelto.");
 assert.throws(()=>linkNarrativeKnowledgeToConcealment({projectId:"other",knowledgeCandidates:known,concealmentCandidates:hidden}));
 assert.throws(()=>linkNarrativeKnowledgeToConcealment({projectId:"book",
  knowledgeCandidates:[{...known[0],evidence:{...known[0].evidence,excerpt:"falso"}}],concealmentCandidates:hidden}));
});
test("valida orden documental duplicado",()=>{
 const known=knowledge("Ana sabía que Bruno había vuelto.","chapter-a");
 const hidden=concealment("Ana ocultó que Bruno había vuelto.","chapter-b");
 assert.throws(()=>linkNarrativeKnowledgeToConcealment({projectId:"book",knowledgeCandidates:known,concealmentCandidates:hidden,
  documentOrder:[{documentId:"chapter-a",order:1},{documentId:"chapter-b",order:1}]}));
});
