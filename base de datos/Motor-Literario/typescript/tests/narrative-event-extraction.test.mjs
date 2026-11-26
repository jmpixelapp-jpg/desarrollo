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
