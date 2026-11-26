import test from "node:test";
import assert from "node:assert/strict";
import { detectExplicitStateContradictions } from "../dist/motor-literario.js";

const projectId = "life-state-chronology";
const character = {
  projectId,
  id: "ana",
  kind: "character",
  canonicalName: "Ana",
  normalizedName: "ana",
  aliases: [],
  evidence: [],
  firstSeenAt: 1,
  lastSeenAt: 1,
  extractionVersion: 1
};

function event(id, label, orderValue, status) {
  return {
    projectId,
    id,
    label,
    participants: [character.id],
    evidence: [{
      documentId: "chapter-" + id,
      revision: 1,
      start: 0,
      end: label.length,
      excerpt: label,
      ...(status ? { status } : {})
    }],
    timeReference: {
      basis: "calendar",
      precision: "date",
      raw: label.match(/\\d{4}-\\d{2}-\\d{2}/)?.[0] ?? "explicit",
      orderValue
    }
  };
}

test("no clasifica como contradicción una muerte seguida de resurrección explícita y vida posterior", () => {
  const events = [
    event("death", "Ana está muerta el 2020-01-01", 18262),
    event("resurrection", "Ana resucitó el 2020-01-02", 18263),
    event("alive", "Ana está viva el 2020-01-03", 18264)
  ];
  assert.deepEqual(
    detectExplicitStateContradictions(projectId, events, [character]),
    []
  );
});

test("no acepta una resurrección cuya evidencia está obsoleta", () => {
  const events = [
    event("death", "Ana está muerta el 2020-01-01", 18262),
    event("resurrection", "Ana resucitó el 2020-01-02", 18263, "stale"),
    event("alive", "Ana está viva el 2020-01-03", 18264)
  ];
  assert.equal(
    detectExplicitStateContradictions(projectId, events, [character]).length,
    1
  );
});

test("conserva la contradicción cuando la vida posterior no tiene resurrección documentada", () => {
  const events = [
    event("death", "Ana está muerta el 2020-01-01", 18262),
    event("alive", "Ana está viva el 2020-01-03", 18264)
  ];
  assert.equal(
    detectExplicitStateContradictions(projectId, events, [character]).length,
    1
  );
});
