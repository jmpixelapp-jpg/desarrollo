/**
 * Enlaza información atribuida explícitamente a un personaje con sus acciones
 * posteriores. La precedencia temporal no se interpreta como causalidad.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";
import type { NarrativeActionCandidate } from "./narrative-action-extraction";
import type { NarrativeCharacterKnowledgeState } from "./narrative-character-knowledge-state";

export interface NarrativeKnowledgeActionLink {
  readonly id: string;
  readonly projectId: string;
  readonly characterEntityId: string;
  readonly informationId: string;
  readonly actionId: string;
  readonly relation: "knowledge-precedes-action";
  readonly chronology: "same-document-position" | "explicit-document-order";
  readonly knowledgeAssessment: NarrativeCharacterKnowledgeState["items"][number]["currentAssessment"];
  readonly knowledgeChannel: NarrativeCharacterKnowledgeState["items"][number]["channel"];
  readonly knowledgeStatus: NarrativeCharacterKnowledgeState["items"][number]["status"];
  readonly knowledgeEvidence: TextEvidence;
  readonly actionEvidence: TextEvidence;
  readonly reviewStatus: "candidate";
}

export interface NarrativeKnowledgeActionLinksInput {
  readonly projectId: string;
  readonly entities: readonly NarrativeEntity[];
  readonly knowledgeStates: readonly NarrativeCharacterKnowledgeState[];
  readonly actions: readonly NarrativeActionCandidate[];
  readonly orderedDocumentIds?: readonly string[];
}

const MAX_RECORDS = 10_000;

function validEvidence(value: TextEvidence): boolean {
  return !!value && typeof value.documentId === "string" && !!value.documentId.trim() &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    Number.isSafeInteger(value.start) && value.start >= 0 &&
    Number.isSafeInteger(value.end) && value.end >= value.start;
}

function validate(input: NarrativeKnowledgeActionLinksInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !Array.isArray(input.entities) || !Array.isArray(input.knowledgeStates) ||
      !Array.isArray(input.actions) ||
      (input.orderedDocumentIds !== undefined &&
        (!Array.isArray(input.orderedDocumentIds) ||
          input.orderedDocumentIds.some(id => typeof id !== "string" || !id.trim()) ||
          new Set(input.orderedDocumentIds).size !== input.orderedDocumentIds.length)) ||
      input.knowledgeStates.length + input.actions.length > MAX_RECORDS) {
    throw new Error("Contexto inválido para enlazar conocimiento y acciones narrativas.");
  }
  const characters = new Set(input.entities
    .filter(entity => entity && entity.projectId === input.projectId && entity.kind === "character")
    .map(entity => entity.id));
  if (input.entities.some(entity => !entity || entity.projectId !== input.projectId ||
      typeof entity.id !== "string" || !entity.id.trim())) {
    throw new Error("Las entidades deben pertenecer al proyecto y tener identificadores válidos.");
  }
  for (const state of input.knowledgeStates) {
    if (!state || state.projectId !== input.projectId ||
        !characters.has(state.characterEntityId) || !Array.isArray(state.items)) {
      throw new Error("Los estados de conocimiento deben pertenecer a personajes del proyecto.");
    }
    const ids = new Set<string>();
    for (const item of state.items) {
      if (!item || typeof item.informationId !== "string" || !item.informationId.trim() ||
          ids.has(item.informationId) || typeof item.content !== "string" ||
          !item.content.trim() || !validEvidence(item.evidence)) {
        throw new Error("Cada elemento de conocimiento debe tener ID único, contenido y evidencia válidos.");
      }
      ids.add(item.informationId);
    }
  }
  const actionIds = new Set<string>();
  for (const action of input.actions) {
    if (!action || action.projectId !== input.projectId ||
        !characters.has(action.actorEntityId) ||
        typeof action.id !== "string" || !action.id.trim() || actionIds.has(action.id) ||
        !validEvidence(action.evidence)) {
      throw new Error("Las acciones deben tener ID único, actor conocido y evidencia válida.");
    }
    actionIds.add(action.id);
  }
}

/**
 * Genera enlaces de precedencia verificable. No exige que la información sea
 * verdadera, comprendida o decisiva para la acción; esos juicios no se infieren.
 */
export function linkNarrativeKnowledgeToActions(
  input: NarrativeKnowledgeActionLinksInput
): readonly NarrativeKnowledgeActionLink[] {
  validate(input);
  const order = new Map((input.orderedDocumentIds ?? []).map((id, index) => [id, index]));
  const links: NarrativeKnowledgeActionLink[] = [];
  for (const state of input.knowledgeStates) {
    for (const item of state.items) {
      if (item.evidence.status === "stale") continue;
      for (const action of input.actions) {
        if (action.actorEntityId !== state.characterEntityId ||
            action.polarity !== "affirmed" || action.evidence.status === "stale") continue;
        let chronology: NarrativeKnowledgeActionLink["chronology"] | undefined;
        if (item.evidence.documentId === action.evidence.documentId &&
            item.evidence.revision === action.evidence.revision &&
            item.evidence.end <= action.evidence.start) {
          chronology = "same-document-position";
        } else if (item.evidence.documentId !== action.evidence.documentId) {
          const knowledgeOrder = order.get(item.evidence.documentId);
          const actionOrder = order.get(action.evidence.documentId);
          if (knowledgeOrder !== undefined && actionOrder !== undefined &&
              actionOrder > knowledgeOrder) chronology = "explicit-document-order";
        }
        if (!chronology) continue;
        links.push({
          id: "knowledge-action:" + item.informationId + ":" + action.id,
          projectId: input.projectId,
          characterEntityId: state.characterEntityId,
          informationId: item.informationId,
          actionId: action.id,
          relation: "knowledge-precedes-action",
          chronology,
          knowledgeAssessment: item.currentAssessment,
          knowledgeChannel: item.channel,
          knowledgeStatus: item.status,
          knowledgeEvidence: item.evidence,
          actionEvidence: action.evidence,
          reviewStatus: "candidate"
        });
        if (links.length >= MAX_RECORDS) return links;
      }
    }
  }
  return links.sort((a, b) =>
    a.knowledgeEvidence.start - b.knowledgeEvidence.start ||
    a.actionEvidence.start - b.actionEvidence.start || a.id.localeCompare(b.id)
  );
}
