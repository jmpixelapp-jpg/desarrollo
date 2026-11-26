/**
 * Descubrimiento conservador de afirmaciones sobre conocimiento de personajes.
 * Registra señales textuales, no hechos mentales confirmados.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

export type NarrativeCharacterKnowledgeKind =
  | "learned" | "discovered" | "suspected" | "believed" | "remembered" | "forgotten" | "reported";
export type NarrativeCharacterKnowledgeMode =
  | "asserted-cognition" | "uncertain-cognition" | "reported-transfer";

export interface NarrativeCharacterKnowledgeCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly kind: NarrativeCharacterKnowledgeKind;
  readonly mode: NarrativeCharacterKnowledgeMode;
  readonly holderEntityId: string;
  readonly sourceEntityId?: string;
  readonly propositionEvidence?: TextEvidence;
  readonly holderEvidence: TextEvidence;
  readonly triggerEvidence: TextEvidence;
  readonly sourceEvidence?: TextEvidence;
  readonly evidence: TextEvidence;
  readonly polarity: "affirmed" | "negated";
  readonly certainty: "explicit-claim" | "uncertain-claim";
  readonly reviewStatus: "candidate";
}
export interface NarrativeCharacterKnowledgeDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
}
export const MAX_NARRATIVE_CHARACTER_KNOWLEDGE_TEXT_UNITS = 2_000_000;
export const MAX_NARRATIVE_CHARACTER_KNOWLEDGE_CANDIDATES = 500;
export const MAX_NARRATIVE_CHARACTER_KNOWLEDGE_ENTITIES = 5_000;
export const MAX_NARRATIVE_CHARACTER_KNOWLEDGE_ALIASES = 100;
export const MAX_NARRATIVE_CHARACTER_KNOWLEDGE_NAME_LENGTH = 256;
export const MAX_NARRATIVE_CHARACTER_KNOWLEDGE_SCAN_UNITS = 25_000_000;
export const MAX_NARRATIVE_CHARACTER_KNOWLEDGE_PROPOSITION_UNITS = 500;

interface NameMatch { readonly entityId: string; readonly start: number; readonly end: number; }
interface Signal {
  readonly kind: NarrativeCharacterKnowledgeKind;
  readonly mode: NarrativeCharacterKnowledgeMode;
  readonly certainty: NarrativeCharacterKnowledgeCandidate["certainty"];
  readonly pattern: RegExp;
}
const COGNITIVE_SIGNALS: readonly Signal[] = [
  { kind:"learned",mode:"asserted-cognition",certainty:"explicit-claim",pattern:/(?<trigger>se\s+enter[oó]|se\s+enteraba|supo|sab[ií]a|averigu[oó]|averiguaba)\s+(?:de\s+)?que\s+(?<proposition>[^.!?;\n]{1,500})/giu },
  { kind:"discovered",mode:"asserted-cognition",certainty:"explicit-claim",pattern:/(?<trigger>descubri[oó]|descubr[ií]a|comprendi[oó]|comprend[ií]a|advirti[oó]|se\s+dio\s+cuenta)\s+(?:de\s+)?que\s+(?<proposition>[^.!?;\n]{1,500})/giu },
  { kind:"suspected",mode:"uncertain-cognition",certainty:"uncertain-claim",pattern:/(?<trigger>sospech[oó]|sospechaba|intuy[oó]|intu[ií]a|dud[oó]|dudaba)\s+(?:que|de\s+que)\s+(?<proposition>[^.!?;\n]{1,500})/giu },
  { kind:"believed",mode:"uncertain-cognition",certainty:"uncertain-claim",pattern:/(?<trigger>crey[oó]|cre[ií]a|pens[oó]|pensaba|supuso|supon[ií]a|imagin[oó]|imaginaba)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu },
  { kind:"remembered",mode:"asserted-cognition",certainty:"explicit-claim",pattern:/(?<trigger>record[oó]|recordaba|rememor[oó]|rememoraba)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu },
  { kind:"forgotten",mode:"asserted-cognition",certainty:"explicit-claim",pattern:/(?<trigger>olvid[oó]|olvidaba|no\s+recordaba)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu }
];
const TRANSFER_PATTERN = /(?<trigger>revel[oó]|cont[oó]|confes[oó]|inform[oó]|comunic[oó]|advirti[oó])\s+(?:a\s+)?(?<recipient>[\p{L}\p{M}][\p{L}\p{M}'’ -]{0,80}?)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$|[\]\\{}]/gu, "\\$&");
}
function spans(text: string): readonly {start:number;end:number}[] {
  const out:{start:number;end:number}[]=[];
  for(const line of text.matchAll(/[^\n]+/gu)) for(const m of line[0].matchAll(/[^.!?]+(?:[.!?]+|$)/gu)) {
    const leading=m[0].search(/\S/u), end=m[0].trimEnd().length;
    if(leading>=0&&end>leading) out.push({start:line.index+m.index+leading,end:line.index+m.index+end});
  }
  return out;
}
function ev(input:NarrativeCharacterKnowledgeDiscoveryInput,start:number,end:number):TextEvidence {
 return {documentId:input.documentId,revision:input.revision,start:(input.baseOffset??0)+start,end:(input.baseOffset??0)+end,excerpt:input.text.slice(start,end)};
}
function validate(input:NarrativeCharacterKnowledgeDiscoveryInput):void {
 if(!input||typeof input!=="object"||typeof input.projectId!=="string"||!input.projectId.trim()||
 typeof input.documentId!=="string"||!input.documentId.trim()||!Number.isSafeInteger(input.revision)||input.revision<0||
 typeof input.text!=="string"||input.text.length>MAX_NARRATIVE_CHARACTER_KNOWLEDGE_TEXT_UNITS||
 !Array.isArray(input.entities)||input.entities.length>MAX_NARRATIVE_CHARACTER_KNOWLEDGE_ENTITIES||
 (input.baseOffset!==undefined&&(!Number.isSafeInteger(input.baseOffset)||input.baseOffset<0||
 input.baseOffset>Number.MAX_SAFE_INTEGER-input.text.length))) throw new Error("Contexto inválido para descubrir conocimiento de personajes.");
 const ids=new Set<string>();
 for(const entity of input.entities) {
  if(!entity||entity.projectId!==input.projectId||typeof entity.id!=="string"||!entity.id.trim()||ids.has(entity.id)||
  typeof entity.canonicalName!=="string"||!entity.canonicalName.trim()||entity.canonicalName.length>MAX_NARRATIVE_CHARACTER_KNOWLEDGE_NAME_LENGTH||
  !Array.isArray(entity.aliases)||entity.aliases.length>MAX_NARRATIVE_CHARACTER_KNOWLEDGE_ALIASES||
  entity.aliases.some(alias=>typeof alias!=="string"||!alias.trim()||alias.length>MAX_NARRATIVE_CHARACTER_KNOWLEDGE_NAME_LENGTH))
  throw new Error("Entidades inválidas, duplicadas o ajenas al proyecto.");
  ids.add(entity.id);
 }
}
function findNames(sentence:string,absoluteStart:number,entities:readonly NarrativeEntity[]):NameMatch[] {
 const out:NameMatch[]=[];
 for(const entity of entities) if(entity.kind==="character") for(const name of new Set([entity.canonicalName,...entity.aliases])) {
  const re=new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])"+escapeRegExp(name)+"(?![\\p{L}\\p{M}\\p{N}_])","giu");
  for(const m of sentence.matchAll(re)) out.push({entityId:entity.id,start:absoluteStart+m.index!,end:absoluteStart+m.index!+m[0].length});
 }
 return out.sort((a,b)=>a.start-b.start||b.end-a.end);
}
function uniqueMention(matches:readonly NameMatch[],start:number,end:number):NameMatch|undefined {
 const found=matches.filter(x=>x.start>=start&&x.end<=end), ids=new Set(found.map(x=>x.entityId));
 return ids.size===1&&found.length?found[0]:undefined;
}
export function discoverNarrativeCharacterKnowledgeCandidates(input:NarrativeCharacterKnowledgeDiscoveryInput):readonly NarrativeCharacterKnowledgeCandidate[] {
 validate(input);
 const characters=input.entities.filter(x=>x.kind==="character"), sentenceSpans=spans(input.text);
 const names=characters.reduce((n,x)=>n+1+x.aliases.length,0);
 const cost=sentenceSpans.reduce((n,x)=>n+(x.end-x.start)*names,0);
 if(!Number.isSafeInteger(cost)||cost>MAX_NARRATIVE_CHARACTER_KNOWLEDGE_SCAN_UNITS)
  throw new Error("La búsqueda de conocimiento supera el presupuesto; divide el manuscrito por bloques o capítulos.");
 const out:NarrativeCharacterKnowledgeCandidate[]=[], seen=new Set<string>();
 const add=(item:NarrativeCharacterKnowledgeCandidate)=>{
  const key=[item.kind,item.holderEntityId,item.triggerEvidence.start,item.sourceEntityId??""].join(":");
  if(seen.has(key))return; seen.add(key);
  if(out.length>=MAX_NARRATIVE_CHARACTER_KNOWLEDGE_CANDIDATES) throw new Error("La extracción supera el límite de afirmaciones de conocimiento; divide el manuscrito.");
  out.push(item);
 };
 for(const span of sentenceSpans) {
  const sentence=input.text.slice(span.start,span.end), mentions=findNames(sentence,span.start,characters);
  if(!mentions.length)continue;
  for(const signal of COGNITIVE_SIGNALS) {
   signal.pattern.lastIndex=0;
   for(const m of sentence.matchAll(signal.pattern)) {
    const triggerLocal=m.index!+m[0].indexOf(m.groups!.trigger!);
    const triggerStart=span.start+triggerLocal, triggerEnd=triggerStart+m.groups!.trigger!.length;
    const holder=uniqueMention(mentions,span.start,triggerStart);
    if(!holder)continue;
    const raw=m.groups!.proposition!, proposition=raw.trim();
    if(!proposition||proposition.length>MAX_NARRATIVE_CHARACTER_KNOWLEDGE_PROPOSITION_UNITS)continue;
    const pLocal=m.index!+m[0].indexOf(raw)+(raw.length-raw.trimStart().length);
    const pStart=span.start+pLocal;
    const prefix=sentence.slice(0,triggerLocal);
    const negated=/(?:\\bno\\s+|\\bnunca\\s+|\\bjam[aá]s\\s+)/iu.test(prefix);
    add({id:"character-knowledge:"+input.documentId+":"+input.revision+":"+triggerStart+":"+signal.kind,
     projectId:input.projectId,documentId:input.documentId,revision:input.revision,kind:signal.kind,mode:signal.mode,
     holderEntityId:holder.entityId,propositionEvidence:ev(input,pStart,pStart+proposition.length),
     holderEvidence:ev(input,holder.start,holder.end),triggerEvidence:ev(input,triggerStart,triggerEnd),
     evidence:ev(input,span.start,span.end),polarity:negated?"negated":"affirmed",certainty:signal.certainty,reviewStatus:"candidate"});
   }
  }
  TRANSFER_PATTERN.lastIndex=0;
  for(const m of sentence.matchAll(TRANSFER_PATTERN)) {
   const triggerLocal=m.index!+m[0].indexOf(m.groups!.trigger!), triggerStart=span.start+triggerLocal;
   const speaker=uniqueMention(mentions,span.start,triggerStart); if(!speaker)continue;
   const recRaw=m.groups!.recipient!, recLocal=m.index!+m[0].indexOf(recRaw);
   const rec=uniqueMention(mentions,span.start+recLocal,span.start+recLocal+recRaw.length);
   if(!rec||rec.entityId===speaker.entityId)continue;
   const raw=m.groups!.proposition!, proposition=raw.trim();
   if(!proposition||proposition.length>MAX_NARRATIVE_CHARACTER_KNOWLEDGE_PROPOSITION_UNITS)continue;
   const pLocal=m.index!+m[0].indexOf(raw)+(raw.length-raw.trimStart().length), pStart=span.start+pLocal;
   add({id:"character-knowledge:"+input.documentId+":"+input.revision+":"+triggerStart+":reported",
    projectId:input.projectId,documentId:input.documentId,revision:input.revision,kind:"reported",mode:"reported-transfer",
    holderEntityId:rec.entityId,sourceEntityId:speaker.entityId,propositionEvidence:ev(input,pStart,pStart+proposition.length),
    holderEvidence:ev(input,rec.start,rec.end),triggerEvidence:ev(input,triggerStart,triggerStart+m.groups!.trigger!.length),
    sourceEvidence:ev(input,speaker.start,speaker.end),evidence:ev(input,span.start,span.end),
    polarity:"affirmed",certainty:"explicit-claim",reviewStatus:"candidate"});
  }
 }
 return out.sort((a,b)=>a.evidence.start-b.evidence.start||a.triggerEvidence.start-b.triggerEvidence.start||a.holderEntityId.localeCompare(b.holderEntityId));
}
