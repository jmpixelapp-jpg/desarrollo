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
import { extractNarrativeAttributedClaims } from "./narrative-claim-extraction";
import { extractNarrativeDialogueAttributions } from "./narrative-dialogue-attribution";
import { extractNarrativeInformationProvenance } from "./narrative-information-provenance";
import {
  extractNarrativeKnowledgeEvolution,
  type NarrativeKnowledgeEvolution
} from "./narrative-knowledge-evolution";
import type { NarrativeAttributedClaim } from "./narrative-claim-extraction";
import {
  reconstructNarrativeInformationChain,
  type NarrativeInformationChainStep
} from "./narrative-information-chain";
import type { NarrativeInformationProvenance } from "./narrative-information-provenance";
import {
  extractNarrativeInformationInterpretations,
  type NarrativeInformationInterpretation
} from "./narrative-information-interpretation";
import {
  buildNarrativeCharacterKnowledgeStates,
  type NarrativeCharacterKnowledgeState
} from "./narrative-character-knowledge-state";
import { extractNarrativeEventCandidates } from "./narrative-event-extraction";
import { extractNarrativeMemoryEvents, type NarrativeMemoryEvent } from "./narrative-memory-events";
import { buildNarrativeMemoryTimeline, type NarrativeCharacterMemoryState } from "./narrative-memory-timeline";
import { extractNarrativeConsequenceCandidates } from "./narrative-consequence-extraction";
import {
  assignNarrativeEvidenceToScene,
  segmentNarrativeScenes
} from "./narrative-scene-context";
import {
  extractNarrativeCharacterInteractions,
  detectNarrativeInteractionShifts
} from "./narrative-character-interaction-evolution";
import {
  resolveNarrativePronounReferences,
  type NarrativeCharacterMention,
  type NarrativePronounReference,
  type NarrativePronounResolutionOptions
} from "./narrative-pronoun-resolution";
import { extractNarrativePronounActionCandidates } from "./narrative-pronoun-action-link";
import { linkNarrativePronounActionTargets } from "./narrative-pronoun-target-link";
import {
  extractNarrativeAssertions,
  type NarrativeAssertion
} from "./narrative-history";
import {
  analyzeNarrativeConsistency,
  type NarrativeConsistencyFinding
} from "./narrative-consistency";
import {
  detectNarrativePronounInputs,
  type NarrativeCharacterPronounProfile
} from "./narrative-pronoun-detection";

export interface NarrativeUnderstandingInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  /** Offset UTF-16 absoluto cuando el fragmento es una ventana del documento. */
  readonly baseOffset?: number;
  /** Menciones detectadas externamente; offsets UTF-16 absolutos del documento. */
  readonly characterMentions?: readonly NarrativeCharacterMention[];
  /** Pronombres detectados externamente; offsets UTF-16 absolutos del documento. */
  readonly pronounReferences?: readonly NarrativePronounReference[];
  readonly pronounResolutionOptions?: NarrativePronounResolutionOptions;
  readonly characterProfiles?: readonly NarrativeCharacterPronounProfile[];
  /** Afirmaciones previas del mismo proyecto, procedentes de otros fragmentos o capítulos. */
  readonly priorAssertions?: readonly NarrativeAssertion[];
  /** Afirmaciones atribuidas anteriores, conservadas con su procedencia original. */
  readonly priorClaims?: readonly NarrativeAttributedClaim[];
  /** Procedencias previas del mismo proyecto para reconstruir transmisiones entre capítulos. */
  readonly priorInformationProvenance?: readonly NarrativeInformationProvenance[];
  /** Interpretaciones explícitas previas, conservadas con su evidencia. */
  readonly priorInformationInterpretations?: readonly NarrativeInformationInterpretation[];
  /** Evaluaciones anteriores de afirmaciones, con evidencia y autoría originales. */
  readonly priorKnowledgeEvolution?: readonly NarrativeKnowledgeEvolution[];
  /** Eventos explícitos de memoria anteriores, conservados entre fragmentos. */
  readonly priorMemoryEvents?: readonly NarrativeMemoryEvent[];
  /** Orden cronológico de documentos conocido por el proyecto; si falta, no se inventa. */
  readonly orderedDocumentIds?: readonly string[];
}

export interface NarrativeUnderstandingResult {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly analyzedRange: { readonly start: number; readonly end: number };
  readonly ideas: ReturnType<typeof discoverNarrativeIdeaCandidates>;
  readonly actions: ReturnType<typeof extractNarrativeActionCandidates>;
  readonly attributedClaims: ReturnType<typeof extractNarrativeAttributedClaims>;
  readonly dialogueAttributions: ReturnType<typeof extractNarrativeDialogueAttributions>;
  readonly informationProvenance: ReturnType<typeof extractNarrativeInformationProvenance>;
  readonly knowledgeEvolution: readonly NarrativeKnowledgeEvolution[];
  readonly informationChain: readonly NarrativeInformationChainStep[];
  readonly informationInterpretations: readonly NarrativeInformationInterpretation[];
  readonly characterKnowledgeStates: readonly NarrativeCharacterKnowledgeState[];
  readonly memoryEvents: readonly NarrativeMemoryEvent[];
  readonly characterMemoryTimelines: readonly NarrativeCharacterMemoryState[];
  readonly events: ReturnType<typeof extractNarrativeEventCandidates>;
  readonly consequences: ReturnType<typeof extractNarrativeConsequenceCandidates>;
  readonly scenes: ReturnType<typeof segmentNarrativeScenes>;
  readonly interactions: ReturnType<typeof extractNarrativeCharacterInteractions>;
  readonly interactionShifts: ReturnType<typeof detectNarrativeInteractionShifts>;
  readonly pronounResolutions: ReturnType<typeof resolveNarrativePronounReferences>;
  readonly pronounActions: ReturnType<typeof extractNarrativePronounActionCandidates>;
  readonly pronounTargetActions: ReturnType<typeof linkNarrativePronounActionTargets>;
  readonly skippedAmbiguousCharacterNames: readonly string[];
  readonly assertions: readonly NarrativeAssertion[];
  readonly consistencyFindings: readonly NarrativeConsistencyFinding[];
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
    readonly pronounActionCandidates: readonly {
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
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length)) ||
      (input.characterMentions !== undefined && !Array.isArray(input.characterMentions)) ||
      (input.pronounReferences !== undefined && !Array.isArray(input.pronounReferences)) ||
      (input.priorAssertions !== undefined &&
        (!Array.isArray(input.priorAssertions) || input.priorAssertions.length > 5000)) ||
      (input.priorClaims !== undefined &&
        (!Array.isArray(input.priorClaims) || input.priorClaims.length > 5000)) ||
      (input.priorInformationProvenance !== undefined &&
        (!Array.isArray(input.priorInformationProvenance) || input.priorInformationProvenance.length > 5000)) ||
      (input.priorInformationInterpretations !== undefined &&
        (!Array.isArray(input.priorInformationInterpretations) || input.priorInformationInterpretations.length > 5000)) ||
      (input.priorKnowledgeEvolution !== undefined &&
        (!Array.isArray(input.priorKnowledgeEvolution) || input.priorKnowledgeEvolution.length > 5000)) ||
      (input.orderedDocumentIds !== undefined && !Array.isArray(input.orderedDocumentIds))) {
    throw new Error("Contexto inválido para comprender el fragmento narrativo.");
  }
  const baseOffset = input.baseOffset ?? 0;
  const endOffset = baseOffset + input.text.length;
  // Validar primero la colección: las comprobaciones de menciones la recorren.
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim()) {
      throw new Error("Las entidades deben pertenecer al proyecto analizado.");
    }
  }
  for (const mention of input.characterMentions ?? []) {
    if (!mention || !Number.isSafeInteger(mention.start) || !Number.isSafeInteger(mention.end) ||
        mention.start < baseOffset || mention.end > endOffset ||
        mention.documentId !== input.documentId || mention.revision !== input.revision ||
        !input.entities.some(entity => entity.id === mention.characterId && entity.kind === "character")) {
      throw new Error("Las menciones deben referir personajes del documento, revisión y fragmento analizados.");
    }
  }
  for (const reference of input.pronounReferences ?? []) {
    if (!reference || !Number.isSafeInteger(reference.start) || !Number.isSafeInteger(reference.end) ||
        reference.start < baseOffset || reference.end > endOffset ||
        reference.documentId !== input.documentId || reference.revision !== input.revision ||
        input.text.slice(reference.start - baseOffset, reference.end - baseOffset) !== reference.surface) {
      throw new Error("Las referencias pronominales deben coincidir con el texto y su procedencia.");
    }
  }
  if ((input.pronounReferences?.length ?? 0) > 500 ||
      (input.characterMentions?.length ?? 0) > 2000) {
    throw new Error("Se superó el límite de menciones o referencias pronominales.");
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
  for (const assertion of input.priorAssertions ?? []) {
    if (!assertion || assertion.projectId !== input.projectId ||
        typeof assertion.entityId !== "string" ||
        !input.entities.some(entity => entity.kind === "character" && entity.id === assertion.entityId)) {
      throw new Error("Las afirmaciones previas deben pertenecer al proyecto y a personajes conocidos.");
    }
  }
  const assertions = extractNarrativeAssertions(
    input.projectId, input.documentId, input.revision, input.text,
    input.entities, baseOffset
  );
  const consistencyFindings = analyzeNarrativeConsistency(
    input.projectId, [...(input.priorAssertions ?? []), ...assertions]
  );
  const ideas = discoverNarrativeIdeaCandidates({
    projectId: input.projectId, documentId: input.documentId,
    revision: input.revision, text: input.text, baseOffset
  });
  const actions = extractNarrativeActionCandidates(extractionContext);
  const attributedClaims = extractNarrativeAttributedClaims(extractionContext);
  const dialogueAttributions = extractNarrativeDialogueAttributions(extractionContext);
  const informationProvenance = extractNarrativeInformationProvenance(extractionContext);
  const knowledgeEvolution = extractNarrativeKnowledgeEvolution({
    ...extractionContext, priorClaims: input.priorClaims
  });
  const informationChain = reconstructNarrativeInformationChain({
    projectId: input.projectId,
    currentRecords: informationProvenance,
    priorRecords: input.priorInformationProvenance
  });
  const informationInterpretations = extractNarrativeInformationInterpretations({
    ...extractionContext,
    priorInformation: input.priorInformationProvenance
  });
  const memoryEvents = extractNarrativeMemoryEvents(extractionContext);
  const characterMemoryTimelines = buildNarrativeMemoryTimeline({
    projectId: input.projectId,
    entities: input.entities,
    events: [...(input.priorMemoryEvents ?? []), ...memoryEvents],
    orderedDocumentIds: input.orderedDocumentIds
  });
  const characterKnowledgeStates = buildNarrativeCharacterKnowledgeStates({
    projectId: input.projectId,
    entities: input.entities,
    information: [...(input.priorInformationProvenance ?? []), ...informationProvenance],
    interpretations: [...(input.priorInformationInterpretations ?? []), ...informationInterpretations],
    evaluations: [...(input.priorKnowledgeEvolution ?? []), ...knowledgeEvolution],
    orderedDocumentIds: input.orderedDocumentIds
  });
  const events = extractNarrativeEventCandidates(extractionContext);
  const consequences = extractNarrativeConsequenceCandidates({
    projectId: input.projectId, documentId: input.documentId,
    revision: input.revision, text: input.text, events, baseOffset
  });
  const scenes = segmentNarrativeScenes({
    projectId: input.projectId, documentId: input.documentId,
    revision: input.revision, text: input.text, baseOffset
  });

  const detectedPronouns = detectNarrativePronounInputs(
    input.text, input.entities, input.documentId, input.revision,
    baseOffset, input.characterProfiles ?? []
  );
  const sourceMentions = input.characterMentions ?? detectedPronouns.mentions;
  const sourceReferences = input.pronounReferences ?? detectedPronouns.references;
  const localMentions = sourceMentions.map(item => ({
    ...item, start: item.start - baseOffset, end: item.end - baseOffset
  }));
  const localReferences = sourceReferences.map(item => ({
    ...item, start: item.start - baseOffset, end: item.end - baseOffset
  }));
  const pronounResolutions = localReferences.length
    ? resolveNarrativePronounReferences(
        input.text, localMentions, localReferences, input.pronounResolutionOptions
      )
    : [];
  const pronounActions = localReferences.length
    ? extractNarrativePronounActionCandidates(input.text, localReferences, pronounResolutions)
        .map(item => ({
          ...item,
          evidence: {
            ...item.evidence,
            start: item.evidence.start + baseOffset,
            end: item.evidence.end + baseOffset
          }
        }))
    : [];
  const pronounTargetActions = linkNarrativePronounActionTargets(
    input.text, pronounActions, input.entities, input.projectId, baseOffset
  );
  const interactions = extractNarrativeCharacterInteractions(
    [...actions, ...pronounTargetActions], input.entities, input.projectId
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
    ideas, actions, attributedClaims, dialogueAttributions, informationProvenance, knowledgeEvolution, informationChain, informationInterpretations, characterKnowledgeStates, memoryEvents, characterMemoryTimelines, events, consequences, scenes, interactions, interactionShifts, pronounResolutions, pronounActions, pronounTargetActions,
    skippedAmbiguousCharacterNames: detectedPronouns.skippedAmbiguousNames,
    assertions, consistencyFindings,
    sceneAssignments: {
      ideaCandidates: assign(ideas),
      actionCandidates: assign(actions),
      eventCandidates: assign(events),
      pronounActionCandidates: assign(pronounActions)
    }
  };
}
