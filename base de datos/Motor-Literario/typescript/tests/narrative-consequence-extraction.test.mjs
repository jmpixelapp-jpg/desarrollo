import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrativeConsequenceCandidates } from "../dist/motor-literario.js";

function event(id, start, end, excerpt, participants = [], characterParticipants = participants) {
  return {
    id, projectId: "book-1", label: excerpt,
    participantEntityIds: participants, characterParticipantEntityIds: characterParticipants, actionCandidateIds: [],
    reviewStatus: "candidate",
    evidence: { documentId: "chapter-1", revision: 2, start, end, excerpt }
  };
}
function input(text, events) {
  return { projectId: "book-1", documentId: "chapter-1", revision: 2, text, events };
}

test("vincula dos acontecimientos consecutivos con un marcador explícito", () => {
  const text = "Mara abrió la puerta. Por eso Elian escapó.";
  const first = text.indexOf("Mara");
  const second = text.indexOf("Por eso");
  const events = [
    event("event-1", first, text.indexOf(".") + 1, "Mara abrió la puerta."),
    event("event-2", second, text.length, "Por eso Elian escapó.")
  ];
  const results = extractNarrativeConsequenceCandidates(input(text, events));
  assert.equal(results.length, 1);
  assert.equal(results[0].sourceEventId, "event-1");
  assert.equal(results[0].consequenceEventId, "event-2");
  assert.equal(results[0].marker, "Por eso");
  assert.equal(results[0].reviewStatus, "candidate");
  assert.equal(results[0].hypothesisBasis, "explicit-linguistic-connector");
  assert.deepEqual(results[0].sharedCharacterEntityIds, []);
  assert.equal(results[0].supportingEvidence.sourceEvent.excerpt, "Mara abrió la puerta.");
  assert.equal(results[0].supportingEvidence.consequenceEvent.excerpt, "Por eso Elian escapó.");
  assert.equal(text.slice(results[0].evidence.start, results[0].evidence.end), "Por eso");
});

test("reconoce conectores compuestos y mantiene el texto de evidencia exacto", () => {
  const text = "Mara encontró la llave. Como consecuencia de ello, la puerta se abrió.";
  const a = text.indexOf("Mara"), b = text.indexOf("Como consecuencia");
  const events = [
    event("e1", a, text.indexOf(".") + 1, "Mara encontró la llave."),
    event("e2", b, text.length, "Como consecuencia de ello, la puerta se abrió.")
  ];
  const result = extractNarrativeConsequenceCandidates(input(text, events));
  assert.equal(result[0].marker, "Como consecuencia de ello");
});

test("no inventa causalidad cuando solo hay sucesión temporal", () => {
  const text = "Mara abrió la puerta. Después Elian escapó.";
  const a = text.indexOf("Mara"), b = text.indexOf("Después");
  const events = [
    event("e1", a, text.indexOf(".") + 1, "Mara abrió la puerta."),
    event("e2", b, text.length, "Después Elian escapó.")
  ];
  assert.deepEqual(extractNarrativeConsequenceCandidates(input(text, events)), []);
});

test("rechaza acontecimientos de otro documento o revisión", () => {
  const text = "Mara abrió la puerta. Por eso Elian escapó.";
  const a = text.indexOf("Mara"), b = text.indexOf("Por eso");
  const events = [
    event("e1", a, text.indexOf(".") + 1, "Mara abrió la puerta."),
    { ...event("e2", b, text.length, "Por eso Elian escapó."),
      evidence: { ...event("e2", b, text.length, "Por eso Elian escapó.").evidence, revision: 1 } }
  ];
  assert.throws(() => extractNarrativeConsequenceCandidates(input(text, events)), /mismo documento y revisión/);
});

test("no enlaza acontecimientos separados por un salto de párrafo", () => {
  const text = "Mara abrió la puerta.\n\nPor eso Elian escapó.";
  const a = text.indexOf("Mara"), b = text.indexOf("Por eso");
  const events = [
    event("e1", a, text.indexOf(".") + 1, "Mara abrió la puerta."),
    event("e2", b, text.length, "Por eso Elian escapó.")
  ];
  assert.deepEqual(extractNarrativeConsequenceCandidates(input(text, events)), []);
});

test("rechaza evidencia cuyo fragmento no coincide con el documento", () => {
  const text = "Mara abrió la puerta. Por eso Elian escapó.";
  const a = text.indexOf("Mara"), b = text.indexOf("Por eso");
  const events = [
    event("e1", a, text.indexOf(".") + 1, "Mara abrió la puerta."),
    event("e2", b, text.length, "Por eso Elian escapó.")
  ];
  events[1].evidence.excerpt = "Por eso Mara escapó.";
  assert.throws(() => extractNarrativeConsequenceCandidates(input(text, events)), /mismo documento y revisión/);
});

test("reconoce conectores causales explícitos adicionales sin convertir sucesión en causalidad",()=>{
  for (const marker of ["Debido a ello","Debido a eso","A causa de ello","Por esa causa"]) {
    const text="Mara encontró la llave. "+marker+" la puerta se abrió.";
    const a=text.indexOf("Mara"), b=text.indexOf(marker);
    const events=[
      event("source-"+marker,a,text.indexOf(".")+1,"Mara encontró la llave."),
      event("result-"+marker,b,text.length,text.slice(b))
    ];
    const [result]=extractNarrativeConsequenceCandidates(input(text,events));
    assert.equal(result.marker,marker);
    assert.equal(text.slice(result.evidence.start,result.evidence.end),marker);
  }
});

test("marca la proximidad temporal como hipótesis no demostrada si comparten participante",()=>{
  const text="Mara abrió la puerta. Poco después, Mara escapó.";
  const a=text.indexOf("Mara"), b=text.indexOf("Poco después");
  const events=[
    event("source-temporal",a,text.indexOf(".")+1,"Mara abrió la puerta.",["mara"]),
    event("result-temporal",b,text.length,text.slice(b),["mara"])
  ];
  const [result]=extractNarrativeConsequenceCandidates(input(text,events));
  assert.equal(result.relationType,"temporal-association-hypothesis");
  assert.equal(result.causalStatus,"unproven-hypothesis");
  assert.equal(result.hypothesisBasis,"temporal-marker-and-shared-character");
  assert.deepEqual(result.sharedCharacterEntityIds,["mara"]);
  assert.equal(result.supportingEvidence.sourceEvent.excerpt,"Mara abrió la puerta.");
  assert.equal(result.supportingEvidence.consequenceEvent.excerpt,"Poco después, Mara escapó.");
  assert.equal(result.marker,"Poco después");
  assert.equal(text.slice(result.evidence.start,result.evidence.end), "Poco después");
});
test("no propone hipótesis temporal sin participantes compartidos",()=>{
  const text="Mara abrió la puerta. Poco después, Elian escapó.";
  const a=text.indexOf("Mara"), b=text.indexOf("Poco después");
  const events=[
    event("source-independent",a,text.indexOf(".")+1,"Mara abrió la puerta.",["mara"]),
    event("result-independent",b,text.length,text.slice(b),["elian"])
  ];
  assert.deepEqual(extractNarrativeConsequenceCandidates(input(text,events)),[]);
});
test("la sucesión temporal no se eleva a causalidad explícita",()=>{
  const text="Mara abrió la puerta. Después, Mara escapó.";
  const a=text.indexOf("Mara"), b=text.indexOf("Después");
  const events=[
    event("source-temporal-only",a,text.indexOf(".")+1,"Mara abrió la puerta.",["mara"]),
    event("result-temporal-only",b,text.length,text.slice(b),["mara"])
  ];
  const [result]=extractNarrativeConsequenceCandidates(input(text,events));
  assert.equal(result.causalStatus,"unproven-hypothesis");
  assert.notEqual(result.relationType,"explicit-consequence-marker");
});

test("no crea hipótesis temporal a través de un límite entre párrafos",()=>{
  const text="Mara abrió la puerta.\n\nPoco después, Mara escapó.";
  const a=text.indexOf("Mara"), b=text.indexOf("Poco después");
  const events=[
    event("source-paragraph",a,text.indexOf(".")+1,"Mara abrió la puerta.",["mara"]),
    event("result-paragraph",b,text.length,text.slice(b),["mara"])
  ];
  assert.deepEqual(extractNarrativeConsequenceCandidates(input(text,events)),[]);
});
test("rechaza participantes mal formados y eventos duplicados",()=>{
  const text="Mara abrió la puerta. Después, Mara escapó.";
  const a=text.indexOf("Mara"), b=text.indexOf("Después");
  const first=event("duplicate",a,text.indexOf(".")+1,"Mara abrió la puerta.",["mara"]);
  const second=event("duplicate",b,text.length,text.slice(b),["mara"]);
  assert.throws(()=>extractNarrativeConsequenceCandidates(input(text,[first,second])),/únicos, válidos/);
  const malformed=event("malformed",a,text.indexOf(".")+1,"Mara abrió la puerta.");
  malformed.participantEntityIds=null;
  assert.throws(()=>extractNarrativeConsequenceCandidates(input(text,[malformed])),/únicos, válidos/);
});

test("mantiene offsets absolutos al analizar una ventana del documento",()=>{
  const prefix="Prólogo sin eventos. ";
  const fragment="Mara abrió la puerta. Poco después, Mara escapó.";
  const text=prefix+fragment;
  const baseOffset=prefix.length;
  const a=baseOffset+fragment.indexOf("Mara");
  const b=baseOffset+fragment.indexOf("Poco después");
  const events=[
    event("window-source",a,baseOffset+fragment.indexOf(".")+1,"Mara abrió la puerta.",["mara"]),
    event("window-result",b,text.length,text.slice(b),["mara"])
  ];
  const [result]=extractNarrativeConsequenceCandidates({...input(fragment,events),text:fragment,baseOffset});
  assert.equal(result.evidence.start,b);
  assert.equal(result.evidence.end,b+"Poco después".length);
  assert.equal(text.slice(result.evidence.start,result.evidence.end), "Poco después");
});

test("un objeto compartido no se confunde con un personaje compartido",()=>{
  const text="Mara abrió la puerta. Poco después, Elian escapó.";
  const a=text.indexOf("Mara"), b=text.indexOf("Poco después");
  const events=[
    event("source-object",a,text.indexOf(".")+1,"Mara abrió la puerta.",["mara","door"],[]),
    event("result-object",b,text.length,text.slice(b),["elian","door"],[])
  ];
  assert.deepEqual(extractNarrativeConsequenceCandidates(input(text,events)),[]);
});
test("valida que los participantes-personaje pertenezcan al conjunto de participantes",()=>{
  const text="Mara abrió la puerta. Después, Mara escapó.";
  const a=text.indexOf("Mara");
  const malformed=event("invalid-character-participant",a,text.indexOf(".")+1,"Mara abrió la puerta.",["mara"],["ghost"]);
  assert.throws(()=>extractNarrativeConsequenceCandidates(input(text,[malformed])),/únicos, válidos/);
});

test("la evidencia de soporte conserva documento, revisión y rangos exactos de ambos eventos",()=>{
  const text="Mara protegió a Elian. Por eso Elian escapó.";
  const a=text.indexOf("Mara"), b=text.indexOf("Por eso");
  const source=event("source-support",a,text.indexOf(".")+1,"Mara protegió a Elian.",["mara","elian"],["mara","elian"]);
  const consequence=event("result-support",b,text.length,text.slice(b),["elian"],["elian"]);
  const [result]=extractNarrativeConsequenceCandidates(input(text,[source,consequence]));
  assert.deepEqual(result.supportingEvidence.sourceEvent,{
    documentId:"chapter-1",revision:2,start:a,end:text.indexOf(".")+1,excerpt:"Mara protegió a Elian."
  });
  assert.deepEqual(result.supportingEvidence.consequenceEvent,{
    documentId:"chapter-1",revision:2,start:b,end:text.length,excerpt:"Por eso Elian escapó."
  });
});
