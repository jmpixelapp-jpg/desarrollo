import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeObservationCandidates } from "../dist/motor-literario.js";

const character = {
  projectId: "book-1", id: "entity:character:ana", kind: "character",
  canonicalName: "Ana", normalizedName: "ana", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};
const other = {
  projectId: "book-1", id: "entity:object:espada", kind: "object",
  canonicalName: "Espada Solar", normalizedName: "espada solar", aliases: [],
  evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
};
const context = {
  projectId: "book-1", documentId: "chapter-1", revision: 7,
  entities: [character, other]
};

test("detecta acciones explícitas de un personaje conocido y conserva la frase probatoria", () => {
  const text = "Ana cruzó el puente y abrió la Espada Solar.";
  const found = discoverNarrativeObservationCandidates({ ...context, text });
  assert.deepEqual(found.map(item => item.action), ["cruzar", "abrir"]);
  assert.ok(found.every(item => item.singleMentionedCharacterId === character.id));
  assert.ok(found.every(item => item.mentionedEntityIds.includes(other.id)));
  assert.ok(found.every(item => item.evidence.excerpt === text));
  assert.ok(found.every(item => item.evidence.revision === 7));
});

test("no atribuye un sujeto cuando aparecen varios personajes", () => {
  const bruno = { ...character, id: "entity:character:bruno", canonicalName: "Bruno" };
  const text = "Ana ayudó a Bruno durante la huida.";
  const found = discoverNarrativeObservationCandidates({
    ...context, entities: [character, bruno], text
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].singleMentionedCharacterId, undefined);
  assert.deepEqual(found[0].mentionedCharacterIds.sort(), [character.id, bruno.id].sort());
});

test("no presenta al único personaje mencionado como agente gramatical", () => {
  const text = "Ana fue encontrada por el guardia.";
  const found = discoverNarrativeObservationCandidates({ ...context, text });
  assert.equal(found.length, 1);
  assert.equal(found[0].singleMentionedCharacterId, character.id);
  assert.equal("actorEntityId" in found[0], false);
});

test("marca negación explícita sin convertirla en acción afirmada", () => {
  const found = discoverNarrativeObservationCandidates({
    ...context, text: "Ana no abrió la puerta."
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].action, "abrir");
  assert.equal(found[0].polarity, "negated");
});

test("mantiene offsets UTF-16 absolutos y no inventa acciones sin personajes conocidos", () => {
  const prefix = "Prólogo.\n";
  const text = "Ana encontró la carta.";
  const found = discoverNarrativeObservationCandidates({
    ...context, text, baseOffset: prefix.length
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].evidence.start, prefix.length);
  assert.equal(found[0].evidence.end, prefix.length + text.length);
  assert.deepEqual(discoverNarrativeObservationCandidates({
    ...context, entities: [], text
  }), []);
});

test("rechaza entidades ajenas al proyecto y límites inválidos", () => {
  assert.throws(() => discoverNarrativeObservationCandidates({
    ...context, entities: [{ ...character, projectId: "another-book" }], text: "Ana corrió."
  }));
  assert.throws(() => discoverNarrativeObservationCandidates({
    ...context, baseOffset: -1, text: "Ana corrió."
  }));
});
