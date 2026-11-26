import test from "node:test";
import assert from "node:assert/strict";
import { analyzeNarrativeConsistency } from "../dist/motor-literario.js";

function assertion(overrides = {}) {
  const start = overrides.start ?? 0;
  return {
    projectId: "novel-a",
    id: "assertion-" + start,
    entityId: "mara",
    entityName: "Mara",
    attribute: "location",
    value: "Puerto Azul",
    evidence: {
      documentId: "chapter-" + start,
      revision: 1,
      start,
      end: start + 10,
      excerpt: "Mara vive en Puerto Azul."
    },
    capturedAt: 100,
    ...overrides
  };
}

const calendar = (raw, orderValue, precision = "date") => ({
  basis: "calendar", precision, raw, orderValue
});
const storyDay = (raw, orderValue) => ({
  basis: "story-day", precision: "day-index", raw, orderValue
});

test("marca conflicto cuando dos valores distintos comparten el mismo instante explícito", () => {
  const result = analyzeNarrativeConsistency("novel-a", [
    assertion({ value: "Puerto Azul", start: 1, timeReference: calendar("2030-04-02", 22005) }),
    assertion({ value: "Isla Norte", start: 20, timeReference: calendar("2030-04-02", 22005) })
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].classification, "same-time-conflict");
  assert.equal(result[0].evidence.length, 2);
  assert.match(result[0].explanation, /misma referencia temporal/u);
});

test("clasifica valores diferentes en fechas ordenables como evolución, no contradicción", () => {
  const result = analyzeNarrativeConsistency("novel-a", [
    assertion({ value: "Puerto Azul", start: 1, timeReference: calendar("2030-04-02", 22005) }),
    assertion({ value: "Isla Norte", start: 20, timeReference: calendar("2030-04-03", 22006) })
  ]);
  assert.equal(result[0].classification, "temporal-change");
});

test("no compara como simultáneos un año y una fecha de precisión distinta", () => {
  const result = analyzeNarrativeConsistency("novel-a", [
    assertion({ value: "Puerto Azul", start: 1, timeReference: calendar("año 2030", 21915, "year") }),
    assertion({ value: "Isla Norte", start: 20, timeReference: calendar("2030-01-01", 21915, "date") })
  ]);
  assert.equal(result[0].classification, "time-incomparable");
});

test("no ordena entre calendario y contador de día narrativo", () => {
  const result = analyzeNarrativeConsistency("novel-a", [
    assertion({ value: "Puerto Azul", start: 1, timeReference: calendar("2030-04-02", 22005) }),
    assertion({ value: "Isla Norte", start: 20, timeReference: storyDay("día 20", 20) })
  ]);
  assert.equal(result[0].classification, "time-incomparable");
});

test("sin fecha explícita solicita revisión y no declara contradicción", () => {
  const result = analyzeNarrativeConsistency("novel-a", [
    assertion({ value: "Puerto Azul", start: 1 }),
    assertion({ value: "Isla Norte", start: 20, timeReference: calendar("2030-04-02", 22005) })
  ]);
  assert.equal(result[0].classification, "time-incomparable");
});

test("aísla proyectos, ignora evidencia obsoleta y no duplica un mismo valor", () => {
  const result = analyzeNarrativeConsistency("novel-a", [
    assertion({ value: "Puerto Azul", start: 1, timeReference: calendar("2030-04-02", 22005) }),
    assertion({ value: "Puerto Azul", start: 20, timeReference: calendar("2030-04-02", 22005) }),
    assertion({ projectId: "novel-b", value: "Isla Norte", start: 30, timeReference: calendar("2030-04-02", 22005) }),
    assertion({
      value: "Isla Norte", start: 40, timeReference: calendar("2030-04-02", 22005),
      evidence: { documentId: "old", revision: 1, start: 40, end: 50, excerpt: "old", status: "stale" }
    })
  ]);
  assert.deepEqual(result, []);
});

test("rechaza contexto y afirmaciones mal formadas", () => {
  assert.throws(() => analyzeNarrativeConsistency("", []));
  assert.throws(() => analyzeNarrativeConsistency("novel-a", [assertion({ attribute: "unknown" })]));
});
