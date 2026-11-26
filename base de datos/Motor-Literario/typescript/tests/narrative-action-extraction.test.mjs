import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrativeActionCandidates } from "../dist/motor-literario.js";

const entities = [
  {
    projectId: "book-1", id: "character:mara", kind: "character",
    canonicalName: "Mara", normalizedName: "mara", aliases: [],
    evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  },
  {
    projectId: "book-1", id: "character:elian", kind: "character",
    canonicalName: "Elian", normalizedName: "elian", aliases: [],
    evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  },
  {
    projectId: "book-1", id: "object:espada", kind: "object",
    canonicalName: "Espada Solar", normalizedName: "espada solar", aliases: ["Solar"],
    evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  },
  {
    projectId: "book-1", id: "place:torre", kind: "place",
    canonicalName: "Torre Norte", normalizedName: "torre norte", aliases: [],
    evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  }
];
const context = {
  projectId: "book-1", documentId: "chapter-3", revision: 2, entities
};

test("extrae actor, acción y objetivo con evidencia literal", () => {
  const found = extractNarrativeActionCandidates({
    ...context, text: "Mara encontró la Espada Solar."
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].actorEntityId, "character:mara");
  assert.equal(found[0].action, "encontró");
  assert.equal(found[0].targetEntityId, "object:espada");
  assert.equal(found[0].reviewStatus, "candidate");
  assert.equal(found[0].evidence.excerpt, "Mara encontró la Espada Solar.");
});

test("reconoce acciones entre personajes y conserva la negación", () => {
  const found = extractNarrativeActionCandidates({
    ...context, text: "Mara no salvó a Elian."
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].targetEntityId, "character:elian");
  assert.equal(found[0].polarity, "negated");
});

test("usa alias y respeta offsets absolutos", () => {
  const prefix = "Capítulo anterior.\n";
  const found = extractNarrativeActionCandidates({
    ...context, text: "Mara protegió la Solar.", baseOffset: prefix.length
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].targetEntityId, "object:espada");
  assert.equal(found[0].evidence.start, prefix.length);
});

test("omite identidades ambiguas y no inventa acciones implícitas", () => {
  const ambiguous = [
    ...entities,
    { ...entities[2], id: "object:otra-espada" }
  ];
  assert.deepEqual(extractNarrativeActionCandidates({
    ...context, entities: ambiguous, text: "Mara encontró la Espada Solar."
  }), []);
  assert.deepEqual(extractNarrativeActionCandidates({
    ...context, text: "La espada cayó y Mara corrió."
  }), []);
});

test("rechaza contexto de otro proyecto y limita entradas inválidas", () => {
  assert.throws(() => extractNarrativeActionCandidates({
    ...context, entities: [{ ...entities[0], projectId: "other" }],
    text: "Mara encontró la Espada Solar."
  }));
  assert.throws(() => extractNarrativeActionCandidates({
    ...context, text: "Mara encontró la Espada Solar.", baseOffset: -1
  }));
});
