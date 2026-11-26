/**
 * Vincula conocimiento con acciones únicamente cuando la propia oración de
 * acción contiene un marcador explícito de uso consciente de esa información.
 * La mera proximidad entre saber y actuar nunca crea un enlace.
 */
import type { TextEvidence } from "./narrative-knowledge";
import type { NarrativeCharacterKnowledgeCandidate } from "./narrative-character-knowledge-discovery";
import type { NarrativeObservationCandidate } from "./narrative-observation-discovery";

export interface NarrativeKnowledgeActionUseInput {
  readonly projectId: string;
  readonly knowledgeCandidates: readonly NarrativeCharacterKnowledgeCandidate[];
  readonly observations: readonly NarrativeObservationCandidate[];
}
export type NarrativeKnowledgeActionUseMarker =
  | "knowing-that" | "aware-that" | "remembering-that" | "without-forgetting-that";
export interface NarrativeKnowledgeActionUseLink {
  readonly id: string;
  readonly projectId: string;
  readonly knowledgeCandidateId: string;
  readonly actionObservationId: string;
  readonly characterEntityId: string;
  readonly action: string;
  readonly marker: NarrativeKnowledgeActionUseMarker;
  readonly markerEvidence: TextEvidence;
  readonly knowledgeEvidence: TextEvidence;
  readonly actionEvidence: TextEvidence;
  readonly propositionEvidence: TextEvidence;
  readonly relationship: "explicit-knowledge-context-in-action-sentence";
  readonly knowledgeUseEstablished: false;
  readonly actionCausationEstablished: false;
  readonly reviewStatus: "candidate";
}
export const MAX_NARRATIVE_KNOWLEDGE_ACTION_CLAIMS = 10_000;
export const MAX_NARRATIVE_KNOWLEDGE_ACTION_OBSERVATIONS = 10_000;
export const MAX_NARRATIVE_KNOWLEDGE_ACTION_PAIR_CHECKS = 50_000;
export const MAX_NARRATIVE_KNOWLEDGE_ACTION_LINKS = 5_000;

interface MarkerPattern {
  readonly marker: NarrativeKnowledgeActionUseMarker;
  readonly expression: RegExp;
}
const MARKERS: readonly MarkerPattern[] = [
  {marker:"knowing-that",expression:/(?<![\p{L}\p{M}\p{N}_])(?:sabiendo|sabiendo bien)\s+que\s+/giu},
  {marker:"aware-that",expression:/(?<![\p{L}\p{M}\p{N}_])(?:consciente|enterado|al tanto)\s+de\s+que\s+/giu},
  {marker:"remembering-that",expression:/(?<![\p{L}\p{M}\p{N}_])recordando\s+que\s+/giu},
  {marker:"without-forgetting-that",expression:/(?<![\p{L}\p{M}\p{N}_])sin\s+olvidar\s+que\s+/giu}
];
function normalize(value:string):string {
 return value.normalize("NFC").toLocaleLowerCase("es").replace(/[.,;:!?¿¡"'«»“”]+/gu," ").replace(/\s+/gu," ").trim();
}
function validEvidence(value:TextEvidence, item:{documentId:string;revision:number}):boolean {
 return !!value&&value.documentId===item.documentId&&value.revision===item.revision&&
 Number.isSafeInteger(value.start)&&Number.isSafeInteger(value.end)&&value.start>=0&&value.end>value.start&&
 typeof value.excerpt==="string"&&value.excerpt.length===value.end-value.start&&value.status!=="stale";
}
function validate(input:NarrativeKnowledgeActionUseInput):void {
 if(!input||typeof input!=="object"||typeof input.projectId!=="string"||!input.projectId.trim()||
 !Array.isArray(input.knowledgeCandidates)||input.knowledgeCandidates.length>MAX_NARRATIVE_KNOWLEDGE_ACTION_CLAIMS||
 !Array.isArray(input.observations)||input.observations.length>MAX_NARRATIVE_KNOWLEDGE_ACTION_OBSERVATIONS)
 throw new Error("Entrada inválida para enlazar conocimiento y acciones.");
 const knowledgeIds=new Set<string>();
 for(const item of input.knowledgeCandidates) {
  if(!item||item.projectId!==input.projectId||typeof item.id!=="string"||!item.id.trim()||knowledgeIds.has(item.id)||
   typeof item.holderEntityId!=="string"||!item.holderEntityId.trim()||
   !item.propositionEvidence||!validEvidence(item.evidence,item)||!validEvidence(item.propositionEvidence,item)||
   !validEvidence(item.holderEvidence,item)||!validEvidence(item.triggerEvidence,item)||
   item.propositionEvidence.start<item.evidence.start||item.propositionEvidence.end>item.evidence.end)
   throw new Error("Afirmación de conocimiento inválida o sin proposición verificable.");
  knowledgeIds.add(item.id);
 }
 const actionIds=new Set<string>();
 for(const item of input.observations) {
  if(!item||item.projectId!==input.projectId||item.kind!=="action"||typeof item.id!=="string"||
   !item.id.trim()||actionIds.has(item.id)||typeof item.action!=="string"||!item.action.trim()||
   !validEvidence(item.evidence,item)||!validEvidence(item.actionEvidence,item)||
   item.actionEvidence.start<item.evidence.start||item.actionEvidence.end>item.evidence.end||
   (item.grammaticalSubjectCandidate!==undefined&&
    (!item.grammaticalSubjectCandidate.entityId?.trim()||
     !validEvidence(item.grammaticalSubjectCandidate.evidence,item)||
     item.grammaticalSubjectCandidate.evidence.start<item.evidence.start||
     item.grammaticalSubjectCandidate.evidence.end>item.evidence.end)))
   throw new Error("Observación de acción inválida o sin evidencia consistente.");
  actionIds.add(item.id);
 }
}
export function linkNarrativeKnowledgeToActionUse(
 input:NarrativeKnowledgeActionUseInput
):readonly NarrativeKnowledgeActionUseLink[] {
 validate(input);
 const result:NarrativeKnowledgeActionUseLink[]=[];
 let checks=0;
 for(const knowledge of input.knowledgeCandidates) for(const action of input.observations) {
  if(++checks>MAX_NARRATIVE_KNOWLEDGE_ACTION_PAIR_CHECKS)
   throw new Error("El cruce conocimiento-acción supera el presupuesto; procesa por capítulos.");
  const subject=action.grammaticalSubjectCandidate;
  if(!subject||subject.voice!=="active"||subject.entityId!==knowledge.holderEntityId) continue;
  if(knowledge.mode!=="asserted-cognition"||knowledge.polarity!=="affirmed"||
   knowledge.certainty!=="explicit-claim"||!knowledge.propositionEvidence) continue;
  const sentence=action.evidence.excerpt;
  const proposition=normalize(knowledge.propositionEvidence.excerpt);
  if(!proposition) continue;
  for(const pattern of MARKERS) {
   pattern.expression.lastIndex=0;
   let match:RegExpExecArray|null;
   while((match=pattern.expression.exec(sentence))!==null) {
    const after=sentence.slice(match.index+match[0].length);
    const normalizedAfter=normalize(after);
    if(!normalizedAfter.includes(proposition)) continue;
    const relative=sentence.indexOf(match[0],match.index);
    const markerStart=action.evidence.start+relative;
    const markerEnd=markerStart+match[0].trimEnd().length;
    if(result.length>=MAX_NARRATIVE_KNOWLEDGE_ACTION_LINKS)
     throw new Error("El cruce conocimiento-acción supera el límite de enlaces.");
    result.push({
     id:"knowledge-action-use:"+JSON.stringify([knowledge.id,action.id,markerStart]),
     projectId:input.projectId,knowledgeCandidateId:knowledge.id,actionObservationId:action.id,
     characterEntityId:subject.entityId,action:action.action,marker:pattern.marker,
     markerEvidence:{documentId:action.documentId,revision:action.revision,start:markerStart,end:markerEnd,
      excerpt:sentence.slice(relative,relative+match[0].trimEnd().length)},
     knowledgeEvidence:knowledge.evidence,actionEvidence:action.evidence,
     propositionEvidence:knowledge.propositionEvidence,
     relationship:"explicit-knowledge-context-in-action-sentence",
     knowledgeUseEstablished:false,actionCausationEstablished:false,reviewStatus:"candidate"
    });
   }
  }
 }
 return result.sort((a,b)=>a.actionEvidence.start-b.actionEvidence.start||
  a.knowledgeEvidence.start-b.knowledgeEvidence.start||a.id.localeCompare(b.id));
}
