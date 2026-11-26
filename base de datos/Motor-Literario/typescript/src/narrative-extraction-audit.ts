import type { TextEvidence } from "./narrative-knowledge";

export const MAX_NARRATIVE_AUDIT_SENTENCES = 100_000;
export const MAX_NARRATIVE_AUDIT_UNREVIEWED = 1_000;

export interface NarrativeAuditEvidenceSource {
  readonly evidence: TextEvidence | readonly TextEvidence[];
}

export interface NarrativeUncoveredSentenceCandidate {
  readonly id: string;
  readonly evidence: TextEvidence;
  readonly reason: "no-action-or-event-evidence-overlap";
  readonly reviewStatus: "unreviewed";
}

export interface NarrativeExtractionAudit {
  readonly documentId: string;
  readonly revision: number;
  readonly sourceLength: number;
  readonly sentenceCount: number;
  readonly sentencesWithActionOrEventEvidence: number;
  readonly sentencesWithoutActionOrEventEvidence: number;
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
}

interface Span { readonly start: number; readonly end: number; }

function sentenceSpans(text: string): readonly Span[] {
  const spans: Span[] = [];
  // Conserva offsets UTF-16; separa por puntuación terminal y saltos de línea.
  // Es una segmentación operativa para cobertura, no un analizador sintáctico.
  const expression = /[^.!?\r\n]+(?:[.!?]+|$)/gu;
  for (const line of text.split(/(?<=\n)/u)) {
    const lineStart = text.indexOf(line, spans.length ? spans[spans.length - 1]!.end : 0);
    for (const match of line.matchAll(expression)) {
      const raw = match[0];
      const leading = raw.search(/\S/u);
      const trailing = raw.trimEnd().length;
      const candidate = raw.slice(leading, trailing).trim();
      const structuralHeading = /^(?:#{1,6}\s*)?(?:(?:cap[ií]tulo|chapter|parte|part|libro|book)\s+(?:[ivxlcdm]+|\d+|[a-záéíóúñ-]+)(?:\s*[:.—-].*)?|pr[oó]logo|ep[ií]logo|introducci[oó]n|interludio)$/iu.test(candidate);
      if (leading < 0 || trailing <= leading || !/[\\p{L}\\p{N}]/u.test(raw) || structuralHeading) continue;
      spans.push({
        start: lineStart + (match.index ?? 0) + leading,
        end: lineStart + (match.index ?? 0) + trailing
      });
      if (spans.length >= MAX_NARRATIVE_AUDIT_SENTENCES) return spans;
    }
  }
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
 * acciones o acontecimientos explícitos. No los clasifica como irrelevantes:
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
      !Array.isArray(input.observations) || !Array.isArray(input.events)) {
    throw new Error("Entrada inválida para auditar la cobertura de extracción narrativa.");
  }

  const baseOffset = input.baseOffset ?? 0;
  const evidence = [
    ...flattenEvidence(input.observations),
    ...flattenEvidence(input.events)
  ];
  for (const item of evidence) {
    validateEvidence(item, input.documentId, input.revision, baseOffset, input.text.length);
    if (input.text.slice(item.start - baseOffset, item.end - baseOffset) !== item.excerpt) {
      throw new Error("La evidencia de auditoría no coincide literalmente con el texto fuente.");
    }
  }

  const allSpans = sentenceSpans(input.text);
  const sentenceCount = allSpans.length;
  const sentenceSpansTruncated = sentenceCount >= MAX_NARRATIVE_AUDIT_SENTENCES;
  const uncovered: NarrativeUncoveredSentenceCandidate[] = [];
  let coveredCount = 0;
  for (const span of allSpans) {
    const absoluteStart = baseOffset + span.start;
    const absoluteEnd = baseOffset + span.end;
    const covered = evidence.some(item =>
      item.start < absoluteEnd && item.end > absoluteStart
    );
    if (covered) {
      coveredCount += 1;
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
        reason: "no-action-or-event-evidence-overlap",
        reviewStatus: "unreviewed"
      });
    }
  }
  const uncoveredCount = sentenceCount - coveredCount;
  return {
    documentId: input.documentId,
    revision: input.revision,
    sourceLength: input.text.length,
    sentenceCount,
    sentencesWithActionOrEventEvidence: coveredCount,
    sentencesWithoutActionOrEventEvidence: uncoveredCount,
    coverageRatio: sentenceCount === 0 ? 1 : coveredCount / sentenceCount,
    uncoveredSentences: uncovered,
    omittedUncoveredSentences: Math.max(0, uncoveredCount - uncovered.length),
    truncated: sentenceSpansTruncated || uncoveredCount > uncovered.length,
    interpretation: "coverage-of-current-extractors-not-semantic-completeness"
  };
}
