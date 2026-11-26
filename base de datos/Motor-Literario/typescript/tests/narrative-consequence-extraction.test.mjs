import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrativeConsequenceCandidates } from "../dist/motor-literario.js";

function event(id, start, end, excerpt, participants = []) {
  return {
    id, projectId: "book-1", label: excerpt,
    participantEntityIds: participants, actionCandidateIds: [],
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
