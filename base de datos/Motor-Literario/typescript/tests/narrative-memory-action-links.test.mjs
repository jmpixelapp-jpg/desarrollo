import test from "node:test";
import assert from "node:assert/strict";
import { understandNarrativeFragment } from "../dist/motor-literario.js";

const entities = [
  { projectId:"novel", id:"mara", kind:"character", canonicalName:"Mara", normalizedName:"mara", aliases:[], evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1 },
  { projectId:"novel", id:"elian", kind:"character", canonicalName:"Elian", normalizedName:"elian", aliases:[], evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1 }
];

test("vincula recuerdo y acción con conector causal explícito", () => {
  const text = "Mara recordó que Elian estaba preso; por eso Mara rescató a Elian.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"memory-cause", revision:1, text, entities
  });
  assert.equal(result.memoryEvents.length, 1);
  assert.equal(result.actions.length, 1);
  assert.equal(result.memoryActionLinks.length, 1);
  const link = result.memoryActionLinks[0];
  assert.equal(link.relation, "explicit-causal-link");
  assert.equal(link.characterEntityId, "mara");
  assert.equal(link.actionId, result.actions[0].id);
  assert.equal(link.memoryEventIds[0], result.memoryEvents[0].id);
  assert.match(link.connectorEvidence.excerpt, /por eso/u);
});

test("separa la secuencia temporal de una afirmación causal", () => {
  const text = "Mara recordó que Elian estaba preso; después Mara rescató a Elian.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"memory-temporal", revision:1, text, entities
  });
  assert.equal(result.memoryActionLinks.length, 1);
  assert.equal(result.memoryActionLinks[0].relation, "temporal-cooccurrence");
  assert.match(result.memoryActionLinks[0].connectorEvidence.excerpt, /después/u);
});

test("no atribuye el recuerdo de Mara a la acción de Elian", () => {
  const text = "Mara recordó que estaba preso; por eso Elian rescató a Mara.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"memory-other-actor", revision:1, text, entities
  });
  assert.equal(result.memoryActionLinks.length, 0);
});

test("un recuerdo negado no se convierte en recuerdo activo", () => {
  const text = "Mara no recordó que Elian estaba preso; por eso Mara rescató a Elian.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"memory-negated", revision:1, text, entities
  });
  assert.equal(result.memoryEvents.length, 0);
  assert.equal(result.memoryActionLinks.length, 0);
});

test("mantiene offsets absolutos de evidencia en fragmentos", () => {
  const text = "Mara recordó que Elian estaba preso; por eso Mara rescató a Elian.";
  const baseOffset = 900;
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"memory-offset", revision:4,
    text, entities, baseOffset
  });
  const link = result.memoryActionLinks[0];
  assert.equal(link.memoryEvidence[0].start, baseOffset);
  assert.equal(link.actionEvidence.start, baseOffset + text.indexOf("Mara rescató"));
  assert.equal(link.connectorEvidence.start, baseOffset + text.indexOf("por eso"));
});

test("no convierte la proximidad entre oraciones en causalidad", () => {
  const text = "Mara recordó que Elian estaba preso. Mara rescató a Elian.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"memory-no-cause", revision:1, text, entities
  });
  assert.equal(result.memoryActionLinks.length, 1);
  assert.equal(result.memoryActionLinks[0].relation, "unresolved");
});

test("conserva varios recuerdos posibles como relación ambigua", () => {
  const text = "Mara recordó que Elian estaba preso y Mara recordó que Elian había escapado; por eso Mara rescató a Elian.";
  const result = understandNarrativeFragment({
    projectId:"novel", documentId:"memory-ambiguous", revision:1, text, entities
  });
  assert.equal(result.memoryEvents.length, 2);
  assert.equal(result.memoryActionLinks.length, 1);
  assert.equal(result.memoryActionLinks[0].relation, "unresolved");
  assert.equal(result.memoryActionLinks[0].memoryEventIds.length, 2);
});
