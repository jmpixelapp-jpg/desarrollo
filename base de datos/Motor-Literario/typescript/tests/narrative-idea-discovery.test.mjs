import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeIdeaCandidates } from "../dist/motor-literario.js";

const context = {
  projectId: "book-1",
  documentId: "chapter-1",
  revision: 3
};

test("descubre tema, premisa y conflicto expresados en prosa natural", () => {
  const text = [
    "El tema central es la pérdida de la memoria.",
    "La premisa narrativa consiste en que nadie recuerda el pasado.",
    "El conflicto principal es la lucha entre verdad y silencio."
  ].join("\n");

  const found = discoverNarrativeIdeaCandidates({ ...context, text });
  assert.deepEqual(found.map(item => item.kind), ["theme", "premise", "conflict"]);
  assert.deepEqual(found.map(item => item.text), [
    "la pérdida de la memoria",
    "que nadie recuerda el pasado",
    "la lucha entre verdad y silencio"
  ]);
  assert.ok(found.every(item => item.reviewStatus === "candidate"));
  assert.ok(found.every(item => item.confidence === "high"));
});

test("detecta preguntas hipotéticas, hipótesis y motivos sin convertirlos en hechos", () => {
  const text = [
    "¿Qué pasaría si la ciudad olvidara su propio nombre?",
    "Tal vez el protagonista sea quien provocó el incendio.",
    "El símbolo recurrente es una puerta cerrada."
  ].join("\n");

  const found = discoverNarrativeIdeaCandidates({ ...context, text });
  assert.deepEqual(found.map(item => item.kind), ["question", "hypothesis", "motif"]);
  assert.equal(found[1].confidence, "medium");
  assert.ok(found.every(item => item.reviewStatus === "candidate"));
});

test("conserva offsets UTF-16 absolutos y el fragmento probatorio", () => {
  const prefix = "Prólogo.\n";
  const sentence = "El tema central es la memoria de Ángela.";
  const found = discoverNarrativeIdeaCandidates({
    ...context,
    text: sentence,
    baseOffset: prefix.length
  });

  assert.equal(found.length, 1);
  assert.equal(found[0].evidence.start, prefix.length + sentence.indexOf("la memoria"));
  assert.equal(found[0].evidence.end, prefix.length + sentence.indexOf("."));
  assert.equal(found[0].evidence.excerpt, sentence);
});

test("no inventa ideas a partir de prosa sin señales lingüísticas explícitas", () => {
  const found = discoverNarrativeIdeaCandidates({
    ...context,
    text: "La lluvia golpeaba los cristales. Ana cruzó el puente en silencio."
  });
  assert.deepEqual(found, []);
});

test("el resultado es determinista y no duplica una señal", () => {
  const input = {
    ...context,
    text: "La historia trata sobre la memoria. La historia trata sobre la memoria."
  };
  const first = discoverNarrativeIdeaCandidates(input);
  const second = discoverNarrativeIdeaCandidates(input);
  assert.deepEqual(second, first);
  assert.equal(first.length, 2);
  assert.notEqual(first[0].id, first[1].id);
});

test("rechaza contextos y offsets inválidos", () => {
  assert.throws(() => discoverNarrativeIdeaCandidates({
    ...context, projectId: " ", text: "El tema central es la memoria."
  }));
  assert.throws(() => discoverNarrativeIdeaCandidates({
    ...context, text: "El tema central es la memoria.", baseOffset: -1
  }));
});
