import test from "node:test";
import assert from "node:assert/strict";
import { IndexedDbProjectStore } from "../dist/motor-literario.js";

const projectId = "idea-reference-limits";

function baseIdea(extra = {}) {
  return {
    projectId,
    id: "idea-source",
    text: "La idea conserva sus conexiones.",
    status: "IDEA",
    originDocumentId: "chapter",
    sourceProjectName: "Book",
    evidence: [],
    ...extra
  };
}

test("IndexedDB rechaza más de 500 referencias explícitas por categoría", async () => {
  const store = new IndexedDbProjectStore();
  const tooManyIdeaLinks = Array.from({ length: 501 }, (_, index) => "idea-" + index);
  const tooManyEntityLinks = Array.from({ length: 501 }, (_, index) => "entity-" + index);

  await assert.rejects(
    store.saveIdea(baseIdea({ relatedIdeaIds: tooManyIdeaLinks })),
    /superiores al límite de 500/
  );
  await assert.rejects(
    store.saveIdea(baseIdea({ relatedEntityIds: tooManyEntityLinks })),
    /superiores al límite de 500/
  );
  await assert.rejects(
    store.saveIdea(baseIdea({
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 1 },
        { status: "IDEA", reason: "writer", changedAt: 2 }
      ]
    })),
    /transición de estado inválida/
  );
  await assert.rejects(
    store.saveIdea(baseIdea({
      status: "discarded",
      statusHistory: [
        { status: "incorporated", reason: "initial", changedAt: 1 },
        { status: "discarded", reason: "text-revised", changedAt: 2 }
      ]
    })),
    /transición de estado inválida/
  );
});

test("calcula marcas temporales de decisiones sin retroceder ante relojes desincronizados", async () => {
  const { nextNarrativeIdeaStatusChangeAt } = await import("../dist/motor-literario.js");
  const history = [
    { status: "IDEA", reason: "initial", changedAt: 100 },
    { status: "incorporated", reason: "writer", changedAt: 250 },
    { status: "IDEA", reason: "text-revised" }
  ];

  const frozenHistory = Object.freeze(history.map(change => Object.freeze({ ...change })));
  const before = JSON.stringify(frozenHistory);
  assert.equal(nextNarrativeIdeaStatusChangeAt(frozenHistory, 200), 250);
  assert.equal(nextNarrativeIdeaStatusChangeAt(frozenHistory, 300), 300);
  assert.equal(nextNarrativeIdeaStatusChangeAt([], 0), 0);
  assert.equal(JSON.stringify(frozenHistory), before);
});

test("rechaza historiales y relojes inválidos al calcular decisiones narrativas", async () => {
  const { nextNarrativeIdeaStatusChangeAt } = await import("../dist/motor-literario.js");

  assert.throws(() => nextNarrativeIdeaStatusChangeAt(null, 1), /Historial o reloj/);
  assert.throws(() => nextNarrativeIdeaStatusChangeAt([], Number.NaN), /Historial o reloj/);
  assert.throws(() => nextNarrativeIdeaStatusChangeAt([], Number.POSITIVE_INFINITY), /Historial o reloj/);
  assert.throws(() => nextNarrativeIdeaStatusChangeAt([], "100"), /Historial o reloj/);
  assert.throws(() => nextNarrativeIdeaStatusChangeAt([], -1), /Historial o reloj/);
  assert.throws(() => nextNarrativeIdeaStatusChangeAt([null], 1), /decisión narrativa inválida/);
  assert.throws(() => nextNarrativeIdeaStatusChangeAt(["IDEA"], 1), /decisión narrativa inválida/);
  assert.throws(() => nextNarrativeIdeaStatusChangeAt([
    { status: "IDEA", changedAt: 10 }
  ], 1), /decisión narrativa inválida/);
  assert.throws(() => nextNarrativeIdeaStatusChangeAt([
    { status: "pending", reason: "writer", changedAt: 10 }
  ], 1), /decisión narrativa inválida/);
  assert.throws(() => nextNarrativeIdeaStatusChangeAt([
    { status: "IDEA", reason: "import", changedAt: 10 }
  ], 1), /decisión narrativa inválida/);
  assert.throws(() => nextNarrativeIdeaStatusChangeAt([
    { status: "IDEA", reason: "initial", changedAt: "10" }
  ], 1), /marca temporal inválida/);
  assert.throws(() => nextNarrativeIdeaStatusChangeAt([
    { status: "IDEA", reason: "initial", changedAt: Number.POSITIVE_INFINITY }
  ], 1), /marca temporal inválida/);
  assert.throws(() => nextNarrativeIdeaStatusChangeAt([
    { status: "IDEA", reason: "initial", changedAt: -1 }
  ], 1), /marca temporal inválida/);
});

