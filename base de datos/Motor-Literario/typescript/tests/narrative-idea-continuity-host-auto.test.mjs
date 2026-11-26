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


test("si un capítulo avanza mientras se analiza, no confirma un índice de revisiones mezcladas", async () => {
  const store = new IndexedDbProjectStore();
  const id = projectId();
  const originalText = "El tema central es la memoria compartida que une a dos ciudades.";
  const revisedText = "El tema central es la culpa compartida que divide a dos ciudades.";
  await store.saveDocument({
    projectId: id,
    documentId: "chapter-race",
    text: originalText,
    revision: 0,
    sequence: 0,
    updatedAt: 1
  });
  const api = new HostEngineApi({ store });

  try {
    api.initializeProject({ projectId: id, projectName: "Reconciliación concurrente" });
    await api.flushPendingChanges();
    const before = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(before);

    const originalLoadDocument = store.loadDocument.bind(store);
    let injected = false;
    store.loadDocument = async (projectId, documentId) => {
      const snapshot = await originalLoadDocument(projectId, documentId);
      if (!injected) {
        injected = true;
        await store.saveDocument({
          ...snapshot,
          text: revisedText,
          revision: snapshot.revision + 1,
          sequence: snapshot.sequence + 1,
          updatedAt: 2
        });
      }
      return snapshot;
    };

    await assert.rejects(
      api.invalidateNarrativeKnowledgeFromExternalChange(),
      /revisión avanzó|conjunto documental cambió/u
    );
    const afterRejectedRefresh = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.equal(afterRejectedRefresh.generation, before.generation);
    assert.equal(afterRejectedRefresh.occurrences[0].text, "la memoria compartida que une a dos ciudades");

    await api.invalidateNarrativeKnowledgeFromExternalChange();
    const afterRetry = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.equal(afterRetry.sourceRevisions[0].revision, 1);
    assert.equal(afterRetry.occurrences[0].text, "la culpa compartida que divide a dos ciudades");
  } finally {
    api.dispose();
    await store.close();
  }
});

test("un cambio externo que no modifica documentos reutiliza candidatos y no relee el manuscrito", async () => {
  const store = new IndexedDbProjectStore();
  const id = projectId();
  await store.saveDocument({
    projectId: id,
    documentId: "chapter-stable",
    text: "El tema central es la memoria compartida que une a dos ciudades.",
    revision: 3,
    sequence: 7,
    updatedAt: 1
  });
  let documentReads = 0;
  const originalLoadDocument = store.loadDocument.bind(store);
  store.loadDocument = async (projectId, documentId) => {
    documentReads++;
    return originalLoadDocument(projectId, documentId);
  };
  const api = new HostEngineApi({ store });

  try {
    api.initializeProject({ projectId: id, projectName: "Caché de candidatos" });
    await api.flushPendingChanges();
    const before = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(before);
    const readsAfterInitialBuild = documentReads;
    assert.equal(readsAfterInitialBuild, 1);

    await api.invalidateNarrativeKnowledgeFromExternalChange();
    const after = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(after);
    assert.equal(documentReads, readsAfterInitialBuild);
    assert.equal(after.generation, before.generation);
    assert.equal(after.fingerprint, before.fingerprint);
  } finally {
    api.dispose();
    await store.close();
  }
});


test("detecta cambios de snapshot aunque un adaptador conserve revisión y secuencia", async () => {
  const store = new IndexedDbProjectStore();
  const id = projectId();
  const firstText = "El tema central es la memoria compartida que une a dos ciudades.";
  const nextText = "El tema central es la culpa compartida que divide a dos ciudades.";
  const api = new HostEngineApi({ store });

  try {
    api.initializeProject({ projectId: id, projectName: "Revisión de metadatos" });
    await api.openDocument({
      documentId: "chapter-same-revision",
      text: firstText,
      revision: 4,
      sequence: 9
    });
    await api.flushPendingChanges();
    const before = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(before);

    await store.saveDocument({
      projectId: id,
      documentId: "chapter-same-revision",
      text: nextText,
      revision: 4,
      sequence: 9,
      updatedAt: Date.now() + 1
    });
    await api.invalidateNarrativeKnowledgeFromExternalChange();

    const after = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(after);
    assert.ok(after.generation > before.generation);
    assert.equal(after.occurrences[0].revision, 4);
    assert.equal(after.occurrences[0].text, "la culpa compartida que divide a dos ciudades");
  } finally {
    api.dispose();
    await store.close();
  }
});
