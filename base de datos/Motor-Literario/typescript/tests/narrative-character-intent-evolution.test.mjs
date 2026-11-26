import test from "node:test";
import assert from "node:assert/strict";
import { evolveNarrativeCharacterIntents } from "../dist/motor-literario.js";

const entities = [
  { projectId:"novel", id:"mara", kind:"character", canonicalName:"Mara", normalizedName:"mara", aliases:[], evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1 }
];

function intent(id, text, polarity, documentId, start, excerpt = text, revision = 1, kind = "goal") {
  return {
    id, projectId:"novel", characterEntityId:"mara", kind, text,
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

test("no ordena automáticamente revisiones distintas del mismo documento", () => {
  const prior = intent("old", "buscar el trono", "affirmed", "chapter-1", 10, "Mara quiere buscar el trono.", 1);
  const current = intent("new", "proteger a Elian", "affirmed", "chapter-1", 80, "Mara quiere proteger a Elian.", 2);
  const [result] = evolveNarrativeCharacterIntents({
    projectId:"novel", entities, priorIntents:[prior], currentIntents:[current],
    orderedDocumentIds:["chapter-1"]
  });
  assert.equal(result.transition, "chronology-unresolved");
});

test("detecta abandono explícito cuando se nombra la meta abandonada", () => {
  const excerpt = "Mara renunció a buscar el trono y ahora quiere proteger a Elian.";
  const prior = intent("old", "buscar el trono", "affirmed", "chapter-1", 10);
  const current = intent("new", "proteger a Elian", "affirmed", "chapter-2", 48, excerpt);
  const [result] = evolveNarrativeCharacterIntents({
    projectId:"novel", entities, priorIntents:[prior], currentIntents:[current],
    orderedDocumentIds:["chapter-1","chapter-2"]
  });
  assert.equal(result.transition, "withdrawn");
  assert.deepEqual(result.priorIntentIds, ["old"]);
  assert.match(result.transitionEvidence.excerpt, /renunció a/u);
});

test("conserva una motivación idéntica como mantenida", () => {
  const prior = intent("old-motive","miedo a perder a su hermana","affirmed","chapter-1",10,
    "Mara luchó por miedo a perder a su hermana.",1,"motivation");
  const current = intent("new-motive","miedo a perder a su hermana","affirmed","chapter-2",20,
    "Mara volvió a luchar por miedo a perder a su hermana.",1,"motivation");
  const [result] = evolveNarrativeCharacterIntents({
    projectId:"novel",entities,priorIntents:[prior],currentIntents:[current],
    orderedDocumentIds:["chapter-1","chapter-2"]
  });
  assert.equal(result.transition,"maintained");
  assert.deepEqual(result.priorIntentIds,["old-motive"]);
});

test("detecta sustitución explícita de una motivación y conserva ambas evidencias", () => {
  const excerpt = "Mara cambió de motivación: en lugar de actuar por miedo a perder a su hermana, ahora actúa por lealtad a Elian.";
  const prior = intent("old-motive","miedo a perder a su hermana","affirmed","chapter-1",10,
    "Mara luchó por miedo a perder a su hermana.",1,"motivation");
  const current = intent("new-motive","lealtad a Elian","affirmed","chapter-2",90,
    excerpt,1,"motivation");
  const [result] = evolveNarrativeCharacterIntents({
    projectId:"novel",entities,priorIntents:[prior],currentIntents:[current],
    orderedDocumentIds:["chapter-1","chapter-2"]
  });
  assert.equal(result.transition,"replaced");
  assert.deepEqual(result.priorIntentIds,["old-motive"]);
  assert.equal(result.priorEvidence[0].documentId,"chapter-1");
  assert.equal(result.currentEvidence.documentId,"chapter-2");
  assert.match(result.transitionEvidence.excerpt,/en lugar de/u);
});

test("no interpreta una motivación diferente como sustitución sin marcador expreso", () => {
  const prior = intent("old-motive","miedo a perder a su hermana","affirmed","chapter-1",10,
    "Mara luchó por miedo a perder a su hermana.",1,"motivation");
  const current = intent("new-motive","lealtad a Elian","affirmed","chapter-2",20,
    "Mara actuó por lealtad a Elian.",1,"motivation");
  const [result] = evolveNarrativeCharacterIntents({
    projectId:"novel",entities,priorIntents:[prior],currentIntents:[current],
    orderedDocumentIds:["chapter-1","chapter-2"]
  });
  assert.equal(result.transition,"coexisting");
});

test("rechaza IDs repetidos entre intenciones actuales e históricas", () => {
  const prior = intent("same-id","proteger a Elian","affirmed","chapter-1",10);
  const current = intent("same-id","buscar el trono","affirmed","chapter-2",20);
  assert.throws(() => evolveNarrativeCharacterIntents({
    projectId:"novel",entities,priorIntents:[prior],currentIntents:[current],
    orderedDocumentIds:["chapter-1","chapter-2"]
  }),/IDs únicos/i);
});

test("rechaza un orden documental con capítulos duplicados", () => {
  assert.throws(() => evolveNarrativeCharacterIntents({
    projectId:"novel",entities,priorIntents:[],
    currentIntents:[intent("new","proteger a Elian","affirmed","chapter-1",10)],
    orderedDocumentIds:["chapter-1","chapter-1"]
  }));
});
