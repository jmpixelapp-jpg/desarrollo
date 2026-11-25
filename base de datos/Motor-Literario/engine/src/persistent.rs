//! Puente durable entre los cambios del editor y MLDB.
//!
//! El anfitrión sigue siendo la autoridad del snapshot inicial. MLDB conserva
//! una secuencia incremental de cambios y su high-water mark en transacciones
//! MLPJ. Si el anfitrión reinicia con un snapshot anterior, el motor reproduce
//! los eventos durables que faltan. No se guarda el manuscrito completo por
//! cada pulsación.

use std::collections::BTreeMap;
use std::path::Path;

use mldb_storage::project_store::{ProjectOperation, ProjectStore};

use crate::{AffectedParagraphSnapshot, ApplyOutcome, DocumentSnapshot, EngineError, LiveSession, Suggestion};

const HEAD_TABLE: &str = "live_document_heads";
const EVENT_TABLE_PREFIX: &str = "live_events_";
const HEAD_MAGIC: &[u8; 4] = b"MLHD";
const EVENT_MAGIC: &[u8; 4] = b"MLEV";
const FORMAT_VERSION: u8 = 1;
const EVENT_CHUNK_BYTES: usize = 3_000;
const MAX_EVENT_CHUNKS: usize = 4_096;
const MAX_DURABLE_HISTORY_CHANGES: u64 = 100_000;

/// Delta recuperado del historial durable de un documento.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableDocumentChange {
    pub sequence: u64,
    pub base_revision: u64,
    pub revision: u64,
    pub start_byte: usize,
    pub end_byte: usize,
    pub replacement_bytes: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Head {
    epoch: u64,
    base_sequence: u64,
    last_sequence: u64,
    last_revision: u64,
    legacy_event_table: bool,
}

pub struct PersistentLiveEngine {
    project_id: String,
    store: ProjectStore,
    sessions: BTreeMap<String, LiveSession>,
    heads: BTreeMap<String, Head>,
    recovery_required: bool,
}

impl PersistentLiveEngine {
    /// Abre MLDB y vincula esta instancia a la identidad aportada por el anfitrión.
    pub fn open(
        project_id: impl Into<String>,
        pages_path: impl AsRef<Path>,
        wal_path: impl AsRef<Path>,
    ) -> Result<Self, EngineError> {
        let project_id = project_id.into();
        validate_project_id(&project_id)?;
        let store = ProjectStore::open(pages_path, wal_path)
            .map_err(|error| EngineError::Persistence(error.to_string()))?;
        Ok(Self {
            project_id,
            store,
            sessions: BTreeMap::new(),
            heads: BTreeMap::new(),
            recovery_required: false,
        })
    }

    /// Abre un workspace ya existente sin crear ni inicializar archivos ausentes.
    /// Estas rutas deben pertenecer a una working copy mutable, nunca a una generación publicada.
    pub fn open_existing(
        project_id: impl Into<String>,
        pages_path: impl AsRef<Path>,
        wal_path: impl AsRef<Path>,
    ) -> Result<Self, EngineError> {
        let project_id = project_id.into();
        validate_project_id(&project_id)?;
        let store = ProjectStore::open_existing(pages_path, wal_path)
            .map_err(|error| EngineError::Persistence(error.to_string()))?;
        Ok(Self {
            project_id,
            store,
            sessions: BTreeMap::new(),
            heads: BTreeMap::new(),
            recovery_required: false,
        })
    }

    /// Abre una working copy existente ligada al lock de sesión.
    /// El ProjectStore valida el lock antes de recovery y en cada mutación durable.
    pub fn open_existing_with_session_validator(
        project_id: impl Into<String>,
        pages_path: impl AsRef<Path>,
        wal_path: impl AsRef<Path>,
        validator: mldb_storage::bundle::SessionLockValidator,
    ) -> Result<Self, EngineError> {
        let project_id = project_id.into();
        validate_project_id(&project_id)?;
        let store = ProjectStore::open_existing_with_session_validator(
            pages_path, wal_path, validator,
        ).map_err(|error| EngineError::Persistence(error.to_string()))?;
        Ok(Self {
            project_id,
            store,
            sessions: BTreeMap::new(),
            heads: BTreeMap::new(),
            recovery_required: false,
        })
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn open_document(
        &mut self,
        project_id: &str,
        document_id: impl Into<String>,
        host_text: impl Into<String>,
        host_revision: u64,
        host_sequence: u64,
    ) -> Result<(), EngineError> {
        self.ensure_ready()?;
        self.require_project(project_id)?;
        let document_id = document_id.into();
        validate_document_id(&document_id)?;
        if self.sessions.contains_key(&document_id) {
            return Err(EngineError::DocumentAlreadyOpen);
        }

        let mut session = LiveSession::open(
            project_id,
            document_id.clone(),
            host_text,
            host_revision,
            host_sequence,
        )?;

        let stored = self.store.get_project(project_id, HEAD_TABLE, &document_id)
            .map_err(|error| EngineError::Persistence(error.to_string()))?;

        let head = match stored {
            None => {
                let head = Head {
                    epoch: 0,
                    base_sequence: host_sequence,
                    last_sequence: host_sequence,
                    last_revision: host_revision,
                    legacy_event_table: false,
                };
                self.persist_head(&document_id, head)?;
                head
            }
            Some(bytes) => {
                let mut head = decode_head(&bytes)?;
                if host_sequence < head.base_sequence {
                    return Err(EngineError::ResynchronizationRequired);
                }
                if host_sequence > head.last_sequence {
                    // El anfitrión tiene un snapshot más reciente: se convierte
                    // en la nueva base autoritativa sin reconstruir texto perdido.
                    let next_epoch = head.epoch.checked_add(1)
                        .ok_or(EngineError::CounterExhausted("document_epoch"))?;
                    let previous_head = head;
                    head = Head {
                        epoch: next_epoch,
                        base_sequence: host_sequence,
                        last_sequence: host_sequence,
                        last_revision: host_revision,
                        legacy_event_table: false,
                    };
                    self.persist_head(&document_id, head)?;
                    self.cleanup_event_table(&document_id, previous_head)?;
                } else if host_sequence == head.last_sequence {
                    if host_revision != head.last_revision {
                        return Err(EngineError::RevisionConflict {
                            expected: head.last_revision,
                            received: host_revision,
                        });
                    }
                } else {
                    self.replay_after(&document_id, &mut session, host_sequence, head)?;
                }
                head
            }
        };

        if session.last_sequence() != head.last_sequence
            || session.revision() != head.last_revision
        {
            return Err(EngineError::ResynchronizationRequired);
        }
        self.heads.insert(document_id.clone(), head);
        self.sessions.insert(document_id, session);
        Ok(())
    }

    /// Aplica y persiste el evento antes de publicar el nuevo estado en memoria.
    /// Un fallo de almacenamiento deja la instancia en cuarentena hasta reabrir MLDB.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_change(
        &mut self,
        project_id: &str,
        document_id: &str,
        sequence: u64,
        base_revision: u64,
        start_byte: usize,
        end_byte: usize,
        replacement: &str,
    ) -> Result<ApplyOutcome, EngineError> {
        self.ensure_ready()?;
        self.require_project(project_id)?;
        let current = self.sessions.get(document_id)
            .ok_or(EngineError::DocumentNotOpen)?;
        if let Some(outcome) = current.validate_change(
            sequence, base_revision, start_byte, end_byte, replacement,
        )? {
            return Ok(outcome);
        }
        let revision = base_revision.checked_add(1)
            .ok_or(EngineError::CounterExhausted("revision"))?;
        let old_head = *self.heads.get(document_id)
            .ok_or(EngineError::ResynchronizationRequired)?;
        let next_head = Head {
            epoch: old_head.epoch,
            base_sequence: old_head.base_sequence,
            last_sequence: sequence,
            last_revision: revision,
            legacy_event_table: old_head.legacy_event_table,
        };
        let event_ops = encode_event_operations(
            &self.project_id,
            document_id,
            old_head,
            sequence,
            base_revision,
            start_byte,
            end_byte,
            replacement,
        )?;
        let mut operations = event_ops;
        operations.push(ProjectOperation::Put {
            project_id: self.project_id.clone(),
            table: HEAD_TABLE.to_owned(),
            record_id: document_id.to_owned(),
            value: encode_head(next_head),
        });

        if let Err(error) = self.store.apply_batch(operations) {
            self.recovery_required = true;
            return Err(EngineError::Persistence(error.to_string()));
        }

        let outcome = match self.sessions.get_mut(document_id)
            .ok_or(EngineError::DocumentNotOpen)?
            .apply_change(sequence, base_revision, start_byte, end_byte, replacement)
        {
            Ok(outcome @ ApplyOutcome::Applied { .. }) => outcome,
            Ok(_) | Err(_) => {
                self.recovery_required = true;
                return Err(EngineError::PersistenceRecoveryRequired);
            }
        };
        self.heads.insert(document_id.to_owned(), next_head);
        Ok(outcome)
    }

    /// Reemplaza la base de recuperación con un snapshot explícito del anfitrión.
    /// Los eventos anteriores se vuelven no reproducibles y pueden compactarse.
    pub fn resynchronize_document(
        &mut self,
        project_id: &str,
        document_id: &str,
        authoritative_text: impl Into<String>,
        authoritative_revision: u64,
        authoritative_sequence: u64,
    ) -> Result<(), EngineError> {
        self.ensure_ready()?;
        self.require_project(project_id)?;
        if !self.sessions.contains_key(document_id) {
            return Err(EngineError::DocumentNotOpen);
        }
        let replacement = LiveSession::open(
            project_id,
            document_id.to_owned(),
            authoritative_text,
            authoritative_revision,
            authoritative_sequence,
        )?;
        let previous_epoch = *self.heads.get(document_id)
            .ok_or(EngineError::ResynchronizationRequired)?;
        let next_epoch = previous_epoch.epoch.checked_add(1)
            .ok_or(EngineError::CounterExhausted("document_epoch"))?;
        let head = Head {
            epoch: next_epoch,
            base_sequence: authoritative_sequence,
            last_sequence: authoritative_sequence,
            last_revision: authoritative_revision,
            legacy_event_table: false,
        };
        self.persist_head(document_id, head)?;
        self.cleanup_event_table(document_id, previous_epoch)?;
        self.sessions.insert(document_id.to_owned(), replacement);
        self.heads.insert(document_id.to_owned(), head);
        Ok(())
    }

    /// Guarda un checkpoint lógico en el high-water mark y elimina eventos antiguos
    /// en lotes acotados. El texto sigue siendo propiedad del anfitrión.
    pub fn checkpoint_document(
        &mut self,
        project_id: &str,
        document_id: &str,
        host_saved_revision: u64,
        host_saved_sequence: u64,
    ) -> Result<(), EngineError> {
        self.ensure_ready()?;
        self.require_project(project_id)?;
        let head = *self.heads.get(document_id)
            .ok_or(EngineError::DocumentNotOpen)?;
        if host_saved_revision != head.last_revision
            || host_saved_sequence != head.last_sequence
        {
            return Err(EngineError::RevisionConflict {
                expected: head.last_revision,
                received: host_saved_revision,
            });
        }
        let checkpoint = Head {
            base_sequence: host_saved_sequence,
            ..head
        };
        self.persist_head(document_id, checkpoint)?;
        self.heads.insert(document_id.to_owned(), checkpoint);

        let table = event_table_for_head(document_id, checkpoint);
        let mut range = self.store.scan_project_table_iter(project_id, &table)
            .map_err(|error| EngineError::Persistence(error.to_string()))?;
        let mut stale_ids = Vec::new();
        while let Some(record) = range.next() {
            let (record_id, _) = record
                .map_err(|error| EngineError::Persistence(error.to_string()))?;
            if let Some((sequence, _)) = parse_event_id(&record_id) {
                if sequence <= checkpoint.base_sequence {
                    stale_ids.push(record_id);
                }
            }
        }
        for chunk in stale_ids.chunks(512) {
            let operations = chunk.iter().map(|record_id| ProjectOperation::Delete {
                project_id: project_id.to_owned(),
                table: table.clone(),
                record_id: record_id.clone(),
            }).collect();
            if let Err(error) = self.store.apply_batch(operations) {
                self.recovery_required = true;
                return Err(EngineError::Persistence(error.to_string()));
            }
        }
        Ok(())
    }

    pub fn close_document(
        &mut self,
        project_id: &str,
        document_id: &str,
    ) -> Result<(), EngineError> {
        self.ensure_ready()?;
        self.require_project(project_id)?;
        self.sessions.remove(document_id)
            .map(|_| ())
            .ok_or(EngineError::DocumentNotOpen)
    }

    pub fn snapshot(
        &self,
        project_id: &str,
        document_id: &str,
    ) -> Result<DocumentSnapshot, EngineError> {
        self.ensure_ready()?;
        self.require_project(project_id)?;
        self.sessions.get(document_id)
            .map(LiveSession::snapshot)
            .ok_or(EngineError::DocumentNotOpen)
    }

    /// Recupera la cadena ordenada de deltas confirmados de la época activa.
    /// Valida secuencias, revisiones y bloques antes de exponer offsets para reanclar citas.
    pub fn durable_document_changes(
        &mut self,
        project_id: &str,
        document_id: &str,
    ) -> Result<Vec<DurableDocumentChange>, EngineError> {
        self.ensure_ready()?;
        self.require_project(project_id)?;
        let head = *self.heads.get(document_id).ok_or(EngineError::DocumentNotOpen)?;
        if head.last_sequence < head.base_sequence {
            return Err(EngineError::ResynchronizationRequired);
        }
        let expected_count = head.last_sequence - head.base_sequence;
        if expected_count > MAX_DURABLE_HISTORY_CHANGES {
            return Err(EngineError::ResynchronizationRequired);
        }
        if expected_count == 0 {
            return Ok(Vec::new());
        }
        let table = event_table_for_head(document_id, head);
        let mut range = self.store.scan_project_table_iter(project_id, &table)
            .map_err(|error| EngineError::Persistence(error.to_string()))?;
        let mut expected_sequence = head.base_sequence.checked_add(1)
            .ok_or(EngineError::CounterExhausted("sequence"))?;
        let mut previous_revision: Option<u64> = None;
        let mut changes = Vec::with_capacity(expected_count as usize);
        let mut current_sequence: Option<u64> = None;
        let mut current_chunks: BTreeMap<u32, Vec<u8>> = BTreeMap::new();

        // El iterador de ProjectStore ordena por ID: solo se mantiene en memoria
        // el grupo de bloques del evento actual, no el historial completo.
        while let Some(record) = range.next() {
            let (record_id, bytes) = record
                .map_err(|error| EngineError::Persistence(error.to_string()))?;
            let (sequence, chunk) = parse_event_id(&record_id)
                .ok_or_else(|| EngineError::Persistence("ID de evento MLDB inválido".into()))?;
            if sequence <= head.base_sequence || sequence > head.last_sequence {
                continue;
            }
            if current_sequence.is_some_and(|active| active != sequence) {
                append_durable_change(
                    current_sequence.unwrap(),
                    &current_chunks,
                    head.last_sequence,
                    &mut expected_sequence,
                    &mut previous_revision,
                    &mut changes,
                )?;
                current_chunks.clear();
                current_sequence = None;
            }
            if current_sequence.is_none() {
                if sequence != expected_sequence {
                    return Err(EngineError::ResynchronizationRequired);
                }
                current_sequence = Some(sequence);
            }
            if current_chunks.insert(chunk, bytes).is_some() {
                return Err(EngineError::Persistence("bloque durable duplicado".into()));
            }
        }
        if let Some(sequence) = current_sequence {
            append_durable_change(
                sequence,
                &current_chunks,
                head.last_sequence,
                &mut expected_sequence,
                &mut previous_revision,
                &mut changes,
            )?;
        }
        if changes.len() != expected_count as usize
            || previous_revision != Some(head.last_revision)
        {
            return Err(EngineError::ResynchronizationRequired);
        }
        Ok(changes)
    }

    /// Comprueba la vigencia de un fragmento sin construir un snapshot del manuscrito.
    pub fn fragment_matches(
        &self,
        project_id: &str,
        document_id: &str,
        expected_revision: u64,
        expected_sequence: u64,
        start_byte: usize,
        end_byte: usize,
        expected_text: &str,
    ) -> Result<(u64, u64, bool), EngineError> {
        self.ensure_ready()?;
        self.require_project(project_id)?;
        let session = self.sessions.get(document_id).ok_or(EngineError::DocumentNotOpen)?;
        Ok((
            session.revision(),
            session.last_sequence(),
            session.fragment_matches(
                expected_revision, expected_sequence, start_byte, end_byte, expected_text,
            ),
        ))
    }

    /// Valida la procedencia de un extracto sin clonar el documento completo.
    pub fn validate_evidence(
        &self,
        project_id: &str,
        document_id: &str,
        expected_revision: u64,
        start_byte: usize,
        end_byte: usize,
        excerpt: &str,
    ) -> Result<(), EngineError> {
        self.ensure_ready()?;
        self.require_project(project_id)?;
        self.sessions.get(document_id)
            .ok_or(EngineError::DocumentNotOpen)?
            .validate_evidence_excerpt(expected_revision, start_byte, end_byte, excerpt)
    }

    /// Contrasta la revisión y el rango de un análisis persistido con el documento vivo.
    pub fn validate_fragment_anchor(
        &self,
        project_id: &str,
        document_id: &str,
        expected_revision: u64,
        start_byte: usize,
        end_byte: usize,
    ) -> Result<(), EngineError> {
        self.ensure_ready()?;
        self.require_project(project_id)?;
        self.sessions.get(document_id)
            .ok_or(EngineError::DocumentNotOpen)?
            .validate_fragment_anchor(expected_revision, start_byte, end_byte)
    }

    /// Extrae solo el párrafo afectado, sin clonar el documento completo.
    pub fn affected_paragraph(
        &self,
        project_id: &str,
        document_id: &str,
        expected_revision: u64,
        selection_start_byte: usize,
        selection_end_byte: usize,
    ) -> Result<AffectedParagraphSnapshot, EngineError> {
        self.ensure_ready()?;
        self.require_project(project_id)?;
        let session = self.sessions.get(document_id).ok_or(EngineError::DocumentNotOpen)?;
        if session.revision() != expected_revision {
            return Err(EngineError::AnalysisRevisionConflict {
                expected: expected_revision,
                received: session.revision(),
                last_sequence: session.last_sequence(),
            });
        }
        session.affected_paragraph(selection_start_byte, selection_end_byte)
            .ok_or(EngineError::InvalidRange)
    }

    pub fn add_suggestion(
        &mut self,
        project_id: &str,
        document_id: &str,
        suggestion: Suggestion,
    ) -> Result<(), EngineError> {
        self.ensure_ready()?;
        self.require_project(project_id)?;
        self.sessions.get_mut(document_id)
            .ok_or(EngineError::DocumentNotOpen)?
            .add_suggestion(suggestion)
    }

    pub fn validate_storage(&mut self) -> Result<(), EngineError> {
        self.ensure_ready()?;
        self.store.validate()
            .map(|_| ())
            .map_err(|error| EngineError::Persistence(error.to_string()))
    }

    fn replay_after(
        &mut self,
        document_id: &str,
        session: &mut LiveSession,
        host_sequence: u64,
        head: Head,
    ) -> Result<(), EngineError> {
        let table = event_table_for_head(document_id, head);
        let mut range = self.store.scan_project_table_iter(&self.project_id, &table)
            .map_err(|error| EngineError::Persistence(error.to_string()))?;
        let mut expected = host_sequence.checked_add(1)
            .ok_or(EngineError::CounterExhausted("sequence"))?;
        let mut current_sequence: Option<u64> = None;
        let mut current_chunks: BTreeMap<u32, Vec<u8>> = BTreeMap::new();

        while let Some(record) = range.next() {
            let (record_id, bytes) = record
                .map_err(|error| EngineError::Persistence(error.to_string()))?;
            let (sequence, chunk) = parse_event_id(&record_id)
                .ok_or_else(|| EngineError::Persistence("ID de evento MLDB inválido".into()))?;
            if sequence <= host_sequence || sequence > head.last_sequence {
                continue;
            }
            if current_sequence.is_some_and(|active| active != sequence) {
                let completed = current_sequence.unwrap();
                apply_replayed_event(session, completed, &current_chunks, &mut expected)?;
                current_chunks.clear();
            }
            current_sequence = Some(sequence);
            if current_chunks.insert(chunk, bytes).is_some() {
                return Err(EngineError::Persistence("bloque de evento duplicado".into()));
            }
        }
        if let Some(sequence) = current_sequence {
            apply_replayed_event(session, sequence, &current_chunks, &mut expected)?;
        }
        let expected_after_head = if head.last_sequence == u64::MAX {
            u64::MAX
        } else {
            head.last_sequence + 1
        };
        if expected != expected_after_head {
            return Err(EngineError::ResynchronizationRequired);
        }
        if session.last_sequence() != head.last_sequence
            || session.revision() != head.last_revision
        {
            return Err(EngineError::ResynchronizationRequired);
        }
        Ok(())
    }

    fn cleanup_event_table(&mut self, document_id: &str, head: Head) -> Result<(), EngineError> {
        let table = event_table_for_head(document_id, head);
        let mut range = self.store.scan_project_table_iter(&self.project_id, &table)
            .map_err(|error| EngineError::Persistence(error.to_string()))?;
        let mut ids = Vec::new();
        while let Some(record) = range.next() {
            let (record_id, _) = record
                .map_err(|error| EngineError::Persistence(error.to_string()))?;
            ids.push(record_id);
        }
        for chunk in ids.chunks(512) {
            let operations = chunk.iter().map(|record_id| ProjectOperation::Delete {
                project_id: self.project_id.clone(),
                table: table.clone(),
                record_id: record_id.clone(),
            }).collect();
            if let Err(error) = self.store.apply_batch(operations) {
                self.recovery_required = true;
                return Err(EngineError::Persistence(error.to_string()));
            }
        }
        Ok(())
    }

    fn persist_head(&mut self, document_id: &str, head: Head) -> Result<(), EngineError> {
        let operation = ProjectOperation::Put {
            project_id: self.project_id.clone(),
            table: HEAD_TABLE.to_owned(),
            record_id: document_id.to_owned(),
            value: encode_head(head),
        };
        if let Err(error) = self.store.apply_batch(vec![operation]) {
            self.recovery_required = true;
            return Err(EngineError::Persistence(error.to_string()));
        }
        Ok(())
    }

    fn require_project(&self, project_id: &str) -> Result<(), EngineError> {
        if project_id == self.project_id {
            Ok(())
        } else {
            Err(EngineError::ProjectNotOpen)
        }
    }

    fn ensure_ready(&self) -> Result<(), EngineError> {
        if self.recovery_required {
            Err(EngineError::PersistenceRecoveryRequired)
        } else {
            Ok(())
        }
    }
}

fn apply_replayed_event(
    session: &mut LiveSession,
    sequence: u64,
    chunks: &BTreeMap<u32, Vec<u8>>,
    expected: &mut u64,
) -> Result<(), EngineError> {
    if sequence != *expected {
        return Err(EngineError::ResynchronizationRequired);
    }
    let (base_revision, start, end, replacement) = decode_event(chunks)?;
    let result = session.apply_change(sequence, base_revision, start, end, &replacement)?;
    if !matches!(result, ApplyOutcome::Applied { .. }) {
        return Err(EngineError::ResynchronizationRequired);
    }
    if sequence != u64::MAX {
        *expected = sequence + 1;
    }
    Ok(())
}

fn validate_project_id(value: &str) -> Result<(), EngineError> {
    if value.trim().is_empty() || value.len() > 128 {
        return Err(EngineError::InvalidIdentifier("project_id"));
    }
    Ok(())
}

fn validate_document_id(value: &str) -> Result<(), EngineError> {
    if value.trim().is_empty() || value.len() > 128 {
        return Err(EngineError::InvalidIdentifier("document_id"));
    }
    Ok(())
}

fn event_table(document_id: &str, epoch: u64) -> String {
    let mut table = String::with_capacity(EVENT_TABLE_PREFIX.len() + document_id.len() * 2);
    table.push_str(EVENT_TABLE_PREFIX);
    for byte in document_id.as_bytes() {
        use std::fmt::Write as _;
        let _ = write!(table, "{byte:02x}");
    }
    use std::fmt::Write as _;
    let _ = write!(table, "_{epoch:020}");
    table
}

fn legacy_event_table(document_id: &str) -> String {
    let mut table = String::with_capacity(EVENT_TABLE_PREFIX.len() + document_id.len() * 2);
    table.push_str(EVENT_TABLE_PREFIX);
    for byte in document_id.as_bytes() {
        use std::fmt::Write as _;
        let _ = write!(table, "{byte:02x}");
    }
    table
}

fn event_table_for_head(document_id: &str, head: Head) -> String {
    if head.legacy_event_table {
        legacy_event_table(document_id)
    } else {
        event_table(document_id, head.epoch)
    }
}

fn event_id(sequence: u64, chunk: usize) -> String {
    format!("{sequence:020}:{chunk:06}")
}

fn parse_event_id(value: &str) -> Option<(u64, u32)> {
    let (sequence, chunk) = value.split_once(':')?;
    Some((sequence.parse().ok()?, chunk.parse().ok()?))
}

fn encode_head(head: Head) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(if head.legacy_event_table { 29 } else { 37 });
    bytes.extend_from_slice(HEAD_MAGIC);
    bytes.push(FORMAT_VERSION);
    if !head.legacy_event_table {
        bytes.extend_from_slice(&head.epoch.to_le_bytes());
    }
    bytes.extend_from_slice(&head.base_sequence.to_le_bytes());
    bytes.extend_from_slice(&head.last_sequence.to_le_bytes());
    bytes.extend_from_slice(&head.last_revision.to_le_bytes());
    bytes
}

fn decode_head(bytes: &[u8]) -> Result<Head, EngineError> {
    if bytes.len() < 4 || &bytes[..4] != HEAD_MAGIC {
        return Err(EngineError::Persistence("cabecera de documento MLHD inválida".into()));
    }
    let head = match (bytes.len(), bytes.get(4).copied()) {
        (29, Some(FORMAT_VERSION)) => Head {
            epoch: 0,
            base_sequence: read_u64(bytes, 5)?,
            last_sequence: read_u64(bytes, 13)?,
            last_revision: read_u64(bytes, 21)?,
            legacy_event_table: true,
        },
        (37, Some(FORMAT_VERSION)) => Head {
            epoch: read_u64(bytes, 5)?,
            base_sequence: read_u64(bytes, 13)?,
            last_sequence: read_u64(bytes, 21)?,
            last_revision: read_u64(bytes, 29)?,
            legacy_event_table: false,
        },
        _ => return Err(EngineError::Persistence("cabecera de documento MLHD inválida".into())),
    };
    if head.base_sequence > head.last_sequence {
        return Err(EngineError::Persistence("rango de secuencias MLHD inválido".into()));
    }
    Ok(head)
}

fn encode_event_operations(
    project_id: &str,
    document_id: &str,
    head: Head,
    sequence: u64,
    base_revision: u64,
    start: usize,
    end: usize,
    replacement: &str,
) -> Result<Vec<ProjectOperation>, EngineError> {
    let table = event_table_for_head(document_id, head);
    let chunks = split_utf8(replacement, EVENT_CHUNK_BYTES);
    if chunks.len() > MAX_EVENT_CHUNKS {
        return Err(EngineError::Persistence("el cambio supera el límite durable de 12 MiB".into()));
    }
    let mut operations = Vec::with_capacity(chunks.len());
    for (index, chunk) in chunks.iter().enumerate() {
        let mut value = Vec::with_capacity(chunk.len() + 41);
        if index == 0 {
            value.extend_from_slice(EVENT_MAGIC);
            value.push(FORMAT_VERSION);
            value.extend_from_slice(&base_revision.to_le_bytes());
            value.extend_from_slice(&(start as u64).to_le_bytes());
            value.extend_from_slice(&(end as u64).to_le_bytes());
            value.extend_from_slice(&(replacement.len() as u64).to_le_bytes());
            value.extend_from_slice(&(chunks.len() as u32).to_le_bytes());
        }
        value.extend_from_slice(chunk.as_bytes());
        operations.push(ProjectOperation::Put {
            project_id: project_id.to_owned(),
            table: table.clone(),
            record_id: event_id(sequence, index),
            value,
        });
    }
    Ok(operations)
}

fn split_utf8(value: &str, max_bytes: usize) -> Vec<&str> {
    if value.is_empty() {
        return vec![""];
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < value.len() {
        let mut end = (start + max_bytes).min(value.len());
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(&value[start..end]);
        start = end;
    }
    chunks
}

fn append_durable_change(
    sequence: u64,
    chunks: &BTreeMap<u32, Vec<u8>>,
    last_sequence: u64,
    expected_sequence: &mut u64,
    previous_revision: &mut Option<u64>,
    changes: &mut Vec<DurableDocumentChange>,
) -> Result<(), EngineError> {
    if sequence != *expected_sequence {
        return Err(EngineError::ResynchronizationRequired);
    }
    let (base_revision, start_byte, end_byte, replacement_bytes) =
        decode_event_metadata(chunks)?;
    if previous_revision.is_some_and(|revision| revision != base_revision) {
        return Err(EngineError::ResynchronizationRequired);
    }
    let revision = base_revision.checked_add(1)
        .ok_or(EngineError::CounterExhausted("revision"))?;
    changes.push(DurableDocumentChange {
        sequence, base_revision, revision, start_byte, end_byte, replacement_bytes,
    });
    *previous_revision = Some(revision);
    if sequence != last_sequence {
        *expected_sequence = (*expected_sequence).checked_add(1)
            .ok_or(EngineError::CounterExhausted("sequence"))?;
    }
    Ok(())
}

fn decode_event_metadata(
    chunks: &BTreeMap<u32, Vec<u8>>,
) -> Result<(u64, usize, usize, usize), EngineError> {
    let first = chunks.get(&0)
        .ok_or_else(|| EngineError::Persistence("falta el primer bloque de un evento".into()))?;
    if first.len() < 41 || &first[..4] != EVENT_MAGIC || first[4] != FORMAT_VERSION {
        return Err(EngineError::Persistence("cabecera MLEV inválida".into()));
    }
    let base_revision = read_u64(first, 5)?;
    let start = usize::try_from(read_u64(first, 13)?)
        .map_err(|_| EngineError::Persistence("offset inicial fuera de rango".into()))?;
    let end = usize::try_from(read_u64(first, 21)?)
        .map_err(|_| EngineError::Persistence("offset final fuera de rango".into()))?;
    let expected_len = usize::try_from(read_u64(first, 29)?)
        .map_err(|_| EngineError::Persistence("longitud de reemplazo fuera de rango".into()))?;
    if start > end {
        return Err(EngineError::Persistence("rango MLEV invertido".into()));
    }
    let chunk_count = u32::from_le_bytes(first[37..41].try_into().unwrap()) as usize;
    if chunk_count == 0 || chunk_count > MAX_EVENT_CHUNKS || chunks.len() != chunk_count {
        return Err(EngineError::Persistence("cantidad de bloques MLEV inválida".into()));
    }
    let mut actual_len = 0usize;
    for index in 0..chunk_count {
        let bytes = chunks.get(&(index as u32))
            .ok_or_else(|| EngineError::Persistence("secuencia de bloques MLEV incompleta".into()))?;
        let payload = if index == 0 { &bytes[41..] } else { bytes.as_slice() };
        std::str::from_utf8(payload)
            .map_err(|_| EngineError::Persistence("reemplazo MLEV no es UTF-8".into()))?;
        actual_len = actual_len.checked_add(payload.len())
            .ok_or_else(|| EngineError::Persistence("longitud MLEV fuera de rango".into()))?;
    }
    if actual_len != expected_len {
        return Err(EngineError::Persistence("longitud MLEV no coincide".into()));
    }
    Ok((base_revision, start, end, actual_len))
}

fn decode_event(
    chunks: &BTreeMap<u32, Vec<u8>>,
) -> Result<(u64, usize, usize, String), EngineError> {
    let first = chunks.get(&0)
        .ok_or_else(|| EngineError::Persistence("falta el primer bloque de un evento".into()))?;
    if first.len() < 41 || &first[..4] != EVENT_MAGIC || first[4] != FORMAT_VERSION {
        return Err(EngineError::Persistence("cabecera MLEV inválida".into()));
    }
    let base_revision = read_u64(first, 5)?;
    let start = usize::try_from(read_u64(first, 13)?)
        .map_err(|_| EngineError::Persistence("offset inicial fuera de rango".into()))?;
    let end = usize::try_from(read_u64(first, 21)?)
        .map_err(|_| EngineError::Persistence("offset final fuera de rango".into()))?;
    let expected_len = usize::try_from(read_u64(first, 29)?)
        .map_err(|_| EngineError::Persistence("longitud de reemplazo fuera de rango".into()))?;
    let chunk_count = u32::from_le_bytes(first[37..41].try_into().unwrap()) as usize;
    if chunk_count == 0 || chunk_count > MAX_EVENT_CHUNKS || chunks.len() != chunk_count {
        return Err(EngineError::Persistence("cantidad de bloques MLEV inválida".into()));
    }
    let mut replacement = Vec::with_capacity(expected_len);
    for index in 0..chunk_count {
        let bytes = chunks.get(&(index as u32))
            .ok_or_else(|| EngineError::Persistence("secuencia de bloques MLEV incompleta".into()))?;
        if index == 0 {
            replacement.extend_from_slice(&bytes[41..]);
        } else {
            replacement.extend_from_slice(bytes);
        }
    }
    if replacement.len() != expected_len {
        return Err(EngineError::Persistence("longitud MLEV no coincide".into()));
    }
    let replacement = String::from_utf8(replacement)
        .map_err(|_| EngineError::Persistence("reemplazo MLEV no es UTF-8".into()))?;
    Ok((base_revision, start, end, replacement))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, EngineError> {
    let slice = bytes.get(offset..offset + 8)
        .ok_or_else(|| EngineError::Persistence("registro durable truncado".into()))?;
    Ok(u64::from_le_bytes(slice.try_into().unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_PATH: AtomicU64 = AtomicU64::new(1);

    fn paths() -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "motor-literario-live-{}-{}",
            std::process::id(),
            NEXT_PATH.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&root).unwrap();
        (root.clone(), root.join("store.pages"), root.join("store.mlpj"))
    }

    #[test]
    fn durable_edit_replays_when_host_reopens_with_previous_snapshot() {
        let (root, pages, wal) = paths();
        {
            let mut engine = PersistentLiveEngine::open("book-1", &pages, &wal).unwrap();
            engine.open_document("book-1", "chapter-1", "Hola", 4, 10).unwrap();
            assert_eq!(
                engine.apply_change("book-1", "chapter-1", 11, 4, 4, 4, " mundo").unwrap(),
                ApplyOutcome::Applied { revision: 5, invalidated_suggestions: 0 }
            );
        }
        {
            let mut engine = PersistentLiveEngine::open("book-1", &pages, &wal).unwrap();
            engine.open_document("book-1", "chapter-1", "Hola", 4, 10).unwrap();
            let snapshot = engine.snapshot("book-1", "chapter-1").unwrap();
            assert_eq!(snapshot.text, "Hola mundo");
            assert_eq!(snapshot.revision, 5);
            assert_eq!(snapshot.last_sequence, 11);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn durable_document_history_returns_ordered_revision_and_utf8_deltas() {
        let (root, pages, wal) = paths();
        let mut engine = PersistentLiveEngine::open("book-1", &pages, &wal).unwrap();
        engine.open_document("book-1", "chapter-1", "Hola", 4, 10).unwrap();
        engine.apply_change("book-1", "chapter-1", 11, 4, 0, 0, "🙂").unwrap();
        engine.apply_change("book-1", "chapter-1", 12, 5, 8, 8, "!").unwrap();
        let large_replacement = "ñ".repeat(4_000);
        engine.apply_change(
            "book-1", "chapter-1", 13, 6, 9, 9, &large_replacement,
        ).unwrap();
        let changes = engine.durable_document_changes("book-1", "chapter-1").unwrap();
        assert_eq!(changes, vec![
            DurableDocumentChange {
                sequence: 11, base_revision: 4, revision: 5,
                start_byte: 0, end_byte: 0, replacement_bytes: 4,
            },
            DurableDocumentChange {
                sequence: 12, base_revision: 5, revision: 6,
                start_byte: 8, end_byte: 8, replacement_bytes: 1,
            },
            DurableDocumentChange {
                sequence: 13, base_revision: 6, revision: 7,
                start_byte: 9, end_byte: 9, replacement_bytes: 8_000,
            },
        ]);
        drop(engine);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rope_live_session_preserves_paragraph_extraction_after_wal_recovery() {
        let (root, pages, wal) = paths();
        let original = "Primero.\n\nEl niño llegó.\n\nTercero.";
        let start = original.find("niño").unwrap();
        {
            let mut engine = PersistentLiveEngine::open("book-rope-recovery", &pages, &wal).unwrap();
            engine.open_document("book-rope-recovery", "chapter", original, 0, 0).unwrap();
            assert_eq!(
                engine.apply_change(
                    "book-rope-recovery", "chapter", 1, 0,
                    start, start + "niño".len(), "gato",
                ).unwrap(),
                ApplyOutcome::Applied { revision: 1, invalidated_suggestions: 0 }
            );
            let paragraph = engine.affected_paragraph(
                "book-rope-recovery", "chapter", 1, start, start + 4,
            ).unwrap();
            assert_eq!(paragraph.text, "El gato llegó.");
            let second_start = start + "El gato ".len();
            assert_eq!(
                engine.apply_change(
                    "book-rope-recovery", "chapter", 2, 1,
                    second_start, second_start + "llegó".len(), "entró",
                ).unwrap(),
                ApplyOutcome::Applied { revision: 2, invalidated_suggestions: 0 }
            );
        }
        {
            let mut engine = PersistentLiveEngine::open("book-rope-recovery", &pages, &wal).unwrap();
            engine.open_document("book-rope-recovery", "chapter", original, 0, 0).unwrap();
            let snapshot = engine.snapshot("book-rope-recovery", "chapter").unwrap();
            assert_eq!(snapshot.text, "Primero.\n\nEl gato entró.\n\nTercero.");
            let paragraph = engine.affected_paragraph(
                "book-rope-recovery", "chapter", 2, start, start + 4,
            ).unwrap();
            assert_eq!(paragraph.text, "El gato entró.");
            assert_eq!(paragraph.last_sequence, 2);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn empty_replacement_deletion_replays_after_restart() {
        let (root, pages, wal) = paths();
        {
            let mut engine = PersistentLiveEngine::open("book-delete", &pages, &wal).unwrap();
            engine.open_document("book-delete", "chapter", "abc", 0, 0).unwrap();
            assert!(matches!(
                engine.apply_change("book-delete", "chapter", 1, 0, 1, 2, ""),
                Ok(ApplyOutcome::Applied { revision: 1, .. })
            ));
            assert_eq!(engine.snapshot("book-delete", "chapter").unwrap().text, "ac");
        }
        {
            let mut engine = PersistentLiveEngine::open("book-delete", &pages, &wal).unwrap();
            engine.open_document("book-delete", "chapter", "abc", 0, 0).unwrap();
            let snapshot = engine.snapshot("book-delete", "chapter").unwrap();
            assert_eq!(snapshot.text, "ac");
            assert_eq!(snapshot.revision, 1);
            assert_eq!(snapshot.last_sequence, 1);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn multi_chunk_edit_replays_exact_utf8_text_after_restart() {
        let (root, pages, wal) = paths();
        let replacement = "á界🙂".repeat(2_500);
        {
            let mut engine = PersistentLiveEngine::open("book-1", &pages, &wal).unwrap();
            engine.open_document("book-1", "chapter-1", "", 0, 0).unwrap();
            engine.apply_change(
                "book-1", "chapter-1", 1, 0, 0, 0, &replacement
            ).unwrap();
        }
        {
            let mut engine = PersistentLiveEngine::open("book-1", &pages, &wal).unwrap();
            engine.open_document("book-1", "chapter-1", "", 0, 0).unwrap();
            assert_eq!(
                engine.snapshot("book-1", "chapter-1").unwrap().text,
                replacement
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_replays_only_events_after_an_intermediate_host_snapshot() {
        let (root, pages, wal) = paths();
        {
            let mut engine = PersistentLiveEngine::open("book-1", &pages, &wal).unwrap();
            engine.open_document("book-1", "chapter-1", "A", 0, 0).unwrap();
            engine.apply_change("book-1", "chapter-1", 1, 0, 1, 1, "B").unwrap();
            engine.apply_change("book-1", "chapter-1", 2, 1, 2, 2, "C").unwrap();
        }
        {
            let mut engine = PersistentLiveEngine::open("book-1", &pages, &wal).unwrap();
            engine.open_document("book-1", "chapter-1", "AB", 1, 1).unwrap();
            let snapshot = engine.snapshot("book-1", "chapter-1").unwrap();
            assert_eq!(snapshot.text, "ABC");
            assert_eq!(snapshot.revision, 2);
            assert_eq!(snapshot.last_sequence, 2);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn durable_edit_is_not_reapplied_when_host_snapshot_is_current() {
        let (root, pages, wal) = paths();
        {
            let mut engine = PersistentLiveEngine::open("book-1", &pages, &wal).unwrap();
            engine.open_document("book-1", "chapter-1", "A", 0, 0).unwrap();
            engine.apply_change("book-1", "chapter-1", 1, 0, 1, 1, "B").unwrap();
        }
        {
            let mut engine = PersistentLiveEngine::open("book-1", &pages, &wal).unwrap();
            engine.open_document("book-1", "chapter-1", "AB", 1, 1).unwrap();
            assert_eq!(engine.snapshot("book-1", "chapter-1").unwrap().text, "AB");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn checkpoint_makes_prior_events_unnecessary_for_recovery() {
        let (root, pages, wal) = paths();
        {
            let mut engine = PersistentLiveEngine::open("book-1", &pages, &wal).unwrap();
            engine.open_document("book-1", "chapter-1", "A", 0, 0).unwrap();
            engine.apply_change("book-1", "chapter-1", 1, 0, 1, 1, "B").unwrap();
            engine.checkpoint_document("book-1", "chapter-1", 1, 1).unwrap();
        }
        {
            let mut engine = PersistentLiveEngine::open("book-1", &pages, &wal).unwrap();
            assert_eq!(
                engine.open_document("book-1", "chapter-1", "A", 0, 0),
                Err(EngineError::ResynchronizationRequired)
            );
            engine.open_document("book-1", "chapter-1", "AB", 1, 1).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resynchronization_starts_a_new_event_epoch_when_sequence_restarts() {
        let (root, pages, wal) = paths();
        {
            let mut engine = PersistentLiveEngine::open("book-1", &pages, &wal).unwrap();
            engine.open_document("book-1", "chapter-1", "A", 0, 0).unwrap();
            engine.apply_change("book-1", "chapter-1", 1, 0, 1, 1, "B").unwrap();
            engine.resynchronize_document("book-1", "chapter-1", "X", 10, 0).unwrap();
            engine.apply_change("book-1", "chapter-1", 1, 10, 1, 1, "Y").unwrap();
        }
        {
            let mut engine = PersistentLiveEngine::open("book-1", &pages, &wal).unwrap();
            engine.open_document("book-1", "chapter-1", "X", 10, 0).unwrap();
            let snapshot = engine.snapshot("book-1", "chapter-1").unwrap();
            assert_eq!(snapshot.text, "XY");
            assert_eq!(snapshot.revision, 11);
            assert_eq!(snapshot.last_sequence, 1);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn events_are_isolated_by_host_project() {
        let (root, pages, wal) = paths();
        {
            let mut engine = PersistentLiveEngine::open("book-1", &pages, &wal).unwrap();
            engine.open_document("book-1", "chapter-1", "A", 0, 0).unwrap();
            assert_eq!(
                engine.apply_change("book-2", "chapter-1", 1, 0, 1, 1, "X"),
                Err(EngineError::ProjectNotOpen)
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn same_document_id_isolated_between_projects_in_shared_mldb() {
        let (root, pages, wal) = paths();
        {
            let mut first = PersistentLiveEngine::open("book-private-a", &pages, &wal).unwrap();
            first.open_document("book-private-a", "chapter-1", "A", 0, 0).unwrap();
            first.apply_change("book-private-a", "chapter-1", 1, 0, 1, 1, "secret").unwrap();
        }
        {
            let mut second = PersistentLiveEngine::open("book-private-b", &pages, &wal).unwrap();
            second.open_document("book-private-b", "chapter-1", "B", 0, 0).unwrap();
            assert_eq!(
                second.snapshot("book-private-b", "chapter-1").unwrap().text,
                "B"
            );
        }
        {
            let mut first = PersistentLiveEngine::open("book-private-a", &pages, &wal).unwrap();
            first.open_document("book-private-a", "chapter-1", "A", 0, 0).unwrap();
            assert_eq!(
                first.snapshot("book-private-a", "chapter-1").unwrap().text,
                "Asecret"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_head_replays_and_continues_writing_to_legacy_event_table() {
        let (root, pages, wal) = paths();
        let legacy_head = Head {
            epoch: 0,
            base_sequence: 0,
            last_sequence: 1,
            last_revision: 1,
            legacy_event_table: true,
        };
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            let mut operations = encode_event_operations(
                "book-legacy", "chapter", legacy_head, 1, 0, 1, 1, "B"
            ).unwrap();
            operations.push(ProjectOperation::Put {
                project_id: "book-legacy".into(),
                table: HEAD_TABLE.into(),
                record_id: "chapter".into(),
                value: encode_head(legacy_head),
            });
            store.apply_batch(operations).unwrap();
        }
        {
            let mut engine = PersistentLiveEngine::open("book-legacy", &pages, &wal).unwrap();
            engine.open_document("book-legacy", "chapter", "A", 0, 0).unwrap();
            assert_eq!(engine.snapshot("book-legacy", "chapter").unwrap().text, "AB");
            engine.apply_change("book-legacy", "chapter", 2, 1, 2, 2, "C").unwrap();
        }
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            let bytes = store.get_project("book-legacy", HEAD_TABLE, "chapter").unwrap().unwrap();
            assert_eq!(bytes.len(), 29);
            assert!(decode_head(&bytes).unwrap().legacy_event_table);
        }
        {
            let mut engine = PersistentLiveEngine::open("book-legacy", &pages, &wal).unwrap();
            engine.open_document("book-legacy", "chapter", "A", 0, 0).unwrap();
            assert_eq!(engine.snapshot("book-legacy", "chapter").unwrap().text, "ABC");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn persistent_live_store_rejects_mutation_after_session_lock_replacement() {
        use mldb_storage::bundle::{BundleManifest, BundlePointer, BundlePublicationStore};
        use mldb_storage::interprocess_lock::lock_path_for;
        use mldb_storage::publication::{GenerationReceipt, PublicationPointer};
        use std::os::unix::fs::OpenOptionsExt;

        let (root, _, _) = paths();
        let pointer = BundlePointer::new(1, [0x61; 16], "live-session-project").unwrap();
        let generation = root.join("generations").join(&pointer.generation_dir);
        let live = generation.join("live");
        let knowledge = generation.join("knowledge");
        fs::create_dir_all(&live).unwrap();
        fs::create_dir_all(&knowledge).unwrap();
        let member_pointer = PublicationPointer::new(1, pointer.bundle_id).unwrap();
        for directory in [&live, &knowledge] {
            let mut store = ProjectStore::open(
                directory.join("store.pages"), directory.join("store.mlpj"),
            ).unwrap();
            store.checkpoint().unwrap();
            drop(store);
            GenerationReceipt::create_from_files(directory, &member_pointer).unwrap();
        }
        let live_receipt = fs::read(live.join("GENERATION.MANIFEST")).unwrap();
        let knowledge_receipt = fs::read(knowledge.join("GENERATION.MANIFEST")).unwrap();
        let manifest = BundleManifest::from_receipt_bytes(
            &pointer, &live_receipt, &knowledge_receipt,
        ).unwrap();
        let mut bundle_manifest_options = std::fs::OpenOptions::new();
        bundle_manifest_options.write(true).create_new(true).mode(0o600);
        use std::io::Write;
        let mut bundle_manifest_file = bundle_manifest_options
            .open(generation.join("BUNDLE.MANIFEST")).unwrap();
        bundle_manifest_file.write_all(&manifest.encode().unwrap()).unwrap();
        bundle_manifest_file.sync_all().unwrap();

        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(pointer).unwrap();
        let working = publication.create_working_bundle([0x62; 16]).unwrap();
        let (pages, wal, _, _) = working.paths();
        let session_lock = lock_path_for(
            &pages.parent().unwrap().parent().unwrap().join("SESSION")
        ).unwrap();
        let displaced = session_lock.with_extension("displaced");
        let validator = working.session_lock_validator();
        let mut engine = PersistentLiveEngine::open_existing_with_session_validator(
            "live-session-project", &pages, &wal, validator,
        ).unwrap();
        engine.open_document("live-session-project", "chapter", "A", 0, 0).unwrap();

        fs::rename(&session_lock, &displaced).unwrap();
        let replacement = std::fs::OpenOptions::new()
            .write(true).create_new(true).mode(0o600).open(&session_lock).unwrap();
        replacement.sync_all().unwrap();

        assert!(matches!(
            engine.apply_change("live-session-project", "chapter", 1, 0, 1, 1, "B"),
            Err(EngineError::Persistence(_))
        ));
        assert_eq!(engine.snapshot("live-session-project", "chapter").unwrap().text, "A");

        drop(replacement);
        drop(engine);
        drop(working);
        drop(publication);
        fs::remove_file(&session_lock).unwrap();
        fs::remove_file(&displaced).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn large_utf8_replacement_is_chunked_without_splitting_characters() {
        let replacement = "ñ".repeat(EVENT_CHUNK_BYTES + 20);
        let chunks = split_utf8(&replacement, EVENT_CHUNK_BYTES);
        assert!(chunks.iter().all(|chunk| chunk.len() <= EVENT_CHUNK_BYTES));
        assert_eq!(chunks.concat(), replacement);
        assert!(chunks.len() > 1);
    }
}
