import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi, IndexedDbProjectStore } from "../dist/motor-literario.js";

const clone = value => structuredClone(value);

function createFakeDatabase(initialStores, options = {}) {
  const state = new Map(Object.entries(initialStores).map(([name, records]) => [name, clone(records)]));
  return {
    version: 22,
    objectStoreNames: [...state.keys()],
    state,
    transaction(names, mode) {
      const selected = Array.isArray(names) ? names : [names];
      const working = new Map(selected.map(name => [name, clone(state.get(name) ?? [])]));
      let pending = 0;
      let ended = false;
      let completionQueued = false;
      let abortError;

      const transaction = {
        error: null,
        objectStore(name) {
          assert.ok(working.has(name), "object store must be in the transaction scope");
          return {
            getAll() {
              const snapshot = clone(working.get(name));
              const request = { result: undefined, onsuccess: null, onerror: null };
              pending++;
              queueMicrotask(() => {
                if (ended) return;
                request.result = clone(snapshot);
                request.onsuccess?.();
                pending--;
                scheduleCompletion();
              });
              return request;
            },
            clear() {
              assert.equal(mode, "readwrite");
              working.set(name, []);
            },
            add(value) {
              assert.equal(mode, "readwrite");
              if (options.failOnRecord?.(name, value)) {
                throw new Error("simulated IndexedDB write failure");
              }
              working.get(name).push(clone(value));
            }
          };
        },
        abort() {
          if (ended) return;
          ended = true;
          abortError = new Error("simulated IndexedDB transaction abort");
          this.error = abortError;
          queueMicrotask(() => this.onabort?.());
        }
      };

      function scheduleCompletion() {
        if (ended || pending !== 0 || completionQueued) return;
        completionQueued = true;
        queueMicrotask(() => {
          completionQueued = false;
          if (ended || pending !== 0) return;
          if (mode === "readwrite") {
            for (const [name, records] of working) state.set(name, clone(records));
          }
          ended = true;
          transaction.oncomplete?.();
        });
      }

      queueMicrotask(scheduleCompletion);
      return transaction;
    },
    close() {}
  };
}

function attach(database) {
  const store = new IndexedDbProjectStore();
  // The class caches the opened native database promise; injection keeps these
  // tests independent from the browser while exercising the public methods.
  store.database = Promise.resolve(database);
  return store;
}

const documentRecord = {
  projectId: "backup-project",
  documentId: "chapter-one",
  text: "La llave espera bajo la piedra.",
  revision: 7,
  sequence: 7,
  updatedAt: 700
};

const archivedIdea = {
  writerId: "backup-writer",
  sourceProjectId: "backup-project",
  sourceProjectName: "Libro de respaldo",
  category: "Libro de respaldo",
  idea: {
    projectId: "backup-project",
    id: "idea-key",
    text: "La llave abre el jardín.",
    status: "IDEA",
    originDocumentId: "chapter-one",
    sourceProjectName: "Libro de respaldo",
    evidence: [],
    relatedEntityIds: [],
    relatedIdeaIds: [],
    statusHistory: [{ status: "IDEA", reason: "initial", changedAt: 10 }]
  },
  context: { version: 1, relatedIdeas: [], relatedEntities: [] },
  archivedAt: 20
};

test("exporta todos los object stores en una instantánea JSON con checksum", async () => {
  const database = createFakeDatabase({
    documents: [documentRecord],
    "personal-idea-library": [archivedIdea],
    "writer-library-finalization-receipts": [{
      writerId: "backup-writer",
      sourceProjectId: "backup-project",
      receiptId: "finalization-v1",
      sourceProjectName: "Libro de respaldo",
      finalizedAt: 20,
      archivedIdeaIds: ["idea-key"],
      archiveChecksum: "fnv1a64:0000000000000000"
    }]
  });
  const store = attach(database);
  try {
    const backup = await store.exportDatabaseBackup();
    assert.equal(backup.format, "motor-literario-indexeddb-backup");
    assert.equal(backup.formatVersion, 1);
    assert.equal(backup.databaseVersion, 22);
    assert.ok(backup.createdAt >= 0);
    assert.match(backup.checksum, /^fnv1a64:[0-9a-f]{16}$/u);
    assert.deepEqual(backup.stores.documents, [documentRecord]);
    assert.deepEqual(backup.stores["personal-idea-library"], [archivedIdea]);
    assert.ok(Object.hasOwn(backup.stores, "writer-library-finalization-receipts"));
  } finally {
    store.database = undefined;
  }
});

test("rechaza checksum alterado antes de iniciar una restauración", async () => {
  const database = createFakeDatabase({
    documents: [{ ...documentRecord, text: "Versión local que debe conservarse." }],
    "personal-idea-library": []
  });
  const store = attach(database);
  try {
    const valid = await store.exportDatabaseBackup();
    const tampered = clone(valid);
    tampered.stores.documents[0].text = "Texto alterado fuera del checksum.";

    await assert.rejects(
      store.restoreDatabaseBackup(tampered),
      /checksum.*no coincide/iu
    );
    assert.equal(database.state.get("documents")[0].text, "Versión local que debe conservarse.");
  } finally {
    store.database = undefined;
  }
});

test("restaura manuscrito, biblioteca y recibos e invalida identidades anteriores y restauradas", async () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
  class TestBroadcastChannel {
    static channels = new Set();
    name;
    onmessage = null;
    constructor(name) {
      this.name = name;
      TestBroadcastChannel.channels.add(this);
    }
    postMessage(data) {
      for (const channel of TestBroadcastChannel.channels) {
        if (channel === this || channel.name !== this.name) continue;
        queueMicrotask(() => channel.onmessage?.({ data: clone(data) }));
      }
    }
    close() { TestBroadcastChannel.channels.delete(this); }
    unref() {}
  }
  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: TestBroadcastChannel
  });
  const oldDocument = {
    ...documentRecord,
    projectId: "old-project",
    documentId: "old-chapter",
    text: "Proyecto anterior."
  };
  const oldIdea = {
    ...archivedIdea,
    writerId: "old-writer",
    sourceProjectId: "old-project",
    sourceProjectName: "Libro anterior",
    category: "Libro anterior",
    idea: {
      ...archivedIdea.idea,
      projectId: "old-project",
      id: "old-idea",
      sourceProjectName: "Libro anterior",
      originDocumentId: "old-chapter"
    }
  };
  const currentDatabase = createFakeDatabase({
    documents: [oldDocument],
    "personal-idea-library": [oldIdea],
    "writer-library-finalization-receipts": [{
      writerId: "old-writer",
      sourceProjectId: "old-project",
      receiptId: "finalization-v1",
      sourceProjectName: "Libro anterior",
      finalizedAt: 10,
      archivedIdeaIds: ["old-idea"],
      archiveChecksum: "fnv1a64:0000000000000000"
    }]
  });
  const backupSource = attach(createFakeDatabase({
    documents: [documentRecord],
    "personal-idea-library": [archivedIdea],
    "writer-library-finalization-receipts": [{
      writerId: "backup-writer",
      sourceProjectId: "backup-project",
      receiptId: "finalization-v1",
      sourceProjectName: "Libro de respaldo",
      finalizedAt: 20,
      archivedIdeaIds: ["idea-key"],
      archiveChecksum: "fnv1a64:0000000000000000"
    }]
  }));
  const target = attach(currentDatabase);
  const changedProjects = [];
  const changedWriters = [];
  const offProjects = target.subscribeNarrativeChanges(id => changedProjects.push(id));
  const offWriters = target.subscribePersonalIdeaLibraryChanges(id => changedWriters.push(id));
  try {
    const backup = await backupSource.exportDatabaseBackup();
    await target.restoreDatabaseBackup(backup);

    assert.deepEqual(changedProjects.sort(), ["backup-project", "old-project"]);
    assert.deepEqual(changedWriters.sort(), ["backup-writer", "old-writer"]);
    assert.deepEqual(currentDatabase.state.get("documents"), [documentRecord]);
    assert.deepEqual(currentDatabase.state.get("personal-idea-library"), [archivedIdea]);
    assert.equal(currentDatabase.state.get("writer-library-finalization-receipts")[0].writerId, "backup-writer");
    assert.equal(currentDatabase.state.get("writer-library-finalization-receipts")[0].archivedIdeaIds[0], "idea-key");
  } finally {
    offProjects();
    offWriters();
    backupSource.database = undefined;
    target.database = undefined;
    if (originalDescriptor) Object.defineProperty(globalThis, "BroadcastChannel", originalDescriptor);
    else delete globalThis.BroadcastChannel;
  }
});

test("un fallo de escritura aborta toda la restauración y conserva los stores anteriores", async () => {
  const currentDatabase = createFakeDatabase({
    documents: [{ ...documentRecord, text: "No debe perderse." }],
    "personal-idea-library": []
  }, {
    failOnRecord: (_name, value) => value?.id === "explode"
  });
  const backupSource = attach(createFakeDatabase({
    documents: [{ ...documentRecord, text: "Documento del respaldo." }],
    "personal-idea-library": [{
      ...archivedIdea,
      idea: { ...archivedIdea.idea, id: "explode" }
    }]
  }));
  const target = attach(currentDatabase);
  try {
    const backup = await backupSource.exportDatabaseBackup();
    await assert.rejects(
      target.restoreDatabaseBackup(backup),
      /simulated IndexedDB write failure/
    );
    assert.equal(currentDatabase.state.get("documents")[0].text, "No debe perderse.");
    assert.deepEqual(currentDatabase.state.get("personal-idea-library"), []);
  } finally {
    backupSource.database = undefined;
    target.database = undefined;
  }
});

test("rechaza restaurar un respaldo de una versión de esquema diferente", async () => {
  const database = createFakeDatabase({
    documents: [documentRecord],
    "personal-idea-library": []
  });
  const store = attach(database);
  try {
    const backup = await store.exportDatabaseBackup();
    const oldVersion = { ...backup, databaseVersion: 21 };
    // The schema version is checked before the checksum.
    await assert.rejects(
      store.restoreDatabaseBackup(oldVersion),
      /versión del respaldo IndexedDB.*no coincide/iu
    );
    assert.deepEqual(database.state.get("documents"), [documentRecord]);
  } finally {
    store.database = undefined;
  }
});

test("HostEngineApi expone backup, restaura antes de inicializar y rechaza una restauración en sesión activa", async () => {
  const database = createFakeDatabase({
    documents: [documentRecord],
    "personal-idea-library": [archivedIdea]
  });
  const store = attach(database);
  const api = new HostEngineApi({ store });
  try {
    assert.equal(api.getCapabilities().fullDatabaseBackupRestore, true);
    const backup = await api.exportDatabaseBackup();
    assert.equal(backup.format, "motor-literario-indexeddb-backup");

    database.state.set("documents", [{ ...documentRecord, text: "Cambio que se va a revertir." }]);
    database.state.set("personal-idea-library", []);
    await api.restoreDatabaseBackup(backup);
    assert.deepEqual(database.state.get("documents"), [documentRecord]);
    assert.deepEqual(database.state.get("personal-idea-library"), [archivedIdea]);

    api.initializeProject({
      projectId: "active-project",
      projectName: "Sesión abierta",
      writerId: "backup-writer"
    });
    await assert.rejects(
      api.restoreDatabaseBackup(backup),
      /restauración requiere una instancia.*sin proyecto inicializado/iu
    );
  } finally {
    api.dispose();
    store.database = undefined;
  }

  const legacyStore = {
    async saveDocument() {},
    async loadDocument() { return undefined; },
    async loadDocumentWithChanges() { return { document: undefined, changes: [] }; }
  };
  const legacyApi = new HostEngineApi({ store: legacyStore });
  try {
    assert.equal(legacyApi.getCapabilities().fullDatabaseBackupRestore, false);
    await assert.rejects(legacyApi.exportDatabaseBackup(), /no admite respaldo integral/iu);
    await assert.rejects(legacyApi.restoreDatabaseBackup({}), /no admite restauración integral/iu);
  } finally {
    legacyApi.dispose();
  }
});
