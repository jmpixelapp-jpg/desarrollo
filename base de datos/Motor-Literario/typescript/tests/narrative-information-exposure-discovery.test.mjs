import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeInformationExposureCandidates as discover } from "../dist/motor-literario.js";
const entity=(id,name,kind="character")=>({projectId:"book",id,kind,canonicalName:name,
 normalizedName:name.toLocaleLowerCase("es"),aliases:[],evidence:[],firstSeenAt:0,lastSeenAt:0,extractionVersion:1});
const base={projectId:"book",documentId:"chapter-1",revision:1,entities:[entity("ana","Ana") ]};
test("detecta un marcador explícito de secreto sin adjudicar conocimiento al lector",()=>{
 const text="El secreto era que la llave estaba bajo la mesa.";
 const [r]=discover({...base,text});
 assert.equal(r.signal,"secret-is-that");
 assert.equal(r.propositionEvidence.excerpt,"la llave estaba bajo la mesa");
 assert.equal(r.readerKnowledge,"not-established");
 assert.equal(r.focalization,"unresolved");
});
test("detecta una exposición marcada como verdad",()=>{
 const [r]=discover({...base,text:"La verdad era que Bruno había regresado."});
 assert.equal(r.signal,"truth-is-that");
 assert.equal(r.propositionEvidence.excerpt,"Bruno había regresado");
});
test("asocia un personaje solo cuando el nombre explícito coincide",()=>{
 const [r]=discover({...base,text:"Ana salió sin que Ana supiera que Bruno había vuelto."});
 assert.equal(r.signal,"character-unaware-that");
 assert.equal(r.subjectEntityId,"ana");
 assert.equal(r.propositionEvidence.excerpt,"Bruno había vuelto");
});
test("no infiere desconocimiento por ausencia de mención",()=>{
 assert.deepEqual(discover({...base,text:"Ana salió. Bruno había vuelto."}),[]);
});
test("no extrae marcadores dentro de un diálogo excluido",()=>{
 const text="«El secreto era que la puerta estaba abierta»";
 const excluded=[{documentId:"chapter-1",revision:1,start:0,end:text.length,excerpt:text}];
 assert.deepEqual(discover({...base,text,excludedDialogueEvidence:excluded}),[]);
});
test("no mezcla revisiones o documentos en las exclusiones",()=>{
 const text="El secreto era que la llave estaba aquí.";
 assert.throws(()=>discover({...base,text,excludedDialogueEvidence:[
  {documentId:"chapter-1",revision:2,start:0,end:5,excerpt:"El se"}
 ]}));
});
test("respeta baseOffset absoluto en evidencia",()=>{
 const text="La verdad era que Ana había mentido.";
 const [r]=discover({...base,text,baseOffset:120});
 assert.equal(r.triggerEvidence.start,120);
 assert.equal(r.propositionEvidence.start,120+text.indexOf("Ana"));
});
test("rechaza entidades inválidas y exceso de tamaño",()=>{
 assert.throws(()=>discover({...base,entities:[entity("ana","Ana"),entity("ana","Otra")],text:"El secreto era que huyó."}));
 assert.throws(()=>discover({...base,baseOffset:Number.MAX_SAFE_INTEGER,text:"El secreto era que huyó."}));
});
test("no genera proposiciones vacías ni excede la frase",()=>{
 assert.deepEqual(discover({...base,text:"El secreto era que ."}),[]);
});
