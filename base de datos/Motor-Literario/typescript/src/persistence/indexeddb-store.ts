import type { ProjectStore, StoredChange, StoredDocument, StoredDiagnostics, StoredProjectFinalizationReceipt, Diagnostic } from "../contracts";
import { normalizeEntityName } from "../narrative-knowledge";
import type { NarrativeEntity, NarrativeRelation, NarrativeEvent, NarrativeIdea, PersonalIdeaLibraryEntry, PersonalIdeaLibraryContext, TextEvidence } from "../narrative-knowledge";
import type { NarrativeAssertion } from "../narrative-history";
import type { ProjectDictionary, DictionaryEntry } from "../dictionaries";
import { validateProjectDictionary, validateDictionaryEntry } from "../dictionaries";
import type { ProjectSetting } from "../project-data";
import { cloneProjectSetting, validateProjectSetting } from "../project-data";

const DATABASE_NAME = "motor-literario-local";
const DATABASE_VERSION = 14;
const DOCUMENTS = "documents";
const CHANGES = "changes";
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
const DIAGNOSTICS = "document-diagnostics";
const DICTIONARIES = "project-dictionaries";
const DICTIONARY_ENTRIES = "dictionary-entries";
const PROJECT_SETTINGS = "project-settings";

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
  if (!["character", "place", "object"].includes(entity.kind) ||
      typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
      typeof entity.normalizedName !== "string" || !entity.normalizedName.trim() ||
      normalizeEntityName(entity.canonicalName) !== entity.normalizedName ||
      !Array.isArray(entity.aliases) ||
      entity.aliases.some(alias => typeof alias !== "string" || !alias.trim()) ||
      (entity.mergedFromIds !== undefined &&
        (!Array.isArray(entity.mergedFromIds) || entity.mergedFromIds.some(id => typeof id !== "string" || !id.trim()))) ||
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
        (!Array.isArray(links) || links.some(id => typeof id !== "string" || !id.trim()) ||
          new Set(links).size !== links.length)) {
      throw new Error(`Registro de ${label} malformado: referencias inválidas o duplicadas.`);
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
          (index === 0 ? change.reason !== "initial" : change.reason === "initial") ||
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
  expectedCurrent?: NarrativeIdea
): Promise<void> {
  const entityIds = idea.relatedEntityIds ?? [];
  const relatedIdeaIds = idea.relatedIdeaIds ?? [];
  if (expectedCurrent && (
    expectedCurrent.projectId !== idea.projectId || expectedCurrent.id !== idea.id
  )) {
    throw new Error("La actualización debe conservar la identidad de la idea original.");
  }
  const stores = entityIds.length > 0 ? [IDEAS, ENTITIES] : [IDEAS];
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(stores, "readwrite");
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
    const existingRequest = expectedCurrent
      ? ideaStore.get([idea.projectId, idea.id])
      : undefined;
    const totalChecks = checks.length + (existingRequest ? 1 : 0);
    if (totalChecks === 0) {
      ideaStore.put(idea);
    } else {
      let remaining = totalChecks;
      const abortWith = (error: unknown): void => {
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
        reject(error);
      };
      const markCheckComplete = (): void => {
        remaining--;
        if (remaining === 0) ideaStore.put(idea);
      };
      if (existingRequest && expectedCurrent) {
        existingRequest.onsuccess = () => {
          const current = existingRequest.result as NarrativeIdea | undefined;
          if (!current || current.projectId !== idea.projectId || current.id !== idea.id) {
            abortWith(new Error(
              "La idea ya no existe en el proyecto; puede haberse archivado o eliminado desde otra instancia."
            ));
            return;
          }
          if (JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
            abortWith(new Error(
              "La idea cambió en otra instancia; actualiza la vista antes de volver a modificarla."
            ));
            return;
          }
          markCheckComplete();
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
    transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar la idea."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Se canceló el guardado de la idea."));
  });
}

async function saveNarrativeRecordWithEntityReferences<T extends { readonly projectId: string }>(
  db: IDBDatabase,
  storeName: string,
  record: T,
  entityIds: readonly string[],
  failureMessage: string
): Promise<void> {
  const requiredIds = [...new Set(entityIds)];
  if (requiredIds.some(id => typeof id !== "string" || !id.trim())) {
    throw new Error("La referencia narrativa contiene identificadores de entidad inválidos.");
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([ENTITIES, storeName], "readwrite");
    let referenceConflict = false;
    const abort = () => {
      try { transaction.abort(); } catch { /* transacción ya abortada */ }
    };
    const request = transaction.objectStore(ENTITIES).index("by-project").getAll(record.projectId);
    request.onsuccess = () => {
      const entities = request.result as NarrativeEntity[];
      if (!Array.isArray(entities)) {
        referenceConflict = true;
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
        referenceConflict = true;
        abort();
        return;
      }
      if (requiredIds.some(id => !available.has(id))) {
        referenceConflict = true;
        abort();
        return;
      }
      transaction.objectStore(storeName).put(record);
    };
    request.onerror = abort;
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(failureMessage));
    transaction.onabort = () => reject(referenceConflict
      ? new Error("Referencia narrativa inválida: una o más entidades no existen en el proyecto.")
      : transaction.error ?? new Error(failureMessage));
  });
}

/**
 * Persistencia local mediante IndexedDB nativo del entorno.
 * No transmite manuscritos ni depende de servicios de terceros.
 */
export class IndexedDbProjectStore implements ProjectStore {
  private database: Promise<IDBDatabase> | undefined;

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

      request.onupgradeneeded = () => {
        // Si onblocked ya rechazó la apertura, el navegador puede reanudar
        // esta migración cuando se cierre la conexión que la bloqueaba.
        // Abortamos antes de tocar el esquema para no modificar la base
        // después de haber informado que la apertura falló.
        if (settled) {
          request.transaction?.abort();
          return;
        }
        const db = request.result;
        if (!db.objectStoreNames.contains(PROJECT_SETTINGS)) {
          const settings = db.createObjectStore(PROJECT_SETTINGS, {
            keyPath: ["projectId", "key"]
          });
          settings.createIndex("by-project", "projectId", { unique: false });
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
        if (!db.objectStoreNames.contains(DIAGNOSTICS)) {
          const diagnostics = db.createObjectStore(DIAGNOSTICS, {
            keyPath: ["projectId", "documentId"]
          });
          diagnostics.createIndex("by-project", "projectId", { unique: false });
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
        ensureIndex(PROJECT_SETTINGS, "by-project", "projectId");
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
        ensureIndex(DIAGNOSTICS, "by-project", "projectId");
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
    expectedCurrent?: DictionaryEntry
  ): Promise<void> {
    validateDictionaryEntry(entry, "entrada de diccionario");
    if (expectedCurrent !== undefined) {
      validateDictionaryEntry(expectedCurrent, "entrada anterior");
      if (expectedCurrent.projectId !== entry.projectId || expectedCurrent.id !== entry.id) {
        throw new Error("La actualización de entrada cambió su identidad.");
      }
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        [DICTIONARIES, DICTIONARY_ENTRIES, ENTITIES], "readwrite"
      );
      const dictionaries = transaction.objectStore(DICTIONARIES);
      const entries = transaction.objectStore(DICTIONARY_ENTRIES);
      const entities = transaction.objectStore(ENTITIES);
      let dictionaryChecked = false;
      let entryChecked = false;
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
        if (finished || !dictionaryChecked || !entryChecked || pendingEntities !== 0) return;
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
    archivedAt: number
  ): Promise<readonly PersonalIdeaLibraryEntry[]> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof writerId !== "string" || !writerId.trim() || writerId.length > 256 ||
        typeof sourceProjectName !== "string" || !sourceProjectName.trim() ||
        !Number.isFinite(archivedAt) || archivedAt < 0) {
      throw new Error("Datos de archivo de ideas inválidos.");
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [IDEAS, PERSONAL_IDEAS, ENTITIES, FINALIZATION_RECEIPTS], "readwrite"
      );
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

  async saveAssertion(assertion: NarrativeAssertion): Promise<void> {
    validateNarrativeAssertionRecord(assertion, "afirmación narrativa");
    const db = await this.open();
    await saveNarrativeRecordWithEntityReferences(
      db, ASSERTIONS, assertion, [assertion.entityId],
      "No se pudo guardar la afirmación narrativa."
    );
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
    await saveNarrativeRecordWithEntityReferences(
      db, EVENTS, event, event.participants,
      "No se pudo guardar el acontecimiento."
    );
  }

  async loadEvents(projectId: string): Promise<readonly NarrativeEvent[]> {
    if (typeof projectId !== "string" || !projectId.trim()) throw new Error("Identificador de proyecto inválido.");
    const db = await this.open();
    const transaction = db.transaction(EVENTS, "readonly");
    const request = transaction.objectStore(EVENTS).index("by-project").getAll(projectId);
    const records = await readAfterTransaction(transaction, request, "No se pudieron leer los acontecimientos.") as NarrativeEvent[];
    const scoped = validateProjectRecords(records, projectId, "acontecimiento");
    for (const event of scoped) validateNarrativeEventRecord(event, "acontecimiento");
    return scoped;
  }

  async saveIdea(idea: NarrativeIdea): Promise<void> {
    validateNarrativeIdeaRecord(idea, "idea narrativa");
    const db = await this.open();
    await saveNarrativeIdeaWithReferences(db, idea);
  }

  /**
   * Actualiza una idea existente solo si sigue presente y coincide con la
   * versión leída por el anfitrión. Impide que una caché antigua la restaure
   * después de que otra instancia la haya archivado o modificado.
   */
  async updateIdeaIfUnchanged(
    idea: NarrativeIdea,
    expectedCurrent: NarrativeIdea
  ): Promise<void> {
    validateNarrativeIdeaRecord(idea, "idea narrativa");
    validateNarrativeIdeaRecord(expectedCurrent, "idea anterior");
    const db = await this.open();
    await saveNarrativeIdeaWithReferences(db, idea, expectedCurrent);
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
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(ENTITIES, "readwrite");
      const store = transaction.objectStore(ENTITIES);
      const request = store.index("by-project").getAll(entity.projectId);
      let requestError: unknown;
      request.onsuccess = () => {
        try {
          const current = request.result as NarrativeEntity[];
          const scoped = validateProjectRecords(current, entity.projectId, "entidad narrativa");
          for (const existing of scoped) {
            validateNarrativeEntityRecord(existing, "entidad narrativa");
          }
          const next = scoped.filter(existing => existing.id !== entity.id);
          next.push(entity);
          // La unicidad de los IDs actuales e históricos se comprueba antes
          // de escribir; dos entidades nunca pueden reclamar la misma identidad.
          validateNarrativeEntityIdentityHistory(next);
          store.put(entity);
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
    writerId?: string
  ): Promise<void> {
    if (typeof projectId !== "string" || !projectId.trim() ||
        typeof targetEntityId !== "string" || !targetEntityId.trim() ||
        typeof sourceEntityId !== "string" || !sourceEntityId.trim() ||
        targetEntityId === sourceEntityId ||
        (writerId !== undefined && (typeof writerId !== "string" || !writerId.trim() || writerId.length > 256))) {
      throw new Error("Identidades de entidad inválidas para consolidación.");
    }
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      // La biblioteca se incluye incluso sin writerId para detectar
      // entradas archivadas que no podríamos mantener coherentes sin identidad.
      const stores = [ENTITIES, RELATIONS, EVENTS, ASSERTIONS, IDEAS, PERSONAL_IDEAS];
      const transaction = db.transaction(stores, "readwrite");
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
          } catch (error) {
            try { transaction.abort(); } catch { /* transacción ya finalizada */ }
            reject(error);
          }
        };
        request.onerror = () => {
          try { transaction.abort(); } catch { /* transacción ya abortada */ }
        };
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo consolidar la identidad narrativa."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Se canceló la consolidación de identidad."));
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
      // El snapshot y el último delta se comprueban en la misma transacción
      // que inserta el nuevo registro. Así dos instancias no pueden crear
      // ramas divergentes con secuencias distintas.
      const transaction = db.transaction([DOCUMENTS, CHANGES], "readwrite");
      const documents = transaction.objectStore(DOCUMENTS);
      const changes = transaction.objectStore(CHANGES);
      let snapshotReady = false;
      let journalReady = false;
      let snapshot: StoredDocument | undefined;
      let expectedSequence = 0;
      let expectedRevision = 0;
      let expectedTextLength = 0;
      let conflict = false;
      const abort = () => {
        try { transaction.abort(); } catch { /* transacción ya abortada */ }
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
        try {
          changes.add(change);
        } catch {
          abort();
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        transaction.error ?? new Error("No se pudo registrar el cambio.")
      );
      transaction.onabort = () => reject(
        conflict
          ? new Error("Conflicto de secuencia o revisión: el documento cambió en otra instancia y requiere resincronización.")
          : transaction.error ?? new Error("Se canceló el registro del cambio.")
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
}
