/**
 * Relaciona recuerdos explícitos con acciones solo cuando la secuencia textual
 * ofrece una conexión verificable. La coexistencia no se presenta como causa.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";
import type { NarrativeActionCandidate } from "./narrative-action-extraction";
import type { NarrativeMemoryEvent } from "./narrative-memory-events";

export type NarrativeMemoryActionRelation =
  | "explicit-causal-link"
  | "temporal-cooccurrence"
  | "unresolved";

export interface NarrativeMemoryActionLink {
  readonly id: string;
  readonly projectId: string;
  readonly characterEntityId: string;
  readonly memoryEventIds: readonly string[];
  readonly actionId?: string;
  readonly relation: NarrativeMemoryActionRelation;
  readonly connectorEvidence?: TextEvidence;
  readonly memoryEvidence: readonly TextEvidence[];
  readonly actionEvidence?: TextEvidence;
  readonly reviewStatus: "candidate";
}

export interface NarrativeMemoryActionLinksInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly baseOffset?: number;
  readonly entities: readonly NarrativeEntity[];
  readonly memoryEvents: readonly NarrativeMemoryEvent[];
  readonly actions: readonly NarrativeActionCandidate[];
}

const MAX_RECORDS = 10_000;
const MAX_LINKS = 500;
const CAUSAL = /\b(?:por eso|por ello|por lo tanto|por consiguiente|debido a que|debido a|a causa de|por haber recordado|porque)\b/iu;
const TEMPORAL = /\b(?:después|despues|entonces|luego|más tarde|mas tarde|al recordar|tras recordar)\b/iu;

function validate(input: NarrativeMemoryActionLinksInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > 2_000_000 ||
      !Array.isArray(input.entities) || !Array.isArray(input.memoryEvents) ||
      !Array.isArray(input.actions) ||
      input.memoryEvents.length + input.actions.length > MAX_RECORDS ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
         input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para relacionar recuerdos y acciones narrativas.");
  }
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim()) {
      throw new Error("Las entidades deben pertenecer al proyecto y tener identificadores válidos.");
    }
  }
  const characterIds = new Set(input.entities.filter(item => item.kind === "character").map(item => item.id));
  for (const event of input.memoryEvents) {
    if (!event || event.projectId !== input.projectId ||
        !characterIds.has(event.characterEntityId) ||
        event.evidence?.documentId !== input.documentId ||
        event.evidence?.revision !== input.revision) {
      throw new Error("Los recuerdos deben pertenecer al proyecto, personaje, documento y revisión actuales.");
    }
  }
  for (const action of input.actions) {
    if (!action || action.projectId !== input.projectId ||
        !characterIds.has(action.actorEntityId) ||
        action.evidence?.documentId !== input.documentId ||
        action.evidence?.revision !== input.revision) {
      throw new Error("Las acciones deben pertenecer al proyecto, actor, documento y revisión actuales.");
    }
  }
}

function evidenceSlice(
  input: NarrativeMemoryActionLinksInput, start: number, end: number
): TextEvidence {
  const base = input.baseOffset ?? 0;
  return {
    documentId: input.documentId,
    revision: input.revision,
    start: base + start,
    end: base + end,
    excerpt: input.text.slice(start, end)
  };
}

/**
 * Solo considera recuerdos anteriores a la acción del mismo personaje y dentro
 * de una ventana textual acotada. Los conectores causales se conservan como
 * evidencia separada; "después/entonces" solo indica secuencia temporal.
 */
export function linkNarrativeMemoryToActions(
  input: NarrativeMemoryActionLinksInput
): readonly NarrativeMemoryActionLink[] {
  validate(input);
  const base = input.baseOffset ?? 0;
  const links: NarrativeMemoryActionLink[] = [];
  for (const action of input.actions) {
    if (action.polarity !== "affirmed") continue;
    const actionStart = action.evidence.start - base;
    const actionEnd = action.evidence.end - base;
    if (actionStart < 0 || actionEnd > input.text.length || actionEnd < actionStart) continue;

    const preceding = input.memoryEvents.filter(event =>
      event.characterEntityId === action.actorEntityId &&
      event.kind !== "forgetting" &&
      event.evidence.start >= base &&
      event.evidence.end <= base + actionStart &&
      actionStart - (event.evidence.end - base) <= 500
    );
    const local = preceding.filter(event => {
      const start = event.evidence.start - base;
      const between = input.text.slice(event.evidence.end - base, actionStart);
      const sameLine = !between.includes("\n");
      return sameLine || CAUSAL.test(between);
    });
    if (!local.length) continue;

    const latestStart = Math.max(...local.map(item => item.evidence.start));
    const nearest = local.filter(item => item.evidence.start === latestStart);
    const chosen = nearest.length === 1 ? nearest[0] : undefined;
    const between = chosen
      ? input.text.slice(chosen.evidence.end - base, actionStart)
      : "";
    const causalMatch = chosen ? CAUSAL.exec(between) : null;
    const temporalMatch = chosen ? TEMPORAL.exec(between) : null;
    const sameSentence = chosen !== undefined &&
      !/[.!?;\n]/u.test(between);
    const relation: NarrativeMemoryActionRelation = !chosen
      ? "unresolved"
      : causalMatch ? "explicit-causal-link"
      : temporalMatch || sameSentence ? "temporal-cooccurrence"
      : "unresolved";
    const memoryEvents = chosen ? [chosen] : nearest;
    const connectorMatch = causalMatch ?? temporalMatch;
    const connectorEvidence = chosen && connectorMatch
      ? evidenceSlice(
          input,
          chosen.evidence.end - base + (connectorMatch.index ?? 0),
          chosen.evidence.end - base + (connectorMatch.index ?? 0) + connectorMatch[0].length
        )
      : undefined;
    const id = "memory-action:" + action.id + ":" +
      memoryEvents.map(item => item.id).sort().join(",");
    links.push({
      id,
      projectId: input.projectId,
      characterEntityId: action.actorEntityId,
      memoryEventIds: memoryEvents.map(item => item.id),
      actionId: action.id,
      relation,
      ...(connectorEvidence ? { connectorEvidence } : {}),
      memoryEvidence: memoryEvents.map(item => item.evidence),
      actionEvidence: action.evidence,
      reviewStatus: "candidate"
    });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}
