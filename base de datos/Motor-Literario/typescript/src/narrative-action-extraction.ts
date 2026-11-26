/**
 * Extracción conservadora de acciones explícitas entre entidades narrativas.
 * No deduce causalidad ni completa sujetos u objetos omitidos.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

export const MAX_NARRATIVE_ACTIONS = 200;
const MAX_TEXT_UNITS = 2_000_000;

export interface NarrativeActionCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly actorEntityId: string;
  readonly action: string;
  readonly targetEntityId: string;
  readonly polarity: "affirmed" | "negated";
  readonly reviewStatus: "candidate";
  readonly evidence: TextEvidence;
}
export interface NarrativeActionExtractionInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
}

const ACTIONS = [
  "acompañó", "acompaña", "acompañaba", "protegió", "protege", "protegía",
  "traicionó", "traiciona", "traicionaba", "destruyó", "destruye", "destruía",
  "encontró", "encuentra", "encontraba", "entregó", "entrega", "entregaba",
  "rescató", "rescata", "rescataba", "atacó", "ataca", "atacaba",
  "ayudó", "ayuda", "ayudaba", "salvó", "salva", "salvaba",
  "buscó", "busca", "buscaba", "abrió", "abre", "abría",
  "cerró", "cierra", "cerraba", "mató", "mata", "mataba"
] as const;

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es");
}
function escapeRegExp(value: string): string {
  return value.split("").map(char => "|\\{}()[]^$+*?.-".includes(char) ? "\\" + char : char).join("");
}
function validate(input: NarrativeActionExtractionInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_TEXT_UNITS ||
      !Array.isArray(input.entities) ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para extraer acciones narrativas.");
  }
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() ||
        typeof entity.kind !== "string" ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        !Array.isArray(entity.aliases) ||
        entity.aliases.some(alias => typeof alias !== "string" || !alias.trim())) {
      throw new Error("Las entidades deben ser válidas y pertenecer al proyecto.");
    }
  }
}

/** Extrae relaciones actor-acción-objetivo con nombres explícitos y no ambiguos. */
export function extractNarrativeActionCandidates(
  input: NarrativeActionExtractionInput
): readonly NarrativeActionCandidate[] {
  validate(input);
  const baseOffset = input.baseOffset ?? 0;
  const entities = input.entities.filter(entity => entity.projectId === input.projectId);
  const owners = new Map<string, { entity: NarrativeEntity; name: string } | null>();
  for (const entity of entities) {
    for (const name of [entity.canonicalName, ...entity.aliases]) {
      const key = normalize(name);
      const previous = owners.get(key);
      owners.set(key, previous === undefined || previous?.entity.id === entity.id
        ? { entity, name }
        : null);
    }
  }
  const unique = [...owners.values()].filter(
    (value): value is { entity: NarrativeEntity; name: string } => value !== null
  );
  const actors = unique.filter(value => value.entity.kind === "character");
  const targets = unique;
  if (!actors.length || !targets.length) return [];

  const actionPattern = ACTIONS.map(escapeRegExp).sort((a, b) => b.length - a.length).join("|");
  const results = new Map<string, NarrativeActionCandidate>();
  for (const line of input.text.matchAll(/[^\n]+/gu)) {
    const lineText = line[0];
    for (const actor of actors) {
      for (const target of targets) {
        if (actor.entity.id === target.entity.id) continue;
        const expression = new RegExp(
          "(?<![\\p{L}\\p{M}\\p{N}_])" + escapeRegExp(actor.name) +
          "(?![\\p{L}\\p{M}\\p{N}_])\\s+(no\\s+)?(" + actionPattern +
          ")\\s+(?:(?:a|al|la|las|el|los|un|una|unos|unas)\\s+)?" +
          escapeRegExp(target.name) + "(?![\\p{L}\\p{M}\\p{N}_])",
          "giu"
        );
        for (const match of lineText.matchAll(expression)) {
          const action = (match[2] ?? "").toLocaleLowerCase("es");
          const localStart = line.index + match.index;
          const localEnd = localStart + match[0].length;
          const start = baseOffset + localStart;
          const end = baseOffset + localEnd;
          const id = "action:" + input.documentId + ":" + start + ":" +
            actor.entity.id + ":" + target.entity.id;
          results.set(id, {
            id, projectId: input.projectId, actorEntityId: actor.entity.id,
            action, targetEntityId: target.entity.id,
            polarity: match[1] ? "negated" : "affirmed",
            reviewStatus: "candidate",
            evidence: {
              documentId: input.documentId, revision: input.revision,
              start, end, excerpt: lineText
            }
          });
          if (results.size >= MAX_NARRATIVE_ACTIONS) break;
        }
        if (results.size >= MAX_NARRATIVE_ACTIONS) break;
      }
      if (results.size >= MAX_NARRATIVE_ACTIONS) break;
    }
    if (results.size >= MAX_NARRATIVE_ACTIONS) break;
  }
  return [...results.values()].sort((a, b) =>
    a.evidence.start - b.evidence.start || a.id.localeCompare(b.id)
  );
}
