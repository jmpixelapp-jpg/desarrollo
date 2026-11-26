import test from "node:test";
import assert from "node:assert/strict";
import { resolveNarrativePronounReferences } from "../dist/motor-literario.js";

const doc = "chapter-1";
const revision = 3;
const text = "Mara habló con Elian. Ella salió.";

function mention(characterId, name, gender = "feminine", number = "singular", sourceText = text) {
  const start = sourceText.indexOf(name);
  return { characterId, documentId: doc, revision, start, end: start + name.length,
    grammaticalGender: gender, grammaticalNumber: number };
}
function reference(surface, gender = "feminine", number = "singular", sourceText = text) {
  const start = sourceText.lastIndexOf(surface);
  return { id: "ref-1", documentId: doc, revision, start, end: start + surface.length,
    surface, grammaticalGender: gender, grammaticalNumber: number };
}

test("resuelve cuando solo existe un antecedente compatible", () => {
  const result = resolveNarrativePronounReferences(text,
    [mention("mara", "Mara", "feminine"), mention("elian", "Elian", "masculine")],
    [reference("Ella")]);
  assert.equal(result[0].status, "resolved");
  assert.equal(result[0].characterId, "mara");
});

test("marca ambigüedad cuando hay varios antecedentes compatibles", () => {
  const sample = "Mara llegó. Lucía esperó. Ella sonrió.";
  const result = resolveNarrativePronounReferences(sample, [
    mention("mara", "Mara", "feminine", "singular", sample),
    mention("lucia", "Lucía", "feminine", "singular", sample)
  ], [reference("Ella", "feminine", "singular", sample)]);
  assert.equal(result[0].status, "ambiguous");
  assert.deepEqual(result[0].candidateCharacterIds, ["lucia", "mara"]);
  assert.equal(result[0].characterId, undefined);
});

test("no resuelve si no hay concordancia de número o género", () => {
  const result = resolveNarrativePronounReferences(text,
    [mention("mara", "Mara", "feminine")],
    [reference("Ella", "masculine")]);
  assert.equal(result[0].status, "unresolved");
});

test("no utiliza menciones de otros documentos o revisiones", () => {
  const item = mention("mara", "Mara");
  const result = resolveNarrativePronounReferences(text,
    [{ ...item, documentId: "another-doc" }, { ...item, revision: revision - 1 }],
    [reference("Ella")]);
  assert.equal(result[0].status, "unresolved");
});

test("respeta distancia máxima y opción de misma oración", () => {
  const sample = "Mara llegó. " + "palabra ".repeat(30) + "Ella esperó.";
  const person = mention("mara", "Mara", "feminine", "singular", sample);
  const pronoun = reference("Ella", "feminine", "singular", sample);
  assert.equal(resolveNarrativePronounReferences(sample, [person], [pronoun], { maxDistance: 10 })[0].status, "unresolved");
  assert.equal(resolveNarrativePronounReferences(sample, [person], [pronoun], { sameSentenceOnly: true })[0].status, "unresolved");
});

test("rechaza offsets inválidos, referencias duplicadas y opciones excesivas", () => {
  assert.throws(() => resolveNarrativePronounReferences(text,
    [{ ...mention("mara", "Mara"), end: text.length + 10 }], [reference("Ella")]));
  const ref = reference("Ella");
  assert.throws(() => resolveNarrativePronounReferences(text, [], [ref, ref]));
  assert.throws(() => resolveNarrativePronounReferences(text, [], [ref], { maxDistance: 999999 }));
});

test("permite rasgos desconocidos sin fingir que el nombre determina el género", () => {
  const result = resolveNarrativePronounReferences(text,
    [mention("mara", "Mara", "unknown")],
    [reference("Ella", "feminine")]);
  assert.equal(result[0].status, "resolved");
});
