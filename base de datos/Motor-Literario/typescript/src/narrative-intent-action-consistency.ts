import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";
import type { NarrativeActionCandidate } from "./narrative-action-extraction";
import type { NarrativeCharacterIntentCandidate } from "./narrative-character-intent-extraction";

export type NarrativeIntentActionRelation =
  | "supports-intent" | "opposes-intent" | "unrelated-action"
  | "intent-negated" | "conditional-intent" | "ambiguous-target" | "not-comparable";

export interface NarrativeIntentActionConsistency {
  readonly id: string;
  readonly projectId: string;
  readonly characterEntityId: string;
  readonly intentId: string;
  readonly actionId: string;
  readonly relation: NarrativeIntentActionRelation;
  readonly reviewStatus: "candidate";
  readonly intentEvidence: TextEvidence;
  readonly actionEvidence: TextEvidence;
  readonly matchedTargetEntityId?: string;
}
export interface NarrativeIntentActionConsistencyInput {
  readonly projectId: string;
  readonly entities: readonly NarrativeEntity[];
  readonly intents: readonly NarrativeCharacterIntentCandidate[];
  readonly priorIntents?: readonly NarrativeCharacterIntentCandidate[];
  readonly actions: readonly NarrativeActionCandidate[];
  readonly orderedDocumentIds?: readonly string[];
}
const MAX_ITEMS = 5000;
const SUPPORTS: Readonly<Record<string, readonly string[]>> = {
  proteger: ["protegió", "protege", "protegía"],
  rescatar: ["rescató", "rescata", "rescataba"],
  salvar: ["salvó", "salva", "salvaba"],
  ayudar: ["ayudó", "ayuda", "ayudaba"],
  acompañar: ["acompañó", "acompaña", "acompañaba"],
  encontrar: ["encontró", "encuentra", "encontraba"],
  buscar: ["buscó", "busca", "buscaba"],
  entregar: ["entregó", "entrega", "entregaba"]
};
const OPPOSITIONS: Readonly<Record<string, readonly string[]>> = {
  proteger: ["traicionó", "traiciona", "traicionaba", "atacó", "ataca", "atacaba"],
  rescatar: ["atacó", "ataca", "atacaba"],
  salvar: ["atacó", "ataca", "atacaba"],
  ayudar: ["traicionó", "traiciona", "traicionaba"],
  acompañar: ["abandonó", "abandona", "abandonaba"]
};
function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es");
}
function escapeRegExp(value: string): string {
  return value.split("").map(char => "|\\{}()[]^$+*?.-".includes(char) ? "\\" + char : char).join("");
}
function validate(input: NarrativeIntentActionConsistencyInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !Array.isArray(input.entities) || !Array.isArray(input.intents) ||
      !Array.isArray(input.actions) ||
      (input.priorIntents !== undefined && !Array.isArray(input.priorIntents)) ||
      (input.orderedDocumentIds !== undefined && (!Array.isArray(input.orderedDocumentIds) ||
        input.orderedDocumentIds.some(id => typeof id !== "string" || !id.trim()))) ||
      input.intents.length + (input.priorIntents?.length ?? 0) + input.actions.length > MAX_ITEMS) {
    throw new Error("Contexto inválido para comparar intenciones y acciones.");
  }
  const characters = new Set(input.entities
    .filter(entity => entity && entity.projectId === input.projectId && entity.kind === "character")
    .map(entity => entity.id));
  for (const intent of [...(input.priorIntents ?? []), ...input.intents]) {
    if (!intent || intent.projectId !== input.projectId ||
        !characters.has(intent.characterEntityId) ||
        !["goal", "motivation"].includes(intent.kind) ||
        !["affirmed", "negated", "conditional"].includes(intent.polarity) ||
        !intent.evidence || typeof intent.evidence.documentId !== "string" ||
        !Number.isSafeInteger(intent.evidence.revision) ||
        !Number.isSafeInteger(intent.evidence.start) ||
        !Number.isSafeInteger(intent.evidence.end) ||
        intent.evidence.start < 0 || intent.evidence.end < intent.evidence.start) {
      throw new Error("Intención inválida o atribuida a un personaje desconocido.");
    }
  }
  for (const action of input.actions) {
    if (!action || action.projectId !== input.projectId ||
        !characters.has(action.actorEntityId) ||
        !input.entities.some(entity => entity.projectId === input.projectId && entity.id === action.targetEntityId) ||
        !["affirmed", "negated"].includes(action.polarity) ||
        !action.evidence || !Number.isSafeInteger(action.evidence.revision) ||
        !Number.isSafeInteger(action.evidence.start) ||
        !Number.isSafeInteger(action.evidence.end) ||
        action.evidence.start < 0 || action.evidence.end < action.evidence.start) {
      throw new Error("Acción inválida o atribuida a entidades desconocidas.");
    }
  }
}
function goalVerb(text: string): string | undefined {
  const first = normalize(text).match(/^[\p{L}\p{M}]+/u)?.[0];
  return first && Object.prototype.hasOwnProperty.call(SUPPORTS, first) ? first : undefined;
}
function targetMatches(intentText: string, target: NarrativeEntity): boolean {
  const names = [target.canonicalName, ...target.aliases]
    .filter(name => typeof name === "string" && name.trim());
  return names.some(name => new RegExp(
    "(^|[^\\p{L}\\p{M}\\p{N}_])" + escapeRegExp(normalize(name)) +
    "($|[^\\p{L}\\p{M}\\p{N}_])", "iu"
  ).test(normalize(intentText)));
}
/** Compara objetivos explícitos con acciones posteriores del mismo personaje. */
export function compareNarrativeIntentsWithActions(
  input: NarrativeIntentActionConsistencyInput
): readonly NarrativeIntentActionConsistency[] {
  validate(input);
  const entities = new Map<string, NarrativeEntity>(input.entities
    .filter(entity => entity && entity.projectId === input.projectId)
    .map(entity => [entity.id, entity] as const));
  const results: NarrativeIntentActionConsistency[] = [];
  const allIntents = [...(input.priorIntents ?? []), ...input.intents];
  const seenIntentIds = new Set<string>();
  for (const intent of allIntents) {
    if (seenIntentIds.has(intent.id)) continue;
    seenIntentIds.add(intent.id);
    const verb = goalVerb(intent.text);
    const targetEntities = [...entities.values()].filter(entity =>
      entity.id !== intent.characterEntityId && targetMatches(intent.text, entity)
    );
    const sameActorActions = input.actions.filter(action => {
      if (action.actorEntityId !== intent.characterEntityId) return false;
      if (action.evidence.documentId === intent.evidence.documentId) {
        return action.evidence.revision === intent.evidence.revision &&
          action.evidence.start >= intent.evidence.end;
      }
      if (intent.evidence.status === "stale" || action.evidence.status === "stale") return false;
      const ordered = input.orderedDocumentIds;
      if (!ordered) return false;
      const intentOrder = ordered.indexOf(intent.evidence.documentId);
      const actionOrder = ordered.indexOf(action.evidence.documentId);
      return intentOrder >= 0 && actionOrder > intentOrder;
    });
    for (const action of sameActorActions) {
      const target = entities.get(action.targetEntityId);
      const targetIsNamed = !!target && targetMatches(intent.text, target);
      let relation: NarrativeIntentActionRelation;
      if (targetEntities.length === 0) relation = "not-comparable";
      else if (targetEntities.length > 1) relation = targetIsNamed ? "ambiguous-target" : "unrelated-action";
      else if (!targetIsNamed) relation = "unrelated-action";
      else if (intent.evidence.status === "stale" || action.evidence.status === "stale") relation = "not-comparable";
      else if (intent.polarity === "negated") relation = "intent-negated";
      else if (intent.polarity === "conditional") relation = "conditional-intent";
      else if (!verb) relation = "not-comparable";
      else if (action.polarity === "negated") relation = "not-comparable";
      else if (SUPPORTS[verb]?.includes(action.action)) relation = "supports-intent";
      else if (OPPOSITIONS[verb]?.includes(action.action)) relation = "opposes-intent";
      else relation = "unrelated-action";
      if (results.length >= MAX_ITEMS) return results;
      results.push({
        id: "intent-action:" + intent.id + ":" + action.id,
        projectId: input.projectId,
        characterEntityId: intent.characterEntityId,
        intentId: intent.id,
        actionId: action.id,
        relation,
        reviewStatus: "candidate",
        intentEvidence: intent.evidence,
        actionEvidence: action.evidence,
        ...(targetIsNamed && targetEntities.length === 1 ? {matchedTargetEntityId: action.targetEntityId} : {})
      });
    }
  }
  return results;
}
