import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

/**
 * Descubre segmentos de discurso directo y atribuciones explícitas de hablante.
 * La presencia de un personaje en la escena o en el turno anterior nunca basta
 * para atribuirle una intervención: se exige nombre + verbo de habla en la
 * etiqueta contigua al segmento.
 */
export type NarrativeDialogueSpeakerStatus = "explicit-single" | "ambiguous" | "unattributed";

export interface NarrativeDialogueSpeakerCandidate {
  readonly entityId: string;
  readonly entityKind: NarrativeEntity["kind"];
  readonly nameEvidence: TextEvidence;
  readonly speechVerbEvidence: TextEvidence;
}

export interface NarrativeDialogueSegmentCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly format: "guillemets" | "curly-quotes" | "straight-quotes" | "em-dash";
  readonly utteranceEvidence: TextEvidence;
  readonly segmentEvidence: TextEvidence;
  readonly attributionEvidence?: TextEvidence;
  readonly speakerCandidates: readonly NarrativeDialogueSpeakerCandidate[];
  readonly speakerStatus: NarrativeDialogueSpeakerStatus;
  readonly reviewStatus: "candidate";
}

export interface NarrativeDialogueSpeakerDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
  readonly maxAttributionDistance?: number;
}

export const DEFAULT_NARRATIVE_DIALOGUE_ATTRIBUTION_DISTANCE = 180;
export const MAX_NARRATIVE_DIALOGUE_ATTRIBUTION_DISTANCE = 1_000;
export const MAX_NARRATIVE_DIALOGUE_SEGMENTS = 5_000;
export const MAX_NARRATIVE_DIALOGUE_UTTERANCE_UNITS = 20_000;
export const MAX_NARRATIVE_DIALOGUE_TEXT_UNITS = 2_000_000;

const SPEECH_VERB = /(?<![\p{L}\p{M}\p{N}_])(?:dij(?:o|eron|e|iste|imos)|habl(?:ó|aba|aron|a|an)|declar(?:ó|aba|aron|a|an)|insisti(?:ó|ó|eron|e|en)|protest(?:ó|aba|aron|a|an)|suplic(?:ó|aba|aron|a|an)|implor(?:ó|aba|aron|a|an)|reproch(?:ó|aba|aron|a|an)|brome(?:ó|aba|aron|a|an)|interrump(?:ió|ía|ieron|e|en)|pid(?:ió|ieron|e|en)|rog(?:ó|aba|aron|a|an)|dec(?:ía|ían|ir)|pregunt(?:ó|aba|aron|a|an)|respond(?:ió|ía|ieron|e|en)|contest(?:ó|aba|aron|a|an)|exclam(?:ó|aba|aron|a|an)|grit(?:ó|aba|aron|a|an)|susurr(?:ó|aba|aron|a|an)|murmur(?:ó|aba|aron|a|an)|añad(?:ió|ía|ieron|e|en)|replic(?:ó|aba|aron|a|an)|anunci(?:ó|aba|aron|a|an)|afirm(?:ó|aba|aron|a|an)|orden(?:ó|aba|aron|a|an)|respond(?:ió|ía|ieron|e|en)|coment(?:ó|aba|aron|a|an)|explic(?:ó|aba|aron|a|an)|advirti(?:ó|ó|eron|e|en)|balbuce(?:ó|aba|aron|a|an)|confes(?:ó|aba|aron|a|an)|prometi(?:ó|ó|eron|e|en))(?![\p{L}\p{M}\p{N}_])/giu;

interface Span {
  readonly start: number;
  readonly end: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly format: NarrativeDialogueSegmentCandidate["format"];
  readonly utterance: string;
  readonly delimiter: string;
  readonly attributionStart?: number;
  readonly attributionEnd?: number;
}

function evidence(documentId: string, revision: number, base: number, start: number, end: number, excerpt: string): TextEvidence {
  return { documentId, revision, start: base + start, end: base + end, excerpt };
}

function validate(input: NarrativeDialogueSpeakerDiscoveryInput): void {
  const distance = input?.maxAttributionDistance ?? DEFAULT_NARRATIVE_DIALOGUE_ATTRIBUTION_DISTANCE;
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_NARRATIVE_DIALOGUE_TEXT_UNITS ||
      !Array.isArray(input.entities) ||
      !Number.isSafeInteger(distance) || distance < 1 ||
      distance > MAX_NARRATIVE_DIALOGUE_ATTRIBUTION_DISTANCE ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para descubrir hablantes de diálogo.");
  }
  const ids = new Set<string>();
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() || ids.has(entity.id) ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        !Array.isArray(entity.aliases)) {
      throw new Error("Las entidades de diálogo deben ser únicas, válidas y del mismo proyecto.");
    }
    ids.add(entity.id);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function nameMatches(text: string, entity: NarrativeEntity): readonly { start: number; end: number; excerpt: string }[] {
  const found: { start: number; end: number; excerpt: string }[] = [];
  for (const name of [entity.canonicalName, ...entity.aliases]) {
    if (typeof name !== "string" || !name.trim()) continue;
    const expression = new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])" + escapeRegExp(name) +
      "(?![\\p{L}\\p{M}\\p{N}_])", "giu");
    for (const match of text.matchAll(expression)) {
      found.push({ start: match.index!, end: match.index! + match[0].length, excerpt: match[0] });
    }
  }
  return found.sort((a, b) => a.start - b.start || b.end - a.end);
}

function quotedSpans(text: string, maxDistance: number): readonly Span[] {
  const spans: Span[] = [];
  const patterns: readonly { expression: RegExp; format: Span["format"]; open: string; close: string }[] = [
    { expression: /«([^»\n]{1,20000})»/gu, format: "guillemets", open: "«", close: "»" },
    { expression: /“([^”\n]{1,20000})”/gu, format: "curly-quotes", open: "“", close: "”" },
    { expression: /"([^"\n]{1,20000})"/gu, format: "straight-quotes", open: '"', close: '"' }
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.expression)) {
      const start = match.index!;
      const contentStart = start + pattern.open.length;
      const contentEnd = contentStart + match[1]!.length;
      const end = contentEnd + pattern.close.length;
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const lineEndIndex = text.indexOf("\n", end);
      const lineEnd = lineEndIndex < 0 ? text.length : lineEndIndex;
      const beforeStart = Math.max(lineStart, start - maxDistance);
      const afterEnd = Math.min(lineEnd, end + maxDistance);
      spans.push({
        start, end, contentStart, contentEnd, format: pattern.format,
        utterance: match[1]!, delimiter: pattern.open + pattern.close,
        attributionStart: beforeStart, attributionEnd: afterEnd
      });
    }
  }
  // A segment is emitted once. Overlapping quote styles are not merged because
  // they may represent nested quotations whose boundaries need manual review.
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
    .filter((span, index, all) => !all.slice(0, index).some(other =>
      span.start < other.end && other.start < span.end));
}

function emDashSpans(text: string, maxDistance: number): readonly Span[] {
  const spans: Span[] = [];
  const expression = /^([ \t]*)—([^\n]{1,20000}?)(?:[ \t]+—([ \t]*[^\n]{1,500}))?$/gmu;
  for (const match of text.matchAll(expression)) {
    const lineStart = match.index! + match[1]!.length;
    const body = match[2]!;
    const closingTag = match[3];
    const bodyStart = lineStart + 1;
    const closingDashOffset = closingTag ? match[0].lastIndexOf("—") : -1;
    const tagOffset = closingTag ? match.index! + closingDashOffset + 1 : -1;
    const utterance = body.trimEnd();
    const leadingTrim = body.length - body.trimStart().length;
    const contentStart = bodyStart + leadingTrim;
    const contentEnd = contentStart + utterance.length;
    const end = match.index! + match[0].length;
    spans.push({
      start: lineStart, end, contentStart, contentEnd, format: "em-dash",
      utterance, delimiter: "—",
      ...(closingTag ? { attributionStart: tagOffset, attributionEnd: end } :
        { attributionStart: Math.max(lineStart, contentEnd - maxDistance), attributionEnd: end })
    });
  }
  return spans;
}

/**
 * Atribuye solo si la etiqueta próxima contiene verbo de habla y una única
 * entidad conocida. Los casos sin etiqueta o con varias entidades quedan abiertos.
 */
export function discoverNarrativeDialogueSpeakers(
  input: NarrativeDialogueSpeakerDiscoveryInput
): readonly NarrativeDialogueSegmentCandidate[] {
  validate(input);
  const base = input.baseOffset ?? 0;
  const distance = input.maxAttributionDistance ?? DEFAULT_NARRATIVE_DIALOGUE_ATTRIBUTION_DISTANCE;
  const spans = [...quotedSpans(input.text, distance), ...emDashSpans(input.text, distance)]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .slice(0, MAX_NARRATIVE_DIALOGUE_SEGMENTS);
  return spans.map((span, index) => {
    const attributionStart = span.attributionStart ?? Math.max(0, span.start - distance);
    const attributionEnd = span.attributionEnd ?? Math.min(input.text.length, span.end + distance);
    const rawAttributionText = input.text.slice(attributionStart, attributionEnd);
    const attributionChars = rawAttributionText.split("");
    const maskedStart = Math.max(attributionStart, span.contentStart);
    const maskedEnd = Math.min(attributionEnd, span.contentEnd);
    for (let offset = maskedStart; offset < maskedEnd; offset++) {
      attributionChars[offset - attributionStart] = " ";
    }
    const attributionText = attributionChars.join("");
    const verbMatches = [...attributionText.matchAll(SPEECH_VERB)];
    const candidates = verbMatches.length === 0 ? [] : input.entities.filter(entity => entity.kind === "character").flatMap(entity => {
      const mentions = nameMatches(attributionText, entity);
      const mention = mentions.find(item => {
        const preceding = attributionText.slice(Math.max(0, item.start - 16), item.start);
        // A name governed by «a/para/hacia» is a likely addressee or complement,
        // not the grammatical subject of the speech verb.
        if (/(?:\\b(?:a|para|hacia)\\s+)$/iu.test(preceding)) return false;
        return verbMatches.some(verb =>
          Math.abs((attributionStart + item.start) - (attributionStart + verb.index!)) <= distance
        );
      });
      if (!mention) return [];
      const verb = verbMatches.sort((a, b) =>
        Math.abs((attributionStart + mention.start) - (attributionStart + a.index!)) -
        Math.abs((attributionStart + mention.start) - (attributionStart + b.index!))
      )[0]!;
      return [{
        entityId: entity.id,
        entityKind: entity.kind,
        nameEvidence: evidence(input.documentId, input.revision, base,
          attributionStart + mention.start, attributionStart + mention.end, mention.excerpt),
        speechVerbEvidence: evidence(input.documentId, input.revision, base,
          attributionStart + verb.index!, attributionStart + verb.index! + verb[0].length, verb[0])
      }];
    });
    const unique = [...new Map(candidates.map(candidate => [candidate.entityId, candidate])).values()];
    const attributionEvidence = verbMatches.length > 0
      ? evidence(input.documentId, input.revision, base, attributionStart, attributionEnd, rawAttributionText)
      : undefined;
    return {
      id: "dialogue-speaker:" + input.documentId + ":" + input.revision + ":" + (base + span.start) + ":" + index,
      projectId: input.projectId,
      documentId: input.documentId,
      revision: input.revision,
      format: span.format,
      utteranceEvidence: evidence(input.documentId, input.revision, base,
        span.contentStart, span.contentEnd, input.text.slice(span.contentStart, span.contentEnd)),
      segmentEvidence: evidence(input.documentId, input.revision, base,
        span.start, span.end, input.text.slice(span.start, span.end)),
      ...(attributionEvidence ? { attributionEvidence } : {}),
      speakerCandidates: unique,
      speakerStatus: unique.length === 0 ? "unattributed" : unique.length === 1 ? "explicit-single" : "ambiguous",
      reviewStatus: "candidate"
    };
  });
}
