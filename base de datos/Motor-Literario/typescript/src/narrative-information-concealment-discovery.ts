/**
 * Extrae afirmaciones textuales explícitas de ocultación, mentira o fingimiento.
 * No determina si el acto ocurrió, si la afirmación era falsa ni la intención real.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

export type NarrativeInformationConcealmentSignal =
  | "concealed-proposition"
  | "lied-to-recipient"
  | "feigned-proposition"
  | "induced-belief";
export interface NarrativeInformationConcealmentCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly signal: NarrativeInformationConcealmentSignal;
  readonly actorEntityId: string;
  readonly recipientEntityId?: string;
  readonly propositionEvidence: TextEvidence;
  readonly actorEvidence: TextEvidence;
  readonly triggerEvidence: TextEvidence;
  readonly evidence: TextEvidence;
  readonly recipientEvidence?: TextEvidence;
  readonly assertionStatus: "textually-asserted";
  readonly polarity: "affirmed" | "negated";
  readonly deceptionEstablished: false;
  readonly intentEstablished: false;
  readonly reviewStatus: "candidate";
}
export interface NarrativeInformationConcealmentDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
}
export const MAX_NARRATIVE_INFORMATION_CONCEALMENT_TEXT_UNITS = 2_000_000;
export const MAX_NARRATIVE_INFORMATION_CONCEALMENT_ENTITIES = 5_000;
export const MAX_NARRATIVE_INFORMATION_CONCEALMENT_ALIASES = 100;
export const MAX_NARRATIVE_INFORMATION_CONCEALMENT_NAME_UNITS = 256;
export const MAX_NARRATIVE_INFORMATION_CONCEALMENT_PROPOSITION_UNITS = 500;
export const MAX_NARRATIVE_INFORMATION_CONCEALMENT_SCAN_UNITS = 25_000_000;
export const MAX_NARRATIVE_INFORMATION_CONCEALMENT_CANDIDATES = 1_000;

interface Span { readonly start:number; readonly end:number; }
interface Name { readonly entityId:string; readonly value:string; readonly normalized:string; }
interface Found {
  readonly signal:NarrativeInformationConcealmentSignal;
  readonly actor:string;
  readonly recipient?:string;
  readonly trigger:string;
  readonly proposition:string;
  readonly start:number;
  readonly actorStart:number;
  readonly triggerStart:number;
  readonly propositionStart:number;
  readonly recipientStart?:number;
}
function escapeRegExp(value:string):string {
  return value.replace(/[.*+?^$|[\]\\{}()]/gu,"\\$&");
}
function sentenceSpans(text:string):Span[] {
  const result:Span[]=[];
  for(const line of text.matchAll(/[^\n]+/gu)) {
    for(const part of line[0].matchAll(/[^.!?;]+(?:[.!?;]+|$)/gu)) {
      const leading=part[0].search(/\S/u), trailing=part[0].trimEnd().length;
      if(leading>=0&&trailing>leading) result.push({
        start:line.index!+part.index!+leading,
        end:line.index!+part.index!+trailing
      });
    }
  }
  return result;
}
function evidence(input:NarrativeInformationConcealmentDiscoveryInput,start:number,end:number):TextEvidence {
  const base=input.baseOffset??0;
  return {documentId:input.documentId,revision:input.revision,start:base+start,end:base+end,
    excerpt:input.text.slice(start,end)};
}
function validate(input:NarrativeInformationConcealmentDiscoveryInput):void {
  if(!input||typeof input!=="object"||typeof input.projectId!=="string"||!input.projectId.trim()||
    typeof input.documentId!=="string"||!input.documentId.trim()||
    !Number.isSafeInteger(input.revision)||input.revision<0||
    typeof input.text!=="string"||input.text.length>MAX_NARRATIVE_INFORMATION_CONCEALMENT_TEXT_UNITS||
    !Array.isArray(input.entities)||input.entities.length>MAX_NARRATIVE_INFORMATION_CONCEALMENT_ENTITIES||
    (input.baseOffset!==undefined&&(!Number.isSafeInteger(input.baseOffset)||input.baseOffset<0||
      input.baseOffset>Number.MAX_SAFE_INTEGER-input.text.length)))
    throw new Error("Contexto inválido para extraer afirmaciones de ocultación narrativa.");
  const ids=new Set<string>();
  for(const entity of input.entities) {
    if(!entity||entity.projectId!==input.projectId||typeof entity.id!=="string"||!entity.id.trim()||
      ids.has(entity.id)||typeof entity.canonicalName!=="string"||!entity.canonicalName.trim()||
      entity.canonicalName.length>MAX_NARRATIVE_INFORMATION_CONCEALMENT_NAME_UNITS||
      !Array.isArray(entity.aliases)||entity.aliases.length>MAX_NARRATIVE_INFORMATION_CONCEALMENT_ALIASES||
      entity.aliases.some(alias=>typeof alias!=="string"||!alias.trim()||
        alias.length>MAX_NARRATIVE_INFORMATION_CONCEALMENT_NAME_UNITS))
      throw new Error("Entidades inválidas, duplicadas o ajenas al proyecto.");
    ids.add(entity.id);
  }
}
function resolveName(raw:string,names:readonly Name[]):string|undefined {
  const key=raw.normalize("NFC").toLocaleLowerCase("es");
  const matches=new Set(names.filter(item=>item.normalized===key).map(item=>item.entityId));
  return matches.size===1?[...matches][0]:undefined;
}
/**
 * Busca únicamente construcciones con actor nombrado y verbo explícito.
 * Los destinatarios omitidos permanecen sin resolver; nunca se asignan por pronombre.
 */
export function discoverNarrativeInformationConcealmentCandidates(
  input:NarrativeInformationConcealmentDiscoveryInput
):readonly NarrativeInformationConcealmentCandidate[] {
  validate(input);
  const characters=input.entities.filter(entity=>entity.kind==="character");
  const names:Name[]=[];
  for(const entity of characters) for(const value of new Set([entity.canonicalName,...entity.aliases]))
    names.push({entityId:entity.id,value,normalized:value.normalize("NFC").toLocaleLowerCase("es")});
  const scanCost=input.text.length*Math.max(1,names.length);
  if(!Number.isSafeInteger(scanCost)||scanCost>MAX_NARRATIVE_INFORMATION_CONCEALMENT_SCAN_UNITS)
    throw new Error("La extracción de ocultación supera el presupuesto; divide el manuscrito por capítulos.");
  if(!names.length)return [];
  const alternatives=[...new Set(names.map(item=>item.value))].sort((a,b)=>b.length-a.length)
    .map(escapeRegExp).join("|");
  const boundaryStart="(?<![\\p{L}\\p{M}\\p{N}_])";
  const boundaryEnd="(?![\\p{L}\\p{M}\\p{N}_])";
  const actor="(?<actor>"+boundaryStart+"(?:"+alternatives+")"+boundaryEnd+")";
  const recipient="(?<recipient>"+boundaryStart+"(?:"+alternatives+")"+boundaryEnd+")";
  const patterns:readonly {signal:NarrativeInformationConcealmentSignal;expression:RegExp}[]=[
    {signal:"concealed-proposition",expression:new RegExp(actor+"\\s+(?<trigger>ocult[oó]|escondi[oó]|call[oó]|silenci[oó]|mantuvo\\s+en\\s+secreto|guard[oó]\\s+en\\s+secreto)\\s+(?:(?:a|ante)\\s+"+recipient+"\\s+)?que\\s+(?<proposition>[^.!?;\\n]{1,500})","giu")},
    {signal:"lied-to-recipient",expression:new RegExp(actor+"\\s+(?<trigger>minti[oó])\\s+a\\s+"+recipient+"\\s+(?<bridge>diciendo)\\s+que\\s+(?<proposition>[^.!?;\\n]{1,500})","giu")},
    {signal:"feigned-proposition",expression:new RegExp(actor+"\\s+(?<trigger>fingi[oó]|simul[oó])\\s+que\\s+(?<proposition>[^.!?;\\n]{1,500})","giu")},
    {signal:"induced-belief",expression:new RegExp(actor+"\\s+(?<trigger>hizo)\\s+creer\\s+a\\s+"+recipient+"\\s+que\\s+(?<proposition>[^.!?;\\n]{1,500})","giu")}
  ];
  const output:NarrativeInformationConcealmentCandidate[]=[],seen=new Set<string>();
  for(const span of sentenceSpans(input.text)) {
    const sentence=input.text.slice(span.start,span.end);
    for(const pattern of patterns) {
      pattern.expression.lastIndex=0;
      for(const match of sentence.matchAll(pattern.expression)) {
        const groups=match.groups!;
        const actorRaw=groups.actor!,actorId=resolveName(actorRaw,names);
        const recipientRaw=groups.recipient;
        const recipientId=recipientRaw?resolveName(recipientRaw,names):undefined;
        if(!actorId|| (recipientRaw&&!recipientId) || (recipientId===actorId))continue;
        const proposition=groups.proposition!.trim();
        if(!proposition||proposition.length>MAX_NARRATIVE_INFORMATION_CONCEALMENT_PROPOSITION_UNITS)continue;
        const actorLocal=match.index!+match[0].indexOf(actorRaw);
        const triggerRaw=groups.trigger!;
        const triggerLocal=match.index!+match[0].indexOf(triggerRaw,actorLocal+actorRaw.length);
        const propositionRaw=groups.proposition!;
        const propositionLocal=match.index!+match[0].lastIndexOf(propositionRaw);
        const recipientLocal=recipientRaw?match.index!+match[0].indexOf(recipientRaw,actorLocal+actorRaw.length):undefined;
        const leading=propositionRaw.length-propositionRaw.trimStart().length;
        const propositionStart=span.start+propositionLocal+leading;
        const actorStart=span.start+actorLocal,triggerStart=span.start+triggerLocal;
        const recipientStart=recipientLocal===undefined?undefined:span.start+recipientLocal;
        const key=[pattern.signal,actorId,recipientId??"",triggerStart].join(":");
        if(seen.has(key))continue;
        seen.add(key);
        if(output.length>=MAX_NARRATIVE_INFORMATION_CONCEALMENT_CANDIDATES)
          throw new Error("La extracción supera el límite de candidatos; divide el manuscrito.");
        output.push({
          id:"information-concealment:"+input.documentId+":"+input.revision+":"+triggerStart+":"+pattern.signal,
          projectId:input.projectId,documentId:input.documentId,revision:input.revision,
          signal:pattern.signal,actorEntityId:actorId,
          ...(recipientId?{recipientEntityId:recipientId}:{}),
          propositionEvidence:evidence(input,propositionStart,propositionStart+proposition.length),
          actorEvidence:evidence(input,actorStart,actorStart+actorRaw.length),
          triggerEvidence:evidence(input,triggerStart,triggerStart+triggerRaw.length),
          evidence:evidence(input,span.start,span.end),
          ...(recipientId&&recipientStart!==undefined?{recipientEvidence:evidence(input,recipientStart,recipientStart+recipientRaw!.length)}:{}),
          assertionStatus:"textually-asserted",
          polarity:/\b(?:no|nunca|jam[aá]s)\s+[^.!?;]*$/iu.test(sentence.slice(0,triggerStart-span.start))?"negated":"affirmed",
          deceptionEstablished:false,intentEstablished:false,
          reviewStatus:"candidate"
        });
      }
    }
  }
  return output.sort((a,b)=>a.evidence.start-b.evidence.start||a.triggerEvidence.start-b.triggerEvidence.start||a.id.localeCompare(b.id));
}
