import test from "node:test";
import assert from "node:assert/strict";
import { buildNarrativeMemoryTimeline } from "../dist/motor-literario.js";

const entities = [
  {projectId:"story",id:"mara",kind:"character",canonicalName:"Mara",normalizedName:"mara",aliases:[],evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1}
];
const event = (id,kind,documentId,start,content="Elian había salido",revision=1) => ({
  id,projectId:"story",characterEntityId:"mara",kind,content,reviewStatus:"candidate",
  evidence:{documentId,revision,start,end:start+content.length,excerpt:content}
});
const build = (events, orderedDocumentIds) => buildNarrativeMemoryTimeline({
  projectId:"story",entities,events,orderedDocumentIds
});

test("un olvido posterior cambia la proyección, pero conserva ambos eventos", () => {
  const result = build([
    event("e1","remembering","chapter-1",10),
    event("e2","forgetting","chapter-1",80)
  ]);
  const memory = result[0].memories[0];
  assert.equal(memory.currentStatus,"forgotten");
  assert.equal(memory.events.length,2);
  assert.deepEqual(memory.events.map(item => item.id),["e1","e2"]);
});

test("un recuerdo posterior puede recuperar un contenido previamente olvidado", () => {
  const result = build([
    event("e1","forgetting","chapter-1",10),
    event("e2","memory-recovery","chapter-1",80)
  ]);
  assert.equal(result[0].memories[0].currentStatus,"memory-recovered");
});

test("no inventa cronología entre documentos sin orden explícito", () => {
  const result = build([
    event("e1","remembering","chapter-1",10),
    event("e2","forgetting","chapter-2",10)
  ]);
  assert.equal(result[0].memories[0].currentStatus,"chronology-unresolved");
  assert.equal(result[0].memories[0].chronology,"cross-document-order-unknown");
});

test("usa exclusivamente el orden documental proporcionado", () => {
  const result = build([
    event("e1","forgetting","chapter-2",10),
    event("e2","remembering","chapter-1",10)
  ],["chapter-1","chapter-2"]);
  assert.equal(result[0].memories[0].currentStatus,"forgotten");
  assert.equal(result[0].memories[0].chronology,"explicit-document-order");
});

test("revisiones distintas del mismo documento no se ordenan automáticamente", () => {
  const result = build([
    event("e1","remembering","chapter-1",10,"Elian había salido",1),
    event("e2","forgetting","chapter-1",80,"Elian había salido",2)
  ]);
  assert.equal(result[0].memories[0].currentStatus,"chronology-unresolved");
});

test("rechaza eventos pertenecientes a otro proyecto o personaje", () => {
  assert.throws(() => build([{...event("e1","forgetting","chapter-1",1),projectId:"other"}]));
});
