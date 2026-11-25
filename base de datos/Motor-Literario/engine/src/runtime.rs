//! Coordinador de sesiones del editor para un único proyecto activo.
//!
//! El anfitrión conserva la autoridad sobre los IDs y envía todos los cambios.
//! Este módulo no observa ni modifica el editor por su cuenta.

use std::collections::BTreeMap;

use crate::{ApplyOutcome, DocumentSnapshot, EngineError, LiveSession, Suggestion};

/// Coordina documentos abiertos del proyecto activo del anfitrión.
///
/// Un anfitrión trabaja con un libro a la vez. El motor admite varios
/// documentos de ese mismo proyecto (por ejemplo, capítulos abiertos en
/// pestañas) y nunca mezcla sesiones de proyectos diferentes.
#[derive(Default)]
pub struct LiveEngine {
    active_project: Option<String>,
    sessions: BTreeMap<String, LiveSession>,
}

impl LiveEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Abre el proyecto indicado por el anfitrión. No genera identidades.
    pub fn open_project(&mut self, project_id: impl Into<String>) -> Result<(), EngineError> {
        let project_id = project_id.into();
        if project_id.trim().is_empty() || project_id.len() > 128 {
            return Err(EngineError::InvalidIdentifier("project_id"));
        }
        if self.active_project.is_some() {
            return Err(EngineError::ProjectAlreadyOpen);
        }
        self.active_project = Some(project_id);
        Ok(())
    }

    /// Cierra el proyecto y descarta todas sus sesiones en memoria.
    /// La persistencia narrativa corresponde al adaptador de almacenamiento.
    pub fn close_project(&mut self, project_id: &str) -> Result<(), EngineError> {
        match self.active_project.as_deref() {
            Some(active) if active == project_id => {
                self.sessions.clear();
                self.active_project = None;
                Ok(())
            }
            _ => Err(EngineError::ProjectNotOpen),
        }
    }

    pub fn active_project_id(&self) -> Option<&str> {
        self.active_project.as_deref()
    }

    pub fn open_document_count(&self) -> usize {
        self.sessions.len()
    }

    /// Inicia una sesión con el snapshot/revisión/contador entregados por el anfitrión.
    pub fn open_document(
        &mut self,
        project_id: &str,
        document_id: impl Into<String>,
        initial_text: impl Into<String>,
        initial_revision: u64,
        initial_sequence: u64,
    ) -> Result<(), EngineError> {
        self.require_project(project_id)?;
        let document_id = document_id.into();
        if self.sessions.contains_key(&document_id) {
            return Err(EngineError::DocumentAlreadyOpen);
        }
        let session = LiveSession::open(
            project_id,
            document_id.clone(),
            initial_text,
            initial_revision,
            initial_sequence,
        )?;
        self.sessions.insert(document_id, session);
        Ok(())
    }

    /// Sustituye la sesión por un snapshot completo enviado por el anfitrión.
    ///
    /// Se usa cuando se detecta un hueco/conflicto de secuencia. La sesión nueva
    /// se valida antes de reemplazar la anterior; nunca se intenta reconstruir
    /// texto perdido ni se conservan sugerencias ancladas a la revisión antigua.
    pub fn resynchronize_document(
        &mut self,
        project_id: &str,
        document_id: &str,
        authoritative_text: impl Into<String>,
        authoritative_revision: u64,
        authoritative_sequence: u64,
    ) -> Result<(), EngineError> {
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
        self.sessions.insert(document_id.to_owned(), replacement);
        Ok(())
    }

    pub fn close_document(
        &mut self,
        project_id: &str,
        document_id: &str,
    ) -> Result<(), EngineError> {
        self.require_project(project_id)?;
        self.sessions
            .remove(document_id)
            .map(|_| ())
            .ok_or(EngineError::DocumentNotOpen)
    }

    /// Reenvía un cambio incremental del editor a la sesión correspondiente.
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
        self.require_project(project_id)?;
        self.sessions
            .get_mut(document_id)
            .ok_or(EngineError::DocumentNotOpen)?
            .apply_change(sequence, base_revision, start_byte, end_byte, replacement)
    }

    pub fn add_suggestion(
        &mut self,
        project_id: &str,
        document_id: &str,
        suggestion: Suggestion,
    ) -> Result<(), EngineError> {
        self.require_project(project_id)?;
        self.sessions
            .get_mut(document_id)
            .ok_or(EngineError::DocumentNotOpen)?
            .add_suggestion(suggestion)
    }

    pub fn snapshot(
        &self,
        project_id: &str,
        document_id: &str,
    ) -> Result<DocumentSnapshot, EngineError> {
        self.require_project(project_id)?;
        self.sessions
            .get(document_id)
            .map(LiveSession::snapshot)
            .ok_or(EngineError::DocumentNotOpen)
    }

    fn require_project(&self, project_id: &str) -> Result<(), EngineError> {
        match self.active_project.as_deref() {
            Some(active) if active == project_id => Ok(()),
            _ => Err(EngineError::ProjectNotOpen),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> LiveEngine {
        let mut engine = LiveEngine::new();
        engine.open_project("project-from-host").unwrap();
        engine
    }

    #[test]
    fn project_identity_is_supplied_by_host_and_only_one_project_is_active() {
        let mut engine = LiveEngine::new();
        assert_eq!(engine.active_project_id(), None);
        engine.open_project("host-book-17").unwrap();
        assert_eq!(engine.active_project_id(), Some("host-book-17"));
        assert_eq!(
            engine.open_project("another-book"),
            Err(EngineError::ProjectAlreadyOpen)
        );
        assert_eq!(engine.active_project_id(), Some("host-book-17"));
    }

    #[test]
    fn documents_are_isolated_inside_the_active_project() {
        let mut engine = engine();
        engine.open_document("project-from-host", "chapter-1", "Uno", 0, 0).unwrap();
        engine.open_document("project-from-host", "chapter-2", "Dos", 4, 9).unwrap();

        assert_eq!(
            engine.apply_change("project-from-host", "chapter-1", 1, 0, 3, 3, "!"),
            Ok(ApplyOutcome::Applied { revision: 1, invalidated_suggestions: 0 })
        );
        assert_eq!(
            engine.snapshot("project-from-host", "chapter-1").unwrap().text,
            "Uno!"
        );
        assert_eq!(
            engine.snapshot("project-from-host", "chapter-2").unwrap().text,
            "Dos"
        );
        assert_eq!(engine.open_document_count(), 2);
    }

    #[test]
    fn foreign_project_cannot_read_or_write_active_document() {
        let mut engine = engine();
        engine.open_document("project-from-host", "doc", "privado", 0, 0).unwrap();

        assert_eq!(
            engine.snapshot("other-project", "doc"),
            Err(EngineError::ProjectNotOpen)
        );
        assert_eq!(
            engine.apply_change("other-project", "doc", 1, 0, 0, 0, "filtrado"),
            Err(EngineError::ProjectNotOpen)
        );
        assert_eq!(
            engine.snapshot("project-from-host", "doc").unwrap().text,
            "privado"
        );
    }

    #[test]
    fn resynchronization_replaces_state_only_with_host_authoritative_snapshot() {
        let mut engine = engine();
        engine.open_document("project-from-host", "doc", "texto viejo", 2, 5).unwrap();

        assert!(matches!(
            engine.apply_change("project-from-host", "doc", 7, 2, 0, 0, "perdido"),
            Ok(ApplyOutcome::ResyncRequired { expected_sequence: 6, received_sequence: 7 })
        ));
        assert_eq!(
            engine.resynchronize_document(
                "project-from-host", "doc", "snapshot oficial", 12, 40
            ),
            Ok(())
        );
        let snapshot = engine.snapshot("project-from-host", "doc").unwrap();
        assert_eq!(snapshot.text, "snapshot oficial");
        assert_eq!(snapshot.revision, 12);
        assert_eq!(snapshot.last_sequence, 40);
        assert_eq!(
            engine.apply_change("project-from-host", "doc", 41, 12, 16, 16, "!"),
            Ok(ApplyOutcome::Applied { revision: 13, invalidated_suggestions: 0 })
        );
        assert_eq!(
            engine.snapshot("project-from-host", "doc").unwrap().text,
            "snapshot oficial!"
        );
    }

    #[test]
    fn unknown_document_resynchronization_does_not_destroy_existing_session() {
        let mut engine = engine();
        engine.open_document("project-from-host", "doc", "preservado", 3, 9).unwrap();

        assert_eq!(
            engine.resynchronize_document("project-from-host", "missing", "nuevo", 0, 0),
            Err(EngineError::DocumentNotOpen)
        );
        assert_eq!(
            engine.snapshot("project-from-host", "doc").unwrap().text,
            "preservado"
        );
    }

    #[test]
    fn duplicate_document_open_is_rejected_without_replacing_session() {
        let mut engine = engine();
        engine.open_document("project-from-host", "doc", "original", 3, 8).unwrap();

        assert_eq!(
            engine.open_document("project-from-host", "doc", "reemplazo", 0, 0),
            Err(EngineError::DocumentAlreadyOpen)
        );
        let snapshot = engine.snapshot("project-from-host", "doc").unwrap();
        assert_eq!(snapshot.text, "original");
        assert_eq!(snapshot.revision, 3);
        assert_eq!(snapshot.last_sequence, 8);
    }

    #[test]
    fn closing_project_discards_all_live_sessions_and_requires_reopen() {
        let mut engine = engine();
        engine.open_document("project-from-host", "doc-1", "A", 0, 0).unwrap();
        engine.open_document("project-from-host", "doc-2", "B", 0, 0).unwrap();

        engine.close_project("project-from-host").unwrap();
        assert_eq!(engine.active_project_id(), None);
        assert_eq!(engine.open_document_count(), 0);
        assert_eq!(
            engine.snapshot("project-from-host", "doc-1"),
            Err(EngineError::ProjectNotOpen)
        );
        engine.open_project("new-host-project").unwrap();
    }

    #[test]
    fn closing_unknown_document_does_not_change_other_sessions() {
        let mut engine = engine();
        engine.open_document("project-from-host", "kept", "texto", 0, 0).unwrap();
        assert_eq!(
            engine.close_document("project-from-host", "missing"),
            Err(EngineError::DocumentNotOpen)
        );
        assert_eq!(engine.open_document_count(), 1);
        assert_eq!(
            engine.snapshot("project-from-host", "kept").unwrap().text,
            "texto"
        );
    }
}
