import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, open as openFile } from "node:fs/promises";
import { dirname } from "node:path";

const TABLE = "bridge_records";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function encodedKey(parts) {
  return JSON.stringify(parts);
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
      "value_json TEXT NOT NULL," +
      "PRIMARY KEY (collection, record_key)" +
      ") WITHOUT ROWID"
    );
    database.exec("CREATE INDEX IF NOT EXISTS bridge_records_project ON " + TABLE + "(collection, project_id)");
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
    this.database.prepare(
      "INSERT INTO " + TABLE + "(collection, record_key, project_id, writer_id, document_id, sequence, value_json) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(collection, record_key) DO UPDATE SET " +
      "project_id=excluded.project_id, writer_id=excluded.writer_id, document_id=excluded.document_id, " +
      "sequence=excluded.sequence, value_json=excluded.value_json"
    ).run(collection, key, projectId, writerId, documentId, sequence, JSON.stringify(value));
    return clone(value);
  }

  remove(collection, parts) {
    this.ensureOpen();
    this.database.prepare(
      "DELETE FROM " + TABLE + " WHERE collection = ? AND record_key = ?"
    ).run(collection, encodedKey(parts));
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

  loadEvents(projectId) { return this.loadProject("narrative-events", projectId, "acontecimiento narrativo"); }

  saveIdea(idea) {
    requireProjectRecord(idea, "idea narrativa");
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

  updateIdeaIfUnchanged(idea, expectedCurrent) {
    requireProjectRecord(idea, "idea narrativa");
    requireProjectRecord(expectedCurrent, "idea anterior");
    if (idea.projectId !== expectedCurrent.projectId || idea.id !== expectedCurrent.id) throw new Error("La identidad de la idea no puede cambiar.");
    return this.transaction(() => this.put("narrative-ideas", identityKey(idea.projectId, idea.id), idea, { expectedCurrent }));
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

  loadAssertions(projectId) { return this.loadProject("narrative-assertions", projectId, "afirmación narrativa"); }

  archiveUnincorporatedIdeas(projectId, writerId, sourceProjectName, archivedAt) {
    requireProject(projectId);
    requireText(writerId, "writerId");
    requireText(sourceProjectName, "sourceProjectName");
    if (!Number.isFinite(archivedAt) || archivedAt < 0) throw new Error("Fecha de archivo inválida.");
    return this.transaction(() => {
      const receiptId = "finalization-v1";
      const receiptKey = [writerId, projectId, receiptId];
      const existingReceipt = this.get("writer-library-finalization-receipts", receiptKey);
      const projectIdeas = this.loadIdeas(projectId);
      if (existingReceipt) {
        if (existingReceipt.sourceProjectName !== sourceProjectName) throw new Error("El título del proyecto no coincide con el recibo de finalización.");
        if (projectIdeas.some(item => item.status === "IDEA")) {
          throw new Error("El libro ya está finalizado; las ideas nuevas requieren reapertura explícita.");
        }
        return this.find("personal-idea-library", item => item.writerId === writerId && item.sourceProjectId === projectId);
      }

      const pending = projectIdeas.filter(item => item.status === "IDEA");
      const pendingIds = new Set(pending.map(item => item.id));
      const relatedIdeas = new Map();
      const relatedEntityIds = new Set();
      const visitedIdeas = new Set(pendingIds);
      const queue = pending.flatMap(item => [...(item.relatedIdeaIds ?? [])]);
      while (queue.length) {
        const id = queue.shift();
        if (!id || visitedIdeas.has(id)) continue;
        visitedIdeas.add(id);
        const related = projectIdeas.find(item => item.id === id);
        if (!related) throw new Error("No se pudo resolver una idea relacionada durante la finalización.");
        if (!pendingIds.has(id)) relatedIdeas.set(id, related);
        for (const entityId of related.relatedEntityIds ?? []) relatedEntityIds.add(entityId);
        for (const nextId of related.relatedIdeaIds ?? []) queue.push(nextId);
      }
      for (const idea of pending) for (const entityId of idea.relatedEntityIds ?? []) relatedEntityIds.add(entityId);
      const relatedEntities = this.loadEntities(projectId).filter(entity => relatedEntityIds.has(entity.id));
      if (relatedEntities.length !== relatedEntityIds.size) throw new Error("Falta una ficha vinculada a ideas que se van a archivar.");
      const archived = [];
      for (const idea of pending) {
        const entry = {
          writerId,
          sourceProjectId: projectId,
          sourceProjectName,
          category: sourceProjectName,
          idea,
          context: {
            version: 1,
            relatedIdeas: [...relatedIdeas.values()],
            relatedEntities
          },
          archivedAt
        };
        this.put("personal-idea-library", [writerId, projectId, idea.id], entry, { insertOnly: true });
        this.remove("narrative-ideas", identityKey(projectId, idea.id));
        archived.push(entry);
      }
      const archivedIdeaIds = pending.map(item => item.id).sort();
      const checksumSource = JSON.stringify(archivedIdeaIds);
      let hash = 0xcbf29ce484222325n;
      for (let i = 0; i < checksumSource.length; i++) {
        hash ^= BigInt(checksumSource.charCodeAt(i));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
      }
      const archiveChecksum = "fnv1a64:" + hash.toString(16).padStart(16, "0");
      this.put("writer-library-finalization-receipts", receiptKey, {
        writerId, sourceProjectId: projectId, receiptId, sourceProjectName,
        finalizedAt: archivedAt, archivedIdeaIds, archiveChecksum
      }, { insertOnly: true });
      return clone(archived);
    });
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
  if (collection === "dictionary-entry-entities") return [row.projectId, row.entryId, row.recordId];
  return identityKey(row.projectId, row.id);
}
