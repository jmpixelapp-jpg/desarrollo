import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateMldbSchema, validateMldbStorageMapping } from "../scripts/validate-mldb-schema.mjs";

const schemaUrl = new URL("../../MLDB/schema_v0.4.2.json", import.meta.url);
const mappingUrl = new URL("../../MLDB/storage_mapping_v0.4.2.json", import.meta.url);
const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
const storageMapping = JSON.parse(await readFile(mappingUrl, "utf8"));

test("el esquema MLDB 0.4.3 completo supera la validación estructural", () => {
  assert.equal(schema.format.schema_version, "0.4.3");
  assert.equal(schema.tables.length, 27);
  assert.deepEqual(validateMldbSchema(schema), []);
  assert.deepEqual(validateMldbStorageMapping(schema, storageMapping), []);
});

test("el esquema y manifiesto MLDB 0.4.1 anteriores conservan compatibilidad", async () => {
  const previous = JSON.parse(await readFile(new URL("../../MLDB/schema_v0.4.1.json", import.meta.url), "utf8"));
  const previousMapping = JSON.parse(await readFile(new URL("../../MLDB/storage_mapping_v0.4.1.json", import.meta.url), "utf8"));
  assert.equal(previous.format.schema_version, "0.4.1");
  assert.deepEqual(validateMldbSchema(previous), []);
  assert.deepEqual(validateMldbStorageMapping(previous, previousMapping), []);
});

test("el esquema MLDB 0.4.0 anterior conserva compatibilidad de validación", async () => {
  const previous = JSON.parse(await readFile(new URL("../../MLDB/schema_v0.4.0.json", import.meta.url), "utf8"));
  assert.deepEqual(validateMldbSchema(previous), []);
});

test("el esquema MLDB 0.3.0 anterior conserva compatibilidad de validación", async () => {
  const legacy = JSON.parse(await readFile(new URL("../../MLDB/schema_v0.3.0.json", import.meta.url), "utf8"));
  assert.deepEqual(validateMldbSchema(legacy), []);
});

test("el esquema MLDB 0.2.0 anterior conserva compatibilidad de validación", async () => {
  const legacy = JSON.parse(await readFile(new URL("../../MLDB/schema_v0.2.0.json", import.meta.url), "utf8"));
  assert.deepEqual(validateMldbSchema(legacy), []);
});

test("los diccionarios y sus vínculos con entidades quedan aislados por proyecto", () => {
  const entries = schema.tables.find((table) => table.name === "dictionary_entries");
  const links = schema.tables.find((table) => table.name === "dictionary_entry_entities");
  assert.ok(entries.foreign_keys.some((fk) => fk.references.table === "project_dictionaries" &&
    fk.columns.includes("project_id") && fk.references.columns.includes("project_id")));
  assert.ok(links.foreign_keys.some((fk) => fk.references.table === "records" &&
    fk.columns.includes("project_id") && fk.references.columns.includes("project_id")));
});

test("las autorizaciones de importación exigen que el mismo escritor sea dueño de ambos proyectos", () => {
  const auth = schema.tables.find((table) => table.name === "import_authorizations");
  assert.equal(auth.foreign_keys.filter((fk) => fk.references.table === "projects" &&
    fk.columns[0] === "writer_id").length, 2);
});

test("rechaza índices que apuntan a columnas inexistentes", () => {
  const copy = structuredClone(schema);
  copy.tables.find((table) => table.name === "evidences").indexes.push(["project_id", "not_a_column"]);
  assert.ok(validateMldbSchema(copy).some((issue) => issue.code === "UNKNOWN_INDEX_COLUMN"));
});

test("rechaza claves foráneas duplicadas", () => {
  const copy = structuredClone(schema);
  const table = copy.tables.find((item) => item.name === "records");
  table.foreign_keys.push(structuredClone(table.foreign_keys[0]));
  assert.ok(validateMldbSchema(copy).some((issue) => issue.code === "DUPLICATE_FOREIGN_KEY"));
});

test("rechaza referencias entre proyectos sin project_id compuesto", () => {
  const copy = structuredClone(schema);
  const table = copy.tables.find((item) => item.name === "record_names");
  const fk = table.foreign_keys.find((item) => item.name === "fk_record_names_record");
  fk.columns = ["record_id"];
  fk.references.columns = ["record_id"];
  assert.ok(validateMldbSchema(copy).some((issue) => issue.code === "CROSS_PROJECT_REFERENCE"));
});

test("exige project_id obligatorio y clave foránea al catálogo de proyectos", () => {
  const nullable = structuredClone(schema);
  nullable.tables.find((item) => item.name === "records").columns
    .find((column) => column[0] === "project_id")[2] = "NULL";
  assert.ok(validateMldbSchema(nullable).some((issue) => issue.code === "PROJECT_ID_NULLABLE"));

  const missing = structuredClone(schema);
  missing.tables.find((item) => item.name === "records").foreign_keys = [];
  assert.ok(validateMldbSchema(missing).some((issue) => issue.code === "PROJECT_OWNER_FK_MISSING"));
});

test("exige que las columnas referenciadas sean únicas", () => {
  const copy = structuredClone(schema);
  const table = copy.tables.find((item) => item.name === "record_names");
  const fk = table.foreign_keys.find((item) => item.name === "fk_record_names_record");
  fk.references.columns = ["project_id", "name"];
  assert.ok(validateMldbSchema(copy).some((issue) => issue.code === "NON_UNIQUE_FOREIGN_KEY_TARGET"));
});

test("la biblioteca de ideas requiere ámbito de escritor y propiedad del proyecto de origen", () => {
  const ideas = schema.tables.find((table) => table.name === "writer_library_ideas");
  const receipts = schema.tables.find((table) => table.name === "writer_library_finalization_receipts");
  assert.equal(ideas.scope, "writer");
  assert.equal(receipts.scope, "writer");
  assert.ok(ideas.foreign_keys.some((fk) => fk.columns.join(",") === "writer_id,source_project_id" &&
    fk.references.table === "projects" && fk.references.columns.join(",") === "writer_id,project_id"));
});

test("rechaza tablas de biblioteca sin writer_id obligatorio o sin vínculo de propiedad", () => {
  const missingOwner = structuredClone(schema);
  const ideas = missingOwner.tables.find((table) => table.name === "writer_library_ideas");
  ideas.columns = ideas.columns.filter((column) => column[0] !== "writer_id");
  assert.ok(validateMldbSchema(missingOwner).some((issue) => issue.code === "WRITER_ID_MISSING"));

  const missingProjectLink = structuredClone(schema);
  missingProjectLink.tables.find((table) => table.name === "writer_library_ideas").foreign_keys = [];
  assert.ok(validateMldbSchema(missingProjectLink).some((issue) => issue.code === "WRITER_PROJECT_OWNER_FK_MISSING"));
});

test("rechaza claves foráneas que omiten la identidad del escritor", () => {
  const copy = structuredClone(schema);
  const fk = copy.tables.find((table) => table.name === "writer_library_ideas").foreign_keys[0];
  fk.columns = ["source_project_id"];
  fk.references.columns = ["project_id"];
  assert.ok(validateMldbSchema(copy).some((issue) => issue.code === "CROSS_WRITER_REFERENCE"));
});

test("el esquema conserva historiales completos de entidades y relaciones", () => {
  const recordHistory = schema.tables.find((table) => table.name === "record_lifecycles");
  const relationHistory = schema.tables.find((table) => table.name === "relation_lifecycles");
  assert.ok(recordHistory.foreign_keys.some((fk) => fk.references.table === "records" &&
    fk.columns.join(",") === "project_id,record_id" &&
    fk.references.columns.join(",") === "project_id,record_id"));
  assert.ok(relationHistory.foreign_keys.some((fk) => fk.references.table === "relations" &&
    fk.columns.join(",") === "project_id,relation_id" &&
    fk.references.columns.join(",") === "project_id,relation_id"));
});

test("cada idea archivada conserva referencia a su entidad narrativa de origen", () => {
  const ideas = schema.tables.find((table) => table.name === "writer_library_ideas");
  assert.ok(ideas.foreign_keys.some((fk) => fk.name === "fk_writer_library_ideas_source_entity" &&
    fk.columns.join(",") === "source_project_id,source_entity_id" &&
    fk.references.table === "records" &&
    fk.references.columns.join(",") === "project_id,record_id"));
});

test("cada tabla lógica tiene una correspondencia física declarada y con ámbito correcto", () => {
  assert.equal(storageMapping.format, "MLDB_STORAGE_MAPPING");
  assert.equal(storageMapping.schema_version, schema.format.schema_version);
  const mappings = new Map(storageMapping.entries.map((entry) => [entry.table, entry]));
  assert.equal(mappings.size, schema.tables.length);
  for (const table of schema.tables) {
    const mapping = mappings.get(table.name);
    assert.ok(mapping, `Falta correspondencia para ${table.name}`);
    assert.equal(mapping.logicalScope, table.scope, table.name);
    assert.ok(mapping.storageScopes.length > 0, table.name);
    assert.ok(mapping.keyPrefixes.length > 0, table.name);
  }
  assert.deepEqual(
    storageMapping.entries.filter(entry => entry.implementationStatus !== "implemented")
      .map(entry => [entry.table, entry.implementationStatus]),
    [["projects", "host-owned"]],
    "solo projects pertenece al anfitrión; todas las demás tablas deben estar implementadas"
  );
});

test("el modelo materializa cada vínculo de diccionario con metadatos completos", () => {
  const mapping = storageMapping.entries.find((entry) => entry.table === "dictionary_entry_entities");
  assert.equal(mapping.representation, "record");
  assert.equal(mapping.implementationStatus, "implemented");
  assert.deepEqual(mapping.objectStores, [
    "dictionary-entry-entities", "dictionary-entries", "narrative-entities"
  ]);
  assert.ok(mapping.contract.includes("linkKind"));
  assert.ok(mapping.contract.includes("provenanceKind"));
  assert.ok(mapping.contract.includes("createdAt"));
  assert.ok(mapping.contract.includes("MIGRATION"));
});


test("los anclajes de evidencia exigen coordenadas coherentes y referencias documentales completas", () => {
  const evidence = schema.tables.find((table) => table.name === "evidences");
  assert.ok(evidence.constraints.includes("fragment_id IS NULL OR document_id IS NOT NULL"));
  assert.ok(evidence.constraints.some((rule) => rule.includes("start_offset IS NULL AND end_offset IS NULL")));
  assert.ok(evidence.constraints.includes("page_number IS NULL OR page_number >= 1"));
  assert.ok(evidence.constraints.includes("line_number IS NULL OR line_number >= 1"));
  assert.ok(evidence.constraints.includes("document_revision IS NULL OR document_revision >= 0"));
});

test("los fragmentos impiden autorreferencias y rangos de offsets incompletos", () => {
  const fragments = schema.tables.find((table) => table.name === "manuscript_fragments");
  assert.ok(fragments.constraints.includes("parent_fragment_id IS NULL OR parent_fragment_id <> fragment_id"));
  assert.ok(fragments.constraints.some((rule) => rule.includes("start_offset IS NULL AND end_offset IS NULL")));
  assert.ok(fragments.constraints.includes("revision >= 0"));
});


test("el validador comprueba todas las correspondencias físicas", () => {
  assert.deepEqual(validateMldbStorageMapping(schema, storageMapping), []);
});

test("el validador rechaza correspondencias ausentes y tablas extra", () => {
  const missing = structuredClone(storageMapping);
  missing.entries = missing.entries.filter((entry) => entry.table !== "evidences");
  assert.ok(validateMldbStorageMapping(schema, missing).some((issue) =>
    issue.code === "MAPPING_TABLE_MISSING"));

  const extra = structuredClone(storageMapping);
  extra.entries.push({ ...extra.entries[0], table: "unknown_table" });
  assert.ok(validateMldbStorageMapping(schema, extra).some((issue) =>
    issue.code === "MAPPING_UNKNOWN_TABLE"));
});

test("el validador rechaza ámbitos físicos incompatibles con el ámbito lógico", () => {
  const copy = structuredClone(storageMapping);
  copy.entries.find((entry) => entry.table === "writer_library_ideas").storageScopes = ["project"];
  assert.ok(validateMldbStorageMapping(schema, copy).some((issue) =>
    issue.code === "MAPPING_WRITER_SCOPE"));
});

test("el validador rechaza versiones, representaciones y prefijos incoherentes", () => {
  const copy = structuredClone(storageMapping);
  copy.schema_version = "9.9.9";
  const evidence = copy.entries.find((entry) => entry.table === "evidences");
  evidence.representation = "sql-row";
  evidence.keyPrefixes = [];
  const issues = validateMldbStorageMapping(schema, copy);
  assert.ok(issues.some((issue) => issue.code === "MAPPING_SCHEMA_VERSION"));
  assert.ok(issues.some((issue) => issue.code === "MAPPING_REPRESENTATION"));
  assert.ok(issues.some((issue) => issue.code === "MAPPING_KEY_PREFIXES"));
});

test("el validador rechaza tablas duplicadas y contratos vacíos", () => {
  const copy = structuredClone(storageMapping);
  copy.entries.push({ ...copy.entries[0] });
  copy.entries.find((entry) => entry.table === "records").contract = " ";
  const issues = validateMldbStorageMapping(schema, copy);
  assert.ok(issues.some((issue) => issue.code === "MAPPING_DUPLICATE_TABLE"));
  assert.ok(issues.some((issue) => issue.code === "MAPPING_CONTRACT"));
});
