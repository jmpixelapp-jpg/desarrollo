import type { ChangeAdmission, EditorChange } from "./contracts";

export interface LiveAuthorMonitorEditorChangeSource {
  /**
   * Suscribe deltas ya normalizados del editor. Cada evento debe contener
   * offsets UTF-16, revisión base y secuencia del documento correspondientes.
   */
  subscribeChanges(listener: (change: EditorChange) => void): () => void;
  /** Pausa una fuente transaccional cuando el backlog perdió capacidad de retención. */
  requireResynchronization?(reason?: string): void;
}

export interface LiveAuthorMonitorChangeSink {
  /** HostEngineApi.onEditorChange; integra automáticamente el monitor y la cola. */
  onEditorChange(change: EditorChange): ChangeAdmission;
}

export type LiveAuthorMonitorPermanentAdmissionReason =
  Exclude<Extract<ChangeAdmission, { status: "rejected" }>["reason"], "queue_full">;

export type LiveAuthorMonitorBackpressureReason =
  | "queue_full"
  | "rejected"
  | "sink_error"
  | "resync_required"
  | LiveAuthorMonitorPermanentAdmissionReason;

/** Estado observable del backlog FIFO; no contiene texto del manuscrito. */
export interface LiveAuthorMonitorBackpressureSnapshot {
  readonly status: "clear" | "backpressured" | "resync-required";
  readonly pendingCount: number;
  readonly firstPendingSequence?: number;
  readonly lastPendingSequence?: number;
  /** Secuencia que excedió el límite y no pudo retenerse; exige snapshot común. */
  readonly overflowSequence?: number;
  /** Secuencia que originó un rechazo que requiere snapshot/resincronización. */
  readonly resyncSequence?: number;
  readonly reason?: LiveAuthorMonitorBackpressureReason;
}

/** Error emitido cuando el buffer acotado ya no puede retener todos los deltas. */
export class LiveAuthorMonitorBackpressureOverflowError extends Error {
  readonly code = "pending-buffer-overflow";

  constructor(
    readonly maxPendingChanges: number,
    readonly overflowSequence: number
  ) {
    super(
      "El backlog del monitor alcanzó " + maxPendingChanges +
      " cambios; se pausó la captura en la secuencia " + overflowSequence +
      " y se requiere resincronización desde un snapshot autoritativo."
    );
    this.name = "LiveAuthorMonitorBackpressureOverflowError";
  }
}

/** Rechazo no recuperable mediante un simple reintento de capacidad. */
export class LiveAuthorMonitorAdmissionResynchronizationError extends Error {
  readonly code = "editor-change-resync-required";

  constructor(
    readonly reason: LiveAuthorMonitorPermanentAdmissionReason,
    readonly sequence: number
  ) {
    super(
      "El motor rechazó la secuencia " + sequence + " (" + reason +
      "); la captura quedó pausada hasta reconciliar editor y motor con un snapshot autoritativo."
    );
    this.name = "LiveAuthorMonitorAdmissionResynchronizationError";
  }
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
  /**
   * Máximo de deltas retenidos fuera de la cola del motor. Predeterminado: 4096.
   * Al alcanzarlo, el enlace pausa la fuente y exige resincronización.
   */
  readonly maxPendingChanges?: number;
  /** Recibe errores de envío, callbacks o desbordamiento sin romper el editor. */
  readonly onError: (error: unknown, change: EditorChange) => void;
}

/**
 * El handle sigue siendo una función invocable para conservar el uso histórico
 * stopChanges(). Además expone reintento e inspección de la cola diferida.
 */
export interface LiveAuthorMonitorChangeBindingControl {
  /** Se detiene solo con backlog vacío; lanza un error y conserva el stream si hay deltas pendientes. */
  (): void;
  /** Reenvía en orden todos los deltas retenidos hasta que el motor vuelva a rechazarlos. */
  retryPending(): void;
  /** Devuelve una copia inmutable de los deltas que aún no fueron admitidos. */
  getPendingChanges(): readonly EditorChange[];
  /**
   * Descarta el backlog solo después de reconciliar editor y motor con el mismo
   * snapshot autoritativo. Si el buffer se desbordó, vuelve a suscribir la fuente
   * únicamente después de completar esa reconciliación.
   */
  discardPendingAfterResynchronization(): void;
}

/**
 * Une el flujo de deltas de un editor con HostEngineApi.onEditorChange.
 *
 * Si el motor devuelve queue_full, retiene el delta rechazado y todos los
 * eventos posteriores, sin enviarlos fuera de orden. El anfitrión llama a
 * retryPending cuando la cola del motor haya liberado capacidad. Si se aporta
 * subscribeRetrySignal, el enlace lo hace automáticamente.
 *
 * El buffer externo es acotado por maxPendingChanges. Si llega otro delta cuando
 * ya no cabe, el enlace no lo descarta silenciosamente: pausa la fuente, informa
 * pending-buffer-overflow y exige resincronizar editor y motor desde un snapshot
 * común antes de llamar discardPendingAfterResynchronization().
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

  const maxPendingChanges = options.maxPendingChanges ?? 4096;
  if (!Number.isSafeInteger(maxPendingChanges) || maxPendingChanges < 1 || maxPendingChanges > 65536) {
    throw new RangeError("maxPendingChanges debe ser un entero entre 1 y 65536.");
  }

  let disposed = false;
  let retrying = false;
  let resyncRequired = false;
  let pausedForResynchronization = false;
  let overflowSequence: number | undefined;
  let resyncSequence: number | undefined;
  let pendingReason: LiveAuthorMonitorBackpressureReason | undefined;
  let lastPublishedBackpressure: LiveAuthorMonitorBackpressureSnapshot | undefined;
  let unsubscribeRetrySignal: (() => void) | undefined;
  let unsubscribeSource: (() => void) | undefined;
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

  const publishBackpressure = (): void => {
    if (!options.onBackpressure) return;
    const first = pending[0];
    const last = pending[pending.length - 1];
    const status = resyncRequired
      ? "resync-required"
      : pending.length === 0 ? "clear" : "backpressured";
    const snapshot: LiveAuthorMonitorBackpressureSnapshot = status === "clear"
      ? Object.freeze({ status: "clear", pendingCount: 0 })
      : Object.freeze({
          status,
          pendingCount: pending.length,
          ...(first ? { firstPendingSequence: first.sequence } : {}),
          ...(last ? { lastPendingSequence: last.sequence } : {}),
          ...(overflowSequence === undefined ? {} : { overflowSequence }),
          ...(resyncSequence === undefined ? {} : { resyncSequence }),
          reason: pendingReason ?? "rejected"
        });

    if (lastPublishedBackpressure &&
        lastPublishedBackpressure.status === snapshot.status &&
        lastPublishedBackpressure.pendingCount === snapshot.pendingCount &&
        lastPublishedBackpressure.firstPendingSequence === snapshot.firstPendingSequence &&
        lastPublishedBackpressure.lastPendingSequence === snapshot.lastPendingSequence &&
        lastPublishedBackpressure.overflowSequence === snapshot.overflowSequence &&
        lastPublishedBackpressure.resyncSequence === snapshot.resyncSequence &&
        lastPublishedBackpressure.reason === snapshot.reason) {
      return;
    }
    lastPublishedBackpressure = snapshot;

    try {
      options.onBackpressure(snapshot);
    } catch {
      // La vista de contrapresión es observabilidad opcional; no debe frenar al autor.
      // Sus errores no se reenvían a onError para evitar bucles entre callbacks.
    }
  };

  const detachSource = (): void => {
    const unsubscribe = unsubscribeSource;
    if (!unsubscribe) return;
    // Conserva el disposer si la fuente falla al cerrar: una resincronización
    // posterior debe poder reintentar antes de crear otra suscripción.
    unsubscribe();
    if (unsubscribeSource === unsubscribe) unsubscribeSource = undefined;
  };

  const pauseForResynchronization = (
    change: EditorChange,
    reason: LiveAuthorMonitorBackpressureReason,
    error: Error,
    isOverflow = false
  ): void => {
    if (disposed || resyncRequired) return;
    resyncRequired = true;
    pausedForResynchronization = true;
    pendingReason = reason;
    resyncSequence = change.sequence;
    if (isOverflow) overflowSequence = change.sequence;

    try {
      options.source.requireResynchronization?.(error.message);
    } catch (pauseError) {
      reportError(pauseError, change);
    }
    try {
      detachSource();
    } catch (unsubscribeError) {
      reportError(unsubscribeError, change);
    }
    publishBackpressure();
    reportError(error, change);
  };

  const retainPendingChange = (change: EditorChange): EditorChange => Object.freeze({
    documentId: change.documentId,
    sequence: change.sequence,
    baseRevision: change.baseRevision,
    start: change.start,
    end: change.end,
    replacement: change.replacement,
    ...(change.activityKind === undefined ? {} : { activityKind: change.activityKind })
  });

  const submitNewChange = (change: EditorChange): void => {
    if (disposed || resyncRequired) return;
    if (pending.length > 0) {
      if (pending.length >= maxPendingChanges) {
        // No se agrega el delta que desbordaría el buffer; se obliga a tomar un snapshot común.
        pauseForResynchronization(
          change,
          "resync_required",
          new LiveAuthorMonitorBackpressureOverflowError(maxPendingChanges, change.sequence),
          true
        );
        return;
      }
      pending.push(retainPendingChange(change));
      publishBackpressure();
      return;
    }

    let admission: ChangeAdmission;
    try {
      admission = options.sink.onEditorChange(change);
    } catch (error) {
      pending.push(retainPendingChange(change));
      pendingReason = "sink_error";
      publishBackpressure();
      reportError(error, change);
      return;
    }

    if (admission.status === "queued") {
      reportAdmission(change, admission);
      return;
    }

    if (admission.reason === "queue_full") {
      pending.push(retainPendingChange(change));
      pendingReason = "queue_full";
      publishBackpressure();
      reportAdmission(change, admission);
      return;
    }

    // El rechazo no se repara esperando capacidad, pero conservamos el delta
    // acotado para diagnóstico y para descartarlo solo tras un snapshot común.
    pending.push(retainPendingChange(change));
    // Primero se marca y desacopla la fuente; onAdmission puede ser reentrante.
    // Ninguna emisión síncrona del callback debe adelantar al delta rechazado.
    pauseForResynchronization(
      change,
      admission.reason,
      new LiveAuthorMonitorAdmissionResynchronizationError(admission.reason, change.sequence)
    );
    reportAdmission(change, admission);
  };

  const retryPending = (): void => {
    if (disposed || resyncRequired || retrying || pending.length === 0) return;
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
          publishBackpressure();
          reportError(error, change);
          break;
        }

        if (admission.status === "queued") {
          pending.shift();
          if (pending.length === 0) pendingReason = undefined;
          publishBackpressure();
          reportAdmission(change, admission);
          continue;
        }

        if (admission.reason === "queue_full") {
          pendingReason = "queue_full";
          publishBackpressure();
          reportAdmission(change, admission);
          break;
        }

        // Pausar y desacoplar antes de notificar. El callback debe ejecutarse
        // una sola vez y no puede introducir otra secuencia en un stream pausado.
        pauseForResynchronization(
          change,
          admission.reason,
          new LiveAuthorMonitorAdmissionResynchronizationError(admission.reason, change.sequence)
        );
        reportAdmission(change, admission);
        break;
      }
    } finally {
      retrying = false;
    }
  };

  const attachSource = (): void => {
    if (unsubscribeSource) {
      throw new Error("La suscripción anterior del editor aún no pudo cerrarse.");
    }
    const unsubscribe = options.source.subscribeChanges(submitNewChange);
    if (typeof unsubscribe !== "function") {
      throw new TypeError("subscribeChanges debe devolver una función de cancelación.");
    }
    // Guardamos el disposer antes de procesar una emisión síncrona. Si esta
    // emisión provoca overflow, pauseForResynchronization puede haber intentado
    // cerrar la fuente antes de que subscribeChanges devolviera el disposer.
    unsubscribeSource = unsubscribe;
    if (disposed || resyncRequired) detachSource();
  };

  try {
    if (options.subscribeRetrySignal) {
      unsubscribeRetrySignal = options.subscribeRetrySignal(retryPending);
      if (typeof unsubscribeRetrySignal !== "function") {
        throw new TypeError("subscribeRetrySignal debe devolver una función de cancelación.");
      }
    }

    attachSource();
  } catch (error) {
    try { detachSource(); } catch { /* Conserva el error original de montaje. */ }
    try { unsubscribeRetrySignal?.(); } catch { /* Conserva el error original de montaje. */ }
    throw error;
  }

  const stop = (() => {
    if (!disposed && pending.length > 0) {
      throw new Error(
        "No se puede detener el enlace mientras existan cambios pendientes; reintente la cola FIFO o descarte solo tras resincronizar con un snapshot autoritativo."
      );
    }
    disposed = true;
    pendingReason = undefined;
    let cleanupFailed = false;
    let firstCleanupError: unknown;
    const attemptCleanup = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (error) {
        if (!cleanupFailed) firstCleanupError = error;
        cleanupFailed = true;
      }
    };
    attemptCleanup(detachSource);
    const unsubscribeRetry = unsubscribeRetrySignal;
    if (unsubscribeRetry) {
      attemptCleanup(() => {
        unsubscribeRetry();
        if (unsubscribeRetrySignal === unsubscribeRetry) unsubscribeRetrySignal = undefined;
      });
    }
    // Si una liberación falla, una llamada posterior a stop() puede reintentarla.
    if (cleanupFailed) throw firstCleanupError;
  }) as LiveAuthorMonitorChangeBindingControl;

  stop.retryPending = retryPending;
  stop.getPendingChanges = () => Object.freeze(pending.map(retainPendingChange));
  stop.discardPendingAfterResynchronization = () => {
    if (disposed) return;
    const shouldResume = pausedForResynchronization;
    const hadState = pending.length > 0 || resyncRequired;

    if (shouldResume) {
      try {
        // Una desuscripción fallida durante el overflow conserva su disposer.
        // Se debe completar antes de intentar abrir una nueva suscripción.
        detachSource();
        pending.length = 0;
        pendingReason = undefined;
        overflowSequence = undefined;
        resyncSequence = undefined;
        resyncRequired = false;
        pausedForResynchronization = false;
        attachSource();
        if (hadState && !resyncRequired) publishBackpressure();
      } catch (error) {
        resyncRequired = true;
        pausedForResynchronization = true;
        pendingReason = "resync_required";
        publishBackpressure();
        throw error;
      }
      return;
    }

    pending.length = 0;
    pendingReason = undefined;
    overflowSequence = undefined;
    resyncSequence = undefined;
    resyncRequired = false;
    pausedForResynchronization = false;
    if (hadState) publishBackpressure();
  };
  return stop;
}
