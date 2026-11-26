import type {
  ChangeAdmission,
  CommitResult,
  DocumentSnapshot,
  EditorChange,
  StoredLiveAuthorMonitorCheckpoint
} from "./contracts";

export type LiveAuthorActivityState = "active" | "idle" | "needs-resync";

export interface LiveAuthorMonitorOptions {
  readonly idleAfterMs?: number;
  readonly maxOpenDocuments?: number;
  readonly commitSampleWindow?: number;
  readonly now?: () => number;
}

export interface LiveAuthorMonitorSnapshot {
  readonly sessionId: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly state: LiveAuthorActivityState;
  readonly openedAt: number;
  readonly lastActivityAt: number | undefined;
  readonly sessionDurationMs: number;
  readonly activeDurationMs: number;
  readonly idleDurationMs: number;
  readonly currentIdleMs: number;
  readonly pauseCount: number;
  readonly acceptedChanges: number;
  readonly typingChanges: number;
  readonly compositionChanges: number;
  readonly pasteChanges: number;
  readonly deletionChanges: number;
  readonly correctionChanges: number;
  readonly undoChanges: number;
  readonly redoChanges: number;
  readonly otherChanges: number;
  readonly rejectedChanges: number;
  readonly committedChanges: number;
  readonly failedChanges: number;
  readonly pendingChanges: number;
  /** All admitted insertions/deletions, including every provisional IME candidate delta. */
  readonly insertedCharacters: number;
  readonly deletedCharacters: number;
  /** UTF-16 units from changes explicitly classified as ordinary typing. */
  readonly typingInsertedCharacters: number;
  /** Raw UTF-16 units across applied provisional/committed IME composition deltas. */
  readonly compositionInsertedCharacters: number;
  readonly compositionDeletedCharacters: number;
  /** False when a legacy checkpoint lacked unit-provenance counters. */
  readonly activityUnitMetricsComplete: boolean;
  readonly netCharacterDelta: number;
  readonly currentDocumentLength: number;
  readonly estimatedWordsPerMinute: number;
  readonly insertedCharactersPerMinute: number;
  readonly latestRevision: number;
  readonly durableRevision: number;
  readonly latestSequence: number;
  readonly durableSequence: number;
  readonly needsResync: boolean;
  readonly resynchronizations: number;
  readonly lastCommitLatencyMs: number;
  readonly averageCommitLatencyMs: number;
  readonly commitLatencyP50Ms: number;
  readonly commitLatencyP95Ms: number;
  readonly commitLatencySamples: number;
  /** Fallos de callbacks de observabilidad de esta sesión; no afectan la escritura. */
  readonly listenerErrors: number;
}

interface MonitorSubscriber {
  readonly listener: LiveAuthorMonitorListener;
  readonly documentId?: string;
}

interface PendingMonitorNotification {
  readonly snapshot: LiveAuthorMonitorSnapshot;
  readonly session: DocumentSession;
  readonly subscribers: readonly MonitorSubscriber[];
}

interface PendingTicket {
  readonly documentId: string;
  readonly submittedAt: number;
  readonly sequence: number;
  readonly revision: number;
}

interface DocumentSession {
  readonly sessionId: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly openedAt: number;
  lastObservedAt: number;
  lastActivityAt: number | undefined;
  activeDurationMs: number;
  idleDurationMs: number;
  pauseCount: number;
  acceptedChanges: number;
  typingChanges: number;
  compositionChanges: number;
  pasteChanges: number;
  deletionChanges: number;
  correctionChanges: number;
  undoChanges: number;
  redoChanges: number;
  otherChanges: number;
  rejectedChanges: number;
  committedChanges: number;
  failedChanges: number;
  listenerErrors: number;
  insertedCharacters: number;
  deletedCharacters: number;
  typingInsertedCharacters: number;
  compositionInsertedCharacters: number;
  compositionDeletedCharacters: number;
  activityUnitMetricsComplete: boolean;
  currentDocumentLength: number;
  latestRevision: number;
  durableRevision: number;
  latestSequence: number;
  durableSequence: number;
  needsResync: boolean;
  resynchronizations: number;
  lastCommitLatencyMs: number;
  totalCommitLatencyMs: number;
  readonly pendingTickets: Set<string>;
  readonly commitLatencies: number[];
}

export type LiveAuthorMonitorListener = (snapshot: LiveAuthorMonitorSnapshot) => void;

function classifyActivityKind(change: EditorChange):
  "typing" | "composition" | "paste" | "deletion" | "correction" | "undo" | "redo" | "other" {
  switch (change.activityKind) {
    case "typing":
    case "composition":
    case "paste":
    case "deletion":
    case "correction":
    case "undo":
    case "redo":
    case "other":
      return change.activityKind;
    // Sin procedencia explícita, la geometría del delta no demuestra si fue
    // escritura, pegado, autocorrección, dictado, corte u otra operación.
    // Se conserva como "other" en lugar de inventar una categoría.
    default:
      return "other";
  }
}

const defaultMonotonicClock = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1);
  return ordered[index] ?? 0;
}

/**
 * Observa la actividad de escritura sin conservar el contenido del manuscrito.
 * El anfitrión informa admisiones y commits del motor.
 */
export class LiveAuthorMonitor {
  private readonly sessions = new Map<string, DocumentSession>();
  private readonly pendingTickets = new Map<string, PendingTicket>();
  private readonly listeners = new Set<MonitorSubscriber>();
  private readonly notificationQueue: PendingMonitorNotification[] = [];
  private notifyingListeners = false;
  private readonly idleAfterMs: number;
  private readonly maxOpenDocuments: number;
  private readonly commitSampleWindow: number;
  private readonly now: () => number;
  private sessionCounter = 0;

  constructor(options: LiveAuthorMonitorOptions = {}) {
    this.idleAfterMs = options.idleAfterMs ?? 10_000;
    this.maxOpenDocuments = options.maxOpenDocuments ?? 8;
    this.commitSampleWindow = options.commitSampleWindow ?? 256;
    this.now = options.now ?? defaultMonotonicClock;

    if (!Number.isSafeInteger(this.idleAfterMs) || this.idleAfterMs < 0) {
      throw new RangeError("idleAfterMs debe ser un entero seguro no negativo.");
    }
    if (!Number.isSafeInteger(this.maxOpenDocuments) || this.maxOpenDocuments < 1 || this.maxOpenDocuments > 64) {
      throw new RangeError("maxOpenDocuments debe estar entre 1 y 64.");
    }
    if (!Number.isSafeInteger(this.commitSampleWindow) || this.commitSampleWindow < 1 || this.commitSampleWindow > 4096) {
      throw new RangeError("commitSampleWindow debe estar entre 1 y 4096.");
    }
  }

  openDocument(snapshot: DocumentSnapshot, projectId: string): LiveAuthorMonitorSnapshot {
    if (!projectId.trim() || !snapshot.documentId.trim() ||
        !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
        !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 ||
        typeof snapshot.text !== "string") {
      throw new TypeError("El snapshot del documento no es válido para iniciar el monitoreo.");
    }
    if (this.sessions.has(snapshot.documentId)) {
      throw new Error("El documento " + snapshot.documentId + " ya tiene una sesión de monitoreo abierta.");
    }
    if (this.sessions.size >= this.maxOpenDocuments) {
      throw new Error("Se alcanzó el límite de documentos observados simultáneamente.");
    }

    const openedAt = this.readClock();
    const sessionNonce = globalThis.crypto?.randomUUID?.() ??
      Math.random().toString(36).slice(2);
    const session: DocumentSession = {
      sessionId: projectId + ":" + snapshot.documentId + ":" + Date.now() +
        ":" + sessionNonce + ":" + (++this.sessionCounter),
      projectId,
      documentId: snapshot.documentId,
      openedAt,
      lastObservedAt: openedAt,
      lastActivityAt: undefined,
      activeDurationMs: 0,
      idleDurationMs: 0,
      pauseCount: 0,
      acceptedChanges: 0,
      typingChanges: 0,
      compositionChanges: 0,
      pasteChanges: 0,
      deletionChanges: 0,
      correctionChanges: 0,
      undoChanges: 0,
      redoChanges: 0,
      otherChanges: 0,
      rejectedChanges: 0,
      committedChanges: 0,
      failedChanges: 0,
      listenerErrors: 0,
      insertedCharacters: 0,
      deletedCharacters: 0,
      typingInsertedCharacters: 0,
      compositionInsertedCharacters: 0,
      compositionDeletedCharacters: 0,
      activityUnitMetricsComplete: true,
      currentDocumentLength: snapshot.text.length,
      latestRevision: snapshot.revision,
      durableRevision: snapshot.revision,
      latestSequence: snapshot.sequence,
      durableSequence: snapshot.sequence,
      needsResync: false,
      resynchronizations: 0,
      lastCommitLatencyMs: 0,
      totalCommitLatencyMs: 0,
      pendingTickets: new Set<string>(),
      commitLatencies: []
    };
    this.sessions.set(snapshot.documentId, session);
    return this.publish(session);
  }

  /**
   * Registra el resultado de HostEngineApi.onEditorChange. Debe llamarse una
   * sola vez por evento, después de obtener la admisión del motor.
   */
  recordAdmission(change: EditorChange, admission: ChangeAdmission): LiveAuthorMonitorSnapshot {
    const session = this.requireSession(change.documentId);
    const at = this.readClock(session);
    this.advanceTimeline(session, at);
    if (session.lastActivityAt !== undefined && at - session.lastActivityAt > this.idleAfterMs) {
      session.pauseCount++;
    }
    session.lastActivityAt = at;

    if (admission.status === "rejected") {
      session.rejectedChanges++;
      return this.publish(session);
    }

    if (!admission.ticketId || this.pendingTickets.has(admission.ticketId)) {
      throw new Error("El ticket de edición está vacío o ya fue registrado.");
    }
    if (!Number.isSafeInteger(change.sequence) || change.sequence !== session.latestSequence + 1 ||
        !Number.isSafeInteger(change.baseRevision) || change.baseRevision !== session.latestRevision ||
        !Number.isSafeInteger(change.start) || !Number.isSafeInteger(change.end) ||
        change.start < 0 || change.end < change.start || change.end > session.currentDocumentLength ||
        typeof change.replacement !== "string") {
      throw new Error("El cambio admitido no continúa la secuencia y revisión observadas por el monitor.");
    }

    session.acceptedChanges++;
    const activityKind = classifyActivityKind(change);
    switch (activityKind) {
      case "typing":
        session.typingChanges++;
        session.typingInsertedCharacters += change.replacement.length;
        break;
      case "composition":
        session.compositionChanges++;
        session.compositionInsertedCharacters += change.replacement.length;
        session.compositionDeletedCharacters += change.end - change.start;
        break;
      case "paste": session.pasteChanges++; break;
      case "deletion": session.deletionChanges++; break;
      case "correction": session.correctionChanges++; break;
      case "undo": session.undoChanges++; break;
      case "redo": session.redoChanges++; break;
      case "other": session.otherChanges++; break;
    }
    session.insertedCharacters += change.replacement.length;
    session.deletedCharacters += change.end - change.start;
    session.currentDocumentLength += change.replacement.length - (change.end - change.start);
    session.latestSequence = change.sequence;
    session.latestRevision = change.baseRevision + 1;
    session.pendingTickets.add(admission.ticketId);
    this.pendingTickets.set(admission.ticketId, {
      documentId: session.documentId,
      submittedAt: at,
      sequence: change.sequence,
      revision: session.latestRevision
    });
    return this.publish(session);
  }

  recordCommit(result: CommitResult): LiveAuthorMonitorSnapshot | undefined {
    const pending = this.pendingTickets.get(result.ticketId);
    if (!pending) return undefined;
    const session = this.sessions.get(pending.documentId);
    if (!session) {
      this.pendingTickets.delete(result.ticketId);
      return undefined;
    }

    const at = this.readClock(session);
    this.advanceTimeline(session, at);
    const latency = Math.max(0, at - pending.submittedAt);
    session.lastCommitLatencyMs = latency;
    session.totalCommitLatencyMs += latency;
    session.commitLatencies.push(latency);
    if (session.commitLatencies.length > this.commitSampleWindow) session.commitLatencies.shift();
    session.pendingTickets.delete(result.ticketId);
    this.pendingTickets.delete(result.ticketId);

    if (result.status === "applied") {
      session.committedChanges++;
      session.durableSequence = Math.max(session.durableSequence, pending.sequence);
      session.durableRevision = Math.max(session.durableRevision, result.revision ?? pending.revision);
    } else {
      session.failedChanges++;
      session.needsResync = true;
    }
    return this.publish(session);
  }

  resynchronizeDocument(snapshot: DocumentSnapshot): LiveAuthorMonitorSnapshot {
    const session = this.requireSession(snapshot.documentId);
    if (session.pendingTickets.size > 0) {
      throw new Error("No se puede resincronizar el monitor mientras existan commits pendientes.");
    }
    if (typeof snapshot.text !== "string" || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
        !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) {
      throw new TypeError("El snapshot autoritativo no es válido.");
    }

    const at = this.readClock(session);
    this.advanceTimeline(session, at);
    session.currentDocumentLength = snapshot.text.length;
    // Una resincronización confirma el estado textual, pero no recupera el
    // historial de tipos/longitudes de los deltas que pudieron faltar.
    session.activityUnitMetricsComplete = false;
    session.latestRevision = snapshot.revision;
    session.durableRevision = snapshot.revision;
    session.latestSequence = snapshot.sequence;
    session.durableSequence = snapshot.sequence;
    session.needsResync = false;
    session.resynchronizations++;
    return this.publish(session);
  }

  getSnapshot(documentId: string): LiveAuthorMonitorSnapshot | undefined {
    const session = this.sessions.get(documentId);
    return session ? this.createSnapshot(session, this.readClock(session)) : undefined;
  }

  getSnapshots(): readonly LiveAuthorMonitorSnapshot[] {
    const now = this.readClock();
    for (const session of this.sessions.values()) {
      if (now < session.lastObservedAt) {
        throw new Error("El reloj del monitor debe ser monotónico y no puede retroceder.");
      }
    }
    return [...this.sessions.values()].map(session => this.createSnapshot(session, now));
  }

  subscribe(listener: LiveAuthorMonitorListener, documentId?: string): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("El suscriptor del monitor debe ser una función.");
    }
    if (documentId !== undefined &&
        (typeof documentId !== "string" || !documentId.trim())) {
      throw new TypeError("documentId del suscriptor no puede estar vacío.");
    }
    const entry = documentId === undefined ? { listener } : { listener, documentId };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  closeDocument(documentId: string): LiveAuthorMonitorSnapshot {
    const session = this.requireSession(documentId);
    if (session.pendingTickets.size > 0) {
      throw new Error("No se puede cerrar el monitoreo con cambios pendientes de confirmación.");
    }
    const snapshot = this.createSnapshot(session, this.readClock(session));
    this.sessions.delete(documentId);
    return snapshot;
  }

  /**
   * Produce un checkpoint solo cuando todas las ediciones admitidas están durables.
   * El registro contiene métricas, identidad y secuencia; nunca incluye el manuscrito.
   */
  createCheckpoint(
    documentId: string,
    savedAt = Date.now()
  ): StoredLiveAuthorMonitorCheckpoint | undefined {
    if (!Number.isFinite(savedAt) || savedAt < 0) {
      throw new RangeError("savedAt debe ser un timestamp de pared finito no negativo.");
    }
    const session = this.requireSession(documentId);
    if (session.pendingTickets.size > 0 || session.needsResync ||
        session.latestRevision !== session.durableRevision ||
        session.latestSequence !== session.durableSequence) {
      return undefined;
    }

    const now = this.readClock(session);
    this.advanceTimeline(session, now);
    const checkpoint: StoredLiveAuthorMonitorCheckpoint = {
      version: 1,
      projectId: session.projectId,
      documentId: session.documentId,
      sessionId: session.sessionId,
      savedAt,
      sessionDurationMs: Math.max(0, now - session.openedAt),
      activeDurationMs: session.activeDurationMs,
      idleDurationMs: session.idleDurationMs,
      lastActivityAgeMs: session.lastActivityAt === undefined
        ? null
        : Math.max(0, now - session.lastActivityAt),
      pauseCount: session.pauseCount,
      acceptedChanges: session.acceptedChanges,
      typingChanges: session.typingChanges,
      compositionChanges: session.compositionChanges,
      pasteChanges: session.pasteChanges,
      deletionChanges: session.deletionChanges,
      correctionChanges: session.correctionChanges,
      undoChanges: session.undoChanges,
      redoChanges: session.redoChanges,
      otherChanges: session.otherChanges,
      rejectedChanges: session.rejectedChanges,
      committedChanges: session.committedChanges,
      failedChanges: session.failedChanges,
      insertedCharacters: session.insertedCharacters,
      deletedCharacters: session.deletedCharacters,
      typingInsertedCharacters: session.typingInsertedCharacters,
      compositionInsertedCharacters: session.compositionInsertedCharacters,
      compositionDeletedCharacters: session.compositionDeletedCharacters,
      activityUnitMetricsComplete: session.activityUnitMetricsComplete,
      currentDocumentLength: session.currentDocumentLength,
      revision: session.latestRevision,
      sequence: session.latestSequence,
      resynchronizations: session.resynchronizations,
      lastCommitLatencyMs: session.lastCommitLatencyMs,
      totalCommitLatencyMs: session.totalCommitLatencyMs,
      commitLatencies: Object.freeze([...session.commitLatencies])
    };
    return Object.freeze(checkpoint);
  }

  /**
   * Restaura métricas sobre un snapshot durable exacto. El tiempo transcurrido
   * fuera del proceso se cuenta como inactividad, nunca como tiempo escribiendo.
   */
  restoreCheckpoint(
    checkpoint: StoredLiveAuthorMonitorCheckpoint,
    snapshot: DocumentSnapshot,
    projectId: string,
    restoredAt = Date.now()
  ): LiveAuthorMonitorSnapshot {
    if (snapshot === null || typeof snapshot !== "object") {
      throw new TypeError("El snapshot durable del documento debe ser un objeto.");
    }
    if (!checkpoint || checkpoint.version !== 1 ||
        typeof projectId !== "string" || !projectId.trim() ||
        checkpoint.projectId !== projectId ||
        typeof checkpoint.documentId !== "string" || !checkpoint.documentId.trim() ||
        checkpoint.documentId !== snapshot.documentId ||
        typeof checkpoint.sessionId !== "string" || !checkpoint.sessionId.trim()) {
      throw new TypeError("El checkpoint del monitor no corresponde al proyecto/documento.");
    }
    if (!snapshot || typeof snapshot.text !== "string" ||
        !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
        !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 ||
        checkpoint.revision !== snapshot.revision ||
        checkpoint.sequence !== snapshot.sequence ||
        checkpoint.currentDocumentLength !== snapshot.text.length) {
      throw new Error("El checkpoint no coincide exactamente con el snapshot durable del documento.");
    }
    const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;
    const integerNonNegative = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
    const classifiedActivityCounts = [checkpoint.typingChanges, checkpoint.pasteChanges,
      checkpoint.deletionChanges, checkpoint.correctionChanges, checkpoint.undoChanges, checkpoint.redoChanges];
    const hasActivityCounts = classifiedActivityCounts.some(value => value !== undefined) ||
      checkpoint.compositionChanges !== undefined || checkpoint.otherChanges !== undefined;
    const validClassifiedCounts = classifiedActivityCounts.every(
      value => value !== undefined && integerNonNegative(value)
    );
    const classifiedCountTotal = classifiedActivityCounts.reduce<number>((sum, value) => sum + (value ?? 0), 0) +
      (checkpoint.compositionChanges ?? 0);
    const hasAnyUnitMetrics = checkpoint.typingInsertedCharacters !== undefined ||
      checkpoint.compositionInsertedCharacters !== undefined ||
      checkpoint.compositionDeletedCharacters !== undefined;
    const hasAllUnitMetrics = checkpoint.typingInsertedCharacters !== undefined &&
      checkpoint.compositionInsertedCharacters !== undefined &&
      checkpoint.compositionDeletedCharacters !== undefined;
    const validUnitMetrics = !hasAnyUnitMetrics || (hasAllUnitMetrics &&
      integerNonNegative(checkpoint.typingInsertedCharacters!) &&
      integerNonNegative(checkpoint.compositionInsertedCharacters!) &&
      integerNonNegative(checkpoint.compositionDeletedCharacters!) &&
      Number.isSafeInteger(checkpoint.typingInsertedCharacters! + checkpoint.compositionInsertedCharacters!) &&
      checkpoint.typingInsertedCharacters! + checkpoint.compositionInsertedCharacters! <= checkpoint.insertedCharacters &&
      checkpoint.compositionDeletedCharacters! <= checkpoint.deletedCharacters);
    const validUnitMetricsCompleteness = checkpoint.activityUnitMetricsComplete === undefined ||
      typeof checkpoint.activityUnitMetricsComplete === "boolean";
    const validUnitMetricsFlag = checkpoint.activityUnitMetricsComplete !== true || hasAllUnitMetrics;
    const validCompositionCount = checkpoint.compositionChanges === undefined ||
      integerNonNegative(checkpoint.compositionChanges);
    const activityCountTotal = classifiedCountTotal +
      (checkpoint.otherChanges ?? checkpoint.acceptedChanges - classifiedCountTotal);
    const validActivityCounts = !hasActivityCounts || (validClassifiedCounts && validCompositionCount &&
      (checkpoint.otherChanges === undefined || integerNonNegative(checkpoint.otherChanges)) &&
      classifiedCountTotal <= checkpoint.acceptedChanges &&
      (checkpoint.otherChanges === undefined ||
        classifiedCountTotal + checkpoint.otherChanges === checkpoint.acceptedChanges));
    if (!finiteNonNegative(restoredAt) || !finiteNonNegative(checkpoint.savedAt) ||
        restoredAt < checkpoint.savedAt ||
        !finiteNonNegative(checkpoint.sessionDurationMs) ||
        !finiteNonNegative(checkpoint.activeDurationMs) ||
        !finiteNonNegative(checkpoint.idleDurationMs) ||
        Math.abs(checkpoint.sessionDurationMs -
          checkpoint.activeDurationMs - checkpoint.idleDurationMs) > 1 ||
        !(checkpoint.lastActivityAgeMs === null ||
          (finiteNonNegative(checkpoint.lastActivityAgeMs) &&
            checkpoint.lastActivityAgeMs <= checkpoint.sessionDurationMs + 1)) ||
        !integerNonNegative(checkpoint.pauseCount) ||
        !integerNonNegative(checkpoint.acceptedChanges) ||
        (hasActivityCounts && (!validActivityCounts || activityCountTotal !== checkpoint.acceptedChanges)) ||
        !validUnitMetrics || !validUnitMetricsCompleteness || !validUnitMetricsFlag ||
        !integerNonNegative(checkpoint.rejectedChanges) ||
        checkpoint.pauseCount > checkpoint.acceptedChanges + checkpoint.rejectedChanges ||
        !integerNonNegative(checkpoint.committedChanges) ||
        !integerNonNegative(checkpoint.failedChanges) ||
        checkpoint.committedChanges + checkpoint.failedChanges !== checkpoint.acceptedChanges ||
        !integerNonNegative(checkpoint.insertedCharacters) ||
        !integerNonNegative(checkpoint.deletedCharacters) ||
        !integerNonNegative(checkpoint.currentDocumentLength) ||
        checkpoint.insertedCharacters > checkpoint.currentDocumentLength + checkpoint.deletedCharacters ||
        !integerNonNegative(checkpoint.revision) ||
        !integerNonNegative(checkpoint.sequence) ||
        !integerNonNegative(checkpoint.resynchronizations) ||
        !finiteNonNegative(checkpoint.lastCommitLatencyMs) ||
        !finiteNonNegative(checkpoint.totalCommitLatencyMs) ||
        !Array.isArray(checkpoint.commitLatencies) ||
        checkpoint.commitLatencies.length > this.commitSampleWindow ||
        checkpoint.commitLatencies.length > checkpoint.committedChanges + checkpoint.failedChanges ||
        Array.from(checkpoint.commitLatencies).some(value => !finiteNonNegative(value)) ||
        checkpoint.commitLatencies.reduce((sum, value) => sum + value, 0) >
          checkpoint.totalCommitLatencyMs + 1 ||
        (checkpoint.commitLatencies.length === 0
          ? (checkpoint.committedChanges + checkpoint.failedChanges > 0 ||
            checkpoint.lastCommitLatencyMs !== 0 || checkpoint.totalCommitLatencyMs !== 0)
          : checkpoint.commitLatencies[checkpoint.commitLatencies.length - 1] !== checkpoint.lastCommitLatencyMs)) {
      throw new TypeError("El checkpoint del monitor contiene métricas o tiempos inválidos.");
    }
    if (this.sessions.has(snapshot.documentId)) {
      throw new Error("Ya existe una sesión de monitoreo abierta para el documento.");
    }
    if (this.sessions.size >= this.maxOpenDocuments) {
      throw new Error("Se alcanzó el límite de documentos observados simultáneamente.");
    }

    const downtime = restoredAt - checkpoint.savedAt;
    const now = this.readClock();
    const sessionDurationMs = checkpoint.sessionDurationMs + downtime;
    const idleDurationMs = checkpoint.idleDurationMs + downtime;
    if (!Number.isFinite(downtime) || !Number.isFinite(sessionDurationMs) ||
        !Number.isFinite(idleDurationMs)) {
      throw new RangeError("El intervalo de recuperación excede el rango numérico admitido.");
    }
    // La interrupción completa ya se suma a idleDurationMs. Conservar la
    // edad real evita situar lastActivityAt antes del inicio de una sesión
    // muy reciente cuando el downtime es menor que idleAfterMs.
    const restoredActivityAge = checkpoint.lastActivityAgeMs === null
      ? undefined
      : checkpoint.lastActivityAgeMs + downtime;
    const session: DocumentSession = {
      sessionId: checkpoint.sessionId,
      projectId,
      documentId: snapshot.documentId,
      openedAt: now - sessionDurationMs,
      lastObservedAt: now,
      lastActivityAt: restoredActivityAge === undefined ? undefined : now - restoredActivityAge,
      activeDurationMs: checkpoint.activeDurationMs,
      idleDurationMs,
      pauseCount: checkpoint.pauseCount,
      acceptedChanges: checkpoint.acceptedChanges,
      typingChanges: checkpoint.typingChanges ?? 0,
      compositionChanges: checkpoint.compositionChanges ?? 0,
      pasteChanges: checkpoint.pasteChanges ?? 0,
      deletionChanges: checkpoint.deletionChanges ?? 0,
      correctionChanges: checkpoint.correctionChanges ?? 0,
      undoChanges: checkpoint.undoChanges ?? 0,
      redoChanges: checkpoint.redoChanges ?? 0,
      otherChanges: hasActivityCounts
        ? (checkpoint.otherChanges ?? checkpoint.acceptedChanges - classifiedCountTotal)
        : checkpoint.acceptedChanges,
      rejectedChanges: checkpoint.rejectedChanges,
      committedChanges: checkpoint.committedChanges,
      failedChanges: checkpoint.failedChanges,
      listenerErrors: 0,
      insertedCharacters: checkpoint.insertedCharacters,
      deletedCharacters: checkpoint.deletedCharacters,
      typingInsertedCharacters: checkpoint.typingInsertedCharacters ?? 0,
      compositionInsertedCharacters: checkpoint.compositionInsertedCharacters ?? 0,
      compositionDeletedCharacters: checkpoint.compositionDeletedCharacters ?? 0,
      activityUnitMetricsComplete: checkpoint.activityUnitMetricsComplete ?? hasAllUnitMetrics,
      currentDocumentLength: snapshot.text.length,
      latestRevision: snapshot.revision,
      durableRevision: snapshot.revision,
      latestSequence: snapshot.sequence,
      durableSequence: snapshot.sequence,
      needsResync: false,
      resynchronizations: checkpoint.resynchronizations,
      lastCommitLatencyMs: checkpoint.lastCommitLatencyMs,
      totalCommitLatencyMs: checkpoint.totalCommitLatencyMs,
      pendingTickets: new Set<string>(),
      commitLatencies: [...checkpoint.commitLatencies]
    };
    this.sessions.set(snapshot.documentId, session);
    const counter = Number(checkpoint.sessionId.slice(checkpoint.sessionId.lastIndexOf(":") + 1));
    if (Number.isSafeInteger(counter) && counter > this.sessionCounter) {
      this.sessionCounter = counter;
    }
    return this.publish(session);
  }

  dispose(): void {
    this.listeners.clear();
    this.notificationQueue.length = 0;
    this.sessions.clear();
    this.pendingTickets.clear();
  }

  private advanceTimeline(session: DocumentSession, at: number): void {
    const from = session.lastObservedAt;
    const elapsed = Math.max(0, at - from);
    if (session.lastActivityAt === undefined) {
      session.idleDurationMs += elapsed;
    } else {
      const activeUntil = session.lastActivityAt + this.idleAfterMs;
      const activeEnd = Math.max(from, Math.min(at, activeUntil));
      session.activeDurationMs += Math.max(0, activeEnd - from);
      session.idleDurationMs += Math.max(0, at - Math.max(from, activeUntil));
    }
    session.lastObservedAt = at;
  }

  private createSnapshot(session: DocumentSession, now: number): LiveAuthorMonitorSnapshot {
    const extraActive = session.lastActivityAt === undefined
      ? 0
      : Math.max(0, Math.min(now, session.lastActivityAt + this.idleAfterMs) - session.lastObservedAt);
    const extraIdle = session.lastActivityAt === undefined
      ? Math.max(0, now - session.lastObservedAt)
      : Math.max(0, now - Math.max(session.lastObservedAt, session.lastActivityAt + this.idleAfterMs));
    const activeDurationMs = session.activeDurationMs + extraActive;
    const idleDurationMs = session.idleDurationMs + extraIdle;
    // El ritmo se calcula solo con unidades de operaciones que el editor clasificó
    // explícitamente como typing. Pegados, correcciones, undo/redo y candidatos IME
    // se mantienen en sus contadores, pero no se presentan como escritura normal.
    const wordsPerMinute = activeDurationMs > 0
      ? (session.typingInsertedCharacters / 5) * 60_000 / activeDurationMs
      : 0;
    const charactersPerMinute = activeDurationMs > 0
      ? session.typingInsertedCharacters * 60_000 / activeDurationMs
      : 0;
    const totalCommitResults = session.committedChanges + session.failedChanges;
    const averageCommitLatencyMs = totalCommitResults > 0
      ? session.totalCommitLatencyMs / totalCommitResults
      : 0;
    const state: LiveAuthorActivityState = session.needsResync
      ? "needs-resync"
      : session.lastActivityAt !== undefined && now - session.lastActivityAt <= this.idleAfterMs
        ? "active"
        : "idle";

    return Object.freeze({
      sessionId: session.sessionId,
      projectId: session.projectId,
      documentId: session.documentId,
      state,
      openedAt: session.openedAt,
      lastActivityAt: session.lastActivityAt,
      sessionDurationMs: Math.max(0, now - session.openedAt),
      activeDurationMs,
      idleDurationMs,
      currentIdleMs: session.lastActivityAt === undefined
        ? Math.max(0, now - session.openedAt)
        : Math.max(0, now - session.lastActivityAt - this.idleAfterMs),
      pauseCount: session.pauseCount,
      acceptedChanges: session.acceptedChanges,
      typingChanges: session.typingChanges,
      compositionChanges: session.compositionChanges,
      pasteChanges: session.pasteChanges,
      deletionChanges: session.deletionChanges,
      correctionChanges: session.correctionChanges,
      undoChanges: session.undoChanges,
      redoChanges: session.redoChanges,
      otherChanges: session.otherChanges,
      rejectedChanges: session.rejectedChanges,
      committedChanges: session.committedChanges,
      failedChanges: session.failedChanges,
      pendingChanges: session.pendingTickets.size,
      insertedCharacters: session.insertedCharacters,
      deletedCharacters: session.deletedCharacters,
      typingInsertedCharacters: session.typingInsertedCharacters,
      compositionInsertedCharacters: session.compositionInsertedCharacters,
      compositionDeletedCharacters: session.compositionDeletedCharacters,
      activityUnitMetricsComplete: session.activityUnitMetricsComplete,
      netCharacterDelta: session.insertedCharacters - session.deletedCharacters,
      currentDocumentLength: session.currentDocumentLength,
      estimatedWordsPerMinute: wordsPerMinute,
      insertedCharactersPerMinute: charactersPerMinute,
      latestRevision: session.latestRevision,
      durableRevision: session.durableRevision,
      latestSequence: session.latestSequence,
      durableSequence: session.durableSequence,
      needsResync: session.needsResync,
      resynchronizations: session.resynchronizations,
      lastCommitLatencyMs: session.lastCommitLatencyMs,
      averageCommitLatencyMs,
      commitLatencyP50Ms: percentile(session.commitLatencies, 0.50),
      commitLatencyP95Ms: percentile(session.commitLatencies, 0.95),
      commitLatencySamples: session.commitLatencies.length,
      listenerErrors: session.listenerErrors
    });
  }

  /**
   * Entrega snapshots inmutables en un único drenaje FIFO por instancia.
   * Los callbacks pueden reentrar en el monitor: esas publicaciones se
   * encolan y esperan a que termine la notificación actual. Los destinatarios
   * se fijan por snapshot y se comprueba la suscripción antes de cada llamada.
   */
  private publish(session: DocumentSession): LiveAuthorMonitorSnapshot {
    const snapshot = this.createSnapshot(session, this.readClock(session));
    this.notificationQueue.push({
      snapshot,
      session,
      // Fija los destinatarios al publicar: altas posteriores no reciben
      // snapshots anteriores y las bajas se respetan antes de cada callback.
      subscribers: [...this.listeners]
    });

    // Un callback puede producir otra edición de forma síncrona. Encolamos su
    // snapshot para que ningún suscriptor reciba primero el estado nuevo y
    // después el antiguo.
    if (this.notifyingListeners) return snapshot;

    this.notifyingListeners = true;
    let cursor = 0;
    try {
      while (cursor < this.notificationQueue.length) {
        const notification = this.notificationQueue[cursor++];
        if (!notification) continue;
        for (const subscriber of notification.subscribers) {
          if (!this.listeners.has(subscriber)) continue;
          if (subscriber.documentId !== undefined &&
              subscriber.documentId !== notification.snapshot.documentId) continue;
          try {
            subscriber.listener(notification.snapshot);
          } catch {
            // Solo se cuenta el fallo; no se conserva ni expone el mensaje del error.
            notification.session.listenerErrors++;
          }
        }
      }
    } finally {
      this.notificationQueue.length = 0;
      this.notifyingListeners = false;
    }
    return snapshot;
  }

  private requireSession(documentId: string): DocumentSession {
    const session = this.sessions.get(documentId);
    if (!session) throw new Error("No existe una sesión de monitoreo para " + documentId + ".");
    return session;
  }

  private readClock(session?: DocumentSession): number {
    const value = this.now();
    if (!Number.isFinite(value)) throw new Error("El reloj del monitor debe devolver un número finito.");
    if (session && value < session.lastObservedAt) {
      throw new Error("El reloj del monitor debe ser monotónico y no puede retroceder.");
    }
    return value;
  }
}

/**
 * Superficie pública de HostEngineApi necesaria para conectar un panel.
 * No expone ni conserva el texto del manuscrito.
 */
export type LiveAuthorMonitorCheckpointState =
  | "unavailable" | "not-saved" | "waiting-for-durability" | "saving" | "saved" | "error";

export type LiveAuthorMonitorLeaseState =
  | "unsupported" | "uninitialized" | "owner" | "observer" | "lost"
  | "expired" | "releasing" | "error";

/**
 * Diagnóstico operativo local. Solo expone códigos de error, timestamps y
 * metadatos de coordinación; nunca mensajes arbitrarios ni texto del manuscrito.
 */
export interface LiveAuthorMonitorPersistenceDiagnostics {
  readonly documentId: string;
  readonly checkpointState: LiveAuthorMonitorCheckpointState;
  readonly lastCheckpointAt?: number;
  readonly checkpointErrorCode?: string;
  readonly leaseState: LiveAuthorMonitorLeaseState;
  readonly fencingToken?: number;
  readonly leaseExpiresAt?: number;
  readonly leaseErrorCode?: string;
}

export interface LiveAuthorMonitorHostApi {
  /** Reanuda de forma idempotente las métricas desde el snapshot durable del motor. */
  ensureLiveAuthorMonitorDocument?(documentId: string): LiveAuthorMonitorSnapshot;
  getLiveAuthorMonitorSnapshot(documentId: string): LiveAuthorMonitorSnapshot | undefined;
  /** Estado de persistencia y coordinación, sin datos del manuscrito. */
  getLiveAuthorMonitorPersistenceDiagnostics?(documentId: string): LiveAuthorMonitorPersistenceDiagnostics | undefined;
  getLiveAuthorMonitorSnapshots(): readonly LiveAuthorMonitorSnapshot[];
  subscribeLiveAuthorMonitor(listener: LiveAuthorMonitorListener, documentId?: string): () => void;
}

export interface LiveAuthorMonitorPollingOptions {
  /** Limita las notificaciones a un documento concreto. */
  readonly documentId?: string;
  /** Intervalo de refresco visual; predeterminado: 1000 ms. */
  readonly intervalMs?: number;
  /** Permite inyectar un planificador determinista en pruebas o en el anfitrión. */
  readonly schedule?: (callback: () => void, intervalMs: number) => () => void;
  /** Recibe el snapshot, nunca el mensaje de excepción, si falla una vista. */
  readonly onListenerError?: (snapshot: LiveAuthorMonitorSnapshot) => void;
}

const defaultMonitorRefreshScheduler = (
  callback: () => void,
  intervalMs: number
): (() => void) => {
  const handle = globalThis.setInterval(callback, intervalMs);
  return () => globalThis.clearInterval(handle);
};

/**
 * Combina los eventos inmediatos del motor con refrescos temporales.
 *
 * Los eventos inmediatos reflejan admisiones y commits. El refresco periódico
 * permite que un panel observe el paso de "active" a "idle" aunque el escritor
 * no genere otro evento. El anfitrión controla el ciclo de vida mediante la
 * función de cancelación devuelta.
 */
export function subscribeLiveAuthorMonitorWithRefresh(
  hostApi: LiveAuthorMonitorHostApi,
  listener: LiveAuthorMonitorListener,
  options: LiveAuthorMonitorPollingOptions = {}
): () => void {
  if (typeof listener !== "function") {
    throw new TypeError("El suscriptor del monitor debe ser una función.");
  }

  const intervalMs = options.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60_000) {
    throw new RangeError("intervalMs debe estar entre 1 y 60000 milisegundos.");
  }

  const documentId = options.documentId;
  if (documentId !== undefined &&
      (typeof documentId !== "string" || !documentId.trim())) {
    throw new TypeError("documentId debe ser una cadena no vacía.");
  }
  if (options.onListenerError !== undefined && typeof options.onListenerError !== "function") {
    throw new TypeError("onListenerError debe ser una función.");
  }

  const schedule = options.schedule ?? defaultMonitorRefreshScheduler;
  let disposed = false;

  const deliver: LiveAuthorMonitorListener = snapshot => {
    if (disposed) return;
    try {
      listener(snapshot);
    } catch {
      // El error se reduce a un aviso seguro, sin exponer mensajes del anfitrión.
      try { options.onListenerError?.(snapshot); } catch { /* La telemetría no afecta al escritor. */ }
    }
  };

  const refresh = (): void => {
    if (disposed) return;
    try {
      if (documentId === undefined) {
        for (const snapshot of hostApi.getLiveAuthorMonitorSnapshots()) deliver(snapshot);
      } else {
        const snapshot = hostApi.getLiveAuthorMonitorSnapshot(documentId);
        if (snapshot) deliver(snapshot);
      }
    } catch {
      // Un fallo de observabilidad omite este refresco, no la escritura.
    }
  };

  const unsubscribe = hostApi.subscribeLiveAuthorMonitor(deliver, documentId);
  try {
    // La suscripción se registra antes de la primera lectura para no perder eventos.
    refresh();
    const cancelRefresh = schedule(refresh, intervalMs);
    if (typeof cancelRefresh !== "function") {
      throw new TypeError("El planificador debe devolver una función de cancelación.");
    }

    return () => {
      if (disposed) return;
      disposed = true;
      try { unsubscribe(); } catch { /* La cancelación local debe continuar. */ }
      try { cancelRefresh(); } catch { /* La cancelación local debe ser idempotente. */ }
    };
  } catch (error) {
    disposed = true;
    try { unsubscribe(); } catch { /* Conserva el error original de configuración. */ }
    throw error;
  }
}
