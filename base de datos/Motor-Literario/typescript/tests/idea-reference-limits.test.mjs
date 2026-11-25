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

test("reabrir una idea editada conserva el historial y agrega una transición monotónica", async () => {
  const { mergeNarrativeIdea } = await import("../dist/motor-literario.js");
  const previous = baseIdea({
    text: "Versión anterior de la idea.",
    status: "incorporated",
    statusHistory: [
      { status: "IDEA", reason: "initial", changedAt: 100 },
      { status: "incorporated", reason: "writer", changedAt: Number.MAX_SAFE_INTEGER }
    ]
  });
  const originalHistory = JSON.stringify(previous.statusHistory);
  const incoming = baseIdea({ text: "La idea fue revisada por el escritor." });

  const merged = mergeNarrativeIdea(previous, incoming);

  assert.equal(merged.status, "IDEA");
  assert.equal(merged.text, incoming.text);
  assert.equal(merged.statusHistory.length, 3);
  assert.deepEqual(merged.statusHistory.slice(0, 2), previous.statusHistory);
  assert.equal(merged.statusHistory[2].status, "IDEA");
  assert.equal(merged.statusHistory[2].reason, "text-revised");
  assert.equal(merged.statusHistory[2].changedAt, Number.MAX_SAFE_INTEGER);
  assert.equal(JSON.stringify(previous.statusHistory), originalHistory);
});

test("una idea sin cambios textuales no agrega transiciones editoriales", async () => {
  const { mergeNarrativeIdea } = await import("../dist/motor-literario.js");
  const previous = baseIdea({
    status: "discarded",
    statusHistory: [
      { status: "IDEA", reason: "initial", changedAt: 100 },
      { status: "discarded", reason: "writer", changedAt: 200 }
    ]
  });
  const incoming = baseIdea({ sourceProjectName: "Renamed book" });

  const merged = mergeNarrativeIdea(previous, incoming);

  assert.equal(merged.status, "discarded");
  assert.equal(merged.statusHistory.length, 2);
  assert.deepEqual(merged.statusHistory, previous.statusHistory);
  assert.equal(merged.sourceProjectName, "Renamed book");
});

test("fusionar ideas conserva evidencia histórica y deduplica solo registros idénticos", async () => {
  const { mergeNarrativeIdea } = await import("../dist/motor-literario.js");
  const currentEvidence = {
    documentId: "chapter",
    revision: 2,
    start: 10,
    end: 24,
    excerpt: "La puerta se abre."
  };
  const staleEvidence = { ...currentEvidence, revision: 1, status: "stale" };
  const previous = baseIdea({
    evidence: [currentEvidence, staleEvidence],
    relatedIdeaIds: ["idea-related"]
  });
  const incoming = baseIdea({
    evidence: [currentEvidence, {
      documentId: "chapter",
      revision: 3,
      start: 30,
      end: 42,
      excerpt: "La noche termina."
    }]
  });

  const merged = mergeNarrativeIdea(previous, incoming);

  assert.equal(merged.evidence.length, 3);
  assert.deepEqual(merged.evidence, [
    currentEvidence,
    staleEvidence,
    incoming.evidence[1]
  ]);
  assert.deepEqual(merged.relatedIdeaIds, ["idea-related"]);
  assert.equal(previous.evidence.length, 2);
});

test("fusionar ideas combina referencias explícitas sin duplicarlas y respeta el límite", async () => {
  const { mergeNarrativeIdea, MAX_NARRATIVE_IDEA_REFERENCES } =
    await import("../dist/motor-literario.js");
  const previous = baseIdea({
    relatedIdeaIds: ["idea-a", "idea-shared"]
  });
  const incoming = baseIdea({
    relatedIdeaIds: ["idea-shared", "idea-b"]
  });

  const merged = mergeNarrativeIdea(previous, incoming);
  assert.deepEqual(merged.relatedIdeaIds, ["idea-a", "idea-shared", "idea-b"]);
  assert.deepEqual(previous.relatedIdeaIds, ["idea-a", "idea-shared"]);
  assert.deepEqual(incoming.relatedIdeaIds, ["idea-shared", "idea-b"]);

  const tooMany = baseIdea({
    relatedIdeaIds: Array.from(
      { length: MAX_NARRATIVE_IDEA_REFERENCES },
      (_, index) => "existing-" + index
    )
  });
  const oneMore = baseIdea({ relatedIdeaIds: ["new-reference"] });
  assert.throws(
    () => mergeNarrativeIdea(tooMany, oneMore),
    /referencias explícitas de la idea superan el límite de 500/
  );
});

test("fusionar ideas conserva referencias a entidades y limita cada categoría por separado", async () => {
  const { mergeNarrativeIdea, MAX_NARRATIVE_IDEA_REFERENCES } =
    await import("../dist/motor-literario.js");
  const previous = baseIdea({
    relatedEntityIds: ["entity-a", "entity-shared"],
    relatedIdeaIds: ["idea-a"]
  });
  const incoming = baseIdea({
    relatedEntityIds: ["entity-shared", "entity-b"],
    relatedIdeaIds: ["idea-a", "idea-b"]
  });

  const merged = mergeNarrativeIdea(previous, incoming);
  assert.deepEqual(merged.relatedEntityIds, ["entity-a", "entity-shared", "entity-b"]);
  assert.deepEqual(merged.relatedIdeaIds, ["idea-a", "idea-b"]);

  const fullCategories = baseIdea({
    relatedEntityIds: Array.from(
      { length: MAX_NARRATIVE_IDEA_REFERENCES },
      (_, index) => "entity-" + index
    ),
    relatedIdeaIds: Array.from(
      { length: MAX_NARRATIVE_IDEA_REFERENCES },
      (_, index) => "idea-" + index
    )
  });
  const oneMoreEntity = baseIdea({ relatedEntityIds: ["entity-overflow"] });
  const oneMoreIdea = baseIdea({ relatedIdeaIds: ["idea-overflow"] });

  assert.equal(
    mergeNarrativeIdea(baseIdea(), fullCategories).relatedEntityIds.length,
    MAX_NARRATIVE_IDEA_REFERENCES
  );
  assert.equal(
    mergeNarrativeIdea(baseIdea(), fullCategories).relatedIdeaIds.length,
    MAX_NARRATIVE_IDEA_REFERENCES
  );
  assert.throws(
    () => mergeNarrativeIdea(fullCategories, oneMoreEntity),
    /referencias explícitas de cada categoría superan el límite de 500/
  );
  assert.throws(
    () => mergeNarrativeIdea(fullCategories, oneMoreIdea),
    /referencias explícitas de cada categoría superan el límite de 500/
  );
});
test("repetir la misma fusión de ideas es idempotente", async () => {
  const { mergeNarrativeIdea } = await import("../dist/motor-literario.js");
  const previous = baseIdea({
    text: "Idea original.",
    status: "incorporated",
    statusHistory: [
      { status: "IDEA", reason: "initial", changedAt: 10 },
      { status: "incorporated", reason: "writer", changedAt: 20 }
    ],
    relatedEntityIds: ["entity-a"],
    relatedIdeaIds: ["idea-a"],
    evidence: [{
      documentId: "chapter",
      revision: 1,
      start: 0,
      end: 12,
      excerpt: "Idea original."
    }]
  });
  const incoming = baseIdea({
    text: "Idea revisada.",
    relatedEntityIds: ["entity-b"],
    relatedIdeaIds: ["idea-b"],
    evidence: [{
      documentId: "chapter",
      revision: 2,
      start: 0,
      end: 14,
      excerpt: "Idea revisada."
    }]
  });

  const first = mergeNarrativeIdea(previous, incoming);
  const second = mergeNarrativeIdea(first, incoming);

  assert.deepEqual(second, first);
  assert.equal(second.statusHistory.length, 3);
  assert.deepEqual(second.relatedEntityIds, ["entity-a", "entity-b"]);
  assert.deepEqual(second.relatedIdeaIds, ["idea-a", "idea-b"]);
  assert.equal(second.evidence.length, 2);
});
