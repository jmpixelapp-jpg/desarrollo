import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrativeAttributedClaims } from "../dist/motor-literario.js";

const entities = [
  {
    projectId: "book-1", id: "character:mara", kind: "character",
    canonicalName: "Mara", normalizedName: "mara", aliases: ["La Guardiana"],
    evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  },
  {
    projectId: "book-1", id: "character:elian", kind: "character",
    canonicalName: "Elian", normalizedName: "elian", aliases: [],
    evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  }
];

const context = {
  projectId: "book-1", documentId: "chapter-2", revision: 4, entities
};

test("atribuye creencias al personaje sin convertirlas en hechos", () => {
  const found = extractNarrativeAttributedClaims({
    ...context,
    text: "Mara cree que Elian conoce la entrada secreta."
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].speakerEntityId, "character:mara");
  assert.equal(found[0].kind, "belief");
  assert.equal(found[0].content, "Elian conoce la entrada secreta");
  assert.equal(found[0].reviewStatus, "candidate");
});

test("distingue afirmaciones, recuerdos, temores y palabras dichas", () => {
  const found = extractNarrativeAttributedClaims({
    ...context,
    text: [
      "Mara afirma que la puerta está abierta.",
      "Elian recuerda que su madre vivía aquí.",
      "Mara teme que llegue la tormenta.",
      "Elian dijo que volvería al amanecer."
    ].join("\n")
  });
  assert.deepEqual(found.map(item => item.kind), [
    "assertion", "memory", "fear", "speech"
  ]);
});

test("conserva negación, evidencia y offsets absolutos", () => {
  const prefix = "Prólogo.\n";
  const sentence = "Mara no cree que Elian sea un traidor.";
  const found = extractNarrativeAttributedClaims({
    ...context, text: sentence, baseOffset: prefix.length
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].polarity, "negated");
  assert.equal(found[0].evidence.start, prefix.length);
  assert.equal(found[0].evidence.excerpt, sentence);
  assert.equal(found[0].evidence.documentId, "chapter-2");
  assert.equal(found[0].evidence.revision, 4);
});

test("resuelve alias confirmados y no atribuye nombres ambiguos", () => {
  const alias = extractNarrativeAttributedClaims({
    ...context, text: "La Guardiana sospecha que alguien la sigue."
  });
  assert.equal(alias.length, 1);
  assert.equal(alias[0].speakerEntityId, "character:mara");

  const ambiguous = [
    ...entities,
    {
      projectId: "book-1", id: "character:other", kind: "character",
      canonicalName: "Mara", normalizedName: "mara", aliases: [],
      evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
    }
  ];
  assert.deepEqual(extractNarrativeAttributedClaims({
    ...context, entities: ambiguous, text: "Mara cree que el puente caerá."
  }), []);
});

test("rechaza entidades de otro proyecto y offsets inválidos", () => {
  assert.throws(() => extractNarrativeAttributedClaims({
    ...context,
    entities: [{ ...entities[0], projectId: "other-book" }],
    text: "Mara cree que volverá."
  }));
  assert.throws(() => extractNarrativeAttributedClaims({
    ...context, text: "Mara cree que volverá.", baseOffset: -1
  }));
});
