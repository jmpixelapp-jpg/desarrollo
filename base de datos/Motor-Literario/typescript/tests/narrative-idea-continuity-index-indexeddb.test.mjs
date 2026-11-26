import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";

globalThis.indexedDB = new IDBFactory();
const {
  IndexedDbProjectStore,
  analyzeNarrativeIdeaCrossDocumentRelations,
  buildNarrativeIdeaContinuityLines,
  buildNarrativeIdeaEvolution,
  commitNarrativeIdeaContinuityIndex,
  createNarrativeIdeaContinuityIndex,
  hydrateNarrativeIdeaContinuityIndex
} = await import("../dist/motor-literario.js");

function idea(id, documentId, text, revision = 1, projectId = "persisted-continuity-" + projectSuffix) {
  const excerpt = "La idea expresada es " + text + ".";
  const start = 10 + excerpt.indexOf(text);
  return {
    id,
    projectId,
    documentId,
    revision,
    kind: "theme",
    text,
    confidence: "high",
    polarity: "affirmed",
    reviewStatus: "candidate",
    evidence: { start, end: start + text.length, excerpt }
  };
}

const projectSuffix = randomUUID();

function result(candidates, orderedDocumentIds, projectId = "persisted-continuity-" + projectSuffix) {
  const relations = analyzeNarrativeIdeaCrossDocumentRelations({
    projectId,
    ideaCandidates: candidates,
    orderedDocumentIds
  });
  const evolution = buildNarrativeIdeaEvolution({
    projectId,
    crossDocumentAnalysis: relations
  });
  return buildNarrativeIdeaContinuityLines({
    projectId,
    evolution
  });
}

test("IndexedDB conserva y rehidrata el índice compacto con aislamiento por proyecto", async () => {
  const store = new IndexedDbProjectStore();
  const projectId = "persisted-continuity-" + projectSuffix;
  const candidates = [
    idea("a", "chapter-1", "memoria antigua de la ciudad", 1, projectId),
    idea("b", "chapter-2", "memoria antigua de la ciudad", 1, projectId)
  ];
  const source = result(candidates, ["chapter-1", "chapter-2"], projectId);
  const sourceRevisions = [
    { documentId: "chapter-1", revision: 1, status: "active" },
    { documentId: "chapter-2", revision: 1, status: "active" }
  ];

  try {
    const first = await commitNarrativeIdeaContinuityIndex(store, {
      projectId,
      updatedAt: 1_000,
      sourceRevisions,
      result: source
    });
    assert.equal(first.index.generation, 1);
    assert.equal(first.reused, false);
    assert.deepEqual(
      hydrateNarrativeIdeaContinuityIndex(await store.loadNarrativeIdeaContinuityIndex(projectId)),
      source
    );
    assert.equal(await store.loadNarrativeIdeaContinuityIndex(projectId + "-other"), undefined);

    const replay = await commitNarrativeIdeaContinuityIndex(store, {
      projectId,
      updatedAt: 2_000,
      sourceRevisions,
      result: source
    });
    assert.equal(replay.reused, true);
    assert.equal(replay.index.generation, 1);
    assert.equal(replay.index.updatedAt, 1_000);
  } finally {
    await store.close();
  }
});

test("CAS rechaza una generación obsoleta y admite la generación siguiente", async () => {
  const store = new IndexedDbProjectStore();
  const projectId = "persisted-cas-" + randomUUID();
  const candidates = [
    idea("a", "chapter-1", "memoria antigua de la ciudad", 1, projectId),
    idea("b", "chapter-2", "memoria antigua de la ciudad", 1, projectId)
  ];
  const source = result(candidates, ["chapter-1", "chapter-2"], projectId);
  const sourceRevisions = [
    { documentId: "chapter-1", revision: 1, status: "active" },
    { documentId: "chapter-2", revision: 1, status: "active" }
  ];

  try {
    const first = createNarrativeIdeaContinuityIndex({
      projectId,
      generation: 1,
      updatedAt: 1_000,
      sourceRevisions,
      result: source
    });
    await store.saveNarrativeIdeaContinuityIndexIfUnchanged(first);
    const second = createNarrativeIdeaContinuityIndex({
      projectId,
      generation: 2,
      updatedAt: 2_000,
      sourceRevisions,
      result: source
    });
    await assert.rejects(
      store.saveNarrativeIdeaContinuityIndexIfUnchanged(second, 0),
      /CAS|generación|aborto/u
    );
    await store.saveNarrativeIdeaContinuityIndexIfUnchanged(second, 1);
    assert.equal((await store.loadNarrativeIdeaContinuityIndex(projectId)).generation, 2);
  } finally {
    await store.close();
  }
});

test("dos instancias no pueden confirmar simultáneamente la misma generación CAS", async () => {
  const storeA = new IndexedDbProjectStore();
  const storeB = new IndexedDbProjectStore();
  const projectId = "persisted-race-" + randomUUID();
  const candidates = [
    idea("a", "chapter-1", "memoria antigua de la ciudad", 1, projectId),
    idea("b", "chapter-2", "memoria antigua de la ciudad", 1, projectId)
  ];
  const source = result(candidates, ["chapter-1", "chapter-2"], projectId);
  const base = createNarrativeIdeaContinuityIndex({
    projectId,
    generation: 1,
    updatedAt: 1_000,
    sourceRevisions: [
      { documentId: "chapter-1", revision: 1, status: "active" },
      { documentId: "chapter-2", revision: 1, status: "active" }
    ],
    result: source
  });

  try {
    await storeA.saveNarrativeIdeaContinuityIndexIfUnchanged(base);
    const nextA = createNarrativeIdeaContinuityIndex({
      projectId, generation: 2, updatedAt: 2_000,
      sourceRevisions: base.sourceRevisions, result: source
    });
    const nextB = createNarrativeIdeaContinuityIndex({
      projectId, generation: 2, updatedAt: 3_000,
      sourceRevisions: [
        ...base.sourceRevisions,
        { documentId: "chapter-3", revision: 1, status: "active" }
      ],
      result: source
    });
    const outcomes = await Promise.allSettled([
      storeA.saveNarrativeIdeaContinuityIndexIfUnchanged(nextA, 1),
      storeB.saveNarrativeIdeaContinuityIndexIfUnchanged(nextB, 1)
    ]);
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
    assert.equal((await storeA.loadNarrativeIdeaContinuityIndex(projectId)).generation, 2);
  } finally {
    await storeA.close();
    await storeB.close();
  }
});
