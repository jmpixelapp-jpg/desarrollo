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
});
