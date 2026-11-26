import type { ProjectStore } from "./contracts";
import { MAX_NARRATIVE_IDEA_REFERENCES, type NarrativeIdea } from "./narrative-knowledge";
import type { NarrativeSyncOperationHandler } from "./narrative-sync-dispatcher";

export interface NarrativeIdeaUpsertPayload {
  readonly idea: NarrativeIdea;
}

function isBoundedIdentifierList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= MAX_NARRATIVE_IDEA_REFERENCES &&
    value.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 256) &&
    new Set(value).size === value.length;
}

function isNarrativeIdea(value: unknown): value is NarrativeIdea {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const idea = value as Partial<NarrativeIdea>;
  if (typeof idea.projectId !== "string" || !idea.projectId.trim() || idea.projectId.length > 256 ||
      typeof idea.id !== "string" || !idea.id.trim() || idea.id.length > 512 ||
      typeof idea.text !== "string" || idea.text.length > 1_000_000 ||
      !["IDEA", "incorporated", "discarded"].includes(idea.status ?? "") ||
      typeof idea.originDocumentId !== "string" || !idea.originDocumentId.trim() ||
      idea.originDocumentId.length > 256 ||
      typeof idea.sourceProjectName !== "string" || !idea.sourceProjectName.trim() ||
      idea.sourceProjectName.length > 512 ||
      !Array.isArray(idea.evidence) || idea.evidence.length > 10_000) return false;

  if (!idea.evidence.every(item => item && typeof item.documentId === "string" &&
      item.documentId.trim().length > 0 && item.documentId.length <= 256 &&
      Number.isSafeInteger(item.revision) && item.revision >= 0 &&
      Number.isSafeInteger(item.start) && item.start >= 0 &&
      Number.isSafeInteger(item.end) && item.end >= item.start &&
      typeof item.excerpt === "string" && item.excerpt.length <= 20_000 &&
      (item.status === undefined || item.status === "stale"))) return false;

  if (idea.relatedEntityIds !== undefined && !isBoundedIdentifierList(idea.relatedEntityIds)) return false;
  if (idea.relatedIdeaIds !== undefined && !isBoundedIdentifierList(idea.relatedIdeaIds)) return false;
  if (idea.statusHistory !== undefined) {
    if (!Array.isArray(idea.statusHistory) || idea.statusHistory.length > 10_000 ||
        !idea.statusHistory.every(change => change &&
          ["IDEA", "incorporated", "discarded"].includes(change.status) &&
          ["initial", "writer", "text-revised"].includes(change.reason) &&
          (change.changedAt === undefined ||
            (Number.isFinite(change.changedAt) && change.changedAt >= 0)))) return false;
  }
  return true;
}

/**
 * Construye el handler de dominio para la operación versionada idea-upsert.
 *
 * El payload contiene el registro completo y el projectId del sobre debe
 * coincidir con el de la idea. La escritura usa CAS; si otra instancia cambia
 * la idea entre lectura y escritura, el conflicto se propaga y el diario deja
 * la operación pendiente para que el anfitrión reconcilie la edición.
 *
 * Repetir la misma operación después de una caída entre el CAS de dominio y
 * el acuse del diario es inocuo: la comparación exacta detecta que el estado
 * ya fue aplicado.
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
      return Boolean(payload && typeof payload === "object" && !Array.isArray(payload) &&
        isNarrativeIdea((payload as { idea?: unknown }).idea));
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
