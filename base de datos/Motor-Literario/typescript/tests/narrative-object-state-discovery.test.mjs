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

test("detecta cambios explícitos de condición del objeto con roles y evidencia exactos", () => {
  const cases = [
    ["Ana abrió la Espada Solar.", "abrir", "opened", "abrió"],
    ["Ana cerró la Espada Solar.", "cerrar", "closed", "cerró"],
    ["Ana rompió la Espada Solar.", "romper", "broken", "rompió"],
    ["Ana reparó la Espada Solar.", "reparar", "repaired", "reparó"],
    ["Ana destruyó la Espada Solar.", "destruir", "destroyed", "destruyó"],
    ["Ana activó la Espada Solar.", "activar", "activated", "activó"],
    ["Ana desactivó la Espada Solar.", "desactivar", "deactivated", "desactivó"]
  ];
  for (const [text, action, transition, verb] of cases) {
    const observations = observe(text);
    const observation = observations.find(item => item.action === action);
    assert.ok(observation, text);
    const [candidate] = discoverNarrativeObjectTransitionCandidates({
      projectId: context.projectId, documentId: context.documentId,
      revision: context.revision, observations
    });
    assert.ok(candidate, text);
    assert.equal(candidate.transition, transition);
    assert.equal(candidate.objectEntityId, sword.id);
    assert.equal(candidate.actorEntityId, ana.id);
    assert.equal(candidate.actionEvidence.excerpt, verb);
    assert.equal(candidate.objectEvidence.excerpt, "Espada Solar");
    assert.equal(candidate.effectStatus, "candidate");
    for (const evidence of [candidate.actionEvidence, candidate.objectEvidence, candidate.actorEvidence]) {
      assert.ok(evidence);
      assert.equal(text.slice(evidence.start, evidence.end), evidence.excerpt);
    }
  }
});

test("conserva negación y futuro en cambios de condición sin aplicarlos al estado actual", () => {
  const cases = [
    ["Ana no rompió la Espada Solar.", "broken", "not-applied", "negated"],
    ["Ana reparará la Espada Solar.", "repaired", "prospective", "affirmed"],
    ["Ana no activará la Espada Solar.", "activated", "not-applied", "negated"]
  ];
  for (const [text, transition, effectStatus, polarity] of cases) {
    const observations = observe(text);
    const candidates = discoverNarrativeObjectTransitionCandidates({
      projectId: context.projectId, documentId: context.documentId,
      revision: context.revision, observations
    });
    assert.equal(candidates.length, 1, text);
    assert.equal(candidates[0].transition, transition);
    assert.equal(candidates[0].effectStatus, effectStatus);
    assert.equal(candidates[0].polarity, polarity);
  }
});

test("no propone transición si faltan objeto o participante activo", () => {
  const observations = observe("Ana perdió el recuerdo.");
  const transitions = discoverNarrativeObjectTransitionCandidates({
    projectId: context.projectId, documentId: context.documentId,
    revision: context.revision, observations
  });
  assert.deepEqual(transitions, []);
});

test("admite varias oraciones en una línea y conserva rangos del contexto", () => {
  const text = "Ana miró la Espada Solar. Ana perdió la Espada Solar.";
  const observations = observe(text);
  const transitions = discoverNarrativeObjectTransitionCandidates({
    projectId: context.projectId, documentId: context.documentId,
    revision: context.revision, observations
  });
  assert.equal(transitions.length, 1);
  const evidence = transitions[0].contextEvidence;
  assert.equal(evidence.start, 0);
  assert.equal(evidence.end, text.length);
  assert.equal(evidence.excerpt, text);
  assert.equal(text.slice(transitions[0].actionEvidence.start, transitions[0].actionEvidence.end),
    transitions[0].actionEvidence.excerpt);
});

test("rechaza offsets de evidencia que no corresponden a su fragmento UTF-16", () => {
  const [observation] = observe("Ana perdió la Espada Solar.");
  assert.throws(() => discoverNarrativeObjectTransitionCandidates({
    projectId: context.projectId, documentId: context.documentId,
    revision: context.revision,
    observations: [{
      ...observation,
      grammaticalObjectCandidate: {
        ...observation.grammaticalObjectCandidate,
        evidence: {
          ...observation.grammaticalObjectCandidate.evidence,
          end: observation.grammaticalObjectCandidate.evidence.end + 1
        }
      }
    }]
  }));
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
