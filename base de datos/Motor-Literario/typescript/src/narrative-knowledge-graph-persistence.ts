import type { ProjectStore } from "./contracts";
import {
  mergeNarrativeEntity,
  mergeNarrativeRelation,
  mergeNarrativeEvent,
  mergeNarrativeIdea,
  type NarrativeEntity,
  type NarrativeRelation,
  type NarrativeEvent,
  type NarrativeIdea
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
  const contribution = snapshot.documents.find(item => item.input.documentId === documentId);
  if (!contribution) throw new Error("El documento no forma parte del snapshot: " + documentId);
  const ids = <T extends { readonly id: string; readonly evidence: readonly { readonly documentId: string }[] }>(items: readonly T[]) =>
    [...new Set(items.filter(item => item.evidence.some(evidence => evidence.documentId === documentId))
      .map(item => item.id))].sort();
  const assertions: readonly NarrativeAssertion[] = contribution.graph.assertions;
  const assertionIds = assertions.map((item: NarrativeAssertion) => item.id).sort();
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
    assertionIds,
    updatedAt
  };
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
    const base = documentIds.reduce((record, documentId) => withoutDocumentEvidence(record, documentId), current);
    const next = incoming ? mergeNarrativeEntity(base, incoming) : base;
    if (JSON.stringify(current) === JSON.stringify(next)) { reused.entities++; continue; }
    await store.saveEntityIfUnchanged!(next, current);
    entityMap.set(next.id, next);
    saved.entities++;
    incomingEntities.delete(current.id);
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
    const base = documentIds.reduce((record, documentId) => withoutDocumentEvidence(record, documentId), current);
    const next = incoming ? mergeNarrativeRelation(base, incoming) : base;
    if (JSON.stringify(current) === JSON.stringify(next)) { reused.relations++; continue; }
    await store.saveRelationIfUnchanged!(next, current);
    relationMap.set(next.id, next);
    saved.relations++;
    incomingRelations.delete(current.id);
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
    const base = documentIds.reduce((record, documentId) => withoutDocumentEvidence(record, documentId), current);
    const next = incoming ? mergeNarrativeEvent(base, incoming) : base;
    if (JSON.stringify(current) === JSON.stringify(next)) { reused.events++; continue; }
    await store.saveEventIfUnchanged!(next, current);
    eventMap.set(next.id, next);
    saved.events++;
    incomingEvents.delete(current.id);
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
    const base = documentIds.reduce((record, documentId) => withoutDocumentEvidence(record, documentId), current);
    const next = incoming ? mergeNarrativeIdea(base, incoming) : base;
    if (JSON.stringify(current) === JSON.stringify(next)) { reused.ideas++; continue; }
    await store.saveIdeaIfUnchanged!(next, current);
    ideaMap.set(next.id, next);
    saved.ideas++;
    incomingIdeas.delete(current.id);
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
