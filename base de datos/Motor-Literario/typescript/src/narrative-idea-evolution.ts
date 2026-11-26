import type {
  NarrativeIdeaCrossDocumentAnalysis,
  NarrativeIdeaCrossDocumentRelation,
  NarrativeIdeaOccurrenceReference
} from "./narrative-idea-cross-document-relations";

export type NarrativeIdeaEvolutionSignal =
  | "exact-wording-recurrence"
  | "lexical-resonance"
  | "modality-change"
  | "idea-kind-change";

export type NarrativeIdeaEvolutionEventKind =
  | "reappeared"
  | "echoed"
  | "observed-without-order";

export interface NarrativeIdeaEvolutionEvent {
  readonly id: string;
  readonly projectId: string;
  readonly eventKind: NarrativeIdeaEvolutionEventKind;
  readonly reviewStatus: "candidate";
  readonly chronology: "ordered" | "unknown";
  /** Solo se publican cuando el orden de ambos documentos fue aportado por el proyecto. */
  readonly earlierOccurrence?: NarrativeIdeaOccurrenceReference;
  readonly laterOccurrence?: NarrativeIdeaOccurrenceReference;
  /** Se conservan ambos extremos incluso cuando su orden es desconocido. */
  readonly firstOccurrence: NarrativeIdeaOccurrenceReference;
  readonly secondOccurrence: NarrativeIdeaOccurrenceReference;
  readonly signals: readonly NarrativeIdeaEvolutionSignal[];
  readonly supportingRelation: {
    readonly relationId: string;
    readonly relationType: NarrativeIdeaCrossDocumentRelation["relationType"];
    readonly sharedTerms: readonly string[];
    readonly normalizedSimilarity: number;
    readonly overlapCoefficient: number;
  };
}

export interface NarrativeIdeaEvolutionSummary {
  readonly projectId: string;
  readonly relationCount: number;
  readonly eventCount: number;
  readonly reappearedCount: number;
  readonly echoedCount: number;
  readonly withoutOrderCount: number;
  readonly modalityChangeCount: number;
  readonly ideaKindChangeCount: number;
  readonly sourceAnalysisTruncated: boolean;
}

export interface NarrativeIdeaEvolutionResult {
  readonly summary: NarrativeIdeaEvolutionSummary;
  readonly events: readonly NarrativeIdeaEvolutionEvent[];
}

export interface NarrativeIdeaEvolutionInput {
  readonly projectId: string;
  readonly crossDocumentAnalysis: NarrativeIdeaCrossDocumentAnalysis;
  /** Solo el análisis de relaciones es insumo; nunca se modifica la biblioteca editorial. */
}

const MAX_RELATIONS = 10_000;
const MAX_SHARED_TERMS = 500;
const MAX_OCCURRENCE_TEXT_UNITS = 500;
const MAX_EVIDENCE_UNITS = 2_000_000;

function validateOccurrence(
  occurrence: NarrativeIdeaOccurrenceReference
): void {
  if (!occurrence || typeof occurrence !== "object" ||
      typeof occurrence.ideaCandidateId !== "string" || !occurrence.ideaCandidateId.trim() ||
      typeof occurrence.documentId !== "string" || !occurrence.documentId.trim() ||
      !Number.isSafeInteger(occurrence.revision) || occurrence.revision < 0 ||
      typeof occurrence.text !== "string" || !occurrence.text.trim() ||
      occurrence.text.length > MAX_OCCURRENCE_TEXT_UNITS ||
      !["theme", "premise", "conflict", "goal", "motivation", "dilemma", "question", "hypothesis", "motif"].includes(occurrence.kind) ||
      !["affirmed", "negated", "conditional", "hypothetical"].includes(occurrence.polarity) ||
      !occurrence.evidence ||
      occurrence.evidence.documentId !== occurrence.documentId ||
      occurrence.evidence.revision !== occurrence.revision ||
      typeof occurrence.evidence.excerpt !== "string" ||
      !occurrence.evidence.excerpt.includes(occurrence.text) ||
      !Number.isSafeInteger(occurrence.evidence.start) ||
      !Number.isSafeInteger(occurrence.evidence.end) ||
      occurrence.evidence.start < 0 ||
      occurrence.evidence.end <= occurrence.evidence.start ||
      occurrence.evidence.excerpt.length > MAX_EVIDENCE_UNITS) {
    throw new Error("La evolución contiene una aparición de idea inválida.");
  }
}

function normalizeExactPhrase(value: string): string {
  return value.normalize("NFKD")
    .replace(/\\p{M}/gu, "")
    .toLocaleLowerCase("es")
    .replace(/[\\p{P}\\p{S}]+/gu, " ")
    .replace(/\\s+/gu, " ")
    .trim()
    .normalize("NFKC");
}

function validateRelation(
  relation: NarrativeIdeaCrossDocumentRelation,
  projectId: string
): void {
  if (!relation || typeof relation !== "object" ||
      relation.projectId !== projectId ||
      typeof relation.id !== "string" || !relation.id.trim() ||
      !["exact-recurrence", "lexical-resonance"].includes(relation.relationType) ||
      relation.reviewStatus !== "candidate" ||
      !["ordered", "unknown"].includes(relation.chronology) ||
      !["consistent", "changed"].includes(relation.polarityRelation) ||
      !Array.isArray(relation.sharedTerms) ||
      relation.sharedTerms.length > MAX_SHARED_TERMS ||
      relation.sharedTerms.some(term => typeof term !== "string" || !term.trim()) ||
      typeof relation.normalizedSimilarity !== "number" ||
      !Number.isFinite(relation.normalizedSimilarity) ||
      relation.normalizedSimilarity < 0 || relation.normalizedSimilarity > 1 ||
      typeof relation.overlapCoefficient !== "number" ||
      !Number.isFinite(relation.overlapCoefficient) ||
      relation.overlapCoefficient < 0 || relation.overlapCoefficient > 1) {
    throw new Error("La relación de origen para evolución de ideas es inválida.");
  }

  validateOccurrence(relation.first);
  validateOccurrence(relation.second);

  if ((relation.first.polarity === relation.second.polarity ? "consistent" : "changed") !== relation.polarityRelation) {
    throw new Error("La modalidad de la relación no coincide con las dos apariciones.");
  }
  if (relation.relationType === "exact-recurrence" &&
      (relation.normalizedSimilarity !== 1 || relation.overlapCoefficient !== 1 ||
        normalizeExactPhrase(relation.first.text) !== normalizeExactPhrase(relation.second.text))) {
    throw new Error("Una recurrencia exacta debe conservar texto normalizado y métricas unitarias.");
  }

  if (relation.first.ideaCandidateId === relation.second.ideaCandidateId ||
      relation.first.documentId === relation.second.documentId) {
    throw new Error("La evolución requiere dos apariciones de capítulos distintos.");
  }

  if (relation.relationType === "lexical-resonance" && relation.sharedTerms.length < 2) {
    throw new Error("Una resonancia léxica requiere al menos dos términos compartidos.");
  }

  if (relation.chronology === "ordered") {
    const documents = new Set([
      relation.first.documentId,
      relation.second.documentId
    ]);
    if (typeof relation.earlierDocumentId !== "string" ||
        typeof relation.laterDocumentId !== "string" ||
        !documents.has(relation.earlierDocumentId) ||
        !documents.has(relation.laterDocumentId) ||
        relation.earlierDocumentId === relation.laterDocumentId) {
      throw new Error("La cronología de la relación no identifica ambos documentos.");
    }
  } else if (relation.earlierDocumentId !== undefined ||
      relation.laterDocumentId !== undefined) {
    throw new Error("Una relación sin cronología no puede declarar un documento anterior o posterior.");
  }
}

function signalsFor(
  relation: NarrativeIdeaCrossDocumentRelation
): readonly NarrativeIdeaEvolutionSignal[] {
  const signals: NarrativeIdeaEvolutionSignal[] = [
    relation.relationType === "exact-recurrence"
      ? "exact-wording-recurrence"
      : "lexical-resonance"
  ];
  if (relation.polarityRelation === "changed") signals.push("modality-change");
  if (relation.first.kind !== relation.second.kind) signals.push("idea-kind-change");
  return signals;
}

function orderOccurrences(
  relation: NarrativeIdeaCrossDocumentRelation
): {
  readonly earlier: NarrativeIdeaOccurrenceReference;
  readonly later: NarrativeIdeaOccurrenceReference;
} {
  const earlier = relation.first.documentId === relation.earlierDocumentId
    ? relation.first
    : relation.second;
  const later = relation.first.documentId === relation.laterDocumentId
    ? relation.first
    : relation.second;
  return { earlier, later };
}

/**
 * Convierte relaciones transversales explicables en eventos de evolución.
 *
 * "reappeared" y "echoed" requieren orden documental explícito. Sin cronología,
 * solo se informa de una relación observada. No se afirma que una idea haya
 * nacido, muerto, sido sustituida o cambiado de significado.
 */
export function buildNarrativeIdeaEvolution(
  input: NarrativeIdeaEvolutionInput
): NarrativeIdeaEvolutionResult {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !input.crossDocumentAnalysis ||
      input.crossDocumentAnalysis.projectId !== input.projectId ||
      !Array.isArray(input.crossDocumentAnalysis.relations) ||
      input.crossDocumentAnalysis.relations.length > MAX_RELATIONS ||
      !Number.isSafeInteger(input.crossDocumentAnalysis.analyzedCandidateCount) ||
      input.crossDocumentAnalysis.analyzedCandidateCount < 0 ||
      input.crossDocumentAnalysis.analyzedCandidateCount > 200 ||
      !Number.isSafeInteger(input.crossDocumentAnalysis.comparedCrossDocumentPairs) ||
      input.crossDocumentAnalysis.comparedCrossDocumentPairs < 0 ||
      input.crossDocumentAnalysis.comparedCrossDocumentPairs > 19_900 ||
      typeof input.crossDocumentAnalysis.truncated !== "boolean") {
    throw new Error("Contexto inválido para construir la evolución de ideas.");
  }

  const seenIds = new Set<string>();
  const events: NarrativeIdeaEvolutionEvent[] = [];
  let reappearedCount = 0;
  let echoedCount = 0;
  let withoutOrderCount = 0;
  let modalityChangeCount = 0;
  let ideaKindChangeCount = 0;

  for (const relation of input.crossDocumentAnalysis.relations) {
    validateRelation(relation, input.projectId);
    if (seenIds.has(relation.id)) {
      throw new Error("La evolución recibió relaciones duplicadas.");
    }
    seenIds.add(relation.id);

    const eventKind: NarrativeIdeaEvolutionEventKind =
      relation.chronology === "unknown" ? "observed-without-order" :
      relation.relationType === "exact-recurrence" ? "reappeared" : "echoed";
    const signals = signalsFor(relation);

    if (eventKind === "reappeared") reappearedCount++;
    if (eventKind === "echoed") echoedCount++;
    if (eventKind === "observed-without-order") withoutOrderCount++;
    if (relation.polarityRelation === "changed") modalityChangeCount++;
    if (relation.first.kind !== relation.second.kind) ideaKindChangeCount++;

    const ordered = relation.chronology === "ordered"
      ? orderOccurrences(relation)
      : undefined;

    events.push({
      id: "idea-evolution:" + encodeURIComponent(relation.id),
      projectId: input.projectId,
      eventKind,
      reviewStatus: "candidate",
      chronology: relation.chronology,
      ...(ordered ? {
        earlierOccurrence: ordered.earlier,
        laterOccurrence: ordered.later
      } : {}),
      firstOccurrence: relation.first,
      secondOccurrence: relation.second,
      signals,
      supportingRelation: {
        relationId: relation.id,
        relationType: relation.relationType,
        sharedTerms: [...relation.sharedTerms],
        normalizedSimilarity: relation.normalizedSimilarity,
        overlapCoefficient: relation.overlapCoefficient
      }
    });
  }

  events.sort((a, b) =>
    a.eventKind.localeCompare(b.eventKind) ||
    a.supportingRelation.relationId.localeCompare(b.supportingRelation.relationId)
  );

  return {
    summary: {
      projectId: input.projectId,
      relationCount: input.crossDocumentAnalysis.relations.length,
      eventCount: events.length,
      reappearedCount,
      echoedCount,
      withoutOrderCount,
      modalityChangeCount,
      ideaKindChangeCount,
      sourceAnalysisTruncated: input.crossDocumentAnalysis.truncated
    },
    events
  };
}
