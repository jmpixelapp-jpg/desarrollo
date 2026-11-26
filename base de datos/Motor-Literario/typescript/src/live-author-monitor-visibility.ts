/**
 * Scheduler para el polling visual de las vistas del monitor.
 *
 * Coordina Page Visibility y Page Lifecycle (pagehide/pageshow, freeze/resume).
 * No toca los timers de persistencia ni los heartbeats del lease, que pertenecen al motor.
 */
export type LiveAuthorMonitorRefreshScheduler = (callback: () => void, intervalMs: number) => () => void;

const scheduleInterval: LiveAuthorMonitorRefreshScheduler = (callback, intervalMs) => {
  const handle = globalThis.setInterval(callback, intervalMs);
  return () => globalThis.clearInterval(handle);
};

/** Ejecuta refrescos periódicos solo mientras la página está activa y visible. */
export function scheduleLiveAuthorMonitorWhileVisible(
  document: Document, callback: () => void, intervalMs: number,
  schedule: LiveAuthorMonitorRefreshScheduler = scheduleInterval
): () => void {
  if (!document || typeof document.hidden !== "boolean" ||
      typeof document.addEventListener !== "function" || typeof document.removeEventListener !== "function") {
    // Incluso sin Page Visibility, un tick que ya entró en la cola del event loop
    // debe quedar invalidado después del desmontaje.
    let disposed = false;
    const guardedCallback = (): void => { if (!disposed) callback(); };
    const cancel = schedule(guardedCallback, intervalMs);
    if (typeof cancel !== "function") {
      disposed = true;
      throw new TypeError("El planificador debe devolver una función de cancelación.");
    }
    return () => {
      if (disposed) return;
      disposed = true;
      cancel();
    };
  }
  let disposed = false;
  let active = !document.hidden;
  let cancelInterval: (() => void) | undefined;
  const stopInterval = (): void => { const cancel = cancelInterval; cancelInterval = undefined; cancel?.(); };
  const startInterval = (): void => {
    if (disposed || !active || document.hidden || cancelInterval) return;
    const guardedCallback = (): void => { if (!disposed && active && !document.hidden) callback(); };
    const cancel = schedule(guardedCallback, intervalMs);
    if (typeof cancel !== "function") throw new TypeError("El planificador debe devolver una función de cancelación.");
    cancelInterval = cancel;
  };
  const suspend = (): void => { if (disposed || !active) return; active = false; stopInterval(); };
  const resume = (): void => {
    if (disposed || document.hidden || active) return;
    active = true;
    try { callback(); } finally { startInterval(); }
  };
  const onVisibilityChange: EventListener = () => { if (document.hidden) suspend(); else resume(); };
  const onSuspend: EventListener = () => suspend();
  const onResume: EventListener = () => resume();
  const documentListeners: readonly (readonly [string, EventListener])[] = [
    ["visibilitychange", onVisibilityChange], ["freeze", onSuspend], ["resume", onResume]
  ];
  const view = document.defaultView;
  const viewListeners: readonly (readonly [string, EventListener])[] = view ? [
    ["pagehide", onSuspend], ["pageshow", onResume]
  ] : [];
  try {
    for (const [type, listener] of documentListeners) document.addEventListener(type, listener);
    if (view) for (const [type, listener] of viewListeners) view.addEventListener(type, listener);
    startInterval();
  } catch (error) {
    for (const [type, listener] of viewListeners) { try { view?.removeEventListener(type, listener); } catch { /* Preserve original error. */ } }
    for (const [type, listener] of documentListeners) { try { document.removeEventListener(type, listener); } catch { /* Preserve original error. */ } }
    try { stopInterval(); } catch { /* Preserve original error. */ }
    throw error;
  }
  return () => {
    if (disposed) return;
    disposed = true;
    for (const [type, listener] of viewListeners) view?.removeEventListener(type, listener);
    try { for (const [type, listener] of documentListeners) document.removeEventListener(type, listener); }
    finally { stopInterval(); }
  };
}