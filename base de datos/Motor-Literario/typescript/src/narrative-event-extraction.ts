/**
 * Agrupa acciones explícitas en candidatos de acontecimiento por oración.
 * La proximidad textual organiza evidencia; no demuestra causalidad ni cronología.
 */
import type { NarrativeTimeReference } from "./narrative-knowledge";
import type { NarrativeActionCandidate, NarrativeActionExtractionInput } from "./narrative-action-extraction";
import { extractNarrativeActionCandidates } from "./narrative-action-extraction";

export const MAX_NARRATIVE_EVENTS = 200;

export interface NarrativeEventCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly label: string;
  readonly participantEntityIds: readonly string[];
  readonly actionCandidateIds: readonly string[];
  readonly reviewStatus: "candidate";
  readonly evidence: {
    readonly documentId: string;
    readonly revision: number;
    /** Rangos UTF-16 absolutos dentro del documento. */
    readonly start: number;
    readonly end: number;
    readonly excerpt: string;
  };
  /** Solo se completa cuando hay una referencia temporal inequívoca en la oración. */
  readonly timeReference?: NarrativeTimeReference;
}

function sentenceBounds(text: string, offset: number): { start: number; end: number } {
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(/[.!?…]+(?:["»”’')\]]*)?(?:\s+|$)/gu)) {
    const boundary = (match.index ?? 0) + match[0].length;
    if (boundary <= offset) start = boundary;
    else {
      end = (match.index ?? 0) + match[0].length - (match[0].match(/\s+$/u)?.[0].length ?? 0);
      break;
    }
  }
  while (start < end && /\s/u.test(text[start] ?? "")) start++;
  while (end > start && /\s/u.test(text[end - 1] ?? "")) end--;
  return { start, end };
}


function validCalendarDay(year: number, month: number, day: number): number | undefined {
  if (year < 1000 || year > 2999 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return Math.floor(date.getTime() / 86_400_000);
}

/**
 * Reconoce únicamente fechas inequívocas (AAAA-MM-DD, DD/MM/AAAA),
 * años aislados y contadores explícitos "día N". Si hay más de una
 * referencia temporal distinta en la oración, no elige arbitrariamente.
 */
function extractTimeReference(sentence: string): NarrativeTimeReference | undefined {
  const found: NarrativeTimeReference[] = [];
  const occupied: Array<[number, number]> = [];
  const datePatterns = [
    { regex: /(?<![\p{L}\p{N}])((\d{4})-(\d{2})-(\d{2}))(?![\p{L}\p{N}])/gu, iso: true },
    { regex: /(?<![\p{L}\p{N}])((\d{2})\/(\d{2})\/(\d{4}))(?![\p{L}\p{N}])/gu, iso: false }
  ];
  for (const pattern of datePatterns) {
    for (const match of sentence.matchAll(pattern.regex)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (occupied.some(([a, b]) => start < b && end > a)) continue;
      occupied.push([start, end]);
      const year = Number(pattern.iso ? match[2] : match[4]);
      const month = Number(match[3]);
      const day = Number(pattern.iso ? match[4] : match[2]);
      const orderValue = validCalendarDay(year, month, day);
      if (orderValue === undefined) continue;
      found.push({ basis: "calendar", precision: "date", raw: match[0], orderValue });
    }
  }
  const months = new Map([
    ["enero", 1], ["febrero", 2], ["marzo", 3], ["abril", 4],
    ["mayo", 5], ["junio", 6], ["julio", 7], ["agosto", 8],
    ["septiembre", 9], ["setiembre", 9], ["octubre", 10],
    ["noviembre", 11], ["diciembre", 12]
  ]);
  const monthPattern = [...months.keys()].join("|");
  const writtenDate = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(\d{1,2})\s+de\s+(${monthPattern})\s+de\s+(\d{4})(?![\p{L}\p{N}])`,
    "giu"
  );
  for (const match of sentence.matchAll(writtenDate)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (occupied.some(([a, b]) => start < b && end > a)) continue;
    occupied.push([start, end]);
    const day = Number(match[1]);
    const month = months.get((match[2] ?? "").toLocaleLowerCase("es")) ?? 0;
    const year = Number(match[3]);
    const orderValue = validCalendarDay(year, month, day);
    if (orderValue === undefined) continue;
    found.push({ basis: "calendar", precision: "date", raw: match[0], orderValue });
  }

  for (const match of sentence.matchAll(/(?<![\p{L}\p{N}])(?:día|dia)\s+(?:n(?:ú|u)mero\s+)?(\d{1,9})(?![\p{L}\p{N}])/giu)) {
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value < 1) continue;
    found.push({ basis: "story-day", precision: "day-index", raw: match[0], orderValue: value });
  }
  for (const match of sentence.matchAll(/(?<![\p{L}\p{N}])((?:1[0-9]{3}|2[0-9]{3}))(?![\p{L}\p{N}])/gu)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (occupied.some(([a, b]) => start >= a && end <= b)) continue;
    const year = Number(match[1]);
    found.push({
      basis: "calendar", precision: "year", raw: match[0],
      orderValue: Math.floor(Date.UTC(year, 0, 1) / 86_400_000)
    });
  }
  const unique = new Map(found.map(item => [
    JSON.stringify([item.basis, item.precision, item.raw, item.orderValue]), item
  ]));
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

/** Construye eventos candidatos agrupando acciones que aparecen en la misma oración. */
export function extractNarrativeEventCandidates(
  input: NarrativeActionExtractionInput
): readonly NarrativeEventCandidate[] {
  const actions: readonly NarrativeActionCandidate[] = extractNarrativeActionCandidates(input);
  const groups = new Map<string, NarrativeActionCandidate[]>();
  for (const action of actions) {
    const localOffset = action.evidence.start - (input.baseOffset ?? 0);
    const bounds = sentenceBounds(input.text, localOffset);
    const key = bounds.start + ":" + bounds.end;
    const group = groups.get(key) ?? [];
    group.push(action);
    groups.set(key, group);
  }

  const events: NarrativeEventCandidate[] = [];
  for (const [key, group] of groups) {
    if (events.length >= MAX_NARRATIVE_EVENTS) break;
    const separator = key.indexOf(":");
    const localStart = Number(key.slice(0, separator));
    const localEnd = Number(key.slice(separator + 1));
    const participantEntityIds = [...new Set(group.flatMap(action =>
      [action.actorEntityId, action.targetEntityId]
    ))].sort();
    const start = (input.baseOffset ?? 0) + localStart;
    const end = (input.baseOffset ?? 0) + localEnd;
    const timeReference = extractTimeReference(input.text.slice(localStart, localEnd));
    events.push({
      id: "event:" + input.documentId + ":" + input.revision + ":" + start,
      projectId: input.projectId,
      label: input.text.slice(localStart, localEnd),
      participantEntityIds,
      actionCandidateIds: group.map(action => action.id),
      reviewStatus: "candidate",
      ...(timeReference ? { timeReference } : {}),
      evidence: {
        documentId: input.documentId,
        revision: input.revision,
        start,
        end,
        excerpt: input.text.slice(localStart, localEnd)
      }
    });
  }
  return events.sort((a, b) => a.evidence.start - b.evidence.start);
}
