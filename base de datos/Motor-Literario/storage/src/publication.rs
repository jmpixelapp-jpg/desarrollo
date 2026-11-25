//! Selector durable de generaciones publicadas de ProjectStore.
//! No mueve archivos ni cambia el manifiesto: solo publica una pareja ya preparada.
use crate::interprocess_lock::InterprocessLock;
use crate::migration::Sha256;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

const MAGIC: &[u8; 8] = b"MLPUB001";
pub const FORMAT_VERSION: u16 = 1;
const MAX_POINTER_BYTES: usize = 512;
const CHECKSUM_BYTES: usize = 32;
const RECEIPT_MAGIC: &[u8; 8] = b"MLGEN001";
const RECEIPT_VERSION: u16 = 1;
const RECEIPT_BYTES: usize = 8 + 2 + 8 + 16 + 8 + 8 + 32 + 32 + 32;
const WORKING_MAGIC:&[u8;8]=b"MLWORK01";
const WORKING_VERSION:u16=1;
const WORKING_MANIFEST_BYTES:usize=8+2+16+8+16+32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PublicationError {
    Io(String),
    Invalid(&'static str),
    Truncated,
    UnsupportedVersion(u16),
    ChecksumMismatch,
    TrailingBytes,
}

impl std::fmt::Display for PublicationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(message) => write!(f, "I/O del selector de publicación: {message}"),
            Self::Invalid(message) => write!(f, "selector de publicación inválido: {message}"),
            Self::Truncated => write!(f, "selector de publicación truncado"),
            Self::UnsupportedVersion(version) => write!(f, "versión de selector no compatible: {version}"),
            Self::ChecksumMismatch => write!(f, "checksum SHA-256 del selector incorrecto"),
            Self::TrailingBytes => write!(f, "bytes sobrantes en el selector de publicación"),
        }
    }
}
impl std::error::Error for PublicationError {}

#[derive(Debug)]
pub enum PublishedStoreOpenError {
    Publication(PublicationError),
    Store(crate::btree::BTreeError),
}
impl std::fmt::Display for PublishedStoreOpenError {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {
        match self {
            Self::Publication(error)=>write!(f,"publicación: {error}"),
            Self::Store(error)=>write!(f,"ProjectStore: {error}"),
        }
    }
}
impl std::error::Error for PublishedStoreOpenError {}

#[derive(Debug)]
pub enum WorkingStoreError {
    Publication(PublicationError),
    Store(crate::btree::BTreeError),
}
impl std::fmt::Display for WorkingStoreError {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {
        match self {
            Self::Publication(error)=>write!(f,"working copy: {error}"),
            Self::Store(error)=>write!(f,"ProjectStore de trabajo: {error}"),
        }
    }
}
impl std::error::Error for WorkingStoreError {}

/// Almacén mutable aislado, clonado lógicamente desde una generación publicada.
/// El manifiesto conserva el origen para que el anfitrión pueda detectar ramas obsoletas.
pub struct WorkingProjectStore {
    inner:crate::project_store::ProjectStore,
    working_id:[u8;16],
    base:PublicationPointer,
}
impl WorkingProjectStore {
    pub fn working_id(&self)->[u8;16]{self.working_id}
    pub fn base_generation(&self)->u64{self.base.generation}
    pub fn base_migration_id(&self)->[u8;16]{self.base.migration_id}
    pub fn put_project(&mut self,project_id:&str,table:&str,record_id:&str,value:&[u8])->Result<(),crate::btree::BTreeError>{
        self.inner.put_project(project_id,table,record_id,value)
    }
    pub fn get_project(&mut self,project_id:&str,table:&str,record_id:&str)->Result<Option<Vec<u8>>,crate::btree::BTreeError>{
        self.inner.get_project(project_id,table,record_id)
    }
    pub fn delete_project(&mut self,project_id:&str,table:&str,record_id:&str)->Result<bool,crate::btree::BTreeError>{
        self.inner.delete_project(project_id,table,record_id)
    }
    pub fn apply_batch(&mut self,operations:Vec<crate::project_store::ProjectOperation>)->Result<Vec<crate::project_store::ProjectBatchResult>,crate::btree::BTreeError>{
        self.inner.apply_batch(operations)
    }
    pub fn scan_all_iter(&mut self)->Result<crate::project_store::ProjectStoreRange<'_>,crate::btree::BTreeError>{
        self.inner.scan_all_iter()
    }
    pub fn scan_project_table_iter<'a>(&'a mut self,project_id:&str,table:&str)->Result<crate::project_store::ProjectTableRange<'a>,crate::btree::BTreeError>{
        self.inner.scan_project_table_iter(project_id,table)
    }
    pub fn scan_project_table_after_iter<'a>(&'a mut self,project_id:&str,table:&str,after_record_id:&str)->Result<crate::project_store::ProjectTableRange<'a>,crate::btree::BTreeError>{
        self.inner.scan_project_table_after_iter(project_id,table,after_record_id)
    }
    pub fn validate(&mut self)->Result<crate::btree::ValidationReport,crate::btree::BTreeError>{self.inner.validate()}
    pub fn checkpoint(&mut self)->Result<(),crate::btree::BTreeError>{self.inner.checkpoint()}
    pub(crate) fn paths(&self)->(&Path,&Path){self.inner.paths()}
}

/// Vista de solo lectura lógica sobre una generación publicada e inmutable.
/// No expone put/delete/checkpoint ni el ProjectStore interno.
pub struct PublishedProjectStore {
    inner:crate::project_store::ProjectStore,
}
impl PublishedProjectStore {
    pub fn get_project(
        &mut self,project_id:&str,table:&str,record_id:&str,
    )->Result<Option<Vec<u8>>,crate::btree::BTreeError>{
        self.inner.get_project(project_id,table,record_id)
    }
    pub fn scan_project_table(
        &mut self,project_id:&str,table:&str,
    )->Result<Vec<(String,Vec<u8>)>,crate::btree::BTreeError>{
        self.inner.scan_project_table(project_id,table)
    }
    pub fn scan_project_table_iter<'a>(
        &'a mut self,project_id:&str,table:&str,
    )->Result<crate::project_store::ProjectTableRange<'a>,crate::btree::BTreeError>{
        self.inner.scan_project_table_iter(project_id,table)
    }
    pub fn scan_project_table_after_iter<'a>(
        &'a mut self,project_id:&str,table:&str,after_record_id:&str,
    )->Result<crate::project_store::ProjectTableRange<'a>,crate::btree::BTreeError>{
        self.inner.scan_project_table_after_iter(project_id,table,after_record_id)
    }
    pub fn scan_all_iter(
        &mut self,
    )->Result<crate::project_store::ProjectStoreRange<'_>,crate::btree::BTreeError>{
        self.inner.scan_all_iter()
    }
    pub fn validate(&mut self)->Result<crate::btree::ValidationReport,crate::btree::BTreeError>{
        self.inner.validate()
    }
    pub(crate) fn as_mut_project_store(&mut self)->&mut crate::project_store::ProjectStore{
        &mut self.inner
    }
}


/// Abre un miembro inmutable de bundle verificando receipt sobre los mismos
/// descriptores que DurablePages utilizará sin permitir recuperación ni escritura WAL.
pub(crate) fn open_verified_bundle_member(
    pages_path: impl AsRef<Path>,
    wal_path: impl AsRef<Path>,
    receipt: &GenerationReceipt,
) -> Result<PublishedProjectStore, PublishedStoreOpenError> {
    let pages_path = pages_path.as_ref().to_path_buf();
    let wal_path = wal_path.as_ref().to_path_buf();
    let inner = crate::project_store::ProjectStore::open_read_only_with_pre_recovery_verification(
        &pages_path,
        &wal_path,
        |pages, wal| {
            verify_published_descriptor(&pages_path, pages)?;
            verify_published_descriptor(&wal_path, wal)?;
            receipt.verify_open_files(pages, wal)?;
            // El hash puede tardar; repetir la comprobación al terminar para
            // detectar sustituciones o hardlinks introducidos durante lectura.
            verify_published_descriptor(&pages_path, pages)?;
            verify_published_descriptor(&wal_path, wal)
        },
    ).map_err(PublishedStoreOpenError::Store)?;
    Ok(PublishedProjectStore { inner })
}

fn verify_published_descriptor(path: &Path, file: &File) -> std::io::Result<()> {
    let opened = file.metadata()?;
    let current = fs::symlink_metadata(path)?;
    if !opened.is_file() || current.file_type().is_symlink() || !current.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "archivo publicado no es regular",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if opened.dev() != current.dev() || opened.ino() != current.ino()
            || opened.nlink() != 1 || opened.permissions().mode() & 0o077 != 0
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "descriptor publicado sustituido, compartido o no privado",
            ));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.volume_serial_number().is_none()
            || opened.file_index().is_none()
            || opened.volume_serial_number() != current.volume_serial_number()
            || opened.file_index() != current.file_index()
            || opened.number_of_links() != Some(1)
            || opened.len() != current.len()
            || opened.creation_time() != current.creation_time()
            || opened.last_write_time() != current.last_write_time()
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "descriptor publicado sustituido, compartido o modificado",
            ));
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        if opened.len() != current.len() || opened.modified().ok() != current.modified().ok() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "descriptor publicado no coincide con su ruta",
            ));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicationPointer {
    pub generation: u64,
    pub migration_id: [u8; 16],
    pub generation_dir: String,
}

impl PublicationPointer {
    pub fn new(generation: u64, migration_id: [u8; 16]) -> Result<Self, PublicationError> {
        let pointer = Self {
            generation,
            migration_id,
            generation_dir: generation_directory_name(generation, &migration_id),
        };
        pointer.validate()?;
        Ok(pointer)
    }

    pub fn validate(&self) -> Result<(), PublicationError> {
        if self.generation == 0 {
            return Err(PublicationError::Invalid("generación cero"));
        }
        if self.generation_dir != generation_directory_name(self.generation, &self.migration_id) {
            return Err(PublicationError::Invalid("el directorio no coincide con generación e identidad"));
        }
        if self.generation_dir.len() > 128
            || !self.generation_dir.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(PublicationError::Invalid("nombre de generación no permitido"));
        }
        Ok(())
    }

    pub fn encode(&self) -> Result<Vec<u8>, PublicationError> {
        self.validate()?;
        let mut bytes = Vec::with_capacity(8 + 2 + 8 + 16 + 2 + self.generation_dir.len() + CHECKSUM_BYTES);
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        bytes.extend_from_slice(&self.generation.to_le_bytes());
        bytes.extend_from_slice(&self.migration_id);
        let name_len = u16::try_from(self.generation_dir.len())
            .map_err(|_| PublicationError::Invalid("nombre demasiado largo"))?;
        bytes.extend_from_slice(&name_len.to_le_bytes());
        bytes.extend_from_slice(self.generation_dir.as_bytes());
        let mut hash = Sha256::new();
        hash.update(&bytes);
        bytes.extend_from_slice(&hash.finish());
        if bytes.len() > MAX_POINTER_BYTES {
            return Err(PublicationError::Invalid("selector excede el tamaño máximo"));
        }
        Ok(bytes)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, PublicationError> {
        if bytes.len() > MAX_POINTER_BYTES {
            return Err(PublicationError::Invalid("selector excede el tamaño máximo"));
        }
        if bytes.len() < 8 + 2 + 8 + 16 + 2 + CHECKSUM_BYTES {
            return Err(PublicationError::Truncated);
        }
        if &bytes[..8] != MAGIC {
            return Err(PublicationError::Invalid("magic incorrecto"));
        }
        let version = u16::from_le_bytes(bytes[8..10].try_into().unwrap());
        if version != FORMAT_VERSION {
            return Err(PublicationError::UnsupportedVersion(version));
        }
        let checksum_at = bytes.len() - CHECKSUM_BYTES;
        let mut hash = Sha256::new();
        hash.update(&bytes[..checksum_at]);
        let expected_checksum = hash.finish();
        if expected_checksum[..] != bytes[checksum_at..] {
            return Err(PublicationError::ChecksumMismatch);
        }
        let generation = u64::from_le_bytes(bytes[10..18].try_into().unwrap());
        let migration_id: [u8; 16] = bytes[18..34].try_into().unwrap();
        let name_len = u16::from_le_bytes(bytes[34..36].try_into().unwrap()) as usize;
        let name_end = 36usize.checked_add(name_len).ok_or(PublicationError::Truncated)?;
        if name_end != checksum_at {
            return if name_end > checksum_at {
                Err(PublicationError::Truncated)
            } else {
                Err(PublicationError::TrailingBytes)
            };
        }
        let generation_dir = String::from_utf8(bytes[36..name_end].to_vec())
            .map_err(|_| PublicationError::Invalid("nombre de generación no es UTF-8"))?;
        let pointer = Self { generation, migration_id, generation_dir };
        pointer.validate()?;
        Ok(pointer)
    }
}

fn generation_directory_name(generation: u64, migration_id: &[u8; 16]) -> String {
    let mut hex = String::with_capacity(32);
    for byte in migration_id {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    format!("gen-{generation}-{hex}")
}


#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileDigest {
    pub length: u64,
    pub sha256: [u8; 32],
}

/// Huella durable de los dos archivos de una generación publicada.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GenerationReceipt {
    pub generation: u64,
    pub migration_id: [u8; 16],
    pub pages: FileDigest,
    pub wal: FileDigest,
}

impl GenerationReceipt {
    /// Compara la receipt con los mismos descriptores que serán entregados a
    /// DurablePages. No abre rutas y deja ambos descriptores rebobinados.
    pub(crate) fn verify_open_files(&self,pages:&mut File,wal:&mut File)->std::io::Result<()>{
        let pages_digest=hash_open_file(pages)?;
        let wal_digest=hash_open_file(wal)?;
        if pages_digest!=self.pages || wal_digest!=self.wal {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"SHA-256 o tamaño no coincide con GENERATION.MANIFEST"));
        }
        pages.seek(std::io::SeekFrom::Start(0))?;
        wal.seek(std::io::SeekFrom::Start(0))?;
        Ok(())
    }

    /// Crea una receipt desde los archivos de una generación todavía no publicada.
    /// El llamador debe mantener el bloqueo del publicador y garantizar que el
    /// directorio no sea una generación ya visible.
    pub fn create_from_files(
        directory: &Path,
        pointer: &PublicationPointer,
    ) -> Result<Self, PublicationError> {
        let pages = hash_regular_file(&directory.join("store.pages"))?;
        let wal = hash_regular_file(&directory.join("store.mlpj"))?;
        Self::write(directory, pointer, pages, wal)
    }

    /// Escribe una receipt inmutable sin adquirir por sí misma el bloqueo raíz.
    /// El llamador debe validar y mantener el bloqueo de publicación durante
    /// toda la preparación; este método solo protege la creación del archivo.
    pub fn write(
        directory: &Path,
        pointer: &PublicationPointer,
        pages: FileDigest,
        wal: FileDigest,
    ) -> Result<Self, PublicationError> {
        pointer.validate()?;
        ensure_regular_directory(directory)?;
        let receipt = Self {
            generation: pointer.generation,
            migration_id: pointer.migration_id,
            pages,
            wal,
        };
        let encoded = receipt.encode()?;
        let temporary = directory.join("GENERATION.MANIFEST.tmp");
        let final_path = directory.join("GENERATION.MANIFEST");

        // Una receipt publicada es inmutable. Nunca permitir que un reintento
        // la sustituya, ni siquiera si el archivo existente es un symlink.
        match fs::symlink_metadata(&final_path) {
            Ok(_) => return Err(PublicationError::Invalid("la receipt de generación ya existe")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }

        // Un cierre abrupto puede dejar el temporal incompleto. Es seguro
        // descartarlo mientras todavía no exista la receipt definitiva.
        match fs::symlink_metadata(&temporary) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(PublicationError::Invalid("temporal de receipt no es archivo regular"));
                }
                fs::remove_file(&temporary).map_err(io_error)?;
                sync_directory(directory)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }

        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(io_error)?;
        file.write_all(&encoded).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);
        // hard_link crea el nombre definitivo de forma atómica y falla si
        // otro escritor ya publicó una receipt; rename podría sobrescribirla.
        if let Err(error) = fs::hard_link(&temporary, &final_path) {
            return Err(io_error(error));
        }
        fs::remove_file(&temporary).map_err(io_error)?;
        sync_directory(directory)?;
        Ok(receipt)
    }

    pub fn encode(&self) -> Result<Vec<u8>, PublicationError> {
        if self.generation == 0 {
            return Err(PublicationError::Invalid("receipt con generación cero"));
        }
        let mut bytes = Vec::with_capacity(RECEIPT_BYTES);
        bytes.extend_from_slice(RECEIPT_MAGIC);
        bytes.extend_from_slice(&RECEIPT_VERSION.to_le_bytes());
        bytes.extend_from_slice(&self.generation.to_le_bytes());
        bytes.extend_from_slice(&self.migration_id);
        bytes.extend_from_slice(&self.pages.length.to_le_bytes());
        bytes.extend_from_slice(&self.wal.length.to_le_bytes());
        bytes.extend_from_slice(&self.pages.sha256);
        bytes.extend_from_slice(&self.wal.sha256);
        let mut hash = Sha256::new();
        hash.update(&bytes);
        bytes.extend_from_slice(&hash.finish());
        Ok(bytes)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, PublicationError> {
        if bytes.len() < RECEIPT_BYTES { return Err(PublicationError::Truncated); }
        if bytes.len() > RECEIPT_BYTES { return Err(PublicationError::TrailingBytes); }
        if &bytes[..8] != RECEIPT_MAGIC {
            return Err(PublicationError::Invalid("magic del receipt incorrecto"));
        }
        let version = u16::from_le_bytes(bytes[8..10].try_into().unwrap());
        if version != RECEIPT_VERSION {
            return Err(PublicationError::UnsupportedVersion(version));
        }
        let checksum_at = RECEIPT_BYTES - CHECKSUM_BYTES;
        let mut hash = Sha256::new();
        hash.update(&bytes[..checksum_at]);
        let expected = hash.finish();
        if expected[..] != bytes[checksum_at..] {
            return Err(PublicationError::ChecksumMismatch);
        }
        let receipt = Self {
            generation: u64::from_le_bytes(bytes[10..18].try_into().unwrap()),
            migration_id: bytes[18..34].try_into().unwrap(),
            pages: FileDigest {
                length: u64::from_le_bytes(bytes[34..42].try_into().unwrap()),
                sha256: bytes[50..82].try_into().unwrap(),
            },
            wal: FileDigest {
                length: u64::from_le_bytes(bytes[42..50].try_into().unwrap()),
                sha256: bytes[82..114].try_into().unwrap(),
            },
        };
        if receipt.generation == 0 {
            return Err(PublicationError::Invalid("receipt con generación cero"));
        }
        Ok(receipt)
    }
}

/// Publicador legado de una única instancia ProjectStore.
/// Para publicar conjuntamente el estado vivo y el conocimiento narrativo,
/// la integración del motor debe utilizar `BundlePublicationStore`.
pub struct PublicationStore {
    root: PathBuf,
    active_slot: Option<usize>,
    current: Option<PublicationPointer>,
    _lock: InterprocessLock,
    recovery_required: bool,
}

impl PublicationStore {
    fn validate_root_lock(&self) -> Result<(), PublicationError> {
        self._lock.validate_identity()
            .map_err(|error| PublicationError::Io(error.to_string()))
    }

    /// Abre el selector bajo bloqueo exclusivo. Un slot existente corrupto hace
    /// fallar cerrado: no se retrocede a una generación anterior silenciosamente.
    pub fn open(root: impl AsRef<Path>) -> Result<Self, PublicationError> {
        let requested_root = root.as_ref().to_path_buf();
        fs::create_dir_all(&requested_root).map_err(io_error)?;
        let metadata = fs::symlink_metadata(&requested_root).map_err(io_error)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(PublicationError::Invalid("la raíz de publicación no es un directorio regular"));
        }
        let root = fs::canonicalize(&requested_root).map_err(io_error)?;
        let lock_path = root.join("CURRENT");
        let lock = InterprocessLock::acquire_for(&lock_path)
            .map_err(|error| PublicationError::Io(error.to_string()))?;
        lock.validate_identity().map_err(|error| PublicationError::Io(error.to_string()))?;
        let slot0 = read_pointer_slot(&root.join("CURRENT.0"))?;
        let slot1 = read_pointer_slot(&root.join("CURRENT.1"))?;
        let (active_slot, current) = select_pointer_slots(slot0, slot1)?;
        lock.validate_identity().map_err(|error| PublicationError::Io(error.to_string()))?;
        Ok(Self { root, active_slot, current, _lock: lock, recovery_required: false })
    }

    pub fn current(&self) -> Option<&PublicationPointer> {
        self.current.as_ref()
    }

    /// Abre la generación actual mediante una fachada de solo lectura.
    /// SHA-256 se calcula sobre los mismos descriptores que conserva DurablePages.
    /// La receipt se compara antes de cualquier validación/truncado del WAL.
    pub fn open_current_project_store(
        &self,
    )->Result<Option<PublishedProjectStore>,PublishedStoreOpenError>{
        self.validate_root_lock().map_err(PublishedStoreOpenError::Publication)?;
        if self.recovery_required {
            return Err(PublishedStoreOpenError::Publication(PublicationError::Invalid("selector ambiguo; cerrar y reabrir PublicationStore")));
        }
        let Some(pointer)=self.current.as_ref() else {return Ok(None);};
        let store=self.open_project_store_for_pointer(pointer).map(Some)?;
        self.validate_root_lock().map_err(PublishedStoreOpenError::Publication)?;
        Ok(store)
    }

    /// Abre una generación concreta usando sus descriptores verificados.
    /// Solo lectura lógica: no llamar put/delete/checkpoint. Debe llamarse mientras
    /// el selector/root lock siga retenido; escrituras requieren otra generación.
    pub(crate) fn open_project_store_for_pointer(
        &self,
        pointer:&PublicationPointer,
    )->Result<PublishedProjectStore,PublishedStoreOpenError>{
        self.validate_root_lock().map_err(PublishedStoreOpenError::Publication)?;
        if self.recovery_required {
            return Err(PublishedStoreOpenError::Publication(PublicationError::Invalid("selector ambiguo; cerrar y reabrir PublicationStore")));
        }
        let (pages_path,wal_path)=self.resolve_paths(pointer)
            .map_err(PublishedStoreOpenError::Publication)?;
        let directory=pages_path.parent()
            .ok_or(PublishedStoreOpenError::Publication(PublicationError::Invalid("generación sin directorio")))?;
        let receipt=read_generation_receipt(directory)
            .map_err(PublishedStoreOpenError::Publication)?;
        if receipt.generation!=pointer.generation || receipt.migration_id!=pointer.migration_id {
            return Err(PublishedStoreOpenError::Publication(PublicationError::Invalid("receipt no corresponde al selector")));
        }
        // El publicador hace checkpoint antes de copiar la generación. Una
        // generación publicada debe tener solo la cabecera MLPJ: abrirla no
        // puede requerir redo/truncado que altere una generación inmutable.
        if receipt.wal.length!=crate::page_journal::MLPJ_HEADER_BYTES {
            return Err(PublishedStoreOpenError::Publication(PublicationError::Invalid("la generación publicada no tiene WAL checkpointed")));
        }
        let page_size=crate::page::PAGE_SIZE as u64;
        if receipt.pages.length<page_size*2 || receipt.pages.length%page_size!=0 {
            return Err(PublishedStoreOpenError::Publication(PublicationError::Invalid("archivo MLPG publicado incompleto o sin metadata y raíz")));
        }
        let inner=crate::project_store::ProjectStore::open_read_only_with_pre_recovery_verification(
            &pages_path,&wal_path,
            move |pages,wal|receipt.verify_open_files(pages,wal),
        ).map_err(PublishedStoreOpenError::Store)?;
        self.validate_root_lock().map_err(PublishedStoreOpenError::Publication)?;
        Ok(PublishedProjectStore{inner})
    }

    /// Crea una copia mutable independiente de la generación activa.
    /// El ID lo aporta el anfitrión y nunca se interpreta como ruta.
    pub fn create_working_copy(&self,working_id:[u8;16])->Result<WorkingProjectStore,WorkingStoreError>{
        self.validate_root_lock().map_err(WorkingStoreError::Publication)?;
        if self.recovery_required {
            return Err(WorkingStoreError::Publication(PublicationError::Invalid("selector ambiguo; cerrar y reabrir PublicationStore")));
        }
        let base=self.current.clone().ok_or(WorkingStoreError::Publication(PublicationError::Invalid("no existe una generación publicada para clonar")))?;
        let working_root=self.root.join("working");
        match fs::symlink_metadata(&working_root) {
            Ok(_)=>ensure_regular_directory(&working_root).map_err(WorkingStoreError::Publication)?,
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>{
                create_private_directory(&working_root).map_err(|e|WorkingStoreError::Publication(io_error(e)))?;
                sync_directory(&self.root).map_err(WorkingStoreError::Publication)?;
            }
            Err(error)=>return Err(WorkingStoreError::Publication(io_error(error))),
        }
        let name=working_directory_name(&working_id);
        let final_dir=working_root.join(&name);
        let temporary_dir=working_root.join(format!(".{name}.tmp"));
        if path_exists_no_follow(&final_dir).map_err(|e|WorkingStoreError::Publication(io_error(e)))?
            || path_exists_no_follow(&temporary_dir).map_err(|e|WorkingStoreError::Publication(io_error(e)))? {
            return Err(WorkingStoreError::Publication(PublicationError::Invalid("el ID de working copy ya existe o dejó un temporal; no se reutiliza")));
        }
        create_private_directory(&temporary_dir).map_err(|e|WorkingStoreError::Publication(io_error(e)))?;
        let result=(||{
            let mut source=self.open_project_store_for_pointer(&base).map_err(|error|match error{
                PublishedStoreOpenError::Publication(error)=>WorkingStoreError::Publication(error),
                PublishedStoreOpenError::Store(error)=>WorkingStoreError::Store(error),
            })?;
            let source_validation=source.validate().map_err(WorkingStoreError::Store)?;
            let pages=temporary_dir.join("store.pages");
            let wal=temporary_dir.join("store.mlpj");
            let mut target=crate::project_store::ProjectStore::open(&pages,&wal).map_err(WorkingStoreError::Store)?;
            let mut copied=0u64;
            {
                let mut records=source.scan_all_iter().map_err(WorkingStoreError::Store)?;
                while let Some(record)=records.next(){
                    let (project,table,id,value)=record.map_err(WorkingStoreError::Store)?;
                    target.put_project(&project,&table,&id,&value).map_err(WorkingStoreError::Store)?;
                    copied=copied.checked_add(1).ok_or(WorkingStoreError::Publication(PublicationError::Invalid("contador de working copy agotado")))?;
                }
            }
            if copied!=source_validation.entries as u64 {
                return Err(WorkingStoreError::Publication(PublicationError::Invalid("el recuento de la copia difiere del origen")));
            }
            target.checkpoint().map_err(WorkingStoreError::Store)?;
            let target_validation=target.validate().map_err(WorkingStoreError::Store)?;
            if target_validation.entries!=source_validation.entries {
                return Err(WorkingStoreError::Publication(PublicationError::Invalid("la validación de la working copy no coincide con el origen")));
            }
            write_working_manifest(&temporary_dir,&WorkingCopyManifest{
                working_id,base_generation:base.generation,base_migration_id:base.migration_id,
            }).map_err(WorkingStoreError::Publication)?;
            drop(target);
            drop(source);
            sync_directory(&temporary_dir).map_err(WorkingStoreError::Publication)?;
            self.validate_root_lock().map_err(WorkingStoreError::Publication)?;
            fs::rename(&temporary_dir,&final_dir).map_err(|e|WorkingStoreError::Publication(io_error(e)))?;
            sync_directory(&working_root).map_err(WorkingStoreError::Publication)?;
            self.validate_root_lock().map_err(WorkingStoreError::Publication)?;
            let inner=crate::project_store::ProjectStore::open_existing(final_dir.join("store.pages"),final_dir.join("store.mlpj"))
                .map_err(WorkingStoreError::Store)?;
            Ok(WorkingProjectStore{inner,working_id,base})
        })();
        if result.is_err() {
            // La copia incompleta nunca es visible con el nombre definitivo.
            // Si el rename ya ocurrió, no se elimina: queda recuperable para inspección.
            let _=fs::remove_dir_all(&temporary_dir);
        }
        result
    }

    /// Publica una working copy solo si su generación base sigue siendo la activa.
    /// Consume la sesión para impedir que se siga escribiendo sobre una copia ya publicada.
    pub fn publish_working_copy(
        &mut self,
        mut working:WorkingProjectStore,
        publication_id:[u8;16],
    )->Result<PublicationPointer,WorkingStoreError>{
        self.validate_root_lock().map_err(WorkingStoreError::Publication)?;
        if self.recovery_required {
            return Err(WorkingStoreError::Publication(PublicationError::Invalid("selector ambiguo; cerrar y reabrir PublicationStore")));
        }
        let current=self.current.clone().ok_or(WorkingStoreError::Publication(PublicationError::Invalid("no existe generación activa")))?;
        if current!=working.base {
            return Err(WorkingStoreError::Publication(PublicationError::Invalid("working copy obsoleta: la generación base ya no está activa")));
        }
        let working_root=self.root.join("working");
        ensure_regular_directory(&working_root).map_err(WorkingStoreError::Publication)?;
        let directory=working_root.join(working_directory_name(&working.working_id));
        ensure_regular_directory(&directory).map_err(WorkingStoreError::Publication)?;
        let manifest=read_working_manifest(&directory).map_err(WorkingStoreError::Publication)?;
        if manifest.working_id!=working.working_id
            || manifest.base_generation!=working.base.generation
            || manifest.base_migration_id!=working.base.migration_id {
            return Err(WorkingStoreError::Publication(PublicationError::Invalid("manifiesto working no coincide con la sesión abierta")));
        }
        let expected_pages=directory.join("store.pages");
        let expected_wal=directory.join("store.mlpj");
        let (pages_path,wal_path)=working.paths();
        let pages_path=pages_path.to_path_buf();
        let wal_path=wal_path.to_path_buf();
        if pages_path!=expected_pages || wal_path!=expected_wal {
            return Err(WorkingStoreError::Publication(PublicationError::Invalid("rutas de working copy no corresponden a su ID")));
        }
        working.checkpoint().map_err(WorkingStoreError::Store)?;
        let source_validation=working.validate().map_err(WorkingStoreError::Store)?;
        let next_generation=current.generation.checked_add(1)
            .ok_or(WorkingStoreError::Publication(PublicationError::Invalid("contador de generaciones agotado")))?;
        let pointer=PublicationPointer::new(next_generation,publication_id)
            .map_err(WorkingStoreError::Publication)?;
        let generations=self.root.join("generations");
        ensure_regular_directory(&generations).map_err(WorkingStoreError::Publication)?;
        let generation_dir=generations.join(&pointer.generation_dir);
        self.validate_root_lock().map_err(WorkingStoreError::Publication)?;
        create_private_directory(&generation_dir).map_err(|error|WorkingStoreError::Publication(io_error(error)))?;
        (||{
            let temp_pages=generation_dir.join("store.pages.tmp");
            let temp_wal=generation_dir.join("store.mlpj.tmp");
            let final_pages=generation_dir.join("store.pages");
            let final_wal=generation_dir.join("store.mlpj");
            let pages_digest=copy_regular_file_synced(&pages_path,&temp_pages).map_err(WorkingStoreError::Publication)?;
            let wal_digest=copy_regular_file_synced(&wal_path,&temp_wal).map_err(WorkingStoreError::Publication)?;
            self.validate_root_lock().map_err(WorkingStoreError::Publication)?;
            fs::rename(&temp_pages,&final_pages).map_err(|error|WorkingStoreError::Publication(io_error(error)))?;
            fs::rename(&temp_wal,&final_wal).map_err(|error|WorkingStoreError::Publication(io_error(error)))?;
            GenerationReceipt::write(&generation_dir,&pointer,pages_digest,wal_digest).map_err(WorkingStoreError::Publication)?;
            self.validate_root_lock().map_err(WorkingStoreError::Publication)?;
            sync_directory(&generation_dir).map_err(WorkingStoreError::Publication)?;
            sync_directory(&generations).map_err(WorkingStoreError::Publication)?;
            self.validate_root_lock().map_err(WorkingStoreError::Publication)?;

            let mut published=self.open_project_store_for_pointer(&pointer).map_err(|error|match error{
                PublishedStoreOpenError::Publication(error)=>WorkingStoreError::Publication(error),
                PublishedStoreOpenError::Store(error)=>WorkingStoreError::Store(error),
            })?;
            let destination_validation=published.validate().map_err(WorkingStoreError::Store)?;
            if destination_validation.entries!=source_validation.entries {
                return Err(WorkingStoreError::Publication(PublicationError::Invalid("recuento de la generación nueva difiere de la working copy")));
            }
            compare_project_store_contents(&mut working,&mut published).map_err(WorkingStoreError::Store)?;
            drop(published);
            self.validate_root_lock().map_err(WorkingStoreError::Publication)?;
            self.publish(pointer.clone()).map_err(WorkingStoreError::Publication)?;
            Ok(pointer.clone())
        })()
    }

    /// Reanuda la working copy si existe; de lo contrario crea una desde la generación activa.
    /// Un temporal abandonado nunca se confunde con una copia completa.
    pub fn open_or_create_working_copy(&self,working_id:[u8;16])->Result<WorkingProjectStore,WorkingStoreError>{
        self.validate_root_lock().map_err(WorkingStoreError::Publication)?;
        let path=self.root.join("working").join(working_directory_name(&working_id));
        if path_exists_no_follow(&path).map_err(|error|WorkingStoreError::Publication(io_error(error)))? {
            self.open_working_copy(working_id)
        } else {
            self.create_working_copy(working_id)
        }
    }

    /// Reabre una working copy persistente por el ID opaco que aportó el anfitrión.
    pub fn open_working_copy(&self,working_id:[u8;16])->Result<WorkingProjectStore,WorkingStoreError>{
        self.validate_root_lock().map_err(WorkingStoreError::Publication)?;
        let working_root=self.root.join("working");
        ensure_regular_directory(&working_root).map_err(WorkingStoreError::Publication)?;
        let directory=working_root.join(working_directory_name(&working_id));
        ensure_regular_directory(&directory).map_err(WorkingStoreError::Publication)?;
        let manifest=read_working_manifest(&directory).map_err(WorkingStoreError::Publication)?;
        if manifest.working_id!=working_id {
            return Err(WorkingStoreError::Publication(PublicationError::Invalid("el manifiesto no corresponde al ID de working copy")));
        }
        let pages=directory.join("store.pages");
        let wal=directory.join("store.mlpj");
        ensure_regular_file(&pages).map_err(WorkingStoreError::Publication)?;
        ensure_regular_file(&wal).map_err(WorkingStoreError::Publication)?;
        let page_len=fs::metadata(&pages).map_err(|e|WorkingStoreError::Publication(io_error(e)))?.len();
        let wal_len=fs::metadata(&wal).map_err(|e|WorkingStoreError::Publication(io_error(e)))?.len();
        let page_size=crate::page::PAGE_SIZE as u64;
        if page_len<page_size*2 || page_len%page_size!=0 || wal_len<crate::page_journal::MLPJ_HEADER_BYTES {
            return Err(WorkingStoreError::Publication(PublicationError::Invalid("archivos de working copy incompletos")));
        }
        let inner=crate::project_store::ProjectStore::open_existing(&pages,&wal).map_err(WorkingStoreError::Store)?;
        self.validate_root_lock().map_err(WorkingStoreError::Publication)?;
        Ok(WorkingProjectStore{
            inner,working_id,
            base:PublicationPointer::new(manifest.base_generation,manifest.base_migration_id)
                .map_err(WorkingStoreError::Publication)?,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Devuelve rutas después de verificar sus hashes. No debe usarse para abrir
    /// el almacén: la apertura segura debe conservar los descriptores verificados.
    pub fn resolve_current_paths(&self) -> Result<Option<(PathBuf, PathBuf)>, PublicationError> {
        self.validate_root_lock()?;
        if self.recovery_required {
            return Err(PublicationError::Invalid("selector ambiguo; cerrar y reabrir PublicationStore"));
        }
        let Some(pointer) = self.current.as_ref() else { return Ok(None); };
        self.verify_generation(pointer)?;
        self.resolve_paths(pointer).map(Some)
    }

    /// Resuelve rutas y comprueba receipt, identidad y tamaños. No elimina la
    /// ventana TOCTOU; usar solo para diagnóstico/copia, nunca para abrir el Store.
    pub fn resolve_paths(&self, pointer: &PublicationPointer) -> Result<(PathBuf, PathBuf), PublicationError> {
        self.validate_root_lock()?;
        if self.recovery_required {
            return Err(PublicationError::Invalid("selector ambiguo; cerrar y reabrir PublicationStore"));
        }
        pointer.validate()?;
        let generations = self.root.join("generations");
        ensure_regular_directory(&generations)?;
        let directory = generations.join(&pointer.generation_dir);
        ensure_regular_directory(&directory)?;
        let pages = directory.join("store.pages");
        let wal = directory.join("store.mlpj");
        ensure_regular_file(&pages)?;
        ensure_regular_file(&wal)?;
        let receipt = read_generation_receipt(&directory)?;
        if receipt.generation != pointer.generation || receipt.migration_id != pointer.migration_id {
            return Err(PublicationError::Invalid("receipt no pertenece a la generación seleccionada"));
        }
        if fs::metadata(&pages).map_err(io_error)?.len() != receipt.pages.length
            || fs::metadata(&wal).map_err(io_error)?.len() != receipt.wal.length
        {
            return Err(PublicationError::Invalid("tamaño de archivo no coincide con receipt"));
        }
        Ok((pages, wal))
    }


    /// Recalcula SHA-256 de ambos archivos y los compara con el receipt durable.
    pub fn verify_generation(&self, pointer: &PublicationPointer) -> Result<(), PublicationError> {
        self.validate_root_lock()?;
        let (pages, wal) = self.resolve_paths(pointer)?;
        let receipt = read_generation_receipt(
            pages.parent().ok_or(PublicationError::Invalid("generación sin directorio"))?
        )?;
        if receipt.wal.length!=crate::page_journal::MLPJ_HEADER_BYTES {
            return Err(PublicationError::Invalid("no se puede publicar una generación con WAL sin checkpoint"));
        }
        let page_size=crate::page::PAGE_SIZE as u64;
        if receipt.pages.length<page_size*2 || receipt.pages.length%page_size!=0 {
            return Err(PublicationError::Invalid("archivo MLPG publicado incompleto o sin metadata y raíz"));
        }
        if hash_regular_file(&pages)? != receipt.pages || hash_regular_file(&wal)? != receipt.wal {
            return Err(PublicationError::ChecksumMismatch);
        }
        self.validate_root_lock()?;
        Ok(())
    }

    /// Publica un selector hacia una generación ya completa. La creación y
    /// sincronización de los archivos de generación corresponde al publicador.
    /// Escribe siempre el slot inactivo; el slot activo no se trunca ni reemplaza.
    pub fn publish(&mut self, pointer: PublicationPointer) -> Result<(), PublicationError> {
        self.validate_root_lock()?;
        if self.recovery_required {
            return Err(PublicationError::Invalid("selector ambiguo; cerrar y reabrir PublicationStore"));
        }
        pointer.validate()?;
        self.verify_generation(&pointer)?;
        let expected_generation = self.current.as_ref()
            .map(|current| current.generation.checked_add(1)
                .ok_or(PublicationError::Invalid("generación agotada")))
            .transpose()?
            .unwrap_or(1);
        if pointer.generation != expected_generation {
            return Err(PublicationError::Invalid("la generación publicada debe avanzar exactamente una unidad"));
        }

        self.validate_root_lock()?;
        let target_slot = self.active_slot.map(|slot| 1 - slot).unwrap_or(0);
        let target_path = self.root.join(if target_slot == 0 { "CURRENT.0" } else { "CURRENT.1" });
        match fs::symlink_metadata(&target_path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(PublicationError::Invalid("slot inactivo no es archivo regular"));
                }
                self.validate_root_lock()?;
                fs::remove_file(&target_path).map_err(io_error)?;
                if let Err(error) = self.validate_root_lock() {
                    self.recovery_required = true;
                    return Err(error);
                }
                if let Err(error) = sync_directory(&self.root) {
                    self.recovery_required = true;
                    return Err(error);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }

        let temporary = self.root.join(format!(
            ".CURRENT.{target_slot}.{}.tmp",
            pointer.generation
        ));
        self.validate_root_lock()?;
        match fs::symlink_metadata(&temporary) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(PublicationError::Invalid("temporal de selector no es archivo regular"));
                }
                self.validate_root_lock()?;
                fs::remove_file(&temporary).map_err(io_error)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
        let encoded = pointer.encode()?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(io_error)?;
        file.write_all(&encoded).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);
        // Publicación sin reemplazo: si aparece un destino inesperado entre
        // la validación y este punto, hard_link falla en vez de sobrescribirlo.
        if let Err(error)=self.validate_root_lock() {
            let _=fs::remove_file(&temporary);
            return Err(error);
        }
        if let Err(error) = fs::hard_link(&temporary, &target_path) {
            self.recovery_required = true;
            return Err(io_error(error));
        }
        if let Err(error) = self.validate_root_lock() {
            self.recovery_required = true;
            return Err(error);
        }
        if let Err(error) = fs::remove_file(&temporary) {
            self.recovery_required = true;
            return Err(io_error(error));
        }
        if let Err(error) = self.validate_root_lock() {
            self.recovery_required = true;
            return Err(error);
        }
        if let Err(error) = sync_directory(&self.root) {
            self.recovery_required = true;
            return Err(error);
        }
        self.active_slot = Some(target_slot);
        self.current = Some(pointer);
        Ok(())
    }
}


#[derive(Clone,Debug,Eq,PartialEq)]
struct WorkingCopyManifest{
    working_id:[u8;16],
    base_generation:u64,
    base_migration_id:[u8;16],
}
impl WorkingCopyManifest{
    fn encode(&self)->Vec<u8>{
        let mut bytes=Vec::with_capacity(WORKING_MANIFEST_BYTES);
        bytes.extend_from_slice(WORKING_MAGIC);
        bytes.extend_from_slice(&WORKING_VERSION.to_le_bytes());
        bytes.extend_from_slice(&self.working_id);
        bytes.extend_from_slice(&self.base_generation.to_le_bytes());
        bytes.extend_from_slice(&self.base_migration_id);
        let mut hash=Sha256::new();
        hash.update(&bytes);
        bytes.extend_from_slice(&hash.finish());
        bytes
    }
    fn decode(bytes:&[u8])->Result<Self,PublicationError>{
        if bytes.len()!=WORKING_MANIFEST_BYTES{return Err(PublicationError::Invalid("tamaño del manifiesto working incorrecto"));}
        if &bytes[..8]!=WORKING_MAGIC{return Err(PublicationError::Invalid("magic del manifiesto working incorrecto"));}
        let version=u16::from_le_bytes(bytes[8..10].try_into().unwrap());
        if version!=WORKING_VERSION{return Err(PublicationError::UnsupportedVersion(version));}
        let checksum_at=WORKING_MANIFEST_BYTES-CHECKSUM_BYTES;
        let mut hash=Sha256::new();
        hash.update(&bytes[..checksum_at]);
        let expected=hash.finish();
        if expected[..]!=bytes[checksum_at..]{return Err(PublicationError::ChecksumMismatch);}
        let manifest=Self{
            working_id:bytes[10..26].try_into().unwrap(),
            base_generation:u64::from_le_bytes(bytes[26..34].try_into().unwrap()),
            base_migration_id:bytes[34..50].try_into().unwrap(),
        };
        if manifest.base_generation==0{return Err(PublicationError::Invalid("working copy sin generación base"));}
        Ok(manifest)
    }
}

fn working_directory_name(working_id:&[u8;16])->String{
    let mut name=String::from("work-");
    for byte in working_id{name.push_str(&format!("{byte:02x}"));}
    name
}

fn path_exists_no_follow(path:&Path)->std::io::Result<bool>{
    match fs::symlink_metadata(path){
        Ok(_)=>Ok(true),
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>Ok(false),
        Err(error)=>Err(error),
    }
}

fn create_private_directory(path:&Path)->std::io::Result<()>{
    let mut builder=fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn write_working_manifest(directory:&Path,manifest:&WorkingCopyManifest)->Result<(),PublicationError>{
    let path=directory.join("WORKING.MANIFEST");
    let bytes=manifest.encode();
    let mut options=OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file=options.open(&path).map_err(io_error)?;
    file.write_all(&bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    sync_directory(directory)?;
    Ok(())
}

fn read_working_manifest(directory:&Path)->Result<WorkingCopyManifest,PublicationError>{
    let path=directory.join("WORKING.MANIFEST");
    let metadata=fs::symlink_metadata(&path).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len()!=WORKING_MANIFEST_BYTES as u64{
        return Err(PublicationError::Invalid("manifiesto working ausente, no regular o de tamaño incorrecto"));
    }
    let mut options=OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os="linux",target_os="android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x20_000);
    }
    let file=options.open(&path).map_err(io_error)?;
    let opened=file.metadata().map_err(io_error)?;
    let current=fs::symlink_metadata(&path).map_err(io_error)?;
    if !opened.is_file() || current.file_type().is_symlink() || !current.is_file()
        || !same_file_identity(&metadata,&opened) || !same_file_identity(&opened,&current)
        || opened.len()!=WORKING_MANIFEST_BYTES as u64
    {
        return Err(PublicationError::Invalid("manifiesto working cambió durante la apertura"));
    }
    let mut limited=Read::take(file,WORKING_MANIFEST_BYTES as u64+1);
    let mut bytes=Vec::with_capacity(WORKING_MANIFEST_BYTES);
    limited.read_to_end(&mut bytes).map_err(io_error)?;
    WorkingCopyManifest::decode(&bytes)
}

fn read_generation_receipt(directory: &Path) -> Result<GenerationReceipt, PublicationError> {
    let path = directory.join("GENERATION.MANIFEST");
    let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PublicationError::Invalid("receipt ausente o no es archivo regular"));
    }
    if metadata.len() != RECEIPT_BYTES as u64 {
        return Err(PublicationError::Invalid("tamaño del receipt incorrecto"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.nlink() != 1 || metadata.permissions().mode() & 0o077 != 0 {
            return Err(PublicationError::Invalid("receipt compartido o no privado"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.number_of_links() != Some(1) {
            return Err(PublicationError::Invalid("receipt tiene hardlinks"));
        }
    }
    // Abrir sin seguir symlinks en Linux/Android y comprobar la identidad
    // del descriptor en las plataformas que exponen identidad de archivo.
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os="linux",target_os="android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x20_000);
    }
    let mut file = options.open(&path).map_err(io_error)?;
    let opened = file.metadata().map_err(io_error)?;
    let current = fs::symlink_metadata(&path).map_err(io_error)?;
    if !opened.is_file() || current.file_type().is_symlink() || !current.is_file()
        || !same_file_identity(&metadata, &opened)
        || !same_file_identity(&opened, &current)
        || opened.len() != RECEIPT_BYTES as u64
    {
        return Err(PublicationError::Invalid("el receipt cambió durante la apertura"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if opened.nlink() != 1 || opened.permissions().mode() & 0o077 != 0 {
            return Err(PublicationError::Invalid("descriptor de receipt compartido o no privado"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.number_of_links() != Some(1) || current.number_of_links() != Some(1) {
            return Err(PublicationError::Invalid("descriptor de receipt tiene hardlinks"));
        }
    }
    let mut limited = (&mut file).take(RECEIPT_BYTES as u64 + 1);
    let mut bytes = Vec::with_capacity(RECEIPT_BYTES);
    limited.read_to_end(&mut bytes).map_err(io_error)?;
    drop(limited);
    if bytes.len() != RECEIPT_BYTES {
        return Err(PublicationError::Invalid("tamaño del receipt incorrecto"));
    }
    let after = file.metadata().map_err(io_error)?;
    let path_after = fs::symlink_metadata(&path).map_err(io_error)?;
    if !same_file_identity(&opened, &after)
        || !same_file_identity(&after, &path_after)
        || after.len() != RECEIPT_BYTES as u64
        || after.modified().ok() != opened.modified().ok()
    {
        return Err(PublicationError::Invalid("receipt cambió durante la lectura"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if after.nlink() != 1 || path_after.nlink() != 1
            || after.permissions().mode() & 0o077 != 0
        {
            return Err(PublicationError::Invalid("receipt adquirió hardlinks o perdió privacidad"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if after.number_of_links() != Some(1) || path_after.number_of_links() != Some(1) {
            return Err(PublicationError::Invalid("receipt adquirió hardlinks durante lectura"));
        }
    }
    GenerationReceipt::decode(&bytes)
}


fn compare_project_store_contents(
    working:&mut WorkingProjectStore,
    published:&mut PublishedProjectStore,
)->Result<(),crate::btree::BTreeError>{
    let mut source=working.scan_all_iter()?;
    let mut target=published.scan_all_iter()?;
    loop{
        match (source.next(),target.next()){
            (None,None)=>return Ok(()),
            (Some(Ok(left)),Some(Ok(right))) if left==right=>{},
            (Some(Err(error)),_)=>return Err(error),
            (_,Some(Err(error)))=>return Err(error),
            (None,Some(Ok(_)))=>return Err(crate::btree::BTreeError::Corrupt("la generación publicada contiene registros adicionales")),
            (Some(Ok(_)),None)=>return Err(crate::btree::BTreeError::Corrupt("la generación publicada perdió registros")),
            (Some(Ok(_)),Some(Ok(_)))=>return Err(crate::btree::BTreeError::Corrupt("los registros de la generación publicada difieren de la working copy")),
        }
    }
}

fn copy_regular_file_synced(source: &Path, destination: &Path) -> Result<FileDigest, PublicationError> {
    let before = fs::symlink_metadata(source).map_err(io_error)?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(PublicationError::Invalid("origen de working copy no es archivo regular"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if before.nlink() != 1 || before.permissions().mode() & 0o077 != 0 {
            return Err(PublicationError::Invalid("origen de working copy compartido o no privado"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if before.number_of_links() != Some(1) {
            return Err(PublicationError::Invalid("origen de working copy tiene hardlinks"));
        }
    }

    let mut input_options = OpenOptions::new();
    input_options.read(true);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        input_options.custom_flags(0x20_000);
    }
    let mut input = input_options.open(source).map_err(io_error)?;
    let opened = input.metadata().map_err(io_error)?;
    let current = fs::symlink_metadata(source).map_err(io_error)?;
    if !opened.is_file() || current.file_type().is_symlink() || !current.is_file()
        || !same_file_identity(&before, &opened)
        || !same_file_identity(&opened, &current)
        || opened.len() != before.len()
        || opened.modified().ok() != before.modified().ok()
    {
        return Err(PublicationError::Invalid("origen de working copy cambió durante apertura"));
    }

    let mut output_options = OpenOptions::new();
    output_options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        output_options.mode(0o600);
    }
    let mut output = output_options.open(destination).map_err(io_error)?;
    let mut hash = Sha256::new();
    let mut length = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = input.read(&mut buffer).map_err(io_error)?;
        if count == 0 { break; }
        output.write_all(&buffer[..count]).map_err(io_error)?;
        hash.update(&buffer[..count]);
        length = length.checked_add(count as u64)
            .ok_or(PublicationError::Invalid("tamaño de working copy desbordado"))?;
    }
    output.sync_all().map_err(io_error)?;

    let after = input.metadata().map_err(io_error)?;
    let path_after = fs::symlink_metadata(source).map_err(io_error)?;
    if !after.is_file() || path_after.file_type().is_symlink() || !path_after.is_file()
        || !same_file_identity(&opened, &after)
        || !same_file_identity(&after, &path_after)
        || length != opened.len()
        || after.len() != opened.len()
        || after.modified().ok() != opened.modified().ok()
    {
        return Err(PublicationError::Invalid("origen de working copy cambió durante copia"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if after.nlink() != 1 || path_after.nlink() != 1 {
            return Err(PublicationError::Invalid("origen de working copy adquirió hardlinks"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if after.number_of_links() != Some(1) || path_after.number_of_links() != Some(1) {
            return Err(PublicationError::Invalid("origen de working copy adquirió hardlinks"));
        }
    }

    let destination_opened = output.metadata().map_err(io_error)?;
    let destination_path = fs::symlink_metadata(destination).map_err(io_error)?;
    if !destination_opened.is_file() || destination_path.file_type().is_symlink()
        || !destination_path.is_file()
        || !same_file_identity(&destination_opened, &destination_path)
        || destination_opened.len() != length
        || destination_path.len() != length
    {
        return Err(PublicationError::Invalid("destino de working copy cambió durante copia"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if destination_opened.nlink() != 1 || destination_path.nlink() != 1
            || destination_opened.permissions().mode() & 0o077 != 0
        {
            return Err(PublicationError::Invalid("destino de working copy compartido o no privado"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if destination_opened.number_of_links() != Some(1)
            || destination_path.number_of_links() != Some(1)
        {
            return Err(PublicationError::Invalid("destino de working copy tiene hardlinks"));
        }
    }
    Ok(FileDigest { length, sha256: hash.finish() })
}

fn hash_open_file(file:&mut File)->std::io::Result<FileDigest>{
    let initial=file.metadata()?;
    if !initial.is_file(){return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput,"descriptor no es archivo regular"));}
    let initial_length=initial.len();
    let initial_modified=initial.modified().ok();
    file.seek(std::io::SeekFrom::Start(0))?;
    let mut hash=Sha256::new();
    let mut length=0u64;
    let mut buffer=[0u8;64*1024];
    loop{
        let count=file.read(&mut buffer)?;
        if count==0{break;}
        hash.update(&buffer[..count]);
        length=length.checked_add(count as u64).ok_or_else(||std::io::Error::new(std::io::ErrorKind::InvalidData,"tamaño desbordado"))?;
    }
    let final_metadata=file.metadata()?;
    if !final_metadata.is_file() || length!=initial_length || final_metadata.len()!=initial_length
        || final_metadata.modified().ok()!=initial_modified{
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"archivo cambió durante verificación"));
    }
    Ok(FileDigest{length,sha256:hash.finish()})
}

fn hash_regular_file(path: &Path) -> Result<FileDigest, PublicationError> {
    let path_metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err(PublicationError::Invalid("archivo de generación no es regular"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if path_metadata.nlink() != 1 || path_metadata.permissions().mode() & 0o077 != 0 {
            return Err(PublicationError::Invalid("archivo de generación compartido o no privado"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if path_metadata.number_of_links() != Some(1) {
            return Err(PublicationError::Invalid("archivo de generación tiene hardlinks"));
        }
    }

    // Abrir sin seguir symlinks en Linux/Android y verificar identidad,
    // tipo y exclusividad tanto antes como después del hash.
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x20_000);
    }
    let mut file = options.open(path).map_err(io_error)?;
    let opened_metadata = file.metadata().map_err(io_error)?;
    let current_path = fs::symlink_metadata(path).map_err(io_error)?;
    if !opened_metadata.is_file() || current_path.file_type().is_symlink()
        || !current_path.is_file()
        || !same_file_identity(&path_metadata, &opened_metadata)
        || !same_file_identity(&opened_metadata, &current_path)
        || opened_metadata.len() != path_metadata.len()
    {
        return Err(PublicationError::Invalid("el archivo cambió al abrirse para verificar"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if opened_metadata.nlink() != 1 || current_path.nlink() != 1
            || opened_metadata.permissions().mode() & 0o077 != 0
            || current_path.permissions().mode() & 0o077 != 0
        {
            return Err(PublicationError::Invalid("descriptor de generación compartido o no privado"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened_metadata.number_of_links() != Some(1)
            || current_path.number_of_links() != Some(1)
        {
            return Err(PublicationError::Invalid("descriptor de generación tiene hardlinks"));
        }
    }
    let initial_length = opened_metadata.len();
    let initial_modified = opened_metadata.modified().ok();

    let mut hash = Sha256::new();
    let mut length = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(io_error)?;
        if count == 0 { break; }
        hash.update(&buffer[..count]);
        length = length.checked_add(count as u64)
            .ok_or(PublicationError::Invalid("tamaño de archivo desbordado"))?;
    }

    let final_metadata = file.metadata().map_err(io_error)?;
    let final_path = fs::symlink_metadata(path).map_err(io_error)?;
    if !final_metadata.is_file()
        || final_path.file_type().is_symlink()
        || !final_path.is_file()
        || !same_file_identity(&opened_metadata, &final_metadata)
        || !same_file_identity(&final_metadata, &final_path)
        || length != initial_length
        || final_metadata.len() != initial_length
        || final_metadata.modified().ok() != initial_modified
    {
        return Err(PublicationError::Invalid("el archivo cambió durante la verificación"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if final_metadata.nlink() != 1 || final_path.nlink() != 1
            || final_metadata.permissions().mode() & 0o077 != 0
            || final_path.permissions().mode() & 0o077 != 0
        {
            return Err(PublicationError::Invalid("archivo de generación adquirió hardlinks o perdió privacidad"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if final_metadata.number_of_links() != Some(1)
            || final_path.number_of_links() != Some(1)
        {
            return Err(PublicationError::Invalid("archivo de generación adquirió hardlinks durante hash"));
        }
    }

    Ok(FileDigest { length, sha256: hash.finish() })
}

#[cfg(unix)]
fn same_file_identity(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(windows)]
fn same_file_identity(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    left.is_file() && right.is_file()
        && left.volume_serial_number().is_some()
        && left.file_index().is_some()
        && left.volume_serial_number() == right.volume_serial_number()
        && left.file_index() == right.file_index()
}

#[cfg(not(any(unix, windows)))]
fn same_file_identity(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    // En plataformas sin identidad portable de archivo en std, exigir al
    // menos que el descriptor conserve su tipo y tamaño observado.
    left.is_file() && right.is_file() && left.len() == right.len()
}

fn select_pointer_slots(
    slot0: Option<PublicationPointer>,
    slot1: Option<PublicationPointer>,
) -> Result<(Option<usize>, Option<PublicationPointer>), PublicationError> {
    match (slot0, slot1) {
        (None, None) => Ok((None, None)),
        (Some(pointer), None) => Ok((Some(0), Some(pointer))),
        (None, Some(pointer)) => Ok((Some(1), Some(pointer))),
        (Some(left), Some(right)) => {
            if left.generation == right.generation {
                if left != right {
                    return Err(PublicationError::Invalid("selectores distintos comparten generación"));
                }
                return Ok((Some(0), Some(left)));
            }
            let (newer, older, slot) = if left.generation > right.generation {
                (&left, &right, 0)
            } else {
                (&right, &left, 1)
            };
            if newer.generation != older.generation.checked_add(1)
                .ok_or(PublicationError::Invalid("generación anterior agotada"))?
            {
                return Err(PublicationError::Invalid("las generaciones de los dos selectores no son consecutivas"));
            }
            if slot == 0 {
                Ok((Some(0), Some(left)))
            } else {
                Ok((Some(1), Some(right)))
            }
        }
    }
}

fn read_pointer_slot(path: &Path) -> Result<Option<PublicationPointer>, PublicationError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PublicationError::Invalid("slot no es archivo regular"));
    }
    if metadata.len() > MAX_POINTER_BYTES as u64 {
        return Err(PublicationError::Invalid("slot excede el tamaño máximo"));
    }
    // No seguir symlinks y asegurar que se lee el mismo slot regular
    // observado antes de abrirlo.
    let mut options=OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os="linux",target_os="android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x20_000);
    }
    let file=options.open(path).map_err(io_error)?;
    let opened=file.metadata().map_err(io_error)?;
    let current=fs::symlink_metadata(path).map_err(io_error)?;
    if !opened.is_file() || current.file_type().is_symlink() || !current.is_file()
        || !same_file_identity(&metadata,&opened) || !same_file_identity(&opened,&current)
    {
        return Err(PublicationError::Invalid("el slot cambió durante la apertura"));
    }
    // El límite se aplica también durante la lectura: el archivo puede crecer.
    let mut limited = Read::take(file, MAX_POINTER_BYTES as u64 + 1);
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    limited.read_to_end(&mut bytes).map_err(io_error)?;
    if bytes.len() > MAX_POINTER_BYTES {
        return Err(PublicationError::Invalid("slot excede el tamaño máximo"));
    }
    PublicationPointer::decode(&bytes).map(Some)
}

fn ensure_regular_directory(path: &Path) -> Result<(), PublicationError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(PublicationError::Invalid("directorio de generación ausente o no regular"));
    }
    Ok(())
}

fn ensure_regular_file(path: &Path) -> Result<(), PublicationError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PublicationError::Invalid("archivo de generación ausente o no regular"));
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), PublicationError> {
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

fn io_error(error: std::io::Error) -> PublicationError {
    PublicationError::Io(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn root(label: &str) -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("mldb-publish-{label}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn make_generation(root: &Path, pointer: &PublicationPointer) {
        let dir = root.join("generations").join(&pointer.generation_dir);
        fs::create_dir_all(&dir).unwrap();
        let pages=dir.join("store.pages");
        let wal=dir.join("store.mlpj");
        {
            let mut project=crate::project_store::ProjectStore::open(&pages,&wal).unwrap();
            project.checkpoint().unwrap();
        }
        GenerationReceipt::create_from_files(&dir, pointer).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_working_copy_rejects_hardlinked_source() {
        let root = root("windows-copy-source-hardlink");
        let source = root.join("source.pages");
        let alias = root.join("source.alias");
        let destination = root.join("destination.pages");
        fs::write(&source, b"private-source").unwrap();
        fs::hard_link(&source, &alias).unwrap();
        assert!(copy_regular_file_synced(&source, &destination).is_err());
        fs::remove_file(&alias).unwrap();
        let digest = copy_regular_file_synced(&source, &destination).unwrap();
        assert_eq!(digest.length, b"private-source".len() as u64);
        assert_eq!(fs::read(destination).unwrap(), b"private-source");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_generation_hash_rejects_hardlinked_member() {
        let root = root("windows-generation-hash-hardlink");
        let pointer = PublicationPointer::new(1, [0xa3; 16]).unwrap();
        make_generation(&root, &pointer);
        let directory = root.join("generations").join(&pointer.generation_dir);
        let pages = directory.join("store.pages");
        let alias = directory.join("store.pages.alias");
        fs::hard_link(&pages, &alias).unwrap();
        assert!(hash_regular_file(&pages).is_err());
        fs::remove_file(alias).unwrap();
        assert!(hash_regular_file(&pages).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_replaced_publication_root_lock_rejects_reads_and_selector_changes() {
        let root = root("windows-root-lock-replaced");
        let pointer = PublicationPointer::new(1, [0xb1; 16]).unwrap();
        make_generation(&root, &pointer);
        let mut publication = PublicationStore::open(&root).unwrap();
        publication.publish(pointer.clone()).unwrap();
        let working = publication.create_working_copy([0xb2; 16]).unwrap();
        drop(working);

        let lock_path = crate::interprocess_lock::lock_path_for(&root.join("CURRENT")).unwrap();
        let displaced = lock_path.with_extension("displaced");
        fs::rename(&lock_path, &displaced).unwrap();
        OpenOptions::new().write(true).create_new(true)
            .open(&lock_path).unwrap().sync_all().unwrap();

        assert!(publication.verify_generation(&pointer).is_err());
        assert!(publication.open_current_project_store().is_err());
        assert!(publication.resolve_current_paths().is_err());
        assert!(publication.open_working_copy([0xb2; 16]).is_err());
        assert!(publication.create_working_copy([0xb4; 16]).is_err());
        let next = PublicationPointer::new(2, [0xb3; 16]).unwrap();
        make_generation(&root, &next);
        assert!(publication.publish(next).is_err());
        assert_eq!(publication.current(), Some(&pointer));

        drop(publication);
        fs::remove_file(lock_path).unwrap();
        fs::remove_file(displaced).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_generation_receipt_rejects_hardlinks() {
        use std::os::windows::fs::MetadataExt;
        let root = root("windows-receipt-hardlink");
        let pointer = PublicationPointer::new(1, [0xa1; 16]).unwrap();
        make_generation(&root, &pointer);
        let directory = root.join("generations").join(&pointer.generation_dir);
        let receipt = directory.join("GENERATION.MANIFEST");
        let alias = directory.join("GENERATION.MANIFEST.alias");
        fs::hard_link(&receipt, &alias).unwrap();
        assert_eq!(fs::metadata(&receipt).unwrap().number_of_links(), Some(2));
        assert!(read_generation_receipt(&directory).is_err());
        fs::remove_file(alias).unwrap();
        assert!(read_generation_receipt(&directory).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_verified_published_member_rejects_hardlinked_pages_descriptor() {
        use std::os::windows::fs::MetadataExt;
        let root = root("windows-verified-member-hardlink");
        let pointer = PublicationPointer::new(1, [0xa0; 16]).unwrap();
        make_generation(&root, &pointer);
        let directory = root.join("generations").join(&pointer.generation_dir);
        let receipt = GenerationReceipt::decode(
            &fs::read(directory.join("GENERATION.MANIFEST")).unwrap()
        ).unwrap();
        let pages = directory.join("store.pages");
        let alias = directory.join("store.pages.alias");
        fs::hard_link(&pages, &alias).unwrap();

        let descriptor = File::open(&pages).unwrap();
        assert_eq!(descriptor.metadata().unwrap().number_of_links(), Some(2));
        assert!(verify_published_descriptor(&pages, &descriptor).is_err());
        assert!(open_verified_bundle_member(
            &pages, directory.join("store.mlpj"), &receipt
        ).is_err());

        drop(descriptor);
        fs::remove_file(alias).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn working_copy_rejects_hardlinked_source() {
        use std::os::unix::fs::{hard_link, PermissionsExt};
        let root = root("copy-source-hardlink");
        let source = root.join("source.pages");
        let alias = root.join("source.alias");
        let destination = root.join("destination.pages");
        fs::write(&source, b"private-source").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
        hard_link(&source, &alias).unwrap();
        assert!(copy_regular_file_synced(&source, &destination).is_err());
        fs::remove_file(&alias).unwrap();
        let digest = copy_regular_file_synced(&source, &destination).unwrap();
        assert_eq!(digest.length, b"private-source".len() as u64);
        assert_eq!(fs::read(destination).unwrap(), b"private-source");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn generation_hash_rejects_publicly_readable_member() {
        use std::os::unix::fs::PermissionsExt;
        let root = root("generation-hash-public-mode");
        let pointer = PublicationPointer::new(1, [0xa5; 16]).unwrap();
        make_generation(&root, &pointer);
        let pages = root.join("generations").join(&pointer.generation_dir).join("store.pages");
        fs::set_permissions(&pages, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(hash_regular_file(&pages).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn generation_hash_rejects_hardlinked_member() {
        use std::os::unix::fs::hard_link;
        let root = root("generation-hash-hardlink");
        let pointer = PublicationPointer::new(1, [0xa4; 16]).unwrap();
        make_generation(&root, &pointer);
        let directory = root.join("generations").join(&pointer.generation_dir);
        let pages = directory.join("store.pages");
        let alias = directory.join("store.pages.alias");
        hard_link(&pages, &alias).unwrap();
        assert!(hash_regular_file(&pages).is_err());
        fs::remove_file(alias).unwrap();
        assert!(hash_regular_file(&pages).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn replaced_publication_root_lock_rejects_reads_and_selector_changes() {
        use std::os::unix::fs::OpenOptionsExt;
        let root = root("root-lock-replaced");
        let pointer = PublicationPointer::new(1, [0xb1; 16]).unwrap();
        make_generation(&root, &pointer);
        let mut publication = PublicationStore::open(&root).unwrap();
        publication.publish(pointer.clone()).unwrap();
        let working = publication.create_working_copy([0xb2; 16]).unwrap();
        drop(working);

        let lock_path = crate::interprocess_lock::lock_path_for(&root.join("CURRENT")).unwrap();
        let displaced = lock_path.with_extension("displaced");
        fs::rename(&lock_path, &displaced).unwrap();
        OpenOptions::new().write(true).create_new(true).mode(0o600)
            .open(&lock_path).unwrap().sync_all().unwrap();

        assert!(publication.verify_generation(&pointer).is_err());
        assert!(publication.open_current_project_store().is_err());
        assert!(publication.resolve_current_paths().is_err());
        assert!(publication.open_working_copy([0xb2; 16]).is_err());
        assert!(publication.create_working_copy([0xb4; 16]).is_err());
        let next = PublicationPointer::new(2, [0xb3; 16]).unwrap();
        make_generation(&root, &next);
        assert!(publication.publish(next).is_err());
        assert_eq!(publication.current(), Some(&pointer));

        drop(publication);
        fs::remove_file(lock_path).unwrap();
        fs::remove_file(displaced).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn generation_receipt_rejects_hardlinks() {
        use std::os::unix::fs::hard_link;
        let root = root("receipt-hardlink");
        let pointer = PublicationPointer::new(1, [0xa2; 16]).unwrap();
        make_generation(&root, &pointer);
        let directory = root.join("generations").join(&pointer.generation_dir);
        let receipt = directory.join("GENERATION.MANIFEST");
        let alias = directory.join("GENERATION.MANIFEST.alias");
        hard_link(&receipt, &alias).unwrap();
        assert!(read_generation_receipt(&directory).is_err());
        fs::remove_file(alias).unwrap();
        assert!(read_generation_receipt(&directory).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn verified_published_member_rejects_hardlinked_pages_descriptor() {
        use std::os::unix::fs::hard_link;
        let root = root("verified-member-hardlink");
        let pointer = PublicationPointer::new(1, [0xa0; 16]).unwrap();
        make_generation(&root, &pointer);
        let directory = root.join("generations").join(&pointer.generation_dir);
        let receipt = GenerationReceipt::decode(
            &fs::read(directory.join("GENERATION.MANIFEST")).unwrap()
        ).unwrap();
        let pages = directory.join("store.pages");
        let alias = directory.join("store.pages.alias");
        hard_link(&pages, &alias).unwrap();

        assert!(open_verified_bundle_member(
            &pages, directory.join("store.mlpj"), &receipt
        ).is_err());

        fs::remove_file(alias).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn generation_receipt_recovers_stale_temporary_without_overwriting_final() {
        let root = root("receipt-stale-temp");
        let pointer = PublicationPointer::new(1, [0xa1; 16]).unwrap();
        let directory = root.join("generations").join(&pointer.generation_dir);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("store.pages"), b"pages").unwrap();
        fs::write(directory.join("store.mlpj"), b"wal").unwrap();
        fs::write(directory.join("GENERATION.MANIFEST.tmp"), b"partial receipt").unwrap();

        let receipt = GenerationReceipt::create_from_files(&directory, &pointer).unwrap();
        assert_eq!(GenerationReceipt::decode(
            &fs::read(directory.join("GENERATION.MANIFEST")).unwrap()
        ).unwrap(), receipt);
        assert!(!directory.join("GENERATION.MANIFEST.tmp").exists());

        let second = GenerationReceipt::create_from_files(&directory, &pointer);
        assert!(matches!(second, Err(PublicationError::Invalid("la receipt de generación ya existe"))));
        assert_eq!(GenerationReceipt::decode(
            &fs::read(directory.join("GENERATION.MANIFEST")).unwrap()
        ).unwrap(), receipt);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn generation_receipt_refuses_non_regular_stale_temporary() {
        let root = root("receipt-temp-symlink");
        let pointer = PublicationPointer::new(1, [0xa2; 16]).unwrap();
        let directory = root.join("generations").join(&pointer.generation_dir);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("store.pages"), b"pages").unwrap();
        fs::write(directory.join("store.mlpj"), b"wal").unwrap();
        fs::create_dir(directory.join("GENERATION.MANIFEST.tmp")).unwrap();

        assert!(matches!(
            GenerationReceipt::create_from_files(&directory, &pointer),
            Err(PublicationError::Invalid("temporal de receipt no es archivo regular"))
        ));
        assert!(!directory.join("GENERATION.MANIFEST").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_pointer_roundtrips_and_resolves_only_regular_generation_files() {
        let root = root("roundtrip");
        let pointer = PublicationPointer::new(1, [0x42; 16]).unwrap();
        let encoded = pointer.encode().unwrap();
        assert_eq!(PublicationPointer::decode(&encoded).unwrap(), pointer);
        make_generation(&root, &pointer);
        let store = PublicationStore::open(&root).unwrap();
        assert_eq!(
            store.resolve_paths(&pointer).unwrap(),
            (
                root.join("generations").join(&pointer.generation_dir).join("store.pages"),
                root.join("generations").join(&pointer.generation_dir).join("store.mlpj"),
            )
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_store_advances_generation_without_replacing_active_slot() {
        let root = root("advance");
        let first = PublicationPointer::new(1, [0x11; 16]).unwrap();
        let second = PublicationPointer::new(2, [0x22; 16]).unwrap();
        make_generation(&root, &first);
        make_generation(&root, &second);
        let mut store = PublicationStore::open(&root).unwrap();
        store.publish(first.clone()).unwrap();
        assert_eq!(store.current(), Some(&first));
        store.publish(second.clone()).unwrap();
        assert_eq!(store.current(), Some(&second));
        assert!(root.join("CURRENT.0").exists());
        assert!(root.join("CURRENT.1").exists());
        drop(store);
        let reopened = PublicationStore::open(&root).unwrap();
        assert_eq!(reopened.current(), Some(&second));
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_store_fails_closed_when_any_existing_selector_is_corrupt() {
        let root = root("fail-closed");
        let first = PublicationPointer::new(1, [0x33; 16]).unwrap();
        make_generation(&root, &first);
        let mut store = PublicationStore::open(&root).unwrap();
        store.publish(first).unwrap();
        drop(store);
        fs::write(root.join("CURRENT.1"), b"torn selector").unwrap();
        assert!(matches!(
            PublicationStore::open(&root),
            Err(PublicationError::Truncated)
                | Err(PublicationError::Invalid(_))
                | Err(PublicationError::ChecksumMismatch)
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_pointer_rejects_path_traversal_and_tampering() {
        let mut pointer = PublicationPointer::new(1, [0x44; 16]).unwrap();
        pointer.generation_dir = "../outside".into();
        assert!(matches!(pointer.encode(), Err(PublicationError::Invalid(_))));
        let mut valid = PublicationPointer::new(1, [0x55; 16]).unwrap().encode().unwrap();
        valid[12] ^= 0x01;
        assert!(matches!(
            PublicationPointer::decode(&valid),
            Err(PublicationError::ChecksumMismatch)
        ));
    }
    #[test]
    fn publication_store_rejects_generation_gaps_between_existing_selectors() {
        let first = PublicationPointer::new(1, [0x61; 16]).unwrap();
        let third = PublicationPointer::new(3, [0x63; 16]).unwrap();
        assert!(matches!(
            select_pointer_slots(Some(first), Some(third)),
            Err(PublicationError::Invalid("las generaciones de los dos selectores no son consecutivas"))
        ));
    }

    #[test]
    fn publication_store_does_not_switch_to_incomplete_generation() {
        let root = root("incomplete");
        let first = PublicationPointer::new(1, [0x71; 16]).unwrap();
        let second = PublicationPointer::new(2, [0x72; 16]).unwrap();
        make_generation(&root, &first);
        let mut store = PublicationStore::open(&root).unwrap();
        store.publish(first.clone()).unwrap();
        fs::create_dir_all(root.join("generations").join(&second.generation_dir)).unwrap();
        assert!(matches!(
            store.publish(second),
            Err(PublicationError::Io(_))
        ));
        assert_eq!(store.current(), Some(&first));
        drop(store);
        let reopened = PublicationStore::open(&root).unwrap();
        assert_eq!(reopened.current(), Some(&first));
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn published_generation_detects_same_length_file_tampering() {
        let root = root("receipt-tamper");
        let pointer = PublicationPointer::new(1, [0x81; 16]).unwrap();
        make_generation(&root, &pointer);
        let generation_dir = root.join("generations").join(&pointer.generation_dir);
        let pages = generation_dir.join("store.pages");
        fs::write(&pages, b"a").unwrap();
        fs::remove_file(generation_dir.join("GENERATION.MANIFEST")).unwrap();
        GenerationReceipt::create_from_files(&generation_dir, &pointer).unwrap();
        let mut store = PublicationStore::open(&root).unwrap();
        store.publish(pointer.clone()).unwrap();
        fs::write(&pages, b"x").unwrap();
        assert!(matches!(
            store.verify_generation(&pointer),
            Err(PublicationError::ChecksumMismatch)
        ));
        assert!(matches!(
            store.resolve_current_paths(),
            Err(PublicationError::ChecksumMismatch)
        ));
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn generation_receipt_checksum_corruption_blocks_active_resolution() {
        let root = root("receipt-checksum");
        let pointer = PublicationPointer::new(1, [0x91; 16]).unwrap();
        make_generation(&root, &pointer);
        let mut store = PublicationStore::open(&root).unwrap();
        store.publish(pointer.clone()).unwrap();
        let receipt = root.join("generations").join(&pointer.generation_dir).join("GENERATION.MANIFEST");
        let mut bytes = fs::read(&receipt).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x80;
        fs::write(&receipt, bytes).unwrap();
        assert!(matches!(
            store.resolve_current_paths(),
            Err(PublicationError::ChecksumMismatch)
        ));
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }


    #[test]
    fn pointer_slot_read_rejects_oversized_content_with_bounded_read() {
        let root = root("oversized-pointer-slot");
        let path = root.join("CURRENT.0");
        fs::write(&path, vec![0x5a; MAX_POINTER_BYTES + 1]).unwrap();

        assert!(matches!(
            read_pointer_slot(&path),
            Err(PublicationError::Invalid("slot excede el tamaño máximo"))
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_retries_after_stale_partial_selector_temporary() {
        let root = root("selector-stale-temp");
        let first = PublicationPointer::new(1, [0xa1; 16]).unwrap();
        let second = PublicationPointer::new(2, [0xa2; 16]).unwrap();
        make_generation(&root, &first);
        make_generation(&root, &second);

        let mut store = PublicationStore::open(&root).unwrap();
        store.publish(first.clone()).unwrap();

        let temporary = root.join(".CURRENT.1.2.tmp");
        fs::write(&temporary, b"partial selector").unwrap();
        store.publish(second.clone()).unwrap();

        assert!(!temporary.exists());
        assert_eq!(store.current(), Some(&second));
        drop(store);

        let reopened = PublicationStore::open(&root).unwrap();
        assert_eq!(reopened.current(), Some(&second));
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_refuses_non_regular_stale_selector_temporary() {
        let root = root("selector-nonregular-temp");
        let first = PublicationPointer::new(1, [0xb1; 16]).unwrap();
        let second = PublicationPointer::new(2, [0xb2; 16]).unwrap();
        make_generation(&root, &first);
        make_generation(&root, &second);

        let mut store = PublicationStore::open(&root).unwrap();
        store.publish(first.clone()).unwrap();

        let temporary = root.join(".CURRENT.1.2.tmp");
        fs::create_dir(&temporary).unwrap();
        assert!(matches!(
            store.publish(second),
            Err(PublicationError::Invalid("temporal de selector no es archivo regular"))
        ));
        assert_eq!(store.current(), Some(&first));
        assert!(root.join("CURRENT.0").exists());
        assert!(!root.join("CURRENT.1").exists());

        drop(store);
        fs::remove_dir_all(root).unwrap();
    }


    #[test]
    fn generation_file_hash_uses_open_regular_file_and_reports_exact_digest() {
        let root = root("hash-regular");
        let path = root.join("store.pages");
        fs::write(&path, b"immutable generation bytes").unwrap();

        let digest = hash_regular_file(&path).unwrap();
        let mut expected = Sha256::new();
        expected.update(b"immutable generation bytes");
        assert_eq!(digest.length, 26);
        assert_eq!(digest.sha256, expected.finish());

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn generation_file_hash_rejects_symbolic_links() {
        use std::os::unix::fs::symlink;
        let root = root("hash-symlink");
        let target = root.join("outside.pages");
        let link = root.join("store.pages");
        fs::write(&target, b"external bytes").unwrap();
        symlink(&target, &link).unwrap();

        assert!(matches!(
            hash_regular_file(&link),
            Err(PublicationError::Invalid("archivo de generación no es regular"))
        ));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_rejects_empty_page_file_that_would_trigger_tree_initialization() {
        let root=root("empty-published-pages");
        let pointer=PublicationPointer::new(1,[0xc5;16]).unwrap();
        let directory=root.join("generations").join(&pointer.generation_dir);
        fs::create_dir_all(&directory).unwrap();
        let pages=directory.join("store.pages");
        let wal=directory.join("store.mlpj");
        {
            let mut project=crate::project_store::ProjectStore::open(&pages,&wal).unwrap();
            project.checkpoint().unwrap();
        }
        fs::write(&pages,b"").unwrap();
        GenerationReceipt::create_from_files(&directory,&pointer).unwrap();
        let mut publication=PublicationStore::open(&root).unwrap();
        assert!(matches!(
            publication.publish(pointer),
            Err(PublicationError::Invalid("archivo MLPG publicado incompleto o sin metadata y raíz"))
        ));
        assert!(publication.current().is_none());
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn working_copy_is_independent_persistent_and_tracks_its_base_generation() {
        let root=root("working-copy-independent");
        let pointer=PublicationPointer::new(1,[0xd1;16]).unwrap();
        let directory=root.join("generations").join(&pointer.generation_dir);
        fs::create_dir_all(&directory).unwrap();
        let pages=directory.join("store.pages");
        let wal=directory.join("store.mlpj");
        {
            let mut project=crate::project_store::ProjectStore::open(&pages,&wal).unwrap();
            project.put_project("novel-A","entities","hero",b"Alice").unwrap();
            project.put_project("novel-B","entities","hero",b"Bruno").unwrap();
            project.checkpoint().unwrap();
        }
        GenerationReceipt::create_from_files(&directory,&pointer).unwrap();
        let mut publication=PublicationStore::open(&root).unwrap();
        publication.publish(pointer.clone()).unwrap();
        let pages_before=fs::read(&pages).unwrap();
        let wal_before=fs::read(&wal).unwrap();

        let working_id=[0xd2;16];
        {
            let mut working=publication.create_working_copy(working_id).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let working_dir=root.join("working").join(working_directory_name(&working_id));
                assert_eq!(fs::metadata(&working_dir).unwrap().permissions().mode()&0o777,0o700);
                for name in ["store.pages","store.mlpj","WORKING.MANIFEST"] {
                    assert_eq!(fs::metadata(working_dir.join(name)).unwrap().permissions().mode()&0o777,0o600);
                }
            }
            assert_eq!(working.base_generation(),1);
            assert_eq!(working.base_migration_id(),pointer.migration_id);
            assert!(publication.open_working_copy(working_id).is_err());
            assert_eq!(working.get_project("novel-A","entities","hero").unwrap(),Some(b"Alice".to_vec()));
            working.put_project("novel-A","entities","hero",b"Alicia").unwrap();
            working.put_project("novel-A","events","arrival",b"new event").unwrap();
            assert_eq!(working.validate().unwrap().entries,3);
        }

        assert_eq!(fs::read(&pages).unwrap(),pages_before);
        assert_eq!(fs::read(&wal).unwrap(),wal_before);
        {
            let mut published=publication.open_current_project_store().unwrap().unwrap();
            assert_eq!(published.get_project("novel-A","entities","hero").unwrap(),Some(b"Alice".to_vec()));
            assert_eq!(published.get_project("novel-A","events","arrival").unwrap(),None);
        }
        {
            let mut reopened=publication.open_or_create_working_copy(working_id).unwrap();
            assert_eq!(reopened.base_generation(),1);
            assert_eq!(reopened.get_project("novel-A","entities","hero").unwrap(),Some(b"Alicia".to_vec()));
            assert_eq!(reopened.get_project("novel-B","entities","hero").unwrap(),Some(b"Bruno".to_vec()));
            assert_eq!(reopened.get_project("novel-A","events","arrival").unwrap(),Some(b"new event".to_vec()));
        }
        assert!(matches!(
            publication.create_working_copy(working_id),
            Err(WorkingStoreError::Publication(PublicationError::Invalid("el ID de working copy ya existe o dejó un temporal; no se reutiliza")))
        ));
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publish_working_copy_advances_selector_without_mutating_its_base() {
        let root=root("publish-working-copy");
        let base=PublicationPointer::new(1,[0xe1;16]).unwrap();
        let directory=root.join("generations").join(&base.generation_dir);
        fs::create_dir_all(&directory).unwrap();
        let pages=directory.join("store.pages");
        let wal=directory.join("store.mlpj");
        {
            let mut project=crate::project_store::ProjectStore::open(&pages,&wal).unwrap();
            project.put_project("novel","entities","hero",b"Alice").unwrap();
            project.checkpoint().unwrap();
        }
        GenerationReceipt::create_from_files(&directory,&base).unwrap();
        let mut publication=PublicationStore::open(&root).unwrap();
        publication.publish(base.clone()).unwrap();
        let base_pages=fs::read(&pages).unwrap();
        let base_wal=fs::read(&wal).unwrap();
        let mut working=publication.create_working_copy([0xe2;16]).unwrap();
        working.put_project("novel","entities","hero",b"Alicia").unwrap();
        working.put_project("novel","events","arrival",b"arrived").unwrap();
        let published=publication.publish_working_copy(working,[0xe3;16]).unwrap();
        assert_eq!(published.generation,2);
        assert_eq!(published.migration_id,[0xe3;16]);
        assert_eq!(publication.current(),Some(&published));
        assert_eq!(fs::read(&pages).unwrap(),base_pages);
        assert_eq!(fs::read(&wal).unwrap(),base_wal);
        let mut current=publication.open_current_project_store().unwrap().unwrap();
        assert_eq!(current.get_project("novel","entities","hero").unwrap(),Some(b"Alicia".to_vec()));
        assert_eq!(current.get_project("novel","events","arrival").unwrap(),Some(b"arrived".to_vec()));
        drop(current);
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publish_working_copy_rejects_corruption_without_advancing_selector() {
        let root=root("publish-working-copy-corrupt");
        let base=PublicationPointer::new(1,[0xe9;16]).unwrap();
        make_generation(&root,&base);
        let mut publication=PublicationStore::open(&root).unwrap();
        publication.publish(base.clone()).unwrap();
        let working=publication.create_working_copy([0xea;16]).unwrap();
        let (pages,_)=working.paths();
        let pages=pages.to_path_buf();
        let mut bytes=fs::read(&pages).unwrap();
        bytes[0]^=0x5a;
        fs::write(&pages,&bytes).unwrap();
        assert!(publication.publish_working_copy(working,[0xeb;16]).is_err());
        assert_eq!(publication.current(),Some(&base));
        let mut published=publication.open_current_project_store().unwrap().unwrap();
        assert_eq!(published.validate().unwrap().entries,0);
        drop(published);
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publish_working_copy_rejects_a_stale_base_generation() {
        let root=root("publish-working-copy-stale");
        let base=PublicationPointer::new(1,[0xe4;16]).unwrap();
        make_generation(&root,&base);
        let mut publication=PublicationStore::open(&root).unwrap();
        publication.publish(base).unwrap();
        let first=publication.create_working_copy([0xe5;16]).unwrap();
        let stale=publication.create_working_copy([0xe6;16]).unwrap();
        publication.publish_working_copy(first,[0xe7;16]).unwrap();
        assert!(matches!(
            publication.publish_working_copy(stale,[0xe8;16]),
            Err(WorkingStoreError::Publication(PublicationError::Invalid(
                "working copy obsoleta: la generación base ya no está activa"
            )))
        ));
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn working_copy_open_rejects_tampered_provenance_manifest() {
        let root=root("working-copy-manifest-tamper");
        let pointer=PublicationPointer::new(1,[0xd3;16]).unwrap();
        make_generation(&root,&pointer);
        let mut publication=PublicationStore::open(&root).unwrap();
        publication.publish(pointer).unwrap();
        let working_id=[0xd4;16];
        let working=publication.create_working_copy(working_id).unwrap();
        drop(working);
        let manifest_path=root.join("working").join(working_directory_name(&working_id)).join("WORKING.MANIFEST");
        let mut bytes=fs::read(&manifest_path).unwrap();
        bytes[12]^=0x01;
        fs::write(&manifest_path,&bytes).unwrap();
        assert!(matches!(
            publication.open_working_copy(working_id),
            Err(WorkingStoreError::Publication(PublicationError::ChecksumMismatch))
        ));
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn published_store_open_rejects_uncheckpointed_wal() {
        let root=root("verified-open-pending-wal");
        let pointer=PublicationPointer::new(1,[0xc4;16]).unwrap();
        let directory=root.join("generations").join(&pointer.generation_dir);
        fs::create_dir_all(&directory).unwrap();
        let pages=directory.join("store.pages");
        let wal=directory.join("store.mlpj");
        {
            let mut project=crate::project_store::ProjectStore::open(&pages,&wal).unwrap();
            project.put_project("novel","entities","hero",b"pending").unwrap();
        }
        GenerationReceipt::create_from_files(&directory,&pointer).unwrap();
        let mut publication=PublicationStore::open(&root).unwrap();
        assert!(matches!(
            publication.publish(pointer),
            Err(PublicationError::Invalid("no se puede publicar una generación con WAL sin checkpoint"))
        ));
        assert!(publication.current().is_none());
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn published_member_rejects_mutation_through_internal_store_handle() {
        let root = root("published-read-only");
        let pointer = PublicationPointer::new(1, [0xd1; 16]).unwrap();
        make_generation(&root, &pointer);
        let directory = root.join("generations").join(&pointer.generation_dir);
        let pages_path = directory.join("store.pages");
        let wal_path = directory.join("store.mlpj");
        let pages_before = fs::read(&pages_path).unwrap();
        let wal_before = fs::read(&wal_path).unwrap();
        let receipt = read_generation_receipt(&directory).unwrap();

        let mut published = open_verified_bundle_member(&pages_path, &wal_path, &receipt).unwrap();
        let result = published.as_mut_project_store().put_project(
            "book", "entities", "must-not-write", b"private",
        );
        assert!(matches!(
            result,
            Err(crate::btree::BTreeError::Journal(
                crate::page_journal::JournalError::Invalid("almacén publicado de solo lectura")
            ))
        ));
        let checkpoint = published.as_mut_project_store().checkpoint();
        assert!(matches!(
            checkpoint,
            Err(crate::btree::BTreeError::Journal(
                crate::page_journal::JournalError::Invalid("almacén publicado de solo lectura")
            ))
        ));
        drop(published);
        assert_eq!(fs::read(&pages_path).unwrap(), pages_before);
        assert_eq!(fs::read(&wal_path).unwrap(), wal_before);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn published_read_only_open_rejects_partial_page_without_repairing_it() {
        let root = root("published-partial-page");
        let pointer = PublicationPointer::new(1, [0xd2; 16]).unwrap();
        let directory = root.join("generations").join(&pointer.generation_dir);
        fs::create_dir_all(&directory).unwrap();
        let pages_path = directory.join("store.pages");
        let wal_path = directory.join("store.mlpj");
        {
            let mut project = crate::project_store::ProjectStore::open(&pages_path, &wal_path).unwrap();
            project.checkpoint().unwrap();
        }
        use std::io::Write as _;
        OpenOptions::new().append(true).open(&pages_path).unwrap()
            .write_all(b"x").unwrap();
        let pages_before = fs::read(&pages_path).unwrap();
        let wal_before = fs::read(&wal_path).unwrap();
        let receipt = GenerationReceipt::create_from_files(&directory, &pointer).unwrap();

        assert!(open_verified_bundle_member(&pages_path, &wal_path, &receipt).is_err());
        assert_eq!(fs::read(&pages_path).unwrap(), pages_before);
        assert_eq!(fs::read(&wal_path).unwrap(), wal_before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn current_project_store_verifies_open_descriptors_before_recovery() {
        let root=root("verified-open");
        let pointer=PublicationPointer::new(1,[0xc1;16]).unwrap();
        let directory=root.join("generations").join(&pointer.generation_dir);
        fs::create_dir_all(&directory).unwrap();
        let pages=directory.join("store.pages");
        let wal=directory.join("store.mlpj");
        {
            let mut project=crate::project_store::ProjectStore::open(&pages,&wal).unwrap();
            project.put_project("novel","entities","hero",b"verified-value").unwrap();
            project.checkpoint().unwrap();
        }
        GenerationReceipt::create_from_files(&directory,&pointer).unwrap();
        let pages_before=fs::read(&pages).unwrap();
        let wal_before=fs::read(&wal).unwrap();
        let mut publication=PublicationStore::open(&root).unwrap();
        publication.publish(pointer.clone()).unwrap();
        let mut opened=publication.open_current_project_store().unwrap().unwrap();
        assert_eq!(opened.get_project("novel","entities","hero").unwrap(),Some(b"verified-value".to_vec()));
        drop(opened);
        assert_eq!(fs::read(&pages).unwrap(),pages_before);
        assert_eq!(fs::read(&wal).unwrap(),wal_before);
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn current_project_store_rejects_tampered_wal_before_header_recovery() {
        let root=root("verified-open-wal-tamper");
        let pointer=PublicationPointer::new(1,[0xc2;16]).unwrap();
        let directory=root.join("generations").join(&pointer.generation_dir);
        fs::create_dir_all(&directory).unwrap();
        let pages=directory.join("store.pages");
        let wal=directory.join("store.mlpj");
        {
            let mut project=crate::project_store::ProjectStore::open(&pages,&wal).unwrap();
            project.put_project("novel","entities","hero",b"original").unwrap();
            project.checkpoint().unwrap();
        }
        GenerationReceipt::create_from_files(&directory,&pointer).unwrap();
        let mut publication=PublicationStore::open(&root).unwrap();
        publication.publish(pointer).unwrap();

        // El WAL conserva el mismo tamaño, pero su cabecera queda corrupta.
        // SHA debe fallar antes de que ensure_wal_header() pueda inspeccionarla.
        let mut bytes=fs::read(&wal).unwrap();
        bytes[0]^=0x5a;
        fs::write(&wal,&bytes).unwrap();
        assert!(matches!(
            publication.open_current_project_store(),
            Err(PublishedStoreOpenError::Store(crate::btree::BTreeError::Journal(
                crate::page_journal::JournalError::Io(_)
            )))
        ));
        assert_eq!(fs::read(&wal).unwrap(),bytes);
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn current_project_store_rejects_tampered_pages_before_recovery() {
        let root=root("verified-open-pages-tamper");
        let pointer=PublicationPointer::new(1,[0xc3;16]).unwrap();
        let directory=root.join("generations").join(&pointer.generation_dir);
        fs::create_dir_all(&directory).unwrap();
        let pages=directory.join("store.pages");
        let wal=directory.join("store.mlpj");
        {
            let mut project=crate::project_store::ProjectStore::open(&pages,&wal).unwrap();
            project.put_project("novel","entities","hero",b"original").unwrap();
            project.checkpoint().unwrap();
        }
        GenerationReceipt::create_from_files(&directory,&pointer).unwrap();
        let mut publication=PublicationStore::open(&root).unwrap();
        publication.publish(pointer).unwrap();

        let mut bytes=fs::read(&pages).unwrap();
        let last=bytes.len()-1;
        bytes[last]^=0x5a;
        fs::write(&pages,&bytes).unwrap();
        assert!(matches!(
            publication.open_current_project_store(),
            Err(PublishedStoreOpenError::Store(crate::btree::BTreeError::Journal(
                crate::page_journal::JournalError::Io(_)
            )))
        ));
        assert_eq!(fs::read(&pages).unwrap(),bytes);
        drop(publication);
        fs::remove_dir_all(root).unwrap();
    }

}
