//! Registros narrativos estructurados, versionados y aislados por proyecto.
//!
//! Este módulo almacena hechos y procedencia; no afirma comprender ni extraerlos
//! automáticamente del manuscrito. La capa de análisis debe aportar estos registros.

use mldb_storage::project_store::{ProjectOperation, ProjectStore};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

const FORMAT_VERSION: u8 = 1;
const EVIDENCE_FORMAT_VERSION: u8 = 2;
const ENTITY_TABLE: &str = "narrative.entity.v1";
const RELATION_TABLE: &str = "narrative.relation.v1";
const EVENT_TABLE: &str = "narrative.event.v1";
const EVIDENCE_TABLE: &str = "narrative.evidence.v1";
const FRAGMENT_ANALYSIS_TABLE: &str = "narrative.fragment_analysis.v1";
const FRAGMENT_ANALYSIS_FORMAT_VERSION: u8 = 2;
const MAX_FRAGMENT_ANALYSIS_SOURCE_BYTES: usize = 512 * 1024;
const MAX_FIELD_BYTES: usize = 1024 * 1024;
const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_EVIDENCE_HISTORY_TRANSFORM_STEPS: usize = 5_000_000;
const EVIDENCE_HISTORY_WRITE_BATCH_RECORDS: usize = 8;

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum KnowledgeError {
    Invalid(&'static str),
    Corrupt(&'static str),
    Storage(String),
}

impl std::fmt::Display for KnowledgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "registro narrativo inválido: {message}"),
            Self::Corrupt(message) => write!(f, "registro narrativo corrupto: {message}"),
            Self::Storage(message) => write!(f, "almacenamiento narrativo: {message}"),
        }
    }
}
impl std::error::Error for KnowledgeError {}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct EntityRecord {
    pub id: String,
    pub canonical_name: String,
    pub entity_type: String,
    pub attributes: Vec<(String, String)>,
    pub status: RecordStatus,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RelationRecord {
    pub id: String,
    pub subject_id: String,
    pub predicate: String,
    pub object_id: String,
    pub status: RecordStatus,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct EventRecord {
    pub id: String,
    pub label: String,
    pub chronology_order: Option<i64>,
    pub status: RecordStatus,
}

#[derive(Debug, Clone, Eq, PartialEq)]
/// Resultado de proyectar una evidencia sobre una edición UTF-8 posterior.
/// No modifica el registro: el anfitrión decide si actualiza o invalida la evidencia.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum EvidenceAnchorTransform {
    Unchanged,
    Shifted { start_byte: u64, end_byte: u64 },
    Invalidated,
}

/// Proyecta el rango de una evidencia a través de un delta del editor.
/// Los offsets del delta y del resultado son bytes UTF-8 de la revisión base.
/// Si el delta toca el texto citado, la evidencia se invalida; nunca se desplaza
/// una cita cuyo contenido pudo haber cambiado.
pub fn transform_evidence_anchor(
    evidence_start: u64,
    evidence_end: u64,
    change_start: usize,
    change_end: usize,
    replacement_bytes: usize,
) -> Option<EvidenceAnchorTransform> {
    if evidence_start >= evidence_end || change_start > change_end {
        return None;
    }
    let change_start = u64::try_from(change_start).ok()?;
    let change_end = u64::try_from(change_end).ok()?;
    let replacement_bytes = u64::try_from(replacement_bytes).ok()?;

    // Una edición que termina en el inicio de la cita la desplaza; una que
    // comienza en su final queda después de ella. Las inserciones en ambos
    // límites siguen estas mismas reglas sin tocar los bytes citados.
    if change_end <= evidence_start {
        let removed = change_end.checked_sub(change_start)?;
        let delta = i128::from(replacement_bytes) - i128::from(removed);
        let start = (i128::from(evidence_start) + delta).try_into().ok()?;
        let end = (i128::from(evidence_end) + delta).try_into().ok()?;
        return Some(EvidenceAnchorTransform::Shifted {
            start_byte: start,
            end_byte: end,
        });
    }
    if change_start >= evidence_end {
        return Some(EvidenceAnchorTransform::Unchanged);
    }
    Some(EvidenceAnchorTransform::Invalidated)
}

#[derive(Debug, Clone, Copy, Default, Eq, PartialEq)]
pub struct EvidenceRebaseSummary {
    /// Evidencias vigentes de la revisión base que se actualizaron en bloque.
    pub updated: usize,
    /// Rangos que se desplazaron por una edición anterior.
    pub shifted: usize,
    /// Rangos que conservaron su posición.
    pub unchanged: usize,
    /// Evidencias cuyo texto citado fue tocado y permanecen en su revisión anterior.
    pub invalidated: usize,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct EvidenceRecord {
    pub id: String,
    pub target_kind: EvidenceTarget,
    pub target_id: String,
    pub document_id: String,
    pub revision: u64,
    pub start_byte: u64,
    pub end_byte: u64,
    pub excerpt: String,
    pub source_kind: String,
    /// Indica que la cita fue modificada o perdió su anclaje por resincronización.
    pub stale: bool,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RepeatedWordRecord {
    pub normalized: String,
    pub count: u64,
    pub first_start_byte: u64,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct FragmentAnalysisRecord {
    pub id: String,
    pub document_id: String,
    pub revision: u64,
    pub start_byte: u64,
    pub end_byte: u64,
    pub character_count: u64,
    pub word_count: u64,
    pub unique_word_count: u64,
    pub sentence_count: u64,
    pub paragraph_count: u64,
    pub long_word_count: u64,
    pub average_word_length_milli: u64,
    /// Texto exacto analizado; None identifica registros históricos sin procedencia textual.
    pub source_text: Option<String>,
    pub repeated_words: Vec<RepeatedWordRecord>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
#[repr(u8)]
pub enum RecordStatus {
    Proposed = 1,
    Confirmed = 2,
    Rejected = 3,
    Superseded = 4,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
#[repr(u8)]
pub enum EvidenceTarget {
    Entity = 1,
    Relation = 2,
    Event = 3,
}

#[derive(Default)]
struct DocumentEvidenceTargets {
    entities: BTreeMap<String, usize>,
    relations: BTreeMap<String, usize>,
    events: BTreeMap<String, usize>,
}

impl DocumentEvidenceTargets {
    fn counts_mut(&mut self, kind: EvidenceTarget) -> &mut BTreeMap<String, usize> {
        match kind {
            EvidenceTarget::Entity => &mut self.entities,
            EvidenceTarget::Relation => &mut self.relations,
            EvidenceTarget::Event => &mut self.events,
        }
    }

    fn insert(&mut self, kind: EvidenceTarget, id: &str) {
        *self.counts_mut(kind).entry(id.to_owned()).or_default() += 1;
    }

    fn remove(&mut self, kind: EvidenceTarget, id: &str) {
        let counts = self.counts_mut(kind);
        match counts.get(id).copied() {
            Some(count) if count > 1 => {
                if let Some(current) = counts.get_mut(id) { *current = count - 1; }
            }
            Some(_) => { counts.remove(id); }
            None => {}
        }
    }

    fn is_empty(&self) -> bool {
        self.entities.is_empty() && self.relations.is_empty() && self.events.is_empty()
    }

    fn ids(&self, kind: EvidenceTarget) -> &BTreeMap<String, usize> {
        match kind {
            EvidenceTarget::Entity => &self.entities,
            EvidenceTarget::Relation => &self.relations,
            EvidenceTarget::Event => &self.events,
        }
    }
}

/// Incidencia detectada por una auditoría explícita del almacén narrativo.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct IntegrityIssue {
    pub table: &'static str,
    pub record_id: String,
    pub code: &'static str,
    pub target_id: Option<String>,
}

/// Página acotada de auditoría. El cursor apunta al último registro examinado.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct IntegrityAuditPage {
    pub issues: Vec<IntegrityIssue>,
    pub scanned: usize,
    pub next_after: Option<String>,
    pub has_more: bool,
}

pub struct NarrativeKnowledgeStore {
    project_id: String,
    store: ProjectStore,
    // Índices derivados por documento: se reconstruyen juntos una sola vez y
    // se mantienen al insertar o reemplazar evidencias durante esta instancia.
    evidence_ids_by_document: Option<HashMap<String, BTreeSet<String>>>,
    evidence_targets_by_document: Option<HashMap<String, DocumentEvidenceTargets>>,
    fragment_analysis_ids_by_document: Option<HashMap<String, BTreeSet<String>>>,
    fragment_analysis_document_by_id: Option<HashMap<String, String>>,
}

impl NarrativeKnowledgeStore {
    /// Abre un almacén narrativo local. project_id debe proceder del anfitrión.
    pub fn open(
        project_id: impl Into<String>,
        pages_path: impl AsRef<Path>,
        wal_path: impl AsRef<Path>,
    ) -> Result<Self, KnowledgeError> {
        let project_id = project_id.into();
        validate_id(&project_id, "project_id")?;
        let store = ProjectStore::open(pages_path, wal_path)
            .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
        Ok(Self {
            project_id, store,
            evidence_ids_by_document: None,
            evidence_targets_by_document: None,
            fragment_analysis_ids_by_document: None,
            fragment_analysis_document_by_id: None,
        })
    }

    /// Abre un workspace narrativo existente sin crear archivos ausentes.
    /// Las rutas deben apuntar a una working copy mutable, no a una generación publicada.
    pub fn open_existing(
        project_id: impl Into<String>,
        pages_path: impl AsRef<Path>,
        wal_path: impl AsRef<Path>,
    ) -> Result<Self, KnowledgeError> {
        let project_id = project_id.into();
        validate_id(&project_id, "project_id")?;
        let store = ProjectStore::open_existing(pages_path, wal_path)
            .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
        Ok(Self {
            project_id, store,
            evidence_ids_by_document: None,
            evidence_targets_by_document: None,
            fragment_analysis_ids_by_document: None,
            fragment_analysis_document_by_id: None,
        })
    }

    /// Abre una working copy existente y liga todas sus escrituras al lock de sesión.
    pub fn open_existing_with_session_validator(
        project_id: impl Into<String>,
        pages_path: impl AsRef<Path>,
        wal_path: impl AsRef<Path>,
        validator: mldb_storage::bundle::SessionLockValidator,
    ) -> Result<Self, KnowledgeError> {
        let project_id = project_id.into();
        validate_id(&project_id, "project_id")?;
        let store = ProjectStore::open_existing_with_session_validator(
            pages_path, wal_path, validator,
        ).map_err(|error| KnowledgeError::Storage(error.to_string()))?;
        Ok(Self {
            project_id, store,
            evidence_ids_by_document: None,
            evidence_targets_by_document: None,
            fragment_analysis_ids_by_document: None,
            fragment_analysis_document_by_id: None,
        })
    }

    pub fn project_id(&self) -> &str { &self.project_id }

    pub fn put_entity(&mut self, record: &EntityRecord) -> Result<(), KnowledgeError> {
        validate_id(&record.id, "entity.id")?;
        validate_nonempty_text(&record.canonical_name, "entity.canonical_name")?;
        validate_nonempty_text(&record.entity_type, "entity.entity_type")?;
        let mut bytes = vec![FORMAT_VERSION, record.status as u8];
        put_string(&mut bytes, &record.canonical_name)?;
        put_string(&mut bytes, &record.entity_type)?;
        put_count(&mut bytes, record.attributes.len())?;
        let mut attribute_keys = BTreeSet::new();
        for (key, value) in &record.attributes {
            validate_nonempty_text(key, "attribute.key")?;
            if !attribute_keys.insert(key) {
                return Err(KnowledgeError::Invalid("attribute.key duplicada"));
            }
            put_string(&mut bytes, key)?;
            put_string(&mut bytes, value)?;
        }
        self.put(ENTITY_TABLE, &record.id, bytes)
    }

    pub fn get_entity(&mut self, id: &str) -> Result<Option<EntityRecord>, KnowledgeError> {
        let Some(bytes) = self.get(ENTITY_TABLE, id)? else { return Ok(None); };
        let mut reader = Reader::new(&bytes);
        let status = reader.status()?;
        let canonical_name = reader.string()?;
        let entity_type = reader.string()?;
        let count = reader.count()?;
        let mut attributes = Vec::with_capacity(count);
        let mut attribute_keys = BTreeSet::new();
        for _ in 0..count {
            let key = reader.string()?;
            if key.trim().is_empty() || !attribute_keys.insert(key.clone()) {
                return Err(KnowledgeError::Corrupt("clave de atributo vacía o duplicada"));
            }
            attributes.push((key, reader.string()?));
        }
        reader.finish()?;
        Ok(Some(EntityRecord { id: id.to_owned(), canonical_name, entity_type, attributes, status }))
    }

    pub fn put_relation(&mut self, record: &RelationRecord) -> Result<(), KnowledgeError> {
        validate_id(&record.id, "relation.id")?;
        validate_id(&record.subject_id, "relation.subject_id")?;
        validate_nonempty_text(&record.predicate, "relation.predicate")?;
        validate_id(&record.object_id, "relation.object_id")?;
        if self.get_entity(&record.subject_id)?.is_none()
            || self.get_entity(&record.object_id)?.is_none()
        {
            return Err(KnowledgeError::Invalid("relación referencia una entidad inexistente"));
        }
        let mut bytes = vec![FORMAT_VERSION, record.status as u8];
        put_string(&mut bytes, &record.subject_id)?;
        put_string(&mut bytes, &record.predicate)?;
        put_string(&mut bytes, &record.object_id)?;
        self.put(RELATION_TABLE, &record.id, bytes)
    }

    pub fn get_relation(&mut self, id: &str) -> Result<Option<RelationRecord>, KnowledgeError> {
        let Some(bytes) = self.get(RELATION_TABLE, id)? else { return Ok(None); };
        let mut reader = Reader::new(&bytes);
        let status = reader.status()?;
        let subject_id = reader.string()?;
        let predicate = reader.string()?;
        let object_id = reader.string()?;
        reader.finish()?;
        Ok(Some(RelationRecord { id: id.to_owned(), subject_id, predicate, object_id, status }))
    }

    pub fn put_event(&mut self, record: &EventRecord) -> Result<(), KnowledgeError> {
        validate_id(&record.id, "event.id")?;
        validate_nonempty_text(&record.label, "event.label")?;
        let mut bytes = vec![FORMAT_VERSION, record.status as u8];
        match record.chronology_order {
            Some(value) => { bytes.push(1); bytes.extend_from_slice(&value.to_le_bytes()); }
            None => bytes.push(0),
        }
        put_string(&mut bytes, &record.label)?;
        self.put(EVENT_TABLE, &record.id, bytes)
    }

    pub fn get_event(&mut self, id: &str) -> Result<Option<EventRecord>, KnowledgeError> {
        let Some(bytes) = self.get(EVENT_TABLE, id)? else { return Ok(None); };
        let mut reader = Reader::new(&bytes);
        let status = reader.status()?;
        let chronology_order = match reader.byte()? {
            0 => None,
            1 => Some(i64::from_le_bytes(reader.take(8)?.try_into().unwrap())),
            _ => return Err(KnowledgeError::Corrupt("marcador cronológico inválido")),
        };
        let label = reader.string()?;
        reader.finish()?;
        Ok(Some(EventRecord { id: id.to_owned(), label, chronology_order, status }))
    }

    fn has_evidence_target(&mut self, kind: EvidenceTarget, target_id: &str) -> Result<bool, KnowledgeError> {
        let records = self.store.scan_project_table_iter(&self.project_id, EVIDENCE_TABLE)
            .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
        for item in records {
            let (id, bytes) = item.map_err(|error| KnowledgeError::Storage(error.to_string()))?;
            if bytes.len() > MAX_RECORD_BYTES {
                return Err(KnowledgeError::Corrupt("registro supera el límite de 8 MiB"));
            }
            let evidence = decode_evidence_record(&id, &bytes)?;
            if evidence.target_kind == kind && evidence.target_id == target_id { return Ok(true); }
        }
        Ok(false)
    }

    fn has_relation_reference(&mut self, entity_id: &str) -> Result<bool, KnowledgeError> {
        let records = self.store.scan_project_table_iter(&self.project_id, RELATION_TABLE)
            .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
        for item in records {
            let (relation_id, bytes) = item.map_err(|error| KnowledgeError::Storage(error.to_string()))?;
            if bytes.len() > MAX_RECORD_BYTES {
                return Err(KnowledgeError::Corrupt("registro supera el límite de 8 MiB"));
            }
            validate_id(&relation_id, "relation.id")
                .map_err(|_| KnowledgeError::Corrupt("ID de relación inválido"))?;
            let mut reader = Reader::new(&bytes);
            let _status = reader.status()?;
            let subject_id = reader.string()?;
            let predicate = reader.string()?;
            let object_id = reader.string()?;
            reader.finish()?;
            validate_id(&subject_id, "relation.subject_id")
                .map_err(|_| KnowledgeError::Corrupt("sujeto de relación inválido"))?;
            validate_nonempty_text(&predicate, "relation.predicate")
                .map_err(|_| KnowledgeError::Corrupt("predicado de relación inválido"))?;
            validate_id(&object_id, "relation.object_id")
                .map_err(|_| KnowledgeError::Corrupt("objeto de relación inválido"))?;
            if subject_id == entity_id || object_id == entity_id { return Ok(true); }
        }
        Ok(false)
    }

    /// Rechaza la eliminación si existen relaciones o evidencias dependientes.
    pub fn delete_entity(&mut self, id: &str) -> Result<bool, KnowledgeError> {
        validate_id(id, "entity.id")?;
        if self.get_entity(id)?.is_none() { return Ok(false); }
        if self.has_relation_reference(id)? {
            return Err(KnowledgeError::Invalid("entidad referenciada por una relación; elimine primero la relación"));
        }
        if self.has_evidence_target(EvidenceTarget::Entity, id)? {
            return Err(KnowledgeError::Invalid("entidad referenciada por evidencias; elimine primero las evidencias"));
        }
        self.store.delete_project(&self.project_id, ENTITY_TABLE, id)
            .map_err(|error| KnowledgeError::Storage(error.to_string()))
    }

    /// Rechaza la eliminación si existen evidencias dependientes.
    pub fn delete_relation(&mut self, id: &str) -> Result<bool, KnowledgeError> {
        validate_id(id, "relation.id")?;
        if self.get_relation(id)?.is_none() { return Ok(false); }
        if self.has_evidence_target(EvidenceTarget::Relation, id)? {
            return Err(KnowledgeError::Invalid("relación referenciada por evidencias; elimine primero las evidencias"));
        }
        self.store.delete_project(&self.project_id, RELATION_TABLE, id)
            .map_err(|error| KnowledgeError::Storage(error.to_string()))
    }

    /// Rechaza la eliminación si existen evidencias dependientes.
    pub fn delete_event(&mut self, id: &str) -> Result<bool, KnowledgeError> {
        validate_id(id, "event.id")?;
        if self.get_event(id)?.is_none() { return Ok(false); }
        if self.has_evidence_target(EvidenceTarget::Event, id)? {
            return Err(KnowledgeError::Invalid("acontecimiento referenciado por evidencias; elimine primero las evidencias"));
        }
        self.store.delete_project(&self.project_id, EVENT_TABLE, id)
            .map_err(|error| KnowledgeError::Storage(error.to_string()))
    }

    /// Lee el registro previo solo cuando hay índices derivados en memoria.
    /// Si el valor durable está corrupto, invalida ambos índices: la operación
    /// de reemplazo/eliminación podrá repararlo sin dejar índices parcialmente fiables.
    fn previous_evidence_for_index_update(
        &mut self,
        id: &str,
    ) -> Result<Option<EvidenceRecord>, KnowledgeError> {
        if self.evidence_ids_by_document.is_none() && self.evidence_targets_by_document.is_none() {
            return Ok(None);
        }
        match self.get_evidence(id) {
            Ok(previous) => Ok(previous),
            Err(KnowledgeError::Corrupt(_)) => {
                self.evidence_ids_by_document = None;
                self.evidence_targets_by_document = None;
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub fn put_evidence(&mut self, record: &EvidenceRecord) -> Result<(), KnowledgeError> {
        validate_id(&record.id, "evidence.id")?;
        validate_id(&record.target_id, "evidence.target_id")?;
        validate_id(&record.document_id, "evidence.document_id")?;
        validate_nonempty_text(&record.source_kind, "evidence.source_kind")?;
        validate_nonempty_text(&record.excerpt, "evidence.excerpt")?;
        if record.start_byte >= record.end_byte || record.stale {
            return Err(KnowledgeError::Invalid("evidence requiere un rango vigente y no vacío"));
        }
        let target_exists = match record.target_kind {
            EvidenceTarget::Entity => self.get_entity(&record.target_id)?.is_some(),
            EvidenceTarget::Relation => self.get_relation(&record.target_id)?.is_some(),
            EvidenceTarget::Event => self.get_event(&record.target_id)?.is_some(),
        };
        if !target_exists {
            return Err(KnowledgeError::Invalid("evidencia referencia un destino inexistente"));
        }
        let previous = self.previous_evidence_for_index_update(&record.id)?;
        self.put(EVIDENCE_TABLE, &record.id, encode_evidence(record)?)?;
        if let Some(index) = self.evidence_ids_by_document.as_mut() {
            if let Some(previous) = previous.as_ref() {
                if previous.document_id != record.document_id {
                    let remove_document = if let Some(ids) = index.get_mut(&previous.document_id) {
                        ids.remove(&record.id);
                        ids.is_empty()
                    } else {
                        false
                    };
                    if remove_document { index.remove(&previous.document_id); }
                }
            }
            index.entry(record.document_id.clone()).or_default().insert(record.id.clone());
        }
        if let Some(index) = self.evidence_targets_by_document.as_mut() {
            let target_changed = previous.as_ref().map_or(true, |previous| {
                previous.document_id != record.document_id
                    || previous.target_kind != record.target_kind
                    || previous.target_id != record.target_id
            });
            if target_changed {
                if let Some(previous) = previous.as_ref() {
                    let remove_document = if let Some(targets) = index.get_mut(&previous.document_id) {
                        targets.remove(previous.target_kind, &previous.target_id);
                        targets.is_empty()
                    } else {
                        false
                    };
                    if remove_document { index.remove(&previous.document_id); }
                }
                index.entry(record.document_id.clone()).or_default()
                    .insert(record.target_kind, &record.target_id);
            }
        }
        Ok(())
    }

    /// Reconstruye evidencias a través de una secuencia durable con dos pasadas
    /// sobre el índice del documento y lotes pequeños idempotentes de escritura.
    pub fn rebase_document_evidence_history(
        &mut self,
        document_id: &str,
        target_revision: u64,
        changes: &[crate::persistent::DurableDocumentChange],
    ) -> Result<EvidenceRebaseSummary, KnowledgeError> {
        validate_id(document_id, "evidence.document_id")?;
        // Esta API también puede recibir deltas construidos por un llamador
        // interno. No se deben desplazar citas con una cadena incompleta,
        // desordenada o cuyo destino no coincida con la revisión solicitada.
        for (index, change) in changes.iter().enumerate() {
            if change.start_byte > change.end_byte
                || change.base_revision.checked_add(1) != Some(change.revision)
                || (index > 0 && (
                    changes[index - 1].sequence.checked_add(1) != Some(change.sequence)
                    || changes[index - 1].revision != change.base_revision
                ))
            {
                return Err(KnowledgeError::Invalid("historial de cambios no es consecutivo"));
            }
        }
        if changes.last().is_some_and(|change| change.revision != target_revision) {
            return Err(KnowledgeError::Invalid("revisión destino no coincide con el historial"));
        }
        let mut summary = EvidenceRebaseSummary::default();
        // Primera pasada: estimar el coste sin conservar todos los IDs/registros
        // del documento en un Vec. Cada lectura materializa solo un registro.
        self.ensure_evidence_document_index()?;
        let mut work = 0usize;
        {
            // El índice BTreeSet ya está ordenado y vive en otro campo del
            // almacén; recorrerlo directamente evita reiniciar el B+Tree desde
            // el principio para cada lote y no crea una copia de los IDs.
            let project_id = self.project_id.as_str();
            let store = &mut self.store;
            if let Some(ids) = self.evidence_ids_by_document.as_ref()
                .and_then(|index| index.get(document_id))
            {
                for id in ids {
                    let Some(record) = read_evidence_record(store, project_id, id)? else { continue; };
                    if record.stale || record.revision == target_revision { continue; }
                    let first = changes.partition_point(|change| change.revision <= record.revision);
                    work = work.checked_add(changes.len() - first).unwrap_or(usize::MAX);
                }
            }
        }
        let conservative_fallback = work > MAX_EVIDENCE_HISTORY_TRANSFORM_STEPS;
        let mut operations = Vec::with_capacity(EVIDENCE_HISTORY_WRITE_BATCH_RECORDS);
        // Segunda pasada: recorre el índice sin clonarlo y confirma lotes pequeños.
        let project_id = self.project_id.clone();
        let store = &mut self.store;
        if let Some(ids) = self.evidence_ids_by_document.as_ref()
            .and_then(|index| index.get(document_id))
        {
            for id in ids {
            let Some(mut record) = read_evidence_record(store, &project_id, id)? else { continue; };
            if record.stale || record.revision == target_revision { continue; }
            let first = changes.partition_point(|change| change.revision <= record.revision);
            let mut advanced = false;
            if conservative_fallback {
                // Evita que una recuperación histórica excepcional monopolice
                // el hilo de conocimiento: conserva procedencia y no adivina.
                record.stale = true;
                summary.invalidated += 1;
                advanced = true;
            } else {
                for change in &changes[first..] {
                    if change.base_revision != record.revision {
                        break;
                    }
                    match transform_evidence_anchor(
                        record.start_byte, record.end_byte,
                        change.start_byte, change.end_byte, change.replacement_bytes,
                    ).ok_or(KnowledgeError::Invalid("rango de edición o evidencia inválido"))? {
                        EvidenceAnchorTransform::Invalidated => {
                            record.stale = true;
                            summary.invalidated += 1;
                            advanced = true;
                            break;
                        }
                        EvidenceAnchorTransform::Unchanged => {
                            record.revision = change.revision;
                            summary.unchanged += 1;
                            advanced = true;
                        }
                        EvidenceAnchorTransform::Shifted { start_byte, end_byte } => {
                            record.revision = change.revision;
                            record.start_byte = start_byte;
                            record.end_byte = end_byte;
                            summary.shifted += 1;
                            advanced = true;
                        }
                    }
                }
                if !record.stale && record.revision != target_revision {
                    // Falta un delta entre la revisión de la cita y el snapshot actual.
                    record.stale = true;
                    summary.invalidated += 1;
                    advanced = true;
                }
            }
            if advanced {
                summary.updated += 1;
                operations.push(ProjectOperation::Put {
                    project_id: project_id.clone(),
                    table: EVIDENCE_TABLE.to_owned(),
                    record_id: record.id.clone(),
                    value: encode_evidence(&record)?,
                });
                if operations.len() >= EVIDENCE_HISTORY_WRITE_BATCH_RECORDS {
                    store.apply_batch(std::mem::take(&mut operations))
                        .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
                    operations = Vec::with_capacity(EVIDENCE_HISTORY_WRITE_BATCH_RECORDS);
                }
            }
            }
        }
        if !operations.is_empty() {
            store.apply_batch(operations)
                .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
        }
        Ok(summary)
    }

    /// Actualiza por lotes las evidencias de un documento afectadas por un delta
    /// ya confirmado. Cada lote es durable e idempotente. Las citas intersectadas permanecen en su
    /// revisión anterior para que nunca se presenten como evidencia vigente.
    pub fn rebase_document_evidence(
        &mut self,
        document_id: &str,
        base_revision: u64,
        new_revision: u64,
        change_start: usize,
        change_end: usize,
        replacement_bytes: usize,
    ) -> Result<EvidenceRebaseSummary, KnowledgeError> {
        validate_id(document_id, "evidence.document_id")?;
        if base_revision.checked_add(1) != Some(new_revision) {
            return Err(KnowledgeError::Invalid("rebase requiere revisiones consecutivas"));
        }
        self.ensure_evidence_document_index()?;
        let mut summary = EvidenceRebaseSummary::default();
        let mut operations = Vec::with_capacity(EVIDENCE_HISTORY_WRITE_BATCH_RECORDS);
        let project_id = self.project_id.clone();
        let store = &mut self.store;
        if let Some(ids) = self.evidence_ids_by_document.as_ref()
            .and_then(|index| index.get(document_id))
        {
            for id in ids {
            let Some(mut record) = read_evidence_record(store, &project_id, id)? else { continue; };
            if record.revision != base_revision || record.stale {
                continue;
            }
            let transform = transform_evidence_anchor(
                record.start_byte,
                record.end_byte,
                change_start,
                change_end,
                replacement_bytes,
            ).ok_or(KnowledgeError::Invalid("rango de edición o evidencia inválido"))?;
            match transform {
                EvidenceAnchorTransform::Invalidated => {
                    record.stale = true;
                    summary.updated += 1;
                    summary.invalidated += 1;
                    operations.push(ProjectOperation::Put {
                        project_id: project_id.clone(),
                        table: EVIDENCE_TABLE.to_owned(),
                        record_id: record.id.clone(),
                        value: encode_evidence(&record)?,
                    });
                }
                EvidenceAnchorTransform::Unchanged => {
                    record.revision = new_revision;
                    summary.updated += 1;
                    summary.unchanged += 1;
                    operations.push(ProjectOperation::Put {
                        project_id: project_id.clone(),
                        table: EVIDENCE_TABLE.to_owned(),
                        record_id: record.id.clone(),
                        value: encode_evidence(&record)?,
                    });
                }
                EvidenceAnchorTransform::Shifted { start_byte, end_byte } => {
                    record.revision = new_revision;
                    record.start_byte = start_byte;
                    record.end_byte = end_byte;
                    summary.updated += 1;
                    summary.shifted += 1;
                    operations.push(ProjectOperation::Put {
                        project_id: project_id.clone(),
                        table: EVIDENCE_TABLE.to_owned(),
                        record_id: record.id.clone(),
                        value: encode_evidence(&record)?,
                    });
                }
            }
            if operations.len() >= EVIDENCE_HISTORY_WRITE_BATCH_RECORDS {
                store.apply_batch(std::mem::take(&mut operations))
                    .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
                operations = Vec::with_capacity(EVIDENCE_HISTORY_WRITE_BATCH_RECORDS);
            }
            }
        }
        if !operations.is_empty() {
            store.apply_batch(operations)
                .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
        }
        Ok(summary)
    }

    /// Marca como obsoletas todas las evidencias de un documento cuya base
    /// fue reemplazada por un snapshot autoritativo no proyectable.
    pub fn invalidate_document_evidence(&mut self, document_id: &str) -> Result<usize, KnowledgeError> {
        validate_id(document_id, "evidence.document_id")?;
        self.ensure_evidence_document_index()?;
        let mut operations = Vec::with_capacity(EVIDENCE_HISTORY_WRITE_BATCH_RECORDS);
        let mut count = 0usize;
        let project_id = self.project_id.clone();
        let store = &mut self.store;
        if let Some(ids) = self.evidence_ids_by_document.as_ref()
            .and_then(|index| index.get(document_id))
        {
            for id in ids {
                let Some(mut record) = read_evidence_record(store, &project_id, id)? else { continue; };
                if !record.stale {
                    record.stale = true;
                    count += 1;
                    operations.push(ProjectOperation::Put {
                        project_id: project_id.clone(),
                        table: EVIDENCE_TABLE.to_owned(),
                        record_id: record.id.clone(),
                        value: encode_evidence(&record)?,
                    });
                }
                if operations.len() >= EVIDENCE_HISTORY_WRITE_BATCH_RECORDS {
                    store.apply_batch(std::mem::take(&mut operations))
                        .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
                    operations = Vec::with_capacity(EVIDENCE_HISTORY_WRITE_BATCH_RECORDS);
                }
            }
        }
        if !operations.is_empty() {
            store.apply_batch(operations)
                .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
        }
        Ok(count)
    }

    pub fn get_evidence(&mut self, id: &str) -> Result<Option<EvidenceRecord>, KnowledgeError> {
        let Some(bytes) = self.get(EVIDENCE_TABLE, id)? else { return Ok(None); };
        decode_evidence_record(id, &bytes).map(Some)
    }

    pub fn put_fragment_analysis(&mut self, record: &FragmentAnalysisRecord) -> Result<(), KnowledgeError> {
        validate_id(&record.id, "fragment_analysis.id")?;
        validate_id(&record.document_id, "fragment_analysis.document_id")?;
        if record.start_byte > record.end_byte
            || record.unique_word_count > record.word_count
            || record.long_word_count > record.word_count
        {
            return Err(KnowledgeError::Invalid("métricas o rango de fragmento incoherentes"));
        }
        if let Some(source_text) = record.source_text.as_deref() {
            if source_text.len() > MAX_FRAGMENT_ANALYSIS_SOURCE_BYTES
                || u64::try_from(source_text.len()).ok() != record.end_byte.checked_sub(record.start_byte)
            {
                return Err(KnowledgeError::Invalid("texto de origen no coincide con el rango del análisis"));
            }
        }
        let mut bytes = vec![FRAGMENT_ANALYSIS_FORMAT_VERSION];
        put_string(&mut bytes, &record.document_id)?;
        for value in [
            record.revision, record.start_byte, record.end_byte,
            record.character_count, record.word_count, record.unique_word_count,
            record.sentence_count, record.paragraph_count, record.long_word_count,
            record.average_word_length_milli,
        ] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        match record.source_text.as_deref() {
            Some(source_text) => { bytes.push(1); put_string(&mut bytes, source_text)?; }
            None => bytes.push(0),
        }
        put_count(&mut bytes, record.repeated_words.len())?;
        let mut repeated_keys = BTreeSet::new();
        for word in &record.repeated_words {
            validate_nonempty_text(&word.normalized, "repeated_word.normalized")?;
            if word.count < 2 || word.count > record.word_count
                || word.first_start_byte < record.start_byte
                || word.first_start_byte >= record.end_byte
                || !repeated_keys.insert(&word.normalized)
            {
                return Err(KnowledgeError::Invalid("palabra repetida incoherente o duplicada"));
            }
            put_string(&mut bytes, &word.normalized)?;
            bytes.extend_from_slice(&word.count.to_le_bytes());
            bytes.extend_from_slice(&word.first_start_byte.to_le_bytes());
        }
        let previous_document = if let Some(index) = self.fragment_analysis_document_by_id.as_ref() {
            index.get(&record.id).cloned()
        } else {
            None
        };
        self.put(FRAGMENT_ANALYSIS_TABLE, &record.id, bytes)?;
        if let Some(index) = self.fragment_analysis_ids_by_document.as_mut() {
            if let Some(previous) = previous_document.as_deref() {
                if previous != record.document_id.as_str() {
                    let remove_document = if let Some(ids) = index.get_mut(previous) {
                        ids.remove(&record.id);
                        ids.is_empty()
                    } else { false };
                    if remove_document { index.remove(previous); }
                }
            }
            index.entry(record.document_id.clone()).or_default().insert(record.id.clone());
        }
        if let Some(index) = self.fragment_analysis_document_by_id.as_mut() {
            index.insert(record.id.clone(), record.document_id.clone());
        }
        Ok(())
    }

    pub fn get_fragment_analysis(&mut self, id: &str) -> Result<Option<FragmentAnalysisRecord>, KnowledgeError> {
        let Some(bytes) = self.get(FRAGMENT_ANALYSIS_TABLE, id)? else { return Ok(None); };
        let mut reader = Reader::new(&bytes);
        let version = reader.byte()?;
        if version != FORMAT_VERSION && version != FRAGMENT_ANALYSIS_FORMAT_VERSION {
            return Err(KnowledgeError::Corrupt("versión de análisis de fragmento desconocida"));
        }
        let document_id = reader.string()?;
        let revision = reader.u64()?;
        let start_byte = reader.u64()?;
        let end_byte = reader.u64()?;
        let character_count = reader.u64()?;
        let word_count = reader.u64()?;
        let unique_word_count = reader.u64()?;
        let sentence_count = reader.u64()?;
        let paragraph_count = reader.u64()?;
        let long_word_count = reader.u64()?;
        let average_word_length_milli = reader.u64()?;
        let source_text = if version >= FRAGMENT_ANALYSIS_FORMAT_VERSION {
            match reader.byte()? {
                0 => None,
                1 => {
                    let text = reader.string()?;
                    if text.len() > MAX_FRAGMENT_ANALYSIS_SOURCE_BYTES
                        || u64::try_from(text.len()).ok() != end_byte.checked_sub(start_byte)
                    {
                        return Err(KnowledgeError::Corrupt("texto de origen no coincide con el rango"));
                    }
                    Some(text)
                }
                _ => return Err(KnowledgeError::Corrupt("marcador de texto de origen inválido")),
            }
        } else {
            None
        };
        let count = reader.count()?;
        let mut repeated_words = Vec::with_capacity(count);
        for _ in 0..count {
            repeated_words.push(RepeatedWordRecord {
                normalized: reader.string()?,
                count: reader.u64()?,
                first_start_byte: reader.u64()?,
            });
        }
        reader.finish()?;
        let record = FragmentAnalysisRecord {
            id: id.to_owned(), document_id, revision, start_byte, end_byte,
            character_count, word_count, unique_word_count, sentence_count,
            paragraph_count, long_word_count, average_word_length_milli, source_text, repeated_words,
        };
        if record.start_byte > record.end_byte || record.unique_word_count > record.word_count
            || record.long_word_count > record.word_count
        {
            return Err(KnowledgeError::Corrupt("métricas de fragmento incoherentes"));
        }
        let mut repeated_keys = BTreeSet::new();
        for word in &record.repeated_words {
            if word.normalized.trim().is_empty() || word.count < 2 || word.count > record.word_count
                || word.first_start_byte < record.start_byte
                || word.first_start_byte >= record.end_byte
                || !repeated_keys.insert(&word.normalized)
            {
                return Err(KnowledgeError::Corrupt("palabras repetidas incoherentes"));
            }
        }
        Ok(Some(record))
    }

    pub fn delete_fragment_analysis(&mut self, id: &str) -> Result<bool, KnowledgeError> {
        validate_id(id, "fragment_analysis.id")?;
        let deleted = self.store.delete_project(&self.project_id, FRAGMENT_ANALYSIS_TABLE, id)
            .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
        if !deleted { return Ok(false); }
        let previous_document = self.fragment_analysis_document_by_id.as_mut()
            .and_then(|index| index.remove(id));
        if let (Some(document_id), Some(index)) = (
            previous_document,
            self.fragment_analysis_ids_by_document.as_mut(),
        ) {
            let remove_document = if let Some(ids) = index.get_mut(&document_id) {
                ids.remove(id);
                ids.is_empty()
            } else { false };
            if remove_document { index.remove(&document_id); }
        }
        Ok(true)
    }

    /// Elimina una evidencia y mantiene sincronizados los índices derivados.
    pub fn delete_evidence(&mut self, id: &str) -> Result<bool, KnowledgeError> {
        validate_id(id, "evidence.id")?;
        let previous = self.previous_evidence_for_index_update(id)?;
        let deleted = self.store.delete_project(&self.project_id, EVIDENCE_TABLE, id)
            .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
        if !deleted { return Ok(false); }
        if let Some(previous) = previous.as_ref() {
            if let Some(index) = self.evidence_ids_by_document.as_mut() {
                let remove_document = if let Some(ids) = index.get_mut(&previous.document_id) {
                    ids.remove(id); ids.is_empty()
                } else { false };
                if remove_document { index.remove(&previous.document_id); }
            }
            if let Some(index) = self.evidence_targets_by_document.as_mut() {
                let remove_document = if let Some(targets) = index.get_mut(&previous.document_id) {
                    targets.remove(previous.target_kind, &previous.target_id); targets.is_empty()
                } else { false };
                if remove_document { index.remove(&previous.document_id); }
            }
        }
        Ok(true)
    }

    /// Reconstruye una sola vez los índices derivados de análisis por documento.
    /// El recorrido es incremental y no materializa el conjunto completo de registros.
    fn ensure_fragment_analysis_document_index(&mut self) -> Result<(), KnowledgeError> {
        if self.fragment_analysis_ids_by_document.is_none()
            || self.fragment_analysis_document_by_id.is_none()
        {
            let mut by_document: HashMap<String, BTreeSet<String>> = HashMap::new();
            let mut by_id: HashMap<String, String> = HashMap::new();
            {
                let records = self.store.scan_project_table_iter(
                    &self.project_id, FRAGMENT_ANALYSIS_TABLE,
                ).map_err(|error| KnowledgeError::Storage(error.to_string()))?;
                for item in records {
                    let (id, bytes) = item
                        .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
                    // El índice es derivado y no debe impedir que la auditoría
                    // global informe registros dañados. Solo indexa cabeceras legibles;
                    // el decodificador completo informa corrupción al consultar el ID.
                    if bytes.len() > MAX_RECORD_BYTES { continue; }
                    let mut reader = Reader::new(&bytes);
                    if reader.header().is_err() { continue; }
                    let Ok(document_id) = reader.string() else { continue; };
                    if validate_id(&document_id, "fragment_analysis.document_id").is_err() {
                        continue;
                    }
                    by_document.entry(document_id.clone()).or_default().insert(id.clone());
                    by_id.insert(id, document_id);
                }
            }
            self.fragment_analysis_ids_by_document = Some(by_document);
            self.fragment_analysis_document_by_id = Some(by_id);
        }
        Ok(())
    }

    /// Página de análisis de un documento con cursor exclusivo O(log n + página).
    pub fn fragment_analysis_ids_for_document_after(
        &mut self, document_id: &str, after_id: Option<&str>, limit: usize,
    ) -> Result<Vec<String>, KnowledgeError> {
        validate_id(document_id, "fragment_analysis.document_id")?;
        if limit == 0 || limit > 1_000 {
            return Err(KnowledgeError::Invalid("limit debe estar entre 1 y 1000"));
        }
        if let Some(id) = after_id { validate_id(id, "after_id")?; }
        self.ensure_fragment_analysis_document_index()?;
        let Some(ids) = self.fragment_analysis_ids_by_document.as_ref()
            .and_then(|index| index.get(document_id)) else {
                return Ok(Vec::new());
            };
        let mut page = Vec::with_capacity(limit);
        match after_id {
            Some(id) => page.extend(ids.range((
                std::ops::Bound::Excluded(id.to_owned()),
                std::ops::Bound::Unbounded,
            )).take(limit).cloned()),
            None => page.extend(ids.iter().take(limit).cloned()),
        }
        Ok(page)
    }

    pub fn fragment_analysis_ids(&mut self) -> Result<Vec<String>, KnowledgeError> {
        self.ids_in_table(FRAGMENT_ANALYSIS_TABLE)
    }

    pub fn entity_ids(&mut self) -> Result<Vec<String>, KnowledgeError> {
        self.ids_in_table(ENTITY_TABLE)
    }
    pub fn relation_ids(&mut self) -> Result<Vec<String>, KnowledgeError> {
        self.ids_in_table(RELATION_TABLE)
    }
    pub fn event_ids(&mut self) -> Result<Vec<String>, KnowledgeError> {
        self.ids_in_table(EVENT_TABLE)
    }
    pub fn evidence_ids(&mut self) -> Result<Vec<String>, KnowledgeError> {
        self.ids_in_table(EVIDENCE_TABLE)
    }

    /// Devuelve una página ordenada de IDs de cualquier tabla narrativa.
    /// La iteración del almacén es incremental: solo se materializan los IDs
    /// solicitados y nunca se construye una lista completa intermedia.
    pub fn entity_ids_page(&mut self, offset: usize, limit: usize) -> Result<Vec<String>, KnowledgeError> {
        self.ids_in_table_page(ENTITY_TABLE, offset, limit)
    }
    pub fn relation_ids_page(&mut self, offset: usize, limit: usize) -> Result<Vec<String>, KnowledgeError> {
        self.ids_in_table_page(RELATION_TABLE, offset, limit)
    }
    pub fn event_ids_page(&mut self, offset: usize, limit: usize) -> Result<Vec<String>, KnowledgeError> {
        self.ids_in_table_page(EVENT_TABLE, offset, limit)
    }
    pub fn evidence_ids_page(&mut self, offset: usize, limit: usize) -> Result<Vec<String>, KnowledgeError> {
        self.ids_in_table_page(EVIDENCE_TABLE, offset, limit)
    }
    pub fn fragment_analysis_ids_page(&mut self, offset: usize, limit: usize) -> Result<Vec<String>, KnowledgeError> {
        self.ids_in_table_page(FRAGMENT_ANALYSIS_TABLE, offset, limit)
    }

    /// Paginación por cursor estable: el B+Tree busca directamente después del ID.
    pub fn entity_ids_after(&mut self, after_id: Option<&str>, limit: usize) -> Result<Vec<String>, KnowledgeError> {
        self.ids_in_table_after(ENTITY_TABLE, after_id, limit)
    }
    pub fn relation_ids_after(&mut self, after_id: Option<&str>, limit: usize) -> Result<Vec<String>, KnowledgeError> {
        self.ids_in_table_after(RELATION_TABLE, after_id, limit)
    }
    pub fn event_ids_after(&mut self, after_id: Option<&str>, limit: usize) -> Result<Vec<String>, KnowledgeError> {
        self.ids_in_table_after(EVENT_TABLE, after_id, limit)
    }
    pub fn evidence_ids_after(&mut self, after_id: Option<&str>, limit: usize) -> Result<Vec<String>, KnowledgeError> {
        self.ids_in_table_after(EVIDENCE_TABLE, after_id, limit)
    }
    pub fn fragment_analysis_ids_after(&mut self, after_id: Option<&str>, limit: usize) -> Result<Vec<String>, KnowledgeError> {
        self.ids_in_table_after(FRAGMENT_ANALYSIS_TABLE, after_id, limit)
    }

    /// Devuelve IDs de entidades referenciadas por evidencias del documento.
    pub fn entity_ids_for_document(&mut self, document_id: &str) -> Result<Vec<String>, KnowledgeError> {
        self.knowledge_target_ids_for_document(document_id, EvidenceTarget::Entity)
    }

    /// Devuelve IDs de relaciones referenciadas por evidencias del documento.
    pub fn relation_ids_for_document(&mut self, document_id: &str) -> Result<Vec<String>, KnowledgeError> {
        self.knowledge_target_ids_for_document(document_id, EvidenceTarget::Relation)
    }

    /// Devuelve IDs de acontecimientos referenciados por evidencias del documento.
    pub fn event_ids_for_document(&mut self, document_id: &str) -> Result<Vec<String>, KnowledgeError> {
        self.knowledge_target_ids_for_document(document_id, EvidenceTarget::Event)
    }

    /// Recupera una página de destinos narrativos distintos citados en un documento.
    /// La paginación se aplica al conjunto ordenado de destinos, no a las evidencias.
    pub fn entity_ids_for_document_page(
        &mut self, document_id: &str, offset: usize, limit: usize,
    ) -> Result<Vec<String>, KnowledgeError> {
        self.knowledge_target_ids_for_document_page(document_id, EvidenceTarget::Entity, offset, limit)
    }
    pub fn relation_ids_for_document_page(
        &mut self, document_id: &str, offset: usize, limit: usize,
    ) -> Result<Vec<String>, KnowledgeError> {
        self.knowledge_target_ids_for_document_page(document_id, EvidenceTarget::Relation, offset, limit)
    }
    pub fn event_ids_for_document_page(
        &mut self, document_id: &str, offset: usize, limit: usize,
    ) -> Result<Vec<String>, KnowledgeError> {
        self.knowledge_target_ids_for_document_page(document_id, EvidenceTarget::Event, offset, limit)
    }

    fn knowledge_target_ids_for_document_page(
        &mut self, document_id: &str, target_kind: EvidenceTarget,
        offset: usize, limit: usize,
    ) -> Result<Vec<String>, KnowledgeError> {
        validate_id(document_id, "evidence.document_id")?;
        if limit == 0 || limit > 1_000 {
            return Err(KnowledgeError::Invalid("limit debe estar entre 1 y 1000"));
        }
        self.ensure_evidence_document_index()?;
        let ids = self.evidence_targets_by_document.as_ref()
            .and_then(|index| index.get(document_id))
            .map(|targets| targets.ids(target_kind));
        Ok(ids.map(|ids| ids.keys().skip(offset).take(limit).cloned().collect())
            .unwrap_or_default())
    }

    fn knowledge_target_ids_for_document_after(
        &mut self, document_id: &str, target_kind: EvidenceTarget,
        after_id: Option<&str>, limit: usize,
    ) -> Result<Vec<String>, KnowledgeError> {
        validate_id(document_id, "evidence.document_id")?;
        if let Some(id) = after_id { validate_id(id, "after_id")?; }
        if limit == 0 || limit > 1_000 {
            return Err(KnowledgeError::Invalid("limit debe estar entre 1 y 1000"));
        }
        self.ensure_evidence_document_index()?;
        let ids = self.evidence_targets_by_document.as_ref()
            .and_then(|index| index.get(document_id))
            .map(|targets| targets.ids(target_kind));
        let mut page = Vec::with_capacity(limit);
        if let Some(ids) = ids {
            match after_id {
                Some(id) => page.extend(ids.range((
                    std::ops::Bound::Excluded(id.to_owned()),
                    std::ops::Bound::Unbounded,
                )).take(limit).map(|(id, _)| id.clone())),
                None => page.extend(ids.keys().take(limit).cloned()),
            }
        }
        Ok(page)
    }

    fn knowledge_target_ids_for_document(
        &mut self, document_id: &str, target_kind: EvidenceTarget,
    ) -> Result<Vec<String>, KnowledgeError> {
        validate_id(document_id, "evidence.document_id")?;
        self.ensure_evidence_document_index()?;
        let ids = self.evidence_targets_by_document.as_ref()
            .and_then(|index| index.get(document_id))
            .map(|targets| targets.ids(target_kind));
        let mut page = Vec::new();
        if let Some(ids) = ids {
            for id in ids.keys() {
                if page.len() == 50_000 {
                    return Err(KnowledgeError::Invalid(
                        "más de 50.000 destinos narrativos; use paginación",
                    ));
                }
                page.push(id.clone());
            }
        }
        Ok(page)
    }

    /// Devuelve únicamente las evidencias del documento. El primer uso reconstruye
    /// el índice desde el almacén persistente; las consultas y ediciones siguientes
    /// evitan recorrer evidencias pertenecientes a otros documentos del proyecto.
    fn ensure_evidence_document_index(&mut self) -> Result<(), KnowledgeError> {
        if self.evidence_ids_by_document.is_none() || self.evidence_targets_by_document.is_none() {
            // Un solo recorrido incremental reconstruye ambos índices derivados.
            // No se materializa primero un Vec de IDs ni se impone el límite de
            // 50.000 registros de los listados heredados.
            let mut evidence_index: HashMap<String, BTreeSet<String>> = HashMap::new();
            let mut target_index: HashMap<String, DocumentEvidenceTargets> = HashMap::new();
            {
                let records = self.store.scan_project_table_iter(&self.project_id, EVIDENCE_TABLE)
                    .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
                for item in records {
                    let (id, bytes) = item
                        .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
                    if bytes.len() > MAX_RECORD_BYTES {
                        return Err(KnowledgeError::Corrupt("registro supera el límite de 8 MiB"));
                    }
                    let record = decode_evidence_record(&id, &bytes)?;
                    evidence_index.entry(record.document_id.clone()).or_default().insert(id);
                    target_index.entry(record.document_id).or_default()
                        .insert(record.target_kind, &record.target_id);
                }
            }
            self.evidence_ids_by_document = Some(evidence_index);
            self.evidence_targets_by_document = Some(target_index);
        }
        Ok(())
    }

    pub fn evidence_ids_for_document(&mut self, document_id: &str) -> Result<Vec<String>, KnowledgeError> {
        validate_id(document_id, "evidence.document_id")?;
        self.ensure_evidence_document_index()?;
        let mut page = Vec::new();
        if let Some(ids) = self.evidence_ids_by_document.as_ref()
            .and_then(|index| index.get(document_id))
        {
            for id in ids {
                if page.len() == 50_000 {
                    return Err(KnowledgeError::Invalid(
                        "más de 50.000 evidencias en el documento; use paginación",
                    ));
                }
                page.push(id.clone());
            }
        }
        Ok(page)
    }

    /// Recupera una página ordenada de evidencias de un documento.
    /// El límite evita respuestas enormes; offset permite continuar sin
    /// materializar una copia completa del conjunto de identificadores.
    pub fn evidence_ids_for_document_page(
        &mut self, document_id: &str, offset: usize, limit: usize,
    ) -> Result<Vec<String>, KnowledgeError> {
        validate_id(document_id, "evidence.document_id")?;
        if limit == 0 || limit > 1_000 {
            return Err(KnowledgeError::Invalid("limit debe estar entre 1 y 1000"));
        }
        self.ensure_evidence_document_index()?;
        Ok(self.evidence_ids_by_document.as_ref()
            .and_then(|index| index.get(document_id))
            .map(|ids| ids.iter().skip(offset).take(limit).cloned().collect())
            .unwrap_or_default())
    }

    /// Página de evidencias por cursor exclusivo dentro del índice del documento.
    pub fn evidence_ids_for_document_after(
        &mut self, document_id: &str, after_id: Option<&str>, limit: usize,
    ) -> Result<Vec<String>, KnowledgeError> {
        validate_id(document_id, "evidence.document_id")?;
        if limit == 0 || limit > 1_000 {
            return Err(KnowledgeError::Invalid("limit debe estar entre 1 y 1000"));
        }
        if let Some(id) = after_id {
            validate_id(id, "after_id")?;
        }
        self.ensure_evidence_document_index()?;
        let Some(ids) = self.evidence_ids_by_document.as_ref()
            .and_then(|index| index.get(document_id)) else {
                return Ok(Vec::new());
            };
        let mut page = Vec::with_capacity(limit);
        match after_id {
            Some(id) => page.extend(ids.range((
                std::ops::Bound::Excluded(id.to_owned()),
                std::ops::Bound::Unbounded,
            )).take(limit).cloned()),
            None => page.extend(ids.iter().take(limit).cloned()),
        }
        Ok(page)
    }

    fn ids_in_table_page(
        &mut self, table: &str, offset: usize, limit: usize,
    ) -> Result<Vec<String>, KnowledgeError> {
        if limit == 0 || limit > 1_000 {
            return Err(KnowledgeError::Invalid("limit debe estar entre 1 y 1000"));
        }
        let range = self.store.scan_project_table_iter(&self.project_id, table)
            .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
        let mut ids = Vec::with_capacity(limit);
        for (index, record) in range.enumerate() {
            if index >= offset && ids.len() == limit {
                break;
            }
            let (id, _) = record
                .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
            if index < offset {
                continue;
            }
            ids.push(id);
        }
        Ok(ids)
    }

    /// Audita una tabla narrativa sin modificar datos ni cargarla completa.
    /// La paginación avanza por registros examinados, no por incidencias: una
    /// página puede contener cero incidencias y aun así devolver cursor.
    pub fn audit_integrity_page(
        &mut self,
        table: &str,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<IntegrityAuditPage, KnowledgeError> {
        if limit == 0 || limit > 1_000 {
            return Err(KnowledgeError::Invalid("limit debe estar entre 1 y 1000"));
        }
        let (table_name, table_label) = match table {
            "entity" => (ENTITY_TABLE, "entity"),
            "relation" => (RELATION_TABLE, "relation"),
            "event" => (EVENT_TABLE, "event"),
            "evidence" => (EVIDENCE_TABLE, "evidence"),
            "fragment_analysis" => (FRAGMENT_ANALYSIS_TABLE, "fragment_analysis"),
            _ => return Err(KnowledgeError::Invalid("tabla de auditoría desconocida")),
        };
        if let Some(cursor) = after_id { validate_id(cursor, "after_id")?; }

        // Materializa como máximo una página más un elemento para detectar
        // continuación; libera el préstamo del iterador antes de validar
        // referencias cruzadas mediante get_entity/get_relation/get_event.
        let mut records = Vec::with_capacity(limit.saturating_add(1));
        {
            let range = match after_id {
                Some(cursor) => self.store.scan_project_table_after_iter(&self.project_id, table_name, cursor),
                None => self.store.scan_project_table_iter(&self.project_id, table_name),
            }.map_err(|error| KnowledgeError::Storage(error.to_string()))?;
            for item in range.take(limit.saturating_add(1)) {
                records.push(item.map_err(|error| KnowledgeError::Storage(error.to_string()))?);
            }
        }
        let has_more = records.len() > limit;
        if has_more { records.pop(); }
        let scanned = records.len();
        let next_after = records.last().map(|(id, _)| id.clone());
        let mut issues = Vec::new();

        for (id, bytes) in records {
            macro_rules! add_corrupt {
                ($code:expr) => {{
                    issues.push(IntegrityIssue {
                        table: table_label, record_id: id.clone(), code: $code, target_id: None,
                    });
                }};
            }
            if validate_id(&id, "record_id").is_err() {
                add_corrupt!("invalid_record_id");
                continue;
            }
            if bytes.len() > MAX_RECORD_BYTES {
                add_corrupt!("record_too_large");
                continue;
            }
            match table {
                "entity" => match self.get_entity(&id) {
                    Ok(Some(entity)) => {
                        if validate_nonempty_text(&entity.canonical_name, "entity.canonical_name").is_err()
                            || validate_nonempty_text(&entity.entity_type, "entity.entity_type").is_err()
                        {
                            add_corrupt!("invalid_entity_fields");
                        } else {
                            let mut keys = BTreeSet::new();
                            if entity.attributes.iter().any(|(key, _)| key.trim().is_empty() || !keys.insert(key)) {
                                add_corrupt!("invalid_entity_attributes");
                            }
                        }
                    }
                    Ok(None) => add_corrupt!("record_disappeared"),
                    Err(KnowledgeError::Storage(message)) => return Err(KnowledgeError::Storage(message)),
                    Err(_) => add_corrupt!("malformed_record"),
                },
                "relation" => match self.get_relation(&id) {
                    Ok(Some(relation)) => {
                        if validate_id(&relation.subject_id, "subject_id").is_err()
                            || validate_nonempty_text(&relation.predicate, "predicate").is_err()
                            || validate_id(&relation.object_id, "object_id").is_err()
                        {
                            add_corrupt!("invalid_relation_fields");
                        } else {
                            match self.get_entity(&relation.subject_id) {
                                Ok(Some(_)) => {}
                                Ok(None) => issues.push(IntegrityIssue { table: table_label, record_id: id.clone(), code: "orphan_relation_subject", target_id: Some(relation.subject_id.clone()) }),
                                Err(KnowledgeError::Storage(message)) => return Err(KnowledgeError::Storage(message)),
                                Err(_) => issues.push(IntegrityIssue { table: table_label, record_id: id.clone(), code: "unreadable_relation_subject", target_id: Some(relation.subject_id.clone()) }),
                            }
                            match self.get_entity(&relation.object_id) {
                                Ok(Some(_)) => {}
                                Ok(None) => issues.push(IntegrityIssue { table: table_label, record_id: id.clone(), code: "orphan_relation_object", target_id: Some(relation.object_id.clone()) }),
                                Err(KnowledgeError::Storage(message)) => return Err(KnowledgeError::Storage(message)),
                                Err(_) => issues.push(IntegrityIssue { table: table_label, record_id: id.clone(), code: "unreadable_relation_object", target_id: Some(relation.object_id.clone()) }),
                            }
                        }
                    }
                    Ok(None) => add_corrupt!("record_disappeared"),
                    Err(KnowledgeError::Storage(message)) => return Err(KnowledgeError::Storage(message)),
                    Err(_) => add_corrupt!("malformed_record"),
                },
                "event" => match self.get_event(&id) {
                    Ok(Some(event)) if validate_nonempty_text(&event.label, "event.label").is_err() => add_corrupt!("invalid_event_fields"),
                    Ok(Some(_)) => {}
                    Ok(None) => add_corrupt!("record_disappeared"),
                    Err(KnowledgeError::Storage(message)) => return Err(KnowledgeError::Storage(message)),
                    Err(_) => add_corrupt!("malformed_record"),
                },
                "evidence" => match self.get_evidence(&id) {
                    Ok(Some(evidence)) => {
                        if validate_id(&evidence.target_id, "evidence.target_id").is_err()
                            || validate_id(&evidence.document_id, "evidence.document_id").is_err()
                            || validate_nonempty_text(&evidence.source_kind, "evidence.source_kind").is_err()
                        {
                            add_corrupt!("invalid_evidence_fields");
                            continue;
                        }
                        let target_state = match evidence.target_kind {
                            EvidenceTarget::Entity => self.get_entity(&evidence.target_id).map(|value| value.is_some()),
                            EvidenceTarget::Relation => self.get_relation(&evidence.target_id).map(|value| value.is_some()),
                            EvidenceTarget::Event => self.get_event(&evidence.target_id).map(|value| value.is_some()),
                        };
                        match target_state {
                            Ok(true) => {}
                            Ok(false) => issues.push(IntegrityIssue {
                                table: table_label, record_id: id, code: "orphan_evidence_target",
                                target_id: Some(evidence.target_id),
                            }),
                            Err(KnowledgeError::Storage(message)) => return Err(KnowledgeError::Storage(message)),
                            Err(_) => issues.push(IntegrityIssue {
                                table: table_label, record_id: id, code: "unreadable_evidence_target",
                                target_id: Some(evidence.target_id),
                            }),
                        }
                    }
                    Ok(None) => add_corrupt!("record_disappeared"),
                    Err(KnowledgeError::Storage(message)) => return Err(KnowledgeError::Storage(message)),
                    Err(_) => add_corrupt!("malformed_record"),
                },
                "fragment_analysis" => match self.get_fragment_analysis(&id) {
                    Ok(Some(analysis)) => {
                        if validate_id(&analysis.document_id, "fragment_analysis.document_id").is_err()
                            || analysis.start_byte > analysis.end_byte
                            || analysis.unique_word_count > analysis.word_count
                            || analysis.long_word_count > analysis.word_count
                        {
                            add_corrupt!("invalid_fragment_analysis_fields");
                        } else {
                            if analysis.source_text.is_none() {
                                add_corrupt!("fragment_analysis_source_unavailable");
                            }
                            let mut words = BTreeSet::new();
                            if analysis.repeated_words.iter().any(|word| {
                                word.normalized.trim().is_empty()
                                    || word.count < 2
                                    || word.count > analysis.word_count
                                    || word.first_start_byte < analysis.start_byte
                                    || word.first_start_byte >= analysis.end_byte
                                    || !words.insert(&word.normalized)
                            }) {
                                add_corrupt!("invalid_fragment_analysis_words");
                            }
                        }
                    }
                    Ok(None) => add_corrupt!("record_disappeared"),
                    Err(KnowledgeError::Storage(message)) => return Err(KnowledgeError::Storage(message)),
                    Err(_) => add_corrupt!("malformed_record"),
                },
                _ => unreachable!("table validated above"),
            }
        }
        Ok(IntegrityAuditPage { issues, scanned, next_after, has_more })
    }

    fn ids_in_table_after(
        &mut self, table: &str, after_id: Option<&str>, limit: usize,
    ) -> Result<Vec<String>, KnowledgeError> {
        if limit == 0 || limit > 1_000 {
            return Err(KnowledgeError::Invalid("limit debe estar entre 1 y 1000"));
        }
        let range = match after_id {
            Some(id) => {
                validate_id(id, "after_id")?;
                self.store.scan_project_table_after_iter(&self.project_id, table, id)
            }
            None => self.store.scan_project_table_iter(&self.project_id, table),
        }.map_err(|error| KnowledgeError::Storage(error.to_string()))?;
        let mut ids = Vec::with_capacity(limit);
        for record in range.take(limit) {
            let (id, _) = record.map_err(|error| KnowledgeError::Storage(error.to_string()))?;
            ids.push(id);
        }
        Ok(ids)
    }

    fn ids_in_table(&mut self, table: &str) -> Result<Vec<String>, KnowledgeError> {
        let range = self.store.scan_project_table_iter(&self.project_id, table)
            .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
        let mut ids = Vec::new();
        for record in range {
            if ids.len() >= 50_000 {
                return Err(KnowledgeError::Invalid("más de 50.000 registros; paginación pendiente"));
            }
            let (id, _) = record
                .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
            ids.push(id);
        }
        Ok(ids)
    }

    fn put(&mut self, table: &str, id: &str, value: Vec<u8>) -> Result<(), KnowledgeError> {
        self.store.apply_batch(vec![ProjectOperation::Put {
            project_id: self.project_id.clone(),
            table: table.to_owned(),
            record_id: id.to_owned(),
            value,
        }]).map(|_| ()).map_err(|error| KnowledgeError::Storage(error.to_string()))
    }

    fn get(&mut self, table: &str, id: &str) -> Result<Option<Vec<u8>>, KnowledgeError> {
        validate_id(id, "record_id")?;
        let value = self.store.get_project(&self.project_id, table, id)
            .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
        if value.as_ref().is_some_and(|bytes| bytes.len() > MAX_RECORD_BYTES) {
            return Err(KnowledgeError::Corrupt("registro supera el límite de 8 MiB"));
        }
        Ok(value)
    }
}

fn read_evidence_record(
    store: &mut ProjectStore,
    project_id: &str,
    id: &str,
) -> Result<Option<EvidenceRecord>, KnowledgeError> {
    let bytes = store.get_project(project_id, EVIDENCE_TABLE, id)
        .map_err(|error| KnowledgeError::Storage(error.to_string()))?;
    let Some(bytes) = bytes else { return Ok(None); };
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(KnowledgeError::Corrupt("registro supera el límite de 8 MiB"));
    }
    decode_evidence_record(id, &bytes).map(Some)
}

fn decode_evidence_record(id: &str, bytes: &[u8]) -> Result<EvidenceRecord, KnowledgeError> {
    let mut reader = Reader::new(bytes);
    let version = reader.byte()?;
    if version != FORMAT_VERSION && version != EVIDENCE_FORMAT_VERSION {
        return Err(KnowledgeError::Corrupt("versión de evidencia desconocida"));
    }
    let target_kind = match reader.byte()? {
        1 => EvidenceTarget::Entity,
        2 => EvidenceTarget::Relation,
        3 => EvidenceTarget::Event,
        _ => return Err(KnowledgeError::Corrupt("tipo de evidencia desconocido")),
    };
    let target_id = reader.string()?;
    let document_id = reader.string()?;
    let revision = reader.u64()?;
    let start_byte = reader.u64()?;
    let end_byte = reader.u64()?;
    let excerpt = reader.string()?;
    let source_kind = reader.string()?;
    let stale = if version >= EVIDENCE_FORMAT_VERSION {
        match reader.byte()? {
            0 => false,
            1 => true,
            _ => return Err(KnowledgeError::Corrupt("marcador stale inválido")),
        }
    } else {
        false
    };
    reader.finish()?;
    if start_byte >= end_byte || excerpt.trim().is_empty() {
        return Err(KnowledgeError::Corrupt("rango o extracto de evidencia vacío/incoherente"));
    }
    Ok(EvidenceRecord {
        id: id.to_owned(), target_kind, target_id, document_id,
        revision, start_byte, end_byte, excerpt, source_kind, stale,
    })
}

fn encode_evidence(record: &EvidenceRecord) -> Result<Vec<u8>, KnowledgeError> {
    validate_id(&record.id, "evidence.id")?;
    validate_id(&record.target_id, "evidence.target_id")?;
    validate_id(&record.document_id, "evidence.document_id")?;
    validate_nonempty_text(&record.source_kind, "evidence.source_kind")?;
    validate_nonempty_text(&record.excerpt, "evidence.excerpt")?;
    if record.start_byte >= record.end_byte {
        return Err(KnowledgeError::Invalid("evidence requiere un rango no vacío"));
    }
    let mut bytes = vec![EVIDENCE_FORMAT_VERSION, record.target_kind as u8];
    put_string(&mut bytes, &record.target_id)?;
    put_string(&mut bytes, &record.document_id)?;
    bytes.extend_from_slice(&record.revision.to_le_bytes());
    bytes.extend_from_slice(&record.start_byte.to_le_bytes());
    bytes.extend_from_slice(&record.end_byte.to_le_bytes());
    put_string(&mut bytes, &record.excerpt)?;
    put_string(&mut bytes, &record.source_kind)?;
    bytes.push(u8::from(record.stale));
    Ok(bytes)
}

fn validate_id(value: &str, field: &'static str) -> Result<(), KnowledgeError> {
    if value.trim().is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        Err(KnowledgeError::Invalid(field))
    } else { Ok(()) }
}
fn validate_text(value: &str, field: &'static str) -> Result<(), KnowledgeError> {
    if value.len() > MAX_FIELD_BYTES { Err(KnowledgeError::Invalid(field)) } else { Ok(()) }
}
fn validate_nonempty_text(value: &str, field: &'static str) -> Result<(), KnowledgeError> {
    validate_text(value, field)?;
    if value.trim().is_empty() { Err(KnowledgeError::Invalid(field)) } else { Ok(()) }
}
fn put_count(out: &mut Vec<u8>, value: usize) -> Result<(), KnowledgeError> {
    if value > 100_000 { return Err(KnowledgeError::Invalid("demasiados atributos")); }
    let value = u32::try_from(value).map_err(|_| KnowledgeError::Invalid("demasiados elementos"))?;
    out.extend_from_slice(&value.to_le_bytes());
    Ok(())
}
fn put_string(out: &mut Vec<u8>, value: &str) -> Result<(), KnowledgeError> {
    validate_text(value, "string")?;
    let total = out.len().checked_add(4).and_then(|n| n.checked_add(value.len()))
        .ok_or(KnowledgeError::Invalid("registro demasiado grande"))?;
    if total > MAX_RECORD_BYTES { return Err(KnowledgeError::Invalid("registro supera 8 MiB")); }
    let len = u32::try_from(value.len()).map_err(|_| KnowledgeError::Invalid("string demasiado larga"))?;
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(value.as_bytes());
    Ok(())
}

struct Reader<'a> { bytes: &'a [u8], at: usize }
impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self { Self { bytes, at: 0 } }
    fn take(&mut self, n: usize) -> Result<&'a [u8], KnowledgeError> {
        let end = self.at.checked_add(n).ok_or(KnowledgeError::Corrupt("offset desbordado"))?;
        let part = self.bytes.get(self.at..end).ok_or(KnowledgeError::Corrupt("registro truncado"))?;
        self.at = end;
        Ok(part)
    }
    fn byte(&mut self) -> Result<u8, KnowledgeError> { Ok(self.take(1)?[0]) }
    fn u32(&mut self) -> Result<u32, KnowledgeError> { Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap())) }
    fn u64(&mut self) -> Result<u64, KnowledgeError> { Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap())) }
    fn string(&mut self) -> Result<String, KnowledgeError> {
        let len = self.u32()? as usize;
        if len > MAX_FIELD_BYTES { return Err(KnowledgeError::Corrupt("campo supera el límite")); }
        String::from_utf8(self.take(len)?.to_vec()).map_err(|_| KnowledgeError::Corrupt("UTF-8 inválido"))
    }
    fn count(&mut self) -> Result<usize, KnowledgeError> {
        let count = self.u32()? as usize;
        if count > 100_000 { return Err(KnowledgeError::Corrupt("cantidad de atributos excesiva")); }
        Ok(count)
    }
    fn status(&mut self) -> Result<RecordStatus, KnowledgeError> {
        self.header()?;
        match self.byte()? {
            1 => Ok(RecordStatus::Proposed), 2 => Ok(RecordStatus::Confirmed),
            3 => Ok(RecordStatus::Rejected), 4 => Ok(RecordStatus::Superseded),
            _ => Err(KnowledgeError::Corrupt("estado desconocido")),
        }
    }
    fn header(&mut self) -> Result<(), KnowledgeError> {
        if self.byte()? != FORMAT_VERSION { return Err(KnowledgeError::Corrupt("versión desconocida")); }
        Ok(())
    }
    fn finish(&self) -> Result<(), KnowledgeError> {
        if self.at == self.bytes.len() { Ok(()) } else { Err(KnowledgeError::Corrupt("bytes sobrantes")) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    fn paths() -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("ml-knowledge-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&root).unwrap();
        (root.clone(), root.join("knowledge.pages"), root.join("knowledge.wal"))
    }

    #[test]
    fn narrative_id_pages_are_ordered_bounded_and_cover_all_record_tables() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book-pages", &pages, &wal).unwrap();
        for id in ["ana", "luis", "marta"] {
            store.put_entity(&EntityRecord {
                id: id.into(), canonical_name: id.into(),
                entity_type: "character".into(), attributes: vec![],
                status: RecordStatus::Confirmed,
            }).unwrap();
        }
        for (id, order) in [("event-a", 1), ("event-b", 2)] {
            store.put_event(&EventRecord {
                id: id.into(), label: id.into(), chronology_order: Some(order),
                status: RecordStatus::Proposed,
            }).unwrap();
        }
        store.put_relation(&RelationRecord {
            id: "relation-a".into(), subject_id: "ana".into(),
            predicate: "conoce".into(), object_id: "luis".into(),
            status: RecordStatus::Confirmed,
        }).unwrap();
        store.put_evidence(&EvidenceRecord {
            id: "evidence-a".into(), target_kind: EvidenceTarget::Entity,
            target_id: "ana".into(), document_id: "chapter".into(),
            revision: 1, start_byte: 0, end_byte: 3, excerpt: "Ana".into(),
            source_kind: "explicit_text".into(), stale: false,
        }).unwrap();
        let analysis = |id: &str| FragmentAnalysisRecord {
            id: id.into(), document_id: "chapter".into(), revision: 1,
            start_byte: 0, end_byte: 4, character_count: 4, word_count: 1,
            unique_word_count: 1, sentence_count: 1, paragraph_count: 1,
            long_word_count: 0, average_word_length_milli: 4_000,
            source_text: None,
            repeated_words: vec![],
        };
        store.put_fragment_analysis(&analysis("paragraph-a")).unwrap();
        store.put_fragment_analysis(&analysis("paragraph-b")).unwrap();

        assert_eq!(store.entity_ids_page(0, 2).unwrap(), vec!["ana", "luis"]);
        assert_eq!(store.entity_ids_page(2, 2).unwrap(), vec!["marta"]);
        assert_eq!(store.entity_ids_after(None, 2).unwrap(), vec!["ana", "luis"]);
        assert_eq!(store.entity_ids_after(Some("luis"), 2).unwrap(), vec!["marta"]);
        assert!(store.entity_ids_after(Some("marta"), 2).unwrap().is_empty());
        assert_eq!(store.entity_ids_after(Some("lui"), 2).unwrap(), vec!["luis", "marta"]);
        assert!(matches!(store.entity_ids_after(Some(" "), 2), Err(KnowledgeError::Invalid(_))));
        assert!(store.entity_ids_page(3, 1).unwrap().is_empty());
        assert_eq!(store.event_ids_page(0, 1).unwrap(), vec!["event-a"]);
        assert_eq!(store.event_ids_page(1, 1).unwrap(), vec!["event-b"]);
        assert_eq!(store.relation_ids_page(0, 1).unwrap(), vec!["relation-a"]);
        assert_eq!(store.evidence_ids_page(0, 1).unwrap(), vec!["evidence-a"]);
        assert_eq!(store.evidence_ids_after(None, 1).unwrap(), vec!["evidence-a"]);
        assert_eq!(store.evidence_ids_for_document_after("chapter", None, 1).unwrap(), vec!["evidence-a"]);
        assert!(store.evidence_ids_for_document_after("chapter", Some("evidence-a"), 1).unwrap().is_empty());
        assert_eq!(store.fragment_analysis_ids_page(1, 1).unwrap(), vec!["paragraph-b"]);
        assert!(matches!(store.entity_ids_page(0, 0), Err(KnowledgeError::Invalid(_))));
        assert!(matches!(store.entity_ids_page(0, 1_001), Err(KnowledgeError::Invalid(_))));
        drop(store);

        let mut reopened = NarrativeKnowledgeStore::open("book-pages", &pages, &wal).unwrap();
        assert_eq!(reopened.entity_ids_page(1, 2).unwrap(), vec!["luis", "marta"]);
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn large_document_evidence_rebases_and_invalidations_use_small_durable_batches() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book-batched", &pages, &wal).unwrap();
        store.put_entity(&EntityRecord {
            id: "ana".into(), canonical_name: "Ana".into(),
            entity_type: "character".into(), attributes: vec![],
            status: RecordStatus::Confirmed,
        }).unwrap();
        for index in 0..25 {
            let id = format!("quote-{index:02}");
            store.put_evidence(&EvidenceRecord {
                id, target_kind: EvidenceTarget::Entity, target_id: "ana".into(),
                document_id: "chapter".into(), revision: 1,
                start_byte: 10, end_byte: 13, excerpt: "Ana".into(),
                source_kind: "explicit_text".into(), stale: false,
            }).unwrap();
        }
        let change = crate::persistent::DurableDocumentChange {
            sequence: 1, base_revision: 1, revision: 2,
            start_byte: 0, end_byte: 0, replacement_bytes: 2,
        };
        let rebased = store.rebase_document_evidence_history("chapter", 2, &[change]).unwrap();
        assert_eq!(rebased.updated, 25);
        assert_eq!(rebased.shifted, 25);
        for index in 0..25 {
            let record = store.get_evidence(&format!("quote-{index:02}")).unwrap().unwrap();
            assert_eq!((record.revision, record.start_byte, record.end_byte), (2, 12, 15));
            assert!(!record.stale);
        }
        assert_eq!(store.invalidate_document_evidence("chapter").unwrap(), 25);
        assert_eq!(store.invalidate_document_evidence("chapter").unwrap(), 0);
        drop(store);

        let mut reopened = NarrativeKnowledgeStore::open("book-batched", &pages, &wal).unwrap();
        for index in 0..25 {
            assert!(reopened.get_evidence(&format!("quote-{index:02}")).unwrap().unwrap().stale);
        }
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn evidence_history_rejects_gaps_and_wrong_target_before_mutating_records() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book", &pages, &wal).unwrap();
        let gap = vec![
            crate::persistent::DurableDocumentChange {
                sequence: 4, base_revision: 10, revision: 11,
                start_byte: 0, end_byte: 0, replacement_bytes: 1,
            },
            crate::persistent::DurableDocumentChange {
                sequence: 6, base_revision: 11, revision: 12,
                start_byte: 0, end_byte: 0, replacement_bytes: 1,
            },
        ];
        assert!(matches!(
            store.rebase_document_evidence_history("chapter", 12, &gap),
            Err(KnowledgeError::Invalid(_))
        ));
        let wrong_target = vec![
            crate::persistent::DurableDocumentChange {
                sequence: 4, base_revision: 10, revision: 11,
                start_byte: 0, end_byte: 0, replacement_bytes: 1,
            },
        ];
        assert!(matches!(
            store.rebase_document_evidence_history("chapter", 12, &wrong_target),
            Err(KnowledgeError::Invalid(_))
        ));
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_evidence_can_be_replaced_or_deleted_without_trusting_stale_indexes() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book", &pages, &wal).unwrap();
        store.put_entity(&EntityRecord {
            id: "ana".into(), canonical_name: "Ana".into(), entity_type: "character".into(),
            attributes: vec![], status: RecordStatus::Confirmed,
        }).unwrap();
        let evidence = EvidenceRecord {
            id: "ev".into(), target_kind: EvidenceTarget::Entity, target_id: "ana".into(),
            document_id: "chapter".into(), revision: 1, start_byte: 0, end_byte: 3,
            excerpt: "Ana".into(), source_kind: "explicit_text".into(), stale: false,
        };
        store.put_evidence(&evidence).unwrap();
        assert_eq!(store.evidence_ids_for_document("chapter").unwrap(), vec!["ev"]);

        // Simula corrupción externa del valor durable tras materializar índices.
        store.put(EVIDENCE_TABLE, "ev", vec![0xff]).unwrap();
        assert!(store.delete_evidence("ev").unwrap());
        assert!(store.evidence_ids_by_document.is_none());
        assert!(store.evidence_targets_by_document.is_none());
        assert!(store.evidence_ids_for_document("chapter").unwrap().is_empty());

        // El reemplazo de otro registro corrupto también invalida los índices
        // y permite reconstruirlos desde el conjunto durable ya reparado.
        store.put_evidence(&evidence).unwrap();
        assert_eq!(store.evidence_ids_for_document("chapter").unwrap(), vec!["ev"]);
        store.put(EVIDENCE_TABLE, "ev", vec![0xff]).unwrap();
        store.put_evidence(&evidence).unwrap();
        assert!(store.evidence_ids_by_document.is_none());
        assert!(store.evidence_targets_by_document.is_none());
        assert_eq!(store.evidence_ids_for_document("chapter").unwrap(), vec!["ev"]);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn document_evidence_index_isolated_and_tracks_new_records_after_first_lookup() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book", &pages, &wal).unwrap();
        for id in ["ana", "luis"] {
            store.put_entity(&EntityRecord {
                id: id.into(), canonical_name: id.into(), entity_type: "character".into(),
                attributes: vec![], status: RecordStatus::Confirmed,
            }).unwrap();
        }
        let evidence = |id: &str, target: &str, document: &str| EvidenceRecord {
            id: id.into(), target_kind: EvidenceTarget::Entity, target_id: target.into(),
            document_id: document.into(), revision: 1, start_byte: 0, end_byte: 3,
            excerpt: target.into(), source_kind: "explicit_text".into(), stale: false,
        };
        store.put_evidence(&evidence("a1", "ana", "chapter-a")).unwrap();
        store.put_evidence(&evidence("b1", "luis", "chapter-b")).unwrap();

        assert_eq!(store.evidence_ids_for_document("chapter-a").unwrap(), vec!["a1"]);
        // El índice ya está materializado: las inserciones posteriores deben
        // actualizarlo sin requerir una reconstrucción ni perder aislamiento.
        store.put_evidence(&evidence("a2", "ana", "chapter-a")).unwrap();
        assert_eq!(store.evidence_ids_for_document("chapter-a").unwrap(), vec!["a1", "a2"]);
        assert_eq!(store.evidence_ids_for_document("chapter-b").unwrap(), vec!["b1"]);
        // Cambiar el destino dentro del mismo documento decrementa el
        // contador anterior sin borrar una entidad que otra cita aún utiliza.
        store.put_evidence(&evidence("a2", "luis", "chapter-a")).unwrap();
        assert_eq!(store.entity_ids_for_document_page("chapter-a", 0, 10).unwrap(), vec!["ana", "luis"]);
        // Reemplazar un ID y asociarlo a otro documento debe retirarlo del
        // conjunto anterior y añadirlo al nuevo sin duplicar resultados.
        store.put_evidence(&evidence("a2", "ana", "chapter-b")).unwrap();
        store.put_evidence(&evidence("a3", "ana", "chapter-b")).unwrap();
        assert_eq!(store.evidence_ids_for_document("chapter-a").unwrap(), vec!["a1"]);
        assert_eq!(store.evidence_ids_for_document("chapter-b").unwrap(), vec!["a2", "a3", "b1"]);
        assert_eq!(store.entity_ids_for_document_page("chapter-a", 0, 10).unwrap(), vec!["ana"]);
        assert_eq!(store.entity_ids_for_document_page("chapter-b", 0, 10).unwrap(), vec!["ana", "luis"]);
        assert_eq!(store.entity_ids_for_document_page("chapter-b", 1, 1).unwrap(), vec!["luis"]);
        assert_eq!(store.entity_ids_for_document_after("chapter-b", None, 1).unwrap(), vec!["ana"]);
        assert_eq!(store.entity_ids_for_document_after("chapter-b", Some("ana"), 1).unwrap(), vec!["luis"]);
        assert!(store.entity_ids_for_document_after("chapter-b", Some("luis"), 1).unwrap().is_empty());
        assert!(store.entity_ids_for_document_page("chapter-b", 2, 10).unwrap().is_empty());
        assert!(matches!(
            store.entity_ids_for_document_page("chapter-b", 0, 0),
            Err(KnowledgeError::Invalid(_))
        ));
        assert!(store.evidence_ids_for_document("chapter-c").unwrap().is_empty());

        let summary = store.rebase_document_evidence("chapter-a", 1, 2, 0, 0, 1).unwrap();
        assert_eq!(summary.shifted, 1);
        let shifted = store.get_evidence("a1").unwrap().unwrap();
        assert_eq!((shifted.revision, shifted.start_byte, shifted.end_byte), (2, 1, 4));
        // El rebase del capítulo A no toca citas que pertenecen al capítulo B.
        assert_eq!(store.get_evidence("a2").unwrap().unwrap().revision, 1);
        assert_eq!(store.get_evidence("b1").unwrap().unwrap().revision, 1);
        drop(store);

        let mut reopened = NarrativeKnowledgeStore::open("book", &pages, &wal).unwrap();
        assert_eq!(reopened.evidence_ids_for_document("chapter-a").unwrap(), vec!["a1"]);
        assert_eq!(reopened.evidence_ids_for_document("chapter-b").unwrap(), vec!["a2", "a3", "b1"]);
        assert_eq!(reopened.entity_ids_for_document_after("chapter-b", None, 10).unwrap(), vec!["ana", "luis"]);
        assert_eq!(reopened.get_evidence("a1").unwrap().unwrap().revision, 2);
        assert!(reopened.delete_evidence("a2").unwrap());
        assert!(!reopened.delete_evidence("a2").unwrap());
        // La segunda cita de Ana mantiene el destino hasta que se elimina también.
        assert_eq!(reopened.entity_ids_for_document_after("chapter-b", None, 10).unwrap(), vec!["ana", "luis"]);
        assert!(reopened.delete_evidence("a3").unwrap());
        assert_eq!(reopened.evidence_ids_for_document("chapter-b").unwrap(), vec!["b1"]);
        assert_eq!(reopened.entity_ids_for_document_after("chapter-b", None, 10).unwrap(), vec!["luis"]);
        drop(reopened);
        let mut after_delete = NarrativeKnowledgeStore::open("book", &pages, &wal).unwrap();
        assert_eq!(after_delete.evidence_ids_for_document("chapter-b").unwrap(), vec!["b1"]);
        assert_eq!(after_delete.entity_ids_for_document_after("chapter-b", None, 10).unwrap(), vec!["luis"]);
        drop(after_delete);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn evidence_anchor_tracks_edits_before_and_after_without_guessing_overlaps() {
        use EvidenceAnchorTransform::{Invalidated, Shifted, Unchanged};

        // El texto insertado antes de la cita desplaza el rango por bytes UTF-8.
        assert_eq!(
            transform_evidence_anchor(10, 16, 0, 0, "ñ".len()),
            Some(Shifted { start_byte: 12, end_byte: 18 }),
        );
        // Una sustitución anterior aplica la diferencia entre bytes retirados
        // y añadidos, no el número de caracteres Unicode.
        assert_eq!(
            transform_evidence_anchor(10, 16, 2, 5, "🙂".len()),
            Some(Shifted { start_byte: 11, end_byte: 17 }),
        );
        // Inserción exactamente al inicio desplaza la cita; al final no la toca.
        assert_eq!(
            transform_evidence_anchor(10, 16, 10, 10, 3),
            Some(Shifted { start_byte: 13, end_byte: 19 }),
        );
        assert_eq!(
            transform_evidence_anchor(10, 16, 16, 16, 3),
            Some(Unchanged),
        );
        assert_eq!(
            transform_evidence_anchor(10, 16, 12, 12, 1),
            Some(Invalidated),
        );
        assert_eq!(
            transform_evidence_anchor(10, 16, 8, 12, 0),
            Some(Invalidated),
        );
        assert_eq!(
            transform_evidence_anchor(10, 16, 16, 18, 4),
            Some(Unchanged),
        );
        assert_eq!(transform_evidence_anchor(16, 16, 0, 0, 1), None);
        assert_eq!(transform_evidence_anchor(10, 16, 8, 7, 1), None);
    }

    #[test]
    fn evidence_rebase_updates_valid_anchors_in_batches_and_leaves_touched_quotes_stale() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book", &pages, &wal).unwrap();
        store.put_entity(&EntityRecord {
            id: "ana".into(), canonical_name: "Ana".into(),
            entity_type: "character".into(), attributes: vec![], status: RecordStatus::Confirmed,
        }).unwrap();
        let make = |id: &str, document: &str, revision: u64, start: u64, end: u64, excerpt: &str| EvidenceRecord {
            id: id.into(), target_kind: EvidenceTarget::Entity, target_id: "ana".into(),
            document_id: document.into(), revision, start_byte: start, end_byte: end,
            excerpt: excerpt.into(), source_kind: "explicit_text".into(), stale: false,
        };
        store.put_evidence(&make("before", "chapter", 4, 2, 4, "Ana")).unwrap();
        store.put_evidence(&make("after", "chapter", 4, 10, 13, "Ana")).unwrap();
        store.put_evidence(&make("overlap", "chapter", 4, 4, 8, "Ana ")).unwrap();
        store.put_evidence(&make("other-document", "appendix", 4, 10, 13, "Ana")).unwrap();
        store.put_evidence(&make("older", "chapter", 3, 30, 33, "Ana")).unwrap();

        // Sustituye un byte anterior a una cita, aumentando dos bytes.
        // Una cita anterior queda intacta, otra se desplaza y la intersectada caduca.
        let summary = store.rebase_document_evidence("chapter", 4, 5, 5, 6, 3).unwrap();
        assert_eq!(summary, EvidenceRebaseSummary {
            updated: 3, shifted: 1, unchanged: 1, invalidated: 1,
        });
        let before = store.get_evidence("before").unwrap().unwrap();
        assert_eq!((before.revision, before.start_byte, before.end_byte), (5, 2, 4));
        let after = store.get_evidence("after").unwrap().unwrap();
        assert_eq!((after.revision, after.start_byte, after.end_byte), (5, 12, 15));
        let overlap = store.get_evidence("overlap").unwrap().unwrap();
        assert_eq!((overlap.revision, overlap.start_byte, overlap.end_byte, overlap.stale), (4, 4, 8, true));
        assert_eq!(store.get_evidence("other-document").unwrap().unwrap().revision, 4);
        assert_eq!(store.get_evidence("older").unwrap().unwrap().revision, 3);

        // La misma revisión no se vuelve a contar ni desplaza dos veces.
        let repeated = store.rebase_document_evidence("chapter", 4, 5, 5, 6, 3).unwrap();
        assert_eq!(repeated, EvidenceRebaseSummary::default());
        drop(store);
        let mut reopened = NarrativeKnowledgeStore::open("book", &pages, &wal).unwrap();
        assert_eq!(reopened.get_evidence("after").unwrap().unwrap().start_byte, 12);
        assert_eq!(reopened.get_evidence("overlap").unwrap().unwrap().revision, 4);
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn durable_history_rebase_updates_survivors_and_invalidates_only_touched_quotes() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book", &pages, &wal).unwrap();
        store.put_entity(&EntityRecord {
            id: "ana".into(), canonical_name: "Ana".into(),
            entity_type: "character".into(), attributes: vec![], status: RecordStatus::Confirmed,
        }).unwrap();
        let make = |id: &str, start: u64, end: u64, excerpt: &str| EvidenceRecord {
            id: id.into(), target_kind: EvidenceTarget::Entity, target_id: "ana".into(),
            document_id: "chapter".into(), revision: 0, start_byte: start, end_byte: end,
            excerpt: excerpt.into(), source_kind: "explicit_text".into(), stale: false,
        };
        store.put_evidence(&make("ana-quote", 0, 3, "Ana")).unwrap();
        store.put_evidence(&make("xyz-quote", 3, 6, "XYZ")).unwrap();
        let changes = vec![
            crate::persistent::DurableDocumentChange {
                sequence: 1, base_revision: 0, revision: 1,
                start_byte: 0, end_byte: 0, replacement_bytes: 1,
            },
            crate::persistent::DurableDocumentChange {
                sequence: 2, base_revision: 1, revision: 2,
                start_byte: 4, end_byte: 4, replacement_bytes: 1,
            },
            crate::persistent::DurableDocumentChange {
                sequence: 3, base_revision: 2, revision: 3,
                start_byte: 2, end_byte: 3, replacement_bytes: 1,
            },
        ];
        let summary = store.rebase_document_evidence_history("chapter", 3, &changes).unwrap();
        assert_eq!(summary.updated, 2);
        assert_eq!(summary.invalidated, 1);
        let ana = store.get_evidence("ana-quote").unwrap().unwrap();
        assert!(ana.stale);
        assert_eq!((ana.revision, ana.start_byte, ana.end_byte), (2, 1, 4));
        let xyz = store.get_evidence("xyz-quote").unwrap().unwrap();
        assert!(!xyz.stale);
        assert_eq!((xyz.revision, xyz.start_byte, xyz.end_byte), (3, 5, 8));
        assert_eq!(
            store.rebase_document_evidence_history("chapter", 3, &changes).unwrap(),
            EvidenceRebaseSummary::default(),
        );
        drop(store);
        let mut reopened = NarrativeKnowledgeStore::open("book", &pages, &wal).unwrap();
        assert!(reopened.get_evidence("ana-quote").unwrap().unwrap().stale);
        assert_eq!(reopened.get_evidence("xyz-quote").unwrap().unwrap().start_byte, 5);
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalidating_document_evidence_is_batched_persistent_and_idempotent() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book", &pages, &wal).unwrap();
        store.put_entity(&EntityRecord {
            id: "ana".into(), canonical_name: "Ana".into(),
            entity_type: "character".into(), attributes: vec![], status: RecordStatus::Confirmed,
        }).unwrap();
        let evidence = EvidenceRecord {
            id: "ev".into(), target_kind: EvidenceTarget::Entity, target_id: "ana".into(),
            document_id: "chapter".into(), revision: 4, start_byte: 0, end_byte: 3,
            excerpt: "Ana".into(), source_kind: "explicit_text".into(), stale: false,
        };
        store.put_evidence(&evidence).unwrap();
        assert_eq!(store.invalidate_document_evidence("chapter").unwrap(), 1);
        assert_eq!(store.invalidate_document_evidence("chapter").unwrap(), 0);
        assert!(store.get_evidence("ev").unwrap().unwrap().stale);
        drop(store);
        let mut reopened = NarrativeKnowledgeStore::open("book", &pages, &wal).unwrap();
        assert!(reopened.get_evidence("ev").unwrap().unwrap().stale);
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn entity_and_evidence_round_trip_with_provenance() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("host-book-1", &pages, &wal).unwrap();
        let entity = EntityRecord {
            id: "character-ana".into(), canonical_name: "Ana".into(),
            entity_type: "character".into(),
            attributes: vec![("eye_color".into(), "verde".into())],
            status: RecordStatus::Confirmed,
        };
        store.put_entity(&entity).unwrap();
        assert_eq!(store.get_entity(&entity.id).unwrap(), Some(entity.clone()));
        let evidence = EvidenceRecord {
            id: "evidence-1".into(), target_kind: EvidenceTarget::Entity,
            target_id: "character-ana".into(), document_id: "chapter-1".into(),
            revision: 7, start_byte: 10, end_byte: 20,
            excerpt: "Ana entró".into(), source_kind: "explicit_text".into(), stale: false,
        };
        store.put_evidence(&evidence).unwrap();
        assert_eq!(store.get_evidence(&evidence.id).unwrap(), Some(evidence.clone()));
        drop(store);
        let mut reopened = NarrativeKnowledgeStore::open("host-book-1", &pages, &wal).unwrap();
        assert_eq!(reopened.get_entity(&entity.id).unwrap(), Some(entity));
        assert_eq!(reopened.get_evidence(&evidence.id).unwrap(), Some(evidence));
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn evidence_reader_remains_compatible_with_legacy_v1_records() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book", &pages, &wal).unwrap();
        store.put_entity(&EntityRecord {
            id: "ana".into(), canonical_name: "Ana".into(),
            entity_type: "character".into(), attributes: vec![], status: RecordStatus::Confirmed,
        }).unwrap();
        // Codifica el formato histórico v1, anterior al indicador stale.
        let mut legacy = vec![FORMAT_VERSION, EvidenceTarget::Entity as u8];
        put_string(&mut legacy, "ana").unwrap();
        put_string(&mut legacy, "chapter").unwrap();
        legacy.extend_from_slice(&4u64.to_le_bytes());
        legacy.extend_from_slice(&0u64.to_le_bytes());
        legacy.extend_from_slice(&3u64.to_le_bytes());
        put_string(&mut legacy, "Ana").unwrap();
        put_string(&mut legacy, "explicit_text").unwrap();
        store.put(EVIDENCE_TABLE, "legacy", legacy).unwrap();
        let loaded = store.get_evidence("legacy").unwrap().unwrap();
        assert_eq!(loaded.revision, 4);
        assert!(!loaded.stale);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn relation_and_event_round_trip_preserves_status_and_chronology() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book", &pages, &wal).unwrap();
        for id in ["ana", "luis"] {
            store.put_entity(&EntityRecord {
                id: id.into(), canonical_name: id.to_uppercase(),
                entity_type: "character".into(), attributes: vec![],
                status: RecordStatus::Confirmed,
            }).unwrap();
        }
        let relation = RelationRecord {
            id: "rel-1".into(), subject_id: "ana".into(),
            predicate: "conoce".into(), object_id: "luis".into(),
            status: RecordStatus::Proposed,
        };
        store.put_relation(&relation).unwrap();
        assert_eq!(store.get_relation(&relation.id).unwrap(), Some(relation));
        let event = EventRecord {
            id: "event-1".into(), label: "La llegada".into(),
            chronology_order: Some(-42), status: RecordStatus::Confirmed,
        };
        store.put_event(&event).unwrap();
        assert_eq!(store.get_event(&event.id).unwrap(), Some(event));
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_scope_prevents_cross_book_record_reads() {
        let (root, pages, wal) = paths();
        let entity = |id: &str, name: &str| EntityRecord {
            id: id.into(), canonical_name: name.into(),
            entity_type: "character".into(), attributes: vec![],
            status: RecordStatus::Confirmed,
        };
        let relation = |id: &str, subject: &str, object: &str| RelationRecord {
            id: id.into(), subject_id: subject.into(), predicate: "conoce".into(),
            object_id: object.into(), status: RecordStatus::Confirmed,
        };
        let event = |id: &str, label: &str| EventRecord {
            id: id.into(), label: label.into(), chronology_order: Some(7),
            status: RecordStatus::Confirmed,
        };
        let evidence = |id: &str, target: &str, excerpt: &str| EvidenceRecord {
            id: id.into(), target_kind: EvidenceTarget::Entity, target_id: target.into(),
            document_id: "chapter-shared-id".into(), revision: 1,
            start_byte: 0, end_byte: excerpt.len() as u64, excerpt: excerpt.into(),
            source_kind: "manual".into(), stale: false,
        };
        let analysis = |id: &str, source: &str| FragmentAnalysisRecord {
            id: id.into(), document_id: "chapter-shared-id".into(), revision: 1,
            start_byte: 0, end_byte: source.len() as u64,
            character_count: source.chars().count() as u64, word_count: 1,
            unique_word_count: 1, sentence_count: 1, paragraph_count: 1,
            long_word_count: 0, average_word_length_milli: source.len() as u64 * 1_000,
            source_text: Some(source.into()), repeated_words: vec![],
        };

        // El libro A crea IDs deliberadamente idénticos a los que usará B.
        {
            let mut a = NarrativeKnowledgeStore::open("book-A", &pages, &wal).unwrap();
            a.put_entity(&entity("same-entity", "Privado A")).unwrap();
            a.put_entity(&entity("subject", "Sujeto A")).unwrap();
            a.put_entity(&entity("object", "Objeto A")).unwrap();
            a.put_relation(&relation("same-relation", "subject", "object")).unwrap();
            a.put_event(&event("same-event", "Acontecimiento A")).unwrap();
            a.put_evidence(&evidence("same-evidence", "same-entity", "cita A")).unwrap();
            a.put_fragment_analysis(&analysis("same-analysis", "texto A")).unwrap();
        }

        // B no puede leer datos de A ni descubrir sus IDs mediante índices o auditoría.
        {
            let mut b = NarrativeKnowledgeStore::open("book-B", &pages, &wal).unwrap();
            assert_eq!(b.get_entity("same-entity").unwrap(), None);
            assert_eq!(b.get_relation("same-relation").unwrap(), None);
            assert_eq!(b.get_event("same-event").unwrap(), None);
            assert_eq!(b.get_evidence("same-evidence").unwrap(), None);
            assert_eq!(b.get_fragment_analysis("same-analysis").unwrap(), None);
            assert!(b.entity_ids().unwrap().is_empty());
            assert!(b.relation_ids().unwrap().is_empty());
            assert!(b.event_ids().unwrap().is_empty());
            assert!(b.evidence_ids().unwrap().is_empty());
            assert!(b.fragment_analysis_ids().unwrap().is_empty());
            assert!(b.evidence_ids_for_document("chapter-shared-id").unwrap().is_empty());
            assert!(b.fragment_analysis_ids_for_document_after("chapter-shared-id", None, 10).unwrap().is_empty());
            for table in ["entity", "relation", "event", "evidence", "fragment_analysis"] {
                assert_eq!(b.audit_integrity_page(table, None, 10).unwrap().scanned, 0);
            }

            // B puede reutilizar los mismos IDs sin sobrescribir el contenido de A.
            b.put_entity(&entity("same-entity", "Privado B")).unwrap();
            b.put_entity(&entity("subject", "Sujeto B")).unwrap();
            b.put_entity(&entity("object", "Objeto B")).unwrap();
            b.put_relation(&relation("same-relation", "subject", "object")).unwrap();
            b.put_event(&event("same-event", "Acontecimiento B")).unwrap();
            b.put_evidence(&evidence("same-evidence", "same-entity", "cita B")).unwrap();
            b.put_fragment_analysis(&analysis("same-analysis", "texto B")).unwrap();
        }

        // La separación se conserva al cerrar y reabrir ambos ámbitos.
        {
            let mut a = NarrativeKnowledgeStore::open("book-A", &pages, &wal).unwrap();
            assert_eq!(a.get_entity("same-entity").unwrap().unwrap().canonical_name, "Privado A");
            assert_eq!(a.get_relation("same-relation").unwrap().unwrap().subject_id, "subject");
            assert_eq!(a.get_event("same-event").unwrap().unwrap().label, "Acontecimiento A");
            assert_eq!(a.get_evidence("same-evidence").unwrap().unwrap().excerpt, "cita A");
            assert_eq!(a.get_fragment_analysis("same-analysis").unwrap().unwrap().source_text.as_deref(), Some("texto A"));
        }
        {
            let mut b = NarrativeKnowledgeStore::open("book-B", &pages, &wal).unwrap();
            assert_eq!(b.get_entity("same-entity").unwrap().unwrap().canonical_name, "Privado B");
            assert_eq!(b.get_relation("same-relation").unwrap().unwrap().subject_id, "subject");
            assert_eq!(b.get_event("same-event").unwrap().unwrap().label, "Acontecimiento B");
            assert_eq!(b.get_evidence("same-evidence").unwrap().unwrap().excerpt, "cita B");
            assert_eq!(b.get_fragment_analysis("same-analysis").unwrap().unwrap().source_text.as_deref(), Some("texto B"));
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn legacy_fragment_analysis_v1_remains_readable_without_source_provenance() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book-analysis-legacy", &pages, &wal).unwrap();
        let mut legacy = vec![FORMAT_VERSION];
        put_string(&mut legacy, "chapter").unwrap();
        for value in [7u64, 10, 14, 4, 1, 1, 1, 1, 0, 4_000] {
            legacy.extend_from_slice(&value.to_le_bytes());
        }
        put_count(&mut legacy, 0).unwrap();
        store.put(FRAGMENT_ANALYSIS_TABLE, "legacy-analysis", legacy).unwrap();
        let loaded = store.get_fragment_analysis("legacy-analysis").unwrap().unwrap();
        assert_eq!(loaded.revision, 7);
        assert_eq!(loaded.source_text, None);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fragment_analysis_rejects_source_text_that_does_not_match_its_byte_range() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book-analysis-source", &pages, &wal).unwrap();
        let record = FragmentAnalysisRecord {
            id: "bad-source".into(), document_id: "chapter".into(),
            revision: 1, start_byte: 4, end_byte: 9,
            character_count: 4, word_count: 1, unique_word_count: 1,
            sentence_count: 1, paragraph_count: 1, long_word_count: 0,
            average_word_length_milli: 4_000,
            source_text: Some("four".into()),
            repeated_words: vec![],
        };
        assert!(matches!(store.put_fragment_analysis(&record), Err(KnowledgeError::Invalid(_))));
        assert_eq!(store.get_fragment_analysis("bad-source").unwrap(), None);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fragment_analysis_round_trips_metrics_and_repeated_word_offsets() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book-analysis", &pages, &wal).unwrap();
        let record = FragmentAnalysisRecord {
            id: "chapter-1-r8-p0".into(),
            document_id: "chapter-1".into(),
            revision: 8,
            start_byte: 100,
            end_byte: 111,
            character_count: 9,
            word_count: 2,
            unique_word_count: 1,
            sentence_count: 1,
            paragraph_count: 1,
            long_word_count: 0,
            average_word_length_milli: 4_000,
            source_text: Some("Niño Niño".into()),
            repeated_words: vec![RepeatedWordRecord {
                normalized: "ana".into(), count: 2, first_start_byte: 100,
            }],
        };
        store.put_fragment_analysis(&record).unwrap();
        assert_eq!(store.get_fragment_analysis(&record.id).unwrap(), Some(record.clone()));
        assert_eq!(store.fragment_analysis_ids().unwrap(), vec!["chapter-1-r8-p0".to_owned()]);
        drop(store);
        let mut reopened = NarrativeKnowledgeStore::open("book-analysis", &pages, &wal).unwrap();
        assert_eq!(reopened.get_fragment_analysis(&record.id).unwrap(), Some(record));
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fragment_analysis_query_is_scoped_by_document_and_revision() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book-query", &pages, &wal).unwrap();
        for (id, document_id, revision, start_byte) in [
            ("a-old", "chapter-a", 1, 0),
            ("a-new", "chapter-a", 2, 10),
            ("b-new", "chapter-b", 2, 0),
        ] {
            store.put_fragment_analysis(&FragmentAnalysisRecord {
                id: id.into(), document_id: document_id.into(), revision,
                start_byte, end_byte: start_byte + 4, character_count: 4,
                word_count: 1, unique_word_count: 1, sentence_count: 1,
                paragraph_count: 1, long_word_count: 0,
                source_text: None,
                average_word_length_milli: 4_000, repeated_words: vec![],
            }).unwrap();
        }
        let all = store.fragment_analyses_for_document("chapter-a", None, 10).unwrap();
        assert_eq!(all.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["a-old", "a-new"]);
        let exact = store.fragment_analyses_for_document("chapter-a", Some(2), 10).unwrap();
        assert_eq!(exact.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["a-new"]);
        assert!(matches!(
            store.fragment_analyses_for_document("chapter-a", None, 1),
            Err(KnowledgeError::Invalid(_))
        ));
        assert!(matches!(
            store.fragment_analyses_for_document("chapter-a", None, 0),
            Err(KnowledgeError::Invalid(_))
        ));
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fragment_analysis_document_cursor_index_tracks_moves_deletes_and_reopen() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book-analysis-index", &pages, &wal).unwrap();
        let record = |id: &str, document_id: &str| FragmentAnalysisRecord {
            id: id.into(), document_id: document_id.into(),
            revision: 1, start_byte: 0, end_byte: 4,
            character_count: 4, word_count: 1, unique_word_count: 1,
            sentence_count: 1, paragraph_count: 1, long_word_count: 0,
            source_text: None,
            average_word_length_milli: 4_000, repeated_words: vec![],
        };
        store.put_fragment_analysis(&record("analysis-a", "chapter-a")).unwrap();
        store.put_fragment_analysis(&record("analysis-b", "chapter-a")).unwrap();
        assert_eq!(
            store.fragment_analysis_ids_for_document_after("chapter-a", None, 1).unwrap(),
            vec!["analysis-a"],
        );
        store.put_fragment_analysis(&record("analysis-a", "chapter-b")).unwrap();
        assert_eq!(
            store.fragment_analysis_ids_for_document_after("chapter-a", None, 10).unwrap(),
            vec!["analysis-b"],
        );
        assert_eq!(
            store.fragment_analysis_ids_for_document_after("chapter-b", None, 10).unwrap(),
            vec!["analysis-a"],
        );
        assert!(store.delete_fragment_analysis("analysis-b").unwrap());
        assert!(store.fragment_analysis_ids_for_document_after("chapter-a", None, 10).unwrap().is_empty());
        drop(store);

        let mut reopened = NarrativeKnowledgeStore::open("book-analysis-index", &pages, &wal).unwrap();
        assert_eq!(
            reopened.fragment_analysis_ids_for_document_after("chapter-b", None, 10).unwrap(),
            vec!["analysis-a"],
        );
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fragment_analysis_can_be_removed_when_a_paragraph_disappears() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book-analysis-delete", &pages, &wal).unwrap();
        let record = FragmentAnalysisRecord {
            id: "paragraph-old".into(), document_id: "chapter".into(),
            revision: 2, start_byte: 0, end_byte: 4,
            character_count: 4, word_count: 1, unique_word_count: 1,
            sentence_count: 1, paragraph_count: 1, long_word_count: 0,
            source_text: None,
            average_word_length_milli: 4_000, repeated_words: vec![],
        };
        store.put_fragment_analysis(&record).unwrap();
        assert!(store.delete_fragment_analysis(&record.id).unwrap());
        assert!(!store.delete_fragment_analysis(&record.id).unwrap());
        assert_eq!(store.get_fragment_analysis(&record.id).unwrap(), None);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fragment_analysis_is_isolated_between_projects() {
        let (root, pages, wal) = paths();
        let record = FragmentAnalysisRecord {
            id: "same-analysis-id".into(), document_id: "chapter".into(),
            revision: 1, start_byte: 0, end_byte: 4,
            character_count: 4, word_count: 1, unique_word_count: 1,
            sentence_count: 1, paragraph_count: 1, long_word_count: 0,
            average_word_length_milli: 4_000, source_text: None, repeated_words: vec![],
        };
        {
            let mut a = NarrativeKnowledgeStore::open("private-book-A", &pages, &wal).unwrap();
            a.put_fragment_analysis(&record).unwrap();
        }
        {
            let mut b = NarrativeKnowledgeStore::open("private-book-B", &pages, &wal).unwrap();
            assert_eq!(b.get_fragment_analysis("same-analysis-id").unwrap(), None);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_duplicate_entity_attribute_keys() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book", &pages, &wal).unwrap();
        let entity = EntityRecord {
            id: "person".into(), canonical_name: "Persona".into(),
            entity_type: "character".into(),
            attributes: vec![("age".into(), "20".into()), ("age".into(), "21".into())],
            status: RecordStatus::Proposed,
        };
        assert!(matches!(store.put_entity(&entity), Err(KnowledgeError::Invalid(_))));
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn narrative_deletions_reject_dependents_and_allow_ordered_cleanup() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book-delete-integrity", &pages, &wal).unwrap();
        for id in ["ana", "luis"] {
            store.put_entity(&EntityRecord {
                id: id.into(), canonical_name: id.into(), entity_type: "character".into(),
                attributes: vec![], status: RecordStatus::Confirmed,
            }).unwrap();
        }
        store.put_entity(&EntityRecord {
            id: "maria".into(), canonical_name: "Maria".into(), entity_type: "character".into(),
            attributes: vec![], status: RecordStatus::Confirmed,
        }).unwrap();
        store.put_relation(&RelationRecord {
            id: "rel".into(), subject_id: "ana".into(), predicate: "conoce".into(),
            object_id: "luis".into(), status: RecordStatus::Confirmed,
        }).unwrap();
        store.put_event(&EventRecord {
            id: "event".into(), label: "Llegada".into(), chronology_order: None,
            status: RecordStatus::Confirmed,
        }).unwrap();
        let evidence = |id: &str, kind: EvidenceTarget, target: &str| EvidenceRecord {
            id: id.into(), target_kind: kind, target_id: target.into(), document_id: "chapter".into(),
            revision: 1, start_byte: 0, end_byte: 3, excerpt: "Ana".into(),
            source_kind: "explicit_text".into(), stale: false,
        };
        store.put_evidence(&evidence("ev-entity", EvidenceTarget::Entity, "ana")).unwrap();
        store.put_evidence(&evidence("ev-relation", EvidenceTarget::Relation, "rel")).unwrap();
        store.put_evidence(&evidence("ev-event", EvidenceTarget::Event, "event")).unwrap();

        assert!(matches!(store.delete_entity("ana"), Err(KnowledgeError::Invalid(_))));
        assert!(matches!(store.delete_relation("rel"), Err(KnowledgeError::Invalid(_))));
        assert!(matches!(store.delete_event("event"), Err(KnowledgeError::Invalid(_))));
        // Reemplazar la relación cambia sus extremos sin dejar referencias
        // residuales al sujeto anterior.
        store.put_relation(&RelationRecord {
            id: "rel".into(), subject_id: "maria".into(), predicate: "conoce".into(),
            object_id: "luis".into(), status: RecordStatus::Confirmed,
        }).unwrap();
        assert!(store.delete_evidence("ev-entity").unwrap());
        assert!(store.delete_entity("ana").unwrap());
        assert!(matches!(store.delete_entity("maria"), Err(KnowledgeError::Invalid(_))));
        assert!(store.delete_evidence("ev-relation").unwrap());
        assert!(store.delete_relation("rel").unwrap());
        assert!(store.delete_evidence("ev-event").unwrap());
        assert!(store.delete_event("event").unwrap());
        assert!(store.delete_entity("luis").unwrap());
        assert!(store.delete_entity("maria").unwrap());
        assert!(!store.delete_entity("ana").unwrap());
        assert!(!store.delete_relation("rel").unwrap());
        assert!(!store.delete_event("event").unwrap());
        drop(store);
        let mut reopened = NarrativeKnowledgeStore::open("book-delete-integrity", &pages, &wal).unwrap();
        assert!(reopened.get_entity("ana").unwrap().is_none());
        assert!(reopened.get_entity("luis").unwrap().is_none());
        assert!(reopened.get_entity("maria").unwrap().is_none());
        assert!(reopened.get_relation("rel").unwrap().is_none());
        assert!(reopened.get_event("event").unwrap().is_none());
        assert!(reopened.get_evidence("ev-entity").unwrap().is_none());
        assert!(reopened.get_evidence("ev-relation").unwrap().is_none());
        assert!(reopened.get_evidence("ev-event").unwrap().is_none());
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn entity_deletion_fails_closed_on_malformed_relation_records() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book-corrupt-relation", &pages, &wal).unwrap();
        store.put_entity(&EntityRecord {
            id: "ana".into(), canonical_name: "Ana".into(), entity_type: "character".into(),
            attributes: vec![], status: RecordStatus::Confirmed,
        }).unwrap();

        // Registro durable con formato legible pero un extremo inválido.
        let mut bytes = vec![FORMAT_VERSION, RecordStatus::Confirmed as u8];
        put_string(&mut bytes, "").unwrap();
        put_string(&mut bytes, "conoce").unwrap();
        put_string(&mut bytes, "ana").unwrap();
        store.put(RELATION_TABLE, "broken-relation", bytes).unwrap();

        assert!(matches!(store.delete_entity("ana"), Err(KnowledgeError::Corrupt(_))));
        assert!(store.get_entity("ana").unwrap().is_some());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn entity_deletion_respects_relation_references_in_every_status() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book-all-relation-statuses", &pages, &wal).unwrap();
        for id in ["ana", "luis"] {
            store.put_entity(&EntityRecord {
                id: id.into(), canonical_name: id.into(), entity_type: "character".into(),
                attributes: vec![], status: RecordStatus::Confirmed,
            }).unwrap();
        }
        let statuses = [
            RecordStatus::Proposed,
            RecordStatus::Confirmed,
            RecordStatus::Rejected,
            RecordStatus::Superseded,
        ];
        for (index, status) in statuses.into_iter().enumerate() {
            let relation_id = format!("relation-{index}");
            store.put_relation(&RelationRecord {
                id: relation_id.clone(), subject_id: "ana".into(),
                predicate: "conoce".into(), object_id: "luis".into(), status,
            }).unwrap();
            assert!(matches!(store.delete_entity("ana"), Err(KnowledgeError::Invalid(_))));
            assert!(matches!(store.delete_entity("luis"), Err(KnowledgeError::Invalid(_))));
            assert!(store.delete_relation(&relation_id).unwrap());
        }
        assert!(store.delete_entity("ana").unwrap());
        assert!(store.delete_entity("luis").unwrap());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn integrity_audit_reports_orphans_and_pages_by_scanned_records() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book-integrity-audit", &pages, &wal).unwrap();
        store.put_entity(&EntityRecord {
            id: "known".into(), canonical_name: "Known".into(), entity_type: "character".into(),
            attributes: vec![], status: RecordStatus::Confirmed,
        }).unwrap();

        let relation_bytes = |subject: &str, object: &str| {
            let mut bytes = vec![FORMAT_VERSION, RecordStatus::Confirmed as u8];
            put_string(&mut bytes, subject).unwrap();
            put_string(&mut bytes, "conoce").unwrap();
            put_string(&mut bytes, object).unwrap();
            bytes
        };
        // Simula datos antiguos/inconsistentes introducidos antes de las
        // validaciones actuales de put_relation.
        store.put(RELATION_TABLE, "a-orphan", relation_bytes("missing-person", "known")).unwrap();
        store.put(RELATION_TABLE, "b-valid", relation_bytes("known", "known")).unwrap();

        let first = store.audit_integrity_page("relation", None, 1).unwrap();
        assert_eq!(first.scanned, 1);
        assert!(first.has_more);
        assert_eq!(first.next_after.as_deref(), Some("a-orphan"));
        assert_eq!(first.issues, vec![IntegrityIssue {
            table: "relation", record_id: "a-orphan".into(),
            code: "orphan_relation_subject", target_id: Some("missing-person".into()),
        }]);

        let second = store.audit_integrity_page("relation", first.next_after.as_deref(), 1).unwrap();
        assert_eq!(second.scanned, 1);
        assert!(!second.has_more);
        assert!(second.issues.is_empty());

        let evidence = EvidenceRecord {
            id: "orphan-evidence".into(), target_kind: EvidenceTarget::Event,
            target_id: "missing-event".into(), document_id: "chapter".into(),
            revision: 1, start_byte: 0, end_byte: 4, excerpt: "word".into(),
            source_kind: "manual".into(), stale: false,
        };
        store.put(EVIDENCE_TABLE, &evidence.id, encode_evidence(&evidence).unwrap()).unwrap();
        let evidence_page = store.audit_integrity_page("evidence", None, 10).unwrap();
        assert_eq!(evidence_page.issues, vec![IntegrityIssue {
            table: "evidence", record_id: "orphan-evidence".into(),
            code: "orphan_evidence_target", target_id: Some("missing-event".into()),
        }]);

        assert!(matches!(store.audit_integrity_page("unknown", None, 10), Err(KnowledgeError::Invalid(_))));
        assert!(matches!(store.audit_integrity_page("entity", None, 0), Err(KnowledgeError::Invalid(_))));

        // Los registros ilegibles se notifican como incidencias y no detienen
        // el resto de la auditoría ni provocan una reparación automática.
        store.put(EVENT_TABLE, "corrupt-event", vec![0]).unwrap();
        let corrupt_page = store.audit_integrity_page("event", None, 10).unwrap();
        assert_eq!(corrupt_page.issues, vec![IntegrityIssue {
            table: "event", record_id: "corrupt-event".into(),
            code: "malformed_record", target_id: None,
        }]);
        assert!(store.get(EVENT_TABLE, "corrupt-event").unwrap().is_some());

        let valid_analysis = FragmentAnalysisRecord {
            id: "a-valid".into(), document_id: "chapter".into(), revision: 3,
            start_byte: 0, end_byte: 4, character_count: 4, word_count: 1,
            unique_word_count: 1, sentence_count: 1, paragraph_count: 1,
            long_word_count: 0, average_word_length_milli: 4_000,
            source_text: Some("text".into()),
            repeated_words: vec![],
        };
        store.put_fragment_analysis(&valid_analysis).unwrap();
        // Registro antiguo/corrupto con ID de documento vacío: se introduce
        // directamente para verificar que la auditoría detecta el defecto.
        let mut invalid_analysis = vec![FORMAT_VERSION];
        put_string(&mut invalid_analysis, "").unwrap();
        for value in [3u64, 0, 4, 4, 1, 1, 1, 1, 0, 4_000] {
            invalid_analysis.extend_from_slice(&value.to_le_bytes());
        }
        put_count(&mut invalid_analysis, 0).unwrap();
        store.put(FRAGMENT_ANALYSIS_TABLE, "b-invalid", invalid_analysis).unwrap();

        let first_analysis_page = store.audit_integrity_page("fragment_analysis", None, 1).unwrap();
        assert_eq!(first_analysis_page.scanned, 1);
        assert!(first_analysis_page.issues.is_empty());
        assert!(first_analysis_page.has_more);
        assert_eq!(first_analysis_page.next_after.as_deref(), Some("a-valid"));
        let second_analysis_page = store.audit_integrity_page(
            "fragment_analysis", first_analysis_page.next_after.as_deref(), 1,
        ).unwrap();
        assert_eq!(second_analysis_page.scanned, 1);
        assert!(!second_analysis_page.has_more);
        assert_eq!(second_analysis_page.issues, vec![IntegrityIssue {
            table: "fragment_analysis", record_id: "b-invalid".into(),
            code: "invalid_fragment_analysis_fields", target_id: None,
        }]);
        assert!(store.get(FRAGMENT_ANALYSIS_TABLE, "b-invalid").unwrap().is_some());

        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_relations_and_evidence_with_missing_targets() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book-integrity", &pages, &wal).unwrap();
        let relation = RelationRecord {
            id: "rel-missing".into(), subject_id: "missing-a".into(),
            predicate: "conoce".into(), object_id: "missing-b".into(),
            status: RecordStatus::Proposed,
        };
        assert!(matches!(store.put_relation(&relation), Err(KnowledgeError::Invalid(_))));
        let evidence = EvidenceRecord {
            id: "ev-missing".into(), target_kind: EvidenceTarget::Event,
            target_id: "missing-event".into(), document_id: "chapter".into(),
            revision: 0, start_byte: 0, end_byte: 1,
            excerpt: "x".into(), source_kind: "manual".into(), stale: false,
        };
        assert!(matches!(store.put_evidence(&evidence), Err(KnowledgeError::Invalid(_))));
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_invalid_evidence_ranges() {
        let (root, pages, wal) = paths();
        let mut store = NarrativeKnowledgeStore::open("book", &pages, &wal).unwrap();
        let evidence = EvidenceRecord {
            id: "e".into(), target_kind: EvidenceTarget::Event, target_id: "event".into(),
            document_id: "chapter".into(), revision: 0, start_byte: 9, end_byte: 2,
            excerpt: "x".into(), source_kind: "manual".into(), stale: false,
        };
        assert!(matches!(store.put_evidence(&evidence), Err(KnowledgeError::Invalid(_))));
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
}
