/**
 * Agrupa acciones explícitas en candidatos de acontecimiento por oración.
 * La proximidad textual organiza evidencia; no demuestra causalidad ni cronología.
 */
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
    events.push({
      id: "event:" + input.documentId + ":" + input.revision + ":" + start,
      projectId: input.projectId,
      label: input.text.slice(localStart, localEnd),
      participantEntityIds,
      actionCandidateIds: group.map(action => action.id),
      reviewStatus: "candidate",
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
