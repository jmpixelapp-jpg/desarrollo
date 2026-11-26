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

/** Metadatos ligeros del editor, disponibles sin materializar el texto completo. */
export interface LiveAuthorMonitorEditorDocumentState {
  readonly documentId: string;
  readonly revision: number;
  readonly sequence: number;
  /** Longitud en unidades UTF-16, igual a String.prototype.length. */
  readonly documentLength: number;
}

/**
 * Contrato mínimo que debe implementar el adaptador del editor anfitrión.
 * getSnapshot devuelve el estado local actual; subscribeTransactions emite
 * transacciones ya aplicadas, en orden y una vez por transacción.
 */
export interface LiveAuthorMonitorEditorTransactionProvider {
  /** Snapshot completo requerido al montar y al resincronizar. */
  getSnapshot(documentId: string): DocumentSnapshot | undefined;
  /**
   * Metadatos sin texto completo para validar cada transacción aplicada.
   * Los adaptadores de producción deberían implementarlo para no copiar o
   * serializar el manuscrito en cada pulsación. Si se omite, se usa getSnapshot
   * como fallback compatible con proveedores anteriores.
   */
  getDocumentState?(documentId: string): LiveAuthorMonitorEditorDocumentState | undefined;
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
  | "editor-state-mismatch"
  | "editor-state-unavailable"
  | "transaction-backlog-overflow"
  | "resync-required";

export class LiveAuthorMonitorEditorTransactionSourceError extends Error {
  readonly code: LiveAuthorMonitorEditorTransactionErrorCode;

  constructor(code: LiveAuthorMonitorEditorTransactionErrorCode, message: string) {
    super(message);
    this.name = "LiveAuthorMonitorEditorTransactionSourceError";
    this.code = code;
  }
}

interface SeenLiveAuthorMonitorTransaction {
  readonly sequence: number;
  readonly kind: LiveAuthorMonitorEditorTransactionKind;
  readonly baseRevision: number;
  readonly start: number;
  readonly end: number;
  readonly replacementLength: number;
  readonly replacementHashA: number;
  readonly replacementHashB: number;
  /** Categoría efectiva que consumen las métricas del monitor. */
  readonly activityKind?: EditorChange["activityKind"];
}

export interface LiveAuthorMonitorEditorTransactionSourceOptions {
  readonly documentId: string;
  readonly initialSnapshot: DocumentSnapshot;
  readonly provider: LiveAuthorMonitorEditorTransactionProvider;
  readonly onError?: (error: LiveAuthorMonitorEditorTransactionSourceError) => void;
  /** Ventana acotada de firmas recientes para descartar duplicados idénticos. */
  readonly duplicateWindowSize?: number;
  /** Máximo de eventos reentrantes en espera; predeterminado: 4096. */
  readonly maxQueuedTransactions?: number;
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
 * acotada de firmas compactas para distinguir duplicados exactos de IDs reutilizados.
 *
 * Los eventos undo/redo deben incluir el delta exacto que el editor ya aplicó.
 */
export class LiveAuthorMonitorEditorTransactionSource implements LiveAuthorMonitorEditorChangeSource {
  private readonly documentId: string;
  private readonly provider: LiveAuthorMonitorEditorTransactionProvider;
  private readonly onError: ((error: LiveAuthorMonitorEditorTransactionSourceError) => void) | undefined;
  private readonly duplicateWindowSize: number;
  private readonly maxQueuedTransactions: number;
  private readonly listeners = new Set<(change: EditorChange) => void>();
  private readonly dispatchQueue: EditorChange[] = [];
  private readonly pendingTransactions: LiveAuthorMonitorEditorTransaction[] = [];
  private dispatching = false;
  private processingTransactions = false;
  private readonly seenTransactions = new Map<string, SeenLiveAuthorMonitorTransaction>();
  private revision: number;
  private sequence: number;
  private documentLength: number;
  private lastTransactionKind: LiveAuthorMonitorEditorTransactionKind | null = null;
  private needsResync = false;
  private disposed = false;
  private unsubscribeProvider: (() => void) | undefined;
  /** true solo cuando unsubscribeProvider sigue retenido por una cancelación fallida. */
  private providerDetachFailed = false;

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

    const queueLimit = options.maxQueuedTransactions ?? 4096;
    if (!Number.isSafeInteger(queueLimit) || queueLimit < 1 || queueLimit > 65536) {
      throw new RangeError("maxQueuedTransactions debe ser un entero entre 1 y 65536.");
    }

    this.documentId = options.documentId;
    this.provider = options.provider;
    this.onError = options.onError;
    this.duplicateWindowSize = windowSize;
    this.maxQueuedTransactions = queueLimit;
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
        this.attachProvider();
      } catch (error) {
        this.listeners.delete(listener);
        // attachProvider conserva un disposer anterior si su cierre falló;
        // no lo descartes aquí o una reanudación podría duplicar listeners.
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

  /**
   * Reanuda únicamente cuando el snapshot local actual coincide con el del motor.
   * beforeResume se ejecuta tras aceptar el snapshot y antes de volver a suscribirse,
   * para retirar el backlog antiguo antes de que el proveedor reproduzca cambios nuevos.
   */
  resynchronize(
    snapshot: DocumentSnapshot,
    beforeResume?: () => void
  ): LiveAuthorMonitorEditorTransactionSourceState {
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
    try {
      beforeResume?.();
    } catch (error) {
      this.fail(
        "resync-required",
        "No se pudo preparar el stream antes de reanudar las transacciones del editor."
      );
      throw error;
    }
    if (this.listeners.size > 0) {
      try {
        this.attachProvider();
      } catch (error) {
        this.fail("resync-required", "No se pudo reanudar la suscripción de transacciones tras resincronizar.");
        throw error;
      }
    }
    return this.getState();
  }

  /** Suspende el stream tras un rechazo no recuperable del motor anfitrión. */
  requireResynchronization(reason = "El anfitrión solicitó resincronizar el historial del editor."): void {
    if (this.disposed) return;
    this.fail("resync-required", reason);
  }

  dispose(): void {
    if (this.disposed) {
      // Un primer cierre pudo fallar dentro del proveedor; llamadas repetidas
      // permiten terminar la retirada sin volver a registrar listeners.
      this.detachProvider();
      if (this.providerDetachFailed) {
        throw new Error("No se pudo retirar el listener del proveedor; repita dispose() para reintentar.");
      }
      return;
    }
    this.disposed = true;
    this.detachProvider();
    this.listeners.clear();
    this.dispatchQueue.length = 0;
    this.pendingTransactions.length = 0;
    this.seenTransactions.clear();
    if (this.providerDetachFailed) {
      throw new Error("No se pudo retirar el listener del proveedor; repita dispose() para reintentar.");
    }
  }

  private readonly handleTransaction = (transaction: LiveAuthorMonitorEditorTransaction): void => {
    if (this.disposed || this.needsResync) return;
    if (this.pendingTransactions.length >= this.maxQueuedTransactions) {
      this.fail(
        "transaction-backlog-overflow",
        "El proveedor produjo más transacciones reentrantes de las que admite la cola segura; se requiere resincronización."
      );
      return;
    }
    let retained: LiveAuthorMonitorEditorTransaction;
    try {
      retained = this.snapshotTransaction(transaction);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.fail(
        "invalid-transaction",
        "El proveedor modificó o no permitió copiar una transacción de forma segura: " + detail
      );
      return;
    }
    this.pendingTransactions.push(retained);
    this.drainTransactionQueue();
  };

  /**
   * Retiene el payload al cruzar la frontera del proveedor. Los eventos
   * reentrantes pueden permanecer en cola mientras otro callback sigue activo;
   * nunca conservamos referencias mutables al objeto entregado por el editor.
   */
  private snapshotTransaction(transaction: unknown): LiveAuthorMonitorEditorTransaction {
    if (!transaction || typeof transaction !== "object") {
      return transaction as LiveAuthorMonitorEditorTransaction;
    }

    const candidate = transaction as Record<string, unknown>;
    const transactionId = candidate["transactionId"];
    const kind = candidate["kind"];
    const rawChange = candidate["change"];
    if (!rawChange || typeof rawChange !== "object") {
      return Object.freeze({
        transactionId,
        kind,
        change: rawChange
      }) as unknown as LiveAuthorMonitorEditorTransaction;
    }

    const change = rawChange as Record<string, unknown>;
    const documentId = change["documentId"];
    const sequence = change["sequence"];
    const baseRevision = change["baseRevision"];
    const start = change["start"];
    const end = change["end"];
    const replacement = change["replacement"];
    const activityKind = change["activityKind"];
    const retainedChange = Object.freeze({
      documentId,
      sequence,
      baseRevision,
      start,
      end,
      replacement,
      ...(activityKind === undefined ? {} : { activityKind })
    });

    return Object.freeze({
      transactionId,
      kind,
      change: retainedChange
    }) as unknown as LiveAuthorMonitorEditorTransaction;
  }

  private drainTransactionQueue(): void {
    if (this.processingTransactions || this.disposed) return;
    this.processingTransactions = true;
    try {
      while (this.pendingTransactions.length > 0 && !this.disposed && !this.needsResync) {
        const transaction = this.pendingTransactions.shift();
        try {
          // La frontera del proveedor es dinámica en runtime: incluso un payload
          // null o un getter defectuoso debe pausar el source, no escapar al editor.
          this.processTransaction(transaction as LiveAuthorMonitorEditorTransaction);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.fail(
            "invalid-transaction",
            "El proveedor emitió un payload que no pudo validarse de forma segura: " + detail
          );
        }
      }
    } finally {
      this.processingTransactions = false;
      if (this.disposed || this.needsResync) this.pendingTransactions.length = 0;
    }
  }

  private processTransaction(transaction: LiveAuthorMonitorEditorTransaction): void {
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

    if (typeof change.replacement !== "string") {
      this.fail("invalid-change-range", "El reemplazo de la transacción nativa no es una cadena válida.");
      return;
    }

    const activityKind: unknown = change.activityKind;
    if (activityKind !== undefined &&
        activityKind !== "typing" &&
        activityKind !== "paste" &&
        activityKind !== "deletion" &&
        activityKind !== "correction" &&
        activityKind !== "undo" &&
        activityKind !== "redo" &&
        activityKind !== "other") {
      this.fail("invalid-transaction", "El editor emitió una categoría activityKind desconocida.");
      return;
    }

    const previousSignature = this.seenTransactions.get(transaction.transactionId);
    if (previousSignature !== undefined) {
      const currentSignature = this.createTransactionSignature(transaction);
      if (this.sameTransactionSignature(previousSignature, currentSignature)) return;
      this.fail(
        "transaction-id-reused",
        "El editor reutilizó un transactionId con otra secuencia o contenido; se requiere resincronización."
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

    const nextDocumentLength =
      this.documentLength + change.replacement.length - (change.end - change.start);
    let editorState: LiveAuthorMonitorEditorDocumentState | undefined;
    try {
      editorState = this.readEditorState();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.fail(
        "editor-state-unavailable",
        "No se pudieron verificar los metadatos nativos tras la transacción: " + detail
      );
      return;
    }
    if (!editorState ||
        editorState.documentId !== this.documentId ||
        editorState.sequence !== change.sequence ||
        editorState.revision !== this.revision + 1 ||
        editorState.documentLength !== nextDocumentLength) {
      this.fail(
        "editor-state-mismatch",
        "Los metadatos nativos todavía no reflejan la transacción anunciada; se suspende la captura."
      );
      return;
    }

    const normalized: EditorChange = Object.freeze({
      documentId: change.documentId,
      sequence: change.sequence,
      baseRevision: change.baseRevision,
      start: change.start,
      end: change.end,
      replacement: change.replacement,
      ...(transaction.kind === "undo" || transaction.kind === "redo"
        ? { activityKind: transaction.kind }
        : change.activityKind === undefined ? {} : { activityKind: change.activityKind })
    });

    this.sequence = normalized.sequence;
    this.revision++;
    this.documentLength = nextDocumentLength;
    this.lastTransactionKind = transaction.kind;
    this.seenTransactions.set(transaction.transactionId, this.createTransactionSignature(transaction));
    if (this.seenTransactions.size > this.duplicateWindowSize) {
      const oldest = this.seenTransactions.keys().next().value as string | undefined;
      if (oldest !== undefined) this.seenTransactions.delete(oldest);
    }

    // Serializa la notificación. Un suscriptor puede provocar otra transacción
    // de forma síncrona; esa transacción se encola y no adelanta a la actual
    // para los demás suscriptores.
    this.dispatchQueue.push(normalized);
    this.drainDispatchQueue();
  }

  private drainDispatchQueue(): void {
    if (this.dispatching || this.disposed) return;
    this.dispatching = true;
    try {
      while (this.dispatchQueue.length > 0 && !this.disposed) {
        const change = this.dispatchQueue.shift();
        if (!change) continue;
        for (const subscriber of [...this.listeners]) {
          if (this.disposed) break;
          try {
            subscriber(change);
          } catch (error) {
            this.report(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
    } finally {
      this.dispatching = false;
      if (this.disposed) this.dispatchQueue.length = 0;
    }
  }

  private attachProvider(): void {
    if (this.disposed || this.needsResync || this.listeners.size === 0) return;

    // Un disposer presente normalmente representa la suscripción activa.
    // Solo se reintenta cuando el cierre anterior falló explícitamente.
    if (this.unsubscribeProvider) {
      if (!this.providerDetachFailed) return;
      this.detachProvider();
      if (this.providerDetachFailed) {
        throw new Error("La suscripción anterior del editor aún no pudo cerrarse.");
      }
    }

    // Algunos editores reproducen eventos pendientes de forma síncrona al
    // suscribirse. Guardamos primero el disposer devuelto y después comprobamos
    // si esa reproducción provocó un fallo o un desmontaje reentrante.
    const unsubscribe = this.provider.subscribeTransactions(
      this.documentId,
      this.handleTransaction
    );
    if (typeof unsubscribe !== "function") {
      throw new TypeError("subscribeTransactions debe devolver una función de cancelación.");
    }
    this.unsubscribeProvider = unsubscribe;
    this.providerDetachFailed = false;
    if (this.disposed || this.needsResync || this.listeners.size === 0) {
      this.detachProvider();
    }
  }

  private detachProvider(): void {
    const unsubscribe = this.unsubscribeProvider;
    if (!unsubscribe) return;
    try {
      unsubscribe();
      if (this.unsubscribeProvider === unsubscribe) {
        this.unsubscribeProvider = undefined;
        this.providerDetachFailed = false;
      }
    } catch (error) {
      // Mantener el handle y marcar el fallo: la próxima reanudación debe
      // reintentar solo este cancelador, nunca cancelar uno que sigue activo.
      this.providerDetachFailed = true;
      this.report(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Firma compacta del delta para distinguir retransmisiones idénticas de
   * transactionId reutilizados con otro payload. No conserva el reemplazo.
   */
  private createTransactionSignature(
    transaction: LiveAuthorMonitorEditorTransaction
  ): SeenLiveAuthorMonitorTransaction {
    const change = transaction.change;
    let hashA = 0x811c9dc5;
    let hashB = 0x9e3779b9;
    const replacement = change.replacement;
    for (let index = 0; index < replacement.length; index += 1) {
      const codeUnit = replacement.charCodeAt(index);
      hashA = Math.imul(hashA ^ codeUnit, 0x01000193) >>> 0;
      hashB = Math.imul(hashB ^ (codeUnit + index), 0x85ebca6b) >>> 0;
      hashB ^= hashB >>> 13;
    }
    return Object.freeze({
      sequence: change.sequence,
      kind: transaction.kind,
      baseRevision: change.baseRevision,
      start: change.start,
      end: change.end,
      replacementLength: replacement.length,
      replacementHashA: hashA,
      replacementHashB: hashB,
      ...(transaction.kind === "undo" || transaction.kind === "redo"
        ? { activityKind: transaction.kind }
        : change.activityKind === undefined ? {} : { activityKind: change.activityKind })
    });
  }

  private sameTransactionSignature(
    left: SeenLiveAuthorMonitorTransaction,
    right: SeenLiveAuthorMonitorTransaction
  ): boolean {
    return left.sequence === right.sequence &&
      left.kind === right.kind &&
      left.baseRevision === right.baseRevision &&
      left.start === right.start &&
      left.end === right.end &&
      left.replacementLength === right.replacementLength &&
      left.replacementHashA === right.replacementHashA &&
      left.replacementHashB === right.replacementHashB &&
      left.activityKind === right.activityKind;
  }

  private readEditorState(): LiveAuthorMonitorEditorDocumentState | undefined {
    const metadata = this.provider.getDocumentState;
    if (typeof metadata === "function") {
      const state = metadata.call(this.provider, this.documentId);
      if (!this.isValidEditorState(state)) {
        throw new Error("getDocumentState devolvió metadatos inválidos para el editor.");
      }
      return state;
    }

    const snapshot = this.provider.getSnapshot(this.documentId);
    if (!this.isValidSnapshot(snapshot)) return undefined;
    return {
      documentId: snapshot.documentId,
      revision: snapshot.revision,
      sequence: snapshot.sequence,
      documentLength: snapshot.text.length
    };
  }

  private isValidEditorState(
    state: LiveAuthorMonitorEditorDocumentState | undefined
  ): state is LiveAuthorMonitorEditorDocumentState {
    return !!state &&
      typeof state.documentId === "string" && state.documentId.trim().length > 0 &&
      Number.isSafeInteger(state.revision) && state.revision >= 0 &&
      Number.isSafeInteger(state.sequence) && state.sequence >= 0 &&
      Number.isSafeInteger(state.documentLength) && state.documentLength >= 0;
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
