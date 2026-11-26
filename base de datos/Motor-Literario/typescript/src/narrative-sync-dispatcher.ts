import type { NarrativeSyncOperationEnvelope } from "./narrative-sync-integrity";

/**
 * Un handler declara explícitamente qué forma de payload acepta y cómo aplica
 * la operación. La validación del digest ocurre antes, en el diario de entrada.
 */
export interface NarrativeSyncOperationHandler<T = unknown> {
  readonly kind: string;
  readonly validate: (payload: unknown) => payload is T;
  readonly apply: (operation: NarrativeSyncOperationEnvelope<T>) => Promise<void>;
}

export interface NarrativeSyncDispatchOptions {
  /** Permite que el anfitrión audite operaciones rechazadas sin exponer payloads. */
  readonly onRejected?: (operation: NarrativeSyncOperationEnvelope, reason: string) => void;
}

export type NarrativeSyncDispatchFailure =
  | "unknown-kind"
  | "invalid-payload";

/**
 * Crea un dispatcher cerrado: solo procesa kinds registrados y payloads que
 * superan el validador de su handler. No interpreta ni muta el grafo por sí solo.
 *
 * Los handlers deben aplicar cambios idempotentes por operationId: el diario
 * ofrece entrega al menos una vez, no una transacción con las proyecciones.
 */
export function createNarrativeSyncOperationDispatcher(
  handlers: readonly NarrativeSyncOperationHandler[],
  options: NarrativeSyncDispatchOptions = {}
): (operation: NarrativeSyncOperationEnvelope) => Promise<void> {
  if (!Array.isArray(handlers)) {
    throw new TypeError("Los handlers de sincronización deben ser una lista.");
  }
  const registry = new Map<string, NarrativeSyncOperationHandler>();
  for (const handler of handlers) {
    if (!handler || typeof handler.kind !== "string" || !handler.kind.trim() ||
        typeof handler.validate !== "function" || typeof handler.apply !== "function") {
      throw new TypeError("Cada handler requiere kind, validate y apply válidos.");
    }
    if (registry.has(handler.kind)) {
      throw new Error("Existe más de un handler para el kind: " + handler.kind);
    }
    registry.set(handler.kind, handler);
  }

  return async (operation: NarrativeSyncOperationEnvelope): Promise<void> => {
    if (!operation || typeof operation.kind !== "string") {
      throw new TypeError("La operación de sincronización no contiene kind.");
    }
    const handler = registry.get(operation.kind);
    if (!handler) {
      options.onRejected?.(operation, "unknown-kind");
      throw new Error("No existe un handler registrado para: " + operation.kind);
    }
    let valid = false;
    try {
      valid = handler.validate(operation.payload);
    } catch {
      valid = false;
    }
    if (!valid) {
      options.onRejected?.(operation, "invalid-payload");
      throw new Error("El payload no cumple el contrato del handler: " + operation.kind);
    }
    await handler.apply(operation);
  };
}
