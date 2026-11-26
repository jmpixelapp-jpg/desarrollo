/**
 * Evolución observable de interacciones entre personajes.
 *
 * Resume acciones explícitas entre dos personajes como señales de interacción.
 * No declara amistad, amor, enemistad ni cambios psicológicos: conserva dirección,
 * verbo, polaridad, evidencia y orden textual para revisión del escritor.
 */
import type { NarrativeEntity } from "./narrative-knowledge";
import type { NarrativeActionCandidate } from "./narrative-action-extraction";

export const MAX_RELATIONSHIP_INTERACTIONS = 500;

export type NarrativeInteractionValence = "supportive" | "hostile" | "neutral-or-unknown";

export interface NarrativeCharacterInteraction {
  readonly id: string;
  readonly projectId: string;
  readonly actorEntityId: string;
  readonly targetEntityId: string;
  readonly action: string;
  /** Valencia léxica tentativa, no estado emocional ni relación confirmada. */
  readonly valence: NarrativeInteractionValence;
  readonly polarity: "affirmed" | "negated";
  readonly effectiveSignal: NarrativeInteractionValence;
  readonly reviewStatus: "candidate";
  readonly evidence: NarrativeActionCandidate["evidence"];
}

export interface NarrativeInteractionShiftCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly firstInteractionId: string;
  readonly secondInteractionId: string;
  readonly fromValence: NarrativeInteractionValence;
  readonly toValence: NarrativeInteractionValence;
  readonly relationType: "explicit-interaction-valence-shift";
  readonly reviewStatus: "candidate";
  readonly evidence: readonly NarrativeActionCandidate["evidence"][];
}

const SUPPORTIVE = new Set([
  "acompañó", "acompaña", "acompañaba", "protegió", "protege", "protegía",
  "rescató", "rescata", "rescataba", "ayudó", "ayuda", "ayudaba", "salvó", "salva", "salvaba"
]);
const HOSTILE = new Set([
  "traicionó", "traiciona", "traicionaba", "destruyó", "destruye", "destruía",
  "atacó", "ataca", "atacaba", "mató", "mata", "mataba"
]);

function invert(valence: NarrativeInteractionValence): NarrativeInteractionValence {
  if (valence === "supportive") return "hostile";
  if (valence === "hostile") return "supportive";
  return valence;
}

/** Extrae señales de interacción únicamente de acciones personaje → personaje. */
export function extractNarrativeCharacterInteractions(
  actions: readonly NarrativeActionCandidate[],
  entities: readonly NarrativeEntity[],
  projectId: string
): readonly NarrativeCharacterInteraction[] {
  if (!Array.isArray(actions) || !Array.isArray(entities) ||
      typeof projectId !== "string" || !projectId.trim()) {
    throw new Error("Entradas inválidas para analizar interacciones narrativas.");
  }
  const characters = new Set<string>();
  for (const entity of entities) {
    if (!entity || entity.projectId !== projectId ||
        typeof entity.id !== "string" || !entity.id ||
        typeof entity.kind !== "string") {
      throw new Error("Entidad inválida o perteneciente a otro proyecto.");
    }
    if (entity.kind === "character") characters.add(entity.id);
  }
  const results: NarrativeCharacterInteraction[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    if (!action || action.projectId !== projectId ||
        typeof action.actorEntityId !== "string" ||
        typeof action.targetEntityId !== "string" ||
        !["affirmed", "negated"].includes(action.polarity) ||
        action.reviewStatus !== "candidate" ||
        !action.evidence || typeof action.action !== "string" ||
        !Number.isSafeInteger(action.evidence.start) ||
        !Number.isSafeInteger(action.evidence.end) ||
        action.evidence.start < 0 || action.evidence.end <= action.evidence.start ||
        typeof action.evidence.documentId !== "string" ||
        !Number.isSafeInteger(action.evidence.revision)) {
      throw new Error("Acción inválida para analizar interacciones.");
    }
    if (!characters.has(action.actorEntityId) ||
        !characters.has(action.targetEntityId) ||
        action.actorEntityId === action.targetEntityId) continue;
    const key = action.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const normalizedAction = action.action.toLocaleLowerCase("es");
    const baseValence: NarrativeInteractionValence = SUPPORTIVE.has(normalizedAction)
      ? "supportive"
      : HOSTILE.has(normalizedAction) ? "hostile" : "neutral-or-unknown";
    results.push({
      id: "interaction:" + action.id,
      projectId,
      actorEntityId: action.actorEntityId,
      targetEntityId: action.targetEntityId,
      action: action.action,
      valence: baseValence,
      polarity: action.polarity,
      effectiveSignal: action.polarity === "negated" ? invert(baseValence) : baseValence,
      reviewStatus: "candidate",
      evidence: action.evidence
    });
    if (results.length >= MAX_RELATIONSHIP_INTERACTIONS) break;
  }
  return results.sort((a,b) =>
    a.evidence.documentId.localeCompare(b.evidence.documentId) ||
    a.evidence.revision-b.evidence.revision ||
    a.evidence.start-b.evidence.start || a.id.localeCompare(b.id)
  );
}

/**
 * Señala cambios de valencia entre interacciones dirigidas al mismo personaje
 * por el mismo actor, dentro del mismo documento y revisión. No combina
 * documentos ni interpreta el espacio entre acciones como causalidad.
 */
export function detectNarrativeInteractionShifts(
  interactions: readonly NarrativeCharacterInteraction[]
): readonly NarrativeInteractionShiftCandidate[] {
  if (!Array.isArray(interactions)) throw new Error("Interacciones inválidas.");
  const groups = new Map<string, NarrativeCharacterInteraction[]>();
  const ids = new Set<string>();
  for (const item of interactions) {
    if (!item || typeof item.id !== "string" || !item.id ||
        ids.has(item.id) || !item.evidence ||
        !["supportive", "hostile", "neutral-or-unknown"].includes(item.effectiveSignal) ||
        !Number.isSafeInteger(item.evidence.start) ||
        !Number.isSafeInteger(item.evidence.end) ||
        item.evidence.start < 0 || item.evidence.end <= item.evidence.start) {
      throw new Error("Interacción duplicada o inválida.");
    }
    ids.add(item.id);
    const key = [
      item.projectId, item.actorEntityId, item.targetEntityId,
      item.evidence.documentId, item.evidence.revision
    ].join(":");
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const results: NarrativeInteractionShiftCandidate[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((a,b) =>
      a.evidence.start-b.evidence.start || a.id.localeCompare(b.id)
    );
    for (let index=1; index<ordered.length && results.length<MAX_RELATIONSHIP_INTERACTIONS; index++) {
      const previous = ordered[index-1]!;
      const current = ordered[index]!;
      if (previous.effectiveSignal === current.effectiveSignal ||
          previous.effectiveSignal === "neutral-or-unknown" ||
          current.effectiveSignal === "neutral-or-unknown") continue;
      results.push({
        id: "interaction-shift:" + previous.id + ":" + current.id,
        projectId: current.projectId,
        firstInteractionId: previous.id,
        secondInteractionId: current.id,
        fromValence: previous.effectiveSignal,
        toValence: current.effectiveSignal,
        relationType: "explicit-interaction-valence-shift",
        reviewStatus: "candidate",
        evidence: [previous.evidence, current.evidence]
      });
    }
  }
  return results.sort((a,b) =>
    a.evidence[1]!.documentId.localeCompare(b.evidence[1]!.documentId) ||
    a.evidence[1]!.revision-b.evidence[1]!.revision ||
    a.evidence[1]!.start-b.evidence[1]!.start
  );
}
