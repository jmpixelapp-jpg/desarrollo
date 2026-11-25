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

export interface LiveAuthorMonitorChangeBindingOptions {
  readonly source: LiveAuthorMonitorEditorChangeSource;
  readonly sink: LiveAuthorMonitorChangeSink;
  /** Se llama una vez con la respuesta real de admisión, incluida la contrapresión. */
  readonly onAdmission: (change: EditorChange, admission: ChangeAdmission) => void;
  /** Recibe errores de envío o de la callback de admisión sin romper la notificación del editor. */
  readonly onError: (error: unknown, change: EditorChange) => void;
}

/**
 * Une el flujo de deltas de un editor con HostEngineApi.onEditorChange.
 *
 * No sintetiza offsets ni captura DOM: el adaptador concreto del editor debe
 * emitir el delta exacto. No duplica recordAdmission/recordCommit porque
 * HostEngineApi ya alimenta LiveAuthorMonitor dentro del flujo normal.
 *
 * El anfitrión debe usar onAdmission para conservar/reintentar en orden los
 * deltas rechazados; esta función no elimina ni reordena cambios.
 */
export function bindLiveAuthorMonitorEditorChanges(
  options: LiveAuthorMonitorChangeBindingOptions
): () => void {
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

  let disposed = false;
  const unsubscribe = options.source.subscribeChanges(change => {
    if (disposed) return;
    try {
      const admission = options.sink.onEditorChange(change);
      options.onAdmission(change, admission);
    } catch (error) {
      options.onError(error, change);
    }
  });

  if (typeof unsubscribe !== "function") {
    throw new TypeError("subscribeChanges debe devolver una función de cancelación.");
  }

  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
  };
}
