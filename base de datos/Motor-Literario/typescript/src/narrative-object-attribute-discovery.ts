/**
 * Extrae atributos físicos expresados literalmente junto a menciones de objetos.
 * Los atributos son observaciones textuales candidatas, no propiedades permanentes.
 */
import type {NarrativeEntity,TextEvidence} from "./narrative-knowledge";
export type NarrativeObjectAttributeKind="color"|"material"|"condition"|"shape"|"size";
export interface NarrativeObjectAttributeCandidate{
 readonly id:string;readonly projectId:string;readonly documentId:string;readonly revision:number;
 readonly objectEntityId:string;readonly attributeKind:NarrativeObjectAttributeKind;
 readonly value:string;readonly normalizedValue:string;
 readonly objectEvidence:TextEvidence;readonly attributeEvidence:TextEvidence;
 readonly contextEvidence:TextEvidence;readonly polarity:"affirmed"|"negated";
 readonly reviewStatus:"candidate";readonly persistence:"not-established";
}
export interface NarrativeObjectAttributeDiscoveryInput{
 readonly projectId:string;readonly documentId:string;readonly revision:number;readonly text:string;
 readonly entities:readonly NarrativeEntity[];readonly baseOffset?:number;readonly maxCandidates?:number;
}
export const MAX_OBJECT_ATTRIBUTE_TEXT_UNITS=2_000_000;
export const MAX_OBJECT_ATTRIBUTE_ENTITIES=5_000;
export const MAX_OBJECT_ATTRIBUTE_ALIASES=100;
export const MAX_OBJECT_ATTRIBUTE_NAME_LENGTH=256;
export const MAX_OBJECT_ATTRIBUTE_SCAN_UNITS=25_000_000;
export const MAX_OBJECT_ATTRIBUTE_CANDIDATES=5_000;
const LEXICON:Readonly<Record<NarrativeObjectAttributeKind,readonly string[]>>={
 color:["rojo","roja","rojizo","rojiza","azul","azulada","azulado","verde","verdosa","verdoso","negro","negra","blanco","blanca","dorado","dorada","plateado","plateada","gris","marrón","moreno","morena"],
 material:["oro","plata","hierro","acero","bronce","madera","cuero","piedra","cristal","vidrio","marfil","hueso"],
 condition:["roto","rota","rotos","rotas","intacto","intacta","intactos","intactas","dañado","dañada","gastado","gastada","desgastado","desgastada","oxidado","oxidada","limpio","limpia","sucio","sucia","abierto","abierta","cerrado","cerrada"],
 shape:["redondo","redonda","circular","cuadrado","cuadrada","ovalado","ovalada","rectangular","curvo","curva","plano","plana","afilado","afilada"],
 size:["pequeño","pequeña","pequeños","pequeñas","grande","grandes","enorme","enormes","diminuto","diminuta","largo","larga","corto","corta","ancho","ancha","estrecho","estrecha"]
};
function norm(s:string):string{return s.normalize("NFC").toLocaleLowerCase("es").trim().replace(/\s+/gu," ");}
function esc(s:string):string{return s.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&");}
function valid(e:TextEvidence,doc:string,rev:number):boolean{return !!e&&e.documentId===doc&&e.revision===rev&&Number.isSafeInteger(e.start)&&e.start>=0&&Number.isSafeInteger(e.end)&&e.end>e.start&&typeof e.excerpt==="string"&&e.excerpt.length===e.end-e.start&&e.status!=="stale";}
export function discoverNarrativeObjectAttributeCandidates(input:NarrativeObjectAttributeDiscoveryInput):readonly NarrativeObjectAttributeCandidate[]{
 const max=input?.maxCandidates??MAX_OBJECT_ATTRIBUTE_CANDIDATES;
 if(!input||typeof input!=="object"||typeof input.projectId!=="string"||!input.projectId.trim()||typeof input.documentId!=="string"||!input.documentId.trim()||!Number.isSafeInteger(input.revision)||input.revision<0||typeof input.text!=="string"||input.text.length>MAX_OBJECT_ATTRIBUTE_TEXT_UNITS||!Array.isArray(input.entities)||input.entities.length>MAX_OBJECT_ATTRIBUTE_ENTITIES||!Number.isSafeInteger(max)||max<1||max>MAX_OBJECT_ATTRIBUTE_CANDIDATES||(input.baseOffset!==undefined&&(!Number.isSafeInteger(input.baseOffset)||input.baseOffset<0||input.baseOffset>Number.MAX_SAFE_INTEGER-input.text.length)))throw new Error("Entrada inválida para extraer atributos de objetos.");
 const base=input.baseOffset??0,seen=new Set<string>(),out:NarrativeObjectAttributeCandidate[]=[];let scan=0;
 for(const entity of input.entities){
  if(!entity||entity.projectId!==input.projectId||entity.kind!=="object"||typeof entity.id!=="string"||!entity.id.trim()||seen.has(entity.id)||typeof entity.canonicalName!=="string"||!entity.canonicalName.trim()||!Array.isArray(entity.aliases)||entity.aliases.length>MAX_OBJECT_ATTRIBUTE_ALIASES)throw new Error("Se requieren fichas de objetos únicas y válidas del proyecto.");
  seen.add(entity.id);
  const names=[entity.canonicalName,...entity.aliases].filter((n):n is string=>typeof n==="string"&&!!n.trim()&&n.length<=MAX_OBJECT_ATTRIBUTE_NAME_LENGTH);
  for(const name of new Set(names.map(norm))){
   const spelling=names.find(n=>norm(n)===name)!;
   const objectPattern=esc(spelling);
   for(const kind of Object.keys(LEXICON) as NarrativeObjectAttributeKind[])for(const value of LEXICON[kind]){
    const v=esc(value);
    const patterns=[
     new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])("+objectPattern+")(?![\\p{L}\\p{M}\\p{N}_])\\s+(?:(?:de|del)\\s+)?("+v+")(?![\\p{L}\\p{M}\\p{N}_])","giu"),
     new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])("+objectPattern+")(?![\\p{L}\\p{M}\\p{N}_])\\s+(?:de\\s+)?("+v+")(?![\\p{L}\\p{M}\\p{N}_])","giu"),
     new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])("+v+")(?![\\p{L}\\p{M}\\p{N}_])\\s+("+objectPattern+")(?![\\p{L}\\p{M}\\p{N}_])","giu")
    ];
    if(kind==="material") patterns.push(new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])("+objectPattern+")(?![\\p{L}\\p{M}\\p{N}_])(?:\\s+[\\p{L}\\p{M}]+){0,3}\\s+de\\s+("+v+")(?![\\p{L}\\p{M}\\p{N}_])","giu"));
    for(const re of patterns){
     scan+=input.text.length;if(scan>MAX_OBJECT_ATTRIBUTE_SCAN_UNITS)throw new Error("Presupuesto de exploración de atributos excedido.");
     for(const m of input.text.matchAll(re)){
      const start=m.index!,whole=m[0],obj=m[1]!,attr=m[2]!,objRel=whole.indexOf(obj),attrRel=whole.lastIndexOf(attr);
      const objectStart=start+objRel,attributeStart=start+attrRel;
      const negated=/(?:no|nunca|jamás)\s+$/iu.test(input.text.slice(Math.max(0,start-12),start));
      const contextStart=Math.max(0,start-45),contextEnd=Math.min(input.text.length,start+whole.length+45);
      const id="object-attribute:"+entity.id+":"+kind+":"+attributeStart;
      if(out.some(x=>x.id===id))continue;
      out.push({id,projectId:input.projectId,documentId:input.documentId,revision:input.revision,objectEntityId:entity.id,attributeKind:kind,value:attr,normalizedValue:norm(attr),objectEvidence:{documentId:input.documentId,revision:input.revision,start:base+objectStart,end:base+objectStart+obj.length,excerpt:obj},attributeEvidence:{documentId:input.documentId,revision:input.revision,start:base+attributeStart,end:base+attributeStart+attr.length,excerpt:attr},contextEvidence:{documentId:input.documentId,revision:input.revision,start:base+contextStart,end:base+contextEnd,excerpt:input.text.slice(contextStart,contextEnd)},polarity:negated?"negated":"affirmed",reviewStatus:"candidate",persistence:"not-established"});
      if(out.length>=max)return out;
     }
    }
   }
  }
 }
 return out.sort((a,b)=>a.attributeEvidence.start-b.attributeEvidence.start||a.objectEntityId.localeCompare(b.objectEntityId));
}
