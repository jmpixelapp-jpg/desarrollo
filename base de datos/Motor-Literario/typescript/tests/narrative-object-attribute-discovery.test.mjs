import test from "node:test";
import assert from "node:assert/strict";
import {discoverNarrativeObjectAttributeCandidates as discover} from "../dist/motor-literario.js";
const sword={projectId:"p",id:"sword",kind:"object",canonicalName:"Espada Solar",normalizedName:"espada solar",aliases:["la espada"],evidence:[],firstSeenAt:0,lastSeenAt:0,extractionVersion:1};
const input=(text)=>({projectId:"p",documentId:"ch1",revision:1,text,entities:[sword]});
test("extrae color, material y condición como evidencias separadas",()=>{
 const r=discover(input("La Espada Solar dorada de oro apareció rota."));
 assert.ok(r.some(x=>x.attributeKind==="color"&&x.normalizedValue==="dorada"));
 assert.ok(r.some(x=>x.attributeKind==="material"&&x.normalizedValue==="oro"));
 assert.ok(r.some(x=>x.attributeKind==="condition"&&x.normalizedValue==="rota"));
 assert.ok(r.every(x=>x.persistence==="not-established"));
});
test("reconoce atributos antepuestos y alias explícitos",()=>{
 const r=discover(input("La pequeña la espada brillaba."));
 assert.ok(r.some(x=>x.attributeKind==="size"&&x.objectEntityId==="sword"));
});
test("conserva offsets absolutos y extractos literales",()=>{
 const prefix="😀 ";const text="La Espada Solar rota.";
 const [r]=discover({...input(text),baseOffset:prefix.length});
 assert.ok(r);assert.equal(r.attributeEvidence.start,prefix.length+16);
 assert.equal(text.slice(r.attributeEvidence.start-prefix.length,r.attributeEvidence.end-prefix.length),r.attributeEvidence.excerpt);
});
test("no infiere atributos que no están expresados",()=>assert.deepEqual(discover(input("La Espada Solar apareció en silencio.")),[]));
test("rechaza fichas de otro proyecto y entidades no objeto",()=>{
 assert.throws(()=>discover({...input("Espada Solar dorada"),entities:[{...sword,projectId:"q"}]}));
 assert.throws(()=>discover({...input("Espada Solar dorada"),entities:[{...sword,kind:"character"}]}));
});
test("valida límites de entrada",()=>{
 assert.throws(()=>discover({...input("Espada Solar dorada"),maxCandidates:5001}));
});
