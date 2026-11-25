import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi, IndexedDbProjectStore, PieceTable } from "../dist/motor-literario.js";

class MemoryStore {
  documents = new Map();
  entities = new Map();
  relations = new Map();
  events = new Map();
  eventLifecycles = new Map();
  ideas = new Map();
  personalIdeas = new Map();
  assertions = new Map();
  async saveDocument(document) {
    this.documents.set(document.projectId + ":" + document.documentId, structuredClone(document));
  }
  async loadDocument(projectId, documentId) {
    const value = this.documents.get(projectId + ":" + documentId);
    return value ? structuredClone(value) : undefined;
  }
  async loadDocumentWithChanges(projectId, documentId) {
    const document = await this.loadDocument(projectId, documentId);
    const changes = document && typeof this.loadChanges === "function"
      ? await this.loadChanges(projectId, documentId, document.sequence)
      : [];
    return { document, changes };
  }
  async saveEntity(entity) {
    this.entities.set(entity.projectId + ":" + entity.id, structuredClone(entity));
  }
  async loadEntities(projectId) {
    return [...this.entities.values()].filter(entity => entity.projectId === projectId).map(entity => structuredClone(entity));
  }
  async saveRelation(relation) {
    this.relations.set(relation.projectId + ":" + relation.id, structuredClone(relation));
  }
  async loadRelations(projectId) {
    return [...this.relations.values()].filter(relation => relation.projectId === projectId).map(relation => structuredClone(relation));
  }
  async saveEvent(event) {
    this.events.set(event.projectId + ":" + event.id, structuredClone(event));
  }
  async loadEvents(projectId) {
    return [...this.events.values()].filter(event => event.projectId === projectId).map(event => structuredClone(event));
  }
  async loadEventLifecycles(projectId,eventId) {
    return [...this.eventLifecycles.values()]
      .filter(item=>item.projectId===projectId && item.eventId===eventId)
      .sort((a,b)=>a.revision-b.revision)
      .map(item=>structuredClone(item));
  }
  async loadProjectEventLifecycles(projectId) {
    return [...this.eventLifecycles.values()]
      .filter(item=>item.projectId===projectId)
      .sort((a,b)=>a.eventId.localeCompare(b.eventId) || a.revision-b.revision)
      .map(item=>structuredClone(item));
  }
  async saveEventAndAppendLifecycleIfUnchanged(event,expectedCurrent,lifecycle) {
    const key=event.projectId+":"+event.id;
    const current=this.events.get(key);
    if(!current || JSON.stringify(current)!==JSON.stringify(expectedCurrent)) {
      throw new Error("event_changed_concurrently");
    }
    const history=await this.loadEventLifecycles(event.projectId,event.id);
    const previous=history[history.length-1];
    if(previous && (
      lifecycle.revision!==previous.revision+1 ||
      lifecycle.previousLabel!==previous.newLabel ||
      JSON.stringify(lifecycle.previousParticipants)!==JSON.stringify(previous.newParticipants) ||
      lifecycle.changedAt<previous.changedAt
    )) throw new Error("invalid_event_lifecycle_sequence");
    if(!previous && lifecycle.revision!==1) throw new Error("invalid_initial_event_lifecycle");
    if(this.eventLifecycles.has(event.projectId+":"+lifecycle.id)) throw new Error("duplicate_event_lifecycle");
    this.events.set(key,structuredClone(event));
    this.eventLifecycles.set(event.projectId+":"+lifecycle.id,structuredClone(lifecycle));
  }
  async saveAssertion(assertion) {
    this.assertions.set(assertion.projectId + ":" + assertion.id, structuredClone(assertion));
  }
  async loadAssertions(projectId) {
    return [...this.assertions.values()].filter(item => item.projectId === projectId).map(item => structuredClone(item));
  }
  async saveIdea(idea) {
    this.ideas.set(idea.projectId + ":" + idea.id, structuredClone(idea));
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
  async loadIdeas(projectId) {
    return [...this.ideas.values()].filter(idea => idea.projectId === projectId).map(idea => structuredClone(idea));
  }
  async archiveUnincorporatedIdeas(projectId, writerId, sourceProjectName, archivedAt) {
    const projectIdeas = [...this.ideas.values()].filter(idea => idea.projectId === projectId);
    const ideasById = new Map(projectIdeas.map(idea => [idea.id, idea]));
    const ideasToArchive = new Set(projectIdeas.filter(idea => idea.status === "IDEA").map(idea => idea.id));
    for (const idea of projectIdeas) {
      if (idea.status !== "IDEA" && (idea.relatedIdeaIds ?? []).some(id => ideasToArchive.has(id))) {
        throw new Error("a kept idea cannot depend on an archived idea");
      }
    }
    const prepared = [];
    for (const idea of projectIdeas.filter(item => item.status === "IDEA")) {
      const relatedIdeaIds = new Set();
      const visited = new Set([idea.id]);
      const queue = [...(idea.relatedIdeaIds ?? [])];
      while (queue.length) {
        const id = queue.shift();
        if (visited.has(id)) continue;
        visited.add(id);
        if (ideasToArchive.has(id)) continue;
        const related = ideasById.get(id);
        if (!related) throw new Error("missing related idea");
        relatedIdeaIds.add(id);
        queue.push(...(related.relatedIdeaIds ?? []));
      }
      const relatedIdeas = projectIdeas.filter(item => relatedIdeaIds.has(item.id))
        .sort((first, second) => first.id.localeCompare(second.id));
      const relatedEntityIds = new Set(idea.relatedEntityIds ?? []);
      for (const related of relatedIdeas) {
        for (const id of related.relatedEntityIds ?? []) relatedEntityIds.add(id);
      }
      const relatedEntities = [...relatedEntityIds].sort().map(id => {
        const entity = this.entities.get(projectId + ":" + id);
        if (!entity) throw new Error("missing related entity");
        return structuredClone(entity);
      });
      const entry = {
        writerId,
        sourceProjectId: projectId,
        sourceProjectName,
        category: sourceProjectName,
        idea: structuredClone({ ...idea, sourceProjectName }),
        context: {
          version: 1,
          relatedIdeas: structuredClone(relatedIdeas.map(related => ({
            ...related, sourceProjectName
          }))),
          relatedEntities
        },
        archivedAt
      };
      const key = JSON.stringify([writerId, projectId, idea.id]);
      if (this.personalIdeas.has(key) || prepared.some(item => item.key === key)) {
        throw new Error("duplicate_personal_idea");
      }
      prepared.push({ key, entry });
    }
    // Prepara y valida el lote entero antes de mover una sola idea, igual que
    // la transacción IndexedDB: una colisión no debe dejar transferencias parciales.
    const archived = prepared.map(item => structuredClone(item.entry));
    for (const item of prepared) {
      this.personalIdeas.set(item.key, structuredClone(item.entry));
      this.ideas.delete(projectId + ":" + item.entry.idea.id);
    }
    return archived;
  }
  async loadPersonalIdeas(writerId) {
    return [...this.personalIdeas.values()].filter(entry => entry.writerId === writerId)
      .map(entry => structuredClone(entry));
  }
  async mergeNarrativeEntityIdentity(projectId, targetId, sourceId, writerId) {
    const target = this.entities.get(projectId + ":" + targetId);
    const source = this.entities.get(projectId + ":" + sourceId);
    if (!target || !source || target.kind !== source.kind) throw new Error("invalid identity merge");
    const aliases = [...new Set([...target.aliases, source.canonicalName, ...source.aliases])].filter(x => x !== target.canonicalName);
    const evidence = [...target.evidence];
    const evidenceKeys = new Set(evidence.map(item =>
      [item.documentId, item.revision, item.start, item.end, item.excerpt, item.status ?? ""].join("\\u0000")
    ));
    for (const item of source.evidence) {
      const key = [item.documentId, item.revision, item.start, item.end, item.excerpt, item.status ?? ""].join("\\u0000");
      if (!evidenceKeys.has(key)) { evidence.push(item); evidenceKeys.add(key); }
    }
    this.entities.set(projectId + ":" + targetId, structuredClone({
      ...target, aliases, evidence,
      mergedFromIds: [...new Set([...(target.mergedFromIds ?? []), sourceId, ...(source.mergedFromIds ?? [])])]
    }));
    this.entities.delete(projectId + ":" + sourceId);
    const relationGroups = new Map();
    for (const [key, relation] of this.relations) {
      if (relation.projectId !== projectId) continue;
      const originatedAtCanonical =
        relation.fromEntityId === targetId || relation.toEntityId === targetId;
      const fromEntityId = relation.fromEntityId === sourceId ? targetId : relation.fromEntityId;
      const toEntityId = relation.toEntityId === sourceId ? targetId : relation.toEntityId;
      if (fromEntityId === toEntityId) {
        this.relations.delete(key);
        continue;
      }
      const groupKey = JSON.stringify([fromEntityId, relation.relationType, toEntityId]);
      const group = relationGroups.get(groupKey) ?? [];
      group.push({
        key, relation: { ...relation, fromEntityId, toEntityId }, originatedAtCanonical
      });
      relationGroups.set(groupKey, group);
    }
    for (const group of relationGroups.values()) {
      group.sort((a, b) =>
        Number(b.originatedAtCanonical) - Number(a.originatedAtCanonical) ||
        a.relation.id.localeCompare(b.relation.id)
      );
      const [primary, ...duplicates] = group;
      const evidence = new Map();
      for (const item of group.flatMap(value => value.relation.evidence)) {
        const evidenceKey = [item.documentId, item.revision, item.start, item.end, item.excerpt, item.status ?? ""].join("\\u0000");
        if (!evidence.has(evidenceKey)) evidence.set(evidenceKey, item);
      }
      this.relations.set(primary.key, structuredClone({ ...primary.relation, evidence: [...evidence.values()] }));
      for (const duplicate of duplicates) this.relations.delete(duplicate.key);
    }
    for (const [key, event] of this.events) if (event.projectId === projectId && event.participants.includes(sourceId)) {
      this.events.set(key, structuredClone({ ...event, participants: [...new Set(event.participants.map(id => id === sourceId ? targetId : id))] }));
    }
    for (const [key, assertion] of this.assertions) if (assertion.projectId === projectId && assertion.entityId === sourceId) {
      this.assertions.set(key, structuredClone({ ...assertion, entityId: targetId }));
    }
    for (const [key, idea] of this.ideas) if (idea.projectId === projectId && idea.relatedEntityIds?.includes(sourceId)) {
      this.ideas.set(key, structuredClone({
        ...idea,
        relatedEntityIds: [...new Set(idea.relatedEntityIds.map(id => id === sourceId ? targetId : id))]
      }));
    }
    if (writerId) {
      const mergedEntity = this.entities.get(projectId + ":" + targetId);
      const absorbedIdentityIds = new Set(mergedEntity.mergedFromIds ?? []);
      const mergedIdentityIds = new Set([targetId, ...absorbedIdentityIds]);
      for (const [key, entry] of this.personalIdeas) {
        if (entry.writerId !== writerId || entry.sourceProjectId !== projectId) continue;
        const remap = idea => (idea.relatedEntityIds ?? []).some(id => absorbedIdentityIds.has(id))
          ? { ...idea, relatedEntityIds: [...new Set((idea.relatedEntityIds ?? []).map(id =>
            absorbedIdentityIds.has(id) ? targetId : id
          ))] }
          : idea;
        if (!entry.context) {
          const idea = remap(entry.idea);
          if (idea !== entry.idea) {
            this.personalIdeas.set(key, structuredClone({ ...entry, idea }));
          }
          continue;
        }
        if (!entry.context.relatedEntities.some(entity => mergedIdentityIds.has(entity.id))) continue;
        this.personalIdeas.set(key, structuredClone({
          ...entry,
          idea: remap(entry.idea),
          context: {
            ...entry.context,
            relatedIdeas: entry.context.relatedIdeas.map(remap),
            relatedEntities: [
              ...entry.context.relatedEntities.filter(entity => !mergedIdentityIds.has(entity.id)),
              mergedEntity
            ].sort((first, second) => first.id.localeCompare(second.id))
          }
        }));
      }
    }
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("PieceTable clona piezas de forma independiente y comparte el pool append-only", async () => {
  const { PieceTable } = await import("../dist/motor-literario.js");
  const original = new PieceTable("abcdef");
  const copy = original.clone();
  copy.replace(3, 3, "XYZ");
  assert.equal(copy.toString(), "abcXYZdef");
  assert.equal(original.toString(), "abcdef");
  original.replace(0, 1, "Q");
  assert.equal(original.toString(), "Qbcdef");
  assert.equal(copy.toString(), "abcXYZdef");
});

test("IndexedDB permite reintentar la apertura después de un error inicial", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let attempts = 0;
  const fakeDatabase = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore() {
          return {
            get() {
              const request = { result: undefined, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                request.onsuccess?.();
                queueMicrotask(() => transaction.oncomplete?.());
              });
              return request;
            }
          };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        attempts++;
        if (attempts === 1) throw new Error("synchronous_open_failure");
        const request = { result: fakeDatabase, error: new Error("temporary_open_failure") };
        queueMicrotask(() => {
          if (attempts === 2) request.onerror?.();
          else request.onsuccess?.();
        });
        return request;
      }
    }
  });

  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(store.loadDocument("project", "chapter"), /synchronous_open_failure/);
    await assert.rejects(store.loadDocument("project", "chapter"), /temporary_open_failure/);
    assert.equal(await store.loadDocument("project", "chapter"), undefined);
    assert.equal(attempts, 3);
  } finally {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else delete globalThis.indexedDB;
  }
});

test("el análisis inicial utiliza el texto reconstruido desde el journal", async () => {
  class RecoverableJournalStore extends MemoryStore {
    changes = [];
    async appendChange(change) {
      this.changes.push(structuredClone(change));
    }
    async loadChanges(projectId, documentId, afterSequence) {
      return this.changes.filter(item =>
        item.projectId === projectId && item.documentId === documentId &&
        item.sequence > afterSequence
      ).sort((a, b) => a.sequence - b.sequence).map(item => structuredClone(item));
    }
    async saveDocumentAndCompactChanges(document, throughSequence) {
      await this.saveDocument(document);
      this.changes = this.changes.filter(item =>
        item.projectId !== document.projectId || item.documentId !== document.documentId ||
        item.sequence > throughSequence
      );
    }
  }

  const store = new RecoverableJournalStore();
  await store.saveDocument({
    projectId: "recovered-analysis", documentId: "chapter",
    text: "Texto inicial.", revision: 0, sequence: 0, updatedAt: 1
  });
  store.changes.push({
    projectId: "recovered-analysis", documentId: "chapter",
    sequence: 1, baseRevision: 0, committedRevision: 1,
    start: 0, end: "Texto inicial.".length,
    replacement: "El personaje Alejandro llegó.",
    committedAt: 2
  });

  const api = new HostEngineApi({ store });
  api.initializeProject({
    projectId: "recovered-analysis", projectName: "Análisis recuperado"
  });
  await api.openDocument({
    documentId: "chapter", text: "Texto inicial.", revision: 0, sequence: 0
  });
  assert.equal(api.getSnapshot("chapter")?.text, "El personaje Alejandro llegó.");
  assert.equal(api.getSnapshot("chapter")?.revision, 1);
  await api.flushPendingChanges();

  const entities = await api.getNarrativeEntities();
  assert.ok(entities.some(entity => entity.canonicalName === "Alejandro"));
});

test("recibe cambios, confirma persistencia y analiza sin modificar el texto", async () => {
  const store = new MemoryStore();
  const analyses = [];
  const commits = [];
  const api = new HostEngineApi({
    store,
    callbacks: {
      onAnalysis: result => analyses.push(result),
      onCommit: result => commits.push(result)
    }
  });
  api.initializeProject({ projectId: "book-1", projectName: "Libro de prueba" });
  await api.openDocument({ documentId: "chapter-1", text: "La casa", revision: 0, sequence: 0 });

  const admission = api.onEditorChange({
    documentId: "chapter-1",
    sequence: 1,
    baseRevision: 0,
    start: 7,
    end: 7,
    replacement: " grande"
  });
  assert.equal(admission.status, "queued");
  if (admission.status !== "queued") return;

  for (let i = 0; i < 20 && !api.pollCommit(admission.ticketId); i++) await tick();
  assert.equal(api.pollCommit(admission.ticketId)?.status, "applied");
  assert.equal(api.getSnapshot("chapter-1")?.text, "La casa grande");
  assert.equal(store.documents.get("book-1:chapter-1")?.text, "La casa grande");
  assert.equal(analyses.length, 1);
  assert.equal(commits.length, 1);
});

test("rechaza desbordamiento de cola sin descartar silenciosamente cambios", async () => {
  const api = new HostEngineApi({ store: new MemoryStore(), queueCapacity: 1 });
  api.initializeProject({ projectId: "book-2", projectName: "Segundo libro" });
  await api.openDocument({ documentId: "chapter", text: "abc", revision: 0, sequence: 0 });

  const first = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0, start: 3, end: 3, replacement: "d"
  });
  const second = api.onEditorChange({
    documentId: "chapter", sequence: 2, baseRevision: 1, start: 4, end: 4, replacement: "e"
  });
  assert.equal(first.status, "queued");
  assert.deepEqual(second, { status: "rejected", reason: "queue_full" });
});

test("limita la memoria de reemplazos pendientes y libera el presupuesto al despachar", async () => {
  const api = new HostEngineApi({
    store: new MemoryStore(), queueCapacity: 8, maxQueuedTextUnits: 5
  });
  api.initializeProject({ projectId: "queued-text-budget", projectName: "Presupuesto de cola" });
  await api.openDocument({ documentId: "chapter", text: "", revision: 0, sequence: 0 });

  assert.deepEqual(api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "123456"
  }), { status: "rejected", reason: "change_too_large" });
  assert.equal(api.getLiveAnalysisMetrics().changeTooLargeRejections, 1);

  assert.equal(api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "123"
  }).status, "queued");
  assert.deepEqual(api.onEditorChange({
    documentId: "chapter", sequence: 2, baseRevision: 1,
    start: 3, end: 3, replacement: "456"
  }), { status: "rejected", reason: "queue_full" });
  assert.equal(api.getLiveAnalysisMetrics().queuedTextUnits, 3);
  assert.equal(api.getLiveAnalysisMetrics().maxQueuedTextUnits, 3);

  await api.flushPendingChanges();
  assert.equal(api.getLiveAnalysisMetrics().queuedTextUnits, 0);
  assert.equal(api.getSnapshot("chapter")?.text, "123");
});

test("clasifica una edición inválida antes de aplicar el límite de cola", async () => {
  const api = new HostEngineApi({ store: new MemoryStore(), queueCapacity: 1 });
  api.initializeProject({ projectId: "invalid-before-full", projectName: "Validación de admisión" });
  await api.openDocument({ documentId: "chapter", text: "", revision: 0, sequence: 0 });

  assert.equal(api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "a"
  }).status, "queued");
  assert.deepEqual(api.onEditorChange({
    documentId: "chapter", sequence: 9, baseRevision: 0,
    start: 0, end: 0, replacement: "b"
  }), { status: "rejected", reason: "invalid_change" });
  assert.equal(api.getLiveAnalysisMetrics().invalidChangeRejections, 1);
  assert.equal(api.getLiveAnalysisMetrics().queueFullRejections, 0);
  await api.flushPendingChanges();
});

test("reserva capacidad de cola para que otro documento no sea expulsado por una ráfaga", async () => {
  const api = new HostEngineApi({
    store: new MemoryStore(), queueCapacity: 8, maxConcurrentDocuments: 2
  });
  api.initializeProject({ projectId: "fair-queue", projectName: "Cola justa" });
  await api.openDocument({ documentId: "chapter-a", text: "", revision: 0, sequence: 0 });
  await api.openDocument({ documentId: "chapter-b", text: "", revision: 0, sequence: 0 });

  for (let sequence = 1; sequence <= 7; sequence++) {
    assert.equal(api.onEditorChange({
      documentId: "chapter-a", sequence, baseRevision: sequence - 1,
      start: sequence - 1, end: sequence - 1, replacement: "a"
    }).status, "queued");
  }
  assert.deepEqual(api.onEditorChange({
    documentId: "chapter-a", sequence: 8, baseRevision: 7,
    start: 7, end: 7, replacement: "a"
  }), { status: "rejected", reason: "queue_full" });
  assert.equal(api.getLiveAnalysisMetrics().rejectedChanges, 1);
  assert.equal(api.getLiveAnalysisMetrics().queueFullRejections, 1);
  assert.equal(api.getLiveAnalysisMetrics().resyncRequiredRejections, 0);

  const otherDocument = api.onEditorChange({
    documentId: "chapter-b", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "b"
  });
  assert.equal(otherDocument.status, "queued");
  assert.equal(api.getLiveAnalysisMetrics().queueDepth, 8);
  await api.flushPendingChanges();
  assert.equal(api.getSnapshot("chapter-a")?.text, "aaaaaaa");
  assert.equal(api.getSnapshot("chapter-b")?.text, "b");
});

test("reserva varios espacios cuando hay tres documentos concurrentes configurados", async () => {
  const api = new HostEngineApi({
    store: new MemoryStore(), queueCapacity: 8, maxConcurrentDocuments: 3
  });
  api.initializeProject({ projectId: "three-way-reservation", projectName: "Reserva triple" });
  await api.openDocument({ documentId: "chapter-a", text: "", revision: 0, sequence: 0 });
  await api.openDocument({ documentId: "chapter-b", text: "", revision: 0, sequence: 0 });
  await api.openDocument({ documentId: "chapter-c", text: "", revision: 0, sequence: 0 });

  for (let sequence = 1; sequence <= 6; sequence++) {
    assert.equal(api.onEditorChange({
      documentId: "chapter-a", sequence, baseRevision: sequence - 1,
      start: sequence - 1, end: sequence - 1, replacement: "a"
    }).status, "queued");
  }
  assert.deepEqual(api.onEditorChange({
    documentId: "chapter-a", sequence: 7, baseRevision: 6,
    start: 6, end: 6, replacement: "a"
  }), { status: "rejected", reason: "queue_full" });

  assert.equal(api.onEditorChange({
    documentId: "chapter-b", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "b"
  }).status, "queued");
  assert.equal(api.onEditorChange({
    documentId: "chapter-c", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "c"
  }).status, "queued");
  assert.equal(api.getLiveAnalysisMetrics().queueDepth, 8);

  await api.flushPendingChanges();
  assert.equal(api.getSnapshot("chapter-a")?.text, "aaaaaa");
  assert.equal(api.getSnapshot("chapter-b")?.text, "b");
  assert.equal(api.getSnapshot("chapter-c")?.text, "c");
  assert.equal(api.getLiveAnalysisMetrics().maxActiveDocuments, 3);
});

test("un fallo de persistencia en un documento no bloquea los demás", async () => {
  class SelectiveFailureStore extends MemoryStore {
    failDocumentId = undefined;
    async saveDocument(document) {
      if (document.documentId === this.failDocumentId) {
        throw new Error("disk_failure_for_one_document");
      }
      return super.saveDocument(document);
    }
  }

  const store = new SelectiveFailureStore();
  const api = new HostEngineApi({ store, maxConcurrentDocuments: 2 });
  api.initializeProject({ projectId: "isolated-write-failure", projectName: "Fallo aislado" });
  await api.openDocument({ documentId: "broken", text: "A", revision: 0, sequence: 0 });
  await api.openDocument({ documentId: "healthy", text: "B", revision: 0, sequence: 0 });
  store.failDocumentId = "broken";

  const broken = api.onEditorChange({
    documentId: "broken", sequence: 1, baseRevision: 0,
    start: 1, end: 1, replacement: "X"
  });
  const healthy = api.onEditorChange({
    documentId: "healthy", sequence: 1, baseRevision: 0,
    start: 1, end: 1, replacement: "Y"
  });
  assert.equal(broken.status, "queued");
  assert.equal(healthy.status, "queued");
  if (broken.status !== "queued" || healthy.status !== "queued") return;

  await api.flushPendingChanges();
  assert.equal(api.pollCommit(broken.ticketId)?.status, "rejected");
  assert.equal(api.pollCommit(healthy.ticketId)?.status, "applied");
  assert.equal(api.getSnapshot("broken")?.text, "A");
  assert.equal(api.getSnapshot("healthy")?.text, "BY");
  assert.equal(api.getDocumentSyncState("broken")?.needsResync, true);
  assert.equal(api.getDocumentSyncState("healthy")?.needsResync, false);
  assert.equal(api.getLiveAnalysisMetrics().activeDocuments, 0);
});

test("procesa documentos independientes en paralelo y conserva FIFO dentro de cada documento", async () => {
  assert.throws(
    () => new HostEngineApi({ store: new MemoryStore(), maxConcurrentDocuments: 9 }),
    /maxConcurrentDocuments/
  );
  class DelayedJournalStore extends MemoryStore {
    changes = [];
    async appendChange(change) {
      if (change.documentId === "slow") {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      this.changes.push(structuredClone(change));
    }
  }

  const commits = [];
  const store = new DelayedJournalStore();
  const api = new HostEngineApi({
    store,
    queueCapacity: 8,
    maxConcurrentDocuments: 2,
    callbacks: { onCommit: result => commits.push(result.ticketId) }
  });
  api.initializeProject({ projectId: "parallel-documents", projectName: "Documentos paralelos" });
  await api.openDocument({ documentId: "slow", text: "", revision: 0, sequence: 0 });
  await api.openDocument({ documentId: "fast", text: "", revision: 0, sequence: 0 });
  await api.openDocument({ documentId: "fast-2", text: "", revision: 0, sequence: 0 });

  const slowFirst = api.onEditorChange({
    documentId: "slow", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "A"
  });
  const slowSecond = api.onEditorChange({
    documentId: "slow", sequence: 2, baseRevision: 1,
    start: 1, end: 1, replacement: "B"
  });
  const fast = api.onEditorChange({
    documentId: "fast", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "Z"
  });
  const fastSecond = api.onEditorChange({
    documentId: "fast-2", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "Y"
  });
  assert.equal(slowFirst.status, "queued");
  assert.equal(slowSecond.status, "queued");
  assert.equal(fast.status, "queued");
  assert.equal(fastSecond.status, "queued");
  if (slowFirst.status !== "queued" || slowSecond.status !== "queued" ||
      fast.status !== "queued" || fastSecond.status !== "queued") return;

  await api.flushPendingChanges();
  assert.deepEqual(commits, [fast.ticketId, fastSecond.ticketId, slowFirst.ticketId, slowSecond.ticketId]);
  assert.equal(api.getSnapshot("slow")?.text, "AB");
  assert.equal(api.getSnapshot("slow")?.revision, 2);
  assert.equal(api.getSnapshot("fast")?.text, "Z");
  assert.equal(api.getSnapshot("fast")?.revision, 1);
  assert.equal(api.getSnapshot("fast-2")?.text, "Y");
  assert.equal(api.getSnapshot("fast-2")?.revision, 1);
  assert.equal(api.getLiveAnalysisMetrics().activeDocuments, 0);
  assert.equal(api.getLiveAnalysisMetrics().maxActiveDocuments, 2);
  assert.equal(api.getLiveAnalysisMetrics().maxActiveChanges, 2);
});

test("no permite cambiar la identidad del proyecto de una instancia", () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "book-a", projectName: "A", writerId: "writer-a" });
  assert.throws(() => api.initializeProject({ projectId: "book-b", projectName: "B", writerId: "writer-a" }));
  assert.throws(() => api.initializeProject({ projectId: "book-a", projectName: "Nombre alterado", writerId: "writer-a" }));
  assert.throws(() => api.initializeProject({ projectId: "book-a", projectName: "A", writerId: "writer-b" }));
});


test("exige resincronización explícita cuando falla la persistencia", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "book-sync", projectName: "Libro sincronizado" });
  await api.openDocument({ documentId: "chapter", text: "abc", revision: 0, sequence: 0 });

  store.saveDocument = async () => { throw new Error("disco_no_disponible"); };
  const admission = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0, start: 3, end: 3, replacement: "d"
  });
  assert.equal(admission.status, "queued");
  if (admission.status !== "queued") return;
  for (let i = 0; i < 20 && !api.pollCommit(admission.ticketId); i++) await tick();

  assert.equal(api.pollCommit(admission.ticketId)?.status, "rejected");
  assert.equal(api.getDocumentSyncState("chapter")?.needsResync, true);
  assert.deepEqual(api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0, start: 3, end: 3, replacement: "d"
  }), { status: "rejected", reason: "resync_required" });
  assert.equal(api.getLiveAnalysisMetrics().resyncRequiredRejections, 1);
  assert.equal(api.getLiveAnalysisMetrics().queueFullRejections, 0);

  store.saveDocument = MemoryStore.prototype.saveDocument.bind(store);
  await api.openDocument({ documentId: "chapter", text: "abcd", revision: 1, sequence: 1 });
  assert.equal(api.getDocumentSyncState("chapter")?.needsResync, false);
  assert.equal(api.getSnapshot("chapter")?.text, "abcd");
});


test("analiza todas las líneas introducidas por una edición multilínea", async () => {
  const analyses = [];
  const api = new HostEngineApi({
    store: new MemoryStore(),
    callbacks: { onAnalysis: result => analyses.push(result) }
  });
  api.initializeProject({ projectId: "book-multiline", projectName: "Edición multilínea" });
  await api.openDocument({ documentId: "chapter", text: "", revision: 0, sequence: 0 });
  const admission = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "Primera línea\n  segunda línea"
  });
  assert.equal(admission.status, "queued");
  if (admission.status !== "queued") return;
  for (let i = 0; i < 20 && !api.pollCommit(admission.ticketId); i++) await tick();
  assert.equal(api.pollCommit(admission.ticketId)?.status, "applied");
  assert.ok(analyses[0]?.diagnostics.some(item =>
    item.ruleId === "multiple-spaces" && item.start === 14
  ));
});


test("rechaza un snapshot del anfitrión que cambia el texto sin avanzar revisión ni secuencia", async () => {
  const store = new MemoryStore();
  const first = new HostEngineApi({ store });
  first.initializeProject({ projectId: "book-authority", projectName: "Autoridad anfitrión" });
  await first.openDocument({ documentId: "chapter", text: "texto local", revision: 3, sequence: 8 });

  const reopened = new HostEngineApi({ store });
  reopened.initializeProject({ projectId: "book-authority", projectName: "Autoridad anfitrión" });
  await assert.rejects(
    reopened.openDocument({ documentId: "chapter", text: "texto del editor", revision: 3, sequence: 8 }),
    /no se permite retroceder ni desalinear revisión y secuencia/
  );
  assert.equal(reopened.getSnapshot("chapter"), undefined);
  assert.equal(store.documents.get("book-authority:chapter")?.text, "texto local");
});


test("el anfitrión puede esperar la persistencia de todos los cambios admitidos", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "book-flush", projectName: "Cierre seguro" });
  await api.openDocument({ documentId: "chapter", text: "A", revision: 0, sequence: 0 });
  const admission = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 1, end: 1, replacement: "B"
  });
  assert.equal(admission.status, "queued");
  await api.flushPendingChanges();
  if (admission.status === "queued") {
    assert.equal(api.pollCommit(admission.ticketId)?.status, "applied");
  }
  assert.equal(api.getSnapshot("chapter")?.text, "AB");
});


test("usa journal incremental y compacta en snapshots periódicos", async () => {
  class JournalStore extends MemoryStore {
    changes = [];
    snapshotWrites = 0;
    atomicCheckpointWrites = 0;
    async saveDocument(document) {
      this.snapshotWrites++;
      await super.saveDocument(document);
    }
    async saveDocumentAndCompactChanges(document, throughSequence) {
      this.atomicCheckpointWrites++;
      await this.saveDocument(document);
      this.changes = this.changes.filter(item =>
        item.projectId !== document.projectId || item.documentId !== document.documentId ||
        item.sequence > throughSequence
      );
    }
    async appendChange(change) {
      this.changes.push(structuredClone(change));
    }
    async compactChanges(projectId, documentId, throughSequence) {
      this.changes = this.changes.filter(item =>
        item.projectId !== projectId || item.documentId !== documentId ||
        item.sequence > throughSequence
      );
    }
  }

  const store = new JournalStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "book-journal", projectName: "Journal incremental" });
  await api.openDocument({ documentId: "chapter", text: "", revision: 0, sequence: 0 });
  assert.equal(store.snapshotWrites, 1);
  assert.equal(store.atomicCheckpointWrites, 0);

  for (let sequence = 1; sequence <= 63; sequence++) {
    const admission = api.onEditorChange({
      documentId: "chapter", sequence, baseRevision: sequence - 1,
      start: sequence - 1, end: sequence - 1, replacement: "x"
    });
    assert.equal(admission.status, "queued");
  }
  await api.flushPendingChanges();
  assert.equal(store.changes.length, 63);
  assert.equal(store.snapshotWrites, 1);
  assert.equal(api.getSnapshot("chapter")?.text.length, 63);

  const admission = api.onEditorChange({
    documentId: "chapter", sequence: 64, baseRevision: 63,
    start: 63, end: 63, replacement: "x"
  });
  assert.equal(admission.status, "queued");
  await api.flushPendingChanges();
  assert.equal(store.snapshotWrites, 2);
  assert.equal(store.atomicCheckpointWrites, 1);
  assert.equal(store.changes.length, 0);
  assert.equal(store.documents.get("book-journal:chapter")?.text.length, 64);
});


test("conserva snapshot y journal ante secuencias duplicadas, saltos o desorden", async () => {
  const makeEntry = (sequence) => ({
    projectId: "journal-integrity",
    documentId: "chapter",
    sequence,
    baseRevision: sequence - 1,
    committedRevision: sequence,
    start: 0,
    end: 0,
    replacement: String(sequence),
    committedAt: sequence
  });
  const scenarios = [
    { name: "duplicada", entries: [makeEntry(1), makeEntry(1)] },
    { name: "con salto", entries: [makeEntry(2)] },
    { name: "fuera de orden", entries: [makeEntry(2), makeEntry(1)] }
  ];

  for (const scenario of scenarios) {
    class CorruptJournalStore extends MemoryStore {
      changes = structuredClone(scenario.entries);
      async loadChanges(projectId, documentId, afterSequence) {
        return structuredClone(this.changes.filter(entry =>
          entry.projectId === projectId && entry.documentId === documentId &&
          entry.sequence > afterSequence
        ));
      }
    }
    const store = new CorruptJournalStore();
    await store.saveDocument({
      projectId: "journal-integrity", documentId: "chapter",
      text: "base", revision: 0, sequence: 0, updatedAt: 1
    });
    const originalSnapshot = await store.loadDocument("journal-integrity", "chapter");
    const originalJournal = structuredClone(store.changes);
    const api = new HostEngineApi({ store });
    api.initializeProject({ projectId: "journal-integrity", projectName: "Integridad" });

    await assert.rejects(
      api.openDocument({ documentId: "chapter", text: "base", revision: 0, sequence: 0 }),
      /Journal inválido o discontinuo/
    );
    assert.equal(api.getSnapshot("chapter"), undefined, scenario.name);
    assert.deepEqual(
      await store.loadDocument("journal-integrity", "chapter"),
      originalSnapshot,
      scenario.name
    );
    assert.deepEqual(store.changes, originalJournal, scenario.name);
  }
});

test("la recuperación rechaza offsets de journal fuera del snapshot sin alterar datos durables", async () => {
  class CorruptOffsetStore extends MemoryStore {
    changes = [];
    async appendChange(change) {
      this.changes.push(structuredClone(change));
    }
    async loadChanges(projectId, documentId, afterSequence) {
      return structuredClone(this.changes.filter(entry =>
        entry.projectId === projectId && entry.documentId === documentId &&
        entry.sequence > afterSequence
      ));
    }
  }

  const store = new CorruptOffsetStore();
  const first = new HostEngineApi({ store });
  first.initializeProject({ projectId: "recovery-invalid-offset", projectName: "Offsets inválidos" });
  await first.openDocument({ documentId: "chapter", text: "abc", revision: 0, sequence: 0 });
  store.changes.push({
    projectId: "recovery-invalid-offset",
    documentId: "chapter",
    sequence: 1,
    baseRevision: 0,
    committedRevision: 1,
    start: 2,
    end: 4,
    replacement: "X",
    committedAt: 1
  });

  const snapshotBefore = await store.loadDocument("recovery-invalid-offset", "chapter");
  const journalBefore = structuredClone(store.changes);
  const reopened = new HostEngineApi({ store });
  reopened.initializeProject({ projectId: "recovery-invalid-offset", projectName: "Offsets inválidos" });

  await assert.rejects(
    reopened.openDocument({ documentId: "chapter", text: "abc", revision: 0, sequence: 0 }),
    /Journal inválido o discontinuo/
  );
  assert.equal(reopened.getSnapshot("chapter"), undefined);
  assert.deepEqual(
    await store.loadDocument("recovery-invalid-offset", "chapter"),
    snapshotBefore
  );
  assert.deepEqual(store.changes, journalBefore);
});

test("no publica un documento si falla el checkpoint atómico de recuperación", async () => {
  class FailingCheckpointStore extends MemoryStore {
    changes = [];
    failCheckpoint = false;
    async appendChange(change) {
      this.changes.push(structuredClone(change));
    }
    async loadChanges(projectId, documentId, afterSequence) {
      return this.changes.filter(item =>
        item.projectId === projectId && item.documentId === documentId &&
        item.sequence > afterSequence
      ).sort((a, b) => a.sequence - b.sequence);
    }
    async saveDocumentAndCompactChanges(document, throughSequence) {
      if (this.failCheckpoint) throw new Error("checkpoint_unavailable");
      await super.saveDocument(document);
      this.changes = this.changes.filter(item =>
        item.projectId !== document.projectId || item.documentId !== document.documentId ||
        item.sequence > throughSequence
      );
    }
  }

  const store = new FailingCheckpointStore();
  const first = new HostEngineApi({ store });
  first.initializeProject({ projectId: "checkpoint-recovery", projectName: "Recuperación" });
  await first.openDocument({ documentId: "chapter", text: "A", revision: 0, sequence: 0 });
  store.changes.push({
    projectId: "checkpoint-recovery", documentId: "chapter",
    sequence: 1, baseRevision: 0, committedRevision: 1,
    start: 1, end: 1, replacement: "B", committedAt: Date.now()
  });
  store.failCheckpoint = true;

  const reopened = new HostEngineApi({ store });
  reopened.initializeProject({ projectId: "checkpoint-recovery", projectName: "Recuperación" });
  await assert.rejects(
    reopened.openDocument({ documentId: "chapter", text: "A", revision: 0, sequence: 0 }),
    /checkpoint_unavailable/
  );
  assert.equal(reopened.getSnapshot("chapter"), undefined);
  assert.equal(store.documents.get("checkpoint-recovery:chapter").text, "A");
  assert.equal(store.changes.length, 1);
});

test("aplica reemplazos sucesivos sobre fragmentos originales y añadidos", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "book-piece-table", projectName: "Tabla de piezas" });
  await api.openDocument({ documentId: "chapter", text: "abcdef", revision: 0, sequence: 0 });

  const changes = [
    { sequence: 1, baseRevision: 0, start: 1, end: 3, replacement: "123" },
    { sequence: 2, baseRevision: 1, start: 2, end: 5, replacement: "Z" },
    { sequence: 3, baseRevision: 2, start: 0, end: 2, replacement: "" }
  ];
  for (const change of changes) {
    const admission = api.onEditorChange({ documentId: "chapter", ...change });
    assert.equal(admission.status, "queued");
    await api.flushPendingChanges();
  }
  assert.equal(api.getSnapshot("chapter")?.text, "Zef");
  assert.equal(api.getSnapshot("chapter")?.revision, 3);
});


test("si falla el journal, no aplica la edición en memoria", async () => {
  class BrokenJournalStore extends MemoryStore {
    async appendChange() { throw new Error("journal_no_disponible"); }
    async compactChanges() {}
  }
  const api = new HostEngineApi({ store: new BrokenJournalStore() });
  api.initializeProject({ projectId: "book-journal-failure", projectName: "Journal fallido" });
  await api.openDocument({ documentId: "chapter", text: "original", revision: 0, sequence: 0 });
  const admission = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 8, end: 8, replacement: " alterado"
  });
  assert.equal(admission.status, "queued");
  await api.flushPendingChanges();
  if (admission.status === "queued") {
    assert.equal(api.pollCommit(admission.ticketId)?.status, "rejected");
  }
  assert.equal(api.getSnapshot("chapter")?.text, "original");
  assert.equal(api.getDocumentSyncState("chapter")?.needsResync, true);
});


test("analiza la línea posterior a un salto inicial con offsets absolutos", async () => {
  const analyses = [];
  const api = new HostEngineApi({
    store: new MemoryStore(),
    callbacks: { onAnalysis: result => analyses.push(result) }
  });
  api.initializeProject({ projectId: "book-leading-newline", projectName: "Salto inicial" });
  await api.openDocument({ documentId: "chapter", text: "\n  palabra", revision: 0, sequence: 0 });
  const admission = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 1, end: 1, replacement: "Inicio"
  });
  assert.equal(admission.status, "queued");
  await api.flushPendingChanges();
  assert.ok(analyses[0]?.diagnostics.some(item =>
    item.ruleId === "multiple-spaces" && item.start === 7
  ));
});


test("una apertura en curso bloquea duplicados y cambios antes de publicar el documento", async () => {
  let releaseLoad;
  let startedLoad;
  const loadStarted = new Promise(resolve => { startedLoad = resolve; });
  const loadGate = new Promise(resolve => { releaseLoad = resolve; });
  class GatedLoadStore extends MemoryStore {
    async loadDocument(projectId, documentId) {
      startedLoad();
      await loadGate;
      return super.loadDocument(projectId, documentId);
    }
  }

  const store = new GatedLoadStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "opening-race", projectName: "Apertura concurrente" });
  const opening = api.openDocument({
    documentId: "chapter", text: "base", revision: 0, sequence: 0
  });
  await loadStarted;

  await assert.rejects(
    api.openDocument({ documentId: "chapter", text: "otra base", revision: 0, sequence: 0 }),
    /operaciones activas/
  );
  assert.equal(api.getSnapshot("chapter"), undefined);
  assert.equal(api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "X"
  }).reason, "resync_required");

  releaseLoad();
  await opening;
  assert.equal(api.getSnapshot("chapter")?.text, "base");
  assert.equal(api.getDocumentSyncState("chapter")?.needsResync, false);
});

test("la apertura de un documento no bloquea documentos independientes", async () => {
  let releaseSlow;
  let startedSlow;
  const slowStarted = new Promise(resolve => { startedSlow = resolve; });
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  class IndependentOpenStore extends MemoryStore {
    async loadDocument(projectId, documentId) {
      if (documentId === "chapter-slow") {
        startedSlow();
        await slowGate;
      }
      return super.loadDocument(projectId, documentId);
    }
  }

  const api = new HostEngineApi({ store: new IndependentOpenStore() });
  api.initializeProject({ projectId: "independent-opens", projectName: "Aperturas independientes" });
  const slowOpening = api.openDocument({
    documentId: "chapter-slow", text: "lento", revision: 0, sequence: 0
  });
  await slowStarted;

  await api.openDocument({
    documentId: "chapter-fast", text: "rápido", revision: 0, sequence: 0
  });
  assert.equal(api.getSnapshot("chapter-fast")?.text, "rápido");
  assert.equal(api.getSnapshot("chapter-slow"), undefined);

  releaseSlow();
  await slowOpening;
  assert.equal(api.getSnapshot("chapter-slow")?.text, "lento");
});

test("una apertura fallida libera el bloqueo y permite reintentar sin publicar estado parcial", async () => {
  class RecoveringInitialStore extends MemoryStore {
    attempts = 0;
    async saveDocument(document) {
      this.attempts++;
      if (this.attempts === 1) throw new Error("initial_save_failed");
      await super.saveDocument(document);
    }
  }
  const api = new HostEngineApi({ store: new RecoveringInitialStore() });
  api.initializeProject({ projectId: "book-open-failure", projectName: "Apertura fallida" });
  const snapshot = { documentId: "chapter", text: "texto", revision: 0, sequence: 0 };
  await assert.rejects(api.openDocument(snapshot), /initial_save_failed/);
  assert.equal(api.getSnapshot("chapter"), undefined);
  assert.deepEqual(api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "x"
  }), { status: "rejected", reason: "unknown_document" });
  assert.equal(api.getLiveAnalysisMetrics().unknownDocumentRejections, 1);
  assert.equal(api.getLiveAnalysisMetrics().invalidChangeRejections, 0);

  await api.openDocument(snapshot);
  assert.equal(api.getSnapshot("chapter")?.text, "texto");
  assert.equal(api.getDocumentSyncState("chapter")?.needsResync, false);
});


test("recupera tras reinicio reproduciendo deltas posteriores al último snapshot", async () => {
  class RecoverableStore extends MemoryStore {
    changes = [];
    async appendChange(change) {
      this.changes.push(structuredClone(change));
    }
    async loadChanges(projectId, documentId, afterSequence) {
      return this.changes
        .filter(item => item.projectId === projectId &&
          item.documentId === documentId && item.sequence > afterSequence)
        .sort((a, b) => a.sequence - b.sequence)
        .map(item => structuredClone(item));
    }
    atomicCheckpoints = 0;
    async saveDocumentAndCompactChanges(document, throughSequence) {
      this.atomicCheckpoints++;
      await super.saveDocument(document);
      this.changes = this.changes.filter(item =>
        item.projectId !== document.projectId || item.documentId !== document.documentId ||
        item.sequence > throughSequence
      );
    }
    async compactChanges(projectId, documentId, throughSequence) {
      this.changes = this.changes.filter(item =>
        item.projectId !== projectId || item.documentId !== documentId ||
        item.sequence > throughSequence
      );
    }
  }

  const store = new RecoverableStore();
  const originalSnapshot = {
    documentId: "chapter", text: "Había una casa",
    revision: 10, sequence: 20
  };
  const firstSession = new HostEngineApi({ store });
  firstSession.initializeProject({ projectId: "book-recovery", projectName: "Recuperación" });
  await firstSession.openDocument(originalSnapshot);

  const admission = firstSession.onEditorChange({
    documentId: "chapter", sequence: 21, baseRevision: 10,
    start: 14, end: 14, replacement: " azul"
  });
  assert.equal(admission.status, "queued");
  await firstSession.flushPendingChanges();
  assert.equal(store.documents.get("book-recovery:chapter")?.sequence, 20);
  assert.equal(store.changes.length, 1);

  const restarted = new HostEngineApi({ store });
  restarted.initializeProject({ projectId: "book-recovery", projectName: "Recuperación" });
  await restarted.openDocument(originalSnapshot);

  assert.equal(restarted.getSnapshot("chapter")?.text, "Había una casa azul");
  assert.equal(restarted.getSnapshot("chapter")?.revision, 11);
  assert.equal(restarted.getSnapshot("chapter")?.sequence, 21);
  assert.equal(store.documents.get("book-recovery:chapter")?.sequence, 21);
  assert.equal(store.changes.length, 0);
  assert.equal(store.atomicCheckpoints, 1);
});


test("un snapshot distinto del anfitrión invalida deltas anteriores", async () => {
  class RecoverableStore extends MemoryStore {
    changes = [];
    async loadChanges(projectId, documentId, afterSequence) {
      return this.changes.filter(item =>
        item.projectId === projectId && item.documentId === documentId &&
        item.sequence > afterSequence
      );
    }
    async compactChanges(projectId, documentId, throughSequence) {
      this.changes = this.changes.filter(item =>
        item.projectId !== projectId || item.documentId !== documentId ||
        item.sequence > throughSequence
      );
    }
  }
  const store = new RecoverableStore();
  store.documents.set("book-authority-reset:chapter", {
    projectId: "book-authority-reset", documentId: "chapter",
    text: "estado viejo", revision: 5, sequence: 5, updatedAt: 1
  });
  store.changes.push({
    projectId: "book-authority-reset", documentId: "chapter",
    sequence: 6, baseRevision: 5, start: 11, end: 11,
    replacement: " corrupto", committedRevision: 6, committedAt: 2
  });
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "book-authority-reset", projectName: "Reset" });
  await api.openDocument({
    documentId: "chapter", text: "nuevo estado", revision: 9, sequence: 9
  });
  assert.equal(api.getSnapshot("chapter")?.text, "nuevo estado");
  assert.equal(api.getSnapshot("chapter")?.sequence, 9);
  assert.equal(store.changes.length, 0);
});


test("rechaza y conserva un journal corrupto sin publicar una reconstrucción parcial", async () => {
  class CorruptStore extends MemoryStore {
    changes = [];
    async loadChanges(projectId, documentId, afterSequence) {
      return this.changes.filter(item =>
        item.projectId === projectId && item.documentId === documentId &&
        item.sequence > afterSequence
      );
    }
    async compactChanges(projectId, documentId, throughSequence) {
      this.changes = this.changes.filter(item =>
        item.projectId !== projectId || item.documentId !== documentId ||
        item.sequence > throughSequence
      );
    }
  }
  const store = new CorruptStore();
  const snapshot = {
    projectId: "book-corrupt-journal", documentId: "chapter",
    text: "base", revision: 4, sequence: 7, updatedAt: 1
  };
  store.documents.set("book-corrupt-journal:chapter", structuredClone(snapshot));
  store.changes.push(
    {
      projectId: "book-corrupt-journal", documentId: "chapter",
      sequence: 8, baseRevision: 4, start: 4, end: 4,
      replacement: " válido", committedRevision: 5, committedAt: 2
    },
    {
      projectId: "book-corrupt-journal", documentId: "chapter",
      sequence: 10, baseRevision: 5, start: 10, end: 10,
      replacement: " inválido", committedRevision: 6, committedAt: 3
    }
  );
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "book-corrupt-journal", projectName: "Journal corrupto" });
  await assert.rejects(
    api.openDocument({
      documentId: "chapter", text: "base", revision: 4, sequence: 7
    }),
    /Journal inválido o discontinuo/
  );
  assert.equal(api.getSnapshot("chapter"), undefined);
  assert.equal(store.documents.get("book-corrupt-journal:chapter")?.text, "base");
  assert.equal(store.changes.length, 2);
  assert.equal(store.changes[0].sequence, 8);
  assert.equal(store.changes[1].sequence, 10);
});


test("rechaza entradas malformadas del anfitrión sin romper la sesión", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  assert.throws(() => api.initializeProject(null), /identidad del proyecto o del escritor es inválida/);
  api.initializeProject({ projectId: "book-input-validation", projectName: "Validación" });
  await assert.rejects(api.openDocument({
    documentId: "chapter", text: null, revision: 0, sequence: 0
  }), /Snapshot de documento inválido/);
  await api.openDocument({
    documentId: "chapter", text: "base", revision: 0, sequence: 0
  });
  assert.deepEqual(api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 4, end: 4, replacement: null
  }), { status: "rejected", reason: "invalid_change" });
  assert.equal(api.getLiveAnalysisMetrics().invalidChangeRejections, 1);
  assert.equal(api.getLiveAnalysisMetrics().unknownDocumentRejections, 0);
  assert.equal(api.getSnapshot("chapter")?.text, "base");
});


test("bloquea resincronización mientras una edición sigue persistiendo", async () => {
  let releaseAppend;
  let appendStarted;
  const started = new Promise(resolve => { appendStarted = resolve; });
  const blocked = new Promise(resolve => { releaseAppend = resolve; });
  class SlowJournalStore extends MemoryStore {
    async appendChange(change) {
      appendStarted();
      await blocked;
      this.lastChange = structuredClone(change);
    }
    async loadChanges() { return []; }
  }
  const store = new SlowJournalStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "book-open-race", projectName: "Carrera de apertura" });
  await api.openDocument({ documentId: "chapter", text: "A", revision: 0, sequence: 0 });
  const admission = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 1, end: 1, replacement: "B"
  });
  assert.equal(admission.status, "queued");
  await started;
  await assert.rejects(
    api.openDocument({ documentId: "chapter", text: "A", revision: 0, sequence: 0 }),
    /operaciones activas/
  );
  releaseAppend();
  await api.flushPendingChanges();
  assert.equal(api.getSnapshot("chapter")?.text, "AB");
});


test("rechaza resincronizaciones que desalinean revisión y secuencia sin tocar el journal", async () => {
  for (const incoming of [
    { revision: 5, sequence: 10 },
    { revision: 4, sequence: 11 }
  ]) {
    class JournalStore extends MemoryStore {
      changes = [{
        projectId: "aligned-snapshot",
        documentId: "chapter",
        sequence: 11,
        baseRevision: 4,
        committedRevision: 5,
        start: 1,
        end: 1,
        replacement: "B",
        committedAt: 11
      }];
      checkpointCalls = 0;
      async saveDocumentAndCompactChanges(document, throughSequence) {
        this.checkpointCalls++;
        await super.saveDocument(document);
        this.changes = this.changes.filter(entry =>
          entry.sequence > throughSequence
        );
      }
    }
    const store = new JournalStore();
    await store.saveDocument({
      projectId: "aligned-snapshot", documentId: "chapter",
      text: "A", revision: 4, sequence: 10, updatedAt: 1
    });
    const before = await store.loadDocument("aligned-snapshot", "chapter");
    const journalBefore = structuredClone(store.changes);
    const api = new HostEngineApi({ store });
    api.initializeProject({ projectId: "aligned-snapshot", projectName: "Revisión alineada" });

    await assert.rejects(
      api.openDocument({
        documentId: "chapter", text: "host-newer",
        revision: incoming.revision, sequence: incoming.sequence
      }),
      /no se permite retroceder ni desalinear revisión y secuencia/
    );
    assert.equal(api.getSnapshot("chapter"), undefined);
    assert.deepEqual(
      await store.loadDocument("aligned-snapshot", "chapter"),
      before
    );
    assert.deepEqual(store.changes, journalBefore);
    assert.equal(store.checkpointCalls, 0);
  }
});

test("IndexedDB impide que un guardado atrasado reemplace un snapshot más reciente", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const originalKeyRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  const documents = new Map();
  const key = (projectId, documentId) => projectId + ":" + documentId;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      let finished = false;
      const transaction = {
        error: null,
        objectStore(name) {
          if (name === "documents") return {
            get([projectId, documentId]) {
              const request = {};
              queueMicrotask(() => {
                request.result = documents.get(key(projectId, documentId));
                request.onsuccess?.();
              });
              return request;
            },
            put(document) {
              documents.set(key(document.projectId, document.documentId), structuredClone(document));
              queueMicrotask(() => {
                if (finished) return;
                finished = true;
                transaction.oncomplete?.();
              });
            }
          };
          return {
            index() {
              return { openCursor() {
                const request = {};
                queueMicrotask(() => {
                  request.result = null;
                  request.onsuccess?.();
                });
                return request;
              } };
            }
          };
        },
        abort() {
          if (finished) return;
          finished = true;
          queueMicrotask(() => transaction.onabort?.());
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: { bound: (...bounds) => bounds }
  });

  try {
    const store = new IndexedDbProjectStore();
    const initial = {
      projectId: "snapshot-monotonic", documentId: "chapter",
      text: "base", revision: 4, sequence: 4, updatedAt: 1
    };
    const latest = {
      ...initial, text: "edición reciente", revision: 5, sequence: 5, updatedAt: 2
    };
    await store.saveDocument(initial);
    await store.saveDocument(latest);

    await assert.rejects(
      store.saveDocument(initial),
      /Guardado rechazado/
    );
    await assert.rejects(
      store.saveDocument({ ...latest, text: "rama divergente" }),
      /Guardado rechazado/
    );
    await store.saveDocument({ ...latest, updatedAt: 3 });

    assert.deepEqual(documents.get(key("snapshot-monotonic", "chapter")), {
      ...latest, updatedAt: 3
    });
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
    if (originalKeyRange) Object.defineProperty(globalThis, "IDBKeyRange", originalKeyRange);
    else delete globalThis.IDBKeyRange;
  }
});

test("IndexedDB solo compacta checkpoints reconstruibles desde el journal durable", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const originalKeyRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  const key = (projectId, documentId) => projectId + ":" + documentId;
  const makeDatabase = (initialDocument, initialChanges) => {
    const documents = new Map(initialDocument
      ? [[key(initialDocument.projectId, initialDocument.documentId), structuredClone(initialDocument)]]
      : []);
    const changes = initialChanges.map(item => structuredClone(item));
    const database = {
      onversionchange: null,
      close() {},
      transaction() {
        let finished = false;
        let pending = 0;
        const tx = {
          error: null,
          objectStore(name) {
            if (name === "documents") return {
              get([projectId, documentId]) {
                pending++;
                const request = {};
                queueMicrotask(() => {
                  request.result = documents.get(key(projectId, documentId));
                  request.onsuccess?.();
                  pending--;
                  completeIfReady();
                });
                return request;
              },
              put(document) {
                pending++;
                queueMicrotask(() => {
                  documents.set(key(document.projectId, document.documentId), structuredClone(document));
                  pending--;
                  completeIfReady();
                });
              }
            };
            return {
              index() {
                return {
                  openCursor(bounds) {
                    pending++;
                    const request = {};
                    const [lower, upper] = bounds;
                    const entries = changes
                      .filter(item => {
                        const tuple = [item.projectId, item.documentId, item.sequence];
                        return tuple[0] === lower[0] && tuple[1] === lower[1] &&
                          tuple[2] >= lower[2] && tuple[2] <= upper[2];
                      })
                      .sort((a, b) => a.sequence - b.sequence);
                    let position = 0;
                    const dispatch = () => queueMicrotask(() => {
                      const entry = entries[position];
                      if (!entry) {
                        request.result = null;
                        request.onsuccess?.();
                        pending--;
                        completeIfReady();
                        return;
                      }
                      request.result = {
                        value: entry,
                        delete() {
                          const index = changes.findIndex(item =>
                            item.projectId === entry.projectId &&
                            item.documentId === entry.documentId &&
                            item.sequence === entry.sequence
                          );
                          if (index >= 0) changes.splice(index, 1);
                        },
                        continue() { position++; dispatch(); }
                      };
                      request.onsuccess?.();
                    });
                    dispatch();
                    return request;
                  }
                };
              }
            };
          },
          abort() {
            if (finished) return;
            finished = true;
            queueMicrotask(() => tx.onabort?.());
          }
        };
        function completeIfReady() {
          if (finished || pending !== 0) return;
          finished = true;
          queueMicrotask(() => tx.oncomplete?.());
        }
        return tx;
      }
    };
    return { database, documents, changes };
  };

  const base = {
    projectId: "checkpoint-proof", documentId: "chapter",
    text: "abc", revision: 0, sequence: 0, updatedAt: 1
  };
  const deltas = [
    { ...base, sequence: 1, baseRevision: 0, committedRevision: 1,
      start: 3, end: 3, replacement: "d", committedAt: 2 },
    { ...base, sequence: 2, baseRevision: 1, committedRevision: 2,
      start: 0, end: 1, replacement: "A", committedAt: 3 }
  ];
  const scenarios = [
    { name: "valid", changes: [...deltas, {
      ...base, sequence: 3, baseRevision: 2, committedRevision: 3,
      start: 4, end: 4, replacement: "!", committedAt: 5
    }], snapshot: {
      ...base, text: "Abcd", revision: 2, sequence: 2, updatedAt: 4
    }, succeeds: true },
    { name: "same sequence covered journal", initialDocument: {
      ...base, text: "Abcd", revision: 2, sequence: 2, updatedAt: 4
    }, changes: [...deltas, {
      ...base, sequence: 3, baseRevision: 2, committedRevision: 3,
      start: 4, end: 4, replacement: "!", committedAt: 5
    }], snapshot: {
      ...base, text: "Abcd", revision: 2, sequence: 2, updatedAt: 4
    }, succeeds: true },
    { name: "wrong text", changes: deltas, snapshot: {
      ...base, text: "no corresponde", revision: 2, sequence: 2, updatedAt: 4
    }, succeeds: false },
    { name: "journal gap", changes: [deltas[1]], snapshot: {
      ...base, text: "Abc", revision: 2, sequence: 2, updatedAt: 4
    }, succeeds: false },
    { name: "orphan future delta", initialDocument: undefined, changes: [{
      ...base, sequence: 3, baseRevision: 2, committedRevision: 3,
      start: 3, end: 3, replacement: "!", committedAt: 5
    }], snapshot: {
      ...base, text: "Abcd", revision: 2, sequence: 2, updatedAt: 4
    }, succeeds: false }
  ];

  try {
    for (const scenario of scenarios) {
      const initialDocument = scenario.initialDocument ??
        (scenario.name === "orphan future delta" ? undefined : base);
      const state = makeDatabase(initialDocument, scenario.changes);
      Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: { open() {
          const request = { result: state.database };
          queueMicrotask(() => request.onsuccess?.());
          return request;
        } }
      });
      Object.defineProperty(globalThis, "IDBKeyRange", {
        configurable: true,
        value: { bound: (lower, upper) => [lower, upper] }
      });
      const store = new IndexedDbProjectStore();
      if (scenario.succeeds) {
        await store.saveDocumentAndCompactChanges(scenario.snapshot, 2);
        assert.deepEqual(state.documents.get(key(base.projectId, base.documentId)), scenario.snapshot);
        assert.deepEqual(
          state.changes.map(item => item.sequence),
          scenario.name === "valid" || scenario.name === "same sequence covered journal" ? [3] : []
        );
      } else {
        await assert.rejects(
          store.saveDocumentAndCompactChanges(scenario.snapshot, 2),
          /Checkpoint obsoleto o inconsistente/
        );
        assert.deepEqual(
          state.documents.get(key(base.projectId, base.documentId)),
          scenario.name === "orphan future delta" ? undefined : base
        );
        assert.deepEqual(state.changes, scenario.changes);
      }
    }
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
    if (originalKeyRange) Object.defineProperty(globalThis, "IDBKeyRange", originalKeyRange);
    else delete globalThis.IDBKeyRange;
  }
});

test("IndexedDB impide anexar una rama basada en una revisión antigua", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const originalKeyRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  const documents = new Map();
  const changes = [];
  const key = (projectId, documentId) => projectId + ":" + documentId;
  const database = {
    onversionchange: null,
    close() {},
    transaction(_stores, _mode) {
      let finished = false;
      const tx = {
        error: null,
        objectStore(name) {
          if (name === "documents") {
            return {
              get([projectId, documentId]) {
                const request = {};
                queueMicrotask(() => {
                  request.result = documents.get(key(projectId, documentId));
                  request.onsuccess?.();
                });
                return request;
              }
            };
          }
          return {
            index() {
              return {
                openCursor() {
                  const request = {};
                  let index = 0;
                  const dispatch = () => queueMicrotask(() => {
                    const ordered = [...changes].sort((a, b) => a.sequence - b.sequence);
                    const entry = ordered[index];
                    request.result = entry ? {
                      value: entry,
                      continue() { index++; dispatch(); }
                    } : null;
                    request.onsuccess?.();
                  });
                  dispatch();
                  return request;
                }
              };
            },
            add(change) {
              if (changes.some(entry => entry.projectId === change.projectId &&
                  entry.documentId === change.documentId && entry.sequence === change.sequence)) {
                tx.error = new Error("ConstraintError");
                tx.abort();
                return;
              }
              changes.push(structuredClone(change));
              queueMicrotask(() => {
                if (!finished) {
                  finished = true;
                  tx.oncomplete?.();
                }
              });
            }
          };
        },
        abort() {
          if (finished) return;
          finished = true;
          queueMicrotask(() => tx.onabort?.());
        }
      };
      return tx;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: { bound: (...bounds) => bounds }
  });

  try {
    documents.set(key("shared", "chapter"), {
      projectId: "shared", documentId: "chapter", text: "base",
      revision: 5, sequence: 5, updatedAt: 1
    });
    changes.push({
      projectId: "shared", documentId: "chapter", sequence: 6,
      baseRevision: 5, committedRevision: 6, start: 0, end: 0,
      replacement: "A", committedAt: 2
    });
    const store = new IndexedDbProjectStore();
    const next = {
      projectId: "shared", documentId: "chapter", sequence: 7,
      baseRevision: 6, committedRevision: 7, start: 0, end: 0,
      replacement: "B", committedAt: 3
    };
    await assert.rejects(
      store.appendChange({ ...next, baseRevision: 5, committedRevision: 6 }),
      /requiere resincronización/
    );
    assert.equal(changes.length, 1);
    changes.push({
      projectId: "shared", documentId: "chapter", sequence: 8,
      baseRevision: 7, committedRevision: 8, start: 0, end: 0,
      replacement: "gap", committedAt: 4
    });
    await assert.rejects(
      store.appendChange({ ...next, sequence: 9, baseRevision: 8, committedRevision: 9 }),
      /requiere resincronización/
    );
    changes.pop();
    await store.appendChange(next);
    assert.equal(changes.length, 2);
    assert.equal(changes[1].sequence, 7);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
    if (originalKeyRange) Object.defineProperty(globalThis, "IDBKeyRange", originalKeyRange);
    else delete globalThis.IDBKeyRange;
  }
});

test("IndexedDB impide avanzar un snapshot compatible mientras haya deltas pendientes", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const originalKeyRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  const documents = new Map([["safe:chapter", {
    projectId: "safe", documentId: "chapter", text: "base",
    revision: 0, sequence: 0, updatedAt: 1
  }]]);
  const changes = [{
    projectId: "safe", documentId: "chapter", sequence: 1,
    baseRevision: 0, committedRevision: 1, start: 4, end: 4,
    replacement: "!", committedAt: 2
  }];
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      let finished = false;
      const tx = {
        error: null,
        objectStore(name) {
          if (name === "documents") return {
            get() {
              const request = {};
              queueMicrotask(() => {
                request.result = documents.get("safe:chapter");
                request.onsuccess?.();
              });
              return request;
            },
            put(value) {
              documents.set("safe:chapter", structuredClone(value));
              queueMicrotask(() => {
                if (!finished) { finished = true; tx.oncomplete?.(); }
              });
            }
          };
          return {
            index() {
              return { openCursor() {
                const request = {};
                queueMicrotask(() => {
                  request.result = changes.length ? { value: changes[0] } : null;
                  request.onsuccess?.();
                });
                return request;
              } };
            }
          };
        },
        abort() {
          if (finished) return;
          finished = true;
          queueMicrotask(() => tx.onabort?.());
        }
      };
      return tx;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: { bound: (...bounds) => bounds }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(store.saveDocument({
      projectId: "safe", documentId: "chapter", text: "base!",
      revision: 1, sequence: 1, updatedAt: 3
    }), /journal vacío/);
    assert.equal(documents.get("safe:chapter").sequence, 0);
    assert.equal(changes.length, 1);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
    if (originalKeyRange) Object.defineProperty(globalThis, "IDBKeyRange", originalKeyRange);
    else delete globalThis.IDBKeyRange;
  }
});

test("IndexedDB no entrega el journal hasta completar la transacción de lectura", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const originalKeyRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  const rows = [{
    projectId: "read-atomic", documentId: "chapter", sequence: 4,
    baseRevision: 8, committedRevision: 9, start: 0, end: 0,
    replacement: "x", committedAt: 2
  }];
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore() {
          return { index() {
            return { getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = structuredClone(rows);
                request.onsuccess?.();
              });
              return request;
            } };
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: { bound: (...bounds) => bounds }
  });
  try {
    const store = new IndexedDbProjectStore();
    let settled = false;
    const pending = store.loadChanges("read-atomic", "chapter", 3).then(result => {
      settled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(settled, false);
    transaction.oncomplete?.();
    assert.deepEqual(await pending, rows);
    assert.equal(settled, true);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
    if (originalKeyRange) Object.defineProperty(globalThis, "IDBKeyRange", originalKeyRange);
    else delete globalThis.IDBKeyRange;
  }
});

test("IndexedDB no entrega registros narrativos cuando su transacción termina abortada", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: new Error("transaction_aborted"),
        objectStore() {
          return { index() {
            return { getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = [{ projectId: "aborted-read", id: "entity-1" }];
                request.onsuccess?.();
              });
              return request;
            } };
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    const pending = store.loadEntities("aborted-read");
    await new Promise(resolve => setTimeout(resolve, 0));
    transaction.onabort?.();
    await assert.rejects(pending, /transaction_aborted/);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB rechaza un journal con saltos de secuencia al leerlo", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const originalKeyRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  const rows = [{
    projectId: "journal-gap-read", documentId: "chapter",
    sequence: 5, baseRevision: 4, committedRevision: 5,
    start: 0, end: 0, replacement: "x", committedAt: 5
  }];
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore() {
          return { index() {
            return { getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = structuredClone(rows);
                request.onsuccess?.();
              });
              return request;
            } };
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: { bound: (...bounds) => bounds }
  });
  try {
    const store = new IndexedDbProjectStore();
    let settled = false;
    const pending = store.loadChanges("journal-gap-read", "chapter", 3).then(
      value => { settled = true; return value; },
      error => { settled = true; throw error; }
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(settled, false);
    transaction.oncomplete?.();
    await assert.rejects(pending, /Journal inconsistente/);
    assert.equal(settled, true);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
    if (originalKeyRange) Object.defineProperty(globalThis, "IDBKeyRange", originalKeyRange);
    else delete globalThis.IDBKeyRange;
  }
});

test("IndexedDB espera el cierre de transacción para lecturas de conocimiento narrativo", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let transaction;
  const records = [{
    projectId: "narrative-read",
    id: "entity-1",
    kind: "character",
    canonicalName: "Ada",
    normalizedName: "ada",
    aliases: [],
    evidence: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
    extractionVersion: 1
  }];
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore() {
          return { index() {
            return { getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = structuredClone(records);
                request.onsuccess?.();
              });
              return request;
            } };
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    let settled = false;
    const pending = store.loadEntities("narrative-read").then(value => {
      settled = true;
      return value;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(settled, false);
    transaction.oncomplete?.();
    assert.deepEqual(await pending, records);
    assert.equal(settled, true);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB no entrega un snapshot leído hasta completar la transacción", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const stored = {
    projectId: "read-document", documentId: "chapter", text: "contenido",
    revision: 2, sequence: 2, updatedAt: 5
  };
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore() {
          return { get() {
            const request = {};
            queueMicrotask(() => {
              request.result = structuredClone(stored);
              request.onsuccess?.();
            });
            return request;
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    let settled = false;
    const pending = store.loadDocument("read-document", "chapter").then(value => {
      settled = true;
      return value;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(settled, false);
    transaction.oncomplete?.();
    assert.deepEqual(await pending, stored);
    assert.equal(settled, true);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB crea el esquema completo al inicializar una base nueva", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const stores = new Map();
  const createdStores = [];
  const createdIndexes = [];
  const makeStore = (name, options) => {
    const indexes = new Map();
    const store = {
      keyPath: options.keyPath,
      indexNames: { contains: indexName => indexes.has(indexName) },
      createIndex(indexName, keyPath, indexOptions) {
        indexes.set(indexName, {
          keyPath,
          unique: indexOptions?.unique ?? false
        });
        createdIndexes.push({ store: name, name: indexName, keyPath, unique: indexOptions?.unique ?? false });
      },
      deleteIndex(indexName) { indexes.delete(indexName); },
      index(indexName) {
        const metadata = indexes.get(indexName);
        assert.ok(metadata, `índice inexistente: ${name}.${indexName}`);
        return {
          ...metadata,
          getAll() {
            const request = {};
            queueMicrotask(() => {
              request.result = [];
              request.onsuccess?.();
              queueMicrotask(() => transaction.oncomplete?.());
            });
            return request;
          }
        };
      }
    };
    stores.set(name, store);
    createdStores.push({ name, keyPath: options.keyPath });
    return store;
  };
  let transaction;
  const database = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore: makeStore,
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore(name) { return stores.get(name); }
      };
      return transaction;
    }
  };
  const upgradeTransaction = { objectStore(name) { return stores.get(name); } };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open(_name, version) {
      assert.equal(version, 22);
      const request = { result: database, transaction: upgradeTransaction };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    assert.deepEqual(await store.loadEntities("fresh-database"), []);
    assert.deepEqual(createdStores, [
      { name: "project-settings", keyPath: ["projectId", "key"] },
      { name: "language-profiles", keyPath: ["projectId", "id"] },
      { name: "language-resource-refs", keyPath: ["projectId", "id"] },
      { name: "style-profiles", keyPath: ["projectId", "id"] },
      { name: "timeline-tracks", keyPath: ["projectId", "id"] },
      { name: "record-lifecycles", keyPath: ["projectId", "id"] },
      { name: "relation-lifecycles", keyPath: ["projectId", "id"] },
      { name: "event-lifecycles", keyPath: ["projectId", "id"] },
      { name: "documents", keyPath: ["projectId", "documentId"] },
      { name: "changes", keyPath: ["projectId", "documentId", "sequence"] },
      { name: "narrative-entities", keyPath: ["projectId", "id"] },
      { name: "narrative-relations", keyPath: ["projectId", "id"] },
      { name: "narrative-events", keyPath: ["projectId", "id"] },
      { name: "narrative-ideas", keyPath: ["projectId", "id"] },
      { name: "personal-idea-library", keyPath: ["writerId", "sourceProjectId", "idea.id"] },
      { name: "writer-library-finalization-receipts", keyPath: ["writerId", "sourceProjectId", "receiptId"] },
      { name: "narrative-assertions", keyPath: ["projectId", "id"] },
      { name: "document-diagnostics", keyPath: ["projectId", "documentId"] },
      { name: "manuscript-fragments", keyPath: ["projectId", "id"] },
      { name: "record-attributes", keyPath: ["projectId", "id"] },
      { name: "relation-attributes", keyPath: ["projectId", "id"] },
      { name: "active-suggestions", keyPath: ["projectId", "id"] },
      { name: "import-authorizations", keyPath: ["writerId", "sourceProjectId", "targetProjectId", "authorizationId"] },
      { name: "schema-migrations", keyPath: "migrationId" },
      { name: "project-records", keyPath: ["projectId", "id"] },
      { name: "record-names", keyPath: ["projectId", "id"] },
      { name: "project-relations", keyPath: ["projectId", "id"] },
      { name: "project-evidences", keyPath: ["projectId", "id"] },
      { name: "timeline-occurrences", keyPath: ["projectId", "id"] },
      { name: "project-dictionaries", keyPath: ["projectId", "id"] },
      { name: "dictionary-entries", keyPath: ["projectId", "id"] },
      { name: "dictionary-entry-entities", keyPath: ["projectId", "entryId", "recordId"] }
    ]);
    assert.deepEqual(createdIndexes.map(index => [index.store, index.name]), [
      ["project-settings", "by-project"],
      ["language-profiles", "by-project"],
      ["language-profiles", "by-project-language"],
      ["language-profiles", "by-project-active"],
      ["language-resource-refs", "by-project"],
      ["language-resource-refs", "by-profile"],
      ["language-resource-refs", "by-resource-database"],
      ["style-profiles", "by-project"],
      ["style-profiles", "by-project-name"],
      ["timeline-tracks", "by-project"],
      ["timeline-tracks", "by-project-name"],
      ["record-lifecycles", "by-project"],
      ["record-lifecycles", "by-subject"],
      ["record-lifecycles", "by-subject-revision"],
      ["relation-lifecycles", "by-project"],
      ["relation-lifecycles", "by-subject"],
      ["relation-lifecycles", "by-subject-revision"],
      ["event-lifecycles", "by-project"],
      ["event-lifecycles", "by-subject"],
      ["event-lifecycles", "by-subject-revision"],
      ["documents", "by-project"],
      ["changes", "by-document-sequence"],
      ["narrative-entities", "by-project"],
      ["narrative-relations", "by-project"],
      ["narrative-events", "by-project"],
      ["narrative-ideas", "by-project"],
      ["personal-idea-library", "by-writer"],
      ["personal-idea-library", "by-writer-source"],
      ["personal-idea-library", "by-source-project"],
      ["writer-library-finalization-receipts", "by-writer"],
      ["writer-library-finalization-receipts", "by-writer-source"],
      ["narrative-assertions", "by-project"],
      ["narrative-assertions", "by-entity"],
      ["document-diagnostics", "by-project"],
      ["manuscript-fragments", "by-project"],
      ["manuscript-fragments", "by-document-revision"],
      ["manuscript-fragments", "by-parent"],
      ["record-attributes", "by-project"],
      ["record-attributes", "by-record-key"],
      ["relation-attributes", "by-project"],
      ["relation-attributes", "by-relation-key"],
      ["active-suggestions", "by-project"],
      ["active-suggestions", "by-document-revision"],
      ["active-suggestions", "by-status-priority"],
      ["import-authorizations", "by-writer"],
      ["import-authorizations", "by-source-target"],
      ["import-authorizations", "by-target"],
      ["schema-migrations", "by-to-version"],
      ["schema-migrations", "by-applied-at"],
      ["project-records", "by-project"],
      ["project-records", "by-project-type"],
      ["project-records", "by-project-name"],
      ["project-records", "by-project-label-state"],
      ["project-records", "by-project-updated"],
      ["record-names", "by-project"],
      ["record-names", "by-record"],
      ["record-names", "by-name"],
      ["project-relations", "by-project"],
      ["project-relations", "by-source"],
      ["project-relations", "by-target"],
      ["project-relations", "by-type"],
      ["project-evidences", "by-project"],
      ["project-evidences", "by-subject-record"],
      ["project-evidences", "by-subject-relation"],
      ["project-evidences", "by-document"],
      ["project-evidences", "by-fragment"],
      ["timeline-occurrences", "by-project"],
      ["timeline-occurrences", "by-event-record"],
      ["timeline-occurrences", "by-track-order"],
      ["project-dictionaries", "by-project"],
      ["project-dictionaries", "by-project-language-name"],
      ["dictionary-entries", "by-project"],
      ["dictionary-entries", "by-dictionary"],
      ["dictionary-entries", "by-dictionary-normalized"],
      ["dictionary-entry-entities", "by-project"],
      ["dictionary-entry-entities", "by-entry"],
      ["dictionary-entry-entities", "by-record"]
    ]);
    assert.equal(createdIndexes.find(index => index.name === "by-document-sequence")?.unique, true);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB aborta una migración que se reanuda después de haber sido bloqueada", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let schemaWrites = 0;
  let abortCalls = 0;
  const database = {
    objectStoreNames: { contains: () => false },
    createObjectStore() {
      schemaWrites++;
      return { createIndex() { schemaWrites++; } };
    },
    onversionchange: null,
    close() {}
  };
  const upgradeTransaction = {
    abort() { abortCalls++; },
    objectStore() { throw new Error("No debe accederse al esquema tras el bloqueo."); }
  };
  let request;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        request = { result: database, transaction: upgradeTransaction };
        queueMicrotask(() => request.onblocked?.());
        return request;
      }
    }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.loadEntities("blocked-migration"),
      /apertura de la base local está bloqueada/
    );

    // IndexedDB puede disparar onupgradeneeded más tarde, cuando se libera
    // la conexión que impedía la migración.
    request.onupgradeneeded?.();

    assert.equal(abortCalls, 1, "la transacción de migración debe abortarse");
    assert.equal(schemaWrites, 0, "el esquema no debe modificarse después del bloqueo");
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB repara índices ausentes en object stores de una base anterior", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const createdIndexes = [];
  const names = [
    "language-profiles", "language-resource-refs", "style-profiles", "timeline-tracks",
    "record-lifecycles", "relation-lifecycles", "project-settings", "documents", "changes",
    "narrative-entities", "narrative-relations",
    "narrative-events", "narrative-ideas", "personal-idea-library",
    "writer-library-finalization-receipts", "narrative-assertions", "document-diagnostics",
    "project-dictionaries", "dictionary-entries", "manuscript-fragments",
    "record-attributes", "relation-attributes", "active-suggestions",
    "import-authorizations", "schema-migrations", "project-records", "record-names",
    "project-relations", "project-evidences", "timeline-occurrences", "dictionary-entry-entities"
  ];
  const stores = new Map(names.map(name => [name, {
    indexNames: { contains: () => false },
    createIndex(indexName, keyPath, options) { createdIndexes.push([name, indexName, keyPath, options]); },
    index() {
      return { getAll() {
        const request = {};
        queueMicrotask(() => {
          request.result = [];
          request.onsuccess?.();
          queueMicrotask(() => transaction.oncomplete?.());
        });
        return request;
      } };
    }
  }]));
  let transaction;
  const database = {
    objectStoreNames: { contains: name => stores.has(name) },
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore(name) { return stores.get(name); }
      };
      return transaction;
    }
  };
  const upgradeTransaction = {
    objectStore(name) { return stores.get(name); }
  };
  let openedVersion;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open(_name, version) {
      openedVersion = version;
      const request = { result: database, transaction: upgradeTransaction };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    assert.deepEqual(await store.loadEntities("migration-test"), []);
    assert.equal(openedVersion, 21);
    const expected = [
      ["project-settings", "by-project"],
      ["language-profiles", "by-project"],
      ["language-profiles", "by-project-language"],
      ["language-profiles", "by-project-active"],
      ["language-resource-refs", "by-project"],
      ["language-resource-refs", "by-profile"],
      ["language-resource-refs", "by-resource-database"],
      ["style-profiles", "by-project"],
      ["style-profiles", "by-project-name"],
      ["timeline-tracks", "by-project"],
      ["timeline-tracks", "by-project-name"],
      ["record-lifecycles", "by-project"],
      ["record-lifecycles", "by-subject"],
      ["record-lifecycles", "by-subject-revision"],
      ["relation-lifecycles", "by-project"],
      ["relation-lifecycles", "by-subject"],
      ["relation-lifecycles", "by-subject-revision"],
      ["documents", "by-project"],
      ["changes", "by-document-sequence"],
      ["narrative-entities", "by-project"],
      ["narrative-relations", "by-project"],
      ["narrative-events", "by-project"],
      ["narrative-ideas", "by-project"],
      ["personal-idea-library", "by-writer"],
      ["personal-idea-library", "by-writer-source"],
      ["personal-idea-library", "by-source-project"],
      ["writer-library-finalization-receipts", "by-writer"],
      ["writer-library-finalization-receipts", "by-writer-source"],
      ["narrative-assertions", "by-project"],
      ["narrative-assertions", "by-entity"],
      ["document-diagnostics", "by-project"],
      ["project-dictionaries", "by-project"],
      ["project-dictionaries", "by-project-language-name"],
      ["dictionary-entries", "by-project"],
      ["dictionary-entries", "by-dictionary"],
      ["dictionary-entries", "by-dictionary-normalized"],
      ["dictionary-entry-entities", "by-project"],
      ["dictionary-entry-entities", "by-entry"],
      ["dictionary-entry-entities", "by-record"],
      ["manuscript-fragments", "by-project"],
      ["manuscript-fragments", "by-document-revision"],
      ["manuscript-fragments", "by-parent"],
      ["record-attributes", "by-project"],
      ["record-attributes", "by-record-key"],
      ["relation-attributes", "by-project"],
      ["relation-attributes", "by-relation-key"],
      ["active-suggestions", "by-project"],
      ["active-suggestions", "by-document-revision"],
      ["active-suggestions", "by-status-priority"],
      ["import-authorizations", "by-writer"],
      ["import-authorizations", "by-source-target"],
      ["import-authorizations", "by-target"],
      ["schema-migrations", "by-to-version"],
      ["schema-migrations", "by-applied-at"],
      ["project-records", "by-project"],
      ["project-records", "by-project-type"],
      ["project-records", "by-project-name"],
      ["project-records", "by-project-label-state"],
      ["project-records", "by-project-updated"],
      ["record-names", "by-project"],
      ["record-names", "by-record"],
      ["record-names", "by-name"],
      ["project-relations", "by-project"],
      ["project-relations", "by-source"],
      ["project-relations", "by-target"],
      ["project-relations", "by-type"],
      ["project-evidences", "by-project"],
      ["project-evidences", "by-subject-record"],
      ["project-evidences", "by-subject-relation"],
      ["project-evidences", "by-document"],
      ["project-evidences", "by-fragment"],
      ["timeline-occurrences", "by-project"],
      ["timeline-occurrences", "by-event-record"],
      ["timeline-occurrences", "by-track-order"]
    ];
    assert.deepEqual(createdIndexes.map(([storeName, indexName]) => [storeName, indexName]), expected);
    assert.equal(
      createdIndexes.find(([, indexName]) => indexName === "by-document-sequence")?.[3]?.unique,
      true,
      "la migración debe conservar la unicidad del índice del journal"
    );
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB reemplaza índices existentes con definición incompatible", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const names = [
    "language-profiles", "language-resource-refs", "style-profiles", "timeline-tracks",
    "record-lifecycles", "relation-lifecycles", "project-settings", "documents", "changes",
    "narrative-entities", "narrative-relations",
    "narrative-events", "narrative-ideas", "personal-idea-library",
    "writer-library-finalization-receipts", "narrative-assertions", "document-diagnostics",
    "project-dictionaries", "dictionary-entries", "manuscript-fragments",
    "record-attributes", "relation-attributes", "active-suggestions",
    "import-authorizations", "schema-migrations", "project-records", "record-names",
    "project-relations", "project-evidences", "timeline-occurrences", "dictionary-entry-entities"
  ];
  const deleted = [];
  const created = [];
  const stores = new Map(names.map(name => {
    const indexes = new Set(name === "changes" ? ["by-document-sequence"] : []);
    return [name, {
      indexNames: { contains: indexName => indexes.has(indexName) },
      index(indexName) {
        if (name === "changes" && indexName === "by-document-sequence") {
          return { keyPath: ["projectId", "documentId", "sequence"], unique: false };
        }
        return { getAll() {
          const request = {};
          queueMicrotask(() => {
            request.result = [];
            request.onsuccess?.();
            queueMicrotask(() => transaction.oncomplete?.());
          });
          return request;
        } };
      },
      deleteIndex(indexName) {
        deleted.push([name, indexName]);
        indexes.delete(indexName);
      },
      createIndex(indexName, keyPath, options) {
        created.push([name, indexName, keyPath, options]);
        indexes.add(indexName);
      }
    }];
  }));
  let transaction;
  const database = {
    objectStoreNames: { contains: name => stores.has(name) },
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore(name) { return stores.get(name); }
      };
      return transaction;
    }
  };
  const upgradeTransaction = { objectStore(name) { return stores.get(name); } };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database, transaction: upgradeTransaction };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    assert.deepEqual(await store.loadEntities("migration-index-mismatch"), []);
    assert.deepEqual(deleted, [["changes", "by-document-sequence"]]);
    const repaired = created.find(([, indexName]) => indexName === "by-document-sequence");
    assert.deepEqual(repaired?.[2], ["projectId", "documentId", "sequence"]);
    assert.equal(repaired?.[3]?.unique, true);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB protege la biblioteca personal contra registros de otro escritor", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const entries = [{
    writerId: "writer-b", sourceProjectId: "private-book",
    sourceProjectName: "Libro privado", category: "Libro privado",
    idea: { projectId: "private-book", id: "idea-1", status: "IDEA" },
    archivedAt: 10
  }];
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore() {
          return { index() {
            return { getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = structuredClone(entries);
                request.onsuccess?.();
              });
              return request;
            } };
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    const pending = store.loadPersonalIdeas("writer-a");
    await new Promise(resolve => setTimeout(resolve, 0));
    transaction.oncomplete?.();
    await assert.rejects(pending, /Biblioteca personal inconsistente/);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB no compacta el journal si el snapshot durable tiene metadatos inválidos", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = {
        error: null,
        abort() { queueMicrotask(() => transaction.onabort?.()); },
        objectStore(name) {
          if (name === "documents") return { get() {
            const request = {};
            queueMicrotask(() => {
              request.result = {
                projectId: "compact-validation", documentId: "chapter",
                text: "texto", revision: 4, sequence: 4, updatedAt: Number.NaN
              };
              request.onsuccess?.();
            });
            return request;
          } };
          return { index() {
            return { openCursor() {
              throw new Error("No debe abrirse el journal con un snapshot inválido.");
            } };
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.compactChanges("compact-validation", "chapter", 4),
      /Compactación rechazada/
    );
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB rechaza snapshots persistidos malformados sin entregarlos al anfitrión", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const malformed = {
    projectId: "another-project", documentId: "chapter", text: "texto",
    revision: 1, sequence: 1, updatedAt: 1
  };
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = {
        error: null,
        abort() { queueMicrotask(() => transaction.onabort?.()); },
        objectStore() {
          return { get() {
            const request = {};
            queueMicrotask(() => {
              request.result = structuredClone(malformed);
              request.onsuccess?.();
            });
            return request;
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.loadDocument("expected-project", "chapter"),
      /Snapshot almacenado malformado/
    );
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB rechaza registros y límites de journal malformados antes de abrir la base", async () => {
  const store = new IndexedDbProjectStore();
  const validDocument = {
    projectId: "journal-validation",
    documentId: "chapter",
    text: "base",
    revision: 2,
    sequence: 2,
    updatedAt: 1
  };
  const validChange = {
    projectId: "journal-validation",
    documentId: "chapter",
    sequence: 3,
    baseRevision: 2,
    committedRevision: 3,
    start: 0,
    end: 0,
    replacement: "x",
    committedAt: 3
  };

  await assert.rejects(
    store.saveDocumentAndCompactChanges(validDocument, 3),
    /debe coincidir exactamente/
  );
  await assert.rejects(
    store.saveDocumentAndCompactChanges({ ...validDocument, projectId: " " }, 2),
    /Snapshot de documento inválido/
  );
  await assert.rejects(
    store.appendChange({ ...validChange, committedRevision: 4 }),
    /Registro de journal inválido/
  );
  await assert.rejects(
    store.appendChange({ ...validChange, sequence: 0 }),
    /Registro de journal inválido/
  );
  await assert.rejects(
    store.loadChanges("journal-validation", "chapter", -1),
    /Parámetros inválidos/
  );
  await assert.rejects(
    store.compactChanges("journal-validation", "chapter", Number.MAX_SAFE_INTEGER + 1),
    /Parámetros inválidos/
  );
  await assert.rejects(
    store.saveEntity({ projectId: " ", id: "entity" }),
    /Registro de entidad narrativa inválido/
  );
  await assert.rejects(
    store.saveRelation({ projectId: "journal-validation", id: " " }),
    /Registro de relación narrativa inválido/
  );
  await assert.rejects(
    store.saveEvent({ projectId: "journal-validation", id: "" }),
    /Registro de acontecimiento inválido/
  );
  await assert.rejects(
    store.saveIdea({ projectId: "journal-validation", id: " " }),
    /Registro de idea narrativa inválido/
  );
  await assert.rejects(
    store.saveAssertion({ projectId: " ", id: "assertion" }),
    /Registro de afirmación narrativa inválido/
  );
  const validEntity = {
    projectId: "journal-validation", id: "ana", kind: "character",
    canonicalName: "Ana", normalizedName: "ana", aliases: [],
    evidence: [{ documentId: "chapter-5", revision: 4, start: 3, end: 6, excerpt: "Ana" }],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  };
  await assert.rejects(
    store.saveEntity({ ...validEntity, normalizedName: "otra" }),
    /ficha de entidad inválida/
  );
  await assert.rejects(
    store.saveEntity({ ...validEntity, evidence: [{ documentId: "chapter", revision: -1, start: 0, end: 1, excerpt: "A" }] }),
    /evidencia inválida/
  );
  const validRelation = {
    projectId: "journal-validation", id: "relation", fromEntityId: "ana",
    toEntityId: "luis", relationType: "ally", evidence: []
  };
  await assert.rejects(
    store.saveRelation({ ...validRelation, relationType: " " }),
    /extremos o tipo de relación inválidos/
  );
  await assert.rejects(
    store.saveRelation({ ...validRelation, evidence: [{ documentId: "", revision: 0, start: 0, end: 0, excerpt: "" }] }),
    /evidencia inválida/
  );
  const validEvent = {
    projectId: "journal-validation", id: "event", label: "Regreso",
    participants: ["ana"], evidence: []
  };
  await assert.rejects(
    store.saveEvent({ ...validEvent, participants: [" "] }),
    /etiqueta o participantes inválidos/
  );
  await assert.rejects(
    store.saveEvent({ ...validEvent, participants: ["ana", "ana"] }),
    /etiqueta o participantes inválidos/
  );
  await assert.rejects(
    store.saveEvent({ ...validEvent, timeReference: { basis: "story-day", precision: "date", raw: "día 2", orderValue: 2 } }),
    /referencia temporal inválida/
  );
  const validAssertion = {
    projectId: "journal-validation", id: "assertion-valid", entityId: "ana",
    entityName: "Ana", attribute: "age", value: 31,
    evidence: { documentId: "chapter", revision: 1, start: 0, end: 3, excerpt: "Ana" },
    capturedAt: 10
  };
  await assert.rejects(
    store.saveAssertion({ ...validAssertion, capturedAt: Number.NaN }),
    /atributos obligatorios inválidos/
  );
  await assert.rejects(
    store.saveAssertion({ ...validAssertion, value: -1 }),
    /atributos obligatorios inválidos/
  );
  await assert.rejects(
    store.saveAssertion({ ...validAssertion, attribute: "location", value: 12 }),
    /atributos obligatorios inválidos/
  );
  await assert.rejects(
    store.saveAssertion({
      ...validAssertion,
      timeReference: { basis: "story-day", precision: "date", raw: "día 3", orderValue: 3 }
    }),
    /referencia temporal inválida/
  );
  await assert.rejects(
    store.saveAssertion({
      ...validAssertion,
      evidence: { ...validAssertion.evidence, end: -1 }
    }),
    /evidencia inválida/
  );
});

test("una resincronización nueva conserva deltas posteriores al snapshot del anfitrión", async () => {
  class ConcurrentJournalStore extends MemoryStore {
    changes = [
      {
        projectId: "host-resync-race", documentId: "chapter",
        sequence: 6, baseRevision: 5, committedRevision: 6,
        start: 0, end: 0, replacement: "incluido", committedAt: 6
      },
      {
        projectId: "host-resync-race", documentId: "chapter",
        sequence: 7, baseRevision: 6, committedRevision: 7,
        start: 0, end: 0, replacement: "posterior", committedAt: 7
      }
    ];
    checkpointLimits = [];
    async saveDocumentAndCompactChanges(document, throughSequence) {
      this.checkpointLimits.push(throughSequence);
      await super.saveDocument(document);
      this.changes = this.changes.filter(item =>
        item.projectId !== document.projectId ||
        item.documentId !== document.documentId ||
        item.sequence > throughSequence
      );
    }
    async loadChanges(projectId, documentId, afterSequence) {
      return this.changes.filter(item =>
        item.projectId === projectId && item.documentId === documentId &&
        item.sequence > afterSequence
      );
    }
  }

  const store = new ConcurrentJournalStore();
  await store.saveDocument({
    projectId: "host-resync-race", documentId: "chapter",
    text: "base", revision: 5, sequence: 5, updatedAt: 1
  });
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "host-resync-race", projectName: "Resincronización concurrente" });
  await api.openDocument({
    documentId: "chapter", text: "estado autoritativo",
    revision: 6, sequence: 6
  });

  assert.deepEqual(store.checkpointLimits, [6]);
  assert.equal(store.changes.length, 1);
  assert.equal(store.changes[0].sequence, 7);
  assert.equal(api.getSnapshot("chapter")?.text, "estado autoritativo");
});

test("rechaza snapshots atrasados que podrían revertir ediciones ya persistidas", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "stale-host-snapshot", projectName: "Snapshot atrasado" });
  const original = { documentId: "chapter", text: "A", revision: 4, sequence: 10 };
  await api.openDocument(original);

  const admission = api.onEditorChange({
    documentId: "chapter", sequence: 11, baseRevision: 4,
    start: 1, end: 1, replacement: "B"
  });
  assert.equal(admission.status, "queued");
  await api.flushPendingChanges();
  assert.equal(api.getSnapshot("chapter")?.text, "AB");

  await assert.rejects(
    api.openDocument(original),
    /Snapshot del anfitrión obsoleto o inconsistente/
  );
  assert.equal(api.getSnapshot("chapter")?.text, "AB");
  assert.equal(store.documents.get("stale-host-snapshot:chapter")?.text, "AB");
});

test("PieceTable localiza saltos de línea reales entre piezas", () => {
  const buffer = new PieceTable("uno\ndos\ntres");
  assert.equal(buffer.lastIndexOfNewline(6), 3);
  assert.equal(buffer.indexOfNewline(0), 3);
  buffer.replace(4, 7, "SEGUNDO\nintermedio");
  assert.equal(buffer.toString(), "uno\nSEGUNDO\nintermedio\ntres");
  assert.equal(buffer.lastIndexOfNewline(15), 11);
  assert.equal(buffer.indexOfNewline(4), 11);
  assert.equal(buffer.slice(4, 10), "SEGUND");
});


test("extrae personajes, lugares y objetos con evidencia y offsets UTF-16", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "novel-a", projectName: "La novela" });
  const text = "El personaje Álvaro llegó a la ciudad de Brumaria. La espada llamada Lúmina brilló.";
  const extracted = await api.extractNarrativeKnowledge("chapter-1", 7, text);
  assert.deepEqual(extracted.map(entity => entity.kind).sort(), ["character", "object", "place"]);
  const alvaro = extracted.find(entity => entity.canonicalName === "Álvaro");
  assert.equal(text.slice(alvaro.evidence[0].start, alvaro.evidence[0].end), "Álvaro");
  assert.equal(alvaro.evidence[0].revision, 7);
  assert.equal(alvaro.evidence[0].excerpt, text);
  assert.equal((await api.getNarrativeEntities()).length, 3);
});


test("la API rechaza offsets absolutos desbordados antes de encolar la extracción", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "offset-host-validation", projectName: "Offsets" });
  await assert.rejects(
    api.extractNarrativeKnowledge("chapter", 1, "texto", Number.MAX_SAFE_INTEGER - 2),
    /Fragmento narrativo inválido/
  );
  assert.equal((await api.getNarrativeEntities()).length, 0);
});


test("fusiona evidencias sin duplicar y mantiene aislamiento estricto entre proyectos", async () => {
  const store = new MemoryStore();
  const first = new HostEngineApi({ store });
  first.initializeProject({ projectId: "private-book-a", projectName: "Libro A" });
  await first.extractNarrativeKnowledge("chapter-1", 1, "El personaje Elena llegó.");
  await first.extractNarrativeKnowledge("chapter-2", 2, "El personaje Elena regresó.");
  const entity = (await first.getNarrativeEntities())[0];
  assert.equal(entity.evidence.length, 2);

  const second = new HostEngineApi({ store });
  second.initializeProject({ projectId: "private-book-b", projectName: "Libro B" });
  assert.equal((await second.getNarrativeEntities()).length, 0);
  await second.extractNarrativeKnowledge("chapter-1", 1, "El personaje Elena apareció.");
  assert.equal((await second.getNarrativeEntities()).length, 1);
  assert.equal((await first.getNarrativeEntities())[0].evidence.length, 2);
});


test("no inventa entidades cuando no existen indicadores narrativos explícitos", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "novel-empty", projectName: "Texto libre" });
  const result = await api.extractNarrativeKnowledge(
    "chapter", 0, "María caminó por el valle y observó las estrellas junto a la espada de Aragorn."
  );
  assert.equal(result.length, 0);
});


test("agrupa menciones repetidas dentro del mismo fragmento conservando cada evidencia", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "novel-repeated", projectName: "Menciones" });
  const result = await api.extractNarrativeKnowledge(
    "chapter", 3,
    "El personaje Irene entró.\nMás tarde, el personaje Irene regresó."
  );
  const irene = result.find(entity => entity.canonicalName === "Irene");
  assert.equal(irene?.evidence.length, 2);
  assert.deepEqual(irene?.evidence.map(item => item.excerpt), [
    "El personaje Irene entró.",
    "Más tarde, el personaje Irene regresó."
  ]);
});


test("no pierde evidencias cuando llegan extracciones simultáneas", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "novel-concurrent", projectName: "Concurrencia" });
  await Promise.all([
    api.extractNarrativeKnowledge("chapter-1", 1, "El personaje Mara llegó."),
    api.extractNarrativeKnowledge("chapter-2", 2, "El personaje Mara regresó."),
    api.extractNarrativeKnowledge("chapter-3", 3, "El personaje Mara venció.")
  ]);
  const mara = (await api.getNarrativeEntities()).find(entity => entity.canonicalName === "Mara");
  assert.equal(mara?.evidence.length, 3);
});


test("reconoce relaciones explícitas entre personajes y conserva la frase como evidencia", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "novel-relations", projectName: "Relaciones" });
  const text = "El personaje Ana y el personaje Luis viajaron juntos. Ana es hermana de Luis y regresó a casa. Ana ayudó a Luis y volvió.";
  await api.extractNarrativeKnowledge("chapter-1", 4, text);
  const relations = await api.getNarrativeRelations();
  assert.equal(relations.length, 2);
  const family = relations.find(item => item.relationType === "hermana");
  const action = relations.find(item => item.relationType === "ayudó");
  assert.ok(family);
  assert.ok(action);
  assert.equal(family.evidence[0].excerpt, text);
  assert.equal(text.slice(action.evidence[0].start, action.evidence[0].end), "Ana ayudó a Luis");
  assert.equal(family.projectId, "novel-relations");
});


test("no crea relaciones si alguno de los personajes no está identificado", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "novel-unresolved-relation", projectName: "Relación incompleta" });
  await api.extractNarrativeKnowledge(
    "chapter-1", 1,
    "El personaje Ana encontró a Luis. Ana ayudó a Luis."
  );
  assert.equal((await api.getNarrativeRelations()).length, 0);
});


test("las relaciones narrativas permanecen aisladas por proyecto", async () => {
  const store = new MemoryStore();
  const first = new HostEngineApi({ store });
  first.initializeProject({ projectId: "relation-book-a", projectName: "A" });
  await first.extractNarrativeKnowledge(
    "chapter", 1, "El personaje Ana y el personaje Luis. Ana es hermana de Luis."
  );
  assert.equal((await first.getNarrativeRelations()).length, 1);

  const second = new HostEngineApi({ store });
  second.initializeProject({ projectId: "relation-book-b", projectName: "B" });
  assert.equal((await second.getNarrativeRelations()).length, 0);
});


test("captura acontecimientos explícitos con participantes y evidencia", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "novel-events", projectName: "Acontecimientos" });
  const text = "El personaje Ana llegó al reino de Eldoria.\nACONTECIMIENTO: Ana descubre la puerta secreta.";
  await api.extractNarrativeKnowledge("chapter-1", 2, text);
  const events = await api.getNarrativeEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].label, "Ana descubre la puerta secreta.");
  assert.equal(events[0].participants.length, 1);
  assert.equal(events[0].evidence[0].excerpt, "ACONTECIMIENTO: Ana descubre la puerta secreta.");
});


test("versiona cambios explícitos de etiqueta y participantes de acontecimientos", async () => {
  const store=new MemoryStore();
  const api=new HostEngineApi({store});
  api.initializeProject({projectId:"event-lifecycle",projectName:"Historial de acontecimientos"});
  await store.saveEntity({
    projectId:"event-lifecycle",id:"ana",kind:"character",
    canonicalName:"Ana",normalizedName:"ana",aliases:[],evidence:[],
    firstSeenAt:1,lastSeenAt:1,extractionVersion:1
  });
  await store.saveEntity({
    projectId:"event-lifecycle",id:"bruno",kind:"character",
    canonicalName:"Bruno",normalizedName:"bruno",aliases:[],evidence:[],
    firstSeenAt:1,lastSeenAt:1,extractionVersion:1
  });
  await store.saveEvent({
    projectId:"event-lifecycle",id:"alarm",label:"Suena la alarma",
    participants:["ana"],evidence:[]
  });

  const first=await api.updateNarrativeEvent({
    eventId:"alarm",label:"La alarma se activa",
    participants:["bruno","ana","bruno"],
    changedBy:"writer-1",changeReason:"Se precisa el alcance del acontecimiento",changedAt:100
  });
  assert.equal(first.label,"La alarma se activa");
  assert.deepEqual(first.participants,["ana","bruno"]);

  const second=await api.updateNarrativeEvent({
    eventId:"alarm",participants:["bruno"],
    changedBy:"writer-1",changeReason:"Se retira la asociación anterior",changedAt:120
  });
  assert.deepEqual(second.participants,["bruno"]);

  const unchanged=await api.updateNarrativeEvent({
    eventId:"alarm",label:"La alarma se activa",participants:["bruno"],
    changedBy:"writer-1",changedAt:130
  });
  assert.deepEqual(unchanged.participants,["bruno"]);
  assert.equal((await api.getEventLifecycleHistory("alarm")).length,2);

  const history=await api.getEventLifecycleHistory("alarm");
  assert.equal(history.length,2);
  assert.deepEqual(history.map(item=>item.revision),[1,2]);
  assert.deepEqual(history.map(item=>item.previousLabel),["Suena la alarma","La alarma se activa"]);
  assert.deepEqual(history.map(item=>item.newLabel),["La alarma se activa","La alarma se activa"]);
  assert.deepEqual(history.map(item=>item.previousParticipants),[["ana"],["ana","bruno"]]);
  assert.deepEqual(history.map(item=>item.newParticipants),[["ana","bruno"],["bruno"]]);
  assert.deepEqual(history.map(item=>item.changedAt),[100,120]);

  history[0].newParticipants.push("mutated-copy");
  const reread=await api.getEventLifecycleHistory("alarm");
  assert.deepEqual(reread[0].newParticipants,["ana","bruno"]);
});

test("rechaza actualizar acontecimientos con participantes que no existen en el proyecto", async () => {
  const store=new MemoryStore();
  const api=new HostEngineApi({store});
  api.initializeProject({projectId:"event-lifecycle-integrity",projectName:"Integridad"});
  await store.saveEvent({
    projectId:"event-lifecycle-integrity",id:"arrival",label:"La llegada",
    participants:[],evidence:[]
  });
  await assert.rejects(
    api.updateNarrativeEvent({
      eventId:"arrival",participants:["missing-character"],
      changedBy:"writer-1"
    }),
    /referencia.*inexistente|no existen|no existente/i
  );
  assert.deepEqual(store.events.get("event-lifecycle-integrity:arrival").participants,[]);
  assert.equal((await store.loadEventLifecycles("event-lifecycle-integrity","arrival")).length,0);
});

test("una instancia obsoleta no puede sobrescribir un cambio versionado de acontecimiento", async () => {
  const store=new MemoryStore();
  const initial={
    projectId:"event-lifecycle-race",id:"gate",label:"Se abre la puerta",
    participants:[],evidence:[]
  };
  await store.saveEvent(initial);
  const first=new HostEngineApi({store});
  const second=new HostEngineApi({store});
  first.initializeProject({projectId:"event-lifecycle-race",projectName:"Concurrencia"});
  second.initializeProject({projectId:"event-lifecycle-race",projectName:"Concurrencia"});
  await first.getNarrativeEvents();
  await second.updateNarrativeEvent({
    eventId:"gate",label:"La puerta queda abierta",
    changedBy:"writer-2",changedAt:200
  });
  await assert.rejects(
    first.updateNarrativeEvent({
      eventId:"gate",label:"La puerta se cierra",
      changedBy:"writer-1",changedAt:210
    }),
    /cambió en otra instancia|event_changed_concurrently/
  );
  const persisted=store.events.get("event-lifecycle-race:gate");
  assert.equal(persisted.label,"La puerta queda abierta");
  const history=await store.loadEventLifecycles("event-lifecycle-race","gate");
  assert.equal(history.length,1);
  assert.equal(history[0].newLabel,"La puerta queda abierta");
});

test("el análisis literario expone evolución versionada de acontecimientos separada de las menciones", async () => {
  const store=new MemoryStore();
  const api=new HostEngineApi({store});
  api.initializeProject({projectId:"event-lifecycle-analysis",projectName:"Evolución"});
  await store.saveEntity({
    projectId:"event-lifecycle-analysis",id:"ana",kind:"character",
    canonicalName:"Ana",normalizedName:"ana",aliases:[],evidence:[],
    firstSeenAt:1,lastSeenAt:1,extractionVersion:1
  });
  await store.saveEntity({
    projectId:"event-lifecycle-analysis",id:"bruno",kind:"character",
    canonicalName:"Bruno",normalizedName:"bruno",aliases:[],evidence:[],
    firstSeenAt:1,lastSeenAt:1,extractionVersion:1
  });
  const text="ESCENA 1\nLa alarma se activa. Ana escuchó el sonido.";
  const excerpt="La alarma se activa.";
  const start=text.indexOf(excerpt);
  await store.saveEvent({
    projectId:"event-lifecycle-analysis",id:"alarm",label:"Suena la alarma",
    participants:["ana"],evidence:[{
      documentId:"chapter",revision:3,start,end:start+excerpt.length,excerpt
    }]
  });
  await api.openDocument({documentId:"chapter",text,revision:3,sequence:0});
  await api.updateNarrativeEvent({
    eventId:"alarm",label:"Se activa la alarma",
    participants:["bruno"],changedBy:"writer-1",changedAt:321
  });

  const result=await api.analyzeLiteraryDocument("chapter");
  assert.deepEqual(result.eventLifecycleAnalysis,{
    eventCount:1,
    totalTransitionCount:1,
    omittedEventCount:0,
    profiles:[
      {
        eventId:"alarm",
        currentLabel:"Se activa la alarma",
        currentParticipantIds:["bruno"],
        latestRecordedLabel:"Se activa la alarma",
        latestRecordedParticipantIds:["bruno"],
        currentStateMatchesLatestRevision:true,
        latestRevision:1,
        transitionCount:1,
        labelChangeCount:1,
        participantSetChangeCount:1,
        changes:[
          {
            revision:1,
            previousLabel:"Suena la alarma",
            newLabel:"Se activa la alarma",
            labelChanged:true,
            addedParticipantIds:["bruno"],
            removedParticipantIds:["ana"],
            participantSetChanged:true,
            changedBy:"writer-1",
            changeReason:null,
            changedAt:321
          }
        ],
        changesTruncated:false
      }
    ]
  });
  assert.equal(result.explicitScenes[0].eventLinks[0].participants[0].entityId,"bruno");
  assert.equal(result.explicitScenes[0].eventLinks[0].participants[0].mentionedByName,false);
});

test("señala divergencia entre la ficha vigente y la última transición registrada", async () => {
  const store=new MemoryStore();
  const projectId="event-lifecycle-divergence";
  const text="ESCENA 1\nLa puerta se abre.";
  const excerpt="La puerta se abre.";
  const start=text.indexOf(excerpt);
  await store.saveEvent({
    projectId,id:"gate",label:"Se abre la puerta",participants:[],
    evidence:[{
      documentId:"chapter",revision:5,start,end:start+excerpt.length,excerpt
    }]
  });
  const first=new HostEngineApi({store});
  first.initializeProject({projectId,projectName:"Divergencia"});
  await first.openDocument({documentId:"chapter",text,revision:5,sequence:0});
  await first.updateNarrativeEvent({
    eventId:"gate",label:"La puerta queda abierta",
    changedBy:"writer-1",changedAt:100
  });

  await store.saveEvent({
    ...store.events.get(projectId+":gate"),
    label:"La puerta se cierra después"
  });
  const reopened=new HostEngineApi({store});
  reopened.initializeProject({projectId,projectName:"Divergencia"});
  await reopened.openDocument({documentId:"chapter",text,revision:5,sequence:0});
  const result=await reopened.analyzeLiteraryDocument("chapter");

  const profile=result.eventLifecycleAnalysis.profiles[0];
  assert.equal(profile.currentLabel,"La puerta se cierra después");
  assert.equal(profile.latestRecordedLabel,"La puerta queda abierta");
  assert.equal(profile.currentStateMatchesLatestRevision,false);
  assert.deepEqual(profile.latestRecordedParticipantIds,[]);
  assert.deepEqual(profile.currentParticipantIds,[]);
});

test("captura ideas marcadas por el escritor y permite cambiar su estado", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "novel-ideas", projectName: "Ideas" });
  const text = "Capítulo inicial.\nIDEA: El mapa podría revelar un segundo continente.";
  await api.extractNarrativeKnowledge("chapter-1", 5, text);
  const ideas = await api.getNarrativeIdeas();
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0].status, "IDEA");
  assert.equal(ideas[0].originDocumentId, "chapter-1");
  assert.equal(ideas[0].sourceProjectName, "Ideas");
  const incorporated = await api.setNarrativeIdeaStatus(ideas[0].id, "incorporated");
  assert.equal(incorporated.status, "incorporated");
  assert.deepEqual(incorporated.statusHistory.map(item => item.reason), ["initial", "writer"]);
  assert.deepEqual(incorporated.statusHistory.map(item => item.status), ["IDEA", "incorporated"]);
  assert.equal((await api.getNarrativeIdeas())[0].status, "incorporated");
  const unchanged = await api.setNarrativeIdeaStatus(ideas[0].id, "incorporated");
  assert.equal(unchanged.statusHistory.length, 2);
});


test("el MemoryStore no sobrescribe una idea archivada al restaurar y volver a transferir el mismo ID", async () => {
  const store = new MemoryStore();
  const projectId = "library-rearchive";
  const writerId = "writer-rearchive";
  const idea = {
    projectId, id: "same-idea", text: "Idea restaurada", status: "IDEA",
    originDocumentId: "chapter-1", sourceProjectName: "Libro", evidence: []
  };
  const existing = {
    writerId, sourceProjectId: projectId, sourceProjectName: "Libro",
    category: "Libro", idea: {
      ...idea, text: "Versión archivada original"
    }, context: { version: 1, relatedIdeas: [], relatedEntities: [] },
    archivedAt: 10
  };
  store.personalIdeas.set(JSON.stringify([writerId, projectId, idea.id]), structuredClone(existing));
  await store.saveIdea(idea);

  await assert.rejects(
    store.archiveUnincorporatedIdeas(projectId, writerId, "Libro", 20),
    /duplicate_personal_idea/
  );
  assert.deepEqual(
    store.personalIdeas.get(JSON.stringify([writerId, projectId, idea.id])),
    existing,
    "la versión archivada anterior no debe sobrescribirse"
  );
  assert.equal(
    (await store.loadIdeas(projectId)).find(item => item.id === idea.id)?.text,
    "Idea restaurada",
    "la idea restaurada debe seguir en el proyecto si la transferencia colisiona"
  );
});


test("transfiere ideas no incorporadas a una biblioteca aislada por escritor y conserva su procedencia", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "finished-book", projectName: "El faro de invierno", writerId: "writer-17" });
  assert.equal(api.getCapabilities().personalIdeaLibrary, true);
  assert.equal(api.getCapabilities().explicitIdeaLinks, true);
  assert.equal(api.getCapabilities().explicitIdeaEntityLinks, true);
  await api.extractNarrativeKnowledge("chapter-1", 1,
    "IDEA: La luz del faro responde a los recuerdos.");
  await api.extractNarrativeKnowledge("chapter-2", 1,
    "IDEA: La ciudad celebra la llegada del verano.");
  await api.extractNarrativeKnowledge("chapter-3", 1,
    "IDEA: El reloj se detiene a medianoche.");
  await api.extractNarrativeKnowledge("chapter-4", 1,
    "IDEA: La campana anuncia el regreso del viajero.");
  await api.extractNarrativeKnowledge("chapter-5", 1,
    "La protagonista Ana llega al pueblo.");
  const [first, second, third, fourth] = await api.getNarrativeIdeas();
  const ana = (await api.getNarrativeEntities()).find(entity => entity.canonicalName === "Ana");
  assert.ok(ana);
  await api.setNarrativeIdeaEntityLink(second.id, ana.id, true);
  await api.setNarrativeIdeaLink(second.id, fourth.id, true);
  const otherBook = new HostEngineApi({ store });
  otherBook.initializeProject({ projectId: "other-book", projectName: "Otro libro", writerId: "writer-17" });
  await assert.rejects(() => otherBook.setNarrativeIdeaLink(second.id, fourth.id, true), /Ambas ideas deben existir/);
  await assert.rejects(() => otherBook.setNarrativeIdeaEntityLink(second.id, ana.id, true), /La idea y la entidad deben existir/);
  await api.setNarrativeIdeaStatus(first.id, "incorporated");
  await api.setNarrativeIdeaStatus(third.id, "discarded");
  const archived = await api.archiveUnincorporatedIdeas();
  assert.equal(archived.length, 2);
  assert.equal(archived[0].writerId, "writer-17");
  assert.equal(archived[0].sourceProjectId, "finished-book");
  assert.equal(archived[0].sourceProjectName, "El faro de invierno");
  assert.equal(archived[0].category, "El faro de invierno");
  assert.equal(archived[0].idea.id, second.id);
  assert.equal(archived[0].idea.status, "IDEA");
  assert.ok(archived[0].idea.evidence.length > 0);
  assert.deepEqual(archived[0].idea.relatedEntityIds, [ana.id]);
  assert.deepEqual(archived[0].idea.relatedIdeaIds, [fourth.id]);
  assert.equal(archived[0].context.version, 1);
  assert.equal(archived[0].context.relatedIdeas.length, 0,
    "la idea relacionada que también se archiva se resuelve por su propia entrada");
  assert.equal(archived[0].context.relatedEntities[0].id, ana.id);
  assert.equal(archived[1].idea.id, fourth.id);
  assert.deepEqual(archived[0].idea.statusHistory.map(item => item.status), ["IDEA"]);
  assert.equal((await api.getNarrativeIdeas()).length, 2);
  assert.deepEqual(new Set((await api.getNarrativeIdeas()).map(item => item.id)), new Set([first.id, third.id]));
  assert.equal((await api.getNarrativeIdeas()).find(item => item.id === third.id).status, "discarded");
  assert.equal((await api.getPersonalIdeaLibrary()).length, 2);
  const otherWriter = new HostEngineApi({ store });
  otherWriter.initializeProject({ projectId: "finished-book", projectName: "El faro de invierno", writerId: "writer-18" });
  assert.equal((await otherWriter.getPersonalIdeaLibrary()).length, 0);
  assert.equal((await api.archiveUnincorporatedIdeas()).length, 0);
});

test("una instancia con caché antigua no puede restaurar una idea archivada por otra", async () => {
  const store = new MemoryStore();
  const first = new HostEngineApi({ store });
  const second = new HostEngineApi({ store });
  const identity = {
    projectId: "cross-instance-archive",
    projectName: "Libro compartido",
    writerId: "writer-cross-instance"
  };
  first.initializeProject(identity);
  second.initializeProject(identity);
  await store.saveIdea({
    projectId: identity.projectId, id: "idea-archived",
    text: "Idea final", status: "IDEA",
    originDocumentId: "chapter-1", sourceProjectName: identity.projectName,
    evidence: []
  });

  // La segunda instancia conserva una copia anterior a la transferencia.
  assert.equal((await second.getNarrativeIdeas()).length, 1);
  const archived = await first.archiveUnincorporatedIdeas();
  assert.equal(archived.length, 1);

  await assert.rejects(
    second.setNarrativeIdeaStatus("idea-archived", "discarded"),
    /ya no existe en el proyecto/
  );
  assert.deepEqual(await second.getNarrativeIdeas(), [],
    "la instancia descarta su caché obsoleta y no restaura la idea al libro");
  assert.equal((await second.getPersonalIdeaLibrary()).length, 1);
});


test("la biblioteca distingue ideas con el mismo ID cuando proceden de libros distintos", async () => {
  const store = new MemoryStore();
  const writerId = "writer-multi-book";
  const firstBook = new HostEngineApi({ store });
  firstBook.initializeProject({
    projectId: "book-a", projectName: "Libro A", writerId
  });
  await store.saveIdea({
    projectId: "book-a", id: "same-idea-id", text: "Idea del primer libro",
    status: "IDEA", originDocumentId: "chapter-a", sourceProjectName: "Libro A",
    evidence: []
  });
  const firstArchived = await firstBook.archiveUnincorporatedIdeas();
  assert.equal(firstArchived.length, 1);

  const secondBook = new HostEngineApi({ store });
  secondBook.initializeProject({
    projectId: "book-b", projectName: "Libro B", writerId
  });
  await store.saveIdea({
    projectId: "book-b", id: "same-idea-id", text: "Idea del segundo libro",
    status: "IDEA", originDocumentId: "chapter-b", sourceProjectName: "Libro B",
    evidence: []
  });
  const secondArchived = await secondBook.archiveUnincorporatedIdeas();
  assert.equal(secondArchived.length, 1);

  const library = await secondBook.getPersonalIdeaLibrary();
  assert.equal(library.length, 2);
  assert.deepEqual(
    library.map(entry => [entry.sourceProjectId, entry.idea.id, entry.category]),
    [
      ["book-a", "same-idea-id", "Libro A"],
      ["book-b", "same-idea-id", "Libro B"]
    ]
  );
  assert.deepEqual(
    new Set(library.map(entry => entry.idea.text)),
    new Set(["Idea del primer libro", "Idea del segundo libro"])
  );
});


test("una instancia del anfitrión no puede cambiar de libro y reutilizar cachés narrativas", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({
    projectId: "immutable-book-a", projectName: "Libro A", writerId: "writer-same"
  });
  await store.saveIdea({
    projectId: "immutable-book-a", id: "idea-a", text: "Idea del libro A",
    status: "IDEA", originDocumentId: "chapter-a",
    sourceProjectName: "Libro A", evidence: []
  });
  assert.equal((await api.getNarrativeIdeas())[0].text, "Idea del libro A");

  assert.throws(
    () => api.initializeProject({
      projectId: "immutable-book-b", projectName: "Libro B", writerId: "writer-same"
    }),
    /identidad de esta instancia es inmutable/
  );
  assert.equal((await api.getNarrativeIdeas())[0].projectId, "immutable-book-a");

  const secondBook = new HostEngineApi({ store });
  secondBook.initializeProject({
    projectId: "immutable-book-b", projectName: "Libro B", writerId: "writer-same"
  });
  await store.saveIdea({
    projectId: "immutable-book-b", id: "idea-a", text: "Idea del libro B",
    status: "IDEA", originDocumentId: "chapter-b",
    sourceProjectName: "Libro B", evidence: []
  });
  assert.equal((await secondBook.getNarrativeIdeas())[0].text, "Idea del libro B");
});


test("la biblioteca no resuelve vínculos de ideas usando IDs de otro libro", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({
    projectId: "current-book", projectName: "Libro abierto", writerId: "writer-links"
  });
  const makeEntry = (sourceProjectId, sourceProjectName, ideaId, relatedIdeaIds = []) => ({
    writerId: "writer-links",
    sourceProjectId,
    sourceProjectName,
    category: sourceProjectName,
    archivedAt: 10,
    idea: {
      projectId: sourceProjectId,
      id: ideaId,
      text: "Idea archivada",
      status: "IDEA",
      originDocumentId: "chapter-1",
      sourceProjectName,
      evidence: [],
      relatedIdeaIds
    },
    context: { version: 1, relatedIdeas: [], relatedEntities: [] }
  });
  store.loadPersonalIdeas = async () => [
    makeEntry("book-a", "Libro A", "idea-a", ["idea-only-in-book-b"]),
    makeEntry("book-b", "Libro B", "idea-only-in-book-b")
  ];
  await assert.rejects(
    api.getPersonalIdeaLibrary(),
    /referencias sin contexto resoluble/
  );
});


test("IndexedDB rechaza IDs duplicados dentro del contexto de una entrada archivada", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const sourceProjectId = "library-duplicate-context";
  const entry = {
    writerId: "writer-context",
    sourceProjectId,
    sourceProjectName: "Libro",
    category: "Libro",
    archivedAt: 10,
    idea: {
      projectId: sourceProjectId, id: "root", text: "Idea raíz", status: "IDEA",
      originDocumentId: "chapter-1", sourceProjectName: "Libro", evidence: []
    },
    context: {
      version: 1,
      relatedIdeas: [
        {
          projectId: sourceProjectId, id: "related", text: "Idea relacionada",
          status: "incorporated", originDocumentId: "chapter-2",
          sourceProjectName: "Libro", evidence: []
        },
        {
          projectId: sourceProjectId, id: "related", text: "Idea duplicada",
          status: "discarded", originDocumentId: "chapter-3",
          sourceProjectName: "Libro", evidence: []
        }
      ],
      relatedEntities: []
    }
  };
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = {
        error: null,
        objectStore() {
          return {
            index() {
              return {
                getAll() {
                  const request = {};
                  queueMicrotask(() => {
                    request.result = [structuredClone(entry)];
                    request.onsuccess?.();
                    queueMicrotask(() => transaction.oncomplete?.());
                  });
                  return request;
                }
              };
            }
          };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const request = { result: database };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      }
    }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.loadPersonalIdeas("writer-context"),
      /identificadores duplicados/
    );
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB aborta la transferencia completa si se interrumpe después de añadir una idea a la biblioteca", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const projectId = "archive-transaction-abort";
  const idea = {
    projectId, id: "idea-pending", text: "La ciudad aparece al amanecer.", status: "IDEA",
    originDocumentId: "chapter-1", sourceProjectName: "Libro", evidence: [],
    relatedIdeaIds: ["idea-kept"], relatedEntityIds: ["entity-ana"]
  };
  const relatedIdea = {
    projectId, id: "idea-kept", text: "Ana conoce la ciudad.", status: "incorporated",
    originDocumentId: "chapter-2", sourceProjectName: "Libro", evidence: [],
    relatedEntityIds: ["entity-ana"]
  };
  const entity = {
    projectId, id: "entity-ana", kind: "character", canonicalName: "Ana",
    normalizedName: "ana", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 2, extractionVersion: 1
  };
  let transaction;
  let additions = 0;
  let deletions = 0;
  const committedProjectIdeas = [structuredClone(idea), structuredClone(relatedIdea)];
  const committedLibrary = [];
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      let aborted = false;
      transaction = {
        error: new Error("simulated_archive_abort"),
        abort() {
          if (aborted) return;
          aborted = true;
          queueMicrotask(() => transaction.onabort?.());
        },
        objectStore(name) {
          if (name === "narrative-ideas") {
            return {
              index() {
                return { getAll() {
                  const request = {};
                  queueMicrotask(() => {
                    request.result = structuredClone(committedProjectIdeas);
                    request.onsuccess?.();
                  });
                  return request;
                } };
              },
              delete(key) {
                deletions++;
                assert.deepEqual(key, [projectId, "idea-pending"]);
              }
            };
          }
          if (name === "narrative-entities") {
            return {
              get(key) {
                const request = {};
                queueMicrotask(() => {
                  request.result = structuredClone(key[1] === entity.id ? entity : undefined);
                  request.onsuccess?.();
                });
                return request;
              }
            };
          }
          return {
            add(entry) {
              additions++;
              assert.equal(entry.writerId, "writer-a");
              assert.equal(entry.sourceProjectId, projectId);
              assert.deepEqual(entry.idea.relatedIdeaIds, ["idea-kept"]);
              assert.equal(entry.context.relatedIdeas[0].id, "idea-kept");
              assert.equal(entry.context.relatedEntities[0].id, "entity-ana");
              queueMicrotask(() => transaction.abort());
            }
          };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.archiveUnincorporatedIdeas(projectId, "writer-a", "Libro", 100),
      /simulated_archive_abort/
    );
    assert.equal(additions, 1, "la interrupción ocurre después de encolar el alta en biblioteca");
    assert.equal(deletions, 1, "la eliminación del origen también fue encolada en la misma transacción");
    assert.equal(committedProjectIdeas.length, 2,
      "el estado confirmado conserva la idea pendiente y la idea contextual en el proyecto");
    assert.equal(committedLibrary.length, 0,
      "el estado confirmado no contiene una copia parcial en la biblioteca");
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("la API invalida la caché si un adaptador confirma el archivo y devuelve entradas inválidas", async () => {
  const store = new MemoryStore();
  const idea = {
    projectId: "archive-invalid-response", id: "idea-1", text: "Idea pendiente", status: "IDEA",
    originDocumentId: "chapter", sourceProjectName: "Libro", evidence: []
  };
  await store.saveIdea(idea);
  store.archiveUnincorporatedIdeas = async (projectId, writerId, sourceProjectName, archivedAt) => {
    store.ideas.delete(projectId + ":idea-1");
    return [{ writerId, sourceProjectId: projectId, sourceProjectName, category: sourceProjectName,
      idea: { ...structuredClone(idea), text: "" }, archivedAt }];
  };
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "archive-invalid-response", projectName: "Libro", writerId: "writer-a" });
  assert.equal((await api.getNarrativeIdeas()).length, 1);
  await assert.rejects(() => api.archiveUnincorporatedIdeas(), /ideas de otro escritor o proyecto/i);
  assert.deepEqual(await api.getNarrativeIdeas(), []);
});

test("el archivo conserva instantáneas de ideas y fichas que permanecen en el libro", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "archive-cross-links", projectName: "Libro", writerId: "writer-a" });
  await store.saveEntity({
    projectId: "archive-cross-links", id: "ana", kind: "character",
    canonicalName: "Ana", normalizedName: "ana", aliases: [],
    evidence: [{ documentId: "chapter-5", revision: 4, start: 3, end: 6, excerpt: "Ana" }],
    firstSeenAt: 1, lastSeenAt: 2, extractionVersion: 1
  });
  await store.saveIdea({
    projectId: "archive-cross-links", id: "pending-idea", text: "Idea pendiente", status: "IDEA",
    originDocumentId: "chapter-1", sourceProjectName: "Libro", evidence: [],
    relatedIdeaIds: ["kept-idea"], relatedEntityIds: ["ana"]
  });
  await store.saveIdea({
    projectId: "archive-cross-links", id: "kept-idea", text: "Idea incorporada", status: "incorporated",
    originDocumentId: "chapter-2", sourceProjectName: "Libro",
    evidence: [{ documentId: "chapter-2", revision: 3, start: 10, end: 24, excerpt: "Idea incorporada" }],
    relatedEntityIds: ["ana"],
    statusHistory: [
      { status: "IDEA", changedAt: 1, reason: "initial" },
      { status: "incorporated", changedAt: 2, reason: "writer" }
    ]
  });
  assert.equal((await api.getNarrativeIdeas()).length, 2);
  const archived = await api.archiveUnincorporatedIdeas();
  assert.equal(archived.length, 1);
  assert.deepEqual(archived[0].idea.relatedIdeaIds, ["kept-idea"]);
  assert.equal(archived[0].context.relatedIdeas.length, 1);
  assert.equal(archived[0].context.relatedIdeas[0].id, "kept-idea");
  assert.deepEqual(
    archived[0].context.relatedIdeas[0].statusHistory,
    [
      { status: "IDEA", changedAt: 1, reason: "initial" },
      { status: "incorporated", changedAt: 2, reason: "writer" }
    ]
  );
  assert.deepEqual(archived[0].context.relatedIdeas[0].evidence, [
    { documentId: "chapter-2", revision: 3, start: 10, end: 24, excerpt: "Idea incorporada" }
  ]);
  assert.equal(archived[0].context.relatedEntities[0].id, "ana");
  assert.deepEqual(archived[0].context.relatedEntities[0].evidence, [
    { documentId: "chapter-5", revision: 4, start: 3, end: 6, excerpt: "Ana" }
  ]);
  const remaining = await api.getNarrativeIdeas();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, "kept-idea");
  assert.equal(remaining[0].relatedIdeaIds, undefined);
  const library = await api.getPersonalIdeaLibrary();
  assert.equal(library[0].context.relatedIdeas[0].text, "Idea incorporada");
});

test("el contexto archivado conserva ciclos entre ideas que permanecen en el libro", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({
    projectId: "archive-context-cycle",
    projectName: "Libro con ciclo",
    writerId: "writer-cycle"
  });
  await store.saveIdea({
    projectId: "archive-context-cycle", id: "pending-root",
    text: "Idea pendiente", status: "IDEA", originDocumentId: "chapter-1",
    sourceProjectName: "Libro con ciclo", evidence: [],
    relatedIdeaIds: ["kept-a"]
  });
  await store.saveIdea({
    projectId: "archive-context-cycle", id: "kept-a",
    text: "Idea incorporada A", status: "incorporated", originDocumentId: "chapter-2",
    sourceProjectName: "Libro con ciclo", evidence: [],
    relatedIdeaIds: ["kept-b"]
  });
  await store.saveIdea({
    projectId: "archive-context-cycle", id: "kept-b",
    text: "Idea descartada B", status: "discarded", originDocumentId: "chapter-3",
    sourceProjectName: "Libro con ciclo", evidence: [],
    relatedIdeaIds: ["kept-a"]
  });

  const archived = await api.archiveUnincorporatedIdeas();
  assert.equal(archived.length, 1);
  assert.deepEqual(
    archived[0].context.relatedIdeas.map(idea => idea.id),
    ["kept-a", "kept-b"]
  );
  const [keptA, keptB] = archived[0].context.relatedIdeas;
  assert.deepEqual(keptA.relatedIdeaIds, ["kept-b"]);
  assert.deepEqual(keptB.relatedIdeaIds, ["kept-a"]);
  const reopened = await api.getPersonalIdeaLibrary();
  assert.equal(reopened[0].context.relatedIdeas.length, 2);
});

test("el archivo conserva el grafo de ideas que se transfieren juntas sin duplicar sus nodos", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "archive-mutual-links", projectName: "Libro enlazado", writerId: "writer-a" });
  await store.saveIdea({
    projectId: "archive-mutual-links", id: "idea-a", text: "Idea A", status: "IDEA",
    originDocumentId: "chapter-a", sourceProjectName: "Libro enlazado", evidence: [],
    relatedIdeaIds: ["idea-b"]
  });
  await store.saveIdea({
    projectId: "archive-mutual-links", id: "idea-b", text: "Idea B", status: "IDEA",
    originDocumentId: "chapter-b", sourceProjectName: "Libro enlazado", evidence: [],
    relatedIdeaIds: ["idea-a"]
  });
  const archived = await api.archiveUnincorporatedIdeas();
  assert.equal(archived.length, 2);
  const byId = new Map(archived.map(entry => [entry.idea.id, entry]));
  assert.deepEqual(byId.get("idea-a").idea.relatedIdeaIds, ["idea-b"]);
  assert.deepEqual(byId.get("idea-b").idea.relatedIdeaIds, ["idea-a"]);
  assert.equal(byId.get("idea-a").context.relatedIdeas.length, 0);
  assert.equal(byId.get("idea-b").context.relatedIdeas.length, 0);
  const recovered = await api.getPersonalIdeaLibrary();
  assert.equal(recovered.length, 2);
  assert.deepEqual(
    new Set(recovered.map(entry => entry.idea.id)),
    new Set(["idea-a", "idea-b"])
  );
});

test("exige identidad de escritor suministrada por el anfitrión para acceder a la biblioteca", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "book-without-writer", projectName: "Libro sin identidad" });
  await assert.rejects(() => api.getPersonalIdeaLibrary(), /identificador estable del escritor/);
  await assert.rejects(() => api.archiveUnincorporatedIdeas(), /identificador estable del escritor/);
});

test("rechaza lecturas de biblioteca que mezclan identidades de escritor o proyecto", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "requesting-book", projectName: "Libro solicitante", writerId: "writer-requested" });
  store.personalIdeas.set("writer-other:book-other:idea-other", {
    writerId: "writer-other", sourceProjectId: "book-other", sourceProjectName: "Otro libro",
    category: "Otro libro", archivedAt: 1,
    idea: { projectId: "book-other", id: "idea-other", text: "Privada", status: "IDEA",
      originDocumentId: "chapter", sourceProjectName: "Otro libro", evidence: [] }
  });
  store.loadPersonalIdeas = async () => [{
    writerId: "writer-other", sourceProjectId: "book-other", sourceProjectName: "Otro libro",
    category: "Otro libro", archivedAt: 1,
    idea: { projectId: "book-other", id: "idea-other", text: "Privada", status: "IDEA",
      originDocumentId: "chapter", sourceProjectName: "Otro libro", evidence: [] }
  }];
  await assert.rejects(() => api.getPersonalIdeaLibrary(), /Violación de aislamiento/);
  store.loadPersonalIdeas = async () => [{
    writerId: "writer-requested", sourceProjectId: "book-a", sourceProjectName: "Libro A",
    category: "Libro A", archivedAt: 1,
    idea: { projectId: "book-b", id: "idea-cross-project", text: "Privada", status: "IDEA",
      originDocumentId: "chapter", sourceProjectName: "Libro A", evidence: [] }
  }];
  await assert.rejects(() => api.getPersonalIdeaLibrary(), /Violación de aislamiento/);
});

test("la lectura de biblioteca espera a que termine una transferencia en curso", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "archive-library-read", projectName: "Libro", writerId: "writer-a" });
  await store.saveIdea({
    projectId: "archive-library-read", id: "idea-1", text: "Idea pendiente", status: "IDEA",
    originDocumentId: "chapter", sourceProjectName: "Libro", evidence: []
  });
  await api.getNarrativeIdeas();
  let releaseArchive;
  let markArchiveStarted;
  const archiveGate = new Promise(resolve => { releaseArchive = resolve; });
  const archiveStarted = new Promise(resolve => { markArchiveStarted = resolve; });
  const originalArchive = store.archiveUnincorporatedIdeas.bind(store);
  store.archiveUnincorporatedIdeas = async (...args) => {
    markArchiveStarted();
    await archiveGate;
    return originalArchive(...args);
  };
  const archiving = api.archiveUnincorporatedIdeas();
  await archiveStarted;
  let libraryResolved = false;
  const library = api.getPersonalIdeaLibrary().then(entries => { libraryResolved = true; return entries; });
  await Promise.resolve();
  assert.equal(libraryResolved, false);
  releaseArchive();
  await archiving;
  assert.equal((await library).length, 1);
});

test("el archivo de ideas espera a que terminen las mutaciones narrativas pendientes", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "archive-serialization", projectName: "Libro", writerId: "writer-a" });
  await store.saveIdea({
    projectId: "archive-serialization", id: "idea-1", text: "Idea pendiente", status: "IDEA",
    originDocumentId: "chapter", sourceProjectName: "Libro", evidence: []
  });
  await api.getNarrativeIdeas();
  let releaseSave;
  let markSaveStarted;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  const saveStarted = new Promise(resolve => { markSaveStarted = resolve; });
  const originalUpdate = store.updateIdeaIfUnchanged.bind(store);
  store.updateIdeaIfUnchanged = async (idea, expectedCurrent) => {
    markSaveStarted();
    await saveGate;
    await originalUpdate(idea, expectedCurrent);
  };
  const statusChange = api.setNarrativeIdeaStatus("idea-1", "incorporated");
  await saveStarted;
  const archive = api.archiveUnincorporatedIdeas();
  releaseSave();
  await statusChange;
  assert.deepEqual(await archive, []);
  assert.equal((await api.getNarrativeIdeas())[0].status, "incorporated");
});

test("el archivo de ideas espera a que termine el análisis vivo antes de transferirlas", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "live-finished-book", projectName: "Libro en cierre", writerId: "writer-live" });
  await api.openDocument({ documentId: "chapter", text: "Borrador", revision: 0, sequence: 0 });
  const admission = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 8, end: 8, replacement: "\nIDEA: La puerta se abre al amanecer."
  });
  assert.equal(admission.status, "queued");
  const archived = await api.archiveUnincorporatedIdeas();
  assert.equal(archived.length, 1);
  assert.equal(archived[0].idea.text, "La puerta se abre al amanecer.");
  assert.equal((await api.getNarrativeIdeas()).length, 0);
});

test("mantiene monotónico el historial al sincronizar decisiones con una marca futura", async () => {
  const store = new MemoryStore();
  const projectId = "idea-clock-sync";
  const futureAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
  const idea = {
    projectId,
    id: "idea:chapter:0",
    text: "Idea original",
    status: "incorporated",
    originDocumentId: "chapter",
    sourceProjectName: "Reloj desincronizado",
    evidence: [],
    statusHistory: [
      { status: "IDEA", changedAt: 1, reason: "initial" },
      { status: "incorporated", changedAt: futureAt, reason: "writer" }
    ]
  };
  await store.saveIdea(idea);
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId, projectName: "Reloj desincronizado" });

  const discarded = await api.setNarrativeIdeaStatus(idea.id, "discarded");
  assert.ok(discarded.statusHistory[2].changedAt >= futureAt);
  assert.equal(discarded.statusHistory[2].reason, "writer");

  await api.extractNarrativeKnowledge("chapter", 2, "IDEA: Idea revisada.");
  const revised = (await api.getNarrativeIdeas())[0];
  assert.equal(revised.status, "IDEA");
  assert.equal(revised.statusHistory[3].reason, "text-revised");
  assert.ok(revised.statusHistory[3].changedAt >= futureAt);
  assert.deepEqual(revised.statusHistory.map(item => item.status), [
    "IDEA", "incorporated", "discarded", "IDEA"
  ]);
});

test("el historial de decisiones de una idea sobrevive al reinicio del motor", async () => {
  const store = new MemoryStore();
  const firstSession = new HostEngineApi({ store });
  firstSession.initializeProject({ projectId: "idea-history-restart", projectName: "Historia persistente" });
  await firstSession.extractNarrativeKnowledge("chapter", 1, "IDEA: El faro guía a los viajeros.");
  const original = (await firstSession.getNarrativeIdeas())[0];
  await firstSession.setNarrativeIdeaStatus(original.id, "incorporated");

  const restarted = new HostEngineApi({ store });
  restarted.initializeProject({ projectId: "idea-history-restart", projectName: "Historia persistente" });
  let recovered = (await restarted.getNarrativeIdeas())[0];
  assert.equal(recovered.status, "incorporated");
  assert.deepEqual(recovered.statusHistory.map(item => item.status), ["IDEA", "incorporated"]);
  assert.equal(recovered.statusHistory[1].reason, "writer");

  await restarted.extractNarrativeKnowledge("chapter", 2, "IDEA: El faro guía a los barcos.");
  recovered = (await restarted.getNarrativeIdeas())[0];
  assert.equal(recovered.status, "IDEA");
  assert.deepEqual(recovered.statusHistory.map(item => item.status), ["IDEA", "incorporated", "IDEA"]);
  assert.equal(recovered.statusHistory[2].reason, "text-revised");
});


test("acontecimientos e ideas no se filtran entre proyectos", async () => {
  const store = new MemoryStore();
  const first = new HostEngineApi({ store });
  first.initializeProject({ projectId: "event-idea-a", projectName: "A" });
  await first.extractNarrativeKnowledge(
    "chapter", 1, "El personaje Nora llegó.\nEVENTO: Nora cruza el puente.\nIDEA: El puente esconde un secreto."
  );
  const second = new HostEngineApi({ store });
  second.initializeProject({ projectId: "event-idea-b", projectName: "B" });
  assert.equal((await second.getNarrativeEvents()).length, 0);
  assert.equal((await second.getNarrativeIdeas()).length, 0);
});


test("reconoce relaciones con nombres propios que comienzan con letras acentuadas", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "novel-accented-relations", projectName: "Nombres acentuados" });
  await api.extractNarrativeKnowledge(
    "chapter", 1,
    "El personaje Álvaro y el personaje Lucía. Álvaro es hermano de Lucía."
  );
  const relations = await api.getNarrativeRelations();
  assert.equal(relations.length, 1);
  assert.equal(relations[0].relationType, "hermano");
});


test("una idea editada conserva su historial y vuelve al estado IDEA", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "novel-edited-idea", projectName: "Idea editada" });
  await api.extractNarrativeKnowledge("chapter", 1, "IDEA: El mapa esconde una isla.");
  let idea = (await api.getNarrativeIdeas())[0];
  await api.setNarrativeIdeaStatus(idea.id, "incorporated");
  await api.extractNarrativeKnowledge("chapter", 2, "IDEA: El mapa esconde una ciudad.");
  idea = (await api.getNarrativeIdeas())[0];
  assert.equal(idea.text, "El mapa esconde una ciudad.");
  assert.equal(idea.status, "IDEA");
  assert.equal(idea.evidence.length, 2);
  assert.deepEqual(idea.statusHistory.map(item => item.status), ["IDEA", "incorporated", "IDEA"]);
  assert.deepEqual(idea.statusHistory.map(item => item.reason), ["initial", "writer", "text-revised"]);
});


test("mantiene compatibilidad con adaptadores que solo persisten entidades", async () => {
  const records = new Map();
  const store = {
    async saveDocument() {},
    async loadDocument() { return undefined; },
    async saveEntity(entity) { records.set(entity.id, structuredClone(entity)); },
    async loadEntities(projectId) {
      return [...records.values()].filter(entity => entity.projectId === projectId);
    }
  };
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "legacy-store", projectName: "Adaptador compatible" });
  await api.extractNarrativeKnowledge("chapter", 1, "El personaje Bruno llegó.");
  assert.equal((await api.getNarrativeEntities()).length, 1);
  assert.equal(api.getCapabilities().evidenceBasedCharacterRelations, false);
});


test("el monitoreo vivo extrae entidades solo de las líneas modificadas y mantiene offsets absolutos", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "live-knowledge", projectName: "Conocimiento en vivo" });
  await api.openDocument({
    documentId: "chapter", text: "Prólogo.\n",
    revision: 0, sequence: 0
  });
  const base = "Prólogo.\n";
  const line = "El personaje Álvaro llegó.";
  const admission = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: base.length, end: base.length, replacement: line
  });
  assert.equal(admission.status, "queued");
  await api.flushPendingChanges();
  const entity = (await api.getNarrativeEntities()).find(item => item.canonicalName === "Álvaro");
  assert.ok(entity);
  assert.equal(entity.evidence[0].start, base.length + line.indexOf("Álvaro"));
  assert.equal(entity.evidence[0].excerpt, line);
});


test("no registra nombres incompletos mientras el escritor todavía está formando la palabra", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "live-partial-name", projectName: "Nombre parcial" });
  await api.openDocument({
    documentId: "chapter", text: "El personaje Al",
    revision: 0, sequence: 0
  });
  assert.equal((await api.getNarrativeEntities()).length, 0);
  const admission = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 15, end: 15, replacement: "varo llegó."
  });
  assert.equal(admission.status, "queued");
  await api.flushPendingChanges();
  const entities = await api.getNarrativeEntities();
  assert.equal(entities.length, 1);
  assert.equal(entities[0].canonicalName, "Alvaro");
});


test("un fallo del conocimiento narrativo no impide abrir ni editar el documento", async () => {
  class BrokenKnowledgeStore extends MemoryStore {
    async saveEntity() { throw new Error("knowledge_write_failed"); }
  }
  const errors = [];
  const api = new HostEngineApi({
    store: new BrokenKnowledgeStore(),
    callbacks: { onKnowledgeError: error => errors.push(error) }
  });
  api.initializeProject({ projectId: "knowledge-failure", projectName: "Fallo de conocimiento" });
  await api.openDocument({
    documentId: "chapter", text: "El personaje Ana llegó.",
    revision: 0, sequence: 0
  });
  assert.equal(api.getSnapshot("chapter")?.text, "El personaje Ana llegó.");
  await api.flushPendingChanges();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /knowledge_write_failed/);
});


test("la cronología ordena fechas explícitas y no inventa fechas para eventos sin referencia", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "timeline-explicit", projectName: "Cronología" });
  await api.extractNarrativeKnowledge(
    "chapter-1", 1,
    "ACONTECIMIENTO: [FECHA 2030-05-20] Se firma la alianza.\n" +
    "EVENTO: [DÍA 7] El grupo cruza el río.\n" +
    "ACONTECIMIENTO: [FECHA 2028-01-02] Comienza la guerra.\n" +
    "EVENTO: El mensajero llega sin indicar cuándo."
  );
  const events = await api.getNarrativeTimeline();
  assert.equal(events.length, 4);
  assert.equal(events[0].label, "[FECHA 2028-01-02] Comienza la guerra.");
  assert.equal(events[1].label, "[FECHA 2030-05-20] Se firma la alianza.");
  assert.equal(events[0].timeReference?.basis, "calendar");
  assert.equal(events[2].timeReference?.basis, "story-day");
  assert.equal(events[3].timeReference, undefined);
});

test("la cronología reconoce años y fechas con formato día/mes/año y rechaza fechas imposibles", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "timeline-formats", projectName: "Fechas" });
  await api.extractNarrativeKnowledge(
    "chapter", 1,
    "EVENTO: Año 1999, se funda la ciudad.\n" +
    "EVENTO: 31/12/2001 termina el conflicto.\n" +
    "EVENTO: 31/02/2002 no es una fecha válida."
  );
  const events = await api.getNarrativeTimeline();
  assert.equal(events[0].timeReference?.precision, "date");
  assert.equal(events[1].timeReference?.precision, "year");
  assert.equal(events[2].timeReference, undefined);
});


test("ignora años fuera del rango de calendario sin guardar referencias temporales corruptas", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "invalid-calendar-year", projectName: "Año extremo" });
  await api.extractNarrativeKnowledge(
    "chapter", 1,
    "El personaje Ana llegó.\n" +
    "EVENTO: Año 999999, Ana llegó a la ciudad.\n" +
    "Año 999999, Ana tiene 18 años."
  );

  const events = await api.getNarrativeEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].timeReference, undefined);
  const assertions = await api.getNarrativeAssertions();
  assert.equal(assertions.length, 1);
  assert.equal(assertions[0].timeReference, undefined);
});

test("detecta estados vitales incompatibles y conserva ambas evidencias sin resolverlas", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "contradiction-life", projectName: "Estados" });
  await api.extractNarrativeKnowledge(
    "chapter-1", 1,
    "El personaje Ana llegó.\nEVENTO: Ana está viva."
  );
  await api.extractNarrativeKnowledge(
    "chapter-2", 2,
    "EVENTO: Ana murió durante la batalla."
  );
  const conflicts = await api.getNarrativeContradictions();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].subject, "Ana");
  assert.equal(conflicts[0].predicate, "life-state");
  assert.deepEqual(new Set([conflicts[0].firstValue, conflicts[0].secondValue]), new Set(["alive", "dead"]));
  assert.equal(conflicts[0].status, "unresolved");
  assert.equal(conflicts[0].evidence.length, 2);
  assert.deepEqual(new Set(conflicts[0].evidence.map(item => item.documentId)), new Set(["chapter-1", "chapter-2"]));
});

test("no inventa contradicciones sin dos afirmaciones opuestas explícitas", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "contradiction-safe", projectName: "Sin conflicto" });
  await api.extractNarrativeKnowledge(
    "chapter", 1,
    "El personaje Bruno llegó.\nEVENTO: Bruno está vivo."
  );
  assert.equal((await api.getNarrativeContradictions()).length, 0);
});


test("no clasifica como contradicción una vida explícita anterior a una muerte posterior", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "life-transition", projectName: "Transición" });
  await api.extractNarrativeKnowledge(
    "chapter-1", 1,
    "El personaje Elena llegó.\nEVENTO: [FECHA 2020-01-01] Elena está viva."
  );
  await api.extractNarrativeKnowledge(
    "chapter-2", 2,
    "EVENTO: [FECHA 2021-01-01] Elena murió."
  );
  assert.equal((await api.getNarrativeContradictions()).length, 0);
});

test("detecta una contradicción posterior aunque exista una transición vital anterior válida", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "life-revival-conflict", projectName: "Retorno imposible" });
  await api.extractNarrativeKnowledge(
    "chapter-1", 1,
    "El personaje Mara llegó.\nEVENTO: [FECHA 2020-01-01] Mara está viva."
  );
  await api.extractNarrativeKnowledge(
    "chapter-2", 2,
    "EVENTO: [FECHA 2021-01-01] Mara murió."
  );
  await api.extractNarrativeKnowledge(
    "chapter-3", 3,
    "EVENTO: [FECHA 2022-01-01] Mara sigue viva."
  );

  const conflicts = await api.getNarrativeContradictions();
  assert.equal(conflicts.length, 1);
  assert.deepEqual(new Set(conflicts[0].evidence.map(item => item.documentId)),
    new Set(["chapter-2", "chapter-3"]));
});

test("mantiene como candidato un conflicto cuando la cronología no permite resolver la secuencia", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "life-unknown-order", projectName: "Orden desconocido" });
  await api.extractNarrativeKnowledge("chapter-a", 1, "El personaje Elena llegó.\nEVENTO: Elena murió.");
  await api.extractNarrativeKnowledge("chapter-b", 2, "EVENTO: Elena está viva.");
  assert.equal((await api.getNarrativeContradictions()).length, 1);
});


test("registra evolución explícita de personajes con historial, fechas y aislamiento", async () => {
  const store = new MemoryStore();
  const first = new HostEngineApi({ store });
  first.initializeProject({ projectId: "history-book-a", projectName: "Historia A" });
  await first.extractNarrativeKnowledge(
    "chapter-1", 1,
    "El personaje Ana llegó.\n[2020-01-02] Ana tiene 18 años y vive en Brumaria."
  );
  await first.extractNarrativeKnowledge(
    "chapter-2", 2,
    "El personaje Ana regresó.\n[2022-03-04] Ana tiene 20 años y es la reina."
  );
  const entity = (await first.getNarrativeEntities()).find(item => item.canonicalName === "Ana");
  const history = await first.getNarrativeEntityHistory(entity.id);
  assert.equal(history.length, 4);
  assert.deepEqual(history.map(item => item.attribute).sort(), ["age", "age", "location", "role"]);
  assert.deepEqual(history.filter(item => item.attribute === "age").map(item => item.value), [18, 20]);
  assert.equal(history[0].timeReference?.raw, "2020-01-02");
  assert.ok(history.every(item => item.evidence.excerpt.includes("Ana")));
  const second = new HostEngineApi({ store });
  second.initializeProject({ projectId: "history-book-b", projectName: "Historia B" });
  assert.equal((await second.getNarrativeAssertions()).length, 0);
});

test("no inventa historial cuando el personaje no está identificado explícitamente", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "history-no-guess", projectName: "Sin inferencias" });
  await api.extractNarrativeKnowledge("chapter", 1, "Ana tiene 18 años y vive en Brumaria.");
  assert.equal((await api.getNarrativeAssertions()).length, 0);
});


test("rechaza registros de otros proyectos devueltos por un adaptador defectuoso", async () => {
  const cases = [
    ["loadEntities", "getNarrativeEntities"],
    ["loadRelations", "getNarrativeRelations"],
    ["loadEvents", "getNarrativeEvents"],
    ["loadIdeas", "getNarrativeIdeas"],
    ["loadAssertions", "getNarrativeAssertions"]
  ];
  for (const [loader, getter] of cases) {
    const store = new MemoryStore();
    store[loader] = async () => [{ projectId: "otro-proyecto", id: "foreign-record" }];
    const api = new HostEngineApi({ store });
    api.initializeProject({ projectId: "proyecto-correcto", projectName: "Proyecto correcto" });
    await assert.rejects(() => api[getter](), /aislamiento|colección inválida/i, loader);
  }
});

test("la API rechaza registros narrativos malformados de adaptadores externos sin contaminar cachés", async () => {
  const store = new MemoryStore();
  store.loadEntities = async () => [{
    projectId: "external-shape", id: "broken", kind: "character",
    canonicalName: "", normalizedName: "ana", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  }];
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "external-shape", projectName: "Adaptador externo" });
  await assert.rejects(() => api.getNarrativeEntities(), /registro malformado en entidades/i);
  store.loadEntities = async () => [];
  assert.deepEqual(await api.getNarrativeEntities(), []);
});

test("la API rechaza IDs históricos reclamados por varias entidades", async () => {
  const store = new MemoryStore();
  const base = { projectId: "identity-history-integrity", kind: "character", aliases: [],
    evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1 };
  store.loadEntities = async () => [
    { ...base, id: "entity-a", canonicalName: "Ana", normalizedName: "ana", mergedFromIds: ["legacy-id"] },
    { ...base, id: "entity-b", canonicalName: "Anita", normalizedName: "anita", mergedFromIds: ["legacy-id"] }
  ];
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "identity-history-integrity", projectName: "Identidades" });
  await assert.rejects(() => api.getNarrativeEntities(), /ID histórico pertenece a más de una entidad/i);
  store.loadEntities = async () => [];
  assert.deepEqual(await api.getNarrativeEntities(), []);
});

test("la API rechaza vínculos duplicados o autorreferenciales dentro de una idea", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "idea-duplicate-links", projectName: "Libro" });
  const base = { projectId: "idea-duplicate-links", id: "idea-a", text: "Idea", status: "IDEA",
    originDocumentId: "chapter", sourceProjectName: "Libro", evidence: [] };
  store.loadIdeas = async () => [{ ...base, relatedIdeaIds: ["idea-b", "idea-b"] }];
  await assert.rejects(() => api.getNarrativeIdeas(), /registro malformado en ideas/i);
  store.loadIdeas = async () => [{ ...base, relatedIdeaIds: ["idea-a"] }];
  await assert.rejects(() => api.getNarrativeIdeas(), /registro malformado en ideas/i);
  store.loadIdeas = async () => [{
    ...base,
    statusHistory: [
      { status: "IDEA", reason: "initial", changedAt: 1 },
      { status: "IDEA", reason: "writer", changedAt: 2 }
    ]
  }];
  await assert.rejects(() => api.getNarrativeIdeas(), /registro malformado en ideas/i);
  store.loadIdeas = async () => [{
    ...base,
    status: "discarded",
    statusHistory: [
      { status: "incorporated", reason: "initial", changedAt: 1 },
      { status: "discarded", reason: "text-revised", changedAt: 2 }
    ]
  }];
  await assert.rejects(() => api.getNarrativeIdeas(), /registro malformado en ideas/i);
  store.loadIdeas = async () => [];
  assert.deepEqual(await api.getNarrativeIdeas(), []);
});

test("la API rechaza ideas con vínculos a entidades inexistentes sin contaminar la caché", async () => {
  const store = new MemoryStore();
  store.loadIdeas = async () => [{
    projectId: "idea-link-integrity", id: "idea-orphan", text: "Idea", status: "IDEA",
    originDocumentId: "chapter", sourceProjectName: "Libro", evidence: [],
    relatedEntityIds: ["missing-entity"]
  }];
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "idea-link-integrity", projectName: "Libro" });
  await assert.rejects(() => api.getNarrativeIdeas(), /referencias a entidades inexistentes/i);
  store.loadIdeas = async () => [];
  assert.deepEqual(await api.getNarrativeIdeas(), []);
});

test("rechaza registros ajenos antes de incorporarlos durante extracción narrativa", async () => {
  const store = new MemoryStore();
  store.loadEntities = async () => [{ projectId: "proyecto-ajeno", id: "foreign-entity" }];
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "proyecto-local", projectName: "Proyecto local" });
  await assert.rejects(
    () => api.extractNarrativeKnowledge("chapter", 1, "El personaje Ana llegó."),
    /aislamiento/i
  );
});


test("rebasea evidencias posteriores e invalida líneas editadas en todas las colecciones narrativas", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "evidence-rebase", projectName: "Rebase" });
  const original = [
    "El personaje Ana llegó.",
    "El personaje Luis llegó.",
    "Ana es hermana de Luis.",
    "EVENTO: Ana salva a Luis.",
    "IDEA: El mapa revela una isla.",
    "Ana tiene 18 años."
  ].join("\n");
  await api.openDocument({ documentId: "chapter-a", text: original, revision: 0, sequence: 0 });
  await api.flushPendingChanges();

  const other = new HostEngineApi({ store: new MemoryStore() });
  other.initializeProject({ projectId: "evidence-other", projectName: "Otro" });
  await other.extractNarrativeKnowledge("chapter-a", 0, "El personaje Bruno llegó.");
  await api.openDocument({ documentId: "chapter-b", text: "El personaje Zoe llegó.", revision: 0, sequence: 0 });
  await api.flushPendingChanges();
  const otherDocumentEvidence = (await api.getNarrativeEntities())
    .find(item => item.canonicalName === "Zoe").evidence[0];

  const prefix = "Prólogo.\n";
  const admitted = api.onEditorChange({
    documentId: "chapter-a", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: prefix
  });
  assert.equal(admitted.status, "queued");
  await api.flushPendingChanges();

  const entities = await api.getNarrativeEntities();
  const luis = entities.find(item => item.canonicalName === "Luis");
  const luisEvidence = luis.evidence.find(item => item.documentId === "chapter-a");
  assert.equal(luisEvidence.start, original.indexOf("Luis") + prefix.length);
  assert.equal(luisEvidence.status, undefined);
  const ana = entities.find(item => item.canonicalName === "Ana");
  // La inserción de un párrafo completo antes de la primera línea desplaza
  // la evidencia original; no altera el contenido de esa línea.
  assert.equal(ana.evidence.find(item => item.documentId === "chapter-a").status, undefined);

  const relation = (await api.getNarrativeRelations())[0];
  assert.equal(relation.evidence[0].status, undefined);
  assert.equal(relation.evidence[0].start, original.indexOf("Ana es") + prefix.length);
  const event = (await api.getNarrativeEvents())[0];
  assert.equal(event.evidence[0].start, original.indexOf("Ana salva") + prefix.length);
  assert.equal(event.evidence[0].status, undefined);
  const idea = (await api.getNarrativeIdeas())[0];
  assert.equal(idea.evidence[0].start, original.indexOf("El mapa") + prefix.length);
  assert.equal(idea.evidence[0].status, undefined);
  const assertion = (await api.getNarrativeAssertions())[0];
  assert.equal(assertion.evidence.start, original.indexOf("Ana tiene") + prefix.length);
  assert.equal(assertion.evidence.status, undefined);

  const endOfDocument = api.getSnapshot("chapter-a").text.length;
  const afterEvidence = api.onEditorChange({
    documentId: "chapter-a", sequence: 2, baseRevision: 1,
    start: endOfDocument, end: endOfDocument, replacement: " Fin."
  });
  assert.equal(afterEvidence.status, "queued");
  await api.flushPendingChanges();
  const unchangedLuis = (await api.getNarrativeEntities()).find(item => item.canonicalName === "Luis")
    .evidence.find(item => item.documentId === "chapter-a");
  assert.equal(unchangedLuis.start, original.indexOf("Luis") + prefix.length);
  assert.equal((await api.getNarrativeEntities()).find(item => item.canonicalName === "Zoe").evidence[0].start,
    otherDocumentEvidence.start);

  const firstLine = prefix.length;
  const endFirstLine = firstLine + "El personaje Ana llegó.".length;
  const second = api.onEditorChange({
    documentId: "chapter-a", sequence: 3, baseRevision: 2,
    start: firstLine, end: endFirstLine, replacement: "Ana desapareció."
  });
  assert.equal(second.status, "queued");
  await api.flushPendingChanges();
  const updatedAna = (await api.getNarrativeEntities()).find(item => item.canonicalName === "Ana");
  assert.ok(updatedAna.evidence.some(evidence => evidence.status === "stale"));
  assert.equal((await other.getNarrativeEntities()).length, 1);
});


test("marca como históricas relaciones, eventos, ideas y afirmaciones cuya línea se edita", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "stale-all-kinds", projectName: "Evidencia histórica" });
  const lines = [
    "El personaje Ana llegó.",
    "El personaje Luis llegó.",
    "Ana es hermana de Luis.",
    "EVENTO: Ana salva a Luis.",
    "IDEA: El mapa revela una isla.",
    "Ana tiene 18 años."
  ];
  await api.openDocument({ documentId: "chapter", text: lines.join("\n"), revision: 0, sequence: 0 });
  await api.flushPendingChanges();

  let revision = 0;
  let sequence = 0;
  const replaceLine = async (before, after) => {
    const snapshot = api.getSnapshot("chapter");
    const start = snapshot.text.indexOf(before);
    assert.notEqual(start, -1, before);
    const admission = api.onEditorChange({
      documentId: "chapter", sequence: ++sequence, baseRevision: revision,
      start, end: start + before.length, replacement: after
    });
    assert.equal(admission.status, "queued");
    await api.flushPendingChanges();
    revision++;
  };

  await replaceLine("Ana es hermana de Luis.", "Ana y Luis conversaron.");
  await replaceLine("EVENTO: Ana salva a Luis.", "Ana salva a Luis.");
  await replaceLine("IDEA: El mapa revela una isla.", "El mapa revela una isla.");
  await replaceLine("Ana tiene 18 años.", "Ana tiene 19 años.");

  assert.ok((await api.getNarrativeRelations())[0].evidence.some(item => item.status === "stale"));
  assert.ok((await api.getNarrativeEvents())[0].evidence.some(item => item.status === "stale"));
  assert.equal((await api.getNarrativeTimeline()).length, 0);
  assert.ok((await api.getNarrativeIdeas())[0].evidence.some(item => item.status === "stale"));
  const history = await api.getNarrativeAssertions();
  assert.ok(history.some(item => item.evidence.status === "stale"));
  assert.ok(history.some(item => item.value === 19 && item.evidence.status === undefined));
});


test("conserva la identidad y el estado de una idea al desplazarla y luego editarla", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "idea-stable-offset", projectName: "Idea estable" });
  const original = "IDEA: El mapa revela una isla.\nTexto final.";
  await api.openDocument({ documentId: "chapter", text: original, revision: 0, sequence: 0 });
  await api.flushPendingChanges();
  const initial = (await api.getNarrativeIdeas())[0];
  await api.setNarrativeIdeaStatus(initial.id, "incorporated");

  const prefix = "Prólogo.\n";
  const first = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: prefix
  });
  assert.equal(first.status, "queued");
  await api.flushPendingChanges();
  let idea = (await api.getNarrativeIdeas())[0];
  assert.equal(idea.id, initial.id);
  assert.equal(idea.status, "incorporated");
  assert.equal(idea.evidence[0].start, original.indexOf("El mapa") + prefix.length);

  const currentText = api.getSnapshot("chapter").text;
  const oldLine = "IDEA: El mapa revela una isla.";
  const start = currentText.indexOf(oldLine);
  const second = api.onEditorChange({
    documentId: "chapter", sequence: 2, baseRevision: 1,
    start, end: start + oldLine.length,
    replacement: "IDEA: El mapa revela dos islas."
  });
  assert.equal(second.status, "queued");
  await api.flushPendingChanges();
  const ideas = await api.getNarrativeIdeas();
  assert.equal(ideas.length, 1);
  idea = ideas[0];
  assert.equal(idea.id, initial.id);
  assert.equal(idea.status, "IDEA");
  assert.match(idea.text, /dos islas/);
});


test("una evidencia histórica obsoleta no oculta una evidencia vigente al detectar contradicciones", async () => {
  const store = new MemoryStore();
  const character = {
    projectId: "mixed-evidence", id: "entity:character:ana", kind: "character",
    canonicalName: "Ana", normalizedName: "ana", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  };
  store.entities.set("mixed-evidence:" + character.id, character);
  store.events.set("mixed-evidence:event:death", {
    projectId: "mixed-evidence", id: "event:death", label: "Ana está muerta",
    participants: [character.id],
    evidence: [
      { documentId: "chapter-death", revision: 1, start: 4, end: 19, excerpt: "Ana está muerta", status: "stale" },
      { documentId: "chapter-death", revision: 2, start: 14, end: 29, excerpt: "Ana está muerta" }
    ]
  });
  store.events.set("mixed-evidence:event:alive", {
    projectId: "mixed-evidence", id: "event:alive", label: "Ana sigue viva",
    participants: [character.id],
    evidence: [{ documentId: "chapter-alive", revision: 0, start: 0, end: 14, excerpt: "Ana sigue viva" }]
  });
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "mixed-evidence", projectName: "Evidencias mixtas" });
  const contradictions = await api.getNarrativeContradictions();
  assert.equal(contradictions.length, 1);
  assert.ok(contradictions[0].evidence.some(item =>
    item.documentId === "chapter-death" && item.revision === 2
  ));
  assert.ok(!contradictions[0].evidence.some(item => item.status === "stale"));
});


test("la cronología ordena por la ubicación vigente y no por offsets históricos obsoletos", async () => {
  const store = new MemoryStore();
  store.events.set("timeline-current:event-a", {
    projectId: "timeline-current", id: "event-a", label: "Acontecimiento A",
    participants: [], evidence: [
      { documentId: "chapter", revision: 0, start: 0, end: 5, excerpt: "Acontecimiento A", status: "stale" },
      { documentId: "chapter", revision: 2, start: 100, end: 105, excerpt: "Acontecimiento A" }
    ]
  });
  store.events.set("timeline-current:event-b", {
    projectId: "timeline-current", id: "event-b", label: "Acontecimiento B",
    participants: [], evidence: [
      { documentId: "chapter", revision: 2, start: 50, end: 55, excerpt: "Acontecimiento B" }
    ]
  });
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "timeline-current", projectName: "Cronología" });
  const timeline = await api.getNarrativeTimeline();
  assert.deepEqual(timeline.map(event => event.id), ["event-b", "event-a"]);
});


test("un alias confirmado resuelve menciones entre capítulos sin fusionar nombres ambiguos", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "alias-project", projectName: "Alias" });
  await api.openDocument({
    documentId: "chapter-one",
    text: "El personaje Alejandro llegó.\nEl personaje Bruno llegó.",
    revision: 0, sequence: 0
  });
  await api.flushPendingChanges();
  const entities = await api.getNarrativeEntities();
  const alejandro = entities.find(item => item.canonicalName === "Alejandro");
  const updated = await api.addNarrativeEntityAlias(alejandro.id, "El Zorro");
  assert.deepEqual(updated.aliases, ["El Zorro"]);

  await api.openDocument({
    documentId: "chapter-two",
    text: "El Zorro es hermano de Bruno.\nEVENTO: El Zorro está vivo.\nEl Zorro tiene 31 años.",
    revision: 0, sequence: 0
  });
  await api.flushPendingChanges();

  const relations = await api.getNarrativeRelations();
  assert.ok(relations.some(item => item.fromEntityId === alejandro.id));
  const events = await api.getNarrativeEvents();
  assert.ok(events.some(item => item.participants.includes(alejandro.id)));
  const assertions = await api.getNarrativeAssertions();
  assert.ok(assertions.some(item => item.entityId === alejandro.id && item.attribute === "age" && item.value === 31));

  await assert.rejects(
    () => api.addNarrativeEntityAlias(alejandro.id, "Bruno"),
    /ya identifica otra entidad/
  );
  assert.deepEqual((await api.getNarrativeEntities()).find(item => item.id === alejandro.id).aliases, ["El Zorro"]);
});

test("no permite registrar aliases con saltos de línea ni aliases vacíos", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "alias-validation", projectName: "Validación" });
  await api.extractNarrativeKnowledge("chapter", 0, "El personaje Ana llegó.");
  const entity = (await api.getNarrativeEntities())[0];
  await assert.rejects(() => api.addNarrativeEntityAlias(entity.id, "  "), /inválido/);
  await assert.rejects(() => api.addNarrativeEntityAlias(entity.id, "Ana\nLuis"), /inválido/);
});


test("detecta posibles entidades duplicadas solo por nombres explícitamente iguales", async () => {
  const store = new MemoryStore();
  const base = {
    projectId: "identity-candidates", kind: "character", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  };
  const records = [
    { ...base, id: "entity-a", canonicalName: "Ana", normalizedName: "ana", aliases: ["Anita"] },
    { ...base, id: "entity-b", canonicalName: " ANA ", normalizedName: "ana" },
    { ...base, id: "entity-c", canonicalName: "Anahí", normalizedName: "anahí" },
    { ...base, id: "entity-d", canonicalName: "El Zorro", normalizedName: "el zorro", aliases: ["Anita"] },
    { ...base, id: "other-project", projectId: "another-book", canonicalName: "Ana", normalizedName: "ana" }
  ];
  for (const entity of records) await store.saveEntity(entity);
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "identity-candidates", projectName: "Identidades" });
  const candidates = await api.getNarrativeEntityIdentityCandidates();
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map(item => item.reason).sort(), [
    "confirmed-name-overlap", "same-canonical-name"
  ]);
  assert.ok(candidates.every(item => item.projectId === "identity-candidates"));
  assert.ok(!candidates.some(item => item.firstEntityId === "entity-a" && item.secondEntityId === "entity-c"));
  assert.equal((await api.getNarrativeEntities()).length, 4);
});


test("una mención con alias explícito no crea una segunda ficha de personaje", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "alias-extraction", projectName: "Alias en extracción" });
  await api.extractNarrativeKnowledge("chapter-one", 0, "El personaje Alejandro llegó.");
  const initial = (await api.getNarrativeEntities())[0];
  await api.addNarrativeEntityAlias(initial.id, "Zorro");
  await api.extractNarrativeKnowledge("chapter-two", 0, "El personaje Zorro regresó.");
  const entities = await api.getNarrativeEntities();
  assert.equal(entities.length, 1);
  assert.equal(entities[0].id, initial.id);
  assert.equal(entities[0].canonicalName, "Alejandro");
  assert.deepEqual(entities[0].aliases, ["Zorro"]);
  assert.ok(entities[0].evidence.some(item => item.documentId === "chapter-two"));
});


test("consolida dos entidades y conserva referencias, evidencias e historial", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "merge-book", projectName: "Consolidación" });
  const common = {
    projectId: "merge-book", kind: "character", aliases: [], firstSeenAt: 1,
    lastSeenAt: 2, extractionVersion: 1
  };
  await store.saveEntity({ ...common, id: "target", canonicalName: "Alejandro", normalizedName: "alejandro",
    evidence: [{ documentId: "chapter-1", revision: 1, start: 4, end: 13, excerpt: "Alejandro" }] });
  await store.saveEntity({ ...common, id: "source", canonicalName: "Zorro", normalizedName: "zorro",
    evidence: [{ documentId: "chapter-2", revision: 2, start: 8, end: 13, excerpt: "Zorro" }] });
  await store.saveEntity({ ...common, id: "third", canonicalName: "Bruno", normalizedName: "bruno", evidence: [] });
  await store.saveRelation({ projectId: "merge-book", id: "relation-1", fromEntityId: "source", toEntityId: "third",
    relationType: "ally", evidence: [] });
  await store.saveEvent({ projectId: "merge-book", id: "event-1", label: "Regreso", participants: ["source", "target"],
    evidence: [], firstSeenAt: 1, lastSeenAt: 2, extractionVersion: 1 });
  await store.saveAssertion({ projectId: "merge-book", id: "assertion-1", entityId: "source",
    entityName: "Zorro", attribute: "age", value: 31,
    evidence: { documentId: "chapter-2", revision: 2, start: 8, end: 13, excerpt: "Zorro" }, capturedAt: 2 });
  // Carga previamente las cachés para verificar su invalidación tras la transacción.
  await api.getNarrativeRelations();
  await api.getNarrativeEvents();
  await api.getNarrativeAssertions();
  const merged = await api.mergeNarrativeEntities("target", "source");
  assert.equal(merged.id, "target");
  assert.deepEqual(merged.aliases, ["Zorro"]);
  assert.deepEqual(merged.mergedFromIds, ["source"]);
  assert.equal(merged.evidence.length, 2);
  assert.equal((await api.getNarrativeEntities()).length, 2);
  assert.equal((await api.getNarrativeRelations())[0].fromEntityId, "target");
  assert.equal((await api.getNarrativeRelations())[0].toEntityId, "third");
  assert.deepEqual((await api.getNarrativeEvents())[0].participants, ["target"]);
  assert.equal((await api.getNarrativeAssertions())[0].entityId, "target");
  assert.equal(await api.resolveNarrativeEntityId("source"), "target");
  assert.equal((await api.getNarrativeEntityHistory("source")).length, 1);
});

test("consolida también las identidades referenciadas por ideas ya archivadas sin alterar su historial", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({
    projectId: "merge-archived-library", projectName: "Libro de origen", writerId: "writer-merge"
  });
  const base = {
    projectId: "merge-archived-library", kind: "character", aliases: [],
    firstSeenAt: 1, lastSeenAt: 2, extractionVersion: 1
  };
  await store.saveEntity({
    ...base, id: "target", canonicalName: "Ana", normalizedName: "ana",
    mergedFromIds: ["target-legacy"],
    evidence: [{ documentId: "chapter-1", revision: 1, start: 0, end: 3, excerpt: "Ana" }]
  });
  await store.saveEntity({
    ...base, id: "source", canonicalName: "Anita", normalizedName: "anita",
    mergedFromIds: ["source-legacy"],
    evidence: [{ documentId: "chapter-2", revision: 2, start: 0, end: 5, excerpt: "Anita" }]
  });
  const root = {
    projectId: "merge-archived-library", id: "archived-root", text: "La idea pendiente",
    status: "IDEA", originDocumentId: "chapter-3", sourceProjectName: "Libro de origen",
    evidence: [{ documentId: "chapter-3", revision: 3, start: 0, end: 17, excerpt: "La idea pendiente" }],
    relatedEntityIds: ["source", "target"], relatedIdeaIds: ["context-idea"],
    statusHistory: [{ status: "IDEA", changedAt: 4, reason: "initial" }]
  };
  const contextual = {
    projectId: "merge-archived-library", id: "context-idea", text: "Idea incorporada",
    status: "incorporated", originDocumentId: "chapter-4", sourceProjectName: "Libro de origen",
    evidence: [{ documentId: "chapter-4", revision: 4, start: 0, end: 17, excerpt: "Idea incorporada" }],
    relatedEntityIds: ["source"],
    statusHistory: [
      { status: "IDEA", changedAt: 1, reason: "initial" },
      { status: "incorporated", changedAt: 5, reason: "writer" }
    ]
  };
  await store.saveIdea(root);
  await store.saveIdea(contextual);
  const [archived] = await api.archiveUnincorporatedIdeas();
  assert.equal(archived.context.relatedEntities.length, 2);

  // Simula una entrada histórica creada antes de que el libro pudiera resolver
  // los IDs absorbidos de fusiones anteriores.
  const archivedKey = [...store.personalIdeas.entries()].find(([, entry]) =>
    entry.idea.id === root.id
  )?.[0];
  assert.ok(archivedKey);
  const historicalEntry = store.personalIdeas.get(archivedKey);
  historicalEntry.idea.relatedEntityIds = ["source-legacy", "target-legacy"];
  historicalEntry.context.relatedIdeas[0].relatedEntityIds = ["source-legacy", "target-legacy"];
  historicalEntry.context.relatedEntities = [
    {
      ...base, id: "source-legacy", canonicalName: "Anita", normalizedName: "anita",
      evidence: [{ documentId: "chapter-2", revision: 2, start: 0, end: 5, excerpt: "Anita" }]
    },
    {
      ...base, id: "target-legacy", canonicalName: "Ana", normalizedName: "ana",
      evidence: [{ documentId: "chapter-1", revision: 1, start: 0, end: 3, excerpt: "Ana" }]
    }
  ];

  await api.mergeNarrativeEntities("target", "source");
  const [after] = await api.getPersonalIdeaLibrary();
  assert.deepEqual(after.idea.relatedEntityIds, ["target"]);
  assert.deepEqual(after.context.relatedIdeas[0].relatedEntityIds, ["target"]);
  assert.deepEqual(after.context.relatedEntities.map(entity => entity.id), ["target"]);
  assert.deepEqual(after.context.relatedEntities[0].mergedFromIds, ["target-legacy", "source", "source-legacy"]);
  assert.equal(after.context.relatedEntities[0].evidence.length, 2);
  assert.equal(after.idea.text, root.text);
  assert.deepEqual(after.idea.evidence, root.evidence);
  assert.deepEqual(after.idea.statusHistory, root.statusHistory);
  assert.equal(after.idea.originDocumentId, root.originDocumentId);
  assert.equal(after.sourceProjectId, "merge-archived-library");
  assert.equal(after.sourceProjectName, "Libro de origen");
  assert.equal(after.category, "Libro de origen");
  assert.equal(after.archivedAt, archived.archivedAt);
  assert.equal(after.context.relatedIdeas[0].text, contextual.text);
  assert.deepEqual(after.context.relatedIdeas[0].statusHistory, contextual.statusHistory);
});


test("rechaza consolidar entidades de proyectos o tipos distintos sin modificar datos", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "merge-safety", projectName: "Seguridad" });
  const base = { projectId: "merge-safety", aliases: [], evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1 };
  await store.saveEntity({ ...base, id: "character", kind: "character", canonicalName: "Ana", normalizedName: "ana" });
  await store.saveEntity({ ...base, id: "place", kind: "place", canonicalName: "Ana", normalizedName: "ana" });
  await assert.rejects(() => api.mergeNarrativeEntities("character", "place"), /tipos diferentes/);
  assert.equal((await api.getNarrativeEntities()).length, 2);
});


test("no realiza una consolidación parcial si el adaptador no ofrece transacción atómica", async () => {
  const store = new MemoryStore();
  store.mergeNarrativeEntityIdentity = undefined;
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "merge-no-atomic", projectName: "Sin transacción" });
  const base = { projectId: "merge-no-atomic", kind: "character", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1 };
  await store.saveEntity({ ...base, id: "one", canonicalName: "Ana", normalizedName: "ana" });
  await store.saveEntity({ ...base, id: "two", canonicalName: "Anita", normalizedName: "anita" });
  await assert.rejects(() => api.mergeNarrativeEntities("one", "two"), /no ofrece consolidación transaccional/);
  assert.equal((await api.getNarrativeEntities()).length, 2);
});


test("consolidación elimina relaciones propias y combina duplicadas sin perder evidencias", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "merge-relations", projectName: "Relaciones" });
  const base = { projectId: "merge-relations", kind: "character", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1 };
  await store.saveEntity({ ...base, id: "target", canonicalName: "Ana", normalizedName: "ana" });
  await store.saveEntity({ ...base, id: "source", canonicalName: "Anita", normalizedName: "anita" });
  await store.saveEntity({ ...base, id: "third", canonicalName: "Bruno", normalizedName: "bruno" });
  await store.saveRelation({ projectId: "merge-relations", id: "source-link", fromEntityId: "source",
    toEntityId: "third", relationType: "ally", evidence: [
      { documentId: "chapter-1", revision: 1, start: 0, end: 12, excerpt: "Anita aliada" }
    ] });
  await store.saveRelation({ projectId: "merge-relations", id: "target-link", fromEntityId: "target",
    toEntityId: "third", relationType: "ally", evidence: [
      { documentId: "chapter-2", revision: 2, start: 5, end: 17, excerpt: "Ana es aliada" }
    ] });
  await store.saveRelation({ projectId: "merge-relations", id: "self-link", fromEntityId: "source",
    toEntityId: "target", relationType: "rival", evidence: [
      { documentId: "chapter-3", revision: 1, start: 0, end: 8, excerpt: "Anita Ana" }
    ] });
  await store.saveIdea({ projectId: "merge-relations", id: "linked-idea", text: "Idea vinculada",
    status: "IDEA", originDocumentId: "chapter-1", sourceProjectName: "Relaciones", evidence: [],
    relatedEntityIds: ["source", "target", "third"] });
  await api.getNarrativeIdeas();
  await api.getNarrativeRelations();
  await api.mergeNarrativeEntities("target", "source");
  const relations = await api.getNarrativeRelations();
  assert.equal(relations.length, 1);
  assert.equal(relations[0].id, "target-link");
  assert.equal(relations[0].fromEntityId, "target");
  assert.equal(relations[0].toEntityId, "third");
  assert.equal(relations[0].evidence.length, 2);
  const linkedIdea = (await api.getNarrativeIdeas()).find(item => item.id === "linked-idea");
  assert.deepEqual(linkedIdea?.relatedEntityIds, ["target", "third"]);
  assert.deepEqual((await store.loadIdeas("merge-relations"))[0].relatedEntityIds, ["target", "third"]);
});


test("reconoce nombres compuestos de lugares y objetos sin perder partículas internas", async () => {
  const { extractNarrativeEntities } = await import("../dist/motor-literario.js");
  const entities = extractNarrativeEntities("compound-names", "chapter-1", 1,
    "La ciudad de Mar del Plata recibió al viajero. El personaje Juan de la Cruz llegó al castillo de los Tres Hermanos, donde guardaban una espada llamada Luz de Luna.");
  assert.ok(entities.some(item => item.kind === "place" && item.canonicalName === "Mar del Plata"));
  assert.ok(entities.some(item => item.kind === "character" && item.canonicalName === "Juan de la Cruz"));
  assert.ok(entities.some(item => item.kind === "place" && item.canonicalName === "Tres Hermanos"));
  assert.ok(entities.some(item => item.kind === "object" && item.canonicalName === "Luz de Luna"));
});


test("rechaza consolidaciones que crearían alias ambiguos con una tercera entidad", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "merge-alias-collision", projectName: "Colisión" });
  const base = { projectId: "merge-alias-collision", kind: "character", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1 };
  await store.saveEntity({ ...base, id: "target", canonicalName: "Juan", normalizedName: "juan" });
  await store.saveEntity({ ...base, id: "source", canonicalName: "Juan de la Cruz", normalizedName: "juan de la cruz" });
  await store.saveEntity({ ...base, id: "third", canonicalName: "Cruz", normalizedName: "cruz", aliases: ["Juan de la Cruz"] });
  await assert.rejects(() => api.mergeNarrativeEntities("target", "source"), /alias ambiguo/);
  assert.equal((await api.getNarrativeEntities()).length, 3);
});


test("la consolidación conserva evidencia vigente y obsoleta en la misma ubicación", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "merge-evidence-status", projectName: "Evidencias" });
  const base = { projectId: "merge-evidence-status", kind: "character", aliases: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1 };
  const shared = { documentId: "chapter-1", revision: 2, start: 10, end: 14, excerpt: "Ana" };
  await store.saveEntity({ ...base, id: "target", canonicalName: "Ana", normalizedName: "ana",
    evidence: [{ ...shared, status: "stale" }] });
  await store.saveEntity({ ...base, id: "source", canonicalName: "Anita", normalizedName: "anita",
    evidence: [shared] });
  const merged = await api.mergeNarrativeEntities("target", "source");
  assert.equal(merged.evidence.length, 2);
  assert.ok(merged.evidence.some(item => item.status === "stale"));
  assert.ok(merged.evidence.some(item => item.status === undefined));
});


test("el análisis de líneas extensas cede el hilo y conserva diagnósticos del final", async () => {
  const analyses = [];
  const api = new HostEngineApi({
    store: new MemoryStore(),
    callbacks: { onAnalysis: result => analyses.push(result) }
  });
  api.initializeProject({ projectId: "long-live-line", projectName: "Línea extensa" });
  const initialText = "a".repeat(40_000) + " palabra palabra";
  await api.openDocument({ documentId: "chapter", text: initialText, revision: 0, sequence: 0 });
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0);
  const admission = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: initialText.length, end: initialText.length, replacement: "!"
  });
  assert.equal(admission.status, "queued");
  await api.flushPendingChanges();
  assert.equal(timerFired, true);
  assert.ok(analyses[0]?.diagnostics.some(item => item.ruleId === "repeated-word"));
});


test("las fusiones narrativas conservan evidencias de revisiones distintas y su estado histórico", async () => {
  const {
    mergeNarrativeEntity, mergeNarrativeRelation, mergeNarrativeEvent, mergeNarrativeIdea
  } = await import("../dist/motor-literario.js");
  const stale = { documentId: "chapter-1", revision: 1, start: 20, end: 23, excerpt: "Ana", status: "stale" };
  const current = { documentId: "chapter-1", revision: 2, start: 20, end: 23, excerpt: "Ana" };
  const entityBase = { projectId: "evidence-history", kind: "character", canonicalName: "Ana",
    normalizedName: "ana", aliases: [], firstSeenAt: 1, lastSeenAt: 2, extractionVersion: 1 };
  const entity = mergeNarrativeEntity(
    { ...entityBase, id: "entity-1", evidence: [stale] },
    { ...entityBase, id: "entity-1", evidence: [current] }
  );
  const relation = mergeNarrativeRelation(
    { projectId: "evidence-history", id: "relation-1", fromEntityId: "entity-1",
      toEntityId: "entity-2", relationType: "ally", evidence: [stale] },
    { projectId: "evidence-history", id: "relation-1", fromEntityId: "entity-1",
      toEntityId: "entity-2", relationType: "ally", evidence: [current] }
  );
  const event = mergeNarrativeEvent(
    { projectId: "evidence-history", id: "event-1", label: "Ana llegó",
      participants: ["entity-1"], evidence: [stale] },
    { projectId: "evidence-history", id: "event-1", label: "Ana llegó",
      participants: ["entity-1"], evidence: [current] }
  );
  const idea = mergeNarrativeIdea(
    { projectId: "evidence-history", id: "idea-1", text: "Ana viaja", status: "IDEA",
      originDocumentId: "chapter-1", sourceProjectName: "Libro", evidence: [stale] },
    { projectId: "evidence-history", id: "idea-1", text: "Ana viaja", status: "IDEA",
      originDocumentId: "chapter-1", sourceProjectName: "Libro", evidence: [current] }
  );
  for (const record of [entity, relation, event, idea]) {
    assert.equal(record.evidence.length, 2);
    assert.ok(record.evidence.some(item => item.status === "stale"));
    assert.ok(record.evidence.some(item => item.status === undefined));
  }
});


test("las afirmaciones narrativas rechazan contexto y entidades malformados o ajenos", async () => {
  const { extractNarrativeAssertions } = await import("../dist/motor-literario.js");
  const entities = [{
    projectId: "assertion-validation", id: "ana", kind: "character", canonicalName: "Ana",
    normalizedName: "ana", aliases: [], evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  }];
  assert.throws(
    () => extractNarrativeAssertions("assertion-validation", "chapter", 1, "Ana tiene 30 años.", entities, 0, Number.NaN),
    /Contexto de afirmaciones/
  );
  assert.throws(
    () => extractNarrativeAssertions("assertion-validation", "chapter", 1, "Ana tiene 30 años.", [
      { ...entities[0], projectId: "other-project" }
    ]),
    /perteneciente a otro proyecto/
  );
  assert.throws(
    () => extractNarrativeAssertions("assertion-validation", "chapter", 1, "Ana tiene 30 años.", [
      { ...entities[0], aliases: ["Ana", 42] }
    ]),
    /Colección de entidades inválida/
  );
  const assertions = extractNarrativeAssertions(
    "assertion-validation", "chapter", 1, "Ana tiene 30 años.", entities, 0, 123
  );
  assert.equal(assertions.length, 1);
  assert.equal(assertions[0].capturedAt, 123);
});


test("los extractores narrativos rechazan parámetros y colecciones inválidos", async () => {
  const { extractNarrativeEntities, extractNarrativeIdeas, extractNarrativeRelations } =
    await import("../dist/motor-literario.js");
  const entities = [{
    projectId: "extract-validation", id: "ana", kind: "character", canonicalName: "Ana",
    normalizedName: "ana", aliases: [], evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  }];
  assert.throws(
    () => extractNarrativeEntities("extract-validation", "chapter", 1, "personaje Ana", Number.NaN),
    /Contexto de extracción narrativa/
  );
  assert.throws(
    () => extractNarrativeEntities("extract-validation", "chapter", 1, null),
    /Contexto de extracción narrativa/
  );
  assert.throws(
    () => extractNarrativeRelations("extract-validation", "chapter", 1, "Ana salvó a Luis", [
      { ...entities[0], projectId: "foreign-project" }
    ]),
    /entidades inválida|perteneciente a otro proyecto/i
  );
  assert.throws(
    () => extractNarrativeIdeas("extract-validation", "chapter", 1, "IDEA: Un secreto", 0, " "),
    /nombre del proyecto de origen/
  );
  assert.throws(
    () => extractNarrativeIdeas("extract-validation", "chapter", -1, "IDEA: Un secreto"),
    /Contexto de extracción narrativa/
  );
  assert.equal(
    extractNarrativeIdeas("extract-validation", "chapter", 1, "IDEA: Un secreto", 0, "Libro A").length,
    1
  );
  const { extractNarrativeAssertions } = await import("../dist/motor-literario.js");
  assert.throws(
    () => extractNarrativeAssertions(
      "extract-validation", "chapter", 1, "Ana tiene 30 años.", entities,
      Number.MAX_SAFE_INTEGER - 2, 100
    ),
    /Contexto de afirmaciones narrativas/
  );
  assert.throws(
    () => extractNarrativeAssertions("extract-validation", "chapter", 1, "Ana tiene 30 años.", [
      { ...entities[0], projectId: "foreign-project" }
    ]),
    /perteneciente a otro proyecto/
  );
});


test("los extractores omiten búsquedas narrativas costosas cuando faltan sus indicadores", async () => {
  const {
    extractNarrativeEntities, extractNarrativeRelations
  } = await import("../dist/motor-literario.js");
  const { extractNarrativeAssertions } = await import("../dist/motor-literario.js");
  const ordinaryText = "La tarde avanzó lentamente sobre el valle y todos guardaron silencio.";
  const entities = [{
    projectId: "fast-gates", id: "ana", kind: "character", canonicalName: "Ana",
    normalizedName: "ana", aliases: [], evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  }];
  assert.deepEqual(extractNarrativeEntities("fast-gates", "chapter", 1, ordinaryText), []);
  assert.deepEqual(extractNarrativeRelations("fast-gates", "chapter", 1, ordinaryText, entities), []);
  assert.deepEqual(extractNarrativeAssertions("fast-gates", "chapter", 1, ordinaryText, entities), []);
});


test("la identidad de un acontecimiento se recupera por documento y línea tras reabrir el proyecto", async () => {
  const store = new MemoryStore();
  const first = new HostEngineApi({ store });
  first.initializeProject({ projectId: "event-line-index", projectName: "Índice de eventos" });
  await first.extractNarrativeKnowledge("chapter", 1, "EVENTO: Ana encuentra la llave.");
  const original = (await first.getNarrativeEvents())[0];
  assert.ok(original);

  const reopened = new HostEngineApi({ store });
  reopened.initializeProject({ projectId: "event-line-index", projectName: "Índice de eventos" });
  await reopened.extractNarrativeKnowledge("chapter", 2, "EVENTO: Ana encuentra la puerta.");
  const events = await reopened.getNarrativeEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].id, original.id);
  assert.equal(events[0].label, "Ana encuentra la puerta.");
  assert.equal(events[0].evidence.length, 2);
});


test("las relaciones explícitas reconocen nombres compuestos con partículas internas", async () => {
  const { extractNarrativeEntities, extractNarrativeRelations } = await import("../dist/motor-literario.js");
  const text = "El personaje Juan de la Cruz y el personaje Ana llegaron. Juan de la Cruz es el padre de Ana.";
  const entities = extractNarrativeEntities("compound-relations", "chapter-1", 1, text);
  const relations = extractNarrativeRelations("compound-relations", "chapter-1", 1,
    "Juan de la Cruz es el padre de Ana.", entities);
  assert.equal(relations.length, 1);
  assert.equal(relations[0]?.fromEntityId, entities.find(item => item.canonicalName === "Juan de la Cruz")?.id);
  assert.equal(relations[0]?.toEntityId, entities.find(item => item.canonicalName === "Ana")?.id);
});


test("expone métricas de cola y aplicación sin esperar al análisis", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "live-metrics", projectName: "Métricas" });
  await api.openDocument({ documentId: "chapter", text: "Ana", revision: 0, sequence: 0 });
  const before = api.getLiveAnalysisMetrics();
  assert.equal(before.acceptedChanges, 0);
  const admission = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 3, end: 3, replacement: " llegó"
  });
  assert.equal(admission.status, "queued");
  assert.equal(api.getLiveAnalysisMetrics().acceptedChanges, 1);
  await api.flushPendingChanges();
  const after = api.getLiveAnalysisMetrics();
  assert.equal(after.appliedChanges, 1);
  assert.equal(after.failedChanges, 0);
  assert.equal(after.queueDepth, 0);
  assert.equal(after.activeChanges, 0);
  assert.equal(after.completedAnalyses, 1);
  assert.equal(after.failedAnalyses, 0);
  assert.equal(after.pendingAnalyses, 0);
  assert.ok(after.totalApplyMs >= 0);
  assert.ok(after.totalQueueWaitMs >= 0);
  assert.ok(after.queueWaitP50Ms >= 0);
  assert.ok(after.queueWaitP95Ms >= after.queueWaitP50Ms);
  assert.equal(after.queueWaitWindowSamples, 1);
  assert.ok(after.applyP50Ms >= 0);
  assert.ok(after.applyP95Ms >= after.applyP50Ms);
  assert.equal(after.applyWindowSamples, 1);
  assert.ok(after.totalKnowledgeMs >= 0);
  assert.ok(after.totalAnalysisQueueWaitMs >= 0);
  assert.ok(after.maxAnalysisQueueWaitMs >= 0);
  assert.ok(after.totalAnalysisExecutionMs >= 0);
  assert.ok(after.maxAnalysisExecutionMs >= 0);
  assert.ok(after.totalKnowledgeMs >= after.totalAnalysisExecutionMs);
  assert.equal(after.endToEndSamples, 1);
  assert.ok(after.totalEndToEndMs >= 0);
  assert.ok(after.maxEndToEndMs >= 0);
  assert.equal(after.endToEndWindowSamples, 1);
  assert.ok(after.endToEndP50Ms >= 0);
  assert.ok(after.endToEndP95Ms >= after.endToEndP50Ms);
});


test("las métricas de latencia conservan una ventana acotada en sesiones largas", async () => {
  const api = new HostEngineApi({ store: new MemoryStore(), queueCapacity: 520 });
  api.initializeProject({ projectId: "live-latency-window", projectName: "Ventana de latencia" });
  await api.openDocument({ documentId: "chapter", text: "", revision: 0, sequence: 0 });

  for (let sequence = 1; sequence <= 513; sequence++) {
    const admission = api.onEditorChange({
      documentId: "chapter",
      sequence,
      baseRevision: sequence - 1,
      start: sequence - 1,
      end: sequence - 1,
      replacement: "x"
    });
    assert.equal(admission.status, "queued");
  }

  await api.flushPendingChanges();
  const metrics = api.getLiveAnalysisMetrics();
  assert.equal(metrics.endToEndSamples, 513);
  assert.equal(metrics.endToEndWindowSamples, 512);
  assert.ok(metrics.endToEndP50Ms >= 0);
  assert.ok(metrics.endToEndP95Ms >= metrics.endToEndP50Ms);
  assert.equal(metrics.queueWaitWindowSamples, 256);
  assert.equal(metrics.applyWindowSamples, 256);
});

test("la cola aplica contrapresión medible cuando alcanza su capacidad", async () => {
  const api = new HostEngineApi({ store: new MemoryStore(), queueCapacity: 1 });
  api.initializeProject({ projectId: "live-backpressure", projectName: "Contrapresión" });
  await api.openDocument({ documentId: "chapter", text: "", revision: 0, sequence: 0 });
  const first = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "A"
  });
  const second = api.onEditorChange({
    documentId: "chapter", sequence: 2, baseRevision: 1,
    start: 1, end: 1, replacement: "B"
  });
  assert.equal(first.status, "queued");
  assert.deepEqual(second, { status: "rejected", reason: "queue_full" });
  const during = api.getLiveAnalysisMetrics();
  assert.equal(during.acceptedChanges, 1);
  assert.equal(during.rejectedChanges, 1);
  assert.equal(during.maxQueueDepth, 1);
  await api.flushPendingChanges();
  assert.equal(api.getLiveAnalysisMetrics().appliedChanges, 1);
});


test("el índice de acontecimientos sigue los desplazamientos de línea causados por ediciones anteriores", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "event-line-rebase", projectName: "Eventos desplazados" });
  await api.openDocument({
    documentId: "chapter",
    text: "Encabezado\nEVENTO: Ana llega.",
    revision: 0,
    sequence: 0
  });
  await api.flushPendingChanges();
  const original = (await api.getNarrativeEvents())[0];
  assert.ok(original);

  const prefix = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 0, end: 0, replacement: "Nota nueva\n"
  });
  assert.equal(prefix.status, "queued");
  await api.flushPendingChanges();

  const editEvent = api.onEditorChange({
    documentId: "chapter", sequence: 2, baseRevision: 1,
    start: 34, end: 39, replacement: "aparece"
  });
  assert.equal(editEvent.status, "queued");
  await api.flushPendingChanges();
  const events = await api.getNarrativeEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].id, original.id);
  assert.equal(events[0].label, "Ana aparece.");
});


test("una colisión entre instancias drena cambios obsoletos y permite resincronizar la sesión", async () => {
  class ConflictingStore extends MemoryStore {
    conflictNextAppend = true;
    async appendChange(change) {
      if (this.conflictNextAppend) {
        this.conflictNextAppend = false;
        await this.saveDocument({
          projectId: change.projectId,
          documentId: change.documentId,
          text: "Edición confirmada en otra instancia.",
          revision: 1,
          sequence: 1,
          updatedAt: 2
        });
        throw new Error("Conflicto de secuencia o revisión: otra instancia avanzó el documento.");
      }
    }
  }

  const store = new ConflictingStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "multi-instance-resync", projectName: "Resincronización" });
  await api.openDocument({
    documentId: "chapter", text: "Base.", revision: 0, sequence: 0
  });

  const first = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 5, end: 5, replacement: " cambio local"
  });
  const second = api.onEditorChange({
    documentId: "chapter", sequence: 2, baseRevision: 1,
    start: 17, end: 17, replacement: " pendiente"
  });
  assert.equal(first.status, "queued");
  assert.equal(second.status, "queued");

  await api.flushPendingChanges();
  const firstResult = first.status === "queued" ? api.pollCommit(first.ticketId) : undefined;
  const secondResult = second.status === "queued" ? api.pollCommit(second.ticketId) : undefined;
  assert.equal(firstResult?.status, "rejected");
  assert.match(firstResult?.reason ?? "", /otra instancia avanzó/);
  assert.equal(secondResult?.status, "rejected");
  assert.equal(secondResult?.reason, "resync_required");
  assert.equal(api.getDocumentSyncState("chapter")?.needsResync, true);
  assert.equal(api.getDocumentSyncState("chapter")?.pendingSequence, 0);
  assert.equal(api.getLiveAnalysisMetrics().queueDepth, 0);

  await api.openDocument({
    documentId: "chapter",
    text: "Edición confirmada en otra instancia.",
    revision: 1,
    sequence: 1
  });
  assert.equal(api.getDocumentSyncState("chapter")?.needsResync, false);

  const retried = api.onEditorChange({
    documentId: "chapter", sequence: 2, baseRevision: 1,
    start: 37, end: 37, replacement: " y continúa"
  });
  assert.equal(retried.status, "queued");
  await api.flushPendingChanges();
  assert.equal(api.pollCommit(retried.ticketId)?.status, "applied");
  assert.equal(api.getSnapshot("chapter")?.sequence, 2);
});


test("IndexedDB rechaza registros de otro proyecto en todas las lecturas de conocimiento", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let activeTransaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore() {
          return { index() {
            return { getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = [{ projectId: "foreign-project", id: "foreign-record" }];
                request.onsuccess?.();
                queueMicrotask(() => transaction.oncomplete?.());
              });
              return request;
            } };
          } };
        }
      };
      activeTransaction = transaction;
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    const reads = [
      ["loadEntities", () => store.loadEntities("requested-project")],
      ["loadRelations", () => store.loadRelations("requested-project")],
      ["loadEvents", () => store.loadEvents("requested-project")],
      ["loadIdeas", () => store.loadIdeas("requested-project")],
      ["loadAssertions", () => store.loadAssertions("requested-project")]
    ];
    for (const [label, read] of reads) {
      await assert.rejects(read(), /Aislamiento de .* inconsistente/ , label);
      assert.ok(activeTransaction, label);
    }
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB aborta el archivo de ideas si la colección contiene otra identidad de proyecto", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let writes = 0;
  let deletes = 0;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = {
        error: null,
        abort() { queueMicrotask(() => transaction.onabort?.()); },
        objectStore(name) {
          if (name === "narrative-ideas") {
            return {
              index() { return { getAll() {
                const request = {};
                queueMicrotask(() => {
                  request.result = [{
                    projectId: "foreign-project", id: "idea-1", status: "IDEA"
                  }];
                  request.onsuccess?.();
                });
                return request;
              } }; },
              delete() { deletes++; }
            };
          }
          return { put() { writes++; } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.archiveUnincorporatedIdeas("requested-project", "writer-a", "Libro", 10),
      /Aislamiento de ideas inconsistente/
    );
    assert.equal(writes, 0);
    assert.equal(deletes, 0);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB aborta la consolidación si alguna colección contiene registros de otro proyecto", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let writes = 0;
  let deletes = 0;
  const collections = {
    "narrative-entities": [
      { projectId: "project-a", id: "entity-target", kind: "character", aliases: [], canonicalName: "Ana", normalizedName: "ana", evidence: [], firstSeenAt: 1, lastSeenAt: 1 },
      { projectId: "project-a", id: "entity-source", kind: "character", aliases: [], canonicalName: "Ana", normalizedName: "ana", evidence: [], firstSeenAt: 1, lastSeenAt: 1 }
    ],
    "narrative-relations": [
      { projectId: "project-b", id: "foreign-relation" }
    ],
    "narrative-events": [],
    "narrative-assertions": []
  };
  let pendingReads = 6;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = {
        error: null,
        abort() { queueMicrotask(() => transaction.onabort?.()); },
        objectStore(name) {
          return {
            index() { return { getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = structuredClone(collections[name] ?? []);
                request.onsuccess?.();
                pendingReads--;
                if (pendingReads === 0) queueMicrotask(() => transaction.oncomplete?.());
              });
              return request;
            } }; },
            put() { writes++; },
            delete() { deletes++; }
          };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.mergeNarrativeEntityIdentity("project-a", "entity-target", "entity-source"),
      /Aislamiento de relación narrativa inconsistente/
    );
    assert.equal(writes, 0);
    assert.equal(deletes, 0);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB rechaza un resultado de journal que no sea una colección", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const originalKeyRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore() {
          return { index() {
            return { getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = { malformed: true };
                request.onsuccess?.();
              });
              return request;
            } };
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: { bound: (...bounds) => bounds }
  });
  try {
    const store = new IndexedDbProjectStore();
    const pending = store.loadChanges("journal-malformed-result", "chapter", 0);
    await new Promise(resolve => setTimeout(resolve, 0));
    transaction.oncomplete?.();
    await assert.rejects(pending, /Journal inconsistente/);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
    if (originalKeyRange) Object.defineProperty(globalThis, "IDBKeyRange", originalKeyRange);
    else delete globalThis.IDBKeyRange;
  }
});

test("IndexedDB no resuelve una lectura si la transacción termina sin resultado de solicitud", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore() {
          return { index() {
            return { getAll() { return {}; } };
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    const pending = store.loadEntities("missing-request-result");
    await new Promise(resolve => setTimeout(resolve, 0));
    transaction.oncomplete?.();
    await assert.rejects(pending, /No se pudieron leer las entidades narrativas/);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB no sobrescribe un snapshot corrupto al guardar ni al crear un checkpoint", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let writes = 0;
  const malformedSnapshot = {
    projectId: "corrupt-snapshot", documentId: "chapter",
    text: null, revision: 2, sequence: 2, updatedAt: 1
  };
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = {
        error: null,
        abort() { queueMicrotask(() => transaction.onabort?.()); },
        objectStore(name) {
          if (name === "documents") return {
            get() {
              const request = {};
              queueMicrotask(() => {
                request.result = structuredClone(malformedSnapshot);
                request.onsuccess?.();
              });
              return request;
            },
            put() { writes++; }
          };
          return { index() {
            return { openCursor() {
              throw new Error("No debe consultarse el journal con un snapshot corrupto.");
            } };
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    const valid = {
      projectId: "corrupt-snapshot", documentId: "chapter",
      text: "nuevo", revision: 3, sequence: 3, updatedAt: 2
    };
    await assert.rejects(store.saveDocument(valid), /Guardado rechazado/);
    await assert.rejects(
      store.saveDocumentAndCompactChanges(valid, 3),
      /Checkpoint obsoleto o inconsistente/
    );
    assert.equal(writes, 0);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB rechaza vínculos de idea duplicados y autorreferenciales antes de abrir la base", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let opens = 0;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() { opens++; throw new Error("No debería abrirse la base."); } }
  });
  try {
    const store = new IndexedDbProjectStore();
    const base = { projectId: "idea-link-shape", id: "idea-a", text: "Idea", status: "IDEA",
      originDocumentId: "chapter", sourceProjectName: "Libro", evidence: [] };
    await assert.rejects(
      store.saveIdea({ ...base, relatedIdeaIds: ["idea-b", "idea-b"] }),
      /referencias inválidas o duplicadas/i
    );
    await assert.rejects(
      store.saveIdea({ ...base, relatedIdeaIds: ["idea-a"] }),
      /no puede relacionarse consigo misma/i
    );
    assert.equal(opens, 0);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB actualiza una idea solo si sigue presente y coincide con la versión leída", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const expected = {
    projectId: "idea-conditional-update", id: "idea-1",
    text: "Idea original", status: "IDEA",
    originDocumentId: "chapter-1", sourceProjectName: "Libro", evidence: []
  };
  const updated = { ...expected, text: "Idea actualizada" };

  async function runCase(current, shouldSucceed) {
    let puts = 0;
    let transaction;
    const database = {
      onversionchange: null,
      close() {},
      transaction(storeNames, mode) {
        assert.deepEqual(storeNames, ["narrative-ideas"]);
        assert.equal(mode, "readwrite");
        transaction = {
          error: null,
          abort() { queueMicrotask(() => transaction.onabort?.()); },
          oncomplete: null,
          onabort: null,
          objectStore(name) {
            assert.equal(name, "narrative-ideas");
            return {
              get(key) {
                assert.deepEqual(key, [expected.projectId, expected.id]);
                const request = {};
                queueMicrotask(() => {
                  request.result = current === undefined ? undefined : structuredClone(current);
                  request.onsuccess?.();
                });
                return request;
              },
              put(record) {
                puts++;
                assert.deepEqual(record, updated);
                queueMicrotask(() => transaction.oncomplete?.());
              }
            };
          }
        };
        return transaction;
      }
    };
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: { open() {
        const request = { result: database };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      } }
    });
    const store = new IndexedDbProjectStore();
    if (shouldSucceed) {
      await store.updateIdeaIfUnchanged(updated, expected);
      assert.equal(puts, 1);
    } else {
      await assert.rejects(
        store.updateIdeaIfUnchanged(updated, expected),
        current === undefined
          ? /ya no existe en el proyecto/
          : /cambió en otra instancia/
      );
      assert.equal(puts, 0);
    }
  }

  try {
    await runCase(expected, true);
    await runCase(undefined, false);
    await runCase({ ...expected, text: "Otra versión ya guardada" }, false);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB guarda vínculos de idea solo tras confirmar sus destinos", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let puts = 0;
  const entity = {
    projectId: "idea-link-valid", id: "entity-a", kind: "character", canonicalName: "Ana",
    normalizedName: "ana", aliases: [], evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  };
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = {
        error: null,
        abort() { queueMicrotask(() => transaction.onabort?.()); },
        objectStore(name) {
          return {
            get(key) {
              const request = {};
              queueMicrotask(() => {
                request.result = structuredClone(entity);
                request.onsuccess?.();
                queueMicrotask(() => transaction.oncomplete?.());
              });
              return request;
            },
            put() { puts++; }
          };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() { const request = { result: database }; queueMicrotask(() => request.onsuccess?.()); return request; } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await store.saveIdea({
      projectId: "idea-link-valid", id: "idea-a", text: "Idea principal", status: "IDEA",
      originDocumentId: "chapter", sourceProjectName: "Libro", evidence: [],
      relatedEntityIds: ["entity-a"]
    });
    assert.equal(puts, 1);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB exige que los vínculos entre ideas apunten a registros del mismo proyecto", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let stored = 0;
  let relatedIdea = {
    projectId: "idea-reference-integrity", id: "idea-b", text: "Idea destino",
    status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Libro", evidence: []
  };
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      let finished = false;
      const transaction = {
        error: null,
        abort() {
          if (finished) return;
          finished = true;
          queueMicrotask(() => transaction.onabort?.());
        },
        objectStore() {
          return {
            get() {
              const request = {};
              queueMicrotask(() => {
                request.result = relatedIdea ? structuredClone(relatedIdea) : undefined;
                request.onsuccess?.();
                if (!finished) {
                  finished = true;
                  queueMicrotask(() => transaction.oncomplete?.());
                }
              });
              return request;
            },
            put() { stored++; }
          };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    const base = {
      projectId: "idea-reference-integrity", id: "idea-a", text: "Idea origen",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Libro", evidence: []
    };
    await store.saveIdea({ ...base, relatedIdeaIds: ["idea-b"] });
    assert.equal(stored, 1);

    relatedIdea = undefined;
    await assert.rejects(
      store.saveIdea({ ...base, id: "idea-c", relatedIdeaIds: ["missing-idea"] }),
      /ideas relacionadas no existen en el proyecto/i
    );
    assert.equal(stored, 1);

    relatedIdea = {
      projectId: "another-project", id: "idea-b", text: "Idea ajena",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Otro libro", evidence: []
    };
    await assert.rejects(
      store.saveIdea({ ...base, id: "idea-d", relatedIdeaIds: ["idea-b"] }),
      /ideas relacionadas no existen en el proyecto/i
    );
    assert.equal(stored, 1);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB rechaza ideas con vínculos huérfanos antes de guardarlas", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let puts = 0;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = {
        error: null,
        abort() { queueMicrotask(() => transaction.onabort?.()); },
        objectStore(name) {
          return {
            get() {
              const request = {};
              queueMicrotask(() => { request.result = undefined; request.onsuccess?.(); });
              return request;
            },
            put() { puts++; }
          };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() { const request = { result: database }; queueMicrotask(() => request.onsuccess?.()); return request; } }
  });
  try {
    const store = new IndexedDbProjectStore();
    const base = { projectId: "idea-link-write", id: "idea-a", text: "Idea", status: "IDEA",
      originDocumentId: "chapter", sourceProjectName: "Libro", evidence: [] };
    await assert.rejects(
      store.saveIdea({ ...base, relatedEntityIds: ["missing-entity"] }),
      /entidades no existen en el proyecto/i
    );
    assert.equal(puts, 0);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB conserva la procedencia al archivar tras renombrar el libro", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let storedEntry;
  let deleted = 0;
  const idea = {
    projectId: "renamed-book", id: "idea-1", text: "Una idea", status: "IDEA",
    originDocumentId: "chapter", sourceProjectName: "Título anterior", evidence: [],
    relatedIdeaIds: ["kept-idea"]
  };
  const keptIdea = {
    projectId: "renamed-book", id: "kept-idea", text: "Idea incorporada", status: "incorporated",
    originDocumentId: "chapter-2", sourceProjectName: "Título anterior", evidence: []
  };
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = { error: null, abort() { queueMicrotask(() => transaction.onabort?.()); }, objectStore(name) {
        return name === "narrative-ideas"
          ? { index() { return { getAll() {
            const request = {};
            queueMicrotask(() => {
              request.result = [structuredClone(idea), structuredClone(keptIdea)];
              request.onsuccess?.();
              queueMicrotask(() => transaction.oncomplete?.());
            });
            return request;
          } }; }, delete() { deleted++; } }
          : { add(entry) { storedEntry = structuredClone(entry); } };
      } };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() { const request = { result: database }; queueMicrotask(() => request.onsuccess?.()); return request; } }
  });
  try {
    const store = new IndexedDbProjectStore();
    const archived = await store.archiveUnincorporatedIdeas("renamed-book", "writer-a", "Título actual", 10);
    assert.equal(archived.length, 1);
    assert.equal(storedEntry.idea.sourceProjectName, "Título actual");
    assert.equal(storedEntry.category, "Título actual");
    assert.equal(storedEntry.context.relatedIdeas[0].sourceProjectName, "Título actual");
    assert.equal(storedEntry.context.relatedIdeas[0].id, "kept-idea");
    assert.equal(deleted, 1);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB aborta una transferencia repetida sin sobrescribir la entrada archivada", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const projectId = "library-rearchive-idb";
  const writerId = "writer-rearchive-idb";
  const idea = {
    projectId, id: "same-idea", text: "Idea restaurada", status: "IDEA",
    originDocumentId: "chapter-1", sourceProjectName: "Libro", evidence: []
  };
  const originalEntry = {
    writerId, sourceProjectId: projectId, sourceProjectName: "Libro",
    category: "Libro",
    idea: { ...idea, text: "Versión archivada original" },
    context: { version: 1, relatedIdeas: [], relatedEntities: [] },
    archivedAt: 10
  };
  const storedIdeas = [structuredClone(idea)];
  const storedLibrary = [structuredClone(originalEntry)];
  let queuedAdds = 0;
  let queuedDeletes = 0;
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore(name) {
          if (name === "narrative-ideas") {
            return {
              index() {
                return { getAll() {
                  const request = {};
                  queueMicrotask(() => {
                    request.result = structuredClone(storedIdeas);
                    request.onsuccess?.();
                  });
                  return request;
                } };
              },
              delete(key) { queuedDeletes++; }
            };
          }
          if (name === "personal-idea-library") {
            return {
              add(entry) {
                queuedAdds++;
                const request = {};
                queueMicrotask(() => {
                  // Simula ConstraintError de IDBObjectStore.add cuando la clave
                  // [writerId, sourceProjectId, idea.id] ya existe.
                  const error = new DOMException("Key already exists", "ConstraintError");
                  request.error = error;
                  transaction.error = error;
                  request.onerror?.();
                  transaction.onerror?.();
                  transaction.onabort?.();
                });
                return request;
              }
            };
          }
          return {};
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.archiveUnincorporatedIdeas(projectId, writerId, "Libro", 20),
      /Key already exists|ConstraintError/
    );
    assert.equal(queuedAdds, 1, "la transferencia detecta la colisión al insertar la clave existente");
    assert.equal(queuedDeletes, 1, "la eliminación también se encoló, pero debe revertirse con el aborto");
    assert.deepEqual(storedLibrary, [originalEntry],
      "la entrada original de biblioteca permanece intacta");
    assert.deepEqual(storedIdeas, [idea],
      "la idea restaurada permanece en el libro tras el aborto");
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB conserva contexto de ideas y entidades relacionadas después de reabrir la biblioteca", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const projectId = "archive-library-context";
  const sourceProjectName = "Libro con referencias";
  const projectIdeas = [
    {
      projectId, id: "pending", text: "Idea pendiente", status: "IDEA",
      originDocumentId: "chapter-1", sourceProjectName, evidence: [],
      relatedIdeaIds: ["kept", "pending-2"], relatedEntityIds: ["ana"]
    },
    {
      projectId, id: "pending-2", text: "Otra idea pendiente", status: "IDEA",
      originDocumentId: "chapter-2b", sourceProjectName, evidence: [],
      relatedIdeaIds: ["pending", "discarded"], relatedEntityIds: ["luz"]
    },
    {
      projectId, id: "kept", text: "Idea incorporada", status: "incorporated",
      originDocumentId: "chapter-2", sourceProjectName, evidence: [],
      relatedIdeaIds: ["discarded"], relatedEntityIds: ["ana", "luz"],
      statusHistory: [
        { status: "IDEA", changedAt: 1, reason: "initial" },
        { status: "incorporated", changedAt: 2, reason: "writer" }
      ]
    },
    {
      projectId, id: "discarded", text: "Idea descartada", status: "discarded",
      originDocumentId: "chapter-3", sourceProjectName, evidence: [],
      relatedEntityIds: ["luz"],
      statusHistory: [
        { status: "IDEA", changedAt: 1, reason: "initial" },
        { status: "discarded", changedAt: 3, reason: "writer" }
      ]
    }
  ];
  const entities = new Map([
    [JSON.stringify([projectId, "ana"]), {
      projectId, id: "ana", kind: "character", canonicalName: "Ana",
      normalizedName: "ana", aliases: [], evidence: [],
      firstSeenAt: 1, lastSeenAt: 2, extractionVersion: 1
    }],
    [JSON.stringify([projectId, "luz"]), {
      projectId, id: "luz", kind: "object", canonicalName: "La luz",
      normalizedName: "la luz", aliases: [], evidence: [],
      firstSeenAt: 1, lastSeenAt: 2, extractionVersion: 1
    }]
  ]);
  const personalEntries = [];
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = {
        error: null,
        pendingRequests: 0,
        abort() {
          queueMicrotask(() => transaction.onabort?.());
        },
        schedule(request, resolve) {
          transaction.pendingRequests++;
          queueMicrotask(() => {
            resolve();
            request.onsuccess?.();
            transaction.pendingRequests--;
            if (transaction.pendingRequests === 0) {
              queueMicrotask(() => transaction.oncomplete?.());
            }
          });
        },
        objectStore(name) {
          if (name === "narrative-ideas") {
            return {
              index() {
                return { getAll() {
                  const request = {};
                  transaction.schedule(request, () => {
                    request.result = structuredClone(projectIdeas);
                  });
                  return request;
                } };
              },
              delete(key) {
                const id = key[1];
                for (let index = projectIdeas.length - 1; index >= 0; index--) {
                  if (projectIdeas[index].id === id) projectIdeas.splice(index, 1);
                }
              }
            };
          }
          if (name === "narrative-entities") {
            return {
              get(key) {
                const request = {};
                transaction.schedule(request, () => {
                  request.result = structuredClone(entities.get(JSON.stringify(key)));
                });
                return request;
              }
            };
          }
          return {
            index() {
              return { getAll(writerId) {
                const request = {};
                transaction.schedule(request, () => {
                  request.result = structuredClone(personalEntries.filter(entry => entry.writerId === writerId));
                });
                return request;
              } };
            },
            add(entry) { personalEntries.push(structuredClone(entry)); }
          };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const request = { result: database };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      }
    }
  });
  try {
    const store = new IndexedDbProjectStore();
    const archived = await store.archiveUnincorporatedIdeas(
      projectId, "writer-context", sourceProjectName, 50
    );
    assert.equal(archived.length, 2);
    const archivedById = new Map(archived.map(entry => [entry.idea.id, entry]));
    assert.deepEqual(
      archivedById.get("pending").context.relatedIdeas.map(idea => idea.id),
      ["discarded", "kept"]
    );
    assert.deepEqual(
      archivedById.get("pending-2").context.relatedIdeas.map(idea => idea.id),
      ["discarded"]
    );
    assert.deepEqual(archivedById.get("pending").idea.relatedIdeaIds, ["kept", "pending-2"]);
    assert.deepEqual(archivedById.get("pending-2").idea.relatedIdeaIds, ["pending", "discarded"]);
    assert.deepEqual(
      archived[0].context.relatedEntities.map(entity => entity.id),
      ["ana", "luz"]
    );
    // Solo se transfieren las ideas IDEA; las incorporadas y descartadas
    // permanecen en el conocimiento del libro de origen.
    assert.equal(projectIdeas.length, 2);
    assert.deepEqual(projectIdeas.map(idea => idea.id).sort(), ["discarded", "kept"]);
    entities.clear(); // Simula la eliminación de las fichas del libro ya finalizado.

    const reopenedStore = new IndexedDbProjectStore();
    const library = await reopenedStore.loadPersonalIdeas("writer-context");
    assert.equal(library.length, 2);
    const libraryById = new Map(library.map(entry => [entry.idea.id, entry]));
    assert.deepEqual(libraryById.get("pending").idea.relatedIdeaIds, ["kept", "pending-2"]);
    assert.deepEqual(libraryById.get("pending-2").idea.relatedIdeaIds, ["pending", "discarded"],
      "los enlaces mutuos entre dos ideas trasladadas se conservan tras reabrir otra instancia");
    assert.deepEqual(
      libraryById.get("pending").context.relatedIdeas.map(idea => idea.id),
      ["discarded", "kept"]
    );
    assert.deepEqual(
      libraryById.get("pending-2").context.relatedIdeas.map(idea => idea.id),
      ["discarded"]
    );
    assert.equal(libraryById.get("pending").context.relatedIdeas.find(idea => idea.id === "kept")
      .statusHistory.at(-1).status, "incorporated");
    assert.equal(libraryById.get("pending").context.relatedIdeas.find(idea => idea.id === "discarded")
      .statusHistory.at(-1).status, "discarded");
    assert.deepEqual(new Set(libraryById.get("pending").context.relatedEntities.map(entity => entity.canonicalName)),
      new Set(["Ana", "La luz"]));

    const reopenedApi = new HostEngineApi({ store: reopenedStore });
    reopenedApi.initializeProject({
      projectId: "next-book", projectName: "Nuevo libro", writerId: "writer-context"
    });
    const libraryThroughHost = await reopenedApi.getPersonalIdeaLibrary();
    assert.deepEqual(
      new Set(libraryThroughHost.map(entry => entry.idea.id)),
      new Set(["pending", "pending-2"]),
      "la biblioteca personal sigue disponible al abrir otro proyecto del mismo escritor"
    );
    assert.deepEqual(
      libraryThroughHost.find(entry => entry.idea.id === "pending")?.idea.relatedIdeaIds,
      ["kept", "pending-2"]
    );
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB aborta el archivo si entradas diferentes reclaman el mismo ID histórico", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const projectId = "archive-history-collision";
  const idea = {
    projectId, id: "pending", text: "Idea pendiente", status: "IDEA",
    originDocumentId: "chapter", sourceProjectName: "Libro", evidence: [],
    relatedEntityIds: ["entity-a"]
  };
  const secondIdea = {
    projectId, id: "pending-b", text: "Otra idea pendiente", status: "IDEA",
    originDocumentId: "chapter-2", sourceProjectName: "Libro", evidence: [],
    relatedEntityIds: ["entity-b"]
  };
  const common = {
    projectId, kind: "character", aliases: [], evidence: [],
    mergedFromIds: ["legacy-id"], firstSeenAt: 1, lastSeenAt: 1,
    extractionVersion: 1
  };
  const entities = new Map([
    [JSON.stringify([projectId, "entity-a"]), {
      ...common, id: "entity-a", canonicalName: "Ana", normalizedName: "ana"
    }],
    [JSON.stringify([projectId, "entity-b"]), {
      ...common, id: "entity-b", canonicalName: "Anita", normalizedName: "anita"
    }]
  ]);
  let writes = 0;
  let deletes = 0;
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      let pendingRequests = 0;
      transaction = {
        error: null,
        abort() { queueMicrotask(() => transaction.onabort?.()); },
        schedule(request, resolve) {
          pendingRequests++;
          queueMicrotask(() => {
            resolve();
            request.onsuccess?.();
            pendingRequests--;
            if (pendingRequests === 0) queueMicrotask(() => transaction.oncomplete?.());
          });
        },
        objectStore(name) {
          if (name === "narrative-ideas") {
            return {
              index() {
                return { getAll() {
                  const request = {};
                  transaction.schedule(request, () => { request.result = [structuredClone(idea), structuredClone(secondIdea)]; });
                  return request;
                } };
              },
              delete() { deletes++; }
            };
          }
          if (name === "narrative-entities") {
            return {
              get(key) {
                const request = {};
                transaction.schedule(request, () => {
                  request.result = structuredClone(entities.get(JSON.stringify(key)));
                });
                return request;
              }
            };
          }
          return { add() { writes++; } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.archiveUnincorporatedIdeas(projectId, "writer-a", "Libro", 10),
      /ID histórico pertenece a más de una entidad/i
    );
    assert.equal(writes, 0, "no se añade una entrada con contexto de identidad ambiguo");
    assert.equal(deletes, 0, "la idea original sigue intacta si el contexto no puede validarse");
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB impide archivar ideas que aún son referenciadas por ideas que permanecen en el libro", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let writes = 0;
  let deletes = 0;
  const ideas = [
    {
      projectId: "archive-cross-reference", id: "pending", text: "Idea pendiente",
      status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Libro", evidence: []
    },
    {
      projectId: "archive-cross-reference", id: "kept", text: "Idea incorporada",
      status: "incorporated", originDocumentId: "chapter", sourceProjectName: "Libro",
      evidence: [], relatedIdeaIds: ["pending"]
    }
  ];
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = {
        error: null,
        abort() { queueMicrotask(() => transaction.onabort?.()); },
        objectStore(name) {
          return name === "narrative-ideas"
            ? { index() { return { getAll() {
              const request = {};
              queueMicrotask(() => { request.result = structuredClone(ideas); request.onsuccess?.(); });
              return request;
            } }; }, delete() { deletes++; } }
            : { add() { writes++; } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.archiveUnincorporatedIdeas("archive-cross-reference", "writer-a", "Libro", 10),
      /idea que permanecerá en el libro depende de una idea que se trasladaría/i
    );
    assert.equal(writes, 0, "no debe añadirse ninguna entrada a la biblioteca");
    assert.equal(deletes, 0, "no debe eliminarse ninguna idea del proyecto");
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB aborta el archivo antes de escribir si hay IDs de ideas duplicados", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let writes = 0;
  let deletes = 0;
  const idea = {
    projectId: "archive-duplicate-ideas", id: "same-id", text: "Una idea",
    status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Libro", evidence: []
  };
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = {
        error: null,
        abort() { queueMicrotask(() => transaction.onabort?.()); },
        objectStore(name) {
          return name === "narrative-ideas"
            ? { index() { return { getAll() {
              const request = {};
              queueMicrotask(() => { request.result = [structuredClone(idea), structuredClone(idea)]; request.onsuccess?.(); });
              return request;
            } }; }, delete() { deletes++; } }
            : { add() { writes++; } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() { const request = { result: database }; queueMicrotask(() => request.onsuccess?.()); return request; } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.archiveUnincorporatedIdeas("archive-duplicate-ideas", "writer-a", "Libro", 10),
      /identificadores duplicados/i
    );
    assert.equal(writes, 0);
    assert.equal(deletes, 0);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB rechaza ideas archivadas con evidencia malformada y no transfiere ideas inválidas", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let writes = 0;
  let deletes = 0;
  const malformedIdea = {
    projectId: "idea-validation", id: "idea-1", text: "Una idea",
    status: "IDEA", originDocumentId: "chapter", sourceProjectName: "Libro",
    evidence: [{ documentId: "chapter", revision: 1, start: -1, end: 3, excerpt: "idea" }]
  };
  const database = {
    onversionchange: null,
    close() {},
    transaction(storeNames) {
      const transaction = {
        error: null,
        abort() { queueMicrotask(() => transaction.onabort?.()); },
        objectStore(name) {
          return {
            index() { return { getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = name === "personal-idea-library"
                  ? [{
                    writerId: "writer-a", sourceProjectId: "idea-validation",
                    sourceProjectName: "Libro", category: "Libro",
                    idea: structuredClone(malformedIdea), archivedAt: 10
                  }]
                  : [structuredClone(malformedIdea)];
                request.onsuccess?.();
                if (storeNames === "personal-idea-library") {
                  queueMicrotask(() => transaction.oncomplete?.());
                }
              });
              return request;
            } }; },
            put() { writes++; },
            delete() { deletes++; }
          };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.loadPersonalIdeas("writer-a"),
      /Biblioteca personal inconsistente/
    );
    await assert.rejects(
      store.archiveUnincorporatedIdeas("idea-validation", "writer-a", "Libro", 10),
      /evidencia inválida/
    );
    assert.equal(writes, 0);
    assert.equal(deletes, 0);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB rechaza IDs duplicados dentro de una colección narrativa", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const entity = {
    projectId: "indexed-duplicate-ids", id: "same", kind: "character",
    canonicalName: "Ana", normalizedName: "ana", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  };
  let storedEntities = [structuredClone(entity), structuredClone(entity)];
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = {
        error: null,
        objectStore() { return { index() { return { getAll() {
          const request = {};
          queueMicrotask(() => {
            request.result = structuredClone(storedEntities);
            request.onsuccess?.();
            queueMicrotask(() => transaction.oncomplete?.());
          });
          return request;
        } }; } }; }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(store.loadEntities("indexed-duplicate-ids"), /identificadores duplicados/i);
    storedEntities = [
      { ...structuredClone(entity), id: "entity-a", mergedFromIds: ["legacy-id"] },
      { ...structuredClone(entity), id: "entity-b", canonicalName: "Anita", normalizedName: "anita", mergedFromIds: ["legacy-id"] }
    ];
    await assert.rejects(store.loadEntities("indexed-duplicate-ids"), /ID histórico pertenece a más de una entidad/i);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB rechaza colisiones de IDs históricos antes de guardar una entidad", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const records = [];
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      let aborted = false;
      let completed = false;
      const transaction = {
        error: null,
        abort() {
          if (aborted || completed) return;
          aborted = true;
          queueMicrotask(() => transaction.onabort?.());
        },
        objectStore() {
          return {
            index() {
              return {
                getAll(projectId) {
                  const request = {};
                  queueMicrotask(() => {
                    request.result = structuredClone(records.filter(item => item.projectId === projectId));
                    request.onsuccess?.();
                    queueMicrotask(() => {
                      if (!aborted && !completed) {
                        completed = true;
                        transaction.oncomplete?.();
                      }
                    });
                  });
                  return request;
                }
              };
            },
            put(record) { records.push(structuredClone(record)); }
          };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    const base = {
      projectId: "identity-write-integrity", kind: "character", aliases: [], evidence: [],
      firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
    };
    await store.saveEntity({
      ...base, id: "entity-a", canonicalName: "Ana", normalizedName: "ana",
      mergedFromIds: ["legacy-id"]
    });
    assert.equal(records.length, 1);

    await assert.rejects(
      store.saveEntity({
        ...base, id: "entity-b", canonicalName: "Anita", normalizedName: "anita",
        mergedFromIds: ["legacy-id"]
      }),
      /ID histórico pertenece a más de una entidad/i
    );
    assert.equal(records.length, 1, "la entidad conflictiva no debe persistirse");
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB actualiza la biblioteca personal dentro de la consolidación atómica de entidades", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const base = {
    projectId: "canonical-relation", kind: "character", aliases: [], firstSeenAt: 1,
    lastSeenAt: 2, extractionVersion: 1
  };
  const target = {
    ...base, id: "target", canonicalName: "Ana", normalizedName: "ana",
    mergedFromIds: ["target-legacy"],
    evidence: [{ documentId: "chapter-1", revision: 1, start: 0, end: 3, excerpt: "Ana" }]
  };
  const source = {
    ...base, id: "source", canonicalName: "Anita", normalizedName: "anita",
    mergedFromIds: ["source-legacy"],
    evidence: [{ documentId: "chapter-2", revision: 2, start: 0, end: 5, excerpt: "Anita" }]
  };
  const historicalSource = {
    ...source, id: "source-legacy", mergedFromIds: ["source-ancient"],
    aliases: ["Anita antigua"], firstSeenAt: 0, lastSeenAt: 1,
    evidence: [
      ...source.evidence,
      { documentId: "chapter-old-source", revision: 0, start: 0, end: 12, excerpt: "Anita en carta" }
    ]
  };
  const historicalAncientSource = {
    ...source, id: "source-ancient", mergedFromIds: undefined,
    aliases: ["Anita original"], firstSeenAt: 0, lastSeenAt: 0,
    evidence: [
      { documentId: "chapter-ancient-source", revision: 0, start: 0, end: 12, excerpt: "Anita original" }
    ]
  };
  const historicalTarget = {
    ...target, id: "target-legacy", mergedFromIds: undefined,
    aliases: ["Ana antigua"], firstSeenAt: 0, lastSeenAt: 1,
    evidence: [
      ...target.evidence,
      { documentId: "chapter-old-target", revision: 0, start: 0, end: 10, excerpt: "Ana en carta" }
    ]
  };
  const contextualIdea = {
    projectId: "canonical-relation", id: "context-idea", text: "Idea incorporada",
    status: "incorporated", originDocumentId: "chapter-2", sourceProjectName: "Libro",
    evidence: [], relatedEntityIds: ["source-legacy", "source-ancient", "target-legacy"],
    statusHistory: [
      { status: "IDEA", reason: "initial" },
      { status: "incorporated", changedAt: 5, reason: "writer" }
    ]
  };
  const collections = {
    "narrative-entities": [
      target, source,
      { ...base, id: "third", canonicalName: "Bruno", normalizedName: "bruno", evidence: [] }
    ],
    "narrative-relations": [
      { projectId: "canonical-relation", id: "source-link", fromEntityId: "source",
        toEntityId: "third", relationType: "ally", evidence: [
          { documentId: "chapter-1", revision: 1, start: 0, end: 12, excerpt: "Anita aliada" }
        ] },
      { projectId: "canonical-relation", id: "target-link", fromEntityId: "target",
        toEntityId: "third", relationType: "ally", evidence: [
          { documentId: "chapter-2", revision: 2, start: 5, end: 17, excerpt: "Ana es aliada" }
        ] },
      { projectId: "canonical-relation", id: "self-link", fromEntityId: "source",
        toEntityId: "target", relationType: "rival", evidence: [] }
    ],
    "narrative-events": [],
    "narrative-assertions": [],
    "narrative-ideas": [{
      projectId: "canonical-relation", id: "idea-linked", text: "La alianza importa",
      status: "IDEA", originDocumentId: "chapter-1", sourceProjectName: "Libro",
      evidence: [], relatedEntityIds: ["source", "target", "third"]
    }],
    "personal-idea-library": [
      {
        writerId: "writer-canonical", sourceProjectId: "canonical-relation",
        sourceProjectName: "Libro", category: "Libro", archivedAt: 20,
        idea: {
          projectId: "canonical-relation", id: "archived-idea", text: "La idea pendiente",
          status: "IDEA", originDocumentId: "chapter-3", sourceProjectName: "Libro",
          evidence: [{ documentId: "chapter-3", revision: 3, start: 0, end: 17, excerpt: "La idea pendiente" }],
          relatedEntityIds: ["source", "source-legacy", "source-ancient", "target", "target-legacy"], relatedIdeaIds: ["context-idea"],
          statusHistory: [{ status: "IDEA", changedAt: 4, reason: "initial" }]
        },
        context: {
          version: 1,
          relatedIdeas: [contextualIdea],
          relatedEntities: [source, historicalSource, historicalAncientSource, target, historicalTarget]
        }
      },
      {
        writerId: "writer-canonical", sourceProjectId: "canonical-relation",
        sourceProjectName: "Libro", category: "Libro", archivedAt: 18,
        idea: {
          projectId: "canonical-relation", id: "legacy-archived", text: "Idea antigua",
          status: "IDEA", originDocumentId: "chapter-legacy", sourceProjectName: "Libro",
          evidence: [], relatedEntityIds: ["source", "source-legacy", "source-ancient", "target-legacy"]
        }
      },
      {
        writerId: "writer-canonical", sourceProjectId: "another-book",
        sourceProjectName: "Otro libro", category: "Otro libro", archivedAt: 16,
        idea: {
          projectId: "another-book", id: "archived-idea", text: "Idea del segundo libro",
          status: "IDEA", originDocumentId: "chapter-other", sourceProjectName: "Otro libro",
          evidence: [], relatedEntityIds: ["source"]
        },
        context: {
          version: 1, relatedIdeas: [],
          relatedEntities: [{
            ...source, projectId: "another-book"
          }]
        }
      },
      {
        writerId: "another-writer", sourceProjectId: "canonical-relation",
        sourceProjectName: "Libro", category: "Libro", archivedAt: 17,
        idea: {
          projectId: "canonical-relation", id: "foreign-archived", text: "Idea de otro escritor",
          status: "IDEA", originDocumentId: "chapter-foreign", sourceProjectName: "Libro",
          evidence: [], relatedEntityIds: ["source"]
        },
        context: { version: 1, relatedIdeas: [], relatedEntities: [source] }
      }
    ]
  };
  const puts = [];
  const deletes = [];
  let pendingReads = 6;
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        abort() { queueMicrotask(() => transaction.onabort?.()); },
        objectStore(name) {
          return {
            index(indexName) {
              return {
                getAll(key) {
                  const request = {};
                  queueMicrotask(() => {
                    const records = collections[name] ?? [];
                    request.result = structuredClone(name === "personal-idea-library"
                      ? records.filter(item =>
                        item.writerId === key[0] && item.sourceProjectId === key[1]
                      )
                      : records.filter(item => item.projectId === key));
                    request.onsuccess?.();
                    pendingReads--;
                    if (pendingReads === 0) queueMicrotask(() => transaction.oncomplete?.());
                  });
                  return request;
                }
              };
            },
            put(record) { puts.push({ store: name, record: structuredClone(record) }); },
            delete(key) { deletes.push({ store: name, key }); }
          };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await store.mergeNarrativeEntityIdentity(
      "canonical-relation", "target", "source", "writer-canonical"
    );
    const primary = puts.find(item => item.store === "narrative-relations" && item.record.id === "target-link");
    assert.ok(primary);
    assert.equal(primary.record.evidence.length, 2);
    assert.ok(deletes.some(item => item.store === "narrative-relations" &&
      item.key[1] === "source-link"));
    assert.ok(deletes.some(item => item.store === "narrative-relations" &&
      item.key[1] === "self-link"));
    const linkedIdea = puts.find(item => item.store === "narrative-ideas" && item.record.id === "idea-linked");
    assert.deepEqual(linkedIdea?.record.relatedEntityIds, ["target", "third"]);

    const archived = puts.find(item => item.store === "personal-idea-library");
    assert.ok(archived, "la consolidación debe actualizar la entrada archivada en la misma transacción");
    assert.deepEqual(archived.record.idea.relatedEntityIds, ["target"]);
    assert.deepEqual(archived.record.context.relatedIdeas[0].relatedEntityIds, ["target"]);
    assert.deepEqual(archived.record.context.relatedEntities.map(entity => entity.id), ["target"]);
    assert.deepEqual(archived.record.context.relatedEntities[0].mergedFromIds, ["target-legacy", "source", "source-legacy", "source-ancient"]);
    assert.equal(archived.record.context.relatedEntities[0].evidence.length, 5,
      "la consolidación conserva también evidencias que solo estaban en snapshots antiguos");
    assert.ok(archived.record.context.relatedEntities[0].aliases.includes("Anita antigua"));
    assert.ok(archived.record.context.relatedEntities[0].aliases.includes("Anita original"));
    assert.ok(archived.record.context.relatedEntities[0].aliases.includes("Ana antigua"));
    assert.equal(archived.record.context.relatedEntities[0].firstSeenAt, 0);
    assert.equal(archived.record.context.relatedEntities[0].lastSeenAt, 2);
    assert.equal(archived.record.idea.text, "La idea pendiente");
    assert.equal(puts.filter(item => item.store === "personal-idea-library").length, 2,
      "solo se actualizan las entradas del escritor solicitado");
    const legacy = puts.find(item =>
      item.store === "personal-idea-library" && item.record.idea.id === "legacy-archived"
    );
    assert.deepEqual(legacy?.record.idea.relatedEntityIds, ["target"],
      "las entradas antiguas actualizan el ID, pero siguen sin fingir que poseen contexto");
    assert.equal(legacy?.record.context, undefined);
    assert.equal(puts.some(item =>
      item.store === "personal-idea-library" && item.record.writerId === "another-writer"
    ), false, "la consolidación no debe consultar ni modificar bibliotecas de otros escritores");
    assert.equal(puts.some(item =>
      item.store === "personal-idea-library" && item.record.sourceProjectId === "another-book"
    ), false, "la consolidación no debe modificar entradas del segundo libro del mismo escritor");
    assert.equal(archived.record.idea.status, "IDEA");
    assert.deepEqual(archived.record.idea.statusHistory, [{ status: "IDEA", changedAt: 4, reason: "initial" }]);
    assert.equal(archived.record.category, "Libro");
    assert.equal(archived.record.archivedAt, 20);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB aborta también la actualización de la biblioteca si falla la consolidación", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const projectId = "merge-transaction-abort";
  const writerId = "writer-transaction-abort";
  const base = {
    projectId, kind: "character", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  };
  const originalEntry = {
    writerId, sourceProjectId: projectId, sourceProjectName: "Libro",
    category: "Libro", archivedAt: 15,
    idea: {
      projectId, id: "archived-idea", text: "Idea archivada", status: "IDEA",
      originDocumentId: "chapter-1", sourceProjectName: "Libro", evidence: [],
      relatedEntityIds: ["source"]
    },
    context: {
      version: 1, relatedIdeas: [],
      relatedEntities: [{
        ...base, id: "source", canonicalName: "Anita", normalizedName: "anita"
      }]
    }
  };
  const committed = {
    "narrative-entities": [
      { ...base, id: "target", canonicalName: "Ana", normalizedName: "ana" },
      { ...base, id: "source", canonicalName: "Anita", normalizedName: "anita" }
    ],
    "narrative-relations": [],
    "narrative-events": [],
    "narrative-assertions": [],
    "narrative-ideas": [],
    "personal-idea-library": [originalEntry]
  };
  let queuedWrites = 0;
  let queuedDeletes = 0;
  let queuedPersonalWrites = 0;
  let pendingReads = 6;
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      let aborted = false;
      let completed = false;
      transaction = {
        error: new Error("simulated_transaction_abort"),
        abort() {
          if (aborted || completed) return;
          aborted = true;
          queueMicrotask(() => transaction.onabort?.());
        },
        objectStore(name) {
          return {
            index() {
              return { getAll(key) {
                const request = {};
                queueMicrotask(() => {
                  const values = committed[name] ?? [];
                  request.result = structuredClone(name === "personal-idea-library"
                    ? values.filter(item => item.writerId === key[0] && item.sourceProjectId === key[1])
                    : values.filter(item => item.projectId === key));
                  request.onsuccess?.();
                  pendingReads--;
                  if (pendingReads === 0) {
                    queueMicrotask(() => {
                      if (!aborted && !completed) {
                        completed = true;
                        transaction.oncomplete?.();
                      }
                    });
                  }
                });
                return request;
              } };
            },
            put(record) {
              queuedWrites++;
              if (name === "personal-idea-library") queuedPersonalWrites++;
              if (queuedWrites === 1) queueMicrotask(() => transaction.abort());
            },
            delete() { queuedDeletes++; }
          };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.mergeNarrativeEntityIdentity(projectId, "target", "source", writerId),
      /simulated_transaction_abort/
    );
    assert.ok(queuedWrites > 0 || queuedDeletes > 0,
      "la prueba debe abortar después de que la consolidación haya encolado escrituras");
    assert.equal(queuedPersonalWrites, 1,
      "la actualización de la biblioteca debe formar parte de la misma transacción");
    assert.equal(committed["narrative-entities"].length, 2,
      "el almacén confirmado conserva ambas entidades");
    assert.equal(committed["narrative-entities"].some(item => item.id === "source"), true,
      "la entidad origen no se elimina parcialmente");
    assert.equal(committed["personal-idea-library"][0].idea.relatedEntityIds[0], "source",
      "la biblioteca confirmada conserva el estado anterior si la transacción aborta");
    assert.equal(committed["personal-idea-library"][0].context.relatedEntities[0].id, "source",
      "la instantánea de origen no debe actualizarse parcialmente");
    for (const collection of [
      "narrative-relations", "narrative-events", "narrative-assertions", "narrative-ideas"
    ]) {
      assert.equal(committed[collection].length, 0,
        "ninguna colección relacionada debe confirmar cambios parciales");
    }
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB permite consolidar sin writerId si el libro no tiene ideas archivadas", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const projectId = "merge-no-archive-writer";
  const base = {
    projectId, kind: "character", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  };
  const collections = {
    "narrative-entities": [
      { ...base, id: "target", canonicalName: "Ana", normalizedName: "ana" },
      { ...base, id: "source", canonicalName: "Anita", normalizedName: "anita" }
    ],
    "narrative-relations": [],
    "narrative-events": [],
    "narrative-assertions": [],
    "narrative-ideas": [],
    "personal-idea-library": []
  };
  const writes = [];
  const deletes = [];
  let pendingReads = 6;
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction(names) {
      assert.ok(names.includes("personal-idea-library"));
      transaction = {
        error: null,
        abort() { queueMicrotask(() => transaction.onabort?.()); },
        objectStore(name) {
          return {
            index() {
              return { getAll() {
                const request = {};
                queueMicrotask(() => {
                  request.result = structuredClone(collections[name] ?? []);
                  request.onsuccess?.();
                  pendingReads--;
                  if (pendingReads === 0) queueMicrotask(() => transaction.oncomplete?.());
                });
                return request;
              } };
            },
            put(record) { writes.push({ store: name, record: structuredClone(record) }); },
            delete(key) { deletes.push({ store: name, key }); }
          };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await store.mergeNarrativeEntityIdentity(projectId, "target", "source");
    assert.equal(writes.filter(item => item.store === "narrative-entities").length, 1);
    assert.equal(writes[0].record.id, "target");
    assert.ok(deletes.some(item => item.store === "narrative-entities" &&
      item.key[1] === "source"));
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB exige writerId antes de consolidar un libro con ideas archivadas", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const projectId = "merge-library-writer-required";
  const base = {
    projectId, kind: "character", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  };
  const entities = [
    { ...base, id: "target", canonicalName: "Ana", normalizedName: "ana" },
    { ...base, id: "source", canonicalName: "Anita", normalizedName: "anita" }
  ];
  const archived = [{
    writerId: "writer-private",
    sourceProjectId: projectId,
    sourceProjectName: "Libro",
    category: "Libro",
    archivedAt: 20,
    idea: {
      projectId, id: "archived-idea", text: "Idea con referencia",
      status: "IDEA", originDocumentId: "chapter-1",
      sourceProjectName: "Libro", evidence: [], relatedEntityIds: ["source"]
    },
    context: {
      version: 1, relatedIdeas: [],
      relatedEntities: [{ ...base, id: "source", canonicalName: "Anita", normalizedName: "anita" }]
    }
  }];
  let writes = 0;
  let deletes = 0;
  let transactionStores = [];
  const collections = {
    "narrative-entities": entities,
    "narrative-relations": [],
    "narrative-events": [],
    "narrative-assertions": [],
    "narrative-ideas": [],
    "personal-idea-library": archived
  };
  const database = {
    onversionchange: null,
    close() {},
    transaction(names) {
      transactionStores = [...names];
      const tx = {
        error: null,
        abort() { queueMicrotask(() => tx.onabort?.()); },
        objectStore(name) {
          return {
            index(indexName) {
              return {
                getAll() {
                  const request = {};
                  queueMicrotask(() => {
                    request.result = structuredClone(collections[name] ?? []);
                    request.onsuccess?.();
                  });
                  return request;
                }
              };
            },
            put() { writes++; },
            delete() { deletes++; }
          };
        }
      };
      return tx;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.mergeNarrativeEntityIdentity(projectId, "target", "source"),
      /identidad estable del escritor/
    );
    assert.ok(transactionStores.includes("personal-idea-library"),
      "la verificación de la biblioteca debe formar parte de la transacción");
    assert.equal(writes, 0, "no debe escribir entidades ni snapshots parciales");
    assert.equal(deletes, 0, "no debe eliminar la identidad original");
    assert.deepEqual(collections["personal-idea-library"], archived,
      "la biblioteca archivada permanece intacta");
    assert.equal(entities.length, 2, "las dos entidades originales permanecen disponibles");
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB aborta la fusión ante referencias huérfanas en todas las colecciones narrativas", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const base = {
    projectId: "merge-orphan", kind: "character", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  };
  const entities = [
    { ...base, id: "target", canonicalName: "Ana", normalizedName: "ana" },
    { ...base, id: "source", canonicalName: "Anita", normalizedName: "anita" }
  ];

  async function runCase(orphanCollection, orphanRecord, expectedMessage) {
    const collections = {
      "narrative-entities": entities,
      "narrative-relations": [],
      "narrative-events": [],
      "narrative-assertions": [],
      "narrative-ideas": [],
      "personal-idea-library": []
    };
    collections[orphanCollection] = [orphanRecord];
    let writes = 0;
    let deletes = 0;
    const database = {
      onversionchange: null,
      close() {},
      transaction() {
        const tx = {
          error: null,
          abort() { queueMicrotask(() => tx.onabort?.()); },
          objectStore(name) {
            return {
              index() { return { getAll() {
                const request = {};
                queueMicrotask(() => {
                  request.result = structuredClone(collections[name]);
                  request.onsuccess?.();
                });
                return request;
              } }; },
              put() { writes++; },
              delete() { deletes++; }
            };
          }
        };
        return tx;
      }
    };
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: { open() {
        const request = { result: database };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      } }
    });
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.mergeNarrativeEntityIdentity("merge-orphan", "target", "source"),
      expectedMessage
    );
    assert.equal(writes, 0);
    assert.equal(deletes, 0);
  }

  try {
    await runCase("narrative-relations", {
      projectId: "merge-orphan", id: "orphan-link", fromEntityId: "target",
      toEntityId: "missing", relationType: "ally", evidence: []
    }, /relación referencia una entidad inexistente/);

    await runCase("narrative-events", {
      projectId: "merge-orphan", id: "orphan-event", label: "Llegada",
      participants: ["missing"], evidence: []
    }, /acontecimiento referencia una entidad inexistente/);

    await runCase("narrative-assertions", {
      projectId: "merge-orphan", id: "orphan-assertion", entityId: "missing",
      entityName: "Desconocida", attribute: "role", value: "guardia",
      capturedAt: 1, evidence: {
        documentId: "chapter", revision: 1, start: 0, end: 11, excerpt: "Desconocida"
      }
    }, /afirmación referencia una entidad inexistente/);

    await runCase("narrative-ideas", {
      projectId: "merge-orphan", id: "orphan-idea", text: "Idea", status: "IDEA",
      originDocumentId: "chapter", sourceProjectName: "Libro", evidence: [],
      relatedEntityIds: ["missing"]
    }, /idea referencia una entidad inexistente/);

    await runCase("narrative-ideas", {
      projectId: "merge-orphan", id: "orphan-idea-link", text: "Idea vinculada", status: "IDEA",
      originDocumentId: "chapter", sourceProjectName: "Libro", evidence: [],
      relatedIdeaIds: ["missing-idea"]
    }, /idea referencia otra idea inexistente/);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB no anexa ediciones fuera del texto ni acepta deltas previos con rangos imposibles", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const originalKeyRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  async function runCase(existingChanges, incomingChange) {
    let additions = 0;
    let transaction;
    const snapshot = {
      projectId: "journal-ranges", documentId: "chapter",
      text: "abc", revision: 0, sequence: 0, updatedAt: 1
    };
    const database = {
      onversionchange: null,
      close() {},
      transaction() {
        transaction = {
          error: null,
          abort() { queueMicrotask(() => transaction.onabort?.()); },
          objectStore(name) {
            if (name === "documents") return {
              get() {
                const request = {};
                queueMicrotask(() => {
                  request.result = structuredClone(snapshot);
                  request.onsuccess?.();
                });
                return request;
              }
            };
            return {
              add() { additions++; },
              index() { return { openCursor() {
                const request = {};
                queueMicrotask(() => {
                  let index = 0;
                  const advance = () => {
                    const value = existingChanges[index++];
                    request.result = value
                      ? { value: structuredClone(value), continue: advance }
                      : null;
                    request.onsuccess?.();
                  };
                  advance();
                });
                return request;
              } }; }
            };
          }
        };
        return transaction;
      }
    };
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: { open() {
        const request = { result: database };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      } }
    });
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.appendChange(incomingChange),
      /Conflicto de secuencia o revisión/
    );
    assert.equal(additions, 0);
  }
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: { bound: (...bounds) => bounds }
  });
  try {
    await runCase([], {
      projectId: "journal-ranges", documentId: "chapter",
      sequence: 1, baseRevision: 0, committedRevision: 1,
      start: 0, end: 4, replacement: "", committedAt: 2
    });
    await runCase([{
      projectId: "journal-ranges", documentId: "chapter",
      sequence: 1, baseRevision: 0, committedRevision: 1,
      start: 0, end: 4, replacement: "", committedAt: 2
    }], {
      projectId: "journal-ranges", documentId: "chapter",
      sequence: 2, baseRevision: 1, committedRevision: 2,
      start: 0, end: 0, replacement: "x", committedAt: 3
    });
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
    if (originalKeyRange) Object.defineProperty(globalThis, "IDBKeyRange", originalKeyRange);
    else delete globalThis.IDBKeyRange;
  }
});


test("la API rechaza entradas de biblioteca con metadatos o evidencias malformadas", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({
    projectId: "library-api-validation",
    projectName: "Libro validado",
    writerId: "writer-validated"
  });
  const entry = {
    writerId: "writer-validated",
    sourceProjectId: "library-api-validation",
    sourceProjectName: "Libro validado",
    category: "Libro validado",
    archivedAt: 10,
    idea: {
      projectId: "library-api-validation",
      id: "idea-1",
      text: "Una idea conservada",
      status: "IDEA",
      originDocumentId: "chapter",
      sourceProjectName: "Libro validado",
      evidence: [{
        documentId: "chapter", revision: 1, start: 0, end: 5,
        excerpt: "Una idea"
      }],
      statusHistory: [{ status: "IDEA", changedAt: 1, reason: "initial" }]
    }
  };
  store.loadPersonalIdeas = async () => [{
    ...structuredClone(entry),
    archivedAt: Number.NaN
  }];
  await assert.rejects(
    api.getPersonalIdeaLibrary(),
    /Violación de aislamiento/
  );
  store.loadPersonalIdeas = async () => [{
    ...structuredClone(entry),
    idea: {
      ...structuredClone(entry.idea),
      evidence: [{ ...entry.idea.evidence[0], end: -1 }]
    }
  }];
  await assert.rejects(
    api.getPersonalIdeaLibrary(),
    /Violación de aislamiento/
  );
  store.loadPersonalIdeas = async () => [structuredClone(entry)];
  const legacyLibrary = await api.getPersonalIdeaLibrary();
  assert.equal(legacyLibrary.length, 1);
  assert.equal(legacyLibrary[0].contextStatus, "missing-legacy-context");
  store.loadPersonalIdeas = async () => [{
    ...structuredClone(entry),
    idea: {
      ...structuredClone(entry.idea),
      statusHistory: [{ status: "incorporated", changedAt: 2, reason: "initial" }]
    }
  }];
  await assert.rejects(
    api.getPersonalIdeaLibrary(),
    /Violación de aislamiento/
  );

  store.loadPersonalIdeas = async () => [{
    ...structuredClone(entry),
    idea: {
      ...structuredClone(entry.idea),
      relatedIdeaIds: Array.from({ length: 501 }, (_, index) => "root-related-" + index)
    }
  }];
  await assert.rejects(
    api.getPersonalIdeaLibrary(),
    /Violación de aislamiento/
  );

  store.loadPersonalIdeas = async () => [{
    ...structuredClone(entry),
    idea: {
      ...structuredClone(entry.idea),
      statusHistory: [
        { status: "IDEA", reason: "initial", changedAt: 1 },
        { status: "IDEA", reason: "writer", changedAt: 2 }
      ]
    }
  }];
  await assert.rejects(
    api.getPersonalIdeaLibrary(),
    /Violación de aislamiento/
  );

  store.loadPersonalIdeas = async () => [{
    ...structuredClone(entry),
    context: {
      version: 1,
      relatedIdeas: [{
        projectId: "library-api-validation",
        id: "invalid-text-revision",
        text: "Idea incorporada",
        status: "discarded",
        originDocumentId: "chapter",
        sourceProjectName: "Libro validado",
        evidence: [],
        statusHistory: [
          { status: "incorporated", reason: "initial", changedAt: 1 },
          { status: "discarded", reason: "text-revised", changedAt: 2 }
        ]
      }],
      relatedEntities: []
    }
  }];
  await assert.rejects(
    api.getPersonalIdeaLibrary(),
    /Violación de aislamiento/
  );

  const contextTargets = Array.from({ length: 501 }, (_, index) => ({
    projectId: "library-api-validation",
    id: "context-target-" + index,
    text: "Idea contextual " + index,
    status: "discarded",
    originDocumentId: "chapter",
    sourceProjectName: "Libro validado",
    evidence: []
  }));
  const contextSource = {
    projectId: "library-api-validation",
    id: "context-source",
    text: "Idea contextual con muchos vínculos",
    status: "incorporated",
    originDocumentId: "chapter",
    sourceProjectName: "Libro validado",
    evidence: [],
    relatedIdeaIds: contextTargets.map(target => target.id)
  };
  store.loadPersonalIdeas = async () => [{
    ...structuredClone(entry),
    idea: { ...structuredClone(entry.idea), relatedIdeaIds: [] },
    context: {
      version: 1,
      relatedIdeas: [contextSource, ...contextTargets],
      relatedEntities: []
    }
  }];
  await assert.rejects(
    api.getPersonalIdeaLibrary(),
    /Violación de aislamiento/
  );
});

test("la API rechaza entradas de biblioteca con enlaces sin instantánea contextual", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({
    projectId: "library-missing-context",
    projectName: "Libro con contexto incompleto",
    writerId: "writer-context"
  });
  const entry = {
    writerId: "writer-context",
    sourceProjectId: "library-missing-context",
    sourceProjectName: "Libro con contexto incompleto",
    category: "Libro con contexto incompleto",
    archivedAt: 10,
    idea: {
      projectId: "library-missing-context",
      id: "archived-idea",
      text: "Idea archivada",
      status: "IDEA",
      originDocumentId: "chapter",
      sourceProjectName: "Libro con contexto incompleto",
      evidence: [],
      relatedIdeaIds: ["missing-related-idea"]
    },
    context: { version: 1, relatedIdeas: [], relatedEntities: [] }
  };
  store.loadPersonalIdeas = async () => [structuredClone(entry)];
  await assert.rejects(
    api.getPersonalIdeaLibrary(),
    /referencias sin contexto resoluble/
  );
});

test("la API rechaza transferencias de archivo con procedencia narrativa inconsistente", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({
    projectId: "archive-api-validation",
    projectName: "Libro de origen",
    writerId: "writer-archive"
  });
  store.archiveUnincorporatedIdeas = async () => [{
    writerId: "writer-archive",
    sourceProjectId: "archive-api-validation",
    sourceProjectName: "Libro de origen",
    category: "Libro de origen",
    archivedAt: 10,
    idea: {
      projectId: "archive-api-validation",
      id: "idea-invalid",
      text: "Idea privada",
      status: "IDEA",
      originDocumentId: "chapter",
      sourceProjectName: "Otro libro",
      evidence: []
    }
  }];
  await assert.rejects(
    api.archiveUnincorporatedIdeas(),
    /Violación de aislamiento/
  );
});


test("IndexedDB rechaza ideas malformadas tanto al guardar como al recuperar", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const malformed = { projectId: "idea-integrity", id: "idea-1" };
  let storedIdea = malformed;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      const transaction = {
        error: null,
        objectStore() {
          return { index() { return { getAll() {
            const request = {};
            queueMicrotask(() => {
              request.result = [structuredClone(storedIdea)];
              request.onsuccess?.();
              queueMicrotask(() => transaction.oncomplete?.());
            });
            return request;
          } }; } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.saveIdea(malformed),
      /faltan datos narrativos obligatorios/
    );
    await assert.rejects(
      store.loadIdeas("idea-integrity"),
      /faltan datos narrativos obligatorios/
    );
    const historyMismatch = {
      projectId: "idea-integrity", id: "idea-history",
      text: "Idea", status: "IDEA", originDocumentId: "chapter",
      sourceProjectName: "Libro", evidence: [],
      statusHistory: [{ status: "incorporated", reason: "initial" }]
    };
    await assert.rejects(
      store.saveIdea(historyMismatch),
      /historial no coincide con el estado actual/
    );
    storedIdea = historyMismatch;
    await assert.rejects(
      store.loadIdeas("idea-integrity"),
      /historial no coincide con el estado actual/
    );
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB compacta solo deltas cubiertos por el snapshot exacto y conserva los posteriores", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const originalKeyRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  const snapshot = {
    projectId: "compact-exact", documentId: "chapter",
    text: "texto", revision: 2, sequence: 2, updatedAt: 10
  };
  const initialChanges = [1, 2, 3].map(sequence => ({
    projectId: "compact-exact", documentId: "chapter", sequence,
    baseRevision: sequence - 1, committedRevision: sequence,
    start: 0, end: 0, replacement: String(sequence), committedAt: sequence
  }));
  async function run(snapshotRecord, shouldSucceed) {
    const changes = structuredClone(initialChanges);
    const database = {
      onversionchange: null,
      close() {},
      transaction() {
        let pending = 0;
        let finished = false;
        const tx = {
          error: null,
          abort() {
            if (finished) return;
            finished = true;
            queueMicrotask(() => tx.onabort?.());
          },
          objectStore(name) {
            if (name === "documents") return {
              get() {
                pending++;
                const request = {};
                queueMicrotask(() => {
                  request.result = structuredClone(snapshotRecord);
                  request.onsuccess?.();
                  pending--;
                  completeIfReady();
                });
                return request;
              }
            };
            return {
              index() {
                return { openCursor(bounds) {
                  pending++;
                  const request = {};
                  const [lower, upper] = bounds;
                  const selected = changes.filter(item =>
                    item.projectId === lower[0] && item.documentId === lower[1] &&
                    item.sequence >= lower[2] && item.sequence <= upper[2]
                  );
                  let position = 0;
                  const dispatch = () => queueMicrotask(() => {
                    const entry = selected[position++];
                    if (!entry) {
                      request.result = null;
                      request.onsuccess?.();
                      pending--;
                      completeIfReady();
                      return;
                    }
                    request.result = {
                      value: entry,
                      delete() {
                        const index = changes.findIndex(item => item.sequence === entry.sequence);
                        if (index >= 0) changes.splice(index, 1);
                      },
                      continue: dispatch
                    };
                    request.onsuccess?.();
                  });
                  dispatch();
                  return request;
                } };
              }
            };
          }
        };
        function completeIfReady() {
          if (finished || pending !== 0) return;
          finished = true;
          queueMicrotask(() => tx.oncomplete?.());
        }
        return tx;
      }
    };
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: { open() {
        const request = { result: database };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      } }
    });
    const store = new IndexedDbProjectStore();
    if (shouldSucceed) {
      await store.compactChanges("compact-exact", "chapter", 2);
      assert.deepEqual(changes.map(item => item.sequence), [3]);
    } else {
      await assert.rejects(
        store.compactChanges("compact-exact", "chapter", 2),
        /Compactación rechazada/
      );
      assert.deepEqual(changes.map(item => item.sequence), [1, 2, 3]);
    }
  }
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: { bound: (lower, upper) => [lower, upper] }
  });
  try {
    await run(snapshot, true);
    await run({ ...snapshot, sequence: 3 }, false);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
    if (originalKeyRange) Object.defineProperty(globalThis, "IDBKeyRange", originalKeyRange);
    else delete globalThis.IDBKeyRange;
  }
});


test("IndexedDB impide guardar relaciones, acontecimientos y afirmaciones con entidades inexistentes", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const records = [];
  let entities = [{ projectId: "reference-integrity", id: "ana", kind: "character",
    canonicalName: "Ana", normalizedName: "ana", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1 }];
  function installDatabase() {
    const database = {
      onversionchange: null,
      close() {},
      transaction() {
        let finished = false;
        const tx = {
          error: null,
          abort() {
            if (finished) return;
            finished = true;
            queueMicrotask(() => tx.onabort?.());
          },
          objectStore(name) {
            if (name === "narrative-entities") return {
              index() { return { getAll() {
                const request = {};
                queueMicrotask(() => {
                  request.result = structuredClone(entities);
                  request.onsuccess?.();
                  if (!finished) {
                    finished = true;
                    queueMicrotask(() => tx.oncomplete?.());
                  }
                });
                return request;
              } }; }
            };
            return { put(record) { records.push({ store: name, record: structuredClone(record) }); } };
          }
        };
        return tx;
      }
    };
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: { open() {
        const request = { result: database };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      } }
    });
  }
  try {
    installDatabase();
    const store = new IndexedDbProjectStore();
    await store.saveRelation({ projectId: "reference-integrity", id: "r1", fromEntityId: "ana",
      toEntityId: "ana", relationType: "ally", evidence: [] });
    entities = [{ ...entities[0], normalizedName: "nombre-inconsistente" }];
    await assert.rejects(store.saveRelation({ projectId: "reference-integrity", id: "r-corrupt",
      fromEntityId: "ana", toEntityId: "ana", relationType: "ally", evidence: [] }),
      /una o más entidades no existen/);
    entities = [{ projectId: "reference-integrity", id: "ana", kind: "character",
      canonicalName: "Ana", normalizedName: "ana", aliases: [], evidence: [],
      firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1 }];
    await assert.rejects(store.saveRelation({ projectId: "reference-integrity", id: "r2",
      fromEntityId: "ana", toEntityId: "missing", relationType: "ally", evidence: [] }),
      /una o más entidades no existen/);
    await assert.rejects(store.saveEvent({ projectId: "reference-integrity", id: "e1",
      label: "Encuentro", participants: ["missing"], evidence: [] }),
      /una o más entidades no existen/);
    await assert.rejects(store.saveAssertion({ projectId: "reference-integrity", id: "a1",
      entityId: "missing", entityName: "Desconocida", attribute: "role", value: "guardia",
      evidence: { documentId: "chapter", revision: 0, start: 0, end: 1, excerpt: "x" }, capturedAt: 1 }),
      /una o más entidades no existen/);
    assert.deepEqual(records.map(item => item.store), ["narrative-relations"]);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("la API no expone relaciones, acontecimientos ni afirmaciones con referencias huérfanas", async () => {
  const store = new MemoryStore();
  store.relations.set("legacy:r", {
    projectId: "legacy", id: "r", fromEntityId: "missing-a",
    toEntityId: "missing-b", relationType: "ally", evidence: []
  });
  store.events.set("legacy:e", {
    projectId: "legacy", id: "e", label: "Encuentro",
    participants: ["missing-a"], evidence: []
  });
  store.assertions.set("legacy:a", {
    projectId: "legacy", id: "a", entityId: "missing-a",
    entityName: "Entidad antigua", attribute: "role", value: "guardia",
    evidence: { documentId: "chapter", revision: 0, start: 0, end: 1, excerpt: "x" },
    capturedAt: 1
  });
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "legacy", projectName: "Libro heredado" });

  await assert.rejects(api.getNarrativeRelations(), /referencias a entidades inexistentes/);
  store.relations.clear();
  assert.deepEqual(await api.getNarrativeRelations(), []);

  await assert.rejects(api.getNarrativeEvents(), /referencias a entidades inexistentes/);
  store.events.clear();
  assert.deepEqual(await api.getNarrativeEvents(), []);

  await assert.rejects(api.getNarrativeAssertions(), /referencias a entidades inexistentes/);
  store.assertions.clear();
  assert.deepEqual(await api.getNarrativeAssertions(), []);
});


test("la API rechaza IDs narrativos duplicados sin contaminar la caché", async () => {
  const store = new MemoryStore();
  store.loadEntities = async () => [
    {
    projectId: "duplicate-ids", id: "same", kind: "character",
    canonicalName: "Ana", normalizedName: "ana", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  },
    {
    projectId: "duplicate-ids", id: "same", kind: "character",
    canonicalName: "Ana", normalizedName: "ana", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  }
  ];
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "duplicate-ids", projectName: "Libro" });

  await assert.rejects(api.getNarrativeEntities(), /identificador vacío o duplicado/);
  store.loadEntities = async () => [];
  assert.deepEqual(await api.getNarrativeEntities(), []);
});


test("la API rechaza entradas duplicadas en la biblioteca personal del escritor", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({
    projectId: "library-duplicate-ids",
    projectName: "Libro",
    writerId: "writer-library"
  });
  const entry = {
    writerId: "writer-library",
    sourceProjectId: "library-duplicate-ids",
    sourceProjectName: "Libro",
    category: "Libro",
    archivedAt: 10,
    idea: {
      projectId: "library-duplicate-ids",
      id: "idea-same",
      text: "Idea conservada",
      status: "IDEA",
      originDocumentId: "chapter",
      sourceProjectName: "Libro",
      evidence: [],
      statusHistory: [{ status: "IDEA", changedAt: 1, reason: "initial" }]
    }
  };
  store.loadPersonalIdeas = async () => [
    structuredClone(entry),
    { ...structuredClone(entry), archivedAt: 11 }
  ];
  await assert.rejects(
    api.getPersonalIdeaLibrary(),
    /ideas archivadas duplicadas/
  );
  store.loadPersonalIdeas = async () => [structuredClone(entry)];
  assert.equal((await api.getPersonalIdeaLibrary()).length, 1);

  const entityBase = {
    projectId: "library-duplicate-ids", kind: "character", aliases: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1, evidence: [],
    mergedFromIds: ["legacy-entity"]
  };
  store.loadPersonalIdeas = async () => [{
    ...structuredClone(entry),
    context: {
      version: 1,
      relatedIdeas: [],
      relatedEntities: [
        { ...entityBase, id: "entity-a", canonicalName: "Ana", normalizedName: "ana" },
        { ...entityBase, id: "entity-b", canonicalName: "Anita", normalizedName: "anita" }
      ]
    }
  }];
  await assert.rejects(
    api.getPersonalIdeaLibrary(),
    /Violación de aislamiento/
  );
});

test("IndexedDB rechaza IDs históricos ambiguos entre entidades del contexto archivado", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const projectId = "library-history-collision";
  const entry = {
    writerId: "writer-a", sourceProjectId: projectId, sourceProjectName: "Libro",
    category: "Libro", archivedAt: 10,
    idea: {
      projectId, id: "idea-1", text: "Idea archivada", status: "IDEA",
      originDocumentId: "chapter", sourceProjectName: "Libro", evidence: []
    },
    context: {
      version: 1, relatedIdeas: [],
      relatedEntities: [
        {
          projectId, id: "entity-a", kind: "character", canonicalName: "Ana",
          normalizedName: "ana", aliases: [], mergedFromIds: ["legacy-id"],
          evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
        },
        {
          projectId, id: "entity-b", kind: "character", canonicalName: "Anita",
          normalizedName: "anita", aliases: [], mergedFromIds: ["legacy-id"],
          evidence: [], firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
        }
      ]
    }
  };
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore() {
          return { index() {
            return { getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = [structuredClone(entry)];
                request.onsuccess?.();
                queueMicrotask(() => transaction.oncomplete?.());
              });
              return request;
            } };
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.loadPersonalIdeas("writer-a"),
      /Biblioteca personal inconsistente/
    );
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("dos instancias concurrentes archivan sin duplicar el mismo libro ni colisionar entre libros", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const writerId = "writer-concurrent-archive";
  const projectIdeas = new Map([
    ["book-a", [{
      projectId: "book-a", id: "shared-idea", text: "Idea del libro A",
      status: "IDEA", originDocumentId: "chapter-a",
      sourceProjectName: "Libro A", evidence: []
    }]],
    ["book-b", [{
      projectId: "book-b", id: "shared-idea", text: "Idea del libro B",
      status: "IDEA", originDocumentId: "chapter-b",
      sourceProjectName: "Libro B", evidence: []
    }]]
  ]);
  const library = new Map();
  const transactionQueue = [];
  let writeTransactionActive = false;

  const finishTransaction = transaction => {
    transaction.oncomplete?.();
    writeTransactionActive = false;
    queueMicrotask(startNextTransaction);
  };
  const startNextTransaction = () => {
    if (writeTransactionActive || transactionQueue.length === 0) return;
    writeTransactionActive = true;
    const transaction = transactionQueue.shift();
    transaction.start();
  };
  const database = {
    onversionchange: null,
    close() {},
    transaction(storeNames, mode) {
      assert.equal(mode, "readwrite");
      assert.deepEqual(new Set(storeNames), new Set([
        "narrative-ideas", "personal-idea-library", "narrative-entities",
        "writer-library-finalization-receipts"
      ]));
      let started = false;
      const pendingRequests = [];
      const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        aborted: false,
        start() {
          started = true;
          for (const request of pendingRequests.splice(0)) queueMicrotask(request);
        },
        enqueueRequest(request) {
          if (started) queueMicrotask(request);
          else pendingRequests.push(request);
        },
        abort() {
          if (transaction.aborted) return;
          transaction.aborted = true;
          transaction.error = new Error("simulated_transaction_abort");
          queueMicrotask(() => {
            transaction.onabort?.();
            writeTransactionActive = false;
            queueMicrotask(startNextTransaction);
          });
        },
        objectStore(name) {
          return {
            index(indexName) {
              assert.equal(indexName, "by-project");
              return {
                getAll(projectId) {
                  const request = {};
                  transaction.enqueueRequest(() => {
                    if (transaction.aborted) return;
                    request.result = structuredClone(projectIdeas.get(projectId) ?? []);
                    request.onsuccess?.();
                    queueMicrotask(() => {
                      if (!transaction.aborted) finishTransaction(transaction);
                    });
                  });
                  return request;
                }
              };
            },
            add(entry) {
              const key = JSON.stringify([entry.writerId, entry.sourceProjectId, entry.idea.id]);
              if (library.has(key)) {
                transaction.error = new Error("ConstraintError");
                transaction.abort();
                return;
              }
              library.set(key, structuredClone(entry));
            },
            delete(key) {
              const [projectId, ideaId] = key;
              projectIdeas.set(
                projectId,
                (projectIdeas.get(projectId) ?? []).filter(idea => idea.id !== ideaId)
              );
            }
          };
        }
      };
      transactionQueue.push(transaction);
      queueMicrotask(startNextTransaction);
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });

  try {
    const firstInstance = new IndexedDbProjectStore();
    const secondInstance = new IndexedDbProjectStore();
    const [firstArchive, duplicateArchive, secondBookArchive] = await Promise.all([
      firstInstance.archiveUnincorporatedIdeas("book-a", writerId, "Libro A", 10),
      secondInstance.archiveUnincorporatedIdeas("book-a", writerId, "Libro A", 11),
      secondInstance.archiveUnincorporatedIdeas("book-b", writerId, "Libro B", 12)
    ]);

    assert.equal(firstArchive.length + duplicateArchive.length, 1,
      "dos instancias no deben archivar dos veces la misma idea del mismo libro");
    assert.equal(secondBookArchive.length, 1,
      "el mismo ID de idea debe poder archivarse en otro libro");
    assert.equal(library.size, 2);
    assert.deepEqual(
      [...library.values()].map(entry => [
        entry.writerId, entry.sourceProjectId, entry.idea.id, entry.idea.text
      ]),
      [
        [writerId, "book-a", "shared-idea", "Idea del libro A"],
        [writerId, "book-b", "shared-idea", "Idea del libro B"]
      ]
    );
    assert.equal(projectIdeas.get("book-a").length, 0);
    assert.equal(projectIdeas.get("book-b").length, 0);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB permite el mismo ID de idea en dos libros del mismo escritor", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const writerId = "writer-multi-book";
  const entryFor = (projectId, sourceProjectName) => ({
    writerId,
    sourceProjectId: projectId,
    sourceProjectName,
    category: sourceProjectName,
    archivedAt: 10,
    idea: {
      projectId, id: "shared-idea-id", text: "Idea archivada",
      status: "IDEA", originDocumentId: "chapter-1",
      sourceProjectName, evidence: [],
      statusHistory: [{ status: "IDEA", changedAt: 1, reason: "initial" }]
    }
  });
  const entries = [
    entryFor("book-a", "Libro A"),
    entryFor("book-b", "Libro B")
  ];
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore() {
          return { index(indexName) {
            assert.equal(indexName, "by-writer");
            return { getAll(key) {
              assert.equal(key, writerId);
              const request = {};
              queueMicrotask(() => {
                request.result = structuredClone(entries);
                request.onsuccess?.();
                queueMicrotask(() => transaction.oncomplete?.());
              });
              return request;
            } };
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    const library = await store.loadPersonalIdeas(writerId);
    assert.equal(library.length, 2);
    assert.deepEqual(
      library.map(entry => [entry.sourceProjectId, entry.idea.id]),
      [["book-a", "shared-idea-id"], ["book-b", "shared-idea-id"]]
    );
    assert.deepEqual(library.map(entry => entry.category), ["Libro A", "Libro B"]);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB rechaza IDs duplicados al recuperar la biblioteca personal", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const entry = {
    writerId: "writer-a",
    sourceProjectId: "book-a",
    sourceProjectName: "Libro A",
    category: "Libro A",
    archivedAt: 10,
    idea: {
      projectId: "book-a",
      id: "idea-duplicate",
      text: "Idea archivada",
      status: "IDEA",
      originDocumentId: "chapter-1",
      sourceProjectName: "Libro A",
      evidence: [],
      statusHistory: [{ status: "IDEA", changedAt: 1, reason: "initial" }]
    }
  };
  const entries = [structuredClone(entry), { ...structuredClone(entry), archivedAt: 11 }];
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore() {
          return { index() {
            return { getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = structuredClone(entries);
                request.onsuccess?.();
              });
              return request;
            } };
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    const pending = store.loadPersonalIdeas("writer-a");
    await new Promise(resolve => setTimeout(resolve, 0));
    transaction.oncomplete?.();
    await assert.rejects(pending, /ideas archivadas duplicadas/);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB rechaza una biblioteca personal que no sea una colección", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore() {
          return { index() {
            return { getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = { malformed: true };
                request.onsuccess?.();
              });
              return request;
            } };
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    const pending = store.loadPersonalIdeas("writer-a");
    await new Promise(resolve => setTimeout(resolve, 0));
    transaction.oncomplete?.();
    await assert.rejects(pending, /colección recuperada no es una lista/);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB rechaza ideas archivadas cuyo título de origen no coincide con la entrada", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const entries = [{
    writerId: "writer-a",
    sourceProjectId: "book-a",
    sourceProjectName: "Título de la entrada",
    category: "Título de la entrada",
    idea: {
      projectId: "book-a",
      id: "idea-1",
      text: "Idea archivada",
      status: "IDEA",
      originDocumentId: "chapter-1",
      sourceProjectName: "Título interno distinto",
      evidence: []
    },
    archivedAt: 10
  }];
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transaction = {
        error: null,
        objectStore() {
          return { index() {
            return { getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = structuredClone(entries);
                request.onsuccess?.();
              });
              return request;
            } };
          } };
        }
      };
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  try {
    const store = new IndexedDbProjectStore();
    const pending = store.loadPersonalIdeas("writer-a");
    await new Promise(resolve => setTimeout(resolve, 0));
    transaction.oncomplete?.();
    await assert.rejects(pending, /Biblioteca personal inconsistente/);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("la lectura iniciada antes del archivo también serializa la transferencia", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "library-read-before-archive", projectName: "Libro", writerId: "writer-a" });
  await store.saveIdea({
    projectId: "library-read-before-archive", id: "idea-1", text: "Idea pendiente", status: "IDEA",
    originDocumentId: "chapter", sourceProjectName: "Libro", evidence: []
  });
  let releaseRead;
  let markReadStarted;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const readStarted = new Promise(resolve => { markReadStarted = resolve; });
  const originalLoad = store.loadPersonalIdeas.bind(store);
  store.loadPersonalIdeas = async writerId => {
    markReadStarted();
    await readGate;
    return originalLoad(writerId);
  };
  const reading = api.getPersonalIdeaLibrary();
  await readStarted;
  let archiveStarted = false;
  const originalArchive = store.archiveUnincorporatedIdeas.bind(store);
  store.archiveUnincorporatedIdeas = async (...args) => {
    archiveStarted = true;
    return originalArchive(...args);
  };
  const archiving = api.archiveUnincorporatedIdeas();
  await Promise.resolve();
  assert.equal(archiveStarted, false);
  releaseRead();
  assert.equal((await reading).length, 0);
  assert.equal((await archiving).length, 1);
  assert.equal(archiveStarted, true);
});

test("la admisión rechaza offsets fuera del texto proyectado sin perder la secuencia", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "projected-offsets", projectName: "Offsets proyectados" });
  await api.openDocument({ documentId: "chapter", text: "abcdef", revision: 0, sequence: 0 });

  for (const malformed of [
    { sequence: Symbol("sequence"), baseRevision: 0, start: 0, end: 0 },
    { sequence: 1, baseRevision: 0, start: Symbol("start"), end: 0 },
    { sequence: 1, baseRevision: 0, start: 0, end: 1.5 }
  ]) {
    const admission = api.onEditorChange({
      documentId: "chapter", ...malformed, replacement: "x"
    });
    assert.deepEqual(admission, { status: "rejected", reason: "invalid_change" });
    assert.equal(api.getDocumentSyncState("chapter")?.pendingSequence, 0);
  }

  assert.deepEqual(api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 7, end: 7, replacement: "x"
  }), { status: "rejected", reason: "invalid_change" });
  assert.equal(api.getDocumentSyncState("chapter")?.pendingSequence, 0);

  const shrink = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 2, end: 6, replacement: ""
  });
  const appendAtProjectedEnd = api.onEditorChange({
    documentId: "chapter", sequence: 2, baseRevision: 1,
    start: 2, end: 2, replacement: "XY"
  });
  assert.equal(shrink.status, "queued");
  assert.equal(appendAtProjectedEnd.status, "queued");
  assert.deepEqual(api.onEditorChange({
    documentId: "chapter", sequence: 3, baseRevision: 2,
    start: 5, end: 5, replacement: "!"
  }), { status: "rejected", reason: "invalid_change" });

  await api.flushPendingChanges();
  assert.equal(api.getSnapshot("chapter")?.text, "abXY");
  assert.equal(api.getDocumentSyncState("chapter")?.needsResync, false);
  assert.equal(api.getLiveAnalysisMetrics().invalidChangeRejections, 5);
});

test("las consultas narrativas ocupan la cola y no se solapan con escrituras posteriores", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "serialized-knowledge-read", projectName: "Lectura serializada" });

  let releaseRead;
  let markReadStarted;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const readStarted = new Promise(resolve => { markReadStarted = resolve; });
  const originalLoadEntities = store.loadEntities.bind(store);
  let loadCalls = 0;
  store.loadEntities = async projectId => {
    loadCalls++;
    if (loadCalls === 1) {
      markReadStarted();
      await readGate;
    }
    return originalLoadEntities(projectId);
  };

  try {
    const reading = api.getNarrativeEntities();
    await readStarted;
    const extraction = api.extractNarrativeKnowledge(
      "chapter", 1, "El personaje Valeria llegó."
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(loadCalls, 1,
      "la extracción debe esperar a que termine la consulta que ya ocupó la cola");

    releaseRead();
    assert.deepEqual(await reading, []);
    await extraction;
    const entities = await api.getNarrativeEntities();
    assert.ok(entities.some(entity => entity.canonicalName === "Valeria"));
    assert.equal(loadCalls, 1);
  } finally {
    releaseRead();
  }
});

test("la asignación manual de alias espera las consultas narrativas en curso", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "serialized-alias", projectName: "Alias serializado" });
  await store.saveEntity({
    projectId: "serialized-alias", id: "ana", kind: "character",
    canonicalName: "Ana", normalizedName: "ana", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  });

  let releaseRead;
  let markReadStarted;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const readStarted = new Promise(resolve => { markReadStarted = resolve; });
  const originalLoadEntities = store.loadEntities.bind(store);
  let loadCalls = 0;
  store.loadEntities = async projectId => {
    loadCalls++;
    if (loadCalls === 1) {
      markReadStarted();
      await readGate;
    }
    return originalLoadEntities(projectId);
  };

  try {
    const reading = api.getNarrativeEntities();
    await readStarted;
    const aliasing = api.addNarrativeEntityAlias("ana", "La viajera");
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(loadCalls, 1,
      "la escritura manual debe esperar a que termine la lectura ya encolada");

    releaseRead();
    assert.equal((await reading)[0].aliases.length, 0);
    const updated = await aliasing;
    assert.deepEqual(updated.aliases, ["La viajera"]);
    assert.equal(loadCalls, 1);
  } finally {
    releaseRead();
  }
});

test("las consultas narrativas devuelven copias aisladas de sus cachés", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({ projectId: "defensive-narrative-reads", projectName: "Lecturas defensivas" });
  await api.extractNarrativeKnowledge("chapter-1", 0, "El personaje Mara llegó a Buenos Aires.");
  const first = await api.getNarrativeEntities();
  assert.ok(first.length > 0);
  const baseline = structuredClone(first);
  const mara = first.find(entity => entity.canonicalName === "Mara") ?? first[0];
  mara.aliases.push("Alias contaminante");
  mara.evidence[0].excerpt = "Texto alterado desde el anfitrión";
  assert.deepEqual(await api.getNarrativeEntities(), baseline);

  const extracted = await api.extractNarrativeKnowledge(
    "chapter-1", 1, "El personaje Mara llegó a Buenos Aires otra vez."
  );
  extracted[0].aliases.push("Alias desde extracción");
  extracted[0].evidence[0].excerpt = "Evidencia manipulada";
  assert.ok(!(await api.getNarrativeEntities()).some(entity =>
    entity.aliases.includes("Alias desde extracción") ||
    entity.evidence.some(item => item.excerpt === "Evidencia manipulada")
  ));

  const aliasResult = await api.addNarrativeEntityAlias(mara.id, "La viajera");
  aliasResult.aliases.push("Alias desde respuesta");
  assert.deepEqual(
    (await api.getNarrativeEntities()).find(entity => entity.id === mara.id).aliases,
    ["La viajera"]
  );
});


test("IndexedDB no permite inaugurar un journal sin snapshot durable", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const originalKeyRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  let additions = 0;
  let transaction;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      let finished = false;
      transaction = {
        error: null,
        objectStore(name) {
          if (name === "documents") return {
            get() {
              const request = {};
              queueMicrotask(() => {
                request.result = undefined;
                request.onsuccess?.();
              });
              return request;
            }
          };
          return {
            add() { additions++; },
            index() {
              return { openCursor() {
                const request = {};
                queueMicrotask(() => {
                  request.result = null;
                  request.onsuccess?.();
                });
                return request;
              } };
            }
          };
        },
        abort() {
          if (finished) return;
          finished = true;
          queueMicrotask(() => transaction.onabort?.());
        }
      };
      const complete = () => {
        if (finished) return;
        finished = true;
        queueMicrotask(() => transaction.oncomplete?.());
      };
      transaction.complete = complete;
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: { bound: (...bounds) => bounds }
  });

  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.appendChange({
        projectId: "orphan-journal",
        documentId: "chapter",
        sequence: 1,
        baseRevision: 0,
        committedRevision: 1,
        start: 0,
        end: 0,
        replacement: "texto",
        committedAt: 1
      }),
      /Conflicto de secuencia o revisión/
    );
    assert.equal(additions, 0);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
    if (originalKeyRange) Object.defineProperty(globalThis, "IDBKeyRange", originalKeyRange);
    else delete globalThis.IDBKeyRange;
  }
});


test("el historial de una entidad devuelve copias aisladas de la caché", async () => {
  const store = new MemoryStore();
  const entity = {
    projectId: "defensive-assertion-history", id: "ana", kind: "character",
    canonicalName: "Ana", normalizedName: "ana", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  };
  const assertion = {
    projectId: "defensive-assertion-history", id: "assertion-ana-age",
    entityId: "ana", entityName: "Ana", attribute: "age", value: 31,
    evidence: {
      documentId: "chapter-1", revision: 1, start: 0, end: 18,
      excerpt: "Ana tiene 31 años."
    },
    capturedAt: 10
  };
  await store.saveEntity(entity);
  await store.saveAssertion(assertion);
  const api = new HostEngineApi({ store });
  api.initializeProject({
    projectId: "defensive-assertion-history",
    projectName: "Historial aislado"
  });

  const first = await api.getNarrativeEntityHistory("ana");
  assert.equal(first.length, 1);
  first[0].value = 99;
  first[0].evidence.excerpt = "Texto alterado por el anfitrión";

  assert.deepEqual(await api.getNarrativeEntityHistory("ana"), [assertion]);
});


test("la extracción de ubicaciones no absorbe la siguiente oración coordinada", async () => {
  const { extractNarrativeAssertions } = await import("../dist/motor-literario.js");
  const entities = [{
    projectId: "location-clause-boundary", id: "ana", kind: "character",
    canonicalName: "Ana", normalizedName: "ana", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  }];
  const assertions = extractNarrativeAssertions(
    "location-clause-boundary", "chapter", 1,
    "Ana vive en París y trabaja en el puerto.", entities
  );
  assert.equal(assertions.length, 1);
  assert.equal(assertions[0].attribute, "location");
  assert.equal(assertions[0].value, "París");
});


test("cada afirmación toma la referencia temporal más cercana de su propia cláusula", async () => {
  const { extractNarrativeAssertions } = await import("../dist/motor-literario.js");
  const entities = [{
    projectId: "assertion-nearest-date", id: "ana", kind: "character",
    canonicalName: "Ana", normalizedName: "ana", aliases: [], evidence: [],
    firstSeenAt: 1, lastSeenAt: 1, extractionVersion: 1
  }];
  const assertions = extractNarrativeAssertions(
    "assertion-nearest-date", "chapter", 1,
    "En el año 2020 Ana tenía 18 años; en el año 2021 Ana tiene 19 años.", entities
  );
  assert.equal(assertions.length, 2);
  assert.deepEqual(assertions.map(item => item.value), [18, 19]);
  assert.deepEqual(assertions.map(item => item.timeReference?.raw), ["año 2020", "año 2021"]);
});


test("la recuperación prefiere una vista atómica de snapshot y journal", async () => {
  class AtomicRecoveryStore extends MemoryStore {
    async loadDocument() {
      throw new Error("no debe realizar una lectura separada del snapshot");
    }
    async loadChanges() {
      throw new Error("no debe realizar una lectura separada del journal");
    }
    async loadDocumentWithChanges(projectId, documentId) {
      return {
        document: {
          projectId, documentId, text: "A", revision: 0, sequence: 0, updatedAt: 1
        },
        changes: [{
          projectId, documentId, sequence: 1, baseRevision: 0,
          committedRevision: 1, start: 1, end: 1,
          replacement: "B", committedAt: 2
        }]
      };
    }
    async saveDocumentAndCompactChanges(document) {
      await MemoryStore.prototype.saveDocument.call(this, document);
    }
  }

  const store = new AtomicRecoveryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "atomic-recovery", projectName: "Recuperación atómica" });
  await api.openDocument({ documentId: "chapter", text: "A", revision: 0, sequence: 0 });
  assert.equal(api.getSnapshot("chapter")?.text, "AB");
  assert.equal(api.getSnapshot("chapter")?.revision, 1);
  assert.equal(api.getSnapshot("chapter")?.sequence, 1);
});


test("IndexedDB lee snapshot y journal con una sola transacción readonly", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const originalKeyRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  const transactions = [];
  const snapshot = {
    projectId: "atomic-indexeddb", documentId: "chapter",
    text: "base", revision: 4, sequence: 9, updatedAt: 10
  };
  const journal = [{
    projectId: "atomic-indexeddb", documentId: "chapter",
    sequence: 10, baseRevision: 4, committedRevision: 5,
    start: 4, end: 4, replacement: "!", committedAt: 11
  }];
  const database = {
    onversionchange: null,
    close() {},
    transaction(names, mode) {
      const transaction = { names, mode, error: null, abort() {} };
      transactions.push(transaction);
      transaction.objectStore = name => ({
        get() {
          const request = {};
          queueMicrotask(() => {
            request.result = snapshot;
            request.onsuccess?.();
          });
          return request;
        },
        index() {
          return {
            getAll(range) {
              transaction.range = range;
              const request = {};
              queueMicrotask(() => {
                request.result = journal;
                request.onsuccess?.();
                queueMicrotask(() => transaction.oncomplete?.());
              });
              return request;
            }
          };
        }
      });
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: { bound: (lower, upper) => ({ lower, upper }) }
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }
  });

  try {
    const store = new IndexedDbProjectStore();
    const recovery = await store.loadDocumentWithChanges("atomic-indexeddb", "chapter");
    assert.deepEqual(recovery.document, snapshot);
    assert.deepEqual(recovery.changes, journal);
    assert.equal(transactions.length, 1);
    assert.deepEqual(transactions[0].names, ["documents", "changes"]);
    assert.equal(transactions[0].mode, "readonly");
    assert.deepEqual(transactions[0].range.lower, ["atomic-indexeddb", "chapter", 10]);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
    if (originalKeyRange) Object.defineProperty(globalThis, "IDBKeyRange", originalKeyRange);
    else delete globalThis.IDBKeyRange;
  }
});


test("IndexedDB descarta la conexión tras versionchange y abre una conexión nueva", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let opens = 0;
  const databases = [];
  function makeDatabase() {
    const database = {
      onversionchange: null,
      closed: false,
      close() { this.closed = true; },
      transaction() {
        const transaction = {
          error: null,
          objectStore() {
            return {
              get() {
                const request = {};
                queueMicrotask(() => {
                  request.result = undefined;
                  request.onsuccess?.();
                  queueMicrotask(() => transaction.oncomplete?.());
                });
                return request;
              }
            };
          }
        };
        return transaction;
      }
    };
    databases.push(database);
    return database;
  }
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        opens++;
        const request = { result: makeDatabase() };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      }
    }
  });

  try {
    const store = new IndexedDbProjectStore();
    assert.equal(await store.loadDocument("version-change", "chapter"), undefined);
    assert.equal(opens, 1);
    const oldDatabase = databases[0];
    oldDatabase.onversionchange?.();
    assert.equal(oldDatabase.closed, true);

    assert.equal(await store.loadDocument("version-change", "chapter"), undefined);
    assert.equal(opens, 2);
    assert.notEqual(databases[1], oldDatabase);
  } finally {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB vuelve a abrir la base tras un cierre inesperado de conexión", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let opens = 0;
  const databases = [];
  function makeDatabase() {
    const database = {
      onversionchange: null,
      onclose: null,
      close() {},
      transaction() {
        const transaction = {
          error: null,
          objectStore() {
            return {
              get() {
                const request = {};
                queueMicrotask(() => {
                  request.result = undefined;
                  request.onsuccess?.();
                  queueMicrotask(() => transaction.oncomplete?.());
                });
                return request;
              }
            };
          }
        };
        return transaction;
      }
    };
    databases.push(database);
    return database;
  }
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        opens++;
        const request = { result: makeDatabase() };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      }
    }
  });

  try {
    const store = new IndexedDbProjectStore();
    assert.equal(await store.loadDocument("unexpected-close", "chapter"), undefined);
    assert.equal(opens, 1);
    databases[0].onclose?.(new Event("close"));

    assert.equal(await store.loadDocument("unexpected-close", "chapter"), undefined);
    assert.equal(opens, 2);
    assert.notEqual(databases[1], databases[0]);
  } finally {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else delete globalThis.indexedDB;
  }
});

test("la resincronización del anfitrión conserva deltas posteriores y los recupera en la siguiente apertura", async () => {
  class ResyncJournalStore extends MemoryStore {
    changes = [];
    async loadDocumentWithChanges(projectId, documentId) {
      return {
        document: await this.loadDocument(projectId, documentId),
        changes: structuredClone(this.changes.filter(item =>
          item.projectId === projectId && item.documentId === documentId
        ).sort((a, b) => a.sequence - b.sequence))
      };
    }
    async saveDocumentAndCompactChanges(document, throughSequence) {
      const current = await this.loadDocument(document.projectId, document.documentId);
      if (!current) throw new Error("falta snapshot base");
      let text = current.text;
      let revision = current.revision;
      let sequence = current.sequence;
      for (const change of this.changes.filter(item =>
        item.projectId === document.projectId &&
        item.documentId === document.documentId &&
        item.sequence <= throughSequence
      ).sort((a, b) => a.sequence - b.sequence)) {
        if (change.sequence !== sequence + 1 || change.baseRevision !== revision ||
            change.committedRevision !== revision + 1 ||
            change.start < 0 || change.end < change.start || change.end > text.length) {
          throw new Error("journal no verificable");
        }
        text = text.slice(0, change.start) + change.replacement + text.slice(change.end);
        revision = change.committedRevision;
        sequence = change.sequence;
      }
      if (sequence !== throughSequence || document.sequence !== sequence ||
          document.revision !== revision || document.text !== text) {
        throw new Error("checkpoint no coincide con los deltas confirmados");
      }
      await this.saveDocument(document);
      this.changes = this.changes.filter(item =>
        item.projectId !== document.projectId ||
        item.documentId !== document.documentId ||
        item.sequence > throughSequence
      );
    }
  }

  const store = new ResyncJournalStore();
  await store.saveDocument({
    projectId: "host-resync", documentId: "chapter",
    text: "A", revision: 0, sequence: 0, updatedAt: 1
  });
  store.changes = [
    { projectId: "host-resync", documentId: "chapter", sequence: 1,
      baseRevision: 0, committedRevision: 1, start: 1, end: 1,
      replacement: "B", committedAt: 2 },
    { projectId: "host-resync", documentId: "chapter", sequence: 2,
      baseRevision: 1, committedRevision: 2, start: 2, end: 2,
      replacement: "C", committedAt: 3 }
  ];

  const first = new HostEngineApi({ store });
  first.initializeProject({ projectId: "host-resync", projectName: "Resincronización" });
  await first.openDocument({ documentId: "chapter", text: "AB", revision: 1, sequence: 1 });
  assert.equal(first.getSnapshot("chapter")?.text, "AB");
  assert.equal(store.documents.get("host-resync:chapter")?.text, "AB");
  assert.deepEqual(store.changes.map(item => item.sequence), [2]);

  const reopened = new HostEngineApi({ store });
  reopened.initializeProject({ projectId: "host-resync", projectName: "Resincronización" });
  await reopened.openDocument({ documentId: "chapter", text: "AB", revision: 1, sequence: 1 });
  assert.equal(reopened.getSnapshot("chapter")?.text, "ABC");
  assert.equal(store.documents.get("host-resync:chapter")?.text, "ABC");
  assert.deepEqual(store.changes, []);
});



test("IndexedDB serializa escrituras concurrentes de dos conexiones y conserva un único delta ganador", {
  skip: typeof indexedDB === "undefined" || typeof IDBKeyRange === "undefined"
}, async () => {
  const databaseName = "motor-literario-local";
  const firstStore = new IndexedDbProjectStore();
  const secondStore = new IndexedDbProjectStore();
  const projectId = "real-idb-concurrent-write";
  const documentId = "chapter";
  const initial = {
    projectId, documentId, text: "Base.", revision: 0, sequence: 0, updatedAt: 1
  };
  const competingChange = {
    projectId, documentId, sequence: 1, baseRevision: 0, committedRevision: 1,
    start: 5, end: 5, replacement: " editado", committedAt: 2
  };

  try {
    await firstStore.saveDocument(initial);
    // Dos instancias independientes abren conexiones diferentes a la misma DB.
    const results = await Promise.allSettled([
      firstStore.appendChange(competingChange),
      secondStore.appendChange(competingChange)
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);

    const recovered = await secondStore.loadDocumentWithChanges(projectId, documentId);
    assert.deepEqual(recovered.document, initial);
    assert.equal(recovered.changes.length, 1);
    assert.equal(recovered.changes[0].sequence, 1);
    assert.equal(recovered.changes[0].replacement, " editado");
  } finally {
    // deleteDatabase dispara versionchange; el adaptador debe cerrar ambas
    // conexiones y permitir que la limpieza termine sin dejar handles abiertos.
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("No se pudo limpiar la base de prueba."));
      request.onblocked = () => reject(new Error("La limpieza quedó bloqueada por una conexión IndexedDB abierta."));
    });
  }
});


test("IndexedDB ordena una edición concurrente antes de compactar su checkpoint", {
  skip: typeof indexedDB === "undefined" || typeof IDBKeyRange === "undefined"
}, async () => {
  const firstStore = new IndexedDbProjectStore();
  const secondStore = new IndexedDbProjectStore();
  const projectId = "real-idb-append-checkpoint-race";
  const documentId = "chapter";
  const initial = {
    projectId, documentId, text: "Base.", revision: 0, sequence: 0, updatedAt: 1
  };
  const change = {
    projectId, documentId, sequence: 1, baseRevision: 0, committedRevision: 1,
    start: 5, end: 5, replacement: " editado", committedAt: 2
  };
  const checkpoint = {
    projectId, documentId, text: "Base. editado",
    revision: 1, sequence: 1, updatedAt: 3
  };

  try {
    await firstStore.saveDocument(initial);
    // Abrimos ambas conexiones antes de iniciar las dos transacciones rivales.
    await secondStore.loadDocumentWithChanges(projectId, documentId);
    const results = await Promise.allSettled([
      firstStore.appendChange(change),
      secondStore.saveDocumentAndCompactChanges(checkpoint, 1)
    ]);
    assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled"]);

    const recovered = await firstStore.loadDocumentWithChanges(projectId, documentId);
    assert.deepEqual(recovered.document, checkpoint);
    assert.deepEqual(recovered.changes, []);
  } finally {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("motor-literario-local");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("No se pudo limpiar la base de prueba."));
      request.onblocked = () => reject(new Error("La limpieza quedó bloqueada por una conexión IndexedDB abierta."));
    });
  }
});


test("IndexedDB mantiene una vista coherente al leer mientras otra conexión compacta", {
  skip: typeof indexedDB === "undefined" || typeof IDBKeyRange === "undefined"
}, async () => {
  const firstStore = new IndexedDbProjectStore();
  const secondStore = new IndexedDbProjectStore();
  const projectId = "real-idb-read-checkpoint-race";
  const documentId = "chapter";
  const initial = {
    projectId, documentId, text: "Base.", revision: 0, sequence: 0, updatedAt: 1
  };
  const change = {
    projectId, documentId, sequence: 1, baseRevision: 0, committedRevision: 1,
    start: 5, end: 5, replacement: " editado", committedAt: 2
  };
  const checkpoint = {
    projectId, documentId, text: "Base. editado",
    revision: 1, sequence: 1, updatedAt: 3
  };

  try {
    await firstStore.saveDocument(initial);
    await firstStore.appendChange(change);
    await secondStore.loadDocumentWithChanges(projectId, documentId);

    // La lectura readonly se inicia primero; el checkpoint queda serializado
    // detrás y no puede exponer un snapshot nuevo con un journal ya borrado
    // a una lectura que comenzó sobre el estado anterior.
    const reading = firstStore.loadDocumentWithChanges(projectId, documentId);
    const checkpointing = secondStore.saveDocumentAndCompactChanges(checkpoint, 1);
    const [recovered] = await Promise.all([reading, checkpointing]);

    assert.deepEqual(recovered.document, initial);
    assert.equal(recovered.changes.length, 1);
    assert.equal(recovered.changes[0].sequence, 1);
    const finalState = await secondStore.loadDocumentWithChanges(projectId, documentId);
    assert.deepEqual(finalState.document, checkpoint);
    assert.deepEqual(finalState.changes, []);
  } finally {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("motor-literario-local");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("No se pudo limpiar la base de prueba."));
      request.onblocked = () => reject(new Error("La limpieza quedó bloqueada por una conexión IndexedDB abierta."));
    });
  }
});

test("dos motores reales conservan una edición concurrente mientras uno resincroniza y compacta", {
  skip: typeof indexedDB === "undefined" || typeof IDBKeyRange === "undefined"
}, async () => {
  const databaseName = "motor-literario-local";
  const projectId = "two-real-engines-resync-race";
  const documentId = "chapter";
  const firstStore = new IndexedDbProjectStore();
  const secondStore = new IndexedDbProjectStore();
  const initial = {
    projectId, documentId, text: "A", revision: 0, sequence: 0, updatedAt: 1
  };
  let signalCheckpointStarted;
  let releaseCheckpoint;
  const checkpointStarted = new Promise(resolve => { signalCheckpointStarted = resolve; });
  const checkpointGate = new Promise(resolve => { releaseCheckpoint = resolve; });
  const originalCheckpoint = secondStore.saveDocumentAndCompactChanges.bind(secondStore);
  secondStore.saveDocumentAndCompactChanges = async (document, throughSequence) => {
    signalCheckpointStarted();
    await checkpointGate;
    return originalCheckpoint(document, throughSequence);
  };

  const firstEngine = new HostEngineApi({ store: firstStore });
  const secondEngine = new HostEngineApi({ store: secondStore });
  firstEngine.initializeProject({ projectId, projectName: "Concurrencia" });
  secondEngine.initializeProject({ projectId, projectName: "Concurrencia" });

  try {
    await firstStore.saveDocument(initial);
    const base = { documentId, text: "A", revision: 0, sequence: 0 };
    await firstEngine.openDocument(base);
    await secondEngine.openDocument(base);

    const firstAdmission = firstEngine.onEditorChange({
      documentId, sequence: 1, baseRevision: 0, start: 1, end: 1, replacement: "B"
    });
    assert.equal(firstAdmission.status, "queued");
    await firstEngine.flushPendingChanges();
    assert.equal(firstEngine.pollCommit(firstAdmission.ticketId)?.status, "applied");

    const authoritativeHostSnapshot = {
      documentId, text: "AB", revision: 1, sequence: 1
    };
    const resyncing = secondEngine.openDocument(authoritativeHostSnapshot);
    await checkpointStarted;

    const concurrentAdmission = firstEngine.onEditorChange({
      documentId, sequence: 2, baseRevision: 1, start: 2, end: 2, replacement: "C"
    });
    assert.equal(concurrentAdmission.status, "queued");
    await firstEngine.flushPendingChanges();
    assert.equal(firstEngine.pollCommit(concurrentAdmission.ticketId)?.status, "applied");

    releaseCheckpoint();
    await resyncing;

    const durableDuringRace = await secondStore.loadDocumentWithChanges(projectId, documentId);
    assert.equal(durableDuringRace.document?.text, "AB");
    assert.equal(durableDuringRace.document?.sequence, 1);
    assert.deepEqual(durableDuringRace.changes.map(change => change.sequence), [2]);
    assert.equal(firstEngine.getSnapshot(documentId)?.text, "ABC");
    assert.equal(secondEngine.getSnapshot(documentId)?.text, "AB");

    const reopenedEngine = new HostEngineApi({ store: secondStore });
    reopenedEngine.initializeProject({ projectId, projectName: "Concurrencia" });
    await reopenedEngine.openDocument(authoritativeHostSnapshot);
    assert.equal(reopenedEngine.getSnapshot(documentId)?.text, "ABC");
    assert.equal(reopenedEngine.getSnapshot(documentId)?.revision, 2);
    assert.equal(reopenedEngine.getSnapshot(documentId)?.sequence, 2);
    const finalState = await secondStore.loadDocumentWithChanges(projectId, documentId);
    assert.equal(finalState.document?.text, "ABC");
    assert.deepEqual(finalState.changes, []);
  } finally {
    releaseCheckpoint();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("No se pudo limpiar la base de prueba."));
      request.onblocked = () => reject(new Error("La limpieza quedó bloqueada por una conexión IndexedDB abierta."));
    });
  }
});

test("IndexedDB rechaza un snapshot divergente con la misma revisión si hay deltas posteriores", {
  skip: typeof indexedDB === "undefined" || typeof IDBKeyRange === "undefined"
}, async () => {
  const projectId = "real-idb-same-revision-divergence";
  const documentId = "chapter";
  const store = new IndexedDbProjectStore();
  const initial = {
    projectId, documentId, text: "A", revision: 0, sequence: 0, updatedAt: 1
  };
  const firstChange = {
    projectId, documentId, sequence: 1, baseRevision: 0, committedRevision: 1,
    start: 1, end: 1, replacement: "B", committedAt: 2
  };
  const laterChange = {
    projectId, documentId, sequence: 2, baseRevision: 1, committedRevision: 2,
    start: 2, end: 2, replacement: "C", committedAt: 3
  };
  const checkpoint = {
    projectId, documentId, text: "AB", revision: 1, sequence: 1, updatedAt: 4
  };
  const divergentSnapshot = {
    projectId, documentId, text: "AX", revision: 1, sequence: 1, updatedAt: 5
  };

  try {
    await store.saveDocument(initial);
    await store.appendChange(firstChange);
    await store.saveDocumentAndCompactChanges(checkpoint, 1);
    await store.appendChange(laterChange);

    await assert.rejects(
      store.saveDocumentAndCompactChanges(divergentSnapshot, 1),
      /Checkpoint obsoleto o inconsistente/
    );

    const preserved = await store.loadDocumentWithChanges(projectId, documentId);
    assert.deepEqual(preserved.document, checkpoint);
    assert.deepEqual(preserved.changes, [laterChange]);
  } finally {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("motor-literario-local");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("No se pudo limpiar la base de prueba."));
      request.onblocked = () => reject(new Error("La limpieza quedó bloqueada por una conexión IndexedDB abierta."));
    });
  }
});

test("un fallo de persistencia resuelve todos los tickets dependientes y permite recuperar el texto del anfitrión", async () => {
  class FailFirstJournalStore extends MemoryStore {
    attempts = 0;
    changes = [];
    async appendChange(change) {
      this.attempts++;
      if (this.attempts === 1) throw new Error("fallo_temporal_de_persistencia");
      this.changes.push(structuredClone(change));
    }
    async loadChanges(projectId, documentId, afterSequence = 0) {
      return this.changes.filter(change =>
        change.projectId === projectId && change.documentId === documentId &&
        change.sequence > afterSequence
      ).map(change => structuredClone(change));
    }
  }

  const commits = [];
  const store = new FailFirstJournalStore();
  const api = new HostEngineApi({
    store,
    callbacks: { onCommit: result => commits.push(result) }
  });
  api.initializeProject({ projectId: "queued-failure-recovery", projectName: "Recuperación de cola" });
  await api.openDocument({ documentId: "chapter", text: "A", revision: 0, sequence: 0 });

  const first = api.onEditorChange({
    documentId: "chapter", sequence: 1, baseRevision: 0,
    start: 1, end: 1, replacement: "B"
  });
  const second = api.onEditorChange({
    documentId: "chapter", sequence: 2, baseRevision: 1,
    start: 2, end: 2, replacement: "C"
  });
  const third = api.onEditorChange({
    documentId: "chapter", sequence: 3, baseRevision: 2,
    start: 3, end: 3, replacement: "D"
  });

  assert.equal(first.status, "queued");
  assert.equal(second.status, "queued");
  assert.equal(third.status, "queued");
  await api.flushPendingChanges();

  assert.equal(store.attempts, 1, "los cambios que dependen del primero no deben llegar al almacenamiento");
  assert.equal(api.pollCommit(first.ticketId)?.reason, "fallo_temporal_de_persistencia");
  assert.equal(api.pollCommit(second.ticketId)?.reason, "resync_required");
  assert.equal(api.pollCommit(third.ticketId)?.reason, "resync_required");
  assert.deepEqual(commits.map(result => result.ticketId).sort(), [
    first.ticketId, second.ticketId, third.ticketId
  ].sort());
  assert.ok(commits.every(result => result.status === "rejected"));
  assert.equal(api.getSnapshot("chapter")?.text, "A");
  assert.deepEqual(api.getDocumentSyncState("chapter"), {
    documentId: "chapter", revision: 0, sequence: 0,
    pendingSequence: 0, needsResync: true
  });
  assert.equal(api.getLiveAnalysisMetrics().queueDepth, 0);
  assert.equal(api.getLiveAnalysisMetrics().activeDocuments, 0);

  // El anfitrión conserva el texto completo que el motor no pudo persistir.
  await api.openDocument({
    documentId: "chapter", text: "ABCD", revision: 3, sequence: 3
  });
  assert.equal(api.getSnapshot("chapter")?.text, "ABCD");
  assert.equal(api.getDocumentSyncState("chapter")?.needsResync, false);
  assert.equal((await store.loadDocument("queued-failure-recovery", "chapter"))?.text, "ABCD");

  const afterRecovery = api.onEditorChange({
    documentId: "chapter", sequence: 4, baseRevision: 3,
    start: 4, end: 4, replacement: "E"
  });
  assert.equal(afterRecovery.status, "queued");
  await api.flushPendingChanges();
  assert.equal(api.pollCommit(afterRecovery.ticketId)?.status, "applied");
  assert.equal(api.getSnapshot("chapter")?.text, "ABCDE");
});

test("IndexedDB recupera una edición confirmada cuyo acuse de persistencia se perdió", {
  skip: typeof indexedDB === "undefined" || typeof IDBKeyRange === "undefined"
}, async () => {
  const projectId = "real-idb-ambiguous-append";
  const documentId = "chapter";
  const store = new IndexedDbProjectStore();
  const appendChange = store.appendChange.bind(store);
  let appendAttempts = 0;
  store.appendChange = async change => {
    await appendChange(change);
    appendAttempts++;
    if (appendAttempts === 1) {
      throw new Error("acuse_perdido_despues_de_confirmar_transaccion");
    }
  };
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId, projectName: "Acuse de persistencia perdido" });

  try {
    await store.saveDocument({
      projectId, documentId, text: "A", revision: 0, sequence: 0, updatedAt: 1
    });
    await api.openDocument({ documentId, text: "A", revision: 0, sequence: 0 });

    const admission = api.onEditorChange({
      documentId, sequence: 1, baseRevision: 0,
      start: 1, end: 1, replacement: "B"
    });
    assert.equal(admission.status, "queued");
    await api.flushPendingChanges();
    assert.equal(api.pollCommit(admission.ticketId)?.status, "rejected");
    assert.equal(api.getSnapshot(documentId)?.text, "A");
    assert.equal(api.getDocumentSyncState(documentId)?.needsResync, true);

    // El editor conservó la edición aunque el motor no recibiera el acuse.
    await api.openDocument({ documentId, text: "AB", revision: 1, sequence: 1 });
    assert.equal(api.getSnapshot(documentId)?.text, "AB");
    const recovered = await store.loadDocumentWithChanges(projectId, documentId);
    assert.equal(recovered.document?.text, "AB");
    assert.equal(recovered.document?.revision, 1);
    assert.deepEqual(recovered.changes, []);

    const next = api.onEditorChange({
      documentId, sequence: 2, baseRevision: 1,
      start: 2, end: 2, replacement: "C"
    });
    assert.equal(next.status, "queued");
    await api.flushPendingChanges();
    assert.equal(api.pollCommit(next.ticketId)?.status, "applied");
    assert.equal(api.getSnapshot(documentId)?.text, "ABC");
  } finally {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("motor-literario-local");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("No se pudo limpiar la base de prueba."));
      request.onblocked = () => reject(new Error("La limpieza quedó bloqueada por una conexión IndexedDB abierta."));
    });
  }
});

test("IndexedDB reconstruye una edición durable al abrir una instancia nueva del motor", {
  skip: typeof indexedDB === "undefined" || typeof IDBKeyRange === "undefined"
}, async () => {
  const projectId = "real-idb-process-restart";
  const documentId = "chapter";
  const firstStore = new IndexedDbProjectStore();
  const firstApi = new HostEngineApi({ store: firstStore });
  firstApi.initializeProject({ projectId, projectName: "Reinicio del proceso" });

  try {
    const hostBase = { documentId, text: "A", revision: 0, sequence: 0 };
    await firstStore.saveDocument({
      projectId, ...hostBase, updatedAt: 1
    });
    await firstApi.openDocument(hostBase);

    const admission = firstApi.onEditorChange({
      documentId, sequence: 1, baseRevision: 0,
      start: 1, end: 1, replacement: "B"
    });
    assert.equal(admission.status, "queued");
    await firstApi.flushPendingChanges();
    assert.equal(firstApi.pollCommit(admission.ticketId)?.status, "applied");

    // Una instancia nueva representa el proceso reiniciado: no conserva
    // memoria, tickets ni callbacks de la instancia que confirmó el journal.
    const restartedStore = new IndexedDbProjectStore();
    const restartedApi = new HostEngineApi({ store: restartedStore });
    restartedApi.initializeProject({ projectId, projectName: "Reinicio del proceso" });
    await restartedApi.openDocument(hostBase);

    assert.deepEqual(restartedApi.getSnapshot(documentId), {
      documentId, text: "AB", revision: 1, sequence: 1
    });
    const durable = await restartedStore.loadDocumentWithChanges(projectId, documentId);
    assert.equal(durable.document?.text, "AB");
    assert.equal(durable.document?.revision, 1);
    assert.equal(durable.document?.sequence, 1);
    assert.deepEqual(durable.changes, []);

    const next = restartedApi.onEditorChange({
      documentId, sequence: 2, baseRevision: 1,
      start: 2, end: 2, replacement: "C"
    });
    assert.equal(next.status, "queued");
    await restartedApi.flushPendingChanges();
    assert.equal(restartedApi.pollCommit(next.ticketId)?.status, "applied");
    assert.equal(restartedApi.getSnapshot(documentId)?.text, "ABC");
  } finally {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("motor-literario-local");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("No se pudo limpiar la base de prueba."));
      request.onblocked = () => reject(new Error("La limpieza quedó bloqueada por una conexión IndexedDB abierta."));
    });
  }
});

test("IndexedDB compacta sin duplicar cuando el anfitrión ya conservó la edición antes del reinicio", {
  skip: typeof indexedDB === "undefined" || typeof IDBKeyRange === "undefined"
}, async () => {
  const projectId = "real-idb-host-ahead-on-restart";
  const documentId = "chapter";
  const firstStore = new IndexedDbProjectStore();
  const firstApi = new HostEngineApi({ store: firstStore });
  firstApi.initializeProject({ projectId, projectName: "Anfitrión adelantado" });

  try {
    const hostBase = { documentId, text: "A", revision: 0, sequence: 0 };
    await firstStore.saveDocument({
      projectId, ...hostBase, updatedAt: 1
    });
    await firstApi.openDocument(hostBase);

    const admission = firstApi.onEditorChange({
      documentId, sequence: 1, baseRevision: 0,
      start: 1, end: 1, replacement: "B"
    });
    assert.equal(admission.status, "queued");
    await firstApi.flushPendingChanges();
    assert.equal(firstApi.pollCommit(admission.ticketId)?.status, "applied");

    // El anfitrión persistió su texto antes de que el motor reiniciara,
    // pero el snapshot interno aún conserva la base y el journal contiene B.
    const restartedStore = new IndexedDbProjectStore();
    const restartedApi = new HostEngineApi({ store: restartedStore });
    restartedApi.initializeProject({ projectId, projectName: "Anfitrión adelantado" });
    await restartedApi.openDocument({
      documentId, text: "AB", revision: 1, sequence: 1
    });

    assert.deepEqual(restartedApi.getSnapshot(documentId), {
      documentId, text: "AB", revision: 1, sequence: 1
    });
    const durable = await restartedStore.loadDocumentWithChanges(projectId, documentId);
    assert.equal(durable.document?.text, "AB");
    assert.equal(durable.document?.revision, 1);
    assert.equal(durable.document?.sequence, 1);
    assert.deepEqual(durable.changes, []);

    const next = restartedApi.onEditorChange({
      documentId, sequence: 2, baseRevision: 1,
      start: 2, end: 2, replacement: "C"
    });
    assert.equal(next.status, "queued");
    await restartedApi.flushPendingChanges();
    assert.equal(restartedApi.pollCommit(next.ticketId)?.status, "applied");
    assert.equal(restartedApi.getSnapshot(documentId)?.text, "ABC");
  } finally {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("motor-literario-local");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("No se pudo limpiar la base de prueba."));
      request.onblocked = () => reject(new Error("La limpieza quedó bloqueada por una conexión IndexedDB abierta."));
    });
  }
});

test("IndexedDB no conserva una edición cuya transacción se aborta antes del commit", {
  skip: typeof indexedDB === "undefined" || typeof IDBKeyRange === "undefined"
}, async () => {
  const projectId = "real-idb-aborted-write";
  const documentId = "chapter";
  const store = new IndexedDbProjectStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId, projectName: "Transacción abortada" });

  try {
    const hostBase = { documentId, text: "A", revision: 0, sequence: 0 };
    await store.saveDocument({
      projectId, ...hostBase, updatedAt: 1
    });
    await api.openDocument(hostBase);

    // Simula una interrupción antes del commit real: la transacción
    // readwrite se aborta después de encolar sus lecturas, antes de completar.
    const originalOpen = store.open.bind(store);
    let abortNextWrite = true;
    store.open = async () => {
      const db = await originalOpen();
      if (!abortNextWrite) return db;
      const originalTransaction = db.transaction.bind(db);
      db.transaction = (...args) => {
        const transaction = originalTransaction(...args);
        if (abortNextWrite && args[1] === "readwrite") {
          abortNextWrite = false;
          queueMicrotask(() => {
            try { transaction.abort(); } catch { /* ya finalizada */ }
          });
        }
        return transaction;
      };
      return db;
    };

    const rejected = api.onEditorChange({
      documentId, sequence: 1, baseRevision: 0,
      start: 1, end: 1, replacement: "B"
    });
    assert.equal(rejected.status, "queued");
    await api.flushPendingChanges();
    assert.equal(api.pollCommit(rejected.ticketId)?.status, "rejected");

    // Reinicio: solo sobrevive el snapshot confirmado por el anfitrión.
    const restartedStore = new IndexedDbProjectStore();
    const restartedApi = new HostEngineApi({ store: restartedStore });
    restartedApi.initializeProject({ projectId, projectName: "Transacción abortada" });
    await restartedApi.openDocument(hostBase);

    assert.deepEqual(restartedApi.getSnapshot(documentId), {
      documentId, text: "A", revision: 0, sequence: 0
    });
    const durable = await restartedStore.loadDocumentWithChanges(projectId, documentId);
    assert.deepEqual(durable.changes, []);

    const recovered = restartedApi.onEditorChange({
      documentId, sequence: 1, baseRevision: 0,
      start: 1, end: 1, replacement: "C"
    });
    assert.equal(recovered.status, "queued");
    await restartedApi.flushPendingChanges();
    assert.equal(restartedApi.pollCommit(recovered.ticketId)?.status, "applied");
    assert.equal(restartedApi.getSnapshot(documentId)?.text, "AC");
  } finally {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("motor-literario-local");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("No se pudo limpiar la base de prueba."));
      request.onblocked = () => reject(new Error("La limpieza quedó bloqueada por una conexión IndexedDB abierta."));
    });
  }
});



test("IndexedDB conserva el contexto completo al archivar redes amplias de ideas", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const projectId = "archive-large-context";
  const projectName = "Libro de red amplia";
  const smallCount = 256;
  const wideCount = 1200;
  const pendingIdeas = Array.from({ length: smallCount }, (_, index) => ({
    projectId,
    id: `pending-${String(index).padStart(4, "0")}`,
    text: `Idea pendiente ${index}`,
    status: "IDEA",
    originDocumentId: "chapter",
    sourceProjectName: projectName,
    evidence: [],
    relatedIdeaIds: [`context-${String(index).padStart(4, "0")}`]
  }));
  pendingIdeas.push({
    projectId,
    id: "pending-wide",
    text: "Idea con contexto amplio",
    status: "IDEA",
    originDocumentId: "chapter",
    sourceProjectName: projectName,
    evidence: [],
    relatedIdeaIds: ["context-wide-root"]
  });
  const smallContexts = Array.from({ length: smallCount }, (_, index) => ({
    projectId,
    id: `context-${String(index).padStart(4, "0")}`,
    text: `Contexto ${index}`,
    status: "incorporated",
    originDocumentId: "chapter",
    sourceProjectName: projectName,
    evidence: []
  }));
  const wideRoot = {
    projectId,
    id: "context-wide-root",
    text: "Raíz del contexto amplio",
    status: "incorporated",
    originDocumentId: "chapter",
    sourceProjectName: projectName,
    evidence: [],
    relatedIdeaIds: Array.from({ length: wideCount }, (_, index) =>
      `wide-leaf-${String(index).padStart(4, "0")}`
    )
  };
  const wideLeaves = Array.from({ length: wideCount }, (_, index) => ({
    projectId,
    id: `wide-leaf-${String(index).padStart(4, "0")}`,
    text: `Detalle contextual ${index}`,
    status: "incorporated",
    originDocumentId: "chapter",
    sourceProjectName: projectName,
    evidence: []
  }));
  const projectIdeas = [...pendingIdeas, ...smallContexts, wideRoot, ...wideLeaves];
  const entries = [];
  const deleted = [];
  const transaction = {
    error: null,
    objectStore(name) {
      if (name === "narrative-ideas") {
        return {
          index(indexName) {
            assert.equal(indexName, "by-project");
            return {
              getAll(requestedProjectId) {
                assert.equal(requestedProjectId, projectId);
                const request = {};
                queueMicrotask(() => {
                  request.result = structuredClone(projectIdeas);
                  request.onsuccess?.();
                  queueMicrotask(() => transaction.oncomplete?.());
                });
                return request;
              }
            };
          },
          delete(key) { deleted.push(key); }
        };
      }
      if (name === "personal-idea-library") {
        return { add(entry) { entries.push(structuredClone(entry)); } };
      }
      if (name === "writer-library-finalization-receipts") return {};
      assert.equal(name, "narrative-entities");
      return {};
    }
  };
  const database = {
    onversionchange: null,
    close() {},
    transaction(storeNames, mode) {
      assert.equal(mode, "readwrite");
      assert.deepEqual(new Set(storeNames), new Set([
        "narrative-ideas", "personal-idea-library", "narrative-entities",
        "writer-library-finalization-receipts"
      ]));
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const request = { result: database };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      }
    }
  });

  try {
    const store = new IndexedDbProjectStore();
    const archived = await store.archiveUnincorporatedIdeas(
      projectId, "writer-large-context", projectName, 10
    );
    assert.equal(archived.length, smallCount + 1);
    assert.equal(entries.length, smallCount + 1);
    assert.equal(deleted.length, smallCount + 1);

    for (let index = 0; index < smallCount; index++) {
      const entry = entries.find(item => item.idea.id === pendingIdeas[index].id);
      assert.ok(entry);
      assert.deepEqual(
        entry.context.relatedIdeas.map(idea => idea.id),
        [`context-${String(index).padStart(4, "0")}`]
      );
    }
    const wideEntry = entries.find(item => item.idea.id === "pending-wide");
    assert.ok(wideEntry);
    assert.equal(wideEntry.context.relatedIdeas.length, wideCount + 1);
    assert.deepEqual(
      wideEntry.context.relatedIdeas.map(idea => idea.id),
      [...["context-wide-root"], ...wideLeaves.map(idea => idea.id)].sort()
    );
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("recupera un documento desde el snapshot local y su journal sin reenviar el texto del anfitrión", async () => {
  const store = new MemoryStore();
  const changes = [];
  store.appendChange = async change => {
    changes.push(structuredClone(change));
  };
  store.loadDocumentWithChanges = async (projectId, documentId) => {
    const document = await store.loadDocument(projectId, documentId);
    return {
      document,
      changes: changes
        .filter(change => change.projectId === projectId &&
          change.documentId === documentId &&
          change.sequence > (document?.sequence ?? -1))
        .sort((first, second) => first.sequence - second.sequence)
        .map(change => structuredClone(change))
    };
  };
  store.compactChanges = async (projectId, documentId, throughSequence) => {
    for (let index = changes.length - 1; index >= 0; index--) {
      const change = changes[index];
      if (change.projectId === projectId &&
          change.documentId === documentId &&
          change.sequence <= throughSequence) {
        changes.splice(index, 1);
      }
    }
  };

  const identity = {
    projectId: "local-recovery-without-host-snapshot",
    projectName: "Recuperación local"
  };
  const firstProcess = new HostEngineApi({ store });
  firstProcess.initializeProject(identity);
  await firstProcess.openDocument({
    documentId: "chapter-1",
    text: "Texto inicial",
    revision: 0,
    sequence: 0
  });

  const admission = firstProcess.onEditorChange({
    documentId: "chapter-1",
    sequence: 1,
    baseRevision: 0,
    start: "Texto inicial".length,
    end: "Texto inicial".length,
    replacement: " y una continuación"
  });
  assert.equal(admission.status, "queued");
  await firstProcess.flushPendingChanges();
  assert.equal(changes.length, 1);
  assert.equal((await store.loadDocument(identity.projectId, "chapter-1")).text, "Texto inicial");

  // El segundo proceso solo conoce el ID del documento; el texto se recupera
  // desde el snapshot durable y el delta confirmado.
  const restartedProcess = new HostEngineApi({ store });
  restartedProcess.initializeProject(identity);
  await restartedProcess.recoverDocument("chapter-1");
  await restartedProcess.flushPendingChanges();

  const recovered = restartedProcess.getSnapshot("chapter-1");
  assert.equal(recovered.text, "Texto inicial y una continuación");
  assert.equal(recovered.revision, 1);
  assert.equal(recovered.sequence, 1);
  assert.equal(changes.length, 0);
  const durable = await store.loadDocument(identity.projectId, "chapter-1");
  assert.equal(durable.text, recovered.text);
  assert.equal(durable.revision, recovered.revision);
  assert.equal(durable.sequence, recovered.sequence);
});

test("la recuperación local no inventa un snapshot cuando el documento nunca fue guardado", async () => {
  const api = new HostEngineApi({ store: new MemoryStore() });
  api.initializeProject({
    projectId: "missing-local-recovery",
    projectName: "Sin snapshot durable"
  });
  await assert.rejects(
    api.recoverDocument("chapter-missing"),
    /No existe un snapshot durable/
  );
  assert.equal(api.getSnapshot("chapter-missing"), undefined);
});


test("IndexedDB registra el cierre del libro y repite la transferencia usando el mismo recibo durable", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const projectId = "finalization-receipt-book";
  const writerId = "finalization-receipt-writer";
  const projectName = "El libro finalizado";
  const idea = {
    projectId,
    id: "idea-to-archive",
    text: "La ciudad recuerda a sus habitantes.",
    status: "IDEA",
    originDocumentId: "chapter-1",
    sourceProjectName: projectName,
    evidence: [],
    statusHistory: [{ status: "IDEA", changedAt: 10, reason: "initial" }]
  };
  const projectIdeas = [structuredClone(idea)];
  const library = new Map();
  const receipts = new Map();
  const makeKey = parts => JSON.stringify(parts);

  const database = {
    onversionchange: null,
    close() {},
    transaction(storeNames, mode) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      assert.ok(names.includes("writer-library-finalization-receipts"));
      const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        aborted: false,
        completed: false,
        pendingRequests: 0,
        abort() {
          if (transaction.aborted || transaction.completed) return;
          transaction.aborted = true;
          queueMicrotask(() => transaction.onabort?.());
        },
        maybeComplete() {
          if (transaction.completed || transaction.aborted || transaction.pendingRequests !== 0) return;
          queueMicrotask(() => {
            if (transaction.completed || transaction.aborted || transaction.pendingRequests !== 0) return;
            transaction.completed = true;
            transaction.oncomplete?.();
          });
        },
        request(resultFactory) {
          transaction.pendingRequests++;
          const request = {};
          queueMicrotask(() => {
            if (transaction.aborted) return;
            request.result = resultFactory();
            request.onsuccess?.();
            transaction.pendingRequests--;
            transaction.maybeComplete();
          });
          return request;
        },
        objectStore(name) {
          if (name === "narrative-ideas") {
            return {
              index(indexName) {
                assert.equal(indexName, "by-project");
                return {
                  getAll(requestedProjectId) {
                    return transaction.request(() =>
                      structuredClone(projectIdeas.filter(item => item.projectId === requestedProjectId))
                    );
                  }
                };
              },
              delete(key) {
                const [requestedProjectId, ideaId] = key;
                const index = projectIdeas.findIndex(item =>
                  item.projectId === requestedProjectId && item.id === ideaId
                );
                if (index >= 0) projectIdeas.splice(index, 1);
              }
            };
          }
          if (name === "personal-idea-library") {
            return {
              index(indexName) {
                assert.equal(indexName, "by-writer-source");
                return {
                  getAll(key) {
                    return transaction.request(() =>
                      [...library.values()]
                        .filter(entry => entry.writerId === key[0] && entry.sourceProjectId === key[1])
                        .map(entry => structuredClone(entry))
                    );
                  }
                };
              },
              add(entry) {
                const key = makeKey([entry.writerId, entry.sourceProjectId, entry.idea.id]);
                if (library.has(key)) {
                  throw new Error("ConstraintError: idea already archived");
                }
                library.set(key, structuredClone(entry));
              }
            };
          }
          if (name === "writer-library-finalization-receipts") {
            return {
              get(key) {
                return transaction.request(() => {
                  const value = receipts.get(makeKey(key));
                  return value ? structuredClone(value) : undefined;
                });
              },
              add(receipt) {
                const key = makeKey([receipt.writerId, receipt.sourceProjectId, receipt.receiptId]);
                if (receipts.has(key)) throw new Error("ConstraintError: receipt already exists");
                receipts.set(key, structuredClone(receipt));
              }
            };
          }
          assert.equal(name, "narrative-entities");
          return {
            get() {
              return transaction.request(() => undefined);
            }
          };
        }
      };
      assert.equal(mode === "readwrite" || mode === "readonly", true);
      return transaction;
    }
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const request = { result: database };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      }
    }
  });

  try {
    const store = new IndexedDbProjectStore();
    const firstArchive = await store.archiveUnincorporatedIdeas(
      projectId, writerId, projectName, 100
    );
    assert.equal(firstArchive.length, 1);
    assert.equal(projectIdeas.length, 0);
    assert.equal(library.size, 1);
    assert.equal(receipts.size, 1);

    const receipt = await store.loadProjectFinalizationReceipt(writerId, projectId);
    assert.ok(receipt);
    assert.equal(receipt.receiptId, "finalization-v1");
    assert.equal(receipt.sourceProjectName, projectName);
    assert.equal(receipt.finalizedAt, 100);
    assert.deepEqual(receipt.archivedIdeaIds, ["idea-to-archive"]);
    assert.match(receipt.archiveChecksum, /^fnv1a64:[0-9a-f]{16}$/);

    const retryArchive = await store.archiveUnincorporatedIdeas(
      projectId, writerId, projectName, 200
    );
    assert.equal(retryArchive.length, 1);
    assert.equal(retryArchive[0].idea.id, "idea-to-archive");
    assert.equal(library.size, 1, "el reintento no duplica entradas de biblioteca");
    assert.equal(receipts.size, 1, "el reintento no crea un segundo recibo");
    assert.equal(
      (await store.loadProjectFinalizationReceipt(writerId, projectId)).archiveChecksum,
      receipt.archiveChecksum
    );

    projectIdeas.push({
      ...structuredClone(idea),
      id: "idea-created-after-finalization",
      text: "Esta idea se añadió después del cierre."
    });
    await assert.rejects(
      store.archiveUnincorporatedIdeas(projectId, writerId, projectName, 300),
      /recibo de finalización; las ideas nuevas/
    );
    assert.equal(projectIdeas.length, 1, "el reintento posterior no elimina ni archiva ideas nuevas");
    assert.equal(library.size, 1);
    assert.equal(receipts.size, 1);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});


test("IndexedDB sincroniza solo la identidad del proyecto entre pestañas y libera suscripciones", async () => {
  const originalBroadcastChannel = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
  class FakeBroadcastChannel {
    static instances = [];
    name;
    onmessage = null;
    sent = [];
    closed = false;

    constructor(name) {
      this.name = name;
      FakeBroadcastChannel.instances.push(this);
    }

    postMessage(message) {
      this.sent.push(structuredClone(message));
      for (const receiver of FakeBroadcastChannel.instances) {
        if (receiver === this || receiver.name !== this.name || receiver.closed) continue;
        queueMicrotask(() => receiver.onmessage?.({ data: structuredClone(message) }));
      }
    }

    close() {
      this.closed = true;
      this.onmessage = null;
    }
  }

  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: FakeBroadcastChannel
  });

  try {
    const writerStore = new IndexedDbProjectStore();
    const readerStore = new IndexedDbProjectStore();
    const received = [];
    const unsubscribe = readerStore.subscribeNarrativeChanges(projectId => received.push(projectId));
    assert.equal(FakeBroadcastChannel.instances.length, 1);
    assert.equal(FakeBroadcastChannel.instances[0].name, "motor-literario-local:narrative-changes:v1");

    writerStore.publishNarrativeChange("book-a");
    await new Promise(resolve => queueMicrotask(resolve));
    assert.deepEqual(received, ["book-a"]);
    assert.deepEqual(FakeBroadcastChannel.instances[1].sent, [{
      type: "motor-literario:narrative-change",
      projectId: "book-a"
    }]);

    unsubscribe();
    assert.equal(FakeBroadcastChannel.instances[0].closed, true);
    readerStore.publishNarrativeChange("book-b");
    await new Promise(resolve => queueMicrotask(resolve));
    assert.deepEqual(received, ["book-a"]);
  } finally {
    if (originalBroadcastChannel) {
      Object.defineProperty(globalThis, "BroadcastChannel", originalBroadcastChannel);
    } else {
      delete globalThis.BroadcastChannel;
    }
  }
});

test("HostEngineApi invalida la caché y avisa al anfitrión ante cambios de otra pestaña", async () => {
  const store = new MemoryStore();
  const listeners = new Set();
  store.subscribeNarrativeChanges = listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let resolveNotice;
  const notice = new Promise(resolve => { resolveNotice = resolve; });
  const api = new HostEngineApi({
    store,
    callbacks: {
      onKnowledgeChanged: projectId => resolveNotice(projectId)
    }
  });
  const identity = {
    projectId: "cross-tab-cache",
    projectName: "Libro compartido",
    writerId: "writer-cross-tab"
  };
  api.initializeProject(identity);
  const idea = {
    projectId: identity.projectId,
    id: "idea-1",
    text: "La campana anuncia el regreso.",
    status: "IDEA",
    originDocumentId: "chapter-1",
    sourceProjectName: identity.projectName,
    evidence: []
  };
  await store.saveIdea(idea);
  assert.equal((await api.getNarrativeIdeas())[0].status, "IDEA");

  await store.saveIdea({ ...idea, status: "incorporated" });
  for (const listener of listeners) listener(identity.projectId);

  assert.equal(await notice, identity.projectId);
  assert.equal((await api.getNarrativeIdeas())[0].status, "incorporated");
  api.dispose();
  assert.equal(listeners.size, 0, "dispose debe retirar la suscripción local");
});

test("IndexedDB rechaza una entidad obsoleta sin sustituir la versión confirmada", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const projectId = "indexeddb-entity-cas";
  const previous = {
    projectId,
    id: "entity-ana",
    kind: "character",
    canonicalName: "Ana",
    normalizedName: "ana",
    aliases: [],
    evidence: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
    extractionVersion: 1
  };
  const current = { ...previous, aliases: ["Anita"] };
  const records = [structuredClone(current)];
  let putCount = 0;

  const database = {
    onversionchange: null,
    close() {},
    transaction(storeNames, mode) {
      assert.equal(mode, "readwrite");
      assert.equal(storeNames, "narrative-entities");
      const transaction = {
        error: null,
        aborted: false,
        abort() {
          if (transaction.aborted) return;
          transaction.aborted = true;
          transaction.error = new Error("simulated_version_conflict");
          queueMicrotask(() => transaction.onabort?.());
        },
        objectStore(name) {
          assert.equal(name, "narrative-entities");
          return {
            index(indexName) {
              assert.equal(indexName, "by-project");
              return {
                getAll(requestedProjectId) {
                  assert.equal(requestedProjectId, projectId);
                  const request = {};
                  queueMicrotask(() => {
                    request.result = structuredClone(records.filter(item =>
                      item.projectId === requestedProjectId
                    ));
                    request.onsuccess?.();
                    if (!transaction.aborted) queueMicrotask(() => transaction.oncomplete?.());
                  });
                  return request;
                }
              };
            },
            put(record) {
              putCount++;
              const index = records.findIndex(item =>
                item.projectId === record.projectId && item.id === record.id
              );
              if (index >= 0) records[index] = structuredClone(record);
              else records.push(structuredClone(record));
            }
          };
        }
      };
      return transaction;
    }
  };

  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const request = { result: database };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      }
    }
  });

  try {
    const store = new IndexedDbProjectStore();
    await assert.rejects(
      store.saveEntityIfUnchanged({ ...previous, aliases: ["Ana antigua"] }, previous),
      /cambió en otra instancia/
    );
    assert.equal(putCount, 0, "la transacción obsoleta no debe encolar ninguna escritura");
    assert.deepEqual(records[0].aliases, ["Anita"]);
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("IndexedDB rechaza relaciones, acontecimientos y afirmaciones basados en versiones antiguas", async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const projectId = "indexeddb-narrative-record-cas";
  const entities = ["entity-a", "entity-b"].map((id, index) => ({
    projectId,
    id,
    kind: "character",
    canonicalName: index === 0 ? "Ana" : "Bruno",
    normalizedName: index === 0 ? "ana" : "bruno",
    aliases: [],
    evidence: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
    extractionVersion: 1
  }));
  const evidence = {
    documentId: "chapter-1",
    revision: 0,
    start: 0,
    end: 3,
    excerpt: "Ana"
  };
  const cases = [
    {
      storeName: "narrative-relations",
      expected: {
        id: "relation-1", projectId,
        fromEntityId: "entity-a", toEntityId: "entity-b",
        relationType: "knows", evidence: []
      },
      current: {
        id: "relation-1", projectId,
        fromEntityId: "entity-a", toEntityId: "entity-b",
        relationType: "protects", evidence: []
      },
      stale: {
        id: "relation-1", projectId,
        fromEntityId: "entity-a", toEntityId: "entity-b",
        relationType: "enemy", evidence: []
      },
      save: (store, stale, expected) => store.saveRelationIfUnchanged(stale, expected)
    },
    {
      storeName: "narrative-events",
      expected: {
        id: "event-1", projectId,
        label: "Ana llega", participants: ["entity-a"], evidence: []
      },
      current: {
        id: "event-1", projectId,
        label: "Ana entra", participants: ["entity-a"], evidence: []
      },
      stale: {
        id: "event-1", projectId,
        label: "Ana se marcha", participants: ["entity-a"], evidence: []
      },
      save: (store, stale, expected) => store.saveEventIfUnchanged(stale, expected)
    },
    {
      storeName: "narrative-assertions",
      expected: {
        id: "assertion-1", projectId,
        entityId: "entity-a", entityName: "Ana",
        attribute: "role", value: "guardiana", evidence, capturedAt: 1
      },
      current: {
        id: "assertion-1", projectId,
        entityId: "entity-a", entityName: "Ana",
        attribute: "role", value: "capitana", evidence, capturedAt: 1
      },
      stale: {
        id: "assertion-1", projectId,
        entityId: "entity-a", entityName: "Ana",
        attribute: "role", value: "enemiga", evidence, capturedAt: 1
      },
      save: (store, stale, expected) => store.saveAssertionIfUnchanged(stale, expected)
    }
  ];

  try {
    for (const item of cases) {
      let putCount = 0;
      const database = {
        onversionchange: null,
        close() {},
        transaction(storeNames, mode) {
          const expectedStores = item.storeName === "narrative-events"
            ? ["narrative-entities", "timeline-tracks", "narrative-events"]
            : ["narrative-entities", item.storeName];
          assert.deepEqual(new Set(storeNames), new Set(expectedStores));
          assert.equal(mode, "readwrite");
          const transaction = {
            error: null,
            aborted: false,
            completed: false,
            pendingRequests: 0,
            abort() {
              if (transaction.aborted || transaction.completed) return;
              transaction.aborted = true;
              transaction.error = new Error("simulated_narrative_version_conflict");
              queueMicrotask(() => transaction.onabort?.());
            },
            request(resultFactory) {
              transaction.pendingRequests++;
              const request = {};
              queueMicrotask(() => {
                if (transaction.aborted) return;
                request.result = structuredClone(resultFactory());
                request.onsuccess?.();
                transaction.pendingRequests--;
                if (transaction.pendingRequests === 0 && !transaction.aborted) {
                  queueMicrotask(() => {
                    if (transaction.aborted || transaction.completed) return;
                    transaction.completed = true;
                    transaction.oncomplete?.();
                  });
                }
              });
              return request;
            },
            objectStore(name) {
              if (name === "narrative-entities") {
                return {
                  index(indexName) {
                    assert.equal(indexName, "by-project");
                    return {
                      getAll(requestedProjectId) {
                        assert.equal(requestedProjectId, projectId);
                        return transaction.request(() => entities);
                      }
                    };
                  }
                };
              }
              assert.equal(name, item.storeName);
              return {
                get(key) {
                  assert.deepEqual(key, [projectId, item.expected.id]);
                  return transaction.request(() => item.current);
                },
                put() {
                  putCount++;
                }
              };
            }
          };
          return transaction;
        }
      };
      Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: {
          open() {
            const request = { result: database };
            queueMicrotask(() => request.onsuccess?.());
            return request;
          }
        }
      });

      const persistedBefore = structuredClone(item.current);
      const store = new IndexedDbProjectStore();
      await assert.rejects(
        item.save(store, item.stale, item.expected),
        /cambió en otra instancia/
      );
      assert.equal(putCount, 0, `no debe guardarse la ${item.storeName} obsoleta`);
      assert.deepEqual(item.current, persistedBefore);
    }
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
    else delete globalThis.indexedDB;
  }
});

test("el análisis literario mide ritmo, diálogo y repeticiones con offsets UTF-16", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "La sombra cubría el camino. La sombra parecía interminable.",
    "",
    "La sombra avanzó lentamente. La sombra se detuvo.",
    "—¿Vienes conmigo? —preguntó Ana.",
    "«Yo no puedo», respondió Luis."
  ].join("\n");
  const result = analyzeLiteraryFragment({
    projectId:"literary-metrics", documentId:"chapter", revision:4, text, baseOffset:100
  });
  assert.equal(result.range.start,100);
  assert.equal(result.range.end,100+text.length);
  assert.equal(result.metrics.paragraphCount,2);
  assert.equal(result.metrics.sentenceCount,7);
  assert.ok(result.metrics.wordCount > 15);
  assert.ok(result.metrics.dialogueWordCount > 0);
  assert.ok(result.metrics.dialogueRatio > 0);
  assert.equal(result.repeatedWords.find(item => item.word === "sombra")?.count,4);
  assert.ok(result.repeatedWords.find(item => item.word === "sombra").occurrences
    .every(item => item.start >= 100 && item.end > item.start));
  assert.equal(result.voiceSignals.counts.firstPerson,0,
    "los pronombres dentro del diálogo no cuentan como señales fuera de diálogo");
  assert.ok(result.caveats.length >= 3);
});

test("las señales gramaticales separan pronombres narrativos y pronombres en diálogo", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const result = analyzeLiteraryFragment({
    projectId:"voice-signals",documentId:"chapter",revision:1,
    text:"Yo recuerdo la casa. Yo escuché el viento. «Tú debes volver», dijo Ana."
  });
  assert.equal(result.voiceSignals.classification,"first-person-signals");
  assert.equal(result.voiceSignals.counts.firstPerson,2);
  assert.equal(result.voiceSignals.counts.secondPerson,0);
  assert.equal(result.voiceSignals.samples.length,2);
});

test("los offsets literarios respetan UTF-16 y limitan el tamaño del fragmento", async () => {
  const { analyzeLiteraryFragment, MAX_LITERARY_ANALYSIS_TEXT_UNITS } =
    await import("../dist/motor-literario.js");
  const result = analyzeLiteraryFragment({
    projectId:"unicode-literary",documentId:"chapter",revision:2,
    text:"🧭 Yo vi la luz.",baseOffset:50
  });
  const yo = result.voiceSignals.samples.find(item => item.term === "Yo");
  assert.ok(yo);
  assert.equal(yo.start,53,"el emoji ocupa dos unidades UTF-16");
  assert.equal(result.range.end,50+"🧭 Yo vi la luz.".length);
  assert.throws(() => analyzeLiteraryFragment({
    projectId:"large",documentId:"chapter",revision:0,
    text:"x".repeat(MAX_LITERARY_ANALYSIS_TEXT_UNITS+1)
  }),/demasiado grande/i);
});

test("la API analiza el documento abierto sin modificar el manuscrito", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({store});
  api.initializeProject({projectId:"literary-api",projectName:"Análisis"});
  const text = "Yo crucé el puente. Yo miré atrás. La noche llegó.";
  await api.openDocument({documentId:"chapter",text,revision:0,sequence:0});
  const before = api.getSnapshot("chapter");
  const result = await api.analyzeLiteraryDocument("chapter",3,text.length);
  const after = api.getSnapshot("chapter");
  assert.equal(result.range.start,3);
  assert.equal(result.range.end,text.length);
  assert.equal(result.revision,0);
  assert.deepEqual(after,before);
  assert.equal(result.voiceSignals.classification,"first-person-signals");
  await assert.rejects(() => api.analyzeLiteraryDocument("missing"),/abierto/i);
  await assert.rejects(() => api.analyzeLiteraryDocument("chapter",0,text.length+1),/supera/i);
});




test("la API vincula acontecimientos persistidos a escenas del documento y revisión activos", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({store});
  api.initializeProject({projectId:"scene-event-api",projectName:"Continuidad"});
  const text = "ESCENA: Vestíbulo\nAna abrió la puerta. La alarma sonó.";
  const phrase = "La alarma sonó.";
  const start = text.indexOf(phrase);
  await store.saveEntity({
    projectId:"scene-event-api",id:"ana",kind:"character",canonicalName:"Ana",
    normalizedName:"ana",aliases:[],evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1
  });
  await store.saveEvent({
    projectId:"scene-event-api",id:"alarm",label:"Suena la alarma",participants:["ana"],
    timeReference:{basis:"calendar",precision:"year",raw:"año 2020",orderValue:100},
    evidence:[{documentId:"chapter",revision:0,start,end:start+phrase.length,excerpt:phrase}]
  });
  await store.saveEvent({
    projectId:"scene-event-api",id:"other-chapter-event",label:"Se apaga la alarma",participants:["ana"],
    timeReference:{basis:"calendar",precision:"year",raw:"año 2021",orderValue:200},
    evidence:[{documentId:"other-chapter",revision:0,start:0,end:19,excerpt:"La alarma se apagó."}]
  });
  await store.saveEvent({
    projectId:"scene-event-api",id:"stale",label:"Evento antiguo",participants:["ana"],
    evidence:[{documentId:"chapter",revision:1,start,end:start+phrase.length,excerpt:phrase}]
  });
  await api.openDocument({documentId:"chapter",text,revision:0,sequence:0});
  const before = api.getSnapshot("chapter");
  const result = await api.analyzeLiteraryDocument("chapter");
  assert.deepEqual(result.explicitScenes[0].eventLinks.map(item => item.eventId),["alarm"]);
  assert.equal(result.explicitScenes[0].eventLinks[0].participants[0].mentionedByName,true);
  const anaTrajectory=result.characterNarrativeTrajectories.trajectories.find(item => item.entityId==="ana");
  assert.ok(anaTrajectory);
  assert.deepEqual(anaTrajectory.eventParticipation.map(item => item.eventId),["alarm"]);
  assert.deepEqual(anaTrajectory.scenes[0].eventIds,["alarm"]);
  assert.equal(anaTrajectory.scenes[0].participationStatus,"linked-to-explicit-event-evidence");
  assert.equal(anaTrajectory.projectEventTimeline.sourceEventCount,3);
  assert.equal(anaTrajectory.projectEventTimeline.timedEventCount,2);
  assert.equal(anaTrajectory.projectEventTimeline.pointCount,2);
  assert.deepEqual(anaTrajectory.projectEventTimeline.points.map(item => item.documentIds),[
    ["chapter"],["other-chapter"]
  ]);
  assert.deepEqual(api.getSnapshot("chapter"),before);
});

test("resume la recurrencia de acontecimientos entre escenas aunque no declaren participantes", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1","La tormenta comenzó.","***",
    "ESCENA 2","El patio quedó en silencio.","***",
    "ESCENA 3","La tormenta regresó.","***",
    "ESCENA 4","La campana repicó."
  ].join("\n");
  const evidenceFor = excerpt => {
    const start = text.indexOf(excerpt);
    assert.notEqual(start,-1);
    return {
      documentId:"chapter",revision:12,
      start,end:start+excerpt.length,excerpt
    };
  };
  const result = analyzeLiteraryFragment({
    projectId:"event-scene-recurrence",documentId:"chapter",revision:12,text,
    knownEvents:[
      {
        eventId:"storm",label:"La tormenta",
        participants:[],
        evidence:[
          evidenceFor("La tormenta comenzó."),
          evidenceFor("La tormenta regresó.")
        ]
      },
      {
        eventId:"bell",label:"La campana",
        participants:[],
        evidence:[evidenceFor("La campana repicó.")]
      }
    ]
  });

  assert.deepEqual(result.sceneEventEvidenceProfiles,{
    explicitSceneCount:4,
    sourceTruncatedSceneCount:0,
    sourceTruncatedSceneIndexes:[],
    eventCount:2,
    omittedEventCount:0,
    profiles:[
      {
        eventId:"storm",eventLabel:"La tormenta",
        sceneIndexes:[1,3],sceneCount:2,
        firstSceneIndex:1,lastSceneIndex:3,
        interveningSceneCount:1,longestConsecutiveSceneRun:1,
        totalEvidenceRangeCount:2,
        scenes:[
          {sceneIndex:1,evidenceRangeCount:1,evidenceSamplesTruncated:false},
          {sceneIndex:2,evidenceRangeCount:null,evidenceSamplesTruncated:null},
          {sceneIndex:3,evidenceRangeCount:1,evidenceSamplesTruncated:false},
          {sceneIndex:4,evidenceRangeCount:null,evidenceSamplesTruncated:null}
        ]
      },
      {
        eventId:"bell",eventLabel:"La campana",
        sceneIndexes:[4],sceneCount:1,
        firstSceneIndex:4,lastSceneIndex:4,
        interveningSceneCount:0,longestConsecutiveSceneRun:1,
        totalEvidenceRangeCount:1,
        scenes:[
          {sceneIndex:1,evidenceRangeCount:null,evidenceSamplesTruncated:null},
          {sceneIndex:2,evidenceRangeCount:null,evidenceSamplesTruncated:null},
          {sceneIndex:3,evidenceRangeCount:null,evidenceSamplesTruncated:null},
          {sceneIndex:4,evidenceRangeCount:1,evidenceSamplesTruncated:false}
        ]
      }
    ]
  });
  assert.deepEqual(result.characterEventEvidenceProfiles.profiles,[]);
});

test("detecta secuencias recurrentes de acontecimientos en ventanas de escenas contiguas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1","La tormenta comienza.","***",
    "ESCENA 2","El patio quedó vacío.","***",
    "ESCENA 3","La campana suena.","***",
    "ESCENA 4","La tormenta comienza.","***",
    "ESCENA 5","El patio quedó vacío.","***",
    "ESCENA 6","La campana suena."
  ].join("\n");
  const evidenceForAll = excerpt => {
    const evidence=[];
    let cursor=0;
    while(true) {
      const start=text.indexOf(excerpt,cursor);
      if(start<0) break;
      evidence.push({
        documentId:"chapter",revision:15,
        start,end:start+excerpt.length,excerpt
      });
      cursor=start+excerpt.length;
    }
    assert.ok(evidence.length>0);
    return evidence;
  };
  const result=analyzeLiteraryFragment({
    projectId:"event-sequence-motifs",documentId:"chapter",revision:15,text,
    knownEvents:[
      {
        eventId:"storm",label:"Comienza la tormenta",participants:[],
        evidence:evidenceForAll("La tormenta comienza.")
      },
      {
        eventId:"bell",label:"Suena la campana",participants:[],
        evidence:evidenceForAll("La campana suena.")
      }
    ]
  });

  assert.deepEqual(result.sceneEventSequenceMotifs,{
    explicitSceneCount:6,
    candidateWindowCount:9,
    analyzedWindowCount:9,
    emptyWindowCount:0,
    sourceTruncatedWindowCount:0,
    motifCount:3,
    omittedMotifCount:0,
    motifs:[
      {
        sceneCount:3,
        sceneSequence:[
          {sceneOffset:1,eventIds:["storm"]},
          {sceneOffset:2,eventIds:[]},
          {sceneOffset:3,eventIds:["bell"]}
        ],
        occurrenceCount:2,
        instances:[
          {fromSceneIndex:1,toSceneIndex:3},
          {fromSceneIndex:4,toSceneIndex:6}
        ],
        instancesTruncated:false
      },
      {
        sceneCount:2,
        sceneSequence:[
          {sceneOffset:1,eventIds:["storm"]},
          {sceneOffset:2,eventIds:[]}
        ],
        occurrenceCount:2,
        instances:[
          {fromSceneIndex:1,toSceneIndex:2},
          {fromSceneIndex:4,toSceneIndex:5}
        ],
        instancesTruncated:false
      },
      {
        sceneCount:2,
        sceneSequence:[
          {sceneOffset:1,eventIds:[]},
          {sceneOffset:2,eventIds:["bell"]}
        ],
        occurrenceCount:2,
        instances:[
          {fromSceneIndex:2,toSceneIndex:3},
          {fromSceneIndex:5,toSceneIndex:6}
        ],
        instancesTruncated:false
      }
    ]
  });
});

test("excluye ventanas con escenas truncadas y cuenta las ventanas vacías", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1","La alarma sonó.","***",
    "ESCENA 2","El patio quedó vacío.","***",
    "ESCENA 3","La campana repicó.","***",
    "ESCENA 4","La biblioteca cerró.","***",
    "ESCENA 5","El silencio continuó."
  ].join("\n");
  const alarmStart=text.indexOf("La alarma sonó.");
  const bellStart=text.indexOf("La campana repicó.");
  const knownEvents=[
    ...Array.from({length:101},(_,index)=>({
      eventId:"alarm-"+String(index).padStart(3,"0"),
      label:"Alarma "+index,
      participants:[],
      evidence:[{
        documentId:"chapter",revision:16,
        start:alarmStart,end:alarmStart+"La alarma sonó.".length,
        excerpt:"La alarma sonó."
      }]
    })),
    {
      eventId:"bell",label:"Campana",participants:[],
      evidence:[{
        documentId:"chapter",revision:16,
        start:bellStart,end:bellStart+"La campana repicó.".length,
        excerpt:"La campana repicó."
      }]
    }
  ];
  const result=analyzeLiteraryFragment({
    projectId:"event-sequence-truncation",documentId:"chapter",revision:16,text,knownEvents
  });

  assert.equal(result.explicitScenes[0].eventLinks.length,100);
  assert.equal(result.explicitScenes[0].eventLinksTruncated,true);
  assert.deepEqual(result.sceneEventSequenceMotifs,{
    explicitSceneCount:5,
    candidateWindowCount:7,
    analyzedWindowCount:4,
    emptyWindowCount:1,
    sourceTruncatedWindowCount:2,
    motifCount:0,
    omittedMotifCount:0,
    motifs:[]
  });
});


test("limita las instancias expuestas de cada motivo de secuencia", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const lines=[];
  for(let index=1;index<=25;index++) {
    lines.push("ESCENA "+index,"La señal persiste.");
    if(index<25) lines.push("***");
  }
  const text=lines.join("\n");
  const evidence=[];
  let cursor=0;
  while(true) {
    const start=text.indexOf("La señal persiste.",cursor);
    if(start<0) break;
    evidence.push({
      documentId:"chapter",revision:17,
      start,end:start+"La señal persiste.".length,excerpt:"La señal persiste."
    });
    cursor=start+"La señal persiste.".length;
  }
  const result=analyzeLiteraryFragment({
    projectId:"event-sequence-instance-limit",documentId:"chapter",revision:17,text,
    knownEvents:[{
      eventId:"signal",label:"La señal",participants:[],evidence
    }]
  });

  assert.equal(result.sceneEventSequenceMotifs.candidateWindowCount,47);
  assert.equal(result.sceneEventSequenceMotifs.analyzedWindowCount,47);
  assert.equal(result.sceneEventSequenceMotifs.motifCount,2);
  assert.equal(result.sceneEventSequenceMotifs.motifs.length,2);
  assert.deepEqual(
    result.sceneEventSequenceMotifs.motifs.map(motif=>({
      sceneCount:motif.sceneCount,
      occurrenceCount:motif.occurrenceCount,
      instanceCount:motif.instances.length,
      instancesTruncated:motif.instancesTruncated
    })),
    [
      {sceneCount:2,occurrenceCount:24,instanceCount:20,instancesTruncated:true},
      {sceneCount:3,occurrenceCount:23,instanceCount:20,instancesTruncated:true}
    ]
  );
});

test("compara cambios de evidencia y menciones nominales de participantes entre escenas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1","Ana vio la alarma. Bruno aguardó.","***",
    "ESCENA 2","La alarma volvió a sonar. La alarma persistió.","***",
    "ESCENA 3","Bruno cerró la puerta."
  ].join("\n");
  const evidenceForAll = excerpt => {
    const evidence=[];
    let cursor=0;
    while(true) {
      const start=text.indexOf(excerpt,cursor);
      if(start<0) break;
      evidence.push({
        documentId:"chapter",revision:18,
        start,end:start+excerpt.length,excerpt
      });
      cursor=start+excerpt.length;
    }
    assert.ok(evidence.length>0);
    return evidence;
  };
  const result=analyzeLiteraryFragment({
    projectId:"event-association-transitions",documentId:"chapter",revision:18,text,
    knownCharacters:[
      {entityId:"ana",canonicalName:"Ana"},
      {entityId:"bruno",canonicalName:"Bruno"}
    ],
    knownEvents:[{
      eventId:"alarm",label:"Suena la alarma",participants:["ana","bruno"],
      evidence:[
        ...evidenceForAll("la alarma."),
        ...evidenceForAll("La alarma volvió a sonar."),
        ...evidenceForAll("La alarma persistió.")
      ]
    }]
  });

  assert.deepEqual(result.sceneEventAssociationTransitions,[
    {
      fromSceneIndex:1,toSceneIndex:2,eventId:"alarm",label:"Suena la alarma",
      status:"evidence-in-both-scenes",
      previousEvidenceRangeCount:1,nextEvidenceRangeCount:2,evidenceRangeCountDelta:1,
      participants:[
        {
          entityId:"ana",previousMentionedByName:true,nextMentionedByName:false,
          status:"mentioned-only-in-previous-scene"
        },
        {
          entityId:"bruno",previousMentionedByName:true,nextMentionedByName:false,
          status:"mentioned-only-in-previous-scene"
        }
      ]
    },
    {
      fromSceneIndex:2,toSceneIndex:3,eventId:"alarm",label:"Suena la alarma",
      status:"evidence-only-in-previous-scene",
      previousEvidenceRangeCount:2,nextEvidenceRangeCount:0,evidenceRangeCountDelta:-2,
      participants:[
        {
          entityId:"ana",previousMentionedByName:false,nextMentionedByName:null,
          status:"no-event-evidence-in-next-scene"
        },
        {
          entityId:"bruno",previousMentionedByName:false,nextMentionedByName:null,
          status:"no-event-evidence-in-next-scene"
        }
      ]
    }
  ]);
});

test("no interpreta como discontinuidad una escena con vínculos de eventos truncados", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1","La alarma sonó.","***",
    "ESCENA 2","Ana escuchó la señal."
  ].join("\n");
  const firstStart=text.indexOf("La alarma sonó.");
  const secondStart=text.indexOf("Ana escuchó la señal.");
  const knownEvents=Array.from({length:101},(_,index)=>({
    eventId:"event-"+String(index).padStart(3,"0"),
    label:"Evento "+index,
    participants:["ana"],
    evidence:[
      {
        documentId:"chapter",revision:19,
        start:firstStart,end:firstStart+"La alarma sonó.".length,
        excerpt:"La alarma sonó."
      },
      ...(index===100?[{
        documentId:"chapter",revision:19,
        start:secondStart,end:secondStart+"Ana escuchó la señal.".length,
        excerpt:"Ana escuchó la señal."
      }]:[])
    ]
  }));
  const result=analyzeLiteraryFragment({
    projectId:"event-association-source-truncation",
    documentId:"chapter",revision:19,text,
    knownCharacters:[{entityId:"ana",canonicalName:"Ana"}],
    knownEvents
  });

  assert.equal(result.explicitScenes[0].eventLinksTruncated,true);
  assert.equal(result.explicitScenes[1].eventLinksTruncated,false);
  const transition=result.sceneEventAssociationTransitions.find(item=>item.eventId==="event-100");
  assert.deepEqual(transition,{
    fromSceneIndex:1,toSceneIndex:2,
    eventId:"event-100",label:"Evento 100",
    status:"source-truncated-in-previous-scene",
    previousEvidenceRangeCount:null,
    nextEvidenceRangeCount:1,
    evidenceRangeCountDelta:null,
    participants:[
      {
        entityId:"ana",
        previousMentionedByName:null,
        nextMentionedByName:true,
        status:"source-truncated-in-previous-scene"
      }
    ]
  });
});

test("la API publica comparaciones de continuidad con evidencia narrativa persistida", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({store});
  api.initializeProject({projectId:"scene-continuity-api",projectName:"Continuidad"});
  const text = [
    "ESCENA: Umbral",
    "Ana abrió la puerta. La alarma sonó.",
    "***",
    "ESCENA: Pasillo",
    "Ana cerró la ventana. La alarma volvió a sonar."
  ].join("\n");
  const passages = ["La alarma sonó.","La alarma volvió a sonar."];
  await store.saveEntity({
    projectId:"scene-continuity-api",id:"ana",kind:"character",canonicalName:"Ana",
    normalizedName:"ana",aliases:[],evidence:[],firstSeenAt:1,lastSeenAt:1,extractionVersion:1
  });
  await store.saveEvent({
    projectId:"scene-continuity-api",id:"alarm",label:"Alarma",participants:["ana"],
    evidence:passages.map(excerpt => {
      const start = text.indexOf(excerpt);
      return {documentId:"chapter",revision:2,start,end:start+excerpt.length,excerpt};
    })
  });
  await api.openDocument({documentId:"chapter",text,revision:2,sequence:0});
  const before = api.getSnapshot("chapter");
  const result = await api.analyzeLiteraryDocument("chapter");

  assert.equal(result.sceneContinuity.length,1);
  assert.equal(result.sceneContinuity[0].characterSignals[0].status,"mentioned-in-both-scenes");
  assert.equal(result.sceneContinuity[0].eventSignals[0].status,"evidence-in-both-scenes");
  assert.deepEqual(api.getSnapshot("chapter"),before);
});

test("la API relaciona personajes del proyecto con escenas por nombre y alias", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({store});
  api.initializeProject({projectId:"scene-entity-integration",projectName:"Continuidad"});
  await store.saveEntity({
    projectId:"scene-entity-integration",id:"ana",kind:"character",
    canonicalName:"Ana",normalizedName:"ana",aliases:["La viajera"],evidence:[],
    firstSeenAt:1,lastSeenAt:1,extractionVersion:1
  });
  await store.saveEntity({
    projectId:"scene-entity-integration",id:"luis",kind:"character",
    canonicalName:"Luis",normalizedName:"luis",aliases:[],evidence:[],
    firstSeenAt:1,lastSeenAt:1,extractionVersion:1
  });
  const text = "ESCENA: Estación\nLa viajera llegó. Ana saludó a Luis.";
  await api.openDocument({documentId:"chapter",text,revision:0,sequence:0});
  const result = await api.analyzeLiteraryDocument("chapter");
  assert.equal(result.explicitScenes.length,1);
  assert.equal(result.explicitScenes[0].characterMentions.length,2);
  assert.deepEqual(
    result.explicitScenes[0].characterMentions.map(item => item.entityId).sort(),
    ["ana","luis"]
  );
  const anaMention = result.explicitScenes[0].characterMentions.find(item => item.entityId === "ana");
  assert.deepEqual(anaMention?.matchedNames,["La viajera","Ana"]);
  assert.deepEqual(result.characterCoMentions[0],{
    characterIds:["ana","luis"],sharedSceneCount:1,sceneIndexes:[1]
  });
  assert.equal(api.getSnapshot("chapter").text,text);
});

test("detecta candidatos a anáfora en oraciones consecutivas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = "La noche cae sobre la plaza. La noche cubre las calles. La noche apaga las luces. Después llega el alba.";
  const result = analyzeLiteraryFragment({
    projectId:"literary-anaphora",documentId:"chapter",revision:1,text,baseOffset:30
  });
  const candidate = result.anaphoraCandidates.find(item => item.phrase === "La noche");
  assert.ok(candidate);
  assert.deepEqual(candidate.sentenceIndexes,[1,2,3]);
  assert.equal(candidate.occurrences.length,3);
  assert.ok(candidate.occurrences.every(item => item.start >= 30 && item.end > item.start));
  assert.equal(result.anaphoraCandidates.some(item => item.phrase === "Después llega"),false);
});

test("identifica vocabulario sensorial explícito sin inferir metáforas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const result = analyzeLiteraryFragment({
    projectId:"literary-senses",documentId:"chapter",revision:1,
    text:"La luz brillaba y el ruido crecía. El aroma llenó la estancia; la piel sintió el frío y el sabor amargo."
  });
  const count = modality => result.sensorySignals.find(item => item.modality === modality)?.count ?? 0;
  assert.ok(count("visual") >= 2);
  assert.ok(count("auditory") >= 1);
  assert.ok(count("olfactory") >= 1);
  assert.ok(count("tactile") >= 2);
  assert.ok(count("gustatory") >= 2);
  assert.ok(result.sensorySignals.every(signal => signal.occurrences.every(
    item => item.start >= 0 && item.end > item.start
  )));
});


test("calcula mediana, dispersión y transiciones bruscas del ritmo", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const longSentence = "La expedición atravesó lentamente el valle oscuro mientras la tormenta avanzaba sobre las montañas lejanas y distantes";
  const text = "¡Alto! " + longSentence + ". ¡Corre ahora!";
  const result = analyzeLiteraryFragment({
    projectId:"literary-rhythm",documentId:"chapter",revision:3,text,baseOffset:200
  });
  assert.ok(result.metrics.medianWordsPerSentence > 0);
  assert.ok(result.metrics.sentenceLengthStandardDeviation > 0);
  assert.equal(
    result.metrics.shortSentenceCount + result.metrics.mediumSentenceCount +
      result.metrics.longSentenceCount,
    result.metrics.sentenceCount
  );
  assert.ok(result.rhythmTransitions.some(item => item.direction === "acceleration"));
  const transition = result.rhythmTransitions.find(item => item.direction === "acceleration");
  assert.ok(transition.occurrences.every(item => item.start >= 200 && item.end > item.start));
  assert.equal(transition.beforeSentenceIndex + 1,transition.afterSentenceIndex);
});


test("detecta frases recurrentes literales de dos a cuatro palabras con evidencia", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "La puerta antigua de hierro se abrió lentamente.",
    "La puerta antigua de hierro volvió a cerrarse.",
    "El sendero oscuro condujo al río."
  ].join(" ");
  const result = analyzeLiteraryFragment({
    projectId:"literary-phrases",documentId:"chapter",revision:2,text,baseOffset:75
  });
  const candidate = result.repeatedPhrases.find(item =>
    item.phrase.toLocaleLowerCase("es") === "la puerta antigua" && item.wordCount === 3
  );
  assert.ok(candidate);
  assert.equal(candidate.count,2);
  assert.equal(candidate.occurrences.length,2);
  assert.ok(candidate.occurrences.every(item => item.start >= 75 && item.end > item.start));
  assert.ok(result.repeatedPhrases.every(item => item.wordCount >= 2 && item.wordCount <= 4));
});

test("no une frases recurrentes a través de límites de oración", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const result = analyzeLiteraryFragment({
    projectId:"literary-phrase-boundaries",documentId:"chapter",revision:1,
    text:"La noche. Oscura plaza. La noche. Oscura plaza."
  });
  assert.equal(result.repeatedPhrases.some(item => item.phrase === "La noche Oscura"),false);
});


test("describe segmentos de diálogo sin asignar hablantes por conjetura", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "—No puedo esperar —dijo Ana.",
    "—Debemos salir ahora.",
    "«Volveré mañana», respondió Luis."
  ].join("\n");
  const result = analyzeLiteraryFragment({
    projectId:"literary-dialogue-turns",documentId:"chapter",revision:5,text,baseOffset:300
  });
  assert.equal(result.metrics.dialogueSegmentCount,3);
  assert.equal(result.dialogueSegments.length,3);
  assert.deepEqual(result.dialogueSegments.map(item => item.format),
    ["dialogue-dash","dialogue-dash","quotation"]);
  assert.ok(result.dialogueSegments.every(item =>
    item.wordCount > 0 && item.occurrence.start >= 300 && item.occurrence.end > item.occurrence.start
  ));
  assert.ok(result.metrics.averageWordsPerDialogueSegment > 0);
  assert.ok(result.metrics.longestDialogueSegmentWords >= 3);
  assert.equal("speakerId" in result.dialogueSegments[0],false);
});

test("fusiona citas solapadas con una línea de diálogo para evitar doble conteo", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const result = analyzeLiteraryFragment({
    projectId:"literary-dialogue-overlap",documentId:"chapter",revision:1,
    text:"—«No volveré», dijo Ana."
  });
  assert.equal(result.metrics.dialogueSegmentCount,1);
  assert.equal(result.dialogueSegments[0].format,"mixed");
});


test("detecta capítulos, escenas y separadores explícitos sin inferir transiciones", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const prefix = "🌙\n";
  const text = prefix + [
    "# CAPÍTULO I: Llegada",
    "ESCENA 1 — La estación",
    "La viajera entró en el vestíbulo.",
    "",
    "* * *",
    "",
    "ESCENA 2: El andén",
    "El tren llegó al amanecer."
  ].join("\n");
  const result = analyzeLiteraryFragment({
    projectId:"literary-scenes",documentId:"chapter",revision:7,text,baseOffset:120
  });
  assert.deepEqual(result.structuralMarkers.map(item => item.markerType),[
    "chapter-heading","scene-heading","scene-divider","scene-heading"
  ]);
  assert.equal(result.explicitScenes.length,2);
  assert.equal(result.explicitScenes[0].sceneIndex,1);
  assert.equal(result.explicitScenes[1].sceneIndex,2);
  assert.ok(result.explicitScenes.every(item =>
    item.wordCount > 0 &&
    item.markerOccurrence.start >= 120 &&
    item.contentRange.start >= item.markerOccurrence.end &&
    item.contentRange.end > item.contentRange.start
  ));
  assert.equal(
    result.structuralMarkers[0].occurrence.start,
    120 + prefix.length
  );
  assert.equal(result.structuralMarkers[1].lineIndex,3);
});

test("no inventa escenas cuando el fragmento no contiene marcadores explícitos", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const result = analyzeLiteraryFragment({
    projectId:"literary-no-scene-inference",documentId:"chapter",revision:1,
    text:"La mañana comenzó en silencio.\n\nDespués, la puerta se abrió lentamente."
  });
  assert.deepEqual(result.structuralMarkers,[]);
  assert.deepEqual(result.explicitScenes,[]);
});


test("separa el conteo completo de menciones de las muestras limitadas por escena", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const aliases = [
    "La viajera","La exploradora","La guardiana","La cartógrafa",
    "La forastera","La testigo","La mensajera","La astrónoma",
    "La médica","La comandante","La navegante"
  ];
  const firstSceneNames = [...Array.from({length:25},() => "Ana"),...aliases];
  const text = [
    "ESCENA 1",firstSceneNames.join(". ")+".",
    "***",
    "ESCENA 2","Ana. La viajera."
  ].join("\n");
  const result = analyzeLiteraryFragment({
    projectId:"scene-character-mention-counts",documentId:"chapter",revision:2,text,baseOffset:500,
    knownCharacters:[{entityId:"ana",canonicalName:"Ana",aliases}]
  });

  const [firstScene,secondScene] = result.explicitScenes;
  const firstMention = firstScene.characterMentions[0];
  const secondMention = secondScene.characterMentions[0];
  assert.equal(firstMention.mentionCount,36);
  assert.equal(firstMention.occurrences.length,20);
  assert.equal(firstMention.occurrencesTruncated,true);
  assert.equal(firstMention.matchedNameCount,12);
  assert.equal(firstMention.matchedNames.length,10);
  assert.equal(firstMention.matchedNamesTruncated,true);
  assert.equal(firstMention.occurrences[0].start,500+text.indexOf("Ana"));
  assert.ok(firstMention.occurrences.every(item => item.start >= 500 && item.end > item.start));

  assert.equal(secondMention.mentionCount,2);
  assert.equal(secondMention.occurrences.length,2);
  assert.equal(secondMention.occurrencesTruncated,false);
  assert.equal(secondMention.matchedNameCount,2);
  assert.equal(secondMention.matchedNamesTruncated,false);

  assert.deepEqual(result.characterMentionDistributions.characters[0],{
    entityId:"ana",
    canonicalName:"Ana",
    totalMentionCount:38,
    totalSceneWordCount:50,
    mentionRatePer1000Words:760,
    mentionCountByScene:[
      {sceneIndex:1,sceneWordCount:47,mentionCount:36,mentionRatePer1000Words:765.957},
      {sceneIndex:2,sceneWordCount:3,mentionCount:2,mentionRatePer1000Words:666.667}
    ],
    sceneIndexes:[1,2],
    sceneCount:2,
    firstSceneIndex:1,
    lastSceneIndex:2,
    interveningSceneCount:0,
    longestConsecutiveSceneRun:2,
    sceneCoverageRatio:1
  });
});

test("vincula menciones literales de personajes conocidos a escenas y aliases", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = "🌌\nESCENA 1\nLa viajera Ana habló con Luis. Ana miró la puerta.\n***\nESCENA 2\nBruno esperó en silencio.";
  const result = analyzeLiteraryFragment({
    projectId:"scene-character-mentions",documentId:"chapter",revision:4,text,baseOffset:250,
    knownCharacters:[
      {entityId:"ana-id",canonicalName:"Ana",aliases:["La viajera"]},
      {entityId:"luis-id",canonicalName:"Luis",aliases:[]},
      {entityId:"bruno-id",canonicalName:"Bruno",aliases:[]}
    ]
  });
  assert.equal(result.explicitScenes.length,2);
  assert.deepEqual(result.explicitScenes[0].characterMentions.map(item => item.entityId),["ana-id","luis-id"]);
  assert.deepEqual(result.explicitScenes[0].characterMentions[0].matchedNames.sort(),["Ana","La viajera"].sort());
  assert.deepEqual(result.explicitScenes[1].characterMentions.map(item => item.entityId),["bruno-id"]);
  const anaMention = result.explicitScenes[0].characterMentions.find(item => item.entityId === "ana-id");
  assert.equal(anaMention.occurrences.length,3);
  assert.ok(anaMention.occurrences.every(item => item.start >= 250 && item.end > item.start));
  assert.equal(result.explicitScenes[1].characterMentions.some(item => item.entityId === "ana-id"),false);
});

test("omite personajes con alias ambiguos y nombres que solo aparecen como parte de otra palabra", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const result = analyzeLiteraryFragment({
    projectId:"scene-character-ambiguity",documentId:"chapter",revision:1,
    text:"ESCENA: Patio\nLa viajera esperó junto a Anabel.",
    knownCharacters:[
      {entityId:"ana-1",canonicalName:"Ana",aliases:["La viajera"]},
      {entityId:"ana-2",canonicalName:"Ariadna",aliases:["La viajera"]}
    ]
  });
  assert.deepEqual(result.explicitScenes[0].characterMentions.map(item => item.entityId),[]);
});


test("vincula acontecimientos a escenas solo con evidencia de la misma revisión", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = "ESCENA: Patio\nAna abrió la puerta. La alarma sonó.\n***\nESCENA: Calle\nAna salió corriendo.";
  const eventEvidence = "La alarma sonó.";
  const evidenceStart = text.indexOf(eventEvidence);
  const result = analyzeLiteraryFragment({
    projectId:"scene-event-links",documentId:"chapter",revision:8,text,baseOffset:400,
    knownCharacters:[{entityId:"ana",canonicalName:"Ana"}],
    knownEvents:[
      {
        eventId:"alarm",label:"Suena la alarma",participants:["ana","guard"],
        evidence:[{documentId:"chapter",revision:8,start:400+evidenceStart,end:400+evidenceStart+eventEvidence.length,excerpt:eventEvidence}]
      },
      {
        eventId:"stale-alarm",label:"Alarma histórica",participants:[],
        evidence:[{documentId:"chapter",revision:7,start:400+evidenceStart,end:400+evidenceStart+eventEvidence.length,excerpt:eventEvidence}]
      },
      {
        eventId:"other-document",label:"Otra escena",participants:[],
        evidence:[{documentId:"other",revision:8,start:400+evidenceStart,end:400+evidenceStart+eventEvidence.length,excerpt:eventEvidence}]
      }
    ]
  });
  assert.equal(result.explicitScenes.length,2);
  assert.deepEqual(result.explicitScenes[0].eventLinks.map(item => item.eventId),["alarm"]);
  assert.deepEqual(result.explicitScenes[0].eventLinks[0].participants,[
    {entityId:"ana",mentionedByName:true},
    {entityId:"guard",mentionedByName:false}
  ]);
  assert.deepEqual(result.explicitScenes[1].eventLinks,[]);
  assert.ok(result.explicitScenes[0].eventLinks[0].matchingEvidence[0].start >= 400);
});

test("traza evidencia de acontecimientos por participante sin inferir presencia o acción", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1","Ana aguardó mientras la puerta cedía.","***",
    "ESCENA 2","Bruno vio las huellas.","***",
    "ESCENA 3","Ana regresó cuando la puerta volvió a ceder.","***",
    "ESCENA 4","El patio quedó vacío."
  ].join("\n");
  const baseOffset = 900;
  const evidenceFor = excerpt => {
    const start = text.indexOf(excerpt);
    assert.notEqual(start,-1);
    return {
      documentId:"chapter",revision:6,
      start:baseOffset+start,end:baseOffset+start+excerpt.length,excerpt
    };
  };
  const result = analyzeLiteraryFragment({
    projectId:"character-event-evidence",documentId:"chapter",revision:6,text,baseOffset,
    knownCharacters:[
      {entityId:"ana",canonicalName:"Ana"},
      {entityId:"bruno",canonicalName:"Bruno"}
    ],
    knownEvents:[
      {
        eventId:"gate",label:"La puerta cede",
        participants:["ana","bruno"],
        evidence:[evidenceFor("la puerta cedía."),evidenceFor("la puerta volvió a ceder.")]
      },
      {
        eventId:"footprints",label:"Se descubren huellas",
        participants:["bruno"],
        evidence:[evidenceFor("las huellas.")]
      }
    ]
  });

  assert.equal(result.explicitScenes[0].eventLinks[0].matchingEvidenceCount,1);
  assert.equal(result.explicitScenes[0].eventLinks[0].matchingEvidenceTruncated,false);
  assert.equal(result.explicitScenes[0].eventLinksTruncated,false);
  assert.deepEqual(result.characterEventEvidenceProfiles,{
    explicitSceneCount:4,
    sourceTruncatedSceneCount:0,
    sourceTruncatedSceneIndexes:[],
    associationCount:3,
    omittedAssociationCount:0,
    characterCount:2,
    eventCount:2,
    profiles:[
      {
        entityId:"ana",canonicalName:"Ana",eventId:"gate",eventLabel:"La puerta cede",
        sceneIndexes:[1,3],eventEvidenceSceneCount:2,
        firstSceneIndex:1,lastSceneIndex:3,interveningSceneCount:1,
        totalEvidenceRangeCount:2,participantMentionedByNameSceneCount:2,
        scenes:[
          {sceneIndex:1,evidenceRangeCount:1,participantMentionedByName:true},
          {sceneIndex:2,evidenceRangeCount:null,participantMentionedByName:null},
          {sceneIndex:3,evidenceRangeCount:1,participantMentionedByName:true},
          {sceneIndex:4,evidenceRangeCount:null,participantMentionedByName:null}
        ]
      },
      {
        entityId:"bruno",canonicalName:"Bruno",eventId:"gate",eventLabel:"La puerta cede",
        sceneIndexes:[1,3],eventEvidenceSceneCount:2,
        firstSceneIndex:1,lastSceneIndex:3,interveningSceneCount:1,
        totalEvidenceRangeCount:2,participantMentionedByNameSceneCount:0,
        scenes:[
          {sceneIndex:1,evidenceRangeCount:1,participantMentionedByName:false},
          {sceneIndex:2,evidenceRangeCount:null,participantMentionedByName:null},
          {sceneIndex:3,evidenceRangeCount:1,participantMentionedByName:false},
          {sceneIndex:4,evidenceRangeCount:null,participantMentionedByName:null}
        ]
      },
      {
        entityId:"bruno",canonicalName:"Bruno",eventId:"footprints",
        eventLabel:"Se descubren huellas",
        sceneIndexes:[2],eventEvidenceSceneCount:1,
        firstSceneIndex:2,lastSceneIndex:2,interveningSceneCount:0,
        totalEvidenceRangeCount:1,participantMentionedByNameSceneCount:1,
        scenes:[
          {sceneIndex:1,evidenceRangeCount:null,participantMentionedByName:null},
          {sceneIndex:2,evidenceRangeCount:1,participantMentionedByName:true},
          {sceneIndex:3,evidenceRangeCount:null,participantMentionedByName:null},
          {sceneIndex:4,evidenceRangeCount:null,participantMentionedByName:null}
        ]
      }
    ]
  });
});

test("evalúa participantes nombrados aunque la muestra pública exceda cuarenta personajes", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const knownCharacters = Array.from({length:40},(_,index) => ({
    entityId:"character-"+String(index).padStart(3,"0"),
    canonicalName:"Personaje "+String(index).padStart(3,"0")
  }));
  knownCharacters.push({entityId:"ana",canonicalName:"Ana"});
  const text = [
    "ESCENA 1",
    knownCharacters.map(character => character.canonicalName).join(". ")+".",
    "Ana espera. La alarma sonó."
  ].join("\n");
  const excerpt = "La alarma sonó.";
  const start = text.indexOf(excerpt);
  const result = analyzeLiteraryFragment({
    projectId:"event-participant-over-character-sample",documentId:"chapter",revision:1,text,
    knownCharacters,
    knownEvents:[{
      eventId:"alarm",label:"Suena la alarma",participants:["ana"],
      evidence:[{
        documentId:"chapter",revision:1,start,end:start+excerpt.length,excerpt
      }]
    }]
  });

  assert.equal(result.explicitScenes[0].characterMentions.length,40);
  assert.equal(
    result.explicitScenes[0].characterMentions.some(item => item.entityId === "ana"),
    false
  );
  assert.equal(result.explicitScenes[0].eventLinks[0].participants[0].mentionedByName,true);
  assert.equal(
    result.characterEventEvidenceProfiles.profiles[0].participantMentionedByNameSceneCount,
    1
  );
});

test("conserva el conteo total de evidencia cuando sus rangos se limitan a veinte", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = "ESCENA 1\nLa puerta cedió.";
  const start = text.indexOf("La puerta");
  const evidence = Array.from({length:25},() => ({
    documentId:"chapter",revision:1,start,end:text.length,excerpt:"La puerta cedió."
  }));
  const result = analyzeLiteraryFragment({
    projectId:"event-evidence-truncation",documentId:"chapter",revision:1,text,
    knownEvents:[{
      eventId:"door",label:"Cede la puerta",participants:["unlisted-character"],evidence
    }]
  });
  const event = result.explicitScenes[0].eventLinks[0];
  assert.equal(event.matchingEvidenceCount,25);
  assert.equal(event.matchingEvidence.length,20);
  assert.equal(event.matchingEvidenceTruncated,true);
  assert.equal(result.explicitScenes[0].eventLinksTruncated,false);
  assert.equal(result.characterEventEvidenceProfiles.sourceTruncatedSceneCount,0);
  assert.equal(result.characterEventEvidenceProfiles.profiles[0].canonicalName,null);
  assert.equal(result.characterEventEvidenceProfiles.profiles[0].totalEvidenceRangeCount,25);
  assert.equal(result.sceneEventEvidenceProfiles.profiles[0].totalEvidenceRangeCount,25);
  assert.deepEqual(result.sceneEventEvidenceProfiles.profiles[0].scenes,[
    {sceneIndex:1,evidenceRangeCount:25,evidenceSamplesTruncated:true}
  ]);
});

test("informa escenas con más de cien acontecimientos enlazados y perfiles omitidos", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = "ESCENA 1\nLa alarma sonó.";
  const start = text.indexOf("La alarma");
  const knownEvents = Array.from({length:101},(_,index) => ({
    eventId:"event-"+String(index).padStart(3,"0"),
    label:"Acontecimiento "+index,
    participants:["character-a","character-b","character-c"],
    evidence:[{
      documentId:"chapter",revision:1,start,end:text.length,excerpt:"La alarma sonó."
    }]
  }));
  const result = analyzeLiteraryFragment({
    projectId:"event-link-scene-limit",documentId:"chapter",revision:1,text,knownEvents
  });

  assert.equal(result.explicitScenes[0].eventLinks.length,100);
  assert.equal(result.explicitScenes[0].eventLinksTruncated,true);
  assert.equal(result.characterEventEvidenceProfiles.explicitSceneCount,1);
  assert.equal(result.characterEventEvidenceProfiles.sourceTruncatedSceneCount,1);
  assert.deepEqual(result.characterEventEvidenceProfiles.sourceTruncatedSceneIndexes,[1]);
  assert.equal(result.characterEventEvidenceProfiles.associationCount,300);
  assert.equal(result.characterEventEvidenceProfiles.omittedAssociationCount,100);
  assert.equal(result.characterEventEvidenceProfiles.characterCount,3);
  assert.equal(result.characterEventEvidenceProfiles.eventCount,100);
  assert.equal(result.characterEventEvidenceProfiles.profiles.length,200);
  assert.equal(result.sceneEventEvidenceProfiles.sourceTruncatedSceneCount,1);
  assert.deepEqual(result.sceneEventEvidenceProfiles.sourceTruncatedSceneIndexes,[1]);
  assert.equal(result.sceneEventEvidenceProfiles.eventCount,100);
  assert.equal(result.sceneEventEvidenceProfiles.profiles.length,100);
});

test("limita a cien perfiles globales sin confundirlos con el tope por escena", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1","La señal inicial quedó registrada.","***",
    "ESCENA 2","La señal final apareció."
  ].join("\n");
  const evidenceFor = excerpt => {
    const start = text.indexOf(excerpt);
    assert.notEqual(start,-1);
    return {documentId:"chapter",revision:4,start,end:start+excerpt.length,excerpt};
  };
  const knownEvents = [
    ...Array.from({length:100},(_,index) => ({
      eventId:"event-"+String(index).padStart(3,"0"),
      label:"Evento "+index,
      participants:[],
      evidence:[evidenceFor("La señal inicial quedó registrada.")]
    })),
    {
      eventId:"event-100",label:"Evento 100",participants:[],
      evidence:[evidenceFor("La señal final apareció.")]
    }
  ];
  const result = analyzeLiteraryFragment({
    projectId:"scene-event-profile-limit",documentId:"chapter",revision:4,text,knownEvents
  });

  assert.equal(result.explicitScenes[0].eventLinks.length,100);
  assert.equal(result.explicitScenes[0].eventLinksTruncated,false);
  assert.equal(result.explicitScenes[1].eventLinks.length,1);
  assert.equal(result.explicitScenes[1].eventLinksTruncated,false);
  assert.equal(result.sceneEventEvidenceProfiles.eventCount,101);
  assert.equal(result.sceneEventEvidenceProfiles.omittedEventCount,1);
  assert.equal(result.sceneEventEvidenceProfiles.profiles.length,100);
  assert.deepEqual(
    result.sceneEventEvidenceProfiles.profiles.map(profile => profile.eventId),
    Array.from({length:100},(_,index) => "event-"+String(index).padStart(3,"0"))
  );
});

test("agrega patrones de co-mención de personajes por escena sin inferir relaciones", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1",
    "Ana encontró a Bruno.",
    "***",
    "ESCENA 2",
    "Bruno habló con Ana.",
    "***",
    "ESCENA 3",
    "Ana saludó a Carla."
  ].join("\n");
  const result = analyzeLiteraryFragment({
    projectId:"character-co-mentions",documentId:"chapter",revision:3,text,
    knownCharacters:[
      {entityId:"ana",canonicalName:"Ana"},
      {entityId:"bruno",canonicalName:"Bruno"},
      {entityId:"carla",canonicalName:"Carla"}
    ]
  });

  assert.deepEqual(result.characterCoMentions,[
    {characterIds:["ana","bruno"],sharedSceneCount:2,sceneIndexes:[1,2]},
    {characterIds:["ana","carla"],sharedSceneCount:1,sceneIndexes:[3]}
  ]);
});

test("resume la distribución de menciones literales de personajes entre escenas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1","Ana observa el camino.","***",
    "ESCENA 2","Ana llama a Bruno.","***",
    "ESCENA 3","Carla espera junto al río.","***",
    "ESCENA 4","Ana vuelve. Bruno escucha.","***",
    "ESCENA 5","Ana recuerda la llegada."
  ].join("\n");
  const result = analyzeLiteraryFragment({
    projectId:"character-mention-distribution",documentId:"chapter",revision:9,text,
    knownCharacters:[
      {entityId:"ana",canonicalName:"Ana"},
      {entityId:"bruno",canonicalName:"Bruno"},
      {entityId:"carla",canonicalName:"Carla"},
      {entityId:"diego",canonicalName:"Diego"}
    ]
  });

  assert.deepEqual(result.characterMentionDistributions,{
    explicitSceneCount:5,
    characterCount:3,
    omittedCharacterCount:0,
    characters:[
      {
        entityId:"ana",canonicalName:"Ana",totalMentionCount:4,
        totalSceneWordCount:21,mentionRatePer1000Words:190.476,
        mentionCountByScene:[
          {sceneIndex:1,sceneWordCount:4,mentionCount:1,mentionRatePer1000Words:250},
          {sceneIndex:2,sceneWordCount:4,mentionCount:1,mentionRatePer1000Words:250},
          {sceneIndex:3,sceneWordCount:5,mentionCount:0,mentionRatePer1000Words:0},
          {sceneIndex:4,sceneWordCount:4,mentionCount:1,mentionRatePer1000Words:250},
          {sceneIndex:5,sceneWordCount:4,mentionCount:1,mentionRatePer1000Words:250}
        ],
        sceneIndexes:[1,2,4,5],sceneCount:4,firstSceneIndex:1,lastSceneIndex:5,
        interveningSceneCount:1,longestConsecutiveSceneRun:2,sceneCoverageRatio:0.8
      },
      {
        entityId:"bruno",canonicalName:"Bruno",totalMentionCount:2,
        totalSceneWordCount:21,mentionRatePer1000Words:95.238,
        mentionCountByScene:[
          {sceneIndex:1,sceneWordCount:4,mentionCount:0,mentionRatePer1000Words:0},
          {sceneIndex:2,sceneWordCount:4,mentionCount:1,mentionRatePer1000Words:250},
          {sceneIndex:3,sceneWordCount:5,mentionCount:0,mentionRatePer1000Words:0},
          {sceneIndex:4,sceneWordCount:4,mentionCount:1,mentionRatePer1000Words:250},
          {sceneIndex:5,sceneWordCount:4,mentionCount:0,mentionRatePer1000Words:0}
        ],
        sceneIndexes:[2,4],sceneCount:2,firstSceneIndex:2,lastSceneIndex:4,
        interveningSceneCount:1,longestConsecutiveSceneRun:1,sceneCoverageRatio:0.4
      },
      {
        entityId:"carla",canonicalName:"Carla",totalMentionCount:1,
        totalSceneWordCount:21,mentionRatePer1000Words:47.619,
        mentionCountByScene:[
          {sceneIndex:1,sceneWordCount:4,mentionCount:0,mentionRatePer1000Words:0},
          {sceneIndex:2,sceneWordCount:4,mentionCount:0,mentionRatePer1000Words:0},
          {sceneIndex:3,sceneWordCount:5,mentionCount:1,mentionRatePer1000Words:200},
          {sceneIndex:4,sceneWordCount:4,mentionCount:0,mentionRatePer1000Words:0},
          {sceneIndex:5,sceneWordCount:4,mentionCount:0,mentionRatePer1000Words:0}
        ],
        sceneIndexes:[3],sceneCount:1,firstSceneIndex:3,lastSceneIndex:3,
        interveningSceneCount:0,longestConsecutiveSceneRun:1,sceneCoverageRatio:0.2
      }
    ]
  });
  assert.equal(
    result.characterMentionDistributions.characters.some(item => item.entityId === "diego"),
    false
  );
});

test("la distribución de menciones queda vacía sin escenas explícitas ni coincidencias", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const result = analyzeLiteraryFragment({
    projectId:"character-mention-distribution-empty",documentId:"chapter",revision:1,
    text:"Ana camina por la plaza.",
    knownCharacters:[{entityId:"ana",canonicalName:"Ana"}]
  });
  assert.deepEqual(result.characterMentionDistributions,{
    explicitSceneCount:0,characterCount:0,omittedCharacterCount:0,characters:[]
  });
});

test("limita a cien perfiles de personajes e informa los omitidos", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const knownCharacters = Array.from({length:101},(_,index) => {
    const suffix = String(index).padStart(3,"0");
    return {entityId:"person-"+suffix,canonicalName:"Personaje "+suffix};
  });
  const names = knownCharacters.map(item => item.canonicalName);
  const text = [
    "ESCENA 1",names.slice(0,34).join(" "),"***",
    "ESCENA 2",names.slice(34,68).join(" "),"***",
    "ESCENA 3",names.slice(68).join(" ")
  ].join("\n");
  const result = analyzeLiteraryFragment({
    projectId:"character-mention-distribution-limit",documentId:"chapter",revision:1,
    text,knownCharacters
  });

  assert.equal(result.characterMentionDistributions.explicitSceneCount,3);
  assert.equal(result.characterMentionDistributions.characterCount,101);
  assert.equal(result.characterMentionDistributions.omittedCharacterCount,1);
  assert.equal(result.characterMentionDistributions.characters.length,100);
  assert.equal(result.characterMentionDistributions.characters[0].entityId,"person-000");
  assert.equal(result.characterMentionDistributions.characters[99].entityId,"person-099");
});

test("clasifica señales gramaticales por escena y excluye el diálogo", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1",
    "Yo recuerdo el camino. «Él conoce la salida», dijo Ana.",
    "***",
    "ESCENA 2",
    "Ella caminaba hacia el río. Tú observabas desde lejos."
  ].join("\n");
  const baseOffset = 125;
  const result = analyzeLiteraryFragment({
    projectId:"scene-voice-signals",documentId:"chapter",revision:4,text,baseOffset
  });

  assert.equal(result.explicitScenes.length,2);
  assert.deepEqual(result.explicitScenes[0].voiceSignals.counts,{
    firstPerson:1,secondPerson:0,thirdPerson:0
  });
  assert.equal(result.explicitScenes[0].voiceSignals.classification,"first-person-signals");
  assert.deepEqual(result.explicitScenes[1].voiceSignals.counts,{
    firstPerson:0,secondPerson:1,thirdPerson:1
  });
  assert.equal(result.explicitScenes[1].voiceSignals.classification,"mixed-signals");
  assert.ok(result.explicitScenes.every(scene =>
    scene.voiceSignals.samples.every(sample =>
      sample.start >= scene.contentRange.start && sample.end <= scene.contentRange.end
    )
  ));
  assert.equal(result.explicitScenes[0].voiceSignals.samples.some(sample => sample.term === "Él"),false);
});

test("compara variaciones de señales gramaticales entre escenas contiguas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1",
    "Yo recuerdo el camino. «Él conoce la salida», dijo Ana.",
    "***",
    "ESCENA 2",
    "Ella caminaba hacia el río. Tú observabas desde lejos.",
    "***",
    "ESCENA 3",
    "La tormenta cubrió el valle."
  ].join("\n");
  const result = analyzeLiteraryFragment({
    projectId:"scene-voice-transitions",documentId:"chapter",revision:6,text,baseOffset:250
  });

  assert.equal(result.sceneVoiceTransitions.length,2);
  assert.deepEqual(result.sceneVoiceTransitions[0],{
    fromSceneIndex:1,
    toSceneIndex:2,
    previousClassification:"first-person-signals",
    nextClassification:"mixed-signals",
    classificationChanged:true,
    countDelta:{firstPerson:-1,secondPerson:1,thirdPerson:1},
    changedCategories:["firstPerson","secondPerson","thirdPerson"]
  });
  assert.deepEqual(result.sceneVoiceTransitions[1],{
    fromSceneIndex:2,
    toSceneIndex:3,
    previousClassification:"mixed-signals",
    nextClassification:"undetermined",
    classificationChanged:true,
    countDelta:{firstPerson:0,secondPerson:-1,thirdPerson:-1},
    changedCategories:["secondPerson","thirdPerson"]
  });
  assert.equal(result.sceneVoiceTransitions[0].fromSceneIndex+1,
    result.sceneVoiceTransitions[0].toSceneIndex);
  assert.equal(result.explicitScenes[0].voiceSignals.samples.some(sample => sample.term === "Él"),false);

  assert.equal(result.explicitScenes[0].wordCount,10);
  assert.equal(result.explicitScenes[0].narrativeWordCount,6);
  assert.equal(result.explicitScenes[1].narrativeWordCount,9);
  assert.equal(result.explicitScenes[2].narrativeWordCount,5);
  assert.deepEqual(result.sceneVoiceProfile,{
    sceneCount:3,
    totalSignals:3,
    totalNarrativeWordCount:20,
    categoryTotals:{firstPerson:1,secondPerson:1,thirdPerson:1},
    categoryRatesPer1000Words:{firstPerson:50,secondPerson:50,thirdPerson:50},
    totalRatePer1000Words:150,
    classificationSceneCounts:{
      firstPerson:1,secondPerson:0,thirdPerson:0,mixed:1,undetermined:1
    },
    categoryCoverage:[
      {category:"firstPerson",occurrences:1,scenesWithOccurrences:1,sceneShare:0.333},
      {category:"secondPerson",occurrences:1,scenesWithOccurrences:1,sceneShare:0.333},
      {category:"thirdPerson",occurrences:1,scenesWithOccurrences:1,sceneShare:0.333}
    ],
    sceneSnapshots:[
      {sceneIndex:1,classification:"first-person-signals",
        counts:{firstPerson:1,secondPerson:0,thirdPerson:0},totalSignals:1,
        narrativeWordCount:6,ratesPer1000Words:{firstPerson:166.667,secondPerson:0,thirdPerson:0},
        totalRatePer1000Words:166.667},
      {sceneIndex:2,classification:"mixed-signals",
        counts:{firstPerson:0,secondPerson:1,thirdPerson:1},totalSignals:2,
        narrativeWordCount:9,ratesPer1000Words:{firstPerson:0,secondPerson:111.111,thirdPerson:111.111},
        totalRatePer1000Words:222.222},
      {sceneIndex:3,classification:"undetermined",
        counts:{firstPerson:0,secondPerson:0,thirdPerson:0},totalSignals:0,
        narrativeWordCount:5,ratesPer1000Words:{firstPerson:0,secondPerson:0,thirdPerson:0},
        totalRatePer1000Words:0}
    ]
  });
});

test("resume el ritmo de cada escena y compara sus cambios por separado de las señales gramaticales", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1",
    "Yo camino despacio por la calle vacía. Yo miro las ventanas de las casas. Yo escucho el viento entre los árboles.",
    "***",
    "ESCENA 2",
    "Elena contempló el horizonte mientras la tormenta avanzaba sobre las montañas y las luces distantes desaparecían detrás de una cortina de lluvia que cubría lentamente el valle entero. Ella cerró la puerta y esperó."
  ].join("\n");
  const baseOffset = 400;
  const result = analyzeLiteraryFragment({
    projectId:"scene-rhythm",documentId:"chapter",revision:2,text,baseOffset
  });
  const [first,second] = result.explicitScenes;

  assert.equal(first.rhythmSignals.sentenceCount,3);
  assert.equal(first.rhythmSignals.averageWordsPerSentence,7);
  assert.equal(first.rhythmSignals.rhythmProfile,"fragmented");
  assert.equal(first.rhythmSignals.shortSentenceCount,3);
  assert.equal(first.rhythmSignals.transitions.length,0);
  assert.equal(second.rhythmSignals.sentenceCount,2);
  assert.equal(second.rhythmSignals.averageWordsPerSentence,17);
  assert.equal(second.rhythmSignals.rhythmProfile,"balanced");
  assert.equal(second.rhythmSignals.shortestSentenceWords,6);
  assert.equal(second.rhythmSignals.longestSentenceWords,28);
  assert.deepEqual(
    second.rhythmSignals.transitions.map(({beforeSentenceIndex,afterSentenceIndex,direction}) => ({
      beforeSentenceIndex,afterSentenceIndex,direction
    })),
    [{beforeSentenceIndex:1,afterSentenceIndex:2,direction:"acceleration"}]
  );
  assert.equal(second.rhythmSignals.transitions[0].occurrences[0].start,
    baseOffset+text.indexOf("Elena contempló"));
  assert.equal(second.rhythmSignals.transitions[0].occurrences[1].start,
    baseOffset+text.indexOf("Ella cerró"));

  assert.deepEqual(result.sceneRhythmTransitions,[{
    fromSceneIndex:1,toSceneIndex:2,
    previousRhythmProfile:"fragmented",nextRhythmProfile:"balanced",rhythmProfileChanged:true,
    previousAverageWordsPerSentence:7,nextAverageWordsPerSentence:17,
    averageWordsPerSentenceDelta:10,
    previousSentenceCount:3,nextSentenceCount:2,sentenceCountDelta:-1,
    previousTransitionCount:0,nextTransitionCount:1,transitionCountDelta:1
  }]);
  assert.deepEqual(
    result.sceneVoiceTransitions.map(({fromSceneIndex,toSceneIndex,previousClassification,nextClassification}) => ({
      fromSceneIndex,toSceneIndex,previousClassification,nextClassification
    })),
    [{
      fromSceneIndex:1,toSceneIndex:2,
      previousClassification:"first-person-signals",nextClassification:"third-person-signals"
    }]
  );
  assert.equal(first.voiceSignals.counts.firstPerson,3);
  assert.equal(second.voiceSignals.counts.thirdPerson,1);
});

test("detecta cadencias alternantes, progresivas y estables dentro de cada escena", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const sentence = count => Array.from({length:count},() => "palabra").join(" ") + ".";
  const text = [
    "ESCENA 1",
    sentence(3),sentence(25),sentence(4),sentence(26),sentence(5),
    "***",
    "ESCENA 2",
    sentence(3),sentence(9),sentence(19),sentence(29),
    "***",
    "ESCENA 3",
    sentence(3),sentence(4),sentence(7)
  ].join("\n");
  const baseOffset = 900;
  const result = analyzeLiteraryFragment({
    projectId:"scene-cadence",documentId:"chapter",revision:3,text,baseOffset
  });
  const [alternating,ascending,stable] = result.explicitScenes.map(scene => scene.rhythmSignals.cadence);

  assert.deepEqual(alternating.sentenceBandCounts,{short:3,medium:0,long:2});
  assert.equal(alternating.bandTransitionCounts.shortToLong,2);
  assert.equal(alternating.bandTransitionCounts.longToShort,2);
  assert.equal(alternating.patternCount,1);
  assert.equal(alternating.patterns[0].patternType,"alternating-length-band-run");
  assert.equal(alternating.patterns[0].fromSentenceIndex,1);
  assert.equal(alternating.patterns[0].toSentenceIndex,5);
  assert.deepEqual(alternating.patterns[0].sentenceWordCounts,[3,25,4,26,5]);
  assert.equal(alternating.patterns[0].occurrences[0].start,
    baseOffset+text.indexOf(sentence(3)));

  assert.equal(ascending.patternCount,1);
  assert.equal(ascending.patterns[0].patternType,"ascending-length-run");
  assert.deepEqual(ascending.patterns[0].sentenceWordCounts,[3,9,19,29]);

  assert.equal(stable.patternCount,1);
  assert.equal(stable.patterns[0].patternType,"stable-length-band-run");
  assert.equal(stable.patterns[0].sentenceCount,3);
  assert.deepEqual(stable.patterns[0].lengthBands,["short","short","short"]);

  assert.deepEqual(result.explicitScenes[0].rhythmSignals.cadence.patternTypeCounts,{
    stableLengthBandRun:0,alternatingLengthBandRun:1,ascendingLengthRun:0,descendingLengthRun:0
  });
  assert.equal(result.explicitScenes[0].voiceSignals.classification,"undetermined");
  assert.equal(result.explicitScenes[0].rhythmSignals.cadence.sentenceCount,5);
  assert.equal(result.sceneVoiceTransitions.length,2);

  assert.equal(result.sceneCadenceTransitions.length,2);
  assert.deepEqual(result.sceneCadenceTransitions[0],{
    fromSceneIndex:1,toSceneIndex:2,
    sentenceBandCountDelta:{short:-2,medium:2,long:-1},
    bandTransitionCountDelta:{
      shortToShort:0,shortToMedium:1,shortToLong:-2,
      mediumToShort:0,mediumToMedium:1,mediumToLong:1,
      longToShort:-2,longToMedium:0,longToLong:0
    },
    patternCountDelta:0,
    patternTypeCountDelta:{
      stableLengthBandRun:0,alternatingLengthBandRun:-1,
      ascendingLengthRun:1,descendingLengthRun:0
    },
    newlyDetectedPatternTypes:["ascending-length-run"],
    noLongerDetectedPatternTypes:["alternating-length-band-run"]
  });
  assert.deepEqual(result.sceneCadenceTransitions[1].newlyDetectedPatternTypes,[
    "stable-length-band-run"
  ]);
  assert.deepEqual(result.sceneCadenceTransitions[1].noLongerDetectedPatternTypes,[
    "ascending-length-run"
  ]);
});

test("agrupa firmas de cadencia recurrentes entre escenas con evidencias separadas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const sentence = count => Array.from({length:count},() => "palabra").join(" ") + ".";
  const alternating = [3,25,4,26,5].map(sentence);
  const text = [
    "ESCENA 1",...alternating,
    "***",
    "ESCENA 2",...alternating,
    "***",
    "ESCENA 3",sentence(3),sentence(4),sentence(7)
  ].join("\n");
  const baseOffset = 1200;
  const result = analyzeLiteraryFragment({
    projectId:"scene-cadence-motifs",documentId:"chapter",revision:4,text,baseOffset
  });
  const analysis = result.sceneCadenceMotifs;

  assert.equal(analysis.candidatePatternCount,3);
  assert.equal(analysis.sampledPatternCount,3);
  assert.equal(analysis.omittedPatternCount,0);
  assert.equal(analysis.motifCount,1);
  assert.deepEqual(analysis.motifs[0],{
    patternType:"alternating-length-band-run",
    lengthBands:["short","long","short","long","short"],
    sceneIndexes:[1,2],
    sceneCount:2,
    occurrenceCount:2,
    instances:[
      {
        sceneIndex:1,fromSentenceIndex:1,toSentenceIndex:5,
        sentenceWordCounts:[3,25,4,26,5],
        occurrences:result.explicitScenes[0].rhythmSignals.cadence.patterns[0].occurrences,
        evidenceTruncated:false
      },
      {
        sceneIndex:2,fromSentenceIndex:1,toSentenceIndex:5,
        sentenceWordCounts:[3,25,4,26,5],
        occurrences:result.explicitScenes[1].rhythmSignals.cadence.patterns[0].occurrences,
        evidenceTruncated:false
      }
    ],
    instancesTruncated:false
  });
  assert.equal(analysis.motifs[0].instances[0].occurrences[0].start,
    baseOffset+text.indexOf(sentence(3)));
  assert.notEqual(
    analysis.motifs[0].instances[0].occurrences[0].start,
    analysis.motifs[0].instances[1].occurrences[0].start
  );
});

test("el análisis de motivos de cadencia permanece vacío sin patrones en dos escenas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const result = analyzeLiteraryFragment({
    projectId:"scene-cadence-motifs-empty",documentId:"chapter",revision:1,
    text:"ESCENA 1\nUna frase.\n***\nESCENA 2\nOtra frase."
  });
  assert.deepEqual(result.sceneCadenceMotifs,{
    candidatePatternCount:0,
    sampledPatternCount:0,
    omittedPatternCount:0,
    motifCount:0,
    motifs:[]
  });
});

test("detecta tramos estables y alternancias de señales gramaticales entre escenas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1","Yo recuerdo.","***",
    "ESCENA 2","Yo camino.","***",
    "ESCENA 3","Nosotros salimos.","***",
    "ESCENA 4","Ella mira.","***",
    "ESCENA 5","Tú esperas.","***",
    "ESCENA 6","Ella regresa.","***",
    "ESCENA 7","Tú vuelves."
  ].join("\n");
  const result = analyzeLiteraryFragment({
    projectId:"scene-voice-sequences",documentId:"chapter",revision:7,text,baseOffset:90
  });

  assert.deepEqual(
    result.sceneVoiceSequences.map(({patternType,fromSceneIndex,toSceneIndex,classifications}) => ({
      patternType,fromSceneIndex,toSceneIndex,classifications
    })),
    [
      {
        patternType:"stable-classification-run",fromSceneIndex:1,toSceneIndex:3,
        classifications:["first-person-signals","first-person-signals","first-person-signals"]
      },
      {
        patternType:"alternating-classification-run",fromSceneIndex:4,toSceneIndex:7,
        classifications:[
          "third-person-signals","second-person-signals",
          "third-person-signals","second-person-signals"
        ]
      }
    ]
  );
  assert.equal(result.sceneVoiceSequences[0].sceneSnapshots.length,3);
  assert.deepEqual(
    result.sceneVoiceSequences[1].sceneSnapshots.map(item => item.ratesPer1000Words),
    [
      {firstPerson:0,secondPerson:0,thirdPerson:500},
      {firstPerson:0,secondPerson:500,thirdPerson:0},
      {firstPerson:0,secondPerson:0,thirdPerson:500},
      {firstPerson:0,secondPerson:500,thirdPerson:0}
    ]
  );
  assert.equal(result.sceneVoiceSequences[1].sceneSnapshots[0].sceneIndex,4);
});

test("las señales mixtas e indeterminadas interrumpen patrones de voz entre escenas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1","Yo vuelvo.","***",
    "ESCENA 2","La lluvia cae.","***",
    "ESCENA 3","Ella mira.","***",
    "ESCENA 4","Tú esperas.","***",
    "ESCENA 5","Ella regresa.","***",
    "ESCENA 6","Tú vuelves."
  ].join("\n");
  const result = analyzeLiteraryFragment({
    projectId:"scene-voice-sequence-breaks",documentId:"chapter",revision:1,text
  });
  assert.deepEqual(
    result.sceneVoiceSequences.map(({patternType,fromSceneIndex,toSceneIndex}) => ({
      patternType,fromSceneIndex,toSceneIndex
    })),
    [{patternType:"alternating-classification-run",fromSceneIndex:3,toSceneIndex:6}]
  );
});

test("compara señales literales entre escenas explícitas contiguas sin inferir ausencias", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1",
    "Ana encontró la llave. La alarma sonó.",
    "***",
    "ESCENA 2",
    "Ana y Bruno cruzaron el patio. La alarma volvió a sonar.",
    "***",
    "ESCENA 3",
    "Bruno esperó junto al muro."
  ].join("\n");
  const firstEvidence = "La alarma sonó.";
  const secondEvidence = "La alarma volvió a sonar.";
  const baseOffset = 700;
  const result = analyzeLiteraryFragment({
    projectId:"scene-continuity",documentId:"chapter",revision:5,text,baseOffset,
    knownCharacters:[
      {entityId:"ana",canonicalName:"Ana"},
      {entityId:"bruno",canonicalName:"Bruno"}
    ],
    knownEvents:[{
      eventId:"alarm",label:"Alarma",participants:[],
      evidence:[firstEvidence,secondEvidence].map(excerpt => {
        const start = text.indexOf(excerpt);
        return {
          documentId:"chapter",revision:5,start:baseOffset+start,
          end:baseOffset+start+excerpt.length,excerpt
        };
      })
    }]
  });

  assert.equal(result.sceneContinuity.length,2);
  assert.deepEqual(
    result.sceneContinuity[0].characterSignals.map(({entityId,status}) => ({entityId,status})),
    [
      {entityId:"ana",status:"mentioned-in-both-scenes"},
      {entityId:"bruno",status:"mentioned-only-in-next-scene"}
    ]
  );
  assert.equal(result.sceneContinuity[0].characterSignals[0].previousMentions[0].start,
    baseOffset+text.indexOf("Ana encontró"));
  assert.equal(result.sceneContinuity[0].eventSignals[0].status,"evidence-in-both-scenes");
  assert.equal(result.sceneContinuity[0].eventSignals[0].previousEvidence[0].start,
    baseOffset+text.indexOf(firstEvidence));

  assert.deepEqual(
    result.sceneContinuity[1].characterSignals.map(({entityId,status}) => ({entityId,status})),
    [
      {entityId:"ana",status:"not-mentioned-in-next-scene"},
      {entityId:"bruno",status:"mentioned-in-both-scenes"}
    ]
  );
  assert.equal(result.sceneContinuity[1].eventSignals[0].status,"evidence-only-in-previous-scene");
  assert.equal(result.sceneContinuity[1].eventSignals[0].nextEvidence.length,0);
});

test("no convierte ausencia de mención literal en contradicción", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = "ESCENA: Noche\nLa puerta se cerró.";
  const start = text.indexOf("La puerta");
  const result = analyzeLiteraryFragment({
    projectId:"scene-event-absence",documentId:"chapter",revision:1,text,
    knownEvents:[{
      eventId:"quiet-event",label:"La guardia escucha",participants:["ana"],
      evidence:[{documentId:"chapter",revision:1,start,end:start+text.length-start,excerpt:"La puerta se cerró."}]
    }]
  });
  assert.equal(result.explicitScenes[0].eventLinks[0].participants[0].mentionedByName,false);
});


test("resume el volumen y formato del diálogo dentro de cada escena explícita", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1",
    "—Ven conmigo, Ana.",
    "«No iré», respondió Ana.",
    "La puerta quedó abierta.",
    "***",
    "ESCENA 2",
    "—Volveré mañana.",
    "El pasillo largo parecía completamente vacío bajo la luz de la luna y sin ninguna respuesta."
  ].join("\n");
  const baseOffset = 2400;
  const result = analyzeLiteraryFragment({
    projectId:"scene-dialogue",documentId:"chapter",revision:8,text,baseOffset
  });
  const [first,second] = result.explicitScenes;
  assert.equal(result.explicitScenes.length,2);
  assert.deepEqual(first.dialogueSignals,{
    segmentCount:2,
    dialogueWordCount:5,
    dialogueRatio:0.455,
    dialogueWordsPer1000NarrativeWords:833.333,
    density:"high",
    averageWordsPerSegment:2.5,
    longestSegmentWords:3,
    formatCounts:{quotation:1,dialogueDash:1,mixed:0},
    segments:[
      {
        segmentIndex:1,format:"dialogue-dash",wordCount:3,
        occurrence:{
          start:baseOffset+text.indexOf("Ven conmigo, Ana."),
          end:baseOffset+text.indexOf("Ven conmigo, Ana.")+"Ven conmigo, Ana.".length
        }
      },
      {
        segmentIndex:2,format:"quotation",wordCount:2,
        occurrence:{
          start:baseOffset+text.indexOf("No iré"),
          end:baseOffset+text.indexOf("No iré")+"No iré".length
        }
      }
    ],
    evidenceTruncated:false
  });
  assert.equal(first.narrativeWordCount,6);
  assert.equal(second.dialogueSignals.segmentCount,1);
  assert.equal(second.dialogueSignals.dialogueWordCount,2);
  assert.equal(second.dialogueSignals.formatCounts.dialogueDash,1);
  assert.equal(second.dialogueSignals.density,"moderate");
  assert.equal(second.dialogueSignals.segments[0].wordCount,2);
  assert.equal(second.dialogueSignals.segments[0].occurrence.start,
    baseOffset+text.indexOf("Volveré mañana."));
  assert.equal(second.dialogueSignals.evidenceTruncated,false);
});

test("mantiene el perfil de diálogo vacío cuando una escena no contiene segmentos reconocidos", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = "ESCENA 1\nEl jardín permaneció silencioso durante toda la tarde.";
  const result = analyzeLiteraryFragment({
    projectId:"scene-dialogue-empty",documentId:"chapter",revision:1,text
  });
  assert.deepEqual(result.explicitScenes[0].dialogueSignals,{
    segmentCount:0,
    dialogueWordCount:0,
    dialogueRatio:0,
    dialogueWordsPer1000NarrativeWords:0,
    density:"none",
    averageWordsPerSegment:0,
    longestSegmentWords:0,
    formatCounts:{quotation:0,dialogueDash:0,mixed:0},
    segments:[],
    evidenceTruncated:false
  });  assert.equal(result.explicitScenes[0].dialogueFlowSignals.paragraphCount,1);
  assert.deepEqual(result.explicitScenes[0].dialogueFlowSignals.classificationCounts,{
    narrativeOnly:1,dialogueOnly:0,mixed:0
  });
  assert.equal(result.explicitScenes[0].dialogueFlowSignals.dialogueBearingParagraphCount,0);

});

test("describe el flujo de diálogo por párrafos sin atribuir hablantes", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1",
    "La casa permanecía en silencio.",
    "",
    "—Ven conmigo, Ana.",
    "",
    "«No iré», respondió Ana.",
    "",
    "La puerta quedó abierta."
  ].join("\n");
  const baseOffset = 7300;
  const result = analyzeLiteraryFragment({
    projectId:"scene-dialogue-flow",documentId:"chapter",revision:4,text,baseOffset
  });
  const flow = result.explicitScenes[0].dialogueFlowSignals;
  assert.equal(flow.paragraphCount,4);
  assert.deepEqual(flow.classificationCounts,{narrativeOnly:2,dialogueOnly:1,mixed:1});
  assert.equal(flow.dialogueBearingParagraphCount,2);
  assert.equal(flow.dialogueBearingParagraphRatio,0.5);
  assert.deepEqual(flow.classificationTransitionCounts,{
    narrativeOnlyToNarrativeOnly:0,
    narrativeOnlyToDialogueOnly:1,
    narrativeOnlyToMixed:0,
    dialogueOnlyToNarrativeOnly:0,
    dialogueOnlyToDialogueOnly:0,
    dialogueOnlyToMixed:1,
    mixedToNarrativeOnly:1,
    mixedToDialogueOnly:0,
    mixedToMixed:0
  });
  assert.equal(flow.classificationChangeCount,3);
  assert.deepEqual(flow.paragraphs.map(paragraph => paragraph.classification),[
    "narrative-only","dialogue-only","mixed","narrative-only"
  ]);
  assert.deepEqual(flow.paragraphs.map(paragraph => paragraph.dialogueWordCount),[0,3,2,0]);
  const mixedStart = baseOffset+text.indexOf("«No iré»");
  assert.deepEqual(flow.paragraphs[2].occurrence,{
    start:mixedStart,end:mixedStart+"«No iré», respondió Ana.".length
  });
  assert.equal(flow.evidenceTruncated,false);
});

test("limita las muestras del flujo de diálogo sin truncar conteos ni transiciones", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const paragraphs = Array.from({length:45},(_,index) =>
    index%2===0 ? `La puerta ${index} permaneció abierta.` : `«Vuelve ${index} pronto».`
  );
  const text = ["ESCENA 1",...paragraphs].join("\n\n");
  const baseOffset = 8800;
  const result = analyzeLiteraryFragment({
    projectId:"scene-dialogue-flow-truncation",documentId:"chapter",revision:1,text,baseOffset
  });
  const flow = result.explicitScenes[0].dialogueFlowSignals;
  assert.equal(flow.paragraphCount,45);
  assert.deepEqual(flow.classificationCounts,{narrativeOnly:23,dialogueOnly:22,mixed:0});
  assert.equal(flow.dialogueBearingParagraphCount,22);
  assert.equal(flow.dialogueBearingParagraphRatio,0.489);
  assert.equal(flow.classificationChangeCount,44);
  assert.equal(flow.classificationTransitionCounts.narrativeOnlyToDialogueOnly,22);
  assert.equal(flow.classificationTransitionCounts.dialogueOnlyToNarrativeOnly,22);
  assert.equal(flow.paragraphs.length,40);
  assert.equal(flow.paragraphs[39].paragraphIndex,40);
  assert.equal(flow.paragraphs[39].occurrence.start,baseOffset+text.indexOf(paragraphs[39]));
  assert.equal(flow.evidenceTruncated,true);
});

test("agrega el flujo de diálogo por escena con proporciones ponderadas y cobertura", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1",
    "La casa estaba en silencio.",
    "",
    "—Ven conmigo, Ana.",
    "",
    "«No iré», respondió Ana.",
    "",
    "La puerta quedó abierta.",
    "***",
    "ESCENA 2",
    "«Regresaré pronto».",
    "",
    "El tren salió de la estación."
  ].join("\n");
  const result = analyzeLiteraryFragment({
    projectId:"scene-dialogue-flow-summary",documentId:"chapter",revision:1,text
  });
  const summary = result.sceneDialogueFlowSummary;
  assert.equal(summary.sceneCount,2);
  assert.equal(summary.totalParagraphCount,6);
  assert.deepEqual(summary.classificationCounts,{
    narrativeOnly:3,dialogueOnly:2,mixed:1
  });
  assert.equal(summary.dialogueBearingParagraphCount,3);
  assert.equal(summary.dialogueBearingParagraphRatio,0.5);
  assert.equal(summary.scenesWithDialogueParagraphs,2);
  assert.equal(summary.sceneShareWithDialogueParagraphs,1);
  assert.deepEqual(summary.classificationTransitionCounts,{
    narrativeOnlyToNarrativeOnly:0,
    narrativeOnlyToDialogueOnly:1,
    narrativeOnlyToMixed:0,
    dialogueOnlyToNarrativeOnly:1,
    dialogueOnlyToDialogueOnly:0,
    dialogueOnlyToMixed:1,
    mixedToNarrativeOnly:1,
    mixedToDialogueOnly:0,
    mixedToMixed:0
  });
  assert.equal(summary.classificationChangeCount,4);
  assert.equal(summary.totalRunCount,5);
  assert.equal(summary.dialogueBearingRunCount,2);
  assert.equal(summary.narrativeOnlyRunCount,3);
  assert.equal(summary.longestDialogueBearingRunParagraphs,2);
  assert.equal(summary.longestNarrativeOnlyRunParagraphs,1);
  assert.deepEqual(summary.sceneSnapshots.map(snapshot => snapshot.sceneIndex),[1,2]);
  assert.deepEqual(summary.sceneSnapshots.map(snapshot => snapshot.dialogueBearingParagraphCount),[2,1]);
  assert.deepEqual(summary.sceneSnapshots.map(snapshot => snapshot.runCount),[3,2]);
  assert.deepEqual(summary.sceneSnapshots.map(snapshot => snapshot.dialogueBearingRunCount),[1,1]);
  assert.deepEqual(summary.sceneSnapshots.map(snapshot => snapshot.narrativeOnlyRunCount),[2,1]);
  assert.deepEqual(summary.sceneSnapshots.map(snapshot => snapshot.longestDialogueBearingRunParagraphs),[2,1]);
});

test("mantiene vacío el resumen de flujo cuando no hay escenas explícitas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const result = analyzeLiteraryFragment({
    projectId:"scene-dialogue-flow-summary-empty",documentId:"chapter",revision:1,
    text:"Un fragmento sin encabezados explícitos."
  });
  assert.deepEqual(result.sceneDialogueFlowSummary,{
    sceneCount:0,
    totalParagraphCount:0,
    classificationCounts:{narrativeOnly:0,dialogueOnly:0,mixed:0},
    dialogueBearingParagraphCount:0,
    dialogueBearingParagraphRatio:0,
    scenesWithDialogueParagraphs:0,
    sceneShareWithDialogueParagraphs:0,
    classificationTransitionCounts:{
      narrativeOnlyToNarrativeOnly:0,
      narrativeOnlyToDialogueOnly:0,
      narrativeOnlyToMixed:0,
      dialogueOnlyToNarrativeOnly:0,
      dialogueOnlyToDialogueOnly:0,
      dialogueOnlyToMixed:0,
      mixedToNarrativeOnly:0,
      mixedToDialogueOnly:0,
      mixedToMixed:0
    },
    classificationChangeCount:0,
    totalRunCount:0,
    dialogueBearingRunCount:0,
    narrativeOnlyRunCount:0,
    longestDialogueBearingRunParagraphs:0,
    longestNarrativeOnlyRunParagraphs:0,
    sceneSnapshots:[]
  });
});

test("compara el flujo de párrafos dialogados entre escenas explícitas contiguas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1",
    "La casa estaba en silencio.",
    "",
    "—Ven conmigo, Ana.",
    "",
    "«No iré», respondió Ana.",
    "",
    "La puerta quedó abierta.",
    "***",
    "ESCENA 2",
    "«Regresaré pronto».",
    "",
    "El tren salió de la estación."
  ].join("\n");
  const result = analyzeLiteraryFragment({
    projectId:"scene-dialogue-flow-transitions",documentId:"chapter",revision:1,text
  });
  assert.equal(result.sceneDialogueFlowTransitions.length,1);
  const transition = result.sceneDialogueFlowTransitions[0];
  assert.equal(transition.fromSceneIndex,1);
  assert.equal(transition.toSceneIndex,2);
  assert.equal(transition.previousParagraphCount,4);
  assert.equal(transition.nextParagraphCount,2);
  assert.equal(transition.paragraphCountDelta,-2);
  assert.equal(transition.previousDialogueBearingParagraphCount,2);
  assert.equal(transition.nextDialogueBearingParagraphCount,1);
  assert.equal(transition.dialogueBearingParagraphCountDelta,-1);
  assert.equal(transition.previousDialogueBearingParagraphRatio,0.5);
  assert.equal(transition.nextDialogueBearingParagraphRatio,0.5);
  assert.equal(transition.dialogueBearingParagraphRatioDelta,0);
  assert.deepEqual(transition.classificationCountDelta,{
    narrativeOnly:-1,dialogueOnly:0,mixed:-1
  });
  assert.deepEqual(transition.classificationTransitionCountDelta,{
    narrativeOnlyToNarrativeOnly:0,
    narrativeOnlyToDialogueOnly:-1,
    narrativeOnlyToMixed:0,
    dialogueOnlyToNarrativeOnly:1,
    dialogueOnlyToDialogueOnly:0,
    dialogueOnlyToMixed:-1,
    mixedToNarrativeOnly:-1,
    mixedToDialogueOnly:0,
    mixedToMixed:0
  });
  assert.equal(transition.classificationChangeCountDelta,-2);
  assert.equal(transition.previousRunCount,3);
  assert.equal(transition.nextRunCount,2);
  assert.equal(transition.runCountDelta,-1);
  assert.equal(transition.previousDialogueBearingRunCount,1);
  assert.equal(transition.nextDialogueBearingRunCount,1);
  assert.equal(transition.dialogueBearingRunCountDelta,0);
  assert.equal(transition.previousNarrativeOnlyRunCount,2);
  assert.equal(transition.nextNarrativeOnlyRunCount,1);
  assert.equal(transition.narrativeOnlyRunCountDelta,-1);
  assert.equal(transition.previousLongestDialogueBearingRunParagraphs,2);
  assert.equal(transition.nextLongestDialogueBearingRunParagraphs,1);
  assert.equal(transition.longestDialogueBearingRunParagraphsDelta,-1);
  assert.equal(transition.previousLongestNarrativeOnlyRunParagraphs,1);
  assert.equal(transition.nextLongestNarrativeOnlyRunParagraphs,1);
  assert.equal(transition.longestNarrativeOnlyRunParagraphsDelta,0);
});

test("no crea transiciones de flujo de diálogo con menos de dos escenas explícitas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const result = analyzeLiteraryFragment({
    projectId:"scene-dialogue-flow-single",documentId:"chapter",revision:1,
    text:"ESCENA 1\n«Una respuesta.»"
  });
  assert.deepEqual(result.sceneDialogueFlowTransitions,[]);
});

test("compara las métricas de diálogo entre escenas explícitas contiguas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = "ESCENA 1\nLa tarde cayó lentamente. “Hola, Ana.”\n***\nESCENA 2\nEl viento cruzó la plaza.";
  const result = analyzeLiteraryFragment({
    projectId:"scene-dialogue-transitions",documentId:"chapter",revision:1,text
  });
  assert.equal(result.sceneDialogueTransitions.length,1);
  const transition = result.sceneDialogueTransitions[0];
  assert.equal(transition.fromSceneIndex,1);
  assert.equal(transition.toSceneIndex,2);
  assert.equal(transition.previousDensity,"high");
  assert.equal(transition.nextDensity,"none");
  assert.equal(transition.densityChanged,true);
  assert.equal(transition.previousSegmentCount,1);
  assert.equal(transition.nextSegmentCount,0);
  assert.equal(transition.segmentCountDelta,-1);
  assert.equal(transition.previousDialogueWordCount,2);
  assert.equal(transition.nextDialogueWordCount,0);
  assert.equal(transition.dialogueWordCountDelta,-2);
  assert.equal(transition.previousAverageWordsPerSegment,2);
  assert.equal(transition.nextAverageWordsPerSegment,0);
  assert.equal(transition.averageWordsPerSegmentDelta,-2);
  assert.equal(transition.previousLongestSegmentWords,2);
  assert.equal(transition.nextLongestSegmentWords,0);
  assert.equal(transition.longestSegmentWordsDelta,-2);
  assert.deepEqual(transition.formatCountDelta,{quotation:-1,dialogueDash:0,mixed:0});
  assert.equal(transition.dialogueRatioDelta,-0.333);
  assert.equal(transition.previousDialogueWordsPer1000NarrativeWords,500);
  assert.equal(transition.nextDialogueWordsPer1000NarrativeWords,0);
  assert.equal(transition.dialogueWordsPer1000NarrativeWordsDelta,-500);
  assert.equal(result.explicitScenes[0].dialogueSignals.dialogueWordsPer1000NarrativeWords,500);
});

test("no crea transiciones de diálogo cuando hay menos de dos escenas explícitas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const result = analyzeLiteraryFragment({
    projectId:"scene-dialogue-single",documentId:"chapter",revision:1,
    text:"ESCENA 1\n“Una frase.”"
  });
  assert.deepEqual(result.sceneDialogueTransitions,[]);
});


test("limita las evidencias de diálogo por escena sin truncar los conteos", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const segments = Array.from({length:21},() => "«palabra clara»");
  const text = ["ESCENA 1",...segments].join("\n");
  const baseOffset = 5100;
  const result = analyzeLiteraryFragment({
    projectId:"scene-dialogue-truncation",documentId:"chapter",revision:2,text,baseOffset
  });
  const profile = result.explicitScenes[0].dialogueSignals;
  const visible20Match = [...text.matchAll(/palabra clara/gu)][19];
  assert.ok(visible20Match);
  const visible20Start = visible20Match.index ?? -1;
  assert.equal(profile.segmentCount,21);
  assert.equal(profile.dialogueWordCount,42);
  assert.equal(profile.formatCounts.quotation,21);
  assert.equal(profile.averageWordsPerSegment,2);
  assert.equal(profile.longestSegmentWords,2);
  assert.equal(profile.segments.length,20);
  assert.equal(profile.evidenceTruncated,true);
  assert.equal(profile.segments[19].segmentIndex,20);
  assert.equal(profile.segments[19].occurrence.start,baseOffset+visible20Start);
  assert.equal(profile.segments[19].occurrence.end,baseOffset+visible20Start+"palabra clara".length);
});

test("recorta una cita que atraviesa un separador sin incluir encabezados en las escenas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1",
    "«Luz tenue",
    "***",
    "ESCENA 2",
    "y sombra al final»."
  ].join("\n");
  const baseOffset = 6300;
  const result = analyzeLiteraryFragment({
    projectId:"scene-dialogue-boundary",documentId:"chapter",revision:3,text,baseOffset
  });
  const [first,second] = result.explicitScenes;
  assert.equal(result.explicitScenes.length,2);
  assert.equal(first.wordCount,2);
  assert.equal(second.wordCount,4);
  assert.equal(first.dialogueSignals.segmentCount,1);
  assert.equal(first.dialogueSignals.dialogueWordCount,2);
  assert.equal(second.dialogueSignals.segmentCount,1);
  assert.equal(second.dialogueSignals.dialogueWordCount,4);
  assert.equal(first.dialogueSignals.segments[0].occurrence.start,
    baseOffset+text.indexOf("Luz"));
  assert.equal(first.dialogueSignals.segments[0].occurrence.end,
    baseOffset+text.indexOf("tenue")+"tenue".length);
  assert.equal(second.dialogueSignals.segments[0].occurrence.start,
    baseOffset+text.indexOf("y sombra"));
  assert.equal(second.dialogueSignals.segments[0].occurrence.end,
    baseOffset+text.indexOf("final")+"final".length);
  assert.equal(first.dialogueSignals.dialogueRatio,1);
  assert.equal(second.dialogueSignals.dialogueRatio,1);
});


test("describe un solapamiento entre cita y raya como un único segmento mixto por escena", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = "ESCENA 1\n—«No volveré», dijo Ana.";
  const baseOffset = 950;
  const result = analyzeLiteraryFragment({
    projectId:"scene-dialogue-overlap",documentId:"chapter",revision:1,text,baseOffset
  });
  const profile = result.explicitScenes[0].dialogueSignals;
  assert.equal(result.dialogueSegments.length,1);
  assert.equal(result.dialogueSegments[0].format,"mixed");
  assert.equal(profile.segmentCount,1);
  assert.equal(profile.dialogueWordCount,4);
  assert.equal(profile.dialogueRatio,1);
  assert.deepEqual(profile.formatCounts,{quotation:0,dialogueDash:0,mixed:1});
  assert.equal(profile.segments[0].format,"mixed");
  assert.equal(profile.segments[0].wordCount,4);
  assert.deepEqual(profile.segments[0].occurrence,{
    start:baseOffset+text.indexOf("«"),
    end:baseOffset+text.length
  });
});

test("agrupa bloques consecutivos del flujo de diálogo y conserva los offsets de cada tramo", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const text = [
    "ESCENA 1",
    "La lluvia cesó.",
    "",
    "«Ven aquí», dijo Ana.",
    "",
    "«Ahora mismo».",
    "",
    "El tren partió."
  ].join("\n");
  const baseOffset = 8700;
  const result = analyzeLiteraryFragment({
    projectId:"scene-dialogue-flow-runs",documentId:"chapter",revision:4,text,baseOffset
  });
  const flow = result.explicitScenes[0].dialogueFlowSignals;
  assert.equal(flow.runCount,3);
  assert.equal(flow.dialogueBearingRunCount,1);
  assert.equal(flow.narrativeOnlyRunCount,2);
  assert.equal(flow.longestDialogueBearingRunParagraphs,2);
  assert.equal(flow.longestNarrativeOnlyRunParagraphs,1);
  assert.equal(flow.runsTruncated,false);
  assert.deepEqual(flow.runs.map(run => ({
    runIndex:run.runIndex,
    kind:run.kind,
    fromParagraphIndex:run.fromParagraphIndex,
    toParagraphIndex:run.toParagraphIndex,
    paragraphCount:run.paragraphCount,
    narrativeOnlyParagraphCount:run.narrativeOnlyParagraphCount,
    dialogueOnlyParagraphCount:run.dialogueOnlyParagraphCount,
    mixedParagraphCount:run.mixedParagraphCount
  })),[
    {
      runIndex:1,kind:"narrative-only-run",fromParagraphIndex:1,toParagraphIndex:1,
      paragraphCount:1,narrativeOnlyParagraphCount:1,dialogueOnlyParagraphCount:0,mixedParagraphCount:0
    },
    {
      runIndex:2,kind:"dialogue-bearing-run",fromParagraphIndex:2,toParagraphIndex:3,
      paragraphCount:2,narrativeOnlyParagraphCount:0,dialogueOnlyParagraphCount:1,mixedParagraphCount:1
    },
    {
      runIndex:3,kind:"narrative-only-run",fromParagraphIndex:4,toParagraphIndex:4,
      paragraphCount:1,narrativeOnlyParagraphCount:1,dialogueOnlyParagraphCount:0,mixedParagraphCount:0
    }
  ]);
  assert.equal(flow.runs[0].occurrence.start,baseOffset+text.indexOf("La lluvia"));
  assert.equal(flow.runs[0].occurrence.end,baseOffset+text.indexOf("cesó.")+"cesó.".length);
  assert.equal(flow.runs[1].occurrence.start,baseOffset+text.indexOf("«Ven aquí»"));
  assert.equal(flow.runs[1].occurrence.end,baseOffset+text.indexOf("«Ahora mismo».")+"«Ahora mismo».".length);
  assert.equal(flow.runs[2].occurrence.start,baseOffset+text.indexOf("El tren"));
  assert.equal(flow.runs[2].occurrence.end,baseOffset+text.indexOf("partió.")+"partió.".length);
});

test("limita las muestras de tramos del flujo sin truncar sus métricas", async () => {
  const { analyzeLiteraryFragment } = await import("../dist/motor-literario.js");
  const paragraphs = Array.from({length:41},(_,index) =>
    index % 2 === 0 ? "La noche cayó." : "«Estoy aquí»."
  );
  const text = ["ESCENA 1",paragraphs.join("\n\n")].join("\n");
  const result = analyzeLiteraryFragment({
    projectId:"scene-dialogue-flow-run-truncation",documentId:"chapter",revision:1,text
  });
  const flow = result.explicitScenes[0].dialogueFlowSignals;
  assert.equal(flow.paragraphCount,41);
  assert.equal(flow.runCount,41);
  assert.equal(flow.dialogueBearingRunCount,20);
  assert.equal(flow.narrativeOnlyRunCount,21);
  assert.equal(flow.longestDialogueBearingRunParagraphs,1);
  assert.equal(flow.longestNarrativeOnlyRunParagraphs,1);
  assert.equal(flow.runs.length,40);
  assert.equal(flow.runsTruncated,true);
  assert.equal(flow.runs[39].runIndex,40);
  assert.equal(flow.runs[39].fromParagraphIndex,40);
});

test("la API incorpora afirmaciones almacenadas a la evolución de atributos entre escenas", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "literary-attribute-api", projectName: "Atributos" });
  const text = [
    "Escena 1",
    "Ana cruzó el patio al amanecer.",
    "Escena 2",
    "Ana regresó por la puerta norte."
  ].join("\n");
  await store.saveEntity({
    projectId: "literary-attribute-api",
    id: "ana",
    kind: "character",
    canonicalName: "Ana",
    normalizedName: "ana",
    aliases: [],
    evidence: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
    extractionVersion: 1
  });
  const first = "Ana cruzó el patio al amanecer.";
  const second = "Ana regresó por la puerta norte.";
  const firstStart = text.indexOf(first);
  const secondStart = text.indexOf(second);
  await store.saveAssertion({
    projectId: "literary-attribute-api",
    id: "ana-age-20",
    entityId: "ana",
    entityName: "Ana",
    attribute: "age",
    value: 20,
    evidence: {
      documentId: "chapter",
      revision: 0,
      start: firstStart,
      end: firstStart + first.length,
      excerpt: first
    },
    capturedAt: 1
  });
  await store.saveAssertion({
    projectId: "literary-attribute-api",
    id: "ana-age-21",
    entityId: "ana",
    entityName: "Ana",
    attribute: "age",
    value: 21,
    evidence: {
      documentId: "chapter",
      revision: 0,
      start: secondStart,
      end: secondStart + second.length,
      excerpt: second
    },
    capturedAt: 2
  });
  await api.openDocument({ documentId: "chapter", text, revision: 0, sequence: 0 });
  const result = await api.analyzeLiteraryDocument("chapter");
  const profile = result.characterAttributeEvolution.profiles.find(item =>
    item.entityId === "ana" && item.attribute === "age"
  );

  assert.ok(profile);
  assert.deepEqual(profile.scenes.map(item => item.values), [[20], [21]]);
  assert.equal(profile.transitions[0].status, "changed-value");
  const trajectory=result.characterNarrativeTrajectories.trajectories.find(item => item.entityId==="ana");
  assert.ok(trajectory);
  assert.deepEqual(trajectory.attributes.find(item => item.attribute==="age").scenes
    .map(item => item.values),[[20],[21]]);
  assert.deepEqual(trajectory.scenes.map(item => item.attributeValues[0].values),[[20],[21]]);
});

test("la API integra relaciones y decisiones persistidas en la trayectoria del personaje", async () => {
  const store = new MemoryStore();
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId: "character-arc-api", projectName: "Arcos" });
  const text = [
    "Escena 1",
    "Ana habló con Bruno. La promesa quedó registrada.",
    "Escena 2",
    "Ana regresó al refugio."
  ].join("\n");
  const phrase = "Ana habló con Bruno.";
  const start = text.indexOf(phrase);
  for (const [id,name] of [["ana","Ana"],["bruno","Bruno"]]) {
    await store.saveEntity({
      projectId: "character-arc-api",
      id,
      kind: "character",
      canonicalName: name,
      normalizedName: name.toLocaleLowerCase("es"),
      aliases: [],
      evidence: [],
      firstSeenAt: 1,
      lastSeenAt: 1,
      extractionVersion: 1
    });
  }
  await store.saveRelation({
    projectId: "character-arc-api",
    id: "ana-bruno",
    fromEntityId: "ana",
    toEntityId: "bruno",
    relationType: "alliance",
    evidence: [{
      documentId: "chapter",
      revision: 0,
      start,
      end: start + phrase.length,
      excerpt: phrase
    }]
  });
  await store.saveIdea({
    projectId: "character-arc-api",
    id: "ana-promise-decision",
    text: "Ana decide cumplir la promesa.",
    status: "incorporated",
    originDocumentId: "chapter",
    sourceProjectName: "Arcos",
    evidence: [{
      documentId: "chapter",
      revision: 0,
      start,
      end: start + phrase.length,
      excerpt: phrase
    }],
    relatedEntityIds: ["ana"],
    relatedIdeaIds: [],
    statusHistory: [
      { status: "IDEA", reason: "initial", changedAt: 1 },
      { status: "incorporated", reason: "writer", changedAt: 2 }
    ]
  });
  await api.openDocument({ documentId: "chapter", text, revision: 0, sequence: 0 });
  const result = await api.analyzeLiteraryDocument("chapter");
  const ana = result.characterNarrativeTrajectories.trajectories.find(item => item.entityId === "ana");
  assert.ok(ana);
  assert.equal(ana.relationships[0].relationId, "ana-bruno");
  assert.equal(ana.relationships[0].otherCharacterName, "Bruno");
  assert.equal(ana.relationships[0].evidenceStatus, "active-evidence");
  assert.equal(ana.documentedDecisions[0].ideaId, "ana-promise-decision");
  assert.equal(ana.documentedDecisions[0].status, "incorporated");
  assert.equal(ana.writerDecisionCount, 1);
  assert.deepEqual(ana.scenes[0].relationshipIds, ["ana-bruno"]);
  assert.deepEqual(ana.scenes[0].documentedDecisionIdeaIds, ["ana-promise-decision"]);
});
