/**
 * Reconstruye una línea temporal conservadora de recuerdos explícitos.
 * Los eventos nunca se borran: el estado es una proyección revisable del historial.
 */
import type { NarrativeEntity } from "./narrative-knowledge";
import type { NarrativeMemoryEvent } from "./narrative-memory-events";

export type NarrativeMemoryStatus =
  | "unrecorded"
  | "remembered"
  | "forgotten"
  | "memory-recovered"
  | "chronology-unresolved";

export interface NarrativeCharacterMemoryItem {
  readonly characterEntityId: string;
  readonly normalizedContent: string;
  readonly events: readonly NarrativeMemoryEvent[];
  readonly currentStatus: NarrativeMemoryStatus;
  readonly chronology: "same-document-position" | "explicit-document-order" | "cross-document-order-unknown";
}
export interface NarrativeCharacterMemoryState {
  readonly projectId: string;
  readonly characterEntityId: string;
  readonly memories: readonly NarrativeCharacterMemoryItem[];
  readonly eventCount: number;
  readonly reviewStatus: "candidate";
}
export interface NarrativeMemoryTimelineInput {
  readonly projectId: string;
  readonly entities: readonly NarrativeEntity[];
  readonly events: readonly NarrativeMemoryEvent[];
  readonly orderedDocumentIds?: readonly string[];
}
const MAX_EVENTS = 10_000;

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ")
    .toLocaleLowerCase("es").replace(/[.!?;:,]+$/gu, "");
}
function validEvent(event: NarrativeMemoryEvent): boolean {
  return !!event && typeof event.id === "string" && !!event.id.trim() &&
    typeof event.projectId === "string" &&
    ["forgetting", "remembering", "memory-recovery"].includes(event.kind) &&
    typeof event.content === "string" && !!event.content.trim() &&
    !!event.evidence && typeof event.evidence.documentId === "string" &&
    Number.isSafeInteger(event.evidence.revision) && event.evidence.revision >= 0 &&
    Number.isSafeInteger(event.evidence.start) && event.evidence.start >= 0 &&
    Number.isSafeInteger(event.evidence.end) && event.evidence.end >= event.evidence.start;
}
export function buildNarrativeMemoryTimeline(
  input: NarrativeMemoryTimelineInput
): readonly NarrativeCharacterMemoryState[] {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !Array.isArray(input.entities) || !Array.isArray(input.events) ||
      input.events.length > MAX_EVENTS ||
      (input.orderedDocumentIds !== undefined &&
        (!Array.isArray(input.orderedDocumentIds) ||
          input.orderedDocumentIds.some(id => typeof id !== "string" || !id.trim()) ||
          new Set(input.orderedDocumentIds).size !== input.orderedDocumentIds.length))) {
    throw new Error("Contexto inválido para reconstruir la memoria narrativa.");
  }
  const characters = input.entities.filter(entity =>
    entity && entity.projectId === input.projectId && entity.kind === "character" &&
    typeof entity.id === "string" && !!entity.id.trim()
  );
  if (input.entities.some(entity => !entity || entity.projectId !== input.projectId ||
      typeof entity.id !== "string" || !entity.id.trim())) {
    throw new Error("Las entidades deben pertenecer al proyecto y tener identificadores.");
  }
  const characterIds = new Set(characters.map(item => item.id));
  for (const event of input.events) {
    if (!validEvent(event) || event.projectId !== input.projectId ||
        !characterIds.has(event.characterEntityId)) {
      throw new Error("Los eventos de memoria deben pertenecer a personajes y proyecto válidos.");
    }
  }
  const order = new Map((input.orderedDocumentIds ?? []).map((id, index) => [id, index]));
  return characters.map(character => {
    const ownEvents = input.events.filter(event => event.characterEntityId === character.id);
    const groups = new Map<string, NarrativeMemoryEvent[]>();
    for (const event of ownEvents) {
      const key = normalize(event.content);
      const list = groups.get(key) ?? [];
      list.push(event);
      groups.set(key, list);
    }
    const memories = [...groups.entries()].map(([normalizedContent, records]) => {
      const docs = new Set(records.map(item => item.evidence.documentId));
      const revisions = new Map<string, Set<number>>();
      for (const event of records) {
        const set = revisions.get(event.evidence.documentId) ?? new Set<number>();
        set.add(event.evidence.revision);
        revisions.set(event.evidence.documentId, set);
      }
      const sameDocument = docs.size === 1 &&
        [...revisions.values()].every(set => set.size === 1);
      const explicitlyOrdered = [...docs].every(id => order.has(id)) &&
        [...revisions.values()].every(set => set.size === 1);
      const chronologyKnown = sameDocument || explicitlyOrdered;
      const ordered = [...records].sort((a, b) => {
        const ao = order.get(a.evidence.documentId);
        const bo = order.get(b.evidence.documentId);
        if (ao !== undefined && bo !== undefined && ao !== bo) return ao - bo;
        if (a.evidence.documentId === b.evidence.documentId &&
            a.evidence.revision === b.evidence.revision) return a.evidence.start - b.evidence.start;
        return a.id.localeCompare(b.id);
      });
      const latest = ordered[ordered.length - 1];
      const currentStatus: NarrativeMemoryStatus = !chronologyKnown
        ? "chronology-unresolved"
        : latest.kind === "forgetting" ? "forgotten"
        : latest.kind === "remembering" ? "remembered"
        : "memory-recovered";
      return {
        characterEntityId: character.id,
        normalizedContent,
        events: ordered,
        currentStatus,
        chronology: sameDocument ? "same-document-position" as const
          : explicitlyOrdered ? "explicit-document-order" as const
          : "cross-document-order-unknown" as const
      };
    }).sort((a, b) => a.normalizedContent.localeCompare(b.normalizedContent));
    return {
      projectId: input.projectId,
      characterEntityId: character.id,
      memories,
      eventCount: ownEvents.length,
      reviewStatus: "candidate" as const
    };
  });
}
