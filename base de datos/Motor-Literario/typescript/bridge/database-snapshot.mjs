#!/usr/bin/env node

/**
 * Copias de seguridad verificables del almacenamiento SQLite local.
 *
 * El respaldo usa VACUUM INTO para producir una base autónoma que incluye
 * las transacciones ya confirmadas aunque el origen trabaje en modo WAL.
 * La restauración requiere que el anfitrión haya detenido el puente y cerrado
 * todas las conexiones a la base de destino.
 */

import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const BACKUP_FORMAT = "motor-literario-sqlite-backup";
const BACKUP_FORMAT_VERSION = 1;
const DATABASE_SCHEMA_VERSION = "1";
const REQUIRED_TABLES = ["bridge_records", "bridge_document_heads", "bridge_metadata"];
const REQUIRED_COLUMNS = {
  bridge_records: [
    "collection", "record_key", "project_id", "writer_id",
    "document_id", "sequence", "sort_key", "value_json"
  ],
  bridge_document_heads: [
    "project_id", "document_id", "sequence", "revision", "text_length"
  ],
  bridge_metadata: ["key", "value"]
};

function requirePath(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(label + " es obligatorio.");
  }
  return resolve(value);
}

function sqlStringLiteral(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}

async function requireRegularFile(filePath, label) {
  const resolved = requirePath(filePath, label);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(label + " debe ser un archivo regular, no un enlace simbólico.");
  }
  return resolved;
}

async function ensureDestinationDirectory(filePath) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
}

async function assertDoesNotExist(filePath, label) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(label + " ya existe; no se sobrescribió.");
}

function inspectDatabaseFile(filePath) {
  const database = new DatabaseSync(filePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA query_only = ON");

    const integrityRows = database.prepare("PRAGMA integrity_check").all();
    if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== "ok") {
      throw new Error("La copia SQLite no supera PRAGMA integrity_check.");
    }

    const tables = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all().map(row => row.name));
    for (const table of REQUIRED_TABLES) {
      if (!tables.has(table)) {
        throw new Error("La base SQLite no contiene la tabla requerida: " + table + ".");
      }
    }

    for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
      const actual = new Set(database.prepare("PRAGMA table_info(" + table + ")")
        .all().map(column => column.name));
      if (required.some(column => !actual.has(column))) {
        throw new Error("La estructura SQLite de " + table + " no es compatible.");
      }
    }

    const schema = database.prepare(
      "SELECT value FROM bridge_metadata WHERE key = ?"
    ).get("schema_version");
    if (schema?.value !== DATABASE_SCHEMA_VERSION) {
      throw new Error(
        "Versión de base no compatible: se esperaba " +
        DATABASE_SCHEMA_VERSION + " y se recibió " + String(schema?.value ?? "ausente") + "."
      );
    }

    const invalidJson = database.prepare(
      "SELECT COUNT(*) AS total FROM bridge_records WHERE json_valid(value_json) = 0"
    ).get();
    if (Number(invalidJson?.total ?? -1) !== 0) {
      throw new Error("La base SQLite contiene registros JSON malformados.");
    }

    const recordCount = Number(database.prepare(
      "SELECT COUNT(*) AS total FROM bridge_records"
    ).get()?.total ?? 0);
    const documentHeadCount = Number(database.prepare(
      "SELECT COUNT(*) AS total FROM bridge_document_heads"
    ).get()?.total ?? 0);

    return {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
      recordCount,
      documentHeadCount
    };
  } finally {
    database.close();
  }
}

/**
 * Crea una copia consistente y autónoma de una base del puente SQLite.
 * El destino debe ser nuevo: nunca se sobrescribe una copia anterior.
 */
export async function createDatabaseBackup(sourcePath, destinationPath) {
  const source = await requireRegularFile(sourcePath, "La base de origen");
  const destination = requirePath(destinationPath, "La ruta de respaldo");
  if (source === destination) {
    throw new Error("El respaldo no puede sobrescribir la base de origen.");
  }

  await ensureDestinationDirectory(destination);
  await assertDoesNotExist(destination, "La ruta de respaldo");

  const temporary = destination + ".tmp-" + randomUUID();
  let database;
  try {
    database = new DatabaseSync(source);
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("VACUUM INTO " + sqlStringLiteral(temporary));
    database.close();
    database = undefined;

    try { await chmod(temporary, 0o600); } catch { /* Permisos POSIX no disponibles en todos los entornos. */ }
    const summary = inspectDatabaseFile(await requireRegularFile(temporary, "El respaldo temporal"));

    // link() publica el archivo sin sobrescribir un destino que aparezca en
    // una carrera entre la comprobación inicial y la finalización de VACUUM.
    await link(temporary, destination);
    await rm(temporary, { force: true });
    return { path: destination, ...summary };
  } catch (error) {
    try { database?.close(); } catch { /* La conexión pudo haberse cerrado. */ }
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Verifica la integridad y la compatibilidad de una copia sin modificarla. */
export async function verifyDatabaseBackup(backupPath) {
  const backup = await requireRegularFile(backupPath, "El respaldo");
  return { path: backup, ...inspectDatabaseFile(backup) };
}

async function moveSidecar(source, destination) {
  try {
    const info = await lstat(source);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Un archivo auxiliar SQLite no es regular: " + source);
    }
    await rename(source, destination);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Restaura un respaldo validado. Debe ejecutarse con el puente detenido.
 * Si ya existe una base de destino, se conserva como .pre-restore-* junto
 * con sus archivos WAL/journal para permitir una recuperación manual.
 */
export async function restoreDatabaseBackup(backupPath, destinationPath) {
  const backup = await requireRegularFile(backupPath, "El respaldo");
  const destination = requirePath(destinationPath, "La ruta de destino");
  if (backup === destination) {
    throw new Error("El respaldo y la base de destino no pueden ser el mismo archivo.");
  }

  const summary = await verifyDatabaseBackup(backup);
  await ensureDestinationDirectory(destination);

  const temporary = destination + ".restore-" + randomUUID();
  const recovery = destination + ".pre-restore-" + Date.now() + "-" + randomUUID();
  const sidecars = ["-wal", "-shm", "-journal"];
  const movedSidecars = [];
  let destinationMoved = false;

  try {
    await copyFile(backup, temporary, fsConstants.COPYFILE_EXCL);
    try { await chmod(temporary, 0o600); } catch { /* Permisos POSIX no disponibles en todos los entornos. */ }
    inspectDatabaseFile(await requireRegularFile(temporary, "La copia temporal de restauración"));

    try {
      const existing = await lstat(destination);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error("La base de destino debe ser un archivo regular.");
      }
      await rename(destination, recovery);
      destinationMoved = true;
      for (const suffix of sidecars) {
        const oldSidecar = destination + suffix;
        if (await moveSidecar(oldSidecar, recovery + suffix)) {
          movedSidecars.push(suffix);
        }
      }
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }

    await rename(temporary, destination);
    try { await chmod(destination, 0o600); } catch { /* Permisos POSIX no disponibles en todos los entornos. */ }

    return {
      path: destination,
      recoveryPath: destinationMoved ? recovery : null,
      ...summary
    };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (destinationMoved) {
      try {
        await rm(destination, { force: true });
        await rename(recovery, destination);
        for (const suffix of movedSidecars) {
          await moveSidecar(recovery + suffix, destination + suffix);
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Falló la restauración y también la recuperación del archivo anterior."
        );
      }
    }
    throw error;
  }
}

function readArguments(argv) {
  const [command, ...rest] = argv;
  const values = new Map();
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index];
    if (!key?.startsWith("--") || index + 1 >= rest.length || rest[index + 1].startsWith("--")) {
      throw new Error("Argumentos inválidos. Use --help para ver el uso.");
    }
    if (values.has(key)) throw new Error("Argumento repetido: " + key);
    values.set(key, rest[++index]);
  }
  if (values.has("--help")) return { command: "help", values };
  return { command, values };
}

function usage() {
  return [
    "Respaldo local del Motor Literario (SQLite)",
    "",
    "Crear:      node bridge/database-snapshot.mjs create --source <motor.sqlite> --destination <respaldo.sqlite>",
    "Verificar:  node bridge/database-snapshot.mjs verify --backup <respaldo.sqlite>",
    "Restaurar:  node bridge/database-snapshot.mjs restore --backup <respaldo.sqlite> --destination <motor.sqlite>",
    "",
    "La restauración exige detener el puente y cerrar todas las conexiones a la base destino."
  ].join("\n");
}

async function main(argv) {
  const { command, values } = readArguments(argv);
  if (command === "help" || command === "--help" || command === undefined) {
    process.stdout.write(usage() + "\n");
    return;
  }

  let result;
  if (command === "create") {
    if (values.size !== 4 || !values.has("--source") || !values.has("--destination")) {
      throw new Error("create requiere --source y --destination.");
    }
    result = await createDatabaseBackup(values.get("--source"), values.get("--destination"));
  } else if (command === "verify") {
    if (values.size !== 2 || !values.has("--backup")) {
      throw new Error("verify requiere --backup.");
    }
    result = await verifyDatabaseBackup(values.get("--backup"));
  } else if (command === "restore") {
    if (values.size !== 4 || !values.has("--backup") || !values.has("--destination")) {
      throw new Error("restore requiere --backup y --destination.");
    }
    result = await restoreDatabaseBackup(values.get("--backup"), values.get("--destination"));
  } else {
    throw new Error("Comando desconocido: " + String(command) + ". Use --help.");
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write("database-snapshot: " + String(error?.message ?? error) + "\n");
    process.exitCode = 1;
  });
}
