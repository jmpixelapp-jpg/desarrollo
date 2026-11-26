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

test("distingue formas verbales sin convertir el tiempo gramatical en cronología", () => {
  const forms = [
    ["Ana cruzó el puente.", "past-preterite"],
    ["Ana cruzaba el puente.", "past-imperfect"],
    ["Ana cruza el puente.", "present"],
    ["Ana cruzar el puente.", "infinitive"],
    ["Ana cruzando el puente.", "gerund"]
  ];
  for (const [text, expected] of forms) {
    const found = discoverNarrativeObservationCandidates({ ...context, text });
    assert.equal(found[0]?.grammaticalTense, expected, text);
  }
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

test("detecta pronombres narrativos y conserva candidatos de antecedente sin resolverlos", () => {
  const text = "Ana entró en la habitación. Ella corrió hacia la ventana.";
  const found = discoverNarrativeObservationCandidates({ ...context, text });
  const pronounAction = found.find(item => item.action === "correr");
  assert.ok(pronounAction);
  assert.deepEqual(pronounAction.mentionedCharacterIds, []);
  assert.equal(pronounAction.unresolvedReferences?.[0]?.pronoun, "Ella");
  assert.deepEqual(pronounAction.unresolvedReferences?.[0]?.candidateEntityIds, [character.id]);
  assert.equal(pronounAction.unresolvedReferences?.[0]?.antecedentEvidence?.excerpt,
    "Ana entró en la habitación.");
  assert.equal(pronounAction.unresolvedReferences?.[0]?.evidence.excerpt,
    "Ella");
});

test("reconoce pronombre con espacios iniciales y conserva offsets UTF-16 exactos", () => {
  const prefix = "😀 Prólogo.\n";
  const text = "   Ella cruzó el puente.";
  const found = discoverNarrativeObservationCandidates({
    ...context, text, baseOffset: prefix.length
  });
  assert.equal(found.length, 1);
  const reference = found[0].unresolvedReferences?.[0];
  assert.equal(reference?.pronoun, "Ella");
  assert.equal(reference?.evidence.start, prefix.length + 3);
  assert.equal(reference?.evidence.end, prefix.length + 7);
  assert.equal(reference?.evidence.excerpt, "Ella");
});

test("no inventa un antecedente cuando el pronombre aparece sin contexto previo", () => {
  const found = discoverNarrativeObservationCandidates({
    ...context, text: "Ella corrió hacia la ventana."
  });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].unresolvedReferences?.[0]?.candidateEntityIds, []);
});

test("no presenta al único personaje mencionado como agente gramatical", () => {
  const text = "Ana fue encontrada por el guardia.";
  const found = discoverNarrativeObservationCandidates({ ...context, text });
  assert.equal(found.length, 1);
  assert.equal(found[0].singleMentionedCharacterId, character.id);
  assert.equal("actorEntityId" in found[0], false);
});

test("propone sujeto gramatical solo con patrón local explícito y distingue voz pasiva", () => {
  const active = discoverNarrativeObservationCandidates({
    ...context, text: "Ana no abrió la puerta."
  })[0];
  assert.equal(active?.grammaticalSubjectCandidate?.entityId, character.id);
  assert.equal(active?.grammaticalSubjectCandidate?.voice, "active");
  assert.equal(active?.grammaticalSubjectCandidate?.evidence.excerpt, "Ana");

  const passive = discoverNarrativeObservationCandidates({
    ...context, text: "Ana fue encontrada por el guardia."
  })[0];
  assert.equal(passive?.grammaticalSubjectCandidate?.entityId, character.id);
  assert.equal(passive?.grammaticalSubjectCandidate?.voice, "passive");
  assert.equal(passive?.singleMentionedCharacterId, character.id);
  assert.equal("actorEntityId" in (passive ?? {}), false);
});

test("no atribuye sujeto cuando el personaje aparece después del verbo o como complemento", () => {
  const found = discoverNarrativeObservationCandidates({
    ...context, text: "A Ana la encontró Bruno."
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.grammaticalSubjectCandidate, undefined);
});

test("reconoce participios pasivos sin atribuir el papel de agente al personaje", () => {
  const found = discoverNarrativeObservationCandidates({
    ...context, text: "Ana fue encontrada por el guardia."
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].action, "encontrar");
  assert.equal(found[0].grammaticalTense, "participle");
  assert.equal(found[0].singleMentionedCharacterId, character.id);
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
