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
      (idea.status !== "IDEA" && idea.status !== "incorporated" && idea.status !== "discarded") ||
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


import type { NarrativeAssertion } from "./narrative-history";

export interface NarrativeAssertionUpsertPayload {
  readonly assertion: NarrativeAssertion;
}

function isNarrativeAssertion(value: unknown): value is NarrativeAssertion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<NarrativeAssertion>;
  const evidence = item.evidence;
  if (typeof item.projectId !== "string" || !item.projectId.trim() || item.projectId.length > 256 ||
      typeof item.id !== "string" || !item.id.trim() || item.id.length > 512 ||
      typeof item.entityId !== "string" || !item.entityId.trim() || item.entityId.length > 512 ||
      typeof item.entityName !== "string" || !item.entityName.trim() || item.entityName.length > 512 ||
      (item.attribute !== "age" && item.attribute !== "location" && item.attribute !== "role") ||
      !((typeof item.value === "string" && item.value.trim().length > 0 && item.value.length <= 4096) ||
        (typeof item.value === "number" && Number.isFinite(item.value) && item.value >= 0)) ||
      typeof item.capturedAt !== "number" || !Number.isFinite(item.capturedAt) || item.capturedAt < 0 ||
      !evidence || typeof evidence.documentId !== "string" || !evidence.documentId.trim() ||
      evidence.documentId.length > 256 ||
      !Number.isSafeInteger(evidence.revision) || evidence.revision < 0 ||
      !Number.isSafeInteger(evidence.start) || evidence.start < 0 ||
      !Number.isSafeInteger(evidence.end) || evidence.end < evidence.start ||
      typeof evidence.excerpt !== "string" || evidence.excerpt.length > 20_000 ||
      (evidence.status !== undefined && evidence.status !== "stale")) return false;

  if (item.timeReference !== undefined) {
    const time = item.timeReference;
    if (!time || (time.basis !== "calendar" && time.basis !== "story-day") ||
        (time.precision !== "date" && time.precision !== "year" && time.precision !== "day-index") ||
        typeof time.raw !== "string" || !time.raw.trim() || time.raw.length > 128 ||
        !Number.isSafeInteger(time.orderValue) || time.orderValue < 0) return false;
    if ((time.basis === "calendar" && time.precision === "day-index") ||
        (time.basis === "story-day" && time.precision !== "day-index")) return false;
  }
  return true;
}

/**
 * Persiste una afirmación narrativa versionada mediante CAS.
 * Las afirmaciones son históricas: una operación repetida es un no-op cuando
 * el registro ya coincide; una divergencia concurrente deja el replay pendiente.
 */
export function createNarrativeAssertionUpsertHandler(
  store: ProjectStore
): NarrativeSyncOperationHandler<NarrativeAssertionUpsertPayload> {
  if (!store || typeof store.loadAssertions !== "function" ||
      typeof store.saveAssertionIfUnchanged !== "function") {
    throw new TypeError("El store debe implementar loadAssertions y saveAssertionIfUnchanged.");
  }
  return {
    kind: "assertion-upsert",
    validate(payload: unknown): payload is NarrativeAssertionUpsertPayload {
      return Boolean(payload && typeof payload === "object" && !Array.isArray(payload) &&
        isNarrativeAssertion((payload as { assertion?: unknown }).assertion));
    },
    async apply(operation): Promise<void> {
      const assertion = operation.payload.assertion;
      if (assertion.projectId !== operation.projectId) {
        throw new Error("La afirmación de la operación pertenece a otro proyecto.");
      }
      const existing = (await store.loadAssertions!(operation.projectId))
        .find(item => item.id === assertion.id);
      if (existing && JSON.stringify(existing) === JSON.stringify(assertion)) return;
      await store.saveAssertionIfUnchanged!(assertion, existing);
    }
  };
}
