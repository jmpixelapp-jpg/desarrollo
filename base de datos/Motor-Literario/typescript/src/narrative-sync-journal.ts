import {
  verifyNarrativeSyncOperationEnvelope,
  type NarrativeSyncOperationEnvelope
} from "./narrative-sync-integrity";

export interface NarrativeSyncJournalOptions {
  readonly databaseName?: string;
}

export type NarrativeSyncAcceptResult =
  | { readonly status: "accepted"; readonly nextSequence: number }
  | { readonly status: "duplicate"; readonly nextSequence: number };

export interface NarrativeSyncJournalEntry extends NarrativeSyncOperationEnvelope {
  readonly receivedAt: number;
  readonly appliedAt?: number;
}
type StoredOperation = NarrativeSyncJournalEntry;

interface WriterCursor {
  readonly projectId: string;
  readonly writerId: string;
  readonly lastSequence: number;
  readonly lastOperationId: string;
  readonly updatedAt: number;
}

/**
 * Diario durable de recepción. La inserción de operación y avance de cursor
 * se confirman en una única transacción IndexedDB.
 *
 * Este componente registra y ordena operaciones; NO las aplica al grafo.
 */
export class IndexedDbNarrativeSyncJournal {
  private database: Promise<IDBDatabase> | undefined;
  private readonly databaseName: string;

  constructor(options: NarrativeSyncJournalOptions = {}) {
    this.databaseName = options.databaseName ?? "motor-literario-sync-journal";
    if (!this.databaseName.trim()) throw new TypeError("El nombre de la base de sincronización es obligatorio.");
  }

  close(): void {
    const current = this.database;
    this.database = undefined;
    void current?.then(database => database.close()).catch(() => undefined);
  }

  async accept(
    envelope: NarrativeSyncOperationEnvelope
  ): Promise<NarrativeSyncAcceptResult> {
    if (!(await verifyNarrativeSyncOperationEnvelope(envelope))) {
      throw new Error("La operación narrativa no supera la verificación SHA-256.");
    }
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(["operations", "writer-cursors"], "readwrite");
      const operations = transaction.objectStore("operations");
      const cursors = transaction.objectStore("writer-cursors");
      let result: NarrativeSyncAcceptResult | undefined;
      let failure: Error | undefined;
      let operationReady = false;
      let cursorReady = false;
      let existingOperation: StoredOperation | undefined;
      let cursor: WriterCursor | undefined;

      const fail = (message: string): void => {
        if (failure) return;
        failure = new Error(message);
        try { transaction.abort(); } catch { /* abortado */ }
      };
      const proceed = (): void => {
        if (!operationReady || !cursorReady || failure) return;
        if (existingOperation) {
          if (existingOperation.digest !== envelope.digest) {
            fail("Conflicto: operationId ya existe con otro contenido.");
            return;
          }
          result = { status: "duplicate", nextSequence: (cursor?.lastSequence ?? 0) + 1 };
          return;
        }
        const expected = (cursor?.lastSequence ?? 0) + 1;
        if (envelope.sequence !== expected) {
          fail(envelope.sequence < expected
            ? "Replay o secuencia antigua: la operación ya quedó superada."
            : "Hueco de secuencia: falta una operación anterior del escritor.");
          return;
        }
        const stored: StoredOperation = { ...envelope, receivedAt: Date.now() };
        const nextCursor: WriterCursor = {
          projectId: envelope.projectId,
          writerId: envelope.writerId,
          lastSequence: envelope.sequence,
          lastOperationId: envelope.operationId,
          updatedAt: Date.now()
        };
        operations.add(stored);
        cursors.put(nextCursor);
        result = { status: "accepted", nextSequence: envelope.sequence + 1 };
      };

      const operationRequest = operations.get([envelope.projectId, envelope.operationId]);
      operationRequest.onsuccess = () => {
        existingOperation = operationRequest.result as StoredOperation | undefined;
        operationReady = true;
        proceed();
      };
      operationRequest.onerror = () => fail("No se pudo consultar el diario de operaciones.");

      const cursorRequest = cursors.get([envelope.projectId, envelope.writerId]);
      cursorRequest.onsuccess = () => {
        cursor = cursorRequest.result as WriterCursor | undefined;
        cursorReady = true;
        proceed();
      };
      cursorRequest.onerror = () => fail("No se pudo consultar la secuencia del escritor.");

      transaction.oncomplete = () => {
        if (failure) reject(failure);
        else if (!result) reject(new Error("La transacción terminó sin resultado de recepción."));
        else resolve(result);
      };
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("Falló el diario de sincronización."));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Se abortó el diario de sincronización."));
    });
  }

  /** Recupera operaciones recibidas para que un consumidor pueda procesarlas tras reiniciar. */
  async loadOperations(
    projectId: string,
    writerId?: string
  ): Promise<readonly NarrativeSyncJournalEntry[]> {
    if (!projectId.trim() || (writerId !== undefined && !writerId.trim())) {
      throw new TypeError("Proyecto y escritor deben ser identificadores no vacíos.");
    }
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("operations", "readonly");
      const request = transaction.objectStore("operations").index("by-project").getAll(projectId);
      let entries: NarrativeSyncJournalEntry[] = [];
      let ready = false;
      request.onsuccess = () => {
        entries = (request.result as StoredOperation[])
          .filter(entry => writerId === undefined || entry.writerId === writerId)
          .sort((left, right) =>
            left.writerId.localeCompare(right.writerId) || left.sequence - right.sequence
          );
        ready = true;
      };
      request.onerror = () => {
        try { transaction.abort(); } catch { /* abortado */ }
      };
      transaction.oncomplete = () => ready
        ? resolve(entries)
        : reject(new Error("No se pudieron recuperar las operaciones recibidas."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Falló la lectura del diario."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Se abortó la lectura del diario."));
    });
  }

  /** Recupera solo operaciones aún no marcadas como aplicadas. */
  async loadPendingOperations(
    projectId: string,
    writerId?: string
  ): Promise<readonly NarrativeSyncJournalEntry[]> {
    const entries = await this.loadOperations(projectId, writerId);
    return entries.filter(entry => entry.appliedAt === undefined);
  }

  /**
   * Marca una operación como aplicada después de que el consumidor termine.
   * El digest evita que un consumidor confirme una identidad con otro contenido.
   */
  async markApplied(
    projectId: string,
    operationId: string,
    expectedDigest: string,
    appliedAt = Date.now()
  ): Promise<void> {
    if (!projectId.trim() || !operationId.trim() ||
        !/^sha256:[a-f0-9]{64}$/u.test(expectedDigest) ||
        !Number.isFinite(appliedAt) || appliedAt < 0) {
      throw new TypeError("Datos inválidos para confirmar la aplicación de la operación.");
    }
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("operations", "readwrite");
      const store = transaction.objectStore("operations");
      const request = store.get([projectId, operationId]);
      let failure: Error | undefined;
      request.onsuccess = () => {
        const current = request.result as StoredOperation | undefined;
        if (!current) {
          failure = new Error("No existe la operación que se intenta marcar como aplicada.");
          try { transaction.abort(); } catch { /* abortado */ }
          return;
        }
        if (current.digest !== expectedDigest) {
          failure = new Error("El digest no coincide con la operación recibida.");
          try { transaction.abort(); } catch { /* abortado */ }
          return;
        }
        if (current.appliedAt === undefined) {
          store.put({ ...current, appliedAt });
        }
      };
      request.onerror = () => {
        failure = new Error("No se pudo leer la operación para confirmar su aplicación.");
        try { transaction.abort(); } catch { /* abortado */ }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("Falló la confirmación de aplicación."));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Se abortó la confirmación de aplicación."));
    });
  }

  /** Recupera una operación por su identidad durable dentro del proyecto. */
  async loadOperation(
    projectId: string,
    operationId: string
  ): Promise<NarrativeSyncJournalEntry | undefined> {
    if (!projectId.trim() || !operationId.trim()) {
      throw new TypeError("Proyecto y operationId deben ser identificadores no vacíos.");
    }
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("operations", "readonly");
      const request = transaction.objectStore("operations").get([projectId, operationId]);
      let entry: StoredOperation | undefined;
      let ready = false;
      request.onsuccess = () => {
        entry = request.result as StoredOperation | undefined;
        ready = true;
      };
      request.onerror = () => {
        try { transaction.abort(); } catch { /* abortado */ }
      };
      transaction.oncomplete = () => ready
        ? resolve(entry)
        : reject(new Error("No se pudo recuperar la operación solicitada."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Falló la lectura de la operación."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Se abortó la lectura de la operación."));
    });
  }

  async getLastSequence(projectId: string, writerId: string): Promise<number> {
    if (!projectId.trim() || !writerId.trim()) throw new TypeError("Proyecto y escritor son obligatorios.");
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("writer-cursors", "readonly");
      const request = transaction.objectStore("writer-cursors").get([projectId, writerId]);
      let sequence = 0;
      let ready = false;
      request.onsuccess = () => {
        sequence = (request.result as WriterCursor | undefined)?.lastSequence ?? 0;
        ready = true;
      };
      request.onerror = () => {
        try { transaction.abort(); } catch { /* abortado */ }
      };
      transaction.oncomplete = () => ready
        ? resolve(sequence)
        : reject(new Error("No se pudo leer la secuencia persistida."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Falló la lectura del cursor."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Se abortó la lectura del cursor."));
    });
  }

  private open(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new Error("IndexedDB no está disponible en este entorno."));
    }
    if (this.database) return this.database;
    let opening!: Promise<IDBDatabase>;
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("operations")) {
          const store = database.createObjectStore("operations", {
            keyPath: ["projectId", "operationId"]
          });
          store.createIndex("by-project", "projectId", { unique: false });
          store.createIndex("by-writer-sequence", ["projectId", "writerId", "sequence"], { unique: true });
        }
        if (!database.objectStoreNames.contains("writer-cursors")) {
          const store = database.createObjectStore("writer-cursors", {
            keyPath: ["projectId", "writerId"]
          });
          store.createIndex("by-project", "projectId", { unique: false });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error("No se pudo abrir el diario de sincronización."));
      request.onblocked = () => reject(new Error("La apertura del diario está bloqueada por otra conexión."));
    });
    this.database = opening;
    void opening.catch(() => {
      if (this.database === opening) this.database = undefined;
    });
    return opening;
  }
}


export interface NarrativeSyncReplayResult {
  readonly processed: number;
  readonly remaining: number;
  readonly stoppedAtOperationId?: string;
  readonly failure?: "invalid-envelope" | "apply-or-ack-failed";
}

/**
 * Reproduce operaciones pendientes en orden y confirma cada una tras el callback.
 * Si el callback falla, la operación permanece pendiente y el replay se detiene.
 * El callback debe ser idempotente: un fallo del proceso entre la mutación externa
 * y markApplied puede provocar que la misma operación se entregue otra vez.
 */
export async function replayPendingNarrativeSyncOperations(
  journal: IndexedDbNarrativeSyncJournal,
  projectId: string,
  apply: (operation: NarrativeSyncOperationEnvelope) => Promise<void>,
  writerId?: string
): Promise<NarrativeSyncReplayResult> {
  if (!journal || typeof apply !== "function") {
    throw new TypeError("Se requiere un diario y un procesador de operaciones.");
  }
  const pending = await journal.loadPendingOperations(projectId, writerId);
  let processed = 0;
  for (const operation of pending) {
    // El registro añade receivedAt/appliedAt, que son metadatos locales y no
    // forman parte del digest original de la envoltura recibida.
    const envelope: NarrativeSyncOperationEnvelope = {
      schemaVersion: operation.schemaVersion,
      algorithm: operation.algorithm,
      operationId: operation.operationId,
      projectId: operation.projectId,
      writerId: operation.writerId,
      sequence: operation.sequence,
      createdAt: operation.createdAt,
      kind: operation.kind,
      // IndexedDB entrega un structured clone; normalizamos el payload al
      // subconjunto JSON antes de verificar su representación canónica.
      payload: JSON.parse(JSON.stringify(operation.payload)) as unknown,
      digest: operation.digest
    };
    if (!(await verifyNarrativeSyncOperationEnvelope(envelope))) {
      const remaining = (await journal.loadPendingOperations(projectId, writerId)).length;
      return {
        processed, remaining, stoppedAtOperationId: operation.operationId,
        failure: "invalid-envelope"
      };
    }
    try {
      await apply(operation);
      await journal.markApplied(projectId, operation.operationId, operation.digest);
      processed++;
    } catch {
      const remaining = (await journal.loadPendingOperations(projectId, writerId)).length;
      return {
        processed, remaining, stoppedAtOperationId: operation.operationId,
        failure: "apply-or-ack-failed"
      };
    }
  }
  return { processed, remaining: (await journal.loadPendingOperations(projectId, writerId)).length };
}
