import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { auditStorageImplementation } from "../scripts/audit-storage-implementation.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MAPPING_PATH = resolve(TEST_DIR, "../../MLDB/storage_mapping_v0.4.2.json");
const RUNTIME_PATH = resolve(TEST_DIR, "../src/persistence/indexeddb-store.ts");

const [mappingText, runtimeSource] = await Promise.all([
  readFile(MAPPING_PATH, "utf8"),
  readFile(RUNTIME_PATH, "utf8")
]);
const mapping = JSON.parse(mappingText);

test("todas las tablas del motor tienen almacenes IndexedDB declarados y creados", () => {
  const engineTables = mapping.entries.filter((entry) => entry.table !== "projects");
  assert.equal(engineTables.length, mapping.entries.length - 1);
  assert.ok(engineTables.every((entry) => entry.implementationStatus === "implemented"));
  assert.deepEqual(auditStorageImplementation(mapping, runtimeSource), []);
});

test("projects permanece bajo propiedad exclusiva del anfitrión", () => {
  const copy = structuredClone(mapping);
  copy.entries.find((entry) => entry.table === "projects").implementationStatus = "implemented";
  assert.ok(auditStorageImplementation(copy, runtimeSource).some(
    (issue) => issue.code === "PROJECTS_MUST_BE_HOST_OWNED"
  ));
});

test("rechaza declarar implementada una tabla del motor sin su almacén físico", () => {
  const copy = structuredClone(mapping);
  copy.entries.find((entry) => entry.table === "records").objectStores = [];
  assert.ok(auditStorageImplementation(copy, runtimeSource).some(
    (issue) => issue.code === "MISSING_RUNTIME_STORE_MAPPING"
  ));
});

test("detecta almacenes del manifiesto que no se crean en IndexedDB", () => {
  const sourceWithoutStore = runtimeSource.replace(
    "createObjectStore(PROJECT_RECORDS,",
    "createObjectStore(UNKNOWN_RECORDS,"
  );
  assert.ok(auditStorageImplementation(mapping, sourceWithoutStore).some(
    (issue) => issue.code === "RUNTIME_STORE_CREATION_MISSING"
  ));
});

test("rechaza estados pendientes en tablas propiedad del motor", () => {
  const copy = structuredClone(mapping);
  copy.entries.find((entry) => entry.table === "dictionary_entries").implementationStatus = "planned";
  assert.ok(auditStorageImplementation(copy, runtimeSource).some(
    (issue) => issue.code === "UNIMPLEMENTED_ENGINE_TABLE"
  ));
});

test("detecta una versión IndexedDB distinta entre manifiesto y adaptador", () => {
  const copy = structuredClone(mapping);
  copy.runtime.database_version += 1;
  assert.ok(auditStorageImplementation(copy, runtimeSource).some(
    (issue) => issue.code === "DATABASE_VERSION_MISMATCH"
  ));
});

test("cada almacén lógico tiene descriptor y los almacenes operativos también se verifican", () => {
  const copy = structuredClone(mapping);
  copy.runtime.object_stores = copy.runtime.object_stores.filter(
    (store) => store.name !== "writer-library-finalization-receipts"
  );
  assert.ok(auditStorageImplementation(copy, runtimeSource).some(
    (issue) => issue.code === "MISSING_RUNTIME_STORE_DESCRIPTOR"
  ));

  const withUnknownStore = structuredClone(mapping);
  withUnknownStore.runtime.object_stores.push({
    name: "orphan-store",
    keyPath: "id",
    indexes: []
  });
  assert.ok(auditStorageImplementation(withUnknownStore, runtimeSource).some(
    (issue) => issue.code === "RUNTIME_DESCRIPTOR_CONSTANT_MISSING"
  ));
});

test("detecta cambios en keyPath e índices aunque el almacén exista", () => {
  const copy = structuredClone(mapping);
  const descriptor = copy.runtime.object_stores.find(
    (store) => store.name === "project-records"
  );
  descriptor.keyPath = ["projectId", "primaryName"];
  assert.ok(auditStorageImplementation(copy, runtimeSource).some(
    (issue) => issue.code === "RUNTIME_STORE_KEY_PATH_MISMATCH"
  ));

  const indexCopy = structuredClone(mapping);
  const records = indexCopy.runtime.object_stores.find(
    (store) => store.name === "project-records"
  );
  records.indexes.find((index) => index[0] === "by-project-type")[2] = true;
  assert.ok(auditStorageImplementation(indexCopy, runtimeSource).some(
    (issue) => issue.code === "RUNTIME_INDEX_MISMATCH"
  ));
});

test("detecta almacenes IndexedDB creados que no figuran en el manifiesto", () => {
  const sourceWithExtraStore = runtimeSource.replace(
    "const db = request.result;",
    [
      "const db = request.result;",
      '        const UNDECLARED_STORE = "undeclared-store";',
      '        if (!db.objectStoreNames.contains(UNDECLARED_STORE)) db.createObjectStore(UNDECLARED_STORE, { keyPath: "id" });'
    ].join("\n")
  );
  assert.ok(auditStorageImplementation(mapping, sourceWithExtraStore).some(
    (issue) => issue.code === "UNMAPPED_RUNTIME_STORE"
  ));
});


function extractIdeaReferenceWriter(source) {
  const start = source.indexOf("async function saveNarrativeIdeaWithReferences(");
  const end = source.indexOf("\nasync function saveNarrativeEventWithReferences", start);
  assert.notEqual(start, -1, "debe existir el escritor transaccional de ideas");
  assert.notEqual(end, -1, "el escritor transaccional debe tener un límite identificable");
  return source.slice(start, end);
}

test("la validación de vínculos y la escritura CAS de ideas comparten una transacción readwrite", () => {
  const writer = extractIdeaReferenceWriter(runtimeSource);
  assert.match(writer, /const stores = entityIds\.length > 0 \? \[IDEAS, ENTITIES\] : \[IDEAS\]/);
  assert.match(writer, /db\.transaction\(stores, "readwrite"\)/);
  assert.match(writer, /transaction\.objectStore\(ENTITIES\)\.get\(\[idea\.projectId, id\]\)/);
  assert.match(writer, /ideaStore\.get\(\[idea\.projectId, id\]\)/);
  assert.match(writer, /ideaStore\.get\(\[idea\.projectId, idea\.id\]\)/);
});

test("el registro de idea solo se escribe después de completar todas las comprobaciones", () => {
  const writer = extractIdeaReferenceWriter(runtimeSource);
  assert.match(writer, /const markCheckComplete = \(\): void => \{\s*remaining--;\s*if \(remaining === 0\) ideaStore\.put\(idea\);\s*\}/);
  assert.match(writer, /if \(totalChecks === 0\) \{\s*ideaStore\.put\(idea\);/);
  assert.ok(writer.indexOf("const totalChecks =") < writer.indexOf("const markCheckComplete ="));
  assert.ok(writer.indexOf("const markCheckComplete =") < writer.indexOf("transaction.oncomplete"));
});

test("un destino inválido aborta la transacción y no confirma la escritura", () => {
  const writer = extractIdeaReferenceWriter(runtimeSource);
  assert.match(writer, /const abortWith = \(error: unknown\): void => \{\s*try \{ transaction\.abort\(\); \}/);
  assert.match(writer, /if \(!record \|\| record\.projectId !== idea\.projectId \|\| record\.id !== check\.id\)/);
  assert.match(writer, /transaction\.onabort = \(\) => reject\(/);
  assert.match(writer, /transaction\.oncomplete = \(\) => resolve\(\)/);
});

test("la auditoría de atomicidad detecta perder el almacén de entidades del alcance transaccional", () => {
  const writer = extractIdeaReferenceWriter(runtimeSource);
  const weakenedWriter = writer.replace(
    "const stores = entityIds.length > 0 ? [IDEAS, ENTITIES] : [IDEAS];",
    "const stores = [IDEAS];"
  );
  assert.notEqual(weakenedWriter, writer);
  assert.doesNotMatch(
    weakenedWriter,
    /const stores = entityIds\.length > 0 \? \[IDEAS, ENTITIES\] : \[IDEAS\]/
  );
});
