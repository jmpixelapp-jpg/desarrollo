import type { DocumentSnapshot } from "./contracts";
import type {
  LiveAuthorMonitorEditorDocumentState,
  LiveAuthorMonitorEditorTransaction,
  LiveAuthorMonitorEditorTransactionProvider
} from "./live-author-monitor-editor-transaction-source";

export interface LiveAuthorMonitorEditorTransactionBridgeOptions {
  /** Lee el snapshot completo al montar o resincronizar la integración. */
  readonly getSnapshot: (documentId: string) => DocumentSnapshot | undefined;
  /** Lee revisión/secuencia/longitud sin materializar el texto completo. */
  readonly getDocumentState: (
    documentId: string
  ) => LiveAuthorMonitorEditorDocumentState | undefined;
  /** Un listener de diagnóstico no debe poder interrumpir las notificaciones. */
  readonly onListenerError?: (error: unknown, documentId: string) => void;
}

/**
 * Puente de publicación para el editor anfitrión.
 *
 * El anfitrión delega las lecturas al estado nativo del editor y llama a
 * publishAppliedTransaction() desde los callbacks de transacción ya aplicados.
 * El puente no mantiene una copia del manuscrito, no inventa deltas ni simula
 * undo/redo; solo distribuye el evento autoritativo a los suscriptores activos.
 *
 * Cada publicación es síncrona: preserva el orden en que el anfitrión informa
 * las transacciones. El source conectado valida secuencia, revisión y estado
 * del editor antes de entregar el delta al motor.
 */
export class LiveAuthorMonitorEditorTransactionBridge
implements LiveAuthorMonitorEditorTransactionProvider {
  private readonly readSnapshot: LiveAuthorMonitorEditorTransactionBridgeOptions["getSnapshot"];
  private readonly readDocumentState: LiveAuthorMonitorEditorTransactionBridgeOptions["getDocumentState"];
  private readonly onListenerError: LiveAuthorMonitorEditorTransactionBridgeOptions["onListenerError"];
  private readonly listeners = new Map<
    string,
    Set<(transaction: LiveAuthorMonitorEditorTransaction) => void>
  >();
  private readonly pendingPublications: Array<{
    readonly documentId: string;
    readonly transaction: LiveAuthorMonitorEditorTransaction;
    readonly listeners: readonly ((transaction: LiveAuthorMonitorEditorTransaction) => void)[];
  }> = [];
  private dispatching = false;
  private disposed = false;

  constructor(options: LiveAuthorMonitorEditorTransactionBridgeOptions) {
    if (!options || typeof options.getSnapshot !== "function" ||
        typeof options.getDocumentState !== "function") {
      throw new TypeError("El puente requiere lectores nativos de snapshot y metadatos del editor.");
    }
    this.readSnapshot = options.getSnapshot;
    this.readDocumentState = options.getDocumentState;
    this.onListenerError = options.onListenerError;
  }

  getSnapshot(documentId: string): DocumentSnapshot | undefined {
    this.assertActive();
    return this.readSnapshot(documentId);
  }

  getDocumentState(documentId: string): LiveAuthorMonitorEditorDocumentState | undefined {
    this.assertActive();
    return this.readDocumentState(documentId);
  }

  subscribeTransactions(
    documentId: string,
    listener: (transaction: LiveAuthorMonitorEditorTransaction) => void
  ): () => void {
    this.assertActive();
    if (typeof documentId !== "string" || !documentId.trim()) {
      throw new TypeError("documentId es obligatorio para suscribir transacciones.");
    }
    if (typeof listener !== "function") {
      throw new TypeError("listener debe ser una función.");
    }

    let subscribers = this.listeners.get(documentId);
    if (!subscribers) {
      subscribers = new Set();
      this.listeners.set(documentId, subscribers);
    }
    subscribers.add(listener);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.listeners.get(documentId);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(documentId);
    };
  }

  /**
   * Publica un evento que el editor ya aplicó localmente.
   * Retorna el número de listeners notificados; cero indica que no había una
   * integración montada para ese documento o que el puente ya fue dispuesto.
   */
  publishAppliedTransaction(
    documentId: string,
    transaction: LiveAuthorMonitorEditorTransaction
  ): number {
    if (this.disposed) return 0;
    if (typeof documentId !== "string" || !documentId.trim()) {
      throw new TypeError("documentId es obligatorio para publicar una transacción.");
    }
    const subscribers = this.listeners.get(documentId);
    if (!subscribers || subscribers.size === 0) return 0;

    // Copia solo los metadatos y el delta de la transacción; nunca el documento.
    // El objeto congelado evita que un listener altere lo que reciben los demás.
    const immutableTransaction = Object.freeze({
      transactionId: transaction.transactionId,
      kind: transaction.kind,
      change: Object.freeze({ ...transaction.change })
    });
    const targets = [...subscribers];
    this.pendingPublications.push({
      documentId,
      transaction: immutableTransaction,
      listeners: targets
    });
    this.drainPublications();
    // Cuenta los listeners registrados al encolar; una publicación reentrante
    // queda en cola y conserva el orden de la publicación exterior.
    return targets.length;
  }

  private drainPublications(): void {
    if (this.dispatching || this.disposed) return;
    this.dispatching = true;
    try {
      while (this.pendingPublications.length > 0 && !this.disposed) {
        const publication = this.pendingPublications.shift();
        if (!publication) continue;
        const active = this.listeners.get(publication.documentId);
        if (!active) continue;
        for (const listener of publication.listeners) {
          if (this.disposed) break;
          if (!active.has(listener)) continue;
          try {
            listener(publication.transaction);
          } catch (error) {
            try { this.onListenerError?.(error, publication.documentId); } catch {
              // Los diagnósticos nunca deben interferir con la edición ni con otros listeners.
            }
          }
        }
      }
    } finally {
      this.dispatching = false;
      if (this.disposed) this.pendingPublications.length = 0;
    }
  }

  getSubscriberCount(documentId?: string): number {
    if (documentId !== undefined) return this.listeners.get(documentId)?.size ?? 0;
    let count = 0;
    for (const subscribers of this.listeners.values()) count += subscribers.size;
    return count;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.pendingPublications.length = 0;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("El puente de transacciones ya fue dispuesto.");
  }
}
