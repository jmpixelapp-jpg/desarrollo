import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverNarrativeObservationCandidates,
  discoverNarrativeObjectTransitionCandidates
} from "../dist/motor-literario.js";

const ana = {
  projectId: "book-1", id: "character:ana", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};
const bruno = {
  ...ana, id: "character:bruno", canonicalName: "Bruno", normalizedName: "bruno"
};
const sword = {
  projectId: "book-1", id: "object:sword", kind: "object",
  canonicalName: "Espada Solar", normalizedName: "espada solar", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};
const context = {
  projectId: "book-1", documentId: "chapter-1", revision: 4,
  entities: [ana, bruno, sword]
};

function observe(text) {
  return discoverNarrativeObservationCandidates({ ...context, text });
}

test("propone descubrimiento de objeto sin afirmar posesión", () => {
  const text = "Ana encontró la Espada Solar.";
  const observations = observe(text);
  const transitions = discoverNarrativeObjectTransitionCandidates({
    projectId: context.projectId, documentId: context.documentId,
    revision: context.revision, observations
  });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].transition, "discovered");
  assert.equal(transitions[0].objectEntityId, sword.id);
  assert.equal(transitions[0].actorEntityId, ana.id);
  assert.equal(transitions[0].recipientEntityId, undefined);
  assert.equal(transitions[0].effectStatus, "candidate");
  assert.equal(text.slice(transitions[0].objectEvidence.start, transitions[0].objectEvidence.end), "Espada Solar");
});

test("reconstruye una entrega solo con objeto, emisor y receptor explícitos", () => {
  const text = "Ana entregó la Espada Solar a Bruno.";
  const observations = observe(text);
  const transitions = discoverNarrativeObjectTransitionCandidates({
    projectId: context.projectId, documentId: context.documentId,
    revision: context.revision, observations
  });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].transition, "transferred");
  assert.equal(transitions[0].actorEntityId, ana.id);
  assert.equal(transitions[0].recipientEntityId, bruno.id);
  assert.equal(text.slice(transitions[0].recipientEvidence.start, transitions[0].recipientEvidence.end), "Bruno");
  assert.equal(transitions[0].effectStatus, "candidate");
});

test("registra pérdida candidata sin afirmar quién posee el objeto después", () => {
  const observations = observe("Ana perdió la Espada Solar.");
  const transitions = discoverNarrativeObjectTransitionCandidates({
    projectId: context.projectId, documentId: context.documentId,
    revision: context.revision, observations
  });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].transition, "lost");
  assert.equal(transitions[0].actorEntityId, ana.id);
  assert.equal(transitions[0].recipientEntityId, undefined);
});

test("una recepción identifica al receptor, pero no inventa al emisor", () => {
  const observations = observe("Ana recibió la Espada Solar.");
  const transitions = discoverNarrativeObjectTransitionCandidates({
    projectId: context.projectId, documentId: context.documentId,
    revision: context.revision, observations
  });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].transition, "received");
  assert.equal(transitions[0].recipientEntityId, ana.id);
  assert.equal(transitions[0].actorEntityId, undefined);
});

test("la negación no aplica el cambio de estado", () => {
  const observations = observe("Ana no perdió la Espada Solar.");
  const transitions = discoverNarrativeObjectTransitionCandidates({
    projectId: context.projectId, documentId: context.documentId,
    revision: context.revision, observations
  });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].polarity, "negated");
  assert.equal(transitions[0].effectStatus, "not-applied");
});

test("el futuro queda como cambio prospectivo, no como estado actual", () => {
  const observations = observe("Ana entregará la Espada Solar a Bruno.");
  const transitions = discoverNarrativeObjectTransitionCandidates({
    projectId: context.projectId, documentId: context.documentId,
    revision: context.revision, observations
  });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].transition, "transferred");
  assert.equal(transitions[0].effectStatus, "prospective");
});

test("no propone transición si faltan objeto o participante activo", () => {
  const observations = observe("Ana perdió el recuerdo.");
  const transitions = discoverNarrativeObjectTransitionCandidates({
    projectId: context.projectId, documentId: context.documentId,
    revision: context.revision, observations
  });
  assert.deepEqual(transitions, []);
});

test("rechaza observaciones de otra revisión o con evidencia obsoleta", () => {
  const [observation] = observe("Ana perdió la Espada Solar.");
  assert.throws(() => discoverNarrativeObjectTransitionCandidates({
    projectId: context.projectId, documentId: context.documentId,
    revision: context.revision + 1, observations: [observation]
  }));
  assert.throws(() => discoverNarrativeObjectTransitionCandidates({
    projectId: context.projectId, documentId: context.documentId,
    revision: context.revision,
    observations: [{ ...observation, actionEvidence: { ...observation.actionEvidence, status: "stale" } }]
  }));
});
