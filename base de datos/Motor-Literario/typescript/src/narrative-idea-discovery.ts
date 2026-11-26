/**
 * Descubrimiento conservador de ideas narrativas a partir de prosa natural.
 *
 * Este módulo NO convierte automáticamente una interpretación en una idea
 * confirmada. Devuelve candidatos revisables, cada uno enlazado a evidencia
 * textual y offsets UTF-16 absolutos del documento.
 */

export const MAX_NARRATIVE_IDEA_DISCOVERY_TEXT_UNITS = 2_000_000;
export const MAX_NARRATIVE_IDEA_DISCOVERY_CANDIDATES = 100;
export const MAX_NARRATIVE_IDEA_CANDIDATE_TEXT_UNITS = 500;

export type NarrativeIdeaCandidateKind =
  | "theme"
  | "premise"
  | "conflict"
  | "goal"
  | "motivation"
  | "dilemma"
  | "question"
  | "hypothesis"
  | "motif";

export type NarrativeIdeaCandidateConfidence = "high" | "medium";
export type NarrativeIdeaCandidatePolarity = "affirmed" | "negated" | "conditional" | "hypothetical";

export interface NarrativeIdeaCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly kind: NarrativeIdeaCandidateKind;
  /** Fragmento que expresa la idea; no es una paráfrasis generada. */
  readonly text: string;
  /** La confianza mide la claridad de la señal lingüística, no la verdad. */
  readonly confidence: NarrativeIdeaCandidateConfidence;
  /** Forma lingüística observada; no equivale a verdad ni a canon narrativo. */
  readonly polarity: NarrativeIdeaCandidatePolarity;
  readonly reviewStatus: "candidate";
  readonly evidence: {
    readonly start: number;
    readonly end: number;
    readonly excerpt: string;
  };
}

export interface NarrativeIdeaDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  /** Offset UTF-16 absoluto cuando se analiza una ventana del documento. */
  readonly baseOffset?: number;
}

interface DiscoveryPattern {
  readonly kind: NarrativeIdeaCandidateKind;
  readonly confidence: NarrativeIdeaCandidateConfidence;
  readonly expression: RegExp;
}

/**
 * Las señales son deliberadamente explícitas. No se considera que cada frase,
 * sustantivo repetido o emoción sea una idea por sí sola.
 */
const DISCOVERY_PATTERNS: readonly DiscoveryPattern[] = [
  {
    kind: "premise",
    confidence: "high",
    expression: /\b(?:la\s+)?(?:idea\s+central|idea\s+principal|premisa(?:\s+narrativa)?)\s*(?:es|consiste\s+en|:)?\s+(.+?)(?=[.!?;]|$)/iu
  },
  {
    kind: "theme",
    confidence: "high",
    expression: /\b(?:el\s+)?(?:tema\s+central|tema\s+principal|tema\s+de\s+la\s+historia)\s*(?:es|:)?\s+(.+?)(?=[.!?;]|$)/iu
  },
  {
    kind: "theme",
    confidence: "medium",
    expression: /\b(?:la\s+historia|el\s+relato|la\s+novela)\s+trata\s+sobre\s+(.+?)(?=[.!?;]|$)/iu
  },
  {
    kind: "conflict",
    confidence: "high",
    expression: /\b(?:conflicto\s+central|conflicto\s+principal|problema\s+central)\s*(?:es|consiste\s+en|:)?\s+(.+?)(?=[.!?;]|$)/iu
  },
  {
    kind: "goal",
    confidence: "high",
    expression: /\b(?:objetivo|meta|prop[oó]sito)\s+(?:de\s+[^,:;.!?]{1,100}\s+)?(?:es|consiste\s+en|:)?\s+(.+?)(?=[.!?;]|$)/iu
  },
  {
    kind: "goal",
    confidence: "medium",
    expression: /\b(?:quiere|desea|pretende|intenta|busca)\s+(.+?)(?=[.!?;]|$)/iu
  },
  {
    kind: "motivation",
    confidence: "high",
    expression: /\b(?:su\s+)?(?:motivaci[oó]n|raz[oó]n)\s+(?:principal\s+)?(?:es|consiste\s+en|:)?\s+(.+?)(?=[.!?;]|$)/iu
  },
  {
    kind: "motivation",
    confidence: "medium",
    expression: /\b(?:lo\s+hace|act[uú]a|decide\s+hacerlo)\s+porque\s+(.+?)(?=[.!?;]|$)/iu
  },
  {
    kind: "dilemma",
    confidence: "high",
    expression: /\b(?:debe\s+elegir|tiene\s+que\s+elegir|se\s+debate)\s+entre\s+(.+?)(?=[.!?;]|$)/iu
  },
  {
    kind: "question",
    confidence: "high",
    expression: /\bqu[eé]\s+pasar[ií]a\s+si\s+(.+?)(?=[?]|$)/iu
  },
  {
    kind: "hypothesis",
    confidence: "medium",
    expression: /\b(?:quiz[aá]|tal\s+vez|puede\s+que|es\s+posible\s+que)\s+(.+?)(?=[.!?;]|$)/iu
  },
  {
    kind: "motif",
    confidence: "high",
    expression: /\b(?:motivo\s+recurrente|s[ií]mbolo\s+recurrente)\s*(?:es|:)?\s+(.+?)(?=[.!?;]|$)/iu
  }
];

function validateInput(input: NarrativeIdeaDiscoveryInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" ||
      input.text.length > MAX_NARRATIVE_IDEA_DISCOVERY_TEXT_UNITS ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para descubrir ideas narrativas.");
  }
}

function splitIntoEvidenceSegments(text: string): readonly { start: number; end: number }[] {
  const segments: { start: number; end: number }[] = [];
  const boundary = /[^\n]+/gu;
  for (const line of text.matchAll(boundary)) {
    const lineStart = line.index;
    const lineText = line[0];
    const sentenceBoundary = /[^.!?]+(?:[.!?]+|$)/gu;
    for (const sentence of lineText.matchAll(sentenceBoundary)) {
      const raw = sentence[0];
      const leading = raw.search(/\S/u);
      if (leading < 0) continue;
      const trailing = raw.trimEnd().length;
      if (trailing <= leading) continue;
      segments.push({
        start: lineStart + sentence.index + leading,
        end: lineStart + sentence.index + trailing
      });
    }
  }
  return segments;
}

/**
 * Encuentra expresiones de idea reconocibles en el texto original.
 * El resultado es estable para el mismo documento, revisión y contenido.
 */
export function discoverNarrativeIdeaCandidates(
  input: NarrativeIdeaDiscoveryInput
): readonly NarrativeIdeaCandidate[] {
  validateInput(input);
  const baseOffset = input.baseOffset ?? 0;
  const candidates = new Map<string, NarrativeIdeaCandidate>();

  for (const segment of splitIntoEvidenceSegments(input.text)) {
    const excerpt = input.text.slice(segment.start, segment.end);
    for (const pattern of DISCOVERY_PATTERNS) {
      pattern.expression.lastIndex = 0;
      const match = pattern.expression.exec(excerpt);
      const captured = match?.[1];
      if (!match || !captured) continue;

      const value = captured.trim().replace(/\s+/gu, " ");
      if (!value || value.length > MAX_NARRATIVE_IDEA_CANDIDATE_TEXT_UNITS) continue;

      const prefix = excerpt.slice(0, match.index + match[0].indexOf(captured));
      const polarity: NarrativeIdeaCandidatePolarity =
        /\b(?:no|nunca|jam[aá]s|tampoco)\s*$/iu.test(prefix) ? "negated" :
        /\b(?:si|cuando|en\s+caso\s+de)\s*$/iu.test(prefix) ? "conditional" :
        pattern.kind === "hypothesis" || pattern.kind === "question" ? "hypothetical" : "affirmed";
      const captureOffset = match.index + match[0].lastIndexOf(captured);
      const leadingTrim = captured.search(/\S/u);
      const trailingTrim = captured.trimEnd().length;
      const start = baseOffset + segment.start + captureOffset + leadingTrim;
      const end = baseOffset + segment.start + captureOffset + trailingTrim;
      const id = `idea-candidate:${input.documentId}:${start}:${pattern.kind}`;
      candidates.set(id, {
        id,
        projectId: input.projectId,
        documentId: input.documentId,
        revision: input.revision,
        kind: pattern.kind,
        text: value,
        confidence: pattern.confidence,
        polarity,
        reviewStatus: "candidate",
        evidence: { start, end, excerpt }
      });
    }
  }

  return [...candidates.values()]
    .sort((a, b) => a.evidence.start - b.evidence.start ||
      a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    .slice(0, MAX_NARRATIVE_IDEA_DISCOVERY_CANDIDATES);
}
