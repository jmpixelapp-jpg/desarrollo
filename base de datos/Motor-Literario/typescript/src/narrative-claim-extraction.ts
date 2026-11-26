/**
 * Extracción conservadora de afirmaciones atribuidas a personajes.
 * No convierte creencias, recuerdos ni temores en hechos narrativos.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

export type NarrativeAttributionKind = "belief" | "assertion" | "memory" | "fear" | "speech";

export interface NarrativeAttributedClaim {
  readonly id: string;
  readonly projectId: string;
  readonly speakerEntityId: string;
  readonly attribution: string;
  readonly kind: NarrativeAttributionKind;
  readonly content: string;
  readonly polarity: "affirmed" | "negated";
  readonly reviewStatus: "candidate";
  readonly evidence: TextEvidence;
}

export interface NarrativeClaimExtractionInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
}

export const MAX_NARRATIVE_CLAIMS = 200;
const MAX_TEXT_UNITS = 2_000_000;
const MAX_CONTENT_UNITS = 1000;

const VERBS: readonly { verb: string; kind: NarrativeAttributionKind }[] = [
  { verb: "cree", kind: "belief" }, { verb: "piensa", kind: "belief" },
  { verb: "supone", kind: "belief" }, { verb: "sospecha", kind: "belief" },
  { verb: "considera", kind: "belief" }, { verb: "afirma", kind: "assertion" },
  { verb: "asegura", kind: "assertion" }, { verb: "declara", kind: "assertion" },
  { verb: "recuerda", kind: "memory" }, { verb: "olvida", kind: "memory" },
  { verb: "teme", kind: "fear" }, { verb: "dijo", kind: "speech" },
  { verb: "dice", kind: "speech" }, { verb: "contó", kind: "speech" },
  { verb: "confiesa", kind: "speech" }
];

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es");
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
}
function validate(input: NarrativeClaimExtractionInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_TEXT_UNITS ||
      !Array.isArray(input.entities) ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para extraer afirmaciones narrativas.");
  }
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        !Array.isArray(entity.aliases)) {
      throw new Error("Las entidades deben ser válidas y pertenecer al proyecto.");
    }
  }
}

/** Atribuye una frase solo si el nombre resuelve a una identidad única. */
export function extractNarrativeAttributedClaims(
  input: NarrativeClaimExtractionInput
): readonly NarrativeAttributedClaim[] {
  validate(input);
  const baseOffset = input.baseOffset ?? 0;
  const characters = input.entities.filter(entity =>
    entity.projectId === input.projectId && entity.kind === "character"
  );
  const nameOwners = new Map<string, NarrativeEntity | null>();
  for (const entity of characters) {
    for (const name of [entity.canonicalName, ...entity.aliases]) {
      const key = normalizeName(name);
      const owner = nameOwners.get(key);
      nameOwners.set(key, owner === undefined || owner?.id === entity.id ? entity : null);
    }
  }
  const names = [...nameOwners.entries()]
    .filter((entry): entry is [string, NarrativeEntity] => entry[1] !== null)
    .map(([normalized, entity]) => ({
      entity,
      name: [entity.canonicalName, ...entity.aliases]
        .find(value => normalizeName(value) === normalized)!
    }))
    .sort((a, b) => b.name.length - a.name.length);
  if (!names.length) return [];

  const verbAlternation = VERBS.map(item => escapeRegExp(item.verb)).join("|");
  const found = new Map<string, NarrativeAttributedClaim>();
  for (const line of input.text.matchAll(/[^\n]+/gu)) {
    for (const { entity, name } of names) {
      const expression = new RegExp(
        String.raw\`(?<![\p{L}\p{M}\p{N}_])(\${escapeRegExp(name)})(?![\p{L}\p{M}\p{N}_])\s+(no\s+)?(\${verbAlternation})\s+(?:que\s+)?(.+?)(?=[.!?;]|$)\`,
        "giu"
      );
      for (const match of line[0].matchAll(expression)) {
        const verb = (match[3] ?? "").toLocaleLowerCase("es");
        const definition = VERBS.find(item => item.verb === verb);
        const content = (match[4] ?? "").trim();
        if (!definition || !content || content.length > MAX_CONTENT_UNITS) continue;

        const lineStart = line.index;
        const relativeStart = match.index + match[0].lastIndexOf(match[4] ?? "");
        const contentStart = lineStart + relativeStart;
        const contentEnd = contentStart + content.length;
        const evidenceStart = baseOffset + lineStart + match.index;
        const evidenceEnd = baseOffset + contentEnd;
        const id = \`claim:\${input.documentId}:\${evidenceStart}:\${entity.id}\`;
        found.set(id, {
          id,
          projectId: input.projectId,
          speakerEntityId: entity.id,
          attribution: verb,
          kind: definition.kind,
          content,
          polarity: match[2] ? "negated" : "affirmed",
          reviewStatus: "candidate",
          evidence: {
            documentId: input.documentId,
            revision: input.revision,
            start: evidenceStart,
            end: evidenceEnd,
            excerpt: line[0]
          }
        });
        if (found.size >= MAX_NARRATIVE_CLAIMS) break;
      }
      if (found.size >= MAX_NARRATIVE_CLAIMS) break;
    }
    if (found.size >= MAX_NARRATIVE_CLAIMS) break;
  }
  return [...found.values()].sort((a, b) =>
    a.evidence.start - b.evidence.start || a.id.localeCompare(b.id)
  );
}
