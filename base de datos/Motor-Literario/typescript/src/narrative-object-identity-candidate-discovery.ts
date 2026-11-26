/**
 * Descubre posibles identidades compartidas entre fichas de objetos a partir
 * de descripciones revisadas idénticas. No fusiona entidades ni resuelve
 * equivalencias semánticas o sinonimias.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";
export interface NarrativeObjectIdentityDescriptionProfile {
 readonly entityId:string;
 readonly labels:readonly {readonly text:string;readonly evidence:TextEvidence}[];
}
export interface NarrativeObjectIdentityCandidate {
 readonly id:string;readonly projectId:string;
 readonly firstEntityId:string;readonly secondEntityId:string;
 readonly reason:"shared-reviewed-description";
 readonly normalizedDescription:string;
 readonly evidence:readonly [TextEvidence,TextEvidence];
 readonly descriptionUsedByEntityIds:readonly string[];
 readonly ambiguity:"pair-only"|"shared-by-three-or-more-objects";
 readonly interpretation:"identity-hypothesis-only";
 readonly mergePerformed:false;
 readonly reviewStatus:"candidate";
}
export interface NarrativeObjectIdentityDiscoveryInput {
 readonly projectId:string;readonly entities:readonly NarrativeEntity[];
 readonly profiles:readonly NarrativeObjectIdentityDescriptionProfile[];
 readonly maxCandidates?:number;
}
export const MAX_OBJECT_IDENTITY_ENTITIES=10_000;
export const MAX_OBJECT_IDENTITY_PROFILES=10_000;
export const MAX_OBJECT_IDENTITY_LABELS=100;
export const MAX_OBJECT_IDENTITY_TOTAL_LABELS=50_000;
export const MAX_OBJECT_IDENTITY_LABEL_LENGTH=160;
export const MAX_OBJECT_IDENTITY_CANDIDATES=20_000;
function normalize(value:string):string{return value.normalize("NFC").toLocaleLowerCase("es").trim().replace(/\s+/gu," ");}
function validEvidence(e:TextEvidence):boolean{return !!e&&typeof e.documentId==="string"&&!!e.documentId.trim()&&Number.isSafeInteger(e.revision)&&e.revision>=0&&Number.isSafeInteger(e.start)&&e.start>=0&&Number.isSafeInteger(e.end)&&e.end>e.start&&typeof e.excerpt==="string"&&e.excerpt.length===e.end-e.start&&e.status!=="stale";}
export function discoverNarrativeObjectIdentityCandidates(input:NarrativeObjectIdentityDiscoveryInput):readonly NarrativeObjectIdentityCandidate[]{
 const max=input?.maxCandidates??MAX_OBJECT_IDENTITY_CANDIDATES;
 if(!input||typeof input!=="object"||typeof input.projectId!=="string"||!input.projectId.trim()||
 !Array.isArray(input.entities)||input.entities.length>MAX_OBJECT_IDENTITY_ENTITIES||
 !Array.isArray(input.profiles)||input.profiles.length>MAX_OBJECT_IDENTITY_PROFILES||
 !Number.isSafeInteger(max)||max<1||max>MAX_OBJECT_IDENTITY_CANDIDATES)
 throw new Error("Entrada inválida para descubrir identidades candidatas de objetos.");
 const entities=new Map<string,NarrativeEntity>();
 for(const e of input.entities){if(!e||e.projectId!==input.projectId||typeof e.id!=="string"||!e.id.trim()||entities.has(e.id)||e.kind!=="object")throw new Error("Las entidades deben ser objetos únicos del proyecto.");entities.set(e.id,e);}
 const profileIds=new Set<string>();let total=0;
 const byDescription=new Map<string,Map<string,TextEvidence>>();
 for(const p of input.profiles){
  if(!p||!entities.has(p.entityId)||profileIds.has(p.entityId)||!Array.isArray(p.labels)||p.labels.length>MAX_OBJECT_IDENTITY_LABELS)throw new Error("Perfil descriptivo ajeno, duplicado o inválido.");
  profileIds.add(p.entityId);
  for(const label of p.labels){
   if(!label||typeof label.text!=="string"||!label.text.trim()||label.text.length>MAX_OBJECT_IDENTITY_LABEL_LENGTH||!validEvidence(label.evidence))throw new Error("Etiqueta descriptiva sin evidencia válida.");
   total++;if(total>MAX_OBJECT_IDENTITY_TOTAL_LABELS)throw new Error("Demasiadas etiquetas para comparar identidades.");
   if(label.evidence.status==="stale")continue;
   const key=normalize(label.text);const owners=byDescription.get(key)??new Map<string,TextEvidence>();
   if(!owners.has(p.entityId))owners.set(p.entityId,label.evidence);
   byDescription.set(key,owners);
  }
 }
 const out:NarrativeObjectIdentityCandidate[]=[];
 for(const [description,owners] of byDescription){
  const ids=[...owners.keys()].sort();
  if(ids.length<2)continue;
  for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
   if(out.length>=max)break;
   const first=ids[i]!,second=ids[j]!;
   out.push({id:"object-identity:"+first+":"+second+":"+encodeURIComponent(description),
    projectId:input.projectId,firstEntityId:first,secondEntityId:second,
    reason:"shared-reviewed-description",normalizedDescription:description,
    evidence:[owners.get(first)!,owners.get(second)!],descriptionUsedByEntityIds:ids,
    ambiguity:ids.length>=3?"shared-by-three-or-more-objects":"pair-only",
    interpretation:"identity-hypothesis-only",mergePerformed:false,reviewStatus:"candidate"});
  }
 }
 return out.sort((a,b)=>a.firstEntityId.localeCompare(b.firstEntityId)||a.secondEntityId.localeCompare(b.secondEntityId)||a.normalizedDescription.localeCompare(b.normalizedDescription));
}
