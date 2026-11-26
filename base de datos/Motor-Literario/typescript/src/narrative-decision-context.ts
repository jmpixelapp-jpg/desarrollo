/**
 * Triangula conocimiento e intención que preceden a una misma acción.
 * Describe contexto documentado; no atribuye causalidad ni deliberación interna.
 */
import type { NarrativeKnowledgeActionLink } from "./narrative-knowledge-action-links";
import type { NarrativeIntentActionConsistency } from "./narrative-intent-action-consistency";

export interface NarrativeDecisionContextCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly characterEntityId: string;
  readonly actionId: string;
  readonly informationId: string;
  readonly intentId: string;
  readonly alignment: "supports-intent" | "opposes-intent" | "conditional-intent" | "other-or-undetermined";
  readonly chronology: {
    readonly knowledgeBeforeAction: NarrativeKnowledgeActionLink["chronology"];
    readonly intentBeforeAction: "same-document-position" | "explicit-document-order";
  };
  readonly knowledgeEvidence: NarrativeKnowledgeActionLink["knowledgeEvidence"];
  readonly intentEvidence: NarrativeIntentActionConsistency["intentEvidence"];
  readonly actionEvidence: NarrativeKnowledgeActionLink["actionEvidence"];
  readonly reviewStatus: "candidate";
}

export interface NarrativeDecisionContextInput {
  readonly projectId: string;
  readonly knowledgeActionLinks: readonly NarrativeKnowledgeActionLink[];
  readonly intentActionConsistency: readonly NarrativeIntentActionConsistency[];
}

const MAX_RESULTS = 10_000;

function validate(input: NarrativeDecisionContextInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !Array.isArray(input.knowledgeActionLinks) ||
      !Array.isArray(input.intentActionConsistency) ||
      input.knowledgeActionLinks.length + input.intentActionConsistency.length > MAX_RESULTS) {
    throw new Error("Contexto inválido para triangular conocimiento, intención y acción.");
  }
  const knowledgeIds = new Set<string>();
  for (const link of input.knowledgeActionLinks) {
    if (!link || link.projectId !== input.projectId ||
        typeof link.id !== "string" || !link.id.trim() || knowledgeIds.has(link.id) ||
        typeof link.characterEntityId !== "string" || !link.characterEntityId.trim() ||
        typeof link.informationId !== "string" || !link.informationId.trim() ||
        typeof link.actionId !== "string" || !link.actionId.trim() ||
        link.relation !== "knowledge-precedes-action" ||
        !["same-document-position", "explicit-document-order"].includes(link.chronology) ||
        !link.knowledgeEvidence || !link.actionEvidence) {
      throw new Error("Enlace de conocimiento-acción inválido o duplicado.");
    }
    knowledgeIds.add(link.id);
  }
  const consistencyIds = new Set<string>();
  for (const item of input.intentActionConsistency) {
    if (!item || item.projectId !== input.projectId ||
        typeof item.id !== "string" || !item.id.trim() || consistencyIds.has(item.id) ||
        typeof item.characterEntityId !== "string" || !item.characterEntityId.trim() ||
        typeof item.intentId !== "string" || !item.intentId.trim() ||
        typeof item.actionId !== "string" || !item.actionId.trim() ||
        !["supports-intent", "opposes-intent", "unrelated-action", "intent-negated",
          "conditional-intent", "ambiguous-target", "not-comparable"].includes(item.relation) ||
        !item.intentEvidence || !item.actionEvidence) {
      throw new Error("Comparación intención-acción inválida o duplicada.");
    }
    consistencyIds.add(item.id);
  }
}

function sameEvidence(
  left: {documentId:string; revision:number; start:number; end:number; excerpt:string},
  right: {documentId:string; revision:number; start:number; end:number; excerpt:string}
): boolean {
  return left.documentId === right.documentId && left.revision === right.revision &&
    left.start === right.start && left.end === right.end && left.excerpt === right.excerpt;
}

/** Combina únicamente enlaces que apuntan al mismo personaje y a la misma acción. */
export function buildNarrativeDecisionContexts(
  input: NarrativeDecisionContextInput
): readonly NarrativeDecisionContextCandidate[] {
  validate(input);
  const consistencyByAction = new Map<string, NarrativeIntentActionConsistency[]>();
  for (const item of input.intentActionConsistency) {
    const key = item.characterEntityId + "\u0000" + item.actionId;
    const values = consistencyByAction.get(key) ?? [];
    values.push(item);
    consistencyByAction.set(key, values);
  }
  const output: NarrativeDecisionContextCandidate[] = [];
  for (const knowledge of input.knowledgeActionLinks) {
    const key = knowledge.characterEntityId + "\u0000" + knowledge.actionId;
    for (const intent of consistencyByAction.get(key) ?? []) {
      if (!sameEvidence(knowledge.actionEvidence, intent.actionEvidence)) {
        throw new Error("Las referencias a una misma acción deben conservar evidencia idéntica.");
      }
      const alignment = intent.relation === "supports-intent" ||
        intent.relation === "opposes-intent" || intent.relation === "conditional-intent"
        ? intent.relation : "other-or-undetermined";
      output.push({
        id: "decision-context:" + knowledge.informationId + ":" + intent.intentId + ":" + knowledge.actionId,
        projectId: input.projectId,
        characterEntityId: knowledge.characterEntityId,
        actionId: knowledge.actionId,
        informationId: knowledge.informationId,
        intentId: intent.intentId,
        alignment,
        chronology: {
          knowledgeBeforeAction: knowledge.chronology,
          intentBeforeAction: intent.intentEvidence.documentId === intent.actionEvidence.documentId
            ? "same-document-position" : "explicit-document-order"
        },
        knowledgeEvidence: knowledge.knowledgeEvidence,
        intentEvidence: intent.intentEvidence,
        actionEvidence: knowledge.actionEvidence,
        reviewStatus: "candidate"
      });
      if (output.length >= MAX_RESULTS) return output;
    }
  }
  return output.sort((a, b) =>
    a.actionEvidence.start - b.actionEvidence.start || a.id.localeCompare(b.id)
  );
}
