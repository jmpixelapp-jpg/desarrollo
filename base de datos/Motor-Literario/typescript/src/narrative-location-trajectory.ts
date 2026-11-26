/**
 * Secuencias editoriales de movimientos por personaje.
 *
 * El orden de capítulos debe suministrarse explícitamente. Una salida seguida
 * de una llegada solo es una secuencia textual candidata: no demuestra una
 * ruta directa, viaje continuo ni ausencia de paradas intermedias.
 */
import type { TextEvidence } from "./narrative-knowledge";
import type {
  NarrativeLocationTransitionCandidate
} from "./narrative-location-transition-discovery";

export interface NarrativeLocationDocumentOrder {
  readonly documentId: string;
  readonly chapterOrder: number;
  readonly chapterLabel?: string;
}

export interface NarrativeLocationTrajectoryEntry {
  readonly sequenceIndex: number;
  readonly chapterOrder: number;
  readonly chapterLabel?: string;
  readonly transition: NarrativeLocationTransitionCandidate;
  readonly interveningDocumentsWithoutTransitionCandidate: readonly string[];
}

export interface NarrativeLocationMovementSequence {
  readonly id: string;
  readonly kind: "departure-arrival-sequence";
  readonly departureTransitionId: string;
  readonly arrivalTransitionId: string;
  readonly actorEntityId: string;
  readonly fromLocationEntityId: string;
  readonly toLocationEntityId: string;
  readonly evidence: readonly [TextEvidence, TextEvidence];
  readonly status: "sequence-candidate";
}

export interface NarrativeLocationTrajectory {
  readonly projectId: string;
  readonly actorEntityId: string;
  readonly entries: readonly NarrativeLocationTrajectoryEntry[];
  readonly movementSequences: readonly NarrativeLocationMovementSequence[];
  readonly evidenceCoverage: "candidate-movements-only";
  readonly reviewStatus: "candidate";
}

export interface NarrativeLocationTrajectoryInput {
  readonly projectId: string;
  readonly documentOrder: readonly NarrativeLocationDocumentOrder[];
  readonly transitions: readonly NarrativeLocationTransitionCandidate[];
}

function validEvidence(
  evidence: TextEvidence | undefined,
  transition: NarrativeLocationTransitionCandidate
): evidence is TextEvidence {
  return !!evidence &&
    evidence.documentId === transition.documentId &&
    evidence.revision === transition.revision &&
    Number.isSafeInteger(evidence.start) && evidence.start >= 0 &&
    Number.isSafeInteger(evidence.end) && evidence.end > evidence.start &&
    typeof evidence.excerpt === "string" && evidence.excerpt.length > 0 &&
    evidence.end - evidence.start === evidence.excerpt.length &&
    evidence.status !== "stale";
}

function containedInContext(evidence: TextEvidence, context: TextEvidence): boolean {
  if (evidence.start < context.start || evidence.end > context.end) return false;
  return context.excerpt.slice(
    evidence.start - context.start,
    evidence.end - context.start
  ) === evidence.excerpt;
}

function validate(input: NarrativeLocationTrajectoryInput): Map<string, NarrativeLocationDocumentOrder> {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !Array.isArray(input.documentOrder) || !Array.isArray(input.transitions)) {
    throw new Error("Contexto inválido para ordenar trayectorias de ubicación.");
  }

  const documents = new Map<string, NarrativeLocationDocumentOrder>();
  const chapterOrders = new Set<number>();
  for (const item of input.documentOrder) {
    if (!item || typeof item.documentId !== "string" || !item.documentId.trim() ||
        !Number.isSafeInteger(item.chapterOrder) || item.chapterOrder < 0 ||
        documents.has(item.documentId) || chapterOrders.has(item.chapterOrder) ||
        (item.chapterLabel !== undefined &&
          (typeof item.chapterLabel !== "string" || !item.chapterLabel.trim()))) {
      throw new Error("El orden editorial contiene documentos o posiciones inválidas.");
    }
    documents.set(item.documentId, item);
    chapterOrders.add(item.chapterOrder);
  }

  const ids = new Set<string>();
  const revisions = new Map<string, number>();
  for (const transition of input.transitions) {
    if (!transition || transition.projectId !== input.projectId ||
        typeof transition.id !== "string" || !transition.id.trim() ||
        ids.has(transition.id) ||
        !documents.has(transition.documentId) ||
        !Number.isSafeInteger(transition.revision) || transition.revision < 0 ||
        typeof transition.locationEntityId !== "string" || !transition.locationEntityId.trim() ||
        typeof transition.actorEntityId !== "string" || !transition.actorEntityId.trim() ||
        transition.reviewStatus !== "candidate" ||
        !validEvidence(transition.actionEvidence, transition) ||
        !validEvidence(transition.locationEvidence, transition) ||
        !validEvidence(transition.actorEvidence, transition) ||
        !validEvidence(transition.relationEvidence, transition) ||
        !validEvidence(transition.contextEvidence, transition)) {
      throw new Error("La trayectoria contiene movimientos ajenos, duplicados o sin evidencia válida.");
    }
    ids.add(transition.id);
    const previousRevision = revisions.get(transition.documentId);
    if (previousRevision !== undefined && previousRevision !== transition.revision) {
      throw new Error("No se pueden mezclar revisiones de un mismo capítulo en una trayectoria.");
    }
    revisions.set(transition.documentId, transition.revision);
    const evidence = [
      transition.actionEvidence,
      transition.locationEvidence,
      transition.actorEvidence,
      transition.relationEvidence
    ];
    if (evidence.some(item => !containedInContext(item, transition.contextEvidence))) {
      throw new Error("Una evidencia de movimiento no coincide con su contexto original.");
    }
  }
  return documents;
}

/**
 * Agrupa movimientos por actor y orden editorial. Las secuencias salida-llegada
 * se señalan solo cuando ambos movimientos son afirmados y no prospectivos.
 */
export function buildNarrativeLocationTrajectories(
  input: NarrativeLocationTrajectoryInput
): readonly NarrativeLocationTrajectory[] {
  const documents = validate(input);
  const grouped = new Map<string, NarrativeLocationTransitionCandidate[]>();
  for (const transition of input.transitions) {
    const actor = transition.actorEntityId;
    if (!actor) continue;
    const list = grouped.get(actor) ?? [];
    list.push(transition);
    grouped.set(actor, list);
  }

  const trajectories: NarrativeLocationTrajectory[] = [];
  for (const [actorEntityId, transitions] of grouped) {
    const ordered = [...transitions].sort((a, b) => {
      const chapterDifference =
        documents.get(a.documentId)!.chapterOrder -
        documents.get(b.documentId)!.chapterOrder;
      return chapterDifference ||
        a.actionEvidence.start - b.actionEvidence.start ||
        a.actionEvidence.end - b.actionEvidence.end ||
        a.id.localeCompare(b.id);
    });

    const entries: NarrativeLocationTrajectoryEntry[] = ordered.map((transition, index) => {
      const previous = ordered[index - 1];
      const previousOrder = previous
        ? documents.get(previous.documentId)!.chapterOrder
        : -1;
      const currentOrder = documents.get(transition.documentId)!.chapterOrder;
      const interveningDocumentsWithoutTransitionCandidate = previous
        ? input.documentOrder
          .filter(item => item.chapterOrder > previousOrder && item.chapterOrder < currentOrder)
          .filter(item => !transitions.some(candidate => candidate.documentId === item.documentId))
          .sort((a, b) => a.chapterOrder - b.chapterOrder)
          .map(item => item.documentId)
        : [];
      const document = documents.get(transition.documentId)!;
      return {
        sequenceIndex: index,
        chapterOrder: document.chapterOrder,
        ...(document.chapterLabel ? { chapterLabel: document.chapterLabel } : {}),
        transition,
        interveningDocumentsWithoutTransitionCandidate
      };
    });

    const movementSequences: NarrativeLocationMovementSequence[] = [];
    for (let index = 1; index < ordered.length; index += 1) {
      const departure = ordered[index - 1];
      const arrival = ordered[index];
      if (!departure || !arrival ||
          departure.transition !== "departed" || arrival.transition !== "arrived" ||
          departure.polarity !== "affirmed" || arrival.polarity !== "affirmed" ||
          departure.effectStatus !== "candidate" || arrival.effectStatus !== "candidate" ||
          departure.locationEntityId === arrival.locationEntityId) continue;
      movementSequences.push({
        id: "location-sequence:" + departure.id + ":" + arrival.id,
        kind: "departure-arrival-sequence",
        departureTransitionId: departure.id,
        arrivalTransitionId: arrival.id,
        actorEntityId,
        fromLocationEntityId: departure.locationEntityId,
        toLocationEntityId: arrival.locationEntityId,
        evidence: [departure.contextEvidence, arrival.contextEvidence],
        status: "sequence-candidate"
      });
    }

    trajectories.push({
      projectId: input.projectId,
      actorEntityId,
      entries,
      movementSequences,
      evidenceCoverage: "candidate-movements-only",
      reviewStatus: "candidate"
    });
  }

  return trajectories.sort((a, b) => a.actorEntityId.localeCompare(b.actorEntityId));
}
