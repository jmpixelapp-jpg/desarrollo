import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import "fake-indexeddb/auto";
import {
  HostEngineApi,
  IndexedDbNarrativeSyncOutbox,
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

    const originalLoadDocument = store.loadDocument.bind(store);
    let reads = 0;
    let inFlight = 0;
    let maximumInFlight = 0;
    store.loadDocument = async (projectId, documentId) => {
      reads++;
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      try {
        return await originalLoadDocument(projectId, documentId);
      } finally {
        inFlight--;
      }
    };
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
      assert.equal(reads, 201);
      assert.ok(maximumInFlight > 1);
      assert.ok(maximumInFlight <= 16);
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


test("reanuncia la generación local reutilizada para recuperar una inserción de outbox fallida", async () => {
  const store = new IndexedDbProjectStore();
  const id = projectId();
  await store.saveDocument({
    projectId: id,
    documentId: "chapter-outbox",
    text: "El tema central es la memoria compartida que une a dos ciudades.",
    revision: 2,
    sequence: 5,
    updatedAt: 10
  });
  const notices = [];
  let failFirstEnqueue = true;
  const api = new HostEngineApi({
    store,
    callbacks: {
      onNarrativeIdeaContinuityIndexUpdated: notice => {
        notices.push(notice);
        if (failFirstEnqueue) {
          failFirstEnqueue = false;
          throw new Error("outbox temporalmente no disponible");
        }
      }
    }
  });

  try {
    api.initializeProject({ projectId: id, projectName: "Recuperación del outbox" });
    await api.flushPendingChanges();
    const index = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(index);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].index.generation, index.generation);
    assert.equal(notices[0].reused, false);

    await api.invalidateNarrativeKnowledgeFromExternalChange();
    assert.equal(notices.length, 2);
    assert.equal(notices[1].index.generation, index.generation);
    assert.equal(notices[1].reused, true);
  } finally {
    api.dispose();
    await store.close();
  }
});


test("limita el volumen total de texto analizado en proyectos con muchos documentos grandes", async () => {
  const store = new IndexedDbProjectStore();
  const id = projectId();
  const largePrefix = "x".repeat(1_900_000);
  const text = largePrefix + " El tema central es una señal deliberadamente situada al final.";
  try {
    for (let index = 0; index < 11; index++) {
      await store.saveDocument({
        projectId: id,
        documentId: "large-chapter-" + String(index).padStart(2, "0"),
        text,
        revision: 0,
        sequence: 0,
        updatedAt: index + 1
      });
    }
    const api = new HostEngineApi({ store });
    try {
      api.initializeProject({ projectId: id, projectName: "Proyecto de gran volumen" });
      await api.flushPendingChanges();
      const index = await store.loadNarrativeIdeaContinuityIndex(id);
      assert.ok(index);
      assert.equal(index.sourceRevisions.length, 11);
      assert.equal(index.summary.sourceAnalysisTruncated, true);
      assert.equal(index.occurrences.length, 0);
    } finally {
      api.dispose();
    }
  } finally {
    await store.close();
  }
});


test("redistribuye el presupuesto y revalida cachés cuando cambia el tamaño del proyecto", async () => {
  const store = new IndexedDbProjectStore();
  const id = projectId();
  const sourceText = "El tema central es la memoria compartida que une a dos ciudades.";
  for (let index = 0; index < 10; index++) {
    await store.saveDocument({
      projectId: id,
      documentId: "chapter-" + String(index).padStart(2, "0"),
      text: sourceText,
      revision: 0,
      sequence: 0,
      updatedAt: index + 1
    });
  }
  // Desactiva el aviso automático solo en esta prueba para medir exactamente
  // una reconciliación solicitada por el anfitrión.
  store.subscribeNarrativeChanges = undefined;
  let reads = 0;
  const originalLoadDocument = store.loadDocument.bind(store);
  store.loadDocument = async (projectId, documentId) => {
    reads++;
    return originalLoadDocument(projectId, documentId);
  };
  const api = new HostEngineApi({ store });

  try {
    api.initializeProject({ projectId: id, projectName: "Presupuesto cambiante" });
    await api.flushPendingChanges();
    assert.equal(reads, 10);
    const previous = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(previous);

    for (let index = 10; index < 12; index++) {
      await store.saveDocument({
        projectId: id,
        documentId: "chapter-" + String(index).padStart(2, "0"),
        text: sourceText,
        revision: 0,
        sequence: 0,
        updatedAt: index + 1
      });
    }
    await api.invalidateNarrativeKnowledgeFromExternalChange();

    const updated = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(updated);
    assert.equal(updated.sourceRevisions.length, 12);
    // El presupuesto por capítulo disminuyó al pasar de 10 a 12 documentos,
    // por eso se vuelven a descubrir también los diez documentos cacheados.
    assert.equal(reads, 22);
    assert.ok(updated.generation > previous.generation);
  } finally {
    api.dispose();
    await store.close();
  }
});


test("refreshNarrativeKnowledge también reconcilia cambios documentales externos en el índice transversal", async () => {
  const store = new IndexedDbProjectStore();
  const id = projectId();
  const originalText = "El tema central es la memoria compartida que une a dos ciudades.";
  const changedText = "El tema central es la culpa compartida que divide a dos ciudades.";
  await store.saveDocument({
    projectId: id,
    documentId: "chapter-explicit-refresh",
    text: originalText,
    revision: 3,
    sequence: 8,
    updatedAt: 10
  });
  store.subscribeNarrativeChanges = undefined;
  const api = new HostEngineApi({ store });

  try {
    api.initializeProject({ projectId: id, projectName: "Actualización explícita" });
    await api.flushPendingChanges();
    const before = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(before);

    await store.saveDocument({
      projectId: id,
      documentId: "chapter-explicit-refresh",
      text: changedText,
      revision: 3,
      sequence: 8,
      updatedAt: 11
    });
    await api.refreshNarrativeKnowledge();

    const after = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(after);
    assert.ok(after.generation > before.generation);
    assert.equal(after.occurrences[0].text, "la culpa compartida que divide a dos ciudades");
    assert.equal(after.occurrences[0].revision, 3);
  } finally {
    api.dispose();
    await store.close();
  }
});


test("recalcula cronología cuando cambia el orden editorial sin modificar los capítulos", async () => {
  const store = new IndexedDbProjectStore();
  const id = projectId();
  const sourceText = "El tema central es la memoria compartida que une a dos ciudades.";
  store.subscribeNarrativeChanges = undefined;
  let editorialOrder = ["chapter-1", "chapter-2"];
  const api = new HostEngineApi({
    store,
    getOrderedDocumentIds: () => editorialOrder
  });

  try {
    api.initializeProject({ projectId: id, projectName: "Reordenación de capítulos" });
    await api.openDocument({
      documentId: "chapter-1", text: sourceText, revision: 1, sequence: 2
    });
    await api.openDocument({
      documentId: "chapter-2", text: sourceText, revision: 1, sequence: 2
    });
    await api.flushPendingChanges();
    const first = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(first);
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0].chronology, "ordered");
    const firstOccurrences = new Map(first.occurrences.map(item => [item.ideaCandidateId, item]));
    assert.equal(firstOccurrences.get(first.events[0].earlierOccurrenceId).documentId, "chapter-1");

    editorialOrder = ["chapter-2", "chapter-1"];
    await api.refreshNarrativeKnowledge();
    const second = await store.loadNarrativeIdeaContinuityIndex(id);
    assert.ok(second);
    assert.ok(second.generation > first.generation);
    assert.equal(second.events[0].chronology, "ordered");
    const secondOccurrences = new Map(second.occurrences.map(item => [item.ideaCandidateId, item]));
    assert.equal(secondOccurrences.get(second.events[0].earlierOccurrenceId).documentId, "chapter-2");
    assert.equal(second.occurrences[0].revision, 1);
    assert.equal(second.occurrences[1].revision, 1);
  } finally {
    api.dispose();
    await store.close();
  }
});


test("HostEngineApi encola automáticamente cada generación con un ID único de instalación", async () => {
  const store = new IndexedDbProjectStore();
  const outbox = new IndexedDbNarrativeSyncOutbox({
    databaseName: "host-continuity-outbox-" + projectId()
  });
  const id = projectId();
  const writerId = "writer-account-" + randomUUID();
  const replicaId = "replica-installation-" + randomUUID();
  const initialText = "El tema central es la memoria compartida que une a dos ciudades.";
  const revisedText = "El tema central es la culpa compartida que divide a dos ciudades.";
  const api = new HostEngineApi({
    store,
    continuityOutbox: outbox,
    continuityOutboxWriterId: replicaId,
    getOrderedDocumentIds: () => ["chapter-1", "chapter-2"]
  });

  try {
    api.initializeProject({
      projectId: id,
      projectName: "Outbox integrado",
      writerId
    });
    await api.openDocument({
      documentId: "chapter-1", text: initialText, revision: 0, sequence: 0
    });
    await api.openDocument({
      documentId: "chapter-2", text: initialText, revision: 0, sequence: 0
    });
    await api.flushPendingChanges();

    const firstEntries = await outbox.loadEntries(id);
    assert.equal(firstEntries.length, 1);
    assert.equal(firstEntries[0].generation, 1);
    assert.equal(firstEntries[0].writerId, replicaId);
    assert.notEqual(firstEntries[0].writerId, writerId);
    assert.equal(firstEntries[0].status, "pending");
    assert.equal(api.getCapabilities().narrativeIdeaContinuityDurableOutbox, true);

    api.onEditorChange({
      documentId: "chapter-2",
      sequence: 1,
      baseRevision: 0,
      start: 0,
      end: initialText.length,
      replacement: revisedText
    });
    await api.flushPendingChanges();

    const entries = await outbox.loadEntries(id);
    assert.deepEqual(entries.map(item => item.generation), [1, 2]);
    assert.deepEqual(entries.map(item => item.sequence), [1, 2]);
    assert.equal(entries[1].envelope.payload.expectedGeneration, 1);
    assert.equal(entries[1].envelope.payload.index.occurrences.some(item =>
      item.documentId === "chapter-2" && item.revision === 1 &&
      item.text === "la culpa compartida que divide a dos ciudades"
    ), true);
  } finally {
    api.dispose();
    outbox.close();
    await store.close();
  }
});


test("exige un ID estable y distinto por instalación al configurar el outbox automático", async () => {
  const store = new IndexedDbProjectStore();
  const outbox = new IndexedDbNarrativeSyncOutbox({
    databaseName: "host-continuity-outbox-invalid-" + projectId()
  });
  try {
    assert.throws(() => new HostEngineApi({
      store,
      continuityOutbox: outbox
    }), /continuityOutboxWriterId estable y único por instalación/u);
    assert.throws(() => new HostEngineApi({
      store,
      continuityOutboxWriterId: "replica-without-outbox"
    }), /solo se usa junto a continuityOutbox/u);
  } finally {
    outbox.close();
    await store.close();
  }
});


test("un callback auxiliar que falla sincrónicamente no impide persistir en el outbox", async () => {
  const store = new IndexedDbProjectStore();
  const outbox = new IndexedDbNarrativeSyncOutbox({
    databaseName: "host-continuity-outbox-callback-error-" + projectId()
  });
  const id = projectId();
  const errors = [];
  const api = new HostEngineApi({
    store,
    continuityOutbox: outbox,
    continuityOutboxWriterId: "replica-callback-error-" + randomUUID(),
    callbacks: {
      onKnowledgeError: error => errors.push(error),
      onNarrativeIdeaContinuityIndexUpdated: () => {
        throw new Error("callback auxiliar falló");
      }
    }
  });

  try {
    api.initializeProject({ projectId: id, projectName: "Outbox resistente al callback" });
    await api.openDocument({
      documentId: "chapter-callback",
      text: "El tema central es la memoria compartida que une a dos ciudades.",
      revision: 0,
      sequence: 0
    });
    await api.flushPendingChanges();

    const entries = await outbox.loadEntries(id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].generation, 1);
    assert.ok(errors.some(error => /callback auxiliar falló/u.test(error.message)));
  } finally {
    api.dispose();
    outbox.close();
    await store.close();
  }
});
