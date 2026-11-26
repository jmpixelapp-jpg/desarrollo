import test from "node:test";
import assert from "node:assert/strict";
import {
  createNarrativeSyncOperationEnvelope,
  inspectNarrativeSyncJournalIntegrity
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
  const journal = {
    loadOperations: async () => [
      { ...first, receivedAt: 10 },
      { ...second, receivedAt: 20 }
    ],
    loadWriterCursors: async () => [{
      projectId: "cursor-project-2", writerId: "writer-a",
      lastSequence: 1, lastOperationId: "cursor-op-a", updatedAt: 15
    }, {
      projectId: "cursor-project-2", writerId: "writer-a-mismatch",
      lastSequence: 2, lastOperationId: "wrong-last-operation", updatedAt: 25
    }]
  };
  const report = await inspectNarrativeSyncJournalIntegrity(journal, "cursor-project-2");
  assert.ok(report.issues.some(issue => issue.code === "cursor-behind-journal"));
  assert.equal(report.intact, false);
});
