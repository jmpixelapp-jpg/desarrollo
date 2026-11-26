import test from "node:test";
import assert from "node:assert/strict";
import {
  createNarrativeSyncOperationEnvelope,
  IndexedDbNarrativeSyncJournal,
  inspectNarrativeSyncJournalIntegrity,
  planNarrativeSyncJournalCursorRecovery
} from "../dist/motor-literario.js";

test("el diario íntegro informa continuidad y metadatos sin mutar operaciones", async () => {
  const first = await createNarrativeSyncOperationEnvelope({
    operationId: "integrity-op-1", projectId: "integrity-project",
    writerId: "writer-a", sequence: 1, createdAt: 10,
    kind: "note", payload: { text: "inicio" }
  });
  const second = await createNarrativeSyncOperationEnvelope({
    operationId: "integrity-op-2", projectId: "integrity-project",
    writerId: "writer-a", sequence: 2, createdAt: 20,
    kind: "note", payload: { text: "continuación" }
  });
  const operations = [
    { ...first, receivedAt: 11, appliedAt: 12 },
    { ...second, receivedAt: 21 }
  ];
  const journal = {
    loadOperations: async () => structuredClone(operations),
    loadWriterCursors: async () => [{ projectId: "integrity-project", writerId: "writer-a", lastSequence: 2, lastOperationId: "integrity-op-2", updatedAt: 22 }]
  };

  const report = await inspectNarrativeSyncJournalIntegrity(journal, "integrity-project");
  assert.deepEqual(report, {
    projectId: "integrity-project",
    checkedOperations: 2,
    checkedWriters: 1,
    issues: [],
    intact: true
  });
  assert.equal(operations[1].appliedAt, undefined);
});

test("el diario detecta huecos, secuencias repetidas, metadatos inválidos y digest corrupto", async () => {
  const make = async (operationId, sequence) => ({
    ...await createNarrativeSyncOperationEnvelope({
      operationId, projectId: "integrity-project", writerId: "writer-a",
      sequence, createdAt: sequence, kind: "note", payload: { operationId }
    }),
    receivedAt: 50
  });
  const first = await make("integrity-op-1", 1);
  const gap = await make("integrity-op-3", 3);
  const duplicate = await make("integrity-op-3b", 3);
  const corrupt = { ...await make("integrity-op-4", 4), digest: "sha256:" + "0".repeat(64) };
  corrupt.appliedAt = 40;
  const journal = {
    loadOperations: async () => [first, gap, duplicate, corrupt],
    loadWriterCursors: async () => [{ projectId: "integrity-project", writerId: "writer-a", lastSequence: 4, lastOperationId: "integrity-op-4", updatedAt: 60 }]
  };

  const report = await inspectNarrativeSyncJournalIntegrity(journal, "integrity-project");
  const codes = report.issues.map(issue => issue.code);
  assert.ok(codes.includes("sequence-gap"));
  assert.ok(codes.includes("duplicate-writer-sequence"));
  assert.ok(codes.includes("invalid-applied-at"));
  assert.ok(codes.includes("invalid-envelope"));
  assert.equal(report.intact, false);
  assert.equal(report.checkedOperations, 4);
});


test("la auditoría detecta cursores adelantados, retrasados y sin operaciones", async () => {
  const operation = await createNarrativeSyncOperationEnvelope({
    operationId: "cursor-op-1", projectId: "cursor-project",
    writerId: "writer-a", sequence: 1, kind: "note", payload: { value: 1 }
  });
  const journal = {
    loadOperations: async () => [{ ...operation, receivedAt: 10 }],
    loadWriterCursors: async () => [
      { projectId: "cursor-project", writerId: "writer-a", lastSequence: 2, lastOperationId: "cursor-op-2", updatedAt: 20 },
      { projectId: "cursor-project", writerId: "writer-b", lastSequence: 1, lastOperationId: "missing-op", updatedAt: 20 }
    ]
  };
  const report = await inspectNarrativeSyncJournalIntegrity(journal, "cursor-project");
  const codes = report.issues.map(issue => issue.code);
  assert.ok(codes.includes("cursor-ahead-of-journal"));
  assert.ok(codes.includes("cursor-without-operations"));
  assert.equal(report.intact, false);
});

test("la auditoría detecta operaciones posteriores al cursor y última identidad divergente", async () => {
  const first = await createNarrativeSyncOperationEnvelope({
    operationId: "cursor-op-a", projectId: "cursor-project-2",
    writerId: "writer-a", sequence: 1, kind: "note", payload: { value: 1 }
  });
  const second = await createNarrativeSyncOperationEnvelope({
    operationId: "cursor-op-b", projectId: "cursor-project-2",
    writerId: "writer-a", sequence: 2, kind: "note", payload: { value: 2 }
  });
  const otherWriter = await createNarrativeSyncOperationEnvelope({
    operationId: "cursor-op-c", projectId: "cursor-project-2",
    writerId: "writer-b", sequence: 1, kind: "note", payload: { value: 3 }
  });
  const journal = {
    loadOperations: async () => [
      { ...first, receivedAt: 10 },
      { ...second, receivedAt: 20 },
      { ...otherWriter, receivedAt: 30 }
    ],
    loadWriterCursors: async () => [{
      projectId: "cursor-project-2", writerId: "writer-a",
      lastSequence: 1, lastOperationId: "cursor-op-a", updatedAt: 15
    }, {
      projectId: "cursor-project-2", writerId: "writer-b",
      lastSequence: 1, lastOperationId: "wrong-last-operation", updatedAt: 35
    }]
  };
  const report = await inspectNarrativeSyncJournalIntegrity(journal, "cursor-project-2");
  assert.ok(report.issues.some(issue => issue.code === "cursor-behind-journal"));
  assert.ok(report.issues.some(issue => issue.code === "cursor-last-operation-mismatch"));
  assert.equal(report.intact, false);
});


test("la auditoría detecta operaciones sin cursor durable e identidad de cursor inválida", async () => {
  const operation = await createNarrativeSyncOperationEnvelope({
    operationId: "orphan-operation", projectId: "orphan-project",
    writerId: "writer-orphan", sequence: 1, kind: "note", payload: { value: "orphan" }
  });
  const journal = {
    loadOperations: async () => [{ ...operation, receivedAt: 10 }],
    loadWriterCursors: async () => [{
      projectId: "orphan-project",
      writerId: "writer-malformed",
      lastSequence: 0,
      lastOperationId: "",
      updatedAt: -1
    }]
  };
  const report = await inspectNarrativeSyncJournalIntegrity(journal, "orphan-project");
  const codes = report.issues.map(issue => issue.code);
  assert.ok(codes.includes("cursor-missing-for-operations"));
  assert.ok(codes.includes("invalid-cursor"));
  assert.ok(codes.includes("cursor-without-operations"));
  assert.equal(report.intact, false);
});


test("la auditoría informa cursores con writerId no textual sin interrumpirse", async () => {
  const journal = {
    loadOperations: async () => [],
    loadWriterCursors: async () => [{
      projectId: "bad-cursor-project",
      writerId: null,
      lastSequence: 0,
      lastOperationId: null,
      updatedAt: -1
    }]
  };
  const report = await inspectNarrativeSyncJournalIntegrity(journal, "bad-cursor-project");
  assert.equal(report.intact, false);
  assert.ok(report.issues.some(issue => issue.code === "invalid-cursor"));
});

test("la auditoría exige soporte para leer cursores antes de comenzar", async () => {
  await assert.rejects(
    inspectNarrativeSyncJournalIntegrity({ loadOperations: async () => [] }, "missing-cursor-reader"),
    /diario y un proyecto válidos/
  );
});


test("el planificador propone reconstrucción solo con diario completo y no muta el almacén", async () => {
  const first = await createNarrativeSyncOperationEnvelope({
    operationId: "plan-op-1", projectId: "plan-project",
    writerId: "writer-a", sequence: 1, kind: "note", payload: { n: 1 }
  });
  const second = await createNarrativeSyncOperationEnvelope({
    operationId: "plan-op-2", projectId: "plan-project",
    writerId: "writer-a", sequence: 2, kind: "note", payload: { n: 2 }
  });
  const operations = [{ ...first, receivedAt: 10 }, { ...second, receivedAt: 20 }];
  const cursors = [];
  const before = structuredClone({ operations, cursors });
  const journal = {
    loadOperations: async () => structuredClone(operations),
    loadWriterCursors: async () => structuredClone(cursors)
  };

  const plan = await planNarrativeSyncJournalCursorRecovery(journal, "plan-project");
  assert.equal(plan.proposedRebuildCount, 1);
  assert.equal(plan.manualReviewCount, 0);
  assert.equal(plan.requiresManualReview, false);
  assert.deepEqual(plan.items[0], {
    writerId: "writer-a",
    action: "rebuild-cursor-from-complete-journal",
    reason: "El historial es contiguo desde la secuencia 1 y sus envolturas son válidas; se puede proponer un cursor derivado de la última operación.",
    proposal: {
      projectId: "plan-project",
      writerId: "writer-a",
      lastSequence: 2,
      lastOperationId: "plan-op-2"
    },
    issueCodes: ["cursor-missing-for-operations"]
  });
  assert.deepEqual({ operations, cursors }, before);
});

test("el planificador exige revisión manual ante huecos o cursores adelantados", async () => {
  const first = await createNarrativeSyncOperationEnvelope({
    operationId: "manual-op-1", projectId: "manual-project",
    writerId: "writer-gap", sequence: 1, kind: "note", payload: { n: 1 }
  });
  const gap = await createNarrativeSyncOperationEnvelope({
    operationId: "manual-op-3", projectId: "manual-project",
    writerId: "writer-gap", sequence: 3, kind: "note", payload: { n: 3 }
  });
  const another = await createNarrativeSyncOperationEnvelope({
    operationId: "manual-op-b1", projectId: "manual-project",
    writerId: "writer-ahead", sequence: 1, kind: "note", payload: { n: 1 }
  });
  const journal = {
    loadOperations: async () => [
      { ...first, receivedAt: 10 },
      { ...gap, receivedAt: 30 },
      { ...another, receivedAt: 40 }
    ],
    loadWriterCursors: async () => [{
      projectId: "manual-project", writerId: "writer-ahead",
      lastSequence: 2, lastOperationId: "missing-op-2", updatedAt: 50
    }]
  };

  const plan = await planNarrativeSyncJournalCursorRecovery(journal, "manual-project");
  assert.equal(plan.manualReviewCount, 2);
  assert.equal(plan.proposedRebuildCount, 0);
  assert.equal(plan.requiresManualReview, true);
  assert.ok(plan.items.every(item => item.action === "manual-review"));
  assert.ok(plan.items.find(item => item.writerId === "writer-gap").issueCodes.includes("sequence-gap"));
  assert.ok(plan.items.find(item => item.writerId === "writer-ahead").issueCodes.includes("cursor-ahead-of-journal"));
});

test("el planificador reconoce un cursor coherente y no recomienda cambios", async () => {
  const operation = await createNarrativeSyncOperationEnvelope({
    operationId: "stable-op-1", projectId: "stable-project",
    writerId: "writer-stable", sequence: 1, kind: "note", payload: { stable: true }
  });
  const journal = {
    loadOperations: async () => [{ ...operation, receivedAt: 10 }],
    loadWriterCursors: async () => [{
      projectId: "stable-project", writerId: "writer-stable",
      lastSequence: 1, lastOperationId: "stable-op-1", updatedAt: 11
    }]
  };
  const plan = await planNarrativeSyncJournalCursorRecovery(journal, "stable-project");
  assert.equal(plan.requiresManualReview, false);
  assert.equal(plan.proposedRebuildCount, 0);
  assert.equal(plan.manualReviewCount, 0);
  assert.equal(plan.items[0].action, "no-action");
});


test("el planificador solo propone corregir identidad final cuando la secuencia está completa", async () => {
  const first = await createNarrativeSyncOperationEnvelope({
    operationId: "identity-plan-1", projectId: "identity-plan-project",
    writerId: "writer-identity", sequence: 1, kind: "note", payload: { n: 1 }
  });
  const second = await createNarrativeSyncOperationEnvelope({
    operationId: "identity-plan-2", projectId: "identity-plan-project",
    writerId: "writer-identity", sequence: 2, kind: "note", payload: { n: 2 }
  });
  const journal = {
    loadOperations: async () => [
      { ...first, receivedAt: 10 },
      { ...second, receivedAt: 20 }
    ],
    loadWriterCursors: async () => [{
      projectId: "identity-plan-project", writerId: "writer-identity",
      lastSequence: 2, lastOperationId: "wrong-operation-id", updatedAt: 30
    }]
  };
  const plan = await planNarrativeSyncJournalCursorRecovery(journal, "identity-plan-project");
  assert.equal(plan.proposedRebuildCount, 1);
  assert.equal(plan.requiresManualReview, false);
  assert.equal(plan.items[0].action, "rebuild-cursor-from-complete-journal");
  assert.equal(plan.items[0].proposal.lastOperationId, "identity-plan-2");
  assert.deepEqual(plan.items[0].issueCodes, ["cursor-last-operation-mismatch"]);
});


test("la recuperación acepta snapshots idénticos aunque IndexedDB reordene las propiedades", async () => {
  const { indexedDB } = await import("fake-indexeddb");
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = indexedDB;
  const databaseName = "sync-recovery-canonical-" + Math.random().toString(36).slice(2);
  const journal = new IndexedDbNarrativeSyncJournal({ databaseName });
  try {
    const operation = await createNarrativeSyncOperationEnvelope({
      operationId: "canonical-recovery-op",
      projectId: "canonical-recovery-project",
      writerId: "writer-canonical",
      sequence: 1,
      createdAt: 100,
      kind: "note",
      payload: { text: "La forma no altera el contenido." }
    });
    await journal.accept(operation);

    // Simula un snapshot estructuralmente idéntico con distinto orden de claves.
    const database = await journal.database;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("operations", "readwrite");
      const store = transaction.objectStore("operations");
      const request = store.get([operation.projectId, operation.operationId]);
      request.onsuccess = () => {
        const current = request.result;
        store.put(Object.fromEntries(Object.entries(current).reverse()));
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    assert.deepEqual(
      await journal.applyCursorRecoveryProposal({
        projectId: operation.projectId,
        writerId: operation.writerId,
        lastSequence: operation.sequence,
        lastOperationId: operation.operationId
      }),
      {
        status: "already-consistent",
        writerId: operation.writerId,
        lastSequence: operation.sequence,
        lastOperationId: operation.operationId
      }
    );
  } finally {
    journal.close();
    globalThis.indexedDB = previous;
    await new Promise(resolve => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }
});
