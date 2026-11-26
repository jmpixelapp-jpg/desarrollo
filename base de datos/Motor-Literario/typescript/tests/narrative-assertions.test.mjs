import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrativeAssertions } from "../dist/motor-literario.js";

function character(overrides = {}) {
  return {
    projectId: "novel-a",
    id: "character-mara",
    kind: "character",
    canonicalName: "Mara",
    normalizedName: "mara",
    aliases: ["La capitana"],
    evidence: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
    extractionVersion: 1,
    ...overrides
  };
}

test("extrae edad, ubicación y rol con offsets absolutos y evidencia de revisión", () => {
  const prefix = "Capítulo anterior.\n";
  const paragraph = "Día 12 — Mara tiene 27 años y vive en Puerto Azul. Mara es la capitana.";
  const assertions = extractNarrativeAssertions(
    "novel-a", "chapter-2", 4, prefix + paragraph, [character()], prefix.length, 900
  );

  assert.deepEqual(assertions.map(item => [item.attribute, item.value]), [
    ["age", 27],
    ["location", "Puerto Azul"],
    ["role", "capitana"]
  ]);
  assert.ok(assertions.every(item => item.projectId === "novel-a"));
  assert.ok(assertions.every(item => item.evidence.documentId === "chapter-2"));
  assert.ok(assertions.every(item => item.evidence.revision === 4));
  assert.ok(assertions.every(item => item.evidence.start >= prefix.length));
  assert.ok(assertions.every(item => item.evidence.end > item.evidence.start));
  assert.ok(assertions.every(item => item.capturedAt === 900));
  assert.equal(assertions[0].timeReference.basis, "story-day");
  assert.equal(assertions[0].timeReference.orderValue, 12);
});

test("reconoce alias y no extrae atributos de entidades que no sean personajes", () => {
  const entities = [
    character(),
    character({
      id: "place-puerto",
      kind: "location",
      canonicalName: "Puerto Azul",
      normalizedName: "puerto azul",
      aliases: []
    })
  ];
  const assertions = extractNarrativeAssertions(
    "novel-a", "chapter-1", 1,
    "La capitana tiene 31 años y reside en Isla Norte.", entities
  );
  assert.equal(assertions.length, 2);
  assert.deepEqual(assertions.map(item => item.attribute), ["age", "location"]);
  assert.ok(assertions.every(item => item.entityId === "character-mara"));
});

test("selecciona la referencia temporal explícita más cercana a la afirmación", () => {
  const assertions = extractNarrativeAssertions(
    "novel-a", "chapter-date", 2,
    "2024-01-01. Mara tiene 27 años. En 2025-06-03, Mara vive en Puerto Azul.",
    [character()]
  );
  const age = assertions.find(item => item.attribute === "age");
  const location = assertions.find(item => item.attribute === "location");
  assert.equal(age.timeReference.raw, "2024-01-01");
  assert.equal(location.timeReference.raw, "2025-06-03");
  assert.equal(age.timeReference.precision, "date");
});

test("rechaza entidades de otro proyecto y contextos inválidos", () => {
  assert.throws(() => extractNarrativeAssertions(
    "novel-a", "chapter-1", 1, "Mara tiene 27 años.",
    [character({ projectId: "novel-b" })]
  ), /otro proyecto/u);

  for (const args of [
    ["", "chapter-1", 1, "Mara tiene 27 años.", [character()]],
    ["novel-a", "", 1, "Mara tiene 27 años.", [character()]],
    ["novel-a", "chapter-1", -1, "Mara tiene 27 años.", [character()]],
    ["novel-a", "chapter-1", 1, "Mara tiene 27 años.", [character()], -1]
  ]) {
    assert.throws(() => extractNarrativeAssertions(...args));
  }
});

test("no inventa atributos ni referencias temporales ausentes", () => {
  const assertions = extractNarrativeAssertions(
    "novel-a", "chapter-empty", 1,
    "Mara caminó bajo la lluvia y recordó su infancia.",
    [character()]
  );
  assert.deepEqual(assertions, []);
});
