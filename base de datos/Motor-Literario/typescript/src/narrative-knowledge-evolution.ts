/**
 * Evolución explícita del estado de una afirmación narrativa.
 *
 * Compara señales textuales de confirmación/refutación con afirmaciones previas
 * cuyo contenido coincide literalmente tras normalización conservadora.
 * No decide la verdad ni resuelve paráfrasis.
 */
import type { NarrativeAttributedClaim } from "./narrative-claim-extraction";
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

export type NarrativeKnowledgeEvaluation =
  | "confirmed"
  | "refuted"
  | "uncertain"
  | "concealed";

export interface NarrativeKnowledgeEvolution {
  readonly id: string;
  readonly projectId: string;
  readonly evaluatorEntityId: string;
  readonly evaluation: NarrativeKnowledgeEvaluation;
  readonly matchedClaimId?: string;
  readonly content: string;
  readonly matchStatus: "exact-match" | "no-prior-match" | "ambiguous-prior-match";
  readonly reviewStatus: "candidate";
  readonly evidence: TextEvidence;
  readonly claimEvidence?: TextEvidence;
}

export interface NarrativeKnowledgeEvolutionInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly priorClaims?: readonly NarrativeAttributedClaim[];
  readonly baseOffset?: number;
}

export const MAX_NARRATIVE_KNOWLEDGE_EVOLUTIONS = 200;
const MAX_TEXT_UNITS = 2_000_000;
const MAX_PRIOR_CLAIMS = 5_000;
const MAX_CONTENT_UNITS = 1_000;

interface NamedCharacter {
  readonly entity: NarrativeEntity;
  readonly name: string;
}

const SIGNALS: readonly {
  readonly verb: string;
  readonly evaluation: NarrativeKnowledgeEvaluation;
}[] = [
  { verb: "confirmó", evaluation: "confirmed" },
  { verb: "confirmo", evaluation: "confirmed" },
  { verb: "comprobó", evaluation: "confirmed" },
  { verb: "comprobo", evaluation: "confirmed" },
  { verb: "verificó", evaluation: "confirmed" },
  { verb: "verifico", evaluation: "confirmed" },
  { verb: "desmintió", evaluation: "refuted" },
  { verb: "desmintio", evaluation: "refuted" },
  { verb: "refutó", evaluation: "refuted" },
  { verb: "refuto", evaluation: "refuted" },
  { verb: "descartó", evaluation: "refuted" },
  { verb: "descarto", evaluation: "refuted" },
  { verb: "dudó", evaluation: "uncertain" },
  { verb: "dudo", evaluation: "uncertain" },
  { verb: "cuestionó", evaluation: "uncertain" },
  { verb: "cuestiono", evaluation: "uncertain" },
  { verb: "ocultó", evaluation: "concealed" },
  { verb: "oculto", evaluation: "concealed" },
  { verb: "escondió", evaluation: "concealed" },
  { verb: "escondio", evaluation: "concealed" }
];

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es")
    .replace(/[.!?;:,]+$/gu, "");
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function validate(input: NarrativeKnowledgeEvolutionInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_TEXT_UNITS ||
      !Array.isArray(input.entities) ||
      (input.priorClaims !== undefined &&
        (!Array.isArray(input.priorClaims) || input.priorClaims.length > MAX_PRIOR_CLAIMS)) ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para analizar la evolución del conocimiento narrativo.");
  }
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        !Array.isArray(entity.aliases) ||
        entity.aliases.some(alias => typeof alias !== "string" || !alias.trim())) {
      throw new Error("Las entidades deben ser válidas y pertenecer al proyecto.");
    }
  }
  for (const claim of input.priorClaims ?? []) {
    if (!claim || claim.projectId !== input.projectId ||
        typeof claim.id !== "string" || typeof claim.content !== "string" ||
        !claim.content.trim() ||
        !input.entities.some(entity => entity.kind === "character" && entity.id === claim.speakerEntityId) ||
        !claim.evidence || typeof claim.evidence.documentId !== "string" ||
        !Number.isSafeInteger(claim.evidence.revision) ||
        !Number.isSafeInteger(claim.evidence.start) ||
        !Number.isSafeInteger(claim.evidence.end) ||
        claim.evidence.start < 0 || claim.evidence.end < claim.evidence.start) {
      throw new Error("Las afirmaciones previas deben pertenecer al proyecto y a personajes conocidos.");
    }
  }
}
function uniqueCharacters(entities: readonly NarrativeEntity[]): readonly NamedCharacter[] {
  const owners = new Map<string, NarrativeEntity | null>();
  for (const entity of entities.filter(item => item.kind === "character")) {
    for (const name of [entity.canonicalName, ...entity.aliases]) {
      const key = normalize(name);
      const current = owners.get(key);
      owners.set(key, current == null || current.id === entity.id ? entity : null);
    }
  }
  return [...owners.entries()]
    .filter((entry): entry is [string, NarrativeEntity] => entry[1] !== null)
    .map(([key, entity]) => ({
      entity,
      name: [entity.canonicalName, ...entity.aliases].find(name => normalize(name) === key)!
    }))
    .sort((a, b) => b.name.length - a.name.length);
}
function makeEvidence(
  input: NarrativeKnowledgeEvolutionInput,
  start: number,
  end: number,
  excerpt: string
): TextEvidence {
  return {
    documentId: input.documentId,
    revision: input.revision,
    start: (input.baseOffset ?? 0) + start,
    end: (input.baseOffset ?? 0) + end,
    excerpt
  };
}

/**
 * Solo genera candidatos si un personaje expresa un verbo explícito de
 * evaluación. La asociación con memoria previa exige igualdad textual exacta
 * normalizada; paráfrasis o varios antecedentes compatibles quedan sin enlace.
 */
export function extractNarrativeKnowledgeEvolution(
  input: NarrativeKnowledgeEvolutionInput
): readonly NarrativeKnowledgeEvolution[] {
  validate(input);
  const names = uniqueCharacters(input.entities);
  const found = new Map<string, NarrativeKnowledgeEvolution>();
  const priorByContent = new Map<string, NarrativeAttributedClaim[]>();
  for (const claim of input.priorClaims ?? []) {
    const key = normalize(claim.content);
    const bucket = priorByContent.get(key) ?? [];
    bucket.push(claim);
    priorByContent.set(key, bucket);
  }

  for (const lineMatch of input.text.matchAll(/[^\n]+/gu)) {
    if (found.size >= MAX_NARRATIVE_KNOWLEDGE_EVOLUTIONS) break;
    const line = lineMatch[0];
    const lineStart = lineMatch.index ?? 0;
    for (const { entity, name } of names) {
      if (found.size >= MAX_NARRATIVE_KNOWLEDGE_EVOLUTIONS) break;
      for (const signal of SIGNALS) {
        const expression = new RegExp(
          String.raw`(?<![\p{L}\p{M}\p{N}_])(${escapeRegExp(name)})(?![\p{L}\p{M}\p{N}_])\s+${escapeRegExp(signal.verb)}\s+(?:que\s+)?(.+?)(?=[.!?;]|$)`,
          "giu"
        );
        for (const match of line.matchAll(expression)) {
          const content = (match[2] ?? "").trim();
          if (!content || content.length > MAX_CONTENT_UNITS) continue;
          const matched = priorByContent.get(normalize(content)) ?? [];
          const uniqueIds = [...new Map(matched.map(claim => [claim.id, claim])).values()];
          const matchStatus = uniqueIds.length === 1
            ? "exact-match" as const
            : uniqueIds.length === 0
              ? "no-prior-match" as const
              : "ambiguous-prior-match" as const;
          const contentStart = lineStart + match.index + match[0].lastIndexOf(match[2] ?? "");
          const contentEnd = contentStart + content.length;
          const absoluteStart = (input.baseOffset ?? 0) + lineStart + match.index;
          const id = `knowledge-evolution:${input.documentId}:${absoluteStart}:${entity.id}:${signal.evaluation}`;
          found.set(id, {
            id,
            projectId: input.projectId,
            evaluatorEntityId: entity.id,
            evaluation: signal.evaluation,
            ...(matchStatus === "exact-match" ? { matchedClaimId: uniqueIds[0]!.id } : {}),
            content,
            matchStatus,
            reviewStatus: "candidate",
            evidence: makeEvidence(input, lineStart + match.index,
              contentEnd, line.slice(match.index, contentEnd - lineStart)),
            ...(matchStatus === "exact-match"
              ? { claimEvidence: uniqueIds[0]!.evidence }
              : {})
          });
          if (found.size >= MAX_NARRATIVE_KNOWLEDGE_EVOLUTIONS) break;
        }
      }
    }
  }
  return [...found.values()].sort((a, b) =>
    a.evidence.start - b.evidence.start || a.id.localeCompare(b.id)
  );
}
