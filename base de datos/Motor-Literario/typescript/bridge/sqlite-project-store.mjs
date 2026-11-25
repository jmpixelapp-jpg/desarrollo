import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, open as openFile } from "node:fs/promises";
import { dirname } from "node:path";

const TABLE = "bridge_records";
const ARCHIVE_PAGE_SIZE = 128;
// Debe coincidir con MAX_NARRATIVE_IDEA_REFERENCES en narrative-knowledge.ts.
const MAX_NARRATIVE_IDEA_REFERENCES = 500;
const WRITER_LIBRARY_COLLECTIONS = new Set([
  "personal-idea-library",
  "writer-library-finalization-receipts"
]);
const NARRATIVE_COLLECTIONS = new Set([
  "narrative-entities",
  "narrative-relations",
  "narrative-events",
  "narrative-ideas",
  "narrative-assertions",
  "event-lifecycles"
]);

function createArchiveContentChecksumBuilder() {
  let hash = 0xcbf29ce484222325n;
  let count = 0;
  let finished = false;
  const update = value => {
    for (let index = 0; index < value.length; index++) {
      hash ^= BigInt(value.charCodeAt(index));
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
  };
  update("[");
  return {
    add(entry) {
      if (finished) throw new Error("El checksum de la biblioteca ya fue cerrado.");
      if (!entry || !entry.idea || typeof entry.idea.id !== "string" || !entry.idea.id.trim()) {
        throw new Error("No se puede calcular el checksum de una entrada de biblioteca inválida.");
      }
      const serialized = JSON.stringify(entry);
      if (typeof serialized !== "string") {
        throw new Error("La entrada de biblioteca no se puede serializar para comprobar su integridad.");
      }
      if (count > 0) update(",");
      update(serialized);
      count++;
    },
    digest() {
      if (finished) throw new Error("El checksum de la biblioteca ya fue cerrado.");
      finished = true;
      update("]");
      return "fnv1a64:" + hash.toString(16).padStart(16, "0");
    }
  };
}
function isValidArchiveContentChecksum(value) {
  return typeof value === "string" && /^fnv1a64:[0-9a-f]{16}$/u.test(value);
}
function checksumForArchiveIds(ids) {
  const source = JSON.stringify([...ids].sort());
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < source.length; index++) {
    hash ^= BigInt(source.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return "fnv1a64:" + hash.toString(16).padStart(16, "0");
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function encodedKey(parts) {
  return JSON.stringify(parts);
}

/**
 * Clave de orden estable compatible con el orden lexicográfico UTF-16
 * usado por las claves compuestas de IndexedDB. Cada unidad se codifica
 * en cuatro dígitos hexadecimales; "!" separa componentes y preserva prefijos.
 */
function personalIdeaLibrarySortKey(sourceProjectId, ideaId) {
  const encode = value => {
    let result = "";
    for (let index = 0; index < value.length; index++) {
      result += value.charCodeAt(index).toString(16).padStart(4, "0");
    }
    return result;
  };
  return encode(sourceProjectId) + "!" + encode(ideaId) + "!";
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(label + " es obligatorio.");
  }
}

function requireProjectRecord(value, label) {
  if (!value || typeof value !== "object") throw new Error(label + " inválido.");
  requireText(value.projectId, label + ".projectId");
  requireText(value.id, label + ".id");
}

function requireProject(value, label = "projectId") {
  requireText(value, label);
}

function identityKey(projectId, id) {
  return [projectId, id];
}

function recordId(record) {
  return record?.id;
}

function normalizeNarrativeName(value) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es");
}
function evidenceKey(item) {
  return JSON.stringify([item.documentId, item.revision, item.start, item.end, item.excerpt, item.status ?? null]);
}
function validateEvidenceList(evidence, label) {
  if (!Array.isArray(evidence)) throw new Error(label + ": evidencias inválidas.");
  for (const item of evidence) {
    if (!item || typeof item.documentId !== "string" || !item.documentId.trim() ||
        !Number.isSafeInteger(item.revision) || item.revision < 0 ||
        !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) ||
        item.start < 0 || item.end < item.start || typeof item.excerpt !== "string" ||
        (item.status !== undefined && item.status !== "stale")) {
      throw new Error(label + ": evidencia malformada.");
    }
  }
}
function validateNarrativeEntity(entity, projectId, label = "entidad") {
  requireProjectRecord(entity, label);
  if (entity.projectId !== projectId || typeof entity.kind !== "string" || !entity.kind.trim() ||
      entity.kind.length > 128 || typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
      typeof entity.normalizedName !== "string" || entity.normalizedName !== normalizeNarrativeName(entity.canonicalName) ||
      !Array.isArray(entity.aliases) || entity.aliases.some(x => typeof x !== "string" || !x.trim()) ||
      (entity.mergedFromIds !== undefined &&
        (!Array.isArray(entity.mergedFromIds) ||
          entity.mergedFromIds.some(x => typeof x !== "string" || !x.trim()) ||
          new Set(entity.mergedFromIds).size !== entity.mergedFromIds.length)) ||
      !Number.isFinite(entity.firstSeenAt) || entity.firstSeenAt < 0 ||
      !Number.isFinite(entity.lastSeenAt) || entity.lastSeenAt < entity.firstSeenAt ||
      entity.extractionVersion !== 1) {
    throw new Error("Integridad narrativa: " + label + " malformada.");
  }
  validateEvidenceList(entity.evidence, label);
}
function validateNarrativeIdentityHistory(entities) {
  const owners = new Map();
  for (const entity of entities) {
    const localIds = new Set([entity.id]);
    for (const id of entity.mergedFromIds ?? []) {
      if (localIds.has(id)) throw new Error("Integridad narrativa: una entidad repite o reclama su propio ID histórico.");
      localIds.add(id);
    }
    for (const id of localIds) {
      if (owners.has(id) && owners.get(id) !== entity.id) {
        throw new Error("Integridad narrativa: un ID histórico pertenece a más de una entidad.");
      }
      owners.set(id, entity.id);
    }
  }
}
function validateEntitySnapshotHistory(entities) {
  const ids = new Set();
  const parents = new Map();
  for (const entity of entities) {
    validateNarrativeEntity(entity, entity.projectId, "entidad contextual");
    if (ids.has(entity.id)) throw new Error("Biblioteca personal: instantánea de entidad duplicada.");
    ids.add(entity.id);
    for (const parent of entity.mergedFromIds ?? []) {
      if (parent === entity.id || (parents.has(parent) && parents.get(parent) !== entity.id)) {
        throw new Error("Biblioteca personal: historial de identidades inconsistente.");
      }
      parents.set(parent, entity.id);
    }
  }
  for (const start of ids) {
    const visited = new Set();
    let current = start;
    while (parents.has(current)) {
      if (visited.has(current)) throw new Error("Biblioteca personal: ciclo en historial de identidades.");
      visited.add(current);
      current = parents.get(current);
    }
  }
}
function validateNarrativeIdeaStatusHistory(idea) {
  if (idea.statusHistory === undefined) return;
  if (!Array.isArray(idea.statusHistory) || idea.statusHistory.length === 0) {
    throw new Error("Historial de estados de idea inválido.");
  }
  let previousTime;
  for (let index = 0; index < idea.statusHistory.length; index++) {
    const item = idea.statusHistory[index];
    if (!item || !["IDEA", "incorporated", "discarded"].includes(item.status) ||
        !["initial", "writer", "text-revised"].includes(item.reason) ||
        (item.reason === "text-revised" && item.status !== "IDEA") ||
        (index === 0 ? item.reason !== "initial" : item.reason === "initial" ||
          item.status === idea.statusHistory[index - 1]?.status) ||
        (item.changedAt !== undefined &&
          (!Number.isFinite(item.changedAt) || item.changedAt < 0 ||
            (previousTime !== undefined && item.changedAt < previousTime)))) {
      throw new Error("Historial de estados de idea inválido.");
    }
    if (item.changedAt !== undefined) previousTime = item.changedAt;
  }
  if (idea.statusHistory[idea.statusHistory.length - 1]?.status !== idea.status) {
    throw new Error("El historial de estados no coincide con la idea actual.");
  }
}

function validateNarrativeIdeaReferenceLimit(idea) {
  for (const links of [idea.relatedEntityIds, idea.relatedIdeaIds]) {
    if (links !== undefined &&
        (!Array.isArray(links) || links.length > MAX_NARRATIVE_IDEA_REFERENCES)) {
      throw new Error(
        "Una idea no puede conservar más de " + MAX_NARRATIVE_IDEA_REFERENCES +
        " vínculos por categoría."
      );
    }
  }
}

function validateNarrativeIdea(idea, projectId, label = "idea") {
  requireProjectRecord(idea, label);
  if (idea.projectId !== projectId || typeof idea.text !== "string" || !idea.text.trim() ||
      !["IDEA", "incorporated", "discarded"].includes(idea.status) ||
      typeof idea.originDocumentId !== "string" || !idea.originDocumentId.trim() ||
      typeof idea.sourceProjectName !== "string" || !idea.sourceProjectName.trim()) {
    throw new Error("Integridad narrativa: " + label + " malformada.");
  }
  validateEvidenceList(idea.evidence, label);
  for (const links of [idea.relatedEntityIds, idea.relatedIdeaIds]) {
    if (links !== undefined &&
        (!Array.isArray(links) || links.length > MAX_NARRATIVE_IDEA_REFERENCES ||
          links.some(id => typeof id !== "string" || !id.trim()) ||
          new Set(links).size !== links.length)) {
      throw new Error(
        "Integridad narrativa: referencias de " + label +
        " inválidas, duplicadas o superiores al límite de " + MAX_NARRATIVE_IDEA_REFERENCES + "."
      );
    }
  }
  if (idea.relatedIdeaIds?.includes(idea.id)) throw new Error("Una idea no puede enlazarse a sí misma.");
  validateNarrativeIdeaStatusHistory(idea);
}
function validateNarrativeRelation(relation, projectId) {
  requireProjectRecord(relation, "relación narrativa");
  if (relation.projectId !== projectId || typeof relation.fromEntityId !== "string" ||
      !relation.fromEntityId.trim() || typeof relation.toEntityId !== "string" ||
      !relation.toEntityId.trim() || typeof relation.relationType !== "string" ||
      !relation.relationType.trim()) throw new Error("Relación narrativa malformada.");
  validateEvidenceList(relation.evidence, "relación narrativa");
}
function validateNarrativeEvent(event, projectId) {
  requireProjectRecord(event, "acontecimiento narrativo");
  if (event.projectId !== projectId || typeof event.label !== "string" || !event.label.trim() ||
      !Array.isArray(event.participants) ||
      event.participants.some(id => typeof id !== "string" || !id.trim()) ||
      new Set(event.participants).size !== event.participants.length) {
    throw new Error("Acontecimiento narrativo malformado.");
  }
  validateEvidenceList(event.evidence, "acontecimiento narrativo");
}
function validateEventLifecycle(item, projectId) {
  if (!item || typeof item !== "object" ||
      item.projectId !== projectId ||
      typeof item.id !== "string" || !item.id.trim() || item.id.length > 512 ||
      typeof item.eventId !== "string" || !item.eventId.trim() || item.eventId.length > 256 ||
      !Number.isSafeInteger(item.revision) || item.revision < 1 ||
      typeof item.previousLabel !== "string" || !item.previousLabel.trim() || item.previousLabel.length > 512 ||
      typeof item.newLabel !== "string" || !item.newLabel.trim() || item.newLabel.length > 512 ||
      typeof item.changedBy !== "string" || !item.changedBy.trim() || item.changedBy.length > 256 ||
      (item.changeReason !== undefined && item.changeReason !== null &&
        (typeof item.changeReason !== "string" || item.changeReason.length > 4096)) ||
      typeof item.changedAt !== "number" || !Number.isFinite(item.changedAt) || item.changedAt < 0) {
    throw new Error("Registro de ciclo de vida de acontecimiento inválido.");
  }
  for (const [participants, label] of [
    [item.previousParticipants, "anteriores"],
    [item.newParticipants, "nuevos"]
  ]) {
    if (!Array.isArray(participants) || participants.length > 500 ||
        participants.some(id => typeof id !== "string" || !id.trim() || id.length > 256) ||
        new Set(participants).size !== participants.length ||
        participants.some((id, index) => index > 0 && participants[index - 1].localeCompare(id, "en") > 0)) {
      throw new Error("Los participantes " + label + " del historial de acontecimiento son inválidos o no están normalizados.");
    }
  }
  const changedParticipants = item.previousParticipants.length !== item.newParticipants.length ||
    !item.previousParticipants.every((id, index) => id === item.newParticipants[index]);
  if (item.previousLabel === item.newLabel && !changedParticipants) {
    throw new Error("Una transición de acontecimiento debe cambiar la etiqueta o los participantes.");
  }
}

function validateEventLifecycleHistory(records, projectId, eventId) {
  if (!Array.isArray(records)) throw new Error("El historial de acontecimiento no es una colección.");
  const ordered = [...records].sort((first, second) => first.revision - second.revision);
  const ids = new Set();
  let previous;
  for (const item of ordered) {
    validateEventLifecycle(item, projectId);
    if (item.eventId !== eventId || ids.has(item.id) ||
        (!previous && item.revision !== 1) ||
        (previous && (
          item.revision !== previous.revision + 1 ||
          item.previousLabel !== previous.newLabel ||
          item.previousParticipants.length !== previous.newParticipants.length ||
          !item.previousParticipants.every((id, index) => id === previous.newParticipants[index]) ||
          item.changedAt < previous.changedAt
        ))) {
      throw new Error("El historial de acontecimiento contiene revisiones duplicadas o transiciones discontinuas.");
    }
    ids.add(item.id);
    previous = item;
  }
  return ordered;
}

function validateNarrativeAssertion(assertion, projectId) {
  requireProjectRecord(assertion, "afirmación narrativa");
  if (assertion.projectId !== projectId || typeof assertion.entityId !== "string" ||
      !assertion.entityId.trim() || typeof assertion.entityName !== "string" ||
      !assertion.entityName.trim() || !["age", "location", "role"].includes(assertion.attribute) ||
      (assertion.attribute === "age"
        ? typeof assertion.value !== "number" || !Number.isFinite(assertion.value) || assertion.value < 0
        : typeof assertion.value !== "string" || !assertion.value.trim()) ||
      !Number.isFinite(assertion.capturedAt) || assertion.capturedAt < 0) {
    throw new Error("Afirmación narrativa malformada.");
  }
  validateEvidenceList([assertion.evidence], "afirmación narrativa");
}
function validatePersonalIdeaContext(context, projectId, sourceProjectName) {
  if (!context || context.version !== 1 || !Array.isArray(context.relatedIdeas) ||
      !Array.isArray(context.relatedEntities)) {
    throw new Error("Contexto de biblioteca personal inválido.");
  }
  const ideaIds = new Set();
  for (const idea of context.relatedIdeas) {
    validateNarrativeIdea(idea, projectId, "idea contextual");
    if (idea.sourceProjectName !== sourceProjectName || idea.status === "IDEA" || ideaIds.has(idea.id)) {
      throw new Error("La biblioteca contiene una idea contextual duplicada o pendiente.");
    }
    ideaIds.add(idea.id);
  }
  for (const entity of context.relatedEntities) validateNarrativeEntity(entity, projectId, "entidad contextual");
  validateEntitySnapshotHistory(context.relatedEntities);
  const entityIds = new Set(context.relatedEntities.map(entity => entity.id));
  for (const idea of context.relatedIdeas) {
    if ((idea.relatedEntityIds ?? []).some(id => !entityIds.has(id))) {
      throw new Error("Una idea contextual conserva una referencia a una ficha no archivada.");
    }
  }
}
function remapPersonalIdeaEntriesForEntityMerge(entries, writerId, projectId, sourceEntityId, mergedEntity) {
  if (!Array.isArray(entries)) throw new Error("No se pudo leer la biblioteca de ideas del proyecto.");
  const identities = new Set();
  const archivedIdeaIds = new Set();
  for (const entry of entries) {
    if (!entry || entry.writerId !== writerId || entry.sourceProjectId !== projectId ||
        typeof entry.sourceProjectName !== "string" || !entry.sourceProjectName.trim() ||
        entry.category !== entry.sourceProjectName || !entry.idea ||
        entry.idea.sourceProjectName !== entry.sourceProjectName || entry.idea.status !== "IDEA" ||
        !Number.isFinite(entry.archivedAt) || entry.archivedAt < 0) {
      throw new Error("Biblioteca personal: registro ajeno o malformado.");
    }
    validateNarrativeIdea(entry.idea, projectId, "idea archivada");
    if (identities.has(entry.idea.id)) throw new Error("Biblioteca personal: ideas archivadas duplicadas.");
    identities.add(entry.idea.id);
    archivedIdeaIds.add(entry.idea.id);
  }
  const absorbedIds = new Set([sourceEntityId, ...(mergedEntity.mergedFromIds ?? [])]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const entry of entries) {
      if (!entry.context) continue;
      validatePersonalIdeaContext(entry.context, projectId, entry.sourceProjectName);
      for (const snapshot of entry.context.relatedEntities) {
        const belongs = absorbedIds.has(snapshot.id) ||
          (snapshot.mergedFromIds ?? []).some(id => absorbedIds.has(id));
        if (!belongs) continue;
        if (!absorbedIds.has(snapshot.id)) { absorbedIds.add(snapshot.id); expanded = true; }
        for (const id of snapshot.mergedFromIds ?? []) {
          if (!absorbedIds.has(id)) { absorbedIds.add(id); expanded = true; }
        }
      }
    }
  }
  const mergedIdentityIds = new Set([mergedEntity.id, ...absorbedIds]);
  return entries.map(entry => {
    if (!entry.context) {
      const current = entry.idea.relatedEntityIds ?? [];
      if (!current.some(id => absorbedIds.has(id))) return entry;
      return {
        ...entry,
        idea: { ...entry.idea, relatedEntityIds: [...new Set(current.map(id => absorbedIds.has(id) ? mergedEntity.id : id))] }
      };
    }
    validatePersonalIdeaContext(entry.context, projectId, entry.sourceProjectName);
    const contextIdeaIds = new Set(entry.context.relatedIdeas.map(idea => idea.id));
    const contextEntityIds = new Set(entry.context.relatedEntities.map(entity => entity.id));
    if (contextIdeaIds.has(entry.idea.id) || [...contextIdeaIds].some(id => archivedIdeaIds.has(id))) {
      throw new Error("La biblioteca repite una idea archivada dentro del contexto.");
    }
    for (const idea of [entry.idea, ...entry.context.relatedIdeas]) {
      if ((idea.relatedEntityIds ?? []).some(id => !contextEntityIds.has(id)) ||
          (idea.relatedIdeaIds ?? []).some(id => !contextIdeaIds.has(id) && !archivedIdeaIds.has(id))) {
        throw new Error("Biblioteca personal: hay referencias históricas sin destino resoluble.");
      }
    }
    const identityIds = new Set(mergedIdentityIds);
    const selected = new Map();
    let changed = true;
    while (changed) {
      changed = false;
      for (const snapshot of entry.context.relatedEntities) {
        if (selected.has(snapshot.id)) continue;
        if (!identityIds.has(snapshot.id) &&
            !(snapshot.mergedFromIds ?? []).some(id => identityIds.has(id))) continue;
        selected.set(snapshot.id, snapshot);
        identityIds.add(snapshot.id);
        for (const id of snapshot.mergedFromIds ?? []) identityIds.add(id);
        changed = true;
      }
    }
    const referencesMerged = [entry.idea, ...entry.context.relatedIdeas].some(idea =>
      (idea.relatedEntityIds ?? []).some(id => identityIds.has(id))
    );
    if (referencesMerged && selected.size === 0) {
      throw new Error("Una idea archivada referencia una identidad sin instantánea histórica.");
    }
    if (selected.size === 0) return entry;
    const snapshots = [...selected.values()];
    if (snapshots.some(snapshot => snapshot.kind !== mergedEntity.kind)) {
      throw new Error("Una instantánea histórica pertenece a otra clase de entidad.");
    }
    const aliases = [...new Map(
      [...mergedEntity.aliases, ...snapshots.flatMap(snapshot => [snapshot.canonicalName, ...snapshot.aliases])]
        .map(alias => [normalizeNarrativeName(alias), alias])
    ).values()].filter(alias => alias && normalizeNarrativeName(alias) !== mergedEntity.normalizedName);
    const mergedFromIds = [...new Set([
      ...(mergedEntity.mergedFromIds ?? []),
      ...snapshots.flatMap(snapshot => [snapshot.id, ...(snapshot.mergedFromIds ?? [])])
    ])].filter(id => id !== mergedEntity.id);
    const evidence = new Map();
    for (const item of [...mergedEntity.evidence, ...snapshots.flatMap(snapshot => snapshot.evidence)]) evidence.set(evidenceKey(item), item);
    const contextualEntity = {
      ...mergedEntity, aliases, mergedFromIds, evidence: [...evidence.values()],
      firstSeenAt: Math.min(mergedEntity.firstSeenAt, ...snapshots.map(item => item.firstSeenAt)),
      lastSeenAt: Math.max(mergedEntity.lastSeenAt, ...snapshots.map(item => item.lastSeenAt))
    };
    validateNarrativeEntity(contextualEntity, projectId, "entidad contextual consolidada");
    const remapIdea = idea => ({
      ...idea,
      ...(idea.relatedEntityIds ? {
        relatedEntityIds: [...new Set(idea.relatedEntityIds.map(id => identityIds.has(id) ? mergedEntity.id : id))]
      } : {})
    });
    const relatedEntities = [
      ...entry.context.relatedEntities.filter(entity => !selected.has(entity.id)),
      contextualEntity
    ].sort((a, b) => a.id.localeCompare(b.id));
    validateEntitySnapshotHistory(relatedEntities);
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


export class SqliteProjectStore {
  constructor(database, databasePath) {
    this.database = database;
    this.databasePath = databasePath;
    this.transactionDepth = 0;
    this.closed = false;

    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA trusted_schema = OFF");
    database.exec(
      "CREATE TABLE IF NOT EXISTS " + TABLE + " (" +
      "collection TEXT NOT NULL," +
      "record_key TEXT NOT NULL," +
      "project_id TEXT," +
      "writer_id TEXT," +
      "document_id TEXT," +
      "sequence INTEGER," +
      "sort_key TEXT," +
      "value_json TEXT NOT NULL," +
      "PRIMARY KEY (collection, record_key)" +
      ") WITHOUT ROWID"
    );
    database.exec("CREATE INDEX IF NOT EXISTS bridge_records_project ON " + TABLE + "(collection, project_id)");
    database.exec("CREATE INDEX IF NOT EXISTS bridge_records_project_key ON " + TABLE + "(collection, project_id, record_key)");
    // Las bases existentes se migran en lotes repetibles: si el proceso se
    // interrumpe, la siguiente apertura continúa con los registros sin sort_key.
    const columns = database.prepare("PRAGMA table_info(" + TABLE + ")").all();
    if (!columns.some(column => column.name === "sort_key")) {
      database.exec("ALTER TABLE " + TABLE + " ADD COLUMN sort_key TEXT");
    }
    const missingLibraryKeys = database.prepare(
      "SELECT record_key, value_json FROM " + TABLE +
      " WHERE collection = ? AND sort_key IS NULL ORDER BY record_key LIMIT ?"
    );
    const updateLibraryKey = database.prepare(
      "UPDATE " + TABLE + " SET sort_key = ? WHERE collection = ? AND record_key = ?"
    );
    while (true) {
      const batch = missingLibraryKeys.all("personal-idea-library", ARCHIVE_PAGE_SIZE);
      if (batch.length === 0) break;
      for (const row of batch) {
        const entry = JSON.parse(row.value_json);
        if (!entry || typeof entry.sourceProjectId !== "string" ||
            typeof entry.idea?.id !== "string") {
          throw new Error("Biblioteca SQLite inconsistente: no se puede reconstruir la clave de orden.");
        }
        updateLibraryKey.run(
          personalIdeaLibrarySortKey(entry.sourceProjectId, entry.idea.id),
          "personal-idea-library",
          row.record_key
        );
      }
    }
    database.exec(
      "CREATE INDEX IF NOT EXISTS bridge_records_personal_library_page ON " + TABLE +
      "(collection, writer_id, sort_key) WHERE collection = 'personal-idea-library'"
    );
    database.exec("CREATE INDEX IF NOT EXISTS bridge_records_writer ON " + TABLE + "(collection, writer_id)");
    database.exec("CREATE INDEX IF NOT EXISTS bridge_records_document ON " + TABLE + "(collection, project_id, document_id, sequence)");
    database.exec(
      "CREATE TABLE IF NOT EXISTS bridge_document_heads (" +
      "project_id TEXT NOT NULL, document_id TEXT NOT NULL, sequence INTEGER NOT NULL, " +
      "revision INTEGER NOT NULL, text_length INTEGER NOT NULL, " +
      "PRIMARY KEY(project_id, document_id)" +
      ") WITHOUT ROWID"
    );
    database.exec(
      "CREATE TABLE IF NOT EXISTS bridge_metadata (" +
      "key TEXT PRIMARY KEY NOT NULL," +
      "value TEXT NOT NULL" +
      ") WITHOUT ROWID"
    );
    const version = database.prepare("SELECT value FROM bridge_metadata WHERE key = ?").get("schema_version");
    if (!version) {
      database.prepare("INSERT INTO bridge_metadata(key, value) VALUES(?, ?)").run("schema_version", "1");
    } else if (version.value !== "1") {
      throw new Error("Versión SQLite del puente no compatible: " + version.value);
    }
  }

  static async open(databasePath) {
    requireText(databasePath, "MOTOR_LITERARIO_DB");
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
    const handle = await openFile(databasePath, "a", 0o600);
    await handle.close();
    // El anfitrión debe mantener la carpeta de datos privada para proteger
    // también los archivos auxiliares -wal y -shm. En Windows se aplican ACL.
    try { await chmod(databasePath, 0o600); } catch { /* Algunos entornos no admiten chmod completo. */ }
    const database = new DatabaseSync(databasePath);
    return new SqliteProjectStore(database, databasePath);
  }

  ensureOpen() {
    if (this.closed) throw new Error("El almacenamiento SQLite del puente está cerrado.");
  }

  transaction(work) {
    this.ensureOpen();
    if (this.transactionDepth > 0) return work();
    this.database.exec("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* La transacción pudo haberse abortado. */ }
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  get(collection, parts) {
    this.ensureOpen();
    const row = this.database.prepare(
      "SELECT value_json FROM " + TABLE + " WHERE collection = ? AND record_key = ?"
    ).get(collection, encodedKey(parts));
    return row ? JSON.parse(row.value_json) : undefined;
  }

  all(collection) {
    this.ensureOpen();
    return this.database.prepare(
      "SELECT value_json FROM " + TABLE + " WHERE collection = ? ORDER BY record_key"
    ).all(collection).map(row => JSON.parse(row.value_json));
  }

  find(collection, predicate) {
    return this.all(collection).filter(predicate);
  }

  loadProjectPage(collection, projectId, afterRecordKey = "", pageSize = ARCHIVE_PAGE_SIZE) {
    requireProject(projectId);
    if (typeof collection !== "string" || !collection.trim() ||
        typeof afterRecordKey !== "string" ||
        !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 512) {
      throw new Error("Parámetros de paginación de proyecto inválidos.");
    }
    const rows = this.database.prepare(
      "SELECT record_key, value_json FROM " + TABLE +
      " WHERE collection = ? AND project_id = ? AND record_key > ? ORDER BY record_key LIMIT ?"
    ).all(collection, projectId, afterRecordKey, pageSize + 1);
    const hasMore = rows.length > pageSize;
    const selected = hasMore ? rows.slice(0, pageSize) : rows;
    return {
      items: selected.map(row => JSON.parse(row.value_json)),
      nextCursor: hasMore ? selected[selected.length - 1].record_key : null
    };
  }

  /** Recorre páginas sin acumularlas; el visitante solo retiene sus propios resultados. */
  forEachProjectPage(collection, projectId, visit, pageSize = ARCHIVE_PAGE_SIZE) {
    if (typeof visit !== "function") throw new TypeError("El visitante de páginas debe ser una función.");
    let cursor = "";
    while (true) {
      const page = this.loadProjectPage(collection, projectId, cursor, pageSize);
      if (!page || !Array.isArray(page.items)) {
        throw new Error("El almacenamiento devolvió una página de proyecto inválida.");
      }
      for (const item of page.items) visit(item);
      if (page.nextCursor === null) return;
      if (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor === cursor) {
        throw new Error("El cursor de paginación no avanza de forma estricta.");
      }
      cursor = page.nextCursor;
    }
  }

  put(collection, parts, value, options = {}) {
    this.ensureOpen();
    const key = encodedKey(parts);
    const current = this.get(collection, parts);
    if (options.expectedCurrent !== undefined) {
      if (!current || !sameValue(current, options.expectedCurrent)) {
        throw new Error(options.conflictMessage || "Conflicto de actualización: el registro cambió desde la lectura.");
      }
    } else if (options.insertOnly && current !== undefined) {
      throw new Error(options.conflictMessage || "El registro ya existe; no se sobrescribió.");
    }
    if (options.unique) {
      for (const record of this.all(collection)) {
        if (sameValue(options.unique(record), options.unique(value)) &&
            !sameValue(options.keyOf(record), options.keyOf(value))) {
          throw new Error(options.uniqueMessage || "Conflicto de unicidad en " + collection + ".");
        }
      }
    }
    const projectId = typeof value?.projectId === "string" ? value.projectId : null;
    const writerId = typeof value?.writerId === "string" ? value.writerId : null;
    const documentId = typeof value?.documentId === "string" ? value.documentId : null;
    const sequence = Number.isSafeInteger(value?.sequence) ? value.sequence : null;
    let sortKey = null;
    if (collection === "personal-idea-library") {
      if (typeof value?.writerId !== "string" || !value.writerId.trim() ||
          typeof value?.sourceProjectId !== "string" || !value.sourceProjectId.trim() ||
          typeof value?.idea?.id !== "string" || !value.idea.id.trim()) {
        throw new Error("Entrada de biblioteca inválida: faltan escritor, libro o ID de idea.");
      }
      sortKey = personalIdeaLibrarySortKey(value.sourceProjectId, value.idea.id);
    }
    this.database.prepare(
      "INSERT INTO " + TABLE + "(collection, record_key, project_id, writer_id, document_id, sequence, sort_key, value_json) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(collection, record_key) DO UPDATE SET " +
      "project_id=excluded.project_id, writer_id=excluded.writer_id, document_id=excluded.document_id, " +
      "sequence=excluded.sequence, sort_key=excluded.sort_key, value_json=excluded.value_json"
    ).run(collection, key, projectId, writerId, documentId, sequence, sortKey, JSON.stringify(value));
    if (projectId && NARRATIVE_COLLECTIONS.has(collection)) this.bumpNarrativeVersion(projectId);
    if (writerId && WRITER_LIBRARY_COLLECTIONS.has(collection)) this.bumpWriterLibraryVersion(writerId);
    return clone(value);
  }

  bumpNarrativeVersion(projectId) {
    requireProject(projectId);
    this.ensureOpen();
    this.database.prepare(
      "INSERT INTO bridge_metadata(key, value) VALUES(?, '1') " +
      "ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1"
    ).run("narrative-version:" + projectId);
  }

  getNarrativeVersion(projectId) {
    requireProject(projectId);
    this.ensureOpen();
    const row = this.database.prepare(
      "SELECT value FROM bridge_metadata WHERE key = ?"
    ).get("narrative-version:" + projectId);
    if (!row) return 0;
    const version = Number(row.value);
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error("La versión de conocimiento narrativo almacenada es inválida.");
    }
    return version;
  }

  bumpWriterLibraryVersion(writerId) {
    requireText(writerId, "writerId");
    this.ensureOpen();
    this.database.prepare(
      "INSERT INTO bridge_metadata(key, value) VALUES(?, '1') " +
      "ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1"
    ).run("writer-library-version:" + writerId);
  }

  getWriterLibraryVersion(writerId) {
    requireText(writerId, "writerId");
    this.ensureOpen();
    const row = this.database.prepare(
      "SELECT value FROM bridge_metadata WHERE key = ?"
    ).get("writer-library-version:" + writerId);
    if (!row) return 0;
    const version = Number(row.value);
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error("La versión de biblioteca del escritor almacenada es inválida.");
    }
    return version;
  }

  getDataVersion() {
    this.ensureOpen();
    const row = this.database.prepare("PRAGMA data_version").get();
    const version = Number(row?.data_version);
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error("SQLite no devolvió una versión válida de la base de datos.");
    }
    return version;
  }

  remove(collection, parts) {
    this.ensureOpen();
    const result = this.database.prepare(
      "DELETE FROM " + TABLE + " WHERE collection = ? AND record_key = ?"
    ).run(collection, encodedKey(parts));
    if (Number(result.changes) > 0) {
      if (NARRATIVE_COLLECTIONS.has(collection)) {
        const projectId = Array.isArray(parts) ? parts[0] : undefined;
        if (typeof projectId === "string" && projectId.trim()) this.bumpNarrativeVersion(projectId);
      }
      if (WRITER_LIBRARY_COLLECTIONS.has(collection)) {
        const writerId = Array.isArray(parts) ? parts[0] : undefined;
        if (typeof writerId === "string" && writerId.trim()) this.bumpWriterLibraryVersion(writerId);
      }
    }
  }

  removeWhere(collection, predicate) {
    const rows = this.all(collection).filter(predicate);
    for (const row of rows) this.remove(collection, keyForCollection(collection, row));
    return rows.length;
  }

  saveSimple(collection, record, expectedCurrent, label = collection) {
    requireProjectRecord(record, label);
    return this.transaction(() => {
      if (expectedCurrent) requireProjectRecord(expectedCurrent, label + " anterior");
      return this.put(collection, identityKey(record.projectId, record.id), record, {
        expectedCurrent,
        conflictMessage: "Conflicto al guardar " + label + ": el registro cambió desde la lectura."
      });
    });
  }

  loadProject(collection, projectId, label = collection) {
    requireProject(projectId);
    const values = this.database.prepare(
      "SELECT value_json FROM " + TABLE + " WHERE collection = ? AND project_id = ? ORDER BY record_key"
    ).all(collection, projectId).map(row => JSON.parse(row.value_json));
    const ids = new Set();
    for (const item of values) {
      requireProjectRecord(item, label);
      if (item.projectId !== projectId) throw new Error("Violación de aislamiento en " + label + ".");
      if (ids.has(item.id)) throw new Error("IDs duplicados en " + label + ".");
      ids.add(item.id);
    }
    return clone(values);
  }

  loadProjectSettings(projectId) {
    requireProject(projectId);
    return clone(this.find("project-settings", item => item.projectId === projectId));
  }

  saveProjectSetting(setting, expectedCurrent) {
    if (!setting || typeof setting.projectId !== "string" || !setting.projectId.trim() ||
        typeof setting.key !== "string" || !setting.key.trim()) throw new Error("Configuración de proyecto inválida.");
    return this.transaction(() => this.put("project-settings", [setting.projectId, setting.key], setting, { expectedCurrent }));
  }

  loadLanguageProfiles(projectId) { return this.loadProject("language-profiles", projectId); }
  saveLanguageProfile(profile, expectedCurrent) {
    return this.transaction(() => {
      if (profile.isActive) {
        for (const existing of this.find("language-profiles", x =>
          x.projectId === profile.projectId && x.languageIdentifier === profile.languageIdentifier &&
          x.isActive && x.id !== profile.id
        )) this.put("language-profiles", identityKey(existing.projectId, existing.id), { ...existing, isActive: false });
      }
      return this.saveSimple("language-profiles", profile, expectedCurrent, "perfil lingüístico");
    });
  }

  loadLanguageResourceRefs(projectId, profileId) {
    return this.loadProject("language-resource-refs", projectId).filter(item =>
      profileId === undefined || item.profileId === profileId
    );
  }

  saveLanguageResourceRef(resource, expectedCurrent) {
    requireProjectRecord(resource, "referencia lingüística");
    if (resource.profileId && !this.get("language-profiles", identityKey(resource.projectId, resource.profileId))) {
      throw new Error("El perfil lingüístico asociado no existe en el proyecto.");
    }
    return this.saveSimple("language-resource-refs", resource, expectedCurrent, "referencia lingüística");
  }

  loadRecordLifecycles(projectId, recordId) {
    requireProject(projectId);
    return clone(this.find("record-lifecycles", x => x.projectId === projectId && x.recordId === recordId)
      .sort((a, b) => a.revision - b.revision));
  }

  appendRecordLifecycle(item) {
    requireProjectRecord(item, "historial de ficha");
    return this.transaction(() => {
      if (!this.get("project-records", identityKey(item.projectId, item.recordId))) {
        throw new Error("La ficha del historial no existe en el proyecto.");
      }
      const history = this.loadRecordLifecycles(item.projectId, item.recordId);
      const expectedRevision = history.length ? history[history.length - 1].revision + 1 : 1;
      if (item.revision !== expectedRevision) throw new Error("La revisión del historial de ficha debe ser consecutiva.");
      this.put("record-lifecycles", [item.projectId, item.recordId, item.revision], item, { insertOnly: true });
    });
  }

  loadEventLifecycles(projectId, eventId) {
    requireProject(projectId);
    requireText(eventId, "eventId");
    const event = this.get("narrative-events", identityKey(projectId, eventId));
    if (!event) throw new Error("No existe el acontecimiento solicitado en el proyecto.");
    validateNarrativeEvent(event, projectId);
    const history = this.find("event-lifecycles", item =>
      item.projectId === projectId && item.eventId === eventId
    );
    return clone(validateEventLifecycleHistory(history, projectId, eventId));
  }

  loadProjectEventLifecycles(projectId) {
    requireProject(projectId);
    const events = new Map(this.loadEvents(projectId).map(event => [event.id, event]));
    const history = this.loadProject("event-lifecycles", projectId, "historial de acontecimiento");
    const grouped = new Map();
    for (const item of history) {
      validateEventLifecycle(item, projectId);
      if (!events.has(item.eventId)) {
        throw new Error("El historial de acontecimiento referencia un evento inexistente.");
      }
      const rows = grouped.get(item.eventId) ?? [];
      rows.push(item);
      grouped.set(item.eventId, rows);
    }
    const ordered = [];
    for (const [eventId, rows] of grouped) {
      ordered.push(...validateEventLifecycleHistory(rows, projectId, eventId));
    }
    return clone(ordered.sort((first, second) =>
      first.eventId.localeCompare(second.eventId, "en") || first.revision - second.revision
    ));
  }

  saveEventAndAppendLifecycleIfUnchanged(event, expectedCurrent, lifecycle) {
    requireProjectRecord(event, "acontecimiento narrativo");
    requireProjectRecord(expectedCurrent, "acontecimiento anterior");
    validateNarrativeEvent(event, event.projectId);
    validateNarrativeEvent(expectedCurrent, event.projectId);
    validateEventLifecycle(lifecycle, event.projectId);
    const normalizeParticipants = values => [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
    if (event.id !== expectedCurrent.id ||
        lifecycle.eventId !== event.id ||
        lifecycle.previousLabel !== expectedCurrent.label ||
        lifecycle.newLabel !== event.label ||
        JSON.stringify(lifecycle.previousParticipants) !== JSON.stringify(normalizeParticipants(expectedCurrent.participants)) ||
        JSON.stringify(lifecycle.newParticipants) !== JSON.stringify(normalizeParticipants(event.participants))) {
      throw new Error("La transición versionada no coincide con el cambio real del acontecimiento.");
    }

    return this.transaction(() => {
      const current = this.get("narrative-events", identityKey(event.projectId, event.id));
      if (!current || !sameValue(current, expectedCurrent)) {
        throw new Error("El acontecimiento cambió en otra instancia; actualiza la vista antes de registrar su evolución.");
      }
      for (const id of event.participants) {
        if (!this.get("narrative-entities", identityKey(event.projectId, id))) {
          throw new Error("El acontecimiento contiene un participante que no existe en el proyecto.");
        }
      }
      if (event.timelineTrackId &&
          !this.get("timeline-tracks", identityKey(event.projectId, event.timelineTrackId))) {
        throw new Error("La pista cronológica del acontecimiento no existe.");
      }
      const history = this.loadEventLifecycles(event.projectId, event.id);
      const previous = history[history.length - 1];
      if (!previous) {
        if (lifecycle.revision !== 1) {
          throw new Error("La primera transición de acontecimiento debe comenzar en revisión 1.");
        }
      } else if (lifecycle.revision !== previous.revision + 1 ||
          lifecycle.previousLabel !== previous.newLabel ||
          lifecycle.previousParticipants.length !== previous.newParticipants.length ||
          !lifecycle.previousParticipants.every((id, index) => id === previous.newParticipants[index]) ||
          lifecycle.changedAt < previous.changedAt) {
        throw new Error("La transición de acontecimiento no continúa la última revisión durable.");
      }
      if (history.some(item => item.id === lifecycle.id)) {
        throw new Error("El ID de la transición de acontecimiento ya existe.");
      }
      this.put("narrative-events", identityKey(event.projectId, event.id), event, {
        expectedCurrent,
        conflictMessage: "El acontecimiento cambió en otra instancia; actualiza la vista antes de registrar su evolución."
      });
      this.put("event-lifecycles", [event.projectId, event.id, lifecycle.revision], lifecycle, {
        insertOnly: true,
        conflictMessage: "La transición de acontecimiento ya existe y no puede reemplazarse."
      });
    });
  }

  loadRelationLifecycles(projectId, relationId) {
    requireProject(projectId);
    return clone(this.find("relation-lifecycles", x => x.projectId === projectId && x.relationId === relationId)
      .sort((a, b) => a.revision - b.revision));
  }

  appendRelationLifecycle(item) {
    requireProjectRecord(item, "historial de relación");
    return this.transaction(() => {
      if (!this.get("project-relations", identityKey(item.projectId, item.relationId))) {
        throw new Error("La relación del historial no existe en el proyecto.");
      }
      const history = this.loadRelationLifecycles(item.projectId, item.relationId);
      const expectedRevision = history.length ? history[history.length - 1].revision + 1 : 1;
      if (item.revision !== expectedRevision) throw new Error("La revisión del historial de relación debe ser consecutiva.");
      this.put("relation-lifecycles", [item.projectId, item.relationId, item.revision], item, { insertOnly: true });
    });
  }

  loadProjectRelations(projectId) { return this.loadProject("project-relations", projectId, "relación MLDB"); }

  saveProjectRelation(relation, expectedCurrent) {
    requireProjectRecord(relation, "relación MLDB");
    return this.transaction(() => {
      for (const parentId of [relation.sourceRecordId, relation.targetRecordId]) {
        if (parentId && !this.get("project-records", identityKey(relation.projectId, parentId))) {
          throw new Error("La relación apunta a una ficha inexistente del proyecto.");
        }
      }
      if (expectedCurrent && relation.currentVersion !== expectedCurrent.currentVersion + 1) {
        throw new Error("La versión de la relación debe avanzar exactamente una unidad.");
      }
      return this.put("project-relations", identityKey(relation.projectId, relation.id), relation, { expectedCurrent });
    });
  }

  loadProjectEvidences(projectId, subjectKind, subjectId) {
    return this.loadProject("project-evidences", projectId, "evidencia MLDB").filter(item =>
      (subjectKind === undefined || item.subjectKind === subjectKind) &&
      (subjectId === undefined || item.subjectRecordId === subjectId || item.subjectRelationId === subjectId)
    );
  }

  saveProjectEvidence(evidence, expectedCurrent) {
    requireProjectRecord(evidence, "evidencia MLDB");
    return this.transaction(() => {
      if (evidence.subjectKind === "RECORD" && evidence.subjectRecordId &&
          !this.get("project-records", identityKey(evidence.projectId, evidence.subjectRecordId))) {
        throw new Error("La ficha sujeto de la evidencia no existe.");
      }
      if (evidence.subjectKind === "RELATION" && evidence.subjectRelationId &&
          !this.get("project-relations", identityKey(evidence.projectId, evidence.subjectRelationId))) {
        throw new Error("La relación sujeto de la evidencia no existe.");
      }
      if (evidence.documentId && !this.get("documents", identityKey(evidence.projectId, evidence.documentId))) {
        throw new Error("El documento de la evidencia no existe en el proyecto.");
      }
      if (evidence.fragmentId && !this.get("manuscript-fragments", identityKey(evidence.projectId, evidence.fragmentId))) {
        throw new Error("El fragmento de la evidencia no existe en el proyecto.");
      }
      return this.put("project-evidences", identityKey(evidence.projectId, evidence.id), evidence, { expectedCurrent });
    });
  }

  loadTimelineOccurrences(projectId, eventRecordId, trackId) {
    return this.loadProject("timeline-occurrences", projectId, "ocurrencia cronológica").filter(item =>
      (eventRecordId === undefined || item.eventRecordId === eventRecordId) &&
      (trackId === undefined || item.trackId === trackId)
    );
  }

  saveTimelineOccurrence(occurrence, expectedCurrent) {
    requireProjectRecord(occurrence, "ocurrencia cronológica");
    return this.transaction(() => {
      if (occurrence.eventRecordId && !this.get("project-records", identityKey(occurrence.projectId, occurrence.eventRecordId))) {
        throw new Error("El acontecimiento de la ocurrencia no existe en el proyecto.");
      }
      if (occurrence.trackId && !this.get("timeline-tracks", identityKey(occurrence.projectId, occurrence.trackId))) {
        throw new Error("La pista cronológica no existe en el proyecto.");
      }
      return this.put("timeline-occurrences", identityKey(occurrence.projectId, occurrence.id), occurrence, { expectedCurrent });
    });
  }

  loadProjectRecords(projectId) { return this.loadProject("project-records", projectId, "ficha MLDB"); }

  saveProjectRecord(record, expectedCurrent) {
    requireProjectRecord(record, "ficha MLDB");
    return this.transaction(() => {
      const current = this.get("project-records", identityKey(record.projectId, record.id));
      if (expectedCurrent && (!current || !sameValue(current, expectedCurrent))) {
        throw new Error("Conflicto al guardar la ficha: cambió desde la lectura.");
      }
      if (current && expectedCurrent && record.currentVersion !== expectedCurrent.currentVersion + 1) {
        throw new Error("La versión de la ficha debe avanzar exactamente una unidad.");
      }
      if (current && record.createdAt !== current.createdAt) throw new Error("La fecha de creación de una ficha es inmutable.");
      return this.put("project-records", identityKey(record.projectId, record.id), record, { expectedCurrent });
    });
  }

  loadRecordNames(projectId, recordId) {
    return this.loadProject("record-names", projectId, "nombre de ficha")
      .filter(item => recordId === undefined || item.recordId === recordId);
  }

  saveRecordName(name, expectedCurrent) {
    requireProjectRecord(name, "nombre de ficha");
    return this.transaction(() => {
      if (!this.get("project-records", identityKey(name.projectId, name.recordId))) {
        throw new Error("La ficha asociada al nombre no existe.");
      }
      const normalized = String(name.name).normalize("NFKC").trim().toLocaleLowerCase("es");
      for (const other of this.find("record-names", item => item.projectId === name.projectId && item.id !== name.id)) {
        if (String(other.name).normalize("NFKC").trim().toLocaleLowerCase("es") === normalized) {
          throw new Error("El nombre ya está asociado a otra ficha del proyecto.");
        }
      }
      return this.put("record-names", identityKey(name.projectId, name.id), name, { expectedCurrent });
    });
  }

  loadManuscriptFragments(projectId, documentId) {
    return this.loadProject("manuscript-fragments", projectId, "fragmento")
      .filter(item => documentId === undefined || item.documentId === documentId);
  }

  saveManuscriptFragment(fragment, expectedCurrent) {
    requireProjectRecord(fragment, "fragmento");
    return this.transaction(() => {
      if (fragment.documentId && !this.get("documents", identityKey(fragment.projectId, fragment.documentId))) {
        throw new Error("El documento del fragmento no existe.");
      }
      if (fragment.parentFragmentId &&
          !this.get("manuscript-fragments", identityKey(fragment.projectId, fragment.parentFragmentId))) {
        throw new Error("El fragmento padre no existe.");
      }
      return this.put("manuscript-fragments", identityKey(fragment.projectId, fragment.id), fragment, { expectedCurrent });
    });
  }

  loadRecordAttributes(projectId, recordId) {
    return this.loadProject("record-attributes", projectId, "atributo de ficha").filter(x => x.recordId === recordId);
  }

  saveRecordAttribute(attribute, expectedCurrent) {
    requireProjectRecord(attribute, "atributo de ficha");
    return this.transaction(() => {
      if (!this.get("project-records", identityKey(attribute.projectId, attribute.recordId))) {
        throw new Error("La ficha del atributo no existe.");
      }
      return this.put("record-attributes", identityKey(attribute.projectId, attribute.id), attribute, { expectedCurrent });
    });
  }

  loadRelationAttributes(projectId, relationId) {
    return this.loadProject("relation-attributes", projectId, "atributo de relación").filter(x => x.relationId === relationId);
  }

  saveRelationAttribute(attribute, expectedCurrent) {
    requireProjectRecord(attribute, "atributo de relación");
    return this.transaction(() => {
      if (!this.get("project-relations", identityKey(attribute.projectId, attribute.relationId))) {
        throw new Error("La relación del atributo no existe.");
      }
      return this.put("relation-attributes", identityKey(attribute.projectId, attribute.id), attribute, { expectedCurrent });
    });
  }

  loadActiveSuggestions(projectId, documentId, status) {
    return this.loadProject("active-suggestions", projectId, "sugerencia").filter(x =>
      (documentId === undefined || x.documentId === documentId) && (status === undefined || x.status === status)
    );
  }

  saveActiveSuggestion(suggestion, expectedCurrent) {
    requireProjectRecord(suggestion, "sugerencia");
    return this.transaction(() => {
      if (suggestion.documentId) {
        const document = this.get("documents", identityKey(suggestion.projectId, suggestion.documentId));
        if (!document) throw new Error("El documento de la sugerencia no existe.");
        if (suggestion.documentRevision !== undefined && suggestion.documentRevision !== null &&
            suggestion.documentRevision > document.revision) throw new Error("La sugerencia se refiere a una revisión futura.");
      }
      return this.put("active-suggestions", identityKey(suggestion.projectId, suggestion.id), suggestion, { expectedCurrent });
    });
  }

  loadImportAuthorizations(writerId) {
    requireText(writerId, "writerId");
    return clone(this.find("import-authorizations", item => item.writerId === writerId));
  }

  appendImportAuthorization(authorization) {
    requireText(authorization?.writerId, "writerId");
    requireText(authorization?.authorizationId, "authorizationId");
    if (authorization.sourceProjectId === authorization.targetProjectId) {
      throw new Error("No se puede autorizar una importación hacia el mismo proyecto.");
    }
    return this.transaction(() => this.put("import-authorizations", [
      authorization.writerId, authorization.sourceProjectId, authorization.targetProjectId, authorization.authorizationId
    ], authorization, { insertOnly: true, conflictMessage: "La autorización ya existe y es inmutable." }));
  }

  loadSchemaMigrations() {
    return clone(this.all("schema-migrations").sort((a, b) => a.appliedAt - b.appliedAt));
  }

  loadStyleProfiles(projectId) { return this.loadProject("style-profiles", projectId, "perfil de estilo"); }
  saveStyleProfile(profile, expectedCurrent) {
    return this.saveSimple("style-profiles", profile, expectedCurrent, "perfil de estilo");
  }

  loadTimelineTracks(projectId) { return this.loadProject("timeline-tracks", projectId, "pista cronológica"); }
  saveTimelineTrack(track, expectedCurrent) {
    return this.saveSimple("timeline-tracks", track, expectedCurrent, "pista cronológica");
  }

  saveDictionary(dictionary, expectedCurrent) {
    requireProjectRecord(dictionary, "diccionario");
    return this.transaction(() => {
      const normalized = String(dictionary.normalizedName ?? dictionary.name).normalize("NFKC").trim().toLocaleLowerCase("es");
      for (const existing of this.find("project-dictionaries", x => x.projectId === dictionary.projectId && x.id !== dictionary.id &&
        x.languageIdentifier === dictionary.languageIdentifier)) {
        const existingName = String(existing.normalizedName ?? existing.name).normalize("NFKC").trim().toLocaleLowerCase("es");
        if (existingName === normalized) throw new Error("Ya existe un diccionario con ese nombre e idioma.");
      }
      return this.put("project-dictionaries", identityKey(dictionary.projectId, dictionary.id), dictionary, { expectedCurrent });
    });
  }

  loadDictionaries(projectId) { return this.loadProject("project-dictionaries", projectId, "diccionario"); }

  saveDictionaryEntry(entry, expectedCurrent, suppliedLinks) {
    requireProjectRecord(entry, "entrada de diccionario");
    return this.transaction(() => {
      if (!this.get("project-dictionaries", identityKey(entry.projectId, entry.dictionaryId))) {
        throw new Error("El diccionario de la entrada no existe.");
      }
      const normalized = String(entry.normalizedForm ?? entry.surfaceForm).normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("es");
      for (const existing of this.find("dictionary-entries", x => x.projectId === entry.projectId &&
        x.dictionaryId === entry.dictionaryId && x.id !== entry.id)) {
        const existingNormalized = String(existing.normalizedForm ?? existing.surfaceForm)
          .normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("es");
        if (existingNormalized === normalized) throw new Error("La forma normalizada ya existe en el diccionario.");
      }
      const relatedIds = new Set(entry.relatedEntityIds ?? []);
      for (const link of this.loadDictionaryEntryEntityLinks(entry.projectId, entry.id)) relatedIds.add(link.recordId);
      for (const link of suppliedLinks ?? []) {
        if (link.projectId !== entry.projectId || link.entryId !== entry.id) {
          throw new Error("El vínculo de diccionario no pertenece a la entrada que se está guardando.");
        }
        if (!this.get("narrative-entities", identityKey(entry.projectId, link.recordId))) {
          throw new Error("La ficha enlazada al término no existe en el mismo proyecto.");
        }
        relatedIds.add(link.recordId);
        this.put("dictionary-entry-entities", [link.projectId, link.entryId, link.recordId], link);
      }
      const stored = { ...entry, relatedEntityIds: [...relatedIds] };
      return this.put("dictionary-entries", identityKey(entry.projectId, entry.id), stored, { expectedCurrent });
    });
  }

  loadDictionaryEntries(projectId, dictionaryId) {
    return this.loadProject("dictionary-entries", projectId, "entrada de diccionario")
      .filter(item => item.dictionaryId === dictionaryId);
  }

  loadDictionaryEntryEntityLinks(projectId, entryId) {
    requireProject(projectId);
    return clone(this.find("dictionary-entry-entities", item =>
      item.projectId === projectId && item.entryId === entryId
    ));
  }

  setDictionaryEntryEntityLink(entry, expectedCurrent, link, linked) {
    requireProjectRecord(entry, "entrada de diccionario");
    requireProjectRecord(expectedCurrent, "entrada anterior");
    return this.transaction(() => {
      const current = this.get("dictionary-entries", identityKey(entry.projectId, entry.id));
      if (!current || !sameValue(current, expectedCurrent)) throw new Error("Conflicto al modificar el vínculo del diccionario.");
      if (link.projectId !== entry.projectId || link.entryId !== entry.id) throw new Error("Vínculo de diccionario fuera de la entrada activa.");
      if (linked) {
        if (!this.get("narrative-entities", identityKey(entry.projectId, link.recordId))) throw new Error("La ficha enlazada no existe.");
        this.put("dictionary-entry-entities", [link.projectId, link.entryId, link.recordId], link, { insertOnly: true });
      } else {
        this.remove("dictionary-entry-entities", [link.projectId, link.entryId, link.recordId]);
      }
      const links = this.loadDictionaryEntryEntityLinks(entry.projectId, entry.id);
      const ids = new Set(links.map(x => x.recordId));
      if (linked) for (const id of entry.relatedEntityIds ?? []) ids.add(id);
      else for (const id of entry.relatedEntityIds ?? []) if (id !== link.recordId) ids.add(id);
      const updated = { ...entry, relatedEntityIds: [...ids] };
      this.put("dictionary-entries", identityKey(entry.projectId, entry.id), updated, { expectedCurrent });
    });
  }

  mergeNarrativeEntityIdentity(projectId, targetEntityId, sourceEntityId, writerId) {
    requireProject(projectId);
    requireText(targetEntityId, "targetEntityId");
    requireText(sourceEntityId, "sourceEntityId");
    if (targetEntityId === sourceEntityId) throw new Error("Las entidades de origen y destino deben ser distintas.");
    if (writerId !== undefined) requireText(writerId, "writerId");
    return this.transaction(() => {
      const entities = this.loadEntities(projectId);
      const relations = this.loadRelations(projectId);
      const events = this.loadEvents(projectId);
      const assertions = this.loadAssertions(projectId);
      const ideas = this.loadIdeas(projectId);
      const libraryEntries = this.find("personal-idea-library", entry =>
        entry.sourceProjectId === projectId && (writerId === undefined || entry.writerId === writerId)
      );
      const finalizationReceipt = writerId
        ? this.get("writer-library-finalization-receipts", [writerId, projectId, "finalization-v1"])
        : undefined;
      for (const entity of entities) validateNarrativeEntity(entity, projectId);
      validateNarrativeIdentityHistory(entities);
      for (const relation of relations) validateNarrativeRelation(relation, projectId);
      for (const event of events) validateNarrativeEvent(event, projectId);
      for (const assertion of assertions) validateNarrativeAssertion(assertion, projectId);
      for (const idea of ideas) validateNarrativeIdea(idea, projectId);
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
        if (!entityIds.has(assertion.entityId)) throw new Error("La consolidación se rechazó: una afirmación referencia una entidad inexistente.");
      }
      const ideaIds = new Set(ideas.map(idea => idea.id));
      for (const idea of ideas) {
        if ((idea.relatedEntityIds ?? []).some(id => !entityIds.has(id)) ||
            (idea.relatedIdeaIds ?? []).some(id => !ideaIds.has(id))) {
          throw new Error("La consolidación se rechazó: el grafo de ideas contiene una referencia inexistente.");
        }
      }
      const target = entities.find(entity => entity.id === targetEntityId);
      const source = entities.find(entity => entity.id === sourceEntityId);
      if (!target || !source) throw new Error("Una de las entidades no existe en el proyecto activo.");
      if (target.kind !== source.kind) throw new Error("No se pueden consolidar entidades de tipos diferentes.");
      const names = new Set(
        [target.canonicalName, ...target.aliases, source.canonicalName, ...source.aliases]
          .map(normalizeNarrativeName)
      );
      const collision = entities.find(entity =>
        entity.id !== targetEntityId && entity.id !== sourceEntityId && entity.kind === target.kind &&
        [entity.canonicalName, ...entity.aliases].some(name => names.has(normalizeNarrativeName(name)))
      );
      if (collision) throw new Error("La consolidación produciría un alias ambiguo con otra entidad del proyecto.");
      const aliases = [...new Map(
        [...target.aliases, source.canonicalName, ...source.aliases]
          .map(alias => [normalizeNarrativeName(alias), alias])
      ).values()].filter(alias => alias && normalizeNarrativeName(alias) !== target.normalizedName);
      const mergedFromIds = [...new Set([
        ...(target.mergedFromIds ?? []), source.id, ...(source.mergedFromIds ?? [])
      ])];
      const mergedEvidence = new Map();
      for (const item of [...target.evidence, ...source.evidence]) mergedEvidence.set(evidenceKey(item), item);
      const mergedEntity = {
        ...target, aliases, mergedFromIds, evidence: [...mergedEvidence.values()],
        firstSeenAt: Math.min(target.firstSeenAt, source.firstSeenAt),
        lastSeenAt: Math.max(target.lastSeenAt, source.lastSeenAt)
      };
      validateNarrativeEntity(mergedEntity, projectId, "entidad consolidada");
      if (writerId === undefined && libraryEntries.length > 0) {
        throw new Error("Se requiere writerId para consolidar un libro con ideas ya archivadas.");
      }
      const remappedLibrary = writerId
        ? remapPersonalIdeaEntriesForEntityMerge(libraryEntries, writerId, projectId, sourceEntityId, mergedEntity)
        : [];
      let updatedFinalizationReceipt;
      if (finalizationReceipt) {
        const ids = finalizationReceipt.archivedIdeaIds;
        if (finalizationReceipt.writerId !== writerId ||
            finalizationReceipt.sourceProjectId !== projectId ||
            finalizationReceipt.receiptId !== "finalization-v1" ||
            !Array.isArray(ids) ||
            ids.some((id, index) => typeof id !== "string" || !id.trim() ||
              (index > 0 && ids[index - 1].localeCompare(id) > 0)) ||
            new Set(ids).size !== ids.length ||
            finalizationReceipt.archiveChecksum !== checksumForArchiveIds(ids) ||
            (finalizationReceipt.archiveContentChecksum !== undefined &&
              !isValidArchiveContentChecksum(finalizationReceipt.archiveContentChecksum))) {
          throw new Error("El recibo de finalización no coincide con la biblioteca durante la consolidación.");
        }
        const orderedOriginal = [...libraryEntries].sort((a, b) =>
          a.idea.id.localeCompare(b.idea.id)
        );
        if (JSON.stringify(orderedOriginal.map(entry => entry.idea.id)) !== JSON.stringify(ids)) {
          throw new Error("La biblioteca no coincide con los IDs del recibo durante la consolidación.");
        }
        const previousContent = createArchiveContentChecksumBuilder();
        for (const entry of orderedOriginal) previousContent.add(entry);
        const previousChecksum = previousContent.digest();
        if (finalizationReceipt.archiveContentChecksum !== undefined &&
            previousChecksum !== finalizationReceipt.archiveContentChecksum) {
          throw new Error("La biblioteca no coincide con el checksum del contenido archivado.");
        }
        const remappedById = new Map(remappedLibrary.map(entry => [entry.idea.id, entry]));
        const nextContent = createArchiveContentChecksumBuilder();
        for (const id of ids) {
          const entry = remappedById.get(id);
          if (!entry) throw new Error("La consolidación perdió una entrada de la biblioteca personal.");
          nextContent.add(entry);
        }
        updatedFinalizationReceipt = {
          ...finalizationReceipt,
          archiveContentChecksum: nextContent.digest()
        };
      }
      // Todas las referencias cambian bajo BEGIN IMMEDIATE: un error revierte
      // también la ficha canónica, las instantáneas de biblioteca y su recibo.
      this.put("narrative-entities", identityKey(projectId, targetEntityId), mergedEntity);
      this.remove("narrative-entities", identityKey(projectId, sourceEntityId));
      const relationGroups = new Map();
      for (const relation of relations) {
        const originatedAtCanonical =
          relation.fromEntityId === targetEntityId || relation.toEntityId === targetEntityId;
        const fromEntityId = relation.fromEntityId === sourceEntityId ? targetEntityId : relation.fromEntityId;
        const toEntityId = relation.toEntityId === sourceEntityId ? targetEntityId : relation.toEntityId;
        if (fromEntityId === toEntityId) {
          this.remove("narrative-relations", identityKey(projectId, relation.id));
          continue;
        }
        const key = JSON.stringify([fromEntityId, relation.relationType, toEntityId]);
        const group = relationGroups.get(key) ?? [];
        group.push({relation:{...relation,fromEntityId,toEntityId},originatedAtCanonical});
        relationGroups.set(key,group);
      }
      for (const group of relationGroups.values()) {
        group.sort((a,b)=>
          Number(b.originatedAtCanonical)-Number(a.originatedAtCanonical) ||
          a.relation.id.localeCompare(b.relation.id)
        );
        const primary=group[0]?.relation;
        if(!primary) continue;
        const evidence=new Map();
        for(const item of group) for(const record of item.relation.evidence) evidence.set(evidenceKey(record),record);
        this.put("narrative-relations",identityKey(projectId,primary.id),{...primary,evidence:[...evidence.values()]});
        for(const item of group.slice(1)) {
          if(item.relation.id!==primary.id) this.remove("narrative-relations",identityKey(projectId,item.relation.id));
        }
      }
      for(const event of events) {
        if(!event.participants.includes(sourceEntityId)) continue;
        const participants=[...new Set(event.participants.map(id=>id===sourceEntityId?targetEntityId:id))];
        this.put("narrative-events",identityKey(projectId,event.id),{...event,participants});
      }
      for(const assertion of assertions) {
        if(assertion.entityId===sourceEntityId) {
          this.put("narrative-assertions",identityKey(projectId,assertion.id),{...assertion,entityId:targetEntityId});
        }
      }
      for(const idea of ideas) {
        if(!idea.relatedEntityIds?.includes(sourceEntityId)) continue;
        this.put("narrative-ideas",identityKey(projectId,idea.id),{
          ...idea,relatedEntityIds:[...new Set(idea.relatedEntityIds.map(id=>id===sourceEntityId?targetEntityId:id))]
        });
      }
      for(let index=0;index<remappedLibrary.length;index++) {
        const before=libraryEntries[index],after=remappedLibrary[index];
        if(!sameValue(before,after)) this.put("personal-idea-library",[writerId,projectId,after.idea.id],after);
      }
      if (updatedFinalizationReceipt) {
        this.put("writer-library-finalization-receipts",
          [writerId, projectId, "finalization-v1"], updatedFinalizationReceipt);
      }
    });
  }

  saveEntity(entity) {
    requireProjectRecord(entity, "entidad narrativa");
    return this.transaction(() => {
      for (const existing of this.find("narrative-entities", x => x.projectId === entity.projectId && x.id !== entity.id &&
        x.kind === entity.kind && x.normalizedName === entity.normalizedName)) {
        if (existing.id !== entity.id) throw new Error("La identidad narrativa ya está asociada a otra ficha del mismo tipo.");
      }
      this.put("narrative-entities", identityKey(entity.projectId, entity.id), entity);
    });
  }

  saveEntityIfUnchanged(entity, expectedCurrent) {
    requireProjectRecord(entity, "entidad narrativa");
    if (expectedCurrent !== undefined) {
      requireProjectRecord(expectedCurrent, "entidad anterior");
      if (entity.projectId !== expectedCurrent.projectId || entity.id !== expectedCurrent.id) {
        throw new Error("La identidad de la entidad no puede cambiar.");
      }
    }
    return this.transaction(() => {
      for (const existing of this.find("narrative-entities", x => x.projectId === entity.projectId &&
        x.id !== entity.id && x.kind === entity.kind && x.normalizedName === entity.normalizedName)) {
        throw new Error("La identidad narrativa ya está asociada a otra ficha del mismo tipo.");
      }
      this.put("narrative-entities", identityKey(entity.projectId, entity.id), entity,
        expectedCurrent === undefined
          ? { insertOnly: true, conflictMessage: "La entidad apareció en otra instancia; actualiza la vista antes de volver a modificarla." }
          : { expectedCurrent, conflictMessage: "La entidad cambió en otra instancia o ya no existe; actualiza la vista antes de volver a modificarla." });
    });
  }

  loadEntities(projectId) { return this.loadProject("narrative-entities", projectId, "entidad narrativa"); }

  saveRelation(relation) {
    requireProjectRecord(relation, "relación narrativa");
    return this.transaction(() => {
      for (const id of [relation.fromEntityId, relation.toEntityId]) {
        if (!this.get("narrative-entities", identityKey(relation.projectId, id))) {
          throw new Error("La relación narrativa apunta a una entidad inexistente.");
        }
      }
      this.put("narrative-relations", identityKey(relation.projectId, relation.id), relation);
    });
  }

  saveRelationIfUnchanged(relation, expectedCurrent) {
    requireProjectRecord(relation, "relación narrativa");
    if (expectedCurrent !== undefined) {
      requireProjectRecord(expectedCurrent, "relación anterior");
      if (relation.projectId !== expectedCurrent.projectId || relation.id !== expectedCurrent.id) {
        throw new Error("La identidad de la relación no puede cambiar.");
      }
    }
    return this.transaction(() => {
      for (const id of [relation.fromEntityId, relation.toEntityId]) {
        if (!this.get("narrative-entities", identityKey(relation.projectId, id))) {
          throw new Error("La relación narrativa apunta a una entidad inexistente.");
        }
      }
      this.put("narrative-relations", identityKey(relation.projectId, relation.id), relation,
        expectedCurrent === undefined
          ? { insertOnly: true, conflictMessage: "La relación apareció en otra instancia; actualiza la vista antes de volver a modificarla." }
          : { expectedCurrent, conflictMessage: "La relación cambió en otra instancia o ya no existe; actualiza la vista antes de volver a modificarla." });
    });
  }

  loadRelations(projectId) { return this.loadProject("narrative-relations", projectId, "relación narrativa"); }

  saveEvent(event) {
    requireProjectRecord(event, "acontecimiento narrativo");
    return this.transaction(() => {
      for (const id of event.participants ?? []) {
        if (!this.get("narrative-entities", identityKey(event.projectId, id))) {
          throw new Error("El acontecimiento contiene un participante que no existe en el proyecto.");
        }
      }
      if (event.timelineTrackId && !this.get("timeline-tracks", identityKey(event.projectId, event.timelineTrackId))) {
        throw new Error("La pista cronológica del acontecimiento no existe.");
      }
      this.put("narrative-events", identityKey(event.projectId, event.id), event);
    });
  }

  saveEventIfUnchanged(event, expectedCurrent) {
    requireProjectRecord(event, "acontecimiento narrativo");
    if (expectedCurrent !== undefined) {
      requireProjectRecord(expectedCurrent, "acontecimiento anterior");
      if (event.projectId !== expectedCurrent.projectId || event.id !== expectedCurrent.id) {
        throw new Error("La identidad del acontecimiento no puede cambiar.");
      }
    }
    return this.transaction(() => {
      for (const id of event.participants ?? []) {
        if (!this.get("narrative-entities", identityKey(event.projectId, id))) {
          throw new Error("El acontecimiento contiene un participante que no existe en el proyecto.");
        }
      }
      if (event.timelineTrackId && !this.get("timeline-tracks", identityKey(event.projectId, event.timelineTrackId))) {
        throw new Error("La pista cronológica del acontecimiento no existe.");
      }
      this.put("narrative-events", identityKey(event.projectId, event.id), event,
        expectedCurrent === undefined
          ? { insertOnly: true, conflictMessage: "El acontecimiento apareció en otra instancia; actualiza la vista antes de volver a modificarlo." }
          : { expectedCurrent, conflictMessage: "El acontecimiento cambió en otra instancia o ya no existe; actualiza la vista antes de volver a modificarlo." });
    });
  }

  loadEvents(projectId) { return this.loadProject("narrative-events", projectId, "acontecimiento narrativo"); }

  saveIdea(idea) {
    requireProjectRecord(idea, "idea narrativa");
    validateNarrativeIdeaReferenceLimit(idea);
    validateNarrativeIdeaStatusHistory(idea);
    return this.transaction(() => {
      for (const id of idea.relatedEntityIds ?? []) {
        if (!this.get("narrative-entities", identityKey(idea.projectId, id))) throw new Error("La idea enlaza una ficha inexistente.");
      }
      for (const id of idea.relatedIdeaIds ?? []) {
        if (id === idea.id || !this.get("narrative-ideas", identityKey(idea.projectId, id))) {
          throw new Error("La idea enlaza una idea inexistente o se enlaza a sí misma.");
        }
      }
      this.put("narrative-ideas", identityKey(idea.projectId, idea.id), idea);
    });
  }

  saveIdeaIfUnchanged(idea, expectedCurrent) {
    requireProjectRecord(idea, "idea narrativa");
    validateNarrativeIdeaReferenceLimit(idea);
    validateNarrativeIdeaStatusHistory(idea);
    if (expectedCurrent !== undefined) {
      requireProjectRecord(expectedCurrent, "idea anterior");
      if (idea.projectId !== expectedCurrent.projectId || idea.id !== expectedCurrent.id) {
        throw new Error("La identidad de la idea no puede cambiar.");
      }
    }
    return this.transaction(() => {
      for (const id of idea.relatedEntityIds ?? []) {
        if (!this.get("narrative-entities", identityKey(idea.projectId, id))) throw new Error("La idea enlaza una ficha inexistente.");
      }
      for (const id of idea.relatedIdeaIds ?? []) {
        if (id === idea.id || !this.get("narrative-ideas", identityKey(idea.projectId, id))) {
          throw new Error("La idea enlaza una idea inexistente o se enlaza a sí misma.");
        }
      }
      this.put("narrative-ideas", identityKey(idea.projectId, idea.id), idea,
        expectedCurrent === undefined
          ? { insertOnly: true, conflictMessage: "La idea apareció en otra instancia; actualiza la vista antes de volver a modificarla." }
          : { expectedCurrent, conflictMessage: "La idea cambió en otra instancia o ya no existe; actualiza la vista antes de volver a modificarla." });
    });
  }

  updateIdeaIfUnchanged(idea, expectedCurrent) {
    return this.saveIdeaIfUnchanged(idea, expectedCurrent);
  }

  loadIdeas(projectId) { return this.loadProject("narrative-ideas", projectId, "idea narrativa"); }

  saveAssertion(assertion) {
    requireProjectRecord(assertion, "afirmación narrativa");
    return this.transaction(() => {
      if (!this.get("narrative-entities", identityKey(assertion.projectId, assertion.entityId))) {
        throw new Error("La afirmación apunta a una entidad inexistente.");
      }
      this.put("narrative-assertions", identityKey(assertion.projectId, assertion.id), assertion);
    });
  }

  saveAssertionIfUnchanged(assertion, expectedCurrent) {
    requireProjectRecord(assertion, "afirmación narrativa");
    if (expectedCurrent !== undefined) {
      requireProjectRecord(expectedCurrent, "afirmación anterior");
      if (assertion.projectId !== expectedCurrent.projectId || assertion.id !== expectedCurrent.id) {
        throw new Error("La identidad de la afirmación no puede cambiar.");
      }
    }
    return this.transaction(() => {
      if (!this.get("narrative-entities", identityKey(assertion.projectId, assertion.entityId))) {
        throw new Error("La afirmación apunta a una entidad inexistente.");
      }
      this.put("narrative-assertions", identityKey(assertion.projectId, assertion.id), assertion,
        expectedCurrent === undefined
          ? { insertOnly: true, conflictMessage: "La afirmación apareció en otra instancia; actualiza la vista antes de volver a modificarla." }
          : { expectedCurrent, conflictMessage: "La afirmación cambió en otra instancia o ya no existe; actualiza la vista antes de volver a modificarla." });
    });
  }

  loadAssertions(projectId) { return this.loadProject("narrative-assertions", projectId, "afirmación narrativa"); }

  archiveUnincorporatedIdeas(projectId, writerId, sourceProjectName, archivedAt) {
    return this.archiveUnincorporatedIdeasInternal(projectId, writerId, sourceProjectName, archivedAt, true);
  }

  archiveUnincorporatedIdeasSummary(projectId, writerId, sourceProjectName, archivedAt) {
    return this.archiveUnincorporatedIdeasInternal(projectId, writerId, sourceProjectName, archivedAt, false);
  }

  archiveUnincorporatedIdeasInternal(projectId, writerId, sourceProjectName, archivedAt, collectEntries) {
    requireProject(projectId);
    requireText(writerId, "writerId");
    requireText(sourceProjectName, "sourceProjectName");
    if (!Number.isFinite(archivedAt) || archivedAt < 0) throw new Error("Fecha de archivo inválida.");

    const checksumFor = ids => {
      const source = JSON.stringify([...ids].sort());
      let hash = 0xcbf29ce484222325n;
      for (let index = 0; index < source.length; index++) {
        hash ^= BigInt(source.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
      }
      return "fnv1a64:" + hash.toString(16).padStart(16, "0");
    };

    return this.transaction(() => {
      const receiptId = "finalization-v1";
      const receiptKey = [writerId, projectId, receiptId];
      const existingReceipt = this.get("writer-library-finalization-receipts", receiptKey);
      const pendingTable = "ml_archive_pending_ideas";
      const identityTable = "ml_archive_identity_owners";
      this.database.exec("DROP TABLE IF EXISTS temp." + pendingTable);
      this.database.exec("DROP TABLE IF EXISTS temp." + identityTable);

      const loadIdea = id => {
        const idea = this.get("narrative-ideas", identityKey(projectId, id));
        if (!idea) {
          throw new Error("No se pueden archivar ideas: existe una referencia a otra idea inexistente.");
        }
        validateNarrativeIdea(idea, projectId);
        return idea;
      };

      const validateIdeaReferences = rejectPendingReferences => {
        let hasPending = false;
        this.forEachProjectPage("narrative-ideas", projectId, idea => {
          validateNarrativeIdea(idea, projectId);
          if (idea.status === "IDEA") hasPending = true;
        });
        this.forEachProjectPage("narrative-ideas", projectId, idea => {
          for (const relatedId of idea.relatedIdeaIds ?? []) {
            const related = loadIdea(relatedId);
            if (rejectPendingReferences && idea.status !== "IDEA" && related.status === "IDEA") {
              throw new Error("No se pueden archivar ideas: una idea que permanecerá en el libro depende de una idea que se trasladaría a la biblioteca personal.");
            }
          }
        });
        return hasPending;
      };

      try {
        if (existingReceipt) {
          if (existingReceipt.writerId !== writerId || existingReceipt.sourceProjectId !== projectId ||
              existingReceipt.receiptId !== receiptId || existingReceipt.sourceProjectName !== sourceProjectName ||
              !Number.isFinite(existingReceipt.finalizedAt) || existingReceipt.finalizedAt < 0 ||
              !Array.isArray(existingReceipt.archivedIdeaIds) ||
              existingReceipt.archivedIdeaIds.some(id => typeof id !== "string" || !id.trim()) ||
              new Set(existingReceipt.archivedIdeaIds).size !== existingReceipt.archivedIdeaIds.length ||
              [...existingReceipt.archivedIdeaIds].some((id,index,ids)=>index>0&&ids[index-1].localeCompare(id)>0) ||
              existingReceipt.archiveChecksum !== checksumFor(existingReceipt.archivedIdeaIds) ||
              (existingReceipt.archiveContentChecksum !== undefined &&
                !isValidArchiveContentChecksum(existingReceipt.archiveContentChecksum))) {
            throw new Error("El recibo de finalización está malformado o no pertenece al escritor y libro activos.");
          }
          if (validateIdeaReferences(true)) {
            throw new Error("El libro ya está finalizado; las ideas nuevas requieren una reapertura explícita antes de archivarse.");
          }

          // La verificación usa COUNT en SQLite y lecturas por clave. No materializa
          // toda la biblioteca del escritor para comprobar un recibo ya publicado.
          const libraryCount = this.database.prepare(
            "SELECT COUNT(*) AS total FROM " + TABLE +
            " WHERE collection = ? AND writer_id = ? AND json_extract(value_json, '$.sourceProjectId') = ?"
          ).get("personal-idea-library", writerId, projectId);
          if (Number(libraryCount?.total ?? -1) !== existingReceipt.archivedIdeaIds.length) {
            throw new Error("La biblioteca no coincide con el recibo de finalización del libro.");
          }

          const archivedIds = new Set(existingReceipt.archivedIdeaIds);
          const contentChecksum = createArchiveContentChecksumBuilder();
          const restoredEntries = collectEntries ? [] : undefined;
          for (const id of existingReceipt.archivedIdeaIds) {
            const entry = this.get("personal-idea-library", [writerId, projectId, id]);
            if (!entry || entry.writerId !== writerId || entry.sourceProjectId !== projectId ||
                entry.sourceProjectName !== sourceProjectName || entry.category !== sourceProjectName ||
                !entry.idea || entry.idea.projectId !== projectId ||
                entry.idea.sourceProjectName !== sourceProjectName || entry.idea.status !== "IDEA" ||
                !Number.isFinite(entry.archivedAt) || entry.archivedAt < 0 || !entry.context) {
              throw new Error("La biblioteca personal contiene una entrada ajena o incompleta.");
            }
            validateNarrativeIdea(entry.idea, projectId, "idea archivada");
            validatePersonalIdeaContext(entry.context, projectId, sourceProjectName);
            contentChecksum.add(entry);
            restoredEntries?.push(entry);
            const contextIdeaIds = new Set(entry.context.relatedIdeas.map(idea => idea.id));
            const contextEntityIds = new Set(entry.context.relatedEntities.map(entity => entity.id));
            for (const idea of [entry.idea, ...entry.context.relatedIdeas]) {
              if ((idea.relatedEntityIds ?? []).some(entityId => !contextEntityIds.has(entityId)) ||
                  (idea.relatedIdeaIds ?? []).some(ideaId => !contextIdeaIds.has(ideaId) && !archivedIds.has(ideaId))) {
                throw new Error("La biblioteca personal contiene referencias históricas sin destino resoluble.");
              }
            }
          }
          const calculatedContentChecksum = contentChecksum.digest();
          if (existingReceipt.archiveContentChecksum !== undefined &&
              calculatedContentChecksum !== existingReceipt.archiveContentChecksum) {
            throw new Error("La biblioteca personal no coincide con el checksum del contenido archivado.");
          }
          return collectEntries ? clone(restoredEntries) : {
            writerId, sourceProjectId: projectId, sourceProjectName,
            archivedCount: existingReceipt.archivedIdeaIds.length,
            finalizedAt: existingReceipt.finalizedAt,
            alreadyFinalized: true,
            archiveChecksum: existingReceipt.archiveChecksum,
            ...(existingReceipt.archiveContentChecksum
              ? { archiveContentChecksum: existingReceipt.archiveContentChecksum }
              : {})
          };
        }

        this.database.exec(
          "CREATE TEMP TABLE " + pendingTable + " (idea_id TEXT PRIMARY KEY) WITHOUT ROWID"
        );
        const addPending = this.database.prepare(
          "INSERT INTO " + pendingTable + "(idea_id) VALUES(?)"
        );
        this.forEachProjectPage("narrative-ideas", projectId, idea => {
          validateNarrativeIdea(idea, projectId);
          if (idea.status === "IDEA") addPending.run(idea.id);
        });
        const hasPendingIdea = this.database.prepare(
          "SELECT 1 AS found FROM " + pendingTable + " WHERE idea_id = ?"
        );
        const isPendingIdea = id => Boolean(hasPendingIdea.get(id));

        // Segunda pasada: valida enlaces con búsquedas por clave. La tabla temporal
        // permite comprobar dependencias sin conservar un Map de todas las ideas.
        this.forEachProjectPage("narrative-ideas", projectId, idea => {
          for (const relatedId of idea.relatedIdeaIds ?? []) {
            const related = loadIdea(relatedId);
            if (idea.status !== "IDEA" && isPendingIdea(relatedId) && related.status === "IDEA") {
              throw new Error("No se pueden archivar ideas: una idea que permanecerá en el libro depende de una idea que se trasladaría a la biblioteca personal.");
            }
          }
        });

        // Comprueba la propiedad de cada ID histórico usando una tabla temporal
        // indexada, en vez de cargar todos los registros de entidades en memoria.
        this.database.exec(
          "CREATE TEMP TABLE " + identityTable +
          " (identity_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL) WITHOUT ROWID"
        );
        const insertIdentity = this.database.prepare(
          "INSERT OR IGNORE INTO " + identityTable + "(identity_id, owner_id) VALUES(?, ?)"
        );
        const getIdentityOwner = this.database.prepare(
          "SELECT owner_id FROM " + identityTable + " WHERE identity_id = ?"
        );
        this.forEachProjectPage("narrative-entities", projectId, entity => {
          validateNarrativeEntity(entity, projectId);
          const localIds = new Set([entity.id]);
          for (const historicalId of entity.mergedFromIds ?? []) {
            if (localIds.has(historicalId)) {
              throw new Error("Integridad narrativa: una entidad repite o reclama su propio ID histórico.");
            }
            localIds.add(historicalId);
          }
          for (const identityId of localIds) {
            insertIdentity.run(identityId, entity.id);
            const owner = getIdentityOwner.get(identityId);
            if (!owner || owner.owner_id !== entity.id) {
              throw new Error("Integridad narrativa: un ID histórico pertenece a más de una entidad.");
            }
          }
        });

        const archived = [];
        const archivedIdeaIds = [];
        // La segunda lectura también es paginada. Se elimina solo la página ya
        // leída; el cursor por clave primaria mantiene estables las páginas siguientes.
        this.forEachProjectPage("narrative-ideas", projectId, idea => {
          if (idea.status !== "IDEA") return;

          const contextIdeasById = new Map();
          const visited = new Set([idea.id]);
          const queue = [...(idea.relatedIdeaIds ?? [])];
          let queueIndex = 0;
          while (queueIndex < queue.length) {
            const relatedId = queue[queueIndex++];
            if (visited.has(relatedId)) continue;
            visited.add(relatedId);
            // Las ideas que se trasladarán tendrán sus propias entradas de biblioteca.
            if (isPendingIdea(relatedId)) continue;
            const related = loadIdea(relatedId);
            contextIdeasById.set(relatedId, related);
            queue.push(...(related.relatedIdeaIds ?? []));
          }

          const relatedIdeaSnapshots = [...contextIdeasById.values()]
            .sort((first, second) => first.id.localeCompare(second.id))
            .map(related => ({ ...related, sourceProjectName }));
          const relatedEntityIds = new Set(idea.relatedEntityIds ?? []);
          for (const related of relatedIdeaSnapshots) {
            for (const entityId of related.relatedEntityIds ?? []) relatedEntityIds.add(entityId);
          }
          const relatedEntities = [...relatedEntityIds].sort().map(id => {
            const entity = this.get("narrative-entities", identityKey(projectId, id));
            if (!entity || entity.projectId !== projectId || entity.id !== id) {
              throw new Error("No se puede archivar una idea: falta una ficha relacionada del proyecto.");
            }
            validateNarrativeEntity(entity, projectId, "entidad contextual");
            return entity;
          });

          const archivedIdea = { ...idea, sourceProjectName };
          validateNarrativeIdea(archivedIdea, projectId, "idea archivada");
          const context = {
            version: 1,
            relatedIdeas: relatedIdeaSnapshots,
            relatedEntities
          };
          validatePersonalIdeaContext(context, projectId, sourceProjectName);
          const contextEntityIds = new Set(relatedEntities.map(entity => entity.id));
          if ((archivedIdea.relatedEntityIds ?? []).some(id => !contextEntityIds.has(id))) {
            throw new Error("Una idea archivada conserva una referencia a una ficha que no está en su contexto.");
          }

          const entry = {
            writerId, sourceProjectId: projectId, sourceProjectName, category: sourceProjectName,
            idea: archivedIdea, context, archivedAt
          };
          this.put("personal-idea-library", [writerId, projectId, idea.id], entry, { insertOnly: true });
          this.remove("narrative-ideas", identityKey(projectId, idea.id));
          if (collectEntries) archived.push(entry);
          archivedIdeaIds.push(idea.id);
        });

        archivedIdeaIds.sort((first, second) => first.localeCompare(second));
        const contentChecksum = createArchiveContentChecksumBuilder();
        for (const id of archivedIdeaIds) {
          const entry = this.get("personal-idea-library", [writerId, projectId, id]);
          if (!entry || entry.writerId !== writerId ||
              entry.sourceProjectId !== projectId || entry.idea?.id !== id) {
            throw new Error("La biblioteca personal no conserva una entrada recién archivada.");
          }
          contentChecksum.add(entry);
        }
        const archiveContentChecksum = contentChecksum.digest();
        this.put("writer-library-finalization-receipts", receiptKey, {
          writerId, sourceProjectId: projectId, receiptId, sourceProjectName,
          finalizedAt: archivedAt, archivedIdeaIds, archiveChecksum: checksumFor(archivedIdeaIds),
          archiveContentChecksum
        }, { insertOnly: true });
        return collectEntries ? clone(archived) : {
          writerId, sourceProjectId: projectId, sourceProjectName,
          archivedCount: archivedIdeaIds.length,
          finalizedAt: archivedAt,
          alreadyFinalized: false,
          archiveChecksum: checksumFor(archivedIdeaIds),
          archiveContentChecksum
        };
      } finally {
        this.database.exec("DROP TABLE IF EXISTS temp." + pendingTable);
        this.database.exec("DROP TABLE IF EXISTS temp." + identityTable);
      }
    });
  }


  loadPersonalIdeasPage(writerId, cursor = null, limit = 50) {
    requireText(writerId, "writerId");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
        (cursor !== null && (!cursor || typeof cursor.sourceProjectId !== "string" ||
          !cursor.sourceProjectId.trim() || typeof cursor.ideaId !== "string" ||
          !cursor.ideaId.trim()))) {
      throw new Error("Parámetros de paginación de biblioteca inválidos.");
    }
    const afterSortKey = cursor
      ? personalIdeaLibrarySortKey(cursor.sourceProjectId, cursor.ideaId)
      : "";
    const rows = this.database.prepare(
      "SELECT value_json FROM " + TABLE +
      " WHERE collection = 'personal-idea-library' AND writer_id = ? AND sort_key > ? " +
      "ORDER BY sort_key LIMIT ?"
    ).all(writerId, afterSortKey, limit + 1);
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    const items = selected.map(row => JSON.parse(row.value_json));
    if (items.some(entry => entry.writerId !== writerId)) {
      throw new Error("Biblioteca SQLite inconsistente: se rechazó una entrada de otro escritor.");
    }
    const last = items[items.length - 1];
    return {
      items: clone(items),
      nextCursor: hasMore && last
        ? { sourceProjectId: last.sourceProjectId, ideaId: last.idea.id }
        : null
    };
  }

  loadPersonalIdea(writerId, sourceProjectId, ideaId) {
    requireText(writerId, "writerId");
    requireProject(sourceProjectId, "sourceProjectId");
    requireText(ideaId, "ideaId");
    const entry = this.get("personal-idea-library", [writerId, sourceProjectId, ideaId]);
    if (entry && entry.writerId !== writerId) {
      throw new Error("Biblioteca SQLite inconsistente: se rechazó una entrada de otro escritor.");
    }
    return clone(entry);
  }

  loadPersonalIdeasByKeys(writerId, references) {
    requireText(writerId, "writerId");
    if (!Array.isArray(references) || references.length > 128) {
      throw new Error("La lectura agrupada admite un máximo de 128 referencias.");
    }
    const seen = new Set();
    const statement = this.database.prepare(
      "SELECT value_json FROM " + TABLE +
      " WHERE collection = 'personal-idea-library' AND record_key = ? AND writer_id = ?"
    );
    const entries = [];
    for (const reference of references) {
      if (!reference || typeof reference.sourceProjectId !== "string" ||
          !reference.sourceProjectId.trim() ||
          typeof reference.ideaId !== "string" || !reference.ideaId.trim()) {
        throw new Error("La lectura agrupada recibió una referencia malformada.");
      }
      const key = JSON.stringify([reference.sourceProjectId, reference.ideaId]);
      if (seen.has(key)) throw new Error("La lectura agrupada recibió referencias duplicadas.");
      seen.add(key);
      const row = statement.get(
        encodedKey([writerId, reference.sourceProjectId, reference.ideaId]),
        writerId
      );
      if (!row) continue;
      const entry = JSON.parse(row.value_json);
      if (!entry || entry.writerId !== writerId ||
          entry.sourceProjectId !== reference.sourceProjectId ||
          entry.idea?.id !== reference.ideaId) {
        throw new Error("Biblioteca SQLite inconsistente: la lectura agrupada devolvió una entrada ajena.");
      }
      entries.push(entry);
    }
    return clone(entries);
  }


  loadPersonalIdeas(writerId) {
    requireText(writerId, "writerId");
    return clone(this.find("personal-idea-library", item => item.writerId === writerId));
  }

  loadProjectFinalizationReceipt(writerId, projectId) {
    requireText(writerId, "writerId");
    requireProject(projectId);
    return clone(this.get("writer-library-finalization-receipts", [writerId, projectId, "finalization-v1"]));
  }

  saveDocument(document) {
    if (!document || typeof document.projectId !== "string" || !document.projectId.trim() ||
        typeof document.documentId !== "string" || !document.documentId.trim() ||
        typeof document.text !== "string" || !Number.isSafeInteger(document.revision) || document.revision < 0 ||
        !Number.isSafeInteger(document.sequence) || document.sequence < 0 ||
        !Number.isFinite(document.updatedAt) || document.updatedAt < 0) throw new Error("Snapshot de documento inválido.");
    return this.transaction(() => {
      const key = identityKey(document.projectId, document.documentId);
      const current = this.get("documents", key);
      const journal = this.loadChanges(document.projectId, document.documentId, current?.sequence ?? 0);
      if (!current && this.loadChanges(document.projectId, document.documentId, 0).length) {
        throw new Error("No se puede crear una base de documento sobre un journal huérfano.");
      }
      if (current) {
        if (document.revision < current.revision || document.sequence < current.sequence ||
            document.revision - current.revision !== document.sequence - current.sequence) {
          throw new Error("El snapshot no puede retroceder ni desalinear revisión y secuencia.");
        }
        if (document.sequence === current.sequence && document.revision === current.revision &&
            document.text !== current.text) {
          if (journal.length) throw new Error("El texto diverge y existen cambios posteriores en el journal.");
        }
        if (document.sequence > current.sequence && journal.length) {
          throw new Error("Debe usarse el checkpoint atómico para avanzar un snapshot con journal pendiente.");
        }
      }
      this.put("documents", key, document);
      const head = this.database.prepare(
        "SELECT sequence FROM bridge_document_heads WHERE project_id = ? AND document_id = ?"
      ).get(document.projectId, document.documentId);
      if (!head || head.sequence <= document.sequence) {
        this.database.prepare(
          "INSERT INTO bridge_document_heads(project_id, document_id, sequence, revision, text_length) " +
          "VALUES(?, ?, ?, ?, ?) ON CONFLICT(project_id, document_id) DO UPDATE SET " +
          "sequence=excluded.sequence, revision=excluded.revision, text_length=excluded.text_length"
        ).run(document.projectId, document.documentId, document.sequence, document.revision, document.text.length);
      }
    });
  }

  loadDocument(projectId, documentId) {
    requireProject(projectId);
    requireText(documentId, "documentId");
    return clone(this.get("documents", identityKey(projectId, documentId)));
  }

  loadDocumentWithChanges(projectId, documentId) {
    const document = this.loadDocument(projectId, documentId);
    return {
      document,
      changes: clone(this.loadChanges(projectId, documentId, document?.sequence ?? 0))
    };
  }

  appendChange(change) {
    if (!change || typeof change.projectId !== "string" || !change.projectId.trim() ||
        typeof change.documentId !== "string" || !change.documentId.trim() ||
        !Number.isSafeInteger(change.sequence) || change.sequence < 1 ||
        !Number.isSafeInteger(change.baseRevision) || change.baseRevision < 0 ||
        !Number.isSafeInteger(change.committedRevision) || change.committedRevision !== change.baseRevision + 1 ||
        !Number.isSafeInteger(change.start) || !Number.isSafeInteger(change.end) ||
        change.start < 0 || change.end < change.start || typeof change.replacement !== "string") {
      throw new Error("Delta de documento inválido.");
    }
    return this.transaction(() => {
      const snapshot = this.get("documents", identityKey(change.projectId, change.documentId));
      if (!snapshot) throw new Error("No existe snapshot durable base para el journal.");
      let head = this.database.prepare(
        "SELECT sequence, revision, text_length FROM bridge_document_heads WHERE project_id = ? AND document_id = ?"
      ).get(change.projectId, change.documentId);
      if (!head || head.sequence < snapshot.sequence) {
        head = { sequence: snapshot.sequence, revision: snapshot.revision, text_length: snapshot.text.length };
        this.database.prepare(
          "INSERT INTO bridge_document_heads(project_id, document_id, sequence, revision, text_length) " +
          "VALUES(?, ?, ?, ?, ?) ON CONFLICT(project_id, document_id) DO UPDATE SET " +
          "sequence=excluded.sequence, revision=excluded.revision, text_length=excluded.text_length"
        ).run(change.projectId, change.documentId, head.sequence, head.revision, head.text_length);
      }
      if (change.sequence !== head.sequence + 1 || change.baseRevision !== head.revision) {
        throw new Error("Secuencia o revisión del journal no consecutiva.");
      }
      if (change.end > head.text_length) throw new Error("El delta supera la longitud proyectada del documento.");
      const nextLength = head.text_length - (change.end - change.start) + change.replacement.length;
      this.put("changes", [change.projectId, change.documentId, change.sequence], change, { insertOnly: true });
      this.database.prepare(
        "UPDATE bridge_document_heads SET sequence = ?, revision = ?, text_length = ? " +
        "WHERE project_id = ? AND document_id = ?"
      ).run(change.sequence, change.committedRevision, nextLength, change.projectId, change.documentId);
    });
  }

  loadChanges(projectId, documentId, afterSequence) {
    requireProject(projectId);
    requireText(documentId, "documentId");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("afterSequence inválido.");
    return this.database.prepare(
      "SELECT value_json FROM " + TABLE +
      " WHERE collection = ? AND project_id = ? AND document_id = ? AND sequence > ? ORDER BY sequence"
    ).all("changes", projectId, documentId, afterSequence).map(row => JSON.parse(row.value_json));
  }

  compactChanges(projectId, documentId, throughSequence) {
    return this.transaction(() => {
      const snapshot = this.get("documents", identityKey(projectId, documentId));
      if (!snapshot || snapshot.sequence !== throughSequence) {
        throw new Error("La compactación exige un snapshot durable con la misma secuencia.");
      }
      this.database.prepare(
        "DELETE FROM " + TABLE + " WHERE collection = ? AND project_id = ? AND document_id = ? AND sequence <= ?"
      ).run("changes", projectId, documentId, throughSequence);
    });
  }

  saveDocumentAndCompactChanges(document, throughSequence) {
    if (!document || document.sequence !== throughSequence) throw new Error("El checkpoint y su snapshot deben tener la misma secuencia.");
    return this.transaction(() => {
      const key = identityKey(document.projectId, document.documentId);
      const current = this.get("documents", key);
      const journal = this.loadChanges(document.projectId, document.documentId, current?.sequence ?? 0);
      if (!current) {
        if (document.sequence !== 0 || document.revision !== 0 || journal.length) {
          throw new Error("No se puede crear un checkpoint sin snapshot durable base.");
        }
      } else {
        if (document.revision < current.revision || document.sequence < current.sequence ||
            document.revision - current.revision !== document.sequence - current.sequence) {
          throw new Error("El checkpoint no puede retroceder ni desalinear revisión y secuencia.");
        }
        let expectedSequence = current.sequence;
        let expectedRevision = current.revision;
        let reconstructedText = current.text;
        for (const delta of journal.filter(item => item.sequence <= throughSequence)) {
          if (delta.sequence !== expectedSequence + 1 || delta.baseRevision !== expectedRevision ||
              delta.committedRevision !== expectedRevision + 1 || delta.end > reconstructedText.length) {
            throw new Error("Journal discontinuo al comprobar el checkpoint.");
          }
          reconstructedText = reconstructedText.slice(0, delta.start) + delta.replacement + reconstructedText.slice(delta.end);
          expectedSequence = delta.sequence;
          expectedRevision = delta.committedRevision;
        }
        if (expectedSequence !== document.sequence || expectedRevision !== document.revision ||
            reconstructedText !== document.text) {
          throw new Error("El snapshot no coincide con la reconstrucción durable del journal.");
        }
      }
      this.put("documents", key, document);
      this.database.prepare(
        "DELETE FROM " + TABLE + " WHERE collection = ? AND project_id = ? AND document_id = ? AND sequence <= ?"
      ).run("changes", document.projectId, document.documentId, throughSequence);
      const head = this.database.prepare(
        "SELECT sequence FROM bridge_document_heads WHERE project_id = ? AND document_id = ?"
      ).get(document.projectId, document.documentId);
      if (!head || head.sequence <= throughSequence) {
        this.database.prepare(
          "INSERT INTO bridge_document_heads(project_id, document_id, sequence, revision, text_length) " +
          "VALUES(?, ?, ?, ?, ?) ON CONFLICT(project_id, document_id) DO UPDATE SET " +
          "sequence=excluded.sequence, revision=excluded.revision, text_length=excluded.text_length"
        ).run(document.projectId, document.documentId, document.sequence, document.revision, document.text.length);
      }
    });
  }

  saveDiagnostics(record) {
    if (!record || typeof record.projectId !== "string" || !record.projectId.trim() ||
        typeof record.documentId !== "string" || !record.documentId.trim() ||
        !Number.isSafeInteger(record.revision) || record.revision < 0 ||
        !Array.isArray(record.diagnostics) || !Number.isFinite(record.updatedAt)) {
      throw new Error("Registro de diagnósticos inválido.");
    }
    return this.transaction(() => this.put("document-diagnostics", identityKey(record.projectId, record.documentId), record));
  }

  loadDiagnostics(projectId, documentId) {
    return clone(this.get("document-diagnostics", identityKey(projectId, documentId)));
  }

  close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  health() {
    this.ensureOpen();
    const check = this.database.prepare("PRAGMA quick_check").get();
    const version = this.database.prepare("SELECT value FROM bridge_metadata WHERE key = ?").get("schema_version");
    return { databasePath: this.databasePath, integrity: check?.quick_check ?? "unknown", sqliteSchemaVersion: version?.value ?? "unknown" };
  }
}

function keyForCollection(collection, row) {
  if (collection === "documents" || collection === "document-diagnostics") return identityKey(row.projectId, row.documentId);
  if (collection === "changes") return [row.projectId, row.documentId, row.sequence];
  if (collection === "project-settings") return [row.projectId, row.key];
  if (collection === "import-authorizations") return [row.writerId, row.sourceProjectId, row.targetProjectId, row.authorizationId];
  if (collection === "schema-migrations") return [row.migrationId];
  if (collection === "personal-idea-library") return [row.writerId, row.sourceProjectId, row.idea.id];
  if (collection === "writer-library-finalization-receipts") return [row.writerId, row.sourceProjectId, row.receiptId];
  if (collection === "record-lifecycles") return [row.projectId, row.recordId, row.revision];
  if (collection === "relation-lifecycles") return [row.projectId, row.relationId, row.revision];
  if (collection === "event-lifecycles") return [row.projectId, row.eventId, row.revision];
  if (collection === "dictionary-entry-entities") return [row.projectId, row.entryId, row.recordId];
  return identityKey(row.projectId, row.id);
}
