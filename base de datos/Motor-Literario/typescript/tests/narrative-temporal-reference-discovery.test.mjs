import test from "node:test";
import assert from "node:assert/strict";
import { discoverNarrativeTemporalReferenceCandidates } from "../dist/motor-literario.js";

function discover(text, baseOffset = 0) {
  return discoverNarrativeTemporalReferenceCandidates({
    projectId: "book-1", documentId: "chapter-1", revision: 6,
    text, baseOffset
  });
}

test("normaliza fechas ISO y fechas escritas en español con validación de calendario", () => {
  const text = "El 1945-03-12 ocurrió la llegada. El 29 de febrero de 2020 hubo otra escena.";
  const result = discover(text);
  assert.deepEqual(result.filter(item => item.kind === "calendar-date")
    .map(item => item.normalizedDate), ["1945-03-12", "2020-02-29"]);
  for (const item of result) {
    assert.equal(text.slice(item.evidence.start, item.evidence.end), item.evidence.excerpt);
  }
});

test("no inventa el orden de fechas numéricas ambiguas ni resuelve expresiones relativas", () => {
  const text = "El 12/03/1945 llegó Ana. Al día siguiente salió. Una semana después volvió; dos días antes había esperado.";
  const result = discover(text);
  const numeric = result.find(item => item.kind === "ambiguous-numeric-date");
  assert.equal(numeric.numericDateAmbiguity, "day-month-order-not-established");
  assert.equal(numeric.absoluteResolution, "ambiguous");
  const nextDay = result.find(item => item.surface.toLowerCase() === "al día siguiente");
  assert.equal(nextDay.relation, "next-day-after");
  assert.equal(nextDay.anchorRequired, true);
  assert.equal(nextDay.absoluteResolution, "unresolved-relative");
  const duration = result.find(item => item.surface.toLowerCase() === "una semana después");
  assert.equal(duration.kind, "relative-duration");
  assert.equal(duration.anchorRequired, true);
  assert.equal(duration.relation, "after");
  assert.equal(result.find(item => item.surface.toLowerCase() === "dos días antes").relation, "before");
});

test("distingue duraciones de tiempo transcurrido antes y después de un ancla", () => {
  const result = discover("Durante tres días esperó. Hace dos días había partido. Al cabo de una semana regresó.");
  assert.equal(result.find(item => item.surface === "Durante tres días").relation, "duration");
  assert.equal(result.find(item => item.surface === "Hace dos días").relation, "before");
  assert.equal(result.find(item => item.surface === "Al cabo de una semana").relation, "after");
});

test("extrae referencias de orden, franjas del día y horas sin asignar fecha absoluta", () => {
  const text = "Mientras esperaba, al amanecer miró el reloj a las 18:30.";
  const result = discover(text);
  assert.ok(result.some(item => item.relation === "simultaneous"));
  assert.ok(result.some(item => item.kind === "day-period" && item.surface === "al amanecer"));
  assert.ok(result.some(item => item.kind === "clock-time" && item.surface.endsWith("18:30")));
  assert.ok(result.filter(item => item.kind === "day-period" || item.kind === "clock-time")
    .every(item => item.absoluteResolution === "unresolved-relative"));
});

test("rechaza fechas imposibles, respeta offsets absolutos y valida límites", () => {
  const result = discover("La fecha fue 2019-02-29.", 90);
  assert.equal(result.some(item => item.kind === "calendar-date"), false);
  assert.equal(result.find(item => item.kind === "calendar-year").evidence.start, 103);
  assert.throws(() => discover("Ana llegó.", -1));
  assert.throws(() => discover("x".repeat(2_000_001)));
});
