import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbProjectStore } from "../dist/motor-literario.js";

globalThis.indexedDB = new IDBFactory();
const { IndexedDbProjectStore } = await import("../dist/motor-literario.js");

test("diagnostica IndexedDB sin mutar datos y respeta las APIs opcionales del navegador", async () => {
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
  const baseline = await store.inspectStorageHealth();
  const after = await store.loadDocument(projectId, documentId);

  assert.equal(baseline.databaseName, "motor-literario-local");
  assert.equal(baseline.databaseVersion, 25);
  assert.equal(baseline.recordCounts["sync-outbox"], 0);
  assert.equal(baseline.recordCounts["sync-device-sequences"], 0);
  assert.equal(baseline.recordCounts.documents, 1);
  assert.equal(baseline.recordCounts.changes, 0);
  assert.deepEqual(after, before);

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
    const report = await store.inspectStorageHealth();
    assert.equal(report.usageBytes, 128);
    assert.equal(report.quotaBytes, 1024);
    assert.equal(report.persistentStorage, false);
    assert.equal(await store.requestPersistentStorage(), true);

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {}
    });
    assert.equal(await store.requestPersistentStorage(), false);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
});
