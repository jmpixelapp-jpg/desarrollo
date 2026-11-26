/**
 * Scheduler para el polling visual de las vistas del monitor.
 *
 * Suspende los intervalos mientras el documento del navegador está oculto y
 * fuerza una reconciliación inmediata al volver a primer plano. No toca los
 * timers de persistencia ni los heartbeats del lease, que pertenecen al motor.
 */
export type LiveAuthorMonitorRefreshScheduler = (callback: () => void, intervalMs: number) => () => void;

const scheduleInterval: LiveAuthorMonitorRefreshScheduler = (callback, intervalMs) => {
  const handle = globalThis.setInterval(callback, intervalMs);
  return () => globalThis.clearInterval(handle);
};

/**
 * Ejecuta refrescos periódicos solo mientras la pestaña está visible.
 * El scheduler se puede inyectar para usar un reloj determinista en pruebas.
 * En entornos sin Page Visibility API se mantiene el polling convencional.
 */
export function scheduleLiveAuthorMonitorWhileVisible(
  document: Document,
  callback: () => void,
  intervalMs: number,
  schedule: LiveAuthorMonitorRefreshScheduler = scheduleInterval
): () => void {
  if (!document || typeof document.hidden !== "boolean" ||
      typeof document.addEventListener !== "function" ||
      typeof document.removeEventListener !== "function") {
    return schedule(callback, intervalMs);
  }
  let disposed = false;
  let cancelInterval: (() => void) | undefined;
  const stopInterval = (): void => {
    const cancel = cancelInterval;
    cancelInterval = undefined;
    cancel?.();
  };
  const startInterval = (): void => {
    if (disposed || document.hidden || cancelInterval) return;
    const guardedCallback = (): void => {
      if (!disposed && !document.hidden) callback();
    };
    const cancel = schedule(guardedCallback, intervalMs);
    if (typeof cancel !== "function") throw new TypeError("El planificador debe devolver una función de cancelación.");
    cancelInterval = cancel;
  };
  const onVisibilityChange = (): void => {
    if (disposed) return;
    if (document.hidden) { stopInterval(); return; }
    try { callback(); } finally { startInterval(); }
  };
  try {
    document.addEventListener("visibilitychange", onVisibilityChange);
    startInterval();
  } catch (error) {
    try { document.removeEventListener("visibilitychange", onVisibilityChange); } catch { /* Preserve original error. */ }
    try { stopInterval(); } catch { /* Preserve original error. */ }
    throw error;
  }
  return () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    stopInterval();
  };
}