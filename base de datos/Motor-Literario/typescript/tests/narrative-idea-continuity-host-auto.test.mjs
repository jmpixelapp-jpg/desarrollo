import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import "fake-indexeddb/auto";
import {
  HostEngineApi,
  IndexedDbProjectStore
} from "../dist/motor-literario.js";

function projectId() {
  return "automatic-continuity-" + randomUUID();
}

test("al abrir capítulos genera y persiste automáticamente continuidad entre candidatos", async () => {
  const store = new IndexedDbProjectStore();
  const id = projectId();
  const notices = [];
  const api = new HostEngineApi({
    store,
    getOrderedDocumentIds: () => ["chapter-1", "chapter-2"],
    callbacks: {
      onNarrativeIdeaContinuityIndexUpdated: notice => notices.push(notice)
    }
  });

  try {
    api.initializeProject({ projectId: id, projectName: "La ciudad de la memoria" });
    await api.openDocument({
      documentId: "chapter-1",
      text: "El tema central es la memoria compartida que une a dos ciudades.",
      revision: 0,
      sequence: 0
    });
    await api.openDocument({
      documentId: "chapter-2",
      text: "El tema central es la memoria compartida que une a dos ciudades.",
      revision: 0,
      sequence: 0
    });
    await api.flushPendingChanges();

    const index = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(index);
    assert.equal(index.sourceRevisions.length, 2);
    assert.equal(index.occurrences.length, 2);
    assert.equal(index.events.length, 1);
    assert.equal(index.lines.length, 1);
    assert.equal(index.events[0].chronology, "ordered");
    assert.ok(notices.some(notice =>
      notice.projectId === id &&
      notice.index.fingerprint === index.fingerprint &&
      notice.sourceDocumentCount === 2
    ));
    assert.equal(api.getCapabilities().automaticNarrativeIdeaContinuityIndex, true);
  } finally {
    api.dispose();
    await store.close();
  }
});

test("una edición confirmada refresca automáticamente la revisión de la aparición y reutiliza la otra línea", async () => {
  const store = new IndexedDbProjectStore();
  const id = projectId();
  const notices = [];
  const api = new HostEngineApi({
    store,
    getOrderedDocumentIds: () => ["chapter-1", "chapter-2"],
    callbacks: {
      onNarrativeIdeaContinuityIndexUpdated: notice => notices.push(notice)
    }
  });
  const firstText = "El tema central es la memoria compartida que une a dos ciudades.";
  const changedText = "El tema central es la culpa compartida que divide a dos ciudades.";

  try {
    api.initializeProject({ projectId: id, projectName: "La ciudad de la memoria" });
    await api.openDocument({
      documentId: "chapter-1", text: firstText, revision: 0, sequence: 0
    });
    await api.openDocument({
      documentId: "chapter-2", text: firstText, revision: 0, sequence: 0
    });
    await api.flushPendingChanges();
    const before = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(before);
    assert.equal(before.generation > 0, true);

    const admission = api.onEditorChange({
      documentId: "chapter-2",
      sequence: 1,
      baseRevision: 0,
      start: 0,
      end: firstText.length,
      replacement: changedText
    });
    assert.equal(admission.status, "queued");
    await api.flushPendingChanges();

    const after = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(after);
    assert.ok(after.generation > before.generation);
    assert.equal(after.sourceRevisions.find(item => item.documentId === "chapter-2").revision, 1);
    assert.ok(after.occurrences.some(item =>
      item.documentId === "chapter-2" &&
      item.revision === 1 &&
      item.text === "la culpa compartida que divide a dos ciudades"
    ));
    assert.ok(after.occurrences.some(item =>
      item.documentId === "chapter-1" && item.revision === 0
    ));
    assert.ok(notices.some(notice =>
      notice.index.generation === after.generation &&
      notice.expectedGeneration === after.generation - 1
    ));
  } finally {
    api.dispose();
    await store.close();
  }
});

test("sin orden editorial explícito conserva cronología desconocida", async () => {
  const store = new IndexedDbProjectStore();
  const id = projectId();
  const api = new HostEngineApi({ store });

  try {
    api.initializeProject({ projectId: id, projectName: "La ciudad de la memoria" });
    await api.openDocument({
      documentId: "chapter-a",
      text: "El tema central es la memoria compartida que une a dos ciudades.",
      revision: 0,
      sequence: 0
    });
    await api.openDocument({
      documentId: "chapter-b",
      text: "El tema central es la memoria compartida que une a dos ciudades.",
      revision: 0,
      sequence: 0
    });
    await api.flushPendingChanges();

    const index = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(index);
    assert.equal(index.events.length, 1);
    assert.equal(index.events[0].chronology, "unknown");
    assert.equal(index.events[0].earlierOccurrenceId, undefined);
    assert.equal(index.events[0].laterOccurrenceId, undefined);
  } finally {
    api.dispose();
    await store.close();
  }
});


test("el índice de metadatos enumera revisiones sin exponer cuerpos documentales", async () => {
  const store = new IndexedDbProjectStore();
  const id = projectId();
  try {
    await store.saveDocument({
      projectId: id,
      documentId: "metadata-chapter",
      text: "Este cuerpo debe permanecer fuera del inventario.",
      revision: 4,
      sequence: 9,
      updatedAt: 1234
    });
    const metadata = await store.loadDocumentMetadata(id);
    assert.deepEqual(metadata, [{
      projectId: id,
      documentId: "metadata-chapter",
      revision: 4,
      sequence: 9,
      updatedAt: 1234
    }]);
    assert.equal(Object.hasOwn(metadata[0], "text"), false);
    assert.deepEqual(await store.loadDocumentMetadata(id + "-other"), []);
  } finally {
    await store.close();
  }
});


test("actualiza continuidad tras una edición aunque el adaptador no ofrezca extracción de entidades", async () => {
  const store = new IndexedDbProjectStore();
  // Elimina las capacidades de extracción clásica para ejercitar el camino
  // independiente de documentos + índice de continuidad.
  for (const name of [
    "saveEntity", "loadEntities",
    "saveRelation", "loadRelations",
    "saveEvent", "loadEvents",
    "saveIdea", "loadIdeas",
    "saveAssertion", "loadAssertions"
  ]) {
    store[name] = undefined;
  }
  const id = projectId();
  const api = new HostEngineApi({ store });
  const firstText = "El tema central es la memoria compartida que une a dos ciudades.";
  const changedText = "El tema central es la culpa compartida que divide a dos ciudades.";

  try {
    api.initializeProject({ projectId: id, projectName: "Continuidad independiente" });
    await api.openDocument({
      documentId: "chapter-1", text: firstText, revision: 0, sequence: 0
    });
    await api.flushPendingChanges();
    const before = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(before);
    const admission = api.onEditorChange({
      documentId: "chapter-1",
      sequence: 1,
      baseRevision: 0,
      start: 0,
      end: firstText.length,
      replacement: changedText
    });
    assert.equal(admission.status, "queued");
    await api.flushPendingChanges();

    const after = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(after);
    assert.ok(after.generation > before.generation);
    assert.equal(after.sourceRevisions[0].revision, 1);
    assert.equal(after.occurrences[0].text, "la culpa compartida que divide a dos ciudades");
  } finally {
    api.dispose();
    await store.close();
  }
});


test("reparte 200 candidatos entre más de 200 documentos y señala cobertura parcial", async () => {
  const store = new IndexedDbProjectStore();
  const id = projectId();
  const sourceText = "El tema central es la memoria compartida que une a dos ciudades.";

  try {
    for (let index = 0; index < 201; index++) {
      const documentId = "chapter-" + String(index).padStart(3, "0");
      await store.saveDocument({
        projectId: id,
        documentId,
        text: sourceText,
        revision: 0,
        sequence: 0,
        updatedAt: index + 1
      });
    }

    const api = new HostEngineApi({ store });
    try {
      api.initializeProject({ projectId: id, projectName: "Proyecto extenso" });
      await api.flushPendingChanges();

      const index = await store.loadNarrativeIdeaContinuityIndex(id);
      assert.ok(index);
      assert.equal(index.sourceRevisions.length, 201);
      assert.equal(index.occurrences.length, 200);
      assert.equal(index.summary.sourceAnalysisTruncated, true);
      assert.ok(index.occurrences.some(item => item.documentId === "chapter-000"));
      assert.ok(index.occurrences.some(item => item.documentId === "chapter-200"));
    } finally {
      api.dispose();
    }
  } finally {
    await store.close();
  }
});
