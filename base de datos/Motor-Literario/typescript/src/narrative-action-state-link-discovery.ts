/**
 * Propone vínculos entre acciones observadas y estados explícitos de personajes.
 *
 * La relación expresa proximidad de evidencia y presencia de un conector causal;
 * no certifica causalidad en el mundo narrado ni resuelve la voz narrativa.
 */
import type { NarrativeObservationCandidate } from "./narrative-observation-discovery";
import type { NarrativeCharacterStateCandidate } from "./narrative-character-state-discovery";
import type { TextEvidence } from "./narrative-knowledge";

export type NarrativeActionStateLinkPosition = "action-before-state" | "state-before-action";
export type NarrativeActionStateLinkBasis = "shared-character-mention" | "directed-interaction-target";

export interface NarrativeActionStateLinkCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly actionId: string;
  readonly stateCandidateId: string;
  readonly entityId: string;
  readonly basis: NarrativeActionStateLinkBasis;
  readonly marker: string;
  readonly markerEvidence: TextEvidence;
  readonly position: NarrativeActionStateLinkPosition;
  readonly actionEvidence: TextEvidence;
  readonly stateEvidence: TextEvidence;
  readonly reviewStatus: "candidate";
}

export interface NarrativeActionStateLinkDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly observations: readonly NarrativeObservationCandidate[];
  readonly states: readonly NarrativeCharacterStateCandidate[];
  readonly baseOffset?: number;
}

export const MAX_NARRATIVE_ACTION_STATE_LINK_GAP = 500;
export const MAX_NARRATIVE_ACTION_STATE_LINKS = 300;

const CAUSAL_MARKERS = /(?<![\p{L}\p{M}\p{N}_])(?:porque|ya\s+que|puesto\s+que|debido\s+a|a\s+causa\s+de|por\s+culpa\s+de|gracias\s+a|a\s+ra[ií]z\s+de|por\s+esta\s+raz[oó]n|por\s+esa\s+raz[oó]n|por\s+eso|por\s+lo\s+tanto|por\s+consiguiente|as[ií]\s+que|de\s+ah[ií]\s+que|de\s+modo\s+que|como\s+resultado|en\s+consecuencia)(?![\p{L}\p{M}\p{N}_])/iu;

function validEvidence(evidence: TextEvidence, input: NarrativeActionStateLinkDiscoveryInput): boolean {
  const base = input.baseOffset ?? 0;
  return !!evidence &&
    evidence.documentId === input.documentId &&
    evidence.revision === input.revision &&
    Number.isSafeInteger(evidence.start) && Number.isSafeInteger(evidence.end) &&
    evidence.start >= base && evidence.end > evidence.start &&
    evidence.end <= base + input.text.length &&
    typeof evidence.excerpt === "string" && evidence.excerpt.length > 0 &&
    evidence.end - evidence.start === evidence.excerpt.length &&
    input.text.slice(evidence.start - base, evidence.end - base) === evidence.excerpt &&
    evidence.status !== "stale";
}

function validate(input: NarrativeActionStateLinkDiscoveryInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || !Array.isArray(input.observations) ||
      !Array.isArray(input.states) ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para vincular acciones y estados.");
  }
  const actionIds = new Set<string>();
  for (const action of input.observations) {
    if (!action || action.projectId !== input.projectId ||
        action.documentId !== input.documentId || action.revision !== input.revision ||
        action.kind !== "action" || typeof action.id !== "string" || !action.id.trim() ||
        actionIds.has(action.id) || !validEvidence(action.actionEvidence, input)) {
      throw new Error("Las acciones deben tener identidad única y evidencia literal verificable.");
    }
    actionIds.add(action.id);
  }
  const stateIds = new Set<string>();
  for (const state of input.states) {
    if (!state || state.projectId !== input.projectId ||
        state.documentId !== input.documentId || state.revision !== input.revision ||
        typeof state.id !== "string" || !state.id.trim() || stateIds.has(state.id) ||
        typeof state.entityId !== "string" || !state.entityId.trim() ||
        !validEvidence(state.stateEvidence, input) ||
        !validEvidence(state.evidence, input) ||
        state.stateEvidence.start < state.evidence.start ||
        state.stateEvidence.end > state.evidence.end) {
      throw new Error("Los estados deben pertenecer al mismo documento/revisión y conservar evidencia verificable.");
    }
    stateIds.add(state.id);
  }
}

/**
 * Solo vincula si el marcador causal aparece entre el verbo y el predicado
 * de estado, y existe un personaje compartido o un destinatario explícito.
 */
export function discoverNarrativeActionStateLinks(
  input: NarrativeActionStateLinkDiscoveryInput
): readonly NarrativeActionStateLinkCandidate[] {
  validate(input);
  const base = input.baseOffset ?? 0;
  const actions = [...input.observations].sort((a, b) =>
    a.actionEvidence.start - b.actionEvidence.start
  );
  const states = [...input.states].sort((a, b) =>
    a.stateEvidence.start - b.stateEvidence.start
  );
  const result: NarrativeActionStateLinkCandidate[] = [];
  const seen = new Set<string>();

  for (const action of actions) {
    for (const state of states) {
      const actionEntityIds = new Set(action.mentionedCharacterIds);
      const shared = actionEntityIds.has(state.entityId);
      const directedTarget = action.directedInteractionCandidate?.toEntityId === state.entityId;
      if (!shared && !directedTarget) continue;

      const actionStart = action.actionEvidence.start;
      const actionEnd = action.actionEvidence.end;
      const stateStart = state.stateEvidence.start;
      const stateEnd = state.stateEvidence.end;
      let gapStart: number;
      let gapEnd: number;
      let position: NarrativeActionStateLinkPosition;
      if (actionEnd <= stateStart) {
        gapStart = actionEnd;
        gapEnd = stateStart;
        position = "action-before-state";
      } else if (stateEnd <= actionStart) {
        gapStart = stateEnd;
        gapEnd = actionStart;
        position = "state-before-action";
      } else {
        continue;
      }
      const gapLength = gapEnd - gapStart;
      if (gapLength <= 0 || gapLength > MAX_NARRATIVE_ACTION_STATE_LINK_GAP) continue;
      const gap = input.text.slice(gapStart - base, gapEnd - base);
      const marker = CAUSAL_MARKERS.exec(gap);
      if (!marker) continue;

      const markerStart = gapStart + marker.index;
      const markerEnd = markerStart + marker[0].length;
      const identity = action.id + ":" + state.id + ":" + markerStart;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const basis: NarrativeActionStateLinkBasis = directedTarget
        ? "directed-interaction-target"
        : "shared-character-mention";

      result.push({
        id: "action-state-link:" + input.documentId + ":" + input.revision + ":" + identity,
        projectId: input.projectId,
        documentId: input.documentId,
        revision: input.revision,
        actionId: action.id,
        stateCandidateId: state.id,
        entityId: state.entityId,
        basis,
        marker: marker[0],
        markerEvidence: {
          documentId: input.documentId,
          revision: input.revision,
          start: markerStart,
          end: markerEnd,
          excerpt: marker[0]
        },
        position,
        actionEvidence: action.actionEvidence,
        stateEvidence: state.stateEvidence,
        reviewStatus: "candidate"
      });
      if (result.length >= MAX_NARRATIVE_ACTION_STATE_LINKS) return result;
    }
  }
  return result.sort((a, b) =>
    a.markerEvidence.start - b.markerEvidence.start ||
    a.entityId.localeCompare(b.entityId)
  );
}
