//! Identidades y manifiestos autocontenidos para publicación conjunta de MLDB.
//! Implementa codecs, working bundles y un selector raíz durable para publicar
//! juntos el almacén vivo y el conocimiento narrativo.
use crate::migration::Sha256;
use crate::interprocess_lock::InterprocessLock;
use std::sync::{Arc, Mutex};

const POINTER_MAGIC: &[u8; 8] = b"MLBND001";
const MANIFEST_MAGIC: &[u8; 8] = b"MLBMF001";
const FORMAT_VERSION: u16 = 1;
const CHECKSUM_BYTES: usize = 32;
const MAX_POINTER_BYTES: usize = 1024;
const MAX_PROJECT_ID_BYTES: usize = 128;
const POINTER_FIXED_BYTES: usize = 8 + 2 + 8 + 16 + 2 + 2 + CHECKSUM_BYTES;
const MANIFEST_FIXED_BYTES: usize = 8 + 2 + 8 + 16 + 2 + 64 + CHECKSUM_BYTES;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BundleFormatError {
    Invalid(&'static str),
    Truncated,
    TrailingBytes,
    UnsupportedVersion(u16),
    ChecksumMismatch,
}
impl std::fmt::Display for BundleFormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "bundle MLDB inválido: {message}"),
            Self::Truncated => write!(f, "bundle MLDB truncado"),
            Self::TrailingBytes => write!(f, "bytes sobrantes en bundle MLDB"),
            Self::UnsupportedVersion(version) => write!(f, "versión de bundle no compatible: {version}"),
            Self::ChecksumMismatch => write!(f, "checksum de bundle incorrecto"),
        }
    }
}
impl std::error::Error for BundleFormatError {}

/// Identidad común que selecciona los dos almacenes como una sola generación.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BundlePointer {
    pub generation: u64,
    pub bundle_id: [u8; 16],
    pub project_id: String,
    pub generation_dir: String,
}
impl BundlePointer {
    pub fn new(
        generation: u64,
        bundle_id: [u8; 16],
        project_id: impl Into<String>,
    ) -> Result<Self, BundleFormatError> {
        let pointer = Self {
            generation,
            bundle_id,
            project_id: project_id.into(),
            generation_dir: bundle_directory_name(generation, &bundle_id),
        };
        pointer.validate()?;
        Ok(pointer)
    }

    pub fn validate(&self) -> Result<(), BundleFormatError> {
        validate_identity(self.generation, &self.project_id)?;
        if self.generation_dir != bundle_directory_name(self.generation, &self.bundle_id) {
            return Err(BundleFormatError::Invalid("el directorio no coincide con la identidad"));
        }
        if self.generation_dir.len() > 128
            || !self.generation_dir.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(BundleFormatError::Invalid("nombre de directorio no permitido"));
        }
        Ok(())
    }

    pub fn encode(&self) -> Result<Vec<u8>, BundleFormatError> {
        self.validate()?;
        let project = self.project_id.as_bytes();
        let directory = self.generation_dir.as_bytes();
        let mut bytes = Vec::with_capacity(POINTER_FIXED_BYTES + project.len() + directory.len());
        bytes.extend_from_slice(POINTER_MAGIC);
        bytes.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        bytes.extend_from_slice(&self.generation.to_le_bytes());
        bytes.extend_from_slice(&self.bundle_id);
        bytes.extend_from_slice(&(project.len() as u16).to_le_bytes());
        bytes.extend_from_slice(project);
        bytes.extend_from_slice(&(directory.len() as u16).to_le_bytes());
        bytes.extend_from_slice(directory);
        append_checksum(&mut bytes);
        if bytes.len() > MAX_POINTER_BYTES {
            return Err(BundleFormatError::Invalid("selector excede el tamaño máximo"));
        }
        Ok(bytes)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, BundleFormatError> {
        if bytes.len() > MAX_POINTER_BYTES {
            return Err(BundleFormatError::Invalid("selector excede el tamaño máximo"));
        }
        if bytes.len() < POINTER_FIXED_BYTES {
            return Err(BundleFormatError::Truncated);
        }
        if &bytes[..8] != POINTER_MAGIC {
            return Err(BundleFormatError::Invalid("magic de selector incorrecto"));
        }
        let version = u16::from_le_bytes(bytes[8..10].try_into().unwrap());
        if version != FORMAT_VERSION {
            return Err(BundleFormatError::UnsupportedVersion(version));
        }
        verify_checksum(bytes)?;
        let generation = u64::from_le_bytes(bytes[10..18].try_into().unwrap());
        let bundle_id = bytes[18..34].try_into().unwrap();
        let project_len = u16::from_le_bytes(bytes[34..36].try_into().unwrap()) as usize;
        let project_end = 36usize.checked_add(project_len).ok_or(BundleFormatError::Truncated)?;
        let directory_len_end = project_end.checked_add(2).ok_or(BundleFormatError::Truncated)?;
        if directory_len_end > bytes.len() - CHECKSUM_BYTES {
            return Err(BundleFormatError::Truncated);
        }
        let project_id = std::str::from_utf8(&bytes[36..project_end])
            .map_err(|_| BundleFormatError::Invalid("project_id no es UTF-8"))?.to_owned();
        let directory_len = u16::from_le_bytes(bytes[project_end..directory_len_end].try_into().unwrap()) as usize;
        let directory_end = directory_len_end.checked_add(directory_len).ok_or(BundleFormatError::Truncated)?;
        if directory_end != bytes.len() - CHECKSUM_BYTES {
            return if directory_end > bytes.len() - CHECKSUM_BYTES {
                Err(BundleFormatError::Truncated)
            } else {
                Err(BundleFormatError::TrailingBytes)
            };
        }
        let generation_dir = std::str::from_utf8(&bytes[directory_len_end..directory_end])
            .map_err(|_| BundleFormatError::Invalid("directorio no es UTF-8"))?.to_owned();
        let pointer = Self { generation, bundle_id, project_id, generation_dir };
        pointer.validate()?;
        Ok(pointer)
    }
}

/// Manifiesto que enlaza los dos receipts inmutables de una misma generación.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BundleManifest {
    pub generation: u64,
    pub bundle_id: [u8; 16],
    pub project_id: String,
    pub live_receipt_sha256: [u8; 32],
    pub knowledge_receipt_sha256: [u8; 32],
}
impl BundleManifest {
    pub fn new(
        pointer: &BundlePointer,
        live_receipt_sha256: [u8; 32],
        knowledge_receipt_sha256: [u8; 32],
    ) -> Result<Self, BundleFormatError> {
        pointer.validate()?;
        Ok(Self {
            generation: pointer.generation,
            bundle_id: pointer.bundle_id,
            project_id: pointer.project_id.clone(),
            live_receipt_sha256,
            knowledge_receipt_sha256,
        })
    }

    pub fn validate(&self) -> Result<(), BundleFormatError> {
        validate_identity(self.generation, &self.project_id)
    }

    /// Construye el manifiesto calculando internamente los hashes de ambos receipts.
    pub fn from_receipt_bytes(
        pointer: &BundlePointer,
        live_receipt: &[u8],
        knowledge_receipt: &[u8],
    ) -> Result<Self, BundleFormatError> {
        Self::new(pointer, bundle_hash(live_receipt), bundle_hash(knowledge_receipt))
    }

    pub fn matches_pointer(&self, pointer: &BundlePointer) -> bool {
        self.generation == pointer.generation
            && self.bundle_id == pointer.bundle_id
            && self.project_id == pointer.project_id
    }

    pub fn encode(&self) -> Result<Vec<u8>, BundleFormatError> {
        self.validate()?;
        let project = self.project_id.as_bytes();
        let mut bytes = Vec::with_capacity(MANIFEST_FIXED_BYTES + project.len());
        bytes.extend_from_slice(MANIFEST_MAGIC);
        bytes.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        bytes.extend_from_slice(&self.generation.to_le_bytes());
        bytes.extend_from_slice(&self.bundle_id);
        bytes.extend_from_slice(&(project.len() as u16).to_le_bytes());
        bytes.extend_from_slice(project);
        bytes.extend_from_slice(&self.live_receipt_sha256);
        bytes.extend_from_slice(&self.knowledge_receipt_sha256);
        append_checksum(&mut bytes);
        Ok(bytes)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, BundleFormatError> {
        if bytes.len() < MANIFEST_FIXED_BYTES {
            return Err(BundleFormatError::Truncated);
        }
        if &bytes[..8] != MANIFEST_MAGIC {
            return Err(BundleFormatError::Invalid("magic de manifiesto incorrecto"));
        }
        let version = u16::from_le_bytes(bytes[8..10].try_into().unwrap());
        if version != FORMAT_VERSION {
            return Err(BundleFormatError::UnsupportedVersion(version));
        }
        verify_checksum(bytes)?;
        let generation = u64::from_le_bytes(bytes[10..18].try_into().unwrap());
        let bundle_id = bytes[18..34].try_into().unwrap();
        let project_len = u16::from_le_bytes(bytes[34..36].try_into().unwrap()) as usize;
        let project_end = 36usize.checked_add(project_len).ok_or(BundleFormatError::Truncated)?;
        let expected_end = project_end.checked_add(64).ok_or(BundleFormatError::Truncated)?;
        if expected_end != bytes.len() - CHECKSUM_BYTES {
            return if expected_end > bytes.len() - CHECKSUM_BYTES {
                Err(BundleFormatError::Truncated)
            } else {
                Err(BundleFormatError::TrailingBytes)
            };
        }
        let project_id = std::str::from_utf8(&bytes[36..project_end])
            .map_err(|_| BundleFormatError::Invalid("project_id no es UTF-8"))?.to_owned();
        let manifest = Self {
            generation,
            bundle_id,
            project_id,
            live_receipt_sha256: bytes[project_end..project_end + 32].try_into().unwrap(),
            knowledge_receipt_sha256: bytes[project_end + 32..expected_end].try_into().unwrap(),
        };
        manifest.validate()?;
        Ok(manifest)
    }
}

fn validate_identity(generation: u64, project_id: &str) -> Result<(), BundleFormatError> {
    if generation == 0 {
        return Err(BundleFormatError::Invalid("generación cero"));
    }
    if project_id.trim().is_empty()
        || project_id.len() > MAX_PROJECT_ID_BYTES
        || project_id.chars().any(char::is_control)
    {
        return Err(BundleFormatError::Invalid("project_id vacío, demasiado largo o con controles"));
    }
    Ok(())
}

fn bundle_directory_name(generation: u64, bundle_id: &[u8; 16]) -> String {
    let mut hex = String::with_capacity(32);
    for byte in bundle_id {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    format!("bundle-gen-{generation}-{hex}")
}

fn append_checksum(bytes: &mut Vec<u8>) {
    let mut hash = Sha256::new();
    hash.update(bytes);
    bytes.extend_from_slice(&hash.finish());
}

fn verify_checksum(bytes: &[u8]) -> Result<(), BundleFormatError> {
    if bytes.len() < CHECKSUM_BYTES {
        return Err(BundleFormatError::Truncated);
    }
    let checksum_at = bytes.len() - CHECKSUM_BYTES;
    let mut hash = Sha256::new();
    hash.update(&bytes[..checksum_at]);
    if hash.finish().as_slice() != &bytes[checksum_at..] {
        return Err(BundleFormatError::ChecksumMismatch);
    }
    Ok(())
}



const BUNDLE_WORKING_MAGIC: &[u8; 8] = b"MLBWRK01";
const BUNDLE_WORKING_VERSION: u16 = 1;
const MAX_BUNDLE_WORKING_BYTES: usize = 8 + 2 + 16 + 2 + MAX_POINTER_BYTES + CHECKSUM_BYTES;

struct BundleWorkingManifest {
    working_id: [u8; 16],
    base: BundlePointer,
}
impl BundleWorkingManifest {
    fn encode(&self) -> Result<Vec<u8>, BundleFormatError> {
        let pointer = self.base.encode()?;
        let mut bytes = Vec::with_capacity(8 + 2 + 16 + 2 + pointer.len() + CHECKSUM_BYTES);
        bytes.extend_from_slice(BUNDLE_WORKING_MAGIC);
        bytes.extend_from_slice(&BUNDLE_WORKING_VERSION.to_le_bytes());
        bytes.extend_from_slice(&self.working_id);
        bytes.extend_from_slice(&(pointer.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&pointer);
        append_checksum(&mut bytes);
        Ok(bytes)
    }

    fn decode(bytes: &[u8]) -> Result<Self, BundleFormatError> {
        if bytes.len() > MAX_BUNDLE_WORKING_BYTES {
            return Err(BundleFormatError::Invalid("manifiesto de trabajo supera tamaño máximo"));
        }
        if bytes.len() < 8 + 2 + 16 + 2 + CHECKSUM_BYTES {
            return Err(BundleFormatError::Truncated);
        }
        if &bytes[..8] != BUNDLE_WORKING_MAGIC {
            return Err(BundleFormatError::Invalid("magic de working bundle incorrecto"));
        }
        let version = u16::from_le_bytes(bytes[8..10].try_into().unwrap());
        if version != BUNDLE_WORKING_VERSION {
            return Err(BundleFormatError::UnsupportedVersion(version));
        }
        verify_checksum(bytes)?;
        let working_id = bytes[10..26].try_into().unwrap();
        let pointer_len = u16::from_le_bytes(bytes[26..28].try_into().unwrap()) as usize;
        let pointer_end = 28usize.checked_add(pointer_len).ok_or(BundleFormatError::Truncated)?;
        if pointer_end != bytes.len() - CHECKSUM_BYTES {
            return if pointer_end > bytes.len() - CHECKSUM_BYTES {
                Err(BundleFormatError::Truncated)
            } else {
                Err(BundleFormatError::TrailingBytes)
            };
        }
        let base = BundlePointer::decode(&bytes[28..pointer_end])?;
        Ok(Self { working_id, base })
    }
}

/// Sesión mutable conjunta. No mantiene abiertos los ProjectStore: el anfitrión
/// puede abrir ambos archivos con HostEngineApi. El lock de sesión evita dos
/// anfitriones concurrentes sobre el mismo working bundle.
pub struct WorkingBundle {
    directory: PathBuf,
    working_id: [u8; 16],
    base: BundlePointer,
    _session_lock: Arc<Mutex<InterprocessLock>>,
}
impl WorkingBundle {
    fn open_directory(
        directory: PathBuf,
        working_id: [u8; 16],
        expected_base: BundlePointer,
    ) -> Result<Self, BundlePublicationError> {
        ensure_private_bundle_directory(&directory)?;
        let parent = directory.parent()
            .ok_or(BundlePublicationError::Invalid("working bundle sin directorio padre"))?;
        ensure_private_bundle_directory(parent)?;
        let lock = Arc::new(Mutex::new(InterprocessLock::acquire_for(directory.join("SESSION"))
            .map_err(|error| BundlePublicationError::Io(error.to_string()))?));
        let manifest = read_bundle_working_manifest(&directory)?;
        if manifest.working_id != working_id || manifest.base != expected_base {
            return Err(BundlePublicationError::Invalid("manifiesto de working bundle no coincide con identidad/base"));
        }
        // Validar los directorios intermedios: comprobar solo el archivo
        // final no detecta que live/ o knowledge/ hayan sido sustituidos
        // por enlaces simbólicos hacia otra ubicación.
        ensure_private_bundle_directory(&directory.join("live"))?;
        ensure_private_bundle_directory(&directory.join("knowledge"))?;
        for path in [
            directory.join("live/store.pages"),
            directory.join("live/store.mlpj"),
            directory.join("knowledge/store.pages"),
            directory.join("knowledge/store.mlpj"),
        ] {
            let metadata = fs::symlink_metadata(&path).map_err(bundle_io)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(BundlePublicationError::Invalid("archivo de working bundle ausente o no regular"));
            }
            ensure_private_bundle_file(&path)?;
        }
        ensure_private_bundle_file(&directory.join("WORKING.MANIFEST"))?;
        Ok(Self { directory, working_id, base: expected_base, _session_lock: lock })
    }

    pub fn validate_session_lock(&self) -> Result<(), BundlePublicationError> {
        self._session_lock.lock()
            .map_err(|_| BundlePublicationError::Invalid("lock de sesión envenenado"))?
            .validate_identity()
            .map_err(|error| BundlePublicationError::Io(error.to_string()))
    }

    /// Validador compartido que permite al worker comprobar el lock justo antes
    /// de cada operación durable, sin transferir ni duplicar el bloqueo del kernel.
    pub fn session_lock_validator(&self) -> SessionLockValidator {
        SessionLockValidator { lock: Arc::clone(&self._session_lock) }
    }

    pub fn working_id(&self) -> [u8; 16] { self.working_id }
    pub fn base_generation(&self) -> u64 { self.base.generation }
    pub fn project_id(&self) -> &str { &self.base.project_id }
    pub fn live_pages(&self) -> PathBuf { self.directory.join("live/store.pages") }
    pub fn live_wal(&self) -> PathBuf { self.directory.join("live/store.mlpj") }
    pub fn knowledge_pages(&self) -> PathBuf { self.directory.join("knowledge/store.pages") }
    pub fn knowledge_wal(&self) -> PathBuf { self.directory.join("knowledge/store.mlpj") }
    pub fn paths(&self) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        (self.live_pages(), self.live_wal(), self.knowledge_pages(), self.knowledge_wal())
    }
}

/// Validador clonable de identidad del lock que protege una working bundle.
#[derive(Clone)]
pub struct SessionLockValidator {
    lock: Arc<Mutex<InterprocessLock>>,
}
impl SessionLockValidator {
    pub fn validate(&self) -> Result<(), String> {
        self.lock.lock()
            .map_err(|_| "lock de sesión envenenado".to_owned())?
            .validate_identity()
            .map_err(|error| error.to_string())
    }
}

fn write_bundle_working_manifest(
    directory: &Path,
    working_id: [u8; 16],
    base: &BundlePointer,
) -> Result<(), BundlePublicationError> {
    let bytes = BundleWorkingManifest { working_id, base: base.clone() }.encode()?;
    write_bundle_immutable_file(&directory.join("WORKING.MANIFEST"), &bytes)
}

fn read_bundle_working_manifest(directory: &Path) -> Result<BundleWorkingManifest, BundlePublicationError> {
    ensure_bundle_directory(directory)?;
    let bytes = read_bundle_regular_file(&directory.join("WORKING.MANIFEST"), MAX_BUNDLE_WORKING_BYTES)?;
    BundleWorkingManifest::decode(&bytes).map_err(Into::into)
}

fn write_bundle_manifest(directory: &Path, manifest: &BundleManifest) -> Result<(), BundlePublicationError> {
    write_bundle_immutable_file(&directory.join("BUNDLE.MANIFEST"), &manifest.encode()?)
}

fn write_bundle_immutable_file(path: &Path, bytes: &[u8]) -> Result<(), BundlePublicationError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(bundle_io)?;
    file.write_all(bytes).map_err(bundle_io)?;
    file.sync_all().map_err(bundle_io)?;
    Ok(())
}

fn copy_published_member(
    source: &mut PublishedProjectStore,
    directory: &Path,
    project_id: &str,
) -> Result<(), BundlePublicationError> {
    let source_validation = source.validate()
        .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
    let pages = directory.join("store.pages");
    let wal = directory.join("store.mlpj");
    let mut target = crate::project_store::ProjectStore::open(&pages, &wal)
        .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
    let mut copied = 0u64;
    {
        let mut records = source.scan_all_iter()
            .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
        while let Some(record) = records.next() {
            let (record_project, table, id, value) = record
                .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
            if record_project != project_id {
                return Err(BundlePublicationError::Invalid("el almacén contiene registros de otro proyecto"));
            }
            target.put_project(&record_project, &table, &id, &value)
                .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
            copied = copied.checked_add(1)
                .ok_or(BundlePublicationError::Invalid("contador de registros desbordado"))?;
        }
    }
    if copied != source_validation.entries as u64 {
        return Err(BundlePublicationError::Invalid("el recuento de working bundle difiere del origen"));
    }
    target.checkpoint().map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
    let target_validation = target.validate()
        .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
    if target_validation.entries != source_validation.entries {
        return Err(BundlePublicationError::Invalid("validación de working bundle no coincide con origen"));
    }
    drop(target);
    set_bundle_private_file(&pages)?;
    set_bundle_private_file(&wal)?;
    Ok(())
}

fn validate_bundle_project(
    store: &mut crate::project_store::ProjectStore,
    project_id: &str,
) -> Result<(), BundlePublicationError> {
    let mut records = store.scan_all_iter()
        .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
    while let Some(record) = records.next() {
        let (record_project, _, _, _) = record
            .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
        if record_project != project_id {
            return Err(BundlePublicationError::Invalid("working store contiene registros de otro proyecto"));
        }
    }
    drop(records);
    store.validate().map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
    Ok(())
}

fn copy_bundle_file_synced(source: &Path, destination: &Path) -> Result<FileDigest, BundlePublicationError> {
    // Abrir sin seguir symlinks en el kernel cuando la plataforma lo permite.
    // Todas las lecturas posteriores se hacen desde este descriptor.
    let before = fs::symlink_metadata(source).map_err(bundle_io)?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(BundlePublicationError::Invalid("origen de copia no es archivo regular"));
    }
    let mut input_options = OpenOptions::new();
    input_options.read(true);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        input_options.custom_flags(0o400000);
    }
    let mut input = input_options.open(source).map_err(bundle_io)?;
    let opened = input.metadata().map_err(bundle_io)?;
    let current = fs::symlink_metadata(source).map_err(bundle_io)?;
    if !opened.is_file() || current.file_type().is_symlink()
        || !same_bundle_file(&before, &opened)
        || !same_bundle_file(&opened, &current)
        || !bundle_file_snapshot_matches(&before, &opened)
    {
        return Err(BundlePublicationError::Invalid("origen cambió durante apertura"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if opened.nlink() != 1 || opened.permissions().mode() & 0o077 != 0 {
            return Err(BundlePublicationError::Invalid("origen de copia tiene hardlinks o no es privado"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.number_of_links() != Some(1) {
            return Err(BundlePublicationError::Invalid("origen de copia tiene hardlinks"));
        }
    }

    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(destination).map_err(bundle_io)?;
    let copied = std::io::copy(&mut input, &mut output).map_err(bundle_io)?;
    output.sync_all().map_err(bundle_io)?;

    // Verificar descriptor y ruta de origen después de copiar, antes de crear receipts.
    let after = input.metadata().map_err(bundle_io)?;
    let path_after = fs::symlink_metadata(source).map_err(bundle_io)?;
    if !same_bundle_file(&opened, &after)
        || !same_bundle_file(&after, &path_after)
        || !bundle_file_snapshot_matches(&opened, &after)
        || path_after.file_type().is_symlink()
        || copied != opened.len()
    {
        return Err(BundlePublicationError::Invalid("origen cambió durante copia"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if after.nlink() != 1 || path_after.nlink() != 1
            || after.permissions().mode() & 0o077 != 0
            || path_after.permissions().mode() & 0o077 != 0
        {
            return Err(BundlePublicationError::Invalid("origen adquirió hardlinks o perdió privacidad durante copia"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if after.number_of_links() != Some(1) || path_after.number_of_links() != Some(1) {
            return Err(BundlePublicationError::Invalid("origen adquirió hardlinks durante copia"));
        }
    }

    // El hash se calcula sobre el mismo descriptor de destino que recibió los
    // bytes, evitando reabrir una ruta que pudiera haberse sustituido.
    output.seek(SeekFrom::Start(0)).map_err(bundle_io)?;
    let digest = digest_open_bundle_file(&mut output)?;
    let destination_path = fs::symlink_metadata(destination).map_err(bundle_io)?;
    let destination_opened = output.metadata().map_err(bundle_io)?;
    if !same_bundle_file(&destination_opened, &destination_path)
        || !bundle_file_snapshot_matches(&destination_opened, &destination_path)
        || digest.length != copied
    {
        return Err(BundlePublicationError::Invalid("destino de copia cambió durante verificación"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if destination_opened.nlink() != 1 || destination_path.nlink() != 1
            || destination_opened.permissions().mode() & 0o077 != 0
            || destination_path.permissions().mode() & 0o077 != 0
        {
            return Err(BundlePublicationError::Invalid("destino de copia compartido o no privado"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if destination_opened.number_of_links() != Some(1)
            || destination_path.number_of_links() != Some(1)
        {
            return Err(BundlePublicationError::Invalid("destino de copia tiene hardlinks"));
        }
    }
    Ok(digest)
}

fn bundle_file_snapshot_matches(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    if left.len() != right.len() || left.modified().ok() != right.modified().ok() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.ctime() == right.ctime() && left.ctime_nsec() == right.ctime_nsec()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        left.creation_time() == right.creation_time()
            && left.last_write_time() == right.last_write_time()
    }
    #[cfg(not(any(unix, windows)))]
    {
        true
    }
}

fn ensure_private_bundle_directory(path: &Path) -> Result<(), BundlePublicationError> {
    ensure_bundle_directory(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path).map_err(bundle_io)?.permissions().mode();
        if mode & 0o077 != 0 {
            return Err(BundlePublicationError::Invalid("directorio de working bundle no es privado"));
        }
    }
    Ok(())
}

fn verify_working_bundle_descriptor(path: &Path, file: &File) -> std::io::Result<()> {
    let opened = file.metadata()?;
    let current = fs::symlink_metadata(path)?;
    if !opened.is_file() || current.file_type().is_symlink() || !current.is_file()
        || !same_bundle_file(&opened, &current)
        || !bundle_file_snapshot_matches(&opened, &current)
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "descriptor de working bundle no coincide con su ruta",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if opened.permissions().mode() & 0o077 != 0 || opened.nlink() != 1 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "descriptor de working bundle no es privado o tiene hardlinks",
            ));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.number_of_links() != Some(1) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "descriptor de working bundle tiene hardlinks",
            ));
        }
    }
    Ok(())
}

fn ensure_private_bundle_file(path: &Path) -> Result<(), BundlePublicationError> {
    let metadata = fs::symlink_metadata(path).map_err(bundle_io)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(BundlePublicationError::Invalid("archivo privado de working bundle no es regular"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(BundlePublicationError::Invalid("archivo de working bundle no es privado"));
        }
        // Los archivos de una working copy deben tener identidad exclusiva.
        // Un hardlink permitiría modificar o exponer datos desde otra ruta.
        if metadata.nlink() != 1 {
            return Err(BundlePublicationError::Invalid("archivo de working bundle tiene hardlinks externos"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.number_of_links() != Some(1) {
            return Err(BundlePublicationError::Invalid("archivo de working bundle tiene hardlinks externos"));
        }
    }
    Ok(())
}

fn create_bundle_private_directory(path: &Path) -> std::io::Result<()> {
    fs::create_dir(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn set_bundle_private_file(path: &Path) -> Result<(), BundlePublicationError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(bundle_io)?;
    }
    Ok(())
}

fn bundle_working_directory_name(working_id: &[u8; 16]) -> String {
    let mut hex = String::with_capacity(32);
    for byte in working_id {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    format!("bundle-working-{hex}")
}

fn bundle_path_exists(path: &Path) -> Result<bool, BundlePublicationError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(bundle_io(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_pointer_roundtrips_and_binds_project_and_directory() {
        let pointer = BundlePointer::new(7, [0x4a; 16], "novel-main").unwrap();
        assert_eq!(BundlePointer::decode(&pointer.encode().unwrap()).unwrap(), pointer);
        let mut altered = pointer;
        altered.generation_dir = "../outside".into();
        assert!(matches!(altered.encode(), Err(BundleFormatError::Invalid(_))));
    }

    #[test]
    fn bundle_pointer_rejects_truncation_trailing_bytes_and_checksum_damage() {
        let pointer = BundlePointer::new(1, [0x51; 16], "book").unwrap();
        let encoded = pointer.encode().unwrap();
        assert_eq!(BundlePointer::decode(&encoded[..encoded.len() - 1]), Err(BundleFormatError::Truncated));
        let mut trailing = encoded.clone();
        trailing.insert(trailing.len() - CHECKSUM_BYTES, 0);
        assert_eq!(BundlePointer::decode(&trailing), Err(BundleFormatError::TrailingBytes));
        let mut damaged = encoded;
        damaged[20] ^= 1;
        assert_eq!(BundlePointer::decode(&damaged), Err(BundleFormatError::ChecksumMismatch));
    }

    #[test]
    fn bundle_manifest_roundtrips_and_rejects_cross_project_identity() {
        let pointer = BundlePointer::new(3, [0x61; 16], "book-A").unwrap();
        let manifest = BundleManifest::new(&pointer, [0x11; 32], [0x22; 32]).unwrap();
        assert_eq!(BundleManifest::decode(&manifest.encode().unwrap()).unwrap(), manifest);
        assert!(manifest.matches_pointer(&pointer));
        let other = BundlePointer::new(3, [0x61; 16], "book-B").unwrap();
        assert!(!manifest.matches_pointer(&other));
    }

    #[test]
    fn bundle_manifest_rejects_truncation_trailing_bytes_and_checksum_damage() {
        let pointer = BundlePointer::new(2, [0x71; 16], "book").unwrap();
        let encoded = BundleManifest::new(&pointer, [0x31; 32], [0x32; 32]).unwrap().encode().unwrap();
        assert_eq!(BundleManifest::decode(&encoded[..encoded.len() - 1]), Err(BundleFormatError::Truncated));
        let mut trailing = encoded.clone();
        trailing.insert(trailing.len() - CHECKSUM_BYTES, 0);
        assert_eq!(BundleManifest::decode(&trailing), Err(BundleFormatError::TrailingBytes));
        let mut damaged = encoded;
        damaged[35] ^= 1;
        assert_eq!(BundleManifest::decode(&damaged), Err(BundleFormatError::ChecksumMismatch));
    }

    #[test]
    fn bundle_identity_rejects_zero_generation_and_invalid_project_id() {
        assert!(matches!(BundlePointer::new(0, [0; 16], "book"), Err(BundleFormatError::Invalid(_))));
        assert!(matches!(BundlePointer::new(1, [0; 16], "  "), Err(BundleFormatError::Invalid(_))));
        assert!(matches!(BundlePointer::new(1, [0; 16], "x\nbook"), Err(BundleFormatError::Invalid(_))));
    }
}


use crate::interprocess_lock::InterprocessLock;
use crate::publication::{FileDigest, GenerationReceipt, PublishedProjectStore};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const MAX_BUNDLE_MANIFEST_BYTES: usize = 512;
const BUNDLE_RECEIPT_BYTES: usize = 8 + 2 + 8 + 16 + 8 + 8 + 32 + 32 + 32;

/// Selector raíz: ambos almacenes quedan activados por el mismo puntero durable.
/// No expone operaciones para publicar miembros individuales.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BundlePublishStage {
    InactiveSlotCleared,
    SelectorTempSynced,
    SelectorLinked,
    SelectorTempRemoved,
    RootDirectorySynced,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BundleBuildStage {
    LiveCheckpointed,
    KnowledgeCheckpointed,
    LivePagesCopied,
    LiveWalCopied,
    KnowledgePagesCopied,
    KnowledgeWalCopied,
    LiveReceiptWritten,
    KnowledgeReceiptWritten,
    BundleManifestWritten,
    GenerationDirectoriesSynced,
}


/// Inventario conservador de generaciones no referenciadas. No elimina datos:
/// la limpieza física requiere una política de retención y confirmación explícita.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BundleOrphanInventory {
    pub unreferenced_generation_directories: Vec<String>,
    /// Temporales de creación incompletos. Se informan, nunca se adoptan ni borran.
    pub abandoned_working_temporaries: Vec<String>,
    /// Temporales de selector persistidos antes de completar el hard link.
    pub abandoned_selector_temporaries: Vec<String>,
    /// Directorios de generación creados pero sin manifiesto de bundle completo.
    pub incomplete_generation_directories: Vec<String>,
    /// Working bundles cuyo lock de sesión está adquirido en el momento del inventario.
    pub active_working_bundles: Vec<String>,
    /// Working bundles válidas cuyo lock no está adquirido en el momento del inventario.
    /// Es una observación puntual, no una autorización para borrarlas.
    pub inactive_working_bundles: Vec<String>,
}

pub struct BundlePublicationStore {
    root: PathBuf,
    active_slot: Option<usize>,
    current: Option<BundlePointer>,
    _lock: InterprocessLock,
    recovery_required: bool,
}

impl BundlePublicationStore {
    fn validate_root_lock(&self) -> Result<(), BundlePublicationError> {
        self._lock.validate_identity()
            .map_err(|error| BundlePublicationError::Io(error.to_string()))
    }

    pub fn open(root: impl AsRef<Path>) -> Result<Self, BundlePublicationError> {
        let requested = root.as_ref();
        fs::create_dir_all(requested).map_err(bundle_io)?;
        let metadata = fs::symlink_metadata(requested).map_err(bundle_io)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(BundlePublicationError::Invalid("raíz no es directorio regular"));
        }
        let root = fs::canonicalize(requested).map_err(bundle_io)?;
        let lock = InterprocessLock::acquire_for(root.join("CURRENT"))
            .map_err(|error| BundlePublicationError::Io(error.to_string()))?;
        lock.validate_identity().map_err(|error| BundlePublicationError::Io(error.to_string()))?;
        let left = read_bundle_slot(&root.join("CURRENT.0"))?;
        let right = read_bundle_slot(&root.join("CURRENT.1"))?;
        let (active_slot, current) = select_bundle_slots(left, right)?;
        let store = Self { root, active_slot, current, _lock: lock, recovery_required: false };
        if let Some(pointer) = store.current.as_ref() {
            store.verify_generation(pointer)?;
        }
        store.validate_root_lock()?;
        Ok(store)
    }

    /// Enumera directorios de generación que no están protegidos por ninguno
    /// de los dos slots ni por una working bundle válida. Nunca borra archivos.
    /// Si encuentra metadatos ambiguos, symlinks o manifiestos de trabajo dañados,
    /// falla cerrado y no emite candidatos de limpieza.
    pub fn inspect_unreferenced_generations(&self) -> Result<BundleOrphanInventory, BundlePublicationError> {
        self.validate_root_lock()?;
        let generations = self.root.join("generations");
        let working = self.root.join("working");
        ensure_bundle_directory_chain(&self.root, &self.root)?;
        // El lock raíz excluye escritores cooperativos. Estos snapshots añaden
        // detección fail-closed si otro proceso altera los contenedores durante
        // el recorrido: una lista mezclada nunca se devuelve como inventario.
        let working_snapshot = capture_optional_bundle_directory(&working)?;
        let generations_snapshot = capture_optional_bundle_directory(&generations)?;
        let mut protected = std::collections::HashSet::<String>::new();
        let mut abandoned_working_temporaries = Vec::new();
        let mut abandoned_working_temporary_snapshots = Vec::new();
        let mut abandoned_selector_temporaries = Vec::new();
        let mut incomplete_generation_directories = Vec::new();
        let mut active_working_bundles = Vec::new();
        let mut inactive_working_bundles = Vec::new();

        // Un temporal de selector nunca es autoridad de publicación. Se inspecciona
        // para diagnóstico, pero jamás se adopta ni se elimina automáticamente.
        for entry in fs::read_dir(&self.root).map_err(bundle_io)? {
            let entry = entry.map_err(bundle_io)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with(".CURRENT.") || !name.ends_with(".tmp") {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(bundle_io)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_POINTER_BYTES as u64 {
                return Err(BundlePublicationError::Invalid("temporal de selector no es archivo regular válido"));
            }
            let temporary_snapshot = metadata;
            let pieces: Vec<&str> = name.trim_start_matches(".CURRENT.").trim_end_matches(".tmp").split('.').collect();
            if pieces.len() != 2 || !matches!(pieces[0], "0" | "1") {
                return Err(BundlePublicationError::Invalid("nombre de temporal de selector inválido"));
            }
            let generation: u64 = pieces[1].parse()
                .map_err(|_| BundlePublicationError::Invalid("generación temporal de selector inválida"))?;
            // Un temporal aún enlazado al slot puede compartir inode tras
            // una caída justo después del hard link; solo se inspecciona.
            let pointer = BundlePointer::decode(
                &read_bundle_regular_file_internal(&entry.path(), MAX_POINTER_BYTES, false)?
            )?;
            if pointer.generation != generation {
                return Err(BundlePublicationError::Invalid("temporal de selector no coincide con su nombre"));
            }
            // El temporal no es autoridad de publicación. Aun así, no se debe
            // clasificar a partir de bytes leídos de un archivo que fue sustituido
            // durante la inspección.
            let after = fs::symlink_metadata(entry.path()).map_err(bundle_io)?;
            if after.file_type().is_symlink() || !after.is_file()
                || !same_bundle_file(&temporary_snapshot, &after)
                || !bundle_file_snapshot_matches(&temporary_snapshot, &after)
            {
                return Err(BundlePublicationError::Invalid("temporal de selector cambió durante el inventario"));
            }
            abandoned_selector_temporaries.push(name);
        }

        for slot in [0, 1] {
            if let Some(pointer) = read_bundle_slot(
                &self.root.join(if slot == 0 { "CURRENT.0" } else { "CURRENT.1" })
            )? {
                protected.insert(pointer.generation_dir);
            }
        }

        match fs::symlink_metadata(&working) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(BundlePublicationError::Invalid("directorio working no regular durante inventario"));
                }
                for entry in fs::read_dir(&working).map_err(bundle_io)? {
                    let entry = entry.map_err(bundle_io)?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.starts_with(".bundle-working-") && name.ends_with(".tmp") {
                        let metadata = fs::symlink_metadata(entry.path()).map_err(bundle_io)?;
                        if metadata.file_type().is_symlink() || !metadata.is_dir() {
                            return Err(BundlePublicationError::Invalid("temporal de working bundle no es directorio regular"));
                        }
                        let temporary_path = entry.path();
                        abandoned_working_temporary_snapshots.push((
                            temporary_path.clone(),
                            capture_bundle_inventory_node(&temporary_path, true)?,
                        ));
                        abandoned_working_temporaries.push(name);
                        continue;
                    }
                    if !name.starts_with("bundle-working-") {
                        return Err(BundlePublicationError::Invalid("entrada desconocida en directorio working"));
                    }
                    let metadata = fs::symlink_metadata(entry.path()).map_err(bundle_io)?;
                    if metadata.file_type().is_symlink() || !metadata.is_dir() {
                        return Err(BundlePublicationError::Invalid("working bundle no regular durante inventario"));
                    }
                    let mut member_snapshots = vec![(
                        entry.path(),
                        capture_bundle_inventory_node(&entry.path(), true)?,
                        true,
                    )];
                    let manifest = read_bundle_working_manifest(&entry.path())?;
                    if bundle_working_directory_name(&manifest.working_id) != name {
                        return Err(BundlePublicationError::Invalid("nombre e ID de working bundle no coinciden"));
                    }
                    // Una carpeta con nombre definitivo solo cuenta como working
                    // bundle válida si conserva los dos miembros y los cuatro
                    // archivos persistentes. No basta con que sobreviva el
                    // manifiesto: una copia truncada no puede proteger una base
                    // como si fuera reanudable ni ser candidata a una limpieza.
                    let manifest_file = entry.path().join("WORKING.MANIFEST");
                    member_snapshots.push((
                        manifest_file.clone(),
                        capture_bundle_inventory_node(&manifest_file, false)?,
                        false,
                    ));
                    for member_dir in [entry.path().join("live"), entry.path().join("knowledge")] {
                        ensure_private_bundle_directory(&member_dir)?;
                        member_snapshots.push((
                            member_dir.clone(),
                            capture_bundle_inventory_node(&member_dir, true)?,
                            true,
                        ));
                    }
                    for member_file in [
                        entry.path().join("live/store.pages"),
                        entry.path().join("live/store.mlpj"),
                        entry.path().join("knowledge/store.pages"),
                        entry.path().join("knowledge/store.mlpj"),
                    ] {
                        ensure_private_bundle_file(&member_file)?;
                        member_snapshots.push((
                            member_file.clone(),
                            capture_bundle_inventory_node(&member_file, false)?,
                            false,
                        ));
                    }
                    // No basta con conservar la generación base: el inventario
                    // también distingue sesiones vivas de copias abandonadas.
                    // Solo se adquiere el lock para observarlo; nunca se modifica
                    // ni elimina la working bundle durante esta operación.
                    let session_lock_path = crate::interprocess_lock::lock_path_for(
                        &entry.path().join("SESSION")
                    ).map_err(|error| BundlePublicationError::Io(error.to_string()))?;
                    ensure_private_bundle_file(&session_lock_path)?;
                    member_snapshots.push((
                        session_lock_path.clone(),
                        capture_bundle_inventory_node(&session_lock_path, false)?,
                        false,
                    ));
                    match InterprocessLock::acquire_existing_for(entry.path().join("SESSION")) {
                        Ok(probe) => {
                            drop(probe);
                            inactive_working_bundles.push(name.clone());
                        }
                        Err(crate::interprocess_lock::LockError::AlreadyLocked) => {
                            active_working_bundles.push(name.clone());
                        }
                        Err(error) => return Err(BundlePublicationError::Io(error.to_string())),
                    }
                    for (member_path, snapshot, is_directory) in &member_snapshots {
                        verify_bundle_inventory_node(member_path, snapshot, *is_directory)?;
                    }
                    protected.insert(manifest.base.generation_dir);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(bundle_io(error)),
        }

        let mut candidates = Vec::new();
        match fs::symlink_metadata(&generations) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(BundlePublicationError::Invalid("directorio generations no regular durante inventario"));
                }
                for entry in fs::read_dir(&generations).map_err(bundle_io)? {
                    let entry = entry.map_err(bundle_io)?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if !name.starts_with("bundle-gen-") {
                        return Err(BundlePublicationError::Invalid("entrada desconocida en directorio generations"));
                    }
                    // Validar el tipo del nodo antes de omitir generaciones
                    // protegidas. Una referencia en CURRENT/WORKING no vuelve
                    // confiable un symlink colocado en su lugar.
                    let metadata = fs::symlink_metadata(entry.path()).map_err(bundle_io)?;
                    if metadata.file_type().is_symlink() || !metadata.is_dir() {
                        return Err(BundlePublicationError::Invalid("candidato de generación no es directorio regular"));
                    }
                    let directory_snapshot = metadata;
                    if protected.contains(&name) {
                        continue;
                    }
                    let manifest_path = entry.path().join("BUNDLE.MANIFEST");
                    match fs::symlink_metadata(&manifest_path) {
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            incomplete_generation_directories.push(name);
                        }
                        Err(error) => return Err(bundle_io(error)),
                        Ok(manifest_metadata) => {
                            if manifest_metadata.file_type().is_symlink() || !manifest_metadata.is_file() {
                                return Err(BundlePublicationError::Invalid("manifiesto de generación no regular"));
                            }
                            // Conservar la identidad del manifiesto exacto que
                            // determinó el pointer. verify_generation vuelve a leer
                            // el manifiesto y los receipts; una sustitución entre
                            // ambas lecturas no debe mezclar dos generaciones.
                            let manifest_before = fs::symlink_metadata(&manifest_path).map_err(bundle_io)?;
                            let bytes = read_bundle_regular_file(&manifest_path, MAX_BUNDLE_MANIFEST_BYTES)?;
                            let manifest = BundleManifest::decode(&bytes)?;
                            let pointer = BundlePointer::new(manifest.generation, manifest.bundle_id, manifest.project_id.clone())?;
                            if pointer.generation_dir != name {
                                return Err(BundlePublicationError::Invalid("nombre de generación no coincide con manifiesto huérfano"));
                            }
                            self.verify_generation(&pointer)?;
                            let verified_bytes = read_bundle_regular_file(&manifest_path, MAX_BUNDLE_MANIFEST_BYTES)?;
                            let manifest_after = fs::symlink_metadata(&manifest_path).map_err(bundle_io)?;
                            if bytes != verified_bytes
                                || manifest_after.file_type().is_symlink()
                                || !manifest_after.is_file()
                                || !same_bundle_file(&manifest_before, &manifest_after)
                                || !bundle_file_snapshot_matches(&manifest_before, &manifest_after)
                            {
                                return Err(BundlePublicationError::Invalid("manifiesto cambió durante verificación de generación"));
                            }
                            // Revalidar identidad y metadatos del directorio después
                            // de verificar manifiestos, receipts y almacenes. Si fue
                            // sustituido o cambió durante la inspección, no se emite
                            // un candidato basado en una observación mezclada.
                            let after = fs::symlink_metadata(entry.path()).map_err(bundle_io)?;
                            if after.file_type().is_symlink() || !after.is_dir()
                                || !same_bundle_directory(&directory_snapshot, &after)
                                || !bundle_directory_snapshot_matches(&directory_snapshot, &after)
                            {
                                return Err(BundlePublicationError::Invalid("generación cambió durante el inventario"));
                            }
                            candidates.push(name);
                        }
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(bundle_io(error)),
        }
        for (temporary_path, snapshot) in &abandoned_working_temporary_snapshots {
            verify_bundle_inventory_node(temporary_path, snapshot, true)?;
        }
        candidates.sort();
        abandoned_working_temporaries.sort();
        abandoned_selector_temporaries.sort();
        incomplete_generation_directories.sort();
        active_working_bundles.sort();
        inactive_working_bundles.sort();
        verify_optional_bundle_directory_snapshot(&working, &working_snapshot)?;
        verify_optional_bundle_directory_snapshot(&generations, &generations_snapshot)?;
        self.validate_root_lock()?;
        Ok(BundleOrphanInventory {
            unreferenced_generation_directories: candidates,
            abandoned_working_temporaries,
            abandoned_selector_temporaries,
            incomplete_generation_directories,
            active_working_bundles,
            inactive_working_bundles,
        })
    }

    /// Crea una working bundle independiente copiando ambos almacenes publicados.
    pub fn create_working_bundle(&self, working_id: [u8; 16]) -> Result<WorkingBundle, BundlePublicationError> {
        self.validate_root_lock()?;
        if self.recovery_required {
            return Err(BundlePublicationError::Invalid("selector ambiguo; cerrar y reabrir"));
        }
        let base = self.current.clone().ok_or(BundlePublicationError::Invalid("no hay bundle publicado para clonar"))?;
        let working_root = self.root.join("working");
        match fs::symlink_metadata(&working_root) {
            Ok(_) => ensure_private_bundle_directory(&working_root)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                create_bundle_private_directory(&working_root).map_err(bundle_io)?;
                sync_bundle_directory(&self.root)?;
            }
            Err(error) => return Err(bundle_io(error)),
        }
        let name = bundle_working_directory_name(&working_id);
        let final_dir = working_root.join(&name);
        let temporary = working_root.join(format!(".{name}.tmp"));
        if bundle_path_exists(&final_dir)? || bundle_path_exists(&temporary)? {
            return Err(BundlePublicationError::Invalid("el ID de working bundle ya existe o dejó un temporal"));
        }
        create_bundle_private_directory(&temporary).map_err(bundle_io)?;
        let result = (|| {
            let live_dir = temporary.join("live");
            let knowledge_dir = temporary.join("knowledge");
            create_bundle_private_directory(&live_dir).map_err(bundle_io)?;
            create_bundle_private_directory(&knowledge_dir).map_err(bundle_io)?;
            let mut published = self.open_current_bundle()?
                .ok_or(BundlePublicationError::Invalid("no hay bundle activo"))?;
            copy_published_member(published.live(), &live_dir, &base.project_id)?;
            copy_published_member(published.knowledge(), &knowledge_dir, &base.project_id)?;
            drop(published);
            write_bundle_working_manifest(&temporary, working_id, &base)?;
            sync_bundle_directory(&live_dir)?;
            sync_bundle_directory(&knowledge_dir)?;
            sync_bundle_directory(&temporary)?;
            self.validate_root_lock()?;
            fs::rename(&temporary, &final_dir).map_err(bundle_io)?;
            sync_bundle_directory(&working_root)?;
            self.validate_root_lock()?;
            WorkingBundle::open_directory(final_dir, working_id, base)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&temporary);
        }
        result
    }

    pub fn open_working_bundle(&self, working_id: [u8; 16]) -> Result<WorkingBundle, BundlePublicationError> {
        self.validate_root_lock()?;
        let working_root = self.root.join("working");
        ensure_private_bundle_directory(&working_root)?;
        let directory = working_root.join(bundle_working_directory_name(&working_id));
        let working = WorkingBundle::open_directory(directory, working_id, self.read_working_base(working_id)?)?;
        self.validate_root_lock()?;
        Ok(working)
    }

    pub fn open_or_create_working_bundle(&self, working_id: [u8; 16]) -> Result<WorkingBundle, BundlePublicationError> {
        let directory = self.root.join("working").join(bundle_working_directory_name(&working_id));
        if bundle_path_exists(&directory)? {
            self.open_working_bundle(working_id)
        } else {
            self.create_working_bundle(working_id)
        }
    }

    fn read_working_base(&self, working_id: [u8; 16]) -> Result<BundlePointer, BundlePublicationError> {
        self.validate_root_lock()?;
        let working_root = self.root.join("working");
        ensure_private_bundle_directory(&working_root)?;
        let directory = working_root.join(bundle_working_directory_name(&working_id));
        ensure_private_bundle_directory(&directory)?;
        let manifest = read_bundle_working_manifest(&directory)?;
        if manifest.working_id != working_id {
            return Err(BundlePublicationError::Invalid("ID del manifiesto de working bundle no coincide"));
        }
        self.validate_root_lock()?;
        Ok(manifest.base)
    }

    /// Publica ambos almacenes desde una única working bundle y un solo selector.
    /// El llamador debe cerrar HostEngineApi antes de transferir la sesión aquí.
    pub fn publish_working_bundle(
        &mut self,
        working: WorkingBundle,
        publication_id: [u8; 16],
    ) -> Result<BundlePointer, BundlePublicationError> {
        self.publish_working_bundle_with_hook(working, publication_id, |_| Ok(()))
    }

    // Punto de inyección privado: los fallos de preparación se prueban en los
    // límites reales del protocolo, antes de tocar el selector activo.
    fn publish_working_bundle_with_hook<F>(
        &mut self,
        working: WorkingBundle,
        publication_id: [u8; 16],
        mut after_stage: F,
    ) -> Result<BundlePointer, BundlePublicationError>
    where
        F: FnMut(BundleBuildStage) -> Result<(), BundlePublicationError>,
    {
        self.validate_root_lock()?;
        if self.recovery_required {
            return Err(BundlePublicationError::Invalid("selector ambiguo; cerrar y reabrir"));
        }
        working.validate_session_lock()?;
        let current = self.current.clone().ok_or(BundlePublicationError::Invalid("no existe bundle activo"))?;
        if current != working.base {
            return Err(BundlePublicationError::Invalid("working bundle obsoleta: la generación base ya no está activa"));
        }
        let expected_dir = self.root.join("working").join(bundle_working_directory_name(&working.working_id));
        if expected_dir != working.directory {
            return Err(BundlePublicationError::Invalid("rutas de working bundle no corresponden al ID"));
        }
        let manifest = read_bundle_working_manifest(&working.directory)?;
        if manifest.working_id != working.working_id || manifest.base != working.base {
            return Err(BundlePublicationError::Invalid("manifiesto de working bundle no coincide con la sesión"));
        }

        // Revalidar la cadena completa en el punto de publicación; la
        // sesión puede haber permanecido abierta mientras otro proceso con
        // los mismos permisos intentaba sustituir directorios o archivos.
        let working_root = working.directory.parent()
            .ok_or(BundlePublicationError::Invalid("working bundle sin directorio padre"))?;
        ensure_private_bundle_directory(working_root)?;
        ensure_private_bundle_directory(&working.directory)?;
        ensure_private_bundle_directory(&working.directory.join("live"))?;
        ensure_private_bundle_directory(&working.directory.join("knowledge"))?;
        let live_pages = working.live_pages();
        let live_wal = working.live_wal();
        let knowledge_pages = working.knowledge_pages();
        let knowledge_wal = working.knowledge_wal();
        for path in [&live_pages, &live_wal, &knowledge_pages, &knowledge_wal] {
            ensure_private_bundle_file(path)?;
        }
        ensure_private_bundle_file(&working.directory.join("WORKING.MANIFEST"))?;
        // La verificación ocurre sobre los descriptores ya abiertos, bajo
        // los locks de páginas/WAL y antes de recovery, redo o truncado.
        let mut live = crate::project_store::ProjectStore::open_with_pre_recovery_verification_and_session_validator(
            &live_pages, &live_wal,
            |pages, wal| {
                verify_working_bundle_descriptor(&live_pages, pages)?;
                verify_working_bundle_descriptor(&live_wal, wal)
            },
            working.session_lock_validator(),
        ).map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
        let mut knowledge = crate::project_store::ProjectStore::open_with_pre_recovery_verification_and_session_validator(
            &knowledge_pages, &knowledge_wal,
            |pages, wal| {
                verify_working_bundle_descriptor(&knowledge_pages, pages)?;
                verify_working_bundle_descriptor(&knowledge_wal, wal)
            },
            working.session_lock_validator(),
        ).map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
        live.checkpoint().map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
        after_stage(BundleBuildStage::LiveCheckpointed)?;
        working.validate_session_lock()?;
        knowledge.checkpoint().map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
        after_stage(BundleBuildStage::KnowledgeCheckpointed)?;
        working.validate_session_lock()?;
        validate_bundle_project(&mut live, &current.project_id)?;
        validate_bundle_project(&mut knowledge, &current.project_id)?;
        drop(live);
        drop(knowledge);

        let generation = current.generation.checked_add(1)
            .ok_or(BundlePublicationError::Invalid("contador de generaciones agotado"))?;
        let pointer = BundlePointer::new(generation, publication_id, current.project_id.clone())?;
        let generations = self.root.join("generations");
        ensure_bundle_directory_chain(&self.root, &generations)?;
        let generation_dir = generations.join(&pointer.generation_dir);
        create_bundle_private_directory(&generation_dir).map_err(bundle_io)?;
        let build = (|| {
            working.validate_session_lock()?;
            let live_dir = generation_dir.join("live");
            let knowledge_dir = generation_dir.join("knowledge");
            create_bundle_private_directory(&live_dir).map_err(bundle_io)?;
            create_bundle_private_directory(&knowledge_dir).map_err(bundle_io)?;
            working.validate_session_lock()?;
            let live_pages_digest = copy_bundle_file_synced(&live_pages, &live_dir.join("store.pages"))?;
            after_stage(BundleBuildStage::LivePagesCopied)?;
            working.validate_session_lock()?;
            let live_wal_digest = copy_bundle_file_synced(&live_wal, &live_dir.join("store.mlpj"))?;
            after_stage(BundleBuildStage::LiveWalCopied)?;
            working.validate_session_lock()?;
            let knowledge_pages_digest = copy_bundle_file_synced(&knowledge_pages, &knowledge_dir.join("store.pages"))?;
            after_stage(BundleBuildStage::KnowledgePagesCopied)?;
            working.validate_session_lock()?;
            let knowledge_wal_digest = copy_bundle_file_synced(&knowledge_wal, &knowledge_dir.join("store.mlpj"))?;
            after_stage(BundleBuildStage::KnowledgeWalCopied)?;
            working.validate_session_lock()?;
            let member_pointer = crate::publication::PublicationPointer::new(generation, publication_id)
                .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
            let live_receipt = GenerationReceipt::write(&live_dir, &member_pointer, live_pages_digest, live_wal_digest)
                .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
            after_stage(BundleBuildStage::LiveReceiptWritten)?;
            working.validate_session_lock()?;
            let knowledge_receipt = GenerationReceipt::write(&knowledge_dir, &member_pointer, knowledge_pages_digest, knowledge_wal_digest)
                .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
            after_stage(BundleBuildStage::KnowledgeReceiptWritten)?;
            working.validate_session_lock()?;
            let live_receipt_bytes = live_receipt.encode()
                .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
            let knowledge_receipt_bytes = knowledge_receipt.encode()
                .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
            let bundle_manifest = BundleManifest::new(
                &pointer, bundle_hash(&live_receipt_bytes), bundle_hash(&knowledge_receipt_bytes),
            )?;
            write_bundle_manifest(&generation_dir, &bundle_manifest)?;
            after_stage(BundleBuildStage::BundleManifestWritten)?;
            working.validate_session_lock()?;
            sync_bundle_directory(&live_dir)?;
            sync_bundle_directory(&knowledge_dir)?;
            sync_bundle_directory(&generation_dir)?;
            sync_bundle_directory(&generations)?;
            after_stage(BundleBuildStage::GenerationDirectoriesSynced)?;
            working.validate_session_lock()?;
            self.verify_generation(&pointer)?;
            working.validate_session_lock()?;
            self.publish_with_hook_and_session_validator(
                pointer.clone(), Some(working.session_lock_validator()), |_| Ok(()),
            )?;
            Ok(pointer.clone())
        })();
        build
    }

    pub fn current(&self) -> Option<&BundlePointer> {
        self.current.as_ref()
    }

    /// Verifica ambos miembros y solo entonces avanza el único selector del bundle.
    /// El directorio debe estar completamente preparado antes de llamar este método.
    pub fn publish(&mut self, pointer: BundlePointer) -> Result<(), BundlePublicationError> {
        self.publish_with_hook(pointer, |_| Ok(()))
    }

    // El hook privado permite probar fallos exactamente en fronteras del protocolo.
    // No forma parte de la API pública ni altera el orden de las operaciones reales.
    fn publish_with_hook<F>(
        &mut self,
        pointer: BundlePointer,
        after_stage: F,
    ) -> Result<(), BundlePublicationError>
    where
        F: FnMut(BundlePublishStage) -> Result<(), BundlePublicationError>,
    {
        self.publish_with_hook_and_session_validator(pointer, None, after_stage)
    }

    fn publish_with_hook_and_session_validator<F>(
        &mut self,
        pointer: BundlePointer,
        session_lock_validator: Option<SessionLockValidator>,
        mut after_stage: F,
    ) -> Result<(), BundlePublicationError>
    where
        F: FnMut(BundlePublishStage) -> Result<(), BundlePublicationError>,
    {
        self.validate_root_lock()?;
        if self.recovery_required {
            return Err(BundlePublicationError::Invalid("selector ambiguo; cerrar y reabrir"));
        }
        pointer.validate()?;
        if let Some(validator)=&session_lock_validator { validator.validate().map_err(BundlePublicationError::Io)?; }
        self.verify_generation(&pointer)?;
        self.validate_root_lock()?;
        if let Some(validator)=&session_lock_validator { validator.validate().map_err(BundlePublicationError::Io)?; }
        let expected = self.current.as_ref()
            .map(|current| {
                if current.project_id != pointer.project_id {
                    return Err(BundlePublicationError::Invalid("no se puede cambiar el proyecto dentro de la misma raíz de bundle"));
                }
                current.generation.checked_add(1)
                    .ok_or(BundlePublicationError::Invalid("generación agotada"))
            })
            .transpose()?.unwrap_or(1);
        if pointer.generation != expected {
            return Err(BundlePublicationError::Invalid("la generación del bundle debe avanzar exactamente una unidad"));
        }

        let target_slot = self.active_slot.map(|slot| 1 - slot).unwrap_or(0);
        let target = self.root.join(if target_slot == 0 { "CURRENT.0" } else { "CURRENT.1" });
        match fs::symlink_metadata(&target) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(BundlePublicationError::Invalid("slot inactivo no es archivo regular"));
                }
                self.validate_root_lock()?;
                if let Some(validator)=&session_lock_validator { validator.validate().map_err(BundlePublicationError::Io)?; }
                fs::remove_file(&target).map_err(bundle_io)?;
                if let Some(validator)=&session_lock_validator { validator.validate().map_err(BundlePublicationError::Io)?; }
        if let Err(error) = self.validate_root_lock() {
            self.recovery_required = true;
            return Err(error);
        }
        if let Err(error) = sync_bundle_directory(&self.root) {
                    self.recovery_required = true;
                    return Err(error);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(bundle_io(error)),
        }
        after_stage(BundlePublishStage::InactiveSlotCleared)?;
        if let Some(validator)=&session_lock_validator { validator.validate().map_err(BundlePublicationError::Io)?; }

        let temporary = self.root.join(format!(".CURRENT.{target_slot}.{}.tmp", pointer.generation));
        match fs::symlink_metadata(&temporary) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_POINTER_BYTES as u64 {
                    return Err(BundlePublicationError::Invalid("temporal de selector no es archivo regular válido"));
                }
                // Solo se retira un temporal recuperable que contenga exactamente
                // el puntero que se intenta publicar. Nunca se descarta un estado
                // desconocido, truncado o perteneciente a otra publicación.
                let stale_bytes = read_bundle_regular_file(&temporary, MAX_POINTER_BYTES)?;
                let stale_pointer = BundlePointer::decode(&stale_bytes)?;
                if stale_pointer != pointer {
                    return Err(BundlePublicationError::Invalid("temporal de selector pertenece a otra publicación"));
                }
                if let Some(validator)=&session_lock_validator { validator.validate().map_err(BundlePublicationError::Io)?; }
                fs::remove_file(&temporary).map_err(bundle_io)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(bundle_io(error)),
        }

        self.validate_root_lock()?;
        if let Some(validator)=&session_lock_validator { validator.validate().map_err(BundlePublicationError::Io)?; }
        let encoded = pointer.encode()?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(bundle_io)?;
        file.write_all(&encoded).map_err(bundle_io)?;
        file.sync_all().map_err(bundle_io)?;
        drop(file);
        after_stage(BundlePublishStage::SelectorTempSynced)?;
        if let Err(error) = self.validate_root_lock() {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        if let Some(validator)=&session_lock_validator { validator.validate().map_err(BundlePublicationError::Io)?; }
        if let Err(error) = fs::hard_link(&temporary, &target) {
            self.recovery_required = true;
            return Err(bundle_io(error));
        }
        if let Err(error) = self.validate_root_lock() {
            self.recovery_required = true;
            return Err(error);
        }
        if let Err(error) = after_stage(BundlePublishStage::SelectorLinked) {
            self.recovery_required = true;
            return Err(error);
        }
        if let Some(validator)=&session_lock_validator {
            if let Err(error)=validator.validate() {
                self.recovery_required = true;
                return Err(BundlePublicationError::Io(error));
            }
        }
        if let Err(error) = fs::remove_file(&temporary) {
            self.recovery_required = true;
            return Err(bundle_io(error));
        }
        if let Err(error) = after_stage(BundlePublishStage::SelectorTempRemoved) {
            self.recovery_required = true;
            return Err(error);
        }
        if let Some(validator)=&session_lock_validator {
            if let Err(error)=validator.validate() {
                self.recovery_required = true;
                return Err(BundlePublicationError::Io(error));
            }
        }
        if let Err(error) = sync_bundle_directory(&self.root) {
            self.recovery_required = true;
            return Err(error);
        }
        self.active_slot = Some(target_slot);
        self.current = Some(pointer);
        if let Err(error) = after_stage(BundlePublishStage::RootDirectorySynced) {
            self.recovery_required = true;
            return Err(error);
        }
        Ok(())
    }

    /// Abre ambos miembros como una vista read-only vinculada al lifetime del
    /// selector. Mientras exista la vista, el BundlePublicationStore no puede
    /// cerrarse y liberar el lock de la raíz.
    pub fn open_current_bundle(&self) -> Result<Option<PublishedBundle<'_>>, BundlePublicationError> {
        if self.recovery_required {
            return Err(BundlePublicationError::Invalid("selector ambiguo; cerrar y reabrir"));
        }
        self.validate_root_lock()?;
        let Some(pointer) = self.current.as_ref() else { return Ok(None); };
        self.verify_generation(pointer)?;
        let generation = self.root.join("generations").join(&pointer.generation_dir);
        let live_dir = generation.join("live");
        let knowledge_dir = generation.join("knowledge");
        ensure_bundle_directory_chain(&self.root, &live_dir)?;
        ensure_bundle_directory_chain(&self.root, &knowledge_dir)?;
        let live_receipt_bytes = read_bundle_regular_file(
            &live_dir.join("GENERATION.MANIFEST"), BUNDLE_RECEIPT_BYTES,
        )?;
        let knowledge_receipt_bytes = read_bundle_regular_file(
            &knowledge_dir.join("GENERATION.MANIFEST"), BUNDLE_RECEIPT_BYTES,
        )?;
        // Revalidar los bytes exactos de receipts que se usarán para abrir
        // los descriptores; no depender de una lectura previa separada.
        let manifest_bytes = read_bundle_regular_file(
            &generation.join("BUNDLE.MANIFEST"), MAX_BUNDLE_MANIFEST_BYTES,
        )?;
        let manifest = BundleManifest::decode(&manifest_bytes)?;
        if !manifest.matches_pointer(pointer)
            || bundle_hash(&live_receipt_bytes) != manifest.live_receipt_sha256
            || bundle_hash(&knowledge_receipt_bytes) != manifest.knowledge_receipt_sha256
        {
            return Err(BundlePublicationError::Invalid("receipts cambiaron o no corresponden al manifiesto"));
        }
        let live_receipt = GenerationReceipt::decode(&live_receipt_bytes)
            .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
        let knowledge_receipt = GenerationReceipt::decode(&knowledge_receipt_bytes)
            .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
        for receipt in [&live_receipt, &knowledge_receipt] {
            if receipt.generation != pointer.generation || receipt.migration_id != pointer.bundle_id {
                return Err(BundlePublicationError::Invalid("receipt no corresponde al selector activo"));
            }
        }
        // La validación integral anterior y la lectura de receipts pueden
        // tardar. Revalidar toda la cadena inmediatamente antes de cada
        // apertura read-only, y otra vez al terminar ambas aperturas.
        ensure_bundle_directory_chain(&self.root, &live_dir)?;
        ensure_bundle_directory_chain(&self.root, &knowledge_dir)?;
        let live = crate::publication::open_verified_bundle_member(
            live_dir.join("store.pages"), live_dir.join("store.mlpj"), &live_receipt,
        ).map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
        ensure_bundle_directory_chain(&self.root, &live_dir)?;
        ensure_bundle_directory_chain(&self.root, &knowledge_dir)?;
        let knowledge = crate::publication::open_verified_bundle_member(
            knowledge_dir.join("store.pages"), knowledge_dir.join("store.mlpj"), &knowledge_receipt,
        ).map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
        ensure_bundle_directory_chain(&self.root, &live_dir)?;
        ensure_bundle_directory_chain(&self.root, &knowledge_dir)?;
        self.validate_root_lock()?;
        Ok(Some(PublishedBundle {
            live,
            knowledge,
            _root_lock: std::marker::PhantomData,
        }))
    }

    pub fn verify_current(&self) -> Result<(), BundlePublicationError> {
        self.validate_root_lock()?;
        if self.recovery_required {
            return Err(BundlePublicationError::Invalid("selector ambiguo; cerrar y reabrir"));
        }
        if let Some(pointer) = self.current.as_ref() {
            self.verify_generation(pointer)?;
        }
        self.validate_root_lock()
    }

    fn verify_generation(&self, pointer: &BundlePointer) -> Result<(), BundlePublicationError> {
        self.validate_root_lock()?;
        pointer.validate()?;
        let generations = self.root.join("generations");
        ensure_bundle_directory(&generations)?;
        let directory = generations.join(&pointer.generation_dir);
        ensure_bundle_directory_chain(&self.root, &directory)?;
        // La identidad de los contenedores y directorios miembro debe
        // mantenerse durante toda la verificación, no solo al abrir cada
        // archivo. Esto detecta sustituciones entre la validación de live
        // y la de knowledge.
        let mut verified_nodes = vec![
            (generations.clone(), capture_bundle_inventory_node(&generations, true)?, true),
            (directory.clone(), capture_bundle_inventory_node(&directory, true)?, true),
        ];
        let manifest_path = directory.join("BUNDLE.MANIFEST");
        let manifest_snapshot = fs::symlink_metadata(&manifest_path).map_err(bundle_io)?;
        let manifest_bytes = read_bundle_regular_file(&manifest_path, MAX_BUNDLE_MANIFEST_BYTES)?;
        let manifest = BundleManifest::decode(&manifest_bytes)?;
        if !manifest.matches_pointer(pointer) {
            return Err(BundlePublicationError::Invalid("manifiesto no corresponde al selector"));
        }
        let mut verified_metadata = vec![(manifest_path.clone(), manifest_snapshot, manifest_bytes)];
        verified_nodes.push((
            manifest_path.clone(),
            capture_bundle_inventory_node(&manifest_path, false)?,
            false,
        ));

        for (member, expected_receipt_hash) in [
            ("live", manifest.live_receipt_sha256),
            ("knowledge", manifest.knowledge_receipt_sha256),
        ] {
            let member_dir = directory.join(member);
            ensure_bundle_directory_chain(&self.root, &member_dir)?;
            verified_nodes.push((
                member_dir.clone(),
                capture_bundle_inventory_node(&member_dir, true)?,
                true,
            ));
            let receipt_path = member_dir.join("GENERATION.MANIFEST");
            let receipt_snapshot = fs::symlink_metadata(&receipt_path).map_err(bundle_io)?;
            let receipt_bytes = read_bundle_regular_file(&receipt_path, BUNDLE_RECEIPT_BYTES)?;
            if receipt_bytes.len() != BUNDLE_RECEIPT_BYTES {
                return Err(BundlePublicationError::Invalid("receipt de miembro con tamaño incorrecto"));
            }
            if bundle_hash(&receipt_bytes) != expected_receipt_hash {
                return Err(BundlePublicationError::Invalid("hash del receipt no coincide con manifiesto"));
            }
            let receipt = GenerationReceipt::decode(&receipt_bytes)
                .map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
            if receipt.generation != pointer.generation || receipt.migration_id != pointer.bundle_id {
                return Err(BundlePublicationError::Invalid("receipt pertenece a otra generación o bundle"));
            }
            verified_metadata.push((receipt_path.clone(), receipt_snapshot, receipt_bytes));
            verified_nodes.push((
                receipt_path.clone(),
                capture_bundle_inventory_node(&receipt_path, false)?,
                false,
            ));

            let pages_path = member_dir.join("store.pages");
            let wal_path = member_dir.join("store.mlpj");
            verified_nodes.push((
                pages_path.clone(),
                capture_bundle_inventory_node(&pages_path, false)?,
                false,
            ));
            verified_nodes.push((
                wal_path.clone(),
                capture_bundle_inventory_node(&wal_path, false)?,
                false,
            ));
            if receipt.wal.length != 12 {
                return Err(BundlePublicationError::Invalid("WAL publicado no está checkpointed"));
            }
            // Hash y validación estructural se hacen sobre los mismos
            // descriptores que DurablePages conservará, bajo locks y antes
            // de cualquier recovery. También rechazamos hardlinks y rutas
            // sustituidas entre la validación inicial y la apertura.
            let mut project = crate::project_store::ProjectStore::open_read_only_with_pre_recovery_verification(
                &pages_path, &wal_path,
                |pages, wal| {
                    verify_working_bundle_descriptor(&pages_path, pages)?;
                    verify_working_bundle_descriptor(&wal_path, wal)?;
                    receipt.verify_open_files(pages, wal)?;
                    verify_working_bundle_descriptor(&pages_path, pages)?;
                    verify_working_bundle_descriptor(&wal_path, wal)
                },
            ).map_err(|error| BundlePublicationError::InvalidOwned(error.to_string()))?;
            validate_bundle_project(&mut project, &pointer.project_id)?;
            drop(project);
        }
        // Revalidar manifiesto y receipts después de recorrer ambos almacenes.
        // La comprobación inicial de cada lectura no basta si un archivo puede
        // sustituirse mientras se valida el otro miembro.
        for (path, before, expected_bytes) in verified_metadata {
            let current_bytes = read_bundle_regular_file(&path, if path == manifest_path {
                MAX_BUNDLE_MANIFEST_BYTES
            } else {
                BUNDLE_RECEIPT_BYTES
            })?;
            let after = fs::symlink_metadata(&path).map_err(bundle_io)?;
            if current_bytes != expected_bytes
                || after.file_type().is_symlink()
                || !after.is_file()
                || !same_bundle_file(&before, &after)
                || !bundle_file_snapshot_matches(&before, &after)
            {
                return Err(BundlePublicationError::Invalid("manifiesto o receipt cambió durante verificación"));
            }
        }
        // Verificar de nuevo todos los nodos por ruta después de cerrar
        // los stores read-only. La verificación de descriptores protege los
        // bytes abiertos; estos snapshots protegen que la estructura visible
        // siga siendo exactamente la que se inspeccionó.
        ensure_bundle_directory_chain(&self.root, &directory)?;
        for (path, snapshot, is_directory) in &verified_nodes {
            verify_bundle_inventory_node(path, snapshot, *is_directory)?;
        }
        self.validate_root_lock()?;
        Ok(())
    }
}

#[derive(Debug)]
pub enum BundlePublicationError {
    Io(String),
    Invalid(&'static str),
    InvalidOwned(String),
    Format(BundleFormatError),
}
impl std::fmt::Display for BundlePublicationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(message) => write!(f, "I/O del bundle: {message}"),
            Self::Invalid(message) => write!(f, "bundle inválido: {message}"),
            Self::InvalidOwned(message) => write!(f, "bundle inválido: {message}"),
            Self::Format(error) => write!(f, "{error}"),
        }
    }
}
impl std::error::Error for BundlePublicationError {}
impl From<BundleFormatError> for BundlePublicationError {
    fn from(error: BundleFormatError) -> Self { Self::Format(error) }
}

/// Vista read-only de ambos almacenes. Su lifetime mantiene vivo el lock
/// de BundlePublicationStore y evita que otra instancia publique mientras se lee.
pub struct PublishedBundle<'a> {
    live: PublishedProjectStore,
    knowledge: PublishedProjectStore,
    _root_lock: std::marker::PhantomData<&'a BundlePublicationStore>,
}
impl PublishedBundle<'_> {
    pub fn live(&mut self) -> &mut PublishedProjectStore { &mut self.live }
    pub fn knowledge(&mut self) -> &mut PublishedProjectStore { &mut self.knowledge }
}

fn bundle_io(error: std::io::Error) -> BundlePublicationError {
    BundlePublicationError::Io(error.to_string())
}

fn bundle_hash(bytes: &[u8]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(bytes);
    hash.finish()
}

fn digest_open_bundle_file(file: &mut File) -> Result<FileDigest, BundlePublicationError> {
    let before = file.metadata().map_err(bundle_io)?;
    file.seek(SeekFrom::Start(0)).map_err(bundle_io)?;
    let mut hash = Sha256::new();
    let mut length = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(bundle_io)?;
        if count == 0 { break; }
        length = length.checked_add(count as u64)
            .ok_or(BundlePublicationError::Invalid("tamaño de miembro desbordado"))?;
        hash.update(&buffer[..count]);
    }
    let after = file.metadata().map_err(bundle_io)?;
    if !same_bundle_file(&before, &after)
        || !bundle_file_snapshot_matches(&before, &after)
        || length != after.len()
    {
        return Err(BundlePublicationError::Invalid("archivo cambió durante cálculo de hash"));
    }
    Ok(FileDigest { length, sha256: hash.finish() })
}

fn digest_bundle_file(path: &Path) -> Result<FileDigest, BundlePublicationError> {
    let metadata = fs::symlink_metadata(path).map_err(bundle_io)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(BundlePublicationError::Invalid("archivo de miembro no es regular"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.nlink() != 1 || metadata.permissions().mode() & 0o077 != 0 {
            return Err(BundlePublicationError::Invalid("archivo de miembro compartido o no privado"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.number_of_links() != Some(1) {
            return Err(BundlePublicationError::Invalid("archivo de miembro tiene hardlinks"));
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x20_000);
    }
    let mut file = options.open(path).map_err(bundle_io)?;
    let opened = file.metadata().map_err(bundle_io)?;
    let current = fs::symlink_metadata(path).map_err(bundle_io)?;
    if !opened.is_file() || current.file_type().is_symlink() || !current.is_file()
        || !same_bundle_file(&metadata, &opened) || !same_bundle_file(&opened, &current)
        || !bundle_file_snapshot_matches(&metadata, &opened)
    {
        return Err(BundlePublicationError::Invalid("archivo de miembro cambió durante apertura"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if opened.nlink() != 1 || opened.permissions().mode() & 0o077 != 0 {
            return Err(BundlePublicationError::Invalid("descriptor de miembro compartido o no privado"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.number_of_links() != Some(1) || current.number_of_links() != Some(1) {
            return Err(BundlePublicationError::Invalid("descriptor de miembro tiene hardlinks"));
        }
    }
    digest_open_bundle_file(&mut file)
}

fn read_bundle_regular_file(path: &Path, maximum: usize) -> Result<Vec<u8>, BundlePublicationError> {
    read_bundle_regular_file_internal(path, maximum, true)
}

fn read_bundle_regular_file_internal(
    path: &Path,
    maximum: usize,
    reject_hardlinks: bool,
) -> Result<Vec<u8>, BundlePublicationError> {
    let metadata = fs::symlink_metadata(path).map_err(bundle_io)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(BundlePublicationError::Invalid("manifiesto/receipt no es archivo regular"));
    }
    if metadata.len() > maximum as u64 {
        return Err(BundlePublicationError::Invalid("manifiesto/receipt supera tamaño máximo"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if (reject_hardlinks && metadata.nlink() != 1)
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(BundlePublicationError::Invalid("manifiesto/receipt compartido o no privado"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if reject_hardlinks && metadata.number_of_links() != Some(1) {
            return Err(BundlePublicationError::Invalid("manifiesto/receipt tiene hardlinks"));
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x20_000);
    }
    let mut file = options.open(path).map_err(bundle_io)?;
    let opened = file.metadata().map_err(bundle_io)?;
    let current = fs::symlink_metadata(path).map_err(bundle_io)?;
    if !opened.is_file() || current.file_type().is_symlink() || !current.is_file()
        || !same_bundle_file(&metadata, &opened)
        || !same_bundle_file(&opened, &current)
        || !bundle_file_snapshot_matches(&metadata, &opened)
    {
        return Err(BundlePublicationError::Invalid("archivo de manifiesto cambió durante apertura"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if reject_hardlinks
            && (opened.number_of_links() != Some(1) || current.number_of_links() != Some(1))
        {
            return Err(BundlePublicationError::Invalid("manifiesto/receipt adquirió hardlinks durante apertura"));
        }
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut file).take(maximum as u64 + 1).read_to_end(&mut bytes).map_err(bundle_io)?;
    if bytes.len() > maximum {
        return Err(BundlePublicationError::Invalid("manifiesto/receipt supera tamaño máximo"));
    }
    let after = file.metadata().map_err(bundle_io)?;
    let path_after = fs::symlink_metadata(path).map_err(bundle_io)?;
    if !same_bundle_file(&opened, &after)
        || !same_bundle_file(&after, &path_after)
        || !bundle_file_snapshot_matches(&opened, &after)
        || bytes.len() as u64 != after.len()
    {
        return Err(BundlePublicationError::Invalid("archivo de manifiesto cambió durante lectura"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if reject_hardlinks
            && (after.number_of_links() != Some(1) || path_after.number_of_links() != Some(1))
        {
            return Err(BundlePublicationError::Invalid("manifiesto/receipt adquirió hardlinks durante lectura"));
        }
    }
    Ok(bytes)
}

fn ensure_bundle_directory(path: &Path) -> Result<(), BundlePublicationError> {
    let metadata = fs::symlink_metadata(path).map_err(bundle_io)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(BundlePublicationError::Invalid("directorio de bundle ausente o no regular"));
    }
    Ok(())
}

/// Recorre cada componente desde la raíz confiable hasta el directorio objetivo.
/// Validar solo el último componente no detecta un padre sustituido por symlink.
fn ensure_bundle_directory_chain(
    trusted_root: &Path,
    target: &Path,
) -> Result<(), BundlePublicationError> {
    let relative = target.strip_prefix(trusted_root)
        .map_err(|_| BundlePublicationError::Invalid("directorio fuera de la raíz del bundle"))?;
    ensure_bundle_directory(trusted_root)?;
    let mut current = trusted_root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(BundlePublicationError::Invalid("componente de ruta de bundle no permitido"));
        };
        current.push(name);
        ensure_bundle_directory(&current)?;
    }
    Ok(())
}

fn capture_bundle_inventory_node(
    path: &Path,
    directory: bool,
) -> Result<fs::Metadata, BundlePublicationError> {
    let metadata = fs::symlink_metadata(path).map_err(bundle_io)?;
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err(BundlePublicationError::Invalid("miembro de working bundle no es nodo regular"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.permissions().mode() & 0o077 != 0
            || (!directory && metadata.nlink() != 1)
        {
            return Err(BundlePublicationError::Invalid("miembro de working bundle no es privado o tiene hardlinks"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if !directory && metadata.number_of_links() != Some(1) {
            return Err(BundlePublicationError::Invalid("archivo de working bundle tiene hardlinks"));
        }
    }
    Ok(metadata)
}

fn verify_bundle_inventory_node(
    path: &Path,
    before: &fs::Metadata,
    directory: bool,
) -> Result<(), BundlePublicationError> {
    let after = capture_bundle_inventory_node(path, directory)?;
    let same_identity = if directory {
        same_bundle_directory(before, &after)
    } else {
        same_bundle_file(before, &after)
    };
    if !same_identity || !bundle_directory_snapshot_matches(before, &after) {
        return Err(BundlePublicationError::Invalid("miembro de working bundle cambió durante el inventario"));
    }
    Ok(())
}

/// Captura un directorio contenedor opcional sin crearlo. La ausencia es
/// parte del snapshot: si aparece durante el inventario, la observación queda
/// invalidada igual que si un directorio existente desaparece o se sustituye.
fn capture_optional_bundle_directory(path: &Path) -> Result<Option<fs::Metadata>, BundlePublicationError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(BundlePublicationError::Invalid("directorio contenedor de inventario no regular"));
            }
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(bundle_io(error)),
    }
}

fn verify_optional_bundle_directory_snapshot(
    path: &Path,
    before: &Option<fs::Metadata>,
) -> Result<(), BundlePublicationError> {
    let after = capture_optional_bundle_directory(path)?;
    let unchanged = match (before, after.as_ref()) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            same_bundle_directory(left, right)
                && bundle_directory_snapshot_matches(left, right)
        }
        _ => false,
    };
    if !unchanged {
        return Err(BundlePublicationError::Invalid("directorio contenedor cambió durante el inventario"));
    }
    Ok(())
}

fn bundle_directory_snapshot_matches(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    if left.modified().ok() != right.modified().ok() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.ctime() == right.ctime() && left.ctime_nsec() == right.ctime_nsec()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        left.creation_time() == right.creation_time()
            && left.last_write_time() == right.last_write_time()
    }
    #[cfg(not(any(unix, windows)))]
    {
        true
    }
}

#[cfg(unix)]
fn same_bundle_directory(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}
#[cfg(windows)]
fn same_bundle_directory(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    left.is_dir() && right.is_dir()
        && left.volume_serial_number().is_some()
        && left.file_index().is_some()
        && left.volume_serial_number() == right.volume_serial_number()
        && left.file_index() == right.file_index()
}
#[cfg(not(any(unix, windows)))]
fn same_bundle_directory(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.is_dir() && right.is_dir()
        && left.modified().ok() == right.modified().ok()
}

#[cfg(unix)]
fn same_bundle_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}
#[cfg(windows)]
fn same_bundle_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    left.is_file() && right.is_file()
        && left.volume_serial_number().is_some()
        && left.file_index().is_some()
        && left.volume_serial_number() == right.volume_serial_number()
        && left.file_index() == right.file_index()
}
#[cfg(not(any(unix, windows)))]
fn same_bundle_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.is_file() && right.is_file() && left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
}

fn read_bundle_slot(path: &Path) -> Result<Option<BundlePointer>, BundlePublicationError> {
    let before = match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(bundle_io(error)),
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(BundlePublicationError::Invalid("slot de bundle no es archivo regular"));
            }
            if metadata.len() > MAX_POINTER_BYTES as u64 {
                return Err(BundlePublicationError::Invalid("slot de bundle demasiado grande"));
            }
            metadata
        }
    };
    // Durante un cierre abrupto puede persistir el hardlink temporal que
    // publica el selector. Se permite leer ese inode, pero nunca se adopta
    // ni elimina el temporal desde esta ruta de recuperación.
    let bytes = read_bundle_regular_file_internal(path, MAX_POINTER_BYTES, false)?;
    // La identidad que se validó debe seguir siendo la del slot después de
    // leerlo. Si fue sustituido durante la recuperación, no elegimos puntero.
    let after = fs::symlink_metadata(path).map_err(bundle_io)?;
    if after.file_type().is_symlink() || !after.is_file()
        || !same_bundle_file(&before, &after)
        || !bundle_file_snapshot_matches(&before, &after)
    {
        return Err(BundlePublicationError::Invalid("slot de bundle cambió durante la lectura"));
    }
    BundlePointer::decode(&bytes).map(Some).map_err(Into::into)
}

fn select_bundle_slots(
    slot0: Option<BundlePointer>,
    slot1: Option<BundlePointer>,
) -> Result<(Option<usize>, Option<BundlePointer>), BundlePublicationError> {
    match (slot0, slot1) {
        (None, None) => Ok((None, None)),
        (Some(pointer), None) => Ok((Some(0), Some(pointer))),
        (None, Some(pointer)) => Ok((Some(1), Some(pointer))),
        (Some(left), Some(right)) => {
            if left.generation == right.generation {
                if left != right {
                    return Err(BundlePublicationError::Invalid("selectores distintos comparten generación"));
                }
                return Ok((Some(0), Some(left)));
            }
            let (newer, older, slot) = if left.generation > right.generation {
                (&left, &right, 0)
            } else {
                (&right, &left, 1)
            };
            if newer.generation != older.generation.checked_add(1)
                .ok_or(BundlePublicationError::Invalid("generación anterior agotada"))?
            {
                return Err(BundlePublicationError::Invalid("selectores no consecutivos"));
            }
            if newer.project_id != older.project_id {
                return Err(BundlePublicationError::Invalid("selectores de proyectos distintos comparten la raíz"));
            }
            if slot == 0 { Ok((Some(0), Some(left))) } else { Ok((Some(1), Some(right))) }
        }
    }
}


#[cfg(test)]
mod publication_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn root(label: &str) -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("mldb-bundle-{label}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[cfg(windows)]
    #[test]
    fn windows_bundle_copy_rejects_hardlinked_source() {
        let root = root("windows-copy-hardlink");
        let source = root.join("source.bin");
        let alias = root.join("source.alias");
        let destination = root.join("destination.bin");
        fs::write(&source, b"private-bundle-source").unwrap();
        fs::hard_link(&source, &alias).unwrap();
        assert!(copy_bundle_file_synced(&source, &destination).is_err());
        fs::remove_file(&alias).unwrap();
        let digest = copy_bundle_file_synced(&source, &destination).unwrap();
        assert_eq!(digest.length, b"private-bundle-source".len() as u64);
        assert_eq!(fs::read(destination).unwrap(), b"private-bundle-source");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_bundle_identity_and_hardlink_checks_reject_shared_files() {
        use std::os::windows::fs::MetadataExt;
        let directory = std::env::temp_dir().join(format!(
            "mldb-bundle-windows-identity-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
        ));
        fs::create_dir_all(&directory).unwrap();
        let first = directory.join("first.bin");
        let second = directory.join("second.bin");
        let alias = directory.join("first-alias.bin");
        fs::write(&first, b"same-size").unwrap();
        fs::write(&second, b"same-size").unwrap();
        let first_metadata = fs::metadata(&first).unwrap();
        let second_metadata = fs::metadata(&second).unwrap();
        assert!(!same_bundle_file(&first_metadata, &second_metadata));
        fs::hard_link(&first, &alias).unwrap();
        assert_eq!(fs::metadata(&first).unwrap().number_of_links(), Some(2));
        assert!(ensure_private_bundle_file(&first).is_err());
        assert!(read_bundle_regular_file(&first, 1024).is_err());
        // Los slots pueden compartir inode con su temporal después del hard link.
        assert_eq!(
            read_bundle_regular_file_internal(&first, 1024, false).unwrap(),
            b"same-size"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn inventory_working_member_snapshot_detects_file_replacement() {
        use std::os::unix::fs::PermissionsExt;
        let root = root("inventory-working-file-replacement");
        let file = root.join("store.pages");
        fs::write(&file, b"original").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let snapshot = capture_bundle_inventory_node(&file, false).unwrap();
        let displaced = root.join("store.displaced");
        fs::rename(&file, &displaced).unwrap();
        fs::write(&file, b"original").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(verify_bundle_inventory_node(&file, &snapshot, false).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn inventory_working_member_snapshot_detects_directory_replacement() {
        let root = root("inventory-working-dir-replacement");
        let member = root.join("live");
        create_bundle_private_directory(&member).unwrap();
        let snapshot = capture_bundle_inventory_node(&member, true).unwrap();
        let displaced = root.join("live-displaced");
        fs::rename(&member, &displaced).unwrap();
        create_bundle_private_directory(&member).unwrap();
        assert!(verify_bundle_inventory_node(&member, &snapshot, true).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn generation_verification_snapshot_detects_member_directory_replacement() {
        let root = root("generation-member-directory-replacement");
        let generations = root.join("generations");
        let generation = generations.join("bundle-gen-1");
        let member = generation.join("live");
        create_bundle_private_directory(&generations).unwrap();
        create_bundle_private_directory(&generation).unwrap();
        create_bundle_private_directory(&member).unwrap();
        let generations_snapshot = capture_bundle_inventory_node(&generations, true).unwrap();
        let generation_snapshot = capture_bundle_inventory_node(&generation, true).unwrap();
        let member_snapshot = capture_bundle_inventory_node(&member, true).unwrap();

        let displaced = generation.join("live-displaced");
        fs::rename(&member, &displaced).unwrap();
        create_bundle_private_directory(&member).unwrap();

        assert!(verify_bundle_inventory_node(&generations, &generations_snapshot, true).is_ok());
        assert!(verify_bundle_inventory_node(&generation, &generation_snapshot, true).is_ok());
        assert!(verify_bundle_inventory_node(&member, &member_snapshot, true).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn generation_verification_snapshot_detects_store_file_replacement() {
        use std::os::unix::fs::PermissionsExt;
        let root = root("generation-store-file-replacement");
        let generations = root.join("generations");
        let generation = generations.join("bundle-gen-1");
        let member = generation.join("knowledge");
        create_bundle_private_directory(&generations).unwrap();
        create_bundle_private_directory(&generation).unwrap();
        create_bundle_private_directory(&member).unwrap();
        let pages = member.join("store.pages");
        fs::write(&pages, b"same-bytes").unwrap();
        fs::set_permissions(&pages, fs::Permissions::from_mode(0o600)).unwrap();
        let snapshot = capture_bundle_inventory_node(&pages, false).unwrap();

        let displaced = member.join("store.displaced");
        fs::rename(&pages, &displaced).unwrap();
        fs::write(&pages, b"same-bytes").unwrap();
        fs::set_permissions(&pages, fs::Permissions::from_mode(0o600)).unwrap();

        assert!(verify_bundle_inventory_node(&pages, &snapshot, false).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inventory_container_snapshot_detects_added_entries() {
        let root = root("inventory-container-entry");
        let container = root.join("working");
        create_bundle_private_directory(&container).unwrap();
        let snapshot = capture_optional_bundle_directory(&container).unwrap();
        fs::create_dir(container.join("new-entry")).unwrap();
        assert!(verify_optional_bundle_directory_snapshot(&container, &snapshot).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inventory_container_snapshot_detects_replacement() {
        let root = root("inventory-container-replacement");
        let container = root.join("generations");
        create_bundle_private_directory(&container).unwrap();
        let snapshot = capture_optional_bundle_directory(&container).unwrap();
        let displaced = root.join("generations-displaced");
        fs::rename(&container, &displaced).unwrap();
        create_bundle_private_directory(&container).unwrap();
        assert!(verify_optional_bundle_directory_snapshot(&container, &snapshot).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn inventory_container_snapshot_rejects_symlinked_directory() {
        let root = root("inventory-container-symlink");
        let outside = root.join("outside");
        let container = root.join("working");
        create_bundle_private_directory(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, &container).unwrap();
        assert!(capture_optional_bundle_directory(&container).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inventory_container_snapshot_detects_directory_appearing() {
        let root = root("inventory-container-appearing");
        let container = root.join("working");
        let snapshot = capture_optional_bundle_directory(&container).unwrap();
        assert!(snapshot.is_none());
        create_bundle_private_directory(&container).unwrap();
        assert!(verify_optional_bundle_directory_snapshot(&container, &snapshot).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    fn prepare_bundle(root: &Path, pointer: &BundlePointer) {
        prepare_bundle_with_values(root, pointer, b"revision-10", b"character-A");
    }

    fn prepare_bundle_with_values(
        root: &Path,
        pointer: &BundlePointer,
        live_value: &[u8],
        knowledge_value: &[u8],
    ) {
        let generation = root.join("generations").join(&pointer.generation_dir);
        let live = generation.join("live");
        let knowledge = generation.join("knowledge");
        fs::create_dir_all(&live).unwrap();
        fs::create_dir_all(&knowledge).unwrap();
        let publication_pointer = crate::publication::PublicationPointer::new(
            pointer.generation, pointer.bundle_id,
        ).unwrap();
        for (directory, table, value) in [
            (&live, "live_state", live_value),
            (&knowledge, "narrative_entities", knowledge_value),
        ] {
            let pages = directory.join("store.pages");
            let wal = directory.join("store.mlpj");
            {
                let mut store = crate::project_store::ProjectStore::open(&pages, &wal).unwrap();
                store.put_project(&pointer.project_id, table, "record-1", value).unwrap();
                store.checkpoint().unwrap();
            }
            GenerationReceipt::create_from_files(directory, &publication_pointer).unwrap();
        }
        let live_receipt = fs::read(live.join("GENERATION.MANIFEST")).unwrap();
        let knowledge_receipt = fs::read(knowledge.join("GENERATION.MANIFEST")).unwrap();
        let manifest = BundleManifest::new(
            pointer, bundle_hash(&live_receipt), bundle_hash(&knowledge_receipt),
        ).unwrap();
        write_bundle_manifest(&generation, &manifest).unwrap();
    }




    #[cfg(unix)]
    #[test]
    fn bundle_publication_rejects_replaced_working_session_lock() {
        use std::os::unix::fs::OpenOptionsExt;
        let root = root("replaced-session-lock");
        let pointer = BundlePointer::new(1, [0xe1; 16], "book-A").unwrap();
        prepare_bundle(&root, &pointer);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(pointer.clone()).unwrap();
        let working = publication.create_working_bundle([0xe2; 16]).unwrap();
        let validator = working.session_lock_validator();
        let session_lock = crate::interprocess_lock::lock_path_for(
            &working.directory.join("SESSION")
        ).unwrap();
        let displaced = session_lock.with_extension("displaced");
        fs::rename(&session_lock, &displaced).unwrap();
        let mut replacement = OpenOptions::new()
            .write(true).create_new(true).mode(0o600).open(&session_lock).unwrap();
        replacement.sync_all().unwrap();

        assert!(validator.validate().is_err());
        assert!(publication.publish_working_bundle(working, [0xe3; 16]).is_err());
        assert_eq!(publication.current(), Some(&pointer));

        fs::remove_file(&session_lock).unwrap();
        fs::remove_file(&displaced).unwrap();
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn project_store_mutations_fail_closed_after_session_lock_replacement() {
        use std::os::unix::fs::OpenOptionsExt;
        let root = root("project-store-session-guard");
        let pointer = BundlePointer::new(1, [0xe8; 16], "book-A").unwrap();
        prepare_bundle(&root, &pointer);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(pointer).unwrap();
        let working = publication.create_working_bundle([0xe9; 16]).unwrap();
        let (pages, wal, _, _) = working.paths();
        let session_lock = crate::interprocess_lock::lock_path_for(
            &pages.parent().unwrap().parent().unwrap().join("SESSION")
        ).unwrap();
        let displaced = session_lock.with_extension("displaced");
        let validator = working.session_lock_validator();
        let mut store = crate::project_store::ProjectStore::open_existing_with_session_validator(
            &pages, &wal, validator,
        ).unwrap();
        assert_eq!(
            store.get_project("book-A", "live_state", "record-1").unwrap(),
            Some(b"revision-10".to_vec()),
        );
        store.put_project("book-A", "live_state", "checkpoint-probe", b"durable").unwrap();
        let wal_before_rejected_checkpoint = fs::read(&wal).unwrap();

        fs::rename(&session_lock, &displaced).unwrap();
        let replacement = OpenOptions::new()
            .write(true).create_new(true).mode(0o600).open(&session_lock).unwrap();
        replacement.sync_all().unwrap();

        assert!(store.put_project("book-A", "live_state", "new", b"must-not-write").is_err());
        assert!(store.delete_project("book-A", "live_state", "record-1").is_err());
        assert!(store.apply_batch(vec![crate::project_store::ProjectOperation::Put {
            project_id: "book-A".into(), table: "live_state".into(),
            record_id: "batch".into(), value: b"must-not-write".to_vec(),
        }]).is_err());
        assert!(store.repair_occupancy().is_err());
        assert!(store.checkpoint().is_err());
        assert_eq!(fs::read(&wal).unwrap(), wal_before_rejected_checkpoint,
            "un checkpoint rechazado no debe truncar el WAL");
        assert_eq!(
            store.get_project("book-A", "live_state", "record-1").unwrap(),
            Some(b"revision-10".to_vec()),
        );
        assert_eq!(store.get_project("book-A", "live_state", "new").unwrap(), None);
        assert_eq!(store.get_project("book-A", "live_state", "batch").unwrap(), None);

        drop(store);
        drop(replacement);
        drop(working);
        drop(publication);
        fs::remove_file(&session_lock).unwrap();
        fs::remove_file(&displaced).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn bundle_publication_aborts_before_selector_if_session_lock_changes_during_preparation() {
        use std::os::unix::fs::OpenOptionsExt;
        let root = root("session-lock-replaced-during-publication");
        let pointer = BundlePointer::new(1, [0xea; 16], "book-A").unwrap();
        prepare_bundle(&root, &pointer);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(pointer.clone()).unwrap();
        let working = publication.create_working_bundle([0xeb; 16]).unwrap();
        let session_lock = crate::interprocess_lock::lock_path_for(
            &working.directory.join("SESSION")
        ).unwrap();
        let displaced = session_lock.with_extension("displaced");

        let result = publication.publish_working_bundle_with_hook(
            working,
            [0xec; 16],
            |stage| {
                if stage == BundleBuildStage::GenerationDirectoriesSynced {
                    fs::rename(&session_lock, &displaced).map_err(bundle_io)?;
                    let mut replacement = OpenOptions::new()
                        .write(true).create_new(true).mode(0o600)
                        .open(&session_lock).map_err(bundle_io)?;
                    replacement.sync_all().map_err(bundle_io)?;
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(publication.current(), Some(&pointer));

        drop(publication);
        fs::remove_file(&session_lock).unwrap();
        fs::remove_file(&displaced).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn joint_checkpoint_stops_before_knowledge_member_if_session_lock_changes() {
        use std::os::unix::fs::OpenOptionsExt;
        let root = root("session-lock-replaced-between-member-checkpoints");
        let pointer = BundlePointer::new(1, [0xf1; 16], "book-A").unwrap();
        prepare_bundle(&root, &pointer);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(pointer.clone()).unwrap();
        let working = publication.create_working_bundle([0xf2; 16]).unwrap();
        let (_, _, knowledge_pages, knowledge_wal) = working.paths();
        let mut knowledge = crate::project_store::ProjectStore::open_existing_with_session_validator(
            &knowledge_pages, &knowledge_wal, working.session_lock_validator(),
        ).unwrap();
        knowledge.put_project("book-A", "narrative_entities", "pending-checkpoint", b"pending")
            .unwrap();
        drop(knowledge);
        let knowledge_wal_before = fs::read(&knowledge_wal).unwrap();

        let session_lock = crate::interprocess_lock::lock_path_for(
            &working.directory.join("SESSION")
        ).unwrap();
        let displaced = session_lock.with_extension("displaced");
        let result = publication.publish_working_bundle_with_hook(
            working,
            [0xf3; 16],
            |stage| {
                if stage == BundleBuildStage::LiveCheckpointed {
                    fs::rename(&session_lock, &displaced).map_err(bundle_io)?;
                    let mut replacement = OpenOptions::new()
                        .write(true).create_new(true).mode(0o600)
                        .open(&session_lock).map_err(bundle_io)?;
                    replacement.sync_all().map_err(bundle_io)?;
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(publication.current(), Some(&pointer));
        assert_eq!(fs::read(&knowledge_wal).unwrap(), knowledge_wal_before,
            "el miembro narrativo no debe checkpointarse tras perder la sesión");

        drop(publication);
        fs::remove_file(&session_lock).unwrap();
        fs::remove_file(&displaced).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn replaced_root_lock_rejects_bundle_reads_inventory_and_mutations() {
        use std::os::unix::fs::OpenOptionsExt;
        let root = root("root-lock-replaced");
        let current = BundlePointer::new(1, [0xf1; 16], "book-A").unwrap();
        let next = BundlePointer::new(2, [0xf2; 16], "book-A").unwrap();
        prepare_bundle(&root, &current);
        prepare_bundle(&root, &next);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(current.clone()).unwrap();

        let lock_path = crate::interprocess_lock::lock_path_for(&root.join("CURRENT")).unwrap();
        let displaced = lock_path.with_extension("displaced");
        fs::rename(&lock_path, &displaced).unwrap();
        OpenOptions::new().write(true).create_new(true).mode(0o600)
            .open(&lock_path).unwrap().sync_all().unwrap();

        assert!(publication.verify_current().is_err());
        assert!(publication.open_current_bundle().is_err());
        assert!(publication.inspect_unreferenced_generations().is_err());
        assert!(publication.create_working_bundle([0xf3; 16]).is_err());
        assert!(publication.publish(next).is_err());
        assert_eq!(publication.current(), Some(&current));

        drop(publication);
        fs::remove_file(lock_path).unwrap();
        fs::remove_file(displaced).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn selector_link_is_not_created_if_session_lock_changes_after_temp_sync() {
        use std::os::unix::fs::OpenOptionsExt;
        let root = root("session-lock-replaced-before-selector-link");
        let current = BundlePointer::new(1, [0xed; 16], "book-A").unwrap();
        let next = BundlePointer::new(2, [0xee; 16], "book-A").unwrap();
        prepare_bundle(&root, &current);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(current.clone()).unwrap();
        let working = publication.create_working_bundle([0xef; 16]).unwrap();
        prepare_bundle(&root, &next);
        let session_lock = crate::interprocess_lock::lock_path_for(
            &working.directory.join("SESSION")
        ).unwrap();
        let displaced = session_lock.with_extension("displaced");

        let result = publication.publish_with_hook_and_session_validator(
            next,
            Some(working.session_lock_validator()),
            |stage| {
                if stage == BundlePublishStage::SelectorTempSynced {
                    fs::rename(&session_lock, &displaced).map_err(bundle_io)?;
                    let mut replacement = OpenOptions::new()
                        .write(true).create_new(true).mode(0o600)
                        .open(&session_lock).map_err(bundle_io)?;
                    replacement.sync_all().map_err(bundle_io)?;
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(publication.current(), Some(&current));
        assert!(!root.join("CURRENT.1").exists());

        drop(working);
        drop(publication);
        fs::remove_file(&session_lock).unwrap();
        fs::remove_file(&displaced).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_replaced_root_lock_rejects_bundle_reads_and_mutations() {
        let root = root("windows-root-lock-replaced");
        let current = BundlePointer::new(1, [0xf1; 16], "book-A").unwrap();
        let next = BundlePointer::new(2, [0xf2; 16], "book-A").unwrap();
        prepare_bundle(&root, &current);
        prepare_bundle(&root, &next);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(current.clone()).unwrap();

        let lock_path = crate::interprocess_lock::lock_path_for(&root.join("CURRENT")).unwrap();
        let displaced = lock_path.with_extension("displaced");
        fs::rename(&lock_path, &displaced).unwrap();
        OpenOptions::new().write(true).create_new(true)
            .open(&lock_path).unwrap().sync_all().unwrap();

        assert!(publication.verify_current().is_err());
        assert!(publication.open_current_bundle().is_err());
        assert!(publication.inspect_unreferenced_generations().is_err());
        assert!(publication.create_working_bundle([0xf3; 16]).is_err());
        assert!(publication.publish(next).is_err());
        assert_eq!(publication.current(), Some(&current));

        drop(publication);
        fs::remove_file(lock_path).unwrap();
        fs::remove_file(displaced).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_selector_link_is_not_created_if_session_lock_changes_after_temp_sync() {
        let root = root("windows-session-lock-replaced-before-selector-link");
        let current = BundlePointer::new(1, [0xed; 16], "book-A").unwrap();
        let next = BundlePointer::new(2, [0xee; 16], "book-A").unwrap();
        prepare_bundle(&root, &current);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(current.clone()).unwrap();
        let working = publication.create_working_bundle([0xef; 16]).unwrap();
        prepare_bundle(&root, &next);
        let session_lock = crate::interprocess_lock::lock_path_for(
            &working.directory.join("SESSION")
        ).unwrap();
        let displaced = session_lock.with_extension("displaced");

        let result = publication.publish_with_hook_and_session_validator(
            next,
            Some(working.session_lock_validator()),
            |stage| {
                if stage == BundlePublishStage::SelectorTempSynced {
                    fs::rename(&session_lock, &displaced).map_err(bundle_io)?;
                    let mut replacement = OpenOptions::new()
                        .write(true).create_new(true).open(&session_lock)
                        .map_err(bundle_io)?;
                    replacement.sync_all().map_err(bundle_io)?;
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(publication.current(), Some(&current));
        assert!(!root.join("CURRENT.1").exists());

        drop(working);
        drop(publication);
        fs::remove_file(&session_lock).unwrap();
        fs::remove_file(&displaced).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn replaced_session_lock_does_not_allow_second_writer_into_working_store() {
        use std::os::unix::fs::OpenOptionsExt;
        let root = root("replaced-session-lock-store-exclusion");
        let pointer = BundlePointer::new(1, [0xe4; 16], "book-A").unwrap();
        prepare_bundle(&root, &pointer);
        let publication = BundlePublicationStore::open(&root).unwrap();
        let working = publication.create_working_bundle([0xe5; 16]).unwrap();
        let (pages, wal, knowledge_pages, knowledge_wal) = working.paths();
        let first_writer = crate::page_journal::DurablePages::open(&pages, &wal).unwrap();
        let first_knowledge_writer =
            crate::page_journal::DurablePages::open(&knowledge_pages, &knowledge_wal).unwrap();

        // Aunque se sustituya el lock de sesión, los locks propios de ambos
        // almacenes siguen impidiendo que un segundo anfitrión abra la sesión.
        let session_lock = crate::interprocess_lock::lock_path_for(
            &working.directory.join("SESSION")
        ).unwrap();
        let displaced = session_lock.with_extension("displaced");
        fs::rename(&session_lock, &displaced).unwrap();
        let replacement = OpenOptions::new()
            .write(true).create_new(true).mode(0o600).open(&session_lock).unwrap();
        replacement.sync_all().unwrap();

        assert!(matches!(
            crate::page_journal::DurablePages::open(&knowledge_pages, &knowledge_wal),
            Err(crate::page_journal::JournalError::AlreadyLocked)
        ));
        assert!(matches!(
            crate::page_journal::DurablePages::open(&pages, &wal),
            Err(crate::page_journal::JournalError::AlreadyLocked)
        ));

        drop(first_knowledge_writer);
        drop(first_writer);
        drop(working);
        fs::remove_file(&session_lock).unwrap();
        fs::remove_file(&displaced).unwrap();
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn working_descriptor_verification_rejects_path_replacement() {
        let root = root("descriptor-path-replacement");
        let source = root.join("store.pages");
        let parked = root.join("store.pages.original");
        fs::write(&source, b"original durable pages").unwrap();
        let descriptor = File::open(&source).unwrap();

        fs::rename(&source, &parked).unwrap();
        fs::write(&source, b"replacement pages").unwrap();

        assert!(verify_working_bundle_descriptor(&source, &descriptor).is_err());
        assert_eq!(fs::read(&parked).unwrap(), b"original durable pages");
        assert_eq!(fs::read(&source).unwrap(), b"replacement pages");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn published_bundle_verification_rejects_symlinked_generation_container() {
        use std::os::unix::fs::symlink;
        let root = root("published-generation-container-symlink");
        let pointer = BundlePointer::new(1, [0xfa; 16], "book-A").unwrap();
        prepare_bundle(&root, &pointer);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(pointer.clone()).unwrap();

        let generations = root.join("generations");
        let parked = root.join("generations-parked");
        fs::rename(&generations, &parked).unwrap();
        symlink(&parked, &generations).unwrap();
        assert!(publication.verify_current().is_err());
        assert!(publication.open_current_bundle().is_err());

        fs::remove_file(&generations).unwrap();
        fs::rename(&parked, &generations).unwrap();
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn published_bundle_verification_rejects_symlinked_member_directory() {
        use std::os::unix::fs::symlink;
        let root = root("published-member-directory-symlink");
        let pointer = BundlePointer::new(1, [0xfb; 16], "book-A").unwrap();
        prepare_bundle(&root, &pointer);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(pointer.clone()).unwrap();

        let generation = root.join("generations").join(&pointer.generation_dir);
        let live = generation.join("live");
        let parked = generation.join("live-parked");
        fs::rename(&live, &parked).unwrap();
        symlink(&parked, &live).unwrap();
        assert!(publication.verify_current().is_err());
        assert!(publication.open_current_bundle().is_err());

        fs::remove_file(&live).unwrap();
        fs::rename(&parked, &live).unwrap();
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn published_bundle_verification_rejects_member_symlink() {
        use std::os::unix::fs::symlink;
        let root = root("published-member-symlink");
        let pointer = BundlePointer::new(1, [0xf8; 16], "book-A").unwrap();
        prepare_bundle(&root, &pointer);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(pointer.clone()).unwrap();

        let pages = root.join("generations").join(&pointer.generation_dir).join("live/store.pages");
        let parked = pages.with_extension("original");
        fs::rename(&pages, &parked).unwrap();
        symlink(&parked, &pages).unwrap();

        assert!(publication.verify_current().is_err());
        assert_eq!(publication.current(), Some(&pointer));

        fs::remove_file(&pages).unwrap();
        fs::rename(&parked, &pages).unwrap();
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn published_bundle_verification_rejects_member_hardlink() {
        use std::os::unix::fs::hard_link;
        let root = root("published-member-hardlink");
        let pointer = BundlePointer::new(1, [0xf9; 16], "book-A").unwrap();
        prepare_bundle(&root, &pointer);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(pointer.clone()).unwrap();

        let pages = root.join("generations").join(&pointer.generation_dir).join("live/store.pages");
        let alias = pages.with_extension("alias");
        hard_link(&pages, &alias).unwrap();

        assert!(publication.verify_current().is_err());
        assert_eq!(publication.current(), Some(&pointer));

        fs::remove_file(&alias).unwrap();
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn bundle_manifest_reader_rejects_hardlinked_metadata_file() {
        use std::os::unix::fs::hard_link;
        let root = root("manifest-reader-hardlink");
        let manifest = root.join("BUNDLE.MANIFEST");
        let alias = root.join("external-alias");
        write_bundle_immutable_file(&manifest, b"manifest bytes").unwrap();
        hard_link(&manifest, &alias).unwrap();

        assert!(read_bundle_regular_file(&manifest, 128).is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bundle_copy_hashes_the_exact_bytes_written_to_destination_descriptor() {
        let root = root("copy-descriptor-digest");
        let source = root.join("source.pages");
        let destination = root.join("destination.pages");
        let contents = b"durable page image with UTF-8: narracion";
        fs::write(&source, contents).unwrap();
        set_bundle_private_file(&source).unwrap();

        let digest = copy_bundle_file_synced(&source, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), contents);
        assert_eq!(digest.length, contents.len() as u64);
        assert_eq!(digest.sha256, bundle_hash(contents));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn bundle_copy_rejects_symlink_source_without_creating_destination() {
        use std::os::unix::fs::symlink;
        let root = root("copy-symlink-source");
        let real = root.join("real.pages");
        let source = root.join("source.pages");
        let destination = root.join("destination.pages");
        fs::write(&real, b"valid pages").unwrap();
        symlink(&real, &source).unwrap();
        assert!(copy_bundle_file_synced(&source, &destination).is_err());
        assert!(!destination.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn bundle_copy_rejects_non_private_source_without_creating_destination() {
        use std::os::unix::fs::PermissionsExt;
        let root = root("copy-non-private-source");
        let source = root.join("source.pages");
        let destination = root.join("destination.pages");
        fs::write(&source, b"private page image").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o644)).unwrap();

        assert!(copy_bundle_file_synced(&source, &destination).is_err());
        assert!(!destination.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn bundle_copy_rejects_hardlinked_source_without_creating_destination() {
        use std::os::unix::fs::hard_link;
        let root = root("copy-hardlink-source");
        let source = root.join("source.pages");
        let alias = root.join("alias.pages");
        let destination = root.join("destination.pages");
        fs::write(&source, b"valid pages").unwrap();
        hard_link(&source, &alias).unwrap();
        assert!(copy_bundle_file_synced(&source, &destination).is_err());
        assert!(!destination.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orphan_inventory_lists_only_complete_verified_unreferenced_generations() {
        let root = root("inventory-complete-orphan");
        let pointer = BundlePointer::new(1, [0xf3; 16], "book-A").unwrap();
        prepare_bundle(&root, &pointer);
        let publication = BundlePublicationStore::open(&root).unwrap();
        let inventory = publication.inspect_unreferenced_generations().unwrap();
        assert_eq!(inventory.unreferenced_generation_directories, vec![pointer.generation_dir.clone()]);
        assert!(inventory.incomplete_generation_directories.is_empty());
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orphan_inventory_fails_closed_when_complete_generation_manifest_is_corrupt() {
        let root = root("inventory-corrupt-complete-orphan");
        let pointer = BundlePointer::new(1, [0xf4; 16], "book-A").unwrap();
        prepare_bundle(&root, &pointer);
        fs::write(
            root.join("generations").join(&pointer.generation_dir).join("BUNDLE.MANIFEST"),
            b"corrupt",
        ).unwrap();
        let publication = BundlePublicationStore::open(&root).unwrap();
        assert!(publication.inspect_unreferenced_generations().is_err());
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }


    #[test]
    fn retry_refuses_to_delete_malformed_or_foreign_selector_temporary() {
        let root = root("retry-foreign-selector-temporary");
        let first = BundlePointer::new(1, [0xf5; 16], "book-A").unwrap();
        let intended = BundlePointer::new(2, [0xf6; 16], "book-A").unwrap();
        let foreign = BundlePointer::new(2, [0xf7; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        prepare_bundle(&root, &intended);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first).unwrap();
        let temporary = root.join(".CURRENT.1.2.tmp");
        fs::write(&temporary, foreign.encode().unwrap()).unwrap();
        assert!(publication.publish(intended).is_err());
        assert_eq!(fs::read(&temporary).unwrap(), foreign.encode().unwrap());
        assert_eq!(publication.current().unwrap().generation, 1);
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }


    #[cfg(unix)]
    #[test]
    fn orphan_inventory_rejects_symlink_even_when_generation_is_protected() {
        use std::os::unix::fs::symlink;
        let root = root("inventory-protected-generation-symlink");
        let pointer = BundlePointer::new(1, [0xf8; 16], "book-A").unwrap();
        prepare_bundle(&root, &pointer);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(pointer.clone()).unwrap();
        let generation = root.join("generations").join(&pointer.generation_dir);
        let parked = root.join("parked-generation");
        fs::rename(&generation, &parked).unwrap();
        symlink(&parked, &generation).unwrap();
        assert!(publication.inspect_unreferenced_generations().is_err());
        fs::remove_file(&generation).unwrap();
        fs::rename(&parked, &generation).unwrap();
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }


    #[cfg(unix)]
    #[test]
    fn orphan_inventory_rejects_symlinked_generations_container() {
        use std::os::unix::fs::symlink;
        let root = root("inventory-generations-container-symlink");
        let publication = BundlePublicationStore::open(&root).unwrap();
        let generations = root.join("generations");
        fs::create_dir(&generations).unwrap();
        let parked = root.join("generations-parked");
        fs::rename(&generations, &parked).unwrap();
        symlink(&parked, &generations).unwrap();
        assert!(publication.inspect_unreferenced_generations().is_err());
        fs::remove_file(&generations).unwrap();
        fs::rename(&parked, &generations).unwrap();
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn orphan_inventory_rejects_symlinked_working_container() {
        use std::os::unix::fs::symlink;
        let root = root("inventory-working-container-symlink");
        let publication = BundlePublicationStore::open(&root).unwrap();
        let working = root.join("working");
        fs::create_dir(&working).unwrap();
        let parked = root.join("working-parked");
        fs::rename(&working, &parked).unwrap();
        symlink(&parked, &working).unwrap();
        assert!(publication.inspect_unreferenced_generations().is_err());
        fs::remove_file(&working).unwrap();
        fs::rename(&parked, &working).unwrap();
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orphan_inventory_classifies_incomplete_generation_without_adopting_it() {
        let root = root("inventory-incomplete-generation");
        let pointer = BundlePointer::new(1, [0xf1; 16], "book-A").unwrap();
        let directory = root.join("generations").join(&pointer.generation_dir);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("partial-member"), b"incomplete").unwrap();
        let publication = BundlePublicationStore::open(&root).unwrap();
        let inventory = publication.inspect_unreferenced_generations().unwrap();
        assert_eq!(inventory.incomplete_generation_directories, vec![pointer.generation_dir.clone()]);
        assert!(inventory.unreferenced_generation_directories.is_empty());
        assert!(directory.join("partial-member").is_file());
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orphan_inventory_reports_valid_selector_temporary_but_never_promotes_it() {
        let root = root("inventory-selector-temporary");
        let pointer = BundlePointer::new(1, [0xf2; 16], "book-A").unwrap();
        prepare_bundle(&root, &pointer);
        let temporary = root.join(".CURRENT.0.1.tmp");
        write_bundle_immutable_file(&temporary, &pointer.encode().unwrap()).unwrap();
        let publication = BundlePublicationStore::open(&root).unwrap();
        assert_eq!(publication.current(), None);
        let inventory = publication.inspect_unreferenced_generations().unwrap();
        assert_eq!(inventory.abandoned_selector_temporaries, vec![".CURRENT.0.1.tmp".to_owned()]);
        assert_eq!(publication.current(), None);
        assert!(temporary.is_file());
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orphan_inventory_fails_closed_on_malformed_selector_temporary() {
        let root = root("inventory-corrupt-selector-temporary");
        let temporary = root.join(".CURRENT.0.1.tmp");
        fs::write(&temporary, b"partial").unwrap();
        let publication = BundlePublicationStore::open(&root).unwrap();
        assert!(publication.inspect_unreferenced_generations().is_err());
        assert!(temporary.is_file());
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn root_lock_rejects_a_second_publisher_until_first_store_closes() {
        let root = root("root-lock-exclusion");
        let first = BundlePublicationStore::open(&root).unwrap();
        assert!(matches!(
            BundlePublicationStore::open(&root),
            Err(BundlePublicationError::Io(_))
        ));
        drop(first);
        let reopened = BundlePublicationStore::open(&root).unwrap();
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bundle_reopens_from_the_only_surviving_valid_selector_slot() {
        for (label, missing_slot) in [("only-slot-zero", 1usize), ("only-slot-one", 0usize)] {
            let root = root(label);
            let first = BundlePointer::new(1, [0xe7; 16], "book-A").unwrap();
            let second = BundlePointer::new(2, [0xe8; 16], "book-A").unwrap();
            prepare_bundle(&root, &first);
            prepare_bundle(&root, &second);
            let expected = if missing_slot == 0 { second.clone() } else { first.clone() };
            {
                let mut publication = BundlePublicationStore::open(&root).unwrap();
                publication.publish(first).unwrap();
                if missing_slot == 0 {
                    publication.publish(second).unwrap();
                }
            }
            let missing = root.join(if missing_slot == 0 { "CURRENT.0" } else { "CURRENT.1" });
            if missing.exists() {
                fs::remove_file(&missing).unwrap();
            }
            let reopened = BundlePublicationStore::open(&root).unwrap();
            assert_eq!(reopened.current(), Some(&expected), "{label}");
            reopened.verify_current().unwrap();
            drop(reopened);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn bundle_does_not_infer_current_generation_when_both_selector_slots_are_missing() {
        let root = root("both-slots-missing");
        let first = BundlePointer::new(1, [0xe6; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let publication = BundlePublicationStore::open(&root).unwrap();
        drop(publication);
        // Una generación completa sin selector no tiene autoridad para convertirse
        // en la generación actual por inferencia del contenido del directorio.
        assert_eq!(
            select_bundle_slots(None, None).unwrap(),
            (None, None)
        );
        let mut reopened = BundlePublicationStore::open(&root).unwrap();
        assert_eq!(reopened.current(), None);
        assert!(reopened.verify_current().is_ok());
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn surviving_selector_never_opens_an_incomplete_generation() {
        for (label, surviving_slot) in [("surviving-slot-zero", 0usize), ("surviving-slot-one", 1usize)] {
            let root = root(label);
            let first = BundlePointer::new(1, [0xe9; 16], "book-A").unwrap();
            let second = BundlePointer::new(2, [0xea; 16], "book-A").unwrap();
            let selected = if surviving_slot == 0 { first.clone() } else { second.clone() };
            prepare_bundle(&root, &first);
            prepare_bundle(&root, &second);
            {
                let mut publication = BundlePublicationStore::open(&root).unwrap();
                publication.publish(first).unwrap();
                if surviving_slot == 1 {
                    publication.publish(second).unwrap();
                }
            }
            let absent_slot = root.join(if surviving_slot == 0 { "CURRENT.1" } else { "CURRENT.0" });
            if absent_slot.exists() {
                fs::remove_file(&absent_slot).unwrap();
            }
            let surviving_path = root.join(if surviving_slot == 0 { "CURRENT.0" } else { "CURRENT.1" });
            let selector_before = fs::read(&surviving_path).unwrap();
            let missing_receipt = root.join("generations").join(&selected.generation_dir)
                .join("knowledge/GENERATION.MANIFEST");
            fs::remove_file(&missing_receipt).unwrap();

            assert!(BundlePublicationStore::open(&root).is_err(), "{label}");
            assert_eq!(fs::read(&surviving_path).unwrap(), selector_before);
            assert!(!absent_slot.exists());
            assert!(!missing_receipt.exists(), "la recuperación no debe reconstruir el miembro ausente");
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn corrupt_active_selector_fails_closed_without_falling_back_to_previous_generation() {
        let root = root("corrupt-active-selector");
        let first = BundlePointer::new(1, [0xe1; 16], "book-A").unwrap();
        let second = BundlePointer::new(2, [0xe2; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        prepare_bundle(&root, &second);
        {
            let mut publication = BundlePublicationStore::open(&root).unwrap();
            publication.publish(first).unwrap();
            publication.publish(second).unwrap();
        }
        let active = root.join("CURRENT.1");
        fs::write(&active, b"broken-selector").unwrap();
        assert!(BundlePublicationStore::open(&root).is_err());
        assert!(root.join("CURRENT.0").is_file());
        assert_eq!(fs::read(&active).unwrap(), b"broken-selector");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_inactive_selector_also_fails_closed_instead_of_guessing() {
        let root = root("corrupt-inactive-selector");
        let first = BundlePointer::new(1, [0xe3; 16], "book-A").unwrap();
        let second = BundlePointer::new(2, [0xe4; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        prepare_bundle(&root, &second);
        {
            let mut publication = BundlePublicationStore::open(&root).unwrap();
            publication.publish(first).unwrap();
            publication.publish(second).unwrap();
        }
        fs::write(root.join("CURRENT.0"), b"broken-old-selector").unwrap();
        assert!(BundlePublicationStore::open(&root).is_err());
        assert!(root.join("CURRENT.1").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bundle_publication_uses_one_selector_for_both_verified_members() {
        let root = root("atomic-selector");
        let first = BundlePointer::new(1, [0x91; 16], "book-A").unwrap();
        let second = BundlePointer::new(2, [0x92; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        prepare_bundle(&root, &second);

        let mut publication = BundlePublicationStore::open(&root).unwrap();
        assert_eq!(publication.current(), None);
        publication.publish(first.clone()).unwrap();
        assert_eq!(publication.current(), Some(&first));
        publication.publish(second.clone()).unwrap();
        assert_eq!(publication.current(), Some(&second));
        assert!(root.join("CURRENT.0").exists());
        assert!(root.join("CURRENT.1").exists());
        drop(publication);

        let reopened = BundlePublicationStore::open(&root).unwrap();
        assert_eq!(reopened.current(), Some(&second));
        let inventory = reopened.inspect_unreferenced_generations().unwrap();
        assert_eq!(
            inventory.abandoned_selector_temporaries,
            vec![".CURRENT.1.2.tmp".to_owned()]
        );
        reopened.verify_current().unwrap();
        {
            let mut bundle = reopened.open_current_bundle().unwrap().unwrap();
            assert_eq!(
                bundle.live().get_project("book-A", "live_state", "record-1").unwrap(),
                Some(b"revision-10".to_vec())
            );
            assert_eq!(
                bundle.knowledge().get_project("book-A", "narrative_entities", "record-1").unwrap(),
                Some(b"character-A".to_vec())
            );
        }
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bundle_publication_rejects_missing_or_corrupt_member_without_switching() {
        let root = root("reject-incomplete");
        let first = BundlePointer::new(1, [0xa1; 16], "book-A").unwrap();
        let second = BundlePointer::new(2, [0xa2; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        prepare_bundle(&root, &second);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first.clone()).unwrap();

        let knowledge_pages = root.join("generations").join(&second.generation_dir)
            .join("knowledge").join("store.pages");
        let mut bytes = fs::read(&knowledge_pages).unwrap();
        bytes[0] ^= 0x80;
        fs::write(&knowledge_pages, bytes).unwrap();

        assert!(publication.publish(second).is_err());
        assert_eq!(publication.current(), Some(&first));
        drop(publication);
        let reopened = BundlePublicationStore::open(&root).unwrap();
        assert_eq!(reopened.current(), Some(&first));
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn working_bundle_clones_both_members_and_publishes_them_with_one_selector() {
        let root = root("working-publish");
        let first = BundlePointer::new(1, [0xd1; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first.clone()).unwrap();

        let working = publication.create_working_bundle([0xd2; 16]).unwrap();
        assert_eq!(working.base_generation(), 1);
        assert_eq!(working.project_id(), "book-A");
        let (live_pages, live_wal, knowledge_pages, knowledge_wal) = working.paths();
        {
            let mut live = crate::project_store::ProjectStore::open_existing(&live_pages, &live_wal).unwrap();
            live.put_project("book-A", "live_state", "record-2", b"revision-11").unwrap();
        }
        {
            let mut knowledge = crate::project_store::ProjectStore::open_existing(&knowledge_pages, &knowledge_wal).unwrap();
            knowledge.put_project("book-A", "narrative_entities", "record-2", b"character-B").unwrap();
        }

        let published = publication.publish_working_bundle(working, [0xd3; 16]).unwrap();
        assert_eq!(published.generation, 2);
        assert_eq!(publication.current(), Some(&published));
        {
            let mut bundle = publication.open_current_bundle().unwrap().unwrap();
            assert_eq!(
                bundle.live().get_project("book-A", "live_state", "record-2").unwrap(),
                Some(b"revision-11".to_vec())
            );
            assert_eq!(
                bundle.knowledge().get_project("book-A", "narrative_entities", "record-2").unwrap(),
                Some(b"character-B".to_vec())
            );
        }
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn working_bundle_reopens_and_rejects_stale_base_publication() {
        let root = root("working-stale");
        let first = BundlePointer::new(1, [0xe1; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first.clone()).unwrap();

        let working_a = publication.create_working_bundle([0xe2; 16]).unwrap();
        let working_b = publication.create_working_bundle([0xe3; 16]).unwrap();
        drop(working_b);
        let reopened = publication.open_working_bundle([0xe3; 16]).unwrap();
        assert_eq!(reopened.base_generation(), 1);

        publication.publish_working_bundle(working_a, [0xe4; 16]).unwrap();
        assert!(matches!(
            publication.publish_working_bundle(reopened, [0xe5; 16]),
            Err(BundlePublicationError::Invalid(
                "working bundle obsoleta: la generación base ya no está activa"
            ))
        ));
        assert_eq!(publication.current().unwrap().generation, 2);
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn working_bundle_fails_closed_when_one_member_file_is_missing() {
        let root = root("working-missing-member");
        let first = BundlePointer::new(1, [0xf1; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first).unwrap();
        let working = publication.create_working_bundle([0xf2; 16]).unwrap();
        let missing = working.knowledge_wal();
        drop(working);
        fs::remove_file(&missing).unwrap();
        assert!(publication.open_working_bundle([0xf2; 16]).is_err());
        assert!(!missing.exists());
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bundle_root_cannot_switch_to_a_different_host_project() {
        let root = root("project-switch");
        let first = BundlePointer::new(1, [0xc1; 16], "book-A").unwrap();
        let other = BundlePointer::new(2, [0xc2; 16], "book-B").unwrap();
        prepare_bundle(&root, &first);
        prepare_bundle(&root, &other);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first.clone()).unwrap();
        assert!(matches!(
            publication.publish(other),
            Err(BundlePublicationError::Invalid(
                "no se puede cambiar el proyecto dentro de la misma raíz de bundle"
            ))
        ));
        assert_eq!(publication.current(), Some(&first));
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bundle_selector_rejects_corrupt_existing_slot_instead_of_falling_back() {
        let root = root("corrupt-slot");
        let pointer = BundlePointer::new(1, [0xb1; 16], "book-A").unwrap();
        prepare_bundle(&root, &pointer);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(pointer).unwrap();
        drop(publication);
        fs::write(root.join("CURRENT.0"), b"broken selector").unwrap();
        assert!(BundlePublicationStore::open(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn selector_failure_before_hard_link_reopens_previous_bundle_and_retry_succeeds() {
        let root = root("selector-before-link");
        let first = BundlePointer::new(1, [0xb8; 16], "book-A").unwrap();
        let second = BundlePointer::new(2, [0xb9; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        prepare_bundle(&root, &second);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first.clone()).unwrap();

        let failed = publication.publish_with_hook(second.clone(), |stage| {
            if stage == BundlePublishStage::SelectorTempSynced {
                Err(BundlePublicationError::Io("fallo inyectado antes del hard link".into()))
            } else {
                Ok(())
            }
        });
        assert!(failed.is_err());
        assert_eq!(publication.current(), Some(&first));
        drop(publication);

        let mut reopened = BundlePublicationStore::open(&root).unwrap();
        assert_eq!(reopened.current(), Some(&first));
        let inventory = reopened.inspect_unreferenced_generations().unwrap();
        assert_eq!(
            inventory.abandoned_selector_temporaries,
            vec![".CURRENT.1.2.tmp".to_owned()]
        );
        assert_eq!(reopened.current(), Some(&first));
        reopened.publish(second.clone()).unwrap();
        assert_eq!(reopened.current(), Some(&second));
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selector_failure_after_hard_link_recovers_the_complete_new_bundle() {
        let root = root("selector-after-link");
        let first = BundlePointer::new(1, [0xba; 16], "book-A").unwrap();
        let second = BundlePointer::new(2, [0xbb; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        prepare_bundle(&root, &second);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first.clone()).unwrap();

        let failed = publication.publish_with_hook(second.clone(), |stage| {
            if stage == BundlePublishStage::SelectorLinked {
                Err(BundlePublicationError::Io("fallo inyectado después del hard link".into()))
            } else {
                Ok(())
            }
        });
        assert!(failed.is_err());
        assert!(publication.recovery_required);
        assert_eq!(publication.current(), Some(&first));
        drop(publication);

        let reopened = BundlePublicationStore::open(&root).unwrap();
        assert_eq!(reopened.current(), Some(&second));
        reopened.verify_current().unwrap();
        let mut bundle = reopened.open_current_bundle().unwrap().unwrap();
        assert_eq!(
            bundle.live().get_project("book-A", "live_state", "record-1").unwrap(),
            Some(b"revision-10".to_vec())
        );
        assert_eq!(
            bundle.knowledge().get_project("book-A", "narrative_entities", "record-1").unwrap(),
            Some(b"character-A".to_vec())
        );
        drop(bundle);
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selector_failures_after_link_cleanup_or_directory_sync_reopen_new_bundle() {
        for (index, fail_stage) in [
            BundlePublishStage::SelectorTempRemoved,
            BundlePublishStage::RootDirectorySynced,
        ].into_iter().enumerate() {
            let root = root("selector-after-link-finalization");
            let first = BundlePointer::new(1, [0xbc + index as u8; 16], "book-A").unwrap();
            let second = BundlePointer::new(2, [0xbe + index as u8; 16], "book-A").unwrap();
            prepare_bundle(&root, &first);
            prepare_bundle(&root, &second);
            let mut publication = BundlePublicationStore::open(&root).unwrap();
            publication.publish(first).unwrap();

            let failed = publication.publish_with_hook(second.clone(), |stage| {
                if stage == fail_stage {
                    Err(BundlePublicationError::Io("fallo inyectado al finalizar selector".into()))
                } else {
                    Ok(())
                }
            });
            assert!(failed.is_err());
            assert!(publication.recovery_required);
            drop(publication);

            let reopened = BundlePublicationStore::open(&root).unwrap();
            assert_eq!(reopened.current(), Some(&second));
            reopened.verify_current().unwrap();
            drop(reopened);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn orphan_inventory_reports_but_never_adopts_or_removes_abandoned_working_temporaries() {
        let root = root("orphan-working-temporary");
        let first = BundlePointer::new(1, [0xd1; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first).unwrap();
        let working_root = root.join("working");
        create_bundle_private_directory(&working_root).unwrap();
        let temporary = working_root.join(".bundle-working-deadbeef.tmp");
        create_bundle_private_directory(&temporary).unwrap();
        let inventory = publication.inspect_unreferenced_generations().unwrap();
        assert_eq!(
            inventory.abandoned_working_temporaries,
            vec![".bundle-working-deadbeef.tmp".to_owned()]
        );
        assert!(temporary.is_dir());
        assert!(publication.open_working_bundle([0xde; 16]).is_err());
        assert!(temporary.is_dir());
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orphan_inventory_reports_active_and_inactive_working_sessions_without_mutating_them() {
        let root = root("inventory-working-session-state");
        let first = BundlePointer::new(1, [0xc0; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first).unwrap();

        let active = publication.create_working_bundle([0xc1; 16]).unwrap();
        let active_name = bundle_working_directory_name(&[0xc1; 16]);
        let inactive = publication.create_working_bundle([0xc2; 16]).unwrap();
        let inactive_name = bundle_working_directory_name(&[0xc2; 16]);
        drop(inactive);

        let inventory = publication.inspect_unreferenced_generations().unwrap();
        assert_eq!(inventory.active_working_bundles, vec![active_name.clone()]);
        assert_eq!(inventory.inactive_working_bundles, vec![inactive_name.clone()]);
        assert!(root.join("working").join(active_name).is_dir());
        assert!(root.join("working").join(inactive_name).is_dir());

        drop(active);
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orphan_inventory_fails_closed_when_working_member_file_is_missing() {
        let root = root("inventory-working-member-missing");
        let first = BundlePointer::new(1, [0xba; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first).unwrap();
        let working = publication.create_working_bundle([0xbb; 16]).unwrap();
        let missing_member = working.knowledge_pages();
        fs::remove_file(&missing_member).unwrap();

        assert!(publication.inspect_unreferenced_generations().is_err());
        assert!(!missing_member.exists(), "el inventario no debe reconstruir miembros ausentes");

        drop(working);
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orphan_inventory_fails_closed_when_working_session_lock_is_missing_without_recreating_it() {
        let root = root("inventory-missing-session-lock");
        let first = BundlePointer::new(1, [0xbf; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first).unwrap();
        let working = publication.create_working_bundle([0xbe; 16]).unwrap();
        let session_lock = crate::interprocess_lock::lock_path_for(
            &working.directory.join("SESSION")
        ).unwrap();
        drop(working);
        fs::remove_file(&session_lock).unwrap();

        assert!(publication.inspect_unreferenced_generations().is_err());
        assert!(!session_lock.exists(), "el inventario no debe recrear locks ausentes");
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orphan_inventory_fails_closed_on_unknown_working_entry() {
        let root = root("inventory-unknown-working-entry");
        let first = BundlePointer::new(1, [0xbd; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first).unwrap();
        let working = root.join("working");
        create_bundle_private_directory(&working).unwrap();
        fs::write(working.join("unexpected.data"), b"unknown").unwrap();
        assert!(publication.inspect_unreferenced_generations().is_err());
        assert_eq!(fs::read(working.join("unexpected.data")).unwrap(), b"unknown");
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orphan_inventory_fails_closed_on_unknown_generation_entry() {
        let root = root("inventory-unknown-generation-entry");
        let first = BundlePointer::new(1, [0xbc; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first).unwrap();
        let generations = root.join("generations");
        fs::write(generations.join("unexpected.data"), b"unknown").unwrap();
        assert!(publication.inspect_unreferenced_generations().is_err());
        assert_eq!(fs::read(generations.join("unexpected.data")).unwrap(), b"unknown");
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orphan_inventory_protects_both_selector_slots_and_working_bundle_bases() {
        let root = root("orphan-inventory-protection");
        let first = BundlePointer::new(1, [0xc1; 16], "book-A").unwrap();
        let second = BundlePointer::new(2, [0xc2; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        prepare_bundle(&root, &second);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first.clone()).unwrap();
        let working = publication.create_working_bundle([0xc3; 16]).unwrap();
        drop(working);
        publication.publish(second.clone()).unwrap();

        let orphan = root.join("generations").join("bundle-gen-999-abandoned");
        create_bundle_private_directory(&orphan).unwrap();
        let inventory = publication.inspect_unreferenced_generations().unwrap();
        assert!(!inventory.unreferenced_generation_directories.contains(&first.generation_dir));
        assert!(!inventory.unreferenced_generation_directories.contains(&second.generation_dir));
        assert!(inventory.unreferenced_generation_directories.contains(&"bundle-gen-999-abandoned".to_owned()));
        assert!(orphan.exists(), "el inventario nunca elimina candidatos");
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orphan_inventory_fails_closed_on_corrupt_working_manifest() {
        let root = root("orphan-inventory-corrupt-working");
        let first = BundlePointer::new(1, [0xc4; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first).unwrap();
        let working = publication.create_working_bundle([0xc5; 16]).unwrap();
        let directory = working.directory.clone();
        drop(working);
        fs::write(directory.join("WORKING.MANIFEST"), b"damaged").unwrap();
        assert!(publication.inspect_unreferenced_generations().is_err());
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preparation_failures_never_switch_to_a_partial_bundle_and_old_bundle_reopens() {
        let stages = [
            BundleBuildStage::LiveCheckpointed,
            BundleBuildStage::KnowledgeCheckpointed,
            BundleBuildStage::LivePagesCopied,
            BundleBuildStage::LiveWalCopied,
            BundleBuildStage::KnowledgePagesCopied,
            BundleBuildStage::KnowledgeWalCopied,
            BundleBuildStage::LiveReceiptWritten,
            BundleBuildStage::KnowledgeReceiptWritten,
            BundleBuildStage::BundleManifestWritten,
            BundleBuildStage::GenerationDirectoriesSynced,
        ];
        for (index, fail_stage) in stages.into_iter().enumerate() {
            let root = root("build-failure-before-selector");
            let first = BundlePointer::new(1, [0x60 + index as u8; 16], "book-A").unwrap();
            prepare_bundle(&root, &first);
            let mut publication = BundlePublicationStore::open(&root).unwrap();
            publication.publish(first.clone()).unwrap();
            let working = publication.create_working_bundle([0x70 + index as u8; 16]).unwrap();

            let result = publication.publish_working_bundle_with_hook(
                working, [0x80 + index as u8; 16], |stage| {
                    if stage == fail_stage {
                        Err(BundlePublicationError::Io("fallo inyectado durante preparación".into()))
                    } else {
                        Ok(())
                    }
                },
            );
            assert!(result.is_err(), "el failpoint {fail_stage:?} debía interrumpir la preparación");
            assert_eq!(publication.current(), Some(&first));
            assert!(!publication.recovery_required);
            drop(publication);

            let reopened = BundlePublicationStore::open(&root).unwrap();
            assert_eq!(reopened.current(), Some(&first));
            reopened.verify_current().unwrap();

            // La generación que no llegó al selector nunca se adopta. El
            // inventario distingue el directorio parcial del bundle completo
            // que quedó preparado antes de la interrupción.
            let inventory = reopened.inspect_unreferenced_generations().unwrap();
            let interrupted = BundlePointer::new(
                2, [0x80 + index as u8; 16], "book-A",
            ).unwrap();
            if index >= 2 && index < 8 {
                assert!(inventory.incomplete_generation_directories.contains(&interrupted.generation_dir));
                assert!(!inventory.unreferenced_generation_directories.contains(&interrupted.generation_dir));
            } else if index >= 8 {
                assert!(inventory.unreferenced_generation_directories.contains(&interrupted.generation_dir));
                assert!(!inventory.incomplete_generation_directories.contains(&interrupted.generation_dir));
            } else {
                assert!(!inventory.incomplete_generation_directories.contains(&interrupted.generation_dir));
                assert!(!inventory.unreferenced_generation_directories.contains(&interrupted.generation_dir));
            }

            let mut bundle = reopened.open_current_bundle().unwrap().unwrap();
            assert_eq!(
                bundle.live().get_project("book-A", "live_state", "record-1").unwrap(),
                Some(b"revision-10".to_vec())
            );
            assert_eq!(
                bundle.knowledge().get_project("book-A", "narrative_entities", "record-1").unwrap(),
                Some(b"character-A".to_vec())
            );
            drop(bundle);
            drop(reopened);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn working_bundle_session_lock_rejects_a_second_host_and_allows_reopen_after_drop() {
        let root = root("session-lock");
        let first = BundlePointer::new(1, [0xb2; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first).unwrap();

        let session = publication.create_working_bundle([0xb3; 16]).unwrap();
        assert!(publication.open_working_bundle([0xb3; 16]).is_err());
        drop(session);
        let reopened = publication.open_working_bundle([0xb3; 16]).unwrap();
        assert_eq!(reopened.project_id(), "book-A");
        drop(reopened);
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }



    #[cfg(unix)]
    #[test]
    fn publication_rejects_working_member_directory_replaced_during_session() {
        use std::os::unix::fs::symlink;
        let root = root("publish-working-member-symlink");
        let first = BundlePointer::new(1, [0xe5; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first.clone()).unwrap();
        let working = publication.create_working_bundle([0xe6; 16]).unwrap();
        let directory = working.directory.clone();

        let live = directory.join("live");
        let parked = directory.join("live-parked");
        fs::rename(&live, &parked).unwrap();
        symlink(&parked, &live).unwrap();
        assert!(publication.publish_working_bundle(working, [0xe7; 16]).is_err());
        assert_eq!(publication.current(), Some(&first));

        fs::remove_file(&live).unwrap();
        fs::rename(&parked, &live).unwrap();
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn publication_rejects_working_member_hardlink_created_during_session() {
        use std::os::unix::fs::hard_link;

        let root = root("publish-working-member-hardlink");
        let first = BundlePointer::new(1, [0xe8; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first.clone()).unwrap();
        let working = publication.create_working_bundle([0xe9; 16]).unwrap();

        let pages = working.live_pages();
        let parked = working.directory.join("live-pages-parked");
        fs::rename(&pages, &parked).unwrap();
        hard_link(&parked, &pages).unwrap();

        assert!(publication.publish_working_bundle(working, [0xea; 16]).is_err());
        assert_eq!(publication.current(), Some(&first));

        fs::remove_file(&pages).unwrap();
        fs::rename(&parked, &pages).unwrap();
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn bundle_copy_rejects_hardlinked_source() {
        use std::os::unix::fs::{hard_link, PermissionsExt};
        let root = root("copy-hardlink");
        let source = root.join("source.bin");
        let alias = root.join("source.alias");
        let destination = root.join("destination.bin");
        fs::write(&source, b"private-bundle-source").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
        hard_link(&source, &alias).unwrap();
        assert!(copy_bundle_file_synced(&source, &destination).is_err());
        fs::remove_file(&alias).unwrap();
        let digest = copy_bundle_file_synced(&source, &destination).unwrap();
        assert_eq!(digest.length, b"private-bundle-source".len() as u64);
        assert_eq!(fs::read(destination).unwrap(), b"private-bundle-source");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn working_bundle_rejects_symlinked_member_directory() {
        use std::os::unix::fs::symlink;
        let root = root("working-member-directory-symlink");
        let first = BundlePointer::new(1, [0xe1; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let publication = BundlePublicationStore::open(&root).unwrap();
        let working = publication.create_working_bundle([0xe2; 16]).unwrap();
        let directory = working.directory.clone();
        drop(working);

        let live = directory.join("live");
        let parked = directory.join("live-parked");
        fs::rename(&live, &parked).unwrap();
        symlink(&parked, &live).unwrap();
        assert!(publication.open_working_bundle([0xe2; 16]).is_err());

        fs::remove_file(&live).unwrap();
        fs::rename(&parked, &live).unwrap();
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn working_bundle_rejects_symlinked_working_root() {
        use std::os::unix::fs::symlink;
        let root = root("working-root-symlink");
        let first = BundlePointer::new(1, [0xe3; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let publication = BundlePublicationStore::open(&root).unwrap();
        let working = publication.create_working_bundle([0xe4; 16]).unwrap();
        drop(working);

        let working_root = root.join("working");
        let parked = root.join("working-parked");
        fs::rename(&working_root, &parked).unwrap();
        symlink(&parked, &working_root).unwrap();
        assert!(publication.open_working_bundle([0xe4; 16]).is_err());

        fs::remove_file(&working_root).unwrap();
        fs::rename(&parked, &working_root).unwrap();
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn working_bundle_directories_and_files_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let root = root("private-permissions");
        let first = BundlePointer::new(1, [0xb4; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first).unwrap();
        let working = publication.create_working_bundle([0xb5; 16]).unwrap();
        let directory = working.directory.clone();
        assert_eq!(fs::metadata(&directory).unwrap().permissions().mode() & 0o777, 0o700);
        for path in [
            directory.join("WORKING.MANIFEST"),
            working.live_pages(),
            working.live_wal(),
            working.knowledge_pages(),
            working.knowledge_wal(),
        ] {
            assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        drop(working);
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn abandoned_working_temporary_is_never_adopted_or_overwritten() {
        let root = root("abandoned-temp");
        let first = BundlePointer::new(1, [0xb6; 16], "book-A").unwrap();
        prepare_bundle(&root, &first);
        let mut publication = BundlePublicationStore::open(&root).unwrap();
        publication.publish(first).unwrap();

        let working_root = root.join("working");
        create_bundle_private_directory(&working_root).unwrap();
        let name = bundle_working_directory_name(&[0xb7; 16]);
        let temporary = working_root.join(format!(".{name}.tmp"));
        create_bundle_private_directory(&temporary).unwrap();
        fs::write(temporary.join("partial"), b"interrupted").unwrap();

        assert!(publication.create_working_bundle([0xb7; 16]).is_err());
        assert!(temporary.join("partial").exists());
        assert!(!working_root.join(name).exists());
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selector_slot_matrix_rejects_ambiguous_or_nonconsecutive_states() {
        let first = BundlePointer::new(1, [0xd1; 16], "book-A").unwrap();
        let second = BundlePointer::new(2, [0xd2; 16], "book-A").unwrap();
        let gap = BundlePointer::new(3, [0xd3; 16], "book-A").unwrap();
        let other_project = BundlePointer::new(2, [0xd4; 16], "book-B").unwrap();
        let conflicting_same_generation =
            BundlePointer::new(1, [0xd5; 16], "book-A").unwrap();

        assert_eq!(
            select_bundle_slots(Some(first.clone()), None).unwrap(),
            (Some(0), Some(first.clone()))
        );
        assert_eq!(
            select_bundle_slots(None, Some(first.clone())).unwrap(),
            (Some(1), Some(first.clone()))
        );
        assert_eq!(
            select_bundle_slots(Some(first.clone()), Some(second.clone())).unwrap(),
            (Some(1), Some(second))
        );
        assert_eq!(
            select_bundle_slots(Some(first.clone()), Some(first.clone())).unwrap(),
            (Some(0), Some(first.clone()))
        );
        assert!(select_bundle_slots(Some(first.clone()), Some(gap)).is_err());
        assert!(select_bundle_slots(Some(first.clone()), Some(other_project)).is_err());
        assert!(select_bundle_slots(Some(first), Some(conflicting_same_generation)).is_err());
    }

    #[test]
    fn corrupt_newest_generation_never_falls_back_to_previous_bundle() {
        for (label, relative_path) in [
            ("bundle-manifest", "BUNDLE.MANIFEST"),
            ("live-receipt", "live/GENERATION.MANIFEST"),
            ("knowledge-receipt", "knowledge/GENERATION.MANIFEST"),
            ("live-pages", "live/store.pages"),
            ("live-wal", "live/store.mlpj"),
            ("knowledge-pages", "knowledge/store.pages"),
            ("knowledge-wal", "knowledge/store.mlpj"),
        ] {
            let root = root(label);
            let first = BundlePointer::new(1, [0xd6; 16], "book-A").unwrap();
            let second = BundlePointer::new(2, [0xd7; 16], "book-A").unwrap();
            prepare_bundle_with_values(&root, &first, b"previous-live", b"previous-knowledge");
            prepare_bundle_with_values(&root, &second, b"current-live", b"current-knowledge");
            let mut publication = BundlePublicationStore::open(&root).unwrap();
            publication.publish(first.clone()).unwrap();
            publication.publish(second.clone()).unwrap();
            drop(publication);

            let damaged = root.join("generations").join(&second.generation_dir).join(relative_path);
            let mut bytes = fs::read(&damaged).unwrap();
            assert!(!bytes.is_empty());
            bytes[0] ^= 0x5a;
            fs::write(&damaged, bytes).unwrap();

            // El slot anterior sigue siendo válido, pero una generación activa
            // dañada no autoriza fallback silencioso ni mezcla de miembros.
            assert!(BundlePublicationStore::open(&root).is_err(), "{label}");
            assert!(root.join("CURRENT.0").is_file());
            assert!(root.join("CURRENT.1").is_file());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn selector_crash_reopen_keeps_one_complete_bundle_at_each_commit_boundary() {
        // Simula la terminación del proceso cerrando la instancia exactamente
        // después de cada frontera. No pretende simular pérdida física de caché
        // del sistema operativo ante un corte eléctrico.
        for (label, interrupted_stage, expected_generation, expect_temporary) in [
            ("before-link", BundlePublishStage::SelectorTempSynced, 1, true),
            ("after-link", BundlePublishStage::SelectorLinked, 2, true),
            ("after-root-sync", BundlePublishStage::RootDirectorySynced, 2, false),
        ] {
            let root = root(label);
            let first = BundlePointer::new(1, [0xc1; 16], "book-A").unwrap();
            let second = BundlePointer::new(2, [0xc2; 16], "book-A").unwrap();
            prepare_bundle_with_values(&root, &first, b"live-generation-one", b"knowledge-generation-one");
            prepare_bundle_with_values(&root, &second, b"live-generation-two", b"knowledge-generation-two");

            let mut publication = BundlePublicationStore::open(&root).unwrap();
            publication.publish(first.clone()).unwrap();

            let result = publication.publish_with_hook(second.clone(), |stage| {
                if stage == interrupted_stage {
                    Err(BundlePublicationError::Invalid("interrupción simulada"))
                } else {
                    Ok(())
                }
            });
            assert!(result.is_err(), "la interrupción debe propagarse en {label}");
            drop(publication);

            // La reapertura debe resolver la autoridad únicamente desde los
            // slots durables, nunca desde el temporal aislado.
            let reopened = BundlePublicationStore::open(&root).unwrap();
            let expected = if expected_generation == 1 { &first } else { &second };
            assert_eq!(reopened.current(), Some(expected), "generación incorrecta en {label}");

            let mut bundle = reopened.open_current_bundle().unwrap().unwrap();
            let expected_live = if expected_generation == 1 { b"live-generation-one".as_slice() } else { b"live-generation-two".as_slice() };
            let expected_knowledge = if expected_generation == 1 { b"knowledge-generation-one".as_slice() } else { b"knowledge-generation-two".as_slice() };
            assert_eq!(
                bundle.live().get_project("book-A", "live_state", "record-1").unwrap(),
                Some(expected_live.to_vec())
            );
            assert_eq!(
                bundle.knowledge().get_project("book-A", "narrative_entities", "record-1").unwrap(),
                Some(expected_knowledge.to_vec())
            );
            drop(bundle);

            let temporary = root.join(format!(".CURRENT.1.2.tmp"));
            assert_eq!(temporary.exists(), expect_temporary, "temporal inesperado en {label}");
            if expect_temporary {
                let inventory = reopened.inspect_unreferenced_generations().unwrap();
                assert!(inventory.abandoned_selector_temporaries.contains(&".CURRENT.1.2.tmp".to_owned()));
            }
            drop(reopened);
            fs::remove_dir_all(root).unwrap();
        }
    }

}

fn sync_bundle_directory(path: &Path) -> Result<(), BundlePublicationError> {
    #[cfg(unix)]
    File::open(path).and_then(|directory| directory.sync_all()).map_err(bundle_io)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
