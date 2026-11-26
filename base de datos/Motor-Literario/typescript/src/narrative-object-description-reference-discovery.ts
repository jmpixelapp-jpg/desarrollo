/**
 * Recupera menciones descriptivas de objetos usando etiquetas previamente validadas.
 * No crea sinonimias ni fusiona entidades: las etiquetas deben proceder de revisión
 * humana o de una extracción descriptiva revisada.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";
export interface NarrativeObjectDescriptionProfile {
 readonly entityId:string;
 readonly labels:readonly {readonly text:string;readonly evidence:TextEvidence}[];
}
export interface NarrativeObjectDescriptionCandidate {
 readonly entityId:string;readonly entityKind:"object";readonly label:string;
 readonly labelEvidence:TextEvidence;
}
export interface NarrativeObjectDescriptionMatch {
 readonly id:string;readonly projectId:string;readonly documentId:string;readonly revision:number;
 readonly mentionEvidence:TextEvidence;readonly candidates:readonly NarrativeObjectDescriptionCandidate[];
 readonly status:"single-candidate"|"ambiguous";readonly reviewStatus:"candidate";
 readonly matchingMethod:"exact-reviewed-description";
}
export interface NarrativeObjectDescriptionDiscoveryInput {
 readonly projectId:string;readonly documentId:string;readonly revision:number;readonly text:string;
 readonly entities:readonly NarrativeEntity[];readonly profiles:readonly NarrativeObjectDescriptionProfile[];
 readonly baseOffset?:number;readonly maxMatches?:number;
}
export const MAX_OBJECT_DESCRIPTION_TEXT_UNITS=2_000_000;
export const MAX_OBJECT_DESCRIPTION_PROFILES=5_000;
export const MAX_OBJECT_DESCRIPTION_LABELS_PER_PROFILE=100;
export const MAX_OBJECT_DESCRIPTION_LABEL_LENGTH=160;
export const MAX_OBJECT_DESCRIPTION_TOTAL_LABELS=20_000;
export const MAX_OBJECT_DESCRIPTION_SCAN_UNITS=25_000_000;
export const MAX_OBJECT_DESCRIPTION_MATCHES=5_000;
function norm(s:string):string{return s.normalize("NFC").toLocaleLowerCase("es").trim().replace(/\s+/gu," ");}
function esc(s:string):string{return s.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&");}
function validEvidence(e:TextEvidence):boolean{return !!e&&typeof e.documentId==="string"&&!!e.documentId.trim()&&Number.isSafeInteger(e.revision)&&e.revision>=0&&Number.isSafeInteger(e.start)&&e.start>=0&&Number.isSafeInteger(e.end)&&e.end>e.start&&typeof e.excerpt==="string"&&e.excerpt.length===e.end-e.start;}
export function discoverNarrativeObjectDescriptionReferences(input:NarrativeObjectDescriptionDiscoveryInput):readonly NarrativeObjectDescriptionMatch[]{
 const max=input?.maxMatches??2_000;
 if(!input||typeof input!=="object"||typeof input.projectId!=="string"||!input.projectId.trim()||
 typeof input.documentId!=="string"||!input.documentId.trim()||!Number.isSafeInteger(input.revision)||input.revision<0||
 typeof input.text!=="string"||input.text.length>MAX_OBJECT_DESCRIPTION_TEXT_UNITS||
 !Array.isArray(input.entities)||!Array.isArray(input.profiles)||input.profiles.length>MAX_OBJECT_DESCRIPTION_PROFILES||
 !Number.isSafeInteger(max)||max<1||max>MAX_OBJECT_DESCRIPTION_MATCHES||
 (input.baseOffset!==undefined&&(!Number.isSafeInteger(input.baseOffset)||input.baseOffset<0||input.baseOffset>Number.MAX_SAFE_INTEGER-input.text.length)))
 throw new Error("Entrada inválida para referencias descriptivas de objetos.");
 const entities=new Map<string,NarrativeEntity>();
 for(const e of input.entities){if(!e||e.projectId!==input.projectId||typeof e.id!=="string"||!e.id.trim()||entities.has(e.id)||e.kind!=="object"||!Array.isArray(e.aliases))throw new Error("Las entidades deben ser objetos únicos del proyecto.");entities.set(e.id,e);}
 const profileIds=new Set<string>();let total=0,scan=0;
 const occurrences=new Map<string,{start:number;end:number;excerpt:string;candidates:Map<string,NarrativeObjectDescriptionCandidate>}>();
 for(const p of input.profiles){
  const entity=p&&entities.get(p.entityId);
  if(!p||!entity||profileIds.has(p.entityId)||!Array.isArray(p.labels)||p.labels.length>MAX_OBJECT_DESCRIPTION_LABELS_PER_PROFILE)throw new Error("Cada perfil debe pertenecer a un objeto único del proyecto.");
  profileIds.add(p.entityId);total+=p.labels.length;if(total>MAX_OBJECT_DESCRIPTION_TOTAL_LABELS)throw new Error("Demasiadas etiquetas descriptivas.");
  const labels=new Set<string>();
  for(const label of p.labels){
   if(!label||typeof label.text!=="string"||!label.text.trim()||label.text.length>MAX_OBJECT_DESCRIPTION_LABEL_LENGTH||!validEvidence(label.evidence))throw new Error("Etiqueta sin evidencia válida.");
   const n=norm(label.text);if(labels.has(n))throw new Error("Etiqueta descriptiva repetida.");labels.add(n);
   if(label.evidence.status==="stale")continue;
   scan+=input.text.length;if(scan>MAX_OBJECT_DESCRIPTION_SCAN_UNITS)throw new Error("Presupuesto de exploración descriptiva excedido.");
   const expression=new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])"+esc(label.text)+"(?![\\p{L}\\p{M}\\p{N}_])","giu");
   for(const m of input.text.matchAll(expression)){
    const start=m.index!,end=start+m[0].length,key=start+":"+end;
    let hit=occurrences.get(key);if(!hit){hit={start,end,excerpt:m[0],candidates:new Map()};occurrences.set(key,hit);}
    hit.candidates.set(entity.id+":"+n,{entityId:entity.id,entityKind:"object",label:label.text,labelEvidence:label.evidence});
   }
  }
 }
 const base=input.baseOffset??0;
 return [...occurrences.values()].sort((a,b)=>a.start-b.start||a.end-b.end).slice(0,max).map(hit=>{
  const candidates=[...hit.candidates.values()].sort((a,b)=>a.entityId.localeCompare(b.entityId)||a.label.localeCompare(b.label));
  return {id:"object-description:"+input.documentId+":"+input.revision+":"+(base+hit.start),
   projectId:input.projectId,documentId:input.documentId,revision:input.revision,
   mentionEvidence:{documentId:input.documentId,revision:input.revision,start:base+hit.start,end:base+hit.end,excerpt:hit.excerpt},
   candidates,status:candidates.length===1?"single-candidate":"ambiguous",reviewStatus:"candidate",
   matchingMethod:"exact-reviewed-description"};
 });
}
