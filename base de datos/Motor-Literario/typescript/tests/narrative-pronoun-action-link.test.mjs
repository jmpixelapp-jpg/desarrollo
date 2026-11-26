import test from "node:test";
import assert from "node:assert/strict";
import { resolveNarrativePronounReferences, extractNarrativePronounActionCandidates } from "../dist/motor-literario.js";

const context = { documentId: "chapter-8", revision: 2 };
function makeMention(text, characterId, name, gender = "feminine") {
  const start = text.indexOf(name);
  return { characterId, ...context, start, end: start + name.length,
    grammaticalNumber: "singular", grammaticalGender: gender };
}
function makeReference(text, surface, gender = "feminine") {
  const start = text.lastIndexOf(surface);
  return { id: "pronoun-1", ...context, start, end: start + surface.length,
    surface, grammaticalNumber: "singular", grammaticalGender: gender };
}

test("vincula pronombre resuelto con acción explícita y conserva negación", () => {
  const text = "Mara entró. Ella no protegió a Elian.";
  const mention = makeMention(text, "character:mara", "Mara");
  const reference = makeReference(text, "Ella");
  const [resolution] = resolveNarrativePronounReferences(text, [mention], [reference]);
  const [action] = extractNarrativePronounActionCandidates(text, [reference], [resolution]);
  assert.equal(action.actorEntityId, "character:mara");
  assert.equal(action.action, "protegió");
  assert.equal(action.polarity, "negated");
  assert.equal(action.status, "candidate");
  assert.equal(action.evidence.excerpt, "Mara entró. Ella no protegió a Elian.");
});

test("conserva varios posibles actores sin elegir uno", () => {
  const text = "Mara llegó. Lucía esperó. Ella atacó.";
  const reference = makeReference(text, "Ella");
  const mentions = [
    makeMention(text, "character:mara", "Mara"),
    makeMention(text, "character:lucia", "Lucía")
  ];
  const [resolution] = resolveNarrativePronounReferences(text, mentions, [reference]);
  const [action] = extractNarrativePronounActionCandidates(text, [reference], [resolution]);
  assert.equal(action.status, "ambiguous");
  assert.equal(action.actorEntityId, undefined);
  assert.deepEqual(action.candidateActorEntityIds, ["character:lucia", "character:mara"]);
});

test("no convierte una referencia sin resolver en acción atribuida", () => {
  const text = "Ella rescató a Elian.";
  const reference = makeReference(text, "Ella");
  const resolution = { referenceId: reference.id, status: "unresolved",
    candidateCharacterIds: [], antecedentEvidence: [], reason: "no-compatible-antecedent" };
  assert.deepEqual(extractNarrativePronounActionCandidates(text, [reference], [resolution]), []);
});

test("no atribuye una acción cuando el verbo no sigue inmediatamente al pronombre", () => {
  const text = "Mara llegó. Ella, después de esperar, atacó.";
  const reference = makeReference(text, "Ella");
  const resolution = { referenceId: reference.id, status: "resolved",
    characterId: "character:mara", candidateCharacterIds: ["character:mara"],
    antecedentEvidence: [{ ...context, start: 0, end: 4 }],
    reason: "unique-compatible-antecedent" };
  assert.deepEqual(extractNarrativePronounActionCandidates(text, [reference], [resolution]), []);
});

test("rechaza referencias duplicadas y resoluciones únicas incoherentes", () => {
  const text = "Mara llegó. Ella atacó.";
  const reference = makeReference(text, "Ella");
  assert.throws(() => extractNarrativePronounActionCandidates(text, [reference, reference], []));
  assert.throws(() => extractNarrativePronounActionCandidates(text, [reference], [{
    referenceId: reference.id, status: "resolved", characterId: "mara",
    candidateCharacterIds: ["other"], antecedentEvidence: [],
    reason: "unique-compatible-antecedent"
  }]));
});
