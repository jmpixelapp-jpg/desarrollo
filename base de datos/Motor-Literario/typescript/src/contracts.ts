import type {
  ProjectRecord, RecordName, ProjectRelation, ProjectEvidence, TimelineOccurrence, EvidenceSubjectKind,
  ManuscriptFragment, RecordAttribute, RelationAttribute, ActiveSuggestion,
  ImportAuthorization, SchemaMigration
} from "./mldb-records";
import type { ProjectDictionary, DictionaryEntry, DictionaryEntryEntityLink } from "./dictionaries";
import type { ProjectSetting, LanguageProfile, LanguageResourceRef, StyleProfile, TimelineTrack, RecordLifecycle, RelationLifecycle, EventLifecycle } from "./project-data";

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

export type EditorChangeActivityKind =
  | "typing" | "paste" | "deletion" | "correction" | "undo" | "redo" | "other";

export interface EditorChange {
  readonly documentId: string;
  readonly sequence: number;
  readonly baseRevision: number;
  /** Índices UTF-16, como los que entregan los editores JavaScript. */
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  /** Optional operation metadata from native editor events. */
  readonly activityKind?: EditorChangeActivityKind;
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

/**
 * Operación durable pendiente de transporte. El payload es JSON serializado
 * para mantener el contrato independiente de proveedores de red.
 */
export interface StoredSyncOperation {
  readonly operationId: string;
  readonly projectId: string;
  readonly deviceId: string;
  readonly sequence: number;
  readonly kind: string;
  readonly payload: string;
  readonly createdAt: number;
  readonly attemptCount: number;
  readonly lastAttemptAt?: number;
  readonly lastErrorCode?: string;
}

export interface StoredDocument extends DocumentSnapshot {
  readonly projectId: string;
  readonly updatedAt: number;
}

/** Diagnósticos durables de una revisión concreta del documento. */
/** Checkpoint versionado de métricas del monitor; no contiene texto ni deltas del manuscrito. */
export interface StoredLiveAuthorMonitorCheckpoint {
  readonly version: 1;
  readonly projectId: string;
  readonly documentId: string;
  readonly sessionId: string;
  readonly savedAt: number;
  readonly sessionDurationMs: number;
  readonly activeDurationMs: number;
  readonly idleDurationMs: number;
  /** Edad monotónica de la última actividad al guardar; null si nunca hubo edición. */
  readonly lastActivityAgeMs: number | null;
  readonly pauseCount: number;
  readonly acceptedChanges: number;
  readonly rejectedChanges: number;
  readonly committedChanges: number;
  readonly failedChanges: number;
  readonly insertedCharacters: number;
  readonly deletedCharacters: number;
  readonly currentDocumentLength: number;
  readonly revision: number;
  readonly sequence: number;
  readonly resynchronizations: number;
  readonly lastCommitLatencyMs: number;
  readonly totalCommitLatencyMs: number;
  readonly commitLatencies: readonly number[];
  /** Optional v1 counters; absent in historic checkpoints means zero. */
  readonly typingChanges?: number;
  readonly pasteChanges?: number;
  readonly deletionChanges?: number;
  readonly correctionChanges?: number;
  readonly undoChanges?: number;
  readonly redoChanges?: number;
  readonly otherChanges?: number;
}

/** Lease temporal de titularidad del monitor, con fencing token monotónico por documento. */
export interface StoredLiveAuthorMonitorLease {
  readonly version: 1;
  readonly projectId: string;
  readonly documentId: string;
  readonly ownerId: string;
  /** Aumenta cada vez que cambia la titularidad tras expirar o liberar una reserva. */
  readonly fencingToken: number;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly updatedAt: number;
}

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
  /** Escucha avisos locales de cambios narrativos confirmados en otras instancias. */
  subscribeNarrativeChanges?(listener: (projectId: string) => void): () => void;
  /** Relaciones genéricas enlazadas a fichas del mismo libro. */
  loadProjectRelations(projectId: string): Promise<readonly ProjectRelation[]>;
  saveProjectRelation(relation: ProjectRelation, expectedCurrent?: ProjectRelation): Promise<void>;

  /** Evidencias con sujeto XOR y anclajes documentales verificables. */
  loadProjectEvidences(projectId: string, subjectKind?: EvidenceSubjectKind, subjectId?: string): Promise<readonly ProjectEvidence[]>;
  saveProjectEvidence(evidence: ProjectEvidence, expectedCurrent?: ProjectEvidence): Promise<void>;

  /** Ocurrencias temporales independientes del orden del manuscrito. */
  loadTimelineOccurrences(projectId: string, eventRecordId?: string, trackId?: string): Promise<readonly TimelineOccurrence[]>;
  saveTimelineOccurrence(occurrence: TimelineOccurrence, expectedCurrent?: TimelineOccurrence): Promise<void>;


  /** Fichas genéricas MLDB; el nombre principal puede quedar vacío. */
  loadProjectRecords(projectId: string): Promise<readonly ProjectRecord[]>;
  saveProjectRecord(record: ProjectRecord, expectedCurrent?: ProjectRecord): Promise<void>;
  /** Nombres principales, alias, títulos y nombres anteriores, siempre ligados a una ficha. */
  loadRecordNames(projectId: string, recordId?: string): Promise<readonly RecordName[]>;
  saveRecordName(name: RecordName, expectedCurrent?: RecordName): Promise<void>;


  /** Fragmentos estables con posiciones UTF-16 recalculables. */
  loadManuscriptFragments?(projectId: string, documentId?: string): Promise<readonly ManuscriptFragment[]>;
  saveManuscriptFragment?(fragment: ManuscriptFragment, expectedCurrent?: ManuscriptFragment): Promise<void>;

  /** Atributos dinámicos de fichas y relaciones. */
  loadRecordAttributes?(projectId: string, recordId: string): Promise<readonly RecordAttribute[]>;
  saveRecordAttribute?(attribute: RecordAttribute, expectedCurrent?: RecordAttribute): Promise<void>;
  loadRelationAttributes?(projectId: string, relationId: string): Promise<readonly RelationAttribute[]>;
  saveRelationAttribute?(attribute: RelationAttribute, expectedCurrent?: RelationAttribute): Promise<void>;

  /** Sugerencias estructuradas asociadas a proyecto, documento y revisión. */
  loadActiveSuggestions?(projectId: string, documentId?: string, status?: ActiveSuggestion["status"]): Promise<readonly ActiveSuggestion[]>;
  saveActiveSuggestion?(suggestion: ActiveSuggestion, expectedCurrent?: ActiveSuggestion): Promise<void>;

  /** Autorizaciones globales append-only ligadas al escritor autenticado. */
  loadImportAuthorizations?(writerId: string): Promise<readonly ImportAuthorization[]>;
  appendImportAuthorization?(authorization: ImportAuthorization): Promise<void>;

  /** Historial de las migraciones nativas aplicadas a IndexedDB. */
  loadSchemaMigrations?(): Promise<readonly SchemaMigration[]>;


  /** Historial append-only de etiquetas y estados de fichas y relaciones. */
  loadRecordLifecycles?(projectId: string, recordId: string): Promise<readonly RecordLifecycle[]>;
  appendRecordLifecycle?(item: RecordLifecycle): Promise<void>;
  loadRelationLifecycles?(projectId: string, relationId: string): Promise<readonly RelationLifecycle[]>;
  appendRelationLifecycle?(item: RelationLifecycle): Promise<void>;
  /** Historial versionado de etiquetas y participantes de acontecimientos. */
  loadEventLifecycles?(projectId: string, eventId: string): Promise<readonly EventLifecycle[]>;
  loadProjectEventLifecycles?(projectId: string): Promise<readonly EventLifecycle[]>;
  /** Actualiza el acontecimiento y añade su transición append-only en una sola transacción. */
  saveEventAndAppendLifecycleIfUnchanged?(
    event: import("./narrative-knowledge").NarrativeEvent,
    expectedCurrent: import("./narrative-knowledge").NarrativeEvent,
    lifecycle: EventLifecycle
  ): Promise<void>;


  /** Preferencias persistentes del libro, siempre aisladas por projectId. */
  loadProjectSettings?(projectId: string): Promise<readonly ProjectSetting[]>;
  saveProjectSetting?(setting: ProjectSetting, expectedCurrent?: ProjectSetting): Promise<void>;

  /** Perfiles lingüísticos y referencias a recursos declarados por el anfitrión. */
  loadLanguageProfiles?(projectId: string): Promise<readonly LanguageProfile[]>;
  saveLanguageProfile?(profile: LanguageProfile, expectedCurrent?: LanguageProfile): Promise<void>;
  loadLanguageResourceRefs?(projectId: string, profileId?: string): Promise<readonly LanguageResourceRef[]>;
  saveLanguageResourceRef?(resource: LanguageResourceRef, expectedCurrent?: LanguageResourceRef): Promise<void>;

  /** Perfiles de estilo del escritor asociados al proyecto. */
  loadStyleProfiles?(projectId: string): Promise<readonly StyleProfile[]>;
  saveStyleProfile?(profile: StyleProfile, expectedCurrent?: StyleProfile): Promise<void>;
  /** Pistas temporales explícitas para organizar acontecimientos del libro. */
  loadTimelineTracks?(projectId: string): Promise<readonly TimelineTrack[]>;
  saveTimelineTrack?(track: TimelineTrack, expectedCurrent?: TimelineTrack): Promise<void>;

  /** Diccionarios y vocabulario propios, siempre aislados por proyecto. */
  saveDictionary?(dictionary: ProjectDictionary, expectedCurrent?: ProjectDictionary): Promise<void>;
  loadDictionaries?(projectId: string): Promise<readonly ProjectDictionary[]>;
  saveDictionaryEntry?(
    entry: DictionaryEntry,
    expectedCurrent?: DictionaryEntry,
    links?: readonly DictionaryEntryEntityLink[]
  ): Promise<void>;
  loadDictionaryEntries?(projectId: string, dictionaryId: string): Promise<readonly DictionaryEntry[]>;
  /** Vínculos por entrada; las tres columnas de metadatos se conservan por vínculo. */
  loadDictionaryEntryEntityLinks?(projectId: string, entryId: string): Promise<readonly DictionaryEntryEntityLink[]>;
  /** Actualiza en una sola transacción la entrada y el vínculo explícito. */
  setDictionaryEntryEntityLink?(
    entry: DictionaryEntry,
    expectedCurrent: DictionaryEntry,
    link: DictionaryEntryEntityLink,
    linked: boolean
  ): Promise<void>;

  /** Última secuencia durable aceptada para un proyecto/dispositivo; cero si aún no hay operaciones. */
  loadLastSyncOperationSequence?(projectId: string, deviceId: string): Promise<number>;
  /** Encola una operación idempotente para sincronización posterior. */
  enqueueSyncOperation?(operation: StoredSyncOperation): Promise<void>;
  /** Lee pendientes sin eliminarlos; el acuse remoto es quien autoriza retirarlos. */
  loadPendingSyncOperations?(projectId: string, limit?: number): Promise<readonly StoredSyncOperation[]>;
  /** Registra un intento de transporte fallido o no confirmado. */
  recordSyncOperationAttempt?(operationId: string, attemptedAt: number, error?: string): Promise<boolean>;
  /** Retira una operación solo después de un acuse remoto durable. */
  acknowledgeSyncOperation?(operationId: string): Promise<boolean>;

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
  /** Adquiere, renueva y libera la titularidad temporal del monitor por pestaña. */
  acquireLiveAuthorMonitorLease?(
    projectId: string,
    documentId: string,
    ownerId: string,
    now: number,
    leaseDurationMs: number
  ): Promise<StoredLiveAuthorMonitorLease | undefined>;
  renewLiveAuthorMonitorLease?(
    lease: StoredLiveAuthorMonitorLease,
    now: number,
    leaseDurationMs: number
  ): Promise<StoredLiveAuthorMonitorLease | undefined>;
  releaseLiveAuthorMonitorLease?(
    lease: StoredLiveAuthorMonitorLease,
    now: number
  ): Promise<boolean>;
  /** Guarda checkpoints solo bajo un lease vigente y su fencing token actual. */
  saveLiveAuthorMonitorCheckpoint?(
    checkpoint: StoredLiveAuthorMonitorCheckpoint,
    lease?: StoredLiveAuthorMonitorLease
  ): Promise<void>;
  loadLiveAuthorMonitorCheckpoint?(
    projectId: string,
    documentId: string
  ): Promise<StoredLiveAuthorMonitorCheckpoint | undefined>;
  deleteLiveAuthorMonitorCheckpoint?(projectId: string, documentId: string): Promise<void>;
  /** Elimina checkpoints antiguos sin lease vigente; nunca elimina los tombstones de lease. */
  cleanupLiveAuthorMonitorCheckpoints?(projectId: string, olderThan: number, now: number): Promise<number>;
  /** Guarda y recupera diagnósticos asociados a una revisión exacta. */
  saveDiagnostics?(diagnostics: StoredDiagnostics): Promise<void>;
  loadDiagnostics?(projectId: string, documentId: string): Promise<StoredDiagnostics | undefined>;
  /** Opcional: conocimiento narrativo persistente, siempre aislado por projectId. */
  saveEntity?(entity: import("./narrative-knowledge").NarrativeEntity): Promise<void>;
  /** Inserta o actualiza una entidad solo si la versión actual coincide con la lectura. */
  saveEntityIfUnchanged?(
    entity: import("./narrative-knowledge").NarrativeEntity,
    expectedCurrent?: import("./narrative-knowledge").NarrativeEntity
  ): Promise<void>;
  loadEntities?(projectId: string): Promise<readonly import("./narrative-knowledge").NarrativeEntity[]>;
  saveRelation?(relation: import("./narrative-knowledge").NarrativeRelation): Promise<void>;
  saveRelationIfUnchanged?(
    relation: import("./narrative-knowledge").NarrativeRelation,
    expectedCurrent?: import("./narrative-knowledge").NarrativeRelation
  ): Promise<void>;
  loadRelations?(projectId: string): Promise<readonly import("./narrative-knowledge").NarrativeRelation[]>;
  saveEvent?(event: import("./narrative-knowledge").NarrativeEvent): Promise<void>;
  saveEventIfUnchanged?(
    event: import("./narrative-knowledge").NarrativeEvent,
    expectedCurrent?: import("./narrative-knowledge").NarrativeEvent
  ): Promise<void>;
  loadEvents?(projectId: string): Promise<readonly import("./narrative-knowledge").NarrativeEvent[]>;
  saveIdea?(idea: import("./narrative-knowledge").NarrativeIdea): Promise<void>;
  /** Inserta o actualiza una idea solo si la versión actual coincide con la lectura. */
  saveIdeaIfUnchanged?(
    idea: import("./narrative-knowledge").NarrativeIdea,
    expectedCurrent?: import("./narrative-knowledge").NarrativeIdea
  ): Promise<void>;
  /** Compatibilidad explícita para actualizar una idea existente. */
  updateIdeaIfUnchanged?(
    idea: import("./narrative-knowledge").NarrativeIdea,
    expectedCurrent: import("./narrative-knowledge").NarrativeIdea
  ): Promise<void>;
  loadIdeas?(projectId: string): Promise<readonly import("./narrative-knowledge").NarrativeIdea[]>;
  /** Historial versionado de afirmaciones explícitas sobre entidades. */
  saveAssertion?(assertion: import("./narrative-history").NarrativeAssertion): Promise<void>;
  saveAssertionIfUnchanged?(
    assertion: import("./narrative-history").NarrativeAssertion,
    expectedCurrent?: import("./narrative-history").NarrativeAssertion
  ): Promise<void>;
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


