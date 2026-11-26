/**
 * Compara afirmaciones explícitas de desconocimiento con afirmaciones
 * cognitivas del mismo personaje y proposición. No resuelve contradicciones
 * semánticas ni convierte una señal en estado mental objetivo.
 */
import type { TextEvidence } from "./narrative-knowledge";
import type { NarrativeCharacterKnowledgeCandidate } from "./narrative-character-knowledge-discovery";
import type { NarrativeInformationExposureCandidate } from "./narrative-information-exposure-discovery";

export type NarrativeInformationAsymmetryRelation =
  | "knowledge-claim-before-unawareness-exposure"
  | "knowledge-claim-after-unawareness-exposure"
  | "same-position-unresolved";
export interface NarrativeInformationAsymmetryCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly characterEntityId: string;
  readonly relation: NarrativeInformationAsymmetryRelation;
  readonly exposureCandidateId: string;
  readonly knowledgeCandidateId: string;
  readonly propositionKey: string;
  readonly exposureEvidence: TextEvidence;
  readonly knowledgeEvidence: TextEvidence;
  readonly exposurePropositionEvidence: TextEvidence;
  readonly knowledgePropositionEvidence: TextEvidence;
  readonly knowledgeKind: NarrativeCharacterKnowledgeCandidate["kind"];
  readonly knowledgeMode: NarrativeCharacterKnowledgeCandidate["mode"];
  readonly knowledgePolarity: NarrativeCharacterKnowledgeCandidate["polarity"];
  readonly interpretation: "candidate-tension-only";
  readonly contradictionEstablished: false;
  readonly chronologyResolved: false;
  readonly reviewStatus: "candidate";
}
export interface NarrativeInformationAsymmetryInput {
  readonly projectId: string;
  readonly exposures: readonly NarrativeInformationExposureCandidate[];
  readonly knowledgeCandidates: readonly NarrativeCharacterKnowledgeCandidate[];
  /** Solo permite comparar pasajes de documentos distintos si el orden es explícito y único. */
  readonly documentOrder?: readonly { readonly documentId: string; readonly order: number }[];
}
export const MAX_NARRATIVE_INFORMATION_ASYMMETRY_EXPOSURES = 5_000;
export const MAX_NARRATIVE_INFORMATION_ASYMMETRY_KNOWLEDGE = 10_000;
export const MAX_NARRATIVE_INFORMATION_ASYMMETRY_PAIRS = 50_000;
export const MAX_NARRATIVE_INFORMATION_ASYMMETRY_RESULTS = 5_000;
function normalize(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("es")
    .replace(/[.,;:!?¿¡"'«»“”]+/gu, " ").replace(/\s+/gu, " ").trim();
}
function validEvidence(value: TextEvidence, documentId: string, revision: number): boolean {
  return !!value && value.documentId === documentId && value.revision === revision &&
    Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) &&
    value.start >= 0 && value.end > value.start && typeof value.excerpt === "string" &&
    value.excerpt.length === value.end - value.start && value.status !== "stale";
}
function validate(input: NarrativeInformationAsymmetryInput): void {
  if (!input || typeof input !== "object" || typeof input.projectId !== "string" ||
      !input.projectId.trim() || !Array.isArray(input.exposures) ||
      input.exposures.length > MAX_NARRATIVE_INFORMATION_ASYMMETRY_EXPOSURES ||
      !Array.isArray(input.knowledgeCandidates) ||
      input.knowledgeCandidates.length > MAX_NARRATIVE_INFORMATION_ASYMMETRY_KNOWLEDGE ||
      (input.documentOrder !== undefined && !Array.isArray(input.documentOrder))) {
    throw new Error("Entrada inválida para comparar asimetrías de información.");
  }
  const orders = new Set<string>(), values = new Set<number>();
  for (const item of input.documentOrder ?? []) {
    if (!item || typeof item.documentId !== "string" || !item.documentId.trim() ||
        !Number.isSafeInteger(item.order) || item.order < 0 ||
        orders.has(item.documentId) || values.has(item.order)) {
      throw new Error("El orden documental contiene valores inválidos o duplicados.");
    }
    orders.add(item.documentId); values.add(item.order);
  }
  const exposureIds = new Set<string>();
  for (const item of input.exposures) {
    if (!item || item.projectId !== input.projectId || !item.id || exposureIds.has(item.id) ||
        !["secret-is-that","truth-is-that","character-unaware-that"].includes(item.signal) ||
        !validEvidence(item.evidence,item.documentId,item.revision) ||
        !validEvidence(item.triggerEvidence,item.documentId,item.revision) ||
        !validEvidence(item.propositionEvidence,item.documentId,item.revision) ||
        item.triggerEvidence.start < item.evidence.start || item.triggerEvidence.end > item.evidence.end ||
        item.propositionEvidence.start < item.evidence.start || item.propositionEvidence.end > item.evidence.end ||
        item.readerKnowledge !== "not-established" || item.focalization !== "unresolved" ||
        (item.signal === "character-unaware-that" &&
          (typeof item.subjectEntityId !== "string" || !item.subjectEntityId.trim() ||
           !item.subjectEvidence || !validEvidence(item.subjectEvidence,item.documentId,item.revision) ||
           item.subjectEvidence.start < item.evidence.start || item.subjectEvidence.end > item.evidence.end))) {
      throw new Error("Candidato de exposición inválido o con evidencia inconsistente.");
    }
    exposureIds.add(item.id);
  }
  const knowledgeIds = new Set<string>();
  for (const item of input.knowledgeCandidates) {
    if (!item || item.projectId !== input.projectId || !item.id || knowledgeIds.has(item.id) ||
        typeof item.holderEntityId !== "string" || !item.holderEntityId.trim() ||
        !validEvidence(item.evidence,item.documentId,item.revision) ||
        !validEvidence(item.holderEvidence,item.documentId,item.revision) ||
        !validEvidence(item.triggerEvidence,item.documentId,item.revision) ||
        item.holderEvidence.start < item.evidence.start || item.holderEvidence.end > item.evidence.end ||
        item.triggerEvidence.start < item.evidence.start || item.triggerEvidence.end > item.evidence.end ||
        (item.propositionEvidence !== undefined &&
          (!validEvidence(item.propositionEvidence,item.documentId,item.revision) ||
           item.propositionEvidence.start < item.evidence.start ||
           item.propositionEvidence.end > item.evidence.end))) {
      throw new Error("Candidato de conocimiento inválido o con evidencia inconsistente.");
    }
    knowledgeIds.add(item.id);
  }
}
function compareOrder(
  exposure: NarrativeInformationExposureCandidate,
  knowledge: NarrativeCharacterKnowledgeCandidate,
  orders: ReadonlyMap<string,number>
): NarrativeInformationAsymmetryRelation | undefined {
  if (exposure.documentId === knowledge.documentId && exposure.revision === knowledge.revision) {
    if (knowledge.evidence.end <= exposure.evidence.start) return "knowledge-claim-before-unawareness-exposure";
    if (exposure.evidence.end <= knowledge.evidence.start) return "knowledge-claim-after-unawareness-exposure";
    return "same-position-unresolved";
  }
  const a = orders.get(exposure.documentId), b = orders.get(knowledge.documentId);
  if (a === undefined || b === undefined) return undefined;
  if (a === b) return undefined;
  return b < a ? "knowledge-claim-before-unawareness-exposure" :
    "knowledge-claim-after-unawareness-exposure";
}
/** Comparación literal y conservadora; no busca sinónimos ni paráfrasis. */
export function compareNarrativeInformationAsymmetry(
  input: NarrativeInformationAsymmetryInput
): readonly NarrativeInformationAsymmetryCandidate[] {
  validate(input);
  const orders = new Map((input.documentOrder ?? []).map(item=>[item.documentId,item.order]));
  const output: NarrativeInformationAsymmetryCandidate[] = [];
  let examined = 0;
  for (const exposure of input.exposures) {
    if (exposure.signal !== "character-unaware-that" || !exposure.subjectEntityId) continue;
    const propositionKey = normalize(exposure.propositionEvidence.excerpt);
    if (!propositionKey) continue;
    for (const knowledge of input.knowledgeCandidates) {
      if (knowledge.holderEntityId !== exposure.subjectEntityId || !knowledge.propositionEvidence) continue;
      if (normalize(knowledge.propositionEvidence.excerpt) !== propositionKey) continue;
      examined++;
      if (examined > MAX_NARRATIVE_INFORMATION_ASYMMETRY_PAIRS) {
        throw new Error("La comparación supera el presupuesto de pares; procesa el manuscrito por capítulos.");
      }
      const relation = compareOrder(exposure,knowledge,orders);
      if (!relation) continue;
      if (output.length >= MAX_NARRATIVE_INFORMATION_ASYMMETRY_RESULTS) {
        throw new Error("La comparación supera el límite de resultados; procesa el manuscrito por capítulos.");
      }
      output.push({
        id:"information-asymmetry:"+JSON.stringify([exposure.id,knowledge.id]),
        projectId:input.projectId,characterEntityId:exposure.subjectEntityId,relation,
        exposureCandidateId:exposure.id,knowledgeCandidateId:knowledge.id,propositionKey,
        exposureEvidence:exposure.evidence,knowledgeEvidence:knowledge.evidence,
        exposurePropositionEvidence:exposure.propositionEvidence,
        knowledgePropositionEvidence:knowledge.propositionEvidence,
        knowledgeKind:knowledge.kind,knowledgeMode:knowledge.mode,
        knowledgePolarity:knowledge.polarity,interpretation:"candidate-tension-only",
        contradictionEstablished:false,chronologyResolved:false,reviewStatus:"candidate"
      });
    }
  }
  return output.sort((a,b)=>a.exposureEvidence.documentId.localeCompare(b.exposureEvidence.documentId)||
    a.exposureEvidence.start-b.exposureEvidence.start||
    a.knowledgeEvidence.start-b.knowledgeEvidence.start||a.id.localeCompare(b.id));
}
