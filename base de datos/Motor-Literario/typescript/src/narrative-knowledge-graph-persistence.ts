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
  const saved = { entities: 0, relations: 0, events: 0, ideas: 0, assertions: 0 };
  const reused = { entities: 0, relations: 0, events: 0, ideas: 0, assertions: 0 };

  const existingEntities = await store.loadEntities!(projectId);
  const entityMap = new Map(existingEntities.map(item => [item.id, item]));
  for (const incoming of graph.entities) {
    const current = entityMap.get(incoming.id);
    const next = mergeNarrativeEntity(current, incoming);
    if (current && JSON.stringify(current) === JSON.stringify(next)) {
      reused.entities++;
      continue;
    }
    await store.saveEntityIfUnchanged!(next, current);
    entityMap.set(next.id, next);
    saved.entities++;
  }

  const existingRelations = await store.loadRelations!(projectId);
  const relationMap = new Map(existingRelations.map(item => [item.id, item]));
  for (const incoming of graph.relations) {
    const current = relationMap.get(incoming.id);
    const next = mergeNarrativeRelation(current, incoming);
    if (current && JSON.stringify(current) === JSON.stringify(next)) {
      reused.relations++;
      continue;
    }
    await store.saveRelationIfUnchanged!(next, current);
    relationMap.set(next.id, next);
    saved.relations++;
  }

  const existingEvents = await store.loadEvents!(projectId);
  const eventMap = new Map(existingEvents.map(item => [item.id, item]));
  for (const incoming of graph.events) {
    const current = eventMap.get(incoming.id);
    const next = mergeNarrativeEvent(current, incoming);
    if (current && JSON.stringify(current) === JSON.stringify(next)) {
      reused.events++;
      continue;
    }
    await store.saveEventIfUnchanged!(next, current);
    eventMap.set(next.id, next);
    saved.events++;
  }

  const existingIdeas = await store.loadIdeas!(projectId);
  const ideaMap = new Map(existingIdeas.map(item => [item.id, item]));
  for (const incoming of graph.ideas) {
    const current = ideaMap.get(incoming.id);
    const next = mergeNarrativeIdea(current, incoming);
    if (current && JSON.stringify(current) === JSON.stringify(next)) {
      reused.ideas++;
      continue;
    }
    await store.saveIdeaIfUnchanged!(next, current);
    ideaMap.set(next.id, next);
    saved.ideas++;
  }

  const existingAssertions = await store.loadAssertions!(projectId);
  const assertionMap = new Map(existingAssertions.map(item => [item.id, item]));
  for (const incoming of graph.assertions) {
    const current = assertionMap.get(incoming.id);
    if (current && JSON.stringify(current) === JSON.stringify(incoming)) {
      reused.assertions++;
      continue;
    }
    await store.saveAssertionIfUnchanged!(incoming, current);
    assertionMap.set(incoming.id, incoming);
    saved.assertions++;
  }

  return { projectId, saved, reused };
}
