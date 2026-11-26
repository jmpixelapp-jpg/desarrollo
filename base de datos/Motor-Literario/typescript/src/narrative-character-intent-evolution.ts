import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";
import type { NarrativeCharacterIntentCandidate } from "./narrative-character-intent-extraction";

export type NarrativeIntentTransitionKind =
  | "maintained"
  | "withdrawn"
  | "replaced"
  | "conditional"
  | "coexisting"
  | "ambiguous-predecessor"
  | "chronology-unresolved";

export interface NarrativeCharacterIntentEvolution {
  readonly id: string;
  readonly projectId: string;
  readonly characterEntityId: string;
  readonly currentIntentId: string;
  readonly priorIntentIds: readonly string[];
  readonly transition: NarrativeIntentTransitionKind;
  readonly reviewStatus: "candidate";
  readonly currentEvidence: TextEvidence;
  readonly priorEvidence: readonly TextEvidence[];
  readonly transitionEvidence?: TextEvidence;
}

export interface NarrativeCharacterIntentEvolutionInput {
  readonly projectId: string;
  readonly entities: readonly NarrativeEntity[];
  readonly currentIntents: readonly NarrativeCharacterIntentCandidate[];
  readonly priorIntents?: readonly NarrativeCharacterIntentCandidate[];
  readonly orderedDocumentIds?: readonly string[];
}

const MAX_INTENTS = 5000;
const MAX_RESULTS = 1000;

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es")
    .replace(/[.!?;:,]+$/gu, "");
}

function validate(input: NarrativeCharacterIntentEvolutionInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !Array.isArray(input.entities) || !Array.isArray(input.currentIntents) ||
      (input.priorIntents !== undefined && !Array.isArray(input.priorIntents)) ||
      input.currentIntents.length + (input.priorIntents?.length ?? 0) > MAX_INTENTS ||
      (input.orderedDocumentIds !== undefined &&
        (!Array.isArray(input.orderedDocumentIds) ||
         input.orderedDocumentIds.some(id => typeof id !== "string" || !id.trim()) ||
         new Set(input.orderedDocumentIds).size !== input.orderedDocumentIds.length))) {
    throw new Error("Contexto inválido para reconstruir la evolución de objetivos.");
  }
  const characters = new Set(input.entities
    .filter(entity => entity && entity.projectId === input.projectId && entity.kind === "character")
    .map(entity => entity.id));
  const intentIds = new Set<string>();
  for (const intent of [...(input.priorIntents ?? []), ...input.currentIntents]) {
    if (!intent || intent.projectId !== input.projectId ||
        !characters.has(intent.characterEntityId) ||
        typeof intent.id !== "string" || !intent.id.trim() || intentIds.has(intent.id) ||
        typeof intent.text !== "string" || !intent.text.trim() ||
        !["goal", "motivation"].includes(intent.kind) ||
        !["affirmed", "negated", "conditional"].includes(intent.polarity) ||
        !intent.evidence || typeof intent.evidence.documentId !== "string" ||
        !Number.isSafeInteger(intent.evidence.revision) ||
        !Number.isSafeInteger(intent.evidence.start) ||
        !Number.isSafeInteger(intent.evidence.end) ||
        intent.evidence.start < 0 || intent.evidence.end < intent.evidence.start) {
      throw new Error("Los objetivos deben pertenecer al proyecto y a personajes conocidos, con IDs únicos.");
    }
    intentIds.add(intent.id);
  }
}

function orderOf(
  intent: NarrativeCharacterIntentCandidate,
  ordered: readonly string[] | undefined
): number | undefined {
  if (!ordered) return undefined;
  const index = ordered.indexOf(intent.evidence.documentId);
  return index < 0 ? undefined : index;
}

function transitionSignal(
  intent: NarrativeCharacterIntentCandidate
): { kind: "replacement" | "withdrawal"; evidence?: TextEvidence } | undefined {
  const excerpt = intent.evidence.excerpt;
  const patterns = [
    { kind: "replacement" as const, regex: /\b(?:en\s+lugar\s+de|en\s+vez\s+de|cambió\s+(?:de\s+)?objetivo|cambio\s+(?:de\s+)?objetivo|sustituyó\s+(?:su\s+)?objetivo|sustituyo\s+(?:su\s+)?objetivo|cambió\s+de\s+motivación|cambio\s+de\s+motivacion|cambió\s+de\s+motivo|cambio\s+de\s+motivo)\b/iu },
    { kind: "withdrawal" as const, regex: /\b(?:dejó\s+de\s+querer|dejo\s+de\s+querer|renunció\s+a|renuncio\s+a|abandonó\s+(?:su\s+)?objetivo|abandono\s+(?:su\s+)?objetivo)\b/iu }
  ];
  for (const pattern of patterns) {
    const match = pattern.regex.exec(excerpt);
    if (!match) continue;
    // El extractor conserva la oración completa en excerpt y el rango de la
    // intención dentro de ella; así se recupera el inicio absoluto de la oración.
    const intentOffset = excerpt.indexOf(intent.text);
    if (intentOffset < 0) continue;
    const start = intent.evidence.start - intentOffset;
    return {
      kind: pattern.kind,
      evidence: {
        ...intent.evidence,
        start: start + match.index,
        end: start + match.index + match[0].length,
        excerpt: match[0]
      }
    };
  }
  return undefined;
}

/**
 * Relaciona objetivos entre documentos solo con orden documental declarado.
 * Una meta diferente coexiste con la anterior salvo señal expresa de sustitución.
 */
export function evolveNarrativeCharacterIntents(
  input: NarrativeCharacterIntentEvolutionInput
): readonly NarrativeCharacterIntentEvolution[] {
  validate(input);
  const prior = input.priorIntents ?? [];
  const results: NarrativeCharacterIntentEvolution[] = [];
  for (const current of input.currentIntents) {
    const sameCharacter = prior.filter(item =>
      item.characterEntityId === current.characterEntityId &&
      item.kind === current.kind && item.id !== current.id
    );
    const orderedPrior = sameCharacter.filter(item => {
      if (item.evidence.documentId === current.evidence.documentId) {
        return item.evidence.revision === current.evidence.revision &&
          item.evidence.end <= current.evidence.start;
      }
      const before = orderOf(item, input.orderedDocumentIds);
      const now = orderOf(current, input.orderedDocumentIds);
      return before !== undefined && now !== undefined && before < now;
    });
    const signal = transitionSignal(current);
    const exact = orderedPrior.filter(item => normalize(item.text) === normalize(current.text));
    let transition: NarrativeIntentTransitionKind;
    let candidates: readonly NarrativeCharacterIntentCandidate[];
    if (current.polarity === "conditional") {
      transition = "conditional";
      candidates = orderedPrior;
    } else if (current.polarity === "negated" && exact.length === 1) {
      transition = "withdrawn";
      candidates = exact;
    } else if (signal?.kind === "withdrawal") {
      const excerpt = normalize(current.evidence.excerpt);
      const withdrawn = orderedPrior.filter(item =>
        item.polarity === "affirmed" && excerpt.includes(normalize(item.text))
      );
      transition = withdrawn.length === 1 ? "withdrawn" : withdrawn.length > 1
        ? "ambiguous-predecessor" : "coexisting";
      candidates = withdrawn;
    } else if (signal?.kind === "replacement") {
      const excerpt = normalize(current.evidence.excerpt);
      const affirmed = orderedPrior.filter(item =>
        item.polarity === "affirmed" && excerpt.includes(normalize(item.text))
      );
      transition = affirmed.length === 1 ? "replaced" : affirmed.length > 1
        ? "ambiguous-predecessor" : "coexisting";
      candidates = affirmed;
    } else if (exact.length > 1) {
      transition = "ambiguous-predecessor";
      candidates = exact;
    } else if (exact.length === 1 && current.polarity === "affirmed") {
      transition = "maintained";
      candidates = exact;
    } else if (orderedPrior.length === 0 && sameCharacter.some(item => {
      if (item.evidence.documentId === current.evidence.documentId) {
        return item.evidence.revision !== current.evidence.revision;
      }
      const before = orderOf(item, input.orderedDocumentIds);
      const now = orderOf(current, input.orderedDocumentIds);
      return before === undefined || now === undefined || before === now;
    })) {
      transition = "chronology-unresolved";
      candidates = sameCharacter;
    } else {
      transition = "coexisting";
      candidates = orderedPrior;
    }
    if (results.length >= MAX_RESULTS) break;
    results.push({
      id: "intent-evolution:" + current.id,
      projectId: input.projectId,
      characterEntityId: current.characterEntityId,
      currentIntentId: current.id,
      priorIntentIds: candidates.map(item => item.id),
      transition,
      reviewStatus: "candidate",
      currentEvidence: current.evidence,
      priorEvidence: candidates.map(item => item.evidence),
      ...(signal?.evidence ? { transitionEvidence: signal.evidence } : {})
    });
  }
  return results;
}
