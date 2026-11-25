import type {
  ChangeAdmission,
  DocumentSnapshot,
  EditorChange
} from "./contracts";
import {
  bindLiveAuthorMonitorEditorChanges,
  type LiveAuthorMonitorChangeBindingControl,
  type LiveAuthorMonitorBackpressureSnapshot
} from "./live-author-monitor-change-binding";
import type { LiveAuthorMonitorSnapshot } from "./live-author-monitor";
import {
  LiveAuthorMonitorTextAreaSource,
  type LiveAuthorMonitorTextAreaSourceState
} from "./live-author-monitor-textarea-source";

export interface LiveAuthorMonitorTextAreaSyncState {
  readonly sequence: number;
  readonly pendingSequence: number;
  readonly needsResync: boolean;
}

export interface LiveAuthorMonitorTextAreaHostApi {
  getSnapshot(documentId: string): DocumentSnapshot | undefined;
  getDocumentSyncState(documentId: string): LiveAuthorMonitorTextAreaSyncState | undefined;
  onEditorChange(change: EditorChange): ChangeAdmission;
  getLiveAuthorMonitorSnapshot(documentId: string): LiveAuthorMonitorSnapshot | undefined;
  ensureLiveAuthorMonitorDocument(documentId: string): LiveAuthorMonitorSnapshot;
  subscribeLiveAuthorMonitor(listener: (snapshot: LiveAuthorMonitorSnapshot) => void): () => void;
  resynchronizeLiveAuthorMonitor(snapshot: DocumentSnapshot): LiveAuthorMonitorSnapshot;
}

export interface LiveAuthorMonitorTextAreaIntegrationOptions {
  readonly element: HTMLTextAreaElement;
  readonly documentId: string;
  readonly hostApi: LiveAuthorMonitorTextAreaHostApi;
  readonly onAdmission?: (change: EditorChange, admission: ChangeAdmission) => void;
  /** Estado de la cola FIFO para indicadores visuales; nunca contiene texto del manuscrito. */
  readonly onBackpressure?: (snapshot: LiveAuthorMonitorBackpressureSnapshot) => void;
  readonly onError?: (error: unknown, change?: EditorChange) => void;
}

export interface LiveAuthorMonitorTextAreaIntegration {
  /** Estado local de secuencia y longitud; no devuelve el contenido del manuscrito. */
  getState(): LiveAuthorMonitorTextAreaSourceState;
  /** Cambios que esperan admisión por contrapresión o fallo transitorio. */
  getPendingChanges(): readonly EditorChange[];
  /** Reintento explícito; normalmente bastan las señales automáticas del motor. */
  retryPending(): void;
  /**
   * Reconciliación segura desde el snapshot del motor.
   * Rechaza si el motor aún tiene cambios sin confirmar o necesita resincronización.
   */
  resynchronize(): LiveAuthorMonitorTextAreaSourceState;
  /** Retira listeners y suscripciones sin cerrar el documento ni disponer HostEngineApi. */
  dispose(): void;
}

/**
 * Monta el adaptador textarea contra HostEngineApi en una sola operación.
 *
 * - Exige que el texto del textarea coincida con el snapshot del motor.
 * - Asegura que exista una sesión de métricas para el documento.
 * - Entrega cada delta una sola vez al motor.
 * - Reintenta el backlog FIFO cuando HostEngineApi publica nuevas métricas.
 * - Solo descarta cambios pendientes tras una resincronización explícita y durable.
 */
export function mountLiveAuthorMonitorTextArea(
  options: LiveAuthorMonitorTextAreaIntegrationOptions
): LiveAuthorMonitorTextAreaIntegration {
  if (!options || typeof options.documentId !== "string" || !options.documentId.trim()) {
    throw new TypeError("documentId es obligatorio para montar el monitor del textarea.");
  }
  if (!options.hostApi ||
      typeof options.hostApi.getSnapshot !== "function" ||
      typeof options.hostApi.getDocumentSyncState !== "function" ||
      typeof options.hostApi.onEditorChange !== "function" ||
      typeof options.hostApi.getLiveAuthorMonitorSnapshot !== "function" ||
      typeof options.hostApi.ensureLiveAuthorMonitorDocument !== "function" ||
      typeof options.hostApi.subscribeLiveAuthorMonitor !== "function" ||
      typeof options.hostApi.resynchronizeLiveAuthorMonitor !== "function") {
    throw new TypeError("hostApi no implementa el contrato completo de monitoreo del editor.");
  }

  const snapshot = options.hostApi.getSnapshot(options.documentId);
  if (!snapshot) {
    throw new Error("No se puede montar el monitor: el documento no está abierto en HostEngineApi.");
  }

  const sync = options.hostApi.getDocumentSyncState(options.documentId);
  if (!sync || sync.needsResync || sync.pendingSequence !== sync.sequence) {
    throw new Error("No se puede montar el monitor sobre un documento pendiente o que necesita resincronización.");
  }

  if (!options.hostApi.getLiveAuthorMonitorSnapshot(options.documentId)) {
    options.hostApi.ensureLiveAuthorMonitorDocument(options.documentId);
  }

  const source = new LiveAuthorMonitorTextAreaSource({
    element: options.element,
    initialSnapshot: snapshot,
    onError: error => {
      try { options.onError?.(error); } catch {
        // Un callback de diagnóstico no debe alterar la escritura.
      }
    }
  });

  let binding: LiveAuthorMonitorChangeBindingControl;
  let disposed = false;
  try {
    binding = bindLiveAuthorMonitorEditorChanges({
      source,
      sink: options.hostApi,
      subscribeRetrySignal: listener =>
        options.hostApi.subscribeLiveAuthorMonitor(() => listener()),
      onBackpressure: options.onBackpressure,
      onAdmission: (change, admission) => {
        if (admission.status === "rejected" && admission.reason !== "queue_full") {
          source.requireResynchronization(
            "El motor rechazó un delta que requiere reconciliación: " + admission.reason
          );
        }
        try { options.onAdmission?.(change, admission); } catch (error) {
          try { options.onError?.(error, change); } catch {
            // Un callback del anfitrión no debe detener el stream del editor.
          }
        }
      },
      onError: (error, change) => {
        try { options.onError?.(error, change); } catch {
          // Un callback de diagnóstico no debe alterar la escritura.
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

    resynchronize: (): LiveAuthorMonitorTextAreaSourceState => {
      if (disposed) throw new Error("No se puede resincronizar una integración ya dispuesta.");

      const currentSync = options.hostApi.getDocumentSyncState(options.documentId);
      if (!currentSync || currentSync.needsResync ||
          currentSync.pendingSequence !== currentSync.sequence) {
        throw new Error("La resincronización requiere que el motor esté durable y sin cambios pendientes.");
      }

      const authoritative = options.hostApi.getSnapshot(options.documentId);
      if (!authoritative || authoritative.documentId !== options.documentId) {
        throw new Error("HostEngineApi no devolvió un snapshot autoritativo para el documento activo.");
      }
      if (options.element.value !== authoritative.text) {
        throw new Error("El textarea debe coincidir con el snapshot autoritativo antes de reanudar.");
      }

      const monitored = options.hostApi.getLiveAuthorMonitorSnapshot(options.documentId);
      if (!monitored) {
        options.hostApi.ensureLiveAuthorMonitorDocument(options.documentId);
      } else if (monitored.needsResync ||
          monitored.latestRevision !== authoritative.revision ||
          monitored.latestSequence !== authoritative.sequence ||
          monitored.currentDocumentLength !== authoritative.text.length) {
        options.hostApi.resynchronizeLiveAuthorMonitor(authoritative);
      }

      const state = source.resynchronize(authoritative);
      binding.discardPendingAfterResynchronization();
      return state;
    },

    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      try { binding(); } finally { source.dispose(); }
    }
  };
}
