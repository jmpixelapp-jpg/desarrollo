import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createNarrativeSyncOperationEnvelope,
  IndexedDbNarrativeSyncJournal,
  planNarrativeSyncJournalCursorRecovery,
  replayPendingNarrativeSyncOperations
} from "../dist/motor-literario.js";

test("replays de escritores distintos avanzan en paralelo dentro del mismo proyecto", async () => {
  const journal = new IndexedDbNarrativeSyncJournal({
    databaseName: "narrative-sync-writer-parallel-" + Math.random().toString(36).slice(2)
  });
  for (const [writerId, operationId] of [
    ["writer-a", "parallel-a"], ["writer-b", "parallel-b"]
  ]) {
    const envelope = await createNarrativeSyncOperationEnvelope({
      operationId, projectId: "shared-project", writerId, sequence: 1,
      kind: "test-operation", payload: { writerId }
    });
    await journal.accept(envelope);
  }

  let entered = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const apply = async () => {
    entered++;
    if (entered === 2) release();
    await gate;
  };

  const [first, second] = await Promise.all([
    replayPendingNarrativeSyncOperations(journal, "shared-project", apply, "writer-a"),
    replayPendingNarrativeSyncOperations(journal, "shared-project", apply, "writer-b")
  ]);

  assert.equal(entered, 2, "ambos escritores deben entrar al handler antes de liberar la barrera");
  assert.deepEqual(first, { processed: 1, remaining: 0 });
  assert.deepEqual(second, { processed: 1, remaining: 0 });
  assert.equal((await journal.loadPendingOperations("shared-project")).length, 0);
  journal.close();
});

test("un replay de proyecto completo excluye replays específicos de escritor", async () => {
  const journal = new IndexedDbNarrativeSyncJournal({
    databaseName: "narrative-sync-project-lock-" + Math.random().toString(36).slice(2)
  });
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "project-lock-operation", projectId: "locked-project",
    writerId: "writer-a", sequence: 1, kind: "test-operation", payload: {}
  });
  await journal.accept(envelope);

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const projectReplay = replayPendingNarrativeSyncOperations(
    journal, "locked-project", async () => { entered(); await gate; }
  );
  await started;
  const writerReplay = await replayPendingNarrativeSyncOperations(
    journal, "locked-project", async () => { throw new Error("no debe ejecutarse"); }, "writer-a"
  );
  assert.equal(writerReplay.failure, "consumer-already-running");
  assert.equal(writerReplay.remaining, 1);
  release();
  assert.deepEqual(await projectReplay, { processed: 1, remaining: 0 });
  journal.close();
});


function openJournalDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function mutateStoredCursor(databaseName, projectId, writerId, mutate) {
  const database = await openJournalDatabase(databaseName);
  await new Promise((resolve, reject) => {
    const transaction = database.transaction("writer-cursors", "readwrite");
    const store = transaction.objectStore("writer-cursors");
    const request = store.get([projectId, writerId]);
    request.onsuccess = () => {
      const current = request.result;
      if (current) store.put(mutate(current));
      else if (mutate === null) store.delete([projectId, writerId]);
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}

test("aplica una propuesta de cursor ausente y el reintento es idempotente", async () => {
  const databaseName = "narrative-sync-cursor-recovery-" + Math.random().toString(36).slice(2);
  const journal = new IndexedDbNarrativeSyncJournal({ databaseName });
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "recover-cursor-op-1", projectId: "recover-cursor-project",
    writerId: "writer-recover", sequence: 1, kind: "note", payload: { value: 1 }
  });
  await journal.accept(envelope);
  await mutateStoredCursor(databaseName, "recover-cursor-project", "writer-recover", () => null);
  // El helper de mutación elimina el registro explícitamente para simular pérdida de cursor.
  const database = await openJournalDatabase(databaseName);
  await new Promise((resolve, reject) => {
    const transaction = database.transaction("writer-cursors", "readwrite");
    transaction.objectStore("writer-cursors").delete(["recover-cursor-project", "writer-recover"]);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();

  const plan = await planNarrativeSyncJournalCursorRecovery(journal, "recover-cursor-project");
  const proposal = plan.items[0].proposal;
  assert.equal(plan.proposedRebuildCount, 1);
  assert.deepEqual(await journal.applyCursorRecoveryProposal(proposal), {
    status: "applied", writerId: "writer-recover",
    lastSequence: 1, lastOperationId: "recover-cursor-op-1"
  });
  assert.deepEqual(await journal.applyCursorRecoveryProposal(proposal), {
    status: "already-consistent", writerId: "writer-recover",
    lastSequence: 1, lastOperationId: "recover-cursor-op-1"
  });
  assert.equal(await journal.getLastSequence("recover-cursor-project", "writer-recover"), 1);
  journal.close();
});

test("rechaza una propuesta obsoleta si el diario avanzó después de planificar", async () => {
  const journal = new IndexedDbNarrativeSyncJournal({
    databaseName: "narrative-sync-cursor-stale-journal-" + Math.random().toString(36).slice(2)
  });
  const first = await createNarrativeSyncOperationEnvelope({
    operationId: "stale-journal-1", projectId: "stale-journal-project",
    writerId: "writer-stale", sequence: 1, kind: "note", payload: { n: 1 }
  });
  await journal.accept(first);
  // Construimos la propuesta de forma consultiva y simulamos la pérdida del cursor.
  const database = await openJournalDatabase("narrative-sync-cursor-stale-journal-" + "");
  database.close();
  const proposal = {
    projectId: "stale-journal-project", writerId: "writer-stale",
    lastSequence: 1, lastOperationId: "stale-journal-1"
  };
  const second = await createNarrativeSyncOperationEnvelope({
    operationId: "stale-journal-2", projectId: "stale-journal-project",
    writerId: "writer-stale", sequence: 2, kind: "note", payload: { n: 2 }
  });
  await journal.accept(second);
  const result = await journal.applyCursorRecoveryProposal(proposal);
  assert.equal(result.status, "rejected");
  assert.ok(["journal-not-complete", "journal-changed"].includes(result.reason));
  journal.close();
});

test("rechaza cambios concurrentes del cursor y no sobrescribe su secuencia", async () => {
  const databaseName = "narrative-sync-cursor-cas-" + Math.random().toString(36).slice(2);
  const journal = new IndexedDbNarrativeSyncJournal({ databaseName });
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "cursor-cas-op-1", projectId: "cursor-cas-project",
    writerId: "writer-cas", sequence: 1, kind: "note", payload: {}
  });
  await journal.accept(envelope);
  const proposal = {
    projectId: "cursor-cas-project", writerId: "writer-cas",
    lastSequence: 1, lastOperationId: "cursor-cas-op-1"
  };
  await mutateStoredCursor(databaseName, "cursor-cas-project", "writer-cas",
    current => ({ ...current, lastSequence: 2, lastOperationId: "newer-operation" }));
  const result = await journal.applyCursorRecoveryProposal(proposal);
  assert.deepEqual(result, { status: "rejected", reason: "cursor-changed" });
  assert.equal(await journal.getLastSequence("cursor-cas-project", "writer-cas"), 2);
  journal.close();
});

test("rechaza diarios con huecos aunque se presente una propuesta formal", async () => {
  const journal = new IndexedDbNarrativeSyncJournal({
    databaseName: "narrative-sync-cursor-gap-" + Math.random().toString(36).slice(2)
  });
  const envelope = await createNarrativeSyncOperationEnvelope({
    operationId: "cursor-gap-op-1", projectId: "cursor-gap-project",
    writerId: "writer-gap", sequence: 1, kind: "note", payload: {}
  });
  await journal.accept(envelope);
  const proposal = {
    projectId: "cursor-gap-project", writerId: "writer-gap",
    lastSequence: 2, lastOperationId: "missing-operation"
  };
  assert.deepEqual(await journal.applyCursorRecoveryProposal(proposal), {
    status: "rejected", reason: "journal-not-complete"
  });
  journal.close();
});
