import type { PersonalIdeaLibraryEntry } from "../narrative-knowledge";

/**
 * Incremental FNV-1a checksum of archived entries in receipt ID order.
 * This detects accidental content drift; it is not a cryptographic signature.
 */
export function createPersonalIdeaArchiveChecksumBuilder(): {
  add(entry: PersonalIdeaLibraryEntry): void;
  digest(): string;
} {
  let hash = 0xcbf29ce484222325n;
  let count = 0;
  let finished = false;

  const update = (value: string): void => {
    for (let index = 0; index < value.length; index++) {
      hash ^= BigInt(value.charCodeAt(index));
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
  };

  update("[");

  return {
    add(entry): void {
      if (finished) throw new Error("El checksum de la biblioteca ya fue cerrado.");
      if (!entry || !entry.idea || typeof entry.idea.id !== "string" || !entry.idea.id.trim()) {
        throw new Error("No se puede calcular el checksum de una entrada de biblioteca inválida.");
      }
      const serialized = JSON.stringify(entry);
      if (typeof serialized !== "string") {
        throw new Error("La entrada de biblioteca no se puede serializar para comprobar su integridad.");
      }
      if (count > 0) update(",");
      update(serialized);
      count++;
    },
    digest(): string {
      if (finished) throw new Error("El checksum de la biblioteca ya fue cerrado.");
      finished = true;
      update("]");
      return "fnv1a64:" + hash.toString(16).padStart(16, "0");
    }
  };
}

export function isValidPersonalIdeaArchiveChecksum(value: unknown): value is string {
  return typeof value === "string" && /^fnv1a64:[0-9a-f]{16}$/u.test(value);
}
