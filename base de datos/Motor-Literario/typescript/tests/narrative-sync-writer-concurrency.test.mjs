import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createNarrativeSyncOperationEnvelope,
  IndexedDbNarrativeSyncJournal,
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
