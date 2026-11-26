import test from "node:test";
import assert from "node:assert/strict";
import {
  attributeNarrativeIdeasToEntities,
  understandNarrativeFragment
} from "../dist/motor-literario.js";

function entity(id, canonicalName, aliases = []) {
  return {
    projectId: "book-1",
    id,
    kind: "character",
    canonicalName,
    normalizedName: canonicalName.toLocaleLowerCase("es"),
    aliases,
    evidence: [],
    firstSeenAt: 0,
    lastSeenAt: 0,
    extractionVersion: 1
  };
}

function idea(id, excerpt, text, documentId = "chapter-1") {
  const start = excerpt.indexOf(text);
  return {
    id,
    projectId: "book-1",
    documentId,
    revision: 2,
    kind: "goal",
    text,
    confidence: "high",
    polarity: "affirmed",
    reviewStatus: "candidate",
    evidence: { start: 10 + start, end: 10 + start + text.length, excerpt }
  };
}

test("atribuye una idea al personaje nombrado antes de la expresión de la idea", () => {
  const candidate = idea("idea-1", "Mara desea ayudar a Elian.", "ayudar a Elian");
  const result = attributeNarrativeIdeasToEntities({
    projectId: "book-1",
    ideas: [candidate],
    entities: [entity("mara", "Mara"), entity("elian", "Elian")]
  });

  assert.equal(result[0].status, "attributed");
  assert.equal(result[0].entityId, "mara");
  assert.deepEqual(result[0].candidateEntityIds, ["mara"]);
});

test("no confunde al personaje nombrado como objetivo con el titular de la idea", () => {
  const candidate = idea("idea-2", "Mara desea proteger a Elian.", "proteger a Elian");
  const result = attributeNarrativeIdeasToEntities({
    projectId: "book-1",
    ideas: [candidate],
    entities: [entity("mara", "Mara"), entity("elian", "Elian")]
  });

  assert.equal(result[0].entityId, "mara");
});

test("conserva ambigüedad cuando dos personajes preceden a la idea", () => {
  const candidate = idea("idea-3", "Mara y Elian desean proteger el reino.", "proteger el reino");
  const result = attributeNarrativeIdeasToEntities({
    projectId: "book-1",
    ideas: [candidate],
    entities: [entity("mara", "Mara"), entity("elian", "Elian")]
  });

  assert.equal(result[0].status, "ambiguous");
  assert.equal("entityId" in result[0], false);
  assert.deepEqual(result[0].candidateEntityIds, ["elian", "mara"]);
});

test("no atribuye una idea cuando no hay un personaje explícito antes de ella", () => {
  const candidate = idea("idea-4", "La historia explora el sacrificio.", "el sacrificio");
  const result = attributeNarrativeIdeasToEntities({
    projectId: "book-1",
    ideas: [candidate],
    entities: [entity("mara", "Mara")]
  });

  assert.equal(result[0].status, "unattributed");
  assert.deepEqual(result[0].candidateEntityIds, []);
});

test("un alias compartido entre identidades produce ambigüedad", () => {
  const candidate = idea("idea-5", "La capitana desea proteger la ciudad.", "proteger la ciudad");
  const result = attributeNarrativeIdeasToEntities({
    projectId: "book-1",
    ideas: [candidate],
    entities: [
      entity("mara", "Mara", ["la capitana"]),
      entity("ines", "Inés", ["la capitana"])
    ]
  });

  assert.equal(result[0].status, "ambiguous");
  assert.deepEqual(result[0].candidateEntityIds, ["ines", "mara"]);
});

test("se abstiene si el texto candidato aparece varias veces en la evidencia", () => {
  const candidate = idea("idea-6", "Mara desea ayudar a Mara.", "Mara");
  const result = attributeNarrativeIdeasToEntities({
    projectId: "book-1",
    ideas: [candidate],
    entities: [entity("mara", "Mara")]
  });

  assert.equal(result[0].status, "unattributed");
});

test("rechaza entidades duplicadas y candidatos de otro proyecto", () => {
  const candidate = idea("idea-7", "Mara desea proteger el reino.", "proteger el reino");
  assert.throws(() => attributeNarrativeIdeasToEntities({
    projectId: "book-1",
    ideas: [candidate],
    entities: [entity("mara", "Mara"), entity("mara", "Mara")]
  }));
  assert.throws(() => attributeNarrativeIdeasToEntities({
    projectId: "book-1",
    ideas: [{ ...candidate, projectId: "other-book" }],
    entities: [entity("mara", "Mara")]
  }));
});

test("el pipeline publica atribuciones de ideas con procedencia compartida", () => {
  const result = understandNarrativeFragment({
    projectId: "book-1",
    documentId: "chapter-1",
    revision: 2,
    text: "Mara desea encontrar a su hermano.",
    entities: [entity("mara", "Mara")]
  });

  assert.equal(result.ideas.length, 1);
  assert.equal(result.ideaEntityAttributions.length, 1);
  assert.equal(result.ideaEntityAttributions[0].ideaCandidateId, result.ideas[0].id);
  assert.equal(result.ideaEntityAttributions[0].entityId, "mara");
  assert.deepEqual(result.ideaEntityAttributions[0].evidence, result.ideas[0].evidence);
});


test("atribuye correctamente cuando la evidencia conserva espacios repetidos del manuscrito", () => {
  const excerpt = "Mara desea proteger   a Elian.";
  const originalSpan = "proteger   a Elian";
  const start = 50 + excerpt.indexOf("proteger");
  const candidate = {
    ...idea("idea-whitespace", "Mara desea proteger a Elian.", "proteger a Elian"),
    evidence: {
      documentId: "chapter-1",
      revision: 3,
      start,
      end: start + originalSpan.length,
      excerpt
    }
  };

  const result = attributeNarrativeIdeasToEntities({
    projectId: "book-1",
    ideas: [candidate],
    entities: [entity("mara", "Mara"), entity("elian", "Elian")]
  });

  assert.equal(result[0].status, "attributed");
  assert.equal(result[0].entityId, "mara");
  assert.equal(result[0].evidence.excerpt, excerpt);
});
