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
}

export interface SyncOutboxPort {
  loadPendingSyncOperations(projectId: string, limit?: number): Promise<readonly SyncOperation[]>;
  recordSyncOperationAttempt(operationId: string, attemptedAt: number, error?: string): Promise<void>;
  acknowledgeSyncOperation(operationId: string): Promise<boolean>;
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

export interface NarrativeSyncCoordinatorOptions {
  readonly batchSize?: number;
  readonly now?: () => number;
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
      typeof operation.payload !== "string") {
    throw new TypeError("La bandeja devolvió una operación fuera de contrato o de otro proyecto.");
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
  }
  for (const id of result.retryableOperationIds) add(id, "operationId reintentable");
  if (classified.size !== sent.size) {
    throw new Error("El transporte dejó operaciones enviadas sin clasificar.");
  }
}

export class NarrativeSyncCoordinator {
  private readonly batchSize: number;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<NarrativeSyncResult>>();

  constructor(
    private readonly outbox: SyncOutboxPort,
    private readonly transport: SyncTransport,
    options: NarrativeSyncCoordinatorOptions = {}
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.batchSize) ||
        this.batchSize < 1 || this.batchSize > MAX_BATCH_SIZE) {
      throw new RangeError(`batchSize debe estar entre 1 y ${MAX_BATCH_SIZE}.`);
    }
  }

  /**
   * Ejecuta como máximo un envío simultáneo por proyecto en esta instancia.
   * Los proyectos distintos pueden sincronizarse en paralelo.
   */
  syncOnce(projectId: string): Promise<NarrativeSyncResult> {
    assertNonEmpty(projectId, "projectId");
    const active = this.inFlight.get(projectId);
    if (active) return active;
    const task = this.performSync(projectId).finally(() => {
      if (this.inFlight.get(projectId) === task) this.inFlight.delete(projectId);
    });
    this.inFlight.set(projectId, task);
    return task;
  }

  private async performSync(projectId: string): Promise<NarrativeSyncResult> {
    const pending = await this.outbox.loadPendingSyncOperations(projectId, this.batchSize);
    if (pending.length > this.batchSize) {
      throw new Error("La bandeja excedió el tamaño máximo solicitado.");
    }
    const ids = new Set<string>();
    const lastSequenceByDevice = new Map<string, number>();
    for (const operation of pending) {
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
    }

    if (pending.length === 0) {
      return { projectId, sent: 0, acknowledged: 0, conflicted: 0, retryable: 0, remaining: 0 };
    }

    const attemptedAt = this.now();
    if (!Number.isFinite(attemptedAt) || attemptedAt < 0) {
      throw new RangeError("El reloj de sincronización devolvió una marca temporal inválida.");
    }

    let response: SyncPushResult;
    try {
      response = await this.transport.push(projectId, pending);
      validatePushResult(response, pending);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error de transporte desconocido.";
      await Promise.all(pending.map(operation =>
        this.outbox.recordSyncOperationAttempt(operation.operationId, attemptedAt, message)
      ));
      throw error;
    }

    // Registrar el intento antes de retirar cualquier operación confirmada.
    await Promise.all(pending.map(operation =>
      this.outbox.recordSyncOperationAttempt(operation.operationId, attemptedAt)
    ));

    let acknowledged = 0;
    for (const operationId of response.acknowledgedOperationIds) {
      if (await this.outbox.acknowledgeSyncOperation(operationId)) acknowledged++;
    }

    return {
      projectId,
      sent: pending.length,
      acknowledged,
      conflicted: response.conflicts.length,
      retryable: response.retryableOperationIds.length,
      remaining: pending.length - acknowledged
    };
  }
}
