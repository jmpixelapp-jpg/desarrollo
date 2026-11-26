import test from "node:test";
import assert from "node:assert/strict";
import {
  createNarrativeKnowledgeGraphSnapshot,
  updateNarrativeKnowledgeGraphSnapshot
} from "../dist/motor-literario.js";

const chapter = (documentId, revision, text, baseOffset = 0) => ({
  documentId, revision, text, baseOffset
});

test("reutiliza documentos intactos y reconstruye solo la revisión modificada", () => {
  const initial = createNarrativeKnowledgeGraphSnapshot("novel-a", [
    chapter("chapter-a", 1, "personaje Mara aparece."),
    chapter("chapter-b", 1, "personaje Leo aparece.")
  ], { now: 100 });
  const update = updateNarrativeKnowledgeGraphSnapshot(initial, [
    chapter("chapter-a", 1, "personaje Mara aparece."),
    chapter("chapter-b", 2, "personaje Leo regresa.")
  ], { now: 200 });

  assert.deepEqual(update.reusedDocumentIds, ["chapter-a"]);
  assert.deepEqual(update.rebuiltDocumentIds, ["chapter-b"]);
  assert.deepEqual(update.removedDocumentIds, []);
  assert.deepEqual(update.snapshot.graph.documents, [
    { documentId: "chapter-a", revision: 1 },
    { documentId: "chapter-b", revision: 2 }
  ]);
  assert.equal(update.snapshot.graph.entities.length, 2);
});

test("elimina contribuciones documentales al retirar un capítulo", () => {
  const initial = createNarrativeKnowledgeGraphSnapshot("novel-a", [
    chapter("chapter-a", 1, "personaje Mara aparece."),
    chapter("chapter-b", 1, "personaje Leo aparece.")
  ], { now: 100 });
  const update = updateNarrativeKnowledgeGraphSnapshot(initial, [
    chapter("chapter-a", 1, "personaje Mara aparece.")
  ], { now: 200 });

  assert.deepEqual(update.removedDocumentIds, ["chapter-b"]);
  assert.deepEqual(update.reusedDocumentIds, ["chapter-a"]);
  assert.deepEqual(update.snapshot.graph.entities.map(x => x.canonicalName), ["Mara"]);
});

test("reconstruye si cambia texto u offset aunque se conserve el número de revisión", () => {
  const initial = createNarrativeKnowledgeGraphSnapshot("novel-a", [
    chapter("chapter-a", 1, "personaje Mara aparece.", 0)
  ], { now: 100 });
  const update = updateNarrativeKnowledgeGraphSnapshot(initial, [
    chapter("chapter-a", 1, "personaje Mara aparece en escena.", 500)
  ], { now: 200 });

  assert.deepEqual(update.rebuiltDocumentIds, ["chapter-a"]);
  assert.deepEqual(update.reusedDocumentIds, []);
  assert.ok(update.snapshot.graph.entities[0].evidence[0].start >= 500);
});

test("invalida todas las contribuciones si cambia el nombre de proyecto de origen", () => {
  const initial = createNarrativeKnowledgeGraphSnapshot("novel-a", [
    chapter("chapter-a", 1, "IDEA: La memoria transforma a Mara.")
  ], { sourceProjectName: "Primera", now: 100 });
  const update = updateNarrativeKnowledgeGraphSnapshot(initial, [
    chapter("chapter-a", 1, "IDEA: La memoria transforma a Mara.")
  ], { sourceProjectName: "Segunda", now: 200 });

  assert.deepEqual(update.rebuiltDocumentIds, ["chapter-a"]);
  assert.deepEqual(update.reusedDocumentIds, []);
  assert.equal(update.snapshot.graph.ideas[0].sourceProjectName, "Segunda");
});

test("rechaza documentos duplicados y snapshots previos inválidos", () => {
  const initial = createNarrativeKnowledgeGraphSnapshot("novel-a", []);
  assert.throws(() => updateNarrativeKnowledgeGraphSnapshot(initial, [
    chapter("same", 1, "uno"), chapter("same", 2, "dos")
  ]));
  assert.throws(() => updateNarrativeKnowledgeGraphSnapshot(null, []));
});
