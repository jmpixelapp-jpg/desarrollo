import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrativeKnowledgeEvolution } from "../dist/motor-literario.js";

const entities = [{
  projectId:"book-1", id:"character:mara", kind:"character",
  canonicalName:"Mara", normalizedName:"mara", aliases:[],
  evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1
}];
const priorClaim = {
  id:"claim:old:10:mara", projectId:"book-1", speakerEntityId:"character:mara",
  attribution:"afirma", kind:"assertion", content:"el puente había caído",
  attributionPolarity:"affirmed", contentPolarity:"affirmed", polarity:"affirmed",
  reviewStatus:"candidate",
  evidence:{documentId:"chapter-old",revision:2,start:10,end:40,excerpt:"Mara afirma que el puente había caído"}
};
const context = {
  projectId:"book-1", documentId:"chapter-new", revision:3, entities,
  priorClaims:[priorClaim]
};

test("vincula confirmación explícita con una afirmación previa de contenido exacto", () => {
  const found = extractNarrativeKnowledgeEvolution({
    ...context, text:"Mara confirmó que el puente había caído."
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].evaluation, "confirmed");
  assert.equal(found[0].matchStatus, "exact-match");
  assert.equal(found[0].matchedClaimId, priorClaim.id);
  assert.equal(found[0].claimEvidence.documentId, "chapter-old");
});

test("registra refutación sin borrar ni reescribir la afirmación anterior", () => {
  const found = extractNarrativeKnowledgeEvolution({
    ...context, text:"Mara desmintió que el puente había caído."
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].evaluation, "refuted");
  assert.equal(found[0].matchedClaimId, priorClaim.id);
  assert.equal(found[0].claimEvidence, priorClaim.evidence);
});

test("no enlaza paráfrasis como si fueran coincidencias exactas", () => {
  const found = extractNarrativeKnowledgeEvolution({
    ...context, text:"Mara confirmó que la estructura del río se había derrumbado."
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].matchStatus, "no-prior-match");
  assert.equal(found[0].matchedClaimId, undefined);
});

test("mantiene el estado ambiguo si hay varias afirmaciones previas idénticas", () => {
  const found = extractNarrativeKnowledgeEvolution({
    ...context,
    priorClaims:[priorClaim,{ ...priorClaim, id:"claim:other", evidence:{...priorClaim.evidence,documentId:"chapter-other"} }],
    text:"Mara confirmó que el puente había caído."
  });
  assert.equal(found[0].matchStatus, "ambiguous-prior-match");
  assert.equal(found[0].matchedClaimId, undefined);
});

test("no inventa una fuente ni atribuye conocimiento por un verbo no explícito", () => {
  assert.deepEqual(extractNarrativeKnowledgeEvolution({
    ...context, text:"El puente había caído."
  }), []);
});

test("conserva offsets absolutos y rechaza datos previos de otro proyecto", () => {
  const prefix = "Capítulo anterior.\n";
  const text = "Mara confirmó que el puente había caído.";
  const found = extractNarrativeKnowledgeEvolution({
    ...context, text, baseOffset:prefix.length
  });
  assert.equal(found[0].evidence.start, prefix.length);
  assert.equal(found[0].evidence.documentId, "chapter-new");
  assert.throws(() => extractNarrativeKnowledgeEvolution({
    ...context, priorClaims:[{...priorClaim,projectId:"other"}], text
  }));
});
