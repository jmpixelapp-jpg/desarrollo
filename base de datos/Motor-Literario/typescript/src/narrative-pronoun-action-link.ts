/**
 * Vincula referencias pronominales ya evaluadas con acciones verbales explícitas.
 *
 * No intenta descubrir pronombres ni resolver antecedentes. Consume la salida
 * del resolver conservador y solo reconoce un verbo inmediatamente posterior
 * al pronombre. Las acciones resultantes siguen siendo candidatos revisables.
 */
import type {
  NarrativePronounReference,
  NarrativePronounResolution
} from "./narrative-pronoun-resolution";

export const MAX_PRONOUN_ACTION_CANDIDATES = 200;
const MAX_TEXT_UNITS = 2_000_000;

export interface NarrativePronounActionCandidate {
  readonly id: string;
  readonly referenceId: string;
  readonly actorEntityId?: string;
  readonly candidateActorEntityIds: readonly string[];
  readonly action: string;
  readonly polarity: "affirmed" | "negated";
  readonly status: "candidate" | "ambiguous";
  readonly evidence: {
    readonly documentId: string;
    readonly revision: number;
    readonly start: number;
    readonly end: number;
    readonly excerpt: string;
  };
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Convierte una referencia resuelta en actor de una acción explícita.
 * Las referencias ambiguas conservan los posibles actores, sin elegir uno.
 */
export function extractNarrativePronounActionCandidates(
  text: string,
  references: readonly NarrativePronounReference[],
  resolutions: readonly NarrativePronounResolution[]
): readonly NarrativePronounActionCandidate[] {
  if (typeof text !== "string" || text.length > MAX_TEXT_UNITS ||
      !Array.isArray(references) || !Array.isArray(resolutions)) {
    throw new Error("Entrada inválida para vincular pronombres con acciones.");
  }
  const referenceById = new Map<string, NarrativePronounReference>();
  for (const reference of references) {
    if (!reference || typeof reference.id !== "string" || !reference.id ||
        !Number.isSafeInteger(reference.start) || reference.start < 0 ||
        !Number.isSafeInteger(reference.end) || reference.end <= reference.start ||
        reference.end > text.length || typeof reference.documentId !== "string" ||
        !reference.documentId || !Number.isSafeInteger(reference.revision) ||
        reference.revision < 0) {
      throw new Error("Referencia pronominal inválida para vincular acciones.");
    }
    if (referenceById.has(reference.id)) throw new Error("Referencia pronominal duplicada.");
    referenceById.set(reference.id, reference);
  }

  const actionPattern = ACTIONS.map(escapeRegExp).sort((a,b) => b.length-a.length).join("|");
  const results: NarrativePronounActionCandidate[] = [];
  const seen = new Set<string>();
  for (const resolution of resolutions) {
    if (!resolution || typeof resolution.referenceId !== "string" ||
        !["resolved", "ambiguous", "unresolved"].includes(resolution.status) ||
        !Array.isArray(resolution.candidateCharacterIds)) {
      throw new Error("Resolución pronominal inválida.");
    }
    const reference = referenceById.get(resolution.referenceId);
    if (!reference || resolution.status === "unresolved") continue;
    if (resolution.status === "resolved" &&
        (typeof resolution.characterId !== "string" ||
         resolution.candidateCharacterIds.length !== 1 ||
         resolution.candidateCharacterIds[0] !== resolution.characterId)) {
      throw new Error("Una resolución marcada como única no contiene una identidad coherente.");
    }
    if (resolution.status === "ambiguous" &&
        (resolution.characterId !== undefined || resolution.candidateCharacterIds.length < 2)) {
      throw new Error("Una resolución ambigua no puede declarar un actor único.");
    }
    const lineStart = Math.max(text.lastIndexOf("\n", reference.start - 1) + 1,
      text.lastIndexOf("\r", reference.start - 1) + 1);
    const nextLineBreak = text.slice(reference.end).search(/[\r\n]/u);
    const lineEnd = nextLineBreak < 0 ? text.length : reference.end + nextLineBreak;
    const suffix = text.slice(reference.end, lineEnd);
    const expression = new RegExp("^\\s+(?:(?:mismo|misma)\\s+)?(no\\s+)?(" + actionPattern +
      ")(?![\\p{L}\\p{M}\\p{N}_])", "iu");
    const match = expression.exec(suffix);
    if (!match) continue;
    const action = match[2]!.toLocaleLowerCase("es");
    const start = reference.start;
    const end = reference.end + match[0].length;
    const key = reference.id + ":" + start + ":" + end;
    if (seen.has(key)) continue;
    seen.add(key);
    const actorIds = [...new Set(resolution.candidateCharacterIds)].sort();
    const isResolved = resolution.status === "resolved";
    results.push({
      id: "pronoun-action:" + reference.documentId + ":" + reference.revision +
        ":" + start + ":" + reference.id,
      referenceId: reference.id,
      ...(isResolved ? { actorEntityId: resolution.characterId } : {}),
      candidateActorEntityIds: actorIds,
      action,
      polarity: match[1] ? "negated" : "affirmed",
      status: isResolved ? "candidate" : "ambiguous",
      evidence: {
        documentId: reference.documentId,
        revision: reference.revision,
        start,
        end,
        excerpt: text.slice(lineStart, lineEnd)
      }
    });
    if (results.length >= MAX_PRONOUN_ACTION_CANDIDATES) break;
  }
  return results.sort((a,b) => a.evidence.start-b.evidence.start || a.id.localeCompare(b.id));
}
