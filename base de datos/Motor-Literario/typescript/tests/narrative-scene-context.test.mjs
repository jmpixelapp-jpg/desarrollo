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


import { buildNarrativeCharacterSceneContinuity } from "../dist/motor-literario.js";

test("construye continuidad solo con participantes explícitos en escenas verificadas", () => {
  const text = "ESCENA 1\\nMara abre la puerta.\\nESCENA 2\\nMara encuentra a Elian.";
  const scenes = segmentNarrativeScenes({ ...context, text });
  const evidenceFor = (excerpt) => {
    const start = text.indexOf(excerpt);
    return { documentId: context.documentId, revision: context.revision,
      start, end: start + excerpt.length, excerpt };
  };
  const continuity = buildNarrativeCharacterSceneContinuity([
    { projectId: context.projectId, id: "event-1", participants: ["mara"],
      evidence: [evidenceFor("Mara abre la puerta.")] },
    { projectId: context.projectId, id: "event-2", participants: ["mara", "elian"],
      evidence: [evidenceFor("Mara encuentra a Elian.")] }
  ], scenes);
  const mara = continuity.find(item => item.characterId === "mara");
  assert.deepEqual(mara.sceneIds, [scenes[0].id, scenes[1].id]);
  assert.equal(mara.appearanceCount, 2);
  assert.equal(mara.firstSceneOrdinal, 1);
  assert.equal(mara.lastSceneOrdinal, 2);
  assert.deepEqual(continuity.find(item => item.characterId === "elian").sceneIds, [scenes[1].id]);
});

test("no inventa continuidad para evidencia fuera de escena o que cruza límites", () => {
  const text = "ESCENA 1\\nMara habla.\\nESCENA 2\\nElian responde.";
  const scenes = segmentNarrativeScenes({ ...context, text });
  const crossStart = text.indexOf("Mara habla.");
  const crossing = { documentId: context.documentId, revision: context.revision,
    start: crossStart, end: text.indexOf("Elian responde.") + "Elian responde.".length,
    excerpt: "Mara habla.\\nESCENA 2\\nElian responde." };
  const continuity = buildNarrativeCharacterSceneContinuity([
    { projectId: context.projectId, id: "cross", participants: ["mara"], evidence: [crossing] }
  ], scenes);
  assert.deepEqual(continuity, []);
});

test("no mezcla revisiones ni documentos al enlazar escenas", () => {
  const text = "ESCENA 1\\nMara habla.";
  const scenes = segmentNarrativeScenes({ ...context, text });
  const evidence = { documentId: "other-document", revision: context.revision,
    start: text.indexOf("Mara"), end: text.length, excerpt: "Mara habla." };
  const continuity = buildNarrativeCharacterSceneContinuity([
    { projectId: context.projectId, id: "wrong-doc", participants: ["mara"], evidence: [evidence] }
  ], scenes);
  assert.deepEqual(continuity, []);
});

test("rechaza eventos duplicados y estructuras inválidas", () => {
  const text = "ESCENA 1\\nMara habla.";
  const scenes = segmentNarrativeScenes({ ...context, text });
  const evidence = { documentId: context.documentId, revision: context.revision,
    start: text.indexOf("Mara"), end: text.length, excerpt: "Mara habla." };
  const event = { projectId: context.projectId, id: "duplicate", participants: ["mara"], evidence: [evidence] };
  assert.throws(() => buildNarrativeCharacterSceneContinuity([event, event], scenes));
  assert.throws(() => buildNarrativeCharacterSceneContinuity([null], scenes));
});
