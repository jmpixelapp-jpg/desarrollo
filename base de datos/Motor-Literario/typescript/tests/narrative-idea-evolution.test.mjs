import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeNarrativeIdeaCrossDocumentRelations,
  buildNarrativeIdeaEvolution,
  understandNarrativeFragment
} from "../dist/motor-literario.js";

function idea(id, documentId, text, options = {}) {
  const excerpt = "La idea expresada es " + text + ".";
  const start = 10 + excerpt.indexOf(text);
  return {
    id,
    projectId: "book-1",
    documentId,
    revision: options.revision ?? 1,
    kind: options.kind ?? "theme",
    text,
    confidence: options.confidence ?? "high",
    polarity: options.polarity ?? "affirmed",
    reviewStatus: "candidate",
    evidence: {
      start,
      end: start + text.length,
      excerpt
    }
  };
}

function sourceAnalysis(candidates, orderedDocumentIds) {
  return analyzeNarrativeIdeaCrossDocumentRelations({
    projectId: "book-1",
    ideaCandidates: candidates,
    ...(orderedDocumentIds ? { orderedDocumentIds } : {})
  });
}

function evolve(candidates, orderedDocumentIds) {
  return buildNarrativeIdeaEvolution({
    projectId: "book-1",
    crossDocumentAnalysis: sourceAnalysis(candidates, orderedDocumentIds)
  });
}

test("reconstruye una reaparición exacta y orienta sus apariciones con cronología explícita", () => {
  const result = evolve([
    idea("later", "chapter-2", "la memoria de la ciudad"),
    idea("earlier", "chapter-1", "La memoria de la ciudad.")
  ], ["chapter-1", "chapter-2"]);

  assert.equal(result.summary.relationCount, 1);
  assert.equal(result.summary.reappearedCount, 1);
  assert.equal(result.events[0].eventKind, "reappeared");
  assert.equal(result.events[0].chronology, "ordered");
  assert.equal(result.events[0].earlierOccurrence.ideaCandidateId, "earlier");
  assert.equal(result.events[0].laterOccurrence.ideaCandidateId, "later");
  assert.deepEqual(result.events[0].signals, ["exact-wording-recurrence"]);
  assert.equal(result.events[0].reviewStatus, "candidate");
});

test("registra una resonancia léxica como eco, no como identidad confirmada", () => {
  const result = evolve([
    idea("first", "chapter-1", "memoria perdida de la ciudad"),
    idea("second", "chapter-2", "la ciudad recuerda la memoria antigua")
  ], ["chapter-1", "chapter-2"]);

  assert.equal(result.summary.echoedCount, 1);
  assert.equal(result.events[0].eventKind, "echoed");
  assert.deepEqual(result.events[0].signals, ["lexical-resonance"]);
  assert.deepEqual(result.events[0].supportingRelation.sharedTerms, ["ciudad", "memoria"]);
});

test("no inventa una dirección temporal cuando falta el orden documental", () => {
  const result = evolve([
    idea("one", "chapter-1", "la memoria de la ciudad"),
    idea("two", "chapter-2", "la memoria de la ciudad")
  ]);

  assert.equal(result.summary.withoutOrderCount, 1);
  assert.equal(result.events[0].eventKind, "observed-without-order");
  assert.equal(result.events[0].chronology, "unknown");
  assert.equal("earlierOccurrence" in result.events[0], false);
  assert.equal("laterOccurrence" in result.events[0], false);
});

test("conserva el cambio de modalidad como señal y no como contradicción objetiva", () => {
  const result = evolve([
    idea("before", "chapter-1", "proteger la ciudad", { polarity: "affirmed" }),
    idea("after", "chapter-2", "proteger la ciudad", { polarity: "negated" })
  ], ["chapter-1", "chapter-2"]);

  assert.equal(result.summary.modalityChangeCount, 1);
  assert.deepEqual(result.events[0].signals, [
    "exact-wording-recurrence",
    "modality-change"
  ]);
  assert.equal(result.events[0].earlierOccurrence.polarity, "affirmed");
  assert.equal(result.events[0].laterOccurrence.polarity, "negated");
});

test("señala un cambio de clase expresiva sin fusionar las categorías", () => {
  const result = evolve([
    idea("before", "chapter-1", "la ciudad recuerda la memoria", { kind: "theme" }),
    idea("after", "chapter-2", "la ciudad recuerda la memoria", { kind: "hypothesis" })
  ], ["chapter-1", "chapter-2"]);

  assert.equal(result.summary.ideaKindChangeCount, 1);
  assert.ok(result.events[0].signals.includes("idea-kind-change"));
  assert.equal(result.events[0].earlierOccurrence.kind, "theme");
  assert.equal(result.events[0].laterOccurrence.kind, "hypothesis");
});

test("propaga truncamiento del análisis de origen en el resumen de evolución", () => {
  const analysis = sourceAnalysis([
    idea("one", "chapter-1", "la memoria de la ciudad"),
    idea("two", "chapter-2", "la memoria de la ciudad")
  ], ["chapter-1", "chapter-2"]);
  const result = buildNarrativeIdeaEvolution({
    projectId: "book-1",
    crossDocumentAnalysis: { ...analysis, truncated: true }
  });

  assert.equal(result.summary.sourceAnalysisTruncated, true);
});

test("el resumen cuenta señales independientemente por evento y el orden es estable", () => {
  const candidates = [
    idea("a", "chapter-1", "la memoria de la ciudad"),
    idea("b", "chapter-2", "la memoria de la ciudad", { polarity: "conditional" }),
    idea("c", "chapter-3", "la memoria de la ciudad")
  ];
  const first = evolve(candidates, ["chapter-1", "chapter-2", "chapter-3"]);
  const second = evolve([...candidates].reverse(), ["chapter-1", "chapter-2", "chapter-3"]);

  assert.deepEqual(second, first);
  assert.equal(first.summary.relationCount, 3);
  assert.equal(first.summary.reappearedCount, 3);
  assert.equal(first.summary.modalityChangeCount, 2);
  assert.equal(first.summary.eventCount, 3);
});

test("rechaza proyectos cruzados y relaciones duplicadas", () => {
  const analysis = sourceAnalysis([
    idea("one", "chapter-1", "la memoria de la ciudad"),
    idea("two", "chapter-2", "la memoria de la ciudad")
  ], ["chapter-1", "chapter-2"]);

  assert.throws(() => buildNarrativeIdeaEvolution({
    projectId: "other-book",
    crossDocumentAnalysis: analysis
  }));
  assert.throws(() => buildNarrativeIdeaEvolution({
    projectId: "book-1",
    crossDocumentAnalysis: {
      ...analysis,
      relations: [...analysis.relations, ...analysis.relations]
    }
  }));
});

test("rechaza una relación ordenada con referencias documentales incoherentes", () => {
  const analysis = sourceAnalysis([
    idea("one", "chapter-1", "la memoria de la ciudad"),
    idea("two", "chapter-2", "la memoria de la ciudad")
  ], ["chapter-1", "chapter-2"]);
  const relation = analysis.relations[0];

  assert.throws(() => buildNarrativeIdeaEvolution({
    projectId: "book-1",
    crossDocumentAnalysis: {
      ...analysis,
      relations: [{ ...relation, earlierDocumentId: "chapter-3" }]
    }
  }));
});

test("integra evolución transversal en el pipeline sin modificar candidatos previos", () => {
  const previous = idea("prior-idea", "chapter-1", "la memoria de la ciudad");
  const result = understandNarrativeFragment({
    projectId: "book-1",
    documentId: "chapter-2",
    revision: 4,
    text: "La premisa narrativa es la memoria de la ciudad.",
    entities: [],
    priorIdeaCandidates: [previous],
    orderedDocumentIds: ["chapter-1", "chapter-2"]
  });

  assert.equal(result.ideaEvolution.summary.reappearedCount, 1);
  assert.equal(result.ideaEvolution.events[0].earlierOccurrence.ideaCandidateId, "prior-idea");
  assert.equal(result.ideaEvolution.events[0].laterOccurrence.ideaCandidateId, result.ideas[0].id);
  assert.equal(previous.documentId, "chapter-1");
  assert.equal(previous.revision, 1);
});


test("rechaza una recurrencia declarada exacta cuando los textos normalizados difieren", () => {
  const analysis = sourceAnalysis([
    idea("one", "chapter-1", "la memoria de la ciudad"),
    idea("two", "chapter-2", "la memoria de la ciudad")
  ], ["chapter-1", "chapter-2"]);
  const relation = analysis.relations[0];
  const changedText = "el destino de la ciudad";
  const changedExcerpt = "La idea expresada es " + changedText + ".";
  const changedStart = 10 + changedExcerpt.indexOf(changedText);

  assert.throws(() => buildNarrativeIdeaEvolution({
    projectId: "book-1",
    crossDocumentAnalysis: {
      ...analysis,
      relations: [{
        ...relation,
        second: {
          ...relation.second,
          text: changedText,
          evidence: {
            ...relation.second.evidence,
            start: changedStart,
            end: changedStart + changedText.length,
            excerpt: changedExcerpt
          }
        }
      }]
    }
  }));
});

test("rechaza la modalidad declarada cuando no coincide con las dos apariciones", () => {
  const analysis = sourceAnalysis([
    idea("one", "chapter-1", "la memoria de la ciudad", { polarity: "affirmed" }),
    idea("two", "chapter-2", "la memoria de la ciudad", { polarity: "negated" })
  ], ["chapter-1", "chapter-2"]);

  assert.throws(() => buildNarrativeIdeaEvolution({
    projectId: "book-1",
    crossDocumentAnalysis: {
      ...analysis,
      relations: [{
        ...analysis.relations[0],
        polarityRelation: "consistent"
      }]
    }
  }));
});


test("conserva evidencia original con espacios repetidos al reconstruir una recurrencia", () => {
  const firstText = "la memoria de la ciudad";
  const secondText = "la memoria de la ciudad";
  const firstExcerpt = "La idea expresada es la memoria   de la ciudad.";
  const secondExcerpt = "La idea expresada es la memoria de   la ciudad.";
  const firstStart = 10 + firstExcerpt.indexOf("la memoria");
  const secondStart = 10 + secondExcerpt.indexOf("la memoria");
  const result = evolve([
    {
      ...idea("space-first", "chapter-1", firstText),
      evidence: {
        documentId: "chapter-1",
        revision: 1,
        start: firstStart,
        end: firstStart + "la memoria   de la ciudad".length,
        excerpt: firstExcerpt
      }
    },
    {
      ...idea("space-second", "chapter-2", secondText),
      evidence: {
        documentId: "chapter-2",
        revision: 1,
        start: secondStart,
        end: secondStart + "la memoria de   la ciudad".length,
        excerpt: secondExcerpt
      }
    }
  ], ["chapter-1", "chapter-2"]);

  assert.equal(result.summary.reappearedCount, 1);
  assert.equal(result.events[0].earlierOccurrence.evidence.excerpt, firstExcerpt);
  assert.equal(result.events[0].laterOccurrence.evidence.excerpt, secondExcerpt);
});
