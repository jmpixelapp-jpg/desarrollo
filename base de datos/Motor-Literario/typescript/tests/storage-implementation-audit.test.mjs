import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { auditStorageImplementation } from "../scripts/audit-storage-implementation.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MAPPING_PATH = resolve(TEST_DIR, "../../MLDB/storage_mapping_v0.4.1.json");
const RUNTIME_PATH = resolve(TEST_DIR, "../src/persistence/indexeddb-store.ts");

const [mappingText, runtimeSource] = await Promise.all([
  readFile(MAPPING_PATH, "utf8"),
  readFile(RUNTIME_PATH, "utf8")
]);
const mapping = JSON.parse(mappingText);

test("las 24 tablas del motor tienen almacenes IndexedDB declarados y creados", () => {
  const engineTables = mapping.entries.filter((entry) => entry.table !== "projects");
  assert.equal(engineTables.length, 24);
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

test("exige que cada almacén lógico tenga una definición física y viceversa", () => {
  const copy = structuredClone(mapping);
  copy.runtime.object_stores = copy.runtime.object_stores.filter(
    (store) => store.name !== "dictionary-entry-entities"
  );
  assert.ok(auditStorageImplementation(copy, runtimeSource).some(
    (issue) => issue.code === "MISSING_RUNTIME_STORE_DESCRIPTOR"
  ));

  const withOrphan = structuredClone(mapping);
  withOrphan.runtime.object_stores.push({
    name: "orphan-store",
    keyPath: "id",
    indexes: []
  });
  assert.ok(auditStorageImplementation(withOrphan, runtimeSource).some(
    (issue) => issue.code === "UNMAPPED_RUNTIME_STORE_DESCRIPTOR"
  ));
});
