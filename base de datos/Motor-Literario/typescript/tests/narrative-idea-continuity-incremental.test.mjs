import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeNarrativeIdeaCrossDocumentRelations,
  buildNarrativeIdeaContinuityLines,
  buildNarrativeIdeaEvolution,
  updateNarrativeIdeaContinuityLinesIncrementally
} from "../dist/motor-literario.js";

function idea(id, documentId, text, options = {}) {
  const excerpt = "La idea expresada es " + text + ".";
  const start = 10 + excerpt.indexOf(text);
  return {
    id,
    projectId: "book-incremental",
    documentId,
    revision: options.revision ?? 1,
    kind: options.kind ?? "theme",
    text,
    confidence: "high",
    polarity: options.polarity ?? "affirmed",
    reviewStatus: "candidate",
    evidence: { start, end: start + text.length, excerpt }
  };
}

function evolution(candidates, orderedDocumentIds, truncated = false) {
  const relations = analyzeNarrativeIdeaCrossDocumentRelations({
    projectId: "book-incremental",
    ideaCandidates: candidates,
    orderedDocumentIds
  });
  const result = buildNarrativeIdeaEvolution({
    projectId: "book-incremental",
    crossDocumentAnalysis: relations
  });
  return truncated
    ? { ...result, summary: { ...result.summary, sourceAnalysisTruncated: true } }
    : result;
}

function snapshot(candidates, orderedDocumentIds) {
  return buildNarrativeIdeaContinuityLines({
    projectId: "book-incremental",
    evolution: evolution(candidates, orderedDocumentIds)
  });
}

function update(previous, candidates, orderedDocumentIds, changedDocumentIds, truncated = false) {
  return updateNarrativeIdeaContinuityLinesIncrementally({
    projectId: "book-incremental",
    previous,
    nextEvolution: evolution(candidates, orderedDocumentIds, truncated),
    changedDocumentIds
  });
}

const orderedThree = ["chapter-1", "chapter-2", "chapter-3", "chapter-4", "chapter-5"];

test("reconstruye solo el componente afectado y reutiliza líneas ajenas", () => {
  const previousCandidates = [
    idea("a", "chapter-1", "memoria antigua del reino"),
    idea("b", "chapter-2", "memoria antigua del reino"),
    idea("c", "chapter-3", "destino oscuro del reino"),
    idea("d", "chapter-4", "destino oscuro del reino")
  ];
  const previous = snapshot(previousCandidates, orderedThree);
  const next = update(previous, previousCandidates, orderedThree, ["chapter-1"]);

  assert.equal(next.result.summary.lineCount, 2);
  assert.equal(next.rebuiltLineCount, 1);
  assert.equal(next.reusedLineIds.length, 1);
  assert.equal(next.changedLineIds.length, 1);
  assert.deepEqual(next.removedLineIds, []);
  assert.equal(next.scannedEventCount, previous.summary.relationCount * 2);
});

test("reconstruye un subgrafo al desaparecer una aparición y permite dividir el componente", () => {
  const previousCandidates = [
    idea("a", "chapter-1", "memoria de la ciudad"),
    idea("b", "chapter-2", "memoria de la ciudad"),
    idea("c", "chapter-3", "memoria de la ciudad")
  ];
  const previous = snapshot(previousCandidates, orderedThree);
  const nextCandidates = previousCandidates.filter(item => item.id !== "c");
  const next = update(previous, nextCandidates, ["chapter-1", "chapter-2"], ["chapter-3"]);

  assert.equal(next.result.summary.lineCount, 1);
  assert.equal(next.result.summary.occurrenceCount, 2);
  assert.equal(next.result.summary.relationCount, 1);
  assert.deepEqual(next.result.lines[0].occurrences.map(item => item.ideaCandidateId), ["a", "b"]);
  assert.equal(next.removedLineIds.length, 1);
  assert.equal(next.rebuiltLineCount, 1);
});

test("un vínculo nuevo puede unir dos componentes anteriores sin reconstruir los demás", () => {
  const previousCandidates = [
    idea("a", "chapter-1", "memoria antigua del reino"),
    idea("b", "chapter-2", "memoria antigua del reino"),
    idea("c", "chapter-3", "memoria antigua perdida"),
    idea("d", "chapter-4", "tormenta sobre el reino")
  ];
  const previous = snapshot(previousCandidates, orderedThree);
  // El nuevo texto conecta los dos subgrupos mediante términos discriminantes.
  const nextCandidates = [
    ...previousCandidates,
    idea("e", "chapter-5", "memoria antigua del reino perdida durante la tormenta")
  ];
  const next = update(previous, nextCandidates, orderedThree, ["chapter-5"]);

  assert.ok(next.result.summary.lineCount <= previous.summary.lineCount);
  assert.ok(next.changedLineIds.length > 0);
  assert.equal(next.result.summary.relationCount,
    next.result.lines.reduce((sum, line) => sum + line.relations.length, 0));
});

test("detecta cambios de contenido/modo aunque el identificador del evento se conserve", () => {
  const initial = [
    idea("a", "chapter-1", "memoria antigua del reino"),
    idea("b", "chapter-2", "memoria antigua del reino")
  ];
  const previous = snapshot(initial, orderedThree);
  const changed = [
    initial[0]!,
    idea("b", "chapter-2", "memoria antigua del reino", { polarity: "negated", revision: 2 })
  ];
  const next = update(previous, changed, orderedThree, ["chapter-2"]);

  assert.equal(next.result.summary.lineCount, 1);
  assert.equal(next.rebuiltLineCount, 1);
  assert.ok(next.changedLineIds.length > 0);
  assert.ok(next.result.lines[0].relations.some(event =>
    event.signals.includes("modality-change")));
});

test("mantiene los componentes al día y propaga el nuevo estado de truncamiento", () => {
  const candidates = [
    idea("a", "chapter-1", "memoria antigua del reino"),
    idea("b", "chapter-2", "memoria antigua del reino")
  ];
  const previous = snapshot(candidates, orderedThree);
  const next = update(previous, candidates, orderedThree, [], true);

  assert.equal(next.rebuiltLineCount, 0);
  assert.equal(next.reusedLineIds.length, 1);
  assert.equal(next.result.summary.sourceAnalysisTruncated, true);
  assert.equal(next.result.summary.relationCount, previous.summary.relationCount);
});

test("la retirada de todas las relaciones elimina la línea sin dejar apariciones huérfanas", () => {
  const previous = snapshot([
    idea("a", "chapter-1", "memoria antigua del reino"),
    idea("b", "chapter-2", "memoria antigua del reino")
  ], orderedThree);
  const next = update(previous, [
    idea("a", "chapter-1", "memoria antigua del reino")
  ], ["chapter-1"], ["chapter-2"]);

  assert.equal(next.result.summary.lineCount, 0);
  assert.equal(next.result.summary.occurrenceCount, 0);
  assert.equal(next.result.summary.relationCount, 0);
  assert.equal(next.removedLineIds.length, 1);
});

test("mantiene determinismo aunque las ideas de entrada cambien de orden", () => {
  const candidates = [
    idea("a", "chapter-1", "memoria antigua del reino"),
    idea("b", "chapter-2", "memoria antigua del reino"),
    idea("c", "chapter-3", "memoria antigua del reino")
  ];
  const previous = snapshot(candidates, orderedThree);
  const first = update(previous, candidates, orderedThree, ["chapter-1"]);
  const second = update(previous, [...candidates].reverse(), orderedThree, ["chapter-1"]);

  assert.deepEqual(first.result, second.result);
  assert.deepEqual(first.changedLineIds, second.changedLineIds);
});

test("rechaza documentos cambiados repetidos, eventos duplicados e índices de otro proyecto", () => {
  const candidates = [
    idea("a", "chapter-1", "memoria antigua del reino"),
    idea("b", "chapter-2", "memoria antigua del reino")
  ];
  const previous = snapshot(candidates, orderedThree);
  const nextEvolution = evolution(candidates, orderedThree);

  assert.throws(() => updateNarrativeIdeaContinuityLinesIncrementally({
    projectId: "book-incremental",
    previous,
    nextEvolution,
    changedDocumentIds: ["chapter-1", "chapter-1"]
  }));
  assert.throws(() => updateNarrativeIdeaContinuityLinesIncrementally({
    projectId: "book-incremental",
    previous,
    nextEvolution: {
      ...nextEvolution,
      summary: { ...nextEvolution.summary, eventCount: 2, relationCount: 2 },
      events: [...nextEvolution.events, ...nextEvolution.events]
    },
    changedDocumentIds: ["chapter-1"]
  }));
  assert.throws(() => updateNarrativeIdeaContinuityLinesIncrementally({
    projectId: "other-book",
    previous,
    nextEvolution,
    changedDocumentIds: ["chapter-1"]
  }));
});

test("la diferencia incremental conserva eventos nuevos conectados al subgrafo afectado", () => {
  const previousCandidates = [
    idea("a", "chapter-1", "memoria antigua del reino"),
    idea("b", "chapter-2", "memoria antigua del reino")
  ];
  const previous = snapshot(previousCandidates, orderedThree);
  const nextCandidates = [
    ...previousCandidates,
    idea("c", "chapter-3", "memoria antigua del reino perdido")
  ];
  const next = update(previous, nextCandidates, orderedThree, ["chapter-3"]);

  assert.equal(next.result.summary.lineCount, 1);
  assert.equal(next.result.summary.occurrenceCount, 3);
  assert.ok(next.result.summary.relationCount >= 2);
  assert.equal(next.rebuiltLineCount, 1);
});
