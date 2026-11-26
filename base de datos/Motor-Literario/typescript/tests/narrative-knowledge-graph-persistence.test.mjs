import test from "node:test";
import assert from "node:assert/strict";
import {
  createNarrativeKnowledgeGraphSnapshot,
  persistNarrativeKnowledgeGraphSnapshot,
  createNarrativeDocumentProjectionManifest,
  createNarrativeDocumentProjectionTombstone,
  commitNarrativeDocumentProjectionManifest,
  persistNarrativeKnowledgeGraphSnapshotWithManifests,
  retireNarrativeDocumentProjection,
  reconcileNarrativeDocumentProjections,
  repairNarrativeDocumentProjectionManifest,
  proposeNarrativeReferenceRepairs,
  applyNarrativeReferenceRepair,
  recoverNarrativeReferenceRepairs,
  inspectNarrativeReferenceRepairPending,
  loadNarrativeProjectAfterRepairRecovery,
  verifyNarrativeReferenceRepairAuditIntegrity,
  reconcileNarrativeRepairAndSyncState,
  validateNarrativeDocumentProjectionManifest
} from "../dist/motor-literario.js";

function createMemoryStore() {
  const tables = {
    entities: new Map(), relations: new Map(), events: new Map(),
    ideas: new Map(), assertions: new Map(), manifests: new Map(), audits: new Map(), pendingRepairs: new Map()
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
  methods.appendNarrativeReferenceRepairAudit = async entry => {
    const key = entry.projectId + "\\u0000" + entry.operationId;
    const current = tables.audits.get(key);
    if (current) {
      const { appliedAt: _a, ...left } = current;
      const { appliedAt: _b, ...right } = entry;
      assert.deepEqual(left, right, "la auditoría append-only no puede cambiar de contenido");
      return;
    }
    tables.audits.set(key, copy(entry));
  };
  methods.loadNarrativeReferenceRepairAudits = async projectId =>
    [...tables.audits.values()].filter(item => item.projectId === projectId).map(copy);
  methods.saveNarrativeReferenceRepairPending = async entry => {
    const key = entry.projectId + "\\u0000" + entry.operationId;
    const current = tables.pendingRepairs.get(key);
    if (current) {
      const { appliedAt: _currentAt, ...currentOperation } = current;
      const { appliedAt: _entryAt, ...newOperation } = entry;
      assert.deepEqual(currentOperation, newOperation, "la intención pendiente es inmutable");
    } else tables.pendingRepairs.set(key, copy(entry));
  };
  methods.loadNarrativeReferenceRepairPending = async projectId =>
    [...tables.pendingRepairs.values()].filter(item => item.projectId === projectId).map(copy);
  methods.deleteNarrativeReferenceRepairPending = async (projectId, operationId) =>
    tables.pendingRepairs.delete(projectId + "\\u0000" + operationId);
  methods.loadNarrativeDocumentProjectionManifest = async (projectId, documentId) =>
    copy(tables.manifests.get(projectId + "\\u0000" + documentId));
  methods.saveNarrativeDocumentProjectionManifestIfUnchanged = async (manifest, expectedGeneration) => {
    const key = manifest.projectId + "\\u0000" + manifest.documentId;
    const current = tables.manifests.get(key);
    assert.equal(current?.generation, expectedGeneration, "manifiesto CAS por generación");
    tables.manifests.set(key, copy(manifest));
  };
  methods.loadNarrativeDocumentProjectionManifests = async projectId =>
    [...tables.manifests.values()].filter(item => item.projectId === projectId).map(copy);
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


test("valida inventarios únicos y tombstones sin referencias activas", () => {
  const valid = {
    projectId: "novel-a", documentId: "chapter-a", revision: 2,
    generation: 1, status: "active", entityIds: ["entity-1"],
    relationIds: [], eventIds: [], ideaIds: [], assertionIds: [], updatedAt: 100
  };
  assert.doesNotThrow(() => validateNarrativeDocumentProjectionManifest(valid));
  assert.throws(() => validateNarrativeDocumentProjectionManifest({
    ...valid, entityIds: ["entity-1", "entity-1"]
  }), /IDs duplicados/u);
  assert.throws(() => validateNarrativeDocumentProjectionManifest({
    ...valid, status: "deleted"
  }), /inventarios vacíos/u);
  assert.throws(() => validateNarrativeDocumentProjectionManifest({
    ...valid, generation: 0
  }), /Manifiesto/u);
});


test("publica manifiestos activos después de persistir el grafo y reutiliza revisiones idénticas", async () => {
  const snapshot = createNarrativeKnowledgeGraphSnapshot("novel-manifests", [
    { documentId: "chapter-1", revision: 3, text: "personaje Mara aparece." },
    { documentId: "chapter-2", revision: 2, text: "personaje Leo aparece." }
  ], { now: 300 });
  const { store, tables } = createMemoryStore();
  const first = await persistNarrativeKnowledgeGraphSnapshotWithManifests(store, snapshot, 301);
  assert.equal(first.manifests.length, 2);
  assert.ok(first.manifests.every(item => item.manifest.status === "active"));
  assert.equal(tables.manifests.size, 2);
  const second = await persistNarrativeKnowledgeGraphSnapshotWithManifests(store, snapshot, 302);
  assert.ok(second.manifests.every(item => item.reused));
  assert.equal(tables.manifests.size, 2);
});

test("retira un documento con tombstone CAS y rechaza una retirada obsoleta", async () => {
  const { store, tables } = createMemoryStore();
  const snapshot = createNarrativeKnowledgeGraphSnapshot("novel-delete", [
    { documentId: "chapter-1", revision: 4, text: "personaje Mara aparece." }
  ], { now: 400 });
  await persistNarrativeKnowledgeGraphSnapshotWithManifests(store, snapshot, 401);
  const retired = await retireNarrativeDocumentProjection(store, "novel-delete", "chapter-1", 5, 402);
  assert.equal(retired.manifest.status, "deleted");
  assert.deepEqual(retired.manifest.entityIds, []);
  const replay = await retireNarrativeDocumentProjection(store, "novel-delete", "chapter-1", 5, 403);
  assert.equal(replay.reused, true);
  assert.equal(tables.manifests.size, 1);
  await assert.rejects(
    retireNarrativeDocumentProjection(store, "novel-delete", "chapter-1", 4, 404),
    /posterior al manifiesto vigente/u
  );
});


test("reconcilia inventarios divergentes sin modificar registros ni manifiestos", async () => {
  const { store, tables } = createMemoryStore();
  const snapshot = createNarrativeKnowledgeGraphSnapshot("novel-reconcile", [
    { documentId: "chapter-a", revision: 1, text: "personaje Mara aparece." }
  ], { now: 500 });
  await persistNarrativeKnowledgeGraphSnapshotWithManifests(store, snapshot, 501);
  const clean = await reconcileNarrativeDocumentProjections(store, "novel-reconcile");
  assert.equal(clean.issues.length, 0);

  const key = "novel-reconcile" + "\\u0000" + "chapter-a";
  const manifest = tables.manifests.get(key);
  tables.manifests.set(key, {
    ...manifest,
    entityIds: [...manifest.entityIds, "entity:ghost"]
  });
  const beforeEntityCount = tables.entities.size;
  const report = await reconcileNarrativeDocumentProjections(store, "novel-reconcile");
  assert.ok(report.issues.some(issue =>
    issue.code === "stale-inventory-id" && issue.recordId === "entity:ghost"
  ));
  assert.equal(tables.entities.size, beforeEntityCount);
  assert.equal(tables.manifests.get(key).entityIds.includes("entity:ghost"), true);
});

test("detecta tombstones con evidencia residual y documentos sin manifiesto", async () => {
  const { store, tables } = createMemoryStore();
  const snapshot = createNarrativeKnowledgeGraphSnapshot("novel-orphans", [
    { documentId: "chapter-gone", revision: 2, text: "personaje Mara aparece." }
  ], { now: 600 });
  await persistNarrativeKnowledgeGraphSnapshotWithManifests(store, snapshot, 601);
  const key = "novel-orphans" + "\\u0000" + "chapter-gone";
  const current = tables.manifests.get(key);
  tables.manifests.set(key, {
    ...current, generation: current.generation + 1, revision: 3,
    status: "deleted", entityIds: [], relationIds: [], eventIds: [], ideaIds: [], assertionIds: []
  });
  const report = await reconcileNarrativeDocumentProjections(store, "novel-orphans");
  assert.ok(report.issues.some(issue => issue.code === "tombstone-has-evidence"));
  tables.manifests.delete(key);
  const missing = await reconcileNarrativeDocumentProjections(store, "novel-orphans");
  assert.ok(missing.issues.some(issue =>
    issue.code === "missing-manifest" && issue.documentId === "chapter-gone"
  ));
});


test("repara el inventario activo desde evidencia persistida mediante CAS", async () => {
  const { store, tables } = createMemoryStore();
  const snapshot = createNarrativeKnowledgeGraphSnapshot("novel-repair", [
    { documentId: "chapter-r", revision: 7, text: "personaje Mara aparece." }
  ], { now: 700 });
  await persistNarrativeKnowledgeGraphSnapshotWithManifests(store, snapshot, 701);
  const key = "novel-repair" + "\\u0000" + "chapter-r";
  const original = tables.manifests.get(key);
  const evidenceIds = [...original.entityIds];
  tables.manifests.set(key, {
    ...original, entityIds: [...original.entityIds, "entity:ghost"], relationIds: ["relation:ghost"]
  });
  const before = [...tables.entities.values()].map(item => structuredClone(item));
  const repaired = await repairNarrativeDocumentProjectionManifest(
    store, "novel-repair", "chapter-r", 702
  );
  assert.equal(repaired.changed, true);
  assert.equal(repaired.manifest.generation, original.generation + 1);
  assert.deepEqual(repaired.manifest.entityIds, evidenceIds);
  assert.deepEqual(repaired.manifest.relationIds, []);
  assert.deepEqual([...tables.entities.values()], before);
  const clean = await reconcileNarrativeDocumentProjections(store, "novel-repair");
  assert.equal(clean.issues.length, 0);
  const replay = await repairNarrativeDocumentProjectionManifest(
    store, "novel-repair", "chapter-r", 703
  );
  assert.equal(replay.changed, false);
  assert.equal(replay.reused, true);
});

test("rechaza reparar tombstones o manifiestos inexistentes sin mutar datos", async () => {
  const { store, tables } = createMemoryStore();
  const snapshot = createNarrativeKnowledgeGraphSnapshot("novel-repair-guard", [
    { documentId: "chapter-t", revision: 2, text: "personaje Mara aparece." }
  ], { now: 800 });
  await persistNarrativeKnowledgeGraphSnapshotWithManifests(store, snapshot, 801);
  const key = "novel-repair-guard" + "\\u0000" + "chapter-t";
  const active = tables.manifests.get(key);
  tables.manifests.set(key, {
    ...active, generation: active.generation + 1, revision: 3,
    status: "deleted", entityIds: [], relationIds: [], eventIds: [], ideaIds: [], assertionIds: []
  });
  await assert.rejects(
    repairNarrativeDocumentProjectionManifest(store, "novel-repair-guard", "chapter-t", 802),
    /No se reparan tombstones/u
  );
  await assert.rejects(
    repairNarrativeDocumentProjectionManifest(store, "novel-repair-guard", "missing", 802),
    /manifiesto inexistente/u
  );
  assert.equal(tables.manifests.get(key).status, "deleted");
});


test("reconcilia referencias cruzadas rotas sin modificar el grafo", async () => {
  const { store, tables } = createMemoryStore();
  const snapshot = createNarrativeKnowledgeGraphSnapshot("novel-refs", [
    { documentId: "chapter-refs", revision: 1, text: "personaje Mara aparece." }
  ], { now: 900 });
  await persistNarrativeKnowledgeGraphSnapshotWithManifests(store, snapshot, 901);
  const entity = [...tables.entities.values()][0];
  assert.ok(entity, "el snapshot debe aportar una entidad válida");
  tables.relations.set("relation:broken", {
    projectId: "novel-refs", id: "relation:broken",
    fromEntityId: entity.id, toEntityId: "entity:missing",
    relationType: "knows", evidence: []
  });
  tables.events.set("event:broken", {
    projectId: "novel-refs", id: "event:broken", label: "Encuentro",
    participants: ["entity:missing"], evidence: []
  });
  tables.assertions.set("assertion:broken", {
    projectId: "novel-refs", id: "assertion:broken",
    entityId: "entity:missing", entityName: "Desconocido",
    attribute: "role", value: "test",
    evidence: { documentId: "chapter-refs", revision: 1, start: 0, end: 1, excerpt: "x" },
    capturedAt: 902
  });
  const idea = [...tables.ideas.values()][0];
  if (idea) {
    tables.ideas.set(idea.id, {
      ...idea,
      relatedEntityIds: ["entity:missing"],
      relatedIdeaIds: ["idea:missing"]
    });
  } else {
    tables.ideas.set("idea:broken", {
      projectId: "novel-refs", id: "idea:broken", text: "Idea",
      status: "IDEA", originDocumentId: "chapter-refs", sourceProjectName: "Novela",
      evidence: [], relatedEntityIds: ["entity:missing"], relatedIdeaIds: ["idea:missing"]
    });
  }
  const before = JSON.stringify([...tables.relations, ...tables.events, ...tables.assertions, ...tables.ideas]);
  const report = await reconcileNarrativeDocumentProjections(store, "novel-refs");
  const codes = new Set(report.issues.map(issue => issue.code));
  assert.ok(codes.has("missing-relation-entity"));
  assert.ok(codes.has("missing-event-participant"));
  assert.ok(codes.has("missing-assertion-entity"));
  assert.ok(codes.has("missing-related-entity"));
  assert.ok(codes.has("missing-related-idea"));
  assert.ok(report.issues.some(issue => issue.recordId === "relation:broken" && issue.referenceField === "toEntityId"));
  assert.ok(report.issues.some(issue => issue.recordId === "event:broken" && issue.referenceField === "participants"));
  assert.ok(report.issues.some(issue => issue.recordId === "assertion:broken" && issue.referenceField === "entityId"));
  assert.equal(
    JSON.stringify([...tables.relations, ...tables.events, ...tables.assertions, ...tables.ideas]),
    before,
    "la reconciliación no debe mutar registros"
  );
});


test("distingue ambos extremos rotos de una relación reflexiva", async () => {
  const { store, tables } = createMemoryStore();
  tables.entities.set("entity:canonical", {
    projectId: "novel-self", id: "entity:canonical", kind: "character",
    canonicalName: "Mara", normalizedName: "mara", aliases: [],
    mergedFromIds: ["entity:legacy"], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  });
  tables.relations.set("relation:self", {
    projectId: "novel-self", id: "relation:self",
    fromEntityId: "entity:legacy", toEntityId: "entity:legacy",
    relationType: "knows", evidence: []
  });
  const report = await reconcileNarrativeDocumentProjections(store, "novel-self");
  const issues = report.issues.filter(issue => issue.recordId === "relation:self");
  assert.deepEqual(issues.map(issue => issue.referenceField).sort(), ["fromEntityId", "toEntityId"]);
  const proposals = await proposeNarrativeReferenceRepairs(store, report);
  assert.deepEqual(proposals.map(item => item.referenceField).sort(), ["fromEntityId", "toEntityId"]);
  assert.notEqual(
    proposals.find(item => item.referenceField === "fromEntityId").referenceField,
    proposals.find(item => item.referenceField === "toEntityId").referenceField
  );
  for (const proposal of proposals) await applyNarrativeReferenceRepair(store, proposal, true, 20);
  const repaired = tables.relations.get("relation:self");
  assert.equal(repaired.fromEntityId, "entity:canonical");
  assert.equal(repaired.toEntityId, "entity:canonical");
  const audits = await store.loadNarrativeReferenceRepairAudits("novel-self");
  assert.equal(audits.length, 2);
  assert.notEqual(audits[0].operationId, audits[1].operationId);
});

test("propone reparación sólo ante una correspondencia de merge explícita y única", async () => {
  const { store, tables } = createMemoryStore();
  tables.entities.set("entity:canonical", {
    projectId: "novel-repair", id: "entity:canonical", kind: "character",
    canonicalName: "Mara", normalizedName: "mara", aliases: [],
    mergedFromIds: ["entity:legacy"], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  });
  const report = {
    projectId: "novel-repair", checkedManifests: 0, checkedRecords: 1,
    issues: [
      { code: "missing-relation-entity", documentId: "", recordType: "relation",
        recordId: "relation:1", relatedId: "entity:legacy", referenceField: "fromEntityId", detail: "missing" },
      { code: "missing-event-participant", documentId: "", recordType: "event",
        recordId: "event:1", relatedId: "entity:unknown", referenceField: "participants", detail: "missing" },
      { code: "missing-related-idea", documentId: "", recordType: "idea",
        recordId: "idea:1", relatedId: "idea:unknown", detail: "missing" }
    ]
  };
  const proposals = await proposeNarrativeReferenceRepairs(store, report);
  assert.equal(proposals.length, 2);
  assert.deepEqual(proposals[0], {
    projectId: "novel-repair", issueCode: "missing-relation-entity",
    recordType: "relation", recordId: "relation:1",
    missingReferenceId: "entity:legacy", referenceField: "fromEntityId",
    candidateEntityId: "entity:canonical", resolution: "explicit-merge-match"
  });
  assert.equal(proposals[1].resolution, "manual-review");
  assert.equal(proposals[1].candidateEntityId, undefined);
  assert.equal(tables.entities.size, 1, "la generación de propuestas no escribe");
});


test("rechaza replay de relación si la entidad candidata sólo ocupa el extremo opuesto", async () => {
  const { store, tables } = createMemoryStore();
  tables.entities.set("entity:canonical", {
    projectId: "novel-field", id: "entity:canonical", kind: "character",
    canonicalName: "Mara", normalizedName: "mara", aliases: [],
    mergedFromIds: ["entity:legacy"], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  });
  tables.relations.set("relation:field", {
    projectId: "novel-field", id: "relation:field",
    fromEntityId: "entity:other", toEntityId: "entity:canonical",
    relationType: "knows", evidence: []
  });
  const proposal = {
    projectId: "novel-field", issueCode: "missing-relation-entity",
    recordType: "relation", recordId: "relation:field",
    missingReferenceId: "entity:legacy", referenceField: "fromEntityId",
    candidateEntityId: "entity:canonical", resolution: "explicit-merge-match"
  };
  await assert.rejects(
    applyNarrativeReferenceRepair(store, proposal, true, 10),
    /extremo indicado/
  );
  assert.equal((await store.loadNarrativeReferenceRepairAudits("novel-field")).length, 0);
});

test("aplica reparación aprobada de relación mediante CAS y devuelve auditoría", async () => {
  const { store, tables } = createMemoryStore();
  tables.entities.set("entity:canonical", {
    projectId: "novel-apply", id: "entity:canonical", kind: "character",
    canonicalName: "Mara", normalizedName: "mara", aliases: [],
    mergedFromIds: ["entity:legacy"], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  });
  tables.relations.set("relation:1", {
    projectId: "novel-apply", id: "relation:1",
    fromEntityId: "entity:legacy", toEntityId: "entity:canonical",
    relationType: "knows", evidence: []
  });
  const proposal = {
    projectId: "novel-apply", issueCode: "missing-relation-entity",
    recordType: "relation", recordId: "relation:1",
    missingReferenceId: "entity:legacy", referenceField: "fromEntityId", candidateEntityId: "entity:canonical",
    resolution: "explicit-merge-match"
  };
  await assert.rejects(
    applyNarrativeReferenceRepair(store, proposal, false, 10),
    /aprobación explícita/
  );
  const result = await applyNarrativeReferenceRepair(store, proposal, true, 11);
  assert.equal(result.changed, true);
  assert.equal(result.replayed, false);
  assert.equal(result.audit.before, "entity:legacy");
  assert.equal(result.audit.after, "entity:canonical");
  assert.equal(result.audit.appliedAt, 11);
  assert.ok(result.audit.operationId);
  assert.equal(tables.relations.get("relation:1").fromEntityId, "entity:canonical");
  const durableAudit = await store.loadNarrativeReferenceRepairAudits("novel-apply");
  assert.equal(durableAudit.length, 1);
  assert.equal(durableAudit[0].missingReferenceId, "entity:legacy");
  const replay = await applyNarrativeReferenceRepair(store, proposal, true, 12);
  assert.equal(replay.changed, false);
  assert.equal(replay.replayed, true);
  assert.equal((await store.loadNarrativeReferenceRepairAudits("novel-apply")).length, 1,
    "un reintento no debe duplicar la auditoría");
});

test("reanuda una intención durable cuando el CAS todavía no había ocurrido", async () => {
  const { store, tables } = createMemoryStore();
  tables.entities.set("entity:canonical", {
    projectId: "novel-pending-before-cas", id: "entity:canonical", kind: "character",
    canonicalName: "Mara", normalizedName: "mara", aliases: [],
    mergedFromIds: ["entity:legacy"], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  });
  tables.relations.set("relation:pending", {
    projectId: "novel-pending-before-cas", id: "relation:pending",
    fromEntityId: "entity:legacy", toEntityId: "entity:other",
    relationType: "knows", evidence: []
  });
  const pending = {
    operationId: "reference-repair|novel-pending-before-cas|relation|relation:pending|fromEntityId|entity:legacy|entity:canonical",
    projectId: "novel-pending-before-cas", issueCode: "missing-relation-entity",
    recordType: "relation", recordId: "relation:pending", referenceField: "fromEntityId",
    missingReferenceId: "entity:legacy", replacementEntityId: "entity:canonical", appliedAt: 41
  };
  await store.saveNarrativeReferenceRepairPending(pending);
  const recovery = await recoverNarrativeReferenceRepairs(store, "novel-pending-before-cas");
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.pending.length, 0);
  assert.equal(tables.relations.get("relation:pending").fromEntityId, "entity:canonical");
  assert.equal(tables.audits.size, 1);
  assert.equal(tables.pendingRepairs.size, 0);
});

test("recupera una reparación confirmada cuyo guardado de auditoría falló", async () => {
  const { store, tables } = createMemoryStore();
  tables.entities.set("entity:canonical", {
    projectId: "novel-recovery", id: "entity:canonical", kind: "character",
    canonicalName: "Mara", normalizedName: "mara", aliases: [],
    mergedFromIds: ["entity:legacy"], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  });
  tables.relations.set("relation:recover", {
    projectId: "novel-recovery", id: "relation:recover",
    fromEntityId: "entity:legacy", toEntityId: "entity:other",
    relationType: "knows", evidence: []
  });
  const proposal = {
    projectId: "novel-recovery", issueCode: "missing-relation-entity",
    recordType: "relation", recordId: "relation:recover",
    missingReferenceId: "entity:legacy", referenceField: "fromEntityId",
    candidateEntityId: "entity:canonical", resolution: "explicit-merge-match"
  };
  const append = store.appendNarrativeReferenceRepairAudit;
  let failOnce = true;
  store.appendNarrativeReferenceRepairAudit = async entry => {
    if (failOnce) { failOnce = false; throw new Error("simulated audit write failure"); }
    return append(entry);
  };
  await assert.rejects(applyNarrativeReferenceRepair(store, proposal, true, 31), /simulated audit write failure/);
  assert.equal(tables.relations.get("relation:recover").fromEntityId, "entity:canonical");
  assert.equal(tables.pendingRepairs.size, 1);
  assert.equal(tables.audits.size, 0);

  const recovery = await recoverNarrativeReferenceRepairs(store, "novel-recovery");
  assert.equal(recovery.checked, 1);
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.pending.length, 0);
  assert.equal(tables.relations.get("relation:recover").fromEntityId, "entity:canonical",
    "la recuperación no debe aplicar una segunda mutación");
  assert.equal(tables.audits.size, 1);
  assert.equal(tables.pendingRepairs.size, 0);
});

test("verifica integridad durable y distingue cambios posteriores del registro", async () => {
  const { store, tables } = createMemoryStore();
  tables.entities.set("entity:canonical", {
    projectId: "novel-audit-check", id: "entity:canonical", kind: "character",
    canonicalName: "Mara", normalizedName: "mara", aliases: [],
    mergedFromIds: ["entity:legacy"], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  });
  tables.relations.set("relation:audit", {
    projectId: "novel-audit-check", id: "relation:audit",
    fromEntityId: "entity:legacy", toEntityId: "entity:other",
    relationType: "knows", evidence: []
  });
  const proposal = {
    projectId: "novel-audit-check", issueCode: "missing-relation-entity",
    recordType: "relation", recordId: "relation:audit",
    missingReferenceId: "entity:legacy", referenceField: "fromEntityId",
    candidateEntityId: "entity:canonical", resolution: "explicit-merge-match"
  };
  await applyNarrativeReferenceRepair(store, proposal, true, 21);
  const verified = await verifyNarrativeReferenceRepairAuditIntegrity(store, "novel-audit-check");
  assert.equal(verified.checkedEntries, 1);
  assert.equal(verified.intact, true);
  assert.deepEqual(verified.integrityIssues, []);
  assert.equal(verified.recordChecks[0].status, "matches-current-state");

  tables.relations.set("relation:audit", {
    ...tables.relations.get("relation:audit"), fromEntityId: "entity:later-change"
  });
  const historical = await verifyNarrativeReferenceRepairAuditIntegrity(store, "novel-audit-check");
  assert.equal(historical.intact, true, "un cambio posterior no altera la integridad histórica de la entrada");
  assert.equal(historical.recordChecks[0].status, "record-state-changed");

  const key = [...tables.audits.keys()][0];
  const entry = tables.audits.get(key);
  tables.audits.set(key, { ...entry, operationId: "tampered-operation-id" });
  const tampered = await verifyNarrativeReferenceRepairAuditIntegrity(store, "novel-audit-check");
  assert.equal(tampered.intact, false);
  assert.ok(tampered.integrityIssues.some(issue => issue.code === "operation-id-mismatch"));
});

test("rechaza aplicar propuesta si la procedencia de fusión ya no la respalda", async () => {
  const { store, tables } = createMemoryStore();
  tables.entities.set("entity:canonical", {
    projectId: "novel-stale", id: "entity:canonical", kind: "character",
    canonicalName: "Mara", normalizedName: "mara", aliases: [],
    mergedFromIds: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  });
  await assert.rejects(applyNarrativeReferenceRepair(store, {
    projectId: "novel-stale", issueCode: "missing-assertion-entity",
    recordType: "assertion", recordId: "assertion:1",
    missingReferenceId: "entity:legacy", referenceField: "entityId", candidateEntityId: "entity:canonical",
    resolution: "explicit-merge-match"
  }, true, 13), /correspondencia de fusión cambió/);
});


test("la carga del proyecto ejecuta recuperación durable antes de hidratarlo", async () => {
  const events = [];
  const store = {
    loadNarrativeReferenceRepairPending: async projectId => {
      events.push("recover:" + projectId);
      return [];
    },
    appendNarrativeReferenceRepairAudit: async () => {},
    deleteNarrativeReferenceRepairPending: async () => {}
  };

  const result = await loadNarrativeProjectAfterRepairRecovery(
    store,
    "project-startup",
    async () => {
      events.push("hydrate");
      return { id: "project-startup", ready: true };
    }
  );

  assert.deepEqual(events, ["recover:project-startup", "hydrate"]);
  assert.deepEqual(result.project, { id: "project-startup", ready: true });
  assert.deepEqual(result.recovery, {
    projectId: "project-startup",
    checked: 0,
    recovered: 0,
    pending: []
  });
});

test("la carga del proyecto no hidrata si no se puede inspeccionar la cola durable", async () => {
  let hydrated = false;
  const store = {
    loadNarrativeReferenceRepairPending: async () => {
      throw new Error("IndexedDB no disponible");
    },
    appendNarrativeReferenceRepairAudit: async () => {},
    deleteNarrativeReferenceRepairPending: async () => {}
  };

  await assert.rejects(
    loadNarrativeProjectAfterRepairRecovery(store, "project-startup-failure", async () => {
      hydrated = true;
      return {};
    }),
    /IndexedDB no disponible/
  );
  assert.equal(hydrated, false);
});


test("dos recuperaciones concurrentes del mismo proyecto comparten una sola ejecución", async () => {
  const { store } = createMemoryStore();
  let reads = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  store.loadNarrativeReferenceRepairPending = async () => {
    reads++;
    await gate;
    return [];
  };

  const first = recoverNarrativeReferenceRepairs(store, "concurrent-recovery-project");
  const second = recoverNarrativeReferenceRepairs(store, "concurrent-recovery-project");
  assert.equal(reads, 1, "la segunda llamada debe reutilizar la recuperación activa");
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult, secondResult);
  assert.deepEqual(firstResult, {
    projectId: "concurrent-recovery-project",
    checked: 0,
    recovered: 0,
    pending: []
  });
});


test("inspecciona reparaciones pendientes y distingue listas, aplicadas y conflictos", async () => {
  const { store, tables } = createMemoryStore();
  tables.entities.set("entity:canonical", {
    projectId: "inspection-project", id: "entity:canonical", kind: "character",
    canonicalName: "Mara", normalizedName: "mara", aliases: [],
    mergedFromIds: ["entity:legacy"], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  });
  tables.relations.set("relation:ready", {
    projectId: "inspection-project", id: "relation:ready",
    fromEntityId: "entity:legacy", toEntityId: "entity:other",
    relationType: "knows", evidence: []
  });
  tables.relations.set("relation:applied", {
    projectId: "inspection-project", id: "relation:applied",
    fromEntityId: "entity:canonical", toEntityId: "entity:other",
    relationType: "knows", evidence: []
  });
  tables.relations.set("relation:changed", {
    projectId: "inspection-project", id: "relation:changed",
    fromEntityId: "entity:unrelated", toEntityId: "entity:other",
    relationType: "knows", evidence: []
  });
  const makePending = (recordId, missing = "entity:legacy", replacement = "entity:canonical") => ({
    projectId: "inspection-project",
    operationId: ["reference-repair", "inspection-project", "relation", recordId,
      "fromEntityId", missing, replacement].join("|"),
    issueCode: "missing-relation-entity",
    recordType: "relation",
    recordId,
    referenceField: "fromEntityId",
    missingReferenceId: missing,
    replacementEntityId: replacement,
    appliedAt: 50
  });
  const malformed = {
    ...makePending("relation:ready"),
    operationId: ["reference-repair", "inspection-project", "relation", "relation:ready",
      "participants", "entity:legacy", "entity:canonical"].join("|"),
    referenceField: "participants"
  };
  for (const entry of [
    makePending("relation:ready"),
    makePending("relation:applied"),
    makePending("relation:changed"),
    makePending("relation:ready", "entity:unknown", "entity:missing"),
    malformed
  ]) {
    await store.saveNarrativeReferenceRepairPending(entry);
  }

  const inspection = await inspectNarrativeReferenceRepairPending(store, "inspection-project");
  assert.deepEqual(inspection.map(item => item.status), [
    "ready-to-recover", "already-applied", "record-changed",
    "replacement-not-proven", "invalid-intent"
  ]);
  assert.equal(tables.pendingRepairs.size, 5, "la inspección no debe borrar ni mutar intenciones");
  assert.equal(tables.audits.size, 0, "la inspección no debe escribir auditoría");
});


test("usa Web Locks para serializar la recuperación por proyecto entre pestañas", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const requested = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async (name, options, callback) => {
          requested.push({ name, options });
          return callback({ name, mode: options.mode });
        }
      }
    }
  });
  try {
    const { store } = createMemoryStore();
    const result = await recoverNarrativeReferenceRepairs(store, "cross-tab-project");
    assert.equal(result.checked, 0);
    assert.deepEqual(requested, [{
      name: "motor-literario:narrative-reference-repair:cross-tab-project",
      options: { mode: "exclusive" }
    }]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
  }
});


test("reconcilia cola de reparación, auditoría y diario remoto sin mutar sus fuentes", async () => {
  const { store, tables } = createMemoryStore();
  tables.entities.set("entity:canonical", {
    projectId: "reconcile-project", id: "entity:canonical", kind: "character",
    canonicalName: "Mara", normalizedName: "mara", aliases: [],
    mergedFromIds: ["entity:legacy"], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  });
  tables.relations.set("relation:pending", {
    projectId: "reconcile-project", id: "relation:pending",
    fromEntityId: "entity:legacy", toEntityId: "entity:other",
    relationType: "knows", evidence: []
  });
  const pending = {
    projectId: "reconcile-project",
    operationId: ["reference-repair", "reconcile-project", "relation", "relation:pending",
      "fromEntityId", "entity:legacy", "entity:canonical"].join("|"),
    issueCode: "missing-relation-entity",
    recordType: "relation",
    recordId: "relation:pending",
    referenceField: "fromEntityId",
    missingReferenceId: "entity:legacy",
    replacementEntityId: "entity:canonical",
    appliedAt: 42
  };
  await store.saveNarrativeReferenceRepairPending(pending);
  const journal = {
    loadOperations: async projectId => {
      assert.equal(projectId, "reconcile-project");
      return [
        { operationId: "sync:pending", writerId: "writer-a", sequence: 1, digest: "sha256:" + "a".repeat(64) },
        { operationId: "sync:applied", writerId: "writer-a", sequence: 2, digest: "sha256:" + "b".repeat(64), appliedAt: 80 }
      ];
    }
  };

  const report = await reconcileNarrativeRepairAndSyncState(store, "reconcile-project", journal);
  assert.equal(report.pendingRepairs.length, 1);
  assert.equal(report.pendingRepairs[0].status, "ready-to-recover");
  assert.equal(report.pendingRepairs[0].auditAlreadyRecorded, false);
  assert.equal(report.auditIntegrity.intact, true);
  assert.deepEqual(report.syncJournal, {
    checkedOperations: 2,
    pendingCount: 1,
    appliedCount: 1,
    pendingOperationIds: ["sync:pending"]
  });
  assert.equal(report.repairQueueConsistent, true);
  assert.equal(tables.pendingRepairs.size, 1);
  assert.equal(tables.audits.size, 0);
});
