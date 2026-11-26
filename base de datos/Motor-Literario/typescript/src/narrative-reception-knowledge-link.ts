/**
 * Cruza recepción explícita de información con afirmaciones de conocimiento.
 * El enlace conserva ambas evidencias: no equipara exposición con comprensión,
 * ni comprensión con conocimiento cierto.
 */
import type { TextEvidence } from "./narrative-knowledge";
import type { NarrativeCharacterKnowledgeCandidate } from "./narrative-character-knowledge-discovery";
import type { NarrativeInformationReceptionCandidate } from "./narrative-information-reception-discovery";

export interface NarrativeReceptionKnowledgeOrder {
  readonly documentId: string;
  readonly order: number;
}
export type NarrativeReceptionKnowledgePosition =
  | "overlapping-evidence"
  | "reception-before-knowledge"
  | "knowledge-before-reception"
  | "document-order-only"
  | "unordered";
export type NarrativeReceptionKnowledgeStatus =
  | "same-character-same-proposition"
  | "same-proposition-different-character";
export interface NarrativeReceptionKnowledgeLinkInput {
  readonly projectId: string;
  readonly receptionCandidates: readonly NarrativeInformationReceptionCandidate[];
  readonly knowledgeCandidates: readonly NarrativeCharacterKnowledgeCandidate[];
  readonly documentOrder?: readonly NarrativeReceptionKnowledgeOrder[];
}
export interface NarrativeReceptionKnowledgeLink {
  readonly id: string;
  readonly projectId: string;
  readonly receptionCandidateId: string;
  readonly knowledgeCandidateId: string;
  readonly characterEntityId: string;
  readonly knowledgeHolderEntityId: string;
  readonly status: NarrativeReceptionKnowledgeStatus;
  readonly position: NarrativeReceptionKnowledgePosition;
  readonly receptionStage: NarrativeInformationReceptionCandidate["stage"];
  readonly knowledgeKind: NarrativeCharacterKnowledgeCandidate["kind"];
  readonly receptionPolarity: "affirmed" | "negated";
  readonly knowledgePolarity: "affirmed" | "negated";
  readonly receptionEvidence: TextEvidence;
  readonly knowledgeEvidence: TextEvidence;
  readonly propositionEvidence: TextEvidence;
  readonly interpretation: "literal-proposition-link-only";
  readonly comprehensionInferred: false;
  readonly acceptanceInferred: false;
  readonly knowledgeTruthEstablished: false;
  readonly reviewStatus: "candidate";
}
export const MAX_NARRATIVE_RECEPTION_KNOWLEDGE_RECEPTIONS = 10_000;
export const MAX_NARRATIVE_RECEPTION_KNOWLEDGE_CLAIMS = 10_000;
export const MAX_NARRATIVE_RECEPTION_KNOWLEDGE_PAIRS = 50_000;
export const MAX_NARRATIVE_RECEPTION_KNOWLEDGE_LINKS = 5_000;

function normalize(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("es")
    .replace(/[.,;:!?¿¡"'«»“”]+/gu, " ").replace(/\s+/gu, " ").trim();
}
function validEvidence(item: TextEvidence, documentId: string, revision: number): boolean {
  return !!item && item.documentId===documentId && item.revision===revision &&
    Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) &&
    item.start>=0 && item.end>item.start && typeof item.excerpt==="string" &&
    item.excerpt.length===item.end-item.start && item.status!=="stale";
}
function validate(input: NarrativeReceptionKnowledgeLinkInput): void {
  if(!input||typeof input!=="object"||typeof input.projectId!=="string"||!input.projectId.trim()||
    !Array.isArray(input.receptionCandidates)||input.receptionCandidates.length>MAX_NARRATIVE_RECEPTION_KNOWLEDGE_RECEPTIONS||
    !Array.isArray(input.knowledgeCandidates)||input.knowledgeCandidates.length>MAX_NARRATIVE_RECEPTION_KNOWLEDGE_CLAIMS||
    (input.documentOrder!==undefined&&!Array.isArray(input.documentOrder)))
    throw new Error("Entrada inválida para enlazar recepción y conocimiento.");
  const receptionIds=new Set<string>();
  for(const item of input.receptionCandidates) {
    if(!item||item.projectId!==input.projectId||typeof item.id!=="string"||!item.id.trim()||receptionIds.has(item.id)||
      typeof item.characterEntityId!=="string"||!item.characterEntityId.trim()||
      !validEvidence(item.evidence,item.documentId,item.revision)||
      !validEvidence(item.propositionEvidence,item.documentId,item.revision)||
      !validEvidence(item.characterEvidence,item.documentId,item.revision)||
      !validEvidence(item.triggerEvidence,item.documentId,item.revision)||
      item.propositionEvidence.start<item.evidence.start||item.propositionEvidence.end>item.evidence.end||
      item.characterEvidence.start<item.evidence.start||item.characterEvidence.end>item.evidence.end||
      item.triggerEvidence.start<item.evidence.start||item.triggerEvidence.end>item.evidence.end)
      throw new Error("Candidato de recepción inválido o con evidencia inconsistente.");
    receptionIds.add(item.id);
  }
  const knowledgeIds=new Set<string>();
  for(const item of input.knowledgeCandidates) {
    if(!item||item.projectId!==input.projectId||typeof item.id!=="string"||!item.id.trim()||knowledgeIds.has(item.id)||
      typeof item.holderEntityId!=="string"||!item.holderEntityId.trim()||
      !validEvidence(item.evidence,item.documentId,item.revision)||
      !validEvidence(item.holderEvidence,item.documentId,item.revision)||
      !validEvidence(item.triggerEvidence,item.documentId,item.revision)||
      !item.propositionEvidence||!validEvidence(item.propositionEvidence,item.documentId,item.revision)||
      item.propositionEvidence.start<item.evidence.start||item.propositionEvidence.end>item.evidence.end)
      throw new Error("Candidato de conocimiento inválido o sin proposición probatoria.");
    knowledgeIds.add(item.id);
  }
  const orderIds=new Set<string>(),orderValues=new Set<number>();
  for(const item of input.documentOrder??[]) {
    if(!item||typeof item.documentId!=="string"||!item.documentId.trim()||orderIds.has(item.documentId)||
      !Number.isSafeInteger(item.order)||orderValues.has(item.order))
      throw new Error("El orden documental debe ser explícito, único y no ambiguo.");
    orderIds.add(item.documentId);orderValues.add(item.order);
  }
}
function position(reception: NarrativeInformationReceptionCandidate, knowledge: NarrativeCharacterKnowledgeCandidate,
  order: ReadonlyMap<string,number>): NarrativeReceptionKnowledgePosition {
  if(reception.documentId===knowledge.documentId) {
    if(reception.revision!==knowledge.revision) return "unordered";
    if(reception.evidence.start<knowledge.evidence.end&&knowledge.evidence.start<reception.evidence.end)
      return "overlapping-evidence";
    if(reception.evidence.end<=knowledge.evidence.start) return "reception-before-knowledge";
    return "knowledge-before-reception";
  }
  const a=order.get(reception.documentId),b=order.get(knowledge.documentId);
  return a!==undefined&&b!==undefined&&a!==b?"document-order-only":"unordered";
}
/**
 * Solo crea enlaces cuando coinciden personaje y proposición literal normalizada.
 * Las coincidencias de proposición en personajes distintos se mantienen como
 * pistas separadas, nunca como transferencia ni recepción del mismo individuo.
 */
export function linkNarrativeReceptionToKnowledge(
  input: NarrativeReceptionKnowledgeLinkInput
): readonly NarrativeReceptionKnowledgeLink[] {
  validate(input);
  const order=new Map((input.documentOrder??[]).map(item=>[item.documentId,item.order]));
  const links:NarrativeReceptionKnowledgeLink[]=[];
  let examined=0;
  for(const reception of input.receptionCandidates) for(const knowledge of input.knowledgeCandidates) {
    if(++examined>MAX_NARRATIVE_RECEPTION_KNOWLEDGE_PAIRS)
      throw new Error("El cruce recepción-conocimiento supera el presupuesto; procesa por capítulos.");
    if(normalize(reception.propositionEvidence.excerpt)!==normalize(knowledge.propositionEvidence!.excerpt)) continue;
    const sameCharacter=reception.characterEntityId===knowledge.holderEntityId;
    if(!sameCharacter) continue;
    if(links.length>=MAX_NARRATIVE_RECEPTION_KNOWLEDGE_LINKS)
      throw new Error("El cruce recepción-conocimiento supera el límite de enlaces.");
    links.push({
      id:"reception-knowledge-link:"+JSON.stringify([reception.id,knowledge.id]),
      projectId:input.projectId,receptionCandidateId:reception.id,knowledgeCandidateId:knowledge.id,
      characterEntityId:reception.characterEntityId,knowledgeHolderEntityId:knowledge.holderEntityId,
      status:"same-character-same-proposition",position:position(reception,knowledge,order),
      receptionStage:reception.stage,knowledgeKind:knowledge.kind,
      receptionPolarity:reception.polarity,knowledgePolarity:knowledge.polarity,
      receptionEvidence:reception.evidence,knowledgeEvidence:knowledge.evidence,
      propositionEvidence:reception.propositionEvidence,
      interpretation:"literal-proposition-link-only",comprehensionInferred:false,
      acceptanceInferred:false,knowledgeTruthEstablished:false,reviewStatus:"candidate"
    });
  }
  return links.sort((a,b)=>a.receptionEvidence.start-b.receptionEvidence.start||
    a.knowledgeEvidence.start-b.knowledgeEvidence.start||a.id.localeCompare(b.id));
}
