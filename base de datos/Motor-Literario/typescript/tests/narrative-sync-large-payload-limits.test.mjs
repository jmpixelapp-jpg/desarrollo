import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import "fake-indexeddb/auto";
import {
  createNarrativeSyncOperationEnvelope,
  inspectNarrativeSyncJournalIntegrity,
  IndexedDbNarrativeSyncJournal,
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
