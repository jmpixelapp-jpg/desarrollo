/**
 * Reconstruye cadenas explícitas de transmisión de información.
 *
 * Una transmisión posterior se enlaza con una adquisición anterior solo si:
 * - el receptor anterior es el emisor explícito de la transmisión nueva;
 * - el contenido coincide exactamente tras normalización conservadora.
 * Nunca deduce paráfrasis, fuentes implícitas ni veracidad.
 */
import type {
  NarrativeInformationProvenance
} from "./narrative-information-provenance";
import type { TextEvidence } from "./narrative-knowledge";

export type NarrativeInformationChainLinkStatus =
  | "linked"
  | "no-predecessor"
  | "ambiguous-predecessor";

export interface NarrativeInformationChainStep {
  readonly id: string;
  readonly projectId: string;
  readonly sourceEntityId?: string;
  readonly recipientEntityId?: string;
  readonly channel: NarrativeInformationProvenance["channel"];
  readonly content: string;
  readonly predecessorRecordId?: string;
  readonly linkStatus: NarrativeInformationChainLinkStatus;
  readonly reviewStatus: "candidate";
  readonly evidence: TextEvidence;
  readonly predecessorEvidence?: TextEvidence;
}

export interface NarrativeInformationChainInput {
  readonly projectId: string;
  readonly currentRecords: readonly NarrativeInformationProvenance[];
  readonly priorRecords?: readonly NarrativeInformationProvenance[];
}

export const MAX_NARRATIVE_INFORMATION_CHAIN_RECORDS = 5_000;

function normalizeContent(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ")
    .toLocaleLowerCase("es").replace(/[.!?;:,]+$/gu, "");
}

function validateRecord(record: NarrativeInformationProvenance, projectId: string): void {
  if (!record || record.projectId !== projectId ||
      typeof record.id !== "string" || !record.id.trim() ||
      typeof record.content !== "string" || !record.content.trim() ||
      !record.evidence || typeof record.evidence.documentId !== "string" ||
      !Number.isSafeInteger(record.evidence.revision) ||
      !Number.isSafeInteger(record.evidence.start) ||
      !Number.isSafeInteger(record.evidence.end) ||
      record.evidence.start < 0 || record.evidence.end < record.evidence.start ||
      (record.informationHolderEntityId !== undefined &&
        (typeof record.informationHolderEntityId !== "string" || !record.informationHolderEntityId.trim())) ||
      (record.sourceEntityId !== undefined &&
        (typeof record.sourceEntityId !== "string" || !record.sourceEntityId.trim()))) {
    throw new Error("Registro de procedencia inválido para reconstruir la cadena de información.");
  }
}

/**
 * Devuelve un paso por cada registro actual. Un registro previo enlaza con el
 * actual si su titular coincide con el emisor actual y la proposición coincide.
 */
export function reconstructNarrativeInformationChain(
  input: NarrativeInformationChainInput
): readonly NarrativeInformationChainStep[] {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !Array.isArray(input.currentRecords) ||
      (input.priorRecords !== undefined && !Array.isArray(input.priorRecords)) ||
      input.currentRecords.length + (input.priorRecords?.length ?? 0) >
        MAX_NARRATIVE_INFORMATION_CHAIN_RECORDS) {
    throw new Error("Contexto inválido para reconstruir la cadena de información.");
  }

  const prior = input.priorRecords ?? [];
  const current = input.currentRecords;
  for (const record of [...prior, ...current]) validateRecord(record, input.projectId);

  const priorIds = new Set<string>();
  for (const record of prior) {
    if (priorIds.has(record.id)) {
      throw new Error("Los registros previos de procedencia no pueden repetir identificadores.");
    }
    priorIds.add(record.id);
  }

  return current.map(record => {
    if (!record.sourceEntityId) {
      return {
        id: `information-chain:${record.id}`,
        projectId: input.projectId,
        ...(record.informationHolderEntityId
          ? { recipientEntityId: record.informationHolderEntityId } : {}),
        channel: record.channel,
        content: record.content,
        linkStatus: "no-predecessor" as const,
        reviewStatus: "candidate" as const,
        evidence: record.evidence
      };
    }

    const key = normalizeContent(record.content);
    const candidates = prior.filter(previous =>
      previous.informationHolderEntityId === record.sourceEntityId &&
      normalizeContent(previous.content) === key &&
      previous.id !== record.id
    );
    const unique = [...new Map(candidates.map(candidate => [candidate.id, candidate])).values()];
    const linked = unique.length === 1 ? unique[0] : undefined;

    return {
      id: `information-chain:${record.id}`,
      projectId: input.projectId,
      sourceEntityId: record.sourceEntityId,
      ...(record.informationHolderEntityId
        ? { recipientEntityId: record.informationHolderEntityId } : {}),
      channel: record.channel,
      content: record.content,
      ...(linked ? { predecessorRecordId: linked.id, predecessorEvidence: linked.evidence } : {}),
      linkStatus: unique.length === 1
        ? "linked" as const
        : unique.length > 1
          ? "ambiguous-predecessor" as const
          : "no-predecessor" as const,
      reviewStatus: "candidate" as const,
      evidence: record.evidence
    };
  });
}
