import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi } from "../dist/motor-literario.js";

class LifecycleMemoryStore {
  entities = new Map();
  relations = new Map();
  projectRecords = new Map();
  projectRelations = new Map();
  recordHistory = new Map();
  relationHistory = new Map();

  key(projectId, id) { return JSON.stringify([projectId, id]); }

  async saveEntity(item) {
    this.entities.set(this.key(item.projectId, item.id), structuredClone(item));
    this.projectRecords.set(this.key(item.projectId, item.id), {
      projectId: item.projectId, id: item.id, recordType: item.kind,
      primaryName: item.canonicalName ?? null, description: null,
      label: "REGISTRADO EN LA OBRA", state: "abierto",
      confidence: "HIGH", confirmationKind: "EXPLICIT",
      provenanceKind: "MOTOR", createdAt: item.firstSeenAt ?? 0,
      updatedAt: item.lastSeenAt ?? item.firstSeenAt ?? 0, currentVersion: 1
    });
  }
  async loadProjectRecords(projectId) {
    return [...this.projectRecords.values()]
      .filter(item => item.projectId === projectId)
      .map(item => structuredClone(item));
  }
  async saveProjectRecord(item) {
    this.projectRecords.set(this.key(item.projectId, item.id), structuredClone(item));
  }
  async loadEntities(projectId) {
    return [...this.entities.values()]
      .filter(item => item.projectId === projectId)
      .map(item => structuredClone(item));
  }
  async saveRelation(item) {
    this.relations.set(this.key(item.projectId, item.id), structuredClone(item));
    this.projectRelations.set(this.key(item.projectId, item.id), {
      projectId: item.projectId, id: item.id, relationType: item.relationType,
      sourceRecordId: item.fromEntityId ?? null, targetRecordId: item.toEntityId ?? null,
      label: "REGISTRADO EN LA OBRA", state: "abierto",
      confirmationKind: "EXPLICIT", provenanceKind: "MOTOR", confidence: "HIGH",
      createdAt: 0, updatedAt: 0, currentVersion: 1
    });
  }
  async loadProjectRelations(projectId) {
    return [...this.projectRelations.values()]
      .filter(item => item.projectId === projectId)
      .map(item => structuredClone(item));
  }
  async saveProjectRelation(item) {
    this.projectRelations.set(this.key(item.projectId, item.id), structuredClone(item));
  }
  async loadRelations(projectId) {
    return [...this.relations.values()]
      .filter(item => item.projectId === projectId)
      .map(item => structuredClone(item));
  }

  async loadRecordLifecycles(projectId, recordId) {
    if (!this.projectRecords.has(this.key(projectId, recordId))) {
      throw new Error("No existe la ficha solicitada.");
    }
    return structuredClone(this.recordHistory.get(this.key(projectId, recordId)) ?? []);
  }
  async appendRecordLifecycle(item) {
    if (!this.projectRecords.has(this.key(item.projectId, item.recordId))) {
      throw new Error("No existe la ficha de destino.");
    }
    const key = this.key(item.projectId, item.recordId);
    const history = this.recordHistory.get(key) ?? [];
    const previous = history.at(-1);
    if (!previous
      ? item.revision !== 1 || item.previousLabel !== null || item.previousState !== null
      : item.revision !== previous.revision + 1 ||
        item.previousLabel !== previous.newLabel ||
        item.previousState !== previous.newState ||
        item.changedAt < previous.changedAt) {
      throw new Error("Transición de ficha inconsistente.");
    }
    if (history.some(existing => existing.id === item.id)) throw new Error("ID histórico duplicado.");
    this.recordHistory.set(key, [...history, structuredClone(item)]);
  }

  async loadRelationLifecycles(projectId, relationId) {
    if (!this.projectRelations.has(this.key(projectId, relationId))) {
      throw new Error("No existe la relación solicitada.");
    }
    return structuredClone(this.relationHistory.get(this.key(projectId, relationId)) ?? []);
  }
  async appendRelationLifecycle(item) {
    if (!this.projectRelations.has(this.key(item.projectId, item.relationId))) {
      throw new Error("No existe la relación de destino.");
    }
    const key = this.key(item.projectId, item.relationId);
    const history = this.relationHistory.get(key) ?? [];
    const previous = history.at(-1);
    if (!previous
      ? item.revision !== 1 || item.previousLabel !== null || item.previousState !== null
      : item.revision !== previous.revision + 1 ||
        item.previousLabel !== previous.newLabel ||
        item.previousState !== previous.newState ||
        item.changedAt < previous.changedAt) {
      throw new Error("Transición de relación inconsistente.");
    }
    if (history.some(existing => existing.id === item.id)) throw new Error("ID histórico duplicado.");
    this.relationHistory.set(key, [...history, structuredClone(item)]);
  }
}

const project = { projectId: "book-a", projectName: "Libro A", writerId: "writer-a" };
const ana = {
  projectId: "book-a", id: "record-a", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [], evidence: [],
  firstSeenAt: 0, lastSeenAt: 0, extractionVersion: 1
};
const bruno = {
  projectId: "book-a", id: "record-b", kind: "character",
  canonicalName: "Bruno", normalizedName: "bruno", aliases: [], evidence: [],
  firstSeenAt: 0, lastSeenAt: 0, extractionVersion: 1
};
const relation = {
  projectId: "book-a", id: "relation-a", fromEntityId: "record-a",
  toEntityId: "record-b", relationType: "ally", evidence: []
};
const firstRecord = (overrides = {}) => ({
  id: "record-life-1", recordId: "record-a", revision: 1,
  previousLabel: null, newLabel: "Ana",
  previousState: null, newState: "ACTIVE",
  changedBy: "writer-a", changeReason: "Primera identificación",
  changedAt: 10, ...overrides
});
const firstRelation = (overrides = {}) => ({
  id: "relation-life-1", relationId: "relation-a", revision: 1,
  previousLabel: null, newLabel: "Alianza",
  previousState: null, newState: "ACTIVE",
  changedBy: "writer-a", changeReason: null,
  changedAt: 10, ...overrides
});

test("mantiene historial inmutable y secuencial de una ficha", async () => {
  const store = new LifecycleMemoryStore();
  await store.saveEntity(ana);
  const api = new HostEngineApi({ store });
  api.initializeProject(project);

  const one = await api.appendRecordLifecycle(firstRecord());
  const two = await api.appendRecordLifecycle({
    id: "record-life-2", recordId: "record-a", revision: 2,
    previousLabel: "Ana", newLabel: "Ana de Arven",
    previousState: "ACTIVE", newState: "CONFIRMED",
    changedBy: "writer-a", changeReason: "Apellido confirmado",
    changedAt: 20
  });

  assert.equal(one.revision, 1);
  assert.equal(two.revision, 2);
  assert.deepEqual(
    (await api.getRecordLifecycleHistory("record-a")).map(item => item.newState),
    ["ACTIVE", "CONFIRMED"]
  );
});

test("mantiene historial inmutable y secuencial de una relación", async () => {
  const store = new LifecycleMemoryStore();
  await store.saveEntity(ana);
  await store.saveEntity(bruno);
  await store.saveRelation(relation);
  const api = new HostEngineApi({ store });
  api.initializeProject(project);

  await api.appendRelationLifecycle(firstRelation());
  const next = await api.appendRelationLifecycle({
    id: "relation-life-2", relationId: "relation-a", revision: 2,
    previousLabel: "Alianza", newLabel: "Pacto de protección",
    previousState: "ACTIVE", newState: "SUSPENDED",
    changedBy: "writer-a", changedAt: 15
  });

  assert.equal(next.newState, "SUSPENDED");
  assert.deepEqual(
    (await api.getRelationLifecycleHistory("relation-a")).map(item => item.revision),
    [1, 2]
  );
});

test("rechaza revisiones salteadas, estados previos falsos y fechas regresivas", async () => {
  const store = new LifecycleMemoryStore();
  await store.saveEntity(ana);
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  await api.appendRecordLifecycle(firstRecord());

  await assert.rejects(api.appendRecordLifecycle(firstRecord({
    id: "record-life-3", revision: 3, changedAt: 30
  })), /continuar exactamente/);
  await assert.rejects(api.appendRecordLifecycle(firstRecord({
    id: "record-life-2", revision: 2, previousLabel: "Otra etiqueta", changedAt: 30
  })), /continuar exactamente/);
  await assert.rejects(api.appendRecordLifecycle(firstRecord({
    id: "record-life-2", revision: 2, previousLabel: "Ana",
    previousState: "ACTIVE", changedAt: 9
  })), /continuar exactamente/);

  assert.equal((await api.getRecordLifecycleHistory("record-a")).length, 1);
});

test("rechaza historiales para fichas o relaciones inexistentes", async () => {
  const api = new HostEngineApi({ store: new LifecycleMemoryStore() });
  api.initializeProject(project);
  await assert.rejects(api.appendRecordLifecycle(firstRecord()), /no existe/);
  await assert.rejects(api.appendRelationLifecycle(firstRelation()), /no existe/);
});

test("aísla historiales entre libros aunque los IDs coincidan", async () => {
  const store = new LifecycleMemoryStore();
  await store.saveEntity(ana);
  const first = new HostEngineApi({ store });
  first.initializeProject(project);
  await first.appendRecordLifecycle(firstRecord());

  const second = new HostEngineApi({ store });
  second.initializeProject({ projectId: "book-b", projectName: "Libro B", writerId: "writer-a" });
  await assert.rejects(second.getRecordLifecycleHistory("record-a"), /no existe/);
  assert.equal((await first.getRecordLifecycleHistory("record-a")).length, 1);
});

test("las lecturas del historial devuelven copias aisladas", async () => {
  const store = new LifecycleMemoryStore();
  await store.saveEntity(ana);
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  await api.appendRecordLifecycle(firstRecord());

  const history = await api.getRecordLifecycleHistory("record-a");
  history[0].newLabel = "modificado";
  assert.equal((await api.getRecordLifecycleHistory("record-a"))[0].newLabel, "Ana");
});
