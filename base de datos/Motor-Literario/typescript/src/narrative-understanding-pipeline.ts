/**
 * Punto de entrada para comprender un fragmento narrativo.
 *
 * Coordina extractores especializados sobre el mismo documento/revisión y
 * devuelve candidatos con procedencia compartida. No consolida ni canoniza
 * interpretaciones: cada señal permanece revisable y vinculada al texto.
 */
import type { NarrativeEntity } from "./narrative-knowledge";
import { discoverNarrativeIdeaCandidates } from "./narrative-idea-discovery";
import { extractNarrativeActionCandidates } from "./narrative-action-extraction";
import { extractNarrativeEventCandidates } from "./narrative-event-extraction";
import { extractNarrativeConsequenceCandidates } from "./narrative-consequence-extraction";
import {
  assignNarrativeEvidenceToScene,
  segmentNarrativeScenes
} from "./narrative-scene-context";
import {
  extractNarrativeCharacterInteractions,
  detectNarrativeInteractionShifts
} from "./narrative-character-interaction-evolution";

export interface NarrativeUnderstandingInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  /** Offset UTF-16 absoluto cuando el fragmento es una ventana del documento. */
  readonly baseOffset?: number;
}

export interface NarrativeUnderstandingResult {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly analyzedRange: { readonly start: number; readonly end: number };
  readonly ideas: ReturnType<typeof discoverNarrativeIdeaCandidates>;
  readonly actions: ReturnType<typeof extractNarrativeActionCandidates>;
  readonly events: ReturnType<typeof extractNarrativeEventCandidates>;
  readonly consequences: ReturnType<typeof extractNarrativeConsequenceCandidates>;
  readonly scenes: ReturnType<typeof segmentNarrativeScenes>;
  readonly interactions: ReturnType<typeof extractNarrativeCharacterInteractions>;
  readonly interactionShifts: ReturnType<typeof detectNarrativeInteractionShifts>;
  readonly sceneAssignments: {
    readonly ideaCandidates: readonly {
      readonly candidateId: string;
      readonly sceneId?: string;
      readonly sceneAssignment: "explicit" | "unassigned" | "crosses-boundary";
    }[];
    readonly actionCandidates: readonly {
      readonly candidateId: string;
      readonly sceneId?: string;
      readonly sceneAssignment: "explicit" | "unassigned" | "crosses-boundary";
    }[];
    readonly eventCandidates: readonly {
      readonly candidateId: string;
      readonly sceneId?: string;
      readonly sceneAssignment: "explicit" | "unassigned" | "crosses-boundary";
    }[];
  };
}

const MAX_TEXT_UNITS = 2_000_000;
const MAX_ENTITIES = 500;

function validate(input: NarrativeUnderstandingInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_TEXT_UNITS ||
      !Array.isArray(input.entities) || input.entities.length > MAX_ENTITIES ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para comprender el fragmento narrativo.");
  }
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim()) {
      throw new Error("Las entidades deben pertenecer al proyecto analizado.");
    }
  }
}

/**
 * Ejecuta la adquisición narrativa coordinada para un único documento y
 * revisión. La misma ventana y baseOffset se propagan a todos los módulos.
 */
export function understandNarrativeFragment(
  input: NarrativeUnderstandingInput
): NarrativeUnderstandingResult {
  validate(input);
  const baseOffset = input.baseOffset ?? 0;
  const extractionContext = {
    projectId: input.projectId,
    documentId: input.documentId,
    revision: input.revision,
    text: input.text,
    entities: input.entities,
    baseOffset
  };
  const ideas = discoverNarrativeIdeaCandidates({
    projectId: input.projectId, documentId: input.documentId,
    revision: input.revision, text: input.text, baseOffset
  });
  const actions = extractNarrativeActionCandidates(extractionContext);
  const events = extractNarrativeEventCandidates(extractionContext);
  const consequences = extractNarrativeConsequenceCandidates({
    projectId: input.projectId, documentId: input.documentId,
    revision: input.revision, text: input.text, events, baseOffset
  });
  const scenes = segmentNarrativeScenes({
    projectId: input.projectId, documentId: input.documentId,
    revision: input.revision, text: input.text, baseOffset
  });
  const interactions = extractNarrativeCharacterInteractions(
    actions, input.entities, input.projectId
  );
  const interactionShifts = detectNarrativeInteractionShifts(interactions);

  const assign = <T extends { readonly id: string; readonly evidence: {
    readonly start: number; readonly end: number; readonly excerpt: string
  } }>(items: readonly T[]) => items.map(item => {
    const assigned = assignNarrativeEvidenceToScene(item, scenes);
    return {
      candidateId: item.id,
      ...(assigned.sceneId ? { sceneId: assigned.sceneId } : {}),
      sceneAssignment: assigned.sceneAssignment
    };
  });

  return {
    projectId: input.projectId,
    documentId: input.documentId,
    revision: input.revision,
    analyzedRange: { start: baseOffset, end: baseOffset + input.text.length },
    ideas, actions, events, consequences, scenes, interactions, interactionShifts,
    sceneAssignments: {
      ideaCandidates: assign(ideas),
      actionCandidates: assign(actions),
      eventCandidates: assign(events)
    }
  };
}
