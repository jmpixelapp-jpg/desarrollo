import type { ProjectStore } from "./contracts";
import type { NarrativeIdea } from "./narrative-knowledge";
import type { NarrativeSyncOperationHandler } from "./narrative-sync-dispatcher";

export interface NarrativeIdeaUpsertPayload {
  readonly idea: NarrativeIdea;
}

/**
 * Construye el handler de dominio para la operación versionada idea-upsert.
 *
 * El payload contiene el registro completo y el projectId del sobre debe
 * coincidir con el de la idea. La escritura usa CAS; si otra instancia cambia
 * la idea entre lectura y escritura, el conflicto se propaga y el diario deja
 * la operación pendiente para que el anfitrión reconcilie la edición.
 *
 * Repetir la misma operación después de una caída entre escritura y acuse es
 * inocuo: la comparación exacta detecta que el estado ya fue aplicado.
 */
export function createNarrativeIdeaUpsertHandler(
  store: ProjectStore
): NarrativeSyncOperationHandler<NarrativeIdeaUpsertPayload> {
  if (!store || typeof store.loadIdeas !== "function" ||
      typeof store.saveIdeaIfUnchanged !== "function") {
    throw new TypeError("El store debe implementar loadIdeas y saveIdeaIfUnchanged.");
  }

  return {
    kind: "idea-upsert",
    validate(payload: unknown): payload is NarrativeIdeaUpsertPayload {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
      const idea = (payload as { idea?: unknown }).idea;
      if (!idea || typeof idea !== "object" || Array.isArray(idea)) return false;
      const value = idea as Partial<NarrativeIdea>;
      return typeof value.projectId === "string" && value.projectId.trim().length > 0 &&
        typeof value.id === "string" && value.id.trim().length > 0 &&
        typeof value.text === "string" &&
        (value.status === "IDEA" || value.status === "incorporated" || value.status === "discarded") &&
        typeof value.originDocumentId === "string" && value.originDocumentId.trim().length > 0 &&
        typeof value.sourceProjectName === "string" && value.sourceProjectName.trim().length > 0 &&
        Array.isArray(value.evidence) &&
        value.evidence.every(item => item && typeof item.documentId === "string" &&
          Number.isSafeInteger(item.revision) && item.revision >= 0 &&
          Number.isSafeInteger(item.start) && item.start >= 0 &&
          Number.isSafeInteger(item.end) && item.end >= item.start &&
          typeof item.excerpt === "string");
    },
    async apply(operation): Promise<void> {
      const idea = operation.payload.idea;
      if (idea.projectId !== operation.projectId) {
        throw new Error("La idea de la operación pertenece a otro proyecto.");
      }
      const existing = (await store.loadIdeas!(operation.projectId))
        .find(item => item.id === idea.id);
      if (existing && JSON.stringify(existing) === JSON.stringify(idea)) return;
      await store.saveIdeaIfUnchanged!(idea, existing);
    }
  };
}
