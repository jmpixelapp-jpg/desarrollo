//! Codec experimental de nodos B+Tree. No realiza I/O ni administra splits.
use std::fmt;

pub const NODE_MAGIC: [u8; 4] = *b"MBTN";
pub const NODE_VERSION: u16 = 1;
const HEADER: usize = 20;
const LEAF: u8 = 1;
const INTERNAL: u8 = 2;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NodeError {
    TooSmall,
    InvalidCapacity,
    TooManyEntries,
    EmptyKey,
    KeyTooLarge,
    ValueTooLarge,
    UnsortedKeys,
    Invalid(&'static str),
    NoSpace,
}
impl fmt::Display for NodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooSmall => write!(f, "payload insuficiente para nodo B+Tree"),
            Self::InvalidCapacity => write!(f, "capacidad fuera del rango u16"),
            Self::TooManyEntries => write!(f, "demasiadas entradas"),
            Self::EmptyKey => write!(f, "clave vacía"),
            Self::KeyTooLarge => write!(f, "clave supera u16"),
            Self::ValueTooLarge => write!(f, "valor supera u32"),
            Self::UnsortedKeys => write!(f, "las claves deben estar estrictamente ordenadas"),
            Self::Invalid(s) => write!(f, "nodo B+Tree inválido: {s}"),
            Self::NoSpace => write!(f, "el nodo no cabe en el payload"),
        }
    }
}
impl std::error::Error for NodeError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeafEntry { pub key: Vec<u8>, pub value: Vec<u8> }

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InternalEntry { pub separator: Vec<u8>, pub right_child: u64 }

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BTreeNode {
    Leaf { next_leaf: Option<u64>, entries: Vec<LeafEntry> },
    Internal { level: u16, first_child: u64, entries: Vec<InternalEntry> },
}

impl BTreeNode {
    pub fn encode(&self, capacity: usize) -> Result<Vec<u8>, NodeError> {
        if capacity < HEADER { return Err(NodeError::TooSmall); }
        if capacity > u16::MAX as usize { return Err(NodeError::InvalidCapacity); }
        let (kind, count, next, body) = match self {
            Self::Leaf { next_leaf, entries } => {
                validate_keys(entries.iter().map(|e| e.key.as_slice()))?;
                if entries.len() > u16::MAX as usize { return Err(NodeError::TooManyEntries); }
                let mut body = Vec::new();
                for e in entries {
                    if e.value.len() > u32::MAX as usize { return Err(NodeError::ValueTooLarge); }
                    body.extend_from_slice(&(e.key.len() as u16).to_le_bytes());
                    body.extend_from_slice(&(e.value.len() as u32).to_le_bytes());
                    body.extend_from_slice(&e.key);
                    body.extend_from_slice(&e.value);
                }
                (LEAF, entries.len(), next_leaf.unwrap_or(u64::MAX), body)
            }
            Self::Internal { level, first_child, entries } => {
                validate_keys(entries.iter().map(|e| e.separator.as_slice()))?;
                if *level == 0 { return Err(NodeError::Invalid("nivel interno debe ser positivo")); }
                if entries.len() > u16::MAX as usize { return Err(NodeError::TooManyEntries); }
                let mut body = Vec::new();
                body.extend_from_slice(&first_child.to_le_bytes());
                for e in entries {
                    body.extend_from_slice(&(e.separator.len() as u16).to_le_bytes());
                    body.extend_from_slice(&e.separator);
                    body.extend_from_slice(&e.right_child.to_le_bytes());
                }
                let mut header = vec![0u8; HEADER];
                header[..4].copy_from_slice(&NODE_MAGIC);
                header[4..6].copy_from_slice(&NODE_VERSION.to_le_bytes());
                header[6] = INTERNAL;
                header[8..10].copy_from_slice(&(entries.len() as u16).to_le_bytes());
                header[10..12].copy_from_slice(&level.to_le_bytes());
                header[12..20].copy_from_slice(&0u64.to_le_bytes());
                if HEADER + body.len() > capacity { return Err(NodeError::NoSpace); }
                header.extend_from_slice(&body);
                header.resize(capacity, 0);
                return Ok(header);
            }
        };
        if HEADER + body.len() > capacity { return Err(NodeError::NoSpace); }
        let mut out = vec![0u8; capacity];
        out[..4].copy_from_slice(&NODE_MAGIC);
        out[4..6].copy_from_slice(&NODE_VERSION.to_le_bytes());
        out[6] = kind;
        out[8..10].copy_from_slice(&(count as u16).to_le_bytes());
        out[10..12].copy_from_slice(&0u16.to_le_bytes());
        out[12..20].copy_from_slice(&next.to_le_bytes());
        out[HEADER..HEADER + body.len()].copy_from_slice(&body);
        Ok(out)
    }

    pub fn decode(data: &[u8]) -> Result<Self, NodeError> {
        if data.len() < HEADER { return Err(NodeError::TooSmall); }
        if data[..4] != NODE_MAGIC { return Err(NodeError::Invalid("magic")); }
        if u16::from_le_bytes([data[4], data[5]]) != NODE_VERSION {
            return Err(NodeError::Invalid("versión"));
        }
        if data[7] != 0 { return Err(NodeError::Invalid("flags reservados")); }
        let count = u16::from_le_bytes([data[8], data[9]]) as usize;
        let level = u16::from_le_bytes([data[10], data[11]]);
        let next = u64::from_le_bytes(data[12..20].try_into().unwrap());
        let mut pos = HEADER;
        match data[6] {
            LEAF => {
                if level != 0 { return Err(NodeError::Invalid("nivel de hoja")); }
                let mut entries = Vec::with_capacity(count);
                for _ in 0..count {
                    if pos.checked_add(6).filter(|v| *v <= data.len()).is_none() {
                        return Err(NodeError::Invalid("cabecera de entrada truncada"));
                    }
                    let kl = u16::from_le_bytes(data[pos..pos+2].try_into().unwrap()) as usize;
                    let vl = u32::from_le_bytes(data[pos+2..pos+6].try_into().unwrap()) as usize;
                    pos += 6;
                    let end = pos.checked_add(kl).and_then(|v| v.checked_add(vl))
                        .filter(|v| *v <= data.len()).ok_or(NodeError::Invalid("entrada truncada"))?;
                    if kl == 0 { return Err(NodeError::EmptyKey); }
                    entries.push(LeafEntry { key: data[pos..pos+kl].to_vec(), value: data[pos+kl..end].to_vec() });
                    pos = end;
                }
                if data[pos..].iter().any(|b| *b != 0) { return Err(NodeError::Invalid("relleno no nulo")); }
                validate_keys(entries.iter().map(|e| e.key.as_slice()))?;
                Ok(Self::Leaf { next_leaf: if next == u64::MAX { None } else { Some(next) }, entries })
            }
            INTERNAL => {
                if next != 0 { return Err(NodeError::Invalid("puntero de hoja en nodo interno")); }
                if level == 0 { return Err(NodeError::Invalid("nivel interno debe ser positivo")); }
                if pos + 8 > data.len() { return Err(NodeError::Invalid("primer hijo truncado")); }
                let first_child = u64::from_le_bytes(data[pos..pos+8].try_into().unwrap());
                pos += 8;
                let mut entries = Vec::with_capacity(count);
                for _ in 0..count {
                    if pos + 2 > data.len() { return Err(NodeError::Invalid("longitud de separador truncada")); }
                    let kl = u16::from_le_bytes(data[pos..pos+2].try_into().unwrap()) as usize;
                    pos += 2;
                    let end_key = pos.checked_add(kl).filter(|v| *v <= data.len())
                        .ok_or(NodeError::Invalid("separador truncado"))?;
                    if kl == 0 { return Err(NodeError::EmptyKey); }
                    let key = data[pos..end_key].to_vec();
                    pos = end_key;
                    if pos + 8 > data.len() { return Err(NodeError::Invalid("puntero hijo truncado")); }
                    let right_child = u64::from_le_bytes(data[pos..pos+8].try_into().unwrap());
                    pos += 8;
                    entries.push(InternalEntry { separator: key, right_child });
                }
                if data[pos..].iter().any(|b| *b != 0) { return Err(NodeError::Invalid("relleno no nulo")); }
                validate_keys(entries.iter().map(|e| e.separator.as_slice()))?;
                Ok(Self::Internal { level, first_child, entries })
            }
            _ => Err(NodeError::Invalid("tipo de nodo desconocido")),
        }
    }
}

fn validate_keys<'a>(keys: impl Iterator<Item = &'a [u8]>) -> Result<(), NodeError> {
    let mut previous: Option<&[u8]> = None;
    for key in keys {
        if key.is_empty() { return Err(NodeError::EmptyKey); }
        if key.len() > u16::MAX as usize { return Err(NodeError::KeyTooLarge); }
        if previous.is_some_and(|p| p >= key) { return Err(NodeError::UnsortedKeys); }
        previous = Some(key);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leaf_roundtrip_with_link() {
        let node = BTreeNode::Leaf { next_leaf: Some(9), entries: vec![
            LeafEntry { key: b"alpha".to_vec(), value: b"one".to_vec() },
            LeafEntry { key: b"beta".to_vec(), value: b"two".to_vec() },
        ]};
        let bytes = node.encode(512).unwrap();
        assert_eq!(BTreeNode::decode(&bytes).unwrap(), node);
    }
    #[test]
    fn internal_roundtrip() {
        let node = BTreeNode::Internal { level: 2, first_child: 10, entries: vec![
            InternalEntry { separator: b"middle".to_vec(), right_child: 11 },
            InternalEntry { separator: b"zulu".to_vec(), right_child: 12 },
        ]};
        let bytes = node.encode(512).unwrap();
        assert_eq!(BTreeNode::decode(&bytes).unwrap(), node);
    }
    #[test]
    fn unary_internal_node_roundtrips() {
        // Un nodo interno con cero separadores conserva un único hijo.
        // Es necesario cuando un split por bytes promueve el primer separador.
        let node = BTreeNode::Internal { level: 1, first_child: 42, entries: vec![] };
        let bytes = node.encode(128).unwrap();
        assert_eq!(BTreeNode::decode(&bytes).unwrap(), node);
    }

    #[test]
    fn leaf_link_can_target_page_zero() {
        let node = BTreeNode::Leaf { next_leaf: Some(0), entries: vec![] };
        let bytes = node.encode(64).unwrap();
        assert_eq!(BTreeNode::decode(&bytes).unwrap(), node);
    }
    #[test]
    fn rejects_unsorted_and_duplicate_keys() {
        let node = BTreeNode::Leaf { next_leaf: None, entries: vec![
            LeafEntry { key: b"b".to_vec(), value: vec![] },
            LeafEntry { key: b"a".to_vec(), value: vec![] },
        ]};
        assert_eq!(node.encode(128), Err(NodeError::UnsortedKeys));
    }
    #[test]
    fn rejects_truncated_node() {
        let mut bytes = BTreeNode::Leaf { next_leaf: None, entries: vec![
            LeafEntry { key: b"k".to_vec(), value: b"v".to_vec() },
        ]}.encode(64).unwrap();
        bytes.truncate(HEADER + 6);
        assert!(matches!(BTreeNode::decode(&bytes), Err(NodeError::Invalid(_))));
    }
    #[test]
    fn internal_node_accepts_exact_payload_capacity() {
        // HEADER(20) + first_child(8) + separator(2 + 26) + right_child(8) = 64.
        let node = BTreeNode::Internal {
            level: 1,
            first_child: 7,
            entries: vec![InternalEntry {
                separator: vec![b'm'; 26],
                right_child: 9,
            }],
        };
        let encoded = node.encode(64).unwrap();
        assert_eq!(encoded.len(), 64);
        assert_eq!(BTreeNode::decode(&encoded).unwrap(), node);
    }

    #[test]
    fn internal_node_rejects_one_byte_over_payload_capacity() {
        // El mismo nodo necesita 65 bytes; el rechazo no debe truncar el separador.
        let node = BTreeNode::Internal {
            level: 1,
            first_child: 7,
            entries: vec![InternalEntry {
                separator: vec![b'm'; 27],
                right_child: 9,
            }],
        };
        assert_eq!(node.encode(64), Err(NodeError::NoSpace));
        assert_eq!(node.encode(65).unwrap().len(), 65);
    }

    #[test]
    fn rejects_insufficient_capacity() {
        let node = BTreeNode::Leaf { next_leaf: None, entries: vec![
            LeafEntry { key: b"key".to_vec(), value: b"value".to_vec() },
        ]};
        assert_eq!(node.encode(24), Err(NodeError::NoSpace));
    }
}
