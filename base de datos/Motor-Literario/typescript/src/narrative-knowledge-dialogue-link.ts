/**
 * Enlaza afirmaciones explícitas de transferencia de conocimiento con turnos
 * de diálogo y hablantes candidatos. No presume comprensión ni recepción
 * efectiva por parte del destinatario.
 */
import type { TextEvidence } from "./narrative-knowledge";
import type { NarrativeCharacterKnowledgeCandidate } from "./narrative-character-knowledge-discovery";
import type { NarrativeDialogueSegmentCandidate } from "./narrative-dialogue-speaker-discovery";

export type NarrativeKnowledgeDialogueLinkStatus =
  | "speaker-matches-source"
  | "speaker-conflicts-with-source"
  | "speaker-ambiguous"
  | "speaker-unattributed"
  | "utterance-does-not-repeat-proposition"
  | "not-a-dialogue-transfer";
export interface NarrativeKnowledgeDialogueLinkInput {
  readonly projectId: string;
  readonly knowledgeCandidates: readonly NarrativeCharacterKnowledgeCandidate[];
  readonly dialogueSegments: readonly NarrativeDialogueSegmentCandidate[];
}
export interface NarrativeKnowledgeDialogueLink {
  readonly id: string;
  readonly projectId: string;
  readonly knowledgeCandidateId: string;
  readonly dialogueSegmentId: string;
  readonly sourceEntityId?: string;
  readonly recipientEntityId: string;
  readonly speakerEntityIds: readonly string[];
  readonly status: NarrativeKnowledgeDialogueLinkStatus;
  readonly propositionEvidence?: TextEvidence;
  readonly utteranceEvidence: TextEvidence;
  readonly speakerEvidence: readonly TextEvidence[];
  readonly transferEvidence: TextEvidence;
  readonly recipientEvidence: TextEvidence;
  readonly interpretation: "candidate-only";
  readonly recipientComprehension: "not-established";
  readonly reviewStatus: "candidate";
}
export const MAX_NARRATIVE_KNOWLEDGE_DIALOGUE_CANDIDATES = 10_000;
export const MAX_NARRATIVE_KNOWLEDGE_DIALOGUE_SEGMENTS = 10_000;
export const MAX_NARRATIVE_KNOWLEDGE_DIALOGUE_LINKS = 5_000;
function validEvidence(value: TextEvidence, documentId: string, revision: number): boolean {
  return !!value && value.documentId === documentId && value.revision === revision &&
    Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) &&
    value.start >= 0 && value.end > value.start && typeof value.excerpt === "string" &&
    value.excerpt.length === value.end - value.start && value.status !== "stale";
}
function normalize(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("es")
    .replace(/[.,;:!?¿¡"'«»“”]+/gu, " ").replace(/\s+/gu, " ").trim();
}
function containsProposition(utterance: string, proposition: string): boolean {
  const u = normalize(utterance), p = normalize(proposition);
  return !!p && u.includes(p);
}
function validate(input: NarrativeKnowledgeDialogueLinkInput): void {
  if (!input || typeof input !== "object" || typeof input.projectId !== "string" ||
      !input.projectId.trim() || !Array.isArray(input.knowledgeCandidates) ||
      input.knowledgeCandidates.length > MAX_NARRATIVE_KNOWLEDGE_DIALOGUE_CANDIDATES ||
      !Array.isArray(input.dialogueSegments) ||
      input.dialogueSegments.length > MAX_NARRATIVE_KNOWLEDGE_DIALOGUE_SEGMENTS) {
    throw new Error("Entrada inválida para enlazar conocimiento y diálogo.");
  }
  const knowledgeIds = new Set<string>();
  for (const item of input.knowledgeCandidates) {
    if (!item || item.projectId !== input.projectId || typeof item.id !== "string" ||
        !item.id.trim() || knowledgeIds.has(item.id) ||
        typeof item.holderEntityId !== "string" || !item.holderEntityId.trim() ||
        !validEvidence(item.evidence, item.documentId, item.revision) ||
        !validEvidence(item.holderEvidence, item.documentId, item.revision) ||
        !validEvidence(item.triggerEvidence, item.documentId, item.revision) ||
        item.holderEvidence.start < item.evidence.start || item.holderEvidence.end > item.evidence.end ||
        item.triggerEvidence.start < item.evidence.start || item.triggerEvidence.end > item.evidence.end ||
        (item.propositionEvidence !== undefined &&
          (!validEvidence(item.propositionEvidence, item.documentId, item.revision) ||
           item.propositionEvidence.start < item.evidence.start ||
           item.propositionEvidence.end > item.evidence.end)) ||
        (item.sourceEvidence !== undefined &&
          (!validEvidence(item.sourceEvidence, item.documentId, item.revision) ||
           item.sourceEvidence.start < item.evidence.start || item.sourceEvidence.end > item.evidence.end)) ||
        (item.sourceEntityId !== undefined &&
          (typeof item.sourceEntityId !== "string" || !item.sourceEntityId.trim() || !item.sourceEvidence)) ||
        (item.sourceEvidence !== undefined && !item.sourceEntityId)) {
      throw new Error("Candidato de conocimiento inválido o con evidencia inconsistente.");
    }
    knowledgeIds.add(item.id);
  }
  const dialogueIds = new Set<string>();
  for (const item of input.dialogueSegments) {
    if (!item || item.projectId !== input.projectId || typeof item.id !== "string" ||
        !item.id.trim() || dialogueIds.has(item.id) ||
        !validEvidence(item.segmentEvidence, item.documentId, item.revision) ||
        !validEvidence(item.utteranceEvidence, item.documentId, item.revision) ||
        item.utteranceEvidence.start < item.segmentEvidence.start ||
        item.utteranceEvidence.end > item.segmentEvidence.end ||
        !Array.isArray(item.speakerCandidates) ||
        !["explicit-single", "ambiguous", "unattributed"].includes(item.speakerStatus)) {
      throw new Error("Segmento de diálogo inválido o con evidencia inconsistente.");
    }
    const speakerIds = new Set<string>();
    for (const speaker of item.speakerCandidates) {
      if (!speaker || typeof speaker.entityId !== "string" || !speaker.entityId.trim() ||
          speakerIds.has(speaker.entityId) ||
          !validEvidence(speaker.nameEvidence, item.documentId, item.revision) ||
          !validEvidence(speaker.speechVerbEvidence, item.documentId, item.revision)) {
        throw new Error("Atribución de hablante inválida.");
      }
      speakerIds.add(speaker.entityId);
    }
    if ((item.speakerStatus === "explicit-single" && speakerIds.size !== 1) ||
        (item.speakerStatus === "ambiguous" && speakerIds.size < 2) ||
        (item.speakerStatus === "unattributed" && speakerIds.size !== 0)) {
      throw new Error("El estado de atribución no coincide con los candidatos de hablante.");
    }
    dialogueIds.add(item.id);
  }
}
export function linkNarrativeKnowledgeToDialogue(
  input: NarrativeKnowledgeDialogueLinkInput
): readonly NarrativeKnowledgeDialogueLink[] {
  validate(input);
  const transfers = input.knowledgeCandidates.filter(item =>
    item.mode === "reported-transfer" && item.kind === "reported" &&
    typeof item.sourceEntityId === "string" && !!item.propositionEvidence
  );
  const links: NarrativeKnowledgeDialogueLink[] = [];
  for (const transfer of transfers) {
    for (const dialogue of input.dialogueSegments) {
      if (dialogue.documentId !== transfer.documentId || dialogue.revision !== transfer.revision ||
          dialogue.segmentEvidence.start > transfer.evidence.end ||
          dialogue.segmentEvidence.end < transfer.evidence.start) continue;
      const speakers = dialogue.speakerCandidates.map(item => item.entityId).sort();
      let status: NarrativeKnowledgeDialogueLinkStatus;
      if (dialogue.speakerStatus === "ambiguous") status = "speaker-ambiguous";
      else if (dialogue.speakerStatus === "unattributed") status = "speaker-unattributed";
      else if (speakers[0] !== transfer.sourceEntityId) status = "speaker-conflicts-with-source";
      else if (!containsProposition(dialogue.utteranceEvidence.excerpt, transfer.propositionEvidence!.excerpt)) {
        status = "utterance-does-not-repeat-proposition";
      } else status = "speaker-matches-source";
      if (links.length >= MAX_NARRATIVE_KNOWLEDGE_DIALOGUE_LINKS) {
        throw new Error("El enlace conocimiento-diálogo supera el límite; procesa el manuscrito por capítulos.");
      }
      links.push({
        id: "knowledge-dialogue-link:" + JSON.stringify([transfer.id, dialogue.id]),
        projectId: input.projectId,
        knowledgeCandidateId: transfer.id,
        dialogueSegmentId: dialogue.id,
        sourceEntityId: transfer.sourceEntityId,
        recipientEntityId: transfer.holderEntityId,
        speakerEntityIds: speakers,
        status,
        ...(transfer.propositionEvidence ? { propositionEvidence: transfer.propositionEvidence } : {}),
        utteranceEvidence: dialogue.utteranceEvidence,
        speakerEvidence: dialogue.speakerCandidates.map(item => item.nameEvidence),
        transferEvidence: transfer.evidence,
        recipientEvidence: transfer.holderEvidence,
        interpretation: "candidate-only",
        recipientComprehension: "not-established",
        reviewStatus: "candidate"
      });
    }
  }
  return links.sort((a, b) => a.transferEvidence.start - b.transferEvidence.start ||
    a.utteranceEvidence.start - b.utteranceEvidence.start || a.id.localeCompare(b.id));
}
