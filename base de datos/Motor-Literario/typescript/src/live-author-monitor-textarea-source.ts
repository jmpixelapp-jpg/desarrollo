import type { DocumentSnapshot, EditorChange } from "./contracts";
import type { LiveAuthorMonitorEditorChangeSource } from "./live-author-monitor-change-binding";

export type LiveAuthorMonitorTextAreaErrorCode =
  | "invalid-initial-snapshot"
  | "document-mismatch"
  | "missing-beforeinput"
  | "missing-input"
  | "invalid-selection"
  | "untrusted-event"
  | "unsupported-input-type"
  | "composition-state-mismatch"
  | "input-type-mismatch"
  | "input-data-mismatch"
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
  /** Snapshot autoritativo; su texto se mantiene solo como referencia efímera en memoria. */
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
  readonly inputData: string | null;
  readonly isComposing: boolean;
}

/**
 * Convierte eventos nativos beforeinput/input de un textarea en deltas del motor.
 * Mantiene una copia sombra efímera en memoria para comprobar el contexto
 * anterior y posterior a cada edición. No la persiste ni la incluye en diagnósticos.
 * Solo acepta eventos DOM confiables (isTrusted=true); los eventos sintéticos
 * requieren un adaptador transaccional explícito del editor.
 * Todos los offsets siguen la convención UTF-16 del navegador.
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
  /** Snapshot efímero en memoria para verificar prefijo/sufijo y detectar mutaciones externas. */
  private previousText: string;
  private needsResync = false;
  private disposed = false;
  private compositionActive = false;
  private pendingInput: BeforeInputState | undefined;

  private readonly handleBeforeInput = (event: Event): void => {
    if (this.disposed || this.needsResync) return;
    const input = event as InputEvent;
    if (input.isTrusted !== true) {
      this.fail(
        "untrusted-event",
        "Se rechazó un beforeinput sintético o no confiable; la captura nativa solo acepta eventos originados por el navegador."
      );
      return;
    }
    if (this.pendingInput) {
      this.fail(
        "missing-input",
        "Se recibió un nuevo beforeinput antes de completar el input anterior; no se puede asociar con seguridad el cambio al rango capturado."
      );
      return;
    }

    // No basta con comparar la longitud: una mutación programática de igual
    // tamaño dentro de la selección podría desaparecer al escribir encima.
    // El snapshot debe coincidir íntegramente ANTES de capturar cada intención.
    if (this.element.value !== this.previousText ||
        this.element.value.length !== this.documentLength) {
      this.fail(
        "resync-required",
        "El contenido del textarea cambió fuera de una secuencia observada completa; se requiere un snapshot autoritativo."
      );
      return;
    }

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
      inputData: typeof input.data === "string" ? input.data : null,
      isComposing
    };
  };

  private readonly handleCompositionStart = (event: Event): void => {
    if (this.disposed || this.needsResync) return;
    if (event.isTrusted !== true) {
      this.fail(
        "untrusted-event",
        "Se rechazó un compositionstart sintético o no confiable."
      );
      return;
    }
    if (this.pendingInput) {
      this.fail(
        "composition-state-mismatch",
        "La composición comenzó antes de completar el input pendiente."
      );
      return;
    }
    this.compositionActive = true;
  };

  private readonly handleCompositionEnd = (event: Event): void => {
    if (this.disposed) return;
    if (event.isTrusted !== true) {
      this.fail(
        "untrusted-event",
        "Se rechazó un compositionend sintético o no confiable."
      );
      return;
    }
    // Algunos navegadores despachan compositionend antes del input final.
    // No invalidamos el beforeinput pendiente: el input que lo completa sigue
    // siendo la evidencia necesaria para publicar el delta.
    this.compositionActive = false;
  };

  private readonly handleInput = (event: Event): void => {
    if (this.disposed || this.needsResync) return;
    const input = event as InputEvent;
    if (input.isTrusted !== true) {
      this.fail(
        "untrusted-event",
        "Se rechazó un input sintético o no confiable; la edición debe confirmarse con eventos nativos."
      );
      return;
    }
    const before = this.pendingInput;
    this.pendingInput = undefined;
    if (!before) {
      this.fail(
        "missing-beforeinput",
        "Se recibió input sin su beforeinput correspondiente; no se inventará un rango de edición."
      );
      return;
    }

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
    const previousText = this.previousText;
    if (previousText.length !== before.previousLength || previousText.length !== this.documentLength) {
      this.fail("inconsistent-length", "El snapshot efímero anterior no coincide con la longitud capturada.");
      return;
    }
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

    // Si beforeinput e input exponen contenido, ambas declaraciones deben
    // coincidir. Si solo uno proporciona data, se usa como evidencia disponible.
    // Nunca se incluyen esos valores en el diagnóstico.
    const inputData = typeof input.data === "string" ? input.data : null;
    if (before.inputData !== null && inputData !== null &&
        before.inputData !== inputData) {
      this.fail(
        "input-data-mismatch",
        "Los datos declarados por beforeinput e input no coinciden; se requiere resincronización."
      );
      return;
    }

    const insertedText = value.slice(start, start + insertedLength);
    const expectedInputData = before.inputData ?? inputData;
    if (expectedInputData !== null && before.inputType.startsWith("insert") &&
        expectedInputData !== insertedText) {
      this.fail(
        "input-data-mismatch",
        "El texto insertado no coincide con los datos declarados por los eventos; se requiere resincronización."
      );
      return;
    }

    // Verifica el texto completo fuera del rango editado. La longitud por sí sola
    // no detecta una mutación externa de igual tamaño en otra zona del documento.
    // Este snapshot es efímero y solo vive mientras el adaptador está montado.
    if (previousText.slice(0, start) !== value.slice(0, start) ||
        previousText.slice(end) !== value.slice(start + insertedLength)) {
      this.fail(
        "inconsistent-length",
        "Se detectó una modificación fuera del rango anunciado por beforeinput; el delta no puede atribuirse con seguridad."
      );
      return;
    }

    if (before.inputType.startsWith("delete") && insertedLength !== 0) {
      this.fail(
        "inconsistent-length",
        "Una operación delete modificó texto fuera del rango de eliminación esperado."
      );
      return;
    }
    if (this.sequence >= Number.MAX_SAFE_INTEGER || this.revision >= Number.MAX_SAFE_INTEGER) {
      this.fail("resync-required", "La secuencia o revisión alcanzó el límite entero seguro de JavaScript.");
      return;
    }

    // inputType informa el mecanismo del navegador, no siempre la intención.
    // Drop y yank no se etiquetan como pegado/corrección sin evidencia específica.
    // La categoría se deriva del inputType declarado por el navegador, nunca
    // de que el delta reemplace una selección. "typing" significa aquí entrada
    // de texto reportada por el navegador, no prueba de teclado físico o intención.
    const activityKind =
      before.inputType === "insertFromPaste" ||
      before.inputType === "insertFromPasteAsQuotation"
        ? "paste" as const
        : before.inputType === "insertReplacementText"
          ? "correction" as const
          : before.inputType.startsWith("delete")
            ? "deletion" as const
            : before.inputType === "insertCompositionText"
              ? "composition" as const
              : before.inputType === "insertText" ||
                before.inputType === "insertLineBreak" ||
                before.inputType === "insertParagraph"
                  ? "typing" as const
                  : "other" as const;
    const change: EditorChange = Object.freeze({
      documentId: this.documentId,
      sequence: this.sequence + 1,
      baseRevision: this.revision,
      start,
      end,
      replacement: insertedText,
      ...(activityKind === undefined ? {} : { activityKind })
    });

    this.sequence = change.sequence;
    this.revision++;
    this.documentLength = value.length;
    this.previousText = value;

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
    this.previousText = snapshot.text;
    this.onError = options.onError;
  }

  subscribeChanges(listener: (change: EditorChange) => void): () => void {
    if (this.disposed) throw new Error("No se puede suscribir un adaptador ya dispuesto.");
    if (typeof listener !== "function") throw new TypeError("listener debe ser una función.");

    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      // La primera suscripción puede llegar después de una mutación ocurrida
      // desde la construcción del adaptador. No se inicia sobre una base vieja.
      if (!this.needsResync && this.element.value !== this.previousText) {
        this.fail(
          "resync-required",
          "El textarea cambió antes de iniciar la observación; se requiere un snapshot autoritativo."
        );
      }
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
        const hadPendingInput = this.pendingInput !== undefined;
        if (!this.disposed && !this.needsResync) {
          this.fail(
            hadPendingInput ? "missing-input" : "resync-required",
            hadPendingInput
              ? "La última suscripción terminó con un beforeinput sin su input correspondiente; se requiere resincronización."
              : "La captura quedó sin observadores; cualquier edición durante ese intervalo exige un snapshot autoritativo antes de reanudar."
          );
        } else {
          this.pendingInput = undefined;
          this.compositionActive = false;
        }
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
    if (this.needsResync && this.listeners.size === 0) {
      throw new LiveAuthorMonitorTextAreaSourceError(
        "resync-required",
        "La resincronización requiere una suscripción activa para evitar otra ventana sin observación."
      );
    }
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
    this.previousText = snapshot.text;
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
    // La instancia puede seguir referenciada después de dispose(); libera el manuscrito.
    this.previousText = "";
  }

  private fail(code: LiveAuthorMonitorTextAreaErrorCode, message: string): void {
    this.needsResync = true;
    this.pendingInput = undefined;
    this.compositionActive = false;
    // Mientras se espera un snapshot autoritativo no se necesita conservar texto.
    this.previousText = "";
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
