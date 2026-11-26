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
  ideaReads = 0;
  entityReads = 0;

  constructor(ideas = [], entities = []) {
    for (const item of ideas) this.ideas.set(this.key(item), structuredClone(item));
    for (const item of entities) this.entities.set(this.key(item), structuredClone(item));
  }
  key(item) { return item.projectId + ":" + item.id; }
  async saveIdea(item) { this.ideas.set(this.key(item), structuredClone(item)); }
  async loadIdeas(id) {
    this.ideaReads++;
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

test("permite retirar una referencia a una ficha eliminada", async () => {
  const store = new RacingStore([
    idea("idea-source", { relatedEntityIds: ["character-deleted"] })
  ]);
  const api = createApi(store);

  const result = await api.setNarrativeIdeaEntityLink(
    "idea-source", "character-deleted", false
  );

  assert.deepEqual(result.relatedEntityIds, []);
  assert.deepEqual(
    store.ideas.get(projectId + ":idea-source").relatedEntityIds,
    []
  );
  assert.equal(store.entityReads, 1);
  assert.equal(store.writes, 1);
  api.dispose();
});

test("permite retirar una referencia a una idea que ya no existe", async () => {
  const store = new RacingStore([
    idea("idea-source", { relatedIdeaIds: ["idea-deleted"] })
  ]);
  const api = createApi(store);

  const result = await api.setNarrativeIdeaLink(
    "idea-source", "idea-deleted", false
  );

  assert.deepEqual(result.relatedIdeaIds, []);
  assert.deepEqual(
    store.ideas.get(projectId + ":idea-source").relatedIdeaIds,
    []
  );
  assert.equal(store.writes, 1);
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

test("rechaza el alta de un vínculo si la idea destino desaparece durante CAS", async () => {
  const store = new RacingStore([
    idea("idea-source"), idea("idea-target"), idea("idea-external")
  ]);
  const api = createApi(store);
  await api.getNarrativeIdeas();

  store.onNextConflict = current => {
    store.ideas.delete(projectId + ":idea-target");
    return { ...current, relatedIdeaIds: ["idea-external"] };
  };

  await assert.rejects(
    api.setNarrativeIdeaLink("idea-source", "idea-target", true),
    /Ambas ideas deben existir en el proyecto activo/
  );
  assert.deepEqual(
    store.ideas.get(projectId + ":idea-source").relatedIdeaIds,
    ["idea-external"]
  );
  assert.equal(store.ideaReads, 4);
  assert.equal(store.writes, 1);
  api.dispose();
});

test("permite limpiar el vínculo a una idea eliminada durante un conflicto CAS", async () => {
  const store = new RacingStore([
    idea("idea-source", { relatedIdeaIds: ["idea-target"] }),
    idea("idea-target")
  ]);
  const api = createApi(store);
  await api.getNarrativeIdeas();

  store.onNextConflict = current => {
    store.ideas.delete(projectId + ":idea-target");
    return {
      ...current,
      status: "incorporated",
      statusHistory: [
        ...current.statusHistory,
        { status: "incorporated", reason: "writer", changedAt: 2 }
      ]
    };
  };

  const result = await api.setNarrativeIdeaLink(
    "idea-source", "idea-target", false
  );

  assert.deepEqual(result.relatedIdeaIds, []);
  assert.equal(result.status, "incorporated");
  assert.equal(result.statusHistory.at(-1).reason, "writer");
  assert.deepEqual(
    store.ideas.get(projectId + ":idea-source").relatedIdeaIds,
    []
  );
  assert.equal(store.writes, 2);
  api.dispose();
});

test("permite limpiar el vínculo a una ficha eliminada durante un conflicto CAS", async () => {
  const store = new RacingStore([
    idea("idea-source", { relatedEntityIds: ["character-local"] })
  ], [entity("character-local", "Ana")]);
  const api = createApi(store);
  await api.getNarrativeIdeas();

  store.onNextConflict = current => {
    store.entities.delete(projectId + ":character-local");
    return {
      ...current,
      status: "incorporated",
      statusHistory: [
        ...current.statusHistory,
        { status: "incorporated", reason: "writer", changedAt: 2 }
      ]
    };
  };

  const result = await api.setNarrativeIdeaEntityLink(
    "idea-source", "character-local", false
  );

  assert.deepEqual(result.relatedEntityIds, []);
  assert.equal(result.status, "incorporated");
  assert.equal(result.statusHistory.at(-1).reason, "writer");
  assert.deepEqual(
    store.ideas.get(projectId + ":idea-source").relatedEntityIds,
    []
  );
  assert.equal(store.entityReads, 2);
  assert.equal(store.writes, 2);
  api.dispose();
});

test("rechaza auto-vínculos sin intentar leer ni escribir el catálogo", async () => {
  const store = new RacingStore([idea("idea-source")]);
  const api = createApi(store);

  await assert.rejects(
    api.setNarrativeIdeaLink("idea-source", "idea-source", true),
    /Datos de relación entre ideas inválidos/
  );
  assert.equal(store.writes, 0);
  assert.equal(store.entityReads, 0);
  api.dispose();
});

test("las altas y bajas repetidas de un vínculo son idempotentes y no escriben", async () => {
  const store = new RacingStore([
    idea("idea-source", { relatedIdeaIds: ["idea-target"] }),
    idea("idea-target")
  ]);
  const api = createApi(store);
  await api.getNarrativeIdeas();

  const alreadyLinked = await api.setNarrativeIdeaLink(
    "idea-source", "idea-target", true
  );
  assert.deepEqual(alreadyLinked.relatedIdeaIds, ["idea-target"]);
  alreadyLinked.relatedIdeaIds.push("external-mutation");

  const stillLinked = await api.setNarrativeIdeaLink(
    "idea-source", "idea-target", true
  );
  assert.deepEqual(stillLinked.relatedIdeaIds, ["idea-target"]);

  const alreadyUnlinked = await api.setNarrativeIdeaLink(
    "idea-source", "missing-target", false
  );
  assert.deepEqual(alreadyUnlinked.relatedIdeaIds, ["idea-target"]);
  assert.equal(store.writes, 0);
  assert.deepEqual(
    store.ideas.get(projectId + ":idea-source").relatedIdeaIds,
    ["idea-target"]
  );
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

test("rechaza altas de vínculos entre ideas si el destino fue eliminado externamente", async () => {
  const store = new RacingStore([
    idea("idea-source"), idea("idea-deleted")
  ]);
  const api = createApi(store);

  const initial = await api.getNarrativeIdeas();
  assert.equal(initial.length, 2);
  assert.equal(store.ideaReads, 1);

  store.ideas.delete(projectId + ":idea-deleted");
  await assert.rejects(
    api.setNarrativeIdeaLink("idea-source", "idea-deleted", true),
    /Ambas ideas deben existir en el proyecto activo/
  );

  assert.equal(store.ideaReads, 2);
  assert.equal(store.writes, 0);
  assert.deepEqual(
    store.ideas.get(projectId + ":idea-source").relatedIdeaIds,
    []
  );
  api.dispose();
});

test("rechaza altas de vínculos si el destino fue eliminado tras calentar la caché", async () => {
  const store = new RacingStore(
    [idea("idea-source")],
    [entity("character-external", "Luz")]
  );
  const api = createApi(store);

  const cachedEntities = await api.getNarrativeEntities();
  assert.equal(cachedEntities.length, 1);
  assert.equal(store.entityReads, 1);

  store.entities.delete(projectId + ":character-external");
  await assert.rejects(
    api.setNarrativeIdeaEntityLink("idea-source", "character-external", true),
    /La idea y la entidad deben existir en el proyecto activo/
  );

  assert.equal(store.entityReads, 2);
  assert.equal(store.writes, 0);
  assert.deepEqual(
    store.ideas.get(projectId + ":idea-source").relatedEntityIds,
    []
  );
  api.dispose();
});

test("detecta fichas eliminadas externamente aunque la caché de entidades esté caliente", async () => {
  const store = new RacingStore(
    [idea("idea-source", { relatedEntityIds: ["character-external"] })],
    [entity("character-external", "Luz")]
  );
  const api = createApi(store);

  const initial = await api.getNarrativeIdeas();
  assert.deepEqual(initial[0].relatedEntityIds, ["character-external"]);
  assert.equal(store.entityReads, 1);

  store.entities.delete(projectId + ":character-external");
  await assert.rejects(
    api.getNarrativeIdeas(),
    /referencias a entidades inexistentes en el proyecto activo/
  );
  assert.equal(store.entityReads, 2);

  const cleaned = await api.setNarrativeIdeaEntityLink(
    "idea-source", "character-external", false
  );
  assert.deepEqual(cleaned.relatedEntityIds, []);
  assert.deepEqual(
    store.ideas.get(projectId + ":idea-source").relatedEntityIds,
    []
  );
  api.dispose();
});

test("recupera la cola y la caché tras un fallo de persistencia", async () => {
  const store = new RacingStore([
    idea("idea-source"), idea("idea-target-a"), idea("idea-target-b")
  ]);
  const api = createApi(store);
  await api.getNarrativeIdeas();
  store.nextWriteError = new Error("fallo transitorio de almacenamiento");

  await assert.rejects(
    api.setNarrativeIdeaLink("idea-source", "idea-target-a", true),
    /fallo transitorio de almacenamiento/
  );
  assert.equal(store.writes, 1);

  const recovered = await api.setNarrativeIdeaLink(
    "idea-source", "idea-target-b", true
  );
  assert.deepEqual(recovered.relatedIdeaIds, ["idea-target-b"]);
  assert.deepEqual(
    store.ideas.get(projectId + ":idea-source").relatedIdeaIds,
    ["idea-target-b"]
  );
  assert.equal(store.ideaReads, 4);
  assert.equal(store.writes, 2);
  api.dispose();
});

test("revalida el máximo de referencias después de un conflicto CAS", async () => {
  const existingIds = Array.from({ length: 499 }, (_, index) =>
    "idea-existing-" + String(index).padStart(3, "0")
  );
  const store = new RacingStore([
    idea("idea-source", { relatedIdeaIds: existingIds }),
    ...existingIds.map(id => idea(id)),
    idea("idea-concurrent"),
    idea("idea-local")
  ]);
  const api = createApi(store);
  await api.getNarrativeIdeas();
  store.onNextConflict = current => ({
    ...current,
    relatedIdeaIds: [...current.relatedIdeaIds, "idea-concurrent"]
  });

  await assert.rejects(
    api.setNarrativeIdeaLink("idea-source", "idea-local", true),
    /no puede conservar más de 500 vínculos por categoría/
  );
  const persisted = store.ideas.get(projectId + ":idea-source");
  assert.equal(persisted.relatedIdeaIds.length, 500);
  assert.equal(persisted.relatedIdeaIds.includes("idea-concurrent"), true);
  assert.equal(persisted.relatedIdeaIds.includes("idea-local"), false);
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

  // El tercer conflicto también debe dejar invalidada la caché local:
  // la siguiente lectura tiene que reflejar las tres escrituras externas.
  const reloaded = await api.getNarrativeIdeas();
  const reloadedSource = reloaded.find(item => item.id === "idea-source");
  assert.deepEqual(reloadedSource.relatedIdeaIds, concurrentIds);
  assert.equal(store.ideaReads, 7);
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

test("no reintenta cambios de estado ante errores ajenos a CAS", async () => {
  const store = new RacingStore([idea("idea-source")]);
  const api = createApi(store);
  await api.getNarrativeIdeas();
  store.nextWriteError = new Error("fallo de almacenamiento");

  await assert.rejects(
    api.setNarrativeIdeaStatus("idea-source", "incorporated"),
    /fallo de almacenamiento/
  );
  assert.equal(store.writes, 1);
  assert.equal(
    store.ideas.get(projectId + ":idea-source").status,
    "IDEA"
  );
  api.dispose();
});

test("limita a tres intentos los conflictos CAS persistentes al cambiar estado", async () => {
  const store = new RacingStore([idea("idea-source")]);
  const api = createApi(store);
  await api.getNarrativeIdeas();
  store.saveIdeaIfUnchanged = async () => {
    store.writes++;
    throw new Error("La idea cambió en otra instancia; actualiza la vista antes de volver a modificarla.");
  };

  await assert.rejects(
    api.setNarrativeIdeaStatus("idea-source", "incorporated"),
    /La idea cambió en otra instancia/
  );
  assert.equal(store.writes, 3);
  assert.equal(store.ideaReads, 3);
  assert.equal(
    store.ideas.get(projectId + ":idea-source").status,
    "IDEA"
  );
  api.dispose();
});

test("no duplica una decisión editorial ya aplicada por otra instancia durante el CAS", async () => {
  const store = new RacingStore([idea("idea-source")]);
  const api = createApi(store);
  await api.getNarrativeIdeas();
  store.onNextConflict = current => ({
    ...current,
    status: "incorporated",
    statusHistory: [
      ...current.statusHistory,
      { status: "incorporated", reason: "writer", changedAt: 2 }
    ]
  });

  const result = await api.setNarrativeIdeaStatus("idea-source", "incorporated");
  assert.equal(result.status, "incorporated");
  assert.equal(result.statusHistory.length, 2);
  assert.deepEqual(
    result.statusHistory.map(change => change.status),
    ["IDEA", "incorporated"]
  );
  assert.equal(store.writes, 1);
  assert.equal(store.ideaReads, 2);
  api.dispose();
});

test("reintenta cambios de estado tras CAS y conserva vínculos concurrentes", async () => {
  const store = new RacingStore([
    idea("idea-source"), idea("idea-concurrent-target")
  ]);
  const api = createApi(store);
  await api.getNarrativeIdeas();
  store.onNextConflict = current => ({
    ...current,
    relatedIdeaIds: ["idea-concurrent-target"],
    status: "discarded",
    statusHistory: [
      ...current.statusHistory,
      { status: "discarded", reason: "writer", changedAt: 2 }
    ]
  });

  const result = await api.setNarrativeIdeaStatus("idea-source", "incorporated");
  assert.equal(result.status, "incorporated");
  assert.deepEqual(result.relatedIdeaIds, ["idea-concurrent-target"]);
  assert.deepEqual(result.statusHistory.map(change => change.status), [
    "IDEA", "discarded", "incorporated"
  ]);
  assert.equal(result.statusHistory.at(-1).reason, "writer");
  assert.deepEqual(
    store.ideas.get(projectId + ":idea-source").relatedIdeaIds,
    ["idea-concurrent-target"]
  );
  assert.equal(store.writes, 2);
  assert.equal(store.ideaReads, 2);
  api.dispose();
});

test("serializa vínculos y decisiones editoriales simultáneas en una misma instancia", async () => {
  const store = new RacingStore([
    idea("idea-source"), idea("idea-target-a"), idea("idea-target-b")
  ]);
  const api = createApi(store);
  await api.getNarrativeIdeas();

  const [linkedA, updatedStatus, linkedB] = await Promise.all([
    api.setNarrativeIdeaLink("idea-source", "idea-target-a", true),
    api.setNarrativeIdeaStatus("idea-source", "incorporated"),
    api.setNarrativeIdeaLink("idea-source", "idea-target-b", true)
  ]);

  const persisted = store.ideas.get(projectId + ":idea-source");
  assert.deepEqual(persisted.relatedIdeaIds, ["idea-target-a", "idea-target-b"]);
  assert.equal(persisted.status, "incorporated");
  assert.equal(persisted.statusHistory.at(-1).reason, "writer");
  assert.deepEqual(linkedA.relatedIdeaIds, ["idea-target-a"]);
  assert.equal(updatedStatus.status, "incorporated");
  assert.deepEqual(linkedB.relatedIdeaIds, ["idea-target-a", "idea-target-b"]);
  assert.equal(store.writes, 3);
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

test("rechaza historiales editoriales cuya secuencia temporal o estado final es incoherente", async () => {
  const invalidHistories = [
    [
      { status: "IDEA", reason: "initial", changedAt: 10 },
      { status: "incorporated", reason: "writer", changedAt: 9 }
    ],
    [
      { status: "IDEA", reason: "initial", changedAt: 1 },
      { status: "discarded", reason: "writer", changedAt: 2 }
    ]
  ];

  for (const statusHistory of invalidHistories) {
    const store = new RacingStore([
      idea("idea-source", { status: "incorporated", statusHistory })
    ]);
    const api = createApi(store);
    await assert.rejects(
      api.getNarrativeIdeas(),
      /registro malformado en ideas/
    );
    api.dispose();
  }
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


test("una referencia rota no publica parcialmente la caché de ideas", async () => {
  const invalidIdea = idea("idea-with-dangling-entity", {
    relatedEntityIds: ["character-to-recover"]
  });
  const store = new RacingStore([invalidIdea]);
  const api = createApi(store);

  await assert.rejects(
    api.getNarrativeIdeas(),
    /referencias a entidades inexistentes/
  );
  const ideaReadsAfterFailure = store.ideaReads;
  const entityReadsAfterFailure = store.entityReads;

  const recoveredEntity = entity("character-to-recover", "Ana");
  store.entities.set(store.key(recoveredEntity), structuredClone(recoveredEntity));
  const recovered = await api.getNarrativeIdeas();

  assert.equal(recovered.length, 1);
  assert.deepEqual(recovered[0].relatedEntityIds, ["character-to-recover"]);
  assert.equal(store.ideaReads, ideaReadsAfterFailure + 1);
  assert.equal(store.entityReads, entityReadsAfterFailure + 1);
  api.dispose();
});
