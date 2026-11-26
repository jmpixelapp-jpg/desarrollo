import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";
export type NarrativeRelationshipTransitionKind = "formed" | "ended" | "reconciled";
export type NarrativeRelationshipFamily = "friendship" | "enmity" | "marriage" | "trust" | "alliance";
export interface NarrativeRelationshipTransitionCandidate {
 readonly id:string; readonly projectId:string; readonly documentId:string; readonly revision:number;
 readonly firstEntityId:string; readonly secondEntityId:string; readonly family:NarrativeRelationshipFamily;
 readonly transition:NarrativeRelationshipTransitionKind; readonly trigger:string;
 readonly triggerEvidence:TextEvidence; readonly firstEntityEvidence:TextEvidence;
 readonly secondEntityEvidence:TextEvidence; readonly contextEvidence:TextEvidence;
 readonly epistemicFrame:"narrator-asserted"|"character-belief"|"character-memory"|"character-desire"|"reported-speech"|"hypothetical";
 readonly epistemicFrameEvidence?:TextEvidence;
 readonly epistemicSourceCandidate?:{readonly entityId:string;readonly evidence:TextEvidence};
 readonly polarity:"affirmed"|"negated";
 readonly polarityEvidence?:TextEvidence;
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
interface Signal {family:NarrativeRelationshipFamily;transition:NarrativeRelationshipTransitionKind;expression:string;}
interface NameOccurrence {entityId:string;start:number;end:number;surface:string;}
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
function normalize(value:string):string {return value.normalize("NFC").toLocaleLowerCase("es").trim().replace(/\s+/gu," ");}
function makeEvidence(documentId:string,revision:number,base:number,start:number,end:number,excerpt:string):TextEvidence {
 return {documentId,revision,start:base+start,end:base+end,excerpt};
}

const TRANSITION_EPISTEMIC_SIGNALS:readonly {
 frame:"character-belief"|"character-memory"|"character-desire"|"reported-speech"|"hypothetical";
 expression:RegExp;
}[]=[
 {frame:"character-belief",expression:/\b(?:creyó|creía|creyeron|pensó|pensaba|imaginó|imaginaba|supuso|suponía)\s+que\s+/giu},
 {frame:"character-memory",expression:/\b(?:recordó|recordaba|rememoró|rememoraba|olvidó|olvidaba)\s+que\s+/giu},
 {frame:"character-desire",expression:/\b(?:deseó|deseaba|quería|quiso|esperaba|esperó|anhelaba|anheló)\s+que\s+/giu},
 {frame:"reported-speech",expression:/\b(?:dijo|decía|afirmó|afirmaba|aseguró|aseguraba|contó|relató|advirtió|anunció)\s+que\s+/giu},
 {frame:"hypothetical",expression:/\b(?:si|quizá|quizás|tal vez|acaso|como si)\s+/giu}
];
function classifyTransitionContext(
 sentence:string,triggerStart:number,characters:readonly NarrativeEntity[],documentId:string,revision:number,base:number
):{
 frame:NarrativeRelationshipTransitionCandidate["epistemicFrame"];
 frameEvidence?:TextEvidence;
 source?:{entityId:string;evidence:TextEvidence};
 polarity:"affirmed"|"negated";
 polarityEvidence?:TextEvidence;
}{
 let selected:{frame:NonNullable<NarrativeRelationshipTransitionCandidate["epistemicFrame"]>;start:number;end:number;excerpt:string}|undefined;
 for(const signal of TRANSITION_EPISTEMIC_SIGNALS){
  signal.expression.lastIndex=0;
  for(const match of sentence.matchAll(signal.expression)){
   if(match.index!>=triggerStart)break;
   const candidate={frame:signal.frame,start:match.index!,end:match.index!+match[0].length,excerpt:match[0]};
   if(!selected||candidate.start>selected.start)selected=candidate;
  }
 }
 let source:{entityId:string;start:number;end:number;excerpt:string}|undefined;
 if(selected?.frame==="reported-speech"){
  const possible=characters.flatMap(entity=>[entity.canonicalName,...entity.aliases].flatMap(name=>{
   const escaped=escapeRegExp(name);
   const expression=new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])"+escaped+"(?![\\p{L}\\p{M}\\p{N}_])","giu");
   return [...sentence.slice(0,selected!.start).matchAll(expression)].map(match=>({entityId:entity.id,start:match.index!,end:match.index!+match[0].length,excerpt:match[0]}));
  })).sort((a,b)=>b.end-a.end||b.start-a.start);
  const nearest=possible[0];
  const equallyNear=nearest?possible.filter(item=>item.end===nearest.end):[];
  if(nearest&&equallyNear.every(item=>item.entityId===nearest.entityId))source=nearest;
 }
 const prefix=sentence.slice(0,triggerStart);
 const negation=/(?:^|[^\p{L}\p{M}\p{N}_])(?:no|nunca|jamás)\s*$/iu.exec(prefix);
 return {
  frame:selected?.frame??"narrator-asserted",
  ...(selected?{frameEvidence:makeEvidence(documentId,revision,base,selected.start,selected.end,selected.excerpt)}:{}),
  ...(source?{source:{entityId:source.entityId,evidence:makeEvidence(documentId,revision,base,source.start,source.end,source.excerpt)}}:{}),
  polarity:negation?"negated":"affirmed",
  ...(negation?{polarityEvidence:makeEvidence(documentId,revision,base,negation.index!,negation.index!+negation[0].length,negation[0])}:{})
 };
}
/** Detecta transiciones expresadas literalmente, sin mutar el grafo de relaciones. */
export function discoverNarrativeRelationshipTransitionCandidates(input:NarrativeRelationshipTransitionDiscoveryInput):readonly NarrativeRelationshipTransitionCandidate[] {
 const max=input?.maxCandidates??DEFAULT_MAX_CANDIDATES;
 if(!input||typeof input!=="object"||typeof input.projectId!=="string"||!input.projectId.trim()||
 typeof input.documentId!=="string"||!input.documentId.trim()||!Number.isSafeInteger(input.revision)||input.revision<0||
 typeof input.text!=="string"||input.text.length>MAX_NARRATIVE_RELATIONSHIP_TRANSITION_TEXT_UNITS||
 !Array.isArray(input.entities)||input.entities.length>MAX_NARRATIVE_RELATIONSHIP_TRANSITION_ENTITIES||
 !Number.isSafeInteger(max)||max<1||max>MAX_NARRATIVE_RELATIONSHIP_TRANSITION_CANDIDATES||
 (input.baseOffset!==undefined&&(!Number.isSafeInteger(input.baseOffset)||input.baseOffset<0||
 input.baseOffset>Number.MAX_SAFE_INTEGER-input.text.length))) throw new Error("Contexto inválido para descubrir cambios de relaciones narrativas.");
 const ids=new Set<string>(); const names:{entityId:string;name:string}[]=[];
 for(const entity of input.entities){
  if(!entity||entity.kind!=="character"||entity.projectId!==input.projectId||typeof entity.id!=="string"||
  !entity.id.trim()||ids.has(entity.id)||typeof entity.canonicalName!=="string"||!entity.canonicalName.trim()||
  entity.canonicalName.length>MAX_NARRATIVE_RELATIONSHIP_TRANSITION_NAME_LENGTH||
  !Array.isArray(entity.aliases)||entity.aliases.length>MAX_NARRATIVE_RELATIONSHIP_TRANSITION_ALIASES||
  entity.aliases.some(alias=>typeof alias!=="string"||!alias.trim()||alias.length>MAX_NARRATIVE_RELATIONSHIP_TRANSITION_NAME_LENGTH))
  throw new Error("Las entidades y sus alias deben ser únicos y válidos.");
  ids.add(entity.id);
  for(const name of [entity.canonicalName,...entity.aliases]) names.push({entityId:entity.id,name});
 }
 const normalizedOwners=new Map<string,Set<string>>();
 for(const item of names){const key=normalize(item.name);const owners=normalizedOwners.get(key)??new Set<string>();owners.add(item.entityId);normalizedOwners.set(key,owners);}
 const usableNames=names.filter(item=>(normalizedOwners.get(normalize(item.name))?.size??0)===1)
  .sort((a,b)=>b.name.length-a.name.length||a.entityId.localeCompare(b.entityId));
 const sentences:{start:number;text:string}[]=[];
 const sentenceExpression=/[^.!?;\n]+(?:[.!?;]+|\n|$)/gu;
 for(const match of input.text.matchAll(sentenceExpression)) sentences.push({start:match.index!,text:match[0]});
 const results=new Map<string,NarrativeRelationshipTransitionCandidate>();let scanUnits=0;const base=input.baseOffset??0;
 for(const sentence of sentences) for(const signal of SIGNALS){
  scanUnits+=sentence.text.length*Math.max(1,usableNames.length);
  if(scanUnits>MAX_NARRATIVE_RELATIONSHIP_TRANSITION_SCAN_UNITS) throw new Error("La búsqueda de cambios relacionales supera el presupuesto operativo de exploración.");
  const occurrences:NameOccurrence[]=[];
  for(const item of usableNames){
   const expression=new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])"+escapeRegExp(item.name)+"(?![\\p{L}\\p{M}\\p{N}_])","giu");
   for(const found of sentence.text.matchAll(expression)) occurrences.push({entityId:item.entityId,start:sentence.start+found.index!,end:sentence.start+found.index!+found[0].length,surface:found[0]});
  }
  if(occurrences.length<2) continue;
  occurrences.sort((a,b)=>a.start-b.start||a.end-b.end||a.entityId.localeCompare(b.entityId));
  const triggerExpression=new RegExp(signal.expression,"giu");
  for(const trigger of sentence.text.matchAll(triggerExpression)){
   const triggerStart=sentence.start+trigger.index!;const triggerEnd=triggerStart+trigger[0].length;
   const nearestByEntity=new Map<string,NameOccurrence>();
   for(const occurrence of occurrences){
    const previous=nearestByEntity.get(occurrence.entityId);
    const distance=Math.min(Math.abs(occurrence.start-triggerStart),Math.abs(occurrence.end-triggerEnd));
    const previousDistance=previous?Math.min(Math.abs(previous.start-triggerStart),Math.abs(previous.end-triggerEnd)):Infinity;
    if(!previous||distance<previousDistance) nearestByEntity.set(occurrence.entityId,occurrence);
   }
   const selected=[...nearestByEntity.values()].sort((a,b)=>a.start-b.start||a.entityId.localeCompare(b.entityId));
   const pairCandidates:{first:NameOccurrence;second:NameOccurrence;start:number;end:number;span:number}[]=[];
   for(let i=0;i<selected.length;i++) for(let j=i+1;j<selected.length;j++){
    const first=selected[i]!;const second=selected[j]!;
    const start=Math.min(first.start,second.start,triggerStart);
    const end=Math.max(first.end,second.end,triggerEnd);
    if(end-start<=MAX_CONTEXT_UNITS) pairCandidates.push({first,second,start,end,span:end-start});
   }
   // Preferimos el par con el menor contexto que contiene las dos menciones y
   // el disparador: reduce asociaciones accidentales con personajes incidentales.
   pairCandidates.sort((a,b)=>a.span-b.span||a.first.entityId.localeCompare(b.first.entityId)||a.second.entityId.localeCompare(b.second.entityId));
   const chosen=pairCandidates[0];
   if(chosen){
    const {first,second,start:contextStart,end:contextEnd}=chosen;
    const key=[first.entityId,second.entityId,signal.family,signal.transition,triggerStart].join(":");
    if(!results.has(key)){
     const epistemic=classifyTransitionContext(sentence.text,trigger.index!,input.entities,input.documentId,input.revision,base+sentence.start);
     results.set(key,{id:"relationship-transition-candidate:"+JSON.stringify([input.documentId,input.revision,base+triggerStart,first.entityId,second.entityId,signal.family,signal.transition]),
      projectId:input.projectId,documentId:input.documentId,revision:input.revision,
      firstEntityId:first.entityId,secondEntityId:second.entityId,family:signal.family,transition:signal.transition,trigger:trigger[0],
      triggerEvidence:makeEvidence(input.documentId,input.revision,base,triggerStart,triggerEnd,trigger[0]),
      firstEntityEvidence:makeEvidence(input.documentId,input.revision,base,first.start,first.end,first.surface),
      secondEntityEvidence:makeEvidence(input.documentId,input.revision,base,second.start,second.end,second.surface),
      contextEvidence:makeEvidence(input.documentId,input.revision,base,contextStart,contextEnd,input.text.slice(contextStart,contextEnd)),
      epistemicFrame:epistemic.frame,
      ...(epistemic.frameEvidence?{epistemicFrameEvidence:epistemic.frameEvidence}:{}),
      ...(epistemic.source?{epistemicSourceCandidate:epistemic.source}:{}),
      polarity:epistemic.polarity,
      ...(epistemic.polarityEvidence?{polarityEvidence:epistemic.polarityEvidence}:{}),
      reviewStatus:"candidate"});
     if(results.size>max) throw new Error("La extracción supera el máximo de cambios relacionales; no se devuelve un resultado parcial.");
    }
   }
  }
 }
 return [...results.values()].sort((a,b)=>a.triggerEvidence.start-b.triggerEvidence.start||a.firstEntityId.localeCompare(b.firstEntityId)||a.secondEntityId.localeCompare(b.secondEntityId));
}
