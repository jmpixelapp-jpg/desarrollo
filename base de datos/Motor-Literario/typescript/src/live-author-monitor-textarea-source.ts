import type { DocumentSnapshot, EditorChange } from "./contracts";
import type { LiveAuthorMonitorEditorChangeSource } from "./live-author-monitor-change-binding";

export type LiveAuthorMonitorTextAreaErrorCode =
  | "invalid-initial-snapshot"
  | "document-mismatch"
  | "missing-beforeinput"
  | "missing-input"
  | "invalid-selection"
  | "unsupported-input-type"
  | "composition-state-mismatch"
  | "input-type-mismatch"
  | "inconsistent-length"
  | "resync-required";

export class LiveAuthorMonitorTextAreaSourceError extends Error {
  readonly code: LiveAuthorMonitorTextAreaErrorCode;

  constructor(code: LiveAuthorMonitorTextAreaErrorCode, message: string) {
    super(message);
    this.name = "LiveAuthorMonitorTextAreaSourceError";
    this.code = code;
  }
}

export interface LiveAuthorMonitorTextAreaSourceOptions {
  readonly element: HTMLTextAreaElement;
  /** Snapshot autoritativo usado al abrir el documento. No se conserva. */
  readonly initialSnapshot: DocumentSnapshot;
  readonly onError?: (error: LiveAuthorMonitorTextAreaSourceError) => void;
}

export interface LiveAuthorMonitorTextAreaSourceState {
  readonly documentId: string;
  readonly revision: number;
  readonly sequence: number;
  readonly documentLength: number;
  readonly compositionActive: boolean;
  readonly needsResync: boolean;
}

interface BeforeInputState {
  readonly start: number;
  readonly end: number;
  readonly previousLength: number;
  readonly inputType: string;
  readonly isComposing: boolean;
}

/**
 * Convierte eventos nativos beforeinput/input de un textarea en deltas del motor.
 * Solo conserva longitud, revisión y secuencia; no mantiene una copia sombra
 * del manuscrito. Todos los offsets siguen la convención UTF-16 del navegador.
 *
 * historyUndo/historyRedo requieren el adaptador de historial del editor:
 * el stream se suspende antes de inventar un rango que el navegador no expone.
 */
export class LiveAuthorMonitorTextAreaSource implements LiveAuthorMonitorEditorChangeSource {
  private readonly element: HTMLTextAreaElement;
  private readonly documentId: string;
  private readonly onError: ((error: LiveAuthorMonitorTextAreaSourceError) => void) | undefined;
  private readonly listeners = new Set<(change: EditorChange) => void>();
  private revision: number;
  private sequence: number;
  private documentLength: number;
  private needsResync = false;
  private disposed = false;
  private compositionActive = false;
  private pendingInput: BeforeInputState | undefined;

  private readonly handleBeforeInput = (event: Event): void => {
    if (this.disposed || this.needsResync) return;
    if (this.pendingInput) {
      this.fail(
        "missing-input",
        "Se recibió un nuevo beforeinput antes de completar el input anterior; no se puede asociar con seguridad el cambio al rango capturado."
      );
      return;
    }
    const input = event as InputEvent;
    if (input.defaultPrevented) {
      this.pendingInput = undefined;
      return;
    }

    const inputType = typeof input.inputType === "string" ? input.inputType : "";
    if (input.isComposing === true) this.compositionActive = true;
    const isComposing = this.compositionActive || input.isComposing === true;
    if (inputType === "insertCompositionText" && !isComposing) {
      this.fail(
        "composition-state-mismatch",
        "Se recibió insertCompositionText fuera de una composición activa; se requiere resincronización."
      );
      return;
    }

    const start = this.element.selectionStart;
    const end = this.element.selectionEnd;
    const previousLength = this.element.value.length;
    if (start === null || end === null || start < 0 || end < start ||
        end > previousLength || previousLength !== this.documentLength) {
      this.fail(
        "invalid-selection",
        "No se pudo capturar una selección coherente antes de la edición; el documento necesita resincronización."
      );
      return;
    }

    this.pendingInput = {
      start,
      end,
      previousLength,
      inputType,
      isComposing
    };
  };

  private readonly handleCompositionStart = (): void => {
    if (this.disposed || this.needsResync) return;
    if (this.pendingInput) {
      this.fail(
        "composition-state-mismatch",
        "La composición comenzó antes de completar el input pendiente."
      );
      return;
    }
    this.compositionActive = true;
  };

  private readonly handleCompositionEnd = (): void => {
    if (this.disposed) return;
    // Algunos navegadores despachan compositionend antes del input final.
    // No invalidamos el beforeinput pendiente: el input que lo completa sigue
    // siendo la evidencia necesaria para publicar el delta.
    this.compositionActive = false;
  };

  private readonly handleInput = (event: Event): void => {
    if (this.disposed || this.needsResync) return;
    const before = this.pendingInput;
    this.pendingInput = undefined;
    if (!before) {
      this.fail(
        "missing-beforeinput",
        "Se recibió input sin su beforeinput correspondiente; no se inventará un rango de edición."
      );
      return;
    }

    const input = event as InputEvent;
    if (typeof input.inputType === "string" && input.inputType &&
        input.inputType !== before.inputType) {
      this.fail(
        "input-type-mismatch",
        "El inputType de input no coincide con el beforeinput asociado; se requiere resincronización."
      );
      return;
    }

    if ((before.inputType === "insertCompositionText" && !before.isComposing) ||
        (input.isComposing === true && !before.isComposing)) {
      this.fail(
        "composition-state-mismatch",
        "El estado de composición cambió entre beforeinput e input; no se enviará un delta ambiguo."
      );
      return;
    }

    if (before.inputType === "historyUndo" || before.inputType === "historyRedo") {
      this.fail(
        "unsupported-input-type",
        "Deshacer/rehacer requiere el adaptador de historial del editor para producir deltas autoritativos."
      );
      return;
    }
    if (!before.inputType ||
        (!before.inputType.startsWith("insert") && !before.inputType.startsWith("delete"))) {
      this.fail(
        "unsupported-input-type",
        "El navegador no identificó una operación de inserción o eliminación compatible."
      );
      return;
    }

    const value = this.element.value;
    const deltaLength = value.length - before.previousLength;
    let start = before.start;
    let end = before.end;
    let insertedLength: number;

    if (before.start === before.end && deltaLength < 0) {
      const removedLength = -deltaLength;
      if (before.inputType.includes("Backward")) {
        if (removedLength > before.start) {
          this.fail("inconsistent-length", "La eliminación hacia atrás excede el prefijo disponible.");
          return;
        }
        start = before.start - removedLength;
        end = before.start;
      } else if (before.inputType.includes("Forward")) {
        start = before.start;
        end = before.start + removedLength;
        if (end > before.previousLength) {
          this.fail("inconsistent-length", "La eliminación hacia delante excede el sufijo disponible.");
          return;
        }
      } else {
        this.fail(
          "unsupported-input-type",
          "La dirección de una eliminación sin selección no está disponible en beforeinput."
        );
        return;
      }
      insertedLength = 0;
    } else {
      insertedLength = (before.end - before.start) + deltaLength;
      if (!Number.isSafeInteger(insertedLength) || insertedLength < 0) {
        this.fail(
          "inconsistent-length",
          "La longitud resultante no coincide con el rango capturado antes de la edición."
        );
        return;
      }
    }

    if (start < 0 || end < start || end > before.previousLength ||
        insertedLength > value.length - start ||
        value.length !== before.previousLength + deltaLength) {
      this.fail(
        "inconsistent-length",
        "El valor del textarea no permite reconstruir un único delta seguro."
      );
      return;
    }
    if (this.sequence >= Number.MAX_SAFE_INTEGER || this.revision >= Number.MAX_SAFE_INTEGER) {
      this.fail("resync-required", "La secuencia o revisión alcanzó el límite entero seguro de JavaScript.");
      return;
    }

    // inputType informa el mecanismo del navegador, no siempre la intención.
    // Drop y yank no se etiquetan como pegado/corrección sin evidencia específica.
    const activityKind = before.inputType === "insertFromPaste" ||
      before.inputType === "insertFromPasteAsQuotation"
      ? "paste" as const
      : before.inputType === "insertReplacementText"
        ? "correction" as const
        : before.inputType.startsWith("delete") ? "deletion" as const
          : before.inputType === "insertFromDrop" || before.inputType === "insertFromYank"
            ? "other" as const : undefined;
    const change: EditorChange = Object.freeze({
      documentId: this.documentId,
      sequence: this.sequence + 1,
      baseRevision: this.revision,
      start,
      end,
      replacement: value.slice(start, start + insertedLength),
      ...(activityKind === undefined ? {} : { activityKind })
    });

    this.sequence = change.sequence;
    this.revision++;
    this.documentLength = value.length;

    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.report(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  constructor(options: LiveAuthorMonitorTextAreaSourceOptions) {
    if (!options || !options.element || typeof options.element.value !== "string" ||
        typeof options.element.addEventListener !== "function" ||
        typeof options.element.removeEventListener !== "function") {
      throw new TypeError("element debe ser un HTMLTextAreaElement válido.");
    }

    const snapshot = options.initialSnapshot;
    if (!snapshot || typeof snapshot.documentId !== "string" || !snapshot.documentId.trim() ||
        typeof snapshot.text !== "string" ||
        !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
        !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) {
      throw new LiveAuthorMonitorTextAreaSourceError(
        "invalid-initial-snapshot",
        "El snapshot inicial del textarea no es válido."
      );
    }
    if (options.element.value !== snapshot.text) {
      throw new LiveAuthorMonitorTextAreaSourceError(
        "document-mismatch",
        "El contenido visible del textarea debe coincidir con el snapshot autoritativo inicial."
      );
    }

    this.element = options.element;
    this.documentId = snapshot.documentId;
    this.revision = snapshot.revision;
    this.sequence = snapshot.sequence;
    this.documentLength = snapshot.text.length;
    this.onError = options.onError;
  }

  subscribeChanges(listener: (change: EditorChange) => void): () => void {
    if (this.disposed) throw new Error("No se puede suscribir un adaptador ya dispuesto.");
    if (typeof listener !== "function") throw new TypeError("listener debe ser una función.");

    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.element.addEventListener("beforeinput", this.handleBeforeInput);
      this.element.addEventListener("input", this.handleInput);
      this.element.addEventListener("compositionstart", this.handleCompositionStart);
      this.element.addEventListener("compositionend", this.handleCompositionEnd);
    }

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.element.removeEventListener("beforeinput", this.handleBeforeInput);
        this.element.removeEventListener("input", this.handleInput);
        this.element.removeEventListener("compositionstart", this.handleCompositionStart);
        this.element.removeEventListener("compositionend", this.handleCompositionEnd);
        this.pendingInput = undefined;
        this.compositionActive = false;
      }
    };
  }

  getState(): LiveAuthorMonitorTextAreaSourceState {
    return Object.freeze({
      documentId: this.documentId,
      revision: this.revision,
      sequence: this.sequence,
      documentLength: this.documentLength,
      compositionActive: this.compositionActive,
      needsResync: this.needsResync
    });
  }

  /** Reanuda el stream solo si el textarea coincide con el snapshot autoritativo. */
  resynchronize(snapshot: DocumentSnapshot): LiveAuthorMonitorTextAreaSourceState {
    if (this.disposed) throw new Error("No se puede resincronizar un adaptador ya dispuesto.");
    if (!snapshot || snapshot.documentId !== this.documentId ||
        typeof snapshot.text !== "string" ||
        !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
        !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) {
      throw new LiveAuthorMonitorTextAreaSourceError(
        "invalid-initial-snapshot",
        "El snapshot de resincronización no es válido para este documento."
      );
    }
    if (this.element.value !== snapshot.text) {
      throw new LiveAuthorMonitorTextAreaSourceError(
        "document-mismatch",
        "No se puede reanudar: el textarea aún no coincide con el snapshot autoritativo."
      );
    }

    this.revision = snapshot.revision;
    this.sequence = snapshot.sequence;
    this.documentLength = snapshot.text.length;
    this.pendingInput = undefined;
    this.compositionActive = false;
    this.needsResync = false;
    return this.getState();
  }

  /** Suspende explícitamente la captura tras una admisión no recuperable. */
  requireResynchronization(reason = "El anfitrión solicitó resincronizar el editor."): void {
    if (this.disposed) return;
    this.fail("resync-required", reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.element.removeEventListener("beforeinput", this.handleBeforeInput);
    this.element.removeEventListener("input", this.handleInput);
    this.element.removeEventListener("compositionstart", this.handleCompositionStart);
    this.element.removeEventListener("compositionend", this.handleCompositionEnd);
    this.listeners.clear();
    this.pendingInput = undefined;
    this.compositionActive = false;
  }

  private fail(code: LiveAuthorMonitorTextAreaErrorCode, message: string): void {
    this.needsResync = true;
    this.pendingInput = undefined;
    this.compositionActive = false;
    this.report(new LiveAuthorMonitorTextAreaSourceError(code, message));
  }

  private report(error: Error): void {
    try {
      this.onError?.(error instanceof LiveAuthorMonitorTextAreaSourceError
        ? error
        : new LiveAuthorMonitorTextAreaSourceError("resync-required", error.message));
    } catch {
      // Un panel de diagnóstico no debe interrumpir el flujo de edición del navegador.
    }
  }
}
