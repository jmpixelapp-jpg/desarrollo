import test from "node:test";
import assert from "node:assert/strict";
import { buildNarrativeObjectTrajectories } from "../dist/motor-literario.js";

const projectId = "book-1";
const objectEntityId = "object:sword";
const documentOrder = [
  { documentId: "chapter-1", chapterOrder: 1, chapterLabel: "Capítulo I" },
  { documentId: "chapter-2", chapterOrder: 2, chapterLabel: "Capítulo II" },
  { documentId: "chapter-3", chapterOrder: 3, chapterLabel: "Capítulo III" },
  { documentId: "chapter-4", chapterOrder: 4, chapterLabel: "Capítulo IV" }
];

function evidence(documentId, revision, start, excerpt) {
  return { documentId, revision, start, end: start + excerpt.length, excerpt };
}

function transition({
  id, documentId, revision = 1, start = 0, action = "encontrar",
  kind = "discovered", objectId = objectEntityId
}) {
  const actionEvidence = evidence(documentId, revision, start, action);
  const objectEvidence = evidence(documentId, revision, start + action.length + 1, "Espada Solar");
  const contextEvidence = evidence(documentId, revision, 0,
    action + " Espada Solar.");
  return {
    id, projectId, documentId, revision, observationId: "observation:" + id,
    objectEntityId: objectId, transition: kind,
    actorEntityId: "character:ana", polarity: "affirmed",
    grammaticalTense: "past-preterite", effectStatus: "candidate",
    actionEvidence, objectEvidence, contextEvidence,
    reviewStatus: "candidate"
  };
}

test("ordena transiciones por orden editorial explícito, no por orden de entrada", () => {
  const input = {
    projectId, documentOrder,
    transitions: [
      transition({ id: "later", documentId: "chapter-3", action: "perder", kind: "lost" }),
      transition({ id: "first", documentId: "chapter-1" }),
      transition({ id: "middle", documentId: "chapter-2", action: "recibir", kind: "received" })
    ]
  };
  const [trajectory] = buildNarrativeObjectTrajectories(input);
  assert.deepEqual(trajectory.entries.map(entry => entry.transition.id), ["first", "middle", "later"]);
  assert.deepEqual(trajectory.entries.map(entry => entry.chapterOrder), [1, 2, 3]);
  assert.equal(trajectory.evidenceCoverage, "candidate-transitions-only");
});

test("marca capítulos intermedios sin transición detectada sin afirmar ausencia del objeto", () => {
  const [trajectory] = buildNarrativeObjectTrajectories({
    projectId, documentOrder,
    transitions: [
      transition({ id: "first", documentId: "chapter-1" }),
      transition({ id: "last", documentId: "chapter-4", action: "perder", kind: "lost" })
    ]
  });
  assert.deepEqual(
    trajectory.entries[1].interveningDocumentsWithoutTransitionCandidate,
    ["chapter-2", "chapter-3"]
  );
});

test("ordena por offset cuando hay varias transiciones dentro del mismo capítulo", () => {
  const [trajectory] = buildNarrativeObjectTrajectories({
    projectId, documentOrder,
    transitions: [
      transition({ id: "second", documentId: "chapter-1", start: 40, action: "perder", kind: "lost" }),
      transition({ id: "first", documentId: "chapter-1", start: 2 })
    ]
  });
  assert.deepEqual(trajectory.entries.map(entry => entry.transition.id), ["first", "second"]);
});

test("separa trayectorias de objetos distintos", () => {
  const trajectories = buildNarrativeObjectTrajectories({
    projectId, documentOrder,
    transitions: [
      transition({ id: "sword", documentId: "chapter-1" }),
      transition({ id: "key", documentId: "chapter-2", objectId: "object:key" })
    ]
  });
  assert.equal(trajectories.length, 2);
  assert.deepEqual(trajectories.map(item => item.objectEntityId), ["object:key", objectEntityId].sort());
});

test("rechaza un documento sin orden editorial explícito", () => {
  assert.throws(() => buildNarrativeObjectTrajectories({
    projectId, documentOrder: documentOrder.slice(0, 2),
    transitions: [transition({ id: "missing", documentId: "chapter-4" })]
  }));
});

test("rechaza posiciones de capítulo duplicadas y evidencias inconsistentes", () => {
  assert.throws(() => buildNarrativeObjectTrajectories({
    projectId,
    documentOrder: [
      { documentId: "chapter-1", chapterOrder: 1 },
      { documentId: "chapter-2", chapterOrder: 1 }
    ],
    transitions: []
  }));
  const invalid = transition({ id: "bad", documentId: "chapter-1" });
  invalid.objectEvidence = { ...invalid.objectEvidence, end: invalid.objectEvidence.end + 1 };
  assert.throws(() => buildNarrativeObjectTrajectories({
    projectId, documentOrder, transitions: [invalid]
  }));
});

test("rechaza mezclar revisiones de un mismo capítulo", () => {
  assert.throws(() => buildNarrativeObjectTrajectories({
    projectId, documentOrder,
    transitions: [
      transition({ id: "revision-1", documentId: "chapter-1", revision: 1 }),
      transition({ id: "revision-2", documentId: "chapter-1", revision: 2, start: 30 })
    ]
  }));
});
