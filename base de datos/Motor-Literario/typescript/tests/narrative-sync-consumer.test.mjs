import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createNarrativeSyncOperationEnvelope,
  createNarrativeSyncJournalConsumer,
  createRecoveryFirstNarrativeSyncConsumer,
  replayPendingNarrativeSyncOperations,
  IndexedDbNarrativeSyncJournal
} from "../dist/motor-literario.js";

function createJournal(databaseName = "narrative-sync-consumer-" + Math.random().toString(36).slice(2)) {
  return new IndexedDbNarrativeSyncJournal({ databaseName });
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
  assert.equal(result.blockedByJournalIntegrity, false);
  assert.equal(result.journalIntegrity.intact, true);
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
  assert.equal(result.blockedByJournalIntegrity, false);
  assert.equal(result.recovery.pending.length, 1);
  assert.equal(result.replay, undefined);
  assert.equal(applied, 0);
  assert.equal((await journal.loadPendingOperations("recovery-blocked-project")).length, 1);
  journal.close();
});


test("la sincronización protegida bloquea replay ante digest corrupto del diario", async () => {
  const databaseName = "recovery-corrupt-journal-" + Math.random().toString(36).slice(2);
  const journal = createJournal(databaseName);
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "corrupt-sync-1",
    projectId: "corrupt-journal-project",
    writerId: "remote-writer",
    sequence: 1,
    kind: "note",
    payload: { value: "must-not-apply" }
  });
  await journal.accept(envelope);
  journal.close();

  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const transaction = database.transaction("operations", "readwrite");
    const store = transaction.objectStore("operations");
    const request = store.get(["corrupt-journal-project", "corrupt-sync-1"]);
    request.onsuccess = () => store.put({ ...request.result, digest: "sha256:" + "0".repeat(64) });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();

  const reopenedJournal = createJournal(databaseName);
  let applied = 0;
  const store = {
    loadNarrativeReferenceRepairPending: async () => [],
    appendNarrativeReferenceRepairAudit: async () => {},
    deleteNarrativeReferenceRepairPending: async () => {}
  };
  const consume = createRecoveryFirstNarrativeSyncConsumer(store, reopenedJournal, [{
    kind: "note",
    validate: payload => Boolean(payload && typeof payload.value === "string"),
    apply: async () => { applied++; }
  }]);

  const result = await consume("corrupt-journal-project", "remote-writer");
  assert.equal(result.blockedByJournalIntegrity, true);
  assert.equal(result.journalIntegrity.intact, false);
  assert.ok(result.journalIntegrity.issues.some(issue => issue.code === "invalid-envelope"));
  assert.equal(result.replay, undefined);
  assert.equal(applied, 0);
  assert.equal((await reopenedJournal.loadPendingOperations("corrupt-journal-project")).length, 1);
  reopenedJournal.close();
});


test("el diario expone cursores durables ordenados por escritor sin permitir mutación", async () => {
  const journal = createJournal();
  const secondWriter = await createNarrativeSyncOperationEnvelope({
    operationId: "cursor-read-b", projectId: "cursor-read-project",
    writerId: "writer-b", sequence: 1, kind: "note", payload: { value: "b" }
  });
  const firstWriter = await createNarrativeSyncOperationEnvelope({
    operationId: "cursor-read-a", projectId: "cursor-read-project",
    writerId: "writer-a", sequence: 1, kind: "note", payload: { value: "a" }
  });
  await journal.accept(secondWriter);
  await journal.accept(firstWriter);
  const cursors = await journal.loadWriterCursors("cursor-read-project");
  assert.deepEqual(cursors.map(cursor => cursor.writerId), ["writer-a", "writer-b"]);
  assert.deepEqual(cursors.map(cursor => cursor.lastSequence), [1, 1]);
  assert.deepEqual(cursors.map(cursor => cursor.lastOperationId), ["cursor-read-a", "cursor-read-b"]);
  assert.equal(await journal.getLastSequence("cursor-read-project", "writer-a"), 1);
  journal.close();
});


async function removeWriterCursor(databaseName, projectId, writerId) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const transaction = database.transaction("writer-cursors", "readwrite");
    transaction.objectStore("writer-cursors").delete([projectId, writerId]);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}

test("la sincronización protegida informa el plan pero no repara cursores sin aprobación", async () => {
  const databaseName = "recovery-cursor-no-approval-" + Math.random().toString(36).slice(2);
  const journal = createJournal(databaseName);
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "cursor-no-approval-1", projectId: "cursor-no-approval-project",
    writerId: "remote-writer", sequence: 1, kind: "note", payload: { value: "pending" }
  });
  await journal.accept(envelope);
  await removeWriterCursor(databaseName, "cursor-no-approval-project", "remote-writer");
  let applied = 0;
  const store = {
    loadNarrativeReferenceRepairPending: async () => [],
    appendNarrativeReferenceRepairAudit: async () => {},
    deleteNarrativeReferenceRepairPending: async () => {}
  };
  const consume = createRecoveryFirstNarrativeSyncConsumer(store, journal, [{
    kind: "note",
    validate: payload => Boolean(payload && typeof payload.value === "string"),
    apply: async () => { applied++; }
  }]);
  const result = await consume("cursor-no-approval-project", "remote-writer");
  assert.equal(result.cursorRecovery.plan.proposedRebuildCount, 1);
  assert.deepEqual(result.cursorRecovery.applications, []);
  assert.equal(result.blockedByJournalIntegrity, true);
  assert.equal(result.replay, undefined);
  assert.equal(applied, 0);
  assert.equal(await journal.getLastSequence("cursor-no-approval-project", "remote-writer"), 0);
  journal.close();
});

test("la sincronización protegida repara un cursor solo tras aprobación y luego reanuda replay", async () => {
  const databaseName = "recovery-cursor-approved-" + Math.random().toString(36).slice(2);
  const journal = createJournal(databaseName);
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "cursor-approved-1", projectId: "cursor-approved-project",
    writerId: "remote-writer", sequence: 1, kind: "note", payload: { value: "approved" }
  });
  await journal.accept(envelope);
  await removeWriterCursor(databaseName, "cursor-approved-project", "remote-writer");
  const approved = [];
  let applied = 0;
  const store = {
    loadNarrativeReferenceRepairPending: async () => [],
    appendNarrativeReferenceRepairAudit: async () => {},
    deleteNarrativeReferenceRepairPending: async () => {}
  };
  const consume = createRecoveryFirstNarrativeSyncConsumer(store, journal, [{
    kind: "note",
    validate: payload => Boolean(payload && typeof payload.value === "string"),
    apply: async () => { applied++; }
  }], {}, {
    approve: proposal => {
      approved.push(proposal);
      return true;
    }
  });
  const result = await consume("cursor-approved-project", "remote-writer");
  assert.equal(approved.length, 1);
  assert.equal(approved[0].lastOperationId, "cursor-approved-1");
  assert.deepEqual(result.cursorRecovery.applications.map(item => item.status), ["applied"]);
  assert.equal(result.blockedByJournalIntegrity, false);
  assert.deepEqual(result.replay, { processed: 1, remaining: 0 });
  assert.equal(applied, 1);
  assert.equal(await journal.getLastSequence("cursor-approved-project", "remote-writer"), 1);
  journal.close();
});



test("Web Locks evita replay concurrente en otra pestaña sin ejecutar handlers", async () => {
  const journal = createJournal();
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "web-lock-busy-1", projectId: "web-lock-project",
    writerId: "writer-lock", sequence: 1, kind: "note", payload: { value: "x" }
  });
  await journal.accept(envelope);
  let applied = 0;
  let requestedName = "";
  const lockManager = {
    request: async (name, _options, callback) => {
      requestedName = name;
      return callback(null);
    }
  };
  const result = await replayPendingNarrativeSyncOperations(
    journal, "web-lock-project", async () => { applied++; }, "writer-lock", lockManager
  );
  assert.equal(requestedName, "motor-literario:narrative-sync:web-lock-project");
  assert.deepEqual(result, {
    processed: 0, remaining: 1, failure: "consumer-already-running"
  });
  assert.equal(applied, 0);
  journal.close();
});

test("fallo del coordinador Web Locks bloquea replay sin fallback inseguro", async () => {
  const journal = createJournal();
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "web-lock-error-1", projectId: "web-lock-error-project",
    writerId: "writer-lock", sequence: 1, kind: "note", payload: { value: "x" }
  });
  await journal.accept(envelope);
  let applied = 0;
  const result = await replayPendingNarrativeSyncOperations(
    journal, "web-lock-error-project", async () => { applied++; }, "writer-lock",
    { request: async () => { throw new Error("lock backend unavailable"); } }
  );
  assert.deepEqual(result, {
    processed: 0, remaining: 1, failure: "consumer-lock-failed"
  });
  assert.equal(applied, 0);
  journal.close();
});

test("Web Locks mantiene la exclusión durante el procesamiento y libera al terminar", async () => {
  const journal = createJournal();
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "web-lock-success-1", projectId: "web-lock-success-project",
    writerId: "writer-lock", sequence: 1, kind: "note", payload: { value: "x" }
  });
  await journal.accept(envelope);
  let lockHeld = false;
  const lockManager = {
    request: async (_name, options, callback) => {
      assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
      lockHeld = true;
      try { return await callback({ name: "test-lock" }); }
      finally { lockHeld = false; }
    }
  };
  const result = await replayPendingNarrativeSyncOperations(
    journal, "web-lock-success-project",
    async () => { assert.equal(lockHeld, true); },
    "writer-lock", lockManager
  );
  assert.deepEqual(result, { processed: 1, remaining: 0 });
  assert.equal(lockHeld, false);
  journal.close();
});

