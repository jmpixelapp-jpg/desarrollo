import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrativeMemoryEvents } from "../dist/motor-literario.js";

const entities = [
  {projectId:"story",id:"mara",kind:"character",canonicalName:"Mara",normalizedName:"mara",aliases:[],evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1},
  {projectId:"story",id:"elian",kind:"character",canonicalName:"Elian",normalizedName:"elian",aliases:[],evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1}
];
const run = (text, baseOffset = 0) => extractNarrativeMemoryEvents({
  projectId:"story",documentId:"chapter-1",revision:2,text,entities,baseOffset
});

test("detecta olvido explícito sin inferirlo por silencio", () => {
  const events = run("Mara olvidó que Elian había salido.");
  assert.equal(events.length,1);
  assert.equal(events[0].kind,"forgetting");
  assert.equal(events[0].characterEntityId,"mara");
  assert.equal(events[0].content,"Elian había salido");
});

test("detecta recuerdo y recuperación como eventos diferentes", () => {
  const remembered = run("Mara recordó que la llave estaba bajo la piedra.");
  const recovered = run("Mara recuperó el recuerdo de que la llave estaba bajo la piedra.");
  assert.equal(remembered[0].kind,"remembering");
  assert.equal(recovered[0].kind,"memory-recovery");
});

test("no interpreta 'no olvidó' ni 'nunca olvidó' como olvido", () => {
  assert.deepEqual(run("Mara no olvidó que Elian había salido."),[]);
  assert.deepEqual(run("Mara nunca olvidó que Elian había salido."),[]);
});

test("no atribuye nombres ambiguos a un personaje", () => {
  const ambiguous = [...entities, {
    projectId:"story",id:"mara-2",kind:"character",canonicalName:"Mara",normalizedName:"mara",
    aliases:[],evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1
  }];
  const events = extractNarrativeMemoryEvents({
    projectId:"story",documentId:"chapter-1",revision:1,
    text:"Mara olvidó que Elian había salido.",entities:ambiguous
  });
  assert.deepEqual(events,[]);
});

test("conserva offsets UTF-16 absolutos en ventanas parciales", () => {
  const events = run("Mara recordó que la puerta estaba abierta.",500);
  assert.equal(events[0].evidence.start,500);
  assert.equal(events[0].evidence.end,events[0].evidence.start+events[0].evidence.excerpt.length);
});

test("rechaza entidades de otro proyecto", () => {
  assert.throws(() => extractNarrativeMemoryEvents({
    projectId:"story",documentId:"chapter-1",revision:1,
    text:"Mara recordó que la puerta estaba abierta.",
    entities:[{...entities[0],projectId:"other"}]
  }));
});
