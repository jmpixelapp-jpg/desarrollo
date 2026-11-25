import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi } from "../dist/motor-literario.js";

class MldbRecordsMemoryStore {
  documents = new Map();
  fragments = new Map();
  entities = new Map();
  relations = new Map();
  projectRecords = new Map();
  projectRelations = new Map();
  evidences = new Map();
  occurrences = new Map();
  recordNames = new Map();
  recordAttributes = new Map();
  relationAttributes = new Map();
  suggestions = new Map();
  authorizations = new Map();
  migrations = [];

  key(projectId, id) { return JSON.stringify([projectId, id]); }

  async saveDocument(document) {
    this.documents.set(this.key(document.projectId, document.documentId), structuredClone(document));
  }
  async loadDocument(projectId, documentId) {
    const result = this.documents.get(this.key(projectId, documentId));
    return result ? structuredClone(result) : undefined;
  }
  async saveEntity(entity) {
    this.entities.set(this.key(entity.projectId, entity.id), structuredClone(entity));
    this.projectRecords.set(this.key(entity.projectId, entity.id), {
      projectId: entity.projectId, id: entity.id, recordType: entity.kind,
      primaryName: entity.canonicalName ?? null, description: null,
      label: "REGISTRADO EN LA OBRA", state: "abierto",
      confidence: "HIGH", confirmationKind: "EXPLICIT", provenanceKind: "MOTOR",
      createdAt: entity.firstSeenAt ?? 0, updatedAt: entity.lastSeenAt ?? entity.firstSeenAt ?? 0,
      currentVersion: 1
    });
  }
  async loadProjectRecords(projectId) {
    return [...this.projectRecords.values()].filter(item => item.projectId === projectId)
      .map(item => structuredClone(item));
  }
  async saveProjectRecord(record, expectedCurrent) {
    const key = this.key(record.projectId, record.id);
    const current = this.projectRecords.get(key);
    if (expectedCurrent === undefined ? current !== undefined
      : !current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) throw new Error("record_conflict");
    const previousNames = [...this.recordNames.values()].filter(item =>
      item.projectId === record.projectId && item.recordId === record.id
    );
    for (const name of previousNames) {
      if (name.isPrimary && name.name !== record.primaryName) {
        this.recordNames.set(this.key(name.projectId, name.id), { ...name, isPrimary: false });
      }
    }
    if (record.primaryName !== null) {
      const match = previousNames.find(name => name.name === record.primaryName);
      if (match) this.recordNames.set(this.key(match.projectId, match.id), { ...match, isPrimary: true });
      else {
        const name = {
          projectId: record.projectId, id: "primary:" + record.id + ":" + record.currentVersion,
          recordId: record.id, name: record.primaryName, nameKind: "primary",
          isPrimary: true, provenanceKind: record.provenanceKind
        };
        this.recordNames.set(this.key(name.projectId, name.id), structuredClone(name));
      }
    }
    this.projectRecords.set(key, structuredClone(record));
  }
  async loadRecordNames(projectId, recordId) {
    return [...this.recordNames.values()].filter(item =>
      item.projectId === projectId && (recordId === undefined || item.recordId === recordId)
    ).map(item => structuredClone(item));
  }
  async saveRecordName(name, expectedCurrent) {
    const key = this.key(name.projectId, name.id);
    const current = this.recordNames.get(key);
    if (expectedCurrent === undefined ? current !== undefined
      : !current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) throw new Error("name_conflict");
    this.recordNames.set(key, structuredClone(name));
  }
  async loadEntities(projectId) {
    return [...this.entities.values()].filter(item => item.projectId === projectId).map(item => structuredClone(item));
  }
  async saveRelation(relation) {
    this.relations.set(this.key(relation.projectId, relation.id), structuredClone(relation));
    this.projectRelations.set(this.key(relation.projectId, relation.id), {
      projectId: relation.projectId, id: relation.id, relationType: relation.relationType,
      sourceRecordId: relation.fromEntityId ?? null, targetRecordId: relation.toEntityId ?? null,
      label: "REGISTRADO EN LA OBRA", state: "abierto",
      confirmationKind: "EXPLICIT", provenanceKind: "MOTOR", confidence: "HIGH",
      createdAt: 0, updatedAt: 0, currentVersion: 1
    });
  }
  async loadProjectRelations(projectId) {
    return [...this.projectRelations.values()].filter(item => item.projectId === projectId)
      .map(item => structuredClone(item));
  }
  async saveProjectRelation(relation, expectedCurrent) {
    if (relation.sourceRecordId &&
        !this.projectRecords.has(this.key(relation.projectId, relation.sourceRecordId))) {
      throw new Error("No existe la ficha de origen de la relación.");
    }
    if (relation.targetRecordId &&
        !this.projectRecords.has(this.key(relation.projectId, relation.targetRecordId))) {
      throw new Error("No existe la ficha de destino de la relación.");
    }
    const key = this.key(relation.projectId, relation.id);
    const current = this.projectRelations.get(key);
    if (expectedCurrent === undefined ? current !== undefined
      : !current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) throw new Error("relation_conflict");
    this.projectRelations.set(key, structuredClone(relation));
  }
  async loadRelations(projectId) {
    return [...this.relations.values()].filter(item => item.projectId === projectId).map(item => structuredClone(item));
  }

  async loadManuscriptFragments(projectId, documentId) {
    return [...this.fragments.values()].filter(item =>
      item.projectId === projectId && (documentId === undefined || item.documentId === documentId)
    ).map(item => structuredClone(item));
  }
  async saveManuscriptFragment(fragment, expectedCurrent) {
    if (fragment.documentId && !this.documents.has(this.key(fragment.projectId, fragment.documentId))) {
      throw new Error("document_missing");
    }
    if (fragment.parentFragmentId) {
      const parent = this.fragments.get(this.key(fragment.projectId, fragment.parentFragmentId));
      if (!parent || parent.documentId !== fragment.documentId) throw new Error("parent_missing");
    }
    const key = this.key(fragment.projectId, fragment.id);
    const current = this.fragments.get(key);
    if (expectedCurrent === undefined ? current !== undefined
      : !current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) throw new Error("fragment_conflict");
    this.fragments.set(key, structuredClone(fragment));
  }

  async loadRecordAttributes(projectId, recordId) {
    return [...this.recordAttributes.values()].filter(item =>
      item.projectId === projectId && item.recordId === recordId
    ).map(item => structuredClone(item));
  }
  async saveRecordAttribute(attribute, expectedCurrent) {
    if (!this.projectRecords.has(this.key(attribute.projectId, attribute.recordId))) throw new Error("No existe la ficha del atributo.");
    const key = this.key(attribute.projectId, attribute.id);
    const current = this.recordAttributes.get(key);
    if (expectedCurrent === undefined ? current !== undefined
      : !current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) throw new Error("attribute_conflict");
    this.recordAttributes.set(key, structuredClone(attribute));
  }

  async loadRelationAttributes(projectId, relationId) {
    return [...this.relationAttributes.values()].filter(item =>
      item.projectId === projectId && item.relationId === relationId
    ).map(item => structuredClone(item));
  }
  async saveRelationAttribute(attribute, expectedCurrent) {
    if (!this.projectRelations.has(this.key(attribute.projectId, attribute.relationId))) throw new Error("No existe la relación del atributo.");
    const key = this.key(attribute.projectId, attribute.id);
    const current = this.relationAttributes.get(key);
    if (expectedCurrent === undefined ? current !== undefined
      : !current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) throw new Error("attribute_conflict");
    this.relationAttributes.set(key, structuredClone(attribute));
  }

  async loadActiveSuggestions(projectId, documentId, status) {
    return [...this.suggestions.values()].filter(item =>
      item.projectId === projectId &&
      (documentId === undefined || item.documentId === documentId) &&
      (status === undefined || item.status === status)
    ).map(item => structuredClone(item));
  }
  async saveActiveSuggestion(suggestion, expectedCurrent) {
    if (suggestion.documentId && !this.documents.has(this.key(suggestion.projectId, suggestion.documentId))) {
      throw new Error("No existe el documento de la sugerencia.");
    }
    if (suggestion.fragmentId) {
      const fragment = this.fragments.get(this.key(suggestion.projectId, suggestion.fragmentId));
      if (!fragment || fragment.documentId !== suggestion.documentId) throw new Error("El fragmento de la sugerencia no existe o pertenece a otro documento.");
    }
    const key = this.key(suggestion.projectId, suggestion.id);
    const current = this.suggestions.get(key);
    if (expectedCurrent === undefined ? current !== undefined
      : !current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) throw new Error("suggestion_conflict");
    this.suggestions.set(key, structuredClone(suggestion));
  }

  async loadProjectEvidences(projectId, subjectKind, subjectId) {
    return [...this.evidences.values()].filter(item =>
      item.projectId === projectId &&
      (subjectKind === undefined || item.subjectKind === subjectKind) &&
      (subjectId === undefined ||
        (subjectKind === "RECORD" ? item.subjectRecordId === subjectId : item.subjectRelationId === subjectId))
    ).map(item => structuredClone(item));
  }
  async saveProjectEvidence(evidence, expectedCurrent) {
    const key = this.key(evidence.projectId, evidence.id);
    const current = this.evidences.get(key);
    if (expectedCurrent === undefined ? current !== undefined
      : !current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) throw new Error("evidence_conflict");
    if (evidence.subjectKind === "RECORD" &&
        !this.projectRecords.has(this.key(evidence.projectId, evidence.subjectRecordId))) {
      throw new Error("No existe la ficha de la evidencia.");
    }
    if (evidence.subjectKind === "RELATION" &&
        !this.projectRelations.has(this.key(evidence.projectId, evidence.subjectRelationId))) {
      throw new Error("No existe la relación de la evidencia.");
    }
    if (evidence.documentId && !this.documents.has(this.key(evidence.projectId, evidence.documentId))) {
      throw new Error("No existe el documento de la evidencia.");
    }
    if (evidence.fragmentId) {
      const fragment = this.fragments.get(this.key(evidence.projectId, evidence.fragmentId));
      if (!fragment || fragment.documentId !== evidence.documentId) throw new Error("El fragmento de evidencia no existe en el documento.");
    }
    this.evidences.set(key, structuredClone(evidence));
  }
  async loadTimelineOccurrences(projectId, eventRecordId, trackId) {
    return [...this.occurrences.values()].filter(item =>
      item.projectId === projectId &&
      (eventRecordId === undefined || item.eventRecordId === eventRecordId) &&
      (trackId === undefined || item.trackId === trackId)
    ).map(item => structuredClone(item));
  }
  async saveTimelineOccurrence(occurrence, expectedCurrent) {
    const key = this.key(occurrence.projectId, occurrence.id);
    const current = this.occurrences.get(key);
    if (expectedCurrent === undefined ? current !== undefined
      : !current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) throw new Error("occurrence_conflict");
    if (occurrence.eventRecordId &&
        !this.projectRecords.has(this.key(occurrence.projectId, occurrence.eventRecordId))) {
      throw new Error("No existe la ficha de evento.");
    }
    this.occurrences.set(key, structuredClone(occurrence));
  }

  async loadImportAuthorizations(writerId) {
    return [...this.authorizations.values()].filter(item => item.writerId === writerId)
      .map(item => structuredClone(item));
  }
  async appendImportAuthorization(authorization) {
    const key = JSON.stringify([
      authorization.writerId, authorization.sourceProjectId,
      authorization.targetProjectId, authorization.authorizationId
    ]);
    if (this.authorizations.has(key)) throw new Error("authorization_exists");
    this.authorizations.set(key, structuredClone(authorization));
  }
  async loadSchemaMigrations() { return structuredClone(this.migrations); }
}

const project = { projectId: "book-a", projectName: "Libro A", writerId: "writer-a" };
const document = {
  projectId: "book-a", documentId: "chapter-1", text: "Ana llega.",
  revision: 1, sequence: 1, updatedAt: 1
};
const entity = {
  projectId: "book-a", id: "record-ana", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [], evidence: [],
  firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};
const relation = {
  projectId: "book-a", id: "relation-ana-bruno",
  fromEntityId: "record-ana", toEntityId: "record-bruno",
  relationType: "ally", evidence: []
};
const fragment = (overrides = {}) => ({
  id: "fragment-1", documentId: "chapter-1", parentFragmentId: null,
  fragmentKind: "paragraph", currentText: "Ana llega.",
  startOffset: 0, endOffset: 10, revision: 1, isCurrent: true, ...overrides
});

test("las fichas genéricas admiten nombre nulo y sincronizan nombres principales sin perder alias", async () => {
  const store = new MldbRecordsMemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  const base = {
    id: "record-unnamed", recordType: "culture", primaryName: null, description: null,
    label: "IDEA", state: "abierto", confidence: "UNKNOWN",
    confirmationKind: "UNKNOWN", provenanceKind: "WRITER",
    createdAt: 1, updatedAt: 1
  };
  const unnamed = await api.saveProjectRecord(base);
  assert.equal(unnamed.primaryName, null);
  assert.equal((await api.getProjectRecords()).length, 1);
  assert.deepEqual(await api.getRecordNames("record-unnamed"), []);

  await api.saveProjectRecord({ ...base, primaryName: "Lunarios", updatedAt: 2 });
  assert.equal((await api.getRecordNames("record-unnamed")).filter(name => name.isPrimary)[0].name, "Lunarios");
  await api.saveRecordName({
    id: "old-name", recordId: "record-unnamed", name: "Pueblo lunar",
    nameKind: "alias", languageCode: "es", isPrimary: false, provenanceKind: "WRITER"
  });
  await api.saveProjectRecord({ ...base, primaryName: "Lunarianos", updatedAt: 3 });
  const names = await api.getRecordNames("record-unnamed");
  assert.equal(names.some(name => name.name === "Lunarios" && name.isPrimary), false);
  assert.equal(names.some(name => name.name === "Lunarios" && !name.isPrimary), true);
  assert.equal(names.find(name => name.isPrimary).name, "Lunarianos");
});

test("las relaciones genéricas conservan tipo, extremos opcionales y estado propio", async () => {
  const store = new MldbRecordsMemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  await api.saveProjectRecord({
    id: "record-origin", recordType: "character", primaryName: "Ana", description: null,
    label: "REGISTRADO EN LA OBRA", state: "abierto", confidence: "HIGH",
    confirmationKind: "EXPLICIT", provenanceKind: "WRITER", createdAt: 1, updatedAt: 1
  });
  const saved = await api.saveProjectRelation({
    id: "relation-one", relationType: "protege", sourceRecordId: "record-origin",
    targetRecordId: null, label: "IDEA", state: "abierto",
    confirmationKind: "INFERRED", provenanceKind: "MOTOR", confidence: "MEDIUM",
    createdAt: 2, updatedAt: 2
  });
  assert.equal(saved.targetRecordId, null);
  assert.equal((await api.getProjectRelations())[0].relationType, "protege");
  await assert.rejects(api.saveProjectRelation({
    id: "relation-bad", relationType: "parent_of", sourceRecordId: "missing-record",
    targetRecordId: null, label: "IDEA", state: "abierto",
    confirmationKind: "UNKNOWN", provenanceKind: "WRITER", confidence: "LOW",
    createdAt: 2, updatedAt: 2
  }), /ficha de origen/);
});

test("las evidencias validan sujeto exclusivo y anclaje de documento y fragmento", async () => {
  const store = new MldbRecordsMemoryStore();
  await store.saveDocument(document);
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  await api.saveProjectRecord({
    id: "record-evidence", recordType: "character", primaryName: "Ana", description: null,
    label: "REGISTRADO EN LA OBRA", state: "abierto", confidence: "HIGH",
    confirmationKind: "EXPLICIT", provenanceKind: "WRITER", createdAt: 1, updatedAt: 1
  });
  await api.saveManuscriptFragment(fragment());
  const saved = await api.saveProjectEvidence({
    id: "evidence-one", subjectKind: "RECORD",
    subjectRecordId: "record-evidence", subjectRelationId: null,
    documentId: "chapter-1", fragmentId: "fragment-1", evidenceText: "Ana llega.",
    chapterLabel: "Capítulo 1", pageNumber: 1, lineNumber: 1,
    startOffset: 0, endOffset: 10, documentRevision: 1,
    evidenceKind: "EXPLICIT", provenanceKind: "WRITER", isCurrent: true
  });
  assert.equal(saved.subjectKind, "RECORD");
  assert.equal((await api.getProjectEvidences("RECORD", "record-evidence")).length, 1);
  await assert.rejects(api.saveProjectEvidence({
    id: "evidence-bad", subjectKind: "RECORD",
    subjectRecordId: "record-evidence", subjectRelationId: "foreign-relation",
    documentId: null, fragmentId: null, evidenceText: null, chapterLabel: null,
    pageNumber: null, lineNumber: null, startOffset: null, endOffset: null,
    documentRevision: null, evidenceKind: "EXPLICIT", provenanceKind: "WRITER", isCurrent: true
  }), /no puede referenciar una relación/);
});

test("las ocurrencias cronológicas enlazan un evento sin inventar orden ni fecha", async () => {
  const store = new MldbRecordsMemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  await api.saveProjectRecord({
    id: "record-event", recordType: "event", primaryName: null, description: null,
    label: "REGISTRADO EN LA OBRA", state: "abierto", confidence: "MEDIUM",
    confirmationKind: "INFERRED", provenanceKind: "MOTOR", createdAt: 1, updatedAt: 1
  });
  const occurrence = await api.saveTimelineOccurrence({
    id: "occurrence-one", eventRecordId: "record-event", trackId: null,
    timeValue: { kind: "UNKNOWN", reason: "El texto no fija fecha" },
    narrativeOrder: null, causalLinks: [], provenanceKind: "MOTOR", confidence: "LOW"
  });
  assert.equal(occurrence.narrativeOrder, null);
  assert.deepEqual((await api.getTimelineOccurrences("record-event"))[0].timeValue.kind, "UNKNOWN");
});

test("persiste fragmentos con offsets, revisión y jerarquía del mismo documento", async () => {
  const store = new MldbRecordsMemoryStore();
  await store.saveDocument(document);
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  const root = await api.saveManuscriptFragment(fragment());
  const child = await api.saveManuscriptFragment(fragment({
    id: "fragment-2", parentFragmentId: "fragment-1",
    fragmentKind: "sentence", currentText: "Ana llega.", startOffset: 0, endOffset: 10
  }));
  assert.equal(root.projectId, "book-a");
  assert.equal(child.parentFragmentId, "fragment-1");
  assert.deepEqual((await api.getManuscriptFragments("chapter-1")).map(item => item.id), ["fragment-1", "fragment-2"]);
  await assert.rejects(
    api.saveManuscriptFragment(fragment({ id: "fragment-bad", startOffset: 3, endOffset: null })),
    /offsets/
  );
});

test("los atributos dinámicos de fichas persisten JSON y exigen ficha del mismo libro", async () => {
  const store = new MldbRecordsMemoryStore();
  await store.saveEntity(entity);
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  const saved = await api.saveRecordAttribute({
    id: "attribute-age", recordId: "record-ana", attributeKey: "age",
    value: { years: 24, certainty: "explicit" }, valueStatus: "EXPLICIT",
    provenanceKind: "WRITER", confidence: "HIGH"
  });
  assert.equal(saved.attributeKey, "age");
  assert.deepEqual((await api.getRecordAttributes("record-ana"))[0].value, { years: 24, certainty: "explicit" });
  await assert.rejects(api.saveRecordAttribute({
    id: "attribute-missing", recordId: "foreign-record", attributeKey: "title",
    value: "Duke", valueStatus: "EXPLICIT", provenanceKind: "WRITER", confidence: "HIGH"
  }), /No existe/);
});

test("los atributos dinámicos de relaciones permanecen ligados a la relación", async () => {
  const store = new MldbRecordsMemoryStore();
  await store.saveRelation(relation);
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  const saved = await api.saveRelationAttribute({
    id: "relation-attribute-1", relationId: "relation-ana-bruno",
    attributeKey: "loyalty", value: 0.8, provenanceKind: "MOTOR", confidence: "MEDIUM"
  });
  assert.equal(saved.relationId, relation.id);
  assert.equal((await api.getRelationAttributes(relation.id))[0].value, 0.8);
  await assert.rejects(api.saveRelationAttribute({
    id: "relation-attribute-2", relationId: "missing-relation",
    attributeKey: "trust", value: "high", provenanceKind: "WRITER", confidence: "HIGH"
  }), /No existe/);
});

test("las sugerencias conservan su revisión y referencias a documento y fragmento", async () => {
  const store = new MldbRecordsMemoryStore();
  await store.saveDocument(document);
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  await api.saveManuscriptFragment(fragment());
  const suggestion = await api.saveActiveSuggestion({
    id: "suggestion-1", moduleId: "proofreading",
    documentId: "chapter-1", fragmentId: "fragment-1", documentRevision: 1,
    suggestionKind: "repetition", priority: "MEDIUM", confidence: "HIGH",
    payload: { message: "Repetición cercana", start: 0, end: 3 },
    status: "ACTIVE", createdAt: 100
  });
  assert.equal(suggestion.status, "ACTIVE");
  assert.equal((await api.getActiveSuggestions("chapter-1", "ACTIVE")).length, 1);
  await api.saveActiveSuggestion({ ...suggestion, status: "ACCEPTED" });
  assert.equal((await api.getActiveSuggestions("chapter-1", "ACTIVE")).length, 0);
  assert.equal((await api.getActiveSuggestions("chapter-1", "ACCEPTED")).length, 1);
  await assert.rejects(api.saveActiveSuggestion({
    id: "suggestion-bad", moduleId: "proofreading",
    documentId: "chapter-1", fragmentId: "foreign-fragment", documentRevision: 1,
    suggestionKind: "grammar", priority: "HIGH", confidence: "HIGH",
    payload: {}, status: "ACTIVE", createdAt: 100
  }), /fragment/);
});

test("las autorizaciones exigen identidades verificadas del mismo escritor", async () => {
  const store = new MldbRecordsMemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  const source = { projectId: "book-a", projectName: "Libro A", writerId: "writer-a" };
  const target = { projectId: "book-b", projectName: "Libro B", writerId: "writer-a" };
  const authorization = await api.authorizeImportBetweenProjects(
    source, target, "auth-1", { records: ["record-ana"], includeEvidence: true }, 150
  );
  assert.equal(authorization.writerId, "writer-a");
  assert.equal((await api.getImportAuthorizations()).length, 1);

  await assert.rejects(
    api.authorizeImportBetweenProjects(
      source, { ...target, writerId: "writer-b" }, "auth-2", { records: ["*"] }, 151
    ),
    /mismo escritor/
  );
  await assert.rejects(
    api.authorizeImportBetweenProjects(
      source, { ...target, projectId: "book-a" }, "auth-3", {}, 151
    ),
    /proyectos distintos/
  );
});

test("el historial de migraciones se lee con orden de versión", async () => {
  const store = new MldbRecordsMemoryStore();
  store.migrations = [
    { migrationId: "v18", fromVersion: "17", toVersion: "18", appliedAt: 180, result: "APPLIED", checksum: "c18" },
    { migrationId: "v17", fromVersion: "16", toVersion: "17", appliedAt: 170, result: "APPLIED", checksum: "c17" }
  ];
  const api = new HostEngineApi({ store });
  const items = await api.getSchemaMigrations();
  assert.deepEqual(items.map(item => item.toVersion), ["17", "18"]);
});

test("las fichas admiten tipos narrativos extensibles sin convertirlos en personajes", async () => {
  const store = new MldbRecordsMemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject(project);
  await store.saveEntity({
    projectId: "book-a", id: "record-culture", kind: "culture",
    canonicalName: "Lunarios", normalizedName: "lunarios", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  });
  const entities = await api.getNarrativeEntities();
  assert.equal(entities.find(item => item.id === "record-culture").kind, "culture");
});
