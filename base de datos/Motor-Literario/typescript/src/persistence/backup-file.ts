/** Construye un Blob JSON descargable sin modificar ni filtrar el respaldo. */
export function createIndexedDbBackupBlob(backup: unknown): Blob {
  if (!backup || typeof backup !== "object" || Array.isArray(backup)) {
    throw new Error("El respaldo IndexedDB debe ser un objeto JSON.");
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(backup);
  } catch {
    throw new Error("No se pudo serializar el respaldo IndexedDB como JSON.");
  }
  if (typeof serialized !== "string") {
    throw new Error("No se pudo serializar el respaldo IndexedDB como JSON.");
  }
  return new Blob([serialized], { type: "application/json;charset=utf-8" });
}

/**
 * Lee un archivo elegido por el anfitrión. La validación de versión, checksum,
 * almacenes y registros se realiza después en restoreDatabaseBackup().
 */
export async function readIndexedDbBackupFile(
  file: Pick<Blob, "size" | "text">
): Promise<unknown> {
  if (!file || typeof file !== "object" ||
      !Number.isSafeInteger(file.size) || file.size <= 0 ||
      typeof file.text !== "function") {
    throw new Error("El archivo de respaldo está vacío o no es válido.");
  }

  let source: string;
  try {
    source = await file.text();
  } catch {
    throw new Error("No se pudo leer el archivo de respaldo seleccionado.");
  }
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error("El archivo de respaldo está vacío.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error("El archivo seleccionado no contiene JSON válido.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("El archivo JSON no contiene un manifiesto de respaldo.");
  }
  return parsed;
}

/** Descarga un respaldo completo en el navegador sin enviarlo a ningún servicio. */
export function downloadIndexedDbBackupFile(
  backup: unknown,
  filename = `motor-literario-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`
): void {
  const safeFilename = filename.trim();
  const deviceName = safeFilename.split(".", 1)[0]?.toUpperCase() ?? "";
  if (!safeFilename || safeFilename.length > 180 ||
      /[<>:"|?*]/u.test(safeFilename) ||
      safeFilename.includes("/") || safeFilename.includes("\\") ||
      [...safeFilename].some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      safeFilename.endsWith(".") || safeFilename.endsWith(" ") ||
      safeFilename === "." || safeFilename === ".." ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceName)) {
    throw new Error("El nombre del archivo de respaldo no es válido.");
  }

  if (typeof document === "undefined" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function" ||
      typeof URL.revokeObjectURL !== "function") {
    throw new Error("La descarga de respaldos requiere un navegador compatible.");
  }

  const blob = createIndexedDbBackupBlob(backup);
  const objectUrl = URL.createObjectURL(blob);
  let link: HTMLAnchorElement | undefined;

  try {
    link = document.createElement("a");
    link.href = objectUrl;
    link.download = /\.json$/iu.test(safeFilename) ? safeFilename : `${safeFilename}.json`;
    link.hidden = true;

    const parent = document.body ?? document.documentElement;
    if (!parent) {
      throw new Error("El documento no está preparado para descargar el respaldo.");
    }
    parent.append(link);
    link.click();
  } finally {
    // La URL se libera incluso si crear, insertar o retirar el enlace falla.
    try {
      link?.remove();
    } finally {
      // Mantiene la URL activa mientras el navegador inicia la descarga.
      globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }
  }
}
