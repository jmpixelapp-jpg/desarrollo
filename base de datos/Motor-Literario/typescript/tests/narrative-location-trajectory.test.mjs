import test from "node:test";
import assert from "node:assert/strict";
import { buildNarrativeLocationTrajectories } from "../dist/motor-literario.js";

function movement({
  documentId, text, action, surface, location, transition,
  polarity = "affirmed", tense = "past-preterite",
  effectStatus = "candidate", baseOffset = 0
}) {
  const actionStart = text.indexOf(surface);
  const locationStart = text.indexOf(location);
  const evidence = (start, end, excerpt) => ({
    documentId, revision: 2,
    start: baseOffset + start, end: baseOffset + end, excerpt
  });
  return {
    id: "move:" + documentId + ":" + actionStart,
    projectId: "book-1", documentId, revision: 2,
    observationId: "obs:" + documentId,
    locationEntityId: "location:" + location.toLowerCase().replace(/\s+/gu, "-"),
    transition,
    actorEntityId: "character:ana",
    polarity, grammaticalTense: tense, effectStatus,
    actionEvidence: evidence(actionStart, actionStart + surface.length, surface),
    locationEvidence: evidence(locationStart, locationStart + location.length, location),
    actorEvidence: evidence(0, 3, "Ana"),
    relationEvidence: evidence(
      actionStart + surface.length, locationStart,
      text.slice(actionStart + surface.length, locationStart)
    ),
    contextEvidence: evidence(0, text.length, text),
    reviewStatus: "candidate"
  };
}

test("ordena movimientos por actor usando solo el orden editorial explícito", () => {
  const departure = movement({
    documentId: "chapter-1", text: "Ana salió de la ciudad.",
    action: "salir", surface: "salió", location: "ciudad", transition: "departed",
    baseOffset: 100
  });
  const arrival = movement({
    documentId: "chapter-3", text: "Ana llegó al puerto.",
    action: "llegar", surface: "llegó", location: "puerto", transition: "arrived",
    baseOffset: 500
  });
  const [trajectory] = buildNarrativeLocationTrajectories({
    projectId: "book-1",
    documentOrder: [
      { documentId: "chapter-1", chapterOrder: 1, chapterLabel: "Salida" },
      { documentId: "chapter-2", chapterOrder: 2, chapterLabel: "Intervalo" },
      { documentId: "chapter-3", chapterOrder: 3, chapterLabel: "Llegada" }
    ],
    transitions: [arrival, departure]
  });
  assert.equal(trajectory.actorEntityId, "character:ana");
  assert.deepEqual(trajectory.entries.map(entry => entry.transition.id), [
    departure.id, arrival.id
  ]);
  assert.deepEqual(
    trajectory.entries[1].interveningDocumentsWithoutTransitionCandidate,
    ["chapter-2"]
  );
  assert.equal(trajectory.movementSequences.length, 1);
  assert.equal(trajectory.movementSequences[0].fromLocationEntityId, "location:ciudad");
  assert.equal(trajectory.movementSequences[0].toLocationEntityId, "location:puerto");
  assert.equal(trajectory.movementSequences[0].status, "sequence-candidate");
  assert.equal(trajectory.evidenceCoverage, "candidate-movements-only");
});

test("no crea secuencia de viaje con salida negada, llegada futura o actor distinto", () => {
  const departure = movement({
    documentId: "chapter-1", text: "Ana no salió de la ciudad.",
    action: "salir", surface: "salió", location: "ciudad", transition: "departed",
    polarity: "negated", effectStatus: "not-applied"
  });
  const arrival = movement({
    documentId: "chapter-2", text: "Ana llegará al puerto.",
    action: "llegar", surface: "llegará", location: "puerto", transition: "arrived",
    tense: "future", effectStatus: "prospective"
  });
  const [trajectory] = buildNarrativeLocationTrajectories({
    projectId: "book-1",
    documentOrder: [
      { documentId: "chapter-1", chapterOrder: 0 },
      { documentId: "chapter-2", chapterOrder: 1 }
    ],
    transitions: [departure, arrival]
  });
  assert.deepEqual(trajectory.movementSequences, []);
});

test("rechaza evidencia fuera del contexto y órdenes editoriales duplicados", () => {
  const item = movement({
    documentId: "chapter-1", text: "Ana llegó al puerto.",
    action: "llegar", surface: "llegó", location: "puerto", transition: "arrived"
  });
  assert.throws(() => buildNarrativeLocationTrajectories({
    projectId: "book-1",
    documentOrder: [{ documentId: "chapter-1", chapterOrder: 0 }],
    transitions: [{
      ...item,
      locationEvidence: { ...item.locationEvidence, excerpt: "bahía" }
    }]
  }));
  assert.throws(() => buildNarrativeLocationTrajectories({
    projectId: "book-1",
    documentOrder: [
      { documentId: "chapter-1", chapterOrder: 0 },
      { documentId: "chapter-2", chapterOrder: 0 }
    ],
    transitions: [item]
  }));
});
