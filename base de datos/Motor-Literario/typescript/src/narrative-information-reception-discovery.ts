/**
 * Detecta recepción y procesamiento explícitos de información por personajes.
 * Contacto, comprensión, aceptación y malentendido son dimensiones distintas:
 * ninguna se deduce automáticamente de las otras.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

export type NarrativeInformationReceptionStage =
  | "exposure" | "comprehension" | "acceptance" | "misunderstanding";

export type NarrativeInformationReceptionSignal =
  | "heard-proposition" | "listened-to-proposition" | "read-proposition"
  | "received-reported-information" | "understood-proposition"
  | "comprehended-proposition" | "failed-to-understand-proposition"
  | "believed-proposition" | "accepted-proposition"
  | "misinterpreted-proposition";

export interface NarrativeInformationReceptionCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly characterEntityId: string;
  readonly stage: NarrativeInformationReceptionStage;
  readonly signal: NarrativeInformationReceptionSignal;
  readonly propositionEvidence: TextEvidence;
  readonly characterEvidence: TextEvidence;
  readonly triggerEvidence: TextEvidence;
  readonly evidence: TextEvidence;
  readonly polarity: "affirmed" | "negated";
  readonly interpretation:
    | "contact-does-not-establish-comprehension"
    | "comprehension-does-not-establish-acceptance"
    | "explicit-non-comprehension"
    | "explicit-belief-or-acceptance"
    | "explicit-misinterpretation";
  readonly comprehensionEstablished: boolean;
  readonly acceptanceEstablished: boolean;
  readonly reviewStatus: "candidate";
}

export interface NarrativeInformationReceptionInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
}

export const MAX_NARRATIVE_INFORMATION_RECEPTION_TEXT_UNITS = 2_000_000;
export const MAX_NARRATIVE_INFORMATION_RECEPTION_ENTITIES = 5_000;
export const MAX_NARRATIVE_INFORMATION_RECEPTION_ALIASES = 100;
export const MAX_NARRATIVE_INFORMATION_RECEPTION_NAME_UNITS = 256;
export const MAX_NARRATIVE_INFORMATION_RECEPTION_PROPOSITION_UNITS = 500;
export const MAX_NARRATIVE_INFORMATION_RECEPTION_SCAN_UNITS = 25_000_000;
export const MAX_NARRATIVE_INFORMATION_RECEPTION_CANDIDATES = 1_000;

interface Pattern {
  readonly stage: NarrativeInformationReceptionStage;
  readonly signal: NarrativeInformationReceptionSignal;
  readonly expression: RegExp;
  readonly interpretation: NarrativeInformationReceptionCandidate["interpretation"];
  readonly comprehension: boolean;
  readonly acceptance: boolean;
  readonly polarity: "affirmed" | "negated";
}

interface Span { readonly start: number; readonly end: number; }
interface Mention { readonly entityId: string; readonly start: number; readonly end: number; }

const PATTERNS: readonly Pattern[] = [
  {stage:"exposure",signal:"heard-proposition",expression:/(?<trigger>oy[oó]|o[ií]a|oyeron|escuch[oó]|escuchaba|escucharon)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu,interpretation:"contact-does-not-establish-comprehension",comprehension:false,acceptance:false,polarity:"affirmed"},
  {stage:"exposure",signal:"listened-to-proposition",expression:/(?<trigger>prest[oó]|prestaba)\s+atenci[oó]n\s+(?:a\s+)?(?:lo\s+que\s+)?(?:dec[ií]a|dijo)\s+(?<proposition>[^.!?;\n]{1,500})/giu,interpretation:"contact-does-not-establish-comprehension",comprehension:false,acceptance:false,polarity:"affirmed"},
  {stage:"exposure",signal:"read-proposition",expression:/(?<trigger>ley[oó]|le[ií]a|leyeron)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu,interpretation:"contact-does-not-establish-comprehension",comprehension:false,acceptance:false,polarity:"affirmed"},
  {stage:"exposure",signal:"received-reported-information",expression:/(?<trigger>recibi[oó]|recib[ií]a)\s+(?:la\s+)?(?:noticia|informaci[oó]n|confirmaci[oó]n)\s+de\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu,interpretation:"contact-does-not-establish-comprehension",comprehension:false,acceptance:false,polarity:"affirmed"},
  {stage:"comprehension",signal:"understood-proposition",expression:/(?<trigger>entendi[oó]|entend[ií]a)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu,interpretation:"comprehension-does-not-establish-acceptance",comprehension:true,acceptance:false,polarity:"affirmed"},
  {stage:"comprehension",signal:"comprehended-proposition",expression:/(?<trigger>comprendi[oó]|comprend[ií]a)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu,interpretation:"comprehension-does-not-establish-acceptance",comprehension:true,acceptance:false,polarity:"affirmed"},
  {stage:"comprehension",signal:"failed-to-understand-proposition",expression:/(?<trigger>no\s+entendi[oó]|no\s+entend[ií]a|no\s+comprendi[oó]|no\s+comprend[ií]a)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu,interpretation:"explicit-non-comprehension",comprehension:false,acceptance:false,polarity:"negated"},
  {stage:"acceptance",signal:"believed-proposition",expression:/(?<trigger>crey[oó]|cre[ií]a)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu,interpretation:"explicit-belief-or-acceptance",comprehension:false,acceptance:true,polarity:"affirmed"},
  {stage:"acceptance",signal:"accepted-proposition",expression:/(?<trigger>acept[oó]|aceptaba|admiti[oó]|admit[ií]a)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu,interpretation:"explicit-belief-or-acceptance",comprehension:false,acceptance:true,polarity:"affirmed"},
  {stage:"misunderstanding",signal:"misinterpreted-proposition",expression:/(?<trigger>interpret[oó]\s+err[oó]neamente|interpretaba\s+err[oó]neamente|malinterpret[oó]|malinterpretaba)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu,interpretation:"explicit-misinterpretation",comprehension:false,acceptance:false,polarity:"affirmed"}
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
function sentenceSpans(text: string): Span[] {
  const result: Span[] = [];
  for (const line of text.matchAll(/[^\n]+/gu)) {
    for (const match of line[0].matchAll(/[^.!?]+(?:[.!?]+|$)/gu)) {
      const leading = match[0].search(/\S/u);
      const length = match[0].trimEnd().length;
      if (leading >= 0 && length > leading) result.push({start:line.index!+match.index!+leading,end:line.index!+match.index!+length});
    }
  }
  return result;
}
function evidence(input: NarrativeInformationReceptionInput, start: number, end: number): TextEvidence {
  return {documentId:input.documentId,revision:input.revision,start:(input.baseOffset??0)+start,end:(input.baseOffset??0)+end,excerpt:input.text.slice(start,end)};
}
function validate(input: NarrativeInformationReceptionInput): void {
  if (!input || typeof input !== "object" || typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_NARRATIVE_INFORMATION_RECEPTION_TEXT_UNITS ||
      !Array.isArray(input.entities) || input.entities.length > MAX_NARRATIVE_INFORMATION_RECEPTION_ENTITIES ||
      (input.baseOffset !== undefined && (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
        input.baseOffset > Number.MAX_SAFE_INTEGER-input.text.length))) {
    throw new Error("Contexto inválido para descubrir recepción de información.");
  }
  const ids = new Set<string>();
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId || typeof entity.id !== "string" || !entity.id.trim() ||
        ids.has(entity.id) || typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        entity.canonicalName.length > MAX_NARRATIVE_INFORMATION_RECEPTION_NAME_UNITS ||
        !Array.isArray(entity.aliases) || entity.aliases.length > MAX_NARRATIVE_INFORMATION_RECEPTION_ALIASES ||
        entity.aliases.some(alias => typeof alias !== "string" || !alias.trim() || alias.length > MAX_NARRATIVE_INFORMATION_RECEPTION_NAME_UNITS)) {
      throw new Error("Entidades inválidas, duplicadas o ajenas al proyecto.");
    }
    ids.add(entity.id);
  }
}
function mentionsIn(sentence: string, absoluteStart: number, entities: readonly NarrativeEntity[]): Mention[] {
  const found: Mention[] = [];
  for (const entity of entities) if (entity.kind === "character") {
    for (const name of new Set([entity.canonicalName,...entity.aliases])) {
      const expression = new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])"+escapeRegExp(name)+"(?![\\p{L}\\p{M}\\p{N}_])","giu");
      for (const match of sentence.matchAll(expression)) found.push({entityId:entity.id,start:absoluteStart+match.index!,end:absoluteStart+match.index!+match[0].length});
    }
  }
  return found.sort((a,b)=>a.start-b.start||b.end-a.end);
}
function uniqueCharacter(mentions: readonly Mention[], start: number, end: number): Mention | undefined {
  const selected=mentions.filter(item=>item.start>=start&&item.end<=end);
  const ids=new Set(selected.map(item=>item.entityId));
  return ids.size===1&&selected.length?selected[0]:undefined;
}

/**
 * Solo atribuye la señal a un personaje nombrado antes del verbo cognitivo.
 * La evidencia de contacto nunca se eleva a comprensión ni aceptación.
 */
export function discoverNarrativeInformationReceptionCandidates(
  input: NarrativeInformationReceptionInput
): readonly NarrativeInformationReceptionCandidate[] {
  validate(input);
  const entities=input.entities.filter(entity=>entity.kind==="character");
  const spans=sentenceSpans(input.text);
  const names=entities.reduce((sum,entity)=>sum+1+entity.aliases.length,0);
  const cost=spans.reduce((sum,span)=>sum+(span.end-span.start)*names,0);
  if(!Number.isSafeInteger(cost)||cost>MAX_NARRATIVE_INFORMATION_RECEPTION_SCAN_UNITS)
    throw new Error("La búsqueda de recepción supera el presupuesto; divide el manuscrito por capítulos.");
  const output:NarrativeInformationReceptionCandidate[]=[];
  const seen=new Set<string>();
  for(const span of spans) {
    const sentence=input.text.slice(span.start,span.end);
    const mentions=mentionsIn(sentence,span.start,entities);
    if(!mentions.length) continue;
    for(const pattern of PATTERNS) {
      pattern.expression.lastIndex=0;
      for(const match of sentence.matchAll(pattern.expression)) {
        const trigger=match.groups!.trigger!, raw=match.groups!.proposition!;
        const localTrigger=match.index!+match[0].indexOf(trigger);
        const triggerStart=span.start+localTrigger;
        const character=uniqueCharacter(mentions,span.start,triggerStart);
        if(!character) continue;
        const proposition=raw.trim();
        if(!proposition||proposition.length>MAX_NARRATIVE_INFORMATION_RECEPTION_PROPOSITION_UNITS) continue;
        const rawLocal=match.index!+match[0].lastIndexOf(raw);
        const propositionStart=span.start+rawLocal+(raw.length-raw.trimStart().length);
        const key=[pattern.signal,character.entityId,triggerStart].join(":");
        if(seen.has(key)) continue;
        seen.add(key);
        if(output.length>=MAX_NARRATIVE_INFORMATION_RECEPTION_CANDIDATES)
          throw new Error("La extracción supera el límite de candidatos; divide el manuscrito por capítulos.");
        output.push({
          id:"information-reception:"+input.documentId+":"+input.revision+":"+triggerStart+":"+pattern.signal,
          projectId:input.projectId,documentId:input.documentId,revision:input.revision,
          characterEntityId:character.entityId,stage:pattern.stage,signal:pattern.signal,
          propositionEvidence:evidence(input,propositionStart,propositionStart+proposition.length),
          characterEvidence:evidence(input,character.start,character.end),
          triggerEvidence:evidence(input,triggerStart,triggerStart+trigger.length),
          evidence:evidence(input,span.start,span.end),polarity:pattern.polarity,
          interpretation:pattern.interpretation,comprehensionEstablished:pattern.comprehension,
          acceptanceEstablished:pattern.acceptance,reviewStatus:"candidate"
        });
      }
    }
  }
  return output.sort((a,b)=>a.evidence.start-b.evidence.start||a.triggerEvidence.start-b.triggerEvidence.start||a.characterEntityId.localeCompare(b.characterEntityId));
}
