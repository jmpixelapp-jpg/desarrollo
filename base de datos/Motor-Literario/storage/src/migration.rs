//! Importación controlada del WAL legado hacia un ProjectStore nuevo.
//!
//! El origen permanece bloqueado durante el snapshot. El destino debe ser
//! nuevo, aislado y no publicarse hasta completar la verificación posterior.

use crate::btree::{BTreeError, ValidationReport};
use crate::project_store::{ProjectOperation, ProjectStore};
use crate::interprocess_lock::InterprocessLock;
use crate::{Error as StoreError, Store, StoreSnapshot, StoreSnapshotError};
use crate::migration_manifest::{ManifestError, ManifestStore, MigrationManifest, MigrationState};
use crate::publication::{FileDigest, GenerationReceipt, PublicationError, PublicationPointer, PublicationStore, PublishedStoreOpenError};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

/// Tamaño máximo permitido para cada lote de importación.
pub const MAX_SNAPSHOT_IMPORT_BATCH_SIZE: usize = 256;
/// Presupuesto lógico por copia de lote. La verificación conserva una segunda
/// copia de operaciones; por eso el límite se fija a la mitad del presupuesto
/// agregado aproximado de 256 KiB (sin contar overhead de allocator/estructuras).
pub const MAX_SNAPSHOT_IMPORT_BATCH_BYTES: usize = 128 * 1024;
/// Tamaño recomendado para importaciones normales.
pub const DEFAULT_SNAPSHOT_IMPORT_BATCH_SIZE: usize = 128;

/// Resultado de importar un snapshot legado en lotes MLPJ.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotImportReport {
    pub records_imported: usize,
    pub batches_committed: usize,
    pub destination: ValidationReport,
}

/// Fallos posibles durante la extracción o importación del snapshot.
#[derive(Debug)]
pub enum SnapshotImportError {
    InvalidBatchSize,
    TargetNotEmpty { entries: usize },
    SourceRecoveryRequired,
    SourcePoisoned,
    Target(BTreeError),
    Manifest(ManifestError),
    ResumeMismatch(&'static str),
    SourceChanged,
    VerificationMismatch(&'static str),
    Publication(PublicationError),
}

impl std::fmt::Display for SnapshotImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidBatchSize => write!(
                f,
                "el tamaño del lote debe estar entre 1 y {MAX_SNAPSHOT_IMPORT_BATCH_SIZE}"
            ),
            Self::TargetNotEmpty { entries } => write!(
                f,
                "el destino de migración debe estar vacío; contiene {entries} registros"
            ),
            Self::SourceRecoveryRequired => write!(
                f,
                "el WAL de origen requiere cierre y reapertura antes de exportar"
            ),
            Self::SourcePoisoned => write!(f, "el bloqueo interno del WAL de origen está envenenado"),
            Self::Target(error) => write!(f, "error al importar en ProjectStore: {error}"),
            Self::Manifest(error) => write!(f, "error al persistir el manifiesto: {error}"),
            Self::ResumeMismatch(reason) => write!(f, "el destino no coincide con el progreso del manifiesto: {reason}"),
            Self::SourceChanged => write!(f, "el WAL de origen cambió durante la migración; el destino no puede publicarse"),
            Self::VerificationMismatch(reason) => write!(f, "la verificación integral de migración falló: {reason}"),
            Self::Publication(error) => write!(f, "error al publicar generación: {error}"),
        }
    }
}

impl std::error::Error for SnapshotImportError {}

fn map_published_store_open_error(error:PublishedStoreOpenError)->SnapshotImportError{
    match error{
        PublishedStoreOpenError::Publication(error)=>SnapshotImportError::Publication(error),
        PublishedStoreOpenError::Store(error)=>SnapshotImportError::Target(error),
    }
}


fn apply_batch_and_verify(
    target: &mut ProjectStore,
    operations: Vec<ProjectOperation>,
) -> Result<(), BTreeError> {
    // La segunda copia conserva las expectativas para verificar tras el COMMIT.
    // El presupuesto del importador reserva 128 KiB para cada copia.
    let expected = operations.clone();
    target.apply_batch(operations)?;

    for operation in expected {
        match operation {
            ProjectOperation::Put {
                project_id,
                table,
                record_id,
                value,
            } => {
                let actual = target.get_project(&project_id, &table, &record_id)?;
                if actual.as_deref() != Some(value.as_slice()) {
                    return Err(BTreeError::Corrupt(
                        "el registro importado no coincide con el snapshot de origen",
                    ));
                }
            }
            ProjectOperation::Delete { .. } => {
                return Err(BTreeError::Invalid(
                    "la importación de snapshot solo admite operaciones PUT",
                ));
            }
        }
    }
    Ok(())
}

/// Importa el snapshot completo del WAL legado en un ProjectStore vacío.
///
/// El origen queda bloqueado durante toda la extracción. Los registros se
/// copian sin reinterpretar sus identidades ni sus bytes y se confirman en
/// lotes independientes. El lote admite hasta 256 registros y 128 KiB lógicos por copia (la verificación mantiene una copia adicional; presupuesto agregado aproximado 256 KiB, sin contar overhead de allocator).
///
/// IMPORTANTE: esta función no hace que todos los lotes sean una única
/// transacción global. Si falla después de confirmar uno o más lotes, el
/// destino queda parcial y debe descartarse; nunca debe publicarse ni
/// reutilizarse como si fuera una migración completa. El WAL de origen no se modifica. Para importaciones con checkpoints durables y
/// reanudación, usar `import_legacy_snapshot_resumable()`; la publicación segura
/// y verificación integral siguen siendo fases separadas.
pub fn import_legacy_snapshot(
    source: &Store,
    target: &mut ProjectStore,
    batch_size: usize,
) -> Result<SnapshotImportReport, SnapshotImportError> {
    if batch_size == 0 || batch_size > MAX_SNAPSHOT_IMPORT_BATCH_SIZE {
        return Err(SnapshotImportError::InvalidBatchSize);
    }

    let initial = target.validate().map_err(SnapshotImportError::Target)?;
    if initial.entries != 0 {
        return Err(SnapshotImportError::TargetNotEmpty {
            entries: initial.entries,
        });
    }

    let mut batch = Vec::with_capacity(batch_size);
    let mut batch_bytes = 0usize;
    let mut report = SnapshotImportReport {
        records_imported: 0,
        batches_committed: 0,
        destination: initial,
    };

    let snapshot_result = source.visit_records(|project, table, id, value| {
        let record_bytes = project.len()
            .checked_add(table.len())
            .and_then(|n| n.checked_add(id.len()))
            .and_then(|n| n.checked_add(value.len()))
            .ok_or(BTreeError::Invalid("tamaño de registro desbordado"))?;
        if record_bytes > MAX_SNAPSHOT_IMPORT_BATCH_BYTES {
            return Err(BTreeError::Invalid(
                "un registro supera el límite de memoria por lote de migración",
            ));
        }

        if !batch.is_empty()
            && (batch.len() >= batch_size
                || batch_bytes + record_bytes > MAX_SNAPSHOT_IMPORT_BATCH_BYTES)
        {
            let operations = std::mem::replace(
                &mut batch,
                Vec::with_capacity(batch_size),
            );
            let committed = operations.len();
            apply_batch_and_verify(target, operations)?;
            report.records_imported += committed;
            report.batches_committed += 1;
            batch_bytes = 0;
        }

        batch.push(ProjectOperation::Put {
            project_id: project.to_owned(),
            table: table.to_owned(),
            record_id: id.to_owned(),
            value: value.to_vec(),
        });
        batch_bytes += record_bytes;

        if batch.len() >= batch_size || batch_bytes == MAX_SNAPSHOT_IMPORT_BATCH_BYTES {
            let operations = std::mem::replace(
                &mut batch,
                Vec::with_capacity(batch_size),
            );
            let committed = operations.len();
            apply_batch_and_verify(target, operations)?;
            report.records_imported += committed;
            report.batches_committed += 1;
            batch_bytes = 0;
        }
        Ok::<(), BTreeError>(())
    });

    match snapshot_result {
        Ok(()) => {}
        Err(StoreSnapshotError::RecoveryRequired) => {
            return Err(SnapshotImportError::SourceRecoveryRequired);
        }
        Err(StoreSnapshotError::Poisoned) => {
            return Err(SnapshotImportError::SourcePoisoned);
        }
        Err(StoreSnapshotError::Visitor(error)) => {
            return Err(SnapshotImportError::Target(error));
        }
    }

    if !batch.is_empty() {
        let committed = batch.len();
        apply_batch_and_verify(target, batch).map_err(SnapshotImportError::Target)?;
        report.records_imported += committed;
        report.batches_committed += 1;
    }

    let final_validation = target.validate().map_err(SnapshotImportError::Target)?;
    if final_validation.entries != report.records_imported {
        return Err(SnapshotImportError::Target(BTreeError::Corrupt(
            "el recuento importado no coincide con el destino validado",
        )));
    }
    report.destination = final_validation;
    Ok(report)
}


/// Importación con checkpoint durable después de cada lote MLPJ.
/// El llamador debe proporcionar un manifiesto Created cuando comienza una
/// migración nueva. Si ya existe uno, se reanuda desde su cursor tras verificar
/// todo el prefijo importado contra el WAL de origen y el recuento del destino.
///
/// El fingerprint del origen y del prefijo usa SHA-256 incremental. El checksum
/// del contenedor del manifiesto es un control de corrupción separado, no una firma.
/// La publicación sigue requiriendo verificación independiente.
pub fn import_legacy_snapshot_resumable(
    source: &Store,
    target: &mut ProjectStore,
    manifests: &mut ManifestStore,
    initial_manifest: MigrationManifest,
    batch_size: usize,
) -> Result<SnapshotImportReport, SnapshotImportError> {
    if batch_size == 0 || batch_size > MAX_SNAPSHOT_IMPORT_BATCH_SIZE {
        return Err(SnapshotImportError::InvalidBatchSize);
    }

    let mut source_hash = Sha256::new();
    let mut source_records = 0u64;
    let mut source_bytes = 0u64;
    source.visit_records(|project, table, id, value| {
        hash_record(&mut source_hash, project, table, id, value);
        source_records = source_records.checked_add(1)
            .ok_or(BTreeError::Invalid("contador de origen desbordado"))?;
        source_bytes = source_bytes.checked_add(logical_record_bytes(project, table, id, value)? as u64)
            .ok_or(BTreeError::Invalid("bytes de origen desbordados"))?;
        Ok::<(), BTreeError>(())
    }).map_err(map_snapshot_error)?;
    let source_fingerprint = source_hash.finish();

    if manifests.current().is_none() {
        let mut initial = initial_manifest.clone();
        if initial.state != MigrationState::Created || initial.generation != 1 {
            return Err(SnapshotImportError::ResumeMismatch("el manifiesto inicial debe estar en Created, generación 1"));
        }
        initial.source_records = source_records;
        initial.source_logical_bytes = source_bytes;
        initial.source_hash = [0; 32];
        initial.batch_size = batch_size as u32;
        initial.batch_byte_budget = MAX_SNAPSHOT_IMPORT_BATCH_BYTES as u64;
        manifests.create(initial).map_err(SnapshotImportError::Manifest)?;
        let mut scanned = manifests.current().unwrap().clone();
        scanned.transition(MigrationState::SourceScanned).map_err(SnapshotImportError::Manifest)?;
        scanned.source_hash = source_fingerprint;
        manifests.save(scanned).map_err(SnapshotImportError::Manifest)?;
    }

    let mut manifest = manifests.current().unwrap().clone();
    let actual_source_path = source.path().map_err(|_| SnapshotImportError::SourcePoisoned)?;
    if manifest.source_path != actual_source_path.to_string_lossy().as_ref() {
        return Err(SnapshotImportError::ResumeMismatch("la ruta del WAL no coincide con el manifiesto"));
    }
    if manifest.destination_path != target.paths().0.to_string_lossy().as_ref() {
        return Err(SnapshotImportError::ResumeMismatch("la ruta de páginas del destino no coincide con el manifiesto"));
    }
    if manifest.migration_id != initial_manifest.migration_id
        || manifest.destination_path != initial_manifest.destination_path
        || manifest.source_path != initial_manifest.source_path
    {
        return Err(SnapshotImportError::ResumeMismatch("la identidad suministrada no coincide con el manifiesto existente"));
    }
    if manifest.source_records != source_records
        || manifest.source_logical_bytes != source_bytes
        || manifest.source_hash != source_fingerprint
    {
        abort_manifest(manifests, &mut manifest);
        return Err(SnapshotImportError::SourceChanged);
    }
    if manifest.batch_size as usize != batch_size
        || manifest.batch_byte_budget != MAX_SNAPSHOT_IMPORT_BATCH_BYTES as u64
    {
        return Err(SnapshotImportError::ResumeMismatch("los límites de lote no coinciden con el manifiesto"));
    }
    if !matches!(manifest.state, MigrationState::SourceScanned | MigrationState::Importing) {
        return Err(SnapshotImportError::ResumeMismatch("el estado no admite continuar la importación"));
    }
    if manifest.state == MigrationState::SourceScanned {
        manifest.transition(MigrationState::Importing).map_err(SnapshotImportError::Manifest)?;
        manifests.save(manifest.clone()).map_err(SnapshotImportError::Manifest)?;
    }

    let existing = target.validate().map_err(SnapshotImportError::Target)?;
    if existing.entries < manifest.imported_records {
        return Err(SnapshotImportError::ResumeMismatch("el destino perdió registros ya confirmados"));
    }
    let recovery_extra = existing.entries - manifest.imported_records;
    if recovery_extra > manifest.batch_size as u64 {
        return Err(SnapshotImportError::ResumeMismatch(
            "el destino contiene más de un lote sin checkpoint",
        ));
    }

    let resume_cursor = decode_cursor(&manifest.cursor)?;
    let mut prefix_hash = Sha256::new();
    let mut full_hash = Sha256::new();
    let mut seen_records = 0u64;
    let mut seen_bytes = 0u64;
    let mut prefix_records = 0u64;
    let mut prefix_bytes = 0u64;
    // El cursor debe ser exactamente la última clave del prefijo, no solo
    // una posición posterior que casualmente produzca el mismo hash/recuento.
    let mut prefix_last: Option<(String, String, String)> = None;
    let mut prefix_validated = false;
    let mut recovery_remaining = recovery_extra;
    let mut recovery_bytes = 0u64;
    let mut recovery_last: Option<(String, String, String)> = None;
    let mut batch = Vec::with_capacity(batch_size);
    let mut batch_bytes = 0usize;
    let mut batch_last: Option<(String, String, String)> = None;
    let mut report = SnapshotImportReport {
        records_imported: 0,
        batches_committed: 0,
        destination: existing,
    };

    let snapshot_result = source.visit_records(|project, table, id, value| {
        hash_record(&mut full_hash, project, table, id, value);
        seen_records = seen_records.checked_add(1)
            .ok_or(BTreeError::Invalid("contador de origen desbordado"))?;
        let record_bytes = logical_record_bytes(project, table, id, value)?;
        if record_bytes > MAX_SNAPSHOT_IMPORT_BATCH_BYTES {
            return Err(BTreeError::Invalid("un registro supera el límite de memoria por lote de migración"));
        }
        seen_bytes = seen_bytes.checked_add(record_bytes as u64)
            .ok_or(BTreeError::Invalid("bytes de origen desbordados"))?;
        let key = (project.to_owned(), table.to_owned(), id.to_owned());

        if resume_cursor.as_ref().map_or(false, |cursor| key <= *cursor) {
            hash_record(&mut prefix_hash, project, table, id, value);
            prefix_records = prefix_records.checked_add(1)
                .ok_or(BTreeError::Invalid("contador del prefijo desbordado"))?;
            prefix_bytes = prefix_bytes.checked_add(record_bytes as u64)
                .ok_or(BTreeError::Invalid("bytes del prefijo desbordados"))?;
            prefix_last = Some(key.clone());
            let actual = target.get_project(project, table, id)?;
            if actual.as_deref() != Some(value) {
                return Err(BTreeError::Corrupt("el prefijo ya importado difiere del origen"));
            }
            return Ok(());
        }

        if !prefix_validated {
            if prefix_records != manifest.imported_records
                || prefix_last != resume_cursor
                || (manifest.imported_records > 0 && prefix_hash.finish() != manifest.prefix_hash)
            {
                return Err(BTreeError::Corrupt("cursor/checkpoint no coincide con el prefijo del origen"));
            }
            prefix_validated = true;
        }

        // Recupera el caso de caída después del COMMIT MLPJ y antes de guardar
        // el checkpoint: el destino puede contener exactamente un lote adicional.
        if recovery_remaining > 0 {
            let actual = target.get_project(project, table, id)?;
            if actual.as_deref() != Some(value) {
                return Err(BTreeError::Corrupt("el lote durable sin checkpoint difiere del origen"));
            }
            hash_record(&mut prefix_hash, project, table, id, value);
            prefix_records = prefix_records.checked_add(1)
                .ok_or(BTreeError::Invalid("contador del prefijo desbordado"))?;
            prefix_bytes = prefix_bytes.checked_add(record_bytes as u64)
                .ok_or(BTreeError::Invalid("bytes del prefijo desbordados"))?;
            recovery_bytes = recovery_bytes.checked_add(record_bytes as u64)
                .ok_or(BTreeError::Invalid("bytes del lote recuperado desbordados"))?;
            if recovery_bytes > manifest.batch_byte_budget {
                return Err(BTreeError::Corrupt("el lote durable sin checkpoint supera el presupuesto"));
            }
            recovery_last = Some(key);
            recovery_remaining -= 1;
            if recovery_remaining == 0 {
                persist_recovered_checkpoint(
                    manifests, &mut manifest, recovery_extra, &recovery_last,
                    &prefix_hash, prefix_records, prefix_bytes,
                )?;
                let recovered = usize::try_from(recovery_extra)
                    .map_err(|_| BTreeError::Invalid("contador de recuperación excede usize"))?;
                report.records_imported = report.records_imported.checked_add(recovered)
                    .ok_or(BTreeError::Invalid("contador de importación desbordado"))?;
                report.batches_committed = report.batches_committed.checked_add(1)
                    .ok_or(BTreeError::Invalid("contador de lotes desbordado"))?;
            }
            return Ok(());
        }

        if !batch.is_empty()
            && (batch.len() >= batch_size || batch_bytes.saturating_add(record_bytes) > MAX_SNAPSHOT_IMPORT_BATCH_BYTES)
        {
            commit_resumable_batch(
                target, manifests, &mut manifest, &mut batch, &mut report,
                &mut prefix_hash, &mut batch_last,
                &mut batch_bytes, prefix_records, prefix_bytes,
            )?;
        }

        batch.push(ProjectOperation::Put {
            project_id: project.to_owned(),
            table: table.to_owned(),
            record_id: id.to_owned(),
            value: value.to_vec(),
        });
        batch_bytes += record_bytes;
        hash_record(&mut prefix_hash, project, table, id, value);
        prefix_records = prefix_records.checked_add(1)
            .ok_or(BTreeError::Invalid("contador del prefijo desbordado"))?;
        prefix_bytes = prefix_bytes.checked_add(record_bytes as u64)
            .ok_or(BTreeError::Invalid("bytes del prefijo desbordados"))?;
        batch_last = Some(key);
        if batch.len() >= batch_size || batch_bytes == MAX_SNAPSHOT_IMPORT_BATCH_BYTES {
            commit_resumable_batch(
                target, manifests, &mut manifest, &mut batch, &mut report,
                &mut prefix_hash, &mut batch_last,
                &mut batch_bytes, prefix_records, prefix_bytes,
            )?;
        }
        Ok(())
    });

    match snapshot_result {
        Ok(()) => {}
        Err(StoreSnapshotError::RecoveryRequired) => return Err(SnapshotImportError::SourceRecoveryRequired),
        Err(StoreSnapshotError::Poisoned) => return Err(SnapshotImportError::SourcePoisoned),
        Err(StoreSnapshotError::Visitor(BTreeError::Corrupt("el prefijo ya importado difiere del origen"))) =>
            return Err(SnapshotImportError::ResumeMismatch("el prefijo ya importado contiene datos divergentes")),
        Err(StoreSnapshotError::Visitor(BTreeError::Corrupt("el cursor/checkpoint no coincide con el prefijo del origen"))) =>
            return Err(SnapshotImportError::ResumeMismatch("el cursor no coincide con el prefijo del origen")),
        Err(StoreSnapshotError::Visitor(BTreeError::Corrupt("el lote durable sin checkpoint difiere del origen"))) =>
            return Err(SnapshotImportError::ResumeMismatch("el lote durable pendiente no coincide con el origen")),
        Err(StoreSnapshotError::Visitor(BTreeError::Corrupt("el lote durable sin checkpoint supera el presupuesto"))) =>
            return Err(SnapshotImportError::ResumeMismatch("el lote durable pendiente supera el presupuesto configurado")),
        Err(StoreSnapshotError::Visitor(error)) => return Err(SnapshotImportError::Target(error)),
    }

    if !prefix_validated {
        if prefix_records != manifest.imported_records
            || prefix_last != resume_cursor
            || (manifest.imported_records > 0 && prefix_hash.finish() != manifest.prefix_hash)
        {
            return Err(SnapshotImportError::ResumeMismatch("el cursor no corresponde al prefijo importado"));
        }
        prefix_validated = true;
    }
    if recovery_remaining != 0 {
        return Err(SnapshotImportError::ResumeMismatch("el destino contiene registros extra que no existen en el origen"));
    }
    if !batch.is_empty() {
        commit_resumable_batch(
            target, manifests, &mut manifest, &mut batch, &mut report,
            &mut prefix_hash, &mut batch_last,
            &mut batch_bytes, prefix_records, prefix_bytes,
        ).map_err(SnapshotImportError::Target)?;
    }

    if seen_records != source_records || seen_bytes != source_bytes || full_hash.finish() != source_fingerprint {
        abort_manifest(manifests, &mut manifest);
        return Err(SnapshotImportError::SourceChanged);
    }
    if prefix_records != source_records || prefix_bytes != source_bytes
        || prefix_hash.finish() != source_fingerprint
    {
        return Err(SnapshotImportError::ResumeMismatch("el prefijo final no cubre el snapshot completo"));
    }
    let final_validation = target.validate().map_err(SnapshotImportError::Target)?;
    if final_validation.entries != source_records {
        return Err(SnapshotImportError::ResumeMismatch("el recuento final del destino no coincide"));
    }
    manifest = manifests.current().unwrap().clone();
    manifest.transition(MigrationState::ImportComplete).map_err(SnapshotImportError::Manifest)?;
    manifests.save(manifest).map_err(SnapshotImportError::Manifest)?;
    report.destination = final_validation;
    Ok(report)
}




/// Resultado de la comparación integral e independiente origen/destino.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotVerificationReport {
    pub records_verified: u64,
    pub logical_bytes_verified: u64,
    pub fingerprint: [u8; 32],
    pub destination: ValidationReport,
}

/// Verifica de forma independiente todos los registros antes de permitir publicar.
///
/// Recorre origen y destino en orden global de clave, compara identidades y bytes
/// exactamente y comprueba que no falten ni sobren registros. La verificación
/// es incremental y no materializa ninguno de los dos almacenes completos.
pub fn verify_legacy_snapshot_migration(
    source: &Store,
    target: &mut ProjectStore,
    manifests: &mut ManifestStore,
) -> Result<SnapshotVerificationReport, SnapshotImportError> {
    let mut manifest = manifests.current().cloned()
        .ok_or(SnapshotImportError::ResumeMismatch("no existe manifiesto para verificar"))?;
    let actual_source_path = source.path().map_err(|_| SnapshotImportError::SourcePoisoned)?;
    if manifest.source_path != actual_source_path.to_string_lossy().as_ref() {
        return Err(SnapshotImportError::ResumeMismatch("la ruta del origen no coincide con el manifiesto"));
    }
    if manifest.destination_path != target.paths().0.to_string_lossy().as_ref() {
        return Err(SnapshotImportError::ResumeMismatch("la ruta de páginas del destino no coincide con el manifiesto"));
    }
    match manifest.state {
        MigrationState::ImportComplete => {
            manifest.transition(MigrationState::Verifying).map_err(SnapshotImportError::Manifest)?;
            manifests.save(manifest.clone()).map_err(SnapshotImportError::Manifest)?;
        }
        MigrationState::Verifying => {}
        _ => return Err(SnapshotImportError::ResumeMismatch("la migración debe estar ImportComplete o Verifying")),
    }

    let destination_validation = target.validate().map_err(SnapshotImportError::Target)?;
    if destination_validation.entries as u64 != manifest.imported_records
        || manifest.imported_records != manifest.source_records
        || manifest.imported_logical_bytes != manifest.source_logical_bytes
    {
        return Err(SnapshotImportError::VerificationMismatch(
            "los contadores del destino/manifiesto no coinciden",
        ));
    }

    let mut destination_iter = target.scan_all_iter().map_err(SnapshotImportError::Target)?;
    let mut source_hash = Sha256::new();
    let mut verified_records = 0u64;
    let mut verified_bytes = 0u64;

    let scan = source.visit_records(|project, table, id, value| {
        let (target_project, target_table, target_id, target_value) =
            match destination_iter.next() {
                Some(Ok(record)) => record,
                Some(Err(error)) => return Err(error),
                None => return Err(BTreeError::Corrupt("faltan registros en el destino")),
            };
        if target_project != project || target_table != table || target_id != id {
            return Err(BTreeError::Corrupt("las identidades o el orden de claves difieren"));
        }
        if target_value.as_slice() != value {
            return Err(BTreeError::Corrupt("los bytes de un registro difieren"));
        }
        hash_record(&mut source_hash, project, table, id, value);
        verified_records = verified_records.checked_add(1)
            .ok_or(BTreeError::Invalid("contador de verificación desbordado"))?;
        verified_bytes = verified_bytes.checked_add(logical_record_bytes(project, table, id, value)? as u64)
            .ok_or(BTreeError::Invalid("bytes de verificación desbordados"))?;
        Ok::<(), BTreeError>(())
    });

    match scan {
        Ok(()) => {}
        Err(StoreSnapshotError::RecoveryRequired) => return Err(SnapshotImportError::SourceRecoveryRequired),
        Err(StoreSnapshotError::Poisoned) => return Err(SnapshotImportError::SourcePoisoned),
        Err(StoreSnapshotError::Visitor(BTreeError::Corrupt("faltan registros en el destino"))) =>
            return Err(SnapshotImportError::VerificationMismatch("faltan registros en el destino")),
        Err(StoreSnapshotError::Visitor(BTreeError::Corrupt("las identidades o el orden de claves difieren"))) =>
            return Err(SnapshotImportError::VerificationMismatch("las identidades o el orden de claves difieren")),
        Err(StoreSnapshotError::Visitor(BTreeError::Corrupt("los bytes de un registro difieren"))) =>
            return Err(SnapshotImportError::VerificationMismatch("los bytes de un registro difieren")),
        Err(StoreSnapshotError::Visitor(error)) => return Err(SnapshotImportError::Target(error)),
    }

    match destination_iter.next() {
        None => {}
        Some(Ok(_)) => return Err(SnapshotImportError::VerificationMismatch("el destino contiene registros adicionales")),
        Some(Err(error)) => return Err(SnapshotImportError::Target(error)),
    }
    drop(destination_iter);

    let fingerprint = source_hash.finish();
    if verified_records != manifest.source_records
        || verified_bytes != manifest.source_logical_bytes
        || fingerprint != manifest.source_hash
    {
        return Err(SnapshotImportError::VerificationMismatch(
            "el origen cambió o no coincide con el snapshot registrado",
        ));
    }
    if destination_validation.entries as u64 != verified_records {
        return Err(SnapshotImportError::VerificationMismatch(
            "el recuento validado del destino difiere del recorrido",
        ));
    }

    manifest = manifests.current().cloned()
        .ok_or(SnapshotImportError::ResumeMismatch("manifiesto desaparecido durante la verificación"))?;
    manifest.transition(MigrationState::Verified).map_err(SnapshotImportError::Manifest)?;
    manifests.save(manifest).map_err(SnapshotImportError::Manifest)?;

    Ok(SnapshotVerificationReport {
        records_verified: verified_records,
        logical_bytes_verified: verified_bytes,
        fingerprint,
        destination: destination_validation,
    })
}

/// Resultado de publicar una generación ya verificada.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotPublicationReport {
    pub pointer: PublicationPointer,
    pub records_verified: u64,
    pub logical_bytes_verified: u64,
    pub fingerprint: [u8; 32],
    pub destination: ValidationReport,
}

/// Copia un ProjectStore verificado a una generación inmutable y publica el
/// selector solo después de reabrir la copia y compararla íntegramente con el
/// origen. Conserva intactos los archivos temporales originales.
pub fn publish_verified_legacy_snapshot(
    source: &Store,
    staging: &mut ProjectStore,
    manifests: &mut ManifestStore,
    publication: &mut PublicationStore,
) -> Result<SnapshotPublicationReport, SnapshotImportError> {
    let manifest = manifests.current().cloned()
        .ok_or(SnapshotImportError::ResumeMismatch("no existe manifiesto para publicar"))?;
    let source_path = source.path().map_err(|_| SnapshotImportError::SourcePoisoned)?;
    if manifest.source_path != source_path.to_string_lossy().as_ref() {
        return Err(SnapshotImportError::ResumeMismatch("la ruta del origen no coincide con el manifiesto"));
    }
    let source_snapshot = source.snapshot().map_err(map_snapshot_guard_error)?;
    let (staging_pages, staging_wal) = staging.paths();
    let staging_pages = staging_pages.to_path_buf();
    let staging_wal = staging_wal.to_path_buf();
    if manifest.destination_path != staging_pages.to_string_lossy().as_ref() {
        return Err(SnapshotImportError::ResumeMismatch("la ruta del destino temporal no coincide con el manifiesto"));
    }
    if !matches!(manifest.state, MigrationState::Verified | MigrationState::Published) {
        return Err(SnapshotImportError::ResumeMismatch("solo se puede publicar una migración verificada o reconciliar una publicada"));
    }

    if let Some(current) = publication.current() {
        if current.migration_id == manifest.migration_id {
            let mut published=publication.open_project_store_for_pointer(current)
                .map_err(map_published_store_open_error)?;
            let (records, bytes, fingerprint, destination) =
                verify_source_against_project_store(&source_snapshot, published.as_mut_project_store())?;
            ensure_publication_matches_manifest(&manifest, records, bytes, fingerprint)?;
            if manifest.state == MigrationState::Verified {
                let mut next = manifests.current().cloned()
                    .ok_or(SnapshotImportError::ResumeMismatch("manifiesto desaparecido al reconciliar publicación"))?;
                next.transition(MigrationState::Published).map_err(SnapshotImportError::Manifest)?;
                manifests.save(next).map_err(SnapshotImportError::Manifest)?;
            }
            return Ok(SnapshotPublicationReport {
                pointer: current.clone(),
                records_verified: records,
                logical_bytes_verified: bytes,
                fingerprint,
                destination,
            });
        }
    }
    if manifest.state == MigrationState::Published {
        return Err(SnapshotImportError::ResumeMismatch("el manifiesto Published no coincide con el selector activo"));
    }

    staging.checkpoint().map_err(SnapshotImportError::Target)?;
    staging.validate().map_err(SnapshotImportError::Target)?;

    let next_generation = publication.current()
        .map(|current| current.generation.checked_add(1)
            .ok_or(SnapshotImportError::ResumeMismatch("contador de generaciones agotado")))
        .transpose()?
        .unwrap_or(1);
    let pointer = PublicationPointer::new(next_generation, manifest.migration_id)
        .map_err(SnapshotImportError::Publication)?;
    let generations_dir = publication.root().join("generations");
    fs::create_dir_all(&generations_dir)
        .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
    ensure_publication_directory(&generations_dir)?;
    let generation_dir = generations_dir.join(&pointer.generation_dir);
    prepare_unpublished_generation_directory(&generation_dir)?;

    let final_pages = generation_dir.join("store.pages");
    let final_wal = generation_dir.join("store.mlpj");
    let temp_pages = generation_dir.join("store.pages.tmp");
    let temp_wal = generation_dir.join("store.mlpj.tmp");
    let pages_digest = copy_file_synced(&staging_pages, &temp_pages)?;
    let wal_digest = copy_file_synced(&staging_wal, &temp_wal)?;
    fs::rename(&temp_pages, &final_pages)
        .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
    fs::rename(&temp_wal, &final_wal)
        .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
    GenerationReceipt::write(&generation_dir, &pointer, pages_digest, wal_digest)
        .map_err(SnapshotImportError::Publication)?;
    sync_publication_directory(&generation_dir)?;
    sync_publication_directory(&generations_dir)?;

    let mut published = ProjectStore::open(&final_pages, &final_wal)
        .map_err(SnapshotImportError::Target)?;
    let (records, bytes, fingerprint, destination) =
        verify_source_against_project_store(&source_snapshot, &mut published)?;
    ensure_publication_matches_manifest(&manifest, records, bytes, fingerprint)?;

    // Mantener los bloqueos de la generación copiada hasta que el selector y
    // el manifiesto Published queden persistidos.
    publication.publish(pointer.clone()).map_err(SnapshotImportError::Publication)?;
    let mut next = manifests.current().cloned()
        .ok_or(SnapshotImportError::ResumeMismatch("manifiesto desaparecido después de publicar selector"))?;
    next.transition(MigrationState::Published).map_err(SnapshotImportError::Manifest)?;
    manifests.save(next).map_err(SnapshotImportError::Manifest)?;

    Ok(SnapshotPublicationReport {
        pointer,
        records_verified: records,
        logical_bytes_verified: bytes,
        fingerprint,
        destination,
    })
}

/// Reconciliación del crash posterior al selector y anterior al checkpoint
/// Published. Solo actualiza el manifiesto después de verificar la generación
/// seleccionada contra el WAL legado.
pub fn reconcile_legacy_snapshot_publication(
    source: &Store,
    manifests: &mut ManifestStore,
    publication: &PublicationStore,
) -> Result<Option<SnapshotPublicationReport>, SnapshotImportError> {
    let manifest = manifests.current().cloned()
        .ok_or(SnapshotImportError::ResumeMismatch("no existe manifiesto para reconciliar"))?;
    let source_path = source.path().map_err(|_| SnapshotImportError::SourcePoisoned)?;
    if manifest.source_path != source_path.to_string_lossy().as_ref() {
        return Err(SnapshotImportError::ResumeMismatch("la ruta del origen no coincide con el manifiesto"));
    }
    let source_snapshot = source.snapshot().map_err(map_snapshot_guard_error)?;
    let Some(pointer) = publication.current() else {
        if manifest.state == MigrationState::Published {
            return Err(SnapshotImportError::ResumeMismatch("manifiesto Published sin selector activo"));
        }
        return Ok(None);
    };
    if pointer.migration_id != manifest.migration_id {
        if manifest.state == MigrationState::Published {
            return Err(SnapshotImportError::ResumeMismatch("manifiesto Published no coincide con selector activo"));
        }
        return Ok(None);
    }
    if !matches!(manifest.state, MigrationState::Verified | MigrationState::Published) {
        return Err(SnapshotImportError::ResumeMismatch("selector apunta a una migración cuyo manifiesto no está verificado"));
    }
    let mut published=publication.open_project_store_for_pointer(pointer)
        .map_err(map_published_store_open_error)?;
    let (records, bytes, fingerprint, destination) =
        verify_source_against_project_store(&source_snapshot, published.as_mut_project_store())?;
    ensure_publication_matches_manifest(&manifest, records, bytes, fingerprint)?;
    if manifest.state == MigrationState::Verified {
        let mut next = manifests.current().cloned()
            .ok_or(SnapshotImportError::ResumeMismatch("manifiesto desaparecido durante reconciliación"))?;
        next.transition(MigrationState::Published).map_err(SnapshotImportError::Manifest)?;
        manifests.save(next).map_err(SnapshotImportError::Manifest)?;
    }
    Ok(Some(SnapshotPublicationReport {
        pointer: pointer.clone(),
        records_verified: records,
        logical_bytes_verified: bytes,
        fingerprint,
        destination,
    }))
}


fn map_snapshot_guard_error(error: StoreError) -> SnapshotImportError {
    match error {
        StoreError::RecoveryRequired => SnapshotImportError::SourceRecoveryRequired,
        StoreError::Poisoned => SnapshotImportError::SourcePoisoned,
        _ => SnapshotImportError::SourcePoisoned,
    }
}

fn ensure_publication_matches_manifest(
    manifest: &MigrationManifest,
    records: u64,
    logical_bytes: u64,
    fingerprint: [u8; 32],
) -> Result<(), SnapshotImportError> {
    if records != manifest.source_records
        || logical_bytes != manifest.source_logical_bytes
        || fingerprint != manifest.source_hash
    {
        return Err(SnapshotImportError::VerificationMismatch(
            "la generación no coincide con el fingerprint y contadores del manifiesto Verified",
        ));
    }
    Ok(())
}

fn prepare_unpublished_generation_directory(path: &Path) -> Result<(), SnapshotImportError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path)
                .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
            return Ok(());
        }
        Err(error) => return Err(SnapshotImportError::Publication(PublicationError::Io(error.to_string()))),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() =>
            return Err(SnapshotImportError::Publication(PublicationError::Invalid("directorio huérfano no es regular"))),
        Ok(_) => {}
    }

    let pages = path.join("store.pages");
    let wal = path.join("store.mlpj");
    let _locks = InterprocessLock::acquire_many(&[pages.as_path(), wal.as_path()])
        .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;

    for entry in fs::read_dir(path)
        .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?
    {
        let entry = entry.map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let is_data = name == "store.pages.tmp" || name == "store.mlpj.tmp"
            || name == "store.pages" || name == "store.mlpj"
            || name == "GENERATION.MANIFEST.tmp" || name == "GENERATION.MANIFEST";
        let is_lock = name == "store.pages.mldb-lock" || name == "store.mlpj.mldb-lock";
        if !is_data && !is_lock {
            return Err(SnapshotImportError::Publication(PublicationError::Invalid("directorio huérfano contiene elementos inesperados")));
        }
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(SnapshotImportError::Publication(PublicationError::Invalid("elemento huérfano no es archivo regular")));
        }
        // Los lockfiles son persistentes por diseño y nunca se eliminan.
        if is_data {
            fs::remove_file(entry.path())
                .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
        }
    }
    sync_publication_directory(path)?;
    Ok(())
}

fn verify_source_against_project_store(
    source: &StoreSnapshot<'_>,
    target: &mut ProjectStore,
) -> Result<(u64, u64, [u8; 32], ValidationReport), SnapshotImportError> {
    let destination = target.validate().map_err(SnapshotImportError::Target)?;
    let mut target_iter = target.scan_all_iter().map_err(SnapshotImportError::Target)?;
    let mut hash = Sha256::new();
    let mut records = 0u64;
    let mut logical_bytes = 0u64;
    for (project, table, id, value) in source.iter() {
        let (target_project, target_table, target_id, target_value) = match target_iter.next() {
            Some(Ok(record)) => record,
            Some(Err(error)) => return Err(SnapshotImportError::Target(error)),
            None => return Err(SnapshotImportError::VerificationMismatch("faltan registros en la generación publicada")),
        };
        if target_project != project || target_table != table || target_id != id {
            return Err(SnapshotImportError::VerificationMismatch("identidades distintas en la generación publicada"));
        }
        if target_value.as_slice() != value {
            return Err(SnapshotImportError::VerificationMismatch("bytes distintos en la generación publicada"));
        }
        hash_record(&mut hash, project, table, id, value);
        records = records.checked_add(1)
            .ok_or(SnapshotImportError::VerificationMismatch("contador de publicación desbordado"))?;
        logical_bytes = logical_bytes.checked_add(logical_record_bytes(project, table, id, value)
            .map_err(SnapshotImportError::Target)? as u64)
            .ok_or(SnapshotImportError::VerificationMismatch("bytes de publicación desbordados"))?;
    }
    match target_iter.next() {
        None => {}
        Some(Ok(_)) => return Err(SnapshotImportError::VerificationMismatch("hay registros adicionales en la generación publicada")),
        Some(Err(error)) => return Err(SnapshotImportError::Target(error)),
    }
    if destination.entries as u64 != records {
        return Err(SnapshotImportError::VerificationMismatch("el recuento validado no coincide con la generación publicada"));
    }
    Ok((records, logical_bytes, hash.finish(), destination))
}

fn copy_file_synced(source: &Path, destination: &Path) -> Result<FileDigest, SnapshotImportError> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(SnapshotImportError::Publication(PublicationError::Invalid("archivo temporal no es regular")));
    }
    let mut input = File::open(source)
        .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
    if !input.metadata()
        .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?
        .is_file()
    {
        return Err(SnapshotImportError::Publication(PublicationError::Invalid("origen de copia no es archivo regular")));
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(destination)
        .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
    let mut buffer = [0u8; 64 * 1024];
    let mut source_hash = Sha256::new();
    let mut length = 0u64;
    loop {
        let count = input.read(&mut buffer)
            .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
        if count == 0 { break; }
        source_hash.update(&buffer[..count]);
        length = length.checked_add(count as u64)
            .ok_or(SnapshotImportError::VerificationMismatch("tamaño de archivo desbordado"))?;
        output.write_all(&buffer[..count])
            .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
    }
    output.sync_all()
        .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
    drop(output);
    let expected = FileDigest { length, sha256: source_hash.finish() };
    if expected != hash_file(destination)? {
        return Err(SnapshotImportError::Publication(PublicationError::ChecksumMismatch));
    }
    Ok(expected)
}

fn hash_file(path: &Path) -> Result<FileDigest, SnapshotImportError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(SnapshotImportError::Publication(PublicationError::Invalid("archivo copiado no es regular")));
    }
    let mut file = File::open(path)
        .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
    let mut hash = Sha256::new();
    let mut length = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)
            .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
        if count == 0 { break; }
        hash.update(&buffer[..count]);
        length = length.checked_add(count as u64)
            .ok_or(SnapshotImportError::VerificationMismatch("tamaño de archivo desbordado"))?;
    }
    Ok(FileDigest { length, sha256: hash.finish() })
}

fn ensure_publication_directory(path: &Path) -> Result<(), SnapshotImportError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(SnapshotImportError::Publication(PublicationError::Invalid("directorio de generaciones no es regular")));
    }
    Ok(())
}

fn sync_publication_directory(path: &Path) -> Result<(), SnapshotImportError> {
    #[cfg(unix)]
    {
        File::open(path).and_then(|directory| directory.sync_all())
            .map_err(|error| SnapshotImportError::Publication(PublicationError::Io(error.to_string())))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn abort_manifest(manifests: &mut ManifestStore, manifest: &mut MigrationManifest) {
    if matches!(manifest.state, MigrationState::Created | MigrationState::SourceScanned | MigrationState::Importing | MigrationState::ImportComplete | MigrationState::Verifying | MigrationState::Verified) {
        if manifest.transition(MigrationState::Aborted).is_ok() {
            let _ = manifests.save(manifest.clone());
        }
    }
}

fn persist_recovered_checkpoint(
    manifests: &mut ManifestStore,
    manifest: &mut MigrationManifest,
    recovered_records: u64,
    last_key: &Option<(String, String, String)>,
    prefix_hash: &Sha256,
    prefix_records: u64,
    prefix_bytes: u64,
) -> Result<(), BTreeError> {
    let key = last_key.as_ref().ok_or(BTreeError::Corrupt("recuperación sin cursor final"))?;
    let mut next = manifests.current().ok_or(BTreeError::Corrupt("manifiesto desaparecido"))?.clone();
    next.transition(MigrationState::Importing)
        .map_err(|_| BTreeError::Corrupt("transición de recuperación inválida"))?;
    next.last_batch_sequence = next.last_batch_sequence.checked_add(1)
        .ok_or(BTreeError::Invalid("secuencia de lote agotada"))?;
    next.last_batch_records = recovered_records;
    next.imported_records = prefix_records;
    next.imported_logical_bytes = prefix_bytes;
    next.cursor = encode_cursor(key).map_err(|_| BTreeError::Invalid("cursor de migración demasiado largo"))?;
    next.prefix_hash = prefix_hash.finish();
    manifests.save(next.clone())
        .map_err(|_| BTreeError::Corrupt("no se pudo persistir checkpoint recuperado"))?;
    *manifest = next;
    Ok(())
}

fn commit_resumable_batch(
    target: &mut ProjectStore,
    manifests: &mut ManifestStore,
    manifest: &mut MigrationManifest,
    batch: &mut Vec<ProjectOperation>,
    report: &mut SnapshotImportReport,
    prefix_hash: &mut Sha256,
    batch_last: &mut Option<(String, String, String)>,
    batch_bytes: &mut usize,
    prefix_records: u64,
    prefix_bytes: u64,
) -> Result<(), BTreeError> {
    if batch.is_empty() { return Ok(()); }
    let operations = std::mem::replace(batch, Vec::with_capacity(manifest.batch_size as usize));
    let count = operations.len() as u64;
    apply_batch_and_verify(target, operations)?;
    let last = batch_last.take().ok_or(BTreeError::Corrupt("lote sin cursor final"))?;
    let mut next = manifests.current().ok_or(BTreeError::Corrupt("manifiesto desaparecido"))?.clone();
    next.transition(MigrationState::Importing)
        .map_err(|_| BTreeError::Corrupt("transición de checkpoint inválida"))?;
    next.last_batch_sequence = next.last_batch_sequence.checked_add(1)
        .ok_or(BTreeError::Invalid("secuencia de lote agotada"))?;
    next.last_batch_records = count;
    next.imported_records = prefix_records;
    next.imported_logical_bytes = prefix_bytes;
    next.cursor = encode_cursor(&last).map_err(|_| BTreeError::Invalid("cursor de migración demasiado largo"))?;
    next.prefix_hash = prefix_hash.finish();
    manifests.save(next.clone())
        .map_err(|_| BTreeError::Corrupt("no se pudo persistir checkpoint del lote"))?;
    *manifest = next;
    *batch_bytes = 0;
    let committed = usize::try_from(count)
        .map_err(|_| BTreeError::Invalid("contador del lote excede usize"))?;
    report.records_imported = report.records_imported.checked_add(committed)
        .ok_or(BTreeError::Invalid("contador de importación desbordado"))?;
    report.batches_committed = report.batches_committed.checked_add(1)
        .ok_or(BTreeError::Invalid("contador de lotes desbordado"))?;
    Ok(())
}

fn map_snapshot_error(error: StoreSnapshotError<BTreeError>) -> SnapshotImportError {
    match error {
        StoreSnapshotError::RecoveryRequired => SnapshotImportError::SourceRecoveryRequired,
        StoreSnapshotError::Poisoned => SnapshotImportError::SourcePoisoned,
        StoreSnapshotError::Visitor(error) => SnapshotImportError::Target(error),
    }
}

fn logical_record_bytes(project: &str, table: &str, id: &str, value: &[u8]) -> Result<usize, BTreeError> {
    project.len().checked_add(table.len()).and_then(|n| n.checked_add(id.len()))
        .and_then(|n| n.checked_add(value.len()))
        .ok_or(BTreeError::Invalid("tamaño de registro desbordado"))
}

fn encode_cursor(key: &(String, String, String)) -> Result<Vec<u8>, ManifestError> {
    let mut out = Vec::new();
    for part in [&key.0, &key.1, &key.2] {
        let len = u32::try_from(part.len()).map_err(|_| ManifestError::Invalid("cursor demasiado largo"))?;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(part.as_bytes());
    }
    if out.len() > crate::migration_manifest::MAX_CURSOR_BYTES {
        return Err(ManifestError::Invalid("cursor demasiado largo"));
    }
    Ok(out)
}

fn decode_cursor(bytes: &[u8]) -> Result<Option<(String, String, String)>, SnapshotImportError> {
    if bytes.is_empty() { return Ok(None); }
    let mut at = 0usize;
    let mut parts = Vec::with_capacity(3);
    for _ in 0..3 {
        if at + 4 > bytes.len() { return Err(SnapshotImportError::ResumeMismatch("cursor truncado")); }
        let len = u32::from_le_bytes(bytes[at..at+4].try_into().unwrap()) as usize;
        at += 4;
        let end = at.checked_add(len).ok_or(SnapshotImportError::ResumeMismatch("cursor desbordado"))?;
        if end > bytes.len() { return Err(SnapshotImportError::ResumeMismatch("cursor truncado")); }
        parts.push(String::from_utf8(bytes[at..end].to_vec())
            .map_err(|_| SnapshotImportError::ResumeMismatch("cursor no UTF-8"))?);
        at = end;
    }
    if at != bytes.len() { return Err(SnapshotImportError::ResumeMismatch("cursor con bytes sobrantes")); }
    Ok(Some((parts.remove(0), parts.remove(0), parts.remove(0))))
}

#[derive(Clone)]
pub(crate) struct Sha256 {
    state: [u32; 8],
    buffer: [u8; 64],
    buffer_len: usize,
    total_len: u64,
}

impl Sha256 {
    pub(crate) fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
            ],
            buffer: [0; 64],
            buffer_len: 0,
            total_len: 0,
        }
    }

    pub(crate) fn update(&mut self, mut bytes: &[u8]) {
        self.total_len = self.total_len.wrapping_add(bytes.len() as u64);
        if self.buffer_len > 0 {
            let take = (64 - self.buffer_len).min(bytes.len());
            self.buffer[self.buffer_len..self.buffer_len + take].copy_from_slice(&bytes[..take]);
            self.buffer_len += take;
            bytes = &bytes[take..];
            if self.buffer_len == 64 {
                sha256_compress(&mut self.state, &self.buffer);
                self.buffer_len = 0;
            }
        }
        while bytes.len() >= 64 {
            let block: &[u8; 64] = bytes[..64].try_into().unwrap();
            sha256_compress(&mut self.state, block);
            bytes = &bytes[64..];
        }
        if !bytes.is_empty() {
            self.buffer[..bytes.len()].copy_from_slice(bytes);
            self.buffer_len = bytes.len();
        }
    }

    pub(crate) fn finish(&self) -> [u8; 32] {
        let mut finalizer = self.clone();
        let bit_len = finalizer.total_len.wrapping_mul(8);
        finalizer.buffer[finalizer.buffer_len] = 0x80;
        finalizer.buffer_len += 1;
        if finalizer.buffer_len > 56 {
            finalizer.buffer[finalizer.buffer_len..].fill(0);
            sha256_compress(&mut finalizer.state, &finalizer.buffer);
            finalizer.buffer = [0; 64];
            finalizer.buffer_len = 0;
        }
        finalizer.buffer[finalizer.buffer_len..56].fill(0);
        finalizer.buffer[56..64].copy_from_slice(&bit_len.to_be_bytes());
        sha256_compress(&mut finalizer.state, &finalizer.buffer);

        let mut output = [0u8; 32];
        for (index, word) in finalizer.state.iter().enumerate() {
            output[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        output
    }
}

fn sha256_compress(state: &mut [u32; 8], block: &[u8; 64]) {
    const K: [u32; 64] = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ];
    let mut words = [0u32; 64];
    for (index, chunk) in block.chunks_exact(4).enumerate() {
        words[index] = u32::from_be_bytes(chunk.try_into().unwrap());
    }
    for index in 16..64 {
        let x = words[index - 15];
        let y = words[index - 2];
        let s0 = x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3);
        let s1 = y.rotate_right(17) ^ y.rotate_right(19) ^ (y >> 10);
        words[index] = words[index - 16]
            .wrapping_add(s0)
            .wrapping_add(words[index - 7])
            .wrapping_add(s1);
    }

    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
    for index in 0..64 {
        let sum1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let choose = (e & f) ^ ((!e) & g);
        let temp1 = h
            .wrapping_add(sum1)
            .wrapping_add(choose)
            .wrapping_add(K[index])
            .wrapping_add(words[index]);
        let sum0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let majority = (a & b) ^ (a & c) ^ (b & c);
        let temp2 = sum0.wrapping_add(majority);
        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(temp1);
        d = c;
        c = b;
        b = a;
        a = temp1.wrapping_add(temp2);
    }
    state[0] = state[0].wrapping_add(a);
    state[1] = state[1].wrapping_add(b);
    state[2] = state[2].wrapping_add(c);
    state[3] = state[3].wrapping_add(d);
    state[4] = state[4].wrapping_add(e);
    state[5] = state[5].wrapping_add(f);
    state[6] = state[6].wrapping_add(g);
    state[7] = state[7].wrapping_add(h);
}

fn hash_record(hash: &mut Sha256, project: &str, table: &str, id: &str, value: &[u8]) {
    for part in [project.as_bytes(), table.as_bytes(), id.as_bytes(), value] {
        hash.update(&(part.len() as u64).to_le_bytes());
        hash.update(part);
    }
}


#[cfg(test)]
mod resumable_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("mldb-{label}-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn initial_manifest(source: &std::path::Path, destination: &std::path::Path) -> MigrationManifest {
        MigrationManifest {
            generation: 1,
            migration_id: [0x51; 16],
            state: MigrationState::Created,
            source_path: source.to_string_lossy().into_owned(),
            destination_path: destination.to_string_lossy().into_owned(),
            source_format_version: 1,
            destination_format_version: 1,
            source_hash: [0; 32],
            source_records: 0,
            source_logical_bytes: 0,
            batch_size: 2,
            batch_byte_budget: MAX_SNAPSHOT_IMPORT_BATCH_BYTES as u64,
            last_batch_sequence: 0,
            last_batch_records: 0,
            imported_records: 0,
            imported_logical_bytes: 0,
            cursor: Vec::new(),
            prefix_hash: [0; 32],
        }
    }

    #[test]
    fn resumable_import_checkpoints_every_batch_and_reopens_complete_manifest() {
        let root = test_dir("resumable");
        let source_path = root.join("legacy.wal");
        let pages_path = root.join("new.pages");
        let page_wal_path = root.join("new.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        for index in 0..5 {
            source.put_project("project-a", "entities", &format!("id-{index}"), format!("value-{index}").as_bytes()).unwrap();
        }
        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        let report = import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 2,
        ).unwrap();
        assert_eq!(report.records_imported, 5);
        assert_eq!(report.batches_committed, 3);
        assert_eq!(report.destination.entries, 5);
        let completed = manifests.current().unwrap();
        assert_eq!(completed.state, MigrationState::ImportComplete);
        assert_eq!(completed.imported_records, 5);
        assert_eq!(completed.last_batch_sequence, 3);
        for index in 0..5 {
            assert_eq!(
                target.get_project("project-a", "entities", &format!("id-{index}")).unwrap(),
                Some(format!("value-{index}").into_bytes())
            );
        }
        drop(manifests);
        let reopened = ManifestStore::open(&manifest_path).unwrap();
        assert_eq!(reopened.current().unwrap().state, MigrationState::ImportComplete);
        drop(reopened);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resumable_migration_preserves_identical_record_ids_across_project_scopes() {
        let root = test_dir("resumable-project-isolation");
        let source_path = root.join("legacy.wal");
        let pages_path = root.join("new.pages");
        let page_wal_path = root.join("new.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();

        // La identidad del registro no es global: proyecto y tabla forman
        // parte de la clave y deben sobrevivir a la migración sin colisiones.
        source.put_project("novel-A", "entities", "character-1", b"Alice").unwrap();
        source.put_project("novel-B", "entities", "character-1", b"Bruno").unwrap();
        source.put_project("novel-A", "events", "character-1", b"arrival-A").unwrap();
        source.put_project("novel-B", "events", "character-1", b"arrival-B").unwrap();

        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        let imported = import_legacy_snapshot_resumable(
            &source,
            &mut target,
            &mut manifests,
            initial_manifest(&source_path, &pages_path),
            2,
        ).unwrap();

        assert_eq!(imported.records_imported, 4);
        assert_eq!(imported.destination.entries, 4);
        assert_eq!(target.get_project("novel-A", "entities", "character-1").unwrap(), Some(b"Alice".to_vec()));
        assert_eq!(target.get_project("novel-B", "entities", "character-1").unwrap(), Some(b"Bruno".to_vec()));
        assert_eq!(target.get_project("novel-A", "events", "character-1").unwrap(), Some(b"arrival-A".to_vec()));
        assert_eq!(target.get_project("novel-B", "events", "character-1").unwrap(), Some(b"arrival-B".to_vec()));

        let verified = verify_legacy_snapshot_migration(&source, &mut target, &mut manifests).unwrap();
        assert_eq!(verified.records_verified, 4);
        assert_eq!(manifests.current().unwrap().state, MigrationState::Verified);
        drop(manifests);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resumable_import_handles_empty_source_without_creating_empty_batches() {
        let root = test_dir("resumable-empty");
        let source_path = root.join("legacy.wal");
        let pages_path = root.join("new.pages");
        let page_wal_path = root.join("new.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        let report = import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 4,
        ).unwrap();
        assert_eq!(report.records_imported, 0);
        assert_eq!(report.batches_committed, 0);
        assert_eq!(report.destination.entries, 0);
        assert_eq!(manifests.current().unwrap().state, MigrationState::ImportComplete);
        drop(manifests);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resumable_import_refuses_destination_that_disagrees_with_checkpoint_count() {
        let root = test_dir("resumable-mismatch");
        let source_path = root.join("legacy.wal");
        let pages_path = root.join("new.pages");
        let page_wal_path = root.join("new.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        source.put_project("p", "t", "a", b"one").unwrap();
        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        target.put_project("p", "t", "unexpected", b"extra").unwrap();
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        let result = import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 2,
        );
        assert!(matches!(result, Err(SnapshotImportError::ResumeMismatch(_))));
        drop(manifests);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn resumable_import_recovers_commit_that_preceded_manifest_checkpoint() {
        let root = test_dir("resumable-crash-gap");
        let source_path = root.join("legacy.wal");
        let pages_path = root.join("new.pages");
        let page_wal_path = root.join("new.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        for index in 0..3 {
            source.put_project("p", "t", &format!("id-{index}"), format!("value-{index}").as_bytes()).unwrap();
        }
        let mut full = Sha256::new();
        let mut source_records = 0u64;
        let mut source_bytes = 0u64;
        source.visit_records(|project, table, id, value| {
            hash_record(&mut full, project, table, id, value);
            source_records += 1;
            source_bytes += logical_record_bytes(project, table, id, value).unwrap() as u64;
            Ok::<(), BTreeError>(())
        }).unwrap();

        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        target.put_project("p", "t", "id-0", b"value-0").unwrap();
        target.put_project("p", "t", "id-1", b"value-1").unwrap();
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        let mut initial = initial_manifest(&source_path, &pages_path);
        initial.source_records = source_records;
        initial.source_logical_bytes = source_bytes;
        manifests.create(initial.clone()).unwrap();
        initial.transition(MigrationState::SourceScanned).unwrap();
        initial.source_hash = full.finish();
        manifests.save(initial.clone()).unwrap();
        initial.transition(MigrationState::Importing).unwrap();
        manifests.save(initial.clone()).unwrap();

        // Simula un reinicio real: el lote MLPJ existe, pero el manifiesto
        // todavía conserva el checkpoint anterior.
        drop(manifests);
        drop(target);
        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();

        let report = import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 2,
        ).unwrap();
        assert_eq!(report.destination.entries, 3);
        assert_eq!(manifests.current().unwrap().state, MigrationState::ImportComplete);
        assert_eq!(manifests.current().unwrap().imported_records, 3);
        assert_eq!(manifests.current().unwrap().last_batch_sequence, 2);
        assert_eq!(target.get_project("p", "t", "id-2").unwrap(), Some(b"value-2".to_vec()));
        drop(manifests);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resumable_import_rejects_cursor_that_is_not_the_last_key_of_its_prefix() {
        let root = test_dir("resumable-invalid-cursor");
        let source_path = root.join("legacy.wal");
        let pages_path = root.join("new.pages");
        let page_wal_path = root.join("new.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        source.put_project("p", "t", "id-0", b"value-0").unwrap();

        let mut source_hash = Sha256::new();
        source.visit_records(|project, table, id, value| {
            hash_record(&mut source_hash, project, table, id, value);
            Ok::<(), BTreeError>(())
        }).unwrap();
        let prefix_hash = source_hash.finish();
        let prefix_bytes = logical_record_bytes("p", "t", "id-0", b"value-0").unwrap() as u64;

        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        target.put_project("p", "t", "id-0", b"value-0").unwrap();
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        let mut initial = initial_manifest(&source_path, &pages_path);
        initial.source_records = 1;
        initial.source_logical_bytes = prefix_bytes;
        manifests.create(initial.clone()).unwrap();
        initial.transition(MigrationState::SourceScanned).unwrap();
        initial.source_hash = prefix_hash;
        manifests.save(initial.clone()).unwrap();
        initial.transition(MigrationState::Importing).unwrap();
        initial.imported_records = 1;
        initial.imported_logical_bytes = prefix_bytes;
        initial.last_batch_sequence = 1;
        initial.last_batch_records = 1;
        initial.cursor = encode_cursor(&("p".to_owned(), "t".to_owned(), "id-1".to_owned())).unwrap();
        initial.prefix_hash = prefix_hash;
        manifests.save(initial.clone()).unwrap();

        let result = import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 2,
        );
        assert!(matches!(result, Err(SnapshotImportError::ResumeMismatch(_))));
        assert_eq!(target.validate().unwrap().entries, 1);
        assert_eq!(manifests.current().unwrap().imported_records, 1);

        // Con cursor correcto, un hash de prefijo adulterado también debe
        // bloquear la reanudación antes de modificar el destino.
        let mut bad_hash = manifests.current().unwrap().clone();
        bad_hash.generation += 1;
        bad_hash.cursor = encode_cursor(&("p".to_owned(), "t".to_owned(), "id-0".to_owned())).unwrap();
        bad_hash.prefix_hash = [0x99; 32];
        manifests.save(bad_hash).unwrap();
        let result = import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 2,
        );
        assert!(matches!(result, Err(SnapshotImportError::ResumeMismatch(_))));
        assert_eq!(target.validate().unwrap().entries, 1);
        assert_eq!(manifests.current().unwrap().imported_records, 1);

        drop(manifests);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resumable_import_aborts_when_source_changes_after_manifest_scan() {
        let root = test_dir("resumable-source-change");
        let source_path = root.join("legacy.wal");
        let pages_path = root.join("new.pages");
        let page_wal_path = root.join("new.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        source.put_project("p", "t", "a", b"one").unwrap();

        let mut digest = Sha256::new();
        let mut initial = initial_manifest(&source_path, &pages_path);
        let mut count = 0u64;
        let mut bytes = 0u64;
        source.visit_records(|project, table, id, value| {
            hash_record(&mut digest, project, table, id, value);
            count += 1;
            bytes += logical_record_bytes(project, table, id, value).unwrap() as u64;
            Ok::<(), BTreeError>(())
        }).unwrap();
        initial.source_records = count;
        initial.source_logical_bytes = bytes;
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        manifests.create(initial.clone()).unwrap();
        initial.transition(MigrationState::SourceScanned).unwrap();
        initial.source_hash = digest.finish();
        manifests.save(initial.clone()).unwrap();

        source.put_project("p", "t", "b", b"two").unwrap();
        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        let result = import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 2,
        );
        assert!(matches!(result, Err(SnapshotImportError::SourceChanged)));
        assert_eq!(manifests.current().unwrap().state, MigrationState::Aborted);
        drop(manifests);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resumable_import_rejects_unmatched_tail_after_recovered_records() {
        let root = test_dir("resumable-recovery-extra-tail");
        let source_path = root.join("legacy.wal");
        let pages_path = root.join("new.pages");
        let page_wal_path = root.join("new.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        source.put_project("p", "t", "a", b"one").unwrap();
        source.put_project("p", "t", "b", b"two").unwrap();
        source.put_project("p", "t", "c", b"three").unwrap();

        let mut source_hash = Sha256::new();
        let mut prefix_hash = Sha256::new();
        let mut source_records = 0u64;
        let mut source_bytes = 0u64;
        let mut prefix_bytes = 0u64;
        source.visit_records(|project, table, id, value| {
            hash_record(&mut source_hash, project, table, id, value);
            source_records += 1;
            let bytes = logical_record_bytes(project, table, id, value).unwrap() as u64;
            source_bytes += bytes;
            if id == "a" {
                hash_record(&mut prefix_hash, project, table, id, value);
                prefix_bytes = bytes;
            }
            Ok::<(), BTreeError>(())
        }).unwrap();

        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        target.put_project("p", "t", "a", b"one").unwrap();
        target.put_project("p", "t", "b", b"two").unwrap();
        target.put_project("p", "t", "c", b"three").unwrap();
        target.put_project("p", "t", "z-extra", b"not in snapshot").unwrap();

        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        let mut initial = initial_manifest(&source_path, &pages_path);
        initial.batch_size = 3;
        initial.source_records = source_records;
        initial.source_logical_bytes = source_bytes;
        manifests.create(initial.clone()).unwrap();
        initial.transition(MigrationState::SourceScanned).unwrap();
        initial.source_hash = source_hash.finish();
        manifests.save(initial.clone()).unwrap();
        initial.transition(MigrationState::Importing).unwrap();
        initial.imported_records = 1;
        initial.imported_logical_bytes = prefix_bytes;
        initial.last_batch_sequence = 1;
        initial.last_batch_records = 1;
        initial.cursor = encode_cursor(&("p".to_owned(), "t".to_owned(), "a".to_owned())).unwrap();
        initial.prefix_hash = prefix_hash.finish();
        manifests.save(initial).unwrap();

        let result = import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 3,
        );
        assert!(matches!(result, Err(SnapshotImportError::ResumeMismatch(_))));
        assert_eq!(manifests.current().unwrap().imported_records, 1);
        assert_eq!(target.validate().unwrap().entries, 4);

        // Un conteo correcto tampoco autoriza recuperar bytes divergentes.
        target.put_project("p", "t", "b", b"tampered").unwrap();
        let result = import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 3,
        );
        assert!(matches!(result, Err(SnapshotImportError::ResumeMismatch(_))));
        assert_eq!(manifests.current().unwrap().imported_records, 1);
        assert_eq!(target.validate().unwrap().entries, 4);

        drop(manifests);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resumable_import_rejects_recovered_batch_above_logical_byte_budget() {
        let root = test_dir("resumable-recovery-byte-budget");
        let source_path = root.join("legacy.wal");
        let pages_path = root.join("new.pages");
        let page_wal_path = root.join("new.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        source.put_project("p", "t", "a", b"prefix").unwrap();
        let large = vec![0x5a; 70 * 1024];
        source.put_project("p", "t", "b", &large).unwrap();
        source.put_project("p", "t", "c", &large).unwrap();

        let mut full_hash = Sha256::new();
        let mut prefix_hash = Sha256::new();
        let mut source_records = 0u64;
        let mut source_bytes = 0u64;
        let mut prefix_bytes = 0u64;
        source.visit_records(|project, table, id, value| {
            hash_record(&mut full_hash, project, table, id, value);
            source_records += 1;
            let bytes = logical_record_bytes(project, table, id, value).unwrap() as u64;
            source_bytes += bytes;
            if id == "a" {
                hash_record(&mut prefix_hash, project, table, id, value);
                prefix_bytes = bytes;
            }
            Ok::<(), BTreeError>(())
        }).unwrap();
        let source_fingerprint = full_hash.finish();
        let prefix_fingerprint = prefix_hash.finish();

        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        target.put_project("p", "t", "a", b"prefix").unwrap();
        target.put_project("p", "t", "b", &large).unwrap();
        target.put_project("p", "t", "c", &large).unwrap();

        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        let mut initial = initial_manifest(&source_path, &pages_path);
        initial.source_records = source_records;
        initial.source_logical_bytes = source_bytes;
        manifests.create(initial.clone()).unwrap();
        initial.transition(MigrationState::SourceScanned).unwrap();
        initial.source_hash = source_fingerprint;
        manifests.save(initial.clone()).unwrap();
        initial.transition(MigrationState::Importing).unwrap();
        initial.imported_records = 1;
        initial.imported_logical_bytes = prefix_bytes;
        initial.last_batch_sequence = 1;
        initial.last_batch_records = 1;
        initial.cursor = encode_cursor(&("p".to_owned(), "t".to_owned(), "a".to_owned())).unwrap();
        initial.prefix_hash = prefix_fingerprint;
        manifests.save(initial).unwrap();

        let result = import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 2,
        );
        assert!(matches!(result, Err(SnapshotImportError::ResumeMismatch(_))));
        assert_eq!(manifests.current().unwrap().imported_records, 1);
        assert_eq!(manifests.current().unwrap().last_batch_sequence, 1);
        assert_eq!(target.validate().unwrap().entries, 3);

        drop(manifests);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resumable_import_rejects_single_record_above_logical_batch_budget() {
        let root = test_dir("resumable-oversized");
        let source_path = root.join("legacy.wal");
        let pages_path = root.join("new.pages");
        let page_wal_path = root.join("new.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        source.put_project("p", "t", "large", &vec![0x5a; MAX_SNAPSHOT_IMPORT_BATCH_BYTES + 1]).unwrap();
        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        let result = import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 4,
        );
        assert!(matches!(result, Err(SnapshotImportError::Target(BTreeError::Invalid(_)))));
        assert_eq!(target.validate().unwrap().entries, 0);
        assert_eq!(manifests.current().unwrap().state, MigrationState::Importing);
        drop(manifests);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn independent_verification_compares_all_records_and_marks_manifest_verified() {
        let root = test_dir("verify-success");
        let source_path = root.join("legacy.wal");
        let pages_path = root.join("new.pages");
        let page_wal_path = root.join("new.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        source.put_project("p1", "entities", "a", b"alpha").unwrap();
        source.put_project("p1", "events", "b", b"").unwrap();
        source.put_project("p2", "entities", "c", b"gamma").unwrap();
        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 2,
        ).unwrap();

        let verified = verify_legacy_snapshot_migration(&source, &mut target, &mut manifests).unwrap();
        assert_eq!(verified.records_verified, 3);
        assert_eq!(verified.logical_bytes_verified, 41); // project/table/id/value bytes
        assert_eq!(verified.destination.entries, 3);
        assert_eq!(manifests.current().unwrap().state, MigrationState::Verified);
        drop(manifests);
        let reopened = ManifestStore::open(&manifest_path).unwrap();
        assert_eq!(reopened.current().unwrap().state, MigrationState::Verified);
        drop(reopened);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn independent_verification_rejects_changed_record_bytes() {
        let root = test_dir("verify-changed-value");
        let source_path = root.join("legacy.wal");
        let pages_path = root.join("new.pages");
        let page_wal_path = root.join("new.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        source.put_project("p", "t", "a", b"original").unwrap();
        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 2,
        ).unwrap();
        target.put_project("p", "t", "a", b"tampered").unwrap();
        let result = verify_legacy_snapshot_migration(&source, &mut target, &mut manifests);
        assert!(matches!(result, Err(SnapshotImportError::VerificationMismatch(_))));
        assert_eq!(manifests.current().unwrap().state, MigrationState::Verifying);
        drop(manifests);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn independent_verification_rejects_missing_destination_records() {
        let root = test_dir("verify-missing");
        let source_path = root.join("legacy.wal");
        let pages_path = root.join("new.pages");
        let page_wal_path = root.join("new.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        source.put_project("p", "t", "a", b"one").unwrap();
        source.put_project("p", "t", "b", b"two").unwrap();
        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 2,
        ).unwrap();
        target.delete_project("p", "t", "b").unwrap();
        let result = verify_legacy_snapshot_migration(&source, &mut target, &mut manifests);
        assert!(matches!(result, Err(SnapshotImportError::VerificationMismatch(_))));
        drop(manifests);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn independent_verification_rejects_additional_destination_records() {
        let root = test_dir("verify-extra");
        let source_path = root.join("legacy.wal");
        let pages_path = root.join("new.pages");
        let page_wal_path = root.join("new.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        source.put_project("p", "t", "a", b"one").unwrap();
        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 2,
        ).unwrap();
        target.put_project("p", "t", "unexpected", b"extra").unwrap();
        let result = verify_legacy_snapshot_migration(&source, &mut target, &mut manifests);
        assert!(matches!(result, Err(SnapshotImportError::VerificationMismatch(_))));
        drop(manifests);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn independent_verification_can_resume_after_destination_is_repaired() {
        let root = test_dir("verify-retry");
        let source_path = root.join("legacy.wal");
        let pages_path = root.join("new.pages");
        let page_wal_path = root.join("new.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        source.put_project("p", "t", "a", b"original").unwrap();
        let mut target = ProjectStore::open(&pages_path, &page_wal_path).unwrap();
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &pages_path), 2,
        ).unwrap();
        target.put_project("p", "t", "a", b"wrong").unwrap();
        assert!(matches!(
            verify_legacy_snapshot_migration(&source, &mut target, &mut manifests),
            Err(SnapshotImportError::VerificationMismatch(_))
        ));
        target.put_project("p", "t", "a", b"original").unwrap();
        let verified = verify_legacy_snapshot_migration(&source, &mut target, &mut manifests).unwrap();
        assert_eq!(verified.records_verified, 1);
        assert_eq!(manifests.current().unwrap().state, MigrationState::Verified);
        drop(manifests);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sha256_fingerprint_matches_standard_vectors_and_streaming_updates() {
        fn hex(bytes: &[u8]) -> String {
            bytes.iter().map(|byte| format!("{byte:02x}")).collect()
        }
        assert_eq!(
            hex(&Sha256::new().finish()),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let mut whole = Sha256::new();
        whole.update(b"abc");
        assert_eq!(
            hex(&whole.finish()),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let mut streamed = Sha256::new();
        streamed.update(b"a");
        streamed.update(b"b");
        streamed.update(b"c");
        assert_eq!(streamed.finish(), whole.finish());
        let mut multi_block = Sha256::new();
        multi_block.update(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq");
        assert_eq!(
            hex(&multi_block.finish()),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn resumable_import_rejects_target_opened_at_a_different_path() {
        let root = test_dir("resumable-target-path");
        let source_path = root.join("legacy.wal");
        let actual_pages = root.join("actual.pages");
        let wrong_pages = root.join("wrong.pages");
        let page_wal_path = root.join("actual.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        source.put_project("p", "t", "a", b"value").unwrap();
        let mut target = ProjectStore::open(&actual_pages, &page_wal_path).unwrap();
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        let result = import_legacy_snapshot_resumable(
            &source, &mut target, &mut manifests,
            initial_manifest(&source_path, &wrong_pages), 2,
        );
        assert!(matches!(result, Err(SnapshotImportError::ResumeMismatch(_))));
        assert_eq!(target.validate().unwrap().entries, 0);
        drop(manifests);
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

}


#[cfg(test)]
mod publication_migration_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn root(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("mldb-publication-flow-{label}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn manifest(source: &Path, pages: &Path) -> MigrationManifest {
        MigrationManifest {
            generation: 1,
            migration_id: [0xA7; 16],
            state: MigrationState::Created,
            source_path: source.to_string_lossy().into_owned(),
            destination_path: pages.to_string_lossy().into_owned(),
            source_format_version: 1,
            destination_format_version: 1,
            source_hash: [0; 32],
            source_records: 0,
            source_logical_bytes: 0,
            batch_size: 2,
            batch_byte_budget: MAX_SNAPSHOT_IMPORT_BATCH_BYTES as u64,
            last_batch_sequence: 0,
            last_batch_records: 0,
            imported_records: 0,
            imported_logical_bytes: 0,
            cursor: Vec::new(),
            prefix_hash: [0; 32],
        }
    }

    fn prepare_verified(root: &Path) -> (Store, ProjectStore, ManifestStore, std::path::PathBuf, std::path::PathBuf) {
        let source_path = root.join("legacy.wal");
        let pages = root.join("staging.pages");
        let wal = root.join("staging.mlpj");
        let manifest_path = root.join("migration");
        let source = Store::open(&source_path).unwrap();
        for index in 0..7 {
            source.put_project("project", "entities", &format!("entity-{index}"), format!("payload-{index}").as_bytes()).unwrap();
        }
        let mut target = ProjectStore::open(&pages, &wal).unwrap();
        let mut manifests = ManifestStore::open(&manifest_path).unwrap();
        import_legacy_snapshot_resumable(&source, &mut target, &mut manifests, manifest(&source_path, &pages), 3).unwrap();
        verify_legacy_snapshot_migration(&source, &mut target, &mut manifests).unwrap();
        assert_eq!(manifests.current().unwrap().state, MigrationState::Verified);
        (source, target, manifests, pages, wal)
    }

    #[test]
    fn publication_flow_copies_verifies_and_publishes_without_moving_staging_files() {
        let root = root("complete");
        let (source, mut target, mut manifests, pages, wal) = prepare_verified(&root);
        let publication_root = root.join("published");
        let mut publication = PublicationStore::open(&publication_root).unwrap();
        let report = publish_verified_legacy_snapshot(&source, &mut target, &mut manifests, &mut publication).unwrap();
        assert_eq!(report.records_verified, 7);
        assert_eq!(manifests.current().unwrap().state, MigrationState::Published);
        assert_eq!(publication.current(), Some(&report.pointer));
        assert!(pages.exists());
        assert!(wal.exists());
        let mut opened=publication.open_current_project_store().unwrap().unwrap();
        assert_eq!(opened.validate().unwrap().entries, 7);
        assert_eq!(opened.get_project("project", "entities", "entity-4").unwrap(), Some(b"payload-4".to_vec()));
        drop(opened);
        drop(publication);
        drop(manifests);
        drop(target);
        drop(source);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_reconciliation_completes_manifest_after_selector_commit() {
        let root = root("reconcile");
        let (source, mut target, mut manifests, pages, wal) = prepare_verified(&root);
        let publication_root = root.join("published");
        let mut publication = PublicationStore::open(&publication_root).unwrap();
        target.checkpoint().unwrap();
        let pointer = PublicationPointer::new(1, manifests.current().unwrap().migration_id).unwrap();
        let generation_dir = publication_root.join("generations").join(&pointer.generation_dir);
        fs::create_dir_all(&generation_dir).unwrap();
        fs::copy(&pages, generation_dir.join("store.pages")).unwrap();
        fs::copy(&wal, generation_dir.join("store.mlpj")).unwrap();
        GenerationReceipt::create_from_files(&generation_dir, &pointer).unwrap();
        publication.publish(pointer.clone()).unwrap();
        assert_eq!(manifests.current().unwrap().state, MigrationState::Verified);
        drop(publication);

        let publication = PublicationStore::open(&publication_root).unwrap();
        let report = reconcile_legacy_snapshot_publication(&source, &mut manifests, &publication).unwrap().unwrap();
        assert_eq!(report.pointer, pointer);
        assert_eq!(report.records_verified, 7);
        assert_eq!(manifests.current().unwrap().state, MigrationState::Published);
        drop(publication);
        drop(manifests);
        drop(target);
        drop(source);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_flow_rejects_manifest_before_independent_verification() {
        let root = root("unverified");
        let source_path = root.join("legacy.wal");
        let pages = root.join("staging.pages");
        let wal = root.join("staging.mlpj");
        let source = Store::open(&source_path).unwrap();
        source.put_project("p", "t", "id", b"value").unwrap();
        let mut target = ProjectStore::open(&pages, &wal).unwrap();
        let mut manifests = ManifestStore::open(root.join("migration")).unwrap();
        manifests.create(manifest(&source_path, &pages)).unwrap();
        let mut publication = PublicationStore::open(root.join("published")).unwrap();
        let result = publish_verified_legacy_snapshot(&source, &mut target, &mut manifests, &mut publication);
        assert!(matches!(result, Err(SnapshotImportError::ResumeMismatch(_))));
        assert!(publication.current().is_none());
        drop(publication);
        drop(manifests);
        drop(target);
        drop(source);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn publication_flow_rejects_source_changed_after_verification() {
        let root = root("source-changed");
        let (source, mut target, mut manifests, _pages, _wal) = prepare_verified(&root);
        source.put_project("project", "entities", "late-record", b"changed after verify").unwrap();
        let mut publication = PublicationStore::open(root.join("published")).unwrap();
        let result = publish_verified_legacy_snapshot(&source, &mut target, &mut manifests, &mut publication);
        assert!(matches!(result, Err(SnapshotImportError::VerificationMismatch(_))));
        assert!(publication.current().is_none());
        assert_eq!(manifests.current().unwrap().state, MigrationState::Verified);
        drop(publication);
        drop(manifests);
        drop(target);
        drop(source);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_retry_cleanup_preserves_persistent_lockfiles() {
        let root = root("orphan-cleanup");
        let generation = root.join("orphan-generation");
        fs::create_dir(&generation).unwrap();
        fs::write(generation.join("store.pages.tmp"), b"partial pages").unwrap();
        fs::write(generation.join("store.mlpj"), b"partial wal").unwrap();
        prepare_unpublished_generation_directory(&generation).unwrap();
        assert!(!generation.join("store.pages.tmp").exists());
        assert!(!generation.join("store.mlpj").exists());
        assert!(generation.join("store.pages.mldb-lock").is_file());
        assert!(generation.join("store.mlpj.mldb-lock").is_file());
        fs::remove_dir_all(root).unwrap();
    }

}