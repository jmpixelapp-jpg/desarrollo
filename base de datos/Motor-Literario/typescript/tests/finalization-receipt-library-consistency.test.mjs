import test from "node:test";
import assert from "node:assert/strict";
import { HostEngineApi } from "../dist/motor-literario.js";

const writerId = "writer-library-receipt";
const projectId = "book-library-receipt";
const projectName = "El archivo de las mareas";

function checksum(ids) {
  const serialized = JSON.stringify([...ids].sort());
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < serialized.length; index++) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function ideaEntry(id, sourceId = projectId, sourceName = projectName, owner = writerId) {
  return {
    writerId: owner,
    sourceProjectId: sourceId,
    sourceProjectName: sourceName,
    category: sourceName,
    idea: {
      projectId: sourceId,
      id,
      text: "La marea revela una puerta oculta.",
      status: "IDEA",
      originDocumentId: "chapter-1",
      sourceProjectName: sourceName,
      evidence: []
    },
    archivedAt: 100
  };
}

function makeReceipt(ids, overrides = {}) {
  const sortedIds = [...ids].sort();
  return {
    writerId,
    sourceProjectId: projectId,
    receiptId: "finalization-v1",
    sourceProjectName: projectName,
    finalizedAt: 100,
    archivedIdeaIds: sortedIds,
    archiveChecksum: checksum(sortedIds),
    ...overrides
  };
}

function createApi({ receipt, library = [], includeLibraryLoader = true } = {}) {
  const store = {
    async loadProjectFinalizationReceipt() {
      return receipt === undefined ? undefined : structuredClone(receipt);
    }
  };
  if (includeLibraryLoader) {
    store.loadPersonalIdeas = async requestedWriterId => {
      assert.equal(requestedWriterId, writerId);
      return structuredClone(library);
    };
  }
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId, projectName, writerId });
  return { api, store };
}

test("el recibo solo se devuelve cuando coincide exactamente con la biblioteca del libro", async () => {
  const entries = [ideaEntry("idea-a"), ideaEntry("idea-b")];
  const receipt = makeReceipt(["idea-b", "idea-a"]);
  const { api } = createApi({ receipt, library: entries });
  try {
    const actual = await api.getProjectFinalizationReceipt();
    assert.deepEqual(actual?.archivedIdeaIds, ["idea-a", "idea-b"]);
    assert.equal(actual?.archiveChecksum, checksum(["idea-a", "idea-b"]));
  } finally {
    api.dispose();
  }
});

test("rechaza un recibo que anuncia ideas ausentes de la biblioteca personal", async () => {
  const { api } = createApi({
    receipt: makeReceipt(["idea-missing"]),
    library: []
  });
  try {
    await assert.rejects(
      () => api.getProjectFinalizationReceipt(),
      /no coincide con las ideas archivadas/
    );
  } finally {
    api.dispose();
  }
});

test("rechaza una biblioteca que contiene ideas del libro no declaradas en el recibo", async () => {
  const { api } = createApi({
    receipt: makeReceipt(["idea-a"]),
    library: [ideaEntry("idea-a"), ideaEntry("idea-unlisted")]
  });
  try {
    await assert.rejects(
      () => api.getProjectFinalizationReceipt(),
      /no coincide con las ideas archivadas/
    );
  } finally {
    api.dispose();
  }
});

test("la verificación del recibo ignora otros libros del mismo escritor", async () => {
  const currentBook = ideaEntry("idea-current");
  const otherBook = ideaEntry("idea-other", "another-book", "Otro libro");
  const { api } = createApi({
    receipt: makeReceipt(["idea-current"]),
    library: [currentBook, otherBook]
  });
  try {
    const receipt = await api.getProjectFinalizationReceipt();
    assert.deepEqual(receipt?.archivedIdeaIds, ["idea-current"]);
  } finally {
    api.dispose();
  }
});

test("no anuncia recibos cuando el adaptador no permite comprobar la biblioteca", async () => {
  const { api } = createApi({
    receipt: makeReceipt([]),
    includeLibraryLoader: false
  });
  try {
    assert.equal(api.getCapabilities().personalIdeaLibraryFinalizationReceipts, false);
    await assert.rejects(
      () => api.getProjectFinalizationReceipt(),
      /verificación completa/
    );
  } finally {
    api.dispose();
  }
});

test("la consulta del recibo espera a que termine el archivo y compare la biblioteca", async () => {
  let releaseArchive;
  let markArchiveStarted;
  const archiveGate = new Promise(resolve => { releaseArchive = resolve; });
  const archiveStarted = new Promise(resolve => { markArchiveStarted = resolve; });
  const entry = ideaEntry("idea-pending");
  entry.context = { version: 1, relatedIdeas: [], relatedEntities: [] };
  let storedReceipt;
  let storedLibrary = [];
  let receiptReads = 0;

  const store = {
    async archiveUnincorporatedIdeas(sourceProjectId, requestedWriterId, sourceProjectName, archivedAt) {
      markArchiveStarted();
      await archiveGate;
      entry.archivedAt = archivedAt;
      storedLibrary = [structuredClone(entry)];
      storedReceipt = makeReceipt(["idea-pending"], { finalizedAt: archivedAt });
      return [structuredClone(entry)];
    },
    async loadProjectFinalizationReceipt() {
      receiptReads++;
      return storedReceipt ? structuredClone(storedReceipt) : undefined;
    },
    async loadPersonalIdeas(requestedWriterId) {
      assert.equal(requestedWriterId, writerId);
      return structuredClone(storedLibrary);
    }
  };
  const api = new HostEngineApi({ store });
  api.initializeProject({ projectId, projectName, writerId });
  try {
    const archiving = api.archiveUnincorporatedIdeas();
    await archiveStarted;
    let resolved = false;
    const reading = api.getProjectFinalizationReceipt().then(value => {
      resolved = true;
      return value;
    });
    await Promise.resolve();
    assert.equal(receiptReads, 0);
    assert.equal(resolved, false);
    releaseArchive();
    assert.equal((await archiving).length, 1);
    const receipt = await reading;
    assert.deepEqual(receipt?.archivedIdeaIds, ["idea-pending"]);
    assert.equal(receiptReads, 1);
  } finally {
    releaseArchive?.();
    api.dispose();
  }
});
