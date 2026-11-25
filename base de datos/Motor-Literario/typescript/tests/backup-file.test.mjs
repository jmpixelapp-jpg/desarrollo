import test from "node:test";
import assert from "node:assert/strict";
import {
  createIndexedDbBackupBlob,
  downloadIndexedDbBackupFile,
  readIndexedDbBackupFile
} from "../dist/motor-literario.js";

const sampleBackup = {
  format: "motor-literario-indexeddb-backup",
  formatVersion: 1,
  databaseVersion: 22,
  createdAt: 1_800_000_000_000,
  stores: {
    documents: [{ projectId: "book-1", documentId: "chapter-1", text: "Privado." }]
  },
  checksum: "fnv1a64:0123456789abcdef"
};

test("serializa un respaldo en Blob JSON y permite leerlo sin alterar datos", async () => {
  const blob = createIndexedDbBackupBlob(sampleBackup);
  assert.equal(blob.type, "application/json;charset=utf-8");
  const restored = await readIndexedDbBackupFile(blob);
  assert.deepEqual(restored, sampleBackup);
});

test("rechaza archivos vacíos, JSON malformado y raíces que no son objetos", async () => {
  await assert.rejects(readIndexedDbBackupFile(new Blob([])), /vacío o no es válido/u);
  await assert.rejects(readIndexedDbBackupFile(new Blob(["{"])), /JSON válido/u);
  await assert.rejects(readIndexedDbBackupFile(new Blob(["null"])), /manifiesto de respaldo/u);
  await assert.rejects(readIndexedDbBackupFile(new Blob(["[]"])), /manifiesto de respaldo/u);
  await assert.rejects(
    readIndexedDbBackupFile({
      size: 20,
      text: async () => { throw new Error("read failure"); }
    }),
    /No se pudo leer/u
  );
});

test("descarga el paquete JSON con nombre controlado y libera la URL temporal", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const originalSetTimeout = globalThis.setTimeout;
  let appended;
  let revoked;
  let createdBlob;
  let scheduledDelay;
  const link = {
    href: "",
    download: "",
    hidden: false,
    clicked: false,
    removed: false,
    click() { this.clicked = true; },
    remove() { this.removed = true; }
  };
  const parent = {
    append(value) { appended = value; }
  };

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: parent,
      documentElement: parent,
      createElement(name) {
        assert.equal(name, "a");
        return link;
      }
    }
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value(blob) {
      createdBlob = blob;
      return "blob:test-backup";
    }
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value(value) { revoked = value; }
  });
  globalThis.setTimeout = (callback, delay) => {
    scheduledDelay = delay;
    callback();
    return 1;
  };

  try {
    downloadIndexedDbBackupFile(sampleBackup, "respaldo-libro");
    assert.equal(appended, link);
    assert.equal(link.href, "blob:test-backup");
    assert.equal(link.download, "respaldo-libro.json");
    assert.equal(link.hidden, true);
    assert.equal(link.clicked, true);
    assert.equal(link.removed, true);
    assert.equal(createdBlob.type, "application/json;charset=utf-8");
    assert.equal(revoked, "blob:test-backup");
    assert.equal(scheduledDelay, 1000);
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete globalThis.document;
    if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate);
    else delete URL.createObjectURL;
    if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
    else delete URL.revokeObjectURL;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("rechaza nombres de respaldo con rutas o controles", () => {
  assert.throws(
    () => downloadIndexedDbBackupFile(sampleBackup, "../shared.json"),
    /nombre del archivo.*no es válido/u
  );
  assert.throws(
    () => downloadIndexedDbBackupFile(sampleBackup, "carpeta\\respaldo.json"),
    /nombre del archivo.*no es válido/u
  );
});
