/**
 * Coordinador de sincronización saliente.
 *
 * Este módulo no implementa red, autenticación ni resolución automática de
 * conflictos. Orquesta un transporte que aporta el anfitrión y una bandeja
 * durable que solo elimina operaciones tras un acuse explícito del servidor.
 */

export interface SyncOperation {
  readonly operationId: string;
  readonly projectId: string;
  readonly deviceId: string;
  readonly sequence: number;
  readonly kind: string;
  /** Payload JSON serializado y validado por el almacenamiento. */
  readonly payload: string;
  readonly createdAt: number;
  readonly attemptCount: number;
  readonly lastAttemptAt?: number;
  readonly lastError?: string;
  /** No transmitir antes de esta fecha; se conserva en la bandeja durable. */
  readonly nextAttemptAt?: number;
}

export interface SyncOutboxPort {
  /** Crea una operación con secuencia asignada por el almacén en una transacción atómica. */
  enqueueNextSyncOperation?(draft: Omit<SyncOperation, "sequence">): Promise<SyncOperation>;
  loadPendingSyncOperations(projectId: string, limit?: number): Promise<readonly SyncOperation[]>;
  recordSyncOperationAttempt(
    operationId: string,
    attemptedAt: number,
    error?: string,
    nextAttemptAt?: number
  ): Promise<void>;
  countPendingSyncOperations(projectId: string): Promise<number>;
  acknowledgeSyncOperation(operationId: string): Promise<boolean>;
  /** Retira acuses en una única transacción cuando el almacén lo soporta. */
  acknowledgeSyncOperations?(operationIds: readonly string[]): Promise<number>;
}

/** Payload versionado de un delta textual confirmado por el motor narrativo. */
export interface NarrativeDocumentChangePayloadV1 {
  readonly schemaVersion: 1;
  readonly documentId: string;
  readonly sequence: number;
  readonly baseRevision: number;
  readonly committedRevision: number;
  /** Offsets UTF-16, compatibles con las posiciones del editor JavaScript. */
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/** Valida el contrato público del payload narrative-document-change.v1. */
export function validateNarrativeDocumentChangePayloadV1(
  value: unknown
): asserts value is NarrativeDocumentChangePayloadV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("El delta narrativo debe ser un objeto JSON.");
  }
  const payload = value as Record<string, unknown>;
  if (payload.schemaVersion !== 1 ||
      typeof payload.documentId !== "string" || !payload.documentId.trim() ||
      payload.documentId.length > 512 ||
      !Number.isSafeInteger(payload.sequence) || (payload.sequence as number) < 1 ||
      !Number.isSafeInteger(payload.baseRevision) || (payload.baseRevision as number) < 0 ||
      !Number.isSafeInteger(payload.committedRevision) ||
      payload.committedRevision !== (payload.baseRevision as number) + 1 ||
      !Number.isSafeInteger(payload.start) || (payload.start as number) < 0 ||
      !Number.isSafeInteger(payload.end) || (payload.end as number) < (payload.start as number) ||
      typeof payload.replacement !== "string") {
    throw new TypeError("El payload narrative-document-change.v1 no cumple el esquema 1.");
  }
}

export interface SyncConflict {
  readonly operationId: string;
  readonly code: string;
  readonly message?: string;
}

export interface SyncPushResult {
  /** IDs aceptados durablemente por el servidor; únicamente estos se retiran. */
  readonly acknowledgedOperationIds: readonly string[];
  /** Conflictos que requieren decisión o reconciliación explícita. */
  readonly conflicts: readonly SyncConflict[];
  /** Operaciones no procesadas que pueden volver a intentarse. */
  readonly retryableOperationIds: readonly string[];
}

export interface SyncTransport {
  push(projectId: string, operations: readonly SyncOperation[]): Promise<SyncPushResult>;
}

export interface SyncExecutionLock {
  /** Ejecuta la tarea en exclusión mutua para la clave compartida entre coordinadores. */
  runExclusive<T>(key: string, task: () => Promise<T>): Promise<T>;
}

export interface NarrativeSyncCoordinatorOptions {
  readonly batchSize?: number;
  readonly now?: () => number;
  /** Espera exponencial inicial tras un fallo, en milisegundos. */
  readonly retryBaseDelayMs?: number;
  /** Límite superior del backoff, en milisegundos. */
  readonly retryMaxDelayMs?: number;
  /** Fuente inyectable para jitter determinista en pruebas. Devuelve [0, 1]. */
  readonly random?: () => number;
  /** Bloqueo compartido opcional (Web Locks o lease durable del anfitrión). */
  readonly executionLock?: SyncExecutionLock;
}

export interface NarrativeSyncResult {
  readonly projectId: string;
  readonly sent: number;
  readonly acknowledged: number;
  readonly conflicted: number;
  readonly retryable: number;
  readonly remaining: number;
}

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 500;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 5 * 60_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60_000;

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} debe ser una cadena no vacía.`);
  }
}

function validateOperation(operation: SyncOperation, projectId: string): void {
  if (!operation || typeof operation !== "object") {
    throw new TypeError("La bandeja devolvió una operación malformada.");
  }
  assertNonEmpty(operation.operationId, "operationId");
  assertNonEmpty(operation.projectId, "projectId");
  assertNonEmpty(operation.deviceId, "deviceId");
  assertNonEmpty(operation.kind, "kind");
  if (operation.projectId !== projectId ||
      !Number.isSafeInteger(operation.sequence) || operation.sequence < 1 ||
      !Number.isFinite(operation.createdAt) || operation.createdAt < 0 ||
      !Number.isSafeInteger(operation.attemptCount) || operation.attemptCount < 0 ||
      typeof operation.payload !== "string" || operation.payload.length > 2_000_000 ||
      operation.operationId.length > 256 || operation.deviceId.length > 256 ||
      operation.kind.length > 128 ||
      (operation.lastAttemptAt !== undefined &&
        (!Number.isFinite(operation.lastAttemptAt) || operation.lastAttemptAt < 0)) ||
      (operation.lastError !== undefined &&
        (typeof operation.lastError !== "string" || operation.lastError.length > 2048)) ||
      (operation.nextAttemptAt !== undefined &&
        (!Number.isFinite(operation.nextAttemptAt) || operation.nextAttemptAt < 0 ||
          (operation.lastAttemptAt !== undefined && operation.nextAttemptAt < operation.lastAttemptAt)))) {
    throw new TypeError("La bandeja devolvió una operación fuera de contrato o de otro proyecto.");
  }
  let payload: unknown;
  try { payload = JSON.parse(operation.payload); }
  catch { throw new TypeError("La bandeja devolvió un payload que no es JSON válido."); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("El payload de sincronización debe ser un objeto JSON.");
  }
  if (operation.kind === "narrative-document-change.v1") {
    validateNarrativeDocumentChangePayloadV1(payload);
  }
}

function validatePushResult(
  result: SyncPushResult,
  operations: readonly SyncOperation[]
): void {
  if (!result || !Array.isArray(result.acknowledgedOperationIds) ||
      !Array.isArray(result.conflicts) || !Array.isArray(result.retryableOperationIds)) {
    throw new TypeError("El transporte devolvió una respuesta de sincronización malformada.");
  }
  const sent = new Set(operations.map(operation => operation.operationId));
  const classified = new Set<string>();
  const add = (id: unknown, label: string): void => {
    assertNonEmpty(id, label);
    if (!sent.has(id)) throw new Error(`El transporte clasificó una operación no enviada: ${id}.`);
    if (classified.has(id)) throw new Error(`El transporte clasificó dos veces la operación: ${id}.`);
    classified.add(id);
  };
  for (const id of result.acknowledgedOperationIds) add(id, "operationId confirmado");
  for (const conflict of result.conflicts) {
    if (!conflict || typeof conflict !== "object") {
      throw new TypeError("El transporte devolvió un conflicto malformado.");
    }
    add(conflict.operationId, "operationId del conflicto");
    assertNonEmpty(conflict.code, "code del conflicto");
    if (conflict.code.length > 128) {
      throw new TypeError("El código del conflicto supera el límite permitido.");
    }
    if (conflict.message !== undefined &&
        (typeof conflict.message !== "string" || conflict.message.length > 2048)) {
      throw new TypeError("El mensaje del conflicto supera el límite permitido.");
    }
  }
  for (const id of result.retryableOperationIds) add(id, "operationId reintentable");
  if (classified.size !== sent.size) {
    throw new Error("El transporte dejó operaciones enviadas sin clasificar.");
  }
}

export class NarrativeSyncCoordinator {
  private readonly batchSize: number;
  private readonly now: () => number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly random: () => number;
  private readonly executionLock?: SyncExecutionLock;
  private readonly inFlight = new Map<string, Promise<NarrativeSyncResult>>();

  constructor(
    private readonly outbox: SyncOutboxPort,
    private readonly transport: SyncTransport,
    options: NarrativeSyncCoordinatorOptions = {}
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.now = options.now ?? Date.now;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.random = options.random ?? Math.random;
    this.executionLock = options.executionLock;
    if (this.executionLock !== undefined &&
        (typeof this.executionLock !== "object" || typeof this.executionLock.runExclusive !== "function")) {
      throw new TypeError("executionLock debe implementar runExclusive.");
    }
    if (!Number.isSafeInteger(this.batchSize) ||
        this.batchSize < 1 || this.batchSize > MAX_BATCH_SIZE) {
      throw new RangeError(`batchSize debe estar entre 1 y ${MAX_BATCH_SIZE}.`);
    }
    if (!Number.isSafeInteger(this.retryBaseDelayMs) ||
        this.retryBaseDelayMs < 1 || this.retryBaseDelayMs > MAX_RETRY_DELAY_MS ||
        !Number.isSafeInteger(this.retryMaxDelayMs) ||
        this.retryMaxDelayMs < this.retryBaseDelayMs ||
        this.retryMaxDelayMs > MAX_RETRY_DELAY_MS) {
      throw new RangeError("Los límites de backoff deben ser enteros positivos, crecientes y no superar 24 horas.");
    }
    if (typeof this.random !== "function") {
      throw new TypeError("Se requiere una fuente de jitter válida.");
    }
  }

  /** Calcula backoff exponencial con jitter igual para evitar reintentos sincronizados. */
  private nextRetryAt(operation: SyncOperation, attemptedAt: number): number {
    const exponent = Math.min(operation.attemptCount, 52);
    const ceiling = Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * (2 ** exponent));
    const sample = this.random();
    if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
      throw new RangeError("La fuente de jitter debe devolver un número entre 0 y 1.");
    }
    const delay = Math.max(1, Math.floor(ceiling * (0.5 + sample * 0.5)));
    const retryAt = attemptedAt + delay;
    if (!Number.isSafeInteger(retryAt)) {
      throw new RangeError("La fecha del próximo intento excede el rango seguro.");
    }
    return retryAt;
  }

  private async recordAttempt(
    operation: SyncOperation,
    attemptedAt: number,
    error?: string,
    scheduleRetry = false
  ): Promise<void> {
    const nextAttemptAt = scheduleRetry ? this.nextRetryAt(operation, attemptedAt) : undefined;
    await this.outbox.recordSyncOperationAttempt(
      operation.operationId,
      attemptedAt,
      error?.slice(0, 2048),
      nextAttemptAt
    );
  }

  /**
   * Ejecuta como máximo un envío simultáneo por proyecto en esta instancia.
   * Los proyectos distintos pueden sincronizarse en paralelo.
   */
  syncOnce(projectId: string): Promise<NarrativeSyncResult> {
    assertNonEmpty(projectId, "projectId");
    const active = this.inFlight.get(projectId);
    if (active) return active;
    const execution = () => this.performSync(projectId);
    const task = (this.executionLock
      ? this.executionLock.runExclusive(`narrative-sync:${projectId}`, execution)
      : execution()).finally(() => {
      if (this.inFlight.get(projectId) === task) this.inFlight.delete(projectId);
    });
    this.inFlight.set(projectId, task);
    return task;
  }

  private async performSync(projectId: string): Promise<NarrativeSyncResult> {
    const attemptedAt = this.now();
    if (!Number.isFinite(attemptedAt) || attemptedAt < 0) {
      throw new RangeError("El reloj de sincronización devolvió una marca temporal inválida.");
    }

    const loaded = await this.outbox.loadPendingSyncOperations(projectId, this.batchSize);
    if (loaded.length > this.batchSize) {
      throw new Error("La bandeja excedió el tamaño máximo solicitado.");
    }
    const ids = new Set<string>();
    const lastSequenceByDevice = new Map<string, number>();
    const pending: SyncOperation[] = [];
    const devicesBlockedByBackoff = new Set<string>();
    for (const operation of loaded) {
      validateOperation(operation, projectId);
      if (ids.has(operation.operationId)) {
        throw new Error("La bandeja devolvió operationId duplicados.");
      }
      ids.add(operation.operationId);
      const previous = lastSequenceByDevice.get(operation.deviceId);
      if (previous !== undefined && operation.sequence <= previous) {
        throw new Error("La bandeja no devolvió secuencias crecientes por dispositivo.");
      }
      lastSequenceByDevice.set(operation.deviceId, operation.sequence);

      // El backoff bloquea solo el flujo causal de su dispositivo.
      // Otros dispositivos son escritores independientes y pueden progresar.
      if (!devicesBlockedByBackoff.has(operation.deviceId) &&
          (operation.nextAttemptAt ?? 0) <= attemptedAt) {
        pending.push(operation);
      } else {
        devicesBlockedByBackoff.add(operation.deviceId);
      }
    }

    if (pending.length === 0) {
      const remaining = await this.outbox.countPendingSyncOperations(projectId);
      return { projectId, sent: 0, acknowledged: 0, conflicted: 0, retryable: 0, remaining };
    }

    let response: SyncPushResult;
    try {
      response = await this.transport.push(projectId, pending);
      validatePushResult(response, pending);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error de transporte desconocido.";
      await Promise.all(pending.map(operation =>
        this.recordAttempt(operation, attemptedAt, message, true)
      ));
      throw error;
    }

    const acknowledgedIds = new Set(response.acknowledgedOperationIds);
    const conflictsById = new Map<string, SyncConflict>(
      response.conflicts.map(conflict => [conflict.operationId, conflict] as const)
    );
    const retryableIds = new Set(response.retryableOperationIds);

    // Los acuses limpian el backoff anterior. Conflictos y reintentos quedan
    // durables con su próxima fecha; no se elimina nada antes del acuse.
    await Promise.all(pending.map(operation => {
      if (acknowledgedIds.has(operation.operationId)) {
        return this.recordAttempt(operation, attemptedAt);
      }
      const conflict = conflictsById.get(operation.operationId);
      if (conflict) {
        const detail = conflict.message ? ": " + conflict.message : "";
        return this.recordAttempt(operation, attemptedAt, "conflict: " + conflict.code + detail, true);
      }
      if (retryableIds.has(operation.operationId)) {
        return this.recordAttempt(operation, attemptedAt, "retryable response", true);
      }
      throw new Error("La respuesta validada perdió la clasificación de una operación.");
    }));

    let acknowledged = 0;
    if (this.outbox.acknowledgeSyncOperations) {
      acknowledged = await this.outbox.acknowledgeSyncOperations(response.acknowledgedOperationIds);
    } else {
      for (const operationId of response.acknowledgedOperationIds) {
        if (await this.outbox.acknowledgeSyncOperation(operationId)) acknowledged++;
      }
    }
    const remaining = await this.outbox.countPendingSyncOperations(projectId);

    return {
      projectId,
      sent: pending.length,
      acknowledged,
      conflicted: response.conflicts.length,
      retryable: response.retryableOperationIds.length,
      remaining
    };
  }
}
