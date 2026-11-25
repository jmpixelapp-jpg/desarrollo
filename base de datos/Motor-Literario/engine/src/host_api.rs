//! Fachada de integración para el programa anfitrión.
//!
//! El anfitrión crea/nombra el proyecto y entrega sus IDs, snapshots y deltas.
//! Esta API no abre archivos del editor, no genera identidades y nunca modifica
//! el texto del anfitrión: únicamente persiste los cambios que este comunica.

use std::path::Path;
use mldb_storage::bundle::WorkingBundle;
use std::sync::{atomic::AtomicBool, Arc};

use crate::persistent::{DurableDocumentChange, PersistentLiveEngine};
use crate::knowledge::{EntityRecord, EvidenceRecord, EvidenceRebaseSummary, EventRecord, FragmentAnalysisRecord, KnowledgeError, NarrativeKnowledgeStore, RelationRecord, IntegrityAuditPage};
use crate::worker::{
    AffectedParagraphTicket, ChangeTicket, LiveEngineWorker, PendingChange, SubmitError, TicketError, WorkerError,
    WorkerMetricsSnapshot,
};
use crate::{AffectedParagraphSnapshot, DocumentSnapshot, EngineError};

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum HostApiError {
    Engine(EngineError),
    Worker(WorkerError),
    Ticket(TicketError),
    Knowledge(KnowledgeError),
    KnowledgeNotConfigured,
    WorkingBundleNotConfigured,
    WorkingBundleSessionInvalid(String),
}

impl From<EngineError> for HostApiError {
    fn from(value: EngineError) -> Self {
        Self::Engine(value)
    }
}

impl From<WorkerError> for HostApiError {
    fn from(value: WorkerError) -> Self {
        Self::Worker(value)
    }
}

impl From<TicketError> for HostApiError {
    fn from(value: TicketError) -> Self {
        Self::Ticket(value)
    }
}

impl From<KnowledgeError> for HostApiError {
    fn from(value: KnowledgeError) -> Self {
        Self::Knowledge(value)
    }
}

/// Delta exacto enviado por el editor anfitrión.
/// Los offsets son bytes UTF-8 del snapshot correspondiente a la revisión base.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditorChange {
    pub document_id: String,
    pub sequence: u64,
    pub base_revision: u64,
    pub start_byte: usize,
    pub end_byte: usize,
    pub replacement: String,
}

impl EditorChange {
    pub fn into_pending(self) -> PendingChange {
        PendingChange::new(
            self.document_id,
            self.sequence,
            self.base_revision,
            self.start_byte,
            self.end_byte,
            self.replacement,
        )
    }
}

/// Punto de entrada del anfitrión al motor durable de monitoreo en vivo.
pub struct HostEngineApi {
    worker: LiveEngineWorker,
    knowledge: Option<NarrativeKnowledgeStore>,
    working_bundle: Option<WorkingBundle>,
}

impl HostEngineApi {
    /// Abre el almacén local para el proyecto nombrado por el anfitrión.
    /// La capacidad de cola debe ser mayor que cero.
    pub fn open(
        host_project_id: impl Into<String>,
        pages_path: impl AsRef<Path>,
        journal_path: impl AsRef<Path>,
        queue_capacity: usize,
    ) -> Result<Self, HostApiError> {
        let engine = PersistentLiveEngine::open(host_project_id, pages_path, journal_path)
            .map_err(HostApiError::Engine)?;
        let worker = LiveEngineWorker::open(engine, queue_capacity)?;
        Ok(Self { worker, knowledge: None, working_bundle: None })
    }

    /// Abre el motor y un almacén narrativo independiente para el mismo proyecto.
    /// Las dos rutas de conocimiento deben ser locales y distintas del diario de edición.
    pub fn open_with_knowledge(
        host_project_id: impl Into<String>,
        pages_path: impl AsRef<Path>,
        journal_path: impl AsRef<Path>,
        queue_capacity: usize,
        knowledge_pages_path: impl AsRef<Path>,
        knowledge_journal_path: impl AsRef<Path>,
    ) -> Result<Self, HostApiError> {
        let paths = [
            pages_path.as_ref(),
            journal_path.as_ref(),
            knowledge_pages_path.as_ref(),
            knowledge_journal_path.as_ref(),
        ];
        for left in 0..paths.len() {
            for right in (left + 1)..paths.len() {
                if paths[left] == paths[right] {
                    return Err(HostApiError::Knowledge(KnowledgeError::Invalid(
                        "cada almacén debe usar rutas de archivo distintas",
                    )));
                }
            }
        }
        let mut api = Self::open(host_project_id, pages_path, journal_path, queue_capacity)?;
        let knowledge = NarrativeKnowledgeStore::open(
            api.project_id().to_owned(),
            knowledge_pages_path,
            knowledge_journal_path,
        )?;
        api.knowledge = Some(knowledge);
        Ok(api)
    }

    /// Abre los dos almacenes de una working bundle y conserva su lock de sesión
    /// mientras el motor anfitrión permanezca activo.
    pub fn open_working_bundle(
        host_project_id: impl Into<String>,
        working_bundle: WorkingBundle,
        queue_capacity: usize,
    ) -> Result<Self, HostApiError> {
        let project_id = host_project_id.into();
        if project_id != working_bundle.project_id() {
            return Err(HostApiError::Knowledge(KnowledgeError::Invalid(
                "project_id del anfitrión no coincide con la working bundle",
            )));
        }
        let (live_pages, live_wal, knowledge_pages, knowledge_wal) = working_bundle.paths();
        let validator = working_bundle.session_lock_validator();
        let mut api = Self::open_existing_with_knowledge_and_validator(
            project_id, &live_pages, &live_wal, queue_capacity, &knowledge_pages, &knowledge_wal,
            Some(validator),
        )?;
        api.working_bundle = Some(working_bundle);
        Ok(api)
    }

    /// Cierra el worker y devuelve la working bundle para su publicación conjunta.
    /// Debe usarse en lugar de publicar mientras HostEngineApi mantiene los archivos abiertos.
    pub fn into_working_bundle(mut self) -> Result<WorkingBundle, HostApiError> {
        if self.working_bundle.is_none() {
            return Err(HostApiError::WorkingBundleNotConfigured);
        }
        self.worker.shutdown()?;
        drop(self.knowledge.take());
        self.working_bundle.take().ok_or(HostApiError::WorkingBundleNotConfigured)
    }

    /// Abre un workspace MLDB existente sin crear archivos ausentes.
    /// Las rutas deben pertenecer a una working copy mutable, nunca a una generación publicada.
    pub fn open_existing(
        host_project_id: impl Into<String>,
        pages_path: impl AsRef<Path>,
        journal_path: impl AsRef<Path>,
        queue_capacity: usize,
    ) -> Result<Self, HostApiError> {
        let engine = PersistentLiveEngine::open_existing(host_project_id, pages_path, journal_path)
            .map_err(HostApiError::Engine)?;
        let worker = LiveEngineWorker::open(engine, queue_capacity)?;
        Ok(Self { worker, knowledge: None, working_bundle: None })
    }

    /// Abre ambos almacenes de una working session ya preparada por el anfitrión.
    /// No crea archivos: si falta cualquiera de los cuatro, falla sin inicializarlo.
    /// Las rutas deben ser workspaces mutables y no pueden apuntar a generaciones publicadas.
    /// Esta apertura no coordina todavía la publicación atómica conjunta de ambos almacenes.
    pub fn open_existing_with_knowledge(
        host_project_id: impl Into<String>,
        pages_path: impl AsRef<Path>,
        journal_path: impl AsRef<Path>,
        queue_capacity: usize,
        knowledge_pages_path: impl AsRef<Path>,
        knowledge_journal_path: impl AsRef<Path>,
    ) -> Result<Self, HostApiError> {
        Self::open_existing_with_knowledge_and_validator(
            host_project_id, pages_path, journal_path, queue_capacity,
            knowledge_pages_path, knowledge_journal_path, None,
        )
    }

    fn open_existing_with_knowledge_and_validator(
        host_project_id: impl Into<String>,
        pages_path: impl AsRef<Path>,
        journal_path: impl AsRef<Path>,
        queue_capacity: usize,
        knowledge_pages_path: impl AsRef<Path>,
        knowledge_journal_path: impl AsRef<Path>,
        validator: Option<mldb_storage::bundle::SessionLockValidator>,
    ) -> Result<Self, HostApiError> {
        let paths = [
            pages_path.as_ref(),
            journal_path.as_ref(),
            knowledge_pages_path.as_ref(),
            knowledge_journal_path.as_ref(),
        ];
        for left in 0..paths.len() {
            for right in (left + 1)..paths.len() {
                if paths[left] == paths[right] {
                    return Err(HostApiError::Knowledge(KnowledgeError::Invalid(
                        "cada almacén debe usar rutas de archivo distintas",
                    )));
                }
            }
        }
        let project_id = host_project_id.into();
        if let Some(validator) = validator.as_ref() {
            validator.validate().map_err(HostApiError::WorkingBundleSessionInvalid)?;
        }
        let knowledge = match validator.clone() {
            Some(session_validator) => NarrativeKnowledgeStore::open_existing_with_session_validator(
                project_id.clone(), knowledge_pages_path, knowledge_journal_path, session_validator,
            )?,
            None => NarrativeKnowledgeStore::open_existing(
                project_id.clone(), knowledge_pages_path, knowledge_journal_path,
            )?,
        };
        let engine = match validator.clone() {
            Some(session_validator) => PersistentLiveEngine::open_existing_with_session_validator(
                project_id, pages_path, journal_path, session_validator,
            ),
            None => PersistentLiveEngine::open_existing(
                project_id, pages_path, journal_path,
            ),
        }.map_err(HostApiError::Engine)?;
        if let Some(validator) = validator.as_ref() {
            validator.validate().map_err(HostApiError::WorkingBundleSessionInvalid)?;
        }
        let worker = LiveEngineWorker::open_with_session_validator(engine, queue_capacity, validator)?;
        Ok(Self { worker, knowledge: Some(knowledge), working_bundle: None })
    }

    /// Solicita la extracción FIFO del párrafo afectado sin bloquear al anfitrión.
    /// El anfitrión consulta el ticket más tarde y puede seguir enviando deltas.
    pub fn request_affected_paragraph(
        &self,
        document_id: impl Into<String>,
        expected_revision: u64,
        selection_start_byte: usize,
        selection_end_byte: usize,
    ) -> Result<AffectedParagraphTicket, HostApiError> {
        self.worker.request_affected_paragraph(
            document_id, expected_revision, selection_start_byte, selection_end_byte,
        ).map_err(HostApiError::Ticket)
    }

    /// Variante cancelable usada por el protocolo de análisis continuo.
    pub fn request_affected_paragraph_cancellable(
        &self,
        document_id: impl Into<String>,
        expected_revision: u64,
        selection_start_byte: usize,
        selection_end_byte: usize,
        cancelled: Arc<AtomicBool>,
    ) -> Result<AffectedParagraphTicket, HostApiError> {
        self.worker.request_affected_paragraph_cancellable(
            document_id, expected_revision, selection_start_byte, selection_end_byte, cancelled,
        ).map_err(HostApiError::Ticket)
    }

    pub fn fragment_analyses_for_document(
        &mut self,
        document_id: &str,
        revision: Option<u64>,
        limit: usize,
    ) -> Result<Vec<FragmentAnalysisRecord>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .fragment_analyses_for_document(document_id, revision, limit)
            .map_err(HostApiError::Knowledge)
    }

    pub fn entity_ids(&mut self) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .entity_ids().map_err(HostApiError::Knowledge)
    }
    pub fn relation_ids(&mut self) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .relation_ids().map_err(HostApiError::Knowledge)
    }
    pub fn event_ids(&mut self) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .event_ids().map_err(HostApiError::Knowledge)
    }
    pub fn evidence_ids(&mut self) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .evidence_ids().map_err(HostApiError::Knowledge)
    }

    pub fn entity_ids_page(&mut self, offset: usize, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .entity_ids_page(offset, limit).map_err(HostApiError::Knowledge)
    }
    pub fn relation_ids_page(&mut self, offset: usize, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .relation_ids_page(offset, limit).map_err(HostApiError::Knowledge)
    }
    pub fn event_ids_page(&mut self, offset: usize, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .event_ids_page(offset, limit).map_err(HostApiError::Knowledge)
    }
    pub fn evidence_ids_page(&mut self, offset: usize, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .evidence_ids_page(offset, limit).map_err(HostApiError::Knowledge)
    }
    pub fn fragment_analysis_ids_page(&mut self, offset: usize, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .fragment_analysis_ids_page(offset, limit).map_err(HostApiError::Knowledge)
    }
    pub fn entity_ids_after(&mut self, after_id: Option<&str>, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .entity_ids_after(after_id, limit).map_err(HostApiError::Knowledge)
    }
    pub fn relation_ids_after(&mut self, after_id: Option<&str>, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .relation_ids_after(after_id, limit).map_err(HostApiError::Knowledge)
    }
    pub fn event_ids_after(&mut self, after_id: Option<&str>, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .event_ids_after(after_id, limit).map_err(HostApiError::Knowledge)
    }
    pub fn evidence_ids_after(&mut self, after_id: Option<&str>, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .evidence_ids_after(after_id, limit).map_err(HostApiError::Knowledge)
    }
    pub fn fragment_analysis_ids_after(&mut self, after_id: Option<&str>, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .fragment_analysis_ids_after(after_id, limit).map_err(HostApiError::Knowledge)
    }

    pub fn entity_ids_for_document(&mut self, document_id: &str) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .entity_ids_for_document(document_id).map_err(HostApiError::Knowledge)
    }
    pub fn relation_ids_for_document(&mut self, document_id: &str) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .relation_ids_for_document(document_id).map_err(HostApiError::Knowledge)
    }
    pub fn event_ids_for_document(&mut self, document_id: &str) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .event_ids_for_document(document_id).map_err(HostApiError::Knowledge)
    }
    pub fn entity_ids_for_document_page(&mut self, document_id: &str, offset: usize, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .entity_ids_for_document_page(document_id, offset, limit).map_err(HostApiError::Knowledge)
    }
    pub fn relation_ids_for_document_page(&mut self, document_id: &str, offset: usize, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .relation_ids_for_document_page(document_id, offset, limit).map_err(HostApiError::Knowledge)
    }
    pub fn event_ids_for_document_page(&mut self, document_id: &str, offset: usize, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .event_ids_for_document_page(document_id, offset, limit).map_err(HostApiError::Knowledge)
    }
    pub fn entity_ids_for_document_after(&mut self, document_id: &str, after_id: Option<&str>, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .entity_ids_for_document_after(document_id, after_id, limit).map_err(HostApiError::Knowledge)
    }
    pub fn relation_ids_for_document_after(&mut self, document_id: &str, after_id: Option<&str>, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .relation_ids_for_document_after(document_id, after_id, limit).map_err(HostApiError::Knowledge)
    }
    pub fn event_ids_for_document_after(&mut self, document_id: &str, after_id: Option<&str>, limit: usize) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .event_ids_for_document_after(document_id, after_id, limit).map_err(HostApiError::Knowledge)
    }

    pub fn evidence_ids_for_document(&mut self, document_id: &str) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .evidence_ids_for_document(document_id).map_err(HostApiError::Knowledge)
    }

    pub fn evidence_ids_for_document_after(
        &mut self, document_id: &str, after_id: Option<&str>, limit: usize,
    ) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .evidence_ids_for_document_after(document_id, after_id, limit)
            .map_err(HostApiError::Knowledge)
    }

    pub fn evidence_ids_for_document_page(
        &mut self, document_id: &str, offset: usize, limit: usize,
    ) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .evidence_ids_for_document_page(document_id, offset, limit)
            .map_err(HostApiError::Knowledge)
    }

    pub fn put_fragment_analysis(&mut self, record: &FragmentAnalysisRecord) -> Result<(), HostApiError> {
        self.validate_working_session()?;
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .put_fragment_analysis(record).map_err(HostApiError::Knowledge)
    }
    pub fn get_fragment_analysis(&mut self, id: &str) -> Result<Option<FragmentAnalysisRecord>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .get_fragment_analysis(id).map_err(HostApiError::Knowledge)
    }
    pub fn delete_fragment_analysis(&mut self, id: &str) -> Result<bool, HostApiError> {
        self.validate_working_session()?;
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .delete_fragment_analysis(id).map_err(HostApiError::Knowledge)
    }
    pub fn fragment_analysis_ids(&mut self) -> Result<Vec<String>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .fragment_analysis_ids().map_err(HostApiError::Knowledge)
    }

    pub fn put_entity(&mut self, record: &EntityRecord) -> Result<(), HostApiError> {
        self.validate_working_session()?;
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .put_entity(record).map_err(HostApiError::Knowledge)
    }
    pub fn get_entity(&mut self, id: &str) -> Result<Option<EntityRecord>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .get_entity(id).map_err(HostApiError::Knowledge)
    }
    pub fn put_relation(&mut self, record: &RelationRecord) -> Result<(), HostApiError> {
        self.validate_working_session()?;
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .put_relation(record).map_err(HostApiError::Knowledge)
    }
    pub fn get_relation(&mut self, id: &str) -> Result<Option<RelationRecord>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .get_relation(id).map_err(HostApiError::Knowledge)
    }
    pub fn put_event(&mut self, record: &EventRecord) -> Result<(), HostApiError> {
        self.validate_working_session()?;
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .put_event(record).map_err(HostApiError::Knowledge)
    }
    pub fn get_event(&mut self, id: &str) -> Result<Option<EventRecord>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .get_event(id).map_err(HostApiError::Knowledge)
    }
    pub(crate) fn knowledge_configured(&self) -> bool {
        self.knowledge.is_some()
    }

    fn validate_working_session(&self) -> Result<(), HostApiError> {
        if let Some(bundle) = self.working_bundle.as_ref() {
            bundle.validate_session_lock().map_err(|error| {
                HostApiError::WorkingBundleSessionInvalid(format!("{error:?}"))
            })?;
        }
        Ok(())
    }

    /// Rebasea evidencias después de confirmar durablemente un delta.
    /// El anfitrión debe invocar deltas en orden de revisión para este documento.
    pub(crate) fn invalidate_document_evidence(&mut self, document_id: &str) -> Result<usize, HostApiError> {
        self.validate_working_session()?;
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .invalidate_document_evidence(document_id).map_err(HostApiError::Knowledge)
    }

    /// Lee el historial durable después de drenar los cambios aceptados.
    pub(crate) fn durable_document_changes(
        &self,
        document_id: &str,
    ) -> Result<Vec<DurableDocumentChange>, HostApiError> {
        self.worker.durable_document_changes(document_id)
            .map_err(HostApiError::Ticket)
    }

    pub(crate) fn rebase_document_evidence_history(
        &mut self,
        document_id: &str,
        target_revision: u64,
        changes: &[DurableDocumentChange],
    ) -> Result<EvidenceRebaseSummary, HostApiError> {
        self.validate_working_session()?;
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .rebase_document_evidence_history(document_id, target_revision, changes)
            .map_err(HostApiError::Knowledge)
    }

    pub(crate) fn rebase_document_evidence(
        &mut self,
        document_id: &str,
        base_revision: u64,
        new_revision: u64,
        change_start: usize,
        change_end: usize,
        replacement_bytes: usize,
    ) -> Result<EvidenceRebaseSummary, HostApiError> {
        self.validate_working_session()?;
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .rebase_document_evidence(
                document_id, base_revision, new_revision,
                change_start, change_end, replacement_bytes,
            ).map_err(HostApiError::Knowledge)
    }

    pub fn put_evidence(&mut self, record: &EvidenceRecord) -> Result<(), HostApiError> {
        self.validate_working_session()?;
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .put_evidence(record).map_err(HostApiError::Knowledge)
    }
    pub fn get_evidence(&mut self, id: &str) -> Result<Option<EvidenceRecord>, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .get_evidence(id).map_err(HostApiError::Knowledge)
    }
    /// Ejecuta una auditoría de integridad de solo lectura sobre una página.
    pub fn audit_knowledge_integrity(
        &mut self,
        table: &str,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<IntegrityAuditPage, HostApiError> {
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .audit_integrity_page(table, after_id, limit).map_err(HostApiError::Knowledge)
    }

    /// Contrasta análisis persistidos con la revisión y los límites UTF-8 del documento vivo.
    /// El cursor pagina el índice derivado del documento; no recorre análisis de otros libros.
    pub fn audit_document_fragment_analyses(
        &mut self,
        document_id: &str,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<IntegrityAuditPage, HostApiError> {
        if limit == 0 || limit > 1_000 {
            return Err(HostApiError::Knowledge(KnowledgeError::Invalid(
                "limit debe estar entre 1 y 1000",
            )));
        }
        let ids = self.knowledge.as_mut()
            .ok_or(HostApiError::KnowledgeNotConfigured)?
            .fragment_analysis_ids_for_document_after(document_id, after_id, limit)
            .map_err(HostApiError::Knowledge)?;
        let scanned = ids.len();
        let next_after = ids.last().cloned();
        let has_more = if scanned == limit {
            let probe = self.knowledge.as_mut()
                .ok_or(HostApiError::KnowledgeNotConfigured)?
                .fragment_analysis_ids_for_document_after(
                    document_id, next_after.as_deref(), 1,
                )
                .map_err(HostApiError::Knowledge)?;
            !probe.is_empty()
        } else {
            false
        };
        let mut issues = Vec::new();
        for id in ids {
            let record = match self.knowledge.as_mut()
                .ok_or(HostApiError::KnowledgeNotConfigured)?
                .get_fragment_analysis(&id)
            {
                Ok(Some(record)) => record,
                Ok(None) => {
                    issues.push(crate::knowledge::IntegrityIssue {
                        table: "fragment_analysis", record_id: id,
                        code: "fragment_analysis_disappeared", target_id: None,
                    });
                    continue;
                }
                Err(KnowledgeError::Corrupt(_)) => {
                    issues.push(crate::knowledge::IntegrityIssue {
                        table: "fragment_analysis", record_id: id,
                        code: "fragment_analysis_malformed_record", target_id: None,
                    });
                    continue;
                }
                Err(error) => return Err(HostApiError::Knowledge(error)),
            };
            if record.document_id != document_id {
                continue;
            }
            let (start_byte, end_byte) = match (
                usize::try_from(record.start_byte),
                usize::try_from(record.end_byte),
            ) {
                (Ok(start), Ok(end)) => (start, end),
                _ => {
                    issues.push(crate::knowledge::IntegrityIssue {
                        table: "fragment_analysis", record_id: id,
                        code: "fragment_analysis_invalid_range", target_id: None,
                    });
                    continue;
                }
            };
            let source_unavailable = record.source_text.is_none();
            let validation = match record.source_text {
                Some(source_text) if !source_text.is_empty() => self.validate_evidence(
                    document_id, record.revision, start_byte, end_byte, source_text,
                ),
                Some(_) | None => self.worker.validate_fragment_anchor(
                    document_id, record.revision, start_byte, end_byte,
                ).map_err(HostApiError::Ticket),
            };
            match validation {
                Ok(()) if source_unavailable => {
                    issues.push(crate::knowledge::IntegrityIssue {
                        table: "fragment_analysis", record_id: id,
                        code: "fragment_analysis_source_unavailable", target_id: None,
                    });
                }
                Ok(()) => {}
                Err(HostApiError::Ticket(TicketError::Engine(
                    EngineError::EvidenceRevisionConflict { .. }
                    | EngineError::AnalysisRevisionConflict { .. }
                ))) => {
                    issues.push(crate::knowledge::IntegrityIssue {
                        table: "fragment_analysis", record_id: id,
                        code: "fragment_analysis_revision_mismatch", target_id: None,
                    });
                }
                Err(HostApiError::Ticket(TicketError::Engine(EngineError::EvidenceExcerptMismatch))) => {
                    issues.push(crate::knowledge::IntegrityIssue {
                        table: "fragment_analysis", record_id: id,
                        code: "fragment_analysis_source_text_mismatch", target_id: None,
                    });
                }
                Err(HostApiError::Ticket(TicketError::Engine(EngineError::InvalidRange))) => {
                    issues.push(crate::knowledge::IntegrityIssue {
                        table: "fragment_analysis", record_id: id,
                        code: "fragment_analysis_invalid_range", target_id: None,
                    });
                }
                Err(HostApiError::Ticket(TicketError::Engine(EngineError::InvalidUtf8Boundary))) => {
                    issues.push(crate::knowledge::IntegrityIssue {
                        table: "fragment_analysis", record_id: id,
                        code: "fragment_analysis_invalid_utf8_boundary", target_id: None,
                    });
                }
                Err(error) => return Err(error),
            }
        }
        Ok(IntegrityAuditPage { issues, scanned, next_after, has_more })
    }

    /// Contrasta una página de citas con la revisión viva del documento.
    /// Es una auditoría explícita: usa validación por rango y no copia el manuscrito.
    pub fn audit_document_evidence(
        &mut self,
        document_id: &str,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<IntegrityAuditPage, HostApiError> {
        if limit == 0 || limit > 1_000 {
            return Err(HostApiError::Knowledge(KnowledgeError::Invalid(
                "limit debe estar entre 1 y 1000",
            )));
        }
        let ids = self.knowledge.as_mut()
            .ok_or(HostApiError::KnowledgeNotConfigured)?
            .evidence_ids_for_document_after(document_id, after_id, limit)
            .map_err(HostApiError::Knowledge)?;
        let scanned = ids.len();
        let next_after = ids.last().cloned();
        let has_more = if scanned == limit {
            let probe = self.knowledge.as_mut()
                .ok_or(HostApiError::KnowledgeNotConfigured)?
                .evidence_ids_for_document_after(
                    document_id, next_after.as_deref(), 1,
                )
                .map_err(HostApiError::Knowledge)?;
            !probe.is_empty()
        } else {
            false
        };
        let mut issues = Vec::new();

        for id in ids {
            let record = self.knowledge.as_mut()
                .ok_or(HostApiError::KnowledgeNotConfigured)?
                .get_evidence(&id)
                .map_err(HostApiError::Knowledge)?;
            let Some(record) = record else {
                issues.push(crate::knowledge::IntegrityIssue {
                    table: "evidence", record_id: id, code: "evidence_disappeared",
                    target_id: None,
                });
                continue;
            };
            if record.document_id != document_id {
                issues.push(crate::knowledge::IntegrityIssue {
                    table: "evidence", record_id: id, code: "evidence_document_index_mismatch",
                    target_id: None,
                });
                continue;
            }
            if record.stale {
                issues.push(crate::knowledge::IntegrityIssue {
                    table: "evidence", record_id: id, code: "evidence_anchor_stale",
                    target_id: None,
                });
                continue;
            }
            let start = usize::try_from(record.start_byte)
                .map_err(|_| HostApiError::Knowledge(KnowledgeError::Corrupt("offset de evidencia fuera de rango")))?;
            let end = usize::try_from(record.end_byte)
                .map_err(|_| HostApiError::Knowledge(KnowledgeError::Corrupt("offset de evidencia fuera de rango")))?;
            match self.validate_evidence(
                document_id, record.revision, start, end, record.excerpt.clone(),
            ) {
                Ok(()) => {}
                Err(HostApiError::Ticket(TicketError::Engine(EngineError::EvidenceRevisionConflict { .. }))) => {
                    issues.push(crate::knowledge::IntegrityIssue {
                        table: "evidence", record_id: id, code: "evidence_revision_mismatch",
                        target_id: None,
                    });
                }
                Err(HostApiError::Ticket(TicketError::Engine(EngineError::EvidenceExcerptMismatch))) => {
                    issues.push(crate::knowledge::IntegrityIssue {
                        table: "evidence", record_id: id, code: "evidence_excerpt_mismatch",
                        target_id: None,
                    });
                }
                Err(HostApiError::Ticket(TicketError::Engine(EngineError::InvalidRange | EngineError::InvalidUtf8Boundary))) => {
                    issues.push(crate::knowledge::IntegrityIssue {
                        table: "evidence", record_id: id, code: "invalid_evidence_anchor",
                        target_id: None,
                    });
                }
                Err(error) => return Err(error),
            }
        }
        Ok(IntegrityAuditPage { issues, scanned, next_after, has_more })
    }

    pub fn delete_evidence(&mut self, id: &str) -> Result<bool, HostApiError> {
        self.validate_working_session()?;
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .delete_evidence(id).map_err(HostApiError::Knowledge)
    }
    pub fn delete_entity(&mut self, id: &str) -> Result<bool, HostApiError> {
        self.validate_working_session()?;
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .delete_entity(id).map_err(HostApiError::Knowledge)
    }
    pub fn delete_relation(&mut self, id: &str) -> Result<bool, HostApiError> {
        self.validate_working_session()?;
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .delete_relation(id).map_err(HostApiError::Knowledge)
    }
    pub fn delete_event(&mut self, id: &str) -> Result<bool, HostApiError> {
        self.validate_working_session()?;
        self.knowledge.as_mut().ok_or(HostApiError::KnowledgeNotConfigured)?
            .delete_event(id).map_err(HostApiError::Knowledge)
    }

    /// Identidad inmutable del proyecto activo, aportada por el anfitrión.
    pub fn project_id(&self) -> &str {
        self.worker.project_id()
    }

    /// Abre un documento usando el snapshot autoritativo del anfitrión.
    pub fn open_document(
        &self,
        host_document_id: impl Into<String>,
        authoritative_text: impl Into<String>,
        revision: u64,
        sequence: u64,
    ) -> Result<(), HostApiError> {
        self.worker.open_document(
            host_document_id,
            authoritative_text,
            revision,
            sequence,
        ).map_err(HostApiError::Ticket)
    }

    /// Ruta caliente para cada evento del editor: no espera al disco.
    ///
    /// Si devuelve QueueFull o WorkerStopped, el anfitrión recibe el delta
    /// original y debe conservarlo/reintentarlo antes de enviar secuencias
    /// posteriores. Si lo acepta, el ticket permite observar su COMMIT durable.
    pub fn on_editor_change(
        &self,
        change: EditorChange,
    ) -> Result<ChangeTicket, SubmitError> {
        self.worker.try_submit_change(change.into_pending())
    }

    /// Barrera FIFO: snapshot del motor después de todos los deltas ya encolados.
    pub fn snapshot(
        &self,
        host_document_id: impl Into<String>,
    ) -> Result<DocumentSnapshot, HostApiError> {
        self.worker.snapshot(host_document_id).map_err(HostApiError::Ticket)
    }

    /// Devuelve solo el párrafo de la revisión confirmada, mediante una barrera FIFO.
    pub fn affected_paragraph(
        &self,
        host_document_id: impl Into<String>,
        expected_revision: u64,
        selection_start_byte: usize,
        selection_end_byte: usize,
    ) -> Result<AffectedParagraphSnapshot, HostApiError> {
        self.worker.affected_paragraph(
            host_document_id, expected_revision, selection_start_byte, selection_end_byte,
        ).map_err(HostApiError::Ticket)
    }

    /// Verifica offsets y extracto contra la revisión viva sin copiar el manuscrito.
    pub fn validate_evidence(
        &self,
        host_document_id: impl Into<String>,
        expected_revision: u64,
        start_byte: usize,
        end_byte: usize,
        excerpt: impl Into<String>,
    ) -> Result<(), HostApiError> {
        self.worker.validate_evidence(
            host_document_id, expected_revision, start_byte, end_byte, excerpt,
        ).map_err(HostApiError::Ticket)
    }

    /// Comprueba si el fragmento analizado sigue vigente sin clonar el documento.
    pub fn fragment_matches(
        &self,
        host_document_id: impl Into<String>,
        expected_revision: u64,
        expected_sequence: u64,
        start_byte: usize,
        end_byte: usize,
        expected_text: impl Into<String>,
    ) -> Result<(u64, u64, bool), HostApiError> {
        self.worker.fragment_matches(
            host_document_id,
            expected_revision,
            expected_sequence,
            start_byte,
            end_byte,
            expected_text,
        ).map_err(HostApiError::Ticket)
    }

    /// Recupera la sesión con el snapshot autoritativo actual del anfitrión.
    pub fn resynchronize(
        &self,
        host_document_id: impl Into<String>,
        authoritative_text: impl Into<String>,
        revision: u64,
        sequence: u64,
    ) -> Result<(), HostApiError> {
        self.worker.resynchronize_document(
            host_document_id,
            authoritative_text,
            revision,
            sequence,
        ).map_err(HostApiError::Ticket)
    }

    /// Registrar únicamente después de que el anfitrión haya guardado el snapshot.
    pub fn acknowledge_host_save(
        &self,
        host_document_id: impl Into<String>,
        saved_revision: u64,
        saved_sequence: u64,
    ) -> Result<(), HostApiError> {
        self.worker.checkpoint_document(
            host_document_id,
            saved_revision,
            saved_sequence,
        ).map_err(HostApiError::Ticket)
    }

    pub fn close_document(
        &self,
        host_document_id: impl Into<String>,
    ) -> Result<(), HostApiError> {
        self.worker.close_document(host_document_id).map_err(HostApiError::Ticket)
    }

    pub fn pending_changes(&self) -> usize {
        self.worker.pending_changes()
    }

    pub fn metrics(&self) -> WorkerMetricsSnapshot {
        self.worker.metrics()
    }

    /// Drena todos los eventos aceptados y espera el cierre del hilo de escritura.
    pub fn shutdown(&mut self) -> Result<(), WorkerError> {
        self.worker.shutdown()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_PATH: AtomicU64 = AtomicU64::new(1);

    fn paths() -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "motor-literario-host-api-{}-{}",
            std::process::id(),
            NEXT_PATH.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&root).unwrap();
        (root.clone(), root.join("store.pages"), root.join("store.mlpj"))
    }

    #[test]
    fn host_api_owns_working_bundle_until_worker_shutdown_and_joint_publication() {
        use mldb_storage::bundle::{BundleManifest, BundlePointer, BundlePublicationStore};
        use mldb_storage::publication::{GenerationReceipt, PublicationPointer,};
        use mldb_storage::project_store::ProjectStore;

        let (root, _, _) = paths();
        let pointer = BundlePointer::new(1, [0x41; 16], "host-bundle-project").unwrap();
        let generation = root.join("generations").join(&pointer.generation_dir);
        let live_dir = generation.join("live");
        let knowledge_dir = generation.join("knowledge");
        fs::create_dir_all(&live_dir).unwrap();
        fs::create_dir_all(&knowledge_dir).unwrap();
        let member_pointer = PublicationPointer::new(1, pointer.bundle_id).unwrap();
        for directory in [&live_dir, &knowledge_dir] {
            let mut store = ProjectStore::open(
                directory.join("store.pages"), directory.join("store.mlpj"),
            ).unwrap();
            store.checkpoint().unwrap();
            drop(store);
            GenerationReceipt::create_from_files(directory, &member_pointer).unwrap();
        }
        let live_receipt = fs::read(live_dir.join("GENERATION.MANIFEST")).unwrap();
        let knowledge_receipt = fs::read(knowledge_dir.join("GENERATION.MANIFEST")).unwrap();
        let manifest = BundleManifest::from_receipt_bytes(
            &pointer, &live_receipt, &knowledge_receipt,
        ).unwrap();
        fs::write(generation.join("BUNDLE.MANIFEST"), manifest.encode().unwrap()).unwrap();

        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(pointer).unwrap();
        let working = publication.create_working_bundle([0x42; 16]).unwrap();
        let mut api = HostEngineApi::open_working_bundle(
            "host-bundle-project", working, 8,
        ).unwrap();
        api.open_document("chapter-1", "Texto", 0, 0).unwrap();
        let ticket = api.on_editor_change(EditorChange {
            document_id: "chapter-1".into(),
            sequence: 1,
            base_revision: 0,
            start_byte: 5,
            end_byte: 5,
            replacement: " vivo".into(),
        }).unwrap();
        assert!(matches!(
            ticket.wait().unwrap(),
            crate::ApplyOutcome::Applied { revision: 1, .. }
        ));

        let working = api.into_working_bundle().unwrap();
        let published = publication.publish_working_bundle(working, [0x43; 16]).unwrap();
        assert_eq!(published.generation, 2);
        assert_eq!(publication.current(), Some(&published));
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn replaced_working_session_lock_rejects_live_and_knowledge_mutations() {
        use mldb_storage::bundle::{BundleManifest, BundlePointer, BundlePublicationStore};
        use mldb_storage::interprocess_lock::lock_path_for;
        use mldb_storage::publication::{GenerationReceipt, PublicationPointer};
        use mldb_storage::project_store::ProjectStore;
        use std::os::unix::fs::OpenOptionsExt;

        let (root, _, _) = paths();
        let pointer = BundlePointer::new(1, [0x51; 16], "session-lock-project").unwrap();
        let generation = root.join("generations").join(&pointer.generation_dir);
        let live_dir = generation.join("live");
        let knowledge_dir = generation.join("knowledge");
        fs::create_dir_all(&live_dir).unwrap();
        fs::create_dir_all(&knowledge_dir).unwrap();
        let member_pointer = PublicationPointer::new(1, pointer.bundle_id).unwrap();
        for directory in [&live_dir, &knowledge_dir] {
            let mut store = ProjectStore::open(
                directory.join("store.pages"), directory.join("store.mlpj"),
            ).unwrap();
            store.checkpoint().unwrap();
            drop(store);
            GenerationReceipt::create_from_files(directory, &member_pointer).unwrap();
        }
        let live_receipt = fs::read(live_dir.join("GENERATION.MANIFEST")).unwrap();
        let knowledge_receipt = fs::read(knowledge_dir.join("GENERATION.MANIFEST")).unwrap();
        let manifest = BundleManifest::from_receipt_bytes(
            &pointer, &live_receipt, &knowledge_receipt,
        ).unwrap();
        fs::write(generation.join("BUNDLE.MANIFEST"), manifest.encode().unwrap()).unwrap();

        let publication = BundlePublicationStore::open(&root).unwrap();
        let working = publication.create_working_bundle([0x52; 16]).unwrap();
        let (live_pages, _, _, _) = working.paths();
        let session_lock = lock_path_for(
            &live_pages.parent().unwrap().parent().unwrap().join("SESSION")
        ).unwrap();
        let displaced = session_lock.with_extension("displaced");
        let mut api = HostEngineApi::open_working_bundle(
            "session-lock-project", working, 8,
        ).unwrap();
        api.open_document("chapter", "A", 0, 0).unwrap();
        api.on_editor_change(EditorChange {
            document_id: "chapter".into(), sequence: 1, base_revision: 0,
            start_byte: 1, end_byte: 1, replacement: "B".into(),
        }).unwrap().wait().unwrap();

        fs::rename(&session_lock, &displaced).unwrap();
        let replacement = std::fs::OpenOptions::new()
            .write(true).create_new(true).mode(0o600).open(&session_lock).unwrap();
        replacement.sync_all().unwrap();

        let entity = EntityRecord {
            id: "entity-1".into(), canonical_name: "No debe guardarse".into(),
            entity_type: "character".into(), attributes: vec![],
            status: crate::RecordStatus::Proposed,
        };
        // La capa narrativa también debe rechazar la escritura directa,
        // incluso si se evita el método de conveniencia de HostEngineApi.
        assert!(matches!(
            api.knowledge.as_mut().unwrap().put_entity(&entity),
            Err(KnowledgeError::Storage(_))
        ));
        assert!(matches!(
            api.put_entity(&entity),
            Err(HostApiError::WorkingBundleSessionInvalid(_))
        ));
        assert_eq!(api.get_entity(&entity.id).unwrap(), None);
        let ticket = api.on_editor_change(EditorChange {
            document_id: "chapter".into(), sequence: 2, base_revision: 1,
            start_byte: 2, end_byte: 2, replacement: "C".into(),
        }).unwrap();
        assert!(matches!(
            ticket.wait(),
            Err(TicketError::Engine(EngineError::Persistence(_)))
        ));
        assert_eq!(api.snapshot("chapter").unwrap().text, "AB");

        drop(replacement);
        drop(api);
        fs::remove_file(&session_lock).unwrap();
        fs::remove_file(&displaced).unwrap();
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn host_api_accepts_editor_deltas_and_reports_durable_snapshot() {
        let (root, pages, journal) = paths();
        let mut api = HostEngineApi::open("host-created-project-42", &pages, &journal, 8).unwrap();
        assert_eq!(api.project_id(), "host-created-project-42");
        api.open_document("host-created-chapter-9", "El inicio", 3, 20).unwrap();

        let ticket = api.on_editor_change(EditorChange {
            document_id: "host-created-chapter-9".into(),
            sequence: 21,
            base_revision: 3,
            start_byte: 10,
            end_byte: 10,
            replacement: " continúa".into(),
        }).unwrap();

        assert!(matches!(
            ticket.wait().unwrap(),
            crate::ApplyOutcome::Applied { revision: 4, .. }
        ));
        let snapshot = api.snapshot("host-created-chapter-9").unwrap();
        assert_eq!(snapshot.text, "El inicio continúa");
        assert_eq!(snapshot.revision, 4);
        assert_eq!(snapshot.last_sequence, 21);
        assert_eq!(api.metrics().durable_commits, 1);
        api.shutdown().unwrap();
        drop(api);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn open_existing_with_knowledge_does_not_recreate_missing_workspace_files() {
        let (root, pages, journal) = paths();
        let knowledge_pages = root.join("knowledge.pages");
        let knowledge_journal = root.join("knowledge.wal");
        {
            let mut api = HostEngineApi::open_with_knowledge(
                "host-existing-workspace", &pages, &journal, 4,
                &knowledge_pages, &knowledge_journal,
            ).unwrap();
            api.shutdown().unwrap();
        }
        fs::remove_file(&knowledge_journal).unwrap();
        let result = HostEngineApi::open_existing_with_knowledge(
            "host-existing-workspace", &pages, &journal, 4,
            &knowledge_pages, &knowledge_journal,
        );
        assert!(result.is_err());
        assert!(!knowledge_journal.exists());
        assert!(pages.exists());
        assert!(journal.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn open_existing_live_workspace_does_not_create_missing_files() {
        let (root, pages, journal) = paths();
        {
            let mut api = HostEngineApi::open(
                "host-existing-live-workspace", &pages, &journal, 4,
            ).unwrap();
            api.shutdown().unwrap();
        }
        fs::remove_file(&pages).unwrap();
        let result = HostEngineApi::open_existing(
            "host-existing-live-workspace", &pages, &journal, 4,
        );
        assert!(result.is_err());
        assert!(!pages.exists());
        assert!(journal.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn knowledge_store_rejects_path_collision_with_live_journal() {
        let (root, pages, journal) = paths();
        let result = HostEngineApi::open_with_knowledge(
            "host-project-path-collision", &pages, &journal, 4, &pages, root.join("knowledge.wal"),
        );
        assert!(matches!(
            result,
            Err(HostApiError::Knowledge(KnowledgeError::Invalid(_)))
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn host_api_exposes_project_scoped_narrative_records() {
        let (root, pages, journal) = paths();
        let mut api = HostEngineApi::open_with_knowledge(
            "host-project-knowledge", &pages, &journal, 4,
            root.join("knowledge.pages"), root.join("knowledge.wal"),
        ).unwrap();
        let entity = EntityRecord {
            id: "person-1".into(), canonical_name: "Clara".into(),
            entity_type: "character".into(), attributes: vec![],
            status: crate::RecordStatus::Proposed,
        };
        api.put_entity(&entity).unwrap();
        assert_eq!(api.get_entity(&entity.id).unwrap(), Some(entity));
        api.shutdown().unwrap();
        drop(api);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn host_save_acknowledgement_releases_replay_history() {
        let (root, pages, journal) = paths();
        {
            let api = HostEngineApi::open("host-project", &pages, &journal, 4).unwrap();
            api.open_document("chapter", "A", 0, 0).unwrap();
            api.on_editor_change(EditorChange {
                document_id: "chapter".into(),
                sequence: 1,
                base_revision: 0,
                start_byte: 1,
                end_byte: 1,
                replacement: "B".into(),
            }).unwrap().wait().unwrap();
            api.acknowledge_host_save("chapter", 1, 1).unwrap();
        }
        {
            let api = HostEngineApi::open("host-project", &pages, &journal, 4).unwrap();
            api.open_document("chapter", "AB", 1, 1).unwrap();
            assert_eq!(api.snapshot("chapter").unwrap().text, "AB");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn host_api_checks_fragment_freshness_without_returning_document_snapshot() {
        let (root, pages, journal) = paths();
        let api = HostEngineApi::open("host-fragment-validation", &pages, &journal, 8).unwrap();
        api.open_document("chapter", "El niño llegó.", 3, 20).unwrap();

        assert_eq!(
            api.fragment_matches("chapter", 3, 20, 3, 8, "niño").unwrap(),
            (3, 20, true),
        );
        assert_eq!(
            api.fragment_matches("chapter", 3, 20, 3, 8, "nino").unwrap(),
            (3, 20, false),
        );

        api.on_editor_change(EditorChange {
            document_id: "chapter".into(),
            sequence: 21,
            base_revision: 3,
            start_byte: 16,
            end_byte: 16,
            replacement: " Ahora.".into(),
        }).unwrap().wait().unwrap();

        assert_eq!(
            api.fragment_matches("chapter", 3, 20, 3, 8, "niño").unwrap(),
            (4, 21, false),
        );
        api.shutdown().unwrap();
        drop(api);
        fs::remove_dir_all(root).unwrap();
    }

}
