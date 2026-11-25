//! Archivo de páginas fijas MLPG v1. No implementa todavía B-tree ni buffer pool.
use std::fs::{File,OpenOptions};
use std::io::{self,Read,Seek,SeekFrom,Write};
use std::path::{Path,PathBuf};

pub const PAGE_SIZE:usize=4096;
const MAGIC:&[u8;4]=b"MLPG";
const VERSION:u16=1;
const HEADER:usize=30;
const MAX_PAYLOAD:usize=PAGE_SIZE-HEADER;

#[derive(Debug)]
pub enum PageError { Io(io::Error), Corrupt(&'static str), Invalid(&'static str) }
impl From<io::Error> for PageError { fn from(e:io::Error)->Self{Self::Io(e)} }
impl std::fmt::Display for PageError {
 fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {
  match self {Self::Io(e)=>write!(f,"I/O de páginas: {e}"),Self::Corrupt(s)=>write!(f,"página corrupta: {s}"),Self::Invalid(s)=>write!(f,"operación de página inválida: {s}")}
 }
}
impl std::error::Error for PageError {}

fn open_page_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    // Las nuevas bases contienen texto privado de los escritores.
    // En Unix, no permitir lectura/escritura por grupo u otros usuarios.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // Linux/Android: rechazar symlinks en la propia operación open(), no
    // solamente mediante una comprobación previa susceptible a TOCTOU.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        const O_NOFOLLOW: i32 = 0x20_000;
        options.custom_flags(O_NOFOLLOW);
    }
    options.open(path)
}

pub struct PageFile { file:File, path:PathBuf, count:u64, recovery_tail_page:Option<u64>, #[cfg(test)] pub(crate) fail_write_after:Option<usize> }

#[derive(Clone,Debug,Eq,PartialEq)]
pub struct Page { pub page_id:u64, pub generation:u64, pub payload:Vec<u8> }

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
 left.is_file() && right.is_file() && left.len() == right.len()
}


/// Abre el archivo de páginas y valida que el descriptor corresponde al path.
/// Abre una generación existente sin crear archivos si alguien elimina una ruta.
pub(crate) fn open_existing_page_file_read_only_checked(path:&Path)->Result<File,PageError>{
 let before=std::fs::symlink_metadata(path)?;
 if before.file_type().is_symlink() || !before.is_file(){return Err(PageError::Invalid("archivo MLPG publicado no es regular"));}
 let mut options=OpenOptions::new(); options.read(true);
 #[cfg(any(target_os="linux",target_os="android"))] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(0x20_000); }
 let file=options.open(path)?;
 let opened=file.metadata()?; let after=std::fs::symlink_metadata(path)?;
 if !opened.is_file() || after.file_type().is_symlink() || !after.is_file()
  || !same_file_identity(&before,&opened) || !same_file_identity(&opened,&after){
  return Err(PageError::Invalid("el archivo MLPG publicado cambió durante la apertura"));
 }
 Ok(file)
}

pub(crate) fn open_existing_page_file_checked(path:&Path)->Result<File,PageError>{
 let before=std::fs::symlink_metadata(path)?;
 if before.file_type().is_symlink() || !before.is_file(){return Err(PageError::Invalid("archivo MLPG no es regular"));}
 let mut options=OpenOptions::new(); options.read(true).write(true);
 #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
 #[cfg(any(target_os="linux",target_os="android"))] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(0x20_000); }
 let file=options.open(path)?;
 let opened=file.metadata()?; let after=std::fs::symlink_metadata(path)?;
 if !opened.is_file() || after.file_type().is_symlink() || !after.is_file()
  || !same_file_identity(&before,&opened) || !same_file_identity(&opened,&after){
  return Err(PageError::Invalid("el archivo MLPG cambió durante la apertura"));
 }
 Ok(file)
}

pub(crate) fn open_page_file_checked(path:&Path)->Result<File,PageError>{
 let path_metadata=match std::fs::symlink_metadata(path){
  Ok(metadata)=>{
   if metadata.file_type().is_symlink() || !metadata.is_file(){
    return Err(PageError::Invalid("archivo MLPG no es regular"));
   }
   Some(metadata)
  }
  Err(error) if error.kind()==io::ErrorKind::NotFound=>None,
  Err(error)=>return Err(PageError::Io(error)),
 };
 let file=open_page_file(path)?;
 let opened=file.metadata()?;
 let current=std::fs::symlink_metadata(path)?;
 if !opened.is_file() || current.file_type().is_symlink() || !current.is_file()
  || !same_file_identity(&opened,&current)
  || path_metadata.as_ref().is_some_and(|before|!same_file_identity(before,&opened))
 {
  return Err(PageError::Invalid("el archivo MLPG cambió durante la apertura"));
 }
 Ok(file)
}

impl PageFile {
 pub fn open(path:impl AsRef<Path>)->Result<Self,PageError>{
  let path=path.as_ref();
  if let Ok(metadata)=std::fs::metadata(path){
   if metadata.len()%(PAGE_SIZE as u64)!=0{
    return Err(PageError::Corrupt("última página incompleta; se requiere recuperación WAL"));
   }
  }
  let mut this=Self::open_for_recovery(path)?;
  for id in 0..this.count { this.read(id)?; }
  Ok(this)
 }
 /// Abre sin validar cada página; reservado para recuperación WAL antes de exponer datos.
 pub fn open_for_recovery(path:impl AsRef<Path>)->Result<Self,PageError>{
  let path=path.as_ref().to_path_buf();
  let file=open_page_file_checked(&path)?;
  Self::from_open_file(path,file)
 }
 /// Construye PageFile usando exactamente el descriptor ya verificado por el llamador.
 /// No vuelve a abrir la ruta: así el descriptor hasheado puede ser el de recovery.
 pub(crate) fn from_open_file(path:impl AsRef<Path>,mut file:File)->Result<Self,PageError>{
  let path=path.as_ref().to_path_buf();
  let opened_metadata=file.metadata()?;
  if !opened_metadata.is_file(){
   return Err(PageError::Invalid("descriptor MLPG no es archivo regular"));
  }
  let current_path_metadata=std::fs::symlink_metadata(&path)?;
  if current_path_metadata.file_type().is_symlink() || !current_path_metadata.is_file()
   || !same_file_identity(&opened_metadata,&current_path_metadata)
  {
   return Err(PageError::Invalid("el archivo MLPG cambió durante la apertura"));
  }
  let len=opened_metadata.len();
  let complete=len/(PAGE_SIZE as u64);
  let recovery_tail_page=if len%(PAGE_SIZE as u64)!=0 {Some(complete)} else {None};
  file.seek(SeekFrom::End(0))?;
  Ok(Self{file,path,count:complete,recovery_tail_page,#[cfg(test)] fail_write_after:None})
 }
 pub fn path(&self)->&Path{&self.path}
 /// Comprueba que la ruta sigue identificando el descriptor de páginas abierto.
 /// Evita escribir sobre un inode desvinculado tras sustituir el archivo durante la sesión.
 pub(crate) fn validate_path_identity(&self)->Result<(),PageError>{
  let opened=self.file.metadata()?;
  let current=std::fs::symlink_metadata(&self.path)?;
  if !opened.is_file() || current.file_type().is_symlink() || !current.is_file()
   || !same_file_identity(&opened,&current){
   return Err(PageError::Invalid("el archivo MLPG fue sustituido durante la sesión"));
  }
  Ok(())
 }
 pub fn page_count(&self)->u64{self.count}
 /// Índice de la página parcial detectada; el WAL debe reconstruirla antes de exponer la base.
 pub(crate) fn recovery_tail_page(&self)->Option<u64>{self.recovery_tail_page}
 pub fn allocate(&mut self,generation:u64,payload:&[u8])->Result<u64,PageError>{
  let id=self.count;
  self.write_new(id,generation,payload)?;
  self.count+=1;
  Ok(id)
 }
 pub fn read(&mut self,page_id:u64)->Result<Page,PageError>{
  self.validate_path_identity()?;
  if page_id>=self.count{return Err(PageError::Invalid("page_id fuera del archivo"));}
  let mut raw=vec![0u8;PAGE_SIZE];
  self.file.seek(SeekFrom::Start(page_id*(PAGE_SIZE as u64)))?;
  self.file.read_exact(&mut raw)?;
  if &raw[..4]!=MAGIC{return Err(PageError::Corrupt("magic MLPG incorrecto"));}
  if u16::from_le_bytes(raw[4..6].try_into().unwrap())!=VERSION{return Err(PageError::Corrupt("versión de página no soportada"));}
  let stored_id=u64::from_le_bytes(raw[6..14].try_into().unwrap());
  if stored_id!=page_id{return Err(PageError::Corrupt("page_id no coincide con su posición física"));}
  let generation=u64::from_le_bytes(raw[14..22].try_into().unwrap());
  let len=u32::from_le_bytes(raw[22..26].try_into().unwrap()) as usize;
  let sum=u32::from_le_bytes(raw[26..30].try_into().unwrap());
  if len>MAX_PAYLOAD{return Err(PageError::Corrupt("longitud excede la página"));}
  let payload=raw[HEADER..HEADER+len].to_vec();
  if checksum(page_id,generation,&payload)!=sum{return Err(PageError::Corrupt("checksum no coincide"));}
  Ok(Page{page_id,generation,payload})
 }
 pub fn overwrite(&mut self,page_id:u64,generation:u64,payload:&[u8])->Result<(),PageError>{
  if page_id>=self.count{return Err(PageError::Invalid("page_id fuera del archivo"));}
  self.write_new(page_id,generation,payload)
 }
 /// Reemplaza una página existente incluso si su checksum está dañado; solo usar durante redo WAL.
 pub fn repair_overwrite(&mut self,page_id:u64,generation:u64,payload:&[u8])->Result<(),PageError>{
  if page_id>=self.count{return Err(PageError::Invalid("page_id fuera del archivo"));}
  self.write_new(page_id,generation,payload)
 }
 /// Añade una página con un ID explícito contiguo; solo usar durante redo WAL.
 pub fn recover_allocate(&mut self,page_id:u64,generation:u64,payload:&[u8])->Result<(),PageError>{
  if page_id!=self.count{return Err(PageError::Invalid("page_id de recuperación no contiguo"));}
  self.write_new(page_id,generation,payload)?;
  self.count+=1;
  Ok(())
 }
 pub fn sync(&mut self)->Result<(),PageError>{self.validate_path_identity()?;sync_page_file(&mut self.file)}
 fn write_new(&mut self,page_id:u64,generation:u64,payload:&[u8])->Result<(),PageError>{
  self.validate_path_identity()?;
  if payload.len()>MAX_PAYLOAD{return Err(PageError::Invalid("payload supera 4066 bytes"));}
  let mut raw=vec![0u8;PAGE_SIZE];
  raw[..4].copy_from_slice(MAGIC);
  raw[4..6].copy_from_slice(&VERSION.to_le_bytes());
  raw[6..14].copy_from_slice(&page_id.to_le_bytes());
  raw[14..22].copy_from_slice(&generation.to_le_bytes());
  raw[22..26].copy_from_slice(&(payload.len() as u32).to_le_bytes());
  raw[26..30].copy_from_slice(&checksum(page_id,generation,payload).to_le_bytes());
  raw[HEADER..HEADER+payload.len()].copy_from_slice(payload);
  #[cfg(test)]
  if let Some(remaining)=self.fail_write_after.take() {
   let mut failing=PageWriteFailAfter{file:&mut self.file,remaining};
   write_page_bytes(&mut failing,page_id,&raw)?;
   return Ok(());
  }
  write_page_bytes(&mut self.file,page_id,&raw)?;
  Ok(())
 }
}
#[cfg(test)]
struct PageWriteFailAfter<'a>{file:&'a mut File,remaining:usize}
#[cfg(test)]
impl Write for PageWriteFailAfter<'_>{
 fn write(&mut self,buf:&[u8])->io::Result<usize>{
  if self.remaining==0{return Err(io::Error::new(io::ErrorKind::Other,"fallo de escritura MLPG inyectado"));}
  let n=buf.len().min(self.remaining);
  let written=self.file.write(&buf[..n])?;
  self.remaining-=written;
  Ok(written)
 }
 fn flush(&mut self)->io::Result<()>{self.file.flush()}
}
#[cfg(test)]
impl Seek for PageWriteFailAfter<'_>{
 fn seek(&mut self,pos:SeekFrom)->io::Result<u64>{self.file.seek(pos)}
}
trait DurableSync { fn sync_durable(&mut self)->io::Result<()>; }
impl DurableSync for File { fn sync_durable(&mut self)->io::Result<()>{self.sync_all()} }
fn sync_page_file<F:DurableSync>(file:&mut F)->Result<(),PageError>{
 file.sync_durable()?;
 Ok(())
}
fn write_page_bytes<W:Write+Seek>(file:&mut W,page_id:u64,raw:&[u8])->Result<(),PageError>{
 if raw.len()!=PAGE_SIZE{return Err(PageError::Invalid("bloque de página de tamaño incorrecto"));}
 file.seek(SeekFrom::Start(page_id*(PAGE_SIZE as u64)))?;
 file.write_all(raw)?;
 Ok(())
}
fn checksum(id:u64,generation:u64,payload:&[u8])->u32{
 let mut h=0x811c9dc5u32;
 for b in id.to_le_bytes().into_iter().chain(generation.to_le_bytes()).chain(payload.iter().copied()){h^=b as u32;h=h.wrapping_mul(0x01000193);}
 h
}

#[cfg(test)]
mod tests{
 use super::*;
 use std::time::{SystemTime,UNIX_EPOCH};
 fn temp()->PathBuf{let n=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();std::env::temp_dir().join(format!("mlpg-{}-{n}.dat",std::process::id()))}
 struct FailAfter<'a>{file:&'a mut File,remaining:usize}
 impl Write for FailAfter<'_>{
  fn write(&mut self,buf:&[u8])->io::Result<usize>{
   if self.remaining==0{return Err(io::Error::new(io::ErrorKind::Other,"fallo de escritura de página inyectado"));}
   let n=buf.len().min(self.remaining);
   let written=self.file.write(&buf[..n])?;
   self.remaining-=written;
   Ok(written)
  }
  fn flush(&mut self)->io::Result<()>{self.file.flush()}
 }
 impl Seek for FailAfter<'_>{
  fn seek(&mut self,pos:SeekFrom)->io::Result<u64>{self.file.seek(pos)}
 }
 #[test]fn interrupted_page_write_leaves_detectable_torn_tail(){
  let p=temp();
  {
   let mut file=OpenOptions::new().read(true).write(true).create(true).open(&p).unwrap();
   let raw=vec![0x5a;PAGE_SIZE];
   let mut failing=FailAfter{file:&mut file,remaining:PAGE_SIZE/2};
   assert!(matches!(write_page_bytes(&mut failing,0,&raw),Err(PageError::Io(_))));
  }
  {
   let pages=PageFile::open_for_recovery(&p).unwrap();
   assert_eq!(pages.page_count(),0);
   assert_eq!(pages.recovery_tail_page(),Some(0));
  }
  assert_eq!(std::fs::metadata(&p).unwrap().len(),(PAGE_SIZE/2) as u64);
  let _=std::fs::remove_file(p);
 }
 struct FailSync<'a>{file:&'a mut File}
 impl DurableSync for FailSync<'_>{
  fn sync_durable(&mut self)->io::Result<()>{Err(io::Error::new(io::ErrorKind::Other,"fallo de sync de páginas inyectado"))}
 }
 #[test]fn page_sync_failure_is_reported_and_retry_can_succeed(){
  let p=temp();
  {
   let mut file=OpenOptions::new().read(true).write(true).create(true).open(&p).unwrap();
   let raw=vec![0x31;PAGE_SIZE];
   write_page_bytes(&mut file,0,&raw).unwrap();
   {
    let mut failing=FailSync{file:&mut file};
    assert!(matches!(sync_page_file(&mut failing),Err(PageError::Io(_))));
   }
   // El error de sync no implica que los bytes no estén presentes;
   // una sincronización posterior real permite cerrar el ciclo.
   file.sync_all().unwrap();
  }
  assert_eq!(std::fs::metadata(&p).unwrap().len(),PAGE_SIZE as u64);
  let _=std::fs::remove_file(p);
 }
 #[cfg(unix)]
 #[test]fn recovery_open_rejects_symbolic_link_page_file(){
  use std::os::unix::fs::symlink;
  let target=temp();
  let link=temp();
  std::fs::write(&target, []).unwrap();
  symlink(&target,&link).unwrap();
  assert!(matches!(
   PageFile::open_for_recovery(&link),
   Err(PageError::Invalid("archivo MLPG no es regular"))
  ));
  let _=std::fs::remove_file(link);
  let _=std::fs::remove_file(target);
 }
 #[test]fn fixed_page_roundtrip_and_reopen(){let p=temp();{let mut f=PageFile::open(&p).unwrap();let id=f.allocate(7,b"page-data").unwrap();assert_eq!(id,0);f.sync().unwrap();}{let mut f=PageFile::open(&p).unwrap();let page=f.read(0).unwrap();assert_eq!(page.generation,7);assert_eq!(page.payload,b"page-data");}let _=std::fs::remove_file(p);}
 #[test]fn plain_open_rejects_torn_tail_without_wal_recovery(){
  let p=temp();
  {
   let mut pages=PageFile::open(&p).unwrap();
   pages.allocate(1,b"must-not-disappear").unwrap();
   pages.sync().unwrap();
  }
  let file=OpenOptions::new().write(true).open(&p).unwrap();
  file.set_len((PAGE_SIZE/2) as u64).unwrap();
  drop(file);
  assert!(matches!(PageFile::open(&p),Err(PageError::Corrupt("última página incompleta; se requiere recuperación WAL"))));
  assert_eq!(std::fs::metadata(&p).unwrap().len(),(PAGE_SIZE/2) as u64);
  let _=std::fs::remove_file(p);
 }
 #[cfg(windows)]
 #[test]
 fn windows_file_identity_rejects_distinct_same_length_files(){
  let first=temp();let second=first.with_extension("other");
  std::fs::write(&first,b"same-size").unwrap();
  std::fs::write(&second,b"same-size").unwrap();
  let left=std::fs::metadata(&first).unwrap();
  let right=std::fs::metadata(&second).unwrap();
  assert!(!same_file_identity(&left,&right));
  let _=std::fs::remove_file(first);let _=std::fs::remove_file(second);
 }

 #[test]fn detects_page_payload_corruption(){
  let p=temp();
  {let mut f=PageFile::open(&p).unwrap();f.allocate(1,b"integrity").unwrap();f.sync().unwrap();}
  let mut bytes=std::fs::read(&p).unwrap();bytes[HEADER]^=0x01;std::fs::write(&p,&bytes).unwrap();
  let result=PageFile::open(&p);
  assert!(matches!(result,Err(PageError::Corrupt("checksum no coincide"))));
  let _=std::fs::remove_file(p);
 }
 #[test]fn overwrite_persists_new_generation(){
  let p=temp();
  {let mut f=PageFile::open(&p).unwrap();let id=f.allocate(1,b"old").unwrap();f.overwrite(id,2,b"new").unwrap();f.sync().unwrap();}
  {let mut f=PageFile::open(&p).unwrap();let page=f.read(0).unwrap();assert_eq!(page.generation,2);assert_eq!(page.payload,b"new");}
  let _=std::fs::remove_file(p);
 }
 #[test]fn rejects_oversized_page(){let p=temp();let mut f=PageFile::open(&p).unwrap();assert!(f.allocate(1,&vec![0;MAX_PAYLOAD+1]).is_err());let _=std::fs::remove_file(p);}
}
