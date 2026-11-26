import test from "node:test";
import assert from "node:assert/strict";
import {
  createNarrativeKnowledgeGraphSnapshot,
  persistNarrativeKnowledgeGraphSnapshot,
  createNarrativeDocumentProjectionManifest,
  createNarrativeDocumentProjectionTombstone,
  commitNarrativeDocumentProjectionManifest
} from "../dist/motor-literario.js";

function createMemoryStore() {
  const tables = {
    entities: new Map(), relations: new Map(), events: new Map(),
    ideas: new Map(), assertions: new Map()
  };
  const copy = value => structuredClone(value);
  const methods = {};
  const contracts = [
    ["entities", "loadEntities", "saveEntityIfUnchanged"],
    ["relations", "loadRelations", "saveRelationIfUnchanged"],
    ["events", "loadEvents", "saveEventIfUnchanged"],
    ["ideas", "loadIdeas", "saveIdeaIfUnchanged"],
    ["assertions", "loadAssertions", "saveAssertionIfUnchanged"]
  ];
  for (const [tableName, loadName, saveName] of contracts) {
    const table = tables[tableName];
    methods[loadName] = async projectId =>
      [...table.values()].filter(x => x.projectId === projectId).map(copy);
    methods[saveName] = async (next, expected) => {
      const current = table.get(next.id);
      assert.deepEqual(current, expected, "la escritura debe respetar compare-and-swap");
      table.set(next.id, copy(next));
    };
  }
  return { store: methods, tables };
}

test("persiste el snapshot con CAS y el segundo guardado es idempotente", async () => {
  const snapshot = createNarrativeKnowledgeGraphSnapshot("novel-a", [
    { documentId: "chapter-a", revision: 1, text: "personaje Mara aparece. Mara tiene 24 años." },
    { documentId: "chapter-b", revision: 1, text: "personaje Leo aparece." }
  ], { now: 100 });
  const { store, tables } = createMemoryStore();

  const first = await persistNarrativeKnowledgeGraphSnapshot(store, snapshot);
  assert.equal(first.saved.entities, 2);
  assert.equal(first.saved.assertions, 1);
  assert.equal(tables.entities.size, 2);

  const second = await persistNarrativeKnowledgeGraphSnapshot(store, snapshot);
  assert.equal(second.saved.entities, 0);
  assert.equal(second.saved.assertions, 0);
  assert.equal(second.reused.entities, 2);
  assert.equal(second.reused.assertions, 1);
});

test("conserva evidencia de otros documentos al fusionar una proyección", async () => {
  const { store, tables } = createMemoryStore();
  const initial = createNarrativeKnowledgeGraphSnapshot("novel-a", [
    { documentId: "chapter-a", revision: 1, text: "personaje Mara aparece." },
    { documentId: "chapter-b", revision: 1, text: "personaje Mara regresa." }
  ], { now: 100 });
  await persistNarrativeKnowledgeGraphSnapshot(store, initial);

  const next = createNarrativeKnowledgeGraphSnapshot("novel-a", [
    { documentId: "chapter-b", revision: 2, text: "personaje Mara vuelve." }
  ], { now: 200 });
  await persistNarrativeKnowledgeGraphSnapshot(store, next);

  const mara = [...tables.entities.values()].find(x => x.canonicalName === "Mara");
  assert.ok(mara.evidence.some(x => x.documentId === "chapter-a"));
  assert.ok(mara.evidence.some(x => x.documentId === "chapter-b" && x.revision === 2));
  assert.equal(mara.evidence.some(x => x.documentId === "chapter-b" && x.revision === 1), false);
});

test("rechaza un store sin las operaciones CAS requeridas", async () => {
  const snapshot = createNarrativeKnowledgeGraphSnapshot("novel-a", []);
  await assert.rejects(
    persistNarrativeKnowledgeGraphSnapshot({}, snapshot),
    /persistencia CAS completa/u
  );
});

test("reemplaza la evidencia de una revisión por la vigente del mismo documento", async () => {
  const { store, tables } = createMemoryStore();
  const first = createNarrativeKnowledgeGraphSnapshot("novel-a", [
    { documentId: "chapter-a", revision: 1, text: "personaje Mara aparece." },
    { documentId: "chapter-b", revision: 1, text: "personaje Mara regresa." }
  ], { now: 100 });
  await persistNarrativeKnowledgeGraphSnapshot(store, first);

  const revised = createNarrativeKnowledgeGraphSnapshot("novel-a", [
    { documentId: "chapter-a", revision: 2, text: "personaje Mara desaparece." },
    { documentId: "chapter-b", revision: 1, text: "personaje Mara regresa." }
  ], { now: 200 });
  await persistNarrativeKnowledgeGraphSnapshot(store, revised);

  const mara = [...tables.entities.values()].find(x => x.canonicalName === "Mara");
  assert.ok(mara.evidence.some(x => x.documentId === "chapter-a" && x.revision === 2));
  assert.equal(mara.evidence.some(x => x.documentId === "chapter-a" && x.revision === 1), false);
  assert.ok(mara.evidence.some(x => x.documentId === "chapter-b" && x.revision === 1));
});

test("construye manifiestos desde una contribución y tombstones explícitos", () => {
  const snapshot = createNarrativeKnowledgeGraphSnapshot("novel-a", [
    { documentId: "chapter-a", revision: 7, text: "personaje Mara aparece." },
    { documentId: "chapter-b", revision: 3, text: "personaje Leo aparece." }
  ], { now: 100 });
  const manifest = createNarrativeDocumentProjectionManifest(snapshot, "chapter-a", 4, 200);
  assert.equal(manifest.projectId, "novel-a");
  assert.equal(manifest.revision, 7);
  assert.equal(manifest.generation, 4);
  assert.equal(manifest.status, "active");
  assert.ok(manifest.entityIds.length > 0);
  assert.deepEqual(manifest.relationIds, []);

  const tombstone = createNarrativeDocumentProjectionTombstone("novel-a", "chapter-a", 8, 5, 300);
  assert.equal(tombstone.status, "deleted");
  assert.equal(tombstone.revision, 8);
  assert.deepEqual(tombstone.entityIds, []);
  assert.deepEqual(tombstone.assertionIds, []);
  assert.throws(
    () => createNarrativeDocumentProjectionManifest(snapshot, "missing", 1, 200),
    /no forma parte/u
  );
});

test("commit de manifiestos rechaza revisiones antiguas y divergencias", async () => {
  let current;
  const store = {
    async loadNarrativeDocumentProjectionManifest(projectId, documentId) {
      return current && current.projectId === projectId && current.documentId === documentId
        ? structuredClone(current) : undefined;
    },
    async saveNarrativeDocumentProjectionManifestIfUnchanged(next, expectedGeneration) {
      assert.equal(current?.generation, expectedGeneration);
      assert.equal(next.generation, (expectedGeneration ?? 0) + 1);
      current = structuredClone(next);
    }
  };
  const base = {
    projectId: "novel-manifest", documentId: "chapter-1", revision: 1,
    generation: 1, status: "active", entityIds: ["e1"], relationIds: [],
    eventIds: [], ideaIds: [], assertionIds: [], updatedAt: 100
  };
  const first = await commitNarrativeDocumentProjectionManifest(store, base);
  assert.equal(first.manifest.generation, 1);
  assert.equal(first.reused, false);

  const retry = await commitNarrativeDocumentProjectionManifest(store, {
    ...base, generation: 99, updatedAt: 999
  });
  assert.equal(retry.reused, true);
  assert.equal(retry.manifest.generation, 1);

  await assert.rejects(
    commitNarrativeDocumentProjectionManifest(store, { ...base, revision: 0 }),
    /obsoleta/u
  );
  await assert.rejects(
    commitNarrativeDocumentProjectionManifest(store, { ...base, entityIds: ["e2"] }),
    /divergentes/u
  );

  const next = await commitNarrativeDocumentProjectionManifest(store, {
    ...base, revision: 2, generation: 1, entityIds: ["e2"], updatedAt: 200
  });
  assert.equal(next.manifest.generation, 2);
  assert.equal(next.manifest.revision, 2);
});
