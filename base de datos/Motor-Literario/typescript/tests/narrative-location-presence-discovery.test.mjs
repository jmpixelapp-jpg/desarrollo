import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeLocationPresenceCandidates } from "../dist/motor-literario.js";

const ana = {
  projectId: "book-1", id: "character:ana", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};
const castle = {
  projectId: "book-1", id: "location:castle", kind: "location",
  canonicalName: "castillo", normalizedName: "castillo", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};

function discover(text, entities = [ana, castle], baseOffset = 0) {
  return discoverNarrativeLocationPresenceCandidates({
    projectId: "book-1", documentId: "chapter-1", revision: 4,
    text, entities, baseOffset
  });
}

test("extrae presencia explícita con evidencias separadas y offsets absolutos", () => {
  const text = "Ana está en el castillo.";
  const [candidate] = discover(text, [ana, castle], 75);
  assert.equal(candidate.characterEntityId, ana.id);
  assert.equal(candidate.locationEntityId, castle.id);
  assert.equal(candidate.effectStatus, "candidate");
  assert.equal(candidate.relationEvidence.excerpt, " en el ");
  assert.equal(candidate.locationEvidence.excerpt, "castillo");
  assert.equal(candidate.evidence.excerpt, text);
  for (const item of [
    candidate.characterEvidence, candidate.predicateEvidence,
    candidate.relationEvidence, candidate.locationEvidence, candidate.evidence
  ]) {
    assert.equal(
      text.slice(item.start - 75, item.end - 75),
      item.excerpt
    );
  }
});

test("distingue negación, futuro, condicional y percepción", () => {
  const negated = discover("Ana no está en el castillo.")[0];
  assert.equal(negated.polarity, "negated");
  assert.equal(negated.effectStatus, "not-applied");
  assert.equal(negated.predicateEvidence.excerpt, "no está");

  const future = discover("Ana estará en el castillo.")[0];
  assert.equal(future.grammaticalTense, "future");
  assert.equal(future.effectStatus, "prospective");

  const conditional = discover("Ana estaría en el castillo.")[0];
  assert.equal(conditional.grammaticalTense, "conditional");
  assert.equal(conditional.effectStatus, "hypothetical");

  const perceptual = discover("Ana parece estar en el castillo.")[0];
  assert.equal(perceptual.assertionMode, "perceptual");
});

test("no inventa presencia por proximidad, pronombres ni nombres ambiguos", () => {
  assert.deepEqual(discover("Ana cruzó el castillo."), []);
  assert.deepEqual(discover("Ella está en el castillo."), []);
  const duplicate = { ...ana, id: "character:ana-2" };
  assert.deepEqual(discover("Ana está en el castillo.", [ana, duplicate, castle]), []);
});

test("requiere entidad de tipo location y valida el contexto de entrada", () => {
  const wrongKind = { ...castle, kind: "object" };
  assert.deepEqual(discover("Ana está en el castillo.", [ana, wrongKind]), []);
  assert.throws(() => discover("Ana está en el castillo.", [ana, castle], -1));
  assert.throws(() => discover("x".repeat(2_000_001)));
});
