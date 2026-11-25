//! Núcleo de sincronización en vivo del Motor Literario.
 //! Los cambios solo se aplican cuando los envía el anfitrión; el adaptador
 //! persistente registra deltas durables en MLDB sin guardar el manuscrito
 //! completo por cada pulsación.
 
 use std::collections::BTreeMap;
 
 pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
 const RECENT_SEQUENCE_WINDOW: usize = 1024;
 
 #[derive(Debug, Clone, PartialEq, Eq)]
 pub enum EngineError {
     InvalidIdentifier(&'static str),
     ProjectAlreadyOpen,
     ProjectNotOpen,
    DocumentAlreadyOpen,
    DocumentNotOpen,
     InvalidRange,
     InvalidUtf8Boundary,
     SequenceGap { expected: u64, received: u64 },
     RevisionConflict { expected: u64, received: u64 },
    AnalysisRevisionConflict { expected: u64, received: u64, last_sequence: u64 },
    EvidenceRevisionConflict { expected: u64, received: u64, last_sequence: u64 },
    EvidenceExcerptMismatch,
     ResynchronizationRequired,
    CounterExhausted(&'static str),
    Persistence(String),
    PersistenceRecoveryRequired,
 }
 
 #[derive(Debug, Clone, PartialEq, Eq)]
 pub enum ApplyOutcome {
     Applied { revision: u64, invalidated_suggestions: usize },
     Duplicate { revision: u64 },
     ResyncRequired { expected_sequence: u64, received_sequence: u64 },
 }
 
 #[derive(Debug, Clone, PartialEq, Eq)]
 pub struct Suggestion {
     pub id: String,
     pub fragment_id: String,
     pub document_revision: u64,
     pub start_byte: usize,
     pub end_byte: usize,
     pub message: String,
     pub stale: bool,
 }
 
 #[derive(Debug, Clone, PartialEq, Eq)]
 pub struct DocumentSnapshot {
     pub project_id: String,
     pub document_id: String,
     pub revision: u64,
     pub last_sequence: u64,
     pub text: String,
     pub active_suggestions: usize,
     pub stale_suggestions: usize,
 }

/// Fragmento de párrafo extraído de una revisión exacta del documento vivo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AffectedParagraphSnapshot {
    pub project_id: String,
    pub document_id: String,
    pub revision: u64,
    pub last_sequence: u64,
    pub start_byte: usize,
    pub end_byte: usize,
    pub text: String,
}
 
 #[derive(Debug, Clone, PartialEq, Eq)]
 struct AppliedChange {
     sequence: u64,
     base_revision: u64,
     start_byte: usize,
     end_byte: usize,
     replacement: String,
 }
 
 /// Sesión local de un libro/documento abierto por el anfitrión.
 /// El project_id y document_id siempre proceden del anfitrión.
 #[derive(Clone)]
pub struct LiveSession {
     project_id: String,
     document_id: String,
     text: crate::RopeText,
     revision: u64,
     last_sequence: u64,
     recent_changes: BTreeMap<u64, AppliedChange>,
     suggestions: BTreeMap<String, Suggestion>,
     active_suggestion_count: usize,
     stale_suggestion_count: usize,
 }
 
 impl LiveSession {
     pub fn open(
         project_id: impl Into<String>,
         document_id: impl Into<String>,
         initial_text: impl Into<String>,
         initial_revision: u64,
         initial_sequence: u64,
     ) -> Result<Self, EngineError> {
         let project_id = project_id.into();
         let document_id = document_id.into();
         if project_id.trim().is_empty() || project_id.len() > 128 {
             return Err(EngineError::InvalidIdentifier("project_id"));
         }
         if document_id.trim().is_empty() || document_id.len() > 128 {
             return Err(EngineError::InvalidIdentifier("document_id"));
         }
         Ok(Self {
             project_id,
             document_id,
             text: crate::RopeText::new(initial_text),
             revision: initial_revision,
             last_sequence: initial_sequence,
             recent_changes: BTreeMap::new(),
             suggestions: BTreeMap::new(),
             active_suggestion_count: 0,
             stale_suggestion_count: 0,
         })
     }
 
     pub fn snapshot(&self) -> DocumentSnapshot {
         DocumentSnapshot {
             project_id: self.project_id.clone(),
             document_id: self.document_id.clone(),
             revision: self.revision,
             last_sequence: self.last_sequence,
             text: self.text.to_string(),
             active_suggestions: self.active_suggestion_count,
             stale_suggestions: self.stale_suggestion_count,
         }
     }
 
     /// Registra una sugerencia; nunca escribe en el documento.
     pub fn add_suggestion(&mut self, suggestion: Suggestion) -> Result<(), EngineError> {
         if suggestion.id.trim().is_empty() || suggestion.fragment_id.trim().is_empty() {
             return Err(EngineError::InvalidIdentifier("suggestion/fragment"));
         }
         if suggestion.document_revision != self.revision
             || suggestion.start_byte > suggestion.end_byte
             || suggestion.end_byte > self.text.len()
             || !self.text.is_char_boundary(suggestion.start_byte)
             || !self.text.is_char_boundary(suggestion.end_byte)
         {
             return Err(EngineError::ResynchronizationRequired);
         }
         let id = suggestion.id.clone();
         if let Some(previous) = self.suggestions.insert(id, suggestion.clone()) {
             let previous_is_stale = previous.stale || previous.document_revision != self.revision;
             if previous_is_stale {
                 self.stale_suggestion_count = self.stale_suggestion_count.saturating_sub(1);
             } else {
                 self.active_suggestion_count = self.active_suggestion_count.saturating_sub(1);
             }
         }
         if suggestion.stale {
             self.stale_suggestion_count = self.stale_suggestion_count.saturating_add(1);
         } else {
             self.active_suggestion_count = self.active_suggestion_count.saturating_add(1);
         }
         Ok(())
     }
 
     /// Comprueba si un fragmento sigue vigente sin clonar el documento completo.
    pub fn fragment_matches(
        &self,
        expected_revision: u64,
        expected_sequence: u64,
        start_byte: usize,
        end_byte: usize,
        expected_text: &str,
    ) -> bool {
        self.revision == expected_revision
            && self.last_sequence == expected_sequence
            && self.text.get(start_byte..end_byte).as_deref() == Some(expected_text)
    }

    pub fn revision(&self) -> u64 { self.revision }

     pub fn last_sequence(&self) -> u64 { self.last_sequence }

     /// Extrae solo el párrafo afectado; evita clonar el manuscrito completo.
     pub fn affected_paragraph(
         &self,
         selection_start_byte: usize,
         selection_end_byte: usize,
     ) -> Option<AffectedParagraphSnapshot> {
         let (start_byte, end_byte) = crate::segmentation::affected_paragraph_range_rope(
             &self.text, selection_start_byte, selection_end_byte,
         )?;
         let text = self.text.get(start_byte..end_byte)?.to_owned();
         Some(AffectedParagraphSnapshot {
             project_id: self.project_id.clone(),
             document_id: self.document_id.clone(),
             revision: self.revision,
             last_sequence: self.last_sequence,
             start_byte,
             end_byte,
             text,
         })
     }

     /// Comprueba la procedencia textual de una evidencia sin clonar el manuscrito.
     pub fn validate_evidence_excerpt(
         &self,
         expected_revision: u64,
         start_byte: usize,
         end_byte: usize,
         excerpt: &str,
     ) -> Result<(), EngineError> {
         if self.revision != expected_revision {
             return Err(EngineError::EvidenceRevisionConflict {
                 expected: expected_revision,
                 received: self.revision,
                 last_sequence: self.last_sequence,
             });
         }
         if start_byte >= end_byte {
             return Err(EngineError::InvalidRange);
         }
         match self.text.get(start_byte..end_byte) {
             Some(source) if source.as_str() == excerpt => Ok(()),
             _ => Err(EngineError::EvidenceExcerptMismatch),
         }
     }

     /// Comprueba revisión y rango UTF-8 de un análisis persistido sin copiar texto.
    pub fn validate_fragment_anchor(
        &self,
        expected_revision: u64,
        start_byte: usize,
        end_byte: usize,
    ) -> Result<(), EngineError> {
        if self.revision != expected_revision {
            return Err(EngineError::AnalysisRevisionConflict {
                expected: expected_revision,
                received: self.revision,
                last_sequence: self.last_sequence,
            });
        }
        if start_byte > end_byte || end_byte > self.text.len() {
            return Err(EngineError::InvalidRange);
        }
        if !self.text.is_char_boundary(start_byte) || !self.text.is_char_boundary(end_byte) {
            return Err(EngineError::InvalidUtf8Boundary);
        }
        Ok(())
    }

    /// Valida un cambio sin clonar ni modificar el texto del documento.
     /// Devuelve Some para duplicados/huecos y None cuando el cambio puede aplicarse.
     pub fn validate_change(
         &self,
         sequence: u64,
         base_revision: u64,
         start_byte: usize,
         end_byte: usize,
         replacement: &str,
     ) -> Result<Option<ApplyOutcome>, EngineError> {
         if sequence <= self.last_sequence {
             let identical = self.recent_changes.get(&sequence).is_some_and(|previous| {
                 previous.base_revision == base_revision
                     && previous.start_byte == start_byte
                     && previous.end_byte == end_byte
                     && previous.replacement.as_str() == replacement
             });
             return Ok(Some(if identical {
                 ApplyOutcome::Duplicate { revision: self.revision }
             } else {
                 ApplyOutcome::ResyncRequired {
                     expected_sequence: self.last_sequence.saturating_add(1),
                     received_sequence: sequence,
                 }
             }));
         }
         let expected_sequence = self.last_sequence.checked_add(1)
             .ok_or(EngineError::CounterExhausted("sequence"))?;
         if sequence != expected_sequence {
             return Ok(Some(ApplyOutcome::ResyncRequired {
                 expected_sequence,
                 received_sequence: sequence,
             }));
         }
         if base_revision != self.revision {
             return Err(EngineError::RevisionConflict {
                 expected: self.revision,
                 received: base_revision,
             });
         }
         if start_byte > end_byte || end_byte > self.text.len() {
             return Err(EngineError::InvalidRange);
         }
         if !self.text.is_char_boundary(start_byte) || !self.text.is_char_boundary(end_byte) {
             return Err(EngineError::InvalidUtf8Boundary);
         }
         self.revision.checked_add(1)
             .ok_or(EngineError::CounterExhausted("revision"))?;
         Ok(None)
     }

     /// Aplica exclusivamente un cambio incremental recibido del editor anfitrión.
     /// Secuencias repetidas idénticas son idempotentes; conflictos o huecos exigen resincronizar.
     pub fn apply_change(
         &mut self,
         sequence: u64,
         base_revision: u64,
         start_byte: usize,
         end_byte: usize,
         replacement: &str,
     ) -> Result<ApplyOutcome, EngineError> {
         if let Some(outcome) = self.validate_change(
             sequence, base_revision, start_byte, end_byte, replacement,
         )? {
             return Ok(outcome);
         }

         let incoming = AppliedChange {
             sequence,
             base_revision,
             start_byte,
             end_byte,
             replacement: replacement.to_owned(),
         };
         let next_revision = self.revision.checked_add(1)
             .ok_or(EngineError::CounterExhausted("revision"))?;

         // El anfitrión envía el reemplazo explícito. No se infiere ni se reescribe contenido.
         self.text.replace_range(start_byte..end_byte, replacement).map_err(|error| match error {
             crate::RopeError::InvalidRange => EngineError::InvalidRange,
             crate::RopeError::InvalidUtf8Boundary => EngineError::InvalidUtf8Boundary,
         })?;
         self.revision = next_revision;
         self.last_sequence = sequence;

         // Toda sugerencia activa pertenece a la revisión anterior. La revisión
         // permite invalidarlas en O(1), sin recorrer el historial de sugerencias.
         let invalidated = self.active_suggestion_count;
         self.active_suggestion_count = 0;
         self.stale_suggestion_count = self.stale_suggestion_count.saturating_add(invalidated);

         self.recent_changes.insert(sequence, incoming);
         while self.recent_changes.len() > RECENT_SEQUENCE_WINDOW {
             if let Some(oldest) = self.recent_changes.keys().next().copied() {
                 self.recent_changes.remove(&oldest);
             }
         }

         Ok(ApplyOutcome::Applied {
             revision: self.revision,
             invalidated_suggestions: invalidated,
         })
     }
 }
 
 #[cfg(test)]
 mod tests {
     use super::*;
 
     fn session() -> LiveSession {
         LiveSession::open("book-from-host", "doc-1", "Hola mundo", 7, 20).unwrap()
     }
 
     #[test]
     fn applies_host_change_and_advances_revision() {
         let mut s = session();
         let result = s.apply_change(21, 7, 5, 10, "escritora").unwrap();
         assert_eq!(result, ApplyOutcome::Applied { revision: 8, invalidated_suggestions: 0 });
         assert_eq!(s.snapshot().text, "Hola escritora");
     }
 
     #[test]
     fn identical_duplicate_is_idempotent() {
         let mut s = session();
         s.apply_change(21, 7, 5, 10, "mundo!").unwrap();
         let result = s.apply_change(21, 7, 5, 10, "mundo!").unwrap();
         assert_eq!(result, ApplyOutcome::Duplicate { revision: 8 });
         assert_eq!(s.snapshot().text, "Hola mundo!");
     }
 
     #[test]
     fn conflicting_duplicate_requires_resync() {
         let mut s = session();
         s.apply_change(21, 7, 5, 10, "mundo!").unwrap();
         assert!(matches!(
             s.apply_change(21, 7, 5, 10, "otra cosa").unwrap(),
             ApplyOutcome::ResyncRequired { .. }
         ));
     }
 
     #[test]
     fn sequence_gap_requires_resync_without_mutation() {
         let mut s = session();
         let result = s.apply_change(22, 7, 5, 10, "x").unwrap();
         assert_eq!(result, ApplyOutcome::ResyncRequired { expected_sequence: 21, received_sequence: 22 });
         assert_eq!(s.snapshot().text, "Hola mundo");
         assert_eq!(s.snapshot().revision, 7);
     }
 
     #[test]
     fn stale_revision_is_rejected() {
         let mut s = session();
         assert_eq!(
             s.apply_change(21, 6, 5, 10, "x"),
             Err(EngineError::RevisionConflict { expected: 7, received: 6 })
         );
         assert_eq!(s.snapshot().text, "Hola mundo");
     }
 
     #[test]
     fn suggestions_become_stale_after_any_document_edit() {
         let mut s = session();
         s.add_suggestion(Suggestion {
             id: "s-1".into(), fragment_id: "f-1".into(), document_revision: 7,
             start_byte: 0, end_byte: 4, message: "Revisar".into(), stale: false,
         }).unwrap();
         let result = s.apply_change(21, 7, 5, 10, "mundo nuevo").unwrap();
         assert_eq!(result, ApplyOutcome::Applied { revision: 8, invalidated_suggestions: 1 });
         assert_eq!(s.snapshot().active_suggestions, 0);
         assert_eq!(s.snapshot().stale_suggestions, 1);
     }
 
     #[test]
     fn revision_overflow_rejects_change_without_mutating_document() {
         let mut s = LiveSession::open("p", "d", "texto", u64::MAX, 0).unwrap();
         assert_eq!(
             s.apply_change(1, u64::MAX, 0, 0, "!"),
             Err(EngineError::CounterExhausted("revision"))
         );
         let snapshot = s.snapshot();
         assert_eq!(snapshot.text, "texto");
         assert_eq!(snapshot.revision, u64::MAX);
         assert_eq!(snapshot.last_sequence, 0);
     }

     #[test]
    fn live_session_rope_edits_preserve_utf8_offsets_and_snapshots() {
        let mut session = LiveSession::open(
            "project-rope", "chapter-rope",
            "Primero.\n\nEl niño llegó.\n\nTercero.", 10, 40,
        ).unwrap();
        let at = session.snapshot().text.find("niño").unwrap();
        let paragraph = session.affected_paragraph(at, at).unwrap();
        assert_eq!(paragraph.text, "El niño llegó.");
        assert_eq!(paragraph.revision, 10);
        let outcome = session.apply_change(41, 10, at, at + "niño".len(), "gato").unwrap();
        assert_eq!(outcome, ApplyOutcome::Applied { revision: 11, invalidated_suggestions: 0 });
        assert_eq!(session.snapshot().text, "Primero.\n\nEl gato llegó.\n\nTercero.");
        let updated = session.affected_paragraph(at, at + 4).unwrap();
        assert_eq!(updated.text, "El gato llegó.");
        assert_eq!(updated.revision, 11);
        assert_eq!(updated.last_sequence, 41);
    }

    #[test]
    fn live_session_rope_handles_large_document_without_changing_host_protocol() {
        let text = "Párrafo largo del escritor.\n\n".repeat(5_000);
        let mut session = LiveSession::open("project-large", "chapter-large", text.clone(), 0, 0).unwrap();
        let at = text.find("escritor").unwrap();
        let paragraph = session.affected_paragraph(at, at + 2).unwrap();
        assert_eq!(paragraph.text, "Párrafo largo del escritor.");
        let outcome = session.apply_change(1, 0, at, at + "escritor".len(), "autor").unwrap();
        assert_eq!(outcome, ApplyOutcome::Applied { revision: 1, invalidated_suggestions: 0 });
        assert_eq!(session.revision(), 1);
        assert_eq!(session.last_sequence(), 1);
        assert!(session.fragment_matches(1, 1, at, at + 5, "autor"));
    }

    #[test]
     fn affected_paragraph_copies_only_the_selected_paragraph() {
         let session = LiveSession::open(
             "project", "chapter", "Primero.\n\nEl niño llegó.\n\nTercero.", 4, 9,
         ).unwrap();
         let at = session.snapshot().text.find("niño").unwrap();
         let paragraph = session.affected_paragraph(at, at).unwrap();
         assert_eq!(paragraph.text, "El niño llegó.");
         assert_eq!(paragraph.end_byte - paragraph.start_byte, paragraph.text.len());
         assert_eq!(paragraph.revision, 4);
     }

     #[test]
     fn evidence_excerpt_requires_exact_revision_utf8_range_and_text() {
         let s = LiveSession::open("project", "chapter", "El niño llegó.", 3, 8).unwrap();
         assert_eq!(s.validate_evidence_excerpt(3, 3, 8, "niño"), Ok(()));
         assert_eq!(
             s.validate_evidence_excerpt(3, 3, 8, "nino"),
             Err(EngineError::EvidenceExcerptMismatch),
         );
         assert_eq!(
             s.validate_evidence_excerpt(3, 6, 8, "ño"),
             Err(EngineError::InvalidRange),
         );
         assert_eq!(
             s.validate_evidence_excerpt(3, 3, 3, ""),
             Err(EngineError::InvalidRange),
         );
         assert!(matches!(
             s.validate_evidence_excerpt(2, 3, 8, "niño"),
             Err(EngineError::EvidenceRevisionConflict { expected: 2, received: 3, last_sequence: 8 })
         ));
     }

     #[test]
     fn utf8_offsets_must_be_character_boundaries() {
         let mut s = LiveSession::open("p", "d", "niño", 0, 0).unwrap();
         assert_eq!(
             s.apply_change(1, 0, 3, 4, "x"),
             Err(EngineError::InvalidUtf8Boundary)
         );
         assert_eq!(s.snapshot().text, "niño");
     }
 
     #[test]
     fn identifiers_are_supplied_and_validated() {
         assert!(matches!(
             LiveSession::open(" ", "d", "", 0, 0),
             Err(EngineError::InvalidIdentifier("project_id"))
         ));
     }
 }
 

pub mod runtime;
pub use runtime::LiveEngine;

pub mod persistent;
pub use persistent::{DurableDocumentChange, PersistentLiveEngine};

pub mod worker;
pub use worker::{ChangeTicket, LiveEngineWorker, PendingChange, SubmitError, TicketError, WorkerError, WorkerMetricsSnapshot};

pub mod host_api;
pub use host_api::{EditorChange, HostApiError, HostEngineApi};

pub mod json;
pub use json::{JsonError, JsonValue};

pub mod protocol;
pub use protocol::JsonRpcServer;

pub mod knowledge;
pub use knowledge::{transform_evidence_anchor, EntityRecord, EvidenceAnchorTransform, EvidenceRebaseSummary, EvidenceRecord, EvidenceTarget, EventRecord, FragmentAnalysisRecord, KnowledgeError, NarrativeKnowledgeStore, RecordStatus, RelationRecord, RepeatedWordRecord};

pub mod text_buffer;
pub use text_buffer::{ChunkedText, TextBufferError, MAX_TEXT_CHUNK_BYTES};

pub mod segmentation;
pub use segmentation::{affected_paragraph_range, affected_paragraph_range_rope, segment_fragment, segment_rope_range, FragmentKind, TextFragment};

pub mod linguistic;
pub mod proofreading;
pub use linguistic::{analyze_fragment, tokenize_words, FragmentMetrics, WordFrequency, WordToken
     #[test]
     fn replacing_suggestion_after_edit_moves_it_from_stale_back_to_active() {
         let mut s = session();
         s.add_suggestion(Suggestion {
             id: "same".into(), fragment_id: "f-old".into(), document_revision: 7,
             start_byte: 0, end_byte: 4, message: "Anterior".into(), stale: false,
         }).unwrap();
         s.apply_change(21, 7, 5, 10, "mundo nuevo").unwrap();
         assert_eq!(s.snapshot().stale_suggestions, 1);
         s.add_suggestion(Suggestion {
             id: "same".into(), fragment_id: "f-new".into(), document_revision: 8,
             start_byte: 0, end_byte: 4, message: "Actualizada".into(), stale: false,
         }).unwrap();
         let snapshot = s.snapshot();
         assert_eq!(snapshot.active_suggestions, 1);
         assert_eq!(snapshot.stale_suggestions, 0);
     }

     #[test]
     fn stale_suggestions_are_not_invalidated_twice_by_later_edits() {
         let mut s = session();
         s.add_suggestion(Suggestion {
             id: "s-1".into(), fragment_id: "f-1".into(), document_revision: 7,
             start_byte: 0, end_byte: 4, message: "Revisar".into(), stale: false,
         }).unwrap();
         s.apply_change(21, 7, 5, 10, "mundo nuevo").unwrap();
         let result = s.apply_change(22, 8, 5, 10, "mundo actualizado").unwrap();
         assert_eq!(result, ApplyOutcome::Applied { revision: 9, invalidated_suggestions: 0 });
         assert_eq!(s.snapshot().active_suggestions, 0);
         assert_eq!(s.snapshot().stale_suggestions, 1);
     }


     #[test]
     fn bulk_suggestion_invalidation_keeps_exact_counts() {
         let mut s = session();
         for index in 0..5_000 {
             s.add_suggestion(Suggestion {
                 id: format!("s-{index}"),
                 fragment_id: format!("f-{index}"),
                 document_revision: 7,
                 start_byte: 0,
                 end_byte: 4,
                 message: "Revisar".into(),
                 stale: false,
             }).unwrap();
         }
         assert_eq!(s.snapshot().active_suggestions, 5_000);
         let outcome = s.apply_change(21, 7, 5, 10, "mundo nuevo").unwrap();
         assert_eq!(outcome, ApplyOutcome::Applied {
             revision: 8,
             invalidated_suggestions: 5_000,
         });
         assert_eq!(s.snapshot().active_suggestions, 0);
         assert_eq!(s.snapshot().stale_suggestions, 5_000);
     }


     #[test]
     fn fragment_freshness_check_uses_exact_revision_sequence_and_utf8_range() {
         let session = LiveSession::open("project", "chapter", "El niño llegó.", 4, 9).unwrap();
         assert!(session.fragment_matches(4, 9, 3, 8, "niño"));
         assert!(!session.fragment_matches(3, 9, 3, 8, "niño"));
         assert!(!session.fragment_matches(4, 8, 3, 8, "niño"));
         assert!(!session.fragment_matches(4, 9, 3, 8, "nino"));
         assert!(!session.fragment_matches(4, 9, 4, 8, "iño"));
         assert!(!session.fragment_matches(4, 9, 3, 99, "niño"));
     }


    #[test]
    fn fragment_anchor_validation_checks_revision_range_and_utf8_boundaries() {
        let live = LiveSession::open("book", "unicode-doc", "ábc", 7, 20).unwrap();
        assert_eq!(live.validate_fragment_anchor(7, 0, 2), Ok(()));
        assert_eq!(
            live.validate_fragment_anchor(6, 0, 2),
            Err(EngineError::AnalysisRevisionConflict {
                expected: 6, received: 7, last_sequence: 20,
            }),
        );
        assert_eq!(
            live.validate_fragment_anchor(7, 1, 2),
            Err(EngineError::InvalidUtf8Boundary),
        );
        assert_eq!(
            live.validate_fragment_anchor(7, 0, 5),
            Err(EngineError::InvalidRange),
        );
    }

};

pub mod segmentation;
pub use segmentation::{affected_paragraph_range, affected_paragraph_range_rope, segment_fragment, segment_rope_range, FragmentKind, TextFragment};

pub mod rope_text;
pub use rope_text::{RopeError, RopeText, ROPE_LEAF_BYTES};
