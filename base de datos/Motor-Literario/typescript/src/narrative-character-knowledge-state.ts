/**
 * Construye una vista conservadora del conocimiento atribuido a cada personaje.
 *
 * Solo incorpora información con titular explícito. Distingue la información
 * recibida de las interpretaciones y evaluaciones declaradas; no infiere
 * ignorancia, aceptación, verdad ni cronología entre documentos sin orden dado.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";
import type { NarrativeInformationProvenance } from "./narrative-information-provenance";
import type { NarrativeInformationInterpretation } from "./narrative-information-interpretation";
import type { NarrativeKnowledgeEvolution } from "./narrative-knowledge-evolution";

export interface NarrativeCharacterKnowledgeItem {
  readonly informationId: string;
  readonly content: string;
  readonly channel: NarrativeInformationProvenance["channel"];
  readonly status: NarrativeInformationProvenance["status"];
  readonly sourceEntityId?: string;
  readonly evidence: TextEvidence;
  readonly interpretations: readonly NarrativeInformationInterpretation[];
  readonly evaluations: readonly NarrativeKnowledgeEvolution[];
  /** Evaluación más reciente solo cuando la secuencia puede establecerse. */
  readonly currentAssessment: "unassessed" | "confirmed-by-character" | "refuted-by-character" | "uncertain" | "concealed" | "chronology-unresolved";
  readonly chronology: "explicit-document-order" | "same-document-position" | "cross-document-order-unknown";
}
export interface NarrativeCharacterKnowledgeState {
  readonly projectId: string;
  readonly characterEntityId: string;
  readonly items: readonly NarrativeCharacterKnowledgeItem[];
  readonly summary: {
    readonly recordedInformationCount: number;
    readonly interpretedInformationCount: number;
    readonly explicitMisinterpretationCount: number;
    readonly evaluationCount: number;
  };
  readonly reviewStatus: "candidate";
}
export interface NarrativeCharacterKnowledgeStateInput {
  readonly projectId: string;
  readonly entities: readonly NarrativeEntity[];
  readonly information: readonly NarrativeInformationProvenance[];
  readonly interpretations?: readonly NarrativeInformationInterpretation[];
  readonly evaluations?: readonly NarrativeKnowledgeEvolution[];
  /** Orden cronológico explícito de documentos. Solo se usa si el usuario/proyecto lo proporciona. */
  readonly orderedDocumentIds?: readonly string[];
}
export const MAX_CHARACTER_KNOWLEDGE_STATE_RECORDS = 10_000;

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ")
    .toLocaleLowerCase("es").replace(/[.!?;:,]+$/gu, "");
}
function validateEvidence(value: TextEvidence): boolean {
  return !!value && typeof value.documentId === "string" &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    Number.isSafeInteger(value.start) && value.start >= 0 &&
    Number.isSafeInteger(value.end) && value.end >= value.start;
}
export function buildNarrativeCharacterKnowledgeStates(
  input: NarrativeCharacterKnowledgeStateInput
): readonly NarrativeCharacterKnowledgeState[] {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !Array.isArray(input.entities) || !Array.isArray(input.information) ||
      (input.interpretations !== undefined && !Array.isArray(input.interpretations)) ||
      (input.evaluations !== undefined && !Array.isArray(input.evaluations)) ||
      (input.orderedDocumentIds !== undefined &&
        (!Array.isArray(input.orderedDocumentIds) ||
          input.orderedDocumentIds.some(id => typeof id !== "string" || !id.trim()) ||
          new Set(input.orderedDocumentIds).size !== input.orderedDocumentIds.length)) ||
      input.information.length + (input.interpretations?.length ?? 0) +
        (input.evaluations?.length ?? 0) > MAX_CHARACTER_KNOWLEDGE_STATE_RECORDS) {
    throw new Error("Contexto inválido para construir estados de conocimiento de personajes.");
  }
  const characters = input.entities.filter(entity =>
    entity && entity.projectId === input.projectId && entity.kind === "character" &&
    typeof entity.id === "string" && entity.id.trim()
  );
  if (input.entities.some(entity => !entity || entity.projectId !== input.projectId ||
      typeof entity.id !== "string" || !entity.id.trim())) {
    throw new Error("Todas las entidades deben pertenecer al proyecto y tener identificadores válidos.");
  }
  const characterIds = new Set(characters.map(character => character.id));
  for (const record of input.information) {
    if (!record || record.projectId !== input.projectId ||
        (record.informationHolderEntityId !== undefined && !characterIds.has(record.informationHolderEntityId)) ||
        typeof record.content !== "string" || !record.content.trim() ||
        !validateEvidence(record.evidence)) {
      throw new Error("La información debe tener titular, contenido y evidencia válidos del proyecto.");
    }
  }
  for (const item of input.interpretations ?? []) {
    if (!item || item.projectId !== input.projectId ||
        !characterIds.has(item.interpreterEntityId) ||
        typeof item.interpretedContent !== "string" || !item.interpretedContent.trim() ||
        !validateEvidence(item.evidence)) {
      throw new Error("Las interpretaciones deben pertenecer a personajes del proyecto y conservar evidencia.");
    }
  }
  for (const item of input.evaluations ?? []) {
    if (!item || item.projectId !== input.projectId ||
        !characterIds.has(item.evaluatorEntityId) ||
        typeof item.content !== "string" || !item.content.trim() ||
        !validateEvidence(item.evidence)) {
      throw new Error("Las evaluaciones deben pertenecer a personajes del proyecto y conservar evidencia.");
    }
  }

  const order = new Map((input.orderedDocumentIds ?? []).map((id, index) => [id, index]));
  return characters.map(character => {
    const information = input.information.filter(item =>
      item.informationHolderEntityId === character.id
    );
    const items = information.map(record => {
      const interpretations = (input.interpretations ?? []).filter(item =>
        item.interpreterEntityId === character.id &&
        (item.priorInformationId === record.id ||
          (!item.priorInformationId && normalize(item.interpretedContent) === normalize(record.content)))
      );
      const evaluations = (input.evaluations ?? []).filter(item =>
        item.evaluatorEntityId === character.id &&
        normalize(item.content) === normalize(record.content)
      );
      const assessmentEvents = [
        { evidence: record.evidence, evaluation: undefined as NarrativeKnowledgeEvolution["evaluation"] | undefined },
        ...evaluations.map(item => ({ evidence: item.evidence, evaluation: item.evaluation }))
      ];
      const eventDocuments = new Set(assessmentEvents.map(event => event.evidence.documentId));
      const eventVersions = new Set(assessmentEvents.map(event =>
        `${event.evidence.documentId}\\u0000${event.evidence.revision}`));
      const revisionsByDocument = new Map<string, Set<number>>();
      for (const event of assessmentEvents) {
        const revisions = revisionsByDocument.get(event.evidence.documentId) ?? new Set<number>();
        revisions.add(event.evidence.revision);
        revisionsByDocument.set(event.evidence.documentId, revisions);
      }
      const comparable = eventVersions.size === 1 ||
        [...eventDocuments].every(documentId => order.has(documentId)) &&
          [...revisionsByDocument.values()].every(revisions => revisions.size === 1);
      const orderedEvaluations = comparable ? [...evaluations].sort((a, b) => {
        const aOrder = order.get(a.evidence.documentId) ?? 0;
        const bOrder = order.get(b.evidence.documentId) ?? 0;
        return aOrder - bOrder || a.evidence.start - b.evidence.start;
      }) : [];
      return {
        informationId: record.id,
        content: record.content,
        channel: record.channel,
        status: record.status,
        ...(record.sourceEntityId ? { sourceEntityId: record.sourceEntityId } : {}),
        evidence: record.evidence,
        interpretations,
        evaluations,
        currentAssessment: !evaluations.length ? "unassessed" as const :
          !comparable ? "chronology-unresolved" as const :
          ({ confirmed: "confirmed-by-character", refuted: "refuted-by-character",
            uncertain: "uncertain", concealed: "concealed" } as const)[orderedEvaluations[orderedEvaluations.length - 1]!.evaluation],
        chronology: order.has(record.evidence.documentId)
          ? "explicit-document-order" as const
          : (input.information.some(other => other.informationHolderEntityId === character.id &&
              other.evidence.documentId === record.evidence.documentId) 
              ? "same-document-position" as const
              : "cross-document-order-unknown" as const)
      };
    }).sort((a, b) => {
      const aOrder = order.get(a.evidence.documentId);
      const bOrder = order.get(b.evidence.documentId);
      if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) return aOrder - bOrder;
      if (a.evidence.documentId === b.evidence.documentId &&
          a.evidence.revision === b.evidence.revision) return a.evidence.start - b.evidence.start;
      return a.informationId.localeCompare(b.informationId);
    });
    const interpretedIds = new Set(items.flatMap(item => item.interpretations.map(value => value.id)));
    const evaluationIds = new Set(items.flatMap(item => item.evaluations.map(value => value.id)));
    return {
      projectId: input.projectId,
      characterEntityId: character.id,
      items,
      summary: {
        recordedInformationCount: items.length,
        interpretedInformationCount: interpretedIds.size,
        explicitMisinterpretationCount: items.reduce((count, item) =>
          count + item.interpretations.filter(value => value.signal === "explicit-misinterpretation").length, 0),
        evaluationCount: evaluationIds.size
      },
      reviewStatus: "candidate" as const
    };
  });
}
