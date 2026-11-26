/**
 * Canonicalización y huella determinista de payloads JSON para sincronización narrativa.
 *
 * La huella permite comparar contenido entre runtimes/dispositivos; NO es una firma
 * criptográfica ni sustituye autenticación, autorización o validación del servidor.
 */

export interface NarrativeSyncCanonicalizationLimits {
  /** Profundidad máxima del árbol JSON. Predeterminado: 64. */
  readonly maxDepth?: number;
  /** Cantidad máxima de valores visitados. Predeterminado: 100_000. */
  readonly maxNodes?: number;
  /** Tamaño máximo UTF-8 del JSON canónico. Predeterminado: 1 MiB. */
  readonly maxBytes?: number;
}

const DEFAULT_LIMITS: Required<NarrativeSyncCanonicalizationLimits> = {
  maxDepth: 64,
  maxNodes: 100_000,
  maxBytes: 1_048_576
};

function resolveLimits(
  limits: NarrativeSyncCanonicalizationLimits
): Required<NarrativeSyncCanonicalizationLimits> {
  const resolved = {
    maxDepth: limits.maxDepth ?? DEFAULT_LIMITS.maxDepth,
    maxNodes: limits.maxNodes ?? DEFAULT_LIMITS.maxNodes,
    maxBytes: limits.maxBytes ?? DEFAULT_LIMITS.maxBytes
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(name + " debe ser un entero positivo.");
    }
  }
  return resolved;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Serializa valores JSON sin depender del orden de inserción de las propiedades.
 * Rechaza valores JavaScript que JSON.stringify omitiría o transformaría
 * silenciosamente, así como getters, prototipos personalizados y ciclos.
 */
export function canonicalizeNarrativeSyncPayload(
  payload: unknown,
  limits: NarrativeSyncCanonicalizationLimits = {}
): string {
  const resolved = resolveLimits(limits);
  const active = new WeakSet<object>();
  let visitedNodes = 0;

  const encode = (value: unknown, depth: number): string => {
    visitedNodes++;
    if (visitedNodes > resolved.maxNodes) {
      throw new RangeError("El payload supera el límite de nodos permitido.");
    }
    if (depth > resolved.maxDepth) {
      throw new RangeError("El payload supera la profundidad máxima permitida.");
    }

    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError("El payload contiene un número no finito.");
      }
      return JSON.stringify(value);
    }
    if (typeof value !== "object") {
      throw new TypeError("El payload contiene un valor que no pertenece a JSON.");
    }

    const objectValue = value as object;
    if (active.has(objectValue)) {
      throw new TypeError("El payload contiene una referencia circular.");
    }
    active.add(objectValue);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) {
          throw new TypeError("El payload contiene un array con prototipo personalizado.");
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
          throw new TypeError("El payload contiene propiedades Symbol.");
        }
        const keys = Object.keys(value);
        if (keys.length !== value.length) {
          throw new TypeError("El payload contiene un array disperso o propiedades adicionales.");
        }
        const encoded: string[] = [];
        for (let index = 0; index < value.length; index++) {
          const key = String(index);
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            throw new TypeError("El payload contiene una posición de array no serializable.");
          }
          encoded.push(encode(descriptor.value, depth + 1));
        }
        return "[" + encoded.join(",") + "]";
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("El payload contiene un objeto con prototipo personalizado.");
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError("El payload contiene propiedades Symbol.");
      }

      const ownKeys = Reflect.ownKeys(value);
      const keys = ownKeys.map(key => {
        if (typeof key !== "string") {
          throw new TypeError("El payload contiene propiedades Symbol.");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError("El payload contiene una propiedad no enumerable o un accessor.");
        }
        return key;
      }).sort(compareCodeUnits);

      return "{" + keys.map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        return JSON.stringify(key) + ":" + encode(descriptor.value, depth + 1);
      }).join(",") + "}";
    } finally {
      active.delete(objectValue);
    }
  };

  const canonical = encode(payload, 0);
  const byteLength = new TextEncoder().encode(canonical).byteLength;
  if (byteLength > resolved.maxBytes) {
    throw new RangeError("El payload canónico supera el límite UTF-8 permitido.");
  }
  return canonical;
}

/**
 * Calcula FNV-1a de 64 bits sobre UTF-8 canónico.
 * Es una huella de consistencia no criptográfica: no debe usarse para seguridad.
 */
export function fingerprintNarrativeSyncPayload(
  payload: unknown,
  limits: NarrativeSyncCanonicalizationLimits = {}
): string {
  const canonical = canonicalizeNarrativeSyncPayload(payload, limits);
  const bytes = new TextEncoder().encode(canonical);
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return "fnv1a64:" + hash.toString(16).padStart(16, "0");
}

/** Compara payloads JSON por su representación canónica, sin depender del orden de claves. */
export function areNarrativeSyncPayloadsEquivalent(
  left: unknown,
  right: unknown,
  limits: NarrativeSyncCanonicalizationLimits = {}
): boolean {
  return canonicalizeNarrativeSyncPayload(left, limits) ===
    canonicalizeNarrativeSyncPayload(right, limits);
}
