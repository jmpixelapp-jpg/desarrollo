import test from "node:test";
import assert from "node:assert/strict";
import { detectExplicitStateContradictions, extractNarrativeEntities, extractNarrativeEvents, extractNarrativeRelations } from "../dist/motor-literario.js";

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
    "unicode-event-boundaries",
    "chapter",
    1,
    text,
    [character("ana", "Ana")]
  );

  assert.equal(events.length, 1);
  assert.deepEqual(events[0].participants, []);
});

test("un nombre que contiene una marca combinante sí coincide de forma completa", () => {
  const decomposedName = "Ana" + String.fromCodePoint(0x0301);
  const text = `ACONTECIMIENTO: ${decomposedName} desaparece.`;
  const events = extractNarrativeEvents(
    "unicode-event-boundaries",
    "chapter",
    1,
    text,
    [character("ana-decomposed", decomposedName)]
  );

  assert.equal(events.length, 1);
  assert.deepEqual(events[0].participants, ["ana-decomposed"]);
  assert.equal(
    text.slice(events[0].evidence[0].start, events[0].evidence[0].end),
    events[0].label
  );
});

function event(projectId, id, label, documentId) {
  return {
    projectId,
    id,
    label,
    participants: [],
    evidence: [{
      documentId,
      revision: 1,
      start: 0,
      end: label.length,
      excerpt: label
    }]
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
    projectId,
    events,
    [character("ana", "Ana")]
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
    projectId,
    events,
    [character("ana-decomposed", decomposedName)]
  );

  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0].entityId, "ana-decomposed");
  assert.equal(contradictions[0].predicate, "life-state");
});


test("el extractor de entidades conserva marcas combinantes dentro del nombre y de la evidencia", () => {
  const decomposedName = "Ana" + String.fromCodePoint(0x0301);
  const text = "Personaje " + decomposedName + " llega al puerto.";
  const entities = extractNarrativeEntities(
    "unicode-event-boundaries", "chapter-entities", 1, text, 100, 0
  );

  assert.equal(entities.length, 1);
  assert.equal(entities[0].canonicalName, decomposedName);
  assert.equal(
    text.slice(entities[0].evidence[0].start, entities[0].evidence[0].end),
    decomposedName
  );
});

test("el extractor de relaciones admite nombres descompuestos completos", () => {
  const decomposedName = "Ana" + String.fromCodePoint(0x0301);
  const entities = [
    character("ana-decomposed", decomposedName),
    character("bruno", "Bruno")
  ];
  const text = decomposedName + " ayudó a Bruno.";
  const relations = extractNarrativeRelations(
    "unicode-event-boundaries", "chapter-relations", 1, text, entities
  );

  assert.equal(relations.length, 1);
  assert.equal(relations[0].fromEntityId, "ana-decomposed");
  assert.equal(relations[0].toEntityId, "bruno");
});

test("el extractor de relaciones no acepta un nombre base como prefijo antes de una marca", () => {
  const combiningMark = String.fromCodePoint(0x0301);
  const entities = [
    character("ana", "Ana"),
    character("bruno", "Bruno")
  ];
  const text = "Ana" + combiningMark + " ayudó a Bruno.";
  const relations = extractNarrativeRelations(
    "unicode-event-boundaries", "chapter-relations-prefix", 1, text, entities
  );

  assert.deepEqual(relations, []);
});

test("extrae entidades cuando la etiqueta está capitalizada y el nombre termina el fragmento", () => {
  const trailing = extractNarrativeEntities(
    "unicode-event-boundaries", "chapter-final-name", 1, "Personaje Ana", 100, 0
  );
  assert.equal(trailing.length, 1);
  assert.equal(trailing[0].canonicalName, "Ana");
  assert.equal(
    "Personaje Ana".slice(trailing[0].evidence[0].start, trailing[0].evidence[0].end),
    "Ana"
  );
});

test("la etiqueta admite mayúscula inicial pero el nombre propio conserva requisito de mayúscula", () => {
  assert.equal(extractNarrativeEntities(
    "unicode-event-boundaries", "lowercase-name", 1, "Personaje ana", 100, 0
  ).length, 0);
  assert.equal(extractNarrativeEntities(
    "unicode-event-boundaries", "capitalized-name", 1, "personaje Ana", 100, 0
  ).length, 1);
});
