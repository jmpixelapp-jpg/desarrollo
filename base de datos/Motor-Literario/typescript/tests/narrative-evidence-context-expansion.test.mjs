import test from "node:test";
import assert from "node:assert/strict";
import {expandNarrativeEvidenceContext as expand} from "../dist/motor-literario.js";
const text="Ana encontró una carta. La leyó detenidamente. Después comprendió por qué Bruno había desaparecido. Al amanecer salió.";
const anchor={id:"knowledge-1",kind:"comprehension",entityIds:["ana"],evidence:{documentId:"ch1",revision:2,start:47,end:99,excerpt:"Después comprendió por qué Bruno había desaparecido."}};
const input={projectId:"book",documentId:"ch1",revision:2,text,anchors:[anchor]};
test("recupera contexto anterior y posterior sin fusionar las evidencias",()=>{
 const [x]=expand(input);assert.deepEqual(x.precedingContext.map(e=>e.excerpt),["La leyó detenidamente."]);
 assert.deepEqual(x.followingContext.map(e=>e.excerpt),["Al amanecer salió."]);
 assert.equal(x.anchorEvidence.excerpt,anchor.evidence.excerpt);
 assert.equal(x.interpretation,"context-only-no-semantic-link-inferred");
});
test("respeta offsets absolutos y mantiene extractos verificables",()=>{
 const base=200,[x]=expand({...input,baseOffset:base,anchors:[{...anchor,evidence:{...anchor.evidence,start:base+anchor.evidence.start,end:base+anchor.evidence.end}}]});
 assert.equal(x.contextStart,base+24);assert.equal(text.slice(x.contextStart-base,x.contextEnd-base),x.contextExcerpt);
});
test("no atraviesa límites de párrafo",()=>{
 const t="Ana llegó.\n\nDespués comprendió la verdad.\n\nBruno se marchó.";
 const a={...anchor,evidence:{documentId:"ch1",revision:2,start:12,end:42,excerpt:"Después comprendió la verdad."}};
 const [x]=expand({projectId:"book",documentId:"ch1",revision:2,text:t,anchors:[a],sentencesBefore:2,sentencesAfter:2});
 assert.deepEqual(x.precedingContext,[]);assert.deepEqual(x.followingContext,[]);
 assert.equal(x.contextCompleteness,"paragraph-boundary");
});
test("no inventa enlaces semánticos entre oraciones vecinas",()=>{
 const [x]=expand({...input,sentencesBefore:0,sentencesAfter:0});
 assert.equal(x.precedingContext.length,0);assert.equal(x.followingContext.length,0);
 assert.equal(x.contextExcerpt,anchor.evidence.excerpt);
});
test("rechaza evidencia alterada, ajena o duplicada",()=>{
 assert.throws(()=>expand({...input,anchors:[{...anchor,evidence:{...anchor.evidence,excerpt:"texto falso"}}]}));
 assert.throws(()=>expand({...input,anchors:[anchor,anchor]}));
 assert.throws(()=>expand({...input,anchors:[{...anchor,evidence:{...anchor.evidence,revision:3}}]}));
});
test("aplica presupuesto y límites de ventanas",()=>{
 assert.throws(()=>expand({...input,maxContextUnits:20_001}));
 assert.throws(()=>expand({...input,sentencesBefore:6}));
});
