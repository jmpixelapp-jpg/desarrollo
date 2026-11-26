/**
 * Auditoría por dominio de la cobertura de extracción.
 * Los huecos indican ausencia de evidencia registrada, nunca ausencia de contenido.
 */
import type { TextEvidence } from "./narrative-knowledge";
export const MAX_NARRATIVE_DOMAIN_AUDIT_TEXT_UNITS=2_000_000;
export const MAX_NARRATIVE_DOMAIN_AUDIT_SENTENCES=100_000;
export const MAX_NARRATIVE_DOMAIN_AUDIT_EVIDENCE_PER_DOMAIN=50_000;
export const MAX_NARRATIVE_DOMAIN_AUDIT_GAPS_PER_DOMAIN=1_000;
export type NarrativeExtractionDomain="actions"|"events"|"character-knowledge"|"information-reception"|"information-concealment"|"character-state"|"relationships"|"locations"|"objects";
export interface NarrativeDomainEvidence {readonly evidence:TextEvidence;}
export interface NarrativeDomainGap {
 readonly id:string;readonly domain:NarrativeExtractionDomain;readonly evidence:TextEvidence;
 readonly reason:"no-evidence-overlap";readonly reviewStatus:"unreviewed";
}
export interface NarrativeDomainCoverage {
 readonly domain:NarrativeExtractionDomain;readonly sentenceCount:number;readonly coveredSentences:number;
 readonly uncoveredSentences:number;readonly coverageRatio:number;
 readonly gaps:readonly NarrativeDomainGap[];readonly omittedGaps:number;readonly truncated:boolean;
}
export interface NarrativeDomainAuditInput {
 readonly documentId:string;readonly revision:number;readonly text:string;readonly baseOffset?:number;
 readonly evidenceByDomain:Readonly<Partial<Record<NarrativeExtractionDomain,readonly NarrativeDomainEvidence[]>>>;
}
export interface NarrativeDomainAudit {
 readonly documentId:string;readonly revision:number;readonly sourceLength:number;
 readonly domains:readonly NarrativeDomainCoverage[];
 readonly interpretation:"evidence-coverage-not-semantic-completeness";
}
const DOMAINS:readonly NarrativeExtractionDomain[]=["actions","events","character-knowledge","information-reception","information-concealment","character-state","relationships","locations","objects"];
interface Span{start:number;end:number;}
function spans(text:string):Span[]{
 const result:Span[]=[];let start=0;
 const add=(end:number)=>{let a=start,b=end;while(a<b&&/\s/u.test(text[a]!))a++;while(b>a&&/\s/u.test(text[b-1]!))b--;
 if(b>a&&/[\p{L}\p{N}]/u.test(text.slice(a,b)))result.push({start:a,end:b});};
 for(let i=0;i<text.length;i++){if(".!?\n\r".includes(text[i]!)){if(".!?".includes(text[i]!)){let end=i+1;while(end<text.length&&/[.!?]/u.test(text[end]!))end++;add(end);i=end-1;start=end;}else{add(i);start=i+1;}}}
 add(text.length);return result;
}
function validate(input:NarrativeDomainAuditInput):void{
 if(!input||typeof input!=="object"||typeof input.documentId!=="string"||!input.documentId.trim()||
 !Number.isSafeInteger(input.revision)||input.revision<0||typeof input.text!=="string"||
 input.text.length>MAX_NARRATIVE_DOMAIN_AUDIT_TEXT_UNITS||!input.evidenceByDomain||
 typeof input.evidenceByDomain!=="object"||
 (input.baseOffset!==undefined&&(!Number.isSafeInteger(input.baseOffset)||input.baseOffset<0||
 input.baseOffset>Number.MAX_SAFE_INTEGER-input.text.length)))throw new Error("Contexto inválido para auditar cobertura por dominio.");
 const base=input.baseOffset??0;
 for(const [domain,items] of Object.entries(input.evidenceByDomain)){
  if(!DOMAINS.includes(domain as NarrativeExtractionDomain)||!Array.isArray(items)||
  items.length>MAX_NARRATIVE_DOMAIN_AUDIT_EVIDENCE_PER_DOMAIN)throw new Error("Dominio o volumen de evidencias inválido.");
  for(const item of items){const e=item?.evidence;
   if(!e||e.documentId!==input.documentId||e.revision!==input.revision||
   !Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<base||
   e.end<=e.start||e.end>base+input.text.length||typeof e.excerpt!=="string"||
   e.end-e.start!==e.excerpt.length||e.status==="stale"||
   input.text.slice(e.start-base,e.end-base)!==e.excerpt)
   throw new Error("Evidencia ajena, obsoleta o que no coincide con el manuscrito.");
  }
 }
}
export function auditNarrativeExtractionByDomain(input:NarrativeDomainAuditInput):NarrativeDomainAudit{
 validate(input);const base=input.baseOffset??0;const sentenceSpans=spans(input.text);
 if(sentenceSpans.length>MAX_NARRATIVE_DOMAIN_AUDIT_SENTENCES)throw new Error("El documento supera el límite de segmentos; divídelo por capítulos.");
 const domains=DOMAINS.map(domain=>{
  const source=input.evidenceByDomain[domain]??[];
  const ordered=[...source].map(x=>x.evidence).sort((a,b)=>a.start-b.start||a.end-b.end);
  const gaps:NarrativeDomainGap[]=[];let covered=0,omitted=0,cursor=0;
  for(const span of sentenceSpans){const start=base+span.start,end=base+span.end;
   while(cursor<ordered.length&&ordered[cursor]!.end<=start)cursor++;
   const item=ordered[cursor];if(item&&item.start<end&&item.end>start){covered++;continue;}
   if(gaps.length<MAX_NARRATIVE_DOMAIN_AUDIT_GAPS_PER_DOMAIN)gaps.push({
    id:"domain-gap:"+domain+":"+input.documentId+":"+input.revision+":"+start,domain,
    evidence:{documentId:input.documentId,revision:input.revision,start,end,excerpt:input.text.slice(span.start,span.end)},
    reason:"no-evidence-overlap",reviewStatus:"unreviewed"
   });else omitted++;
  }
  return {domain,sentenceCount:sentenceSpans.length,coveredSentences:covered,
   uncoveredSentences:sentenceSpans.length-covered,coverageRatio:sentenceSpans.length?covered/sentenceSpans.length:1,
   gaps,omittedGaps:omitted,truncated:omitted>0};
 });
 return {documentId:input.documentId,revision:input.revision,sourceLength:input.text.length,domains,
 interpretation:"evidence-coverage-not-semantic-completeness"};
}
