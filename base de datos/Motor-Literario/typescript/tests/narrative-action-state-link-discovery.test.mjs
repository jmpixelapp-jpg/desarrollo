import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverNarrativeObservationCandidates,
  discoverNarrativeCharacterStateCandidates,
  discoverNarrativeActionStateLinks
} from "../dist/motor-literario.js";

const ana = {
  projectId: "book-1", id: "character:ana", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};
const bruno = {
  ...ana, id: "character:bruno", canonicalName: "Bruno", normalizedName: "bruno"
};

function extract(text, baseOffset = 0, entities = [ana]) {
  const context = {
    projectId: "book-1", documentId: "chapter-1", revision: 3,
    text, baseOffset
  };
  return {
    observations: discoverNarrativeObservationCandidates({ ...context, entities }),
    states: discoverNarrativeCharacterStateCandidates({ ...context, entities })
  };
}

function discover(text, baseOffset = 0, entities = [ana]) {
  const found = extract(text, baseOffset, entities);
  return discoverNarrativeActionStateLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 3,
    text, baseOffset, ...found
  });
}

test("vincula acción y estado con marcador causal explícito cuando el estado aparece primero", () => {
  const text = "Ana quedó herida porque Bruno atacó a Ana.";
  const found = discover(text, 0, [ana, bruno]);
  assert.equal(found.length, 1);
  assert.equal(found[0].marker, "porque");
  assert.equal(found[0].position, "state-before-action");
  assert.equal(found[0].entityId, ana.id);
  assert.equal(found[0].basis, "personal-object");
  assert.equal(found[0].reviewStatus, "candidate");
  assert.equal(text.slice(found[0].markerEvidence.start, found[0].markerEvidence.end), "porque");
  assert.equal(text.slice(found[0].actionEvidence.start, found[0].actionEvidence.end), found[0].actionEvidence.excerpt);
  assert.equal(text.slice(found[0].stateEvidence.start, found[0].stateEvidence.end), "herida");
});

test("vincula acción y estado cuando la acción aparece antes del estado", () => {
  const text = "Ana corrió porque Ana estaba herida.";
  const found = discover(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].position, "action-before-state");
  assert.equal(found[0].marker, "porque");
});

test("no propone vínculo causal por mera proximidad sin marcador causal", () => {
  assert.deepEqual(discover("Ana corrió. Ana estaba herida."), []);
});

test("no enlaza entidades que no aparecen como participantes compartidos", () => {
  const bruno = {
    ...ana, id: "character:bruno", canonicalName: "Bruno", normalizedName: "bruno"
  };
  const text = "Ana corrió porque Bruno estaba herido.";
  const context = {
    projectId: "book-1", documentId: "chapter-1", revision: 3, text,
    entities: [ana, bruno]
  };
  const observations = discoverNarrativeObservationCandidates(context);
  const states = discoverNarrativeCharacterStateCandidates(context);
  assert.deepEqual(discoverNarrativeActionStateLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 3,
    text, observations, states
  }), []);
});

test("conserva offsets absolutos UTF-16 con prefijo y emoji", () => {
  const prefix = "😀 Prólogo.\n";
  const text = "Ana quedó herida porque Ana corrió.";
  const found = discover(text, prefix.length);
  assert.equal(found.length, 1);
  assert.equal(found[0].markerEvidence.start, prefix.length + text.indexOf("porque"));
  assert.equal(found[0].markerEvidence.excerpt, "porque");
});

test("rechaza evidencia de acción o estado que no coincide con el texto", () => {
  const text = "Ana quedó herida porque Ana corrió.";
  const { observations, states } = extract(text);
  assert.throws(() => discoverNarrativeActionStateLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 3, text,
    observations: [{ ...observations[0], actionEvidence: { ...observations[0].actionEvidence, excerpt: "falso" } }],
    states
  }), /evidencia literal verificable/);
  assert.throws(() => discoverNarrativeActionStateLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 3, text,
    observations,
    states: [{ ...states[0], documentId: "other" }]
  }), /evidencia verificable/);
});

test("rechaza candidatos duplicados", () => {
  const text = "Ana quedó herida porque Ana corrió.";
  const { observations, states } = extract(text);
  assert.throws(() => discoverNarrativeActionStateLinks({
    projectId: "book-1", documentId: "chapter-1", revision: 3, text,
    observations: [observations[0], observations[0]], states
  }), /identidad única/);
});
