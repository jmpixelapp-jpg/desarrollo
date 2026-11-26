/**
 * Ordenación documental de transiciones candidatas de un mismo objeto.
 *
 * El orden entre capítulos debe venir del lector/proyecto; nunca se deduce de
 * nombres de archivo, fechas del sistema ni del orden accidental de un array.
 * Una ausencia de transición candidata no significa ausencia del objeto.
 */
import type { TextEvidence } from "./narrative-knowledge";
import type {
  NarrativeObjectTransitionCandidate
} from "./narrative-object-state-discovery";

export interface NarrativeDocumentOrder {
  readonly documentId: string;
  /** Posición editorial explícita, empezando en cero o uno. */
  readonly chapterOrder: number;
  readonly chapterLabel?: string;
}

export interface NarrativeObjectTrajectoryEntry {
  readonly sequenceIndex: number;
  readonly chapterOrder: number;
  readonly chapterLabel?: string;
  readonly transition: NarrativeObjectTransitionCandidate;
  /** Documentos intermedios sin una transición candidata para este objeto. */
  readonly interveningDocumentsWithoutTransitionCandidate: readonly string[];
}

export interface NarrativeObjectContinuitySignal {
  readonly id: string;
  readonly kind: "transfer-reception-corroboration";
  readonly fromTransitionId: string;
  readonly toTransitionId: string;
  readonly participantEntityId: string;
  readonly evidence: readonly [TextEvidence, TextEvidence];
  /** Compatibilidad textual candidata; no demuestra posesión efectiva. */
  readonly status: "corroboration-candidate";
}

export interface NarrativeObjectTrajectory {
  readonly projectId: string;
  readonly objectEntityId: string;
  readonly entries: readonly NarrativeObjectTrajectoryEntry[];
  readonly continuitySignals: readonly NarrativeObjectContinuitySignal[];
  readonly evidenceCoverage: "candidate-transitions-only";
  readonly reviewStatus: "candidate";
}

export interface NarrativeObjectTrajectoryInput {
  readonly projectId: string;
  readonly documentOrder: readonly NarrativeDocumentOrder[];
  readonly transitions: readonly NarrativeObjectTransitionCandidate[];
}

function validEvidence(
  evidence: TextEvidence | undefined,
  transition: NarrativeObjectTransitionCandidate
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

function validateInput(input: NarrativeObjectTrajectoryInput): Map<string, NarrativeDocumentOrder> {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !Array.isArray(input.documentOrder) || !Array.isArray(input.transitions)) {
    throw new Error("Contexto inválido para ordenar la trayectoria de objetos.");
  }

  const documents = new Map<string, NarrativeDocumentOrder>();
  const chapterOrders = new Set<number>();
  for (const item of input.documentOrder) {
    if (!item || typeof item.documentId !== "string" || !item.documentId.trim() ||
        !Number.isSafeInteger(item.chapterOrder) || item.chapterOrder < 0 ||
        documents.has(item.documentId) || chapterOrders.has(item.chapterOrder) ||
        (item.chapterLabel !== undefined &&
          (typeof item.chapterLabel !== "string" || !item.chapterLabel.trim()))) {
      throw new Error("El orden de capítulos contiene identificadores o posiciones inválidos.");
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
        typeof transition.objectEntityId !== "string" || !transition.objectEntityId.trim() ||
        transition.reviewStatus !== "candidate" ||
        !validEvidence(transition.actionEvidence, transition) ||
        !validEvidence(transition.objectEvidence, transition) ||
        !validEvidence(transition.contextEvidence, transition)) {
      throw new Error("La trayectoria contiene transiciones ajenas, duplicadas o sin evidencia válida.");
    }
    ids.add(transition.id);
    const previousRevision = revisions.get(transition.documentId);
    if (previousRevision !== undefined && previousRevision !== transition.revision) {
      throw new Error("No se pueden mezclar revisiones de un mismo capítulo en una trayectoria.");
    }
    revisions.set(transition.documentId, transition.revision);
    if (transition.actorEvidence && !validEvidence(transition.actorEvidence, transition)) {
      throw new Error("La evidencia del actor no es válida.");
    }
    if (transition.recipientEvidence && !validEvidence(transition.recipientEvidence, transition)) {
      throw new Error("La evidencia del receptor no es válida.");
    }
  }
  return documents;
}

/**
 * Construye secuencias por objeto usando exclusivamente el orden documental
 * suministrado. No deduce posesión, causalidad ni transferencias no observadas.
 */
export function buildNarrativeObjectTrajectories(
  input: NarrativeObjectTrajectoryInput
): readonly NarrativeObjectTrajectory[] {
  const documents = validateInput(input);
  const grouped = new Map<string, NarrativeObjectTransitionCandidate[]>();
  for (const transition of input.transitions) {
    const list = grouped.get(transition.objectEntityId) ?? [];
    list.push(transition);
    grouped.set(transition.objectEntityId, list);
  }

  const trajectories: NarrativeObjectTrajectory[] = [];
  for (const [objectEntityId, transitions] of grouped) {
    const ordered = transitions.sort((a, b) => {
      const chapterDifference =
        documents.get(a.documentId)!.chapterOrder -
        documents.get(b.documentId)!.chapterOrder;
      return chapterDifference || a.actionEvidence.start - b.actionEvidence.start ||
        a.actionEvidence.end - b.actionEvidence.end || a.id.localeCompare(b.id);
    });

    const entries: NarrativeObjectTrajectoryEntry[] = ordered.map((transition, index) => {
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

    const continuitySignals: NarrativeObjectContinuitySignal[] = [];
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      // Vincular solo dos enunciados consecutivos, afirmados y no prospectivos:
      // «A entregó X a B» seguido de «B recibió X».
      if (previous.transition !== "transferred" ||
          current.transition !== "received" ||
          previous.polarity !== "affirmed" || current.polarity !== "affirmed" ||
          previous.effectStatus !== "candidate" || current.effectStatus !== "candidate" ||
          !previous.recipientEntityId ||
          previous.recipientEntityId !== current.recipientEntityId ||
          !previous.recipientEvidence || !current.recipientEvidence) {
        continue;
      }
      continuitySignals.push({
        id: `continuity:${previous.id}:${current.id}`,
        kind: "transfer-reception-corroboration",
        fromTransitionId: previous.id,
        toTransitionId: current.id,
        participantEntityId: previous.recipientEntityId,
        evidence: [previous.recipientEvidence, current.recipientEvidence],
        status: "corroboration-candidate"
      });
    }

    trajectories.push({
      projectId: input.projectId,
      objectEntityId,
      entries,
      continuitySignals,
      evidenceCoverage: "candidate-transitions-only",
      reviewStatus: "candidate"
    });
  }

  return trajectories.sort((a, b) => a.objectEntityId.localeCompare(b.objectEntityId));
}
