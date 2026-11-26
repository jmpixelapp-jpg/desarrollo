import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

/**
 * Referencias personales de tercera persona en posición inicial de oración.
 * Los candidatos se ordenan por recencia textual; no se fusionan identidades.
 */
export type NarrativePronounReferenceStatus =
  | "single-candidate"
  | "ambiguous"
  | "no-antecedent";

export interface NarrativePronounAntecedentCandidate {
  readonly entityId: string;
  readonly entityKind: NarrativeEntity["kind"];
  readonly antecedentEvidence: TextEvidence;
  readonly distance: number;
}

export interface NarrativePronounReferenceCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly pronoun: string;
  readonly pronounEvidence: TextEvidence;
  readonly antecedentCandidates: readonly NarrativePronounAntecedentCandidate[];
  readonly status: NarrativePronounReferenceStatus;
  readonly reviewStatus: "candidate";
  readonly searchWindowStart: number;
  readonly searchWindowEnd: number;
}

export interface NarrativePronounReferenceDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
  readonly maxAntecedentDistance?: number;
}

export const DEFAULT_NARRATIVE_PRONOUN_WINDOW = 5_000;
export const MAX_NARRATIVE_PRONOUN_WINDOW = 50_000;
export const MAX_NARRATIVE_PRONOUN_REFERENCES = 2_000;
export const MAX_NARRATIVE_PRONOUN_ANTECEDENTS = 20;

const INITIAL_PERSONAL_PRONOUN =
  /^\s*(él|ella|ellos|ellas|usted|ustedes)\b/iu;

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function findLastNameMention(
  text: string,
  names: readonly string[],
  from: number,
  to: number
): { start: number; end: number; excerpt: string } | undefined {
  const window = text.slice(from, to);
  let best: { start: number; end: number; excerpt: string } | undefined;
  for (const name of names) {
    if (!name.trim()) continue;
    const expression = new RegExp(
      "(?<![\\p{L}\\p{M}\\p{N}_])" + escapeRegExp(name) +
      "(?![\\p{L}\\p{M}\\p{N}_])",
      "giu"
    );
    for (const match of window.matchAll(expression)) {
      const candidate = {
        start: from + match.index!,
        end: from + match.index! + match[0].length,
        excerpt: match[0]
      };
      if (!best || candidate.end > best.end ||
          (candidate.end === best.end && candidate.start > best.start)) best = candidate;
    }
  }
  return best;
}

function sentenceSpans(text: string): readonly { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const expression = /[^.!?\n]+(?:[.!?]+|$)/gu;
  for (const match of text.matchAll(expression)) {
    const raw = match[0];
    const leading = raw.search(/\S/u);
    const trailing = raw.trimEnd().length;
    if (leading < 0 || trailing <= leading) continue;
    spans.push({
      start: match.index! + leading,
      end: match.index! + trailing
    });
  }
  return spans;
}

function validate(input: NarrativePronounReferenceDiscoveryInput): void {
  const window = input?.maxAntecedentDistance ?? DEFAULT_NARRATIVE_PRONOUN_WINDOW;
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" ||
      !Array.isArray(input.entities) ||
      !Number.isSafeInteger(window) || window < 1 ||
      window > MAX_NARRATIVE_PRONOUN_WINDOW ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para descubrir referencias pronominales.");
  }
  const ids = new Set<string>();
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() ||
        ids.has(entity.id) || typeof entity.canonicalName !== "string" ||
        !entity.canonicalName.trim() || !Array.isArray(entity.aliases)) {
      throw new Error("Las entidades deben ser únicas, válidas y pertenecer al mismo proyecto.");
    }
    ids.add(entity.id);
  }
}

/**
 * Recupera posibles antecedentes nombrados antes de pronombres iniciales.
 * La cercanía ordena candidatos, pero no decide concordancia ni correferencia.
 */
export function discoverNarrativePronounReferences(
  input: NarrativePronounReferenceDiscoveryInput
): readonly NarrativePronounReferenceCandidate[] {
  validate(input);
  const base = input.baseOffset ?? 0;
  const maxDistance = input.maxAntecedentDistance ?? DEFAULT_NARRATIVE_PRONOUN_WINDOW;
  const spans = sentenceSpans(input.text);
  const results: NarrativePronounReferenceCandidate[] = [];

  for (const span of spans) {
    if (results.length >= MAX_NARRATIVE_PRONOUN_REFERENCES) break;
    const sentence = input.text.slice(span.start, span.end);
    const match = INITIAL_PERSONAL_PRONOUN.exec(sentence);
    if (!match) continue;

    const pronounStart = span.start + sentence.indexOf(match[1]!);
    const pronounEnd = pronounStart + match[1]!.length;
    const windowStart = Math.max(0, pronounStart - maxDistance);
    const latestByEntity = new Map<string, NarrativePronounAntecedentCandidate>();

    for (const entity of input.entities) {
      const mention = findLastNameMention(
        input.text,
        [entity.canonicalName, ...entity.aliases],
        windowStart,
        pronounStart
      );
      if (!mention) continue;
      latestByEntity.set(entity.id, {
        entityId: entity.id,
        entityKind: entity.kind,
        antecedentEvidence: {
          documentId: input.documentId,
          revision: input.revision,
          start: base + mention.start,
          end: base + mention.end,
          excerpt: mention.excerpt
        },
        distance: pronounStart - mention.end
      });
    }

    const candidates = [...latestByEntity.values()]
      .sort((a, b) => a.distance - b.distance ||
        a.entityId.localeCompare(b.entityId))
      .slice(0, MAX_NARRATIVE_PRONOUN_ANTECEDENTS);
    const status: NarrativePronounReferenceStatus =
      candidates.length === 0 ? "no-antecedent" :
      candidates.length === 1 ? "single-candidate" : "ambiguous";

    results.push({
      id: "pronoun-reference:" + input.documentId + ":" + input.revision + ":" +
        (base + pronounStart),
      projectId: input.projectId,
      documentId: input.documentId,
      revision: input.revision,
      pronoun: match[1]!,
      pronounEvidence: {
        documentId: input.documentId,
        revision: input.revision,
        start: base + pronounStart,
        end: base + pronounEnd,
        excerpt: match[1]!
      },
      antecedentCandidates: candidates,
      status,
      reviewStatus: "candidate",
      searchWindowStart: base + windowStart,
      searchWindowEnd: base + pronounStart
    });
  }
  return results;
}
