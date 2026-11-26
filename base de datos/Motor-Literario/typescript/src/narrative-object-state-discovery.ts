/**
 * Propuestas de trayectoria de objetos derivadas de observaciones literales.
 *
 * No muta estados ni confirma propiedad, posesión o transferencia. Cada salida
 * conserva las evidencias de acción, objeto y participantes y requiere revisión.
 */
import type { TextEvidence } from "./narrative-knowledge";
import type { NarrativeObservationCandidate } from "./narrative-observation-discovery";

export type NarrativeObjectTransitionKind =
  | "discovered"
  | "lost"
  | "transferred"
  | "received";

export type NarrativeObjectEffectStatus =
  | "candidate"
  | "prospective"
  | "not-applied";

export interface NarrativeObjectTransitionCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly observationId: string;
  readonly objectEntityId: string;
  readonly transition: NarrativeObjectTransitionKind;
  /** Participante sujeto activo cuando el texto lo permite; nunca se inventa. */
  readonly actorEntityId?: string;
  /** Receptor explícito; en «recibió» corresponde al sujeto activo. */
  readonly recipientEntityId?: string;
  readonly polarity: "affirmed" | "negated";
  readonly grammaticalTense: NarrativeObservationCandidate["grammaticalTense"];
  /** No es un estado consolidado: futuro, negación o candidato revisable. */
  readonly effectStatus: NarrativeObjectEffectStatus;
  readonly actionEvidence: TextEvidence;
  readonly objectEvidence: TextEvidence;
  readonly actorEvidence?: TextEvidence;
  readonly recipientEvidence?: TextEvidence;
  readonly contextEvidence: TextEvidence;
  readonly reviewStatus: "candidate";
}

export interface NarrativeObjectStateDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly observations: readonly NarrativeObservationCandidate[];
}

export const MAX_NARRATIVE_OBJECT_TRANSITION_CANDIDATES = 200;

function validEvidence(
  evidence: TextEvidence | undefined,
  input: NarrativeObjectStateDiscoveryInput
): evidence is TextEvidence {
  return !!evidence &&
    evidence.documentId === input.documentId &&
    evidence.revision === input.revision &&
    Number.isSafeInteger(evidence.start) && evidence.start >= 0 &&
    Number.isSafeInteger(evidence.end) && evidence.end > evidence.start &&
    typeof evidence.excerpt === "string" &&
    evidence.excerpt.length > 0 &&
    evidence.status !== "stale";
}

function validateInput(input: NarrativeObjectStateDiscoveryInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      !Array.isArray(input.observations)) {
    throw new Error("Contexto inválido para descubrir cambios de estado de objetos.");
  }
  const ids = new Set<string>();
  for (const observation of input.observations) {
    if (!observation || observation.projectId !== input.projectId ||
        observation.documentId !== input.documentId ||
        observation.revision !== input.revision ||
        typeof observation.id !== "string" || !observation.id.trim() ||
        ids.has(observation.id) ||
        !validEvidence(observation.actionEvidence, input) ||
        !validEvidence(observation.evidence, input)) {
      throw new Error("La lista contiene observaciones duplicadas, ajenas o sin evidencia válida.");
    }
    ids.add(observation.id);
    if (observation.grammaticalObjectCandidate &&
        !validEvidence(observation.grammaticalObjectCandidate.evidence, input)) {
      throw new Error("La evidencia del objeto gramatical no es válida.");
    }
    if (observation.grammaticalSubjectCandidate &&
        !validEvidence(observation.grammaticalSubjectCandidate.evidence, input)) {
      throw new Error("La evidencia del sujeto gramatical no es válida.");
    }
    if (observation.personalObjectCandidate &&
        !validEvidence(observation.personalObjectCandidate.evidence, input)) {
      throw new Error("La evidencia del complemento personal no es válida.");
    }
  }
}

function effectStatus(
  observation: NarrativeObservationCandidate
): NarrativeObjectEffectStatus {
  if (observation.polarity === "negated") return "not-applied";
  if (observation.grammaticalTense === "future") return "prospective";
  return "candidate";
}

/**
 * Reconoce únicamente cuatro patrones léxicos con objeto directo identificado:
 * encontrar, perder, entregar y recibir. No calcula un inventario de posesión.
 */
export function discoverNarrativeObjectTransitionCandidates(
  input: NarrativeObjectStateDiscoveryInput
): readonly NarrativeObjectTransitionCandidate[] {
  validateInput(input);
  const results: NarrativeObjectTransitionCandidate[] = [];

  for (const observation of input.observations) {
    const object = observation.grammaticalObjectCandidate;
    if (!object) continue;

    const subject = observation.grammaticalSubjectCandidate;
    const activeSubject = subject?.voice === "active" ? subject : undefined;
    let transition: NarrativeObjectTransitionKind | undefined;
    let actorEntityId: string | undefined;
    let actorEvidence: TextEvidence | undefined;
    let recipientEntityId: string | undefined;
    let recipientEvidence: TextEvidence | undefined;

    switch (observation.action) {
      case "encontrar":
        if (!activeSubject) continue;
        transition = "discovered";
        actorEntityId = activeSubject.entityId;
        actorEvidence = activeSubject.evidence;
        break;
      case "perder":
        if (!activeSubject) continue;
        transition = "lost";
        actorEntityId = activeSubject.entityId;
        actorEvidence = activeSubject.evidence;
        break;
      case "entregar":
        if (!activeSubject || !observation.personalObjectCandidate) continue;
        transition = "transferred";
        actorEntityId = activeSubject.entityId;
        actorEvidence = activeSubject.evidence;
        recipientEntityId = observation.personalObjectCandidate.entityId;
        recipientEvidence = observation.personalObjectCandidate.evidence;
        break;
      case "recibir":
        if (!activeSubject) continue;
        transition = "received";
        recipientEntityId = activeSubject.entityId;
        recipientEvidence = activeSubject.evidence;
        break;
      default:
        continue;
    }

    results.push({
      id: `${observation.id}:object-transition:${transition}`,
      projectId: input.projectId,
      documentId: input.documentId,
      revision: input.revision,
      observationId: observation.id,
      objectEntityId: object.entityId,
      transition,
      ...(actorEntityId ? { actorEntityId } : {}),
      ...(recipientEntityId ? { recipientEntityId } : {}),
      polarity: observation.polarity,
      grammaticalTense: observation.grammaticalTense,
      effectStatus: effectStatus(observation),
      actionEvidence: observation.actionEvidence,
      objectEvidence: object.evidence,
      ...(actorEvidence ? { actorEvidence } : {}),
      ...(recipientEvidence ? { recipientEvidence } : {}),
      contextEvidence: observation.evidence,
      reviewStatus: "candidate"
    });

    if (results.length >= MAX_NARRATIVE_OBJECT_TRANSITION_CANDIDATES) break;
  }

  return results;
}
