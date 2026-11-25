import type { NarrativeAssertion } from "./narrative-history";
import {
  MAX_NARRATIVE_IDEA_REFERENCES,
  type NarrativeTimeReference, type NarrativeRelation, type NarrativeIdea, type NarrativeIdeaStatusChange
} from "./narrative-knowledge";
import { validateEventLifecycle, type EventLifecycle } from "./project-data";

/**
 * Análisis literario descriptivo y determinista.
 * No afirma intención autoral, identidad del narrador ni calidad estética.
 * Las ocurrencias conservan offsets UTF-16 absolutos para inspección editorial.
 */
export const MAX_LITERARY_ANALYSIS_TEXT_UNITS = 2_000_000;

export interface LiteraryAnalysisKnownCharacter {
  readonly entityId: string;
  readonly canonicalName: string;
  readonly aliases?: readonly string[];
}
export interface LiteraryAnalysisKnownEventEvidence {
  readonly documentId: string;
  readonly revision: number;
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
  readonly status?: "stale";
}
export interface LiteraryAnalysisKnownEvent {
  readonly eventId: string;
  readonly label: string;
  readonly participants: readonly string[];
  readonly evidence: readonly LiteraryAnalysisKnownEventEvidence[];
}
export interface LiteraryAnalysisKnownProjectEvent {
  readonly projectId: string;
  readonly eventId: string;
  readonly label: string;
  readonly participants: readonly string[];
  readonly timelineTrackId?: string;
  readonly timeReference?: NarrativeTimeReference;
  /** Total de evidencias activas antes de limitar las muestras transferidas. */
  readonly evidenceCount?: number;
  /** Evidencias obsoletas no incluidas en la muestra activa. */
  readonly staleEvidenceCount?: number;
  readonly evidence: readonly LiteraryAnalysisKnownEventEvidence[];
}
export interface LiteraryAnalysisKnownRelation {
  readonly projectId: string;
  readonly relationId: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly relationType: string;
  readonly evidenceCount: number;
  readonly staleEvidenceCount: number;
  readonly evidence: readonly LiteraryAnalysisKnownEventEvidence[];
}
export interface LiteraryAnalysisKnownIdea {
  readonly projectId: string;
  readonly ideaId: string;
  readonly text: string;
  readonly status: NarrativeIdea["status"];
  readonly originDocumentId: string;
  readonly sourceProjectName: string;
  readonly relatedEntityIds: readonly string[];
  readonly relatedIdeaIds: readonly string[];
  readonly evidenceCount: number;
  readonly staleEvidenceCount: number;
  readonly evidence: readonly LiteraryAnalysisKnownEventEvidence[];
  readonly statusHistory: readonly NarrativeIdeaStatusChange[];
  readonly writerDecisionCount: number;
  readonly omittedStatusHistoryCount: number;
}
/** Proyección completa de ideas del libro usada exclusivamente para el grafo global. */
export interface LiteraryAnalysisKnownProjectIdea {
  readonly projectId: string;
  readonly ideaId: string;
  /** Texto explícito de la idea; opcional para adaptadores antiguos. */
  readonly text?: string;
  /** El anfitrión omitió este texto para respetar el presupuesto agregado de análisis. */
  readonly textOmitted?: "budget";
  readonly status: NarrativeIdea["status"];
  readonly relatedIdeaIds: readonly string[];
  readonly evidenceCount: number;
  readonly staleEvidenceCount: number;
  readonly statusHistory: readonly NarrativeIdeaStatusChange[];
  readonly writerDecisionCount: number;
  readonly omittedStatusHistoryCount: number;
}
export interface LiteraryAnalysisInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly baseOffset?: number;
  /** Identidades de personajes conocidas por el proyecto; nunca se infieren desde el fragmento. */
  readonly knownCharacters?: readonly LiteraryAnalysisKnownCharacter[];
  /** Acontecimientos con evidencia del documento y revisión analizados. */
  readonly knownEvents?: readonly LiteraryAnalysisKnownEvent[];
  /** Catálogo global de acontecimientos del proyecto para cronologías intercapítulos explícitamente fechadas. */
  readonly knownProjectEvents?: readonly LiteraryAnalysisKnownProjectEvent[];
  /** Registros globales omitidos al acotar el catálogo transferido al análisis. */
  readonly knownProjectEventsOmittedCount?: number;
  /** Historiales append-only validados de cambios explícitos de etiqueta y participantes. */
  readonly knownEventLifecycles?: readonly EventLifecycle[];
  /** Afirmaciones históricas del proyecto; solo se asignan a escenas con evidencia vigente de esta revisión. */
  readonly knownAssertions?: readonly NarrativeAssertion[];
  /** Relaciones actuales del proyecto, con evidencias activas y obsoletas separadas. */
  readonly knownRelations?: readonly LiteraryAnalysisKnownRelation[];
  /** Ideas vinculadas explícitamente a personajes, con decisiones de estado registradas. */
  readonly knownIdeas?: readonly LiteraryAnalysisKnownIdea[];
  /** Catálogo global de todas las ideas del libro; alimenta el grafo aunque no tengan personajes asociados. */
  readonly knownProjectIdeas?: readonly LiteraryAnalysisKnownProjectIdea[];
  readonly knownProjectIdeasOmittedCount?: number;
  readonly knownRelationsOmittedCount?: number;
  readonly knownIdeasOmittedCount?: number;
}
export interface LiteraryAnalysisOccurrence { readonly start: number; readonly end: number; }
export interface LiteraryRepeatedWord {
  readonly word: string;
  readonly count: number;
  readonly occurrences: readonly LiteraryAnalysisOccurrence[];
}
export interface LiteraryRepeatedPhrase {
  readonly phrase: string;
  readonly wordCount: number;
  readonly count: number;
  readonly occurrences: readonly LiteraryAnalysisOccurrence[];
}
export interface LiterarySentenceOpening {
  readonly opening: string;
  readonly count: number;
  readonly occurrences: readonly LiteraryAnalysisOccurrence[];
}
export interface LiteraryAnaphoraCandidate {
  readonly phrase: string;
  /** Índices 1-based de las oraciones consecutivas dentro del fragmento. */
  readonly sentenceIndexes: readonly number[];
  readonly occurrences: readonly LiteraryAnalysisOccurrence[];
}
export type LiterarySensoryModality = "visual" | "auditory" | "tactile" | "olfactory" | "gustatory";
export interface LiterarySensorySignal {
  readonly modality: LiterarySensoryModality;
  readonly count: number;
  readonly occurrences: readonly LiteraryAnalysisOccurrence[];
}
export interface LiteraryVoiceSignalCounts {
  readonly firstPerson: number;
  readonly secondPerson: number;
  readonly thirdPerson: number;
}
export type LiteraryVoiceSignalClassification =
  | "first-person-signals" | "second-person-signals" | "third-person-signals"
  | "mixed-signals" | "undetermined";
export type LiteraryDialogueSegmentFormat = "quotation" | "dialogue-dash" | "mixed";
export interface LiteraryDialogueSegment {
  readonly segmentIndex: number;
  readonly format: LiteraryDialogueSegmentFormat;
  readonly wordCount: number;
  readonly occurrence: LiteraryAnalysisOccurrence;
}
export interface LiteraryVoiceSignal {
  readonly classification: LiteraryVoiceSignalClassification;
  readonly counts: LiteraryVoiceSignalCounts;
  readonly samples: readonly {
    readonly category: "firstPerson" | "secondPerson" | "thirdPerson";
    readonly term: string;
    readonly start: number;
    readonly end: number;
  }[];
}
export interface LiteraryAnalysisMetrics {
  readonly characterCount: number;
  readonly letterCount: number;
  readonly wordCount: number;
  readonly sentenceCount: number;
  readonly paragraphCount: number;
  readonly averageWordsPerSentence: number;
  readonly medianWordsPerSentence: number;
  /** Desviación estándar poblacional de la longitud de las oraciones. */
  readonly sentenceLengthStandardDeviation: number;
  readonly averageWordsPerParagraph: number;
  readonly lexicalDiversity: number;
  readonly dialogueWordCount: number;
  readonly dialogueRatio: number;
  readonly dialogueSegmentCount: number;
  readonly averageWordsPerDialogueSegment: number;
  readonly longestDialogueSegmentWords: number;
  readonly questionMarkCount: number;
  readonly exclamationMarkCount: number;
  readonly ellipsisCount: number;
  readonly shortestSentenceWords: number;
  readonly longestSentenceWords: number;
  readonly shortSentenceCount: number;
  readonly mediumSentenceCount: number;
  readonly longSentenceCount: number;
}
export interface LiteraryRhythmTransition {
  readonly beforeSentenceIndex: number;
  readonly afterSentenceIndex: number;
  readonly beforeWordCount: number;
  readonly afterWordCount: number;
  readonly direction: "acceleration" | "deceleration";
  /** Rango UTF-16 completo de ambas oraciones, ya desplazado al documento. */
  readonly occurrences: readonly [LiteraryAnalysisOccurrence, LiteraryAnalysisOccurrence];
}
export type LiteraryRhythmProfile = "fragmented" | "balanced" | "extended" | "insufficient-text";
export type LiterarySentenceLengthBand = "short" | "medium" | "long";
export type LiterarySceneCadencePatternType =
  | "stable-length-band-run"
  | "alternating-length-band-run"
  | "ascending-length-run"
  | "descending-length-run";
export interface LiterarySceneCadencePattern {
  readonly patternType: LiterarySceneCadencePatternType;
  readonly fromSentenceIndex: number;
  readonly toSentenceIndex: number;
  readonly sentenceCount: number;
  /** Muestras alineadas y limitadas a las primeras 40 oraciones del patrón. */
  readonly sentenceWordCounts: readonly number[];
  readonly lengthBands: readonly LiterarySentenceLengthBand[];
  readonly occurrences: readonly LiteraryAnalysisOccurrence[];
  readonly evidenceTruncated: boolean;
}
export interface LiterarySceneCadenceProfile {
  readonly sentenceCount: number;
  readonly sentenceBandCounts: {
    readonly short: number;
    readonly medium: number;
    readonly long: number;
  };
  readonly patternTypeCounts: {
    readonly stableLengthBandRun: number;
    readonly alternatingLengthBandRun: number;
    readonly ascendingLengthRun: number;
    readonly descendingLengthRun: number;
  };
  readonly bandTransitionCounts: {
    readonly shortToShort: number;
    readonly shortToMedium: number;
    readonly shortToLong: number;
    readonly mediumToShort: number;
    readonly mediumToMedium: number;
    readonly mediumToLong: number;
    readonly longToShort: number;
    readonly longToMedium: number;
    readonly longToLong: number;
  };
  readonly patternCount: number;
  /** Patrones ordenados por posición; se devuelven como máximo 20. */
  readonly patterns: readonly LiterarySceneCadencePattern[];
}
export interface LiterarySceneRhythmProfile {
  readonly sentenceCount: number;
  readonly cadence: LiterarySceneCadenceProfile;
  readonly averageWordsPerSentence: number;
  readonly medianWordsPerSentence: number;
  /** Desviación estándar poblacional de la longitud de las oraciones de esta escena. */
  readonly sentenceLengthStandardDeviation: number;
  readonly shortestSentenceWords: number;
  readonly longestSentenceWords: number;
  readonly shortSentenceCount: number;
  readonly mediumSentenceCount: number;
  readonly longSentenceCount: number;
  readonly rhythmProfile: LiteraryRhythmProfile;
  /** Contrastes entre oraciones consecutivas dentro de esta escena, con offsets UTF-16 absolutos. */
  readonly transitions: readonly LiteraryRhythmTransition[];
}
export type LiteraryDialogueDensity = "none" | "low" | "moderate" | "high";

export type LiteraryStructureMarkerType =
  | "part-heading" | "chapter-heading" | "act-heading" | "scene-heading" | "scene-divider";
export interface LiteraryStructureMarker {
  readonly markerType: LiteraryStructureMarkerType;
  readonly label: string;
  readonly lineIndex: number;
  readonly occurrence: LiteraryAnalysisOccurrence;
}
export interface LiterarySceneCharacterMention {
  readonly entityId: string;
  readonly canonicalName: string;
  /** Formas literales observadas; se exponen como máximo diez. */
  readonly matchedNames: readonly string[];
  readonly matchedNameCount: number;
  readonly matchedNamesTruncated: boolean;
  /** Coincidencias literales contadas antes de limitar las muestras. */
  readonly mentionCount: number;
  /** Se conservan como máximo veinte ocurrencias UTF-16. */
  readonly occurrences: readonly LiteraryAnalysisOccurrence[];
  readonly occurrencesTruncated: boolean;
}
export interface LiterarySceneEventParticipant {
  readonly entityId: string;
  /** Indica solo si el nombre/alias aparece literalmente dentro de la escena. */
  readonly mentionedByName: boolean;
}
export interface LiterarySceneEventLink {
  readonly eventId: string;
  readonly label: string;
  /** Número total de rangos coincidentes antes de limitar las muestras UTF-16. */
  readonly matchingEvidenceCount: number;
  readonly matchingEvidenceTruncated: boolean;
  readonly matchingEvidence: readonly LiteraryAnalysisOccurrence[];
  readonly participants: readonly LiterarySceneEventParticipant[];
}
export interface LiteraryCharacterEventEvidenceScene {
  readonly sceneIndex: number;
  /** null indica que no hay evidencia enlazada para este acontecimiento en la escena. */
  readonly evidenceRangeCount: number | null;
  /** Solo se evalúa cuando existe evidencia del acontecimiento en esta escena. */
  readonly participantMentionedByName: boolean | null;
}
export interface LiteraryCharacterEventEvidenceProfile {
  readonly entityId: string;
  /** Nombre canónico conocido en alguna escena del fragmento, o null si no está disponible. */
  readonly canonicalName: string | null;
  readonly eventId: string;
  readonly eventLabel: string;
  readonly sceneIndexes: readonly number[];
  readonly eventEvidenceSceneCount: number;
  readonly firstSceneIndex: number;
  readonly lastSceneIndex: number;
  readonly interveningSceneCount: number;
  readonly totalEvidenceRangeCount: number;
  /** Escenas con evidencia del acontecimiento en las que el nombre del participante también aparece. */
  readonly participantMentionedByNameSceneCount: number;
  /** Serie completa; null distingue ausencia de vínculo de una mención nominal negativa. */
  readonly scenes: readonly LiteraryCharacterEventEvidenceScene[];
}
export interface LiteraryCharacterEventEvidenceAnalysis {
  readonly explicitSceneCount: number;
  /** Escenas donde el límite de 100 vínculos impidió exponer todos los acontecimientos coincidentes. */
  readonly sourceTruncatedSceneCount: number;
  readonly sourceTruncatedSceneIndexes: readonly number[];
  readonly associationCount: number;
  readonly omittedAssociationCount: number;
  readonly characterCount: number;
  readonly eventCount: number;
  /** Asociaciones explícitas participante/acontecimiento, priorizadas por cobertura y evidencia. */
  readonly profiles: readonly LiteraryCharacterEventEvidenceProfile[];
}
export interface LiterarySceneEventEvidenceScene {
  readonly sceneIndex: number;
  /** null indica que no existe evidencia enlazada para este acontecimiento en la escena. */
  readonly evidenceRangeCount: number | null;
  /** null cuando no hay vínculo; en otro caso indica si las muestras UTF-16 superan veinte rangos. */
  readonly evidenceSamplesTruncated: boolean | null;
}
export interface LiterarySceneEventEvidenceProfile {
  readonly eventId: string;
  readonly eventLabel: string;
  readonly sceneIndexes: readonly number[];
  readonly sceneCount: number;
  readonly firstSceneIndex: number;
  readonly lastSceneIndex: number;
  readonly interveningSceneCount: number;
  readonly longestConsecutiveSceneRun: number;
  readonly totalEvidenceRangeCount: number;
  /** Una entrada por escena explícita; null separa ausencia de evidencia de evidencia recortada. */
  readonly scenes: readonly LiterarySceneEventEvidenceScene[];
}
export interface LiterarySceneEventEvidenceAnalysis {
  readonly explicitSceneCount: number;
  /** Escenas cuya lista fuente superó el límite de cien acontecimientos enlazados. */
  readonly sourceTruncatedSceneCount: number;
  readonly sourceTruncatedSceneIndexes: readonly number[];
  readonly eventCount: number;
  readonly omittedEventCount: number;
  /** Perfiles de acontecimientos ordenados por cobertura, racha, evidencia e ID; máximo cien. */
  readonly profiles: readonly LiterarySceneEventEvidenceProfile[];
}
export interface LiteraryEventLifecycleChangeSummary {
  readonly revision: number;
  readonly previousLabel: string;
  readonly newLabel: string;
  readonly labelChanged: boolean;
  readonly addedParticipantIds: readonly string[];
  readonly removedParticipantIds: readonly string[];
  readonly participantSetChanged: boolean;
  readonly changedBy: string;
  readonly changeReason: string | null;
  readonly changedAt: number;
}
export interface LiteraryEventLifecycleProfile {
  readonly eventId: string;
  readonly currentLabel: string;
  /** Participantes de la ficha vigente; no se obtienen de las menciones del texto. */
  readonly currentParticipantIds: readonly string[];
  readonly latestRecordedLabel: string;
  readonly latestRecordedParticipantIds: readonly string[];
  /** false distingue una ficha vigente divergente de la última instantánea versionada. */
  readonly currentStateMatchesLatestRevision: boolean;
  readonly latestRevision: number;
  readonly transitionCount: number;
  readonly labelChangeCount: number;
  readonly participantSetChangeCount: number;
  /** Se exponen las cien transiciones más recientes como máximo, en orden ascendente. */
  readonly changes: readonly LiteraryEventLifecycleChangeSummary[];
  readonly changesTruncated: boolean;
}
export interface LiteraryEventLifecycleAnalysis {
  readonly eventCount: number;
  readonly totalTransitionCount: number;
  readonly omittedEventCount: number;
  /** Perfiles ordenados por cantidad de transiciones e ID; máximo cien. */
  readonly profiles: readonly LiteraryEventLifecycleProfile[];
}

export interface LiterarySceneEventSequenceStep {
  /** Posición 1-based dentro de una ventana de escenas contiguas. */
  readonly sceneOffset: number;
  /** IDs ordenados de forma estable; una lista vacía significa que no hubo vínculo conocido. */
  readonly eventIds: readonly string[];
}
export interface LiterarySceneEventSequenceInstance {
  readonly fromSceneIndex: number;
  readonly toSceneIndex: number;
}
export interface LiterarySceneEventSequenceMotif {
  readonly sceneCount: 2 | 3;
  /** Firma exacta de IDs por posición; no atribuye orden a los acontecimientos dentro de una escena. */
  readonly sceneSequence: readonly LiterarySceneEventSequenceStep[];
  readonly occurrenceCount: number;
  /** Ventanas observadas; se exponen como máximo veinte instancias. */
  readonly instances: readonly LiterarySceneEventSequenceInstance[];
  readonly instancesTruncated: boolean;
}
export interface LiterarySceneEventSequenceMotifAnalysis {
  readonly explicitSceneCount: number;
  /** Todas las ventanas contiguas posibles de dos o tres escenas. */
  readonly candidateWindowCount: number;
  /** Ventanas con evidencia visible y sin escenas fuente truncadas. */
  readonly analyzedWindowCount: number;
  /** Ventanas sin ningún acontecimiento enlazado entre sus escenas. */
  readonly emptyWindowCount: number;
  /** Ventanas descartadas porque al menos una escena superó cien vínculos. */
  readonly sourceTruncatedWindowCount: number;
  readonly motifCount: number;
  readonly omittedMotifCount: number;
  /** Firmas exactas repetidas en al menos dos ventanas; máximo cincuenta. */
  readonly motifs: readonly LiterarySceneEventSequenceMotif[];
}
export type LiterarySceneCharacterContinuityStatus =
  | "mentioned-in-both-scenes"
  | "not-mentioned-in-next-scene"
  | "mentioned-only-in-next-scene";
export interface LiterarySceneCharacterContinuitySignal {
  readonly entityId: string;
  readonly status: LiterarySceneCharacterContinuityStatus;
  readonly previousMentions: readonly LiteraryAnalysisOccurrence[];
  readonly nextMentions: readonly LiteraryAnalysisOccurrence[];
}
export type LiterarySceneEventContinuityStatus =
  | "evidence-in-both-scenes"
  | "evidence-only-in-previous-scene"
  | "evidence-only-in-next-scene";
export interface LiterarySceneEventContinuitySignal {
  readonly eventId: string;
  readonly label: string;
  readonly status: LiterarySceneEventContinuityStatus;
  readonly previousEvidence: readonly LiteraryAnalysisOccurrence[];
  readonly nextEvidence: readonly LiteraryAnalysisOccurrence[];
}
export type LiterarySceneEventParticipantMentionStatus =
  | "mentioned-in-both-scenes"
  | "mentioned-only-in-previous-scene"
  | "mentioned-only-in-next-scene"
  | "not-mentioned-in-either-linked-scene"
  | "no-event-evidence-in-previous-scene"
  | "no-event-evidence-in-next-scene"
  | "source-truncated-in-previous-scene"
  | "source-truncated-in-next-scene";
export interface LiterarySceneEventParticipantMentionTransition {
  readonly entityId: string;
  /** null indica que el acontecimiento no tiene vínculo verificable en esa escena. */
  readonly previousMentionedByName: boolean | null;
  readonly nextMentionedByName: boolean | null;
  readonly status: LiterarySceneEventParticipantMentionStatus;
}
export type LiterarySceneEventAssociationStatus =
  | "evidence-in-both-scenes"
  | "evidence-only-in-previous-scene"
  | "evidence-only-in-next-scene"
  | "source-truncated-in-previous-scene"
  | "source-truncated-in-next-scene";
export interface LiterarySceneEventAssociationTransition {
  readonly fromSceneIndex: number;
  readonly toSceneIndex: number;
  readonly eventId: string;
  readonly label: string;
  readonly status: LiterarySceneEventAssociationStatus;
  /** null indica que la ausencia de vínculo no puede determinarse por truncamiento fuente. */
  readonly previousEvidenceRangeCount: number | null;
  readonly nextEvidenceRangeCount: number | null;
  /** Delta siguiente menos anterior; null si alguna de las dos cantidades es desconocida. */
  readonly evidenceRangeCountDelta: number | null;
  readonly participants: readonly LiterarySceneEventParticipantMentionTransition[];
}
export interface LiterarySceneContinuityTransition {
  readonly fromSceneIndex: number;
  readonly toSceneIndex: number;
  readonly characterSignals: readonly LiterarySceneCharacterContinuitySignal[];
  readonly eventSignals: readonly LiterarySceneEventContinuitySignal[];
}
export interface LiteraryCharacterCoMentionPattern {
  /** IDs de dos personajes conocidos, ordenados de forma estable. */
  readonly characterIds: readonly [string, string];
  readonly sharedSceneCount: number;
  readonly sceneIndexes: readonly number[];
}
export interface LiteraryCharacterMentionCountByScene {
  readonly sceneIndex: number;
  readonly sceneWordCount: number;
  readonly mentionCount: number;
  /** Menciones literales por cada 1.000 palabras de esta escena. */
  readonly mentionRatePer1000Words: number;
}
export interface LiteraryCharacterMentionDistribution {
  readonly entityId: string;
  readonly canonicalName: string;
  /** Total de coincidencias literales, incluso cuando se limitan las ocurrencias de evidencia. */
  readonly totalMentionCount: number;
  /** Palabras de todas las escenas explícitas, incluidas las escenas sin mención del personaje. */
  readonly totalSceneWordCount: number;
  /** Total de menciones por cada 1.000 palabras de todas las escenas explícitas. */
  readonly mentionRatePer1000Words: number;
  /** Serie completa por escena, con ceros explícitos y tasa normalizada; no son muestras de offsets. */
  readonly mentionCountByScene: readonly LiteraryCharacterMentionCountByScene[];
  /** Escenas explícitas con al menos una mención literal no ambigua. */
  readonly sceneIndexes: readonly number[];
  readonly sceneCount: number;
  readonly firstSceneIndex: number;
  readonly lastSceneIndex: number;
  /** Escenas intermedias sin una mención literal detectada; no equivale a ausencia del personaje. */
  readonly interveningSceneCount: number;
  /** Mayor número de escenas explícitas consecutivas con mención literal. */
  readonly longestConsecutiveSceneRun: number;
  /** Fracción de escenas explícitas del fragmento con mención literal. */
  readonly sceneCoverageRatio: number;
}
export interface LiteraryCharacterMentionDistributionAnalysis {
  readonly explicitSceneCount: number;
  /** Identidades con al menos una mención literal no ambigua en las escenas analizadas. */
  readonly characterCount: number;
  readonly omittedCharacterCount: number;
  /** Perfiles ordenados por cobertura, racha consecutiva y, finalmente, ID estable. */
  readonly characters: readonly LiteraryCharacterMentionDistribution[];
}
export interface LiteraryEventDependencyCandidate {
  /** Identificador estable dentro de la revisión analizada. */
  readonly candidateId: string;
  readonly firstEventId: string;
  readonly firstEventLabel: string;
  readonly secondEventId: string;
  readonly secondEventLabel: string;
  readonly causeEventId: string;
  readonly consequenceEventId: string;
  /** IDs declarados por el proyecto para cada acontecimiento y su intersección explícita. */
  readonly firstEventParticipantIds: readonly string[];
  readonly secondEventParticipantIds: readonly string[];
  readonly sharedParticipantIds: readonly string[];
  readonly direction: "cause-before-consequence" | "consequence-before-cause";
  readonly connector: string;
  readonly connectorOccurrence: LiteraryAnalysisOccurrence;
  readonly firstEventOccurrence: LiteraryAnalysisOccurrence;
  readonly secondEventOccurrence: LiteraryAnalysisOccurrence;
  readonly sentenceOccurrence: LiteraryAnalysisOccurrence;
  readonly sceneIndex: number | null;
  readonly status: "candidate-needs-review";
}
export interface LiteraryEventDependencyAnalysis {
  readonly evidenceAnchorCount: number;
  readonly omittedEvidenceAnchorCount: number;
  readonly candidateCount: number;
  readonly omittedCandidateCount: number;
  /** Candidatos basados en conectores causales literales; máximo cincuenta. */
  readonly candidates: readonly LiteraryEventDependencyCandidate[];
}

export type LiteraryCharacterCausalRole =
  | "cause-event-participant"
  | "consequence-event-participant"
  | "both-events-participant";
export interface LiteraryCharacterCausalRelation {
  readonly candidateId: string;
  readonly characterRole: LiteraryCharacterCausalRole;
  readonly candidate: LiteraryEventDependencyCandidate;
}
export interface LiteraryCharacterTrajectorySceneSnapshot {
  readonly sceneIndex: number;
  readonly evidenceStatus: "documented" | "no-known-evidence" | "unknown-due-to-truncation";
  readonly mentionStatus: LiteraryCharacterSceneMentionStatus;
  readonly participationStatus: LiteraryCharacterSceneParticipationStatus;
  readonly eventIds: readonly string[];
  readonly eventEvidenceRangeCount: number;
  readonly attributeValues: readonly {
    readonly attribute: NarrativeAssertion["attribute"];
    readonly values: readonly (string | number)[];
    readonly assertionCount: number;
    readonly assertionIds: readonly string[];
    readonly status: "single-value" | "multiple-values";
  }[];
  readonly causalCandidateIds: readonly string[];
  readonly relationshipIds: readonly string[];
  readonly documentedDecisionIdeaIds: readonly string[];
  readonly incompleteReasons: readonly (
    | "mention-truncation" | "event-truncation"
    | "relationship-evidence-truncation" | "decision-evidence-truncation"
  )[];
}
export interface LiteraryCharacterProjectEventTimelineEvidence {
  readonly eventId: string;
  readonly eventLabel: string;
  readonly documentId: string;
  readonly revision: number;
  readonly occurrence: LiteraryAnalysisOccurrence;
  readonly excerpt: string;
}
export interface LiteraryCharacterProjectEventTimelinePoint {
  readonly timelineTrackId: string | null;
  readonly basis: NarrativeTimeReference["basis"];
  readonly precision: NarrativeTimeReference["precision"];
  readonly orderValue: number;
  readonly rawTimeReferences: readonly string[];
  readonly eventCount: number;
  readonly eventIds: readonly string[];
  readonly omittedEventIdCount: number;
  readonly documentIds: readonly string[];
  readonly evidenceCount: number;
  readonly omittedEvidenceCount: number;
  readonly evidenceSamples: readonly LiteraryCharacterProjectEventTimelineEvidence[];
  readonly evidenceTruncated: boolean;
}
export interface LiteraryCharacterProjectEventTimelineTransition {
  readonly timelineTrackId: string | null;
  readonly basis: NarrativeTimeReference["basis"];
  readonly precision: NarrativeTimeReference["precision"];
  readonly fromOrderValue: number;
  readonly toOrderValue: number;
  readonly previousEventCount: number;
  readonly nextEventCount: number;
  readonly previousEventIds: readonly string[];
  readonly nextEventIds: readonly string[];
}
export interface LiteraryCharacterProjectEventTimeline {
  readonly sourceEventCount: number;
  readonly timedEventCount: number;
  readonly untimedEventCount: number;
  readonly unverifiedEventCount: number;
  readonly staleEventCount: number;
  readonly staleEvidenceCount: number;
  readonly pointCount: number;
  readonly omittedPointCount: number;
  readonly transitionCount: number;
  readonly omittedTransitionCount: number;
  readonly points: readonly LiteraryCharacterProjectEventTimelinePoint[];
  readonly transitions: readonly LiteraryCharacterProjectEventTimelineTransition[];
}

export interface LiteraryCharacterRelationshipEvidence {
  readonly documentId: string;
  readonly revision: number;
  readonly occurrence: LiteraryAnalysisOccurrence;
  readonly excerpt: string;
}
export interface LiteraryCharacterRelationshipProfile {
  readonly relationId: string;
  readonly direction: "outgoing" | "incoming" | "self";
  readonly otherEntityId: string;
  readonly otherCharacterName: string | null;
  readonly relationType: string;
  readonly evidenceStatus: "active-evidence" | "stale-only" | "no-evidence";
  readonly evidenceCount: number;
  readonly staleEvidenceCount: number;
  readonly evidenceSamples: readonly LiteraryCharacterRelationshipEvidence[];
  readonly evidenceTruncated: boolean;
  /** Las relaciones narrativas aún no disponen de un historial de transiciones versionado. */
  readonly historyStatus: "current-record-only";
}
export interface LiteraryCharacterDocumentedIdeaReference {
  readonly ideaId: string;
  /** La referencia puede apuntar a una idea omitida del snapshot, no necesariamente inexistente. */
  readonly resolution: "included-in-analysis-snapshot" | "not-in-analysis-snapshot";
}
export interface LiteraryCharacterDocumentedDecision {
  readonly ideaId: string;
  readonly text: string;
  readonly status: NarrativeIdea["status"];
  readonly originDocumentId: string;
  readonly sourceProjectName: string;
  readonly relatedIdeaIds: readonly string[];
  readonly relatedIdeaReferences: readonly LiteraryCharacterDocumentedIdeaReference[];
  readonly evidenceCount: number;
  readonly staleEvidenceCount: number;
  readonly evidenceSamples: readonly LiteraryCharacterRelationshipEvidence[];
  readonly evidenceTruncated: boolean;
  readonly statusHistory: readonly NarrativeIdeaStatusChange[];
  readonly omittedStatusHistoryCount: number;
  /** Cambios de estado registrados explícitamente con reason=writer. */
  readonly writerDecisionCount: number;
}
export interface LiteraryCharacterNarrativeTrajectory {
  readonly entityId: string;
  readonly canonicalName: string;
  readonly mentionSceneCount: number;
  readonly eventParticipationSceneCount: number;
  readonly attributeAssertionCount: number;
  readonly causalCandidateCount: number;
  readonly writerDecisionCount: number;
  readonly observedSceneIndexes: readonly number[];
  readonly incompleteSceneIndexes: readonly number[];
  readonly attributes: readonly LiteraryCharacterAttributeProfile[];
  readonly relationships: readonly LiteraryCharacterRelationshipProfile[];
  readonly documentedDecisions: readonly LiteraryCharacterDocumentedDecision[];
  readonly eventParticipation: readonly LiteraryCharacterEventEvidenceProfile[];
  readonly projectEventTimeline: LiteraryCharacterProjectEventTimeline;
  readonly causalRelations: readonly LiteraryCharacterCausalRelation[];
  readonly scenes: readonly LiteraryCharacterTrajectorySceneSnapshot[];
}
export interface LiteraryCharacterNarrativeTrajectoryAnalysis {
  readonly explicitSceneCount: number;
  readonly catalogCharacterCount: number;
  readonly profileCount: number;
  readonly omittedCharacterCount: number;
  readonly sourceTruncatedSceneCount: number;
  readonly sourceTruncatedSceneIndexes: readonly number[];
  readonly omittedAttributeProfileCount: number;
  readonly omittedEventAssociationCount: number;
  readonly omittedCausalCandidateCount: number;
  readonly omittedProjectEventCount: number;
  readonly relationshipRecordCount: number;
  readonly omittedRelationshipCount: number;
  readonly linkedIdeaCount: number;
  /** Enlaces entre ideas del catálogo recibido, aunque el destino no esté en este snapshot. */
  readonly ideaReferenceCount: number;
  readonly resolvedIdeaReferenceCount: number;
  readonly notIncludedIdeaReferenceCount: number;
  readonly omittedIdeaCount: number;
  readonly causalCandidateCount: number;
  readonly trajectories: readonly LiteraryCharacterNarrativeTrajectory[];
}

export interface LiteraryIdeaGraphNode {
  readonly ideaId: string;
  readonly status: NarrativeIdea["status"];
  /** Consistencia entre el estado actual y el último registro visible; unknown si falta historial o está truncado. */
  readonly currentStatusHistoryConsistency: "consistent" | "mismatch" | "unknown";
  /** Historial visible de estados; puede estar acotado por omittedStatusHistoryCount. */
  readonly statusHistory: readonly NarrativeIdeaStatusChange[];
  readonly omittedStatusHistoryCount: number;
  readonly writerDecisionCount: number;
  /** Cambios de estado distinguibles en el historial visible; es un mínimo si hay registros omitidos. */
  readonly observedStatusTransitionCount: number;
  /** Retornos a un estado ya observado anteriormente; mínimo si el historial está truncado. */
  readonly statusReversalCount: number;
  /** Pares adyacentes con marcas temporales conocidas que retroceden en el tiempo. */
  readonly nonMonotonicStatusTimestampCount: number;
  /** Pares adyacentes del historial con ambas marcas temporales conocidas. */
  readonly comparableStatusTimestampPairCount: number;
  /** Pares adyacentes que no pueden compararse porque falta alguna marca temporal. */
  readonly uncomparableStatusTimestampPairCount: number;
  /** Registros iniciales visibles; mínimo si el historial fue truncado. */
  readonly observedInitialStatusRecordCount: number;
  /** Cambios visibles atribuidos explícitamente al escritor. */
  readonly observedWriterStatusChangeCount: number;
  /** Cambios visibles atribuidos explícitamente a una revisión del texto. */
  readonly observedTextRevisionStatusChangeCount: number;
  /** Marca temporal conocida más antigua del historial visible; null si ninguna está disponible. */
  readonly earliestKnownStatusChangeAt: number | null;
  /** Marca temporal conocida más reciente del historial visible; null si ninguna está disponible. */
  readonly latestKnownStatusChangeAt: number | null;
  /** Amplitud entre la primera y última marca conocida, sin asumir orden cronológico. */
  readonly knownStatusHistorySpanMs: number | null;
  /** Evidencia no obsoleta registrada para esta idea, sin limitarse al capítulo abierto. */
  readonly activeEvidenceCount: number;
  readonly staleEvidenceCount: number;
  /** Entradas desde ideas incluidas en el snapshot actual. */
  readonly incomingReferenceCount: number;
  /** Salidas cuyo destino también está incluido en el snapshot actual. */
  readonly includedOutgoingReferenceCount: number;
  /** Salidas explícitas cuyo destino no está incluido en el snapshot actual. */
  readonly notIncludedOutgoingReferenceCount: number;
}
/** Referencia explícita y resultado de resolver su destino contra el alcance de catálogo declarado. */
export interface LiteraryIdeaGraphReference {
  readonly fromIdeaId: string;
  readonly toIdeaId: string;
  readonly resolution: "included-in-snapshot" | "not-in-snapshot" | "missing-from-project";
}
export interface LiteraryIdeaGraphCycle {
  /** Componente fuertemente conexo; cada idea puede alcanzar a las demás. */
  readonly ideaIds: readonly string[];
}
export interface LiteraryIdeaGraphWeakComponent {
  /** ID mínimo que identifica de forma estable este grupo dentro del snapshot. */
  readonly representativeIdeaId: string;
  /** Ideas conectadas al ignorar la dirección de sus referencias explícitas. */
  readonly ideaIds: readonly string[];
}
export interface LiteraryIdeaGraphStatusProfile {
  readonly status: NarrativeIdea["status"];
  readonly ideaCount: number;
  /** Marca temporal conocida más antigua entre los historiales visibles del perfil. */
  readonly earliestKnownStatusChangeAt: number | null;
  /** Marca temporal conocida más reciente entre los historiales visibles del perfil. */
  readonly latestKnownStatusChangeAt: number | null;
  /** Amplitud temporal conjunta entre las fechas conocidas del perfil. */
  readonly knownStatusHistorySpanMs: number | null;
  /** Ideas sin entradas desde otros nodos del snapshot; puede haber fuentes omitidas. */
  readonly sourceIdeaCount: number;
  readonly terminalWithinSnapshotIdeaCount: number;
  readonly isolatedWithinSnapshotIdeaCount: number;
  /** Suma de entradas desde orígenes incluidos en el snapshot. */
  readonly incomingReferenceCount: number;
  readonly includedOutgoingReferenceCount: number;
  readonly notIncludedOutgoingReferenceCount: number;
  /** Registros visibles del historial, incluido el estado inicial cuando está disponible. */
  readonly statusHistoryRecordCount: number;
  /** Ideas cuyo último estado visible coincide con la etiqueta actual. */
  readonly statusHistoryConsistentIdeaCount: number;
  /** Ideas cuya etiqueta actual contradice el último estado visible. */
  readonly statusHistoryMismatchIdeaCount: number;
  /** Ideas sin historial suficiente para validar la etiqueta actual. */
  readonly statusHistoryConsistencyUnknownIdeaCount: number;
  readonly omittedStatusHistoryCount: number;
  /** Transiciones explícitas registradas por el escritor. */
  readonly writerDecisionCount: number;
  /** Suma de cambios de estado distinguibles en los historiales visibles del perfil. */
  readonly observedStatusTransitionCount: number;
  /** Suma de retornos a estados previamente observados en los historiales visibles. */
  readonly statusReversalCount: number;
  /** Suma de retrocesos temporales observables en los historiales del perfil. */
  readonly nonMonotonicStatusTimestampCount: number;
  /** Suma de pares adyacentes con ambas marcas temporales conocidas. */
  readonly comparableStatusTimestampPairCount: number;
  /** Suma de pares adyacentes sin marcas temporales suficientes para compararlos. */
  readonly uncomparableStatusTimestampPairCount: number;
  /** Registros iniciales visibles agregados por estado actual. */
  readonly observedInitialStatusRecordCount: number;
  /** Cambios visibles atribuidos al escritor agregados por estado actual. */
  readonly observedWriterStatusChangeCount: number;
  /** Cambios visibles atribuidos a revisiones del texto agregados por estado actual. */
  readonly observedTextRevisionStatusChangeCount: number;
  readonly activeEvidenceCount: number;
  readonly staleEvidenceCount: number;
  readonly ideasWithActiveEvidenceCount: number;
  readonly ideasWithStaleEvidenceCount: number;
  readonly ideasWithoutActiveEvidenceCount: number;
}
export interface LiteraryIdeaLexicalResonance {
  readonly leftIdeaId: string;
  readonly rightIdeaId: string;
  readonly leftTermCount: number;
  readonly rightTermCount: number;
  readonly sharedTermCount: number;
  /** Intersección dividida por la unión de términos literales normalizados. */
  readonly jaccardSimilarity: number;
  /** Jaccard ponderado por frecuencias: suma de mínimos dividida por suma de máximos. */
  readonly frequencyWeightedJaccardSimilarity: number;
  /** Coseno entre vectores de frecuencias de términos normalizados. */
  readonly frequencyCosineSimilarity: number;
  /** Proporción del vocabulario distinto de cada idea presente también en la otra. */
  readonly leftVocabularyCoverage: number;
  readonly rightVocabularyCoverage: number;
  /** Proporción de las apariciones de cada idea cubiertas por frecuencias compartidas. */
  readonly leftFrequencyCoverage: number;
  readonly rightFrequencyCoverage: number;
  /** Intersección dividida por el tamaño del vocabulario menor. */
  readonly overlapCoefficient: number;
  /** Muestra ordenada de términos compartidos; no implica equivalencia semántica. */
  readonly sharedTerms: readonly string[];
  /** Frecuencia literal de cada término compartido en ambos textos; no representa peso semántico. */
  readonly sharedTermFrequencies: readonly {
    readonly term: string;
    readonly leftFrequency: number;
    readonly rightFrequency: number;
  }[];
  readonly omittedSharedTermCount: number;
}
export interface LiteraryIdeaLexicalResonanceAnalysis {
  readonly inputIdeaCount: number;
  readonly analyzedIdeaCount: number;
  readonly ideasWithoutTextCount: number;
  readonly omittedTextBudgetIdeaCount: number;
  readonly tokenizedTextUnitCount: number;
  readonly indexedTermCount: number;
  readonly omittedDistinctTermCount: number;
  readonly ignoredHighFrequencyTermCount: number;
  readonly minimumSharedTermCount: number;
  readonly maxTermDocumentFrequency: number;
  readonly candidatePairCount: number;
  readonly omittedCandidatePairCount: number;
  /** Candidatos ordenados por cantidad de términos compartidos y Jaccard; máximo cien. */
  readonly resonances: readonly LiteraryIdeaLexicalResonance[];
}
export interface LiteraryIdeaGraphAnalysis {
  /** Coincidencias léxicas entre textos de ideas; nunca crean vínculos del grafo. */
  readonly lexicalResonances: LiteraryIdeaLexicalResonanceAnalysis;
  /** Catálogo de entrada completo del proyecto o compatibilidad con el subconjunto ligado a personajes. */
  readonly catalogScope: "project" | "character-linked-fallback";
  /** true solo con catálogo de proyecto y sin ideas omitidas; el modo heredado nunca es exhaustivo. */
  readonly projectCatalogComplete: boolean;
  /** Nodos del snapshot recibido; el catálogo no transferido se informa aparte. */
  readonly ideaCount: number;
  /** Distribución estructural de los nodos por estado editorial explícito. */
  readonly statusProfiles: readonly LiteraryIdeaGraphStatusProfile[];
  /** Resumen global de sincronización entre etiquetas actuales e historiales visibles. */
  readonly statusHistoryConsistency: {
    readonly consistentIdeaCount: number;
    readonly mismatchIdeaCount: number;
    readonly unknownIdeaCount: number;
    readonly verifiableIdeaCount: number;
    readonly verificationCoverage: number;
  };
  /** Ideas omitidas del alcance indicado por catalogScope. */
  readonly omittedIdeaCount: number;
  /** Aristas declaradas por nodos incluidos en el snapshot, antes de limitar las muestras. */
  readonly referenceCount: number;
  /** Aristas cuyos dos extremos pertenecen al snapshot. */
  readonly includedReferenceCount: number;
  /** Aristas cuyo destino no está incluido, por omisión o ausencia del catálogo. */
  readonly notIncludedReferenceCount: number;
  /** Subconjunto sin destino, solo cuando projectCatalogComplete es true. */
  readonly missingFromProjectReferenceCount: number;
  /** Pares de aristas inversas explícitas entre ideas incluidas en el snapshot. */
  readonly reciprocalReferencePairCount: number;
  /** Referencias explícitas de una idea hacia sí misma; también forman ciclos unitarios. */
  readonly selfReferenceCount: number;
  /** Nodos sin referencias entrantes desde el snapshot; no contempla fuentes omitidas. */
  readonly sourceNodeCount: number;
  /** Nodos sin salidas hacia otros nodos incluidos; pueden conservar salidas externas. */
  readonly terminalWithinSnapshotNodeCount: number;
  /** Nodos aislados únicamente respecto del conjunto de ideas incluido. */
  readonly isolatedWithinSnapshotNodeCount: number;
  /** Componentes débilmente conexos dentro del snapshot; ignoran la dirección y no incluyen nodos omitidos. */
  readonly weakComponentCount: number;
  /** Componentes del snapshot no visibles por el límite de muestras. */
  readonly omittedWeakComponentCount: number;
  readonly largestWeakComponentSize: number;
  readonly weakComponents: readonly LiteraryIdeaGraphWeakComponent[];
  /** Componentes cíclicos detectados dentro del snapshot. */
  readonly cycleCount: number;
  /** Componentes cíclicos del snapshot no visibles por el límite de muestras. */
  readonly omittedCycleCount: number;
  readonly referenceSampleCount: number;
  readonly omittedReferenceSampleCount: number;
  readonly referencesTruncated: boolean;
  /** Todos los nodos del snapshot actual, ordenados por ID. */
  readonly nodes: readonly LiteraryIdeaGraphNode[];
  /** Muestra acotada y determinista de referencias explícitas; máximo 5.000. */
  readonly references: readonly LiteraryIdeaGraphReference[];
  /** Componentes cíclicos; máximo 100. */
  readonly cycles: readonly LiteraryIdeaGraphCycle[];
}

export interface LiteraryCharacterAttributeAssertionEvidence {
  readonly assertionId: string;
  readonly value: string | number;
  readonly documentId: string;
  readonly revision: number;
  readonly occurrence: LiteraryAnalysisOccurrence;
  readonly excerpt: string;
  readonly timeReference?: NarrativeAssertion["timeReference"];
}
export interface LiteraryCharacterAttributeSceneSnapshot {
  readonly sceneIndex: number;
  readonly assertionCount: number;
  readonly distinctValueCount: number;
  readonly values: readonly (string | number)[];
  readonly assertions: readonly LiteraryCharacterAttributeAssertionEvidence[];
  readonly evidenceTruncated: boolean;
}
export type LiteraryCharacterAttributeTransitionStatus =
  | "unchanged-value" | "changed-value" | "multiple-values-in-scene";
export interface LiteraryCharacterAttributeTransition {
  readonly fromSceneIndex: number;
  readonly toSceneIndex: number;
  readonly interveningSceneCount: number;
  readonly status: LiteraryCharacterAttributeTransitionStatus;
  readonly previousValues: readonly (string | number)[];
  readonly nextValues: readonly (string | number)[];
  readonly previousAssertionIds: readonly string[];
  readonly nextAssertionIds: readonly string[];
}
export interface LiteraryCharacterAttributeTimelinePoint {
  readonly basis: NonNullable<NarrativeAssertion["timeReference"]>["basis"];
  readonly precision: NonNullable<NarrativeAssertion["timeReference"]>["precision"];
  readonly orderValue: number;
  readonly rawTimeReferences: readonly string[];
  readonly assertionCount: number;
  readonly distinctValueCount: number;
  readonly values: readonly (string | number)[];
  readonly documentIds: readonly string[];
  readonly assertions: readonly LiteraryCharacterAttributeAssertionEvidence[];
  readonly evidenceTruncated: boolean;
}
export type LiteraryCharacterAttributeTimelineTransitionStatus =
  | "unchanged-value" | "changed-value" | "multiple-values-at-same-time";
export interface LiteraryCharacterAttributeTimelineTransition {
  readonly basis: NonNullable<NarrativeAssertion["timeReference"]>["basis"];
  readonly precision: NonNullable<NarrativeAssertion["timeReference"]>["precision"];
  readonly fromOrderValue: number;
  readonly toOrderValue: number;
  readonly fromTimeReferences: readonly string[];
  readonly toTimeReferences: readonly string[];
  readonly status: LiteraryCharacterAttributeTimelineTransitionStatus;
  readonly previousValues: readonly (string | number)[];
  readonly nextValues: readonly (string | number)[];
  readonly previousAssertionIds: readonly string[];
  readonly nextAssertionIds: readonly string[];
}
export interface LiteraryCharacterAttributeProfile {
  readonly entityId: string;
  readonly canonicalName: string;
  readonly attribute: NarrativeAssertion["attribute"];
  readonly assertionCount: number;
  readonly sceneCount: number;
  readonly firstSceneIndex: number;
  readonly lastSceneIndex: number;
  readonly changedValueTransitionCount: number;
  readonly multipleValueSceneIndexes: readonly number[];
  readonly scenes: readonly LiteraryCharacterAttributeSceneSnapshot[];
  readonly transitions: readonly LiteraryCharacterAttributeTransition[];
  /** Afirmaciones con referencias temporales comparables, incluso desde otros capítulos. */
  readonly projectTimelineAssertionCount: number;
  readonly projectTimelinePointCount: number;
  readonly projectTimeline: readonly LiteraryCharacterAttributeTimelinePoint[];
  readonly projectTimelineTransitions: readonly LiteraryCharacterAttributeTimelineTransition[];
}
export interface LiteraryCharacterAttributeEvolutionAnalysis {
  readonly explicitSceneCount: number;
  readonly sourceAssertionCount: number;
  readonly currentRevisionAssertionCount: number;
  readonly staleAssertionCount: number;
  readonly outOfScopeAssertionCount: number;
  readonly unmappedCurrentAssertionCount: number;
  readonly profileCount: number;
  readonly omittedProfileCount: number;
  readonly profiles: readonly LiteraryCharacterAttributeProfile[];
}

export type LiteraryCharacterSceneMentionStatus =
  | "mentioned-by-known-name"
  | "not-mentioned-by-known-name"
  | "unknown-due-to-mention-truncation";
export type LiteraryCharacterSceneParticipationStatus =
  | "linked-to-explicit-event-evidence"
  | "not-linked-in-current-evidence"
  | "unknown-due-to-event-truncation";
export interface LiteraryCharacterSceneEvidenceSnapshot {
  readonly sceneIndex: number;
  readonly mentionStatus: LiteraryCharacterSceneMentionStatus;
  readonly mentionCount: number;
  readonly participationStatus: LiteraryCharacterSceneParticipationStatus;
  readonly eventIds: readonly string[];
  readonly eventEvidenceRangeCount: number;
  readonly eventEvidenceSamplesTruncated: boolean;
  readonly characterMentionsTruncated: boolean;
  readonly eventLinksTruncated: boolean;
}
export interface LiteraryCharacterSceneEvidenceProfile {
  readonly entityId: string;
  readonly canonicalName: string;
  readonly totalMentionCount: number;
  readonly mentionSceneCount: number;
  readonly mentionSceneIndexes: readonly number[];
  readonly firstMentionSceneIndex: number | null;
  readonly lastMentionSceneIndex: number | null;
  readonly eventParticipationSceneCount: number;
  readonly eventParticipationSceneIndexes: readonly number[];
  readonly firstEventParticipationSceneIndex: number | null;
  readonly lastEventParticipationSceneIndex: number | null;
  readonly totalEventEvidenceRangeCount: number;
  readonly incompleteSceneCount: number;
  /** Una instantánea por escena explícita, incluidos ceros y estados desconocidos. */
  readonly scenes: readonly LiteraryCharacterSceneEvidenceSnapshot[];
}
export interface LiteraryCharacterSceneEvidenceAnalysis {
  readonly explicitSceneCount: number;
  readonly sourceTruncatedSceneCount: number;
  readonly sourceTruncatedSceneIndexes: readonly number[];
  readonly characterCount: number;
  readonly omittedCharacterCount: number;
  /** Perfiles ordenados por participación, cobertura nominal, menciones e ID; máximo cien. */
  readonly profiles: readonly LiteraryCharacterSceneEvidenceProfile[];
}

export interface LiterarySceneCadenceTransition {
  readonly fromSceneIndex: number;
  readonly toSceneIndex: number;
  readonly sentenceBandCountDelta: {
    readonly short: number;
    readonly medium: number;
    readonly long: number;
  };
  readonly bandTransitionCountDelta: LiterarySceneCadenceProfile["bandTransitionCounts"];
  readonly patternCountDelta: number;
  readonly patternTypeCountDelta: LiterarySceneCadenceProfile["patternTypeCounts"];
  readonly newlyDetectedPatternTypes: readonly LiterarySceneCadencePatternType[];
  readonly noLongerDetectedPatternTypes: readonly LiterarySceneCadencePatternType[];
}
export interface LiterarySceneCadenceMotifInstance {
  readonly sceneIndex: number;
  readonly fromSentenceIndex: number;
  readonly toSentenceIndex: number;
  readonly sentenceWordCounts: readonly number[];
  readonly occurrences: readonly LiteraryAnalysisOccurrence[];
  readonly evidenceTruncated: boolean;
}
export interface LiterarySceneCadenceMotif {
  readonly patternType: LiterarySceneCadencePatternType;
  readonly lengthBands: readonly LiterarySentenceLengthBand[];
  readonly sceneIndexes: readonly number[];
  readonly sceneCount: number;
  readonly occurrenceCount: number;
  readonly instances: readonly LiterarySceneCadenceMotifInstance[];
  readonly instancesTruncated: boolean;
}
export interface LiterarySceneCadenceMotifAnalysis {
  /** Patrones detectados antes de aplicar el límite de 20 muestras por escena. */
  readonly candidatePatternCount: number;
  readonly sampledPatternCount: number;
  readonly omittedPatternCount: number;
  /** Firmas idénticas presentes en al menos dos escenas explícitas distintas. */
  readonly motifCount: number;
  /** Motivos ordenados por cobertura de escenas y frecuencia; se devuelven como máximo 20. */
  readonly motifs: readonly LiterarySceneCadenceMotif[];
}
export interface LiterarySceneRhythmTransition {
  readonly fromSceneIndex: number;
  readonly toSceneIndex: number;
  readonly previousRhythmProfile: LiteraryRhythmProfile;
  readonly nextRhythmProfile: LiteraryRhythmProfile;
  readonly rhythmProfileChanged: boolean;
  readonly previousAverageWordsPerSentence: number;
  readonly nextAverageWordsPerSentence: number;
  readonly averageWordsPerSentenceDelta: number;
  readonly previousSentenceCount: number;
  readonly nextSentenceCount: number;
  readonly sentenceCountDelta: number;
  readonly previousTransitionCount: number;
  readonly nextTransitionCount: number;
  readonly transitionCountDelta: number;
}
export interface LiterarySceneVoiceTransition {
  readonly fromSceneIndex: number;
  readonly toSceneIndex: number;
  readonly previousClassification: LiteraryVoiceSignalClassification;
  readonly nextClassification: LiteraryVoiceSignalClassification;
  readonly classificationChanged: boolean;
  /** Diferencia next - previous de conteos de pronombres explícitos fuera del diálogo. */
  readonly countDelta: LiteraryVoiceSignalCounts;
  readonly changedCategories: readonly (keyof LiteraryVoiceSignalCounts)[];
}
export interface LiterarySceneVoiceSnapshot {
  readonly sceneIndex: number;
  readonly classification: LiteraryVoiceSignalClassification;
  readonly counts: LiteraryVoiceSignalCounts;
  readonly totalSignals: number;
  readonly narrativeWordCount: number;
  /** Conteos normalizados por cada 1.000 palabras fuera del diálogo reconocido. */
  readonly ratesPer1000Words: LiteraryVoiceSignalCounts;
  readonly totalRatePer1000Words: number;
}
export interface LiterarySceneVoiceCategoryCoverage {
  readonly category: keyof LiteraryVoiceSignalCounts;
  readonly occurrences: number;
  readonly scenesWithOccurrences: number;
  /** Fracción entre 0 y 1 de escenas explícitas con al menos una señal de esta categoría. */
  readonly sceneShare: number;
}
export type LiterarySceneVoiceSequencePatternType =
  | "stable-classification-run"
  | "alternating-classification-run";
export interface LiterarySceneVoiceSequencePattern {
  readonly patternType: LiterarySceneVoiceSequencePatternType;
  readonly fromSceneIndex: number;
  readonly toSceneIndex: number;
  /** Clasificación explícita por escena, en orden textual. */
  readonly classifications: readonly LiteraryVoiceSignalClassification[];
  /** Instantáneas de las escenas que forman el patrón, incluidas sus tasas y conteos. */
  readonly sceneSnapshots: readonly LiterarySceneVoiceSnapshot[];
}
export interface LiterarySceneVoiceProfile {
  readonly sceneCount: number;
  readonly totalSignals: number;
  readonly totalNarrativeWordCount: number;
  readonly categoryTotals: LiteraryVoiceSignalCounts;
  /** Conteos acumulados normalizados por cada 1.000 palabras fuera del diálogo reconocido. */
  readonly categoryRatesPer1000Words: LiteraryVoiceSignalCounts;
  readonly totalRatePer1000Words: number;
  readonly classificationSceneCounts: {
    readonly firstPerson: number;
    readonly secondPerson: number;
    readonly thirdPerson: number;
    readonly mixed: number;
    readonly undetermined: number;
  };
  readonly categoryCoverage: readonly LiterarySceneVoiceCategoryCoverage[];
  /** Instantáneas en orden textual; conservan una referencia por índice a explicitScenes. */
  readonly sceneSnapshots: readonly LiterarySceneVoiceSnapshot[];
}
export type LiterarySceneDialogueParagraphClassification = "narrative-only" | "dialogue-only" | "mixed";
export interface LiterarySceneDialogueParagraph {
  readonly paragraphIndex: number;
  readonly classification: LiterarySceneDialogueParagraphClassification;
  readonly wordCount: number;
  readonly dialogueWordCount: number;
  readonly occurrence: LiteraryAnalysisOccurrence;
}
export type LiterarySceneDialogueFlowRunKind = "narrative-only-run" | "dialogue-bearing-run";
export interface LiterarySceneDialogueFlowRun {
  readonly runIndex: number;
  readonly kind: LiterarySceneDialogueFlowRunKind;
  readonly fromParagraphIndex: number;
  readonly toParagraphIndex: number;
  readonly paragraphCount: number;
  readonly narrativeOnlyParagraphCount: number;
  readonly dialogueOnlyParagraphCount: number;
  readonly mixedParagraphCount: number;
  /** Rango UTF-16 absoluto desde el inicio del primer hasta el final del último párrafo del tramo. */
  readonly occurrence: LiteraryAnalysisOccurrence;
}
export interface LiterarySceneDialogueFlowProfile {
  /** Párrafos con al menos una palabra reconocida dentro de la escena. */
  readonly paragraphCount: number;
  readonly classificationCounts: {
    readonly narrativeOnly: number;
    readonly dialogueOnly: number;
    readonly mixed: number;
  };
  /** Párrafos con diálogo reconocido, sean solo diálogo o mixtos. */
  readonly dialogueBearingParagraphCount: number;
  /** Fracción de párrafos con diálogo reconocido respecto de los párrafos con palabras. */
  readonly dialogueBearingParagraphRatio: number;
  /** Transiciones entre clasificaciones de párrafos consecutivos en orden textual. */
  readonly classificationTransitionCounts: {
    readonly narrativeOnlyToNarrativeOnly: number;
    readonly narrativeOnlyToDialogueOnly: number;
    readonly narrativeOnlyToMixed: number;
    readonly dialogueOnlyToNarrativeOnly: number;
    readonly dialogueOnlyToDialogueOnly: number;
    readonly dialogueOnlyToMixed: number;
    readonly mixedToNarrativeOnly: number;
    readonly mixedToDialogueOnly: number;
    readonly mixedToMixed: number;
  };
  readonly classificationChangeCount: number;
  /** Tramos consecutivos que agrupan párrafos narrativos o párrafos con diálogo reconocido. */
  readonly runCount: number;
  readonly dialogueBearingRunCount: number;
  readonly narrativeOnlyRunCount: number;
  readonly longestDialogueBearingRunParagraphs: number;
  readonly longestNarrativeOnlyRunParagraphs: number;
  /** Se exponen como máximo 40 tramos iniciales, calculados sobre todos los párrafos con palabras. */
  readonly runs: readonly LiterarySceneDialogueFlowRun[];
  readonly runsTruncated: boolean;
  /** Se exponen como máximo 40 párrafos iniciales con offsets UTF-16 absolutos. */
  readonly paragraphs: readonly LiterarySceneDialogueParagraph[];
  readonly evidenceTruncated: boolean;
}

export interface LiterarySceneDialogueFlowTransition {
  readonly fromSceneIndex: number;
  readonly toSceneIndex: number;
  readonly previousParagraphCount: number;
  readonly nextParagraphCount: number;
  readonly paragraphCountDelta: number;
  readonly previousDialogueBearingParagraphCount: number;
  readonly nextDialogueBearingParagraphCount: number;
  readonly dialogueBearingParagraphCountDelta: number;
  readonly previousDialogueBearingParagraphRatio: number;
  readonly nextDialogueBearingParagraphRatio: number;
  readonly dialogueBearingParagraphRatioDelta: number;
  readonly classificationCountDelta: {
    readonly narrativeOnly: number;
    readonly dialogueOnly: number;
    readonly mixed: number;
  };
  readonly classificationTransitionCountDelta: LiterarySceneDialogueFlowProfile["classificationTransitionCounts"];
  readonly classificationChangeCountDelta: number;
  readonly previousRunCount: number;
  readonly nextRunCount: number;
  readonly runCountDelta: number;
  readonly previousDialogueBearingRunCount: number;
  readonly nextDialogueBearingRunCount: number;
  readonly dialogueBearingRunCountDelta: number;
  readonly previousNarrativeOnlyRunCount: number;
  readonly nextNarrativeOnlyRunCount: number;
  readonly narrativeOnlyRunCountDelta: number;
  readonly previousLongestDialogueBearingRunParagraphs: number;
  readonly nextLongestDialogueBearingRunParagraphs: number;
  readonly longestDialogueBearingRunParagraphsDelta: number;
  readonly previousLongestNarrativeOnlyRunParagraphs: number;
  readonly nextLongestNarrativeOnlyRunParagraphs: number;
  readonly longestNarrativeOnlyRunParagraphsDelta: number;
}

export interface LiterarySceneDialogueFlowSnapshot {
  readonly sceneIndex: number;
  readonly paragraphCount: number;
  readonly classificationCounts: LiterarySceneDialogueFlowProfile["classificationCounts"];
  readonly dialogueBearingParagraphCount: number;
  readonly dialogueBearingParagraphRatio: number;
  readonly classificationTransitionCounts: LiterarySceneDialogueFlowProfile["classificationTransitionCounts"];
  readonly classificationChangeCount: number;
  readonly runCount: number;
  readonly dialogueBearingRunCount: number;
  readonly narrativeOnlyRunCount: number;
  readonly longestDialogueBearingRunParagraphs: number;
  readonly longestNarrativeOnlyRunParagraphs: number;
}
export interface LiterarySceneDialogueFlowSummary {
  readonly sceneCount: number;
  readonly totalParagraphCount: number;
  readonly classificationCounts: LiterarySceneDialogueFlowProfile["classificationCounts"];
  readonly dialogueBearingParagraphCount: number;
  /** Fracción agregada ponderada por párrafos, no media simple de porcentajes por escena. */
  readonly dialogueBearingParagraphRatio: number;
  readonly scenesWithDialogueParagraphs: number;
  /** Fracción de escenas con al menos un párrafo dialogado o mixto. */
  readonly sceneShareWithDialogueParagraphs: number;
  readonly classificationTransitionCounts: LiterarySceneDialogueFlowProfile["classificationTransitionCounts"];
  /** Suma de cambios entre párrafos consecutivos dentro de cada escena; no cruza límites de escena. */
  readonly classificationChangeCount: number;
  /** Suma los tramos por escena; nunca une el final de una escena con el inicio de otra. */
  readonly totalRunCount: number;
  readonly dialogueBearingRunCount: number;
  readonly narrativeOnlyRunCount: number;
  /** Máxima longitud de un tramo dentro de una sola escena, no de una concatenación entre escenas. */
  readonly longestDialogueBearingRunParagraphs: number;
  readonly longestNarrativeOnlyRunParagraphs: number;
  readonly sceneSnapshots: readonly LiterarySceneDialogueFlowSnapshot[];
}

export interface LiterarySceneDialogueSegment {
  /** Índice local al conjunto de segmentos de diálogo de esta escena. */
  readonly segmentIndex: number;
  readonly format: LiteraryDialogueSegmentFormat;
  readonly wordCount: number;
  /** Evidencia recortada al contenido de la escena y expresada en offsets UTF-16 absolutos. */
  readonly occurrence: LiteraryAnalysisOccurrence;
}
export interface LiterarySceneDialogueTransition {
  readonly fromSceneIndex: number;
  readonly toSceneIndex: number;
  readonly previousDensity: LiteraryDialogueDensity;
  readonly nextDensity: LiteraryDialogueDensity;
  readonly densityChanged: boolean;
  readonly previousDialogueRatio: number;
  readonly nextDialogueRatio: number;
  /** Diferencia next - previous de la proporción de palabras dialogadas. */
  readonly dialogueRatioDelta: number;
  readonly previousDialogueWordsPer1000NarrativeWords: number;
  readonly nextDialogueWordsPer1000NarrativeWords: number;
  readonly dialogueWordsPer1000NarrativeWordsDelta: number;
  readonly previousSegmentCount: number;
  readonly nextSegmentCount: number;
  readonly segmentCountDelta: number;
  readonly previousDialogueWordCount: number;
  readonly nextDialogueWordCount: number;
  readonly dialogueWordCountDelta: number;
  readonly previousAverageWordsPerSegment: number;
  readonly nextAverageWordsPerSegment: number;
  readonly averageWordsPerSegmentDelta: number;
  readonly previousLongestSegmentWords: number;
  readonly nextLongestSegmentWords: number;
  readonly longestSegmentWordsDelta: number;
  readonly formatCountDelta: LiterarySceneDialogueProfile["formatCounts"];
}
export interface LiterarySceneDialogueProfile {
  readonly segmentCount: number;
  readonly dialogueWordCount: number;
  /** Proporción de palabras dialogadas respecto de todas las palabras de la escena. */
  readonly dialogueRatio: number;
  /** Palabras dialogadas por cada 1.000 palabras de narración fuera del diálogo reconocido. */
  readonly dialogueWordsPer1000NarrativeWords: number;
  readonly density: LiteraryDialogueDensity;
  readonly averageWordsPerSegment: number;
  readonly longestSegmentWords: number;
  readonly formatCounts: {
    readonly quotation: number;
    readonly dialogueDash: number;
    readonly mixed: number;
  };
  /** Se exponen como máximo 20 segmentos; los conteos resumen el total completo. */
  readonly segments: readonly LiterarySceneDialogueSegment[];
  readonly evidenceTruncated: boolean;
}
export interface LiteraryExplicitSceneSegment {
  readonly sceneIndex: number;
  readonly markerType: "scene-heading" | "scene-divider";
  readonly heading: string;
  readonly markerOccurrence: LiteraryAnalysisOccurrence;
  readonly contentRange: LiteraryAnalysisOccurrence;
  readonly wordCount: number;
  /** Palabras de narración fuera de los rangos de diálogo reconocidos. */
  readonly narrativeWordCount: number;
  /** Distribución cuantitativa de los segmentos de diálogo recortados a esta escena. */
  readonly dialogueSignals: LiterarySceneDialogueProfile;
  /** Distribución por párrafo de narración, diálogo exclusivo y párrafos mixtos. */
  readonly dialogueFlowSignals: LiterarySceneDialogueFlowProfile;
  /** Ritmo de las oraciones completas de la escena; incluye diálogo y mantiene evidencia propia. */
  readonly rhythmSignals: LiterarySceneRhythmProfile;
  /** Menciones literales de personajes conocidos y no ambiguos dentro de esta escena. */
  readonly characterMentions: readonly LiterarySceneCharacterMention[];
  /** Indica que se han limitado a cuarenta las identidades con mención nominal. */
  readonly characterMentionsTruncated: boolean;
  readonly eventLinks: readonly LiterarySceneEventLink[];
  /** Indica que hubo más de 100 acontecimientos con evidencia coincidente en esta escena. */
  readonly eventLinksTruncated: boolean;
  /** Señales de pronombres explícitos fuera del diálogo, limitadas al contenido de esta escena. */
  readonly voiceSignals: LiteraryVoiceSignal;
}
/**
 * Recurrencia literal de una palabra de contenido entre escenas explícitas.
 * No agrupa sinónimos, flexiones ni conceptos semánticamente relacionados.
 */
export interface LiterarySceneLexicalEchoScene {
  readonly sceneIndex: number;
  readonly occurrenceCount: number;
  readonly narrativeOccurrenceCount: number;
  readonly dialogueOccurrenceCount: number;
  readonly contextClassification: "narrative-only" | "dialogue-only" | "mixed";
  /** Muestras UTF-16 absolutas con contexto; se conservan como máximo doce por escena. */
  readonly occurrences: readonly (LiteraryAnalysisOccurrence & {
    readonly context: "narrative" | "dialogue";
  })[];
  readonly evidenceTruncated: boolean;
}
export interface LiterarySceneLexicalEcho {
  /** Primera forma literal encontrada para la forma normalizada. */
  readonly word: string;
  readonly normalizedWord: string;
  readonly sceneCount: number;
  readonly totalOccurrenceCount: number;
  readonly scenes: readonly LiterarySceneLexicalEchoScene[];
}
export interface LiterarySceneLexicalEchoAnalysis {
  readonly explicitSceneCount: number;
  /** Candidatos con al menos tres apariciones repartidas entre dos escenas. */
  readonly candidateCount: number;
  readonly omittedCandidateCount: number;
  /** Ordenados por cobertura de escenas y frecuencia; máximo veinte. */
  readonly echoes: readonly LiterarySceneLexicalEcho[];
}

export interface LiteraryAnalysisResult {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly range: LiteraryAnalysisOccurrence;
  readonly metrics: LiteraryAnalysisMetrics;
  readonly rhythmProfile: LiteraryRhythmProfile;
  readonly rhythmTransitions: readonly LiteraryRhythmTransition[];
  readonly dialogueDensity: LiteraryDialogueDensity;
  readonly dialogueSegments: readonly LiteraryDialogueSegment[];
  readonly structuralMarkers: readonly LiteraryStructureMarker[];
  readonly explicitScenes: readonly LiteraryExplicitSceneSegment[];
  /** Coincidencias léxicas recurrentes entre escenas explícitas; no atribuye significado temático. */
  readonly sceneLexicalEchoes: LiterarySceneLexicalEchoAnalysis;
  /** Comparaciones descriptivas entre escenas explícitas contiguas, nunca diagnósticos de contradicción. */
  readonly sceneContinuity: readonly LiterarySceneContinuityTransition[];
  /** Variaciones métricas del ritmo entre escenas contiguas, independientes de las señales gramaticales. */
  readonly sceneRhythmTransitions: readonly LiterarySceneRhythmTransition[];
  /** Comparación de bandas y patrones de cadencia entre escenas contiguas; separada de la voz gramatical. */
  readonly sceneCadenceTransitions: readonly LiterarySceneCadenceTransition[];
  /** Variaciones cuantitativas de diálogo entre escenas explícitas contiguas; no atribuye hablantes. */
  readonly sceneDialogueTransitions: readonly LiterarySceneDialogueTransition[];
  /** Cambios de distribución de párrafos narrativos, dialogados y mixtos entre escenas contiguas. */
  readonly sceneDialogueFlowTransitions: readonly LiterarySceneDialogueFlowTransition[];
  /** Totales y cobertura agregada del flujo de párrafos en todas las escenas explícitas. */
  readonly sceneDialogueFlowSummary: LiterarySceneDialogueFlowSummary;
  /** Firmas de cadencia recurrentes entre escenas explícitas del fragmento analizado. */
  readonly sceneCadenceMotifs: LiterarySceneCadenceMotifAnalysis;
  /** Variaciones de señales gramaticales entre escenas contiguas; no demuestra cambio de narrador. */
  readonly sceneVoiceTransitions: readonly LiterarySceneVoiceTransition[];
  /** Resumen cuantitativo de señales gramaticales a lo largo de las escenas explícitas. */
  readonly sceneVoiceProfile: LiterarySceneVoiceProfile;
  /** Tramos estables o alternantes de clasificaciones gramaticales en escenas contiguas. */
  readonly sceneVoiceSequences: readonly LiterarySceneVoiceSequencePattern[];
  /** Pares de personajes mencionados en las mismas escenas; no implica interacción o relación. */
  readonly characterCoMentions: readonly LiteraryCharacterCoMentionPattern[];
  /** Distribución de menciones literales de personajes conocidos a lo largo de las escenas explícitas. */
  readonly characterMentionDistributions: LiteraryCharacterMentionDistributionAnalysis;
  /** Serie por escena que separa menciones nominales de participación documentada por acontecimientos. */
  readonly characterSceneEvidence: LiteraryCharacterSceneEvidenceAnalysis;
  /** Comparación de atributos explícitos de personajes entre escenas de la revisión vigente. */
  readonly characterAttributeEvolution: LiteraryCharacterAttributeEvolutionAnalysis;
  /** Trayectorias documentales que integran atributos, participación y causalidades candidatas por personaje. */
  readonly characterNarrativeTrajectories: LiteraryCharacterNarrativeTrajectoryAnalysis;
  /** Grafo dirigido de vínculos de ideas introducidos explícitamente por el escritor. */
  readonly ideaGraph: LiteraryIdeaGraphAnalysis;
  /** Dependencias causales candidatas entre acontecimientos, respaldadas por conectores literales del texto. */
  readonly eventDependencyAnalysis: LiteraryEventDependencyAnalysis;
  /** Evidencia de acontecimientos asociados explícitamente a participantes, desglosada por escena. */
  readonly characterEventEvidenceProfiles: LiteraryCharacterEventEvidenceAnalysis;
  /** Recurrencia de acontecimientos en escenas, independiente de que tengan participantes declarados. */
  readonly sceneEventEvidenceProfiles: LiterarySceneEventEvidenceAnalysis;
  /** Firmas recurrentes de IDs de acontecimientos en ventanas de dos y tres escenas contiguas. */
  readonly sceneEventSequenceMotifs: LiterarySceneEventSequenceMotifAnalysis;
  /** Variaciones de evidencia y menciones nominales de participantes en escenas contiguas. */
  readonly sceneEventAssociationTransitions: readonly LiterarySceneEventAssociationTransition[];
  /** Evolución versionada de etiquetas y participantes declarados por el escritor. */
  readonly eventLifecycleAnalysis: LiteraryEventLifecycleAnalysis;
  readonly voiceSignals: LiteraryVoiceSignal;
  readonly repeatedWords: readonly LiteraryRepeatedWord[];
  readonly repeatedPhrases: readonly LiteraryRepeatedPhrase[];
  readonly repeatedSentenceOpenings: readonly LiterarySentenceOpening[];
  readonly anaphoraCandidates: readonly LiteraryAnaphoraCandidate[];
  readonly sensorySignals: readonly LiterarySensorySignal[];
  readonly caveats: readonly string[];
}
interface LocalRange { readonly start: number; readonly end: number; }
interface WordToken extends LocalRange {
  readonly text: string;
  readonly normalized: string;
}
interface OccurrenceGroup {
  readonly key: string;
  readonly label: string;
  occurrences: LocalRange[];
}

const WORD_PATTERN = /[\p{L}\p{M}\p{N}]+(?:[’'][\p{L}\p{M}]+)?/gu;
const LETTER_PATTERN = /\p{L}/gu;
const SENTENCE_BOUNDARY_PATTERN = /[.!?…]+(?:["»”’)}\]]*)?(?=\s|$)/gu;
const PARAGRAPH_SEPARATOR_PATTERN = /\r?\n(?:[ \t]*\r?\n)+/gu;
const STOP_WORDS = new Set([
  "a","al","algo","algunas","algunos","ambos","ante","antes","aquel","aquella","aquellas",
  "aquello","aquellos","aqui","aquí","asi","así","aun","aunque","bajo","bien","cada","casi",
  "como","con","contra","cual","cuando","cuanta","cuantas","cuanto","cuantos","de","del",
  "desde","donde","dos","durante","e","el","ella","ellas","ello","ellos","en","entre","era",
  "erais","eran","eras","eres","es","esa","esas","ese","eso","esos","esta","estaba","estaban",
  "estado","estais","estamos","estan","estar","estas","este","esto","estos","estoy","fue",
  "fueron","ha","hace","hacia","han","hasta","hay","la","las","le","les","lo","los","mas",
  "más","me","mi","mis","mismo","misma","mucho","muy","nada","ni","no","nos","nosotras",
  "nosotros","nuestra","nuestras","nuestro","nuestros","o","os","otra","otras","otro","otros",
  "para","pero","poco","por","porque","que","qué","quien","quién","quienes","se","sea","ser",
  "si","sí","sin","sobre","sois","somos","son","soy","su","sus","tambien","también","tan",
  "tanto","te","tiene","tienen","todo","toda","todas","todos","tu","tú","tus","un","una",
  "unas","uno","unos","usted","ustedes","va","vais","vamos","van","varias","varios","y","ya"
]);
const FIRST_PERSON = new Set([
  "yo","me","mí","conmigo","nos","nosotros","nosotras","nuestro","nuestra","nuestros",
  "nuestras","mío","mía","míos","mías"
]);
const SECOND_PERSON = new Set([
  "tú","te","ti","contigo","vos","usted","ustedes","vosotros","vosotras","os",
  "vuestro","vuestra","vuestros","vuestras"
]);
const THIRD_PERSON = new Set(["él","ella","ellos","ellas"]);
const ABBREVIATIONS = new Set(["sr","sra","srta","dr","dra","prof","profa","etc","ej","núm","núms"]);

const SENSORY_LEXICON: Readonly<Record<LiterarySensoryModality, ReadonlySet<string>>> = {
  visual: new Set([
    "luz","brillo","brillaba","brillante","resplandor","sombra","oscuro","oscura",
    "claro","clara","ver","vio","mirar","miró","miraba","observó","observaba",
    "contempló","contemplaba","vista","ojo","ojos","color","colores"
  ]),
  auditory: new Set([
    "sonido","ruido","voz","voces","silencio","susurro","susurró","susurraba",
    "grito","gritó","gritaba","eco","resonó","resonaba","escuchó","escuchaba",
    "oyó","oía","oír","oir","escuchar","sonó","sonaba","murmuró","murmuraba"
  ]),
  tactile: new Set([
    "piel","frío","fria","fría","calor","caliente","helado","helada","suave",
    "áspero","áspera","aspero","aspera","rugoso","rugosa","textura","tocó",
    "tocaba","acarició","acariciaba","dolor","ardor","húmedo","húmeda","humedo","humeda"
  ]),
  olfactory: new Set([
    "olor","aroma","perfume","fragancia","hedor","apestaba","olió","olia","olía",
    "oler","olfato","huele","olía"
  ]),
  gustatory: new Set([
    "sabor","dulce","amargo","amarga","salado","salada","ácido","ácida","acido",
    "acida","agrio","agria","saboreó","saboreaba","saborear","degustó","degustaba"
  ])
};
const SENSORY_MODALITIES: readonly LiterarySensoryModality[] = [
  "visual","auditory","tactile","olfactory","gustatory"
];


function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
function tokenize(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    const value = match[0];
    const start = match.index ?? 0;
    tokens.push({
      start, end: start + value.length, text: value,
      normalized: value.normalize("NFKC").toLocaleLowerCase("es")
    });
  }
  return tokens;
}
function trimRange(text: string, start: number, end: number): LocalRange | undefined {
  while (start < end && /\s/u.test(text[start] ?? "")) start++;
  while (end > start && /\s/u.test(text[end - 1] ?? "")) end--;
  return start < end ? { start, end } : undefined;
}
function isAbbreviationBoundary(text: string, sentenceStart: number, punctuationIndex: number): boolean {
  const before = text.slice(sentenceStart, punctuationIndex + 1);
  const token = before.match(/([\p{L}]+)\.$/u)?.[1]?.toLocaleLowerCase("es");
  return (token !== undefined && ABBREVIATIONS.has(token)) || /\b\p{Lu}\.$/u.test(before);
}
function isDecimalPoint(text: string, index: number): boolean {
  return /\p{N}/u.test(text[index - 1] ?? "") && /\p{N}/u.test(text[index + 1] ?? "");
}
function findSentenceRanges(text: string): LocalRange[] {
  const ranges: LocalRange[] = [];
  let cursor = 0;
  for (const match of text.matchAll(SENTENCE_BOUNDARY_PATTERN)) {
    const boundaryStart = match.index ?? 0;
    const punctuation = match[0].match(/[.!?…]+/u)?.[0] ?? "";
    if (punctuation === "." &&
        (isAbbreviationBoundary(text, cursor, boundaryStart) ||
         (punctuation.length === 1 && isDecimalPoint(text, boundaryStart)))) continue;
    const end = boundaryStart + match[0].length;
    const range = trimRange(text, cursor, end);
    if (range && tokenize(text.slice(range.start, range.end)).length > 0) ranges.push(range);
    cursor = end;
  }
  const tail = trimRange(text, cursor, text.length);
  if (tail && tokenize(text.slice(tail.start, tail.end)).length > 0) ranges.push(tail);
  return ranges;
}
function findParagraphRanges(text: string): LocalRange[] {
  const ranges: LocalRange[] = [];
  let cursor = 0;
  for (const match of text.matchAll(PARAGRAPH_SEPARATOR_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const range = trimRange(text, cursor, start);
    if (range) ranges.push(range);
    cursor = end;
  }
  const tail = trimRange(text, cursor, text.length);
  if (tail) ranges.push(tail);
  return ranges;
}

interface LocalLiteraryStructureMarker extends LocalRange {
  readonly markerType: LiteraryStructureMarkerType;
  readonly label: string;
  readonly lineIndex: number;
}
function detectLiteraryStructure(text: string): LocalLiteraryStructureMarker[] {
  const markers: LocalLiteraryStructureMarker[] = [];
  const headingLimit = 100;
  let cursor = 0;
  let lineIndex = 0;
  while (cursor < text.length && markers.length < headingLimit) {
    const lineStart = cursor;
    while (cursor < text.length && text[cursor] !== "\n" && text[cursor] !== "\r") cursor++;
    const lineEnd = cursor;
    const line = text.slice(lineStart,lineEnd);
    if (cursor < text.length && text[cursor] === "\r") cursor++;
    if (cursor < text.length && text[cursor] === "\n") cursor++;
    lineIndex++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = trimmed.match(/^(?:#{1,6}[ \t]*)?(cap[ií]tulo|chapter|parte|part|libro|book|acto|act|escena|scene)\b(.*)$/iu);
    if (heading) {
      const keyword = (heading[1] ?? "").toLocaleLowerCase("es");
      const markerType: LiteraryStructureMarkerType =
        /^(?:cap[ií]tulo|chapter)$/u.test(keyword) ? "chapter-heading" :
        /^(?:parte|part|libro|book)$/u.test(keyword) ? "part-heading" :
        /^(?:acto|act)$/u.test(keyword) ? "act-heading" : "scene-heading";
      markers.push({
        markerType,
        label:trimmed.replace(/^#{1,6}[ \t]*/u,""),
        lineIndex,
        start:lineStart,
        end:lineEnd
      });
      continue;
    }
    const compact = trimmed.replace(/[ \t]/gu,"");
    if (/^(?:\*{3,}|-{3,}|_{3,}|={3,}|·{3,}|•{3,})$/u.test(compact)) {
      markers.push({
        markerType:"scene-divider",
        label:"Separador de escena",
        lineIndex,
        start:lineStart,
        end:lineEnd
      });
    }
  }
  return markers;
}
function normalizeSceneCharacterName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu," ").toLocaleLowerCase("es");
}
function escapeSceneCharacterPattern(value: string): string {
  let escaped = "";
  for (const character of value) {
    if ("\\^$.*+?()[]{}|".includes(character)) escaped += "\\";
    escaped += character;
  }
  return escaped;
}
function findSceneCharacterMentions(
  text: string,
  contentRange: LocalRange,
  baseOffset: number,
  characters: readonly LiteraryAnalysisKnownCharacter[],
  resultLimit = 40
): LiterarySceneCharacterMention[] {
  const nameOwners = new Map<string, Array<{
    readonly entityId: string;
    readonly canonicalName: string;
    readonly sourceName: string;
  }>>();
  for (const character of characters) {
    const names = [character.canonicalName,...(character.aliases ?? [])];
    const seenForCharacter = new Set<string>();
    for (const sourceName of names) {
      const normalized = normalizeSceneCharacterName(sourceName);
      if (!normalized || seenForCharacter.has(normalized)) continue;
      seenForCharacter.add(normalized);
      const owners = nameOwners.get(normalized) ?? [];
      owners.push({
        entityId:character.entityId,
        canonicalName:character.canonicalName,
        sourceName
      });
      nameOwners.set(normalized,owners);
    }
  }
  const grouped = new Map<string,{
    readonly entityId: string;
    readonly canonicalName: string;
    matchedNames: Map<string, number>;
    mentionCount: number;
    occurrences: LocalRange[];
  }>();
  const excerpt = text.slice(contentRange.start,contentRange.end);
  for (const owners of nameOwners.values()) {
    const distinctOwners = new Map(owners.map(owner => [owner.entityId,owner]));
    // Nombres o alias en conflicto no se asignan a una identidad automáticamente.
    if (distinctOwners.size !== 1) continue;
    const owner = [...distinctOwners.values()][0]!;
    const escaped = owner.sourceName.trim().replace(/\s+/gu," ").split(" ")
      .map(escapeSceneCharacterPattern).join("\\s+");
    const expression = new RegExp(
      "(?<![\\p{L}\\p{N}_])"+escaped+"(?![\\p{L}\\p{N}_])","giu"
    );
    const group = grouped.get(owner.entityId) ?? {
      entityId:owner.entityId,
      canonicalName:owner.canonicalName,
      matchedNames:new Map<string,number>(),
      mentionCount:0,
      occurrences:[]
    };
    for (const match of excerpt.matchAll(expression)) {
      const matchedName = match[0];
      const start = contentRange.start + (match.index ?? 0);
      group.mentionCount++;
      const previousMatch = group.matchedNames.get(matchedName);
      if (previousMatch === undefined || start < previousMatch) {
        group.matchedNames.set(matchedName,start);
      }
      group.occurrences.push({
        start:baseOffset+start,
        end:baseOffset+start+matchedName.length
      });
      group.occurrences.sort((a,b) => a.start-b.start || a.end-b.end);
      if (group.occurrences.length > 20) group.occurrences.pop();
    }
    if (group.occurrences.length > 0) grouped.set(owner.entityId,group);
  }
  return [...grouped.values()]
    .sort((a,b) => (a.occurrences[0]?.start ?? 0)-(b.occurrences[0]?.start ?? 0))
    .slice(0,resultLimit)
    .map(group => ({
      entityId:group.entityId,
      canonicalName:group.canonicalName,
      matchedNames:[...group.matchedNames.entries()]
        .sort((a,b) => a[1]-b[1] || a[0].localeCompare(b[0],"es"))
        .slice(0,10).map(([name]) => name),
      matchedNameCount:group.matchedNames.size,
      matchedNamesTruncated:group.matchedNames.size>10,
      mentionCount:group.mentionCount,
      occurrences:group.occurrences,
      occurrencesTruncated:group.mentionCount>group.occurrences.length
    }));
}
function findSceneEventLinks(
  contentRange: LocalRange,
  baseOffset: number,
  documentId: string,
  revision: number,
  characters: readonly LiterarySceneCharacterMention[],
  events: readonly LiteraryAnalysisKnownEvent[]
): {readonly links: LiterarySceneEventLink[]; readonly truncated: boolean} {
  const sceneStart = baseOffset + contentRange.start;
  const sceneEnd = baseOffset + contentRange.end;
  const characterIds = new Set(characters.map(character => character.entityId));
  const links: LiterarySceneEventLink[] = [];
  for (const event of events) {
    const matchingEvidence = event.evidence
      .filter(evidence =>
        evidence.status !== "stale" &&
        evidence.documentId === documentId &&
        evidence.revision === revision &&
        evidence.end > sceneStart &&
        evidence.start < sceneEnd &&
        evidence.end > evidence.start
      )
      .map(evidence => ({
        start:Math.max(sceneStart,evidence.start),
        end:Math.min(sceneEnd,evidence.end)
      }))
      .sort((a,b) => a.start-b.start || a.end-b.end);
    if (matchingEvidence.length === 0) continue;
    if (links.length >= 100) return {links,truncated:true};
    links.push({
      eventId:event.eventId,
      label:event.label,
      matchingEvidenceCount:matchingEvidence.length,
      matchingEvidenceTruncated:matchingEvidence.length>20,
      matchingEvidence:matchingEvidence.slice(0,20),
      participants:[...new Set(event.participants)].sort((a,b) => a.localeCompare(b,"en")).map(entityId => ({
        entityId,
        mentionedByName:characterIds.has(entityId)
      }))
    });
  }
  return {links,truncated:false};
}

function summarizeSceneDialogueFlow(
  tokens: readonly WordToken[],
  text: string,
  contentRange: LocalRange,
  dialogueRanges: readonly LocalRange[],
  baseOffset: number
): LiterarySceneDialogueFlowProfile {
  const sceneText = text.slice(contentRange.start,contentRange.end);
  const paragraphRanges = findParagraphRanges(sceneText).map(range => ({
    start:contentRange.start+range.start,
    end:contentRange.start+range.end
  }));
  const wordCounts = countTokensPerRange(tokens,paragraphRanges);
  const dialogueWordCounts = paragraphRanges.map(paragraph => {
    const intersections = dialogueRanges
      .filter(range => range.end > paragraph.start && range.start < paragraph.end)
      .map(range => ({
        start:Math.max(range.start,paragraph.start),
        end:Math.min(range.end,paragraph.end)
      }));
    return countTokensInRanges(tokens,intersections);
  });
  const paragraphSamples: LiterarySceneDialogueParagraph[] = [];
  const runSamples: LiterarySceneDialogueFlowRun[] = [];
  const classificationCounts = {narrativeOnly:0,dialogueOnly:0,mixed:0};
  const classificationTransitionCounts = {
    narrativeOnlyToNarrativeOnly:0,
    narrativeOnlyToDialogueOnly:0,
    narrativeOnlyToMixed:0,
    dialogueOnlyToNarrativeOnly:0,
    dialogueOnlyToDialogueOnly:0,
    dialogueOnlyToMixed:0,
    mixedToNarrativeOnly:0,
    mixedToDialogueOnly:0,
    mixedToMixed:0
  };
  const classificationKey = (value: LiterarySceneDialogueParagraphClassification) =>
    value === "narrative-only" ? "narrativeOnly" :
    value === "dialogue-only" ? "dialogueOnly" : "mixed";
  type MutableRun = {
    kind: LiterarySceneDialogueFlowRunKind;
    fromParagraphIndex: number;
    toParagraphIndex: number;
    paragraphCount: number;
    narrativeOnlyParagraphCount: number;
    dialogueOnlyParagraphCount: number;
    mixedParagraphCount: number;
    start: number;
    end: number;
  };
  let paragraphCount = 0;
  let classificationChangeCount = 0;
  let dialogueBearingRunCount = 0;
  let narrativeOnlyRunCount = 0;
  let longestDialogueBearingRunParagraphs = 0;
  let longestNarrativeOnlyRunParagraphs = 0;
  let previousClassification: LiterarySceneDialogueParagraphClassification | undefined;
  let currentRun: MutableRun | undefined;
  const flushRun = (): void => {
    if (!currentRun) return;
    const runIndex = dialogueBearingRunCount+narrativeOnlyRunCount+1;
    if (currentRun.kind === "dialogue-bearing-run") {
      dialogueBearingRunCount++;
      longestDialogueBearingRunParagraphs = Math.max(
        longestDialogueBearingRunParagraphs,currentRun.paragraphCount
      );
    } else {
      narrativeOnlyRunCount++;
      longestNarrativeOnlyRunParagraphs = Math.max(
        longestNarrativeOnlyRunParagraphs,currentRun.paragraphCount
      );
    }
    if (runSamples.length < 40) {
      runSamples.push({
        runIndex,
        kind:currentRun.kind,
        fromParagraphIndex:currentRun.fromParagraphIndex,
        toParagraphIndex:currentRun.toParagraphIndex,
        paragraphCount:currentRun.paragraphCount,
        narrativeOnlyParagraphCount:currentRun.narrativeOnlyParagraphCount,
        dialogueOnlyParagraphCount:currentRun.dialogueOnlyParagraphCount,
        mixedParagraphCount:currentRun.mixedParagraphCount,
        occurrence:{start:baseOffset+currentRun.start,end:baseOffset+currentRun.end}
      });
    }
    currentRun = undefined;
  };
  for (let index=0; index<paragraphRanges.length; index++) {
    const wordCount = wordCounts[index] ?? 0;
    if (wordCount === 0) continue;
    const dialogueWordCount = Math.min(wordCount,dialogueWordCounts[index] ?? 0);
    const classification: LiterarySceneDialogueParagraphClassification =
      dialogueWordCount === 0 ? "narrative-only" :
      dialogueWordCount >= wordCount ? "dialogue-only" : "mixed";
    const range = paragraphRanges[index]!;
    const kind: LiterarySceneDialogueFlowRunKind = classification === "narrative-only"
      ? "narrative-only-run" : "dialogue-bearing-run";
    paragraphCount++;
    classificationCounts[classificationKey(classification)]++;
    if (previousClassification !== undefined) {
      const previousKey = classificationKey(previousClassification);
      const currentKey = classificationKey(classification);
      const transitionKey =
        `${previousKey}To${currentKey[0]!.toUpperCase()}${currentKey.slice(1)}` as keyof typeof classificationTransitionCounts;
      classificationTransitionCounts[transitionKey]++;
      if (previousClassification !== classification) classificationChangeCount++;
    }
    if (paragraphSamples.length < 40) {
      paragraphSamples.push({
        paragraphIndex:index+1,
        classification,
        wordCount,
        dialogueWordCount,
        occurrence:{start:baseOffset+range.start,end:baseOffset+range.end}
      });
    }
    if (currentRun && currentRun.kind !== kind) flushRun();
    if (!currentRun) {
      currentRun = {
        kind,
        fromParagraphIndex:index+1,
        toParagraphIndex:index+1,
        paragraphCount:1,
        narrativeOnlyParagraphCount:classification === "narrative-only" ? 1 : 0,
        dialogueOnlyParagraphCount:classification === "dialogue-only" ? 1 : 0,
        mixedParagraphCount:classification === "mixed" ? 1 : 0,
        start:range.start,
        end:range.end
      };
    } else {
      currentRun.toParagraphIndex = index+1;
      currentRun.paragraphCount++;
      if (classification === "narrative-only") currentRun.narrativeOnlyParagraphCount++;
      else if (classification === "dialogue-only") currentRun.dialogueOnlyParagraphCount++;
      else currentRun.mixedParagraphCount++;
      currentRun.end = range.end;
    }
    previousClassification = classification;
  }
  flushRun();
  const runCount = dialogueBearingRunCount+narrativeOnlyRunCount;
  const dialogueBearingParagraphCount = classificationCounts.dialogueOnly+classificationCounts.mixed;
  return {
    paragraphCount,
    classificationCounts,
    dialogueBearingParagraphCount,
    dialogueBearingParagraphRatio:roundMetric(paragraphCount > 0
      ? dialogueBearingParagraphCount/paragraphCount : 0),
    classificationTransitionCounts,
    classificationChangeCount,
    runCount,
    dialogueBearingRunCount,
    narrativeOnlyRunCount,
    longestDialogueBearingRunParagraphs,
    longestNarrativeOnlyRunParagraphs,
    runs:runSamples,
    runsTruncated:runCount>40,
    paragraphs:paragraphSamples,
    evidenceTruncated:paragraphCount>40
  };
}
function analyzeExplicitScenes(
  text: string,
  tokens: readonly WordToken[],
  baseOffset: number,
  markers: readonly LocalLiteraryStructureMarker[],
  knownCharacters: readonly LiteraryAnalysisKnownCharacter[],
  knownEvents: readonly LiteraryAnalysisKnownEvent[],
  dialogueRanges: readonly LocalRange[],
  dialogueSegments: readonly (LocalRange & { readonly format: LiteraryDialogueSegmentFormat })[],
  documentId: string,
  revision: number
): LiteraryExplicitSceneSegment[] {
  const sceneMarkers = markers.filter(marker =>
    marker.markerType === "scene-heading" || marker.markerType === "scene-divider"
  );
  const localRanges: LocalRange[] = [];
  const sceneDrafts: Array<{
    marker: LocalLiteraryStructureMarker;
    contentRange: LocalRange;
  }> = [];
  for (const marker of sceneMarkers) {
    const markerIndex = markers.indexOf(marker);
    const nextMarker = markers[markerIndex+1];
    const contentEnd = nextMarker?.start ?? text.length;
    const contentRange = trimRange(text,marker.end,contentEnd);
    if (!contentRange) continue;
    localRanges.push(contentRange);
    sceneDrafts.push({marker,contentRange});
  }
  const boundedScenes = sceneDrafts.slice(0,100);
  const boundedRanges = boundedScenes.map(scene => scene.contentRange);
  const wordCounts = countTokensPerRange(tokens,boundedRanges);
  const narrativeWordCounts = countTokensOutsideRangesPerRange(tokens,boundedRanges,dialogueRanges);
  let dialogueCursor = 0;
  return boundedScenes.map((scene,index) => {
    while (dialogueCursor < dialogueSegments.length &&
      dialogueSegments[dialogueCursor]!.end <= scene.contentRange.start) dialogueCursor++;
    const localDialogueSegments: Array<LocalRange & { readonly format: LiteraryDialogueSegmentFormat }> = [];
    for (let cursor=dialogueCursor; cursor<dialogueSegments.length &&
      dialogueSegments[cursor]!.start < scene.contentRange.end; cursor++) {
      const segment = dialogueSegments[cursor]!;
      const start = Math.max(segment.start,scene.contentRange.start);
      const end = Math.min(segment.end,scene.contentRange.end);
      if (start < end) localDialogueSegments.push({start,end,format:segment.format});
    }
    const sceneDialogueWordCounts = countTokensPerRange(tokens,localDialogueSegments);
    const dialogueWordCount = sceneDialogueWordCounts.reduce((total,count) => total+count,0);
    const dialogueRatio = (wordCounts[index] ?? 0) > 0
      ? dialogueWordCount/(wordCounts[index] ?? 1) : 0;
    let dialogueDensity: LiteraryDialogueDensity = "none";
    if (dialogueRatio > 0) {
      if (dialogueRatio < 0.1) dialogueDensity = "low";
      else if (dialogueRatio < 0.3) dialogueDensity = "moderate";
      else dialogueDensity = "high";
    }
    const formatCounts = {quotation:0,dialogueDash:0,mixed:0};
    for (const segment of localDialogueSegments) {
      if (segment.format === "quotation") formatCounts.quotation++;
      else if (segment.format === "dialogue-dash") formatCounts.dialogueDash++;
      else formatCounts.mixed++;
    }
    const dialogueSignals: LiterarySceneDialogueProfile = {
      segmentCount:localDialogueSegments.length,
      dialogueWordCount,
      dialogueRatio:roundMetric(dialogueRatio),
      dialogueWordsPer1000NarrativeWords:roundMetric((narrativeWordCounts[index] ?? 0) > 0
        ? dialogueWordCount/(narrativeWordCounts[index] ?? 1)*1000 : 0),
      density:dialogueDensity,
      averageWordsPerSegment:roundMetric(localDialogueSegments.length > 0
        ? dialogueWordCount/localDialogueSegments.length : 0),
      longestSegmentWords:sceneDialogueWordCounts.reduce((maximum,count) => Math.max(maximum,count),0),
      formatCounts,
      segments:localDialogueSegments.slice(0,20).map((segment,segmentIndex) => ({
        segmentIndex:segmentIndex+1,
        format:segment.format,
        wordCount:sceneDialogueWordCounts[segmentIndex] ?? 0,
        occurrence:{start:baseOffset+segment.start,end:baseOffset+segment.end}
      })),
      evidenceTruncated:localDialogueSegments.length>20
    };
    const dialogueFlowSignals = summarizeSceneDialogueFlow(
      tokens,text,scene.contentRange,dialogueRanges,baseOffset
    );
    const sceneText = text.slice(scene.contentRange.start,scene.contentRange.end);
    const sceneSentenceRanges = findSentenceRanges(sceneText).map(range => ({
      start:scene.contentRange.start+range.start,
      end:scene.contentRange.start+range.end
    }));
    const sceneSentenceWordCounts = countTokensPerRange(tokens,sceneSentenceRanges);
    const allCharacterMentions = findSceneCharacterMentions(
      text,scene.contentRange,baseOffset,knownCharacters,knownCharacters.length
    );
    const characterMentions = allCharacterMentions.slice(0,40);
    const eventLinkResult = findSceneEventLinks(
      scene.contentRange,baseOffset,documentId,revision,allCharacterMentions,knownEvents
    );
    return ({
    sceneIndex:index+1,
    markerType:scene.marker.markerType as "scene-heading" | "scene-divider",
    heading:scene.marker.label,
    markerOccurrence:{
      start:baseOffset+scene.marker.start,
      end:baseOffset+scene.marker.end
    },
    contentRange:{
      start:baseOffset+scene.contentRange.start,
      end:baseOffset+scene.contentRange.end
    },
    wordCount:wordCounts[index] ?? 0,
    narrativeWordCount:narrativeWordCounts[index] ?? 0,
    dialogueSignals,
    dialogueFlowSignals,
    rhythmSignals:summarizeSceneRhythm(sceneSentenceRanges,sceneSentenceWordCounts,baseOffset),
    characterMentions,
    characterMentionsTruncated:allCharacterMentions.length>40,
    eventLinks:eventLinkResult.links,
    eventLinksTruncated:eventLinkResult.truncated,
    voiceSignals:classifyVoiceSignals(tokens,dialogueRanges,baseOffset,scene.contentRange)
  });});
}

function buildSceneDialogueFlowSummary(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneDialogueFlowSummary {
  const classificationCounts = {narrativeOnly:0,dialogueOnly:0,mixed:0};
  const classificationTransitionCounts = {
    narrativeOnlyToNarrativeOnly:0,
    narrativeOnlyToDialogueOnly:0,
    narrativeOnlyToMixed:0,
    dialogueOnlyToNarrativeOnly:0,
    dialogueOnlyToDialogueOnly:0,
    dialogueOnlyToMixed:0,
    mixedToNarrativeOnly:0,
    mixedToDialogueOnly:0,
    mixedToMixed:0
  };
  let totalParagraphCount = 0;
  let dialogueBearingParagraphCount = 0;
  let scenesWithDialogueParagraphs = 0;
  let classificationChangeCount = 0;
  let totalRunCount = 0;
  let dialogueBearingRunCount = 0;
  let narrativeOnlyRunCount = 0;
  let longestDialogueBearingRunParagraphs = 0;
  let longestNarrativeOnlyRunParagraphs = 0;
  const sceneSnapshots: LiterarySceneDialogueFlowSnapshot[] = [];
  for (const scene of scenes) {
    const flow = scene.dialogueFlowSignals;
    totalParagraphCount += flow.paragraphCount;
    dialogueBearingParagraphCount += flow.dialogueBearingParagraphCount;
    classificationCounts.narrativeOnly += flow.classificationCounts.narrativeOnly;
    classificationCounts.dialogueOnly += flow.classificationCounts.dialogueOnly;
    classificationCounts.mixed += flow.classificationCounts.mixed;
    classificationTransitionCounts.narrativeOnlyToNarrativeOnly +=
      flow.classificationTransitionCounts.narrativeOnlyToNarrativeOnly;
    classificationTransitionCounts.narrativeOnlyToDialogueOnly +=
      flow.classificationTransitionCounts.narrativeOnlyToDialogueOnly;
    classificationTransitionCounts.narrativeOnlyToMixed +=
      flow.classificationTransitionCounts.narrativeOnlyToMixed;
    classificationTransitionCounts.dialogueOnlyToNarrativeOnly +=
      flow.classificationTransitionCounts.dialogueOnlyToNarrativeOnly;
    classificationTransitionCounts.dialogueOnlyToDialogueOnly +=
      flow.classificationTransitionCounts.dialogueOnlyToDialogueOnly;
    classificationTransitionCounts.dialogueOnlyToMixed +=
      flow.classificationTransitionCounts.dialogueOnlyToMixed;
    classificationTransitionCounts.mixedToNarrativeOnly +=
      flow.classificationTransitionCounts.mixedToNarrativeOnly;
    classificationTransitionCounts.mixedToDialogueOnly +=
      flow.classificationTransitionCounts.mixedToDialogueOnly;
    classificationTransitionCounts.mixedToMixed +=
      flow.classificationTransitionCounts.mixedToMixed;
    classificationChangeCount += flow.classificationChangeCount;
    totalRunCount += flow.runCount;
    dialogueBearingRunCount += flow.dialogueBearingRunCount;
    narrativeOnlyRunCount += flow.narrativeOnlyRunCount;
    longestDialogueBearingRunParagraphs = Math.max(
      longestDialogueBearingRunParagraphs,flow.longestDialogueBearingRunParagraphs
    );
    longestNarrativeOnlyRunParagraphs = Math.max(
      longestNarrativeOnlyRunParagraphs,flow.longestNarrativeOnlyRunParagraphs
    );
    if (flow.dialogueBearingParagraphCount > 0) scenesWithDialogueParagraphs++;
    sceneSnapshots.push({
      sceneIndex:scene.sceneIndex,
      paragraphCount:flow.paragraphCount,
      classificationCounts:{...flow.classificationCounts},
      dialogueBearingParagraphCount:flow.dialogueBearingParagraphCount,
      dialogueBearingParagraphRatio:flow.dialogueBearingParagraphRatio,
      classificationTransitionCounts:{...flow.classificationTransitionCounts},
      classificationChangeCount:flow.classificationChangeCount,
      runCount:flow.runCount,
      dialogueBearingRunCount:flow.dialogueBearingRunCount,
      narrativeOnlyRunCount:flow.narrativeOnlyRunCount,
      longestDialogueBearingRunParagraphs:flow.longestDialogueBearingRunParagraphs,
      longestNarrativeOnlyRunParagraphs:flow.longestNarrativeOnlyRunParagraphs
    });
  }
  return {
    sceneCount:scenes.length,
    totalParagraphCount,
    classificationCounts,
    dialogueBearingParagraphCount,
    dialogueBearingParagraphRatio:roundMetric(totalParagraphCount > 0
      ? dialogueBearingParagraphCount/totalParagraphCount : 0),
    scenesWithDialogueParagraphs,
    sceneShareWithDialogueParagraphs:roundMetric(scenes.length > 0
      ? scenesWithDialogueParagraphs/scenes.length : 0),
    classificationTransitionCounts,
    classificationChangeCount,
    totalRunCount,
    dialogueBearingRunCount,
    narrativeOnlyRunCount,
    longestDialogueBearingRunParagraphs,
    longestNarrativeOnlyRunParagraphs,
    sceneSnapshots
  };
}
function buildSceneDialogueFlowTransitions(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneDialogueFlowTransition[] {
  const transitions: LiterarySceneDialogueFlowTransition[] = [];
  for (let index=1; index<scenes.length; index++) {
    const previous = scenes[index-1]!.dialogueFlowSignals;
    const next = scenes[index]!.dialogueFlowSignals;
    transitions.push({
      fromSceneIndex:index,
      toSceneIndex:index+1,
      previousParagraphCount:previous.paragraphCount,
      nextParagraphCount:next.paragraphCount,
      paragraphCountDelta:next.paragraphCount-previous.paragraphCount,
      previousDialogueBearingParagraphCount:previous.dialogueBearingParagraphCount,
      nextDialogueBearingParagraphCount:next.dialogueBearingParagraphCount,
      dialogueBearingParagraphCountDelta:
        next.dialogueBearingParagraphCount-previous.dialogueBearingParagraphCount,
      previousDialogueBearingParagraphRatio:previous.dialogueBearingParagraphRatio,
      nextDialogueBearingParagraphRatio:next.dialogueBearingParagraphRatio,
      dialogueBearingParagraphRatioDelta:roundMetric(
        next.dialogueBearingParagraphRatio-previous.dialogueBearingParagraphRatio
      ),
      classificationCountDelta:{
        narrativeOnly:next.classificationCounts.narrativeOnly-previous.classificationCounts.narrativeOnly,
        dialogueOnly:next.classificationCounts.dialogueOnly-previous.classificationCounts.dialogueOnly,
        mixed:next.classificationCounts.mixed-previous.classificationCounts.mixed
      },
      classificationTransitionCountDelta:{
        narrativeOnlyToNarrativeOnly:
          next.classificationTransitionCounts.narrativeOnlyToNarrativeOnly-previous.classificationTransitionCounts.narrativeOnlyToNarrativeOnly,
        narrativeOnlyToDialogueOnly:
          next.classificationTransitionCounts.narrativeOnlyToDialogueOnly-previous.classificationTransitionCounts.narrativeOnlyToDialogueOnly,
        narrativeOnlyToMixed:
          next.classificationTransitionCounts.narrativeOnlyToMixed-previous.classificationTransitionCounts.narrativeOnlyToMixed,
        dialogueOnlyToNarrativeOnly:
          next.classificationTransitionCounts.dialogueOnlyToNarrativeOnly-previous.classificationTransitionCounts.dialogueOnlyToNarrativeOnly,
        dialogueOnlyToDialogueOnly:
          next.classificationTransitionCounts.dialogueOnlyToDialogueOnly-previous.classificationTransitionCounts.dialogueOnlyToDialogueOnly,
        dialogueOnlyToMixed:
          next.classificationTransitionCounts.dialogueOnlyToMixed-previous.classificationTransitionCounts.dialogueOnlyToMixed,
        mixedToNarrativeOnly:
          next.classificationTransitionCounts.mixedToNarrativeOnly-previous.classificationTransitionCounts.mixedToNarrativeOnly,
        mixedToDialogueOnly:
          next.classificationTransitionCounts.mixedToDialogueOnly-previous.classificationTransitionCounts.mixedToDialogueOnly,
        mixedToMixed:
          next.classificationTransitionCounts.mixedToMixed-previous.classificationTransitionCounts.mixedToMixed
      },
      classificationChangeCountDelta:next.classificationChangeCount-previous.classificationChangeCount,
      previousRunCount:previous.runCount,
      nextRunCount:next.runCount,
      runCountDelta:next.runCount-previous.runCount,
      previousDialogueBearingRunCount:previous.dialogueBearingRunCount,
      nextDialogueBearingRunCount:next.dialogueBearingRunCount,
      dialogueBearingRunCountDelta:next.dialogueBearingRunCount-previous.dialogueBearingRunCount,
      previousNarrativeOnlyRunCount:previous.narrativeOnlyRunCount,
      nextNarrativeOnlyRunCount:next.narrativeOnlyRunCount,
      narrativeOnlyRunCountDelta:next.narrativeOnlyRunCount-previous.narrativeOnlyRunCount,
      previousLongestDialogueBearingRunParagraphs:previous.longestDialogueBearingRunParagraphs,
      nextLongestDialogueBearingRunParagraphs:next.longestDialogueBearingRunParagraphs,
      longestDialogueBearingRunParagraphsDelta:
        next.longestDialogueBearingRunParagraphs-previous.longestDialogueBearingRunParagraphs,
      previousLongestNarrativeOnlyRunParagraphs:previous.longestNarrativeOnlyRunParagraphs,
      nextLongestNarrativeOnlyRunParagraphs:next.longestNarrativeOnlyRunParagraphs,
      longestNarrativeOnlyRunParagraphsDelta:
        next.longestNarrativeOnlyRunParagraphs-previous.longestNarrativeOnlyRunParagraphs
    });
  }
  return transitions;
}

function buildSceneDialogueTransitions(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneDialogueTransition[] {
  const transitions: LiterarySceneDialogueTransition[] = [];
  for (let index=1; index<scenes.length; index++) {
    const previous = scenes[index-1]!.dialogueSignals;
    const next = scenes[index]!.dialogueSignals;
    transitions.push({
      fromSceneIndex:index,
      toSceneIndex:index+1,
      previousDensity:previous.density,
      nextDensity:next.density,
      densityChanged:previous.density !== next.density,
      previousDialogueRatio:previous.dialogueRatio,
      nextDialogueRatio:next.dialogueRatio,
      dialogueRatioDelta:roundMetric(next.dialogueRatio-previous.dialogueRatio),
      previousDialogueWordsPer1000NarrativeWords:previous.dialogueWordsPer1000NarrativeWords,
      nextDialogueWordsPer1000NarrativeWords:next.dialogueWordsPer1000NarrativeWords,
      dialogueWordsPer1000NarrativeWordsDelta:roundMetric(
        next.dialogueWordsPer1000NarrativeWords-previous.dialogueWordsPer1000NarrativeWords
      ),
      previousSegmentCount:previous.segmentCount,
      nextSegmentCount:next.segmentCount,
      segmentCountDelta:next.segmentCount-previous.segmentCount,
      previousDialogueWordCount:previous.dialogueWordCount,
      nextDialogueWordCount:next.dialogueWordCount,
      dialogueWordCountDelta:next.dialogueWordCount-previous.dialogueWordCount,
      previousAverageWordsPerSegment:previous.averageWordsPerSegment,
      nextAverageWordsPerSegment:next.averageWordsPerSegment,
      averageWordsPerSegmentDelta:roundMetric(next.averageWordsPerSegment-previous.averageWordsPerSegment),
      previousLongestSegmentWords:previous.longestSegmentWords,
      nextLongestSegmentWords:next.longestSegmentWords,
      longestSegmentWordsDelta:next.longestSegmentWords-previous.longestSegmentWords,
      formatCountDelta:{
        quotation:next.formatCounts.quotation-previous.formatCounts.quotation,
        dialogueDash:next.formatCounts.dialogueDash-previous.formatCounts.dialogueDash,
        mixed:next.formatCounts.mixed-previous.formatCounts.mixed
      }
    });
  }
  return transitions;
}

function buildSceneCadenceTransitions(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneCadenceTransition[] {
  const transitions: LiterarySceneCadenceTransition[] = [];
  const patternTypes: readonly LiterarySceneCadencePatternType[] = [
    "stable-length-band-run",
    "alternating-length-band-run",
    "ascending-length-run",
    "descending-length-run"
  ];
  for (let index=1; index<scenes.length; index++) {
    const previous=scenes[index-1]!.rhythmSignals.cadence;
    const next=scenes[index]!.rhythmSignals.cadence;
    const sentenceBandCountDelta = {
      short:next.sentenceBandCounts.short-previous.sentenceBandCounts.short,
      medium:next.sentenceBandCounts.medium-previous.sentenceBandCounts.medium,
      long:next.sentenceBandCounts.long-previous.sentenceBandCounts.long
    };
    const bandTransitionCountDelta = {
      shortToShort:next.bandTransitionCounts.shortToShort-previous.bandTransitionCounts.shortToShort,
      shortToMedium:next.bandTransitionCounts.shortToMedium-previous.bandTransitionCounts.shortToMedium,
      shortToLong:next.bandTransitionCounts.shortToLong-previous.bandTransitionCounts.shortToLong,
      mediumToShort:next.bandTransitionCounts.mediumToShort-previous.bandTransitionCounts.mediumToShort,
      mediumToMedium:next.bandTransitionCounts.mediumToMedium-previous.bandTransitionCounts.mediumToMedium,
      mediumToLong:next.bandTransitionCounts.mediumToLong-previous.bandTransitionCounts.mediumToLong,
      longToShort:next.bandTransitionCounts.longToShort-previous.bandTransitionCounts.longToShort,
      longToMedium:next.bandTransitionCounts.longToMedium-previous.bandTransitionCounts.longToMedium,
      longToLong:next.bandTransitionCounts.longToLong-previous.bandTransitionCounts.longToLong
    };
    const patternTypeCountDelta = {
      stableLengthBandRun:next.patternTypeCounts.stableLengthBandRun-previous.patternTypeCounts.stableLengthBandRun,
      alternatingLengthBandRun:next.patternTypeCounts.alternatingLengthBandRun-previous.patternTypeCounts.alternatingLengthBandRun,
      ascendingLengthRun:next.patternTypeCounts.ascendingLengthRun-previous.patternTypeCounts.ascendingLengthRun,
      descendingLengthRun:next.patternTypeCounts.descendingLengthRun-previous.patternTypeCounts.descendingLengthRun
    };
    const typeCount = (profile: typeof previous, type: LiterarySceneCadencePatternType): number => {
      switch (type) {
        case "stable-length-band-run": return profile.patternTypeCounts.stableLengthBandRun;
        case "alternating-length-band-run": return profile.patternTypeCounts.alternatingLengthBandRun;
        case "ascending-length-run": return profile.patternTypeCounts.ascendingLengthRun;
        case "descending-length-run": return profile.patternTypeCounts.descendingLengthRun;
      }
    };
    transitions.push({
      fromSceneIndex:scenes[index-1]!.sceneIndex,
      toSceneIndex:scenes[index]!.sceneIndex,
      sentenceBandCountDelta,
      bandTransitionCountDelta,
      patternCountDelta:next.patternCount-previous.patternCount,
      patternTypeCountDelta,
      newlyDetectedPatternTypes:patternTypes.filter(type =>
        typeCount(previous,type)===0 && typeCount(next,type)>0
      ),
      noLongerDetectedPatternTypes:patternTypes.filter(type =>
        typeCount(previous,type)>0 && typeCount(next,type)===0
      )
    });
  }
  return transitions;
}

function buildSceneCadenceMotifs(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneCadenceMotifAnalysis {
  interface MotifGroup {
    patternType: LiterarySceneCadencePatternType;
    lengthBands: readonly LiterarySentenceLengthBand[];
    instances: LiterarySceneCadenceMotifInstance[];
    sceneIndexes: Set<number>;
  }
  const groups = new Map<string,MotifGroup>();
  let candidatePatternCount = 0;
  let sampledPatternCount = 0;
  for (const scene of scenes) {
    const cadence = scene.rhythmSignals.cadence;
    candidatePatternCount += cadence.patternCount;
    sampledPatternCount += cadence.patterns.length;
    for (const pattern of cadence.patterns) {
      const signature = `${pattern.patternType}:${pattern.lengthBands.join(",")}`;
      let group = groups.get(signature);
      if (!group) {
        group = {
          patternType:pattern.patternType,
          lengthBands:[...pattern.lengthBands],
          instances:[],
          sceneIndexes:new Set<number>()
        };
        groups.set(signature,group);
      }
      group.sceneIndexes.add(scene.sceneIndex);
      group.instances.push({
        sceneIndex:scene.sceneIndex,
        fromSentenceIndex:pattern.fromSentenceIndex,
        toSentenceIndex:pattern.toSentenceIndex,
        sentenceWordCounts:[...pattern.sentenceWordCounts],
        occurrences:pattern.occurrences.map(item => ({start:item.start,end:item.end})),
        evidenceTruncated:pattern.evidenceTruncated
      });
    }
  }

  const motifs = [...groups.values()]
    .filter(group => group.sceneIndexes.size >= 2)
    .map(group => ({
      patternType:group.patternType,
      lengthBands:group.lengthBands,
      sceneIndexes:[...group.sceneIndexes].sort((a,b) => a-b),
      sceneCount:group.sceneIndexes.size,
      occurrenceCount:group.instances.length,
      instances:group.instances.slice(0,40),
      instancesTruncated:group.instances.length>40
    }))
    .sort((a,b) =>
      b.sceneCount-a.sceneCount ||
      b.occurrenceCount-a.occurrenceCount ||
      a.patternType.localeCompare(b.patternType,"en") ||
      a.lengthBands.join(",").localeCompare(b.lengthBands.join(","),"en")
    );
  return {
    candidatePatternCount,
    sampledPatternCount,
    omittedPatternCount:Math.max(0,candidatePatternCount-sampledPatternCount),
    motifCount:motifs.length,
    motifs:motifs.slice(0,20)
  };
}

function buildSceneRhythmTransitions(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneRhythmTransition[] {
  const transitions: LiterarySceneRhythmTransition[] = [];
  for (let index = 1; index < scenes.length; index++) {
    const previous = scenes[index - 1]!;
    const next = scenes[index]!;
    transitions.push({
      fromSceneIndex:previous.sceneIndex,
      toSceneIndex:next.sceneIndex,
      previousRhythmProfile:previous.rhythmSignals.rhythmProfile,
      nextRhythmProfile:next.rhythmSignals.rhythmProfile,
      rhythmProfileChanged:previous.rhythmSignals.rhythmProfile !== next.rhythmSignals.rhythmProfile,
      previousAverageWordsPerSentence:previous.rhythmSignals.averageWordsPerSentence,
      nextAverageWordsPerSentence:next.rhythmSignals.averageWordsPerSentence,
      averageWordsPerSentenceDelta:roundMetric(
        next.rhythmSignals.averageWordsPerSentence-previous.rhythmSignals.averageWordsPerSentence
      ),
      previousSentenceCount:previous.rhythmSignals.sentenceCount,
      nextSentenceCount:next.rhythmSignals.sentenceCount,
      sentenceCountDelta:next.rhythmSignals.sentenceCount-previous.rhythmSignals.sentenceCount,
      previousTransitionCount:previous.rhythmSignals.transitions.length,
      nextTransitionCount:next.rhythmSignals.transitions.length,
      transitionCountDelta:next.rhythmSignals.transitions.length-previous.rhythmSignals.transitions.length
    });
  }
  return transitions;
}

function buildSceneEventAssociationTransitions(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneEventAssociationTransition[] {
  const transitions: LiterarySceneEventAssociationTransition[] = [];
  for (let index=1; index<scenes.length; index++) {
    const previous=scenes[index-1]!;
    const next=scenes[index]!;
    const previousEvents=new Map(previous.eventLinks.map(event=>[event.eventId,event] as const));
    const nextEvents=new Map(next.eventLinks.map(event=>[event.eventId,event] as const));
    const eventIds=[...new Set([...previousEvents.keys(),...nextEvents.keys()])]
      .sort((a,b)=>a.localeCompare(b,"en"));

    for(const eventId of eventIds) {
      const previousEvent=previousEvents.get(eventId);
      const nextEvent=nextEvents.get(eventId);
      let status: LiterarySceneEventAssociationStatus;
      if(previousEvent && nextEvent) status="evidence-in-both-scenes";
      else if(previousEvent) status=next.eventLinksTruncated
        ? "source-truncated-in-next-scene" : "evidence-only-in-previous-scene";
      else status=previous.eventLinksTruncated
        ? "source-truncated-in-previous-scene" : "evidence-only-in-next-scene";

      const previousEvidenceRangeCount=previousEvent?.matchingEvidenceCount ??
        (previous.eventLinksTruncated ? null : 0);
      const nextEvidenceRangeCount=nextEvent?.matchingEvidenceCount ??
        (next.eventLinksTruncated ? null : 0);
      const participantIds=[...new Set([
        ...(previousEvent?.participants.map(participant=>participant.entityId) ?? []),
        ...(nextEvent?.participants.map(participant=>participant.entityId) ?? [])
      ])].sort((a,b)=>a.localeCompare(b,"en"));
      const participants=participantIds.map(entityId=>{
        const previousParticipant=previousEvent?.participants.find(item=>item.entityId===entityId);
        const nextParticipant=nextEvent?.participants.find(item=>item.entityId===entityId);
        const previousMentionedByName=previousParticipant?.mentionedByName ?? null;
        const nextMentionedByName=nextParticipant?.mentionedByName ?? null;
        let participantStatus: LiterarySceneEventParticipantMentionStatus;
        if(previousMentionedByName===null) {
          participantStatus=previous.eventLinksTruncated
            ? "source-truncated-in-previous-scene"
            : "no-event-evidence-in-previous-scene";
        } else if(nextMentionedByName===null) {
          participantStatus=next.eventLinksTruncated
            ? "source-truncated-in-next-scene"
            : "no-event-evidence-in-next-scene";
        } else if(previousMentionedByName && nextMentionedByName) {
          participantStatus="mentioned-in-both-scenes";
        } else if(previousMentionedByName) {
          participantStatus="mentioned-only-in-previous-scene";
        } else if(nextMentionedByName) {
          participantStatus="mentioned-only-in-next-scene";
        } else {
          participantStatus="not-mentioned-in-either-linked-scene";
        }
        return {
          entityId,
          previousMentionedByName,
          nextMentionedByName,
          status:participantStatus
        };
      });
      transitions.push({
        fromSceneIndex:previous.sceneIndex,
        toSceneIndex:next.sceneIndex,
        eventId,
        label:previousEvent?.label ?? nextEvent!.label,
        status,
        previousEvidenceRangeCount,
        nextEvidenceRangeCount,
        evidenceRangeCountDelta:previousEvidenceRangeCount===null || nextEvidenceRangeCount===null
          ? null : nextEvidenceRangeCount-previousEvidenceRangeCount,
        participants
      });
    }
  }
  return transitions;
}

function buildSceneContinuity(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneContinuityTransition[] {
  const transitions: LiterarySceneContinuityTransition[] = [];
  for (let index = 1; index < scenes.length; index++) {
    const previous = scenes[index - 1]!;
    const next = scenes[index]!;

    const previousCharacters = new Map(
      previous.characterMentions.map(mention => [mention.entityId, mention.occurrences] as const)
    );
    const nextCharacters = new Map(
      next.characterMentions.map(mention => [mention.entityId, mention.occurrences] as const)
    );
    const characterIds = [...new Set([
      ...previousCharacters.keys(), ...nextCharacters.keys()
    ])].sort((a,b) => a.localeCompare(b,"en"));
    const characterSignals: LiterarySceneCharacterContinuitySignal[] = characterIds.map(entityId => {
      const previousMentions = previousCharacters.get(entityId) ?? [];
      const nextMentions = nextCharacters.get(entityId) ?? [];
      const status: LiterarySceneCharacterContinuityStatus =
        previousMentions.length > 0 && nextMentions.length > 0
          ? "mentioned-in-both-scenes"
          : previousMentions.length > 0
            ? "not-mentioned-in-next-scene"
            : "mentioned-only-in-next-scene";
      return {
        entityId,
        status,
        previousMentions: previousMentions.map(item => ({start:item.start,end:item.end})),
        nextMentions: nextMentions.map(item => ({start:item.start,end:item.end}))
      };
    });

    const previousEvents = new Map(previous.eventLinks.map(event => [event.eventId,event] as const));
    const nextEvents = new Map(next.eventLinks.map(event => [event.eventId,event] as const));
    const eventIds = [...new Set([
      ...previousEvents.keys(), ...nextEvents.keys()
    ])].sort((a,b) => a.localeCompare(b,"en"));
    const eventSignals: LiterarySceneEventContinuitySignal[] = eventIds.map(eventId => {
      const previousEvent = previousEvents.get(eventId);
      const nextEvent = nextEvents.get(eventId);
      const previousEvidence = previousEvent?.matchingEvidence ?? [];
      const nextEvidence = nextEvent?.matchingEvidence ?? [];
      const status: LiterarySceneEventContinuityStatus =
        previousEvidence.length > 0 && nextEvidence.length > 0
          ? "evidence-in-both-scenes"
          : previousEvidence.length > 0
            ? "evidence-only-in-previous-scene"
            : "evidence-only-in-next-scene";
      return {
        eventId,
        label: previousEvent?.label ?? nextEvent!.label,
        status,
        previousEvidence: previousEvidence.map(item => ({start:item.start,end:item.end})),
        nextEvidence: nextEvidence.map(item => ({start:item.start,end:item.end}))
      };
    });

    transitions.push({
      fromSceneIndex:previous.sceneIndex,
      toSceneIndex:next.sceneIndex,
      characterSignals,
      eventSignals
    });
  }
  return transitions;
}

function compareSceneVoiceSignals(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneVoiceTransition[] {
  const categories: readonly (keyof LiteraryVoiceSignalCounts)[] = [
    "firstPerson","secondPerson","thirdPerson"
  ];
  const transitions: LiterarySceneVoiceTransition[] = [];
  for (let index = 1; index < scenes.length; index++) {
    const previous = scenes[index - 1]!;
    const next = scenes[index]!;
    const countDelta: LiteraryVoiceSignalCounts = {
      firstPerson:next.voiceSignals.counts.firstPerson-previous.voiceSignals.counts.firstPerson,
      secondPerson:next.voiceSignals.counts.secondPerson-previous.voiceSignals.counts.secondPerson,
      thirdPerson:next.voiceSignals.counts.thirdPerson-previous.voiceSignals.counts.thirdPerson
    };
    const changedCategories = categories.filter(category => countDelta[category] !== 0);
    transitions.push({
      fromSceneIndex:previous.sceneIndex,
      toSceneIndex:next.sceneIndex,
      previousClassification:previous.voiceSignals.classification,
      nextClassification:next.voiceSignals.classification,
      classificationChanged:
        previous.voiceSignals.classification !== next.voiceSignals.classification,
      countDelta,
      changedCategories
    });
  }
  return transitions;
}

function buildSceneVoiceProfile(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneVoiceProfile {
  const categories: readonly (keyof LiteraryVoiceSignalCounts)[] = [
    "firstPerson","secondPerson","thirdPerson"
  ];
  const categoryTotals = {firstPerson:0,secondPerson:0,thirdPerson:0};
  const scenesWithOccurrences: Record<keyof LiteraryVoiceSignalCounts,number> = {
    firstPerson:0,secondPerson:0,thirdPerson:0
  };
  const classificationSceneCounts = {
    firstPerson:0,secondPerson:0,thirdPerson:0,mixed:0,undetermined:0
  };
  let totalSignals = 0;
  let totalNarrativeWordCount = 0;

  for (const scene of scenes) {
    const counts = scene.voiceSignals.counts;
    totalNarrativeWordCount += scene.narrativeWordCount;
    for (const category of categories) {
      categoryTotals[category] += counts[category];
      if (counts[category] > 0) scenesWithOccurrences[category]++;
    }
    totalSignals += counts.firstPerson + counts.secondPerson + counts.thirdPerson;
    switch (scene.voiceSignals.classification) {
      case "first-person-signals": classificationSceneCounts.firstPerson++; break;
      case "second-person-signals": classificationSceneCounts.secondPerson++; break;
      case "third-person-signals": classificationSceneCounts.thirdPerson++; break;
      case "mixed-signals": classificationSceneCounts.mixed++; break;
      case "undetermined": classificationSceneCounts.undetermined++; break;
    }
  }

  const categoryRatesPer1000Words: LiteraryVoiceSignalCounts = {
    firstPerson:totalNarrativeWordCount > 0
      ? roundMetric(categoryTotals.firstPerson/totalNarrativeWordCount*1000) : 0,
    secondPerson:totalNarrativeWordCount > 0
      ? roundMetric(categoryTotals.secondPerson/totalNarrativeWordCount*1000) : 0,
    thirdPerson:totalNarrativeWordCount > 0
      ? roundMetric(categoryTotals.thirdPerson/totalNarrativeWordCount*1000) : 0
  };
  return {
    sceneCount:scenes.length,
    totalSignals,
    totalNarrativeWordCount,
    categoryTotals,
    categoryRatesPer1000Words,
    totalRatePer1000Words:totalNarrativeWordCount > 0
      ? roundMetric(totalSignals/totalNarrativeWordCount*1000) : 0,
    classificationSceneCounts,
    categoryCoverage:categories.map(category => ({
      category,
      occurrences:categoryTotals[category],
      scenesWithOccurrences:scenesWithOccurrences[category],
      sceneShare:scenes.length > 0
        ? roundMetric(scenesWithOccurrences[category]/scenes.length)
        : 0
    })),
    sceneSnapshots:scenes.map(scene => {
      const counts = scene.voiceSignals.counts;
      const narrativeWordCount = scene.narrativeWordCount;
      const ratesPer1000Words: LiteraryVoiceSignalCounts = {
        firstPerson:narrativeWordCount > 0
          ? roundMetric(counts.firstPerson/narrativeWordCount*1000) : 0,
        secondPerson:narrativeWordCount > 0
          ? roundMetric(counts.secondPerson/narrativeWordCount*1000) : 0,
        thirdPerson:narrativeWordCount > 0
          ? roundMetric(counts.thirdPerson/narrativeWordCount*1000) : 0
      };
      const totalSignals = counts.firstPerson + counts.secondPerson + counts.thirdPerson;
      return {
        sceneIndex:scene.sceneIndex,
        classification:scene.voiceSignals.classification,
        counts:{...counts},
        totalSignals,
        narrativeWordCount,
        ratesPer1000Words,
        totalRatePer1000Words:narrativeWordCount > 0
          ? roundMetric(totalSignals/narrativeWordCount*1000) : 0
      };
    })
  };
}

function buildSceneVoiceSequences(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneVoiceSequencePattern[] {
  const snapshots: LiterarySceneVoiceSnapshot[] = scenes.map(scene => {
    const counts = scene.voiceSignals.counts;
    const narrativeWordCount = scene.narrativeWordCount;
    const ratesPer1000Words: LiteraryVoiceSignalCounts = {
      firstPerson:narrativeWordCount > 0
        ? roundMetric(counts.firstPerson/narrativeWordCount*1000) : 0,
      secondPerson:narrativeWordCount > 0
        ? roundMetric(counts.secondPerson/narrativeWordCount*1000) : 0,
      thirdPerson:narrativeWordCount > 0
        ? roundMetric(counts.thirdPerson/narrativeWordCount*1000) : 0
    };
    const totalSignals = counts.firstPerson + counts.secondPerson + counts.thirdPerson;
    return {
      sceneIndex:scene.sceneIndex,
      classification:scene.voiceSignals.classification,
      counts:{...counts},
      totalSignals,
      narrativeWordCount,
      ratesPer1000Words,
      totalRatePer1000Words:narrativeWordCount > 0
        ? roundMetric(totalSignals/narrativeWordCount*1000) : 0
    };
  });
  const isSinglePersonClassification = (
    value: LiteraryVoiceSignalClassification
  ): boolean => value === "first-person-signals" ||
    value === "second-person-signals" || value === "third-person-signals";
  const patterns: LiterarySceneVoiceSequencePattern[] = [];

  // Un tramo estable requiere tres escenas consecutivas con la misma señal única.
  let index = 0;
  while (index < scenes.length) {
    const classification = scenes[index]!.voiceSignals.classification;
    if (!isSinglePersonClassification(classification)) {
      index++;
      continue;
    }
    let end = index + 1;
    while (end < scenes.length &&
      scenes[end]!.voiceSignals.classification === classification) end++;
    if (end - index >= 3) {
      patterns.push({
        patternType:"stable-classification-run",
        fromSceneIndex:scenes[index]!.sceneIndex,
        toSceneIndex:scenes[end-1]!.sceneIndex,
        classifications:scenes.slice(index,end).map(scene => scene.voiceSignals.classification),
        sceneSnapshots:snapshots.slice(index,end)
      });
    }
    index = end;
  }

  // Una alternancia exige cuatro escenas y dos clasificaciones únicas diferentes.
  for (let start = 0; start + 3 < scenes.length;) {
    const first = scenes[start]!.voiceSignals.classification;
    const second = scenes[start+1]!.voiceSignals.classification;
    if (!isSinglePersonClassification(first) ||
        !isSinglePersonClassification(second) || first === second) {
      start++;
      continue;
    }
    // Evita publicar un subtramo si la alternancia ya comenzó en la escena previa.
    if (start > 0 && scenes[start-1]!.voiceSignals.classification === second) {
      start++;
      continue;
    }
    let end = start + 2;
    while (end < scenes.length) {
      const expected = (end-start) % 2 === 0 ? first : second;
      if (scenes[end]!.voiceSignals.classification !== expected) break;
      end++;
    }
    if (end - start >= 4) {
      patterns.push({
        patternType:"alternating-classification-run",
        fromSceneIndex:scenes[start]!.sceneIndex,
        toSceneIndex:scenes[end-1]!.sceneIndex,
        classifications:scenes.slice(start,end).map(scene => scene.voiceSignals.classification),
        sceneSnapshots:snapshots.slice(start,end)
      });
      start = end;
    } else start++;
  }

  return patterns.sort((a,b) =>
    a.fromSceneIndex-b.fromSceneIndex ||
    a.toSceneIndex-b.toSceneIndex ||
    a.patternType.localeCompare(b.patternType,"en")
  );
}

function findCharacterCoMentionPatterns(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiteraryCharacterCoMentionPattern[] {
  const groups = new Map<string,{
    readonly characterIds: readonly [string,string];
    sceneIndexes: number[];
  }>();
  for (const scene of scenes) {
    const entityIds = [...new Set(
      scene.characterMentions.map(mention => mention.entityId)
    )].sort((a,b) => a.localeCompare(b,"en"));
    for (let left = 0; left < entityIds.length; left++) {
      for (let right = left + 1; right < entityIds.length; right++) {
        const first = entityIds[left]!;
        const second = entityIds[right]!;
        const key = JSON.stringify([first,second]);
        const group = groups.get(key) ?? {
          characterIds:[first,second] as const,
          sceneIndexes:[]
        };
        group.sceneIndexes.push(scene.sceneIndex);
        groups.set(key,group);
      }
    }
  }
  return [...groups.values()]
    .sort((a,b) =>
      b.sceneIndexes.length-a.sceneIndexes.length ||
      a.characterIds[0].localeCompare(b.characterIds[0],"en") ||
      a.characterIds[1].localeCompare(b.characterIds[1],"en")
    )
    .slice(0,100)
    .map(group => ({
      characterIds:group.characterIds,
      sharedSceneCount:group.sceneIndexes.length,
      sceneIndexes:[...group.sceneIndexes]
    }));
}

function buildSceneEventEvidenceProfiles(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneEventEvidenceAnalysis {
  const groups = new Map<string,{
    readonly eventId: string;
    readonly eventLabel: string;
    sceneEvidence: Map<number,{
      readonly evidenceRangeCount: number;
      readonly evidenceSamplesTruncated: boolean;
    }>;
    totalEvidenceRangeCount: number;
  }>();

  for (const scene of scenes) {
    for (const event of scene.eventLinks) {
      const group = groups.get(event.eventId) ?? {
        eventId:event.eventId,
        eventLabel:event.label,
        sceneEvidence:new Map<number,{
          readonly evidenceRangeCount:number;
          readonly evidenceSamplesTruncated:boolean;
        }>(),
        totalEvidenceRangeCount:0
      };
      group.sceneEvidence.set(scene.sceneIndex,{
        evidenceRangeCount:event.matchingEvidenceCount,
        evidenceSamplesTruncated:event.matchingEvidenceTruncated
      });
      group.totalEvidenceRangeCount += event.matchingEvidenceCount;
      groups.set(event.eventId,group);
    }
  }

  const profiles = [...groups.values()].map(group => {
    const sceneIndexes = scenes
      .filter(scene => group.sceneEvidence.has(scene.sceneIndex))
      .map(scene => scene.sceneIndex);
    const firstSceneIndex = sceneIndexes[0] ?? 0;
    const lastSceneIndex = sceneIndexes[sceneIndexes.length-1] ?? 0;
    let longestConsecutiveSceneRun = 0;
    let currentRun = 0;
    let previousSceneIndex = Number.NEGATIVE_INFINITY;
    for (const sceneIndex of sceneIndexes) {
      currentRun = sceneIndex === previousSceneIndex+1 ? currentRun+1 : 1;
      longestConsecutiveSceneRun = Math.max(longestConsecutiveSceneRun,currentRun);
      previousSceneIndex = sceneIndex;
    }
    return {
      eventId:group.eventId,
      eventLabel:group.eventLabel,
      sceneIndexes,
      sceneCount:sceneIndexes.length,
      firstSceneIndex,
      lastSceneIndex,
      interveningSceneCount:Math.max(0,lastSceneIndex-firstSceneIndex+1-sceneIndexes.length),
      longestConsecutiveSceneRun,
      totalEvidenceRangeCount:group.totalEvidenceRangeCount,
      scenes:scenes.map(scene => {
        const evidence = group.sceneEvidence.get(scene.sceneIndex);
        return {
          sceneIndex:scene.sceneIndex,
          evidenceRangeCount:evidence?.evidenceRangeCount ?? null,
          evidenceSamplesTruncated:evidence?.evidenceSamplesTruncated ?? null
        };
      })
    };
  }).sort((a,b) =>
    b.sceneCount-a.sceneCount ||
    b.longestConsecutiveSceneRun-a.longestConsecutiveSceneRun ||
    b.totalEvidenceRangeCount-a.totalEvidenceRangeCount ||
    a.eventId.localeCompare(b.eventId,"en")
  );

  const sourceTruncatedSceneIndexes = scenes
    .filter(scene => scene.eventLinksTruncated)
    .map(scene => scene.sceneIndex);
  return {
    explicitSceneCount:scenes.length,
    sourceTruncatedSceneCount:sourceTruncatedSceneIndexes.length,
    sourceTruncatedSceneIndexes,
    eventCount:profiles.length,
    omittedEventCount:Math.max(0,profiles.length-100),
    profiles:profiles.slice(0,100)
  };
}

function buildEventLifecycleAnalysis(
  knownEvents: readonly LiteraryAnalysisKnownEvent[],
  lifecycles: readonly EventLifecycle[]
): LiteraryEventLifecycleAnalysis {
  const currentEvents=new Map(knownEvents.map(event=>[event.eventId,event] as const));
  const groups=new Map<string,EventLifecycle[]>();
  for(const item of lifecycles) {
    const group=groups.get(item.eventId) ?? [];
    group.push(item);
    groups.set(item.eventId,group);
  }
  const profiles=[...groups.entries()].map(([eventId,history])=>{
    const ordered=[...history].sort((a,b)=>a.revision-b.revision);
    const currentEvent=currentEvents.get(eventId)!;
    const currentParticipantIds=[...new Set(currentEvent.participants)].sort((a,b)=>a.localeCompare(b,"en"));
    const latest=ordered[ordered.length-1]!;
    const latestRecordedParticipantIds=[...latest.newParticipants];
    let labelChangeCount=0;
    let participantSetChangeCount=0;
    const changes:LiteraryEventLifecycleChangeSummary[]=ordered.map(item=>{
      const previous=new Set(item.previousParticipants);
      const next=new Set(item.newParticipants);
      const addedParticipantIds=item.newParticipants.filter(id=>!previous.has(id));
      const removedParticipantIds=item.previousParticipants.filter(id=>!next.has(id));
      const labelChanged=item.previousLabel!==item.newLabel;
      const participantSetChanged=addedParticipantIds.length>0 || removedParticipantIds.length>0;
      if(labelChanged)labelChangeCount++;
      if(participantSetChanged)participantSetChangeCount++;
      return {
        revision:item.revision,
        previousLabel:item.previousLabel,
        newLabel:item.newLabel,
        labelChanged,
        addedParticipantIds,
        removedParticipantIds,
        participantSetChanged,
        changedBy:item.changedBy,
        changeReason:item.changeReason ?? null,
        changedAt:item.changedAt
      };
    });
    return {
      eventId,
      currentLabel:currentEvent.label,
      currentParticipantIds,
      latestRecordedLabel:latest.newLabel,
      latestRecordedParticipantIds,
      currentStateMatchesLatestRevision:latest.newLabel===currentEvent.label &&
        latestRecordedParticipantIds.length===currentParticipantIds.length &&
        latestRecordedParticipantIds.every((id,index)=>id===currentParticipantIds[index]),
      latestRevision:latest.revision,
      transitionCount:ordered.length,
      labelChangeCount,
      participantSetChangeCount,
      changes:changes.slice(-100),
      changesTruncated:changes.length>100
    };
  }).sort((a,b)=>
    b.transitionCount-a.transitionCount ||
    a.eventId.localeCompare(b.eventId,"en")
  );
  return {
    eventCount:profiles.length,
    totalTransitionCount:profiles.reduce((sum,profile)=>sum+profile.transitionCount,0),
    omittedEventCount:Math.max(0,profiles.length-100),
    profiles:profiles.slice(0,100)
  };
}

function buildSceneEventSequenceMotifs(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneEventSequenceMotifAnalysis {
  const groups = new Map<string,{
    readonly sceneCount: 2 | 3;
    readonly sceneSequence: LiterarySceneEventSequenceStep[];
    instances: LiterarySceneEventSequenceInstance[];
  }>();
  let candidateWindowCount = 0;
  let analyzedWindowCount = 0;
  let emptyWindowCount = 0;
  let sourceTruncatedWindowCount = 0;

  for (const sceneCount of [2,3] as const) {
    for (let start=0; start+sceneCount<=scenes.length; start++) {
      candidateWindowCount++;
      const window = scenes.slice(start,start+sceneCount);
      if (window.some(scene => scene.eventLinksTruncated)) {
        sourceTruncatedWindowCount++;
        continue;
      }
      const sceneSequence: LiterarySceneEventSequenceStep[] = window.map((scene,index) => ({
        sceneOffset:index+1,
        eventIds:[...new Set(scene.eventLinks.map(event => event.eventId))]
          .sort((a,b) => a.localeCompare(b,"en"))
      }));
      if (sceneSequence.every(step => step.eventIds.length===0)) {
        emptyWindowCount++;
        continue;
      }
      analyzedWindowCount++;
      const key = JSON.stringify(sceneSequence.map(step => step.eventIds));
      const groupKey = JSON.stringify([sceneCount,key]);
      const group = groups.get(groupKey) ?? {
        sceneCount,
        sceneSequence,
        instances:[]
      };
      group.instances.push({
        fromSceneIndex:window[0]!.sceneIndex,
        toSceneIndex:window[window.length-1]!.sceneIndex
      });
      groups.set(groupKey,group);
    }
  }

  const motifs = [...groups.values()]
    .filter(group => group.instances.length>=2)
    .sort((a,b) =>
      b.instances.length-a.instances.length ||
      b.sceneCount-a.sceneCount ||
      a.instances[0]!.fromSceneIndex-b.instances[0]!.fromSceneIndex ||
      JSON.stringify(a.sceneSequence).localeCompare(JSON.stringify(b.sceneSequence),"en")
    )
    .map(group => ({
      sceneCount:group.sceneCount,
      sceneSequence:group.sceneSequence,
      occurrenceCount:group.instances.length,
      instances:group.instances.slice(0,20),
      instancesTruncated:group.instances.length>20
    }));

  return {
    explicitSceneCount:scenes.length,
    candidateWindowCount,
    analyzedWindowCount,
    emptyWindowCount,
    sourceTruncatedWindowCount,
    motifCount:motifs.length,
    omittedMotifCount:Math.max(0,motifs.length-50),
    motifs:motifs.slice(0,50)
  };
}

function buildCharacterEventEvidenceProfiles(
  scenes: readonly LiteraryExplicitSceneSegment[],
  knownCharacters: readonly LiteraryAnalysisKnownCharacter[]
): LiteraryCharacterEventEvidenceAnalysis {
  const canonicalNames = new Map<string,string>(
    knownCharacters.map(character => [character.entityId,character.canonicalName] as const)
  );
  const groups = new Map<string,{
    readonly entityId: string;
    readonly eventId: string;
    readonly eventLabel: string;
    sceneIndexes: number[];
    totalEvidenceRangeCount: number;
    participantMentionedByNameSceneCount: number;
    sceneEvidence: Map<number,{
      readonly evidenceRangeCount: number;
      readonly participantMentionedByName: boolean;
    }>;
  }>();

  for (const scene of scenes) {
    for (const mention of scene.characterMentions) {
      if (!canonicalNames.has(mention.entityId)) {
        canonicalNames.set(mention.entityId,mention.canonicalName);
      }
    }
    for (const event of scene.eventLinks) {
      for (const participant of event.participants) {
        const key = JSON.stringify([participant.entityId,event.eventId]);
        const group = groups.get(key) ?? {
          entityId:participant.entityId,
          eventId:event.eventId,
          eventLabel:event.label,
          sceneIndexes:[],
          totalEvidenceRangeCount:0,
          participantMentionedByNameSceneCount:0,
          sceneEvidence:new Map<number,{
            readonly evidenceRangeCount:number;
            readonly participantMentionedByName:boolean;
          }>()
        };
        group.sceneIndexes.push(scene.sceneIndex);
        group.totalEvidenceRangeCount += event.matchingEvidenceCount;
        if (participant.mentionedByName) group.participantMentionedByNameSceneCount++;
        group.sceneEvidence.set(scene.sceneIndex,{
          evidenceRangeCount:event.matchingEvidenceCount,
          participantMentionedByName:participant.mentionedByName
        });
        groups.set(key,group);
      }
    }
  }

  const profiles = [...groups.values()].map(group => {
    const sceneIndexes = [...group.sceneIndexes];
    const firstSceneIndex = sceneIndexes[0] ?? 0;
    const lastSceneIndex = sceneIndexes[sceneIndexes.length-1] ?? 0;
    return {
      entityId:group.entityId,
      canonicalName:canonicalNames.get(group.entityId) ?? null,
      eventId:group.eventId,
      eventLabel:group.eventLabel,
      sceneIndexes,
      eventEvidenceSceneCount:sceneIndexes.length,
      firstSceneIndex,
      lastSceneIndex,
      interveningSceneCount:Math.max(0,lastSceneIndex-firstSceneIndex+1-sceneIndexes.length),
      totalEvidenceRangeCount:group.totalEvidenceRangeCount,
      participantMentionedByNameSceneCount:group.participantMentionedByNameSceneCount,
      scenes:scenes.map(scene => {
        const evidence = group.sceneEvidence.get(scene.sceneIndex);
        return {
          sceneIndex:scene.sceneIndex,
          evidenceRangeCount:evidence?.evidenceRangeCount ?? null,
          participantMentionedByName:evidence?.participantMentionedByName ?? null
        };
      })
    };
  }).sort((a,b) =>
    b.eventEvidenceSceneCount-a.eventEvidenceSceneCount ||
    b.totalEvidenceRangeCount-a.totalEvidenceRangeCount ||
    a.entityId.localeCompare(b.entityId,"en") ||
    a.eventId.localeCompare(b.eventId,"en")
  );

  const sourceTruncatedSceneIndexes = scenes
    .filter(scene => scene.eventLinksTruncated)
    .map(scene => scene.sceneIndex);
  return {
    explicitSceneCount:scenes.length,
    sourceTruncatedSceneCount:sourceTruncatedSceneIndexes.length,
    sourceTruncatedSceneIndexes,
    associationCount:profiles.length,
    omittedAssociationCount:Math.max(0,profiles.length-200),
    characterCount:new Set(profiles.map(item => item.entityId)).size,
    eventCount:new Set(profiles.map(item => item.eventId)).size,
    profiles:profiles.slice(0,200)
  };
}

function buildCharacterProjectEventTimeline(
  entityId: string,
  projectEvents: readonly LiteraryAnalysisKnownProjectEvent[]
): LiteraryCharacterProjectEventTimeline {
  const groups = new Map<string,{
    readonly timelineTrackId: string | null;
    readonly basis: NarrativeTimeReference["basis"];
    readonly precision: NarrativeTimeReference["precision"];
    readonly orderValue: number;
    events: Map<string,LiteraryAnalysisKnownProjectEvent>;
    evidence: LiteraryCharacterProjectEventTimelineEvidence[];
    evidenceCount: number;
    rawReferences: Set<string>;
    documents: Set<string>;
  }>();
  let sourceEventCount = 0;
  let timedEventCount = 0;
  let untimedEventCount = 0;
  let unverifiedEventCount = 0;
  let staleEventCount = 0;
  let staleEvidenceCount = 0;

  for (const event of projectEvents) {
    if (!event.participants.includes(entityId)) continue;
    sourceEventCount++;
    const currentEvidence = event.evidence.filter(
      (item: LiteraryAnalysisKnownEventEvidence) => item.status !== "stale"
    );
    const totalActiveEvidenceCount = event.evidenceCount ?? currentEvidence.length;
    const eventStaleEvidenceCount = event.staleEvidenceCount ??
      event.evidence.filter(
        (item: LiteraryAnalysisKnownEventEvidence) => item.status === "stale"
      ).length;
    staleEvidenceCount += eventStaleEvidenceCount;
    if (totalActiveEvidenceCount === 0) {
      if (eventStaleEvidenceCount > 0) staleEventCount++;
      else unverifiedEventCount++;
      continue;
    }
    if (!event.timeReference) {
      untimedEventCount++;
      continue;
    }
    timedEventCount++;
    const reference = event.timeReference;
    const timelineTrackId = event.timelineTrackId ?? null;
    const key = JSON.stringify([
      timelineTrackId,reference.basis,reference.precision,reference.orderValue
    ]);
    const group = groups.get(key) ?? {
      timelineTrackId,
      basis:reference.basis,
      precision:reference.precision,
      orderValue:reference.orderValue,
      events:new Map<string,LiteraryAnalysisKnownProjectEvent>(),
      evidence:[],
      evidenceCount:0,
      rawReferences:new Set<string>(),
      documents:new Set<string>()
    };
    group.events.set(event.eventId,event);
    group.evidenceCount += totalActiveEvidenceCount;
    group.rawReferences.add(reference.raw);
    for (const evidence of currentEvidence) {
      group.documents.add(evidence.documentId);
      group.evidence.push({
        eventId:event.eventId,
        eventLabel:event.label,
        documentId:evidence.documentId,
        revision:evidence.revision,
        occurrence:{start:evidence.start,end:evidence.end},
        excerpt:evidence.excerpt
      });
    }
    groups.set(key,group);
  }

  const allPoints = [...groups.values()].map(group => {
    const orderedEvents = [...group.events.keys()].sort((a,b) => a.localeCompare(b,"en"));
    const orderedEvidence = [...group.evidence].sort((a,b) =>
      a.documentId.localeCompare(b.documentId,"en") ||
      a.revision-b.revision ||
      a.occurrence.start-b.occurrence.start ||
      a.eventId.localeCompare(b.eventId,"en")
    );
    return {
      timelineTrackId:group.timelineTrackId,
      basis:group.basis,
      precision:group.precision,
      orderValue:group.orderValue,
      rawTimeReferences:[...group.rawReferences].sort((a,b) => a.localeCompare(b,"es")),
      eventCount:orderedEvents.length,
      eventIds:orderedEvents.slice(0,50),
      omittedEventIdCount:Math.max(0,orderedEvents.length-50),
      documentIds:[...group.documents].sort((a,b) => a.localeCompare(b,"en")),
      evidenceCount:group.evidenceCount,
      omittedEvidenceCount:Math.max(0,group.evidenceCount-Math.min(20,orderedEvidence.length)),
      evidenceSamples:orderedEvidence.slice(0,20),
      evidenceTruncated:group.evidenceCount>Math.min(20,orderedEvidence.length)
    };
  }).sort((a,b) =>
    (a.timelineTrackId ?? "").localeCompare(b.timelineTrackId ?? "","en") ||
    a.basis.localeCompare(b.basis,"en") ||
    a.precision.localeCompare(b.precision,"en") ||
    a.orderValue-b.orderValue
  );

  const timelineSeries = new Map<string,typeof allPoints>();
  for (const point of allPoints) {
    // Sin una pista declarada se exponen los puntos, pero no se enlazan entre sí.
    if (point.timelineTrackId === null) continue;
    const key = JSON.stringify([point.timelineTrackId,point.basis,point.precision]);
    const series = timelineSeries.get(key) ?? [];
    series.push(point);
    timelineSeries.set(key,series);
  }
  const allTransitions: LiteraryCharacterProjectEventTimelineTransition[] = [];
  for (const series of timelineSeries.values()) {
    for (let index=1; index<series.length; index++) {
      const previous = series[index-1]!;
      const next = series[index]!;
      allTransitions.push({
        timelineTrackId:previous.timelineTrackId,
        basis:previous.basis,
        precision:previous.precision,
        fromOrderValue:previous.orderValue,
        toOrderValue:next.orderValue,
        previousEventCount:previous.eventCount,
        nextEventCount:next.eventCount,
        previousEventIds:previous.eventIds,
        nextEventIds:next.eventIds
      });
    }
  }

  return {
    sourceEventCount,
    timedEventCount,
    untimedEventCount,
    unverifiedEventCount,
    staleEventCount,
    staleEvidenceCount,
    pointCount:allPoints.length,
    omittedPointCount:Math.max(0,allPoints.length-200),
    transitionCount:allTransitions.length,
    omittedTransitionCount:Math.max(0,allTransitions.length-200),
    points:allPoints.slice(0,200),
    transitions:allTransitions.slice(0,200)
  };
}

const MAX_IDEA_GRAPH_REFERENCE_SAMPLES = 5_000;
const MAX_IDEA_GRAPH_CYCLE_SAMPLES = 100;
const MAX_IDEA_GRAPH_WEAK_COMPONENT_SAMPLES = 100;
/** Presupuesto agregado máximo de texto UTF-16 transferido al análisis léxico de ideas. */
export const MAX_LITERARY_IDEA_LEXICAL_TEXT_UNITS = 2_000_000;
const MAX_IDEA_LEXICAL_TERMS_PER_IDEA = 100;
const MIN_IDEA_LEXICAL_TERM_DOCUMENT_FREQUENCY = 2;
const MAX_IDEA_LEXICAL_TERM_DOCUMENT_FREQUENCY = 40;
const MIN_IDEA_LEXICAL_SHARED_TERMS = 2;
const MAX_IDEA_LEXICAL_RESONANCE_SAMPLES = 100;
const MAX_IDEA_LEXICAL_SHARED_TERM_SAMPLES = 12;
const IDEA_PORTUGUESE_STOP_WORDS = new Set([
  "a","à","às","ao","aos","aquela","aquelas","aquele","aqueles","aquilo","as","até",
  "com","como","da","das","de","dela","delas","dele","deles","depois","do","dos","e",
  "ela","elas","ele","eles","em","entre","era","eram","essa","essas","esse","esses",
  "esta","está","estão","estas","este","estes","eu","foi","foram","há","isso","isto",
  "já","lhe","lhes","mais","mas","me","mesmo","meu","minha","muito","na","nas","nem",
  "no","nos","nós","nossa","nossas","nosso","nossos","num","numa","o","os","ou","para",
  "pela","pelas","pelo","pelos","por","porque","qual","quando","que","quem","se","sem",
  "seu","seus","sua","suas","também","te","tem","têm","tenho","ter","todo","toda",
  "todos","todas","tu","um","uma","umas","uns","você","vocês"
]);
const IDEA_ENGLISH_STOP_WORDS = new Set([
  "the","and","for","with","from","that","this","these","those","then","than","there","their","them",
  "they","you","your","yours","our","ours","his","her","hers","its","who","whom","what","when","where",
  "which","while","because","about","into","onto","over","under","between","through","during","before",
  "after","above","below","again","also","only","very","more","most","some","such","each","every","both",
  "any","all","few","many","much","other","another","same","own","once","here","there","how","why","can",
  "could","would","should","will","shall","may","might","must","not","does","did","doing","done","have",
  "has","had","having","was","were","been","being","are","am","is","be","do","of","to","in","on","by",
  "as","at","an","a","or","if","it","i","he","she","we","me","my","mine","us"
]);
const IDEA_FRENCH_STOP_WORDS = new Set([
  "a","à","au","aux","avec","ce","ces","cette","chez","comme","dans","de","des","du","elle","elles",
  "en","entre","et","eux","il","ils","je","la","le","les","leur","leurs","lui","ma","mais","me","même",
  "mes","moi","moins","mon","ne","ni","nos","notre","nous","on","ou","où","par","pas","plus","pour",
  "quand","que","quel","quelle","quelles","quels","qui","sa","sans","se","ses","son","sont","sous",
  "sur","ta","te","tes","toi","ton","tous","tout","toute","toutes","tu","un","une","vos","votre","vous",
  "y","être","été","était","étaient","est","es","sommes","êtes","ont","avoir","avait","avaient"
]);
const IDEA_ITALIAN_STOP_WORDS = new Set([
  "a","ad","al","allo","ai","agli","all","alla","alle","anche","avere","aveva","avevano","abbiamo",
  "che","chi","ci","coi","col","come","con","contro","cui","da","dal","dallo","dai","dagli","dall",
  "dalla","dalle","de","dei","degli","del","dello","della","delle","di","dopo","dove","e","è","ed",
  "era","erano","essere","fa","fra","gli","ha","hai","hanno","ho","i","il","in","io","la","le","lei",
  "li","lo","loro","lui","ma","me","mi","mia","mie","miei","mio","ne","nei","nel","nello","nella",
  "nelle","no","noi","non","nostra","nostre","nostri","nostro","o","ogni","per","perché","più","quale",
  "quali","quando","quanto","quanta","quanti","quante","quasi","quel","quella","quelle","quelli","quello",
  "questa","queste","questi","questo","qui","quindi","se","sei","senza","si","sia","siamo","siete","sono",
  "su","sul","sullo","sui","sugli","sulla","sulle","tra","tu","tua","tue","tuo","tutti","tutto","un",
  "una","uno","va","vi","voi","vostra","vostre","vostri","vostro"
]);





const IDEA_NORWEGIAN_STOP_WORDS = new Set([
  "alle","alt","alltid","andre","at","av","bak","bare","begge","ble","bli","blir","blitt","bort",
  "bra","bruk","både","da","de","deg","dem","den","denne","der","dere","deres","det","dette",
  "deg","din","disse","dit","du","då","ein","eit","eller","en","ene","enn","er","et","etter",
  "etterpå","før","for","fordi","fra","fram","frem","få","gjennom","ha","hadde","han","hans",
  "har","hennar","henne","hennes","her","hit","hva","hvem","hver","hvilke","hvilken","hvilket",
  "hvis","hvor","hvordan","hvorfor","i","ikke","ikkje","ingen","ingenting","inn","inni","ja",
  "jeg","meg","jo","kan","kom","kommer","kun","kunne","kva","kvar","kven","kvi","kvit","man",
  "med","meg","meir","mellom","men","mens","mer","min","mine","mitt","mot","må","måtte","ned",
  "nei","no","noe","noen","noko","nokon","nå","når","og","også","om","opp","oss","over","på",
  "samme","seg","selv","si","sidan","siden","sin","sine","sitt","skal","skulle","slik","som",
  "så","sånn","til","under","ut","uten","var","vart","ved","vere","vi","vil","ville","viss",
  "være","vært","å"
]);
const IDEA_DANISH_STOP_WORDS = new Set([
  "alle","alt","anden","andre","at","af","aldrig","alligevel","allerede","altid","blandt","blev",
  "blive","bliver","da","dag","de","dem","den","denne","der","deres","det","dette","dig","din",
  "dine","disse","dit","dog","du","efter","eller","en","end","ene","enhver","et","fem","fire",
  "flere","flest","for","fordi","før","fra","få","god","gøre","gør","ham","han","hans","har",
  "havde","have","hele","heller","her","hos","hun","hvad","hvem","hver","hvilke","hvilken",
  "hvilket","hvis","hvor","hvordan","hvorfor","i","ikke","imellem","ind","ingen","intet","ja",
  "jeg","jer","jeres","jo","kan","kom","kommer","kun","kunne","lad","lang","lidt","lige","lille",
  "man","mand","mange","med","meget","men","mens","mere","mig","min","mine","mit","mod","må",
  "måske","ned","nej","noget","nogle","nu","når","og","også","om","op","os","over","på","se",
  "selv","sig","sin","sine","sit","skal","skulle","som","stor","store","så","sådan","thi","til",
  "under","var","ved","vi","vil","ville","vor","vores","være","været","øvrigt"
]);
const IDEA_SWEDISH_STOP_WORDS = new Set([
  "alla","allt","alltid","andra","andras","annan","annat","att","av","bakom","bara","behöva",
  "behöver","blev","bli","blir","blivit","borde","båda","då","de","dem","den","deras","dess",
  "det","detta","dig","din","dina","dit","du","där","efter","eller","en","er","era","ert","ett",
  "fast","fick","finna","finns","fler","flesta","fram","från","för","före","genom","ha","hade",
  "han","hans","har","henne","hennes","hit","hon","honom","hur","här","i","icke","idag","igår",
  "igen","inget","ingen","inga","innan","inne","inte","jag","ju","kan","kunde","kunnat","kvar",
  "kom","kommer","komma","kring","man","med","mellan","men","mig","min","mina","mitt","mot",
  "mycket","många","måste","ned","ni","nog","när","någon","något","några","också","om","oss",
  "på","runt","så","samma","sedan","sig","sin","sina","sist","sitta","ska","skall","skulle",
  "som","stor","större","störst","till","tills","under","upp","utan","utanför","vad","var",
  "vara","varför","varit","varje","vars","vart","vem","vi","vid","vilka","vilken","vilket",
  "vill","vår","våra","vårt","än","ännu","är","åt","över"
]);
const IDEA_DUTCH_STOP_WORDS = new Set([
  "aan","aangezien","achter","af","al","alles","als","altijd","andere","anderen","ben","beneden",
  "bent","bij","bijna","binnen","boven","buiten","daar","daarom","daarna","dan","dat","de","deze",
  "die","dit","doch","doen","door","dus","een","eens","en","er","geen","gehad","gekregen","geweest",
  "haar","had","hadden","heb","hebben","hebt","heeft","hem","hen","het","hier","hoe","hoewel","hun",
  "ieder","iedere","iets","ik","in","is","ja","je","jij","jouw","jou","kan","kon","konden","kunnen",
  "maar","me","meer","men","met","mij","mijn","moet","moeten","na","naar","nee","niet","niets","nog",
  "nu","of","om","omdat","onder","ons","onze","ook","op","over","per","reeds","te","tegen","ten",
  "ter","tot","tussen","uit","uw","van","vanaf","veel","voor","voordat","waren","was","wat","we",
  "wel","welke","werd","werden","wie","wij","wil","wilden","willen","worden","wordt","zal","ze",
  "zelf","zich","zij","zijn","zo","zonder","zou","zouden"
]);
const IDEA_GERMAN_STOP_WORDS = new Set([
  "aber","alle","allem","allen","aller","alles","als","also","am","an","andere","anderem","anderen",
  "anderer","anderes","anderm","andern","anderr","anders","auch","auf","aus","bei","bin","bis","bist",
  "da","damit","dann","das","dass","dazu","dein","deine","deinem","deinen","deiner","deines","dem",
  "den","denn","der","des","dessen","deshalb","die","dies","diese","diesem","diesen","dieser","dieses",
  "doch","dort","du","durch","ein","eine","einem","einen","einer","eines","einige","einigem","einigen",
  "einiger","einiges","einmal","er","es","etwas","euer","eure","eurem","euren","eurer","eures","für",
  "gegen","gewesen","hat","hatte","hatten","hier","hin","hinter","ich","ihm","ihn","ihnen","ihr","ihre",
  "ihrem","ihren","ihrer","ihres","im","in","indem","ins","ist","jede","jedem","jeden","jeder","jedes",
  "jene","jenem","jenen","jener","jenes","jetzt","kann","kein","keine","keinem","keinen","keiner",
  "keines","können","könnte","machen","man","manche","manchem","manchen","mancher","manches","mein",
  "meine","meinem","meinen","meiner","meines","mit","muss","musste","nach","nicht","nichts","noch",
  "nun","nur","ob","oder","ohne","sehr","sein","seine","seinem","seinen","seiner","seines","selbst",
  "sich","sie","sind","so","solche","solchem","solchen","solcher","solches","soll","sollte","sondern",
  "sonst","über","um","und","uns","unser","unsere","unserem","unseren","unserer","unseres","unter",
  "vom","von","vor","war","waren","warst","was","weg","weil","weiter","welche","welchem","welchen",
  "welcher","welches","wenn","wer","werde","werden","werdet","weshalb","wie","wieder","will","wir",
  "wird","wirst","wo","zu","zum","zur","über","zwischen"
]);

/**
 * Resume el grafo dirigido definido únicamente por relatedIdeaIds.
 * Los destinos no incluidos permanecen indeterminados cuando hay ideas omitidas
 * o se usa el catálogo heredado; solo se declaran ausentes si el catálogo del
 * proyecto se suministró completo.
 */
// Memoización de una sola instantánea completa del grafo. La clave incluye
// todas las propiedades serializables de cada idea, no solo sus referencias.
let literaryIdeaGraphCacheKey: string | undefined;
let literaryIdeaGraphCacheValue: LiteraryIdeaGraphAnalysis | undefined;

function buildLiteraryIdeaGraph(
  ideas: readonly LiteraryAnalysisKnownProjectIdea[],
  omittedIdeaCount: number,
  catalogScope: LiteraryIdeaGraphAnalysis["catalogScope"]
): LiteraryIdeaGraphAnalysis {
  // Ordena una sola vez y reutiliza la instantánea canónica para clave y cálculo.
  // El desempate exacto distingue IDs Unicode que comparten colación lingüística.
  const compareIdeaIds = (left: string, right: string): number => {
    const localizedOrder = left.localeCompare(right, "en");
    if (localizedOrder !== 0) return localizedOrder;
    return left === right ? 0 : left < right ? -1 : 1;
  };
  const orderedIdeas = [...ideas].sort((left, right) =>
    compareIdeaIds(left.ideaId, right.ideaId)
  );

  // La clave exacta evita invalidaciones manuales: estado, historial, evidencias,
  // vínculos y texto léxico participan en la identidad de la instantánea.
  let cacheable = orderedIdeas.length <= 2_000;
  let cacheTextUnits = 0;
  if (cacheable) {
    for (const idea of orderedIdeas) {
      if (typeof idea.text === "string") {
        cacheTextUnits += idea.text.length;
        if (cacheTextUnits > MAX_LITERARY_IDEA_LEXICAL_TEXT_UNITS) {
          cacheable = false;
          break;
        }
      }
    }
  }
  const cacheKey = cacheable
    ? JSON.stringify([catalogScope, omittedIdeaCount, orderedIdeas])
    : undefined;
  if (cacheKey !== undefined && cacheKey === literaryIdeaGraphCacheKey &&
      literaryIdeaGraphCacheValue) {
    return structuredClone(literaryIdeaGraphCacheValue);
  }
  const projectCatalogComplete = catalogScope === "project" && omittedIdeaCount === 0;
  const ideaIndexById = new Map(
    orderedIdeas.map((idea, index) => [idea.ideaId, index] as const)
  );
  const ideaCount = orderedIdeas.length;
  const unionParent = new Int32Array(ideaCount);
  const unionSize = new Int32Array(ideaCount);
  for (let index = 0; index < ideaCount; index++) {
    unionParent[index] = index;
    unionSize[index] = 1;
  }
  const findUnionRoot = (initialIndex: number): number => {
    let root = initialIndex;
    while (unionParent[root] !== root) root = unionParent[root]!;
    let current = initialIndex;
    while (unionParent[current] !== current) {
      const next = unionParent[current]!;
      unionParent[current] = root;
      current = next;
    }
    return root;
  };
  const unionNodes = (leftIndex: number, rightIndex: number): void => {
    let leftRoot = findUnionRoot(leftIndex);
    let rightRoot = findUnionRoot(rightIndex);
    if (leftRoot === rightRoot) return;
    if (unionSize[leftRoot]! < unionSize[rightRoot]!) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    unionParent[rightRoot] = leftRoot;
    unionSize[leftRoot] = unionSize[leftRoot]! + unionSize[rightRoot]!;
  };

  // Los índices siguen el orden canónico de IDs; las listas numéricas evitan
  // Map/Set por arista y conservan el orden necesario para búsquedas binarias.
  const adjacency: number[][] = Array.from({ length: ideaCount }, () => []);
  const incoming = new Int32Array(ideaCount);
  const outgoingExternal = new Int32Array(ideaCount);
  let referenceCount = 0;
  let includedReferenceCount = 0;
  let notIncludedReferenceCount = 0;
  let missingFromProjectReferenceCount = 0;
  let selfReferenceCount = 0;
  const references: LiteraryIdeaGraphReference[] = [];

  for (let sourceIndex = 0; sourceIndex < ideaCount; sourceIndex++) {
    const idea = orderedIdeas[sourceIndex]!;
    const targets = [...idea.relatedIdeaIds].sort(compareIdeaIds);
    for (const targetId of targets) {
      referenceCount++;
      const targetIndex = ideaIndexById.get(targetId);
      if (targetIndex !== undefined) {
        includedReferenceCount++;
        if (targetIndex === sourceIndex) selfReferenceCount++;
        adjacency[sourceIndex]!.push(targetIndex);
        incoming[targetIndex] = incoming[targetIndex]! + 1;
        unionNodes(sourceIndex, targetIndex);
      } else {
        notIncludedReferenceCount++;
        if (projectCatalogComplete) missingFromProjectReferenceCount++;
        outgoingExternal[sourceIndex] = outgoingExternal[sourceIndex]! + 1;
      }
      if (references.length < MAX_IDEA_GRAPH_REFERENCE_SAMPLES) {
        references.push({
          fromIdeaId: idea.ideaId,
          toIdeaId: targetId,
          resolution: targetIndex !== undefined
            ? "included-in-snapshot"
            : projectCatalogComplete ? "missing-from-project" : "not-in-snapshot"
        });
      }
    }
  }

  const countStatusReversals = (
    history: readonly NarrativeIdeaStatusChange[]
  ): number => {
    const seenStatuses = new Set<NarrativeIdea["status"]>();
    let previousStatus: NarrativeIdea["status"] | undefined;
    let reversalCount = 0;
    for (const change of history) {
      if (
        previousStatus !== undefined &&
        change.status !== previousStatus &&
        seenStatuses.has(change.status)
      ) {
        reversalCount++;
      }
      seenStatuses.add(change.status);
      previousStatus = change.status;
    }
    return reversalCount;
  };

  const nodes: LiteraryIdeaGraphNode[] = orderedIdeas.map((idea, index) => ({
    ideaId: idea.ideaId,
    status: idea.status,
    currentStatusHistoryConsistency: idea.statusHistory.length === 0 ||
      idea.omittedStatusHistoryCount > 0
      ? "unknown"
      : idea.statusHistory[idea.statusHistory.length - 1]!.status === idea.status
        ? "consistent"
        : "mismatch",
    incomingReferenceCount: incoming[index]!,
    includedOutgoingReferenceCount: adjacency[index]!.length,
    notIncludedOutgoingReferenceCount: outgoingExternal[index]!,
    statusHistory: idea.statusHistory.map(change => ({ ...change })),
    omittedStatusHistoryCount: idea.omittedStatusHistoryCount,
    writerDecisionCount: idea.writerDecisionCount,
    observedStatusTransitionCount: idea.statusHistory.reduce(
      (count, change, changeIndex, history) =>
        count + (changeIndex > 0 && change.status !== history[changeIndex - 1]!.status ? 1 : 0),
      0
    ),
    statusReversalCount: countStatusReversals(idea.statusHistory),
    nonMonotonicStatusTimestampCount: idea.statusHistory.reduce(
      (count, change, changeIndex, history) => {
        if (changeIndex === 0) return count;
        const previousAt = history[changeIndex - 1]!.changedAt;
        return previousAt !== undefined && change.changedAt !== undefined &&
          change.changedAt < previousAt ? count + 1 : count;
      },
      0
    ),
    comparableStatusTimestampPairCount: idea.statusHistory.reduce(
      (count, change, changeIndex, history) => {
        if (changeIndex === 0) return count;
        return history[changeIndex - 1]!.changedAt !== undefined &&
          change.changedAt !== undefined ? count + 1 : count;
      },
      0
    ),
    uncomparableStatusTimestampPairCount: idea.statusHistory.reduce(
      (count, change, changeIndex, history) => {
        if (changeIndex === 0) return count;
        return history[changeIndex - 1]!.changedAt === undefined ||
          change.changedAt === undefined ? count + 1 : count;
      },
      0
    ),
    observedInitialStatusRecordCount: idea.statusHistory.filter(
      change => change.reason === "initial"
    ).length,
    observedWriterStatusChangeCount: idea.statusHistory.filter(
      change => change.reason === "writer"
    ).length,
    observedTextRevisionStatusChangeCount: idea.statusHistory.filter(
      change => change.reason === "text-revised"
    ).length,
    earliestKnownStatusChangeAt: idea.statusHistory.reduce<number | null>(
      (earliest, change) => change.changedAt === undefined
        ? earliest
        : earliest === null ? change.changedAt : Math.min(earliest, change.changedAt),
      null
    ),
    latestKnownStatusChangeAt: idea.statusHistory.reduce<number | null>(
      (latest, change) => change.changedAt === undefined
        ? latest
        : latest === null ? change.changedAt : Math.max(latest, change.changedAt),
      null
    ),
    knownStatusHistorySpanMs: (() => {
      let earliest: number | null = null;
      let latest: number | null = null;
      for (const change of idea.statusHistory) {
        if (change.changedAt === undefined) continue;
        earliest = earliest === null ? change.changedAt : Math.min(earliest, change.changedAt);
        latest = latest === null ? change.changedAt : Math.max(latest, change.changedAt);
      }
      return earliest === null || latest === null ? null : latest - earliest;
    })(),
    activeEvidenceCount: idea.evidenceCount,
    staleEvidenceCount: idea.staleEvidenceCount
  }));

  // Tarjan usa índices compactos en arreglos tipados; detecta componentes
  // cíclicos en O(V + E) sin mapas y conjuntos de cadenas por nodo.
  let nextIndex = 0;
  const discoveryIndex = new Int32Array(ideaCount);
  const lowLink = new Int32Array(ideaCount);
  discoveryIndex.fill(-1);
  lowLink.fill(-1);
  const stack: number[] = [];
  const onStack = new Uint8Array(ideaCount);
  const cycles: LiteraryIdeaGraphCycle[] = [];

  // DFS iterativo: evita consumir la pila de llamadas del runtime en grafos
  // profundos. Cada marco conserva el siguiente vecino pendiente y su padre.
  const dfsNodes: number[] = [];
  const dfsParents: number[] = [];
  const dfsNextNeighbors: number[] = [];

  for (let rootIndex = 0; rootIndex < ideaCount; rootIndex++) {
    if (discoveryIndex[rootIndex] !== -1) continue;

    const rootDiscoveryIndex = nextIndex++;
    discoveryIndex[rootIndex] = rootDiscoveryIndex;
    lowLink[rootIndex] = rootDiscoveryIndex;
    stack.push(rootIndex);
    onStack[rootIndex] = 1;
    dfsNodes.push(rootIndex);
    dfsParents.push(-1);
    dfsNextNeighbors.push(0);

    while (dfsNodes.length > 0) {
      const frameIndex = dfsNodes.length - 1;
      const currentIndex = dfsNodes[frameIndex]!;
      const nextNeighborIndex = dfsNextNeighbors[frameIndex]!;
      const neighbors = adjacency[currentIndex]!;

      if (nextNeighborIndex < neighbors.length) {
        const targetIndex = neighbors[nextNeighborIndex]!;
        dfsNextNeighbors[frameIndex] = nextNeighborIndex + 1;

        if (discoveryIndex[targetIndex] === -1) {
          const targetDiscoveryIndex = nextIndex++;
          discoveryIndex[targetIndex] = targetDiscoveryIndex;
          lowLink[targetIndex] = targetDiscoveryIndex;
          stack.push(targetIndex);
          onStack[targetIndex] = 1;
          dfsNodes.push(targetIndex);
          dfsParents.push(currentIndex);
          dfsNextNeighbors.push(0);
        } else if (onStack[targetIndex] === 1) {
          lowLink[currentIndex] = Math.min(
            lowLink[currentIndex]!, discoveryIndex[targetIndex]!
          );
        }
        continue;
      }

      dfsNodes.pop();
      const parentIndex = dfsParents.pop()!;
      dfsNextNeighbors.pop();

      if (parentIndex !== -1) {
        lowLink[parentIndex] = Math.min(
          lowLink[parentIndex]!, lowLink[currentIndex]!
        );
      }

      if (lowLink[currentIndex] !== discoveryIndex[currentIndex]) continue;
      const component: number[] = [];
      while (stack.length > 0) {
        const member = stack.pop()!;
        onStack[member] = 0;
        component.push(member);
        if (member === currentIndex) break;
      }
      const hasSelfReference = component.length === 1 &&
        adjacency[component[0]!]!.includes(component[0]!);
      if (component.length > 1 || hasSelfReference) {
        component.sort((left, right) => left - right);
        cycles.push({
          ideaIds: component.map(member => orderedIdeas[member]!.ideaId)
        });
      }
    }
  }
  cycles.sort((left, right) =>
    compareIdeaIds(left.ideaIds[0]!, right.ideaIds[0]!)
  );

  // Union-find agrupa los componentes débiles sin duplicar las aristas.
  const weakGroups = new Map<number, string[]>();
  for (let index = 0; index < ideaCount; index++) {
    const root = findUnionRoot(index);
    const group = weakGroups.get(root) ?? [];
    group.push(orderedIdeas[index]!.ideaId);
    weakGroups.set(root, group);
  }
  const allWeakComponents: LiteraryIdeaGraphWeakComponent[] = [...weakGroups.values()]
    .map(ideaIds => ({
      representativeIdeaId: ideaIds[0]!,
      ideaIds
    }));
  allWeakComponents.sort((left, right) =>
    right.ideaIds.length - left.ideaIds.length ||
    compareIdeaIds(left.representativeIdeaId, right.representativeIdeaId)
  );

  // Los índices numéricos mantienen el orden de IDs y permiten comprobar
  // reciprocidad por búsqueda binaria sin duplicar la lista de aristas.
  const hasSortedTarget = (sortedTargets: readonly number[], targetIndex: number): boolean => {
    let low = 0;
    let high = sortedTargets.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = sortedTargets[middle]!;
      if (candidate === targetIndex) return true;
      if (candidate < targetIndex) low = middle + 1;
      else high = middle - 1;
    }
    return false;
  };
  let reciprocalReferencePairCount = 0;
  for (let sourceIndex = 0; sourceIndex < ideaCount; sourceIndex++) {
    for (const targetIndex of adjacency[sourceIndex]!) {
      if (sourceIndex < targetIndex &&
          hasSortedTarget(adjacency[targetIndex]!, sourceIndex)) {
        reciprocalReferencePairCount++;
      }
    }
  }

  // Agrega métricas globales y por estado en una sola pasada sobre los nodos.
  // Evita múltiples filter/map/reduce y arreglos temporales proporcionales al catálogo.
  type MutableStatusProfile = {
    status: LiteraryIdeaGraphStatusProfile["status"];
    ideaCount: number;
    sourceIdeaCount: number;
    terminalWithinSnapshotIdeaCount: number;
    isolatedWithinSnapshotIdeaCount: number;
    incomingReferenceCount: number;
    includedOutgoingReferenceCount: number;
    notIncludedOutgoingReferenceCount: number;
    statusHistoryRecordCount: number;
    statusHistoryConsistentIdeaCount: number;
    statusHistoryMismatchIdeaCount: number;
    statusHistoryConsistencyUnknownIdeaCount: number;
    omittedStatusHistoryCount: number;
    writerDecisionCount: number;
    observedStatusTransitionCount: number;
    statusReversalCount: number;
    nonMonotonicStatusTimestampCount: number;
    comparableStatusTimestampPairCount: number;
    uncomparableStatusTimestampPairCount: number;
    observedInitialStatusRecordCount: number;
    observedWriterStatusChangeCount: number;
    observedTextRevisionStatusChangeCount: number;
    earliestKnownStatusChangeAt: number | null;
    latestKnownStatusChangeAt: number | null;
    knownStatusHistorySpanMs: number | null;
    activeEvidenceCount: number;
    staleEvidenceCount: number;
    ideasWithActiveEvidenceCount: number;
    ideasWithStaleEvidenceCount: number;
    ideasWithoutActiveEvidenceCount: number;
  };
  const profileStatuses = ["IDEA", "incorporated", "discarded"] as const;
  const profileTotals = new Map<MutableStatusProfile["status"], MutableStatusProfile>(
    profileStatuses.map(status => [status, {
      status,
      ideaCount: 0,
      sourceIdeaCount: 0,
      terminalWithinSnapshotIdeaCount: 0,
      isolatedWithinSnapshotIdeaCount: 0,
      incomingReferenceCount: 0,
      includedOutgoingReferenceCount: 0,
      notIncludedOutgoingReferenceCount: 0,
      statusHistoryRecordCount: 0,
      statusHistoryConsistentIdeaCount: 0,
      statusHistoryMismatchIdeaCount: 0,
      statusHistoryConsistencyUnknownIdeaCount: 0,
      omittedStatusHistoryCount: 0,
      writerDecisionCount: 0,
      observedStatusTransitionCount: 0,
      statusReversalCount: 0,
      nonMonotonicStatusTimestampCount: 0,
      comparableStatusTimestampPairCount: 0,
      uncomparableStatusTimestampPairCount: 0,
      observedInitialStatusRecordCount: 0,
      observedWriterStatusChangeCount: 0,
      observedTextRevisionStatusChangeCount: 0,
      earliestKnownStatusChangeAt: null,
      latestKnownStatusChangeAt: null,
      knownStatusHistorySpanMs: null,
      activeEvidenceCount: 0,
      staleEvidenceCount: 0,
      ideasWithActiveEvidenceCount: 0,
      ideasWithStaleEvidenceCount: 0,
      ideasWithoutActiveEvidenceCount: 0
    }] as const)
  );
  let sourceNodeCount = 0;
  let terminalWithinSnapshotNodeCount = 0;
  let isolatedWithinSnapshotNodeCount = 0;
  for (const node of nodes) {
    const isSource = node.incomingReferenceCount === 0;
    const isTerminal = node.includedOutgoingReferenceCount === 0;
    if (isSource) sourceNodeCount++;
    if (isTerminal) terminalWithinSnapshotNodeCount++;
    if (isSource && isTerminal) isolatedWithinSnapshotNodeCount++;

    const totals = profileTotals.get(node.status);
    if (!totals) continue;
    totals.ideaCount++;
    if (isSource) totals.sourceIdeaCount++;
    if (isTerminal) totals.terminalWithinSnapshotIdeaCount++;
    if (isSource && isTerminal) totals.isolatedWithinSnapshotIdeaCount++;
    totals.incomingReferenceCount += node.incomingReferenceCount;
    totals.includedOutgoingReferenceCount += node.includedOutgoingReferenceCount;
    totals.notIncludedOutgoingReferenceCount += node.notIncludedOutgoingReferenceCount;
    totals.statusHistoryRecordCount += node.statusHistory.length;
    if (node.currentStatusHistoryConsistency === "consistent") totals.statusHistoryConsistentIdeaCount++;
    else if (node.currentStatusHistoryConsistency === "mismatch") totals.statusHistoryMismatchIdeaCount++;
    else totals.statusHistoryConsistencyUnknownIdeaCount++;
    totals.omittedStatusHistoryCount += node.omittedStatusHistoryCount;
    totals.writerDecisionCount += node.writerDecisionCount;
    totals.observedStatusTransitionCount += node.observedStatusTransitionCount;
    totals.statusReversalCount += node.statusReversalCount;
    totals.nonMonotonicStatusTimestampCount += node.nonMonotonicStatusTimestampCount;
    totals.comparableStatusTimestampPairCount += node.comparableStatusTimestampPairCount;
    totals.uncomparableStatusTimestampPairCount += node.uncomparableStatusTimestampPairCount;
    totals.observedInitialStatusRecordCount += node.observedInitialStatusRecordCount;
    totals.observedWriterStatusChangeCount += node.observedWriterStatusChangeCount;
    totals.observedTextRevisionStatusChangeCount += node.observedTextRevisionStatusChangeCount;
    if (node.earliestKnownStatusChangeAt !== null) {
      totals.earliestKnownStatusChangeAt =
        totals.earliestKnownStatusChangeAt === null
          ? node.earliestKnownStatusChangeAt
          : Math.min(totals.earliestKnownStatusChangeAt, node.earliestKnownStatusChangeAt);
    }
    if (node.latestKnownStatusChangeAt !== null) {
      totals.latestKnownStatusChangeAt =
        totals.latestKnownStatusChangeAt === null
          ? node.latestKnownStatusChangeAt
          : Math.max(totals.latestKnownStatusChangeAt, node.latestKnownStatusChangeAt);
    }
    totals.activeEvidenceCount += node.activeEvidenceCount;
    totals.staleEvidenceCount += node.staleEvidenceCount;
    if (node.activeEvidenceCount > 0) totals.ideasWithActiveEvidenceCount++;
    if (node.staleEvidenceCount > 0) totals.ideasWithStaleEvidenceCount++;
    if (node.activeEvidenceCount === 0) totals.ideasWithoutActiveEvidenceCount++;
  }
  for (const totals of profileTotals.values()) {
    totals.knownStatusHistorySpanMs =
      totals.earliestKnownStatusChangeAt === null ||
      totals.latestKnownStatusChangeAt === null
        ? null
        : totals.latestKnownStatusChangeAt - totals.earliestKnownStatusChangeAt;
  }
  const statusProfiles: LiteraryIdeaGraphStatusProfile[] = profileStatuses.map(
    status => profileTotals.get(status)!
  );
  const statusHistoryConsistency = statusProfiles.reduce((totals, profile) => ({
    consistentIdeaCount: totals.consistentIdeaCount + profile.statusHistoryConsistentIdeaCount,
    mismatchIdeaCount: totals.mismatchIdeaCount + profile.statusHistoryMismatchIdeaCount,
    unknownIdeaCount: totals.unknownIdeaCount + profile.statusHistoryConsistencyUnknownIdeaCount
  }), { consistentIdeaCount: 0, mismatchIdeaCount: 0, unknownIdeaCount: 0 });
  const verifiableIdeaCount = statusHistoryConsistency.consistentIdeaCount +
    statusHistoryConsistency.mismatchIdeaCount;

  const lexicalResonances = buildLiteraryIdeaLexicalResonances(orderedIdeas);
  const result: LiteraryIdeaGraphAnalysis = {
    lexicalResonances,
    catalogScope,
    projectCatalogComplete,
    ideaCount: orderedIdeas.length,
    statusProfiles,
    statusHistoryConsistency: {
      ...statusHistoryConsistency,
      verifiableIdeaCount,
      verificationCoverage: nodes.length === 0 ? 0 : verifiableIdeaCount / nodes.length
    },
    omittedIdeaCount,
    referenceCount,
    includedReferenceCount,
    notIncludedReferenceCount,
    missingFromProjectReferenceCount,
    reciprocalReferencePairCount,
    selfReferenceCount,
    sourceNodeCount,
    terminalWithinSnapshotNodeCount,
    isolatedWithinSnapshotNodeCount,
    weakComponentCount: allWeakComponents.length,
    omittedWeakComponentCount: Math.max(
      0, allWeakComponents.length - MAX_IDEA_GRAPH_WEAK_COMPONENT_SAMPLES
    ),
    largestWeakComponentSize: allWeakComponents[0]?.ideaIds.length ?? 0,
    weakComponents: allWeakComponents.slice(0, MAX_IDEA_GRAPH_WEAK_COMPONENT_SAMPLES),
    cycleCount: cycles.length,
    omittedCycleCount: Math.max(0, cycles.length - MAX_IDEA_GRAPH_CYCLE_SAMPLES),
    referenceSampleCount: references.length,
    omittedReferenceSampleCount: Math.max(0, referenceCount - references.length),
    referencesTruncated: referenceCount > references.length,
    nodes,
    references,
    cycles: cycles.slice(0, MAX_IDEA_GRAPH_CYCLE_SAMPLES)
  };
  if (cacheKey !== undefined) {
    literaryIdeaGraphCacheKey = cacheKey;
    literaryIdeaGraphCacheValue = structuredClone(result);
  } else {
    literaryIdeaGraphCacheKey = undefined;
    literaryIdeaGraphCacheValue = undefined;
  }
  return result;
}

/**
 * Encuentra proximidad léxica entre ideas sin inferir equivalencia temática.
 * El filtro de frecuencia usa el 40% del catálogo, con mínimo dos y máximo
 * cuarenta ideas, para adaptarse tanto a libros pequeños como a catálogos amplios.
 */
// Caché de una sola instantánea: la clave conserva exactamente los campos léxicos
// relevantes y el resultado almacenado nunca se expone directamente al consumidor.
let literaryIdeaLexicalResonanceCacheKey: string | undefined;
let literaryIdeaLexicalResonanceCacheValue: LiteraryIdeaLexicalResonanceAnalysis | undefined;

function buildLiteraryIdeaLexicalResonances(
  ideas: readonly LiteraryAnalysisKnownProjectIdea[]
): LiteraryIdeaLexicalResonanceAnalysis {
  // La clave es exacta (no un hash): un cambio de texto, ID, orden o estado
  // de omisión invalida la entrada sin depender de probabilidades de colisión.
  let cacheable = ideas.length <= 2_000;
  let cacheKey = "";
  let cacheTextUnits = 0;
  if (cacheable) {
    for (const idea of ideas) {
      const text = typeof idea.text === "string" ? idea.text : undefined;
      if (text !== undefined) {
        cacheTextUnits += text.length;
        if (cacheTextUnits > MAX_LITERARY_IDEA_LEXICAL_TEXT_UNITS) {
          cacheable = false;
          break;
        }
      }
      // La caché de módulo nunca debe compartir resultados entre libros,
      // incluso si los IDs locales y los textos coinciden.
      cacheKey += `${idea.projectId.length}:${idea.projectId}`;
      cacheKey += `${idea.ideaId.length}:${idea.ideaId}`;
      cacheKey += idea.textOmitted === "budget" ? "B" : text === undefined
        ? "N" : `T${text.length}:${text}`;
    }
  }
  if (cacheable && cacheKey === literaryIdeaLexicalResonanceCacheKey &&
      literaryIdeaLexicalResonanceCacheValue) {
    return structuredClone(literaryIdeaLexicalResonanceCacheValue);
  }

  const compareTerms = (left: string, right: string): number => {
    const localized = left.localeCompare(right, "es");
    return localized !== 0 ? localized : left === right ? 0 : left < right ? -1 : 1;
  };
  const compareIdeaIds = (left: string, right: string): number => {
    const localized = left.localeCompare(right, "en");
    return localized !== 0 ? localized : left === right ? 0 : left < right ? -1 : 1;
  };
  const prepared: { ideaId: string; terms: string[]; frequencies: Map<string, number> }[] = [];
  let tokenizedTextUnitCount = 0;
  let ideasWithoutTextCount = 0;
  let omittedTextBudgetIdeaCount = 0;
  let omittedDistinctTermCount = 0;

  for (const idea of ideas) {
    if (idea.textOmitted === "budget") {
      omittedTextBudgetIdeaCount++;
      continue;
    }
    if (typeof idea.text !== "string") {
      ideasWithoutTextCount++;
      continue;
    }
    if (tokenizedTextUnitCount + idea.text.length > MAX_LITERARY_IDEA_LEXICAL_TEXT_UNITS) {
      omittedTextBudgetIdeaCount++;
      continue;
    }
    tokenizedTextUnitCount += idea.text.length;
    const frequencies = new Map<string, number>();
    for (const token of tokenize(idea.text)) {
      const term = token.normalized;
      if (Array.from(term).length < 2 || !/\p{L}/u.test(term) ||
          STOP_WORDS.has(term) || IDEA_ENGLISH_STOP_WORDS.has(term) ||
          IDEA_PORTUGUESE_STOP_WORDS.has(term) || IDEA_FRENCH_STOP_WORDS.has(term) ||
          IDEA_ITALIAN_STOP_WORDS.has(term) || IDEA_GERMAN_STOP_WORDS.has(term) || IDEA_DUTCH_STOP_WORDS.has(term) || IDEA_SWEDISH_STOP_WORDS.has(term) || IDEA_DANISH_STOP_WORDS.has(term) || IDEA_NORWEGIAN_STOP_WORDS.has(term)) continue;
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
    const rankedTerms = [...frequencies.entries()].sort((left, right) =>
      right[1] - left[1] || compareTerms(left[0], right[0])
    );
    omittedDistinctTermCount += Math.max(
      0, rankedTerms.length - MAX_IDEA_LEXICAL_TERMS_PER_IDEA
    );
    prepared.push({
      ideaId: idea.ideaId,
      terms: rankedTerms.slice(0, MAX_IDEA_LEXICAL_TERMS_PER_IDEA).map(([term]) => term),
      frequencies: new Map(rankedTerms.slice(0, MAX_IDEA_LEXICAL_TERMS_PER_IDEA))
    });
  }

  const postings = new Map<string, number[]>();
  for (let ideaIndex = 0; ideaIndex < prepared.length; ideaIndex++) {
    for (const term of prepared[ideaIndex]!.terms) {
      const indexes = postings.get(term) ?? [];
      indexes.push(ideaIndex);
      postings.set(term, indexes);
    }
  }

  // Un arreglo triangular de un byte por par evita millones de Map/Array
  // temporales cuando muchas ideas comparten vocabulario de frecuencia media.
  const ideaCount = prepared.length;
  const maxTermDocumentFrequency = Math.max(
    MIN_IDEA_LEXICAL_TERM_DOCUMENT_FREQUENCY,
    Math.min(
      MAX_IDEA_LEXICAL_TERM_DOCUMENT_FREQUENCY,
      Math.ceil(ideaCount * 0.4)
    )
  );
  const pairRowStarts = new Float64Array(ideaCount);
  for (let index = 0; index < ideaCount; index++) {
    pairRowStarts[index] = index * (2 * ideaCount - index - 1) / 2;
  }
  const pairIndex = (leftIndex: number, rightIndex: number): number =>
    pairRowStarts[leftIndex]! + rightIndex - leftIndex - 1;
  const pairSharedTermCounts = new Uint8Array(ideaCount * (ideaCount - 1) / 2);
  let ignoredHighFrequencyTermCount = 0;

  for (const ideaIndexes of postings.values()) {
    if (ideaIndexes.length > maxTermDocumentFrequency) {
      ignoredHighFrequencyTermCount++;
      continue;
    }
    for (let left = 0; left < ideaIndexes.length; left++) {
      for (let right = left + 1; right < ideaIndexes.length; right++) {
        const key = pairIndex(ideaIndexes[left]!, ideaIndexes[right]!);
        // Cada idea contribuye como máximo cien términos distintos a un par.
        pairSharedTermCounts[key] = pairSharedTermCounts[key]! + 1;
      }
    }
  }

  interface RankedPair {
    readonly key: number;
    readonly leftIndex: number;
    readonly rightIndex: number;
    readonly leftIdeaId: string;
    readonly rightIdeaId: string;
    readonly leftTermCount: number;
    readonly rightTermCount: number;
    readonly sharedTermCount: number;
    /** Precisión completa para ordenar; jaccardSimilarity es solo el valor presentado. */
    readonly jaccardScore: number;
    readonly jaccardSimilarity: number;
    readonly overlapCoefficient: number;
  }
  const compareRank = (left: RankedPair, right: RankedPair): number =>
    right.sharedTermCount - left.sharedTermCount ||
    right.jaccardScore - left.jaccardScore ||
    compareIdeaIds(left.leftIdeaId, right.leftIdeaId) ||
    compareIdeaIds(left.rightIdeaId, right.rightIdeaId);
  // Heap acotado: conserva solo los cien mejores pares sin materializar el catálogo entero.
  const topPairs: RankedPair[] = [];
  let candidatePairCount = 0;
  const siftWorstUp = (initialIndex: number): void => {
    let index = initialIndex;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareRank(topPairs[index]!, topPairs[parent]!) <= 0) break;
      [topPairs[index], topPairs[parent]] = [topPairs[parent]!, topPairs[index]!];
      index = parent;
    }
  };
  const siftWorstDown = (initialIndex: number): void => {
    let index = initialIndex;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < topPairs.length &&
          compareRank(topPairs[left]!, topPairs[worst]!) > 0) worst = left;
      if (right < topPairs.length &&
          compareRank(topPairs[right]!, topPairs[worst]!) > 0) worst = right;
      if (worst === index) break;
      [topPairs[index], topPairs[worst]] = [topPairs[worst]!, topPairs[index]!];
      index = worst;
    }
  };

  for (let leftIndex = 0; leftIndex < ideaCount; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < ideaCount; rightIndex++) {
      const sharedTermCount = pairSharedTermCounts[pairIndex(leftIndex, rightIndex)]!;
      if (sharedTermCount < MIN_IDEA_LEXICAL_SHARED_TERMS) continue;
      candidatePairCount++;
      const left = prepared[leftIndex]!;
      const right = prepared[rightIndex]!;
      const unionTermCount = left.terms.length + right.terms.length - sharedTermCount;
      const candidate: RankedPair = {
        key: pairIndex(leftIndex, rightIndex),
        leftIndex,
        rightIndex,
        leftIdeaId: left.ideaId,
        rightIdeaId: right.ideaId,
        leftTermCount: left.terms.length,
        rightTermCount: right.terms.length,
        sharedTermCount,
        jaccardScore: sharedTermCount / unionTermCount,
        jaccardSimilarity: roundMetric(sharedTermCount / unionTermCount),
        overlapCoefficient: roundMetric(
          sharedTermCount / Math.min(left.terms.length, right.terms.length)
        )
      };
      if (topPairs.length < MAX_IDEA_LEXICAL_RESONANCE_SAMPLES) {
        topPairs.push(candidate);
        siftWorstUp(topPairs.length - 1);
      } else if (compareRank(candidate, topPairs[0]!) < 0) {
        topPairs[0] = candidate;
        siftWorstDown(0);
      }
    }
  }
  topPairs.sort(compareRank);

  // Recupera términos únicamente para los cien resultados que se van a exponer.
  const selectedTerms = new Map<number, string[]>(
    topPairs.map(pair => [pair.key, []])
  );
  for (const [term, ideaIndexes] of postings) {
    if (ideaIndexes.length > maxTermDocumentFrequency) continue;
    for (let left = 0; left < ideaIndexes.length; left++) {
      for (let right = left + 1; right < ideaIndexes.length; right++) {
        const shared = selectedTerms.get(pairIndex(ideaIndexes[left]!, ideaIndexes[right]!));
        if (shared) shared.push(term);
      }
    }
  }

  const resonances: LiteraryIdeaLexicalResonance[] = topPairs.map(pair => {
    const orderedSharedTerms = (selectedTerms.get(pair.key) ?? []).sort(compareTerms);
    const leftFrequencies = prepared[pair.leftIndex]!.frequencies;
    const rightFrequencies = prepared[pair.rightIndex]!.frequencies;
    let weightedIntersection = 0;
    let weightedUnion = 0;
    let leftSharedFrequency = 0;
    let rightSharedFrequency = 0;
    let leftTotalFrequency = 0;
    let rightTotalFrequency = 0;
    let frequencyDotProduct = 0;
    let leftFrequencyMagnitudeSquared = 0;
    let rightFrequencyMagnitudeSquared = 0;
    for (const [term, leftFrequency] of leftFrequencies) {
      const rightFrequency = rightFrequencies.get(term) ?? 0;
      const sharedFrequency = Math.min(leftFrequency, rightFrequency);
      weightedIntersection += sharedFrequency;
      weightedUnion += Math.max(leftFrequency, rightFrequency);
      leftSharedFrequency += sharedFrequency;
      leftTotalFrequency += leftFrequency;
      frequencyDotProduct += leftFrequency * rightFrequency;
      leftFrequencyMagnitudeSquared += leftFrequency * leftFrequency;
      rightFrequencyMagnitudeSquared += rightFrequency * rightFrequency;
    }
    for (const [term, rightFrequency] of rightFrequencies) {
      rightTotalFrequency += rightFrequency;
      if (!leftFrequencies.has(term)) {
        weightedUnion += rightFrequency;
        rightFrequencyMagnitudeSquared += rightFrequency * rightFrequency;
      } else {
        rightSharedFrequency += Math.min(
          rightFrequency, leftFrequencies.get(term)!
        );
      }
    }
    return {
      leftIdeaId: pair.leftIdeaId,
      rightIdeaId: pair.rightIdeaId,
      leftTermCount: pair.leftTermCount,
      rightTermCount: pair.rightTermCount,
      sharedTermCount: pair.sharedTermCount,
      jaccardSimilarity: pair.jaccardSimilarity,
      frequencyWeightedJaccardSimilarity: roundMetric(
        weightedUnion > 0 ? weightedIntersection / weightedUnion : 0
      ),
      frequencyCosineSimilarity: roundMetric(
        leftFrequencyMagnitudeSquared > 0 && rightFrequencyMagnitudeSquared > 0
          ? frequencyDotProduct / Math.sqrt(
            leftFrequencyMagnitudeSquared * rightFrequencyMagnitudeSquared
          )
          : 0
      ),
      leftVocabularyCoverage: roundMetric(
        pair.leftTermCount > 0 ? pair.sharedTermCount / pair.leftTermCount : 0
      ),
      rightVocabularyCoverage: roundMetric(
        pair.rightTermCount > 0 ? pair.sharedTermCount / pair.rightTermCount : 0
      ),
      leftFrequencyCoverage: roundMetric(
        leftTotalFrequency > 0 ? leftSharedFrequency / leftTotalFrequency : 0
      ),
      rightFrequencyCoverage: roundMetric(
        rightTotalFrequency > 0 ? rightSharedFrequency / rightTotalFrequency : 0
      ),
      overlapCoefficient: pair.overlapCoefficient,
      sharedTerms: orderedSharedTerms.slice(0, MAX_IDEA_LEXICAL_SHARED_TERM_SAMPLES),
      sharedTermFrequencies: orderedSharedTerms
        .slice(0, MAX_IDEA_LEXICAL_SHARED_TERM_SAMPLES)
        .map(term => ({
          term,
          leftFrequency: prepared[pair.leftIndex]!.frequencies.get(term) ?? 0,
          rightFrequency: prepared[pair.rightIndex]!.frequencies.get(term) ?? 0
        })),
      omittedSharedTermCount: Math.max(
        0, orderedSharedTerms.length - MAX_IDEA_LEXICAL_SHARED_TERM_SAMPLES
      )
    };
  });

  const result: LiteraryIdeaLexicalResonanceAnalysis = {
    inputIdeaCount: ideas.length,
    analyzedIdeaCount: prepared.length,
    ideasWithoutTextCount,
    omittedTextBudgetIdeaCount,
    tokenizedTextUnitCount,
    indexedTermCount: postings.size,
    omittedDistinctTermCount,
    ignoredHighFrequencyTermCount,
    minimumSharedTermCount: MIN_IDEA_LEXICAL_SHARED_TERMS,
    maxTermDocumentFrequency,
    candidatePairCount,
    omittedCandidatePairCount: Math.max(
      0, candidatePairCount - resonances.length
    ),
    resonances
  };
  if (cacheable) {
    literaryIdeaLexicalResonanceCacheKey = cacheKey;
    literaryIdeaLexicalResonanceCacheValue = structuredClone(result);
  } else {
    literaryIdeaLexicalResonanceCacheKey = undefined;
    literaryIdeaLexicalResonanceCacheValue = undefined;
  }
  return result;
}

function buildCharacterNarrativeTrajectories(
  scenes: readonly LiteraryExplicitSceneSegment[],
  knownCharacters: readonly LiteraryAnalysisKnownCharacter[],
  attributeEvolution: LiteraryCharacterAttributeEvolutionAnalysis,
  eventEvidence: LiteraryCharacterEventEvidenceAnalysis,
  dependencies: LiteraryEventDependencyAnalysis,
  projectEvents: readonly LiteraryAnalysisKnownProjectEvent[],
  documentId: string,
  revision: number,
  knownRelations: readonly LiteraryAnalysisKnownRelation[],
  knownIdeas: readonly LiteraryAnalysisKnownIdea[],
  omittedRelationCount: number,
  omittedIdeaCount: number,
  omittedProjectEventCount: number
): LiteraryCharacterNarrativeTrajectoryAnalysis {
  const attributesByCharacter = new Map<string,LiteraryCharacterAttributeProfile[]>();
  for (const profile of attributeEvolution.profiles) {
    const profiles = attributesByCharacter.get(profile.entityId) ?? [];
    profiles.push(profile);
    attributesByCharacter.set(profile.entityId,profiles);
  }
  const eventsByCharacter = new Map<string,LiteraryCharacterEventEvidenceProfile[]>();
  for (const profile of eventEvidence.profiles) {
    const profiles = eventsByCharacter.get(profile.entityId) ?? [];
    profiles.push(profile);
    eventsByCharacter.set(profile.entityId,profiles);
  }
  const characterById = new Map(knownCharacters.map(character => [character.entityId,character]));
  const knownIdeaIds = new Set(knownIdeas.map(idea => idea.ideaId));
  const ideaReferenceCount = knownIdeas.reduce(
    (total, idea) => total + idea.relatedIdeaIds.length, 0
  );
  const resolvedIdeaReferenceCount = knownIdeas.reduce(
    (total, idea) => total + idea.relatedIdeaIds.filter(ideaId => knownIdeaIds.has(ideaId)).length, 0
  );
  const notIncludedIdeaReferenceCount = ideaReferenceCount - resolvedIdeaReferenceCount;
  const relationshipsByCharacter = new Map<string,LiteraryCharacterRelationshipProfile[]>();
  for (const relation of knownRelations) {
    const linkEndpoints = [
      ...(characterById.has(relation.fromEntityId)
        ? [{entityId:relation.fromEntityId,otherEntityId:relation.toEntityId,direction:relation.fromEntityId===relation.toEntityId ? "self" as const : "outgoing" as const}]
        : []),
      ...(relation.toEntityId !== relation.fromEntityId && characterById.has(relation.toEntityId)
        ? [{entityId:relation.toEntityId,otherEntityId:relation.fromEntityId,direction:"incoming" as const}]
        : [])
    ];
    for (const endpoint of linkEndpoints) {
      const otherCharacter = characterById.get(endpoint.otherEntityId);
      const profile:LiteraryCharacterRelationshipProfile = {
        relationId:relation.relationId,
        direction:endpoint.direction,
        otherEntityId:endpoint.otherEntityId,
        otherCharacterName:otherCharacter?.canonicalName ?? null,
        relationType:relation.relationType,
        evidenceStatus:relation.evidenceCount>0
          ? "active-evidence"
          : relation.staleEvidenceCount>0 ? "stale-only" : "no-evidence",
        evidenceCount:relation.evidenceCount,
        staleEvidenceCount:relation.staleEvidenceCount,
        evidenceSamples:relation.evidence.slice(0,20).map(item => ({
          documentId:item.documentId,
          revision:item.revision,
          occurrence:{start:item.start,end:item.end},
          excerpt:item.excerpt
        })),
        evidenceTruncated:relation.evidenceCount>relation.evidence.length,
        historyStatus:"current-record-only"
      };
      const profiles=relationshipsByCharacter.get(endpoint.entityId) ?? [];
      profiles.push(profile);
      relationshipsByCharacter.set(endpoint.entityId,profiles);
    }
  }
  const decisionsByCharacter = new Map<string,LiteraryCharacterDocumentedDecision[]>();
  for (const idea of knownIdeas) {
    for (const entityId of idea.relatedEntityIds) {
      const decision:LiteraryCharacterDocumentedDecision = {
        ideaId:idea.ideaId,
        text:idea.text,
        status:idea.status,
        originDocumentId:idea.originDocumentId,
        sourceProjectName:idea.sourceProjectName,
        relatedIdeaIds:idea.relatedIdeaIds,
        relatedIdeaReferences:idea.relatedIdeaIds.map(ideaId => ({
          ideaId,
          resolution:knownIdeaIds.has(ideaId)
            ? "included-in-analysis-snapshot" as const
            : "not-in-analysis-snapshot" as const
        })),
        evidenceCount:idea.evidenceCount,
        staleEvidenceCount:idea.staleEvidenceCount,
        evidenceSamples:idea.evidence.slice(0,20).map(item => ({
          documentId:item.documentId,
          revision:item.revision,
          occurrence:{start:item.start,end:item.end},
          excerpt:item.excerpt
        })),
        evidenceTruncated:idea.evidenceCount>idea.evidence.length,
        statusHistory:idea.statusHistory,
        omittedStatusHistoryCount:idea.omittedStatusHistoryCount,
        writerDecisionCount:idea.writerDecisionCount
      };
      const decisions=decisionsByCharacter.get(entityId) ?? [];
      decisions.push(decision);
      decisionsByCharacter.set(entityId,decisions);
    }
  }
  const relationsByCharacter = new Map<string,LiteraryCharacterCausalRelation[]>();
  for (const candidate of dependencies.candidates) {
    const firstParticipants = new Set(candidate.firstEventParticipantIds);
    const secondParticipants = new Set(candidate.secondEventParticipantIds);
    const causeParticipants = candidate.causeEventId === candidate.firstEventId
      ? firstParticipants : secondParticipants;
    const consequenceParticipants = candidate.consequenceEventId === candidate.firstEventId
      ? firstParticipants : secondParticipants;
    const candidateParticipants = new Set([...firstParticipants,...secondParticipants]);
    for (const entityId of candidateParticipants) {
      const inCause = causeParticipants.has(entityId);
      const inConsequence = consequenceParticipants.has(entityId);
      const characterRole: LiteraryCharacterCausalRole = inCause && inConsequence
        ? "both-events-participant"
        : inCause ? "cause-event-participant" : "consequence-event-participant";
      const relations = relationsByCharacter.get(entityId) ?? [];
      relations.push({candidateId:candidate.candidateId,characterRole,candidate});
      relationsByCharacter.set(entityId,relations);
    }
  }

  const sourceTruncatedSceneIndexes = scenes
    .filter(scene => scene.characterMentionsTruncated || scene.eventLinksTruncated)
    .map(scene => scene.sceneIndex);
  const trajectories = knownCharacters.map(character => {
    const attributeProfiles = [...(attributesByCharacter.get(character.entityId) ?? [])]
      .sort((a,b) => a.attribute.localeCompare(b.attribute,"en"));
    const eventProfiles = [...(eventsByCharacter.get(character.entityId) ?? [])]
      .sort((a,b) =>
        a.firstSceneIndex-b.firstSceneIndex ||
        a.eventId.localeCompare(b.eventId,"en")
      );
    const causalRelations = [...(relationsByCharacter.get(character.entityId) ?? [])]
      .sort((a,b) =>
        (a.candidate.sceneIndex ?? Number.MAX_SAFE_INTEGER) -
          (b.candidate.sceneIndex ?? Number.MAX_SAFE_INTEGER) ||
        a.candidateId.localeCompare(b.candidateId,"en")
      );
    const characterRelationships=relationshipsByCharacter.get(character.entityId) ?? [];
    const characterDecisions=decisionsByCharacter.get(character.entityId) ?? [];
    const scenesWithEvidence: LiteraryCharacterTrajectorySceneSnapshot[] = scenes.map(scene => {
      const mention = scene.characterMentions.find(item => item.entityId === character.entityId);
      const linkedEvents = scene.eventLinks
        .filter(event => event.participants.some(participant => participant.entityId === character.entityId))
        .sort((a,b) => a.eventId.localeCompare(b.eventId,"en"));
      const mentionStatus: LiteraryCharacterSceneMentionStatus = mention
        ? "mentioned-by-known-name"
        : scene.characterMentionsTruncated
          ? "unknown-due-to-mention-truncation"
          : "not-mentioned-by-known-name";
      const participationStatus: LiteraryCharacterSceneParticipationStatus = linkedEvents.length > 0
        ? "linked-to-explicit-event-evidence"
        : scene.eventLinksTruncated
          ? "unknown-due-to-event-truncation"
          : "not-linked-in-current-evidence";
      const eventIds = linkedEvents.map(item => item.eventId);
      const eventEvidenceRangeCount = linkedEvents.reduce(
        (total,item) => total+item.matchingEvidenceCount,0
      );
      const attributeValues = attributeProfiles.flatMap(profile => {
        const snapshot = profile.scenes.find(item => item.sceneIndex === scene.sceneIndex);
        if (!snapshot) return [];
        return [{
          attribute:profile.attribute,
          values:snapshot.values,
          assertionCount:snapshot.assertionCount,
          assertionIds:snapshot.assertions.map(item => item.assertionId),
          status:snapshot.distinctValueCount > 1 ? "multiple-values" as const : "single-value" as const
        }];
      });
      const causalCandidateIds = causalRelations
        .filter(item => item.candidate.sceneIndex === scene.sceneIndex)
        .map(item => item.candidateId);
      const matchingRelationships=characterRelationships.filter(profile =>
        profile.evidenceSamples.some(evidence =>
          evidence.documentId===documentId &&
          evidence.revision===revision &&
          evidence.occurrence.end>scene.contentRange.start &&
          evidence.occurrence.start<scene.contentRange.end
        )
      );
      const relationshipIds=matchingRelationships.map(item => item.relationId);
      const matchingDecisions=characterDecisions.filter(decision =>
        decision.evidenceSamples.some(evidence =>
          evidence.documentId===documentId &&
          evidence.revision===revision &&
          evidence.occurrence.end>scene.contentRange.start &&
          evidence.occurrence.start<scene.contentRange.end
        )
      );
      const documentedDecisionIdeaIds=matchingDecisions.map(item => item.ideaId);
      const incompleteReasons: Array<
        "mention-truncation" | "event-truncation" |
        "relationship-evidence-truncation" | "decision-evidence-truncation"
      > = [];
      if (scene.characterMentionsTruncated) incompleteReasons.push("mention-truncation");
      if (scene.eventLinksTruncated) incompleteReasons.push("event-truncation");
      if (matchingRelationships.some(item => item.evidenceTruncated)) {
        incompleteReasons.push("relationship-evidence-truncation");
      }
      if (matchingDecisions.some(item => item.evidenceTruncated)) {
        incompleteReasons.push("decision-evidence-truncation");
      }
      const hasDocumentedEvidence =
        mention !== undefined ||
        linkedEvents.length > 0 ||
        attributeValues.length > 0 ||
        causalCandidateIds.length > 0 ||
        relationshipIds.length > 0 ||
        documentedDecisionIdeaIds.length > 0;
      return {
        sceneIndex:scene.sceneIndex,
        evidenceStatus:hasDocumentedEvidence
          ? "documented"
          : incompleteReasons.length > 0
            ? "unknown-due-to-truncation"
            : "no-known-evidence",
        mentionStatus,
        participationStatus,
        eventIds,
        eventEvidenceRangeCount,
        attributeValues,
        causalCandidateIds,
        relationshipIds,
        documentedDecisionIdeaIds,
        incompleteReasons
      };
    });
    const observedSceneIndexes = scenesWithEvidence
      .filter(scene => scene.evidenceStatus === "documented")
      .map(scene => scene.sceneIndex);
    const incompleteSceneIndexes = scenesWithEvidence
      .filter(scene => scene.incompleteReasons.length > 0)
      .map(scene => scene.sceneIndex);
    return {
      entityId:character.entityId,
      canonicalName:character.canonicalName,
      mentionSceneCount:scenesWithEvidence.filter(scene =>
        scene.mentionStatus === "mentioned-by-known-name"
      ).length,
      eventParticipationSceneCount:scenesWithEvidence.filter(scene =>
        scene.participationStatus === "linked-to-explicit-event-evidence"
      ).length,
      attributeAssertionCount:attributeProfiles.reduce(
        (total,profile) => total+profile.assertionCount,0
      ),
      causalCandidateCount:causalRelations.length,
      writerDecisionCount:characterDecisions.reduce((total,item) => total+item.writerDecisionCount,0),
      observedSceneIndexes,
      incompleteSceneIndexes,
      attributes:attributeProfiles,
      relationships:[...(relationshipsByCharacter.get(character.entityId) ?? [])]
        .sort((a,b) => a.relationId.localeCompare(b.relationId,"en") || a.direction.localeCompare(b.direction,"en")),
      documentedDecisions:[...(decisionsByCharacter.get(character.entityId) ?? [])]
        .sort((a,b) => a.ideaId.localeCompare(b.ideaId,"en")),
      eventParticipation:eventProfiles,
      projectEventTimeline:buildCharacterProjectEventTimeline(character.entityId,projectEvents),
      causalRelations,
      scenes:scenesWithEvidence
    };
  }).sort((a,b) =>
    b.observedSceneIndexes.length-a.observedSceneIndexes.length ||
    b.eventParticipationSceneCount-a.eventParticipationSceneCount ||
    b.attributeAssertionCount-a.attributeAssertionCount ||
    b.causalCandidateCount-a.causalCandidateCount ||
    b.relationships.length-a.relationships.length ||
    b.writerDecisionCount-a.writerDecisionCount ||
    b.documentedDecisions.length-a.documentedDecisions.length ||
    b.mentionSceneCount-a.mentionSceneCount ||
    a.entityId.localeCompare(b.entityId,"en")
  );

  return {
    explicitSceneCount:scenes.length,
    catalogCharacterCount:knownCharacters.length,
    profileCount:trajectories.length,
    omittedCharacterCount:Math.max(0,trajectories.length-200),
    sourceTruncatedSceneCount:sourceTruncatedSceneIndexes.length,
    sourceTruncatedSceneIndexes,
    omittedAttributeProfileCount:attributeEvolution.omittedProfileCount,
    omittedEventAssociationCount:eventEvidence.omittedAssociationCount,
    omittedCausalCandidateCount:dependencies.omittedCandidateCount,
    omittedProjectEventCount,
    relationshipRecordCount:knownRelations.length+omittedRelationCount,
    omittedRelationshipCount:omittedRelationCount,
    linkedIdeaCount:knownIdeas.length,
    ideaReferenceCount,
    resolvedIdeaReferenceCount,
    notIncludedIdeaReferenceCount,
    omittedIdeaCount,
    causalCandidateCount:dependencies.candidateCount,
    trajectories:trajectories.slice(0,200)
  };
}

function buildCharacterMentionDistributions(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiteraryCharacterMentionDistributionAnalysis {
  const groups = new Map<string,{
    readonly entityId: string;
    readonly canonicalName: string;
    sceneIndexes: number[];
    mentionCountByScene: Map<number,number>;
    totalMentionCount: number;
  }>();
  for (const scene of scenes) {
    for (const mention of scene.characterMentions) {
      const group = groups.get(mention.entityId) ?? {
        entityId:mention.entityId,
        canonicalName:mention.canonicalName,
        sceneIndexes:[],
        mentionCountByScene:new Map<number,number>(),
        totalMentionCount:0
      };
      if (group.sceneIndexes[group.sceneIndexes.length-1] !== scene.sceneIndex) {
        group.sceneIndexes.push(scene.sceneIndex);
      }
      group.mentionCountByScene.set(scene.sceneIndex,mention.mentionCount);
      group.totalMentionCount += mention.mentionCount;
      groups.set(mention.entityId,group);
    }
  }

  const totalSceneWordCount = scenes.reduce((total,scene) => total+scene.wordCount,0);
  const characters = [...groups.values()].map(group => {
    const sceneIndexes = [...group.sceneIndexes];
    const mentionCountByScene = scenes.map(scene => {
      const mentionCount = group.mentionCountByScene.get(scene.sceneIndex) ?? 0;
      return {
        sceneIndex:scene.sceneIndex,
        sceneWordCount:scene.wordCount,
        mentionCount,
        mentionRatePer1000Words:scene.wordCount > 0
          ? roundMetric(mentionCount/scene.wordCount*1000) : 0
      };
    });
    const firstSceneIndex = sceneIndexes[0] ?? 0;
    const lastSceneIndex = sceneIndexes[sceneIndexes.length-1] ?? 0;
    let longestConsecutiveSceneRun = 0;
    let currentRun = 0;
    let previousSceneIndex = Number.NEGATIVE_INFINITY;
    for (const sceneIndex of sceneIndexes) {
      currentRun = sceneIndex === previousSceneIndex+1 ? currentRun+1 : 1;
      longestConsecutiveSceneRun = Math.max(longestConsecutiveSceneRun,currentRun);
      previousSceneIndex = sceneIndex;
    }
    return {
      entityId:group.entityId,
      canonicalName:group.canonicalName,
      totalMentionCount:group.totalMentionCount,
      totalSceneWordCount,
      mentionRatePer1000Words:totalSceneWordCount > 0
        ? roundMetric(group.totalMentionCount/totalSceneWordCount*1000) : 0,
      mentionCountByScene,
      sceneIndexes,
      sceneCount:sceneIndexes.length,
      firstSceneIndex,
      lastSceneIndex,
      interveningSceneCount:Math.max(0,lastSceneIndex-firstSceneIndex+1-sceneIndexes.length),
      longestConsecutiveSceneRun,
      sceneCoverageRatio:scenes.length > 0
        ? roundMetric(sceneIndexes.length/scenes.length) : 0
    };
  }).sort((a,b) =>
    b.sceneCount-a.sceneCount ||
    b.longestConsecutiveSceneRun-a.longestConsecutiveSceneRun ||
    a.entityId.localeCompare(b.entityId,"en")
  );

  return {
    explicitSceneCount:scenes.length,
    characterCount:characters.length,
    omittedCharacterCount:Math.max(0,characters.length-100),
    characters:characters.slice(0,100)
  };
}

function findExplicitEventDependencyConnector(
  textBetweenEvents: string
): { readonly connector: string; readonly index: number; readonly direction: LiteraryEventDependencyCandidate["direction"] } | undefined {
  const expression = /\b(por eso|por lo tanto|así que|de modo que|en consecuencia|como resultado|por consiguiente|provocó|provocaron|causó|causaron|desencadenó|desencadenaron|originó|originaron|produjo|produjeron|porque|debido a|a causa de|gracias a|por culpa de|como consecuencia de)\b/giu;
  const matches = [...textBetweenEvents.matchAll(expression)];
  if (matches.length === 0) return undefined;
  const match = matches[0]!;
  const connector = match[0];
  const normalized = connector.normalize("NFKC").toLocaleLowerCase("es");
  const consequenceBeforeCause = new Set([
    "porque","debido a","a causa de","gracias a","por culpa de","como consecuencia de"
  ]);
  return {
    connector,
    index:match.index ?? 0,
    direction:consequenceBeforeCause.has(normalized)
      ? "consequence-before-cause"
      : "cause-before-consequence"
  };
}

function buildExplicitEventDependencyAnalysis(
  text: string,
  sentenceRanges: readonly LocalRange[],
  scenes: readonly LiteraryExplicitSceneSegment[],
  events: readonly LiteraryAnalysisKnownEvent[],
  documentId: string,
  revision: number,
  baseOffset: number
): LiteraryEventDependencyAnalysis {
  const eventById = new Map(events.map(event => [event.eventId,event]));
  const anchors: Array<{
    readonly eventId: string;
    readonly eventLabel: string;
    readonly start: number;
    readonly end: number;
    readonly sentenceIndex: number;
  }> = [];
  let evidenceAnchorCount = 0;
  let sampledEvidenceAnchorCount = 0;
  let omittedEvidenceAnchorCount = 0;
  const MAX_EVIDENCE_ANCHORS = 2_000;

  for (const event of events) {
    for (const evidence of event.evidence) {
      if (evidence.status === "stale" ||
          evidence.documentId !== documentId ||
          evidence.revision !== revision ||
          evidence.start < baseOffset ||
          evidence.end > baseOffset + text.length) continue;
      const localStart = evidence.start - baseOffset;
      const localEnd = evidence.end - baseOffset;
      if (localStart < 0 || localEnd <= localStart || localEnd > text.length) continue;
      evidenceAnchorCount++;
      if (sampledEvidenceAnchorCount >= MAX_EVIDENCE_ANCHORS) {
        omittedEvidenceAnchorCount++;
        continue;
      }
      sampledEvidenceAnchorCount++;
      let low = 0;
      let high = sentenceRanges.length-1;
      let sentenceIndex = -1;
      while (low <= high) {
        const middle = Math.floor((low+high)/2);
        const range = sentenceRanges[middle]!;
        if (localEnd <= range.start) high = middle-1;
        else if (localStart >= range.end) low = middle+1;
        else {
          if (localStart >= range.start && localEnd <= range.end) sentenceIndex = middle;
          break;
        }
      }
      if (sentenceIndex < 0) continue;
      anchors.push({
        eventId:event.eventId,
        eventLabel:event.label,
        start:localStart,
        end:localEnd,
        sentenceIndex
      });
    }
  }
  anchors.sort((a,b) =>
    a.sentenceIndex-b.sentenceIndex ||
    a.start-b.start ||
    a.end-b.end ||
    a.eventId.localeCompare(b.eventId,"en")
  );

  const bySentence = new Map<number, typeof anchors>();
  for (const anchor of anchors) {
    const group = bySentence.get(anchor.sentenceIndex) ?? [];
    // Una sola ancla por evento y oración evita crear pares artificiales por menciones duplicadas.
    if (!group.some(item => item.eventId === anchor.eventId)) group.push(anchor);
    bySentence.set(anchor.sentenceIndex,group);
  }

  const candidates: LiteraryEventDependencyCandidate[] = [];
  let candidateCount = 0;
  for (const [sentenceIndex,sentenceAnchors] of bySentence) {
    sentenceAnchors.sort((a,b) => a.start-b.start || a.end-b.end);
    for (let index=0; index+1<sentenceAnchors.length; index++) {
      const first = sentenceAnchors[index]!;
      const second = sentenceAnchors[index+1]!;
      if (first.eventId === second.eventId || first.end > second.start) continue;
      const between = text.slice(first.end,second.start);
      const causal = findExplicitEventDependencyConnector(between);
      if (!causal) continue;
      candidateCount++;
      const sentence = sentenceRanges[sentenceIndex]!;
      const causeEventId = causal.direction === "cause-before-consequence"
        ? first.eventId : second.eventId;
      const consequenceEventId = causal.direction === "cause-before-consequence"
        ? second.eventId : first.eventId;
      const firstEvent = eventById.get(first.eventId)!;
      const secondEvent = eventById.get(second.eventId)!;
      const firstEventParticipantIds = [...new Set(firstEvent.participants)].sort((a,b) => a.localeCompare(b,"en"));
      const secondEventParticipantIds = [...new Set(secondEvent.participants)].sort((a,b) => a.localeCompare(b,"en"));
      const secondParticipantSet = new Set(secondEventParticipantIds);
      const sharedParticipantIds = firstEventParticipantIds.filter(id => secondParticipantSet.has(id));
      const scene = scenes.find(item =>
        first.start >= item.contentRange.start-baseOffset &&
        second.end <= item.contentRange.end-baseOffset
      );
      if (candidates.length < 50) {
        candidates.push({
          candidateId:`event-dependency:${JSON.stringify([causeEventId,consequenceEventId,baseOffset+first.end+causal.index])}`,
          firstEventId:first.eventId,
          firstEventLabel:first.eventLabel,
          secondEventId:second.eventId,
          secondEventLabel:second.eventLabel,
          causeEventId,
          consequenceEventId,
          firstEventParticipantIds,
          secondEventParticipantIds,
          sharedParticipantIds,
          direction:causal.direction,
          connector:causal.connector,
          connectorOccurrence:{
            start:baseOffset+first.end+causal.index,
            end:baseOffset+first.end+causal.index+causal.connector.length
          },
          firstEventOccurrence:{start:baseOffset+first.start,end:baseOffset+first.end},
          secondEventOccurrence:{start:baseOffset+second.start,end:baseOffset+second.end},
          sentenceOccurrence:{start:baseOffset+sentence.start,end:baseOffset+sentence.end},
          sceneIndex:scene?.sceneIndex ?? null,
          status:"candidate-needs-review"
        });
      }
    }
  }

  return {
    evidenceAnchorCount,
    omittedEvidenceAnchorCount,
    candidateCount,
    omittedCandidateCount:Math.max(0,candidateCount-candidates.length),
    candidates
  };
}

function normalizeCharacterAttributeValue(value: string | number): string {
  return typeof value === "number"
    ? "number:" + String(value)
    : "string:" + value.normalize("NFKC").trim().toLocaleLowerCase("es");
}

function buildCharacterAttributeEvolution(
  scenes: readonly LiteraryExplicitSceneSegment[],
  assertions: readonly NarrativeAssertion[],
  documentId: string,
  revision: number
): LiteraryCharacterAttributeEvolutionAnalysis {
  const groups = new Map<string, {
    readonly entityId: string;
    readonly canonicalName: string;
    readonly attribute: NarrativeAssertion["attribute"];
    readonly byScene: Map<number, NarrativeAssertion[]>;
    readonly timedAssertions: NarrativeAssertion[];
  }>();
  let staleAssertionCount = 0;
  let outOfScopeAssertionCount = 0;
  let currentRevisionAssertionCount = 0;
  let unmappedCurrentAssertionCount = 0;

  for (const assertion of assertions) {
    if (assertion.evidence.status === "stale") {
      staleAssertionCount++;
      continue;
    }
    const inCurrentRevision = assertion.evidence.documentId === documentId &&
      assertion.evidence.revision === revision;
    if (!inCurrentRevision) outOfScopeAssertionCount++;
    else currentRevisionAssertionCount++;

    const scene = inCurrentRevision
      ? scenes.find(item =>
          assertion.evidence.end > item.contentRange.start &&
          assertion.evidence.start < item.contentRange.end
        )
      : undefined;
    if (inCurrentRevision && !scene) unmappedCurrentAssertionCount++;
    // Las afirmaciones de otros capítulos solo se conservan si incluyen una referencia temporal explícita.
    if (!scene && !assertion.timeReference) continue;

    const key = JSON.stringify([assertion.entityId, assertion.attribute]);
    let group = groups.get(key);
    if (!group) {
      group = {
        entityId:assertion.entityId,
        canonicalName:assertion.entityName,
        attribute:assertion.attribute,
        byScene:new Map(),
        timedAssertions:[]
      };
      groups.set(key,group);
    }
    if (assertion.timeReference) group.timedAssertions.push(assertion);
    if (scene) {
      const entries = group.byScene.get(scene.sceneIndex) ?? [];
      entries.push(assertion);
      group.byScene.set(scene.sceneIndex,entries);
    }
  }

  const profiles = [...groups.values()].map(group => {
    const sceneSnapshots = scenes.flatMap(scene => {
      const entries = group.byScene.get(scene.sceneIndex);
      if (!entries?.length) return [];
      const ordered = [...entries].sort((a,b) =>
        a.evidence.start-b.evidence.start || a.id.localeCompare(b.id,"en")
      );
      const values = new Map<string,string | number>();
      for (const assertion of ordered) {
        const key = normalizeCharacterAttributeValue(assertion.value);
        if (!values.has(key)) values.set(key,assertion.value);
      }
      return [{
        sceneIndex:scene.sceneIndex,
        assertionCount:entries.length,
        distinctValueCount:values.size,
        values:[...values.values()],
        assertions:ordered.slice(0,20).map(assertion => ({
          assertionId:assertion.id,
          value:assertion.value,
          documentId:assertion.evidence.documentId,
          revision:assertion.evidence.revision,
          occurrence:{start:assertion.evidence.start,end:assertion.evidence.end},
          excerpt:assertion.evidence.excerpt,
          ...(assertion.timeReference ? {timeReference:assertion.timeReference} : {})
        })),
        evidenceTruncated:entries.length>20
      }];
    });
    const transitions: LiteraryCharacterAttributeTransition[] = [];
    for (let index=1; index<sceneSnapshots.length; index++) {
      const previous = sceneSnapshots[index-1]!;
      const next = sceneSnapshots[index]!;
      const previousKeys = new Set(previous.values.map(normalizeCharacterAttributeValue));
      const nextKeys = new Set(next.values.map(normalizeCharacterAttributeValue));
      const sameValues = previousKeys.size===nextKeys.size &&
        [...previousKeys].every(value => nextKeys.has(value));
      const multipleValues = previous.distinctValueCount>1 || next.distinctValueCount>1;
      transitions.push({
        fromSceneIndex:previous.sceneIndex,
        toSceneIndex:next.sceneIndex,
        interveningSceneCount:Math.max(0,next.sceneIndex-previous.sceneIndex-1),
        status:multipleValues
          ? "multiple-values-in-scene"
          : sameValues ? "unchanged-value" : "changed-value",
        previousValues:previous.values,
        nextValues:next.values,
        previousAssertionIds:previous.assertions.map(item => item.assertionId),
        nextAssertionIds:next.assertions.map(item => item.assertionId)
      });
    }
    const multipleValueSceneIndexes = sceneSnapshots
      .filter(scene => scene.distinctValueCount>1)
      .map(scene => scene.sceneIndex);
    const timelineGroups = new Map<string, NarrativeAssertion[]>();
    for (const assertion of group.timedAssertions) {
      const reference = assertion.timeReference!;
      const key = JSON.stringify([reference.basis,reference.precision,reference.orderValue]);
      const entries = timelineGroups.get(key) ?? [];
      entries.push(assertion);
      timelineGroups.set(key,entries);
    }
    const timelinePoints = [...timelineGroups.values()].map(entries => {
      const reference = entries[0]!.timeReference!;
      const values = new Map<string,string | number>();
      const rawReferences = new Set<string>();
      const documents = new Set<string>();
      const ordered = [...entries].sort((a,b) =>
        a.evidence.documentId.localeCompare(b.evidence.documentId,"en") ||
        a.evidence.revision-b.evidence.revision ||
        a.evidence.start-b.evidence.start ||
        a.id.localeCompare(b.id,"en")
      );
      for (const assertion of ordered) {
        const valueKey = normalizeCharacterAttributeValue(assertion.value);
        if (!values.has(valueKey)) values.set(valueKey,assertion.value);
        rawReferences.add(assertion.timeReference!.raw);
        documents.add(assertion.evidence.documentId);
      }
      return {
        basis:reference.basis,
        precision:reference.precision,
        orderValue:reference.orderValue,
        rawTimeReferences:[...rawReferences].sort((a,b) => a.localeCompare(b,"es")),
        assertionCount:entries.length,
        distinctValueCount:values.size,
        values:[...values.values()],
        documentIds:[...documents].sort((a,b) => a.localeCompare(b,"en")),
        assertions:ordered.slice(0,20).map(assertion => ({
          assertionId:assertion.id,
          value:assertion.value,
          documentId:assertion.evidence.documentId,
          revision:assertion.evidence.revision,
          occurrence:{start:assertion.evidence.start,end:assertion.evidence.end},
          excerpt:assertion.evidence.excerpt,
          timeReference:assertion.timeReference!
        })),
        evidenceTruncated:entries.length>20
      };
    }).sort((a,b) =>
      a.basis.localeCompare(b.basis,"en") ||
      a.precision.localeCompare(b.precision,"en") ||
      a.orderValue-b.orderValue
    );
    const timelineSeries = new Map<string, typeof timelinePoints>();
    for (const point of timelinePoints) {
      const key = JSON.stringify([point.basis,point.precision]);
      const points = timelineSeries.get(key) ?? [];
      points.push(point);
      timelineSeries.set(key,points);
    }
    const projectTimelineTransitions: LiteraryCharacterAttributeTimelineTransition[] = [];
    for (const points of timelineSeries.values()) {
      for (let index=1; index<points.length; index++) {
        const previous = points[index-1]!;
        const next = points[index]!;
        const previousKeys = new Set(previous.values.map(normalizeCharacterAttributeValue));
        const nextKeys = new Set(next.values.map(normalizeCharacterAttributeValue));
        const sameValues = previousKeys.size===nextKeys.size &&
          [...previousKeys].every(value => nextKeys.has(value));
        projectTimelineTransitions.push({
          basis:previous.basis,
          precision:previous.precision,
          fromOrderValue:previous.orderValue,
          toOrderValue:next.orderValue,
          fromTimeReferences:previous.rawTimeReferences,
          toTimeReferences:next.rawTimeReferences,
          status:previous.distinctValueCount>1 || next.distinctValueCount>1
            ? "multiple-values-at-same-time"
            : sameValues ? "unchanged-value" : "changed-value",
          previousValues:previous.values,
          nextValues:next.values,
          previousAssertionIds:previous.assertions.map(item => item.assertionId),
          nextAssertionIds:next.assertions.map(item => item.assertionId)
        });
      }
    }
    return {
      entityId:group.entityId,
      canonicalName:group.canonicalName,
      attribute:group.attribute,
      assertionCount:sceneSnapshots.reduce((total,scene) => total+scene.assertionCount,0),
      sceneCount:sceneSnapshots.length,
      firstSceneIndex:sceneSnapshots[0]?.sceneIndex ?? 0,
      lastSceneIndex:sceneSnapshots.at(-1)?.sceneIndex ?? 0,
      changedValueTransitionCount:transitions.filter(item => item.status==="changed-value").length,
      multipleValueSceneIndexes,
      scenes:sceneSnapshots,
      transitions,
      projectTimelineAssertionCount:group.timedAssertions.length,
      projectTimelinePointCount:timelinePoints.length,
      projectTimeline:timelinePoints,
      projectTimelineTransitions
    };
  }).sort((a,b) =>
    a.entityId.localeCompare(b.entityId,"en") ||
    a.attribute.localeCompare(b.attribute,"en")
  );

  return {
    explicitSceneCount:scenes.length,
    sourceAssertionCount:assertions.length,
    currentRevisionAssertionCount,
    staleAssertionCount,
    outOfScopeAssertionCount,
    unmappedCurrentAssertionCount,
    profileCount:profiles.length,
    omittedProfileCount:Math.max(0,profiles.length-200),
    profiles:profiles.slice(0,200)
  };
}

function buildCharacterSceneEvidenceProfiles(
  scenes: readonly LiteraryExplicitSceneSegment[],
  knownCharacters: readonly LiteraryAnalysisKnownCharacter[]
): LiteraryCharacterSceneEvidenceAnalysis {
  const characterById = new Map(knownCharacters.map(character => [character.entityId, character]));
  const candidateIds = new Set<string>();
  const sourceTruncatedSceneIndexes: number[] = [];
  const preparedScenes = scenes.map(scene => {
    const mentionsById = new Map(scene.characterMentions.map(mention => [mention.entityId, mention]));
    const participantsById = new Map<string, {
      eventIds: string[];
      eventEvidenceRangeCount: number;
      eventEvidenceSamplesTruncated: boolean;
    }>();
    if (scene.characterMentionsTruncated || scene.eventLinksTruncated) {
      sourceTruncatedSceneIndexes.push(scene.sceneIndex);
    }
    for (const mention of scene.characterMentions) candidateIds.add(mention.entityId);
    for (const link of scene.eventLinks) {
      for (const participant of link.participants) {
        candidateIds.add(participant.entityId);
        const aggregate = participantsById.get(participant.entityId) ?? {
          eventIds: [],
          eventEvidenceRangeCount: 0,
          eventEvidenceSamplesTruncated: false
        };
        aggregate.eventIds.push(link.eventId);
        aggregate.eventEvidenceRangeCount += link.matchingEvidenceCount;
        aggregate.eventEvidenceSamplesTruncated ||= link.matchingEvidenceTruncated;
        participantsById.set(participant.entityId, aggregate);
      }
    }
    for (const aggregate of participantsById.values()) {
      aggregate.eventIds.sort((a,b) => a.localeCompare(b,"en"));
    }
    return { scene, mentionsById, participantsById };
  });

  const candidates = [...candidateIds]
    .map(entityId => characterById.get(entityId))
    .filter((character): character is LiteraryAnalysisKnownCharacter => character !== undefined)
    .map(character => {
      const snapshots: LiteraryCharacterSceneEvidenceSnapshot[] = preparedScenes.map(item => {
        const {scene,mentionsById,participantsById} = item;
        const mention = mentionsById.get(character.entityId);
        const participation = participantsById.get(character.entityId);
        const mentionStatus: LiteraryCharacterSceneMentionStatus = mention
          ? "mentioned-by-known-name"
          : scene.characterMentionsTruncated
            ? "unknown-due-to-mention-truncation"
            : "not-mentioned-by-known-name";
        const participationStatus: LiteraryCharacterSceneParticipationStatus = participation
          ? "linked-to-explicit-event-evidence"
          : scene.eventLinksTruncated
            ? "unknown-due-to-event-truncation"
            : "not-linked-in-current-evidence";
        return {
          sceneIndex:scene.sceneIndex,
          mentionStatus,
          mentionCount:mention?.mentionCount ?? 0,
          participationStatus,
          eventIds:participation?.eventIds ?? [],
          eventEvidenceRangeCount:participation?.eventEvidenceRangeCount ?? 0,
          eventEvidenceSamplesTruncated:participation?.eventEvidenceSamplesTruncated ?? false,
          characterMentionsTruncated:scene.characterMentionsTruncated,
          eventLinksTruncated:scene.eventLinksTruncated
        };
      });
      const mentionSnapshots = snapshots.filter(scene => scene.mentionCount > 0);
      const participationSnapshots = snapshots.filter(scene => scene.eventIds.length > 0);
      return {
        entityId:character.entityId,
        canonicalName:character.canonicalName,
        totalMentionCount:mentionSnapshots.reduce((total,scene) => total+scene.mentionCount,0),
        mentionSceneCount:mentionSnapshots.length,
        mentionSceneIndexes:mentionSnapshots.map(scene => scene.sceneIndex),
        firstMentionSceneIndex:mentionSnapshots[0]?.sceneIndex ?? null,
        lastMentionSceneIndex:mentionSnapshots.at(-1)?.sceneIndex ?? null,
        eventParticipationSceneCount:participationSnapshots.length,
        eventParticipationSceneIndexes:participationSnapshots.map(scene => scene.sceneIndex),
        firstEventParticipationSceneIndex:participationSnapshots[0]?.sceneIndex ?? null,
        lastEventParticipationSceneIndex:participationSnapshots.at(-1)?.sceneIndex ?? null,
        totalEventEvidenceRangeCount:snapshots.reduce(
          (total,scene) => total+scene.eventEvidenceRangeCount,0
        ),
        incompleteSceneCount:snapshots.filter(scene =>
          scene.mentionStatus === "unknown-due-to-mention-truncation" ||
          scene.participationStatus === "unknown-due-to-event-truncation"
        ).length,
        scenes:snapshots
      };
    })
    .sort((a,b) =>
      b.eventParticipationSceneCount-a.eventParticipationSceneCount ||
      b.mentionSceneCount-a.mentionSceneCount ||
      b.totalMentionCount-a.totalMentionCount ||
      a.entityId.localeCompare(b.entityId,"en")
    );

  return {
    explicitSceneCount:scenes.length,
    sourceTruncatedSceneCount:sourceTruncatedSceneIndexes.length,
    sourceTruncatedSceneIndexes,
    characterCount:candidates.length,
    omittedCharacterCount:Math.max(0,candidates.length-100),
    profiles:candidates.slice(0,100)
  };
}

function buildSceneLexicalEchoes(
  tokens: readonly WordToken[],
  scenes: readonly LiteraryExplicitSceneSegment[],
  dialogueRanges: readonly LocalRange[],
  baseOffset: number
): LiterarySceneLexicalEchoAnalysis {
  const groups = new Map<string, {
    readonly word: string;
    totalOccurrenceCount: number;
    sceneCount: number;
    lastSceneIndex: number | null;
  }>();
  let tokenCursor = 0;
  let dialogueCursor = 0;

  // Primera pasada: cuenta escenas y contextos sin reservar listas de evidencia.
  for (const scene of scenes) {
    const start = scene.contentRange.start - baseOffset;
    const end = scene.contentRange.end - baseOffset;
    while (tokenCursor < tokens.length && tokens[tokenCursor]!.end <= start) tokenCursor++;

    let cursor = tokenCursor;
    while (cursor < tokens.length && tokens[cursor]!.start < end) {
      const token = tokens[cursor]!;
      while (dialogueCursor < dialogueRanges.length &&
          dialogueRanges[dialogueCursor]!.end <= token.start) dialogueCursor++;
      if (token.start >= start && token.end <= end &&
          !STOP_WORDS.has(token.normalized) && token.normalized.length >= 3) {
        let group = groups.get(token.normalized);
        if (!group) {
          group = {
            word: token.text,
            totalOccurrenceCount: 0,
            sceneCount: 0,
            lastSceneIndex: null
          };
          groups.set(token.normalized, group);
        }
        group.totalOccurrenceCount++;
        if (group.lastSceneIndex !== scene.sceneIndex) {
          group.sceneCount++;
          group.lastSceneIndex = scene.sceneIndex;
        }
      }
      cursor++;
    }
    tokenCursor = cursor;
  }

  const candidates = [...groups.entries()]
    .filter(([, group]) => group.totalOccurrenceCount >= 3 && group.sceneCount >= 2)
    .sort((a, b) =>
      b[1].sceneCount - a[1].sceneCount ||
      b[1].totalOccurrenceCount - a[1].totalOccurrenceCount ||
      a[0].localeCompare(b[0], "es")
    );
  const selected = new Map(candidates.slice(0, 20).map(([normalizedWord, group]) => [
    normalizedWord,
    {
      ...group,
      scenes: new Map<number, {
        occurrenceCount: number;
        narrativeOccurrenceCount: number;
        dialogueOccurrenceCount: number;
        occurrences: Array<LocalRange & { readonly context: "narrative" | "dialogue" }>;
      }>()
    }
  ]));

  // Segunda pasada: recoge offsets solo para los veinte candidatos expuestos.
  tokenCursor = 0;
  dialogueCursor = 0;
  for (const scene of scenes) {
    const start = scene.contentRange.start - baseOffset;
    const end = scene.contentRange.end - baseOffset;
    while (tokenCursor < tokens.length && tokens[tokenCursor]!.end <= start) tokenCursor++;

    let cursor = tokenCursor;
    while (cursor < tokens.length && tokens[cursor]!.start < end) {
      const token = tokens[cursor]!;
      while (dialogueCursor < dialogueRanges.length &&
          dialogueRanges[dialogueCursor]!.end <= token.start) dialogueCursor++;
      const group = selected.get(token.normalized);
      if (group && token.start >= start && token.end <= end) {
        const activeDialogueRange = dialogueRanges[dialogueCursor];
        const context = activeDialogueRange &&
          token.start < activeDialogueRange.end && token.end > activeDialogueRange.start
          ? "dialogue" as const
          : "narrative" as const;
        let sceneGroup = group.scenes.get(scene.sceneIndex);
        if (!sceneGroup) {
          sceneGroup = {
            occurrenceCount: 0,
            narrativeOccurrenceCount: 0,
            dialogueOccurrenceCount: 0,
            occurrences: []
          };
          group.scenes.set(scene.sceneIndex, sceneGroup);
        }
        sceneGroup.occurrenceCount++;
        if (context === "dialogue") sceneGroup.dialogueOccurrenceCount++;
        else sceneGroup.narrativeOccurrenceCount++;
        if (sceneGroup.occurrences.length < 12) {
          sceneGroup.occurrences.push({ start: token.start, end: token.end, context });
        }
      }
      cursor++;
    }
    tokenCursor = cursor;
  }

  const echoes = [...selected.entries()].map(([normalizedWord, group]) => ({
    word: group.word,
    normalizedWord,
    sceneCount: group.sceneCount,
    totalOccurrenceCount: group.totalOccurrenceCount,
    scenes: [...group.scenes.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([sceneIndex, sceneGroup]) => ({
        sceneIndex,
        occurrenceCount: sceneGroup.occurrenceCount,
        narrativeOccurrenceCount: sceneGroup.narrativeOccurrenceCount,
        dialogueOccurrenceCount: sceneGroup.dialogueOccurrenceCount,
        contextClassification: sceneGroup.narrativeOccurrenceCount > 0 &&
          sceneGroup.dialogueOccurrenceCount > 0
          ? "mixed" as const
          : sceneGroup.dialogueOccurrenceCount > 0
            ? "dialogue-only" as const
            : "narrative-only" as const,
        occurrences: sceneGroup.occurrences.map(item => ({
          start: baseOffset + item.start,
          end: baseOffset + item.end,
          context: item.context
        })),
        evidenceTruncated: sceneGroup.occurrenceCount > sceneGroup.occurrences.length
      }))
  }));

  return {
    explicitSceneCount: scenes.length,
    candidateCount: candidates.length,
    omittedCandidateCount: Math.max(0, candidates.length - echoes.length),
    echoes
  };
}

function mergeRanges(ranges: readonly LocalRange[]): LocalRange[] {
  const ordered = [...ranges].filter(range => range.end > range.start)
    .sort((a,b) => a.start - b.start || a.end - b.end);
  const merged: LocalRange[] = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
    } else merged.push(range);
  }
  return merged;
}
function findDialogueSegments(text: string): Array<LocalRange & {
  readonly format: LiteraryDialogueSegmentFormat;
}> {
  const segments: Array<LocalRange & { readonly format: LiteraryDialogueSegmentFormat }> = [];
  const quoted = /«([^»]+)»|“([^”]+)”|"([^"]+)"/gu;
  for (const match of text.matchAll(quoted)) {
    const content = match[1] ?? match[2] ?? match[3] ?? "";
    if (!content) continue;
    const start = (match.index ?? 0) + match[0].indexOf(content);
    segments.push({ start, end: start + content.length, format: "quotation" });
  }
  const dashDialogue = /^[ \t]*[—–][ \t]*(.+)$/gmu;
  for (const match of text.matchAll(dashDialogue)) {
    const content = match[1] ?? "";
    if (!content) continue;
    const start = (match.index ?? 0) + match[0].indexOf(content);
    segments.push({ start, end: start + content.length, format: "dialogue-dash" });
  }
  const ordered = segments.sort((a,b) => a.start-b.start || a.end-b.end);
  const merged: Array<LocalRange & { readonly format: LiteraryDialogueSegmentFormat }> = [];
  for (const segment of ordered) {
    const previous = merged[merged.length-1];
    if (previous && segment.start < previous.end) {
      merged[merged.length-1] = {
        start:previous.start,
        end:Math.max(previous.end,segment.end),
        format:previous.format === segment.format ? previous.format : "mixed"
      };
    } else merged.push(segment);
  }
  return merged;
}
function countTokensPerRange(tokens: readonly WordToken[], ranges: readonly LocalRange[]): number[] {
  let tokenIndex = 0;
  const counts: number[] = [];
  for (const range of ranges) {
    while (tokenIndex < tokens.length && tokens[tokenIndex]!.end <= range.start) tokenIndex++;
    let cursor = tokenIndex;
    let count = 0;
    while (cursor < tokens.length && tokens[cursor]!.start < range.end) {
      if (tokens[cursor]!.end > range.start) count++;
      cursor++;
    }
    counts.push(count);
    tokenIndex = cursor;
  }
  return counts;
}
function countTokensInRanges(tokens: readonly WordToken[], ranges: readonly LocalRange[]): number {
  return countTokensPerRange(tokens, ranges).reduce((total, count) => total + count, 0);
}

function countTokensOutsideRangesPerRange(
  tokens: readonly WordToken[],
  scopes: readonly LocalRange[],
  excludedRanges: readonly LocalRange[]
): number[] {
  const counts = scopes.map(() => 0);
  let scopeIndex = 0;
  let excludedIndex = 0;
  for (const token of tokens) {
    while (scopeIndex < scopes.length && scopes[scopeIndex]!.end <= token.start) scopeIndex++;
    if (scopeIndex >= scopes.length) break;
    const scope = scopes[scopeIndex]!;
    if (token.end <= scope.start || token.start >= scope.end) continue;
    while (excludedIndex < excludedRanges.length &&
      excludedRanges[excludedIndex]!.end <= token.start) excludedIndex++;
    const excluded = excludedRanges[excludedIndex];
    if (excluded && token.start < excluded.end && token.end > excluded.start) continue;
    counts[scopeIndex] = (counts[scopeIndex] ?? 0) + 1;
  }
  return counts;
}
function classifyVoiceSignals(
  tokens: readonly WordToken[],
  dialogueRanges: readonly LocalRange[],
  baseOffset: number,
  scope?: LocalRange
): LiteraryVoiceSignal {
  const counts = { firstPerson: 0, secondPerson: 0, thirdPerson: 0 };
  const samples: LiteraryVoiceSignal["samples"][number][] = [];
  const start = scope?.start ?? 0;
  const end = scope?.end ?? Number.POSITIVE_INFINITY;
  let tokenIndex = 0;
  while (tokenIndex < tokens.length && tokens[tokenIndex]!.end <= start) tokenIndex++;
  let rangeIndex = 0;
  while (rangeIndex < dialogueRanges.length && dialogueRanges[rangeIndex]!.end <= start) rangeIndex++;
  for (; tokenIndex < tokens.length && tokens[tokenIndex]!.start < end; tokenIndex++) {
    const token = tokens[tokenIndex]!;
    while (rangeIndex < dialogueRanges.length && dialogueRanges[rangeIndex]!.end <= token.start) rangeIndex++;
    const activeRange = dialogueRanges[rangeIndex];
    if (activeRange && token.start < activeRange.end && token.end > activeRange.start) continue;
    let category: "firstPerson" | "secondPerson" | "thirdPerson" | undefined;
    if (FIRST_PERSON.has(token.normalized)) category = "firstPerson";
    else if (SECOND_PERSON.has(token.normalized)) category = "secondPerson";
    else if (THIRD_PERSON.has(token.normalized)) category = "thirdPerson";
    if (!category) continue;
    counts[category]++;
    if (samples.length < 40) samples.push({
      category, term: token.text, start: baseOffset + token.start, end: baseOffset + token.end
    });
  }
  const active = Object.entries(counts).filter(([,count]) => count > 0).map(([key]) => key);
  let classification: LiteraryVoiceSignalClassification = "undetermined";
  if (active.length > 1) classification = "mixed-signals";
  else if (active[0] === "firstPerson") classification = "first-person-signals";
  else if (active[0] === "secondPerson") classification = "second-person-signals";
  else if (active[0] === "thirdPerson") classification = "third-person-signals";
  return { classification, counts, samples };
}
function toAbsoluteOccurrences(
  ranges: readonly LocalRange[], baseOffset: number, limit: number
): LiteraryAnalysisOccurrence[] {
  return ranges.slice(0, limit).map(item => ({
    start: baseOffset + item.start, end: baseOffset + item.end
  }));
}



function findRepeatedPhrases(
  text: string,
  tokens: readonly WordToken[],
  sentenceRanges: readonly LocalRange[],
  baseOffset: number
): LiteraryRepeatedPhrase[] {
  const groups = new Map<string, {
    readonly phrase: string;
    readonly wordCount: number;
    count: number;
    occurrences: LocalRange[];
  }>();
  let sentenceTokenCursor = 0;
  for (const sentence of sentenceRanges) {
    while (sentenceTokenCursor < tokens.length &&
      tokens[sentenceTokenCursor]!.end <= sentence.start) sentenceTokenCursor++;
    const indexes: number[] = [];
    let cursor = sentenceTokenCursor;
    while (cursor < tokens.length && tokens[cursor]!.start < sentence.end) {
      if (tokens[cursor]!.end <= sentence.end) indexes.push(cursor);
      cursor++;
    }
    for (let start = 0; start < indexes.length; start++) {
      for (let size = 2; size <= 4 && start + size <= indexes.length; size++) {
        const phraseTokens = indexes.slice(start,start+size).map(index => tokens[index]!);
        const hasHardBreak = phraseTokens.slice(1).some((token,index) => {
          const previous = phraseTokens[index]!;
          return /[,;:.!?…\r\n]/u.test(text.slice(previous.end,token.start));
        });
        if (hasHardBreak) break;
        const contentWords = phraseTokens.filter(token =>
          !STOP_WORDS.has(token.normalized) && token.normalized.length > 2
        ).length;
        if (contentWords < 2) continue;
        const key = phraseTokens.map(token => token.normalized).join(" ");
        const first = phraseTokens[0]!;
        const last = phraseTokens[phraseTokens.length-1]!;
        let group = groups.get(key);
        if (!group) {
          group = {
            phrase: phraseTokens.map(token => token.text).join(" "),
            wordCount:size,
            count:0,
            occurrences:[]
          };
          groups.set(key,group);
        }
        group.count++;
        if (group.occurrences.length < 20) {
          group.occurrences.push({start:first.start,end:last.end});
        }
      }
    }
    sentenceTokenCursor = cursor;
  }
  return [...groups.values()]
    .filter(group => group.count >= 2)
    .sort((a,b) => b.count-a.count || b.wordCount-a.wordCount ||
      a.phrase.localeCompare(b.phrase,"es"))
    .slice(0,12)
    .map(group => ({
      phrase:group.phrase,
      wordCount:group.wordCount,
      count:group.count,
      occurrences:group.occurrences.map(item => ({
        start:baseOffset+item.start,
        end:baseOffset+item.end
      }))
    }));
}

function findRhythmTransitions(
  sentenceRanges: readonly LocalRange[],
  sentenceWordCounts: readonly number[],
  baseOffset: number
): LiteraryRhythmTransition[] {
  const candidates: LiteraryRhythmTransition[] = [];
  for (let index = 0; index + 1 < sentenceWordCounts.length; index++) {
    const before = sentenceWordCounts[index] ?? 0;
    const after = sentenceWordCounts[index + 1] ?? 0;
    const shorter = Math.min(before, after);
    const longer = Math.max(before, after);
    if (longer < 16 || longer - shorter < 10 || longer < shorter * 2) continue;
    const beforeRange = sentenceRanges[index]!;
    const afterRange = sentenceRanges[index + 1]!;
    candidates.push({
      beforeSentenceIndex: index + 1,
      afterSentenceIndex: index + 2,
      beforeWordCount: before,
      afterWordCount: after,
      direction: after < before ? "acceleration" : "deceleration",
      occurrences: [
        { start: baseOffset + beforeRange.start, end: baseOffset + beforeRange.end },
        { start: baseOffset + afterRange.start, end: baseOffset + afterRange.end }
      ]
    });
  }
  return candidates.slice(0, 20);
}

function summarizeSceneRhythm(
  sentenceRanges: readonly LocalRange[],
  sentenceWordCounts: readonly number[],
  baseOffset: number
): LiterarySceneRhythmProfile {
  const sentenceCount = sentenceWordCounts.length;
  const totalWords = sentenceWordCounts.reduce((total,count) => total + count,0);
  const average = sentenceCount > 0 ? totalWords / sentenceCount : 0;
  const ordered = [...sentenceWordCounts].sort((a,b) => a-b);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length === 0 ? 0 : ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
  const variance = sentenceCount > 0
    ? sentenceWordCounts.reduce((sum,count) => sum + (count-average)**2,0) / sentenceCount
    : 0;
  const shortest = sentenceCount > 0
    ? sentenceWordCounts.reduce((minimum,count) => Math.min(minimum,count),Number.POSITIVE_INFINITY)
    : 0;
  const longest = sentenceCount > 0
    ? sentenceWordCounts.reduce((maximum,count) => Math.max(maximum,count),0)
    : 0;
  let rhythmProfile: LiteraryRhythmProfile = "insufficient-text";
  if (totalWords >= 20 && sentenceCount >= 2) {
    if (average < 9) rhythmProfile = "fragmented";
    else if (average >= 22) rhythmProfile = "extended";
    else rhythmProfile = "balanced";
  }
  return {
    sentenceCount,
    averageWordsPerSentence:roundMetric(average),
    medianWordsPerSentence:roundMetric(median),
    sentenceLengthStandardDeviation:roundMetric(Math.sqrt(variance)),
    shortestSentenceWords:shortest,
    longestSentenceWords:longest,
    shortSentenceCount:sentenceWordCounts.filter(count => count <= 8).length,
    mediumSentenceCount:sentenceWordCounts.filter(count => count >= 9 && count <= 24).length,
    longSentenceCount:sentenceWordCounts.filter(count => count >= 25).length,
    rhythmProfile,
    transitions:findRhythmTransitions(sentenceRanges,sentenceWordCounts,baseOffset),
    cadence:buildSceneCadence(sentenceRanges,sentenceWordCounts,baseOffset)
  };
}

function getSentenceLengthBand(wordCount: number): LiterarySentenceLengthBand {
  if (wordCount <= 8) return "short";
  if (wordCount <= 24) return "medium";
  return "long";
}

function buildSceneCadence(
  sentenceRanges: readonly LocalRange[],
  sentenceWordCounts: readonly number[],
  baseOffset: number
): LiterarySceneCadenceProfile {
  const bands = sentenceWordCounts.map(getSentenceLengthBand);
  const sentenceBandCounts = {
    short:bands.filter(band => band === "short").length,
    medium:bands.filter(band => band === "medium").length,
    long:bands.filter(band => band === "long").length
  };
  const bandTransitionCounts = {
    shortToShort:0, shortToMedium:0, shortToLong:0,
    mediumToShort:0, mediumToMedium:0, mediumToLong:0,
    longToShort:0, longToMedium:0, longToLong:0
  };
  for (let index=0; index+1<bands.length; index++) {
    const previous = bands[index]!;
    const next = bands[index+1]!;
    const key = `${previous}To${next[0]!.toLocaleUpperCase("en")}${next.slice(1)}` as keyof typeof bandTransitionCounts;
    bandTransitionCounts[key]++;
  }

  const patterns: LiterarySceneCadencePattern[] = [];
  const addPattern = (
    patternType: LiterarySceneCadencePatternType,
    start: number,
    end: number
  ) => {
    const sampleEnd = Math.min(end,start+40);
    patterns.push({
      patternType,
      fromSentenceIndex:start+1,
      toSentenceIndex:end,
      sentenceCount:end-start,
      sentenceWordCounts:sentenceWordCounts.slice(start,sampleEnd),
      lengthBands:bands.slice(start,sampleEnd),
      occurrences:sentenceRanges.slice(start,sampleEnd).map(range => ({
        start:baseOffset+range.start,
        end:baseOffset+range.end
      })),
      evidenceTruncated:end-start>40
    });
  };

  let index=0;
  while (index<bands.length) {
    let end=index+1;
    while (end<bands.length && bands[end]===bands[index]) end++;
    if (end-index>=3) addPattern("stable-length-band-run",index,end);
    index=end;
  }

  index=0;
  while (index+3<bands.length) {
    if (bands[index]===bands[index+1]) { index++; continue; }
    let end=index+2;
    while (end<bands.length && bands[end]===bands[end-2]) end++;
    if (end-index>=4) {
      addPattern("alternating-length-band-run",index,end);
      index=end;
    } else index++;
  }

  for (const direction of [1,-1] as const) {
    index=0;
    while (index+2<sentenceWordCounts.length) {
      const firstStep=(sentenceWordCounts[index+1]??0)-(sentenceWordCounts[index]??0);
      if (direction*firstStep<2) { index++; continue; }
      let end=index+2;
      while (end<sentenceWordCounts.length) {
        const step=(sentenceWordCounts[end]??0)-(sentenceWordCounts[end-1]??0);
        if (direction*step<2) break;
        end++;
      }
      const totalChange=(sentenceWordCounts[end-1]??0)-(sentenceWordCounts[index]??0);
      if (end-index>=3 && direction*totalChange>=8) {
        addPattern(direction===1?"ascending-length-run":"descending-length-run",index,end);
        index=end;
      } else index++;
    }
  }

  patterns.sort((a,b) =>
    a.fromSentenceIndex-b.fromSentenceIndex ||
    a.toSentenceIndex-b.toSentenceIndex ||
    a.patternType.localeCompare(b.patternType,"en")
  );
  const patternTypeCounts = {
    stableLengthBandRun:patterns.filter(item => item.patternType === "stable-length-band-run").length,
    alternatingLengthBandRun:patterns.filter(item => item.patternType === "alternating-length-band-run").length,
    ascendingLengthRun:patterns.filter(item => item.patternType === "ascending-length-run").length,
    descendingLengthRun:patterns.filter(item => item.patternType === "descending-length-run").length
  };
  return {
    sentenceCount:sentenceWordCounts.length,
    sentenceBandCounts,
    bandTransitionCounts,
    patternTypeCounts,
    patternCount:patterns.length,
    patterns:patterns.slice(0,20)
  };
}

function collectSensorySignals(
  tokens: readonly WordToken[], baseOffset: number
): LiterarySensorySignal[] {
  return SENSORY_MODALITIES.map(modality => {
    const vocabulary = SENSORY_LEXICON[modality];
    const matches = tokens.filter(token => vocabulary.has(token.normalized));
    return {
      modality,
      count: matches.length,
      occurrences: matches.slice(0, 20).map(token => ({
        start: baseOffset + token.start,
        end: baseOffset + token.end
      }))
    };
  });
}

function isValidNarrativeIdeaStatusHistory(
  value: unknown,
  currentStatus: NarrativeIdea["status"],
  writerDecisionCount: number,
  omittedStatusHistoryCount: number
): value is readonly NarrativeIdeaStatusChange[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return false;
  for (let index = 0; index < value.length; index++) {
    const change = value[index] as NarrativeIdeaStatusChange | null | undefined;
    if (!change ||
        !["IDEA","incorporated","discarded"].includes(change.status) ||
        !["initial","writer","text-revised"].includes(change.reason) ||
        (change.reason === "text-revised" && change.status !== "IDEA") ||
        (index === 0
          ? omittedStatusHistoryCount === 0
            ? change.reason !== "initial"
            : change.reason === "initial"
          : change.reason === "initial" ||
            change.status === (value[index - 1] as NarrativeIdeaStatusChange).status) ||
        (change.changedAt !== undefined &&
          (!Number.isFinite(change.changedAt) || change.changedAt < 0)) ||
        false) {
      return false;
    }
  }
  const visibleWriterDecisionCount = value.filter(
    (change: NarrativeIdeaStatusChange) => change.reason === "writer"
  ).length;
  // El prefijo omitido contiene el estado inicial, que no cuenta como decisión del escritor.
  return value[value.length - 1]?.status === currentStatus &&
    writerDecisionCount >= visibleWriterDecisionCount &&
    writerDecisionCount - visibleWriterDecisionCount <= Math.max(0, omittedStatusHistoryCount - 1);
}

function validateInput(input: LiteraryAnalysisInput): number {
  const baseOffset = input?.baseOffset ?? 0;
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" ||
      input.text.length > MAX_LITERARY_ANALYSIS_TEXT_UNITS ||
      !Number.isSafeInteger(baseOffset) || baseOffset < 0 ||
      baseOffset > Number.MAX_SAFE_INTEGER - input.text.length ||
      (input.knownCharacters !== undefined &&
        (!Array.isArray(input.knownCharacters) || input.knownCharacters.length > 500)) ||
      (input.knownEvents !== undefined &&
        (!Array.isArray(input.knownEvents) || input.knownEvents.length > 2_000)) ||
      (input.knownProjectEvents !== undefined &&
        (!Array.isArray(input.knownProjectEvents) || input.knownProjectEvents.length > 2_000)) ||
      (input.knownProjectEventsOmittedCount !== undefined &&
        (!Number.isSafeInteger(input.knownProjectEventsOmittedCount) || input.knownProjectEventsOmittedCount < 0)) ||
      (input.knownRelations !== undefined &&
        (!Array.isArray(input.knownRelations) || input.knownRelations.length > 2_000)) ||
      (input.knownIdeas !== undefined &&
        (!Array.isArray(input.knownIdeas) || input.knownIdeas.length > 2_000)) ||
      (input.knownProjectIdeas !== undefined &&
        (!Array.isArray(input.knownProjectIdeas) || input.knownProjectIdeas.length > 2_000)) ||
      (input.knownProjectIdeasOmittedCount !== undefined &&
        (!Number.isSafeInteger(input.knownProjectIdeasOmittedCount) || input.knownProjectIdeasOmittedCount < 0)) ||
      (input.knownRelationsOmittedCount !== undefined &&
        (!Number.isSafeInteger(input.knownRelationsOmittedCount) || input.knownRelationsOmittedCount < 0)) ||
      (input.knownIdeasOmittedCount !== undefined &&
        (!Number.isSafeInteger(input.knownIdeasOmittedCount) || input.knownIdeasOmittedCount < 0)) ||
      (input.knownEventLifecycles !== undefined &&
        (!Array.isArray(input.knownEventLifecycles) || input.knownEventLifecycles.length > 20_000)) ||
      (input.knownAssertions !== undefined &&
        (!Array.isArray(input.knownAssertions) || input.knownAssertions.length > 20_000))) {
    throw new Error("Contexto de análisis literario inválido o fragmento demasiado grande.");
  }
  const knownCharacterIds = new Set<string>();
  for (const character of input.knownCharacters ?? []) {
    if (!character || typeof character.entityId !== "string" || !character.entityId.trim() ||
        knownCharacterIds.has(character.entityId) ||
        typeof character.canonicalName !== "string" || !character.canonicalName.trim() ||
        (character.aliases !== undefined &&
          (!Array.isArray(character.aliases) || character.aliases.some((alias: string) =>
            typeof alias !== "string" || !alias.trim()
          ))) ||
        [character.canonicalName,...(character.aliases ?? [])].some(name => name.length > 120)) {
      throw new Error("El catálogo de personajes del análisis literario es inválido.");
    }
    knownCharacterIds.add(character.entityId);
  }
  const knownEventIds = new Set<string>();
  for (const event of input.knownEvents ?? []) {
    if (!event || typeof event.eventId !== "string" || !event.eventId.trim() ||
        knownEventIds.has(event.eventId) ||
        typeof event.label !== "string" || !event.label.trim() ||
        !Array.isArray(event.participants) || event.participants.length > 500 ||
        event.participants.some((participant: string) => typeof participant !== "string" || !participant.trim()) ||
        !Array.isArray(event.evidence) || event.evidence.length > 200) {
      throw new Error("El catálogo de acontecimientos del análisis literario es inválido.");
    }
    knownEventIds.add(event.eventId);
    for (const evidence of event.evidence) {
      if (!evidence || typeof evidence.documentId !== "string" || !evidence.documentId.trim() ||
          !Number.isSafeInteger(evidence.revision) || evidence.revision < 0 ||
          !Number.isSafeInteger(evidence.start) || evidence.start < 0 ||
          !Number.isSafeInteger(evidence.end) || evidence.end <= evidence.start ||
          typeof evidence.excerpt !== "string" ||
          (evidence.status !== undefined && evidence.status !== "stale")) {
        throw new Error("La evidencia de acontecimiento del análisis literario es inválida.");
      }
    }
  }

  const projectEventIds = new Set<string>();
  for (const event of input.knownProjectEvents ?? []) {
    if (!event || event.projectId !== input.projectId ||
        typeof event.eventId !== "string" || !event.eventId.trim() ||
        projectEventIds.has(event.eventId) ||
        typeof event.label !== "string" || !event.label.trim() ||
        !Array.isArray(event.participants) || event.participants.length > 500 ||
        event.participants.some((participant: string) => typeof participant !== "string" || !participant.trim()) ||
        !Array.isArray(event.evidence) || event.evidence.length > 200 ||
        (event.evidenceCount !== undefined &&
          (!Number.isSafeInteger(event.evidenceCount) ||
            event.evidenceCount < event.evidence.filter(
              (item: LiteraryAnalysisKnownEventEvidence) => item.status !== "stale"
            ).length)) ||
        (event.staleEvidenceCount !== undefined &&
          (!Number.isSafeInteger(event.staleEvidenceCount) || event.staleEvidenceCount < 0)) ||
        (event.timelineTrackId !== undefined &&
          (typeof event.timelineTrackId !== "string" || !event.timelineTrackId.trim() || event.timelineTrackId.length > 256)) ||
        (event.timeReference !== undefined &&
          (!event.timeReference ||
            !["calendar","story-day"].includes(event.timeReference.basis) ||
            !["date","year","day-index"].includes(event.timeReference.precision) ||
            typeof event.timeReference.raw !== "string" || !event.timeReference.raw.trim() ||
            !Number.isFinite(event.timeReference.orderValue)))) {
      throw new Error("El catálogo global de acontecimientos del análisis literario es inválido.");
    }
    projectEventIds.add(event.eventId);
    for (const evidence of event.evidence) {
      if (!evidence || typeof evidence.documentId !== "string" || !evidence.documentId.trim() ||
          !Number.isSafeInteger(evidence.revision) || evidence.revision < 0 ||
          !Number.isSafeInteger(evidence.start) || evidence.start < 0 ||
          !Number.isSafeInteger(evidence.end) || evidence.end <= evidence.start ||
          typeof evidence.excerpt !== "string" ||
          (evidence.status !== undefined && evidence.status !== "stale")) {
        throw new Error("La evidencia del catálogo global de acontecimientos es inválida.");
      }
    }
  }

  const relationIds = new Set<string>();
  for (const relation of input.knownRelations ?? []) {
    if (!relation || relation.projectId !== input.projectId ||
        typeof relation.relationId !== "string" || !relation.relationId.trim() ||
        relationIds.has(relation.relationId) ||
        typeof relation.fromEntityId !== "string" || !relation.fromEntityId.trim() ||
        typeof relation.toEntityId !== "string" || !relation.toEntityId.trim() ||
        typeof relation.relationType !== "string" || !relation.relationType.trim() ||
        !Number.isSafeInteger(relation.evidenceCount) || relation.evidenceCount < 0 ||
        !Number.isSafeInteger(relation.staleEvidenceCount) || relation.staleEvidenceCount < 0 ||
        !Array.isArray(relation.evidence) || relation.evidence.length > 20 ||
        relation.evidenceCount < relation.evidence.length) {
      throw new Error("El catálogo de relaciones narrativas del análisis es inválido.");
    }
    relationIds.add(relation.relationId);
    for (const evidence of relation.evidence) {
      if (!evidence || typeof evidence.documentId !== "string" || !evidence.documentId.trim() ||
          !Number.isSafeInteger(evidence.revision) || evidence.revision < 0 ||
          !Number.isSafeInteger(evidence.start) || evidence.start < 0 ||
          !Number.isSafeInteger(evidence.end) || evidence.end <= evidence.start ||
          typeof evidence.excerpt !== "string" ||
          (evidence.status !== undefined && evidence.status !== "stale")) {
        throw new Error("La evidencia de una relación narrativa es inválida.");
      }
    }
  }

  const projectIdeaIds = new Set<string>();
  for (const idea of input.knownProjectIdeas ?? []) {
    if (!idea || idea.projectId !== input.projectId ||
        typeof idea.ideaId !== "string" || !idea.ideaId.trim() ||
        projectIdeaIds.has(idea.ideaId) ||
        (idea.text !== undefined && (typeof idea.text !== "string" || idea.text.length > 100_000)) ||
        (idea.textOmitted !== undefined && idea.textOmitted !== "budget") ||
        (idea.textOmitted === "budget" && idea.text !== undefined) ||
        !["IDEA","incorporated","discarded"].includes(idea.status) ||
        !Array.isArray(idea.relatedIdeaIds) || idea.relatedIdeaIds.length > MAX_NARRATIVE_IDEA_REFERENCES ||
        idea.relatedIdeaIds.some((id: string) => typeof id !== "string" || !id.trim()) ||
        new Set(idea.relatedIdeaIds).size !== idea.relatedIdeaIds.length ||
        !Number.isSafeInteger(idea.evidenceCount) || idea.evidenceCount < 0 ||
        !Number.isSafeInteger(idea.staleEvidenceCount) || idea.staleEvidenceCount < 0 ||
        !Number.isSafeInteger(idea.writerDecisionCount) || idea.writerDecisionCount < 0 ||
        !Number.isSafeInteger(idea.omittedStatusHistoryCount) || idea.omittedStatusHistoryCount < 0) {
      throw new Error("El catálogo global de ideas del análisis literario es inválido.");
    }
    if (!isValidNarrativeIdeaStatusHistory(
      idea.statusHistory,idea.status,idea.writerDecisionCount,idea.omittedStatusHistoryCount
    )) {
      throw new Error("El historial de decisiones del catálogo global de ideas es inválido.");
    }
    projectIdeaIds.add(idea.ideaId);
  }

  const ideaIds = new Set<string>();
  for (const idea of input.knownIdeas ?? []) {
    if (!idea || idea.projectId !== input.projectId ||
        typeof idea.ideaId !== "string" || !idea.ideaId.trim() ||
        ideaIds.has(idea.ideaId) ||
        typeof idea.text !== "string" || !idea.text.trim() || idea.text.length > 100_000 ||
        !["IDEA","incorporated","discarded"].includes(idea.status) ||
        typeof idea.originDocumentId !== "string" || !idea.originDocumentId.trim() ||
        typeof idea.sourceProjectName !== "string" || !idea.sourceProjectName.trim() ||
        !Array.isArray(idea.relatedEntityIds) || idea.relatedEntityIds.length > MAX_NARRATIVE_IDEA_REFERENCES ||
        idea.relatedEntityIds.some((id: string) => typeof id !== "string" || !knownCharacterIds.has(id)) ||
        new Set(idea.relatedEntityIds).size !== idea.relatedEntityIds.length ||
        !Array.isArray(idea.relatedIdeaIds) || idea.relatedIdeaIds.length > 500 ||
        idea.relatedIdeaIds.some((id: string) => typeof id !== "string" || !id.trim()) ||
        new Set(idea.relatedIdeaIds).size !== idea.relatedIdeaIds.length ||
        idea.relatedIdeaIds.includes(idea.ideaId) ||
        !Number.isSafeInteger(idea.evidenceCount) || idea.evidenceCount < 0 ||
        !Number.isSafeInteger(idea.staleEvidenceCount) || idea.staleEvidenceCount < 0 ||
        !Array.isArray(idea.evidence) || idea.evidence.length > 20 ||
        idea.evidenceCount < idea.evidence.length ||
        !Number.isSafeInteger(idea.writerDecisionCount) || idea.writerDecisionCount < 0 ||
        !Number.isSafeInteger(idea.omittedStatusHistoryCount) || idea.omittedStatusHistoryCount < 0) {
      throw new Error("El catálogo de ideas y decisiones del análisis literario es inválido.");
    }
    if (!isValidNarrativeIdeaStatusHistory(
      idea.statusHistory,idea.status,idea.writerDecisionCount,idea.omittedStatusHistoryCount
    )) {
      throw new Error("El historial de decisiones de una idea vinculada es inválido.");
    }
    ideaIds.add(idea.ideaId);
    for (const evidence of idea.evidence) {
      if (!evidence || typeof evidence.documentId !== "string" || !evidence.documentId.trim() ||
          !Number.isSafeInteger(evidence.revision) || evidence.revision < 0 ||
          !Number.isSafeInteger(evidence.start) || evidence.start < 0 ||
          !Number.isSafeInteger(evidence.end) || evidence.end <= evidence.start ||
          typeof evidence.excerpt !== "string" ||
          (evidence.status !== undefined && evidence.status !== "stale")) {
        throw new Error("La evidencia de una idea vinculada es inválida.");
      }
    }
  }

  const assertionIds = new Set<string>();
  for (const assertion of input.knownAssertions ?? []) {
    if (!assertion || assertion.projectId !== input.projectId ||
        typeof assertion.id !== "string" || !assertion.id.trim() ||
        assertionIds.has(assertion.id) ||
        !knownCharacterIds.has(assertion.entityId) ||
        typeof assertion.entityName !== "string" || !assertion.entityName.trim() ||
        !["age","location","role"].includes(assertion.attribute) ||
        !(typeof assertion.value === "string" && assertion.value.trim() ||
          typeof assertion.value === "number" && Number.isFinite(assertion.value)) ||
        !assertion.evidence || typeof assertion.evidence.documentId !== "string" ||
        !assertion.evidence.documentId.trim() ||
        !Number.isSafeInteger(assertion.evidence.revision) || assertion.evidence.revision<0 ||
        !Number.isSafeInteger(assertion.evidence.start) || assertion.evidence.start<0 ||
        !Number.isSafeInteger(assertion.evidence.end) ||
        assertion.evidence.end<=assertion.evidence.start ||
        typeof assertion.evidence.excerpt !== "string" ||
        (assertion.evidence.status!==undefined && assertion.evidence.status!=="stale") ||
        !Number.isFinite(assertion.capturedAt) || assertion.capturedAt<0) {
      throw new Error("Las afirmaciones históricas del análisis literario son inválidas.");
    }
    if (assertion.timeReference !== undefined &&
        (!assertion.timeReference || !["calendar","story-day"].includes(assertion.timeReference.basis) ||
          !["date","year","day-index"].includes(assertion.timeReference.precision) ||
          typeof assertion.timeReference.raw !== "string" || !assertion.timeReference.raw.trim() ||
          !Number.isFinite(assertion.timeReference.orderValue))) {
      throw new Error("La referencia temporal de una afirmación histórica es inválida.");
    }
    assertionIds.add(assertion.id);
  }

  const lifecycleGroups=new Map<string,EventLifecycle[]>();
  for(const item of input.knownEventLifecycles ?? []) {
    validateEventLifecycle(item,input.projectId);
    if(!knownEventIds.has(item.eventId)) {
      throw new Error("El historial de acontecimiento no pertenece al catálogo analizado.");
    }
    const group=lifecycleGroups.get(item.eventId) ?? [];
    group.push(item);
    lifecycleGroups.set(item.eventId,group);
  }
  for(const [eventId,history] of lifecycleGroups) {
    const ordered=[...history].sort((a,b)=>a.revision-b.revision);
    let previous:EventLifecycle|undefined;
    const revisions=new Set<number>();
    for(const item of ordered) {
      if(revisions.has(item.revision) ||
          (!previous && item.revision!==1) ||
          (previous && (
            item.revision!==previous.revision+1 ||
            item.previousLabel!==previous.newLabel ||
            item.previousParticipants.length!==previous.newParticipants.length ||
            !item.previousParticipants.every((id,index)=>id===previous!.newParticipants[index]) ||
            item.changedAt<previous.changedAt
          ))) {
        throw new Error("El historial de acontecimiento contiene revisiones duplicadas o transiciones discontinuas.");
      }
      revisions.add(item.revision);
      previous=item;
    }
  }
  return baseOffset;
}

/** Analiza un fragmento sin mutar el texto ni persistir información. */
export function analyzeLiteraryFragment(input: LiteraryAnalysisInput): LiteraryAnalysisResult {
  const baseOffset = validateInput(input);
  const text = input.text;
  const tokens = tokenize(text);
  const sentenceRanges = findSentenceRanges(text);
  const paragraphRanges = findParagraphRanges(text);
  const dialogueSegments = findDialogueSegments(text);
  const dialogueRanges = dialogueSegments.map(({start,end}) => ({start,end}));
  const localStructureMarkers = detectLiteraryStructure(text);
  const structuralMarkers: LiteraryStructureMarker[] = localStructureMarkers.map(marker => ({
    markerType:marker.markerType,
    label:marker.label,
    lineIndex:marker.lineIndex,
    occurrence:{start:baseOffset+marker.start,end:baseOffset+marker.end}
  }));
  const explicitScenes = analyzeExplicitScenes(
    text,tokens,baseOffset,localStructureMarkers,input.knownCharacters ?? [],
    input.knownEvents ?? [],dialogueRanges,dialogueSegments,input.documentId,input.revision
  );
  const sceneLexicalEchoes = buildSceneLexicalEchoes(tokens, explicitScenes, dialogueRanges, baseOffset);
  const characterSceneEvidence = buildCharacterSceneEvidenceProfiles(explicitScenes,input.knownCharacters ?? []);
  const eventDependencyAnalysis = buildExplicitEventDependencyAnalysis(
    text,sentenceRanges,explicitScenes,input.knownEvents ?? [],input.documentId,input.revision,baseOffset
  );
  const characterAttributeEvolution = buildCharacterAttributeEvolution(
    explicitScenes,input.knownAssertions ?? [],input.documentId,input.revision
  );
  const sceneContinuity = buildSceneContinuity(explicitScenes);
  const sceneEventAssociationTransitions = buildSceneEventAssociationTransitions(explicitScenes);
  const sceneRhythmTransitions = buildSceneRhythmTransitions(explicitScenes);
  const sceneCadenceTransitions = buildSceneCadenceTransitions(explicitScenes);
  const sceneDialogueTransitions = buildSceneDialogueTransitions(explicitScenes);
  const sceneDialogueFlowTransitions = buildSceneDialogueFlowTransitions(explicitScenes);
  const sceneDialogueFlowSummary = buildSceneDialogueFlowSummary(explicitScenes);
  const sceneCadenceMotifs = buildSceneCadenceMotifs(explicitScenes);
  const sceneVoiceTransitions = compareSceneVoiceSignals(explicitScenes);
  const sceneVoiceProfile = buildSceneVoiceProfile(explicitScenes);
  const sceneVoiceSequences = buildSceneVoiceSequences(explicitScenes);
  const characterCoMentions = findCharacterCoMentionPatterns(explicitScenes);
  const characterMentionDistributions = buildCharacterMentionDistributions(explicitScenes);
  const characterEventEvidenceProfiles = buildCharacterEventEvidenceProfiles(
    explicitScenes,input.knownCharacters ?? []
  );
  const characterNarrativeTrajectories = buildCharacterNarrativeTrajectories(
    explicitScenes,input.knownCharacters ?? [],characterAttributeEvolution,
    characterEventEvidenceProfiles,eventDependencyAnalysis,input.knownProjectEvents ?? [],
    input.documentId,input.revision,input.knownRelations ?? [],input.knownIdeas ?? [],
    input.knownRelationsOmittedCount ?? 0,input.knownIdeasOmittedCount ?? 0,
    input.knownProjectEventsOmittedCount ?? 0
  );
  const knownIdeaTextById = new Map(
    (input.knownIdeas ?? []).map(idea => [idea.ideaId, idea.text] as const)
  );
  const graphIdeas = (input.knownProjectIdeas ?? input.knownIdeas ?? []).map(idea => {
    if (idea.text !== undefined) return idea;
    const knownText = knownIdeaTextById.get(idea.ideaId);
    if (knownText === undefined) return idea;
    if ("textOmitted" in idea) {
      const { textOmitted: _textOmitted, ...ideaWithoutTextOmission } = idea;
      return { ...ideaWithoutTextOmission, text: knownText };
    }
    return { ...idea, text: knownText };
  });
  const usesProjectIdeaCatalog = input.knownProjectIdeas !== undefined;
  const graphOmittedIdeaCount = usesProjectIdeaCatalog
    ? input.knownProjectIdeasOmittedCount ?? 0
    : input.knownIdeasOmittedCount ?? 0;
  const graphCatalogScope = usesProjectIdeaCatalog
    ? "project" as const
    : "character-linked-fallback" as const;
  const ideaGraph = buildLiteraryIdeaGraph(
    graphIdeas,graphOmittedIdeaCount,graphCatalogScope
  );
  const sceneEventEvidenceProfiles = buildSceneEventEvidenceProfiles(explicitScenes);
  const sceneEventSequenceMotifs = buildSceneEventSequenceMotifs(explicitScenes);
  const eventLifecycleAnalysis = buildEventLifecycleAnalysis(
    input.knownEvents ?? [],input.knownEventLifecycles ?? []
  );
  const dialogueSegmentWordCounts = countTokensPerRange(tokens,dialogueRanges);
  const sentenceWordCounts = countTokensPerRange(tokens,sentenceRanges).filter(Boolean);
  const paragraphWordCounts = countTokensPerRange(tokens, paragraphRanges).filter(Boolean);

  const wordGroups = new Map<string, WordToken[]>();
  for (const token of tokens) {
    if (STOP_WORDS.has(token.normalized) || token.normalized.length < 3) continue;
    const group = wordGroups.get(token.normalized) ?? [];
    group.push(token);
    wordGroups.set(token.normalized, group);
  }
  const repeatedWords: LiteraryRepeatedWord[] = [...wordGroups.entries()]
    .filter(([,items]) => items.length >= 3)
    .map(([word,items]) => ({
      word, count: items.length,
      occurrences: items.slice(0,20).map(item => ({
        start: baseOffset + item.start, end: baseOffset + item.end
      }))
    }))
    .sort((a,b) => b.count - a.count || a.word.localeCompare(b.word,"es"))
    .slice(0,12);

  const openingGroups = new Map<string, OccurrenceGroup>();
  let openingTokenCursor = 0;
  for (const range of sentenceRanges) {
    while (openingTokenCursor < tokens.length &&
      tokens[openingTokenCursor]!.end <= range.start) openingTokenCursor++;
    const first = tokens[openingTokenCursor];
    const second = tokens[openingTokenCursor + 1];
    if (!first || !second || first.start < range.start || second.end > range.end) continue;
    const key = first.normalized + " " + second.normalized;
    const group = openingGroups.get(key) ?? {
      key, label: first.text + " " + second.text, occurrences: []
    };
    group.occurrences.push({ start:first.start, end:second.end });
    openingGroups.set(key,group);
  }
  const repeatedSentenceOpenings: LiterarySentenceOpening[] = [...openingGroups.values()]
    .filter(group => group.occurrences.length >= 2)
    .sort((a,b) => b.occurrences.length - a.occurrences.length || a.key.localeCompare(b.key,"es"))
    .slice(0,8)
    .map(group => ({
      opening:group.label, count:group.occurrences.length,
      occurrences:toAbsoluteOccurrences(group.occurrences,baseOffset,12)
    }));


  const anaphoraCandidates: LiteraryAnaphoraCandidate[] = [];
  const sentenceOpeningRecords: {
    readonly key: string;
    readonly label: string;
    readonly occurrence: LocalRange;
  }[] = [];
  let anaphoraTokenCursor = 0;
  for (const range of sentenceRanges) {
    while (anaphoraTokenCursor < tokens.length &&
      tokens[anaphoraTokenCursor]!.end <= range.start) anaphoraTokenCursor++;
    const first = tokens[anaphoraTokenCursor];
    const second = tokens[anaphoraTokenCursor + 1];
    if (!first || !second || first.start < range.start || second.end > range.end) {
      sentenceOpeningRecords.push({ key: "", label: "", occurrence: { start: range.start, end: range.start } });
      continue;
    }
    sentenceOpeningRecords.push({
      key: first.normalized + " " + second.normalized,
      label: first.text + " " + second.text,
      occurrence: { start: first.start, end: second.end }
    });
  }
  let runStart = 0;
  while (runStart < sentenceOpeningRecords.length) {
    const record = sentenceOpeningRecords[runStart]!;
    let runEnd = runStart + 1;
    if (record.key) {
      while (runEnd < sentenceOpeningRecords.length &&
        sentenceOpeningRecords[runEnd]!.key === record.key) runEnd++;
    }
    if (record.key && runEnd - runStart >= 2) {
      const run = sentenceOpeningRecords.slice(runStart, runEnd);
      anaphoraCandidates.push({
        phrase: record.label,
        sentenceIndexes: run.map((_, index) => runStart + index + 1),
        occurrences: run.map(item => ({
          start: baseOffset + item.occurrence.start,
          end: baseOffset + item.occurrence.end
        }))
      });
    }
    runStart = runEnd;
  }

  const wordCount = tokens.length;
  const uniqueWordCount = new Set(tokens.map(token => token.normalized)).size;
  const dialogueWordCount = dialogueSegmentWordCounts.reduce((total,count) => total+count,0);
  const averageWordsPerDialogueSegment = dialogueSegmentWordCounts.length > 0
    ? dialogueWordCount/dialogueSegmentWordCounts.length : 0;
  const longestDialogueSegmentWords = dialogueSegmentWordCounts.length > 0
    ? dialogueSegmentWordCounts.reduce((maximum,count) => Math.max(maximum,count),0) : 0;
  const averageWordsPerSentence = sentenceWordCounts.length > 0 ? wordCount / sentenceWordCounts.length : 0;
  const orderedSentenceLengths = [...sentenceWordCounts].sort((a,b) => a-b);
  const middle = Math.floor(orderedSentenceLengths.length / 2);
  const medianWordsPerSentence = orderedSentenceLengths.length === 0 ? 0 :
    orderedSentenceLengths.length % 2 === 0
      ? (orderedSentenceLengths[middle - 1]! + orderedSentenceLengths[middle]!) / 2
      : orderedSentenceLengths[middle]!;
  const sentenceLengthVariance = sentenceWordCounts.length > 0
    ? sentenceWordCounts.reduce((sum,count) => sum + (count-averageWordsPerSentence)**2,0) / sentenceWordCounts.length
    : 0;
  const sentenceLengthStandardDeviation = Math.sqrt(sentenceLengthVariance);
  const averageWordsPerParagraph = paragraphWordCounts.length > 0 ? wordCount / paragraphWordCounts.length : 0;
  const shortestSentenceWords = sentenceWordCounts.length > 0
    ? sentenceWordCounts.reduce((minimum, count) => Math.min(minimum, count), Number.POSITIVE_INFINITY)
    : 0;
  const longestSentenceWords = sentenceWordCounts.length > 0
    ? sentenceWordCounts.reduce((maximum, count) => Math.max(maximum, count), 0)
    : 0;

  let rhythmProfile: LiteraryRhythmProfile = "insufficient-text";
  if (wordCount >= 20 && sentenceWordCounts.length >= 2) {
    if (averageWordsPerSentence < 9) rhythmProfile = "fragmented";
    else if (averageWordsPerSentence >= 22) rhythmProfile = "extended";
    else rhythmProfile = "balanced";
  }
  const dialogueRatio = wordCount > 0 ? dialogueWordCount / wordCount : 0;
  let dialogueDensity: LiteraryDialogueDensity = "none";
  if (dialogueRatio > 0) {
    if (dialogueRatio < 0.1) dialogueDensity = "low";
    else if (dialogueRatio < 0.3) dialogueDensity = "moderate";
    else dialogueDensity = "high";
  }
  const metrics: LiteraryAnalysisMetrics = {
    characterCount:[...text].length,
    letterCount:[...text.matchAll(LETTER_PATTERN)].length,
    wordCount,
    sentenceCount:sentenceRanges.length,
    paragraphCount:paragraphRanges.length,
    averageWordsPerSentence:roundMetric(averageWordsPerSentence),
    medianWordsPerSentence:roundMetric(medianWordsPerSentence),
    sentenceLengthStandardDeviation:roundMetric(sentenceLengthStandardDeviation),
    averageWordsPerParagraph:roundMetric(averageWordsPerParagraph),
    lexicalDiversity:wordCount > 0 ? roundMetric(uniqueWordCount / wordCount) : 0,
    dialogueWordCount,
    dialogueRatio:roundMetric(dialogueRatio),
    dialogueSegmentCount:dialogueSegments.length,
    averageWordsPerDialogueSegment:roundMetric(averageWordsPerDialogueSegment),
    longestDialogueSegmentWords,
    questionMarkCount:[...text.matchAll(/\?/gu)].length,
    exclamationMarkCount:[...text.matchAll(/!/gu)].length,
    ellipsisCount:[...text.matchAll(/…|\.{3,}/gu)].length,
    shortestSentenceWords,
    longestSentenceWords,
    shortSentenceCount:sentenceWordCounts.filter(count => count <= 8).length,
    mediumSentenceCount:sentenceWordCounts.filter(count => count >= 9 && count <= 24).length,
    longSentenceCount:sentenceWordCounts.filter(count => count >= 25).length
  };
  return {
    projectId:input.projectId,
    documentId:input.documentId,
    revision:input.revision,
    range:{start:baseOffset,end:baseOffset+text.length},
    metrics,
    rhythmProfile,
    rhythmTransitions:findRhythmTransitions(sentenceRanges,sentenceWordCounts,baseOffset),
    dialogueDensity,
    dialogueSegments:dialogueSegments.slice(0,40).map((segment,index) => ({
      segmentIndex:index+1,
      format:segment.format,
      wordCount:dialogueSegmentWordCounts[index] ?? 0,
      occurrence:{start:baseOffset+segment.start,end:baseOffset+segment.end}
    })),
    structuralMarkers,
    explicitScenes,
    sceneLexicalEchoes,
    sceneContinuity,
    sceneEventAssociationTransitions,
    sceneRhythmTransitions,
    sceneCadenceTransitions,
    sceneDialogueTransitions,
    sceneDialogueFlowTransitions,
    sceneDialogueFlowSummary,
    sceneCadenceMotifs,
    sceneVoiceTransitions,
    sceneVoiceProfile,
    sceneVoiceSequences,
    characterCoMentions,
    characterMentionDistributions,
    characterSceneEvidence,
    characterAttributeEvolution,
    eventDependencyAnalysis,
    characterNarrativeTrajectories,
    ideaGraph,
    characterEventEvidenceProfiles,
    sceneEventEvidenceProfiles,
    sceneEventSequenceMotifs,
    eventLifecycleAnalysis,
    voiceSignals:classifyVoiceSignals(tokens,dialogueRanges,baseOffset),
    repeatedWords,
    repeatedPhrases:findRepeatedPhrases(text,tokens,sentenceRanges,baseOffset),
    repeatedSentenceOpenings,
    anaphoraCandidates,
    sensorySignals:collectSensorySignals(tokens,baseOffset),
    caveats:[
      "El ritmo usa umbrales de longitud de oración; no mide calidad, tensión ni musicalidad.",
      "Los segmentos de diálogo son señales de formato; una línea o cita no equivale siempre a un turno completo ni permite identificar al hablante.",
      "El perfil de diálogo por escena recorta los segmentos reconocidos al contenido local, omite formatos no detectados y no atribuye hablantes.",
      "La estructura de escenas solo se segmenta cuando hay encabezados o separadores explícitos; no infiere cambios de escena a partir del contenido.",
      "La presencia de personajes se basa en nombres y alias literales no ambiguos del catálogo del proyecto; no implica que el personaje actúe, hable o sea el punto de vista de la escena.",
      "Las tasas de mención por cada 1.000 palabras usan como denominador el texto completo de cada escena explícita, incluido el diálogo, y el agregado pondera por la extensión total de las escenas.",
      "La distribución de menciones resume solo coincidencias literales en escenas explícitas; los conteos se calculan antes de limitar las muestras de offsets y formas de nombre, pero heredan el máximo de 40 identidades expuestas por escena.",
      "La distribución de menciones resume solo coincidencias literales en escenas explícitas; los intervalos sin mención y las rachas observadas no demuestran ausencia, entrada o salida del personaje, protagonismo ni arco narrativo.",
      "La mención nominal de un participante se comprueba en el contenido completo de la escena vinculada, no exige solapamiento con el rango exacto de evidencia.",
      "Los perfiles de evidencia por participante agrupan únicamente asociaciones de acontecimiento declaradas por el proyecto y rangos vigentes de la misma revisión; no demuestran presencia física, acción, diálogo ni interacción.",
      "Las escenas con más de 100 acontecimientos enlazados se identifican con eventLinksTruncated; los perfiles agregados informan qué escenas de origen tienen esa muestra recortada.",
      "Los rangos de evidencia se cuentan antes de limitar las muestras UTF-16, pero el resumen hereda el máximo de 100 vínculos por escena y 200 asociaciones participante/acontecimiento.",
      "Los acontecimientos se vinculan a escenas solo cuando la evidencia vigente coincide en documento y revisión y se solapa con el rango de la escena. Que un participante declarado no sea mencionado por nombre no demuestra que esté ausente.",
      "Los motivos de secuencia comparan conjuntos ordenados por ID en ventanas de dos y tres escenas; excluyen ventanas con vínculos fuente truncados, y las posiciones vacías no prueban ausencia de sucesos ni establecen orden temporal interno o causalidad.",
      "Las transiciones de acontecimientos comparan conteos de rangos y menciones nominales de participantes declarados entre escenas contiguas; los participantes proceden de una ficha vigente común, por lo que no se infieren cambios de asociación, presencia o acción. Las ausencias en escenas truncadas quedan como desconocidas.",
      "El historial de acontecimientos conserva cambios explícitos versionados de etiqueta y participantes. currentStateMatchesLatestRevision=false señala una diferencia entre la última instantánea registrada y la ficha vigente, pero no identifica su causa; las adiciones y retiros se calculan por IDs y no por menciones textuales.",
      "La continuidad compara solo escenas explícitas contiguas: las menciones literales y la evidencia por ID de acontecimiento describen cobertura textual, no presencia física, cronología ni contradicciones.",
      "Los motivos de cadencia agrupan firmas idénticas de bandas y tipo de patrón entre escenas explícitas del fragmento; usan las muestras de patrones expuestas por escena y no implican recurrencia temática ni intención autoral.",
      "Las variaciones métricas del ritmo comparan longitud y cambios entre oraciones completas de escenas explícitas; incluyen diálogo y no implican por sí solas tensión, intención ni calidad narrativa.",
      "Las variaciones gramaticales entre escenas comparan conteos de pronombres explícitos fuera del diálogo reconocido; no demuestran un cambio de narrador, focalización ni voz autoral.",
      "El perfil de voz agrega señales y clasificaciones por escena explícita; la cobertura indica en cuántas escenas aparece una categoría, no la identidad ni continuidad de una voz narrativa.",
      "Los tramos estables requieren tres escenas con la misma clasificación única y las alternancias requieren cuatro escenas con dos clasificaciones únicas que se turnan; las señales mixtas o indeterminadas interrumpen los patrones y estos no identifican narradores.",
      "La co-mención agrupa nombres de personajes conocidos que aparecen en una misma escena explícita; no demuestra interacción, relación, diálogo ni presencia física compartida.",
      "Las señales de persona cuentan pronombres explícitos fuera del diálogo y no identifican por sí solas al narrador.",
      "La diversidad léxica usa formas normalizadas; no desambigua homónimos ni funciones gramaticales.",
      "La anáfora se propone por coincidencia literal de las dos primeras palabras en oraciones consecutivas.",
      "Las frases recurrentes requieren coincidencia literal de 2 a 4 palabras dentro de una oración y no prueban un motivo temático.",
      "Las señales sensoriales usan un vocabulario explícito y no detectan metáforas ni sentidos implícitos.",
      "Los tramos del flujo de diálogo agrupan párrafos consecutivos por presencia o ausencia de diálogo reconocido; los párrafos mixtos y dialogados comparten tramo y esto no identifica turnos ni hablantes.",
      "Las transiciones de diálogo comparan únicamente métricas reconocidas entre escenas explícitas contiguas y no identifican hablantes.",
      "Los ecos léxicos agrupan formas normalizadas idénticas que aparecen al menos tres veces en dos o más escenas explícitas; separan ocurrencias en narración y diálogo reconocido, no agrupan sinónimos o flexiones ni demuestran un motivo temático. Cada escena conserva hasta doce ocurrencias UTF-16.",
      "Los perfiles de personajes separan menciones nominales literales de asociaciones a acontecimientos con evidencia vigente de la misma revisión. Una mención no prueba participación; una asociación de participante no prueba presencia física, acción, causalidad ni cambio del personaje. Las escenas con muestras truncadas declaran el estado como desconocido en vez de tratarlo como ausencia.",
      "La evolución de atributos compara afirmaciones explícitas de edad, ubicación y rol en escenas de la misma revisión del documento analizado. Solo los cambios entre valores únicos se clasifican como changed-value; varios valores en una escena o la falta de afirmación no se resuelven como contradicción ni como continuidad.",
      "La cronología de atributos entre capítulos compara únicamente referencias temporales explícitas con la misma base y precisión; las afirmaciones sin fecha comparable no se ordenan. Varios valores asociados al mismo punto temporal se conservan como multiple-values-at-same-time, y una fecha explícita no demuestra causalidad ni resuelve contradicciones.",
      "Las dependencias entre acontecimientos son candidatos basados en dos evidencias vigentes de la misma oración y en conectores causales literales reconocidos. La dirección se orienta según el patrón del conector, pero no demuestra causalidad, suficiencia explicativa ni una secuencia completa; requiere revisión editorial.",
      "Las trayectorias narrativas consolidan por ID atributos, asociaciones de participante y candidatos causales expuestos; los límites de perfiles y escenas se informan por separado. Una trayectoria sin evidencia en una escena no prueba ausencia en la ficción ni describe por sí sola un arco psicológico. Las relaciones causales conservan el estado candidate-needs-review.",
      "La cronología global de acontecimientos usa la lista actual de participantes y fechas explícitas de las fichas del proyecto. No reconstruye listas históricas de participantes a partir de menciones, no ordena eventos sin tiempo comparable y no cruza transiciones entre pistas temporales no declaradas.",
      "Las relaciones por personaje reflejan fichas actuales y evidencia activa/obsoleta; el modelo NarrativeRelation no conserva transiciones versionadas, por lo que no se infieren cambios históricos. Las ideas vinculadas exponen sus estados y cambios de escritor documentados, pero incorporated no verifica la presencia literal del texto en el manuscrito.",
      "El grafo de ideas usa solo los vínculos dirigidos relatedIdeaIds declarados por el escritor. Los destinos fuera del snapshot no se consideran inexistentes; los ciclos describen conectividad del grafo, no causalidad, contradicción ni dependencia temporal."
    ]
  };
}
