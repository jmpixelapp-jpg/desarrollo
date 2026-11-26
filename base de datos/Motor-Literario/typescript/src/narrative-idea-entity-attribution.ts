import type { NarrativeEntity } from "./narrative-knowledge";
import type { NarrativeIdeaCandidate } from "./narrative-idea-discovery";

export interface NarrativeIdeaEntityAttribution {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly ideaCandidateId: string;
  readonly status: "attributed" | "ambiguous" | "unattributed";
  /** Solo contiene una identidad cuando la atribución es inequívoca. */
  readonly entityId?: string;
  /** Identidades compatibles; nunca se elige una por proximidad. */
  readonly candidateEntityIds: readonly string[];
  readonly matchedNames: readonly string[];
  readonly evidence: NarrativeIdeaCandidate["evidence"];
}

export interface NarrativeIdeaEntityAttributionInput {
  readonly projectId: string;
  readonly ideas: readonly NarrativeIdeaCandidate[];
  readonly entities: readonly NarrativeEntity[];
}

const MAX_IDEAS = 100;
const MAX_ENTITIES = 500;
const MAX_NAME_UNITS = 120;
const MAX_EVIDENCE_UNITS = 2_000_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function validate(input: NarrativeIdeaEntityAttributionInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !Array.isArray(input.ideas) || input.ideas.length > MAX_IDEAS ||
      !Array.isArray(input.entities) || input.entities.length > MAX_ENTITIES) {
    throw new Error("Contexto inválido para atribuir ideas a entidades.");
  }
  const entityIds = new Set<string>();
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() ||
        entityIds.has(entity.id) || typeof entity.canonicalName !== "string" ||
        !Array.isArray(entity.aliases) || entity.aliases.length > 100) {
      throw new Error("El catálogo contiene entidades inválidas o duplicadas.");
    }
    entityIds.add(entity.id);
  }
  const ideaIds = new Set<string>();
  for (const idea of input.ideas) {
    if (!idea || idea.projectId !== input.projectId ||
        typeof idea.id !== "string" || !idea.id.trim() ||
        ideaIds.has(idea.id) || typeof idea.documentId !== "string" ||
        !Number.isSafeInteger(idea.revision) || idea.revision < 0 ||
        !idea.evidence || typeof idea.evidence.excerpt !== "string" ||
        idea.evidence.excerpt.length > MAX_EVIDENCE_UNITS ||
        !Number.isSafeInteger(idea.evidence.start) ||
        !Number.isSafeInteger(idea.evidence.end) ||
        idea.evidence.start < 0 || idea.evidence.end <= idea.evidence.start ||
        typeof idea.text !== "string" || !idea.text) {
      throw new Error("La colección contiene candidatos de idea inválidos o duplicados.");
    }
    ideaIds.add(idea.id);
  }
}

/**
 * Atribuye una idea solo a entidades nombradas explícitamente antes del
 * fragmento que expresa la idea, dentro de la misma oración probatoria.
 *
 * La función no persiste relaciones ni convierte candidatos en canon.
 * Si la superficie de la idea no aparece una sola vez en la evidencia, o
 * aparecen varios titulares posibles, se abstiene de elegir una identidad.
 */
export function attributeNarrativeIdeasToEntities(
  input: NarrativeIdeaEntityAttributionInput
): readonly NarrativeIdeaEntityAttribution[] {
  validate(input);
  const output: NarrativeIdeaEntityAttribution[] = [];

  for (const idea of input.ideas) {
    const excerpt = idea.evidence.excerpt;
    const captureIndex = excerpt.indexOf(idea.text);
    if (captureIndex < 0 || excerpt.indexOf(idea.text, captureIndex + 1) >= 0) {
      output.push({
        id: "idea-entity-attribution:" + idea.id,
        projectId: input.projectId,
        documentId: idea.documentId,
        revision: idea.revision,
        ideaCandidateId: idea.id,
        status: "unattributed",
        candidateEntityIds: [],
        matchedNames: [],
        evidence: idea.evidence
      });
      continue;
    }

    const subjectContext = excerpt.slice(0, captureIndex);
    const matches = new Map<string, Set<string>>();
    for (const entity of input.entities) {
      const names = [...new Set([entity.canonicalName, ...entity.aliases]
        .filter(name => typeof name === "string" && name.trim() &&
          name.length <= MAX_NAME_UNITS))];
      for (const name of names) {
        const expression = new RegExp(
          "(^|[^\\p{L}\\p{M}\\p{N}_])(" + escapeRegExp(name) +
          ")(?=$|[^\\p{L}\\p{M}\\p{N}_])",
          "iu"
        );
        if (!expression.test(subjectContext)) continue;
        const entityNames = matches.get(entity.id) ?? new Set<string>();
        entityNames.add(name);
        matches.set(entity.id, entityNames);
      }
    }

    const candidateEntityIds = [...matches.keys()].sort((a, b) => a.localeCompare(b));
    const matchedNames = [...new Set([...matches.values()].flatMap(names => [...names]))]
      .sort((a, b) => a.localeCompare(b));
    const status = candidateEntityIds.length === 1 ? "attributed" :
      candidateEntityIds.length > 1 ? "ambiguous" : "unattributed";
    output.push({
      id: "idea-entity-attribution:" + idea.id,
      projectId: input.projectId,
      documentId: idea.documentId,
      revision: idea.revision,
      ideaCandidateId: idea.id,
      status,
      ...(status === "attributed" ? { entityId: candidateEntityIds[0] } : {}),
      candidateEntityIds,
      matchedNames,
      evidence: idea.evidence
    });
  }

  return output;
}
