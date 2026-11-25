//! Ingestión asíncrona y acotada de cambios del editor.
//!
//! El hilo del editor solo encola deltas mediante try_send. Un worker serializa
//! y confirma cada delta en MLDB. Si la cola está llena, devuelve el delta
//! original al anfitrión para que lo conserve y reintente: nunca lo descarta.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::mpsc::{
    self, Receiver, RecvTimeoutError, SyncSender, TryRecvError, TrySendError,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::persistent::{DurableDocumentChange, PersistentLiveEngine};
use mldb_storage::bundle::SessionLockValidator;
use crate::{AffectedParagraphSnapshot, ApplyOutcome, DocumentSnapshot, EngineError};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingChange {
    pub document_id: String,
    pub sequence: u64,
    pub base_revision: u64,
    pub start_byte: usize,
    pub end_byte: usize,
    pub replacement: String,
}

impl PendingChange {
    pub fn new(
        document_id: impl Into<String>,
        sequence: u64,
        base_revision: u64,
        start_byte: usize,
        end_byte: usize,
        replacement: impl Into<String>,
    ) -> Self {
        Self {
            document_id: document_id.into(),
            sequence,
            base_revision,
            start_byte,
            end_byte,
            replacement: replacement.into(),
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum WorkerError {
    InvalidQueueCapacity,
    Stopped,
    WorkerPanicked,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum SubmitError {
    QueueFull(PendingChange),
    WorkerStopped(PendingChange),
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum TicketError {
    WorkerStopped,
    QueueFull,
    Engine(EngineError),
}

pub struct ChangeTicket {
    receiver: Receiver<Result<ApplyOutcome, EngineError>>,
}

impl ChangeTicket {
    /// Espera la confirmación durable. No debe llamarse desde el hilo de escritura.
    pub fn wait(self) -> Result<ApplyOutcome, TicketError> {
        self.receiver.recv()
            .map_err(|_| TicketError::WorkerStopped)?
            .map_err(TicketError::Engine)
    }

    /// Consulta sin bloquear si el worker ya confirmó el delta.
    pub fn try_result(
        &self,
    ) -> Result<Option<Result<ApplyOutcome, EngineError>>, TicketError> {
        match self.receiver.try_recv() {
            Ok(result) => Ok(Some(result)),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err(TicketError::WorkerStopped),
        }
    }

    /// Espera como máximo el tiempo indicado; None significa que sigue pendiente.
    pub fn wait_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Option<Result<ApplyOutcome, EngineError>>, TicketError> {
        match self.receiver.recv_timeout(timeout) {
            Ok(result) => Ok(Some(result)),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => Err(TicketError::WorkerStopped),
        }
    }
}

/// Resultado diferido de la extracción del párrafo. Consultarlo no bloquea.
pub struct AffectedParagraphTicket {
    receiver: Receiver<Result<AffectedParagraphSnapshot, EngineError>>,
}

impl AffectedParagraphTicket {
    pub fn try_result(
        &self,
    ) -> Result<Option<Result<AffectedParagraphSnapshot, EngineError>>, TicketError> {
        match self.receiver.try_recv() {
            Ok(result) => Ok(Some(result.map_err(TicketError::Engine))),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err(TicketError::WorkerStopped),
        }
    }

    pub fn wait(self) -> Result<AffectedParagraphSnapshot, TicketError> {
        self.receiver.recv()
            .map_err(|_| TicketError::WorkerStopped)?
            .map_err(TicketError::Engine)
    }

    pub fn wait_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Option<Result<AffectedParagraphSnapshot, EngineError>>, TicketError> {
        match self.receiver.recv_timeout(timeout) {
            Ok(result) => Ok(Some(result.map_err(TicketError::Engine))),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => Err(TicketError::WorkerStopped),
        }
    }
}

enum Command {
    OpenDocument {
        document_id: String,
        text: String,
        revision: u64,
        sequence: u64,
        reply: mpsc::Sender<Result<(), EngineError>>,
    },
    ApplyChange {
        change: PendingChange,
        enqueued_at: Instant,
        reply: mpsc::Sender<Result<ApplyOutcome, EngineError>>,
    },
    Snapshot {
        document_id: String,
        reply: mpsc::Sender<Result<DocumentSnapshot, EngineError>>,
    },
    DurableDocumentChanges {
        document_id: String,
        reply: mpsc::Sender<Result<Vec<DurableDocumentChange>, EngineError>>,
    },
    AffectedParagraph {
        document_id: String,
        expected_revision: u64,
        selection_start_byte: usize,
        selection_end_byte: usize,
        enqueued_at: Instant,
        cancelled: Arc<AtomicBool>,
        reply: mpsc::Sender<Result<AffectedParagraphSnapshot, EngineError>>,
    },
    ValidateEvidence {
        document_id: String,
        expected_revision: u64,
        start_byte: usize,
        end_byte: usize,
        excerpt: String,
        reply: mpsc::Sender<Result<(), EngineError>>,
    },
    FragmentMatches {
        document_id: String,
        expected_revision: u64,
        expected_sequence: u64,
        start_byte: usize,
        end_byte: usize,
        expected_text: String,
        reply: mpsc::Sender<Result<(u64, u64, bool), EngineError>>,
    },
    ValidateFragmentAnchor {
        document_id: String,
        expected_revision: u64,
        start_byte: usize,
        end_byte: usize,
        reply: mpsc::Sender<Result<(), EngineError>>,
    },
    Resynchronize {
        document_id: String,
        text: String,
        revision: u64,
        sequence: u64,
        reply: mpsc::Sender<Result<(), EngineError>>,
    },
    Checkpoint {
        document_id: String,
        revision: u64,
        sequence: u64,
        reply: mpsc::Sender<Result<(), EngineError>>,
    },
    CloseDocument {
        document_id: String,
        reply: mpsc::Sender<Result<(), EngineError>>,
    },
    Shutdown,
}

#[derive(Debug, Clone, Default, Eq, PartialEq)]
pub struct WorkerMetricsSnapshot {
    /// Capacidad configurada de cada cola acotada del worker.
    pub queue_capacity: usize,
    /// Pendientes incluye cambios en cola y el cambio que esté confirmándose.
    /// Por eso puede superar la capacidad física de la cola en una unidad.
    pub pending_load_percent: usize,
    pub pending_changes: usize,
    pub processed_changes: u64,
    pub durable_commits: u64,
    pub failed_changes: u64,
    pub sample_count: usize,
    pub last_commit_micros: u64,
    pub p50_commit_micros: u64,
    pub p95_commit_micros: u64,
    pub p99_commit_micros: u64,
    pub max_commit_micros: u64,
    pub end_to_end_sample_count: usize,
    pub last_submit_to_durable_commit_micros: u64,
    pub p50_submit_to_durable_commit_micros: u64,
    pub p95_submit_to_durable_commit_micros: u64,
    pub p99_submit_to_durable_commit_micros: u64,
    pub max_submit_to_durable_commit_micros: u64,
    pub queue_full_rejections: u64,
    pub max_pending_changes: usize,
    pub last_queue_wait_micros: u64,
    pub p50_queue_wait_micros: u64,
    pub p95_queue_wait_micros: u64,
    pub p99_queue_wait_micros: u64,
    pub pending_paragraph_extractions: usize,
    pub paragraph_queue_rejections: u64,
    pub last_extraction_queue_wait_micros: u64,
    pub p50_extraction_queue_wait_micros: u64,
    pub p95_extraction_queue_wait_micros: u64,
    pub p99_extraction_queue_wait_micros: u64,
    pub last_extraction_micros: u64,
    pub p50_extraction_micros: u64,
    pub p95_extraction_micros: u64,
    pub p99_extraction_micros: u64,
}

#[derive(Default)]
struct WorkerMetricsState {
    queue_capacity: usize,
    pending: AtomicUsize,
    processed: AtomicU64,
    durable_commits: AtomicU64,
    failed: AtomicU64,
    last_micros: AtomicU64,
    queue_full_rejections: AtomicU64,
    max_pending: AtomicUsize,
    last_queue_wait_micros: AtomicU64,
    queue_wait_samples: std::sync::Mutex<VecDeque<u64>>,
    samples: std::sync::Mutex<VecDeque<u64>>,
    last_submit_to_durable_commit_micros: AtomicU64,
    end_to_end_samples: std::sync::Mutex<VecDeque<u64>>,
    pending_paragraph_extractions: AtomicUsize,
    paragraph_queue_rejections: AtomicU64,
    last_extraction_queue_wait_micros: AtomicU64,
    extraction_queue_wait_samples: std::sync::Mutex<VecDeque<u64>>,
    last_extraction_micros: AtomicU64,
    extraction_samples: std::sync::Mutex<VecDeque<u64>>,
}

pub struct LiveEngineWorker {
    project_id: String,
    sender: Option<SyncSender<Command>>,
    analysis_sender: Option<SyncSender<Command>>,
    join: Option<JoinHandle<()>>,
    metrics: Arc<WorkerMetricsState>,
}

impl LiveEngineWorker {
    /// Inicia un hilo dedicado con colas acotadas e independientes:
    /// los cambios/control del editor tienen prioridad sobre las lecturas analíticas.
    pub fn open(
        engine: PersistentLiveEngine,
        queue_capacity: usize,
    ) -> Result<Self, WorkerError> {
        Self::open_with_session_validator(engine, queue_capacity, None)
    }

    pub fn open_with_session_validator(
        engine: PersistentLiveEngine,
        queue_capacity: usize,
        session_validator: Option<SessionLockValidator>,
    ) -> Result<Self, WorkerError> {
        if queue_capacity < 2 {
            return Err(WorkerError::InvalidQueueCapacity);
        }
        let project_id = engine.project_id().to_owned();
        let (sender, receiver) = mpsc::sync_channel(queue_capacity);
        let (analysis_sender, analysis_receiver) = mpsc::sync_channel(queue_capacity);
        let metrics = Arc::new(WorkerMetricsState {
            queue_capacity,
            ..WorkerMetricsState::default()
        });
        let worker_metrics = Arc::clone(&metrics);
        let join = thread::Builder::new()
            .name("motor-literario-mldb-writer".to_owned())
            .spawn(move || worker_loop(engine, receiver, analysis_receiver, worker_metrics, session_validator))
            .map_err(|_| WorkerError::Stopped)?;
        Ok(Self {
            project_id,
            sender: Some(sender),
            analysis_sender: Some(analysis_sender),
            join: Some(join),
            metrics,
        })
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    /// Cambios encolados o actualmente en proceso de confirmación durable.
    pub fn pending_changes(&self) -> usize {
        self.metrics.pending.load(Ordering::Relaxed)
    }

    /// Estadísticas de commits y percentiles móviles de las últimas 256 escrituras.
    pub fn metrics(&self) -> WorkerMetricsSnapshot {
        let mut samples = self.metrics.samples.lock()
            .map(|samples| samples.iter().copied().collect::<Vec<_>>())
            .unwrap_or_default();
        samples.sort_unstable();
        let mut end_to_end_samples = self.metrics.end_to_end_samples.lock()
            .map(|samples| samples.iter().copied().collect::<Vec<_>>())
            .unwrap_or_default();
        end_to_end_samples.sort_unstable();
        WorkerMetricsSnapshot {
            queue_capacity: self.metrics.queue_capacity,
            pending_load_percent: {
                let capacity = self.metrics.queue_capacity.max(1);
                self.pending_changes().saturating_mul(100) / capacity
            },
            pending_changes: self.pending_changes(),
            processed_changes: self.metrics.processed.load(Ordering::Relaxed),
            durable_commits: self.metrics.durable_commits.load(Ordering::Relaxed),
            failed_changes: self.metrics.failed.load(Ordering::Relaxed),
            sample_count: samples.len(),
            last_commit_micros: self.metrics.last_micros.load(Ordering::Relaxed),
            p50_commit_micros: percentile(&samples, 50),
            p95_commit_micros: percentile(&samples, 95),
            p99_commit_micros: percentile(&samples, 99),
            max_commit_micros: samples.last().copied().unwrap_or(0),
            end_to_end_sample_count: end_to_end_samples.len(),
            last_submit_to_durable_commit_micros: self.metrics.last_submit_to_durable_commit_micros.load(Ordering::Relaxed),
            p50_submit_to_durable_commit_micros: percentile(&end_to_end_samples, 50),
            p95_submit_to_durable_commit_micros: percentile(&end_to_end_samples, 95),
            p99_submit_to_durable_commit_micros: percentile(&end_to_end_samples, 99),
            max_submit_to_durable_commit_micros: end_to_end_samples.last().copied().unwrap_or(0),
            queue_full_rejections: self.metrics.queue_full_rejections.load(Ordering::Relaxed),
            max_pending_changes: self.metrics.max_pending.load(Ordering::Relaxed),
            last_queue_wait_micros: self.metrics.last_queue_wait_micros.load(Ordering::Relaxed),
            p50_queue_wait_micros: sample_percentile(&self.metrics.queue_wait_samples, 50),
            p95_queue_wait_micros: sample_percentile(&self.metrics.queue_wait_samples, 95),
            p99_queue_wait_micros: sample_percentile(&self.metrics.queue_wait_samples, 99),
            pending_paragraph_extractions: self.metrics.pending_paragraph_extractions.load(Ordering::Relaxed),
            paragraph_queue_rejections: self.metrics.paragraph_queue_rejections.load(Ordering::Relaxed),
            last_extraction_queue_wait_micros: self.metrics.last_extraction_queue_wait_micros.load(Ordering::Relaxed),
            p50_extraction_queue_wait_micros: sample_percentile(&self.metrics.extraction_queue_wait_samples, 50),
            p95_extraction_queue_wait_micros: sample_percentile(&self.metrics.extraction_queue_wait_samples, 95),
            p99_extraction_queue_wait_micros: sample_percentile(&self.metrics.extraction_queue_wait_samples, 99),
            last_extraction_micros: self.metrics.last_extraction_micros.load(Ordering::Relaxed),
            p50_extraction_micros: sample_percentile(&self.metrics.extraction_samples, 50),
            p95_extraction_micros: sample_percentile(&self.metrics.extraction_samples, 95),
            p99_extraction_micros: sample_percentile(&self.metrics.extraction_samples, 99),
        }
    }

    /// Apertura de documento: operación de control, puede esperar a la recuperación MLDB.
    pub fn open_document(
        &self,
        document_id: impl Into<String>,
        host_text: impl Into<String>,
        host_revision: u64,
        host_sequence: u64,
    ) -> Result<(), TicketError> {
        let (reply, response) = mpsc::channel();
        self.sender_ref()
            .map_err(|_| TicketError::WorkerStopped)?
            .send(Command::OpenDocument {
                document_id: document_id.into(),
                text: host_text.into(),
                revision: host_revision,
                sequence: host_sequence,
                reply,
            })
            .map_err(|_| TicketError::WorkerStopped)?;
        response.recv()
            .map_err(|_| TicketError::WorkerStopped)?
            .map_err(TicketError::Engine)
    }

    /// Encola sin esperar a disco. En caso de saturación devuelve el cambio intacto.
    pub fn try_submit_change(
        &self,
        change: PendingChange,
    ) -> Result<ChangeTicket, SubmitError> {
        let Some(sender) = self.sender.as_ref() else {
            return Err(SubmitError::WorkerStopped(change));
        };
        let (reply, receiver) = mpsc::channel();
        let command = Command::ApplyChange { change, enqueued_at: Instant::now(), reply };
        let pending = self.metrics.pending.fetch_add(1, Ordering::Relaxed) + 1;
        match sender.try_send(command) {
            Ok(()) => {
                self.metrics.max_pending.fetch_max(pending, Ordering::Relaxed);
                Ok(ChangeTicket { receiver })
            },
            Err(TrySendError::Full(Command::ApplyChange { change, .. })) => {
                self.metrics.pending.fetch_sub(1, Ordering::Relaxed);
                self.metrics.queue_full_rejections.fetch_add(1, Ordering::Relaxed);
                Err(SubmitError::QueueFull(change))
            }
            Err(TrySendError::Disconnected(Command::ApplyChange { change, .. })) => {
                self.metrics.pending.fetch_sub(1, Ordering::Relaxed);
                Err(SubmitError::WorkerStopped(change))
            }
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                unreachable!("try_submit_change solo envía ApplyChange")
            }
        }
    }

    /// Barrera FIFO: la respuesta incluye todos los cambios encolados anteriormente.
    pub fn snapshot(&self, document_id: impl Into<String>) -> Result<DocumentSnapshot, TicketError> {
        let (reply, response) = mpsc::channel();
        self.sender_ref()
            .map_err(|_| TicketError::WorkerStopped)?
            .send(Command::Snapshot {
                document_id: document_id.into(),
                reply,
            })
            .map_err(|_| TicketError::WorkerStopped)?;
        response.recv()
            .map_err(|_| TicketError::WorkerStopped)?
            .map_err(TicketError::Engine)
    }

    /// Barrera FIFO que devuelve los deltas durables de la época activa.
    pub fn durable_document_changes(
        &self,
        document_id: impl Into<String>,
    ) -> Result<Vec<DurableDocumentChange>, TicketError> {
        let (reply, response) = mpsc::channel();
        self.sender_ref()
            .map_err(|_| TicketError::WorkerStopped)?
            .send(Command::DurableDocumentChanges {
                document_id: document_id.into(), reply,
            })
            .map_err(|_| TicketError::WorkerStopped)?;
        response.recv()
            .map_err(|_| TicketError::WorkerStopped)?
            .map_err(TicketError::Engine)
    }

    /// Encola en el canal analítico independiente la lectura del párrafo afectado.
    /// El worker solo la ejecuta cuando no hay cambios ni controles prioritarios
    /// esperando en la cola principal. No bloquea el hilo del editor.
    pub fn request_affected_paragraph(
        &self,
        document_id: impl Into<String>,
        expected_revision: u64,
        selection_start_byte: usize,
        selection_end_byte: usize,
    ) -> Result<AffectedParagraphTicket, TicketError> {
        self.request_affected_paragraph_cancellable(
            document_id,
            expected_revision,
            selection_start_byte,
            selection_end_byte,
            Arc::new(AtomicBool::new(false)),
        )
    }

    /// Variante que permite al protocolo cancelar la extracción antes de que
    /// el worker la ejecute, si una edición posterior vuelve obsoleto el ticket.
    pub fn request_affected_paragraph_cancellable(
        &self,
        document_id: impl Into<String>,
        expected_revision: u64,
        selection_start_byte: usize,
        selection_end_byte: usize,
        cancelled: Arc<AtomicBool>,
    ) -> Result<AffectedParagraphTicket, TicketError> {
        let Some(sender) = self.analysis_sender.as_ref() else {
            return Err(TicketError::WorkerStopped);
        };
        let (reply, receiver) = mpsc::channel();
        let command = Command::AffectedParagraph {
            document_id: document_id.into(),
            expected_revision,
            selection_start_byte,
            selection_end_byte,
            enqueued_at: Instant::now(),
            cancelled,
            reply,
        };
        self.metrics.pending_paragraph_extractions.fetch_add(1, Ordering::AcqRel);
        match sender.try_send(command) {
            Ok(()) => Ok(AffectedParagraphTicket { receiver }),
            Err(TrySendError::Full(_)) => {
                self.metrics.pending_paragraph_extractions.fetch_sub(1, Ordering::AcqRel);
                self.metrics.paragraph_queue_rejections.fetch_add(1, Ordering::Relaxed);
                Err(TicketError::QueueFull)
            }
            Err(TrySendError::Disconnected(_)) => {
                self.metrics.pending_paragraph_extractions.fetch_sub(1, Ordering::AcqRel);
                Err(TicketError::WorkerStopped)
            }
        }
    }

    /// Variante síncrona para operaciones de control. La escritura interactiva
    /// debe usar request_affected_paragraph y consultar el ticket posteriormente.
    pub fn affected_paragraph(
        &self,
        document_id: impl Into<String>,
        expected_revision: u64,
        selection_start_byte: usize,
        selection_end_byte: usize,
    ) -> Result<AffectedParagraphSnapshot, TicketError> {
        self.request_affected_paragraph(
            document_id, expected_revision, selection_start_byte, selection_end_byte,
        )?.wait()
    }

    /// Valida una cita textual en la revisión exacta mediante una barrera FIFO.
    pub fn validate_evidence(
        &self,
        document_id: impl Into<String>,
        expected_revision: u64,
        start_byte: usize,
        end_byte: usize,
        excerpt: impl Into<String>,
    ) -> Result<(), TicketError> {
        let (reply, response) = mpsc::channel();
        self.sender_ref()
            .map_err(|_| TicketError::WorkerStopped)?
            .send(Command::ValidateEvidence {
                document_id: document_id.into(),
                expected_revision,
                start_byte,
                end_byte,
                excerpt: excerpt.into(),
                reply,
            })
            .map_err(|_| TicketError::WorkerStopped)?;
        response.recv()
            .map_err(|_| TicketError::WorkerStopped)?
            .map_err(TicketError::Engine)
    }

    /// Comprueba revisión y rango de un análisis persistido mediante barrera FIFO.
    pub fn validate_fragment_anchor(
        &self,
        document_id: impl Into<String>,
        expected_revision: u64,
        start_byte: usize,
        end_byte: usize,
    ) -> Result<(), TicketError> {
        let (reply, response) = mpsc::channel();
        self.sender_ref()
            .map_err(|_| TicketError::WorkerStopped)?
            .send(Command::ValidateFragmentAnchor {
                document_id: document_id.into(),
                expected_revision,
                start_byte,
                end_byte,
                reply,
            })
            .map_err(|_| TicketError::WorkerStopped)?;
        response.recv()
            .map_err(|_| TicketError::WorkerStopped)?
            .map_err(TicketError::Engine)
    }

    /// Valida la revisión y el fragmento exacto sin clonar el manuscrito.
    pub fn fragment_matches(
        &self,
        document_id: impl Into<String>,
        expected_revision: u64,
        expected_sequence: u64,
        start_byte: usize,
        end_byte: usize,
        expected_text: impl Into<String>,
    ) -> Result<(u64, u64, bool), TicketError> {
        let (reply, response) = mpsc::channel();
        self.sender_ref()
            .map_err(|_| TicketError::WorkerStopped)?
            .send(Command::FragmentMatches {
                document_id: document_id.into(),
                expected_revision,
                expected_sequence,
                start_byte,
                end_byte,
                expected_text: expected_text.into(),
                reply,
            })
            .map_err(|_| TicketError::WorkerStopped)?;
        response.recv()
            .map_err(|_| TicketError::WorkerStopped)?
            .map_err(TicketError::Engine)
    }

    /// Reemplaza una sesión tras un conflicto/hueco usando el snapshot del anfitrión.
    /// Se procesa en orden FIFO después de los cambios previamente encolados.
    pub fn resynchronize_document(
        &self,
        document_id: impl Into<String>,
        authoritative_text: impl Into<String>,
        revision: u64,
        sequence: u64,
    ) -> Result<(), TicketError> {
        let (reply, response) = mpsc::channel();
        self.sender_ref()
            .map_err(|_| TicketError::WorkerStopped)?
            .send(Command::Resynchronize {
                document_id: document_id.into(),
                text: authoritative_text.into(),
                revision,
                sequence,
                reply,
            })
            .map_err(|_| TicketError::WorkerStopped)?;
        response.recv()
            .map_err(|_| TicketError::WorkerStopped)?
            .map_err(TicketError::Engine)
    }

    /// Debe invocarse solo después de que el anfitrión haya guardado ese snapshot.
    pub fn checkpoint_document(
        &self,
        document_id: impl Into<String>,
        saved_revision: u64,
        saved_sequence: u64,
    ) -> Result<(), TicketError> {
        let (reply, response) = mpsc::channel();
        self.sender_ref()
            .map_err(|_| TicketError::WorkerStopped)?
            .send(Command::Checkpoint {
                document_id: document_id.into(),
                revision: saved_revision,
                sequence: saved_sequence,
                reply,
            })
            .map_err(|_| TicketError::WorkerStopped)?;
        response.recv()
            .map_err(|_| TicketError::WorkerStopped)?
            .map_err(TicketError::Engine)
    }

    pub fn close_document(
        &self,
        document_id: impl Into<String>,
    ) -> Result<(), TicketError> {
        let (reply, response) = mpsc::channel();
        self.sender_ref()
            .map_err(|_| TicketError::WorkerStopped)?
            .send(Command::CloseDocument {
                document_id: document_id.into(),
                reply,
            })
            .map_err(|_| TicketError::WorkerStopped)?;
        response.recv()
            .map_err(|_| TicketError::WorkerStopped)?
            .map_err(TicketError::Engine)
    }

    /// Drena la cola FIFO y espera la terminación limpia del worker.
    pub fn shutdown(&mut self) -> Result<(), WorkerError> {
        // Cerrar la entrada de análisis; el worker drena lo ya aceptado después
        // de procesar todos los cambios de escritura anteriores al Shutdown.
        self.analysis_sender.take();
        let send_failed = self.sender.take()
            .map(|sender| sender.send(Command::Shutdown).is_err())
            .unwrap_or(false);
        let join_panicked = self.join.take()
            .map(|join| join.join().is_err())
            .unwrap_or(false);
        if join_panicked {
            return Err(WorkerError::WorkerPanicked);
        }
        if send_failed {
            return Err(WorkerError::Stopped);
        }
        Ok(())
    }

    fn sender_ref(&self) -> Result<&SyncSender<Command>, WorkerError> {
        self.sender.as_ref().ok_or(WorkerError::Stopped)
    }
}

impl Drop for LiveEngineWorker {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

const MAX_METRIC_SAMPLES: usize = 256;
const MAX_CONSECUTIVE_PRIMARY_COMMANDS: usize = 8;

/// Mantiene una ventana móvil acotada para que las métricas no consuman
/// memoria creciente durante sesiones de escritura prolongadas.
fn record_metric_sample(samples: &std::sync::Mutex<VecDeque<u64>>, value: u64) {
    if let Ok(mut samples) = samples.lock() {
        samples.push_back(value);
        if samples.len() > MAX_METRIC_SAMPLES {
            let _ = samples.pop_front();
        }
    }
}

fn sample_percentile(samples: &std::sync::Mutex<VecDeque<u64>>, percentile_rank: usize) -> u64 {
    let mut sorted = samples.lock()
        .map(|samples| samples.iter().copied().collect::<Vec<_>>())
        .unwrap_or_default();
    sorted.sort_unstable();
    percentile(&sorted, percentile_rank)
}

fn percentile(sorted_samples: &[u64], percentile: usize) -> u64 {
    if sorted_samples.is_empty() {
        return 0;
    }
    let rank = (sorted_samples.len() * percentile + 99) / 100;
    sorted_samples[rank.saturating_sub(1).min(sorted_samples.len() - 1)]
}

fn try_next_worker_command(
    receiver: &Receiver<Command>,
    analysis_receiver: &Receiver<Command>,
    shutting_down: bool,
    primary_commands_since_analysis: &mut usize,
) -> Option<Command> {
    if shutting_down {
        return analysis_receiver.try_recv().ok();
    }

    // Al alcanzar el umbral, el análisis pendiente recibe el siguiente turno.
    // Si no hay análisis, el umbral se conserva para atenderlo en cuanto llegue.
    if *primary_commands_since_analysis >= MAX_CONSECUTIVE_PRIMARY_COMMANDS {
        if let Ok(command) = analysis_receiver.try_recv() {
            *primary_commands_since_analysis = 0;
            return Some(command);
        }
    }

    match receiver.try_recv() {
        Ok(command) => {
            *primary_commands_since_analysis =
                (*primary_commands_since_analysis).saturating_add(1);
            Some(command)
        }
        Err(TryRecvError::Disconnected) => match analysis_receiver.try_recv() {
            Ok(command) => {
                *primary_commands_since_analysis = 0;
                Some(command)
            }
            Err(_) => None,
        },
        Err(TryRecvError::Empty) => match analysis_receiver.try_recv() {
            Ok(command) => {
                *primary_commands_since_analysis = 0;
                Some(command)
            }
            Err(_) => None,
        },
    }
}

fn validate_session_validator(
    validator: &Option<SessionLockValidator>,
) -> Result<(), EngineError> {
    match validator {
        Some(validator) => validator.validate().map_err(EngineError::Persistence),
        None => Ok(()),
    }
}

fn worker_loop(
    mut engine: PersistentLiveEngine,
    receiver: Receiver<Command>,
    analysis_receiver: Receiver<Command>,
    metrics: Arc<WorkerMetricsState>,
    session_validator: Option<SessionLockValidator>,
) {
    let project_id = engine.project_id().to_owned();
    let mut shutting_down = false;
    let mut primary_commands_since_analysis = 0usize;
    loop {
        let command = match try_next_worker_command(
            &receiver,
            &analysis_receiver,
            shutting_down,
            &mut primary_commands_since_analysis,
        ) {
            Some(command) => command,
            None if shutting_down => break,
            None => match receiver.recv_timeout(Duration::from_millis(2)) {
                Ok(command) => {
                    primary_commands_since_analysis =
                        primary_commands_since_analysis.saturating_add(1);
                    command
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    match analysis_receiver.try_recv() {
                        Ok(command) => {
                            primary_commands_since_analysis = 0;
                            command
                        }
                        Err(_) => break,
                    }
                }
            },
        };
        match command {
            Command::OpenDocument { document_id, text, revision, sequence, reply } => {
                let result = validate_session_validator(&session_validator).and_then(|()| engine.open_document(
                    &project_id,
                    document_id,
                    text,
                    revision,
                    sequence,
                ));
                let _ = reply.send(result);
            }
            Command::ApplyChange { change, enqueued_at, reply } => {
                let queue_wait = enqueued_at.elapsed().as_micros().min(u64::MAX as u128) as u64;
                metrics.last_queue_wait_micros.store(queue_wait, Ordering::Relaxed);
                record_metric_sample(&metrics.queue_wait_samples, queue_wait);
                let started = Instant::now();
                let result = validate_session_validator(&session_validator).and_then(|()| engine.apply_change(
                    &project_id,
                    &change.document_id,
                    change.sequence,
                    change.base_revision,
                    change.start_byte,
                    change.end_byte,
                    &change.replacement,
                ));
                let elapsed = started.elapsed().as_micros().min(u64::MAX as u128) as u64;
                metrics.processed.fetch_add(1, Ordering::Relaxed);
                match &result {
                    Ok(ApplyOutcome::Applied { .. }) => {
                        let submit_to_durable = enqueued_at.elapsed()
                            .as_micros().min(u64::MAX as u128) as u64;
                        metrics.durable_commits.fetch_add(1, Ordering::Relaxed);
                        metrics.last_micros.store(elapsed, Ordering::Relaxed);
                        record_metric_sample(&metrics.samples, elapsed);
                        metrics.last_submit_to_durable_commit_micros
                            .store(submit_to_durable, Ordering::Relaxed);
                        record_metric_sample(&metrics.end_to_end_samples, submit_to_durable);
                    }
                    Ok(_) => {}
                    Err(_) => {
                        metrics.failed.fetch_add(1, Ordering::Relaxed);
                    }
                }
                metrics.pending.fetch_sub(1, Ordering::Relaxed);
                let _ = reply.send(result);
            }
            Command::Snapshot { document_id, reply } => {
                let result = engine.snapshot(&project_id, &document_id);
                let _ = reply.send(result);
            }
            Command::DurableDocumentChanges { document_id, reply } => {
                let result = engine.durable_document_changes(&project_id, &document_id);
                let _ = reply.send(result);
            }
            Command::AffectedParagraph {
                document_id, expected_revision, selection_start_byte, selection_end_byte,
                enqueued_at, cancelled, reply,
            } => {
                if cancelled.load(Ordering::Acquire) {
                    // El consumidor ya abandonó este ticket obsoleto. No hacer
                    // extracción innecesaria y liberar el contador de cola.
                    metrics.pending_paragraph_extractions.fetch_sub(1, Ordering::AcqRel);
                    continue;
                }
                let queue_wait = enqueued_at.elapsed().as_micros().min(u64::MAX as u128) as u64;
                metrics.last_extraction_queue_wait_micros.store(queue_wait, Ordering::Relaxed);
                record_metric_sample(&metrics.extraction_queue_wait_samples, queue_wait);
                let started = Instant::now();
                let result = engine.affected_paragraph(
                    &project_id, &document_id, expected_revision, selection_start_byte, selection_end_byte,
                );
                let elapsed = started.elapsed().as_micros().min(u64::MAX as u128) as u64;
                metrics.last_extraction_micros.store(elapsed, Ordering::Relaxed);
                record_metric_sample(&metrics.extraction_samples, elapsed);
                metrics.pending_paragraph_extractions.fetch_sub(1, Ordering::AcqRel);
                let _ = reply.send(result);
            }
            Command::ValidateEvidence {
                document_id, expected_revision, start_byte, end_byte, excerpt, reply,
            } => {
                let result = engine.validate_evidence(
                    &project_id, &document_id, expected_revision, start_byte, end_byte, &excerpt,
                );
                let _ = reply.send(result);
            }
            Command::ValidateFragmentAnchor {
                document_id, expected_revision, start_byte, end_byte, reply,
            } => {
                let result = engine.validate_fragment_anchor(
                    &project_id, &document_id, expected_revision, start_byte, end_byte,
                );
                let _ = reply.send(result);
            }
            Command::FragmentMatches {
                document_id, expected_revision, expected_sequence, start_byte, end_byte, expected_text, reply,
            } => {
                let result = engine.fragment_matches(
                    &project_id, &document_id, expected_revision, expected_sequence,
                    start_byte, end_byte, &expected_text,
                );
                let _ = reply.send(result);
            }
            Command::Resynchronize { document_id, text, revision, sequence, reply } => {
                let result = validate_session_validator(&session_validator).and_then(|()| engine.resynchronize_document(
                    &project_id,
                    &document_id,
                    text,
                    revision,
                    sequence,
                ));
                let _ = reply.send(result);
            }
            Command::Checkpoint { document_id, revision, sequence, reply } => {
                let result = validate_session_validator(&session_validator).and_then(|()| engine.checkpoint_document(
                    &project_id,
                    &document_id,
                    revision,
                    sequence,
                ));
                let _ = reply.send(result);
            }
            Command::CloseDocument { document_id, reply } => {
                let result = validate_session_validator(&session_validator)
                    .and_then(|()| engine.close_document(&project_id, &document_id));
                let _ = reply.send(result);
            }
            Command::Shutdown => shutting_down = true,
        }
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
            "motor-literario-worker-{}-{}",
            std::process::id(),
            NEXT_PATH.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&root).unwrap();
        (root.clone(), root.join("store.pages"), root.join("store.mlpj"))
    }

    #[test]
    fn write_latency_metric_samples_keep_a_bounded_rolling_window() {
        let samples = std::sync::Mutex::new(VecDeque::new());
        for value in 0..(MAX_METRIC_SAMPLES as u64 + 10) {
            record_metric_sample(&samples, value);
        }
        let values = samples.lock().unwrap();
        assert_eq!(values.len(), MAX_METRIC_SAMPLES);
        assert_eq!(values.front().copied(), Some(10));
        assert_eq!(values.back().copied(), Some(MAX_METRIC_SAMPLES as u64 + 9));
        drop(values);
        assert!(sample_percentile(&samples, 95) >= sample_percentile(&samples, 50));
        assert!(sample_percentile(&samples, 99) <= MAX_METRIC_SAMPLES as u64 + 9);
    }

    #[test]
    fn queue_capacity_and_pending_load_are_reported_without_claiming_physical_occupancy() {
        let (root, pages, wal) = paths();
        {
            let engine = PersistentLiveEngine::open("book-queue-metrics", &pages, &wal).unwrap();
            let mut worker = LiveEngineWorker::open(engine, 7).unwrap();
            let metrics = worker.metrics();
            assert_eq!(metrics.queue_capacity, 7);
            assert_eq!(metrics.pending_changes, 0);
            assert_eq!(metrics.pending_load_percent, 0);

            worker.open_document("chapter", "Texto", 0, 0).unwrap();
            let ticket = worker.try_submit_change(
                PendingChange::new("chapter", 1, 0, 5, 5, "!")
            ).unwrap();
            assert_eq!(ticket.wait().unwrap(),
                ApplyOutcome::Applied { revision: 1, invalidated_suggestions: 0 });
            let metrics = worker.metrics();
            assert_eq!(metrics.queue_capacity, 7);
            assert_eq!(metrics.pending_changes, 0);
            assert_eq!(metrics.pending_load_percent, 0);
            worker.shutdown().unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pending_analysis_gets_a_turn_after_eight_primary_commands() {
        let (primary_sender, primary_receiver) = mpsc::channel();
        let (analysis_sender, analysis_receiver) = mpsc::channel();
        for _ in 0..12 {
            primary_sender.send(Command::Shutdown).unwrap();
        }
        analysis_sender.send(Command::Shutdown).unwrap();

        let mut primary_streak = 0;
        for _ in 0..MAX_CONSECUTIVE_PRIMARY_COMMANDS {
            assert!(matches!(
                try_next_worker_command(
                    &primary_receiver, &analysis_receiver, false, &mut primary_streak,
                ),
                Some(Command::Shutdown)
            ));
        }
        assert_eq!(primary_streak, MAX_CONSECUTIVE_PRIMARY_COMMANDS);

        assert!(matches!(
            try_next_worker_command(
                &primary_receiver, &analysis_receiver, false, &mut primary_streak,
            ),
            Some(Command::Shutdown)
        ));
        assert_eq!(primary_streak, 0);

        // El turno analítico no descarta ni reordena los comandos de escritura.
        assert!(matches!(
            try_next_worker_command(
                &primary_receiver, &analysis_receiver, false, &mut primary_streak,
            ),
            Some(Command::Shutdown)
        ));
        assert_eq!(primary_streak, 1);
    }

    #[test]
    fn analysis_turn_threshold_is_retained_until_a_read_arrives() {
        let (primary_sender, primary_receiver) = mpsc::channel();
        let (analysis_sender, analysis_receiver) = mpsc::channel();
        for _ in 0..12 {
            primary_sender.send(Command::Shutdown).unwrap();
        }

        let mut primary_streak = 0;
        for _ in 0..MAX_CONSECUTIVE_PRIMARY_COMMANDS {
            assert!(matches!(
                try_next_worker_command(
                    &primary_receiver, &analysis_receiver, false, &mut primary_streak,
                ),
                Some(Command::Shutdown)
            ));
        }
        assert_eq!(primary_streak, MAX_CONSECUTIVE_PRIMARY_COMMANDS);

        // Sin extracción pendiente, el worker sigue procesando la cola primaria
        // y conserva el turno debido para el primer análisis que llegue.
        assert!(matches!(
            try_next_worker_command(
                &primary_receiver, &analysis_receiver, false, &mut primary_streak,
            ),
            Some(Command::Shutdown)
        ));
        assert_eq!(primary_streak, MAX_CONSECUTIVE_PRIMARY_COMMANDS + 1);

        analysis_sender.send(Command::Shutdown).unwrap();
        assert!(matches!(
            try_next_worker_command(
                &primary_receiver, &analysis_receiver, false, &mut primary_streak,
            ),
            Some(Command::Shutdown)
        ));
        assert_eq!(primary_streak, 0);
    }

    #[test]
    fn paragraph_reads_use_separate_queue_and_editor_changes_are_admitted() {
        let (root, pages, wal) = paths();
        {
            let engine = PersistentLiveEngine::open("book-priority", &pages, &wal).unwrap();
            let worker = LiveEngineWorker::open(engine, 2).unwrap();
            worker.open_document("chapter", "Texto", 0, 0).unwrap();

            // La lectura se envía por un canal independiente del canal de escritura.
            let extraction = worker.request_affected_paragraph("chapter", 0, 0, 1).unwrap();
            let change = worker.try_submit_change(
                PendingChange::new("chapter", 1, 0, 5, 5, " nuevo")
            ).expect("la cola analítica no debe bloquear la admisión del editor");
            // La extracción puede observar la revisión anterior o ser rechazada
            // si el cambio prioritario ya avanzó el documento. Nunca debe devolver
            // texto de una revisión distinta de la solicitada.
            let extraction_result = extraction.wait();
            assert!(matches!(
                &extraction_result,
                Ok(AffectedParagraphSnapshot { revision: 0, last_sequence: 0, text, .. })
                    if text == "Texto"
            ) || matches!(
                &extraction_result,
                Err(TicketError::Engine(EngineError::AnalysisRevisionConflict {
                    expected: 0, received: 1, last_sequence: 1,
                }))
            ));
            assert!(matches!(
                change.wait().unwrap(),
                ApplyOutcome::Applied { revision: 1, .. }
            ));
            let metrics = worker.metrics();
            assert_eq!(metrics.pending_paragraph_extractions, 0);
            assert_eq!(metrics.paragraph_queue_rejections, 0);
            worker.shutdown().unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancelled_paragraph_extraction_is_skipped_before_engine_read() {
        use std::time::{Duration, Instant};

        let (root, pages, wal) = paths();
        {
            let engine = PersistentLiveEngine::open("book-cancelled-read", &pages, &wal).unwrap();
            let worker = LiveEngineWorker::open(engine, 4).unwrap();
            worker.open_document("chapter", "Texto original", 0, 0).unwrap();

            let cancelled = Arc::new(AtomicBool::new(true));
            let ticket = worker.request_affected_paragraph_cancellable(
                "chapter", 0, 0, 6, Arc::clone(&cancelled),
            ).unwrap();
            drop(ticket);

            let deadline = Instant::now() + Duration::from_secs(2);
            while worker.metrics().pending_paragraph_extractions != 0 {
                assert!(Instant::now() < deadline, "cancelled extraction remained queued");
                std::thread::yield_now();
            }
            let metrics = worker.metrics();
            assert_eq!(metrics.last_extraction_micros, 0);
            assert_eq!(metrics.p50_extraction_micros, 0);
            worker.shutdown().unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn queued_changes_are_committed_in_order_and_shutdown_drains_them() {
        let (root, pages, wal) = paths();
        {
            let engine = PersistentLiveEngine::open("book-worker", &pages, &wal).unwrap();
            let mut worker = LiveEngineWorker::open(engine, 8).unwrap();
            worker.open_document("chapter", "A", 0, 0).unwrap();

            let first = worker.try_submit_change(
                PendingChange::new("chapter", 1, 0, 1, 1, "B")
            ).unwrap();
            let second = worker.try_submit_change(
                PendingChange::new("chapter", 2, 1, 2, 2, "C")
            ).unwrap();

            assert_eq!(
                first.wait().unwrap(),
                ApplyOutcome::Applied { revision: 1, invalidated_suggestions: 0 }
            );
            assert_eq!(
                second.wait().unwrap(),
                ApplyOutcome::Applied { revision: 2, invalidated_suggestions: 0 }
            );
            assert_eq!(worker.snapshot("chapter").unwrap().text, "ABC");
            let paragraph = worker.affected_paragraph("chapter", 2, 1, 2).unwrap();
            assert_eq!(paragraph.text, "ABC");
            assert_eq!(paragraph.revision, 2);
            assert_eq!(paragraph.last_sequence, 2);
            worker.validate_evidence("chapter", 2, 0, 3, "ABC").unwrap();
            assert_eq!(
                worker.validate_evidence("chapter", 2, 0, 3, "ABD"),
                Err(TicketError::Engine(EngineError::EvidenceExcerptMismatch)),
            );
            assert_eq!(
                worker.validate_evidence("chapter", 1, 0, 3, "ABC"),
                Err(TicketError::Engine(EngineError::EvidenceRevisionConflict {
                    expected: 1, received: 2, last_sequence: 2,
                })),
            );
            assert_eq!(
                worker.affected_paragraph("chapter", 1, 500, 501),
                Err(TicketError::Engine(EngineError::AnalysisRevisionConflict {
                    expected: 1, received: 2, last_sequence: 2,
                })),
            );
            let metrics = worker.metrics();
            assert_eq!(metrics.processed_changes, 2);
            assert_eq!(metrics.durable_commits, 2);
            assert_eq!(metrics.failed_changes, 0);
            assert_eq!(metrics.sample_count, 2);
            assert!(metrics.max_pending_changes >= 1);
            assert!(metrics.max_pending_changes <= 8);
            assert_eq!(metrics.queue_full_rejections, 0);
            assert!(metrics.p95_queue_wait_micros >= metrics.p50_queue_wait_micros);
            assert!(metrics.p95_commit_micros >= metrics.p50_commit_micros);
            assert!(metrics.max_commit_micros >= metrics.p99_commit_micros);
            assert_eq!(metrics.end_to_end_sample_count, 2);
            assert!(metrics.last_submit_to_durable_commit_micros >= metrics.last_queue_wait_micros);
            assert!(metrics.p95_submit_to_durable_commit_micros >= metrics.p50_submit_to_durable_commit_micros);
            assert!(metrics.max_submit_to_durable_commit_micros >= metrics.p99_submit_to_durable_commit_micros);
            worker.shutdown().unwrap();
        }
        {
            let mut engine = PersistentLiveEngine::open("book-worker", &pages, &wal).unwrap();
            engine.open_document("book-worker", "chapter", "A", 0, 0).unwrap();
            assert_eq!(engine.snapshot("book-worker", "chapter").unwrap().text, "ABC");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn affected_paragraph_ticket_can_be_polled_without_waiting() {
        let (root, pages, wal) = paths();
        {
            let engine = PersistentLiveEngine::open("book-ticket", &pages, &wal).unwrap();
            let worker = LiveEngineWorker::open(engine, 4).unwrap();
            worker.open_document("chapter", "Texto inicial", 3, 7).unwrap();

            let ticket = worker.request_affected_paragraph("chapter", 3, 0, 5).unwrap();
            let paragraph = ticket.wait_timeout(Duration::from_secs(2)).unwrap()
                .expect("el worker debe completar la extracción")
                .unwrap();
            assert_eq!(paragraph.text, "Texto inicial");
            assert_eq!(paragraph.revision, 3);
            assert_eq!(paragraph.last_sequence, 7);

            let stale = worker.request_affected_paragraph("chapter", 2, 0, 5).unwrap();
            assert_eq!(
                stale.wait().unwrap_err(),
                TicketError::Engine(EngineError::AnalysisRevisionConflict {
                    expected: 2, received: 3, last_sequence: 7,
                }),
            );
            worker.shutdown().unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn worker_accepts_authoritative_resynchronization_after_sequence_gap() {
        let (root, pages, wal) = paths();
        {
            let engine = PersistentLiveEngine::open("book-worker", &pages, &wal).unwrap();
            let mut worker = LiveEngineWorker::open(engine, 4).unwrap();
            worker.open_document("chapter", "A", 0, 0).unwrap();
            let gap = worker.try_submit_change(
                PendingChange::new("chapter", 2, 0, 1, 1, "X")
            ).unwrap();
            assert!(matches!(
                gap.wait().unwrap(),
                ApplyOutcome::ResyncRequired { expected_sequence: 1, received_sequence: 2 }
            ));
            worker.resynchronize_document("chapter", "A!", 10, 5).unwrap();
            let next = worker.try_submit_change(
                PendingChange::new("chapter", 6, 10, 2, 2, "B")
            ).unwrap();
            assert!(matches!(next.wait().unwrap(), ApplyOutcome::Applied { revision: 11, .. }));
            assert_eq!(worker.snapshot("chapter").unwrap().text, "A!B");
            worker.shutdown().unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writer_burst_preserves_all_deltas_while_analysis_is_queued() {
        let (root, pages, wal) = paths();
        {
            let engine = PersistentLiveEngine::open("book-burst", &pages, &wal).unwrap();
            let worker = LiveEngineWorker::open(engine, 128).unwrap();
            worker.open_document("chapter", "seed", 0, 0).unwrap();
            let mut changes = Vec::new();
            let mut extractions = Vec::new();
            for index in 0..96u64 {
                extractions.push(worker.request_affected_paragraph("chapter", 0, 0, 0).unwrap());
                changes.push(worker.try_submit_change(PendingChange::new(
                    "chapter", index + 1, index, 4 + index as usize, 4 + index as usize, "x",
                )).unwrap());
            }
            for ticket in changes {
                assert!(matches!(ticket.wait().unwrap(), ApplyOutcome::Applied { .. }));
            }
            for ticket in extractions {
                match ticket.wait() {
                    Ok(snapshot) => {
                        assert_eq!(snapshot.revision, 0);
                        assert_eq!(snapshot.text, "seed");
                    }
                    Err(TicketError::Engine(EngineError::AnalysisRevisionConflict { expected: 0, received, last_sequence })) => {
                        assert!((1..=96).contains(&received));
                        assert_eq!(received, last_sequence);
                    }
                    _ => panic!("unexpected extraction result"),
                }
            }
            let snapshot = worker.snapshot("chapter").unwrap();
            assert_eq!(snapshot.text, format!("seed{}", "x".repeat(96)));
            assert_eq!(snapshot.revision, 96);
            assert_eq!(snapshot.last_sequence, 96);
            let metrics = worker.metrics();
            assert_eq!(metrics.durable_commits, 96);
            assert_eq!(metrics.pending_changes, 0);
            assert_eq!(metrics.pending_paragraph_extractions, 0);
            worker.shutdown().unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn sustained_writer_load_keeps_durable_order_and_serves_analysis() {
        let (root, pages, wal) = paths();
        {
            const WRITES: u64 = 512;
            const QUEUE_CAPACITY: usize = 32;
            let engine = PersistentLiveEngine::open("book-sustained", &pages, &wal).unwrap();
            let mut worker = LiveEngineWorker::open(engine, QUEUE_CAPACITY).unwrap();
            worker.open_document("chapter", "seed", 0, 0).unwrap();

            let mut changes = VecDeque::new();
            let mut extractions = Vec::new();
            let mut completed_writes = 0u64;
            let mut completed_extractions = 0usize;

            for sequence in 1..=WRITES {
                if sequence % 8 == 1 {
                    if let Ok(ticket) = worker.request_affected_paragraph(
                        "chapter",
                        sequence - 1,
                        4 + (sequence - 1) as usize,
                        4 + (sequence - 1) as usize,
                    ) {
                        extractions.push(ticket);
                    }
                }

                let offset = 4 + (sequence - 1) as usize;
                let change = PendingChange::new(
                    "chapter",
                    sequence,
                    sequence - 1,
                    offset,
                    offset,
                    "x",
                );
                match worker.try_submit_change(change) {
                    Ok(ticket) => changes.push_back(ticket),
                    Err(SubmitError::QueueFull(change)) => {
                        let oldest = changes.pop_front().expect("full queue has an accepted change");
                        assert!(matches!(oldest.wait().unwrap(), ApplyOutcome::Applied { .. }));
                        completed_writes += 1;
                        let ticket = worker.try_submit_change(change).expect("retry after freeing capacity");
                        changes.push_back(ticket);
                    }
                    Err(SubmitError::WorkerStopped(_)) => panic!("worker stopped during sustained load"),
                }

                if changes.len() >= QUEUE_CAPACITY / 2 {
                    let oldest = changes.pop_front().unwrap();
                    assert!(matches!(oldest.wait().unwrap(), ApplyOutcome::Applied { .. }));
                    completed_writes += 1;
                }
            }

            while let Some(ticket) = changes.pop_front() {
                assert!(matches!(ticket.wait().unwrap(), ApplyOutcome::Applied { .. }));
                completed_writes += 1;
            }
            for ticket in extractions {
                match ticket.wait() {
                    Ok(snapshot) => {
                        assert!(snapshot.revision <= WRITES);
                        completed_extractions += 1;
                    }
                    Err(TicketError::Engine(EngineError::AnalysisRevisionConflict { .. })) => {
                        completed_extractions += 1;
                    }
                    other => panic!("unexpected analysis result: {other:?}"),
                }
            }

            let snapshot = worker.snapshot("chapter").unwrap();
            assert_eq!(snapshot.text, format!("seed{}", "x".repeat(WRITES as usize)));
            assert_eq!(snapshot.revision, WRITES);
            assert_eq!(snapshot.last_sequence, WRITES);

            let metrics = worker.metrics();
            assert_eq!(completed_writes, WRITES);
            assert_eq!(metrics.durable_commits, WRITES);
            assert_eq!(metrics.processed_changes, WRITES);
            assert_eq!(metrics.failed_changes, 0);
            assert_eq!(metrics.pending_changes, 0);
            assert_eq!(metrics.end_to_end_sample_count, MAX_METRIC_SAMPLES);
            assert_eq!(metrics.sample_count, MAX_METRIC_SAMPLES);
            assert!(metrics.max_pending_changes <= QUEUE_CAPACITY + 1);
            assert!(metrics.max_pending_changes >= 1);
            assert!(metrics.p95_submit_to_durable_commit_micros >= metrics.p50_submit_to_durable_commit_micros);
            assert!(metrics.p99_submit_to_durable_commit_micros >= metrics.p95_submit_to_durable_commit_micros);
            assert!(completed_extractions > 0);
            assert_eq!(metrics.pending_paragraph_extractions, 0);
            assert!(metrics.p95_extraction_micros >= metrics.p50_extraction_micros);
            worker.shutdown().unwrap();
        }
        {
            let mut engine = PersistentLiveEngine::open("book-sustained", &pages, &wal).unwrap();
            engine.open_document(
                "book-sustained",
                "chapter",
                "seed",
                0,
                0,
            ).unwrap();
            let recovered = engine.snapshot("book-sustained", "chapter").unwrap();
            assert_eq!(recovered.text, format!("seed{}", "x".repeat(512)));
            assert_eq!(recovered.revision, 512);
            assert_eq!(recovered.last_sequence, 512);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_producers_preserve_each_document_order_under_queue_pressure() {
        const PRODUCERS: usize = 4;
        const WRITES_PER_PRODUCER: usize = 24;
        const CAPACITY: usize = 8;

        let (root, pages, wal) = paths();
        {
            let engine = PersistentLiveEngine::open("book-concurrent-producers", &pages, &wal).unwrap();
            let worker = Arc::new(LiveEngineWorker::open(engine, CAPACITY).unwrap());
            for producer in 0..PRODUCERS {
                worker.open_document(format!("chapter-{producer}"), "seed", 0, 0).unwrap();
            }

            let mut producers = Vec::new();
            for producer in 0..PRODUCERS {
                let worker = Arc::clone(&worker);
                producers.push(std::thread::spawn(move || {
                    let document_id = format!("chapter-{producer}");
                    let mut tickets = VecDeque::new();
                    for sequence in 1..=WRITES_PER_PRODUCER as u64 {
                        let offset = 4 + (sequence as usize - 1);
                        let change = PendingChange::new(
                            document_id.clone(), sequence, sequence - 1,
                            offset, offset, "x",
                        );
                        let mut pending_change = change;
                        loop {
                            match worker.try_submit_change(pending_change) {
                                Ok(ticket) => {
                                    tickets.push_back(ticket);
                                    break;
                                }
                                Err(SubmitError::QueueFull(change)) => {
                                    pending_change = change;
                                    if let Some(oldest) = tickets.pop_front() {
                                        assert!(matches!(
                                            oldest.wait().unwrap(),
                                            ApplyOutcome::Applied { .. }
                                        ));
                                    } else {
                                        // Otro productor puede ocupar toda la cola antes
                                        // del primer envío de este hilo. Ceder permite que
                                        // el worker libere espacio sin bloquear el editor.
                                        std::thread::yield_now();
                                    }
                                }
                                Err(SubmitError::WorkerStopped(_)) => {
                                    panic!("worker detenido durante productores concurrentes");
                                }
                            }
                        }
                    }
                    while let Some(ticket) = tickets.pop_front() {
                        assert!(matches!(
                            ticket.wait().unwrap(),
                            ApplyOutcome::Applied { .. }
                        ));
                    }
                    document_id
                }));
            }

            for producer in producers {
                let document_id = producer.join().expect("productor concurrente sin panic");
                let snapshot = worker.snapshot(&document_id).unwrap();
                assert_eq!(snapshot.text, format!("seed{}", "x".repeat(WRITES_PER_PRODUCER)));
                assert_eq!(snapshot.revision, WRITES_PER_PRODUCER as u64);
                assert_eq!(snapshot.last_sequence, WRITES_PER_PRODUCER as u64);
            }

            let metrics = worker.metrics();
            assert_eq!(metrics.durable_commits, (PRODUCERS * WRITES_PER_PRODUCER) as u64);
            assert_eq!(metrics.failed_changes, 0);
            assert_eq!(metrics.pending_changes, 0);
            assert!(metrics.max_pending_changes > 0);
            // La contención exacta depende del planificador; los productores
            // mantienen reintento correcto tanto con como sin QueueFull.
            Arc::get_mut(&mut worker).expect("todos los productores terminaron").shutdown().unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn zero_capacity_is_rejected() {
        let (root, pages, wal) = paths();
        let engine = PersistentLiveEngine::open("book-worker", &pages, &wal).unwrap();
        assert_eq!(
            LiveEngineWorker::open(engine, 0).err(),
            Some(WorkerError::InvalidQueueCapacity)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extraction_percentiles_use_nearest_rank_and_handle_empty_samples() {
        let sorted = [10, 20, 30, 40];
        assert_eq!(percentile(&[], 50), 0);
        assert_eq!(percentile(&sorted, 0), 10);
        assert_eq!(percentile(&sorted, 50), 20);
        assert_eq!(percentile(&sorted, 95), 40);
        assert_eq!(percentile(&sorted, 99), 40);
    }

    #[test]
    fn extraction_sample_percentiles_sort_the_bounded_window() {
        let samples = std::sync::Mutex::new(VecDeque::from([40, 10, 30, 20]));
        assert_eq!(sample_percentile(&samples, 50), 20);
        assert_eq!(sample_percentile(&samples, 95), 40);
        assert_eq!(samples.lock().unwrap().len(), 4);
    }


    #[test]
    fn metric_sample_window_is_bounded_and_discards_oldest_values() {
        let samples = std::sync::Mutex::new(VecDeque::new());
        for value in 0..(MAX_METRIC_SAMPLES as u64 + 10) {
            record_metric_sample(&samples, value);
        }
        let samples = samples.lock().unwrap();
        assert_eq!(samples.len(), MAX_METRIC_SAMPLES);
        assert_eq!(samples.front(), Some(&10));
        assert_eq!(samples.back(), Some(&(MAX_METRIC_SAMPLES as u64 + 9)));
    }

}
