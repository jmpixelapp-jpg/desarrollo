import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi } from "../dist/motor-literario.js";

class DurableJournalStore {
  document;
  changes = [];
  entities = new Map();
  relations = new Map();
  events = new Map();
  ideas = new Map();
  assertions = new Map();
  diagnostics = new Map();
  failNextIdeaSave = false;
  failNextEventSave = false;
  durableAppend;

  async saveDocument(document) {
    this.document = structuredClone(document);
  }

  async loadDocument(projectId, documentId) {
    if (this.document?.projectId !== projectId || this.document?.documentId !== documentId) {
      return undefined;
    }
    return structuredClone(this.document);
  }

  async loadDocumentWithChanges(projectId, documentId) {
    const document = await this.loadDocument(projectId, documentId);
    return {
      document,
      changes: this.changes
        .filter(change => change.projectId === projectId &&
          change.documentId === documentId &&
          change.sequence > (document?.sequence ?? -1))
        .map(change => structuredClone(change))
    };
  }

  async appendChange(change) {
    this.changes.push(structuredClone(change));
    this.durableAppend?.();
    // Simula que el proceso desaparece después del commit durable y antes
    // de que el motor reciba el acuse y comience el análisis.
    await new Promise(() => {});
  }

  async saveDocumentAndCompactChanges(document, throughSequence) {
    this.document = structuredClone(document);
    this.changes = this.changes.filter(change =>
      change.projectId !== document.projectId ||
      change.documentId !== document.documentId ||
      change.sequence > throughSequence
    );
  }

  async compactChanges(projectId, documentId, throughSequence) {
    this.changes = this.changes.filter(change =>
      change.projectId !== projectId ||
      change.documentId !== documentId ||
      change.sequence > throughSequence
    );
  }

  async saveEntity(entity) {
    this.entities.set(entity.projectId + ":" + entity.id, structuredClone(entity));
  }

  async loadEntities(projectId) {
    return [...this.entities.values()]
      .filter(entity => entity.projectId === projectId)
      .map(entity => structuredClone(entity));
  }

  async saveRelation(relation) {
    this.relations.set(relation.projectId + ":" + relation.id, structuredClone(relation));
  }

  async loadRelations(projectId) {
    return [...this.relations.values()]
      .filter(relation => relation.projectId === projectId)
      .map(relation => structuredClone(relation));
  }

  async saveEvent(event) {
    if (this.failNextEventSave) {
      this.failNextEventSave = false;
      throw new Error("Simulated interruption while rebasing event evidence");
    }
    this.events.set(event.projectId + ":" + event.id, structuredClone(event));
  }

  async loadEvents(projectId) {
    return [...this.events.values()]
      .filter(event => event.projectId === projectId)
      .map(event => structuredClone(event));
  }

  async saveIdea(idea) {
    if (this.failNextIdeaSave) {
      this.failNextIdeaSave = false;
      throw new Error("Simulated crash during idea persistence");
    }
    this.ideas.set(idea.projectId + ":" + idea.id, structuredClone(idea));
  }

  async loadIdeas(projectId) {
    return [...this.ideas.values()]
      .filter(idea => idea.projectId === projectId)
      .map(idea => structuredClone(idea));
  }

  async updateIdeaIfUnchanged(idea, expectedCurrent) {
    const key = idea.projectId + ":" + idea.id;
    const current = this.ideas.get(key);
    if (!current) {
      throw new Error("La idea ya no existe en el proyecto; puede haberse archivado o eliminado desde otra instancia.");
    }
    if (JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
      throw new Error("La idea cambió en otra instancia; actualiza la vista antes de volver a modificarla.");
    }
    this.ideas.set(key, structuredClone(idea));
  }

  async saveAssertion(assertion) {
    this.assertions.set(assertion.projectId + ":" + assertion.id, structuredClone(assertion));
  }

  async loadAssertions(projectId) {
    return [...this.assertions.values()]
      .filter(assertion => assertion.projectId === projectId)
      .map(assertion => structuredClone(assertion));
  }

  async saveDiagnostics(record) {
    this.diagnostics.set(record.projectId + ":" + record.documentId, structuredClone(record));
  }

  async loadDiagnostics(projectId, documentId) {
    const record = this.diagnostics.get(projectId + ":" + documentId);
    return record ? structuredClone(record) : undefined;
  }
}

test("reconstruye conocimiento narrativo si la aplicación se cierra tras confirmar el journal y antes del análisis", async () => {
  const store = new DurableJournalStore();
  let signalDurableAppend;
  const durableAppend = new Promise(resolve => { signalDurableAppend = resolve; });
  store.durableAppend = signalDurableAppend;

  const firstProcess = new HostEngineApi({ store });
  firstProcess.initializeProject({
    projectId: "project-crash-recovery",
    projectName: "Libro de prueba",
    writerId: "writer-crash-recovery"
  });
  await firstProcess.openDocument({
    documentId: "chapter-1",
    text: "Inicio",
    revision: 0,
    sequence: 0
  });

  const admission = firstProcess.onEditorChange({
    documentId: "chapter-1",
    start: 6,
    end: 6,
    replacement: "\nIDEA: La ciudad bajo el agua",
    baseRevision: 0,
    sequence: 1
  });
  assert.equal(admission.status, "queued");

  await durableAppend;
  assert.equal(store.changes.length, 1);
  assert.equal(store.document.text, "Inicio");

  // Nueva instancia: la primera ya no puede completar su análisis ni confirmar
  // el ticket, pero el journal contiene la edición completa.
  const restartedProcess = new HostEngineApi({ store });
  restartedProcess.initializeProject({
    projectId: "project-crash-recovery",
    projectName: "Libro de prueba",
    writerId: "writer-crash-recovery"
  });
  await restartedProcess.openDocument({
    documentId: "chapter-1",
    text: "Inicio",
    revision: 0,
    sequence: 0
  });
  await restartedProcess.flushPendingChanges();

  assert.equal(
    restartedProcess.getSnapshot("chapter-1").text,
    "Inicio\nIDEA: La ciudad bajo el agua"
  );
  const ideas = await restartedProcess.getNarrativeIdeas();
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0].text, "La ciudad bajo el agua");
  assert.equal(ideas[0].status, "IDEA");
  assert.equal(store.changes.length, 0);
});


test("recalcula y persiste diagnósticos si la aplicación se cierra antes de iniciar el análisis", async () => {
  const store = new DurableJournalStore();
  let signalDurableAppend;
  const durableAppend = new Promise(resolve => { signalDurableAppend = resolve; });
  store.durableAppend = signalDurableAppend;

  const firstProcess = new HostEngineApi({ store });
  firstProcess.initializeProject({
    projectId: "diagnostic-crash-recovery",
    projectName: "Recuperación de diagnósticos"
  });
  const hostBase = {
    documentId: "chapter-diagnostics",
    text: "Inicio",
    revision: 0,
    sequence: 0
  };
  await firstProcess.openDocument(hostBase);
  await firstProcess.flushPendingChanges();
  assert.equal(store.diagnostics.get("diagnostic-crash-recovery:chapter-diagnostics")?.revision, 0);

  const admission = firstProcess.onEditorChange({
    documentId: hostBase.documentId,
    start: 6,
    end: 6,
    replacement: "\nHola hola .",
    baseRevision: 0,
    sequence: 1
  });
  assert.equal(admission.status, "queued");
  await durableAppend;

  // El journal ya es durable, pero appendChange sigue sin devolver el acuse:
  // el proceso original no llega a generar ni persistir los diagnósticos.
  assert.equal(store.changes.length, 1);
  assert.equal(store.diagnostics.get("diagnostic-crash-recovery:chapter-diagnostics")?.revision, 0);

  const restartedProcess = new HostEngineApi({ store });
  restartedProcess.initializeProject({
    projectId: "diagnostic-crash-recovery",
    projectName: "Recuperación de diagnósticos"
  });
  await restartedProcess.openDocument(hostBase);
  await restartedProcess.flushPendingChanges();

  const recoveredSnapshot = restartedProcess.getSnapshot(hostBase.documentId);
  assert.equal(recoveredSnapshot?.text, "Inicio\nHola hola .");
  assert.equal(recoveredSnapshot?.revision, 1);
  const diagnostics = restartedProcess.getDocumentDiagnostics(hostBase.documentId);
  assert.ok(diagnostics.some(item => item.ruleId === "repeated-word"));
  assert.ok(diagnostics.every(item => item.revision === 1));
  const persisted = await store.loadDiagnostics(
    "diagnostic-crash-recovery", hostBase.documentId
  );
  assert.equal(persisted?.revision, 1);
  assert.ok(persisted?.diagnostics.some(item => item.ruleId === "repeated-word"));
  assert.equal(store.changes.length, 0);
});


test("persiste diagnósticos de cambios en vivo aunque el adaptador no tenga conocimiento narrativo", async () => {
  const documents = new Map();
  const changes = [];
  const diagnostics = new Map();
  const store = {
    async saveDocument(document) {
      documents.set(document.projectId + ":" + document.documentId, structuredClone(document));
    },
    async loadDocument(projectId, documentId) {
      const value = documents.get(projectId + ":" + documentId);
      return value ? structuredClone(value) : undefined;
    },
    async loadDocumentWithChanges(projectId, documentId) {
      return {
        document: await this.loadDocument(projectId, documentId),
        changes: changes.filter(change =>
          change.projectId === projectId && change.documentId === documentId
        ).map(change => structuredClone(change))
      };
    },
    async appendChange(change) {
      changes.push(structuredClone(change));
    },
    async saveDocumentAndCompactChanges(document, throughSequence) {
      await this.saveDocument(document);
      for (let index = changes.length - 1; index >= 0; index--) {
        const change = changes[index];
        if (change.projectId === document.projectId &&
            change.documentId === document.documentId &&
            change.sequence <= throughSequence) changes.splice(index, 1);
      }
    },
    async compactChanges(projectId, documentId, throughSequence) {
      for (let index = changes.length - 1; index >= 0; index--) {
        const change = changes[index];
        if (change.projectId === projectId && change.documentId === documentId &&
            change.sequence <= throughSequence) changes.splice(index, 1);
      }
    },
    async saveDiagnostics(record) {
      diagnostics.set(record.projectId + ":" + record.documentId, structuredClone(record));
    },
    async loadDiagnostics(projectId, documentId) {
      const value = diagnostics.get(projectId + ":" + documentId);
      return value ? structuredClone(value) : undefined;
    }
  };
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "live-diagnostic-persistence", projectName: "Diagnósticos en vivo" });
  await api.openDocument({
    documentId: "chapter",
    text: "Inicio",
    revision: 0,
    sequence: 0
  });
  await api.flushPendingChanges();

  const admission = api.onEditorChange({
    documentId: "chapter",
    start: 6,
    end: 6,
    replacement: "\nHola hola .",
    baseRevision: 0,
    sequence: 1
  });
  assert.equal(admission.status, "queued");
  await api.flushPendingChanges();

  const current = api.getDocumentDiagnostics("chapter");
  assert.ok(current.some(item => item.ruleId === "repeated-word"));
  assert.equal(current[0]?.revision, 1);
  assert.equal(diagnostics.get("live-diagnostic-persistence:chapter")?.revision, 1);
});


test("conserva diagnósticos de líneas intactas al analizar una edición en otra línea", async () => {
  const store = new DurableJournalStore();
  store.appendChange = async change => { store.changes.push(structuredClone(change)); };
  const api = new HostEngineApi({ store });
  api.initializeProject({
    projectId: "diagnostic-line-reconciliation",
    projectName: "Reconciliación de diagnósticos"
  });
  const originalText = "Hola hola.\nInicio";
  await api.openDocument({
    documentId: "chapter",
    text: originalText,
    revision: 0,
    sequence: 0
  });
  await api.flushPendingChanges();
  assert.equal(
    api.getDocumentDiagnostics("chapter").filter(item => item.ruleId === "repeated-word").length,
    1
  );

  const admission = api.onEditorChange({
    documentId: "chapter",
    start: 11,
    end: 17,
    replacement: "Hola hola .",
    baseRevision: 0,
    sequence: 1
  });
  assert.equal(admission.status, "queued");
  await api.flushPendingChanges();

  const repeatedWords = api.getDocumentDiagnostics("chapter")
    .filter(item => item.ruleId === "repeated-word");
  assert.equal(repeatedWords.length, 2);
  assert.deepEqual(repeatedWords.map(item => item.start), [5, 16]);
  assert.ok(repeatedWords.every(item => item.revision === 1));
});


test("reanuda una extracción narrativa interrumpida después de guardar entidades, relaciones y acontecimientos", async () => {
  const store = new DurableJournalStore();
  store.failNextIdeaSave = true;
  const errors = [];
  const project = {
    projectId: "narrative-partial-recovery",
    projectName: "Recuperación narrativa",
    writerId: "writer-recovery"
  };
  const snapshot = {
    documentId: "chapter-1",
    text: "El personaje Ana y el personaje Luis. Ana es hermana de Luis.\nACONTECIMIENTO: Ana descubre la puerta secreta.\nIDEA: El mapa revela un segundo continente.",
    revision: 3,
    sequence: 3
  };

  const firstProcess = new HostEngineApi({
    store,
    callbacks: { onKnowledgeError: error => errors.push(error) }
  });
  firstProcess.initializeProject(project);
  await firstProcess.openDocument(snapshot);
  await firstProcess.flushPendingChanges();

  assert.equal(errors.length, 1);
  assert.equal(store.entities.size, 2);
  assert.equal(store.relations.size, 1);
  assert.equal(store.events.size, 1);
  assert.equal(store.ideas.size, 0);

  // El proceso nuevo vuelve a extraer el documento completo. Los registros
  // guardados antes del fallo se fusionan sin duplicar evidencias.
  const restartedProcess = new HostEngineApi({ store });
  restartedProcess.initializeProject(project);
  await restartedProcess.openDocument(snapshot);
  await restartedProcess.flushPendingChanges();

  assert.equal((await restartedProcess.getNarrativeEntities()).length, 2);
  assert.equal((await restartedProcess.getNarrativeRelations()).length, 1);
  assert.equal((await restartedProcess.getNarrativeEvents()).length, 1);
  const ideas = await restartedProcess.getNarrativeIdeas();
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0].text, "El mapa revela un segundo continente.");
  for (const entity of await restartedProcess.getNarrativeEntities()) {
    assert.equal(entity.evidence.filter(item => item.documentId === snapshot.documentId).length, 1);
  }
  for (const relation of await restartedProcess.getNarrativeRelations()) {
    assert.equal(relation.evidence.filter(item => item.documentId === snapshot.documentId).length, 1);
  }
  for (const event of await restartedProcess.getNarrativeEvents()) {
    assert.equal(event.evidence.filter(item => item.documentId === snapshot.documentId).length, 1);
  }
  assert.equal(ideas[0].evidence.filter(item => item.documentId === snapshot.documentId).length, 1);
});


test("recupera identidades de acontecimientos e ideas si falla el guardado de offsets desplazados", async () => {
  const store = new DurableJournalStore();
  const errors = [];
  const project = {
    projectId: "narrative-evidence-rebase-recovery",
    projectName: "Reconciliación de evidencias",
    writerId: "writer-evidence-recovery"
  };
  const initialText = [
    "El personaje Ana.",
    "Ana tiene 20 años.",
    "ACONTECIMIENTO: Ana descubre la puerta secreta.",
    "IDEA: El mapa revela un segundo continente."
  ].join("\n");
  const firstProcess = new HostEngineApi({
    store,
    callbacks: { onKnowledgeError: error => errors.push(error) }
  });
  firstProcess.initializeProject(project);
  await firstProcess.openDocument({
    documentId: "chapter-1",
    text: initialText,
    revision: 0,
    sequence: 0
  });
  await firstProcess.flushPendingChanges();

  assert.equal(store.events.size, 1);
  assert.equal(store.ideas.size, 1);
  store.failNextEventSave = true;

  const admission = firstProcess.onEditorChange({
    documentId: "chapter-1",
    start: 0,
    end: 0,
    replacement: "Prólogo\n",
    baseRevision: 0,
    sequence: 1
  });
  assert.equal(admission.status, "queued");
  await firstProcess.flushPendingChanges();
  assert.equal(errors.length, 1);

  const recoveredSnapshot = firstProcess.getSnapshot("chapter-1");
  assert.equal(recoveredSnapshot.revision, 1);
  assert.ok(recoveredSnapshot.text.startsWith("Prólogo\n"));

  const restartedProcess = new HostEngineApi({ store });
  restartedProcess.initializeProject(project);
  await restartedProcess.openDocument(recoveredSnapshot);
  await restartedProcess.flushPendingChanges();

  const events = await restartedProcess.getNarrativeEvents();
  const ideas = await restartedProcess.getNarrativeIdeas();
  const assertions = await restartedProcess.getNarrativeAssertions();
  assert.equal(events.length, 1);
  assert.equal(ideas.length, 1);
  assert.equal(assertions.length, 1);
  assert.equal(assertions[0].value, 20);
  assert.equal(assertions[0].evidence.revision, 1);
  assert.equal(assertions[0].evidence.start, recoveredSnapshot.text.indexOf("Ana tiene"));
  assert.ok(events[0].evidence.some(item =>
    item.revision === 1 && item.start === recoveredSnapshot.text.indexOf("Ana descubre")
  ));
  assert.ok(ideas[0].evidence.some(item =>
    item.revision === 1 && item.start === recoveredSnapshot.text.indexOf("El mapa revela")
  ));
});
