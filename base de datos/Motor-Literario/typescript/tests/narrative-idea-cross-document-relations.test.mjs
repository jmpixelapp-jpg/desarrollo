import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeNarrativeIdeaCrossDocumentRelations,
  understandNarrativeFragment
} from "../dist/motor-literario.js";

function idea(id, documentId, text, start = 0, revision = 1) {
  const excerpt = "La idea expresada es " + text + ".";
  const evidenceStart = start + excerpt.indexOf(text);
  return {
    id,
    projectId: "book-1",
    documentId,
    revision,
    kind: "theme",
    text,
    confidence: "high",
    polarity: "affirmed",
    reviewStatus: "candidate",
    evidence: {
      start: evidenceStart,
      end: evidenceStart + text.length,
      excerpt
    }
  };
}

function analyze(ideaCandidates, orderedDocumentIds) {
  return analyzeNarrativeIdeaCrossDocumentRelations({
    projectId: "book-1",
    ideaCandidates,
    ...(orderedDocumentIds ? { orderedDocumentIds } : {})
  });
}

test("reconoce una recurrencia textual normalizada entre capítulos", () => {
  const result = analyze([
    idea("idea-a", "chapter-1", "la memoria de Ángela"),
    idea("idea-b", "chapter-2", "La memoria de Angela.")
  ]);

  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].relationType, "exact-recurrence");
  assert.equal(result.relations[0].normalizedSimilarity, 1);
  assert.equal(result.relations[0].reviewStatus, "candidate");
  assert.equal(result.relations[0].chronology, "unknown");
  assert.equal(result.relations[0].first.evidence.excerpt.includes("Ángela"), true);
  assert.equal(result.relations[0].second.evidence.excerpt.includes("Angela"), true);
});

test("detecta resonancia léxica explicable sin declarar equivalencia semántica", () => {
  const result = analyze([
    idea("idea-a", "chapter-1", "memoria perdida de la ciudad"),
    idea("idea-b", "chapter-2", "la ciudad recuerda la memoria antigua")
  ]);

  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].relationType, "lexical-resonance");
  assert.deepEqual(result.relations[0].sharedTerms, ["ciudad", "memoria"]);
  assert.ok(result.relations[0].normalizedSimilarity > 0);
  assert.equal(result.relations[0].reviewStatus, "candidate");
});

test("no crea una relación léxica cuando solo coincide un término", () => {
  const result = analyze([
    idea("idea-a", "chapter-1", "memoria del reino perdido"),
    idea("idea-b", "chapter-2", "memoria de una promesa olvidada")
  ]);

  assert.deepEqual(result.relations, []);
});

test("no relaciona ideas de diferentes revisiones del mismo documento como capítulos", () => {
  const result = analyze([
    idea("idea-a", "chapter-1", "memoria de la ciudad", 0, 1),
    idea("idea-b", "chapter-1", "memoria de la ciudad", 0, 2)
  ]);

  assert.deepEqual(result.relations, []);
  assert.equal(result.comparedCrossDocumentPairs, 0);
});

test("solo orienta la cronología cuando el proyecto entrega el orden de capítulos", () => {
  const result = analyze([
    idea("idea-a", "chapter-2", "la memoria de una ciudad"),
    idea("idea-b", "chapter-1", "la memoria de una ciudad")
  ], ["chapter-1", "chapter-2"]);

  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].chronology, "ordered");
  assert.equal(result.relations[0].earlierDocumentId, "chapter-1");
  assert.equal(result.relations[0].laterDocumentId, "chapter-2");
});

test("elimina términos demasiado frecuentes en el corpus del proyecto", () => {
  const result = analyze([
    idea("idea-a", "chapter-1", "ciudad memoria antigua"),
    idea("idea-b", "chapter-2", "ciudad memoria perdida"),
    idea("idea-c", "chapter-3", "ciudad memoria olvidada")
  ]);

  assert.deepEqual(result.relations, []);
});

test("es determinista aunque los candidatos lleguen en otro orden", () => {
  const candidates = [
    idea("idea-c", "chapter-3", "la memoria de la ciudad"),
    idea("idea-a", "chapter-1", "la memoria de la ciudad"),
    idea("idea-b", "chapter-2", "la ciudad recuerda la memoria")
  ];
  const first = analyze(candidates, ["chapter-1", "chapter-2", "chapter-3"]);
  const second = analyze([...candidates].reverse(), ["chapter-1", "chapter-2", "chapter-3"]);

  assert.deepEqual(second, first);
});

test("rechaza candidatos de otro proyecto, IDs duplicados y orden documental repetido", () => {
  assert.throws(() => analyze([
    idea("idea-a", "chapter-1", "la memoria"),
    { ...idea("idea-b", "chapter-2", "la memoria"), projectId: "other-book" }
  ]));
  assert.throws(() => analyze([
    idea("idea-a", "chapter-1", "la memoria"),
    idea("idea-a", "chapter-2", "la memoria")
  ]));
  assert.throws(() => analyze([
    idea("idea-a", "chapter-1", "la memoria")
  ], ["chapter-1", "chapter-1"]));
});

test("el pipeline integra candidatos previos de otros capítulos", () => {
  const previous = idea("prior-idea", "chapter-1", "la memoria de la ciudad");
  const result = understandNarrativeFragment({
    projectId: "book-1",
    documentId: "chapter-2",
    revision: 3,
    text: "La premisa narrativa es la memoria de la ciudad.",
    entities: [],
    priorIdeaCandidates: [previous],
    orderedDocumentIds: ["chapter-1", "chapter-2"]
  });

  assert.equal(result.ideas.length, 1);
  assert.ok(result.ideaCrossDocumentAnalysis.relations.some(relation =>
    relation.first.ideaCandidateId === "prior-idea" ||
    relation.second.ideaCandidateId === "prior-idea"
  ));
  assert.ok(result.ideaCrossDocumentAnalysis.relations.every(relation =>
    relation.reviewStatus === "candidate"
  ));
});


test("informa cuando el límite de relaciones recorta una salida grande", () => {
  const candidates = Array.from({ length: 200 }, (_, index) => {
    const documentId = index < 67 ? "chapter-a" : index < 134 ? "chapter-b" : "chapter-c";
    return idea("bulk-" + index, documentId, "memoria compartida", index * 30);
  });
  const result = analyze(candidates);

  assert.equal(result.analyzedCandidateCount, 200);
  assert.equal(result.truncated, true);
  assert.equal(result.relations.length, 10_000);
});


test("señala un cambio de modalidad entre apariciones sin llamarlo contradicción confirmada", () => {
  const first = idea("idea-affirmed", "chapter-1", "proteger la ciudad");
  const second = {
    ...idea("idea-negated", "chapter-2", "proteger la ciudad"),
    polarity: "negated"
  };
  const result = analyze([first, second]);

  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].relationType, "exact-recurrence");
  assert.equal(result.relations[0].polarityRelation, "changed");
  assert.equal(result.relations[0].first.polarity, "affirmed");
  assert.equal(result.relations[0].second.polarity, "negated");
  assert.equal(result.relations[0].reviewStatus, "candidate");
});


test("rechaza evidencia de un candidato cuya identidad documental no coincide", () => {
  const candidate = idea("wrong-provenance", "chapter-1", "la memoria de la ciudad");
  const invalid = {
    ...candidate,
    evidence: { ...candidate.evidence, documentId: "chapter-other" }
  };

  assert.throws(() => analyze([
    invalid,
    idea("valid-second", "chapter-2", "la memoria de la ciudad")
  ]));
});
