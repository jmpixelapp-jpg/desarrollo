import test from "node:test";
import assert from "node:assert/strict";
import { detectExplicitStateContradictions, extractNarrativeEvents } from "../dist/motor-literario.js";

function character(id, canonicalName) {
  return {
    projectId: "unicode-event-boundaries",
    id,
    kind: "character",
    canonicalName,
    normalizedName: canonicalName.normalize("NFKC").trim().toLocaleLowerCase("es"),
    aliases: [],
    evidence: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
    extractionVersion: 1
  };
}

test("un nombre no coincide parcialmente antes de una marca combinante en participantes", () => {
  const combiningMark = String.fromCodePoint(0x0301);
  const text = "ACONTECIMIENTO: Ana" + combiningMark + " desaparece.";
  const events = extractNarrativeEvents(
    "unicode-event-boundaries", "chapter", 1, text, [character("ana", "Ana")]
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].participants, []);
});

test("un nombre que contiene una marca combinante sí coincide de forma completa", () => {
  const decomposedName = "Ana" + String.fromCodePoint(0x0301);
  const text = `ACONTECIMIENTO: ${decomposedName} desaparece.`;
  const events = extractNarrativeEvents(
    "unicode-event-boundaries", "chapter", 1, text,
    [character("ana-decomposed", decomposedName)]
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].participants, ["ana-decomposed"]);
  assert.equal(text.slice(events[0].evidence[0].start, events[0].evidence[0].end), events[0].label);
});

test("una marca combinante anterior al nombre impide una coincidencia parcial", () => {
  const combiningMark = String.fromCodePoint(0x0301);
  const text = "ACONTECIMIENTO: " + combiningMark + "Ana desaparece.";
  const events = extractNarrativeEvents(
    "unicode-event-boundaries", "chapter", 1, text, [character("ana", "Ana")]
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].participants, []);
});

function event(projectId, id, label, documentId) {
  return {
    projectId, id, label, participants: [],
    evidence: [{ documentId, revision: 1, start: 0, end: label.length, excerpt: label }]
  };
}

test("los diagnósticos vitales no atribuyen una afirmación a un nombre que solo coincide como prefijo", () => {
  const projectId = "unicode-event-boundaries";
  const combiningMark = String.fromCodePoint(0x0301);
  const events = [
    event(projectId, "alive", "Ana" + combiningMark + " está viva.", "chapter-1"),
    event(projectId, "dead", "Ana murió.", "chapter-2")
  ];
  const contradictions = detectExplicitStateContradictions(
    projectId, events, [character("ana", "Ana")]
  );
  assert.deepEqual(contradictions, []);
});

test("los diagnósticos vitales reconocen nombres canónicos completos con marcas combinantes", () => {
  const projectId = "unicode-event-boundaries";
  const decomposedName = "Ana" + String.fromCodePoint(0x0301);
  const events = [
    event(projectId, "alive", decomposedName + " está viva.", "chapter-1"),
    event(projectId, "dead", decomposedName + " murió.", "chapter-2")
  ];
  const contradictions = detectExplicitStateContradictions(
    projectId, events, [character("ana-decomposed", decomposedName)]
  );
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0].entityId, "ana-decomposed");
  assert.equal(contradictions[0].predicate, "life-state");
});
