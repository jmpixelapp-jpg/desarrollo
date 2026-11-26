import {
  areNarrativeSyncPayloadsEquivalent,
  canonicalizeNarrativeSyncPayload,
  verifyNarrativeSyncOperationEnvelope,
  type NarrativeSyncCanonicalizationLimits,
  type NarrativeSyncOperationEnvelope
} from "./narrative-sync-integrity";

export interface NarrativeSyncJournalOptions {
  readonly databaseName?: string;
  /** Límites canónicos de las envolturas recibidas, aplicadas y auditadas. */
  readonly canonicalizationLimits?: NarrativeSyncCanonicalizationLimits;
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

/** Cursor durable de recepción, expuesto como snapshot de solo lectura. */
export interface NarrativeSyncWriterCursor {
  readonly projectId: string;
  readonly writerId: string;
  readonly lastSequence: number;
  readonly lastOperationId: string;
  readonly updatedAt: number;
}

export type NarrativeSyncCursorRecoveryApplyResult =
  | { readonly status: "applied"; readonly writerId: string; readonly lastSequence: number; readonly lastOperationId: string }
  | { readonly status: "already-consistent"; readonly writerId: string; readonly lastSequence: number; readonly lastOperationId: string }
  | { readonly status: "rejected"; readonly reason: "invalid-proposal" | "journal-not-complete" | "journal-changed" | "cursor-changed" | "transaction-failed" };

/**
 * Aplicación atómica de una propuesta. La verificación criptográfica se hace
 * antes de abrir la transacción y el snapshot se compara de nuevo dentro de
 * ella; así no se mantiene una transacción IndexedDB abierta durante WebCrypto.
 */
/**
 * Diario durable de recepción. La inserción de operación y avance de cursor
 * se confirman en una única transacción IndexedDB.
 *
 * Este componente registra y ordena operaciones; NO las aplica al grafo.
 */
export class IndexedDbNarrativeSyncJournal {
  private database: Promise<IDBDatabase> | undefined;
  private readonly databaseName: string;
  private readonly canonicalizationLimits: NarrativeSyncCanonicalizationLimits;

  constructor(options: NarrativeSyncJournalOptions = {}) {
    this.databaseName = options.databaseName ?? "motor-literario-sync-journal";
    if (!this.databaseName.trim()) throw new TypeError("El nombre de la base de sincronización es obligatorio.");
    this.canonicalizationLimits = Object.freeze({ ...(options.canonicalizationLimits ?? {}) });
    // Valida los límites al construir el diario, no durante la primera recepción.
    canonicalizeNarrativeSyncPayload(null, this.canonicalizationLimits);
  }

  /** Verifica una envoltura usando la política de tamaño configurada para este diario. */
  verifyEnvelope(envelope: NarrativeSyncOperationEnvelope): Promise<boolean> {
    return verifyNarrativeSyncOperationEnvelope(envelope, this.canonicalizationLimits);
  }

  close(): void {
    const current = this.database;
    this.database = undefined;
    void current?.then(database => database.close()).catch(() => undefined);
  }

  async accept(
    envelope: NarrativeSyncOperationEnvelope
  ): Promise<NarrativeSyncAcceptResult> {
    if (!(await this.verifyEnvelope(envelope))) {
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
        // El cursor es parte del contrato durable, no un contador confiable por
        // defecto. Si está corrupto, aceptar una operación podría ocultar la
        // divergencia y volver imposible reconstruir el historial con seguridad.
        if (cursor !== undefined && (
          !cursor || typeof cursor !== "object" ||
          cursor.projectId !== envelope.projectId ||
          cursor.writerId !== envelope.writerId ||
          !Number.isSafeInteger(cursor.lastSequence) || cursor.lastSequence < 1 ||
          typeof cursor.lastOperationId !== "string" || !cursor.lastOperationId.trim() ||
          !Number.isFinite(cursor.updatedAt) || cursor.updatedAt < 0
        )) {
          fail("El cursor durable del escritor está malformado; se requiere auditoría y recuperación antes de aceptar operaciones.");
          return;
        }
        if (cursor && cursor.lastSequence >= Number.MAX_SAFE_INTEGER) {
          fail("El escritor alcanzó el límite de secuencia segura; no se puede aceptar otra operación.");
          return;
        }
        if (existingOperation) {
          const {
            receivedAt,
            appliedAt,
            ...storedEnvelope
          } = existingOperation;
          let sameEnvelope = false;
          try {
            sameEnvelope = areNarrativeSyncPayloadsEquivalent(storedEnvelope, envelope);
          } catch {
            sameEnvelope = false;
          }
          const validStoredMetadata =
            Number.isFinite(receivedAt) && receivedAt >= 0 &&
            (appliedAt === undefined ||
              (Number.isFinite(appliedAt) && appliedAt >= receivedAt));
          if (existingOperation.digest !== envelope.digest ||
              !sameEnvelope || !validStoredMetadata) {
            fail("Conflicto: operationId ya existe con contenido o metadatos inconsistentes.");
            return;
          }
          if (!cursor || cursor.lastSequence < existingOperation.sequence ||
              (cursor.lastSequence === existingOperation.sequence &&
                cursor.lastOperationId !== existingOperation.operationId)) {
            fail("Conflicto: la operación existe, pero el cursor durable no confirma su secuencia.");
            return;
          }
          result = { status: "duplicate", nextSequence: cursor.lastSequence + 1 };
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

  /** Recupera todos los cursores del proyecto para reconciliar diario e índices. */
  async loadWriterCursors(projectId: string): Promise<readonly NarrativeSyncWriterCursor[]> {
    if (!projectId.trim()) throw new TypeError("El proyecto es obligatorio.");
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("writer-cursors", "readonly");
      const request = transaction.objectStore("writer-cursors").index("by-project").getAll(projectId);
      let cursors: NarrativeSyncWriterCursor[] = [];
      let ready = false;
      request.onsuccess = () => {
        cursors = (request.result as WriterCursor[]).sort((left, right) => left.writerId.localeCompare(right.writerId));
        ready = true;
      };
      request.onerror = () => {
        try { transaction.abort(); } catch { /* abortado */ }
      };
      transaction.oncomplete = () => ready
        ? resolve(cursors)
        : reject(new Error("No se pudieron recuperar los cursores del proyecto."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Falló la lectura de cursores."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Se abortó la lectura de cursores."));
    });
  }

  /**
   * Reconstruye un cursor únicamente desde un diario completo y verificado.
   * Relee operaciones y cursor en una transacción readwrite y aborta si el
   * diario cambió desde la verificación o si otro proceso alteró el cursor.
   */
  async applyCursorRecoveryProposal(
    proposal: NarrativeSyncCursorRecoveryProposal
  ): Promise<NarrativeSyncCursorRecoveryApplyResult> {
    if (!proposal || typeof proposal.projectId !== "string" || !proposal.projectId.trim() ||
        typeof proposal.writerId !== "string" || !proposal.writerId.trim() ||
        !Number.isSafeInteger(proposal.lastSequence) || proposal.lastSequence < 1 ||
        typeof proposal.lastOperationId !== "string" || !proposal.lastOperationId.trim()) {
      return { status: "rejected", reason: "invalid-proposal" };
    }

    let snapshot: NarrativeSyncJournalEntry[];
    try {
      snapshot = (await this.loadOperations(proposal.projectId, proposal.writerId))
        .slice().sort((a, b) => a.sequence - b.sequence);
      if (snapshot.length !== proposal.lastSequence ||
          snapshot.some((entry, index) =>
            entry.projectId !== proposal.projectId ||
            entry.writerId !== proposal.writerId ||
            entry.sequence !== index + 1 ||
            !Number.isFinite(entry.receivedAt) || entry.receivedAt < 0 ||
            (entry.appliedAt !== undefined &&
              (!Number.isFinite(entry.appliedAt) || entry.appliedAt < entry.receivedAt)))) {
        return { status: "rejected", reason: "journal-not-complete" };
      }
      for (const entry of snapshot) {
        const { receivedAt: _receivedAt, appliedAt: _appliedAt, ...envelope } = entry;
        if (!(await this.verifyEnvelope(envelope))) {
          return { status: "rejected", reason: "journal-not-complete" };
        }
      }
      const last = snapshot[snapshot.length - 1];
      if (!last || last.sequence !== proposal.lastSequence ||
          last.operationId !== proposal.lastOperationId) {
        return { status: "rejected", reason: "journal-changed" };
      }
    } catch {
      return { status: "rejected", reason: "transaction-failed" };
    }

    let database: IDBDatabase;
    try {
      database = await this.open();
    } catch {
      return { status: "rejected", reason: "transaction-failed" };
    }
    return new Promise(resolve => {
      let settled = false;
      const finish = (result: NarrativeSyncCursorRecoveryApplyResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(["operations", "writer-cursors"], "readwrite");
      } catch {
        finish({ status: "rejected", reason: "transaction-failed" });
        return;
      }
      const operationsStore = transaction.objectStore("operations");
      const cursorsStore = transaction.objectStore("writer-cursors");
      const operationsRequest = operationsStore.index("by-project").getAll(proposal.projectId);
      const cursorRequest = cursorsStore.get([proposal.projectId, proposal.writerId]);
      let currentOperations: StoredOperation[] | undefined;
      let currentCursor: WriterCursor | undefined;
      let operationsReady = false;
      let cursorReady = false;
      let outcome: NarrativeSyncCursorRecoveryApplyResult | undefined;
      const abortWith = (reason: "journal-changed" | "cursor-changed"): void => {
        outcome = { status: "rejected", reason };
        try { transaction.abort(); } catch { /* la transacción ya terminó */ }
      };
      const evaluate = (): void => {
        if (!operationsReady || !cursorReady || outcome) return;
        const currentWriterOperations = (currentOperations ?? [])
          .filter(entry => entry.writerId === proposal.writerId)
          .sort((a, b) => a.sequence - b.sequence);
        const sameSnapshot = currentWriterOperations.length === snapshot.length &&
          currentWriterOperations.every((entry, index) => {
            const expected = snapshot[index];
            return areNarrativeSyncPayloadsEquivalent(entry, expected);
          });
        if (!sameSnapshot) {
          abortWith("journal-changed");
          return;
        }
        const last = snapshot[snapshot.length - 1];
        if (!last) {
          abortWith("journal-changed");
          return;
        }
        if (currentCursor &&
            (currentCursor.projectId !== proposal.projectId ||
             currentCursor.writerId !== proposal.writerId ||
             !Number.isSafeInteger(currentCursor.lastSequence) ||
             currentCursor.lastSequence < 1 ||
             !Number.isFinite(currentCursor.updatedAt) || currentCursor.updatedAt < 0 ||
             typeof currentCursor.lastOperationId !== "string" ||
             !currentCursor.lastOperationId)) {
          abortWith("cursor-changed");
          return;
        }
        if (currentCursor?.lastSequence === proposal.lastSequence &&
            currentCursor.lastOperationId === proposal.lastOperationId) {
          outcome = {
            status: "already-consistent",
            writerId: proposal.writerId,
            lastSequence: proposal.lastSequence,
            lastOperationId: proposal.lastOperationId
          };
          return;
        }
        if (currentCursor && currentCursor.lastSequence !== proposal.lastSequence) {
          abortWith("cursor-changed");
          return;
        }
        const nextCursor: WriterCursor = {
          projectId: proposal.projectId,
          writerId: proposal.writerId,
          lastSequence: last.sequence,
          lastOperationId: last.operationId,
          updatedAt: Math.max(Date.now(), currentCursor?.updatedAt ?? 0, last.receivedAt)
        };
        cursorsStore.put(nextCursor);
        outcome = {
          status: "applied",
          writerId: proposal.writerId,
          lastSequence: last.sequence,
          lastOperationId: last.operationId
        };
      };
      operationsRequest.onsuccess = () => {
        currentOperations = operationsRequest.result as StoredOperation[];
        operationsReady = true;
        evaluate();
      };
      cursorRequest.onsuccess = () => {
        currentCursor = cursorRequest.result as WriterCursor | undefined;
        cursorReady = true;
        evaluate();
      };
      operationsRequest.onerror = () => abortWith("journal-changed");
      cursorRequest.onerror = () => abortWith("cursor-changed");
      transaction.oncomplete = () => finish(outcome ?? {
        status: "rejected", reason: "transaction-failed"
      });
      transaction.onabort = () => finish(outcome ?? {
        status: "rejected", reason: "transaction-failed"
      });
      transaction.onerror = () => finish(outcome ?? {
        status: "rejected", reason: "transaction-failed"
      });
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


export type NarrativeSyncJournalIntegrityIssueCode =
  | "invalid-envelope"
  | "invalid-received-at"
  | "invalid-applied-at"
  | "duplicate-operation"
  | "duplicate-writer-sequence"
  | "sequence-gap"
  | "cursor-without-operations"
  | "cursor-ahead-of-journal"
  | "cursor-behind-journal"
  | "cursor-last-operation-mismatch"
  | "cursor-missing-for-operations"
  | "invalid-cursor";

export interface NarrativeSyncJournalIntegrityIssue {
  readonly code: NarrativeSyncJournalIntegrityIssueCode;
  readonly operationId: string;
  readonly writerId: string;
  readonly detail: string;
}

export interface NarrativeSyncJournalIntegrityReport {
  readonly projectId: string;
  readonly checkedOperations: number;
  readonly checkedWriters: number;
  readonly issues: readonly NarrativeSyncJournalIntegrityIssue[];
  readonly intact: boolean;
}

/**
 * Audita la integridad del diario sin cambiar cursores ni estados de aplicación.
 * Comprueba la envoltura SHA-256, metadatos locales y continuidad de secuencia
 * por escritor. SHA-256 detecta corrupción, pero no autentica al emisor.
 */
export async function inspectNarrativeSyncJournalIntegrity(
  journal: Pick<IndexedDbNarrativeSyncJournal, "loadOperations" | "loadWriterCursors"> & {
    readonly verifyEnvelope?: (envelope: NarrativeSyncOperationEnvelope) => Promise<boolean>;
  },
  projectId: string
): Promise<NarrativeSyncJournalIntegrityReport> {
  if (!journal || typeof journal.loadOperations !== "function" ||
      typeof journal.loadWriterCursors !== "function" ||
      typeof projectId !== "string" || !projectId.trim()) {
    throw new TypeError("Se requiere un diario y un proyecto válidos para auditar sincronización.");
  }
  const operations = await journal.loadOperations(projectId);
  const issues: NarrativeSyncJournalIntegrityIssue[] = [];
  const seenIds = new Set<string>();
  const writers = new Map<string, NarrativeSyncJournalEntry[]>();
  for (const operation of operations) {
    const operationId = typeof operation.operationId === "string" ? operation.operationId : "";
    const writerId = typeof operation.writerId === "string" ? operation.writerId : "";
    const addIssue = (code: NarrativeSyncJournalIntegrityIssueCode, detail: string): void => {
      issues.push({ code, operationId, writerId, detail });
    };
    if (!operationId || seenIds.has(operationId)) {
      addIssue("duplicate-operation", "La identidad de operación está vacía o aparece más de una vez.");
    }
    seenIds.add(operationId);
    if (!Number.isFinite(operation.receivedAt) || operation.receivedAt < 0) {
      addIssue("invalid-received-at", "El instante de recepción local no es válido.");
    }
    if (operation.appliedAt !== undefined &&
        (!Number.isFinite(operation.appliedAt) || operation.appliedAt < operation.receivedAt)) {
      addIssue("invalid-applied-at", "El instante de aplicación es inválido o anterior a la recepción.");
    }
    const { receivedAt: _receivedAt, appliedAt: _appliedAt, ...envelope } = operation;
    if (!(await (journal.verifyEnvelope
      ? journal.verifyEnvelope(envelope)
      : verifyNarrativeSyncOperationEnvelope(envelope)))) {
      addIssue("invalid-envelope", "La envoltura almacenada no supera la verificación de integridad.");
    }
    const writerOperations = writers.get(writerId) ?? [];
    writerOperations.push(operation);
    writers.set(writerId, writerOperations);
  }
  for (const [writerId, entries] of writers) {
    entries.sort((left, right) => left.sequence - right.sequence);
    let expected = 1;
    for (const entry of entries) {
      if (entry.sequence < expected) {
        issues.push({
          code: "duplicate-writer-sequence",
          operationId: entry.operationId,
          writerId,
          detail: "El escritor repite una secuencia."
        });
      } else if (entry.sequence > expected) {
        issues.push({
          code: "sequence-gap",
          operationId: entry.operationId,
          writerId,
          detail: "Falta la secuencia " + expected + " antes de esta operación."
        });
      }
      expected = Math.max(expected, entry.sequence + 1);
    }
  }
  const cursors = await journal.loadWriterCursors(projectId);
  const cursorWriters = new Set(cursors.map(cursor =>
    typeof cursor.writerId === "string" ? cursor.writerId : ""
  ));
  for (const writerId of writers.keys()) {
    if (!cursorWriters.has(writerId)) {
      issues.push({
        code: "cursor-missing-for-operations",
        operationId: writers.get(writerId)?.[0]?.operationId ?? "",
        writerId,
        detail: "Hay operaciones persistidas, pero falta el cursor durable del escritor."
      });
    }
  }
  for (const cursor of cursors) {
    const writerId = typeof cursor.writerId === "string" ? cursor.writerId : "";
    const lastOperationId = typeof cursor.lastOperationId === "string" ? cursor.lastOperationId : "";
    const entries = writers.get(writerId) ?? [];
    const last = entries.reduce<NarrativeSyncJournalEntry | undefined>(
      (current, entry) => !current || entry.sequence > current.sequence ? entry : current,
      undefined
    );
    const addCursorIssue = (code: NarrativeSyncJournalIntegrityIssueCode, detail: string): void => {
      issues.push({ code, operationId: lastOperationId, writerId, detail });
    };
    if (!Number.isSafeInteger(cursor.lastSequence) || cursor.lastSequence < 1 ||
        !Number.isFinite(cursor.updatedAt) || cursor.updatedAt < 0 ||
        typeof cursor.lastOperationId !== "string" || !cursor.lastOperationId.trim() ||
        cursor.projectId !== projectId || typeof cursor.writerId !== "string" || !cursor.writerId.trim()) {
      addCursorIssue("invalid-cursor", "El cursor contiene identidad, secuencia o marca temporal inválida.");
    }
    if (!last) {
      addCursorIssue("cursor-without-operations", "Existe un cursor durable, pero no hay operaciones en el diario.");
    } else {
      if (cursor.lastSequence > last.sequence) {
        addCursorIssue("cursor-ahead-of-journal", "El cursor avanza más allá de la última operación persistida.");
      } else if (cursor.lastSequence < last.sequence) {
        addCursorIssue("cursor-behind-journal", "El diario contiene una operación posterior al cursor durable.");
      }
      if (cursor.lastSequence === last.sequence && lastOperationId !== last.operationId) {
        addCursorIssue("cursor-last-operation-mismatch", "El cursor no identifica la última operación de su secuencia.");
      }
    }
  }
  return {
    projectId,
    checkedOperations: operations.length,
    checkedWriters: writers.size,
    issues,
    intact: issues.length === 0
  };
}

export type NarrativeSyncCursorRecoveryAction =
  | "no-action"
  | "rebuild-cursor-from-complete-journal"
  | "manual-review";

export interface NarrativeSyncCursorRecoveryProposal {
  readonly projectId: string;
  readonly writerId: string;
  readonly lastSequence: number;
  readonly lastOperationId: string;
}

export interface NarrativeSyncCursorRecoveryItem {
  readonly writerId: string;
  readonly action: NarrativeSyncCursorRecoveryAction;
  readonly reason: string;
  readonly proposal?: NarrativeSyncCursorRecoveryProposal;
  readonly issueCodes: readonly NarrativeSyncJournalIntegrityIssueCode[];
}

export interface NarrativeSyncCursorRecoveryPlan {
  readonly projectId: string;
  readonly items: readonly NarrativeSyncCursorRecoveryItem[];
  readonly manualReviewCount: number;
  readonly proposedRebuildCount: number;
  readonly requiresManualReview: boolean;
}

/**
 * Construye un plan consultivo para divergencias de cursores. Nunca escribe
 * en IndexedDB. Solo propone reconstrucción cuando el diario de ese escritor
 * es completo desde la secuencia 1, cada envoltura/metadato es válido y la
 * única divergencia es un cursor ausente o una identidad final equivocada.
 * La propuesta debe volver a validarse en una transacción antes de aplicarse.
 */
export async function planNarrativeSyncJournalCursorRecovery(
  journal: Pick<IndexedDbNarrativeSyncJournal, "loadOperations" | "loadWriterCursors">,
  projectId: string
): Promise<NarrativeSyncCursorRecoveryPlan> {
  if (!journal || typeof journal.loadOperations !== "function" ||
      typeof journal.loadWriterCursors !== "function" ||
      typeof projectId !== "string" || !projectId.trim()) {
    throw new TypeError("Se requiere un diario y un proyecto válidos para planificar recuperación.");
  }

  const operations = await journal.loadOperations(projectId);
  const cursors = await journal.loadWriterCursors(projectId);
  const snapshotJournal = {
    loadOperations: async () => operations,
    loadWriterCursors: async () => cursors
  };
  const integrity = await inspectNarrativeSyncJournalIntegrity(snapshotJournal, projectId);
  const writers = new Set<string>([
    ...operations.map(operation => typeof operation.writerId === "string" ? operation.writerId : ""),
    ...cursors.map(cursor => typeof cursor.writerId === "string" ? cursor.writerId : "")
  ]);
  const items: NarrativeSyncCursorRecoveryItem[] = [];

  for (const writerId of [...writers].sort((left, right) => left.localeCompare(right))) {
    const entries = operations
      .filter(operation => operation.writerId === writerId)
      .slice()
      .sort((left, right) => left.sequence - right.sequence);
    const cursor = cursors.find(candidate => candidate.writerId === writerId);
    const writerIssues = integrity.issues.filter(issue => issue.writerId === writerId);
    const issueCodes = [...new Set(writerIssues.map(issue => issue.code))];
    const last = entries[entries.length - 1];
    const complete = entries.length > 0 &&
      entries.every((entry, index) =>
        entry.projectId === projectId &&
        entry.writerId === writerId &&
        Number.isSafeInteger(entry.sequence) &&
        entry.sequence === index + 1
      ) &&
      !writerIssues.some(issue =>
        issue.code !== "cursor-missing-for-operations" &&
        issue.code !== "cursor-last-operation-mismatch"
      );

    if (writerIssues.length === 0 && cursor && last &&
        cursor.lastSequence === last.sequence && cursor.lastOperationId === last.operationId) {
      items.push({
        writerId,
        action: "no-action",
        reason: "El cursor coincide con la última operación y no hay incidencias para este escritor.",
        issueCodes
      });
      continue;
    }

    const onlyMissingCursor = !cursor &&
      issueCodes.length === 1 &&
      issueCodes[0] === "cursor-missing-for-operations";
    const onlyLastIdentityMismatch = Boolean(cursor && last &&
      cursor.lastSequence === last.sequence &&
      issueCodes.length === 1 &&
      issueCodes[0] === "cursor-last-operation-mismatch");

    if (complete && last && (onlyMissingCursor || onlyLastIdentityMismatch)) {
      items.push({
        writerId,
        action: "rebuild-cursor-from-complete-journal",
        reason: onlyMissingCursor
          ? "El historial es contiguo desde la secuencia 1 y sus envolturas son válidas; se puede proponer un cursor derivado de la última operación."
          : "El historial completo confirma la última secuencia e identidad; solo diverge la identidad almacenada en el cursor.",
        proposal: {
          projectId,
          writerId,
          lastSequence: last.sequence,
          lastOperationId: last.operationId
        },
        issueCodes
      });
      continue;
    }

    items.push({
      writerId,
      action: "manual-review",
      reason: !entries.length
        ? "No hay operaciones conservadas para reconstruir el cursor."
        : "La divergencia no puede resolverse únicamente con un historial completo y verificable; no se propone modificar datos.",
      issueCodes
    });
  }

  const manualReviewCount = items.filter(item => item.action === "manual-review").length;
  const proposedRebuildCount = items.filter(
    item => item.action === "rebuild-cursor-from-complete-journal"
  ).length;
  return {
    projectId,
    items,
    manualReviewCount,
    proposedRebuildCount,
    requiresManualReview: manualReviewCount > 0
  };
}

export interface NarrativeSyncReplayResult {
  readonly processed: number;
  readonly remaining: number;
  readonly stoppedAtOperationId?: string;
  readonly failure?: "invalid-envelope" | "apply-or-ack-failed" | "consumer-already-running" | "consumer-lock-failed";
}

/** Adaptador mínimo de Web Locks, inyectable para pruebas y runtimes alternativos. */
export interface NarrativeSyncReplayLockManager {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive"; readonly ifAvailable: true },
    callback: (lock: unknown | null) => Promise<T>
  ): Promise<T>;
}

/**
 * Reproduce operaciones pendientes en orden y confirma cada una tras el callback.
 * Si el callback falla, la operación permanece pendiente y el replay se detiene.
 * El callback debe ser idempotente: un fallo del proceso entre la mutación externa
 * y markApplied puede provocar que la misma operación se entregue otra vez.
 */
const activeNarrativeSyncProjectWideReplays = new Set<string>();
const activeNarrativeSyncWriterReplays = new Map<string, Set<string>>();

export async function replayPendingNarrativeSyncOperations(
  journal: IndexedDbNarrativeSyncJournal,
  projectId: string,
  apply: (operation: NarrativeSyncOperationEnvelope) => Promise<void>,
  writerId?: string,
  lockManager?: NarrativeSyncReplayLockManager
): Promise<NarrativeSyncReplayResult> {
  if (!journal || typeof apply !== "function") {
    throw new TypeError("Se requiere un diario y un procesador de operaciones.");
  }
  if (!projectId.trim() || (writerId !== undefined && !writerId.trim())) {
    throw new TypeError("Proyecto y escritor deben ser identificadores no vacíos.");
  }
  // Un replay de proyecto completo excluye a todos los escritores del proyecto.
  // Replays de escritores distintos pueden avanzar en paralelo: sus cursores son
  // independientes y las escrituras de dominio siguen protegidas por CAS.
  // El lock local evita reentradas inmediatas; Web Locks añade exclusión
  // entre pestañas del mismo origen. Sin Web Locks, la garantía es local.
  const writerLocks = activeNarrativeSyncWriterReplays.get(projectId);
  const blocked = writerId === undefined
    ? activeNarrativeSyncProjectWideReplays.has(projectId) || Boolean(writerLocks?.size)
    : activeNarrativeSyncProjectWideReplays.has(projectId) || Boolean(writerLocks?.has(writerId));
  if (blocked) {
    return {
      processed: 0,
      remaining: (await journal.loadPendingOperations(projectId, writerId)).length,
      failure: "consumer-already-running"
    };
  }
  if (writerId === undefined) {
    activeNarrativeSyncProjectWideReplays.add(projectId);
  } else {
    const locks = writerLocks ?? new Set<string>();
    locks.add(writerId);
    activeNarrativeSyncWriterReplays.set(projectId, locks);
  }
  try {
    const runReplay = async (): Promise<NarrativeSyncReplayResult> => {
        const pending = await journal.loadPendingOperations(projectId, writerId);
        let processed = 0;
        for (const operation of pending) {
          // El registro añade receivedAt/appliedAt, que son metadatos locales y no
          // forman parte del digest original de la envoltura recibida.
          let envelope: NarrativeSyncOperationEnvelope;
          try {
            envelope = {
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
          } catch {
            const remaining = (await journal.loadPendingOperations(projectId, writerId)).length;
            return {
              processed, remaining, stoppedAtOperationId: operation.operationId,
              failure: "invalid-envelope"
            };
          }
          if (!(await journal.verifyEnvelope(envelope))) {
            const remaining = (await journal.loadPendingOperations(projectId, writerId)).length;
            return {
              processed, remaining, stoppedAtOperationId: operation.operationId,
              failure: "invalid-envelope"
            };
          }
          try {
            await apply(envelope);
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
      
    };
    const runtimeLocks = (globalThis as unknown as {
      navigator?: { locks?: unknown };
    }).navigator?.locks as NarrativeSyncReplayLockManager | undefined;
    const locks = lockManager ?? runtimeLocks;
    if (!locks) return await runReplay();
    try {
      return await locks.request(
        "motor-literario:narrative-sync:" + encodeURIComponent(projectId),
        { mode: "exclusive", ifAvailable: true },
        async lock => {
          if (!lock) {
            return {
              processed: 0,
              remaining: (await journal.loadPendingOperations(projectId, writerId)).length,
              failure: "consumer-already-running"
            };
          }
          return runReplay();
        }
      );
    } catch {
      // Si Web Locks falla, nunca degradar silenciosamente a replay sin exclusión.
      return {
        processed: 0,
        remaining: (await journal.loadPendingOperations(projectId, writerId)).length,
        failure: "consumer-lock-failed"
      };
    }
  } finally {
    if (writerId === undefined) {
      activeNarrativeSyncProjectWideReplays.delete(projectId);
    } else {
      const locks = activeNarrativeSyncWriterReplays.get(projectId);
      locks?.delete(writerId);
      if (locks?.size === 0) activeNarrativeSyncWriterReplays.delete(projectId);
    }
  }
}
