import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrativeEvents } from "../dist/motor-literario.js";

function character(id, canonicalName) {
  return {
    projectId: "unicode-event-boundaries",
    id,
    kind: "character",
    canonicalName,
    normalizedName: canonicalName.normalize("NFKC").trim().replace(/\\s+/gu, " ").toLocaleLowerCase("es"),
    aliases: [],
    evidence: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
    extractionVersion: 1
  };
}

test("un nombre no coincide parcialmente antes de una marca combinante en participantes", () => {
  const text = "ACONTECIMIENTO: Ana\\u0301 desaparece.";
  const events = extractNarrativeEvents(
    "unicode-event-boundaries",
    "chapter",
    1,
    text,
    [character("ana", "Ana")]
  );

  assert.equal(events.length, 1);
  assert.deepEqual(events[0].participants, []);
});

test("un nombre que contiene una marca combinante sí coincide de forma completa", () => {
  const decomposedName = "Ana\\u0301";
  const text = `ACONTECIMIENTO: ${decomposedName} desaparece.`;
  const events = extractNarrativeEvents(
    "unicode-event-boundaries",
    "chapter",
    1,
    text,
    [character("ana-decomposed", decomposedName)]
  );

  assert.equal(events.length, 1);
  assert.deepEqual(events[0].participants, ["ana-decomposed"]);
  assert.equal(
    text.slice(events[0].evidence[0].start, events[0].evidence[0].end),
    events[0].label
  );
});
