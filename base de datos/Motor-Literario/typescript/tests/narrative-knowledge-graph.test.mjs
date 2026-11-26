import test from "node:test";
import assert from "node:assert/strict";
import { buildNarrativeKnowledgeGraph } from "../dist/motor-literario.js";

test("integra entidades, relaciones, eventos, ideas y afirmaciones con evidencia", () => {
  const graph = buildNarrativeKnowledgeGraph("novel-a", [{
    documentId: "chapter-1",
    revision: 3,
    text: [
      "personaje Mara.",
      "personaje Leo.",
      "Mara es la hermana de Leo.",
      "Mara tiene 24 años y vive en Puerto Azul.",
      "EVENTO: Mara está viva el día 4.",
      "IDEA: La memoria familiar conecta a Mara con el pasado."
    ].join("\n")
  }], { sourceProjectName: "La novela", now: 1234 });

  assert.equal(graph.projectId, "novel-a");
  assert.equal(graph.documents.length, 1);
  assert.deepEqual(graph.entities.map(x => x.canonicalName).sort(), ["Leo", "Mara"]);
  assert.ok(graph.relations.some(x => x.relationType === "hermana"));
  assert.equal(graph.events.length, 1);
  assert.equal(graph.events[0].timeReference.basis, "story-day");
  assert.equal(graph.ideas.length, 1);
  assert.equal(graph.ideas[0].sourceProjectName, "La novela");
  assert.equal(graph.ideas[0].statusHistory[0].changedAt, 1234);
  assert.ok(graph.assertions.some(x => x.attribute === "age" && x.value === 24));
  assert.ok(graph.assertions.some(x => x.attribute === "location" && x.value === "Puerto Azul"));
  assert.equal(graph.consistency.length, 0);
  for (const assertion of graph.assertions) {
    assert.equal(assertion.projectId, "novel-a");
    assert.ok(assertion.evidence.start >= 0);
  }
});

test("consolida evidencia de una misma entidad entre documentos y ordena el resultado", () => {
  const graph = buildNarrativeKnowledgeGraph("novel-a", [
    { documentId: "b", revision: 1, text: "personaje Mara aparece." },
    { documentId: "a", revision: 2, text: "personaje Mara regresa." }
  ], { now: 100 });
  assert.equal(graph.entities.length, 1);
  assert.equal(graph.entities[0].evidence.length, 2);
  assert.equal(graph.entities[0].evidence[0].documentId, "a");
  assert.deepEqual(graph.documents.map(x => x.documentId), ["a", "b"]);
});

test("rechaza revisiones duplicadas y documentos inválidos", () => {
  assert.throws(() => buildNarrativeKnowledgeGraph("novel-a", [
    { documentId: "a", revision: 1, text: "uno" },
    { documentId: "a", revision: 1, text: "dos" }
  ]));
  assert.throws(() => buildNarrativeKnowledgeGraph("novel-a", [
    { documentId: "a", revision: 1, text: "versión anterior" },
    { documentId: "a", revision: 2, text: "versión actual" }
  ]), /única revisión seleccionada/u);
  assert.throws(() => buildNarrativeKnowledgeGraph("novel-a", [
    { documentId: "a", revision: -1, text: "uno" }
  ]));
  assert.throws(() => buildNarrativeKnowledgeGraph("", []));
});

test("respeta offsets absolutos al construir evidencia desde ventanas de texto", () => {
  const graph = buildNarrativeKnowledgeGraph("novel-a", [{
    documentId: "chapter-window",
    revision: 2,
    baseOffset: 500,
    text: "personaje Mara. Mara tiene 24 años."
  }], { now: 100 });
  assert.ok(graph.entities[0].evidence[0].start >= 500);
  assert.ok(graph.assertions[0].evidence.start >= 500);
});


test("reconoce marcadores de entidad sin distinguir mayúsculas", () => {
  const graph = buildNarrativeKnowledgeGraph("novel-case", [{
    documentId: "chapter-case",
    revision: 1,
    text: [
      "PERSONAJE Mara.",
      "personaje Leo.",
      "LUGAR Puerto Azul.",
      "OBJETO Espada Solar.",
      "personaje mara."
    ].join("\n")
  }]);

  assert.deepEqual(
    graph.entities.map(entity => entity.kind + ":" + entity.canonicalName).sort(),
    ["character:Leo", "character:Mara", "object:Espada Solar", "place:Puerto Azul"]
  );
});
