import {
  buildNarrativeKnowledgeGraph,
  type NarrativeKnowledgeDocument,
  type NarrativeKnowledgeGraph
} from "./narrative-knowledge-graph";
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
import { analyzeNarrativeConsistency } from "./narrative-consistency";
import type { NarrativeAssertion } from "./narrative-history";

export interface NarrativeKnowledgeGraphSnapshot {
  readonly projectId: string;
  readonly sourceProjectName: string;
  readonly extractionTime: number;
  readonly documents: readonly {
    readonly input: NarrativeKnowledgeDocument;
    readonly graph: NarrativeKnowledgeGraph;
  }[];
  readonly graph: NarrativeKnowledgeGraph;
}

export interface NarrativeKnowledgeGraphUpdate {
  readonly snapshot: NarrativeKnowledgeGraphSnapshot;
  readonly rebuiltDocumentIds: readonly string[];
  readonly reusedDocumentIds: readonly string[];
  readonly removedDocumentIds: readonly string[];
}

function validateInputs(
  projectId: string,
  documents: readonly NarrativeKnowledgeDocument[],
  sourceProjectName: string
): void {
  if (!projectId.trim() || !sourceProjectName.trim() || !Array.isArray(documents)) {
    throw new Error("Parámetros del snapshot narrativo inválidos.");
  }
  const ids = new Set<string>();
  for (const document of documents) {
    if (!document || typeof document.documentId !== "string" || !document.documentId.trim() ||
        !Number.isSafeInteger(document.revision) || document.revision < 0 ||
        typeof document.text !== "string" ||
        (document.baseOffset !== undefined &&
          (!Number.isSafeInteger(document.baseOffset) || document.baseOffset < 0 ||
            document.baseOffset > Number.MAX_SAFE_INTEGER - document.text.length)) ||
        ids.has(document.documentId)) {
      throw new Error("Documento inválido o ID documental duplicado en snapshot.");
    }
    ids.add(document.documentId);
  }
}

function sameInput(a: NarrativeKnowledgeDocument, b: NarrativeKnowledgeDocument): boolean {
  return a.documentId === b.documentId && a.revision === b.revision &&
    a.text === b.text && (a.baseOffset ?? 0) === (b.baseOffset ?? 0);
}

function combineGraphs(
  projectId: string,
  contributions: readonly NarrativeKnowledgeGraph[],
  documents: readonly NarrativeKnowledgeDocument[]
): NarrativeKnowledgeGraph {
  const entities = new Map<string, NarrativeEntity>();
  const relations = new Map<string, NarrativeRelation>();
  const events = new Map<string, NarrativeEvent>();
  const ideas = new Map<string, NarrativeIdea>();
  const assertions = new Map<string, NarrativeAssertion>();

  for (const graph of contributions) {
    for (const item of graph.entities) {
      entities.set(item.id, mergeNarrativeEntity(entities.get(item.id), item));
    }
    for (const item of graph.relations) {
      relations.set(item.id, mergeNarrativeRelation(relations.get(item.id), item));
    }
    for (const item of graph.events) {
      events.set(item.id, mergeNarrativeEvent(events.get(item.id), item));
    }
    for (const item of graph.ideas) {
      ideas.set(item.id, mergeNarrativeIdea(ideas.get(item.id), item));
    }
    for (const item of graph.assertions) assertions.set(item.id, item);
  }

  const ordered = <T extends { readonly id: string }>(map: Map<string, T>) =>
    [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  const orderedDocuments = [...documents].sort((a, b) =>
    a.documentId.localeCompare(b.documentId) || a.revision - b.revision
  );
  const assertionList = ordered(assertions);
  return {
    projectId,
    documents: orderedDocuments.map(({ documentId, revision }) => ({ documentId, revision })),
    entities: ordered(entities),
    relations: ordered(relations),
    events: ordered(events),
    ideas: ordered(ideas),
    assertions: assertionList,
    consistency: analyzeNarrativeConsistency(projectId, assertionList)
  };
}

/**
 * Crea un snapshot incremental en memoria. Conserva una proyección por documento;
 * no persiste texto ni resultados y no sustituye el almacenamiento del proyecto.
 */
export function createNarrativeKnowledgeGraphSnapshot(
  projectId: string,
  documents: readonly NarrativeKnowledgeDocument[],
  options: { readonly sourceProjectName?: string; readonly now?: number } = {}
): NarrativeKnowledgeGraphSnapshot {
  const sourceProjectName = options.sourceProjectName ?? projectId;
  validateInputs(projectId, documents, sourceProjectName);
  const extractionTime = options.now ?? Date.now();
  if (!Number.isFinite(extractionTime) || extractionTime < 0) {
    throw new Error("Tiempo de extracción inválido.");
  }
  const ordered = [...documents].sort((a, b) => a.documentId.localeCompare(b.documentId));
  const contributions = ordered.map(input => ({
    input: { ...input },
    graph: buildNarrativeKnowledgeGraph(projectId, [input], {
      sourceProjectName, now: extractionTime
    })
  }));
  return {
    projectId, sourceProjectName, extractionTime,
    documents: contributions,
    graph: combineGraphs(projectId, contributions.map(item => item.graph), ordered)
  };
}

/**
 * Actualiza el snapshot reutilizando la contribución de cada documento cuyo
 * contenido, revisión y offset no cambiaron. Solo vuelve a ejecutar extractores
 * para documentos nuevos o modificados; las eliminaciones se reflejan al combinar.
 */
export function updateNarrativeKnowledgeGraphSnapshot(
  previous: NarrativeKnowledgeGraphSnapshot,
  documents: readonly NarrativeKnowledgeDocument[],
  options: { readonly sourceProjectName?: string; readonly now?: number } = {}
): NarrativeKnowledgeGraphUpdate {
  if (!previous || !previous.graph || !Array.isArray(previous.documents) ||
      typeof previous.projectId !== "string" || !previous.projectId.trim()) {
    throw new Error("Snapshot narrativo previo inválido.");
  }
  const sourceProjectName = options.sourceProjectName ?? previous.sourceProjectName;
  validateInputs(previous.projectId, documents, sourceProjectName);
  const extractionTime = options.now ?? Date.now();
  if (!Number.isFinite(extractionTime) || extractionTime < 0) {
    throw new Error("Tiempo de extracción inválido.");
  }

  const previousById = new Map(previous.documents.map(item => [item.input.documentId, item]));
  const nextById = new Set(documents.map(item => item.documentId));
  const reusedDocumentIds: string[] = [];
  const rebuiltDocumentIds: string[] = [];
  const removedDocumentIds = [...previousById.keys()]
    .filter(id => !nextById.has(id)).sort();
  const next = [...documents].sort((a, b) => a.documentId.localeCompare(b.documentId));
  const contributions = next.map(input => {
    const cached = previousById.get(input.documentId);
    if (cached && previous.sourceProjectName === sourceProjectName &&
        sameInput(cached.input, input)) {
      reusedDocumentIds.push(input.documentId);
      return cached;
    }
    rebuiltDocumentIds.push(input.documentId);
    return {
      input: { ...input },
      graph: buildNarrativeKnowledgeGraph(previous.projectId, [input], {
        sourceProjectName, now: extractionTime
      })
    };
  });
  const snapshot: NarrativeKnowledgeGraphSnapshot = {
    projectId: previous.projectId,
    sourceProjectName,
    extractionTime,
    documents: contributions,
    graph: combineGraphs(previous.projectId, contributions.map(item => item.graph), next)
  };
  return {
    snapshot,
    rebuiltDocumentIds: rebuiltDocumentIds.sort(),
    reusedDocumentIds: reusedDocumentIds.sort(),
    removedDocumentIds
  };
}
