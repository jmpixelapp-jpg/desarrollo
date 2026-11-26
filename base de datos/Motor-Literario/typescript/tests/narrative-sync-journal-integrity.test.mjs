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
  const journal = { loadOperations: async () => structuredClone(operations) };

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
    loadOperations: async () => [first, gap, duplicate, corrupt]
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
