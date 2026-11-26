import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";
import type { NarrativeObservationCandidate } from "./narrative-observation-discovery";

/**
 * Recupera hipótesis conservadoras de continuidad de sujeto omitido.
 * Solo enlaza acciones adyacentes cuando la anterior tiene sujeto gramatical
 * explícito y no hay otra mención de personaje entre ambas.
 */
export interface NarrativeEllipticalSubjectCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly observationId: string;
  readonly candidateEntityId: string;
  readonly antecedentSubjectEvidence: TextEvidence;
  readonly currentActionEvidence: TextEvidence;
  readonly previousActionEvidence: TextEvidence;
  readonly distance: number;
  readonly basis: "adjacent-explicit-subject-without-intervening-character-mention";
  readonly status: "candidate";
  readonly reviewStatus: "candidate";
}

export interface NarrativeEllipticalSubjectDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly observations: readonly NarrativeObservationCandidate[];
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
  readonly maxDistance?: number;
}

export const DEFAULT_NARRATIVE_ELLIPTICAL_SUBJECT_DISTANCE = 300;
export const MAX_NARRATIVE_ELLIPTICAL_SUBJECT_DISTANCE = 2_000;
export const MAX_NARRATIVE_ELLIPTICAL_SUBJECT_CANDIDATES = 2_000;
export const MAX_NARRATIVE_ELLIPTICAL_SUBJECT_TEXT_UNITS = 2_000_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsCharacterMention(text: string, entities: readonly NarrativeEntity[]): boolean {
  for (const entity of entities) {
    if (entity.kind !== "character") continue;
    for (const name of [entity.canonicalName, ...entity.aliases]) {
      if (!name.trim()) continue;
      const expression = new RegExp(
        "(?<![\p{L}\p{M}\p{N}_])" + escapeRegExp(name) +
        "(?![\p{L}\p{M}\p{N}_])",
        "iu"
      );
      if (expression.test(text)) return true;
    }
  }
  return false;
}

function validate(input: NarrativeEllipticalSubjectDiscoveryInput): void {
  const maxDistance = input?.maxDistance ?? DEFAULT_NARRATIVE_ELLIPTICAL_SUBJECT_DISTANCE;
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_NARRATIVE_ELLIPTICAL_SUBJECT_TEXT_UNITS ||
      !Array.isArray(input.observations) || !Array.isArray(input.entities) ||
      !Number.isSafeInteger(maxDistance) || maxDistance < 1 ||
      maxDistance > MAX_NARRATIVE_ELLIPTICAL_SUBJECT_DISTANCE ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para recuperar sujetos omitidos.");
  }
  const ids = new Set<string>();
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() || ids.has(entity.id) ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        !Array.isArray(entity.aliases)) {
      throw new Error("Las entidades deben ser únicas, válidas y pertenecer al mismo proyecto.");
    }
    ids.add(entity.id);
  }
  for (const observation of input.observations) {
    if (!observation || observation.projectId !== input.projectId ||
        observation.documentId !== input.documentId || observation.revision !== input.revision ||
        observation.kind !== "action" ||
        !observation.evidence || !observation.actionEvidence ||
        !Array.isArray(observation.mentionedCharacterIds) ||
        !Number.isSafeInteger(observation.evidence.start) ||
        !Number.isSafeInteger(observation.evidence.end) ||
        observation.evidence.start < (input.baseOffset ?? 0) ||
        observation.evidence.end > (input.baseOffset ?? 0) + input.text.length ||
        observation.evidence.end <= observation.evidence.start ||
        (observation.grammaticalSubjectCandidate !== undefined &&
          (!observation.grammaticalSubjectCandidate.entityId ||
            !observation.grammaticalSubjectCandidate.evidence ||
            observation.grammaticalSubjectCandidate.evidence.documentId !== input.documentId ||
            observation.grammaticalSubjectCandidate.evidence.revision !== input.revision))) {
      throw new Error("Las observaciones deben pertenecer al mismo documento, revisión y rango textual.");
    }
  }
}

function localOffset(absolute: number, base: number): number {
  return absolute - base;
}

/**
 * Devuelve únicamente candidatos sin confirmar. No propaga sujetos de una
 * hipótesis previa: la acción antecedente debe contener sujeto explícito.
 */
export function discoverNarrativeEllipticalSubjects(
  input: NarrativeEllipticalSubjectDiscoveryInput
): readonly NarrativeEllipticalSubjectCandidate[] {
  validate(input);
  const base = input.baseOffset ?? 0;
  const maxDistance = input.maxDistance ?? DEFAULT_NARRATIVE_ELLIPTICAL_SUBJECT_DISTANCE;
  const characters = input.entities.filter(entity => entity.kind === "character");
  const ordered = [...input.observations].sort((a, b) =>
    a.evidence.start - b.evidence.start || a.evidence.end - b.evidence.end
  );
  const candidates: NarrativeEllipticalSubjectCandidate[] = [];

  for (let index = 1; index < ordered.length && candidates.length < MAX_NARRATIVE_ELLIPTICAL_SUBJECT_CANDIDATES; index++) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    const subject = previous.grammaticalSubjectCandidate;
    if (!subject || subject.voice !== "active" ||
        current.grammaticalSubjectCandidate ||
        current.mentionedCharacterIds.length !== 0) continue;

    const distance = current.evidence.start - previous.evidence.end;
    if (distance < 0 || distance > maxDistance) continue;

    const previousEnd = localOffset(previous.evidence.end, base);
    const currentStart = localOffset(current.evidence.start, base);
    const gap = input.text.slice(previousEnd, currentStart);
    if (gap.includes("\n\n") || containsCharacterMention(gap, characters)) continue;

    const subjectEntity = characters.find(entity => entity.id === subject.entityId);
    if (!subjectEntity) continue;

    candidates.push({
      id: "elliptical-subject:" + input.documentId + ":" + input.revision + ":" +
        current.evidence.start + ":" + subject.entityId,
      projectId: input.projectId,
      documentId: input.documentId,
      revision: input.revision,
      observationId: current.id,
      candidateEntityId: subject.entityId,
      antecedentSubjectEvidence: subject.evidence,
      currentActionEvidence: current.actionEvidence,
      previousActionEvidence: previous.actionEvidence,
      distance,
      basis: "adjacent-explicit-subject-without-intervening-character-mention",
      status: "candidate",
      reviewStatus: "candidate"
    });
  }
  return candidates;
}
