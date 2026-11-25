#!/usr/bin/env node
/**
 * Contrasta el manifiesto de almacenamiento MLDB con los almacenes
 * que IndexedDbProjectStore declara y crea realmente.
 *
 * Es una auditoría estática complementaria: no abre ni modifica IndexedDB.
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MAPPING_PATH = resolve(SCRIPT_DIR, "../../MLDB/storage_mapping_v0.4.1.json");
const RUNTIME_PATH = resolve(SCRIPT_DIR, "../src/persistence/indexeddb-store.ts");

export function auditStorageImplementation(mapping, runtimeSource) {
  const issues = [];
  const add = (code, message) => issues.push({ code, message });

  if (!mapping || typeof mapping !== "object" || !Array.isArray(mapping.entries)) {
    return [{ code: "MAPPING_ENTRIES", message: "El manifiesto debe contener entries como arreglo." }];
  }
  if (typeof runtimeSource !== "string") {
    return [{ code: "RUNTIME_SOURCE", message: "No se pudo leer el código de IndexedDbProjectStore." }];
  }

  const databaseVersion = runtimeSource.match(/^\s*const\s+DATABASE_VERSION\s*=\s*(\d+)\s*;/m);
  if (!Number.isSafeInteger(mapping.runtime?.database_version) ||
      !databaseVersion ||
      Number(databaseVersion[1]) !== mapping.runtime.database_version) {
    add("DATABASE_VERSION_MISMATCH", "La versión IndexedDB del manifiesto no coincide con DATABASE_VERSION del adaptador.");
  }

  const databaseName = runtimeSource.match(/^\s*const\s+DATABASE_NAME\s*=\s*["']([^"']+)["']\s*;/m);
  if (typeof mapping.runtime?.database_name !== "string" ||
      !databaseName ||
      databaseName[1] !== mapping.runtime.database_name) {
    add("DATABASE_NAME_MISMATCH", "El nombre IndexedDB del manifiesto no coincide con DATABASE_NAME del adaptador.");
  }

  const constantsByStore = new Map();
  for (const match of runtimeSource.matchAll(
    /^\s*const\s+([A-Z][A-Z0-9_]*)\s*=\s*["']([^"']+)["']\s*;/gm
  )) {
    if (constantsByStore.has(match[2])) {
      add("DUPLICATE_RUNTIME_STORE_CONSTANT", `El almacén "${match[2]}" tiene más de una constante.`);
    }
    constantsByStore.set(match[2], match[1]);
  }

  const createdConstants = new Set(
    [...runtimeSource.matchAll(/\bcreateObjectStore\(\s*([A-Z][A-Z0-9_]*)\b/g)]
      .map((match) => match[1])
  );

  const seenTables = new Set();
  const mappedStores = new Set();
  let projectOwnerCount = 0;

  for (const entry of mapping.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        typeof entry.table !== "string" || !entry.table.trim()) {
      add("MAPPING_ENTRY", "Existe una entrada de tabla mal formada.");
      continue;
    }

    if (seenTables.has(entry.table)) {
      add("MAPPING_DUPLICATE_TABLE", `La tabla "${entry.table}" aparece más de una vez.`);
    }
    seenTables.add(entry.table);

    if (entry.table === "projects") {
      projectOwnerCount += 1;
      if (entry.implementationStatus !== "host-owned") {
        add("PROJECTS_MUST_BE_HOST_OWNED", "La identidad de projects debe seguir bajo responsabilidad del anfitrión.");
      }
      if (Array.isArray(entry.objectStores) && entry.objectStores.length > 0) {
        add("HOST_TABLE_HAS_RUNTIME_STORE", "projects no debe duplicarse en los almacenes narrativos del motor.");
      }
    } else if (entry.implementationStatus !== "implemented") {
      add(
        "UNIMPLEMENTED_ENGINE_TABLE",
        `La tabla propiedad del motor "${entry.table}" debe estar marcada implemented; estado actual: ${String(entry.implementationStatus)}.`
      );
    }

    if (!Array.isArray(entry.objectStores)) {
      add("MAPPING_OBJECT_STORES", `La tabla "${entry.table}" debe declarar objectStores como arreglo.`);
      continue;
    }
    if (entry.table !== "projects" && entry.implementationStatus === "implemented" &&
        entry.objectStores.length === 0) {
      add("MISSING_RUNTIME_STORE_MAPPING", `La tabla "${entry.table}" no declara ningún almacén físico.`);
    }

    const localStores = new Set();
    for (const storeName of entry.objectStores) {
      if (typeof storeName !== "string" || !storeName.trim()) {
        add("INVALID_RUNTIME_STORE_NAME", `La tabla "${entry.table}" contiene un nombre de almacén inválido.`);
        continue;
      }
      if (localStores.has(storeName)) {
        add("DUPLICATE_RUNTIME_STORE_MAPPING", `La tabla "${entry.table}" repite el almacén "${storeName}".`);
      }
      localStores.add(storeName);
      mappedStores.add(storeName);

      const constantName = constantsByStore.get(storeName);
      if (!constantName) {
        add("RUNTIME_STORE_CONSTANT_MISSING", `El almacén "${storeName}" no está declarado en indexeddb-store.ts.`);
      } else if (!createdConstants.has(constantName)) {
        add("RUNTIME_STORE_CREATION_MISSING", `El almacén "${storeName}" está declarado como ${constantName}, pero no se crea con createObjectStore.`);
      }
    }
  }

  if (projectOwnerCount !== 1) {
    add("PROJECTS_OWNER_COUNT", `Se esperaba una sola entrada projects bajo propiedad del anfitrión; se encontraron ${projectOwnerCount}.`);
  }

  const descriptors = mapping.runtime?.object_stores;
  if (!Array.isArray(descriptors)) {
    add("RUNTIME_STORE_DESCRIPTORS", "El manifiesto debe declarar runtime.object_stores como arreglo.");
  } else {
    const describedStores = new Set();
    for (const descriptor of descriptors) {
      if (!descriptor || typeof descriptor.name !== "string" || !descriptor.name.trim()) {
        add("INVALID_RUNTIME_STORE_DESCRIPTOR", "Existe una definición física sin nombre válido.");
        continue;
      }
      if (describedStores.has(descriptor.name)) {
        add("DUPLICATE_RUNTIME_STORE_DESCRIPTOR", `El almacén "${descriptor.name}" está definido más de una vez.`);
      }
      describedStores.add(descriptor.name);
      if (!mappedStores.has(descriptor.name)) {
        add("UNMAPPED_RUNTIME_STORE_DESCRIPTOR", `El almacén "${descriptor.name}" está definido físicamente pero ninguna tabla lo referencia.`);
      }
    }
    for (const storeName of mappedStores) {
      if (!describedStores.has(storeName)) {
        add("MISSING_RUNTIME_STORE_DESCRIPTOR", `El almacén "${storeName}" no tiene definición física en runtime.object_stores.`);
      }
    }
  }

  return issues;
}

async function main() {
  const [mappingText, runtimeSource] = await Promise.all([
    readFile(MAPPING_PATH, "utf8"),
    readFile(RUNTIME_PATH, "utf8")
  ]);
  const mapping = JSON.parse(mappingText);
  const issues = auditStorageImplementation(mapping, runtimeSource);

  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`[${issue.code}] ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const implementedTables = mapping.entries.filter(
    (entry) => entry.table !== "projects" && entry.implementationStatus === "implemented"
  ).length;
  const physicalStores = new Set(mapping.entries.flatMap((entry) => entry.objectStores ?? [])).size;
  console.log(
    `Auditoría física correcta: ${implementedTables} tablas del motor y ${physicalStores} almacenes IndexedDB declarados, definidos y creados. projects permanece bajo responsabilidad del anfitrión.`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("No se pudo completar la auditoría de almacenamiento:", error);
    process.exitCode = 1;
  });
}
