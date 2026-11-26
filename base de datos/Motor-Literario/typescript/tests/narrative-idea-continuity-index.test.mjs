import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeNarrativeIdeaCrossDocumentRelations,
  buildNarrativeIdeaContinuityLines,
  buildNarrativeIdeaEvolution,
  createNarrativeIdeaContinuityIndex,
  hydrateNarrativeIdeaContinuityIndex,
  updateNarrativeIdeaContinuityIndexIncrementally,
  validateNarrativeIdeaContinuityIndex
} from "../dist/motor-literario.js";

function idea(id, documentId, text, options = {}) {
  const excerpt = "La idea expresada es " + text + ".";
  const start = 10 + excerpt.indexOf(text);
  return {
    id,
    projectId: "book-index",
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

function result(candidates, orderedDocumentIds) {
  const relations = analyzeNarrativeIdeaCrossDocumentRelations({
    projectId: "book-index",
    ideaCandidates: candidates,
    orderedDocumentIds
  });
  const evolution = buildNarrativeIdeaEvolution({
    projectId: "book-index",
    crossDocumentAnalysis: relations
  });
  return buildNarrativeIdeaContinuityLines({ projectId: "book-index", evolution });
}

const candidates = [
  idea("idea-a", "chapter-1", "memoria antigua de la ciudad"),
  idea("idea-b", "chapter-2", "memoria antigua de la ciudad"),
  idea("idea-c", "chapter-3", "memoria antigua de la ciudad")
];
const revisions = [
  { documentId: "chapter-1", revision: 1, status: "active" },
  { documentId: "chapter-2", revision: 1, status: "active" },
  { documentId: "chapter-3", revision: 1, status: "active" }
];

test("compacta las evidencias repetidas por ID y recupera la misma proyección", () => {
  const source = result(candidates, ["chapter-1", "chapter-2", "chapter-3"]);
  const index = createNarrativeIdeaContinuityIndex({
    projectId: "book-index",
    generation: 1,
    updatedAt: 1234,
    sourceRevisions: revisions,
    result: source
  });

  assert.equal(index.version, 1);
  assert.equal(index.generation, 1);
  assert.equal(index.occurrences.length, 3);
  assert.equal(index.events.length, 3);
  assert.equal(index.lines.length, 1);
  assert.match(index.fingerprint, /^fnv1a64:[0-9a-f]{16}$/u);
  assert.deepEqual(hydrateNarrativeIdeaContinuityIndex(index), source);
});

test("aísla snapshots por proyecto y exige que cada aparición esté cubierta por una revisión activa", () => {
  const source = result(candidates.slice(0, 2), ["chapter-1", "chapter-2"]);
  assert.throws(() => createNarrativeIdeaContinuityIndex({
    projectId: "other-book",
    generation: 1,
    updatedAt: 1,
    sourceRevisions: revisions,
    result: source
  }));
  assert.throws(() => createNarrativeIdeaContinuityIndex({
    projectId: "book-index",
    generation: 1,
    updatedAt: 1,
    sourceRevisions: revisions.filter(item => item.documentId !== "chapter-2"),
    result: source
  }));
  assert.throws(() => createNarrativeIdeaContinuityIndex({
    projectId: "book-index",
    generation: 1,
    updatedAt: 1,
    sourceRevisions: revisions.map(item => item.documentId === "chapter-2"
      ? { ...item, revision: 0 } : item),
    result: source
  }));
  assert.throws(() => createNarrativeIdeaContinuityIndex({
    projectId: "book-index",
    generation: 1,
    updatedAt: 1,
    sourceRevisions: revisions.map(item => item.documentId === "chapter-2"
      ? { ...item, status: "deleted" } : item),
    result: source
  }));
});

test("validador rechaza huellas alteradas, inventarios duplicados y referencias huérfanas", () => {
  const index = createNarrativeIdeaContinuityIndex({
    projectId: "book-index",
    generation: 1,
    updatedAt: 1234,
    sourceRevisions: revisions,
    result: result(candidates, ["chapter-1", "chapter-2", "chapter-3"])
  });

  assert.throws(() => validateNarrativeIdeaContinuityIndex({
    ...index,
    fingerprint: "fnv1a64:" + "0".repeat(16)
  }));
  assert.throws(() => validateNarrativeIdeaContinuityIndex({
    ...index,
    occurrences: [...index.occurrences, index.occurrences[0]]
  }));
  assert.throws(() => validateNarrativeIdeaContinuityIndex({
    ...index,
    lines: [{
      ...index.lines[0],
      occurrenceIds: [...index.lines[0].occurrenceIds, "missing-occurrence"]
    }]
  }));
});

test("ordena vector documental, preserva revisiones y rechaza IDs repetidos", () => {
  const source = result(candidates.slice(0, 2), ["chapter-1", "chapter-2"]);
  const index = createNarrativeIdeaContinuityIndex({
    projectId: "book-index",
    generation: 1,
    updatedAt: 1234,
    sourceRevisions: [...revisions.slice(0, 2)].reverse(),
    result: source
  });

  assert.deepEqual(index.sourceRevisions.map(item => item.documentId), ["chapter-1", "chapter-2"]);
  assert.throws(() => createNarrativeIdeaContinuityIndex({
    projectId: "book-index",
    generation: 1,
    updatedAt: 1234,
    sourceRevisions: [...revisions.slice(0, 2), revisions[0]],
    result: source
  }));
});


test("la orquestación incremental rechaza un snapshot anterior corrupto antes de reutilizar líneas", async () => {
  const source = result(candidates, ["chapter-1", "chapter-2", "chapter-3"]);
  const evolution = buildNarrativeIdeaEvolution({
    projectId: "book-index",
    crossDocumentAnalysis: analyzeNarrativeIdeaCrossDocumentRelations({
      projectId: "book-index",
      ideaCandidates: candidates,
      orderedDocumentIds: ["chapter-1", "chapter-2", "chapter-3"]
    })
  });
  const valid = createNarrativeIdeaContinuityIndex({
    projectId: "book-index",
    generation: 1,
    updatedAt: 1234,
    sourceRevisions: revisions,
    result: source
  });
  const corrupt = { ...valid, fingerprint: "fnv1a64:" + "0".repeat(16) };
  let writes = 0;
  const store = {
    async loadNarrativeIdeaContinuityIndex() { return corrupt; },
    async saveNarrativeIdeaContinuityIndexIfUnchanged() { writes++; }
  };

  await assert.rejects(updateNarrativeIdeaContinuityIndexIncrementally(store, {
    projectId: "book-index",
    updatedAt: 2000,
    sourceRevisions: revisions,
    nextEvolution: evolution
  }), /huella|fingerprint|índice/u);
  assert.equal(writes, 0);
});
