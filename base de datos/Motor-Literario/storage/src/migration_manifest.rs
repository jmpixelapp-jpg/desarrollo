//! Formato binario versionado y validado para el estado durable de una migración.
//! Codec versionado, máquina de estados y persistencia durable en dos slots alternos
//! para checkpoints de migración. La verificación integral está implementada; publicación pendiente.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use crate::interprocess_lock::InterprocessLock;

const MAGIC: &[u8; 8] = b"MLMIGR02";
pub const FORMAT_VERSION: u16 = 2;
pub const MAX_PATH_BYTES: usize = 4096;
pub const MAX_CURSOR_BYTES: usize = 16 * 1024;
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const HEADER_BYTES: usize = 8 + 2 + 8;
const CHECKSUM_BYTES: usize = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum MigrationState {
    Created = 1,
    SourceScanned = 2,
    Importing = 3,
    ImportComplete = 4,
    Verifying = 5,
    Verified = 6,
    Published = 7,
    Aborted = 8,
}

impl MigrationState {
    fn decode(value: u8) -> Result<Self, ManifestError> {
        match value {
            1 => Ok(Self::Created),
            2 => Ok(Self::SourceScanned),
            3 => Ok(Self::Importing),
            4 => Ok(Self::ImportComplete),
            5 => Ok(Self::Verifying),
            6 => Ok(Self::Verified),
            7 => Ok(Self::Published),
            8 => Ok(Self::Aborted),
            _ => Err(ManifestError::Invalid("estado desconocido")),
        }
    }

    fn can_transition_to(self, next: Self) -> bool {
        use MigrationState::*;
        matches!(
            (self, next),
            (Created, SourceScanned)
                | (Created, Aborted)
                | (SourceScanned, Importing)
                | (SourceScanned, Aborted)
                | (Importing, Importing)
                | (Importing, ImportComplete)
                | (Importing, Aborted)
                | (ImportComplete, Verifying)
                | (ImportComplete, Aborted)
                | (Verifying, Verifying)
                | (Verifying, Verified)
                | (Verifying, Aborted)
                | (Verified, Published)
                | (Verified, Aborted)
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationManifest {
    pub generation: u64,
    pub migration_id: [u8; 16],
    pub state: MigrationState,
    pub source_path: String,
    pub destination_path: String,
    pub source_format_version: u32,
    pub destination_format_version: u32,
    pub source_hash: [u8; 32],
    pub source_records: u64,
    pub source_logical_bytes: u64,
    pub batch_size: u32,
    pub batch_byte_budget: u64,
    pub last_batch_sequence: u64,
    pub last_batch_records: u64,
    pub imported_records: u64,
    pub imported_logical_bytes: u64,
    pub cursor: Vec<u8>,
    pub prefix_hash: [u8; 32],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManifestError {
    Invalid(&'static str),
    Truncated,
    UnsupportedVersion(u16),
    ChecksumMismatch,
    TrailingBytes,
    InvalidTransition { from: MigrationState, to: MigrationState },
    Io(String),
}

impl fmt::Display for ManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "manifiesto inválido: {message}"),
            Self::Truncated => write!(f, "manifiesto truncado"),
            Self::UnsupportedVersion(version) => write!(f, "versión de manifiesto no compatible: {version}"),
            Self::ChecksumMismatch => write!(f, "checksum del manifiesto incorrecto"),
            Self::TrailingBytes => write!(f, "bytes sobrantes al final del manifiesto"),
            Self::InvalidTransition { from, to } => write!(f, "transición de migración inválida: {from:?} → {to:?}"),
            Self::Io(message) => write!(f, "I/O del manifiesto: {message}"),
        }
    }
}
impl std::error::Error for ManifestError {}

impl MigrationManifest {
    pub fn validate(&self) -> Result<(), ManifestError> {
        if self.generation == 0 {
            return Err(ManifestError::Invalid("generación debe ser positiva"));
        }
        if self.source_path.is_empty() || self.destination_path.is_empty() {
            return Err(ManifestError::Invalid("rutas de origen y destino obligatorias"));
        }
        if self.source_path.as_bytes().contains(&0) || self.destination_path.as_bytes().contains(&0) {
            return Err(ManifestError::Invalid("las rutas no pueden contener NUL"));
        }
        if self.source_path == self.destination_path {
            return Err(ManifestError::Invalid("origen y destino deben ser distintos"));
        }
        if self.source_path.len() > MAX_PATH_BYTES || self.destination_path.len() > MAX_PATH_BYTES {
            return Err(ManifestError::Invalid("ruta demasiado larga"));
        }
        if self.cursor.len() > MAX_CURSOR_BYTES {
            return Err(ManifestError::Invalid("cursor demasiado largo"));
        }
        if self.batch_size == 0 || self.batch_byte_budget == 0 {
            return Err(ManifestError::Invalid("límites de lote deben ser positivos"));
        }
        if self.batch_byte_budget > 32 * 1024 * 1024 {
            return Err(ManifestError::Invalid("presupuesto de lote supera el límite transaccional MLPJ"));
        }
        if self.imported_records > self.source_records
            || self.imported_logical_bytes > self.source_logical_bytes
            || self.last_batch_records > self.imported_records
            || self.last_batch_records > self.batch_size as u64
            || self.last_batch_sequence > self.imported_records
        {
            return Err(ManifestError::Invalid("contadores exceden el snapshot o son inconsistentes"));
        }
        if self.state == MigrationState::Created
            && (self.imported_records != 0 || self.imported_logical_bytes != 0
                || self.last_batch_sequence != 0 || self.last_batch_records != 0
                || !self.cursor.is_empty() || self.prefix_hash != [0; 32])
        {
            return Err(ManifestError::Invalid("estado Created no puede contener progreso"));
        }
        if self.imported_records == 0
            && (self.last_batch_sequence != 0 || self.last_batch_records != 0 || !self.cursor.is_empty())
        {
            return Err(ManifestError::Invalid("cursor y lote requieren registros importados"));
        }
        if self.imported_records > 0 && (self.last_batch_sequence == 0 || self.last_batch_records == 0 || self.cursor.is_empty()) {
            return Err(ManifestError::Invalid("progreso importado requiere secuencia, lote y cursor"));
        }
        if matches!(self.state, MigrationState::Importing | MigrationState::ImportComplete | MigrationState::Verifying | MigrationState::Verified | MigrationState::Published)
            && self.source_hash == [0; 32]
        {
            return Err(ManifestError::Invalid("estado posterior al escaneo requiere hash de origen"));
        }
        if matches!(self.state, MigrationState::ImportComplete | MigrationState::Verifying | MigrationState::Verified | MigrationState::Published)
            && (self.imported_records != self.source_records
                || self.imported_logical_bytes != self.source_logical_bytes)
        {
            return Err(ManifestError::Invalid("estado completo requiere todos los registros y bytes del snapshot"));
        }
        Ok(())
    }

    pub fn transition(&mut self, next: MigrationState) -> Result<(), ManifestError> {
        if !self.state.can_transition_to(next) {
            return Err(ManifestError::InvalidTransition { from: self.state, to: next });
        }
        let mut candidate = self.clone();
        candidate.state = next;
        candidate.generation = candidate.generation.checked_add(1)
            .ok_or(ManifestError::Invalid("generación agotada"))?;
        candidate.validate()?;
        *self = candidate;
        Ok(())
    }

    pub fn encode(&self) -> Result<Vec<u8>, ManifestError> {
        self.validate()?;
        let estimated = 256usize.checked_add(self.source_path.len())
            .and_then(|n| n.checked_add(self.destination_path.len()))
            .and_then(|n| n.checked_add(self.cursor.len()))
            .ok_or(ManifestError::Invalid("tamaño de manifiesto desbordado"))?;
        if estimated > MAX_MANIFEST_BYTES {
            return Err(ManifestError::Invalid("manifiesto supera el tamaño máximo"));
        }
        let mut out = Vec::with_capacity(estimated);
        out.extend_from_slice(MAGIC);
        put_u16(&mut out, FORMAT_VERSION);
        put_u64(&mut out, self.generation);
        out.extend_from_slice(&self.migration_id);
        out.push(self.state as u8);
        put_bytes(&mut out, self.source_path.as_bytes());
        put_bytes(&mut out, self.destination_path.as_bytes());
        put_u32(&mut out, self.source_format_version);
        put_u32(&mut out, self.destination_format_version);
        out.extend_from_slice(&self.source_hash);
        put_u64(&mut out, self.source_records);
        put_u64(&mut out, self.source_logical_bytes);
        put_u32(&mut out, self.batch_size);
        put_u64(&mut out, self.batch_byte_budget);
        put_u64(&mut out, self.last_batch_sequence);
        put_u64(&mut out, self.last_batch_records);
        put_u64(&mut out, self.imported_records);
        put_u64(&mut out, self.imported_logical_bytes);
        put_bytes(&mut out, &self.cursor);
        out.extend_from_slice(&self.prefix_hash);
        let checksum = checksum64(&out);
        put_u64(&mut out, checksum);
        Ok(out)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ManifestError> {
        if bytes.len() < HEADER_BYTES + CHECKSUM_BYTES {
            return Err(ManifestError::Truncated);
        }
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(ManifestError::Invalid("manifiesto supera el tamaño máximo"));
        }
        if &bytes[..8] != MAGIC {
            return Err(ManifestError::Invalid("magic incorrecto"));
        }
        let stored_checksum = u64::from_le_bytes(bytes[bytes.len()-8..].try_into().unwrap());
        if checksum64(&bytes[..bytes.len()-8]) != stored_checksum {
            return Err(ManifestError::ChecksumMismatch);
        }
        let mut reader = Reader { bytes: &bytes[..bytes.len()-8], at: 8 };
        let version = reader.u16()?;
        if version != FORMAT_VERSION {
            return Err(ManifestError::UnsupportedVersion(version));
        }
        let generation = reader.u64()?;
        let migration_id = reader.array::<16>()?;
        let state = MigrationState::decode(reader.u8()?)?;
        let source_path = reader.string(MAX_PATH_BYTES)?;
        let destination_path = reader.string(MAX_PATH_BYTES)?;
        let source_format_version = reader.u32()?;
        let destination_format_version = reader.u32()?;
        let source_hash = reader.array::<32>()?;
        let source_records = reader.u64()?;
        let source_logical_bytes = reader.u64()?;
        let batch_size = reader.u32()?;
        let batch_byte_budget = reader.u64()?;
        let last_batch_sequence = reader.u64()?;
        let last_batch_records = reader.u64()?;
        let imported_records = reader.u64()?;
        let imported_logical_bytes = reader.u64()?;
        let cursor = reader.bytes(MAX_CURSOR_BYTES)?;
        let prefix_hash = reader.array::<32>()?;
        if reader.at != reader.bytes.len() {
            return Err(ManifestError::TrailingBytes);
        }
        let manifest = Self {
            generation, migration_id, state, source_path, destination_path,
            source_format_version, destination_format_version, source_hash,
            source_records, source_logical_bytes, batch_size, batch_byte_budget,
            last_batch_sequence, last_batch_records, imported_records,
            imported_logical_bytes, cursor, prefix_hash,
        };
        manifest.validate()?;
        Ok(manifest)
    }
}

/// Selecciona el manifiesto válido de mayor generación entre dos slots.
/// Un slot ausente se representa con None. Si ambos están presentes pero
/// ninguno se puede decodificar, la recuperación falla cerrada.
pub fn select_latest_slot(
    slot_a: Option<&[u8]>,
    slot_b: Option<&[u8]>,
) -> Result<Option<(usize, MigrationManifest)>, ManifestError> {
    let a = slot_a.map(MigrationManifest::decode);
    let b = slot_b.map(MigrationManifest::decode);
    match (a, b) {
        (None, None) => Ok(None),
        (Some(Ok(value)), None) => Ok(Some((0, value))),
        (None, Some(Ok(value))) => Ok(Some((1, value))),
        (Some(Ok(left)), Some(Ok(right))) => {
            if left.migration_id != right.migration_id
                || left.source_path != right.source_path
                || left.destination_path != right.destination_path
                || left.source_format_version != right.source_format_version
                || left.destination_format_version != right.destination_format_version
            {
                return Err(ManifestError::Invalid("los slots pertenecen a migraciones distintas"));
            }
            if left.generation == right.generation && left != right {
                return Err(ManifestError::Invalid("dos slots distintos comparten generación"));
            }
            if right.generation > left.generation {
                Ok(Some((1, right)))
            } else {
                Ok(Some((0, left)))
            }
        }
        (Some(Ok(value)), Some(Err(_))) => Ok(Some((0, value))),
        (Some(Err(_)), Some(Ok(value))) => Ok(Some((1, value))),
        (Some(Err(error)), None) | (None, Some(Err(error))) => Err(error),
        (Some(Err(_)), Some(Err(_))) => Err(ManifestError::Invalid("ambos slots del manifiesto son inválidos")),
    }
}


/// Almacén durable de manifiesto con dos slots alternos.
/// La escritura solo reemplaza el slot inactivo; el slot seleccionado anterior
/// permanece intacto hasta que el nuevo slot queda sincronizado.
pub struct ManifestStore {
    base_path: PathBuf,
    active_slot: Option<usize>,
    current: Option<MigrationManifest>,
    _lock: InterprocessLock,
}

impl ManifestStore {
    pub fn open(base_path: impl AsRef<Path>) -> Result<Self, ManifestError> {
        let base_path = base_path.as_ref().to_path_buf();
        let lock = InterprocessLock::acquire_for(&base_path)
            .map_err(|error| ManifestError::Io(error.to_string()))?;
        let slot0 = slot_path(&base_path, 0);
        let slot1 = slot_path(&base_path, 1);
        let bytes0 = read_slot(&slot0)?;
        let bytes1 = read_slot(&slot1)?;
        let selected = select_latest_slot(bytes0.as_deref(), bytes1.as_deref())?;
        let (active_slot, current) = match selected {
            Some((slot, manifest)) => (Some(slot), Some(manifest)),
            None => (None, None),
        };
        Ok(Self { base_path, active_slot, current, _lock: lock })
    }

    pub fn current(&self) -> Option<&MigrationManifest> {
        self.current.as_ref()
    }

    pub fn create(&mut self, manifest: MigrationManifest) -> Result<(), ManifestError> {
        if self.current.is_some() || self.active_slot.is_some() {
            return Err(ManifestError::Invalid("el manifiesto ya existe"));
        }
        if manifest.generation != 1 {
            return Err(ManifestError::Invalid("el manifiesto inicial debe tener generación 1"));
        }
        manifest.encode()?;
        self.write_slot(0, &manifest)?;
        self.active_slot = Some(0);
        self.current = Some(manifest);
        Ok(())
    }

    /// Persiste una nueva generación. Debe ser exactamente la siguiente,
    /// mantener la identidad/rutas/versiones y respetar la máquina de estados.
    pub fn save(&mut self, manifest: MigrationManifest) -> Result<(), ManifestError> {
        let current = self.current.as_ref()
            .ok_or(ManifestError::Invalid("no existe manifiesto inicial"))?;
        if manifest.migration_id != current.migration_id
            || manifest.source_path != current.source_path
            || manifest.destination_path != current.destination_path
            || manifest.source_format_version != current.source_format_version
            || manifest.destination_format_version != current.destination_format_version
        {
            return Err(ManifestError::Invalid("la identidad de migración no puede cambiar"));
        }
        let expected = current.generation.checked_add(1)
            .ok_or(ManifestError::Invalid("generación agotada"))?;
        if manifest.generation != expected {
            return Err(ManifestError::Invalid("la generación debe avanzar exactamente una unidad"));
        }
        if !current.state.can_transition_to(manifest.state) {
            return Err(ManifestError::InvalidTransition { from: current.state, to: manifest.state });
        }
        let encoded = manifest.encode()?;
        let target = 1usize - self.active_slot.unwrap_or(1);
        self.write_encoded_slot(target, &encoded)?;
        self.active_slot = Some(target);
        self.current = Some(manifest);
        Ok(())
    }

    pub fn base_path(&self) -> &Path {
        &self.base_path
    }

    fn write_slot(&self, slot: usize, manifest: &MigrationManifest) -> Result<(), ManifestError> {
        let encoded = manifest.encode()?;
        self.write_encoded_slot(slot, &encoded)
    }

    fn write_encoded_slot(&self, slot: usize, encoded: &[u8]) -> Result<(), ManifestError> {
        let path = slot_path(&self.base_path, slot);
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent).map_err(io_error)?;
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(ManifestError::Invalid("slot no es un archivo regular"));
            }
        }
        let mut options = OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(io_error)?;
        file.write_all(encoded).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        sync_directory(parent)?;
        Ok(())
    }
}

fn slot_path(base: &Path, slot: usize) -> PathBuf {
    let mut name = base.as_os_str().to_os_string();
    name.push(if slot == 0 { ".slot0" } else { ".slot1" });
    PathBuf::from(name)
}

fn read_slot(path: &Path) -> Result<Option<Vec<u8>>, ManifestError> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(ManifestError::Invalid("slot no es un archivo regular"));
        }
    }
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    let length = file.metadata().map_err(io_error)?.len();
    if length as u128 > MAX_MANIFEST_BYTES as u128 {
        // Se conserva como slot inválido, permitiendo fallback al otro.
        return Ok(Some(vec![0; MAX_MANIFEST_BYTES + 1]));
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.read_to_end(&mut bytes).map_err(io_error)?;
    Ok(Some(bytes))
}

fn sync_directory(path: &Path) -> Result<(), ManifestError> {
    #[cfg(unix)]
    {
        File::open(path).and_then(|directory| directory.sync_all()).map_err(io_error)?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn io_error(error: std::io::Error) -> ManifestError {
    ManifestError::Io(error.to_string())
}

fn checksum64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}
fn put_u16(out: &mut Vec<u8>, value: u16) { out.extend_from_slice(&value.to_le_bytes()); }
fn put_u32(out: &mut Vec<u8>, value: u32) { out.extend_from_slice(&value.to_le_bytes()); }
fn put_u64(out: &mut Vec<u8>, value: u64) { out.extend_from_slice(&value.to_le_bytes()); }
fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    put_u32(out, bytes.len() as u32);
    out.extend_from_slice(bytes);
}

struct Reader<'a> { bytes: &'a [u8], at: usize }
impl<'a> Reader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], ManifestError> {
        let end = self.at.checked_add(len).ok_or(ManifestError::Truncated)?;
        if end > self.bytes.len() { return Err(ManifestError::Truncated); }
        let value = &self.bytes[self.at..end];
        self.at = end;
        Ok(value)
    }
    fn u8(&mut self) -> Result<u8, ManifestError> { Ok(self.take(1)?[0]) }
    fn u16(&mut self) -> Result<u16, ManifestError> { Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap())) }
    fn u32(&mut self) -> Result<u32, ManifestError> { Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap())) }
    fn u64(&mut self) -> Result<u64, ManifestError> { Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap())) }
    fn array<const N: usize>(&mut self) -> Result<[u8; N], ManifestError> { Ok(self.take(N)?.try_into().unwrap()) }
    fn bytes(&mut self, max: usize) -> Result<Vec<u8>, ManifestError> {
        let len = self.u32()? as usize;
        if len > max { return Err(ManifestError::Invalid("campo excede su límite")); }
        Ok(self.take(len)?.to_vec())
    }
    fn string(&mut self, max: usize) -> Result<String, ManifestError> {
        String::from_utf8(self.bytes(max)?).map_err(|_| ManifestError::Invalid("ruta no es UTF-8"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> MigrationManifest {
        MigrationManifest {
            generation: 1,
            migration_id: [0x42; 16],
            state: MigrationState::Created,
            source_path: "/data/legacy.mlw".into(),
            destination_path: "/data/new-store".into(),
            source_format_version: 1,
            destination_format_version: 1,
            source_hash: [0x11; 32],
            source_records: 3,
            source_logical_bytes: 900,
            batch_size: 2,
            batch_byte_budget: 131072,
            last_batch_sequence: 0,
            last_batch_records: 0,
            imported_records: 0,
            imported_logical_bytes: 0,
            cursor: Vec::new(),
            prefix_hash: [0; 32],
        }
    }

    #[test]
    fn manifest_binary_round_trip_preserves_all_fields() {
        let manifest = sample();
        assert_eq!(MigrationManifest::decode(&manifest.encode().unwrap()).unwrap(), manifest);
    }

    #[test]
    fn manifest_rejects_truncation_checksum_and_trailing_bytes() {
        let encoded = sample().encode().unwrap();
        assert_eq!(MigrationManifest::decode(&encoded[..encoded.len()-1]), Err(ManifestError::ChecksumMismatch));
        let mut corrupted = encoded.clone();
        corrupted[20] ^= 1;
        assert_eq!(MigrationManifest::decode(&corrupted), Err(ManifestError::ChecksumMismatch));
        let mut trailing = encoded;
        trailing.insert(trailing.len()-8, 0);
        let sum = checksum64(&trailing[..trailing.len()-8]);
        let n = trailing.len();
        trailing[n-8..].copy_from_slice(&sum.to_le_bytes());
        assert_eq!(MigrationManifest::decode(&trailing), Err(ManifestError::TrailingBytes));
    }

    #[test]
    fn manifest_rejects_unknown_state_and_oversized_cursor() {
        let mut manifest = sample();
        manifest.state = MigrationState::Created;
        manifest.cursor = vec![1; MAX_CURSOR_BYTES + 1];
        assert!(matches!(manifest.encode(), Err(ManifestError::Invalid(_))));
        let mut encoded = sample().encode().unwrap();
        // El estado está inmediatamente después de magic, version, generation e id.
        encoded[34] = 0xff;
        let sum = checksum64(&encoded[..encoded.len()-8]);
        let n = encoded.len();
        encoded[n-8..].copy_from_slice(&sum.to_le_bytes());
        assert_eq!(MigrationManifest::decode(&encoded), Err(ManifestError::Invalid("estado desconocido")));
    }

    #[test]
    fn manifest_state_machine_rejects_skips_and_terminal_rewrites() {
        let mut manifest = sample();
        assert!(matches!(manifest.transition(MigrationState::Verified), Err(ManifestError::InvalidTransition { .. })));
        manifest.transition(MigrationState::SourceScanned).unwrap();
        manifest.transition(MigrationState::Importing).unwrap();
        assert!(matches!(manifest.transition(MigrationState::Published), Err(ManifestError::InvalidTransition { .. })));
        manifest.transition(MigrationState::Aborted).unwrap();
        assert!(matches!(manifest.transition(MigrationState::Importing), Err(ManifestError::InvalidTransition { .. })));
    }

    #[test]
    fn manifest_counters_cannot_exceed_source_snapshot() {
        let mut manifest = sample();
        manifest.imported_records = 4;
        assert!(matches!(manifest.encode(), Err(ManifestError::Invalid(_))));
        let mut complete = sample();
        complete.state = MigrationState::ImportComplete;
        assert!(matches!(complete.encode(), Err(ManifestError::Invalid(_))));
    }
    #[test]
    fn manifest_complete_states_require_exact_source_logical_byte_count() {
        let mut manifest = sample();
        manifest.state = MigrationState::ImportComplete;
        manifest.source_hash = [9; 32];
        manifest.imported_records = manifest.source_records;
        manifest.imported_logical_bytes = manifest.source_logical_bytes - 1;
        manifest.last_batch_sequence = 2;
        manifest.last_batch_records = 1;
        manifest.cursor = b"last-key".to_vec();
        manifest.prefix_hash = [8; 32];
        assert_eq!(
            manifest.encode(),
            Err(ManifestError::Invalid(
                "estado completo requiere todos los registros y bytes del snapshot"
            ))
        );

        manifest.imported_logical_bytes = manifest.source_logical_bytes;
        assert!(manifest.encode().is_ok());
    }

    #[test]
    fn manifest_rejects_a_last_batch_larger_than_configured_batch_size() {
        let mut manifest = sample();
        manifest.state = MigrationState::Importing;
        manifest.source_hash = [9; 32];
        manifest.imported_records = 3;
        manifest.imported_logical_bytes = 900;
        manifest.last_batch_sequence = 1;
        manifest.last_batch_records = manifest.batch_size as u64 + 1;
        manifest.cursor = b"last-key".to_vec();
        manifest.prefix_hash = [8; 32];
        assert_eq!(
            manifest.encode(),
            Err(ManifestError::Invalid(
                "contadores exceden el snapshot o son inconsistentes"
            ))
        );
    }

    #[test]
    fn failed_manifest_transition_does_not_mutate_generation_or_state() {
        let mut manifest = sample();
        manifest.source_records = 0;
        manifest.imported_records = 0;
        let before = manifest.clone();
        assert!(manifest.transition(MigrationState::SourceScanned).is_ok());
        let mut invalid = sample();
        invalid.imported_records = 1;
        let before_invalid = invalid.clone();
        assert!(matches!(invalid.transition(MigrationState::SourceScanned), Err(ManifestError::Invalid(_))));
        assert_eq!(invalid, before_invalid);
        assert_eq!(manifest.generation, before.generation + 1);
    }

    #[test]
    fn manifest_rejects_identical_or_nul_paths_and_zero_generation() {
        let mut manifest = sample();
        manifest.source_path = manifest.destination_path.clone();
        assert!(matches!(manifest.encode(), Err(ManifestError::Invalid(_))));
        let mut manifest = sample();
        manifest.source_path.push('\\0');
        assert!(matches!(manifest.encode(), Err(ManifestError::Invalid(_))));
        let mut manifest = sample();
        manifest.generation = 0;
        assert!(matches!(manifest.encode(), Err(ManifestError::Invalid(_))));
    }

    #[test]
    fn manifest_rejects_impossible_progress_and_excessive_batch_budget() {
        let mut manifest = sample();
        manifest.imported_records = 1;
        assert!(matches!(manifest.encode(), Err(ManifestError::Invalid(_))));
        let mut manifest = sample();
        manifest.batch_byte_budget = 32 * 1024 * 1024 + 1;
        assert!(matches!(manifest.encode(), Err(ManifestError::Invalid(_))));
    }

    #[test]
    fn manifest_rejects_encoded_data_above_global_size_limit() {
        let mut manifest = sample();
        manifest.cursor = vec![7; MAX_CURSOR_BYTES];
        manifest.state = MigrationState::Importing;
        manifest.source_hash = [9; 32];
        manifest.imported_records = 1;
        manifest.imported_logical_bytes = 1;
        manifest.last_batch_sequence = 1;
        manifest.last_batch_records = 1;
        assert!(manifest.encode().is_ok());
        let mut oversized = vec![0u8; MAX_MANIFEST_BYTES + 1];
        assert!(matches!(MigrationManifest::decode(&oversized), Err(ManifestError::Invalid(_))));
        oversized.clear();
    }

    #[test]
    fn manifest_slot_selection_chooses_highest_valid_generation() {
        let first = sample();
        let mut second = first.clone();
        second.generation = 2;
        second.state = MigrationState::SourceScanned;
        second.source_hash = [8; 32];
        let a = first.encode().unwrap();
        let b = second.encode().unwrap();
        let selected = select_latest_slot(Some(&a), Some(&b)).unwrap().unwrap();
        assert_eq!(selected.0, 1);
        assert_eq!(selected.1, second);
    }

    #[test]
    fn manifest_slot_selection_falls_back_to_single_valid_slot_and_fails_closed_if_both_invalid() {
        let valid = sample().encode().unwrap();
        let invalid = b"not a manifest";
        let selected = select_latest_slot(Some(invalid), Some(&valid)).unwrap().unwrap();
        assert_eq!(selected.0, 1);
        assert_eq!(selected.1, sample());
        assert!(select_latest_slot(Some(invalid), Some(invalid)).is_err());
        assert!(select_latest_slot(None, None).unwrap().is_none());
    }

    #[test]
    fn manifest_slot_selection_rejects_conflicting_equal_generations() {
        let first = sample();
        let mut second = first.clone();
        second.state = MigrationState::Aborted;
        let a = first.encode().unwrap();
        let b = second.encode().unwrap();
        assert!(matches!(select_latest_slot(Some(&a), Some(&b)), Err(ManifestError::Invalid(_))));
    }

    #[test]
    fn manifest_store_persists_generations_and_reopens_from_newest_slot() {
        let base = std::env::temp_dir().join(format!("mldb-manifest-{}-{}", std::process::id(), checksum64(&[9, 8, 7])));
        let _ = std::fs::remove_file(slot_path(&base, 0));
        let _ = std::fs::remove_file(slot_path(&base, 1));
        let lock_path = crate::interprocess_lock::lock_path_for(&base).unwrap();
        let _ = std::fs::remove_file(&lock_path);
        {
            let mut store = ManifestStore::open(&base).unwrap();
            let initial = sample();
            store.create(initial.clone()).unwrap();
            let mut next = initial;
            next.generation = 2;
            next.state = MigrationState::SourceScanned;
            next.source_hash = [4; 32];
            store.save(next.clone()).unwrap();
            assert_eq!(store.current(), Some(&next));
        }
        {
            let store = ManifestStore::open(&base).unwrap();
            assert_eq!(store.current().unwrap().generation, 2);
            assert_eq!(store.current().unwrap().state, MigrationState::SourceScanned);
        }
        let _ = std::fs::remove_file(slot_path(&base, 0));
        let _ = std::fs::remove_file(slot_path(&base, 1));
        let _ = std::fs::remove_file(lock_path);
    }

    #[test]
    fn manifest_store_falls_back_when_newer_slot_is_corrupt() {
        let base = std::env::temp_dir().join(format!("mldb-manifest-fallback-{}", std::process::id()));
        let _ = std::fs::remove_file(slot_path(&base, 0));
        let _ = std::fs::remove_file(slot_path(&base, 1));
        let lock_path = crate::interprocess_lock::lock_path_for(&base).unwrap();
        let _ = std::fs::remove_file(&lock_path);
        {
            let mut store = ManifestStore::open(&base).unwrap();
            let initial = sample();
            store.create(initial.clone()).unwrap();
            let mut next = initial;
            next.generation = 2;
            next.state = MigrationState::SourceScanned;
            next.source_hash = [5; 32];
            store.save(next).unwrap();
        }
        std::fs::write(slot_path(&base, 1), b"corrupt").unwrap();
        {
            let store = ManifestStore::open(&base).unwrap();
            assert_eq!(store.current().unwrap().generation, 1);
        }
        let _ = std::fs::remove_file(slot_path(&base, 0));
        let _ = std::fs::remove_file(slot_path(&base, 1));
        let _ = std::fs::remove_file(lock_path);
    }

    #[test]
    fn manifest_store_rejects_identity_changes_and_generation_skips() {
        let base = std::env::temp_dir().join(format!("mldb-manifest-invalid-{}", std::process::id()));
        let _ = std::fs::remove_file(slot_path(&base, 0));
        let _ = std::fs::remove_file(slot_path(&base, 1));
        let lock_path = crate::interprocess_lock::lock_path_for(&base).unwrap();
        let _ = std::fs::remove_file(&lock_path);
        {
            let mut store = ManifestStore::open(&base).unwrap();
            let initial = sample();
            store.create(initial.clone()).unwrap();
            let mut wrong = initial.clone();
            wrong.generation = 3;
            assert!(store.save(wrong).is_err());
            let mut wrong = initial;
            wrong.generation = 2;
            wrong.destination_path.push_str("-changed");
            assert!(store.save(wrong).is_err());
            assert_eq!(store.current().unwrap().generation, 1);
        }
        let _ = std::fs::remove_file(slot_path(&base, 0));
        let _ = std::fs::remove_file(slot_path(&base, 1));
        let _ = std::fs::remove_file(lock_path);
    }

    #[test]
    fn manifest_store_persists_import_progress_within_same_state() {
        let base = std::env::temp_dir().join(format!("mldb-manifest-progress-{}", std::process::id()));
        let _ = std::fs::remove_file(slot_path(&base, 0));
        let _ = std::fs::remove_file(slot_path(&base, 1));
        let lock_path = crate::interprocess_lock::lock_path_for(&base).unwrap();
        let _ = std::fs::remove_file(&lock_path);
        {
            let mut store = ManifestStore::open(&base).unwrap();
            let mut manifest = sample();
            store.create(manifest.clone()).unwrap();
            manifest.transition(MigrationState::SourceScanned).unwrap();
            manifest.source_hash = [3; 32];
            store.save(manifest.clone()).unwrap();
            manifest.transition(MigrationState::Importing).unwrap();
            store.save(manifest.clone()).unwrap();
            manifest.generation += 1;
            manifest.last_batch_sequence = 1;
            manifest.last_batch_records = 1;
            manifest.imported_records = 1;
            manifest.imported_logical_bytes = 12;
            manifest.cursor = b"last-key".to_vec();
            manifest.prefix_hash = [7; 32];
            store.save(manifest.clone()).unwrap();
            assert_eq!(store.current(), Some(&manifest));
        }
        {
            let store = ManifestStore::open(&base).unwrap();
            assert_eq!(store.current().unwrap().imported_records, 1);
            assert_eq!(store.current().unwrap().cursor, b"last-key");
        }
        let _ = std::fs::remove_file(slot_path(&base, 0));
        let _ = std::fs::remove_file(slot_path(&base, 1));
        let _ = std::fs::remove_file(lock_path);
    }

    #[test]
    fn manifest_store_excludes_concurrent_open_and_keeps_previous_generation_on_rejected_save() {
        let base = std::env::temp_dir().join(format!("mldb-manifest-lock-{}", std::process::id()));
        let _ = std::fs::remove_file(slot_path(&base, 0));
        let _ = std::fs::remove_file(slot_path(&base, 1));
        let lock_path = crate::interprocess_lock::lock_path_for(&base).unwrap();
        let _ = std::fs::remove_file(&lock_path);
        {
            let mut store = ManifestStore::open(&base).unwrap();
            store.create(sample()).unwrap();
            assert!(ManifestStore::open(&base).is_err());
            let mut invalid = sample();
            invalid.generation = 2;
            invalid.migration_id = [0x99; 16];
            assert!(store.save(invalid).is_err());
            assert_eq!(store.current().unwrap().generation, 1);
        }
        {
            let store = ManifestStore::open(&base).unwrap();
            assert_eq!(store.current().unwrap().generation, 1);
        }
        let _ = std::fs::remove_file(slot_path(&base, 0));
        let _ = std::fs::remove_file(slot_path(&base, 1));
        let _ = std::fs::remove_file(lock_path);
    }

    #[cfg(unix)]
    #[test]
    fn manifest_slots_are_created_with_private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("mldb-manifest-mode-{}", std::process::id()));
        let _ = std::fs::remove_file(slot_path(&base, 0));
        let _ = std::fs::remove_file(slot_path(&base, 1));
        let lock_path = crate::interprocess_lock::lock_path_for(&base).unwrap();
        let _ = std::fs::remove_file(&lock_path);
        {
            let mut store = ManifestStore::open(&base).unwrap();
            store.create(sample()).unwrap();
        }
        let mode = std::fs::metadata(slot_path(&base, 0)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = std::fs::remove_file(slot_path(&base, 0));
        let _ = std::fs::remove_file(slot_path(&base, 1));
        let _ = std::fs::remove_file(lock_path);
    }

    #[cfg(unix)]
    #[test]
    fn manifest_store_rejects_symlink_slots() {
        use std::os::unix::fs::symlink;
        let base = std::env::temp_dir().join(format!("mldb-manifest-symlink-{}", std::process::id()));
        let victim = std::env::temp_dir().join(format!("mldb-manifest-victim-{}", std::process::id()));
        let _ = std::fs::remove_file(slot_path(&base, 0));
        let _ = std::fs::remove_file(slot_path(&base, 1));
        let _ = std::fs::remove_file(&victim);
        std::fs::write(&victim, b"untouched").unwrap();
        symlink(&victim, slot_path(&base, 0)).unwrap();
        let lock_path = crate::interprocess_lock::lock_path_for(&base).unwrap();
        let _ = std::fs::remove_file(&lock_path);
        assert!(ManifestStore::open(&base).is_err());
        assert_eq!(std::fs::read(&victim).unwrap(), b"untouched");
        let _ = std::fs::remove_file(slot_path(&base, 0));
        let _ = std::fs::remove_file(&victim);
        let _ = std::fs::remove_file(lock_path);
    }

    #[test]
    fn manifest_slot_selection_rejects_different_migration_identities() {
        let first = sample();
        let mut second = first.clone();
        second.generation = 2;
        second.migration_id = [0x77; 16];
        let a = first.encode().unwrap();
        let b = second.encode().unwrap();
        assert!(matches!(
            select_latest_slot(Some(&a), Some(&b)),
            Err(ManifestError::Invalid("los slots pertenecen a migraciones distintas"))
        ));
    }

}
