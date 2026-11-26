import type { TextEvidence } from "./narrative-knowledge";

export const MAX_NARRATIVE_AUDIT_SENTENCES = 100_000;
export const MAX_NARRATIVE_AUDIT_UNREVIEWED = 1_000;

export interface NarrativeAuditEvidenceSource {
  readonly evidence: TextEvidence | readonly TextEvidence[];
}

export interface NarrativeUncoveredSentenceCandidate {
  readonly id: string;
  readonly evidence: TextEvidence;
  readonly reason: "no-extracted-evidence-overlap";
  readonly reviewStatus: "unreviewed";
}

export interface NarrativeExtractionAudit {
  readonly documentId: string;
  readonly revision: number;
  readonly sourceLength: number;
  readonly sentenceCount: number;
  readonly sentencesWithActionOrEventEvidence: number;
  readonly sentencesWithoutActionOrEventEvidence: number;
  readonly sentencesWithAdditionalEvidence: number;
  readonly sentencesWithAnyExtractedEvidence: number;
  readonly sentencesWithoutAnyExtractedEvidence: number;
  readonly coverageRatio: number;
  readonly uncoveredSentences: readonly NarrativeUncoveredSentenceCandidate[];
  readonly omittedUncoveredSentences: number;
  readonly truncated: boolean;
  readonly interpretation: "coverage-of-current-extractors-not-semantic-completeness";
}

export interface NarrativeExtractionAuditInput {
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly baseOffset?: number;
  readonly observations: readonly NarrativeAuditEvidenceSource[];
  readonly events: readonly NarrativeAuditEvidenceSource[];
  /** Evidencias de otros extractores, por ejemplo estados o trayectorias espaciales. */
  readonly additionalEvidence?: readonly NarrativeAuditEvidenceSource[];
}

interface Span { readonly start: number; readonly end: number; }

function sentenceSpans(text: string): readonly Span[] {
  const spans: Span[] = [];
  const structuralHeading = /^(?:#{1,6}\s*)?(?:(?:cap[ií]tulo|chapter|parte|part|libro|book)\s+(?:[ivxlcdm]+|\d+|[a-záéíóúñ-]+)(?:\s*[:.—-].*)?|pr[oó]logo|ep[ií]logo|introducci[oó]n|interludio)$/iu;
  let segmentStart = 0;

  const append = (rawStart: number, rawEnd: number): boolean => {
    let start = rawStart;
    let end = rawEnd;
    while (start < end && /\s/u.test(text[start]!)) start += 1;
    while (end > start && /\s/u.test(text[end - 1]!)) end -= 1;
    if (end <= start) return false;
    const excerpt = text.slice(start, end);
    if (!/[\p{L}\p{N}]/u.test(excerpt) || structuralHeading.test(excerpt)) return false;
    spans.push({ start, end });
    return spans.length >= MAX_NARRATIVE_AUDIT_SENTENCES;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character !== "." && character !== "!" && character !== "?" &&
        character !== "\n" && character !== "\r") continue;
    if (character === "." || character === "!" || character === "?") {
      let end = index + 1;
      while (end < text.length && /[.!?]/u.test(text[end]!)) end += 1;
      if (append(segmentStart, end)) return spans;
      segmentStart = end;
      index = end - 1;
    } else {
      if (append(segmentStart, index)) return spans;
      segmentStart = index + 1;
    }
  }
  append(segmentStart, text.length);
  return spans;
}

function flattenEvidence(sources: readonly NarrativeAuditEvidenceSource[]): readonly TextEvidence[] {
  return sources.flatMap(source => Array.isArray(source.evidence)
    ? source.evidence
    : [source.evidence as TextEvidence]);
}

function validateEvidence(
  evidence: TextEvidence,
  documentId: string,
  revision: number,
  baseOffset: number,
  sourceLength: number
): void {
  if (!evidence || evidence.documentId !== documentId ||
      evidence.revision !== revision ||
      !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) ||
      evidence.start < baseOffset || evidence.end <= evidence.start ||
      evidence.end > baseOffset + sourceLength ||
      typeof evidence.excerpt !== "string" ||
      evidence.end - evidence.start !== evidence.excerpt.length ||
      evidence.status === "stale") {
    throw new Error("La auditoría recibió evidencia inválida, obsoleta o ajena al texto fuente.");
  }
}

/**
 * Expone pasajes que no quedaron cubiertos por las extracciones actuales de
 * cualquier evidencia estructurada aportada por los extractores. No los clasifica como irrelevantes:
 * son una cola de revisión para descubrir omisiones del extractor.
 */
export function auditNarrativeExtractionCoverage(
  input: NarrativeExtractionAuditInput
): NarrativeExtractionAudit {
  if (!input || typeof input !== "object" ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length)) ||
      !Array.isArray(input.observations) || !Array.isArray(input.events) ||
      (input.additionalEvidence !== undefined && !Array.isArray(input.additionalEvidence))) {
    throw new Error("Entrada inválida para auditar la cobertura de extracción narrativa.");
  }

  const baseOffset = input.baseOffset ?? 0;
  const actionEventEvidence = [
    ...flattenEvidence(input.observations),
    ...flattenEvidence(input.events)
  ];
  const additionalEvidence = flattenEvidence(input.additionalEvidence ?? []);
  const evidence = [...actionEventEvidence, ...additionalEvidence];
  for (const item of evidence) {
    validateEvidence(item, input.documentId, input.revision, baseOffset, input.text.length);
    if (input.text.slice(item.start - baseOffset, item.end - baseOffset) !== item.excerpt) {
      throw new Error("La evidencia de auditoría no coincide literalmente con el texto fuente.");
    }
  }

  const allSpans = sentenceSpans(input.text);
  const sentenceCount = allSpans.length;
  const sentenceSpansTruncated = sentenceCount >= MAX_NARRATIVE_AUDIT_SENTENCES;
  const orderEvidence = (items: readonly TextEvidence[]) => [...items].sort((a, b) =>
    a.start - b.start || a.end - b.end
  );
  const orderedActionEventEvidence = orderEvidence(actionEventEvidence);
  const orderedAdditionalEvidence = orderEvidence(additionalEvidence);
  const uncovered: NarrativeUncoveredSentenceCandidate[] = [];
  let actionEventCoveredCount = 0;
  let additionalCoveredCount = 0;
  let anyCoveredCount = 0;
  let actionEventCursor = 0;
  let additionalCursor = 0;
  for (const span of allSpans) {
    const absoluteStart = baseOffset + span.start;
    const absoluteEnd = baseOffset + span.end;
    while (actionEventCursor < orderedActionEventEvidence.length &&
        orderedActionEventEvidence[actionEventCursor]!.end <= absoluteStart) {
      actionEventCursor += 1;
    }
    while (additionalCursor < orderedAdditionalEvidence.length &&
        orderedAdditionalEvidence[additionalCursor]!.end <= absoluteStart) {
      additionalCursor += 1;
    }
    const actionEventItem = orderedActionEventEvidence[actionEventCursor];
    const additionalItem = orderedAdditionalEvidence[additionalCursor];
    const actionEventCovered = !!actionEventItem &&
      actionEventItem.start < absoluteEnd && actionEventItem.end > absoluteStart;
    const additionalCovered = !!additionalItem &&
      additionalItem.start < absoluteEnd && additionalItem.end > absoluteStart;
    if (actionEventCovered) actionEventCoveredCount += 1;
    if (additionalCovered) additionalCoveredCount += 1;
    if (actionEventCovered || additionalCovered) {
      anyCoveredCount += 1;
      continue;
    }
    if (uncovered.length < MAX_NARRATIVE_AUDIT_UNREVIEWED) {
      uncovered.push({
        id: "uncovered:" + input.documentId + ":" + input.revision + ":" + absoluteStart,
        evidence: {
          documentId: input.documentId,
          revision: input.revision,
          start: absoluteStart,
          end: absoluteEnd,
          excerpt: input.text.slice(span.start, span.end)
        },
        reason: "no-extracted-evidence-overlap",
        reviewStatus: "unreviewed"
      });
    }
  }
  const uncoveredCount = sentenceCount - anyCoveredCount;
  return {
    documentId: input.documentId,
    revision: input.revision,
    sourceLength: input.text.length,
    sentenceCount,
    sentencesWithActionOrEventEvidence: actionEventCoveredCount,
    sentencesWithoutActionOrEventEvidence: sentenceCount - actionEventCoveredCount,
    sentencesWithAdditionalEvidence: additionalCoveredCount,
    sentencesWithAnyExtractedEvidence: anyCoveredCount,
    sentencesWithoutAnyExtractedEvidence: uncoveredCount,
    coverageRatio: sentenceCount === 0 ? 1 : anyCoveredCount / sentenceCount,
    uncoveredSentences: uncovered,
    omittedUncoveredSentences: Math.max(0, uncoveredCount - uncovered.length),
    truncated: sentenceSpansTruncated || uncoveredCount > uncovered.length,
    interpretation: "coverage-of-current-extractors-not-semantic-completeness"
  };
}
