/**
 * Extracción de conocimiento en oraciones con pronombre inicial.
 * Solo atribuye titular cuando el resolver previo ofrece un único antecedente
 * tipado como personaje; no convierte proximidad en correferencia demostrada.
 */
import type { NarrativeCharacterKnowledgeCandidate } from "./narrative-character-knowledge-discovery";
import type { NarrativePronounReferenceCandidate } from "./narrative-pronoun-reference-discovery";
import type { TextEvidence } from "./narrative-knowledge";
export const MAX_PRONOUN_KNOWLEDGE_TEXT_UNITS=2_000_000;
export const MAX_PRONOUN_KNOWLEDGE_REFERENCES=2_000;
export const MAX_PRONOUN_KNOWLEDGE_CANDIDATES=500;
export const MAX_PRONOUN_KNOWLEDGE_PROPOSITION_UNITS=500;
export interface NarrativePronounKnowledgeDiscoveryInput {
 readonly projectId:string;readonly documentId:string;readonly revision:number;readonly text:string;
 readonly baseOffset?:number;readonly pronounReferences:readonly NarrativePronounReferenceCandidate[];
}
interface Signal {
 kind:NarrativeCharacterKnowledgeCandidate["kind"];
 mode:NarrativeCharacterKnowledgeCandidate["mode"];
 certainty:NarrativeCharacterKnowledgeCandidate["certainty"];
 pattern:RegExp;
}
const SIGNALS:readonly Signal[]=[
 {kind:"known",mode:"asserted-cognition",certainty:"explicit-claim",pattern:/(?<trigger>sab[ií]a|sabe|saben)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu},
 {kind:"believed",mode:"uncertain-cognition",certainty:"uncertain-claim",pattern:/(?<trigger>crey[oó]|cre[ií]a|pens[oó]|pensaba|supuso|supon[ií]a)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu},
 {kind:"suspected",mode:"uncertain-cognition",certainty:"uncertain-claim",pattern:/(?<trigger>sospech[oó]|sospechaba|intuy[oó]|intu[ií]a)\s+(?:que|de\s+que)\s+(?<proposition>[^.!?;\n]{1,500})/giu},
 {kind:"remembered",mode:"asserted-cognition",certainty:"explicit-claim",pattern:/(?<trigger>record[oó]|recordaba|rememor[oó]|rememoraba)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu},
 {kind:"forgotten",mode:"asserted-cognition",certainty:"explicit-claim",pattern:/(?<trigger>olvid[oó]|olvidaba|no\s+recordaba)\s+que\s+(?<proposition>[^.!?;\n]{1,500})/giu}
];
interface Span{start:number;end:number;}
function sentenceSpans(text:string):Span[]{
 const out:Span[]=[];let start=0;
 const add=(end:number)=>{let a=start,b=end;while(a<b&&/\s/u.test(text[a]!))a++;while(b>a&&/\s/u.test(text[b-1]!))b--;if(b>a)out.push({start:a,end:b});};
 for(let i=0;i<text.length;i++){if(".!?\n\r".includes(text[i]!)){if(".!?".includes(text[i]!)){let e=i+1;while(e<text.length&&/[.!?]/u.test(text[e]!))e++;add(e);i=e-1;start=e;}else{add(i);start=i+1;}}}add(text.length);return out;
}
function validEvidence(e:TextEvidence,doc:string,rev:number,base:number,length:number):boolean{
 return !!e&&e.documentId===doc&&e.revision===rev&&Number.isSafeInteger(e.start)&&Number.isSafeInteger(e.end)&&
 e.start>=base&&e.end>e.start&&e.end<=base+length&&typeof e.excerpt==="string"&&
 e.end-e.start===e.excerpt.length&&e.status!=="stale";
}
export function discoverNarrativePronounKnowledgeCandidates(input:NarrativePronounKnowledgeDiscoveryInput):readonly NarrativeCharacterKnowledgeCandidate[]{
 if(!input||typeof input!=="object"||typeof input.projectId!=="string"||!input.projectId.trim()||
 typeof input.documentId!=="string"||!input.documentId.trim()||!Number.isSafeInteger(input.revision)||input.revision<0||
 typeof input.text!=="string"||input.text.length>MAX_PRONOUN_KNOWLEDGE_TEXT_UNITS||
 !Array.isArray(input.pronounReferences)||input.pronounReferences.length>MAX_PRONOUN_KNOWLEDGE_REFERENCES||
 (input.baseOffset!==undefined&&(!Number.isSafeInteger(input.baseOffset)||input.baseOffset<0||
 input.baseOffset>Number.MAX_SAFE_INTEGER-input.text.length)))throw new Error("Entrada inválida para conocimiento con sujeto pronominal.");
 const base=input.baseOffset??0,spans=sentenceSpans(input.text),out:NarrativeCharacterKnowledgeCandidate[]=[];
 const byPosition=new Map(input.pronounReferences.map(x=>[x.pronounEvidence.start,x]));
 for(const ref of input.pronounReferences){
  if(!ref||ref.projectId!==input.projectId||ref.documentId!==input.documentId||ref.revision!==input.revision||
  !validEvidence(ref.pronounEvidence,input.documentId,input.revision,base,input.text.length)||
  input.text.slice(ref.pronounEvidence.start-base,ref.pronounEvidence.end-base)!==ref.pronounEvidence.excerpt||
  !Array.isArray(ref.antecedentCandidates))throw new Error("Referencia pronominal ajena o inconsistente.");
  for(const ant of ref.antecedentCandidates)if(!validEvidence(ant.antecedentEvidence,input.documentId,input.revision,base,input.text.length)||
   input.text.slice(ant.antecedentEvidence.start-base,ant.antecedentEvidence.end-base)!==ant.antecedentEvidence.excerpt)
   throw new Error("Evidencia de antecedente inválida.");
 }
 for(const span of spans){
  const absolute=base+span.start,ref=byPosition.get(absolute);
  if(!ref||ref.status!=="single-candidate"||ref.antecedentCandidates.length!==1||
   ref.antecedentCandidates[0]!.entityKind!=="character")continue;
  const sentence=input.text.slice(span.start,span.end);
  for(const signal of SIGNALS){signal.pattern.lastIndex=0;
   for(const m of sentence.matchAll(signal.pattern)){
    const trigger=m.groups!.trigger!,raw=m.groups!.proposition!,proposition=raw.trim();
    if(!proposition||proposition.length>MAX_PRONOUN_KNOWLEDGE_PROPOSITION_UNITS)continue;
    const triggerLocal=m.index!+m[0].indexOf(trigger),propLocal=m.index!+m[0].indexOf(raw)+(raw.length-raw.trimStart().length);
    const start=span.start+propLocal,triggerStart=span.start+triggerLocal;
    const negated=/(?:\bno\s+|\bnunca\s+|\bjam[aá]s\s+)$/iu.test(sentence.slice(0,triggerLocal));
    const ev=(a:number,b:number):TextEvidence=>({documentId:input.documentId,revision:input.revision,start:base+a,end:base+b,excerpt:input.text.slice(a,b)});
    const antecedent=ref.antecedentCandidates[0]!;
    out.push({id:"pronoun-knowledge:"+input.documentId+":"+input.revision+":"+triggerStart+":"+signal.kind,
     projectId:input.projectId,documentId:input.documentId,revision:input.revision,kind:signal.kind,mode:signal.mode,
     holderEntityId:antecedent.entityId,propositionEvidence:ev(start,start+proposition.length),
     holderEvidence:ref.pronounEvidence,triggerEvidence:ev(triggerStart,triggerStart+trigger.length),
     evidence:ev(span.start,span.end),polarity:negated?"negated":"affirmed",certainty:signal.certainty,reviewStatus:"candidate"});
    if(out.length>MAX_PRONOUN_KNOWLEDGE_CANDIDATES)throw new Error("La extracción pronominal supera el límite de candidatos; divide el manuscrito.");
   }
  }
 }
 return out.sort((a,b)=>a.evidence.start-b.evidence.start||a.triggerEvidence.start-b.triggerEvidence.start);
}
