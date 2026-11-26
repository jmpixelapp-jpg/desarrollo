import type { StoredLiveAuthorMonitorLease } from "./contracts";
import type { IndexedDbProjectStore } from "./persistence/indexeddb-store";
import type { SyncExecutionLock } from "./narrative-sync";

export interface IndexedDbSyncExecutionLockOptions {
  /** Identidad única y estable de esta pestaña/worker durante su vida. */
  readonly ownerId: string;
  readonly now?: () => number;
  readonly leaseDurationMs?: number;
  readonly pollIntervalMs?: number;
}

const SYNC_LOCK_DOCUMENT_ID = "__narrative_sync_project__";

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Adaptador de exclusión compartida respaldado por los leases transaccionales
 * de IndexedDB. Todos los contextos deben usar la misma base y un ownerId
 * distinto por contexto.
 */
export class IndexedDbSyncExecutionLock implements SyncExecutionLock {
  private readonly now: () => number;
  private readonly leaseDurationMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly store: IndexedDbProjectStore,
    private readonly options: IndexedDbSyncExecutionLockOptions
  ) {
    if (!options || typeof options.ownerId !== "string" || !options.ownerId.trim()) {
      throw new TypeError("Se requiere un ownerId único para el lease de sincronización.");
    }
    this.now = options.now ?? Date.now;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 150;
    if (!Number.isSafeInteger(this.leaseDurationMs) ||
        this.leaseDurationMs < 1_000 || this.leaseDurationMs > 120_000 ||
        !Number.isSafeInteger(this.pollIntervalMs) ||
        this.pollIntervalMs < 25 || this.pollIntervalMs > 5_000) {
      throw new RangeError("Duración o intervalo de espera del lease no válido.");
    }
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("El reloj del lease de sincronización no es válido.");
    }
    return value;
  }

  async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    if (typeof key !== "string" || !key.startsWith("narrative-sync:") ||
        key.length <= "narrative-sync:".length || typeof task !== "function") {
      throw new TypeError("Clave o tarea inválida para el bloqueo de sincronización.");
    }
    const projectId = key.slice("narrative-sync:".length);
    let lease: StoredLiveAuthorMonitorLease | undefined;
    while (!lease) {
      lease = await this.store.acquireLiveAuthorMonitorLease(
        projectId, SYNC_LOCK_DOCUMENT_ID, this.options.ownerId,
        this.timestamp(), this.leaseDurationMs
      );
      if (!lease) await pause(this.pollIntervalMs);
    }

    let stopped = false;
    let leaseLost = false;
    let renewal: ReturnType<typeof setTimeout> | undefined;
    let renewalFailure: unknown;
    let renewalWork: Promise<void> | undefined;
    const renew = async (): Promise<void> => {
      if (stopped) return;
      try {
        const next = await this.store.renewLiveAuthorMonitorLease(
          lease!, this.timestamp(), this.leaseDurationMs
        );
        if (!next) {
          leaseLost = true;
          return;
        }
        lease = next;
      } catch (error) {
        renewalFailure = error;
        leaseLost = true;
        return;
      }
      if (!stopped) {
        renewal = setTimeout(() => { renewalWork = renew(); }, Math.max(250, Math.floor(this.leaseDurationMs / 3)));
      }
    };
    renewal = setTimeout(() => { void renew(); }, Math.max(250, Math.floor(this.leaseDurationMs / 3)));

    let result!: T;
    let taskFailure: unknown;
    let taskFailed = false;
    try {
      result = await task();
    } catch (error) {
      taskFailed = true;
      taskFailure = error;
    } finally {
      stopped = true;
      if (renewal !== undefined) clearTimeout(renewal);
      if (renewalWork) await renewalWork;
      try {
        const released = await this.store.releaseLiveAuthorMonitorLease(lease, this.timestamp());
        if (!released) leaseLost = true;
      } catch (error) {
        renewalFailure ??= error;
        leaseLost = true;
      }
    }
    if (taskFailed) throw taskFailure;
    if (leaseLost) {
      throw new Error("Se perdió el lease compartido durante la sincronización; el resultado requiere reconciliación.", {
        cause: renewalFailure
      });
    }
    return result;
  }
}
