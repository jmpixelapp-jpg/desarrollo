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
  assert.deepEqual(result.resonances[0].sharedTerms, ["月光", "森林"]);
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

test("mantiene compatibilidad con catálogos antiguos que no transfieren el texto", () => {
  const result = analyze([idea("idea-legacy")]);

  assert.equal(result.inputIdeaCount, 1);
  assert.equal(result.analyzedIdeaCount, 0);
  assert.equal(result.ideasWithoutTextCount, 1);
  assert.equal(result.candidatePairCount, 0);
  assert.deepEqual(result.resonances, []);
});
