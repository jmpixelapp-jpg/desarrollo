import {
  extractNarrativeEntities,
  extractNarrativeRelations,
  extractNarrativeEvents,
  extractNarrativeIdeas,
  mergeNarrativeEntity,
  mergeNarrativeRelation,
  mergeNarrativeEvent,
  mergeNarrativeIdea,
  type NarrativeEntity,
  type NarrativeRelation,
  type NarrativeEvent,
  type NarrativeIdea
} from "./narrative-knowledge";
import {
  extractNarrativeAssertions,
  type NarrativeAssertion
} from "./narrative-history";
import {
  analyzeNarrativeConsistency,
  type NarrativeConsistencyFinding
} from "./narrative-consistency";

export interface NarrativeKnowledgeDocument {
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  /** UTF-16 offset absoluto cuando el documento es una ventana de texto. */
  readonly baseOffset?: number;
}

export interface NarrativeKnowledgeGraph {
  readonly projectId: string;
  readonly documents: readonly { readonly documentId: string; readonly revision: number }[];
  readonly entities: readonly NarrativeEntity[];
  readonly relations: readonly NarrativeRelation[];
  readonly events: readonly NarrativeEvent[];
  readonly ideas: readonly NarrativeIdea[];
  readonly assertions: readonly NarrativeAssertion[];
  readonly consistency: readonly NarrativeConsistencyFinding[];
}

/**
 * Construye una vista de conocimiento narrativa para un conjunto de revisiones.
 * Los extractores siguen siendo conservadores: relaciones, eventos e ideas solo
 * aparecen cuando el texto contiene los marcadores/construcciones documentados.
 *
 * Esta función es pura respecto del almacenamiento: no persiste, no sincroniza
 * y no modifica manuscritos. El llamador decide qué revisiones son vigentes.
 */
export function buildNarrativeKnowledgeGraph(
  projectId: string,
  documents: readonly NarrativeKnowledgeDocument[],
  options: { readonly sourceProjectName?: string; readonly now?: number } = {}
): NarrativeKnowledgeGraph {
  if (typeof projectId !== "string" || !projectId.trim() ||
      !Array.isArray(documents) ||
      (options.sourceProjectName !== undefined &&
        (typeof options.sourceProjectName !== "string" || !options.sourceProjectName.trim())) ||
      (options.now !== undefined &&
        (typeof options.now !== "number" || !Number.isFinite(options.now) || options.now < 0))) {
    throw new Error("Contexto del grafo de conocimiento narrativo inválido.");
  }

  const seenDocuments = new Set<string>();
  for (const document of documents) {
    if (!document || typeof document.documentId !== "string" || !document.documentId.trim() ||
        !Number.isSafeInteger(document.revision) || document.revision < 0 ||
        typeof document.text !== "string" ||
        (document.baseOffset !== undefined &&
          (!Number.isSafeInteger(document.baseOffset) || document.baseOffset < 0 ||
            document.baseOffset > Number.MAX_SAFE_INTEGER - document.text.length))) {
      throw new Error("Documento de entrada del grafo narrativo inválido.");
    }
    const identity = JSON.stringify([document.documentId, document.revision]);
    if (seenDocuments.has(identity)) {
      throw new Error("El grafo no admite dos copias de la misma revisión documental.");
    }
    seenDocuments.add(identity);
  }

  const entitiesById = new Map<string, NarrativeEntity>();
  const relationsById = new Map<string, NarrativeRelation>();
  const eventsById = new Map<string, NarrativeEvent>();
  const ideasById = new Map<string, NarrativeIdea>();
  const assertionsById = new Map<string, NarrativeAssertion>();
  const orderedDocuments = [...documents].sort((a, b) =>
    a.documentId.localeCompare(b.documentId) || a.revision - b.revision
  );

  for (const document of orderedDocuments) {
    const offset = document.baseOffset ?? 0;
    const now = options.now ?? Date.now();
    const extractedEntities = extractNarrativeEntities(
      projectId, document.documentId, document.revision, document.text, now, offset
    );
    for (const entity of extractedEntities) {
      entitiesById.set(entity.id, mergeNarrativeEntity(entitiesById.get(entity.id), entity));
    }
    const entities = [...entitiesById.values()];
    const relations = extractNarrativeRelations(
      projectId, document.documentId, document.revision, document.text, entities, offset
    );
    for (const relation of relations) {
      relationsById.set(relation.id, mergeNarrativeRelation(relationsById.get(relation.id), relation));
    }
    const events = extractNarrativeEvents(
      projectId, document.documentId, document.revision, document.text, entities, offset
    );
    for (const event of events) {
      eventsById.set(event.id, mergeNarrativeEvent(eventsById.get(event.id), event));
    }
    const ideas = extractNarrativeIdeas(
      projectId, document.documentId, document.revision, document.text, offset,
      options.sourceProjectName ?? projectId
    );
    for (const idea of ideas) {
      ideasById.set(idea.id, mergeNarrativeIdea(ideasById.get(idea.id), idea));
    }
    const assertions = extractNarrativeAssertions(
      projectId, document.documentId, document.revision, document.text, entities, offset, now
    );
    for (const assertion of assertions) {
      assertionsById.set(assertion.id, assertion);
    }
  }

  const entities = [...entitiesById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const relations = [...relationsById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const events = [...eventsById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const ideas = [...ideasById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const assertions = [...assertionsById.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    projectId,
    documents: orderedDocuments.map(({ documentId, revision }) => ({ documentId, revision })),
    entities, relations, events, ideas, assertions,
    consistency: analyzeNarrativeConsistency(projectId, assertions)
  };
}
