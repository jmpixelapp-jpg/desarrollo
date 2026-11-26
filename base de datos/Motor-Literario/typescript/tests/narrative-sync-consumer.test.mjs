import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createNarrativeSyncOperationEnvelope,
  createNarrativeSyncJournalConsumer,
  createRecoveryFirstNarrativeSyncConsumer,
  IndexedDbNarrativeSyncJournal
} from "../dist/motor-literario.js";

function createJournal() {
  return new IndexedDbNarrativeSyncJournal({
    databaseName: "narrative-sync-consumer-" + Math.random().toString(36).slice(2)
  });
}

test("consumidor integra recepción durable, validación, despacho y acuse", async () => {
  const journal = createJournal();
  const applied = [];
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "consumer-operation-1",
    projectId: "consumer-project",
    writerId: "consumer-writer",
    sequence: 1,
    kind: "idea-upsert",
    payload: { ideaId: "idea-1", text: "Memoria y retorno" }
  });

  assert.deepEqual(await journal.accept(envelope), {
    status: "accepted",
    nextSequence: 2
  });

  const consume = createNarrativeSyncJournalConsumer(journal, [{
    kind: "idea-upsert",
    validate: payload => Boolean(payload && typeof payload === "object" &&
      typeof payload.ideaId === "string" && typeof payload.text === "string"),
    apply: async operation => { applied.push(operation.operationId); }
  }]);

  assert.deepEqual(await consume("consumer-project", "consumer-writer"), {
    processed: 1,
    remaining: 0
  });
  assert.deepEqual(applied, ["consumer-operation-1"]);
  assert.deepEqual(await consume("consumer-project", "consumer-writer"), {
    processed: 0,
    remaining: 0
  });
  assert.equal((await journal.loadOperation("consumer-project", "consumer-operation-1"))?.appliedAt !== undefined, true);
  journal.close();
});

test("un payload rechazado permanece pendiente y puede reintentarse con un handler válido", async () => {
  const journal = createJournal();
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "consumer-operation-2",
    projectId: "consumer-project",
    writerId: "consumer-writer",
    sequence: 1,
    kind: "idea-upsert",
    payload: { ideaId: 42 }
  });
  await journal.accept(envelope);

  const invalidConsumer = createNarrativeSyncJournalConsumer(journal, [{
    kind: "idea-upsert",
    validate: payload => Boolean(payload && typeof payload.ideaId === "string"),
    apply: async () => { throw new Error("No debe aplicarse un payload inválido."); }
  }]);
  const rejected = await invalidConsumer("consumer-project");
  assert.equal(rejected.processed, 0);
  assert.equal(rejected.remaining, 1);
  assert.equal(rejected.failure, "apply-or-ack-failed");

  let applied = 0;
  const validConsumer = createNarrativeSyncJournalConsumer(journal, [{
    kind: "idea-upsert",
    validate: payload => Boolean(payload && typeof payload.ideaId === "number"),
    apply: async () => { applied++; }
  }]);
  const retried = await validConsumer("consumer-project", "consumer-writer");
  assert.deepEqual(retried, { processed: 1, remaining: 0 });
  assert.equal(applied, 1);
  journal.close();
});

test("consumidor solo reproduce el escritor solicitado y conserva el aislamiento del proyecto", async () => {
  const journal = createJournal();
  const first = await createNarrativeSyncOperationEnvelope({
    operationId: "consumer-operation-a",
    projectId: "consumer-project",
    writerId: "writer-a",
    sequence: 1,
    kind: "note",
    payload: { value: "A" }
  });
  const second = await createNarrativeSyncOperationEnvelope({
    operationId: "consumer-operation-b",
    projectId: "consumer-project",
    writerId: "writer-b",
    sequence: 1,
    kind: "note",
    payload: { value: "B" }
  });
  const otherProject = await createNarrativeSyncOperationEnvelope({
    operationId: "consumer-operation-c",
    projectId: "other-project",
    writerId: "writer-a",
    sequence: 1,
    kind: "note",
    payload: { value: "C" }
  });
  await journal.accept(first);
  await journal.accept(second);
  await journal.accept(otherProject);

  const applied = [];
  const consume = createNarrativeSyncJournalConsumer(journal, [{
    kind: "note",
    validate: payload => Boolean(payload && typeof payload.value === "string"),
    apply: async operation => { applied.push(operation.operationId); }
  }]);

  assert.deepEqual(await consume("consumer-project", "writer-b"), {
    processed: 1,
    remaining: 0
  });
  assert.deepEqual(applied, ["consumer-operation-b"]);
  assert.equal((await journal.loadPendingOperations("consumer-project")).length, 1);
  assert.equal((await journal.loadPendingOperations("other-project")).length, 1);
  journal.close();
});


test("la sincronización protegida recupera referencias antes de reproducir operaciones", async () => {
  const journal = createJournal();
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "recovery-first-sync-1",
    projectId: "recovery-first-project",
    writerId: "remote-writer",
    sequence: 1,
    kind: "note",
    payload: { value: "incoming" }
  });
  await journal.accept(envelope);
  const order = [];
  const store = {
    loadNarrativeReferenceRepairPending: async projectId => {
      order.push("recover:" + projectId);
      return [];
    },
    appendNarrativeReferenceRepairAudit: async () => {},
    deleteNarrativeReferenceRepairPending: async () => {}
  };
  const consume = createRecoveryFirstNarrativeSyncConsumer(store, journal, [{
    kind: "note",
    validate: payload => Boolean(payload && typeof payload.value === "string"),
    apply: async () => { order.push("apply"); }
  }]);

  const result = await consume("recovery-first-project", "remote-writer");
  assert.deepEqual(order, ["recover:recovery-first-project", "apply"]);
  assert.equal(result.blockedByPendingRepairs, false);
  assert.deepEqual(result.replay, { processed: 1, remaining: 0 });
  assert.equal(result.recovery.recovered, 0);
  journal.close();
});

test("la sincronización protegida retiene el replay si una reparación queda en conflicto", async () => {
  const journal = createJournal();
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "recovery-first-sync-2",
    projectId: "recovery-blocked-project",
    writerId: "remote-writer",
    sequence: 1,
    kind: "note",
    payload: { value: "must-wait" }
  });
  await journal.accept(envelope);
  let applied = 0;
  const store = {
    loadNarrativeReferenceRepairPending: async () => [{
      projectId: "recovery-blocked-project",
      operationId: "tampered-operation-id",
      recordType: "relation",
      recordId: "relation-1",
      referenceField: "fromEntityId",
      missingReferenceId: "legacy-entity",
      replacementEntityId: "canonical-entity",
      issueCode: "missing-relation-entity",
      appliedAt: 10
    }],
    appendNarrativeReferenceRepairAudit: async () => {},
    deleteNarrativeReferenceRepairPending: async () => {}
  };
  const consume = createRecoveryFirstNarrativeSyncConsumer(store, journal, [{
    kind: "note",
    validate: payload => Boolean(payload && typeof payload.value === "string"),
    apply: async () => { applied++; }
  }]);

  const result = await consume("recovery-blocked-project", "remote-writer");
  assert.equal(result.blockedByPendingRepairs, true);
  assert.equal(result.recovery.pending.length, 1);
  assert.equal(result.replay, undefined);
  assert.equal(applied, 0);
  assert.equal((await journal.loadPendingOperations("recovery-blocked-project")).length, 1);
  journal.close();
});
