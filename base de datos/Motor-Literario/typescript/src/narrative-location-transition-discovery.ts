/**
 * Descubre movimientos vinculados a lugares explícitamente mencionados.
 *
 * No estima coordenadas, distancias ni ubicación actual. Solo propone
 * transiciones cuando acción, actor y relación preposicional con el lugar
 * aparecen en la misma evidencia textual verificable.
 */
import type { TextEvidence } from "./narrative-knowledge";
import type { NarrativeObservationCandidate } from "./narrative-observation-discovery";

export type NarrativeLocationTransitionKind =
  | "arrived"
  | "departed"
  | "entered"
  | "passed-through"
  | "returned";

export type NarrativeLocationEffectStatus =
  | "candidate"
  | "prospective"
  | "not-applied"
  | "unresolved";

export interface NarrativeLocationTransitionCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly observationId: string;
  readonly locationEntityId: string;
  readonly transition: NarrativeLocationTransitionKind;
  readonly actorEntityId?: string;
  readonly polarity: "affirmed" | "negated";
  readonly grammaticalTense: NarrativeObservationCandidate["grammaticalTense"];
  readonly effectStatus: NarrativeLocationEffectStatus;
  readonly actionEvidence: TextEvidence;
  readonly locationEvidence: TextEvidence;
  readonly actorEvidence?: TextEvidence;
  readonly relationEvidence: TextEvidence;
  readonly contextEvidence: TextEvidence;
  readonly reviewStatus: "candidate";
}

export interface NarrativeLocationTransitionDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly observations: readonly NarrativeObservationCandidate[];
}

export const MAX_NARRATIVE_LOCATION_TRANSITION_CANDIDATES = 200;

function validEvidence(
  evidence: TextEvidence | undefined,
  input: NarrativeLocationTransitionDiscoveryInput
): evidence is TextEvidence {
  return !!evidence &&
    evidence.documentId === input.documentId &&
    evidence.revision === input.revision &&
    Number.isSafeInteger(evidence.start) && evidence.start >= 0 &&
    Number.isSafeInteger(evidence.end) && evidence.end > evidence.start &&
    typeof evidence.excerpt === "string" &&
    evidence.end - evidence.start === evidence.excerpt.length &&
    evidence.status !== "stale";
}

function contained(inner: TextEvidence, outer: TextEvidence): boolean {
  if (inner.start < outer.start || inner.end > outer.end) return false;
  return outer.excerpt.slice(
    inner.start - outer.start,
    inner.end - outer.start
  ) === inner.excerpt;
}

function validate(input: NarrativeLocationTransitionDiscoveryInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      !Array.isArray(input.observations)) {
    throw new Error("Contexto inválido para descubrir trayectorias de ubicación.");
  }
  const ids = new Set<string>();
  for (const observation of input.observations) {
    if (!observation || observation.projectId !== input.projectId ||
        observation.documentId !== input.documentId ||
        observation.revision !== input.revision ||
        typeof observation.id !== "string" || !observation.id.trim() ||
        ids.has(observation.id) ||
        !validEvidence(observation.evidence, input) ||
        !validEvidence(observation.actionEvidence, input) ||
        !contained(observation.actionEvidence, observation.evidence) ||
        typeof observation.action !== "string" || !observation.action.trim() ||
        !Array.isArray(observation.entityMentionEvidence)) {
      throw new Error("La observación contiene evidencia inválida, ajena o inconsistente.");
    }
    ids.add(observation.id);
    for (const mention of observation.entityMentionEvidence) {
      if (!mention || typeof mention.entityId !== "string" ||
          !mention.entityId.trim() || !validEvidence(mention.evidence, input) ||
          !contained(mention.evidence, observation.evidence)) {
        throw new Error("La mención de entidad no está respaldada por el contexto literal.");
      }
    }
    if (observation.grammaticalSubjectCandidate &&
        !validEvidence(observation.grammaticalSubjectCandidate.evidence, input)) {
      throw new Error("La evidencia del sujeto gramatical no es válida.");
    }
  }
}

function effectStatus(
  observation: NarrativeObservationCandidate
): NarrativeLocationEffectStatus {
  if (observation.polarity === "negated") return "not-applied";
  if (observation.grammaticalTense === "future") return "prospective";
  if (observation.grammaticalTense === "unknown" ||
      observation.grammaticalTense === "infinitive" ||
      observation.grammaticalTense === "gerund" ||
      observation.grammaticalTense === "participle") return "unresolved";
  return "candidate";
}

function transitionFor(
  action: string,
  between: string
): NarrativeLocationTransitionKind | undefined {
  const phrase = between.toLocaleLowerCase("es").normalize("NFC");
  if (action === "llegar" &&
      /^\s+(?:a|al|hasta|en)\s+$/u.test(phrase)) return "arrived";
  if (action === "salir" &&
      /^\s+(?:de|desde)\s+$/u.test(phrase)) return "departed";
  if (action === "entrar" &&
      /^\s+(?:en|a|al|hacia)\s+$/u.test(phrase)) return "entered";
  if (action === "cruzar" &&
      /^\s+(?:por|a\s+trav[eé]s\s+de|a\s+lo\s+largo\s+de)\s+$/u.test(phrase)) {
    return "passed-through";
  }
  if ((action === "regresar" || action === "volver") &&
      /^\s+(?:a|al|hacia|hasta)\s+$/u.test(phrase)) return "returned";
  return undefined;
}

/**
 * Solo reconoce relaciones explícitas verbo + preposición + entidad location.
 * No convierte una mención cercana en destino, origen ni posición actual.
 */
export function discoverNarrativeLocationTransitionCandidates(
  input: NarrativeLocationTransitionDiscoveryInput
): readonly NarrativeLocationTransitionCandidate[] {
  validate(input);
  const results: NarrativeLocationTransitionCandidate[] = [];
  const seen = new Set<string>();

  for (const observation of input.observations) {
    const locations = observation.entityMentionEvidence
      .filter(mention => mention.entityKind === "location")
      .sort((a, b) => a.evidence.start - b.evidence.start);
    if (locations.length === 0) continue;

    const subject = observation.grammaticalSubjectCandidate;
    const actor = subject?.voice === "active" ? subject : undefined;
    for (const location of locations) {
      const locationEvidence = location.evidence;
      if (locationEvidence.start <= observation.actionEvidence.end) continue;
      const between = observation.evidence.excerpt.slice(
        observation.actionEvidence.end - observation.evidence.start,
        locationEvidence.start - observation.evidence.start
      );
      const transition = transitionFor(observation.action, between);
      if (!transition) continue;

      const id = "location-transition:" + observation.documentId + ":" +
        observation.revision + ":" + observation.actionEvidence.start + ":" +
        location.entityId + ":" + transition;
      if (seen.has(id)) continue;
      seen.add(id);

      const relationStart = observation.actionEvidence.end;
      const relationEnd = locationEvidence.start;
      const relationEvidence: TextEvidence = {
        documentId: input.documentId,
        revision: input.revision,
        start: relationStart,
        end: relationEnd,
        excerpt: between
      };
      results.push({
        id,
        projectId: input.projectId,
        documentId: input.documentId,
        revision: input.revision,
        observationId: observation.id,
        locationEntityId: location.entityId,
        transition,
        ...(actor ? { actorEntityId: actor.entityId, actorEvidence: actor.evidence } : {}),
        polarity: observation.polarity,
        grammaticalTense: observation.grammaticalTense,
        effectStatus: effectStatus(observation),
        actionEvidence: observation.actionEvidence,
        locationEvidence,
        relationEvidence,
        contextEvidence: observation.evidence,
        reviewStatus: "candidate"
      });
      if (results.length >= MAX_NARRATIVE_LOCATION_TRANSITION_CANDIDATES) return results;
    }
  }
  return results.sort((a, b) =>
    a.actionEvidence.start - b.actionEvidence.start ||
    a.locationEvidence.start - b.locationEvidence.start
  );
}
