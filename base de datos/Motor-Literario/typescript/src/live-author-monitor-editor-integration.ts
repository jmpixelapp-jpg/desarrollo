import {
  mountLiveAuthorMonitorPanel
} from "./live-author-monitor-panel";
import type {
  LiveAuthorMonitorPanelOptions
} from "./live-author-monitor-panel";
import type {
  LiveAuthorMonitorHostApi
} from "./live-author-monitor";
import {
  mountLiveAuthorMonitorWorkspace
} from "./live-author-monitor-workspace";
import type {
  LiveAuthorMonitorWorkspaceOptions
} from "./live-author-monitor-workspace";

/**
 * Contrato mínimo que expone el anfitrión para conocer y cambiar la pestaña
 * activa. El motor sigue recibiendo las ediciones por HostEngineApi.onEditorChange.
 */
export interface LiveAuthorMonitorEditorSelection {
  getActiveDocumentId(): string | undefined;
  subscribeActiveDocument(listener: (documentId: string | undefined) => void): () => void;
  activateDocument(documentId: string): void;
}

export interface LiveAuthorMonitorEditorIntegrationOptions {
  readonly hostApi: LiveAuthorMonitorHostApi;
  readonly editor: LiveAuthorMonitorEditorSelection;
  readonly workspaceContainer: HTMLElement;
  readonly activeDocumentContainer: HTMLElement;
  readonly intervalMs?: number;
  readonly locale?: string;
  readonly workspaceTitle?: string;
  readonly activeDocumentTitle?: string;
  readonly getDocumentLabel?: (documentId: string) => string;
  readonly schedule?: (callback: () => void, intervalMs: number) => () => void;
  readonly onPanelError?: (error: unknown, documentId: string) => void;
}

/**
 * Conecta el tablero multi-documento y el panel detallado de la pestaña activa.
 *
 * Al cambiar de pestaña, solo se desmonta el panel detallado anterior; las
 * tarjetas de los demás documentos siguen vivas. La callback de selección del
 * tablero delega el cambio al editor anfitrión. No duplica onEditorChange,
 * no abre/cierra documentos y no dispone HostEngineApi.
 */
export function mountLiveAuthorMonitorEditorIntegration(
  options: LiveAuthorMonitorEditorIntegrationOptions
): () => void {
  if (!options.workspaceContainer || !options.workspaceContainer.ownerDocument ||
      !options.activeDocumentContainer || !options.activeDocumentContainer.ownerDocument) {
    throw new TypeError("La integración requiere dos contenedores DOM válidos.");
  }
  if (options.workspaceContainer === options.activeDocumentContainer) {
    throw new TypeError("El tablero y el panel activo deben usar contenedores separados.");
  }
  if (!options.editor ||
      typeof options.editor.getActiveDocumentId !== "function" ||
      typeof options.editor.subscribeActiveDocument !== "function" ||
      typeof options.editor.activateDocument !== "function") {
    throw new TypeError("El anfitrión debe implementar el contrato de selección de documentos.");
  }

  const intervalMs = options.intervalMs ?? 1_000;
  let disposed = false;
  let activeDocumentId: string | undefined;
  let unmountActivePanel: (() => void) | undefined;
  let unsubscribeSelection: (() => void) | undefined;
  let unmountWorkspace: (() => void) | undefined;

  const reportPanelError = (error: unknown, documentId: string): void => {
    try { options.onPanelError?.(error, documentId); } catch {
      // Un callback de observabilidad no debe interrumpir la navegación del editor.
    }
  };

  const switchActiveDocument = (candidate: string | undefined): void => {
    if (disposed) return;
    const nextDocumentId = typeof candidate === "string" && candidate.trim()
      ? candidate
      : undefined;
    if (nextDocumentId === activeDocumentId) return;

    try { unmountActivePanel?.(); } catch {
      // El nuevo capítulo debe poder mostrarse aunque falle el desmontaje anterior.
    }
    unmountActivePanel = undefined;
    activeDocumentId = nextDocumentId;
    if (nextDocumentId === undefined) return;

    try {
      if (!options.hostApi.getLiveAuthorMonitorSnapshot(nextDocumentId)) {
        const ensureSession = options.hostApi.ensureLiveAuthorMonitorDocument;
        if (typeof ensureSession !== "function") {
          throw new Error("El anfitrión debe implementar ensureLiveAuthorMonitorDocument para reanudar una sesión cerrada.");
        }
        ensureSession.call(options.hostApi, nextDocumentId);
      }

      const panelOptions: LiveAuthorMonitorPanelOptions = {
        documentId: nextDocumentId,
        title: options.activeDocumentTitle ?? "Actividad del capítulo activo",
        ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
        ...(options.locale === undefined ? {} : { locale: options.locale }),
        ...(options.schedule === undefined ? {} : { schedule: options.schedule })
      };
      unmountActivePanel = mountLiveAuthorMonitorPanel(
        options.activeDocumentContainer,
        options.hostApi,
        panelOptions
      );
    } catch (error) {
      activeDocumentId = undefined;
      reportPanelError(error, nextDocumentId);
    }
  };

  try {
    const workspaceOptions: LiveAuthorMonitorWorkspaceOptions = {
      title: options.workspaceTitle ?? "Documentos abiertos",
      onSelectDocument: documentId => options.editor.activateDocument(documentId),
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      ...(options.getDocumentLabel === undefined ? {} : { getDocumentLabel: options.getDocumentLabel }),
      ...(options.schedule === undefined ? {} : { schedule: options.schedule })
    };
    unmountWorkspace = mountLiveAuthorMonitorWorkspace(
      options.workspaceContainer,
      options.hostApi,
      workspaceOptions
    );

    unsubscribeSelection = options.editor.subscribeActiveDocument(switchActiveDocument);
    if (typeof unsubscribeSelection !== "function") {
      throw new TypeError("La suscripción de pestaña activa debe devolver una función de cancelación.");
    }
    // La suscripción se registra antes de leer el valor inicial para no perder cambios.
    switchActiveDocument(options.editor.getActiveDocumentId());
  } catch (error) {
    disposed = true;
    try { unsubscribeSelection?.(); } catch { /* Conserva el error de montaje. */ }
    try { unmountActivePanel?.(); } catch { /* Conserva el error de montaje. */ }
    try { unmountWorkspace?.(); } catch { /* Conserva el error de montaje. */ }
    throw error;
  }

  return () => {
    if (disposed) return;
    disposed = true;
    try { unsubscribeSelection?.(); } finally {
      try { unmountActivePanel?.(); } finally {
        unmountActivePanel = undefined;
        activeDocumentId = undefined;
        unmountWorkspace?.();
        unmountWorkspace = undefined;
      }
    }
  };
}
