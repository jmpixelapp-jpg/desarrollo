import type {
  AnalysisResult, ChangeAdmission, CommitResult, DocumentSnapshot, EditorChange,
  EngineOptions, LiveAnalysisMetrics, ProjectIdentity, StoredDiagnostics, Diagnostic
} from "./contracts";
import { LiteraryEngine } from "./engine";
import { proofreadFragment } from "./proofreading";
import { extractNarrativeAssertions, type NarrativeAssertion } from "./narrative-history";
import { extractNarrativeEntities, extractNarrativeRelations, extractNarrativeEvents, extractNarrativeIdeas, detectExplicitStateContradictions, normalizeEntityName, findNarrativeEntityIdentityCandidates, mergeNarrativeEntity, mergeNarrativeRelation, mergeNarrativeEvent, mergeNarrativeIdea, type NarrativeEntity, type NarrativeRelation, type NarrativeEvent, type NarrativeIdea, type NarrativeContradiction, type TextEvidence, type PersonalIdeaLibraryEntry, type PersonalIdeaLibraryContext } from "./narrative-knowledge";

export const MOTOR_LITERARIO_API_VERSION = "0.1.0";
/**
 * Defensa de aislamiento en el límite del adaptador: nunca se incorporan a
 * cachés registros que no pertenezcan exactamente al proyecto solicitado.
 */
function requireProjectScopedRecords<T extends { readonly projectId: string; readonly id: string }>(
  records: readonly T[],
  projectId: string,
  collection: string
): readonly T[] {
  if (!Array.isArray(records)) {
    throw new Error(`El almacenamiento devolvió una colección inválida para ${collection}.`);
  }
  const recordIds = new Set<string>();
  for (const record of records) {
    if (!record || typeof record !== "object" || record.projectId !== projectId) {
      throw new Error(`Violación de aislamiento: ${collection} contiene un registro ajeno al proyecto activo.`);
    }
    if (typeof record.id !== "string" || !record.id.trim() || recordIds.has(record.id)) {
      throw new Error(`Integridad narrativa: ${collection} contiene un identificador vacío o duplicado.`);
    }
    requireNarrativeRecordShape(record, collection);
    recordIds.add(record.id);
  }
  if (collection === "entidades") {
    const identityOwners = new Map<string, string>();
    for (const record of records as unknown as readonly NarrativeEntity[]) {
      const historicalIds = new Set<string>([record.id]);
      for (const historicalId of record.mergedFromIds ?? []) {
        if (historicalIds.has(historicalId)) {
          throw new Error("Integridad narrativa: una entidad repite un ID histórico o reclama su propio ID.");
        }
        historicalIds.add(historicalId);
      }
      for (const identityId of historicalIds) {
        const owner = identityOwners.get(identityId);
        if (owner !== undefined && owner !== record.id) {
          throw new Error("Integridad narrativa: un ID histórico pertenece a más de una entidad.");
        }
        identityOwners.set(identityId, record.id);
      }
    }
  }
  return records;
}

/** Valida la forma de los registros recibidos de cualquier adaptador, no solo IndexedDB. */
function requireNarrativeRecordShape(record: unknown, collection: string): void {
  if (!record || typeof record !== "object") {
    throw new Error(`Integridad narrativa: registro inválido en ${collection}.`);
  }
  const item = record as Record<string, any>;
  const invalid = () => { throw new Error(`Integridad narrativa: registro malformado en ${collection}.`); };
  const validEvidence = (evidence: any): boolean => Array.isArray(evidence) && evidence.every(value =>
    value && typeof value.documentId === "string" && value.documentId.trim() &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) &&
    value.start >= 0 && value.end >= value.start && typeof value.excerpt === "string" &&
    (value.status === undefined || value.status === "stale"));
  if (collection === "entidades") {
    if (!["character", "place", "object"].includes(item.kind) ||
        typeof item.canonicalName !== "string" || !item.canonicalName.trim() ||
        typeof item.normalizedName !== "string" || !item.normalizedName.trim() ||
        normalizeEntityName(item.canonicalName) !== item.normalizedName ||
        !Array.isArray(item.aliases) || item.aliases.some((value: unknown) => typeof value !== "string" || !value.trim()) ||
        (item.mergedFromIds !== undefined && (!Array.isArray(item.mergedFromIds) || item.mergedFromIds.some((value: unknown) => typeof value !== "string" || !value.trim()))) ||
        !Number.isFinite(item.firstSeenAt) || item.firstSeenAt < 0 ||
        !Number.isFinite(item.lastSeenAt) || item.lastSeenAt < item.firstSeenAt ||
        item.extractionVersion !== 1 || !validEvidence(item.evidence)) invalid();
  } else if (collection === "relaciones") {
    if (typeof item.fromEntityId !== "string" || !item.fromEntityId.trim() ||
        typeof item.toEntityId !== "string" || !item.toEntityId.trim() ||
        typeof item.relationType !== "string" || !item.relationType.trim() || !validEvidence(item.evidence)) invalid();
  } else if (collection === "acontecimientos") {
    if (typeof item.label !== "string" || !item.label.trim() || !Array.isArray(item.participants) ||
        item.participants.some((value: unknown) => typeof value !== "string" || !value.trim()) ||
        new Set(item.participants).size !== item.participants.length || !validEvidence(item.evidence)) invalid();
    const time = item.timeReference;
    if (time !== undefined && (!time || !["calendar", "story-day"].includes(time.basis) ||
        !["date", "year", "day-index"].includes(time.precision) || typeof time.raw !== "string" ||
        !time.raw.trim() || !Number.isFinite(time.orderValue) ||
        (time.basis === "story-day" && time.precision !== "day-index") ||
        (time.basis === "calendar" && time.precision === "day-index"))) invalid();
  } else if (collection === "ideas") {
    if (typeof item.text !== "string" || !item.text.trim() ||
        !["IDEA", "incorporated", "discarded"].includes(item.status) ||
        typeof item.originDocumentId !== "string" || !item.originDocumentId.trim() ||
        typeof item.sourceProjectName !== "string" || !item.sourceProjectName.trim() ||
        !validEvidence(item.evidence)) invalid();
    for (const links of [item.relatedEntityIds, item.relatedIdeaIds]) {
      if (links !== undefined && (!Array.isArray(links) ||
          links.some((value: unknown) => typeof value !== "string" || !value.trim()) ||
          new Set(links).size !== links.length)) invalid();
    }
    if (item.relatedIdeaIds?.includes(item.id)) invalid();
    if (item.statusHistory !== undefined) {
      if (!Array.isArray(item.statusHistory) || item.statusHistory.length === 0) invalid();
      let previousChangedAt: number | undefined;
      for (let index = 0; index < item.statusHistory.length; index++) {
        const change = item.statusHistory[index];
        if (!change || !["IDEA", "incorporated", "discarded"].includes(change.status) ||
            !["initial", "writer", "text-revised"].includes(change.reason) ||
            (index === 0 ? change.reason !== "initial" : change.reason === "initial") ||
            (change.changedAt !== undefined && (!Number.isFinite(change.changedAt) || change.changedAt < 0)) ||
            (change.changedAt !== undefined && previousChangedAt !== undefined && change.changedAt < previousChangedAt)) invalid();
        if (change.changedAt !== undefined) previousChangedAt = change.changedAt;
      }
      if (item.statusHistory[item.statusHistory.length - 1]?.status !== item.status) invalid();
    }
  } else if (collection === "afirmaciones") {
    if (typeof item.entityId !== "string" || !item.entityId.trim() ||
        typeof item.entityName !== "string" || !item.entityName.trim() ||
        !["age", "location", "role"].includes(item.attribute) ||
        (item.attribute === "age" ? typeof item.value !== "number" || !Number.isFinite(item.value) || item.value < 0
          : typeof item.value !== "string" || !item.value.trim()) ||
        !Number.isFinite(item.capturedAt) || item.capturedAt < 0 || !validEvidence([item.evidence])) invalid();
    const time = item.timeReference;
    if (time !== undefined && (!time || !["calendar", "story-day"].includes(time.basis) ||
        !["date", "year", "day-index"].includes(time.precision) || typeof time.raw !== "string" ||
        !time.raw.trim() || !Number.isFinite(time.orderValue) ||
        (time.basis === "story-day" && time.precision !== "day-index") ||
        (time.basis === "calendar" && time.precision === "day-index"))) invalid();
  }
}

function requireNarrativeEntityReferences<T extends { readonly projectId: string; readonly id: string }>(
  records: readonly T[],
  projectId: string,
  entities: readonly NarrativeEntity[],
  getEntityIds: (record: T) => readonly string[],
  collection: string
): readonly T[] {
  const scoped = requireProjectScopedRecords(records, projectId, collection);
  const entityIds = new Set(entities.map(entity => entity.id));
  for (const record of scoped) {
    const references = getEntityIds(record);
    if (!Array.isArray(references) ||
        references.some(id => typeof id !== "string" || !entityIds.has(id))) {
      throw new Error(`Integridad narrativa: ${collection} contiene referencias a entidades inexistentes en el proyecto activo.`);
    }
  }
  return scoped;
}


function requireUniquePersonalIdeaEntries(
  entries: unknown,
  writerId: string,
  sourceProjectId?: string
): readonly PersonalIdeaLibraryEntry[] {
  if (!Array.isArray(entries)) {
    throw new Error("Violación de aislamiento: la biblioteca devolvió una colección inválida.");
  }
  const typedEntries = entries as PersonalIdeaLibraryEntry[];
  const identities = new Set<string>();
  for (const entry of typedEntries) {
    if (!isValidPersonalIdeaEntry(entry, writerId, sourceProjectId)) {
      throw new Error("Violación de aislamiento: la biblioteca devolvió ideas de otro escritor o proyecto.");
    }
    const identity = JSON.stringify([entry.sourceProjectId, entry.idea.id]);
    if (identities.has(identity)) {
      throw new Error("Integridad de biblioteca: hay ideas archivadas duplicadas para el mismo libro.");
    }
    identities.add(identity);
  }
  const archivedIdeaIds = new Set(typedEntries.map(entry =>
    JSON.stringify([entry.sourceProjectId, entry.idea.id])
  ));
  for (const entry of typedEntries) {
    if (!entry.context) continue; // Entradas previas a la versión 1: lectura compatible.
    const contextIdeaIds = new Set(entry.context.relatedIdeas.map(idea => idea.id));
    const contextEntityIds = new Set(entry.context.relatedEntities.map(entity => entity.id));
    if ([...contextIdeaIds].some(id =>
      archivedIdeaIds.has(JSON.stringify([entry.sourceProjectId, id]))
    )) {
      throw new Error("Integridad de biblioteca: una idea contextual duplica un nodo archivado con el mismo ID.");
    }
    for (const related of [entry.idea, ...entry.context.relatedIdeas]) {
      if ((related.relatedEntityIds ?? []).some(id => !contextEntityIds.has(id)) ||
          (related.relatedIdeaIds ?? []).some(id =>
            !contextIdeaIds.has(id) &&
            !archivedIdeaIds.has(JSON.stringify([entry.sourceProjectId, id]))
          )) {
        throw new Error("Integridad de biblioteca: una idea archivada conserva referencias sin contexto resoluble.");
      }
    }
  }
  return entries;
}

function isValidPersonalIdeaContext(
  value: unknown,
  sourceProjectId: string,
  sourceProjectName: string,
  rootIdeaId: string
): value is PersonalIdeaLibraryContext {
  if (!value || typeof value !== "object") return false;
  const context = value as Partial<PersonalIdeaLibraryContext>;
  if (context.version !== 1 || !Array.isArray(context.relatedIdeas) ||
      !Array.isArray(context.relatedEntities)) return false;

  const ideaIds = new Set<string>();
  for (const idea of context.relatedIdeas) {
    if (!idea || idea.projectId !== sourceProjectId ||
        typeof idea.id !== "string" || !idea.id.trim() || idea.id === rootIdeaId ||
        idea.status === "IDEA" ||
        typeof idea.text !== "string" || !idea.text.trim() ||
        typeof idea.originDocumentId !== "string" || !idea.originDocumentId.trim() ||
        idea.sourceProjectName !== sourceProjectName || !Array.isArray(idea.evidence) ||
        !["incorporated", "discarded"].includes(idea.status)) return false;
    if (ideaIds.has(idea.id)) return false;
    ideaIds.add(idea.id);
    for (const evidence of idea.evidence) {
      if (!evidence || typeof evidence.documentId !== "string" || !evidence.documentId.trim() ||
          !Number.isSafeInteger(evidence.revision) || evidence.revision < 0 ||
          !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) ||
          evidence.start < 0 || evidence.end < evidence.start ||
          typeof evidence.excerpt !== "string" ||
          (evidence.status !== undefined && evidence.status !== "stale")) return false;
    }
    for (const references of [idea.relatedEntityIds, idea.relatedIdeaIds]) {
      if (references !== undefined &&
          (!Array.isArray(references) ||
            references.some(id => typeof id !== "string" || !id.trim()) ||
            new Set(references).size !== references.length)) return false;
    }
    if (idea.relatedIdeaIds?.includes(idea.id)) return false;
    if (idea.statusHistory !== undefined) {
      if (!Array.isArray(idea.statusHistory) || idea.statusHistory.length === 0) return false;
      let previousChangedAt: number | undefined;
      for (let index = 0; index < idea.statusHistory.length; index++) {
        const change = idea.statusHistory[index];
        if (!change ||
            !["IDEA", "incorporated", "discarded"].includes(change.status) ||
            !["initial", "writer", "text-revised"].includes(change.reason) ||
            (index === 0 ? change.reason !== "initial" : change.reason === "initial") ||
            (change.changedAt !== undefined &&
              (!Number.isFinite(change.changedAt) || change.changedAt < 0)) ||
            (change.changedAt !== undefined && previousChangedAt !== undefined &&
              change.changedAt < previousChangedAt)) return false;
        if (change.changedAt !== undefined) previousChangedAt = change.changedAt;
      }
      if (idea.statusHistory[idea.statusHistory.length - 1]?.status !== idea.status) return false;
    }
  }

  const entityIds = new Set<string>();
  const identityOwners = new Map<string, string>();
  for (const entity of context.relatedEntities) {
    if (!entity || entity.projectId !== sourceProjectId ||
        typeof entity.id !== "string" || !entity.id.trim() ||
        !["character", "place", "object"].includes(entity.kind) ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        typeof entity.normalizedName !== "string" || !entity.normalizedName.trim() ||
        normalizeEntityName(entity.canonicalName) !== entity.normalizedName ||
        !Array.isArray(entity.aliases) ||
        entity.aliases.some((alias: unknown) => typeof alias !== "string" || !alias.trim()) ||
        (entity.mergedFromIds !== undefined &&
          (!Array.isArray(entity.mergedFromIds) ||
            entity.mergedFromIds.some((id: unknown) => typeof id !== "string" || !id.trim()))) ||
        !Number.isFinite(entity.firstSeenAt) || entity.firstSeenAt < 0 ||
        !Number.isFinite(entity.lastSeenAt) || entity.lastSeenAt < entity.firstSeenAt ||
        entity.extractionVersion !== 1 || !Array.isArray(entity.evidence)) return false;
    if (entityIds.has(entity.id)) return false;
    entityIds.add(entity.id);

    // Un ID absorbido debe pertenecer a una sola ficha canónica dentro del snapshot.
    const identities = new Set<string>([entity.id]);
    for (const historicalId of entity.mergedFromIds ?? []) {
      if (identities.has(historicalId)) return false;
      identities.add(historicalId);
    }
    for (const identity of identities) {
      const owner = identityOwners.get(identity);
      if (owner !== undefined && owner !== entity.id) return false;
      identityOwners.set(identity, entity.id);
    }

    for (const evidence of entity.evidence) {
      if (!evidence || typeof evidence.documentId !== "string" || !evidence.documentId.trim() ||
          !Number.isSafeInteger(evidence.revision) || evidence.revision < 0 ||
          !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) ||
          evidence.start < 0 || evidence.end < evidence.start ||
          typeof evidence.excerpt !== "string" ||
          (evidence.status !== undefined && evidence.status !== "stale")) return false;
    }
  }
  for (const idea of context.relatedIdeas) {
    if ((idea.relatedEntityIds ?? []).some((id: string) => !entityIds.has(id))) return false;
  }
  return true;
}

function isValidPersonalIdeaEntry(
  value: unknown,
  writerId: string,
  sourceProjectId?: string
): value is PersonalIdeaLibraryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PersonalIdeaLibraryEntry>;
  const idea = entry.idea;
  if (entry.writerId !== writerId ||
      typeof entry.sourceProjectId !== "string" || !entry.sourceProjectId.trim() ||
      (sourceProjectId !== undefined && entry.sourceProjectId !== sourceProjectId) ||
      typeof entry.sourceProjectName !== "string" || !entry.sourceProjectName.trim() ||
      entry.category !== entry.sourceProjectName ||
      !Number.isFinite(entry.archivedAt) || (entry.archivedAt ?? -1) < 0 ||
      !idea || typeof idea !== "object" ||
      idea.projectId !== entry.sourceProjectId ||
      typeof idea.id !== "string" || !idea.id.trim() ||
      typeof idea.text !== "string" || !idea.text.trim() ||
      idea.status !== "IDEA" ||
      typeof idea.originDocumentId !== "string" || !idea.originDocumentId.trim() ||
      idea.sourceProjectName !== entry.sourceProjectName ||
      !Array.isArray(idea.evidence)) return false;

  for (const evidence of idea.evidence) {
    if (!evidence || typeof evidence.documentId !== "string" || !evidence.documentId.trim() ||
        !Number.isSafeInteger(evidence.revision) || evidence.revision < 0 ||
        !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) ||
        evidence.start < 0 || evidence.end < evidence.start ||
        typeof evidence.excerpt !== "string" ||
        (evidence.status !== undefined && evidence.status !== "stale")) return false;
  }
  for (const references of [idea.relatedEntityIds, idea.relatedIdeaIds]) {
    if (references !== undefined &&
        (!Array.isArray(references) || references.some(id => typeof id !== "string" || !id.trim()) ||
          new Set(references).size !== references.length)) {
      return false;
    }
  }
  if (idea.relatedIdeaIds?.includes(idea.id)) return false;
  if ((entry.context === undefined && entry.contextStatus !== undefined &&
        entry.contextStatus !== "missing-legacy-context") ||
      (entry.context !== undefined && entry.contextStatus !== undefined) ||
      (entry.context !== undefined &&
        !isValidPersonalIdeaContext(entry.context, entry.sourceProjectId, entry.sourceProjectName, idea.id))) {
    return false;
  }
  if (idea.statusHistory !== undefined) {
    if (!Array.isArray(idea.statusHistory) || idea.statusHistory.length === 0) return false;
    let previousChangedAt: number | undefined;
    for (let index = 0; index < idea.statusHistory.length; index++) {
      const change = idea.statusHistory[index];
      if (!change ||
          !["IDEA", "incorporated", "discarded"].includes(change.status) ||
          (change.changedAt !== undefined && (!Number.isFinite(change.changedAt) || change.changedAt < 0)) ||
          !["initial", "writer", "text-revised"].includes(change.reason) ||
          (index === 0 ? change.reason !== "initial" : change.reason === "initial") ||
          (change.changedAt !== undefined && previousChangedAt !== undefined &&
            change.changedAt < previousChangedAt)) return false;
      if (change.changedAt !== undefined) previousChangedAt = change.changedAt;
    }
    if (idea.statusHistory[idea.statusHistory.length - 1]?.status !== idea.status) return false;
  }
  return true;
}


function buildDocumentEvidenceIndex<T extends { readonly id: string }>(
  records: Iterable<T>,
  getEvidence: (record: T) => readonly TextEvidence[]
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const record of records) addDocumentEvidenceIndex(index, record.id, getEvidence(record));
  return index;
}

function addDocumentEvidenceIndex(
  index: Map<string, Set<string>> | undefined,
  recordId: string,
  evidence: readonly TextEvidence[]
): void {
  if (!index) return;
  for (const item of evidence) {
    const ids = index.get(item.documentId) ?? new Set<string>();
    ids.add(recordId);
    index.set(item.documentId, ids);
  }
}

function buildDocumentLineIndex<T extends { readonly id: string }>(
  records: Iterable<T>,
  getText: (record: T) => string,
  getEvidence: (record: T) => readonly TextEvidence[]
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const record of records) {
    for (const evidence of getEvidence(record)) {
      const lineStart = evidence.start - Math.max(0, evidence.excerpt.indexOf(getText(record)));
      const key = `${evidence.documentId}\u0000${lineStart}`;
      const ids = index.get(key) ?? new Set<string>();
      ids.add(record.id);
      index.set(key, ids);
    }
  }
  return index;
}

/**
 * Recupera la identidad de una línea desplazada antes de persistir su nuevo
 * offset. Solo compara documento y línea exacta; evita fusionar duplicados.
 */
function findDocumentLineRecordByExcerpt<T extends { readonly id: string }>(
  records: Iterable<T>,
  getEvidence: (record: T) => readonly TextEvidence[],
  documentId: string,
  excerpt: string,
  lineStart: number,
  excludedIds: ReadonlySet<string>
): T | undefined {
  const candidates: { readonly record: T; readonly distance: number }[] = [];
  for (const record of records) {
    if (excludedIds.has(record.id)) continue;
    for (const evidence of getEvidence(record)) {
      if (evidence.documentId !== documentId || evidence.excerpt !== excerpt) continue;
      candidates.push({ record, distance: Math.abs(evidence.start - lineStart) });
    }
  }
  candidates.sort((left, right) => left.distance - right.distance);
  return candidates[0]?.record;
}

function findDocumentLineRecord<T extends { readonly id: string }>(
  index: Map<string, Set<string>>,
  records: ReadonlyMap<string, T>,
  documentId: string,
  lineStart: number,
  excludedIds: ReadonlySet<string> = new Set()
): T | undefined {
  const ids = index.get(`${documentId}\\u0000${lineStart}`);
  if (!ids) return undefined;
  for (const id of ids) {
    if (excludedIds.has(id)) continue;
    const record = records.get(id);
    if (record) return record;
  }
  return undefined;
}

function updateDocumentLineIndex(
  index: Map<string, Set<string>> | undefined,
  recordId: string,
  text: string,
  previous: readonly TextEvidence[],
  next: readonly TextEvidence[]
): void {
  if (!index) return;
  const lineKey = (evidence: TextEvidence) =>
    `${evidence.documentId}\u0000${evidence.start - Math.max(0, evidence.excerpt.indexOf(text))}`;
  const nextKeys = new Set(next.map(lineKey));
  for (const evidence of previous) {
    const key = lineKey(evidence);
    if (nextKeys.has(key)) continue;
    const ids = index.get(key);
    ids?.delete(recordId);
    if (ids?.size === 0) index.delete(key);
  }
  for (const evidence of next) {
    const key = lineKey(evidence);
    const ids = index.get(key) ?? new Set<string>();
    ids.add(recordId);
    index.set(key, ids);
  }
}

function cloneNarrativeRecords<T>(records: readonly T[]): readonly T[] {
  // Los registros narrativos son datos planos persistibles; el clon evita que
  // el anfitrión pueda mutar arrays/objetos anidados de las cachés internas.
  return structuredClone(records);
}

function cloneNarrativeRecord<T>(record: T): T {
  return structuredClone(record);
}

function percentile(values: Float64Array, sampleCount: number, fraction: number): number {
  if (sampleCount <= 0) return 0;
  const sorted = Array.from(values.subarray(0, sampleCount))
    .sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function entityNameIndexKey(kind: NarrativeEntity["kind"], name: string): string {
  return `${kind}:${normalizeEntityName(name)}`;
}

function buildEntityNameIndex(entities: Iterable<NarrativeEntity>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const entity of entities) addEntityNameIndex(index, entity);
  return index;
}

function addEntityNameIndex(
  index: Map<string, Set<string>> | undefined,
  entity: NarrativeEntity
): void {
  if (!index) return;
  for (const name of [entity.canonicalName, ...entity.aliases]) {
    const key = entityNameIndexKey(entity.kind, name);
    const ids = index.get(key) ?? new Set<string>();
    ids.add(entity.id);
    index.set(key, ids);
  }
}

export interface HostCallbacks {
  readonly onAnalysis?: (result: AnalysisResult) => void;
  readonly onCommit?: (result: CommitResult) => void;
  readonly onKnowledgeError?: (error: unknown) => void;
}

export interface HostEngineOptions extends Omit<EngineOptions, "onAnalysis" | "onCommit"> {
  readonly callbacks?: HostCallbacks;
}

/**
 * Fachada estable para la aplicación anfitriona.
 * La aplicación crea proyectos/documentos y entrega sus snapshots y cambios.
 */
export class HostEngineApi {
  private readonly engine: LiteraryEngine;
  private project?: ProjectIdentity;
  private readonly store: HostEngineOptions["store"];
  private readonly onKnowledgeError: HostCallbacks["onKnowledgeError"];
  private readonly onAnalysis: HostCallbacks["onAnalysis"];
  private knowledgeTail: Promise<void> = Promise.resolve();
  private liveAnalysisTail: Promise<void> = Promise.resolve();
  private diagnosticsRecoveryTail: Promise<void> = Promise.resolve();
  private diagnosticsPersistenceTail: Promise<void> = Promise.resolve();
  private readonly documentDiagnostics = new Map<string, StoredDiagnostics>();
  private readonly liveSubmissionTimes = new Map<string, number>();
  private readonly liveMetrics = {
    completedAnalyses: 0,
    failedAnalyses: 0,
    pendingAnalyses: 0,
    totalKnowledgeMs: 0,
    maxKnowledgeMs: 0,
    totalAnalysisQueueWaitMs: 0,
    maxAnalysisQueueWaitMs: 0,
    totalAnalysisExecutionMs: 0,
    maxAnalysisExecutionMs: 0,
    endToEndSamples: 0,
    totalEndToEndMs: 0,
    maxEndToEndMs: 0
  };
  /** Buffer circular: inserción O(1), sin shift ni crecimiento de memoria. */
  private static readonly END_TO_END_SAMPLE_WINDOW = 512;
  private readonly endToEndRecentSamples = new Float64Array(HostEngineApi.END_TO_END_SAMPLE_WINDOW);
  private endToEndSampleCount = 0;
  private endToEndSampleCursor = 0;
  private readonly narrativeEntities = new Map<string, NarrativeEntity>();
  private readonly narrativeRelations = new Map<string, NarrativeRelation>();
  private readonly narrativeEvents = new Map<string, NarrativeEvent>();
  private readonly narrativeIdeas = new Map<string, NarrativeIdea>();
  private readonly narrativeAssertions = new Map<string, NarrativeAssertion>();
  private entitiesLoaded = false;
  private relationsLoaded = false;
  private eventsLoaded = false;
  private ideasLoaded = false;
  private assertionsLoaded = false;
  private entityEvidenceIndex: Map<string, Set<string>> | undefined;
  private relationEvidenceIndex: Map<string, Set<string>> | undefined;
  private eventEvidenceIndex: Map<string, Set<string>> | undefined;
  private ideaEvidenceIndex: Map<string, Set<string>> | undefined;
  private assertionEvidenceIndex: Map<string, Set<string>> | undefined;
  private eventLineIndex: Map<string, Set<string>> | undefined;
  private ideaLineIndex: Map<string, Set<string>> | undefined;
  private entityNameIndex: Map<string, Set<string>> | undefined;

  constructor(options: HostEngineOptions) {
    this.store = options.store;
    this.onKnowledgeError = options.callbacks?.onKnowledgeError;
    this.onAnalysis = options.callbacks?.onAnalysis;
    this.engine = new LiteraryEngine({
      store: options.store,
      ...(options.queueCapacity === undefined ? {} : { queueCapacity: options.queueCapacity }),
      ...(options.maxConcurrentDocuments === undefined
        ? {} : { maxConcurrentDocuments: options.maxConcurrentDocuments }),
      ...(options.maxQueuedTextUnits === undefined
        ? {} : { maxQueuedTextUnits: options.maxQueuedTextUnits }),
      onAnalysis: result => {
        try { options.callbacks?.onAnalysis?.(result); } catch { /* La UI no debe detener el análisis. */ }
        void this.persistLiveDiagnostics(result).catch(error => this.reportKnowledgeError(error));
        if (this.store.saveEntity && this.store.loadEntities) {
          void this.processLiveAnalysis(result).catch(error => {
            this.reportKnowledgeError(error);
          });
        }
      },
      onCommit: result => {
        this.liveSubmissionTimes.delete(result.ticketId);
        try { options.callbacks?.onCommit?.(result); } catch { /* El callback del anfitrión no debe detener la cola. */ }
      }
    });
  }


  private persistLiveDiagnostics(result: AnalysisResult): Promise<void> {
    const work = this.diagnosticsPersistenceTail.then(async () => {
      let previous = this.documentDiagnostics.get(result.documentId);
      if (!previous || previous.revision !== result.revision - 1) {
        // Si falta una revisión intermedia en caché, se reconstruye desde el
        // snapshot vigente en vez de descartar diagnósticos de líneas intactas.
        const snapshot = this.engine.getSnapshot(result.documentId);
        if (!snapshot || snapshot.revision !== result.revision) {
          throw new Error("No se pueden reconciliar diagnósticos sin el snapshot de la revisión analizada.");
        }
        await this.restoreDocumentDiagnostics(snapshot);
        return;
      }

      const delta = result.replacementLength - (result.changeEnd - result.changeStart);
      const retained = previous.diagnostics
        .filter(diagnostic => {
          const insertedWholeLinesBeforeDiagnostic =
            result.changeStart === result.changeEnd &&
            result.changeStart === result.previousAffectedStart &&
            result.changeReplacement.length > 0 &&
            (result.changeReplacement.endsWith("\n") || result.changeReplacement.endsWith("\r"));
          const lineWasAffected = !insertedWholeLinesBeforeDiagnostic && (
            (diagnostic.start < result.previousAffectedEnd &&
              diagnostic.end > result.previousAffectedStart) ||
            (diagnostic.start >= result.previousAffectedStart &&
              diagnostic.start <= result.previousAffectedEnd)
          );
          return !lineWasAffected;
        })
        .map(diagnostic => {
          const shift = diagnostic.start >= result.changeEnd ? delta : 0;
          const start = diagnostic.start + shift;
          const end = diagnostic.end + shift;
          return {
            ...diagnostic,
            id: `${diagnostic.ruleId}:${result.revision}:${start}`,
            start,
            end,
            revision: result.revision
          };
        });
      const byId = new Map<string, Diagnostic>();
      for (const diagnostic of [...retained, ...result.diagnostics]) {
        byId.set(diagnostic.id, diagnostic);
      }
      const diagnostics = [...byId.values()]
        .sort((left, right) => left.start - right.start || left.end - right.end)
        .slice(0, 1024);
      const record: StoredDiagnostics = {
        projectId: result.projectId,
        documentId: result.documentId,
        revision: result.revision,
        diagnostics,
        updatedAt: Date.now()
      };
      await this.store.saveDiagnostics?.(record);
      this.documentDiagnostics.set(result.documentId, record);
    });
    this.diagnosticsPersistenceTail = work.then(() => undefined, () => undefined);
    return work;
  }

  /**
   * Mantiene coherentes las evidencias persistidas antes de analizar el nuevo
   * fragmento. Las líneas tocadas pasan a histórico; las posteriores se
   * desplazan por el delta UTF-16 sin releer el manuscrito completo.
   */
  private async processLiveAnalysis(result: AnalysisResult): Promise<void> {
    const startedAt = performance.now();
    const submittedAt = this.liveSubmissionTimes.get(result.ticketId);
    this.liveSubmissionTimes.delete(result.ticketId);
    this.liveMetrics.pendingAnalyses++;
    // Mantiene el orden de las revisiones incluso si el worker entrega el
    // siguiente callback mientras la persistencia narrativa anterior sigue activa.
    const work = this.liveAnalysisTail.then(async () => {
      const executionStartedAt = performance.now();
      const analysisQueueWaitMs = Math.max(0, executionStartedAt - startedAt);
      this.liveMetrics.totalAnalysisQueueWaitMs += analysisQueueWaitMs;
      this.liveMetrics.maxAnalysisQueueWaitMs = Math.max(
        this.liveMetrics.maxAnalysisQueueWaitMs, analysisQueueWaitMs
      );
      try {
        await this.reconcileNarrativeEvidence(result);
        await this.extractNarrativeKnowledge(
          result.documentId, result.revision, result.affectedText, result.affectedStart
        );
      } finally {
        const analysisExecutionMs = Math.max(0, performance.now() - executionStartedAt);
        this.liveMetrics.totalAnalysisExecutionMs += analysisExecutionMs;
        this.liveMetrics.maxAnalysisExecutionMs = Math.max(
          this.liveMetrics.maxAnalysisExecutionMs, analysisExecutionMs
        );
      }
    });
    this.liveAnalysisTail = work.then(() => undefined, () => undefined);
    try {
      await work;
      this.liveMetrics.completedAnalyses++;
    } catch (error) {
      this.liveMetrics.failedAnalyses++;
      throw error;
    } finally {
      this.liveMetrics.pendingAnalyses--;
      const elapsed = Math.max(0, performance.now() - startedAt);
      this.liveMetrics.totalKnowledgeMs += elapsed;
      this.liveMetrics.maxKnowledgeMs = Math.max(this.liveMetrics.maxKnowledgeMs, elapsed);
      if (submittedAt !== undefined) {
        const endToEndMs = Math.max(0, performance.now() - submittedAt);
        this.liveMetrics.endToEndSamples++;
        this.liveMetrics.totalEndToEndMs += endToEndMs;
        this.liveMetrics.maxEndToEndMs = Math.max(this.liveMetrics.maxEndToEndMs, endToEndMs);
        this.endToEndRecentSamples[this.endToEndSampleCursor] = endToEndMs;
        this.endToEndSampleCursor =
          (this.endToEndSampleCursor + 1) % HostEngineApi.END_TO_END_SAMPLE_WINDOW;
        this.endToEndSampleCount = Math.min(
          HostEngineApi.END_TO_END_SAMPLE_WINDOW, this.endToEndSampleCount + 1
        );
      }
    }
  }

  private async reconcileNarrativeEvidence(result: AnalysisResult): Promise<void> {
    const project = this.requireProject();
    const work = this.knowledgeTail.then(async () => {
      const delta = result.replacementLength - (result.changeEnd - result.changeStart);
      const rebase = (evidence: TextEvidence): TextEvidence => {
        if (evidence.documentId !== result.documentId || evidence.status === "stale") return evidence;
        // Insertar un párrafo completo al inicio de una línea no cambia el
        // contenido ni la identidad de la línea original: solo desplaza sus offsets.
        const insertedWholeLinesBeforeEvidence =
          result.changeStart === result.changeEnd &&
          result.changeStart === result.previousAffectedStart &&
          evidence.start >= result.changeStart &&
          result.changeReplacement.length > 0 &&
          (result.changeReplacement.endsWith("\n") || result.changeReplacement.endsWith("\r"));
        const lineWasAffected = !insertedWholeLinesBeforeEvidence && (
          (evidence.start < result.previousAffectedEnd && evidence.end > result.previousAffectedStart) ||
          (evidence.start >= result.previousAffectedStart && evidence.start <= result.previousAffectedEnd)
        );
        if (lineWasAffected) return { ...evidence, status: "stale" };
        if (evidence.start >= result.changeEnd) {
          return {
            ...evidence,
            revision: result.revision,
            start: evidence.start + delta,
            end: evidence.end + delta
          };
        }
        return evidence;
      };
      const mapEvidence = (items: readonly TextEvidence[]) => items.map(rebase);

      if (this.store.saveEntity && this.store.loadEntities) {
        if (!this.entitiesLoaded) {
          const records = requireProjectScopedRecords(await this.store.loadEntities(project.projectId), project.projectId, "entidades");
          for (const item of records) this.narrativeEntities.set(item.id, item);
          this.entitiesLoaded = true;
        }
        this.entityEvidenceIndex ??= buildDocumentEvidenceIndex(this.narrativeEntities.values(), item => item.evidence);
        for (const id of this.entityEvidenceIndex.get(result.documentId) ?? []) {
          const item = this.narrativeEntities.get(id);
          if (!item) continue;
          const evidence = mapEvidence(item.evidence);
          if (evidence.some((entry, index) => entry !== item.evidence[index])) {
            const updated = { ...item, evidence };
            await this.store.saveEntity(updated);
            this.narrativeEntities.set(id, updated);
          }
        }
      }
      if (this.store.saveRelation && this.store.loadRelations) {
        const store = this.requireRelationStore();
        if (!this.relationsLoaded) {
          const records = requireProjectScopedRecords(await store.loadRelations(project.projectId), project.projectId, "relaciones");
          for (const item of records) this.narrativeRelations.set(item.id, item);
          this.relationsLoaded = true;
        }
        this.relationEvidenceIndex ??= buildDocumentEvidenceIndex(this.narrativeRelations.values(), item => item.evidence);
        for (const id of this.relationEvidenceIndex.get(result.documentId) ?? []) {
          const item = this.narrativeRelations.get(id);
          if (!item) continue;
          const evidence = mapEvidence(item.evidence);
          if (evidence.some((entry, index) => entry !== item.evidence[index])) {
            const updated = { ...item, evidence };
            await store.saveRelation(updated);
            this.narrativeRelations.set(id, updated);
          }
        }
      }
      if (this.store.saveEvent && this.store.loadEvents) {
        const store = this.requireEventStore();
        if (!this.eventsLoaded) {
          const records = requireProjectScopedRecords(await store.loadEvents(project.projectId), project.projectId, "acontecimientos");
          for (const item of records) this.narrativeEvents.set(item.id, item);
          this.eventsLoaded = true;
        }
        this.eventEvidenceIndex ??= buildDocumentEvidenceIndex(this.narrativeEvents.values(), item => item.evidence);
        for (const id of this.eventEvidenceIndex.get(result.documentId) ?? []) {
          const item = this.narrativeEvents.get(id);
          if (!item) continue;
          const evidence = mapEvidence(item.evidence);
          if (evidence.some((entry, index) => entry !== item.evidence[index])) {
            const updated = { ...item, evidence };
            await store.saveEvent(updated);
            this.narrativeEvents.set(id, updated);
            updateDocumentLineIndex(this.eventLineIndex, id, item.label, item.evidence, evidence);
          }
        }
      }
      if (this.store.saveIdea && this.store.loadIdeas && this.store.updateIdeaIfUnchanged) {
        const store = this.requireIdeaStore();
        if (!this.ideasLoaded) {
          const records = requireProjectScopedRecords(await store.loadIdeas(project.projectId), project.projectId, "ideas");
          for (const item of records) this.narrativeIdeas.set(item.id, item);
          this.ideasLoaded = true;
        }
        this.ideaEvidenceIndex ??= buildDocumentEvidenceIndex(this.narrativeIdeas.values(), item => item.evidence);
        for (const id of this.ideaEvidenceIndex.get(result.documentId) ?? []) {
          const item = this.narrativeIdeas.get(id);
          if (!item) continue;
          const evidence = mapEvidence(item.evidence);
          if (evidence.some((entry, index) => entry !== item.evidence[index])) {
            const updated = { ...item, evidence };
            await this.persistIdeaUpdate(store, updated, item);
            this.narrativeIdeas.set(id, updated);
            updateDocumentLineIndex(this.ideaLineIndex, id, item.text, item.evidence, evidence);
          }
        }
      }
      if (this.store.saveAssertion && this.store.loadAssertions) {
        if (!this.assertionsLoaded) {
          const records = requireProjectScopedRecords(await this.store.loadAssertions(project.projectId), project.projectId, "afirmaciones");
          for (const item of records) this.narrativeAssertions.set(item.id, item);
          this.assertionsLoaded = true;
        }
        this.assertionEvidenceIndex ??= buildDocumentEvidenceIndex(this.narrativeAssertions.values(), item => [item.evidence]);
        for (const id of this.assertionEvidenceIndex.get(result.documentId) ?? []) {
          const item = this.narrativeAssertions.get(id);
          if (!item) continue;
          const evidence = rebase(item.evidence);
          if (evidence !== item.evidence) {
            const updated = { ...item, evidence };
            await this.store.saveAssertion(updated);
            this.narrativeAssertions.set(id, updated);
          }
        }
      }
    });
    this.knowledgeTail = work.then(() => undefined, () => undefined);
    await work;
  }

  /**
   * Extrae entidades solo desde el fragmento entregado por el anfitrión.
   * La persistencia y consulta quedan limitadas al projectId de esta instancia.
   */
  async extractNarrativeKnowledge(
    documentId: string,
    revision: number,
    text: string,
    baseOffset = 0
  ): Promise<readonly NarrativeEntity[]> {
    const project = this.requireProject();
    if (typeof documentId !== "string" || !documentId.trim() ||
        !Number.isSafeInteger(revision) || revision < 0 || typeof text !== "string" ||
        !Number.isSafeInteger(baseOffset) || baseOffset < 0 ||
        baseOffset > Number.MAX_SAFE_INTEGER - text.length) {
      throw new Error("Fragmento narrativo inválido.");
    }
    const store = this.requireKnowledgeStore();
    const work = this.knowledgeTail.then(async () => {
      const extracted = extractNarrativeEntities(project.projectId, documentId, revision, text, Date.now(), baseOffset);
      if (!this.entitiesLoaded) {
        const existing = requireProjectScopedRecords(await store.loadEntities(project.projectId), project.projectId, "entidades");
        for (const entity of existing) this.narrativeEntities.set(entity.id, entity);
        this.entitiesLoaded = true;
      }
      const byId = this.narrativeEntities;
      this.entityNameIndex ??= buildEntityNameIndex(byId.values());
      const merged: NarrativeEntity[] = [];
      for (const entity of extracted) {
        const matchingIds = this.entityNameIndex.get(entityNameIndexKey(entity.kind, entity.canonicalName)) ?? [];
        const aliasMatches = [...matchingIds]
          .map(id => byId.get(id))
          .filter((candidate): candidate is NarrativeEntity => candidate !== undefined);
        // Reutiliza una identidad solo si el alias apunta a una única ficha.
        // Si hay más de una coincidencia, conserva el registro separado para revisión.
        const matched = aliasMatches.length === 1 ? aliasMatches[0] : undefined;
        const incoming = matched ? {
          ...entity,
          id: matched.id,
          canonicalName: matched.canonicalName,
          normalizedName: matched.normalizedName,
          aliases: matched.aliases
        } : entity;
        const next = mergeNarrativeEntity(byId.get(incoming.id), incoming);
        await store.saveEntity(next);
        byId.set(next.id, next);
        addEntityNameIndex(this.entityNameIndex, next);
        addDocumentEvidenceIndex(this.entityEvidenceIndex, next.id, next.evidence);
        merged.push(next);
      }
      if (this.store.saveRelation && this.store.loadRelations) {
        const relationStore = this.requireRelationStore();
        if (!this.relationsLoaded) {
          const existingRelations = requireProjectScopedRecords(await relationStore.loadRelations(project.projectId), project.projectId, "relaciones");
          for (const relation of existingRelations) this.narrativeRelations.set(relation.id, relation);
          this.relationsLoaded = true;
        }
        const relationById = this.narrativeRelations;
        const detectedRelations = extractNarrativeRelations(
          project.projectId, documentId, revision, text, [...byId.values()], baseOffset
        );
        for (const relation of detectedRelations) {
          const next = mergeNarrativeRelation(relationById.get(relation.id), relation);
          await relationStore.saveRelation(next);
          relationById.set(next.id, next);
          addDocumentEvidenceIndex(this.relationEvidenceIndex, next.id, next.evidence);
        }
      }

      if (this.store.saveEvent && this.store.loadEvents) {
        const eventStore = this.requireEventStore();
        if (!this.eventsLoaded) {
          const existingEvents = requireProjectScopedRecords(await eventStore.loadEvents(project.projectId), project.projectId, "acontecimientos");
          for (const event of existingEvents) this.narrativeEvents.set(event.id, event);
          this.eventsLoaded = true;
        }
        const eventById = this.narrativeEvents;
        this.eventLineIndex ??= buildDocumentLineIndex(
          eventById.values(), item => item.label, item => item.evidence
        );
        const matchedEventIds = new Set<string>();
        for (const event of extractNarrativeEvents(
          project.projectId, documentId, revision, text, [...byId.values()], baseOffset
        )) {
          const incomingEvidence = event.evidence[0];
          const incomingLineStart = incomingEvidence
            ? incomingEvidence.start - Math.max(0, incomingEvidence.excerpt.indexOf(event.label))
            : -1;
          const indexedEvent = findDocumentLineRecord(
            this.eventLineIndex, eventById, documentId, incomingLineStart, matchedEventIds
          );
          const previousAtLine = indexedEvent && incomingEvidence &&
            indexedEvent.evidence.some(item => item.documentId === documentId)
            ? indexedEvent
            : (incomingEvidence ? findDocumentLineRecordByExcerpt(
              eventById.values(), item => item.evidence, documentId,
              incomingEvidence.excerpt, incomingLineStart, matchedEventIds
            ) : undefined);
          if (previousAtLine) matchedEventIds.add(previousAtLine.id);
          const candidate = previousAtLine ? { ...event, id: previousAtLine.id } : event;
          const next = mergeNarrativeEvent(eventById.get(candidate.id), candidate);
          await eventStore.saveEvent(next);
          eventById.set(next.id, next);
          addDocumentEvidenceIndex(this.eventEvidenceIndex, next.id, next.evidence);
          const key = `${documentId}\u0000${incomingLineStart}`;
          const ids = this.eventLineIndex.get(key) ?? new Set<string>();
          ids.add(next.id);
          this.eventLineIndex.set(key, ids);
        }
      }

      if (this.store.saveIdea && this.store.loadIdeas) {
        const ideaStore = this.requireIdeaStore();
        if (!this.ideasLoaded) {
          const existingIdeas = requireProjectScopedRecords(await ideaStore.loadIdeas(project.projectId), project.projectId, "ideas");
          for (const idea of existingIdeas) this.narrativeIdeas.set(idea.id, idea);
          this.ideasLoaded = true;
        }
        const ideaById = this.narrativeIdeas;
        this.ideaLineIndex ??= buildDocumentLineIndex(
          ideaById.values(), item => item.text, item => item.evidence
        );
        const matchedIdeaIds = new Set<string>();
        for (const idea of extractNarrativeIdeas(project.projectId, documentId, revision, text, baseOffset, project.projectName)) {
          const incomingEvidence = idea.evidence[0];
          const incomingLineStart = incomingEvidence
            ? incomingEvidence.start - Math.max(0, incomingEvidence.excerpt.indexOf(idea.text))
            : -1;
          const indexedIdea = findDocumentLineRecord(
            this.ideaLineIndex, ideaById, documentId, incomingLineStart, matchedIdeaIds
          );
          const previousAtLine = indexedIdea && incomingEvidence &&
            indexedIdea.evidence.some(item => item.documentId === documentId)
            ? indexedIdea
            : (incomingEvidence ? findDocumentLineRecordByExcerpt(
              ideaById.values(), item => item.evidence, documentId,
              incomingEvidence.excerpt, incomingLineStart, matchedIdeaIds
            ) : undefined);
          if (previousAtLine) matchedIdeaIds.add(previousAtLine.id);
          const candidate = previousAtLine ? { ...idea, id: previousAtLine.id } : idea;
          const next = mergeNarrativeIdea(ideaById.get(candidate.id), candidate);
          const currentIdea = ideaById.get(candidate.id);
          if (currentIdea) await this.persistIdeaUpdate(ideaStore, next, currentIdea);
          else await ideaStore.saveIdea(next);
          ideaById.set(next.id, next);
          addDocumentEvidenceIndex(this.ideaEvidenceIndex, next.id, next.evidence);
          const key = `${documentId}\u0000${incomingLineStart}`;
          const ids = this.ideaLineIndex.get(key) ?? new Set<string>();
          ids.add(next.id);
          this.ideaLineIndex.set(key, ids);
        }
      }
      if (this.store.saveAssertion && this.store.loadAssertions) {
        if (!this.assertionsLoaded) {
          const existingAssertions = requireProjectScopedRecords(await this.store.loadAssertions(project.projectId), project.projectId, "afirmaciones");
          for (const assertion of existingAssertions) this.narrativeAssertions.set(assertion.id, assertion);
          this.assertionsLoaded = true;
        }
        const matchedAssertionIds = new Set<string>();
        for (const assertion of extractNarrativeAssertions(
          project.projectId, documentId, revision, text, [...byId.values()], baseOffset
        )) {
          if (this.narrativeAssertions.has(assertion.id)) continue;
          const previous = [...this.narrativeAssertions.values()]
            .filter(item =>
              !matchedAssertionIds.has(item.id) &&
              item.entityId === assertion.entityId &&
              item.attribute === assertion.attribute &&
              item.value === assertion.value &&
              item.evidence.documentId === documentId &&
              item.evidence.excerpt === assertion.evidence.excerpt
            )
            .sort((left, right) =>
              Math.abs(left.evidence.start - assertion.evidence.start) -
              Math.abs(right.evidence.start - assertion.evidence.start)
            )[0];
          // Las afirmaciones conservan una evidencia vigente singular;
          // al desplazarla se mantiene el ID y se actualiza su ubicación.
          const nextAssertion = previous
            ? { ...assertion, id: previous.id }
            : assertion;
          if (previous) matchedAssertionIds.add(previous.id);
          await this.store.saveAssertion(nextAssertion);
          this.narrativeAssertions.set(nextAssertion.id, nextAssertion);
          addDocumentEvidenceIndex(this.assertionEvidenceIndex, nextAssertion.id, [nextAssertion.evidence]);
        }
      }

      return cloneNarrativeRecords(merged);
    });
    this.knowledgeTail = work.then(() => undefined, () => undefined);
    return work;
  }

  /**
   * Registra un alias confirmado por el escritor/anfitrión. Nunca infiere
   * identidades por similitud: rechaza colisiones con otras entidades.
   */
  async addNarrativeEntityAlias(entityId: string, alias: string): Promise<NarrativeEntity> {
    const projectId = this.requireProject().projectId;
    if (typeof entityId !== "string" || !entityId.trim() ||
        typeof alias !== "string" || !alias.trim() || alias.trim().length > 120 ||
        /[\r\n\t]/u.test(alias)) {
      throw new Error("Identificador o alias de entidad inválido.");
    }
    return this.enqueueKnowledgeOperation(async () => {
      const store = this.requireKnowledgeStore();
      const entities = await this.loadNarrativeEntitiesFromStore();
      const entity = this.narrativeEntities.get(entityId);
      if (!entity || entity.projectId !== projectId) {
        throw new Error("La entidad no existe en el proyecto activo.");
      }
      const cleanAlias = alias.normalize("NFKC").trim().replace(/\s+/gu, " ");
      const normalized = normalizeEntityName(cleanAlias);
      if (!normalized) throw new Error("El alias no puede estar vacío.");
      for (const candidate of entities) {
        if (candidate.id === entity.id) continue;
        if (candidate.kind === entity.kind &&
            (candidate.normalizedName === normalized ||
             candidate.aliases.some(value => normalizeEntityName(value) === normalized))) {
          throw new Error("El alias ya identifica otra entidad; no se puede asociar automáticamente.");
        }
      }
      if (normalized === entity.normalizedName ||
          entity.aliases.some(value => normalizeEntityName(value) === normalized)) return cloneNarrativeRecord(entity);
      const updated: NarrativeEntity = { ...entity, aliases: [...entity.aliases, cleanAlias] };
      await store.saveEntity(updated);
      this.narrativeEntities.set(updated.id, updated);
      addEntityNameIndex(this.entityNameIndex, updated);
      return cloneNarrativeRecord(updated);
    });
  }

  /**
   * Devuelve posibles registros duplicados para revisión humana.
   * No modifica ni fusiona identidades.
   */
  /**
   * Consolida dos fichas de la misma clase y redirige referencias históricas.
   * Requiere soporte transaccional del adaptador; nunca degrada a escrituras parciales.
   */
  async mergeNarrativeEntities(targetEntityId: string, sourceEntityId: string): Promise<NarrativeEntity> {
    const project = this.requireProject();
    const projectId = project.projectId;
    if (typeof targetEntityId !== "string" || !targetEntityId.trim() ||
        typeof sourceEntityId !== "string" || !sourceEntityId.trim() ||
        targetEntityId === sourceEntityId) {
      throw new Error("Identificadores de entidades inválidos.");
    }
    await this.liveAnalysisTail;
    const work = this.knowledgeTail.then(async () => {
      const store = this.requireKnowledgeStore();
      if (!store.mergeNarrativeEntityIdentity) {
        throw new Error("El adaptador no ofrece consolidación transaccional; no se realizaron cambios.");
      }
      const loadEntities = async () => requireProjectScopedRecords(
        await store.loadEntities(projectId), projectId, "entidades"
      );
      const entities = this.entitiesLoaded ? [...this.narrativeEntities.values()] : await loadEntities();
      const target = entities.find(item => item.id === targetEntityId);
      const source = entities.find(item => item.id === sourceEntityId);
      if (!target || !source || target.projectId !== projectId || source.projectId !== projectId) {
        throw new Error("Una de las entidades no existe en el proyecto activo.");
      }
      if (target.kind !== source.kind) throw new Error("No se pueden consolidar entidades de tipos diferentes.");
      const mergedNames = new Set(
        [target.canonicalName, ...target.aliases, source.canonicalName, ...source.aliases].map(normalizeEntityName)
      );
      const thirdPartyCollision = entities.find(item =>
        item.id !== targetEntityId && item.id !== sourceEntityId && item.kind === target.kind &&
        [item.canonicalName, ...item.aliases].some(name => mergedNames.has(normalizeEntityName(name)))
      );
      if (thirdPartyCollision) {
        throw new Error("La consolidación produciría un alias ambiguo con otra entidad del proyecto.");
      }
      const mergedEvidence = [...target.evidence];
      const evidenceKeys = new Set(mergedEvidence.map(item =>
        [item.documentId, item.revision, item.start, item.end, item.excerpt, item.status ?? ""].join("\u0000")
      ));
      for (const item of source.evidence) {
        const key = [item.documentId, item.revision, item.start, item.end, item.excerpt, item.status ?? ""].join("\u0000");
        if (!evidenceKeys.has(key)) { mergedEvidence.push(item); evidenceKeys.add(key); }
      }
      const aliases = [...new Map(
        [...target.aliases, source.canonicalName, ...source.aliases]
          .map(alias => [normalizeEntityName(alias), alias] as const)
      ).values()].filter(alias => alias && normalizeEntityName(alias) !== target.normalizedName);
      const merged: NarrativeEntity = {
        ...target, aliases, evidence: mergedEvidence,
        mergedFromIds: [...new Set([...(target.mergedFromIds ?? []), source.id, ...(source.mergedFromIds ?? [])])],
        firstSeenAt: Math.min(target.firstSeenAt, source.firstSeenAt),
        lastSeenAt: Math.max(target.lastSeenAt, source.lastSeenAt)
      };
      await store.mergeNarrativeEntityIdentity(
        projectId, targetEntityId, sourceEntityId, project.writerId
      );
      if (this.ideasLoaded) {
        for (const [ideaId, idea] of this.narrativeIdeas) {
          if (!idea.relatedEntityIds?.includes(sourceEntityId)) continue;
          this.narrativeIdeas.set(ideaId, {
            ...idea,
            relatedEntityIds: [...new Set(idea.relatedEntityIds.map(id =>
              id === sourceEntityId ? targetEntityId : id
            ))]
          });
        }
      }
      this.narrativeEntities.set(targetEntityId, merged);
      this.narrativeEntities.delete(sourceEntityId);
      this.entityEvidenceIndex = undefined;
      this.entityNameIndex = undefined;
      this.relationEvidenceIndex = undefined;
      this.eventEvidenceIndex = undefined;
      this.ideaEvidenceIndex = undefined;
      this.eventLineIndex = undefined;
      this.ideaLineIndex = undefined;
      this.assertionEvidenceIndex = undefined;
      // La transacción puede haber fusionado relaciones duplicadas o eliminado
      // autorrelaciones; invalida estas cachés para recargarlas desde el almacén atómico.
      this.narrativeRelations.clear();
      this.relationsLoaded = false;
      this.narrativeEvents.clear();
      this.eventsLoaded = false;
      this.narrativeAssertions.clear();
      this.assertionsLoaded = false;
      return cloneNarrativeRecord(merged);
    });
    this.knowledgeTail = work.then(() => undefined, () => undefined);
    return work;
  }

  async getNarrativeEntityIdentityCandidates(): Promise<readonly import("./narrative-knowledge").NarrativeEntityIdentityCandidate[]> {
    const entities = await this.getNarrativeEntities();
    return findNarrativeEntityIdentityCandidates(this.requireProject().projectId, entities);
  }

  private async loadNarrativeEntitiesFromStore(): Promise<readonly NarrativeEntity[]> {
    if (!this.entitiesLoaded) {
      const projectId = this.requireProject().projectId;
      const entities = requireProjectScopedRecords(
        await this.requireKnowledgeStore().loadEntities(projectId), projectId, "entidades"
      );
      for (const entity of entities) this.narrativeEntities.set(entity.id, entity);
      this.entitiesLoaded = true;
    }
    return [...this.narrativeEntities.values()];
  }

  async getNarrativeEntities(): Promise<readonly NarrativeEntity[]> {
    return this.enqueueKnowledgeOperation(async () =>
      cloneNarrativeRecords(await this.loadNarrativeEntitiesFromStore())
    );
  }

  async getNarrativeRelations(): Promise<readonly NarrativeRelation[]> {
    return this.enqueueKnowledgeOperation(async () => {
      const projectId = this.requireProject().projectId;
      if (!this.relationsLoaded) {
        const relations = requireProjectScopedRecords(
          await this.requireRelationStore().loadRelations(projectId), projectId, "relaciones"
        );
        const entities = await this.loadNarrativeEntitiesFromStore();
        requireNarrativeEntityReferences(
          relations, projectId, entities,
          relation => [relation.fromEntityId, relation.toEntityId], "relaciones"
        );
        for (const relation of relations) this.narrativeRelations.set(relation.id, relation);
        this.relationsLoaded = true;
      }
      const entities = await this.loadNarrativeEntitiesFromStore();
      requireNarrativeEntityReferences(
        [...this.narrativeRelations.values()], projectId, entities,
        relation => [relation.fromEntityId, relation.toEntityId], "relaciones"
      );
      return cloneNarrativeRecords([...this.narrativeRelations.values()]);
    });
  }

  async getNarrativeEvents(): Promise<readonly NarrativeEvent[]> {
    return this.enqueueKnowledgeOperation(async () => {
      const projectId = this.requireProject().projectId;
      if (!this.eventsLoaded) {
        const events = requireProjectScopedRecords(
          await this.requireEventStore().loadEvents(projectId), projectId, "acontecimientos"
        );
        const entities = await this.loadNarrativeEntitiesFromStore();
        requireNarrativeEntityReferences(
          events, projectId, entities, event => event.participants, "acontecimientos"
        );
        for (const event of events) this.narrativeEvents.set(event.id, event);
        this.eventsLoaded = true;
      }
      const entities = await this.loadNarrativeEntitiesFromStore();
      requireNarrativeEntityReferences(
        [...this.narrativeEvents.values()], projectId, entities,
        event => event.participants, "acontecimientos"
      );
      return cloneNarrativeRecords([...this.narrativeEvents.values()]);
    });
  }

  /**
   * Devuelve una vista de cronología. Solo ordena dentro de referencias comparables:
   * fechas/años de calendario entre sí y días numerados del mundo narrativo entre sí.
   * Los eventos sin fecha explícita quedan al final, sin orden cronológico atribuido.
   */
  async getNarrativeTimeline(): Promise<readonly NarrativeEvent[]> {
    const events = [...await this.getNarrativeEvents()].filter(event =>
      event.evidence.some(evidence => evidence.status !== "stale")
    );
    const basisRank = (event: NarrativeEvent) =>
      event.timeReference?.precision === "date" ? 0 :
      event.timeReference?.precision === "year" ? 1 :
      event.timeReference?.basis === "story-day" ? 2 : 3;
    return events.sort((a, b) => {
      const rank = basisRank(a) - basisRank(b);
      if (rank !== 0) return rank;
      const av = a.timeReference?.orderValue;
      const bv = b.timeReference?.orderValue;
      if (av !== undefined && bv !== undefined && av !== bv) return av - bv;
      const ae = a.evidence.find(evidence => evidence.status !== "stale") ?? a.evidence[0];
      const be = b.evidence.find(evidence => evidence.status !== "stale") ?? b.evidence[0];
      return (ae?.documentId ?? "").localeCompare(be?.documentId ?? "") ||
        (ae?.start ?? 0) - (be?.start ?? 0);
    });
  }

  /**
   * Devuelve candidatos a contradicción respaldados por dos afirmaciones explícitas.
   * La API no resuelve el conflicto ni modifica el manuscrito o el conocimiento.
   */
  async getNarrativeContradictions(): Promise<readonly NarrativeContradiction[]> {
    const [events, entities] = await Promise.all([
      this.getNarrativeEvents(), this.getNarrativeEntities()
    ]);
    return detectExplicitStateContradictions(this.requireProject().projectId, events, entities);
  }

  /** Resuelve tanto el ID canónico como los IDs históricos absorbidos por una consolidación. */
  async resolveNarrativeEntityId(entityId: string): Promise<string | undefined> {
    if (typeof entityId !== "string" || !entityId.trim()) {
      throw new Error("Identificador de entidad inválido.");
    }
    if (!this.entitiesLoaded && !this.store.loadEntities) return undefined;
    const matches = (await this.getNarrativeEntities()).filter(entity =>
      entity.id === entityId || entity.mergedFromIds?.includes(entityId)
    );
    if (matches.length > 1) {
      throw new Error("El ID histórico está asociado a más de una identidad; se requiere revisión de integridad.");
    }
    return matches[0]?.id;
  }

  /** Historial de atributos explícitos de una entidad, conservando cada revisión como evidencia independiente. */
  async getNarrativeEntityHistory(entityId: string): Promise<readonly NarrativeAssertion[]> {
    if (typeof entityId !== "string" || !entityId.trim()) {
      throw new Error("Identificador de entidad inválido.");
    }
    return this.enqueueKnowledgeOperation(async () => {
      const projectId = this.requireProject().projectId;
      const entities = await this.loadNarrativeEntitiesFromStore();
      const matches = entities.filter(entity =>
        entity.id === entityId || entity.mergedFromIds?.includes(entityId)
      );
      if (matches.length > 1) {
        throw new Error("El ID histórico está asociado a más de una identidad; se requiere revisión de integridad.");
      }
      const resolvedEntityId = matches[0]?.id ?? entityId;
      if (!this.store.loadAssertions) return [];
      if (!this.assertionsLoaded) {
        const assertions = requireProjectScopedRecords(
          await this.store.loadAssertions(projectId), projectId, "afirmaciones"
        );
        requireNarrativeEntityReferences(
          assertions, projectId, entities, assertion => [assertion.entityId], "afirmaciones"
        );
        for (const assertion of assertions) this.narrativeAssertions.set(assertion.id, assertion);
        this.assertionsLoaded = true;
      }
      requireNarrativeEntityReferences(
        [...this.narrativeAssertions.values()], projectId, entities,
        assertion => [assertion.entityId], "afirmaciones"
      );
      return cloneNarrativeRecords([...this.narrativeAssertions.values()]
        .filter(assertion => assertion.projectId === projectId && assertion.entityId === resolvedEntityId)
        .sort((a, b) => {
          const at = a.timeReference;
          const bt = b.timeReference;
          if (at && bt && at.basis === bt.basis && at.orderValue !== bt.orderValue) return at.orderValue - bt.orderValue;
          if (at && !bt) return -1;
          if (!at && bt) return 1;
          return a.evidence.revision - b.evidence.revision ||
            a.evidence.documentId.localeCompare(b.evidence.documentId) || a.evidence.start - b.evidence.start;
        }));
    });
  }

  async getNarrativeAssertions(): Promise<readonly NarrativeAssertion[]> {
    return this.enqueueKnowledgeOperation(async () => {
      if (!this.store.loadAssertions) return [];
      const projectId = this.requireProject().projectId;
      if (!this.assertionsLoaded) {
        const assertions = requireProjectScopedRecords(
          await this.store.loadAssertions(projectId), projectId, "afirmaciones"
        );
        const entities = await this.loadNarrativeEntitiesFromStore();
        requireNarrativeEntityReferences(
          assertions, projectId, entities, assertion => [assertion.entityId], "afirmaciones"
        );
        for (const assertion of assertions) this.narrativeAssertions.set(assertion.id, assertion);
        this.assertionsLoaded = true;
      }
      requireNarrativeEntityReferences(
        [...this.narrativeAssertions.values()], projectId,
        await this.loadNarrativeEntitiesFromStore(),
        assertion => [assertion.entityId], "afirmaciones"
      );
      return cloneNarrativeRecords([...this.narrativeAssertions.values()].filter(
        assertion => assertion.projectId === projectId
      ));
    });
  }

  async getNarrativeIdeas(): Promise<readonly NarrativeIdea[]> {
    return this.enqueueKnowledgeOperation(async () => {
      const projectId = this.requireProject().projectId;
      if (!this.ideasLoaded) {
        const ideas = requireProjectScopedRecords(
          await this.requireIdeaStore().loadIdeas(projectId), projectId, "ideas"
        );
        const hasEntityLinks = ideas.some(idea => (idea.relatedEntityIds?.length ?? 0) > 0);
        if (hasEntityLinks) {
          if (!this.store.loadEntities) {
            throw new Error("Integridad narrativa: no se pueden verificar los vínculos de ideas sin acceso a entidades.");
          }
          requireNarrativeEntityReferences(
            ideas, projectId, await this.loadNarrativeEntitiesFromStore(),
            idea => idea.relatedEntityIds ?? [], "ideas"
          );
        }
        for (const idea of ideas) this.narrativeIdeas.set(idea.id, idea);
        this.ideasLoaded = true;
      }
      const ideas = [...this.narrativeIdeas.values()];
      if (ideas.some(idea => (idea.relatedEntityIds?.length ?? 0) > 0)) {
        if (!this.store.loadEntities) {
          throw new Error("Integridad narrativa: no se pueden verificar los vínculos de ideas sin acceso a entidades.");
        }
        requireNarrativeEntityReferences(
          ideas, projectId, await this.loadNarrativeEntitiesFromStore(),
          idea => idea.relatedEntityIds ?? [], "ideas"
        );
      }
      return cloneNarrativeRecords(ideas);
    });
  }

  /** Encola cambios manuales de conocimiento detrás de los análisis ya admitidos. */
  private enqueueKnowledgeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.knowledgeTail.then(operation);
    this.knowledgeTail = work.then(() => undefined, () => undefined);
    return work;
  }

  /**
   * Crea o elimina un vínculo explícito entre una idea y una ficha del mismo libro.
   * No infiere relaciones a partir de coincidencias de palabras.
   */
  async setNarrativeIdeaEntityLink(ideaId: string, entityId: string, linked: boolean): Promise<NarrativeIdea> {
    const projectId = this.requireProject().projectId;
    if (typeof ideaId !== "string" || !ideaId.trim() ||
        typeof entityId !== "string" || !entityId.trim() || typeof linked !== "boolean") {
      throw new Error("Datos de relación entre idea y entidad inválidos.");
    }
    return this.enqueueKnowledgeOperation(async () => {
      const ideaStore = this.requireIdeaStore();
      const entityStore = this.requireKnowledgeStore();
      if (!this.ideasLoaded) {
        const ideas = requireProjectScopedRecords(await ideaStore.loadIdeas(projectId), projectId, "ideas");
        for (const idea of ideas) this.narrativeIdeas.set(idea.id, idea);
        this.ideasLoaded = true;
      }
      if (!this.entitiesLoaded) {
        const entities = requireProjectScopedRecords(await entityStore.loadEntities(projectId), projectId, "entidades");
        for (const entity of entities) this.narrativeEntities.set(entity.id, entity);
        this.entitiesLoaded = true;
      }
      const idea = this.narrativeIdeas.get(ideaId);
      const entity = this.narrativeEntities.get(entityId);
      if (!idea || idea.projectId !== projectId || !entity || entity.projectId !== projectId) {
        throw new Error("La idea y la entidad deben existir en el proyecto activo.");
      }
      const current = idea.relatedEntityIds ?? [];
      const relatedEntityIds = linked
        ? [...new Set([...current, entityId])]
        : current.filter(id => id !== entityId);
      if (relatedEntityIds.length === current.length && relatedEntityIds.every((id, index) => id === current[index])) return cloneNarrativeRecord(idea);
      const updated: NarrativeIdea = { ...idea, relatedEntityIds };
      await this.persistIdeaUpdate(ideaStore, updated, idea);
      this.narrativeIdeas.set(ideaId, updated);
      return cloneNarrativeRecord(updated);
    });
  }

  /**
   * Crea o elimina una referencia dirigida a otra idea del mismo libro.
   * La relación se almacena en la idea de origen para no duplicar escrituras.
   */
  async setNarrativeIdeaLink(ideaId: string, relatedIdeaId: string, linked: boolean): Promise<NarrativeIdea> {
    const projectId = this.requireProject().projectId;
    if (typeof ideaId !== "string" || !ideaId.trim() ||
        typeof relatedIdeaId !== "string" || !relatedIdeaId.trim() ||
        ideaId === relatedIdeaId || typeof linked !== "boolean") {
      throw new Error("Datos de relación entre ideas inválidos.");
    }
    return this.enqueueKnowledgeOperation(async () => {
      const store = this.requireIdeaStore();
      if (!this.ideasLoaded) {
        const ideas = requireProjectScopedRecords(await store.loadIdeas(projectId), projectId, "ideas");
        for (const idea of ideas) this.narrativeIdeas.set(idea.id, idea);
        this.ideasLoaded = true;
      }
      const idea = this.narrativeIdeas.get(ideaId);
      const related = this.narrativeIdeas.get(relatedIdeaId);
      if (!idea || idea.projectId !== projectId ||
          (linked && (!related || related.projectId !== projectId))) {
        throw new Error(linked
          ? "Ambas ideas deben existir en el proyecto activo."
          : "La idea que contiene el vínculo no existe en el proyecto activo.");
      }
      const current = idea.relatedIdeaIds ?? [];
      const relatedIdeaIds = linked
        ? [...new Set([...current, relatedIdeaId])]
        : current.filter(id => id !== relatedIdeaId);
      if (relatedIdeaIds.length === current.length && relatedIdeaIds.every((id, index) => id === current[index])) return cloneNarrativeRecord(idea);
      const updated: NarrativeIdea = { ...idea, relatedIdeaIds };
      await this.persistIdeaUpdate(store, updated, idea);
      this.narrativeIdeas.set(ideaId, updated);
      return cloneNarrativeRecord(updated);
    });
  }

  /**
   * Cierra el ciclo de un libro: transfiere solo ideas todavía en IDEA
   * a la biblioteca privada del escritor. El anfitrión llama esto al finalizar.
   */
  async archiveUnincorporatedIdeas(): Promise<readonly import("./narrative-knowledge").PersonalIdeaLibraryEntry[]> {
    const project = this.requireProject();
    const writerId = this.requireWriterId();
    const archive = this.store.archiveUnincorporatedIdeas;
    if (!archive) throw new Error("El almacenamiento no admite la biblioteca personal de ideas.");
    await this.flushPendingChanges();
    // La transferencia entra en la misma cola que las demás mutaciones narrativas:
    // una actualización manual no puede intercalarse con el movimiento a biblioteca.
    const work = this.knowledgeTail.then(async () => {
      const entries = await archive.call(this.store, project.projectId, writerId, project.projectName, Date.now());
      try {
        const validatedEntries = requireUniquePersonalIdeaEntries(entries, writerId, project.projectId);
        if (validatedEntries.some(entry =>
          entry.sourceProjectName !== project.projectName || entry.context?.version !== 1
        )) {
          throw new Error("Integridad de biblioteca: la transferencia no conservó el contexto relacionado del libro.");
        }
        return cloneNarrativeRecords(validatedEntries);
      } finally {
        // Un adaptador pudo confirmar la transacción y devolver una respuesta inválida.
        // Invalidar igualmente la caché evita exponer ideas que ya fueron transferidas.
        this.narrativeIdeas.clear();
        this.ideasLoaded = false;
        this.ideaEvidenceIndex = undefined;
        this.ideaLineIndex = undefined;
      }
    });
    this.knowledgeTail = work.then(() => undefined, () => undefined);
    return work;
  }

  /** Lee únicamente la biblioteca del escritor solicitado; nunca la mezcla con proyectos. */
  async getPersonalIdeaLibrary(): Promise<readonly import("./narrative-knowledge").PersonalIdeaLibraryEntry[]> {
    const writerId = this.requireWriterId();
    if (!this.store.loadPersonalIdeas) {
      throw new Error("El almacenamiento no admite la biblioteca personal de ideas.");
    }
    // La lectura también ocupa la cola: evita que un archivo iniciado justo
    // después de la llamada se solape con un adaptador externo no transaccional.
    const work = this.knowledgeTail.then(async () => {
      const entries = await this.store.loadPersonalIdeas!(writerId);
      const validated = requireUniquePersonalIdeaEntries(entries, writerId);
      return cloneNarrativeRecords(validated.map(entry => entry.context
        ? entry
        : { ...entry, contextStatus: "missing-legacy-context" as const }
      ));
    });
    this.knowledgeTail = work.then(() => undefined, () => undefined);
    return work;
  }


  async setNarrativeIdeaStatus(
    ideaId: string,
    status: NarrativeIdea["status"]
  ): Promise<NarrativeIdea> {
    const project = this.requireProject();
    if (typeof ideaId !== "string" || !ideaId.trim() ||
        !["IDEA", "incorporated", "discarded"].includes(status)) {
      throw new Error("Identificador o estado de idea inválido.");
    }
    const store = this.requireIdeaStore();
    const work = this.knowledgeTail.then(async () => {
      if (!this.ideasLoaded) {
        const ideas = requireProjectScopedRecords(await store.loadIdeas(project.projectId), project.projectId, "ideas");
        for (const idea of ideas) this.narrativeIdeas.set(idea.id, idea);
        this.ideasLoaded = true;
      }
      const current = this.narrativeIdeas.get(ideaId);
      if (!current) throw new Error("La idea no pertenece al proyecto activo o no existe.");
      if (current.status === status) return cloneNarrativeRecord(current);
      const statusHistory = [...(current.statusHistory ?? [
        { status: current.status, reason: "initial" as const }
      ])];
      statusHistory.push({ status, changedAt: Date.now(), reason: "writer" });
      const updated: NarrativeIdea = { ...current, status, statusHistory };
      await this.persistIdeaUpdate(store, updated, current);
      this.narrativeIdeas.set(updated.id, updated);
      return cloneNarrativeRecord(updated);
    });
    this.knowledgeTail = work.then(() => undefined, () => undefined);
    return work;
  }


  private reportKnowledgeError(error: unknown): void {
    try { this.onKnowledgeError?.(error); } catch { /* Los errores del anfitrión no deben detener el motor. */ }
  }

  private requireEventStore(): Required<Pick<import("./contracts").ProjectStore, "saveEvent" | "loadEvents">> {
    const store = this.store;
    if (!store.saveEvent || !store.loadEvents) throw new Error("El almacenamiento no admite acontecimientos.");
    return { saveEvent: store.saveEvent.bind(store), loadEvents: store.loadEvents.bind(store) };
  }

  private requireIdeaStore(): Required<Pick<
    import("./contracts").ProjectStore,
    "saveIdea" | "loadIdeas" | "updateIdeaIfUnchanged"
  >> {
    const store = this.store;
    if (!store.saveIdea || !store.loadIdeas || !store.updateIdeaIfUnchanged) {
      throw new Error("El almacenamiento no admite actualizaciones de ideas seguras entre instancias.");
    }
    return {
      saveIdea: store.saveIdea.bind(store),
      loadIdeas: store.loadIdeas.bind(store),
      updateIdeaIfUnchanged: store.updateIdeaIfUnchanged.bind(store)
    };
  }

  private async persistIdeaUpdate(
    store: Required<Pick<
      import("./contracts").ProjectStore,
      "saveIdea" | "loadIdeas" | "updateIdeaIfUnchanged"
    >>,
    updated: NarrativeIdea,
    expectedCurrent: NarrativeIdea
  ): Promise<void> {
    try {
      await store.updateIdeaIfUnchanged(updated, expectedCurrent);
    } catch (error) {
      // Otra instancia pudo archivar o modificar la idea. Descarta la caché
      // obsoleta para que la siguiente lectura consulte el estado persistido.
      this.narrativeIdeas.clear();
      this.ideasLoaded = false;
      this.ideaEvidenceIndex = undefined;
      this.ideaLineIndex = undefined;
      throw error;
    }
  }

  private requireRelationStore(): Required<Pick<import("./contracts").ProjectStore, "saveRelation" | "loadRelations">> {
    const store = this.store;
    if (!store.saveRelation || !store.loadRelations) {
      throw new Error("El adaptador de almacenamiento no admite relaciones narrativas.");
    }
    return { saveRelation: store.saveRelation.bind(store), loadRelations: store.loadRelations.bind(store) };
  }

  private requireProject(): ProjectIdentity {
    if (!this.project) throw new Error("Primero debe inicializarse el proyecto desde el anfitrión.");
    return this.project;
  }

  private requireKnowledgeStore(): import("./contracts").ProjectStore &
    Required<Pick<import("./contracts").ProjectStore, "saveEntity" | "loadEntities">> {
    const store = this.store;
    if (!store.saveEntity || !store.loadEntities) {
      throw new Error("El adaptador de almacenamiento no admite conocimiento narrativo.");
    }
    return store as import("./contracts").ProjectStore &
      Required<Pick<import("./contracts").ProjectStore, "saveEntity" | "loadEntities">>;
  }

  getCapabilities(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      apiVersion: MOTOR_LITERARIO_API_VERSION,
      liveEditorChanges: true,
      boundedNonBlockingAdmission: true,
      pieceTableEditing: true,
      incrementalChangeJournal: true,
      journalCrashRecovery: true,
      localSnapshotRecovery: true,
      corruptJournalHostSnapshotFallback: true,
      periodicDocumentSnapshots: true,
      localPersistence: true,
      deterministicProofreading: true,
      persistentRevisionDiagnostics: Boolean(this.store.saveDiagnostics && this.store.loadDiagnostics),
      diagnosticRecoveryOnOpen: true,
      multilineAffectedLineAnalysis: true,
      explicitHostResynchronization: true,
      automaticNarrativeExtraction: Boolean(this.store.saveEntity && this.store.loadEntities),
      incrementalNarrativeExtraction: Boolean(this.store.saveEntity && this.store.loadEntities),
      evidenceBasedEntityExtraction: Boolean(this.store.saveEntity && this.store.loadEntities),
      projectIsolatedNarrativeKnowledge: true,
      evidenceBasedCharacterRelations: Boolean(this.store.saveRelation && this.store.loadRelations),
      explicitEventCapture: Boolean(this.store.saveEvent && this.store.loadEvents),
      explicitEventChronology: Boolean(this.store.saveEvent && this.store.loadEvents),
      authorMarkedIdeaCapture: Boolean(this.store.saveIdea && this.store.loadIdeas && this.store.updateIdeaIfUnchanged),
      explicitIdeaEntityLinks: Boolean(this.store.saveIdea && this.store.loadIdeas && this.store.updateIdeaIfUnchanged && this.store.saveEntity && this.store.loadEntities),
      explicitIdeaLinks: Boolean(this.store.saveIdea && this.store.loadIdeas && this.store.updateIdeaIfUnchanged),
      personalIdeaLibrary: Boolean(this.store.archiveUnincorporatedIdeas && this.store.loadPersonalIdeas),
      explicitStateContradictionCandidates: Boolean(this.store.saveEvent && this.store.loadEvents && this.store.saveEntity && this.store.loadEntities),
      evidenceBackedCharacterHistory: Boolean(this.store.saveAssertion && this.store.loadAssertions),
      semanticContradictionAnalysis: false,
      externalRuntimeServices: false
    });
  }

  initializeProject(identity: ProjectIdentity): void {
    if (!identity || typeof identity.projectId !== "string" || !identity.projectId.trim() ||
        typeof identity.projectName !== "string" || !identity.projectName.trim() ||
        (identity.writerId !== undefined &&
          (typeof identity.writerId !== "string" || !identity.writerId.trim() || identity.writerId.length > 256))) {
      throw new Error("La identidad del proyecto o del escritor es inválida.");
    }
    this.engine.initializeProject(identity);
    this.project = Object.freeze({ ...identity });
  }

  /** La identidad del escritor nunca se recibe como argumento de una consulta de biblioteca. */
  private requireWriterId(): string {
    const writerId = this.requireProject().writerId;
    if (typeof writerId !== "string" || !writerId.trim() || writerId.length > 256) {
      throw new Error("El anfitrión debe proporcionar el identificador estable del escritor al inicializar el proyecto.");
    }
    return writerId;
  }

  async openDocument(snapshot: DocumentSnapshot): Promise<void> {
    await this.engine.openDocument(snapshot);
    await this.afterDocumentRecovery(snapshot.documentId);
  }

  /**
   * Reabre un documento desde el último snapshot y journal locales.
   * El anfitrión no necesita conservar ni reenviar el texto completo para
   * recuperar una sesión ya persistida.
   */
  async recoverDocument(documentId: string): Promise<void> {
    await this.engine.recoverDocument(documentId);
    await this.afterDocumentRecovery(documentId);
  }

  private async afterDocumentRecovery(documentId: string): Promise<void> {
    const recoveredSnapshot = this.engine.getSnapshot(documentId);
    if (recoveredSnapshot) {
      const recovery = this.diagnosticsPersistenceTail.then(async () => {
        await this.restoreDocumentDiagnostics(recoveredSnapshot);
      });
      this.diagnosticsRecoveryTail = recovery.catch(error => {
        this.reportKnowledgeError(error);
      });
      this.diagnosticsPersistenceTail = this.diagnosticsRecoveryTail;
    }
    if (this.store.saveEntity && this.store.loadEntities && recoveredSnapshot) {
      // El análisis inicial usa el snapshot realmente recuperado, que puede
      // incluir deltas durables posteriores al último checkpoint.
      void this.extractNarrativeKnowledge(
        recoveredSnapshot.documentId,
        recoveredSnapshot.revision,
        recoveredSnapshot.text,
        0
      ).catch(error => this.reportKnowledgeError(error));
    }
  }

  onEditorChange(change: EditorChange): ChangeAdmission {
    const admission = this.engine.submitChange(change);
    if (admission.status === "queued") {
      this.liveSubmissionTimes.set(admission.ticketId, performance.now());
    }
    return admission;
  }

  /** Métricas acumuladas del flujo en vivo; leerlas no detiene ni espera al análisis. */
  getLiveAnalysisMetrics(): LiveAnalysisMetrics {
    return {
      ...this.engine.getMetrics(),
      ...this.liveMetrics,
      endToEndP50Ms: percentile(this.endToEndRecentSamples, this.endToEndSampleCount, 0.50),
      endToEndP95Ms: percentile(this.endToEndRecentSamples, this.endToEndSampleCount, 0.95),
      endToEndWindowSamples: this.endToEndSampleCount
    };
  }

  getDocumentSyncState(documentId: string) {
    return this.engine.getSyncState(documentId);
  }

  /** Permite al anfitrión esperar la persistencia de todos los cambios admitidos. */
  async flushPendingChanges(): Promise<void> {
    await this.engine.waitForIdle();
    await this.liveAnalysisTail;
    await this.diagnosticsRecoveryTail;
    await this.diagnosticsPersistenceTail;
    await this.knowledgeTail;
  }

  pollCommit(ticketId: string): CommitResult | undefined {
    return this.engine.getCommit(ticketId);
  }

  getSnapshot(documentId: string): DocumentSnapshot | undefined {
    return this.engine.getSnapshot(documentId);
  }

  /** Devuelve solo diagnósticos que pertenecen a la revisión actualmente abierta. */
  getDocumentDiagnostics(documentId: string): readonly Diagnostic[] {
    const snapshot = this.engine.getSnapshot(documentId);
    const stored = this.documentDiagnostics.get(documentId);
    if (!snapshot || !stored || stored.revision !== snapshot.revision) return [];
    return structuredClone(stored.diagnostics);
  }

  private async restoreDocumentDiagnostics(snapshot: DocumentSnapshot): Promise<void> {
    const projectId = this.requireProject().projectId;
    const stored = await this.store.loadDiagnostics?.(projectId, snapshot.documentId);
    if (stored && stored.projectId === projectId &&
        stored.documentId === snapshot.documentId && stored.revision === snapshot.revision) {
      this.documentDiagnostics.set(snapshot.documentId, stored);
      return;
    }

    const diagnostics: Diagnostic[] = [];
    const maxChunkLength = 16_384;
    const overlap = 256;
    let scannedSinceYield = 0;
    let lineStart = 0;
    while (lineStart <= snapshot.text.length && diagnostics.length < 1024) {
      const newline = snapshot.text.indexOf("\n", lineStart);
      const lineEnd = newline < 0 ? snapshot.text.length : newline;
      for (let coreStart = lineStart; coreStart < lineEnd && diagnostics.length < 1024;
           coreStart += maxChunkLength) {
        const coreEnd = Math.min(lineEnd, coreStart + maxChunkLength);
        const contextStart = Math.max(lineStart, coreStart - overlap);
        const contextEnd = Math.min(lineEnd, coreEnd + overlap);
        const fragmentDiagnostics = proofreadFragment(
          snapshot.text.slice(contextStart, contextEnd), contextStart, snapshot.revision, 2048
        );
        for (const diagnostic of fragmentDiagnostics) {
          if (diagnostic.start >= coreStart && diagnostic.start < coreEnd) {
            diagnostics.push(diagnostic);
            if (diagnostics.length >= 1024) break;
          }
        }
        scannedSinceYield += coreEnd - coreStart;
        if (scannedSinceYield >= maxChunkLength &&
            (coreEnd < lineEnd || lineEnd < snapshot.text.length)) {
          scannedSinceYield = 0;
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }
      if (newline < 0) break;
      lineStart = newline + 1;
    }

    const record: StoredDiagnostics = {
      projectId,
      documentId: snapshot.documentId,
      revision: snapshot.revision,
      diagnostics,
      updatedAt: Date.now()
    };
    await this.store.saveDiagnostics?.(record);
    this.documentDiagnostics.set(snapshot.documentId, record);

  }
}
