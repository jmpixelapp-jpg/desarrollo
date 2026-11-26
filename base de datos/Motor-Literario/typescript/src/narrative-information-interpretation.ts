/**
 * Detecta interpretaciones explícitas de información recibida.
 * Una diferencia textual no prueba por sí sola que el personaje haya entendido mal.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";
import type { NarrativeInformationProvenance } from "./narrative-information-provenance";

export type NarrativeInterpretationSignal = "understood" | "interpreted" | "explicit-misinterpretation";
export type NarrativeInterpretationComparison =
  | "exact-content-match" | "different-content" | "no-prior-information" | "ambiguous-prior-information";

export interface NarrativeInformationInterpretation {
  readonly id: string;
  readonly projectId: string;
  readonly interpreterEntityId: string;
  readonly signal: NarrativeInterpretationSignal;
  readonly interpretedContent: string;
  readonly comparison: NarrativeInterpretationComparison;
  readonly priorInformationId?: string;
  readonly reviewStatus: "candidate";
  readonly evidence: TextEvidence;
  readonly priorEvidence?: TextEvidence;
}
export interface NarrativeInformationInterpretationInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly priorInformation?: readonly NarrativeInformationProvenance[];
  readonly baseOffset?: number;
}
export const MAX_NARRATIVE_INFORMATION_INTERPRETATIONS = 200;
const MAX_TEXT_UNITS = 2_000_000;
const MAX_PRIOR_INFORMATION = 5_000;
const MAX_CONTENT_UNITS = 1_000;

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ")
    .toLocaleLowerCase("es").replace(/[.!?;:,]+$/gu, "");
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&");
}
function evidence(input: NarrativeInformationInterpretationInput, start: number, end: number, excerpt: string): TextEvidence {
  return {
    documentId: input.documentId, revision: input.revision,
    start: (input.baseOffset ?? 0) + start,
    end: (input.baseOffset ?? 0) + end, excerpt
  };
}
function validate(input: NarrativeInformationInterpretationInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_TEXT_UNITS ||
      !Array.isArray(input.entities) ||
      (input.priorInformation !== undefined &&
        (!Array.isArray(input.priorInformation) || input.priorInformation.length > MAX_PRIOR_INFORMATION)) ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para analizar interpretaciones narrativas.");
  }
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        !Array.isArray(entity.aliases)) {
      throw new Error("Las entidades deben ser válidas y pertenecer al proyecto.");
    }
  }
  for (const record of input.priorInformation ?? []) {
    if (!record || record.projectId !== input.projectId ||
        typeof record.id !== "string" || !record.id.trim() ||
        typeof record.content !== "string" || !record.content.trim() ||
        !record.informationHolderEntityId ||
        !input.entities.some(entity => entity.kind === "character" && entity.id === record.informationHolderEntityId) ||
        !record.evidence || typeof record.evidence.documentId !== "string" ||
        !Number.isSafeInteger(record.evidence.revision) ||
        !Number.isSafeInteger(record.evidence.start) ||
        !Number.isSafeInteger(record.evidence.end) ||
        record.evidence.start < 0 || record.evidence.end < record.evidence.start) {
      throw new Error("La información previa debe pertenecer al proyecto y a personajes conocidos.");
    }
  }
}
function uniqueCharacters(entities: readonly NarrativeEntity[]): readonly { entity: NarrativeEntity; name: string }[] {
  const owners = new Map<string, NarrativeEntity | null>();
  for (const entity of entities.filter(item => item.kind === "character")) {
    for (const name of [entity.canonicalName, ...entity.aliases]) {
      const key = normalize(name);
      const current = owners.get(key);
      owners.set(key, current === undefined || current?.id === entity.id ? entity : null);
    }
  }
  return [...owners.entries()]
    .filter((entry): entry is [string, NarrativeEntity] => entry[1] !== null)
    .map(([key, entity]) => ({
      entity, name: [entity.canonicalName, ...entity.aliases].find(name => normalize(name) === key)!
    }))
    .sort((a, b) => b.name.length - a.name.length);
}

export function extractNarrativeInformationInterpretations(
  input: NarrativeInformationInterpretationInput
): readonly NarrativeInformationInterpretation[] {
  validate(input);
  const names = uniqueCharacters(input.entities);
  const found = new Map<string, NarrativeInformationInterpretation>();
  const patterns: readonly { verb: string; signal: NarrativeInterpretationSignal }[] = [
    { verb: "entendió mal", signal: "explicit-misinterpretation" },
    { verb: "entendio mal", signal: "explicit-misinterpretation" },
    { verb: "interpretó erróneamente", signal: "explicit-misinterpretation" },
    { verb: "interpreto erroneamente", signal: "explicit-misinterpretation" },
    { verb: "malinterpretó", signal: "explicit-misinterpretation" },
    { verb: "malinterpreto", signal: "explicit-misinterpretation" },
    { verb: "entendió", signal: "understood" },
    { verb: "entendio", signal: "understood" },
    { verb: "interpretó", signal: "interpreted" },
    { verb: "interpreto", signal: "interpreted" }
  ];
  for (const lineMatch of input.text.matchAll(/[^\n]+/gu)) {
    if (found.size >= MAX_NARRATIVE_INFORMATION_INTERPRETATIONS) break;
    const line = lineMatch[0];
    const lineStart = lineMatch.index ?? 0;
    for (const { entity, name } of names) {
      for (const pattern of patterns) {
        const expression = new RegExp(
          String.raw`(?<![\p{L}\p{M}\p{N}_])(${escapeRegExp(name)})(?![\p{L}\p{M}\p{N}_])\s+${escapeRegExp(pattern.verb)}\s+que\s+(.+?)(?=[.!?;]|$)`,
          "giu"
        );
        for (const match of line.matchAll(expression)) {
          if (found.size >= MAX_NARRATIVE_INFORMATION_INTERPRETATIONS) break;
          const content = (match[2] ?? "").trim();
          if (!content || content.length > MAX_CONTENT_UNITS) continue;
          const exact = (input.priorInformation ?? []).filter(record =>
            record.informationHolderEntityId === entity.id && normalize(record.content) === normalize(content)
          );
          const holderRecords = (input.priorInformation ?? []).filter(record =>
            record.informationHolderEntityId === entity.id
          );
          const pool = exact.length ? exact : holderRecords;
          const unique = [...new Map(pool.map(record => [record.id, record])).values()];
          const selected = unique.length === 1 ? unique[0] : undefined;
          const comparison: NarrativeInterpretationComparison =
            unique.length > 1 ? "ambiguous-prior-information" :
            !selected ? "no-prior-information" :
            exact.length === 1 ? "exact-content-match" : "different-content";
          const contentStart = lineStart + match.index + match[0].lastIndexOf(match[2] ?? "");
          const contentEnd = contentStart + content.length;
          const start = lineStart + match.index;
          const id = "interpretation:" + input.documentId + ":" +
            ((input.baseOffset ?? 0) + start) + ":" + entity.id + ":" + pattern.signal;
          found.set(id, {
            id, projectId: input.projectId, interpreterEntityId: entity.id,
            signal: pattern.signal, interpretedContent: content, comparison,
            ...(selected ? { priorInformationId: selected.id, priorEvidence: selected.evidence } : {}),
            reviewStatus: "candidate",
            evidence: evidence(input, start, contentEnd, line.slice(match.index, contentEnd - lineStart))
          });
        }
      }
    }
  }
  return [...found.values()].sort((a, b) =>
    a.evidence.start - b.evidence.start || a.id.localeCompare(b.id)
  );
}
