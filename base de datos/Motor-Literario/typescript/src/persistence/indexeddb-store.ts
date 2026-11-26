import type { ProjectStore, StoredChange, StoredDocument, StoredDiagnostics, StoredProjectFinalizationReceipt, StoredLiveAuthorMonitorCheckpoint, StoredLiveAuthorMonitorLease, StoredSyncOperation, SyncOperationDraft, SyncOperationAcknowledgement, Diagnostic, NarrativeDocumentProjectionManifest, NarrativeReferenceRepairAuditEntry, NarrativeReferenceRepairPendingEntry } from "../contracts";
import { createNarrativeSyncOperationEnvelope } from "../narrative-sync-integrity";
import { normalizeEntityName, MAX_NARRATIVE_IDEA_REFERENCES } from "../narrative-knowledge";
import type { NarrativeEntity, NarrativeRelation, NarrativeEvent, NarrativeIdea, PersonalIdeaLibraryEntry, PersonalIdeaLibraryContext, TextEvidence } from "../narrative-knowledge";
import type { NarrativeAssertion } from "../narrative-history";
import type { ProjectDictionary, DictionaryEntry, DictionaryEntryEntityLink } from "../dictionaries";
import { validateProjectDictionary, validateDictionaryEntry, validateDictionaryEntryEntityLink } from "../dictionaries";
import type {
  ProjectRecord, RecordName, ProjectRelation, ProjectEvidence, TimelineOccurrence, EvidenceSubjectKind,
  ManuscriptFragment, RecordAttribute, RelationAttribute, ActiveSuggestion,
  ImportAuthorization, SchemaMigration
} from "../mldb-records";
import {
  validateProjectRecord as validateProjectRecordContract,
  validateRecordName, validateProjectRelation, validateProjectEvidence, validateTimelineOccurrence,
  cloneProjectRelation, cloneProjectEvidence, cloneTimelineOccurrence,
  validateManuscriptFragment,
  validateRecordAttribute, validateRelationAttribute, validateActiveSuggestion,
  validateImportAuthorization, validateSchemaMigration,
  cloneProjectRecord, cloneRecordName, cloneManuscriptFragment, cloneRecordAttribute,
  cloneRelationAttribute, cloneActiveSuggestion, cloneImportAuthorization, cloneSchemaMigration
} from "../mldb-records";
import type { ProjectSetting } from "../project-data";
import { cloneProjectSetting, validateProjectSetting, type LanguageProfile, type LanguageResourceRef,
  cloneLanguageProfile, cloneLanguageResourceRef, validateLanguageProfile, validateLanguageResourceRef,
  type StyleProfile, type TimelineTrack, cloneStyleProfile, cloneTimelineTrack,
  validateStyleProfile, validateTimelineTrack,
  type RecordLifecycle, type RelationLifecycle, type EventLifecycle,
  cloneRecordLifecycle, cloneRelationLifecycle, cloneEventLifecycle,
  validateRecordLifecycle, validateRelationLifecycle, validateEventLifecycle
} from "../project-data";

const DATABASE_NAME = "motor-literario-local";
const DATABASE_VERSION = 28;
const DOCUMENTS = "documents";
const CHANGES = "changes";
const SYNC_OUTBOX = "sync-outbox";
const SYNC_DEVICE_SEQUENCES = "sync-device-sequences";
const CHANGE_INDEX = "by-document-sequence";
const ENTITIES = "narrative-entities";
const RELATIONS = "narrative-relations";
const EVENTS = "narrative-events";
const IDEAS = "narrative-ideas";
const PERSONAL_IDEAS = "personal-idea-library";
const PERSONAL_IDEA_SOURCE_INDEX = "by-source-project";
const FINALIZATION_RECEIPTS = "writer-library-finalization-receipts";
const FINALIZATION_RECEIPT_ID = "finalization-v1";
const ASSERTIONS = "narrative-assertions";
const NARRATIVE_PROJECTION_MANIFESTS = "narrative-document-projection-manifests";
const DIAGNOSTICS = "document-diagnostics";
const LIVE_AUTHOR_MONITOR_CHECKPOINTS = "live-author-monitor-checkpoints";
const LIVE_AUTHOR_MONITOR_LEASES = "live-author-monitor-leases";
const DICTIONARIES = "project-dictionaries";
const DICTIONARY_ENTRIES = "dictionary-entries";
const DICTIONARY_ENTRY_ENTITIES = "dictionary-entry-entities";
const PROJECT_SETTINGS = "project-settings";
const LANGUAGE_PROFILES = "language-profiles";
const LANGUAGE_RESOURCE_REFS = "language-resource-refs";
const STYLE_PROFILES = "style-profiles";
const TIMELINE_TRACKS = "timeline-tracks";
const RECORD_LIFECYCLES = "record-lifecycles";
const RELATION_LIFECYCLES = "relation-lifecycles";
const EVENT_LIFECYCLES = "event-lifecycles";
const MANUSCRIPT_FRAGMENTS = "manuscript-fragments";
const RECORD_ATTRIBUTES = "record-attributes";
const RELATION_ATTRIBUTES = "relation-attributes";
const ACTIVE_SUGGESTIONS = "active-suggestions";
const IMPORT_AUTHORIZATIONS = "import-authorizations";
const SCHEMA_MIGRATIONS = "schema-migrations";
const PROJECT_RECORDS = "project-records";
const RECORD_NAMES = "record-names";
const PROJECT_RELATIONS = "project-relations";
const PROJECT_EVIDENCES = "project-evidences";
const TIMELINE_OCCURRENCES = "timeline-occurrences";
const NARRATIVE_REFERENCE_REPAIR_AUDITS = "narrative-reference-repair-audits";
const NARRATIVE_REFERENCE_REPAIR_PENDING = "narrative-reference-repair-pending";

/** FNV-1a de 64 bits: checksum de integridad de la lista ordenada de IDs, no una firma criptográfica. */
function checksumArchivedIdeaIds(ids: readonly string[]): string {
  const serialized = JSON.stringify([...ids].sort());
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < serialized.length; index++) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function validateNarrativeDocumentProjectionManifest(
  manifest: NarrativeDocumentProjectionManifest, projectId: string, documentId: string
): void {
  const arrays = ["entityIds", "relationIds", "eventIds", "ideaIds", "assertionIds"] as const;
  if (!manifest || manifest.projectId !== projectId || manifest.documentId !== documentId ||
      !projectId.trim() || !documentId.trim() ||
      !Number.isSafeInteger(manifest.revision) || manifest.revision < 0 ||
      !Number.isSafeInteger(manifest.generation) || manifest.generation < 1 ||
      (manifest.status !== "active" && manifest.status !== "deleted") ||
      !Number.isFinite(manifest.updatedAt) || manifest.updatedAt < 0) {
    throw new Error("Manifiesto de proyección narrativa inválido.");
  }
  for (const key of arrays) {
    const values = manifest[key];
    if (!Array.isArray(values) || values.some(id => typeof id !== "string" || !id.trim()) ||
        new Set(values).size !== values.length) {
      throw new Error("El manifiesto contiene IDs duplicados o inválidos: " + key);
    }
  }
  if (manifest.status === "deleted" &&
      arrays.some(key => manifest[key].length !== 0)) {
    throw new Error("Un tombstone documental no puede conservar IDs de proyección activos.");
  }
}

function validateFinalizationReceipt(
  receipt: StoredProjectFinalizationReceipt,
  writerId: string,
  projectId: string
): void {
  if (!receipt || receipt.writerId !== writerId ||
      receipt.sourceProjectId !== projectId ||
      receipt.receiptId !== FINALIZATION_RECEIPT_ID ||
      typeof receipt.sourceProjectName !== "string" || !receipt.sourceProjectName.trim() ||
      !Number.isFinite(receipt.finalizedAt) || receipt.finalizedAt < 0 ||
      !Array.isArray(receipt.archivedIdeaIds) ||
      receipt.archivedIdeaIds.some(id => typeof id !== "string" || !id.trim()) ||
      new Set(receipt.archivedIdeaIds).size !== receipt.archivedIdeaIds.length ||
      [...receipt.archivedIdeaIds].some((id, index, ids) => index > 0 && ids[index - 1]!.localeCompare(id) > 0) ||
      typeof receipt.archiveChecksum !== "string" ||
      receipt.archiveChecksum !== checksumArchivedIdeaIds(receipt.archivedIdeaIds)) {
    throw new Error("Recibo de finalización inconsistente: propietario, procedencia, IDs o checksum inválidos.");
  }
}

function validateProjectRecord(
  record: { readonly projectId: string; readonly id: string } | null | undefined,
  label: string
): void {
  if (!record || typeof record.projectId !== "string" || !record.projectId.trim() ||
      typeof record.id !== "string" || !record.id.trim()) {
    throw new Error(`Registro de ${label} inválido: projectId e id son obligatorios.`);
  }
}

function validateNarrativeEvidenceList(evidence: readonly TextEvidence[], label: string): void {
  if (!Array.isArray(evidence)) throw new Error(`Registro de ${label} malformado: evidencias inválidas.`);
  for (const item of evidence) {
    if (!item || typeof item.documentId !== "string" || !item.documentId.trim() ||
        !Number.isSafeInteger(item.revision) || item.revision < 0 ||
        !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) ||
        item.start < 0 || item.end < item.start ||
        typeof item.excerpt !== "string" ||
        (item.status !== undefined && item.status !== "stale")) {
      throw new Error(`Registro de ${label} malformado: evidencia inválida.`);
    }
  }
}

function validateNarrativeEntityRecord(entity: NarrativeEntity, label: string): void {
  validateProjectRecord(entity, label);
  if (typeof entity.kind !== "string" || !entity.kind.trim() || entity.kind.length > 128 ||
      typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
      typeof entity.normalizedName !== "string" || !entity.normalizedName.trim() ||
      normalizeEntityName(entity.canonicalName) !== entity.normalizedName ||
      !Array.isArray(entity.aliases) ||
      entity.aliases.some(alias => typeof alias !== "string" || !alias.trim()) ||
      (entity.mergedFromIds !== undefined &&
        (!Array.isArray(entity.mergedFromIds) ||
          entity.mergedFromIds.some(id => typeof id !== "string" || !id.trim()) ||
          new Set(entity.mergedFromIds).size !== entity.mergedFromIds.length)) ||
      !Number.isFinite(entity.firstSeenAt) || entity.firstSeenAt < 0 ||
      !Number.isFinite(entity.lastSeenAt) || entity.lastSeenAt < entity.firstSeenAt ||
      entity.extractionVersion !== 1) {
    throw new Error(`Registro de ${label} malformado: ficha de entidad inválida.`);
  }
  validateNarrativeEvidenceList(entity.evidence, label);
}

function validateNarrativeRelationRecord(relation: NarrativeRelation, label: string): void {
  validateProjectRecord(relation, label);
  if (typeof relation.fromEntityId !== "string" || !relation.fromEntityId.trim() ||
      typeof relation.toEntityId !== "string" || !relation.toEntityId.trim() ||
      typeof relation.relationType !== "string" || !relation.relationType.trim()) {
    throw new Error(`Registro de ${label} malformado: extremos o tipo de relación inválidos.`);
  }
  validateNarrativeEvidenceList(relation.evidence, label);
}

function validateNarrativeEventRecord(event: NarrativeEvent, label: string): void {
  validateProjectRecord(event, label);
  if (typeof event.label !== "string" || !event.label.trim() ||
      !Array.isArray(event.participants) ||
      event.participants.some(id => typeof id !== "string" || !id.trim()) ||
      new Set(event.participants).size !== event.participants.length) {
    throw new Error(`Registro de ${label} malformado: etiqueta o participantes inválidos.`);
  }
  validateNarrativeEvidenceList(event.evidence, label);
  if (event.timelineTrackId !== undefined &&
      (typeof event.timelineTrackId !== "string" || !event.timelineTrackId.trim() ||
       event.timelineTrackId.length > 256)) {
    throw new Error(`Registro de ${label} malformado: pista cronológica inválida.`);
  }
  const time = event.timeReference;
  if (time !== undefined &&
      (!time || (time.basis !== "calendar" && time.basis !== "story-day") ||
        (time.precision !== "date" && time.precision !== "year" && time.precision !== "day-index") ||
        typeof time.raw !== "string" || !time.raw.trim() || !Number.isFinite(time.orderValue) ||
        (time.basis === "story-day" && time.precision !== "day-index") ||
        (time.basis === "calendar" && time.precision === "day-index"))) {
    throw new Error(`Registro de ${label} malformado: referencia temporal inválida.`);
  }
}

function validateProjectRecords<T extends { readonly projectId: string; readonly id: string }>(
  records: readonly T[],
  projectId: string,
  label: string
): readonly T[] {
  if (!Array.isArray(records)) {
    throw new Error(`Colección de ${label} inválida: se esperaba una lista.`);
  }
  const recordIds = new Set<string>();
  for (const record of records) {
    validateProjectRecord(record, label);
    if (record.projectId !== projectId) {
      throw new Error(`Aislamiento de ${label} inconsistente: se rechazó un registro de otro proyecto.`);
    }
    if (recordIds.has(record.id)) {
      throw new Error(`Integridad de ${label} inconsistente: se encontraron identificadores duplicados.`);
    }
    recordIds.add(record.id);
  }
  return records;
}

function validateNarrativeEntityIdentityHistory(entities: readonly NarrativeEntity[]): void {
  const identityOwners = new Map<string, string>();
  for (const entity of entities) {
    const identityIds = new Set<string>([entity.id]);
    for (const historicalId of entity.mergedFromIds ?? []) {
      if (identityIds.has(historicalId)) {
        throw new Error("Integridad narrativa: una entidad repite un ID histórico o reclama su propio ID.");
      }
      identityIds.add(historicalId);
    }
    for (const identityId of identityIds) {
      const owner = identityOwners.get(identityId);
      if (owner !== undefined && owner !== entity.id) {
        throw new Error("Integridad narrativa: un ID histórico pertenece a más de una entidad.");
      }
      identityOwners.set(identityId, entity.id);
    }
  }
}

/**
 * Valida snapshots históricos de una biblioteca personal.
 * A diferencia de las entidades vivas, los snapshots pueden conservar una
 * cadena legítima de fusiones (A absorbida por B, después B por C).
 * Se rechazan propietarios duplicados y ciclos, pero no la presencia de
 * cada eslabón histórico como snapshot independiente.
 */
function validateNarrativeEntitySnapshotHistory(entities: readonly NarrativeEntity[]): void {
  const byId = new Map<string, NarrativeEntity>();
  const historicalParents = new Map<string, string>();
  for (const entity of entities) {
    validateNarrativeEntityRecord(entity, "entidad contextual");
    if (byId.has(entity.id)) {
      throw new Error("Integridad narrativa: una instantánea de entidad está duplicada.");
    }
    byId.set(entity.id, entity);
    for (const historicalId of entity.mergedFromIds ?? []) {
      if (historicalId === entity.id) {
        throw new Error("Integridad narrativa: una entidad reclama su propio ID histórico.");
      }
      const owner = historicalParents.get(historicalId);
      if (owner !== undefined && owner !== entity.id) {
        throw new Error("Integridad narrativa: un ID histórico pertenece a más de una entidad.");
      }
      historicalParents.set(historicalId, entity.id);
    }
  }

  for (const startingId of byId.keys()) {
    const visited = new Set<string>();
    let currentId = startingId;
    while (historicalParents.has(currentId)) {
      if (visited.has(currentId)) {
        throw new Error("Integridad narrativa: se detectó un ciclo en el historial de identidades.");
      }
      visited.add(currentId);
      currentId = historicalParents.get(currentId)!;
    }
  }
}

function validateNarrativeIdeaRecord(idea: NarrativeIdea, label: string): void {
  validateProjectRecord(idea, label);
  if (typeof idea.text !== "string" || !idea.text.trim() ||
      (idea.status !== "IDEA" && idea.status !== "incorporated" && idea.status !== "discarded") ||
      typeof idea.originDocumentId !== "string" || !idea.originDocumentId.trim() ||
      typeof idea.sourceProjectName !== "string" || !idea.sourceProjectName.trim() ||
      !Array.isArray(idea.evidence)) {
    throw new Error(`Registro de ${label} malformado: faltan datos narrativos obligatorios.`);
  }
  for (const evidence of idea.evidence) {
    if (!evidence || typeof evidence.documentId !== "string" || !evidence.documentId.trim() ||
        !Number.isSafeInteger(evidence.revision) || evidence.revision < 0 ||
        !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) ||
        evidence.start < 0 || evidence.end < evidence.start ||
        typeof evidence.excerpt !== "string" ||
        (evidence.status !== undefined && evidence.status !== "stale")) {
      throw new Error(`Registro de ${label} malformado: evidencia inválida.`);
    }
  }
  for (const links of [idea.relatedEntityIds, idea.relatedIdeaIds]) {
    if (links !== undefined &&
        (!Array.isArray(links) || links.length > MAX_NARRATIVE_IDEA_REFERENCES ||
          links.some(id => typeof id !== "string" || !id.trim()) ||
          new Set(links).size !== links.length)) {
      throw new Error(
        `Registro de ${label} malformado: referencias inválidas, duplicadas o superiores al límite de ${MAX_NARRATIVE_IDEA_REFERENCES}.`
      );
    }
  }
  if (idea.relatedIdeaIds?.includes(idea.id)) {
    throw new Error(`Registro de ${label} malformado: una idea no puede relacionarse consigo misma.`);
  }
  if (idea.statusHistory !== undefined) {
    if (!Array.isArray(idea.statusHistory)) {
      throw new Error(`Registro de ${label} malformado: historial inválido.`);
    }
    let previousChangedAt: number | undefined;
    for (let index = 0; index < idea.statusHistory.length; index++) {
      const change = idea.statusHistory[index];
      if (!change ||
          (change.status !== "IDEA" && change.status !== "incorporated" && change.status !== "discarded") ||
          (change.changedAt !== undefined && (!Number.isFinite(change.changedAt) || change.changedAt < 0)) ||
          (change.reason !== "initial" && change.reason !== "writer" && change.reason !== "text-revised") ||
          (change.reason === "text-revised" && change.status !== "IDEA") ||
          (index === 0 ? change.reason !== "initial" : change.reason === "initial" ||
            change.status === idea.statusHistory[index - 1]?.status) ||
          (change.changedAt !== undefined && previousChangedAt !== undefined &&
            change.changedAt < previousChangedAt)) {
        throw new Error(`Registro de ${label} malformado: transición de estado inválida.`);
      }
      if (change.changedAt !== undefined) previousChangedAt = change.changedAt;
    }
    if (idea.statusHistory.length === 0 ||
        idea.statusHistory[idea.statusHistory.length - 1]?.status !== idea.status) {
      throw new Error(`Registro de ${label} malformado: el historial no coincide con el estado actual.`);
    }
  }
}

function validateNarrativeAssertionRecord(
  assertion: NarrativeAssertion,
  label: string
): void {
  validateProjectRecord(assertion, label);
  if (typeof assertion.entityId !== "string" || !assertion.entityId.trim() ||
      typeof assertion.entityName !== "string" || !assertion.entityName.trim() ||
      (assertion.attribute !== "age" && assertion.attribute !== "location" && assertion.attribute !== "role") ||
      (assertion.attribute === "age"
        ? typeof assertion.value !== "number" || !Number.isFinite(assertion.value) || assertion.value < 0
        : typeof assertion.value !== "string" || !assertion.value.trim()) ||
      !Number.isFinite(assertion.capturedAt) || assertion.capturedAt < 0) {
    throw new Error(`Registro de ${label} malformado: atributos obligatorios inválidos.`);
  }
  const evidence = assertion.evidence;
  if (!evidence || typeof evidence.documentId !== "string" || !evidence.documentId.trim() ||
      !Number.isSafeInteger(evidence.revision) || evidence.revision < 0 ||
      !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) ||
      evidence.start < 0 || evidence.end < evidence.start ||
      typeof evidence.excerpt !== "string" ||
      (evidence.status !== undefined && evidence.status !== "stale")) {
    throw new Error(`Registro de ${label} malformado: evidencia inválida.`);
  }
  const time = assertion.timeReference;
  if (time !== undefined &&
      (!time || (time.basis !== "calendar" && time.basis !== "story-day") ||
        (time.precision !== "date" && time.precision !== "year" && time.precision !== "day-index") ||
        typeof time.raw !== "string" || !time.raw.trim() ||
        !Number.isFinite(time.orderValue) ||
        (time.basis === "story-day" && time.precision !== "day-index") ||
        (time.basis === "calendar" && time.precision === "day-index"))) {
    throw new Error(`Registro de ${label} malformado: referencia temporal inválida.`);
  }
}

function readAfterTransaction<T>(
  transaction: IDBTransaction,
  request: IDBRequest<T>,
  failureMessage: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    let result!: T;
    let resultReady = false;
    let requestError: DOMException | null = null;
    request.onsuccess = () => {
      result = request.result;
      resultReady = true;
    };
    request.onerror = () => {
      requestError = request.error;
      try { transaction.abort(); } catch { /* transacción ya abortada */ }
    };
    transaction.oncomplete = () => {
      if (requestError) reject(requestError);
      else if (!resultReady) reject(new Error(failureMessage));
      else resolve(result);
    };
    transaction.onerror = () => reject(transaction.error ?? new Error(failureMessage));
    transaction.onabort = () => reject(
      transaction.error ?? requestError ?? new Error(failureMessage)
    );
  });
}


function validatePersonalIdeaLibraryContext(
  context: PersonalIdeaLibraryContext,
  projectId: string,
  sourceProjectName: string,
  label: string
): void {
  if (!context || context.version !== 1 || !Array.isArray(context.relatedIdeas) ||
      !Array.isArray(context.relatedEntities)) {
    throw new Error(`Registro de ${label} malformado: contexto de biblioteca inválido.`);
  }
  const relatedIdeas = validateProjectRecords<NarrativeIdea>(
    context.relatedIdeas, projectId, `${label} relacionadas`
  );
  const relatedEntities = validateProjectRecords<NarrativeEntity>(
    context.relatedEntities, projectId, `${label} relacionadas`
  );
  const ideaIds = new Set<string>();
  for (const idea of relatedIdeas) {
    if (ideaIds.has(idea.id)) {
      throw new Error("Integridad de biblioteca: el contexto repite una idea relacionada.");
    }
    ideaIds.add(idea.id);
  }
  const entityIds = new Set<string>();
  for (const entity of relatedEntities) {
    if (entityIds.has(entity.id)) {
      throw new Error("Integridad de biblioteca: el contexto repite una ficha relacionada.");
    }
    entityIds.add(entity.id);
  }
  for (const idea of relatedIdeas) {
    validateNarrativeIdeaRecord(idea, "idea contextual");
    if (idea.sourceProjectName !== sourceProjectName || idea.status === "IDEA") {
      throw new Error("Integridad de biblioteca: una idea pendiente debe resolverse mediante su propia entrada archivada.");
    }
  }
  validateNarrativeEntitySnapshotHistory(relatedEntities);
  // Reutiliza el conjunto ya validado arriba; también comprueba referencias de ideas.
  for (const idea of relatedIdeas) {
    if ((idea.relatedEntityIds ?? []).some(id => !entityIds.has(id))) {
      throw new Error("Integridad de biblioteca: una idea contextual contiene referencias a fichas no conservadas.");
    }
  }
}

/**
 * Reapunta las instantáneas de biblioteca a la identidad canónica dentro de la
 * misma transacción que consolida las fichas del proyecto. El texto, el
 * historial y las evidencias de las ideas permanecen intactos.
 */
function remapPersonalIdeaEntriesForEntityMerge(
  entries: readonly PersonalIdeaLibraryEntry[],
  writerId: string,
  projectId: string,
  sourceEntityId: string,
  mergedEntity: NarrativeEntity
): readonly PersonalIdeaLibraryEntry[] {
  if (!Array.isArray(entries)) {
    throw new Error("Biblioteca personal inconsistente: no se pudo leer el conjunto de ideas del proyecto.");
  }
  const typedEntries = entries as readonly PersonalIdeaLibraryEntry[];
  const absorbedIdentityIds = new Set<string>([
    sourceEntityId, ...(mergedEntity.mergedFromIds ?? [])
  ]);
  const mergedIdentityIds = new Set<string>([mergedEntity.id, ...absorbedIdentityIds]);
  const archivedIdeaIds = new Set<string>();
  const identities = new Set<string>();
  for (const entry of typedEntries) {
    if (!entry || entry.writerId !== writerId || entry.sourceProjectId !== projectId ||
        typeof entry.sourceProjectName !== "string" || !entry.sourceProjectName.trim() ||
        entry.category !== entry.sourceProjectName || !entry.idea ||
        entry.idea.projectId !== projectId || entry.idea.sourceProjectName !== entry.sourceProjectName ||
        entry.idea.status !== "IDEA" || !Number.isFinite(entry.archivedAt) || entry.archivedAt < 0) {
      throw new Error("Biblioteca personal inconsistente: hay una entrada ajena o malformada durante la consolidación.");
    }
    validateNarrativeIdeaRecord(entry.idea, "idea archivada");
    const identity = entry.idea.id;
    if (identities.has(identity)) {
      throw new Error("Biblioteca personal inconsistente: existen ideas archivadas duplicadas para el mismo libro.");
    }
    identities.add(identity);
    archivedIdeaIds.add(identity);
  }

  // Reúne la cadena de ancestros desde todas las instantáneas del mismo
  // libro antes de actualizar entradas legacy que no conservan su propio contexto.
  // Así, un ID antiguo presente únicamente en otra entrada contextual tampoco
  // queda huérfano después de consolidar la identidad canónica.
  let expandedHistory = true;
  while (expandedHistory) {
    expandedHistory = false;
    for (const entry of typedEntries) {
      if (!entry.context) continue;
      validatePersonalIdeaLibraryContext(
        entry.context, projectId, entry.sourceProjectName, "contexto archivado"
      );
      for (const snapshot of entry.context.relatedEntities) {
        const belongsToMergedIdentity = absorbedIdentityIds.has(snapshot.id) ||
          (snapshot.mergedFromIds ?? []).some(id => absorbedIdentityIds.has(id));
        if (!belongsToMergedIdentity) continue;
        if (!absorbedIdentityIds.has(snapshot.id)) {
          absorbedIdentityIds.add(snapshot.id);
          expandedHistory = true;
        }
        for (const historicalId of snapshot.mergedFromIds ?? []) {
          if (!absorbedIdentityIds.has(historicalId)) {
            absorbedIdentityIds.add(historicalId);
            expandedHistory = true;
          }
        }
      }
    }
  }
  for (const historicalId of absorbedIdentityIds) mergedIdentityIds.add(historicalId);

  return typedEntries.map(entry => {
    if (!entry.context) {
      // Las entradas antiguas carecen de instantáneas. No inventamos contexto,
      // pero sí redirigimos cualquier ID histórico absorbido por esta identidad.
      if (!(entry.idea.relatedEntityIds ?? []).some(id => absorbedIdentityIds.has(id))) return entry;
      return {
        ...entry,
        idea: {
          ...entry.idea,
          relatedEntityIds: [...new Set((entry.idea.relatedEntityIds ?? []).map(id =>
            absorbedIdentityIds.has(id) ? mergedEntity.id : id
          ))]
        }
      };
    }
    validatePersonalIdeaLibraryContext(
      entry.context, projectId, entry.sourceProjectName, "contexto archivado"
    );
    const contextIdeaIds = new Set(entry.context.relatedIdeas.map(idea => idea.id));
    const contextEntityIds = new Set(entry.context.relatedEntities.map(entity => entity.id));
    if (contextIdeaIds.has(entry.idea.id)) {
      throw new Error("Biblioteca personal inconsistente: una idea archivada se repite en su propio contexto.");
    }
    for (const related of [entry.idea, ...entry.context.relatedIdeas]) {
      if ((related.relatedEntityIds ?? []).some(id => !contextEntityIds.has(id)) ||
          (related.relatedIdeaIds ?? []).some(id =>
            !contextIdeaIds.has(id) && !archivedIdeaIds.has(id)
          )) {
        throw new Error("Biblioteca personal inconsistente: hay referencias históricas sin destino resoluble.");
      }
    }

    const identitySnapshots: NarrativeEntity[] = [];
    const selectedSnapshotIds = new Set<string>();
    const entryMergedIdentityIds = new Set(mergedIdentityIds);
    let discoveredHistoricalIdentity = true;
    while (discoveredHistoricalIdentity) {
      discoveredHistoricalIdentity = false;
      for (const snapshot of entry.context.relatedEntities) {
        if (selectedSnapshotIds.has(snapshot.id)) continue;
        const belongsToMergedIdentity = entryMergedIdentityIds.has(snapshot.id) ||
          (snapshot.mergedFromIds ?? []).some(id => entryMergedIdentityIds.has(id));
        if (!belongsToMergedIdentity) continue;
        selectedSnapshotIds.add(snapshot.id);
        identitySnapshots.push(snapshot);
        entryMergedIdentityIds.add(snapshot.id);
        for (const id of snapshot.mergedFromIds ?? []) entryMergedIdentityIds.add(id);
        discoveredHistoricalIdentity = true;
      }
    }
    const referencesMergedIdentity = [entry.idea, ...entry.context.relatedIdeas].some(idea =>
      (idea.relatedEntityIds ?? []).some(id => entryMergedIdentityIds.has(id))
    );
    if (referencesMergedIdentity && identitySnapshots.length === 0) {
      throw new Error("Biblioteca personal inconsistente: una idea archivada referencia la identidad que se fusiona sin conservar su ficha.");
    }
    if (identitySnapshots.length === 0) return entry;
    for (const snapshot of identitySnapshots) {
      if (snapshot.kind !== mergedEntity.kind) {
        throw new Error("Biblioteca personal inconsistente: una instantánea histórica pertenece a otra clase de entidad.");
      }
      validateNarrativeEntityIdentityHistory([snapshot]);
    }

    // Las instantáneas pueden contener evidencias y alias que ya no aparecen
    // en el registro vivo. Se incorporan antes de sustituir el grupo histórico.
    const aliases = [...new Map(
      [
        ...mergedEntity.aliases,
        ...identitySnapshots.flatMap(snapshot => [snapshot.canonicalName, ...snapshot.aliases])
      ].map(alias => [normalizeEntityName(alias), alias] as const)
    ).values()].filter(alias => alias && normalizeEntityName(alias) !== mergedEntity.normalizedName);
    const mergedFromIds = [...new Set([
      ...(mergedEntity.mergedFromIds ?? []),
      ...identitySnapshots.flatMap(snapshot => [snapshot.id, ...(snapshot.mergedFromIds ?? [])])
    ])].filter(id => id !== mergedEntity.id);
    const evidence = [...mergedEntity.evidence];
    const evidenceKeys = new Set(evidence.map(item =>
      [item.documentId, item.revision, item.start, item.end, item.excerpt, item.status ?? ""].join("\u0000")
    ));
    for (const snapshot of identitySnapshots) {
      for (const item of snapshot.evidence) {
        const key = [item.documentId, item.revision, item.start, item.end, item.excerpt, item.status ?? ""].join("\u0000");
        if (!evidenceKeys.has(key)) {
          evidence.push(item);
          evidenceKeys.add(key);
        }
      }
    }
    const contextualEntity: NarrativeEntity = {
      ...mergedEntity,
      aliases,
      mergedFromIds,
      evidence,
      firstSeenAt: identitySnapshots.reduce(
        (earliest, item) => Math.min(earliest, item.firstSeenAt), mergedEntity.firstSeenAt
      ),
      lastSeenAt: identitySnapshots.reduce(
        (latest, item) => Math.max(latest, item.lastSeenAt), mergedEntity.lastSeenAt
      )
    };
    validateNarrativeEntityRecord(contextualEntity, "entidad contextual consolidada");
    validateNarrativeEntityIdentityHistory([contextualEntity]);

    const remapIdea = (idea: NarrativeIdea): NarrativeIdea => {
      if (!(idea.relatedEntityIds ?? []).some(id => entryMergedIdentityIds.has(id))) return idea;
      return {
        ...idea,
        relatedEntityIds: [...new Set((idea.relatedEntityIds ?? []).map(id =>
          entryMergedIdentityIds.has(id) ? mergedEntity.id : id
        ))]
      };
    };
    const relatedEntities = [
      ...entry.context.relatedEntities.filter(entity => !entryMergedIdentityIds.has(entity.id)),
      contextualEntity
    ].sort((first, second) => first.id.localeCompare(second.id));
    validateNarrativeEntityIdentityHistory(relatedEntities);
    return {
      ...entry,
      idea: remapIdea(entry.idea),
      context: {
        ...entry.context,
        relatedIdeas: entry.context.relatedIdeas.map(remapIdea),
        relatedEntities
      }
    };
  });
}


async function saveNarrativeIdeaWithReferences(
  db: IDBDatabase,
  idea: NarrativeIdea,
  expectedCurrent?: NarrativeIdea,
  checkExpectedCurrent = expectedCurrent !== undefined,
  syncOperation?: SyncOperationDraft
): Promise<void> {
  const syncDraft = syncOperation === undefined ? undefined : normalizeSyncOperationDraft(syncOperation);
  if (syncDraft && syncDraft.projectId !== idea.projectId) {
    throw new Error("El proyecto de la idea y de la operación de sincronización no coincide.");
  }
  const entityIds = idea.relatedEntityIds ?? [];
  const relatedIdeaIds = idea.relatedIdeaIds ?? [];
  if (expectedCurrent && (
    expectedCurrent.projectId !== idea.projectId || expectedCurrent.id !== idea.id
  )) {
    throw new Error("La actualización debe conservar la identidad de la idea original.");
  }
  const baseStores = entityIds.length > 0 ? [IDEAS, ENTITIES] : [IDEAS];
  const stores = syncDraft
    ? [...baseStores, SYNC_OUTBOX, SYNC_DEVICE_SEQUENCES]
    : baseStores;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(stores, "readwrite");
    let syncFailure: Error | undefined;
    const abortWith = (error: unknown): void => {
      syncFailure = error instanceof Error ? error : new Error("No se pudo encolar la idea narrativa.");
      try { transaction.abort(); } catch { /* transacción ya abortada */ }
    };
    const putIdea = (): void => {
      ideaStore.put(idea);
      if (syncDraft) queueSyncOperationInTransaction(transaction, syncDraft, abortWith);
    };
    const ideaStore = transaction.objectStore(IDEAS);
    const checks: {
      readonly request: IDBRequest<unknown>;
      readonly id: string;
      readonly kind: "entity" | "idea";
    }[] = [
      ...entityIds.map(id => ({
        request: transaction.objectStore(ENTITIES).get([idea.projectId, id]) as IDBRequest<unknown>,
        id,
        kind: "entity" as const
      })),
      ...relatedIdeaIds.map(id => ({
        request: ideaStore.get([idea.projectId, id]) as IDBRequest<unknown>,
        id,
        kind: "idea" as const
      }))
    ];
    const existingRequest = checkExpectedCurrent
      ? ideaStore.get([idea.projectId, idea.id])
      : undefined;
    const totalChecks = checks.length + (existingRequest ? 1 : 0);
    if (totalChecks === 0) {
      putIdea();
    } else {
      let remaining = totalChecks;
      const abortWith = (error: unknown): void => {
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
        reject(error);
      };
      const markCheckComplete = (): void => {
        remaining--;
        if (remaining === 0) putIdea();
      };
      if (existingRequest) {
        existingRequest.onsuccess = () => {
          try {
            const current = existingRequest.result as NarrativeIdea | undefined;
            assertExpectedNarrativeVersion(current, idea, expectedCurrent, "La idea");
            markCheckComplete();
          } catch (error) {
            abortWith(error);
          }
        };
        existingRequest.onerror = () => abortWith(
          existingRequest.error ?? new Error("No se pudo verificar la versión actual de la idea.")
        );
      }
      for (const check of checks) {
        check.request.onsuccess = () => {
          try {
            const record = check.request.result as
              | NarrativeEntity
              | NarrativeIdea
              | undefined;
            if (!record || record.projectId !== idea.projectId || record.id !== check.id) {
              throw new Error(
                check.kind === "entity"
                  ? "Referencia narrativa inválida: una o más entidades no existen en el proyecto."
                  : "Referencia narrativa inválida: una o más ideas relacionadas no existen en el proyecto."
              );
            }
            if (check.kind === "entity") {
              const entity = record as NarrativeEntity;
              validateNarrativeEntityRecord(entity, "entidad narrativa");
              validateNarrativeEntityIdentityHistory([entity]);
            } else {
              validateNarrativeIdeaRecord(record as NarrativeIdea, "idea relacionada");
            }
            markCheckComplete();
          } catch (error) {
            abortWith(error);
          }
        };
        check.request.onerror = () => abortWith(
          check.request.error ?? new Error("No se pudieron verificar las referencias de la idea.")
        );
      }
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(syncFailure ?? transaction.error ?? new Error("No se pudo guardar la idea."));
    transaction.onabort = () => reject(syncFailure ?? transaction.error ?? new Error("Se canceló el guardado de la idea."));
  });
}

async function saveNarrativeEventWithReferences(
  db: IDBDatabase,
  event: NarrativeEvent,
  expectedCurrent?: NarrativeEvent,
  checkExpectedCurrent = false,
  syncOperation?: SyncOperationDraft
): Promise<void> {
  const syncDraft = syncOperation === undefined ? undefined : normalizeSyncOperationDraft(syncOperation);
  if (syncDraft && syncDraft.projectId !== event.projectId) {
    throw new Error("El proyecto del acontecimiento y de la operación de sincronización no coincide.");
  }
  const requiredIds = [...new Set(event.participants)];
  if (requiredIds.some(id => typeof id !== "string" || !id.trim())) {
    throw new Error("El acontecimiento contiene participantes inválidos.");
  }
  if (checkExpectedCurrent && expectedCurrent !== undefined &&
      (expectedCurrent.projectId !== event.projectId || expectedCurrent.id !== event.id)) {
    throw new Error("La actualización debe conservar la identidad del acontecimiento.");
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      syncDraft
        ? [ENTITIES, TIMELINE_TRACKS, EVENTS, SYNC_OUTBOX, SYNC_DEVICE_SEQUENCES]
        : [ENTITIES, TIMELINE_TRACKS, EVENTS],
      "readwrite"
    );
    const eventStore = transaction.objectStore(EVENTS);
    let entitiesReady = false;
    let trackReady = event.timelineTrackId === undefined;
    let expectedReady = !checkExpectedCurrent;
    let referenceConflict = false;
    let failure: Error | undefined;
    const abortWith = (error: unknown, conflict = false): void => {
      failure = error instanceof Error ? error : new Error("No se pudieron validar las referencias del acontecimiento.");
      referenceConflict = conflict;
      try { transaction.abort(); } catch { /* transacción ya abortada */ }
    };
    const saveIfReady = (): void => {
      if (!entitiesReady || !trackReady || !expectedReady || failure) return;
      eventStore.put(event);
      if (syncDraft) {
        queueSyncOperationInTransaction(transaction, syncDraft, error => abortWith(error));
      }
    };

    const entitiesRequest = transaction.objectStore(ENTITIES).index("by-project").getAll(event.projectId);
    entitiesRequest.onsuccess = () => {
      try {
        const entities = entitiesRequest.result as NarrativeEntity[];
        if (!Array.isArray(entities)) throw new Error("La colección de entidades del acontecimiento es inválida.");
        const available = new Set<string>();
        for (const entity of entities) {
          if (entity && typeof entity.id === "string" && requiredIds.includes(entity.id)) {
            validateNarrativeEntityRecord(entity, "entidad participante");
            if (entity.projectId !== event.projectId) throw new Error("Una entidad participante pertenece a otro proyecto.");
            available.add(entity.id);
          }
        }
        if (requiredIds.some(id => !available.has(id))) {
          throw new Error("Referencia narrativa inválida: una o más entidades no existen en el proyecto.");
        }
        entitiesReady = true;
        saveIfReady();
      } catch (error) {
        abortWith(error, true);
      }
    };
    entitiesRequest.onerror = () => abortWith(
      entitiesRequest.error ?? new Error("No se pudieron verificar los participantes del acontecimiento.")
    );

    if (event.timelineTrackId !== undefined) {
      const trackRequest = transaction.objectStore(TIMELINE_TRACKS)
        .get([event.projectId, event.timelineTrackId]);
      trackRequest.onsuccess = () => {
        try {
          const track = trackRequest.result as TimelineTrack | undefined;
          if (!track || track.projectId !== event.projectId || track.id !== event.timelineTrackId) {
            throw new Error("La pista cronológica no existe en el mismo proyecto que el acontecimiento.");
          }
          validateTimelineTrack(track, event.projectId);
          trackReady = true;
          saveIfReady();
        } catch (error) {
          abortWith(error, true);
        }
      };
      trackRequest.onerror = () => abortWith(
        trackRequest.error ?? new Error("No se pudo verificar la pista cronológica del acontecimiento.")
      );
    }
    if (checkExpectedCurrent) {
      const currentRequest = eventStore.get([event.projectId, event.id]);
      currentRequest.onsuccess = () => {
        try {
          assertExpectedNarrativeVersion(
            currentRequest.result as NarrativeEvent | undefined, event, expectedCurrent, "El acontecimiento"
          );
          expectedReady = true;
          saveIfReady();
        } catch (error) {
          abortWith(error);
        }
      };
      currentRequest.onerror = () => abortWith(
        currentRequest.error ?? new Error("No se pudo verificar la versión actual del acontecimiento.")
      );
    }

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      failure ?? transaction.error ?? new Error("No se pudo guardar el acontecimiento.")
    );
    transaction.onabort = () => reject(
      failure ?? (referenceConflict
        ? new Error("Referencia narrativa inválida: participante o pista cronológica fuera del proyecto.")
        : transaction.error ?? new Error("Se canceló el guardado del acontecimiento."))
    );
  });
}

function assertExpectedNarrativeVersion<T extends { readonly projectId: string; readonly id: string }>(
  current: T | undefined,
  record: T,
  expectedCurrent: T | undefined,
  label: string
): void {
  if (expectedCurrent === undefined) {
    if (current !== undefined) {
      throw new Error(`${label} apareció en otra instancia; actualiza la vista antes de volver a modificarlo.`);
    }
    return;
  }
  if (!current) {
    throw new Error(`${label} ya no existe en el proyecto; puede haberse archivado o eliminado desde otra instancia.`);
  }
  if (current.projectId !== record.projectId || current.id !== record.id ||
      JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
    throw new Error(`${label} cambió en otra instancia; actualiza la vista antes de volver a modificarlo.`);
  }
}

async function saveNarrativeEntityRecord(
  db: IDBDatabase,
  entity: NarrativeEntity,
  expectedCurrent?: NarrativeEntity,
  checkExpectedCurrent = false,
  syncOperation?: SyncOperationDraft
): Promise<void> {
  const syncDraft = syncOperation === undefined ? undefined : normalizeSyncOperationDraft(syncOperation);
  if (syncDraft && syncDraft.projectId !== entity.projectId) {
    throw new Error("El proyecto de la entidad y de la operación de sincronización no coincide.");
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      syncDraft ? [ENTITIES, SYNC_OUTBOX, SYNC_DEVICE_SEQUENCES] : [ENTITIES],
      "readwrite"
    );
    const store = transaction.objectStore(ENTITIES);
    const request = store.index("by-project").getAll(entity.projectId);
    let requestError: unknown;
    request.onsuccess = () => {
      try {
        const current = request.result as NarrativeEntity[];
        const scoped = validateProjectRecords(current, entity.projectId, "entidad narrativa");
        for (const existing of scoped) validateNarrativeEntityRecord(existing, "entidad narrativa");
        const previous = scoped.find(existing => existing.id === entity.id);
        if (checkExpectedCurrent) assertExpectedNarrativeVersion(previous, entity, expectedCurrent, "La entidad");
        const next = scoped.filter(existing => existing.id !== entity.id);
        next.push(entity);
        validateNarrativeEntityIdentityHistory(next);
        store.put(entity);
        if (syncDraft) {
          queueSyncOperationInTransaction(transaction, syncDraft, error => {
            requestError = error;
            try { transaction.abort(); } catch { /* transacción ya abortada */ }
          });
        }
      } catch (error) {
        requestError = error;
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      }
    };
    request.onerror = () => {
      requestError = request.error ?? new Error("No se pudieron verificar las identidades narrativas.");
      try { transaction.abort(); } catch { /* transacción ya abortada */ }
    };
    transaction.oncomplete = () => {
      if (requestError !== undefined) reject(requestError);
      else resolve();
    };
    transaction.onerror = () => reject(requestError ?? transaction.error ??
      new Error("No se pudo guardar la entidad narrativa."));
    transaction.onabort = () => reject(requestError ?? transaction.error ??
      new Error("Se canceló el guardado de la entidad."));
  });
}

async function saveNarrativeRecordWithEntityReferences<T extends { readonly projectId: string; readonly id: string }>(
  db: IDBDatabase,
  storeName: string,
  record: T,
  entityIds: readonly string[],
  failureMessage: string,
  expectedCurrent?: T,
  checkExpectedCurrent = false,
  syncOperation?: SyncOperationDraft
): Promise<void> {
  const syncDraft = syncOperation === undefined ? undefined : normalizeSyncOperationDraft(syncOperation);
  if (syncDraft && syncDraft.projectId !== record.projectId) {
    throw new Error("El proyecto del registro narrativo y de la operación de sincronización no coincide.");
  }
  const requiredIds = [...new Set(entityIds)];
  if (requiredIds.some(id => typeof id !== "string" || !id.trim())) {
    throw new Error("La referencia narrativa contiene identificadores de entidad inválidos.");
  }
  if (checkExpectedCurrent && expectedCurrent !== undefined &&
      (expectedCurrent.projectId !== record.projectId || expectedCurrent.id !== record.id)) {
    throw new Error("La actualización debe conservar la identidad del registro narrativo.");
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      syncDraft
        ? [ENTITIES, storeName, SYNC_OUTBOX, SYNC_DEVICE_SEQUENCES]
        : [ENTITIES, storeName],
      "readwrite"
    );
    const recordStore = transaction.objectStore(storeName);
    let failure: Error | undefined;
    let referenceConflict = false;
    let entitiesReady = false;
    let expectedReady = !checkExpectedCurrent;
    const abort = (error?: unknown) => {
      if (error !== undefined) failure = error instanceof Error ? error : new Error(failureMessage);
      referenceConflict = error === undefined;
      try { transaction.abort(); } catch { /* transacción ya abortada */ }
    };
    const saveIfReady = () => {
      if (!entitiesReady || !expectedReady || failure) return;
      recordStore.put(record);
      if (syncDraft) {
        queueSyncOperationInTransaction(transaction, syncDraft, abort);
      }
    };
    const request = transaction.objectStore(ENTITIES).index("by-project").getAll(record.projectId);
    request.onsuccess = () => {
      const entities = request.result as NarrativeEntity[];
      if (!Array.isArray(entities)) {
        abort();
        return;
      }
      const available = new Set<string>();
      try {
        for (const entity of entities) {
          if (entity && typeof entity.id === "string" && requiredIds.includes(entity.id)) {
            validateNarrativeEntityRecord(entity, "entidad narrativa");
            if (entity.projectId !== record.projectId) throw new Error("Entidad de otro proyecto.");
            available.add(entity.id);
          }
        }
      } catch {
        abort();
        return;
      }
      if (requiredIds.some(id => !available.has(id))) {
        abort();
        return;
      }
      entitiesReady = true;
      saveIfReady();
    };
    request.onerror = () => abort(request.error ?? new Error(failureMessage));
    if (checkExpectedCurrent) {
      const currentRequest = recordStore.get([record.projectId, record.id]);
      currentRequest.onsuccess = () => {
        try {
          assertExpectedNarrativeVersion(
            currentRequest.result as T | undefined, record, expectedCurrent, "El registro narrativo"
          );
          expectedReady = true;
          saveIfReady();
        } catch (error) {
          abort(error);
        }
      };
      currentRequest.onerror = () => abort(currentRequest.error ?? new Error(failureMessage));
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error(failureMessage));
    transaction.onabort = () => reject(failure ?? (referenceConflict
      ? new Error("Referencia narrativa inválida: una o más entidades no existen en el proyecto.")
      : transaction.error ?? new Error(failureMessage)));
  });
}

async function loadSimpleProjectRecords<T extends { readonly projectId: string; readonly id: string }>(
  db: IDBDatabase,
  storeName: string,
  projectId: string,
  label: string,
  validate: (record: T, expectedProjectId: string) => void,
  clone: (record: T) => T
): Promise<readonly T[]> {
  const transaction = db.transaction(storeName, "readonly");
  const request = transaction.objectStore(storeName).index("by-project").getAll(projectId);
  const records = await readAfterTransaction(
    transaction, request, `No se pudieron leer ${label}.`
  ) as T[];
  if (!Array.isArray(records)) throw new Error(`La colección de ${label} es inválida.`);
  const ids = new Set<string>();
  for (const record of records) {
    validate(record, projectId);
    if (ids.has(record.id)) throw new Error(`Hay IDs duplicados en ${label}.`);
    ids.add(record.id);
  }
  return records.map(clone);
}

async function saveSimpleProjectRecord<T extends { readonly projectId: string; readonly id: string }>(
  db: IDBDatabase,
  storeName: string,
  record: T,
  expectedCurrent: T | undefined,
  label: string,
  validate: (value: T, expectedProjectId?: string) => void,
  clone: (value: T) => T
): Promise<void> {
  validate(record);
  if (expectedCurrent) {
    validate(expectedCurrent, record.projectId);
    if (expectedCurrent.id !== record.id) {
      throw new Error(`Una actualización de ${label} debe conservar su ID original.`);
    }
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.get([record.projectId, record.id]);
    let failure: unknown;
    request.onsuccess = () => {
      try {
        const current = request.result as T | undefined;
        if (expectedCurrent) {
          if (!current || current.projectId !== record.projectId ||
              current.id !== record.id ||
              JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
            throw new Error(`El registro de ${label} cambió en otra instancia; vuelve a leerlo antes de actualizar.`);
          }
        } else if (current) {
          throw new Error(`El registro de ${label} ya existe; vuelve a leerlo antes de actualizar.`);
        }
        store.put(clone(record));
      } catch (error) {
        failure = error;
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      }
    };
    request.onerror = () => {
      failure = request.error ?? new Error(`No se pudo verificar el registro actual de ${label}.`);
      try { transaction.abort(); } catch { /* transacción ya abortada */ }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error(`No se pudo guardar ${label}.`));
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error(`Se canceló el guardado de ${label}.`));
  });
}



interface ProjectParentCheck {
  readonly storeName: string;
  readonly key: IDBValidKey;
  readonly label: string;
  readonly validate?: (value: unknown) => void;
}

async function saveProjectRecordWithParents<T extends { readonly projectId: string; readonly id: string }>(
  db: IDBDatabase,
  storeName: string,
  record: T,
  expectedCurrent: T | undefined,
  parents: readonly ProjectParentCheck[],
  label: string,
  validate: (value: T, expectedProjectId?: string) => void,
  clone: (value: T) => T
): Promise<void> {
  validate(record, record.projectId);
  if (expectedCurrent) {
    validate(expectedCurrent, record.projectId);
    if (expectedCurrent.id !== record.id) throw new Error(`La actualización de ${label} debe conservar su ID.`);
  }
  const storeNames = [...new Set([storeName, ...parents.map(parent => parent.storeName)])];
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeNames, "readwrite");
    const target = transaction.objectStore(storeName);
    const currentRequest = target.get([record.projectId, record.id]);
    const parentRequests = parents.map(parent =>
      transaction.objectStore(parent.storeName).get(parent.key)
    );
    let currentReady = false;
    const parentsReady = parents.map(() => false);
    const parentValues: unknown[] = [];
    let current: T | undefined;
    let failure: Error | undefined;
    let finished = false;
    const abortWith = (error: unknown): void => {
      if (finished) return;
      failure = error instanceof Error ? error : new Error(`No se pudo guardar ${label}.`);
      finished = true;
      try { transaction.abort(); } catch { /* transacción ya abortada */ }
    };
    const commitIfReady = (): void => {
      if (finished || !currentReady || parentsReady.some(ready => !ready)) return;
      try {
        parents.forEach((parent, index) => {
          const value = parentValues[index];
          if (!value) throw new Error(`No existe ${parent.label} en el proyecto activo.`);
          parent.validate?.(value);
        });
        if (expectedCurrent) {
          if (!current || current.projectId !== record.projectId || current.id !== record.id ||
              JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
            throw new Error(`${label} cambió en otra instancia; vuelve a leerlo antes de actualizar.`);
          }
        } else if (current) {
          throw new Error(`${label} ya existe; vuelve a leerlo antes de actualizar.`);
        }
        target.put(clone(record));
      } catch (error) {
        abortWith(error);
      }
    };
    currentRequest.onsuccess = () => {
      current = currentRequest.result as T | undefined;
      currentReady = true;
      commitIfReady();
    };
    currentRequest.onerror = () => abortWith(
      currentRequest.error ?? new Error(`No se pudo verificar ${label}.`)
    );
    parentRequests.forEach((request, index) => {
      request.onsuccess = () => {
        parentValues[index] = request.result;
        parentsReady[index] = true;
        commitIfReady();
      };
      request.onerror = () => abortWith(
        request.error ?? new Error(`No se pudo verificar ${parents[index]!.label}.`)
      );
    });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error(`No se pudo guardar ${label}.`));
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error(`Se canceló el guardado de ${label}.`));
  });
}

type LifecycleHistoryRecord = {
  readonly projectId: string;
  readonly id: string;
  readonly revision: number;
  readonly changedAt: number;
};
type LifecycleSequenceRules<T extends LifecycleHistoryRecord> = {
  readonly isInitial: (item: T) => boolean;
  readonly continues: (previous: T, item: T) => boolean;
};
type LegacyLifecycleState = {
  readonly previousLabel: string | null;
  readonly newLabel: string;
  readonly previousState: string | null;
  readonly newState: string;
};
function standardLifecycleSequenceRules<T extends LifecycleHistoryRecord>(): LifecycleSequenceRules<T> {
  return {
    isInitial:item => {
      const value=item as T & LegacyLifecycleState;
      return value.previousLabel===null && value.previousState===null;
    },
    continues:(previous,item) => {
      const before=previous as T & LegacyLifecycleState;
      const after=item as T & LegacyLifecycleState;
      return after.previousLabel===before.newLabel && after.previousState===before.newState;
    }
  };
}
const EVENT_LIFECYCLE_SEQUENCE_RULES: LifecycleSequenceRules<EventLifecycle> = {
  // El historial de acontecimientos comienza en el primer cambio que se registra.
  // Por ello, su revisión 1 conserva una instantánea anterior real, no un baseline inventado.
  isInitial:() => true,
  continues:(previous,item) =>
    item.previousLabel===previous.newLabel &&
    item.previousParticipants.length===previous.newParticipants.length &&
    item.previousParticipants.every((id,index)=>id===previous.newParticipants[index])
};

function validateLifecycleSequence<T extends LifecycleHistoryRecord>(
  records: readonly T[],
  label: string,
  rules: LifecycleSequenceRules<T> = standardLifecycleSequenceRules<T>()
): readonly T[] {
  if (!Array.isArray(records)) throw new Error(`El historial de ${label} no es una colección.`);
  const ordered = [...records].sort((first, second) => first.revision - second.revision);
  const ids = new Set<string>();
  let previous: T | undefined;
  for (const item of ordered) {
    if (!item || typeof item.id !== "string" || !item.id.trim() ||
        ids.has(item.id) || !Number.isSafeInteger(item.revision) || item.revision < 1 ||
        typeof item.changedAt !== "number" || !Number.isFinite(item.changedAt) || item.changedAt < 0) {
      throw new Error(`El historial de ${label} contiene identificadores o revisiones duplicadas.`);
    }
    ids.add(item.id);
    if (!previous) {
      if (item.revision !== 1 || !rules.isInitial(item)) {
        throw new Error(`El historial de ${label} debe comenzar en revisión 1 con una transición válida.`);
      }
    } else if (item.revision !== previous.revision + 1 ||
        !rules.continues(previous,item) ||
        item.changedAt < previous.changedAt) {
      throw new Error(`El historial de ${label} contiene una transición discontinua o una fecha regresiva.`);
    }
    previous = item;
  }
  return ordered;
}


async function appendLifecycleRecord<T extends LifecycleHistoryRecord>(
  db: IDBDatabase,
  historyStoreName: string,
  parentStoreName: string,
  item: T,
  subjectId: string,
  label: string,
  validate: (value: T, expectedProjectId?: string) => void,
  rules: LifecycleSequenceRules<T> = standardLifecycleSequenceRules<T>()
): Promise<void> {
  validate(item, item.projectId);
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([historyStoreName, parentStoreName], "readwrite");
    const historyStore = transaction.objectStore(historyStoreName);
    const parentStore = transaction.objectStore(parentStoreName);
    const parentRequest = parentStore.get([item.projectId, subjectId]);
    const historyRequest = historyStore.index("by-subject").getAll([item.projectId, subjectId]);
    let parentReady = false;
    let historyReady = false;
    let history: T[] = [];
    let failure: Error | undefined;
    let finished = false;

    const abortWith = (error: unknown): void => {
      if (finished) return;
      failure = error instanceof Error ? error : new Error(`No se pudo guardar el ciclo de vida de ${label}.`);
      finished = true;
      try { transaction.abort(); } catch { /* transacción ya abortada */ }
    };
    const commitIfReady = (): void => {
      if (finished || !parentReady || !historyReady) return;
      try {
        const parent = parentRequest.result as { readonly projectId?: string; readonly id?: string } | undefined;
        if (!parent || parent.projectId !== item.projectId || parent.id !== subjectId) {
          throw new Error(`No existe el elemento de destino del historial de ${label} en el proyecto activo.`);
        }
        const ordered = validateLifecycleSequence(history, label,rules);
        const previous = ordered[ordered.length - 1];
        if (!previous) {
          if (item.revision !== 1 || !rules.isInitial(item)) {
            throw new Error(`El primer cambio de ${label} debe comenzar en revisión 1 y declarar una transición válida.`);
          }
        } else if (item.revision !== previous.revision + 1 ||
            !rules.continues(previous,item) ||
            item.changedAt < previous.changedAt) {
          throw new Error(`El cambio de ${label} no continúa la última revisión durable.`);
        }
        if (ordered.some(existing => existing.id === item.id)) {
          throw new Error(`El ID del evento histórico de ${label} ya existe.`);
        }
        // add es deliberado: un evento confirmado nunca se reemplaza ni se edita.
        historyStore.add(item);
      } catch (error) {
        abortWith(error);
      }
    };

    parentRequest.onsuccess = () => { parentReady = true; commitIfReady(); };
    parentRequest.onerror = () => abortWith(
      parentRequest.error ?? new Error(`No se pudo verificar el elemento de destino del historial de ${label}.`)
    );
    historyRequest.onsuccess = () => {
      try {
        history = historyRequest.result as T[];
        if (!Array.isArray(history)) throw new Error(`El historial de ${label} almacenado no es una colección.`);
        for (const record of history) validate(record, item.projectId);
        historyReady = true;
        commitIfReady();
      } catch (error) {
        abortWith(error);
      }
    };
    historyRequest.onerror = () => abortWith(
      historyRequest.error ?? new Error(`No se pudo leer el historial de ${label}.`)
    );
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      failure ?? transaction.error ?? new Error(`No se pudo guardar el historial de ${label}.`)
    );
    transaction.onabort = () => reject(
      failure ?? transaction.error ?? new Error(`Se canceló el guardado del historial de ${label}.`)
    );
  });
}

async function loadLifecycleHistory<T extends LifecycleHistoryRecord>(
  db: IDBDatabase,
  historyStoreName: string,
  parentStoreName: string,
  projectId: string,
  subjectId: string,
  label: string,
  validate: (value: T, expectedProjectId?: string) => void,
  clone: (value: T) => T,
  rules: LifecycleSequenceRules<T> = standardLifecycleSequenceRules<T>()
): Promise<readonly T[]> {
  const transaction = db.transaction([historyStoreName, parentStoreName], "readonly");
  const historyRequest = transaction.objectStore(historyStoreName).index("by-subject")
    .getAll([projectId, subjectId]);
  const parentRequest = transaction.objectStore(parentStoreName).get([projectId, subjectId]);
  return new Promise((resolve, reject) => {
    let historyReady = false;
    let parentReady = false;
    let records: T[] = [];
    let failure: Error | undefined;
    const abortWith = (error: unknown): void => {
      failure = error instanceof Error ? error : new Error(`No se pudo leer el historial de ${label}.`);
      try { transaction.abort(); } catch { /* transacción ya abortada */ }
    };
    historyRequest.onsuccess = () => {
      try {
        records = historyRequest.result as T[];
        if (!Array.isArray(records)) throw new Error(`El historial de ${label} no es una colección.`);
        for (const record of records) validate(record, projectId);
        historyReady = true;
      } catch (error) {
        abortWith(error);
      }
    };
    historyRequest.onerror = () => abortWith(
      historyRequest.error ?? new Error(`No se pudo leer el historial de ${label}.`)
    );
    parentRequest.onsuccess = () => {
      const parent = parentRequest.result as { readonly projectId?: string; readonly id?: string } | undefined;
      if (!parent || parent.projectId !== projectId || parent.id !== subjectId) {
        abortWith(new Error(`No existe el elemento solicitado en el historial de ${label}.`));
      } else {
        parentReady = true;
      }
    };
    parentRequest.onerror = () => abortWith(
      parentRequest.error ?? new Error(`No se pudo verificar el elemento del historial de ${label}.`)
    );
    transaction.oncomplete = () => {
      if (failure) reject(failure);
      else if (!historyReady || !parentReady) reject(new Error(`La lectura del historial de ${label} quedó incompleta.`));
      else {
        try {
          const ordered = validateLifecycleSequence(records, label,rules);
          resolve(ordered.map(item => clone(item)));
        } catch (error) {
          reject(error);
        }
      }
    };
    transaction.onerror = () => reject(
      failure ?? transaction.error ?? new Error(`No se pudo leer el historial de ${label}.`)
    );
    transaction.onabort = () => reject(
      failure ?? transaction.error ?? new Error(`Se canceló la lectura del historial de ${label}.`)
    );
  });
}

async function saveEventWithLifecycle(
  db: IDBDatabase,
  event: NarrativeEvent,
  expectedCurrent: NarrativeEvent,
  lifecycle: EventLifecycle
): Promise<void> {
  validateNarrativeEventRecord(event,"acontecimiento");
  validateNarrativeEventRecord(expectedCurrent,"acontecimiento previo");
  validateEventLifecycle(lifecycle,event.projectId);
  const normalize = (ids: readonly string[]) => [...new Set(ids)].sort((a,b)=>a.localeCompare(b,"en"));
  if (event.projectId!==expectedCurrent.projectId || event.id!==expectedCurrent.id ||
      lifecycle.projectId!==event.projectId || lifecycle.eventId!==event.id ||
      lifecycle.previousLabel!==expectedCurrent.label || lifecycle.newLabel!==event.label ||
      JSON.stringify(lifecycle.previousParticipants)!==JSON.stringify(normalize(expectedCurrent.participants)) ||
      JSON.stringify(lifecycle.newParticipants)!==JSON.stringify(normalize(event.participants))) {
    throw new Error("La transición versionada no coincide con el cambio real del acontecimiento.");
  }
  await new Promise<void>((resolve,reject)=>{
    const transaction=db.transaction([EVENTS,EVENT_LIFECYCLES],"readwrite");
    const eventsStore=transaction.objectStore(EVENTS);
    const historyStore=transaction.objectStore(EVENT_LIFECYCLES);
    const currentRequest=eventsStore.get([event.projectId,event.id]);
    const historyRequest=historyStore.index("by-subject").getAll([event.projectId,event.id]);
    let currentReady=false;
    let historyReady=false;
    let history:EventLifecycle[]=[];
    let failure:Error|undefined;
    let finished=false;
    const abortWith=(error:unknown):void=>{
      if(finished)return;
      failure=error instanceof Error?error:new Error("No se pudo actualizar el acontecimiento y su historial.");
      finished=true;
      try{transaction.abort();}catch{/* transacción ya abortada */}
    };
    const commitIfReady=():void=>{
      if(finished || !currentReady || !historyReady)return;
      try{
        const current=currentRequest.result as NarrativeEvent|undefined;
        if(!current || JSON.stringify(current)!==JSON.stringify(expectedCurrent)){
          throw new Error("El acontecimiento cambió en otra instancia; actualiza la vista antes de registrar su evolución.");
        }
        for(const item of history)validateEventLifecycle(item,event.projectId);
        const ordered=validateLifecycleSequence(history,"acontecimiento",EVENT_LIFECYCLE_SEQUENCE_RULES);
        const previous=ordered[ordered.length-1];
        if(!previous){
          if(lifecycle.revision!==1 || !EVENT_LIFECYCLE_SEQUENCE_RULES.isInitial(lifecycle)){
            throw new Error("La primera transición de acontecimiento debe comenzar en revisión 1.");
          }
        }else if(lifecycle.revision!==previous.revision+1 ||
          !EVENT_LIFECYCLE_SEQUENCE_RULES.continues(previous,lifecycle) ||
          lifecycle.changedAt<previous.changedAt){
          throw new Error("La transición de acontecimiento no continúa la última revisión durable.");
        }
        if(ordered.some(item=>item.id===lifecycle.id)){
          throw new Error("El ID de la transición de acontecimiento ya existe.");
        }
        // Ambas escrituras comparten transacción: el snapshot vigente nunca queda
        // actualizado sin su correspondiente transición histórica.
        eventsStore.put(event);
        historyStore.add(lifecycle);
      }catch(error){abortWith(error);}
    };
    currentRequest.onsuccess=()=>{currentReady=true;commitIfReady();};
    currentRequest.onerror=()=>abortWith(currentRequest.error ?? new Error("No se pudo leer el acontecimiento vigente."));
    historyRequest.onsuccess=()=>{
      try{
        history=historyRequest.result as EventLifecycle[];
        if(!Array.isArray(history))throw new Error("El historial de acontecimiento no es una colección.");
        historyReady=true;
        commitIfReady();
      }catch(error){abortWith(error);}
    };
    historyRequest.onerror=()=>abortWith(historyRequest.error ?? new Error("No se pudo leer el historial de acontecimiento."));
    transaction.oncomplete=()=>resolve();
    transaction.onerror=()=>reject(failure ?? transaction.error ?? new Error("No se pudo confirmar el acontecimiento y su historial."));
    transaction.onabort=()=>reject(failure ?? transaction.error ?? new Error("Se canceló la actualización versionada del acontecimiento."));
  });
}

function validateLiveAuthorMonitorCheckpoint(
  checkpoint: StoredLiveAuthorMonitorCheckpoint,
  projectId?: string,
  documentId?: string
): void {
  if (!checkpoint || checkpoint.version !== 1 ||
      typeof checkpoint.projectId !== "string" || !checkpoint.projectId.trim() ||
      (projectId !== undefined && checkpoint.projectId !== projectId) ||
      typeof checkpoint.documentId !== "string" || !checkpoint.documentId.trim() ||
      (documentId !== undefined && checkpoint.documentId !== documentId) ||
      typeof checkpoint.sessionId !== "string" || !checkpoint.sessionId.trim()) {
    throw new Error("Checkpoint de monitoreo malformado o perteneciente a otra identidad: identidad.");
  }

  const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;
  const integerNonNegative = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
  const invalid: string[] = [];
  if (!finiteNonNegative(checkpoint.savedAt)) invalid.push("savedAt");
  if (!finiteNonNegative(checkpoint.sessionDurationMs)) invalid.push("sessionDurationMs");
  if (!finiteNonNegative(checkpoint.activeDurationMs)) invalid.push("activeDurationMs");
  if (!finiteNonNegative(checkpoint.idleDurationMs)) invalid.push("idleDurationMs");
  if (finiteNonNegative(checkpoint.sessionDurationMs) &&
      finiteNonNegative(checkpoint.activeDurationMs) &&
      finiteNonNegative(checkpoint.idleDurationMs) &&
      Math.abs(checkpoint.sessionDurationMs -
        checkpoint.activeDurationMs - checkpoint.idleDurationMs) > 1) {
    invalid.push("duration-balance");
  }
  if (!(checkpoint.lastActivityAgeMs === null ||
      (finiteNonNegative(checkpoint.lastActivityAgeMs) &&
        checkpoint.lastActivityAgeMs <= checkpoint.sessionDurationMs + 1))) {
    invalid.push("lastActivityAgeMs");
  }
  if (!integerNonNegative(checkpoint.pauseCount)) invalid.push("pauseCount");
  if (!integerNonNegative(checkpoint.acceptedChanges)) invalid.push("acceptedChanges");
  const classifiedActivityCounts = [checkpoint.typingChanges, checkpoint.pasteChanges,
    checkpoint.deletionChanges, checkpoint.correctionChanges, checkpoint.undoChanges,
    checkpoint.redoChanges];
  const hasActivityCounts = classifiedActivityCounts.some(value => value !== undefined) ||
    checkpoint.otherChanges !== undefined;
  if (hasActivityCounts) {
    if (classifiedActivityCounts.some(value => !integerNonNegative(value as number)) ||
        (checkpoint.otherChanges !== undefined && !integerNonNegative(checkpoint.otherChanges))) {
      invalid.push("activity-counts.values");
    } else if (integerNonNegative(checkpoint.acceptedChanges)) {
      const classifiedTotal = classifiedActivityCounts.reduce<number>((sum, value) => sum + (value as number), 0);
      const total = classifiedTotal + (checkpoint.otherChanges ?? checkpoint.acceptedChanges - classifiedTotal);
      if (total !== checkpoint.acceptedChanges) invalid.push("activity-counts.total");
    }
  }
  if (!integerNonNegative(checkpoint.rejectedChanges)) invalid.push("rejectedChanges");
  if (integerNonNegative(checkpoint.pauseCount) &&
      integerNonNegative(checkpoint.acceptedChanges) &&
      integerNonNegative(checkpoint.rejectedChanges) &&
      checkpoint.pauseCount > checkpoint.acceptedChanges + checkpoint.rejectedChanges) {
    invalid.push("pauseCount.activity-balance");
  }
  if (!integerNonNegative(checkpoint.committedChanges)) invalid.push("committedChanges");
  if (!integerNonNegative(checkpoint.failedChanges)) invalid.push("failedChanges");
  if (integerNonNegative(checkpoint.committedChanges) &&
      integerNonNegative(checkpoint.failedChanges) &&
      integerNonNegative(checkpoint.acceptedChanges)) {
    const commitOutcomeCount = checkpoint.committedChanges + checkpoint.failedChanges;
    if (!Number.isSafeInteger(commitOutcomeCount) ||
        commitOutcomeCount !== checkpoint.acceptedChanges) {
      invalid.push("commit-counts");
    }
  }
  if (!integerNonNegative(checkpoint.insertedCharacters)) invalid.push("insertedCharacters");
  if (!integerNonNegative(checkpoint.deletedCharacters)) invalid.push("deletedCharacters");
  if (!integerNonNegative(checkpoint.currentDocumentLength)) invalid.push("currentDocumentLength");
  if (integerNonNegative(checkpoint.insertedCharacters) &&
      integerNonNegative(checkpoint.deletedCharacters) &&
      integerNonNegative(checkpoint.currentDocumentLength) &&
      checkpoint.insertedCharacters >
        checkpoint.currentDocumentLength + checkpoint.deletedCharacters) {
    invalid.push("character-balance");
  }
  if (!integerNonNegative(checkpoint.revision)) invalid.push("revision");
  if (!integerNonNegative(checkpoint.sequence)) invalid.push("sequence");
  if (!integerNonNegative(checkpoint.resynchronizations)) invalid.push("resynchronizations");
  if (!finiteNonNegative(checkpoint.lastCommitLatencyMs)) invalid.push("lastCommitLatencyMs");
  if (!finiteNonNegative(checkpoint.totalCommitLatencyMs)) invalid.push("totalCommitLatencyMs");
  if (!Array.isArray(checkpoint.commitLatencies)) {
    invalid.push("commitLatencies");
  } else {
    if (checkpoint.commitLatencies.length > 4096) invalid.push("commitLatencies.length");
    if (Array.from(checkpoint.commitLatencies).some(value => !finiteNonNegative(value))) {
      invalid.push("commitLatencies.values");
    }
    const denseCommitLatencies = Array.from(checkpoint.commitLatencies);
    if (finiteNonNegative(checkpoint.totalCommitLatencyMs) &&
        denseCommitLatencies.every(value => finiteNonNegative(value)) &&
        denseCommitLatencies.reduce((sum, value) => sum + value, 0) >
          checkpoint.totalCommitLatencyMs + 1) {
      invalid.push("commitLatencies.total");
    }
    const commitOutcomeCount = checkpoint.committedChanges + checkpoint.failedChanges;
    if (integerNonNegative(checkpoint.committedChanges) &&
        integerNonNegative(checkpoint.failedChanges) &&
        Number.isSafeInteger(commitOutcomeCount)) {
      if (denseCommitLatencies.length > commitOutcomeCount ||
          (commitOutcomeCount > 0 && denseCommitLatencies.length === 0)) {
        invalid.push("commitLatencies.count");
      }
      if (denseCommitLatencies.length === 0 &&
          (checkpoint.lastCommitLatencyMs !== 0 || checkpoint.totalCommitLatencyMs !== 0)) {
        invalid.push("commitLatencies.empty-balance");
      }
      if (denseCommitLatencies.length > 0 &&
          denseCommitLatencies[denseCommitLatencies.length - 1] !== checkpoint.lastCommitLatencyMs) {
        invalid.push("commitLatencies.last");
      }
    }
  }
  if (invalid.length > 0) {
    throw new Error(
      "Checkpoint de monitoreo malformado o perteneciente a otra identidad: " +
      invalid.join(", ") + "."
    );
  }
}

function validateLiveAuthorMonitorLease(
  lease: StoredLiveAuthorMonitorLease,
  projectId?: string,
  documentId?: string
): void {
  if (!lease || lease.version !== 1 ||
      typeof lease.projectId !== "string" || !lease.projectId.trim() ||
      (projectId !== undefined && lease.projectId !== projectId) ||
      typeof lease.documentId !== "string" || !lease.documentId.trim() ||
      (documentId !== undefined && lease.documentId !== documentId) ||
      typeof lease.ownerId !== "string" || !lease.ownerId.trim() ||
      !Number.isSafeInteger(lease.fencingToken) || lease.fencingToken < 1 ||
      !Number.isFinite(lease.acquiredAt) || lease.acquiredAt < 0 ||
      !Number.isFinite(lease.expiresAt) || lease.expiresAt < lease.acquiredAt ||
      !Number.isFinite(lease.updatedAt) || lease.updatedAt < lease.acquiredAt ||
      lease.updatedAt > lease.expiresAt) {
    throw new Error("Lease del monitor malformado o perteneciente a otra identidad.");
  }
}

function validateLiveAuthorMonitorLeaseRequest(
  now: number,
  leaseDurationMs: number
): void {
  if (!Number.isSafeInteger(now) || now < 0 ||
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs < 1_000 || leaseDurationMs > 120_000 ||
      !Number.isSafeInteger(now + leaseDurationMs)) {
    throw new RangeError("El reloj o la duración del lease del monitor no son válidos.");
  }
}

function normalizeSyncOperation(operation: StoredSyncOperation): StoredSyncOperation {
  if (!operation || typeof operation !== "object") {
    throw new TypeError("La operación de sincronización no es válida.");
  }
  const fields: Array<[keyof StoredSyncOperation, unknown]> = [
    ["operationId", operation.operationId], ["projectId", operation.projectId],
    ["deviceId", operation.deviceId], ["kind", operation.kind], ["payload", operation.payload]
  ];
  for (const [field, value] of fields) {
    if (typeof value !== "string" || !value.trim() || value.length > 2_000_000) {
      throw new TypeError("Campo inválido en operación de sincronización: " + field + ".");
    }
  }
  if (operation.operationId.length > 256 || operation.projectId.length > 256 ||
      operation.deviceId.length > 256 || operation.kind.length > 160) {
    throw new RangeError("Los identificadores o el tipo de operación exceden el límite permitido.");
  }
  if (!Number.isSafeInteger(operation.sequence) || operation.sequence < 1 ||
      !Number.isFinite(operation.createdAt) || operation.createdAt < 0 ||
      !Number.isSafeInteger(operation.attemptCount) || operation.attemptCount < 0) {
    throw new TypeError("La secuencia, fecha o contador de intentos no son válidos.");
  }
  if (operation.lastAttemptAt !== undefined &&
      (!Number.isFinite(operation.lastAttemptAt) || operation.lastAttemptAt < 0)) {
    throw new TypeError("La fecha del último intento no es válida.");
  }
  if (operation.lastErrorCode !== undefined &&
      (typeof operation.lastErrorCode !== "string" || operation.lastErrorCode.length > 160)) {
    throw new TypeError("El último error de sincronización no es válido.");
  }
  let payload: unknown;
  try { payload = JSON.parse(operation.payload); }
  catch { throw new TypeError("El payload de sincronización debe ser JSON válido."); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("El payload de sincronización debe ser un objeto JSON.");
  }
  return {
    operationId: operation.operationId, projectId: operation.projectId,
    deviceId: operation.deviceId, sequence: operation.sequence, kind: operation.kind,
    payload: operation.payload, createdAt: operation.createdAt, attemptCount: operation.attemptCount,
    ...(operation.lastAttemptAt === undefined ? {} : { lastAttemptAt: operation.lastAttemptAt }),
    ...(operation.lastErrorCode === undefined ? {} : { lastErrorCode: operation.lastErrorCode })
  };
}

function normalizeSyncOperationDraft(operation: SyncOperationDraft): SyncOperationDraft {
  if (!operation || typeof operation !== "object") {
    throw new TypeError("La operación de sincronización no es válida.");
  }
  const normalized = normalizeSyncOperation({
    ...operation, sequence: 1, attemptCount: 0
  });
  return {
    operationId: normalized.operationId,
    projectId: normalized.projectId,
    deviceId: normalized.deviceId,
    kind: normalized.kind,
    payload: normalized.payload,
    createdAt: normalized.createdAt
  };
}
function queueSyncOperationInTransaction(
  transaction: IDBTransaction,
  operation: SyncOperationDraft,
  onError: (error: unknown) => void
): void {
  const normalized = normalizeSyncOperationDraft(operation);
  const sequenceStore = transaction.objectStore(SYNC_DEVICE_SEQUENCES);
  const outboxStore = transaction.objectStore(SYNC_OUTBOX);
  const request = sequenceStore.get([normalized.projectId, normalized.deviceId]);
  request.onsuccess = () => {
    try {
      const current = request.result as { readonly lastSequence?: unknown } | undefined;
      const lastSequence = current?.lastSequence ?? 0;
      if (!Number.isSafeInteger(lastSequence) || (lastSequence as number) < 0 ||
          (lastSequence as number) >= Number.MAX_SAFE_INTEGER) {
        throw new Error("El cursor de secuencia del dispositivo está corrupto o agotado.");
      }
      const stored = normalizeSyncOperation({
        ...normalized, sequence: (lastSequence as number) + 1, attemptCount: 0
      });
      const outboxRequest = outboxStore.add(stored);
      outboxRequest.onerror = () => onError(
        outboxRequest.error ?? new Error("No se pudo encolar la operación narrativa.")
      );
      const sequenceRequest = sequenceStore.put({
        projectId: normalized.projectId,
        deviceId: normalized.deviceId,
        lastSequence: stored.sequence
      });
      sequenceRequest.onerror = () => onError(
        sequenceRequest.error ?? new Error("No se pudo avanzar la secuencia narrativa del dispositivo.")
      );
    } catch (error) {
      onError(error);
    }
  };
  request.onerror = () => onError(
    request.error ?? new Error("No se pudo leer el cursor narrativo del dispositivo.")
  );
}
function syncOperationFingerprint(operation: StoredSyncOperation): string {
  // Los metadatos de transporte cambian durante los reintentos y no forman parte
  // de la identidad del cambio narrativo.
  return JSON.stringify([
    operation.operationId, operation.projectId, operation.deviceId, operation.sequence,
    operation.kind, operation.payload, operation.createdAt
  ]);
}

/**
 * Persistencia local mediante IndexedDB nativo del entorno.
 * No transmite manuscritos ni depende de servicios de terceros.
 */
export class IndexedDbProjectStore implements ProjectStore {
  readonly supportsAtomicNarrativeSyncOutbox = true;
  private database: Promise<IDBDatabase> | undefined;
  private narrativeChangeChannel: BroadcastChannel | undefined;
  private readonly narrativeChangeListeners = new Set<(projectId: string) => void>();

  private ensureNarrativeChangeChannel(): BroadcastChannel | undefined {
    if (typeof BroadcastChannel === "undefined") return undefined;
    if (this.narrativeChangeChannel) return this.narrativeChangeChannel;
    try {
      const channel = new BroadcastChannel(DATABASE_NAME + ":narrative-changes:v1");
      channel.onmessage = event => {
        const message = event.data;
        if (!message || typeof message !== "object" ||
            (message as { readonly type?: unknown }).type !== "motor-literario:narrative-change") return;
        const projectId = (message as { readonly projectId?: unknown }).projectId;
        if (typeof projectId !== "string" || !projectId.trim()) return;
        for (const listener of this.narrativeChangeListeners) {
          try { listener(projectId); } catch { /* Un suscriptor no debe bloquear a los demás. */ }
        }
      };
      // En Node, un canal de notificaciones no debe mantener vivo el proceso.
      (channel as BroadcastChannel & { unref?: () => void }).unref?.();
      this.narrativeChangeChannel = channel;
      return channel;
    } catch {
      // Algunos perfiles privados o entornos embebidos pueden bloquear BroadcastChannel.
      return undefined;
    }
  }

  subscribeNarrativeChanges(listener: (projectId: string) => void): () => void {
    if (typeof listener !== "function") throw new TypeError("Se requiere un suscriptor de cambios narrativos.");
    if (!this.ensureNarrativeChangeChannel()) return () => undefined;
    this.narrativeChangeListeners.add(listener);
    return () => {
      this.narrativeChangeListeners.delete(listener);
      if (this.narrativeChangeListeners.size === 0 && this.narrativeChangeChannel) {
        this.narrativeChangeChannel.onmessage = null;
        this.narrativeChangeChannel.close();
        this.narrativeChangeChannel = undefined;
      }
    };
  }

  private publishNarrativeChange(projectId: string): void {
    // Una escritura directa también debe avisar a otras pestañas aunque este
    // almacén no tenga suscriptores locales.
    const channel = this.ensureNarrativeChangeChannel();
    if (!channel) return;
    try {
      channel.postMessage({ type: "motor-literario:narrative-change", projectId });
    } catch {
      // La sincronización es complementaria: nunca debe invalidar una escritura ya confirmada.
    }
  }

  /**
   * Cierra la conexión IndexedDB de esta instancia. Las transacciones ya iniciadas
   * terminan antes de que IndexedDB complete el cierre; una operación posterior
   * puede abrir de nuevo la base de datos.
   */
  async close(): Promise<void> {
    const opening = this.database;
    if (!opening) {
      this.narrativeChangeChannel?.close();
      this.narrativeChangeChannel = undefined;
      this.narrativeChangeListeners.clear();
      return;
    }
    try {
      const db = await opening;
      db.close();
    } finally {
      if (this.database === opening) this.database = undefined;
      this.narrativeChangeChannel?.close();
      this.narrativeChangeChannel = undefined;
      this.narrativeChangeListeners.clear();
    }
  }

  private open(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new Error("IndexedDB no está disponible en este entorno."));
    }
    if (this.database) return this.database;

    let opening!: Promise<IDBDatabase>;
    opening = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        // La función ejecutora de Promise es síncrona: diferimos la limpieza
        // para que this.database ya apunte a esta promesa, incluso si open() lanza.
        void Promise.resolve().then(() => {
          if (this.database === opening) this.database = undefined;
        });
        reject(error);
      };

      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("No se pudo iniciar la apertura de la base local."));
        return;
      }

      request.onupgradeneeded = (event) => {
        // Si onblocked ya rechazó la apertura, el navegador puede reanudar
        // esta migración cuando se cierre la conexión que la bloqueaba.
        // Abortamos antes de tocar el esquema para no modificar la base
        // después de haber informado que la apertura falló.
        if (settled) {
          request.transaction?.abort();
          return;
        }
        const db = request.result;
        if (!db.objectStoreNames.contains(NARRATIVE_REFERENCE_REPAIR_AUDITS)) {
          db.createObjectStore(NARRATIVE_REFERENCE_REPAIR_AUDITS, {
            keyPath: ["projectId", "operationId"]
          });
        }
        if (!db.objectStoreNames.contains(NARRATIVE_REFERENCE_REPAIR_PENDING)) {
          db.createObjectStore(NARRATIVE_REFERENCE_REPAIR_PENDING, {
            keyPath: ["projectId", "operationId"]
          });
        }
        if (!db.objectStoreNames.contains(PROJECT_SETTINGS)) {
          const settings = db.createObjectStore(PROJECT_SETTINGS, {
            keyPath: ["projectId", "key"]
          });
          settings.createIndex("by-project", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(LANGUAGE_PROFILES)) {
          const profiles = db.createObjectStore(LANGUAGE_PROFILES, {
            keyPath: ["projectId", "id"]
          });
          profiles.createIndex("by-project", "projectId", { unique: false });
          profiles.createIndex("by-project-language", ["projectId", "languageIdentifier"], { unique: false });
          profiles.createIndex("by-project-active", ["projectId", "isActive"], { unique: false });
        }
        if (!db.objectStoreNames.contains(LANGUAGE_RESOURCE_REFS)) {
          const resources = db.createObjectStore(LANGUAGE_RESOURCE_REFS, {
            keyPath: ["projectId", "id"]
          });
          resources.createIndex("by-project", "projectId", { unique: false });
          resources.createIndex("by-profile", ["projectId", "profileId"], { unique: false });
          resources.createIndex("by-resource-database", ["projectId", "resourceDatabaseId"], { unique: false });
        }
        if (!db.objectStoreNames.contains(STYLE_PROFILES)) {
          const profiles = db.createObjectStore(STYLE_PROFILES, {
            keyPath: ["projectId", "id"]
          });
          profiles.createIndex("by-project", "projectId", { unique: false });
          profiles.createIndex("by-project-name", ["projectId", "profileName"], { unique: false });
        }
        if (!db.objectStoreNames.contains(TIMELINE_TRACKS)) {
          const tracks = db.createObjectStore(TIMELINE_TRACKS, {
            keyPath: ["projectId", "id"]
          });
          tracks.createIndex("by-project", "projectId", { unique: false });
          tracks.createIndex("by-project-name", ["projectId", "trackName"], { unique: false });
        }
        if (!db.objectStoreNames.contains(RECORD_LIFECYCLES)) {
          const lifecycles = db.createObjectStore(RECORD_LIFECYCLES, { keyPath: ["projectId", "id"] });
          lifecycles.createIndex("by-project", "projectId", { unique: false });
          lifecycles.createIndex("by-subject", ["projectId", "recordId"], { unique: false });
          lifecycles.createIndex("by-subject-revision", ["projectId", "recordId", "revision"], { unique: true });
        }
        if (!db.objectStoreNames.contains(RELATION_LIFECYCLES)) {
          const lifecycles = db.createObjectStore(RELATION_LIFECYCLES, { keyPath: ["projectId", "id"] });
          lifecycles.createIndex("by-project", "projectId", { unique: false });
          lifecycles.createIndex("by-subject", ["projectId", "relationId"], { unique: false });
          lifecycles.createIndex("by-subject-revision", ["projectId", "relationId", "revision"], { unique: true });
        }
        if (!db.objectStoreNames.contains(EVENT_LIFECYCLES)) {
          const lifecycles = db.createObjectStore(EVENT_LIFECYCLES, { keyPath: ["projectId", "id"] });
          lifecycles.createIndex("by-project", "projectId", { unique: false });
          lifecycles.createIndex("by-subject", ["projectId", "eventId"], { unique: false });
          lifecycles.createIndex("by-subject-revision", ["projectId", "eventId", "revision"], { unique: true });
        }
        if (!db.objectStoreNames.contains(DOCUMENTS)) {
          const store = db.createObjectStore(DOCUMENTS, { keyPath: ["projectId", "documentId"] });
          store.createIndex("by-project", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(CHANGES)) {
          const changes = db.createObjectStore(CHANGES, {
            keyPath: ["projectId", "documentId", "sequence"]
          });
          changes.createIndex(CHANGE_INDEX, ["projectId", "documentId", "sequence"], { unique: true });
        }
        if (!db.objectStoreNames.contains(ENTITIES)) {
          const entities = db.createObjectStore(ENTITIES, { keyPath: ["projectId", "id"] });
          entities.createIndex("by-project", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(RELATIONS)) {
          const relations = db.createObjectStore(RELATIONS, { keyPath: ["projectId", "id"] });
          relations.createIndex("by-project", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(EVENTS)) {
          const events = db.createObjectStore(EVENTS, { keyPath: ["projectId", "id"] });
          events.createIndex("by-project", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(IDEAS)) {
          const ideas = db.createObjectStore(IDEAS, { keyPath: ["projectId", "id"] });
          ideas.createIndex("by-project", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(PERSONAL_IDEAS)) {
          const personalIdeas = db.createObjectStore(PERSONAL_IDEAS, {
            keyPath: ["writerId", "sourceProjectId", "idea.id"]
          });
          personalIdeas.createIndex("by-writer", "writerId", { unique: false });
          personalIdeas.createIndex("by-writer-source", ["writerId", "sourceProjectId"], { unique: false });
          personalIdeas.createIndex(PERSONAL_IDEA_SOURCE_INDEX, "sourceProjectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(FINALIZATION_RECEIPTS)) {
          const receipts = db.createObjectStore(FINALIZATION_RECEIPTS, {
            keyPath: ["writerId", "sourceProjectId", "receiptId"]
          });
          receipts.createIndex("by-writer", "writerId", { unique: false });
          receipts.createIndex("by-writer-source", ["writerId", "sourceProjectId"], { unique: false });
        }
        if (!db.objectStoreNames.contains(ASSERTIONS)) {
          const assertions = db.createObjectStore(ASSERTIONS, { keyPath: ["projectId", "id"] });
          assertions.createIndex("by-project", "projectId", { unique: false });
          assertions.createIndex("by-entity", ["projectId", "entityId"], { unique: false });
        }
        if (!db.objectStoreNames.contains(NARRATIVE_PROJECTION_MANIFESTS)) {
          const manifests = db.createObjectStore(NARRATIVE_PROJECTION_MANIFESTS, {
            keyPath: ["projectId", "documentId"]
          });
          manifests.createIndex("by-project", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(DIAGNOSTICS)) {
          const diagnostics = db.createObjectStore(DIAGNOSTICS, {
            keyPath: ["projectId", "documentId"]
          });
          diagnostics.createIndex("by-project", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(LIVE_AUTHOR_MONITOR_CHECKPOINTS)) {
          const checkpoints = db.createObjectStore(LIVE_AUTHOR_MONITOR_CHECKPOINTS, {
            keyPath: ["projectId", "documentId"]
          });
          checkpoints.createIndex("by-project", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(LIVE_AUTHOR_MONITOR_LEASES)) {
          const leases = db.createObjectStore(LIVE_AUTHOR_MONITOR_LEASES, {
            keyPath: ["projectId", "documentId"]
          });
          leases.createIndex("by-project", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(MANUSCRIPT_FRAGMENTS)) {
          const fragments = db.createObjectStore(MANUSCRIPT_FRAGMENTS, { keyPath: ["projectId", "id"] });
          fragments.createIndex("by-project", "projectId", { unique: false });
          fragments.createIndex("by-document-revision", ["projectId", "documentId", "revision"], { unique: false });
          fragments.createIndex("by-parent", ["projectId", "parentFragmentId"], { unique: false });
        }
        if (!db.objectStoreNames.contains(RECORD_ATTRIBUTES)) {
          const attributes = db.createObjectStore(RECORD_ATTRIBUTES, { keyPath: ["projectId", "id"] });
          attributes.createIndex("by-project", "projectId", { unique: false });
          attributes.createIndex("by-record-key", ["projectId", "recordId", "attributeKey"], { unique: false });
        }
        if (!db.objectStoreNames.contains(RELATION_ATTRIBUTES)) {
          const attributes = db.createObjectStore(RELATION_ATTRIBUTES, { keyPath: ["projectId", "id"] });
          attributes.createIndex("by-project", "projectId", { unique: false });
          attributes.createIndex("by-relation-key", ["projectId", "relationId", "attributeKey"], { unique: false });
        }
        if (!db.objectStoreNames.contains(ACTIVE_SUGGESTIONS)) {
          const suggestions = db.createObjectStore(ACTIVE_SUGGESTIONS, { keyPath: ["projectId", "id"] });
          suggestions.createIndex("by-project", "projectId", { unique: false });
          suggestions.createIndex("by-document-revision", ["projectId", "documentId", "documentRevision"], { unique: false });
          suggestions.createIndex("by-status-priority", ["projectId", "status", "priority"], { unique: false });
        }
        if (!db.objectStoreNames.contains(IMPORT_AUTHORIZATIONS)) {
          const authorizations = db.createObjectStore(IMPORT_AUTHORIZATIONS, {
            keyPath: ["writerId", "sourceProjectId", "targetProjectId", "authorizationId"]
          });
          authorizations.createIndex("by-writer", "writerId", { unique: false });
          authorizations.createIndex("by-source-target", ["writerId", "sourceProjectId", "targetProjectId"], { unique: false });
          authorizations.createIndex("by-target", ["writerId", "targetProjectId"], { unique: false });
        }
        if (!db.objectStoreNames.contains(SCHEMA_MIGRATIONS)) {
          const migrations = db.createObjectStore(SCHEMA_MIGRATIONS, { keyPath: "migrationId" });
          migrations.createIndex("by-to-version", "toVersion", { unique: false });
          migrations.createIndex("by-applied-at", "appliedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(PROJECT_RECORDS)) {
          const records = db.createObjectStore(PROJECT_RECORDS, { keyPath: ["projectId", "id"] });
          records.createIndex("by-project", "projectId", { unique: false });
          records.createIndex("by-project-type", ["projectId", "recordType"], { unique: false });
          records.createIndex("by-project-name", ["projectId", "primaryName"], { unique: false });
          records.createIndex("by-project-label-state", ["projectId", "label", "state"], { unique: false });
          records.createIndex("by-project-updated", ["projectId", "updatedAt"], { unique: false });
        }
        if (!db.objectStoreNames.contains(RECORD_NAMES)) {
          const names = db.createObjectStore(RECORD_NAMES, { keyPath: ["projectId", "id"] });
          names.createIndex("by-project", "projectId", { unique: false });
          names.createIndex("by-record", ["projectId", "recordId"], { unique: false });
          names.createIndex("by-name", ["projectId", "name"], { unique: false });
        }
        if (!db.objectStoreNames.contains(PROJECT_RELATIONS)) {
          const relations = db.createObjectStore(PROJECT_RELATIONS, { keyPath: ["projectId", "id"] });
          relations.createIndex("by-project", "projectId", { unique: false });
          relations.createIndex("by-source", ["projectId", "sourceRecordId"], { unique: false });
          relations.createIndex("by-target", ["projectId", "targetRecordId"], { unique: false });
          relations.createIndex("by-type", ["projectId", "relationType"], { unique: false });
        }
        if (!db.objectStoreNames.contains(PROJECT_EVIDENCES)) {
          const evidences = db.createObjectStore(PROJECT_EVIDENCES, { keyPath: ["projectId", "id"] });
          evidences.createIndex("by-project", "projectId", { unique: false });
          evidences.createIndex("by-subject-record", ["projectId", "subjectRecordId"], { unique: false });
          evidences.createIndex("by-subject-relation", ["projectId", "subjectRelationId"], { unique: false });
          evidences.createIndex("by-document", ["projectId", "documentId"], { unique: false });
          evidences.createIndex("by-fragment", ["projectId", "fragmentId"], { unique: false });
        }
        if (!db.objectStoreNames.contains(TIMELINE_OCCURRENCES)) {
          const occurrences = db.createObjectStore(TIMELINE_OCCURRENCES, { keyPath: ["projectId", "id"] });
          occurrences.createIndex("by-project", "projectId", { unique: false });
          occurrences.createIndex("by-event-record", ["projectId", "eventRecordId"], { unique: false });
          occurrences.createIndex("by-track-order", ["projectId", "trackId", "narrativeOrder"], { unique: false });
        }
        if (!db.objectStoreNames.contains(DICTIONARIES)) {
          const dictionaries = db.createObjectStore(DICTIONARIES, {
            keyPath: ["projectId", "id"]
          });
          dictionaries.createIndex("by-project", "projectId", { unique: false });
          dictionaries.createIndex(
            "by-project-language-name", ["projectId", "languageIdentifier", "normalizedName"],
            { unique: true }
          );
        }
        if (!db.objectStoreNames.contains(DICTIONARY_ENTRIES)) {
          const dictionaryEntries = db.createObjectStore(DICTIONARY_ENTRIES, {
            keyPath: ["projectId", "id"]
          });
          dictionaryEntries.createIndex("by-project", "projectId", { unique: false });
          dictionaryEntries.createIndex(
            "by-dictionary", ["projectId", "dictionaryId"], { unique: false }
          );
          dictionaryEntries.createIndex(
            "by-dictionary-normalized", ["projectId", "dictionaryId", "normalizedForm"],
            { unique: true }
          );
        }
        if (!db.objectStoreNames.contains(DICTIONARY_ENTRY_ENTITIES)) {
          const links = db.createObjectStore(DICTIONARY_ENTRY_ENTITIES, {
            keyPath: ["projectId", "entryId", "recordId"]
          });
          links.createIndex("by-project", "projectId", { unique: false });
          links.createIndex("by-entry", ["projectId", "entryId"], { unique: false });
          links.createIndex("by-record", ["projectId", "recordId"], { unique: false });
        }

        // Las bases creadas por versiones anteriores pueden tener ya el
        // object store pero carecer de un índice añadido posteriormente.
        // Aseguramos cada índice de forma independiente durante la migración.
        const upgrade = request.transaction;
        if (!upgrade) throw new Error("No se pudo obtener la transacción de migración de IndexedDB.");
        const ensureIndex = (
          storeName: string,
          indexName: string,
          keyPath: string | string[],
          unique = false
        ): void => {
          const store = upgrade.objectStore(storeName);
          const expectedKeyPath = Array.isArray(keyPath) ? keyPath : keyPath;
          if (store.indexNames.contains(indexName)) {
            const existing = store.index(indexName);
            const actualKeyPath = Array.isArray(existing.keyPath)
              ? Array.from(existing.keyPath)
              : existing.keyPath;
            const keyPathMatches = Array.isArray(expectedKeyPath)
              ? Array.isArray(actualKeyPath) &&
                expectedKeyPath.length === actualKeyPath.length &&
                expectedKeyPath.every((part, index) => part === actualKeyPath[index])
              : actualKeyPath === expectedKeyPath;
            if (keyPathMatches && existing.unique === unique) return;
            // IndexedDB permite reemplazar índices durante onupgradeneeded.
            // Si hay duplicados incompatibles con un índice único, la propia
            // migración abortará en lugar de dejar una definición debilitada.
            store.deleteIndex(indexName);
          }
          store.createIndex(indexName, keyPath, { unique });
        };
        ensureIndex(NARRATIVE_REFERENCE_REPAIR_AUDITS, "by-project", "projectId");
        ensureIndex(NARRATIVE_REFERENCE_REPAIR_PENDING, "by-project", "projectId");
        ensureIndex(PROJECT_SETTINGS, "by-project", "projectId");
        ensureIndex(LANGUAGE_PROFILES, "by-project", "projectId");
        ensureIndex(LANGUAGE_PROFILES, "by-project-language", ["projectId", "languageIdentifier"]);
        ensureIndex(LANGUAGE_PROFILES, "by-project-active", ["projectId", "isActive"]);
        ensureIndex(LANGUAGE_RESOURCE_REFS, "by-project", "projectId");
        ensureIndex(LANGUAGE_RESOURCE_REFS, "by-profile", ["projectId", "profileId"]);
        ensureIndex(LANGUAGE_RESOURCE_REFS, "by-resource-database", ["projectId", "resourceDatabaseId"]);
        ensureIndex(STYLE_PROFILES, "by-project", "projectId");
        ensureIndex(STYLE_PROFILES, "by-project-name", ["projectId", "profileName"]);
        ensureIndex(TIMELINE_TRACKS, "by-project", "projectId");
        ensureIndex(TIMELINE_TRACKS, "by-project-name", ["projectId", "trackName"]);
        ensureIndex(RECORD_LIFECYCLES, "by-project", "projectId");
        ensureIndex(RECORD_LIFECYCLES, "by-subject", ["projectId", "recordId"]);
        ensureIndex(RECORD_LIFECYCLES, "by-subject-revision", ["projectId", "recordId", "revision"], true);
        ensureIndex(RELATION_LIFECYCLES, "by-project", "projectId");
        ensureIndex(RELATION_LIFECYCLES, "by-subject", ["projectId", "relationId"]);
        ensureIndex(RELATION_LIFECYCLES, "by-subject-revision", ["projectId", "relationId", "revision"], true);
        ensureIndex(EVENT_LIFECYCLES, "by-project", "projectId");
        ensureIndex(EVENT_LIFECYCLES, "by-subject", ["projectId", "eventId"]);
        ensureIndex(EVENT_LIFECYCLES, "by-subject-revision", ["projectId", "eventId", "revision"], true);
        ensureIndex(DOCUMENTS, "by-project", "projectId");
        ensureIndex(CHANGES, CHANGE_INDEX, ["projectId", "documentId", "sequence"], true);
        ensureIndex(ENTITIES, "by-project", "projectId");
        ensureIndex(RELATIONS, "by-project", "projectId");
        ensureIndex(EVENTS, "by-project", "projectId");
        ensureIndex(IDEAS, "by-project", "projectId");
        ensureIndex(PERSONAL_IDEAS, "by-writer", "writerId");
        ensureIndex(PERSONAL_IDEAS, "by-writer-source", ["writerId", "sourceProjectId"]);
        ensureIndex(PERSONAL_IDEAS, PERSONAL_IDEA_SOURCE_INDEX, "sourceProjectId");
        ensureIndex(FINALIZATION_RECEIPTS, "by-writer", "writerId");
        ensureIndex(FINALIZATION_RECEIPTS, "by-writer-source", ["writerId", "sourceProjectId"]);
        ensureIndex(ASSERTIONS, "by-project", "projectId");
        ensureIndex(ASSERTIONS, "by-entity", ["projectId", "entityId"]);
        ensureIndex(NARRATIVE_PROJECTION_MANIFESTS, "by-project", "projectId");
        ensureIndex(DIAGNOSTICS, "by-project", "projectId");
        ensureIndex(LIVE_AUTHOR_MONITOR_CHECKPOINTS, "by-project", "projectId");
        ensureIndex(LIVE_AUTHOR_MONITOR_LEASES, "by-project", "projectId");
        ensureIndex(DICTIONARIES, "by-project", "projectId");
        ensureIndex(
          DICTIONARIES, "by-project-language-name",
          ["projectId", "languageIdentifier", "normalizedName"], true
        );
        ensureIndex(DICTIONARY_ENTRIES, "by-project", "projectId");
        ensureIndex(
          DICTIONARY_ENTRIES, "by-dictionary", ["projectId", "dictionaryId"]
        );
        ensureIndex(
          DICTIONARY_ENTRIES, "by-dictionary-normalized",
          ["projectId", "dictionaryId", "normalizedForm"], true
        );
        ensureIndex(DICTIONARY_ENTRY_ENTITIES, "by-project", "projectId");
        ensureIndex(DICTIONARY_ENTRY_ENTITIES, "by-entry", ["projectId", "entryId"]);
        ensureIndex(DICTIONARY_ENTRY_ENTITIES, "by-record", ["projectId", "recordId"]);

        // v21 separa los vínculos y conserva las asociaciones existentes.
        // Su fecha registra la materialización de la migración, no una fecha
        // histórica inventada; la procedencia queda explícitamente marcada.
        const changeEvent = event && typeof event === "object"
          ? event as IDBVersionChangeEvent
          : undefined;
        const previousVersion = changeEvent && Number.isSafeInteger(changeEvent.oldVersion)
          ? changeEvent.oldVersion
          : 0;
        if (previousVersion > 0 && previousVersion < 21) {
          const legacyEntries = upgrade.objectStore(DICTIONARY_ENTRIES);
          const migratedLinks = upgrade.objectStore(DICTIONARY_ENTRY_ENTITIES);
          const entityStore = upgrade.objectStore(ENTITIES);
          const migrationTimestamp = Date.now();
          const cursorRequest = legacyEntries.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const legacyEntry = cursor.value as DictionaryEntry;
            const ids = Array.isArray(legacyEntry.relatedEntityIds)
              ? [...new Set(legacyEntry.relatedEntityIds)]
              : [];
            if (ids.length === 0) {
              cursor.continue();
              return;
            }
            let pending = ids.length;
            for (const recordId of ids) {
              const entityRequest = entityStore.get([legacyEntry.projectId, recordId]);
              entityRequest.onsuccess = () => {
                const entity = entityRequest.result as NarrativeEntity | undefined;
                if (!entity || entity.projectId !== legacyEntry.projectId || entity.id !== recordId) {
                  upgrade.abort();
                  return;
                }
                migratedLinks.put({
                  projectId: legacyEntry.projectId,
                  entryId: legacyEntry.id,
                  recordId,
                  linkKind: "RELATED",
                  provenanceKind: "MIGRATION",
                  createdAt: migrationTimestamp
                } satisfies DictionaryEntryEntityLink);
                pending--;
                if (pending === 0) cursor.continue();
              };
              entityRequest.onerror = () => upgrade.abort();
            }
          };
          cursorRequest.onerror = () => upgrade.abort();
        }
        ensureIndex(MANUSCRIPT_FRAGMENTS, "by-project", "projectId");
        ensureIndex(MANUSCRIPT_FRAGMENTS, "by-document-revision", ["projectId", "documentId", "revision"]);
        ensureIndex(MANUSCRIPT_FRAGMENTS, "by-parent", ["projectId", "parentFragmentId"]);
        ensureIndex(RECORD_ATTRIBUTES, "by-project", "projectId");
        ensureIndex(RECORD_ATTRIBUTES, "by-record-key", ["projectId", "recordId", "attributeKey"]);
        ensureIndex(RELATION_ATTRIBUTES, "by-project", "projectId");
        ensureIndex(RELATION_ATTRIBUTES, "by-relation-key", ["projectId", "relationId", "attributeKey"]);
        ensureIndex(ACTIVE_SUGGESTIONS, "by-project", "projectId");
        ensureIndex(ACTIVE_SUGGESTIONS, "by-document-revision", ["projectId", "documentId", "documentRevision"]);
        ensureIndex(ACTIVE_SUGGESTIONS, "by-status-priority", ["projectId", "status", "priority"]);
        ensureIndex(IMPORT_AUTHORIZATIONS, "by-writer", "writerId");
        ensureIndex(IMPORT_AUTHORIZATIONS, "by-source-target", ["writerId", "sourceProjectId", "targetProjectId"]);
        ensureIndex(IMPORT_AUTHORIZATIONS, "by-target", ["writerId", "targetProjectId"]);
        ensureIndex(SCHEMA_MIGRATIONS, "by-to-version", "toVersion");
        ensureIndex(SCHEMA_MIGRATIONS, "by-applied-at", "appliedAt");
        ensureIndex(PROJECT_RECORDS, "by-project", "projectId");
        ensureIndex(PROJECT_RECORDS, "by-project-type", ["projectId", "recordType"]);
        ensureIndex(PROJECT_RECORDS, "by-project-name", ["projectId", "primaryName"]);
        ensureIndex(PROJECT_RECORDS, "by-project-label-state", ["projectId", "label", "state"]);
        ensureIndex(PROJECT_RECORDS, "by-project-updated", ["projectId", "updatedAt"]);
        ensureIndex(RECORD_NAMES, "by-project", "projectId");
        ensureIndex(RECORD_NAMES, "by-record", ["projectId", "recordId"]);
        ensureIndex(RECORD_NAMES, "by-name", ["projectId", "name"]);
        ensureIndex(PROJECT_RELATIONS, "by-project", "projectId");
        ensureIndex(PROJECT_RELATIONS, "by-source", ["projectId", "sourceRecordId"]);
        ensureIndex(PROJECT_RELATIONS, "by-target", ["projectId", "targetRecordId"]);
        ensureIndex(PROJECT_RELATIONS, "by-type", ["projectId", "relationType"]);
        ensureIndex(PROJECT_EVIDENCES, "by-project", "projectId");
        ensureIndex(PROJECT_EVIDENCES, "by-subject-record", ["projectId", "subjectRecordId"]);
        ensureIndex(PROJECT_EVIDENCES, "by-subject-relation", ["projectId", "subjectRelationId"]);
        ensureIndex(PROJECT_EVIDENCES, "by-document", ["projectId", "documentId"]);
        ensureIndex(PROJECT_EVIDENCES, "by-fragment", ["projectId", "fragmentId"]);
        ensureIndex(TIMELINE_OCCURRENCES, "by-project", "projectId");
        ensureIndex(TIMELINE_OCCURRENCES, "by-event-record", ["projectId", "eventRecordId"]);
        ensureIndex(TIMELINE_OCCURRENCES, "by-track-order", ["projectId", "trackId", "narrativeOrder"]);
        // DB26: bandeja de operaciones pendiente y cursor persistente por dispositivo.
        // La creación es idempotente y conserva íntegros los almacenes de DB27.
        if (!db.objectStoreNames.contains(SYNC_OUTBOX)) {
          db.createObjectStore(SYNC_OUTBOX, { keyPath: "operationId" });
        }
        ensureIndex(SYNC_OUTBOX, "by-project-created-at", ["projectId", "createdAt"]);
        ensureIndex(SYNC_OUTBOX, "by-project-device-sequence", ["projectId", "deviceId", "sequence"], true);
        if (!db.objectStoreNames.contains(SYNC_DEVICE_SEQUENCES)) {
          db.createObjectStore(SYNC_DEVICE_SEQUENCES, { keyPath: ["projectId", "deviceId"] });
        }
        const nextVersion = changeEvent && Number.isSafeInteger(changeEvent.newVersion)
          ? changeEvent.newVersion
          : DATABASE_VERSION;
        const migration: SchemaMigration = {
          migrationId: `indexeddb-v${nextVersion}`,
          fromVersion: String(previousVersion),
          toVersion: String(nextVersion),
          appliedAt: Date.now(),
          result: "APPLIED",
          checksum: `motor-literario-mldb-0.4.2-indexeddb-${nextVersion}`
        };
        validateSchemaMigration(migration);
        if (changeEvent) {
          upgrade.objectStore(SCHEMA_MIGRATIONS).put(cloneSchemaMigration(migration));
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Un onblocked puede haber rechazado la apertura antes de que el
        // navegador termine de resolverla. No dejamos una conexión huérfana.
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        db.onversionchange = () => {
          db.close();
          if (this.database === opening) this.database = undefined;
        };
        // El navegador puede cerrar una conexión por causas externas
        // (por ejemplo, cierre forzado o pérdida del almacenamiento). Si no
        // invalidamos la promesa cacheada, todas las operaciones futuras
        // seguirán intentando usar una conexión que ya no está activa.
        db.onclose = () => {
          if (this.database === opening) this.database = undefined;
        };
        resolve(db);
      };
      request.onerror = () => fail(request.error ?? new Error("No se pudo abrir la base local."));
      request.onblocked = () => fail(new Error("La apertura de la base local está bloqueada por otra conexión."));
    });
    this.database = opening;
    return opening;
  }



  /** Crea o actualiza un diccionario. Las actualizaciones usan comparación optimista. */
  async loadProjectSettings(projectId: string): Promise<readonly ProjectSetting[]> {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Identificador de proyecto inválido para cargar configuraciones.");
    }
    const db = await this.open();
    const transaction = db.transaction(PROJECT_SETTINGS, "readonly");
    const request = transaction.objectStore(PROJECT_SETTINGS).index("by-project").getAll(projectId);
    const settings = await readAfterTransaction(
      transaction, request, "No se pudieron recuperar las configuraciones del proyecto."
    ) as ProjectSetting[];
    if (!Array.isArray(settings)) {
      throw new Error("La colección de configuraciones del proyecto no es válida.");
    }
    const keys = new Set<string>();
    for (const setting of settings) {
      validateProjectSetting(setting, projectId);
      if (keys.has(setting.key)) {
        throw new Error("Integridad de configuraciones: hay claves duplicadas dentro del proyecto.");
      }
      keys.add(setting.key);
    }
    return settings.map(cloneProjectSetting);
  }

  async saveProjectSetting(
    setting: ProjectSetting,
    expectedCurrent?: ProjectSetting
  ): Promise<void> {
    validateProjectSetting(setting);
    if (expectedCurrent) {
      validateProjectSetting(expectedCurrent, setting.projectId);
      if (expectedCurrent.key !== setting.key) {
        throw new Error("La actualización de configuración debe conservar la clave original.");
      }
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(PROJECT_SETTINGS, "readwrite");
      const store = transaction.objectStore(PROJECT_SETTINGS);
      const request = store.get([setting.projectId, setting.key]);
      let conflict = false;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const current = request.result as ProjectSetting | undefined;
          if (expectedCurrent) {
            if (!current || current.projectId !== setting.projectId ||
                current.key !== setting.key ||
                JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
              conflict = true;
              throw new Error("La configuración cambió en otra instancia; vuelve a leerla antes de actualizar.");
            }
          } else if (current) {
            conflict = true;
            throw new Error("La configuración ya existe; vuelve a leerla antes de actualizar.");
          }
          store.put(cloneProjectSetting(setting));
        } catch (error) {
          failure = error;
          try { transaction.abort(); } catch { /* la transacción ya está abortada */ }
        }
      };
      request.onerror = () => {
        failure = request.error ?? new Error("No se pudo verificar la configuración actual.");
        try { transaction.abort(); } catch { /* la transacción ya está abortada */ }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("No se pudo guardar la configuración."));
      transaction.onabort = () => reject(failure ?? (conflict
        ? new Error("Conflicto al guardar la configuración del proyecto.")
        : transaction.error ?? new Error("Se canceló el guardado de la configuración.")));
    });
  }

  async loadLanguageProfiles(projectId: string): Promise<readonly LanguageProfile[]> {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Identificador de proyecto inválido para recuperar perfiles lingüísticos.");
    }
    const db = await this.open();
    const transaction = db.transaction(LANGUAGE_PROFILES, "readonly");
    const request = transaction.objectStore(LANGUAGE_PROFILES).index("by-project").getAll(projectId);
    const profiles = await readAfterTransaction(
      transaction, request, "No se pudieron recuperar perfiles lingüísticos."
    ) as LanguageProfile[];
    if (!Array.isArray(profiles)) throw new Error("La colección de perfiles lingüísticos es inválida.");
    const ids = new Set<string>();
    for (const profile of profiles) {
      validateLanguageProfile(profile, projectId);
      if (ids.has(profile.id)) throw new Error("Hay IDs de perfil lingüístico duplicados en el proyecto.");
      ids.add(profile.id);
    }
    return profiles.map(cloneLanguageProfile);
  }

  async saveLanguageProfile(
    profile: LanguageProfile,
    expectedCurrent?: LanguageProfile
  ): Promise<void> {
    validateLanguageProfile(profile);
    if (expectedCurrent) {
      validateLanguageProfile(expectedCurrent, profile.projectId);
      if (expectedCurrent.id !== profile.id) {
        throw new Error("Una actualización debe conservar la identidad del perfil lingüístico.");
      }
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(LANGUAGE_PROFILES, "readwrite");
      const store = transaction.objectStore(LANGUAGE_PROFILES);
      const request = store.get([profile.projectId, profile.id]);
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const current = request.result as LanguageProfile | undefined;
          if (expectedCurrent) {
            if (!current || current.projectId !== profile.projectId ||
                current.id !== profile.id ||
                JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
              throw new Error("El perfil lingüístico cambió en otra instancia; vuelve a leerlo antes de actualizar.");
            }
          } else if (current) {
            throw new Error("El perfil lingüístico ya existe; vuelve a leerlo antes de actualizar.");
          }
          store.put(cloneLanguageProfile(profile));
        } catch (error) {
          failure = error;
          try { transaction.abort(); } catch { /* ya abortada */ }
        }
      };
      request.onerror = () => {
        failure = request.error ?? new Error("No se pudo verificar el perfil lingüístico actual.");
        try { transaction.abort(); } catch { /* ya abortada */ }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("No se pudo guardar el perfil lingüístico."));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Se canceló el guardado del perfil lingüístico."));
    });
  }

  async loadLanguageResourceRefs(
    projectId: string,
    profileId?: string
  ): Promise<readonly LanguageResourceRef[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        (profileId !== undefined && (typeof profileId !== "string" || !profileId.trim()))) {
      throw new Error("Identidad de proyecto o perfil inválida para recuperar recursos lingüísticos.");
    }
    if (profileId !== undefined) {
      const profiles = await this.loadLanguageProfiles(projectId);
      if (!profiles.some(profile => profile.id === profileId)) {
        throw new Error("El perfil lingüístico asociado no existe en el proyecto.");
      }
    }
    const db = await this.open();
    const transaction = db.transaction(LANGUAGE_RESOURCE_REFS, "readonly");
    const index = transaction.objectStore(LANGUAGE_RESOURCE_REFS).index(
      profileId === undefined ? "by-project" : "by-profile"
    );
    const request = index.getAll(
      profileId === undefined ? projectId : [projectId, profileId]
    );
    const resources = await readAfterTransaction(
      transaction, request, "No se pudieron recuperar las referencias de recursos lingüísticos."
    ) as LanguageResourceRef[];
    if (!Array.isArray(resources)) throw new Error("La colección de recursos lingüísticos es inválida.");
    const ids = new Set<string>();
    for (const resource of resources) {
      validateLanguageResourceRef(resource, projectId);
      if (ids.has(resource.id)) throw new Error("Hay IDs de recursos lingüísticos duplicados en el proyecto.");
      ids.add(resource.id);
      if (profileId !== undefined && resource.profileId !== profileId) {
        throw new Error("Una referencia recuperada pertenece a otro perfil lingüístico.");
      }
    }
    const profiles = await this.loadLanguageProfiles(projectId);
    const profileIds = new Set(profiles.map(profile => profile.id));
    for (const resource of resources) {
      if (resource.profileId !== undefined && !profileIds.has(resource.profileId)) {
        throw new Error("Una referencia de recurso apunta a un perfil lingüístico inexistente.");
      }
    }
    return resources.map(cloneLanguageResourceRef);
  }

  async saveLanguageResourceRef(
    resource: LanguageResourceRef,
    expectedCurrent?: LanguageResourceRef
  ): Promise<void> {
    validateLanguageResourceRef(resource);
    if (expectedCurrent) {
      validateLanguageResourceRef(expectedCurrent, resource.projectId);
      if (expectedCurrent.id !== resource.id) {
        throw new Error("Una actualización debe conservar el ID de la referencia de recurso.");
      }
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([LANGUAGE_PROFILES, LANGUAGE_RESOURCE_REFS], "readwrite");
      const profiles = transaction.objectStore(LANGUAGE_PROFILES);
      const resources = transaction.objectStore(LANGUAGE_RESOURCE_REFS);
      const currentRequest = resources.get([resource.projectId, resource.id]);
      const profileRequest = resource.profileId === undefined
        ? undefined
        : profiles.get([resource.projectId, resource.profileId]);
      let currentReady = false;
      let profileReady = profileRequest === undefined;
      let current: LanguageResourceRef | undefined;
      let profileExists = profileRequest === undefined;
      let failure: unknown;
      let finished = false;
      const abortWith = (error: unknown): void => {
        if (finished) return;
        finished = true;
        failure = error;
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      const commitIfReady = (): void => {
        if (finished || !currentReady || !profileReady) return;
        try {
          if (resource.profileId !== undefined && !profileExists) {
            throw new Error("El perfil lingüístico asociado no existe en el proyecto.");
          }
          if (expectedCurrent) {
            if (!current || current.projectId !== resource.projectId ||
                current.id !== resource.id ||
                JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
              throw new Error("La referencia de recurso cambió en otra instancia; vuelve a leerla antes de actualizar.");
            }
          } else if (current) {
            throw new Error("La referencia de recurso ya existe; vuelve a leerla antes de actualizar.");
          }
          resources.put(cloneLanguageResourceRef(resource));
        } catch (error) {
          abortWith(error);
        }
      };
      currentRequest.onsuccess = () => {
        current = currentRequest.result as LanguageResourceRef | undefined;
        currentReady = true;
        commitIfReady();
      };
      currentRequest.onerror = () => abortWith(
        currentRequest.error ?? new Error("No se pudo verificar la referencia de recurso actual.")
      );
      if (profileRequest) {
        profileRequest.onsuccess = () => {
          const profile = profileRequest.result as LanguageProfile | undefined;
          if (profile) {
            try {
              validateLanguageProfile(profile, resource.projectId);
              profileExists = profile.id === resource.profileId;
            } catch (error) {
              abortWith(error);
              return;
            }
          }
          profileReady = true;
          commitIfReady();
        };
        profileRequest.onerror = () => abortWith(
          profileRequest.error ?? new Error("No se pudo verificar el perfil asociado al recurso.")
        );
      }
      transaction.oncomplete = () => {
        if (!finished) {
          finished = true;
          resolve();
        }
      };
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("No se pudo guardar la referencia de recurso."));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Se canceló el guardado de la referencia de recurso."));
    });
  }

  async appendNarrativeReferenceRepairAudit(entry: NarrativeReferenceRepairAuditEntry): Promise<void> {
    if (!entry || typeof entry.projectId !== "string" || !entry.projectId.trim() ||
        typeof entry.operationId !== "string" || !entry.operationId.trim() ||
        entry.operation !== "narrative-reference-repair" ||
        !["relation", "event", "assertion", "idea"].includes(entry.recordType) ||
        !entry.recordId || !entry.referenceField || !entry.missingReferenceId ||
        !entry.replacementEntityId || !Number.isFinite(entry.appliedAt) || entry.appliedAt < 0 ||
        (entry.recordType === "relation" && entry.referenceField !== "fromEntityId" && entry.referenceField !== "toEntityId") ||
        (entry.recordType === "event" && entry.referenceField !== "participants") ||
        (entry.recordType === "assertion" && entry.referenceField !== "entityId") ||
        (entry.recordType === "idea" && entry.referenceField !== "relatedEntityIds") ||
        (entry.recordType === "relation" || entry.recordType === "assertion"
          ? entry.before !== entry.missingReferenceId || entry.after !== entry.replacementEntityId
          : !Array.isArray(entry.before) || !entry.before.includes(entry.missingReferenceId) ||
            !Array.isArray(entry.after) || !entry.after.includes(entry.replacementEntityId))) {
      throw new Error("Registro de auditoría de reparación narrativa inválido.");
    }
    const expectedOperationId = [
      "reference-repair", entry.projectId, entry.recordType, entry.recordId,
      entry.referenceField, entry.missingReferenceId, entry.replacementEntityId
    ].join("|");
    if (entry.operationId !== expectedOperationId) {
      throw new Error("El ID de operación de auditoría no coincide con sus referencias.");
    }
    const db = await this.open();
    const transaction = db.transaction(NARRATIVE_REFERENCE_REPAIR_AUDITS, "readwrite");
    const store = transaction.objectStore(NARRATIVE_REFERENCE_REPAIR_AUDITS);
    const request = store.get([entry.projectId, entry.operationId]);
    await new Promise<void>((resolve, reject) => {
      let failure: Error | undefined;
      request.onsuccess = () => {
        const current = request.result as NarrativeReferenceRepairAuditEntry | undefined;
        if (current) {
          const { appliedAt: _currentAt, ...currentOperation } = current;
          const { appliedAt: _entryAt, ...newOperation } = entry;
          if (JSON.stringify(currentOperation) !== JSON.stringify(newOperation)) {
            failure = new Error("El ID de operación de auditoría ya existe con contenido diferente.");
            transaction.abort();
          }
          return;
        }
        store.add(structuredClone(entry));
      };
      request.onerror = () => {
        failure = request.error ?? new Error("No se pudo consultar la auditoría de reparación.");
        transaction.abort();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("No se pudo guardar la auditoría."));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Se canceló el guardado de auditoría."));
    });
  }

  async saveNarrativeReferenceRepairPending(entry: NarrativeReferenceRepairPendingEntry): Promise<void> {
    if (!entry || typeof entry.projectId !== "string" || !entry.projectId.trim() ||
        typeof entry.operationId !== "string" || !entry.operationId.trim() ||
        typeof entry.issueCode !== "string" || !entry.issueCode ||
        !["relation", "event", "assertion", "idea"].includes(entry.recordType) ||
        !entry.recordId || !entry.referenceField || !entry.missingReferenceId ||
        !entry.replacementEntityId || !Number.isFinite(entry.appliedAt) || entry.appliedAt < 0 ||
        (entry.recordType === "relation" && entry.referenceField !== "fromEntityId" && entry.referenceField !== "toEntityId") ||
        (entry.recordType === "event" && entry.referenceField !== "participants") ||
        (entry.recordType === "assertion" && entry.referenceField !== "entityId") ||
        (entry.recordType === "idea" && entry.referenceField !== "relatedEntityIds")) {
      throw new Error("Intención pendiente de reparación narrativa inválida.");
    }
    const expectedId = ["reference-repair", entry.projectId, entry.recordType, entry.recordId,
      entry.referenceField, entry.missingReferenceId, entry.replacementEntityId].join("|");
    if (entry.operationId !== expectedId) throw new Error("El ID de la intención no coincide con la reparación.");
    const db = await this.open();
    const transaction = db.transaction(NARRATIVE_REFERENCE_REPAIR_PENDING, "readwrite");
    const objectStore = transaction.objectStore(NARRATIVE_REFERENCE_REPAIR_PENDING);
    const request = objectStore.get([entry.projectId, entry.operationId]);
    await new Promise<void>((resolve, reject) => {
      let failure: Error | undefined;
      request.onsuccess = () => {
        const current = request.result as NarrativeReferenceRepairPendingEntry | undefined;
        if (current) {
          const { appliedAt: _currentAt, ...currentOperation } = current;
          const { appliedAt: _entryAt, ...newOperation } = entry;
          if (JSON.stringify(currentOperation) !== JSON.stringify(newOperation)) {
            failure = new Error("La intención pendiente ya existe con contenido diferente.");
            transaction.abort();
          }
          return;
        }
        objectStore.add(structuredClone(entry));
      };
      request.onerror = () => {
        failure = request.error ?? new Error("No se pudo consultar la intención pendiente.");
        transaction.abort();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("No se pudo guardar la intención pendiente."));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Se canceló el guardado de la intención."));
    });
  }

  async loadNarrativeReferenceRepairPending(projectId: string): Promise<readonly NarrativeReferenceRepairPendingEntry[]> {
    if (typeof projectId !== "string" || !projectId.trim()) throw new Error("Proyecto inválido para consultar intenciones.");
    const db = await this.open();
    const transaction = db.transaction(NARRATIVE_REFERENCE_REPAIR_PENDING, "readonly");
    const request = transaction.objectStore(NARRATIVE_REFERENCE_REPAIR_PENDING).index("by-project").getAll(projectId);
    const records = await readAfterTransaction(
      transaction, request, "No se pudieron leer las intenciones pendientes."
    ) as NarrativeReferenceRepairPendingEntry[];
    return records.map(item => structuredClone(item));
  }

  async deleteNarrativeReferenceRepairPending(projectId: string, operationId: string): Promise<void> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof operationId !== "string" || !operationId.trim()) {
      throw new Error("Identidad inválida para cerrar una intención pendiente.");
    }
    const db = await this.open();
    const transaction = db.transaction(NARRATIVE_REFERENCE_REPAIR_PENDING, "readwrite");
    transaction.objectStore(NARRATIVE_REFERENCE_REPAIR_PENDING).delete([projectId, operationId]);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo cerrar la intención pendiente."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Se canceló el cierre de la intención."));
    });
  }

  async loadNarrativeReferenceRepairAudits(projectId: string): Promise<readonly NarrativeReferenceRepairAuditEntry[]> {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Identificador de proyecto inválido para consultar auditorías.");
    }
    const db = await this.open();
    const transaction = db.transaction(NARRATIVE_REFERENCE_REPAIR_AUDITS, "readonly");
    const request = transaction.objectStore(NARRATIVE_REFERENCE_REPAIR_AUDITS)
      .index("by-project").getAll(projectId);
    const records = await readAfterTransaction(
      transaction, request, "No se pudieron leer las auditorías de reparación narrativa."
    ) as NarrativeReferenceRepairAuditEntry[];
    if (!Array.isArray(records)) throw new Error("Las auditorías narrativas no son una colección.");
    return records.map(item => structuredClone(item));
  }
  async loadRecordLifecycles(projectId: string, recordId: string): Promise<readonly RecordLifecycle[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof recordId !== "string" || !recordId.trim()) {
      throw new Error("Identidad de proyecto o ficha inválida.");
    }
    return loadLifecycleHistory(
      await this.open(), RECORD_LIFECYCLES, PROJECT_RECORDS,
      projectId, recordId, "ficha", validateRecordLifecycle, cloneRecordLifecycle
    );
  }

  async appendRecordLifecycle(item: RecordLifecycle): Promise<void> {
    return appendLifecycleRecord(
      await this.open(), RECORD_LIFECYCLES, PROJECT_RECORDS,
      item, item.recordId, "ficha", validateRecordLifecycle
    );
  }

  async loadEventLifecycles(projectId: string, eventId: string): Promise<readonly EventLifecycle[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof eventId !== "string" || !eventId.trim()) {
      throw new Error("Identidad de proyecto o acontecimiento inválida.");
    }
    return loadLifecycleHistory(
      await this.open(),EVENT_LIFECYCLES,EVENTS,
      projectId,eventId,"acontecimiento",validateEventLifecycle,cloneEventLifecycle,
      EVENT_LIFECYCLE_SEQUENCE_RULES
    );
  }

  async loadProjectEventLifecycles(projectId: string): Promise<readonly EventLifecycle[]> {
    if(typeof projectId!=="string" || !projectId.trim()) {
      throw new Error("Identificador de proyecto inválido para consultar historiales de acontecimientos.");
    }
    const db=await this.open();
    const transaction=db.transaction(EVENT_LIFECYCLES,"readonly");
    const request=transaction.objectStore(EVENT_LIFECYCLES).index("by-project").getAll(projectId);
    const records=await readAfterTransaction(
      transaction,request,"No se pudieron leer los historiales de acontecimientos."
    ) as EventLifecycle[];
    if(!Array.isArray(records))throw new Error("Los historiales de acontecimientos no son una colección.");
    for(const item of records)validateEventLifecycle(item,projectId);
    return records.map(cloneEventLifecycle);
  }

  async saveEventAndAppendLifecycleIfUnchanged(
    event: NarrativeEvent,
    expectedCurrent: NarrativeEvent,
    lifecycle: EventLifecycle
  ): Promise<void> {
    return saveEventWithLifecycle(await this.open(),event,expectedCurrent,lifecycle);
  }

  async loadRelationLifecycles(projectId: string, relationId: string): Promise<readonly RelationLifecycle[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof relationId !== "string" || !relationId.trim()) {
      throw new Error("Identidad de proyecto o relación inválida.");
    }
    return loadLifecycleHistory(
      await this.open(), RELATION_LIFECYCLES, PROJECT_RELATIONS,
      projectId, relationId, "relación", validateRelationLifecycle, cloneRelationLifecycle
    );
  }

  async appendRelationLifecycle(item: RelationLifecycle): Promise<void> {
    return appendLifecycleRecord(
      await this.open(), RELATION_LIFECYCLES, PROJECT_RELATIONS,
      item, item.relationId, "relación", validateRelationLifecycle
    );
  }

  async loadProjectRelations(projectId: string): Promise<readonly ProjectRelation[]> {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Identificador de proyecto inválido para consultar relaciones.");
    }
    return loadSimpleProjectRecords(
      await this.open(), PROJECT_RELATIONS, projectId, "relaciones MLDB",
      validateProjectRelation, cloneProjectRelation
    );
  }

  async saveProjectRelation(
    relation: ProjectRelation,
    expectedCurrent?: ProjectRelation
  ): Promise<void> {
    validateProjectRelation(relation, relation.projectId);
    if (expectedCurrent) {
      validateProjectRelation(expectedCurrent, relation.projectId);
      if (relation.currentVersion !== expectedCurrent.currentVersion + 1) {
        throw new Error("La versión de la relación debe avanzar exactamente una unidad.");
      }
      if (relation.createdAt !== expectedCurrent.createdAt || relation.updatedAt < expectedCurrent.updatedAt) {
        throw new Error("Las fechas de relación no pueden retroceder ni cambiar su creación.");
      }
    } else if (relation.currentVersion !== 1) {
      throw new Error("Una relación nueva debe comenzar en versión 1.");
    }
    const parents: ProjectParentCheck[] = [];
    if (relation.sourceRecordId) parents.push({
      storeName: PROJECT_RECORDS, key: [relation.projectId, relation.sourceRecordId],
      label: "la ficha de origen de la relación",
      validate: value => validateProjectRecordContract(value as ProjectRecord, relation.projectId)
    });
    if (relation.targetRecordId) parents.push({
      storeName: PROJECT_RECORDS, key: [relation.projectId, relation.targetRecordId],
      label: "la ficha de destino de la relación",
      validate: value => validateProjectRecordContract(value as ProjectRecord, relation.projectId)
    });
    await saveProjectRecordWithParents(
      await this.open(), PROJECT_RELATIONS, relation, expectedCurrent, parents,
      "relación MLDB", validateProjectRelation, cloneProjectRelation
    );
  }

  async loadProjectEvidences(
    projectId: string,
    subjectKind?: EvidenceSubjectKind,
    subjectId?: string
  ): Promise<readonly ProjectEvidence[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        (subjectKind !== undefined && subjectKind !== "RECORD" && subjectKind !== "RELATION") ||
        (subjectId !== undefined && (typeof subjectId !== "string" || !subjectId.trim())) ||
        (subjectId !== undefined && subjectKind === undefined)) {
      throw new Error("Filtros de evidencia inválidos.");
    }
    const records = await loadSimpleProjectRecords(
      await this.open(), PROJECT_EVIDENCES, projectId, "evidencias",
      validateProjectEvidence, cloneProjectEvidence
    );
    return records.filter(item => {
      if (subjectKind === "RECORD") return subjectId === undefined || item.subjectRecordId === subjectId;
      if (subjectKind === "RELATION") return subjectId === undefined || item.subjectRelationId === subjectId;
      return true;
    });
  }

  async saveProjectEvidence(
    evidence: ProjectEvidence,
    expectedCurrent?: ProjectEvidence
  ): Promise<void> {
    validateProjectEvidence(evidence, evidence.projectId);
    const parents: ProjectParentCheck[] = [];
    if (evidence.subjectKind === "RECORD") {
      parents.push({
        storeName: PROJECT_RECORDS, key: [evidence.projectId, evidence.subjectRecordId!],
        label: "la ficha de la evidencia",
        validate: value => validateProjectRecordContract(value as ProjectRecord, evidence.projectId)
      });
    } else {
      parents.push({
        storeName: PROJECT_RELATIONS, key: [evidence.projectId, evidence.subjectRelationId!],
        label: "la relación de la evidencia",
        validate: value => validateProjectRelation(value as ProjectRelation, evidence.projectId)
      });
    }
    if (evidence.documentId) parents.push({
      storeName: DOCUMENTS, key: [evidence.projectId, evidence.documentId],
      label: "el documento de la evidencia"
    });
    if (evidence.fragmentId) parents.push({
      storeName: MANUSCRIPT_FRAGMENTS, key: [evidence.projectId, evidence.fragmentId],
      label: "el fragmento de la evidencia",
      validate: value => {
        const fragment = value as ManuscriptFragment;
        validateManuscriptFragment(fragment, evidence.projectId);
        if (fragment.documentId !== evidence.documentId) {
          throw new Error("El fragmento de evidencia pertenece a otro documento.");
        }
      }
    });
    await saveProjectRecordWithParents(
      await this.open(), PROJECT_EVIDENCES, evidence, expectedCurrent, parents,
      "evidencia", validateProjectEvidence, cloneProjectEvidence
    );
  }

  async loadTimelineOccurrences(
    projectId: string,
    eventRecordId?: string,
    trackId?: string
  ): Promise<readonly TimelineOccurrence[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        (eventRecordId !== undefined && (typeof eventRecordId !== "string" || !eventRecordId.trim())) ||
        (trackId !== undefined && (typeof trackId !== "string" || !trackId.trim()))) {
      throw new Error("Filtros de ocurrencia cronológica inválidos.");
    }
    const records = await loadSimpleProjectRecords(
      await this.open(), TIMELINE_OCCURRENCES, projectId, "ocurrencias cronológicas",
      validateTimelineOccurrence, cloneTimelineOccurrence
    );
    return records.filter(item =>
      (eventRecordId === undefined || item.eventRecordId === eventRecordId) &&
      (trackId === undefined || item.trackId === trackId)
    );
  }

  async saveTimelineOccurrence(
    occurrence: TimelineOccurrence,
    expectedCurrent?: TimelineOccurrence
  ): Promise<void> {
    validateTimelineOccurrence(occurrence, occurrence.projectId);
    const parents: ProjectParentCheck[] = [];
    if (occurrence.eventRecordId) parents.push({
      storeName: PROJECT_RECORDS, key: [occurrence.projectId, occurrence.eventRecordId],
      label: "la ficha de evento de la ocurrencia",
      validate: value => validateProjectRecordContract(value as ProjectRecord, occurrence.projectId)
    });
    if (occurrence.trackId) parents.push({
      storeName: TIMELINE_TRACKS, key: [occurrence.projectId, occurrence.trackId],
      label: "la pista de la ocurrencia",
      validate: value => validateTimelineTrack(value as TimelineTrack, occurrence.projectId)
    });
    await saveProjectRecordWithParents(
      await this.open(), TIMELINE_OCCURRENCES, occurrence, expectedCurrent, parents,
      "ocurrencia cronológica", validateTimelineOccurrence, cloneTimelineOccurrence
    );
  }

  async loadProjectRecords(projectId: string): Promise<readonly ProjectRecord[]> {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Identificador de proyecto inválido para consultar fichas.");
    }
    return loadSimpleProjectRecords(
      await this.open(), PROJECT_RECORDS, projectId, "fichas MLDB",
      validateProjectRecord, cloneProjectRecord
    );
  }

  async saveProjectRecord(record: ProjectRecord, expectedCurrent?: ProjectRecord): Promise<void> {
    validateProjectRecordContract(record, record.projectId);
    if (expectedCurrent) {
      validateProjectRecordContract(expectedCurrent, record.projectId);
      if (record.currentVersion !== expectedCurrent.currentVersion + 1) {
        throw new Error("La versión de la ficha debe avanzar exactamente una unidad.");
      }
      if (record.createdAt !== expectedCurrent.createdAt || record.updatedAt < expectedCurrent.updatedAt) {
        throw new Error("Las fechas de la ficha no pueden retroceder ni cambiar su creación.");
      }
    } else if (record.currentVersion !== 1) {
      throw new Error("Una ficha nueva debe comenzar en versión 1.");
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([PROJECT_RECORDS, RECORD_NAMES], "readwrite");
      const records = transaction.objectStore(PROJECT_RECORDS);
      const names = transaction.objectStore(RECORD_NAMES);
      const currentRequest = records.get([record.projectId, record.id]);
      const namesRequest = names.index("by-record").getAll([record.projectId, record.id]);
      let current: ProjectRecord | undefined;
      let recordReady = false;
      let namesReady = false;
      let existingNames: RecordName[] = [];
      let failure: Error | undefined;
      let finished = false;
      const abortWith = (error: unknown): void => {
        if (finished) return;
        failure = error instanceof Error ? error : new Error("No se pudo guardar la ficha.");
        finished = true;
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      const commitIfReady = (): void => {
        if (finished || !recordReady || !namesReady) return;
        try {
          if (expectedCurrent) {
            if (!current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
              throw new Error("La ficha cambió en otra instancia; vuelve a leerla antes de actualizar.");
            }
          } else if (current) {
            throw new Error("La ficha ya existe; vuelve a leerla antes de actualizar.");
          }
          for (const name of existingNames) {
            validateRecordName(name, record.projectId);
          }
          const existingPrimary = existingNames.find(name => name.isPrimary);
          if (record.primaryName === null) {
            if (existingPrimary) {
              names.put(cloneRecordName({ ...existingPrimary, isPrimary: false }));
            }
          } else if (!existingPrimary || existingPrimary.name !== record.primaryName) {
            if (existingPrimary) {
              names.put(cloneRecordName({ ...existingPrimary, isPrimary: false }));
            }
            const matchingName = existingNames.find(name => name.name === record.primaryName);
            if (matchingName) {
              names.put(cloneRecordName({
                ...matchingName, isPrimary: true
              }));
            } else {
              const newName: RecordName = {
                projectId: record.projectId,
                id: `primary:${checksumArchivedIdeaIds([record.projectId, record.id, record.primaryName])}`,
                recordId: record.id,
                name: record.primaryName,
                nameKind: "primary",
                isPrimary: true,
                provenanceKind: record.provenanceKind
              };
              validateRecordName(newName, record.projectId);
              names.add(cloneRecordName(newName));
            }
          }
          records.put(cloneProjectRecord(record));
        } catch (error) { abortWith(error); }
      };
      currentRequest.onsuccess = () => {
        current = currentRequest.result as ProjectRecord | undefined;
        try {
          if (current) validateProjectRecordContract(current, record.projectId);
          recordReady = true;
          commitIfReady();
        } catch (error) { abortWith(error); }
      };
      namesRequest.onsuccess = () => {
        try {
          existingNames = namesRequest.result as RecordName[];
          if (!Array.isArray(existingNames)) throw new Error("Los nombres vinculados a la ficha no forman una colección.");
          for (const name of existingNames) validateRecordName(name, record.projectId);
          namesReady = true;
          commitIfReady();
        } catch (error) { abortWith(error); }
      };
      currentRequest.onerror = () => abortWith(
        currentRequest.error ?? new Error("No se pudo leer la ficha actual.")
      );
      namesRequest.onerror = () => abortWith(
        namesRequest.error ?? new Error("No se pudieron leer los nombres asociados a la ficha.")
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        failure ?? transaction.error ?? new Error("No se pudo guardar la ficha.")
      );
      transaction.onabort = () => reject(
        failure ?? transaction.error ?? new Error("Se canceló el guardado de la ficha.")
      );
    });
  }

  async loadRecordNames(projectId: string, recordId?: string): Promise<readonly RecordName[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        (recordId !== undefined && (typeof recordId !== "string" || !recordId.trim()))) {
      throw new Error("Identidad de proyecto o ficha inválida para consultar nombres.");
    }
    const allNames = await loadSimpleProjectRecords(
      await this.open(), RECORD_NAMES, projectId, "nombres de fichas",
      validateRecordName, cloneRecordName
    );
    const records = await this.loadProjectRecords(projectId);
    const parentById = new Map(records.map(record => [record.id, record]));
    const result = allNames.filter(item => recordId === undefined || item.recordId === recordId);
    const ids = new Set<string>();
    const primaryByRecord = new Set<string>();
    for (const item of result) {
      if (ids.has(item.id)) throw new Error("Hay IDs duplicados de nombres de fichas.");
      ids.add(item.id);
      const parent = parentById.get(item.recordId);
      if (!parent) throw new Error("Un nombre persistido referencia una ficha inexistente.");
      if (item.isPrimary) {
        if (primaryByRecord.has(item.recordId)) {
          throw new Error("Una ficha no puede tener más de un nombre alternativo principal.");
        }
        if (parent.primaryName !== item.name) {
          throw new Error("El nombre marcado como principal no coincide con primaryName de la ficha.");
        }
        primaryByRecord.add(item.recordId);
      }
    }
    return result.map(cloneRecordName);
  }

  async saveRecordName(name: RecordName, expectedCurrent?: RecordName): Promise<void> {
    validateRecordName(name, name.projectId);
    if (expectedCurrent) {
      validateRecordName(expectedCurrent, name.projectId);
      if (expectedCurrent.id !== name.id || expectedCurrent.recordId !== name.recordId) {
        throw new Error("La actualización del nombre debe conservar su ficha e ID.");
      }
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([RECORD_NAMES, PROJECT_RECORDS], "readwrite");
      const names = transaction.objectStore(RECORD_NAMES);
      const records = transaction.objectStore(PROJECT_RECORDS);
      const recordRequest = records.get([name.projectId, name.recordId]);
      const currentRequest = names.get([name.projectId, name.id]);
      const namesRequest = names.index("by-record").getAll([name.projectId, name.recordId]);
      let parentReady = false;
      let currentReady = false;
      let namesReady = false;
      let parent: ProjectRecord | undefined;
      let current: RecordName | undefined;
      let existing: RecordName[] = [];
      let failure: Error | undefined;
      let finished = false;
      const abortWith = (error: unknown): void => {
        if (finished) return;
        failure = error instanceof Error ? error : new Error("No se pudo guardar el nombre de ficha.");
        finished = true;
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      const commitIfReady = (): void => {
        if (finished || !parentReady || !currentReady || !namesReady) return;
        try {
          if (!parent) throw new Error("No existe la ficha a la que pertenece el nombre.");
          if (name.isPrimary && parent.primaryName !== name.name) {
            throw new Error("El nombre principal debe coincidir con primaryName de la ficha.");
          }
          if (expectedCurrent) {
            if (!current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
              throw new Error("El nombre cambió en otra instancia; vuelve a leer antes de actualizar.");
            }
          } else if (current) {
            throw new Error("El nombre ya existe; vuelve a leer antes de actualizar.");
          }
          if (name.isPrimary && existing.some(item => item.id !== name.id && item.isPrimary)) {
            throw new Error("La ficha ya tiene otro nombre marcado como principal.");
          }
          names.put(cloneRecordName(name));
        } catch (error) { abortWith(error); }
      };
      recordRequest.onsuccess = () => {
        parent = recordRequest.result as ProjectRecord | undefined;
        try {
          if (parent) validateProjectRecordContract(parent, name.projectId);
          parentReady = true;
          commitIfReady();
        } catch (error) { abortWith(error); }
      };
      currentRequest.onsuccess = () => {
        current = currentRequest.result as RecordName | undefined;
        try {
          if (current) validateRecordName(current, name.projectId);
          currentReady = true;
          commitIfReady();
        } catch (error) { abortWith(error); }
      };
      namesRequest.onsuccess = () => {
        try {
          existing = namesRequest.result as RecordName[];
          if (!Array.isArray(existing)) throw new Error("Los nombres existentes no forman una colección.");
          for (const item of existing) validateRecordName(item, name.projectId);
          namesReady = true;
          commitIfReady();
        } catch (error) { abortWith(error); }
      };
      recordRequest.onerror = () => abortWith(recordRequest.error ?? new Error("No se pudo leer la ficha padre."));
      currentRequest.onerror = () => abortWith(currentRequest.error ?? new Error("No se pudo leer el nombre actual."));
      namesRequest.onerror = () => abortWith(namesRequest.error ?? new Error("No se pudieron leer los nombres de la ficha."));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("No se pudo guardar el nombre de ficha."));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Se canceló el guardado del nombre de ficha."));
    });
  }

  async loadManuscriptFragments(
    projectId: string,
    documentId?: string
  ): Promise<readonly ManuscriptFragment[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        (documentId !== undefined && (typeof documentId !== "string" || !documentId.trim()))) {
      throw new Error("Identidad de proyecto o documento inválida para leer fragmentos.");
    }
    const fragments = await loadSimpleProjectRecords(
      await this.open(), MANUSCRIPT_FRAGMENTS, projectId, "fragmentos",
      validateManuscriptFragment, cloneManuscriptFragment
    );
    const all = new Map(fragments.map(fragment => [fragment.id, fragment]));
    for (const fragment of fragments) {
      if (fragment.parentFragmentId) {
        const parent = all.get(fragment.parentFragmentId);
        if (!parent) throw new Error("Un fragmento persistido referencia un padre inexistente.");
        if ((parent.documentId ?? null) !== (fragment.documentId ?? null)) {
          throw new Error("Un fragmento y su padre deben pertenecer al mismo documento.");
        }
      }
      if (fragment.documentId) {
        const parentDocument = await this.loadDocument(projectId, fragment.documentId);
        if (!parentDocument) throw new Error("Un fragmento persistido referencia un documento inexistente.");
      }
    }
    return fragments.filter(fragment => documentId === undefined || fragment.documentId === documentId);
  }

  async saveManuscriptFragment(
    fragment: ManuscriptFragment,
    expectedCurrent?: ManuscriptFragment
  ): Promise<void> {
    validateManuscriptFragment(fragment, fragment.projectId);
    const parents: ProjectParentCheck[] = [];
    if (fragment.documentId) {
      parents.push({
        storeName: DOCUMENTS, key: [fragment.projectId, fragment.documentId],
        label: "el documento del fragmento"
      });
    }
    if (fragment.parentFragmentId) {
      parents.push({
        storeName: MANUSCRIPT_FRAGMENTS, key: [fragment.projectId, fragment.parentFragmentId],
        label: "el fragmento padre",
        validate: value => {
          const parent = value as ManuscriptFragment;
          validateManuscriptFragment(parent, fragment.projectId);
          if ((parent.documentId ?? null) !== (fragment.documentId ?? null)) {
            throw new Error("El fragmento padre pertenece a otro documento.");
          }
        }
      });
    }
    await saveProjectRecordWithParents(
      await this.open(), MANUSCRIPT_FRAGMENTS, fragment, expectedCurrent, parents,
      "fragmento de manuscrito", validateManuscriptFragment, cloneManuscriptFragment
    );
  }

  async loadRecordAttributes(projectId: string, recordId: string): Promise<readonly RecordAttribute[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof recordId !== "string" || !recordId.trim()) {
      throw new Error("Identidad de proyecto o ficha inválida para leer atributos.");
    }
    const records = await loadSimpleProjectRecords(
      await this.open(), RECORD_ATTRIBUTES, projectId, "atributos de ficha",
      validateRecordAttribute, cloneRecordAttribute
    );
    return records.filter(item => item.recordId === recordId);
  }

  async saveRecordAttribute(
    attribute: RecordAttribute,
    expectedCurrent?: RecordAttribute
  ): Promise<void> {
    validateRecordAttribute(attribute, attribute.projectId);
    await saveProjectRecordWithParents(
      await this.open(), RECORD_ATTRIBUTES, attribute, expectedCurrent,
      [{
        storeName: PROJECT_RECORDS, key: [attribute.projectId, attribute.recordId],
        label: "la ficha del atributo",
        validate: value => validateProjectRecord(value as ProjectRecord, attribute.projectId)
      }],
      "atributo de ficha", validateRecordAttribute, cloneRecordAttribute
    );
  }

  async loadRelationAttributes(projectId: string, relationId: string): Promise<readonly RelationAttribute[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof relationId !== "string" || !relationId.trim()) {
      throw new Error("Identidad de proyecto o relación inválida para leer atributos.");
    }
    const records = await loadSimpleProjectRecords(
      await this.open(), RELATION_ATTRIBUTES, projectId, "atributos de relación",
      validateRelationAttribute, cloneRelationAttribute
    );
    return records.filter(item => item.relationId === relationId);
  }

  async saveRelationAttribute(
    attribute: RelationAttribute,
    expectedCurrent?: RelationAttribute
  ): Promise<void> {
    validateRelationAttribute(attribute, attribute.projectId);
    await saveProjectRecordWithParents(
      await this.open(), RELATION_ATTRIBUTES, attribute, expectedCurrent,
      [{
        storeName: PROJECT_RELATIONS, key: [attribute.projectId, attribute.relationId],
        label: "la relación del atributo",
        validate: value => validateProjectRelation(value as ProjectRelation, attribute.projectId)
      }],
      "atributo de relación", validateRelationAttribute, cloneRelationAttribute
    );
  }

  async loadActiveSuggestions(
    projectId: string,
    documentId?: string,
    status?: ActiveSuggestion["status"]
  ): Promise<readonly ActiveSuggestion[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        (documentId !== undefined && (typeof documentId !== "string" || !documentId.trim()))) {
      throw new Error("Identidad de proyecto o documento inválida para consultar sugerencias.");
    }
    const suggestions = await loadSimpleProjectRecords(
      await this.open(), ACTIVE_SUGGESTIONS, projectId, "sugerencias activas",
      validateActiveSuggestion, cloneActiveSuggestion
    );
    return suggestions.filter(item =>
      (documentId === undefined || item.documentId === documentId) &&
      (status === undefined || item.status === status)
    );
  }

  async saveActiveSuggestion(
    suggestion: ActiveSuggestion,
    expectedCurrent?: ActiveSuggestion
  ): Promise<void> {
    validateActiveSuggestion(suggestion, suggestion.projectId);
    const parents: ProjectParentCheck[] = [];
    if (suggestion.documentId) {
      parents.push({
        storeName: DOCUMENTS, key: [suggestion.projectId, suggestion.documentId],
        label: "el documento de la sugerencia"
      });
    }
    if (suggestion.fragmentId) {
      parents.push({
        storeName: MANUSCRIPT_FRAGMENTS, key: [suggestion.projectId, suggestion.fragmentId],
        label: "el fragmento de la sugerencia",
        validate: value => {
          const fragment = value as ManuscriptFragment;
          validateManuscriptFragment(fragment, suggestion.projectId);
          if (fragment.documentId !== suggestion.documentId) {
            throw new Error("El fragmento de la sugerencia pertenece a otro documento.");
          }
        }
      });
    }
    await saveProjectRecordWithParents(
      await this.open(), ACTIVE_SUGGESTIONS, suggestion, expectedCurrent, parents,
      "sugerencia activa", validateActiveSuggestion, cloneActiveSuggestion
    );
  }

  async loadImportAuthorizations(writerId: string): Promise<readonly ImportAuthorization[]> {
    if (typeof writerId !== "string" || !writerId.trim() || writerId.length > 256) {
      throw new Error("Identificador de escritor inválido para consultar autorizaciones.");
    }
    const transaction = (await this.open()).transaction(IMPORT_AUTHORIZATIONS, "readonly");
    const request = transaction.objectStore(IMPORT_AUTHORIZATIONS).index("by-writer").getAll(writerId);
    const records = await readAfterTransaction(
      transaction, request, "No se pudieron leer las autorizaciones de importación."
    ) as ImportAuthorization[];
    if (!Array.isArray(records)) throw new Error("La colección de autorizaciones es inválida.");
    const ids = new Set<string>();
    for (const item of records) {
      validateImportAuthorization(item, writerId);
      const key = JSON.stringify([item.sourceProjectId, item.targetProjectId, item.authorizationId]);
      if (ids.has(key)) throw new Error("Hay autorizaciones de importación duplicadas.");
      ids.add(key);
    }
    return records.map(cloneImportAuthorization);
  }

  async appendImportAuthorization(authorization: ImportAuthorization): Promise<void> {
    validateImportAuthorization(authorization, authorization.writerId);
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(IMPORT_AUTHORIZATIONS, "readwrite");
      const store = transaction.objectStore(IMPORT_AUTHORIZATIONS);
      const request = store.add(cloneImportAuthorization(authorization));
      let failure: unknown;
      request.onerror = () => {
        failure = request.error ?? new Error("No se pudo registrar la autorización de importación.");
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("No se pudo registrar la autorización de importación."));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Se canceló el registro de autorización."));
    });
  }

  async loadSchemaMigrations(): Promise<readonly SchemaMigration[]> {
    const transaction = (await this.open()).transaction(SCHEMA_MIGRATIONS, "readonly");
    const request = transaction.objectStore(SCHEMA_MIGRATIONS).getAll();
    const records = await readAfterTransaction(
      transaction, request, "No se pudo leer el historial de migraciones."
    ) as SchemaMigration[];
    if (!Array.isArray(records)) throw new Error("El historial de migraciones no es una colección.");
    const ids = new Set<string>();
    for (const item of records) {
      validateSchemaMigration(item);
      if (ids.has(item.migrationId)) throw new Error("Hay IDs duplicados en el historial de migraciones.");
      ids.add(item.migrationId);
    }
    return records.sort((first, second) =>
      Number(first.toVersion) - Number(second.toVersion) ||
      first.migrationId.localeCompare(second.migrationId)
    ).map(cloneSchemaMigration);
  }

  async loadStyleProfiles(projectId: string): Promise<readonly StyleProfile[]> {
    if (typeof projectId !== "string" || !projectId.trim()) throw new Error("Identificador de proyecto inválido.");
    return loadSimpleProjectRecords(
      await this.open(), STYLE_PROFILES, projectId, "perfiles de estilo",
      validateStyleProfile, cloneStyleProfile
    );
  }

  async saveStyleProfile(
    profile: StyleProfile,
    expectedCurrent?: StyleProfile
  ): Promise<void> {
    await saveSimpleProjectRecord(
      await this.open(), STYLE_PROFILES, profile, expectedCurrent,
      "perfil de estilo", validateStyleProfile, cloneStyleProfile
    );
  }

  async loadTimelineTracks(projectId: string): Promise<readonly TimelineTrack[]> {
    if (typeof projectId !== "string" || !projectId.trim()) throw new Error("Identificador de proyecto inválido.");
    return loadSimpleProjectRecords(
      await this.open(), TIMELINE_TRACKS, projectId, "pistas cronológicas",
      validateTimelineTrack, cloneTimelineTrack
    );
  }

  async saveTimelineTrack(
    track: TimelineTrack,
    expectedCurrent?: TimelineTrack
  ): Promise<void> {
    await saveSimpleProjectRecord(
      await this.open(), TIMELINE_TRACKS, track, expectedCurrent,
      "pista cronológica", validateTimelineTrack, cloneTimelineTrack
    );
  }

  async saveDictionary(
    dictionary: ProjectDictionary,
    expectedCurrent?: ProjectDictionary
  ): Promise<void> {
    validateProjectDictionary(dictionary, "diccionario");
    if (expectedCurrent !== undefined) {
      validateProjectDictionary(expectedCurrent, "diccionario anterior");
      if (expectedCurrent.projectId !== dictionary.projectId ||
          expectedCurrent.id !== dictionary.id) {
        throw new Error("La actualización de diccionario cambió su identidad.");
      }
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(DICTIONARIES, "readwrite");
      const objectStore = transaction.objectStore(DICTIONARIES);
      let validationError: Error | undefined;
      const request = objectStore.get([dictionary.projectId, dictionary.id]);
      const abortWith = (error: unknown): void => {
        validationError = error instanceof Error ? error : new Error("Actualización de diccionario inválida.");
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      request.onsuccess = () => {
        try {
          const current = request.result as ProjectDictionary | undefined;
          if (current !== undefined) validateProjectDictionary(current, "diccionario persistido");
          if (expectedCurrent === undefined) {
            if (current !== undefined) {
              throw new Error("El diccionario ya existe; vuelve a leerlo antes de actualizarlo.");
            }
            objectStore.add(dictionary);
          } else {
            if (!current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
              throw new Error("El diccionario cambió en otra instancia; actualiza la vista antes de editarlo.");
            }
            objectStore.put(dictionary);
          }
        } catch (error) {
          abortWith(error);
        }
      };
      request.onerror = () => abortWith(request.error ?? new Error("No se pudo leer el diccionario actual."));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar el diccionario."));
      transaction.onabort = () => reject(
        validationError ?? transaction.error ?? new Error("Se canceló el guardado del diccionario.")
      );
    });
  }

  async loadDictionaries(projectId: string): Promise<readonly ProjectDictionary[]> {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Identificador de proyecto inválido para leer diccionarios.");
    }
    const db = await this.open();
    const transaction = db.transaction(DICTIONARIES, "readonly");
    const request = transaction.objectStore(DICTIONARIES).index("by-project").getAll(projectId);
    const records = await readAfterTransaction(
      transaction, request, "No se pudieron leer los diccionarios del proyecto."
    ) as ProjectDictionary[];
    if (!Array.isArray(records)) {
      throw new Error("Los diccionarios persistidos no forman una colección válida.");
    }
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const dictionary of records) {
      validateProjectDictionary(dictionary, "diccionario persistido");
      if (dictionary.projectId !== projectId || ids.has(dictionary.id)) {
        throw new Error("Violación de aislamiento: diccionarios ajenos o IDs duplicados.");
      }
      const nameKey = JSON.stringify([dictionary.languageIdentifier, dictionary.normalizedName]);
      if (names.has(nameKey)) {
        throw new Error("Integridad de diccionarios: nombre duplicado para el mismo idioma.");
      }
      ids.add(dictionary.id);
      names.add(nameKey);
    }
    return records;
  }

  /** Persiste una entrada solo si su diccionario y todas sus fichas relacionadas existen en el libro. */
  async saveDictionaryEntry(
    entry: DictionaryEntry,
    expectedCurrent?: DictionaryEntry,
    suppliedLinks?: readonly DictionaryEntryEntityLink[]
  ): Promise<void> {
    validateDictionaryEntry(entry, "entrada de diccionario");
    if (expectedCurrent !== undefined) {
      validateDictionaryEntry(expectedCurrent, "entrada anterior");
      if (expectedCurrent.projectId !== entry.projectId || expectedCurrent.id !== entry.id) {
        throw new Error("La actualización de entrada cambió su identidad.");
      }
    }
    const linksToSave = suppliedLinks ?? entry.relatedEntityIds.map(recordId => ({
      projectId: entry.projectId,
      entryId: entry.id,
      recordId,
      linkKind: "RELATED",
      provenanceKind: entry.provenanceKind,
      createdAt: entry.createdAt
    }));
    const linkIds = new Set<string>();
    for (const link of linksToSave) {
      validateDictionaryEntryEntityLink(link, entry.projectId, entry.id);
      if (linkIds.has(link.recordId)) throw new Error("La entrada contiene metadatos duplicados para una ficha.");
      linkIds.add(link.recordId);
    }
    if (linkIds.size !== entry.relatedEntityIds.length ||
        entry.relatedEntityIds.some(id => !linkIds.has(id))) {
      throw new Error("Cada ficha relacionada debe tener exactamente un registro de metadatos.");
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        [DICTIONARIES, DICTIONARY_ENTRIES, DICTIONARY_ENTRY_ENTITIES, ENTITIES], "readwrite"
      );
      const dictionaries = transaction.objectStore(DICTIONARIES);
      const entries = transaction.objectStore(DICTIONARY_ENTRIES);
      const links = transaction.objectStore(DICTIONARY_ENTRY_ENTITIES);
      const entities = transaction.objectStore(ENTITIES);
      let dictionaryChecked = false;
      let entryChecked = false;
      let linksChecked = false;
      let currentLinks: DictionaryEntryEntityLink[] = [];
      let pendingEntities = entry.relatedEntityIds.length;
      let finished = false;
      let validationError: Error | undefined;
      let currentEntry: DictionaryEntry | undefined;

      const abortWith = (error: unknown): void => {
        if (finished) return;
        finished = true;
        validationError = error instanceof Error ? error : new Error("Entrada de diccionario inválida.");
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      const commitIfReady = (): void => {
        if (finished || !dictionaryChecked || !entryChecked || !linksChecked || pendingEntities !== 0) return;
        try {
          if (expectedCurrent === undefined) {
            if (currentEntry !== undefined) {
              throw new Error("La entrada ya existe; vuelve a leerla antes de actualizarla.");
            }
            entries.add(entry);
          } else {
            if (!currentEntry || JSON.stringify(currentEntry) !== JSON.stringify(expectedCurrent)) {
              throw new Error("La entrada cambió en otra instancia; actualiza la vista antes de editarla.");
            }
            if (currentEntry.dictionaryId !== entry.dictionaryId) {
              throw new Error("Una entrada no puede trasladarse de diccionario mediante una actualización ordinaria.");
            }
            entries.put(entry);
          }
          for (const oldLink of currentLinks) {
            links.delete([oldLink.projectId, oldLink.entryId, oldLink.recordId]);
          }
          for (const link of linksToSave) links.put(structuredClone(link));
        } catch (error) {
          abortWith(error);
        }
      };

      const dictionaryRequest = dictionaries.get([entry.projectId, entry.dictionaryId]);
      dictionaryRequest.onsuccess = () => {
        const dictionary = dictionaryRequest.result as ProjectDictionary | undefined;
        try {
          if (!dictionary || dictionary.projectId !== entry.projectId ||
              dictionary.id !== entry.dictionaryId) {
            throw new Error("No se puede guardar la entrada: el diccionario no existe en el proyecto activo.");
          }
          validateProjectDictionary(dictionary, "diccionario relacionado");
          dictionaryChecked = true;
          commitIfReady();
        } catch (error) {
          abortWith(error);
        }
      };
      dictionaryRequest.onerror = () => abortWith(
        dictionaryRequest.error ?? new Error("No se pudo verificar el diccionario de la entrada.")
      );

      const entryRequest = entries.get([entry.projectId, entry.id]);
      entryRequest.onsuccess = () => {
        try {
          currentEntry = entryRequest.result as DictionaryEntry | undefined;
          if (currentEntry) {
            validateDictionaryEntry(currentEntry, "entrada persistida");
            if (currentEntry.projectId !== entry.projectId) {
              throw new Error("La entrada persistida pertenece a otro proyecto.");
            }
          }
          entryChecked = true;
          commitIfReady();
        } catch (error) {
          abortWith(error);
        }
      };
      entryRequest.onerror = () => abortWith(
        entryRequest.error ?? new Error("No se pudo comprobar la entrada anterior.")
      );

      const existingLinksRequest = links.index("by-entry").getAll([entry.projectId, entry.id]);
      existingLinksRequest.onsuccess = () => {
        try {
          currentLinks = existingLinksRequest.result as DictionaryEntryEntityLink[];
          if (!Array.isArray(currentLinks)) throw new Error("Los vínculos anteriores no forman una colección.");
          for (const link of currentLinks) validateDictionaryEntryEntityLink(link, entry.projectId, entry.id);
          linksChecked = true;
          commitIfReady();
        } catch (error) { abortWith(error); }
      };
      existingLinksRequest.onerror = () => abortWith(
        existingLinksRequest.error ?? new Error("No se pudieron leer los vínculos anteriores.")
      );

      for (const entityId of entry.relatedEntityIds) {
        const entityRequest = entities.get([entry.projectId, entityId]);
        entityRequest.onsuccess = () => {
          if (finished) return;
          try {
            const entity = entityRequest.result as NarrativeEntity | undefined;
            if (!entity || entity.projectId !== entry.projectId || entity.id !== entityId) {
              throw new Error("La entrada referencia una ficha que no existe en el mismo proyecto.");
            }
            validateNarrativeEntityRecord(entity, "entidad relacionada con diccionario");
            pendingEntities--;
            commitIfReady();
          } catch (error) {
            abortWith(error);
          }
        };
        entityRequest.onerror = () => abortWith(
          entityRequest.error ?? new Error("No se pudo verificar una ficha relacionada.")
        );
      }
      commitIfReady();

      transaction.oncomplete = () => {
        if (!finished) {
          finished = true;
          resolve();
        }
      };
      transaction.onerror = () => reject(
        validationError ?? transaction.error ?? new Error("No se pudo guardar la entrada de diccionario.")
      );
      transaction.onabort = () => reject(
        validationError ?? transaction.error ?? new Error("Se canceló el guardado de la entrada.")
      );
    });
  }

  async loadDictionaryEntryEntityLinks(
    projectId: string,
    entryId: string
  ): Promise<readonly DictionaryEntryEntityLink[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof entryId !== "string" || !entryId.trim()) {
      throw new Error("Identidad de proyecto o entrada inválida para consultar vínculos.");
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [DICTIONARIES, DICTIONARY_ENTRIES, DICTIONARY_ENTRY_ENTITIES, ENTITIES],
        "readonly"
      );
      const links = transaction.objectStore(DICTIONARY_ENTRY_ENTITIES);
      const entries = transaction.objectStore(DICTIONARY_ENTRIES);
      const dictionaryStore = transaction.objectStore(DICTIONARIES);
      const entryRequest = entries.get([projectId, entryId]);
      const linksRequest = links.index("by-entry").getAll([projectId, entryId]);
      let entry: DictionaryEntry | undefined;
      let records: DictionaryEntryEntityLink[] = [];
      let entryReady = false;
      let linksReady = false;
      let pendingEntities = 0;
      let failure: Error | undefined;
      let finished = false;
      const abortWith = (error: unknown): void => {
        if (finished) return;
        failure = error instanceof Error ? error : new Error("No se pudieron leer los vínculos de diccionario.");
        finished = true;
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      const finishIfReady = (): void => {
        if (finished || !entryReady || !linksReady || pendingEntities !== 0) return;
        try {
          if (!entry) throw new Error("La entrada solicitada no existe en el proyecto activo.");
          const dictionaryRequest = dictionaryStore.get([projectId, entry.dictionaryId]);
          dictionaryRequest.onsuccess = () => {
            try {
              const dictionary = dictionaryRequest.result as ProjectDictionary | undefined;
              if (!dictionary || dictionary.projectId !== projectId || dictionary.id !== entry!.dictionaryId) {
                throw new Error("El diccionario de los vínculos no existe en el proyecto activo.");
              }
              validateProjectDictionary(dictionary, "diccionario de vínculos");
            } catch (error) { abortWith(error); }
          };
          dictionaryRequest.onerror = () => abortWith(
            dictionaryRequest.error ?? new Error("No se pudo verificar el diccionario de los vínculos.")
          );
        } catch (error) {
          abortWith(error);
        }
      };
      entryRequest.onsuccess = () => {
        try {
          entry = entryRequest.result as DictionaryEntry | undefined;
          if (entry) validateDictionaryEntry(entry, "entrada de vínculos");
          entryReady = true;
          finishIfReady();
        } catch (error) { abortWith(error); }
      };
      entryRequest.onerror = () => abortWith(
        entryRequest.error ?? new Error("No se pudo leer la entrada de los vínculos.")
      );
      linksRequest.onsuccess = () => {
        try {
          records = linksRequest.result as DictionaryEntryEntityLink[];
          if (!Array.isArray(records)) throw new Error("Los vínculos de diccionario no forman una colección.");
          const ids = new Set<string>();
          for (const link of records) {
            validateDictionaryEntryEntityLink(link, projectId, entryId);
            if (ids.has(link.recordId)) throw new Error("Hay fichas repetidas en los vínculos de diccionario.");
            ids.add(link.recordId);
            const request = transaction.objectStore(ENTITIES).get([projectId, link.recordId]);
            pendingEntities++;
            request.onsuccess = () => {
              try {
                const entity = request.result as NarrativeEntity | undefined;
                if (!entity || entity.projectId !== projectId || entity.id !== link.recordId) {
                  throw new Error("Un vínculo de diccionario apunta a una ficha inexistente o ajena.");
                }
                validateNarrativeEntityRecord(entity, "ficha vinculada a entrada de diccionario");
                pendingEntities--;
                finishIfReady();
              } catch (error) { abortWith(error); }
            };
            request.onerror = () => abortWith(
              request.error ?? new Error("No se pudo verificar una ficha vinculada a diccionario.")
            );
          }
          linksReady = true;
          finishIfReady();
        } catch (error) { abortWith(error); }
      };
      linksRequest.onerror = () => abortWith(
        linksRequest.error ?? new Error("No se pudieron leer los vínculos de diccionario.")
      );
      transaction.oncomplete = () => {
        if (failure) reject(failure);
        else if (!entryReady || !linksReady || pendingEntities !== 0) {
          reject(new Error("La validación de vínculos de diccionario quedó incompleta."));
        } else {
          const legacyIds = new Set(entry?.relatedEntityIds ?? []);
          for (const link of records) legacyIds.delete(link.recordId);
          if (legacyIds.size > 0) {
            reject(new Error("Hay vínculos heredados sin metadatos; la migración de diccionarios quedó incompleta."));
          } else {
            resolve(records.map(link => structuredClone(link)));
          }
        }
      };
      transaction.onerror = () => reject(
        failure ?? transaction.error ?? new Error("No se pudieron leer los vínculos de diccionario.")
      );
      transaction.onabort = () => reject(
        failure ?? transaction.error ?? new Error("Se canceló la lectura de vínculos de diccionario.")
      );
    });
  }

  async setDictionaryEntryEntityLink(
    entry: DictionaryEntry,
    expectedCurrent: DictionaryEntry,
    link: DictionaryEntryEntityLink,
    linked: boolean
  ): Promise<void> {
    validateDictionaryEntry(entry, "entrada actualizada");
    validateDictionaryEntry(expectedCurrent, "entrada anterior");
    validateDictionaryEntryEntityLink(link, entry.projectId, entry.id);
    if (entry.projectId !== expectedCurrent.projectId || entry.id !== expectedCurrent.id ||
        entry.dictionaryId !== expectedCurrent.dictionaryId ||
        typeof linked !== "boolean" ||
        (linked && !entry.relatedEntityIds.includes(link.recordId)) ||
        (!linked && entry.relatedEntityIds.includes(link.recordId))) {
      throw new Error("La actualización del vínculo y la entrada no coincide.");
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        [DICTIONARIES, DICTIONARY_ENTRIES, DICTIONARY_ENTRY_ENTITIES, ENTITIES],
        "readwrite"
      );
      const dictionaries = transaction.objectStore(DICTIONARIES);
      const entries = transaction.objectStore(DICTIONARY_ENTRIES);
      const links = transaction.objectStore(DICTIONARY_ENTRY_ENTITIES);
      const dictionaryRequest = dictionaries.get([entry.projectId, entry.dictionaryId]);
      const entryRequest = entries.get([entry.projectId, entry.id]);
      const entityRequest = linked
        ? transaction.objectStore(ENTITIES).get([entry.projectId, link.recordId])
        : undefined;
      let dictionaryReady = false;
      let entryReady = false;
      let entityReady = !linked;
      let failure: Error | undefined;
      let finished = false;
      const abortWith = (error: unknown): void => {
        if (finished) return;
        failure = error instanceof Error ? error : new Error("No se pudo actualizar el vínculo de diccionario.");
        finished = true;
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      const commitIfReady = (): void => {
        if (finished || !dictionaryReady || !entryReady || !entityReady) return;
        try {
          const dictionary = dictionaryRequest.result as ProjectDictionary | undefined;
          if (!dictionary || dictionary.projectId !== entry.projectId ||
              dictionary.id !== entry.dictionaryId) {
            throw new Error("El diccionario del vínculo no existe en el proyecto activo.");
          }
          validateProjectDictionary(dictionary, "diccionario del vínculo");
          const current = entryRequest.result as DictionaryEntry | undefined;
          if (!current || JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
            throw new Error("La entrada cambió en otra instancia; vuelve a leerla antes de modificar sus vínculos.");
          }
          if (linked) {
            const entity = entityRequest?.result as NarrativeEntity | undefined;
            if (!entity || entity.projectId !== entry.projectId || entity.id !== link.recordId) {
              throw new Error("No existe la ficha relacionada en el mismo proyecto.");
            }
            validateNarrativeEntityRecord(entity, "ficha relacionada con diccionario");
            links.put(structuredClone(link));
          } else {
            links.delete([link.projectId, link.entryId, link.recordId]);
          }
          entries.put(structuredClone(entry));
        } catch (error) { abortWith(error); }
      };
      dictionaryRequest.onsuccess = () => { dictionaryReady = true; commitIfReady(); };
      dictionaryRequest.onerror = () => abortWith(
        dictionaryRequest.error ?? new Error("No se pudo verificar el diccionario del vínculo.")
      );
      entryRequest.onsuccess = () => { entryReady = true; commitIfReady(); };
      entryRequest.onerror = () => abortWith(
        entryRequest.error ?? new Error("No se pudo verificar la entrada del vínculo.")
      );
      if (entityRequest) {
        entityRequest.onsuccess = () => { entityReady = true; commitIfReady(); };
        entityRequest.onerror = () => abortWith(
          entityRequest.error ?? new Error("No se pudo verificar la ficha del vínculo.")
        );
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        failure ?? transaction.error ?? new Error("No se pudo actualizar el vínculo de diccionario.")
      );
      transaction.onabort = () => reject(
        failure ?? transaction.error ?? new Error("Se canceló la actualización del vínculo de diccionario.")
      );
    });
  }

  async loadDictionaryEntries(
    projectId: string,
    dictionaryId: string
  ): Promise<readonly DictionaryEntry[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof dictionaryId !== "string" || !dictionaryId.trim()) {
      throw new Error("Identidad de proyecto o diccionario inválida.");
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [DICTIONARIES, DICTIONARY_ENTRIES, ENTITIES], "readonly"
      );
      const dictionaryRequest = transaction.objectStore(DICTIONARIES).get([projectId, dictionaryId]);
      const entriesRequest = transaction.objectStore(DICTIONARY_ENTRIES)
        .index("by-dictionary").getAll([projectId, dictionaryId]);
      const entities = transaction.objectStore(ENTITIES);
      let dictionaryReady = false;
      let entriesReady = false;
      let pendingEntities = 0;
      let result: DictionaryEntry[] = [];
      let validationError: Error | undefined;
      const checkedEntities = new Set<string>();
      const abortWith = (error: unknown): void => {
        validationError = error instanceof Error ? error : new Error("No se pudieron validar entradas de diccionario.");
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      const validateWhenReady = (): void => {
        if (!dictionaryReady || !entriesReady || validationError) return;
        try {
          const dictionary = dictionaryRequest.result as ProjectDictionary | undefined;
          if (!dictionary || dictionary.projectId !== projectId || dictionary.id !== dictionaryId) {
            throw new Error("El diccionario solicitado no existe en el proyecto activo.");
          }
          validateProjectDictionary(dictionary, "diccionario consultado");
          const records = entriesRequest.result as DictionaryEntry[];
          if (!Array.isArray(records)) throw new Error("La colección de entradas persistidas es inválida.");
          const ids = new Set<string>();
          const normalizedForms = new Set<string>();
          result = records;
          for (const entry of records) {
            validateDictionaryEntry(entry, "entrada persistida");
            if (entry.projectId !== projectId || entry.dictionaryId !== dictionaryId ||
                ids.has(entry.id) || normalizedForms.has(entry.normalizedForm)) {
              throw new Error("Violación de aislamiento o duplicidad en entradas de diccionario.");
            }
            ids.add(entry.id);
            normalizedForms.add(entry.normalizedForm);
            for (const id of entry.relatedEntityIds) {
              if (checkedEntities.has(id)) continue;
              checkedEntities.add(id);
              pendingEntities++;
              const request = entities.get([projectId, id]);
              request.onsuccess = () => {
                try {
                  const entity = request.result as NarrativeEntity | undefined;
                  if (!entity || entity.projectId !== projectId || entity.id !== id) {
                    throw new Error("Una entrada contiene un vínculo a una ficha inexistente o ajena.");
                  }
                  validateNarrativeEntityRecord(entity, "entidad relacionada con diccionario");
                  pendingEntities--;
                } catch (error) {
                  abortWith(error);
                }
              };
              request.onerror = () => abortWith(
                request.error ?? new Error("No se pudo validar una ficha relacionada con diccionario.")
              );
            }
          }
        } catch (error) {
          abortWith(error);
        }
      };
      dictionaryRequest.onsuccess = () => {
        dictionaryReady = true;
        validateWhenReady();
      };
      entriesRequest.onsuccess = () => {
        entriesReady = true;
        validateWhenReady();
      };
      dictionaryRequest.onerror = () => abortWith(
        dictionaryRequest.error ?? new Error("No se pudo leer el diccionario.")
      );
      entriesRequest.onerror = () => abortWith(
        entriesRequest.error ?? new Error("No se pudieron leer las entradas del diccionario.")
      );
      transaction.oncomplete = () => {
        if (validationError) reject(validationError);
        else if (pendingEntities !== 0) reject(new Error("La validación de fichas relacionadas quedó incompleta."));
        else resolve(result);
      };
      transaction.onerror = () => reject(
        validationError ?? transaction.error ?? new Error("No se pudieron leer las entradas del diccionario.")
      );
      transaction.onabort = () => reject(
        validationError ?? transaction.error ?? new Error("Se canceló la lectura del diccionario.")
      );
    });
  }

  /**
   * Transfiere las ideas pendientes del libro a la biblioteca del escritor.
   * La escritura en biblioteca y eliminación del registro del proyecto
   * comparten una transacción: nunca queda una transferencia a medias.
   */
  async archiveUnincorporatedIdeas(
    projectId: string,
    writerId: string,
    sourceProjectName: string,
    archivedAt: number,
    syncOperation?: SyncOperationDraft,
    expectedIdeaIds?: readonly string[]
  ): Promise<readonly PersonalIdeaLibraryEntry[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof writerId !== "string" || !writerId.trim() || writerId.length > 256 ||
        typeof sourceProjectName !== "string" || !sourceProjectName.trim() ||
        !Number.isFinite(archivedAt) || archivedAt < 0 ||
        (expectedIdeaIds !== undefined &&
          (!Array.isArray(expectedIdeaIds) || expectedIdeaIds.length > 100_000 ||
           expectedIdeaIds.some(id => typeof id !== "string" || !id.trim() || id.length > 512) ||
           new Set(expectedIdeaIds).size !== expectedIdeaIds.length))) {
      throw new Error("Datos de archivo de ideas inválidos.");
    }
    const syncDraft = syncOperation === undefined
      ? undefined : normalizeSyncOperationDraft(syncOperation);
    if (syncDraft && syncDraft.projectId !== projectId) {
      throw new Error("El proyecto del archivo de ideas y de la operación de sincronización no coincide.");
    }
    const expectedIds = expectedIdeaIds === undefined
      ? undefined : [...expectedIdeaIds].sort();
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const stores = syncDraft
        ? [IDEAS, PERSONAL_IDEAS, ENTITIES, FINALIZATION_RECEIPTS, SYNC_OUTBOX, SYNC_DEVICE_SEQUENCES]
        : [IDEAS, PERSONAL_IDEAS, ENTITIES, FINALIZATION_RECEIPTS];
      const transaction = db.transaction(stores, "readwrite");
      const ideas = transaction.objectStore(IDEAS);
      const personal = transaction.objectStore(PERSONAL_IDEAS);
      const entities = transaction.objectStore(ENTITIES);
      const receipts = transaction.objectStore(FINALIZATION_RECEIPTS);
      // La lectura del recibo se encola antes de las ideas: ambas lecturas
      // pertenecen a la misma transacción y no existe una ventana de carrera.
      // Los navegadores siempre exponen get/add en un object store real.
      // La comprobación también permite que adaptadores IndexedDB mínimos de
      // compatibilidad sigan probando la ruta antigua sin simular el almacén.
      const supportsReceipts = typeof receipts.get === "function" &&
        typeof receipts.add === "function";
      const receiptRequest = supportsReceipts
        ? receipts.get([writerId, projectId, FINALIZATION_RECEIPT_ID])
        : undefined;
      let receiptRead = !supportsReceipts;
      let existingReceipt: StoredProjectFinalizationReceipt | undefined;
      if (receiptRequest) {
        receiptRequest.onsuccess = () => {
          existingReceipt = receiptRequest.result as StoredProjectFinalizationReceipt | undefined;
          receiptRead = true;
        };
        receiptRequest.onerror = () => abortWith(
          receiptRequest.error ?? new Error("No se pudo recuperar el recibo de finalización.")
        );
      }
      const request = ideas.index("by-project").getAll(projectId);
      const archived: PersonalIdeaLibraryEntry[] = [];
      let didChange = false;
      let finished = false;
      const abortWith = (error: unknown): void => {
        if (finished) return;
        finished = true;
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
        reject(error);
      };
      const commitEntries = (
        pending: readonly { readonly idea: NarrativeIdea; readonly context: PersonalIdeaLibraryContext }[]
      ): void => {
        if (finished) return;
        try {
          const archivedIdeaIds = pending.map(item => item.idea.id).sort();
          if (expectedIds !== undefined &&
              JSON.stringify(archivedIdeaIds) !== JSON.stringify(expectedIds)) {
            throw new Error("El conjunto de ideas del libro no coincide con la operación de archivo recibida.");
          }
          if (syncDraft) {
            const payload = JSON.stringify({
              writerId, sourceProjectName, archivedAt,
              archivedIdeaIds,
              archiveChecksum: checksumArchivedIdeaIds(archivedIdeaIds)
            });
            queueSyncOperationInTransaction(
              transaction, { ...syncDraft, payload }, abortWith
            );
          }
          for (const item of pending) {
            const archivedIdea: NarrativeIdea = { ...item.idea, sourceProjectName };
            validateNarrativeIdeaRecord(archivedIdea, "idea archivada");
            const entry: PersonalIdeaLibraryEntry = {
              writerId,
              sourceProjectId: projectId,
              sourceProjectName,
              category: sourceProjectName,
              idea: archivedIdea,
              context: item.context,
              archivedAt
            };
            personal.add(entry);
            ideas.delete([projectId, entry.idea.id]);
            archived.push(entry);
            didChange = true;
          }
          const archivedIdeaIds = pending.map(item => item.idea.id).sort();
          if (supportsReceipts) receipts.add({
            writerId,
            sourceProjectId: projectId,
            receiptId: FINALIZATION_RECEIPT_ID,
            sourceProjectName,
            finalizedAt: archivedAt,
            archivedIdeaIds,
            archiveChecksum: checksumArchivedIdeaIds(archivedIdeaIds)
          } satisfies StoredProjectFinalizationReceipt);
        } catch (error) {
          abortWith(error);
        }
      };
      request.onsuccess = () => {
        try {
          if (!receiptRead) {
            throw new Error("No se pudo establecer una lectura transaccional del recibo de finalización.");
          }
          const projectIdeas = request.result as NarrativeIdea[];
          if (!Array.isArray(projectIdeas)) throw new Error("La colección de ideas del proyecto es inválida.");

          if (existingReceipt) {
            validateFinalizationReceipt(existingReceipt, writerId, projectId);
            if (expectedIds !== undefined &&
                JSON.stringify([...existingReceipt.archivedIdeaIds].sort()) !== JSON.stringify(expectedIds)) {
              throw new Error("El recibo de finalización no coincide con los IDs archivados de la operación recibida.");
            }
            if (projectIdeas.some(idea => idea?.status === "IDEA")) {
              throw new Error(
                "El libro ya tiene un recibo de finalización; las ideas nuevas requieren una reapertura explícita antes de archivarse."
              );
            }
            const libraryRequest = personal.index("by-writer-source").getAll([writerId, projectId]);
            libraryRequest.onsuccess = () => {
              if (finished) return;
              try {
                const entries = libraryRequest.result as PersonalIdeaLibraryEntry[];
                if (!Array.isArray(entries)) {
                  throw new Error("La biblioteca personal del libro no devolvió una colección válida.");
                }
                const byIdeaId = new Map<string, PersonalIdeaLibraryEntry>();
                for (const entry of entries) {
                  if (!entry || entry.writerId !== writerId ||
                      entry.sourceProjectId !== projectId ||
                      entry.sourceProjectName !== sourceProjectName ||
                      entry.category !== sourceProjectName ||
                      !entry.idea || entry.idea.projectId !== projectId ||
                      entry.idea.sourceProjectName !== sourceProjectName ||
                      entry.idea.status !== "IDEA" ||
                      !Number.isFinite(entry.archivedAt) || entry.archivedAt < 0) {
                    throw new Error("La biblioteca personal contiene una entrada ajena o malformada.");
                  }
                  validateNarrativeIdeaRecord(entry.idea, "idea archivada");
                  if (entry.context) {
                    validatePersonalIdeaLibraryContext(
                      entry.context, projectId, sourceProjectName, "contexto archivado"
                    );
                  }
                  if (byIdeaId.has(entry.idea.id)) {
                    throw new Error("La biblioteca personal contiene IDs de idea duplicados para el mismo libro.");
                  }
                  byIdeaId.set(entry.idea.id, entry);
                }
                const selected = existingReceipt!.archivedIdeaIds.map(id => {
                  const entry = byIdeaId.get(id);
                  if (!entry) {
                    throw new Error("El recibo de finalización referencia una idea que no existe en la biblioteca.");
                  }
                  if (!entry.context || entry.context.version !== 1) {
                    throw new Error("La idea archivada no conserva el contexto requerido por el recibo.");
                  }
                  return entry;
                });
                const selectedIds = selected.map(entry => entry.idea.id).sort();
                if (checksumArchivedIdeaIds(selectedIds) !== existingReceipt!.archiveChecksum) {
                  throw new Error("El checksum del recibo no coincide con las ideas archivadas recuperadas.");
                }
                archived.push(...selected);
              } catch (error) {
                abortWith(error);
              }
            };
            libraryRequest.onerror = () => abortWith(
              libraryRequest.error ?? new Error("No se pudieron recuperar las ideas del recibo de finalización.")
            );
            return;
          }

          const projectIdeaIds = new Set<string>();
          const ideasById = new Map<string, NarrativeIdea>();
          for (const idea of projectIdeas) {
            if (!idea || typeof idea.id !== "string" || !idea.id.trim()) {
              throw new Error("Integridad de ideas inconsistente: se encontró una identidad inválida.");
            }
            if (projectIdeaIds.has(idea.id)) {
              throw new Error("Integridad de ideas inconsistente: se encontraron identificadores duplicados.");
            }
            if (idea.projectId !== projectId) {
              throw new Error("Aislamiento de ideas inconsistente: se rechazó un registro de otro proyecto.");
            }
            validateNarrativeIdeaRecord(idea, "idea narrativa");
            projectIdeaIds.add(idea.id);
            ideasById.set(idea.id, idea);
          }

          // Antes de archivar, valida el grafo completo. Las ideas que
          // permanecen en el libro no pueden depender de ideas trasladadas.
          const ideasToArchive = new Set(projectIdeas
            .filter(idea => idea.status === "IDEA")
            .map(idea => idea.id));
          if (expectedIds !== undefined &&
              JSON.stringify([...ideasToArchive].sort()) !== JSON.stringify(expectedIds)) {
            throw new Error("El conjunto de ideas del libro cambió desde la operación de archivo recibida.");
          }
          for (const idea of projectIdeas) {
            for (const relatedId of idea.relatedIdeaIds ?? []) {
              if (!projectIdeaIds.has(relatedId)) {
                throw new Error("No se pueden archivar ideas: existe una referencia a otra idea inexistente.");
              }
            }
            if (idea.status !== "IDEA" &&
                (idea.relatedIdeaIds ?? []).some(id => ideasToArchive.has(id))) {
              throw new Error("No se pueden archivar ideas: una idea que permanecerá en el libro depende de una idea que se trasladaría a la biblioteca personal.");
            }
          }

          const pending: { idea: NarrativeIdea; contextIdeaIds: Set<string>; entityIds: Set<string> }[] = [];
          const allEntityIds = new Set<string>();
          for (const idea of projectIdeas) {
            if (idea.status !== "IDEA") continue;
            const contextIdeaIds = new Set<string>();
            const visited = new Set<string>([idea.id]);
            const queue = [...(idea.relatedIdeaIds ?? [])];
            // Un índice evita desplazar los elementos pendientes en cada iteración.
            let queueIndex = 0;
            while (queueIndex < queue.length) {
              const relatedId = queue[queueIndex++]!;
              if (visited.has(relatedId)) continue;
              visited.add(relatedId);
              if (ideasToArchive.has(relatedId)) continue;
              const relatedIdea = ideasById.get(relatedId);
              if (!relatedIdea) {
                throw new Error("No se pueden archivar ideas: existe una referencia a otra idea inexistente.");
              }
              contextIdeaIds.add(relatedId);
              queue.push(...(relatedIdea.relatedIdeaIds ?? []));
            }
            const entityIds = new Set<string>(idea.relatedEntityIds ?? []);
            for (const relatedId of contextIdeaIds) {
              for (const entityId of ideasById.get(relatedId)?.relatedEntityIds ?? []) entityIds.add(entityId);
            }
            for (const entityId of entityIds) allEntityIds.add(entityId);
            pending.push({ idea, contextIdeaIds, entityIds });
          }

          const contextIdeasFor = (ids: ReadonlySet<string>): NarrativeIdea[] =>
            [...ids]
              .map(id => {
                const candidate = ideasById.get(id);
                if (!candidate) {
                  throw new Error("No se pueden archivar ideas: falta una idea del contexto validado.");
                }
                return candidate;
              })
              .sort((first, second) => first.id.localeCompare(second.id))
              .map(candidate => ({ ...candidate, sourceProjectName }));

          const loadedEntities = new Map<string, NarrativeEntity>();
          const entityIds = [...allEntityIds].sort();
          if (entityIds.length === 0) {
            commitEntries(pending.map(item => ({
              idea: item.idea,
              context: {
                version: 1 as const,
                relatedIdeas: contextIdeasFor(item.contextIdeaIds),
                relatedEntities: []
              }
            })));
            return;
          }

          let remaining = entityIds.length;
          const pendingEntries = (): { idea: NarrativeIdea; context: PersonalIdeaLibraryContext }[] => {
            // La transferencia puede dividir un grafo entre varias entradas:
            // valida la identidad de todas las fichas antes de crear cualquiera.
            validateNarrativeEntityIdentityHistory([...loadedEntities.values()]);
            return pending.map(item => {
              const relatedEntities = [...item.entityIds].sort().map(id => loadedEntities.get(id)!);
              return {
                idea: item.idea,
                context: {
                  version: 1 as const,
                  relatedIdeas: contextIdeasFor(item.contextIdeaIds),
                  relatedEntities
                }
              };
            });
          };
          for (const id of entityIds) {
            const entityRequest = entities.get([projectId, id]);
            entityRequest.onsuccess = () => {
              if (finished) return;
              try {
                const entity = entityRequest.result as NarrativeEntity | undefined;
                if (!entity || entity.projectId !== projectId || entity.id !== id) {
                  throw new Error("No se pueden archivar ideas: una ficha relacionada no existe en el proyecto de origen.");
                }
                validateNarrativeEntityRecord(entity, "entidad contextual");
                loadedEntities.set(id, entity);
                remaining--;
                if (remaining === 0) commitEntries(pendingEntries());
              } catch (error) {
                abortWith(error);
              }
            };
            entityRequest.onerror = () => abortWith(
              entityRequest.error ?? new Error("No se pudo recuperar el contexto de las fichas relacionadas.")
            );
          }
        } catch (error) {
          abortWith(error);
        }
      };
      request.onerror = () => abortWith(
        request.error ?? new Error("No se pudieron recuperar las ideas del proyecto.")
      );
      transaction.oncomplete = () => {
        if (!finished) {
          finished = true;
          if (didChange) this.publishNarrativeChange(projectId);
          resolve(archived);
        }
      };
      transaction.onerror = () => {
        if (!finished) reject(transaction.error ?? new Error("No se pudieron archivar las ideas."));
      };
      transaction.onabort = () => {
        if (!finished) reject(transaction.error ?? new Error("Se canceló el archivo de ideas."));
      };
    });
  }

  async loadProjectFinalizationReceipt(
    writerId: string,
    projectId: string
  ): Promise<StoredProjectFinalizationReceipt | undefined> {
    if (typeof writerId !== "string" || !writerId.trim() || writerId.length > 256 ||
        typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Identidad de escritor o proyecto inválida para consultar la finalización.");
    }
    const db = await this.open();
    const transaction = db.transaction(FINALIZATION_RECEIPTS, "readonly");
    const request = transaction.objectStore(FINALIZATION_RECEIPTS).get([
      writerId, projectId, FINALIZATION_RECEIPT_ID
    ]);
    const receipt = await readAfterTransaction(
      transaction, request, "No se pudo leer el recibo de finalización."
    ) as StoredProjectFinalizationReceipt | undefined;
    if (receipt) validateFinalizationReceipt(receipt, writerId, projectId);
    return receipt;
  }

  async loadPersonalIdeas(writerId: string): Promise<readonly PersonalIdeaLibraryEntry[]> {
    if (typeof writerId !== "string" || !writerId.trim() || writerId.length > 256) {
      throw new Error("Identificador de escritor inválido.");
    }
    const db = await this.open();
    const transaction = db.transaction(PERSONAL_IDEAS, "readonly");
    const request = transaction.objectStore(PERSONAL_IDEAS).index("by-writer").getAll(writerId);
    const entries = await readAfterTransaction(
      transaction, request, "No se pudo leer la biblioteca personal de ideas."
    ) as PersonalIdeaLibraryEntry[];
    if (!Array.isArray(entries)) {
      throw new Error("Biblioteca personal inconsistente: la colección recuperada no es una lista.");
    }
    const identities = new Set<string>();
    const archivedIdeaKeys = new Set(entries.map(entry =>
      entry && typeof entry.sourceProjectId === "string" && entry.idea &&
      typeof entry.idea.id === "string"
        ? JSON.stringify([entry.sourceProjectId, entry.idea.id])
        : ""
    ).filter(Boolean));
    for (const entry of entries) {
      if (!entry || entry.writerId !== writerId ||
          typeof entry.sourceProjectId !== "string" || !entry.sourceProjectId.trim() ||
          typeof entry.sourceProjectName !== "string" || !entry.sourceProjectName.trim() ||
          entry.category !== entry.sourceProjectName ||
          !entry.idea || entry.idea.projectId !== entry.sourceProjectId ||
          entry.idea.sourceProjectName !== entry.sourceProjectName ||
          !Number.isFinite(entry.archivedAt) || entry.archivedAt < 0) {
        throw new Error("Biblioteca personal inconsistente: se rechazó un registro ajeno o malformado.");
      }
      try {
        validateNarrativeIdeaRecord(entry.idea, "idea archivada");
        if (entry.idea.status !== "IDEA") {
          throw new Error("La idea archivada ya no conserva el estado IDEA.");
        }
        if (entry.context !== undefined) {
          validatePersonalIdeaLibraryContext(entry.context, entry.sourceProjectId, entry.sourceProjectName, "contexto archivado");
          const contextIdeaIds = new Set(entry.context.relatedIdeas.map(idea => idea.id));
          const contextEntityIds = new Set(entry.context.relatedEntities.map(entity => entity.id));
          if ([...contextIdeaIds].some(id =>
            archivedIdeaKeys.has(JSON.stringify([entry.sourceProjectId, id]))
          )) {
            throw new Error("La biblioteca duplica una idea archivada dentro de su contexto.");
          }
          for (const related of [entry.idea, ...entry.context.relatedIdeas]) {
            if ((related.relatedEntityIds ?? []).some(id => !contextEntityIds.has(id))) {
              throw new Error("Biblioteca personal inconsistente: falta una ficha relacionada.");
            }
            if ((related.relatedIdeaIds ?? []).some(id =>
              !contextIdeaIds.has(id) &&
              !archivedIdeaKeys.has(JSON.stringify([entry.sourceProjectId, id]))
            )) {
              throw new Error("Biblioteca personal inconsistente: falta una idea relacionada.");
            }
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "validación desconocida";
        throw new Error(
          "Biblioteca personal inconsistente: la idea o su contexto están malformados o incompletos. " + detail
        );
      }
      const identity = JSON.stringify([entry.sourceProjectId, entry.idea.id]);
      if (identities.has(identity)) {
        throw new Error("Biblioteca personal inconsistente: hay ideas archivadas duplicadas para el mismo libro.");
      }
      identities.add(identity);
    }
    return entries;
  }

  async loadNarrativeDocumentProjectionManifest(
    projectId: string, documentId: string
  ): Promise<NarrativeDocumentProjectionManifest | undefined> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof documentId !== "string" || !documentId.trim()) {
      throw new Error("Identidad documental inválida para leer el manifiesto narrativo.");
    }
    const db = await this.open();
    const transaction = db.transaction(NARRATIVE_PROJECTION_MANIFESTS, "readonly");
    const request = transaction.objectStore(NARRATIVE_PROJECTION_MANIFESTS).get([projectId, documentId]);
    const result = await readAfterTransaction(
      transaction, request, "No se pudo leer el manifiesto de proyección narrativa."
    ) as NarrativeDocumentProjectionManifest | undefined;
    if (result) validateNarrativeDocumentProjectionManifest(result, projectId, documentId);
    return result;
  }

  async loadNarrativeDocumentProjectionManifests(
    projectId: string
  ): Promise<readonly NarrativeDocumentProjectionManifest[]> {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Identificador de proyecto inválido para enumerar manifiestos narrativos.");
    }
    const db = await this.open();
    const transaction = db.transaction(NARRATIVE_PROJECTION_MANIFESTS, "readonly");
    const request = transaction.objectStore(NARRATIVE_PROJECTION_MANIFESTS).index("by-project").getAll(projectId);
    const records = await readAfterTransaction(
      transaction, request, "No se pudieron enumerar los manifiestos de proyección narrativa."
    ) as NarrativeDocumentProjectionManifest[];
    if (!Array.isArray(records)) throw new Error("La colección de manifiestos narrativos es inválida.");
    const seen = new Set<string>();
    for (const record of records) {
      validateNarrativeDocumentProjectionManifest(record, projectId, record.documentId);
      if (seen.has(record.documentId)) throw new Error("Hay manifiestos documentales duplicados en el proyecto.");
      seen.add(record.documentId);
    }
    return records;
  }

  async saveNarrativeDocumentProjectionManifestIfUnchanged(
    manifest: NarrativeDocumentProjectionManifest,
    expectedGeneration?: number
  ): Promise<void> {
    validateNarrativeDocumentProjectionManifest(manifest, manifest.projectId, manifest.documentId);
    if (expectedGeneration !== undefined &&
        (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)) {
      throw new Error("Generación esperada del manifiesto inválida.");
    }
    if (manifest.generation !== (expectedGeneration ?? 0) + 1) {
      throw new Error("La generación del manifiesto debe avanzar exactamente una unidad (conflicto CAS).");
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(NARRATIVE_PROJECTION_MANIFESTS, "readwrite");
      const objectStore = transaction.objectStore(NARRATIVE_PROJECTION_MANIFESTS);
      const request = objectStore.get([manifest.projectId, manifest.documentId]);
      request.onsuccess = () => {
        const current = request.result as NarrativeDocumentProjectionManifest | undefined;
        const actualGeneration = current?.generation;
        if (actualGeneration !== expectedGeneration) {
          transaction.abort();
          return;
        }
        objectStore.put({ ...manifest,
          entityIds: [...manifest.entityIds], relationIds: [...manifest.relationIds],
          eventIds: [...manifest.eventIds], ideaIds: [...manifest.ideaIds],
          assertionIds: [...manifest.assertionIds]
        });
      };
      request.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error("Conflicto CAS o aborto al guardar manifiesto narrativo."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Error al guardar manifiesto narrativo."));
    });
    this.publishNarrativeChange(manifest.projectId);
  }

  async saveAssertion(assertion: NarrativeAssertion): Promise<void> {
    validateNarrativeAssertionRecord(assertion, "afirmación narrativa");
    const db = await this.open();
    await saveNarrativeRecordWithEntityReferences(
      db, ASSERTIONS, assertion, [assertion.entityId],
      "No se pudo guardar la afirmación narrativa."
    );
    this.publishNarrativeChange(assertion.projectId);
  }

  async saveAssertionIfUnchanged(
    assertion: NarrativeAssertion,
    expectedCurrent?: NarrativeAssertion,
    syncOperation?: SyncOperationDraft
  ): Promise<void> {
    validateNarrativeAssertionRecord(assertion, "afirmación narrativa");
    if (expectedCurrent !== undefined) validateNarrativeAssertionRecord(expectedCurrent, "afirmación anterior");
    const db = await this.open();
    await saveNarrativeRecordWithEntityReferences(
      db, ASSERTIONS, assertion, [assertion.entityId],
      "No se pudo guardar la afirmación narrativa.", expectedCurrent, true, syncOperation
    );
    this.publishNarrativeChange(assertion.projectId);
  }

  async loadAssertions(projectId: string): Promise<readonly NarrativeAssertion[]> {
    if (typeof projectId !== "string" || !projectId.trim()) throw new Error("Identificador de proyecto inválido.");
    const db = await this.open();
    const transaction = db.transaction(ASSERTIONS, "readonly");
    const request = transaction.objectStore(ASSERTIONS).index("by-project").getAll(projectId);
    const records = await readAfterTransaction(transaction, request, "No se pudieron leer las afirmaciones narrativas.") as NarrativeAssertion[];
    validateProjectRecords(records, projectId, "afirmación narrativa");
    for (const assertion of records) {
      validateNarrativeAssertionRecord(assertion, "afirmación narrativa");
    }
    return records;
  }

  async saveEvent(event: NarrativeEvent): Promise<void> {
    validateNarrativeEventRecord(event, "acontecimiento");
    const db = await this.open();
    await saveNarrativeEventWithReferences(db, event);
    this.publishNarrativeChange(event.projectId);
  }

  async saveEventIfUnchanged(
    event: NarrativeEvent,
    expectedCurrent?: NarrativeEvent,
    syncOperation?: SyncOperationDraft
  ): Promise<void> {
    validateNarrativeEventRecord(event, "acontecimiento");
    if (expectedCurrent !== undefined) validateNarrativeEventRecord(expectedCurrent, "acontecimiento anterior");
    const db = await this.open();
    await saveNarrativeEventWithReferences(db, event, expectedCurrent, true, syncOperation);
    this.publishNarrativeChange(event.projectId);
  }

  async loadEvents(projectId: string): Promise<readonly NarrativeEvent[]> {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Identificador de proyecto inválido.");
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([EVENTS, TIMELINE_TRACKS], "readonly");
      const eventsRequest = transaction.objectStore(EVENTS).index("by-project").getAll(projectId);
      const tracksRequest = transaction.objectStore(TIMELINE_TRACKS).index("by-project").getAll(projectId);
      let events: NarrativeEvent[] | undefined;
      let tracks: TimelineTrack[] | undefined;
      let failure: Error | undefined;
      const abortWith = (error: unknown): void => {
        failure = error instanceof Error ? error : new Error("No se pudieron validar los acontecimientos.");
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      eventsRequest.onsuccess = () => {
        events = eventsRequest.result as NarrativeEvent[];
        if (!Array.isArray(events)) abortWith(new Error("La colección de acontecimientos es inválida."));
      };
      tracksRequest.onsuccess = () => {
        tracks = tracksRequest.result as TimelineTrack[];
        if (!Array.isArray(tracks)) abortWith(new Error("La colección de pistas cronológicas es inválida."));
      };
      eventsRequest.onerror = () => abortWith(
        eventsRequest.error ?? new Error("No se pudieron recuperar los acontecimientos.")
      );
      tracksRequest.onerror = () => abortWith(
        tracksRequest.error ?? new Error("No se pudieron recuperar las pistas cronológicas.")
      );
      transaction.oncomplete = () => {
        try {
          if (failure) throw failure;
          const scopedEvents = validateProjectRecords(events ?? [], projectId, "acontecimiento");
          const scopedTracks = validateProjectRecords(tracks ?? [], projectId, "pista cronológica");
          const trackIds = new Set<string>();
          for (const track of scopedTracks) {
            validateTimelineTrack(track, projectId);
            if (trackIds.has(track.id)) throw new Error("Hay IDs de pistas cronológicas duplicados.");
            trackIds.add(track.id);
          }
          for (const event of scopedEvents) {
            validateNarrativeEventRecord(event, "acontecimiento");
            if (event.timelineTrackId !== undefined && !trackIds.has(event.timelineTrackId)) {
              throw new Error("Un acontecimiento referencia una pista cronológica inexistente o ajena al proyecto.");
            }
          }
          resolve(scopedEvents);
        } catch (error) {
          reject(error);
        }
      };
      transaction.onerror = () => reject(
        failure ?? transaction.error ?? new Error("No se pudieron leer los acontecimientos.")
      );
      transaction.onabort = () => reject(
        failure ?? transaction.error ?? new Error("Se canceló la lectura de acontecimientos.")
      );
    });
  }

  async saveIdea(idea: NarrativeIdea): Promise<void> {
    validateNarrativeIdeaRecord(idea, "idea narrativa");
    const db = await this.open();
    await saveNarrativeIdeaWithReferences(db, idea);
    this.publishNarrativeChange(idea.projectId);
  }

  async saveIdeaIfUnchanged(
    idea: NarrativeIdea,
    expectedCurrent?: NarrativeIdea,
    syncOperation?: SyncOperationDraft
  ): Promise<void> {
    validateNarrativeIdeaRecord(idea, "idea narrativa");
    if (expectedCurrent !== undefined) validateNarrativeIdeaRecord(expectedCurrent, "idea anterior");
    const db = await this.open();
    await saveNarrativeIdeaWithReferences(db, idea, expectedCurrent, true, syncOperation);
    this.publishNarrativeChange(idea.projectId);
  }

  /**
   * Actualiza una idea existente solo si sigue presente y coincide con la
   * versión leída por el anfitrión. Impide que una caché antigua la restaure
   * después de que otra instancia la haya archivado o modificado.
   */
  async updateIdeaIfUnchanged(
    idea: NarrativeIdea,
    expectedCurrent: NarrativeIdea,
    syncOperation?: SyncOperationDraft
  ): Promise<void> {
    validateNarrativeIdeaRecord(idea, "idea narrativa");
    validateNarrativeIdeaRecord(expectedCurrent, "idea anterior");
    const db = await this.open();
    await saveNarrativeIdeaWithReferences(db, idea, expectedCurrent, true, syncOperation);
    this.publishNarrativeChange(idea.projectId);
  }

  async loadIdeas(projectId: string): Promise<readonly NarrativeIdea[]> {
    if (typeof projectId !== "string" || !projectId.trim()) throw new Error("Identificador de proyecto inválido.");
    const db = await this.open();
    const transaction = db.transaction(IDEAS, "readonly");
    const request = transaction.objectStore(IDEAS).index("by-project").getAll(projectId);
    const records = await readAfterTransaction(transaction, request, "No se pudieron leer las ideas.") as NarrativeIdea[];
    const scoped = validateProjectRecords(records, projectId, "idea narrativa");
    for (const idea of scoped) validateNarrativeIdeaRecord(idea, "idea narrativa");
    return scoped;
  }

  async saveRelation(relation: NarrativeRelation): Promise<void> {
    validateNarrativeRelationRecord(relation, "relación narrativa");
    const db = await this.open();
    await saveNarrativeRecordWithEntityReferences(
      db, RELATIONS, relation, [relation.fromEntityId, relation.toEntityId],
      "No se pudo guardar la relación narrativa."
    );
    this.publishNarrativeChange(relation.projectId);
  }

  async saveRelationIfUnchanged(
    relation: NarrativeRelation,
    expectedCurrent?: NarrativeRelation,
    syncOperation?: SyncOperationDraft
  ): Promise<void> {
    validateNarrativeRelationRecord(relation, "relación narrativa");
    if (expectedCurrent !== undefined) validateNarrativeRelationRecord(expectedCurrent, "relación anterior");
    const db = await this.open();
    await saveNarrativeRecordWithEntityReferences(
      db, RELATIONS, relation, [relation.fromEntityId, relation.toEntityId],
      "No se pudo guardar la relación narrativa.", expectedCurrent, true, syncOperation
    );
    this.publishNarrativeChange(relation.projectId);
  }

  async loadRelations(projectId: string): Promise<readonly NarrativeRelation[]> {
    if (typeof projectId !== "string" || !projectId.trim()) throw new Error("Identificador de proyecto inválido.");
    const db = await this.open();
    const transaction = db.transaction(RELATIONS, "readonly");
    const request = transaction.objectStore(RELATIONS).index("by-project").getAll(projectId);
    const records = await readAfterTransaction(transaction, request, "No se pudieron leer las relaciones narrativas.") as NarrativeRelation[];
    const scoped = validateProjectRecords(records, projectId, "relación narrativa");
    for (const relation of scoped) validateNarrativeRelationRecord(relation, "relación narrativa");
    return scoped;
  }

  async saveEntity(entity: NarrativeEntity): Promise<void> {
    validateNarrativeEntityRecord(entity, "entidad narrativa");
    const db = await this.open();
    await saveNarrativeEntityRecord(db, entity);
    this.publishNarrativeChange(entity.projectId);
  }

  async saveEntityIfUnchanged(
    entity: NarrativeEntity,
    expectedCurrent?: NarrativeEntity,
    syncOperation?: SyncOperationDraft
  ): Promise<void> {
    validateNarrativeEntityRecord(entity, "entidad narrativa");
    if (expectedCurrent !== undefined) validateNarrativeEntityRecord(expectedCurrent, "entidad anterior");
    const db = await this.open();
    await saveNarrativeEntityRecord(db, entity, expectedCurrent, true, syncOperation);
    this.publishNarrativeChange(entity.projectId);
  }

  async loadEntities(projectId: string): Promise<readonly NarrativeEntity[]> {
    if (typeof projectId !== "string" || !projectId.trim()) throw new Error("Identificador de proyecto inválido.");
    const db = await this.open();
    const transaction = db.transaction(ENTITIES, "readonly");
    const request = transaction.objectStore(ENTITIES).index("by-project").getAll(projectId);
    const records = await readAfterTransaction(transaction, request, "No se pudieron leer las entidades narrativas.") as NarrativeEntity[];
    const scoped = validateProjectRecords(records, projectId, "entidad narrativa");
    for (const entity of scoped) validateNarrativeEntityRecord(entity, "entidad narrativa");
    validateNarrativeEntityIdentityHistory(scoped);
    return scoped;
  }

  /**
   * Consolida dos identidades y redirige todas sus referencias en una única
   * transacción IndexedDB. Un aborto deja intactas todas las colecciones.
   */
  async mergeNarrativeEntityIdentity(
    projectId: string,
    targetEntityId: string,
    sourceEntityId: string,
    writerId?: string,
    syncOperation?: SyncOperationDraft
  ): Promise<void> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof targetEntityId !== "string" || !targetEntityId.trim() ||
        typeof sourceEntityId !== "string" || !sourceEntityId.trim() ||
        targetEntityId === sourceEntityId ||
        (writerId !== undefined && (typeof writerId !== "string" || !writerId.trim() || writerId.length > 256))) {
      throw new Error("Identidades de entidad inválidas para consolidación.");
    }
    const syncDraft = syncOperation === undefined ? undefined : normalizeSyncOperationDraft(syncOperation);
    if (syncDraft && syncDraft.projectId !== projectId) {
      throw new Error("El proyecto de las entidades y de la operación entity-merge no coincide.");
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      // La biblioteca se incluye incluso sin writerId para detectar
      // entradas archivadas que no podríamos mantener coherentes sin identidad.
      const stores = [
        ENTITIES, RELATIONS, EVENTS, ASSERTIONS, IDEAS, PERSONAL_IDEAS,
        ...(syncDraft ? [SYNC_OUTBOX, SYNC_DEVICE_SEQUENCES] : [])
      ];
      const transaction = db.transaction(stores, "readwrite");
      let syncFailure: Error | undefined;
      const entityStore = transaction.objectStore(ENTITIES);
      const relationStore = transaction.objectStore(RELATIONS);
      const eventStore = transaction.objectStore(EVENTS);
      const assertionStore = transaction.objectStore(ASSERTIONS);
      const ideaStore = transaction.objectStore(IDEAS);
      const personalIdeaStore = transaction.objectStore(PERSONAL_IDEAS);
      const requests = [
        entityStore.index("by-project").getAll(projectId),
        relationStore.index("by-project").getAll(projectId),
        eventStore.index("by-project").getAll(projectId),
        assertionStore.index("by-project").getAll(projectId),
        ideaStore.index("by-project").getAll(projectId),
        writerId
          ? personalIdeaStore.index("by-writer-source").getAll([writerId, projectId])
          : personalIdeaStore.index(PERSONAL_IDEA_SOURCE_INDEX).getAll(projectId)
      ];
      const results: unknown[][] = Array.from({ length: requests.length }, () => []);
      let remaining = requests.length;
      requests.forEach((request, index) => {
        request.onsuccess = () => {
          results[index] = request.result as unknown[];
          remaining--;
          if (remaining !== 0) return;
          try {
            const entities = validateProjectRecords(
              results[0] as NarrativeEntity[], projectId, "entidad narrativa"
            );
            const relations = validateProjectRecords(
              results[1] as NarrativeRelation[], projectId, "relación narrativa"
            );
            const events = validateProjectRecords(
              results[2] as NarrativeEvent[], projectId, "acontecimiento"
            );
            const assertions = validateProjectRecords(
              results[3] as NarrativeAssertion[], projectId, "afirmación narrativa"
            );
            const ideas = validateProjectRecords(
              results[4] as NarrativeIdea[], projectId, "idea narrativa"
            );
            for (const entity of entities) {
              validateNarrativeEntityRecord(entity, "entidad narrativa");
            }
            validateNarrativeEntityIdentityHistory(entities);
            for (const relation of relations) {
              validateNarrativeRelationRecord(relation, "relación narrativa");
            }
            for (const event of events) {
              validateNarrativeEventRecord(event, "acontecimiento");
            }
            for (const assertion of assertions) {
              validateNarrativeAssertionRecord(assertion, "afirmación narrativa");
            }
            for (const idea of ideas) {
              validateNarrativeIdeaRecord(idea, "idea narrativa");
            }

            const entityIds = new Set(entities.map(entity => entity.id));
            for (const relation of relations) {
              if (!entityIds.has(relation.fromEntityId) || !entityIds.has(relation.toEntityId)) {
                throw new Error("La consolidación se rechazó: una relación referencia una entidad inexistente.");
              }
            }
            for (const event of events) {
              if (event.participants.some(id => !entityIds.has(id))) {
                throw new Error("La consolidación se rechazó: un acontecimiento referencia una entidad inexistente.");
              }
            }
            for (const assertion of assertions) {
              if (!entityIds.has(assertion.entityId)) {
                throw new Error("La consolidación se rechazó: una afirmación referencia una entidad inexistente.");
              }
            }
            for (const idea of ideas) {
              if ((idea.relatedEntityIds ?? []).some(id => !entityIds.has(id))) {
                throw new Error("La consolidación se rechazó: una idea referencia una entidad inexistente.");
              }
            }
            // La consolidación también exige que el grafo de ideas esté íntegro.
            // No se debe reescribir ninguna identidad si ya hay vínculos huérfanos.
            const ideaIds = new Set(ideas.map(idea => idea.id));
            for (const idea of ideas) {
              if ((idea.relatedIdeaIds ?? []).some(id => !ideaIds.has(id))) {
                throw new Error("La consolidación se rechazó: una idea referencia otra idea inexistente.");
              }
            }

            const target = entities.find(item => item.id === targetEntityId);
            const source = entities.find(item => item.id === sourceEntityId);
            // Un replay puede repetirse si el proceso cayó después de confirmar
            // esta transacción y antes de confirmar el acuse del diario.
            if (target && !source && target.projectId === projectId &&
                (target.mergedFromIds ?? []).includes(sourceEntityId)) {
              return;
            }
            if (!target || !source || target.projectId !== projectId || source.projectId !== projectId ||
                target.kind !== source.kind) {
              transaction.abort();
              return;
            }
            const mergedNameKeys = new Set(
              [target.canonicalName, ...target.aliases, source.canonicalName, ...source.aliases]
                .map(normalizeEntityName)
            );
            const aliasCollision = entities.find(item =>
              item.id !== targetEntityId && item.id !== sourceEntityId && item.kind === target.kind &&
              [item.canonicalName, ...item.aliases].some(name => mergedNameKeys.has(normalizeEntityName(name)))
            );
            if (aliasCollision) {
              throw new Error("La consolidación produciría un alias ambiguo con otra entidad del proyecto.");
            }
            const aliases = [...new Map(
              [...target.aliases, source.canonicalName, ...source.aliases]
                .map(alias => [normalizeEntityName(alias), alias] as const)
            ).values()].filter(alias => alias && normalizeEntityName(alias) !== target.normalizedName);
            const mergedFromIds = [...new Set([...(target.mergedFromIds ?? []), source.id, ...(source.mergedFromIds ?? [])])];
            const evidence = [...target.evidence];
            const evidenceKeys = new Set(evidence.map(item => [item.documentId, item.revision, item.start, item.end, item.excerpt, item.status ?? ""].join("\u0000")));
            for (const item of source.evidence) {
              const key = [item.documentId, item.revision, item.start, item.end, item.excerpt, item.status ?? ""].join("\u0000");
              if (!evidenceKeys.has(key)) { evidence.push(item); evidenceKeys.add(key); }
            }
            const mergedEntity: NarrativeEntity = {
              ...target, aliases, mergedFromIds, evidence,
              firstSeenAt: Math.min(target.firstSeenAt, source.firstSeenAt),
              lastSeenAt: Math.max(target.lastSeenAt, source.lastSeenAt)
            };
            validateNarrativeEntityRecord(mergedEntity, "entidad consolidada");
            const originalPersonalEntries = results[5] as PersonalIdeaLibraryEntry[];
            if (!Array.isArray(originalPersonalEntries)) {
              throw new Error("Biblioteca personal inconsistente: no se pudieron verificar las entradas del libro.");
            }
            if (!writerId && originalPersonalEntries.length > 0) {
              throw new Error("Se requiere la identidad estable del escritor para consolidar entidades de un libro con ideas ya archivadas.");
            }
            const personalEntries = writerId
              ? remapPersonalIdeaEntriesForEntityMerge(
                originalPersonalEntries, writerId, projectId, sourceEntityId, mergedEntity
              )
              : [];
            entityStore.put(mergedEntity);
            entityStore.delete([projectId, sourceEntityId]);
            const relationGroups = new Map<string, Array<{
              relation: NarrativeRelation;
              originatedAtCanonical: boolean;
            }>>();
            for (const relation of relations) {
              if (relation.projectId !== projectId) continue;
              const originatedAtCanonical =
                relation.fromEntityId === targetEntityId || relation.toEntityId === targetEntityId;
              const fromEntityId = relation.fromEntityId === sourceEntityId ? targetEntityId : relation.fromEntityId;
              const toEntityId = relation.toEntityId === sourceEntityId ? targetEntityId : relation.toEntityId;
              // Una relación de una entidad consigo misma pierde su sentido tras la consolidación.
              if (fromEntityId === toEntityId) {
                relationStore.delete([projectId, relation.id]);
                continue;
              }
              const key = JSON.stringify([fromEntityId, relation.relationType, toEntityId]);
              const group = relationGroups.get(key) ?? [];
              group.push({
                relation: { ...relation, fromEntityId, toEntityId },
                originatedAtCanonical
              });
              relationGroups.set(key, group);
            }
            for (const group of relationGroups.values()) {
              // La identidad de origen se conserva antes de reescribir los extremos.
              group.sort((a, b) =>
                Number(b.originatedAtCanonical) - Number(a.originatedAtCanonical) ||
                a.relation.id.localeCompare(b.relation.id)
              );
              const primary = group[0]?.relation;
              if (!primary) continue;
              const duplicates = group.slice(1).map(item => item.relation);
              const evidenceByKey = new Map<string, TextEvidence>();
              for (const item of group) {
                for (const evidence of item.relation.evidence) {
                  const evidenceKey = [evidence.documentId, evidence.revision, evidence.start, evidence.end, evidence.excerpt, evidence.status ?? ""].join("\u0000");
                  if (!evidenceByKey.has(evidenceKey)) evidenceByKey.set(evidenceKey, evidence);
                }
              }
              relationStore.put({ ...primary, evidence: [...evidenceByKey.values()] });
              for (const duplicate of duplicates) {
                if (duplicate.id !== primary.id) relationStore.delete([projectId, duplicate.id]);
              }
            }
            for (const event of events) {
              if (!event.participants.includes(sourceEntityId)) continue;
              const participants = [...new Set(event.participants.map(id => id === sourceEntityId ? targetEntityId : id))];
              eventStore.put({ ...event, participants });
            }
            for (const assertion of assertions) {
              if (assertion.entityId === sourceEntityId) assertionStore.put({ ...assertion, entityId: targetEntityId });
            }
            for (const idea of ideas) {
              if (!idea.relatedEntityIds?.includes(sourceEntityId)) continue;
              const relatedEntityIds = [...new Set(idea.relatedEntityIds.map(id =>
                id === sourceEntityId ? targetEntityId : id
              ))];
              ideaStore.put({ ...idea, relatedEntityIds });
            }
            personalEntries.forEach((entry, index) => {
              if (entry !== originalPersonalEntries[index]) personalIdeaStore.put(entry);
            });
            if (syncDraft) {
              queueSyncOperationInTransaction(transaction, syncDraft, error => {
                syncFailure = error instanceof Error
                  ? error : new Error("No se pudo encolar la consolidación narrativa.");
                try { transaction.abort(); } catch { /* transacción ya abortada */ }
              });
            }
          } catch (error) {
            try { transaction.abort(); } catch { /* transacción ya finalizada */ }
            reject(error);
          }
        };
        request.onerror = () => {
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
        };
      });
      transaction.oncomplete = () => {
        this.publishNarrativeChange(projectId);
        resolve();
      };
      transaction.onerror = () => reject(syncFailure ?? transaction.error ?? new Error("No se pudo consolidar la identidad narrativa."));
      transaction.onabort = () => reject(syncFailure ?? transaction.error ?? new Error("Se canceló la consolidación de identidad."));
    });
  }

  async saveDocument(document: StoredDocument): Promise<void> {
    if (!document || typeof document.projectId !== "string" || !document.projectId.trim() ||
        typeof document.documentId !== "string" || !document.documentId.trim() ||
        typeof document.text !== "string" ||
        !Number.isSafeInteger(document.revision) || document.revision < 0 ||
        !Number.isSafeInteger(document.sequence) || document.sequence < 0 ||
        !Number.isFinite(document.updatedAt) || document.updatedAt < 0) {
      throw new Error("Snapshot de documento inválido: no se puede persistir un estado malformado.");
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      // Un guardado compatible no dispone de la reconstrucción y verificación
      // atómica del checkpoint. Por eso no puede avanzar el snapshot si hay
      // deltas pendientes ni inicializarlo sobre un journal huérfano.
      const transaction = db.transaction([DOCUMENTS, CHANGES], "readwrite");
      const documents = transaction.objectStore(DOCUMENTS);
      const changes = transaction.objectStore(CHANGES);
      let conflict = false;
      const abort = () => {
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      const currentRequest = documents.get([document.projectId, document.documentId]);
      currentRequest.onsuccess = () => {
        const current = currentRequest.result as StoredDocument | undefined;
        if (current && (
          current.projectId !== document.projectId ||
          current.documentId !== document.documentId ||
          typeof current.text !== "string" ||
          !Number.isSafeInteger(current.revision) || current.revision < 0 ||
          !Number.isSafeInteger(current.sequence) || current.sequence < 0 ||
          !Number.isFinite(current.updatedAt) || current.updatedAt < 0
        )) {
          conflict = true;
          abort();
          return;
        }
        if (current && (
          document.sequence < current.sequence ||
          document.revision < current.revision ||
          document.sequence - current.sequence !== document.revision - current.revision ||
          (document.sequence === current.sequence &&
            (document.revision !== current.revision || document.text !== current.text))
        )) {
          conflict = true;
          abort();
          return;
        }
        const advancesSnapshot = !current || document.sequence > current.sequence;
        if (!advancesSnapshot) {
          documents.put(document);
          return;
        }
        const range = IDBKeyRange.bound(
          [document.projectId, document.documentId, 0],
          [document.projectId, document.documentId, Number.MAX_SAFE_INTEGER]
        );
        const journalRequest = changes.index(CHANGE_INDEX).openCursor(range);
        journalRequest.onsuccess = () => {
          if (journalRequest.result) {
            conflict = true;
            abort();
            return;
          }
          documents.put(document);
        };
        journalRequest.onerror = abort;
      };
      currentRequest.onerror = abort;
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar el documento."));
      transaction.onabort = () => reject(
        conflict
          ? new Error("Guardado rechazado: no se puede avanzar el snapshot sin un checkpoint verificable y un journal vacío.")
          : transaction.error ?? new Error("Se canceló el guardado.")
      );
    });
  }

  async saveDocumentAndCompactChanges(
    document: StoredDocument,
    throughSequence: number
  ): Promise<void> {
    if (!document || typeof document.projectId !== "string" || !document.projectId.trim() ||
        typeof document.documentId !== "string" || !document.documentId.trim() ||
        typeof document.text !== "string" ||
        !Number.isSafeInteger(document.revision) || document.revision < 0 ||
        !Number.isSafeInteger(document.sequence) || document.sequence < 0 ||
        !Number.isFinite(document.updatedAt) || document.updatedAt < 0) {
      throw new Error("Snapshot de documento inválido: no se puede persistir un estado malformado.");
    }
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0 ||
        throughSequence !== document.sequence) {
      throw new Error("El límite de compactación debe coincidir exactamente con la secuencia del snapshot.");
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      // La lectura, reconstrucción, validación, escritura y compactación
      // comparten una transacción: nunca se borran deltas que el snapshot
      // recibido no demuestre contener.
      const transaction = db.transaction([DOCUMENTS, CHANGES], "readwrite");
      const documents = transaction.objectStore(DOCUMENTS);
      const changes = transaction.objectStore(CHANGES);
      let conflict = false;
      const abort = () => {
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      const failConflict = () => {
        conflict = true;
        abort();
      };
      const currentRequest = documents.get([document.projectId, document.documentId]);
      currentRequest.onsuccess = () => {
        const current = currentRequest.result as StoredDocument | undefined;
        if (current && (
          current.projectId !== document.projectId ||
          current.documentId !== document.documentId ||
          typeof current.text !== "string" ||
          !Number.isSafeInteger(current.revision) || current.revision < 0 ||
          !Number.isSafeInteger(current.sequence) || current.sequence < 0 ||
          !Number.isFinite(current.updatedAt) || current.updatedAt < 0
        )) {
          failConflict();
          return;
        }
        if (current && (
          document.sequence < current.sequence ||
          document.revision < current.revision ||
          document.sequence - current.sequence !== document.revision - current.revision
        )) {
          failConflict();
          return;
        }
        if (!current) {
          // Sin snapshot base no se puede demostrar la relación entre el
          // snapshot entrante y ningún delta durable. No basta con buscar
          // registros anteriores al límite: un delta posterior también puede
          // ser huérfano o pertenecer a otra rama. Exigimos journal vacío.
          const index = changes.index(CHANGE_INDEX);
          const orphanRange = IDBKeyRange.bound(
            [document.projectId, document.documentId, 0],
            [document.projectId, document.documentId, Number.MAX_SAFE_INTEGER]
          );
          const orphanRequest = index.openCursor(orphanRange);
          orphanRequest.onsuccess = () => {
            if (orphanRequest.result) {
              failConflict();
              return;
            }
            documents.put(document);
          };
          orphanRequest.onerror = abort;
          return;
        }

        if (document.sequence === current.sequence) {
          if (document.revision !== current.revision) {
            failConflict();
            return;
          }
          const commitCheckpoint = (): void => {
            documents.put(document);
            // El snapshot autoritativo cubre todos los deltas hasta su secuencia.
            const coveredRange = IDBKeyRange.bound(
              [document.projectId, document.documentId, 0],
              [document.projectId, document.documentId, throughSequence]
            );
            const coveredRequest = changes.index(CHANGE_INDEX).openCursor(coveredRange);
            coveredRequest.onsuccess = () => {
              const cursor = coveredRequest.result;
              if (cursor) {
                cursor.delete();
                cursor.continue();
              }
            };
            coveredRequest.onerror = abort;
          };
          if (document.text === current.text) {
            commitCheckpoint();
            return;
          }
          // Una diferencia de texto con la misma revisión/sequence solo puede
          // aceptarse como reemplazo autoritativo si no hay deltas posteriores
          // que puedan depender de la rama local divergente.
          if (throughSequence === Number.MAX_SAFE_INTEGER) {
            commitCheckpoint();
            return;
          }
          const laterRange = IDBKeyRange.bound(
            [document.projectId, document.documentId, throughSequence + 1],
            [document.projectId, document.documentId, Number.MAX_SAFE_INTEGER]
          );
          const laterRequest = changes.index(CHANGE_INDEX).openCursor(laterRange);
          laterRequest.onsuccess = () => {
            if (laterRequest.result) {
              failConflict();
              return;
            }
            commitCheckpoint();
          };
          laterRequest.onerror = abort;
          return;
        }

        let expectedSequence = current.sequence;
        let expectedRevision = current.revision;
        let reconstructedText = current.text;
        const index = changes.index(CHANGE_INDEX);
        const range = IDBKeyRange.bound(
          [document.projectId, document.documentId, current.sequence + 1],
          [document.projectId, document.documentId, throughSequence]
        );
        const cursorRequest = index.openCursor(range);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) {
            const entry = cursor.value as StoredChange;
            if (entry.projectId !== document.projectId ||
                entry.documentId !== document.documentId ||
                !Number.isSafeInteger(entry.sequence) ||
                entry.sequence !== expectedSequence + 1 ||
                !Number.isSafeInteger(entry.baseRevision) ||
                entry.baseRevision !== expectedRevision ||
                !Number.isSafeInteger(entry.committedRevision) ||
                entry.committedRevision !== expectedRevision + 1 ||
                !Number.isSafeInteger(entry.start) ||
                !Number.isSafeInteger(entry.end) ||
                entry.start < 0 || entry.end < entry.start ||
                entry.end > reconstructedText.length ||
                typeof entry.replacement !== "string" ||
                !Number.isFinite(entry.committedAt) || entry.committedAt < 0) {
              failConflict();
              return;
            }
            reconstructedText = reconstructedText.slice(0, entry.start) +
              entry.replacement + reconstructedText.slice(entry.end);
            expectedSequence = entry.sequence;
            expectedRevision = entry.committedRevision;
            cursor.continue();
            return;
          }
          if (expectedSequence !== document.sequence ||
              expectedRevision !== document.revision ||
              reconstructedText !== document.text) {
            failConflict();
            return;
          }
          documents.put(document);
          const deleteRange = IDBKeyRange.bound(
            [document.projectId, document.documentId, 0],
            [document.projectId, document.documentId, throughSequence]
          );
          const deleteRequest = index.openCursor(deleteRange);
          deleteRequest.onsuccess = () => {
            const deleteCursor = deleteRequest.result;
            if (deleteCursor) {
              deleteCursor.delete();
              deleteCursor.continue();
            }
          };
          deleteRequest.onerror = abort;
        };
        cursorRequest.onerror = abort;
      };
      currentRequest.onerror = abort;
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        transaction.error ?? new Error("No se pudo guardar el snapshot y compactar el journal.")
      );
      transaction.onabort = () => reject(
        conflict
          ? new Error("Checkpoint obsoleto o inconsistente: se conserva el snapshot y el journal más recientes.")
          : transaction.error ?? new Error("Se canceló el checkpoint atómico del documento.")
      );
    });
  }

  async appendChange(change: StoredChange): Promise<void> {
    return this.persistChange(change);
  }

  /** Persiste journal y outbox juntos; evita deltas locales sin operación replicable. */
  async appendChangeAndEnqueueSyncOperation(
    change: StoredChange,
    operation: SyncOperationDraft
  ): Promise<void> {
    const normalized = normalizeSyncOperationDraft(operation);
    if (normalized.projectId !== change.projectId) {
      throw new Error("El proyecto del delta y de la operación de sincronización no coincide.");
    }
    return this.persistChange(change, normalized);
  }

  private async persistChange(
    change: StoredChange,
    syncOperation?: SyncOperationDraft
  ): Promise<void> {
    if (!change || typeof change.projectId !== "string" || !change.projectId.trim() ||
        typeof change.documentId !== "string" || !change.documentId.trim() ||
        !Number.isSafeInteger(change.sequence) || change.sequence < 1 ||
        !Number.isSafeInteger(change.baseRevision) || change.baseRevision < 0 ||
        !Number.isSafeInteger(change.committedRevision) ||
        change.committedRevision !== change.baseRevision + 1 ||
        !Number.isSafeInteger(change.start) || !Number.isSafeInteger(change.end) ||
        change.start < 0 || change.end < change.start ||
        typeof change.replacement !== "string" ||
        !Number.isFinite(change.committedAt) || change.committedAt < 0) {
      throw new Error("Registro de journal inválido: no se puede persistir una edición malformada.");
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const storeNames = syncOperation
        ? [DOCUMENTS, CHANGES, SYNC_OUTBOX, SYNC_DEVICE_SEQUENCES]
        : [DOCUMENTS, CHANGES];
      const transaction = db.transaction(storeNames, "readwrite");
      const documents = transaction.objectStore(DOCUMENTS);
      const changes = transaction.objectStore(CHANGES);
      const outbox = syncOperation ? transaction.objectStore(SYNC_OUTBOX) : undefined;
      const sequences = syncOperation ? transaction.objectStore(SYNC_DEVICE_SEQUENCES) : undefined;
      let snapshotReady = false;
      let journalReady = false;
      let snapshot: StoredDocument | undefined;
      let expectedSequence = 0;
      let expectedRevision = 0;
      let expectedTextLength = 0;
      let conflict = false;
      let persistenceError: Error | undefined;
      const abort = () => {
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      const appendDurableChange = () => {
        if (!syncOperation) {
          try { changes.add(change); }
          catch (error) {
            persistenceError = error instanceof Error ? error : new Error("No se pudo añadir el delta al journal.");
            abort();
          }
          return;
        }
        const sequenceRequest = sequences!.get([syncOperation.projectId, syncOperation.deviceId]);
        sequenceRequest.onsuccess = () => {
          const stored = sequenceRequest.result as { readonly lastSequence?: unknown } | undefined;
          const lastSequence = stored?.lastSequence ?? 0;
          if (!Number.isSafeInteger(lastSequence) || (lastSequence as number) < 0 ||
              (lastSequence as number) >= Number.MAX_SAFE_INTEGER) {
            persistenceError = new Error("El cursor de secuencia del dispositivo está corrupto o agotado.");
            abort();
            return;
          }
          const operationRecord = normalizeSyncOperation({
            ...syncOperation,
            sequence: (lastSequence as number) + 1,
            attemptCount: 0
          });
          try {
            const operationRequest = outbox!.add(operationRecord);
            operationRequest.onerror = () => {
              persistenceError = operationRequest.error ?? new Error("No se pudo encolar la operación de sincronización.");
              abort();
            };
            const sequenceWrite = sequences!.put({
              projectId: syncOperation.projectId,
              deviceId: syncOperation.deviceId,
              lastSequence: operationRecord.sequence
            });
            sequenceWrite.onerror = () => {
              persistenceError = sequenceWrite.error ?? new Error("No se pudo avanzar la secuencia del dispositivo.");
              abort();
            };
            const changeWrite = changes.add(change);
            changeWrite.onerror = () => {
              persistenceError = changeWrite.error ?? new Error("No se pudo añadir el delta al journal.");
              abort();
            };
          } catch (error) {
            persistenceError = error instanceof Error ? error : new Error("No se pudo persistir el cambio sincronizable.");
            abort();
          }
        };
        sequenceRequest.onerror = () => {
          persistenceError = sequenceRequest.error ?? new Error("No se pudo leer el cursor del dispositivo.");
          abort();
        };
      };
      const validateAndAppend = () => {
        if (!snapshotReady || !journalReady) return;
        // Un delta nunca puede inaugurar un journal: debe existir un snapshot
        // durable que proporcione la base de revisión, secuencia y offsets.
        if (!snapshot || change.sequence !== expectedSequence + 1 ||
            change.baseRevision !== expectedRevision || change.end > expectedTextLength) {
          conflict = true;
          abort();
          return;
        }
        appendDurableChange();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        persistenceError ?? transaction.error ?? new Error("No se pudo registrar el cambio.")
      );
      transaction.onabort = () => reject(
        persistenceError ?? (conflict
          ? new Error("Conflicto de secuencia o revisión: el documento cambió en otra instancia y requiere resincronización.")
          : transaction.error ?? new Error("Se canceló el registro del cambio."))
      );
      const snapshotRequest = documents.get([change.projectId, change.documentId]);
      snapshotRequest.onsuccess = () => {
        snapshot = snapshotRequest.result as StoredDocument | undefined;
        if (snapshot && (
          snapshot.projectId !== change.projectId ||
          snapshot.documentId !== change.documentId ||
          typeof snapshot.text !== "string" ||
          !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
          !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 ||
          !Number.isFinite(snapshot.updatedAt) || snapshot.updatedAt < 0
        )) {
          conflict = true;
          abort();
          return;
        }
        if (snapshot) {
          expectedSequence = snapshot.sequence;
          expectedRevision = snapshot.revision;
          expectedTextLength = snapshot.text.length;
        }
        snapshotReady = true;
        validateAndAppend();
      };
      snapshotRequest.onerror = abort;
      const range = IDBKeyRange.bound(
        [change.projectId, change.documentId, 0],
        [change.projectId, change.documentId, Number.MAX_SAFE_INTEGER]
      );
      const journalRequest = changes.index(CHANGE_INDEX).openCursor(range);
      journalRequest.onsuccess = () => {
        const cursor = journalRequest.result;
        if (cursor) {
          const entry = cursor.value as StoredChange;
          if (!entry || entry.projectId !== change.projectId ||
              entry.documentId !== change.documentId ||
              !Number.isSafeInteger(entry.sequence) || entry.sequence !== expectedSequence + 1 ||
              !Number.isSafeInteger(entry.baseRevision) || entry.baseRevision !== expectedRevision ||
              !Number.isSafeInteger(entry.committedRevision) ||
              entry.committedRevision !== expectedRevision + 1 ||
              !Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end) ||
              entry.start < 0 || entry.end < entry.start || entry.end > expectedTextLength ||
              typeof entry.replacement !== "string" ||
              !Number.isFinite(entry.committedAt) || entry.committedAt < 0) {
            conflict = true;
            abort();
            return;
          }
          expectedTextLength += entry.replacement.length - (entry.end - entry.start);
          expectedSequence = entry.sequence;
          expectedRevision = entry.committedRevision;
          cursor.continue();
          return;
        }
        journalReady = true;
        validateAndAppend();
      };
      journalRequest.onerror = abort;
    });
  }

  async loadChanges(projectId: string, documentId: string, afterSequence: number): Promise<readonly StoredChange[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof documentId !== "string" || !documentId.trim() ||
        !Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
        afterSequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Parámetros inválidos para leer el journal.");
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(CHANGES, "readonly");
      const index = transaction.objectStore(CHANGES).index(CHANGE_INDEX);
      const range = IDBKeyRange.bound(
        [projectId, documentId, afterSequence + 1],
        [projectId, documentId, Number.MAX_SAFE_INTEGER]
      );
      let validatedChanges: StoredChange[] = [];
      let validationError: Error | undefined;
      const request = index.getAll(range);
      request.onsuccess = () => {
        try {
          const result = request.result as StoredChange[];
          if (!Array.isArray(result)) {
            validationError = new Error("Journal inconsistente: la colección recuperada no es válida.");
            return;
          }
          const changes = [...result].sort((a, b) => a.sequence - b.sequence);
          let expectedSequence = afterSequence;
          let expectedRevision: number | undefined;
          for (const change of changes) {
            if (!change || change.projectId !== projectId || change.documentId !== documentId ||
                !Number.isSafeInteger(change.sequence) || change.sequence !== expectedSequence + 1 ||
                !Number.isSafeInteger(change.baseRevision) || change.baseRevision < 0 ||
                (expectedRevision !== undefined && change.baseRevision !== expectedRevision) ||
                !Number.isSafeInteger(change.committedRevision) ||
                change.committedRevision !== change.baseRevision + 1 ||
                !Number.isSafeInteger(change.start) || !Number.isSafeInteger(change.end) ||
                change.start < 0 || change.end < change.start ||
                typeof change.replacement !== "string" ||
                !Number.isFinite(change.committedAt) || change.committedAt < 0) {
              validationError = new Error("Journal inconsistente: se requiere resincronización antes de recuperar el documento.");
              return;
            }
            expectedSequence = change.sequence;
            expectedRevision = change.committedRevision;
          }
          validatedChanges = changes;
        } catch {
          validationError = new Error("Journal inconsistente: no se pudo validar la colección recuperada.");
        }
      };
      request.onerror = () => {
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => {
        if (validationError) reject(validationError);
        else resolve(validatedChanges);
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo leer el journal."));
      transaction.onabort = () => reject(
        transaction.error ?? new Error("Se canceló la lectura consistente del journal.")
      );
    });
  }

  async compactChanges(projectId: string, documentId: string, throughSequence: number): Promise<void> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof documentId !== "string" || !documentId.trim() ||
        !Number.isSafeInteger(throughSequence) || throughSequence < 0) {
      throw new Error("Parámetros inválidos para compactar el journal.");
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      // La compactación compatible solo puede borrar deltas cubiertos por
      // un snapshot durable de exactamente esa secuencia. Sin esa prueba,
      // la operación sería una eliminación irreversible sin checkpoint.
      const transaction = db.transaction([DOCUMENTS, CHANGES], "readwrite");
      const documents = transaction.objectStore(DOCUMENTS);
      const index = transaction.objectStore(CHANGES).index(CHANGE_INDEX);
      let conflict = false;
      const snapshotRequest = documents.get([projectId, documentId]);
      snapshotRequest.onsuccess = () => {
        const snapshot = snapshotRequest.result as StoredDocument | undefined;
        if (!snapshot || snapshot.projectId !== projectId || snapshot.documentId !== documentId ||
            typeof snapshot.text !== "string" ||
            !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
            !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence !== throughSequence ||
            !Number.isFinite(snapshot.updatedAt) || snapshot.updatedAt < 0) {
          conflict = true;
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
          return;
        }
        const range = IDBKeyRange.bound(
          [projectId, documentId, 0],
          [projectId, documentId, throughSequence]
        );
        const request = index.openCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        request.onerror = () => {
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
        };
      };
      snapshotRequest.onerror = () => {
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo compactar el journal."));
      transaction.onabort = () => reject(
        conflict
          ? new Error("Compactación rechazada: no existe un snapshot durable que cubra exactamente la secuencia solicitada.")
          : transaction.error ?? new Error("Se canceló la compactación.")
      );
    });
  }

  /**
   * Lee el snapshot y todos sus deltas posteriores en una única transacción
   * readonly. Evita combinar un snapshot anterior al checkpoint con un journal
   * que otra instancia ya compactó en una transacción posterior.
   */
  async loadDocumentWithChanges(
    projectId: string,
    documentId: string
  ): Promise<{ readonly document: StoredDocument | undefined; readonly changes: readonly StoredChange[] }> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof documentId !== "string" || !documentId.trim()) {
      throw new Error("Parámetros inválidos para recuperar el documento y su journal.");
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([DOCUMENTS, CHANGES], "readonly");
      let document: StoredDocument | undefined;
      let changes: StoredChange[] = [];
      let validationError: Error | undefined;
      const abort = (): void => {
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      const documentRequest = transaction.objectStore(DOCUMENTS).get([projectId, documentId]);
      documentRequest.onsuccess = () => {
        const stored = documentRequest.result as StoredDocument | undefined;
        if (stored !== undefined && (
          !stored || stored.projectId !== projectId || stored.documentId !== documentId ||
          typeof stored.text !== "string" ||
          !Number.isSafeInteger(stored.revision) || stored.revision < 0 ||
          !Number.isSafeInteger(stored.sequence) || stored.sequence < 0 ||
          !Number.isFinite(stored.updatedAt) || stored.updatedAt < 0
        )) {
          validationError = new Error("Snapshot almacenado malformado o perteneciente a otra identidad de documento.");
          abort();
          return;
        }
        document = stored;
        const afterSequence = stored?.sequence ?? 0;
        if (stored && afterSequence === Number.MAX_SAFE_INTEGER) return;
        const range = IDBKeyRange.bound(
          [projectId, documentId, stored ? afterSequence + 1 : 0],
          [projectId, documentId, Number.MAX_SAFE_INTEGER]
        );
        const changesRequest = transaction.objectStore(CHANGES)
          .index(CHANGE_INDEX).getAll(range);
        changesRequest.onsuccess = () => {
          try {
            const result = changesRequest.result as StoredChange[];
            if (!Array.isArray(result)) {
              throw new Error("Journal inconsistente: la colección recuperada no es válida.");
            }
            const ordered = [...result].sort((left, right) => left.sequence - right.sequence);
            let expectedSequence = document?.sequence ?? 0;
            let expectedRevision = document?.revision;
            for (const entry of ordered) {
              if (!entry || entry.projectId !== projectId || entry.documentId !== documentId ||
                  !Number.isSafeInteger(entry.sequence) || entry.sequence !== expectedSequence + 1 ||
                  !Number.isSafeInteger(entry.baseRevision) || entry.baseRevision < 0 ||
                  (expectedRevision !== undefined && entry.baseRevision !== expectedRevision) ||
                  !Number.isSafeInteger(entry.committedRevision) ||
                  entry.committedRevision !== entry.baseRevision + 1 ||
                  !Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end) ||
                  entry.start < 0 || entry.end < entry.start ||
                  typeof entry.replacement !== "string" ||
                  !Number.isFinite(entry.committedAt) || entry.committedAt < 0) {
                throw new Error("Journal inconsistente: se requiere resincronización antes de recuperar el documento.");
              }
              expectedSequence = entry.sequence;
              expectedRevision = entry.committedRevision;
            }
            changes = ordered;
          } catch (error) {
            validationError = error instanceof Error
              ? error
              : new Error("No se pudo validar el journal del documento.");
            abort();
          }
        };
        changesRequest.onerror = abort;
      };
      documentRequest.onerror = abort;
      transaction.oncomplete = () => {
        if (validationError) reject(validationError);
        else resolve({ document, changes });
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo leer la recuperación consistente del documento."));
      transaction.onabort = () => reject(
        transaction.error ?? validationError ?? new Error("Se canceló la lectura consistente del documento y su journal.")
      );
    });
  }

  async acquireLiveAuthorMonitorLease(
    projectId: string,
    documentId: string,
    ownerId: string,
    now: number,
    leaseDurationMs: number
  ): Promise<StoredLiveAuthorMonitorLease | undefined> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof documentId !== "string" || !documentId.trim() ||
        typeof ownerId !== "string" || !ownerId.trim()) {
      throw new Error("Identidad inválida para adquirir el lease del monitor.");
    }
    validateLiveAuthorMonitorLeaseRequest(now, leaseDurationMs);
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(LIVE_AUTHOR_MONITOR_LEASES, "readwrite");
      const store = transaction.objectStore(LIVE_AUTHOR_MONITOR_LEASES);
      const request = store.get([projectId, documentId]);
      let acquired: StoredLiveAuthorMonitorLease | undefined;
      let failure: Error | undefined;
      request.onsuccess = () => {
        const existing = request.result as StoredLiveAuthorMonitorLease | undefined;
        if (existing !== undefined) {
          try {
            validateLiveAuthorMonitorLease(existing, projectId, documentId);
          } catch {
            failure = new Error("El lease previo del monitor está malformado; no se reemplazó.");
            try { transaction.abort(); } catch { /* transacción ya abortada */ }
            return;
          }
          if (existing.expiresAt > now && existing.ownerId !== ownerId) return;
        }
        const sameActiveOwner = existing !== undefined &&
          existing.expiresAt > now && existing.ownerId === ownerId;
        const fencingToken = sameActiveOwner
          ? existing.fencingToken
          : existing === undefined ? 1 : existing.fencingToken + 1;
        if (!Number.isSafeInteger(fencingToken)) {
          failure = new Error("Se agotó el rango del fencing token del monitor.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
          return;
        }
        acquired = {
          version: 1,
          projectId,
          documentId,
          ownerId,
          fencingToken,
          acquiredAt: sameActiveOwner ? existing.acquiredAt : now,
          expiresAt: sameActiveOwner
            ? Math.max(existing.expiresAt, now + leaseDurationMs)
            : now + leaseDurationMs,
          updatedAt: sameActiveOwner ? Math.max(existing.updatedAt, now) : now
        };
        try {
          store.put(structuredClone(acquired));
        } catch (error) {
          failure = error instanceof Error ? error : new Error("No se pudo clonar el lease del monitor.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
        }
      };
      request.onerror = () => {
        failure = request.error ?? new Error("No se pudo leer el lease previo del monitor.");
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => resolve(acquired ? structuredClone(acquired) : undefined);
      transaction.onerror = () => reject(failure ?? transaction.error ??
        new Error("No se pudo adquirir el lease del monitor."));
      transaction.onabort = () => reject(failure ?? transaction.error ??
        new Error("Se canceló la adquisición del lease del monitor."));
    });
  }

  async renewLiveAuthorMonitorLease(
    lease: StoredLiveAuthorMonitorLease,
    now: number,
    leaseDurationMs: number
  ): Promise<StoredLiveAuthorMonitorLease | undefined> {
    validateLiveAuthorMonitorLease(lease);
    validateLiveAuthorMonitorLeaseRequest(now, leaseDurationMs);
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(LIVE_AUTHOR_MONITOR_LEASES, "readwrite");
      const store = transaction.objectStore(LIVE_AUTHOR_MONITOR_LEASES);
      const request = store.get([lease.projectId, lease.documentId]);
      let renewed: StoredLiveAuthorMonitorLease | undefined;
      let failure: Error | undefined;
      request.onsuccess = () => {
        const existing = request.result as StoredLiveAuthorMonitorLease | undefined;
        if (existing === undefined) return;
        try {
          validateLiveAuthorMonitorLease(existing, lease.projectId, lease.documentId);
        } catch {
          failure = new Error("El lease persistido del monitor está malformado.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
          return;
        }
        if (existing.ownerId !== lease.ownerId ||
            existing.fencingToken !== lease.fencingToken ||
            existing.expiresAt <= now) return;
        renewed = {
          ...existing,
          expiresAt: Math.max(existing.expiresAt, now + leaseDurationMs),
          updatedAt: Math.max(existing.updatedAt, now)
        };
        try {
          store.put(structuredClone(renewed));
        } catch (error) {
          failure = error instanceof Error ? error : new Error("No se pudo clonar el lease renovado.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
        }
      };
      request.onerror = () => {
        failure = request.error ?? new Error("No se pudo leer el lease para renovarlo.");
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => resolve(renewed ? structuredClone(renewed) : undefined);
      transaction.onerror = () => reject(failure ?? transaction.error ??
        new Error("No se pudo renovar el lease del monitor."));
      transaction.onabort = () => reject(failure ?? transaction.error ??
        new Error("Se canceló la renovación del lease del monitor."));
    });
  }

  async releaseLiveAuthorMonitorLease(
    lease: StoredLiveAuthorMonitorLease,
    now: number
  ): Promise<boolean> {
    validateLiveAuthorMonitorLease(lease);
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError("El reloj para liberar el lease del monitor no es válido.");
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(LIVE_AUTHOR_MONITOR_LEASES, "readwrite");
      const store = transaction.objectStore(LIVE_AUTHOR_MONITOR_LEASES);
      const request = store.get([lease.projectId, lease.documentId]);
      let released = false;
      let failure: Error | undefined;
      request.onsuccess = () => {
        const existing = request.result as StoredLiveAuthorMonitorLease | undefined;
        if (existing === undefined) return;
        try {
          validateLiveAuthorMonitorLease(existing, lease.projectId, lease.documentId);
        } catch {
          failure = new Error("El lease persistido del monitor está malformado.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
          return;
        }
        if (existing.ownerId !== lease.ownerId ||
            existing.fencingToken !== lease.fencingToken) return;
        released = true;
        try {
          store.put({
            ...existing,
            expiresAt: Math.max(existing.acquiredAt, now),
            updatedAt: Math.max(existing.acquiredAt, now)
          } satisfies StoredLiveAuthorMonitorLease);
        } catch (error) {
          failure = error instanceof Error ? error : new Error("No se pudo liberar el lease del monitor.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
        }
      };
      request.onerror = () => {
        failure = request.error ?? new Error("No se pudo leer el lease para liberarlo.");
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => resolve(released);
      transaction.onerror = () => reject(failure ?? transaction.error ??
        new Error("No se pudo liberar el lease del monitor."));
      transaction.onabort = () => reject(failure ?? transaction.error ??
        new Error("Se canceló la liberación del lease del monitor."));
    });
  }

  async saveLiveAuthorMonitorCheckpoint(
    checkpoint: StoredLiveAuthorMonitorCheckpoint,
    lease?: StoredLiveAuthorMonitorLease
  ): Promise<void> {
    validateLiveAuthorMonitorCheckpoint(checkpoint);
    if (!lease) {
      throw new Error("Se requiere un lease vigente para guardar checkpoints del monitor.");
    }
    validateLiveAuthorMonitorLease(lease, checkpoint.projectId, checkpoint.documentId);
    const now = Date.now();
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        [LIVE_AUTHOR_MONITOR_LEASES, LIVE_AUTHOR_MONITOR_CHECKPOINTS],
        "readwrite"
      );
      const leaseStore = transaction.objectStore(LIVE_AUTHOR_MONITOR_LEASES);
      const checkpointStore = transaction.objectStore(LIVE_AUTHOR_MONITOR_CHECKPOINTS);
      let failure: Error | undefined;
      const leaseRequest = leaseStore.get([checkpoint.projectId, checkpoint.documentId]);
      leaseRequest.onsuccess = () => {
        const currentLease = leaseRequest.result as StoredLiveAuthorMonitorLease | undefined;
        if (currentLease === undefined) {
          failure = new Error("No existe un lease vigente para guardar el checkpoint del monitor.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
          return;
        }
        try {
          validateLiveAuthorMonitorLease(currentLease, checkpoint.projectId, checkpoint.documentId);
        } catch {
          failure = new Error("El lease vigente del monitor está malformado.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
          return;
        }
        const commitNow = Date.now();
        if (currentLease.ownerId !== lease.ownerId ||
            currentLease.fencingToken !== lease.fencingToken ||
            currentLease.expiresAt <= commitNow ||
            checkpoint.savedAt > currentLease.expiresAt) {
          failure = new Error("El checkpoint fue rechazado porque perdió el fencing token del monitor.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
          return;
        }

        const existingRequest = checkpointStore.get([checkpoint.projectId, checkpoint.documentId]);
        existingRequest.onsuccess = () => {
          const existing = existingRequest.result as StoredLiveAuthorMonitorCheckpoint | undefined;
          if (existing !== undefined) {
            try {
              validateLiveAuthorMonitorCheckpoint(
                existing,
                checkpoint.projectId,
                checkpoint.documentId
              );
            } catch {
              failure = new Error("El checkpoint existente del monitor está malformado.");
              try { transaction.abort(); } catch { /* transacción ya abortada */ }
              return;
            }
            if (existing.savedAt > checkpoint.savedAt) {
              failure = new Error("Se rechazó guardar un checkpoint anterior al ya persistido.");
              try { transaction.abort(); } catch { /* transacción ya abortada */ }
              return;
            }
            if (existing.revision > checkpoint.revision ||
                existing.sequence > checkpoint.sequence) {
              failure = new Error(
                "Se rechazó guardar un checkpoint basado en una revisión o secuencia durable anterior."
              );
              try { transaction.abort(); } catch { /* transacción ya abortada */ }
              return;
            }
            if (existing.sessionId === checkpoint.sessionId) {
              const monotonicMetrics = [
                "sessionDurationMs",
                "activeDurationMs",
                "idleDurationMs",
                "pauseCount",
                "acceptedChanges",
                "rejectedChanges",
                "committedChanges",
                "failedChanges",
                "insertedCharacters",
                "deletedCharacters",
                "resynchronizations",
                "totalCommitLatencyMs"
              ] as const;
              const regressedMetric = monotonicMetrics.find(
                key => checkpoint[key] < existing[key]
              );
              if (regressedMetric) {
                failure = new Error(
                  "Se rechazó un checkpoint de la misma sesión que hace retroceder la métrica " +
                  regressedMetric + "."
                );
                try { transaction.abort(); } catch { /* transacción ya abortada */ }
                return;
              }

              // Los contadores por tipo también son monótonos. En checkpoints
              // v1 históricos sin desglose, todos los cambios anteriores se
              // interpretan como "other"; el total implícito debe conservarse.
              const activityMetricKeys = [
                "typingChanges",
                "pasteChanges",
                "deletionChanges",
                "correctionChanges",
                "undoChanges",
                "redoChanges",
                "otherChanges"
              ] as const;
              const activityMetricValue = (
                candidate: StoredLiveAuthorMonitorCheckpoint,
                key: typeof activityMetricKeys[number]
              ): number => {
                if (key === "otherChanges") {
                  const classifiedTotal =
                    (candidate.typingChanges ?? 0) +
                    (candidate.pasteChanges ?? 0) +
                    (candidate.deletionChanges ?? 0) +
                    (candidate.correctionChanges ?? 0) +
                    (candidate.undoChanges ?? 0) +
                    (candidate.redoChanges ?? 0);
                  return candidate.otherChanges ?? candidate.acceptedChanges - classifiedTotal;
                }
                return candidate[key] ?? 0;
              };
              const regressedActivityMetric = activityMetricKeys.find(
                key => activityMetricValue(checkpoint, key) <
                  activityMetricValue(existing, key)
              );
              if (regressedActivityMetric) {
                failure = new Error(
                  "Se rechazó un checkpoint de la misma sesión que hace retroceder la métrica " +
                  regressedActivityMetric + "."
                );
                try { transaction.abort(); } catch { /* transacción ya abortada */ }
                return;
              }
            }
          }
          try {
            const checkpointWrite = checkpointStore.put(structuredClone(checkpoint));
            checkpointWrite.onerror = () => {
              // Preservamos el error original del request (por ejemplo,
              // QuotaExceededError o DataCloneError) para el diagnóstico del host.
              failure = checkpointWrite.error ??
                new Error("No se pudo persistir el checkpoint del monitor.");
              try { transaction.abort(); } catch { /* transacción ya abortada */ }
            };
          } catch (error) {
            failure = error instanceof Error ? error : new Error("No se pudo clonar el checkpoint.");
            try { transaction.abort(); } catch { /* transacción ya abortada */ }
          }
        };
        existingRequest.onerror = () => {
          failure = existingRequest.error ??
            new Error("No se pudo comprobar el checkpoint anterior.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
        };
      };
      leaseRequest.onerror = () => {
        failure = leaseRequest.error ?? new Error("No se pudo verificar el lease del monitor.");
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error ??
        new Error("No se pudo guardar el checkpoint del monitor."));
      transaction.onabort = () => reject(failure ?? transaction.error ??
        new Error("Se canceló el guardado del checkpoint del monitor."));
    });
  }

  async loadLiveAuthorMonitorCheckpoint(
    projectId: string,
    documentId: string
  ): Promise<StoredLiveAuthorMonitorCheckpoint | undefined> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof documentId !== "string" || !documentId.trim()) {
      throw new Error("Identidad inválida para leer el checkpoint del monitor.");
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(LIVE_AUTHOR_MONITOR_CHECKPOINTS, "readonly");
      const request = transaction.objectStore(LIVE_AUTHOR_MONITOR_CHECKPOINTS)
        .get([projectId, documentId]);
      let result: StoredLiveAuthorMonitorCheckpoint | undefined;
      let validationError: Error | undefined;
      request.onsuccess = () => {
        const checkpoint = request.result as StoredLiveAuthorMonitorCheckpoint | undefined;
        if (checkpoint === undefined) return;
        try {
          validateLiveAuthorMonitorCheckpoint(checkpoint, projectId, documentId);
          result = structuredClone(checkpoint);
        } catch (error) {
          validationError = error instanceof Error ? error :
            new Error("El checkpoint persistido del monitor es inválido.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
        }
      };
      request.onerror = () => {
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => {
        if (validationError) reject(validationError);
        else resolve(result);
      };
      transaction.onerror = () => reject(transaction.error ??
        new Error("No se pudo leer el checkpoint del monitor."));
      transaction.onabort = () => reject(validationError ?? transaction.error ??
        new Error("Se canceló la lectura del checkpoint del monitor."));
    });
  }

  async deleteLiveAuthorMonitorCheckpoint(projectId: string, documentId: string): Promise<void> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof documentId !== "string" || !documentId.trim()) {
      throw new Error("Identidad inválida para eliminar el checkpoint del monitor.");
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(LIVE_AUTHOR_MONITOR_CHECKPOINTS, "readwrite");
      transaction.objectStore(LIVE_AUTHOR_MONITOR_CHECKPOINTS).delete([projectId, documentId]);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ??
        new Error("No se pudo eliminar el checkpoint del monitor."));
      transaction.onabort = () => reject(transaction.error ??
        new Error("Se canceló la eliminación del checkpoint del monitor."));
    });
  }

  /**
   * Limpia checkpoints vencidos de un proyecto sin alterar los registros de lease.
   * Un lease activo o malformado protege su checkpoint: ante duda se conserva.
   */
  async cleanupLiveAuthorMonitorCheckpoints(
    projectId: string,
    olderThan: number,
    now: number
  ): Promise<number> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        !Number.isSafeInteger(olderThan) || olderThan < 0 ||
        !Number.isSafeInteger(now) || now < olderThan) {
      throw new RangeError("El proyecto o los límites temporales de retención no son válidos.");
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [LIVE_AUTHOR_MONITOR_CHECKPOINTS, LIVE_AUTHOR_MONITOR_LEASES],
        "readwrite"
      );
      const checkpoints = transaction.objectStore(LIVE_AUTHOR_MONITOR_CHECKPOINTS);
      const leases = transaction.objectStore(LIVE_AUTHOR_MONITOR_LEASES);
      const cursorRequest = checkpoints.index("by-project").openCursor(projectId);
      let deleted = 0;
      let failure: Error | undefined;

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const checkpoint = cursor.value as StoredLiveAuthorMonitorCheckpoint;
        try {
          validateLiveAuthorMonitorCheckpoint(checkpoint, projectId);
        } catch {
          // Un registro que no puede identificarse con certeza no se elimina automáticamente.
          cursor.continue();
          return;
        }
        if (checkpoint.savedAt >= olderThan) {
          cursor.continue();
          return;
        }

        const leaseRequest = leases.get([projectId, checkpoint.documentId]);
        leaseRequest.onsuccess = () => {
          const lease = leaseRequest.result as StoredLiveAuthorMonitorLease | undefined;
          let protectedByLease = false;
          if (lease !== undefined) {
            try {
              validateLiveAuthorMonitorLease(lease, projectId, checkpoint.documentId);
              protectedByLease = lease.expiresAt > now;
            } catch {
              // Un lease ilegible o inválido no autoriza borrar métricas de ese documento.
              protectedByLease = true;
            }
          }
          if (!protectedByLease) {
            try {
              cursor.delete();
              deleted++;
            } catch (error) {
              failure = error instanceof Error ? error :
                new Error("No se pudo eliminar un checkpoint vencido del monitor.");
              try { transaction.abort(); } catch { /* transacción ya abortada */ }
              return;
            }
          }
          cursor.continue();
        };
        leaseRequest.onerror = () => {
          failure = leaseRequest.error ??
            new Error("No se pudo verificar el lease antes de limpiar un checkpoint.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
        };
      };
      cursorRequest.onerror = () => {
        failure = cursorRequest.error ??
          new Error("No se pudieron recorrer los checkpoints para aplicar retención.");
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => resolve(deleted);
      transaction.onerror = () => reject(failure ?? transaction.error ??
        new Error("No se pudo completar la limpieza de checkpoints."));
      transaction.onabort = () => reject(failure ?? transaction.error ??
        new Error("Se canceló la limpieza de checkpoints."));
    });
  }

  async saveDiagnostics(record: StoredDiagnostics): Promise<void> {
    if (!record || typeof record.projectId !== "string" || !record.projectId.trim() ||
        typeof record.documentId !== "string" || !record.documentId.trim() ||
        !Number.isSafeInteger(record.revision) || record.revision < 0 ||
        !Number.isFinite(record.updatedAt) || record.updatedAt < 0 ||
        !Array.isArray(record.diagnostics)) {
      throw new Error("Registro de diagnósticos inválido.");
    }
    const ids = new Set<string>();
    for (const diagnostic of record.diagnostics) {
      if (!diagnostic || typeof diagnostic.id !== "string" || !diagnostic.id.trim() ||
          ids.has(diagnostic.id) || typeof diagnostic.ruleId !== "string" || !diagnostic.ruleId.trim() ||
          typeof diagnostic.message !== "string" ||
          !["error", "warning", "info"].includes(diagnostic.severity) ||
          !Number.isSafeInteger(diagnostic.start) || !Number.isSafeInteger(diagnostic.end) ||
          diagnostic.start < 0 || diagnostic.end < diagnostic.start ||
          diagnostic.revision !== record.revision ||
          (diagnostic.replacement !== undefined && typeof diagnostic.replacement !== "string")) {
        throw new Error("Diagnóstico malformado o perteneciente a otra revisión.");
      }
      ids.add(diagnostic.id);
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(DIAGNOSTICS, "readwrite");
      const store = transaction.objectStore(DIAGNOSTICS);
      let staleRevision = false;
      const existingRequest = store.get([record.projectId, record.documentId]);
      existingRequest.onsuccess = () => {
        const existing = existingRequest.result as StoredDiagnostics | undefined;
        if (existing && Number.isSafeInteger(existing.revision) &&
            existing.revision > record.revision) {
          staleRevision = true;
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
          return;
        }
        store.put(structuredClone(record));
      };
      existingRequest.onerror = () => {
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudieron guardar los diagnósticos."));
      transaction.onabort = () => reject(staleRevision
        ? new Error("Se rechazó guardar diagnósticos de una revisión anterior.")
        : transaction.error ?? new Error("Se canceló el guardado de diagnósticos."));
    });
  }

  async loadDiagnostics(projectId: string, documentId: string): Promise<StoredDiagnostics | undefined> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof documentId !== "string" || !documentId.trim()) {
      throw new Error("Parámetros inválidos para leer diagnósticos.");
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(DIAGNOSTICS, "readonly");
      const request = transaction.objectStore(DIAGNOSTICS).get([projectId, documentId]);
      let result: StoredDiagnostics | undefined;
      let validationError: Error | undefined;
      request.onsuccess = () => {
        const record = request.result as StoredDiagnostics | undefined;
        if (record === undefined) return;
        try {
          if (!record || record.projectId !== projectId || record.documentId !== documentId ||
              !Number.isSafeInteger(record.revision) || record.revision < 0 ||
              !Number.isFinite(record.updatedAt) || record.updatedAt < 0 ||
              !Array.isArray(record.diagnostics)) {
            throw new Error("Registro de diagnósticos malformado o de otra identidad.");
          }
          const ids = new Set<string>();
          for (const diagnostic of record.diagnostics) {
            if (!diagnostic || typeof diagnostic.id !== "string" || !diagnostic.id.trim() ||
                ids.has(diagnostic.id) || typeof diagnostic.ruleId !== "string" || !diagnostic.ruleId.trim() ||
                typeof diagnostic.message !== "string" ||
                !["error", "warning", "info"].includes(diagnostic.severity) ||
                !Number.isSafeInteger(diagnostic.start) || !Number.isSafeInteger(diagnostic.end) ||
                diagnostic.start < 0 || diagnostic.end < diagnostic.start ||
                diagnostic.revision !== record.revision ||
                (diagnostic.replacement !== undefined && typeof diagnostic.replacement !== "string")) {
              throw new Error("Diagnóstico persistido malformado o de otra revisión.");
            }
            ids.add(diagnostic.id);
          }
          result = record;
        } catch (error) {
          validationError = error instanceof Error ? error : new Error("Diagnósticos persistidos inválidos.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
        }
      };
      request.onerror = () => {
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => {
        if (validationError) reject(validationError);
        else resolve(result ? structuredClone(result) : undefined);
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudieron leer los diagnósticos."));
      transaction.onabort = () => reject(validationError ?? transaction.error ?? new Error("Se canceló la lectura de diagnósticos."));
    });
  }

  async loadDocument(projectId: string, documentId: string): Promise<StoredDocument | undefined> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof documentId !== "string" || !documentId.trim()) {
      throw new Error("Parámetros inválidos para leer el documento.");
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(DOCUMENTS, "readonly");
      const request = transaction.objectStore(DOCUMENTS).get([projectId, documentId]);
      let result: StoredDocument | undefined;
      let validationError: Error | undefined;
      request.onsuccess = () => {
        const stored = request.result as StoredDocument | undefined;
        if (stored !== undefined && (
          !stored || stored.projectId !== projectId || stored.documentId !== documentId ||
          typeof stored.text !== "string" ||
          !Number.isSafeInteger(stored.revision) || stored.revision < 0 ||
          !Number.isSafeInteger(stored.sequence) || stored.sequence < 0 ||
          !Number.isFinite(stored.updatedAt) || stored.updatedAt < 0
        )) {
          validationError = new Error("Snapshot almacenado malformado o perteneciente a otra identidad de documento.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
          return;
        }
        result = stored;
      };
      request.onerror = () => {
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => {
        if (validationError) reject(validationError);
        else resolve(result);
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo leer el documento."));
      transaction.onabort = () => reject(
        validationError ?? transaction.error ?? new Error("Se canceló la lectura consistente del documento.")
      );
    });
  }
  /** Lee la última secuencia confirmada localmente para un proyecto y dispositivo. */
  async loadLastSyncOperationSequence(projectId: string, deviceId: string): Promise<number> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof deviceId !== "string" || !deviceId.trim()) {
      throw new TypeError("Proyecto o dispositivo inválido para leer la secuencia de sincronización.");
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(SYNC_DEVICE_SEQUENCES, "readonly");
      const request = transaction.objectStore(SYNC_DEVICE_SEQUENCES).get([projectId, deviceId]);
      let sequence = 0;
      request.onsuccess = () => {
        const stored = request.result as { readonly lastSequence?: unknown } | undefined;
        if (stored) {
          if (!Number.isSafeInteger(stored.lastSequence) || (stored.lastSequence as number) < 0) {
            try { transaction.abort(); } catch { /* transacción ya abortada */ }
            reject(new Error("El cursor de secuencia del dispositivo está corrupto."));
            return;
          }
          sequence = stored.lastSequence as number;
        }
      };
      request.onerror = () => {
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => resolve(sequence);
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo leer la secuencia del dispositivo."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Se abortó la lectura de secuencia."));
    });
  }

  /** Inserta una operación idempotente y avanza la secuencia en una sola transacción. */
  async enqueueSyncOperation(operation: StoredSyncOperation): Promise<void> {
    const normalized = normalizeSyncOperation(operation);
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([SYNC_OUTBOX, SYNC_DEVICE_SEQUENCES], "readwrite");
      const outbox = transaction.objectStore(SYNC_OUTBOX);
      const sequences = transaction.objectStore(SYNC_DEVICE_SEQUENCES);
      let validationError: Error | undefined;
      const request = outbox.get(normalized.operationId);
      request.onsuccess = () => {
        const existing = request.result as StoredSyncOperation | undefined;
        if (existing) {
          if (syncOperationFingerprint(existing) !== syncOperationFingerprint(normalized)) {
            validationError = new Error("Colisión: operationId ya existe con contenido diferente.");
            try { transaction.abort(); } catch { /* transacción ya abortada */ }
          }
          return;
        }
        const sequenceRequest = sequences.get([normalized.projectId, normalized.deviceId]);
        sequenceRequest.onsuccess = () => {
          const stored = sequenceRequest.result as { readonly lastSequence?: unknown } | undefined;
          const lastSequence = stored?.lastSequence ?? 0;
          if (!Number.isSafeInteger(lastSequence) || (lastSequence as number) < 0) {
            validationError = new Error("El cursor de secuencia del dispositivo está corrupto.");
            try { transaction.abort(); } catch { /* transacción ya abortada */ }
            return;
          }
          const expectedSequence = (lastSequence as number) + 1;
          if (normalized.sequence !== expectedSequence) {
            validationError = new Error(
              "Secuencia fuera de orden: se esperaba " + expectedSequence +
              " y se recibió " + normalized.sequence + "."
            );
            try { transaction.abort(); } catch { /* transacción ya abortada */ }
            return;
          }
          try {
            const addRequest = outbox.add(normalized);
            addRequest.onerror = () => {
              validationError = addRequest.error ?? new Error("No se pudo encolar la operación.");
            };
            sequences.put({
              projectId: normalized.projectId,
              deviceId: normalized.deviceId,
              lastSequence: normalized.sequence
            });
          } catch (error) {
            validationError = error instanceof Error ? error : new Error("No se pudo encolar la operación.");
            try { transaction.abort(); } catch { /* transacción ya abortada */ }
          }
        };
        sequenceRequest.onerror = () => {
          validationError = sequenceRequest.error ?? new Error("No se pudo leer el cursor de secuencia.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
        };
      };
      request.onerror = () => {
        validationError = request.error ?? new Error("No se pudo consultar la operación existente.");
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(validationError ?? transaction.error ?? new Error("Falló la escritura de outbox."));
      transaction.onabort = () => reject(validationError ?? transaction.error ?? new Error("Se abortó la escritura de outbox."));
    });
  }

  /** Recupera pendientes en orden FIFO por dispositivo/secuencia sin retirarlos. */
  async loadPendingSyncOperations(projectId: string, limit = 100): Promise<readonly StoredSyncOperation[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("Proyecto o límite inválido para leer la bandeja de sincronización.");
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(SYNC_OUTBOX, "readonly");
      // El índice compuesto garantiza FIFO por dispositivo, aunque el reloj
      // local retroceda o dos operaciones reciban el mismo createdAt.
      const index = transaction.objectStore(SYNC_OUTBOX).index("by-project-device-sequence");
      const range = IDBKeyRange.bound([projectId], [projectId, []]);
      const request = index.openCursor(range);
      const result: StoredSyncOperation[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || result.length >= limit) return;
        result.push({ ...(cursor.value as StoredSyncOperation) });
        cursor.continue();
      };
      request.onerror = () => {
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo leer la bandeja de sincronización."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Se abortó la lectura de la bandeja."));
    });
  }

  /** Registra un intento sin eliminar ni alterar la identidad del cambio pendiente. */
  async recordSyncOperationAttempt(operationId: string, attemptedAt: number, errorCode?: string): Promise<boolean> {
    if (typeof operationId !== "string" || !operationId.trim() ||
        !Number.isFinite(attemptedAt) || attemptedAt < 0 ||
        (errorCode !== undefined && (typeof errorCode !== "string" || errorCode.length > 160))) {
      throw new TypeError("Metadatos de intento de sincronización inválidos.");
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(SYNC_OUTBOX, "readwrite");
      const store = transaction.objectStore(SYNC_OUTBOX);
      let found = false;
      let validationError: Error | undefined;
      const request = store.get(operationId);
      request.onsuccess = () => {
        const existing = request.result as StoredSyncOperation | undefined;
        if (!existing) return;
        if (!Number.isSafeInteger(existing.attemptCount) ||
            existing.attemptCount < 0 || existing.attemptCount >= Number.MAX_SAFE_INTEGER) {
          validationError = new Error("El contador de intentos de sincronización está fuera de rango.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
          return;
        }
        found = true;
        const updated: StoredSyncOperation = {
          ...existing, attemptCount: existing.attemptCount + 1, lastAttemptAt: attemptedAt,
          ...(errorCode === undefined ? {} : { lastErrorCode: errorCode })
        };
        try { store.put(updated); }
        catch (caught) {
          validationError = caught instanceof Error ? caught : new Error("No se pudo guardar el intento.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
        }
      };
      request.onerror = () => {
        validationError = request.error ?? new Error("No se pudo leer la operación pendiente.");
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => resolve(found);
      transaction.onerror = () => reject(validationError ?? transaction.error ?? new Error("Falló el registro del intento."));
      transaction.onabort = () => reject(validationError ?? transaction.error ?? new Error("Se abortó el registro del intento."));
    });
  }

  /**
   * Retira una operación solo si el acuse remoto coincide con el sobre SHA-256
   * reconstruido desde la outbox. La verificación criptográfica ocurre fuera
   * de la transacción; dentro de la transacción se compara otra vez el registro
   * estable para impedir borrar una versión distinta tras una carrera.
   */
  async acknowledgeSyncOperation(
    acknowledgement: SyncOperationAcknowledgement
  ): Promise<boolean> {
    if (!acknowledgement || typeof acknowledgement !== "object" ||
        (acknowledgement.status !== "accepted" && acknowledgement.status !== "duplicate") ||
        acknowledgement.durable !== true ||
        typeof acknowledgement.projectId !== "string" || !acknowledgement.projectId.trim() ||
        typeof acknowledgement.operationId !== "string" || !acknowledgement.operationId.trim() ||
        typeof acknowledgement.writerId !== "string" || !acknowledgement.writerId.trim() ||
        !Number.isSafeInteger(acknowledgement.sequence) || acknowledgement.sequence < 1 ||
        typeof acknowledgement.digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(acknowledgement.digest)) {
      return false;
    }

    const db = await this.open();
    const snapshotTransaction = db.transaction(SYNC_OUTBOX, "readonly");
    const snapshot = await readAfterTransaction(
      snapshotTransaction,
      snapshotTransaction.objectStore(SYNC_OUTBOX).get(acknowledgement.operationId),
      "No se pudo leer la operación antes de validar el acuse remoto."
    ) as StoredSyncOperation | undefined;
    if (!snapshot) return false;

    const normalizedSnapshot = normalizeSyncOperation(snapshot);
    if (normalizedSnapshot.projectId !== acknowledgement.projectId ||
        normalizedSnapshot.operationId !== acknowledgement.operationId ||
        normalizedSnapshot.deviceId !== acknowledgement.writerId ||
        normalizedSnapshot.sequence !== acknowledgement.sequence) {
      return false;
    }

    const envelope = await createNarrativeSyncOperationEnvelope({
      operationId: normalizedSnapshot.operationId,
      projectId: normalizedSnapshot.projectId,
      writerId: normalizedSnapshot.deviceId,
      sequence: normalizedSnapshot.sequence,
      createdAt: normalizedSnapshot.createdAt,
      kind: normalizedSnapshot.kind,
      payload: JSON.parse(normalizedSnapshot.payload) as unknown
    });
    if (envelope.digest !== acknowledgement.digest) return false;

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(SYNC_OUTBOX, "readwrite");
      const outbox = transaction.objectStore(SYNC_OUTBOX);
      let removed = false;
      let validationError: Error | undefined;
      const request = outbox.get(acknowledgement.operationId);
      request.onsuccess = () => {
        const current = request.result as StoredSyncOperation | undefined;
        if (!current) return;
        try {
          const normalizedCurrent = normalizeSyncOperation(current);
          const sameOperation =
            syncOperationFingerprint(normalizedCurrent) ===
            syncOperationFingerprint(normalizedSnapshot);
          const sameAcknowledgement =
            normalizedCurrent.projectId === acknowledgement.projectId &&
            normalizedCurrent.operationId === acknowledgement.operationId &&
            normalizedCurrent.deviceId === acknowledgement.writerId &&
            normalizedCurrent.sequence === acknowledgement.sequence;
          if (!sameOperation || !sameAcknowledgement) return;
          outbox.delete(acknowledgement.operationId);
          removed = true;
        } catch (error) {
          validationError = error instanceof Error
            ? error
            : new Error("La operación pendiente cambió durante la confirmación.");
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
        }
      };
      request.onerror = () => {
        validationError = request.error ?? new Error("No se pudo revalidar la operación pendiente.");
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
      };
      transaction.oncomplete = () => resolve(removed);
      transaction.onerror = () => reject(validationError ?? transaction.error ?? new Error("No se pudo confirmar la operación."));
      transaction.onabort = () => reject(validationError ?? transaction.error ?? new Error("Se abortó la confirmación de sincronización."));
    });
  }

}
