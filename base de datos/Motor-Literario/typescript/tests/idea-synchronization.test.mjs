import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi } from "../dist/motor-literario.js";

const projectId = "idea-reference-sync";
const projectName = "Libro de sincronización";

const idea = (id, extra = {}) => ({
  projectId, id, text: "La luz conduce a una revelación.", status: "IDEA",
  originDocumentId: "chapter-1", sourceProjectName: projectName,
  evidence: [], relatedEntityIds: [], relatedIdeaIds: [],
  statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 1 }],
  ...extra
});
const entity = (id, name) => ({
  projectId, id, kind: "character", canonicalName: name,
  normalizedName: name.toLocaleLowerCase("es"), aliases: [], evidence: [],
  firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
});

class RacingStore {
  ideas = new Map();
  entities = new Map();
  onNextConflict;
  nextWriteError;
  writes = 0;
  entityReads = 0;

  constructor(ideas = [], entities = []) {
    for (const item of ideas) this.ideas.set(this.key(item), structuredClone(item));
    for (const item of entities) this.entities.set(this.key(item), structuredClone(item));
  }
  key(item) { return item.projectId + ":" + item.id; }
  async saveIdea(item) { this.ideas.set(this.key(item), structuredClone(item)); }
  async loadIdeas(id) {
    return [...this.ideas.values()].filter(x => x.projectId === id).map(x => structuredClone(x));
  }
  async saveEntity(item) { this.entities.set(this.key(item), structuredClone(item)); }
  async loadEntities(id) {
    this.entityReads++;
    return [...this.entities.values()].filter(x => x.projectId === id).map(x => structuredClone(x));
  }
  async saveIdeaIfUnchanged(next, expected) {
    this.writes++;
    const key = this.key(next);
    const current = this.ideas.get(key);
    if (this.onNextConflict) {
      const mutate = this.onNextConflict;
      this.onNextConflict = undefined;
      if (!current) throw new Error("La idea ya no existe en el proyecto.");
      this.ideas.set(key, structuredClone(mutate(structuredClone(current))));
      throw new Error("La idea cambió en otra instancia; actualiza la vista antes de volver a modificarla.");
    }
    if (this.nextWriteError) {
      const error = this.nextWriteError;
      this.nextWriteError = undefined;
      throw error;
    }
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error("La idea cambió en otra instancia; actualiza la vista antes de volver a modificarla.");
    }
    for (const id of next.relatedIdeaIds ?? []) {
      if (id === next.id || !this.ideas.has(next.projectId + ":" + id)) {
        throw new Error("La idea enlaza una idea inexistente o se enlaza a sí misma.");
      }
    }
    for (const id of next.relatedEntityIds ?? []) {
      if (!this.entities.has(next.projectId + ":" + id)) throw new Error("La idea enlaza una ficha inexistente.");
    }
    this.ideas.set(key, structuredClone(next));
  }
  async updateIdeaIfUnchanged(next, expected) {
    return this.saveIdeaIfUnchanged(next, expected);
  }
}

function createApi(store) {
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId, projectName, writerId: "writer-idea-sync" });
  return api;
}

test("reconcilia adiciones y eliminaciones de vínculos de ideas tras conflictos CAS", async () => {
  const initial = idea("idea-source", { relatedIdeaIds: ["idea-remove"] });
  const store = new RacingStore([
    initial, idea("idea-remove"), idea("idea-local"),
    idea("idea-external"), idea("idea-concurrent")
  ]);
  const api = createApi(store);
  await api.getNarrativeIdeas();

  store.onNextConflict = current => ({
    ...current,
    status: "incorporated",
    statusHistory: [
      ...current.statusHistory,
      { status: "incorporated", reason: "writer", changedAt: 2 }
    ],
    relatedIdeaIds: [...current.relatedIdeaIds, "idea-external"]
  });
  const added = await api.setNarrativeIdeaLink("idea-source", "idea-local", true);
  assert.deepEqual(added.relatedIdeaIds, ["idea-remove", "idea-external", "idea-local"]);
  assert.equal(added.text, initial.text);
  assert.equal(added.status, "incorporated");
  assert.deepEqual(added.statusHistory.at(-1), {
    status: "incorporated", reason: "writer", changedAt: 2
  });

  store.onNextConflict = current => ({
    ...current,
    status: "discarded",
    statusHistory: [
      ...current.statusHistory,
      { status: "discarded", reason: "writer", changedAt: 3 }
    ],
    relatedIdeaIds: [...current.relatedIdeaIds, "idea-concurrent"]
  });
  const removed = await api.setNarrativeIdeaLink("idea-source", "idea-remove", false);
  assert.deepEqual(removed.relatedIdeaIds, ["idea-external", "idea-local", "idea-concurrent"]);
  assert.equal(removed.status, "discarded");
  assert.deepEqual(removed.statusHistory.at(-1), {
    status: "discarded", reason: "writer", changedAt: 3
  });
  assert.deepEqual(store.ideas.get(projectId + ":idea-source").relatedIdeaIds, removed.relatedIdeaIds);
  assert.equal(store.writes, 4);
  api.dispose();
});

test("reaplica vínculos idea-ficha usando el catálogo recargado tras un conflicto CAS", async () => {
  const store = new RacingStore([idea("idea-source")], [
    entity("character-local", "Ana"), entity("character-external", "Bruno")
  ]);
  const api = createApi(store);
  await api.getNarrativeIdeas();
  store.onNextConflict = current => ({ ...current, relatedEntityIds: ["character-external"] });

  const result = await api.setNarrativeIdeaEntityLink("idea-source", "character-local", true);
  assert.deepEqual(result.relatedEntityIds, ["character-external", "character-local"]);
  assert.deepEqual(store.ideas.get(projectId + ":idea-source").relatedEntityIds, result.relatedEntityIds);
  assert.equal(store.entityReads, 2);
  assert.equal(store.writes, 2);
  api.dispose();
});

test("rechaza el vínculo a ficha si la entidad destino desaparece durante CAS", async () => {
  const store = new RacingStore([idea("idea-source")], [
    entity("character-local", "Ana"), entity("character-external", "Bruno")
  ]);
  const api = createApi(store);
  await api.getNarrativeIdeas();

  store.onNextConflict = current => {
    store.entities.delete(projectId + ":character-local");
    return { ...current, relatedEntityIds: ["character-external"] };
  };

  await assert.rejects(
    api.setNarrativeIdeaEntityLink("idea-source", "character-local", true),
    /La idea y la entidad deben existir en el proyecto activo/
  );
  assert.deepEqual(
    store.ideas.get(projectId + ":idea-source").relatedEntityIds,
    ["character-external"]
  );
  assert.equal(store.entityReads, 2);
  assert.equal(store.writes, 1);
  api.dispose();
});

test("no reintenta errores de almacenamiento que no son conflictos CAS", async () => {
  const store = new RacingStore([idea("idea-source"), idea("idea-target")]);
  const api = createApi(store);
  await api.getNarrativeIdeas();
  store.nextWriteError = new Error("fallo de almacenamiento");

  await assert.rejects(
    api.setNarrativeIdeaLink("idea-source", "idea-target", true),
    /fallo de almacenamiento/
  );
  assert.equal(store.writes, 1);
  api.dispose();
});

test("limita a tres intentos los conflictos CAS consecutivos y conserva las escrituras externas", async () => {
  const store = new RacingStore([
    idea("idea-source"), idea("idea-local"),
    idea("idea-concurrent-1"), idea("idea-concurrent-2"), idea("idea-concurrent-3")
  ]);
  const api = createApi(store);
  await api.getNarrativeIdeas();

  const concurrentIds = ["idea-concurrent-1", "idea-concurrent-2", "idea-concurrent-3"];
  let conflictIndex = 0;
  const queueConflict = () => {
    store.onNextConflict = current => {
      const targetId = concurrentIds[conflictIndex++];
      if (conflictIndex < concurrentIds.length) queueConflict();
      return { ...current, relatedIdeaIds: [...current.relatedIdeaIds, targetId] };
    };
  };
  queueConflict();

  await assert.rejects(
    api.setNarrativeIdeaLink("idea-source", "idea-local", true),
    /La idea cambió en otra instancia/
  );
  const persisted = store.ideas.get(projectId + ":idea-source");
  assert.deepEqual(persisted.relatedIdeaIds, concurrentIds);
  assert.equal(persisted.relatedIdeaIds.includes("idea-local"), false);
  assert.equal(store.writes, 3);
  api.dispose();
});

test("rechaza un vínculo si el destino desaparece durante la relectura tras CAS", async () => {
  const store = new RacingStore([idea("idea-source"), idea("idea-target")]);
  const api = createApi(store);
  await api.getNarrativeIdeas();

  store.onNextConflict = current => {
    store.ideas.delete(projectId + ":idea-target");
    return { ...current, text: "La idea de origen conserva su texto." };
  };

  await assert.rejects(
    api.setNarrativeIdeaLink("idea-source", "idea-target", true),
    /Ambas ideas deben existir en el proyecto activo/
  );
  assert.deepEqual(
    store.ideas.get(projectId + ":idea-source").relatedIdeaIds,
    []
  );
  assert.equal(store.ideas.has(projectId + ":idea-target"), false);
  assert.equal(store.writes, 1);
  api.dispose();
});

test("reconcilia dos altas concurrentes del mismo vínculo como una sola asociación", async () => {
  const store = new RacingStore([idea("idea-source"), idea("idea-target")]);
  const api = createApi(store);
  await api.getNarrativeIdeas();

  store.onNextConflict = current => ({
    ...current,
    relatedIdeaIds: [...current.relatedIdeaIds, "idea-target"]
  });
  const result = await api.setNarrativeIdeaLink("idea-source", "idea-target", true);

  assert.deepEqual(result.relatedIdeaIds, ["idea-target"]);
  assert.deepEqual(
    store.ideas.get(projectId + ":idea-source").relatedIdeaIds,
    ["idea-target"]
  );
  assert.equal(store.writes, 1);
  api.dispose();
});

test("mantiene el límite de 500 vínculos por categoría antes de persistir", async () => {
  const relatedIdeaIds = Array.from({ length: 500 }, (_, index) =>
    "idea-related-" + String(index).padStart(3, "0")
  );
  const ideaStore = new RacingStore([
    idea("idea-source", { relatedIdeaIds }),
    ...relatedIdeaIds.map(id => idea(id)),
    idea("idea-overflow")
  ]);
  const ideaApi = createApi(ideaStore);
  await ideaApi.getNarrativeIdeas();
  await assert.rejects(
    ideaApi.setNarrativeIdeaLink("idea-source", "idea-overflow", true),
    /no puede conservar más de 500 vínculos por categoría/
  );
  assert.equal(ideaStore.writes, 0);
  ideaApi.dispose();

  const relatedEntityIds = Array.from({ length: 500 }, (_, index) =>
    "entity-related-" + String(index).padStart(3, "0")
  );
  const entityStore = new RacingStore(
    [idea("idea-source", { relatedEntityIds })],
    [...relatedEntityIds, "entity-overflow"].map((id, index) => entity(
      id, "Personaje " + index
    ))
  );
  const entityApi = createApi(entityStore);
  await entityApi.getNarrativeIdeas();
  await assert.rejects(
    entityApi.setNarrativeIdeaEntityLink("idea-source", "entity-overflow", true),
    /no puede conservar más de 500 vínculos por categoría/
  );
  assert.equal(entityStore.writes, 0);
  entityApi.dispose();
});

test("rechaza catálogos de adaptadores con más de 500 vínculos por idea", async () => {
  const oversized = Array.from({ length: 501 }, (_, index) =>
    "idea-related-" + String(index).padStart(3, "0")
  );
  const store = new RacingStore([
    idea("idea-source", { relatedIdeaIds: oversized })
  ]);
  const api = createApi(store);
  await assert.rejects(
    api.getNarrativeIdeas(),
    /registro malformado en ideas/
  );
  api.dispose();
});
