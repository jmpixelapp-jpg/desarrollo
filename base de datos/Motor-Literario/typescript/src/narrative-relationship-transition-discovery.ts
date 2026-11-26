import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";
export type NarrativeRelationshipTransitionKind = "formed" | "ended" | "reconciled";
export type NarrativeRelationshipFamily = "friendship" | "enmity" | "marriage" | "trust" | "alliance";
export interface NarrativeRelationshipTransitionCandidate {
 readonly id:string; readonly projectId:string; readonly documentId:string; readonly revision:number;
 readonly firstEntityId:string; readonly secondEntityId:string; readonly family:NarrativeRelationshipFamily;
 readonly transition:NarrativeRelationshipTransitionKind; readonly trigger:string;
 readonly triggerEvidence:TextEvidence; readonly firstEntityEvidence:TextEvidence;
 readonly secondEntityEvidence:TextEvidence; readonly contextEvidence:TextEvidence;
 readonly reviewStatus:"candidate";
}
export interface NarrativeRelationshipTransitionDiscoveryInput {
 readonly projectId:string; readonly documentId:string; readonly revision:number; readonly text:string;
 readonly entities:readonly NarrativeEntity[]; readonly baseOffset?:number; readonly maxCandidates?:number;
}
export const MAX_NARRATIVE_RELATIONSHIP_TRANSITION_TEXT_UNITS=2_000_000;
export const MAX_NARRATIVE_RELATIONSHIP_TRANSITION_ENTITIES=5_000;
export const MAX_NARRATIVE_RELATIONSHIP_TRANSITION_ALIASES=100;
export const MAX_NARRATIVE_RELATIONSHIP_TRANSITION_NAME_LENGTH=256;
export const MAX_NARRATIVE_RELATIONSHIP_TRANSITION_CANDIDATES=2_000;
export const MAX_NARRATIVE_RELATIONSHIP_TRANSITION_SCAN_UNITS=25_000_000;
const DEFAULT_MAX_CANDIDATES=1_000;
const MAX_CONTEXT_UNITS=180;
interface Signal { family:NarrativeRelationshipFamily; transition:NarrativeRelationshipTransitionKind; expression:string; }
const SIGNALS:readonly Signal[]=[
 {family:"friendship",transition:"formed",expression:"se\\s+hicieron\\s+amig[oa]s?|se\\s+volvieron\\s+amig[oa]s?|entabl(?:ó|aron)\\s+amistad|comenz(?:ó|aron)\\s+a\\s+ser\\s+amig[oa]s?"},
 {family:"friendship",transition:"ended",expression:"rompi(?:ó|eron)\\s+(?:su|la)\\s+amistad|dej(?:ó|aron)\\s+de\\s+ser\\s+amig[oa]s?|se\\s+distanci(?:ó|aron)"},
 {family:"friendship",transition:"reconciled",expression:"se\\s+reconcili(?:ó|aron)|hicieron\\s+las\\s+paces"},
 {family:"enmity",transition:"formed",expression:"se\\s+enemist(?:ó|aron)|se\\s+convirti(?:ó|eron)\\s+en\\s+enemig[oa]s?"},
 {family:"enmity",transition:"ended",expression:"dej(?:ó|aron)\\s+de\\s+ser\\s+enemig[oa]s?|firm(?:ó|aron)\\s+la\\s+paz"},
 {family:"marriage",transition:"formed",expression:"se\\s+cas(?:ó|aron)|contraj(?:o|eron)\\s+matrimonio"},
 {family:"marriage",transition:"ended",expression:"se\\s+divorci(?:ó|aron)|anul(?:ó|aron)\\s+el\\s+matrimonio"},
 {family:"trust",transition:"ended",expression:"dej(?:ó|aron)\\s+de\\s+confiar|perdi(?:ó|eron)\\s+la\\s+confianza"},
 {family:"trust",transition:"formed",expression:"empez(?:ó|aron)\\s+a\\s+confiar|deposit(?:ó|aron)\\s+su\\s+confianza"},
 {family:"alliance",transition:"formed",expression:"se\\s+ali(?:ó|aron)|forj(?:ó|aron)\\s+una\\s+alianza|sell(?:ó|aron)\\s+una\\s+alianza"},
 {family:"alliance",transition:"ended",expression:"rompi(?:ó|eron)\\s+la\\s+alianza|disolvi(?:ó|eron)\\s+la\\s+alianza|traicion(?:ó|aron)\\s+la\\s+alianza"}
];
function escapeRegExp(value:string):string {
 const special=new Set([".","+","*","?","^","$","(",")","|","[","]","{","}"]);
 return Array.from(value,c=>special.has(c)||c.charCodeAt(0)===92?String.fromCharCode(92)+c:c).join("");
}
function makeEvidence(documentId:string,revision:number,base:number,start:number,end:number,excerpt:string):TextEvidence {
 return {documentId,revision,start:base+start,end:base+end,excerpt};
}
/** Detecta cambios relacionales literales; nunca actualiza automáticamente el grafo. */
export function discoverNarrativeRelationshipTransitionCandidates(input:NarrativeRelationshipTransitionDiscoveryInput):readonly NarrativeRelationshipTransitionCandidate[] {
 const max=input?.maxCandidates??DEFAULT_MAX_CANDIDATES;
 if(!input||typeof input!=="object"||typeof input.projectId!=="string"||!input.projectId.trim()||
 typeof input.documentId!=="string"||!input.documentId.trim()||!Number.isSafeInteger(input.revision)||input.revision<0||
 typeof input.text!=="string"||input.text.length>MAX_NARRATIVE_RELATIONSHIP_TRANSITION_TEXT_UNITS||
 !Array.isArray(input.entities)||input.entities.length>MAX_NARRATIVE_RELATIONSHIP_TRANSITION_ENTITIES||
 !Number.isSafeInteger(max)||max<1||max>MAX_NARRATIVE_RELATIONSHIP_TRANSITION_CANDIDATES||
 (input.baseOffset!==undefined&&(!Number.isSafeInteger(input.baseOffset)||input.baseOffset<0||
 input.baseOffset>Number.MAX_SAFE_INTEGER-input.text.length))) throw new Error("Contexto inválido para descubrir cambios de relaciones narrativas.");
 const ids=new Set<string>(); const names:{entity:NarrativeEntity;name:string}[]=[];
 for(const entity of input.entities){
  if(!entity||entity.kind!=="character"||entity.projectId!==input.projectId||typeof entity.id!=="string"||!entity.id.trim()||ids.has(entity.id)||
  typeof entity.canonicalName!=="string"||!entity.canonicalName.trim()||
  entity.canonicalName.length>MAX_NARRATIVE_RELATIONSHIP_TRANSITION_NAME_LENGTH||
  !Array.isArray(entity.aliases)||entity.aliases.length>MAX_NARRATIVE_RELATIONSHIP_TRANSITION_ALIASES||
  entity.aliases.some(alias=>typeof alias!=="string"||!alias.trim()||alias.length>MAX_NARRATIVE_RELATIONSHIP_TRANSITION_NAME_LENGTH))
  throw new Error("Las entidades y sus alias deben ser únicos y válidos.");
  ids.add(entity.id); for(const name of [entity.canonicalName,...entity.aliases]) names.push({entity,name});
 }
 names.sort((a,b)=>b.name.length-a.name.length||a.entity.id.localeCompare(b.entity.id));
 const results=new Map<string,NarrativeRelationshipTransitionCandidate>(); let scanUnits=0; const base=input.baseOffset??0;
 for(const signal of SIGNALS) for(const left of names) for(const right of names){
  if(left.entity.id===right.entity.id||normalize(left.name)===normalize(right.name)) continue;
  scanUnits+=input.text.length;
  if(scanUnits>MAX_NARRATIVE_RELATIONSHIP_TRANSITION_SCAN_UNITS) throw new Error("La búsqueda de cambios relacionales supera el presupuesto operativo de exploración.");
  const pair=new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])"+escapeRegExp(left.name)+
   "(?![\\p{L}\\p{M}\\p{N}_])([^.!?;\\n]{0,"+MAX_CONTEXT_UNITS+"}?)(?<![\\p{L}\\p{M}\\p{N}_])"+
   escapeRegExp(right.name)+"(?![\\p{L}\\p{M}\\p{N}_])","giu");
  for(const match of input.text.matchAll(pair)){
   const segment=match[0]; const leftStart=match.index!; const rightStart=leftStart+segment.lastIndexOf(right.name);
   for(const trigger of match[1]!.matchAll(new RegExp(signal.expression,"giu"))){
    const start=leftStart+left.name.length+trigger.index!; const end=start+trigger[0].length;
    const key=[left.entity.id,right.entity.id,signal.family,signal.transition,start].join(":");
    if(results.has(key)) continue;
    results.set(key,{id:"relationship-transition-candidate:"+JSON.stringify([input.documentId,input.revision,base+start,left.entity.id,right.entity.id,signal.family,signal.transition]),
     projectId:input.projectId,documentId:input.documentId,revision:input.revision,
     firstEntityId:left.entity.id,secondEntityId:right.entity.id,family:signal.family,transition:signal.transition,trigger:trigger[0],
     triggerEvidence:makeEvidence(input.documentId,input.revision,base,start,end,trigger[0]),
     firstEntityEvidence:makeEvidence(input.documentId,input.revision,base,leftStart,leftStart+left.name.length,left.name),
     secondEntityEvidence:makeEvidence(input.documentId,input.revision,base,rightStart,rightStart+right.name.length,right.name),
     contextEvidence:makeEvidence(input.documentId,input.revision,base,leftStart,leftStart+segment.length,segment),reviewStatus:"candidate"});
    if(results.size>max) throw new Error("La extracción supera el máximo de cambios relacionales; no se devuelve un resultado parcial.");
   }
  }
 }
 return [...results.values()].sort((a,b)=>a.triggerEvidence.start-b.triggerEvidence.start||a.firstEntityId.localeCompare(b.firstEntityId)||a.secondEntityId.localeCompare(b.secondEntityId));
}
