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
  const text = "Mara ayudó a Elian. Como consecuencia, Mara protegió a Elian.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-2", revision:4,
    text, entities, baseOffset:1200
  });
  assert.equal(result.analyzedRange.start, 1200);
  assert.equal(result.analyzedRange.end, 1200 + text.length);
  assert.equal(result.actions[0].evidence.start, 1200);
  assert.equal(result.consequences.length, 1);
  assert.equal(result.consequences[0].evidence.start, 1200 + text.indexOf("Como consecuencia"));
  assert.equal(result.sceneAssignments.actionCandidates[0].sceneAssignment, "unassigned");
});

test("rechaza entidades de otro proyecto antes de ejecutar extractores", () => {
  assert.throws(() => understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-1", revision:1,
    text:"Mara ayudó a Elian.",
    entities:[{ ...entities[0], projectId:"other" }]
  }));
});


test("integra resolución pronominal y atribuye acciones sin perder offsets absolutos", () => {
  const text = "Mara llegó. Ella protegió a Elian.";
  const nameStart = 0;
  const pronounStart = text.indexOf("Ella");
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-pronouns", revision:2,
    text, entities, baseOffset:800,
    characterMentions:[{
      characterId:"mara", documentId:"chapter-pronouns", revision:2,
      start:800 + nameStart, end:800 + 4,
      grammaticalNumber:"singular", grammaticalGender:"feminine"
    }],
    pronounReferences:[{
      id:"pronoun-ella", documentId:"chapter-pronouns", revision:2,
      start:800 + pronounStart, end:800 + pronounStart + 4,
      surface:"Ella", grammaticalNumber:"singular", grammaticalGender:"feminine"
    }]
  });
  assert.equal(result.pronounResolutions.length, 1);
  assert.equal(result.pronounResolutions[0].status, "resolved");
  assert.equal(result.pronounResolutions[0].characterId, "mara");
  assert.equal(result.pronounActions.length, 1);
  assert.equal(result.pronounActions[0].actorEntityId, "mara");
  assert.equal(result.pronounActions[0].action, "protegió");
  assert.equal(result.pronounActions[0].evidence.start, 800 + pronounStart);
  assert.equal(result.pronounActions[0].evidence.documentId, "chapter-pronouns");
});

test("rechaza referencias pronominales cuya superficie no coincide con el texto", () => {
  assert.throws(() => understandNarrativeFragment({
    projectId:"novel", documentId:"chapter-pronouns", revision:2,
    text:"Mara llegó. Ella protegió a Elian.",
    entities,
    pronounReferences:[{
      id:"wrong-surface", documentId:"chapter-pronouns", revision:2,
      start:13, end:17, surface:"Él",
      grammaticalNumber:"singular", grammaticalGender:"masculine"
    }]
  }));
});
