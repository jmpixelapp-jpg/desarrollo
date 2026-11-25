import type { ChangeAdmission, EditorChange } from "./contracts";

export interface LiveAuthorMonitorEditorChangeSource {
  /**
   * Suscribe deltas ya normalizados del editor. Cada evento debe contener
   * offsets UTF-16, revisión base y secuencia del documento correspondientes.
   */
  subscribeChanges(listener: (change: EditorChange) => void): () => void;
}

export interface LiveAuthorMonitorChangeSink {
  /** HostEngineApi.onEditorChange; integra automáticamente el monitor y la cola. */
  onEditorChange(change: EditorChange): ChangeAdmission;
}

export type LiveAuthorMonitorBackpressureReason = "queue_full" | "rejected" | "sink_error";

/** Estado observable del backlog FIFO; no contiene texto del manuscrito. */
export interface LiveAuthorMonitorBackpressureSnapshot {
  readonly status: "clear" | "backpressured";
  readonly pendingCount: number;
  readonly firstPendingSequence?: number;
  readonly lastPendingSequence?: number;
  readonly reason?: LiveAuthorMonitorBackpressureReason;
}

export interface LiveAuthorMonitorChangeBindingOptions {
  readonly source: LiveAuthorMonitorEditorChangeSource;
  readonly sink: LiveAuthorMonitorChangeSink;
  /** Se llama una vez por cada intento real de admisión, incluida la contrapresión. */
  readonly onAdmission: (change: EditorChange, admission: ChangeAdmission) => void;
  /**
   * Se notifica al cambiar el backlog, tanto al entrar en contrapresión como
   * al drenar o descartar la cola tras una resincronización autoritativa.
   * El snapshot es inmutable y nunca incluye el contenido del manuscrito.
   */
  readonly onBackpressure?: (snapshot: LiveAuthorMonitorBackpressureSnapshot) => void;
  /**
   * Fuente opcional de señales de capacidad. Puede conectarse a
   * HostEngineApi.subscribeLiveAuthorMonitor para reintentar automáticamente
   * cuando una admisión/commit publique nuevas métricas.
   */
  readonly subscribeRetrySignal?: (listener: () => void) => () => void;
  /** Recibe errores de envío o de la callback de admisión sin romper la notificación del editor. */
  readonly onError: (error: unknown, change: EditorChange) => void;
}

/**
 * El handle sigue siendo una función invocable para conservar el uso histórico
 * stopChanges(). Además expone reintento e inspección de la cola diferida.
 */
export interface LiveAuthorMonitorChangeBindingControl {
  (): void;
  /** Reenvía en orden todos los deltas retenidos hasta que el motor vuelva a rechazarlos. */
  retryPending(): void;
  /** Devuelve una copia inmutable de los deltas que aún no fueron admitidos. */
  getPendingChanges(): readonly EditorChange[];
  /**
   * Descarta el backlog solo después de reconciliar editor y motor con un
   * snapshot autoritativo. No debe usarse para ocultar un queue_full temporal.
   */
  discardPendingAfterResynchronization(): void;
}

/**
 * Une el flujo de deltas de un editor con HostEngineApi.onEditorChange.
 *
 * Si el motor devuelve queue_full, retiene el delta rechazado y todos los
 * eventos posteriores, sin enviarlos fuera de orden. El anfitrión llama a
 * retryPending cuando la cola del motor haya liberado capacidad. Si se aporta
 * subscribeRetrySignal, el enlace lo hace automáticamente y se desuscribe al parar.
 *
 * onBackpressure permite reflejar el tamaño y la recuperación del backlog en
 * la interfaz sin exponer el texto ni acoplar el monitor a un framework visual.
 *
 * No sintetiza offsets ni llama manualmente a recordAdmission/recordCommit:
 * HostEngineApi ya alimenta LiveAuthorMonitor dentro del flujo normal.
 */
export function bindLiveAuthorMonitorEditorChanges(
  options: LiveAuthorMonitorChangeBindingOptions
): LiveAuthorMonitorChangeBindingControl {
  if (!options || !options.source ||
      typeof options.source.subscribeChanges !== "function") {
    throw new TypeError("source debe implementar subscribeChanges.");
  }
  if (!options.sink || typeof options.sink.onEditorChange !== "function") {
    throw new TypeError("sink debe implementar onEditorChange.");
  }
  if (typeof options.onAdmission !== "function" || typeof options.onError !== "function") {
    throw new TypeError("onAdmission y onError son callbacks obligatorias.");
  }
  if (options.onBackpressure !== undefined && typeof options.onBackpressure !== "function") {
    throw new TypeError("onBackpressure debe ser una función cuando se proporciona.");
  }

  let disposed = false;
  let retrying = false;
  let pendingReason: LiveAuthorMonitorBackpressureReason | undefined;
  const pending: EditorChange[] = [];

  const reportError = (error: unknown, change: EditorChange): void => {
    try { options.onError(error, change); } catch {
      // La interfaz de diagnóstico no debe interrumpir el stream del editor.
    }
  };

  const reportAdmission = (change: EditorChange, admission: ChangeAdmission): void => {
    try { options.onAdmission(change, admission); } catch (error) {
      reportError(error, change);
    }
  };

  const publishBackpressure = (fallbackChange?: EditorChange): void => {
    if (!options.onBackpressure) return;
    const first = pending[0];
    const last = pending[pending.length - 1];
    const snapshot: LiveAuthorMonitorBackpressureSnapshot = pending.length === 0
      ? Object.freeze({ status: "clear", pendingCount: 0 })
      : Object.freeze({
          status: "backpressured",
          pendingCount: pending.length,
          firstPendingSequence: first?.sequence,
          lastPendingSequence: last?.sequence,
          reason: pendingReason ?? "rejected"
        });

    try {
      options.onBackpressure(snapshot);
    } catch {
      // La vista de contrapresión es observabilidad opcional; no debe frenar al autor.
      // Sus errores no se reenvían a onError para evitar bucles entre callbacks.
      void fallbackChange;
    }
  };

  const submitNewChange = (change: EditorChange): void => {
    if (disposed) return;
    if (pending.length > 0) {
      pending.push(change);
      publishBackpressure(change);
      return;
    }

    let admission: ChangeAdmission;
    try {
      admission = options.sink.onEditorChange(change);
    } catch (error) {
      pending.push(change);
      pendingReason = "sink_error";
      publishBackpressure(change);
      reportError(error, change);
      return;
    }

    if (admission.status === "rejected") {
      pending.push(change);
      pendingReason = admission.reason === "queue_full" ? "queue_full" : "rejected";
      publishBackpressure(change);
    }
    reportAdmission(change, admission);
  };

  const retryPending = (): void => {
    if (disposed || retrying || pending.length === 0) return;
    retrying = true;
    try {
      while (!disposed && pending.length > 0) {
        const change = pending[0];
        if (!change) break;

        let admission: ChangeAdmission;
        try {
          admission = options.sink.onEditorChange(change);
        } catch (error) {
          pendingReason = "sink_error";
          publishBackpressure(change);
          reportError(error, change);
          break;
        }

        if (admission.status === "queued") {
          pending.shift();
          if (pending.length === 0) pendingReason = undefined;
          publishBackpressure(change);
        } else {
          pendingReason = admission.reason === "queue_full" ? "queue_full" : "rejected";
          publishBackpressure(change);
        }
        reportAdmission(change, admission);
        if (admission.status === "rejected") break;
      }
    } finally {
      retrying = false;
    }
  };

  let unsubscribeRetrySignal: (() => void) | undefined;
  let unsubscribeSource: (() => void) | undefined;

  try {
    if (options.subscribeRetrySignal) {
      unsubscribeRetrySignal = options.subscribeRetrySignal(retryPending);
      if (typeof unsubscribeRetrySignal !== "function") {
        throw new TypeError("subscribeRetrySignal debe devolver una función de cancelación.");
      }
    }

    unsubscribeSource = options.source.subscribeChanges(submitNewChange);
    if (typeof unsubscribeSource !== "function") {
      throw new TypeError("subscribeChanges debe devolver una función de cancelación.");
    }
  } catch (error) {
    try { unsubscribeSource?.(); } catch { /* Conserva el error original de montaje. */ }
    try { unsubscribeRetrySignal?.(); } catch { /* Conserva el error original de montaje. */ }
    throw error;
  }

  const stop = (() => {
    if (disposed) return;
    disposed = true;
    pending.length = 0;
    pendingReason = undefined;
    publishBackpressure();
    try { unsubscribeSource?.(); } finally { unsubscribeRetrySignal?.(); }
  }) as LiveAuthorMonitorChangeBindingControl;

  stop.retryPending = retryPending;
  stop.getPendingChanges = () => Object.freeze([...pending]);
  stop.discardPendingAfterResynchronization = () => {
    if (disposed) return;
    pending.length = 0;
    pendingReason = undefined;
    publishBackpressure();
  };
  return stop;
}
