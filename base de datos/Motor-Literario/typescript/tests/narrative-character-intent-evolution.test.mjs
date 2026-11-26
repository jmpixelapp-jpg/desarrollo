import test from "node:test";
import assert from "node:assert/strict";
import { evolveNarrativeCharacterIntents } from "../dist/motor-literario.js";

const entities = [
  { projectId:"novel", id:"mara", kind:"character", canonicalName:"Mara", normalizedName:"mara", aliases:[], evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1 }
];

function intent(id, text, polarity, documentId, start, excerpt = text, revision = 1) {
  return {
    id, projectId:"novel", characterEntityId:"mara", kind:"goal", text,
    polarity, reviewStatus:"candidate",
    evidence:{documentId, revision, start, end:start+text.length, excerpt}
  };
}

test("conserva una meta idéntica como mantenida", () => {
  const prior = intent("old", "proteger a Elian", "affirmed", "chapter-1", 10);
  const current = intent("new", "proteger a Elian", "affirmed", "chapter-2", 20);
  const [result] = evolveNarrativeCharacterIntents({
    projectId:"novel", entities, priorIntents:[prior], currentIntents:[current],
    orderedDocumentIds:["chapter-1","chapter-2"]
  });
  assert.equal(result.transition, "maintained");
  assert.deepEqual(result.priorIntentIds, ["old"]);
});

test("marca retirada solo cuando la misma meta aparece negada", () => {
  const prior = intent("old", "proteger a Elian", "affirmed", "chapter-1", 10);
  const current = intent("new", "proteger a Elian", "negated", "chapter-2", 20);
  const [result] = evolveNarrativeCharacterIntents({
    projectId:"novel", entities, priorIntents:[prior], currentIntents:[current],
    orderedDocumentIds:["chapter-1","chapter-2"]
  });
  assert.equal(result.transition, "withdrawn");
  assert.deepEqual(result.priorIntentIds, ["old"]);
});

test("marca reemplazo solo si la frase menciona la meta anterior y la sustitución", () => {
  const excerpt = "Mara cambió de objetivo: en lugar de buscar el trono, ahora quiere proteger a Elian.";
  const prior = intent("old", "buscar el trono", "affirmed", "chapter-1", 10);
  const current = intent("new", "proteger a Elian", "affirmed", "chapter-2", 80, excerpt);
  const [result] = evolveNarrativeCharacterIntents({
    projectId:"novel", entities, priorIntents:[prior], currentIntents:[current],
    orderedDocumentIds:["chapter-1","chapter-2"]
  });
  assert.equal(result.transition, "replaced");
  assert.deepEqual(result.priorIntentIds, ["old"]);
  assert.match(result.transitionEvidence.excerpt, /en lugar de/u);
});

test("no sustituye una meta anterior por una meta diferente sin señal expresa", () => {
  const prior = intent("old", "buscar el trono", "affirmed", "chapter-1", 10);
  const current = intent("new", "proteger a Elian", "affirmed", "chapter-2", 80);
  const [result] = evolveNarrativeCharacterIntents({
    projectId:"novel", entities, priorIntents:[prior], currentIntents:[current],
    orderedDocumentIds:["chapter-1","chapter-2"]
  });
  assert.equal(result.transition, "coexisting");
  assert.deepEqual(result.priorIntentIds, ["old"]);
});

test("no inventa orden entre capítulos sin cronología declarada", () => {
  const prior = intent("old", "buscar el trono", "affirmed", "chapter-1", 10);
  const current = intent("new", "proteger a Elian", "affirmed", "chapter-2", 80);
  const [result] = evolveNarrativeCharacterIntents({
    projectId:"novel", entities, priorIntents:[prior], currentIntents:[current]
  });
  assert.equal(result.transition, "chronology-unresolved");
  assert.deepEqual(result.priorIntentIds, ["old"]);
});

test("conserva varios antecedentes compatibles como ambiguos", () => {
  const prior = [
    intent("old-1", "proteger a Elian", "affirmed", "chapter-1", 10),
    intent("old-2", "proteger a Elian", "affirmed", "chapter-1", 80)
  ];
  const current = intent("new", "proteger a Elian", "affirmed", "chapter-2", 20);
  const [result] = evolveNarrativeCharacterIntents({
    projectId:"novel", entities, priorIntents:prior, currentIntents:[current],
    orderedDocumentIds:["chapter-1","chapter-2"]
  });
  assert.equal(result.transition, "ambiguous-predecessor");
  assert.deepEqual(result.priorIntentIds, ["old-1","old-2"]);
});

test("rechaza objetivos previos de otro proyecto o personaje desconocido", () => {
  const invalid = {...intent("bad", "buscar el trono", "affirmed", "chapter-1", 10), projectId:"other"};
  assert.throws(() => evolveNarrativeCharacterIntents({
    projectId:"novel", entities, priorIntents:[invalid],
    currentIntents:[intent("new", "proteger a Elian", "affirmed", "chapter-2", 20)]
  }));
});
