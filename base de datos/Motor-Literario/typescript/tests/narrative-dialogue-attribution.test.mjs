import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrativeDialogueAttributions } from "../dist/motor-literario.js";

const entities = [
  {
    projectId:"book-1", id:"character:mara", kind:"character",
    canonicalName:"Mara", normalizedName:"mara", aliases:["La Guardiana"],
    evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1
  },
  {
    projectId:"book-1", id:"character:elian", kind:"character",
    canonicalName:"Elian", normalizedName:"elian", aliases:[],
    evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1
  }
];
const context = {
  projectId:"book-1", documentId:"chapter-dialogue", revision:3, entities
};

test("atribuye diálogo con raya y etiqueta explícita posterior", () => {
  const text = "—No volveré al castillo —dijo Mara.";
  const found = extractNarrativeDialogueAttributions({ ...context, text });
  assert.equal(found.length, 1);
  assert.equal(found[0].speakerEntityId, "character:mara");
  assert.equal(found[0].speech, "No volveré al castillo");
  assert.equal(found[0].attributionForm, "dash-after-dialogue");
  assert.equal(text.slice(found[0].speechEvidence.start, found[0].speechEvidence.end), found[0].speech);
  assert.equal(text.slice(found[0].speakerEvidence.start, found[0].speakerEvidence.end), "Mara");
});

test("atribuye diálogo entre comillas con etiqueta posterior", () => {
  const text = "«La puerta está abierta», respondió Elian.";
  const found = extractNarrativeDialogueAttributions({ ...context, text });
  assert.equal(found.length, 1);
  assert.equal(found[0].speakerEntityId, "character:elian");
  assert.equal(found[0].speech, "La puerta está abierta");
  assert.equal(found[0].attributionForm, "quote-after-dialogue");
});

test("atribuye diálogo con personaje nombrado antes de la cita", () => {
  const text = "Mara preguntó: «¿Quién ha entrado?»";
  const found = extractNarrativeDialogueAttributions({ ...context, text });
  assert.equal(found.length, 1);
  assert.equal(found[0].speakerEntityId, "character:mara");
  assert.equal(found[0].speech, "¿Quién ha entrado?");
  assert.equal(found[0].attributionForm, "speaker-before-dialogue");
});

test("conserva offsets absolutos y procedencia en ventanas de documento", () => {
  const prefix = "Capítulo anterior.\n";
  const text = "—Es tarde —susurró Mara.";
  const found = extractNarrativeDialogueAttributions({
    ...context, text, baseOffset:prefix.length
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].speechEvidence.start, prefix.length + text.indexOf("Es tarde"));
  assert.equal(found[0].speakerEvidence.start, prefix.length + text.indexOf("Mara"));
  assert.equal(found[0].evidence.documentId, "chapter-dialogue");
  assert.equal(found[0].evidence.revision, 3);
});

test("no adivina el hablante cuando falta una etiqueta explícita", () => {
  const text = "—No volveré al castillo.\n—Entonces iré solo.";
  assert.deepEqual(
    extractNarrativeDialogueAttributions({ ...context, text }),
    []
  );
});

test("no atribuye un nombre ambiguo compartido por dos personajes", () => {
  const ambiguous = [
    ...entities,
    {
      projectId:"book-1", id:"character:other", kind:"character",
      canonicalName:"Mara", normalizedName:"mara", aliases:[],
      evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1
    }
  ];
  assert.deepEqual(
    extractNarrativeDialogueAttributions({
      ...context, entities:ambiguous, text:"—Vete —dijo Mara."
    }),
    []
  );
});

test("rechaza entidades de otro proyecto y offsets inválidos", () => {
  assert.throws(() => extractNarrativeDialogueAttributions({
    ...context, entities:[{ ...entities[0], projectId:"other" }], text:"—Hola —dijo Mara."
  }));
  assert.throws(() => extractNarrativeDialogueAttributions({
    ...context, text:"—Hola —dijo Mara.", baseOffset:-1
  }));
});
