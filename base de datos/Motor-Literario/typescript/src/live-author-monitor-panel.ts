import {
  subscribeLiveAuthorMonitorWithRefresh,
  type LiveAuthorMonitorHostApi,
  type LiveAuthorMonitorSnapshot,
  type LiveAuthorMonitorPersistenceDiagnostics
} from "./live-author-monitor";

export interface LiveAuthorMonitorPanelOptions {
  readonly documentId: string;
  readonly intervalMs?: number;
  readonly title?: string;
  readonly locale?: string;
  readonly schedule?: (callback: () => void, intervalMs: number) => () => void;
}
type MetricKey = "session" | "active" | "idle" | "pauses" | "wordsPerMinute" | "charactersPerMinute" |
  "inserted" | "deleted" | "accepted" | "typing" | "paste" | "deletion" | "correction" |
  "undo" | "redo" | "other" | "committed" | "pending" | "failed" |
  "revision" | "commitP95";
interface MetricNode { readonly value: HTMLElement; }
interface PanelNodes {
  readonly status: HTMLElement;
  readonly statusText: HTMLElement;
  readonly durability: HTMLElement;
  readonly persistence: HTMLElement;
  readonly coordination: HTMLElement;
  readonly progress: HTMLElement;
  readonly progressTrack: HTMLElement;
  readonly metrics: ReadonlyMap<MetricKey, MetricNode>;
}
interface MetricDefinition { readonly key: MetricKey; readonly label: string; }

const METRICS: readonly MetricDefinition[] = [
  { key: "session", label: "Tiempo de sesión" },
  { key: "active", label: "Tiempo escribiendo" },
  { key: "idle", label: "Tiempo acumulado en pausa" },
  { key: "pauses", label: "Pausas detectadas" },
  { key: "wordsPerMinute", label: "Ritmo estimado (palabras/min)" },
  { key: "charactersPerMinute", label: "Ritmo (caracteres/min)" },
  { key: "inserted", label: "Caracteres insertados" },
  { key: "deleted", label: "Caracteres eliminados" },
  { key: "accepted", label: "Ediciones aceptadas" },
  { key: "typing", label: "Escritura" },
  { key: "paste", label: "Pegados" },
  { key: "deletion", label: "Borrados" },
  { key: "correction", label: "Correcciones" },
  { key: "undo", label: "Deshacer" },
  { key: "redo", label: "Rehacer" },
  { key: "other", label: "Otras operaciones" },
  { key: "committed", label: "Ediciones guardadas" },
  { key: "pending", label: "Ediciones pendientes" },
  { key: "failed", label: "Ediciones fallidas" },
  { key: "revision", label: "Revisión guardada / actual" },
  { key: "commitP95", label: "Latencia de guardado p95" }
];

/** Estilos autocontenidos: el anfitrión no necesita instalar CSS ni un framework. */
export const LIVE_AUTHOR_MONITOR_PANEL_STYLES = [
  ".ml-author-monitor{box-sizing:border-box;width:100%;color:#172033;background:#fff;border:1px solid #dbe2ea;border-radius:14px;padding:16px;font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}",
  ".ml-author-monitor *,.ml-author-monitor *:before,.ml-author-monitor *:after{box-sizing:border-box}",
  ".ml-author-monitor__header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}",
  ".ml-author-monitor__title{margin:0;font-size:16px;font-weight:700;letter-spacing:-.01em}",
  ".ml-author-monitor__status{display:inline-flex;align-items:center;gap:7px;min-height:28px;border-radius:999px;padding:4px 10px;background:#edf2f7;color:#334155;font-size:12px;font-weight:650}",
  ".ml-author-monitor__dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:0 0 auto}",
  ".ml-author-monitor__status--active{color:#087443;background:#e8f7ef}",
  ".ml-author-monitor__status--idle{color:#805b12;background:#fff6df}",
  ".ml-author-monitor__status--resync{color:#a12c35;background:#fff0f0}",
  ".ml-author-monitor__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:9px}",
  ".ml-author-monitor__metric{min-width:0;border:1px solid #e4e9ef;border-radius:10px;padding:10px 11px;background:#fbfcfe}",
  ".ml-author-monitor__label{display:block;margin-bottom:5px;color:#64748b;font-size:11px;line-height:1.35}",
  ".ml-author-monitor__value{display:block;color:#172033;font-size:17px;font-weight:700;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}",
  ".ml-author-monitor__durability{margin-top:14px;color:#475569;font-size:12px}",
  ".ml-author-monitor__diagnostic{margin:6px 0 0;color:#64748b;font-size:11px;overflow-wrap:anywhere}",
  ".ml-author-monitor__diagnostic[data-level=error]{color:#a12c35;font-weight:650}",
  ".ml-author-monitor__diagnostic[data-level=warning]{color:#805b12}",
  ".ml-author-monitor__progress-track{height:6px;overflow:hidden;margin-top:7px;border-radius:999px;background:#e8edf3}",
  ".ml-author-monitor__progress{width:0;height:100%;border-radius:inherit;background:#23835b;transition:width 160ms ease}",
  ".ml-author-monitor__note{margin:10px 0 0;color:#718096;font-size:11px}",
  "@media(prefers-color-scheme:dark){.ml-author-monitor{color:#e5eaf2;background:#151b26;border-color:#303b4b}.ml-author-monitor__title,.ml-author-monitor__value{color:#edf2f8}.ml-author-monitor__metric{background:#1b2431;border-color:#303b4b}.ml-author-monitor__label,.ml-author-monitor__note{color:#a7b3c4}.ml-author-monitor__durability{color:#c0cad8}.ml-author-monitor__progress-track{background:#303b4b}.ml-author-monitor__status{background:#273244;color:#d2dbea}.ml-author-monitor__status--active{color:#73d6a2;background:#183629}.ml-author-monitor__status--idle{color:#f0cb70;background:#3a301b}.ml-author-monitor__status--resync{color:#ff9a9f;background:#402327}}"
].join("\n");

function makeElement<K extends keyof HTMLElementTagNameMap>(
  document: Document, tag: K, className?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? pad(hours) + ":" + pad(minutes) + ":" + pad(seconds) : pad(minutes) + ":" + pad(seconds);
}
function formatMetric(
  key: MetricKey, snapshot: LiveAuthorMonitorSnapshot,
  integer: Intl.NumberFormat, decimal: Intl.NumberFormat
): string {
  switch (key) {
    case "session": return formatDuration(snapshot.sessionDurationMs);
    case "active": return formatDuration(snapshot.activeDurationMs);
    case "idle": return formatDuration(snapshot.idleDurationMs);
    case "pauses": return integer.format(snapshot.pauseCount);
    case "wordsPerMinute": return decimal.format(snapshot.estimatedWordsPerMinute);
    case "charactersPerMinute": return integer.format(snapshot.insertedCharactersPerMinute);
    case "inserted": return integer.format(snapshot.insertedCharacters);
    case "deleted": return integer.format(snapshot.deletedCharacters);
    case "accepted": return integer.format(snapshot.acceptedChanges);
    case "typing": return integer.format(snapshot.typingChanges);
    case "paste": return integer.format(snapshot.pasteChanges);
    case "deletion": return integer.format(snapshot.deletionChanges);
    case "correction": return integer.format(snapshot.correctionChanges);
    case "undo": return integer.format(snapshot.undoChanges);
    case "redo": return integer.format(snapshot.redoChanges);
    case "other": return integer.format(snapshot.otherChanges);
    case "committed": return integer.format(snapshot.committedChanges);
    case "pending": return integer.format(snapshot.pendingChanges);
    case "failed": return integer.format(snapshot.failedChanges);
    case "revision": return integer.format(snapshot.durableRevision) + " / " + integer.format(snapshot.latestRevision);
    case "commitP95": return decimal.format(snapshot.commitLatencyP95Ms) + " ms";
  }
}
function durabilityMessage(snapshot: LiveAuthorMonitorSnapshot, integer: Intl.NumberFormat): string {
  if (snapshot.needsResync) return "La sesión necesita resincronizarse con el documento anfitrión.";
  if (snapshot.pendingChanges > 0) {
    return "Guardando " + integer.format(snapshot.pendingChanges) + " cambio(s); la revisión durable todavía puede avanzar.";
  }
  if (snapshot.durableSequence >= snapshot.latestSequence &&
      snapshot.durableRevision >= snapshot.latestRevision) {
    return "Todos los cambios admitidos están confirmados.";
  }
  return "Hay cambios admitidos que todavía no están confirmados.";
}
/** Presenta estados operativos sin mostrar el mensaje interno del error. */
export function formatLiveAuthorMonitorCheckpointStatus(
  diagnostics: LiveAuthorMonitorPersistenceDiagnostics | undefined,
  locale = "es"
): string {
  if (!diagnostics) return "Persistencia: diagnóstico no disponible.";
  switch (diagnostics.checkpointState) {
    case "unavailable": return "Persistencia: el almacén no admite checkpoints de métricas.";
    case "not-saved": return "Persistencia: todavía no hay un checkpoint confirmado.";
    case "waiting-for-durability": return "Persistencia: espera a que los cambios queden durables y sincronizados.";
    case "saving": return "Persistencia: guardando las métricas de la sesión.";
    case "saved": {
      const at = diagnostics.lastCheckpointAt;
      return at === undefined ? "Persistencia: checkpoint guardado." :
        "Persistencia: checkpoint guardado; último guardado " + new Date(at).toLocaleString(locale) + ".";
    }
    case "error":
      return diagnostics.checkpointErrorCode === "QuotaExceededError"
        ? "Error de persistencia: se alcanzó la cuota de almacenamiento; las métricas no pudieron guardarse."
        : "Error de persistencia: no se pudieron guardar las métricas (" +
          (diagnostics.checkpointErrorCode ?? "UnknownError") + ").";
  }
}

export function formatLiveAuthorMonitorLeaseStatus(
  diagnostics: LiveAuthorMonitorPersistenceDiagnostics | undefined
): string {
  if (!diagnostics) return "Coordinación entre pestañas: estado no disponible.";
  switch (diagnostics.leaseState) {
    case "unsupported": return "Coordinación entre pestañas: no está disponible en este almacén.";
    case "uninitialized": return "Coordinación entre pestañas: pendiente de inicialización.";
    case "owner": return "Coordinación entre pestañas: esta pestaña posee el lease de persistencia.";
    case "observer": return "Coordinación entre pestañas: otra pestaña conserva el lease; esta pestaña observa.";
    case "lost": return "Coordinación entre pestañas: se perdió el lease; los guardados compartidos están suspendidos.";
    case "expired": return "Coordinación entre pestañas: el lease expiró y debe recuperarse.";
    case "releasing": return "Coordinación entre pestañas: liberando el lease.";
    case "error": return "Error de coordinación: no se pudo verificar el lease (" +
      (diagnostics.leaseErrorCode ?? "UnknownError") + ").";
  }
}

function updatePanel(
  nodes: PanelNodes, snapshot: LiveAuthorMonitorSnapshot,
  integer: Intl.NumberFormat, decimal: Intl.NumberFormat,
  diagnostics: LiveAuthorMonitorPersistenceDiagnostics | undefined,
  locale: string
): void {
  const statuses = {
    active: { label: "Escribiendo", className: "ml-author-monitor__status--active" },
    idle: { label: "En pausa", className: "ml-author-monitor__status--idle" },
    "needs-resync": { label: "Requiere resincronización", className: "ml-author-monitor__status--resync" }
  } as const;
  const current = statuses[snapshot.state];
  nodes.status.className = "ml-author-monitor__status " + current.className;
  nodes.statusText.textContent = current.label;
  nodes.status.setAttribute("aria-label", "Estado de actividad del autor: " + current.label);
  for (const [key, node] of nodes.metrics) {
    node.value.textContent = formatMetric(key, snapshot, integer, decimal);
  }
  nodes.durability.textContent = durabilityMessage(snapshot, integer);
  nodes.persistence.textContent = formatLiveAuthorMonitorCheckpointStatus(diagnostics, locale);
  nodes.persistence.setAttribute("data-level", diagnostics?.checkpointState === "error" ? "error" :
    diagnostics?.checkpointState === "waiting-for-durability" ? "warning" : "info");
  nodes.coordination.textContent = formatLiveAuthorMonitorLeaseStatus(diagnostics);
  nodes.coordination.setAttribute("data-level", diagnostics?.leaseState === "error" ||
    diagnostics?.leaseState === "lost" || diagnostics?.leaseState === "expired" ? "error" : "info");
  const latest = Math.max(0, snapshot.latestSequence);
  const durable = Math.max(0, snapshot.durableSequence);
  const percentage = latest === 0 ? 100 : Math.max(0, Math.min(100, durable / latest * 100));
  nodes.progress.style.width = percentage.toFixed(1) + "%";
  nodes.progressTrack.setAttribute("aria-valuenow", String(Math.round(percentage)));
  nodes.progressTrack.setAttribute(
    "aria-label", "Progreso de confirmación durable: " + Math.round(percentage) + " por ciento"
  );
}

/**
 * Monta un panel DOM sin dependencias de UI. Solo recibe snapshots de métricas,
 * no el texto del manuscrito. La cancelación no cierra el documento anfitrión.
 */
export function mountLiveAuthorMonitorPanel(
  container: HTMLElement,
  hostApi: LiveAuthorMonitorHostApi,
  options: LiveAuthorMonitorPanelOptions
): () => void {
  if (!container || !container.ownerDocument) {
    throw new TypeError("El panel requiere un contenedor DOM válido.");
  }
  if (typeof options.documentId !== "string" || !options.documentId.trim()) {
    throw new TypeError("documentId es obligatorio para montar el panel.");
  }
  const document = container.ownerDocument;
  const title = options.title ?? "Actividad del autor";
  const locale = options.locale ?? "es";
  const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });

  const root = makeElement(document, "section", "ml-author-monitor");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", title);
  const style = makeElement(document, "style");
  style.textContent = LIVE_AUTHOR_MONITOR_PANEL_STYLES;
  root.append(style);

  const header = makeElement(document, "header", "ml-author-monitor__header");
  const heading = makeElement(document, "h2", "ml-author-monitor__title");
  heading.textContent = title;
  const status = makeElement(document, "span", "ml-author-monitor__status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const dot = makeElement(document, "span", "ml-author-monitor__dot");
  dot.setAttribute("aria-hidden", "true");
  const statusText = makeElement(document, "span");
  statusText.textContent = "Esperando actividad";
  status.append(dot, statusText);
  header.append(heading, status);

  const grid = makeElement(document, "div", "ml-author-monitor__grid");
  const metricNodes = new Map<MetricKey, MetricNode>();
  for (const metric of METRICS) {
    const card = makeElement(document, "div", "ml-author-monitor__metric");
    const label = makeElement(document, "span", "ml-author-monitor__label");
    label.textContent = metric.label;
    const value = makeElement(document, "strong", "ml-author-monitor__value");
    value.textContent = "—";
    value.setAttribute("data-metric", metric.key);
    card.append(label, value);
    grid.append(card);
    metricNodes.set(metric.key, { value });
  }

  const durability = makeElement(document, "p", "ml-author-monitor__durability");
  durability.textContent = "Esperando el primer snapshot de actividad.";
  const persistence = makeElement(document, "p", "ml-author-monitor__diagnostic");
  persistence.setAttribute("data-diagnostic", "checkpoint");
  persistence.setAttribute("role", "status");
  persistence.setAttribute("aria-live", "polite");
  const coordination = makeElement(document, "p", "ml-author-monitor__diagnostic");
  coordination.setAttribute("data-diagnostic", "lease");
  coordination.setAttribute("role", "status");
  coordination.setAttribute("aria-live", "polite");
  const progressTrack = makeElement(document, "div", "ml-author-monitor__progress-track");
  progressTrack.setAttribute("role", "progressbar");
  progressTrack.setAttribute("aria-valuemin", "0");
  progressTrack.setAttribute("aria-valuemax", "100");
  progressTrack.setAttribute("aria-valuenow", "0");
  const progress = makeElement(document, "div", "ml-author-monitor__progress");
  progressTrack.append(progress);
  const note = makeElement(document, "p", "ml-author-monitor__note");
  note.textContent = "Métricas locales de esta sesión. El contenido del manuscrito no se muestra ni se transmite.";
  root.append(header, grid, durability, persistence, coordination, progressTrack, note);
  container.append(root);

  const nodes: PanelNodes = {
    status, statusText, durability, persistence, coordination, progress, progressTrack, metrics: metricNodes
  };
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = subscribeLiveAuthorMonitorWithRefresh(hostApi, snapshot => {
      if (!disposed) updatePanel(
        nodes, snapshot, integer, decimal,
        hostApi.getLiveAuthorMonitorPersistenceDiagnostics?.(options.documentId),
        locale
      );
    }, {
      documentId: options.documentId,
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      ...(options.schedule === undefined ? {} : { schedule: options.schedule })
    });
  } catch (error) {
    disposed = true;
    root.remove();
    throw error;
  }
  return () => {
    if (disposed) return;
    disposed = true;
    try { unsubscribe?.(); } finally { root.remove(); }
  };
}
