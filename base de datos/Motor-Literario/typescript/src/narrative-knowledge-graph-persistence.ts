import type { ProjectStore } from "./contracts";
import {
  mergeNarrativeEntity,
  mergeNarrativeRelation,
  mergeNarrativeEvent,
  mergeNarrativeIdea,
  type NarrativeEntity,
  type NarrativeRelation,
  type NarrativeEvent,
  type NarrativeIdea,
  type TextEvidence
} from "./narrative-knowledge";
import type { NarrativeAssertion } from "./narrative-history";
import type { NarrativeKnowledgeGraphSnapshot } from "./narrative-knowledge-graph-incremental";
import type { NarrativeDocumentProjectionManifest } from "./contracts";


/** Sustituye únicamente la contribución del documento; nunca descarta evidencia ajena. */
function withoutDocumentEvidence<T extends { readonly evidence: readonly { readonly documentId: string }[] }>(
  record: T,
  documentId: string
): T {
  return {
    ...record,
    evidence: record.evidence.filter(item => item.documentId !== documentId)
  };
}

function snapshotDocumentIds(snapshot: NarrativeKnowledgeGraphSnapshot): readonly string[] {
  const ids = snapshot.documents.map(document => document.input.documentId);
  if (ids.some(id => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error("El snapshot contiene documentos duplicados o inválidos.");
  }
  return ids;
}

/**
 * Construye el manifiesto de una contribución documental del snapshot.
 * La generación debe proceder de la lectura CAS del manifiesto anterior.
 */
export function createNarrativeDocumentProjectionManifest(
  snapshot: NarrativeKnowledgeGraphSnapshot,
  documentId: string,
  generation: number,
  updatedAt = Date.now()
): NarrativeDocumentProjectionManifest {
  if (!snapshot || !Array.isArray(snapshot.documents) ||
      typeof documentId !== "string" || !documentId.trim() ||
      !Number.isSafeInteger(generation) || generation < 1 ||
      !Number.isFinite(updatedAt) || updatedAt < 0) {
    throw new Error("Contexto inválido para construir el manifiesto documental.");
  }
  const contribution = snapshot.documents.find((item: NarrativeKnowledgeGraphSnapshot["documents"][number]) =>
    item.input.documentId === documentId);
  if (!contribution) throw new Error("El documento no forma parte del snapshot: " + documentId);
  type EvidenceBackedRecord = {
    readonly id: string;
    readonly evidence: readonly TextEvidence[];
  };
  const ids = (items: readonly EvidenceBackedRecord[]): string[] =>
    [...new Set(items
      .filter((item: EvidenceBackedRecord) =>
        item.evidence.some((evidence: TextEvidence) => evidence.documentId === documentId))
      .map((item: EvidenceBackedRecord) => item.id))].sort();
  const assertions = contribution.graph.assertions.map((item: NarrativeAssertion) => item.id).sort();
  return {
    projectId: snapshot.projectId,
    documentId,
    revision: contribution.input.revision,
    generation,
    status: "active",
    entityIds: ids(contribution.graph.entities),
    relationIds: ids(contribution.graph.relations),
    eventIds: ids(contribution.graph.events),
    ideaIds: ids(contribution.graph.ideas),
    assertionIds: assertions,
    updatedAt
  };
}

/**
 * Valida el contrato durable de un manifiesto antes de usarlo como estado CAS.
 * Los inventarios deben ser únicos; un tombstone nunca puede conservar IDs activos.
 */
export function validateNarrativeDocumentProjectionManifest(
  value: NarrativeDocumentProjectionManifest
): void {
  if (!value || typeof value !== "object" ||
      typeof value.projectId !== "string" || !value.projectId.trim() || value.projectId.length > 256 ||
      typeof value.documentId !== "string" || !value.documentId.trim() || value.documentId.length > 256 ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      (value.status !== "active" && value.status !== "deleted") ||
      !Number.isFinite(value.updatedAt) || value.updatedAt < 0) {
    throw new Error("Manifiesto de proyección narrativa inválido: identidad, versión o estado incorrectos.");
  }
  const inventories = [
    value.entityIds, value.relationIds, value.eventIds, value.ideaIds, value.assertionIds
  ];
  for (const inventory of inventories) {
    if (!Array.isArray(inventory) || inventory.length > 100_000 ||
        inventory.some(id => typeof id !== "string" || !id.trim() || id.length > 512) ||
        new Set(inventory).size !== inventory.length) {
      throw new Error("El manifiesto contiene inventarios inválidos o IDs duplicados.");
    }
  }
  if (value.status === "deleted" && inventories.some(inventory => inventory.length > 0)) {
    throw new Error("Un tombstone documental debe tener inventarios vacíos.");
  }
}

/** Crea el tombstone explícito de un documento retirado del proyecto. */
export function createNarrativeDocumentProjectionTombstone(
  projectId: string,
  documentId: string,
  revision: number,
  generation: number,
  updatedAt = Date.now()
): NarrativeDocumentProjectionManifest {
  if (typeof projectId !== "string" || !projectId.trim() ||
      typeof documentId !== "string" || !documentId.trim() ||
      !Number.isSafeInteger(revision) || revision < 0 ||
      !Number.isSafeInteger(generation) || generation < 1 ||
      !Number.isFinite(updatedAt) || updatedAt < 0) {
    throw new Error("Contexto inválido para crear tombstone documental.");
  }
  return {
    projectId, documentId, revision, generation, status: "deleted",
    entityIds: [], relationIds: [], eventIds: [], ideaIds: [], assertionIds: [], updatedAt
  };
}

/**
 * Confirma el manifiesto de un documento usando generación CAS.
 * La misma revisión y el mismo contenido son idempotentes; revisiones antiguas
 * o divergentes se rechazan para impedir que una pestaña obsoleta restaure estado.
 */
export async function commitNarrativeDocumentProjectionManifest(
  store: ProjectStore,
  candidate: NarrativeDocumentProjectionManifest
): Promise<{ readonly manifest: NarrativeDocumentProjectionManifest; readonly reused: boolean }> {
  if (!store || typeof store.loadNarrativeDocumentProjectionManifest !== "function" ||
      typeof store.saveNarrativeDocumentProjectionManifestIfUnchanged !== "function") {
    throw new Error("El almacenamiento no implementa manifiestos documentales CAS.");
  }
  validateNarrativeDocumentProjectionManifest(candidate);
  const current = await store.loadNarrativeDocumentProjectionManifest(
    candidate.projectId, candidate.documentId
  );
  if (current && candidate.revision < current.revision) {
    throw new Error("Revisión documental obsoleta: no se puede retroceder el manifiesto.");
  }
  const comparable = (value: NarrativeDocumentProjectionManifest) => JSON.stringify({
    projectId: value.projectId, documentId: value.documentId, revision: value.revision,
    status: value.status, entityIds: [...value.entityIds].sort(),
    relationIds: [...value.relationIds].sort(), eventIds: [...value.eventIds].sort(),
    ideaIds: [...value.ideaIds].sort(), assertionIds: [...value.assertionIds].sort()
  });
  if (current && candidate.revision === current.revision) {
    if (comparable(current) === comparable(candidate)) return { manifest: current, reused: true };
    throw new Error("La misma revisión documental no puede producir manifiestos divergentes.");
  }
  const generation = (current?.generation ?? 0) + 1;
  const manifest: NarrativeDocumentProjectionManifest = {
    ...candidate, generation,
    entityIds: [...candidate.entityIds], relationIds: [...candidate.relationIds],
    eventIds: [...candidate.eventIds], ideaIds: [...candidate.ideaIds],
    assertionIds: [...candidate.assertionIds]
  };
  await store.saveNarrativeDocumentProjectionManifestIfUnchanged(manifest, current?.generation);
  return { manifest, reused: false };
}

/**
 * Persiste el grafo y después publica el inventario durable por documento.
 *
 * El orden es deliberado: nunca se publica un manifiesto activo antes de que
 * sus registros hayan sido guardados. No es una transacción distribuida; si
 * falla un CAS de manifiesto, el grafo queda reintentable y el manifiesto
 * anterior sigue siendo la referencia durable hasta reconciliación.
 */
export async function persistNarrativeKnowledgeGraphSnapshotWithManifests(
  store: ProjectStore,
  snapshot: NarrativeKnowledgeGraphSnapshot,
  updatedAt = Date.now()
): Promise<{
  readonly persistence: NarrativeKnowledgeGraphPersistenceResult;
  readonly manifests: readonly {
    readonly manifest: NarrativeDocumentProjectionManifest;
    readonly reused: boolean;
  }[];
}> {
  if (!store || typeof store.loadNarrativeDocumentProjectionManifest !== "function" ||
      typeof store.saveNarrativeDocumentProjectionManifestIfUnchanged !== "function") {
    throw new Error("El almacenamiento no implementa manifiestos documentales CAS.");
  }
  if (!Number.isFinite(updatedAt) || updatedAt < 0) {
    throw new Error("Marca temporal inválida para publicar manifiestos documentales.");
  }
  const persistence = await persistNarrativeKnowledgeGraphSnapshot(store, snapshot);
  const manifests: Array<{
    manifest: NarrativeDocumentProjectionManifest;
    reused: boolean;
  }> = [];
  for (const documentId of snapshotDocumentIds(snapshot)) {
    const current = await store.loadNarrativeDocumentProjectionManifest!(
      snapshot.projectId, documentId
    );
    const generation = (current?.generation ?? 0) + 1;
    const candidate = createNarrativeDocumentProjectionManifest(
      snapshot, documentId, generation, updatedAt
    );
    manifests.push(await commitNarrativeDocumentProjectionManifest(store, candidate));
  }
  return { persistence, manifests };
}

/**
 * Retira un documento mediante tombstone CAS. La revisión debe ser posterior
 * a la última revisión activa: un borrado obsoleto nunca puede retirar una
 * proyección más reciente.
 */
export async function retireNarrativeDocumentProjection(
  store: ProjectStore,
  projectId: string,
  documentId: string,
  deletionRevision: number,
  updatedAt = Date.now()
): Promise<{ readonly manifest: NarrativeDocumentProjectionManifest; readonly reused: boolean }> {
  if (!store || typeof store.loadNarrativeDocumentProjectionManifest !== "function" ||
      typeof store.saveNarrativeDocumentProjectionManifestIfUnchanged !== "function") {
    throw new Error("El almacenamiento no implementa manifiestos documentales CAS.");
  }
  const current = await store.loadNarrativeDocumentProjectionManifest(projectId, documentId);
  if (current?.status === "deleted" && current.revision === deletionRevision) {
    return { manifest: current, reused: true };
  }
  if (current && deletionRevision <= current.revision) {
    throw new Error("La retirada documental debe usar una revisión posterior al manifiesto vigente.");
  }
  const candidate = createNarrativeDocumentProjectionTombstone(
    projectId, documentId, deletionRevision, (current?.generation ?? 0) + 1, updatedAt
  );
  return commitNarrativeDocumentProjectionManifest(store, candidate);
}

export type NarrativeProjectionReconciliationIssueCode =
  | "missing-manifest"
  | "missing-inventory-id"
  | "stale-inventory-id"
  | "tombstone-has-evidence"
  | "missing-relation-entity"
  | "missing-event-participant"
  | "missing-assertion-entity"
  | "missing-related-entity"
  | "missing-related-idea";

export interface NarrativeProjectionReconciliationIssue {
  readonly code: NarrativeProjectionReconciliationIssueCode;
  readonly documentId: string;
  readonly recordType: "document" | "entity" | "relation" | "event" | "idea" | "assertion";
  readonly recordId?: string;
  readonly detail: string;
}

export interface NarrativeProjectionReconciliationReport {
  readonly projectId: string;
  readonly checkedManifests: number;
  readonly checkedRecords: number;
  readonly issues: readonly NarrativeProjectionReconciliationIssue[];
}

/**
 * Compara inventarios documentales con evidencia persistida. Es sólo diagnóstico:
 * no borra, restaura ni reescribe registros; las reparaciones requieren resolver
 * cada discrepancia y aplicar las operaciones CAS del store.
 */
export async function reconcileNarrativeDocumentProjections(
  store: ProjectStore,
  projectId: string
): Promise<NarrativeProjectionReconciliationReport> {
  if (!store || typeof projectId !== "string" || !projectId.trim()) {
    throw new Error("Proyecto o almacenamiento inválido para reconciliar proyecciones.");
  }
  const required = [
    "loadNarrativeDocumentProjectionManifests",
    "loadEntities", "loadRelations", "loadEvents", "loadIdeas", "loadAssertions"
  ] as const;
  for (const method of required) {
    if (typeof store[method] !== "function") {
      throw new Error("El almacenamiento no permite reconciliar proyecciones: " + method);
    }
  }
  const [manifests, entities, relations, events, ideas, assertions] = await Promise.all([
    store.loadNarrativeDocumentProjectionManifests!(projectId),
    store.loadEntities!(projectId),
    store.loadRelations!(projectId),
    store.loadEvents!(projectId),
    store.loadIdeas!(projectId),
    store.loadAssertions!(projectId)
  ]);
  const issues: NarrativeProjectionReconciliationIssue[] = [];
  const manifestByDocument = new Map(manifests.map(manifest => {
    validateNarrativeDocumentProjectionManifest(manifest);
    if (manifest.projectId !== projectId) throw new Error("Manifiesto de otro proyecto en el inventario.");
    return [manifest.documentId, manifest] as const;
  }));
  const collections = [
    { type: "entity" as const, records: entities, inventory: "entityIds" as const },
    { type: "relation" as const, records: relations, inventory: "relationIds" as const },
    { type: "event" as const, records: events, inventory: "eventIds" as const },
    { type: "idea" as const, records: ideas, inventory: "ideaIds" as const },
    { type: "assertion" as const, records: assertions, inventory: "assertionIds" as const }
  ];
  const allDocumentIds = new Set<string>(manifestByDocument.keys());
  for (const collection of collections) {
    for (const record of collection.records) {
      const evidenceItems = Array.isArray((record as { evidence?: unknown }).evidence)
        ? (record as { evidence: readonly { documentId: string }[] }).evidence
        : (record as { evidence?: { documentId: string } }).evidence
          ? [(record as { evidence: { documentId: string } }).evidence] : [];
      for (const evidence of evidenceItems) {
        if (evidence && typeof evidence.documentId === "string" && evidence.documentId.trim()) {
          allDocumentIds.add(evidence.documentId);
        }
      }
    }
  }
  const emit = (
    code: NarrativeProjectionReconciliationIssueCode,
    documentId: string,
    recordType: NarrativeProjectionReconciliationIssue["recordType"],
    recordId: string | undefined,
    detail: string
  ) => issues.push({ code, documentId, recordType, ...(recordId ? { recordId } : {}), detail });

  for (const documentId of allDocumentIds) {
    const manifest = manifestByDocument.get(documentId);
    if (!manifest) {
      emit("missing-manifest", documentId, "document", undefined,
        "Hay evidencia documental sin manifiesto durable.");
    }
    if (!manifest) continue;
    for (const collection of collections) {
      const actualIds = new Set<string>();
      for (const record of collection.records) {
        const evidence = Array.isArray((record as { evidence?: unknown }).evidence)
          ? (record as { evidence: readonly { documentId: string }[] }).evidence
          : (record as { evidence?: { documentId: string } }).evidence
            ? [(record as { evidence: { documentId: string } }).evidence] : [];
        if (evidence.some(item => item?.documentId === documentId)) actualIds.add(record.id);
      }
      const listed = new Set(manifest?.[collection.inventory] ?? []);
      if (manifest?.status === "deleted") {
        for (const recordId of actualIds) emit("tombstone-has-evidence", documentId,
          collection.type, recordId, "El tombstone declara retirado el documento, pero persiste evidencia.");
        continue;
      }
      for (const recordId of actualIds) {
        if (!listed.has(recordId)) emit("missing-inventory-id", documentId,
          collection.type, recordId, "La evidencia existe, pero el manifiesto no enumera el registro.");
      }
      for (const recordId of listed) {
        if (!actualIds.has(recordId)) emit("stale-inventory-id", documentId,
          collection.type, recordId, "El manifiesto enumera un registro sin evidencia documental vigente.");
      }
    }
  }
  const entityIds = new Set(entities.map(item => item.id));
  const ideaIds = new Set(ideas.map(item => item.id));
  const evidenceDocuments = (value: unknown): string[] => {
    const entries = Array.isArray(value) ? value :
      value && typeof value === "object" ? [value] : [];
    return [...new Set(entries
      .map(item => item && typeof item === "object"
        ? (item as { documentId?: unknown }).documentId : undefined)
      .filter((id): id is string => typeof id === "string" && !!id.trim()))].sort();
  };
  const emitReference = (
    code: NarrativeProjectionReconciliationIssueCode,
    recordType: NarrativeProjectionReconciliationIssue["recordType"],
    recordId: string,
    targetId: string,
    documents: readonly string[],
    description: string
  ) => {
    const scopes = documents.length ? documents : [""];
    for (const documentId of scopes) {
      emit(code, documentId, recordType, recordId,
        description + " Referencia inexistente: " + targetId + ".");
    }
  };
  for (const relation of relations) {
    const documents = evidenceDocuments(relation.evidence);
    if (!entityIds.has(relation.fromEntityId)) emitReference(
      "missing-relation-entity", "relation", relation.id, relation.fromEntityId,
      documents, "La relación no encuentra su entidad de origen."
    );
    if (!entityIds.has(relation.toEntityId)) emitReference(
      "missing-relation-entity", "relation", relation.id, relation.toEntityId,
      documents, "La relación no encuentra su entidad de destino."
    );
  }
  for (const event of events) {
    const documents = evidenceDocuments(event.evidence);
    for (const participantId of event.participants) {
      if (!entityIds.has(participantId)) emitReference(
        "missing-event-participant", "event", event.id, participantId,
        documents, "El acontecimiento referencia un participante inexistente."
      );
    }
  }
  for (const assertion of assertions) {
    if (!entityIds.has(assertion.entityId)) emitReference(
      "missing-assertion-entity", "assertion", assertion.id, assertion.entityId,
      evidenceDocuments(assertion.evidence), "La afirmación no encuentra su entidad."
    );
  }
  for (const idea of ideas) {
    const documents = evidenceDocuments(idea.evidence);
    for (const entityId of idea.relatedEntityIds ?? []) {
      if (!entityIds.has(entityId)) emitReference(
        "missing-related-entity", "idea", idea.id, entityId,
        documents, "La idea referencia una entidad inexistente."
      );
    }
    for (const relatedIdeaId of idea.relatedIdeaIds ?? []) {
      if (!ideaIds.has(relatedIdeaId)) emitReference(
        "missing-related-idea", "idea", idea.id, relatedIdeaId,
        documents, "La idea referencia otra idea inexistente."
      );
    }
  }

  return {
    projectId, checkedManifests: manifests.length,
    checkedRecords: entities.length + relations.length + events.length + ideas.length + assertions.length,
    issues
  };
}

/**
 * Repara únicamente el inventario de un manifiesto activo a partir de la
 * evidencia actualmente persistida. No toca registros ni acepta tombstones:
 * la escritura del manifiesto se protege con la generación CAS observada.
 */
export async function repairNarrativeDocumentProjectionManifest(
  store: ProjectStore,
  projectId: string,
  documentId: string,
  updatedAt = Date.now()
): Promise<{
  readonly manifest: NarrativeDocumentProjectionManifest;
  readonly reused: boolean;
  readonly changed: boolean;
}> {
  if (!store || typeof projectId !== "string" || !projectId.trim() ||
      typeof documentId !== "string" || !documentId.trim() ||
      !Number.isFinite(updatedAt) || updatedAt < 0 ||
      typeof store.loadNarrativeDocumentProjectionManifest !== "function" ||
      typeof store.saveNarrativeDocumentProjectionManifestIfUnchanged !== "function") {
    throw new Error("Contexto o capacidades inválidas para reparar el manifiesto.");
  }
  const required = [
    "loadEntities", "loadRelations", "loadEvents", "loadIdeas", "loadAssertions"
  ] as const;
  for (const method of required) {
    if (typeof store[method] !== "function") {
      throw new Error("El almacenamiento no permite reparar inventarios: " + method);
    }
  }
  const current = await store.loadNarrativeDocumentProjectionManifest(projectId, documentId);
  if (!current) throw new Error("No se puede reconstruir automáticamente un manifiesto inexistente sin revisión fuente.");
  validateNarrativeDocumentProjectionManifest(current);
  if (current.projectId !== projectId || current.documentId !== documentId) {
    throw new Error("El manifiesto leído no corresponde al documento solicitado.");
  }
  if (current.status !== "active") {
    throw new Error("No se reparan tombstones automáticamente: requieren una decisión editorial explícita.");
  }
  const [entities, relations, events, ideas, assertions] = await Promise.all([
    store.loadEntities!(projectId), store.loadRelations!(projectId),
    store.loadEvents!(projectId), store.loadIdeas!(projectId),
    store.loadAssertions!(projectId)
  ]);
  const idsFor = (records: readonly { readonly id: string; readonly evidence?: unknown }[]) =>
    records.filter(record => {
      const evidence = Array.isArray(record.evidence)
        ? record.evidence as readonly { readonly documentId?: string }[]
        : record.evidence && typeof record.evidence === "object"
          ? [record.evidence as { readonly documentId?: string }] : [];
      return evidence.some(item => item?.documentId === documentId);
    }).map(record => record.id).sort();
  const candidate: NarrativeDocumentProjectionManifest = {
    ...current,
    generation: current.generation + 1,
    entityIds: idsFor(entities),
    relationIds: idsFor(relations),
    eventIds: idsFor(events),
    ideaIds: idsFor(ideas),
    assertionIds: idsFor(assertions),
    updatedAt
  };
  validateNarrativeDocumentProjectionManifest(candidate);
  const sameInventory =
    JSON.stringify([...current.entityIds].sort()) === JSON.stringify(candidate.entityIds) &&
    JSON.stringify([...current.relationIds].sort()) === JSON.stringify(candidate.relationIds) &&
    JSON.stringify([...current.eventIds].sort()) === JSON.stringify(candidate.eventIds) &&
    JSON.stringify([...current.ideaIds].sort()) === JSON.stringify(candidate.ideaIds) &&
    JSON.stringify([...current.assertionIds].sort()) === JSON.stringify(candidate.assertionIds);
  if (sameInventory) return { manifest: current, reused: true, changed: false };
  await store.saveNarrativeDocumentProjectionManifestIfUnchanged(candidate, current.generation);
  return { manifest: candidate, reused: false, changed: true };
}

export interface NarrativeKnowledgeGraphPersistenceResult {
  readonly projectId: string;
  readonly saved: {
    readonly entities: number;
    readonly relations: number;
    readonly events: number;
    readonly ideas: number;
    readonly assertions: number;
  };
  readonly reused: {
    readonly entities: number;
    readonly relations: number;
    readonly events: number;
    readonly ideas: number;
    readonly assertions: number;
  };
}

/**
 * Persiste las proyecciones de un snapshot mediante las operaciones CAS del
 * ProjectStore. Es idempotente para una misma entrada y conserva evidencia
 * procedente de otros documentos mediante los mergeNarrative* del dominio.
 *
 * La operación es secuencial, no una transacción global: un error intermedio
 * deja guardados los elementos anteriores, que pueden reintentarse sin duplicar.
 */
export async function persistNarrativeKnowledgeGraphSnapshot(
  store: ProjectStore,
  snapshot: NarrativeKnowledgeGraphSnapshot
): Promise<NarrativeKnowledgeGraphPersistenceResult> {
  if (!store || !snapshot || !snapshot.graph ||
      typeof snapshot.projectId !== "string" || !snapshot.projectId.trim() ||
      snapshot.graph.projectId !== snapshot.projectId ||
      !Array.isArray(snapshot.documents)) {
    throw new Error("Snapshot o almacenamiento narrativo inválido.");
  }

  const required = [
    "loadEntities", "saveEntityIfUnchanged",
    "loadRelations", "saveRelationIfUnchanged",
    "loadEvents", "saveEventIfUnchanged",
    "loadIdeas", "saveIdeaIfUnchanged",
    "loadAssertions", "saveAssertionIfUnchanged"
  ] as const;
  for (const method of required) {
    if (typeof store[method] !== "function") {
      throw new Error("El almacenamiento no implementa la persistencia CAS completa del grafo narrativo: " + method);
    }
  }

  const projectId = snapshot.projectId;
  const graph = snapshot.graph;
  const documentIds = snapshotDocumentIds(snapshot);
  const saved = { entities: 0, relations: 0, events: 0, ideas: 0, assertions: 0 };
  const reused = { entities: 0, relations: 0, events: 0, ideas: 0, assertions: 0 };

  const existingEntities = await store.loadEntities!(projectId);
  const entityMap = new Map(existingEntities.map(item => [item.id, item]));
  const incomingEntities = new Map(graph.entities.map(item => [item.id, item]));
  for (const current of existingEntities) {
    const incoming = incomingEntities.get(current.id);
    incomingEntities.delete(current.id);
    const base = documentIds.reduce((record, documentId) => withoutDocumentEvidence(record, documentId), current);
    const next = incoming ? mergeNarrativeEntity(base, incoming) : base;
    if (JSON.stringify(current) === JSON.stringify(next)) { reused.entities++; continue; }
    await store.saveEntityIfUnchanged!(next, current);
    entityMap.set(next.id, next);
    saved.entities++;
  }
  for (const incoming of incomingEntities.values()) {
    await store.saveEntityIfUnchanged!(incoming);
    entityMap.set(incoming.id, incoming);
    saved.entities++;
  }

  const existingRelations = await store.loadRelations!(projectId);
  const relationMap = new Map(existingRelations.map(item => [item.id, item]));
  const incomingRelations = new Map(graph.relations.map(item => [item.id, item]));
  for (const current of existingRelations) {
    const incoming = incomingRelations.get(current.id);
    incomingRelations.delete(current.id);
    const base = documentIds.reduce((record, documentId) => withoutDocumentEvidence(record, documentId), current);
    const next = incoming ? mergeNarrativeRelation(base, incoming) : base;
    if (JSON.stringify(current) === JSON.stringify(next)) { reused.relations++; continue; }
    await store.saveRelationIfUnchanged!(next, current);
    relationMap.set(next.id, next);
    saved.relations++;
  }
  for (const incoming of incomingRelations.values()) {
    await store.saveRelationIfUnchanged!(incoming);
    relationMap.set(incoming.id, incoming);
    saved.relations++;
  }

  const existingEvents = await store.loadEvents!(projectId);
  const eventMap = new Map(existingEvents.map(item => [item.id, item]));
  const incomingEvents = new Map(graph.events.map(item => [item.id, item]));
  for (const current of existingEvents) {
    const incoming = incomingEvents.get(current.id);
    incomingEvents.delete(current.id);
    const base = documentIds.reduce((record, documentId) => withoutDocumentEvidence(record, documentId), current);
    const next = incoming ? mergeNarrativeEvent(base, incoming) : base;
    if (JSON.stringify(current) === JSON.stringify(next)) { reused.events++; continue; }
    await store.saveEventIfUnchanged!(next, current);
    eventMap.set(next.id, next);
    saved.events++;
  }
  for (const incoming of incomingEvents.values()) {
    await store.saveEventIfUnchanged!(incoming);
    eventMap.set(incoming.id, incoming);
    saved.events++;
  }

  const existingIdeas = await store.loadIdeas!(projectId);
  const ideaMap = new Map(existingIdeas.map(item => [item.id, item]));
  const incomingIdeas = new Map(graph.ideas.map(item => [item.id, item]));
  for (const current of existingIdeas) {
    const incoming = incomingIdeas.get(current.id);
    incomingIdeas.delete(current.id);
    const base = documentIds.reduce((record, documentId) => withoutDocumentEvidence(record, documentId), current);
    const next = incoming ? mergeNarrativeIdea(base, incoming) : base;
    if (JSON.stringify(current) === JSON.stringify(next)) { reused.ideas++; continue; }
    await store.saveIdeaIfUnchanged!(next, current);
    ideaMap.set(next.id, next);
    saved.ideas++;
  }
  for (const incoming of incomingIdeas.values()) {
    await store.saveIdeaIfUnchanged!(incoming);
    ideaMap.set(incoming.id, incoming);
    saved.ideas++;
  }

  const existingAssertions = await store.loadAssertions!(projectId);
  const assertionMap = new Map(existingAssertions.map(item => [item.id, item]));
  const incomingAssertions = new Map(graph.assertions.map(item => [item.id, item]));
  // Las afirmaciones tienen una sola evidencia (no una colección). Sin una API
  // transaccional de borrado no es seguro convertirlas en registros sin evidencia.
  for (const incoming of incomingAssertions.values()) {
    const current = assertionMap.get(incoming.id);
    if (current && JSON.stringify(current) === JSON.stringify(incoming)) {
      reused.assertions++;
      continue;
    }
    await store.saveAssertionIfUnchanged!(incoming, current);
    assertionMap.set(incoming.id, incoming);
    saved.assertions++;
  }
  reused.assertions += existingAssertions.filter(item => !incomingAssertions.has(item.id)).length;

  return { projectId, saved, reused };
}
