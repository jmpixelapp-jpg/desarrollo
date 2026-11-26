/**
 * Reconstruye transiciones propuestas entre afirmaciones explícitas de estado.
 *
 * Solo compara menciones del mismo personaje, estado, documento y revisión.
 * No deduce orden entre capítulos/documentos ni convierte candidatos en hechos.
 */
import type { NarrativeCharacterStateCandidate } from "./narrative-character-state-discovery";
import type { TextEvidence } from "./narrative-knowledge";

export type NarrativeCharacterStateTransitionKind =
  | "ceased"
  | "reappeared"
  | "reaffirmed"
  | "remained-negated"
  | "recurred";

export type NarrativeCharacterStateTransitionBasis =
  | "paired-assertions"
  | "explicit-aspect-marker";

export interface NarrativeCharacterStateTransitionCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly entityId: string;
  readonly state: NarrativeCharacterStateCandidate["state"];
  readonly epistemicFrame: NarrativeCharacterStateCandidate["epistemicFrame"];
  readonly epistemicSourceEntityId?: string;
  readonly transition: NarrativeCharacterStateTransitionKind;
  readonly basis: NarrativeCharacterStateTransitionBasis;
  readonly previousCandidateId?: string;
  readonly currentCandidateId: string;
  readonly previousEvidence?: TextEvidence;
  readonly currentEvidence: TextEvidence;
  readonly previousEpistemicEvidence?: TextEvidence;
  readonly currentEpistemicEvidence?: TextEvidence;
  readonly evidence: TextEvidence;
  readonly reviewStatus: "candidate";
}

export interface NarrativeCharacterStateTransitionDiscoveryInput {
  readonly projectId: string;
  readonly candidates: readonly NarrativeCharacterStateCandidate[];
}

export const MAX_NARRATIVE_CHARACTER_STATE_TRANSITIONS = 400;

function validEvidence(evidence: TextEvidence): boolean {
  return !!evidence &&
    typeof evidence.documentId === "string" &&
    Number.isSafeInteger(evidence.revision) && evidence.revision >= 0 &&
    Number.isSafeInteger(evidence.start) && evidence.start >= 0 &&
    Number.isSafeInteger(evidence.end) && evidence.end > evidence.start &&
    typeof evidence.excerpt === "string" &&
    evidence.excerpt.length > 0 &&
    evidence.end - evidence.start === evidence.excerpt.length &&
    evidence.status !== "stale";
}

function validate(input: NarrativeCharacterStateTransitionDiscoveryInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !Array.isArray(input.candidates)) {
    throw new Error("Contexto inválido para reconstruir transiciones de estados.");
  }
  const ids = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidate || candidate.projectId !== input.projectId ||
        typeof candidate.id !== "string" || !candidate.id.trim() ||
        typeof candidate.entityId !== "string" || !candidate.entityId.trim() ||
        typeof candidate.state !== "string" ||
        typeof candidate.documentId !== "string" || !candidate.documentId.trim() ||
        !Number.isSafeInteger(candidate.revision) || candidate.revision < 0 ||
        !validEvidence(candidate.evidence) ||
        candidate.evidence.documentId !== candidate.documentId ||
        candidate.evidence.revision !== candidate.revision ||
        !validEvidence(candidate.stateEvidence) ||
        (candidate.epistemicFrameEvidence !== undefined &&
          (!validEvidence(candidate.epistemicFrameEvidence) ||
           candidate.epistemicFrameEvidence.documentId !== candidate.documentId ||
           candidate.epistemicFrameEvidence.revision !== candidate.revision ||
           candidate.epistemicFrameEvidence.start < candidate.evidence.start ||
           candidate.epistemicFrameEvidence.end > candidate.evidence.end)) ||
        (candidate.epistemicSourceCandidate !== undefined &&
          (typeof candidate.epistemicSourceCandidate.entityId !== "string" ||
           !candidate.epistemicSourceCandidate.entityId.trim() ||
           !validEvidence(candidate.epistemicSourceCandidate.evidence) ||
           candidate.epistemicSourceCandidate.evidence.documentId !== candidate.documentId ||
           candidate.epistemicSourceCandidate.evidence.revision !== candidate.revision)) ||
        candidate.stateEvidence.documentId !== candidate.documentId ||
        candidate.stateEvidence.revision !== candidate.revision) {
      throw new Error("La trayectoria contiene candidatos duplicados, ajenos o sin evidencia válida.");
    }
    const identity = [candidate.documentId, candidate.revision, candidate.id].join(":");
    if (ids.has(identity)) {
      throw new Error("La trayectoria contiene el mismo candidato más de una vez.");
    }
    ids.add(identity);
    if (candidate.stateEvidence.start < candidate.evidence.start ||
        candidate.stateEvidence.end > candidate.evidence.end) {
      throw new Error("La evidencia específica del estado queda fuera de su afirmación.");
    }
    if (candidate.polarity !== "affirmed" && candidate.polarity !== "negated") {
      throw new Error("La polaridad del estado no es válida.");
    }
    if (!["ordinary", "ongoing", "recurrent", "ceased"].includes(candidate.aspect)) {
      throw new Error("El aspecto del estado no es válido.");
    }
  }
}


export function discoverNarrativeCharacterStateTransitions(
  input: NarrativeCharacterStateTransitionDiscoveryInput
): readonly NarrativeCharacterStateTransitionCandidate[] {
  validate(input);
  const ordered = [...input.candidates].sort((a, b) =>
    a.documentId.localeCompare(b.documentId) ||
    a.revision - b.revision ||
    a.evidence.start - b.evidence.start ||
    a.id.localeCompare(b.id)
  );
  const previousByState = new Map<string, NarrativeCharacterStateCandidate>();
  const results: NarrativeCharacterStateTransitionCandidate[] = [];

  for (const current of ordered) {
    const key = [current.documentId, current.revision, current.entityId, current.state,
      current.epistemicFrame, current.epistemicSourceCandidate?.entityId ?? ""].join(":");
    const previous = previousByState.get(key);
    let transition: NarrativeCharacterStateTransitionKind | undefined;
    let basis: NarrativeCharacterStateTransitionBasis = "paired-assertions";

    if (current.aspect === "recurrent" && current.polarity === "affirmed") {
      transition = "recurred";
      basis = "explicit-aspect-marker";
    } else if (current.aspect === "ceased" && current.polarity === "negated") {
      transition = "ceased";
      basis = "explicit-aspect-marker";
    } else if (previous) {
      if (previous.polarity === "affirmed" && current.polarity === "negated") {
        transition = "ceased";
      } else if (previous.polarity === "negated" && current.polarity === "affirmed") {
        transition = "reappeared";
      } else if (previous.polarity === "affirmed" && current.polarity === "affirmed") {
        transition = "reaffirmed";
      } else {
        transition = "remained-negated";
      }
    }

    if (transition) {
      const evidence = current.evidence;
      results.push({
        id: "character-state-transition:" + current.documentId + ":" +
          current.revision + ":" + current.id + ":" + transition,
        projectId: input.projectId,
        documentId: current.documentId,
        revision: current.revision,
        entityId: current.entityId,
        state: current.state,
        epistemicFrame: current.epistemicFrame,
        ...(current.epistemicSourceCandidate ? { epistemicSourceEntityId: current.epistemicSourceCandidate.entityId } : {}),
        transition,
        basis,
        ...(previous ? {
          previousCandidateId: previous.id,
          previousEvidence: previous.evidence
        } : {}),
        currentCandidateId: current.id,
        currentEvidence: current.evidence,
        ...(previous?.epistemicFrameEvidence ? { previousEpistemicEvidence: previous.epistemicFrameEvidence } : {}),
        ...(current.epistemicFrameEvidence ? { currentEpistemicEvidence: current.epistemicFrameEvidence } : {}),
        evidence,
        reviewStatus: "candidate"
      });
      if (results.length >= MAX_NARRATIVE_CHARACTER_STATE_TRANSITIONS) {
        throw new Error("La reconstrucción supera el límite de transiciones; divide el manuscrito por bloques o capítulos.");
      }
    }
    previousByState.set(key, current);
  }
  return results.sort((a, b) =>
    a.currentEvidence.start - b.currentEvidence.start ||
    a.entityId.localeCompare(b.entityId)
  );
}
