import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";

globalThis.indexedDB = new IDBFactory();
const { IndexedDbProjectStore } = await import("../dist/motor-literario.js");

function manifest(projectId, documentId, generation, overrides = {}) {
  return {
    projectId, documentId, revision: generation, generation, status: "active",
    entityIds: ["entity-a"], relationIds: [], eventIds: [], ideaIds: [], assertionIds: [],
    updatedAt: generation * 100, ...overrides
  };
}

test("manifiesto documental: CAS monotónico, aislamiento por proyecto y tombstone", async () => {
  const store = new IndexedDbProjectStore();
  const project = "manifest-" + randomUUID();
  const doc = "chapter-" + randomUUID();
  try {
    const first = manifest(project, doc, 1);
    await store.saveNarrativeDocumentProjectionManifestIfUnchanged(first);
    assert.deepEqual(await store.loadNarrativeDocumentProjectionManifest(project, doc), first);
    assert.deepEqual(await store.loadNarrativeDocumentProjectionManifests(project), [first]);
    await assert.rejects(
      store.saveNarrativeDocumentProjectionManifestIfUnchanged(manifest(project, doc, 2), 0),
      /CAS|aborto/u
    );
    const second = manifest(project, doc, 2, { entityIds: ["entity-b"] });
    await store.saveNarrativeDocumentProjectionManifestIfUnchanged(second, 1);
    assert.deepEqual(await store.loadNarrativeDocumentProjectionManifest(project, doc), second);
    assert.equal(await store.loadNarrativeDocumentProjectionManifest(project + "-other", doc), undefined);

    const tombstone = manifest(project, doc, 3, {
      status: "deleted", entityIds: [], updatedAt: 300
    });
    await store.saveNarrativeDocumentProjectionManifestIfUnchanged(tombstone, 2);
    assert.deepEqual(await store.loadNarrativeDocumentProjectionManifest(project, doc), tombstone);
    assert.deepEqual(await store.loadNarrativeDocumentProjectionManifests(project), [tombstone]);
    await assert.rejects(
      store.saveNarrativeDocumentProjectionManifestIfUnchanged(
        manifest(project, doc, 4, { status: "deleted", entityIds: ["entity-a"] }), 3
      ),
      /tombstone/u
    );
  } finally {
    await store.close();
  }
});

test("dos escritores concurrentes no pueden confirmar la misma generación", async () => {
  const storeA = new IndexedDbProjectStore();
  const storeB = new IndexedDbProjectStore();
  const project = "manifest-race-" + randomUUID();
  const doc = "chapter-" + randomUUID();
  try {
    await storeA.saveNarrativeDocumentProjectionManifestIfUnchanged(manifest(project, doc, 1));
    const outcomes = await Promise.allSettled([
      storeA.saveNarrativeDocumentProjectionManifestIfUnchanged(manifest(project, doc, 2), 1),
      storeB.saveNarrativeDocumentProjectionManifestIfUnchanged(manifest(project, doc, 2, { entityIds: ["other"] }), 1)
    ]);
    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(result => result.status === "rejected").length, 1);
    const current = await storeA.loadNarrativeDocumentProjectionManifest(project, doc);
    assert.equal(current.generation, 2);
  } finally {
    await storeA.close();
    await storeB.close();
  }
});
