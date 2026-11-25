//! Codecs versionados MBTR/MBFR. No integra todavía la lista libre con el árbol.
use std::fmt;
const NONE:u64=u64::MAX;
#[derive(Clone,Debug,Eq,PartialEq)] pub struct TreeMetadata{pub root_id:u64,pub level:u16,pub free_head:Option<u64>}
#[derive(Clone,Debug,Eq,PartialEq)] pub struct FreePage{pub next:Option<u64>}
#[derive(Clone,Debug,Eq,PartialEq)] pub enum CodecError{InvalidLength,InvalidMagic,UnsupportedVersion(u16),ReservedBytes,InvalidPageId}
impl fmt::Display for CodecError{fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result{write!(f,"error de codec: {self:?}")}}
impl std::error::Error for CodecError{}
impl TreeMetadata{
 pub fn encode(&self)->Vec<u8>{let mut b=vec![0;32];b[..4].copy_from_slice(b"MBTR");b[4..6].copy_from_slice(&2u16.to_le_bytes());b[8..16].copy_from_slice(&self.root_id.to_le_bytes());b[16..18].copy_from_slice(&self.level.to_le_bytes());b[20..28].copy_from_slice(&self.free_head.unwrap_or(NONE).to_le_bytes());b}
 pub fn decode(b:&[u8])->Result<Self,CodecError>{
  if b.len()<6{return Err(CodecError::InvalidLength)} if &b[..4]!=b"MBTR"{return Err(CodecError::InvalidMagic)}
  let v=u16::from_le_bytes(b[4..6].try_into().unwrap());
  let free_head=match v{1=>{if b.len()!=24{return Err(CodecError::InvalidLength)} if b[6..8]!=[0,0]||b[18..].iter().any(|x|*x!=0){return Err(CodecError::ReservedBytes)} None},
   2=>{if b.len()!=32{return Err(CodecError::InvalidLength)} if b[6..8]!=[0,0]||b[18..20]!=[0,0]||b[28..].iter().any(|x|*x!=0){return Err(CodecError::ReservedBytes)} let n=u64::from_le_bytes(b[20..28].try_into().unwrap());if n==0{return Err(CodecError::InvalidPageId)} if n==NONE{None}else{Some(n)}},
   n=>return Err(CodecError::UnsupportedVersion(n))};
  let root_id=u64::from_le_bytes(b[8..16].try_into().unwrap());if root_id==0{return Err(CodecError::InvalidPageId)}
  Ok(Self{root_id,level:u16::from_le_bytes(b[16..18].try_into().unwrap()),free_head})
 }
}
impl FreePage{
 pub fn encode(&self)->Vec<u8>{let mut b=vec![0;16];b[..4].copy_from_slice(b"MBFR");b[4..6].copy_from_slice(&1u16.to_le_bytes());b[8..16].copy_from_slice(&self.next.unwrap_or(NONE).to_le_bytes());b}
 pub fn decode(b:&[u8])->Result<Self,CodecError>{if b.len()!=16{return Err(CodecError::InvalidLength)}if &b[..4]!=b"MBFR"{return Err(CodecError::InvalidMagic)}let v=u16::from_le_bytes(b[4..6].try_into().unwrap());if v!=1{return Err(CodecError::UnsupportedVersion(v))}if b[6..8]!=[0,0]{return Err(CodecError::ReservedBytes)}let n=u64::from_le_bytes(b[8..16].try_into().unwrap());if n==0{return Err(CodecError::InvalidPageId)}Ok(Self{next:if n==NONE{None}else{Some(n)}})}
}
#[cfg(test)]mod tests{use super::*;fn v1()->Vec<u8>{let mut b=vec![0;24];b[..4].copy_from_slice(b"MBTR");b[4..6].copy_from_slice(&1u16.to_le_bytes());b[8..16].copy_from_slice(&7u64.to_le_bytes());b}
#[test]fn legacy_v1_reads_empty_free_list(){assert_eq!(TreeMetadata::decode(&v1()).unwrap(),TreeMetadata{root_id:7,level:0,free_head:None})}
#[test]fn v2_roundtrip(){let m=TreeMetadata{root_id:9,level:2,free_head:Some(4)};assert_eq!(TreeMetadata::decode(&m.encode()).unwrap(),m)}
#[test]fn v2_empty_sentinel(){let m=TreeMetadata{root_id:1,level:0,free_head:None};assert_eq!(TreeMetadata::decode(&m.encode()).unwrap(),m)}
#[test]fn rejects_metadata_length_and_magic(){assert_eq!(TreeMetadata::decode(&[0;24]),Err(CodecError::InvalidMagic));let mut b=v1();b.pop();assert_eq!(TreeMetadata::decode(&b),Err(CodecError::InvalidLength))}
#[test]fn rejects_reserved_and_unknown_version(){let mut b=TreeMetadata{root_id:1,level:0,free_head:None}.encode();b[6]=1;assert_eq!(TreeMetadata::decode(&b),Err(CodecError::ReservedBytes));b[6]=0;b[4..6].copy_from_slice(&99u16.to_le_bytes());assert_eq!(TreeMetadata::decode(&b),Err(CodecError::UnsupportedVersion(99)))}
#[test]fn rejects_zero_ids(){let mut b=TreeMetadata{root_id:1,level:0,free_head:None}.encode();b[8..16].copy_from_slice(&0u64.to_le_bytes());assert_eq!(TreeMetadata::decode(&b),Err(CodecError::InvalidPageId));let mut b=TreeMetadata{root_id:1,level:0,free_head:Some(2)}.encode();b[20..28].copy_from_slice(&0u64.to_le_bytes());assert_eq!(TreeMetadata::decode(&b),Err(CodecError::InvalidPageId))}
#[test]fn free_page_roundtrip(){for p in [FreePage{next:None},FreePage{next:Some(12)}]{assert_eq!(FreePage::decode(&p.encode()).unwrap(),p)}}
#[test]fn rejects_corrupt_free_page(){let mut b=FreePage{next:None}.encode();b[6]=1;assert_eq!(FreePage::decode(&b),Err(CodecError::ReservedBytes));b[6]=0;b[4..6].copy_from_slice(&2u16.to_le_bytes());assert_eq!(FreePage::decode(&b),Err(CodecError::UnsupportedVersion(2)));b[4..6].copy_from_slice(&1u16.to_le_bytes());b[8..16].copy_from_slice(&0u64.to_le_bytes());assert_eq!(FreePage::decode(&b),Err(CodecError::InvalidPageId));assert_eq!(FreePage::decode(&b[..15]),Err(CodecError::InvalidLength))}
}