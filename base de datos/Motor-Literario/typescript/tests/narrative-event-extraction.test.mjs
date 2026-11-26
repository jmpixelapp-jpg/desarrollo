import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrativeEventCandidates } from "../dist/motor-literario.js";

const entities = [
  { projectId: "book-1", id: "character:mara", kind: "character", canonicalName: "Mara", normalizedName: "mara", aliases: [], evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1 },
  { projectId: "book-1", id: "character:elian", kind: "character", canonicalName: "Elian", normalizedName: "elian", aliases: [], evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1 },
  { projectId: "book-1", id: "object:espada", kind: "object", canonicalName: "Espada Solar", normalizedName: "espada solar", aliases: [], evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1 }
];
const context = { projectId: "book-1", documentId: "chapter-4", revision: 3, entities };

test("agrupa acciones de una oración y reúne participantes sin inferir causalidad", () => {
  const text = "Mara protegió a Elian y encontró la Espada Solar. Después Elian ayudó a Mara.";
  const events = extractNarrativeEventCandidates({ ...context, text });
  assert.equal(events.length, 2);
  assert.equal(events[0].actionCandidateIds.length, 2);
  assert.deepEqual(events[0].participantEntityIds, [
    "character:elian", "character:mara", "object:espada"
  ]);
  assert.equal(events[0].label, "Mara protegió a Elian y encontró la Espada Solar.");
  assert.equal(events[1].actionCandidateIds.length, 1);
  assert.equal(events.every(event => event.reviewStatus === "candidate"), true);
});

test("conserva offsets absolutos y no crea eventos sin acciones explícitas", () => {
  const prefix = "Texto previo.\n";
  const text = "Mara encontró la Espada Solar.";
  const events = extractNarrativeEventCandidates({
    ...context, text, baseOffset: prefix.length
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].evidence.start, prefix.length);
  assert.equal(events[0].evidence.excerpt, text);
  assert.deepEqual(extractNarrativeEventCandidates({
    ...context, text: "Mara estaba preocupada."
  }), []);
});


test("reconoce fechas explícitas y calcula un ordinal UTC reproducible", () => {
  const events = extractNarrativeEventCandidates({
    ...context, text: "El 2024-02-29 Mara encontró la Espada Solar."
  });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].timeReference, {
    basis: "calendar", precision: "date", raw: "2024-02-29",
    orderValue: Math.floor(Date.UTC(2024, 1, 29) / 86400000)
  });
});

test("reconoce día interno y año aislado sin inventar fecha completa", () => {
  const storyDay = extractNarrativeEventCandidates({
    ...context, text: "En el día 12 Mara encontró la Espada Solar."
  });
  assert.deepEqual(storyDay[0].timeReference, {
    basis: "story-day", precision: "day-index", raw: "día 12", orderValue: 12
  });
  const year = extractNarrativeEventCandidates({
    ...context, text: "En 1842 Mara encontró la Espada Solar."
  });
  assert.deepEqual(year[0].timeReference, {
    basis: "calendar", precision: "year", raw: "1842",
    orderValue: Math.floor(Date.UTC(1842, 0, 1) / 86400000)
  });
});

test("no asigna fechas inválidas ni elige entre referencias temporales múltiples", () => {
  const invalid = extractNarrativeEventCandidates({
    ...context, text: "El 2023-02-29 Mara encontró la Espada Solar."
  });
  assert.equal(invalid[0].timeReference, undefined);
  const ambiguous = extractNarrativeEventCandidates({
    ...context, text: "En 1842, el día 12, Mara encontró la Espada Solar."
  });
  assert.equal(ambiguous[0].timeReference, undefined);
});


test("acepta formato de fecha numérica español cuando el calendario es válido", () => {
  const events = extractNarrativeEventCandidates({
    ...context, text: "El 29/02/2024 Mara encontró la Espada Solar."
  });
  assert.deepEqual(events[0].timeReference, {
    basis: "calendar", precision: "date", raw: "29/02/2024",
    orderValue: Math.floor(Date.UTC(2024, 1, 29) / 86400000)
  });
});


test("reconoce fechas escritas en español y variantes de septiembre", () => {
  const march = extractNarrativeEventCandidates({
    ...context, text: "El 12 de marzo de 1842 Mara encontró la Espada Solar."
  });
  assert.deepEqual(march[0].timeReference, {
    basis: "calendar", precision: "date", raw: "12 de marzo de 1842",
    orderValue: Math.floor(Date.UTC(1842, 2, 12) / 86400000)
  });
  const september = extractNarrativeEventCandidates({
    ...context, text: "El 12 de setiembre de 1842 Mara encontró la Espada Solar."
  });
  assert.deepEqual(september[0].timeReference, {
    basis: "calendar", precision: "date", raw: "12 de setiembre de 1842",
    orderValue: Math.floor(Date.UTC(1842, 8, 12) / 86400000)
  });
});

test("rechaza fechas escritas imposibles y no las degrada a año aislado", () => {
  const events = extractNarrativeEventCandidates({
    ...context, text: "El 31 de febrero de 1842 Mara encontró la Espada Solar."
  });
  assert.equal(events[0].timeReference, undefined);
});
