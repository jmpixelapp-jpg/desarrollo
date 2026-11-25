//! Coordinador experimental de WAL de imágenes completas y archivo MLPG.
//! Las transacciones pueden incluir varias páginas y se confirman como una unidad.
use crate::page::{PageError, PageFile};
use crate::interprocess_lock::{InterprocessLock, LockError};
use crate::bundle::SessionLockValidator;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const MAGIC: &[u8; 8] = b"MLPJNL\r\n";
const VERSION: u32 = 2;
const FRAME: &[u8; 4] = b"MPJF";
const HEADER: u64 = 12;
pub(crate) const MLPJ_HEADER_BYTES:u64=HEADER;
const BEGIN: u8 = 1;
const IMAGE: u8 = 2;
const COMMIT: u8 = 3;
const FRAME_HEADER: usize = 21;
const MAX_PAYLOAD: usize = 4066;
pub(crate) const MAX_IMAGES_PER_TX: usize = 8_192;
const MAX_TRANSACTION_BYTES: usize = 32 * 1024 * 1024;
const NO_GENERATION: u64 = u64::MAX;

#[derive(Debug)]
pub enum JournalError { Io(io::Error), Page(PageError), Corrupt(&'static str), Invalid(&'static str), AlreadyLocked }
fn map_lock_error(e: LockError) -> JournalError {
 match e {
  LockError::AlreadyLocked => JournalError::AlreadyLocked,
  LockError::UnsupportedPlatform => JournalError::Invalid("bloqueo interproceso no disponible en esta plataforma"),
  LockError::Io(e) => JournalError::Io(e),
 }
}
impl From<io::Error> for JournalError { fn from(e:io::Error)->Self{Self::Io(e)} }
impl From<PageError> for JournalError { fn from(e:PageError)->Self{Self::Page(e)} }
impl std::fmt::Display for JournalError {
 fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {
  match self { Self::Io(e)=>write!(f,"I/O WAL páginas: {e}"),Self::Page(e)=>write!(f,"páginas: {e}"),Self::Corrupt(s)=>write!(f,"WAL de páginas corrupto: {s}"),Self::Invalid(s)=>write!(f,"operación WAL de páginas inválida: {s}"),Self::AlreadyLocked=>write!(f,"la base ya está abierta por otro proceso") }
 }
}
impl std::error::Error for JournalError {}

/// Cambio solicitado. Los IDs de páginas nuevas los asigna el diario.
pub enum PageChange {
 Allocate { generation:u64, payload:Vec<u8> },
 Overwrite { page_id:u64, expected_generation:u64, new_generation:u64, payload:Vec<u8> },
}
#[derive(Clone,Debug,Eq,PartialEq)]
struct Image { page_id:u64, expected_generation:Option<u64>, generation:u64, payload:Vec<u8> }

fn same_file_identity(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
 #[cfg(unix)]
 {
  use std::os::unix::fs::MetadataExt;
  left.dev() == right.dev() && left.ino() == right.ino()
 }
 #[cfg(windows)]
 {
  use std::os::windows::fs::MetadataExt;
  left.is_file() && right.is_file()
   && left.volume_serial_number().is_some()
   && left.file_index().is_some()
   && left.volume_serial_number() == right.volume_serial_number()
   && left.file_index() == right.file_index()
 }
 #[cfg(not(any(unix, windows)))]
 {
  left.is_file() && right.is_file() && left.len() == right.len()
 }
}

pub(crate) fn open_existing_wal_file_read_only(path:&Path)->io::Result<File>{
 let before=std::fs::symlink_metadata(path)?;
 if before.file_type().is_symlink() || !before.is_file(){return Err(io::Error::new(io::ErrorKind::InvalidInput,"WAL publicado no es regular"));}
 let mut options=OpenOptions::new(); options.read(true);
 #[cfg(any(target_os="linux",target_os="android"))] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(0x20_000); }
 let file=options.open(path)?; let opened=file.metadata()?; let after=std::fs::symlink_metadata(path)?;
 if !opened.is_file() || after.file_type().is_symlink() || !after.is_file()
  || !same_file_identity(&before,&opened) || !same_file_identity(&opened,&after){
  return Err(io::Error::new(io::ErrorKind::InvalidInput,"el WAL publicado cambió durante la apertura"));
 }
 Ok(file)
}

pub(crate) fn open_existing_wal_file(path:&Path)->io::Result<File>{
 let before=std::fs::symlink_metadata(path)?;
 if before.file_type().is_symlink() || !before.is_file(){return Err(io::Error::new(io::ErrorKind::InvalidInput,"archivo WAL no es regular"));}
 let mut options=OpenOptions::new(); options.read(true).write(true);
 #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
 #[cfg(any(target_os="linux",target_os="android"))] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(0x20_000); }
 let file=options.open(path)?; let opened=file.metadata()?; let after=std::fs::symlink_metadata(path)?;
 if !opened.is_file() || after.file_type().is_symlink() || !after.is_file()
  || !same_file_identity(&before,&opened) || !same_file_identity(&opened,&after){
  return Err(io::Error::new(io::ErrorKind::InvalidInput,"el archivo WAL cambió durante la apertura"));
 }
 Ok(file)
}

fn validate_open_wal_path(path:&Path,file:&File)->io::Result<()>{
 let opened=file.metadata()?;
 let current=std::fs::symlink_metadata(path)?;
 if !opened.is_file() || current.file_type().is_symlink() || !current.is_file()
  || !same_file_identity(&opened,&current){
  return Err(io::Error::new(io::ErrorKind::InvalidInput,"el archivo WAL cambió después de verificar su descriptor"));
 }
 Ok(())
}

pub(crate) fn open_wal_file(path: &Path) -> io::Result<File> {
 let before = match std::fs::symlink_metadata(path) {
  Ok(metadata) => {
   if metadata.file_type().is_symlink() || !metadata.is_file() {
    return Err(io::Error::new(io::ErrorKind::InvalidInput, "archivo WAL no es regular"));
   }
   Some(metadata)
  }
  Err(error) if error.kind() == io::ErrorKind::NotFound => None,
  Err(error) => return Err(error),
 };
 let mut options=OpenOptions::new();
 options.read(true).write(true).create(true);
 // El WAL puede contener el texto completo y los cambios de cada obra.
 #[cfg(unix)]
 {
  use std::os::unix::fs::OpenOptionsExt;
  options.mode(0o600);
 }
 // Linux/Android: impedir que el path se resuelva como symlink dentro
 // de open(), cerrando la carrera entre symlink_metadata() y apertura.
 #[cfg(any(target_os = "linux", target_os = "android"))]
 {
  use std::os::unix::fs::OpenOptionsExt;
  const O_NOFOLLOW: i32 = 0x20_000;
  options.custom_flags(O_NOFOLLOW);
 }
 let file = options.open(path)?;
 let opened = file.metadata()?;
 let current = std::fs::symlink_metadata(path)?;
 if !opened.is_file() || current.file_type().is_symlink() || !current.is_file()
  || !same_file_identity(&opened, &current)
  || before.as_ref().is_some_and(|metadata| !same_file_identity(metadata, &opened))
 {
  return Err(io::Error::new(io::ErrorKind::InvalidInput, "el archivo WAL cambió durante la apertura"));
 }
 Ok(file)
}

pub struct DurablePages { pages:PageFile, wal:File, wal_path:PathBuf, next_tx:u64, recovery_required:bool, read_only:bool, _locks:Vec<InterprocessLock>, session_lock_validator:Option<SessionLockValidator>, #[cfg(test)] fail_apply_after_images:Option<usize> }

impl DurablePages {
 /// Abre páginas y ejecuta redo antes de devolver acceso al almacén.
 pub fn open(pages_path:impl AsRef<Path>, wal_path:impl AsRef<Path>)->Result<Self,JournalError>{
  Self::open_internal(pages_path,wal_path,false,|_,_|Ok(()),None)
 }

 /// Verifica descriptores ya abiertos, bajo los bloqueos de datos y antes de
 /// validar/truncar el WAL o ejecutar redo. El llamador debe hashear ambos
 /// descriptores y no sus rutas. Esta ruta nunca crea archivos ausentes.
 pub(crate) fn open_with_pre_recovery_verification<F>(
  pages_path:impl AsRef<Path>,
  wal_path:impl AsRef<Path>,
  verify:F,
 )->Result<Self,JournalError>
 where F:FnOnce(&mut File,&mut File)->io::Result<()> {
  Self::open_internal(pages_path,wal_path,true,verify,None)
 }

 /// Abre archivos existentes verificando sus descriptores y manteniendo el
 /// validador de sesión dentro de recovery y checkpoint.
 pub(crate) fn open_with_pre_recovery_verification_and_session_validator<F>(
  pages_path:impl AsRef<Path>,
  wal_path:impl AsRef<Path>,
  verify:F,
  validator:SessionLockValidator,
 )->Result<Self,JournalError>
 where F:FnOnce(&mut File,&mut File)->io::Result<()> {
  validator.validate().map_err(|_|JournalError::Invalid("bloqueo de sesión inválido"))?;
  Self::open_internal(pages_path,wal_path,true,verify,Some(validator))
 }

 /// Abre archivos existentes y mantiene el validador de sesión dentro del
 /// coordinador WAL. Recovery y checkpoint lo revalidan en sus fronteras de escritura.
 pub(crate) fn open_existing_with_session_validator(
  pages_path:impl AsRef<Path>,
  wal_path:impl AsRef<Path>,
  validator:SessionLockValidator,
 )->Result<Self,JournalError>{
  validator.validate().map_err(|_|JournalError::Invalid("bloqueo de sesión inválido"))?;
  Self::open_internal(pages_path,wal_path,true,|_,_|Ok(()),Some(validator))
 }

 /// Abre una generación publicada sin permisos de escritura y sin ejecutar recovery.
 /// Solo acepta un WAL checkpointed con cabecera válida; cualquier reparación
 /// debe ocurrir en una working copy, nunca sobre los archivos publicados.
 pub(crate) fn open_read_only_with_pre_recovery_verification<F>(
  pages_path:impl AsRef<Path>,
  wal_path:impl AsRef<Path>,
  verify:F,
 )->Result<Self,JournalError>
 where F:FnOnce(&mut File,&mut File)->io::Result<()> {
  let pages_path=pages_path.as_ref();
  let wal_path=wal_path.as_ref().to_path_buf();
  let pages_lock_path=crate::interprocess_lock::lock_path_for(pages_path).map_err(map_lock_error)?;
  let wal_lock_path=crate::interprocess_lock::lock_path_for(&wal_path).map_err(map_lock_error)?;
  if pages_lock_path==wal_lock_path {
   return Err(JournalError::Invalid("el archivo de páginas y el WAL deben ser rutas distintas"));
  }
  let locks=InterprocessLock::acquire_many(&[pages_path,wal_path.as_path()]).map_err(map_lock_error)?;
  let mut pages_file=crate::page::open_existing_page_file_read_only_checked(pages_path)?;
  let mut wal=open_existing_wal_file_read_only(&wal_path)?;
  verify(&mut pages_file,&mut wal).map_err(JournalError::Io)?;
  validate_open_wal_path(&wal_path,&wal).map_err(JournalError::Io)?;
  if wal.metadata()?.len()!=HEADER {
   return Err(JournalError::Invalid("WAL publicado no está checkpointed"));
  }
  wal.seek(SeekFrom::Start(0))?;
  let mut header=[0u8;HEADER as usize];
  wal.read_exact(&mut header)?;
  if &header[..8]!=MAGIC || u32::from_le_bytes(header[8..12].try_into().unwrap())!=VERSION {
   return Err(JournalError::Corrupt("cabecera WAL publicada inválida"));
  }
  wal.seek(SeekFrom::Start(HEADER))?;
  let mut pages=PageFile::from_open_file(pages_path,pages_file)?;
  if pages.recovery_tail_page().is_some() {
   return Err(JournalError::Corrupt("MLPG publicado termina con una página parcial"));
  }
  for id in 0..pages.page_count(){ pages.read(id)?; }
  pages.validate_path_identity()?;
  validate_open_wal_path(&wal_path,&wal).map_err(JournalError::Io)?;
  Ok(Self{pages,wal,wal_path,next_tx:1,recovery_required:false,read_only:true,_locks:locks,session_lock_validator:None,#[cfg(test)] fail_apply_after_images:None})
 }

 fn open_internal<F>(
  pages_path:impl AsRef<Path>,
  wal_path:impl AsRef<Path>,
  existing_only:bool,
  verify:F,
  session_lock_validator:Option<SessionLockValidator>,
 )->Result<Self,JournalError>
 where F:FnOnce(&mut File,&mut File)->io::Result<()> {
  let pages_path=pages_path.as_ref();
  let wal_path=wal_path.as_ref().to_path_buf();
  let pages_lock_path=crate::interprocess_lock::lock_path_for(pages_path).map_err(map_lock_error)?;
  let wal_lock_path=crate::interprocess_lock::lock_path_for(&wal_path).map_err(map_lock_error)?;
  if pages_lock_path==wal_lock_path {
   return Err(JournalError::Invalid("el archivo de páginas y el WAL deben ser rutas distintas"));
  }
  let locks=InterprocessLock::acquire_many(&[pages_path,wal_path.as_path()]).map_err(map_lock_error)?;
  let mut pages_file=if existing_only {
   crate::page::open_existing_page_file_checked(pages_path)?
  } else { crate::page::open_page_file_checked(pages_path)? };
  let mut wal=if existing_only {
   open_existing_wal_file(&wal_path)?
  } else { open_wal_file(&wal_path)? };
  verify(&mut pages_file,&mut wal).map_err(JournalError::Io)?;
  if let Some(validator)=&session_lock_validator { validator.validate().map_err(|_|JournalError::Invalid("bloqueo de sesión inválido"))?; }
  validate_open_wal_path(&wal_path,&wal).map_err(JournalError::Io)?;
  let mut pages=PageFile::from_open_file(pages_path,pages_file)?;
  if let Some(validator)=&session_lock_validator { validator.validate().map_err(|_|JournalError::Invalid("bloqueo de sesión inválido"))?; }
  ensure_wal_header(&mut wal, || {
   if let Some(validator)=&session_lock_validator {
    validator.validate().map_err(|_|JournalError::Invalid("bloqueo de sesión inválido"))?;
   }
   Ok(())
  })?;
  if let Some(validator)=&session_lock_validator { validator.validate().map_err(|_|JournalError::Invalid("bloqueo de sesión inválido"))?; }
  let (next_tx,valid_end)=recover_with_interpass(&mut wal,&mut pages,|_| {
   if let Some(validator)=&session_lock_validator {
    validator.validate().map_err(|_|JournalError::Invalid("bloqueo de sesión inválido"))?;
   }
   Ok(())
  })?;
  if let Some(torn_page)=pages.recovery_tail_page(){
   if pages.page_count()<=torn_page{
    return Err(JournalError::Corrupt("página final incompleta sin imagen WAL confirmada para reconstruirla"));
   }
  }
  if let Some(validator)=&session_lock_validator { validator.validate().map_err(|_|JournalError::Invalid("bloqueo de sesión inválido"))?; }
  let len=wal.metadata()?.len();
  if valid_end<len {
   if let Some(validator)=&session_lock_validator { validator.validate().map_err(|_|JournalError::Invalid("bloqueo de sesión inválido"))?; }
   wal.set_len(valid_end)?;
   if let Some(validator)=&session_lock_validator { validator.validate().map_err(|_|JournalError::Invalid("bloqueo de sesión inválido"))?; }
   wal.sync_all()?;
  }
  for id in 0..pages.page_count(){ pages.read(id)?; }
  if let Some(validator)=&session_lock_validator { validator.validate().map_err(|_|JournalError::Invalid("bloqueo de sesión inválido"))?; }
  pages.sync()?;
  wal.seek(SeekFrom::End(0))?;
  Ok(Self{pages,wal,wal_path,next_tx,recovery_required:false,read_only:false,_locks:locks,session_lock_validator,#[cfg(test)] fail_apply_after_images:None})
 }
 pub fn page_count(&self)->u64{self.pages.page_count()}
 pub(crate) fn attach_session_lock_validator(&mut self,validator:SessionLockValidator)->Result<(),JournalError>{
  validator.validate().map_err(|_|JournalError::Invalid("bloqueo de sesión inválido"))?;
  self.session_lock_validator=Some(validator);
  Ok(())
 }
 fn validate_locks(&self)->Result<(),JournalError>{
  for lock in &self._locks { lock.validate_identity().map_err(map_lock_error)?; }
  if let Some(validator)=&self.session_lock_validator {
   validator.validate().map_err(|_|JournalError::Invalid("bloqueo de sesión inválido"))?;
  }
  Ok(())
 }
 fn validate_paths(&self)->Result<(),JournalError>{
  self.pages.validate_path_identity()?;
  validate_open_wal_path(&self.wal_path,&self.wal).map_err(JournalError::Io)?;
  Ok(())
 }
 pub fn read(&mut self,page_id:u64)->Result<crate::page::Page,JournalError>{
  if self.recovery_required{return Err(JournalError::Invalid("se requiere cerrar y reabrir para completar recovery"));}
  Ok(self.pages.read(page_id)?)
 }
 pub fn pages_path(&self)->&Path{self.pages.path()}
 pub fn wal_path(&self)->&Path{&self.wal_path}
 #[cfg(test)]
 pub(crate) fn inject_apply_failure_after_images(&mut self,count:usize){self.fail_apply_after_images=Some(count);}

 /// Consolida el WAL después de asegurar que todas las páginas confirmadas son durables.
 /// El truncado conserva intacta la cabecera: si se interrumpe, redo sigue siendo seguro
 /// porque las páginas ya fueron sincronizadas antes de reducir el diario.
 pub fn checkpoint(&mut self)->Result<(),JournalError>{
  if self.read_only{return Err(JournalError::Invalid("almacén publicado de solo lectura"));}
  self.validate_locks()?;
  self.checkpoint_with(|wal|{
   wal.set_len(HEADER)?;
   wal.seek(SeekFrom::Start(HEADER))?;
   wal.sync_all()?;
   Ok(())
  })
 }

 fn checkpoint_with<F>(&mut self,finalize:F)->Result<(),JournalError>
 where F:FnOnce(&mut File)->Result<(),JournalError>{
  self.checkpoint_with_sync(|pages|pages.sync().map_err(JournalError::Page),finalize)
 }

 fn checkpoint_with_sync<S,F>(&mut self,sync_pages:S,finalize:F)->Result<(),JournalError>
 where S:FnOnce(&mut PageFile)->Result<(),JournalError>,
       F:FnOnce(&mut File)->Result<(),JournalError>{
  if self.recovery_required{return Err(JournalError::Invalid("se requiere cerrar y reabrir para completar recovery"));}
  // Antes de retirar el WAL, comprobar que ninguna página consolidada esté dañada.
  // Si falla, el diario permanece intacto y una reapertura aún puede hacer redo.
  for page_id in 0..self.pages.page_count(){self.pages.read(page_id)?;}
  // Revalidar antes de persistir páginas durante el mantenimiento.
  self.validate_locks()?;
  self.validate_paths()?;
  // El WAL no se modifica hasta que todas las páginas confirmadas sean durables.
  sync_pages(&mut self.pages)?;
  // Revalidar después del sync de páginas y justo antes de truncar el WAL:
  // una sustitución durante el checkpoint no debe permitir retirar el diario.
  self.validate_locks()?;
  self.validate_paths()?;
  // Desde el primer intento de modificar el WAL, cualquier error es ambiguo:
  // no se puede seguir escribiendo ni reutilizar IDs hasta reabrir y recuperar.
  if let Err(error)=finalize(&mut self.wal){
   self.recovery_required=true;
   return Err(error);
  }
  self.next_tx=1;
  Ok(())
 }

 /// Ejecuta cambios de varias páginas en una sola transacción durable.
 /// Devuelve los IDs asignados a las operaciones Allocate, en su orden.
 pub fn transaction(&mut self, changes:Vec<PageChange>)->Result<Vec<u64>,JournalError>{
  if self.read_only{return Err(JournalError::Invalid("almacén publicado de solo lectura"));}
  self.validate_locks()?;
  if self.recovery_required{return Err(JournalError::Invalid("se requiere cerrar y reabrir para completar recovery"));}
  if changes.is_empty(){return Err(JournalError::Invalid("transacción vacía"));}
  if changes.len()>MAX_IMAGES_PER_TX{return Err(JournalError::Invalid("demasiadas imágenes en una transacción"));}
  if transaction_encoded_size(changes.iter().map(|change|match change{PageChange::Allocate{payload,..}|PageChange::Overwrite{payload,..}=>payload.len()})).is_none(){return Err(JournalError::Invalid("transacción excede el límite de bytes"));}
  let mut images=Vec::with_capacity(changes.len());
  let mut allocated=Vec::new();
  let mut next_page=self.pages.page_count();
  let mut touched=BTreeSet::new();
  for change in changes {
   let image=match change {
    PageChange::Allocate{generation,payload}=>{
     let id=next_page;
     next_page=next_page.checked_add(1).ok_or(JournalError::Invalid("IDs de página agotados"))?;
     allocated.push(id);
     Image{page_id:id,expected_generation:None,generation,payload}
    }
    PageChange::Overwrite{page_id,expected_generation,new_generation,payload}=>{
     if new_generation<=expected_generation{return Err(JournalError::Invalid("la nueva generación debe ser mayor"));}
     let current=self.pages.read(page_id)?;
     if current.generation!=expected_generation{return Err(JournalError::Invalid("generación actual inesperada"));}
     Image{page_id,expected_generation:Some(expected_generation),generation:new_generation,payload}
    }
   };
   if image.payload.len()>MAX_PAYLOAD{return Err(JournalError::Invalid("payload excede capacidad MLPG"));}
   if !touched.insert(image.page_id){return Err(JournalError::Invalid("una página aparece más de una vez en la transacción"));}
   images.push(image);
  }
  validate_shape(&images).map_err(|_|JournalError::Invalid("secuencia de páginas inválida"))?;
  self.commit_images(images)?;
  Ok(allocated)
 }

 /// Compatibilidad: añade una página y devuelve su ID.
 pub fn allocate(&mut self,generation:u64,payload:&[u8])->Result<u64,JournalError>{
  self.transaction(vec![PageChange::Allocate{generation,payload:payload.to_vec()}])?
   .into_iter().next().ok_or(JournalError::Corrupt("asignación sin ID"))
 }
 /// Compatibilidad: sustituye una página si conserva la generación esperada.
 pub fn overwrite(&mut self,page_id:u64,expected_generation:u64,new_generation:u64,payload:&[u8])->Result<(),JournalError>{
  self.transaction(vec![PageChange::Overwrite{page_id,expected_generation,new_generation,payload:payload.to_vec()}])?;
  Ok(())
 }

 fn commit_images(&mut self,images:Vec<Image>)->Result<(),JournalError>{
  #[cfg(test)]
  if let Some(applied_count)=self.fail_apply_after_images.take(){
   return self.commit_images_with_apply(
    images,
    |wal,tx,encoded|persist_transaction(wal,tx,encoded),
    |pages,images|{
     for image in images.iter().take(applied_count){apply_image(pages,image)?;}
     Err(JournalError::Page(PageError::Io(io::Error::new(
      io::ErrorKind::Other,"fallo de apply inyectado después del COMMIT durable"
     ))))
    }
   );
  }
  self.commit_images_with_apply(images,|wal,tx,encoded|persist_transaction(wal,tx,encoded),|pages,images|apply_transaction(pages,images))
 }
 fn commit_images_with<F>(&mut self,images:Vec<Image>,persist:F)->Result<(),JournalError>
 where F:FnOnce(&mut File,u64,&[Vec<u8>])->Result<(),JournalError>{
  self.commit_images_with_apply(images,persist,|pages,images|apply_transaction(pages,images))
 }
 fn commit_images_with_apply<F,A>(&mut self,images:Vec<Image>,persist:F,apply:A)->Result<(),JournalError>
 where F:FnOnce(&mut File,u64,&[Vec<u8>])->Result<(),JournalError>,
       A:FnOnce(&mut PageFile,&[Image])->Result<(),JournalError>{
  let tx=self.next_tx;
  let following=tx.checked_add(1).ok_or(JournalError::Corrupt("contador de transacciones agotado"))?;
  // Serializar todo antes de tocar el WAL: errores de validación no dejan frames parciales.
  let encoded:Vec<Vec<u8>>=images.iter().map(encode_image).collect::<Result<_,_>>()?;
  // Validación final tras el staging completo y antes del primer byte WAL.
  self.validate_locks()?;
  self.validate_paths()?;
  self.wal.seek(SeekFrom::End(0))?;
  // Comprobar de nuevo tras posicionar el descriptor y justo antes del primer frame.
  self.validate_paths()?;
  let result=persist(&mut self.wal,tx,&encoded);
  if let Err(e)=result {
   // Tras tocar el WAL, un error de escritura o sync deja incierto qué bytes
   // llegaron al almacenamiento estable. No truncar ni reutilizar el txid:
   // cerrar y reabrir permite decidir según los frames realmente persistidos.
   self.recovery_required=true;
   return Err(e);
  }
  // Desde aquí la transacción está confirmada: no se reutiliza su txid aunque falle el apply.
  self.next_tx=following;
  if let Err(e)=apply(&mut self.pages,&images){self.recovery_required=true;return Err(e);}
  Ok(())
 }
}

fn ensure_wal_header<F>(wal:&mut File,mut validate_session:F)->Result<(),JournalError>
where F:FnMut()->Result<(),JournalError>{
 let mut expected=[0u8;HEADER as usize];
 expected[..8].copy_from_slice(MAGIC);
 expected[8..12].copy_from_slice(&VERSION.to_le_bytes());
 let len=wal.metadata()?.len();
 if len>=HEADER{return Ok(());}
 let mut prefix=vec![0u8;len as usize];
 wal.seek(SeekFrom::Start(0))?;
 wal.read_exact(&mut prefix)?;
 if prefix!=expected[..prefix.len()] {
  return Err(JournalError::Corrupt("cabecera WAL incompleta o inválida"));
 }
 // Un prefijo válido solo puede proceder de la creación interrumpida del
 // diario: todavía no podía existir ninguna transacción confirmada.
 validate_session()?;
 wal.set_len(0)?;
 wal.seek(SeekFrom::Start(0))?;
 validate_session()?;
 wal.write_all(&expected)?;
 validate_session()?;
 wal.sync_all()?;
 Ok(())
}
fn add_image_encoded_size(current:usize,payload_len:usize)->Option<usize> {
 if payload_len>MAX_PAYLOAD{return None;}
 let total=current.checked_add(FRAME_HEADER+28+payload_len)?;
 if total>MAX_TRANSACTION_BYTES{return None;}
 Some(total)
}
fn transaction_encoded_size(payload_lengths:impl IntoIterator<Item=usize>)->Option<usize> {
 payload_lengths.into_iter().try_fold(2*FRAME_HEADER,add_image_encoded_size)
}
fn validate_shape(images:&[Image])->Result<(),JournalError>{
 if images.is_empty()||images.len()>MAX_IMAGES_PER_TX{return Err(JournalError::Corrupt("cantidad de imágenes inválida"));}
 if transaction_encoded_size(images.iter().map(|image|image.payload.len())).is_none(){return Err(JournalError::Corrupt("transacción excede el límite de bytes"));}
 let mut ids=BTreeSet::new();
 let mut allocations=Vec::new();
 for i in images {
  if i.payload.len()>MAX_PAYLOAD{return Err(JournalError::Corrupt("payload excede capacidad MLPG"));}
  if !ids.insert(i.page_id){return Err(JournalError::Corrupt("page_id duplicado en transacción"));}
  match i.expected_generation {
   None=>allocations.push(i.page_id),
   Some(g) if i.generation>g=>{},
   Some(_)=>return Err(JournalError::Corrupt("generación no creciente")),
  }
 }
 allocations.sort_unstable();
 for pair in allocations.windows(2) {
  if pair[1]!=pair[0].checked_add(1).ok_or(JournalError::Corrupt("ID de página agotado"))? {
   return Err(JournalError::Corrupt("asignaciones no contiguas"));
  }
 }
 Ok(())
}
fn encode_image(i:&Image)->Result<Vec<u8>,JournalError>{
 if i.payload.len()>MAX_PAYLOAD{return Err(JournalError::Invalid("payload excede capacidad MLPG"));}
 let mut b=Vec::with_capacity(28+i.payload.len());
 b.extend_from_slice(&i.page_id.to_le_bytes());
 b.extend_from_slice(&i.expected_generation.unwrap_or(NO_GENERATION).to_le_bytes());
 b.extend_from_slice(&i.generation.to_le_bytes());
 b.extend_from_slice(&(i.payload.len() as u32).to_le_bytes());
 b.extend_from_slice(&i.payload);
 Ok(b)
}
fn decode_image(b:&[u8])->Result<Image,JournalError>{
 if b.len()<28{return Err(JournalError::Corrupt("imagen truncada"));}
 let id=u64::from_le_bytes(b[0..8].try_into().unwrap());
 let expected=u64::from_le_bytes(b[8..16].try_into().unwrap());
 let generation=u64::from_le_bytes(b[16..24].try_into().unwrap());
 let len=u32::from_le_bytes(b[24..28].try_into().unwrap()) as usize;
 if len>MAX_PAYLOAD||b.len()!=28+len{return Err(JournalError::Corrupt("longitud de imagen inválida"));}
 if expected!=NO_GENERATION&&generation<=expected{return Err(JournalError::Corrupt("generación no creciente"));}
 Ok(Image{page_id:id,expected_generation:if expected==NO_GENERATION{None}else{Some(expected)},generation,payload:b[28..].to_vec()})
}
fn apply_transaction(pages:&mut PageFile,images:&[Image])->Result<(),JournalError>{
 validate_shape(images)?;
 // Aplicación ordenada: si el proceso cae a mitad, redo repetirá toda la lista.
 for i in images { apply_image(pages,i)?; }
 pages.sync()?;
 Ok(())
}
fn apply_image(pages:&mut PageFile,i:&Image)->Result<(),JournalError>{
 if i.page_id>=pages.page_count(){
  // Un write interrumpido puede dejar incompleta incluso una página que ya
  // existía. open_for_recovery descarta ese último bloque parcial; el WAL
  // confirmado es la fuente autoritativa para reconstruirlo, también en
  // sobrescrituras (expected_generation = Some).
  if i.page_id!=pages.page_count(){return Err(JournalError::Corrupt("secuencia de páginas no contigua"));}
  pages.recover_allocate(i.page_id,i.generation,&i.payload)?;
  return Ok(());
 }
 match pages.read(i.page_id){
  Ok(current) if current.generation==i.generation&&current.payload==i.payload=>Ok(()),
  Ok(current) if current.generation>i.generation=>Ok(()),
  Ok(current) if Some(current.generation)==i.expected_generation=>{
   pages.overwrite(i.page_id,i.generation,&i.payload)?;Ok(())
  }
  Ok(_)=>Err(JournalError::Corrupt("generación de página no coincide con WAL")),
  Err(PageError::Corrupt(_))=>{pages.repair_overwrite(i.page_id,i.generation,&i.payload)?;Ok(())},
  Err(e)=>Err(JournalError::Page(e)),
 }
}
fn fingerprint_update(mut hash:u64,bytes:&[u8])->u64 {
 for byte in bytes {
  hash^=*byte as u64;
  hash=hash.wrapping_mul(0x100000001b3);
 }
 hash
}
fn frame_fingerprint(hash:u64,header:&[u8;FRAME_HEADER],payload:&[u8])->u64 {
 fingerprint_update(fingerprint_update(hash,header),payload)
}
fn payload_fingerprint(payload:&[u8])->u64 {
 let mut hash=0xcbf29ce484222325u64;
 for byte in payload {
  hash^=*byte as u64;
  hash=hash.wrapping_mul(0x100000001b3);
 }
 hash
}
fn sum(kind:u8,tx:u64,payload:&[u8])->u32{
 let mut h=0x811c9dc5u32;
 for b in std::iter::once(kind).chain(tx.to_le_bytes()).chain(payload.iter().copied()){h^=b as u32;h=h.wrapping_mul(0x01000193);}
 h
}
fn write_frame<W:Write>(w:&mut W,kind:u8,tx:u64,payload:&[u8])->Result<(),JournalError>{
 if payload.len()>MAX_PAYLOAD+28{return Err(JournalError::Invalid("frame demasiado grande"));}
 w.write_all(FRAME)?;w.write_all(&[kind])?;w.write_all(&tx.to_le_bytes())?;
 w.write_all(&(payload.len() as u32).to_le_bytes())?;w.write_all(&sum(kind,tx,payload).to_le_bytes())?;w.write_all(payload)?;Ok(())
}
fn write_transaction_frames<W:Write>(wal:&mut W,tx:u64,encoded:&[Vec<u8>])->Result<(),JournalError>{
 write_frame(wal,BEGIN,tx,&[])?;
 for payload in encoded { write_frame(wal,IMAGE,tx,payload)?; }
 write_frame(wal,COMMIT,tx,&[])?;
 Ok(())
}
trait DurableWrite:Write { fn sync_durable(&mut self)->io::Result<()>; }
impl DurableWrite for File { fn sync_durable(&mut self)->io::Result<()>{self.sync_all()} }
fn persist_transaction<W:DurableWrite>(wal:&mut W,tx:u64,encoded:&[Vec<u8>])->Result<(),JournalError>{
 write_transaction_frames(wal,tx,encoded)?;
 wal.sync_durable()?;
 Ok(())
}
fn recover(wal:&mut File,pages:&mut PageFile)->Result<(u64,u64),JournalError>{
 recover_with_interpass(wal,pages,|_|Ok(()))
}
fn recover_with_interpass<F>(wal:&mut File,pages:&mut PageFile,mut between_passes:F)->Result<(u64,u64),JournalError>
where F:FnMut(&mut File)->Result<(),JournalError> {

 wal.seek(SeekFrom::Start(0))?;
 let mut header=[0u8;12];wal.read_exact(&mut header).map_err(|_|JournalError::Corrupt("cabecera incompleta"))?;
 if &header[..8]!=MAGIC{return Err(JournalError::Corrupt("magic inválido"));}
 if u32::from_le_bytes(header[8..12].try_into().unwrap())!=VERSION{return Err(JournalError::Corrupt("versión no soportada"));}
 let mut pending:Option<(u64,Vec<Image>,u64,usize,usize,bool)>=None;
 let mut committed_transaction_fingerprints=Vec::new();
 // Primero validar el WAL completo. Se conserva solo la última generación
 // confirmada por página; no se duplican los payloads históricos en memoria.
 // El redo de la imagen final comprueba también el payload exacto.
 let mut latest_committed_images:BTreeMap<u64,(u64,usize,u64)>=BTreeMap::new();
 let mut valid=HEADER;let mut max_tx=0u64;let mut last_committed_tx=0u64;
 macro_rules! invalid_frame {
  ($reason:expr) => {{
   // Esta macro solo se invoca después de leer el header completo y, cuando
   // corresponde, el payload completo. EOF parcial se maneja antes del match;
   // por tanto, cualquier frame inválido aquí es corrupción, incluso al final.
   return Err(JournalError::Corrupt($reason));
  }};
 }
 loop{
  let mut h=[0u8;FRAME_HEADER];
  match wal.read_exact(&mut h){Ok(())=>{},Err(e) if e.kind()==io::ErrorKind::UnexpectedEof=>break,Err(e)=>return Err(JournalError::Io(e))}
  if &h[..4]!=FRAME{invalid_frame!("frame inválido dentro del WAL");}
  let kind=h[4];let tx=u64::from_le_bytes(h[5..13].try_into().unwrap());
  let len=u32::from_le_bytes(h[13..17].try_into().unwrap()) as usize;
  let checksum=u32::from_le_bytes(h[17..21].try_into().unwrap());
  if len>MAX_PAYLOAD+28{invalid_frame!("longitud de frame inválida dentro del WAL");}
  let mut payload=vec![0u8;len];
  match wal.read_exact(&mut payload){
   Ok(())=>{},
   Err(e) if e.kind()==io::ErrorKind::UnexpectedEof=>break,
   Err(e)=>return Err(JournalError::Io(e)),
  }
  if sum(kind,tx,&payload)!=checksum{return Err(JournalError::Corrupt("checksum inválido en frame completo"));}
  match kind{
   BEGIN if payload.is_empty()&&pending.is_none()=>{
    let expected=max_tx.checked_add(1).ok_or(JournalError::Corrupt("contador de transacciones agotado"))?;
    if tx!=expected{invalid_frame!("secuencia de transacciones inválida dentro del WAL");}
    max_tx=tx;
    pending=Some((tx,Vec::new(),frame_fingerprint(0xcbf29ce484222325,&h,&payload),2*FRAME_HEADER,0,false));
   }
   IMAGE=>{
    let Some((pt,ref mut images,ref mut fingerprint,ref mut encoded_size,ref mut image_count,ref mut oversized))=pending else{invalid_frame!("IMAGE sin BEGIN dentro del WAL");};
    if pt!=tx{invalid_frame!("secuencia de imágenes inválida dentro del WAL");}
    *fingerprint=frame_fingerprint(*fingerprint,&h,&payload);
    let decoded=match decode_image(&payload){Ok(decoded)=>decoded,Err(_)=>invalid_frame!("imagen inválida dentro del WAL")};
    *image_count=image_count.checked_add(1).unwrap_or(usize::MAX);
    if *image_count>MAX_IMAGES_PER_TX {*oversized=true;}
    match add_image_encoded_size(*encoded_size,decoded.payload.len()) {
     Some(size)=>*encoded_size=size,
     None=>*oversized=true,
    }
    if !*oversized {images.push(decoded);}
   }
   COMMIT if payload.is_empty()=>{
    let Some((pt,images,fingerprint,_encoded_size,image_count,oversized))=pending.take() else{invalid_frame!("COMMIT sin BEGIN dentro del WAL");};
    if pt!=tx||oversized||image_count!=images.len()||validate_shape(&images).is_err(){invalid_frame!("transacción inválida dentro del WAL");}
    committed_transaction_fingerprints.push(frame_fingerprint(fingerprint,&h,&payload));
    for image in &images {
     latest_committed_images.insert(image.page_id,(image.generation,image.payload.len(),payload_fingerprint(&image.payload)));
    }
    last_committed_tx=tx;
    valid=wal.stream_position()?;
   }
   _=>invalid_frame!("tipo de frame o estado de transacción inválido dentro del WAL"),
  }
 }
 between_passes(wal)?;
 // Solo después de validar todos los frames se ejecuta redo. Se recorre
 // el WAL una segunda vez y se mantiene en memoria una sola transacción.
 wal.seek(SeekFrom::Start(HEADER))?;
 let mut redo_images=Vec::new();
 let mut redo_tx=None;
 let mut redo_fingerprint=0xcbf29ce484222325u64;
 let mut redo_encoded_size=2*FRAME_HEADER;
 let mut redo_transaction_index=0usize;
 let mut expected_redo_tx=1u64;
 while wal.stream_position()?<valid {
  let mut h=[0u8;FRAME_HEADER];
  wal.read_exact(&mut h)?;
  if &h[..4]!=FRAME{return Err(JournalError::Corrupt("frame inválido durante redo"));}
  let kind=h[4];
  let tx=u64::from_le_bytes(h[5..13].try_into().unwrap());
  let len=u32::from_le_bytes(h[13..17].try_into().unwrap()) as usize;
  let checksum=u32::from_le_bytes(h[17..21].try_into().unwrap());
  if len>MAX_PAYLOAD+28{return Err(JournalError::Corrupt("longitud inválida durante redo"));}
  let payload_end=wal.stream_position()?.checked_add(len as u64)
   .ok_or(JournalError::Corrupt("offset inválido durante redo"))?;
  if payload_end>valid{return Err(JournalError::Corrupt("frame excede el último COMMIT validado"));}
  let mut payload=vec![0u8;len];
  wal.read_exact(&mut payload)?;
  if sum(kind,tx,&payload)!=checksum{return Err(JournalError::Corrupt("checksum cambió durante redo"));}
  match kind {
   BEGIN if payload.is_empty()&&redo_tx.is_none()&&tx==expected_redo_tx=>{
    redo_images.clear();
    redo_fingerprint=frame_fingerprint(0xcbf29ce484222325,&h,&payload);
    redo_encoded_size=2*FRAME_HEADER;
    redo_tx=Some(tx);
   }
   IMAGE if redo_tx==Some(tx)=>{
    if redo_images.len()>=MAX_IMAGES_PER_TX{return Err(JournalError::Corrupt("demasiadas imágenes durante redo"));}
    redo_fingerprint=frame_fingerprint(redo_fingerprint,&h,&payload);
    let decoded=decode_image(&payload).map_err(|_|JournalError::Corrupt("imagen inválida durante redo"))?;
    redo_encoded_size=add_image_encoded_size(redo_encoded_size,decoded.payload.len())
     .ok_or(JournalError::Corrupt("transacción excede el límite de bytes durante redo"))?;
    redo_images.push(decoded);
   }
   COMMIT if payload.is_empty()&&redo_tx==Some(tx)=>{
    redo_fingerprint=frame_fingerprint(redo_fingerprint,&h,&payload);
    if committed_transaction_fingerprints.get(redo_transaction_index)!=Some(&redo_fingerprint) {
     return Err(JournalError::Corrupt("la transacción WAL cambió entre validación y redo"));
    }
    redo_transaction_index+=1;
    // Antes de aplicar, contrastar las imágenes finales con las huellas
    // capturadas en la primera pasada. Esto detecta cambios del WAL entre
    // pasadas sin conservar payloads completos en memoria.
    for image in &redo_images {
     if let Some((generation,length,fingerprint))=latest_committed_images.get(&image.page_id) {
      if image.generation==*generation
       && (image.payload.len()!=*length||payload_fingerprint(&image.payload)!=*fingerprint) {
       return Err(JournalError::Corrupt("la imagen final cambió entre pasadas de recovery"));
      }
     }
    }
    validate_shape(&redo_images).map_err(|_|JournalError::Corrupt("transacción inválida durante redo"))?;
    for image in &redo_images {
     between_passes(wal)?;
     if apply_image(pages,image).is_err(){
      return Err(JournalError::Corrupt("no se pudo completar redo de transacción confirmada"));
     }
    }
    between_passes(wal)?;
    pages.sync()?;
    redo_images.clear();
    redo_tx=None;
    expected_redo_tx=expected_redo_tx.checked_add(1)
     .ok_or(JournalError::Corrupt("contador de transacciones agotado durante redo"))?;
   }
   _=>return Err(JournalError::Corrupt("secuencia de frames inválida durante redo")),
  }
 }
 if redo_tx.is_some()||wal.stream_position()?!=valid||redo_transaction_index!=committed_transaction_fingerprints.len() {
  return Err(JournalError::Corrupt("redo no terminó en un límite COMMIT válido"));
 }
 // Una página puede estar adelantada respecto a un frame antiguo si una
 // transacción posterior ya se aplicó antes de la caída. Pero no puede
 // superar la última generación confirmada que el WAL conoce: aceptarlo
 // ocultaría una escritura ajena o una corrupción con checksum válido.
 for (page_id,(expected_generation,expected_length,expected_fingerprint)) in latest_committed_images {
  let current=pages.read(page_id)?;
  if current.generation!=expected_generation
   || current.payload.len()!=expected_length
   || payload_fingerprint(&current.payload)!=expected_fingerprint {
   return Err(JournalError::Corrupt("la página física no coincide con su última imagen WAL confirmada"));
  }
 }
 Ok((last_committed_tx.checked_add(1).ok_or(JournalError::Corrupt("contador de transacciones agotado"))?,valid))
}

#[cfg(test)]
mod tests{
 use super::*;
 use std::time::{SystemTime,UNIX_EPOCH};
 fn paths()->(PathBuf,PathBuf){let n=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();let b=std::env::temp_dir().join(format!("mlpj-{}-{n}",std::process::id()));(b.with_extension("pages"),b.with_extension("wal"))}
 fn cleanup(p:PathBuf,w:PathBuf){
  for path in [p,w] {
   let _=std::fs::remove_file(&path);
   if let Some(name)=path.file_name() {
    let mut lock_name=name.to_os_string();
    lock_name.push(".mldb-lock");
    let _=std::fs::remove_file(path.with_file_name(lock_name));
   }
  }
 }
 #[test]
 fn wal_header_repair_checks_session_before_truncating_partial_header(){
  let (pages,wal_path)=paths();
  let prefix=MAGIC[..4].to_vec();
  std::fs::write(&wal_path,&prefix).unwrap();
  let mut wal=OpenOptions::new().read(true).write(true).open(&wal_path).unwrap();
  let result=ensure_wal_header(&mut wal,||{
   Err(JournalError::Invalid("bloqueo de sesión inválido"))
  });
  assert!(matches!(result,Err(JournalError::Invalid("bloqueo de sesión inválido"))));
  assert_eq!(std::fs::read(&wal_path).unwrap(),prefix);
  drop(wal);
  cleanup(pages,wal_path);
 }

 #[cfg(unix)]
 #[cfg(unix)]
 #[test]
 fn verified_open_rejects_path_replacement_after_descriptor_open(){
  let (pages,wal)=paths();
  {
   let mut store=DurablePages::open(&pages,&wal).unwrap();
   store.allocate(1,b"original-page").unwrap();
   store.checkpoint().unwrap();
  }
  let saved=pages.with_extension("saved");
  let original=std::fs::read(&pages).unwrap();
  let result=DurablePages::open_with_pre_recovery_verification(
   &pages,&wal,
   |_,_|{
    std::fs::rename(&pages,&saved)?;
    std::fs::write(&pages,b"replacement")?;
    Ok(())
   }
  );
  assert!(result.is_err());
  assert_eq!(std::fs::read(&saved).unwrap(),original);
  assert_eq!(std::fs::read(&pages).unwrap(),b"replacement");
  let _=std::fs::remove_file(saved);
  cleanup(pages,wal);
 }

 #[cfg(unix)]
 #[test]
 fn verified_open_rejects_wal_path_replacement_after_descriptor_open(){
  let (pages,wal)=paths();
  {
   let mut store=DurablePages::open(&pages,&wal).unwrap();
   store.allocate(1,b"original-page").unwrap();
   store.checkpoint().unwrap();
  }
  let saved=wal.with_extension("saved");
  let original=std::fs::read(&wal).unwrap();
  let result=DurablePages::open_with_pre_recovery_verification(
   &pages,&wal,
   |_,_|{
    std::fs::rename(&wal,&saved)?;
    std::fs::write(&wal,b"replacement")?;
    Ok(())
   }
  );
  assert!(result.is_err());
  assert_eq!(std::fs::read(&saved).unwrap(),original);
  assert_eq!(std::fs::read(&wal).unwrap(),b"replacement");
  let _=std::fs::remove_file(saved);
  cleanup(pages,wal);
 }

 fn durable_pages_open_rejects_symbolic_link_wal_file() {
  use std::os::unix::fs::symlink;
  let (pages, wal) = paths();
  let target = wal.with_extension("external");
  std::fs::write(&target, []).unwrap();
  symlink(&target, &wal).unwrap();
  assert!(matches!(
   DurablePages::open(&pages, &wal),
   Err(JournalError::Io(error)) if error.kind() == io::ErrorKind::InvalidInput
  ));
  cleanup(pages, wal);
  let _ = std::fs::remove_file(target);
 }

 #[cfg(unix)]
 #[test]
 fn newly_created_database_wal_and_lock_files_are_owner_only() {
  use std::os::unix::fs::PermissionsExt;
  let (pages, wal) = paths();
  {
   let _db = DurablePages::open(&pages, &wal).unwrap();
  }
  let mut lock = pages.as_os_str().to_os_string();
  lock.push(".mldb-lock");
  let lock_path = PathBuf::from(lock);
  for path in [&pages, &wal, &lock_path] {
   let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
   assert_eq!(mode & 0o077, 0, "grupo u otros pueden acceder a {}", path.display());
  }
  cleanup(pages, wal);
 }

 #[test]
 fn transaction_byte_limit_accepts_exact_capacity_and_rejects_one_over() {
  let per_image=FRAME_HEADER+28+MAX_PAYLOAD;
  let exact_count=(MAX_TRANSACTION_BYTES-2*FRAME_HEADER)/per_image;
  let exact_remainder=MAX_TRANSACTION_BYTES-2*FRAME_HEADER-exact_count*per_image;
  let exact_lengths=std::iter::repeat(MAX_PAYLOAD).take(exact_count)
   .chain(std::iter::once(exact_remainder-FRAME_HEADER-28));
  assert_eq!(transaction_encoded_size(exact_lengths),Some(MAX_TRANSACTION_BYTES));
  let over_lengths=std::iter::repeat(MAX_PAYLOAD).take(exact_count)
   .chain(std::iter::once(exact_remainder-FRAME_HEADER-28+1));
  assert_eq!(transaction_encoded_size(over_lengths),None);
  assert_eq!(transaction_encoded_size([MAX_PAYLOAD+1]),None);
 }

 #[test]
 fn oversized_transaction_is_rejected_before_wal_and_store_remains_usable() {
  let (p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   let wal_before=std::fs::read(&w).unwrap();
   let changes=(0..MAX_IMAGES_PER_TX).map(|_|PageChange::Allocate{
    generation:1,payload:vec![0x5a;MAX_PAYLOAD]
   }).collect();
   assert!(matches!(db.transaction(changes),Err(JournalError::Invalid("transacción excede el límite de bytes"))));
   assert_eq!(std::fs::read(&w).unwrap(),wal_before);
   assert_eq!(db.page_count(),0);
   assert_eq!(db.allocate(1,b"still-usable").unwrap(),0);
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.read(0).unwrap().payload,b"still-usable");
  }
  cleanup(p,w);
 }

 #[test]
 fn oversized_incomplete_tail_is_discarded_without_rejecting_prior_commit() {
  let (p,w)=paths();
  let committed_len;
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"committed-before-oversized-tail").unwrap();
   committed_len=std::fs::metadata(&w).unwrap().len();
  }
  {
   let mut wal=OpenOptions::new().append(true).open(&w).unwrap();
   write_frame(&mut wal,BEGIN,2,&[]).unwrap();
   let image=Image{page_id:1,expected_generation:None,generation:1,payload:Vec::new()};
   let encoded=encode_image(&image).unwrap();
   for _ in 0..=MAX_IMAGES_PER_TX {
    write_frame(&mut wal,IMAGE,2,&encoded).unwrap();
   }
   wal.sync_all().unwrap();
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),1);
   assert_eq!(db.read(0).unwrap().payload,b"committed-before-oversized-tail");
   assert_eq!(std::fs::metadata(&w).unwrap().len(),committed_len);
   assert_eq!(db.allocate(1,b"after-discard").unwrap(),1);
  }
  cleanup(p,w);
 }

 #[test]
 fn open_repairs_valid_partial_wal_header_from_interrupted_initialization() {
  let (p,w)=paths();
  {
   let mut wal=OpenOptions::new().write(true).create(true).open(&w).unwrap();
   wal.write_all(&MAGIC[..5]).unwrap();
   wal.sync_all().unwrap();
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(std::fs::read(&w).unwrap(),[MAGIC.as_slice(),&VERSION.to_le_bytes()].concat());
   db.allocate(1,b"usable-after-header-repair").unwrap();
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.read(0).unwrap().payload,b"usable-after-header-repair");
  }
  cleanup(p,w);
 }

 #[test]
 fn open_rejects_invalid_partial_wal_header_without_modifying_it() {
  let (p,w)=paths();
  let invalid=b"BAD";
  std::fs::write(&w,invalid).unwrap();
  assert!(matches!(DurablePages::open(&p,&w),Err(JournalError::Corrupt("cabecera WAL incompleta o inválida"))));
  assert_eq!(std::fs::read(&w).unwrap(),invalid);
  cleanup(p,w);
 }

 #[test]fn open_rejects_same_path_for_pages_and_wal(){
  let(p,w)=paths();
  assert!(matches!(
   DurablePages::open(&p,&p),
   Err(JournalError::Invalid("el archivo de páginas y el WAL deben ser rutas distintas"))
  ));
  let alias=p.parent().unwrap().join(".").join(p.file_name().unwrap());
  assert!(matches!(
   DurablePages::open(&p,&alias),
   Err(JournalError::Invalid("el archivo de páginas y el WAL deben ser rutas distintas"))
  ));
  cleanup(p,w);
 }

 #[test]fn second_page_store_open_is_rejected_while_first_is_alive(){
  let(p,w)=paths();
  let first=DurablePages::open(&p,&w).unwrap();
  assert!(matches!(DurablePages::open(&p,&w),Err(JournalError::AlreadyLocked)));
  drop(first);
  let second=DurablePages::open(&p,&w).unwrap();
  drop(second);
  cleanup(p.clone(),w.clone());
  for path in [p,w] { let mut name=path.file_name().unwrap().to_os_string();name.push(".mldb-lock");let _=std::fs::remove_file(path.with_file_name(name)); }
 }
 #[cfg(unix)]
 #[test]
 fn transaction_fails_closed_if_active_lockfile_is_replaced(){
  let(p,w)=paths();
  let displaced;
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   let wal_before=std::fs::read(&w).unwrap();
   let lock_path=crate::interprocess_lock::lock_path_for(&p).unwrap();
   displaced=lock_path.with_extension("displaced");
   std::fs::rename(&lock_path,&displaced).unwrap();
   use std::os::unix::fs::OpenOptionsExt;
   let mut replacement=OpenOptions::new().write(true).create_new(true).mode(0o600).open(&lock_path).unwrap();
   replacement.sync_all().unwrap();
   assert!(db.transaction(vec![PageChange::Allocate{generation:1,payload:b"must-not-write".to_vec()}]).is_err());
   assert_eq!(std::fs::read(&w).unwrap(),wal_before);
  }
  let lock_path=crate::interprocess_lock::lock_path_for(&p).unwrap();
  let _=std::fs::remove_file(lock_path);
  let _=std::fs::remove_file(displaced);
  cleanup(p,w);
 }

 #[cfg(unix)]
 #[test]
 fn checkpoint_fails_closed_if_active_lockfile_is_replaced(){
  let(p,w)=paths();
  let displaced;
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"durable-before-checkpoint").unwrap();
   let wal_before=std::fs::read(&w).unwrap();
   let lock_path=crate::interprocess_lock::lock_path_for(&w).unwrap();
   displaced=lock_path.with_extension("displaced");
   std::fs::rename(&lock_path,&displaced).unwrap();
   use std::os::unix::fs::OpenOptionsExt;
   let replacement=OpenOptions::new().write(true).create_new(true).mode(0o600).open(&lock_path).unwrap();
   replacement.sync_all().unwrap();
   assert!(db.checkpoint().is_err());
   assert_eq!(std::fs::read(&w).unwrap(),wal_before);
  }
  let lock_path=crate::interprocess_lock::lock_path_for(&w).unwrap();
  let _=std::fs::remove_file(lock_path);
  let _=std::fs::remove_file(displaced);
  cleanup(p,w);
 }

 #[cfg(unix)]
 #[test]
 fn transaction_rejects_pages_path_replacement_before_wal_append(){
  let(p,w)=paths();
  let displaced=p.with_extension("displaced");
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"stable-page").unwrap();
   db.checkpoint().unwrap();
   let pages_before=std::fs::read(&p).unwrap();
   let wal_before=std::fs::read(&w).unwrap();
   std::fs::rename(&p,&displaced).unwrap();
   std::fs::write(&p,b"replacement-pages").unwrap();
   assert!(db.transaction(vec![PageChange::Allocate{generation:2,payload:b"must-not-commit".to_vec()}]).is_err());
   assert_eq!(std::fs::read(&w).unwrap(),wal_before);
   assert_eq!(std::fs::read(&displaced).unwrap(),pages_before);
   assert_eq!(std::fs::read(&p).unwrap(),b"replacement-pages");
  }
  let _=std::fs::remove_file(displaced);
  cleanup(p,w);
 }

 #[cfg(unix)]
 #[test]
 fn transaction_rejects_wal_path_replacement_before_append(){
  let(p,w)=paths();
  let displaced=w.with_extension("displaced");
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"stable-page").unwrap();
   db.checkpoint().unwrap();
   let pages_before=std::fs::read(&p).unwrap();
   let wal_before=std::fs::read(&w).unwrap();
   std::fs::rename(&w,&displaced).unwrap();
   std::fs::write(&w,b"replacement-wal").unwrap();
   assert!(db.transaction(vec![PageChange::Allocate{generation:2,payload:b"must-not-commit".to_vec()}]).is_err());
   assert_eq!(std::fs::read(&displaced).unwrap(),wal_before);
   assert_eq!(std::fs::read(&p).unwrap(),pages_before);
   assert_eq!(std::fs::read(&w).unwrap(),b"replacement-wal");
  }
  let _=std::fs::remove_file(displaced);
  cleanup(p,w);
 }

 #[cfg(unix)]
 #[test]
 fn checkpoint_rejects_pages_path_replacement_before_wal_truncation(){
  let(p,w)=paths();
  let displaced=p.with_extension("displaced");
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"checkpoint-page").unwrap();
   let pages_before=std::fs::read(&p).unwrap();
   let wal_before=std::fs::read(&w).unwrap();
   std::fs::rename(&p,&displaced).unwrap();
   std::fs::write(&p,b"replacement-pages").unwrap();
   assert!(db.checkpoint().is_err());
   assert_eq!(std::fs::read(&w).unwrap(),wal_before);
   assert_eq!(std::fs::read(&displaced).unwrap(),pages_before);
  }
  let _=std::fs::remove_file(displaced);
  cleanup(p,w);
 }

 #[cfg(unix)]
 #[test]
 fn checkpoint_rejects_wal_path_replacement_before_truncation(){
  let(p,w)=paths();
  let displaced=w.with_extension("displaced");
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"checkpoint-page").unwrap();
   let pages_before=std::fs::read(&p).unwrap();
   let wal_before=std::fs::read(&w).unwrap();
   std::fs::rename(&w,&displaced).unwrap();
   std::fs::write(&w,b"replacement-wal").unwrap();
   assert!(db.checkpoint().is_err());
   assert_eq!(std::fs::read(&displaced).unwrap(),wal_before);
   assert_eq!(std::fs::read(&p).unwrap(),pages_before);
   assert_eq!(std::fs::read(&w).unwrap(),b"replacement-wal");
  }
  let _=std::fs::remove_file(displaced);
  cleanup(p,w);
 }

 #[test]fn redo_is_idempotent_when_later_committed_generation_is_already_on_disk(){
  let(p,w)=paths();
  {
   let mut wal=OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();wal.write_all(&VERSION.to_le_bytes()).unwrap();
   let first=Image{page_id:0,expected_generation:None,generation:1,payload:b"generation-one".to_vec()};
   let second=Image{page_id:0,expected_generation:Some(1),generation:2,payload:b"generation-two".to_vec()};
   write_transaction_frames(&mut wal,1,&[encode_image(&first).unwrap()]).unwrap();
   write_transaction_frames(&mut wal,2,&[encode_image(&second).unwrap()]).unwrap();
   wal.sync_all().unwrap();
  }
  // Estado físico más adelantado que el primer frame: caída tras aplicar
  // ambas transacciones sin haber limpiado el WAL.
  {
   let mut pages=PageFile::open_for_recovery(&p).unwrap();
   pages.recover_allocate(0,2,b"generation-two").unwrap();
   pages.sync().unwrap();
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   let page=db.read(0).unwrap();
   assert_eq!(page.generation,2);
   assert_eq!(page.payload,b"generation-two");
   db.overwrite(0,2,3,b"generation-three").unwrap();
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.read(0).unwrap().payload,b"generation-three");
  }
  cleanup(p,w);
 }

 #[test]
 fn recovery_reopens_after_interruption_between_page_redo_images(){
  let(p,w)=paths();
  {
   let mut wal=OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();wal.write_all(&VERSION.to_le_bytes()).unwrap();
   let first=Image{page_id:0,expected_generation:None,generation:1,payload:b"first-page".to_vec()};
   let second=Image{page_id:1,expected_generation:None,generation:1,payload:b"second-page".to_vec()};
   write_transaction_frames(&mut wal,1,&[encode_image(&first).unwrap(),encode_image(&second).unwrap()]).unwrap();
   wal.sync_all().unwrap();
  }
  {
   let mut wal=OpenOptions::new().read(true).write(true).open(&w).unwrap();
   let mut pages=PageFile::open_for_recovery(&p).unwrap();
   let mut checks=0;
   let interrupted=recover_with_interpass(&mut wal,&mut pages,|_|{
    checks+=1;
    if checks==3 { Err(JournalError::Invalid("interrupción simulada durante redo")) }
    else { Ok(()) }
   });
   assert!(matches!(interrupted,Err(JournalError::Invalid("interrupción simulada durante redo"))));
   assert_eq!(pages.read(0).unwrap().payload,b"first-page");
   assert!(matches!(pages.read(1),Err(PageError::Invalid("page_id fuera del archivo"))));
  }
  // La siguiente apertura repite redo de forma idempotente y completa la transacción.
  {
   let db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),2);
   assert_eq!(db.read(0).unwrap().payload,b"first-page");
   assert_eq!(db.read(1).unwrap().payload,b"second-page");
  }
  cleanup(p,w);
 }

 #[test]
 fn recovery_reopens_after_redo_before_torn_wal_tail_truncation(){
  let(p,w)=paths();
  let committed_end;
  {
   let mut wal=OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();wal.write_all(&VERSION.to_le_bytes()).unwrap();
   let image=Image{page_id:0,expected_generation:None,generation:1,payload:b"committed-page".to_vec()};
   write_transaction_frames(&mut wal,1,&[encode_image(&image).unwrap()]).unwrap();
   committed_end=wal.stream_position().unwrap();
   write_frame(&mut wal,BEGIN,2,&[]).unwrap();
   wal.write_all(b"MPJF\x01").unwrap();
   wal.sync_all().unwrap();
  }
  {
   let mut wal=OpenOptions::new().read(true).write(true).open(&w).unwrap();
   let mut pages=PageFile::open_for_recovery(&p).unwrap();
   let (next_tx,valid_end)=recover(&mut wal,&mut pages).unwrap();
   assert_eq!(next_tx,2);
   assert_eq!(valid_end,committed_end);
   assert_eq!(pages.read(0).unwrap().payload,b"committed-page");
   // Simula caída: recovery aplicó y sincronizó páginas, pero no truncó el WAL.
  }
  assert!(std::fs::metadata(&w).unwrap().len()>committed_end);
  {
   let db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.read(0).unwrap().payload,b"committed-page");
   assert_eq!(std::fs::metadata(&w).unwrap().len(),committed_end);
   assert_eq!(db.allocate(1,b"after-reopen").unwrap(),1);
  }
  cleanup(p,w);
 }

 #[cfg(windows)]
 #[test]
 fn windows_wal_identity_rejects_distinct_same_length_files(){
  let(p,w)=paths();
  let other=w.with_extension("other");
  std::fs::write(&w,b"same-size").unwrap();
  std::fs::write(&other,b"same-size").unwrap();
  let left=std::fs::metadata(&w).unwrap();
  let right=std::fs::metadata(&other).unwrap();
  assert!(!same_file_identity(&left,&right));
  let _=std::fs::remove_file(&other);
  cleanup(p,w);
 }

 #[test]fn recovery_discards_torn_commit_after_complete_images(){
  let(p,w)=paths();
  {
   let mut wal=OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();wal.write_all(&VERSION.to_le_bytes()).unwrap();
   let image=Image{page_id:0,expected_generation:None,generation:1,payload:b"must-not-commit".to_vec()};
   write_frame(&mut wal,BEGIN,1,&[]).unwrap();
   write_frame(&mut wal,IMAGE,1,&encode_image(&image).unwrap()).unwrap();
   let mut commit=Vec::new();
   write_frame(&mut commit,COMMIT,1,&[]).unwrap();
   wal.write_all(&commit[..10]).unwrap();
   wal.sync_all().unwrap();
  }
  {
   let db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),0);
  }
  assert_eq!(std::fs::metadata(&w).unwrap().len(),HEADER);
  cleanup(p,w);
 }

 #[test]fn committed_page_survives_reopen(){
  let(p,w)=paths();{let mut db=DurablePages::open(&p,&w).unwrap();db.allocate(1,b"one").unwrap();}
  {let mut db=DurablePages::open(&p,&w).unwrap();assert_eq!(db.read(0).unwrap().payload,b"one");}cleanup(p,w);
 }
 #[test]fn overwrite_replays_and_preserves_generation(){
  let(p,w)=paths();{let mut db=DurablePages::open(&p,&w).unwrap();db.allocate(1,b"old").unwrap();db.overwrite(0,1,2,b"new").unwrap();}
  {let mut db=DurablePages::open(&p,&w).unwrap();let page=db.read(0).unwrap();assert_eq!(page.generation,2);assert_eq!(page.payload,b"new");}cleanup(p,w);
 }
 #[test]fn incomplete_wal_tail_is_discarded(){
  let(p,w)=paths();{let mut db=DurablePages::open(&p,&w).unwrap();db.allocate(1,b"safe").unwrap();}
  {let mut f=OpenOptions::new().append(true).open(&w).unwrap();f.write_all(b"MPJF\x01\x02").unwrap();f.sync_all().unwrap();}
  {let mut db=DurablePages::open(&p,&w).unwrap();assert_eq!(db.read(0).unwrap().payload,b"safe");}
  let bytes=std::fs::read(&w).unwrap();assert!(!bytes.ends_with(b"MPJF\\x01\\x02"));cleanup(p,w);
 }
 #[test]fn redo_repairs_corrupt_page_from_committed_image(){
  let(p,w)=paths();{let mut db=DurablePages::open(&p,&w).unwrap();db.allocate(1,b"repair-me").unwrap();}
  let mut bytes=std::fs::read(&p).unwrap();bytes[30]^=0x44;std::fs::write(&p,&bytes).unwrap();
  {let mut db=DurablePages::open(&p,&w).unwrap();assert_eq!(db.read(0).unwrap().payload,b"repair-me");}cleanup(p,w);
 }
 #[test]fn multi_page_transaction_is_atomic_and_durable(){
  let(p,w)=paths();
  {let mut db=DurablePages::open(&p,&w).unwrap();
   let ids=db.transaction(vec![PageChange::Allocate{generation:1,payload:b"alpha".to_vec()},PageChange::Allocate{generation:4,payload:b"beta".to_vec()}]).unwrap();
   assert_eq!(ids,vec![0,1]);assert_eq!(db.page_count(),2);
  }
  {let mut db=DurablePages::open(&p,&w).unwrap();assert_eq!(db.read(0).unwrap().payload,b"alpha");assert_eq!(db.read(1).unwrap().payload,b"beta");}cleanup(p,w);
 }
 #[test]fn multi_page_overwrite_commits_as_one_unit(){
  let(p,w)=paths();
  {let mut db=DurablePages::open(&p,&w).unwrap();db.allocate(1,b"a").unwrap();db.allocate(1,b"b").unwrap();
   db.transaction(vec![PageChange::Overwrite{page_id:0,expected_generation:1,new_generation:2,payload:b"A".to_vec()},PageChange::Overwrite{page_id:1,expected_generation:1,new_generation:2,payload:b"B".to_vec()}]).unwrap();
  }
  {let mut db=DurablePages::open(&p,&w).unwrap();assert_eq!(db.read(0).unwrap().payload,b"A");assert_eq!(db.read(1).unwrap().payload,b"B");}cleanup(p,w);
 }
 #[test]fn duplicate_page_is_rejected_without_wal_change_and_instance_remains_usable(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"x").unwrap();
   let before=std::fs::read(&w).unwrap();
   let result=db.transaction(vec![
    PageChange::Overwrite{page_id:0,expected_generation:1,new_generation:2,payload:b"a".to_vec()},
    PageChange::Overwrite{page_id:0,expected_generation:1,new_generation:3,payload:b"b".to_vec()}
   ]);
   assert!(matches!(result,Err(JournalError::Invalid("una página aparece más de una vez en la transacción"))));
   assert_eq!(std::fs::read(&w).unwrap(),before);
   assert_eq!(db.read(0).unwrap().payload,b"x");
   db.allocate(1,b"after-validation-error").unwrap();
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.read(0).unwrap().payload,b"x");
   assert_eq!(db.read(1).unwrap().payload,b"after-validation-error");
  }
  cleanup(p,w);
 }
 #[test]fn multi_page_redo_repairs_each_committed_image(){
  let(p,w)=paths();{let mut db=DurablePages::open(&p,&w).unwrap();db.transaction(vec![PageChange::Allocate{generation:1,payload:b"first".to_vec()},PageChange::Allocate{generation:1,payload:b"second".to_vec()}]).unwrap();}
  let mut bytes=std::fs::read(&p).unwrap();bytes[30]^=0x20;bytes[4096+30]^=0x40;std::fs::write(&p,&bytes).unwrap();
  {let mut db=DurablePages::open(&p,&w).unwrap();assert_eq!(db.read(0).unwrap().payload,b"first");assert_eq!(db.read(1).unwrap().payload,b"second");}cleanup(p,w);
 }
 #[test]fn checkpoint_keeps_pages_and_allows_new_transactions(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"before-checkpoint").unwrap();
   db.overwrite(0,1,2,b"updated-before-checkpoint").unwrap();
   let old_len=std::fs::metadata(&w).unwrap().len();
   assert!(old_len>HEADER);
   db.checkpoint().unwrap();
   assert_eq!(std::fs::metadata(&w).unwrap().len(),HEADER);
   db.allocate(1,b"after-checkpoint").unwrap();
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.read(0).unwrap().payload,b"updated-before-checkpoint");
   assert_eq!(db.read(1).unwrap().payload,b"after-checkpoint");
  }
  cleanup(p,w);
 }
 #[test]fn recovery_rejects_complete_invalid_zero_payload_frame_at_eof(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"valid").unwrap();
  }
  {
   let mut wal=OpenOptions::new().append(true).open(&w).unwrap();
   // Header completo, tipo inválido y payload vacío: no es una cola parcial.
   write_frame(&mut wal,99,2,&[]).unwrap();
   wal.sync_all().unwrap();
  }
  assert!(matches!(DurablePages::open(&p,&w),Err(JournalError::Corrupt("tipo de frame o estado de transacción inválido dentro del WAL"))));
  cleanup(p,w);
 }

 #[test]fn recovery_fails_closed_on_corrupt_final_committed_frame(){
  let(p,w)=paths();
  {let mut db=DurablePages::open(&p,&w).unwrap();db.allocate(1,b"stable").unwrap();}
  let mut bytes=std::fs::read(&w).unwrap();
  let last=bytes.len()-1;bytes[last]^=0x33;std::fs::write(&w,&bytes).unwrap();
  assert!(matches!(DurablePages::open(&p,&w),Err(JournalError::Corrupt("checksum inválido en frame completo"))));
  let bytes=std::fs::read(&w).unwrap();assert_ne!(bytes.len(),HEADER as usize);
  cleanup(p,w);
 }
 #[test]fn recovery_fails_closed_on_corruption_before_later_frames(){
  let(p,w)=paths();
  let mut wal=OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
  wal.write_all(MAGIC).unwrap();wal.write_all(&VERSION.to_le_bytes()).unwrap();
  let image=Image{page_id:0,expected_generation:None,generation:1,payload:b"first".to_vec()};
  write_frame(&mut wal,BEGIN,1,&[]).unwrap();
  write_frame(&mut wal,IMAGE,1,&encode_image(&image).unwrap()).unwrap();
  write_frame(&mut wal,COMMIT,1,&[]).unwrap();
  let corrupt_at=wal.stream_position().unwrap();
  write_frame(&mut wal,BEGIN,2,&[]).unwrap();
  write_frame(&mut wal,IMAGE,2,&encode_image(&Image{page_id:1,expected_generation:None,generation:1,payload:b"second".to_vec()}).unwrap()).unwrap();
  write_frame(&mut wal,COMMIT,2,&[]).unwrap();
  wal.seek(SeekFrom::Start(corrupt_at+FRAME_HEADER as u64+4)).unwrap();
  let mut byte=[0u8;1];wal.read_exact(&mut byte).unwrap();byte[0]^=0x7f;
  wal.seek(SeekFrom::Start(corrupt_at+FRAME_HEADER as u64+4)).unwrap();wal.write_all(&byte).unwrap();wal.sync_all().unwrap();
  let mut pages=PageFile::open_for_recovery(&p).unwrap();
  assert!(matches!(recover(&mut wal,&mut pages),Err(JournalError::Corrupt("checksum inválido en frame completo"))));
  assert_eq!(pages.page_count(),1);
  drop(wal);drop(pages);cleanup(p,w);
 }
 #[test]
 fn recovery_detects_committed_intermediate_frame_mutated_between_passes() {
  let (p,w)=paths();
  {
   let mut wal=OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();
   wal.write_all(&VERSION.to_le_bytes()).unwrap();
   let first=Image{page_id:0,expected_generation:None,generation:1,payload:b"original-one".to_vec()};
   let second=Image{page_id:0,expected_generation:Some(1),generation:2,payload:b"authoritative-two".to_vec()};
   write_transaction_frames(&mut wal,1,&[encode_image(&first).unwrap()]).unwrap();
   write_transaction_frames(&mut wal,2,&[encode_image(&second).unwrap()]).unwrap();
   wal.sync_all().unwrap();
  }
  let mut wal=OpenOptions::new().read(true).write(true).open(&w).unwrap();
  let mut pages=PageFile::open_for_recovery(&p).unwrap();
  let result=recover_with_interpass(&mut wal,&mut pages,|wal|{
   // Modifica la primera IMAGE y recalcula su checksum: el frame sigue siendo
   // estructuralmente válido, pero ya no es el que se validó en la primera pasada.
   let image_header_offset=HEADER+FRAME_HEADER as u64;
   wal.seek(SeekFrom::Start(image_header_offset))?;
   let mut frame=[0u8;FRAME_HEADER];
   wal.read_exact(&mut frame)?;
   let len=u32::from_le_bytes(frame[13..17].try_into().unwrap()) as usize;
   let mut payload=vec![0u8;len];
   wal.read_exact(&mut payload)?;
   let last=payload.len()-1;
   payload[last]^=0x5a;
   let checksum=sum(IMAGE,1,&payload);
   wal.seek(SeekFrom::Start(image_header_offset+17))?;
   wal.write_all(&checksum.to_le_bytes())?;
   wal.write_all(&payload)?;
   wal.sync_all()?;
   Ok(())
  });
  assert!(matches!(result,Err(JournalError::Corrupt("la transacción WAL cambió entre validación y redo"))));
  assert_eq!(pages.page_count(),0,"ninguna imagen modificada debe aplicarse");
  assert_eq!(std::fs::metadata(&p).unwrap().len(),0);
  drop(wal);drop(pages);cleanup(p,w);
 }

 #[test]fn recovery_rejects_non_monotonic_transaction_ids(){
  let(p,w)=paths();
  let mut wal=OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
  wal.write_all(MAGIC).unwrap();wal.write_all(&VERSION.to_le_bytes()).unwrap();
  let image=Image{page_id:0,expected_generation:None,generation:1,payload:b"must-not-apply".to_vec()};
  write_frame(&mut wal,BEGIN,2,&[]).unwrap();
  write_frame(&mut wal,IMAGE,2,&encode_image(&image).unwrap()).unwrap();
  write_frame(&mut wal,COMMIT,2,&[]).unwrap();
  wal.sync_all().unwrap();
  let mut pages=PageFile::open_for_recovery(&p).unwrap();
  assert!(matches!(recover(&mut wal,&mut pages),Err(JournalError::Corrupt("secuencia de transacciones inválida dentro del WAL"))));
  assert_eq!(pages.page_count(),0);
  drop(wal);drop(pages);cleanup(p,w);
 }
 #[test]fn checkpoint_refuses_when_recovery_is_required(){
  let(p,w)=paths();
  let mut db=DurablePages::open(&p,&w).unwrap();
  db.recovery_required=true;
  assert!(db.checkpoint().is_err());
  cleanup(p,w);
 }

 #[test]fn checkpoint_refuses_to_discard_wal_when_page_is_corrupt(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"keep-recovery-image").unwrap();
   let wal_len=std::fs::metadata(&w).unwrap().len();
   let mut bytes=std::fs::read(&p).unwrap();
   bytes[30]^=0x7f;
   std::fs::write(&p,&bytes).unwrap();
   assert!(matches!(db.checkpoint(),Err(JournalError::Page(PageError::Corrupt("checksum no coincide")))));
   assert!(!db.recovery_required);
   assert_eq!(std::fs::metadata(&w).unwrap().len(),wal_len);
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.read(0).unwrap().payload,b"keep-recovery-image");
  }
  cleanup(p,w);
 }

 #[test]fn checkpoint_page_sync_failure_preserves_wal_and_live_instance(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"before-sync-failure").unwrap();
   let before=std::fs::metadata(&w).unwrap().len();
   let result=db.checkpoint_with_sync(|_|{
    Err(JournalError::Io(io::Error::new(io::ErrorKind::Other,"fallo de sync de páginas inyectado")))
   },|wal|{
    wal.set_len(HEADER)?;
    wal.sync_all()?;
    Ok(())
   });
   assert!(matches!(result,Err(JournalError::Io(_))));
   assert!(!db.recovery_required);
   assert_eq!(std::fs::metadata(&w).unwrap().len(),before);
   db.allocate(1,b"live-instance-still-usable").unwrap();
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.read(0).unwrap().payload,b"before-sync-failure");
   assert_eq!(db.read(1).unwrap().payload,b"live-instance-still-usable");
  }
  cleanup(p,w);
 }

 #[test]fn checkpoint_failure_after_truncation_requires_reopen(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"durable-before-checkpoint").unwrap();
   let result=db.checkpoint_with(|wal|{
    let mut failing=FailAfter{file:wal,remaining:usize::MAX,fail_sync:true};
    failing.file.set_len(HEADER)?;
    failing.sync_durable()?;
    Ok(())
   });
   assert!(matches!(result,Err(JournalError::Io(_))));
   assert!(db.recovery_required);
   assert!(matches!(db.read(0),Err(JournalError::Invalid("se requiere cerrar y reabrir para completar recovery"))));
   assert!(db.checkpoint().is_err());
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.read(0).unwrap().payload,b"durable-before-checkpoint");
   assert_eq!(std::fs::metadata(&w).unwrap().len(),HEADER);
   db.allocate(1,b"after-reopen").unwrap();
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.read(1).unwrap().payload,b"after-reopen");
  }
  cleanup(p,w);
 }

 #[test]fn recovery_rejects_torn_page_without_committed_wal_image(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"already-checkpointed").unwrap();
   db.checkpoint().unwrap();
  }
  // La última página estaba consolidada; el WAL ya no contiene una imagen
  // que permita reconstruirla si el archivo termina a mitad del bloque.
  let file=OpenOptions::new().write(true).open(&p).unwrap();
  file.set_len((crate::page::PAGE_SIZE/2) as u64).unwrap();
  drop(file);
  assert!(matches!(DurablePages::open(&p,&w),Err(JournalError::Corrupt("página final incompleta sin imagen WAL confirmada para reconstruirla"))));
  // La apertura fallida conserva el fragmento para diagnóstico/recuperación externa.
  assert_eq!(std::fs::metadata(&p).unwrap().len(),(crate::page::PAGE_SIZE/2) as u64);
  cleanup(p,w);
 }


 #[test]fn redo_recreates_torn_last_allocated_page_after_multi_page_commit(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.transaction(vec![
    PageChange::Allocate{generation:1,payload:b"first-page-remains-intact".to_vec()},
    PageChange::Allocate{generation:1,payload:b"second-page-was-torn".to_vec()},
   ]).unwrap();
  }
  // La primera página quedó completa; la segunda conserva solo media imagen.
  // El COMMIT durable sigue siendo la autoridad para reconstruir la cola.
  let file=OpenOptions::new().write(true).open(&p).unwrap();
  file.set_len(crate::page::PAGE_SIZE as u64+(crate::page::PAGE_SIZE/2) as u64).unwrap();
  drop(file);
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),2);
   assert_eq!(db.read(0).unwrap().payload,b"first-page-remains-intact");
   assert_eq!(db.read(1).unwrap().payload,b"second-page-was-torn");
  }
  assert_eq!(std::fs::metadata(&p).unwrap().len(),(2*crate::page::PAGE_SIZE) as u64);
  cleanup(p,w);
 }

 #[test]fn corrupt_committed_wal_does_not_truncate_or_repair_torn_page_tail(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"must-be-restored-only-from-valid-wal").unwrap();
  }
  let mut wal_bytes=std::fs::read(&w).unwrap();
  let image_payload_start=HEADER as usize+FRAME_HEADER;
  let image_data_byte=image_payload_start+28;
  wal_bytes[image_data_byte]^=0x55;
  std::fs::write(&w,&wal_bytes).unwrap();
  let original_wal=std::fs::read(&w).unwrap();
  let partial_len=(crate::page::PAGE_SIZE/2) as u64;
  let file=OpenOptions::new().write(true).open(&p).unwrap();
  file.set_len(partial_len).unwrap();
  drop(file);
  assert!(matches!(DurablePages::open(&p,&w),Err(JournalError::Corrupt("checksum inválido en frame completo"))));
  assert_eq!(std::fs::metadata(&p).unwrap().len(),partial_len,"no debe tocarse una página rota si el WAL no supera validación");
  assert_eq!(std::fs::read(&w).unwrap(),original_wal,"el WAL corrupto debe conservarse para diagnóstico");
  cleanup(p,w);
 }

 #[test]fn recovery_rejects_corrupt_intermediate_page_without_wal_image(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.transaction(vec![
    PageChange::Allocate{generation:1,payload:b"left".to_vec()},
    PageChange::Allocate{generation:1,payload:b"middle".to_vec()},
    PageChange::Allocate{generation:1,payload:b"right".to_vec()},
   ]).unwrap();
   db.checkpoint().unwrap();
   db.overwrite(0,1,2,b"left-updated").unwrap();
  }
  // La página central no tiene imagen en el WAL posterior al checkpoint.
  let mut bytes=std::fs::read(&p).unwrap();
  bytes[crate::page::PAGE_SIZE+30]^=0x5a;
  std::fs::write(&p,&bytes).unwrap();
  assert!(matches!(DurablePages::open(&p,&w),Err(JournalError::Page(PageError::Corrupt("checksum no coincide")))));
  cleanup(p,w);
 }


 // Simula un proceso que termina después de escribir BEGIN y una IMAGE,
 // pero antes de escribir COMMIT. Una transacción sin COMMIT no debe aplicarse.
 #[test]fn crash_before_commit_discards_entire_multi_page_transaction(){
  let(p,w)=paths();
  let images=vec![
   Image{page_id:0,expected_generation:None,generation:1,payload:b"first".to_vec()},
   Image{page_id:1,expected_generation:None,generation:1,payload:b"second".to_vec()},
  ];
  {
   let mut wal=OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();wal.write_all(&VERSION.to_le_bytes()).unwrap();
   write_frame(&mut wal,BEGIN,1,&[]).unwrap();
   write_frame(&mut wal,IMAGE,1,&encode_image(&images[0]).unwrap()).unwrap();
   wal.sync_all().unwrap();
  }
  {
   let db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),0);
  }
  assert_eq!(std::fs::metadata(&w).unwrap().len(),HEADER);
  cleanup(p,w);
 }

 // Simula la caída después de que COMMIT quedó escrito y sincronizado,
 // pero antes de que comience la aplicación al archivo de páginas.
 #[test]fn crash_after_durable_commit_replays_all_images(){
  let(p,w)=paths();
  let images=vec![
   Image{page_id:0,expected_generation:None,generation:1,payload:b"first".to_vec()},
   Image{page_id:1,expected_generation:None,generation:1,payload:b"second".to_vec()},
  ];
  {
   let mut wal=OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();wal.write_all(&VERSION.to_le_bytes()).unwrap();
   write_frame(&mut wal,BEGIN,1,&[]).unwrap();
   for image in &images { write_frame(&mut wal,IMAGE,1,&encode_image(image).unwrap()).unwrap(); }
   write_frame(&mut wal,COMMIT,1,&[]).unwrap();
   wal.sync_all().unwrap();
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),2);
   assert_eq!(db.read(0).unwrap().payload,b"first");
   assert_eq!(db.read(1).unwrap().payload,b"second");
  }
  cleanup(p,w);
 }

 // Simula la caída después de aplicar la primera página, antes de terminar
 // la transacción y antes de sincronizar el archivo de páginas.
 #[test]fn crash_during_page_apply_redoes_remaining_images(){
  let(p,w)=paths();
  let images=vec![
   Image{page_id:0,expected_generation:None,generation:1,payload:b"first".to_vec()},
   Image{page_id:1,expected_generation:None,generation:1,payload:b"second".to_vec()},
  ];
  {
   let mut wal=OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();wal.write_all(&VERSION.to_le_bytes()).unwrap();
   write_frame(&mut wal,BEGIN,1,&[]).unwrap();
   for image in &images { write_frame(&mut wal,IMAGE,1,&encode_image(image).unwrap()).unwrap(); }
   write_frame(&mut wal,COMMIT,1,&[]).unwrap();
   wal.sync_all().unwrap();
  }
  {
   let mut pages=PageFile::open_for_recovery(&p).unwrap();
   apply_image(&mut pages,&images[0]).unwrap();
   // No sync: abandonar la instancia en el punto medio de la aplicación.
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),2);
   assert_eq!(db.read(0).unwrap().payload,b"first");
   assert_eq!(db.read(1).unwrap().payload,b"second");
  }
  cleanup(p,w);
 }


 // Una transacción sin COMMIT se elimina al abrir; el siguiente COMMIT
 // debe reutilizar su ID, porque el WAL incompleto fue truncado por completo.
 #[test]fn incomplete_transaction_does_not_consume_transaction_id(){
  let(p,w)=paths();
  {
   let mut wal=OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();wal.write_all(&VERSION.to_le_bytes()).unwrap();
   write_frame(&mut wal,BEGIN,1,&[]).unwrap();
   write_frame(&mut wal,IMAGE,1,&encode_image(&Image{page_id:0,expected_generation:None,generation:1,payload:b"discard".to_vec()}).unwrap()).unwrap();
   wal.sync_all().unwrap();
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),0);
   assert_eq!(db.allocate(1,b"kept").unwrap(),0);
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.read(0).unwrap().payload,b"kept");
  }
  cleanup(p,w);
 }


 // Si una sobrescritura confirmada deja el último bloque físico truncado,
 // open_for_recovery lo elimina y redo debe reconstruirlo desde el WAL.
 #[test]fn redo_rebuilds_torn_last_page_in_multi_page_overwrite_transaction(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.transaction(vec![
    PageChange::Allocate{generation:1,payload:b"first-original".to_vec()},
    PageChange::Allocate{generation:1,payload:b"last-original".to_vec()},
   ]).unwrap();
   db.checkpoint().unwrap();
   db.transaction(vec![
    PageChange::Overwrite{page_id:0,expected_generation:1,new_generation:2,payload:b"first-updated".to_vec()},
    PageChange::Overwrite{page_id:1,expected_generation:1,new_generation:2,payload:b"last-updated".to_vec()},
   ]).unwrap();
  }
  let file=OpenOptions::new().write(true).open(&p).unwrap();
  file.set_len((crate::page::PAGE_SIZE+crate::page::PAGE_SIZE/2) as u64).unwrap();
  drop(file);
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),2);
   assert_eq!(db.read(0).unwrap().payload,b"first-updated");
   assert_eq!(db.read(1).unwrap().payload,b"last-updated");
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.read(0).unwrap().generation,2);
   assert_eq!(db.read(1).unwrap().generation,2);
  }
  cleanup(p,w);
 }

 #[test]fn redo_recreates_torn_last_page_after_committed_overwrite(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"original").unwrap();
   db.checkpoint().unwrap();
   db.overwrite(0,1,2,b"replacement").unwrap();
  }
  // Simula una caída a mitad de la escritura de la página sobrescrita.
  let file=OpenOptions::new().write(true).open(&p).unwrap();
  file.set_len((crate::page::PAGE_SIZE/2) as u64).unwrap();
  drop(file);
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   let page=db.read(0).unwrap();
   assert_eq!(page.generation,2);
   assert_eq!(page.payload,b"replacement");
  }
  cleanup(p,w);
 }


 struct FailAfter<'a>{file:&'a mut File,remaining:usize,fail_sync:bool}
 impl Write for FailAfter<'_>{
  fn write(&mut self,buf:&[u8])->io::Result<usize>{
   if self.remaining==0{return Err(io::Error::new(io::ErrorKind::Other,"fallo de escritura inyectado"));}
   let n=buf.len().min(self.remaining);
   let written=self.file.write(&buf[..n])?;
   self.remaining-=written;
   Ok(written)
  }
  fn flush(&mut self)->io::Result<()>{self.file.flush()}
 }
 impl DurableWrite for FailAfter<'_>{
  fn sync_durable(&mut self)->io::Result<()>{
   if self.fail_sync{return Err(io::Error::new(io::ErrorKind::Other,"fallo de sync inyectado"));}
   self.file.sync_all()
  }
 }

 #[test]fn failed_wal_write_blocks_live_instance_until_reopen(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   let image=Image{page_id:0,expected_generation:None,generation:1,payload:b"not-committed".to_vec()};
   let result=db.commit_images_with(vec![image],|wal,tx,encoded|{
    let mut failing=FailAfter{file:wal,remaining:35,fail_sync:false};
    persist_transaction(&mut failing,tx,encoded)
   });
   assert!(matches!(result,Err(JournalError::Io(_))));
   assert!(db.recovery_required);
   assert!(matches!(db.read(0),Err(JournalError::Invalid("se requiere cerrar y reabrir para completar recovery"))));
  }
  {
   let db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),0);
  }
  cleanup(p,w);
 }

 #[test]
 fn partial_mlpg_write_during_apply_blocks_instance_and_redoes_on_reopen() {
  // Asignación: la escritura deja una página final incompleta.
  let (p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   let image=Image{page_id:0,expected_generation:None,generation:1,payload:b"recover-partial-allocation".to_vec()};
   let result=db.commit_images_with_apply(vec![image],|wal,tx,encoded|persist_transaction(wal,tx,encoded),|pages,images|{
    pages.fail_write_after=Some(crate::page::PAGE_SIZE/2);
    apply_transaction(pages,images)
   });
   assert!(matches!(result,Err(JournalError::Page(PageError::Io(_)))));
   assert!(db.recovery_required);
   assert!(matches!(db.read(0),Err(JournalError::Invalid("se requiere cerrar y reabrir para completar recovery"))));
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),1);
   assert_eq!(db.read(0).unwrap().payload,b"recover-partial-allocation");
  }
  cleanup(p,w);

  // Sobrescritura: la página completa queda corrupta y redo la repara.
  let (p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"old-page-before-partial-overwrite").unwrap();
   let image=Image{page_id:0,expected_generation:Some(1),generation:2,payload:b"new-page-after-partial-overwrite".to_vec()};
   let result=db.commit_images_with_apply(vec![image],|wal,tx,encoded|persist_transaction(wal,tx,encoded),|pages,images|{
    pages.fail_write_after=Some(crate::page::PAGE_SIZE/2);
    apply_transaction(pages,images)
   });
   assert!(matches!(result,Err(JournalError::Page(PageError::Io(_)))));
   assert!(db.recovery_required);
   assert!(matches!(db.read(0),Err(JournalError::Invalid("se requiere cerrar y reabrir para completar recovery"))));
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.read(0).unwrap().generation,2);
   assert_eq!(db.read(0).unwrap().payload,b"new-page-after-partial-overwrite");
  }
  cleanup(p,w);
 }

 #[test]fn page_apply_sync_failure_requires_reopen_and_redoes_commit(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   let images=vec![
    Image{page_id:0,expected_generation:None,generation:1,payload:b"first-durable".to_vec()},
    Image{page_id:1,expected_generation:None,generation:1,payload:b"second-durable".to_vec()},
   ];
   let result=db.commit_images_with_apply(images,|wal,tx,encoded|persist_transaction(wal,tx,encoded),|pages,images|{
    apply_image(pages,&images[0])?;
    Err(JournalError::Page(PageError::Io(io::Error::new(io::ErrorKind::Other,"fallo de sync de páginas inyectado"))))
   });
   assert!(matches!(result,Err(JournalError::Page(PageError::Io(_)))));
   assert!(db.recovery_required);
   assert!(matches!(db.read(0),Err(JournalError::Invalid("se requiere cerrar y reabrir para completar recovery"))));
   // La primera imagen alcanzó disco, pero la segunda sigue pendiente:
   // la instancia bloqueada no expone un estado parcialmente aplicado.
   assert_eq!(db.pages.page_count(),1);
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),2);
   assert_eq!(db.read(0).unwrap().payload,b"first-durable");
   assert_eq!(db.read(1).unwrap().payload,b"second-durable");
  }
  cleanup(p,w);
 }

 #[test]fn commit_frame_write_failure_after_complete_image_discards_batch_and_reuses_txid(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   let image=Image{page_id:0,expected_generation:None,generation:1,payload:b"complete-image-no-commit".to_vec()};
   let encoded=encode_image(&image).unwrap();
   let complete_uncommitted_prefix=21+21+encoded.len();
   let result=db.commit_images_with(vec![image],|wal,tx,frames|{
    let mut failing=FailAfter{file:wal,remaining:complete_uncommitted_prefix,fail_sync:false};
    persist_transaction(&mut failing,tx,frames)
   });
   assert!(matches!(result,Err(JournalError::Io(_))));
   assert!(db.recovery_required);
   assert!(matches!(db.read(0),Err(JournalError::Invalid("se requiere cerrar y reabrir para completar recovery"))));
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),0,"IMAGE sin COMMIT no debe materializarse");
   assert_eq!(std::fs::metadata(&w).unwrap().len(),HEADER,"la cola no confirmada debe truncarse");
   db.allocate(1,b"next-committed-transaction").unwrap();
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),1);
   assert_eq!(db.read(0).unwrap().payload,b"next-committed-transaction");
  }
  cleanup(p,w);
 }

 #[test]fn partial_begin_image_and_commit_frames_are_discarded_as_one_transaction(){
  let payload=b"frame-boundary-matrix";
  let image=Image{page_id:0,expected_generation:None,generation:1,payload:payload.to_vec()};
  let encoded=encode_image(&image).unwrap();
  let image_frame_end=21+21+encoded.len();
  let failure_offsets=[
   1,20,                         // BEGIN header parcial
   21,22,41,                     // BEGIN completo; IMAGE header parcial
   42,43,42+encoded.len()/2,     // IMAGE header/payload parcial
   image_frame_end,              // IMAGE completa; COMMIT aún no escrito
   image_frame_end+1,image_frame_end+20, // cabecera COMMIT parcial
  ];
  for offset in failure_offsets {
   let(p,w)=paths();
   {
    let mut db=DurablePages::open(&p,&w).unwrap();
    let result=db.commit_images_with(vec![image.clone()],|wal,tx,frames|{
     let mut failing=FailAfter{file:wal,remaining:offset,fail_sync:false};
     persist_transaction(&mut failing,tx,frames)
    });
    assert!(matches!(result,Err(JournalError::Io(_))),"offset {offset}");
    assert!(db.recovery_required,"offset {offset}");
    assert!(matches!(db.read(0),Err(JournalError::Invalid("se requiere cerrar y reabrir para completar recovery"))));
   }
   {
    let mut db=DurablePages::open(&p,&w).unwrap();
    assert_eq!(db.page_count(),0,"ningún frame sin COMMIT puede aplicarse; offset {offset}");
    assert_eq!(std::fs::metadata(&w).unwrap().len(),HEADER,"la cola incompleta debe truncarse; offset {offset}");
    db.allocate(1,b"next-transaction").unwrap();
   }
   {
    let mut db=DurablePages::open(&p,&w).unwrap();
    assert_eq!(db.read(0).unwrap().payload,b"next-transaction","la siguiente transacción debe poder confirmarse; offset {offset}");
   }
   cleanup(p,w);
  }
 }

 #[test]
 fn multi_page_overwrite_is_atomic_at_every_wal_frame_boundary() {
  let old = [b"first-page-before-transaction".as_slice(), b"second-page-before-transaction".as_slice()];
  let new = [b"first-page-after-transaction".as_slice(), b"second-page-after-transaction".as_slice()];
  let images = vec![
   Image { page_id: 0, expected_generation: Some(1), generation: 2, payload: new[0].to_vec() },
   Image { page_id: 1, expected_generation: Some(1), generation: 2, payload: new[1].to_vec() },
  ];
  let encoded = images.iter().map(encode_image).collect::<Result<Vec<_>, _>>().unwrap();
  let begin_len = FRAME_HEADER;
  let image_frame_len = |payload: &[u8]| FRAME_HEADER + payload.len();
  let first_image_end = begin_len + image_frame_len(&encoded[0]);
  let second_image_end = first_image_end + image_frame_len(&encoded[1]);
  // Dieciocho cortes dentro de BEGIN, de ambos IMAGE y del header COMMIT.
  // Los límites exactos verifican también el cambio de frame.
  let offsets = [
   0, 1, FRAME_HEADER - 1, begin_len,
   begin_len + 1, begin_len + FRAME_HEADER - 1, begin_len + FRAME_HEADER,
   begin_len + FRAME_HEADER + encoded[0].len() / 2,
   first_image_end - 1, first_image_end,
   first_image_end + 1, first_image_end + FRAME_HEADER - 1,
   first_image_end + FRAME_HEADER,
   first_image_end + FRAME_HEADER + encoded[1].len() / 2,
   second_image_end - 1, second_image_end,
   second_image_end + 1, second_image_end + FRAME_HEADER - 1,
  ];

  for offset in offsets {
   let (pages, wal) = paths();
   {
    let mut db = DurablePages::open(&pages, &wal).unwrap();
    db.transaction(vec![
     PageChange::Allocate { generation: 1, payload: old[0].to_vec() },
     PageChange::Allocate { generation: 1, payload: old[1].to_vec() },
    ]).unwrap();
    db.checkpoint().unwrap();
    let result = db.commit_images_with(images.clone(), |wal, tx, frames| {
     let mut failing = FailAfter { file: wal, remaining: offset, fail_sync: false };
     persist_transaction(&mut failing, tx, frames)
    });
    assert!(matches!(result, Err(JournalError::Io(_))), "corte WAL en byte {offset}");
    assert!(db.recovery_required, "la instancia debe quedar bloqueada en byte {offset}");
    assert!(matches!(
     db.read(0),
     Err(JournalError::Invalid("se requiere cerrar y reabrir para completar recovery"))
    ));
   }

   // El COMMIT no llegó completo: ambas páginas deben conservar la versión anterior.
   {
    let mut db = DurablePages::open(&pages, &wal).unwrap();
    assert_eq!(db.read(0).unwrap().generation, 1, "página 0, corte {offset}");
    assert_eq!(db.read(0).unwrap().payload.as_slice(), old[0], "página 0, corte {offset}");
    assert_eq!(db.read(1).unwrap().generation, 1, "página 1, corte {offset}");
    assert_eq!(db.read(1).unwrap().payload.as_slice(), old[1], "página 1, corte {offset}");
    assert_eq!(std::fs::metadata(&wal).unwrap().len(), HEADER, "WAL, corte {offset}");

    // La misma base debe aceptar una transacción completa después del recovery.
    db.transaction(vec![
     PageChange::Overwrite { page_id: 0, expected_generation: 1, new_generation: 2, payload: new[0].to_vec() },
     PageChange::Overwrite { page_id: 1, expected_generation: 1, new_generation: 2, payload: new[1].to_vec() },
    ]).unwrap();
   }
   {
    let mut db = DurablePages::open(&pages, &wal).unwrap();
    assert_eq!(db.read(0).unwrap().generation, 2);
    assert_eq!(db.read(0).unwrap().payload.as_slice(), new[0]);
    assert_eq!(db.read(1).unwrap().generation, 2);
    assert_eq!(db.read(1).unwrap().payload.as_slice(), new[1]);
   }
   cleanup(pages, wal);
  }
 }

 #[test]fn checkpoint_seek_failure_before_truncation_preserves_wal_but_requires_reopen(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   db.allocate(1,b"committed-before-seek-failure").unwrap();
   let before=std::fs::read(&w).unwrap();
   let result=db.checkpoint_with(|_|{
    Err(JournalError::Io(io::Error::new(io::ErrorKind::Other,"fallo de seek de checkpoint inyectado")))
   });
   assert!(matches!(result,Err(JournalError::Io(_))));
   assert!(db.recovery_required);
   assert_eq!(std::fs::read(&w).unwrap(),before,"el WAL no debe cambiar si falla el seek");
   assert!(matches!(db.read(0),Err(JournalError::Invalid("se requiere cerrar y reabrir para completar recovery"))));
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.read(0).unwrap().payload,b"committed-before-seek-failure");
   db.checkpoint().unwrap();
   assert_eq!(std::fs::metadata(&w).unwrap().len(),HEADER);
  }
  cleanup(p,w);
 }

 #[test]fn wal_sync_failure_is_resolved_by_reopening(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   let image=Image{page_id:0,expected_generation:None,generation:1,payload:b"commit-may-have-persisted".to_vec()};
   let result=db.commit_images_with(vec![image],|wal,tx,encoded|{
    let mut failing=FailAfter{file:wal,remaining:usize::MAX,fail_sync:true};
    persist_transaction(&mut failing,tx,encoded)
   });
   assert!(matches!(result,Err(JournalError::Io(_))));
   assert!(db.recovery_required);
   assert!(matches!(db.read(0),Err(JournalError::Invalid("se requiere cerrar y reabrir para completar recovery"))));
  }
  // La simulación dejó todos los frames visibles, aunque sync informó error.
  // La reapertura debe decidir por el WAL real y reproducir el COMMIT completo.
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),1);
   assert_eq!(db.read(0).unwrap().payload,b"commit-may-have-persisted");
  }
  cleanup(p,w);
 }

 #[test]fn partial_wal_write_is_discarded_on_reopen(){
  let(p,w)=paths();
  {
   let mut wal=OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();wal.write_all(&VERSION.to_le_bytes()).unwrap();
   let image=encode_image(&Image{page_id:0,expected_generation:None,generation:1,payload:b"must-not-appear".to_vec()}).unwrap();
   let result={
    let mut failing=FailAfter{file:&mut wal,remaining:35,fail_sync:false};
    write_transaction_frames(&mut failing,1,&[image])
   };
   assert!(matches!(result,Err(JournalError::Io(_))));
   wal.sync_all().unwrap();
  }
  {
   let db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),0);
  }
  assert_eq!(std::fs::metadata(&w).unwrap().len(),HEADER);
  cleanup(p,w);
 }


 #[test]fn committed_transactions_survive_a_later_incomplete_transaction(){
  let(p,w)=paths();
  let committed_end;
  {
   let mut wal=OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();wal.write_all(&VERSION.to_le_bytes()).unwrap();
   let first=Image{page_id:0,expected_generation:None,generation:1,payload:b"first-commit".to_vec()};
   write_transaction_frames(&mut wal,1,&[encode_image(&first).unwrap()]).unwrap();
   let second=Image{page_id:0,expected_generation:Some(1),generation:2,payload:b"second-commit".to_vec()};
   write_transaction_frames(&mut wal,2,&[encode_image(&second).unwrap()]).unwrap();
   committed_end=wal.stream_position().unwrap();
   write_frame(&mut wal,BEGIN,3,&[]).unwrap();
   let abandoned=Image{page_id:1,expected_generation:None,generation:1,payload:b"must-not-appear".to_vec()};
   write_frame(&mut wal,IMAGE,3,&encode_image(&abandoned).unwrap()).unwrap();
   wal.sync_all().unwrap();
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),1);
   let page=db.read(0).unwrap();
   assert_eq!(page.generation,2);
   assert_eq!(page.payload,b"second-commit");
   assert_eq!(std::fs::metadata(&w).unwrap().len(),committed_end);
   assert_eq!(db.allocate(1,b"next-valid").unwrap(),1);
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.page_count(),2);
   assert_eq!(db.read(0).unwrap().payload,b"second-commit");
   assert_eq!(db.read(1).unwrap().payload,b"next-valid");
  }
  cleanup(p,w);
 }

 #[test]
 fn committed_state_survives_a_truncated_image_payload_in_later_transaction() {
  let (p, w) = paths();
  let committed_end;
  {
   let mut wal = OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();
   wal.write_all(&VERSION.to_le_bytes()).unwrap();
   let committed = Image {
    page_id: 0,
    expected_generation: None,
    generation: 1,
    payload: b"durable-before-torn-tail".to_vec(),
   };
   write_transaction_frames(&mut wal, 1, &[encode_image(&committed).unwrap()]).unwrap();
   committed_end = wal.stream_position().unwrap();

   write_frame(&mut wal, BEGIN, 2, &[]).unwrap();
   let abandoned = Image {
    page_id: 1,
    expected_generation: None,
    generation: 1,
    payload: b"must-not-be-allocated".to_vec(),
   };
   let mut encoded_image = Vec::new();
   write_frame(&mut encoded_image, IMAGE, 2, &encode_image(&abandoned).unwrap()).unwrap();
   // Conservar el header completo del frame y solo parte de su payload.
   wal.write_all(&encoded_image[..FRAME_HEADER + 9]).unwrap();
   wal.sync_all().unwrap();
  }

  {
   let mut db = DurablePages::open(&p, &w).unwrap();
   assert_eq!(db.page_count(), 1);
   assert_eq!(db.read(0).unwrap().payload, b"durable-before-torn-tail");
   assert_eq!(std::fs::metadata(&w).unwrap().len(), committed_end);
   assert_eq!(db.allocate(1, b"next-committed-page").unwrap(), 1);
  }
  {
   let mut db = DurablePages::open(&p, &w).unwrap();
   assert_eq!(db.page_count(), 2);
   assert_eq!(db.read(0).unwrap().payload, b"durable-before-torn-tail");
   assert_eq!(db.read(1).unwrap().payload, b"next-committed-page");
  }
  cleanup(p, w);
 }

 #[test]
 fn later_wal_corruption_is_detected_before_any_committed_image_is_applied() {
  let (pages_path, wal_path) = paths();
  let wal_before;
  let pages_before;
  {
   let mut wal = OpenOptions::new().read(true).write(true).create(true).open(&wal_path).unwrap();
   wal.write_all(MAGIC).unwrap();
   wal.write_all(&VERSION.to_le_bytes()).unwrap();

   let first = Image {
    page_id: 0,
    expected_generation: None,
    generation: 1,
    payload: b"must-not-be-applied-before-full-validation".to_vec(),
   };
   write_transaction_frames(&mut wal, 1, &[encode_image(&first).unwrap()]).unwrap();

   let second = Image {
    page_id: 0,
    expected_generation: Some(1),
    generation: 2,
    payload: b"corrupt-later-transaction".to_vec(),
   };
   let encoded = encode_image(&second).unwrap();
   let tx2_start = wal.stream_position().unwrap();
   write_transaction_frames(&mut wal, 2, &[encoded.clone()]).unwrap();

   // Corromper el checksum del COMMIT completo de la segunda transacción.
   let commit_checksum =
    tx2_start + FRAME_HEADER as u64 + (FRAME_HEADER + encoded.len()) as u64 + 17;
   wal.seek(SeekFrom::Start(commit_checksum)).unwrap();
   let mut byte = [0u8; 1];
   wal.read_exact(&mut byte).unwrap();
   byte[0] ^= 0x40;
   wal.seek(SeekFrom::Start(commit_checksum)).unwrap();
   wal.write_all(&byte).unwrap();
   wal.sync_all().unwrap();
   wal.seek(SeekFrom::Start(0)).unwrap();
   let mut bytes = Vec::new();
   wal.read_to_end(&mut bytes).unwrap();
   wal_before = bytes;
  }
  // La página física no existe: una recuperación incremental habría aplicado
  // la primera transacción antes de descubrir el COMMIT corrupto posterior.
  pages_before = std::fs::read(&pages_path).unwrap_or_default();
  assert!(matches!(
   DurablePages::open(&pages_path, &wal_path),
   Err(JournalError::Corrupt("checksum inválido en frame completo"))
  ));
  assert_eq!(std::fs::read(&wal_path).unwrap(), wal_before);
  assert_eq!(std::fs::read(&pages_path).unwrap_or_default(), pages_before);
  cleanup(pages_path, wal_path);
 }

 #[test]fn corruption_after_multiple_commits_fails_closed_without_truncating_wal_or_pages(){
  let(p,w)=paths();
  let wal_bytes;
  let pages_before;
  {
   let mut wal=OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();wal.write_all(&VERSION.to_le_bytes()).unwrap();
   let first=Image{page_id:0,expected_generation:None,generation:1,payload:b"stable-one".to_vec()};
   write_transaction_frames(&mut wal,1,&[encode_image(&first).unwrap()]).unwrap();
   let second=Image{page_id:0,expected_generation:Some(1),generation:2,payload:b"stable-two".to_vec()};
   write_transaction_frames(&mut wal,2,&[encode_image(&second).unwrap()]).unwrap();
   let third=Image{page_id:0,expected_generation:Some(2),generation:3,payload:b"uncommitted-corrupt".to_vec()};
   let encoded=encode_image(&third).unwrap();
   let tx3_start=wal.stream_position().unwrap();
   write_transaction_frames(&mut wal,3,&[encoded.clone()]).unwrap();
   // Corromper el checksum del COMMIT completo de la tercera transacción.
   let commit_checksum=tx3_start+FRAME_HEADER as u64+(FRAME_HEADER+encoded.len()) as u64+17;
   wal.seek(SeekFrom::Start(commit_checksum)).unwrap();
   let mut byte=[0u8;1];wal.read_exact(&mut byte).unwrap();byte[0]^=0x80;
   wal.seek(SeekFrom::Start(commit_checksum)).unwrap();wal.write_all(&byte).unwrap();wal.sync_all().unwrap();
   wal.seek(SeekFrom::Start(0)).unwrap();let mut bytes=Vec::new();wal.read_to_end(&mut bytes).unwrap();wal_bytes=bytes;
  }
  {
   let mut pages=PageFile::open_for_recovery(&p).unwrap();
   pages.recover_allocate(0,2,b"stable-two").unwrap();
   pages.sync().unwrap();
   pages_before=std::fs::read(&p).unwrap();
  }
  assert!(matches!(DurablePages::open(&p,&w),Err(JournalError::Corrupt("checksum inválido en frame completo"))));
  assert_eq!(std::fs::read(&w).unwrap(),wal_bytes);
  assert_eq!(std::fs::read(&p).unwrap(),pages_before);
  cleanup(p,w);
 }

 #[test]fn repeated_checkpoints_reset_transaction_sequence_and_preserve_state(){
  let(p,w)=paths();
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   assert_eq!(db.allocate(1,b"initial").unwrap(),0);
   db.overwrite(0,1,2,b"after-first-commit").unwrap();
   db.checkpoint().unwrap();
   assert_eq!(std::fs::metadata(&w).unwrap().len(),HEADER);
   db.overwrite(0,2,3,b"after-second-commit").unwrap();
   db.checkpoint().unwrap();
   assert_eq!(std::fs::metadata(&w).unwrap().len(),HEADER);
   db.overwrite(0,3,4,b"after-third-commit").unwrap();
  }
  {
   let bytes=std::fs::read(&w).unwrap();
   assert!(bytes.len()>HEADER as usize);
   assert_eq!(u64::from_le_bytes(bytes[HEADER as usize+5..HEADER as usize+13].try_into().unwrap()),1);
  }
  {
   let mut db=DurablePages::open(&p,&w).unwrap();
   let page=db.read(0).unwrap();
   assert_eq!(page.generation,4);
   assert_eq!(page.payload,b"after-third-commit");
   db.checkpoint().unwrap();
  }
  assert_eq!(std::fs::metadata(&w).unwrap().len(),HEADER);
  cleanup(p,w);
 }


 #[test]
 fn replay_many_commits_from_mixed_page_generations_is_idempotent() {
  let (p, w) = paths();
  let image = |page_id, expected_generation, generation, payload: &[u8]| Image {
   page_id, expected_generation, generation, payload: payload.to_vec()
  };
  let transactions = vec![
   vec![
    image(0, None, 1, b"p0-v1"),
    image(1, None, 1, b"p1-v1"),
    image(2, None, 1, b"p2-v1"),
   ],
   vec![
    image(0, Some(1), 2, b"p0-v2"),
    image(2, Some(1), 2, b"p2-v2"),
   ],
   vec![
    image(0, Some(2), 3, b"p0-v3"),
    image(1, Some(1), 2, b"p1-v2"),
   ],
   vec![
    image(1, Some(2), 3, b"p1-v3"),
    image(2, Some(2), 3, b"p2-v3"),
   ],
  ];
  {
   let mut wal = OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();
   wal.write_all(&VERSION.to_le_bytes()).unwrap();
   for (index, transaction) in transactions.iter().enumerate() {
    let encoded = transaction.iter().map(encode_image).collect::<Result<Vec<_>, _>>().unwrap();
    write_transaction_frames(&mut wal, index as u64 + 1, &encoded).unwrap();
   }
   wal.sync_all().unwrap();
  }
  {
   let mut pages = PageFile::open_for_recovery(&p).unwrap();
   pages.recover_allocate(0, 3, b"p0-v3").unwrap();
   pages.recover_allocate(1, 1, b"p1-v1").unwrap();
   pages.recover_allocate(2, 2, b"p2-v2").unwrap();
   pages.sync().unwrap();
  }
  // El estado físico simula una caída durante el apply: una página ya está
  // en la última generación, otra conserva una generación intermedia y otra
  // está corrupta. Redo debe converger sin retroceder ninguna página.
  let mut physical = std::fs::read(&p).unwrap();
  physical[crate::page::PAGE_SIZE + 30] ^= 0x6d;
  std::fs::write(&p, physical).unwrap();

  {
   let mut db = DurablePages::open(&p, &w).unwrap();
   for (id, expected) in [
    (0, b"p0-v3".as_slice()),
    (1, b"p1-v3".as_slice()),
    (2, b"p2-v3".as_slice()),
   ] {
    let page = db.read(id).unwrap();
    assert_eq!(page.generation, 3);
    assert_eq!(page.payload, expected);
   }
  }
  {
   let mut db = DurablePages::open(&p, &w).unwrap();
   for id in 0..3 {
    assert_eq!(db.read(id).unwrap().generation, 3);
   }
  }
  cleanup(p, w);
 }


 #[test]
 fn durable_pages_open_creates_missing_parent_directories() {
  let base = std::env::temp_dir().join(format!(
   "mlpj-new-parent-{}-{}",
   std::process::id(),
   SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
  ));
  let nested = base.join("level-one").join("level-two");
  let p = nested.join("pages.dat");
  let w = nested.join("journal.wal");
  {
   let mut db = DurablePages::open(&p, &w).unwrap();
   assert_eq!(db.allocate(1, b"created-under-new-parent").unwrap(), 0);
  }
  {
   let mut db = DurablePages::open(&p, &w).unwrap();
   assert_eq!(db.read(0).unwrap().payload, b"created-under-new-parent");
  }
  std::fs::remove_dir_all(base).unwrap();
 }


 #[test]
 fn long_wal_history_replays_streamingly_and_discards_incomplete_tail() {
  let (p, w) = paths();
  let committed_end;
  const COMMITS: u64 = 320;
  {
   let mut wal = OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();
   wal.write_all(&VERSION.to_le_bytes()).unwrap();
   for generation in 1..=COMMITS {
    let image = Image {
     page_id: 0,
     expected_generation: if generation == 1 { None } else { Some(generation - 1) },
     generation,
     payload: format!("durable-generation-{generation:04}").into_bytes(),
    };
    let encoded = encode_image(&image).unwrap();
    write_transaction_frames(&mut wal, generation, &[encoded]).unwrap();
   }
   committed_end = wal.stream_position().unwrap();
   write_frame(&mut wal, BEGIN, COMMITS + 1, &[]).unwrap();
   let abandoned = Image {
    page_id: 1,
    expected_generation: None,
    generation: 1,
    payload: b"uncommitted-allocation".to_vec(),
   };
   write_frame(&mut wal, IMAGE, COMMITS + 1, &encode_image(&abandoned).unwrap()).unwrap();
   wal.sync_all().unwrap();
  }
  // La página ya refleja un commit intermedio: recovery debe completar los
  // commits posteriores y no aplicar la asignación de la cola sin COMMIT.
  {
   let mut pages = PageFile::open_for_recovery(&p).unwrap();
   pages.recover_allocate(0, 173, b"durable-generation-0173").unwrap();
   pages.sync().unwrap();
  }
  {
   let mut db = DurablePages::open(&p, &w).unwrap();
   let page = db.read(0).unwrap();
   assert_eq!(page.generation, COMMITS);
   assert_eq!(page.payload, b"durable-generation-0320");
   assert_eq!(db.page_count(), 1);
   assert_eq!(std::fs::metadata(&w).unwrap().len(), committed_end);
  }
  {
   let mut db = DurablePages::open(&p, &w).unwrap();
   let page = db.read(0).unwrap();
   assert_eq!(page.generation, COMMITS);
   assert_eq!(page.payload, b"durable-generation-0320");
   assert_eq!(db.page_count(), 1);
  }
  cleanup(p, w);
 }

 #[test]
 fn recovery_rejects_valid_physical_page_with_wrong_payload_at_committed_generation() {
  let (p, w) = paths();
  {
   let mut wal = OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();
   wal.write_all(&VERSION.to_le_bytes()).unwrap();
   let image = Image {
    page_id: 0,
    expected_generation: None,
    generation: 7,
    payload: b"committed-authoritative-payload".to_vec(),
   };
   write_transaction_frames(&mut wal, 1, &[encode_image(&image).unwrap()]).unwrap();
   wal.sync_all().unwrap();
  }
  {
   let mut pages = PageFile::open_for_recovery(&p).unwrap();
   pages.recover_allocate(0, 7, b"different-but-checksummed-payload").unwrap();
   pages.sync().unwrap();
  }
  let pages_before = std::fs::read(&p).unwrap();
  let wal_before = std::fs::read(&w).unwrap();
  assert!(matches!(
   DurablePages::open(&p, &w),
   Err(JournalError::Corrupt("generación de página no coincide con WAL"))
  ));
  assert_eq!(std::fs::read(&p).unwrap(), pages_before);
  assert_eq!(std::fs::read(&w).unwrap(), wal_before);
  cleanup(p, w);
 }

 #[test]
 fn recovery_rejects_unjournaled_future_generation_without_mutating_files() {
  let (p,w)=paths();
  {
   let mut wal=OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();
   wal.write_all(&VERSION.to_le_bytes()).unwrap();
   let encoded=encode_image(&Image{
    page_id:0,expected_generation:None,generation:1,payload:b"committed".to_vec()
   }).unwrap();
   write_transaction_frames(&mut wal,1,&[encoded]).unwrap();
   wal.sync_all().unwrap();
  }
  {
   let mut pages=PageFile::open_for_recovery(&p).unwrap();
   pages.recover_allocate(0,9,b"unjournaled-future").unwrap();
   pages.sync().unwrap();
  }
  let pages_before=std::fs::read(&p).unwrap();
  let wal_before=std::fs::read(&w).unwrap();
  assert!(matches!(
   DurablePages::open(&p,&w),
   Err(JournalError::Corrupt("la página física no coincide con su última imagen WAL confirmada"))
  ));
  assert_eq!(std::fs::read(&p).unwrap(),pages_before);
  assert_eq!(std::fs::read(&w).unwrap(),wal_before);
  cleanup(p,w);
 }


 // Ejecuta un proceso hijo real que termina inmediatamente después de que
 // BEGIN + IMAGEs + COMMIT hayan sido sincronizados, antes de aplicar páginas.
 // A diferencia de las pruebas de fallo inyectado, aquí el kernel destruye
 // el proceso y libera sus locks sin ejecutar destructores Rust.
 #[test]
 fn abrupt_process_exit_after_durable_commit_is_recovered_on_reopen() {
  const PAGES_ENV: &str = "MLPJ_CRASH_CHILD_PAGES";
  const WAL_ENV: &str = "MLPJ_CRASH_CHILD_WAL";

  if let (Ok(pages_path), Ok(wal_path)) =
   (std::env::var(PAGES_ENV), std::env::var(WAL_ENV))
  {
   let mut db = DurablePages::open(&pages_path, &wal_path).unwrap();
   let images = vec![
    Image {
     page_id: 0,
     expected_generation: None,
     generation: 1,
     payload: b"first-page-after-process-crash".to_vec(),
    },
    Image {
     page_id: 1,
     expected_generation: None,
     generation: 1,
     payload: b"second-page-after-process-crash".to_vec(),
    },
   ];
   let _ = db.commit_images_with_apply(
    images,
    |wal, tx, encoded| persist_transaction(wal, tx, encoded),
    |_pages, _images| std::process::exit(73),
   );
   panic!("el proceso hijo debía terminar después del COMMIT durable");
  }

  let (pages_path, wal_path) = paths();
  let executable = std::env::current_exe().unwrap();
  let status = std::process::Command::new(executable)
   .arg("--exact")
   .arg("page_journal::tests::abrupt_process_exit_after_durable_commit_is_recovered_on_reopen")
   .arg("--nocapture")
   .env(PAGES_ENV, pages_path.to_string_lossy().as_ref())
   .env(WAL_ENV, wal_path.to_string_lossy().as_ref())
   .status()
   .unwrap();
  assert_eq!(status.code(), Some(73), "el proceso hijo no terminó en el punto de caída previsto");

  {
   let mut db = DurablePages::open(&pages_path, &wal_path).unwrap();
   assert_eq!(db.page_count(), 2);
   assert_eq!(db.read(0).unwrap().payload, b"first-page-after-process-crash");
   assert_eq!(db.read(1).unwrap().payload, b"second-page-after-process-crash");
  }
  {
   let mut db = DurablePages::open(&pages_path, &wal_path).unwrap();
   assert_eq!(db.page_count(), 2);
   assert_eq!(db.read(0).unwrap().generation, 1);
   assert_eq!(db.read(1).unwrap().generation, 1);
  }
  cleanup(pages_path, wal_path);
 }


 // La caída ocurre durante el apply: la primera página ya fue escrita,
 // pero la segunda todavía no. El proceso termina sin sync ni destructores;
 // la reapertura debe aceptar la primera imagen idempotentemente y aplicar la segunda.
 #[test]
 fn abrupt_process_exit_during_partial_page_apply_replays_remaining_images() {
  const PAGES_ENV: &str = "MLPJ_PARTIAL_CRASH_CHILD_PAGES";
  const WAL_ENV: &str = "MLPJ_PARTIAL_CRASH_CHILD_WAL";

  if let (Ok(pages_path), Ok(wal_path)) =
   (std::env::var(PAGES_ENV), std::env::var(WAL_ENV))
  {
   let mut db = DurablePages::open(&pages_path, &wal_path).unwrap();
   let images = vec![
    Image {
     page_id: 0,
     expected_generation: None,
     generation: 1,
     payload: b"first-page-applied-before-process-exit".to_vec(),
    },
    Image {
     page_id: 1,
     expected_generation: None,
     generation: 1,
     payload: b"second-page-must-be-replayed".to_vec(),
    },
   ];
   let _ = db.commit_images_with_apply(
    images,
    |wal, tx, encoded| persist_transaction(wal, tx, encoded),
    |pages, images| {
     apply_image(pages, &images[0])?;
     std::process::exit(74);
    },
   );
   panic!("el proceso hijo debía terminar durante el apply parcial");
  }

  let (pages_path, wal_path) = paths();
  let executable = std::env::current_exe().unwrap();
  let status = std::process::Command::new(executable)
   .arg("--exact")
   .arg("page_journal::tests::abrupt_process_exit_during_partial_page_apply_replays_remaining_images")
   .arg("--nocapture")
   .env(PAGES_ENV, pages_path.to_string_lossy().as_ref())
   .env(WAL_ENV, wal_path.to_string_lossy().as_ref())
   .status()
   .unwrap();
  assert_eq!(status.code(), Some(74), "el proceso hijo no terminó durante el apply parcial");

  {
   let mut db = DurablePages::open(&pages_path, &wal_path).unwrap();
   assert_eq!(db.page_count(), 2);
   assert_eq!(db.read(0).unwrap().payload, b"first-page-applied-before-process-exit");
   assert_eq!(db.read(1).unwrap().payload, b"second-page-must-be-replayed");
  }
  {
   let mut db = DurablePages::open(&pages_path, &wal_path).unwrap();
   assert_eq!(db.read(0).unwrap().payload, b"first-page-applied-before-process-exit");
   assert_eq!(db.read(1).unwrap().payload, b"second-page-must-be-replayed");
  }
  cleanup(pages_path, wal_path);
 }


 #[test]
 fn recovery_redo_truncation_after_first_commit_is_safe_on_reopen() {
  let (p, w) = paths();
  let first_commit_end;
  {
   let mut wal = OpenOptions::new().read(true).write(true).create(true).open(&w).unwrap();
   wal.write_all(MAGIC).unwrap();
   wal.write_all(&VERSION.to_le_bytes()).unwrap();
   let first = Image {
    page_id: 0,
    expected_generation: None,
    generation: 1,
    payload: b"first-commit-remains-authoritative".to_vec(),
   };
   write_transaction_frames(&mut wal, 1, &[encode_image(&first).unwrap()]).unwrap();
   first_commit_end = wal.stream_position().unwrap();
   let second = Image {
    page_id: 1,
    expected_generation: None,
    generation: 1,
    payload: b"second-commit-is-cut-during-redo".to_vec(),
   };
   write_transaction_frames(&mut wal, 2, &[encode_image(&second).unwrap()]).unwrap();
   wal.sync_all().unwrap();
  }

  // La primera pasada valida ambos commits. Entre pasadas, el WAL pierde
  // parte del payload IMAGE de la segunda transacción. Redo puede aplicar
  // el primer commit, pero debe fallar antes de materializar el segundo.
  {
   let mut wal = OpenOptions::new().read(true).write(true).open(&w).unwrap();
   let mut pages = PageFile::open_for_recovery(&p).unwrap();
   let result = recover_with_interpass(&mut wal, &mut pages, |wal| {
    wal.set_len(first_commit_end + (2 * FRAME_HEADER + 7) as u64)?;
    wal.sync_all()?;
    Ok(())
   });
   assert!(matches!(result, Err(JournalError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof));
   assert_eq!(pages.page_count(), 1);
   assert_eq!(pages.read(0).unwrap().payload, b"first-commit-remains-authoritative");
  }

  // La siguiente apertura vuelve a validar el WAL tal como quedó: conserva
  // el primer COMMIT, descarta la cola parcial y completa la recuperación.
  {
   let mut db = DurablePages::open(&p, &w).unwrap();
   assert_eq!(db.page_count(), 1);
   assert_eq!(db.read(0).unwrap().payload, b"first-commit-remains-authoritative");
   assert_eq!(std::fs::metadata(&w).unwrap().len(), first_commit_end);
   assert_eq!(db.allocate(1, b"next-after-safe-recovery").unwrap(), 1);
  }
  {
   let mut db = DurablePages::open(&p, &w).unwrap();
   assert_eq!(db.page_count(), 2);
   assert_eq!(db.read(0).unwrap().payload, b"first-commit-remains-authoritative");
   assert_eq!(db.read(1).unwrap().payload, b"next-after-safe-recovery");
  }
  cleanup(p, w);
 }

}
