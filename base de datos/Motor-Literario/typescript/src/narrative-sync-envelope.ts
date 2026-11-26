/**
 * Sobre de sincronización narrativa versionado.
 *
 * Canonicaliza y verifica la identidad, orden y contenido de cada operación.
 * SHA-256 detecta alteraciones accidentales o incompatibilidad del payload,
 * pero no autentica al emisor: la autorización corresponde al servidor.
 */

import {
  canonicalizeNarrativeSyncPayload,
  type NarrativeSyncCanonicalizationLimits
} from "./narrative-sync-integrity";

export const NARRATIVE_SYNC_ENVELOPE_PROTOCOL = "motor-literario-sync" as const;
export const NARRATIVE_SYNC_ENVELOPE_VERSION = 1 as const;
export const DEFAULT_NARRATIVE_SYNC_BATCH_SIZE = 100;
export const MAX_NARRATIVE_SYNC_BATCH_SIZE = 500;

export interface NarrativeSyncOperationInput {
  readonly operationId: string;
  readonly projectId: string;
  readonly deviceId: string;
  readonly sequence: number;
  readonly kind: string;
  readonly createdAt: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface NarrativeSyncEnvelopeV1 extends NarrativeSyncOperationInput {
  readonly protocol: typeof NARRATIVE_SYNC_ENVELOPE_PROTOCOL;
  readonly protocolVersion: typeof NARRATIVE_SYNC_ENVELOPE_VERSION;
  /** SHA-256 de la representación canónica de todos los campos salvo este. */
  readonly envelopeSha256: string;
}

export interface NarrativeSyncEnvelopeOptions extends NarrativeSyncCanonicalizationLimits {}

export interface NarrativeSyncBatchOptions {
  readonly expectedProjectId?: string;
  readonly maxBatchSize?: number;
  readonly limits?: NarrativeSyncEnvelopeOptions;
}

const INPUT_KEYS = [
  "operationId", "projectId", "deviceId", "sequence", "kind", "createdAt", "payload"
] as const;

const ENVELOPE_KEYS = [
  "protocol", "protocolVersion", "operationId", "projectId", "deviceId",
  "sequence", "kind", "createdAt", "payload", "envelopeSha256"
] as const;

type DataRecord = Record<string, unknown>;

function readExactDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string
): DataRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(label + " debe ser un objeto plano.");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(label + " tiene un prototipo no permitido.");
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== allowedKeys.length ||
      ownKeys.some(key => typeof key !== "string" || !allowedKeys.includes(key))) {
    throw new TypeError(label + " contiene propiedades ausentes, adicionales o Symbol.");
  }

  const result: DataRecord = Object.create(null) as DataRecord;
  for (const key of allowedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(label + " contiene propiedades no enumerables o accessors.");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function assertIdentifier(value: unknown, label: string, maximum = 256): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() ||
      value.length > maximum) {
    throw new TypeError(label + " debe ser una cadena no vacía, recortada y de hasta " +
      maximum + " caracteres.");
  }
}

function assertOperationMetadata(record: DataRecord): void {
  assertIdentifier(record.operationId, "operationId");
  assertIdentifier(record.projectId, "projectId");
  assertIdentifier(record.deviceId, "deviceId");

  if (typeof record.kind !== "string" ||
      !/^[a-z][a-z0-9._-]{0,127}$/u.test(record.kind)) {
    throw new TypeError("kind debe usar un identificador ASCII en minúsculas de hasta 128 caracteres.");
  }
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1) {
    throw new RangeError("sequence debe ser un entero seguro mayor que cero.");
  }
  if (!Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0) {
    throw new RangeError("createdAt debe ser una marca temporal entera no negativa.");
  }
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new TypeError("payload debe ser un objeto JSON, no un array ni un valor primitivo.");
  }
  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("payload debe tener un prototipo plano o nulo.");
  }
}

function envelopeBody(record: DataRecord, payload: Readonly<Record<string, unknown>>): DataRecord {
  return {
    protocol: NARRATIVE_SYNC_ENVELOPE_PROTOCOL,
    protocolVersion: NARRATIVE_SYNC_ENVELOPE_VERSION,
    operationId: record.operationId,
    projectId: record.projectId,
    deviceId: record.deviceId,
    sequence: record.sequence,
    kind: record.kind,
    createdAt: record.createdAt,
    payload
  };
}

async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto SHA-256 no está disponible en este entorno seguro.");
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function cloneCanonicalPayload(
  payload: Readonly<Record<string, unknown>>,
  limits: NarrativeSyncEnvelopeOptions
): Readonly<Record<string, unknown>> {
  const canonical = canonicalizeNarrativeSyncPayload(payload, limits);
  const copy: unknown = JSON.parse(canonical);
  if (typeof copy !== "object" || copy === null || Array.isArray(copy)) {
    throw new TypeError("El payload canonicalizado dejó de ser un objeto.");
  }
  return copy as Readonly<Record<string, unknown>>;
}

/**
 * Construye un sobre nuevo. El payload se copia desde su forma canónica;
 * modificar el objeto original después no cambia la operación creada.
 */
export async function createNarrativeSyncEnvelope(
  input: NarrativeSyncOperationInput,
  limits: NarrativeSyncEnvelopeOptions = {}
): Promise<NarrativeSyncEnvelopeV1> {
  const record = readExactDataRecord(input, INPUT_KEYS, "La operación de sincronización");
  assertOperationMetadata(record);

  const payload = cloneCanonicalPayload(
    record.payload as Readonly<Record<string, unknown>>,
    limits
  );
  const body = envelopeBody(record, payload);
  const canonicalEnvelope = canonicalizeNarrativeSyncPayload(body, limits);
  const envelopeSha256 = await sha256Hex(canonicalEnvelope);

  return freezeJson({
    ...body,
    envelopeSha256
  }) as NarrativeSyncEnvelopeV1;
}

/**
 * Valida un sobre recibido de una fuente no confiable y comprueba su SHA-256.
 * Devuelve una copia canónica; nunca reutiliza referencias del objeto recibido.
 */
export async function verifyNarrativeSyncEnvelope(
  candidate: unknown,
  limits: NarrativeSyncEnvelopeOptions = {}
): Promise<NarrativeSyncEnvelopeV1> {
  const record = readExactDataRecord(candidate, ENVELOPE_KEYS, "El sobre de sincronización");
  if (record.protocol !== NARRATIVE_SYNC_ENVELOPE_PROTOCOL ||
      record.protocolVersion !== NARRATIVE_SYNC_ENVELOPE_VERSION) {
    throw new Error("Protocolo o versión de sobre de sincronización no compatibles.");
  }
  assertOperationMetadata(record);
  if (typeof record.envelopeSha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(record.envelopeSha256)) {
    throw new TypeError("envelopeSha256 debe contener 64 dígitos hexadecimales en minúsculas.");
  }

  const payload = cloneCanonicalPayload(
    record.payload as Readonly<Record<string, unknown>>,
    limits
  );
  const body = envelopeBody(record, payload);
  const canonicalEnvelope = canonicalizeNarrativeSyncPayload(body, limits);
  const expected = await sha256Hex(canonicalEnvelope);
  if (expected !== record.envelopeSha256) {
    throw new Error("La huella SHA-256 del sobre no coincide con su contenido.");
  }

  return freezeJson({
    ...body,
    envelopeSha256: expected
  }) as NarrativeSyncEnvelopeV1;
}

function assertDenseEnvelopeArray(value: unknown): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("El lote de sincronización debe ser un array estándar.");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (Object.getOwnPropertySymbols(value).length > 0 ||
      ownKeys.some(key => key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= value.length)) ||
      Object.keys(value).length !== value.length) {
    throw new TypeError("El lote contiene huecos o propiedades adicionales.");
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("El lote contiene posiciones no serializables.");
    }
  }
}

/**
 * Verifica un lote completo antes de enviarlo o aplicarlo.
 * Exige proyecto único, IDs únicos y secuencias crecientes por dispositivo.
 */
export async function validateNarrativeSyncEnvelopeBatch(
  candidates: unknown,
  options: NarrativeSyncBatchOptions = {}
): Promise<readonly NarrativeSyncEnvelopeV1[]> {
  assertDenseEnvelopeArray(candidates);

  const maxBatchSize = options.maxBatchSize ?? DEFAULT_NARRATIVE_SYNC_BATCH_SIZE;
  if (!Number.isSafeInteger(maxBatchSize) ||
      maxBatchSize < 1 || maxBatchSize > MAX_NARRATIVE_SYNC_BATCH_SIZE) {
    throw new RangeError("maxBatchSize debe estar entre 1 y " +
      MAX_NARRATIVE_SYNC_BATCH_SIZE + ".");
  }
  if (candidates.length > maxBatchSize) {
    throw new RangeError("El lote supera el máximo permitido de " + maxBatchSize + " operaciones.");
  }
  if (options.expectedProjectId !== undefined) {
    assertIdentifier(options.expectedProjectId, "expectedProjectId");
  }

  const verified: NarrativeSyncEnvelopeV1[] = [];
  const operationIds = new Set<string>();
  const lastSequenceByDevice = new Map<string, number>();
  let batchProjectId = options.expectedProjectId;

  for (const candidate of candidates) {
    const envelope = await verifyNarrativeSyncEnvelope(candidate, options.limits);
    if (batchProjectId === undefined) batchProjectId = envelope.projectId;
    if (envelope.projectId !== batchProjectId) {
      throw new Error("El lote mezcla operaciones de proyectos distintos.");
    }
    if (operationIds.has(envelope.operationId)) {
      throw new Error("El lote contiene operationId duplicados.");
    }
    operationIds.add(envelope.operationId);

    const previousSequence = lastSequenceByDevice.get(envelope.deviceId);
    if (previousSequence !== undefined && envelope.sequence <= previousSequence) {
      throw new Error("Las secuencias de cada dispositivo deben aumentar estrictamente dentro del lote.");
    }
    lastSequenceByDevice.set(envelope.deviceId, envelope.sequence);
    verified.push(envelope);
  }

  return Object.freeze(verified);
}
