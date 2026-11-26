import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrativeAssertions } from "../dist/motor-literario.js";

const entities = [
  { projectId:"novel", id:"mara", kind:"character", canonicalName:"Mara", normalizedName:"mara", aliases:[], evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1 },
  { projectId:"novel", id:"elian", kind:"character", canonicalName:"Elian", normalizedName:"elian", aliases:[], evidence:[], firstSeenAt:1, lastSeenAt:1, extractionVersion:1 }
];

test("no asigna a Mara la fecha de una oración posterior sobre Elian", () => {
  const text = "Mara tiene 19 años. Elian tiene 20 años el día 2030-04-02.";
  const assertions = extractNarrativeAssertions("novel", "chapter", 1, text, entities, 0, 10);
  const mara = assertions.find(item => item.entityId === "mara");
  const elian = assertions.find(item => item.entityId === "elian");
  assert.equal(mara?.value, 19);
  assert.equal(mara?.timeReference, undefined);
  assert.equal(elian?.value, 20);
  assert.equal(elian?.timeReference?.raw, "2030-04-02");
});

test("no elige arbitrariamente entre dos fechas en la misma oración", () => {
  const text = "Mara tiene 19 años entre 2030-04-02 y 2030-04-05.";
  const assertions = extractNarrativeAssertions("novel", "chapter", 1, text, entities, 0, 10);
  assert.equal(assertions.find(item => item.entityId === "mara")?.timeReference, undefined);
});

test("conserva offsets absolutos y evidencia de la afirmación extraída", () => {
  const text = "Mara tiene 19 años.";
  const assertions = extractNarrativeAssertions("novel", "chapter", 1, text, entities, 700, 10);
  assert.equal(assertions.length, 1);
  assert.equal(assertions[0].evidence.start, 700);
  assert.equal(assertions[0].evidence.end, 700 + text.length);
  assert.equal(text.slice(assertions[0].evidence.start - 700, assertions[0].evidence.end - 700), text);
});

test("rechaza entidades que no pertenecen al proyecto", () => {
  assert.throws(() => extractNarrativeAssertions(
    "novel", "chapter", 1, "Mara tiene 19 años.",
    [{ ...entities[0], projectId:"other" }]
  ), /proyecto/i);
});
