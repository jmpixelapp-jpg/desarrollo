import type { ChangeAdmission, DocumentSnapshot, EditorChange } from "./contracts";
import {
  bindLiveAuthorMonitorEditorChanges,
  type LiveAuthorMonitorBackpressureSnapshot,
  type LiveAuthorMonitorChangeBindingControl
} from "./live-author-monitor-change-binding";
import type {
  LiveAuthorMonitorEditorHostApi
} from "./live-author-monitor-textarea-integration";
import type { LiveAuthorMonitorSnapshot } from "./live-author-monitor";
import {
  LiveAuthorMonitorEditorTransactionSource,
  type LiveAuthorMonitorEditorTransactionProvider,
  type LiveAuthorMonitorEditorTransactionSourceError,
  type LiveAuthorMonitorEditorTransactionSourceState
} from "./live-author-monitor-editor-transaction-source";

export interface LiveAuthorMonitorEditorTransactionIntegrationOptions {
  readonly documentId: string;
  readonly editor: LiveAuthorMonitorEditorTransactionProvider;
  readonly hostApi: LiveAuthorMonitorEditorHostApi;
  readonly onAdmission?: (change: EditorChange, admission: ChangeAdmission) => void;
  readonly onBackpressure?: (snapshot: LiveAuthorMonitorBackpressureSnapshot) => void;
  /** Máximo de deltas externos retenidos antes de exigir snapshot común; predeterminado: 4096. */
  readonly maxPendingChanges?: number;
  /** Máximo total de unidades UTF-16 de eventos reentrantes retenidos; predeterminado: 4194304. */
  readonly maxQueuedTextUnits?: number;
  readonly onError?: (
    error: unknown,
    change?: EditorChange
  ) => void;
}

export interface LiveAuthorMonitorEditorTransactionIntegration {
  /** Estado de revisión/secuencia y última transacción; no contiene el manuscrito. */
  getState(): LiveAuthorMonitorEditorTransactionSourceState;
  /** Deltas que esperan admisión o reintento FIFO. */
  getPendingChanges(): readonly EditorChange[];
  /** Reintenta explícitamente; normalmente bastan las señales automáticas del motor. */
  retryPending(): void;
  /** Resincroniza editor, motor y monitor desde un snapshot durable compartido. */
  resynchronize(): LiveAuthorMonitorEditorTransactionSourceState;
  /**
   * Retira las suscripciones sin cerrar el documento ni disponer HostEngineApi.
   * Lanza un error y mantiene la integración activa mientras haya deltas sin admitir.
   */
  dispose(): void;
}

function isValidSnapshot(snapshot: DocumentSnapshot | undefined): snapshot is DocumentSnapshot {
  return !!snapshot &&
    typeof snapshot.documentId === "string" && snapshot.documentId.trim().length > 0 &&
    typeof snapshot.text === "string" &&
    Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0 &&
    Number.isSafeInteger(snapshot.sequence) && snapshot.sequence >= 0;
}

function snapshotsMatch(left: DocumentSnapshot | undefined, right: DocumentSnapshot): boolean {
  return isValidSnapshot(left) &&
    left.documentId === right.documentId &&
    left.text === right.text &&
    left.revision === right.revision &&
    left.sequence === right.sequence;
}

/**
 * Une las transacciones nativas de un editor con historial propio a HostEngineApi.
 *
 * El proveedor debe emitir cada operación ya aplicada, incluidas las
 * transacciones inversas de undo y las reejecuciones de redo. Esta integración
 * no simula pulsaciones ni reconstruye texto desde el DOM.
 */
export function mountLiveAuthorMonitorEditorTransactions(
  options: LiveAuthorMonitorEditorTransactionIntegrationOptions
): LiveAuthorMonitorEditorTransactionIntegration {
  if (!options || typeof options.documentId !== "string" || !options.documentId.trim()) {
    throw new TypeError("documentId es obligatorio para montar el monitoreo transaccional.");
  }

  if (options.maxPendingChanges !== undefined &&
      (!Number.isSafeInteger(options.maxPendingChanges) ||
       options.maxPendingChanges < 1 || options.maxPendingChanges > 65536)) {
    throw new RangeError("maxPendingChanges debe ser un entero entre 1 y 65536.");
  }
  if (options.maxQueuedTextUnits !== undefined &&
      (!Number.isSafeInteger(options.maxQueuedTextUnits) || options.maxQueuedTextUnits < 1)) {
    throw new RangeError("maxQueuedTextUnits debe ser un entero positivo.");
  }

  if (!options.editor ||
      typeof options.editor.getSnapshot !== "function" ||
      typeof options.editor.subscribeTransactions !== "function") {
    throw new TypeError("editor debe implementar getSnapshot y subscribeTransactions.");
  }

  const hostApi = options.hostApi;
  if (!hostApi ||
      typeof hostApi.getSnapshot !== "function" ||
      typeof hostApi.getDocumentSyncState !== "function" ||
      typeof hostApi.onEditorChange !== "function" ||
      typeof hostApi.getLiveAuthorMonitorSnapshot !== "function" ||
      typeof hostApi.ensureLiveAuthorMonitorDocument !== "function" ||
      typeof hostApi.subscribeLiveAuthorMonitor !== "function" ||
      typeof hostApi.resynchronizeLiveAuthorMonitor !== "function") {
    throw new TypeError("hostApi no implementa el contrato completo de monitoreo del editor.");
  }

  const snapshot = hostApi.getSnapshot(options.documentId);
  if (!snapshot) {
    throw new Error("No se puede montar el monitoreo: el documento no está abierto en HostEngineApi.");
  }
  const sync = hostApi.getDocumentSyncState(options.documentId);
  if (!sync || sync.needsResync || sync.pendingSequence !== sync.sequence) {
    throw new Error("No se puede montar el monitoreo sobre un documento pendiente o que requiere resincronización.");
  }
  if (!snapshotsMatch(options.editor.getSnapshot(options.documentId), snapshot)) {
    throw new Error("El editor nativo y HostEngineApi deben compartir el mismo snapshot al montar.");
  }

  const source = new LiveAuthorMonitorEditorTransactionSource({
    documentId: options.documentId,
    initialSnapshot: snapshot,
    provider: options.editor,
    ...(options.maxQueuedTextUnits === undefined ? {} : { maxQueuedTextUnits: options.maxQueuedTextUnits }),
    onError: (error: LiveAuthorMonitorEditorTransactionSourceError) => {
      try { options.onError?.(error); } catch {
        // La interfaz de diagnóstico no debe interrumpir el editor.
      }
    }
  });

  if (!hostApi.getLiveAuthorMonitorSnapshot(options.documentId)) {
    try {
      hostApi.ensureLiveAuthorMonitorDocument(options.documentId);
    } catch (error) {
      source.dispose();
      throw error;
    }
  }

  let binding: LiveAuthorMonitorChangeBindingControl;
  let disposed = false;
  try {
    binding = bindLiveAuthorMonitorEditorChanges({
      source,
      sink: hostApi,
      subscribeRetrySignal: listener =>
        hostApi.subscribeLiveAuthorMonitor(() => listener()),
      ...(options.onBackpressure ? { onBackpressure: options.onBackpressure } : {}),
      ...(options.maxPendingChanges === undefined ? {} : { maxPendingChanges: options.maxPendingChanges }),
      onAdmission: (change, admission) => {
        if (admission.status === "rejected" && admission.reason !== "queue_full") {
          source.requireResynchronization(
            "HostEngineApi rechazó una transacción que requiere reconciliación: " + admission.reason
          );
        }
        try { options.onAdmission?.(change, admission); } catch (error) {
          try { options.onError?.(error, change); } catch {
            // La UI no debe detener la entrega de transacciones.
          }
        }
      },
      onError: (error, change) => {
        try { options.onError?.(error, change); } catch {
          // Los errores de diagnóstico no deben alterar la edición.
        }
      }
    });
  } catch (error) {
    source.dispose();
    throw error;
  }

  return {
    getState: () => source.getState(),
    getPendingChanges: () => binding.getPendingChanges(),
    retryPending: () => binding.retryPending(),

    resynchronize: (): LiveAuthorMonitorEditorTransactionSourceState => {
      if (disposed) throw new Error("No se puede resincronizar una integración ya dispuesta.");

      const currentSync = hostApi.getDocumentSyncState(options.documentId);
      if (!currentSync || currentSync.needsResync ||
          currentSync.pendingSequence !== currentSync.sequence) {
        throw new Error("La resincronización requiere que HostEngineApi esté durable y sin cambios pendientes.");
      }

      const authoritative = hostApi.getSnapshot(options.documentId);
      if (!isValidSnapshot(authoritative) || authoritative.documentId !== options.documentId) {
        throw new Error("HostEngineApi no devolvió un snapshot autoritativo válido para el documento.");
      }
      if (!snapshotsMatch(options.editor.getSnapshot(options.documentId), authoritative)) {
        throw new Error("El editor debe coincidir con el snapshot autoritativo antes de reanudar.");
      }

      const monitored: LiveAuthorMonitorSnapshot | undefined =
        hostApi.getLiveAuthorMonitorSnapshot(options.documentId);
      if (!monitored) {
        hostApi.ensureLiveAuthorMonitorDocument(options.documentId);
      } else if (monitored.needsResync ||
          monitored.latestRevision !== authoritative.revision ||
          monitored.latestSequence !== authoritative.sequence ||
          monitored.currentDocumentLength !== authoritative.text.length) {
        hostApi.resynchronizeLiveAuthorMonitor(authoritative);
      }

      // El snapshot durable ya cubre el backlog anterior. Límpialo antes
      // de reactivar el proveedor: subscribeTransactions puede reproducir
      // transacciones nuevas de forma síncrona durante la reconexión.
      return source.resynchronize(
        authoritative,
        () => binding.discardPendingAfterResynchronization()
      );
    },

    dispose: (): void => {
      if (disposed) {
        // La primera limpieza puede haber encontrado un disposer del proveedor
        // temporalmente fallido; permitir llamadas repetidas para reintentarla.
        try { binding(); } finally { source.dispose(); }
        return;
      }
      if (binding.getPendingChanges().length > 0) {
        throw new Error(
          "No se puede desmontar el monitor mientras existan cambios sin admitir; reintente la cola o resincronice antes de disponer la integración."
        );
      }
      disposed = true;
      try { binding(); } finally { source.dispose(); }
    }
  };
}
