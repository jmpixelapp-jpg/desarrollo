import test from "node:test";
import assert from "node:assert/strict";
import { compareNarrativeActionClaims } from "../dist/motor-literario.js";
import { discoverNarrativeObservationCandidates } from "../dist/motor-literario.js";

const ana = {
  projectId: "book-1", id: "ana", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};
const context = { projectId: "book-1", documentId: "chapter-1", revision: 1, entities: [ana] };

test("detecta discrepancia de polaridad y conserva ambas pruebas", () => {
  const positiveText = "Ana abrió la puerta.";
  const negativeText = "Ana no abrió la puerta.";
  const positive = discoverNarrativeObservationCandidates({ ...context, text: positiveText });
  const negative = discoverNarrativeObservationCandidates({
    ...context, documentId: "chapter-2", text: negativeText
  });
  const findings = compareNarrativeActionClaims({
    projectId: "book-1", observations: [...positive, ...negative]
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].classification, "polarity-disagreement-candidate");
  assert.equal(findings[0].interpretation, "same-epistemic-frame");
  assert.deepEqual([findings[0].firstPolarity, findings[0].secondPolarity].sort(),
    ["affirmed", "negated"]);
  assert.equal(findings[0].evidence.length, 2);
  assert.ok(findings[0].evidence.every(item => item.excerpt.includes("Ana")));
});

test("separa perspectivas epistémicas sin declarar cuál es verdadera", () => {
  const narrator = discoverNarrativeObservationCandidates({
    ...context, text: "Ana abrió la puerta."
  });
  const belief = discoverNarrativeObservationCandidates({
    ...context, documentId: "chapter-2", text: "Ana creyó que Ana no abrió la puerta."
  });
  const findings = compareNarrativeActionClaims({
    projectId: "book-1", observations: [...narrator, ...belief]
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].interpretation, "different-epistemic-frame");
  assert.equal(findings[0].firstEpistemicFrame === findings[0].secondEpistemicFrame, false);
});

test("no compara acciones sin sujeto activo inequívoco ni objetos incompatibles", () => {
  const ambiguous = discoverNarrativeObservationCandidates({
    ...context, entities: [ana, { ...ana, id: "bruno", canonicalName: "Bruno" }],
    text: "Ana ayudó a Bruno."
  });
  const explicitObject = discoverNarrativeObservationCandidates({
    ...context, text: "Ana abrió la puerta."
  });
  const noObject = discoverNarrativeObservationCandidates({
    ...context, documentId: "chapter-2", text: "Ana no abrió."
  });
  assert.deepEqual(compareNarrativeActionClaims({
    projectId: "book-1", observations: ambiguous
  }), []);
  assert.deepEqual(compareNarrativeActionClaims({
    projectId: "book-1", observations: [...explicitObject, ...noObject]
  }), []);
});

test("rechaza proyectos, identidades y evidencias inválidas", () => {
  const observations = discoverNarrativeObservationCandidates({
    ...context, text: "Ana abrió la puerta."
  });
  assert.throws(() => compareNarrativeActionClaims({
    projectId: "other", observations
  }));
  assert.throws(() => compareNarrativeActionClaims({
    projectId: "book-1", observations: [observations[0], observations[0]]
  }));
  assert.throws(() => compareNarrativeActionClaims({
    projectId: "book-1",
    observations: [{ ...observations[0], actionEvidence: { ...observations[0].actionEvidence, excerpt: "falso" } }]
  }));
});
