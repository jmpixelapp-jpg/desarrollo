/**
 * Relaciona conocimiento explícitamente atribuido a un personaje con señales
 * posteriores de ocultación/fingimiento. Solo produce vínculos candidatos.
 */
import type { TextEvidence } from "./narrative-knowledge";
import type { NarrativeCharacterKnowledgeCandidate } from "./narrative-character-knowledge-discovery";
import type { NarrativeInformationConcealmentCandidate } from "./narrative-information-concealment-discovery";

export type NarrativeDeceptionEvidenceRelation =
  | "prior-knowledge-before-concealment"
  | "prior-knowledge-before-lie"
  | "prior-knowledge-before-feigning"
  | "prior-knowledge-before-induced-belief";
export interface NarrativeDeceptionEvidenceLink {
  readonly id: string;
  readonly projectId: string;
  readonly actorEntityId: string;
  readonly relation: NarrativeDeceptionEvidenceRelation;
  readonly knowledgeCandidateId: string;
  readonly concealmentCandidateId: string;
  readonly propositionKey: string;
  readonly knowledgeKind: NarrativeCharacterKnowledgeCandidate["kind"];
  readonly knowledgeEvidence: TextEvidence;
  readonly knowledgePropositionEvidence: TextEvidence;
  readonly concealmentEvidence: TextEvidence;
  readonly concealmentPropositionEvidence: TextEvidence;
  readonly concealmentTriggerEvidence: TextEvidence;
  readonly recipientEntityId?: string;
  readonly chronologyBasis: "same-document-revision-offset" | "explicit-document-order";
  readonly knowledgeBeforeSignal: true;
  readonly deceptionEstablished: false;
  readonly intentEstablished: false;
  readonly reviewStatus: "candidate";
}
export interface NarrativeDeceptionEvidenceLinkInput {
  readonly projectId: string;
  readonly knowledgeCandidates: readonly NarrativeCharacterKnowledgeCandidate[];
  readonly concealmentCandidates: readonly NarrativeInformationConcealmentCandidate[];
  /** Orden de capítulos confirmado por el proyecto; no se infiere desde IDs. */
  readonly documentOrder?: readonly { readonly documentId: string; readonly order: number }[];
}
export const MAX_NARRATIVE_DECEPTION_KNOWLEDGE = 10_000;
export const MAX_NARRATIVE_DECEPTION_CONCEALMENTS = 5_000;
export const MAX_NARRATIVE_DECEPTION_PAIR_CHECKS = 50_000;
export const MAX_NARRATIVE_DECEPTION_LINKS = 5_000;

function normalize(value:string):string {
  return value.normalize("NFC").toLocaleLowerCase("es")
    .replace(/[.,;:!?¿¡"'«»“”]+/gu," ").replace(/\s+/gu," ").trim();
}
function validEvidence(value:TextEvidence,documentId:string,revision:number):boolean {
  return !!value&&value.documentId===documentId&&value.revision===revision&&
    Number.isSafeInteger(value.start)&&Number.isSafeInteger(value.end)&&
    value.start>=0&&value.end>value.start&&typeof value.excerpt==="string"&&
    value.excerpt.length===value.end-value.start&&value.status!=="stale";
}
function validate(input:NarrativeDeceptionEvidenceLinkInput):void {
  if(!input||typeof input!=="object"||typeof input.projectId!=="string"||!input.projectId.trim()||
    !Array.isArray(input.knowledgeCandidates)||input.knowledgeCandidates.length>MAX_NARRATIVE_DECEPTION_KNOWLEDGE||
    !Array.isArray(input.concealmentCandidates)||input.concealmentCandidates.length>MAX_NARRATIVE_DECEPTION_CONCEALMENTS||
    (input.documentOrder!==undefined&&(!Array.isArray(input.documentOrder)||input.documentOrder.length>5_000)))
    throw new Error("Entrada inválida para enlazar conocimiento y ocultación narrativa.");
  const documentIds=new Set<string>(),orders=new Set<number>();
  for(const item of input.documentOrder??[]) {
    if(!item||typeof item.documentId!=="string"||!item.documentId.trim()||
      !Number.isSafeInteger(item.order)||item.order<0||documentIds.has(item.documentId)||orders.has(item.order))
      throw new Error("El orden documental contiene identificadores o posiciones duplicadas/inválidas.");
    documentIds.add(item.documentId);orders.add(item.order);
  }
  const knowledgeIds=new Set<string>();
  for(const item of input.knowledgeCandidates) {
    if(!item||item.projectId!==input.projectId||typeof item.id!=="string"||!item.id.trim()||
      knowledgeIds.has(item.id)||typeof item.holderEntityId!=="string"||!item.holderEntityId.trim()||
      !["learned","known","heard","read","discovered","suspected","believed","remembered","forgotten","reported"].includes(item.kind)||
      !["asserted-cognition","uncertain-cognition","reported-transfer"].includes(item.mode)||
      !["affirmed","negated"].includes(item.polarity)||!["explicit-claim","uncertain-claim"].includes(item.certainty)||
      !validEvidence(item.evidence,item.documentId,item.revision)||
      !validEvidence(item.holderEvidence,item.documentId,item.revision)||
      !validEvidence(item.triggerEvidence,item.documentId,item.revision)||
      item.holderEvidence.start<item.evidence.start||item.holderEvidence.end>item.evidence.end||
      item.triggerEvidence.start<item.evidence.start||item.triggerEvidence.end>item.evidence.end||
      (item.propositionEvidence!==undefined&&(!validEvidence(item.propositionEvidence,item.documentId,item.revision)||
        item.propositionEvidence.start<item.evidence.start||item.propositionEvidence.end>item.evidence.end)))
      throw new Error("Afirmación de conocimiento inválida o con evidencia inconsistente.");
    knowledgeIds.add(item.id);
  }
  const concealmentIds=new Set<string>();
  for(const item of input.concealmentCandidates) {
    if(!item||item.projectId!==input.projectId||typeof item.id!=="string"||!item.id.trim()||
      concealmentIds.has(item.id)||!["concealed-proposition","lied-to-recipient","feigned-proposition","induced-belief"].includes(item.signal)||
      typeof item.actorEntityId!=="string"||!item.actorEntityId.trim()||
      (item.recipientEntityId!==undefined&&(typeof item.recipientEntityId!=="string"||!item.recipientEntityId.trim()||
        item.recipientEntityId===item.actorEntityId))||
      item.assertionStatus!=="textually-asserted"||!["affirmed","negated"].includes(item.polarity)||
      item.deceptionEstablished!==false||item.intentEstablished!==false||item.reviewStatus!=="candidate"||
      !validEvidence(item.evidence,item.documentId,item.revision)||
      !validEvidence(item.actorEvidence,item.documentId,item.revision)||
      !validEvidence(item.triggerEvidence,item.documentId,item.revision)||
      !validEvidence(item.propositionEvidence,item.documentId,item.revision)||
      item.actorEvidence.start<item.evidence.start||item.actorEvidence.end>item.evidence.end||
      item.triggerEvidence.start<item.evidence.start||item.triggerEvidence.end>item.evidence.end||
      item.propositionEvidence.start<item.evidence.start||item.propositionEvidence.end>item.evidence.end||
      (item.recipientEvidence!==undefined&&(!validEvidence(item.recipientEvidence,item.documentId,item.revision)||
        item.recipientEvidence.start<item.evidence.start||item.recipientEvidence.end>item.evidence.end))||
      (item.recipientEntityId!==undefined&&!item.recipientEvidence))
      throw new Error("Candidato de ocultación inválido o con evidencia inconsistente.");
    concealmentIds.add(item.id);
  }
}
function relationFor(signal:NarrativeInformationConcealmentCandidate["signal"]):NarrativeDeceptionEvidenceRelation {
  switch(signal) {
    case "concealed-proposition":return "prior-knowledge-before-concealment";
    case "lied-to-recipient":return "prior-knowledge-before-lie";
    case "feigned-proposition":return "prior-knowledge-before-feigning";
    case "induced-belief":return "prior-knowledge-before-induced-belief";
  }
}
function chronology(
  knowledge:NarrativeCharacterKnowledgeCandidate,
  concealment:NarrativeInformationConcealmentCandidate,
  orders:ReadonlyMap<string,number>
):NarrativeDeceptionEvidenceLink["chronologyBasis"]|undefined {
  if(knowledge.documentId===concealment.documentId&&knowledge.revision===concealment.revision)
    return knowledge.evidence.end<=concealment.triggerEvidence.start?"same-document-revision-offset":undefined;
  if(knowledge.documentId===concealment.documentId)return undefined;
  const before=orders.get(knowledge.documentId),after=orders.get(concealment.documentId);
  return before!==undefined&&after!==undefined&&before<after?"explicit-document-order":undefined;
}
/**
 * Solo enlaza proposiciones literales coincidentes y conocimiento afirmado,
 * explícito y anterior. Sospechas, creencias, negaciones, olvidos y transferencias
 * comunicativas se excluyen: no prueban conocimiento previo del actor.
 */
export function linkNarrativeKnowledgeToConcealment(
  input:NarrativeDeceptionEvidenceLinkInput
):readonly NarrativeDeceptionEvidenceLink[] {
  validate(input);
  const orders=new Map((input.documentOrder??[]).map(item=>[item.documentId,item.order]));
  let pairChecks=0;
  const output:NarrativeDeceptionEvidenceLink[]=[];
  for(const concealment of input.concealmentCandidates) {
    if(concealment.polarity!=="affirmed")continue;
    const propositionKey=normalize(concealment.propositionEvidence.excerpt);
    if(!propositionKey)continue;
    for(const knowledge of input.knowledgeCandidates) {
      if(knowledge.holderEntityId!==concealment.actorEntityId||knowledge.mode!=="asserted-cognition"||
        knowledge.polarity!=="affirmed"||knowledge.certainty!=="explicit-claim"||
        !["learned","known","heard","read","discovered","remembered"].includes(knowledge.kind)||
        !knowledge.propositionEvidence)continue;
      pairChecks++;
      if(pairChecks>MAX_NARRATIVE_DECEPTION_PAIR_CHECKS)
        throw new Error("El enlace supera el presupuesto de pares; procesa el manuscrito por capítulos.");
      if(normalize(knowledge.propositionEvidence.excerpt)!==propositionKey)continue;
      const basis=chronology(knowledge,concealment,orders);
      if(!basis)continue;
      if(output.length>=MAX_NARRATIVE_DECEPTION_LINKS)
        throw new Error("El enlace supera el límite de resultados; procesa el manuscrito por capítulos.");
      output.push({
        id:"deception-evidence-link:"+JSON.stringify([knowledge.id,concealment.id]),
        projectId:input.projectId,actorEntityId:concealment.actorEntityId,
        relation:relationFor(concealment.signal),knowledgeCandidateId:knowledge.id,
        concealmentCandidateId:concealment.id,propositionKey,knowledgeKind:knowledge.kind,
        knowledgeEvidence:knowledge.evidence,knowledgePropositionEvidence:knowledge.propositionEvidence,
        concealmentEvidence:concealment.evidence,concealmentPropositionEvidence:concealment.propositionEvidence,
        concealmentTriggerEvidence:concealment.triggerEvidence,
        ...(concealment.recipientEntityId?{recipientEntityId:concealment.recipientEntityId}:{}),
        chronologyBasis:basis,knowledgeBeforeSignal:true,deceptionEstablished:false,
        intentEstablished:false,reviewStatus:"candidate"
      });
    }
  }
  return output.sort((a,b)=>a.knowledgeEvidence.documentId.localeCompare(b.knowledgeEvidence.documentId)||
    a.knowledgeEvidence.start-b.knowledgeEvidence.start||a.concealmentEvidence.start-b.concealmentEvidence.start||
    a.id.localeCompare(b.id));
}
