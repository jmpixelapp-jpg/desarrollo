import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeLocationTransitionCandidates } from "../dist/motor-literario.js";

function observation({
  text, action, actionSurface, location, locationStart,
  tense = "past-preterite", polarity = "affirmed",
  actorId = "character:ana", baseOffset = 0
}) {
  const actionStart = text.indexOf(actionSurface);
  const locationStartIndex = locationStart ?? text.indexOf(location);
  const evidence = (start, end, excerpt) => ({
    documentId: "chapter-1", revision: 3,
    start: baseOffset + start, end: baseOffset + end, excerpt
  });
  return {
    id: "obs:" + action + ":" + actionStart,
    projectId: "book-1", documentId: "chapter-1", revision: 3,
    kind: "action", action, surface: actionSurface,
    grammaticalTense: tense,
    grammaticalSubjectCandidate: {
      entityId: actorId, voice: "active",
      evidence: evidence(0, 3, text.slice(0, 3))
    },
    entityMentionEvidence: [{
      entityId: "location:" + location.toLowerCase().replace(/\s+/gu, "-"),
      entityKind: "location",
      evidence: evidence(locationStartIndex, locationStartIndex + location.length, location)
    }],
    polarity, confidence: "medium", reviewStatus: "candidate",
    actionEvidence: evidence(actionStart, actionStart + actionSurface.length, actionSurface),
    evidence: evidence(0, text.length, text)
  };
}

function discover(item) {
  return discoverNarrativeLocationTransitionCandidates({
    projectId: "book-1", documentId: "chapter-1", revision: 3,
    observations: [item]
  });
}

test("detecta llegada solo con preposición y lugar explícitos", () => {
  const text = "Ana llegó al puerto.";
  const [result] = discover(observation({
    text, action: "llegar", actionSurface: "llegó", location: "puerto", baseOffset: 40
  }));
  assert.equal(result.transition, "arrived");
  assert.equal(result.locationEntityId, "location:puerto");
  assert.equal(result.actorEntityId, "character:ana");
  assert.equal(result.relationEvidence.excerpt, " al ");
  assert.equal(result.locationEvidence.start, 40 + text.indexOf("puerto"));
  assert.equal(result.contextEvidence.excerpt, text);
  assert.equal(result.effectStatus, "candidate");
});

test("distingue salida, entrada, tránsito y regreso", () => {
  const cases = [
    ["Ana salió de la ciudad.", "salir", "salió", "ciudad", "departed"],
    ["Ana entró en la torre.", "entrar", "entró", "torre", "entered"],
    ["Ana cruzó por el bosque.", "cruzar", "cruzó", "bosque", "passed-through"],
    ["Ana regresó al castillo.", "regresar", "regresó", "castillo", "returned"]
  ];
  for (const [text, action, surface, location, expected] of cases) {
    assert.equal(discover(observation({
      text, action, actionSurface: surface, location
    }))[0]?.transition, expected);
  }
});

test("no confirma movimientos negados ni futuros", () => {
  const negatedText = "Ana no llegó al puerto.";
  const negated = discover(observation({
    text: negatedText, action: "llegar", actionSurface: "llegó",
    location: "puerto", polarity: "negated"
  }))[0];
  assert.equal(negated.effectStatus, "not-applied");
  const futureText = "Ana llegará al puerto.";
  const future = discover(observation({
    text: futureText, action: "llegar", actionSurface: "llegará",
    location: "puerto", tense: "future"
  }))[0];
  assert.equal(future.effectStatus, "prospective");
});

test("no deduce relación espacial por mera proximidad o preposición incorrecta", () => {
  const text = "Ana llegó desde el puerto.";
  assert.deepEqual(discover(observation({
    text, action: "llegar", actionSurface: "llegó", location: "puerto"
  })), []);
});

test("rechaza evidencia ajena al contexto o con offsets inconsistentes", () => {
  const text = "Ana llegó al puerto.";
  const item = observation({
    text, action: "llegar", actionSurface: "llegó", location: "puerto"
  });
  const invalid = {
    ...item,
    entityMentionEvidence: [{
      ...item.entityMentionEvidence[0],
      evidence: { ...item.entityMentionEvidence[0].evidence, excerpt: "ciudad" }
    }]
  };
  assert.throws(() => discover(invalid));
});
