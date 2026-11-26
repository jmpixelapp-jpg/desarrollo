import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import "fake-indexeddb/auto";
import {
  createNarrativeSyncOperationEnvelope,
  createNarrativeIdeaContinuityIndex,
  createNarrativeIdeaContinuityIndexSyncEnvelope,
  analyzeNarrativeIdeaCrossDocumentRelations,
  buildNarrativeIdeaContinuityLines,
  buildNarrativeIdeaEvolution,
  inspectNarrativeSyncJournalIntegrity,
  IndexedDbNarrativeSyncJournal,
  NARRATIVE_IDEA_CONTINUITY_SYNC_LIMITS,
  replayPendingNarrativeSyncOperations
} from "../dist/motor-literario.js";

test("el diario conserva su límite por defecto y permite aumentarlo explícitamente", async () => {
  const payload = { content: "x".repeat(1_100_000) };
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "large-" + randomUUID(),
    projectId: "project-large",
    writerId: "writer-large",
    sequence: 1,
    kind: "test-large-payload",
    payload
  }, { maxBytes: 2_000_000 });

  const defaultJournal = new IndexedDbNarrativeSyncJournal({
    databaseName: "sync-default-" + randomUUID()
  });
  const configuredJournal = new IndexedDbNarrativeSyncJournal({
    databaseName: "sync-configured-" + randomUUID(),
    canonicalizationLimits: {
      maxDepth: 64,
      maxNodes: 100_000,
      maxBytes: 2_000_000
    }
  });

  try {
    await assert.rejects(defaultJournal.accept(envelope), /SHA-256/u);
    assert.equal(await configuredJournal.verifyEnvelope(envelope), true);
    assert.deepEqual(await configuredJournal.accept(envelope), {
      status: "accepted",
      nextSequence: 2
    });

    const audit = await inspectNarrativeSyncJournalIntegrity(
      configuredJournal,
      "project-large"
    );
    assert.equal(audit.intact, true);
    assert.equal(audit.checkedOperations, 1);

    const replay = await replayPendingNarrativeSyncOperations(
      configuredJournal,
      "project-large",
      async operation => {
        assert.equal(operation.payload.content.length, 1_100_000);
      },
      "writer-large"
    );
    assert.deepEqual(replay, { processed: 1, remaining: 0 });
  } finally {
    defaultJournal.close();
    configuredJournal.close();
  }
});

test("los límites configurados se validan al construir el diario", () => {
  assert.throws(() => new IndexedDbNarrativeSyncJournal({
    databaseName: "sync-invalid-limits",
    canonicalizationLimits: { maxBytes: 0 }
  }), /entero positivo/u);
});


test("un índice de continuidad mayor a 1 MiB viaja con la política específica y se reproduce", async () => {
  const projectId = "large-continuity-" + randomUUID();
  const text = "memoria antigua de la ciudad";
  const makeIdea = (id, documentId) => {
    const prefix = "x".repeat(550_000);
    const excerpt = prefix + text + "y".repeat(550_000);
    const start = prefix.length;
    return {
      id,
      projectId,
      documentId,
      revision: 1,
      kind: "theme",
      text,
      confidence: "high",
      polarity: "affirmed",
      reviewStatus: "candidate",
      evidence: { start, end: start + text.length, excerpt }
    };
  };
  const analysis = analyzeNarrativeIdeaCrossDocumentRelations({
    projectId,
    ideaCandidates: [
      makeIdea("idea-a", "chapter-1"),
      makeIdea("idea-b", "chapter-2")
    ],
    orderedDocumentIds: ["chapter-1", "chapter-2"]
  });
  const evolution = buildNarrativeIdeaEvolution({
    projectId,
    crossDocumentAnalysis: analysis
  });
  const lines = buildNarrativeIdeaContinuityLines({ projectId, evolution });
  const index = createNarrativeIdeaContinuityIndex({
    projectId,
    generation: 1,
    updatedAt: 1_000,
    sourceRevisions: [
      { documentId: "chapter-1", revision: 1, status: "active" },
      { documentId: "chapter-2", revision: 1, status: "active" }
    ],
    result: lines
  });
  const envelope = await createNarrativeIdeaContinuityIndexSyncEnvelope({
    operationId: "large-continuity-" + randomUUID(),
    projectId,
    writerId: "writer-large-continuity",
    sequence: 1,
    payload: { index }
  });
  const defaultJournal = new IndexedDbNarrativeSyncJournal({
    databaseName: "sync-default-continuity-" + randomUUID()
  });
  const configuredJournal = new IndexedDbNarrativeSyncJournal({
    databaseName: "sync-large-continuity-" + randomUUID(),
    canonicalizationLimits: NARRATIVE_IDEA_CONTINUITY_SYNC_LIMITS
  });

  try {
    assert.ok(JSON.stringify(envelope).length > 1_048_576);
    await assert.rejects(defaultJournal.accept(envelope), /SHA-256/u);
    assert.equal(await configuredJournal.verifyEnvelope(envelope), true);
    await configuredJournal.accept(envelope);
    const replay = await replayPendingNarrativeSyncOperations(
      configuredJournal,
      projectId,
      async operation => {
        assert.equal(operation.kind, "idea-continuity-index-upsert");
        assert.equal(operation.payload.index.fingerprint, index.fingerprint);
      },
      "writer-large-continuity"
    );
    assert.deepEqual(replay, { processed: 1, remaining: 0 });
  } finally {
    defaultJournal.close();
    configuredJournal.close();
  }
});
