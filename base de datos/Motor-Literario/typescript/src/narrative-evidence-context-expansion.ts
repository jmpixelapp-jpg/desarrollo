/**
 * Recupera contexto discursivo contiguo alrededor de evidencias ya extraídas.
 * No fusiona proposiciones ni atribuye correferencia, causalidad o cronología diegética.
 */
import type { TextEvidence } from "./narrative-knowledge";
export interface NarrativeEvidenceAnchor {
 readonly id:string;readonly kind:string;readonly evidence:TextEvidence;
 readonly entityIds?:readonly string[];
}
export interface NarrativeEvidenceContextInput {
 readonly projectId:string;readonly documentId:string;readonly revision:number;readonly text:string;
 readonly anchors:readonly NarrativeEvidenceAnchor[];readonly baseOffset?:number;
 readonly sentencesBefore?:number;readonly sentencesAfter?:number;readonly maxContextUnits?:number;
}
export interface NarrativeEvidenceContextCandidate {
 readonly id:string;readonly projectId:string;readonly documentId:string;readonly revision:number;
 readonly anchorId:string;readonly anchorKind:string;readonly anchorEvidence:TextEvidence;
 readonly precedingContext:readonly TextEvidence[];readonly followingContext:readonly TextEvidence[];
 readonly contextStart:number;readonly contextEnd:number;readonly contextExcerpt:string;
 readonly contextCompleteness:"bounded-by-request"|"document-boundary"|"paragraph-boundary"|"unit-budget";
 readonly entityIds:readonly string[];readonly interpretation:"context-only-no-semantic-link-inferred";
 readonly reviewStatus:"candidate";
}
export const DEFAULT_NARRATIVE_EVIDENCE_CONTEXT_SENTENCES=1;
export const MAX_NARRATIVE_EVIDENCE_CONTEXT_SENTENCES=5;
export const DEFAULT_NARRATIVE_EVIDENCE_CONTEXT_UNITS=5_000;
export const MAX_NARRATIVE_EVIDENCE_CONTEXT_UNITS=20_000;
export const MAX_NARRATIVE_EVIDENCE_CONTEXT_TEXT_UNITS=2_000_000;
export const MAX_NARRATIVE_EVIDENCE_CONTEXT_ANCHORS=10_000;
interface Span{start:number;end:number;}
function sentenceSpans(text:string):Span[]{
 const out:Span[]=[];let start=0;
 const add=(end:number)=>{let a=start,b=end;while(a<b&&/\s/u.test(text[a]!))a++;while(b>a&&/\s/u.test(text[b-1]!))b--;if(b>a)out.push({start:a,end:b});};
 for(let i=0;i<text.length;i++){
  if(".!?".includes(text[i]!)){let end=i+1;while(end<text.length&&/[.!?]/u.test(text[end]!))end++;add(end);i=end-1;start=end;}
  else if(text[i]==="\n"||text[i]==="\r"){add(i);if(text[i]==="\r"&&text[i+1]==="\n")i++;start=i+1;}
 }
 add(text.length);return out;
}
function paragraphBreak(text:string,a:number,b:number):boolean{return /(?:\r?\n)[\t ]*(?:\r?\n)/u.test(text.slice(a,b));}
function evidence(input:NarrativeEvidenceContextInput,span:Span,base:number):TextEvidence{
 return {documentId:input.documentId,revision:input.revision,start:base+span.start,end:base+span.end,excerpt:input.text.slice(span.start,span.end)};
}
export function expandNarrativeEvidenceContext(input:NarrativeEvidenceContextInput):readonly NarrativeEvidenceContextCandidate[]{
 const before=input?.sentencesBefore??DEFAULT_NARRATIVE_EVIDENCE_CONTEXT_SENTENCES;
 const after=input?.sentencesAfter??DEFAULT_NARRATIVE_EVIDENCE_CONTEXT_SENTENCES;
 const budget=input?.maxContextUnits??DEFAULT_NARRATIVE_EVIDENCE_CONTEXT_UNITS;
 if(!input||typeof input!=="object"||typeof input.projectId!=="string"||!input.projectId.trim()||
  typeof input.documentId!=="string"||!input.documentId.trim()||!Number.isSafeInteger(input.revision)||input.revision<0||
  typeof input.text!=="string"||input.text.length>MAX_NARRATIVE_EVIDENCE_CONTEXT_TEXT_UNITS||
  !Array.isArray(input.anchors)||input.anchors.length>MAX_NARRATIVE_EVIDENCE_CONTEXT_ANCHORS||
  !Number.isSafeInteger(before)||before<0||before>MAX_NARRATIVE_EVIDENCE_CONTEXT_SENTENCES||
  !Number.isSafeInteger(after)||after<0||after>MAX_NARRATIVE_EVIDENCE_CONTEXT_SENTENCES||
  !Number.isSafeInteger(budget)||budget<1||budget>MAX_NARRATIVE_EVIDENCE_CONTEXT_UNITS||
  (input.baseOffset!==undefined&&(!Number.isSafeInteger(input.baseOffset)||input.baseOffset<0||
   input.baseOffset>Number.MAX_SAFE_INTEGER-input.text.length)))throw new Error("Entrada inválida para ampliar contexto probatorio.");
 const base=input.baseOffset??0,spans=sentenceSpans(input.text),seen=new Set<string>();
 for(const a of input.anchors){
  if(!a||typeof a.id!=="string"||!a.id.trim()||seen.has(a.id)||typeof a.kind!=="string"||!a.kind.trim()||
   !a.evidence||a.evidence.documentId!==input.documentId||a.evidence.revision!==input.revision||
   !Number.isSafeInteger(a.evidence.start)||!Number.isSafeInteger(a.evidence.end)||
   a.evidence.start<base||a.evidence.end<=a.evidence.start||a.evidence.end>base+input.text.length||
   typeof a.evidence.excerpt!=="string"||a.evidence.end-a.evidence.start!==a.evidence.excerpt.length||
   input.text.slice(a.evidence.start-base,a.evidence.end-base)!==a.evidence.excerpt||
   (a.entityIds!==undefined&&(!Array.isArray(a.entityIds)||a.entityIds.some(x=>typeof x!=="string"||!x.trim()))))
   throw new Error("Ancla duplicada o evidencia incompatible con el texto fuente.");
  seen.add(a.id);
 }
 const output:NarrativeEvidenceContextCandidate[]=[];
 for(const anchor of input.anchors){
  const localStart=anchor.evidence.start-base,localEnd=anchor.evidence.end-base;
  const first=spans.findIndex(s=>s.start<localEnd&&s.end>localStart);
  if(first<0)throw new Error("La evidencia no coincide con ningún segmento discursivo.");
  let last=first;for(let i=first;i<spans.length;i++){if(spans[i]!.start<localEnd&&spans[i]!.end>localStart)last=i;}
  let left=first,right=last,used=0,completeness:"bounded-by-request"|"document-boundary"|"paragraph-boundary"|"unit-budget"="bounded-by-request";
  for(let step=0;step<before&&left>0;step++){
   const candidate=spans[left-1]!;
   if(paragraphBreak(input.text,candidate.end,spans[left]!.start)){completeness="paragraph-boundary";break;}
   const size=spans[left]!.end-candidate.start;
   if(used+size>budget){completeness="unit-budget";break;}
   used+=size;left--;
  }
  if(left===0&&before>first)completeness="document-boundary";
  for(let step=0;step<after&&right+1<spans.length;step++){
   const candidate=spans[right+1]!;
   if(paragraphBreak(input.text,spans[right]!.end,candidate.start)){completeness="paragraph-boundary";break;}
   const size=candidate.end-spans[right]!.start;
   if(used+size>budget){completeness="unit-budget";break;}
   used+=size;right++;
  }
  if(right===spans.length-1&&after>spans.length-1-last)completeness="document-boundary";
  const selected=spans.slice(left,right+1),start=selected[0]!.start,end=selected[selected.length-1]!.end;
  const preceding=spans.slice(left,first).map(s=>evidence(input,s,base));
  const following=spans.slice(last+1,right+1).map(s=>evidence(input,s,base));
  output.push({id:"evidence-context:"+input.documentId+":"+input.revision+":"+anchor.id,
   projectId:input.projectId,documentId:input.documentId,revision:input.revision,anchorId:anchor.id,anchorKind:anchor.kind,
   anchorEvidence:anchor.evidence,precedingContext:preceding,followingContext:following,
   contextStart:base+start,contextEnd:base+end,contextExcerpt:input.text.slice(start,end),
   contextCompleteness:completeness,entityIds:[...(anchor.entityIds??[])],
   interpretation:"context-only-no-semantic-link-inferred",reviewStatus:"candidate"});
 }
 return output;
}
