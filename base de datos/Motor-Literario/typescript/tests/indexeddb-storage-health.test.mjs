import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbProjectStore } from "../dist/motor-literario.js";

globalThis.indexedDB = new IDBFactory();

test("el diagnóstico de IndexedDB cuenta registros sin mutar el manuscrito", async () => {
  const store = new IndexedDbProjectStore();
  const projectId = "storage-health-project";
  const documentId = "chapter-1";

  await store.saveDocument({
    projectId,
    documentId,
    text: "Una historia persistida.",
    revision: 3,
    sequence: 7,
    updatedAt: 1234
  });

  const before = await store.loadDocument(projectId, documentId);
  const report = await store.inspectStorageHealth();
  const after = await store.loadDocument(projectId, documentId);

  assert.equal(report.databaseName, "motor-literario-local");
  assert.equal(report.databaseVersion, 24);
  assert.equal(report.recordCounts.documents, 1);
  assert.equal(report.recordCounts.changes, 0);
  assert.deepEqual(after, before);
  assert.equal(typeof report.usageBytes === "number" || report.usageBytes === null, true);
  assert.equal(typeof report.quotaBytes === "number" || report.quotaBytes === null, true);
  assert.equal(
    typeof report.persistentStorage === "boolean" || report.persistentStorage === null,
    true
  );
});

test("la solicitud de almacenamiento persistente devuelve false cuando el navegador no ofrece la API", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {}
    });
    const store = new IndexedDbProjectStore();
    assert.equal(await store.requestPersistentStorage(), false);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
});


test("el diagnóstico informa cuota estimada y respeta la decisión del navegador", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        storage: {
          estimate: async () => ({ usage: 128, quota: 1024 }),
          persisted: async () => false,
          persist: async () => true
        }
      }
    });
    const store = new IndexedDbProjectStore();
    const report = await store.inspectStorageHealth();
    assert.equal(report.usageBytes, 128);
    assert.equal(report.quotaBytes, 1024);
    assert.equal(report.persistentStorage, false);
    assert.equal(await store.requestPersistentStorage(), true);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
});
