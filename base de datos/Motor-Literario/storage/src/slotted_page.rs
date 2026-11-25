//! Codificación de páginas slotted para registros de longitud variable.
//! El módulo trabaja sobre el payload de una página MLPG; no escribe archivos.
pub const SLOT_PAGE_MAGIC: [u8; 4] = *b"SLT1";
pub const SLOT_PAGE_VERSION: u16 = 1;
const HEADER: usize = 12;
const SLOT_SIZE: usize = 6;

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum SlotError {
    TooSmall,
    InvalidCapacity,
    EmptyRecord,
    TooManyRecords,
    RecordTooLarge,
    NoSpace,
    Corrupt(&'static str),
}
impl std::fmt::Display for SlotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooSmall => write!(f, "payload insuficiente para una página slotted"),
            Self::InvalidCapacity => write!(f, "capacidad supera el rango direccionable u16"),
            Self::EmptyRecord => write!(f, "no se admiten registros vacíos"),
            Self::TooManyRecords => write!(f, "demasiados registros para la tabla de slots"),
            Self::RecordTooLarge => write!(f, "registro demasiado grande"),
            Self::NoSpace => write!(f, "espacio insuficiente en la página"),
            Self::Corrupt(s) => write!(f, "página slotted corrupta: {s}"),
        }
    }
}
impl std::error::Error for SlotError {}

/// Imagen lógica de una página: slots estables por posición y registros opacos.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlottedPage {
    records: Vec<Option<Vec<u8>>>,
}
impl SlottedPage {
    pub fn new() -> Self { Self { records: Vec::new() } }
    pub fn len(&self) -> usize { self.records.iter().filter(|r| r.is_some()).count() }
    pub fn is_empty(&self) -> bool { self.len() == 0 }
    pub fn slot_count(&self) -> usize { self.records.len() }
    pub fn get(&self, slot: usize) -> Option<&[u8]> {
        self.records.get(slot).and_then(|r| r.as_deref())
    }
    /// Inserta sin reutilizar huecos: los números de slot existentes nunca cambian.
    pub fn insert(&mut self, record: Vec<u8>) -> Result<usize, SlotError> {
        if record.is_empty() { return Err(SlotError::EmptyRecord); }
        if record.len() > u16::MAX as usize { return Err(SlotError::RecordTooLarge); }
        if self.records.len() >= u16::MAX as usize { return Err(SlotError::TooManyRecords); }
        self.records.push(Some(record));
        Ok(self.records.len() - 1)
    }
    /// Elimina lógicamente; conserva el slot como tombstone para no invalidar referencias.
    pub fn remove(&mut self, slot: usize) -> Result<(), SlotError> {
        let entry = self.records.get_mut(slot).ok_or(SlotError::Corrupt("slot fuera de rango"))?;
        if entry.is_none() { return Err(SlotError::Corrupt("slot ya eliminado")); }
        *entry = None;
        Ok(())
    }
    /// Serializa en un payload de tamaño fijo, listo para PageFile::allocate/overwrite.
    pub fn encode(&self, capacity: usize) -> Result<Vec<u8>, SlotError> {
        if capacity < HEADER { return Err(SlotError::TooSmall); }
        if capacity > u16::MAX as usize { return Err(SlotError::InvalidCapacity); }
        if self.records.len() > u16::MAX as usize { return Err(SlotError::TooManyRecords); }
        let table_end = HEADER.checked_add(self.records.len() * SLOT_SIZE).ok_or(SlotError::NoSpace)?;
        if table_end > capacity { return Err(SlotError::NoSpace); }
        let mut out = vec![0u8; capacity];
        out[0..4].copy_from_slice(&SLOT_PAGE_MAGIC);
        out[4..6].copy_from_slice(&SLOT_PAGE_VERSION.to_le_bytes());
        out[6..8].copy_from_slice(&(self.records.len() as u16).to_le_bytes());
        let mut free_end = capacity;
        for (index, item) in self.records.iter().enumerate() {
            let pos = HEADER + index * SLOT_SIZE;
            match item {
                Some(record) => {
                    if record.len() > u16::MAX as usize { return Err(SlotError::RecordTooLarge); }
                    if free_end < table_end + record.len() { return Err(SlotError::NoSpace); }
                    free_end -= record.len();
                    out[free_end..free_end + record.len()].copy_from_slice(record);
                    out[pos..pos+2].copy_from_slice(&(free_end as u16).to_le_bytes());
                    out[pos+2..pos+4].copy_from_slice(&(record.len() as u16).to_le_bytes());
                    out[pos+4..pos+6].copy_from_slice(&1u16.to_le_bytes());
                }
                None => {
                    out[pos..pos+2].copy_from_slice(&0u16.to_le_bytes());
                    out[pos+2..pos+4].copy_from_slice(&0u16.to_le_bytes());
                    out[pos+4..pos+6].copy_from_slice(&0u16.to_le_bytes());
                }
            }
        }
        out[8..10].copy_from_slice(&(table_end as u16).to_le_bytes());
        out[10..12].copy_from_slice(&(free_end as u16).to_le_bytes());
        Ok(out)
    }
    pub fn decode(data: &[u8]) -> Result<Self, SlotError> {
        if data.len() < HEADER { return Err(SlotError::TooSmall); }
        if data[0..4] != SLOT_PAGE_MAGIC { return Err(SlotError::Corrupt("magic")); }
        if u16::from_le_bytes([data[4], data[5]]) != SLOT_PAGE_VERSION {
            return Err(SlotError::Corrupt("versión"));
        }
        let count = u16::from_le_bytes([data[6], data[7]]) as usize;
        let free_start = u16::from_le_bytes([data[8], data[9]]) as usize;
        let free_end = u16::from_le_bytes([data[10], data[11]]) as usize;
        let expected_start = HEADER.checked_add(count * SLOT_SIZE).ok_or(SlotError::Corrupt("overflow"))?;
        if free_start != expected_start || free_start > data.len() || free_end < free_start || free_end > data.len() {
            return Err(SlotError::Corrupt("límites de espacio libre"));
        }
        let mut records = Vec::with_capacity(count);
        let mut ranges: Vec<(usize, usize)> = Vec::new();
        for i in 0..count {
            let pos = HEADER + i * SLOT_SIZE;
            let offset = u16::from_le_bytes([data[pos], data[pos+1]]) as usize;
            let len = u16::from_le_bytes([data[pos+2], data[pos+3]]) as usize;
            let flags = u16::from_le_bytes([data[pos+4], data[pos+5]]);
            match flags {
                0 if offset == 0 && len == 0 => records.push(None),
                1 => {
                    let end = offset.checked_add(len).ok_or(SlotError::Corrupt("overflow de registro"))?;
                    if len == 0 || offset < free_end || end > data.len() {
                        return Err(SlotError::Corrupt("rango de registro inválido"));
                    }
                    if ranges.iter().any(|(a,b)| offset < *b && *a < end) {
                        return Err(SlotError::Corrupt("registros solapados"));
                    }
                    ranges.push((offset,end));
                    records.push(Some(data[offset..end].to_vec()));
                }
                _ => return Err(SlotError::Corrupt("flags de slot inválidos")),
            }
        }
        Ok(Self { records })
    }
}
impl Default for SlottedPage { fn default() -> Self { Self::new() } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn variable_records_roundtrip_and_tombstone() {
        let mut page = SlottedPage::new();
        let a = page.insert(b"first".to_vec()).unwrap();
        let b = page.insert(b"a longer second record".to_vec()).unwrap();
        page.remove(a).unwrap();
        let bytes = page.encode(4066).unwrap();
        let decoded = SlottedPage::decode(&bytes).unwrap();
        assert_eq!(decoded.get(a), None);
        assert_eq!(decoded.get(b), Some(&b"a longer second record"[..]));
        assert_eq!(decoded.slot_count(), 2);
    }
    #[test]
    fn rejects_page_with_overlapping_records() {
        let mut page = SlottedPage::new();
        page.insert(b"one".to_vec()).unwrap();
        page.insert(b"two".to_vec()).unwrap();
        let mut bytes = page.encode(128).unwrap();
        let first = HEADER;
        let second = HEADER + SLOT_SIZE;
        let duplicate_offset = bytes[first..first+2].to_vec();
        bytes[second..second+2].copy_from_slice(&duplicate_offset);
        assert!(matches!(SlottedPage::decode(&bytes), Err(SlotError::Corrupt(_))));
    }
    #[test]
    fn rejects_insufficient_space() {
        let mut page = SlottedPage::new();
        page.insert(vec![7; 80]).unwrap();
        assert_eq!(page.encode(32), Err(SlotError::NoSpace));
    }
}
