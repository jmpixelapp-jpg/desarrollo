//! Núcleo experimental de almacenamiento MLDB.
//! Incluye WAL de registros legado, páginas durables, B+Tree persistente y
//! fachada de registros aislados por project_id con lotes atómicos MLPJ.
//! Incluye importación reanudable, verificación independiente y publicación por generaciones
//! con reconciliación ante interrupciones. El crate `engine` integra el acceso anfitrión
//! mediante `HostEngineApi`; el almacenamiento mantiene su contrato independiente.
//! La suite de estrés/recuperación está implementada parcialmente y requiere ejecución
//! verificable en CI nativo Linux/Windows/macOS antes de declarar cobertura validada.

pub mod page;
pub mod slotted_page;
pub mod btree_node;
pub mod btree;
pub mod page_journal;
pub mod interprocess_lock;
pub mod page_reuse;
pub mod project_store;
pub mod migration;
pub mod migration_manifest;
pub mod publication;
pub mod bundle;

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use interprocess_lock::{InterprocessLock, LockError};

const FILE_MAGIC: &[u8; 8] = b"MLWAL\r\n\x1a";
const FILE_VERSION: u32 = 1;
const HEADER_LEN: u64 = 12;
const FRAME_MAGIC: &[u8; 4] = b"MLFR";
const MAX_FRAME: usize = 64 * 1024 * 1024;
const BEGIN: u8 = 1;
const PUT: u8 = 2;
const DELETE: u8 = 3;
const COMMIT: u8 = 4;

#[derive(Debug)]
pub enum Error {
    Io(io::Error),
    Corrupt(&'static str),
    InvalidInput(&'static str),
    AlreadyLocked,
    RecoveryRequired,
    Poisoned,
}

/// Resultado de recorrer un snapshot lógico del WAL legado.
/// El error del visitante se conserva sin convertirlo ni ocultarlo.
#[derive(Debug)]
pub enum StoreSnapshotError<E> {
    RecoveryRequired,
    Poisoned,
    Visitor(E),
}

impl From<io::Error> for Error { fn from(e: io::Error) -> Self { Self::Io(e) } }
fn map_lock_error(e: LockError) -> Error {
    match e {
        LockError::AlreadyLocked => Error::AlreadyLocked,
        LockError::UnsupportedPlatform => Error::InvalidInput("bloqueo interproceso no disponible en esta plataforma"),
        LockError::Io(e) => Error::Io(e),
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "I/O: {e}"),
            Self::Corrupt(s) => write!(f, "archivo WAL corrupto: {s}"),
            Self::InvalidInput(s) => write!(f, "entrada inválida: {s}"),
            Self::AlreadyLocked => write!(f, "la base ya está abierta por otro proceso"),
            Self::RecoveryRequired => write!(f, "se requiere cerrar y reabrir la base para resolver una escritura WAL ambigua"),
            Self::Poisoned => write!(f, "bloqueo interno envenenado"),
        }
    }
}
impl std::error::Error for Error {}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct Key { project: String, table: String, id: String }

#[derive(Clone)]
enum Op { Put(Key, Vec<u8>), Delete(Key) }

struct Inner {
    file: File,
    path: PathBuf,
    next_tx: u64,
    rows: BTreeMap<Key, Vec<u8>>,
    recovery_required: bool,
    // Se declara después del File: el WAL se cierra antes de liberar el guard.
    _lock: InterprocessLock,
}

#[derive(Clone)]
pub struct Store { inner: Arc<Mutex<Inner>> }

/// Vista de snapshot que mantiene bloqueadas las escrituras del mismo Store
/// durante todo el recorrido. No clona el mapa ni los valores.
pub struct StoreSnapshot<'a> {
    guard: MutexGuard<'a, Inner>,
}

impl StoreSnapshot<'_> {
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str, &str, &[u8])> + '_ {
        self.guard.rows.iter().map(|(key, value)| (
            key.project.as_str(),
            key.table.as_str(),
            key.id.as_str(),
            value.as_slice(),
        ))
    }

    pub fn len(&self) -> usize {
        self.guard.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.guard.rows.is_empty()
    }
}

impl Store {
    /// Abre o crea un WAL. La recuperación se ejecuta antes de devolver el Store.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let path = path.as_ref().to_path_buf();
        let lock = InterprocessLock::acquire_for(&path).map_err(map_lock_error)?;
        let mut file = OpenOptions::new().read(true).write(true).create(true).open(&path)?;
        if file.metadata()?.len() == 0 {
            file.write_all(FILE_MAGIC)?;
            file.write_all(&FILE_VERSION.to_le_bytes())?;
            file.sync_all()?;
        }
        let (rows, next_tx, committed_end) = recover(&mut file)?;
        let len = file.metadata()?.len();
        if committed_end < len {
            file.set_len(committed_end)?;
            file.sync_all()?;
        }
        file.seek(SeekFrom::End(0))?;
        Ok(Self { inner: Arc::new(Mutex::new(Inner { file, path, next_tx, rows, recovery_required: false, _lock: lock })) })
    }

    /// Guarda bytes bajo una clave siempre vinculada a un proyecto.
    pub fn put_project(&self, project_id: &str, table: &str, record_id: &str, value: &[u8]) -> Result<(), Error> {
        validate_key(project_id, table, record_id)?;
        self.commit(vec![Op::Put(Key { project: project_id.into(), table: table.into(), id: record_id.into() }, value.to_vec())])
    }

    pub fn delete_project(&self, project_id: &str, table: &str, record_id: &str) -> Result<(), Error> {
        validate_key(project_id, table, record_id)?;
        self.commit(vec![Op::Delete(Key { project: project_id.into(), table: table.into(), id: record_id.into() })])
    }

    /// La clave de lectura requiere project_id; no existe búsqueda global por record_id.
    pub fn get_project(&self, project_id: &str, table: &str, record_id: &str) -> Result<Option<Vec<u8>>, Error> {
        validate_key(project_id, table, record_id)?;
        let guard = self.inner.lock().map_err(|_| Error::Poisoned)?;
        if guard.recovery_required { return Err(Error::RecoveryRequired); }
        Ok(guard.rows.get(&Key { project: project_id.into(), table: table.into(), id: record_id.into() }).cloned())
    }

    /// Ejecuta varias operaciones como una única transacción durable.
    pub fn transaction(&self, operations: Vec<Operation>) -> Result<(), Error> {
        if operations.is_empty() { return Err(Error::InvalidInput("transacción vacía")); }
        let mut ops = Vec::with_capacity(operations.len());
        for op in operations {
            match op {
                Operation::Put { project_id, table, record_id, value } => {
                    validate_key(&project_id, &table, &record_id)?;
                    ops.push(Op::Put(Key { project: project_id, table, id: record_id }, value));
                }
                Operation::Delete { project_id, table, record_id } => {
                    validate_key(&project_id, &table, &record_id)?;
                    ops.push(Op::Delete(Key { project: project_id, table, id: record_id }));
                }
            }
        }
        self.commit(ops)
    }

    pub fn path(&self) -> Result<PathBuf, Error> {
        Ok(self.inner.lock().map_err(|_| Error::Poisoned)?.path.clone())
    }


    /// Adquiere una vista estable del WAL lógico. El guard mantiene el mutex
    /// hasta que StoreSnapshot se descarta, impidiendo escrituras concurrentes
    /// incluso mientras el llamador valida o publica una copia.
    pub fn snapshot(&self) -> Result<StoreSnapshot<'_>, Error> {
        let guard = self.inner.lock().map_err(|_| Error::Poisoned)?;
        if guard.recovery_required {
            return Err(Error::RecoveryRequired);
        }
        Ok(StoreSnapshot { guard })
    }

    /// Visita los registros recuperados en orden determinista de clave.
    ///
    /// El bloqueo interno se mantiene durante todo el recorrido: ninguna
    /// escritura del mismo Store puede intercalarse con el snapshot. Los bytes
    /// se prestan directamente desde el mapa y no se clonan en memoria.
    ///
    /// El visitante no debe volver a llamar a métodos del mismo Store porque
    /// el mutex permanece adquirido. Puede alimentar otro almacén, por ejemplo
    /// importando lotes a un ProjectStore temporal. Si devuelve un error, el
    /// recorrido se detiene y ese error se devuelve como Visitor(E).
    pub fn visit_records<E>(
        &self,
        mut visitor: impl FnMut(&str, &str, &str, &[u8]) -> Result<(), E>,
    ) -> Result<(), StoreSnapshotError<E>> {
        let guard = self.inner.lock().map_err(|_| StoreSnapshotError::Poisoned)?;
        if guard.recovery_required {
            return Err(StoreSnapshotError::RecoveryRequired);
        }
        for (key, value) in &guard.rows {
            visitor(&key.project, &key.table, &key.id, value)
                .map_err(StoreSnapshotError::Visitor)?;
        }
        Ok(())
    }

    fn commit(&self, ops: Vec<Op>) -> Result<(), Error> {
        self.commit_with_persist(ops, persist_transaction)
    }

    fn commit_with_persist<F>(&self, ops: Vec<Op>, persist: F) -> Result<(), Error>
    where
        F: FnOnce(&mut File, u64, &[(u8, Vec<u8>)]) -> Result<(), Error>,
    {
        if ops.is_empty() { return Err(Error::InvalidInput("transacción vacía")); }
        // Serializar y validar todo antes de tocar el WAL.
        let mut frames = Vec::with_capacity(ops.len());
        for op in &ops {
            match op {
                Op::Put(key, value) => frames.push((PUT, encode_put(key, value)?)),
                Op::Delete(key) => frames.push((DELETE, encode_key(key)?)),
            }
        }
        let mut inner = self.inner.lock().map_err(|_| Error::Poisoned)?;
        if inner.recovery_required { return Err(Error::RecoveryRequired); }
        let tx = inner.next_tx;
        let following_tx = tx.checked_add(1).ok_or(Error::Corrupt("contador de transacciones agotado"))?;
        // Si falla seek, aún no se ha intentado modificar el WAL.
        inner.file.seek(SeekFrom::End(0))?;
        if let Err(error) = persist(&mut inner.file, tx, &frames) {
            // La escritura o sync puede haber dejado un COMMIT durable. No truncar
            // ni reutilizar txid: cerrar y reabrir es la única resolución segura.
            inner.recovery_required = true;
            return Err(error);
        }
        for op in ops {
            match op {
                Op::Put(key, value) => { inner.rows.insert(key, value); }
                Op::Delete(key) => { inner.rows.remove(&key); }
            }
        }
        inner.next_tx = following_tx;
        Ok(())
    }
}

pub enum Operation {
    Put { project_id: String, table: String, record_id: String, value: Vec<u8> },
    Delete { project_id: String, table: String, record_id: String },
}

fn validate_key(project: &str, table: &str, id: &str) -> Result<(), Error> {
    if project.trim().is_empty() { return Err(Error::InvalidInput("project_id obligatorio")); }
    if table.trim().is_empty() { return Err(Error::InvalidInput("tabla obligatoria")); }
    if id.trim().is_empty() { return Err(Error::InvalidInput("record_id obligatorio")); }
    if project.len() > u16::MAX as usize || table.len() > u16::MAX as usize || id.len() > u32::MAX as usize {
        return Err(Error::InvalidInput("clave demasiado larga"));
    }
    Ok(())
}

fn encode_key(k: &Key) -> Result<Vec<u8>, Error> {
    validate_key(&k.project, &k.table, &k.id)?;
    let mut b = Vec::new();
    b.extend_from_slice(&(k.project.len() as u16).to_le_bytes());
    b.extend_from_slice(&(k.table.len() as u16).to_le_bytes());
    b.extend_from_slice(&(k.id.len() as u32).to_le_bytes());
    b.extend_from_slice(k.project.as_bytes()); b.extend_from_slice(k.table.as_bytes()); b.extend_from_slice(k.id.as_bytes());
    Ok(b)
}
fn encode_put(k: &Key, value: &[u8]) -> Result<Vec<u8>, Error> {
    if value.len() > MAX_FRAME { return Err(Error::InvalidInput("valor supera el máximo de frame")); }
    let mut b = encode_key(k)?;
    b.extend_from_slice(&(value.len() as u32).to_le_bytes()); b.extend_from_slice(value);
    Ok(b)
}
fn decode_key(data: &[u8]) -> Result<(Key, usize), Error> {
    if data.len() < 8 { return Err(Error::Corrupt("clave truncada")); }
    let pl = u16::from_le_bytes([data[0],data[1]]) as usize;
    let tl = u16::from_le_bytes([data[2],data[3]]) as usize;
    let il = u32::from_le_bytes([data[4],data[5],data[6],data[7]]) as usize;
    let end = 8usize.checked_add(pl).and_then(|x|x.checked_add(tl)).and_then(|x|x.checked_add(il)).ok_or(Error::Corrupt("longitud desbordada"))?;
    if end > data.len() { return Err(Error::Corrupt("clave incompleta")); }
    let p = std::str::from_utf8(&data[8..8+pl]).map_err(|_|Error::Corrupt("project_id no UTF-8"))?;
    let t = std::str::from_utf8(&data[8+pl..8+pl+tl]).map_err(|_|Error::Corrupt("tabla no UTF-8"))?;
    let i = std::str::from_utf8(&data[8+pl+tl..end]).map_err(|_|Error::Corrupt("record_id no UTF-8"))?;
    validate_key(p,t,i).map_err(|_|Error::Corrupt("clave vacía o inválida"))?;
    Ok((Key { project:p.into(), table:t.into(), id:i.into() }, end))
}
fn checksum(kind:u8, tx:u64, payload:&[u8])->u32 {
    // FNV-1a detecta daños accidentales; NO es criptografía ni autenticación.
    let mut h=0x811c9dc5u32;
    for b in std::iter::once(kind).chain(tx.to_le_bytes()).chain(payload.iter().copied()) { h^=b as u32; h=h.wrapping_mul(0x01000193); }
    h
}
fn persist_transaction(file: &mut File, tx: u64, frames: &[(u8, Vec<u8>)]) -> Result<(), Error> {
    write_frame(file, BEGIN, tx, &[])?;
    for (kind, payload) in frames {
        write_frame(file, *kind, tx, payload)?;
    }
    write_frame(file, COMMIT, tx, &[])?;
    file.sync_all()?;
    Ok(())
}

fn write_frame(file:&mut File, kind:u8, tx:u64, payload:&[u8])->Result<(),Error>{
    if payload.len()>MAX_FRAME{return Err(Error::InvalidInput("frame demasiado grande"));}
    file.write_all(FRAME_MAGIC)?; file.write_all(&[kind])?; file.write_all(&tx.to_le_bytes())?;
    file.write_all(&(payload.len() as u32).to_le_bytes())?; file.write_all(&checksum(kind,tx,payload).to_le_bytes())?;
    file.write_all(payload)?; Ok(())
}
fn recover(file:&mut File)->Result<(BTreeMap<Key,Vec<u8>>,u64,u64),Error>{
    file.seek(SeekFrom::Start(0))?;
    let mut header=[0u8;12];
    file.read_exact(&mut header).map_err(|_|Error::Corrupt("cabecera incompleta"))?;
    if &header[..8]!=FILE_MAGIC{return Err(Error::Corrupt("magic inválido"));}
    if u32::from_le_bytes(header[8..12].try_into().unwrap())!=FILE_VERSION{return Err(Error::Corrupt("versión no soportada"));}

    let mut rows=BTreeMap::new();
    let mut pending:Option<(u64,Vec<Op>)>=None;
    let mut committed=HEADER_LEN;
    let mut next_tx=1u64;
    let mut last_committed_tx=0u64;

    loop {
        let frame_start=file.stream_position()?;
        let mut head=[0u8;21];
        match file.read_exact(&mut head) {
            Ok(())=>{},
            // Solo un encabezado incompleto al final se considera cola interrumpida.
            Err(e) if e.kind()==io::ErrorKind::UnexpectedEof=>break,
            Err(e)=>return Err(Error::Io(e)),
        }
        if &head[..4]!=FRAME_MAGIC {
            return Err(Error::Corrupt("magic de frame inválido dentro del WAL"));
        }
        let kind=head[4];
        let tx=u64::from_le_bytes(head[5..13].try_into().unwrap());
        let len=u32::from_le_bytes(head[13..17].try_into().unwrap()) as usize;
        let sum=u32::from_le_bytes(head[17..21].try_into().unwrap());
        match pending.as_ref() {
            Some((pending_tx,_)) if *pending_tx!=tx =>
                return Err(Error::Corrupt("ID de frame no coincide con transacción pendiente")),
            Some(_) => {},
            None if kind==BEGIN && tx<=last_committed_tx =>
                return Err(Error::Corrupt("IDs de transacción no crecientes")),
            None => {},
        }
        if len>MAX_FRAME {
            return Err(Error::Corrupt("longitud de frame supera el máximo"));
        }
        let mut payload=vec![0u8;len];
        match file.read_exact(&mut payload) {
            Ok(())=>{},
            Err(e) if e.kind()==io::ErrorKind::UnexpectedEof=>break,
            Err(e)=>return Err(Error::Io(e)),
        }
        if checksum(kind,tx,&payload)!=sum {
            return Err(Error::Corrupt("checksum no coincide en frame completo"));
        }

        match kind {
            BEGIN if payload.is_empty() && pending.is_none() => {
                pending=Some((tx,Vec::new()));
            }
            PUT|DELETE => {
                let Some((pending_tx,ref mut ops))=pending else {
                    return Err(Error::Corrupt("operación fuera de una transacción"));
                };
                if pending_tx!=tx {
                    return Err(Error::Corrupt("ID de operación no coincide con BEGIN"));
                }
                if kind==PUT {
                    let (key,used)=decode_key(&payload).map_err(|_|Error::Corrupt("clave PUT inválida"))?;
                    if payload.len()<used+4 {
                        return Err(Error::Corrupt("payload PUT truncado dentro de frame completo"));
                    }
                    let value_len=u32::from_le_bytes(payload[used..used+4].try_into().unwrap()) as usize;
                    if payload.len()!=used+4+value_len {
                        return Err(Error::Corrupt("longitud de valor PUT inconsistente"));
                    }
                    ops.push(Op::Put(key,payload[used+4..].to_vec()));
                } else {
                    let (key,used)=decode_key(&payload).map_err(|_|Error::Corrupt("clave DELETE inválida"))?;
                    if used!=payload.len() {
                        return Err(Error::Corrupt("bytes sobrantes en DELETE"));
                    }
                    ops.push(Op::Delete(key));
                }
            }
            COMMIT if payload.is_empty() => {
                let Some((pending_tx,ops))=pending.take() else {
                    return Err(Error::Corrupt("COMMIT sin BEGIN"));
                };
                if pending_tx!=tx {
                    return Err(Error::Corrupt("ID de COMMIT no coincide con BEGIN"));
                }
                if ops.is_empty() {
                    return Err(Error::Corrupt("transacción confirmada sin operaciones"));
                }
                for op in ops {
                    match op {
                        Op::Put(key,value)=>{rows.insert(key,value);},
                        Op::Delete(key)=>{rows.remove(&key);},
                    }
                }
                committed=file.stream_position()?;
                last_committed_tx=tx;
                next_tx=tx.checked_add(1).ok_or(Error::Corrupt("contador de transacciones agotado"))?;
            }
            _ => return Err(Error::Corrupt("tipo de frame o estado transaccional inválido")),
        }
        if file.stream_position()?<=frame_start {
            return Err(Error::Corrupt("posición de lectura inválida"));
        }
    }
    // Si quedó una transacción pendiente o un frame parcial, open() trunca desde
    // committed; el próximo ID vuelve a ser el siguiente al último COMMIT durable.
    Ok((rows,next_tx,committed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime,UNIX_EPOCH};
    fn temp() -> PathBuf {
        let n=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("mldb-test-{}-{n}.wal",std::process::id()))
    }
    #[test] fn persists_and_recovers_committed_data(){
        let p=temp();
        {let db=Store::open(&p).unwrap(); db.put_project("book-A","records","same-id",b"A").unwrap();}
        {let db=Store::open(&p).unwrap(); assert_eq!(db.get_project("book-A","records","same-id").unwrap(),Some(b"A".to_vec()));}
        let _=std::fs::remove_file(p);
    }
    #[test] fn same_record_id_isolated_by_project(){
        let p=temp(); let db=Store::open(&p).unwrap();
        db.put_project("book-A","records","r1",b"A").unwrap();
        db.put_project("book-B","records","r1",b"B").unwrap();
        assert_eq!(db.get_project("book-A","records","r1").unwrap(),Some(b"A".to_vec()));
        assert_eq!(db.get_project("book-B","records","r1").unwrap(),Some(b"B".to_vec()));
        let _=std::fs::remove_file(p);
    }
    #[test] fn discards_incomplete_tail_and_keeps_committed_rows(){
        let p=temp();
        { let db=Store::open(&p).unwrap(); db.put_project("p","records","r1",b"durable").unwrap(); }
        { let mut f=OpenOptions::new().append(true).open(&p).unwrap(); f.write_all(b"MLFR\x01\x02").unwrap(); f.sync_all().unwrap(); }
        { let db=Store::open(&p).unwrap(); assert_eq!(db.get_project("p","records","r1").unwrap(),Some(b"durable".to_vec())); }
        let mut f=File::open(&p).unwrap(); let mut bytes=Vec::new(); f.read_to_end(&mut bytes).unwrap();
        assert!(!bytes.ends_with(b"MLFR\x01\x02"));
        let _=std::fs::remove_file(p);
    }
    #[test] fn delete_is_durable_after_reopen(){
        let p=temp();
        { let db=Store::open(&p).unwrap(); db.put_project("p","records","r",b"value").unwrap(); db.delete_project("p","records","r").unwrap(); }
        { let db=Store::open(&p).unwrap(); assert_eq!(db.get_project("p","records","r").unwrap(),None); }
        let _=std::fs::remove_file(p);
    }
    #[test] fn corrupted_last_transaction_is_rejected_as_complete_frame_corruption(){
        let p=temp();
        { let db=Store::open(&p).unwrap(); db.put_project("p","records","good",b"ok").unwrap(); db.put_project("p","records","bad",b"discard").unwrap(); }
        let mut bytes=std::fs::read(&p).unwrap();
        // El frame completo conserva longitud y magic, pero su checksum ya no coincide.
        let last=bytes.len()-1; bytes[last]^=0x5a; std::fs::write(&p,&bytes).unwrap();
        assert!(matches!(Store::open(&p),Err(Error::Corrupt("checksum no coincide en frame completo"))));
        let _=std::fs::remove_file(&p);
        let mut lock_name=p.file_name().unwrap().to_os_string(); lock_name.push(".mldb-lock");
        let _=std::fs::remove_file(p.with_file_name(lock_name));
    }

    #[test] fn recovery_fails_closed_on_interior_corruption_before_later_commit(){
        let p=temp();
        {
            let db=Store::open(&p).unwrap();
            db.put_project("p","records","first",b"one").unwrap();
            db.put_project("p","records","second",b"two").unwrap();
        }
        let mut bytes=std::fs::read(&p).unwrap();
        // Cabecera de archivo (12) + BEGIN (21): primer byte de checksum del primer PUT.
        bytes[12+21+17]^=0x01;
        std::fs::write(&p,&bytes).unwrap();
        assert!(matches!(Store::open(&p),Err(Error::Corrupt("checksum no coincide en frame completo"))));
        let _=std::fs::remove_file(&p);
        let mut lock_name=p.file_name().unwrap().to_os_string(); lock_name.push(".mldb-lock");
        let _=std::fs::remove_file(p.with_file_name(lock_name));
    }

    #[test] fn recovery_rejects_non_monotonic_transaction_ids(){
        let p=temp();
        {
            let mut file=OpenOptions::new().read(true).write(true).create(true).open(&p).unwrap();
            file.write_all(FILE_MAGIC).unwrap();
            file.write_all(&FILE_VERSION.to_le_bytes()).unwrap();
            write_frame(&mut file,BEGIN,1,&[]).unwrap();
            write_frame(&mut file,PUT,1,&encode_put(&Key{project:"p".into(),table:"t".into(),id:"a".into()},b"x").unwrap()).unwrap();
            write_frame(&mut file,COMMIT,1,&[]).unwrap();
            write_frame(&mut file,BEGIN,1,&[]).unwrap();
            write_frame(&mut file,COMMIT,1,&[]).unwrap();
            file.sync_all().unwrap();
        }
        assert!(matches!(Store::open(&p),Err(Error::Corrupt("IDs de transacción no crecientes"))));
        let _=std::fs::remove_file(&p);
        let mut lock_name=p.file_name().unwrap().to_os_string(); lock_name.push(".mldb-lock");
        let _=std::fs::remove_file(p.with_file_name(lock_name));
    }

    #[test] fn recovery_accepts_legacy_transaction_id_gaps(){
        let p=temp();
        {
            let mut file=OpenOptions::new().read(true).write(true).create(true).open(&p).unwrap();
            file.write_all(FILE_MAGIC).unwrap();
            file.write_all(&FILE_VERSION.to_le_bytes()).unwrap();
            let first=encode_put(&Key{project:"p".into(),table:"records".into(),id:"one".into()},b"one").unwrap();
            let third=encode_put(&Key{project:"p".into(),table:"records".into(),id:"three".into()},b"three").unwrap();
            write_frame(&mut file,BEGIN,1,&[]).unwrap();
            write_frame(&mut file,PUT,1,&first).unwrap();
            write_frame(&mut file,COMMIT,1,&[]).unwrap();
            // Versiones previas podían saltar IDs tras descartar una cola incompleta.
            write_frame(&mut file,BEGIN,3,&[]).unwrap();
            write_frame(&mut file,PUT,3,&third).unwrap();
            write_frame(&mut file,COMMIT,3,&[]).unwrap();
            file.sync_all().unwrap();
        }
        {
            let db=Store::open(&p).unwrap();
            assert_eq!(db.get_project("p","records","one").unwrap(),Some(b"one".to_vec()));
            assert_eq!(db.get_project("p","records","three").unwrap(),Some(b"three".to_vec()));
            db.put_project("p","records","four",b"four").unwrap();
        }
        {
            let db=Store::open(&p).unwrap();
            assert_eq!(db.get_project("p","records","four").unwrap(),Some(b"four".to_vec()));
        }
        cleanup_test_store(&p);
    }

    #[test] fn recovery_rejects_complete_invalid_frame_at_eof(){
        let p=temp();
        {
            let db=Store::open(&p).unwrap();
            db.put_project("p","records","r",b"value").unwrap();
        }
        {
            let mut file=OpenOptions::new().append(true).open(&p).unwrap();
            write_frame(&mut file,99,2,&[]).unwrap();
            file.sync_all().unwrap();
        }
        assert!(matches!(Store::open(&p),Err(Error::Corrupt("tipo de frame o estado transaccional inválido"))));
        let _=std::fs::remove_file(&p);
        let mut lock_name=p.file_name().unwrap().to_os_string(); lock_name.push(".mldb-lock");
        let _=std::fs::remove_file(p.with_file_name(lock_name));
    }
    #[test] fn rejects_missing_project(){
        let p=temp(); let db=Store::open(&p).unwrap();
        assert!(db.put_project("","records","r1",b"x").is_err());
        let _=std::fs::remove_file(p);
    }
    #[test] fn second_store_open_is_rejected_while_first_is_alive(){
        let p=temp();
        let db=Store::open(&p).unwrap();
        assert!(matches!(Store::open(&p),Err(Error::AlreadyLocked)));
        drop(db);
        let reopened=Store::open(&p).unwrap();
        drop(reopened);
        let _=std::fs::remove_file(&p);
        let mut lock_name=p.file_name().unwrap().to_os_string();
        lock_name.push(".mldb-lock");
        let _=std::fs::remove_file(p.with_file_name(lock_name));
    }
    fn cleanup_test_store(path: &Path) {
        let _ = std::fs::remove_file(path);
        let mut lock_name = path.file_name().unwrap().to_os_string();
        lock_name.push(".mldb-lock");
        let _ = std::fs::remove_file(path.with_file_name(lock_name));
    }

    #[test]
    fn ambiguous_error_after_durable_commit_requires_reopen_and_replays_commit() {
        let path = temp();
        {
            let db = Store::open(&path).unwrap();
            let operation = Op::Put(
                Key { project: "book".into(), table: "entities".into(), id: "e1".into() },
                b"durable-but-error-returned".to_vec(),
            );
            let result = db.commit_with_persist(vec![operation], |file, tx, frames| {
                persist_transaction(file, tx, frames)?;
                Err(Error::Io(io::Error::new(io::ErrorKind::Other, "sync outcome injected as ambiguous")))
            });
            assert!(matches!(result, Err(Error::Io(_))));
            assert!(matches!(db.get_project("book", "entities", "e1"), Err(Error::RecoveryRequired)));
            assert!(matches!(db.put_project("book", "entities", "e2", b"blocked"), Err(Error::RecoveryRequired)));
        }
        {
            let db = Store::open(&path).unwrap();
            assert_eq!(
                db.get_project("book", "entities", "e1").unwrap(),
                Some(b"durable-but-error-returned".to_vec())
            );
            assert_eq!(db.get_project("book", "entities", "e2").unwrap(), None);
        }
        cleanup_test_store(&path);
    }

    #[test]
    fn partial_legacy_wal_write_requires_reopen_then_discards_incomplete_transaction() {
        let path = temp();
        {
            let db = Store::open(&path).unwrap();
            let operation = Op::Put(
                Key { project: "book".into(), table: "records".into(), id: "r1".into() },
                b"not-committed".to_vec(),
            );
            let result = db.commit_with_persist(vec![operation], |file, tx, _frames| {
                write_frame(file, BEGIN, tx, &[])?;
                Err(Error::Io(io::Error::new(io::ErrorKind::Other, "partial WAL write injected")))
            });
            assert!(matches!(result, Err(Error::Io(_))));
            assert!(matches!(db.get_project("book", "records", "r1"), Err(Error::RecoveryRequired)));
        }
        {
            let db = Store::open(&path).unwrap();
            assert_eq!(db.get_project("book", "records", "r1").unwrap(), None);
            db.put_project("book", "records", "r2", b"after-reopen").unwrap();
        }
        {
            let db = Store::open(&path).unwrap();
            assert_eq!(db.get_project("book", "records", "r1").unwrap(), None);
            assert_eq!(db.get_project("book", "records", "r2").unwrap(), Some(b"after-reopen".to_vec()));
        }
        cleanup_test_store(&path);
    }

    #[test] fn transaction_is_replayed_as_a_unit(){
        let p=temp(); let db=Store::open(&p).unwrap();
        db.transaction(vec![
            Operation::Put{project_id:"p".into(),table:"records".into(),record_id:"1".into(),value:b"x".to_vec()},
            Operation::Put{project_id:"p".into(),table:"records".into(),record_id:"2".into(),value:b"y".to_vec()},
        ]).unwrap();
        drop(db); let db=Store::open(&p).unwrap();
        assert_eq!(db.get_project("p","records","1").unwrap(),Some(b"x".to_vec()));
        assert_eq!(db.get_project("p","records","2").unwrap(),Some(b"y".to_vec()));
        let _=std::fs::remove_file(p);
    }

    #[test]
    fn visit_records_exports_exact_bytes_in_deterministic_key_order() {
        let path = temp();
        let store = Store::open(&path).unwrap();
        store.put_project("book-b", "records", "same", b"second").unwrap();
        store.put_project("book-a", "records", "z\\0id", &[0, 255, 1, 0]).unwrap();
        store.put_project("book-a", "entities", "é", b"utf8-value").unwrap();
        store.put_project("book-a", "records", "a", b"first").unwrap();

        let mut snapshot = Vec::new();
        store.visit_records(|project, table, id, value| {
            snapshot.push((
                project.to_owned(),
                table.to_owned(),
                id.to_owned(),
                value.to_vec(),
            ));
            Ok::<(), ()>(())
        }).unwrap();

        assert_eq!(snapshot, vec![
            ("book-a".to_owned(), "entities".to_owned(), "é".to_owned(), b"utf8-value".to_vec()),
            ("book-a".to_owned(), "records".to_owned(), "a".to_owned(), b"first".to_vec()),
            ("book-a".to_owned(), "records".to_owned(), "z\\0id".to_owned(), vec![0, 255, 1, 0]),
            ("book-b".to_owned(), "records".to_owned(), "same".to_owned(), b"second".to_vec()),
        ]);
        drop(store);
        cleanup_test_store(&path);
    }

    #[test]
    fn visit_records_propagates_visitor_error_and_stops_immediately() {
        let path = temp();
        let store = Store::open(&path).unwrap();
        store.put_project("p", "records", "a", b"a").unwrap();
        store.put_project("p", "records", "b", b"b").unwrap();
        store.put_project("p", "records", "c", b"c").unwrap();

        let mut visited = 0usize;
        let result = store.visit_records(|_, _, _, _| {
            visited += 1;
            if visited == 2 { Err("stop snapshot") } else { Ok(()) }
        });
        assert!(matches!(result, Err(StoreSnapshotError::Visitor("stop snapshot"))));
        assert_eq!(visited, 2);
        assert_eq!(store.get_project("p", "records", "a").unwrap(), Some(b"a".to_vec()));
        assert_eq!(store.get_project("p", "records", "b").unwrap(), Some(b"b".to_vec()));
        assert_eq!(store.get_project("p", "records", "c").unwrap(), Some(b"c".to_vec()));
        drop(store);
        cleanup_test_store(&path);
    }

    #[test]
    fn visit_records_refuses_ambiguous_store_instance() {
        let path = temp();
        let store = Store::open(&path).unwrap();
        let operation = Op::Put(
            Key { project: "p".into(), table: "records".into(), id: "r".into() },
            b"ambiguous".to_vec(),
        );
        let result = store.commit_with_persist(vec![operation], |file, tx, frames| {
            persist_transaction(file, tx, frames)?;
            Err(Error::Io(io::Error::new(io::ErrorKind::Other, "ambiguous commit injected")))
        });
        assert!(matches!(result, Err(Error::Io(_))));

        let mut called = false;
        let snapshot = store.visit_records(|_, _, _, _| {
            called = true;
            Ok::<(), ()>(())
        });
        assert!(matches!(snapshot, Err(StoreSnapshotError::RecoveryRequired)));
        assert!(!called);
        drop(store);
        cleanup_test_store(&path);
    }



    #[test]
    fn legacy_snapshot_imports_chunked_batches_into_isolated_project_store() {
        let legacy_path = temp();
        let pages_path = temp().with_extension("mlpg");
        let journal_path = temp().with_extension("mlpj");

        {
            let legacy = Store::open(&legacy_path).unwrap();
            legacy.put_project("book-a", "entities", "e1", &[0, 255, 1, 0]).unwrap();
            legacy.put_project("book-a", "records", "id\0with-null", b"unicode-\xc3\xa9").unwrap();
            legacy.put_project("book-b", "entities", "e1", b"same-id-other-project").unwrap();

            let mut target = project_store::ProjectStore::open(&pages_path, &journal_path).unwrap();
            let report = migration::import_legacy_snapshot(&legacy, &mut target, 2).unwrap();
            assert_eq!(report.records_imported, 3);
            assert_eq!(report.batches_committed, 2);
            assert_eq!(report.destination.entries, 3);
            assert_eq!(target.validate().unwrap().entries, 3);
        }

        {
            let mut target = project_store::ProjectStore::open(&pages_path, &journal_path).unwrap();
            assert_eq!(target.get_project("book-a", "entities", "e1").unwrap(), Some(vec![0, 255, 1, 0]));
            assert_eq!(target.get_project("book-a", "records", "id\0with-null").unwrap(), Some(b"unicode-\xc3\xa9".to_vec()));
            assert_eq!(target.get_project("book-b", "entities", "e1").unwrap(), Some(b"same-id-other-project".to_vec()));
            assert_eq!(target.get_project("book-a", "entities", "same-id-other-project").unwrap(), None);
            target.validate().unwrap();
        }

        {
            let legacy = Store::open(&legacy_path).unwrap();
            let mut count = 0usize;
            legacy.visit_records(|_, _, _, _| {
                count += 1;
                Ok::<(), ()>(())
            }).unwrap();
            assert_eq!(count, 3, "la extracción no debe modificar el WAL de origen");
        }

        cleanup_test_store(&legacy_path);
        for path in [&pages_path, &journal_path] {
            let _ = std::fs::remove_file(path);
            let mut lock_name = path.file_name().unwrap().to_os_string();
            lock_name.push(".mldb-lock");
            let _ = std::fs::remove_file(path.with_file_name(lock_name));
        }
    }



    #[test]
    fn snapshot_import_rejects_invalid_batch_size_and_nonempty_destination() {
        let source_path = temp();
        let pages_path = temp().with_extension("mlpg");
        let journal_path = temp().with_extension("mlpj");
        let source = Store::open(&source_path).unwrap();
        source.put_project("p", "records", "r", b"value").unwrap();
        let mut target = project_store::ProjectStore::open(&pages_path, &journal_path).unwrap();

        assert!(matches!(
            migration::import_legacy_snapshot(&source, &mut target, 0),
            Err(migration::SnapshotImportError::InvalidBatchSize)
        ));
        assert!(matches!(
            migration::import_legacy_snapshot(&source, &mut target, migration::MAX_SNAPSHOT_IMPORT_BATCH_SIZE + 1),
            Err(migration::SnapshotImportError::InvalidBatchSize)
        ));
        assert_eq!(target.validate().unwrap().entries, 0);

        target.put_project("existing", "records", "keep", b"untouched").unwrap();
        assert!(matches!(
            migration::import_legacy_snapshot(&source, &mut target, 1),
            Err(migration::SnapshotImportError::TargetNotEmpty { entries: 1 })
        ));
        assert_eq!(
            target.get_project("existing", "records", "keep").unwrap(),
            Some(b"untouched".to_vec())
        );
        assert_eq!(target.get_project("p", "records", "r").unwrap(), None);

        drop(target);
        drop(source);
        cleanup_test_store(&source_path);
        for path in [&pages_path, &journal_path] {
            let _ = std::fs::remove_file(path);
            let mut lock_name = path.file_name().unwrap().to_os_string();
            lock_name.push(".mldb-lock");
            let _ = std::fs::remove_file(path.with_file_name(lock_name));
        }
    }

    #[test]
    fn snapshot_import_of_empty_source_commits_no_empty_batches() {
        let source_path = temp();
        let pages_path = temp().with_extension("mlpg");
        let journal_path = temp().with_extension("mlpj");
        let source = Store::open(&source_path).unwrap();
        let mut target = project_store::ProjectStore::open(&pages_path, &journal_path).unwrap();

        let report = migration::import_legacy_snapshot(&source, &mut target, 4).unwrap();
        assert_eq!(report.records_imported, 0);
        assert_eq!(report.batches_committed, 0);
        assert_eq!(report.destination.entries, 0);
        assert_eq!(target.page_count(), 2);

        drop(target);
        drop(source);
        cleanup_test_store(&source_path);
        for path in [&pages_path, &journal_path] {
            let _ = std::fs::remove_file(path);
            let mut lock_name = path.file_name().unwrap().to_os_string();
            lock_name.push(".mldb-lock");
            let _ = std::fs::remove_file(path.with_file_name(lock_name));
        }
    }



    #[test]
    fn snapshot_import_failure_after_a_committed_batch_leaves_only_unpublishable_partial_target() {
        let source_path = temp();
        let pages_path = temp().with_extension("mlpg");
        let journal_path = temp().with_extension("mlpj");
        let source = Store::open(&source_path).unwrap();
        source.put_project("a", "records", "first", b"committed-first-batch").unwrap();
        source.put_project(&"x".repeat(5000), "records", "second", b"cannot-fit-composite-key").unwrap();
        let mut target = project_store::ProjectStore::open(&pages_path, &journal_path).unwrap();

        let result = migration::import_legacy_snapshot(&source, &mut target, 1);
        assert!(matches!(result, Err(migration::SnapshotImportError::Target(_))));
        assert_eq!(target.validate().unwrap().entries, 1);
        assert_eq!(
            target.get_project("a", "records", "first").unwrap(),
            Some(b"committed-first-batch".to_vec())
        );
        assert_eq!(
            source.get_project(&"x".repeat(5000), "records", "second").unwrap(),
            Some(b"cannot-fit-composite-key".to_vec())
        );
        assert_eq!(
            source.get_project("a", "records", "first").unwrap(),
            Some(b"committed-first-batch".to_vec())
        );

        drop(target);
        drop(source);
        cleanup_test_store(&source_path);
        for path in [&pages_path, &journal_path] {
            let _ = std::fs::remove_file(path);
            let mut lock_name = path.file_name().unwrap().to_os_string();
            lock_name.push(".mldb-lock");
            let _ = std::fs::remove_file(path.with_file_name(lock_name));
        }
    }



    #[test]
    fn snapshot_import_rejects_single_record_above_batch_memory_limit_before_staging() {
        let source_path = temp();
        let pages_path = temp().with_extension("mlpg");
        let journal_path = temp().with_extension("mlpj");
        let source = Store::open(&source_path).unwrap();
        let oversized = vec![0x5a; migration::MAX_SNAPSHOT_IMPORT_BATCH_BYTES + 1];
        source.put_project("p", "records", "large", &oversized).unwrap();
        let mut target = project_store::ProjectStore::open(&pages_path, &journal_path).unwrap();

        let result = migration::import_legacy_snapshot(&source, &mut target, 8);
        assert!(matches!(result, Err(migration::SnapshotImportError::Target(_))));
        assert_eq!(target.validate().unwrap().entries, 0);
        assert_eq!(target.page_count(), 2);
        assert_eq!(
            source.get_project("p", "records", "large").unwrap().unwrap().len(),
            oversized.len()
        );

        drop(target);
        drop(source);
        cleanup_test_store(&source_path);
        for path in [&pages_path, &journal_path] {
            let _ = std::fs::remove_file(path);
            let mut lock_name = path.file_name().unwrap().to_os_string();
            lock_name.push(".mldb-lock");
            let _ = std::fs::remove_file(path.with_file_name(lock_name));
        }
    }



    #[test]
    fn snapshot_import_splits_batches_when_byte_budget_is_reached_before_record_limit() {
        let source_path = temp();
        let pages_path = temp().with_extension("mlpg");
        let journal_path = temp().with_extension("mlpj");
        let source = Store::open(&source_path).unwrap();
        let operations = (0..70)
            .map(|index| Operation::Put {
                project_id: "p".to_owned(),
                table: "records".to_owned(),
                record_id: format!("record-{index:03}"),
                value: vec![index as u8; 3900],
            })
            .collect();
        source.transaction(operations).unwrap();
        let mut target = project_store::ProjectStore::open(&pages_path, &journal_path).unwrap();

        let report = migration::import_legacy_snapshot(&source, &mut target, 256).unwrap();
        assert_eq!(report.records_imported, 70);
        assert_eq!(report.batches_committed, 2);
        assert_eq!(report.destination.entries, 70);
        for index in 0..70 {
            assert_eq!(
                target.get_project("p", "records", &format!("record-{index:03}")).unwrap(),
                Some(vec![index as u8; 3900])
            );
        }

        drop(target);
        drop(source);
        cleanup_test_store(&source_path);
        for path in [&pages_path, &journal_path] {
            let _ = std::fs::remove_file(path);
            let mut lock_name = path.file_name().unwrap().to_os_string();
            lock_name.push(".mldb-lock");
            let _ = std::fs::remove_file(path.with_file_name(lock_name));
        }
    }



    #[test]
    fn snapshot_import_preserves_legacy_wal_byte_for_byte() {
        let source_path = temp();
        let pages_path = temp().with_extension("mlpg");
        let journal_path = temp().with_extension("mlpj");
        let source = Store::open(&source_path).unwrap();
        source.put_project("book", "entities", "entity-1", b"private-bytes\0\xff").unwrap();
        source.put_project("book", "events", "event-1", b"event-payload").unwrap();
        let source_before = std::fs::read(&source_path).unwrap();

        let mut target = project_store::ProjectStore::open(&pages_path, &journal_path).unwrap();
        let report = migration::import_legacy_snapshot(&source, &mut target, 1).unwrap();
        assert_eq!(report.records_imported, 2);
        assert_eq!(report.batches_committed, 2);
        assert_eq!(std::fs::read(&source_path).unwrap(), source_before);
        assert_eq!(
            target.get_project("book", "entities", "entity-1").unwrap(),
            Some(b"private-bytes\0\xff".to_vec())
        );

        drop(target);
        drop(source);
        cleanup_test_store(&source_path);
        for path in [&pages_path, &journal_path] {
            let _ = std::fs::remove_file(path);
            let mut lock_name = path.file_name().unwrap().to_os_string();
            lock_name.push(".mldb-lock");
            let _ = std::fs::remove_file(path.with_file_name(lock_name));
        }
    }

}
