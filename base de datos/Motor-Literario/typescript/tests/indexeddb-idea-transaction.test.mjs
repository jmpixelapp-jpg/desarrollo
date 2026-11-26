import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { HostEngineApi, IndexedDbProjectStore } from "../dist/motor-literario.js";

globalThis.indexedDB = new IDBFactory();

const DATABASE_NAME = "motor-literario-local";
const projectId = "indexeddb-idea-transaction";

const idea = (extra = {}) => ({
  projectId,
  id: "idea-source",
  text: "La memoria transforma la ausencia.",
  status: "IDEA",
  originDocumentId: "chapter-1",
  sourceProjectName: "Libro transaccional",
  evidence: [],
  relatedEntityIds: [],
  relatedIdeaIds: [],
  statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }],
  ...extra
});

const entity = {
  projectId,
  id: "entity-memory",
  kind: "character",
  canonicalName: "Memoria",
  normalizedName: "memoria",
  aliases: [],
  evidence: [],
  firstSeenAt: 1,
  lastSeenAt: 1,
  extractionVersion: 1
};

function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("No se pudo limpiar IndexedDB."));
    request.onblocked = () => reject(new Error("La limpieza de IndexedDB quedó bloqueada."));
  });
}

test("IndexedDB revierte una idea inválida y conserva CAS frente a instantáneas obsoletas", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  const original = idea();

  try {
    await store.saveIdea(original);

    await assert.rejects(
      store.saveIdeaIfUnchanged(
        idea({ relatedEntityIds: ["entity-missing"] }),
        original
      ),
      /Referencia narrativa inválida/
    );

    assert.deepEqual(await store.loadIdeas(projectId), [original]);

    await store.saveEntity(entity);
    const linked = idea({ relatedEntityIds: [entity.id] });
    await store.saveIdeaIfUnchanged(linked, original);
    assert.deepEqual(await store.loadIdeas(projectId), [linked]);

    await assert.rejects(
      store.saveIdeaIfUnchanged(
        idea({ text: "Una edición obsoleta intenta imponerse." }),
        original
      ),
      /cambió en otra instancia/
    );
    assert.deepEqual(await store.loadIdeas(projectId), [linked]);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});


test("IndexedDB serializa dos CAS concurrentes sobre la misma idea y confirma solo uno", async () => {
  await deleteDatabase();
  const firstStore = new IndexedDbProjectStore();
  const secondStore = new IndexedDbProjectStore();
  const original = idea();

  try {
    await firstStore.saveIdea(original);
    const first = idea({ text: "Primera edición concurrente." });
    const second = idea({ text: "Segunda edición concurrente." });

    const outcomes = await Promise.allSettled([
      firstStore.saveIdeaIfUnchanged(first, original),
      secondStore.saveIdeaIfUnchanged(second, original)
    ]);

    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(result => result.status === "rejected").length, 1);
    const rejected = outcomes.find(result => result.status === "rejected");
    assert.match(String(rejected.reason?.message), /cambió en otra instancia/);

    const [durable] = await firstStore.loadIdeas(projectId);
    assert.ok([first.text, second.text].includes(durable.text));
  } finally {
    await Promise.all([firstStore.close(), secondStore.close()]);
    await deleteDatabase();
  }
});

test("IndexedDB valida destinos idea dentro del proyecto y revierte referencias inválidas", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  const original = idea();

  const relatedIdea = idea({
    id: "idea-related",
    text: "La ausencia conserva una forma.",
    relatedIdeaIds: []
  });
  const foreignIdea = idea({
    projectId: "indexeddb-idea-transaction-foreign",
    id: relatedIdea.id,
    text: "Mismo identificador, otro proyecto.",
    relatedIdeaIds: []
  });

  try {
    await store.saveIdea(original);
    await store.saveEntity(entity);

    await assert.rejects(
      store.saveIdeaIfUnchanged(
        idea({ relatedEntityIds: [entity.id], relatedIdeaIds: ["idea-missing"] }),
        original
      ),
      /Referencia narrativa inválida/
    );
    assert.deepEqual(await store.loadIdeas(projectId), [original]);

    await store.saveIdea(foreignIdea);
    await assert.rejects(
      store.saveIdeaIfUnchanged(
        idea({ relatedIdeaIds: [relatedIdea.id] }),
        original
      ),
      /Referencia narrativa inválida/
    );
    assert.deepEqual(await store.loadIdeas(projectId), [original]);

    await store.saveIdea(relatedIdea);
    const linked = idea({
      relatedEntityIds: [entity.id],
      relatedIdeaIds: [relatedIdea.id]
    });
    await store.saveIdeaIfUnchanged(linked, original);
    assert.deepEqual(
      (await store.loadIdeas(projectId)).find(record => record.id === original.id),
      linked
    );
  } finally {
    await store.close();
    await deleteDatabase();
  }
});


test("IndexedDB archiva la biblioteca personal y su operación outbox en una sola transacción", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  const writerId = "writer-library-archive";
  const archivedAt = 55;
  const syncOperation = {
    operationId: "personal-library-archive-operation",
    projectId,
    deviceId: "device-library-archive",
    kind: "personal-idea-archive",
    payload: JSON.stringify({ archive: "pending" }),
    createdAt: archivedAt
  };

  try {
    await store.saveIdea(idea());
    const entries = await store.archiveUnincorporatedIdeas(
      projectId, writerId, "Libro transaccional", archivedAt, syncOperation
    );
    assert.deepEqual(entries.map(entry => entry.idea.id), ["idea-source"]);
    assert.deepEqual(await store.loadIdeas(projectId), []);

    const library = await store.loadPersonalIdeas(writerId);
    assert.deepEqual(library.map(entry => entry.idea.id), ["idea-source"]);
    assert.equal(library[0].context.version, 1);

    const receipt = await store.loadProjectFinalizationReceipt(writerId, projectId);
    assert.deepEqual(receipt.archivedIdeaIds, ["idea-source"]);
    assert.equal(receipt.archiveChecksum.startsWith("fnv1a64:"), true);

    const [pending] = await store.loadPendingSyncOperations(projectId);
    assert.equal(pending.operationId, syncOperation.operationId);
    assert.equal(pending.kind, "personal-idea-archive");
    assert.equal(pending.sequence, 1);
    assert.equal(pending.deviceId, syncOperation.deviceId);
    assert.deepEqual(JSON.parse(pending.payload), {
      writerId,
      sourceProjectName: "Libro transaccional",
      archivedAt,
      archivedIdeaIds: ["idea-source"],
      archiveChecksum: receipt.archiveChecksum
    });
    assert.equal(await store.loadLastSyncOperationSequence(projectId, syncOperation.deviceId), 1);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});

test("IndexedDB revierte el archivo y la outbox si los IDs esperados ya no coinciden", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  const writerId = "writer-library-conflict";
  const syncOperation = {
    operationId: "personal-library-conflict-operation",
    projectId,
    deviceId: "device-library-conflict",
    kind: "personal-idea-archive",
    payload: JSON.stringify({ archive: "pending" }),
    createdAt: 66
  };

  try {
    await store.saveIdea(idea());
    await assert.rejects(
      store.archiveUnincorporatedIdeas(
        projectId, writerId, "Libro transaccional", 66, syncOperation, []
      ),
      /conjunto de ideas del libro cambió/u
    );

    assert.deepEqual(await store.loadIdeas(projectId), [idea()]);
    assert.deepEqual(await store.loadPersonalIdeas(writerId), []);
    assert.equal(await store.loadProjectFinalizationReceipt(writerId, projectId), undefined);
    assert.deepEqual(await store.loadPendingSyncOperations(projectId), []);
    assert.equal(await store.loadLastSyncOperationSequence(projectId, syncOperation.deviceId), 0);
  } finally {
    await store.close();
    await deleteDatabase();
  }
});


test("HostEngineApi sincroniza la finalización de libro y biblioteca personal con su identidad de dispositivo", async () => {
  await deleteDatabase();
  const store = new IndexedDbProjectStore();
  const writerId = "writer-host-library";
  const deviceId = "device-host-library";
  const api = new HostEngineApi({ store });
  api.initializeProject({
    projectId, projectName: "Libro transaccional",
    writerId, deviceId
  });

  try {
    await store.saveIdea(idea());
    const entries = await api.archiveUnincorporatedIdeas();
    assert.deepEqual(entries.map(entry => entry.idea.id), ["idea-source"]);

    const [operation] = await store.loadPendingSyncOperations(projectId);
    assert.equal(operation.kind, "personal-idea-archive");
    assert.equal(operation.deviceId, deviceId);
    assert.equal(operation.sequence, 1);
    const payload = JSON.parse(operation.payload);
    assert.equal(payload.writerId, writerId);
    assert.equal(payload.sourceProjectName, "Libro transaccional");
    assert.deepEqual(payload.archivedIdeaIds, ["idea-source"]);
    assert.equal(typeof payload.archiveChecksum, "string");
  } finally {
    api.dispose();
    await store.close();
    await deleteDatabase();
  }
});
