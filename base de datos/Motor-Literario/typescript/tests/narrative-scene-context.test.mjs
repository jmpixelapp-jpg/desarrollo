import test from "node:test";
import assert from "node:assert/strict";
import {
  segmentNarrativeScenes,
  assignNarrativeEvidenceToScene
} from "../dist/motor-literario.js";

const context = { projectId: "book-1", documentId: "chapter-1", revision: 4 };

test("segmenta solo encabezados explícitos y conserva offsets UTF-16", () => {
  const prefix = "Prólogo.\n";
  const text = "Texto inicial.\nESCENA 1: La llegada\nMara entró.\n## Escena 2\nElian esperó.";
  const scenes = segmentNarrativeScenes({ ...context, text, baseOffset: prefix.length });
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].heading, "ESCENA 1: La llegada");
  assert.equal(scenes[0].content.excerpt, "Mara entró.\n");
  assert.equal(scenes[1].heading, "## Escena 2");
  assert.equal(scenes[0].headingEvidence.start, prefix.length + text.indexOf("ESCENA"));
});

test("reconoce encabezados de guion sin inventar escenas por cambio de párrafo", () => {
  const text = "INT. CASTILLO - NOCHE\nMara espera.\n\nLa puerta se abre.\nEXT. PATIO - DÍA\nElian llega.";
  const scenes = segmentNarrativeScenes({ ...context, text });
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].headingKind, "screenplay");
  assert.ok(scenes[0].content.excerpt.includes("La puerta se abre."));
});

test("no asigna texto anterior ni párrafos sin encabezado a una escena", () => {
  const text = "Inicio sin escena.\nMara caminó.\nOtro párrafo.";
  assert.deepEqual(segmentNarrativeScenes({ ...context, text }), []);
});

test("asigna evidencia solo cuando queda dentro de una escena explícita", () => {
  const text = "ESCENA 1\nMara encontró la llave.\nESCENA 2\nElian llegó.";
  const scenes = segmentNarrativeScenes({ ...context, text });
  const firstStart = text.indexOf("Mara encontró");
  const first = {
    id: "event:1",
    evidence: { start: firstStart, end: firstStart + "Mara encontró la llave.".length,
      excerpt: "Mara encontró la llave." }
  };
  const assigned = assignNarrativeEvidenceToScene(first, scenes);
  assert.equal(assigned.sceneAssignment, "explicit");
  assert.equal(assigned.sceneId, scenes[0].id);
});

test("no fuerza asignación cuando la evidencia cruza un límite de escena", () => {
  const text = "ESCENA 1\nMara.\nESCENA 2\nElian.";
  const scenes = segmentNarrativeScenes({ ...context, text });
  const candidate = { evidence: {
    start: text.indexOf("Mara"), end: text.indexOf("Elian.") + "Elian.".length,
    excerpt: "Mara.\nESCENA 2\nElian."
  }};
  assert.equal(assignNarrativeEvidenceToScene(candidate, scenes).sceneAssignment, "crosses-boundary");
});

test("rechaza contexto y rangos inválidos", () => {
  assert.throws(() => segmentNarrativeScenes({ ...context, projectId: " ", text: "" }));
  assert.throws(() => assignNarrativeEvidenceToScene({ evidence: { start: -1, end: 0, excerpt: "" } }, []));
});
