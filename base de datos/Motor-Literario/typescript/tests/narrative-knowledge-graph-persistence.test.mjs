import test from "node:test";
import assert from "node:assert/strict";
import {
  createNarrativeKnowledgeGraphSnapshot,
  persistNarrativeKnowledgeGraphSnapshot
} from "../dist/motor-literario.js";

function createMemoryStore() {
  const tables = {
    entities: new Map(), relations: new Map(), events: new Map(),
    ideas: new Map(), assertions: new Map()
  };
  const copy = value => structuredClone(value);
  const methods = {};
  for (const name of Object.keys(tables)) {
    const table = tables[name];
    methods["load" + name[0].toUpperCase() + name.slice(1)] = async projectId =>
      [...table.values()].filter(x => x.projectId === projectId).map(copy);
    const saveName = "save" + name[0].toUpperCase() + name.slice(1) + "IfUnchanged";
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
  assert.ok(mara.evidence.some(x => x.documentId === "chapter-b"));
});

test("rechaza un store sin las operaciones CAS requeridas", async () => {
  const snapshot = createNarrativeKnowledgeGraphSnapshot("novel-a", []);
  await assert.rejects(
    persistNarrativeKnowledgeGraphSnapshot({}, snapshot),
    /persistencia CAS completa/u
  );
});
