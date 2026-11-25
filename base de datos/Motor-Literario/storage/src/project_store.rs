//! Fachada de registros aislados por proyecto sobre el B+Tree persistente.
//! La identidad del proyecto siempre la aporta el programa anfitrión.

use crate::btree::{BPlusTreeRange, BTreeError, PersistentBPlusTree, TreeMutation, TreeMutationResult, MAX_TREE_KEY_LEN};
use crate::bundle::SessionLockValidator;
use std::path::Path;

const KEY_ENCODING_VERSION: u8 = 1;

/// Operación ordenada de dominio. Cada elemento declara explícitamente
/// el proyecto, la tabla y el identificador que aporta el anfitrión.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectOperation {
    Put { project_id: String, table: String, record_id: String, value: Vec<u8> },
    Delete { project_id: String, table: String, record_id: String },
}

/// Resultado por operación, en el mismo orden de entrada y publicado solo
/// después de confirmar el lote completo.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectBatchResult {
    Put,
    Delete { deleted: bool },
}

pub struct ProjectStore {
    tree: PersistentBPlusTree,
    session_lock_validator: Option<SessionLockValidator>,
}

/// Iterador incremental de registros dentro de un único proyecto y tabla.
/// Cada next() devuelve como máximo una entrada y no materializa el conjunto completo.
pub struct ProjectTableRange<'a> {
    inner: BPlusTreeRange<'a>,
    project_id: String,
    table: String,
    failed: bool,
    skip_record_id: Option<String>,
}

/// Iterador incremental de todos los registros del almacén, en orden de clave.
pub struct ProjectStoreRange<'a> {
    inner: BPlusTreeRange<'a>,
    failed: bool,
}

impl Iterator for ProjectStoreRange<'_> {
    type Item = Result<(String, String, String, Vec<u8>), BTreeError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.failed { return None; }
        match self.inner.next()? {
            Ok((key, value)) => match decode_key(&key) {
                Ok((project, table, record_id)) => Some(Ok((project, table, record_id, value))),
                Err(error) => {
                    self.failed = true;
                    Some(Err(error))
                }
            },
            Err(error) => {
                self.failed = true;
                Some(Err(error))
            }
        }
    }
}

impl Iterator for ProjectTableRange<'_> {
    type Item = Result<(String, Vec<u8>), BTreeError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.failed { return None; }
        loop {
            match self.inner.next()? {
                Ok((key, value)) => match decode_key(&key) {
                    Ok((project, table, record_id)) if project == self.project_id && table == self.table => {
                        if self.skip_record_id.as_deref() == Some(record_id.as_str()) {
                            self.skip_record_id = None;
                            continue;
                        }
                        self.skip_record_id = None;
                        return Some(Ok((record_id, value)));
                    }
                    Ok(_) => {
                        self.failed = true;
                        return Some(Err(BTreeError::Corrupt("iterador de tabla cruzó el límite del proyecto o tabla")));
                    }
                    Err(error) => {
                        self.failed = true;
                        return Some(Err(error));
                    }
                },
                Err(error) => {
                    self.failed = true;
                    return Some(Err(error));
                }
            }
        }
    }
}

impl ProjectStore {
    /// Abre el almacén de páginas y su WAL, o inicializa un árbol vacío.
    pub fn open(pages_path: impl AsRef<Path>, wal_path: impl AsRef<Path>) -> Result<Self, BTreeError> {
        Ok(Self { tree: PersistentBPlusTree::open(pages_path, wal_path)?, session_lock_validator: None })
    }

    /// Abre únicamente archivos existentes. Nunca inicializa una working copy
    /// si uno de sus archivos desaparece entre la validación y la apertura.
    pub fn open_existing(
        pages_path:impl AsRef<Path>,
        wal_path:impl AsRef<Path>,
    )->Result<Self,BTreeError>{
        Self::open_with_pre_recovery_verification(pages_path,wal_path,|_,_|Ok(()))
    }

    /// Abre una working copy existente y valida el lock de sesión después de
    /// abrir los descriptores, pero antes de que la recuperación pueda escribir.
    pub fn open_existing_with_session_validator(
        pages_path: impl AsRef<Path>,
        wal_path: impl AsRef<Path>,
        validator: SessionLockValidator,
    ) -> Result<Self, BTreeError> {
        validator.validate().map_err(|_| BTreeError::Invalid("bloqueo de sesión inválido"))?;
        let tree = PersistentBPlusTree::open_existing_with_session_validator(
            pages_path, wal_path, validator.clone(),
        )?;
        Ok(Self { tree, session_lock_validator: Some(validator) })
    }

    /// Abre una generación publicada usando descriptores sin escritura.
    /// Exige WAL vacío/checkpointed y no ejecuta recuperación ni inicialización.
    pub(crate) fn open_read_only_with_pre_recovery_verification<F>(
        pages_path: impl AsRef<Path>,
        wal_path: impl AsRef<Path>,
        verify: F,
    ) -> Result<Self, BTreeError>
    where
        F: FnOnce(&mut std::fs::File, &mut std::fs::File) -> std::io::Result<()>,
    {
        let tree = PersistentBPlusTree::open_read_only_with_pre_recovery_verification(
            pages_path, wal_path, verify,
        )?;
        Ok(Self { tree, session_lock_validator: None })
    }

    /// Apertura verificada ligada al lock de sesión, también durante recovery
    /// y los checkpoints posteriores.
    pub(crate) fn open_with_pre_recovery_verification_and_session_validator<F>(
        pages_path: impl AsRef<Path>,
        wal_path: impl AsRef<Path>,
        verify: F,
        validator: SessionLockValidator,
    ) -> Result<Self, BTreeError>
    where F: FnOnce(&mut std::fs::File, &mut std::fs::File) -> std::io::Result<()> {
        validator.validate().map_err(|_| BTreeError::Invalid("bloqueo de sesión inválido"))?;
        let tree = PersistentBPlusTree::open_with_pre_recovery_verification_and_session_validator(
            pages_path, wal_path, verify, validator.clone(),
        )?;
        Ok(Self { tree, session_lock_validator: Some(validator) })
    }

    /// Abre un almacén existente verificando los descriptores ya abiertos antes
    /// de que el WAL pueda truncarse o ejecutar redo.
    pub(crate) fn open_with_pre_recovery_verification<F>(
        pages_path:impl AsRef<Path>,
        wal_path:impl AsRef<Path>,
        verify:F,
    )->Result<Self,BTreeError>
    where F:FnOnce(&mut std::fs::File,&mut std::fs::File)->std::io::Result<()> {
        Ok(Self{tree:PersistentBPlusTree::open_with_pre_recovery_verification(pages_path,wal_path,verify)?, session_lock_validator: None})
    }

    /// Vincula las mutaciones a la sesión activa de una working bundle.
    /// La validación ocurre dentro de esta capa, antes de cada operación durable.
    pub fn attach_session_lock_validator(&mut self, validator: SessionLockValidator) -> Result<(), BTreeError> {
        validator.validate().map_err(|_| BTreeError::Invalid("bloqueo de sesión inválido"))?;
        self.tree.attach_session_lock_validator(validator.clone())?;
        self.session_lock_validator = Some(validator);
        Ok(())
    }

    fn validate_session_lock(&self) -> Result<(), BTreeError> {
        if let Some(validator) = &self.session_lock_validator {
            validator.validate().map_err(|_| BTreeError::Invalid("bloqueo de sesión inválido"))?;
        }
        Ok(())
    }

    /// Inserta o reemplaza un registro bajo la identidad explícita del proyecto.
    pub fn put_project(
        &mut self,
        project_id: &str,
        table: &str,
        record_id: &str,
        value: &[u8],
    ) -> Result<(), BTreeError> {
        validate_identity(project_id, table, record_id)?;
        let key = encode_key(project_id, table, record_id)?;
        self.validate_session_lock()?;
        self.tree.insert(key, value.to_vec())
    }

    /// Recupera un registro únicamente dentro del proyecto y tabla indicados.
    pub fn get_project(
        &mut self,
        project_id: &str,
        table: &str,
        record_id: &str,
    ) -> Result<Option<Vec<u8>>, BTreeError> {
        validate_identity(project_id, table, record_id)?;
        self.tree.get(&encode_key(project_id, table, record_id)?)
    }

    /// Elimina un registro sin afectar el mismo ID en otros proyectos.
    pub fn delete_project(
        &mut self,
        project_id: &str,
        table: &str,
        record_id: &str,
    ) -> Result<bool, BTreeError> {
        validate_identity(project_id, table, record_id)?;
        let key = encode_key(project_id, table, record_id)?;
        self.validate_session_lock()?;
        self.tree.remove(&key)
    }

    /// Confirma una secuencia de operaciones de dominio mediante una sola
    /// transacción MLPJ. Las operaciones repetidas sobre una clave se ejecutan
    /// secuencialmente dentro del overlay; un error de validación/preparación
    /// abandona el lote completo sin modificar páginas.
    ///
    /// Un lote compuesto únicamente por eliminaciones de claves ausentes es
    /// un no-op: devuelve resultados deleted: false sin generar un COMMIT vacío.
    ///
    /// Si se informa un error durante la escritura/sync del WAL o al aplicar
    /// páginas después de un COMMIT durable, el resultado puede ser ambiguo:
    /// no reintentar sobre esta instancia. Cerrarla y reabrirla para que MLPJ
    /// determine y complete la recuperación antes de consultar o repetir.
    pub fn apply_batch(
        &mut self,
        operations: Vec<ProjectOperation>,
    ) -> Result<Vec<ProjectBatchResult>, BTreeError> {
        if operations.is_empty() {
            return Err(BTreeError::Invalid("lote vacío"));
        }
        self.validate_session_lock()?;

        // Validar y codificar todas las identidades antes de crear la sesión.
        let mut tree_operations = Vec::with_capacity(operations.len());
        for operation in operations {
            match operation {
                ProjectOperation::Put { project_id, table, record_id, value } => {
                    validate_identity(&project_id, &table, &record_id)?;
                    tree_operations.push(TreeMutation::Put {
                        key: encode_key(&project_id, &table, &record_id)?,
                        value,
                    });
                }
                ProjectOperation::Delete { project_id, table, record_id } => {
                    validate_identity(&project_id, &table, &record_id)?;
                    tree_operations.push(TreeMutation::Delete {
                        key: encode_key(&project_id, &table, &record_id)?,
                    });
                }
            }
        }

        // Revalidar después de preparar el lote, inmediatamente antes de abrir
        // la transacción MLPJ.
        self.validate_session_lock()?;
        self.tree.apply_batch(tree_operations).map(|results| {
            results.into_iter().map(|result| match result {
                TreeMutationResult::Put => ProjectBatchResult::Put,
                TreeMutationResult::Delete { deleted } => ProjectBatchResult::Delete { deleted },
            }).collect()
        })
    }

    /// Abre un recorrido incremental de los registros de una tabla del proyecto.
    /// El iterador mantiene el límite de ámbito y solo carga una hoja cada vez.
    pub fn scan_project_table_iter<'a>(
        &'a mut self,
        project_id: &str,
        table: &str,
    ) -> Result<ProjectTableRange<'a>, BTreeError> {
        validate_scope(project_id, table)?;
        let mut prefix = vec![KEY_ENCODING_VERSION];
        prefix.extend_from_slice(&encode_component(project_id));
        prefix.extend_from_slice(&encode_component(table));
        let end = prefix_successor(&prefix)
            .ok_or(BTreeError::Invalid("prefijo de proyecto sin límite superior"))?;
        let inner = self.tree.range_iter(Some(&prefix), Some(&end))?;
        Ok(ProjectTableRange {
            inner,
            project_id: project_id.to_string(),
            table: table.to_string(),
            failed: false,
            skip_record_id: None,
        })
    }

    /// Abre un recorrido ordenado a partir de un ID exclusivo.
    /// La búsqueda comienza en el B+Tree, no recorre los elementos anteriores.
    pub fn scan_project_table_after_iter<'a>(
        &'a mut self,
        project_id: &str,
        table: &str,
        after_record_id: &str,
    ) -> Result<ProjectTableRange<'a>, BTreeError> {
        validate_identity(project_id, table, after_record_id)?;
        let mut prefix = vec![KEY_ENCODING_VERSION];
        prefix.extend_from_slice(&encode_component(project_id));
        prefix.extend_from_slice(&encode_component(table));
        let end = prefix_successor(&prefix)
            .ok_or(BTreeError::Invalid("prefijo de proyecto sin límite superior"))?;
        let start = encode_key(project_id, table, after_record_id)?;
        let inner = self.tree.range_iter(Some(&start), Some(&end))?;
        Ok(ProjectTableRange {
            inner,
            project_id: project_id.to_string(),
            table: table.to_string(),
            failed: false,
            skip_record_id: Some(after_record_id.to_string()),
        })
    }

    /// Abre un recorrido incremental de todos los registros, ordenados por clave.
    /// No materializa el almacén completo en memoria.
    pub fn scan_all_iter(&mut self) -> Result<ProjectStoreRange<'_>, BTreeError> {
        let inner = self.tree.range_iter(None, None)?;
        Ok(ProjectStoreRange { inner, failed: false })
    }

    /// Forma materializada para consumidores que necesitan una colección completa.
    /// Para recorridos grandes, preferir scan_project_table_iter().
    pub fn scan_project_table(
        &mut self,
        project_id: &str,
        table: &str,
    ) -> Result<Vec<(String, Vec<u8>)>, BTreeError> {
        self.scan_project_table_iter(project_id, table)?.collect()
    }

    /// Informa déficits estructurales de ocupación del árbol del proyecto.
    pub fn occupancy_diagnostics(&mut self) -> Result<crate::btree::OccupancyDiagnostics, BTreeError> {
        self.tree.occupancy_diagnostics()
    }

    /// Ejecuta mantenimiento global de ocupación en una transacción WAL única.
    /// No modifica registros ni cruza el ámbito lógico de ningún proyecto.
    pub fn repair_occupancy(&mut self) -> Result<usize, BTreeError> {
        self.validate_session_lock()?;
        self.tree.repair_occupancy()
    }

    pub fn validate(&mut self) -> Result<crate::btree::ValidationReport, BTreeError> {
        self.tree.validate()
    }

    pub fn checkpoint(&mut self) -> Result<(), BTreeError> {
        self.validate_session_lock()?;
        self.tree.checkpoint()
    }

    /// Rutas de los archivos de páginas y WAL MLPJ abiertos por este almacén.
    pub fn paths(&self) -> (&Path, &Path) {
        self.tree.paths()
    }

    pub fn page_count(&self) -> u64 {
        self.tree.page_count()
    }

    pub fn height(&self) -> u16 {
        self.tree.height()
    }
}

fn validate_component(value: &str, label: &'static str) -> Result<(), BTreeError> {
    if value.trim().is_empty() {
        return Err(BTreeError::Invalid(label));
    }
    Ok(())
}

fn validate_scope(project_id: &str, table: &str) -> Result<(), BTreeError> {
    validate_component(project_id, "project_id obligatorio")?;
    validate_component(table, "tabla obligatoria")?;
    let prefix_len = 1usize // versión de codificación
        .checked_add(encode_component(project_id).len())
        .and_then(|n| n.checked_add(encode_component(table).len()))
        .and_then(|n| n.checked_add(3)) // un byte de ID más su terminador
        .ok_or(BTreeError::Invalid("prefijo compuesto demasiado largo"))?;
    if prefix_len > MAX_TREE_KEY_LEN {
        return Err(BTreeError::Invalid("prefijo de proyecto/tabla supera la capacidad del B+Tree"));
    }
    Ok(())
}

fn validate_identity(project_id: &str, table: &str, record_id: &str) -> Result<(), BTreeError> {
    validate_scope(project_id, table)?;
    validate_component(record_id, "record_id obligatorio")?;
    let total = 1usize // versión de codificación
        .checked_add(encode_component(project_id).len())
        .and_then(|n| n.checked_add(encode_component(table).len()))
        .and_then(|n| n.checked_add(encode_component(record_id).len()))
        .ok_or(BTreeError::Invalid("clave compuesta demasiado larga"))?;
    if total > MAX_TREE_KEY_LEN {
        return Err(BTreeError::Invalid("clave compuesta supera la capacidad del B+Tree"));
    }
    Ok(())
}

/// Codificación binaria con escape y terminador: no hay colisiones entre
/// componentes ni ambigüedad cuando un identificador contiene bytes NUL.
fn encode_component(value: &str) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(value.len() + 2);
    for byte in value.as_bytes() {
        if *byte == 0 {
            encoded.extend_from_slice(&[0, 0xff]);
        } else {
            encoded.push(*byte);
        }
    }
    encoded.extend_from_slice(&[0, 0]);
    encoded
}

fn encode_key(project_id: &str, table: &str, record_id: &str) -> Result<Vec<u8>, BTreeError> {
    validate_identity(project_id, table, record_id)?;
    let mut key = vec![KEY_ENCODING_VERSION];
    key.extend_from_slice(&encode_component(project_id));
    key.extend_from_slice(&encode_component(table));
    key.extend_from_slice(&encode_component(record_id));
    Ok(key)
}

fn decode_component(input: &[u8], offset: &mut usize) -> Result<String, BTreeError> {
    let mut decoded = Vec::new();
    loop {
        let byte = *input.get(*offset).ok_or(BTreeError::Corrupt("componente de clave truncado"))?;
        *offset += 1;
        if byte != 0 {
            decoded.push(byte);
            continue;
        }
        let escaped = *input.get(*offset).ok_or(BTreeError::Corrupt("escape de clave truncado"))?;
        *offset += 1;
        match escaped {
            0 => break,
            0xff => decoded.push(0),
            _ => return Err(BTreeError::Corrupt("escape de clave compuesta inválido")),
        }
    }
    String::from_utf8(decoded).map_err(|_| BTreeError::Corrupt("identificador de clave no es UTF-8"))
}

fn decode_key(input: &[u8]) -> Result<(String, String, String), BTreeError> {
    if input.first().copied() != Some(KEY_ENCODING_VERSION) {
        return Err(BTreeError::Corrupt("versión de clave compuesta no soportada"));
    }
    let mut offset = 1;
    let project = decode_component(input, &mut offset)?;
    let table = decode_component(input, &mut offset)?;
    let record = decode_component(input, &mut offset)?;
    if offset != input.len() {
        return Err(BTreeError::Corrupt("bytes sobrantes en clave compuesta"));
    }
    if project.trim().is_empty() || table.trim().is_empty() || record.trim().is_empty() {
        return Err(BTreeError::Corrupt("clave compuesta contiene un identificador vacío"));
    }
    Ok((project, table, record))
}

/// Menor límite exclusivo que es mayor que todas las claves con este prefijo.
fn prefix_successor(prefix: &[u8]) -> Option<Vec<u8>> {
    let mut end = prefix.to_vec();
    for index in (0..end.len()).rev() {
        if end[index] != u8::MAX {
            end[index] += 1;
            end.truncate(index + 1);
            return Some(end);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::page_journal::JournalError;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn paths() -> (std::path::PathBuf, std::path::PathBuf) {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("mldb-project-store-{}-{n}", std::process::id()));
        (base.with_extension("pages"), base.with_extension("wal"))
    }

    fn cleanup(pages: &std::path::Path, wal: &std::path::Path) {
        for path in [pages, wal] {
            let _ = std::fs::remove_file(path);
            let mut name = path.file_name().unwrap().to_os_string();
            name.push(".mldb-lock");
            let _ = std::fs::remove_file(path.with_file_name(name));
        }
    }

    fn committed_transaction_count(wal: &std::path::Path) -> usize {
        let bytes = std::fs::read(wal).unwrap();
        let mut offset = 12usize;
        let mut commits = 0usize;
        while offset + 21 <= bytes.len() {
            assert_eq!(&bytes[offset..offset + 4], b"MPJF");
            let kind = bytes[offset + 4];
            let payload_len = u32::from_le_bytes(bytes[offset + 13..offset + 17].try_into().unwrap()) as usize;
            offset += 21 + payload_len;
            if kind == 3 { commits += 1; }
        }
        assert_eq!(offset, bytes.len());
        commits
    }

    #[test]
    fn open_existing_never_recreates_missing_project_store_files() {
        let (pages,wal)=paths();
        {
            let mut store=ProjectStore::open(&pages,&wal).unwrap();
            store.put_project("novel","entities","hero",b"Alice").unwrap();
            store.checkpoint().unwrap();
        }
        std::fs::remove_file(&wal).unwrap();
        assert!(ProjectStore::open_existing(&pages,&wal).is_err());
        assert!(pages.exists());
        assert!(!wal.exists());
        cleanup(&pages,&wal);

        let (pages,wal)=paths();
        {
            let mut store=ProjectStore::open(&pages,&wal).unwrap();
            store.checkpoint().unwrap();
        }
        std::fs::remove_file(&pages).unwrap();
        assert!(ProjectStore::open_existing(&pages,&wal).is_err());
        assert!(!pages.exists());
        assert!(wal.exists());
        cleanup(&pages,&wal);
    }

    #[test]
    fn project_store_exposes_occupancy_diagnostics_and_noop_maintenance() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            assert_eq!(store.repair_occupancy().unwrap(), 0);
            let diagnostics = store.occupancy_diagnostics().unwrap();
            assert_eq!(diagnostics.empty_non_root_leaves, 0);
            assert_eq!(diagnostics.unary_non_root_internal_nodes, 0);
            assert!(!diagnostics.root_is_unary_internal);
            assert_eq!(diagnostics.non_root_pages, 0);
            assert_eq!(diagnostics.non_root_payload_bytes, 0);
            assert_eq!(diagnostics.underfilled_non_root_pages, 0);
            assert_eq!(diagnostics.minimum_diagnostic_occupancy_bytes, crate::btree::MIN_DIAGNOSTIC_OCCUPANCY_BYTES);
            assert_eq!(store.validate().unwrap().entries, 0);
        }
        {
            let mut reopened = ProjectStore::open(&pages, &wal).unwrap();
            assert_eq!(reopened.repair_occupancy().unwrap(), 0);
            assert_eq!(reopened.validate().unwrap().entries, 0);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn batch_durable_commit_apply_failure_recovers_all_records_after_reopen() {
        let (pages, wal) = paths();
        let operations = (0..48u32)
            .map(|id| ProjectOperation::Put {
                project_id: "recovery-book".into(),
                table: "entities".into(),
                record_id: format!("entity-{id:04}"),
                value: vec![(id % 251) as u8; 120],
            })
            .collect::<Vec<_>>();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            store.tree.inject_apply_failure_after_images(1);
            let result = store.apply_batch(operations);
            assert!(matches!(result, Err(BTreeError::Journal(JournalError::Page(_)))));
            assert!(matches!(
                store.get_project("recovery-book", "entities", "entity-0000"),
                Err(BTreeError::Journal(JournalError::Invalid(
                    "se requiere cerrar y reabrir para completar recovery"
                )))
            ));
        }
        {
            let mut recovered = ProjectStore::open(&pages, &wal).unwrap();
            let report = recovered.validate().unwrap();
            assert_eq!(report.entries, 48);
            for id in 0..48u32 {
                assert_eq!(
                    recovered.get_project("recovery-book", "entities", &format!("entity-{id:04}")).unwrap(),
                    Some(vec![(id % 251) as u8; 120]),
                    "registro {id} debe sobrevivir al redo del lote completo"
                );
            }
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn recovery_replays_mixed_project_batch_after_multiple_partial_apply_positions() {
        for fail_after in [0usize, 1, 3, usize::MAX] {
            let (pages, wal) = paths();
            let old_ids = (0..96u32).map(|id| format!("old-{id:04}")).collect::<Vec<_>>();
            let new_ids = (0..96u32).map(|id| format!("new-{id:04}")).collect::<Vec<_>>();
            {
                let mut store = ProjectStore::open(&pages, &wal).unwrap();
                let initial = old_ids.iter().enumerate().map(|(index, record_id)| {
                    ProjectOperation::Put {
                        project_id: "partial-recovery-book".into(),
                        table: "entities".into(),
                        record_id: record_id.clone(),
                        value: vec![(index % 251) as u8; 160],
                    }
                }).collect::<Vec<_>>();
                store.apply_batch(initial).unwrap();

                let mut mixed = old_ids.iter().cloned().map(|record_id| {
                    ProjectOperation::Delete {
                        project_id: "partial-recovery-book".into(),
                        table: "entities".into(),
                        record_id,
                    }
                }).collect::<Vec<_>>();
                mixed.extend(new_ids.iter().enumerate().map(|(index, record_id)| {
                    ProjectOperation::Put {
                        project_id: "partial-recovery-book".into(),
                        table: "entities".into(),
                        record_id: record_id.clone(),
                        value: vec![(index % 239) as u8; 160],
                    }
                }));

                store.tree.inject_apply_failure_after_images(fail_after);
                assert!(matches!(
                    store.apply_batch(mixed),
                    Err(BTreeError::Journal(JournalError::Page(_)))
                ), "el fallo inyectado después de {fail_after} imágenes debe dejar la instancia bloqueada");
                assert!(matches!(
                    store.validate(),
                    Err(BTreeError::Journal(JournalError::Invalid(
                        "se requiere cerrar y reabrir para completar recovery"
                    )))
                ));
            }
            {
                let mut recovered = ProjectStore::open(&pages, &wal).unwrap();
                assert_eq!(recovered.validate().unwrap().entries, new_ids.len());
                for id in &old_ids {
                    assert_eq!(
                        recovered.get_project("partial-recovery-book", "entities", id).unwrap(),
                        None,
                        "ninguna clave antigua debe reaparecer con fail_after={fail_after}"
                    );
                }
                for (index, id) in new_ids.iter().enumerate() {
                    assert_eq!(
                        recovered.get_project("partial-recovery-book", "entities", id).unwrap(),
                        Some(vec![(index % 239) as u8; 160]),
                        "todas las claves nuevas deben sobrevivir con fail_after={fail_after}"
                    );
                }
                assert_eq!(recovered.validate().unwrap().entries, new_ids.len());
            }
            cleanup(&pages, &wal);
        }
    }

    #[test]
    fn batch_repeated_key_operations_are_sequential_and_commit_once() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            let before = committed_transaction_count(&wal);
            let results = store.apply_batch(vec![
                ProjectOperation::Put { project_id: "book".into(), table: "entities".into(), record_id: "e1".into(), value: b"first".to_vec() },
                ProjectOperation::Put { project_id: "book".into(), table: "entities".into(), record_id: "e1".into(), value: b"second".to_vec() },
                ProjectOperation::Delete { project_id: "book".into(), table: "entities".into(), record_id: "e1".into() },
                ProjectOperation::Put { project_id: "book".into(), table: "entities".into(), record_id: "e1".into(), value: b"final".to_vec() },
                ProjectOperation::Delete { project_id: "book".into(), table: "entities".into(), record_id: "missing".into() },
            ]).unwrap();
            assert_eq!(results, vec![
                ProjectBatchResult::Put,
                ProjectBatchResult::Put,
                ProjectBatchResult::Delete { deleted: true },
                ProjectBatchResult::Put,
                ProjectBatchResult::Delete { deleted: false },
            ]);
            assert_eq!(store.get_project("book", "entities", "e1").unwrap(), Some(b"final".to_vec()));
            assert_eq!(committed_transaction_count(&wal), before + 1);
            assert!(store.validate().is_ok());
        }
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            assert_eq!(store.get_project("book", "entities", "e1").unwrap(), Some(b"final".to_vec()));
            assert_eq!(store.get_project("book", "entities", "missing").unwrap(), None);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn batch_keeps_interleaved_project_and_table_namespaces_isolated() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            store.apply_batch(vec![
                ProjectOperation::Put { project_id: "book-A".into(), table: "entities".into(), record_id: "same".into(), value: b"A-entity".to_vec() },
                ProjectOperation::Put { project_id: "book-B".into(), table: "entities".into(), record_id: "same".into(), value: b"B-entity".to_vec() },
                ProjectOperation::Put { project_id: "book-A".into(), table: "ideas".into(), record_id: "same".into(), value: b"A-idea".to_vec() },
                ProjectOperation::Delete { project_id: "book-B".into(), table: "entities".into(), record_id: "same".into() },
            ]).unwrap();
            assert_eq!(store.get_project("book-A", "entities", "same").unwrap(), Some(b"A-entity".to_vec()));
            assert_eq!(store.get_project("book-A", "ideas", "same").unwrap(), Some(b"A-idea".to_vec()));
            assert_eq!(store.get_project("book-B", "entities", "same").unwrap(), None);
            assert!(store.validate().is_ok());
        }
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            assert_eq!(store.get_project("book-A", "entities", "same").unwrap(), Some(b"A-entity".to_vec()));
            assert_eq!(store.get_project("book-A", "ideas", "same").unwrap(), Some(b"A-idea".to_vec()));
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn batch_put_delete_and_delete_put_follow_sequential_key_state() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            store.put_project("book", "entities", "existing", b"old").unwrap();
            let results = store.apply_batch(vec![
                ProjectOperation::Put { project_id: "book".into(), table: "entities".into(), record_id: "temporary".into(), value: b"transient".to_vec() },
                ProjectOperation::Delete { project_id: "book".into(), table: "entities".into(), record_id: "temporary".into() },
                ProjectOperation::Delete { project_id: "book".into(), table: "entities".into(), record_id: "existing".into() },
                ProjectOperation::Put { project_id: "book".into(), table: "entities".into(), record_id: "existing".into(), value: b"replacement".to_vec() },
            ]).unwrap();
            assert_eq!(results, vec![
                ProjectBatchResult::Put,
                ProjectBatchResult::Delete { deleted: true },
                ProjectBatchResult::Delete { deleted: true },
                ProjectBatchResult::Put,
            ]);
            assert_eq!(store.get_project("book", "entities", "temporary").unwrap(), None);
            assert_eq!(store.get_project("book", "entities", "existing").unwrap(), Some(b"replacement".to_vec()));
        }
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            assert_eq!(store.get_project("book", "entities", "temporary").unwrap(), None);
            assert_eq!(store.get_project("book", "entities", "existing").unwrap(), Some(b"replacement".to_vec()));
            assert!(store.validate().is_ok());
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn batch_late_value_capacity_error_abandons_all_staged_operations() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            let before_pages = store.page_count();
            let before_wal = std::fs::read(&wal).unwrap();
            let result = store.apply_batch(vec![
                ProjectOperation::Put { project_id: "book".into(), table: "entities".into(), record_id: "first".into(), value: b"staged-only".to_vec() },
                ProjectOperation::Put { project_id: "book".into(), table: "entities".into(), record_id: "too-large".into(), value: vec![0xA5; 5000] },
            ]);
            assert!(matches!(result, Err(BTreeError::NoSpace)));
            assert_eq!(store.page_count(), before_pages);
            assert_eq!(std::fs::read(&wal).unwrap(), before_wal);
            assert_eq!(store.get_project("book", "entities", "first").unwrap(), None);
        }
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            assert_eq!(store.get_project("book", "entities", "first").unwrap(), None);
            assert_eq!(store.get_project("book", "entities", "too-large").unwrap(), None);
            assert!(store.validate().is_ok());
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn batch_late_identity_error_leaves_pages_and_wal_unchanged() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            let before_pages = store.page_count();
            let before_wal = std::fs::read(&wal).unwrap();
            let result = store.apply_batch(vec![
                ProjectOperation::Put { project_id: "book".into(), table: "entities".into(), record_id: "valid".into(), value: b"must-not-appear".to_vec() },
                ProjectOperation::Delete { project_id: "book".into(), table: "entities".into(), record_id: "  ".into() },
            ]);
            assert!(matches!(result, Err(BTreeError::Invalid("record_id obligatorio"))));
            assert_eq!(store.page_count(), before_pages);
            assert_eq!(std::fs::read(&wal).unwrap(), before_wal);
            assert_eq!(store.get_project("book", "entities", "valid").unwrap(), None);
        }
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            assert_eq!(store.get_project("book", "entities", "valid").unwrap(), None);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn late_batch_error_rolls_back_staged_deletions_and_mbfr_releases() {
        let (pages, wal) = paths();
        let initial = (0..96u32)
            .map(|id| ProjectOperation::Put {
                project_id: "rollback-book".into(),
                table: "entities".into(),
                record_id: format!("entity-{id:03}"),
                value: vec![(id % 251) as u8; 1500],
            })
            .collect::<Vec<_>>();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            store.apply_batch(initial).unwrap();
            assert_eq!(store.validate().unwrap().entries, 96);
        }

        let before_pages = std::fs::read(&pages).unwrap();
        let before_wal = std::fs::read(&wal).unwrap();
        let mut destructive = (0..96u32)
            .map(|id| ProjectOperation::Delete {
                project_id: "rollback-book".into(),
                table: "entities".into(),
                record_id: format!("entity-{id:03}"),
            })
            .collect::<Vec<_>>();
        destructive.push(ProjectOperation::Put {
            project_id: "rollback-book".into(),
            table: "entities".into(),
            record_id: "too-large".into(),
            value: vec![0xD7; 5000],
        });

        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            let page_count = store.page_count();
            assert!(matches!(store.apply_batch(destructive), Err(BTreeError::NoSpace)));
            assert_eq!(store.page_count(), page_count);
            assert_eq!(std::fs::read(&pages).unwrap(), before_pages);
            assert_eq!(std::fs::read(&wal).unwrap(), before_wal);
        }
        {
            let mut recovered = ProjectStore::open(&pages, &wal).unwrap();
            assert_eq!(recovered.validate().unwrap().entries, 96);
            for id in 0..96u32 {
                assert_eq!(
                    recovered.get_project("rollback-book", "entities", &format!("entity-{id:03}")).unwrap(),
                    Some(vec![(id % 251) as u8; 1500]),
                    "la eliminación staged del registro {id} no debe sobrevivir al error tardío"
                );
            }
            assert_eq!(recovered.get_project("rollback-book", "entities", "too-large").unwrap(), None);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn empty_batch_is_rejected_without_wal_change() {
        let (pages, wal) = paths();
        let mut store = ProjectStore::open(&pages, &wal).unwrap();
        let before = std::fs::read(&wal).unwrap();
        assert!(matches!(store.apply_batch(Vec::new()), Err(BTreeError::Invalid("lote vacío"))));
        assert_eq!(std::fs::read(&wal).unwrap(), before);
        drop(store);
        cleanup(&pages, &wal);
    }

    #[test]
    fn batch_of_missing_deletes_is_a_noop_without_empty_commit() {
        let (pages, wal) = paths();
        let mut store = ProjectStore::open(&pages, &wal).unwrap();
        let before = std::fs::read(&wal).unwrap();
        let results = store.apply_batch(vec![
            ProjectOperation::Delete { project_id: "book".into(), table: "entities".into(), record_id: "missing-1".into() },
            ProjectOperation::Delete { project_id: "book".into(), table: "entities".into(), record_id: "missing-2".into() },
        ]).unwrap();
        assert_eq!(results, vec![
            ProjectBatchResult::Delete { deleted: false },
            ProjectBatchResult::Delete { deleted: false },
        ]);
        assert_eq!(std::fs::read(&wal).unwrap(), before);
        assert_eq!(store.validate().unwrap().entries, 0);
        drop(store);
        cleanup(&pages, &wal);
    }

    #[test]
    fn generated_batch_matches_sequential_reference_and_survives_reopen() {
        use std::collections::BTreeMap;
        let (pages, wal) = paths();
        let mut model = BTreeMap::<(String, String, String), Vec<u8>>::new();
        let mut operations = Vec::new();
        let mut expected_results = Vec::new();
        let mut state = 0x243f_6a88_85a3_08d3u64;

        for step in 0..240u64 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let project_id = format!("project-{}", (state % 4));
            let table = format!("table-{}", ((state >> 4) % 3));
            let record_id = format!("record-{:03}", ((state >> 9) % 64));
            let identity = (project_id.clone(), table.clone(), record_id.clone());
            if state & 3 == 0 {
                let deleted = model.remove(&identity).is_some();
                expected_results.push(ProjectBatchResult::Delete { deleted });
                operations.push(ProjectOperation::Delete { project_id, table, record_id });
            } else {
                let value = vec![(step % 251) as u8; 1 + (state as usize % 96)];
                model.insert(identity, value.clone());
                expected_results.push(ProjectBatchResult::Put);
                operations.push(ProjectOperation::Put { project_id, table, record_id, value });
            }
        }

        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            assert_eq!(store.apply_batch(operations).unwrap(), expected_results);
            assert_eq!(store.validate().unwrap().entries, model.len());
            for project_index in 0..4 {
                for table_index in 0..3 {
                    let project_id = format!("project-{project_index}");
                    let table = format!("table-{table_index}");
                    let actual = store.scan_project_table(&project_id, &table).unwrap();
                    let expected = model.iter()
                        .filter(|((project, tab, _), _)| project == &project_id && tab == &table)
                        .map(|((_, _, id), value)| (id.clone(), value.clone()))
                        .collect::<Vec<_>>();
                    assert_eq!(actual, expected);
                }
            }
        }
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            assert_eq!(store.validate().unwrap().entries, model.len());
            for ((project, table, id), value) in &model {
                assert_eq!(store.get_project(project, table, id).unwrap(), Some(value.clone()));
            }
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn project_and_table_namespaces_are_isolated() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            store.put_project("book-A", "entities", "same-id", b"A").unwrap();
            store.put_project("book-B", "entities", "same-id", b"B").unwrap();
            store.put_project("book-A", "ideas", "same-id", b"idea").unwrap();
            assert_eq!(store.get_project("book-A", "entities", "same-id").unwrap(), Some(b"A".to_vec()));
            assert_eq!(store.get_project("book-B", "entities", "same-id").unwrap(), Some(b"B".to_vec()));
            assert_eq!(store.get_project("book-A", "ideas", "same-id").unwrap(), Some(b"idea".to_vec()));
            assert!(store.validate().is_ok());
        }
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            assert_eq!(store.get_project("book-A", "entities", "same-id").unwrap(), Some(b"A".to_vec()));
            assert_eq!(store.get_project("book-B", "entities", "same-id").unwrap(), Some(b"B".to_vec()));
            assert!(store.validate().is_ok());
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn table_scan_is_bounded_to_exact_project_and_table() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            store.put_project("book", "entities", "z", b"last").unwrap();
            store.put_project("book", "entities", "a", b"first").unwrap();
            store.put_project("booklet", "entities", "a", b"other-project").unwrap();
            store.put_project("book", "events", "a", b"other-table").unwrap();
            store.put_project("book", "entities-archive", "a", b"table-prefix-neighbor").unwrap();
            assert_eq!(
                store.scan_project_table("book", "entities").unwrap(),
                vec![
                    ("a".to_string(), b"first".to_vec()),
                    ("z".to_string(), b"last".to_vec()),
                ]
            );
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn table_iterator_yields_incrementally_and_keeps_project_boundary() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            for id in ["c", "a", "b"] {
                store.put_project("book", "entities", id, id.as_bytes()).unwrap();
            }
            store.put_project("book2", "entities", "a", b"outside").unwrap();
            let mut iter = store.scan_project_table_iter("book", "entities").unwrap();
            assert_eq!(iter.next().unwrap().unwrap(), ("a".to_string(), b"a".to_vec()));
            assert_eq!(iter.next().unwrap().unwrap(), ("b".to_string(), b"b".to_vec()));
            assert_eq!(iter.next().unwrap().unwrap(), ("c".to_string(), b"c".to_vec()));
            assert!(iter.next().is_none());
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn table_iterator_after_cursor_seeks_exclusively_across_leaf_pages() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            for index in (0..192).rev() {
                let id = format!("record-{index:03}");
                store.put_project("cursor-book", "entities", &id, id.as_bytes()).unwrap();
            }
            store.put_project("cursor-book-archive", "entities", "record-100", b"outside").unwrap();

            let mut iter = store.scan_project_table_after_iter(
                "cursor-book", "entities", "record-127",
            ).unwrap();
            for index in 128..192 {
                let (id, value) = iter.next().unwrap().unwrap();
                assert_eq!(id, format!("record-{index:03}"));
                assert_eq!(value, id.as_bytes().to_vec());
            }
            assert!(iter.next().is_none());

            let mut from_missing = store.scan_project_table_after_iter(
                "cursor-book", "entities", "record-127x",
            ).unwrap();
            assert_eq!(from_missing.next().unwrap().unwrap().0, "record-128");
            let mut from_last = store.scan_project_table_after_iter(
                "cursor-book", "entities", "record-191",
            ).unwrap();
            assert!(from_last.next().is_none());
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn table_cursor_preserves_utf8_and_escaped_nul_identifier_order() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            for id in ["á", "b", "a\0b", "a"] {
                store.put_project("unicode-cursor", "entities", id, id.as_bytes()).unwrap();
            }
            let mut after_a = store.scan_project_table_after_iter(
                "unicode-cursor", "entities", "a",
            ).unwrap();
            assert_eq!(after_a.next().unwrap().unwrap().0, "a\0b");
            assert_eq!(after_a.next().unwrap().unwrap().0, "b");
            assert_eq!(after_a.next().unwrap().unwrap().0, "á");
            assert!(after_a.next().is_none());
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn project_table_iterator_crosses_multiple_leaf_pages() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            for index in (0..96).rev() {
                let id = format!("record-{index:03}");
                let value = vec![(index % 251) as u8; 48];
                store.put_project("large-book", "entities", &id, &value).unwrap();
            }
            store.put_project("large-book-archive", "entities", "record-050", b"outside").unwrap();
            assert!(store.page_count() > 2);
            let mut iter = store.scan_project_table_iter("large-book", "entities").unwrap();
            for index in 0..96 {
                let (id, value) = iter.next().unwrap().unwrap();
                assert_eq!(id, format!("record-{index:03}"));
                assert_eq!(value, vec![(index % 251) as u8; 48]);
            }
            assert!(iter.next().is_none());
            let report = store.validate().unwrap();
            assert_eq!(report.entries, 97);
        }
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            assert_eq!(store.scan_project_table("large-book", "entities").unwrap().len(), 96);
            assert_eq!(store.get_project("large-book-archive", "entities", "record-050").unwrap(), Some(b"outside".to_vec()));
            assert!(store.validate().is_ok());
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn delete_and_replace_only_affect_the_target_record() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            store.put_project("p", "records", "r", b"old").unwrap();
            store.put_project("q", "records", "r", b"untouched").unwrap();
            store.put_project("p", "records", "r", b"new").unwrap();
            assert!(store.delete_project("p", "records", "r").unwrap());
            assert!(!store.delete_project("p", "records", "r").unwrap());
            assert_eq!(store.get_project("p", "records", "r").unwrap(), None);
            assert_eq!(store.get_project("q", "records", "r").unwrap(), Some(b"untouched".to_vec()));
            assert!(store.validate().is_ok());
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn identifiers_with_nul_bytes_roundtrip_without_key_collisions() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            store.put_project("p\0x", "table", "id\0x", b"value").unwrap();
            assert_eq!(store.get_project("p\0x", "table", "id\0x").unwrap(), Some(b"value".to_vec()));
            assert_eq!(store.scan_project_table("p\0x", "table").unwrap(), vec![("id\0x".to_string(), b"value".to_vec())]);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn rejects_missing_identity_and_oversized_composite_key() {
        let (pages, wal) = paths();
        let mut store = ProjectStore::open(&pages, &wal).unwrap();
        assert!(matches!(store.put_project("", "t", "r", b"x"), Err(BTreeError::Invalid(_))));
        assert!(matches!(store.get_project("p", " ", "r"), Err(BTreeError::Invalid(_))));
        let huge_scope = "x".repeat(u16::MAX as usize);
        assert!(matches!(store.scan_project_table_iter(&huge_scope, "t"), Err(BTreeError::Invalid(_))));
        let huge = "x".repeat(u16::MAX as usize);
        assert!(matches!(store.put_project("p", "t", &huge, b"x"), Err(BTreeError::Invalid(_))));
        drop(store);
        cleanup(&pages, &wal);
    }

    #[test]
    fn deterministic_mixed_project_operations_match_reference_after_reopen() {
        let (pages, wal) = paths();
        let mut store = ProjectStore::open(&pages, &wal).unwrap();
        let mut expected = std::collections::BTreeMap::<(String, String, String), Vec<u8>>::new();
        let mut state = 0x6a09_e667_f3bc_c909u64;

        for step in 0..240u64 {
            // PRNG determinista: el mismo patrón se reproduce en cualquier plataforma.
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let project = format!("book-{}", (state & 1));
            let table = format!("table-{}", ((state >> 1) & 1));
            let record = format!("record-{:02}", ((state >> 2) % 24));
            let key = (project.clone(), table.clone(), record.clone());

            match (state >> 8) % 3 {
                0 => {
                    let value = format!("value-{step}-{}", state).into_bytes();
                    store.put_project(&project, &table, &record, &value).unwrap();
                    expected.insert(key, value);
                }
                1 => {
                    let removed = store.delete_project(&project, &table, &record).unwrap();
                    assert_eq!(removed, expected.remove(&key).is_some());
                }
                _ => {
                    assert_eq!(store.get_project(&project, &table, &record).unwrap(), expected.get(&key).cloned());
                }
            }

            if step % 40 == 39 {
                for p in ["book-0", "book-1"] {
                    for t in ["table-0", "table-1"] {
                        let actual = store.scan_project_table(p, t).unwrap();
                        let reference: Vec<(String, Vec<u8>)> = expected.iter()
                            .filter(|((project, table, _), _)| project == p && table == t)
                            .map(|((_, _, record), value)| (record.clone(), value.clone()))
                            .collect();
                        assert_eq!(actual, reference);
                    }
                }
                assert!(store.validate().is_ok());
                drop(store);
                store = ProjectStore::open(&pages, &wal).unwrap();
            }
        }

        for p in ["book-0", "book-1"] {
            for t in ["table-0", "table-1"] {
                let actual = store.scan_project_table(p, t).unwrap();
                let reference: Vec<(String, Vec<u8>)> = expected.iter()
                    .filter(|((project, table, _), _)| project == p && table == t)
                    .map(|((_, _, record), value)| (record.clone(), value.clone()))
                    .collect();
                assert_eq!(actual, reference);
            }
        }
        assert!(store.validate().is_ok());
        drop(store);
        cleanup(&pages, &wal);
    }

    #[test]
    fn oversized_record_is_rejected_without_partial_tree_mutation() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            store.put_project("p", "records", "valid", b"before").unwrap();
            let oversized = vec![7u8; 5000];
            assert!(matches!(
                store.put_project("p", "records", "too-large", &oversized),
                Err(BTreeError::NoSpace)
            ));
            assert_eq!(store.get_project("p", "records", "valid").unwrap(), Some(b"before".to_vec()));
            assert_eq!(store.get_project("p", "records", "too-large").unwrap(), None);
            assert!(store.validate().is_ok());
        }
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            assert_eq!(store.get_project("p", "records", "valid").unwrap(), Some(b"before".to_vec()));
            assert_eq!(store.get_project("p", "records", "too-large").unwrap(), None);
            assert!(store.validate().is_ok());
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn composite_key_codec_is_collision_free_for_binary_utf8_components() {
        let samples = ["a", "b", "\0", "a\0", "é"];
        let mut encoded = std::collections::BTreeSet::new();
        for project in samples {
            for table in samples {
                for record in samples {
                    let key = encode_key(project, table, record).unwrap();
                    assert!(encoded.insert(key.clone()), "colisión para ({project:?}, {table:?}, {record:?})");
                    assert_eq!(decode_key(&key).unwrap(), (project.to_string(), table.to_string(), record.to_string()));
                }
            }
        }
        assert_eq!(encoded.len(), samples.len().pow(3));
    }

    #[test]
    fn composite_key_size_includes_encoding_version_byte() {
        let project = "p";
        let table = "t";
        let max_record_len = MAX_TREE_KEY_LEN
            + 1
            - 1 // versión de codificación
            - encode_component(project).len()
            - encode_component(table).len()
            - 2;
        let record = "r".repeat(max_record_len);
        assert!(matches!(
            validate_identity(project, table, &record),
            Err(BTreeError::Invalid("clave compuesta supera la capacidad del B+Tree"))
        ));
        let accepted = "r".repeat(max_record_len - 1);
        assert!(validate_identity(project, table, &accepted).is_ok());
        let encoded = encode_key(project, table, &accepted).unwrap();
        assert_eq!(encoded.len(), MAX_TREE_KEY_LEN);
        assert_eq!(
            decode_key(&encoded).unwrap(),
            (project.to_string(), table.to_string(), accepted)
        );
    }

    #[test]
    fn rejects_unknown_composite_key_encoding_version() {
        let mut key = encode_key("p", "t", "r").unwrap();
        key[0] = KEY_ENCODING_VERSION + 1;
        assert!(matches!(decode_key(&key), Err(BTreeError::Corrupt("versión de clave compuesta no soportada"))));
    }

    #[test]
    fn prefix_successor_bounds_encoded_components() {
        let mut prefix = vec![KEY_ENCODING_VERSION];
        prefix.extend_from_slice(&encode_component("book"));
        prefix.extend_from_slice(&encode_component("entities"));
        let end = prefix_successor(&prefix).unwrap();
        let own = encode_key("book", "entities", "id").unwrap();
        let other_project = encode_key("booklet", "entities", "id").unwrap();
        let other_table = encode_key("book", "events", "id").unwrap();
        assert!(own >= prefix && own < end);
        assert!(other_project < prefix || other_project >= end);
        assert!(other_table < prefix || other_table >= end);
    }

    #[test]
    fn interleaved_namespaces_survive_multileaf_deletes_checkpoint_and_reopen() {
        let (pages, wal) = paths();
        let mut expected = std::collections::BTreeMap::<(String, String, String), Vec<u8>>::new();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            // Intercalar proyectos y tablas para forzar que sus claves compartan
            // hojas físicas sin permitir que los recorridos crucen sus límites.
            for record in (0..24).rev() {
                for project in ["novel-A", "novel-B", "novel-C"] {
                    for table in ["entities", "events"] {
                        let id = format!("record-{record:03}");
                        let mut value = vec![
                            (record as u8).wrapping_add(project.as_bytes()[6]);
                            96 + (record as usize % 37)
                        ];
                        value.push(table.len() as u8);
                        store.put_project(project, table, &id, &value).unwrap();
                        expected.insert((project.to_string(), table.to_string(), id), value);
                    }
                }
            }
            assert!(store.page_count() > 2);

            for record in (0..24).step_by(3) {
                let id = format!("record-{record:03}");
                for project in ["novel-A", "novel-B", "novel-C"] {
                    for table in ["entities", "events"] {
                        assert!(store.delete_project(project, table, &id).unwrap());
                        expected.remove(&(project.to_string(), table.to_string(), id.clone()));
                    }
                }
            }

            for project in ["novel-A", "novel-B", "novel-C"] {
                for table in ["entities", "events"] {
                    let actual = store.scan_project_table(project, table).unwrap();
                    let reference = expected.iter()
                        .filter(|((p, t, _), _)| p == project && t == table)
                        .map(|((_, _, id), value)| (id.clone(), value.clone()))
                        .collect::<Vec<_>>();
                    assert_eq!(actual, reference, "ámbito {project}/{table}");
                }
            }
            assert!(store.validate().is_ok());
            store.checkpoint().unwrap();
        }
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            for project in ["novel-A", "novel-B", "novel-C"] {
                for table in ["entities", "events"] {
                    let actual = store.scan_project_table(project, table).unwrap();
                    let reference = expected.iter()
                        .filter(|((p, t, _), _)| p == project && t == table)
                        .map(|((_, _, id), value)| (id.clone(), value.clone()))
                        .collect::<Vec<_>>();
                    assert_eq!(actual, reference, "reapertura de {project}/{table}");
                }
            }
            assert_eq!(store.validate().unwrap().entries, expected.len());
        }
        cleanup(&pages, &wal);
    }


    #[test]
    fn scans_do_not_bleed_into_prefix_neighbor_namespaces() {
        let (pages, wal) = paths();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            let cases = [
                ("book", "events", "same", b"target".as_slice()),
                ("booklet", "events", "same", b"longer-project".as_slice()),
                ("book\0", "events", "same", b"nul-project".as_slice()),
                ("book", "events-log", "same", b"longer-table".as_slice()),
                ("book", "events\0", "same", b"nul-table".as_slice()),
                ("book", "events", "same\0", b"nul-record".as_slice()),
                ("böök", "événements", "clé", b"unicode".as_slice()),
            ];
            for (project, table, id, value) in cases {
                store.put_project(project, table, id, value).unwrap();
            }

            assert_eq!(
                store.scan_project_table("book", "events").unwrap(),
                vec![("same".to_string(), b"target".to_vec())]
            );
            assert_eq!(
                store.scan_project_table("book\0", "events").unwrap(),
                vec![("same".to_string(), b"nul-project".to_vec())]
            );
            assert_eq!(
                store.scan_project_table("book", "events\0").unwrap(),
                vec![("same".to_string(), b"nul-table".to_vec())]
            );
            assert_eq!(
                store.scan_project_table("book", "events-log").unwrap(),
                vec![("same".to_string(), b"longer-table".to_vec())]
            );
            assert_eq!(
                store.scan_project_table("böök", "événements").unwrap(),
                vec![("clé".to_string(), b"unicode".to_vec())]
            );
            assert_eq!(
                store.get_project("book", "events", "same\0").unwrap(),
                Some(b"nul-record".to_vec())
            );
            assert!(store.validate().is_ok());
        }
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            assert_eq!(
                store.scan_project_table("book", "events").unwrap(),
                vec![("same".to_string(), b"target".to_vec())]
            );
            assert_eq!(
                store.scan_project_table("book\0", "events").unwrap(),
                vec![("same".to_string(), b"nul-project".to_vec())]
            );
            assert_eq!(
                store.scan_project_table("book", "events\0").unwrap(),
                vec![("same".to_string(), b"nul-table".to_vec())]
            );
            assert!(store.validate().is_ok());
        }
        cleanup(&pages, &wal);
    }


    #[test]
    fn recovery_replays_project_batch_that_deletes_and_reuses_mbfr_pages() {
        let (pages, wal) = paths();
        let old_ids = (0..96u32).map(|id| format!("old-{id:04}")).collect::<Vec<_>>();
        let new_ids = (0..96u32).map(|id| format!("new-{id:04}")).collect::<Vec<_>>();
        {
            let mut store = ProjectStore::open(&pages, &wal).unwrap();
            let initial = old_ids.iter().enumerate().map(|(index, id)| {
                ProjectOperation::Put {
                    project_id: "recovery-book".into(),
                    table: "entities".into(),
                    record_id: id.clone(),
                    value: vec![(index % 251) as u8; 160],
                }
            }).collect::<Vec<_>>();
            let results = store.apply_batch(initial).unwrap();
            assert_eq!(results.len(), old_ids.len());
            let mut operations = old_ids.iter().cloned().map(|record_id| {
                ProjectOperation::Delete {
                    project_id: "recovery-book".into(),
                    table: "entities".into(),
                    record_id,
                }
            }).collect::<Vec<_>>();
            operations.extend(new_ids.iter().enumerate().map(|(index, id)| {
                ProjectOperation::Put {
                    project_id: "recovery-book".into(),
                    table: "entities".into(),
                    record_id: id.clone(),
                    value: vec![(index % 239) as u8; 160],
                }
            }));

            store.tree.inject_apply_failure_after_images(1);
            assert!(matches!(
                store.apply_batch(operations),
                Err(BTreeError::Journal(JournalError::Page(_)))
            ));
            assert!(matches!(
                store.validate(),
                Err(BTreeError::Journal(JournalError::Invalid(
                    "se requiere cerrar y reabrir para completar recovery"
                )))
            ));
        }
        {
            let mut recovered = ProjectStore::open(&pages, &wal).unwrap();
            let report = recovered.validate().unwrap();
            assert_eq!(report.entries, new_ids.len());
            for id in &old_ids {
                assert_eq!(recovered.get_project("recovery-book", "entities", id).unwrap(), None);
            }
            for (index, id) in new_ids.iter().enumerate() {
                assert_eq!(
                    recovered.get_project("recovery-book", "entities", id).unwrap(),
                    Some(vec![(index % 239) as u8; 160])
                );
            }
            assert_eq!(recovered.validate().unwrap().entries, new_ids.len());
        }
        cleanup(&pages, &wal);
    }

}
