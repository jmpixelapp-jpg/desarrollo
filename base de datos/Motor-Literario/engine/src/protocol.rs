//! Protocolo JSON-RPC 2.0 de una solicitud por línea.
//!
//! Este módulo valida/ejecuta solicitudes y produce una respuesta JSON.
//! main.rs proporciona el transporte local stdio JSON-lines.
//! editor_change responde tras encolar; poll_commit consulta la durabilidad.

use std::collections::{BTreeMap, VecDeque};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use crate::host_api::{EditorChange, HostApiError, HostEngineApi};
use crate::knowledge::{EntityRecord, EvidenceRecord, EvidenceTarget, EventRecord, FragmentAnalysisRecord, RecordStatus, RelationRecord, RepeatedWordRecord};
use crate::linguistic::{analyze_fragment, analyze_fragment_cancellable, tokenize_words, FragmentMetrics};
use crate::proofreading::{review_fragment, review_fragment_cancellable};
use crate::json::{self, JsonValue};
use crate::worker::{AffectedParagraphTicket, ChangeTicket, SubmitError, TicketError, WorkerError};
use crate::{ApplyOutcome, EngineError};

const JSON_RPC_VERSION: &str = "2.0";
const ERROR_PARSE: i64 = -32700;
const ERROR_INVALID_REQUEST: i64 = -32600;
const ERROR_METHOD_NOT_FOUND: i64 = -32601;
const ERROR_INVALID_PARAMS: i64 = -32602;
const ERROR_NOT_INITIALIZED: i64 = -32010;
const ERROR_ALREADY_INITIALIZED: i64 = -32011;
const ERROR_QUEUE_FULL: i64 = -32020;
const ERROR_WORKER_STOPPED: i64 = -32021;
const ERROR_ENGINE: i64 = -32030;
const ERROR_REVISION_CONFLICT: i64 = -32031;
const ERROR_TICKET_NOT_FOUND: i64 = -32040;
const ERROR_TICKET_LIMIT: i64 = -32041;
const ERROR_RESPONSE_TOO_LARGE: i64 = -32050;
const MAX_PENDING_TICKETS: usize = 4_096;
// Límite total de trabajos admitidos, incluidos los que esperan en la cola.
const MAX_PENDING_ANALYSIS_JOBS: usize = 4;
const ANALYSIS_WORKER_THREADS: usize = 2;
const ANALYSIS_CANCELLED_STALE: &str = "analysis_cancelled_superseded_by_edit";
const MAX_FRAGMENT_ANALYSIS_BYTES: usize = 512 * 1024;
const MAX_EVIDENCE_EXCERPT_BYTES: usize = 1024 * 1024;
const MAX_TOKEN_RESPONSE_ITEMS: usize = 50_000;
const MAX_ANALYSIS_SAMPLES: usize = 256;
const MAX_ANALYSIS_CACHE_ENTRIES: usize = 128;
const MAX_ANALYSIS_CACHE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
struct ProtocolFault {
    code: i64,
    message: String,
    data: Option<JsonValue>,
}

impl ProtocolFault {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), data: None }
    }

    fn with_data(mut self, data: JsonValue) -> Self {
        self.data = Some(data);
        self
    }
}

struct AnalysisJobResult {
    snapshot: crate::AffectedParagraphSnapshot,
    metrics: FragmentMetrics,
    diagnostics: Vec<crate::proofreading::TextDiagnostic>,
    extraction_micros: u64,
    analysis_micros: u64,
    cache_hit: bool,
}

type AnalysisCacheKey = (String, String, usize, String);

#[derive(Default)]
struct AnalysisCache {
    entries: BTreeMap<AnalysisCacheKey, FragmentMetrics>,
    insertion_order: VecDeque<AnalysisCacheKey>,
    entry_weights: BTreeMap<AnalysisCacheKey, usize>,
    cached_bytes: usize,
    in_flight: std::collections::BTreeSet<AnalysisCacheKey>,
    waiters: usize,
}

impl AnalysisCache {
    fn get(&self, key: &AnalysisCacheKey) -> Option<FragmentMetrics> {
        self.entries.get(key).cloned()
    }

    fn estimated_entry_bytes(key: &AnalysisCacheKey, metrics: &FragmentMetrics) -> usize {
        let repeated_word_bytes = metrics.repeated_words.iter().fold(0usize, |total, word| {
            total.saturating_add(word.normalized.len()).saturating_add(64)
        });
        key.0.len()
            .saturating_add(key.1.len())
            .saturating_add(key.3.len())
            .saturating_add(repeated_word_bytes)
            .saturating_add(256)
    }

    fn remove_oldest(&mut self) {
        if let Some(oldest) = self.insertion_order.pop_front() {
            self.entries.remove(&oldest);
            if let Some(weight) = self.entry_weights.remove(&oldest) {
                self.cached_bytes = self.cached_bytes.saturating_sub(weight);
            }
        }
    }

    fn insert(&mut self, key: AnalysisCacheKey, metrics: FragmentMetrics) {
        if self.entries.contains_key(&key) {
            if let Some(weight) = self.entry_weights.remove(&key) {
                self.cached_bytes = self.cached_bytes.saturating_sub(weight);
            }
            self.entries.insert(key.clone(), metrics.clone());
            let weight = Self::estimated_entry_bytes(&key, &metrics);
            self.cached_bytes = self.cached_bytes.saturating_add(weight);
            self.entry_weights.insert(key, weight);
            while self.cached_bytes > MAX_ANALYSIS_CACHE_BYTES {
                self.remove_oldest();
            }
            return;
        }

        let weight = Self::estimated_entry_bytes(&key, &metrics);
        // Una sola entrada grande no debe desplazar toda la caché ni exceder
        // el presupuesto: se devuelve el cálculo, pero no se conserva.
        if weight > MAX_ANALYSIS_CACHE_BYTES {
            return;
        }
        while self.entries.len() >= MAX_ANALYSIS_CACHE_ENTRIES
            || self.cached_bytes.saturating_add(weight) > MAX_ANALYSIS_CACHE_BYTES
        {
            if self.insertion_order.is_empty() {
                break;
            }
            self.remove_oldest();
        }
        self.insertion_order.push_back(key.clone());
        self.entries.insert(key.clone(), metrics);
        self.entry_weights.insert(key, weight);
        self.cached_bytes = self.cached_bytes.saturating_add(weight);
    }

    /// Single-flight: para una clave solo un hilo calcula; los demás esperan
    /// y reutilizan el resultado publicado. El cálculo nunca mantiene el mutex.
    fn get_or_compute<F>(
        shared: &Arc<(Mutex<Self>, Condvar)>,
        key: AnalysisCacheKey,
        compute: F,
    ) -> Result<(FragmentMetrics, bool), String>
    where
        F: FnOnce() -> FragmentMetrics,
    {
        let mut compute = Some(compute);
        loop {
            let (mutex, ready) = &**shared;
            let mut cache = mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(metrics) = cache.get(&key) {
                return Ok((metrics, true));
            }

            if cache.in_flight.insert(key.clone()) {
                drop(cache);
                let calculated = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                    compute.take().expect("el cálculo solo se consume una vez"),
                ));
                let mut cache = mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                cache.in_flight.remove(&key);
                match calculated {
                    Ok(metrics) => {
                        cache.insert(key, metrics.clone());
                        ready.notify_all();
                        return Ok((metrics, false));
                    }
                    Err(_) => {
                        ready.notify_all();
                        return Err("falló el cálculo de métricas del fragmento".to_owned());
                    }
                }
            }

            cache.waiters += 1;
            let mut cache = match ready.wait(cache) {
                Ok(cache) => cache,
                Err(poisoned) => poisoned.into_inner(),
            };
            cache.waiters = cache.waiters.saturating_sub(1);
        }
    }

    /// Single-flight cancelable. Los propietarios interrumpen el cálculo y los
    /// demás solicitantes abandonan la espera en intervalos cortos si quedan obsoletos.
    fn get_or_compute_cancellable<F>(
        shared: &Arc<(Mutex<Self>, Condvar)>,
        key: AnalysisCacheKey,
        cancelled: &AtomicBool,
        compute: F,
    ) -> Result<(FragmentMetrics, bool), String>
    where
        F: FnOnce() -> Option<FragmentMetrics>,
    {
        let mut compute = Some(compute);
        loop {
            if cancelled.load(Ordering::Acquire) {
                return Err(ANALYSIS_CANCELLED_STALE.to_owned());
            }
            let (mutex, ready) = &**shared;
            let mut cache = mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(metrics) = cache.get(&key) {
                return Ok((metrics, true));
            }

            if cache.in_flight.insert(key.clone()) {
                drop(cache);
                let calculated = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                    compute.take().expect("el cálculo solo se consume una vez"),
                ));
                let mut cache = mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                cache.in_flight.remove(&key);
                match calculated {
                    Ok(Some(metrics)) if !cancelled.load(Ordering::Acquire) => {
                        cache.insert(key, metrics.clone());
                        ready.notify_all();
                        return Ok((metrics, false));
                    }
                    Ok(_) => {
                        ready.notify_all();
                        return Err(ANALYSIS_CANCELLED_STALE.to_owned());
                    }
                    Err(_) => {
                        ready.notify_all();
                        return Err("falló el cálculo de métricas del fragmento".to_owned());
                    }
                }
            }

            cache.waiters += 1;
            let waited = ready.wait_timeout(cache, Duration::from_millis(10));
            let mut cache = match waited {
                Ok((cache, _)) => cache,
                Err(poisoned) => poisoned.into_inner().0,
            };
            cache.waiters = cache.waiters.saturating_sub(1);
        }
    }
}

struct AnalysisJobTicket {
    receiver: Receiver<Result<AnalysisJobResult, String>>,
    cancelled: Arc<AtomicBool>,
    document_id: String,
    expected_revision: u64,
}

type AnalysisTask = Box<dyn FnOnce() + Send + 'static>;

struct QueuedAnalysisTask {
    cancelled: Arc<AtomicBool>,
    task: AnalysisTask,
}

#[derive(Default)]
struct AnalysisQueue {
    tasks: VecDeque<QueuedAnalysisTask>,
    closed: bool,
}

#[derive(Clone, Copy)]
enum AnalysisSubmitError {
    Full,
    Closed,
}

/// Cola acotada cancelable y grupo fijo de trabajadores. A diferencia de
/// sync_channel, permite retirar tareas obsoletas que todavía no comenzaron.
struct AnalysisExecutor {
    queue: Arc<(Mutex<AnalysisQueue>, Condvar)>,
    workers: Vec<thread::JoinHandle<()>>,
}

impl AnalysisExecutor {
    fn new() -> Self {
        let queue = Arc::new((Mutex::new(AnalysisQueue::default()), Condvar::new()));
        let mut workers = Vec::with_capacity(ANALYSIS_WORKER_THREADS);
        for index in 0..ANALYSIS_WORKER_THREADS {
            let queue = Arc::clone(&queue);
            workers.push(thread::Builder::new()
                .name(format!("motor-literario-analysis-{index}"))
                .spawn(move || loop {
                    let task = {
                        let (mutex, ready) = &*queue;
                        let mut guard = mutex.lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        while guard.tasks.is_empty() && !guard.closed {
                            guard = ready.wait(guard)
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                        }
                        if guard.tasks.is_empty() && guard.closed {
                            None
                        } else {
                            guard.tasks.pop_front()
                        }
                    };
                    match task {
                        Some(task) if !task.cancelled.load(Ordering::Acquire) => {
                            let _ = std::panic::catch_unwind(
                                std::panic::AssertUnwindSafe(task.task),
                            );
                        }
                        Some(_) => {}
                        None => break,
                    }
                })
                .expect("no se pudo crear el grupo fijo de análisis"));
        }
        Self { queue, workers }
    }

    fn try_submit(
        &self,
        cancelled: Arc<AtomicBool>,
        task: AnalysisTask,
    ) -> Result<(), AnalysisSubmitError> {
        let (mutex, ready) = &*self.queue;
        let mut queue = mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if queue.closed {
            return Err(AnalysisSubmitError::Closed);
        }
        if queue.tasks.len() >= MAX_PENDING_ANALYSIS_JOBS {
            return Err(AnalysisSubmitError::Full);
        }
        queue.tasks.push_back(QueuedAnalysisTask { cancelled, task });
        ready.notify_one();
        Ok(())
    }

    /// Retira de la cola las tareas ya marcadas como obsoletas. Los trabajos
    /// que ya ejecutan un cálculo observan su bandera y se cancelan allí.
    fn discard_cancelled_queued(&self) -> usize {
        let (mutex, _) = &*self.queue;
        let mut queue = mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let before = queue.tasks.len();
        queue.tasks.retain(|task| !task.cancelled.load(Ordering::Acquire));
        before - queue.tasks.len()
    }

    fn shutdown(&mut self) {
        let (mutex, ready) = &*self.queue;
        {
            let mut queue = mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            queue.closed = true;
            ready.notify_all();
        }
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

impl Drop for AnalysisExecutor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Clone)]
struct PendingEvidenceRebase {
    ticket_id: String,
    document_id: String,
    base_revision: u64,
    change_start_byte: usize,
    change_end_byte: usize,
    replacement_bytes: usize,
}

pub struct JsonRpcServer {
    api: Option<HostEngineApi>,
    tickets: BTreeMap<String, ChangeTicket>,
    completed_commits: BTreeMap<String, Result<ApplyOutcome, EngineError>>,
    pending_evidence_rebases: BTreeMap<String, VecDeque<PendingEvidenceRebase>>,
    paragraph_tickets: BTreeMap<String, AffectedParagraphTicket>,
    analysis_tickets: BTreeMap<String, AnalysisJobTicket>,
    analysis_cache: Arc<(Mutex<AnalysisCache>, Condvar)>,
    analysis_executor: AnalysisExecutor,
    shutdown_requested: bool,
    analysis_samples: VecDeque<u64>,
    last_analysis_micros: u64,
}

impl Default for JsonRpcServer {
    fn default() -> Self {
        Self::new()
    }
}

impl JsonRpcServer {
    pub fn new() -> Self {
        Self {
            api: None,
            tickets: BTreeMap::new(),
            completed_commits: BTreeMap::new(),
            pending_evidence_rebases: BTreeMap::new(),
            paragraph_tickets: BTreeMap::new(),
            analysis_tickets: BTreeMap::new(),
            analysis_cache: Arc::new((Mutex::new(AnalysisCache::default()), Condvar::new())),
            analysis_executor: AnalysisExecutor::new(),
            shutdown_requested: false,
            analysis_samples: VecDeque::new(),
            last_analysis_micros: 0,
        }
    }

    /// Indica al transporte que debe terminar el proceso después de responder.
    pub fn should_exit(&self) -> bool {
        self.shutdown_requested
    }

    fn cancel_superseded_analyses(&self, document_id: &str, base_revision: u64) -> usize {
        let mut cancelled = 0;
        for analysis in self.analysis_tickets.values() {
            if analysis.document_id == document_id && analysis.expected_revision <= base_revision {
                if !analysis.cancelled.swap(true, Ordering::AcqRel) {
                    cancelled += 1;
                }
            }
        }
        self.analysis_executor.discard_cancelled_queued();
        cancelled
    }

    fn cancel_all_analyses_for_document(&self, document_id: &str) -> usize {
        let mut cancelled = 0;
        for analysis in self.analysis_tickets.values() {
            if analysis.document_id == document_id
                && !analysis.cancelled.swap(true, Ordering::AcqRel)
            {
                cancelled += 1;
            }
        }
        self.analysis_executor.discard_cancelled_queued();
        cancelled
    }

    /// Recoge resultados ya terminados del worker y rebasa las evidencias
    /// en el mismo orden FIFO en que se aceptaron los deltas del documento.
    fn collect_and_rebase_document(&mut self, document_id: &str) -> Result<(), ProtocolFault> {
        let ticket_ids: Vec<String> = self.pending_evidence_rebases
            .get(document_id)
            .map(|queue| queue.iter().map(|item| item.ticket_id.clone()).collect())
            .unwrap_or_default();
        for ticket_id in ticket_ids {
            if self.completed_commits.contains_key(&ticket_id) {
                continue;
            }
            let Some(ticket) = self.tickets.get(&ticket_id) else { continue; };
            match ticket.try_result().map_err(map_ticket_error)? {
                Some(result) => { self.completed_commits.insert(ticket_id, result); }
                None => {}
            }
        }

        loop {
            let Some(front) = self.pending_evidence_rebases
                .get(document_id)
                .and_then(|queue| queue.front())
                .cloned()
            else { break; };
            let Some(result) = self.completed_commits.get(&front.ticket_id).cloned() else {
                break;
            };
            match result {
                Ok(ApplyOutcome::Applied { revision, .. }) => {
                    self.api.as_mut().ok_or_else(not_initialized)?
                        .rebase_document_evidence(
                            &front.document_id,
                            front.base_revision,
                            revision,
                            front.change_start_byte,
                            front.change_end_byte,
                            front.replacement_bytes,
                        ).map_err(map_host_error)?;
                }
                // Un reintento duplicado no vuelve a proyectar el delta: la
                // confirmación original ya debe haber procesado su evidencia.
                Ok(ApplyOutcome::Duplicate { .. })
                | Ok(ApplyOutcome::ResyncRequired { .. })
                | Err(_) => {}
            }
            let remove_queue = if let Some(queue) = self.pending_evidence_rebases.get_mut(document_id) {
                queue.pop_front();
                queue.is_empty()
            } else {
                false
            };
            if remove_queue {
                self.pending_evidence_rebases.remove(document_id);
            }
        }
        Ok(())
    }

    /// Atiende exactamente una solicitud JSON. El anfitrión puede usar una
    /// solicitud por línea y llamar este método por cada línea recibida.
    pub fn handle_line(&mut self, line: &str) -> String {
        let request = match json::parse(line) {
            Ok(value) => value,
            Err(error) => {
                return response_error(
                    JsonValue::Null,
                    ProtocolFault::new(ERROR_PARSE, error.to_string()),
                );
            }
        };

        let id = request.get("id").cloned().unwrap_or(JsonValue::Null);
        if !matches!(id, JsonValue::String(_) | JsonValue::Number(_)) {
            return response_error(
                id,
                ProtocolFault::new(ERROR_INVALID_REQUEST, "la solicitud requiere un id string o number"),
            );
        }
        if request.get("jsonrpc").and_then(JsonValue::as_str) != Some(JSON_RPC_VERSION) {
            return response_error(
                id,
                ProtocolFault::new(ERROR_INVALID_REQUEST, "jsonrpc debe ser 2.0"),
            );
        }
        let method = match request.get("method").and_then(JsonValue::as_str) {
            Some(method) if !method.is_empty() => method.to_owned(),
            _ => {
                return response_error(
                    id,
                    ProtocolFault::new(ERROR_INVALID_REQUEST, "method es obligatorio"),
                );
            }
        };
        let params = request.get("params").cloned()
            .unwrap_or_else(|| JsonValue::Object(BTreeMap::new()));
        if !matches!(params, JsonValue::Object(_)) {
            return response_error(
                id,
                ProtocolFault::new(ERROR_INVALID_PARAMS, "params debe ser un objeto"),
            );
        }
        let ticket_key = match &id {
            JsonValue::String(value) => format!("s:{value}"),
            JsonValue::Number(value) => format!("n:{value}"),
            _ => unreachable!("id ya fue validado"),
        };
        let response = match self.dispatch(&method, &params, &ticket_key) {
            Ok(result) => response_result(id.clone(), result),
            Err(error) => response_error(id.clone(), error),
        };
        if response.len() > json::MAX_JSON_BYTES {
            response_error(
                id,
                ProtocolFault::new(ERROR_RESPONSE_TOO_LARGE, "la respuesta supera el límite de 16 MiB"),
            )
        } else {
            response
        }
    }

    fn dispatch(
        &mut self,
        method: &str,
        params: &JsonValue,
        request_id: &str,
    ) -> Result<JsonValue, ProtocolFault> {
        match method {
            "get_capabilities" => Ok(object([
                ("protocol_version", string("0.1.0")),
                ("jsonrpc_version", string(JSON_RPC_VERSION)),
                ("live_monitoring", JsonValue::Bool(true)),
                ("separate_analysis_queue", JsonValue::Bool(true)),
                ("writer_queue_priority", JsonValue::Bool(true)),
                ("incremental_changes", JsonValue::Bool(true)),
                ("durable_change_journal", JsonValue::Bool(true)),
                ("bounded_async_queue", JsonValue::Bool(true)),
                ("queue_capacity_reported_in_status", JsonValue::Bool(true)),
                ("pending_load_percent_in_status", JsonValue::Bool(true)),
                ("async_paragraph_extraction", JsonValue::Bool(true)),
                ("async_paragraph_analysis", JsonValue::Bool(true)),
                ("fixed_analysis_worker_pool", JsonValue::Bool(true)),
                ("cancel_stale_analysis_on_edit", JsonValue::Bool(true)),
                ("discard_cancelled_queued_analysis", JsonValue::Bool(true)),
                ("cooperative_analysis_cancellation", JsonValue::Bool(true)),
                ("stale_analysis_rejection", JsonValue::Bool(true)),
                ("max_pending_analysis_jobs", number(MAX_PENDING_ANALYSIS_JOBS)),
                ("max_concurrent_analysis_jobs", number(ANALYSIS_WORKER_THREADS)),
                ("max_analysis_cache_entries", number(MAX_ANALYSIS_CACHE_ENTRIES)),
                ("max_analysis_cache_bytes", number(MAX_ANALYSIS_CACHE_BYTES)),
                ("concurrent_analysis_deduplication", JsonValue::Bool(true)),
                ("rolling_commit_percentiles", JsonValue::Bool(true)),
                ("end_to_end_write_latency_metrics", JsonValue::Bool(true)),
                ("max_pending_tickets", number(MAX_PENDING_TICKETS)),
                ("max_fragment_analysis_bytes", number(MAX_FRAGMENT_ANALYSIS_BYTES)),
                ("max_token_response_items", number(MAX_TOKEN_RESPONSE_ITEMS)),
                ("third_party_runtime_dependencies", JsonValue::Bool(false)),
                ("semantic_analysis", JsonValue::Bool(false)),
                ("native_rule_based_proofreading", JsonValue::Bool(true)),
                ("max_proofreading_diagnostics", number(4_096)),
                ("incremental_segmentation", JsonValue::Bool(true)),
                ("descriptive_lexical_metrics", JsonValue::Bool(true)),
                ("affected_paragraph_analysis", JsonValue::Bool(true)),
                ("persistent_fragment_analysis", JsonValue::Bool(true)),
                ("document_scoped_analysis_history", JsonValue::Bool(true)),
                ("narrative_knowledge_records", JsonValue::Bool(true)),
                ("document_scoped_evidence_index", JsonValue::Bool(true)),
                ("document_scoped_target_index", JsonValue::Bool(true)),
                ("automatic_evidence_rebase_after_commit", JsonValue::Bool(true)),
                ("persistent_stale_evidence", JsonValue::Bool(true)),
                ("conservative_evidence_recovery", JsonValue::Bool(true)),
                ("durable_evidence_history_recovery", JsonValue::Bool(true)),
                ("max_durable_evidence_history_changes", number(100_000)),
                ("max_evidence_history_transform_steps", number(5_000_000)),
                ("evidence_history_write_batch_records", number(8)),
                ("knowledge_cursor_pagination", JsonValue::Bool(true)),
                ("knowledge_integrity_audit", JsonValue::Bool(true)),
                ("document_evidence_integrity_audit", JsonValue::Bool(true)),
                ("document_fragment_analysis_integrity_audit", JsonValue::Bool(true)),
                ("fragment_analysis_source_provenance", JsonValue::Bool(true)),
                ("max_fragment_analysis_source_bytes", number(MAX_FRAGMENT_ANALYSIS_BYTES)),
                ("knowledge_cursor_is_exclusive", JsonValue::Bool(true)),
                ("max_knowledge_page_size", number(1_000)),
                ("knowledge_methods_require_local_store_paths", JsonValue::Bool(true)),
                ("transport", string("stdio_json_lines")),
                ("methods", JsonValue::Array([
                    "get_capabilities", "initialize", "open_document", "editor_change", "poll_commit",
                    "snapshot", "resynchronize", "acknowledge_host_save", "close_document",
                    "put_entity", "get_entity", "put_relation", "get_relation",
                    "put_event", "get_event", "audit_knowledge_integrity", "audit_document_evidence", "audit_document_fragment_analyses", "delete_entity", "delete_relation", "delete_event", "put_evidence", "get_evidence", "delete_evidence",
                    "list_entity_ids", "list_relation_ids", "list_event_ids", "list_evidence_ids",
                    "list_entity_ids_page", "list_relation_ids_page", "list_event_ids_page", "list_evidence_ids_page", "list_fragment_analysis_ids_page", "list_entity_ids_after", "list_relation_ids_after", "list_event_ids_after", "list_evidence_ids_after", "list_fragment_analysis_ids_after", "list_evidence_ids_for_document_after", "list_evidence_ids_for_document", "list_evidence_ids_for_document_page", "list_entity_ids_for_document", "list_relation_ids_for_document", "list_event_ids_for_document", "list_entity_ids_for_document_page", "list_relation_ids_for_document_page", "list_event_ids_for_document_page", "list_entity_ids_for_document_after", "list_relation_ids_for_document_after", "list_event_ids_for_document_after", "put_fragment_analysis", "get_fragment_analysis", "list_fragment_analysis_ids", "list_fragment_analyses", "delete_fragment_analysis", "analyze_fragment", "proofread_fragment", "proofread_affected_paragraph", "tokenize_fragment", "request_affected_paragraph", "poll_affected_paragraph", "request_analyze_affected_paragraph", "poll_analyze_affected_paragraph", "analyze_affected_paragraph",
                    "status", "shutdown",
                ].into_iter().map(string).collect())),
            ])),
            "initialize" => self.initialize(params),
            "open_document" => {
                let document_id = required_string(params, "document_id")?;
                let api = self.api.as_ref().ok_or_else(not_initialized)?;
                api.open_document(
                    document_id.clone(),
                    required_text(params, "text")?,
                    required_u64(params, "revision")?,
                    required_u64(params, "sequence")?,
                ).map_err(map_host_error)?;
                self.cancel_all_analyses_for_document(&document_id);
                Ok(status_object("opened"))
            }
            "editor_change" => {
                if self.tickets.contains_key(request_id) {
                    return Err(ProtocolFault::new(ERROR_INVALID_REQUEST, "id ya utilizado por un ticket pendiente"));
                }
                let api = self.api.as_ref().ok_or_else(not_initialized)?;
                let change = EditorChange {
                    document_id: required_string(params, "document_id")?,
                    sequence: required_u64(params, "sequence")?,
                    base_revision: required_u64(params, "base_revision")?,
                    start_byte: required_usize(params, "start_byte")?,
                    end_byte: required_usize(params, "end_byte")?,
                    replacement: required_text(params, "replacement")?,
                };
                let changed_document_id = change.document_id.clone();
                let changed_base_revision = change.base_revision;
                let changed_start_byte = change.start_byte;
                let changed_end_byte = change.end_byte;
                let replacement_bytes = change.replacement.len();
                let track_evidence = api.knowledge_configured();
                if self.tickets.len() >= MAX_PENDING_TICKETS {
                    return Err(ProtocolFault::new(
                        ERROR_TICKET_LIMIT,
                        "demasiados tickets sin consultar; consultar commits antes de enviar más cambios",
                    ).with_data(change_to_json(&change)));
                }
                match api.on_editor_change(change) {
                    Ok(ticket) => {
                        // Una edición aceptada invalida análisis pendientes de
                        // versiones anteriores del mismo documento.
                        self.cancel_superseded_analyses(
                            &changed_document_id,
                            changed_base_revision,
                        );
                        self.tickets.insert(request_id.to_owned(), ticket);
                        if track_evidence {
                            self.pending_evidence_rebases
                                .entry(changed_document_id.clone())
                                .or_default()
                                .push_back(PendingEvidenceRebase {
                                    ticket_id: request_id.to_owned(),
                                    document_id: changed_document_id,
                                    base_revision: changed_base_revision,
                                    change_start_byte: changed_start_byte,
                                    change_end_byte: changed_end_byte,
                                    replacement_bytes,
                                });
                        }
                        Ok(object([
                            ("status", string("queued")),
                            ("ticket_id", string(request_id)),
                        ]))
                    }
                    Err(SubmitError::QueueFull(change)) => {
                        Err(ProtocolFault::new(ERROR_QUEUE_FULL, "cola llena; el anfitrión debe reintentar este delta antes de enviar secuencias posteriores")
                            .with_data(change_to_json(&change)))
                    }
                    Err(SubmitError::WorkerStopped(change)) => {
                        Err(ProtocolFault::new(ERROR_WORKER_STOPPED, "worker detenido; conservar el delta para recuperación")
                            .with_data(change_to_json(&change)))
                    }
                }
            }
            "poll_commit" => {
                let ticket_id = required_string(params, "ticket_id")?;
                let rebase_document = self.pending_evidence_rebases.iter()
                    .find_map(|(document_id, queue)| {
                        queue.iter().any(|item| item.ticket_id == ticket_id)
                            .then(|| document_id.clone())
                    });
                if let Some(document_id) = rebase_document {
                    self.collect_and_rebase_document(&document_id)?;
                    if let Some(result) = self.completed_commits.remove(&ticket_id) {
                        self.tickets.remove(&ticket_id);
                        return match result {
                            Ok(outcome) => Ok(outcome_to_json(outcome)),
                            Err(error) => Err(map_engine_error(error)),
                        };
                    }
                    return Ok(object([
                        ("status", string("pending")),
                        ("ticket_id", string(ticket_id)),
                    ]));
                }

                if let Some(result) = self.completed_commits.remove(&ticket_id) {
                    self.tickets.remove(&ticket_id);
                    return match result {
                        Ok(outcome) => Ok(outcome_to_json(outcome)),
                        Err(error) => Err(map_engine_error(error)),
                    };
                }
                let poll_result = self.tickets.get(&ticket_id)
                    .ok_or_else(|| ProtocolFault::new(ERROR_TICKET_NOT_FOUND, "ticket desconocido o ya consumido"))?
                    .try_result();
                let result = match poll_result {
                    Ok(result) => result,
                    Err(error) => {
                        self.tickets.remove(&ticket_id);
                        return Err(map_ticket_error(error));
                    }
                };
                match result {
                    None => Ok(object([
                        ("status", string("pending")),
                        ("ticket_id", string(ticket_id)),
                    ])),
                    Some(Ok(outcome)) => {
                        self.tickets.remove(&ticket_id);
                        Ok(outcome_to_json(outcome))
                    }
                    Some(Err(error)) => {
                        self.tickets.remove(&ticket_id);
                        Err(map_engine_error(error))
                    }
                }
            }
            "snapshot" => {
                let api = self.api.as_ref().ok_or_else(not_initialized)?;
                let snapshot = api.snapshot(required_string(params, "document_id")?)
                    .map_err(map_host_error)?;
                Ok(object([
                    ("project_id", string(snapshot.project_id)),
                    ("document_id", string(snapshot.document_id)),
                    ("revision", number(snapshot.revision)),
                    ("last_sequence", number(snapshot.last_sequence)),
                    ("text", string(snapshot.text)),
                    ("active_suggestions", number(snapshot.active_suggestions)),
                    ("stale_suggestions", number(snapshot.stale_suggestions)),
                ]))
            }
            "resynchronize" => {
                let document_id = required_string(params, "document_id")?;
                let authoritative_text = required_text(params, "text")?;
                let revision = required_u64(params, "revision")?;
                let sequence = required_u64(params, "sequence")?;
                let knowledge_enabled = self.api.as_ref()
                    .ok_or_else(not_initialized)?
                    .knowledge_configured();
                // Verifica que el documento está abierto y drena los cambios
                // anteriores antes de invalidar el conocimiento dependiente.
                self.api.as_ref().ok_or_else(not_initialized)?
                    .snapshot(&document_id).map_err(map_host_error)?;
                // Invalidar antes de sustituir el snapshot cierra la ventana de
                // caída entre la resincronización durable y la actualización MLDB
                // narrativa. Si la resincronización falla, la invalidación es
                // conservadora: requiere revalidar citas, pero nunca las falsea.
                if knowledge_enabled {
                    self.api.as_mut().ok_or_else(not_initialized)?
                        .invalidate_document_evidence(&document_id)
                        .map_err(map_host_error)?;
                }
                {
                    let api = self.api.as_ref().ok_or_else(not_initialized)?;
                    api.resynchronize(
                        document_id.clone(),
                        authoritative_text,
                        revision,
                        sequence,
                    ).map_err(map_host_error)?;
                }
                self.cancel_all_analyses_for_document(&document_id);
                Ok(status_object("resynchronized"))
            }
            "acknowledge_host_save" => {
                let api = self.api.as_ref().ok_or_else(not_initialized)?;
                api.acknowledge_host_save(
                    required_string(params, "document_id")?,
                    required_u64(params, "revision")?,
                    required_u64(params, "sequence")?,
                ).map_err(map_host_error)?;
                Ok(status_object("checkpointed"))
            }
            "close_document" => {
                let document_id = required_string(params, "document_id")?;
                let api = self.api.as_ref().ok_or_else(not_initialized)?;
                api.close_document(document_id.clone())
                    .map_err(map_host_error)?;
                self.cancel_all_analyses_for_document(&document_id);
                Ok(status_object("closed"))
            }
            "put_entity" => {
                let attributes = optional_string_map(params, "attributes")?;
                let record = EntityRecord {
                    id: required_string(params, "id")?,
                    canonical_name: required_string(params, "canonical_name")?,
                    entity_type: required_string(params, "entity_type")?,
                    attributes,
                    status: required_record_status(params)?,
                };
                self.api.as_mut().ok_or_else(not_initialized)?
                    .put_entity(&record).map_err(map_host_error)?;
                Ok(status_object("stored"))
            }
            "get_entity" => {
                let record = self.api.as_mut().ok_or_else(not_initialized)?
                    .get_entity(&required_string(params, "id")?).map_err(map_host_error)?;
                Ok(record.map(entity_to_json).unwrap_or(JsonValue::Null))
            }
            "put_relation" => {
                let record = RelationRecord {
                    id: required_string(params, "id")?,
                    subject_id: required_string(params, "subject_id")?,
                    predicate: required_string(params, "predicate")?,
                    object_id: required_string(params, "object_id")?,
                    status: required_record_status(params)?,
                };
                self.api.as_mut().ok_or_else(not_initialized)?
                    .put_relation(&record).map_err(map_host_error)?;
                Ok(status_object("stored"))
            }
            "get_relation" => {
                let record = self.api.as_mut().ok_or_else(not_initialized)?
                    .get_relation(&required_string(params, "id")?).map_err(map_host_error)?;
                Ok(record.map(relation_to_json).unwrap_or(JsonValue::Null))
            }
            "put_event" => {
                let record = EventRecord {
                    id: required_string(params, "id")?,
                    label: required_string(params, "label")?,
                    chronology_order: optional_i64(params, "chronology_order")?,
                    status: required_record_status(params)?,
                };
                self.api.as_mut().ok_or_else(not_initialized)?
                    .put_event(&record).map_err(map_host_error)?;
                Ok(status_object("stored"))
            }
            "get_event" => {
                let record = self.api.as_mut().ok_or_else(not_initialized)?
                    .get_event(&required_string(params, "id")?).map_err(map_host_error)?;
                Ok(record.map(event_to_json).unwrap_or(JsonValue::Null))
            }
            "put_evidence" => {
                let target_kind = match required_string(params, "target_kind")?.as_str() {
                    "entity" => EvidenceTarget::Entity,
                    "relation" => EvidenceTarget::Relation,
                    "event" => EvidenceTarget::Event,
                    _ => return Err(ProtocolFault::new(ERROR_INVALID_PARAMS, "target_kind debe ser entity, relation o event")),
                };
                let document_id = required_string(params, "document_id")?;
                let revision = required_u64(params, "revision")?;
                let start_byte = required_usize(params, "start_byte")?;
                let end_byte = required_usize(params, "end_byte")?;
                let excerpt = required_text(params, "excerpt")?;
                if excerpt.len() > MAX_EVIDENCE_EXCERPT_BYTES {
                    return Err(ProtocolFault::new(ERROR_INVALID_PARAMS, "el extracto de evidencia supera 1 MiB"));
                }
                self.api.as_ref().ok_or_else(not_initialized)?
                    .validate_evidence(&document_id, revision, start_byte, end_byte, &excerpt)
                    .map_err(map_evidence_error)?;
                let record = EvidenceRecord {
                    id: required_string(params, "id")?,
                    target_kind,
                    target_id: required_string(params, "target_id")?,
                    document_id,
                    revision,
                    start_byte: usize_to_u64(start_byte)?,
                    end_byte: usize_to_u64(end_byte)?,
                    excerpt,
                    source_kind: required_string(params, "source_kind")?,
                    stale: false,
                };
                self.api.as_mut().ok_or_else(not_initialized)?
                    .put_evidence(&record).map_err(map_host_error)?;
                Ok(status_object("stored"))
            }
            "get_evidence" => {
                let evidence_id = required_string(params, "id")?;
                let initial = self.api.as_mut().ok_or_else(not_initialized)?
                    .get_evidence(&evidence_id).map_err(map_host_error)?;
                let Some(initial_record) = initial else {
                    return Ok(JsonValue::Null);
                };
                let document_id = initial_record.document_id.clone();
                if self.pending_evidence_rebases.contains_key(&document_id) {
                    self.collect_and_rebase_document(&document_id)?;
                }
                let current_revision = match self.api.as_ref().ok_or_else(not_initialized)?
                    .snapshot(&document_id)
                {
                    Ok(snapshot) => Some(snapshot.revision),
                    Err(HostApiError::Ticket(TicketError::Engine(EngineError::DocumentNotOpen))) => None,
                    Err(error) => return Err(map_host_error(error)),
                };
                // El snapshot actúa como barrera FIFO; una segunda recogida
                // aprovecha los tickets que terminaron mientras esperábamos.
                if self.pending_evidence_rebases.contains_key(&document_id) {
                    self.collect_and_rebase_document(&document_id)?;
                }
                let has_pending_rebase = self.pending_evidence_rebases.contains_key(&document_id);
                let mut record = self.api.as_mut().ok_or_else(not_initialized)?
                    .get_evidence(&evidence_id).map_err(map_host_error)?
                    .ok_or_else(|| ProtocolFault::new(ERROR_ENGINE, "la evidencia desapareció durante la consulta"))?;
                // Tras un reinicio no existe cola en memoria. Si la revisión
                // persistida quedó atrás, reconstruimos su anclaje desde el diario
                // durable; solo invalidamos cuando falta historia verificable.
                if !record.stale
                    && current_revision.is_some_and(|revision| revision != record.revision)
                {
                    if has_pending_rebase {
                        // Mientras haya commits aceptados pendientes de reconciliar,
                        // la respuesta tampoco debe presentar la cita como vigente.
                        // Se conserva el indicador temporal en esta respuesta.
                        record.stale = true;
                    } else {
                        let history = self.api.as_ref().ok_or_else(not_initialized)?
                            .durable_document_changes(&document_id);
                        match history {
                            Ok(changes) => {
                                self.api.as_mut().ok_or_else(not_initialized)?
                                    .rebase_document_evidence_history(
                                        &document_id,
                                        current_revision.unwrap_or(record.revision),
                                        &changes,
                                    ).map_err(map_host_error)?;
                            }
                            Err(HostApiError::Ticket(TicketError::Engine(EngineError::ResynchronizationRequired))) => {
                                self.api.as_mut().ok_or_else(not_initialized)?
                                    .invalidate_document_evidence(&document_id)
                                    .map_err(map_host_error)?;
                            }
                            Err(error) => return Err(map_host_error(error)),
                        }
                        record = self.api.as_mut().ok_or_else(not_initialized)?
                            .get_evidence(&evidence_id).map_err(map_host_error)?
                            .ok_or_else(|| ProtocolFault::new(ERROR_ENGINE, "la evidencia desapareció durante la recuperación"))?;
                    }
                }
                Ok(evidence_to_json(record))
            }
            "request_affected_paragraph" => {
                if self.paragraph_tickets.len() >= MAX_PENDING_TICKETS {
                    return Err(ProtocolFault::new(
                        ERROR_TICKET_LIMIT,
                        "demasiadas extracciones de párrafo pendientes; consultar tickets antes de solicitar más",
                    ));
                }
                let document_id = required_string(params, "document_id")?;
                let selection_start = required_usize(params, "selection_start_byte")?;
                let selection_end = required_usize(params, "selection_end_byte")?;
                let expected_revision = required_u64(params, "expected_revision")?;
                let ticket = self.api.as_ref().ok_or_else(not_initialized)?
                    .request_affected_paragraph(
                        document_id, expected_revision, selection_start, selection_end,
                    ).map_err(map_host_error)?;
                self.paragraph_tickets.insert(request_id.to_owned(), ticket);
                Ok(object([
                    ("status", string("queued")),
                    ("ticket_id", string(request_id)),
                ]))
            }
            "poll_affected_paragraph" => {
                let ticket_id = required_string(params, "ticket_id")?;
                let ticket = self.paragraph_tickets.remove(&ticket_id)
                    .ok_or_else(|| ProtocolFault::new(ERROR_TICKET_NOT_FOUND, "ticket de párrafo inexistente"))?;
                match ticket.try_result().map_err(map_ticket_error)? {
                    None => {
                        self.paragraph_tickets.insert(ticket_id.clone(), ticket);
                        Ok(object([("status", string("pending"))]))
                    }
                    Some(Ok(snapshot)) => Ok(object([
                        ("status", string("ready")),
                        ("project_id", string(snapshot.project_id)),
                        ("document_id", string(snapshot.document_id)),
                        ("revision", number(snapshot.revision)),
                        ("last_sequence", number(snapshot.last_sequence)),
                        ("start_byte", number(snapshot.start_byte)),
                        ("end_byte", number(snapshot.end_byte)),
                        ("text", string(snapshot.text)),
                    ])),
                    Some(Err(error)) => Err(map_engine_error(error)),
                }
            }
            "request_analyze_affected_paragraph" => {
                if self.analysis_tickets.len() >= MAX_PENDING_ANALYSIS_JOBS {
                    return Err(ProtocolFault::new(ERROR_TICKET_LIMIT, "demasiados análisis pendientes; consultar resultados antes de solicitar más"));
                }
                if self.analysis_tickets.contains_key(request_id) {
                    return Err(ProtocolFault::new(ERROR_INVALID_REQUEST, "id ya utilizado por un análisis pendiente"));
                }
                let document_id = required_string(params, "document_id")?;
                let selection_start = required_usize(params, "selection_start_byte")?;
                let selection_end = required_usize(params, "selection_end_byte")?;
                let expected_revision = required_u64(params, "expected_revision")?;
                let requested_at = std::time::Instant::now();
                let cancelled = Arc::new(AtomicBool::new(false));
                let ticket = self.api.as_ref().ok_or_else(not_initialized)?
                    .request_affected_paragraph_cancellable(
                        document_id.clone(), expected_revision, selection_start, selection_end,
                        Arc::clone(&cancelled),
                    )
                    .map_err(map_host_error)?;
                let (sender, receiver) = mpsc::channel();
                let analysis_cache = Arc::clone(&self.analysis_cache);
                let task_cancelled = Arc::clone(&cancelled);
                let task: AnalysisTask = Box::new(move || {
                    let result = (|| {
                        // La espera es cancelable: un cambio de revisión no deja
                        // ocupado un hilo del pool esperando una extracción inútil.
                        let snapshot = loop {
                            if task_cancelled.load(Ordering::Acquire) {
                                return Err(ANALYSIS_CANCELLED_STALE.to_owned());
                            }
                            match ticket.wait_timeout(std::time::Duration::from_millis(10)) {
                                Ok(Some(Ok(snapshot))) => break snapshot,
                                Ok(Some(Err(error))) => return Err(format!("{error:?}")),
                                Ok(None) => continue,
                                Err(error) => return Err(format!("{error:?}")),
                            }
                        };
                        if task_cancelled.load(Ordering::Acquire) {
                            return Err(ANALYSIS_CANCELLED_STALE.to_owned());
                        }
                        let extraction_micros = requested_at.elapsed()
                            .as_micros().min(u64::MAX as u128) as u64;
                        if snapshot.text.len() > MAX_FRAGMENT_ANALYSIS_BYTES {
                            return Err("párrafo afectado supera 512 KiB".to_owned());
                        }
                        let analysis_started = std::time::Instant::now();
                        // La clave incluye proyecto y documento: nunca se
                        // reutilizan métricas entre obras ni documentos.
                        // Texto y offset exactos preservan las evidencias UTF-8.
                        let key = (
                            snapshot.project_id.clone(),
                            snapshot.document_id.clone(),
                            snapshot.start_byte,
                            snapshot.text.clone(),
                        );
                        let (metrics, cache_hit) = AnalysisCache::get_or_compute_cancellable(
                            &analysis_cache,
                            key,
                            &task_cancelled,
                            || analyze_fragment_cancellable(
                                &snapshot.text, snapshot.start_byte, &task_cancelled,
                            ),
                        )?;
                        let diagnostics = review_fragment_cancellable(
                            &snapshot.text, snapshot.start_byte, &task_cancelled,
                        ).ok_or_else(|| ANALYSIS_CANCELLED_STALE.to_owned())?;
                        let analysis_micros = analysis_started.elapsed()
                            .as_micros().min(u64::MAX as u128) as u64;
                        if task_cancelled.load(Ordering::Acquire) {
                            return Err(ANALYSIS_CANCELLED_STALE.to_owned());
                        }
                        Ok(AnalysisJobResult {
                            snapshot, metrics, diagnostics, extraction_micros, analysis_micros, cache_hit,
                        })
                    })();
                    let _ = sender.send(result);
                });
                if let Err(error) = self.analysis_executor.try_submit(Arc::clone(&cancelled), task) {
                    // La extracción del párrafo ya se encoló en el worker de
                    // escritura. Si el pool analítico rechaza el trabajo,
                    // cancelar esa extracción para que se omita si sigue pendiente.
                    cancelled.store(true, Ordering::Release);
                    self.analysis_executor.discard_cancelled_queued();
                    return Err(ProtocolFault::new(ERROR_TICKET_LIMIT, match error {
                        AnalysisSubmitError::Full => "cola de análisis llena",
                        AnalysisSubmitError::Closed => "grupo de análisis cerrado",
                    }));
                }
                self.analysis_tickets.insert(request_id.to_owned(), AnalysisJobTicket {
                    receiver, cancelled, document_id, expected_revision,
                });
                Ok(object([("status", string("queued")), ("ticket_id", string(request_id))]))
            }
            "poll_analyze_affected_paragraph" => {
                let ticket_id = required_string(params, "ticket_id")?;
                let analysis_id = required_string(params, "analysis_id")?;
                // La invalidación por una edición es suficiente para responder
                // stale: no hace falta esperar a que el worker despierte, observe
                // la bandera y publique el resultado de cancelación.
                if self.analysis_tickets.get(&ticket_id)
                    .ok_or_else(|| ProtocolFault::new(ERROR_TICKET_NOT_FOUND, "ticket de análisis inexistente"))?
                    .cancelled.load(Ordering::Acquire)
                {
                    let metadata = self.analysis_tickets.remove(&ticket_id);
                    return Ok(object([
                        ("status", string("stale")),
                        ("persisted", JsonValue::Bool(false)),
                        ("reason", string("superseded_by_edit")),
                        ("document_id", string(metadata.as_ref().map(|ticket| ticket.document_id.as_str()).unwrap_or(""))),
                        ("analyzed_revision", number(metadata.as_ref().map(|ticket| ticket.expected_revision).unwrap_or(0))),
                    ]));
                }
                let poll_result = self.analysis_tickets.get(&ticket_id)
                    .ok_or_else(|| ProtocolFault::new(ERROR_TICKET_NOT_FOUND, "ticket de análisis inexistente"))?
                    .receiver.try_recv();
                let (result, completed_ticket) = match poll_result {
                    Ok(result) => {
                        // El resultado ya salió del canal. Retirar el ticket aquí
                        // evita entradas huérfanas; conservamos sus metadatos para
                        // responder stale o reponerlo si falla la persistencia.
                        (result, self.analysis_tickets.remove(&ticket_id))
                    }
                    Err(TryRecvError::Empty) => return Ok(object([("status", string("pending"))])),
                    Err(TryRecvError::Disconnected) => {
                        self.analysis_tickets.remove(&ticket_id);
                        return Err(ProtocolFault::new(ERROR_WORKER_STOPPED, "el worker de análisis terminó sin entregar resultado"));
                    }
                };
                let job = match result {
                    Ok(job) => job,
                    Err(message) => {
                        if message == ANALYSIS_CANCELLED_STALE {
                            let metadata = completed_ticket;
                            return Ok(object([
                                ("status", string("stale")),
                                ("persisted", JsonValue::Bool(false)),
                                ("reason", string("superseded_by_edit")),
                                ("document_id", string(metadata.as_ref().map(|ticket| ticket.document_id.as_str()).unwrap_or(""))),
                                ("analyzed_revision", number(metadata.as_ref().map(|ticket| ticket.expected_revision).unwrap_or(0))),
                            ]));
                        }
                        return Err(ProtocolFault::new(ERROR_ENGINE, message));
                    }
                };
                let extraction_micros = job.extraction_micros;
                let analysis_micros = job.analysis_micros;
                let snapshot = job.snapshot;
                let metrics = job.metrics;
                let diagnostics = job.diagnostics;
                let cache_hit = job.cache_hit;

                // La extracción es FIFO, pero el escritor puede seguir editando
                // mientras el análisis lingüístico corre en su hilo. Antes de
                // persistir, una barrera FIFO confirma que la evidencia sigue
                // perteneciendo a la revisión viva. Los resultados obsoletos no
                // se presentan como actuales ni se guardan como análisis vigente.
                let match_result = self.api.as_ref().ok_or_else(not_initialized)?
                    .fragment_matches(
                        snapshot.document_id.clone(),
                        snapshot.revision,
                        snapshot.last_sequence,
                        snapshot.start_byte,
                        snapshot.end_byte,
                        snapshot.text.clone(),
                    );
                let (current_revision, current_sequence, same_fragment) = match match_result {
                    Ok(result) => result,
                    Err(error) => {
                        // El resultado del canal ya fue consumido: retirar el ticket
                        // también en este camino evita dejar una entrada irrecuperable.
                        self.analysis_tickets.remove(&ticket_id);
                        return Err(map_host_error(error));
                    }
                };
                if !same_fragment {
                    self.analysis_tickets.remove(&ticket_id);
                    return Ok(object([
                        ("status", string("stale")),
                        ("persisted", JsonValue::Bool(false)),
                        ("analysis_id", string(analysis_id)),
                        ("project_id", string(snapshot.project_id)),
                        ("document_id", string(snapshot.document_id)),
                        ("analyzed_revision", number(snapshot.revision)),
                        ("current_revision", number(current_revision)),
                        ("analyzed_sequence", number(snapshot.last_sequence)),
                        ("current_sequence", number(current_sequence)),
                    ]));
                }

                let record = FragmentAnalysisRecord {
                    id: analysis_id.clone(),
                    document_id: snapshot.document_id.clone(),
                    revision: snapshot.revision,
                    start_byte: usize_to_u64(snapshot.start_byte)?,
                    end_byte: usize_to_u64(snapshot.end_byte)?,
                    character_count: usize_to_u64(metrics.character_count)?,
                    word_count: usize_to_u64(metrics.word_count)?,
                    unique_word_count: usize_to_u64(metrics.unique_word_count)?,
                    sentence_count: usize_to_u64(metrics.sentence_count)?,
                    paragraph_count: usize_to_u64(metrics.paragraph_count)?,
                    long_word_count: usize_to_u64(metrics.long_word_count)?,
                    average_word_length_milli: metrics.average_word_length_milli,
                    source_text: Some(snapshot.text.clone()),
                    repeated_words: metrics.repeated_words.iter().map(|word| Ok(RepeatedWordRecord {
                        normalized: word.normalized.clone(),
                        count: usize_to_u64(word.count)?,
                        first_start_byte: usize_to_u64(word.first_start_byte)?,
                    })).collect::<Result<Vec<_>, ProtocolFault>>()?,
                };
                let persistence_started = std::time::Instant::now();
                let persistence = self.api.as_mut().ok_or_else(not_initialized)?
                    .put_fragment_analysis(&record);
                let persistence_micros = persistence_started.elapsed()
                    .as_micros().min(u64::MAX as u128) as u64;
                if let Err(error) = persistence {
                    let (sender, receiver) = mpsc::channel();
                    let document_id = snapshot.document_id.clone();
                    let revision = snapshot.revision;
                    let _ = sender.send(Ok(AnalysisJobResult {
                        snapshot, metrics, diagnostics, extraction_micros, analysis_micros, cache_hit,
                    }));
                    let Some(metadata) = completed_ticket else {
                        return Err(ProtocolFault::new(ERROR_TICKET_NOT_FOUND, "se perdió el metadato del análisis al reintentar persistencia"));
                    };
                    self.analysis_tickets.insert(ticket_id, AnalysisJobTicket {
                        receiver, cancelled: metadata.cancelled, document_id, expected_revision: revision,
                    });
                    return Err(map_host_error(error));
                }
                self.analysis_tickets.remove(&ticket_id);
                // La latencia reportada termina en la persistencia confirmada;
                // extracción y análisis se miden por separado en el worker.
                let elapsed = extraction_micros
                    .saturating_add(analysis_micros)
                    .saturating_add(persistence_micros);
                self.last_analysis_micros = elapsed;
                self.analysis_samples.push_back(elapsed);
                if self.analysis_samples.len() > MAX_ANALYSIS_SAMPLES {
                    self.analysis_samples.pop_front();
                }
                Ok(object([
                    ("status", string("ready")),
                    ("analysis_id", string(analysis_id)),
                    ("persisted", JsonValue::Bool(true)),
                    ("analysis_cache_hit", JsonValue::Bool(cache_hit)),
                    ("extraction_micros", number(extraction_micros)),
                    ("analysis_micros", number(analysis_micros)),
                    ("persistence_micros", number(persistence_micros)),
                    ("project_id", string(snapshot.project_id)),
                    ("document_id", string(snapshot.document_id)),
                    ("revision", number(snapshot.revision)),
                    ("last_sequence", number(snapshot.last_sequence)),
                    ("start_byte", number(snapshot.start_byte)),
                    ("end_byte", number(snapshot.end_byte)),
                    ("text", string(snapshot.text)),
                    ("character_count", number(metrics.character_count)),
                    ("word_count", number(metrics.word_count)),
                    ("unique_word_count", number(metrics.unique_word_count)),
                    ("sentence_count", number(metrics.sentence_count)),
                    ("paragraph_count", number(metrics.paragraph_count)),
                    ("long_word_count", number(metrics.long_word_count)),
                    ("average_word_length_milli", number(metrics.average_word_length_milli)),
                    ("repeated_words", JsonValue::Array(metrics.repeated_words.into_iter().map(|word| object([
                        ("normalized", string(word.normalized)),
                        ("count", number(word.count)),
                        ("first_start_byte", number(word.first_start_byte)),
                    ])).collect())),
                    ("diagnostics", JsonValue::Array(diagnostics.into_iter().map(|item| object([
                        ("code", string(item.code)),
                        ("severity", string(item.severity.as_str())),
                        ("start_byte", number(item.start_byte)),
                        ("end_byte", number(item.end_byte)),
                        ("message", string(item.message)),
                        ("replacement", item.replacement.map(string).unwrap_or(JsonValue::Null)),
                    ])).collect())),
                ]))
            }
            "analyze_affected_paragraph" => {
                let analysis_started = std::time::Instant::now();
                let document_id = required_string(params, "document_id")?;
                let selection_start = required_usize(params, "selection_start_byte")?;
                let selection_end = required_usize(params, "selection_end_byte")?;
                let expected_revision = required_u64(params, "expected_revision")?;
                let paragraph_snapshot = self.api.as_ref().ok_or_else(not_initialized)?
                    .affected_paragraph(document_id, expected_revision, selection_start, selection_end)
                    .map_err(map_analysis_error)?;
                let paragraph_start = paragraph_snapshot.start_byte;
                let paragraph_end = paragraph_snapshot.end_byte;
                let paragraph = paragraph_snapshot.text.as_str();
                if paragraph.len() > MAX_FRAGMENT_ANALYSIS_BYTES {
                    return Err(ProtocolFault::new(ERROR_INVALID_PARAMS, "párrafo afectado supera 512 KiB"));
                }
                let metrics = analyze_fragment(paragraph, paragraph_start);
                let diagnostics = review_fragment(paragraph, paragraph_start);
                let analysis_id = required_string(params, "analysis_id")?;
                let record = FragmentAnalysisRecord {
                        id: analysis_id.clone(),
                        document_id: paragraph_snapshot.document_id.clone(),
                        revision: paragraph_snapshot.revision,
                        start_byte: usize_to_u64(paragraph_start)?,
                        end_byte: usize_to_u64(paragraph_end)?,
                        character_count: usize_to_u64(metrics.character_count)?,
                        word_count: usize_to_u64(metrics.word_count)?,
                        unique_word_count: usize_to_u64(metrics.unique_word_count)?,
                        sentence_count: usize_to_u64(metrics.sentence_count)?,
                        paragraph_count: usize_to_u64(metrics.paragraph_count)?,
                        long_word_count: usize_to_u64(metrics.long_word_count)?,
                        average_word_length_milli: metrics.average_word_length_milli,
                        source_text: Some(paragraph.to_owned()),
                        repeated_words: metrics.repeated_words.iter().map(|word| Ok(RepeatedWordRecord {
                            normalized: word.normalized.clone(),
                            count: usize_to_u64(word.count)?,
                            first_start_byte: usize_to_u64(word.first_start_byte)?,
                        })).collect::<Result<Vec<_>, ProtocolFault>>()?,
                    };
                self.api.as_mut().ok_or_else(not_initialized)?
                    .put_fragment_analysis(&record).map_err(map_host_error)?;
                let elapsed = analysis_started.elapsed().as_micros().min(u64::MAX as u128) as u64;
                self.last_analysis_micros = elapsed;
                self.analysis_samples.push_back(elapsed);
                if self.analysis_samples.len() > MAX_ANALYSIS_SAMPLES {
                    self.analysis_samples.pop_front();
                }
                Ok(object([
                    ("analysis_id", string(analysis_id)),
                    ("persisted", JsonValue::Bool(true)),
                    ("project_id", string(paragraph_snapshot.project_id)),
                    ("document_id", string(paragraph_snapshot.document_id)),
                    ("revision", number(paragraph_snapshot.revision)),
                    ("last_sequence", number(paragraph_snapshot.last_sequence)),
                    ("start_byte", number(paragraph_start)),
                    ("end_byte", number(paragraph_end)),
                    ("text", string(paragraph)),
                    ("word_count", number(metrics.word_count)),
                    ("unique_word_count", number(metrics.unique_word_count)),
                    ("sentence_count", number(metrics.sentence_count)),
                    ("paragraph_count", number(metrics.paragraph_count)),
                    ("long_word_count", number(metrics.long_word_count)),
                    ("average_word_length_milli", number(metrics.average_word_length_milli)),
                    ("repeated_words", JsonValue::Array(metrics.repeated_words.into_iter().map(|word| object([
                        ("normalized", string(word.normalized)),
                        ("count", number(word.count)),
                        ("first_start_byte", number(word.first_start_byte)),
                    ])).collect())),
                    ("diagnostics", JsonValue::Array(diagnostics.into_iter().map(|item| object([
                        ("code", string(item.code)),
                        ("severity", string(item.severity.as_str())),
                        ("start_byte", number(item.start_byte)),
                        ("end_byte", number(item.end_byte)),
                        ("message", string(item.message)),
                        ("replacement", item.replacement.map(string).unwrap_or(JsonValue::Null)),
                    ])).collect())),
                ]))
            }
            "analyze_fragment" => {
                let text = required_text(params, "text")?;
                if text.len() > MAX_FRAGMENT_ANALYSIS_BYTES {
                    return Err(ProtocolFault::new(ERROR_INVALID_PARAMS, "fragmento supera 512 KiB"));
                }
                let base_byte = required_usize(params, "base_byte")?;
                if base_byte.checked_add(text.len()).is_none() {
                    return Err(ProtocolFault::new(ERROR_INVALID_PARAMS, "base_byte más el fragmento desborda usize"));
                }
                let metrics = analyze_fragment(&text, base_byte);
                let repeated_words = JsonValue::Array(metrics.repeated_words.into_iter().map(|word| object([
                    ("normalized", string(word.normalized)),
                    ("count", number(word.count)),
                    ("first_start_byte", number(word.first_start_byte)),
                ])).collect());
                Ok(object([
                    ("start_byte", number(metrics.start_byte)),
                    ("end_byte", number(metrics.end_byte)),
                    ("character_count", number(metrics.character_count)),
                    ("word_count", number(metrics.word_count)),
                    ("unique_word_count", number(metrics.unique_word_count)),
                    ("sentence_count", number(metrics.sentence_count)),
                    ("paragraph_count", number(metrics.paragraph_count)),
                    ("long_word_count", number(metrics.long_word_count)),
                    ("average_word_length_milli", number(metrics.average_word_length_milli)),
                    ("repeated_words", repeated_words),
                ]))
            }
            "proofread_affected_paragraph" => {
                let document_id = required_string(params, "document_id")?;
                let selection_start = required_usize(params, "selection_start_byte")?;
                let selection_end = required_usize(params, "selection_end_byte")?;
                let expected_revision = required_u64(params, "expected_revision")?;
                let snapshot = self.api.as_ref().ok_or_else(not_initialized)?
                    .affected_paragraph(document_id, expected_revision, selection_start, selection_end)
                    .map_err(map_analysis_error)?;
                if snapshot.text.len() > MAX_FRAGMENT_ANALYSIS_BYTES {
                    return Err(ProtocolFault::new(ERROR_INVALID_PARAMS, "párrafo afectado supera 512 KiB"));
                }
                let diagnostics = review_fragment(&snapshot.text, snapshot.start_byte);
                Ok(object([
                    ("document_id", string(snapshot.document_id)),
                    ("revision", number(snapshot.revision)),
                    ("last_sequence", number(snapshot.last_sequence)),
                    ("start_byte", number(snapshot.start_byte)),
                    ("end_byte", number(snapshot.end_byte)),
                    ("diagnostics", JsonValue::Array(diagnostics.into_iter().map(|item| object([
                        ("code", string(item.code)),
                        ("severity", string(item.severity.as_str())),
                        ("start_byte", number(item.start_byte)),
                        ("end_byte", number(item.end_byte)),
                        ("message", string(item.message)),
                        ("replacement", item.replacement.map(string).unwrap_or(JsonValue::Null)),
                    ])).collect())),
                ]))
            }
            "proofread_fragment" => {
                let text = required_text(params, "text")?;
                if text.len() > MAX_FRAGMENT_ANALYSIS_BYTES {
                    return Err(ProtocolFault::new(ERROR_INVALID_PARAMS, "fragmento supera 512 KiB"));
                }
                let base_byte = required_usize(params, "base_byte")?;
                if base_byte.checked_add(text.len()).is_none() {
                    return Err(ProtocolFault::new(ERROR_INVALID_PARAMS, "base_byte más el fragmento desborda usize"));
                }
                let diagnostics = review_fragment(&text, base_byte);
                Ok(JsonValue::Array(diagnostics.into_iter().map(|item| object([
                    ("code", string(item.code)),
                    ("severity", string(item.severity.as_str())),
                    ("start_byte", number(item.start_byte)),
                    ("end_byte", number(item.end_byte)),
                    ("message", string(item.message)),
                    ("replacement", item.replacement.map(string).unwrap_or(JsonValue::Null)),
                ])).collect()))
            }
            "tokenize_fragment" => {
                let text = required_text(params, "text")?;
                if text.len() > MAX_FRAGMENT_ANALYSIS_BYTES {
                    return Err(ProtocolFault::new(ERROR_INVALID_PARAMS, "fragmento supera 512 KiB"));
                }
                let base_byte = required_usize(params, "base_byte")?;
                if base_byte.checked_add(text.len()).is_none() {
                    return Err(ProtocolFault::new(ERROR_INVALID_PARAMS, "base_byte más el fragmento desborda usize"));
                }
                let tokens = tokenize_words(&text, base_byte);
                if tokens.len() > MAX_TOKEN_RESPONSE_ITEMS {
                    return Err(ProtocolFault::new(ERROR_INVALID_PARAMS, "fragmento supera 50.000 tokens"));
                }
                Ok(JsonValue::Array(tokens.into_iter().map(|token| object([
                    ("normalized", string(token.normalized)),
                    ("start_byte", number(token.start_byte)),
                    ("end_byte", number(token.end_byte)),
                    ("character_count", number(token.character_count)),
                ])).collect()))
            }
            "put_fragment_analysis" => {
                let record = parse_fragment_analysis(params)?;
                self.api.as_mut().ok_or_else(not_initialized)?
                    .put_fragment_analysis(&record).map_err(map_host_error)?;
                Ok(status_object("stored"))
            }
            "get_fragment_analysis" => {
                let record = self.api.as_mut().ok_or_else(not_initialized)?
                    .get_fragment_analysis(&required_string(params, "id")?).map_err(map_host_error)?;
                Ok(record.map(fragment_analysis_to_json).unwrap_or(JsonValue::Null))
            }
            "delete_fragment_analysis" => {
                let deleted = self.api.as_mut().ok_or_else(not_initialized)?
                    .delete_fragment_analysis(&required_string(params, "id")?).map_err(map_host_error)?;
                Ok(object([("deleted", JsonValue::Bool(deleted))]))
            }
            "list_fragment_analysis_ids" => {
                let ids = self.api.as_mut().ok_or_else(not_initialized)?
                    .fragment_analysis_ids().map_err(map_host_error)?;
                Ok(JsonValue::Array(ids.into_iter().map(string).collect()))
            }
            "list_fragment_analyses" => {
                let document_id = required_string(params, "document_id")?;
                let revision = optional_u64(params, "revision")?;
                let limit = match params.get("limit") {
                    None => 100,
                    Some(value) => value.as_usize().ok_or_else(|| ProtocolFault::new(
                        ERROR_INVALID_PARAMS, "limit debe ser un entero unsigned",
                    ))?,
                };
                let records = self.api.as_mut().ok_or_else(not_initialized)?
                    .fragment_analyses_for_document(&document_id, revision, limit)
                    .map_err(map_host_error)?;
                Ok(JsonValue::Array(records.into_iter().map(fragment_analysis_to_json).collect()))
            }
            "list_entity_ids_page" | "list_relation_ids_page" | "list_event_ids_page"
            | "list_evidence_ids_page" | "list_fragment_analysis_ids_page" => {
                let offset = params.get("offset")
                    .map(|_| required_usize(params, "offset"))
                    .transpose()?.unwrap_or(0);
                let limit = params.get("limit")
                    .map(|_| required_usize(params, "limit"))
                    .transpose()?.unwrap_or(100);
                let api = self.api.as_mut().ok_or_else(not_initialized)?;
                let ids = match method {
                    "list_entity_ids_page" => api.entity_ids_page(offset, limit),
                    "list_relation_ids_page" => api.relation_ids_page(offset, limit),
                    "list_event_ids_page" => api.event_ids_page(offset, limit),
                    "list_evidence_ids_page" => api.evidence_ids_page(offset, limit),
                    _ => api.fragment_analysis_ids_page(offset, limit),
                }.map_err(map_host_error)?;
                Ok(JsonValue::Array(ids.into_iter().map(string).collect()))
            }
            "list_entity_ids_after" | "list_relation_ids_after" | "list_event_ids_after"
            | "list_evidence_ids_after" | "list_fragment_analysis_ids_after" => {
                let after_id = params.get("after_id")
                    .map(|_| required_string(params, "after_id"))
                    .transpose()?;
                let limit = params.get("limit")
                    .map(|_| required_usize(params, "limit"))
                    .transpose()?.unwrap_or(100);
                let api = self.api.as_mut().ok_or_else(not_initialized)?;
                let ids = match method {
                    "list_entity_ids_after" => api.entity_ids_after(after_id.as_deref(), limit),
                    "list_relation_ids_after" => api.relation_ids_after(after_id.as_deref(), limit),
                    "list_event_ids_after" => api.event_ids_after(after_id.as_deref(), limit),
                    "list_evidence_ids_after" => api.evidence_ids_after(after_id.as_deref(), limit),
                    _ => api.fragment_analysis_ids_after(after_id.as_deref(), limit),
                }.map_err(map_host_error)?;
                Ok(JsonValue::Array(ids.into_iter().map(string).collect()))
            }
            "audit_document_fragment_analyses" => {
                let document_id = required_string(params, "document_id")?;
                let after_id = optional_string(params, "after_id")?;
                let limit = params.get("limit")
                    .map(|_| required_usize(params, "limit"))
                    .transpose()?.unwrap_or(100);
                let page = self.api.as_mut().ok_or_else(not_initialized)?
                    .audit_document_fragment_analyses(
                        &document_id, after_id.as_deref(), limit,
                    )
                    .map_err(map_host_error)?;
                let issues = page.issues.into_iter().map(|issue| object([
                    ("table", string(issue.table)),
                    ("record_id", string(issue.record_id)),
                    ("code", string(issue.code)),
                    ("target_id", issue.target_id.map(string).unwrap_or(JsonValue::Null)),
                ])).collect();
                Ok(object([
                    ("issues", JsonValue::Array(issues)),
                    ("scanned", JsonValue::Number(page.scanned.to_string())),
                    ("next_after", page.next_after.map(string).unwrap_or(JsonValue::Null)),
                    ("has_more", JsonValue::Bool(page.has_more)),
                ]))
            }
            "audit_document_evidence" => {
                let document_id = required_string(params, "document_id")?;
                let after_id = optional_string(params, "after_id")?;
                let limit = params.get("limit")
                    .map(|_| required_usize(params, "limit"))
                    .transpose()?.unwrap_or(100);
                let page = self.api.as_mut().ok_or_else(not_initialized)?
                    .audit_document_evidence(&document_id, after_id.as_deref(), limit)
                    .map_err(map_host_error)?;
                let issues = page.issues.into_iter().map(|issue| object([
                    ("table", string(issue.table)),
                    ("record_id", string(issue.record_id)),
                    ("code", string(issue.code)),
                    ("target_id", issue.target_id.map(string).unwrap_or(JsonValue::Null)),
                ])).collect();
                Ok(object([
                    ("issues", JsonValue::Array(issues)),
                    ("scanned", JsonValue::Number(page.scanned.to_string())),
                    ("next_after", page.next_after.map(string).unwrap_or(JsonValue::Null)),
                    ("has_more", JsonValue::Bool(page.has_more)),
                ]))
            }
            "audit_knowledge_integrity" => {
                let table = required_string(params, "table")?;
                let after_id = optional_string(params, "after_id")?;
                let limit = params.get("limit")
                    .map(|_| required_usize(params, "limit"))
                    .transpose()?.unwrap_or(100);
                let page = self.api.as_mut().ok_or_else(not_initialized)?
                    .audit_knowledge_integrity(&table, after_id.as_deref(), limit)
                    .map_err(map_host_error)?;
                let issues = page.issues.into_iter().map(|issue| object([
                    ("table", string(issue.table)),
                    ("record_id", string(issue.record_id)),
                    ("code", string(issue.code)),
                    ("target_id", issue.target_id.map(string).unwrap_or(JsonValue::Null)),
                ])).collect();
                Ok(object([
                    ("issues", JsonValue::Array(issues)),
                    ("scanned", JsonValue::Number(page.scanned.to_string())),
                    ("next_after", page.next_after.map(string).unwrap_or(JsonValue::Null)),
                    ("has_more", JsonValue::Bool(page.has_more)),
                ]))
            }
            "delete_entity" | "delete_relation" | "delete_event" | "delete_evidence" => {
                let id = required_string(params, "id")?;
                let api = self.api.as_mut().ok_or_else(not_initialized)?;
                let deleted = match method {
                    "delete_entity" => api.delete_entity(&id),
                    "delete_relation" => api.delete_relation(&id),
                    "delete_event" => api.delete_event(&id),
                    _ => api.delete_evidence(&id),
                }.map_err(map_host_error)?;
                Ok(object([("deleted", JsonValue::Bool(deleted))]))
            }
            "list_entity_ids" => {
                let ids = self.api.as_mut().ok_or_else(not_initialized)?
                    .entity_ids().map_err(map_host_error)?;
                Ok(JsonValue::Array(ids.into_iter().map(string).collect()))
            }
            "list_relation_ids" => {
                let ids = self.api.as_mut().ok_or_else(not_initialized)?
                    .relation_ids().map_err(map_host_error)?;
                Ok(JsonValue::Array(ids.into_iter().map(string).collect()))
            }
            "list_event_ids" => {
                let ids = self.api.as_mut().ok_or_else(not_initialized)?
                    .event_ids().map_err(map_host_error)?;
                Ok(JsonValue::Array(ids.into_iter().map(string).collect()))
            }
            "list_evidence_ids" => {
                let ids = self.api.as_mut().ok_or_else(not_initialized)?
                    .evidence_ids().map_err(map_host_error)?;
                Ok(JsonValue::Array(ids.into_iter().map(string).collect()))
            }
            "list_entity_ids_for_document" => {
                let document_id = required_string(params, "document_id")?;
                let ids = self.api.as_mut().ok_or_else(not_initialized)?
                    .entity_ids_for_document(&document_id).map_err(map_host_error)?;
                Ok(JsonValue::Array(ids.into_iter().map(string).collect()))
            }
            "list_relation_ids_for_document" => {
                let document_id = required_string(params, "document_id")?;
                let ids = self.api.as_mut().ok_or_else(not_initialized)?
                    .relation_ids_for_document(&document_id).map_err(map_host_error)?;
                Ok(JsonValue::Array(ids.into_iter().map(string).collect()))
            }
            "list_event_ids_for_document" => {
                let document_id = required_string(params, "document_id")?;
                let ids = self.api.as_mut().ok_or_else(not_initialized)?
                    .event_ids_for_document(&document_id).map_err(map_host_error)?;
                Ok(JsonValue::Array(ids.into_iter().map(string).collect()))
            }
            "list_evidence_ids_for_document" => {
                let document_id = required_string(params, "document_id")?;
                let ids = self.api.as_mut().ok_or_else(not_initialized)?
                    .evidence_ids_for_document(&document_id).map_err(map_host_error)?;
                Ok(JsonValue::Array(ids.into_iter().map(string).collect()))
            }

            "list_entity_ids_for_document_page" | "list_relation_ids_for_document_page"
            | "list_event_ids_for_document_page" => {
                let document_id = required_string(params, "document_id")?;
                let offset = params.get("offset")
                    .map(|_| required_usize(params, "offset"))
                    .transpose()?.unwrap_or(0);
                let limit = params.get("limit")
                    .map(|_| required_usize(params, "limit"))
                    .transpose()?.unwrap_or(100);
                let api = self.api.as_mut().ok_or_else(not_initialized)?;
                let ids = match method {
                    "list_entity_ids_for_document_page" => api.entity_ids_for_document_page(&document_id, offset, limit),
                    "list_relation_ids_for_document_page" => api.relation_ids_for_document_page(&document_id, offset, limit),
                    _ => api.event_ids_for_document_page(&document_id, offset, limit),
                }.map_err(map_host_error)?;
                Ok(JsonValue::Array(ids.into_iter().map(string).collect()))
            }
            "list_entity_ids_for_document_after" | "list_relation_ids_for_document_after"
            | "list_event_ids_for_document_after" => {
                let document_id = required_string(params, "document_id")?;
                let after_id = params.get("after_id")
                    .map(|_| required_string(params, "after_id"))
                    .transpose()?;
                let limit = params.get("limit")
                    .map(|_| required_usize(params, "limit"))
                    .transpose()?.unwrap_or(100);
                let api = self.api.as_mut().ok_or_else(not_initialized)?;
                let ids = match method {
                    "list_entity_ids_for_document_after" => api.entity_ids_for_document_after(&document_id, after_id.as_deref(), limit),
                    "list_relation_ids_for_document_after" => api.relation_ids_for_document_after(&document_id, after_id.as_deref(), limit),
                    _ => api.event_ids_for_document_after(&document_id, after_id.as_deref(), limit),
                }.map_err(map_host_error)?;
                Ok(JsonValue::Array(ids.into_iter().map(string).collect()))
            }
            "list_evidence_ids_for_document_after" => {
                let document_id = required_string(params, "document_id")?;
                let after_id = params.get("after_id")
                    .map(|_| required_string(params, "after_id"))
                    .transpose()?;
                let limit = params.get("limit")
                    .map(|_| required_usize(params, "limit"))
                    .transpose()?.unwrap_or(100);
                let ids = self.api.as_mut().ok_or_else(not_initialized)?
                    .evidence_ids_for_document_after(&document_id, after_id.as_deref(), limit)
                    .map_err(map_host_error)?;
                Ok(JsonValue::Array(ids.into_iter().map(string).collect()))
            }
            "list_evidence_ids_for_document_page" => {
                let document_id = required_string(params, "document_id")?;
                let offset = params.get("offset")
                    .map(|_| required_usize(params, "offset"))
                    .transpose()?.unwrap_or(0);
                let limit = params.get("limit")
                    .map(|_| required_usize(params, "limit"))
                    .transpose()?.unwrap_or(100);
                let ids = self.api.as_mut().ok_or_else(not_initialized)?
                    .evidence_ids_for_document_page(&document_id, offset, limit)
                    .map_err(map_host_error)?;
                Ok(JsonValue::Array(ids.into_iter().map(string).collect()))
            }
            "status" => {
                let api = self.api.as_ref().ok_or_else(not_initialized)?;
                let metrics = api.metrics();
                Ok(object([
                    ("project_id", string(api.project_id())),
                    ("queue_capacity", number(metrics.queue_capacity)),
                    ("pending_load_percent", number(metrics.pending_load_percent)),
                    ("pending_changes", number(metrics.pending_changes)),
                    ("processed_changes", number(metrics.processed_changes)),
                    ("durable_commits", number(metrics.durable_commits)),
                    ("failed_changes", number(metrics.failed_changes)),
                    ("sample_count", number(metrics.sample_count)),
                    ("last_commit_micros", number(metrics.last_commit_micros)),
                    ("p50_commit_micros", number(metrics.p50_commit_micros)),
                    ("p95_commit_micros", number(metrics.p95_commit_micros)),
                    ("p99_commit_micros", number(metrics.p99_commit_micros)),
                    ("max_commit_micros", number(metrics.max_commit_micros)),
                    ("end_to_end_sample_count", number(metrics.end_to_end_sample_count)),
                    ("last_submit_to_durable_commit_micros", number(metrics.last_submit_to_durable_commit_micros)),
                    ("p50_submit_to_durable_commit_micros", number(metrics.p50_submit_to_durable_commit_micros)),
                    ("p95_submit_to_durable_commit_micros", number(metrics.p95_submit_to_durable_commit_micros)),
                    ("p99_submit_to_durable_commit_micros", number(metrics.p99_submit_to_durable_commit_micros)),
                    ("max_submit_to_durable_commit_micros", number(metrics.max_submit_to_durable_commit_micros)),
                    ("queue_full_rejections", number(metrics.queue_full_rejections)),
                    ("queued_paragraph_extractions", number(metrics.pending_paragraph_extractions)),
                    ("paragraph_queue_rejections", number(metrics.paragraph_queue_rejections)),
                    ("last_extraction_queue_wait_micros", number(metrics.last_extraction_queue_wait_micros)),
                    ("p50_extraction_queue_wait_micros", number(metrics.p50_extraction_queue_wait_micros)),
                    ("p95_extraction_queue_wait_micros", number(metrics.p95_extraction_queue_wait_micros)),
                    ("p99_extraction_queue_wait_micros", number(metrics.p99_extraction_queue_wait_micros)),
                    ("last_extraction_micros", number(metrics.last_extraction_micros)),
                    ("p50_extraction_micros", number(metrics.p50_extraction_micros)),
                    ("p95_extraction_micros", number(metrics.p95_extraction_micros)),
                    ("p99_extraction_micros", number(metrics.p99_extraction_micros)),
                    ("max_pending_changes", number(metrics.max_pending_changes)),
                    ("last_queue_wait_micros", number(metrics.last_queue_wait_micros)),
                    ("p50_queue_wait_micros", number(metrics.p50_queue_wait_micros)),
                    ("p95_queue_wait_micros", number(metrics.p95_queue_wait_micros)),
                    ("p99_queue_wait_micros", number(metrics.p99_queue_wait_micros)),
                    ("analysis_sample_count", number(self.analysis_samples.len())),
                    ("last_analysis_micros", number(self.last_analysis_micros)),
                    ("p50_analysis_micros", number(sample_percentile(&self.analysis_samples, 50))),
                    ("p95_analysis_micros", number(sample_percentile(&self.analysis_samples, 95))),
                    ("p99_analysis_micros", number(sample_percentile(&self.analysis_samples, 99))),
                    ("pending_tickets", number(self.tickets.len())),
                    ("pending_paragraph_extractions", number(self.paragraph_tickets.len())),
                    ("pending_analysis_jobs", number(self.analysis_tickets.len())),
                ]))
            }
            "shutdown" => {
                let Some(mut api) = self.api.take() else {
                    self.shutdown_requested = true;
                    self.analysis_executor.shutdown();
                    return Ok(status_object("already_stopped"));
                };
                self.shutdown_requested = true;
                api.shutdown().map_err(|error| ProtocolFault::new(
                    ERROR_WORKER_STOPPED,
                    format!("error al cerrar worker: {error:?}"),
                ))?;
                // El worker de escritura ya drenó las extracciones aceptadas;
                // ahora el pool puede terminar sus tareas y cerrar sin bloquearse.
                self.analysis_executor.shutdown();
                Ok(status_object("stopped"))
            }
            _ => Err(ProtocolFault::new(ERROR_METHOD_NOT_FOUND, "método no reconocido")),
        }
    }

    fn initialize(&mut self, params: &JsonValue) -> Result<JsonValue, ProtocolFault> {
        if self.api.is_some() {
            return Err(ProtocolFault::new(ERROR_ALREADY_INITIALIZED, "el proyecto ya está inicializado"));
        }
        let project_id = required_string(params, "project_id")?;
        let pages_path = required_string(params, "pages_path")?;
        let journal_path = required_string(params, "journal_path")?;
        let queue_capacity = required_usize(params, "queue_capacity")?;
        let knowledge_pages = optional_string(params, "knowledge_pages_path")?;
        let knowledge_journal = optional_string(params, "knowledge_journal_path")?;
        let api = match (knowledge_pages, knowledge_journal) {
            (Some(knowledge_pages), Some(knowledge_journal)) => HostEngineApi::open_with_knowledge(
                project_id, pages_path, journal_path, queue_capacity,
                knowledge_pages, knowledge_journal,
            ),
            (None, None) => HostEngineApi::open(project_id, pages_path, journal_path, queue_capacity),
            _ => return Err(ProtocolFault::new(
                ERROR_INVALID_PARAMS,
                "knowledge_pages_path y knowledge_journal_path deben proporcionarse juntos",
            )),
        }.map_err(map_host_error)?;
        let opened_project = api.project_id().to_owned();
        self.api = Some(api);
        Ok(object([
            ("status", string("initialized")),
            ("project_id", string(opened_project)),
            ("protocol_version", string("0.1.0")),
        ]))
    }
}

fn optional_u64(params: &JsonValue, key: &'static str) -> Result<Option<u64>, ProtocolFault> {
    match params.get(key) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some)
            .ok_or_else(|| ProtocolFault::new(ERROR_INVALID_PARAMS, format!("{key} debe ser un entero unsigned"))),
    }
}

fn optional_string(params: &JsonValue, key: &'static str) -> Result<Option<String>, ProtocolFault> {
    match params.get(key) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::String(value)) if !value.trim().is_empty() => Ok(Some(value.clone())),
        _ => Err(ProtocolFault::new(ERROR_INVALID_PARAMS, format!("{key} debe ser una cadena no vacía"))),
    }
}

fn optional_string_map(params: &JsonValue, key: &'static str) -> Result<Vec<(String, String)>, ProtocolFault> {
    match params.get(key) {
        None | Some(JsonValue::Null) => Ok(Vec::new()),
        Some(JsonValue::Object(values)) => values.iter().map(|(attribute, value)| {
            match value {
                JsonValue::String(value) => Ok((attribute.to_owned(), value.to_owned())),
                _ => Err(ProtocolFault::new(
                    ERROR_INVALID_PARAMS,
                    format!("{key}.{attribute} debe ser una cadena"),
                )),
            }
        }).collect(),
        _ => Err(ProtocolFault::new(ERROR_INVALID_PARAMS, format!("{key} debe ser un objeto de cadenas"))),
    }
}

fn optional_i64(params: &JsonValue, key: &'static str) -> Result<Option<i64>, ProtocolFault> {
    match params.get(key) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Number(value)) => value.parse::<i64>().map(Some)
            .map_err(|_| ProtocolFault::new(ERROR_INVALID_PARAMS, format!("{key} debe ser un entero signed"))),
        _ => Err(ProtocolFault::new(ERROR_INVALID_PARAMS, format!("{key} debe ser un entero o null"))),
    }
}

fn required_record_status(params: &JsonValue) -> Result<RecordStatus, ProtocolFault> {
    match required_string(params, "status")?.as_str() {
        "proposed" => Ok(RecordStatus::Proposed),
        "confirmed" => Ok(RecordStatus::Confirmed),
        "rejected" => Ok(RecordStatus::Rejected),
        "superseded" => Ok(RecordStatus::Superseded),
        _ => Err(ProtocolFault::new(
            ERROR_INVALID_PARAMS,
            "status debe ser proposed, confirmed, rejected o superseded",
        )),
    }
}

fn status_name(status: RecordStatus) -> &'static str {
    match status {
        RecordStatus::Proposed => "proposed",
        RecordStatus::Confirmed => "confirmed",
        RecordStatus::Rejected => "rejected",
        RecordStatus::Superseded => "superseded",
    }
}

fn entity_to_json(record: EntityRecord) -> JsonValue {
    let attributes = JsonValue::Object(record.attributes.into_iter()
        .map(|(key, value)| (key, JsonValue::String(value))).collect());
    object([
        ("id", string(record.id)),
        ("canonical_name", string(record.canonical_name)),
        ("entity_type", string(record.entity_type)),
        ("attributes", attributes),
        ("status", string(status_name(record.status))),
    ])
}

fn relation_to_json(record: RelationRecord) -> JsonValue {
    object([
        ("id", string(record.id)),
        ("subject_id", string(record.subject_id)),
        ("predicate", string(record.predicate)),
        ("object_id", string(record.object_id)),
        ("status", string(status_name(record.status))),
    ])
}

fn event_to_json(record: EventRecord) -> JsonValue {
    object([
        ("id", string(record.id)),
        ("label", string(record.label)),
        ("chronology_order", record.chronology_order.map(|value| number(value)).unwrap_or(JsonValue::Null)),
        ("status", string(status_name(record.status))),
    ])
}

fn evidence_to_json(record: EvidenceRecord) -> JsonValue {
    let target_kind = match record.target_kind {
        EvidenceTarget::Entity => "entity",
        EvidenceTarget::Relation => "relation",
        EvidenceTarget::Event => "event",
    };
    object([
        ("id", string(record.id)),
        ("target_kind", string(target_kind)),
        ("target_id", string(record.target_id)),
        ("document_id", string(record.document_id)),
        ("revision", number(record.revision)),
        ("start_byte", number(record.start_byte)),
        ("end_byte", number(record.end_byte)),
        ("excerpt", string(record.excerpt)),
        ("source_kind", string(record.source_kind)),
        ("stale", JsonValue::Bool(record.stale)),
    ])
}

fn usize_to_u64(value: usize) -> Result<u64, ProtocolFault> {
    u64::try_from(value).map_err(|_| ProtocolFault::new(ERROR_INVALID_PARAMS, "valor fuera del rango u64"))
}

fn parse_fragment_analysis(params: &JsonValue) -> Result<FragmentAnalysisRecord, ProtocolFault> {
    let repeated_words = match params.get("repeated_words") {
        Some(JsonValue::Array(values)) => values.iter().map(|value| {
            Ok(RepeatedWordRecord {
                normalized: required_string(value, "normalized")?,
                count: required_u64(value, "count")?,
                first_start_byte: required_u64(value, "first_start_byte")?,
            })
        }).collect::<Result<Vec<_>, ProtocolFault>>()?,
        _ => return Err(ProtocolFault::new(ERROR_INVALID_PARAMS, "repeated_words debe ser un array")),
    };
    let source_text = match params.get("source_text") {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::String(value)) => Some(value.clone()),
        Some(_) => return Err(ProtocolFault::new(ERROR_INVALID_PARAMS, "source_text debe ser una cadena")),
    };
    let start_byte = required_u64(params, "start_byte")?;
    let end_byte = required_u64(params, "end_byte")?;
    if source_text.as_ref().is_some_and(|text| {
        text.len() > MAX_FRAGMENT_ANALYSIS_BYTES
            || u64::try_from(text.len()).ok() != end_byte.checked_sub(start_byte)
    }) {
        return Err(ProtocolFault::new(
            ERROR_INVALID_PARAMS,
            "source_text debe coincidir con el rango UTF-8 y no superar 512 KiB",
        ));
    }
    Ok(FragmentAnalysisRecord {
        id: required_string(params, "id")?,
        document_id: required_string(params, "document_id")?,
        revision: required_u64(params, "revision")?,
        start_byte,
        end_byte,
        character_count: required_u64(params, "character_count")?,
        word_count: required_u64(params, "word_count")?,
        unique_word_count: required_u64(params, "unique_word_count")?,
        sentence_count: required_u64(params, "sentence_count")?,
        paragraph_count: required_u64(params, "paragraph_count")?,
        long_word_count: required_u64(params, "long_word_count")?,
        average_word_length_milli: required_u64(params, "average_word_length_milli")?,
        source_text,
        repeated_words,
    })
}

fn fragment_analysis_to_json(record: FragmentAnalysisRecord) -> JsonValue {
    let repeated_words = JsonValue::Array(record.repeated_words.into_iter().map(|word| object([
        ("normalized", string(word.normalized)),
        ("count", number(word.count)),
        ("first_start_byte", number(word.first_start_byte)),
    ])).collect());
    object([
        ("id", string(record.id)),
        ("document_id", string(record.document_id)),
        ("revision", number(record.revision)),
        ("start_byte", number(record.start_byte)),
        ("end_byte", number(record.end_byte)),
        ("character_count", number(record.character_count)),
        ("word_count", number(record.word_count)),
        ("unique_word_count", number(record.unique_word_count)),
        ("sentence_count", number(record.sentence_count)),
        ("paragraph_count", number(record.paragraph_count)),
        ("long_word_count", number(record.long_word_count)),
        ("average_word_length_milli", number(record.average_word_length_milli)),
        ("source_text", record.source_text.map(string).unwrap_or(JsonValue::Null)),
        ("repeated_words", repeated_words),
    ])
}

fn required_text(params: &JsonValue, key: &'static str) -> Result<String, ProtocolFault> {
    params.get(key).and_then(JsonValue::as_str).map(str::to_owned)
        .ok_or_else(|| ProtocolFault::new(ERROR_INVALID_PARAMS, format!("{key} debe ser una cadena")))
}

fn required_string(params: &JsonValue, key: &'static str) -> Result<String, ProtocolFault> {
    params.get(key).and_then(JsonValue::as_str).map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ProtocolFault::new(ERROR_INVALID_PARAMS, format!("{key} debe ser una cadena no vacía")))
}

fn required_u64(params: &JsonValue, key: &'static str) -> Result<u64, ProtocolFault> {
    params.get(key).and_then(JsonValue::as_u64)
        .ok_or_else(|| ProtocolFault::new(ERROR_INVALID_PARAMS, format!("{key} debe ser un entero unsigned")))
}

fn required_usize(params: &JsonValue, key: &'static str) -> Result<usize, ProtocolFault> {
    params.get(key).and_then(JsonValue::as_usize)
        .ok_or_else(|| ProtocolFault::new(ERROR_INVALID_PARAMS, format!("{key} está fuera de rango")))
}

fn not_initialized() -> ProtocolFault {
    ProtocolFault::new(ERROR_NOT_INITIALIZED, "inicializar el motor antes de usar este método")
}

fn map_engine_error(error: EngineError) -> ProtocolFault {
    ProtocolFault::new(ERROR_ENGINE, format!("{error:?}"))
}

fn map_ticket_error(error: TicketError) -> ProtocolFault {
    match error {
        TicketError::WorkerStopped => ProtocolFault::new(ERROR_WORKER_STOPPED, "worker detenido"),
        TicketError::QueueFull => ProtocolFault::new(ERROR_QUEUE_FULL, "cola llena; reintentar extracción de párrafo"),
        TicketError::Engine(error) => map_engine_error(error),
    }
}

fn map_evidence_error(error: HostApiError) -> ProtocolFault {
    match error {
        HostApiError::Ticket(TicketError::Engine(EngineError::EvidenceRevisionConflict {
            expected, received, last_sequence,
        })) => ProtocolFault::new(
            ERROR_REVISION_CONFLICT,
            "la evidencia pertenece a una revisión distinta de la revisión viva",
        ).with_data(object([
            ("expected_revision", number(expected)),
            ("current_revision", number(received)),
            ("last_sequence", number(last_sequence)),
        ])),
        HostApiError::Ticket(TicketError::Engine(EngineError::EvidenceExcerptMismatch)) =>
            ProtocolFault::new(ERROR_INVALID_PARAMS, "el extracto no coincide exactamente con el texto en los offsets indicados"),
        HostApiError::Ticket(TicketError::Engine(EngineError::InvalidRange)) =>
            ProtocolFault::new(ERROR_INVALID_PARAMS, "el rango de evidencia no es un rango UTF-8 válido"),
        other => map_host_error(other),
    }
}

fn map_analysis_error(error: HostApiError) -> ProtocolFault {
    match error {
        HostApiError::Ticket(TicketError::Engine(EngineError::AnalysisRevisionConflict {
            expected, received, last_sequence,
        })) => ProtocolFault::new(
            ERROR_REVISION_CONFLICT,
            "la revisión cambió antes del análisis; recalcular el rango sobre el snapshot actual",
        ).with_data(object([
            ("expected_revision", number(expected)),
            ("current_revision", number(received)),
            ("last_sequence", number(last_sequence)),
        ])),
        other => map_host_error(other),
    }
}

fn map_host_error(error: HostApiError) -> ProtocolFault {
    match error {
        HostApiError::Engine(error) => map_engine_error(error),
        HostApiError::Worker(WorkerError::InvalidQueueCapacity) => {
            ProtocolFault::new(ERROR_INVALID_PARAMS, "queue_capacity debe ser mayor que cero")
        }
        HostApiError::Worker(error) => ProtocolFault::new(ERROR_WORKER_STOPPED, format!("{error:?}")),
        HostApiError::Ticket(error) => map_ticket_error(error),
        HostApiError::Knowledge(error) => ProtocolFault::new(ERROR_ENGINE, format!("{error:?}")),
        HostApiError::KnowledgeNotConfigured => ProtocolFault::new(
            ERROR_INVALID_PARAMS,
            "el almacén de conocimiento no fue configurado en initialize",
        ),
    }
}

fn change_to_json(change: &crate::worker::PendingChange) -> JsonValue {
    object([
        ("document_id", string(&change.document_id)),
        ("sequence", number(change.sequence)),
        ("base_revision", number(change.base_revision)),
        ("start_byte", number(change.start_byte)),
        ("end_byte", number(change.end_byte)),
        ("replacement", string(&change.replacement)),
    ])
}

fn outcome_to_json(outcome: ApplyOutcome) -> JsonValue {
    match outcome {
        ApplyOutcome::Applied { revision, invalidated_suggestions } => object([
            ("status", string("applied")),
            ("revision", number(revision)),
            ("invalidated_suggestions", number(invalidated_suggestions)),
        ]),
        ApplyOutcome::Duplicate { revision } => object([
            ("status", string("duplicate")),
            ("revision", number(revision)),
        ]),
        ApplyOutcome::ResyncRequired { expected_sequence, received_sequence } => object([
            ("status", string("resync_required")),
            ("expected_sequence", number(expected_sequence)),
            ("received_sequence", number(received_sequence)),
        ]),
    }
}

fn sample_percentile(samples: &VecDeque<u64>, percentile: usize) -> u64 {
    if samples.is_empty() {
        return 0;
    }
    let mut sorted = samples.iter().copied().collect::<Vec<_>>();
    sorted.sort_unstable();
    let rank = (sorted.len() * percentile + 99) / 100;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

fn status_object(status: &str) -> JsonValue {
    object([("status", string(status))])
}

fn string(value: impl Into<String>) -> JsonValue {
    JsonValue::String(value.into())
}

fn number(value: impl ToString) -> JsonValue {
    JsonValue::Number(value.to_string())
}

fn object<const N: usize>(values: [(&str, JsonValue); N]) -> JsonValue {
    JsonValue::Object(values.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

fn response_result(id: JsonValue, result: JsonValue) -> String {
    json::stringify(&object([
        ("jsonrpc", string(JSON_RPC_VERSION)),
        ("id", id),
        ("result", result),
    ]))
}

fn response_error(id: JsonValue, error: ProtocolFault) -> String {
    let mut detail = BTreeMap::new();
    detail.insert("code".to_owned(), number(error.code));
    detail.insert("message".to_owned(), string(error.message));
    if let Some(data) = error.data {
        detail.insert("data".to_owned(), data);
    }
    json::stringify(&object([
        ("jsonrpc", string(JSON_RPC_VERSION)),
        ("id", id),
        ("error", JsonValue::Object(detail)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_PATH: AtomicU64 = AtomicU64::new(1);

    fn paths() -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "motor-literario-jsonrpc-{}-{}",
            std::process::id(),
            NEXT_PATH.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&root).unwrap();
        (root.clone(), root.join("store.pages"), root.join("store.mlpj"))
    }

    fn request(id: u64, method: &str, params: JsonValue) -> String {
        json::stringify(&object([
            ("jsonrpc", string("2.0")),
            ("id", number(id)),
            ("method", string(method)),
            ("params", params),
        ]))
    }

    #[test]
    fn jsonrpc_narrative_id_pages_return_ordered_bounded_results() {
        let mut server = JsonRpcServer::new();
        let (root, pages, journal) = paths();
        let knowledge_pages = root.join("knowledge.pages");
        let knowledge_journal = root.join("knowledge.mlpj");
        let initialized = server.handle_line(&request(1, "initialize", object([
            ("project_id", string("page-test-book")),
            ("pages_path", string(pages.to_string_lossy().to_string())),
            ("journal_path", string(journal.to_string_lossy().to_string())),
            ("queue_capacity", number(8)),
            ("knowledge_pages_path", string(knowledge_pages.to_string_lossy().to_string())),
            ("knowledge_journal_path", string(knowledge_journal.to_string_lossy().to_string())),
        ])));
        assert!(initialized.contains("\"initialized\""), "{initialized}");
        for (request_id, id) in [(2, "ana"), (3, "luis"), (4, "marta")] {
            let stored = server.handle_line(&request(request_id, "put_entity", object([
                ("id", string(id)),
                ("canonical_name", string(id)),
                ("entity_type", string("character")),
                ("status", string("confirmed")),
            ])));
            assert!(stored.contains("\"stored\""), "{stored}");
        }
        let opened = server.handle_line(&request(5, "open_document", object([
            ("document_id", string("chapter")),
            ("text", string("Ana Luis")),
            ("revision", number(1)),
            ("sequence", number(0)),
        ])));
        assert!(opened.contains("\"opened\""), "{opened}");
        for (request_id, id, target, start, end, excerpt) in [
            (6, "ev-ana-1", "ana", 0, 3, "Ana"),
            (7, "ev-ana-2", "ana", 0, 3, "Ana"),
            (8, "ev-luis-1", "luis", 4, 8, "Luis"),
        ] {
            let stored = server.handle_line(&request(request_id, "put_evidence", object([
                ("id", string(id)),
                ("target_kind", string("entity")),
                ("target_id", string(target)),
                ("document_id", string("chapter")),
                ("revision", number(1)),
                ("start_byte", number(start)),
                ("end_byte", number(end)),
                ("excerpt", string(excerpt)),
                ("source_kind", string("explicit_text")),
            ])));
            assert!(stored.contains("\"stored\""), "{stored}");
        }
        let first = server.handle_line(&request(9, "list_entity_ids_page", object([
            ("offset", number(0)), ("limit", number(2)),
        ])));
        let second = server.handle_line(&request(10, "list_entity_ids_page", object([
            ("offset", number(2)), ("limit", number(2)),
        ])));
        let beyond = server.handle_line(&request(11, "list_entity_ids_page", object([
            ("offset", number(3)), ("limit", number(1)),
        ])));
        let invalid = server.handle_line(&request(12, "list_entity_ids_page", object([
            ("offset", number(0)), ("limit", number(0)),
        ])));
        let cursor_first = server.handle_line(&request(17, "list_entity_ids_after", object([
            ("limit", number(2)),
        ])));
        let cursor_next = server.handle_line(&request(18, "list_entity_ids_after", object([
            ("after_id", string("luis")), ("limit", number(2)),
        ])));
        let cursor_last = server.handle_line(&request(19, "list_entity_ids_after", object([
            ("after_id", string("marta")), ("limit", number(2)),
        ])));
        let target_first = server.handle_line(&request(13, "list_entity_ids_for_document_page", object([
            ("document_id", string("chapter")), ("offset", number(0)), ("limit", number(1)),
        ])));
        let target_second = server.handle_line(&request(14, "list_entity_ids_for_document_page", object([
            ("document_id", string("chapter")), ("offset", number(1)), ("limit", number(1)),
        ])));
        let evidence_page = server.handle_line(&request(15, "list_evidence_ids_for_document_page", object([
            ("document_id", string("chapter")), ("offset", number(0)), ("limit", number(2)),
        ])));
        let evidence_cursor_first = server.handle_line(&request(20, "list_evidence_ids_for_document_after", object([
            ("document_id", string("chapter")), ("limit", number(2)),
        ])));
        let evidence_cursor_next = server.handle_line(&request(21, "list_evidence_ids_for_document_after", object([
            ("document_id", string("chapter")), ("after_id", string("ev-ana-2")), ("limit", number(2)),
        ])));
        let target_cursor_first = server.handle_line(&request(22, "list_entity_ids_for_document_after", object([
            ("document_id", string("chapter")), ("limit", number(1)),
        ])));
        let target_cursor_next = server.handle_line(&request(23, "list_entity_ids_for_document_after", object([
            ("document_id", string("chapter")), ("after_id", string("ana")), ("limit", number(1)),
        ])));
        let target_cursor_last = server.handle_line(&request(24, "list_entity_ids_for_document_after", object([
            ("document_id", string("chapter")), ("after_id", string("luis")), ("limit", number(1)),
        ])));
        assert!(first.contains("\"result\":[\"ana\",\"luis\"]"), "{first}");
        assert!(second.contains("\"result\":[\"marta\"]"), "{second}");
        assert!(beyond.contains("\"result\":[]"), "{beyond}");
        assert!(invalid.contains("-32030"), "{invalid}");
        assert!(cursor_first.contains("\"result\":[\"ana\",\"luis\"]"), "{cursor_first}");
        assert!(cursor_next.contains("\"result\":[\"marta\"]"), "{cursor_next}");
        assert!(cursor_last.contains("\"result\":[]"), "{cursor_last}");
        assert!(target_first.contains("\"result\":[\"ana\"]"), "{target_first}");
        assert!(target_second.contains("\"result\":[\"luis\"]"), "{target_second}");
        assert!(evidence_page.contains("\"result\":[\"ev-ana-1\",\"ev-ana-2\"]"), "{evidence_page}");
        assert!(evidence_cursor_first.contains("\"result\":[\"ev-ana-1\",\"ev-ana-2\"]"), "{evidence_cursor_first}");
        assert!(evidence_cursor_next.contains("\"result\":[\"ev-luis-1\"]"), "{evidence_cursor_next}");
        assert!(target_cursor_first.contains("\"result\":[\"ana\"]"), "{target_cursor_first}");
        assert!(target_cursor_next.contains("\"result\":[\"luis\"]"), "{target_cursor_next}");
        assert!(target_cursor_last.contains("\"result\":[]"), "{target_cursor_last}");

        for (request_id, id, revision, start, end) in [
            (30, "00-analysis-valid", 1, 0, 3),
            (31, "01-analysis-stale", 0, 0, 3),
            (32, "02-analysis-range", 1, 0, 99),
        ] {
            let stored = server.handle_line(&request(request_id, "put_fragment_analysis", object([
                ("id", string(id)),
                ("document_id", string("chapter")),
                ("revision", number(revision)),
                ("start_byte", number(start)),
                ("end_byte", number(end)),
                ("source_text", string(if end == 99 { "x".repeat(99) } else if id == "00-analysis-valid" { "Xna".to_owned() } else { "Ana".to_owned() })),
                ("character_count", number(3)),
                ("word_count", number(1)),
                ("unique_word_count", number(1)),
                ("sentence_count", number(1)),
                ("paragraph_count", number(1)),
                ("long_word_count", number(0)),
                ("average_word_length_milli", number(3_000)),
                ("repeated_words", JsonValue::Array(vec![])),
            ])));
            assert!(stored.contains("stored"), "{stored}");
        }
        let live_analysis_first = server.handle_line(&request(33, "audit_document_fragment_analyses", object([
            ("document_id", string("chapter")), ("limit", number(2)),
        ])));
        assert!(live_analysis_first.contains("\"scanned\":2"), "{live_analysis_first}");
        assert!(live_analysis_first.contains("\"has_more\":true"), "{live_analysis_first}");
        assert!(live_analysis_first.contains("\"next_after\":\"01-analysis-stale\""), "{live_analysis_first}");
        assert!(live_analysis_first.contains("fragment_analysis_revision_mismatch"), "{live_analysis_first}");
        assert!(live_analysis_first.contains("fragment_analysis_source_text_mismatch"), "{live_analysis_first}");
        let live_analysis_second = server.handle_line(&request(34, "audit_document_fragment_analyses", object([
            ("document_id", string("chapter")), ("after_id", string("01-analysis-stale")), ("limit", number(2)),
        ])));
        assert!(live_analysis_second.contains("\"scanned\":1"), "{live_analysis_second}");
        assert!(live_analysis_second.contains("\"has_more\":false"), "{live_analysis_second}");
        assert!(live_analysis_second.contains("fragment_analysis_invalid_range"), "{live_analysis_second}");

        let pre_resync_analysis = server.handle_line(&request(35, "put_fragment_analysis", object([
            ("id", string("03-analysis-resync")),
            ("document_id", string("chapter")),
            ("revision", number(1)),
            ("start_byte", number(0)),
            ("end_byte", number(3)),
            ("source_text", string("Ana")),
            ("character_count", number(3)),
            ("word_count", number(1)),
            ("unique_word_count", number(1)),
            ("sentence_count", number(1)),
            ("paragraph_count", number(1)),
            ("long_word_count", number(0)),
            ("average_word_length_milli", number(3_000)),
            ("repeated_words", JsonValue::Array(vec![])),
        ])));
        assert!(pre_resync_analysis.contains("stored"), "{pre_resync_analysis}");
        let resynchronized = server.handle_line(&request(36, "resynchronize", object([
            ("document_id", string("chapter")),
            ("text", string("Ema Luis")),
            // Misma revisión y secuencia, pero snapshot autoritativo distinto:
            // la procedencia textual debe detectar el cambio de época.
            ("revision", number(1)),
            ("sequence", number(0)),
        ])));
        assert!(resynchronized.contains("resynchronized"), "{resynchronized}");
        let post_resync_analysis_audit = server.handle_line(&request(37, "audit_document_fragment_analyses", object([
            ("document_id", string("chapter")),
            ("after_id", string("02-analysis-range")),
            ("limit", number(2)),
        ])));
        assert!(post_resync_analysis_audit.contains("\"scanned\":1"), "{post_resync_analysis_audit}");
        assert!(post_resync_analysis_audit.contains("fragment_analysis_source_text_mismatch"), "{post_resync_analysis_audit}");

        let audit_entities = server.handle_line(&request(25, "audit_knowledge_integrity", object([
            ("table", string("entity")), ("limit", number(2)),
        ])));
        assert!(audit_entities.contains("\"scanned\":2"), "{audit_entities}");
        assert!(audit_entities.contains("\"has_more\":true"), "{audit_entities}");
        assert!(audit_entities.contains("\"next_after\":\"luis\""), "{audit_entities}");
        assert!(audit_entities.contains("\"issues\":[]"), "{audit_entities}");
        let audit_entities_next = server.handle_line(&request(26, "audit_knowledge_integrity", object([
            ("table", string("entity")), ("after_id", string("luis")), ("limit", number(2)),
        ])));
        assert!(audit_entities_next.contains("\"scanned\":1"), "{audit_entities_next}");
        assert!(audit_entities_next.contains("\"has_more\":false"), "{audit_entities_next}");
        let stored_analysis = server.handle_line(&request(29, "put_fragment_analysis", object([
            ("id", string("analysis-a")),
            ("document_id", string("chapter-1")),
            ("revision", number(10)),
            ("start_byte", number(0)),
            ("end_byte", number(8)),
            ("source_text", string("12345678")),
            ("character_count", number(8)),
            ("word_count", number(1)),
            ("unique_word_count", number(1)),
            ("sentence_count", number(1)),
            ("paragraph_count", number(1)),
            ("long_word_count", number(0)),
            ("average_word_length_milli", number(8_000)),
            ("repeated_words", JsonValue::Array(vec![])),
        ])));
        assert!(stored_analysis.contains("stored"), "{stored_analysis}");
        let audit_fragment_analysis = server.handle_line(&request(28, "audit_knowledge_integrity", object([
            ("table", string("fragment_analysis")),
        ])));
        assert!(audit_fragment_analysis.contains("\"scanned\":5"), "{audit_fragment_analysis}");
        assert!(audit_fragment_analysis.contains("\"has_more\":false"), "{audit_fragment_analysis}");
        assert!(audit_fragment_analysis.contains("\"issues\":[]"), "{audit_fragment_analysis}");
        let audit_invalid_table = server.handle_line(&request(27, "audit_knowledge_integrity", object([
            ("table", string("not-a-table")),
        ])));
        assert!(audit_invalid_table.contains("-32030"), "{audit_invalid_table}");

        let _ = server.handle_line(&request(16, "shutdown", JsonValue::Object(BTreeMap::new())));
        drop(server);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fragment_analysis_provenance_survives_wal_recovery_and_detects_old_revision() {
        let (root, pages, journal) = paths();
        let knowledge_pages = root.join("knowledge.pages");
        let knowledge_journal = root.join("knowledge.mlpj");
        let initialize = || object([
            ("project_id", string("fragment-analysis-recovery")),
            ("pages_path", string(pages.to_string_lossy().to_string())),
            ("journal_path", string(journal.to_string_lossy().to_string())),
            ("queue_capacity", number(8)),
            ("knowledge_pages_path", string(knowledge_pages.to_string_lossy().to_string())),
            ("knowledge_journal_path", string(knowledge_journal.to_string_lossy().to_string())),
        ]);

        {
            let mut server = JsonRpcServer::new();
            let initialized = server.handle_line(&request(1, "initialize", initialize()));
            assert!(initialized.contains("initialized"), "{initialized}");
            let opened = server.handle_line(&request(2, "open_document", object([
                ("document_id", string("chapter")),
                ("text", string("Ana")),
                ("revision", number(1)),
                ("sequence", number(0)),
            ])));
            assert!(opened.contains("opened"), "{opened}");
            let stored = server.handle_line(&request(3, "put_fragment_analysis", object([
                ("id", string("before-restart")),
                ("document_id", string("chapter")),
                ("revision", number(1)),
                ("start_byte", number(0)),
                ("end_byte", number(3)),
                ("source_text", string("Ana")),
                ("character_count", number(3)),
                ("word_count", number(1)),
                ("unique_word_count", number(1)),
                ("sentence_count", number(1)),
                ("paragraph_count", number(1)),
                ("long_word_count", number(0)),
                ("average_word_length_milli", number(3_000)),
                ("repeated_words", JsonValue::Array(vec![])),
            ])));
            assert!(stored.contains("stored"), "{stored}");
            let changed = server.handle_line(&request(4, "editor_change", object([
                ("document_id", string("chapter")),
                ("sequence", number(1)),
                ("base_revision", number(1)),
                ("start_byte", number(3)),
                ("end_byte", number(3)),
                ("replacement", string("!")),
            ])));
            assert!(changed.contains("queued"), "{changed}");
            // snapshot es una barrera FIFO: espera a que el delta quede durable.
            let snapshot = server.handle_line(&request(5, "snapshot", object([
                ("document_id", string("chapter")),
            ])));
            assert!(snapshot.contains("\"revision\":2"), "{snapshot}");
            assert!(snapshot.contains("\"last_sequence\":1"), "{snapshot}");
            let committed = server.handle_line(&request(6, "poll_commit", object([
                ("ticket_id", string("4")),
            ])));
            assert!(committed.contains("applied"), "{committed}");
            let stopped = server.handle_line(&request(7, "shutdown", JsonValue::Object(BTreeMap::new())));
            assert!(stopped.contains("stopped"), "{stopped}");
        }

        {
            let mut server = JsonRpcServer::new();
            let initialized = server.handle_line(&request(8, "initialize", initialize()));
            assert!(initialized.contains("initialized"), "{initialized}");
            // El anfitrión entrega su último snapshot guardado; el motor reproduce
            // el delta WAL que quedó durable antes del cierre anterior.
            let opened = server.handle_line(&request(9, "open_document", object([
                ("document_id", string("chapter")),
                ("text", string("Ana")),
                ("revision", number(1)),
                ("sequence", number(0)),
            ])));
            assert!(opened.contains("opened"), "{opened}");
            let recovered = server.handle_line(&request(10, "snapshot", object([
                ("document_id", string("chapter")),
            ])));
            assert!(recovered.contains("\"text\":\"Ana!\""), "{recovered}");
            assert!(recovered.contains("\"revision\":2"), "{recovered}");
            let audit = server.handle_line(&request(11, "audit_document_fragment_analyses", object([
                ("document_id", string("chapter")),
                ("limit", number(10)),
            ])));
            assert!(audit.contains("fragment_analysis_revision_mismatch"), "{audit}");
            assert!(audit.contains("\"scanned\":1"), "{audit}");
            let _ = server.handle_line(&request(12, "shutdown", JsonValue::Object(BTreeMap::new())));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn capabilities_are_available_before_project_initialization() {
        let mut server = JsonRpcServer::new();
        let response = server.handle_line(&request(
            1,
            "get_capabilities",
            JsonValue::Object(BTreeMap::new()),
        ));
        assert!(response.contains("live_monitoring"));
        assert!(response.contains("semantic_analysis"));
        assert!(response.contains("stdio_json_lines"));
        assert!(response.contains("document_scoped_analysis_history"));
        assert!(response.contains("async_paragraph_extraction"));
        assert!(response.contains("max_analysis_cache_bytes"));
        assert!(response.contains("end_to_end_write_latency_metrics"));
        assert!(response.contains("automatic_evidence_rebase_after_commit"));
        assert!(response.contains("persistent_stale_evidence"));
        assert!(response.contains("conservative_evidence_recovery"));
        assert!(response.contains("durable_evidence_history_recovery"));
        assert!(response.contains("fragment_analysis_source_provenance"));
        assert!(response.contains("max_fragment_analysis_source_bytes"));
        assert!(response.contains("max_durable_evidence_history_changes"));
        assert!(response.contains("max_evidence_history_transform_steps"));
        assert!(response.contains("evidence_history_write_batch_records"));
        assert!(response.contains("knowledge_cursor_pagination"));
        assert!(response.contains("knowledge_integrity_audit"));
        assert!(response.contains("document_fragment_analysis_integrity_audit"));
        assert!(response.contains("document_scoped_evidence_index"));
        assert!(response.contains("document_scoped_target_index"));
        assert!(response.contains("knowledge_cursor_is_exclusive"));
        assert!(response.contains("max_knowledge_page_size"));
    }

    #[test]
    fn accepted_edit_cancels_only_superseded_analysis_for_same_document() {
        let mut server = JsonRpcServer::new();
        let (sender_a, receiver_a) = mpsc::channel();
        let (sender_b, receiver_b) = mpsc::channel();
        let (sender_c, receiver_c) = mpsc::channel();
        server.analysis_tickets.insert("a".into(), AnalysisJobTicket {
            receiver: receiver_a,
            cancelled: Arc::new(AtomicBool::new(false)),
            document_id: "chapter-a".into(),
            expected_revision: 4,
        });
        server.analysis_tickets.insert("b".into(), AnalysisJobTicket {
            receiver: receiver_b,
            cancelled: Arc::new(AtomicBool::new(false)),
            document_id: "chapter-b".into(),
            expected_revision: 4,
        });
        server.analysis_tickets.insert("c".into(), AnalysisJobTicket {
            receiver: receiver_c,
            cancelled: Arc::new(AtomicBool::new(false)),
            document_id: "chapter-a".into(),
            expected_revision: 6,
        });

        assert_eq!(server.cancel_superseded_analyses("chapter-a", 4), 1);
        assert!(server.analysis_tickets["a"].cancelled.load(Ordering::Acquire));
        assert!(!server.analysis_tickets["b"].cancelled.load(Ordering::Acquire));
        assert!(!server.analysis_tickets["c"].cancelled.load(Ordering::Acquire));
        assert_eq!(server.cancel_superseded_analyses("chapter-a", 4), 0);
        assert_eq!(server.cancel_all_analyses_for_document("chapter-b"), 1);
        assert!(server.analysis_tickets["b"].cancelled.load(Ordering::Acquire));
        assert!(server.analysis_tickets["a"].cancelled.load(Ordering::Acquire));
        assert!(!server.analysis_tickets["c"].cancelled.load(Ordering::Acquire));

        drop(sender_a);
        drop(sender_b);
        drop(sender_c);
    }

    #[test]
    fn analysis_executor_survives_a_panicking_task_and_shuts_down() {
        use std::time::Duration;

        let executor = AnalysisExecutor::new();
        assert!(executor.try_submit(Arc::new(AtomicBool::new(false)), Box::new(|| panic!("fallo de tarea simulado"))).is_ok());
        let (sender, receiver) = mpsc::channel();
        assert!(executor.try_submit(Arc::new(AtomicBool::new(false)), Box::new(move || sender.send(()).unwrap())).is_ok());
        receiver.recv_timeout(Duration::from_secs(2))
            .expect("el pool debe seguir atendiendo tareas después de un panic");
        drop(executor);
    }

    #[test]
    fn analysis_executor_discards_cancelled_queued_tasks_and_reuses_capacity() {
        use std::time::Duration;

        let executor = AnalysisExecutor::new();
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let release_receiver = Arc::new(Mutex::new(release_receiver));
        for _ in 0..ANALYSIS_WORKER_THREADS {
            let started_sender = started_sender.clone();
            let release_receiver = Arc::clone(&release_receiver);
            assert!(executor.try_submit(
                Arc::new(AtomicBool::new(false)),
                Box::new(move || {
                    started_sender.send(()).unwrap();
                    let receiver = release_receiver.lock().unwrap();
                    let _ = receiver.recv();
                }),
            ).is_ok());
        }
        for _ in 0..ANALYSIS_WORKER_THREADS {
            started_receiver.recv_timeout(Duration::from_secs(2))
                .expect("ambos trabajadores deben estar ocupados");
        }

        let mut flags = Vec::new();
        let (completed_sender, completed_receiver) = mpsc::channel();
        for id in 0..MAX_PENDING_ANALYSIS_JOBS {
            let cancelled = Arc::new(AtomicBool::new(false));
            let task_cancelled = Arc::clone(&cancelled);
            let completed_sender = completed_sender.clone();
            assert!(executor.try_submit(cancelled.clone(), Box::new(move || {
                completed_sender.send(id).unwrap();
            })).is_ok());
            flags.push(task_cancelled);
        }

        flags[0].store(true, Ordering::Release);
        flags[1].store(true, Ordering::Release);
        assert_eq!(executor.discard_cancelled_queued(), 2);

        let (replacement_sender, replacement_receiver) = mpsc::channel();
        for id in 10..12 {
            let replacement_sender = replacement_sender.clone();
            assert!(executor.try_submit(
                Arc::new(AtomicBool::new(false)),
                Box::new(move || replacement_sender.send(id).unwrap()),
            ).is_ok());
        }
        assert!(matches!(
            executor.try_submit(Arc::new(AtomicBool::new(false)), Box::new(|| {})),
            Err(AnalysisSubmitError::Full),
        ));

        release_sender.send(()).unwrap();
        release_sender.send(()).unwrap();
        drop(completed_sender);
        let mut completed = vec![
            completed_receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
            completed_receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
        ];
        completed.sort_unstable();
        assert_eq!(completed, vec![2, 3]);
        let mut replacements = vec![
            replacement_receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
            replacement_receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
        ];
        replacements.sort_unstable();
        assert_eq!(replacements, vec![10, 11]);
        drop(executor);
    }

    #[test]
    fn analysis_executor_shutdown_drains_all_accepted_tasks() {
        let executor = AnalysisExecutor::new();
        let (sender, receiver) = mpsc::channel();
        for id in 0..MAX_PENDING_ANALYSIS_JOBS {
            let sender = sender.clone();
            assert!(executor.try_submit(Arc::new(AtomicBool::new(false)), Box::new(move || sender.send(id).unwrap())).is_ok());
        }
        drop(sender);
        drop(executor);
        assert_eq!(receiver.try_iter().count(), MAX_PENDING_ANALYSIS_JOBS);
    }

    #[test]
    fn queued_analysis_is_cancelled_before_extraction_wait_when_edit_is_accepted() {
        use std::time::{Duration, Instant};

        let (root, pages, wal) = paths();
        let mut server = JsonRpcServer::new();
        let initialized = server.handle_line(&request(1, "initialize", object([
            ("project_id", string("protocol-analysis-cancel")),
            ("pages_path", string(pages.to_string_lossy().into_owned())),
            ("journal_path", string(wal.to_string_lossy().into_owned())),
            ("queue_capacity", number(8)),
            ("knowledge_pages_path", string(root.join("knowledge.pages").to_string_lossy().into_owned())),
            ("knowledge_journal_path", string(root.join("knowledge.journal").to_string_lossy().into_owned())),
        ])));
        assert!(initialized.contains("\"initialized\""), "{initialized}");
        let status = server.handle_line(&request(15, "status", object([])));
        assert!(status.contains("\"queue_capacity\":8"), "{status}");
        assert!(status.contains("\"pending_load_percent\":0"), "{status}");
        assert!(status.contains("\"pending_changes\":0"), "{status}");
        let opened = server.handle_line(&request(2, "open_document", object([
            ("document_id", string("chapter")),
            ("text", string("Texto original")),
            ("revision", number(0)),
            ("sequence", number(0)),
        ])));
        assert!(opened.contains("\"opened\""), "{opened}");

        // Ocupar ambos trabajadores para que la solicitud analítica permanezca
        // en la cola hasta que la edición posterior la marque como obsoleta.
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let release_receiver = Arc::new(Mutex::new(release_receiver));
        for _ in 0..ANALYSIS_WORKER_THREADS {
            let started_sender = started_sender.clone();
            let release_receiver = Arc::clone(&release_receiver);
            assert!(server.analysis_executor.try_submit(Arc::new(AtomicBool::new(false)), Box::new(move || {
                started_sender.send(()).unwrap();
                let receiver = release_receiver.lock().unwrap();
                let _ = receiver.recv();
            })).is_ok());
        }
        for _ in 0..ANALYSIS_WORKER_THREADS {
            started_receiver.recv_timeout(Duration::from_secs(2))
                .expect("los dos trabajadores deben quedar ocupados");
        }

        for id in 3..(3 + MAX_PENDING_ANALYSIS_JOBS as i64) {
            let queued = server.handle_line(&request(id, "request_analyze_affected_paragraph", object([
                ("document_id", string("chapter")),
                ("selection_start_byte", number(0)),
                ("selection_end_byte", number(6)),
                ("expected_revision", number(0)),
            ])));
            assert!(queued.contains("\"queued\""), "id={id}: {queued}");
        }
        let edit = server.handle_line(&request(7, "editor_change", object([
            ("document_id", string("chapter")),
            ("sequence", number(1)),
            ("base_revision", number(0)),
            ("start_byte", number(0)),
            ("end_byte", number(0)),
            ("replacement", string("Nuevo ")),
        ])));
        assert!(edit.contains("\"queued\""), "{edit}");

        // Las cuatro tareas obsoletas deben salir físicamente de la cola. Así
        // una solicitud vigente puede entrar aunque ambos hilos sigan ocupados.
        for id in 3..(3 + MAX_PENDING_ANALYSIS_JOBS as i64) {
            let stale = server.handle_line(&request(20 + id, "poll_analyze_affected_paragraph", object([
                ("ticket_id", string(format!("n:{id}"))),
                ("analysis_id", string(format!("cancelled-before-analysis-{id}"))),
            ])));
            assert!(stale.contains("\"status\":\"stale\""), "id={id}: {stale}");
            assert!(stale.contains("\"persisted\":false"), "{stale}");
            assert!(stale.contains("\"reason\":\"superseded_by_edit\""), "{stale}");
        }
        assert_eq!(server.analysis_tickets.len(), 0);

        let current = server.handle_line(&request(8, "request_analyze_affected_paragraph", object([
            ("document_id", string("chapter")),
            ("selection_start_byte", number(0)),
            ("selection_end_byte", number(6)),
            ("expected_revision", number(1)),
        ])));
        assert!(current.contains("\"queued\""), "vigent analysis was blocked by stale queue entries: {current}");

        release_sender.send(()).unwrap();
        release_sender.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);

        let committed = loop {
            let response = server.handle_line(&request(9, "poll_commit", object([
                ("ticket_id", string("n:7")),
            ])));
            if response.contains("\"applied\"") { break response; }
            assert!(response.contains("\"pending\""), "unexpected second commit: {response}");
            assert!(Instant::now() < deadline, "accepted edit did not commit");
            std::thread::yield_now();
        };
        assert!(committed.contains("\"revision\":1"), "{committed}");

        let ready = loop {
            let response = server.handle_line(&request(10, "poll_analyze_affected_paragraph", object([
                ("ticket_id", string("n:8")),
                ("analysis_id", string("current-revision-analysis")),
            ])));
            if response.contains("\"status\":\"ready\"") { break response; }
            assert!(response.contains("\"pending\""), "unexpected second commit: {response}");
            assert!(Instant::now() < deadline, "current analysis did not finish");
            std::thread::yield_now();
        };
        assert!(ready.contains("\"persisted\":true"), "{ready}");

        // Cerrar un documento también invalida y retira análisis en cola.
        let (close_started, close_started_rx) = mpsc::channel();
        let (close_release, close_release_rx) = mpsc::channel();
        let close_release_rx = Arc::new(Mutex::new(close_release_rx));
        for _ in 0..ANALYSIS_WORKER_THREADS {
            let started = close_started.clone();
            let release = Arc::clone(&close_release_rx);
            assert!(server.analysis_executor.try_submit(
                Arc::new(AtomicBool::new(false)),
                Box::new(move || {
                    started.send(()).unwrap();
                    let receiver = release.lock().unwrap();
                    let _ = receiver.recv();
                }),
            ).is_ok());
        }
        for _ in 0..ANALYSIS_WORKER_THREADS {
            close_started_rx.recv_timeout(Duration::from_secs(2))
                .expect("los trabajadores deben quedar ocupados antes del cierre");
        }
        let before_close = server.handle_line(&request(11, "request_analyze_affected_paragraph", object([
            ("document_id", string("chapter")),
            ("selection_start_byte", number(0)),
            ("selection_end_byte", number(5)),
            ("expected_revision", number(1)),
        ])));
        assert!(before_close.contains("\"queued\""), "{before_close}");
        let closed = server.handle_line(&request(12, "close_document", object([
            ("document_id", string("chapter")),
        ])));
        assert!(closed.contains("\"closed\""), "{closed}");
        let closed_stale = server.handle_line(&request(13, "poll_analyze_affected_paragraph", object([
            ("ticket_id", string("n:11")),
            ("analysis_id", string("cancelled-by-close")),
        ])));
        assert!(closed_stale.contains("\"status\":\"stale\""), "{closed_stale}");
        assert!(closed_stale.contains("\"persisted\":false"), "{closed_stale}");
        assert_eq!(server.analysis_tickets.len(), 0);
        close_release.send(()).unwrap();
        close_release.send(()).unwrap();

        assert!(server.handle_line(&request(14, "shutdown", JsonValue::Object(BTreeMap::new())))
            .contains("stopped"));
        drop(server);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn async_analysis_enforces_concurrency_limit_and_releases_capacity() {
        use std::time::{Duration, Instant};

        let (root, pages, wal) = paths();
        let mut server = JsonRpcServer::new();
        let initialized = server.handle_line(&request(1, "initialize", object([
            ("project_id", string("protocol-analysis-capacity")),
            ("pages_path", string(pages.to_string_lossy().into_owned())),
            ("journal_path", string(wal.to_string_lossy().into_owned())),
            ("queue_capacity", number(8)),
            ("knowledge_pages_path", string(root.join("knowledge.pages").to_string_lossy().into_owned())),
            ("knowledge_journal_path", string(root.join("knowledge.mlpj").to_string_lossy().into_owned())),
        ])));
        assert!(initialized.contains("\"initialized\""), "{initialized}");
        let opened = server.handle_line(&request(2, "open_document", object([
            ("document_id", string("chapter")),
            ("text", string("Uno. Dos. Tres.")),
            ("revision", number(0)),
            ("sequence", number(0)),
        ])));
        assert!(opened.contains("\"opened\""), "{opened}");

        let capabilities = server.handle_line(&request(8, "get_capabilities", object([])));
        assert!(capabilities.contains("\"max_pending_analysis_jobs\":4"), "{capabilities}");
        assert!(capabilities.contains("\"max_concurrent_analysis_jobs\":2"), "{capabilities}");
        assert!(capabilities.contains("\"fixed_analysis_worker_pool\":true"), "{capabilities}");
        assert!(capabilities.contains("\"cancel_stale_analysis_on_edit\":true"), "{capabilities}");
        assert!(capabilities.contains("\"discard_cancelled_queued_analysis\":true"), "{capabilities}");
        assert!(capabilities.contains("\"cooperative_analysis_cancellation\":true"), "{capabilities}");
        assert!(capabilities.contains("\"knowledge_integrity_audit\":true"), "{capabilities}");
        assert!(capabilities.contains("\"document_evidence_integrity_audit\":true"), "{capabilities}");
        assert!(capabilities.contains("\"fragment_analysis_source_provenance\":true"), "{capabilities}");
        assert!(capabilities.contains("\"max_fragment_analysis_source_bytes\":524288"), "{capabilities}");

        for id in 10..(10 + MAX_PENDING_ANALYSIS_JOBS as i64) {
            let queued = server.handle_line(&request(id, "request_analyze_affected_paragraph", object([
                ("document_id", string("chapter")),
                ("selection_start_byte", number(0)),
                ("selection_end_byte", number(0)),
                ("expected_revision", number(0)),
            ])));
            assert!(queued.contains("\"queued\""), "id={id}: {queued}");
        }
        let rejected = server.handle_line(&request(99, "request_analyze_affected_paragraph", object([
            ("document_id", string("chapter")),
            ("selection_start_byte", number(0)),
            ("selection_end_byte", number(0)),
            ("expected_revision", number(0)),
        ])));
        assert!(rejected.contains("-32041"), "{rejected}");

        let deadline = Instant::now() + Duration::from_secs(5);
        for id in 10..(10 + MAX_PENDING_ANALYSIS_JOBS as i64) {
            loop {
                let response = server.handle_line(&request(100 + id, "poll_analyze_affected_paragraph", object([
                    ("ticket_id", string(format!("n:{id}"))),
                    ("analysis_id", string(format!("capacity-{id}"))),
                ])));
                if response.contains("\"status\":\"ready\"") { break; }
            assert!(response.contains("\"pending\""), "unexpected second commit: {response}");
                assert!(Instant::now() < deadline, "análisis {id} no terminó a tiempo");
                thread::yield_now();
            }
        }
        let status = server.handle_line(&request(200, "status", object([])));
        assert!(status.contains("\"pending_analysis_jobs\":0"), "{status}");
        let accepted_after_release = server.handle_line(&request(201, "request_analyze_affected_paragraph", object([
            ("document_id", string("chapter")),
            ("selection_start_byte", number(0)),
            ("selection_end_byte", number(0)),
            ("expected_revision", number(0)),
        ])));
        assert!(accepted_after_release.contains("\"queued\""), "{accepted_after_release}");
        loop {
            let response = server.handle_line(&request(202, "poll_analyze_affected_paragraph", object([
                ("ticket_id", string("n:201")),
                ("analysis_id", string("capacity-after-release")),
            ])));
            if response.contains("\"status\":\"ready\"") { break; }
            assert!(response.contains("\"pending\""), "unexpected second commit: {response}");
            assert!(Instant::now() < deadline, "el análisis posterior al límite no terminó");
            thread::yield_now();
        }
        let final_status = server.handle_line(&request(203, "status", object([])));
        assert!(final_status.contains("\"pending_analysis_jobs\":0"), "{final_status}");

        drop(server);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn async_paragraph_analysis_returns_and_persists_a_revision_bound_result() {
        use std::time::{Duration, Instant};

        let (root, pages, wal) = paths();
        let mut server = JsonRpcServer::new();
        let initialized = server.handle_line(&request(1, "initialize", object([
            ("project_id", string("protocol-async-analysis")),
            ("pages_path", string(pages.to_string_lossy().into_owned())),
            ("journal_path", string(wal.to_string_lossy().into_owned())),
            ("queue_capacity", number(8)),
            ("knowledge_pages_path", string(root.join("knowledge.pages").to_string_lossy().into_owned())),
            ("knowledge_journal_path", string(root.join("knowledge.mlpj").to_string_lossy().into_owned())),
        ])));
        assert!(initialized.contains("\"initialized\""), "{initialized}");

        let opened = server.handle_line(&request(2, "open_document", object([
            ("document_id", string("chapter")),
            ("text", string("Ana llegó. Ana sonrió.")),
            ("revision", number(0)),
            ("sequence", number(0)),
        ])));
        assert!(opened.contains("\"opened\""), "{opened}");

        let queued = server.handle_line(&request(3, "request_analyze_affected_paragraph", object([
            ("document_id", string("chapter")),
            ("selection_start_byte", number(5)),
            ("selection_end_byte", number(5)),
            ("expected_revision", number(0)),
        ])));
        assert!(queued.contains("\"queued\""), "{queued}");

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut completed = String::new();
        loop {
            completed = server.handle_line(&request(4, "poll_analyze_affected_paragraph", object([
                ("ticket_id", string("n:3")),
                ("analysis_id", string("analysis-1")),
            ])));
            if completed.contains("\"ready\"") || completed.contains("\"stale\"") {
                break;
            }
            assert!(Instant::now() < deadline, "el análisis asíncrono no terminó: {completed}");
            thread::yield_now();
        }

        assert!(completed.contains("\"ready\""), "{completed}");
        assert!(completed.contains("\"persisted\":true"), "{completed}");
        assert!(completed.contains("\"word_count\":4"), "{completed}");
        assert!(completed.contains("\"analysis_id\":\"analysis-1\""), "{completed}");
        let status = server.handle_line(&request(7, "status", object([])));
        assert!(status.contains("\"pending_analysis_jobs\":0"), "{status}");

        drop(server);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn async_paragraph_analysis_rejects_result_after_document_revision_changes() {
        use std::time::{Duration, Instant};

        let (root, pages, wal) = paths();
        let mut server = JsonRpcServer::new();
        let initialized = server.handle_line(&request(1, "initialize", object([
            ("project_id", string("protocol-stale-analysis")),
            ("pages_path", string(pages.to_string_lossy().into_owned())),
            ("journal_path", string(wal.to_string_lossy().into_owned())),
            ("queue_capacity", number(8)),
            ("knowledge_pages_path", string(root.join("knowledge.pages").to_string_lossy().into_owned())),
            ("knowledge_journal_path", string(root.join("knowledge.mlpj").to_string_lossy().into_owned())),
        ])));
        assert!(initialized.contains("\"initialized\""), "{initialized}");

        // No dependemos de pausas temporales: la extracción se encola antes
        // que el delta y el test espera su confirmación antes de consultar el
        // análisis. La barrera FIFO de fragment_matches debe observar la revisión 1.
        let text = "palabra ".repeat(50_000);
        let opened = server.handle_line(&request(2, "open_document", object([
            ("document_id", string("chapter")),
            ("text", string(text.clone())),
            ("revision", number(0)),
            ("sequence", number(0)),
        ])));
        assert!(opened.contains("\"opened\""), "{opened}");

        let queued_analysis = server.handle_line(&request(3, "request_analyze_affected_paragraph", object([
            ("document_id", string("chapter")),
            ("selection_start_byte", number(5)),
            ("selection_end_byte", number(5)),
            ("expected_revision", number(0)),
        ])));
        assert!(queued_analysis.contains("\"queued\""), "{queued_analysis}");
        let queued_change = server.handle_line(&request(5, "editor_change", object([
            ("document_id", string("chapter")),
            ("sequence", number(1)),
            ("base_revision", number(0)),
            ("start_byte", number(text.len())),
            ("end_byte", number(text.len())),
            ("replacement", string("!")),
        ])));
        assert!(queued_change.contains("\"queued\""), "{queued_change}");

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut committed = String::new();
        loop {
            committed = server.handle_line(&request(6, "poll_commit", object([
                ("ticket_id", string("n:5")),
            ])));
            if committed.contains("\"applied\"") || committed.contains("\"duplicate\"") {
                break;
            }
            assert!(Instant::now() < deadline, "el cambio no se confirmó: {committed}");
            thread::yield_now();
        }

        let mut completed = String::new();
        loop {
            completed = server.handle_line(&request(4, "poll_analyze_affected_paragraph", object([
                ("ticket_id", string("n:3")),
                ("analysis_id", string("analysis-stale")),
            ])));
            if completed.contains("\"stale\"") || completed.contains("\"ready\"") {
                break;
            }
            assert!(Instant::now() < deadline, "el análisis no terminó: {completed}");
            thread::yield_now();
        }

        assert!(completed.contains("\"stale\""), "{completed}");
        assert!(completed.contains("\"persisted\":false"), "{completed}");
        assert!(completed.contains("\"analyzed_revision\":0"), "{completed}");
        assert!(completed.contains("\"current_revision\":1"), "{completed}");

        drop(server);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn analysis_cache_deduplicates_concurrent_computations() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::mpsc;
        use std::time::Duration;

        let shared = Arc::new((Mutex::new(AnalysisCache::default()), Condvar::new()));
        let key = (
            "project-single-flight".to_owned(),
            "chapter".to_owned(),
            0,
            "Hola mundo".to_owned(),
        );
        let computations = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        let first_cache = Arc::clone(&shared);
        let first_key = key.clone();
        let first_computations = Arc::clone(&computations);
        let first = thread::spawn(move || {
            AnalysisCache::get_or_compute(&first_cache, first_key, || {
                first_computations.fetch_add(1, Ordering::SeqCst);
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                analyze_fragment("Hola mundo", 0)
            }).unwrap()
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let second_cache = Arc::clone(&shared);
        let second_key = key;
        let second_computations = Arc::clone(&computations);
        let second = thread::spawn(move || {
            AnalysisCache::get_or_compute(&second_cache, second_key, || {
                second_computations.fetch_add(1, Ordering::SeqCst);
                analyze_fragment("Hola mundo", 0)
            }).unwrap()
        });

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let waiters = shared.0.lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()).waiters;
            if waiters == 1 { break; }
            assert!(std::time::Instant::now() < deadline, "el segundo análisis no esperó al primero");
            thread::yield_now();
        }
        release_tx.send(()).unwrap();

        let (first_metrics, first_hit) = first.join().unwrap();
        let (second_metrics, second_hit) = second.join().unwrap();
        assert_eq!(first_metrics.word_count, 2);
        assert_eq!(second_metrics.word_count, 2);
        assert!(!first_hit);
        assert!(second_hit);
        assert_eq!(computations.load(Ordering::SeqCst), 1);
        assert!(shared.0.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()).in_flight.is_empty());
    }

    #[test]
    fn analysis_cache_releases_single_flight_after_panicking_calculation() {
        let shared = Arc::new((Mutex::new(AnalysisCache::default()), Condvar::new()));
        let key = (
            "project-panic".to_owned(),
            "chapter".to_owned(),
            0,
            "texto".to_owned(),
        );

        let failed = AnalysisCache::get_or_compute(&shared, key.clone(), || {
            panic!("fallo simulado del analizador");
        });
        assert!(failed.is_err());
        {
            let cache = shared.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(cache.in_flight.is_empty());
        }

        let (metrics, cache_hit) = AnalysisCache::get_or_compute(&shared, key, || {
            analyze_fragment("texto", 0)
        }).unwrap();
        assert!(!cache_hit);
        assert_eq!(metrics.word_count, 1);
    }

    #[test]
    fn cancellable_analysis_cache_abandons_waiters_and_does_not_cache_stale_results() {
        let shared = Arc::new((Mutex::new(AnalysisCache::default()), Condvar::new()));
        let key = (
            "project-cancel".to_owned(),
            "chapter".to_owned(),
            0,
            "texto repetido".to_owned(),
        );
        let cancelled = AtomicBool::new(true);
        let result = AnalysisCache::get_or_compute_cancellable(
            &shared, key.clone(), &cancelled, || Some(analyze_fragment("texto", 0)),
        );
        assert_eq!(result.unwrap_err(), ANALYSIS_CANCELLED_STALE);
        let cache = shared.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(!cache.entries.contains_key(&key));
        assert!(cache.in_flight.is_empty());
    }

    #[test]
    fn cancelled_single_flight_owner_releases_key_without_caching() {
        let shared = Arc::new((Mutex::new(AnalysisCache::default()), Condvar::new()));
        let key = (
            "project-owner-cancel".to_owned(),
            "chapter".to_owned(),
            0,
            "texto que quedó obsoleto".to_owned(),
        );
        let cancelled = Arc::new(AtomicBool::new(false));
        let owner_flag = Arc::clone(&cancelled);
        let owner_cache = Arc::clone(&shared);
        let owner_key = key.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let owner = thread::spawn(move || {
            AnalysisCache::get_or_compute_cancellable(
                &owner_cache, owner_key, &owner_flag, || {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    None
                },
            )
        });
        started_rx.recv_timeout(Duration::from_secs(2))
            .expect("el cálculo obsoleto debe comenzar");
        cancelled.store(true, Ordering::Release);
        release_tx.send(()).unwrap();
        assert_eq!(owner.join().unwrap().unwrap_err(), ANALYSIS_CANCELLED_STALE);

        let cache = shared.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(!cache.entries.contains_key(&key));
        assert!(cache.in_flight.is_empty());
    }

    #[test]
    fn cancelled_single_flight_waiter_leaves_active_owner_untouched() {
        let shared = Arc::new((Mutex::new(AnalysisCache::default()), Condvar::new()));
        let key = (
            "project-waiter-cancel".to_owned(),
            "chapter".to_owned(),
            0,
            "mismo texto".to_owned(),
        );
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let owner_cache = Arc::clone(&shared);
        let owner_key = key.clone();
        let owner = thread::spawn(move || {
            AnalysisCache::get_or_compute_cancellable(
                &owner_cache, owner_key, &AtomicBool::new(false), || {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Some(analyze_fragment("mismo texto", 0))
                },
            )
        });
        started_rx.recv_timeout(Duration::from_secs(2))
            .expect("el propietario debe iniciar el cálculo");

        let waiter_cancelled = Arc::new(AtomicBool::new(false));
        let waiter_flag = Arc::clone(&waiter_cancelled);
        let waiter_cache = Arc::clone(&shared);
        let waiter_key = key.clone();
        let waiter = thread::spawn(move || {
            AnalysisCache::get_or_compute_cancellable(
                &waiter_cache, waiter_key, &waiter_flag, || {
                    Some(analyze_fragment("mismo texto", 0))
                },
            )
        });

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let waiters = shared.0.lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()).waiters;
            if waiters == 1 { break; }
            assert!(std::time::Instant::now() < deadline, "el segundo solicitante no entró en espera");
            thread::yield_now();
        }
        waiter_cancelled.store(true, Ordering::Release);
        assert_eq!(waiter.join().unwrap().unwrap_err(), ANALYSIS_CANCELLED_STALE);

        release_tx.send(()).unwrap();
        let (metrics, cache_hit) = owner.join().unwrap().unwrap();
        assert_eq!(metrics.word_count, 2);
        assert!(!cache_hit);
        let cache = shared.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(cache.entries.contains_key(&key));
        assert!(cache.in_flight.is_empty());
    }

    #[test]
    fn analysis_cache_respects_byte_budget_and_skips_oversized_entries() {
        let shared = Arc::new((Mutex::new(AnalysisCache::default()), Condvar::new()));
        let large_text = "a".repeat(MAX_ANALYSIS_CACHE_BYTES + 1);
        let large_key = (
            "project-cache-bytes".to_owned(),
            "chapter".to_owned(),
            0,
            large_text.clone(),
        );
        let (_, cache_hit) = AnalysisCache::get_or_compute(&shared, large_key.clone(), || {
            analyze_fragment(&large_text, 0)
        }).unwrap();
        assert!(!cache_hit);
        {
            let cache = shared.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(cache.cached_bytes <= MAX_ANALYSIS_CACHE_BYTES);
            assert!(!cache.entries.contains_key(&large_key));
        }

        for index in 0..MAX_ANALYSIS_CACHE_ENTRIES + 8 {
            let text = format!("fragmento pequeño {index}");
            let key = (
                "project-cache-bytes".to_owned(),
                "chapter".to_owned(),
                index,
                text.clone(),
            );
            AnalysisCache::get_or_compute(&shared, key, || analyze_fragment(&text, index)).unwrap();
        }

        let cache = shared.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(cache.cached_bytes <= MAX_ANALYSIS_CACHE_BYTES);
        assert_eq!(cache.entries.len(), cache.entry_weights.len());
        assert_eq!(cache.entries.len(), cache.insertion_order.len());
        let measured: usize = cache.entry_weights.values().copied().sum();
        assert_eq!(cache.cached_bytes, measured);
    }

    #[test]
    fn analysis_cache_isolates_projects_documents_and_offsets() {
        let shared = Arc::new((Mutex::new(AnalysisCache::default()), Condvar::new()));
        let keys = [
            ("project-a", "chapter", 0, "Hola mundo"),
            ("project-b", "chapter", 0, "Hola mundo"),
            ("project-a", "other-chapter", 0, "Hola mundo"),
            ("project-a", "chapter", 5, "Hola mundo"),
        ];

        for (project, document, offset, text) in keys {
            let key = (project.to_owned(), document.to_owned(), offset, text.to_owned());
            let (_, cache_hit) = AnalysisCache::get_or_compute(&shared, key, || {
                analyze_fragment(text, offset)
            }).unwrap();
            assert!(!cache_hit, "cada proyecto/documento/offset debe calcular su propia entrada");
        }

        let cache = shared.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(cache.entries.len(), 4);
    }

    #[test]
    fn analysis_cache_wakes_waiter_after_single_flight_panics() {
        use std::sync::mpsc;
        use std::time::Duration;

        let shared = Arc::new((Mutex::new(AnalysisCache::default()), Condvar::new()));
        let key = (
            "project-panic-waiter".to_owned(),
            "chapter".to_owned(),
            0,
            "texto compartido".to_owned(),
        );
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        let first_cache = Arc::clone(&shared);
        let first_key = key.clone();
        let first = thread::spawn(move || {
            AnalysisCache::get_or_compute(&first_cache, first_key, || -> FragmentMetrics {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                panic!("fallo simulado con un segundo hilo esperando");
            })
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let second_cache = Arc::clone(&shared);
        let second = thread::spawn(move || {
            AnalysisCache::get_or_compute(&second_cache, key, || {
                analyze_fragment("texto compartido", 0)
            })
        });

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let waiters = shared.0.lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()).waiters;
            if waiters == 1 { break; }
            assert!(std::time::Instant::now() < deadline, "el segundo hilo no quedó esperando");
            thread::yield_now();
        }

        release_tx.send(()).unwrap();
        assert!(first.join().unwrap().is_err());
        let (metrics, cache_hit) = second.join().unwrap().unwrap();
        assert!(!cache_hit);
        assert_eq!(metrics.word_count, 2);

        let cache = shared.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(cache.in_flight.is_empty());
        assert_eq!(cache.waiters, 0);
        assert_eq!(cache.entries.len(), 1);
    }

    #[test]
    fn analysis_cache_evicts_oldest_entry_at_capacity() {
        let shared = Arc::new((Mutex::new(AnalysisCache::default()), Condvar::new()));

        for index in 0..=MAX_ANALYSIS_CACHE_ENTRIES {
            let key = (
                "project-cache-bound".to_owned(),
                "chapter".to_owned(),
                index,
                format!("fragmento {index}"),
            );
            let (_, cache_hit) = AnalysisCache::get_or_compute(&shared, key, || {
                analyze_fragment(&format!("fragmento {index}"), index)
            }).unwrap();
            assert!(!cache_hit);
        }

        {
            let cache = shared.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            assert_eq!(cache.entries.len(), MAX_ANALYSIS_CACHE_ENTRIES);
            assert_eq!(cache.insertion_order.len(), MAX_ANALYSIS_CACHE_ENTRIES);
        }

        let oldest = (
            "project-cache-bound".to_owned(),
            "chapter".to_owned(),
            0,
            "fragmento 0".to_owned(),
        );
        let (_, oldest_hit) = AnalysisCache::get_or_compute(&shared, oldest, || {
            analyze_fragment("fragmento 0", 0)
        }).unwrap();
        assert!(!oldest_hit, "la entrada más antigua debe haber sido expulsada");

        let newest = (
            "project-cache-bound".to_owned(),
            "chapter".to_owned(),
            MAX_ANALYSIS_CACHE_ENTRIES,
            format!("fragmento {}", MAX_ANALYSIS_CACHE_ENTRIES),
        );
        let (_, newest_hit) = AnalysisCache::get_or_compute(&shared, newest, || {
            analyze_fragment(&format!("fragmento {}", MAX_ANALYSIS_CACHE_ENTRIES), MAX_ANALYSIS_CACHE_ENTRIES)
        }).unwrap();
        assert!(newest_hit, "la entrada más reciente debe seguir en caché");

        let cache = shared.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(cache.entries.len(), MAX_ANALYSIS_CACHE_ENTRIES);
        assert_eq!(cache.insertion_order.len(), MAX_ANALYSIS_CACHE_ENTRIES);
    }

    #[test]
    fn rejects_invalid_requests_and_unknown_methods_with_jsonrpc_errors() {
        let mut server = JsonRpcServer::new();
        let malformed = server.handle_line("{");
        assert!(malformed.contains("-32700"));
        let unknown = server.handle_line(&request(1, "not_a_method", JsonValue::Object(BTreeMap::new())));
        assert!(unknown.contains("-32601"));
        let missing = server.handle_line(r#"{"jsonrpc":"2.0","id":2,"method":"snapshot","params":{}}"#);
        assert!(missing.contains("-32010"));
    }

    #[test]
    fn jsonrpc_drives_live_edit_commit_snapshot_and_shutdown() {
        let (root, pages, journal) = paths();
        let mut server = JsonRpcServer::new();

        let init = object([
            ("project_id", string("project-jsonrpc")),
            ("pages_path", string(pages.to_string_lossy())),
            ("journal_path", string(journal.to_string_lossy())),
            ("queue_capacity", number(8)),
            ("knowledge_pages_path", string(root.join("knowledge.pages").to_string_lossy())),
            ("knowledge_journal_path", string(root.join("knowledge.wal").to_string_lossy())),
        ]);
        let initialized = server.handle_line(&request(1, "initialize", init));
        assert!(initialized.contains("initialized"));

        let opened = object([
            ("document_id", string("chapter")),
            ("text", string("Hola")),
            ("revision", number(0)),
            ("sequence", number(0)),
        ]);
        assert!(server.handle_line(&request(2, "open_document", opened)).contains("opened"));

        let paragraph_request = server.handle_line(&request(70, "request_affected_paragraph", object([
            ("document_id", string("chapter")),
            ("selection_start_byte", number(0)),
            ("selection_end_byte", number(4)),
            ("expected_revision", number(0)),
        ])));
        assert!(paragraph_request.contains("queued"));
        let paragraph_result = loop {
            let response = server.handle_line(&request(71, "poll_affected_paragraph", object([
                ("ticket_id", string("n:70")),
            ])));
            if response.contains("\"status\":\"ready\"") { break response; }
            assert!(response.contains("\"pending\""), "unexpected second commit: {response}");
            std::thread::yield_now();
        };
        assert!(paragraph_result.contains("\"text\":\"Hola\""));
        assert!(paragraph_result.contains("\"revision\":0"));

        let change = object([
            ("document_id", string("chapter")),
            ("sequence", number(1)),
            ("base_revision", number(0)),
            ("start_byte", number(4)),
            ("end_byte", number(4)),
            ("replacement", string(" mundo mundo")),
        ]);
        let queued = server.handle_line(&request(3, "editor_change", change));
        assert!(queued.contains("queued"));

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let committed = loop {
            let poll = object([("ticket_id", string("n:3"))]);
            let response = server.handle_line(&request(4, "poll_commit", poll));
            if response.contains("\"applied\"") { break response; }
            assert!(response.contains("\"pending\""), "unexpected second commit: {response}");
            assert!(std::time::Instant::now() < deadline, "durable commit timed out");
            std::thread::yield_now();
        };
        assert!(committed.contains("applied"));

        // Si el anfitrión no recibió la confirmación y reintenta el mismo delta,
        // la secuencia repetida debe reconocerse sin aplicar el texto dos veces.
        let retry = server.handle_line(&request(51, "editor_change", object([
            ("document_id", string("chapter")),
            ("sequence", number(1)),
            ("base_revision", number(0)),
            ("start_byte", number(4)),
            ("end_byte", number(4)),
            ("replacement", string(" mundo mundo")),
        ])));
        assert!(retry.contains("queued"), "retry was not accepted: {retry}");
        let retry_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let retry_result = loop {
            let response = server.handle_line(&request(52, "poll_commit", object([
                ("ticket_id", string("n:51")),
            ])));
            if response.contains("duplicate") {
                break response;
            }
            assert!(response.contains("\"pending\""), "unexpected second commit: {response}");
            assert!(std::time::Instant::now() < retry_deadline, "retry confirmation timed out");
            std::thread::yield_now();
        };
        assert!(retry_result.contains("duplicate"));

        let snapshot = server.handle_line(&request(5, "snapshot", object([
            ("document_id", string("chapter")),
        ])));
        assert!(snapshot.contains("Hola mundo mundo"));
        assert!(!snapshot.contains("Hola mundo mundo mundo"));

        let affected = server.handle_line(&request(50, "analyze_affected_paragraph", object([
            ("document_id", string("chapter")),
            ("selection_start_byte", number(5)),
            ("selection_end_byte", number(10)),
            ("expected_revision", number(1)),
            ("analysis_id", string("chapter-paragraph-1")),
        ])));
        assert!(affected.contains("\"text\":\"Hola mundo mundo\""));
        assert!(affected.contains("\"word_count\":3"));
        assert!(affected.contains("\"revision\":1"));
        assert!(affected.contains("\"persisted\":true"));
        let saved_analysis = server.handle_line(&request(51, "get_fragment_analysis", object([
            ("id", string("chapter-paragraph-1")),
        ])));
        assert!(saved_analysis.contains("\"document_id\":\"chapter\""));
        assert!(saved_analysis.contains("\"word_count\":3"));
        let async_request = server.handle_line(&request(80, "request_analyze_affected_paragraph", object([
            ("document_id", string("chapter")),
            ("selection_start_byte", number(0)),
            ("selection_end_byte", number(4)),
            ("expected_revision", number(1)),
        ])));
        assert!(async_request.contains("\"status\":\"queued\""), "unexpected async request: {async_request}");
        let async_result = loop {
            let response = server.handle_line(&request(81, "poll_analyze_affected_paragraph", object([
                ("ticket_id", string("n:80")),
                ("analysis_id", string("chapter-paragraph-async")),
            ])));
            if response.contains("\"status\":\"ready\"") { break response; }
            assert!(response.contains("\"pending\""), "unexpected second commit: {response}");
            std::thread::yield_now();
        };
        assert!(async_result.contains("\"persisted\":true"));
        assert!(async_result.contains("\"extraction_micros\":"));
        assert!(async_result.contains("\"analysis_micros\":"));
        assert!(async_result.contains("\"persistence_micros\":"));
        assert!(async_result.contains("\"diagnostics\":["));
        assert!(async_result.contains("\"repeated_adjacent_word\""));
        assert!(async_result.contains("\"text\":\"Hola mundo mundo\""));
        assert!(async_result.contains("\"word_count\":3"));
        let async_saved = server.handle_line(&request(82, "get_fragment_analysis", object([
            ("id", string("chapter-paragraph-async")),
        ])));
        assert!(async_saved.contains("\"word_count\":3"));
        assert!(async_result.contains("\"analysis_cache_hit\":false"));
        let cached_request = server.handle_line(&request(88, "request_analyze_affected_paragraph", object([
            ("document_id", string("chapter")),
            ("selection_start_byte", number(0)),
            ("selection_end_byte", number(4)),
            ("expected_revision", number(1)),
        ])));
        assert!(cached_request.contains("\"status\":\"queued\""));
        let cached_result = loop {
            let response = server.handle_line(&request(89, "poll_analyze_affected_paragraph", object([
                ("ticket_id", string("n:88")),
                ("analysis_id", string("chapter-paragraph-cached")),
            ])));
            if response.contains("\"status\":\"ready\"") { break response; }
            assert!(response.contains("\"pending\""), "unexpected second commit: {response}");
            std::thread::yield_now();
        };
        assert!(cached_result.contains("\"analysis_cache_hit\":true"));
        assert!(cached_result.contains("\"word_count\":3"));

        // Un análisis terminado después de una edición posterior debe descartarse.
        assert!(server.handle_line(&request(83, "open_document", object([
            ("document_id", string("chapter-stale-analysis")),
            ("text", string("Texto original")),
            ("revision", number(0)),
            ("sequence", number(0)),
        ]))).contains("opened"));
        let stale_request = server.handle_line(&request(84, "request_analyze_affected_paragraph", object([
            ("document_id", string("chapter-stale-analysis")),
            ("selection_start_byte", number(0)),
            ("selection_end_byte", number(6)),
            ("expected_revision", number(0)),
        ])));
        assert!(stale_request.contains("\"status\":\"queued\""));
        let stale_edit = server.handle_line(&request(85, "editor_change", object([
            ("document_id", string("chapter-stale-analysis")),
            ("sequence", number(1)),
            ("base_revision", number(0)),
            ("start_byte", number(6)),
            ("end_byte", number(14)),
            ("replacement", string("actualizado")),
        ])));
        assert!(stale_edit.contains("\"status\":\"queued\""));
        let stale_async_result = loop {
            let response = server.handle_line(&request(86, "poll_analyze_affected_paragraph", object([
                ("ticket_id", string("n:84")),
                ("analysis_id", string("stale-must-not-persist")),
            ])));
            if response.contains("\"status\":\"stale\"") { break response; }
            assert!(response.contains("\"pending\""), "unexpected second commit: {response}");
            std::thread::yield_now();
        };
        assert!(stale_async_result.contains("\"persisted\":false"));
        assert!(stale_async_result.contains("\"analyzed_revision\":0"));
        assert!(stale_async_result.contains("\"current_revision\":1"));
        let stale_not_saved = server.handle_line(&request(87, "get_fragment_analysis", object([
            ("id", string("stale-must-not-persist")),
        ])));
        assert!(stale_not_saved.contains("\"result\":null"));

        let analysis_ids = server.handle_line(&request(52, "list_fragment_analysis_ids", JsonValue::Object(BTreeMap::new())));
        assert!(analysis_ids.contains("chapter-paragraph-1"));
        let document_history = server.handle_line(&request(59, "list_fragment_analyses", object([
            ("document_id", string("chapter")),
            ("revision", number(1)),
            ("limit", number(10)),
        ])));
        assert!(document_history.contains("chapter-paragraph-1"));
        assert!(document_history.contains("\"revision\":1"));
        let other_document_history = server.handle_line(&request(60, "list_fragment_analyses", object([
            ("document_id", string("another-chapter")),
            ("limit", number(10)),
        ])));
        assert_eq!(other_document_history, response_result(
            number(60),
            JsonValue::Array(vec![]),
        ));
        let invalid_history_limit = server.handle_line(&request(61, "list_fragment_analyses", object([
            ("document_id", string("chapter")),
            ("limit", number(-1)),
        ])));
        assert!(invalid_history_limit.contains("-32602"));
        assert!(server.handle_line(&request(54, "open_document", object([
            ("document_id", string("chapter-paragraphs")),
            ("text", string("Primero.\n\nEl niño llegó.\n\nTercero.")),
            ("revision", number(0)),
            ("sequence", number(0)),
        ]))).contains("opened"));
        let middle_paragraph = server.handle_line(&request(55, "analyze_affected_paragraph", object([
            ("document_id", string("chapter-paragraphs")),
            ("selection_start_byte", number(13)),
            ("selection_end_byte", number(18)),
            ("expected_revision", number(0)),
            ("analysis_id", string("chapter-paragraphs-p2")),
        ])));
        assert!(middle_paragraph.contains("\"text\":\"El niño llegó.\""));
        assert!(!middle_paragraph.contains("Primero"));
        assert!(!middle_paragraph.contains("Tercero"));
        let status = server.handle_line(&request(56, "status", JsonValue::Object(BTreeMap::new())));
        assert!(status.contains("\"analysis_sample_count\":3"));
        assert!(status.contains("\"p95_analysis_micros\""));
        assert!(status.contains("\"queue_full_rejections\""));
        assert!(status.contains("\"max_pending_changes\""));
        assert!(status.contains("\"p95_queue_wait_micros\""));
        let removed_analysis = server.handle_line(&request(57, "delete_fragment_analysis", object([
            ("id", string("chapter-paragraphs-p2")),
        ])));
        assert!(removed_analysis.contains("\"deleted\":true"));
        let removed_lookup = server.handle_line(&request(58, "get_fragment_analysis", object([
            ("id", string("chapter-paragraphs-p2")),
        ])));
        assert!(removed_lookup.contains("\"result\":null"));

        let stale_analysis = server.handle_line(&request(53, "analyze_affected_paragraph", object([
            ("document_id", string("chapter")),
            ("selection_start_byte", number(500)),
            ("selection_end_byte", number(501)),
            ("expected_revision", number(0)),
        ])));
        assert!(stale_analysis.contains("-32031"));
        assert!(stale_analysis.contains("current_revision"));

        let deletion = object([
            ("document_id", string("chapter")),
            ("sequence", number(2)),
            ("base_revision", number(1)),
            ("start_byte", number(0)),
            ("end_byte", number(10)),
            ("replacement", string("")),
        ]);
        assert!(server.handle_line(&request(6, "editor_change", deletion)).contains("queued"));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let response = server.handle_line(&request(7, "poll_commit", object([
                ("ticket_id", string("n:6")),
            ])));
            if response.contains("\"applied\"") { break response; }
            assert!(response.contains("\"pending\""), "unexpected second commit: {response}");
            assert!(std::time::Instant::now() < deadline, "deletion commit timed out");
            std::thread::yield_now();
        }
        let empty_open = server.handle_line(&request(8, "open_document", object([
            ("document_id", string("empty-chapter")),
            ("text", string("")),
            ("revision", number(0)),
            ("sequence", number(0)),
        ])));
        assert!(empty_open.contains("opened"));
        let empty_snapshot = server.handle_line(&request(9, "snapshot", object([
            ("document_id", string("empty-chapter")),
        ])));
        assert!(empty_snapshot.contains("\"text\":\"\""));

        let status = server.handle_line(&request(90, "status", JsonValue::Object(BTreeMap::new())));
        assert!(status.contains("\"durable_commits\":2"), "unexpected durable commit count: {status}");
        assert!(status.contains("\"end_to_end_sample_count\":2"), "duplicates must not add latency samples: {status}");
        assert!(status.contains("\"last_submit_to_durable_commit_micros\":"));
        assert!(status.contains("\"p50_submit_to_durable_commit_micros\":"));
        assert!(status.contains("\"p95_submit_to_durable_commit_micros\":"));
        assert!(status.contains("\"p99_submit_to_durable_commit_micros\":"));
        assert!(status.contains("\"max_submit_to_durable_commit_micros\":"));

        assert!(server.handle_line(&request(10, "shutdown", JsonValue::Object(BTreeMap::new())))
            .contains("stopped"));
        assert!(server.should_exit());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reopened_server_reconstructs_evidence_from_multiple_durable_edits() {
        let (root, pages, journal) = paths();
        let knowledge_pages = root.join("knowledge.pages");
        let knowledge_journal = root.join("knowledge.mlpj");
        {
            let mut server = JsonRpcServer::new();
            let init = object([
                ("project_id", string("project-recovery")),
                ("pages_path", string(pages.to_string_lossy())),
                ("journal_path", string(journal.to_string_lossy())),
                ("queue_capacity", number(4)),
                ("knowledge_pages_path", string(knowledge_pages.to_string_lossy())),
                ("knowledge_journal_path", string(knowledge_journal.to_string_lossy())),
            ]);
            assert!(server.handle_line(&request(1, "initialize", init)).contains("initialized"));
            assert!(server.handle_line(&request(2, "open_document", object([
                ("document_id", string("chapter")),
                ("text", string("Ana")),
                ("revision", number(0)),
                ("sequence", number(0)),
            ]))).contains("opened"));
            assert!(server.handle_line(&request(3, "put_entity", object([
                ("id", string("ana")),
                ("canonical_name", string("Ana")),
                ("entity_type", string("character")),
                ("attributes", JsonValue::Object(BTreeMap::new())),
                ("status", string("confirmed")),
            ]))).contains("stored"));
            assert!(server.handle_line(&request(4, "put_evidence", object([
                ("id", string("ev")),
                ("target_kind", string("entity")),
                ("target_id", string("ana")),
                ("document_id", string("chapter")),
                ("revision", number(0)),
                ("start_byte", number(0)),
                ("end_byte", number(3)),
                ("excerpt", string("Ana")),
                ("source_kind", string("explicit_text")),
            ]))).contains("stored"));
            assert!(server.handle_line(&request(5, "editor_change", object([
                ("document_id", string("chapter")),
                ("sequence", number(1)),
                ("base_revision", number(0)),
                ("start_byte", number(0)),
                ("end_byte", number(0)),
                ("replacement", string("X")),
            ]))).contains("queued"));
            assert!(server.handle_line(&request(10, "editor_change", object([
                ("document_id", string("chapter")),
                ("sequence", number(2)),
                ("base_revision", number(1)),
                ("start_byte", number(4)),
                ("end_byte", number(4)),
                ("replacement", string("!")),
            ]))).contains("queued"));
            // La barrera FIFO confirma ambos deltas, pero no consulta sus tickets:
            // el almacén narrativo aún conserva la revisión anterior.
            let snapshot = server.api.as_ref().unwrap().snapshot("chapter").unwrap();
            assert_eq!((snapshot.revision, snapshot.text.as_str()), (2, "XAna!"));
            server.api.as_mut().unwrap().shutdown().unwrap();
        }
        {
            let mut server = JsonRpcServer::new();
            let init = object([
                ("project_id", string("project-recovery")),
                ("pages_path", string(pages.to_string_lossy())),
                ("journal_path", string(journal.to_string_lossy())),
                ("queue_capacity", number(4)),
                ("knowledge_pages_path", string(knowledge_pages.to_string_lossy())),
                ("knowledge_journal_path", string(knowledge_journal.to_string_lossy())),
            ]);
            assert!(server.handle_line(&request(6, "initialize", init)).contains("initialized"));
            assert!(server.handle_line(&request(7, "open_document", object([
                ("document_id", string("chapter")),
                ("text", string("XAna!")),
                ("revision", number(2)),
                ("sequence", number(2)),
            ]))).contains("opened"));
            let evidence = server.handle_line(&request(8, "get_evidence", object([
                ("id", string("ev")),
            ])));
            assert!(evidence.contains("\"stale\":false"), "valid evidence was not recovered: {evidence}");
            assert!(evidence.contains("\"revision\":2"), "evidence revision was not advanced: {evidence}");
            assert!(evidence.contains("\"start_byte\":1"), "evidence start was not shifted: {evidence}");
            assert!(evidence.contains("\"end_byte\":4"), "evidence end was not shifted: {evidence}");
            let evidence_again = server.handle_line(&request(11, "get_evidence", object([
                ("id", string("ev")),
            ])));
            assert!(evidence_again.contains("\"start_byte\":1"));
            assert!(evidence_again.contains("\"end_byte\":4"));
            assert!(server.handle_line(&request(9, "shutdown", JsonValue::Object(BTreeMap::new())))
                .contains("stopped"));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn jsonrpc_persists_and_retrieves_narrative_entities_and_evidence() {
        let (root, pages, journal) = paths();
        let knowledge_pages = root.join("knowledge.pages");
        let knowledge_journal = root.join("knowledge.mlpj");
        let mut server = JsonRpcServer::new();
        let init = object([
            ("project_id", string("project-knowledge")),
            ("pages_path", string(pages.to_string_lossy())),
            ("journal_path", string(journal.to_string_lossy())),
            ("queue_capacity", number(4)),
            ("knowledge_pages_path", string(knowledge_pages.to_string_lossy())),
            ("knowledge_journal_path", string(knowledge_journal.to_string_lossy())),
        ]);
        assert!(server.handle_line(&request(1, "initialize", init)).contains("initialized"));
        assert!(server.handle_line(&request(32, "open_document", object([
            ("document_id", string("chapter-1")),
            ("text", string("1234567890Ana")),
            ("revision", number(7)),
            ("sequence", number(0)),
        ]))).contains("opened"));

        let entity = object([
            ("id", string("ana")),
            ("canonical_name", string("Ana")),
            ("entity_type", string("character")),
            ("attributes", object([("eye_color", string("verde"))])),
            ("status", string("confirmed")),
        ]);
        assert!(server.handle_line(&request(2, "put_entity", entity)).contains("stored"));
        let found = server.handle_line(&request(3, "get_entity", object([
            ("id", string("ana")),
        ])));
        assert!(found.contains("Ana"));
        assert!(found.contains("verde"));
        let entity_ids = server.handle_line(&request(30, "list_entity_ids", JsonValue::Object(BTreeMap::new())));
        assert!(entity_ids.contains("ana"));

        let evidence = object([
            ("id", string("ev-1")),
            ("target_kind", string("entity")),
            ("target_id", string("ana")),
            ("document_id", string("chapter-1")),
            ("revision", number(7)),
            ("start_byte", number(10)),
            ("end_byte", number(13)),
            ("excerpt", string("Ana")),
            ("source_kind", string("explicit_text")),
        ]);
        assert!(server.handle_line(&request(4, "put_evidence", evidence)).contains("stored"));
        let found_evidence = server.handle_line(&request(5, "get_evidence", object([
            ("id", string("ev-1")),
        ])));
        assert!(found_evidence.contains("chapter-1"));
        assert!(found_evidence.contains("explicit_text"));

        let live_evidence_audit = server.handle_line(&request(48, "audit_document_evidence", object([
            ("document_id", string("chapter-1")),
            ("limit", number(1)),
        ])));
        assert!(live_evidence_audit.contains("\"scanned\":1"), "{live_evidence_audit}");
        assert!(live_evidence_audit.contains("\"has_more\":false"), "{live_evidence_audit}");
        assert!(live_evidence_audit.contains("\"issues\":[]"), "{live_evidence_audit}");

        // Dos cambios aceptados consecutivamente. Se consulta primero el
        // segundo ticket: el protocolo debe recoger ambos resultados y rebasear
        // las evidencias en orden de commit, no en orden de polling.
        let first_edit = server.handle_line(&request(35, "editor_change", object([
            ("document_id", string("chapter-1")),
            ("sequence", number(1)),
            ("base_revision", number(7)),
            ("start_byte", number(0)),
            ("end_byte", number(0)),
            ("replacement", string("XY")),
        ])));
        assert!(first_edit.contains("queued"), "first edit rejected: {first_edit}");
        let second_edit = server.handle_line(&request(36, "editor_change", object([
            ("document_id", string("chapter-1")),
            ("sequence", number(2)),
            ("base_revision", number(8)),
            ("start_byte", number(15)),
            ("end_byte", number(15)),
            ("replacement", string("!")),
        ])));
        assert!(second_edit.contains("queued"), "second edit rejected: {second_edit}");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let second_commit = loop {
            let response = server.handle_line(&request(37, "poll_commit", object([
                ("ticket_id", string("n:36")),
            ])));
            if response.contains("\"applied\"") { break response; }
            assert!(response.contains("\"pending\""), "unexpected second commit: {response}");
            assert!(std::time::Instant::now() < deadline, "second commit timed out");
            std::thread::yield_now();
        };
        assert!(second_commit.contains("applied"));
        let first_commit = server.handle_line(&request(38, "poll_commit", object([
            ("ticket_id", string("n:35")),
        ])));
        assert!(first_commit.contains("applied"), "first result was not retained: {first_commit}");

        let rebased_evidence = server.handle_line(&request(39, "get_evidence", object([
            ("id", string("ev-1")),
        ])));
        assert!(rebased_evidence.contains("\"revision\":9"));
        assert!(rebased_evidence.contains("\"start_byte\":12"));
        assert!(rebased_evidence.contains("\"end_byte\":15"));

        // Una edición que toca la cita no desplaza la evidencia: la deja en
        // su revisión anterior para que el anfitrión la identifique como obsoleta.
        let touching_edit = server.handle_line(&request(40, "editor_change", object([
            ("document_id", string("chapter-1")),
            ("sequence", number(3)),
            ("base_revision", number(9)),
            ("start_byte", number(13)),
            ("end_byte", number(14)),
            ("replacement", string("X")),
        ])));
        assert!(touching_edit.contains("queued"), "touching edit rejected: {touching_edit}");
        // Antes de consumir el ticket de commit, el worker ya aplicó el cambio
        // por orden FIFO, pero la evidencia aún no se ha reanclado en el store.
        // La auditoría debe detectar esa ventana de revisión sin modificar la cita.
        let pending_rebase_audit = server.handle_line(&request(50, "audit_document_evidence", object([
            ("document_id", string("chapter-1")),
            ("limit", number(1)),
        ])));
        assert!(pending_rebase_audit.contains("evidence_revision_mismatch"), "{pending_rebase_audit}");
        let touching_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let response = server.handle_line(&request(41, "poll_commit", object([
                ("ticket_id", string("n:40")),
            ])));
            if response.contains("\"applied\"") { break; }
            assert!(response.contains("\"pending\""), "unexpected touching commit: {response}");
            assert!(std::time::Instant::now() < touching_deadline, "touching edit timed out");
            std::thread::yield_now();
        }
        let invalidated_evidence = server.handle_line(&request(42, "get_evidence", object([
            ("id", string("ev-1")),
        ])));
        assert!(invalidated_evidence.contains("\"revision\":9"));
        assert!(invalidated_evidence.contains("\"start_byte\":12"));

        let bad_excerpt = server.handle_line(&request(33, "put_evidence", object([
            ("id", string("ev-bad")),
            ("target_kind", string("entity")),
            ("target_id", string("ana")),
            ("document_id", string("chapter-1")),
            ("revision", number(10)),
            ("start_byte", number(12)),
            ("end_byte", number(15)),
            ("excerpt", string("Xna")),
            ("source_kind", string("explicit_text")),
        ])));
        assert!(bad_excerpt.contains("-32602"));
        let stale_evidence = server.handle_line(&request(34, "put_evidence", object([
            ("id", string("ev-stale")),
            ("target_kind", string("entity")),
            ("target_id", string("ana")),
            ("document_id", string("chapter-1")),
            ("revision", number(9)),
            ("start_byte", number(12)),
            ("end_byte", number(15)),
            ("excerpt", string("Ana")),
            ("source_kind", string("explicit_text")),
        ])));
        assert!(stale_evidence.contains("-32031"));
        let stale_record = server.handle_line(&request(43, "get_evidence", object([
            ("id", string("ev-1")),
        ])));
        assert!(stale_record.contains("\"stale\":true"));
        let stale_anchor_audit = server.handle_line(&request(49, "audit_document_evidence", object([
            ("document_id", string("chapter-1")),
            ("limit", number(1)),
        ])));
        assert!(stale_anchor_audit.contains("evidence_anchor_stale"), "{stale_anchor_audit}");

        let resync_evidence = object([
            ("id", string("ev-resync")),
            ("target_kind", string("entity")),
            ("target_id", string("ana")),
            ("document_id", string("chapter-1")),
            ("revision", number(10)),
            ("start_byte", number(12)),
            ("end_byte", number(15)),
            ("excerpt", string("AXa")),
            ("source_kind", string("explicit_text")),
        ]);
        assert!(server.handle_line(&request(44, "put_evidence", resync_evidence)).contains("stored"));
        // La resincronización puede conservar el mismo número de revisión y
        // aun así reemplazar el snapshot: todas las citas se invalidan explícitamente.
        let resynchronized = server.handle_line(&request(45, "resynchronize", object([
            ("document_id", string("chapter-1")),
            ("text", string("snapshot autoritativo distinto")),
            ("revision", number(10)),
            ("sequence", number(3)),
        ])));
        assert!(resynchronized.contains("resynchronized"));
        let invalidated_by_resync = server.handle_line(&request(46, "get_evidence", object([
            ("id", string("ev-resync")),
        ])));
        assert!(invalidated_by_resync.contains("\"stale\":true"));

        let evidence_ids = server.handle_line(&request(31, "list_evidence_ids", JsonValue::Object(BTreeMap::new())));
        assert!(evidence_ids.contains("ev-1"));
        let chapter_evidence_ids = server.handle_line(&request(47, "list_evidence_ids_for_document", object([
            ("document_id", string("chapter-1")),
        ])));
        assert!(chapter_evidence_ids.contains("ev-1"));
        assert!(!chapter_evidence_ids.contains("ev-other-document"));
        let first_evidence_page = server.handle_line(&request(76, "list_evidence_ids_for_document_page", object([
            ("document_id", string("chapter-1")),
            ("offset", number(0)),
            ("limit", number(1)),
        ])));
        let second_evidence_page = server.handle_line(&request(77, "list_evidence_ids_for_document_page", object([
            ("document_id", string("chapter-1")),
            ("offset", number(1)),
            ("limit", number(1)),
        ])));
        // En este punto solo ev-1 pertenece a chapter-1: la primera
        // página debe contenerlo y la siguiente debe estar vacía.
        assert!(first_evidence_page.contains("\"result\":[\"ev-1\"]"));
        assert!(second_evidence_page.contains("\"result\":[]"));
        let beyond_evidence_pages = server.handle_line(&request(79, "list_evidence_ids_for_document_page", object([
            ("document_id", string("chapter-1")),
            ("offset", number(50_000)),
            ("limit", number(1)),
        ])));
        assert!(beyond_evidence_pages.contains("\"result\":[]"));
        let invalid_evidence_page = server.handle_line(&request(78, "list_evidence_ids_for_document_page", object([
            ("document_id", string("chapter-1")),
            ("limit", number(0)),
        ])));
        assert!(invalid_evidence_page.contains("-32030"));

        let second_entity = object([
            ("id", string("luis")), ("canonical_name", string("Luis")),
            ("entity_type", string("character")),
            ("attributes", JsonValue::Object(BTreeMap::new())),
            ("status", string("confirmed")),
        ]);
        assert!(server.handle_line(&request(60, "put_entity", second_entity)).contains("stored"));

        let relation = object([
            ("id", string("rel-1")), ("subject_id", string("ana")),
            ("predicate", string("conoce")), ("object_id", string("luis")),
            ("status", string("proposed")),
        ]);
        assert!(server.handle_line(&request(6, "put_relation", relation)).contains("stored"));
        assert!(server.handle_line(&request(7, "get_relation", object([
            ("id", string("rel-1")),
        ]))).contains("conoce"));

        let event = object([
            ("id", string("event-1")), ("label", string("La llegada")),
            ("chronology_order", number(-42)), ("status", string("confirmed")),
        ]);
        assert!(server.handle_line(&request(8, "put_event", event)).contains("stored"));
        let found_event = server.handle_line(&request(9, "get_event", object([
            ("id", string("event-1")),
        ])));
        assert!(found_event.contains("La llegada"));
        assert!(found_event.contains("-42"));

        for (request_id, evidence_id, target_kind, target_id) in [
            (70, "ev-relation", "relation", "rel-1"),
            (71, "ev-event", "event", "event-1"),
        ] {
            let stored = server.handle_line(&request(request_id, "put_evidence", object([
                ("id", string(evidence_id)),
                ("target_kind", string(target_kind)),
                ("target_id", string(target_id)),
                ("document_id", string("chapter-1")),
                ("revision", number(10)),
                ("start_byte", number(0)),
                ("end_byte", number(8)),
                ("excerpt", string("snapshot")),
                ("source_kind", string("explicit_text")),
            ])));
            assert!(stored.contains("stored"));
        }
        let audit_first_page = server.handle_line(&request(85, "audit_document_evidence", object([
            ("document_id", string("chapter-1")),
            ("limit", number(1)),
        ])));
        assert!(audit_first_page.contains("\"scanned\":1"), "{audit_first_page}");
        assert!(audit_first_page.contains("\"has_more\":true"), "{audit_first_page}");
        assert!(audit_first_page.contains("\"next_after\":\"ev-1\""), "{audit_first_page}");
        let audit_second_page = server.handle_line(&request(86, "audit_document_evidence", object([
            ("document_id", string("chapter-1")),
            ("after_id", string("ev-1")),
            ("limit", number(1)),
        ])));
        assert!(audit_second_page.contains("\"scanned\":1"), "{audit_second_page}");
        assert!(audit_second_page.contains("\"has_more\":true"), "{audit_second_page}");
        assert!(audit_second_page.contains("\"issues\":[]"), "{audit_second_page}");

        let chapter_entities = server.handle_line(&request(72, "list_entity_ids_for_document", object([
            ("document_id", string("chapter-1")),
        ])));
        // Dos citas (ambas obsoletas tras resincronizar) apuntan a Ana:
        // el resultado conserva el destino histórico, pero sin duplicarlo.
        assert!(chapter_entities.contains("\"result\":[\"ana\"]"));
        assert!(server.handle_line(&request(73, "list_relation_ids_for_document", object([
            ("document_id", string("chapter-1")),
        ]))).contains("rel-1"));
        assert!(server.handle_line(&request(74, "list_event_ids_for_document", object([
            ("document_id", string("chapter-1")),
        ]))).contains("event-1"));
        let deleted_event = server.handle_line(&request(76, "delete_evidence", object([
            ("id", string("ev-event")),
        ])));
        assert!(deleted_event.contains("\"deleted\":true"), "evidence deletion failed: {deleted_event}");
        let deleted_again = server.handle_line(&request(77, "delete_evidence", object([
            ("id", string("ev-event")),
        ])));
        assert!(deleted_again.contains("\"deleted\":false"), "repeated deletion was not idempotent: {deleted_again}");
        let events_after_delete = server.handle_line(&request(78, "list_event_ids_for_document", object([
            ("document_id", string("chapter-1")),
        ])));
        assert!(events_after_delete.contains("\"result\":[]"), "deleted event remained indexed: {events_after_delete}");
        let unrelated_entities = server.handle_line(&request(75, "list_entity_ids_for_document", object([
            ("document_id", string("chapter-unrelated")),
        ])));
        assert!(unrelated_entities.contains("\"result\":[]"));

        // Las rutas JSON-RPC de borrado preservan las referencias entrantes.
        let blocked_entity_delete = server.handle_line(&request(80, "delete_entity", object([
            ("id", string("ana")),
        ])));
        assert!(blocked_entity_delete.contains("-32030"), "entity with relation was deleted: {blocked_entity_delete}");
        let blocked_relation_delete = server.handle_line(&request(81, "delete_relation", object([
            ("id", string("rel-1")),
        ])));
        assert!(blocked_relation_delete.contains("-32030"), "relation with evidence was deleted: {blocked_relation_delete}");
        let relation_evidence_deleted = server.handle_line(&request(82, "delete_evidence", object([
            ("id", string("ev-relation")),
        ])));
        assert!(relation_evidence_deleted.contains("\"deleted\":true"));
        let relation_deleted = server.handle_line(&request(83, "delete_relation", object([
            ("id", string("rel-1")),
        ])));
        assert!(relation_deleted.contains("\"deleted\":true"));
        let event_deleted = server.handle_line(&request(84, "delete_event", object([
            ("id", string("event-1")),
        ])));
        assert!(event_deleted.contains("\"deleted\":true"));

        let metrics = server.handle_line(&request(11, "analyze_fragment", object([
            ("text", string("Ana llegó. Ana sonrió.")),
            ("base_byte", number(20)),
        ])));
        assert!(metrics.contains("\"word_count\":4"));
        assert!(metrics.contains("\"sentence_count\":2"));
        assert!(metrics.contains("\"normalized\":\"ana\""));

        let tokens = server.handle_line(&request(12, "tokenize_fragment", object([
            ("text", string("Niño llegó")),
            ("base_byte", number(50)),
        ])));
        assert!(tokens.contains("\"normalized\":\"niño\""));
        assert!(tokens.contains("\"start_byte\":50"));

        assert!(server.handle_line(&request(13, "shutdown", JsonValue::Object(BTreeMap::new())))
            .contains("stopped"));
        drop(server);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fragment_analysis_parser_rejects_source_text_outside_declared_byte_range() {
        let params = object([
            ("id", string("analysis-invalid-source")),
            ("document_id", string("chapter")),
            ("revision", number(1)),
            ("start_byte", number(10)),
            ("end_byte", number(14)),
            ("source_text", string("five!")),
            ("character_count", number(5)),
            ("word_count", number(1)),
            ("unique_word_count", number(1)),
            ("sentence_count", number(1)),
            ("paragraph_count", number(1)),
            ("long_word_count", number(0)),
            ("average_word_length_milli", number(5_000)),
            ("repeated_words", JsonValue::Array(vec![])),
        ]);
        let error = parse_fragment_analysis(&params).unwrap_err();
        assert_eq!(error.code, ERROR_INVALID_PARAMS);
        assert!(error.message.contains("source_text"));
    }

    #[test]
    fn jsonrpc_analyzes_empty_fragment_and_rejects_oversized_fragment() {
        let mut server = JsonRpcServer::new();
        let empty = server.handle_line(&request(1, "analyze_fragment", object([
            ("text", string("")),
            ("base_byte", number(0)),
        ])));
        assert!(empty.contains("\"word_count\":0"));
        assert!(empty.contains("\"sentence_count\":0"));

        let too_large = "x".repeat(MAX_FRAGMENT_ANALYSIS_BYTES + 1);
        let rejected = server.handle_line(&request(2, "analyze_fragment", object([
            ("text", string(too_large)),
            ("base_byte", number(0)),
        ])));
        assert!(rejected.contains("-32602"));
        assert!(rejected.contains("512 KiB"));
    }

    #[test]
    fn jsonrpc_exposes_native_proofreading_diagnostics_with_absolute_offsets() {
        let mut server = JsonRpcServer::new();
        let response = server.handle_line(&request(1, "proofread_fragment", object([
            ("text", string("El niño niño llegó,perro.")),
            ("base_byte", number(200)),
        ])));
        assert!(response.contains("\"repeated_adjacent_word\""), "{response}");
        assert!(response.contains("\"missing_space_after_punctuation\""), "{response}");
        assert!(response.contains("\"start_byte\":209"), "{response}");
        assert!(response.contains("\"severity\":\"warning\""), "{response}");
    }

    #[test]
    fn jsonrpc_proofreads_the_live_paragraph_at_its_current_revision() {
        let (root, pages, journal) = paths();
        let mut server = JsonRpcServer::new();
        let init = object([
            ("project_id", string("project-proofreading-live")),
            ("pages_path", string(pages.to_string_lossy())),
            ("journal_path", string(journal.to_string_lossy())),
            ("queue_capacity", number(8)),
        ]);
        assert!(server.handle_line(&request(1, "initialize", init)).contains("initialized"));
        assert!(server.handle_line(&request(2, "open_document", object([
            ("document_id", string("chapter")),
            ("text", string("Antes.\n\nEl niño niño llegó,perro.\n\nDespués.")),
            ("revision", number(4)),
            ("sequence", number(9)),
        ]))).contains("opened"));
        let response = server.handle_line(&request(3, "proofread_affected_paragraph", object([
            ("document_id", string("chapter")),
            ("selection_start_byte", number(17)),
            ("selection_end_byte", number(22)),
            ("expected_revision", number(4)),
        ])));
        assert!(response.contains("\"repeated_adjacent_word\""), "{response}");
        assert!(response.contains("\"revision\":4"), "{response}");
        assert!(response.contains("\"last_sequence\":9"), "{response}");
        drop(server);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn zero_queue_capacity_is_rejected_during_initialization() {
        // La capacidad inválida se rechaza antes de crear una sesión utilizable.
        let (root, pages, journal) = paths();
        let mut server = JsonRpcServer::new();
        let init = object([
            ("project_id", string("project-zero-queue")),
            ("pages_path", string(pages.to_string_lossy())),
            ("journal_path", string(journal.to_string_lossy())),
            ("queue_capacity", number(0)),
        ]);
        let response = server.handle_line(&request(1, "initialize", init));
        assert!(response.contains("queue_capacity"));
        fs::remove_dir_all(root).unwrap();
    }
}
