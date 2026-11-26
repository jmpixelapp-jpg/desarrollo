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

test("marca como histórica una afirmación del documento reemplazado sin alterar otros documentos", async () => {
  const { store, tables } = createMemoryStore();
  const initial = createNarrativeKnowledgeGraphSnapshot("novel-a", [
    { documentId: "chapter-a", revision: 1, text: "Personaje Mara. Mara tiene 24 años." },
    { documentId: "chapter-b", revision: 1, text: "Personaje Mara. Mara es la reina." }
  ], { now: 100 });
  await persistNarrativeKnowledgeGraphSnapshot(store, initial);

  const update = createNarrativeKnowledgeGraphSnapshot("novel-a", [
    { documentId: "chapter-a", revision: 2, text: "Personaje Mara vuelve a casa." }
  ], { now: 200 });
  await persistNarrativeKnowledgeGraphSnapshot(store, update);

  const assertions = [...tables.assertions.values()];
  const age = assertions.find(item => item.attribute === "age");
  const role = assertions.find(item => item.attribute === "role");
  assert.ok(age);
  assert.equal(age.evidence.documentId, "chapter-a");
  assert.equal(age.evidence.status, "stale");
  assert.ok(role);
  assert.equal(role.evidence.documentId, "chapter-b");
  assert.equal(role.evidence.status, undefined);
});
