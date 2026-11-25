import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLiteraryFragment } from "../dist/motor-literario.js";

const projectId = "idea-lexical-resonance";

function idea(id, text) {
  return {
    projectId,
    ideaId: id,
    ...(text === undefined ? {} : { text }),
    status: "IDEA",
    relatedIdeaIds: [],
    evidenceCount: 0,
    staleEvidenceCount: 0,
    statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }],
    writerDecisionCount: 0,
    omittedStatusHistoryCount: 0
  };
}

function analyze(ideas) {
  return analyzeLiteraryFragment({
    projectId,
    documentId: "chapter-1",
    revision: 1,
    text: "Fragmento narrativo de prueba.",
    knownProjectIdeas: ideas
  }).ideaGraph.lexicalResonances;
}

test("detecta resonancias por términos literales compartidos sin alterar el grafo", () => {
  const ideas = [
    idea("idea-a", "La luz revela la memoria del espejo"),
    idea("idea-b", "El espejo conserva la memoria y la luz"),
    idea("idea-c", "La tormenta golpea las ventanas cerradas")
  ];
  const result = analyze(ideas);

  assert.equal(result.inputIdeaCount, 3);
  assert.equal(result.analyzedIdeaCount, 3);
  assert.equal(result.candidatePairCount, 1);
  assert.equal(result.resonances.length, 1);
  assert.equal(result.resonances[0].leftIdeaId, "idea-a");
  assert.equal(result.resonances[0].rightIdeaId, "idea-b");
  assert.equal(result.resonances[0].sharedTermCount, 3);
  assert.equal(result.resonances[0].jaccardSimilarity, 0.6);
  assert.equal(result.resonances[0].overlapCoefficient, 0.75);
  assert.deepEqual(result.resonances[0].sharedTerms, ["espejo", "luz", "memoria"]);
  assert.deepEqual(ideas.map(item => item.relatedIdeaIds), [[], [], []]);
});

test("excluye términos ubicuos para evitar coincidencias poco informativas", () => {
  const ideas = Array.from({ length: 41 }, (_, index) => idea(
    "idea-" + String(index).padStart(2, "0"),
    "secreto misterio concepto" + String(index).padStart(2, "0")
  ));
  const result = analyze(ideas);

  assert.equal(result.inputIdeaCount, 41);
  assert.equal(result.ignoredHighFrequencyTermCount, 2);
  assert.equal(result.candidatePairCount, 0);
  assert.deepEqual(result.resonances, []);
});

test("conserva términos de alfabetos Unicode sin distinción de mayúsculas", () => {
  const result = analyze([
    idea("idea-a", "月光 森林 静寂"),
    idea("idea-b", "月光 森林 海辺")
  ]);

  assert.equal(result.candidatePairCount, 1);
  assert.equal(result.resonances[0].sharedTerms.length, 2);
  assert.ok(result.resonances[0].sharedTerms.includes("月光"));
  assert.ok(result.resonances[0].sharedTerms.includes("森林"));
});

test("normaliza Unicode compuesto y conserva las marcas diacríticas", () => {
  const result = analyze([
    idea("idea-a", "CAFÉ memoria energía bosque"),
    idea("idea-b", "cafe\u0301 MEMORIA energi\u0301a BOSQUE")
  ]);

  assert.equal(result.candidatePairCount, 1);
  assert.equal(result.resonances[0].sharedTermCount, 4);
  assert.ok(result.resonances[0].sharedTerms.includes("café"));
  assert.ok(result.resonances[0].sharedTerms.includes("energía"));
});

test("limita la muestra de términos sin alterar las métricas completas", () => {
  const shared = [
    "alborada","bruma","ceniza","destello","enigma",
    "fragilidad","horizonte","instante","lumbre","memoria",
    "nostalgia","origen","penumbra","quietud","refugio"
  ].join(" ");
  const result = analyze([
    idea("idea-a", shared + " aurora"),
    idea("idea-b", shared + " travesía")
  ]);

  assert.equal(result.candidatePairCount, 1);
  assert.equal(result.resonances[0].sharedTermCount, 15);
  assert.equal(result.resonances[0].sharedTerms.length, 12);
  assert.equal(result.resonances[0].omittedSharedTermCount, 3);
  assert.equal(result.resonances[0].jaccardSimilarity, 0.882);
});

test("ordena los candidatos de forma determinista aunque cambie el orden de entrada", () => {
  const ideas = [
    idea("idea-c", "La memoria y la luz permanecen"),
    idea("idea-a", "La luz revela la memoria"),
    idea("idea-b", "La memoria guarda la luz"),
    idea("idea-d", "La memoria y la sombra regresan")
  ];

  assert.deepEqual(analyze(ideas), analyze([...ideas].reverse()));
});

test("limita la salida a los cien pares mejor clasificados y declara el excedente", () => {
  const ideas = Array.from({ length: 101 }, (_, index) => {
    const suffix = String(index).padStart(3, "0");
    return [
      idea("idea-a-" + suffix, "memoria" + suffix + " simbolo" + suffix + " origen" + suffix),
      idea("idea-b-" + suffix, "memoria" + suffix + " simbolo" + suffix + " destino" + suffix)
    ];
  }).flat();
  const result = analyze(ideas);

  assert.equal(result.candidatePairCount, 101);
  assert.equal(result.resonances.length, 100);
  assert.equal(result.omittedCandidatePairCount, 1);
  assert.equal(result.resonances[0].leftIdeaId, "idea-a-000");
  assert.equal(result.resonances[99].leftIdeaId, "idea-a-099");
});

test("respeta el presupuesto global de texto sin dividir una idea a medias", () => {
  const repeatedIdeaText = "memoria ".repeat(12_500);
  const ideas = Array.from({ length: 21 }, (_, index) => idea(
    "idea-" + String(index).padStart(2, "0"),
    repeatedIdeaText
  ));
  const result = analyze(ideas);

  assert.equal(result.inputIdeaCount, 21);
  assert.equal(result.analyzedIdeaCount, 20);
  assert.equal(result.omittedTextBudgetIdeaCount, 1);
  assert.equal(result.tokenizedTextUnitCount, 2_000_000);
  assert.equal(result.candidatePairCount, 0);
});

test("distingue textos omitidos por presupuesto de textos ausentes en adaptadores antiguos", () => {
  const result = analyze([{ ...idea("idea-budget"), textOmitted: "budget" }]);

  assert.equal(result.inputIdeaCount, 1);
  assert.equal(result.analyzedIdeaCount, 0);
  assert.equal(result.ideasWithoutTextCount, 0);
  assert.equal(result.omittedTextBudgetIdeaCount, 1);
});

test("mantiene compatibilidad con catálogos antiguos que no transfieren el texto", () => {
  const result = analyze([idea("idea-legacy")]);

  assert.equal(result.inputIdeaCount, 1);
  assert.equal(result.analyzedIdeaCount, 0);
  assert.equal(result.ideasWithoutTextCount, 1);
  assert.equal(result.candidatePairCount, 0);
  assert.deepEqual(result.resonances, []);
});
