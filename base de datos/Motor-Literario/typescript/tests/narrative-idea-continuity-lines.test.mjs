import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeNarrativeIdeaCrossDocumentRelations,
  buildNarrativeIdeaContinuityLines,
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

function analysis(candidates, orderedDocumentIds) {
  return analyzeNarrativeIdeaCrossDocumentRelations({
    projectId: "book-1",
    ideaCandidates: candidates,
    ...(orderedDocumentIds ? { orderedDocumentIds } : {})
  });
}

function evolution(candidates, orderedDocumentIds) {
  return buildNarrativeIdeaEvolution({
    projectId: "book-1",
    crossDocumentAnalysis: analysis(candidates, orderedDocumentIds)
  });
}

function linesFromEvolution(evolutionResult) {
  return buildNarrativeIdeaContinuityLines({
    projectId: "book-1",
    evolution: evolutionResult
  });
}

test("reconstruye una línea de recurrencia exacta y conserva el orden único", () => {
  const result = linesFromEvolution(evolution([
    idea("later", "chapter-2", "la memoria de la ciudad"),
    idea("earlier", "chapter-1", "La memoria de la ciudad.")
  ], ["chapter-1", "chapter-2"]));

  assert.equal(result.summary.lineCount, 1);
  assert.equal(result.summary.occurrenceCount, 2);
  assert.equal(result.summary.exactOnlyLineCount, 1);
  assert.equal(result.lines[0].lineType, "exact-recurrence-line");
  assert.equal(result.lines[0].topology, "linear");
  assert.equal(result.lines[0].chronology, "complete");
  assert.deepEqual(result.lines[0].orderedOccurrenceIds, ["earlier", "later"]);
  assert.equal(result.lines[0].relations.length, 1);
});

test("agrupa una recurrencia triple como red, no como una cadena semántica confirmada", () => {
  const result = linesFromEvolution(evolution([
    idea("one", "chapter-1", "la memoria de la ciudad"),
    idea("two", "chapter-2", "la memoria de la ciudad"),
    idea("three", "chapter-3", "la memoria de la ciudad")
  ], ["chapter-1", "chapter-2", "chapter-3"]));

  assert.equal(result.summary.lineCount, 1);
  assert.equal(result.summary.relationCount, 3);
  assert.equal(result.lines[0].occurrences.length, 3);
  assert.equal(result.lines[0].topology, "network");
  assert.equal(result.lines[0].hasBranchingEvidence, true);
  assert.equal(result.lines[0].hasConvergingEvidence, true);
  assert.equal(result.lines[0].chronology, "complete");
});

test("reconoce evidencia estructural de bifurcación sin forzar un orden lineal", () => {
  const source = analysis([
    idea("root", "chapter-1", "la memoria de la ciudad"),
    idea("branch-a", "chapter-2", "la memoria de la ciudad"),
    idea("branch-b", "chapter-3", "la memoria de la ciudad")
  ], ["chapter-1", "chapter-2", "chapter-3"]);
  const selectedRelations = source.relations.filter(relation =>
    relation.first.ideaCandidateId === "root" ||
    relation.second.ideaCandidateId === "root"
  );
  const result = linesFromEvolution(buildNarrativeIdeaEvolution({
    projectId: "book-1",
    crossDocumentAnalysis: { ...source, relations: selectedRelations }
  }));

  assert.equal(result.lines[0].topology, "branching");
  assert.equal(result.lines[0].hasBranchingEvidence, true);
  assert.equal(result.lines[0].hasConvergingEvidence, false);
  assert.equal(result.lines[0].chronology, "partial");
  assert.equal("orderedOccurrenceIds" in result.lines[0], false);
});

test("reconoce evidencia estructural de convergencia sin afirmar fusión de ideas", () => {
  const source = analysis([
    idea("origin-a", "chapter-1", "la memoria de la ciudad"),
    idea("origin-b", "chapter-2", "la memoria de la ciudad"),
    idea("target", "chapter-3", "la memoria de la ciudad")
  ], ["chapter-1", "chapter-2", "chapter-3"]);
  const selectedRelations = source.relations.filter(relation =>
    relation.first.ideaCandidateId === "target" ||
    relation.second.ideaCandidateId === "target"
  );
  const result = linesFromEvolution(buildNarrativeIdeaEvolution({
    projectId: "book-1",
    crossDocumentAnalysis: { ...source, relations: selectedRelations }
  }));

  assert.equal(result.lines[0].topology, "converging");
  assert.equal(result.lines[0].hasConvergingEvidence, true);
  assert.equal(result.lines[0].hasBranchingEvidence, false);
  assert.equal(result.lines[0].chronology, "partial");
});

test("separa componentes sin relación entre sí", () => {
  const result = linesFromEvolution(evolution([
    idea("memory-a", "chapter-1", "memoria de la ciudad"),
    idea("memory-b", "chapter-2", "memoria de la ciudad"),
    idea("destiny-a", "chapter-3", "destino del reino"),
    idea("destiny-b", "chapter-4", "destino del reino")
  ], ["chapter-1", "chapter-2", "chapter-3", "chapter-4"]));

  assert.equal(result.summary.lineCount, 2);
  assert.equal(result.summary.occurrenceCount, 4);
  assert.equal(result.summary.relationCount, 2);
  assert.deepEqual(result.lines.map(line => line.occurrences.length), [2, 2]);
});

test("marca la cronología desconocida y conserva las apariciones sin ordenarlas", () => {
  const result = linesFromEvolution(evolution([
    idea("first", "chapter-1", "memoria de la ciudad"),
    idea("second", "chapter-2", "memoria de la ciudad")
  ]));

  assert.equal(result.lines[0].chronology, "unknown");
  assert.equal(result.lines[0].topology, "undirected");
  assert.equal("orderedOccurrenceIds" in result.lines[0], false);
  assert.equal(result.summary.chronologyUnknownCount, 1);
});

test("distingue cronología parcial cuando solo algunas relaciones tienen orden", () => {
  const source = analysis([
    idea("one", "chapter-1", "memoria de la ciudad"),
    idea("two", "chapter-2", "memoria de la ciudad"),
    idea("three", "chapter-3", "memoria de la ciudad")
  ], ["chapter-1", "chapter-2", "chapter-3"]);
  const evolutionResult = buildNarrativeIdeaEvolution({
    projectId: "book-1",
    crossDocumentAnalysis: {
      ...source,
      relations: source.relations.map((relation, index) => index === 0
        ? { ...relation, chronology: "unknown", earlierDocumentId: undefined, laterDocumentId: undefined }
        : relation)
    }
  });
  const result = linesFromEvolution(evolutionResult);

  assert.equal(result.lines[0].chronology, "partial");
  assert.equal(result.lines[0].topology, "undirected");
  assert.equal(result.summary.chronologyPartialCount, 1);
});

test("separa clústeres de resonancia léxica y no los llama recurrencia exacta", () => {
  const result = linesFromEvolution(evolution([
    idea("echo-a", "chapter-1", "memoria perdida de la ciudad"),
    idea("echo-b", "chapter-2", "la ciudad recuerda la memoria antigua")
  ], ["chapter-1", "chapter-2"]));

  assert.equal(result.summary.lexicalOnlyLineCount, 1);
  assert.equal(result.lines[0].lineType, "lexical-resonance-line");
  assert.equal(result.lines[0].exactRecurrenceCount, 0);
  assert.equal(result.lines[0].lexicalResonanceCount, 1);
});

test("distingue componentes mixtos cuando conviven recurrencias exactas y ecos léxicos", () => {
  const result = linesFromEvolution(evolution([
    idea("mixed-a", "chapter-1", "memoria antigua del reino"),
    idea("mixed-b", "chapter-2", "memoria antigua del reino"),
    idea("mixed-c", "chapter-3", "memoria antigua perdida"),
    idea("filler-d", "chapter-4", "destino lejano"),
    idea("filler-e", "chapter-5", "tormenta azul"),
    idea("filler-f", "chapter-6", "puerta secreta")
  ], ["chapter-1", "chapter-2", "chapter-3", "chapter-4", "chapter-5", "chapter-6"]));

  const mixed = result.lines.find(line => line.occurrences.some(item => item.ideaCandidateId === "mixed-a"));
  assert.ok(mixed);
  assert.equal(mixed.lineType, "mixed-signal-line");
  assert.ok(mixed.exactRecurrenceCount > 0);
  assert.ok(mixed.lexicalResonanceCount > 0);
});

test("propaga truncamiento de la adquisición de relaciones hasta las líneas", () => {
  const base = evolution([
    idea("one", "chapter-1", "memoria de la ciudad"),
    idea("two", "chapter-2", "memoria de la ciudad")
  ], ["chapter-1", "chapter-2"]);
  const result = linesFromEvolution({
    ...base,
    summary: { ...base.summary, sourceAnalysisTruncated: true }
  });

  assert.equal(result.summary.sourceAnalysisTruncated, true);
});

test("rechaza una aparición cuya procedencia cambia entre relaciones", () => {
  const base = evolution([
    idea("one", "chapter-1", "memoria de la ciudad"),
    idea("two", "chapter-2", "memoria de la ciudad"),
    idea("three", "chapter-3", "memoria de la ciudad")
  ], ["chapter-1", "chapter-2", "chapter-3"]);
  const events = base.events.map((event, index) => index === 0
    ? event
    : {
        ...event,
        firstOccurrence: {
          ...event.firstOccurrence,
          text: "destino del reino",
          evidence: {
            ...event.firstOccurrence.evidence,
            excerpt: "La idea expresada es destino del reino."
          }
        }
      });

  assert.throws(() => linesFromEvolution({
    ...base,
    events
  }));
});

test("rechaza relaciones y eventos duplicados en la misma colección", () => {
  const base = evolution([
    idea("one", "chapter-1", "memoria de la ciudad"),
    idea("two", "chapter-2", "memoria de la ciudad")
  ], ["chapter-1", "chapter-2"]);

  assert.throws(() => linesFromEvolution({
    ...base,
    summary: { ...base.summary, eventCount: 2 },
    events: [...base.events, ...base.events]
  }));
});

test("rechaza un evento cuyo extremo cronológico no conserva la evidencia del origen", () => {
  const base = evolution([
    idea("one", "chapter-1", "memoria de la ciudad"),
    idea("two", "chapter-2", "memoria de la ciudad")
  ], ["chapter-1", "chapter-2"]);
  const event = base.events[0];

  assert.throws(() => linesFromEvolution({
    ...base,
    events: [{
      ...event,
      earlierOccurrence: {
        ...event.earlierOccurrence,
        text: "otro contenido"
      }
    }]
  }));
});

test("integra las líneas de continuidad en la salida del pipeline", () => {
  const previous = idea("prior-idea", "chapter-1", "memoria antigua del reino");
  const result = understandNarrativeFragment({
    projectId: "book-1",
    documentId: "chapter-2",
    revision: 2,
    text: "La idea central es memoria antigua del reino.",
    entities: [],
    priorIdeaCandidates: [previous],
    orderedDocumentIds: ["chapter-1", "chapter-2"]
  });

  assert.equal(result.ideaContinuityLines.summary.lineCount, 1);
  assert.equal(result.ideaContinuityLines.lines[0].occurrences.length, 2);
  assert.equal(result.ideaContinuityLines.lines[0].chronology, "complete");
  assert.equal(result.ideaEvolution.summary.reappearedCount, 1);
});


test("rechaza un ciclo cronológico imposible en una colección de eventos manipulada", () => {
  const base = evolution([
    idea("cycle-a", "chapter-1", "memoria de la ciudad"),
    idea("cycle-b", "chapter-2", "memoria de la ciudad"),
    idea("cycle-c", "chapter-3", "memoria de la ciudad")
  ], ["chapter-1", "chapter-2", "chapter-3"]);
  const events = base.events.map(event => {
    const pair = new Set([
      event.firstOccurrence.ideaCandidateId,
      event.secondOccurrence.ideaCandidateId
    ]);
    if (pair.has("cycle-a") && pair.has("cycle-c")) {
      return {
        ...event,
        earlierOccurrence: event.laterOccurrence,
        laterOccurrence: event.earlierOccurrence
      };
    }
    return event;
  });

  assert.throws(() => linesFromEvolution({ ...base, events }), /ciclo imposible/);
});
