import {
  createNarrativeSyncOperationEnvelope,
  type NarrativeSyncOperationEnvelope
} from "./narrative-sync-integrity";
import type { StoredSyncOperation } from "./contracts";

export interface NarrativeSyncOutboxStore {
  loadPendingSyncOperations(projectId: string, limit?: number): Promise<readonly StoredSyncOperation[]>;
  recordSyncOperationAttempt(operationId: string, attemptedAt: number, errorCode?: string): Promise<boolean>;
  acknowledgeSyncOperation(operationId: string): Promise<boolean>;
}

export interface NarrativeSyncRemoteAcknowledgement {
  readonly status: "accepted" | "duplicate";
  readonly durable: true;
  readonly projectId: string;
  readonly operationId: string;
  readonly writerId: string;
  readonly sequence: number;
  readonly digest: string;
}

export interface NarrativeSyncOutboxTransport {
  send(operation: NarrativeSyncOperationEnvelope): Promise<NarrativeSyncRemoteAcknowledgement>;
}

export interface NarrativeSyncOutboxDispatchOptions {
  readonly store: NarrativeSyncOutboxStore;
  readonly transport: NarrativeSyncOutboxTransport;
  readonly projectId: string;
  readonly batchSize?: number;
  readonly now?: () => number;
}

export type NarrativeSyncOutboxDispatchFailure =
  | "already-running"
  | "invalid-local-operation"
  | "transport-error"
  | "invalid-remote-acknowledgement"
  | "attempt-persistence-failed"
  | "operation-no-longer-pending"
  | "local-acknowledgement-failed";

export interface NarrativeSyncOutboxDispatchResult {
  readonly processed: number;
  readonly remaining: number;
  readonly hasMore: boolean;
  readonly stoppedAtOperationId?: string;
  readonly failure?: NarrativeSyncOutboxDispatchFailure;
}

const activeProjectDispatches = new Set<string>();

function isMatchingDurableAcknowledgement(
  acknowledgement: unknown,
  operation: NarrativeSyncOperationEnvelope
): acknowledgement is NarrativeSyncRemoteAcknowledgement {
  if (!acknowledgement || typeof acknowledgement !== "object") return false;
  const value = acknowledgement as Partial<NarrativeSyncRemoteAcknowledgement>;
  return (value.status === "accepted" || value.status === "duplicate") &&
    value.durable === true &&
    value.projectId === operation.projectId &&
    value.operationId === operation.operationId &&
    value.writerId === operation.writerId &&
    value.sequence === operation.sequence &&
    value.digest === operation.digest;
}

async function recordAttempt(
  store: NarrativeSyncOutboxStore,
  operationId: string,
  now: () => number,
  errorCode?: string
): Promise<boolean> {
  const timestamp = now();
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new RangeError("El reloj del anfitrión devolvió una fecha inválida.");
  }
  return store.recordSyncOperationAttempt(operationId, timestamp, errorCode);
}

/**
 * Despacha la outbox local en orden de dispositivo/secuencia.
 * La entrega es al menos una vez: el servidor deduplica operationId y digest.
 * writerId identifica aquí el stream de dispositivo, no una persona.
 * El anfitrión proporciona el transporte autenticado; esta función no configura HTTP.
 */
export async function dispatchPendingNarrativeSyncOperations(
  options: NarrativeSyncOutboxDispatchOptions
): Promise<NarrativeSyncOutboxDispatchResult> {
  if (!options || !options.store ||
      typeof options.store.loadPendingSyncOperations !== "function" ||
      typeof options.store.recordSyncOperationAttempt !== "function" ||
      typeof options.store.acknowledgeSyncOperation !== "function" ||
      !options.transport || typeof options.transport.send !== "function" ||
      typeof options.projectId !== "string" || !options.projectId.trim()) {
    throw new TypeError("El despachador requiere proyecto, almacén y transporte válidos.");
  }
  const batchSize = options.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new RangeError("batchSize debe ser un entero entre 1 y 1000.");
  }
  const now = options.now ?? Date.now;
  if (typeof now !== "function") throw new TypeError("now debe ser una función.");
  if (activeProjectDispatches.has(options.projectId)) {
    return { processed: 0, remaining: 0, hasMore: false, failure: "already-running" };
  }
  activeProjectDispatches.add(options.projectId);
  try {
    const pending = await options.store.loadPendingSyncOperations(options.projectId, batchSize);
    let processed = 0;
    for (const stored of pending) {
      let envelope: NarrativeSyncOperationEnvelope;
      try {
        if (!stored || stored.projectId !== options.projectId ||
            typeof stored.deviceId !== "string" || !stored.deviceId.trim() ||
            typeof stored.payload !== "string") {
          throw new TypeError("La operación pendiente no coincide con el proyecto o dispositivo.");
        }
        const payload: unknown = JSON.parse(stored.payload);
        envelope = await createNarrativeSyncOperationEnvelope({
          operationId: stored.operationId,
          projectId: stored.projectId,
          writerId: stored.deviceId,
          sequence: stored.sequence,
          createdAt: stored.createdAt,
          kind: stored.kind,
          payload
        });
      } catch {
        try { await recordAttempt(options.store, stored.operationId, now, "INVALID_LOCAL_OPERATION"); }
        catch { return { processed, remaining: pending.length - processed, hasMore: pending.length === batchSize, stoppedAtOperationId: stored.operationId, failure: "attempt-persistence-failed" }; }
        return { processed, remaining: pending.length - processed, hasMore: pending.length === batchSize, stoppedAtOperationId: stored.operationId, failure: "invalid-local-operation" };
      }
      let acknowledgement: NarrativeSyncRemoteAcknowledgement;
      try {
        acknowledgement = await options.transport.send(envelope);
      } catch {
        try { await recordAttempt(options.store, stored.operationId, now, "TRANSPORT_ERROR"); }
        catch { return { processed, remaining: pending.length - processed, hasMore: pending.length === batchSize, stoppedAtOperationId: stored.operationId, failure: "attempt-persistence-failed" }; }
        return { processed, remaining: pending.length - processed, hasMore: pending.length === batchSize, stoppedAtOperationId: stored.operationId, failure: "transport-error" };
      }
      if (!isMatchingDurableAcknowledgement(acknowledgement, envelope)) {
        try { await recordAttempt(options.store, stored.operationId, now, "INVALID_REMOTE_ACK"); }
        catch { return { processed, remaining: pending.length - processed, hasMore: pending.length === batchSize, stoppedAtOperationId: stored.operationId, failure: "attempt-persistence-failed" }; }
        return { processed, remaining: pending.length - processed, hasMore: pending.length === batchSize, stoppedAtOperationId: stored.operationId, failure: "invalid-remote-acknowledgement" };
      }
      let recorded: boolean;
      try { recorded = await recordAttempt(options.store, stored.operationId, now); }
      catch { return { processed, remaining: pending.length - processed, hasMore: pending.length === batchSize, stoppedAtOperationId: stored.operationId, failure: "attempt-persistence-failed" }; }
      if (!recorded) {
        return { processed, remaining: pending.length - processed, hasMore: pending.length === batchSize, stoppedAtOperationId: stored.operationId, failure: "operation-no-longer-pending" };
      }
      let acknowledged: boolean;
      try { acknowledged = await options.store.acknowledgeSyncOperation(stored.operationId); }
      catch { return { processed, remaining: pending.length - processed, hasMore: pending.length === batchSize, stoppedAtOperationId: stored.operationId, failure: "local-acknowledgement-failed" }; }
      if (!acknowledged) {
        return { processed, remaining: pending.length - processed, hasMore: pending.length === batchSize, stoppedAtOperationId: stored.operationId, failure: "local-acknowledgement-failed" };
      }
      processed++;
    }
    return { processed, remaining: pending.length - processed, hasMore: pending.length === batchSize };
  } finally {
    activeProjectDispatches.delete(options.projectId);
  }
}
