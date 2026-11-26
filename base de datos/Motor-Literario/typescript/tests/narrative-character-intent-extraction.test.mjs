import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrativeCharacterIntentCandidates } from "../dist/motor-literario.js";

const mara = {
  projectId:"book-1",id:"character:mara",kind:"character",
  canonicalName:"Mara",normalizedName:"mara",aliases:["La Guardiana"],
  evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1
};
const input=(text,entities=[mara])=>({projectId:"book-1",documentId:"chapter-1",revision:4,text,entities});

test("vincula un objetivo explícito a un personaje nombrado",()=>{
  const text="Mara desea encontrar a su hermano desaparecido.";
  const found=extractNarrativeCharacterIntentCandidates(input(text));
  assert.equal(found.length,1);
  assert.equal(found[0].characterEntityId,mara.id);
  assert.equal(found[0].kind,"goal");
  assert.equal(found[0].text,"encontrar a su hermano desaparecido");
  assert.equal(text.slice(found[0].evidence.start,found[0].evidence.end),found[0].text);
});
test("extrae motivación expresada mediante porque",()=>{
  const found=extractNarrativeCharacterIntentCandidates(input("Mara actúa porque teme perder a su familia."));
  assert.equal(found.length,1);
  assert.equal(found[0].kind,"motivation");
  assert.equal(found[0].text,"teme perder a su familia");
});
test("resuelve alias inequívoco",()=>{
  const found=extractNarrativeCharacterIntentCandidates(input("La Guardiana busca la llave perdida."));
  assert.equal(found.length,1);
  assert.equal(found[0].characterEntityId,mara.id);
});
test("se abstiene si aparecen dos personajes",()=>{
  const elian={...mara,id:"character:elian",canonicalName:"Elian",normalizedName:"elian",aliases:[]};
  assert.deepEqual(extractNarrativeCharacterIntentCandidates(input("Mara desea ayudar a Elian.",[mara,elian])),[]);
});
test("no atribuye sujetos tácitos",()=>{
  assert.deepEqual(extractNarrativeCharacterIntentCandidates(input("Desea encontrar la llave.")),[]);
});
test("aísla proyectos",()=>{
  assert.deepEqual(extractNarrativeCharacterIntentCandidates(input("Mara desea encontrar la llave.",[{...mara,projectId:"other"}])),[]);
});
test("conserva offsets UTF-16 de una ventana",()=>{
  const prefix="Prólogo.\n", sentence="Mara desea encontrar la llave.";
  const found=extractNarrativeCharacterIntentCandidates({...input(sentence),baseOffset:prefix.length});
  assert.equal(found[0].evidence.start,prefix.length+sentence.indexOf("encontrar"));
});

test("extrae un motivo indirecto cuando la causa está nombrada literalmente",()=>{
  const text="Mara luchó por miedo a perder a su hermana.";
  const found=extractNarrativeCharacterIntentCandidates(input(text));
  assert.equal(found.length,1);
  assert.equal(found[0].kind,"motivation");
  assert.equal(found[0].evidenceBasis,"explicit-causal-motive");
  assert.equal(found[0].text,"miedo a perder a su hermana");
  assert.equal(text.slice(found[0].evidence.start,found[0].evidence.end),found[0].text);
});
test("extrae el propósito declarado sin presentarlo como motivación psicológica",()=>{
  const text="Mara viajó al norte para encontrar la cura.";
  const found=extractNarrativeCharacterIntentCandidates(input(text));
  assert.equal(found.length,1);
  assert.equal(found[0].kind,"goal");
  assert.equal(found[0].evidenceBasis,"explicit-purpose");
  assert.equal(found[0].text,"encontrar la cura");
});
test("no inventa una motivación a partir de una acción sin marcador causal",()=>{
  assert.deepEqual(
    extractNarrativeCharacterIntentCandidates(input("Mara luchó contra los guardianes.")),
    []
  );
});

test("reconoce otras causas expresas y conserva el texto causal exacto",()=>{
  for (const [text,expected] of [
    ["Mara luchó por lealtad a Elian.","lealtad a Elian"],
    ["Mara atacó por venganza contra el rey.","venganza contra el rey"],
    ["Mara actuó porque teme perder su hogar.","teme perder su hogar"]
  ]) {
    const found=extractNarrativeCharacterIntentCandidates(input(text));
    assert.equal(found.length,1,text);
    assert.equal(found[0].kind,"motivation",text);
    assert.equal(found[0].text,expected,text);
    assert.equal(text.slice(found[0].evidence.start,found[0].evidence.end),expected,text);
  }
});
test("reconoce propósitos con marcadores compuestos",()=>{
  for (const marker of ["a fin de","con el fin de"]) {
    const text="Mara viajó "+marker+" encontrar la cura.";
    const found=extractNarrativeCharacterIntentCandidates(input(text));
    assert.equal(found.length,1,text);
    assert.equal(found[0].kind,"goal",text);
    assert.equal(found[0].evidenceBasis,"explicit-purpose",text);
    assert.equal(found[0].text,"encontrar la cura",text);
  }
});
