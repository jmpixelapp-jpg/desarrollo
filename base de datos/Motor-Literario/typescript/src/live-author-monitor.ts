import type {
  ChangeAdmission,
  CommitResult,
  DocumentSnapshot,
  EditorChange
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
  readonly rejectedChanges: number;
  readonly committedChanges: number;
  readonly failedChanges: number;
  readonly pendingChanges: number;
  readonly insertedCharacters: number;
  readonly deletedCharacters: number;
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
  rejectedChanges: number;
  committedChanges: number;
  failedChanges: number;
  insertedCharacters: number;
  deletedCharacters: number;
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
  private readonly listeners = new Set<{ listener: LiveAuthorMonitorListener; documentId?: string }>();
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
    const session: DocumentSession = {
      sessionId: projectId + ":" + snapshot.documentId + ":" + (++this.sessionCounter),
      projectId,
      documentId: snapshot.documentId,
      openedAt,
      lastObservedAt: openedAt,
      lastActivityAt: undefined,
      activeDurationMs: 0,
      idleDurationMs: 0,
      pauseCount: 0,
      acceptedChanges: 0,
      rejectedChanges: 0,
      committedChanges: 0,
      failedChanges: 0,
      insertedCharacters: 0,
      deletedCharacters: 0,
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

  dispose(): void {
    this.listeners.clear();
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
    const wordsPerMinute = activeDurationMs > 0
      ? (session.insertedCharacters / 5) * 60_000 / activeDurationMs
      : 0;
    const charactersPerMinute = activeDurationMs > 0
      ? session.insertedCharacters * 60_000 / activeDurationMs
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
      rejectedChanges: session.rejectedChanges,
      committedChanges: session.committedChanges,
      failedChanges: session.failedChanges,
      pendingChanges: session.pendingTickets.size,
      insertedCharacters: session.insertedCharacters,
      deletedCharacters: session.deletedCharacters,
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
      commitLatencySamples: session.commitLatencies.length
    });
  }

  private publish(session: DocumentSession): LiveAuthorMonitorSnapshot {
    const snapshot = this.createSnapshot(session, this.readClock(session));
    for (const entry of this.listeners) {
      if (entry.documentId !== undefined && entry.documentId !== session.documentId) continue;
      try { entry.listener(snapshot); } catch { /* Un panel no debe interrumpir la escritura. */ }
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