import {
  createNarrativeIdeaContinuityIndexSyncEnvelope,
  NARRATIVE_IDEA_CONTINUITY_SYNC_LIMITS,
  validateNarrativeIdeaContinuityIndex,
  type NarrativeIdeaContinuityIndex,
  type NarrativeIdeaContinuityIndexSyncPayload
} from "./narrative-idea-continuity-index";
import {
  canonicalizeNarrativeSyncPayload,
  verifyNarrativeSyncOperationEnvelope,
  type NarrativeSyncCanonicalizationLimits,
  type NarrativeSyncOperationEnvelope
} from "./narrative-sync-integrity";

export type NarrativeSyncOutboxStatus = "pending" | "leased" | "delivered";

export interface NarrativeSyncOutboxEntry {
  readonly projectId: string;
  readonly generation: number;
  readonly fingerprint: string;
  readonly writerId: string;
  readonly sequence: number;
  readonly operationId: string;
  readonly envelope: NarrativeSyncOperationEnvelope<NarrativeIdeaContinuityIndexSyncPayload>;
  readonly status: NarrativeSyncOutboxStatus;
  readonly attempts: number;
  readonly createdAt: number;
  readonly nextAttemptAt: number;
  readonly lastAttemptAt?: number;
  readonly deliveredAt?: number;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: number;
  readonly lastError?: string;
}

interface OutboxProjectCursor {
  readonly projectId: string;
  readonly lastGeneration: number;
  readonly updatedAt: number;
}

interface OutboxWriterCursor {
  readonly projectId: string;
  readonly writerId: string;
  readonly lastSequence: number;
  readonly lastOperationId: string;
  readonly updatedAt: number;
}

export interface EnqueueNarrativeIdeaContinuityIndexInput {
  readonly index: NarrativeIdeaContinuityIndex;
  readonly writerId: string;
  readonly expectedGeneration?: number;
  readonly createdAt?: number;
}

export type EnqueueNarrativeIdeaContinuityIndexResult =
  | { readonly status: "queued"; readonly entry: NarrativeSyncOutboxEntry }
  | { readonly status: "duplicate"; readonly entry: NarrativeSyncOutboxEntry };

export interface ClaimNarrativeSyncOutboxInput {
  readonly projectId: string;
  readonly workerId: string;
  readonly now?: number;
  readonly leaseMs?: number;
}

export interface DeliverNarrativeSyncOutboxInput extends ClaimNarrativeSyncOutboxInput {
  readonly send: (
    envelope: NarrativeSyncOperationEnvelope<NarrativeIdeaContinuityIndexSyncPayload>
  ) => Promise<void>;
  readonly baseRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
}

export interface DeliverNarrativeSyncOutboxResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly deferred: number;
  readonly failedGenerations: readonly number[];
}

export interface NarrativeSyncOutboxOptions {
  readonly databaseName?: string;
  readonly canonicalizationLimits?: NarrativeSyncCanonicalizationLimits;
}

const OPERATIONS = "outbox-operations";
const WRITER_CURSORS = "outbox-writer-cursors";
const PROJECT_CURSORS = "outbox-project-cursors";
const MAX_WRITER_ID_UNITS = 256;
const MAX_ERROR_UNITS = 1_024;

function validateIdentifier(value: unknown, name: string, maximum = 256): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new TypeError(name + " debe ser un identificador no vacío de máximo " + maximum + " caracteres.");
  }
}

function validateOutboxCursor(
  value: OutboxWriterCursor | undefined,
  projectId: string,
  writerId: string
): void {
  if (value !== undefined && (
    !value || value.projectId !== projectId || value.writerId !== writerId ||
    !Number.isSafeInteger(value.lastSequence) || value.lastSequence < 1 ||
    value.lastSequence >= Number.MAX_SAFE_INTEGER ||
    typeof value.lastOperationId !== "string" || !value.lastOperationId.trim() ||
    !Number.isFinite(value.updatedAt) || value.updatedAt < 0
  )) {
    throw new Error("El cursor del outbox está corrupto; no se asignará una secuencia nueva.");
  }
}

function validateOutboxProjectCursor(
  value: OutboxProjectCursor | undefined,
  projectId: string
): void {
  if (value !== undefined && (
    !value || value.projectId !== projectId ||
    !Number.isSafeInteger(value.lastGeneration) || value.lastGeneration < 1 ||
    !Number.isFinite(value.updatedAt) || value.updatedAt < 0
  )) {
    throw new Error("El cursor de generaciones del proyecto está corrupto.");
  }
}

function validateStoredEntry(value: NarrativeSyncOutboxEntry): void {
  if (!value || typeof value !== "object" ||
      typeof value.projectId !== "string" || !value.projectId.trim() ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      typeof value.fingerprint !== "string" ||
      typeof value.writerId !== "string" || !value.writerId.trim() ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      typeof value.operationId !== "string" || !value.operationId.trim() ||
      !["pending", "leased", "delivered"].includes(value.status) ||
      !Number.isSafeInteger(value.attempts) || value.attempts < 0 ||
      !Number.isFinite(value.createdAt) || value.createdAt < 0 ||
      !Number.isFinite(value.nextAttemptAt) || value.nextAttemptAt < 0) {
    throw new Error("Una entrada del outbox tiene metadatos inválidos.");
  }
  if (value.attempts === 0
    ? value.lastAttemptAt !== undefined
    : (!Number.isFinite(value.lastAttemptAt) ||
       (value.lastAttemptAt ?? -1) < value.createdAt)) {
    throw new Error("El contador de intentos del outbox no coincide con su fecha de último intento.");
  }
  if (value.status === "leased" &&
      (typeof value.leaseOwner !== "string" || !value.leaseOwner.trim() ||
       !Number.isFinite(value.leaseExpiresAt) || (value.leaseExpiresAt ?? -1) < 0 ||
       !Number.isFinite(value.lastAttemptAt) || (value.lastAttemptAt ?? -1) < value.createdAt ||
       value.attempts < 1)) {
    throw new Error("Una entrada reclamada del outbox perdió su lease o sus metadatos de intento.");
  }
  if (value.status === "pending" &&
      (value.leaseOwner !== undefined || value.leaseExpiresAt !== undefined)) {
    throw new Error("Una entrada pendiente no puede conservar un lease activo.");
  }
  if (value.status === "delivered" &&
      (!Number.isFinite(value.deliveredAt) || (value.deliveredAt ?? -1) < value.createdAt ||
       value.attempts < 1 ||
       (value.lastAttemptAt !== undefined && (value.deliveredAt ?? -1) < value.lastAttemptAt) ||
       value.leaseOwner !== undefined || value.leaseExpiresAt !== undefined)) {
    throw new Error("Una entrada entregada tiene fechas o metadatos de lease inconsistentes.");
  }
  if (value.lastError !== undefined &&
      (typeof value.lastError !== "string" || value.lastError.length > MAX_ERROR_UNITS)) {
    throw new Error("El último error del outbox excede el formato o límite permitido.");
  }
  const envelope = value.envelope;
  if (!envelope || envelope.projectId !== value.projectId ||
      envelope.writerId !== value.writerId ||
      envelope.sequence !== value.sequence ||
      envelope.operationId !== value.operationId ||
      envelope.kind !== "idea-continuity-index-upsert" ||
      envelope.payload?.index?.projectId !== value.projectId ||
      envelope.payload?.index?.generation !== value.generation ||
      envelope.payload?.index?.fingerprint !== value.fingerprint ||
      (envelope.payload?.expectedGeneration ?? 0) !== value.generation - 1 ||
      envelope.createdAt !== value.createdAt) {
    throw new Error("La envoltura no coincide con la identidad persistida del outbox.");
  }
  validateIdentifier(value.writerId, "writerId", MAX_WRITER_ID_UNITS);
  if (value.operationId !==
      "continuity-index:" + encodeURIComponent(value.projectId) + ":" +
      encodeURIComponent(value.writerId) + ":" + value.generation) {
    throw new Error("El operationId del outbox no coincide con el proyecto y la generación.");
  }
  validateNarrativeIdeaContinuityIndex(envelope.payload.index);
}

/**
 * Outbox saliente separado del diario de recepción. Las operaciones de este
 * almacén esperan entrega remota; nunca se exponen a replayPending como entradas
 * que el consumidor local deba volver a aplicar.
 */
export class IndexedDbNarrativeSyncOutbox {
  private database: Promise<IDBDatabase> | undefined;
  private readonly databaseName: string;
  private readonly canonicalizationLimits: NarrativeSyncCanonicalizationLimits;

  constructor(options: NarrativeSyncOutboxOptions = {}) {
    this.databaseName = options.databaseName ?? "motor-literario-sync-outbox";
    validateIdentifier(this.databaseName, "databaseName", 512);
    this.canonicalizationLimits = Object.freeze({
      ...(options.canonicalizationLimits ?? NARRATIVE_IDEA_CONTINUITY_SYNC_LIMITS)
    });
    canonicalizeNarrativeSyncPayload(null, this.canonicalizationLimits);
  }

  verifyEnvelope(
    envelope: NarrativeSyncOperationEnvelope<NarrativeIdeaContinuityIndexSyncPayload>
  ): Promise<boolean> {
    return verifyNarrativeSyncOperationEnvelope(envelope, this.canonicalizationLimits);
  }

  close(): void {
    const current = this.database;
    this.database = undefined;
    void current?.then(database => database.close()).catch(() => undefined);
  }

  /**
   * Encola una generación de continuidad y asigna una secuencia durable por
   * escritor. Un retry de la misma generación y huella es idempotente.
   */
  async enqueueContinuityIndex(
    input: EnqueueNarrativeIdeaContinuityIndexInput
  ): Promise<EnqueueNarrativeIdeaContinuityIndexResult> {
    if (!input || typeof input !== "object" || !input.index) {
      throw new TypeError("Se necesita un índice de continuidad para encolar.");
    }
    validateNarrativeIdeaContinuityIndex(input.index);
    const projectId = input.index.projectId;
    validateIdentifier(projectId, "projectId");
    validateIdentifier(input.writerId, "writerId", MAX_WRITER_ID_UNITS);
    const expectedGeneration = input.expectedGeneration;
    if (expectedGeneration !== undefined &&
        (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 ||
         expectedGeneration >= Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("La generación anterior del índice no es válida.");
    }
    if (input.index.generation !== (expectedGeneration ?? 0) + 1) {
      throw new Error("El índice debe avanzar exactamente desde la generación anterior declarada.");
    }
    const createdAt = input.createdAt ?? input.index.updatedAt;
    if (!Number.isFinite(createdAt) || createdAt < 0) {
      throw new RangeError("La fecha de creación del outbox no es válida.");
    }

    const generation = input.index.generation;
    const fingerprint = input.index.fingerprint;
    const operationId = "continuity-index:" + encodeURIComponent(projectId) + ":" +
      encodeURIComponent(input.writerId) + ":" + generation;
    const database = await this.open();

    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = await this.readEnqueueSnapshot(database, projectId, generation, input.writerId);
      if (snapshot.existing) {
        validateStoredEntry(snapshot.existing);
        validateNarrativeIdeaContinuityIndex(snapshot.existing.envelope.payload.index);
        if (!(await this.verifyEnvelope(snapshot.existing.envelope))) {
          throw new Error("La entrada existente del outbox no supera SHA-256.");
        }
        if (snapshot.existing.fingerprint !== fingerprint ||
            snapshot.existing.envelope.payload.expectedGeneration !== expectedGeneration) {
          throw new Error("Conflicto de outbox: la misma generación ya se encoló con otro contenido o base.");
        }
        return { status: "duplicate", entry: snapshot.existing };
      }
      validateOutboxCursor(snapshot.cursor, projectId, input.writerId);
      validateOutboxProjectCursor(snapshot.projectCursor, projectId);
      if (snapshot.projectCursor &&
          (generation !== snapshot.projectCursor.lastGeneration + 1 ||
           expectedGeneration !== snapshot.projectCursor.lastGeneration)) {
        throw new Error(
          "El outbox exige generaciones consecutivas; primero debe encolarse la generación anterior del proyecto."
        );
      }
      const sequence = (snapshot.cursor?.lastSequence ?? 0) + 1;
      if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) {
        throw new Error("El escritor alcanzó el límite seguro de secuencias del outbox.");
      }

      const envelope = await createNarrativeIdeaContinuityIndexSyncEnvelope({
        operationId,
        projectId,
        writerId: input.writerId,
        sequence,
        createdAt,
        payload: {
          index: input.index,
          ...(expectedGeneration !== undefined ? { expectedGeneration } : {})
        }
      }, this.canonicalizationLimits);

      const entry: NarrativeSyncOutboxEntry = {
        projectId,
        generation,
        fingerprint,
        writerId: input.writerId,
        sequence,
        operationId,
        envelope,
        status: "pending",
        attempts: 0,
        createdAt,
        nextAttemptAt: createdAt
      };
      const result = await this.commitEnqueueSnapshot(
        database,
        entry,
        snapshot.cursor?.lastSequence ?? 0,
        snapshot.projectCursor?.lastGeneration ?? 0
      );
      if (result.status === "retry") continue;
      validateStoredEntry(result.entry);
      return { status: result.status, entry: result.entry };
    }
    throw new Error("El outbox cambió durante cuatro intentos de reserva de secuencia; reintentar más tarde.");
  }

  async loadEntries(
    projectId: string,
    status?: NarrativeSyncOutboxStatus
  ): Promise<readonly NarrativeSyncOutboxEntry[]> {
    validateIdentifier(projectId, "projectId");
    if (status !== undefined && !["pending", "leased", "delivered"].includes(status)) {
      throw new TypeError("Estado de outbox desconocido.");
    }
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS, "readonly");
      const store = transaction.objectStore(OPERATIONS);
      const request = store.index("by-project").getAll(projectId);
      let entries: NarrativeSyncOutboxEntry[] | undefined;
      request.onsuccess = () => {
        entries = (request.result as NarrativeSyncOutboxEntry[])
          .filter(entry => status === undefined || entry.status === status)
          .sort((left, right) =>
            left.generation - right.generation
          );
        try { entries.forEach(validateStoredEntry); } catch (error) {
          reject(error);
          try { transaction.abort(); } catch { /* abortada */ }
        }
      };
      request.onerror = () => {
        try { transaction.abort(); } catch { /* abortada */ }
      };
      transaction.oncomplete = () => resolve(entries ?? []);
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudieron leer las entradas del outbox."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Se abortó la lectura del outbox."));
    });
  }

  /**
   * Reclama únicamente la siguiente generación. Una caída deja vencer el lease
   * y otra instancia puede reenviar la misma operationId sin saltar snapshots.
   */
  async claimPending(input: ClaimNarrativeSyncOutboxInput): Promise<readonly NarrativeSyncOutboxEntry[]> {
    validateIdentifier(input?.projectId, "projectId");
    validateIdentifier(input?.workerId, "workerId", MAX_WRITER_ID_UNITS);
    const now = input.now ?? Date.now();
    const leaseMs = input.leaseMs ?? 30_000;
    if (!Number.isFinite(now) || now < 0 ||
        !Number.isFinite(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) {
      throw new RangeError("Parámetros de reclamación del outbox fuera de rango.");
    }
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS, "readwrite");
      const store = transaction.objectStore(OPERATIONS);
      const request = store.index("by-project").getAll(input.projectId);
      let claimed: NarrativeSyncOutboxEntry[] = [];
      let failure: Error | undefined;
      request.onsuccess = () => {
        try {
          const entries = (request.result as NarrativeSyncOutboxEntry[])
            .map(entry => {
              validateStoredEntry(entry);
              return entry;
            })
            .sort((left, right) => left.generation - right.generation);
          for (let index = 1; index < entries.length; index++) {
            if (entries[index]!.generation !== entries[index - 1]!.generation + 1 ||
                entries[index]!.envelope.payload.expectedGeneration !== entries[index - 1]!.generation) {
              throw new Error("El outbox perdió la continuidad entre generaciones; se requiere reconciliación.");
            }
          }
          // Una generación depende de la anterior. Solo se reclama la primera
          // que aún no está entregada; nunca se adelanta mientras exista un
          // lease activo o un retry pendiente de una generación más antigua.
          const nextPending = entries.find(entry => entry.status !== "delivered");
          if (nextPending) {
            const ready = nextPending.status === "pending"
              ? nextPending.nextAttemptAt <= now
              : (nextPending.leaseExpiresAt ?? Number.POSITIVE_INFINITY) <= now;
            if (ready) {
              if (nextPending.attempts >= Number.MAX_SAFE_INTEGER ||
                  !Number.isFinite(now + leaseMs)) {
                throw new Error("La entrada del outbox agotó sus contadores o su ventana de lease.");
              }
              const next: NarrativeSyncOutboxEntry = {
                ...nextPending,
                status: "leased",
                attempts: nextPending.attempts + 1,
                lastAttemptAt: now,
                leaseOwner: input.workerId,
                leaseExpiresAt: now + leaseMs
              };
              store.put(next);
              claimed.push(next);
            }
          }
        } catch (error) {
          failure = error instanceof Error ? error : new Error("El outbox contiene una entrada inválida.");
          try { transaction.abort(); } catch { /* abortada */ }
        }
      };
      request.onerror = () => {
        failure = request.error ?? new Error("No se pudieron reclamar operaciones pendientes.");
        try { transaction.abort(); } catch { /* abortada */ }
      };
      transaction.oncomplete = () => resolve(claimed);
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("Falló la reclamación del outbox."));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Se abortó la reclamación del outbox."));
    });
  }

  async markDelivered(
    projectId: string,
    generation: number,
    workerId: string,
    expectedDigest: string,
    deliveredAt = Date.now()
  ): Promise<void> {
    validateIdentifier(projectId, "projectId");
    validateIdentifier(workerId, "workerId", MAX_WRITER_ID_UNITS);
    if (!Number.isSafeInteger(generation) || generation < 1 ||
        !/^sha256:[0-9a-f]{64}$/u.test(expectedDigest) ||
        !Number.isFinite(deliveredAt) || deliveredAt < 0) {
      throw new TypeError("Datos inválidos para confirmar la entrega del outbox.");
    }
    const database = await this.open();
    await this.updateEntry(database, projectId, generation, current => {
      if (current.envelope.digest !== expectedDigest) {
        throw new Error("El digest no coincide con la entrada del outbox.");
      }
      if (current.status === "delivered") return current;
      if (current.status !== "leased" || current.leaseOwner !== workerId) {
        throw new Error("El trabajador perdió el lease antes de confirmar la entrega.");
      }
      return {
        ...current,
        status: "delivered",
        deliveredAt,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: undefined
      };
    });
  }

  async releaseForRetry(
    projectId: string,
    generation: number,
    workerId: string,
    expectedDigest: string,
    input: { readonly now?: number; readonly retryAfterMs: number; readonly error?: string }
  ): Promise<void> {
    validateIdentifier(projectId, "projectId");
    validateIdentifier(workerId, "workerId", MAX_WRITER_ID_UNITS);
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(generation) || generation < 1 ||
        !/^sha256:[0-9a-f]{64}$/u.test(expectedDigest) ||
        !Number.isFinite(now) || now < 0 ||
        !Number.isFinite(input.retryAfterMs) || input.retryAfterMs < 0 ||
        input.retryAfterMs > 86_400_000) {
      throw new TypeError("Datos inválidos para devolver una operación al outbox.");
    }
    if (!Number.isFinite(now + input.retryAfterMs)) {
      throw new RangeError("La próxima fecha de reintento excede el rango numérico.");
    }
    const lastError = typeof input.error === "string"
      ? input.error.slice(0, MAX_ERROR_UNITS)
      : undefined;
    const database = await this.open();
    await this.updateEntry(database, projectId, generation, current => {
      if (current.envelope.digest !== expectedDigest) {
        throw new Error("El digest no coincide con la entrada del outbox.");
      }
      if (current.status !== "leased" || current.leaseOwner !== workerId) {
        throw new Error("El trabajador perdió el lease antes de devolver la operación al outbox.");
      }
      return {
        ...current,
        status: "pending",
        nextAttemptAt: now + input.retryAfterMs,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError
      };
    });
  }

  private async readEnqueueSnapshot(
    database: IDBDatabase,
    projectId: string,
    generation: number,
    writerId: string
  ): Promise<{
    readonly existing?: NarrativeSyncOutboxEntry;
    readonly cursor?: OutboxWriterCursor;
    readonly projectCursor?: OutboxProjectCursor;
  }> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([OPERATIONS, WRITER_CURSORS, PROJECT_CURSORS], "readonly");
      const operations = transaction.objectStore(OPERATIONS);
      const cursors = transaction.objectStore(WRITER_CURSORS);
      const projectCursors = transaction.objectStore(PROJECT_CURSORS);
      let existing: NarrativeSyncOutboxEntry | undefined;
      let cursor: OutboxWriterCursor | undefined;
      let projectCursor: OutboxProjectCursor | undefined;
      const operationRequest = operations.get([projectId, generation]);
      operationRequest.onsuccess = () => {
        existing = operationRequest.result as NarrativeSyncOutboxEntry | undefined;
      };
      operationRequest.onerror = () => {
        try { transaction.abort(); } catch { /* abortada */ }
      };
      const cursorRequest = cursors.get([projectId, writerId]);
      cursorRequest.onsuccess = () => {
        cursor = cursorRequest.result as OutboxWriterCursor | undefined;
      };
      cursorRequest.onerror = () => {
        try { transaction.abort(); } catch { /* abortada */ }
      };
      const projectCursorRequest = projectCursors.get(projectId);
      projectCursorRequest.onsuccess = () => {
        projectCursor = projectCursorRequest.result as OutboxProjectCursor | undefined;
      };
      projectCursorRequest.onerror = () => {
        try { transaction.abort(); } catch { /* abortada */ }
      };
      transaction.oncomplete = () => {
        try {
          validateOutboxProjectCursor(projectCursor, projectId);
          resolve({
            ...(existing ? { existing } : {}),
            ...(cursor ? { cursor } : {}),
            ...(projectCursor ? { projectCursor } : {})
          });
        } catch (error) {
          reject(error);
        }
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo leer el estado de secuencia del outbox."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Se abortó la lectura de secuencia del outbox."));
    });
  }

  private async commitEnqueueSnapshot(
    database: IDBDatabase,
    entry: NarrativeSyncOutboxEntry,
    expectedLastSequence: number,
    expectedLastGeneration: number
  ): Promise<{ readonly status: "queued" | "duplicate"; readonly entry: NarrativeSyncOutboxEntry } | { readonly status: "retry" }> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([OPERATIONS, WRITER_CURSORS, PROJECT_CURSORS], "readwrite");
      const operations = transaction.objectStore(OPERATIONS);
      const cursors = transaction.objectStore(WRITER_CURSORS);
      const projectCursors = transaction.objectStore(PROJECT_CURSORS);
      let currentEntry: NarrativeSyncOutboxEntry | undefined;
      let currentCursor: OutboxWriterCursor | undefined;
      let currentProjectCursor: OutboxProjectCursor | undefined;
      let operationsReady = false;
      let cursorReady = false;
      let projectCursorReady = false;
      let outcome:
        | { readonly status: "queued" | "duplicate"; readonly entry: NarrativeSyncOutboxEntry }
        | { readonly status: "retry" }
        | undefined;
      let failure: Error | undefined;
      const proceed = (): void => {
        if (!operationsReady || !cursorReady || !projectCursorReady || failure || outcome) return;
        if (currentEntry) {
          try { validateStoredEntry(currentEntry); } catch (error) {
            failure = error instanceof Error ? error : new Error("Entrada duplicada inválida en outbox.");
            try { transaction.abort(); } catch { /* abortada */ }
            return;
          }
          if (currentEntry.fingerprint !== entry.fingerprint ||
              currentEntry.envelope.payload.expectedGeneration !== entry.envelope.payload.expectedGeneration) {
            failure = new Error("Conflicto: la generación ya existe en el outbox con otro snapshot.");
            try { transaction.abort(); } catch { /* abortada */ }
            return;
          }
          outcome = { status: "duplicate", entry: currentEntry };
          return;
        }
        try {
          validateOutboxCursor(currentCursor, entry.projectId, entry.writerId);
          validateOutboxProjectCursor(currentProjectCursor, entry.projectId);
        } catch (error) {
          failure = error instanceof Error ? error : new Error("Cursor de outbox inválido.");
          try { transaction.abort(); } catch { /* abortada */ }
          return;
        }
        if ((currentProjectCursor?.lastGeneration ?? 0) !== expectedLastGeneration) {
          outcome = { status: "retry" };
          try { transaction.abort(); } catch { /* se vuelve a leer el cursor de proyecto */ }
          return;
        }
        if (currentProjectCursor &&
            (entry.generation !== currentProjectCursor.lastGeneration + 1 ||
             entry.envelope.payload.expectedGeneration !== currentProjectCursor.lastGeneration)) {
          failure = new Error("Conflicto de orden: una generación anterior del proyecto no está en el outbox.");
          try { transaction.abort(); } catch { /* abortada */ }
          return;
        }
        if ((currentCursor?.lastSequence ?? 0) !== expectedLastSequence ||
            entry.sequence !== expectedLastSequence + 1) {
          outcome = { status: "retry" };
          try { transaction.abort(); } catch { /* se vuelve a leer cursor y reintentar */ }
          return;
        }
        const nextProjectCursor: OutboxProjectCursor = {
          projectId: entry.projectId,
          lastGeneration: entry.generation,
          updatedAt: Date.now()
        };
        projectCursors.put(nextProjectCursor);
        const nextCursor: OutboxWriterCursor = {
          projectId: entry.projectId,
          writerId: entry.writerId,
          lastSequence: entry.sequence,
          lastOperationId: entry.operationId,
          updatedAt: Date.now()
        };
        operations.add(entry);
        cursors.put(nextCursor);
        outcome = { status: "queued", entry };
      };
      const operationRequest = operations.get([entry.projectId, entry.generation]);
      operationRequest.onsuccess = () => {
        currentEntry = operationRequest.result as NarrativeSyncOutboxEntry | undefined;
        operationsReady = true;
        proceed();
      };
      operationRequest.onerror = () => {
        failure = operationRequest.error ?? new Error("No se pudo comprobar una generación existente.");
        try { transaction.abort(); } catch { /* abortada */ }
      };
      const cursorRequest = cursors.get([entry.projectId, entry.writerId]);
      cursorRequest.onsuccess = () => {
        currentCursor = cursorRequest.result as OutboxWriterCursor | undefined;
        cursorReady = true;
        proceed();
      };
      cursorRequest.onerror = () => {
        failure = cursorRequest.error ?? new Error("No se pudo leer el cursor del escritor.");
        try { transaction.abort(); } catch { /* abortada */ }
      };
      const projectCursorRequest = projectCursors.get(entry.projectId);
      projectCursorRequest.onsuccess = () => {
        currentProjectCursor = projectCursorRequest.result as OutboxProjectCursor | undefined;
        projectCursorReady = true;
        proceed();
      };
      projectCursorRequest.onerror = () => {
        failure = projectCursorRequest.error ?? new Error("No se pudo leer el cursor de generación del proyecto.");
        try { transaction.abort(); } catch { /* abortada */ }
      };
      transaction.oncomplete = () => {
        if (!outcome) reject(new Error("La transacción del outbox terminó sin resultado."));
        else resolve(outcome);
      };
      transaction.onerror = () => {
        if (outcome?.status === "retry") resolve(outcome);
        else reject(failure ?? transaction.error ?? new Error("Falló la inserción durable del outbox."));
      };
      transaction.onabort = () => {
        if (outcome?.status === "retry") resolve(outcome);
        else reject(failure ?? transaction.error ?? new Error("Se abortó la inserción durable del outbox."));
      };
    });
  }

  private async updateEntry(
    database: IDBDatabase,
    projectId: string,
    generation: number,
    update: (current: NarrativeSyncOutboxEntry) => NarrativeSyncOutboxEntry
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS, "readwrite");
      const store = transaction.objectStore(OPERATIONS);
      const request = store.get([projectId, generation]);
      let failure: Error | undefined;
      request.onsuccess = () => {
        const current = request.result as NarrativeSyncOutboxEntry | undefined;
        if (!current) {
          failure = new Error("No existe la generación solicitada en el outbox.");
          try { transaction.abort(); } catch { /* abortada */ }
          return;
        }
        try {
          validateStoredEntry(current);
          const next = update(current);
          validateStoredEntry(next);
          store.put(next);
        } catch (error) {
          failure = error instanceof Error ? error : new Error("No se pudo actualizar el outbox.");
          try { transaction.abort(); } catch { /* abortada */ }
        }
      };
      request.onerror = () => {
        failure = request.error ?? new Error("No se pudo leer la entrada del outbox.");
        try { transaction.abort(); } catch { /* abortada */ }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("Falló la actualización del outbox."));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Se abortó la actualización del outbox."));
    });
  }

  private async open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(OPERATIONS)) {
          const operations = database.createObjectStore(OPERATIONS, {
            keyPath: ["projectId", "generation"]
          });
          operations.createIndex("by-project", "projectId", { unique: false });
          operations.createIndex("by-project-status", ["projectId", "status"], { unique: false });
          operations.createIndex(
            "by-project-writer-sequence",
            ["projectId", "writerId", "sequence"],
            { unique: true }
          );
        }
        if (!database.objectStoreNames.contains(WRITER_CURSORS)) {
          const cursors = database.createObjectStore(WRITER_CURSORS, {
            keyPath: ["projectId", "writerId"]
          });
          cursors.createIndex("by-project", "projectId", { unique: false });
        }
        if (!database.objectStoreNames.contains(PROJECT_CURSORS)) {
          database.createObjectStore(PROJECT_CURSORS, { keyPath: "projectId" });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          if (this.database) this.database = undefined;
        };
        resolve(database);
      };
      request.onerror = () => {
        this.database = undefined;
        reject(request.error ?? new Error("No se pudo abrir el outbox de sincronización."));
      };
      request.onblocked = () => {
        this.database = undefined;
        reject(new Error("La apertura del outbox está bloqueada por otra conexión."));
      };
    });
    return this.database;
  }
}

/**
 * Conecta directamente el callback de HostEngineApi con un outbox durable.
 * Configura este callback usando el ID estable de instalación/escritor.
 */
export function createNarrativeIdeaContinuityOutboxCallback(
  outbox: IndexedDbNarrativeSyncOutbox,
  writerId: string
): (notice: {
  readonly projectId: string;
  readonly index: NarrativeIdeaContinuityIndex;
  readonly expectedGeneration?: number;
}) => Promise<void> {
  if (!(outbox instanceof IndexedDbNarrativeSyncOutbox)) {
    throw new TypeError("Se requiere una instancia válida de IndexedDbNarrativeSyncOutbox.");
  }
  validateIdentifier(writerId, "writerId", MAX_WRITER_ID_UNITS);
  return async notice => {
    await outbox.enqueueContinuityIndex({
      index: notice.index,
      writerId,
      ...(notice.expectedGeneration !== undefined
        ? { expectedGeneration: notice.expectedGeneration }
        : {}),
      createdAt: notice.index.updatedAt
    });
  };
}

/**
 * Envía una tanda con entrega al menos una vez. Un crash entre send y ack puede
 * repetir la operación después de vencer el lease; el receptor deduplica por
 * operationId/digest usando el diario de entrada.
 */
export async function deliverNarrativeSyncOutboxBatch(
  outbox: IndexedDbNarrativeSyncOutbox,
  input: DeliverNarrativeSyncOutboxInput
): Promise<DeliverNarrativeSyncOutboxResult> {
  if (!(outbox instanceof IndexedDbNarrativeSyncOutbox) ||
      !input || typeof input.send !== "function") {
    throw new TypeError("Se necesita outbox y función de transporte válidos.");
  }
  const baseRetryDelayMs = input.baseRetryDelayMs ?? 1_000;
  const maxRetryDelayMs = input.maxRetryDelayMs ?? 3_600_000;
  if (!Number.isFinite(baseRetryDelayMs) || baseRetryDelayMs < 1 ||
      !Number.isFinite(maxRetryDelayMs) || maxRetryDelayMs < baseRetryDelayMs ||
      maxRetryDelayMs > 86_400_000) {
    throw new RangeError("La política de reintentos del outbox está fuera de rango.");
  }
  const claimed = await outbox.claimPending(input);
  let delivered = 0;
  const failedGenerations: number[] = [];
  for (const entry of claimed) {
    try {
      if (!(await outbox.verifyEnvelope(entry.envelope))) {
        throw new Error("La envoltura durable no supera la verificación SHA-256.");
      }
      await input.send(entry.envelope);
      await outbox.markDelivered(
        entry.projectId,
        entry.generation,
        input.workerId,
        entry.envelope.digest,
        input.now ?? Date.now()
      );
      delivered++;
    } catch (error) {
      const delay = Math.min(
        maxRetryDelayMs,
        baseRetryDelayMs * Math.pow(2, Math.min(20, Math.max(0, entry.attempts - 1)))
      );
      try {
        await outbox.releaseForRetry(
          entry.projectId,
          entry.generation,
          input.workerId,
          entry.envelope.digest,
          {
            now: input.now ?? Date.now(),
            retryAfterMs: delay,
            error: error instanceof Error ? error.message : "Fallo de transporte desconocido."
          }
        );
      } catch {
        // El lease expirará; otra ejecución podrá recuperar la operación.
      }
      failedGenerations.push(entry.generation);
    }
  }
  return {
    claimed: claimed.length,
    delivered,
    deferred: claimed.length - delivered,
    failedGenerations
  };
}
