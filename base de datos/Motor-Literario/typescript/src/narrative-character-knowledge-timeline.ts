/**
 * Construye secuencias de afirmaciones cognitivas sin confundir orden textual
 * con cronología de la historia. Solo asocia fechas explícitas contenidas en
 * el mismo fragmento de evidencia; nunca propaga anclas a otros pasajes.
 */
import type { TextEvidence } from "./narrative-knowledge";
import type { NarrativeCharacterKnowledgeCandidate } from "./narrative-character-knowledge-discovery";
import type { NarrativeTemporalReferenceCandidate } from "./narrative-temporal-reference-discovery";

export interface NarrativeKnowledgeDocumentOrder {
  readonly documentId: string;
  /** Orden de capítulos/documentos proporcionado explícitamente por el proyecto. */
  readonly order: number;
}
export interface NarrativeCharacterKnowledgeTimelineInput {
  readonly projectId: string;
  readonly candidates: readonly NarrativeCharacterKnowledgeCandidate[];
  readonly temporalReferences: readonly NarrativeTemporalReferenceCandidate[];
  readonly documentOrder?: readonly NarrativeKnowledgeDocumentOrder[];
}
export interface NarrativeCharacterKnowledgeTimelineEntry {
  readonly id: string;
  readonly projectId: string;
  readonly holderEntityId: string;
  readonly candidate: NarrativeCharacterKnowledgeCandidate;
  /** Posición en el orden de lectura textual, nunca una fecha diegética inferida. */
  readonly textualOrder: {
    readonly documentOrder?: number;
    readonly documentId: string;
    readonly revision: number;
    readonly offset: number;
  };
  /** Referencia temporal explícita en el mismo fragmento; puede estar ausente. */
  readonly explicitTemporalReference?: NarrativeTemporalReferenceCandidate;
  readonly temporalAssociation: "same-evidence-span" | "none";
  readonly reviewStatus: "candidate";
}
export interface NarrativeCharacterKnowledgeTimeline {
  readonly projectId: string;
  readonly entries: readonly NarrativeCharacterKnowledgeTimelineEntry[];
  readonly orderingBasis: "explicit-document-order-then-text-offset" | "document-local-text-offset";
  readonly chronologyResolved: false;
}
export const MAX_NARRATIVE_KNOWLEDGE_TIMELINE_CANDIDATES = 10_000;
export const MAX_NARRATIVE_KNOWLEDGE_TIMELINE_TEMPORAL_REFERENCES = 20_000;
export const MAX_NARRATIVE_KNOWLEDGE_TIMELINE_DOCUMENTS = 5_000;

function validEvidence(item: TextEvidence, documentId: string, revision: number): boolean {
  return !!item && item.documentId === documentId && item.revision === revision &&
    Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) &&
    item.start >= 0 && item.end > item.start && typeof item.excerpt === "string" &&
    item.excerpt.length === item.end - item.start;
}
function validate(input: NarrativeCharacterKnowledgeTimelineInput): void {
  if (!input || typeof input !== "object" || typeof input.projectId !== "string" ||
      !input.projectId.trim() || !Array.isArray(input.candidates) ||
      input.candidates.length > MAX_NARRATIVE_KNOWLEDGE_TIMELINE_CANDIDATES ||
      !Array.isArray(input.temporalReferences) ||
      input.temporalReferences.length > MAX_NARRATIVE_KNOWLEDGE_TIMELINE_TEMPORAL_REFERENCES ||
      (input.documentOrder !== undefined &&
        (!Array.isArray(input.documentOrder) ||
         input.documentOrder.length > MAX_NARRATIVE_KNOWLEDGE_TIMELINE_DOCUMENTS))) {
    throw new Error("Entrada inválida para reconstruir la secuencia de conocimiento.");
  }
  const orders = new Set<string>(), values = new Set<number>();
  for (const item of input.documentOrder ?? []) {
    if (!item || typeof item.documentId !== "string" || !item.documentId.trim() ||
        !Number.isSafeInteger(item.order) || item.order < 0 ||
        orders.has(item.documentId) || values.has(item.order)) {
      throw new Error("El orden documental explícito contiene identificadores o posiciones duplicadas/inválidas.");
    }
    orders.add(item.documentId); values.add(item.order);
  }
  const candidateIds = new Set<string>();
  for (const item of input.candidates) {
    if (!item || item.projectId !== input.projectId || typeof item.id !== "string" ||
        !item.id.trim() || candidateIds.has(item.id) ||
        typeof item.holderEntityId !== "string" || !item.holderEntityId.trim() ||
        !validEvidence(item.evidence, item.documentId, item.revision) ||
        !validEvidence(item.holderEvidence, item.documentId, item.revision) ||
        !validEvidence(item.triggerEvidence, item.documentId, item.revision) ||
        item.holderEvidence.start < item.evidence.start || item.holderEvidence.end > item.evidence.end ||
        item.triggerEvidence.start < item.evidence.start || item.triggerEvidence.end > item.evidence.end ||
        (item.propositionEvidence !== undefined &&
          (!validEvidence(item.propositionEvidence, item.documentId, item.revision) ||
           item.propositionEvidence.start < item.evidence.start ||
           item.propositionEvidence.end > item.evidence.end)) ||
        (item.sourceEvidence !== undefined &&
          (!validEvidence(item.sourceEvidence, item.documentId, item.revision) ||
           item.sourceEvidence.start < item.evidence.start || item.sourceEvidence.end > item.evidence.end))) {
      throw new Error("Afirmación cognitiva inválida o con evidencia fuera de su fragmento.");
    }
    candidateIds.add(item.id);
  }
  const temporalIds = new Set<string>();
  for (const item of input.temporalReferences) {
    if (!item || item.projectId !== input.projectId || typeof item.id !== "string" ||
        !item.id.trim() || temporalIds.has(item.id) ||
        !validEvidence(item.evidence, item.documentId, item.revision)) {
      throw new Error("Referencia temporal inválida o ajena al proyecto.");
    }
    temporalIds.add(item.id);
  }
}

/**
 * Ordena por orden documental explícito si se proporciona; sin él, los
 * documentos distintos quedan agrupados por ID y no se afirma su orden mutuo.
 */
export function buildNarrativeCharacterKnowledgeTimeline(
  input: NarrativeCharacterKnowledgeTimelineInput
): NarrativeCharacterKnowledgeTimeline {
  validate(input);
  const order = new Map((input.documentOrder ?? []).map(item => [item.documentId, item.order]));
  const entries = input.candidates.map(candidate => {
    const matches = input.temporalReferences.filter(reference =>
      reference.documentId === candidate.documentId &&
      reference.revision === candidate.revision &&
      reference.evidence.start >= candidate.evidence.start &&
      reference.evidence.end <= candidate.evidence.end
    );
    const explicitTemporalReference = matches.length === 1 ? matches[0] : undefined;
    return {
      id: "knowledge-timeline:" + candidate.id,
      projectId: input.projectId,
      holderEntityId: candidate.holderEntityId,
      candidate,
      textualOrder: {
        ...(order.has(candidate.documentId) ? { documentOrder: order.get(candidate.documentId)! } : {}),
        documentId: candidate.documentId,
        revision: candidate.revision,
        offset: candidate.evidence.start
      },
      ...(explicitTemporalReference ? { explicitTemporalReference } : {}),
      temporalAssociation: explicitTemporalReference ? "same-evidence-span" as const : "none" as const,
      reviewStatus: "candidate" as const
    };
  });
  const hasExplicitOrder = input.documentOrder !== undefined;
  entries.sort((a, b) => {
    if (hasExplicitOrder) {
      const ao = a.textualOrder.documentOrder, bo = b.textualOrder.documentOrder;
      if (ao !== undefined && bo !== undefined && ao !== bo) return ao - bo;
      if (ao !== undefined && bo === undefined) return -1;
      if (ao === undefined && bo !== undefined) return 1;
    }
    return a.textualOrder.documentId.localeCompare(b.textualOrder.documentId) ||
      a.textualOrder.revision - b.textualOrder.revision ||
      a.textualOrder.offset - b.textualOrder.offset ||
      a.candidate.id.localeCompare(b.candidate.id);
  });
  return {
    projectId: input.projectId,
    entries,
    orderingBasis: hasExplicitOrder ? "explicit-document-order-then-text-offset" : "document-local-text-offset",
    chronologyResolved: false
  };
}
