import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbProjectStore } from "../dist/motor-literario.js";

const DATABASE_NAME = "motor-literario-local";
const projectId = "indexeddb-narrative-repair-pending";

function openDatabase(version) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("No se pudo abrir la base de prueba."));
    request.onblocked = () => reject(new Error("La apertura de la base de prueba quedó bloqueada."));
  });
}

function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("No se pudo limpiar IndexedDB."));
    request.onblocked = () => reject(new Error("La limpieza de IndexedDB quedó bloqueada."));
  });
}

function pendingEntry(appliedAt = 100) {
  return {
    projectId,
    operationId: [
      "reference-repair", projectId, "relation", "relation-1",
      "fromEntityId", "entity-old", "entity-new"
    ].join("|"),
    issueCode: "missing-relation-entity",
    recordType: "relation",
    recordId: "relation-1",
    referenceField: "fromEntityId",
    missingReferenceId: "entity-old",
    replacementEntityId: "entity-new",
    appliedAt
  };
}

test("la migración 26→28 crea los almacenes de auditoría e intenciones pendientes y conserva reintentos", async () => {
  globalThis.indexedDB = new IDBFactory();
  await deleteDatabase();

  // Simula una instalación existente que aún usa el esquema 26.
  const legacy = await openDatabase(26);
  legacy.close();

  const store = new IndexedDbProjectStore();
  try {
    await store.saveNarrativeReferenceRepairPending(pendingEntry(100));
    // Un reintento de la misma operación puede tener otra marca temporal.
    await store.saveNarrativeReferenceRepairPending(pendingEntry(200));

    const loaded = await store.loadNarrativeReferenceRepairPending(projectId);
    assert.deepEqual(loaded, [pendingEntry(100)]);

    await assert.rejects(
      store.saveNarrativeReferenceRepairPending({
        ...pendingEntry(300),
        replacementEntityId: "entity-different"
      }),
      /ID de la intención no coincide/
    );

    await store.close();
    const reopened = new IndexedDbProjectStore();
    try {
      assert.deepEqual(
        await reopened.loadNarrativeReferenceRepairPending(projectId),
        [pendingEntry(100)]
      );
      await reopened.deleteNarrativeReferenceRepairPending(
        projectId,
        pendingEntry().operationId
      );
      assert.deepEqual(await reopened.loadNarrativeReferenceRepairPending(projectId), []);
    } finally {
      await reopened.close();
    }

    const upgraded = await openDatabase(28);
    try {
      assert.equal(upgraded.version, 28);
      assert.ok(upgraded.objectStoreNames.contains("narrative-reference-repair-audits"));
      assert.ok(upgraded.objectStoreNames.contains("narrative-reference-repair-pending"));
      assert.deepEqual(
        Array.from(upgraded.transaction(
          "narrative-reference-repair-pending"
        ).objectStore("narrative-reference-repair-pending").indexNames),
        ["by-project"]
      );
    } finally {
      upgraded.close();
    }
  } finally {
    await store.close();
    await deleteDatabase();
  }
});


test("dos instancias IndexedDB conservan idempotencia durable de intención y auditoría", async () => {
  globalThis.indexedDB = new IDBFactory();
  await deleteDatabase();
  const first = new IndexedDbProjectStore();
  const second = new IndexedDbProjectStore();
  try {
    const pending = pendingEntry(500);
    const audit = {
      operationId: pending.operationId,
      operation: "narrative-reference-repair",
      projectId,
      recordType: "relation",
      recordId: "relation-1",
      referenceField: "fromEntityId",
      before: "entity-old",
      after: "entity-new",
      missingReferenceId: "entity-old",
      replacementEntityId: "entity-new",
      appliedAt: 500
    };

    await Promise.all([
      first.saveNarrativeReferenceRepairPending(pending),
      second.saveNarrativeReferenceRepairPending(pending)
    ]);
    await Promise.all([
      first.appendNarrativeReferenceRepairAudit(audit),
      second.appendNarrativeReferenceRepairAudit(audit)
    ]);

    assert.deepEqual(await first.loadNarrativeReferenceRepairPending(projectId), [pending]);
    assert.deepEqual(await second.loadNarrativeReferenceRepairPending(projectId), [pending]);
    assert.deepEqual(await first.loadNarrativeReferenceRepairAudits(projectId), [audit]);
    assert.deepEqual(await second.loadNarrativeReferenceRepairAudits(projectId), [audit]);

    await Promise.all([
      first.deleteNarrativeReferenceRepairPending(projectId, pending.operationId),
      second.deleteNarrativeReferenceRepairPending(projectId, pending.operationId)
    ]);
    assert.deepEqual(await first.loadNarrativeReferenceRepairPending(projectId), []);
  } finally {
    await first.close();
    await second.close();
    await deleteDatabase();
  }
});
