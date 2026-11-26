import test from "node:test";
import assert from "node:assert/strict";
import { understandNarrativeFragment } from "../dist/motor-literario.js";

const entities = [
  { projectId:"novel", id:"mara", kind:"character", canonicalName:"Mara", normalizedName:"mara", aliases:[], evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1 },
  { projectId:"novel", id:"elian", kind:"character", canonicalName:"Elian", normalizedName:"elian", aliases:[], evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1 }
];

test("coordina ideas, acciones, eventos, consecuencias y escenas con una procedencia común", () => {
  const text = "ESCENA 1\nMara protegió a Elian. Como consecuencia, Mara traicionó a Elian. El conflicto central es la pérdida de confianza.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-1", revision:3, text, entities
  });
  assert.equal(result.projectId, "novel");
  assert.equal(result.documentId, "chapter-1");
  assert.equal(result.revision, 3);
  assert.equal(result.actions.length, 2);
  assert.equal(result.events.length, 2);
  assert.equal(result.consequences.length, 1);
  assert.equal(result.ideas.length, 1);
  assert.equal(result.interactions.length, 2);
  assert.equal(result.interactionShifts.length, 1);
  assert.ok(result.sceneAssignments.actionCandidates.every(item => item.sceneAssignment === "explicit"));
  assert.ok(result.sceneAssignments.eventCandidates.every(item => item.sceneAssignment === "explicit"));
  assert.equal(result.sceneAssignments.ideaCandidates[0].sceneAssignment, "explicit");
  for (const candidate of [...result.ideas, ...result.actions, ...result.events]) {
    assert.equal(candidate.evidence.documentId, "chapter-1");
    assert.equal(candidate.evidence.revision, 3);
  }
});

test("propaga baseOffset sin alterar offsets absolutos de evidencia", () => {
  const text = "Mara ayudó a Elian.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-2", revision:4,
    text, entities, baseOffset:1200
  });
  assert.equal(result.analyzedRange.start, 1200);
  assert.equal(result.analyzedRange.end, 1200 + text.length);
  assert.equal(result.actions[0].evidence.start, 1200);
  assert.equal(result.sceneAssignments.actionCandidates[0].sceneAssignment, "unassigned");
});

test("rechaza entidades de otro proyecto antes de ejecutar extractores", () => {
  assert.throws(() => understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-1", revision:1,
    text:"Mara ayudó a Elian.",
    entities:[{ ...entities[0], projectId:"other" }]
  }));
});
