/**
 * Detecta declaraciones explícitas de olvido y recuperación/evocación de memoria.
 *
 * No deduce olvido por ausencia de menciones, paso del tiempo o contradicciones.
 * Cada resultado es una señal textual atribuida a un personaje, no una prueba
 * clínica ni una garantía de que el recuerdo sea verdadero.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

export type NarrativeMemoryEventKind = "forgetting" | "remembering" | "memory-recovery";

export interface NarrativeMemoryEvent {
  readonly id: string;
  readonly projectId: string;
  readonly characterEntityId: string;
  readonly kind: NarrativeMemoryEventKind;
  readonly content: string;
  readonly evidence: TextEvidence;
  readonly reviewStatus: "candidate";
}

export interface NarrativeMemoryEventsInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
}

export const MAX_NARRATIVE_MEMORY_EVENTS = 200;
const MAX_TEXT_UNITS = 2_000_000;
const MAX_CONTENT_UNITS = 1_000;

const SIGNALS: readonly {
  readonly pattern: string;
  readonly kind: NarrativeMemoryEventKind;
}[] = [
  { pattern: "olvidó", kind: "forgetting" },
  { pattern: "olvido", kind: "forgetting" },
  { pattern: "olvidaba", kind: "forgetting" },
  { pattern: "había olvidado", kind: "forgetting" },
  { pattern: "dejó de recordar", kind: "forgetting" },
  { pattern: "recordó", kind: "remembering" },
  { pattern: "recordo", kind: "remembering" },
  { pattern: "recordaba", kind: "remembering" },
  { pattern: "rememoró", kind: "remembering" },
  { pattern: "rememoro", kind: "remembering" },
  { pattern: "recuperó el recuerdo de", kind: "memory-recovery" },
  { pattern: "recupero el recuerdo de", kind: "memory-recovery" },
  { pattern: "recuperó la memoria de", kind: "memory-recovery" },
  { pattern: "recupero la memoria de", kind: "memory-recovery" }
];

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\\s+/gu, " ").toLocaleLowerCase("es");
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
}
function validate(input: NarrativeMemoryEventsInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_TEXT_UNITS ||
      !Array.isArray(input.entities) ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para detectar eventos de memoria narrativa.");
  }
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        !Array.isArray(entity.aliases) ||
        entity.aliases.some(alias => typeof alias !== "string" || !alias.trim())) {
      throw new Error("Las entidades deben ser válidas y pertenecer al proyecto.");
    }
  }
}
function evidence(input: NarrativeMemoryEventsInput, start: number, end: number, excerpt: string): TextEvidence {
  return {
    documentId: input.documentId,
    revision: input.revision,
    start: (input.baseOffset ?? 0) + start,
    end: (input.baseOffset ?? 0) + end,
    excerpt
  };
}

/** Extrae únicamente verbos de memoria explícitos asociados a un personaje nombrado. */
export function extractNarrativeMemoryEvents(
  input: NarrativeMemoryEventsInput
): readonly NarrativeMemoryEvent[] {
  validate(input);
  const owners = new Map<string, NarrativeEntity | null>();
  for (const entity of input.entities.filter(item => item.kind === "character")) {
    for (const name of [entity.canonicalName, ...entity.aliases]) {
      const key = normalize(name);
      const current = owners.get(key);
      owners.set(key, current === undefined || current?.id === entity.id ? entity : null);
    }
  }
  const names = [...owners.entries()]
    .filter((entry): entry is [string, NarrativeEntity] => entry[1] !== null)
    .map(([key, entity]) => ({
      entity,
      name: [entity.canonicalName, ...entity.aliases].find(value => normalize(value) === key)!
    }))
    .sort((a, b) => b.name.length - a.name.length);

  const found = new Map<string, NarrativeMemoryEvent>();
  for (const lineMatch of input.text.matchAll(/[^\\n]+/gu)) {
    if (found.size >= MAX_NARRATIVE_MEMORY_EVENTS) break;
    const line = lineMatch[0];
    const lineStart = lineMatch.index ?? 0;
    for (const { entity, name } of names) {
      for (const signal of SIGNALS) {
        if (found.size >= MAX_NARRATIVE_MEMORY_EVENTS) break;
        const expression = new RegExp(
          String.raw`(?<![\\p{L}\\p{M}\\p{N}_])(${escapeRegExp(name)})(?![\\p{L}\\p{M}\\p{N}_])\\s+(?<!no )(?<!nunca )${escapeRegExp(signal.pattern)}\\s+(?:que\\s+)?(.+?)(?=[.!?;]|$)`,
          "giu"
        );
        for (const match of line.matchAll(expression)) {
          const captured = (match[2] ?? "").trim();
          if (!captured || captured.length > MAX_CONTENT_UNITS) continue;
          const start = lineStart + (match.index ?? 0);
          const end = start + match[0].length;
          const id = `memory:${entity.id}:${input.documentId}:${input.revision}:${(input.baseOffset ?? 0) + start}:${signal.kind}`;
          if (!found.has(id)) {
            found.set(id, {
              id,
              projectId: input.projectId,
              characterEntityId: entity.id,
              kind: signal.kind,
              content: captured,
              evidence: evidence(input, start, end, match[0]),
              reviewStatus: "candidate"
            });
          }
        }
      }
    }
  }
  return [...found.values()].sort((a, b) =>
    a.evidence.start - b.evidence.start || a.id.localeCompare(b.id)
  );
}
