#!/usr/bin/env node
/**
 * Validador estructural del esquema declarativo MLDB.
 * No abre ni modifica bases de datos: comprueba integridad del contrato JSON.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const DEFAULT_SCHEMA = resolve(dirname(fileURLToPath(import.meta.url)), "../../MLDB/schema_v0.4.2.json");
const DEFAULT_MAPPING = resolve(dirname(fileURLToPath(import.meta.url)), "../../MLDB/storage_mapping_v0.4.2.json");

function parseColumnMetadata(table) {
  const columns = new Map();
  const primaryKeys = [];
  for (const row of table.columns ?? []) {
    if (!Array.isArray(row) || row.length < 3 || typeof row[0] !== "string") {
      throw new Error(`Tabla "${table.name}": definición de columna mal formada.`);
    }
    if (row[0] === "PRIMARY KEY") {
      const match = typeof row[1] === "string" && row[1].match(/^\((.*)\)$/);
      if (!match) throw new Error(`Tabla "${table.name}": PRIMARY KEY compuesta mal formada.`);
      primaryKeys.push(...match[1].split(",").map((part) => part.trim()).filter(Boolean));
      continue;
    }
    if (columns.has(row[0])) throw new Error(`Tabla "${table.name}": columna duplicada "${row[0]}".`);
    columns.set(row[0], row);
    if (String(row[2]).includes("PRIMARY KEY")) primaryKeys.push(row[0]);
  }
  return { columns, primaryKeys };
}

function uniqueKeys(table, primaryKeys) {
  const keys = [];
  if (primaryKeys.length) keys.push(primaryKeys);
  for (const constraint of table.constraints ?? []) {
    if (typeof constraint !== "string") continue;
    const match = constraint.match(/^\s*UNIQUE\s*\(([^)]+)\)\s*$/i);
    if (match) keys.push(match[1].split(",").map((part) => part.trim()));
  }
  return keys;
}

function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function validateMldbSchema(schema) {
  const issues = [];
  const add = (code, message) => issues.push({ code, message });
  if (!schema || typeof schema !== "object" || !Array.isArray(schema.tables)) {
    return [{ code: "SCHEMA_SHAPE", message: "El esquema debe contener un arreglo tables." }];
  }
  if (typeof schema.format?.schema_version !== "string" || !/^\d+\.\d+\.\d+$/.test(schema.format.schema_version)) {
    add("SCHEMA_VERSION", "La versión lógica debe seguir el formato semántico X.Y.Z.");
  }

  const tableMap = new Map();
  const metadata = new Map();
  for (const table of schema.tables) {
    if (!table || typeof table.name !== "string" || !table.name.trim()) {
      add("TABLE_NAME", "Existe una tabla sin nombre válido.");
      continue;
    }
    if (tableMap.has(table.name)) add("DUPLICATE_TABLE", `La tabla "${table.name}" está duplicada.`);
    tableMap.set(table.name, table);
    try {
      const parsed = parseColumnMetadata(table);
      metadata.set(table.name, parsed);
      if (parsed.primaryKeys.length === 0) add("MISSING_PRIMARY_KEY", `La tabla "${table.name}" no declara clave primaria.`);
      if (new Set(parsed.primaryKeys).size !== parsed.primaryKeys.length) {
        add("DUPLICATE_PRIMARY_KEY_COLUMN", `La tabla "${table.name}" repite columnas en su clave primaria.`);
      }
      for (const key of parsed.primaryKeys) {
        if (!parsed.columns.has(key)) add("UNKNOWN_PRIMARY_KEY_COLUMN", `La clave primaria de "${table.name}" usa la columna inexistente "${key}".`);
      }
    } catch (error) {
      add("COLUMN_DEFINITION", error.message);
    }
  }

  for (const table of schema.tables) {
    if (!table?.name || !metadata.has(table.name)) continue;
    const { columns, primaryKeys } = metadata.get(table.name);
    const uniques = uniqueKeys(table, primaryKeys);
    const indexes = new Set();
    for (const index of table.indexes ?? []) {
      if (!Array.isArray(index) || index.length === 0) {
        add("EMPTY_INDEX", `La tabla "${table.name}" contiene un índice vacío o mal formado.`);
        continue;
      }
      for (const column of index) {
        if (!columns.has(column)) add("UNKNOWN_INDEX_COLUMN", `Índice de "${table.name}" referencia la columna inexistente "${column}".`);
      }
      const signature = JSON.stringify(index);
      if (indexes.has(signature)) add("DUPLICATE_INDEX", `La tabla "${table.name}" repite el índice [${index.join(", ")}].`);
      indexes.add(signature);
    }

    if (table.scope === "project") {
      const projectId = columns.get("project_id");
      if (!projectId) {
        add("PROJECT_ID_MISSING", `La tabla de proyecto "${table.name}" no contiene project_id.`);
      } else if (!String(projectId[2]).includes("NOT NULL")) {
        add("PROJECT_ID_NULLABLE", `La columna project_id de "${table.name}" debe ser NOT NULL.`);
      }
    } else if (table.scope === "writer") {
      const writerId = columns.get("writer_id");
      if (!writerId) {
        add("WRITER_ID_MISSING", `La tabla de escritor "${table.name}" no contiene writer_id.`);
      } else if (!String(writerId[2]).includes("NOT NULL")) {
        add("WRITER_ID_NULLABLE", `La columna writer_id de "${table.name}" debe ser NOT NULL.`);
      }
    } else if (table.scope !== "global") {
      add("INVALID_TABLE_SCOPE", `La tabla "${table.name}" tiene un scope distinto de project/writer/global.`);
    }

    const fkNames = new Set();
    const fkSignatures = new Set();
    let hasProjectOwnerFk = false;
    let hasWriterProjectOwnerFk = false;
    for (const fk of table.foreign_keys ?? []) {
      if (!fk || typeof fk.name !== "string" || !Array.isArray(fk.columns) ||
          !fk.references || typeof fk.references.table !== "string" ||
          !Array.isArray(fk.references.columns) || fk.columns.length === 0 ||
          fk.columns.length !== fk.references.columns.length) {
        add("MALFORMED_FOREIGN_KEY", `La tabla "${table.name}" contiene una clave foránea mal formada.`);
        continue;
      }
      if (fkNames.has(fk.name)) add("DUPLICATE_FOREIGN_KEY_NAME", `La tabla "${table.name}" repite el nombre de clave foránea "${fk.name}".`);
      fkNames.add(fk.name);
      const signature = JSON.stringify([fk.columns, fk.references.table, fk.references.columns]);
      if (fkSignatures.has(signature)) add("DUPLICATE_FOREIGN_KEY", `La tabla "${table.name}" repite la referencia "${fk.name}".`);
      fkSignatures.add(signature);

      for (const column of fk.columns) {
        if (!columns.has(column)) add("UNKNOWN_FOREIGN_KEY_COLUMN", `La clave foránea "${fk.name}" usa "${column}", que no existe en "${table.name}".`);
      }
      const target = tableMap.get(fk.references.table);
      const targetMeta = metadata.get(fk.references.table);
      if (!target || !targetMeta) {
        add("UNKNOWN_FOREIGN_KEY_TABLE", `La clave foránea "${fk.name}" apunta a la tabla inexistente "${fk.references.table}".`);
        continue;
      }
      for (const column of fk.references.columns) {
        if (!targetMeta.columns.has(column)) add("UNKNOWN_REFERENCED_COLUMN", `La clave foránea "${fk.name}" apunta a "${fk.references.table}.${column}", que no existe.`);
      }
      if (!targetMeta.columns.size) continue;
      if (!uniqueKeys(target, targetMeta.primaryKeys).some((key) => sameList(key, fk.references.columns))) {
        add("NON_UNIQUE_FOREIGN_KEY_TARGET", `La referencia "${fk.name}" no apunta a una clave primaria o UNIQUE de "${fk.references.table}".`);
      }

      if (fk.references.table === "projects" &&
          sameList(fk.columns, ["project_id"]) &&
          sameList(fk.references.columns, ["project_id"])) {
        hasProjectOwnerFk = true;
      }
      if (table.scope === "writer" && fk.references.table === "projects" &&
          sameList(fk.columns, ["writer_id", "source_project_id"]) &&
          sameList(fk.references.columns, ["writer_id", "project_id"])) {
        hasWriterProjectOwnerFk = true;
      }

      if (table.scope === "project" && target.scope === "project") {
        const localProjectIndex = fk.columns.indexOf("project_id");
        const remoteProjectIndex = fk.references.columns.indexOf("project_id");
        if (localProjectIndex < 0 || remoteProjectIndex < 0 || localProjectIndex !== remoteProjectIndex) {
          add("CROSS_PROJECT_REFERENCE", `La referencia "${fk.name}" no vincula project_id en la misma posición; permitiría referencias entre libros.`);
        }
      }
      if (table.scope === "writer" && target.name === "projects") {
        const localWriterIndex = fk.columns.indexOf("writer_id");
        const remoteWriterIndex = fk.references.columns.indexOf("writer_id");
        if (localWriterIndex < 0 || remoteWriterIndex < 0 || localWriterIndex !== remoteWriterIndex) {
          add("CROSS_WRITER_REFERENCE", `La referencia "${fk.name}" no vincula writer_id en la misma posición; permitiría acceder a proyectos de otro escritor.`);
        }
      }
      if (table.scope === "writer" && target.scope === "project") {
        const localProjectIndex = fk.columns.indexOf("source_project_id");
        const remoteProjectIndex = fk.references.columns.indexOf("project_id");
        if (localProjectIndex < 0 || remoteProjectIndex < 0 || localProjectIndex !== remoteProjectIndex) {
          add("CROSS_WRITER_PROJECT_REFERENCE", `La referencia "${fk.name}" no vincula el proyecto de origen en la misma posición; permitiría mezclar registros de libros.`);
        }
      }
      if (table.scope === "global" && target.scope === "project" && table.name !== "import_authorizations") {
        add("UNAUTHORIZED_GLOBAL_REFERENCE", `La tabla global "${table.name}" no puede referenciar directamente "${target.name}".`);
      }
    }
    if (table.scope === "project" && !hasProjectOwnerFk) {
      add("PROJECT_OWNER_FK_MISSING", `La tabla "${table.name}" debe tener una FK project_id hacia projects.project_id.`);
    }
    if (table.scope === "writer" && !hasWriterProjectOwnerFk) {
      add("WRITER_PROJECT_OWNER_FK_MISSING", `La tabla "${table.name}" debe vincular writer_id y source_project_id al propietario del proyecto de origen.`);
    }
  }
  return issues;
}


/**
 * Comprueba que el manifiesto físico describe exactamente las tablas lógicas.
 * Evita que el esquema evolucione mientras los adaptadores/documentación quedan atrás.
 */
export function validateMldbStorageMapping(schema, mapping) {
  const issues = [];
  const add = (code, message) => issues.push({ code, message });
  if (!schema || typeof schema !== "object" || !Array.isArray(schema.tables)) {
    return [{ code: "MAPPING_SCHEMA_SHAPE", message: "Se necesita un esquema con tables para validar el manifiesto." }];
  }
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return [{ code: "MAPPING_SHAPE", message: "El manifiesto de almacenamiento debe ser un objeto." }];
  }
  if (mapping.format !== "MLDB_STORAGE_MAPPING") {
    add("MAPPING_FORMAT", "El manifiesto debe declarar format=MLDB_STORAGE_MAPPING.");
  }
  if (!Number.isSafeInteger(mapping.mapping_version) || mapping.mapping_version < 1) {
    add("MAPPING_VERSION", "mapping_version debe ser un entero positivo.");
  }
  if (mapping.schema_version !== schema.format?.schema_version) {
    add("MAPPING_SCHEMA_VERSION", "La versión del manifiesto no coincide con la versión del esquema lógico.");
  }
  if (mapping.storage_model !== "journal-first-key-value") {
    add("MAPPING_STORAGE_MODEL", "El manifiesto debe declarar el modelo journal-first-key-value.");
  }
  if (!Array.isArray(mapping.entries)) {
    add("MAPPING_ENTRIES", "El manifiesto debe contener entries como arreglo.");
    return issues;
  }

  const tables = new Map(schema.tables
    .filter((table) => table && typeof table.name === "string")
    .map((table) => [table.name, table]));
  const seen = new Set();
  const allowedScopes = new Set(["system", "project", "writer"]);
  const allowedRepresentations = new Set(["record", "split-record", "embedded", "archive"]);

  for (const entry of mapping.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      add("MAPPING_ENTRY_SHAPE", "Existe una entrada de correspondencia que no es un objeto.");
      continue;
    }
    if (typeof entry.table !== "string" || entry.table.trim().length === 0) {
      add("MAPPING_TABLE_NAME", "Una entrada del manifiesto no tiene nombre de tabla.");
      continue;
    }
    if (seen.has(entry.table)) {
      add("MAPPING_DUPLICATE_TABLE", `La tabla "${entry.table}" aparece más de una vez en el manifiesto.`);
    }
    seen.add(entry.table);
    const table = tables.get(entry.table);
    if (!table) {
      add("MAPPING_UNKNOWN_TABLE", `El manifiesto contiene la tabla no declarada "${entry.table}".`);
      continue;
    }
    if (entry.logicalScope !== table.scope) {
      add("MAPPING_SCOPE_MISMATCH", `El ámbito de "${entry.table}" no coincide con el esquema lógico.`);
    }
    if (!Array.isArray(entry.storageScopes) || entry.storageScopes.length === 0 ||
        entry.storageScopes.some((scope) => !allowedScopes.has(scope))) {
      add("MAPPING_STORAGE_SCOPES", `La tabla "${entry.table}" debe declarar ámbitos físicos válidos y no vacíos.`);
    } else {
      if (new Set(entry.storageScopes).size !== entry.storageScopes.length) {
        add("MAPPING_DUPLICATE_STORAGE_SCOPE", `La tabla "${entry.table}" repite ámbitos físicos.`);
      }
      if (table.scope === "project" &&
          (entry.storageScopes.length !== 1 || entry.storageScopes[0] !== "project")) {
        add("MAPPING_PROJECT_SCOPE", `La tabla "${entry.table}" debe almacenarse únicamente en project.`);
      }
      if (table.scope === "writer" &&
          (entry.storageScopes.length !== 1 || entry.storageScopes[0] !== "writer")) {
        add("MAPPING_WRITER_SCOPE", `La tabla "${entry.table}" debe almacenarse únicamente en writer.`);
      }
      if (table.scope === "global" && !entry.storageScopes.includes("system")) {
        add("MAPPING_GLOBAL_SCOPE", `La tabla global "${entry.table}" debe incluir el ámbito system.`);
      }
    }
    if (!Array.isArray(entry.keyPrefixes) || entry.keyPrefixes.length === 0 ||
        entry.keyPrefixes.some((prefix) => typeof prefix !== "string" ||
          prefix.trim().length === 0 || prefix.includes("\\u0000"))) {
      add("MAPPING_KEY_PREFIXES", `La tabla "${entry.table}" debe declarar prefijos/llaves válidos.`);
    } else if (new Set(entry.keyPrefixes).size !== entry.keyPrefixes.length) {
      add("MAPPING_DUPLICATE_KEY_PREFIX", `La tabla "${entry.table}" repite prefijos de almacenamiento.`);
    }
    if (!allowedRepresentations.has(entry.representation)) {
      add("MAPPING_REPRESENTATION", `La tabla "${entry.table}" usa una representación física no admitida.`);
    }
    if (typeof entry.contract !== "string" || entry.contract.trim().length === 0) {
      add("MAPPING_CONTRACT", `La tabla "${entry.table}" no identifica su contrato de implementación.`);
    }
  }

  for (const tableName of tables.keys()) {
    if (!seen.has(tableName)) {
      add("MAPPING_TABLE_MISSING", `Falta la correspondencia física de "${tableName}".`);
    }
  }
  return issues;
}

async function main() {
  const schemaPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_SCHEMA;
  const mappingPath = process.argv[3] ? resolve(process.argv[3]) : DEFAULT_MAPPING;
  let schema;
  let mapping;
  try {
    schema = JSON.parse(await readFile(schemaPath, "utf8"));
    mapping = JSON.parse(await readFile(mappingPath, "utf8"));
  } catch (error) {
    console.error(`No se pudo leer el esquema o el manifiesto MLDB: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const issues = [
    ...validateMldbSchema(schema),
    ...validateMldbStorageMapping(schema, mapping),
  ];
  if (issues.length) {
    console.error(`MLDB: ${issues.length} problema(s) estructural(es) o de correspondencia.`);
    for (const issue of issues) console.error(`- [${issue.code}] ${issue.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`MLDB ${schema.format.schema_version}: esquema y correspondencia válidos (${schema.tables.length} tablas).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
