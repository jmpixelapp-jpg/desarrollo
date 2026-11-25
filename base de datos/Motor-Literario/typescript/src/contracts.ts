import type { ProjectDictionary, DictionaryEntry } from "./dictionaries";

/** Contratos públicos. La identidad del proyecto siempre pertenece al anfitrión. */

export interface ProjectIdentity {
  readonly projectId: string;
  readonly projectName: string;
  /** Identidad estable del escritor autenticado, entregada por el anfitrión. */
  readonly writerId?: string;
}

export interface DocumentSnapshot {
  readonly documentId: string;
  readonly text: string;
  readonly revision: number;
  readonly sequence: number;
}

export interface EditorChange {
  readonly documentId: string;
  readonly sequence: number;
  readonly baseRevision: number;
  /** Índices UTF-16, como los que entregan los editores JavaScript. */
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  readonly id: string;
  readonly ruleId: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly start: number;
  readonly end: number;
  readonly revision: number;
  readonly replacement?: string;
}

export interface AnalysisResult {
  /** Ticket de la edición que originó este análisis. */
  readonly ticketId: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  /** Fragmento exacto de líneas analizadas, con offsets absolutos UTF-16. */
  readonly affectedText: string;
  readonly affectedStart: number;
  readonly affectedEnd: number;
  /** Edición original confirmada; todos los offsets son UTF-16. */
  readonly changeStart: number;
  readonly changeEnd: number;
  readonly replacementLength: number;
  /** Texto exacto del reemplazo original; permite distinguir inserciones de líneas completas. */
  readonly changeReplacement: string;
  /** Límites de las líneas afectadas en el texto anterior a la edición. */
  readonly previousAffectedStart: number;
  readonly previousAffectedEnd: number;
  readonly diagnostics: readonly Diagnostic[];
}

export type ChangeAdmission =
  | { readonly status: "queued"; readonly ticketId: string }
  | { readonly status: "rejected"; readonly reason: "queue_full" | "change_too_large" | "unknown_document" | "invalid_change" | "resync_required" };

export interface CommitResult {
  readonly ticketId: string;
  readonly status: "applied" | "rejected";
  readonly revision?: number;
  readonly reason?: string;
}

export interface StoredDocument extends DocumentSnapshot {
  readonly projectId: string;
  readonly updatedAt: number;
}

/** Diagnósticos durables de una revisión concreta del documento. */
export interface StoredDiagnostics {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly diagnostics: readonly Diagnostic[];
  readonly updatedAt: number;
}

/** Recibo durable e idempotente de la transferencia al cerrar un libro. */
export interface StoredProjectFinalizationReceipt {
  readonly writerId: string;
  readonly sourceProjectId: string;
  readonly receiptId: string;
  readonly sourceProjectName: string;
  readonly finalizedAt: number;
  readonly archivedIdeaIds: readonly string[];
  /** Checksum determinista del conjunto ordenado de IDs archivados. */
  readonly archiveChecksum: string;
}

export interface ProjectStore {
  /** Diccionarios y vocabulario propios, siempre aislados por proyecto. */
  saveDictionary?(dictionary: ProjectDictionary, expectedCurrent?: ProjectDictionary): Promise<void>;
  loadDictionaries?(projectId: string): Promise<readonly ProjectDictionary[]>;
  saveDictionaryEntry?(entry: DictionaryEntry, expectedCurrent?: DictionaryEntry): Promise<void>;
  loadDictionaryEntries?(projectId: string, dictionaryId: string): Promise<readonly DictionaryEntry[]>;

  saveDocument(document: StoredDocument): Promise<void>;
  loadDocument(projectId: string, documentId: string): Promise<StoredDocument | undefined>;
  /** Obligatorio: lee snapshot y journal desde una misma vista transaccional consistente. */
  loadDocumentWithChanges(projectId: string, documentId: string): Promise<{
    readonly document: StoredDocument | undefined;
    readonly changes: readonly StoredChange[];
  }>;
  /** Opcional: almacenamiento incremental de cambios. */
  appendChange?(change: StoredChange): Promise<void>;
  /** Lee deltas posteriores al snapshot, ordenados por secuencia ascendente. */
  loadChanges?(projectId: string, documentId: string, afterSequence: number): Promise<readonly StoredChange[]>;
  /** Opcional: elimina del journal los deltas ya incluidos en un snapshot durable. */
  compactChanges?(projectId: string, documentId: string, throughSequence: number): Promise<void>;
  /** Guarda el snapshot y elimina los deltas incluidos en una sola transacción durable. */
  saveDocumentAndCompactChanges?(document: StoredDocument, throughSequence: number): Promise<void>;
  /** Guarda y recupera diagnósticos asociados a una revisión exacta. */
  saveDiagnostics?(diagnostics: StoredDiagnostics): Promise<void>;
  loadDiagnostics?(projectId: string, documentId: string): Promise<StoredDiagnostics | undefined>;
  /** Opcional: conocimiento narrativo persistente, siempre aislado por projectId. */
  saveEntity?(entity: import("./narrative-knowledge").NarrativeEntity): Promise<void>;
  loadEntities?(projectId: string): Promise<readonly import("./narrative-knowledge").NarrativeEntity[]>;
  saveRelation?(relation: import("./narrative-knowledge").NarrativeRelation): Promise<void>;
  loadRelations?(projectId: string): Promise<readonly import("./narrative-knowledge").NarrativeRelation[]>;
  saveEvent?(event: import("./narrative-knowledge").NarrativeEvent): Promise<void>;
  loadEvents?(projectId: string): Promise<readonly import("./narrative-knowledge").NarrativeEvent[]>;
  saveIdea?(idea: import("./narrative-knowledge").NarrativeIdea): Promise<void>;
  /** Actualiza solo si la idea sigue presente y coincide con la versión leída. */
  updateIdeaIfUnchanged?(
    idea: import("./narrative-knowledge").NarrativeIdea,
    expectedCurrent: import("./narrative-knowledge").NarrativeIdea
  ): Promise<void>;
  loadIdeas?(projectId: string): Promise<readonly import("./narrative-knowledge").NarrativeIdea[]>;
  /** Historial versionado de afirmaciones explícitas sobre entidades. */
  saveAssertion?(assertion: import("./narrative-history").NarrativeAssertion): Promise<void>;
  loadAssertions?(projectId: string): Promise<readonly import("./narrative-history").NarrativeAssertion[]>;
  /**
   * Consolidación atómica de identidad y referencias narrativas dentro del proyecto
   * y de las entradas de biblioteca del escritor cuando se proporciona su identidad.
   * Debe redirigir referencias y conservar las instantáneas históricas relacionadas.
   * Si se omite writerId, debe rechazar la operación cuando existan entradas archivadas
   * para el proyecto, porque no puede actualizar sus snapshots con seguridad.
   */
  mergeNarrativeEntityIdentity?(
    projectId: string,
    targetEntityId: string,
    sourceEntityId: string,
    writerId?: string
  ): Promise<void>;
  /** Transfiere atómicamente ideas aún no incorporadas a la biblioteca privada del escritor. */
  archiveUnincorporatedIdeas?(projectId: string, writerId: string, sourceProjectName: string, archivedAt: number): Promise<readonly import("./narrative-knowledge").PersonalIdeaLibraryEntry[]>;
  loadPersonalIdeas?(writerId: string): Promise<readonly import("./narrative-knowledge").PersonalIdeaLibraryEntry[]>;
  loadProjectFinalizationReceipt?(
    writerId: string,
    projectId: string
  ): Promise<StoredProjectFinalizationReceipt | undefined>;
}

export interface EngineOptions {
  readonly store: ProjectStore;
  readonly queueCapacity?: number;
  /** Máximo de documentos procesados en paralelo; cada documento conserva orden FIFO. */
  readonly maxConcurrentDocuments?: number;
  /** Presupuesto agregado de texto de reemplazo retenido en la cola (unidades UTF-16). */
  readonly maxQueuedTextUnits?: number;
  readonly onAnalysis?: (result: AnalysisResult) => void;
  readonly onCommit?: (result: CommitResult) => void;
}


/** Métricas acumuladas de admisión, espera y aplicación de cambios en vivo. */
export interface LiveEngineMetrics {
  readonly acceptedChanges: number;
  readonly rejectedChanges: number;
  /** Rechazos desglosados para que el anfitrión pueda aplicar contrapresión adecuada. */
  readonly queueFullRejections: number;
  readonly resyncRequiredRejections: number;
  readonly invalidChangeRejections: number;
  readonly unknownDocumentRejections: number;
  readonly appliedChanges: number;
  readonly failedChanges: number;
  readonly queueDepth: number;
  /** Unidades UTF-16 actualmente retenidas en reemplazos pendientes. */
  readonly queuedTextUnits: number;
  /** Máximo histórico de unidades UTF-16 retenidas simultáneamente en la cola. */
  readonly maxQueuedTextUnits: number;
  readonly changeTooLargeRejections: number;
  /** Documentos con una edición en curso; cada documento ejecuta como máximo una. */
  readonly activeDocuments: number;
  readonly maxActiveDocuments: number;
  /** Alias heredados de compatibilidad; representan documentos activos, no deltas individuales. */
  readonly activeChanges: number;
  readonly maxActiveChanges: number;
  readonly maxQueueDepth: number;
  readonly totalQueueWaitMs: number;
  readonly maxQueueWaitMs: number;
  readonly totalApplyMs: number;
  readonly maxApplyMs: number;
  /** Percentiles de espera en cola, calculados sobre las últimas 256 ediciones. */
  readonly queueWaitP50Ms: number;
  readonly queueWaitP95Ms: number;
  readonly queueWaitWindowSamples: number;
  /** Percentiles de aplicación/persistencia primaria, sobre las últimas 256 ediciones. */
  readonly applyP50Ms: number;
  readonly applyP95Ms: number;
  readonly applyWindowSamples: number;
}

/** Métricas combinadas del motor y de la persistencia del conocimiento en vivo. */
export interface LiveAnalysisMetrics extends LiveEngineMetrics {
  readonly completedAnalyses: number;
  readonly failedAnalyses: number;
  readonly pendingAnalyses: number;
  readonly totalKnowledgeMs: number;
  readonly maxKnowledgeMs: number;
  /** Tiempo acumulado esperando turno en la cola serial del análisis narrativo. */
  readonly totalAnalysisQueueWaitMs: number;
  readonly maxAnalysisQueueWaitMs: number;
  /** Tiempo efectivo dentro de reconciliación, extracción y persistencia narrativa. */
  readonly totalAnalysisExecutionMs: number;
  readonly maxAnalysisExecutionMs: number;
  /** Latencia desde la admisión del cambio hasta terminar su análisis y persistencia narrativa. */
  readonly endToEndSamples: number;
  readonly totalEndToEndMs: number;
  readonly maxEndToEndMs: number;
  /** Percentiles de las últimas 512 ediciones analizadas; cero si no hay muestras. */
  readonly endToEndP50Ms: number;
  readonly endToEndP95Ms: number;
  readonly endToEndWindowSamples: number;
}

/** Estado de sincronización entre el editor anfitrión y el núcleo local. */
export interface DocumentSyncState {
  readonly documentId: string;
  readonly revision: number;
  readonly sequence: number;
  readonly pendingSequence: number;
  readonly needsResync: boolean;
}


/** Registro durable de una edición; permite guardar deltas sin reescribir el manuscrito. */
export interface StoredChange extends EditorChange {
  readonly projectId: string;
  readonly committedRevision: number;
  readonly committedAt: number;
}


