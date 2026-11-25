import type { DocumentSnapshot, EditorChange } from "./contracts";
import type { LiveAuthorMonitorEditorChangeSource } from "./live-author-monitor-change-binding";

export type LiveAuthorMonitorEditorTransactionKind = "edit" | "undo" | "redo";

export interface LiveAuthorMonitorEditorTransaction {
  /** Identificador estable y único de esta transacción ya aplicada por el editor. */
  readonly transactionId: string;
  readonly kind: LiveAuthorMonitorEditorTransactionKind;
  /**
   * Delta exacto que el editor aplicó localmente. En undo/redo debe ser la
   * operación inversa/reenviada real, no una reconstrucción desde el DOM.
   */
  readonly change: EditorChange;
}

/**
 * Contrato mínimo que debe implementar el adaptador del editor anfitrión.
 * getSnapshot devuelve el estado local actual; subscribeTransactions emite
 * transacciones ya aplicadas, en orden y una vez por transacción.
 */
export interface LiveAuthorMonitorEditorTransactionProvider {
  getSnapshot(documentId: string): DocumentSnapshot | undefined;
  subscribeTransactions(
    documentId: string,
    listener: (transaction: LiveAuthorMonitorEditorTransaction) => void
  ): () => void;
}

export type LiveAuthorMonitorEditorTransactionErrorCode =
  | "invalid-initial-snapshot"
  | "editor-snapshot-mismatch"
  | "invalid-transaction"
  | "document-mismatch"
  | "transaction-id-reused"
  | "sequence-gap"
  | "revision-mismatch"
  | "invalid-change-range"
  | "resync-required";

export class LiveAuthorMonitorEditorTransactionSourceError extends Error {
  readonly code: LiveAuthorMonitorEditorTransactionErrorCode;

  constructor(code: LiveAuthorMonitorEditorTransactionErrorCode, message: string) {
    super(message);
    this.name = "LiveAuthorMonitorEditorTransactionSourceError";
    this.code = code;
  }
}

export interface LiveAuthorMonitorEditorTransactionSourceOptions {
  readonly documentId: string;
  readonly initialSnapshot: DocumentSnapshot;
  readonly provider: LiveAuthorMonitorEditorTransactionProvider;
  readonly onError?: (error: LiveAuthorMonitorEditorTransactionSourceError) => void;
  /** Ventana acotada de IDs recientes para descartar notificaciones duplicadas. */
  readonly duplicateWindowSize?: number;
}

export interface LiveAuthorMonitorEditorTransactionSourceState {
  readonly documentId: string;
  readonly revision: number;
  readonly sequence: number;
  readonly documentLength: number;
  readonly lastTransactionKind: LiveAuthorMonitorEditorTransactionKind | null;
  readonly needsResync: boolean;
}

/**
 * Adapta transacciones autoritativas de un editor con historial propio.
 *
 * No conserva el texto del documento ni los reemplazos recibidos. Solo guarda
 * longitud, revisión, secuencia, tipo de última transacción y una ventana
 * acotada de identificadores para eliminar notificaciones duplicadas.
 *
 * Los eventos undo/redo deben incluir el delta exacto que el editor ya aplicó.
 */
export class LiveAuthorMonitorEditorTransactionSource implements LiveAuthorMonitorEditorChangeSource {
  private readonly documentId: string;
  private readonly provider: LiveAuthorMonitorEditorTransactionProvider;
  private readonly onError: ((error: LiveAuthorMonitorEditorTransactionSourceError) => void) | undefined;
  private readonly duplicateWindowSize: number;
  private readonly listeners = new Set<(change: EditorChange) => void>();
  private readonly seenTransactions = new Map<string, number>();
  private revision: number;
  private sequence: number;
  private documentLength: number;
  private lastTransactionKind: LiveAuthorMonitorEditorTransactionKind | null = null;
  private needsResync = false;
  private disposed = false;
  private unsubscribeProvider: (() => void) | undefined;

  constructor(options: LiveAuthorMonitorEditorTransactionSourceOptions) {
    if (!options || typeof options.documentId !== "string" || !options.documentId.trim()) {
      throw new TypeError("documentId es obligatorio para el adaptador transaccional del editor.");
    }
    if (!options.provider ||
        typeof options.provider.getSnapshot !== "function" ||
        typeof options.provider.subscribeTransactions !== "function") {
      throw new TypeError("provider debe implementar getSnapshot y subscribeTransactions.");
    }

    const snapshot = options.initialSnapshot;
    if (!this.isValidSnapshot(snapshot) || snapshot.documentId !== options.documentId) {
      throw new LiveAuthorMonitorEditorTransactionSourceError(
        "invalid-initial-snapshot",
        "El snapshot inicial no es válido para el documento del adaptador transaccional."
      );
    }
    const editorSnapshot = options.provider.getSnapshot(options.documentId);
    if (!this.sameSnapshot(editorSnapshot, snapshot)) {
      throw new LiveAuthorMonitorEditorTransactionSourceError(
        "editor-snapshot-mismatch",
        "El snapshot local del editor debe coincidir con el snapshot autoritativo del motor al montar."
      );
    }

    const windowSize = options.duplicateWindowSize ?? 512;
    if (!Number.isSafeInteger(windowSize) || windowSize < 1 || windowSize > 4096) {
      throw new RangeError("duplicateWindowSize debe ser un entero entre 1 y 4096.");
    }

    this.documentId = options.documentId;
    this.provider = options.provider;
    this.onError = options.onError;
    this.duplicateWindowSize = windowSize;
    this.revision = snapshot.revision;
    this.sequence = snapshot.sequence;
    this.documentLength = snapshot.text.length;
  }

  subscribeChanges(listener: (change: EditorChange) => void): () => void {
    if (this.disposed) throw new Error("No se puede suscribir un adaptador transaccional ya dispuesto.");
    if (typeof listener !== "function") throw new TypeError("listener debe ser una función.");

    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      try {
        this.unsubscribeProvider = this.provider.subscribeTransactions(
          this.documentId,
          this.handleTransaction
        );
        if (typeof this.unsubscribeProvider !== "function") {
          throw new TypeError("subscribeTransactions debe devolver una función de cancelación.");
        }
      } catch (error) {
        this.listeners.delete(listener);
        this.unsubscribeProvider = undefined;
        throw error;
      }
    }

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.detachProvider();
    };
  }

  getState(): LiveAuthorMonitorEditorTransactionSourceState {
    return Object.freeze({
      documentId: this.documentId,
      revision: this.revision,
      sequence: this.sequence,
      documentLength: this.documentLength,
      lastTransactionKind: this.lastTransactionKind,
      needsResync: this.needsResync
    });
  }

  /** Reanuda únicamente cuando el snapshot local actual coincide con el del motor. */
  resynchronize(snapshot: DocumentSnapshot): LiveAuthorMonitorEditorTransactionSourceState {
    if (this.disposed) throw new Error("No se puede resincronizar un adaptador transaccional ya dispuesto.");
    if (!this.isValidSnapshot(snapshot) || snapshot.documentId !== this.documentId) {
      throw new LiveAuthorMonitorEditorTransactionSourceError(
        "invalid-initial-snapshot",
        "El snapshot de resincronización no es válido para este documento."
      );
    }
    if (!this.sameSnapshot(this.provider.getSnapshot(this.documentId), snapshot)) {
      throw new LiveAuthorMonitorEditorTransactionSourceError(
        "editor-snapshot-mismatch",
        "El snapshot local del editor no coincide con el snapshot autoritativo del motor."
      );
    }

    this.revision = snapshot.revision;
    this.sequence = snapshot.sequence;
    this.documentLength = snapshot.text.length;
    this.lastTransactionKind = null;
    this.seenTransactions.clear();
    this.needsResync = false;
    return this.getState();
  }

  /** Suspende el stream tras un rechazo no recuperable del motor anfitrión. */
  requireResynchronization(reason = "El anfitrión solicitó resincronizar el historial del editor."): void {
    if (this.disposed) return;
    this.fail("resync-required", reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachProvider();
    this.listeners.clear();
    this.seenTransactions.clear();
  }

  private readonly handleTransaction = (transaction: LiveAuthorMonitorEditorTransaction): void => {
    if (this.disposed || this.needsResync) return;

    if (!transaction || typeof transaction.transactionId !== "string" ||
        !transaction.transactionId.trim() ||
        (transaction.kind !== "edit" && transaction.kind !== "undo" && transaction.kind !== "redo") ||
        !transaction.change) {
      this.fail("invalid-transaction", "El editor emitió una transacción nativa incompleta o inválida.");
      return;
    }

    const change = transaction.change;
    if (change.documentId !== this.documentId) {
      this.fail("document-mismatch", "El editor emitió una transacción para otro documento.");
      return;
    }

    const previousSequence = this.seenTransactions.get(transaction.transactionId);
    if (previousSequence !== undefined) {
      if (previousSequence === change.sequence) return;
      this.fail(
        "transaction-id-reused",
        "El editor reutilizó un transactionId para otra secuencia; se requiere resincronización."
      );
      return;
    }

    if (!Number.isSafeInteger(change.sequence) || change.sequence !== this.sequence + 1) {
      this.fail("sequence-gap", "La secuencia de la transacción no es consecutiva.");
      return;
    }
    if (!Number.isSafeInteger(change.baseRevision) || change.baseRevision !== this.revision) {
      this.fail("revision-mismatch", "La revisión base de la transacción no coincide con el editor observado.");
      return;
    }
    if (!Number.isSafeInteger(change.start) || !Number.isSafeInteger(change.end) ||
        change.start < 0 || change.end < change.start || change.end > this.documentLength ||
        typeof change.replacement !== "string") {
      this.fail("invalid-change-range", "El rango o reemplazo de la transacción nativa no es válido.");
      return;
    }
    if (this.sequence >= Number.MAX_SAFE_INTEGER || this.revision >= Number.MAX_SAFE_INTEGER) {
      this.fail("resync-required", "La secuencia o revisión alcanzó el límite entero seguro de JavaScript.");
      return;
    }

    const normalized: EditorChange = Object.freeze({
      documentId: change.documentId,
      sequence: change.sequence,
      baseRevision: change.baseRevision,
      start: change.start,
      end: change.end,
      replacement: change.replacement
    });

    this.sequence = normalized.sequence;
    this.revision++;
    this.documentLength += normalized.replacement.length - (normalized.end - normalized.start);
    this.lastTransactionKind = transaction.kind;
    this.seenTransactions.set(transaction.transactionId, normalized.sequence);
    if (this.seenTransactions.size > this.duplicateWindowSize) {
      const oldest = this.seenTransactions.keys().next().value as string | undefined;
      if (oldest !== undefined) this.seenTransactions.delete(oldest);
    }

    for (const subscriber of [...this.listeners]) {
      try {
        subscriber(normalized);
      } catch (error) {
        this.report(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  private detachProvider(): void {
    const unsubscribe = this.unsubscribeProvider;
    this.unsubscribeProvider = undefined;
    try { unsubscribe?.(); } catch (error) {
      this.report(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private isValidSnapshot(snapshot: DocumentSnapshot | undefined): snapshot is DocumentSnapshot {
    return !!snapshot &&
      typeof snapshot.documentId === "string" && snapshot.documentId.trim().length > 0 &&
      typeof snapshot.text === "string" &&
      Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0 &&
      Number.isSafeInteger(snapshot.sequence) && snapshot.sequence >= 0;
  }

  private sameSnapshot(left: DocumentSnapshot | undefined, right: DocumentSnapshot): boolean {
    return this.isValidSnapshot(left) &&
      left.documentId === right.documentId &&
      left.text === right.text &&
      left.revision === right.revision &&
      left.sequence === right.sequence;
  }

  private fail(code: LiveAuthorMonitorEditorTransactionErrorCode, message: string): void {
    this.needsResync = true;
    this.detachProvider();
    this.report(new LiveAuthorMonitorEditorTransactionSourceError(code, message));
  }

  private report(error: Error): void {
    try {
      this.onError?.(error instanceof LiveAuthorMonitorEditorTransactionSourceError
        ? error
        : new LiveAuthorMonitorEditorTransactionSourceError("resync-required", error.message));
    } catch {
      // Los errores de observabilidad no deben interrumpir la edición.
    }
  }
}
