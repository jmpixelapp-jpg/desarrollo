import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeEllipticalSubjects } from "../dist/motor-literario.js";

const ana = {
  projectId: "book-1", id: "character:ana", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};
const bruno = { ...ana, id: "character:bruno", canonicalName: "Bruno", normalizedName: "bruno" };

function observation(id, start, end, subjectId, mentioned = []) {
  return {
    id, projectId: "book-1", documentId: "chapter-1", revision: 2,
    kind: "action", action: "caminar", surface: "salió",
    grammaticalTense: "past-preterite",
    ...(subjectId ? { grammaticalSubjectCandidate: {
      entityId: subjectId, voice: "active",
      evidence: { documentId: "chapter-1", revision: 2, start, end: start + 3, excerpt: "Ana" }
    } } : {}),
    mentionedCharacterIds: mentioned,
    mentionedEntityIds: [], entityMentionEvidence: [],
    polarity: "affirmed", confidence: "medium", reviewStatus: "candidate",
    actionEvidence: { documentId: "chapter-1", revision: 2, start: end - 5, end, excerpt: "salió" },
    evidence: { documentId: "chapter-1", revision: 2, start, end, excerpt: "Ana salió." }
  };
}
function discover(text, observations, entities = [ana], overrides = {}) {
  return discoverNarrativeEllipticalSubjects({
    projectId: "book-1", documentId: "chapter-1", revision: 2,
    text, observations, entities, ...overrides
  });
}

test("propone continuidad de sujeto omitido tras sujeto activo explícito", () => {
  const text = "Ana abrió la puerta. Después salió corriendo.";
  const first = observation("o1", 0, 20, ana.id, [ana.id]);
  const second = observation("o2", 21, text.length, undefined, []);
  const [candidate] = discover(text, [first, second]);
  assert.equal(candidate.candidateEntityId, ana.id);
  assert.equal(candidate.observationId, "o2");
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.basis, "adjacent-explicit-subject-without-intervening-character-mention");
});

test("no propaga sujetos desde una acción anterior que ya era hipotética", () => {
  const text = "Ana abrió la puerta. Después salió corriendo. Luego regresó.";
  const first = observation("o1", 0, 20, ana.id, [ana.id]);
  const second = observation("o2", 21, 45, undefined, []);
  const third = observation("o3", 46, text.length, undefined, []);
  const candidates = discover(text, [first, second, third]);
  assert.deepEqual(candidates.map(item => item.observationId), ["o2"]);
});

test("se abstiene cuando aparece otro personaje entre acciones", () => {
  const text = "Ana abrió la puerta. Bruno entró. Después salió.";
  const first = observation("o1", 0, 20, ana.id, [ana.id]);
  const second = observation("o2", 21, 33, bruno.id, [bruno.id]);
  const third = observation("o3", 34, text.length, undefined, []);
  assert.deepEqual(discover(text, [first, second, third], [ana, bruno]), []);
});

test("se abstiene ante saltos de párrafo", () => {
  const text = "Ana abrió la puerta.\n\nDespués salió.";
  const first = observation("o1", 0, 20, ana.id, [ana.id]);
  const second = observation("o2", 22, text.length, undefined, []);
  assert.deepEqual(discover(text, [first, second]), []);
});

test("respeta la distancia máxima y los offsets UTF-16 absolutos", () => {
  const prefix = "😀 ";
  const text = "Ana abrió la puerta.  Después salió.";
  const first = observation("o1", prefix.length, prefix.length + 20, ana.id, [ana.id]);
  const second = observation("o2", prefix.length + 22, prefix.length + text.length, undefined, []);
  assert.equal(discover(text, [first, second], [ana], { baseOffset: prefix.length }).length, 1);
  assert.deepEqual(discover(text, [first, second], [ana], { baseOffset: prefix.length, maxDistance: 1 }), []);
});

test("rechaza observaciones de otra revisión o fuera del documento", () => {
  const invalid = { ...observation("o1", 0, 10, ana.id, [ana.id]), revision: 3 };
  assert.throws(() => discover("Ana salió.", [invalid]), /mismo documento/);
});
