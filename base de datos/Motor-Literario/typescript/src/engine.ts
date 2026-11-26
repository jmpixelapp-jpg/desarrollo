import type {
  AnalysisResult, ChangeAdmission, CommitResult, Diagnostic, DocumentSnapshot, DocumentSyncState, EditorChange, LiveEngineMetrics,
  EngineOptions, ProjectIdentity, StoredChange
} from "./contracts";
import { proofreadFragment } from "./proofreading";
import { PieceTable } from "./text-buffer";

function calculatePercentile(samples: Float64Array, count: number, fraction: number): number {
  if (count === 0) return 0;
  const ordered = Array.from(samples.subarray(0, count)).sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
}

interface LiveDocument {
  readonly documentId: string;
  readonly buffer: PieceTable;
  readonly revision: number;
  readonly sequence: number;
  pendingSequence: number;
  needsResync: boolean;
}

interface QueuedChange {
  readonly ticketId: string;
  readonly change: EditorChange;
  readonly enqueuedAt: number;
}

/**
 * Núcleo de sesión. La admisión es síncrona y acotada; persistencia y análisis
 * se ejecutan fuera del callback del editor.
 */
export class LiteraryEngine {
  private project?: ProjectIdentity;
  private readonly documents = new Map<string, LiveDocument>();
  private readonly openingDocuments = new Set<string>();
  private readonly applyingDocuments = new Set<string>();
  private readonly queue: QueuedChange[] = [];
  private readonly queuedByDocument = new Map<string, number>();
  // Longitud UTF-16 proyectada tras todas las ediciones admitidas del documento,
  // incluidas la edición activa y las que aún esperan turno.
  private readonly projectedLengthByDocument = new Map<string, number>();
  private readonly tickets = new Map<string, CommitResult>();
  private draining = false;
  private ticketCounter = 0;
  private readonly capacity: number;
  private readonly maxConcurrentDocuments: number;
  private readonly maxQueuedTextUnits: number;
  private queuedTextUnits = 0;
  private maxObservedQueuedTextUnits = 0;
  private readonly idleWaiters: Array<() => void> = [];
  private static readonly LATENCY_SAMPLE_WINDOW = 256;
  private readonly queueWaitSamples = new Float64Array(LiteraryEngine.LATENCY_SAMPLE_WINDOW);
  private readonly applySamples = new Float64Array(LiteraryEngine.LATENCY_SAMPLE_WINDOW);
  private queueWaitSampleCount = 0;
  private queueWaitSampleCursor = 0;
  private applySampleCount = 0;
  private applySampleCursor = 0;
  private readonly metrics = {
    acceptedChanges: 0,
    rejectedChanges: 0,
    queueFullRejections: 0,
    resyncRequiredRejections: 0,
    invalidChangeRejections: 0,
    unknownDocumentRejections: 0,
    changeTooLargeRejections: 0,
    appliedChanges: 0,
    failedChanges: 0,
    maxQueueDepth: 0,
    maxActiveChanges: 0,
    totalQueueWaitMs: 0,
    maxQueueWaitMs: 0,
    totalApplyMs: 0,
    maxApplyMs: 0
  };

  constructor(private readonly options: EngineOptions) {
    this.capacity = options.queueCapacity ?? 256;
    this.maxConcurrentDocuments = options.maxConcurrentDocuments ?? 2;
    this.maxQueuedTextUnits = options.maxQueuedTextUnits ?? 4_194_304;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) {
      throw new Error("queueCapacity debe ser un entero positivo.");
    }
    if (!Number.isSafeInteger(this.maxQueuedTextUnits) || this.maxQueuedTextUnits < 1) {
      throw new Error("maxQueuedTextUnits debe ser un entero positivo.");
    }
    if (!Number.isInteger(this.maxConcurrentDocuments) ||
        this.maxConcurrentDocuments < 1 || this.maxConcurrentDocuments > 8) {
      throw new Error("maxConcurrentDocuments debe ser un entero entre 1 y 8.");
    }
  }

  initializeProject(identity: ProjectIdentity): void {
    if (!identity || typeof identity.projectId !== "string" ||
        typeof identity.projectName !== "string" ||
        !identity.projectId.trim() || !identity.projectName.trim()) {
      throw new Error("El anfitrión debe proporcionar projectId y projectName.");
    }
    if (this.project && (this.project.projectId !== identity.projectId ||
        this.project.projectName !== identity.projectName ||
        this.project.writerId !== identity.writerId)) {
      throw new Error("La identidad de esta instancia es inmutable; cree otra instancia para otro proyecto o escritor.");
    }
    this.project = Object.freeze({ ...identity });
  }

  async openDocument(snapshot: DocumentSnapshot): Promise<void> {
    if (!snapshot || typeof snapshot.documentId !== "string" ||
        typeof snapshot.text !== "string" || !snapshot.documentId.trim() ||
        !Number.isSafeInteger(snapshot.revision) ||
        !Number.isSafeInteger(snapshot.sequence) || snapshot.revision < 0 || snapshot.sequence < 0) {
      throw new Error("Snapshot de documento inválido.");
    }
    return this.openDocumentInternal(snapshot.documentId, snapshot);
  }

  /**
   * Recupera un documento usando exclusivamente su último snapshot durable y
   * el journal leído en la misma vista transaccional. No requiere que el
   * anfitrión reconstruya ni reenvíe el manuscrito completo.
   */
  async recoverDocument(documentId: string): Promise<void> {
    if (typeof documentId !== "string" || !documentId.trim()) {
      throw new Error("Identificador de documento inválido para recuperación.");
    }
    return this.openDocumentInternal(documentId);
  }

  private async openDocumentInternal(
    documentId: string,
    hostSnapshot?: DocumentSnapshot
  ): Promise<void> {
    const project = this.requireProject();
    if (this.openingDocuments.has(documentId) ||
        this.applyingDocuments.has(documentId) ||
        this.queue.some(item => item.change.documentId === documentId)) {
      throw new Error("No se puede abrir o resincronizar un documento mientras tiene operaciones activas.");
    }
    this.openingDocuments.add(documentId);
    try {
    const recovery = await this.options.store.loadDocumentWithChanges(
      project.projectId, documentId
    );
    if (!recovery || !Array.isArray(recovery.changes)) {
      throw new Error("La lectura transaccional de recuperación devolvió datos inválidos.");
    }
    const stored = recovery.document;
    if (stored && (
      stored.projectId !== project.projectId ||
      stored.documentId !== documentId ||
      typeof stored.text !== "string" ||
      !Number.isSafeInteger(stored.revision) || stored.revision < 0 ||
      !Number.isSafeInteger(stored.sequence) || stored.sequence < 0 ||
      !Number.isFinite(stored.updatedAt) || stored.updatedAt < 0
    )) {
      throw new Error("El snapshot durable está malformado o pertenece a otro proyecto/documento.");
    }
    const snapshot: DocumentSnapshot | undefined = hostSnapshot ?? (stored ? {
      documentId,
      text: stored.text,
      revision: stored.revision,
      sequence: stored.sequence
    } : undefined);
    if (!snapshot) {
      throw new Error("No existe un snapshot durable para recuperar este documento; el anfitrión debe proporcionar el snapshot autoritativo.");
    }
    const atomicJournal: readonly StoredChange[] = recovery.changes;
    if (!stored && atomicJournal.length > 0) {
      throw new Error(
        "Journal sin snapshot base durable: se conserva intacto y se requiere una copia autoritativa para resolverlo."
      );
    }
    if (stored && (snapshot.revision < stored.revision ||
        snapshot.sequence < stored.sequence ||
        snapshot.revision - stored.revision !== snapshot.sequence - stored.sequence ||
        (snapshot.revision === stored.revision &&
         snapshot.sequence === stored.sequence && snapshot.text !== stored.text))) {
      throw new Error("Snapshot del anfitrión obsoleto o inconsistente: no se permite retroceder ni desalinear revisión y secuencia de un documento persistido.");
    }
    const storedMatchesHost = !!stored &&
      stored.revision === snapshot.revision &&
      stored.sequence === snapshot.sequence &&
      stored.text === snapshot.text;
    // El anfitrión es la autoridad. Si coincide exactamente con el último
    // snapshot durable, los deltas posteriores se reproducen en orden.
    // Si difiere, solo se compactan deltas incluidos en el snapshot: los
    // posteriores pueden pertenecer a otra instancia y deben sobrevivir.
    let recoveredBuffer = new PieceTable(snapshot.text);
    let recoveredRevision = snapshot.revision;
    let recoveredSequence = snapshot.sequence;
    let invalidJournal = false;
    if (storedMatchesHost) {
      const journal = atomicJournal;
      for (const entry of journal) {
        if (entry.projectId !== project.projectId ||
            entry.documentId !== snapshot.documentId ||
            !Number.isSafeInteger(entry.sequence) ||
            entry.sequence !== recoveredSequence + 1 ||
            entry.baseRevision !== recoveredRevision ||
            entry.committedRevision !== recoveredRevision + 1 ||
            typeof entry.replacement !== "string" ||
            !Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end) ||
            entry.start < 0 || entry.end < entry.start || entry.end > recoveredBuffer.length) {
          invalidJournal = true;
          break;
        }
        recoveredBuffer.replace(entry.start, entry.end, entry.replacement);
        recoveredRevision = entry.committedRevision;
        recoveredSequence = entry.sequence;
      }
    }
    if (invalidJournal) {
      // Un journal discontinuo puede contener ediciones ya confirmadas. No se
      // descarta ni compacta: se detiene la apertura y se exige una base host
      // realmente más reciente para resolver la rama sin pérdida silenciosa.
      throw new Error(
        "Journal inválido o discontinuo: se conserva intacto y se requiere una resincronización autoritativa."
      );
    }

    const needsInitialSnapshot = !storedMatchesHost;
    const recoveredJournal = recoveredSequence !== snapshot.sequence;
    if (needsInitialSnapshot || recoveredJournal) {
      // Se guarda el estado reconstruido antes de publicar la sesión.
      const recoveredSnapshot = {
        projectId: project.projectId,
        documentId: snapshot.documentId,
        text: recoveredBuffer.toString(),
        revision: recoveredRevision,
        sequence: recoveredSequence,
        updatedAt: Date.now()
      };
      if (!stored) {
        // La primera base durable no es un checkpoint: no hay deltas previos
        // que compactar y el journal huérfano ya fue rechazado arriba.
        await this.options.store.saveDocument(recoveredSnapshot);
      } else if (this.options.store.saveDocumentAndCompactChanges) {
        await this.options.store.saveDocumentAndCompactChanges(
          recoveredSnapshot,
          recoveredSequence
        );
      } else {
        await this.options.store.saveDocument(recoveredSnapshot);
      }
    }
    this.projectedLengthByDocument.delete(snapshot.documentId);
    this.documents.set(snapshot.documentId, {
      documentId: snapshot.documentId,
      buffer: recoveredBuffer,
      revision: recoveredRevision,
      sequence: recoveredSequence,
      pendingSequence: recoveredSequence,
      needsResync: false
    });
    try {
      if (!this.options.store.saveDocumentAndCompactChanges ||
          (!needsInitialSnapshot && !recoveredJournal)) {
        await this.options.store.compactChanges?.(
          project.projectId, snapshot.documentId,
          recoveredSequence
        );
      }
    } catch {
      // La compactación es mantenimiento; el snapshot ya está guardado y el
      // journal restante no compromete la apertura ni la integridad del texto.
    }
    } finally {
      this.openingDocuments.delete(documentId);
    }
  }

  submitChange(change: EditorChange): ChangeAdmission {
    const reject = (reason: Extract<ChangeAdmission, { status: "rejected" }>["reason"]): ChangeAdmission => {
      this.metrics.rejectedChanges++;
      if (reason === "queue_full") this.metrics.queueFullRejections++;
      else if (reason === "change_too_large") this.metrics.changeTooLargeRejections++;
      else if (reason === "resync_required") this.metrics.resyncRequiredRejections++;
      else if (reason === "invalid_change") this.metrics.invalidChangeRejections++;
      else if (reason === "unknown_document") this.metrics.unknownDocumentRejections++;
      return { status: "rejected", reason };
    };
    if (!change || typeof change !== "object" ||
        typeof change.documentId !== "string" ||
        typeof change.replacement !== "string") {
      return reject("invalid_change");
    }
    if (this.openingDocuments.has(change.documentId)) return reject("resync_required");
    const document = this.documents.get(change.documentId);
    if (!document) return reject("unknown_document");
    if (document.needsResync) return reject("resync_required");
    // Validar tipos y enteros antes de cualquier operación aritmética: la API
    // recibe datos del anfitrión en runtime y no debe ejecutar coerciones
    // controladas por objetos externos ni lanzar por valores como Symbol.
    if (!Number.isSafeInteger(change.sequence) || change.sequence < 1 ||
        !Number.isSafeInteger(change.baseRevision) || change.baseRevision < 0 ||
        !Number.isSafeInteger(change.start) || !Number.isSafeInteger(change.end) ||
        change.start < 0 || change.end < change.start) {
      return reject("invalid_change");
    }
    const expectedBaseRevision = document.revision + (change.sequence - document.sequence - 1);
    const projectedLength = this.projectedLengthByDocument.get(change.documentId) ?? document.buffer.length;
    if (!Number.isSafeInteger(expectedBaseRevision) || expectedBaseRevision < 0 ||
        !Number.isSafeInteger(projectedLength) || projectedLength < 0 ||
        change.end > projectedLength) {
      return reject("invalid_change");
    }
    const nextProjectedLength =
      projectedLength - (change.end - change.start) + change.replacement.length;
    if (!Number.isSafeInteger(nextProjectedLength) || nextProjectedLength < 0 ||
        change.sequence !== document.pendingSequence + 1 ||
        change.baseRevision !== expectedBaseRevision) {
      return reject("invalid_change");
    }
    if (change.replacement.length > this.maxQueuedTextUnits) return reject("change_too_large");
    // Validar primero la operación para que una cola llena no oculte errores
    // del anfitrión ni distorsione las métricas por motivo de rechazo.
    const queuedDocumentCount = this.queuedByDocument.size;
    const isNewQueuedDocument = !this.queuedByDocument.has(change.documentId);
    const reservedSlots = Math.min(this.capacity - 1, this.maxConcurrentDocuments - 1);
    if (this.queue.length >= this.capacity ||
        this.queuedTextUnits + change.replacement.length > this.maxQueuedTextUnits ||
        (!isNewQueuedDocument && queuedDocumentCount === 1 &&
         this.queue.length >= this.capacity - reservedSlots)) {
      return reject("queue_full");
    }
    const ticketId = `ml-${++this.ticketCounter}`;
    this.queue.push({
      ticketId,
      change: Object.freeze({ ...change }),
      enqueuedAt: performance.now()
    });
    this.queuedByDocument.set(
      change.documentId, (this.queuedByDocument.get(change.documentId) ?? 0) + 1
    );
    this.queuedTextUnits += change.replacement.length;
    this.projectedLengthByDocument.set(change.documentId, nextProjectedLength);
    this.maxObservedQueuedTextUnits = Math.max(this.maxObservedQueuedTextUnits, this.queuedTextUnits);
    this.metrics.acceptedChanges++;
    this.metrics.maxQueueDepth = Math.max(this.metrics.maxQueueDepth, this.queue.length);
    document.pendingSequence = change.sequence;
    this.scheduleDrain();
    return { status: "queued", ticketId };
  }

  /** Espera a que todos los cambios ya admitidos terminen de persistirse. */
  waitForIdle(): Promise<void> {
    if (!this.draining && this.queue.length === 0 && this.applyingDocuments.size === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  getMetrics(): LiveEngineMetrics {
    return {
      ...this.metrics,
      queueDepth: this.queue.length,
      queuedTextUnits: this.queuedTextUnits,
      maxQueuedTextUnits: this.maxObservedQueuedTextUnits,
      activeDocuments: this.applyingDocuments.size,
      maxActiveDocuments: this.metrics.maxActiveChanges,
      // Alias de compatibilidad: la unidad medida es el documento activo.
      activeChanges: this.applyingDocuments.size,
      queueWaitP50Ms: calculatePercentile(this.queueWaitSamples, this.queueWaitSampleCount, 0.50),
      queueWaitP95Ms: calculatePercentile(this.queueWaitSamples, this.queueWaitSampleCount, 0.95),
      queueWaitWindowSamples: this.queueWaitSampleCount,
      applyP50Ms: calculatePercentile(this.applySamples, this.applySampleCount, 0.50),
      applyP95Ms: calculatePercentile(this.applySamples, this.applySampleCount, 0.95),
      applyWindowSamples: this.applySampleCount
    };
  }

  getCommit(ticketId: string): CommitResult | undefined {
    return this.tickets.get(ticketId);
  }

  getSyncState(documentId: string): DocumentSyncState | undefined {
    const document = this.documents.get(documentId);
    if (!document) return undefined;
    return {
      documentId: document.documentId,
      revision: document.revision,
      sequence: document.sequence,
      pendingSequence: document.pendingSequence,
      needsResync: document.needsResync
    };
  }

  getSnapshot(documentId: string): DocumentSnapshot | undefined {
    const document = this.documents.get(documentId);
    if (!document) return undefined;
    return {
      documentId, text: document.buffer.toString(),
      revision: document.revision, sequence: document.sequence
    };
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => this.drain());
  }

  /**
   * Programa documentos independientes en paralelo, pero nunca dos cambios
   * del mismo documento a la vez. Así cada documento mantiene FIFO y una
   * línea extensa no monopoliza toda la sesión.
   */
  private drain(): void {
    this.draining = false;
    while (this.applyingDocuments.size < this.maxConcurrentDocuments) {
      const nextIndex = this.queue.findIndex(
        item => !this.applyingDocuments.has(item.change.documentId)
      );
      if (nextIndex < 0) break;
      const [item] = this.queue.splice(nextIndex, 1);
      if (!item) continue;
      this.queuedTextUnits -= item.change.replacement.length;
      const queuedForDocument = (this.queuedByDocument.get(item.change.documentId) ?? 1) - 1;
      if (queuedForDocument <= 0) this.queuedByDocument.delete(item.change.documentId);
      else this.queuedByDocument.set(item.change.documentId, queuedForDocument);
      this.applyingDocuments.add(item.change.documentId);
      this.metrics.maxActiveChanges = Math.max(
        this.metrics.maxActiveChanges, this.applyingDocuments.size
      );
      void this.processQueuedChange(item);
    }
    this.resolveIdleWaitersIfNeeded();
  }

  private async processQueuedChange(item: QueuedChange): Promise<void> {
    const startedAt = performance.now();
    const queueWaitMs = Math.max(0, startedAt - item.enqueuedAt);
    this.metrics.totalQueueWaitMs += queueWaitMs;
    this.metrics.maxQueueWaitMs = Math.max(this.metrics.maxQueueWaitMs, queueWaitMs);
    this.queueWaitSamples[this.queueWaitSampleCursor] = queueWaitMs;
    this.queueWaitSampleCursor = (this.queueWaitSampleCursor + 1) % LiteraryEngine.LATENCY_SAMPLE_WINDOW;
    this.queueWaitSampleCount = Math.min(LiteraryEngine.LATENCY_SAMPLE_WINDOW, this.queueWaitSampleCount + 1);
    let result: CommitResult;
    try {
      result = await this.apply(item);
    } catch (error) {
      const document = this.documents.get(item.change.documentId);
      if (document) {
        document.pendingSequence = document.sequence;
        document.needsResync = true;
      }
      result = {
        ticketId: item.ticketId,
        status: "rejected",
        reason: error instanceof Error ? error.message : "unexpected_engine_error"
      };
    } finally {
      this.applyingDocuments.delete(item.change.documentId);
    }
    const applyMs = Math.max(0, performance.now() - startedAt);
    this.metrics.totalApplyMs += applyMs;
    this.metrics.maxApplyMs = Math.max(this.metrics.maxApplyMs, applyMs);
    this.applySamples[this.applySampleCursor] = applyMs;
    this.applySampleCursor = (this.applySampleCursor + 1) % LiteraryEngine.LATENCY_SAMPLE_WINDOW;
    this.applySampleCount = Math.min(LiteraryEngine.LATENCY_SAMPLE_WINDOW, this.applySampleCount + 1);
    if (result.status === "applied") {
      this.metrics.appliedChanges++;
      if ((this.queuedByDocument.get(item.change.documentId) ?? 0) === 0) {
        this.projectedLengthByDocument.delete(item.change.documentId);
      }
    } else {
      this.metrics.failedChanges++;
      this.projectedLengthByDocument.delete(item.change.documentId);
    }
    this.tickets.set(item.ticketId, result);
    // Historial de tickets acotado para que una sesión larga no crezca sin límite.
    if (this.tickets.size > 4096) {
      const oldest = this.tickets.keys().next().value as string | undefined;
      if (oldest !== undefined) this.tickets.delete(oldest);
    }
    try { this.options.onCommit?.(result); } catch { /* Un callback del anfitrión no debe detener el worker. */ }
    this.scheduleDrain();
  }

  private resolveIdleWaitersIfNeeded(): void {
    if (this.draining || this.queue.length > 0 || this.applyingDocuments.size > 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private async apply(item: QueuedChange): Promise<CommitResult> {
    const project = this.requireProject();
    const change = item.change;
    const document = this.documents.get(change.documentId);
    if (!document) return { ticketId: item.ticketId, status: "rejected", reason: "unknown_document" };
    if (document.needsResync) {
      document.pendingSequence = document.sequence;
      return { ticketId: item.ticketId, status: "rejected", reason: "resync_required" };
    }
    if (change.baseRevision !== document.revision || change.sequence !== document.sequence + 1 ||
        change.end > document.buffer.length) {
      document.pendingSequence = document.sequence;
      document.needsResync = true;
      return { ticketId: item.ticketId, status: "rejected", reason: "revision_or_sequence_conflict" };
    }

    const nextBuffer = document.buffer.clone();
    nextBuffer.replace(change.start, change.end, change.replacement);
    const nextRevision = document.revision + 1;
    try {
      if (this.options.store.appendChange) {
        const journalEntry: StoredChange = {
          ...change,
          projectId: project.projectId,
          committedRevision: nextRevision,
          committedAt: Date.now()
        };
        // El delta es el registro durable primario: una edición normal no
        // obliga a serializar y reescribir el manuscrito completo.
        await this.options.store.appendChange(journalEntry);
      } else {
        // Compatibilidad con adaptadores antiguos que solo guardan snapshots.
        await this.options.store.saveDocument({
          projectId: project.projectId,
          documentId: document.documentId,
          text: nextBuffer.toString(),
          revision: nextRevision,
          sequence: change.sequence,
          updatedAt: Date.now()
        });
      }
    } catch (error) {
      document.pendingSequence = document.sequence;
      document.needsResync = true;
      return {
        ticketId: item.ticketId,
        status: "rejected",
        reason: error instanceof Error ? error.message : "persistence_error"
      };
    }

    // appendChange/saveDocument puede resolver después de que el editor haya
    // admitido más transacciones del mismo documento. Leer pendingSequence
    // después del await evita reemplazar el estado vivo con una copia antigua.
    // Solo hay un apply activo por documento, por lo que document sigue siendo
    // la instancia actualmente registrada durante toda esta espera.
    const next: LiveDocument = {
      documentId: document.documentId,
      buffer: nextBuffer,
      revision: nextRevision,
      sequence: change.sequence,
      pendingSequence: Math.max(document.pendingSequence, change.sequence),
      needsResync: false
    };
    this.documents.set(change.documentId, next);

    // Snapshot cada 64 ediciones. El journal ya quedó confirmado; si falla
    // este checkpoint, los deltas siguen siendo la copia durable recuperable.
    if (this.options.store.appendChange && next.sequence % 64 === 0) {
      try {
        const checkpoint = {
          projectId: project.projectId,
          documentId: next.documentId,
          text: next.buffer.toString(),
          revision: next.revision,
          sequence: next.sequence,
          updatedAt: Date.now()
        };
        if (this.options.store.saveDocumentAndCompactChanges) {
          await this.options.store.saveDocumentAndCompactChanges(checkpoint, next.sequence);
        } else {
          await this.options.store.saveDocument(checkpoint);
          await this.options.store.compactChanges?.(project.projectId, next.documentId, next.sequence);
        }
      } catch {
        // El journal no se borra si no se pudo completar el snapshot.
      }
    }

    // Conserva también el intervalo de líneas en el texto anterior: el
    // conocimiento narrativo lo usa para invalidar extractos de línea antiguos.
    const previousAffectedStart = Math.max(0, document.buffer.lastIndexOfNewline(change.start - 1) + 1);
    const previousLineEnd = document.buffer.indexOfNewline(change.end);
    const previousAffectedEnd = previousLineEnd < 0 ? document.buffer.length : previousLineEnd;

    // Analiza todas las líneas afectadas, también cuando una edición inserta
    // o elimina varios saltos de línea. Los offsets siguen siendo absolutos.
    const from = Math.max(0, next.buffer.lastIndexOfNewline(change.start - 1) + 1);
    const affectedPosition = Math.min(next.buffer.length, change.start + change.replacement.length);
    const lastLineEnd = next.buffer.indexOfNewline(affectedPosition);
    const to = lastLineEnd < 0 ? next.buffer.length : lastLineEnd;
    const diagnostics: Diagnostic[] = [];
    const maxChunkLength = 16_384;
    const overlap = 256;
    let scannedSinceYield = 0;
    let lineStart = from;
    while (lineStart <= to && diagnostics.length < 1024) {
      const lineBreak = next.buffer.indexOfNewline(lineStart);
      const lineEnd = lineBreak < 0 || lineBreak > to ? to : lineBreak;
      for (let coreStart = lineStart; coreStart < lineEnd && diagnostics.length < 1024;
           coreStart += maxChunkLength) {
        const coreEnd = Math.min(lineEnd, coreStart + maxChunkLength);
        const contextStart = Math.max(lineStart, coreStart - overlap);
        const contextEnd = Math.min(lineEnd, coreEnd + overlap);
        const fragment = next.buffer.slice(contextStart, contextEnd);
        const fragmentDiagnostics = proofreadFragment(
          fragment, contextStart, next.revision, 2048
        );
        for (const diagnostic of fragmentDiagnostics) {
          // Cada diagnóstico pertenece a un único bloque; el solapamiento
          // aporta contexto sin duplicar resultados entre bloques.
          if (diagnostic.start >= coreStart && diagnostic.start < coreEnd) {
            diagnostics.push(diagnostic);
            if (diagnostics.length >= 1024) break;
          }
        }
        scannedSinceYield += coreEnd - coreStart;
        if (scannedSinceYield >= maxChunkLength && (coreEnd < lineEnd || lineEnd < to)) {
          scannedSinceYield = 0;
          // Cede el hilo principal en documentos/líneas extensos para que el
          // editor y la interfaz puedan atender entrada mientras continúa el análisis.
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }
      if (lineBreak < 0 || lineBreak >= to) break;
      lineStart = lineBreak + 1;
    }
    const result: AnalysisResult = {
      ticketId: item.ticketId,
      projectId: project.projectId,
      documentId: next.documentId,
      revision: next.revision,
      affectedText: next.buffer.slice(from, to),
      affectedStart: from,
      affectedEnd: to,
      changeStart: change.start,
      changeEnd: change.end,
      replacementLength: change.replacement.length,
      changeReplacement: change.replacement,
      previousAffectedStart,
      previousAffectedEnd,
      diagnostics
    };
    try { this.options.onAnalysis?.(result); } catch { /* Los errores de UI no revierten un commit durable. */ }
    return { ticketId: item.ticketId, status: "applied", revision: next.revision };
  }

  private requireProject(): ProjectIdentity {
    if (!this.project) throw new Error("Primero debe inicializarse el proyecto desde el anfitrión.");
    return this.project;
  }
}
