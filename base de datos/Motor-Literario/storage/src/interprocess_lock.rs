//! Bloqueo asesor exclusivo entre procesos usando primitivas del kernel.
//! El archivo .mldb-lock es persistente; nunca se elimina al liberar el bloqueo.
use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum LockError {
    AlreadyLocked,
    UnsupportedPlatform,
    Io(io::Error),
}
impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyLocked => write!(f, "la base de datos ya está abierta por otro proceso"),
            Self::UnsupportedPlatform => write!(f, "bloqueo interproceso no disponible en esta plataforma"),
            Self::Io(e) => write!(f, "error de bloqueo interproceso: {e}"),
        }
    }
}
impl std::error::Error for LockError {}
impl From<io::Error> for LockError { fn from(e: io::Error) -> Self { Self::Io(e) } }

fn open_lock_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        // En Linux/Android, O_NOFOLLOW hace que el kernel rechace el enlace
        // simbólico en la propia operación open(), sin ventana check/use.
        #[cfg(any(target_os = "linux", target_os = "android"))]
        options.custom_flags(0o400000);
    }
    let file = options.open(path)?;
    verify_open_lock_file(path, &file)?;
    Ok(file)
}

fn open_existing_lock_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // No seguir symlinks y, sobre todo, no crear el archivo si desapareció.
        options.custom_flags(0o400000);
    }
    let file = options.open(path)?;
    verify_open_lock_file(path, &file)?;
    Ok(file)
}

fn verify_open_lock_file(path: &Path, file: &File) -> io::Result<()> {
    let opened = file.metadata()?;
    let current = std::fs::symlink_metadata(path)?;
    if !opened.is_file() || current.file_type().is_symlink() || !current.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "el archivo de bloqueo no es un archivo regular",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // El archivo de bloqueo debe ser privado y no compartir inode mediante
        // hardlinks. También comprobamos que la ruta aún nombre el descriptor
        // que acabamos de abrir.
        if opened.mode() & 0o077 != 0 || opened.nlink() != 1
            || opened.dev() != current.dev() || opened.ino() != current.ino()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "archivo de bloqueo sustituido, compartido o no privado",
            ));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // En Windows comparamos volumen e índice de archivo del descriptor
        // con los de la ruta; longitud/fecha no bastan para detectar reemplazo
        // por otro archivo de igual tamaño.
        if opened.volume_serial_number().is_none()
            || opened.file_index().is_none()
            || opened.volume_serial_number() != current.volume_serial_number()
            || opened.file_index() != current.file_index()
            || opened.number_of_links() != Some(1)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "archivo de bloqueo sustituido o compartido",
            ));
        }
    }
    Ok(())
}

/// Un guard no clonable. Su File mantiene vivo el bloqueo del kernel.
pub struct InterprocessLock {
    file: File,
    path: PathBuf,
    #[cfg(windows)]
    overlapped: windows_backend::Overlapped,
}

// SAFETY: el guard solo contiene un File y el estado OVERLAPPED de un bloqueo
// adquirido de forma síncrona (FAIL_IMMEDIATELY); ambos pueden trasladarse
// entre hilos y liberarse desde el hilo que destruya el guard.
unsafe impl Send for InterprocessLock {}

impl InterprocessLock {
    /// Bloquea el archivo mutable indicado mediante un archivo compañero estable.
    pub fn acquire_for(data_path: impl AsRef<Path>) -> Result<Self, LockError> {
        let path = lock_path_for(data_path.as_ref())?;
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
        let file = open_lock_file(&path)?;
        #[cfg(unix)]
        unix_backend::lock(&file)?;
        #[cfg(windows)]
        let overlapped = windows_backend::lock(&file)?;
        #[cfg(not(any(unix, windows)))]
        return Err(LockError::UnsupportedPlatform);
        // Volver a comparar después de adquirir el lock: detecta una
        // sustitución ocurrida entre la apertura y la adquisición del kernel.
        verify_open_lock_file(&path, &file)?;
        #[cfg(any(unix, windows))]
        Ok(Self {
            file,
            path,
            #[cfg(windows)]
            overlapped,
        })
    }

    /// Intenta adquirir un lock ya existente sin crear el archivo ni su directorio.
    /// Se usa para inspecciones: la observación nunca debe reconstruir una sesión ausente.
    pub fn acquire_existing_for(data_path: impl AsRef<Path>) -> Result<Self, LockError> {
        let path = lock_path_for_existing(data_path.as_ref())?;
        let file = open_existing_lock_file(&path)?;
        #[cfg(unix)]
        unix_backend::lock(&file)?;
        #[cfg(windows)]
        let overlapped = windows_backend::lock(&file)?;
        #[cfg(not(any(unix, windows)))]
        return Err(LockError::UnsupportedPlatform);
        verify_open_lock_file(&path, &file)?;
        #[cfg(any(unix, windows))]
        Ok(Self {
            file,
            path,
            #[cfg(windows)]
            overlapped,
        })
    }

    /// Ruta estable del archivo auxiliar; útil para diagnóstico.
    pub fn path(&self) -> &Path { &self.path }

    /// Comprueba que el archivo auxiliar sigue nombrando el descriptor bloqueado.
    /// Detecta sustituciones del lockfile durante una sesión antes de mutar datos.
    pub fn validate_identity(&self) -> Result<(), LockError> {
        verify_open_lock_file(&self.path, &self.file).map_err(LockError::Io)
    }

    /// Adquiere varios bloqueos en orden estable para evitar deadlocks.
    /// Las rutas equivalentes al mismo archivo auxiliar se deduplican.
    pub fn acquire_many(data_paths: &[&Path]) -> Result<Vec<Self>, LockError> {
        let mut paths = Vec::with_capacity(data_paths.len());
        for data_path in data_paths { paths.push(lock_path_for(data_path)?); }
        paths.sort();
        paths.dedup();
        let mut guards = Vec::with_capacity(paths.len());
        for lock_path in paths {
            if let Some(parent) = lock_path.parent() { std::fs::create_dir_all(parent)?; }
            let file = open_lock_file(&lock_path)?;
            #[cfg(unix)]
            unix_backend::lock(&file)?;
            #[cfg(windows)]
            let overlapped = windows_backend::lock(&file)?;
            #[cfg(not(any(unix, windows)))]
            return Err(LockError::UnsupportedPlatform);
            verify_open_lock_file(&lock_path, &file)?;
            #[cfg(any(unix, windows))]
            guards.push(Self {
                file,
                path: lock_path,
                #[cfg(windows)]
                overlapped,
            });
        }
        Ok(guards)
    }
}

impl Drop for InterprocessLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        unix_backend::unlock(&self.file);
        #[cfg(windows)]
        windows_backend::unlock(&self.file, &mut self.overlapped);
        // El archivo auxiliar no se elimina: su identidad debe permanecer estable.
        let _ = &self.file;
    }
}

/// Resuelve un lock existente sin crear directorios ni archivos auxiliares.
fn lock_path_for_existing(data_path: &Path) -> io::Result<PathBuf> {
    let absolute = if data_path.is_absolute() {
        data_path.to_path_buf()
    } else {
        std::env::current_dir()?.join(data_path)
    };
    let parent = absolute.parent().ok_or_else(|| io::Error::new(
        io::ErrorKind::InvalidInput, "ruta sin directorio padre"
    ))?;
    let file_name = absolute.file_name().ok_or_else(|| io::Error::new(
        io::ErrorKind::InvalidInput, "ruta sin nombre de archivo"
    ))?;
    match std::fs::symlink_metadata(&absolute) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "archivo de datos es symlink"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let canonical_parent = std::fs::canonicalize(parent)?;
    let mut lock_name = file_name.to_os_string();
    lock_name.push(".mldb-lock");
    let lock_path = canonical_parent.join(lock_name);
    let lock_metadata = std::fs::symlink_metadata(&lock_path)?;
    if lock_metadata.file_type().is_symlink() || !lock_metadata.is_file() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "lock existente no es archivo regular"));
    }
    Ok(lock_path)
}

/// Normaliza el directorio existente y conserva el nombre final del archivo.
/// Rechaza enlaces simbólicos directos en el archivo de datos y en el lockfile;
pub(crate) fn lock_path_for(data_path: &Path) -> Result<PathBuf, LockError> {
    let absolute = if data_path.is_absolute() {
        data_path.to_path_buf()
    } else {
        std::env::current_dir()?.join(data_path)
    };
    let parent = absolute.parent().ok_or_else(|| LockError::Io(io::Error::new(
        io::ErrorKind::InvalidInput, "ruta sin directorio padre"
    )))?;
    let file_name = absolute.file_name().ok_or_else(|| LockError::Io(io::Error::new(
        io::ErrorKind::InvalidInput, "ruta sin nombre de archivo"
    )))?;
    if let Ok(metadata) = std::fs::symlink_metadata(&absolute) {
        if metadata.file_type().is_symlink() {
            return Err(LockError::Io(io::Error::new(io::ErrorKind::InvalidInput, "no se admiten enlaces simbólicos como archivo de datos")));
        }
    }
    // Asegurar el directorio antes de canonicalizarlo: hacerlo después
    // no sirve porque canonicalize falla si la ruta todavía no existe.
    std::fs::create_dir_all(parent)?;
    let canonical_parent = std::fs::canonicalize(parent)?;
    let mut lock_name = file_name.to_os_string();
    lock_name.push(".mldb-lock");
    let lock_path = canonical_parent.join(lock_name);
    if let Ok(metadata) = std::fs::symlink_metadata(&lock_path) {
        if metadata.file_type().is_symlink() {
            return Err(LockError::Io(io::Error::new(io::ErrorKind::InvalidInput, "no se admiten enlaces simbólicos como archivo de bloqueo")));
        }
    }
    Ok(lock_path)
}

#[cfg(unix)]
mod unix_backend {
    use super::{File, LockError};
    use std::io;
    use std::os::fd::AsRawFd;

    const LOCK_EX: i32 = 2;
    const LOCK_NB: i32 = 4;
    const LOCK_UN: i32 = 8;

    extern "C" { fn flock(fd: i32, operation: i32) -> i32; }

    pub fn lock(file: &File) -> Result<(), LockError> {
        let result = unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) };
        if result == 0 { return Ok(()); }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::WouldBlock {
            return Err(LockError::AlreadyLocked);
        }
        Err(LockError::Io(error))
    }

    pub fn unlock(file: &File) {
        let _ = unsafe { flock(file.as_raw_fd(), LOCK_UN) };
    }
}

#[cfg(windows)]
mod windows_backend {
    use super::{File, LockError};
    use std::io;
    use std::os::windows::io::AsRawHandle;

    const LOCKFILE_EXCLUSIVE_LOCK: u32 = 0x0000_0002;
    const LOCKFILE_FAIL_IMMEDIATELY: u32 = 0x0000_0001;
    const ERROR_LOCK_VIOLATION: i32 = 33;

    #[repr(C)]
    pub struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: *mut core::ffi::c_void,
    }
    impl Default for Overlapped {
        fn default() -> Self {
            Self { internal: 0, internal_high: 0, offset: 0, offset_high: 0, event: std::ptr::null_mut() }
        }
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LockFileEx(
            file: *mut core::ffi::c_void,
            flags: u32,
            reserved: u32,
            bytes_low: u32,
            bytes_high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
        fn UnlockFileEx(
            file: *mut core::ffi::c_void,
            reserved: u32,
            bytes_low: u32,
            bytes_high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
    }

    pub fn lock(file: &File) -> Result<Overlapped, LockError> {
        let mut overlapped = Overlapped::default();
        let result = unsafe {
            LockFileEx(
                file.as_raw_handle() as *mut _,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                u32::MAX,
                u32::MAX,
                &mut overlapped,
            )
        };
        if result != 0 { return Ok(overlapped); }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION) {
            return Err(LockError::AlreadyLocked);
        }
        Err(LockError::Io(error))
    }

    pub fn unlock(file: &File, overlapped: &mut Overlapped) {
        let _ = unsafe {
            UnlockFileEx(
                file.as_raw_handle() as *mut _,
                0,
                u32::MAX,
                u32::MAX,
                overlapped,
            )
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path() -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("mldb-lock-{}-{n}.data", std::process::id()))
    }

    #[test]
    fn failed_multi_lock_releases_earlier_guards() {
        let base = temp_path();
        let first_data = base.with_extension("a");
        let second_data = base.with_extension("b");
        let held = InterprocessLock::acquire_for(&second_data).unwrap();
        assert!(matches!(InterprocessLock::acquire_many(&[&first_data, &second_data]), Err(LockError::AlreadyLocked)));
        let first = InterprocessLock::acquire_for(&first_data).unwrap();
        drop(first);
        drop(held);
        for data in [&first_data, &second_data] {
            let lock_path = lock_path_for(data).unwrap();
            let _ = std::fs::remove_file(lock_path);
        }
    }

    #[test]
    fn second_open_is_rejected_until_guard_drops() {
        let data = temp_path();
        let first = InterprocessLock::acquire_for(&data).unwrap();
        assert!(matches!(InterprocessLock::acquire_for(&data), Err(LockError::AlreadyLocked)));
        drop(first);
        let second = InterprocessLock::acquire_for(&data).unwrap();
        assert!(second.path().exists());
        drop(second);
        let lock_path = lock_path_for(&data).unwrap();
        let _ = std::fs::remove_file(lock_path);
    }

    #[test]
    fn cross_process_lock_is_exclusive_and_released_after_owner_exits() {
        const DATA_ENV: &str = "MLDB_LOCK_CHILD_DATA_PATH";
        const MODE_ENV: &str = "MLDB_LOCK_CHILD_EXPECTATION";
        if let Ok(data) = std::env::var(DATA_ENV) {
            let path = PathBuf::from(data);
            match std::env::var(MODE_ENV).as_deref() {
                Ok("blocked") => assert!(matches!(
                    InterprocessLock::acquire_for(&path),
                    Err(LockError::AlreadyLocked)
                )),
                Ok("available") => {
                    let child_guard = InterprocessLock::acquire_for(&path).unwrap();
                    drop(child_guard);
                }
                Ok("exit-held") => {
                    let _child_guard = InterprocessLock::acquire_for(&path).unwrap();
                    // Simula terminación abrupta: el kernel debe liberar el lock
                    // aunque el destructor Rust no llegue a ejecutarse.
                    std::process::exit(0);
                }
                other => panic!("modo de proceso hijo inválido: {other:?}"),
            }
            return;
        }

        let data = temp_path();
        let guard = InterprocessLock::acquire_for(&data).unwrap();
        let executable = std::env::current_exe().unwrap();
        let run_child = |expectation: &str| {
            let status = std::process::Command::new(&executable)
                .arg("--exact")
                .arg("interprocess_lock::tests::cross_process_lock_is_exclusive_and_released_after_owner_exits")
                .arg("--nocapture")
                .env(DATA_ENV, data.to_string_lossy().as_ref())
                .env(MODE_ENV, expectation)
                .status()
                .unwrap();
            assert!(status.success(), "el proceso hijo falló: {expectation}");
        };

        run_child("blocked");
        drop(guard);
        run_child("available");
        run_child("exit-held");
        let after_abrupt_exit = InterprocessLock::acquire_for(&data).unwrap();
        drop(after_abrupt_exit);

        let lock_path = lock_path_for(&data).unwrap();
        let _ = std::fs::remove_file(data);
        let _ = std::fs::remove_file(lock_path);
    }


    #[test]
    fn acquire_creates_missing_parent_directories() {
        let base = temp_path().with_extension("nested");
        let data = base.join("level-one").join("level-two").join("store.data");
        let guard = InterprocessLock::acquire_for(&data).unwrap();
        assert!(base.join("level-one").join("level-two").is_dir());
        assert!(guard.path().exists());
        drop(guard);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn equivalent_parent_paths_resolve_to_the_same_lock() {
        let base = temp_path().with_extension("aliases");
        std::fs::create_dir_all(base.join("child")).unwrap();
        let direct = base.join("store.data");
        let alias = base.join("child").join("..").join("store.data");
        let first = InterprocessLock::acquire_for(&direct).unwrap();
        assert_eq!(
            lock_path_for(&direct).unwrap(),
            lock_path_for(&alias).unwrap()
        );
        assert!(matches!(
            InterprocessLock::acquire_for(&alias),
            Err(LockError::AlreadyLocked)
        ));
        drop(first);
        let second = InterprocessLock::acquire_for(&alias).unwrap();
        drop(second);
        std::fs::remove_dir_all(base).unwrap();
    }


    #[cfg(unix)]
    #[test]
    fn symbolic_links_are_rejected_for_data_and_lock_files() {
        use std::os::unix::fs::symlink;

        let base = temp_path().with_extension("symlinks");
        std::fs::create_dir_all(&base).unwrap();
        let target = base.join("target.data");
        std::fs::write(&target, b"target").unwrap();

        let data_link = base.join("data-link");
        symlink(&target, &data_link).unwrap();
        assert!(matches!(
            InterprocessLock::acquire_for(&data_link),
            Err(LockError::Io(_))
        ));

        let lock_link_data = base.join("lock-link-data");
        let lock_link = lock_path_for(&lock_link_data).unwrap();
        let other_lock = base.join("other-lock");
        std::fs::write(&other_lock, b"").unwrap();
        symlink(&other_lock, &lock_link).unwrap();
        assert!(matches!(
            InterprocessLock::acquire_for(&lock_link_data),
            Err(LockError::Io(_))
        ));

        std::fs::remove_dir_all(base).unwrap();
    }


    #[cfg(unix)]
    #[test]
    fn acquiring_existing_lock_does_not_create_missing_file() {
        let directory = std::env::temp_dir().join(format!(
            "mldb-existing-lock-missing-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let data = directory.join("store.pages");
        let lock_path = lock_path_for(&data).unwrap();
        assert!(!lock_path.exists());
        assert!(InterprocessLock::acquire_existing_for(&data).is_err());
        assert!(!lock_path.exists(), "la adquisición de inspección no crea locks");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn acquiring_existing_lock_does_not_recreate_missing_parent_directory() {
        let root = std::env::temp_dir().join(format!(
            "mldb-existing-lock-parent-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let missing_parent = root.join("working").join("session");
        let data = missing_parent.join("SESSION");
        assert!(InterprocessLock::acquire_existing_for(&data).is_err());
        assert!(!root.exists(), "la inspección no debe reconstruir directorios ausentes");
    }

    #[test]
    fn active_guard_detects_lockfile_replacement() {
        let data = temp_path();
        let guard = InterprocessLock::acquire_for(&data).unwrap();
        let lock_path = guard.path().to_path_buf();
        let displaced = lock_path.with_extension("displaced");
        std::fs::rename(&lock_path, &displaced).unwrap();
        std::fs::write(&lock_path, b"").unwrap();
        assert!(matches!(guard.validate_identity(), Err(LockError::Io(_))));
        drop(guard);
        let _ = std::fs::remove_file(lock_path);
        let _ = std::fs::remove_file(displaced);
    }

    #[cfg(windows)]
    #[test]
    fn active_guard_detects_lockfile_replacement_on_windows() {
        let data = temp_path();
        let guard = InterprocessLock::acquire_for(&data).unwrap();
        let lock_path = guard.path().to_path_buf();
        let displaced = lock_path.with_extension("displaced");
        std::fs::rename(&lock_path, &displaced).unwrap();
        std::fs::write(&lock_path, b"replacement").unwrap();
        assert!(matches!(guard.validate_identity(), Err(LockError::Io(_))));
        drop(guard);
        let _ = std::fs::remove_file(lock_path);
        let _ = std::fs::remove_file(displaced);
    }

    #[cfg(unix)]
    #[test]
    fn lock_file_rejects_hardlinks_and_non_private_existing_files() {
        use std::os::unix::fs::{hard_link, PermissionsExt};

        let base = temp_path().with_extension("lock-hardlink");
        std::fs::create_dir_all(&base).unwrap();

        let data = base.join("store.data");
        let lock = lock_path_for(&data).unwrap();
        let target = base.join("unrelated-file");
        std::fs::write(&target, b"do not lock this inode").unwrap();
        hard_link(&target, &lock).unwrap();
        assert!(matches!(
            InterprocessLock::acquire_for(&data),
            Err(LockError::Io(_))
        ));

        std::fs::remove_file(&lock).unwrap();
        std::fs::write(&lock, b"").unwrap();
        std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(
            InterprocessLock::acquire_for(&data),
            Err(LockError::Io(_))
        ));

        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn acquire_many_deduplicates_equivalent_paths() {
        let base = temp_path().with_extension("multi-alias");
        std::fs::create_dir_all(base.join("child")).unwrap();
        let direct = base.join("store.data");
        let alias = base.join("child").join("..").join("store.data");
        let guards = InterprocessLock::acquire_many(&[&direct, &alias]).unwrap();
        assert_eq!(guards.len(), 1);
        assert!(matches!(
            InterprocessLock::acquire_for(&direct),
            Err(LockError::AlreadyLocked)
        ));
        drop(guards);
        let guard = InterprocessLock::acquire_for(&alias).unwrap();
        drop(guard);
        std::fs::remove_dir_all(base).unwrap();
    }

}
