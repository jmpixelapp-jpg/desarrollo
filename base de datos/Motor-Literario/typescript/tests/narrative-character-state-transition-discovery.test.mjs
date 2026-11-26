import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverNarrativeCharacterStateCandidates
} from "../dist/motor-literario.js";
import {
  discoverNarrativeCharacterStateTransitions
} from "../dist/motor-literario.js";

const ana = {
  projectId: "book-1", id: "character:ana", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};

function states(text, documentId = "chapter-1", revision = 2) {
  return discoverNarrativeCharacterStateCandidates({
    projectId: "book-1", documentId, revision, text, entities: [ana]
  });
}

function transitions(candidates) {
  return discoverNarrativeCharacterStateTransitions({
    projectId: "book-1", candidates
  });
}

test("reconstruye cese y recurrencia solo a partir de afirmaciones explícitas", () => {
  const text = "Ana está herida. Ana ya no está herida. Ana volvió a estar herida.";
  const candidates = states(text);
  const result = transitions(candidates);
  assert.deepEqual(result.map(item => [item.transition, item.basis]), [
    ["ceased", "paired-assertions"],
    ["recurred", "explicit-aspect-marker"]
  ]);
  assert.equal(result[0].previousCandidateId, candidates[0].id);
  assert.equal(result[0].currentCandidateId, candidates[1].id);
  assert.equal(result[1].currentCandidateId, candidates[2].id);
  assert.equal(result[0].evidence.excerpt, candidates[1].evidence.excerpt);
  assert.equal(result[0].evidence.start, candidates[1].evidence.start);
  assert.equal(result[0].evidence.end - result[0].evidence.start, result[0].evidence.excerpt.length);
  assert.equal(result[0].reviewStatus, "candidate");
});

test("distingue reaparición de una condición previamente negada", () => {
  const candidates = states("Ana no está herida. Ana está herida.");
  const result = transitions(candidates);
  assert.equal(result.length, 1);
  assert.equal(result[0].transition, "reappeared");
  assert.equal(result[0].basis, "paired-assertions");
});

test("no enlaza menciones de documentos o revisiones diferentes", () => {
  const first = states("Ana está herida.", "chapter-1", 1);
  const second = states("Ana ya no está herida.", "chapter-2", 1);
  const third = states("Ana está herida.", "chapter-1", 2);
  assert.deepEqual(transitions([...first, ...second, ...third]), []);
});

test("no mezcla estados distintos ni personajes distintos", () => {
  const other = {
    ...ana, id: "character:bruno", canonicalName: "Bruno", normalizedName: "bruno"
  };
  const candidates = discoverNarrativeCharacterStateCandidates({
    projectId: "book-1", documentId: "chapter-1", revision: 2,
    text: "Ana está herida. Bruno está herido. Ana está enferma. Ana ya no está herida.",
    entities: [ana, other]
  });
  const result = transitions(candidates);
  assert.deepEqual(result.map(item => [item.entityId, item.state, item.transition]), [
    [ana.id, "injured", "ceased"]
  ]);
});

test("rechaza candidatos duplicados y evidencia incompatible con el documento", () => {
  const candidate = states("Ana está herida.")[0];
  assert.throws(() => transitions([candidate, candidate]));
  assert.throws(() => transitions([{
    ...candidate,
    evidence: { ...candidate.evidence, documentId: "other" }
  }]));
});

test("no mezcla una afirmación narratorial con una creencia al reconstruir el estado",()=>{
 const candidates=states("Ana está herida. Ana creyó que Ana no estaba herida.");
 const result=transitions(candidates);
 assert.equal(result.length,0);
});
test("reconstruye cambios dentro de la misma perspectiva y conserva su fuente",()=>{
 const candidates=states("Ana dijo que Ana estaba herida. Ana dijo que Ana ya no estaba herida.");
 const result=transitions(candidates);
 assert.equal(result.length,1);
 assert.equal(result[0].epistemicFrame,"reported-speech");
 assert.equal(result[0].epistemicSourceEntityId,ana.id);
 assert.equal(result[0].previousEpistemicEvidence.excerpt,"dijo que ");
 assert.equal(result[0].currentEpistemicEvidence.excerpt,"dijo que ");
});
