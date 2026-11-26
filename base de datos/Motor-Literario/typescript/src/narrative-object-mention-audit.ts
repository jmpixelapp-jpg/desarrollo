/**
 * Audita la cobertura de menciones explícitas de objetos frente a transiciones extraídas.
 * Un hueco indica falta de transición enlazada, nunca ausencia de actividad del objeto.
 */
import type { TextEvidence } from "./narrative-knowledge";
import type { NarrativeObservationCandidate } from "./narrative-observation-discovery";
import type { NarrativeObjectTransitionCandidate } from "./narrative-object-state-discovery";
export type NarrativeObjectMentionAuditStatus="transition-evidence-matched"|"object-mention-without-transition"|"ambiguous-transition-match";
export interface NarrativeObjectMentionAuditEntry {
 readonly id:string;readonly projectId:string;readonly documentId:string;readonly revision:number;
 readonly entityId:string;readonly mentionEvidence:TextEvidence;readonly observationId:string;
 readonly matchedTransitionIds:readonly string[];readonly status:NarrativeObjectMentionAuditStatus;
 readonly interpretation:"coverage-gap-not-semantic-absence";readonly reviewStatus:"candidate";
}
export interface NarrativeObjectMentionAuditInput {
 readonly projectId:string;readonly documentId:string;readonly revision:number;
 readonly text:string;readonly observations:readonly NarrativeObservationCandidate[];
 readonly transitions:readonly NarrativeObjectTransitionCandidate[];readonly baseOffset?:number;
}
export const MAX_NARRATIVE_OBJECT_MENTION_AUDIT_OBSERVATIONS=20_000;
export const MAX_NARRATIVE_OBJECT_MENTION_AUDIT_TRANSITIONS=20_000;
export const MAX_NARRATIVE_OBJECT_MENTION_AUDIT_ENTRIES=50_000;
function valid(e:TextEvidence,input:NarrativeObjectMentionAuditInput):boolean{
 const base=input.baseOffset??0;
 return !!e&&e.documentId===input.documentId&&e.revision===input.revision&&
 Number.isSafeInteger(e.start)&&Number.isSafeInteger(e.end)&&e.start>=base&&e.end>e.start&&
 e.end<=base+input.text.length&&typeof e.excerpt==="string"&&e.end-e.start===e.excerpt.length&&
 e.status!=="stale"&&input.text.slice(e.start-base,e.end-base)===e.excerpt;
}
export function auditNarrativeObjectMentionCoverage(input:NarrativeObjectMentionAuditInput):readonly NarrativeObjectMentionAuditEntry[]{
 if(!input||typeof input!=="object"||typeof input.projectId!=="string"||!input.projectId.trim()||
 typeof input.documentId!=="string"||!input.documentId.trim()||!Number.isSafeInteger(input.revision)||input.revision<0||
 typeof input.text!=="string"||input.text.length>2_000_000||!Array.isArray(input.observations)||
 input.observations.length>MAX_NARRATIVE_OBJECT_MENTION_AUDIT_OBSERVATIONS||!Array.isArray(input.transitions)||
 input.transitions.length>MAX_NARRATIVE_OBJECT_MENTION_AUDIT_TRANSITIONS||
 (input.baseOffset!==undefined&&(!Number.isSafeInteger(input.baseOffset)||input.baseOffset<0||
 input.baseOffset>Number.MAX_SAFE_INTEGER-input.text.length)))throw new Error("Entrada inválida para auditar menciones de objetos.");
 const obsIds=new Set<string>(),transitionIds=new Set<string>(),mentions:{observation:NarrativeObservationCandidate;entityId:string;evidence:TextEvidence}[]=[];
 for(const o of input.observations){
  if(!o||o.projectId!==input.projectId||o.documentId!==input.documentId||o.revision!==input.revision||
  typeof o.id!=="string"||!o.id.trim()||obsIds.has(o.id)||!valid(o.evidence,input)||
  !valid(o.actionEvidence,input)||o.actionEvidence.start<o.evidence.start||o.actionEvidence.end>o.evidence.end)
   throw new Error("Observación ajena, duplicada o con evidencia inválida.");
  obsIds.add(o.id);
  for(const m of o.entityMentionOccurrences??[]){
   if(m.entityKind!=="object")continue;
   if(typeof m.entityId!=="string"||!m.entityId.trim()||!valid(m.evidence,input)||
    m.evidence.start<o.evidence.start||m.evidence.end>o.evidence.end)
    throw new Error("Mención de objeto sin procedencia válida.");
   mentions.push({observation:o,entityId:m.entityId,evidence:m.evidence});
  }
 }
 const transitionsByObservation=new Map<string,NarrativeObjectTransitionCandidate[]>();
 for(const t of input.transitions){
  if(!t||t.projectId!==input.projectId||t.documentId!==input.documentId||t.revision!==input.revision||
  typeof t.id!=="string"||!t.id.trim()||transitionIds.has(t.id)||!obsIds.has(t.observationId)||
  typeof t.objectEntityId!=="string"||!t.objectEntityId.trim()||!valid(t.objectEvidence,input)||
  !valid(t.contextEvidence,input)||!valid(t.actionEvidence,input)||t.objectEvidence.start<t.contextEvidence.start||
  t.objectEvidence.end>t.contextEvidence.end||t.actionEvidence.start<t.contextEvidence.start||
  t.actionEvidence.end>t.contextEvidence.end)throw new Error("Transición ajena, duplicada o con evidencia inválida.");
  transitionIds.add(t.id);const list=transitionsByObservation.get(t.observationId)??[];list.push(t);transitionsByObservation.set(t.observationId,list);
 }
 if(mentions.length>MAX_NARRATIVE_OBJECT_MENTION_AUDIT_ENTRIES)throw new Error("Demasiadas menciones; divide el documento.");
 const out:NarrativeObjectMentionAuditEntry[]=[];
 for(const mention of mentions){
  const matches=(transitionsByObservation.get(mention.observation.id)??[]).filter(t=>
   t.objectEntityId===mention.entityId&&t.objectEvidence.start===mention.evidence.start&&
   t.objectEvidence.end===mention.evidence.end&&t.objectEvidence.excerpt===mention.evidence.excerpt);
  const status: NarrativeObjectMentionAuditStatus=matches.length===0?"object-mention-without-transition":
   matches.length===1?"transition-evidence-matched":"ambiguous-transition-match";
  out.push({id:"object-mention-audit:"+input.documentId+":"+input.revision+":"+mention.observation.id+":"+mention.entityId+":"+mention.evidence.start,
   projectId:input.projectId,documentId:input.documentId,revision:input.revision,entityId:mention.entityId,
   mentionEvidence:mention.evidence,observationId:mention.observation.id,matchedTransitionIds:matches.map(t=>t.id).sort(),
   status,interpretation:"coverage-gap-not-semantic-absence",reviewStatus:"candidate"});
 }
 return out.sort((a,b)=>a.mentionEvidence.start-b.mentionEvidence.start||a.entityId.localeCompare(b.entityId));
}
