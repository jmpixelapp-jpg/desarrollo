import type { ProjectStore } from "./contracts";
import { areNarrativeSyncPayloadsEquivalent } from "./narrative-sync-integrity";
import {
  MAX_NARRATIVE_IDEA_REFERENCES,
  normalizeEntityName,
  type NarrativeEntity,
  type NarrativeIdea,
  type NarrativeRelation,
  type NarrativeEvent,
  type NarrativeTimeReference,
  type TextEvidence
} from "./narrative-knowledge";
import type { NarrativeAssertion } from "./narrative-history";
import type { NarrativeSyncOperationHandler } from "./narrative-sync-dispatcher";
import type { NarrativeIdeaContinuityIndexSyncPayload } from "./narrative-idea-continuity-index";
import {
  areNarrativeIdeaContinuityIndexesEquivalent,
  validateNarrativeIdeaContinuityIndex
} from "./narrative-idea-continuity-index";

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
      if (existing && areNarrativeSyncPayloadsEquivalent(existing, idea)) return;
      await store.saveIdeaIfUnchanged!(idea, existing);
    }
  };
}


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
      if (existing && areNarrativeSyncPayloadsEquivalent(existing, assertion)) return;
      await store.saveAssertionIfUnchanged!(assertion, existing);
    }
  };
}


export interface NarrativeRelationUpsertPayload {
  readonly relation: NarrativeRelation;
}

export interface NarrativeEventUpsertPayload {
  readonly event: NarrativeEvent;
}

function isTextEvidence(value: unknown): value is TextEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<TextEvidence>;
  return typeof item.documentId === "string" && !!item.documentId.trim() &&
    item.documentId.length <= 256 &&
    Number.isSafeInteger(item.revision) && item.revision! >= 0 &&
    Number.isSafeInteger(item.start) && item.start! >= 0 &&
    Number.isSafeInteger(item.end) && item.end! >= item.start! &&
    typeof item.excerpt === "string" && item.excerpt.length <= 20_000 &&
    (item.status === undefined || item.status === "stale");
}

function isTimeReference(value: unknown): value is NarrativeTimeReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<NarrativeTimeReference>;
  return (item.basis === "calendar" || item.basis === "story-day") &&
    (item.precision === "date" || item.precision === "year" || item.precision === "day-index") &&
    typeof item.raw === "string" && !!item.raw.trim() && item.raw.length <= 128 &&
    Number.isSafeInteger(item.orderValue) && item.orderValue! >= 0 &&
    !((item.basis === "calendar" && item.precision === "day-index") ||
      (item.basis === "story-day" && item.precision !== "day-index"));
}

function isNarrativeRelation(value: unknown): value is NarrativeRelation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<NarrativeRelation>;
  return typeof item.projectId === "string" && !!item.projectId.trim() && item.projectId.length <= 256 &&
    typeof item.id === "string" && !!item.id.trim() && item.id.length <= 512 &&
    typeof item.fromEntityId === "string" && !!item.fromEntityId.trim() && item.fromEntityId.length <= 512 &&
    typeof item.toEntityId === "string" && !!item.toEntityId.trim() && item.toEntityId.length <= 512 &&
    typeof item.relationType === "string" && !!item.relationType.trim() && item.relationType.length <= 256 &&
    Array.isArray(item.evidence) && item.evidence.length > 0 && item.evidence.length <= 10_000 &&
    item.evidence.every(isTextEvidence);
}

function isNarrativeEvent(value: unknown): value is NarrativeEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<NarrativeEvent>;
  return typeof item.projectId === "string" && !!item.projectId.trim() && item.projectId.length <= 256 &&
    typeof item.id === "string" && !!item.id.trim() && item.id.length <= 512 &&
    typeof item.label === "string" && !!item.label.trim() && item.label.length <= 2048 &&
    Array.isArray(item.participants) && item.participants.length <= 500 &&
    item.participants.every(id => typeof id === "string" && !!id.trim() && id.length <= 512) &&
    new Set(item.participants).size === item.participants.length &&
    Array.isArray(item.evidence) && item.evidence.length > 0 && item.evidence.length <= 10_000 &&
    item.evidence.every(isTextEvidence) &&
    (item.timelineTrackId === undefined ||
      (typeof item.timelineTrackId === "string" && !!item.timelineTrackId.trim() && item.timelineTrackId.length <= 256)) &&
    (item.timeReference === undefined || isTimeReference(item.timeReference));
}

export function createNarrativeRelationUpsertHandler(
  store: ProjectStore
): NarrativeSyncOperationHandler<NarrativeRelationUpsertPayload> {
  if (!store || typeof store.loadRelations !== "function" ||
      typeof store.saveRelationIfUnchanged !== "function") {
    throw new TypeError("El store debe implementar loadRelations y saveRelationIfUnchanged.");
  }
  return {
    kind: "relation-upsert",
    validate(payload: unknown): payload is NarrativeRelationUpsertPayload {
      return Boolean(payload && typeof payload === "object" && !Array.isArray(payload) &&
        isNarrativeRelation((payload as { relation?: unknown }).relation));
    },
    async apply(operation): Promise<void> {
      const relation = operation.payload.relation;
      if (relation.projectId !== operation.projectId) {
        throw new Error("La relación de la operación pertenece a otro proyecto.");
      }
      const existing = (await store.loadRelations!(operation.projectId))
        .find(item => item.id === relation.id);
      if (existing && areNarrativeSyncPayloadsEquivalent(existing, relation)) return;
      await store.saveRelationIfUnchanged!(relation, existing);
    }
  };
}

export function createNarrativeEventUpsertHandler(
  store: ProjectStore
): NarrativeSyncOperationHandler<NarrativeEventUpsertPayload> {
  if (!store || typeof store.loadEvents !== "function" ||
      typeof store.saveEventIfUnchanged !== "function") {
    throw new TypeError("El store debe implementar loadEvents y saveEventIfUnchanged.");
  }
  return {
    kind: "event-upsert",
    validate(payload: unknown): payload is NarrativeEventUpsertPayload {
      return Boolean(payload && typeof payload === "object" && !Array.isArray(payload) &&
        isNarrativeEvent((payload as { event?: unknown }).event));
    },
    async apply(operation): Promise<void> {
      const event = operation.payload.event;
      if (event.projectId !== operation.projectId) {
        throw new Error("El acontecimiento de la operación pertenece a otro proyecto.");
      }
      const existing = (await store.loadEvents!(operation.projectId))
        .find(item => item.id === event.id);
      if (existing && areNarrativeSyncPayloadsEquivalent(existing, event)) return;
      await store.saveEventIfUnchanged!(event, existing);
    }
  };
}


export interface NarrativeEntityUpsertPayload {
  readonly entity: NarrativeEntity;
}

function isNarrativeEntity(value: unknown): value is NarrativeEntity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<NarrativeEntity>;
  const validNames = (names: unknown): names is readonly string[] =>
    Array.isArray(names) && names.length <= 2_000 &&
    names.every(name => typeof name === "string" && !!name.trim() && name.length <= 512) &&
    new Set(names.map(name => normalizeEntityName(name))).size === names.length;
  const validMergedIds = (ids: unknown): ids is readonly string[] =>
    Array.isArray(ids) && ids.length <= 2_000 &&
    ids.every(id => typeof id === "string" && !!id.trim() && id.length <= 512) &&
    new Set(ids).size === ids.length;
  const validEvidence = Array.isArray(item.evidence) && item.evidence.length <= 10_000 &&
    item.evidence.every(isTextEvidence);
  return typeof item.projectId === "string" && !!item.projectId.trim() && item.projectId.length <= 256 &&
    typeof item.id === "string" && !!item.id.trim() && item.id.length <= 512 &&
    typeof item.kind === "string" && !!item.kind.trim() && item.kind.length <= 128 &&
    typeof item.canonicalName === "string" && !!item.canonicalName.trim() && item.canonicalName.length <= 512 &&
    typeof item.normalizedName === "string" && item.normalizedName.length <= 512 &&
    item.normalizedName === normalizeEntityName(item.canonicalName) &&
    validNames(item.aliases) &&
    !item.aliases.some(alias => normalizeEntityName(alias) === item.normalizedName) &&
    (item.mergedFromIds === undefined || validMergedIds(item.mergedFromIds)) &&
    validEvidence &&
    typeof item.firstSeenAt === "number" && Number.isFinite(item.firstSeenAt) && item.firstSeenAt >= 0 &&
    typeof item.lastSeenAt === "number" && Number.isFinite(item.lastSeenAt) &&
    item.lastSeenAt >= item.firstSeenAt &&
    item.extractionVersion === 1;
}

/**
 * Persiste una ficha de identidad narrativa sin fusionar identidades por heurística.
 * Los alias son explícitos y la fusión de duplicados debe pasar por el flujo atómico
 * de consolidación de identidad del store, nunca por este upsert.
 */
export function createNarrativeEntityUpsertHandler(
  store: ProjectStore
): NarrativeSyncOperationHandler<NarrativeEntityUpsertPayload> {
  if (!store || typeof store.loadEntities !== "function" ||
      typeof store.saveEntityIfUnchanged !== "function") {
    throw new TypeError("El store debe implementar loadEntities y saveEntityIfUnchanged.");
  }
  return {
    kind: "entity-upsert",
    validate(payload: unknown): payload is NarrativeEntityUpsertPayload {
      return Boolean(payload && typeof payload === "object" && !Array.isArray(payload) &&
        isNarrativeEntity((payload as { entity?: unknown }).entity));
    },
    async apply(operation): Promise<void> {
      const entity = operation.payload.entity;
      if (entity.projectId !== operation.projectId) {
        throw new Error("La entidad de la operación pertenece a otro proyecto.");
      }
      const existing = (await store.loadEntities!(operation.projectId))
        .find(item => item.id === entity.id);
      if (existing && areNarrativeSyncPayloadsEquivalent(existing, entity)) return;
      await store.saveEntityIfUnchanged!(entity, existing);
    }
  };
}


export interface NarrativeEntityMergePayload {
  readonly targetEntityId: string;
  readonly sourceEntityId: string;
  readonly writerId?: string;
}

/**
 * La consolidación delega en la primitiva transaccional del ProjectStore.
 * Nunca se emula con varios upserts: deben redirigirse todas las referencias
 * y conservarse los snapshots archivados en una sola transacción.
 */
export function createNarrativeEntityMergeHandler(
  store: ProjectStore
): NarrativeSyncOperationHandler<NarrativeEntityMergePayload> {
  if (!store || typeof store.mergeNarrativeEntityIdentity !== "function") {
    throw new TypeError("El store debe implementar mergeNarrativeEntityIdentity atómico.");
  }
  return {
    kind: "entity-merge",
    validate(payload: unknown): payload is NarrativeEntityMergePayload {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
      const item = payload as Partial<NarrativeEntityMergePayload>;
      return typeof item.targetEntityId === "string" && !!item.targetEntityId.trim() &&
        item.targetEntityId.length <= 512 &&
        typeof item.sourceEntityId === "string" && !!item.sourceEntityId.trim() &&
        item.sourceEntityId.length <= 512 && item.targetEntityId !== item.sourceEntityId &&
        (item.writerId === undefined ||
          (typeof item.writerId === "string" && !!item.writerId.trim() && item.writerId.length <= 256));
    },
    async apply(operation): Promise<void> {
      await store.mergeNarrativeEntityIdentity!(
        operation.projectId,
        operation.payload.targetEntityId,
        operation.payload.sourceEntityId,
        operation.payload.writerId
      );
    }
  };
}


/**
 * Replica un snapshot derivado con CAS. No modifica ideas canónicas: el índice
 * es una proyección reconstruible y la divergencia se deja pendiente para que
 * el anfitrión vuelva a calcularla desde las fuentes documentales.
 */
export function createNarrativeIdeaContinuityIndexUpsertHandler(
  store: ProjectStore
): NarrativeSyncOperationHandler<NarrativeIdeaContinuityIndexSyncPayload> {
  if (!store ||
      typeof store.loadNarrativeIdeaContinuityIndex !== "function" ||
      typeof store.saveNarrativeIdeaContinuityIndexIfUnchanged !== "function") {
    throw new TypeError("El store debe implementar loadNarrativeIdeaContinuityIndex y saveNarrativeIdeaContinuityIndexIfUnchanged.");
  }

  return {
    kind: "idea-continuity-index-upsert",
    validate(payload: unknown): payload is NarrativeIdeaContinuityIndexSyncPayload {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
      const item = payload as Partial<NarrativeIdeaContinuityIndexSyncPayload>;
      try {
        if (!item.index) return false;
        validateNarrativeIdeaContinuityIndex(item.index);
      } catch {
        return false;
      }
      if (item.expectedGeneration !== undefined &&
          (!Number.isSafeInteger(item.expectedGeneration) ||
            item.expectedGeneration < 0 ||
            item.expectedGeneration >= Number.MAX_SAFE_INTEGER)) {
        return false;
      }
      return item.index.generation === (item.expectedGeneration ?? 0) + 1;
    },
    async apply(operation): Promise<void> {
      const { index, expectedGeneration } = operation.payload;
      if (index.projectId !== operation.projectId) {
        throw new Error("El índice de continuidad del sobre pertenece a otro proyecto.");
      }
      const current = await store.loadNarrativeIdeaContinuityIndex!(operation.projectId);
      // Solo un replay de la misma generación es idempotente. Una generación
      // consecutiva puede tener idéntico contenido derivado y aun así debe
      // avanzar el cursor CAS del receptor para no bloquear la siguiente.
      if (current?.generation === index.generation &&
          areNarrativeIdeaContinuityIndexesEquivalent(current, index)) return;
      if (current?.generation !== expectedGeneration) {
        throw new Error("Conflicto CAS al sincronizar el índice de continuidad; requiere reconciliación.");
      }
      await store.saveNarrativeIdeaContinuityIndexIfUnchanged!(index, expectedGeneration);
    }
  };
}
