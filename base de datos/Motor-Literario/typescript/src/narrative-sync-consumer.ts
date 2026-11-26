import {
  replayPendingNarrativeSyncOperations,
  type IndexedDbNarrativeSyncJournal,
  type NarrativeSyncReplayResult
} from "./narrative-sync-journal";
import {
  createNarrativeSyncOperationDispatcher,
  type NarrativeSyncOperationHandler,
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
  handlers: readonly NarrativeSyncOperationHandler[],
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
