import {
  replayPendingNarrativeSyncOperations,
  inspectNarrativeSyncJournalIntegrity,
  type IndexedDbNarrativeSyncJournal,
  type NarrativeSyncJournalIntegrityReport,
  type NarrativeSyncReplayResult
} from "./narrative-sync-journal";
import { recoverNarrativeReferenceRepairs, type NarrativeReferenceRepairRecoveryResult } from "./narrative-knowledge-graph-persistence";
import type { ProjectStore } from "./contracts";
import {
  createNarrativeSyncOperationDispatcher,
  type AnyNarrativeSyncOperationHandler,
  type NarrativeSyncDispatchOptions
} from "./narrative-sync-dispatcher";

/**
 * Opciones del consumidor que conecta el diario durable con el dispatcher.
 * La autenticación/autorización del escritor y del proyecto pertenece al
 * anfitrión o al servidor; verificar SHA-256 no autentica al emisor.
 */
export interface NarrativeSyncJournalConsumerOptions extends NarrativeSyncDispatchOptions {}

/**
 * Crea un consumidor de operaciones narrativas recibidas.
 *
 * El diario valida la envoltura antes de entregar cada operación. El dispatcher
 * restringe la ejecución a handlers registrados y payloads válidos. El replay
 * confirma cada operación solo después de que el handler termina correctamente.
 *
 * La entrega es al menos una vez: los handlers deben ser idempotentes por
 * operationId y coordinar sus escrituras con sus propias garantías CAS/atómicas.
 * La exclusión de replay es local al runtime, no un mutex entre pestañas.
 */
export function createNarrativeSyncJournalConsumer(
  journal: IndexedDbNarrativeSyncJournal,
  handlers: readonly AnyNarrativeSyncOperationHandler[],
  options: NarrativeSyncJournalConsumerOptions = {}
): (
  projectId: string,
  writerId?: string
) => Promise<NarrativeSyncReplayResult> {
  if (!journal || typeof journal.loadPendingOperations !== "function" ||
      typeof journal.markApplied !== "function") {
    throw new TypeError("El consumidor requiere un diario narrativo durable válido.");
  }
  const dispatch = createNarrativeSyncOperationDispatcher(handlers, options);
  return (projectId, writerId) =>
    replayPendingNarrativeSyncOperations(journal, projectId, dispatch, writerId);
}


/** Resultado del consumo protegido por recuperación del grafo. */
export interface RecoveryFirstNarrativeSyncResult {
  readonly recovery: NarrativeReferenceRepairRecoveryResult;
  readonly blockedByPendingRepairs: boolean;
  readonly blockedByJournalIntegrity: boolean;
  readonly journalIntegrity: NarrativeSyncJournalIntegrityReport;
  readonly replay?: NarrativeSyncReplayResult;
}

/**
 * Construye el límite recomendado para sincronización entrante: reanuda las
 * reparaciones durables antes de reproducir operaciones remotas. Si quedan
 * reparaciones en conflicto, no ejecuta handlers; el anfitrión puede mostrar
 * las incidencias y reintentar después de resolverlas.
 */
export function createRecoveryFirstNarrativeSyncConsumer(
  store: ProjectStore,
  journal: IndexedDbNarrativeSyncJournal,
  handlers: readonly AnyNarrativeSyncOperationHandler[],
  options: NarrativeSyncJournalConsumerOptions = {}
): (projectId: string, writerId?: string) => Promise<RecoveryFirstNarrativeSyncResult> {
  if (!store || typeof store.loadNarrativeReferenceRepairPending !== "function" ||
      typeof store.appendNarrativeReferenceRepairAudit !== "function" ||
      typeof store.deleteNarrativeReferenceRepairPending !== "function") {
    throw new TypeError("La sincronización protegida requiere persistencia durable de reparaciones.");
  }
  const consume = createNarrativeSyncJournalConsumer(journal, handlers, options);
  return async (projectId, writerId) => {
    const recovery = await recoverNarrativeReferenceRepairs(store, projectId);
    if (recovery.pending.length > 0) {
      return {
        recovery,
        blockedByPendingRepairs: true,
        blockedByJournalIntegrity: false,
        journalIntegrity: await inspectNarrativeSyncJournalIntegrity(journal, projectId)
      };
    }
    const journalIntegrity = await inspectNarrativeSyncJournalIntegrity(journal, projectId);
    if (!journalIntegrity.intact) {
      return {
        recovery,
        blockedByPendingRepairs: false,
        blockedByJournalIntegrity: true,
        journalIntegrity
      };
    }
    const replay = await consume(projectId, writerId);
    return { recovery, blockedByPendingRepairs: false, blockedByJournalIntegrity: false, journalIntegrity, replay };
  };
}
