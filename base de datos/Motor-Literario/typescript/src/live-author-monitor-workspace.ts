import {
  LIVE_AUTHOR_MONITOR_PANEL_STYLES,
  formatLiveAuthorMonitorCheckpointStatus,
  formatLiveAuthorMonitorLeaseStatus,
  formatLiveAuthorMonitorListenerErrorStatus,
  readLiveAuthorMonitorPersistenceDiagnosticsSafely,
  scheduleLiveAuthorMonitorWhileVisible
} from "./live-author-monitor-panel";
import type {
  LiveAuthorMonitorHostApi,
  LiveAuthorMonitorSnapshot
} from "./live-author-monitor";

export interface LiveAuthorMonitorWorkspaceOptions {
  /** Frecuencia de reconciliación completa; predeterminado: 1000 ms. */
  readonly intervalMs?: number;
  readonly title?: string;
  readonly locale?: string;
  /** Lista opcional de métricas compactas visibles por capítulo; por defecto todas. */
  readonly visibleMetrics?: readonly LiveAuthorMonitorWorkspaceMetric[];
  /** Etiqueta visual opcional para el ID del documento. */
  readonly getDocumentLabel?: (documentId: string) => string;
  /** El anfitrión cambia de capítulo desde esta callback; el motor no abre documentos aquí. */
  readonly onSelectDocument?: (documentId: string) => void;
  /** Planificador inyectable para ciclo de vida del anfitrión y pruebas. */
  readonly schedule?: (callback: () => void, intervalMs: number) => () => void;
}

export type LiveAuthorMonitorWorkspaceMetric = "wordsPerMinute" | "inserted" | "idle" | "pauses" | "pending" | "revision" | "commitP95" |
  "typing" | "paste" | "deletion" | "correction" | "undo" | "redo" | "other";
type CompactMetricKey = LiveAuthorMonitorWorkspaceMetric;
interface WorkspaceCard {
  readonly root: HTMLElement;
  readonly heading: HTMLElement;
  readonly status: HTMLElement;
  readonly statusText: HTMLElement;
  readonly values: ReadonlyMap<CompactMetricKey, HTMLElement>;
  readonly durability: HTMLElement;
  readonly persistence: HTMLElement;
  readonly coordination: HTMLElement;
  readonly listenerErrors: HTMLElement;
  readonly progress: HTMLElement;
  readonly progressTrack: HTMLElement;
  readonly openButton?: HTMLButtonElement;
}

const WORKSPACE_METRICS: readonly { readonly key: CompactMetricKey; readonly label: string }[] = [
  { key: "wordsPerMinute", label: "Palabras/min" },
  { key: "inserted", label: "Caracteres insertados" },
  { key: "typing", label: "Escritura" },
  { key: "paste", label: "Pegados" },
  { key: "deletion", label: "Borrados" },
  { key: "correction", label: "Correcciones" },
  { key: "undo", label: "Deshacer" },
  { key: "redo", label: "Rehacer" },
  { key: "other", label: "Otras operaciones" },
  { key: "idle", label: "Tiempo en pausa" },
  { key: "pauses", label: "Pausas detectadas" },
  { key: "pending", label: "Pendientes" },
  { key: "revision", label: "Revisión guardada / actual" },
  { key: "commitP95", label: "Latencia p95" }
];

function resolveVisibleWorkspaceMetrics(
  requested: readonly LiveAuthorMonitorWorkspaceMetric[] | undefined
): readonly (typeof WORKSPACE_METRICS)[number][] {
  if (requested === undefined) return WORKSPACE_METRICS;
  if (!Array.isArray(requested)) {
    throw new TypeError("visibleMetrics debe ser una lista de métricas del workspace.");
  }
  const definitions = new Map<string, (typeof WORKSPACE_METRICS)[number]>();
  for (const metric of WORKSPACE_METRICS) definitions.set(metric.key, metric);
  const selected = new Set<string>();
  const resolved: (typeof WORKSPACE_METRICS)[number][] = [];
  for (let index = 0; index < requested.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(requested, index)) {
      throw new TypeError("visibleMetrics no puede contener posiciones vacías.");
    }
    const key = requested[index];
    const definition = definitions.get(key);
    if (!definition) throw new RangeError("Métrica de workspace desconocida: " + String(key) + ".");
    if (selected.has(key)) throw new TypeError("visibleMetrics no puede repetir la métrica " + key + ".");
    selected.add(key);
    resolved.push(definition);
  }
  return resolved;
}

const WORKSPACE_STYLES = [
  ".ml-author-workspace{box-sizing:border-box;width:100%;color:#172033;background:#fff;border:1px solid #dbe2ea;border-radius:14px;padding:16px;font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}",
  ".ml-author-workspace *,.ml-author-workspace *:before,.ml-author-workspace *:after{box-sizing:border-box}",
  ".ml-author-workspace__header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}",
  ".ml-author-workspace__title{margin:0;font-size:16px;font-weight:700}",
  ".ml-author-workspace__count{color:#64748b;font-size:12px}",
  ".ml-author-workspace__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:10px}",
  ".ml-author-workspace__card{min-width:0;border:1px solid #e4e9ef;border-radius:11px;padding:12px;background:#fbfcfe}",
  ".ml-author-workspace__card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px}",
  ".ml-author-workspace__document{margin:0;font-size:13px;font-weight:700;overflow-wrap:anywhere}",
  ".ml-author-workspace__metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}",
  ".ml-author-workspace__metric{min-width:0}",
  ".ml-author-workspace__metric-label{display:block;color:#64748b;font-size:10px;line-height:1.3}",
  ".ml-author-workspace__metric-value{display:block;margin-top:2px;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}",
  ".ml-author-workspace__durability{margin:10px 0 0;color:#64748b;font-size:11px}",
  ".ml-author-workspace__open{margin-top:10px;border:1px solid #cbd5e1;border-radius:8px;padding:6px 10px;color:inherit;background:transparent;font:inherit;font-size:12px;font-weight:650;cursor:pointer}",
  ".ml-author-workspace__open:hover{background:#f1f5f9}",
  ".ml-author-workspace__empty{margin:0;padding:24px 12px;text-align:center;color:#64748b;font-size:13px}",
  "@media(prefers-color-scheme:dark){.ml-author-workspace{color:#e5eaf2;background:#151b26;border-color:#303b4b}.ml-author-workspace__card{background:#1b2431;border-color:#303b4b}.ml-author-workspace__count,.ml-author-workspace__metric-label,.ml-author-workspace__durability,.ml-author-workspace__empty{color:#a7b3c4}.ml-author-workspace__open{border-color:#526176}.ml-author-workspace__open:hover{background:#263244}}"
].join("\n");

function makeElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function compactStatus(state: LiveAuthorMonitorSnapshot["state"]): {
  readonly label: string;
  readonly className: string;
} {
  switch (state) {
    case "active": return { label: "Escribiendo", className: "ml-author-monitor__status--active" };
    case "idle": return { label: "En pausa", className: "ml-author-monitor__status--idle" };
    case "needs-resync": return {
      label: "Requiere resincronización",
      className: "ml-author-monitor__status--resync"
    };
  }
}

function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? pad(hours) + ":" + pad(minutes) + ":" + pad(seconds) : pad(minutes) + ":" + pad(seconds);
}

function metricValue(
  key: CompactMetricKey,
  snapshot: LiveAuthorMonitorSnapshot,
  integer: Intl.NumberFormat,
  decimal: Intl.NumberFormat
): string {
  switch (key) {
    case "wordsPerMinute": return decimal.format(snapshot.estimatedWordsPerMinute);
    case "inserted": return integer.format(snapshot.insertedCharacters);
    case "typing": return integer.format(snapshot.typingChanges);
    case "paste": return integer.format(snapshot.pasteChanges);
    case "deletion": return integer.format(snapshot.deletionChanges);
    case "correction": return integer.format(snapshot.correctionChanges);
    case "undo": return integer.format(snapshot.undoChanges);
    case "redo": return integer.format(snapshot.redoChanges);
    case "other": return integer.format(snapshot.otherChanges);
    case "idle": return formatDuration(snapshot.idleDurationMs);
    case "pauses": return integer.format(snapshot.pauseCount);
    case "pending": return integer.format(snapshot.pendingChanges);
    case "revision":
      return integer.format(snapshot.durableRevision) + " / " + integer.format(snapshot.latestRevision);
    case "commitP95": return decimal.format(snapshot.commitLatencyP95Ms) + " ms";
  }
}

function cardDurability(
  snapshot: LiveAuthorMonitorSnapshot,
  integer: Intl.NumberFormat
): string {
  if (snapshot.needsResync) return "El documento necesita resincronización.";
  if (snapshot.pendingChanges > 0) {
    return "Guardando " + integer.format(snapshot.pendingChanges) + " cambio(s).";
  }
  if (snapshot.durableSequence >= snapshot.latestSequence &&
      snapshot.durableRevision >= snapshot.latestRevision) {
    return "Todos los cambios admitidos están confirmados.";
  }
  return "Hay cambios pendientes de confirmación durable.";
}

function resolveDocumentLabel(
  documentId: string,
  getLabel: LiveAuthorMonitorWorkspaceOptions["getDocumentLabel"]
): string {
  if (!getLabel) return documentId;
  // El error se captura por documento en upsertSafely para mostrar un aviso
  // local sin propagarlo al ciclo de escritura.
  const label = getLabel(documentId);
  return typeof label === "string" && label.trim() ? label.trim() : documentId;
}

/**
 * Monta un monitor conjunto para todas las sesiones abiertas. Las tarjetas se
 * crean/actualizan al llegar eventos y se reconcilian con la lista autoritativa
 * en cada pulso, por lo que documentos cerrados desaparecen sin dejar vistas
 * obsoletas. No abre ni cierra capítulos: esas acciones pertenecen al anfitrión.
 */
export function mountLiveAuthorMonitorWorkspace(
  container: HTMLElement,
  hostApi: LiveAuthorMonitorHostApi,
  options: LiveAuthorMonitorWorkspaceOptions = {}
): () => void {
  if (!container || !container.ownerDocument) {
    throw new TypeError("El espacio de monitoreo requiere un contenedor DOM válido.");
  }
  const intervalMs = options.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60_000) {
    throw new RangeError("intervalMs debe estar entre 1 y 60000 milisegundos.");
  }

  const document = container.ownerDocument;
  const locale = options.locale ?? "es";
  const visibleMetrics = resolveVisibleWorkspaceMetrics(options.visibleMetrics);
  const title = options.title ?? "Documentos en escritura";
  const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const cards = new Map<string, WorkspaceCard>();
  // Mantiene fallos locales de render por documento mientras la tarjeta exista.
  const workspaceRenderErrors = new Map<string, number>();
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let cancelRefresh: (() => void) | undefined;

  const root = makeElement(document, "section", "ml-author-workspace");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", title);

  const style = makeElement(document, "style");
  style.textContent = LIVE_AUTHOR_MONITOR_PANEL_STYLES + "\n" + WORKSPACE_STYLES;
  root.append(style);

  const header = makeElement(document, "header", "ml-author-workspace__header");
  const heading = makeElement(document, "h2", "ml-author-workspace__title");
  heading.textContent = title;
  const count = makeElement(document, "span", "ml-author-workspace__count");
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");
  count.textContent = "0 documentos observados";
  header.append(heading, count);

  const grid = makeElement(document, "div", "ml-author-workspace__grid");
  grid.setAttribute("role", "list");
  const empty = makeElement(document, "p", "ml-author-workspace__empty");
  empty.textContent = "No hay documentos abiertos para monitorear.";
  root.append(header, empty, grid);
  container.append(root);

  const makeCard = (snapshot: LiveAuthorMonitorSnapshot): WorkspaceCard => {
    const cardRoot = makeElement(document, "article", "ml-author-workspace__card");
    cardRoot.setAttribute("role", "listitem");
    cardRoot.setAttribute("data-document-id", snapshot.documentId);
    const cardHead = makeElement(document, "div", "ml-author-workspace__card-head");
    const cardHeading = makeElement(document, "h3", "ml-author-workspace__document");
    const status = makeElement(document, "span", "ml-author-monitor__status");
    const dot = makeElement(document, "span", "ml-author-monitor__dot");
    dot.setAttribute("aria-hidden", "true");
    const statusText = makeElement(document, "span");
    status.setAttribute("role", "status");
    status.append(dot, statusText);
    cardHead.append(cardHeading, status);

    const metricGrid = makeElement(document, "div", "ml-author-workspace__metrics");
    metricGrid.setAttribute("role", "list");
    const values = new Map<CompactMetricKey, HTMLElement>();
    for (const metric of visibleMetrics) {
      const item = makeElement(document, "div", "ml-author-workspace__metric");
      item.setAttribute("role", "listitem");
      const label = makeElement(document, "span", "ml-author-workspace__metric-label");
      label.textContent = metric.label;
      const value = makeElement(document, "strong", "ml-author-workspace__metric-value");
      value.setAttribute("data-metric", metric.key);
      value.textContent = "—";
      item.append(label, value);
      metricGrid.append(item);
      values.set(metric.key, value);
    }

    const durability = makeElement(document, "p", "ml-author-workspace__durability");
    const persistence = makeElement(document, "p", "ml-author-monitor__diagnostic");
    persistence.setAttribute("data-diagnostic", "checkpoint");
    persistence.setAttribute("role", "status");
    persistence.setAttribute("aria-live", "polite");
    const coordination = makeElement(document, "p", "ml-author-monitor__diagnostic");
    coordination.setAttribute("data-diagnostic", "lease");
    coordination.setAttribute("role", "status");
    coordination.setAttribute("aria-live", "polite");
    const listenerErrors = makeElement(document, "p", "ml-author-monitor__diagnostic");
    listenerErrors.setAttribute("data-diagnostic", "listeners");
    listenerErrors.setAttribute("role", "status");
    listenerErrors.setAttribute("aria-live", "polite");
    const progressTrack = makeElement(document, "div", "ml-author-monitor__progress-track");
    progressTrack.setAttribute("role", "progressbar");
    progressTrack.setAttribute("aria-valuemin", "0");
    progressTrack.setAttribute("aria-valuemax", "100");
    progressTrack.setAttribute("aria-valuenow", "0");
    const progress = makeElement(document, "div", "ml-author-monitor__progress");
    progressTrack.append(progress);
    let openButton: HTMLButtonElement | undefined;
    if (options.onSelectDocument) {
      openButton = makeElement(document, "button", "ml-author-workspace__open");
      openButton.type = "button";
      openButton.textContent = "Abrir documento";
      openButton.addEventListener("click", () => {
        if (disposed) return;
        try { options.onSelectDocument?.(snapshot.documentId); } catch {
          // Un error al cambiar de capítulo no interrumpe el monitoreo de sesiones.
        }
      });
    }

    cardRoot.append(cardHead, metricGrid, durability, persistence, coordination, listenerErrors, progressTrack);
    if (openButton) cardRoot.append(openButton);
    grid.append(cardRoot);
    return {
      root: cardRoot,
      heading: cardHeading,
      status,
      statusText,
      values,
      durability,
      persistence,
      coordination,
      listenerErrors,
      progress,
      progressTrack,
      ...(openButton === undefined ? {} : { openButton })
    };
  };

  const updateCard = (snapshot: LiveAuthorMonitorSnapshot, card: WorkspaceCard): void => {
    card.heading.textContent = resolveDocumentLabel(snapshot.documentId, options.getDocumentLabel);
    const status = compactStatus(snapshot.state);
    card.status.className = "ml-author-monitor__status " + status.className;
    card.statusText.textContent = status.label;
    card.status.setAttribute("aria-label", "Estado de " + snapshot.documentId + ": " + status.label);
    for (const [key, node] of card.values) {
      node.textContent = metricValue(key, snapshot, integer, decimal);
    }
    card.durability.textContent = cardDurability(snapshot, integer);
    const diagnostics = readLiveAuthorMonitorPersistenceDiagnosticsSafely(hostApi, snapshot.documentId);
    card.persistence.textContent = formatLiveAuthorMonitorCheckpointStatus(diagnostics, locale);
    card.persistence.setAttribute("data-level", !diagnostics ? "warning" :
      diagnostics.checkpointState === "error" ? "error" :
        diagnostics.checkpointState === "waiting-for-durability" ? "warning" : "info");
    card.coordination.textContent = formatLiveAuthorMonitorLeaseStatus(diagnostics);
    card.coordination.setAttribute("data-level", !diagnostics ? "warning" :
      diagnostics.leaseState === "error" || diagnostics.leaseState === "lost" ||
        diagnostics.leaseState === "expired" ? "error" : "info");
    const viewErrors = workspaceRenderErrors.get(snapshot.documentId) ?? 0;
    card.listenerErrors.textContent = formatLiveAuthorMonitorListenerErrorStatus(
      snapshot, viewErrors, locale
    );
    card.listenerErrors.setAttribute("data-level",
      snapshot.listenerErrors + viewErrors > 0 ? "warning" : "info");
    const latest = Math.max(0, snapshot.latestSequence);
    const durable = Math.max(0, snapshot.durableSequence);
    const percentage = latest === 0 ? 100 : Math.max(0, Math.min(100, durable / latest * 100));
    card.progress.style.width = percentage.toFixed(1) + "%";
    card.progressTrack.setAttribute("aria-valuenow", String(Math.round(percentage)));
    card.progressTrack.setAttribute(
      "aria-label",
      "Confirmación durable de " + snapshot.documentId + ": " + Math.round(percentage) + " por ciento"
    );
  };

  const upsert = (snapshot: LiveAuthorMonitorSnapshot): void => {
    let card = cards.get(snapshot.documentId);
    if (!card) {
      card = makeCard(snapshot);
      cards.set(snapshot.documentId, card);
    }
    updateCard(snapshot, card);
  };

  const reportWorkspaceRenderError = (snapshot: LiveAuthorMonitorSnapshot): void => {
    const failures = (workspaceRenderErrors.get(snapshot.documentId) ?? 0) + 1;
    workspaceRenderErrors.set(snapshot.documentId, failures);
    const card = cards.get(snapshot.documentId);
    if (!card) return;
    try {
      card.listenerErrors.textContent = formatLiveAuthorMonitorListenerErrorStatus(
        snapshot, failures, locale
      );
      card.listenerErrors.setAttribute("data-level", "warning");
    } catch {
      // El aviso local tampoco debe interrumpir el resto del workspace.
    }
  };

  const upsertSafely = (snapshot: LiveAuthorMonitorSnapshot): void => {
    try {
      upsert(snapshot);
    } catch {
      reportWorkspaceRenderError(snapshot);
    }
  };

  const updateCount = (): void => {
    const total = cards.size;
    count.textContent = integer.format(total) + (total === 1 ? " documento observado" : " documentos observados");
    empty.hidden = total > 0;
    grid.hidden = total === 0;
  };

  const reconcile = (): void => {
    if (disposed) return;
    try {
      const snapshots = hostApi.getLiveAuthorMonitorSnapshots();
      const currentIds = new Set<string>();
      for (const snapshot of snapshots) {
        currentIds.add(snapshot.documentId);
        upsertSafely(snapshot);
      }
      for (const [documentId, card] of cards) {
        if (!currentIds.has(documentId)) {
          card.root.remove();
          cards.delete(documentId);
          workspaceRenderErrors.delete(documentId);
        }
      }
      updateCount();
    } catch {
      // Si la observabilidad falla, se conserva la última vista coherente.
    }
  };

  try {
    unsubscribe = hostApi.subscribeLiveAuthorMonitor(snapshot => {
      if (disposed) return;
      upsertSafely(snapshot);
      updateCount();
    });
    reconcile();
    const schedule = (callback: () => void, milliseconds: number) =>
      scheduleLiveAuthorMonitorWhileVisible(document, callback, milliseconds, options.schedule);
    cancelRefresh = schedule(reconcile, intervalMs);
    if (typeof cancelRefresh !== "function") {
      throw new TypeError("El planificador debe devolver una función de cancelación.");
    }
  } catch (error) {
    disposed = true;
    try { unsubscribe?.(); } catch { /* Conserva el error de montaje. */ }
    try { cancelRefresh?.(); } catch { /* Conserva el error de montaje. */ }
    root.remove();
    throw error;
  }

  return () => {
    if (disposed) return;
    disposed = true;
    try { unsubscribe?.(); } finally {
      try { cancelRefresh?.(); } finally {
        cards.clear();
        workspaceRenderErrors.clear();
        root.remove();
      }
    }
  };
}
