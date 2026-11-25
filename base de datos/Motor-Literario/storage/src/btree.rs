//! Árbol B+ persistente experimental sobre MLPG + MLPJ.
//! Las mutaciones de una inserción se confirman como una única transacción de páginas.
use crate::btree_node::{BTreeNode, InternalEntry, LeafEntry, NodeError};
use crate::page_journal::{DurablePages, JournalError, PageChange, MAX_IMAGES_PER_TX};
use std::fmt;
use std::path::Path;
use std::collections::{BTreeMap, BTreeSet};

const PAGE_PAYLOAD: usize = 4066;
/// Umbral de diagnóstico: páginas no raíz por debajo de un tercio del payload útil.
/// Es una señal de mantenimiento, no una invariante de validez del árbol.
pub(crate) const MIN_DIAGNOSTIC_OCCUPANCY_BYTES: usize = PAGE_PAYLOAD / 3;
// Un separador interno ocupa 28 bytes fijos más 10 + longitud de clave.
// Toda clave del árbol debe poder convertirse en separador tras un split.
pub(crate) const MAX_TREE_KEY_LEN: usize = PAGE_PAYLOAD - 38;

#[derive(Debug)]
pub enum BTreeError {
    Journal(JournalError),
    Node(NodeError),
    Corrupt(&'static str),
    Invalid(&'static str),
    NoSpace,
}
impl From<JournalError> for BTreeError { fn from(e: JournalError) -> Self { Self::Journal(e) } }
impl From<NodeError> for BTreeError { fn from(e: NodeError) -> Self { Self::Node(e) } }
impl fmt::Display for BTreeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Journal(e) => write!(f, "B+Tree: {e}"),
            Self::Node(e) => write!(f, "B+Tree nodo: {e}"),
            Self::Corrupt(s) => write!(f, "B+Tree corrupto: {s}"),
            Self::Invalid(s) => write!(f, "operación B+Tree inválida: {s}"),
            Self::NoSpace => write!(f, "la entrada no cabe en una página B+Tree"),
        }
    }
}
impl std::error::Error for BTreeError {}

fn ensure_transaction_image_limit(image_count: usize, limit: usize) -> Result<(), BTreeError> {
    if image_count > limit {
        return Err(BTreeError::Journal(JournalError::Invalid("demasiadas imágenes en una transacción")));
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RootMeta { root_id: u64, level: u16, free_head: Option<u64> }

#[derive(Clone, Debug)]
struct Split { separator: Vec<u8>, right_id: u64 }

pub struct BPlusTreeRange<'a> {
    tree: &'a mut PersistentBPlusTree,
    page_id: Option<u64>,
    next_leaf: Option<u64>,
    entries: Vec<LeafEntry>,
    index: usize,
    end_exclusive: Option<Vec<u8>>,
    visited: BTreeSet<u64>,
    previous_key: Option<Vec<u8>>,
    loaded: bool,
    failed: bool,
}

impl Iterator for BPlusTreeRange<'_> {
    type Item = Result<(Vec<u8>, Vec<u8>), BTreeError>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.failed { return None; }
        loop {
            let page_id = self.page_id?;
            if !self.loaded {
                if !self.visited.insert(page_id) {
                    self.failed = true;
                    return Some(Err(BTreeError::Corrupt("ciclo en enlaces de hojas")));
                }
                if page_id >= self.tree.pages.page_count() {
                    self.failed = true;
                    return Some(Err(BTreeError::Corrupt("enlace de hoja fuera del archivo")));
                }
                let page = match self.tree.pages.read(page_id) {
                    Ok(page) => page,
                    Err(error) => { self.failed = true; return Some(Err(BTreeError::Journal(error))); }
                };
                match BTreeNode::decode(&page.payload) {
                    Ok(BTreeNode::Leaf { next_leaf, entries }) => {
                        self.entries = entries;
                        self.next_leaf = next_leaf;
                        self.loaded = true;
                    }
                    Ok(BTreeNode::Internal { .. }) => {
                        self.failed = true;
                        return Some(Err(BTreeError::Corrupt("enlace de hoja apunta a nodo interno")));
                    }
                    Err(error) => { self.failed = true; return Some(Err(BTreeError::Node(error))); }
                }
            }
            if self.index < self.entries.len() {
                let entry = &self.entries[self.index];
                self.index += 1;
                if self.previous_key.as_ref().is_some_and(|previous| previous.as_slice() >= entry.key.as_slice()) {
                    self.failed = true;
                    return Some(Err(BTreeError::Corrupt("orden global de claves inválido en iterador")));
                }
                self.previous_key = Some(entry.key.clone());
                if self.end_exclusive.as_ref().is_some_and(|end| entry.key.as_slice() >= end.as_slice()) {
                    self.page_id = None;
                    return None;
                }
                return Some(Ok((entry.key.clone(), entry.value.clone())));
            }
            self.page_id = self.next_leaf;
            self.entries.clear();
            self.index = 0;
            self.loaded = false;
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidationReport {
    pub pages_visited: usize,
    pub leaf_pages: usize,
    pub free_pages: usize,
    pub entries: usize,
    pub height: u16,
}

/// Diagnóstico de ocupación lógica (cabecera + entradas, sin padding físico).
/// No declara corruptas las páginas deficitarias: identifica estructuras válidas
/// pendientes de compactación/rebalanceo.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct OccupancyDiagnostics {
    pub empty_non_root_leaves: usize,
    pub unary_non_root_internal_nodes: usize,
    pub root_is_unary_internal: bool,
    /// Umbral en bytes aplicado a los contadores `underfilled_*`.
    pub minimum_diagnostic_occupancy_bytes: usize,
    /// Páginas no raíz cuyo payload codificado ocupa menos de un tercio de la capacidad.
    pub underfilled_non_root_leaf_pages: usize,
    pub underfilled_non_root_internal_pages: usize,
    /// Total agregado de páginas no raíz por debajo del umbral de bytes.
    pub underfilled_non_root_pages: usize,
    /// Cantidad total de páginas de árbol no raíz.
    pub non_root_pages: usize,
    /// Bytes lógicos ocupados por entradas y cabecera en páginas no raíz (sin padding).
    pub non_root_payload_bytes: usize,
    /// Cantidad de nodos no raíz por tipo.
    pub non_root_leaf_pages: usize,
    pub non_root_internal_pages: usize,
    /// Bytes lógicos ocupados por entradas y cabecera, sin el padding físico de página.
    pub non_root_leaf_payload_bytes: usize,
    pub non_root_internal_payload_bytes: usize,
    /// Extremos de tamaño codificado; None cuando no existe ese tipo de nodo.
    pub smallest_non_root_leaf_payload_bytes: Option<usize>,
    pub largest_non_root_leaf_payload_bytes: Option<usize>,
    pub smallest_non_root_internal_payload_bytes: Option<usize>,
    pub largest_non_root_internal_payload_bytes: Option<usize>,
}


/// Acumula una única imagen final por página durante una mutación multinivel.
/// Repetir una página conserva la generación original esperada y sustituye el
/// payload staged; así el WAL recibe un solo Overwrite por page_id.
#[derive(Default)]
struct PageOverwriteSet {
    pages: BTreeMap<u64, (u64, u64, Vec<u8>)>,
}

impl PageOverwriteSet {
    fn stage(
        &mut self,
        page_id: u64,
        expected_generation: u64,
        new_generation: u64,
        payload: Vec<u8>,
    ) -> Result<(), BTreeError> {
        if expected_generation.checked_add(1) != Some(new_generation) {
            return Err(BTreeError::Invalid("imagen staged de página con ID o generación inválidos"));
        }
        match self.pages.get_mut(&page_id) {
            Some((original, generation, current_payload)) => {
                if *original != expected_generation || *generation != new_generation {
                    return Err(BTreeError::Corrupt("una página staged recibió generaciones incompatibles"));
                }
                *current_payload = payload;
            }
            None => {
                self.pages.insert(page_id, (expected_generation, new_generation, payload));
            }
        }
        Ok(())
    }


    fn stage_free_page(
        &mut self,
        page_id: u64,
        generation: u64,
        free_head: &mut Option<u64>,
    ) -> Result<(), BTreeError> {
        if page_id == 0 {
            return Err(BTreeError::Corrupt("no se puede liberar la página metadata"));
        }
        if self.pages.contains_key(&page_id) {
            return Err(BTreeError::Corrupt("una página no puede modificarse y liberarse en el mismo plan"));
        }
        let next_generation = generation.checked_add(1)
            .ok_or(BTreeError::Invalid("generación de página agotada"))?;
        self.stage(
            page_id,
            generation,
            next_generation,
            crate::page_reuse::FreePage { next: *free_head }.encode(),
        )?;
        *free_head = Some(page_id);
        Ok(())
    }

    fn into_changes(self) -> Vec<PageChange> {
        self.pages.into_iter().map(|(page_id, (expected_generation, new_generation, payload))| {
            PageChange::Overwrite { page_id, expected_generation, new_generation, payload }
        }).collect()
    }
}

/// Estado único de una página dentro de una transacción.
#[derive(Clone, Debug, Eq, PartialEq)]
enum OverlayPageState {
    LiveExisting { expected_generation: u64, new_generation: u64, payload: Vec<u8> },
    FreedExisting { expected_generation: u64, new_generation: u64, next: Option<u64> },
    ReusableExisting { generation: u64, next: Option<u64> },
    LiveAllocated { generation: u64, payload: Vec<u8> },
    FreedAllocated { generation: u64, next: Option<u64> },
}

/// Vista transaccional con un único estado por page_id. No modifica disco;
/// produce como máximo una imagen MLPJ final para cada página modificada.
#[derive(Default)]
struct PageOverlay {
    base_page_count: u64,
    next_page_id: u64,
    pages: BTreeMap<u64, OverlayPageState>,
}

impl PageOverlay {
    fn from_changes(base_page_count: u64, changes: Vec<PageChange>) -> Result<Self, BTreeError> {
        let mut overlay = Self::new(base_page_count);
        for change in changes {
            match change {
                PageChange::Overwrite { page_id, expected_generation, new_generation, payload } =>
                    overlay.stage_overwrite(page_id, expected_generation, new_generation, payload)?,
                PageChange::Allocate { generation, payload } => {
                    let page_id = overlay.next_page_id;
                    overlay.stage_allocate(page_id, generation, payload)?;
                }
            }
        }
        Ok(overlay)
    }

    fn new(base_page_count: u64) -> Self {
        Self { base_page_count, next_page_id: base_page_count, pages: BTreeMap::new() }
    }

    fn logical_page_count(&self) -> u64 { self.next_page_id }

    fn is_freed(&self, page_id: u64) -> bool {
        matches!(self.pages.get(&page_id),
            Some(OverlayPageState::FreedExisting { .. } | OverlayPageState::FreedAllocated { .. }))
    }

    fn is_reusable(&self, page_id: u64) -> bool {
        matches!(self.pages.get(&page_id), Some(OverlayPageState::ReusableExisting { .. }))
    }

    fn is_live(&self, page_id: u64) -> bool {
        matches!(self.pages.get(&page_id),
            Some(OverlayPageState::LiveExisting { .. } | OverlayPageState::LiveAllocated { .. }))
    }

    fn payload(&self, page_id: u64) -> Option<&[u8]> {
        match self.pages.get(&page_id)? {
            OverlayPageState::LiveExisting { payload, .. }
            | OverlayPageState::LiveAllocated { payload, .. } => Some(payload.as_slice()),
            _ => None,
        }
    }

    fn expected_generation(&self, page_id: u64) -> Option<u64> {
        match self.pages.get(&page_id)? {
            OverlayPageState::LiveExisting { expected_generation, .. }
            | OverlayPageState::FreedExisting { expected_generation, .. } => Some(*expected_generation),
            OverlayPageState::LiveAllocated { generation, .. }
            | OverlayPageState::FreedAllocated { generation, .. } => Some(*generation),
            OverlayPageState::ReusableExisting { .. } => None,
        }
    }

    fn stage_overwrite(
        &mut self, page_id: u64, expected_generation: u64,
        new_generation: u64, payload: Vec<u8>,
    ) -> Result<(), BTreeError> {
        if page_id >= self.base_page_count
            || expected_generation.checked_add(1) != Some(new_generation)
            || payload.len() > PAGE_PAYLOAD
        {
            return Err(BTreeError::Corrupt("sobrescritura inválida en overlay"));
        }
        let state = if payload.starts_with(b"MBFR") {
            if page_id == 0 {
                return Err(BTreeError::Corrupt("la metadata no puede convertirse en página libre"));
            }
            let free = crate::page_reuse::FreePage::decode(&payload)
                .map_err(|_| BTreeError::Corrupt("imagen MBFR inválida al importar cambios"))?;
            OverlayPageState::FreedExisting { expected_generation, new_generation, next: free.next }
        } else {
            OverlayPageState::LiveExisting { expected_generation, new_generation, payload }
        };
        match self.pages.get(&page_id) {
            None => {}
            Some(OverlayPageState::LiveExisting {
                expected_generation: original, new_generation: staged, ..
            }) if *original == expected_generation && *staged == new_generation => {}
            _ => return Err(BTreeError::Corrupt("transición de estado o generación incompatible en overlay")),
        }
        self.pages.insert(page_id, state);
        Ok(())
    }

    fn stage_payload(
        &mut self, page_id: u64, generation: u64, payload: Vec<u8>,
    ) -> Result<(), BTreeError> {
        if payload.starts_with(b"MBFR") || payload.len() > PAGE_PAYLOAD {
            return Err(BTreeError::Corrupt("stage_payload requiere una imagen viva válida"));
        }
        let state = match self.pages.get(&page_id) {
            Some(OverlayPageState::LiveAllocated { generation: current, .. }) => {
                if *current != generation {
                    return Err(BTreeError::Corrupt("generación incorrecta de página asignada en overlay"));
                }
                OverlayPageState::LiveAllocated { generation, payload }
            }
            Some(OverlayPageState::LiveExisting { expected_generation, new_generation, .. }) => {
                let original_generation = *expected_generation;
                let staged_generation = *new_generation;
                if generation != original_generation && generation != staged_generation {
                    return Err(BTreeError::Corrupt("generación incompatible al coalescer overlay"));
                }
                if original_generation.checked_add(1) != Some(staged_generation) {
                    return Err(BTreeError::Corrupt("generación staged inválida al coalescer overlay"));
                }
                OverlayPageState::LiveExisting {
                    expected_generation: original_generation,
                    new_generation: staged_generation,
                    payload,
                }
            }
            None => {
                let new_generation = generation.checked_add(1)
                    .ok_or(BTreeError::Invalid("generación agotada en overlay"))?;
                return self.stage_overwrite(page_id, generation, new_generation, payload);
            }
            _ => return Err(BTreeError::Corrupt("no se puede escribir una página libre en overlay")),
        };
        self.pages.insert(page_id, state);
        Ok(())
    }

    fn stage_free_page(
        &mut self, page_id: u64, generation: u64, free_head: &mut Option<u64>,
    ) -> Result<(), BTreeError> {
        if page_id == 0 {
            return Err(BTreeError::Corrupt("no se puede liberar la página metadata"));
        }
        let next = *free_head;
        let state = match self.pages.get(&page_id) {
            Some(OverlayPageState::LiveAllocated { generation: current, .. }) => {
                if *current != generation {
                    return Err(BTreeError::Corrupt("generación incorrecta al liberar asignación staged"));
                }
                OverlayPageState::FreedAllocated { generation, next }
            }
            Some(OverlayPageState::LiveExisting { expected_generation, new_generation, .. }) => {
                if *expected_generation != generation || generation.checked_add(1) != Some(*new_generation) {
                    return Err(BTreeError::Corrupt("generación incompatible al liberar página staged"));
                }
                OverlayPageState::FreedExisting {
                    expected_generation: generation, new_generation: *new_generation, next,
                }
            }
            None if page_id < self.base_page_count => {
                let new_generation = generation.checked_add(1)
                    .ok_or(BTreeError::Invalid("generación agotada al liberar página staged"))?;
                OverlayPageState::FreedExisting { expected_generation: generation, new_generation, next }
            }
            None => return Err(BTreeError::Corrupt("página ausente al liberar en overlay")),
            _ => return Err(BTreeError::Corrupt("página ausente, libre o liberada dos veces en overlay")),
        };
        self.pages.insert(page_id, state);
        *free_head = Some(page_id);
        Ok(())
    }

    /// Registra una página MBFR física ya leída y validada por el caller.
    fn register_free_page(
        &mut self, page_id: u64, generation: u64, next: Option<u64>,
    ) -> Result<(), BTreeError> {
        if page_id == 0 || page_id >= self.base_page_count || self.pages.contains_key(&page_id)
            || next.is_some_and(|id| id == 0 || id >= self.base_page_count || id == page_id)
        {
            return Err(BTreeError::Corrupt("registro MBFR inválido en overlay"));
        }
        self.pages.insert(page_id, OverlayPageState::ReusableExisting { generation, next });
        Ok(())
    }

    /// Reutiliza una MBFR registrada y devuelve su siguiente elemento.
    fn stage_reuse(&mut self, page_id: u64, payload: Vec<u8>) -> Result<Option<u64>, BTreeError> {
        if payload.starts_with(b"MBFR") || payload.len() > PAGE_PAYLOAD {
            return Err(BTreeError::Corrupt("una página reutilizada debe recibir una imagen viva, no MBFR"));
        }
        let (generation, next) = match self.pages.get(&page_id) {
            Some(OverlayPageState::ReusableExisting { generation, next }) => (*generation, *next),
            _ => return Err(BTreeError::Corrupt("reutilización de página no registrada como MBFR")),
        };
        let new_generation = generation.checked_add(1)
            .ok_or(BTreeError::Invalid("generación agotada al reutilizar página"))?;
        self.pages.insert(page_id, OverlayPageState::LiveExisting {
            expected_generation: generation, new_generation, payload,
        });
        Ok(next)
    }

    /// Consume la cabeza de la lista libre en el overlay y deja una única
    /// imagen viva final. Si la página se liberó en esta misma transacción,
    /// conserva la generación final ya calculada en lugar de incrementarla dos veces.
    fn stage_consume_free_head(
        &mut self,
        free_head: &mut Option<u64>,
        payload: Vec<u8>,
    ) -> Result<u64, BTreeError> {
        if payload.starts_with(b"MBFR") || payload.len() > PAGE_PAYLOAD {
            return Err(BTreeError::Corrupt("la reutilización requiere una imagen viva válida"));
        }
        let page_id = (*free_head).ok_or(BTreeError::Corrupt("lista libre vacía al solicitar reutilización"))?;
        let state = match self.pages.get(&page_id) {
            Some(OverlayPageState::ReusableExisting { generation, next }) => {
                let new_generation = generation.checked_add(1)
                    .ok_or(BTreeError::Invalid("generación agotada al reutilizar página"))?;
                (OverlayPageState::LiveExisting {
                    expected_generation: *generation, new_generation, payload,
                }, *next)
            }
            Some(OverlayPageState::FreedExisting { expected_generation, new_generation, next }) => {
                (OverlayPageState::LiveExisting {
                    expected_generation: *expected_generation,
                    new_generation: *new_generation,
                    payload,
                }, *next)
            }
            Some(OverlayPageState::FreedAllocated { generation, next }) => {
                (OverlayPageState::LiveAllocated { generation: *generation, payload }, *next)
            }
            _ => return Err(BTreeError::Corrupt("free_head no identifica una página libre registrada en overlay")),
        };
        self.pages.insert(page_id, state.0);
        *free_head = state.1;
        Ok(page_id)
    }

    fn stage_allocate(
        &mut self, page_id: u64, generation: u64, payload: Vec<u8>,
    ) -> Result<(), BTreeError> {
        if page_id == 0 || page_id != self.next_page_id || generation != 1 || payload.len() > PAGE_PAYLOAD {
            return Err(BTreeError::Corrupt("asignación staged no contigua o con generación inicial inválida"));
        }
        let state = if payload.starts_with(b"MBFR") {
            let free = crate::page_reuse::FreePage::decode(&payload)
                .map_err(|_| BTreeError::Corrupt("asignación MBFR inválida al importar cambios"))?;
            OverlayPageState::FreedAllocated { generation, next: free.next }
        } else {
            OverlayPageState::LiveAllocated { generation, payload }
        };
        if self.pages.contains_key(&page_id) {
            return Err(BTreeError::Corrupt("página asignada dos veces en overlay"));
        }
        self.pages.insert(page_id, state);
        self.next_page_id = self.next_page_id.checked_add(1)
            .ok_or(BTreeError::Invalid("IDs de página agotados en overlay"))?;
        Ok(())
    }

    fn validate(&self) -> Result<(), BTreeError> {
        let allocated_ids = self.pages.iter().filter_map(|(id, state)| {
            matches!(state, OverlayPageState::LiveAllocated { .. } | OverlayPageState::FreedAllocated { .. })
                .then_some(*id)
        }).collect::<Vec<_>>();
        let allocated_count = u64::try_from(allocated_ids.len())
            .map_err(|_| BTreeError::Invalid("cantidad de asignaciones fuera de rango"))?;
        let expected_next = self.base_page_count.checked_add(allocated_count)
            .ok_or(BTreeError::Invalid("IDs de página agotados al validar overlay"))?;
        if self.next_page_id != expected_next {
            return Err(BTreeError::Corrupt("rango de asignaciones no coincide con el límite lógico del overlay"));
        }
        for (offset, page_id) in allocated_ids.iter().enumerate() {
            let expected_id = self.base_page_count.checked_add(
                u64::try_from(offset).map_err(|_| BTreeError::Invalid("offset de asignación fuera de rango"))?
            ).ok_or(BTreeError::Invalid("ID de asignación agotado"))?;
            if *page_id != expected_id {
                return Err(BTreeError::Corrupt("asignaciones staged no contiguas"));
            }
        }
        for (page_id, state) in &self.pages {
            match state {
                OverlayPageState::LiveExisting { expected_generation, new_generation, payload } => {
                    if *page_id >= self.base_page_count
                        || expected_generation.checked_add(1) != Some(*new_generation)
                        || payload.len() > PAGE_PAYLOAD || payload.starts_with(b"MBFR")
                    { return Err(BTreeError::Corrupt("estado de página viva existente inválido")); }
                }
                OverlayPageState::FreedExisting { expected_generation, new_generation, next } => {
                    if *page_id == 0 || *page_id >= self.base_page_count
                        || expected_generation.checked_add(1) != Some(*new_generation)
                        || next.is_some_and(|id| id == 0 || id >= self.next_page_id || id == *page_id || self.is_live(id))
                    { return Err(BTreeError::Corrupt("estado de página libre existente inválido")); }
                }
                OverlayPageState::ReusableExisting { next, .. } => {
                    if *page_id == 0 || *page_id >= self.base_page_count
                        || next.is_some_and(|id| id == 0 || id >= self.next_page_id || id == *page_id || self.is_live(id))
                    { return Err(BTreeError::Corrupt("estado de página reutilizable inválido")); }
                }
                OverlayPageState::LiveAllocated { generation, payload } => {
                    if *page_id < self.base_page_count || *generation != 1
                        || payload.len() > PAGE_PAYLOAD || payload.starts_with(b"MBFR")
                    { return Err(BTreeError::Corrupt("estado de página asignada viva inválido")); }
                }
                OverlayPageState::FreedAllocated { generation, next } => {
                    if *page_id < self.base_page_count || *generation != 1
                        || next.is_some_and(|id| id == 0 || id >= self.next_page_id || id == *page_id || self.is_live(id))
                    { return Err(BTreeError::Corrupt("estado de página asignada libre inválido")); }
                }
            }
        }

        if let Some(metadata_payload) = self.payload(0) {
            let metadata = decode_meta(metadata_payload)?;
            if metadata.root_id == 0 || metadata.root_id >= self.next_page_id
                || self.is_freed(metadata.root_id) || self.is_reusable(metadata.root_id)
                || metadata.free_head == Some(metadata.root_id)
                || metadata.free_head.is_some_and(|id| {
                    id == 0 || id >= self.next_page_id || self.is_live(id)
                })
            {
                return Err(BTreeError::Corrupt("metadata staged referencia raíz o free_head inválidos"));
            }
        }

        let mut checked_free_pages = BTreeSet::new();
        for (start_id, state) in &self.pages {
            if !matches!(state,
                OverlayPageState::FreedExisting { .. }
                | OverlayPageState::ReusableExisting { .. }
                | OverlayPageState::FreedAllocated { .. })
            {
                continue;
            }
            let mut chain = BTreeSet::new();
            let mut cursor = Some(*start_id);
            while let Some(page_id) = cursor {
                if checked_free_pages.contains(&page_id) {
                    break;
                }
                if !chain.insert(page_id) {
                    return Err(BTreeError::Corrupt("ciclo en enlaces de páginas libres staged"));
                }
                cursor = match self.pages.get(&page_id) {
                    Some(OverlayPageState::FreedExisting { next, .. }
                        | OverlayPageState::ReusableExisting { next, .. }
                        | OverlayPageState::FreedAllocated { next, .. }) => *next,
                    Some(OverlayPageState::LiveExisting { .. }
                        | OverlayPageState::LiveAllocated { .. }) => {
                        return Err(BTreeError::Corrupt("enlace de página libre staged apunta a una página viva"));
                    }
                    None => None,
                };
            }
            checked_free_pages.extend(chain);
        }
        Ok(())
    }

    fn into_changes(self) -> Vec<PageChange> {
        self.pages.into_iter().filter_map(|(page_id, state)| match state {
            OverlayPageState::LiveExisting { expected_generation, new_generation, payload } =>
                Some(PageChange::Overwrite { page_id, expected_generation, new_generation, payload }),
            OverlayPageState::FreedExisting { expected_generation, new_generation, next } =>
                Some(PageChange::Overwrite {
                    page_id, expected_generation, new_generation,
                    payload: crate::page_reuse::FreePage { next }.encode(),
                }),
            OverlayPageState::ReusableExisting { .. } => None,
            OverlayPageState::LiveAllocated { generation, payload } =>
                Some(PageChange::Allocate { generation, payload }),
            OverlayPageState::FreedAllocated { generation, next } =>
                Some(PageChange::Allocate {
                    generation, payload: crate::page_reuse::FreePage { next }.encode(),
                }),
        }).collect()
    }
}

/// Operación lógica ordenada que se prepara dentro de una sesión B+Tree.
#[derive(Debug, Eq, PartialEq)]
pub(crate) enum TreeMutation {
    Put { key: Vec<u8>, value: Vec<u8> },
    Delete { key: Vec<u8> },
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum TreeMutationResult {
    Put,
    Delete { deleted: bool },
}

/// Estado aislado de una sesión de mutación. No publica metadata ni toca
/// páginas hasta que se valida y confirma el overlay completo.
struct MutationSession {
    root: RootMeta,
    meta_generation: u64,
    overlay: PageOverlay,
    free_head: Option<u64>,
    changed: bool,
}

impl MutationSession {
    fn new(root: RootMeta, meta_generation: u64, base_page_count: u64) -> Self {
        let free_head = root.free_head;
        Self {
            root,
            meta_generation,
            overlay: PageOverlay::new(base_page_count),
            free_head,
            changed: false,
        }
    }
}

/// Ubicación actual de un hijo. Se resuelve por page_id, nunca por un índice
/// capturado antes de una redistribución o fusión.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ParentLocation {
    parent_id: u64,
    parent_level: u16,
    child_index: usize,
}

#[derive(Default)]
struct SubtreeBounds { min: Option<Vec<u8>>, max: Option<Vec<u8>> }

pub struct PersistentBPlusTree {
    pages: DurablePages,
    root: RootMeta,
    meta_generation: u64,
}

impl PersistentBPlusTree {
    /// Abre o inicializa un árbol. Los dos archivos quedan bloqueados por DurablePages.
    pub fn open(pages_path: impl AsRef<Path>, wal_path: impl AsRef<Path>) -> Result<Self, BTreeError> {
        Self::from_durable_pages(DurablePages::open(pages_path,wal_path)?)
    }

    pub(crate) fn open_read_only_with_pre_recovery_verification<F>(
        pages_path: impl AsRef<Path>,
        wal_path: impl AsRef<Path>,
        verify: F,
    ) -> Result<Self, BTreeError>
    where
        F: FnOnce(&mut std::fs::File, &mut std::fs::File) -> std::io::Result<()>,
    {
        let pages = DurablePages::open_read_only_with_pre_recovery_verification(
            pages_path, wal_path, verify,
        )?;
        Self::from_durable_pages_mode(pages, true)
    }

    pub(crate) fn open_with_pre_recovery_verification_and_session_validator<F>(
        pages_path: impl AsRef<Path>,
        wal_path: impl AsRef<Path>,
        verify: F,
        validator: crate::bundle::SessionLockValidator,
    ) -> Result<Self, BTreeError>
    where F: FnOnce(&mut std::fs::File, &mut std::fs::File) -> std::io::Result<()> {
        let pages = DurablePages::open_with_pre_recovery_verification_and_session_validator(
            pages_path, wal_path, verify, validator,
        )?;
        Self::from_durable_pages(pages)
    }

    pub(crate) fn open_existing_with_session_validator(
        pages_path: impl AsRef<Path>,
        wal_path: impl AsRef<Path>,
        validator: crate::bundle::SessionLockValidator,
    ) -> Result<Self, BTreeError> {
        let pages = DurablePages::open_existing_with_session_validator(
            pages_path, wal_path, validator,
        )?;
        Self::from_durable_pages(pages)
    }

    pub(crate) fn open_with_pre_recovery_verification<F>(
        pages_path:impl AsRef<Path>,
        wal_path:impl AsRef<Path>,
        verify:F,
    )->Result<Self,BTreeError>
    where F:FnOnce(&mut std::fs::File,&mut std::fs::File)->std::io::Result<()> {
        let pages=DurablePages::open_with_pre_recovery_verification(pages_path,wal_path,verify)?;
        Self::from_durable_pages(pages)
    }

    fn from_durable_pages(pages:DurablePages)->Result<Self,BTreeError>{
        Self::from_durable_pages_mode(pages, false)
    }

    fn from_durable_pages_mode(mut pages:DurablePages, read_only:bool)->Result<Self,BTreeError>{
        if pages.page_count()==0 {
            if read_only{return Err(BTreeError::Corrupt("generación publicada vacía"));}
            let leaf=BTreeNode::Leaf{next_leaf:None,entries:Vec::new()}.encode(PAGE_PAYLOAD)?;
            let meta=encode_meta(&RootMeta{root_id:1,level:0,free_head:None});
            pages.transaction(vec![
                PageChange::Allocate{generation:1,payload:meta},
                PageChange::Allocate{generation:1,payload:leaf},
            ])?;
        }
        if pages.page_count()<2{return Err(BTreeError::Corrupt("faltan la metadata o la raíz"));}
        let meta_page=pages.read(0)?;
        let root=decode_meta(&meta_page.payload)?;
        if root.root_id>=pages.page_count(){return Err(BTreeError::Corrupt("root_id fuera del archivo"));}
        let root_page=pages.read(root.root_id)?;
        let node=BTreeNode::decode(&root_page.payload)?;
        let actual_level=match node{
            BTreeNode::Leaf{..}=>0,
            BTreeNode::Internal{level,..}=>level,
        };
        if actual_level!=root.level{return Err(BTreeError::Corrupt("nivel de raíz no coincide con metadata"));}
        Ok(Self{pages,root,meta_generation:meta_page.generation})
    }

    pub fn get(&mut self, key: &[u8]) -> Result<Option<Vec<u8>>, BTreeError> {
        if key.is_empty() { return Err(BTreeError::Invalid("clave vacía")); }
        let mut page_id = self.root.root_id;
        let mut expected_level = self.root.level;
        loop {
            let page = self.pages.read(page_id)?;
            match BTreeNode::decode(&page.payload)? {
                BTreeNode::Leaf { entries, .. } => {
                    if expected_level != 0 { return Err(BTreeError::Corrupt("hoja en nivel inesperado")); }
                    return Ok(entries.binary_search_by(|e| e.key.as_slice().cmp(key))
                        .ok().map(|i| entries[i].value.clone()));
                }
                BTreeNode::Internal { level, first_child, entries } => {
                    if level != expected_level || level == 0 { return Err(BTreeError::Corrupt("nivel interno inconsistente")); }
                    page_id = child_for(&entries, first_child, key);
                    expected_level -= 1;
                }
            }
        }
    }

    /// Resuelve un padre contra la imagen lógica de una transacción aún no
    /// confirmada. Las imágenes staged prevalecen sobre disco; las páginas
    /// liberadas se rechazan incluso si su imagen MBFR todavía no se ha escrito.
    fn resolve_parent_with_overlay(
        &mut self,
        target_id: u64,
        overlay: &PageOverlay,
    ) -> Result<Option<ParentLocation>, BTreeError> {
        let page_count = overlay.logical_page_count();
        let read_payload = |tree: &mut Self, id: u64| -> Result<Vec<u8>, BTreeError> {
            if let Some(payload) = overlay.payload(id) {
                return Ok(payload.to_vec());
            }
            if id >= overlay.base_page_count || overlay.is_freed(id) || overlay.is_reusable(id) {
                return Err(BTreeError::Corrupt("página ausente o libre referenciada en overlay"));
            }
            Ok(tree.pages.read(id)?.payload)
        };

        let (root_id, root_level) = if let Some(payload) = overlay.payload(0) {
            let meta = decode_meta(payload)?;
            (meta.root_id, meta.level)
        } else {
            (self.root.root_id, self.root.level)
        };
        if root_id == 0 || root_id >= page_count {
            return Err(BTreeError::Corrupt("raíz staged fuera del rango lógico disponible"));
        }
        if overlay.is_freed(root_id) || overlay.is_reusable(root_id) {
            return Err(BTreeError::Corrupt("la raíz staged está libre o marcada como liberada"));
        }
        if overlay.is_freed(target_id) {
            return Err(BTreeError::Corrupt("página liberada referenciada en overlay"));
        }
        if target_id == root_id { return Ok(None); }
        if target_id == 0 || target_id >= page_count {
            return Err(BTreeError::Corrupt("candidato de overlay fuera del rango lógico de páginas"));
        }
        let target_payload = read_payload(self, target_id)?;
        let target_level = match BTreeNode::decode(&target_payload)? {
            BTreeNode::Leaf { .. } => 0,
            BTreeNode::Internal { level, .. } => level,
        };

        let target_parent_level = target_level.checked_add(1)
            .ok_or(BTreeError::Invalid("nivel del candidato agotado"))?;
        let mut stack = vec![(root_id, root_level)];
        let mut visited = BTreeSet::new();
        let mut boundary_children = BTreeSet::new();
        let mut found = None;
        while let Some((node_id, expected_level)) = stack.pop() {
            if node_id == 0 || node_id >= page_count {
                return Err(BTreeError::Corrupt("puntero fuera de rango lógico en overlay"));
            }
            if !visited.insert(node_id) {
                return Err(BTreeError::Corrupt("ciclo o hijo compartido en overlay"));
            }
            let payload = read_payload(self, node_id)?;
            match BTreeNode::decode(&payload)? {
                BTreeNode::Leaf { .. } if expected_level == 0 => {}
                BTreeNode::Leaf { .. } => {
                    return Err(BTreeError::Corrupt("hoja en nivel inesperado en overlay"));
                }
                BTreeNode::Internal { level, first_child, entries } => {
                    if level != expected_level || level == 0 || level < target_parent_level {
                        return Err(BTreeError::Corrupt("nivel interno incorrecto al resolver padre en overlay"));
                    }
                    if level == target_parent_level {
                        let mut children = Vec::with_capacity(entries.len() + 1);
                        children.push(first_child);
                        children.extend(entries.iter().map(|entry| entry.right_child));
                        let mut local_children = BTreeSet::new();
                        if children.iter().any(|child| {
                            *child == 0 || *child >= page_count
                                || !local_children.insert(*child)
                                || !boundary_children.insert(*child)
                        }) {
                            return Err(BTreeError::Corrupt("IDs de hijo inválidos o duplicados al resolver padre"));
                        }
                        for (child_index, child_id) in children.into_iter().enumerate() {
                            if child_id == target_id {
                                if found.replace(ParentLocation {
                                    parent_id: node_id,
                                    parent_level: level,
                                    child_index,
                                }).is_some() {
                                    return Err(BTreeError::Corrupt("candidato duplicado en overlay"));
                                }
                            }
                        }
                    } else {
                        let mut children = Vec::with_capacity(entries.len() + 1);
                        children.push(first_child);
                        children.extend(entries.iter().map(|entry| entry.right_child));
                        for child_id in children {
                            stack.push((child_id, level - 1));
                        }
                    }
                }
            }
        }
        found.ok_or(BTreeError::Corrupt("candidato no alcanzable en overlay")).map(Some)
    }

    /// Inserta o reemplaza una clave. Split, enlaces de hojas y metadata de raíz
    /// quedan en una única transacción durable de MLPJ.
    /// Inserta o reemplaza una clave usando una sesión de mutación única.
    /// Todas las lecturas posteriores a un staging observan el overlay compartido.
    pub fn insert(&mut self, key: Vec<u8>, value: Vec<u8>) -> Result<(), BTreeError> {
        if key.is_empty() { return Err(BTreeError::Invalid("clave vacía")); }
        if key.len() > MAX_TREE_KEY_LEN { return Err(BTreeError::Invalid("clave no cabe como separador interno")); }

        let mut session = MutationSession::new(
            self.root.clone(),
            self.meta_generation,
            self.pages.page_count(),
        );
        self.insert_in_session(&key, &value, &mut session)?;
        self.commit_mutation_session(session)?;
        Ok(())
    }

    fn commit_mutation_session(
        &mut self,
        mut session: MutationSession,
    ) -> Result<(), BTreeError> {
        if !session.changed {
            return Ok(());
        }
        session.root.free_head = session.free_head;
        let metadata_changed = session.root != self.root;
        let next_meta_generation = if metadata_changed {
            Some(session.meta_generation.checked_add(1)
                .ok_or(BTreeError::Invalid("generación metadata agotada"))?)
        } else {
            None
        };
        if metadata_changed {
            session.overlay.stage_payload(0, session.meta_generation, encode_meta(&session.root))?;
        }

        session.overlay.validate()?;
        self.validate_free_list_overlay(&session.overlay, session.root.free_head)?;
        let changes = session.overlay.into_changes();
        ensure_transaction_image_limit(changes.len(), MAX_IMAGES_PER_TX)?;
        self.pages.transaction(changes)?;

        if let Some(generation) = next_meta_generation {
            self.root = session.root;
            self.meta_generation = generation;
        }
        Ok(())
    }

    /// Aplica una secuencia ordenada de cambios dentro de un único overlay y
    /// confirma todas las imágenes modificadas mediante una sola transacción MLPJ.
    /// Si una operación falla durante la preparación, la sesión se abandona sin
    /// publicar cambios físicos. Una secuencia de eliminaciones ausentes es no-op.
    pub(crate) fn apply_batch(
        &mut self,
        operations: Vec<TreeMutation>,
    ) -> Result<Vec<TreeMutationResult>, BTreeError> {
        if operations.is_empty() {
            return Err(BTreeError::Invalid("lote vacío"));
        }

        let mut session = MutationSession::new(
            self.root.clone(),
            self.meta_generation,
            self.pages.page_count(),
        );
        let mut results = Vec::with_capacity(operations.len());

        for operation in operations {
            match operation {
                TreeMutation::Put { key, value } => {
                    if key.is_empty() {
                        return Err(BTreeError::Invalid("clave vacía"));
                    }
                    if key.len() > MAX_TREE_KEY_LEN {
                        return Err(BTreeError::Invalid("clave no cabe como separador interno"));
                    }
                    self.insert_in_session(&key, &value, &mut session)?;
                    results.push(TreeMutationResult::Put);
                }
                TreeMutation::Delete { key } => {
                    let deleted = self.remove_in_session(&key, &mut session)?;
                    results.push(TreeMutationResult::Delete { deleted });
                }
            }
        }

        self.commit_mutation_session(session)?;
        Ok(results)
    }

    /// Elimina una clave dentro del overlay compartido y repara los underflows
    /// locales usando la misma vista staged. La reparación se limita al camino
    /// afectado; los déficits sin hermano válido permanecen alcanzables.
    fn remove_in_session(
        &mut self,
        key: &[u8],
        session: &mut MutationSession,
    ) -> Result<bool, BTreeError> {
        if key.is_empty() {
            return Err(BTreeError::Invalid("clave vacía"));
        }

        let mut page_id = session.root.root_id;
        let mut expected_level = session.root.level;
        let mut ancestors = Vec::new();

        loop {
            let (generation, node) = self.read_node_overlay(&session.overlay, page_id)?;
            match node {
                BTreeNode::Leaf { next_leaf, mut entries } => {
                    if expected_level != 0 {
                        return Err(BTreeError::Corrupt("hoja en nivel inesperado al eliminar en sesión"));
                    }
                    let Ok(index) = entries.binary_search_by(|entry| entry.key.as_slice().cmp(key)) else {
                        return Ok(false);
                    };
                    entries.remove(index);
                    let empty = entries.is_empty();
                    session.overlay.stage_payload(
                        page_id,
                        generation,
                        encode_node(&BTreeNode::Leaf { next_leaf, entries })?,
                    )?;

                    if empty {
                        self.repair_descending_underflows(
                            &ancestors,
                            page_id,
                            &mut session.overlay,
                            &mut session.free_head,
                        )?;
                        if let Some(metadata) = session.overlay.payload(0) {
                            session.root = decode_meta(metadata)?;
                            session.free_head = session.root.free_head;
                        }
                    }
                    session.changed = true;
                    return Ok(true);
                }
                BTreeNode::Internal { level, first_child, entries } => {
                    if level != expected_level || level == 0 {
                        return Err(BTreeError::Corrupt("nivel interno inconsistente al eliminar en sesión"));
                    }
                    let child_index = entries.partition_point(|entry| key >= entry.separator.as_slice());
                    let child_id = if child_index == 0 {
                        first_child
                    } else {
                        entries[child_index - 1].right_child
                    };
                    ancestors.push(page_id);
                    page_id = child_id;
                    expected_level -= 1;
                }
            }
        }
    }

    fn insert_in_session(
        &mut self,
        key: &[u8],
        value: &[u8],
        session: &mut MutationSession,
    ) -> Result<(), BTreeError> {
        if key.is_empty() { return Err(BTreeError::Invalid("clave vacía")); }
        if key.len() > MAX_TREE_KEY_LEN { return Err(BTreeError::Invalid("clave no cabe como separador interno")); }
        let split = self.insert_recursive_overlay(session.root.root_id, key, value, session)?;
        session.changed = true;
        if let Some(split) = split {
            let new_level = session.root.level.checked_add(1)
                .ok_or(BTreeError::Invalid("nivel agotado"))?;
            let root_node = BTreeNode::Internal {
                level: new_level,
                first_child: session.root.root_id,
                entries: vec![InternalEntry { separator: split.separator, right_child: split.right_id }],
            };
            let new_root_id = self.allocate_node_overlay(encode_node(&root_node)?, session)?;
            session.root.root_id = new_root_id;
            session.root.level = new_level;
            // Los lectores overlay-aware (p. ej. resolve_parent_with_overlay)
            // deben ver la raíz staged antes del commit final de la sesión.
            session.overlay.stage_payload(
                0,
                session.meta_generation,
                encode_meta(&session.root),
            )?;
        }
        Ok(())
    }

    fn allocate_node_overlay(
        &mut self,
        payload: Vec<u8>,
        session: &mut MutationSession,
    ) -> Result<u64, BTreeError> {
        if let Some(head_id) = session.free_head {
            if session.overlay.is_live(head_id) {
                return Err(BTreeError::Corrupt("free_head apunta a una página viva en la sesión"));
            }
            if !session.overlay.is_freed(head_id) && !session.overlay.is_reusable(head_id) {
                let old = self.pages.read(head_id)?;
                let free = crate::page_reuse::FreePage::decode(&old.payload)
                    .map_err(|_| BTreeError::Corrupt("free_head no apunta a una página MBFR válida"))?;
                session.overlay.register_free_page(head_id, old.generation, free.next)?;
            }
            session.overlay.stage_consume_free_head(&mut session.free_head, payload)
        } else {
            let page_id = session.overlay.logical_page_count();
            session.overlay.stage_allocate(page_id, 1, payload)?;
            Ok(page_id)
        }
    }

    fn insert_recursive_overlay(
        &mut self,
        page_id: u64,
        key: &[u8],
        value: &[u8],
        session: &mut MutationSession,
    ) -> Result<Option<Split>, BTreeError> {
        let (generation, node) = self.read_node_overlay(&session.overlay, page_id)?;
        match node {
            BTreeNode::Leaf { next_leaf, mut entries } => {
                match entries.binary_search_by(|entry| entry.key.as_slice().cmp(key)) {
                    Ok(index) => entries[index].value = value.to_vec(),
                    Err(index) => entries.insert(index, LeafEntry { key: key.to_vec(), value: value.to_vec() }),
                }
                let candidate = BTreeNode::Leaf { next_leaf, entries: entries.clone() };
                if let Ok(payload) = encode_node(&candidate) {
                    session.overlay.stage_payload(page_id, generation, payload)?;
                    return Ok(None);
                }

                let expected_right_id = session.free_head.unwrap_or(session.overlay.logical_page_count());
                let (left, right, separator) = split_leaf(entries, expected_right_id, next_leaf)?;
                let right_id = self.allocate_node_overlay(encode_node(&right)?, session)?;
                if right_id != expected_right_id {
                    return Err(BTreeError::Corrupt("asignador devolvió un page_id inesperado"));
                }
                session.overlay.stage_payload(page_id, generation, encode_node(&left)?)?;
                Ok(Some(Split { separator, right_id }))
            }
            BTreeNode::Internal { level, first_child, mut entries } => {
                if level == 0 {
                    return Err(BTreeError::Corrupt("nodo interno con nivel cero durante inserción"));
                }
                let child_id = child_for(&entries, first_child, key);
                let child_split = self.insert_recursive_overlay(child_id, key, value, session)?;
                let Some(child_split) = child_split else { return Ok(None); };
                let insert_at = entries.partition_point(|entry| entry.separator.as_slice() < child_split.separator.as_slice());
                entries.insert(insert_at, InternalEntry {
                    separator: child_split.separator,
                    right_child: child_split.right_id,
                });
                let candidate = BTreeNode::Internal { level, first_child, entries: entries.clone() };
                if let Ok(payload) = encode_node(&candidate) {
                    session.overlay.stage_payload(page_id, generation, payload)?;
                    return Ok(None);
                }
                let (left, right, separator) = split_internal(level, first_child, entries)?;
                let right_id = self.allocate_node_overlay(encode_node(&right)?, session)?;
                session.overlay.stage_payload(page_id, generation, encode_node(&left)?)?;
                Ok(Some(Split { separator, right_id }))
            }
        }
    }

    /// Reserva una página reutilizando free_head cuando existe; la retirada de la
    /// lista y la escritura del nuevo nodo se confirman en la transacción del llamador.
    fn allocate_node(
        &mut self,
        payload: Vec<u8>,
        next_page: &mut u64,
        free_head: &mut Option<u64>,
        changes: &mut Vec<PageChange>,
    ) -> Result<u64, BTreeError> {
        let base_page_count = self.pages.page_count();
        let mut overlay = PageOverlay::from_changes(base_page_count, std::mem::take(changes))?;
        if *next_page != overlay.logical_page_count() {
            return Err(BTreeError::Corrupt("contador next_page no coincide con el overlay de asignaciones"));
        }

        let page_id = if let Some(head_id) = *free_head {
            if overlay.is_live(head_id) {
                return Err(BTreeError::Corrupt("free_head apunta a una página viva en el overlay"));
            }
            if !overlay.is_freed(head_id) && !overlay.is_reusable(head_id) {
                let old = self.pages.read(head_id)?;
                let free = crate::page_reuse::FreePage::decode(&old.payload)
                    .map_err(|_| BTreeError::Corrupt("free_head no apunta a una página MBFR válida"))?;
                overlay.register_free_page(head_id, old.generation, free.next)?;
            }
            overlay.stage_consume_free_head(free_head, payload)?
        } else {
            let id = overlay.logical_page_count();
            overlay.stage_allocate(id, 1, payload)?;
            id
        };

        overlay.validate()?;
        self.validate_free_list_overlay(&overlay, *free_head)?;
        *next_page = overlay.logical_page_count();
        *changes = overlay.into_changes();
        Ok(page_id)
    }

    /// Valida la cabeza de la lista libre y su siguiente enlace, combinando
    /// estados staged con páginas físicas. El chequeo queda acotado a dos páginas:
    /// no recorre toda la lista en cada inserción o eliminación.
    /// Lee primero el estado staged y luego la página física. Las páginas
    /// liberadas/reutilizables no pueden interpretarse como nodos del árbol.
    fn read_page_overlay(
        &mut self,
        overlay: &PageOverlay,
        page_id: u64,
    ) -> Result<(u64, Vec<u8>), BTreeError> {
        if page_id >= overlay.logical_page_count() {
            return Err(BTreeError::Corrupt("lectura overlay fuera del rango lógico"));
        }
        match overlay.pages.get(&page_id) {
            Some(OverlayPageState::LiveExisting { new_generation, payload, .. }) =>
                Ok((*new_generation, payload.clone())),
            Some(OverlayPageState::LiveAllocated { generation, payload }) =>
                Ok((*generation, payload.clone())),
            Some(OverlayPageState::FreedExisting { .. }
                | OverlayPageState::FreedAllocated { .. }
                | OverlayPageState::ReusableExisting { .. }) =>
                Err(BTreeError::Corrupt("lectura de nodo sobre página libre en overlay")),
            None => {
                if page_id >= overlay.base_page_count {
                    return Err(BTreeError::Corrupt("página lógica sin estado staged ni respaldo físico"));
                }
                let page = self.pages.read(page_id)?;
                Ok((page.generation, page.payload))
            }
        }
    }

    /// Decodifica un nodo desde la misma vista staged/física usada por el
    /// futuro motor común de inserciones y eliminaciones.
    fn read_node_overlay(
        &mut self,
        overlay: &PageOverlay,
        page_id: u64,
    ) -> Result<(u64, BTreeNode), BTreeError> {
        let (generation, payload) = self.read_page_overlay(overlay, page_id)?;
        Ok((generation, BTreeNode::decode(&payload)?))
    }

    fn validate_free_list_overlay(
        &mut self,
        overlay: &PageOverlay,
        free_head: Option<u64>,
    ) -> Result<(), BTreeError> {
        let page_limit = overlay.logical_page_count();
        let Some(head_id) = free_head else { return Ok(()); };
        let next_id = self.read_free_link_overlay(overlay, head_id, page_limit)?;
        if let Some(next_id) = next_id {
            if next_id == head_id {
                return Err(BTreeError::Corrupt("autociclo en la cabeza de la lista libre"));
            }
            // Verificar que el destino inmediato también sea una MBFR real.
            // Los enlaces posteriores se validarán cuando esa página llegue a head.
            let next_next = self.read_free_link_overlay(overlay, next_id, page_limit)?;
            if next_next == Some(head_id) {
                return Err(BTreeError::Corrupt("ciclo corto en la cabeza de la lista libre"));
            }
        }
        Ok(())
    }

    fn read_free_link_overlay(
        &mut self,
        overlay: &PageOverlay,
        page_id: u64,
        page_limit: u64,
    ) -> Result<Option<u64>, BTreeError> {
        if page_id == 0 || page_id >= page_limit {
            return Err(BTreeError::Corrupt("enlace libre fuera del rango lógico"));
        }
        match overlay.pages.get(&page_id) {
            Some(OverlayPageState::FreedExisting { next, .. }
                | OverlayPageState::ReusableExisting { next, .. }
                | OverlayPageState::FreedAllocated { next, .. }) => Ok(*next),
            Some(OverlayPageState::LiveExisting { .. }
                | OverlayPageState::LiveAllocated { .. }) => {
                Err(BTreeError::Corrupt("lista libre staged apunta a una página viva"))
            }
            None => {
                let page = self.pages.read(page_id)?;
                let free = crate::page_reuse::FreePage::decode(&page.payload)
                    .map_err(|_| BTreeError::Corrupt("enlace libre no apunta a una página MBFR válida"))?;
                Ok(free.next)
            }
        }
    }

    /// Elimina una clave mediante una MutationSession y un único overlay durable.
    pub fn remove(&mut self, key: &[u8]) -> Result<bool, BTreeError> {
        if key.is_empty() {
            return Err(BTreeError::Invalid("clave vacía"));
        }
        let mut session = MutationSession::new(
            self.root.clone(),
            self.meta_generation,
            self.pages.page_count(),
        );
        let removed = self.remove_in_session(key, &mut session)?;
        if removed {
            self.commit_mutation_session(session)?;
        }
        Ok(removed)
    }

    fn read_node_from_overlay(
        &mut self, page_id: u64, overlay: &PageOverlay,
    ) -> Result<BTreeNode, BTreeError> {
        if overlay.is_freed(page_id) || overlay.is_reusable(page_id) {
            return Err(BTreeError::Corrupt("lectura de nodo libre desde overlay"));
        }
        let payload = if let Some(payload) = overlay.payload(page_id) {
            payload.to_vec()
        } else {
            if page_id >= overlay.base_page_count {
                return Err(BTreeError::Corrupt("nodo ausente del overlay lógico"));
            }
            self.pages.read(page_id)?.payload
        };
        Ok(BTreeNode::decode(&payload)?)
    }

    fn generation_from_overlay(
        &mut self, page_id: u64, overlay: &PageOverlay,
    ) -> Result<u64, BTreeError> {
        match overlay.expected_generation(page_id) {
            Some(generation) => Ok(generation),
            None => Ok(self.pages.read(page_id)?.generation),
        }
    }

    /// Segunda pasada acotada a los IDs capturados en el camino original.
    /// Resuelve cada padre de nuevo sobre el overlay y repara nodos internos
    /// unarios que ahora tienen hermanos bajo ese mismo padre.
    fn repair_descending_internal_underflows(
        &mut self,
        candidates: &[u64],
        overlay: &mut PageOverlay,
        free_head: &mut Option<u64>,
    ) -> Result<usize, BTreeError> {
        let mut total_repaired = 0usize;
        for _pass in 0..=candidates.len() {
            let mut pass_repaired = 0usize;
            let mut processed = BTreeSet::new();
            for candidate_id in candidates.iter().copied() {
            if !processed.insert(candidate_id)
                || overlay.is_freed(candidate_id)
                || overlay.is_reusable(candidate_id)
            {
                continue;
            }
            let (node_level, node_first, node_entries) =
                match self.read_node_from_overlay(candidate_id, overlay)? {
                    BTreeNode::Internal { level, first_child, entries } => (level, first_child, entries),
                    BTreeNode::Leaf { .. } => continue,
                };
            if !node_entries.is_empty() { continue; }

            let current_root_id = overlay.payload(0).map(decode_meta).transpose()?
                .map(|meta| meta.root_id).unwrap_or(self.root.root_id);
            if candidate_id == current_root_id {
                // Una raíz interna unaria no tiene padre del que obtener un
                // hermano: debe contraerse directamente sobre su único hijo.
                self.stage_root_contraction_overlay(
                    candidate_id, node_level, node_first, overlay, free_head,
                )?;
                pass_repaired += 1;
                continue;
            }

            let Some(location) = self.resolve_parent_with_overlay(candidate_id, overlay)? else {
                continue;
            };

            let (parent_level, parent_first, parent_entries) =
                match self.read_node_from_overlay(location.parent_id, overlay)? {
                    BTreeNode::Internal { level, first_child, entries } => (level, first_child, entries),
                    BTreeNode::Leaf { .. } => return Err(BTreeError::Corrupt("el padre resuelto no es interno")),
                };
            if parent_level != location.parent_level || node_level.checked_add(1) != Some(parent_level) {
                return Err(BTreeError::Corrupt("niveles incompatibles en reparación descendente"));
            }
            let mut children = Vec::with_capacity(parent_entries.len() + 1);
            children.push(parent_first);
            children.extend(parent_entries.iter().map(|entry| entry.right_child));
            if children.get(location.child_index) != Some(&candidate_id) {
                return Err(BTreeError::Corrupt("la posición actual del candidato cambió durante la reparación"));
            }

            let left = if location.child_index > 0 {
                let id = children[location.child_index - 1];
                match self.read_node_from_overlay(id, overlay)? {
                    BTreeNode::Internal { level, first_child, entries } if level == node_level =>
                        Some((id, first_child, entries)),
                    _ => return Err(BTreeError::Corrupt("hermano izquierdo interno inválido en reparación descendente")),
                }
            } else { None };
            let right = if location.child_index + 1 < children.len() {
                let id = children[location.child_index + 1];
                match self.read_node_from_overlay(id, overlay)? {
                    BTreeNode::Internal { level, first_child, entries } if level == node_level =>
                        Some((id, first_child, entries)),
                    _ => return Err(BTreeError::Corrupt("hermano derecho interno inválido en reparación descendente")),
                }
            } else { None };
            if left.is_none() && right.is_none() { continue; }

            let plan = plan_internal_rebalance(
                parent_first,
                parent_entries,
                location.child_index,
                candidate_id,
                node_level,
                node_first,
                node_entries,
                left,
                right,
            )?;
            self.stage_internal_rebalance_plan_overlay(
                location.parent_id,
                parent_level,
                parent_first,
                plan,
                overlay,
                free_head,
            )?;
            pass_repaired += 1;
            }
            total_repaired += pass_repaired;
            if pass_repaired == 0 {
                return Ok(total_repaired);
            }
        }
        Err(BTreeError::Corrupt("la reparación descendente no converge dentro del camino afectado"))
    }

    fn stage_internal_rebalance_plan_overlay(
        &mut self,
        parent_id: u64,
        parent_level: u16,
        parent_first_child: u64,
        plan: InternalRebalancePlan,
        overlay: &mut PageOverlay,
        free_head: &mut Option<u64>,
    ) -> Result<(), BTreeError> {
        if plan.changed_nodes.is_empty() {
            return Err(BTreeError::Corrupt("plan interno sin páginas modificadas"));
        }
        if parent_id == 0 || plan.freed_page_id == Some(0)
            || plan.changed_nodes.iter().any(|(id, _)| *id == 0)
        {
            return Err(BTreeError::Corrupt("el plan interno intenta usar la página metadata como nodo"));
        }
        if plan.changed_nodes.iter().any(|(id, _)| *id == parent_id || Some(*id) == plan.freed_page_id)
            || plan.freed_page_id == Some(parent_id)
        {
            return Err(BTreeError::Corrupt("el plan repite el padre o libera una página superviviente"));
        }
        if !plan.changed_nodes.iter().any(|(id, _)| *id == plan.surviving_page_id) {
            return Err(BTreeError::Corrupt("el superviviente no aparece entre las páginas modificadas"));
        }
        let mut changed_ids = BTreeSet::new();
        let mut node_level = None;
        for (page_id, node) in &plan.changed_nodes {
            if !changed_ids.insert(*page_id) {
                return Err(BTreeError::Corrupt("el plan interno repite un page_id"));
            }
            match node {
                BTreeNode::Internal { level, .. } => {
                    if node_level.replace(*level).is_some_and(|previous| previous != *level) {
                        return Err(BTreeError::Corrupt("el plan mezcla niveles internos"));
                    }
                }
                _ => return Err(BTreeError::Corrupt("plan interno contiene una hoja")),
            }
        }
        let node_level = node_level.ok_or(BTreeError::Corrupt("plan interno sin nivel"))?;
        if parent_level != node_level.checked_add(1)
            .ok_or(BTreeError::Invalid("nivel de padre agotado"))?
        {
            return Err(BTreeError::Corrupt("nivel del padre incompatible con el plan interno"));
        }

        let root_id = overlay.payload(0).map(decode_meta).transpose()?
            .map(|meta| meta.root_id).unwrap_or(self.root.root_id);
        if plan.freed_page_id == Some(root_id) {
            return Err(BTreeError::Corrupt("el plan intenta liberar la raíz lógica"));
        }
        let survivor_is_child = parent_first_child == plan.surviving_page_id
            || plan.parent_entries.iter().any(|entry| entry.right_child == plan.surviving_page_id);
        if !survivor_is_child {
            return Err(BTreeError::Corrupt("el padre staged no referencia al superviviente del rebalanceo"));
        }

        let parent_current_payload = if let Some(payload) = overlay.payload(parent_id) {
            payload.to_vec()
        } else {
            if overlay.is_freed(parent_id) || overlay.is_reusable(parent_id) {
                return Err(BTreeError::Corrupt("el padre del rebalanceo está libre en overlay"));
            }
            self.pages.read(parent_id)?.payload
        };
        let (current_parent_level, current_parent_first, current_parent_entries) =
            match BTreeNode::decode(&parent_current_payload)? {
                BTreeNode::Internal { level, first_child, entries } => (level, first_child, entries),
                BTreeNode::Leaf { .. } => return Err(BTreeError::Corrupt("el padre del rebalanceo no es interno")),
            };
        if current_parent_level != parent_level {
            return Err(BTreeError::Corrupt("nivel del padre físico/staged no coincide con el plan"));
        }
        let mut current_children = BTreeSet::new();
        current_children.insert(current_parent_first);
        current_children.extend(current_parent_entries.iter().map(|entry| entry.right_child));
        if current_children.contains(&0) || current_children.len() != current_parent_entries.len() + 1 {
            return Err(BTreeError::Corrupt("el padre actual contiene IDs de hijo inválidos o duplicados"));
        }
        if plan.changed_nodes.iter().any(|(id, _)| !current_children.contains(id))
            || plan.freed_page_id.is_some_and(|id| !current_children.contains(&id))
        {
            return Err(BTreeError::Corrupt("las páginas del plan no son hijos actuales del padre"));
        }

        for (page_id, node) in &plan.changed_nodes {
            if overlay.is_freed(*page_id) || overlay.is_reusable(*page_id) {
                return Err(BTreeError::Corrupt("el plan intenta modificar un nodo libre"));
            }
            let current_payload = if let Some(payload) = overlay.payload(*page_id) {
                payload.to_vec()
            } else {
                self.pages.read(*page_id)?.payload
            };
            match BTreeNode::decode(&current_payload)? {
                BTreeNode::Internal { level, .. } if level == node_level => {}
                _ => return Err(BTreeError::Corrupt("nodo actual incompatible con el nivel del plan")),
            }
            let generation = match overlay.expected_generation(*page_id) {
                Some(generation) => generation,
                None => self.pages.read(*page_id)?.generation,
            };
            overlay.stage_payload(*page_id, generation, encode_node(node)?)?;
        }

        let parent_generation = match overlay.expected_generation(parent_id) {
            Some(generation) => generation,
            None => self.pages.read(parent_id)?.generation,
        };
        let parent_collapses_root = parent_id == root_id && plan.parent_entries.is_empty();
        let surviving_page_id = plan.surviving_page_id;
        overlay.stage_payload(
            parent_id,
            parent_generation,
            encode_node(&BTreeNode::Internal {
                level: parent_level,
                first_child: parent_first_child,
                entries: plan.parent_entries,
            })?,
        )?;

        if let Some(freed_id) = plan.freed_page_id {
            let generation = match overlay.expected_generation(freed_id) {
                Some(generation) => generation,
                None => self.pages.read(freed_id)?.generation,
            };
            overlay.stage_free_page(freed_id, generation, free_head)?;
        }

        if parent_collapses_root {
            self.stage_root_contraction_overlay(
                parent_id, parent_level, surviving_page_id, overlay, free_head,
            )?;
        }
        Ok(())
    }

    fn stage_root_contraction_overlay(
        &mut self,
        old_root_id: u64,
        old_root_level: u16,
        surviving_child: u64,
        overlay: &mut PageOverlay,
        free_head: &mut Option<u64>,
    ) -> Result<(), BTreeError> {
        let mut root_to_free = old_root_id;
        let mut root_level = old_root_level;
        let mut child_id = surviving_child;
        let mut visited = BTreeSet::new();
        loop {
            if !visited.insert(root_to_free) || child_id == root_to_free || child_id == 0 {
                return Err(BTreeError::Corrupt("ciclo al contraer raíces staged"));
            }
            let current_root_id = overlay.payload(0).map(decode_meta).transpose()?
                .map(|meta| meta.root_id).unwrap_or(self.root.root_id);
            if current_root_id != root_to_free {
                return Err(BTreeError::Corrupt("la raíz cambió antes de su contracción staged"));
            }
            let generation = self.generation_from_overlay(root_to_free, overlay)?;
            overlay.stage_free_page(root_to_free, generation, free_head)?;

            let new_level = root_level.checked_sub(1)
                .ok_or(BTreeError::Corrupt("nivel inválido al contraer raíz staged"))?;
            let metadata_generation = overlay.expected_generation(0).unwrap_or(self.meta_generation);
            let mut metadata = overlay.payload(0).map(decode_meta).transpose()?
                .unwrap_or_else(|| self.root.clone());
            metadata.root_id = child_id;
            metadata.level = new_level;
            metadata.free_head = *free_head;
            overlay.stage_payload(0, metadata_generation, encode_meta(&metadata))?;

            match self.read_node_from_overlay(child_id, overlay)? {
                BTreeNode::Leaf { .. } if new_level == 0 => return Ok(()),
                BTreeNode::Internal { level, first_child, entries } if level == new_level => {
                    if entries.is_empty() {
                        root_to_free = child_id;
                        root_level = level;
                        child_id = first_child;
                    } else {
                        return Ok(());
                    }
                }
                BTreeNode::Leaf { .. } => {
                    return Err(BTreeError::Corrupt("hoja con nivel incorrecto tras contraer raíz"));
                }
                BTreeNode::Internal { .. } => {
                    return Err(BTreeError::Corrupt("nivel interno incorrecto tras contraer raíz"));
                }
            }
        }
    }

    fn is_underfilled_internal_node_candidate(
        &mut self,
        page_id: u64,
        overlay: &PageOverlay,
    ) -> Result<bool, BTreeError> {
        if overlay.is_freed(page_id) || overlay.is_reusable(page_id) {
            return Ok(false);
        }
        let root_id = overlay.payload(0).map(decode_meta).transpose()?
            .map(|meta| meta.root_id).unwrap_or(self.root.root_id);
        if page_id == root_id {
            return Ok(false);
        }
        match self.read_node_from_overlay(page_id, overlay)? {
            BTreeNode::Internal { entries, .. } => Ok(
                entries.is_empty()
                    || internal_encoded_size(&entries) < MIN_DIAGNOSTIC_OCCUPANCY_BYTES
            ),
            BTreeNode::Leaf { .. } =>
                Err(BTreeError::Corrupt("el candidato de ocupación interna es una hoja")),
        }
    }

    /// Devuelve el padre si una mutación staged lo dejó vacío o subocupado.
    /// La raíz se excluye porque sus reglas de contracción son distintas.
    fn underfilled_internal_parent_candidate(
        &mut self,
        child_id: u64,
        overlay: &PageOverlay,
    ) -> Result<Option<u64>, BTreeError> {
        let Some(location) = self.resolve_parent_with_overlay(child_id, overlay)? else {
            return Ok(None);
        };
        let root_id = overlay.payload(0).map(decode_meta).transpose()?
            .map(|meta| meta.root_id).unwrap_or(self.root.root_id);
        if location.parent_id == root_id {
            return Ok(None);
        }
        match self.read_node_from_overlay(location.parent_id, overlay)? {
            BTreeNode::Internal { entries, .. }
                if entries.is_empty()
                    || internal_encoded_size(&entries) < MIN_DIAGNOSTIC_OCCUPANCY_BYTES =>
            {
                Ok(Some(location.parent_id))
            }
            BTreeNode::Internal { .. } => Ok(None),
            BTreeNode::Leaf { .. } =>
                Err(BTreeError::Corrupt("el padre de un nodo no raíz no es interno")),
        }
    }

    /// Redistribuye o fusiona dos nodos internos hermanos del mismo nivel.
    /// El separador del padre se incorpora al conjunto ordenado; al redistribuir,
    /// uno de los separadores vuelve al padre y los punteros hijos se conservan
    /// en orden. Al fusionar, se libera el hermano derecho y se propaga el cambio
    /// al padre. Todas las imágenes quedan en el mismo overlay/WAL.
    fn repair_underfilled_internal_by_bytes(
        &mut self,
        candidate_id: u64,
        overlay: &mut PageOverlay,
        free_head: &mut Option<u64>,
    ) -> Result<bool, BTreeError> {
        if overlay.is_freed(candidate_id) || overlay.is_reusable(candidate_id) {
            return Ok(false);
        }
        let (candidate_level, candidate_entries) =
            match self.read_node_from_overlay(candidate_id, overlay)? {
                BTreeNode::Internal { level, entries, .. } => (level, entries),
                BTreeNode::Leaf { .. } => return Ok(false),
            };
        if candidate_entries.is_empty()
            || internal_encoded_size(&candidate_entries) >= MIN_DIAGNOSTIC_OCCUPANCY_BYTES
        {
            return Ok(false);
        }
        let Some(location) = self.resolve_parent_with_overlay(candidate_id, overlay)? else {
            return Ok(false);
        };
        let (parent_level, parent_first, mut parent_entries) =
            match self.read_node_from_overlay(location.parent_id, overlay)? {
                BTreeNode::Internal { level, first_child, entries } =>
                    (level, first_child, entries),
                BTreeNode::Leaf { .. } =>
                    return Err(BTreeError::Corrupt("el padre de nodo interno no es interno")),
            };
        if parent_level != location.parent_level
            || candidate_level.checked_add(1) != Some(parent_level)
        {
            return Err(BTreeError::Corrupt("niveles incompatibles en redistribución interna por bytes"));
        }
        let mut children = Vec::with_capacity(parent_entries.len() + 1);
        children.push(parent_first);
        children.extend(parent_entries.iter().map(|entry| entry.right_child));
        if children.get(location.child_index) != Some(&candidate_id) {
            return Err(BTreeError::Corrupt("posición del nodo interno cambió durante redistribución"));
        }

        let (left_id, right_id, separator_index) = if location.child_index > 0 {
            (children[location.child_index - 1], candidate_id, location.child_index - 1)
        } else if location.child_index + 1 < children.len() {
            (candidate_id, children[location.child_index + 1], location.child_index)
        } else {
            return Ok(false);
        };
        let (left_level, left_first, left_entries) =
            match self.read_node_from_overlay(left_id, overlay)? {
                BTreeNode::Internal { level, first_child, entries } =>
                    (level, first_child, entries),
                BTreeNode::Leaf { .. } =>
                    return Err(BTreeError::Corrupt("hermano interno izquierdo es hoja")),
            };
        let (right_level, right_first, right_entries) =
            match self.read_node_from_overlay(right_id, overlay)? {
                BTreeNode::Internal { level, first_child, entries } =>
                    (level, first_child, entries),
                BTreeNode::Leaf { .. } =>
                    return Err(BTreeError::Corrupt("hermano interno derecho es hoja")),
            };
        if left_level != candidate_level || right_level != candidate_level {
            return Err(BTreeError::Corrupt("hermanos internos con niveles distintos"));
        }

        let mut combined_entries = left_entries.clone();
        combined_entries.push(InternalEntry {
            separator: parent_entries[separator_index].separator.clone(),
            right_child: right_first,
        });
        combined_entries.extend(right_entries.iter().cloned());
        let mut combined_children = Vec::with_capacity(combined_entries.len() + 1);
        combined_children.push(left_first);
        combined_children.extend(left_entries.iter().map(|entry| entry.right_child));
        combined_children.push(right_first);
        combined_children.extend(right_entries.iter().map(|entry| entry.right_child));
        if combined_children.len() != combined_entries.len() + 1 {
            return Err(BTreeError::Corrupt("cantidad de punteros incompatible en redistribución interna"));
        }

        if internal_encoded_size(&combined_entries) <= PAGE_PAYLOAD {
            parent_entries.remove(separator_index);
            let root_id = overlay.payload(0).map(decode_meta).transpose()?
                .map(|meta| meta.root_id).unwrap_or(self.root.root_id);
            let contracts_root = location.parent_id == root_id && parent_entries.is_empty();
            if !contracts_root {
                let parent_generation = self.generation_from_overlay(location.parent_id, overlay)?;
                overlay.stage_payload(
                    location.parent_id,
                    parent_generation,
                    encode_node(&BTreeNode::Internal {
                        level: parent_level,
                        first_child: parent_first,
                        entries: parent_entries.clone(),
                    })?,
                )?;
            }
            let mut merged_entries = combined_entries;
            for (index, entry) in merged_entries.iter_mut().enumerate() {
                entry.right_child = combined_children[index + 1];
            }
            let left_generation = self.generation_from_overlay(left_id, overlay)?;
            overlay.stage_payload(
                left_id,
                left_generation,
                encode_node(&BTreeNode::Internal {
                    level: candidate_level,
                    first_child: combined_children[0],
                    entries: merged_entries,
                })?,
            )?;
            let right_generation = self.generation_from_overlay(right_id, overlay)?;
            overlay.stage_free_page(right_id, right_generation, free_head)?;
            if contracts_root {
                self.stage_root_contraction_overlay(
                    location.parent_id, parent_level, left_id, overlay, free_head,
                )?;
            }
            return Ok(true);
        }

        let Some(plan) = plan_internal_redistribution(
            &combined_entries, PAGE_PAYLOAD, MIN_DIAGNOSTIC_OCCUPANCY_BYTES,
        ) else {
            return Ok(false);
        };
        if plan.underfilled_pages >= 2 {
            return Ok(false);
        }
        let promoted_separator = combined_entries[plan.promoted_index].separator.clone();
        let new_left_first = combined_children[0];
        let new_right_first = combined_children[plan.promoted_index + 1];
        let mut new_left_entries = combined_entries[..plan.promoted_index].to_vec();
        for (index, entry) in new_left_entries.iter_mut().enumerate() {
            entry.right_child = combined_children[index + 1];
        }
        let mut new_right_entries = combined_entries[plan.promoted_index + 1..].to_vec();
        for (index, entry) in new_right_entries.iter_mut().enumerate() {
            entry.right_child = combined_children[plan.promoted_index + 2 + index];
        }
        if new_left_first == left_first
            && new_right_first == right_first
            && new_left_entries == left_entries
            && new_right_entries == right_entries
            && promoted_separator == parent_entries[separator_index].separator
        {
            return Ok(false);
        }
        parent_entries[separator_index].separator = promoted_separator;
        if internal_encoded_size(&parent_entries) > PAGE_PAYLOAD {
            return Ok(false);
        }

        let left_generation = self.generation_from_overlay(left_id, overlay)?;
        overlay.stage_payload(
            left_id, left_generation,
            encode_node(&BTreeNode::Internal {
                level: candidate_level,
                first_child: new_left_first,
                entries: new_left_entries,
            })?,
        )?;
        let right_generation = self.generation_from_overlay(right_id, overlay)?;
        overlay.stage_payload(
            right_id, right_generation,
            encode_node(&BTreeNode::Internal {
                level: candidate_level,
                first_child: new_right_first,
                entries: new_right_entries,
            })?,
        )?;
        let parent_generation = self.generation_from_overlay(location.parent_id, overlay)?;
        overlay.stage_payload(
            location.parent_id, parent_generation,
            encode_node(&BTreeNode::Internal {
                level: parent_level,
                first_child: parent_first,
                entries: parent_entries,
            })?,
        )?;
        Ok(true)
    }

    /// Redistribuye o fusiona dos hojas hermanas no vacías bajo el mismo padre.
    /// Mantiene orden, separadores y enlaces next_leaf; al fusionar libera la
    /// hoja derecha y actualiza el padre. Todas las imágenes se publican juntas
    /// mediante el overlay y una única transacción WAL.
    fn repair_underfilled_leaf_by_bytes(
        &mut self,
        candidate_id: u64,
        overlay: &mut PageOverlay,
        free_head: &mut Option<u64>,
    ) -> Result<bool, BTreeError> {
        if overlay.is_freed(candidate_id) || overlay.is_reusable(candidate_id) {
            return Ok(false);
        }
        let candidate_entries = match self.read_node_from_overlay(candidate_id, overlay)? {
            BTreeNode::Leaf { entries, .. } => entries,
            BTreeNode::Internal { .. } => return Ok(false),
        };
        if leaf_encoded_size(&candidate_entries) >= MIN_DIAGNOSTIC_OCCUPANCY_BYTES {
            return Ok(false);
        }
        let Some(location) = self.resolve_parent_with_overlay(candidate_id, overlay)? else {
            return Ok(false);
        };
        if location.parent_level != 1 {
            return Ok(false);
        }
        let (parent_level, parent_first, mut parent_entries) =
            match self.read_node_from_overlay(location.parent_id, overlay)? {
                BTreeNode::Internal { level, first_child, entries } =>
                    (level, first_child, entries),
                BTreeNode::Leaf { .. } =>
                    return Err(BTreeError::Corrupt("el padre de hoja no es interno")),
            };
        if parent_level != 1 {
            return Err(BTreeError::Corrupt("nivel del padre incompatible con hojas"));
        }
        let mut children = Vec::with_capacity(parent_entries.len() + 1);
        children.push(parent_first);
        children.extend(parent_entries.iter().map(|entry| entry.right_child));
        if children.get(location.child_index) != Some(&candidate_id) {
            return Err(BTreeError::Corrupt("posición de hoja cambió durante redistribución por bytes"));
        }

        let (left_id, right_id, separator_index) = if location.child_index > 0 {
            (children[location.child_index - 1], candidate_id, location.child_index - 1)
        } else if location.child_index + 1 < children.len() {
            (candidate_id, children[location.child_index + 1], location.child_index)
        } else {
            return Ok(false);
        };
        let (left_next, mut left_entries) = match self.read_node_from_overlay(left_id, overlay)? {
            BTreeNode::Leaf { next_leaf, entries } => (next_leaf, entries),
            BTreeNode::Internal { .. } =>
                return Err(BTreeError::Corrupt("hermano izquierdo no es hoja")),
        };
        let (right_next, right_entries) = match self.read_node_from_overlay(right_id, overlay)? {
            BTreeNode::Leaf { next_leaf, entries } => (next_leaf, entries),
            BTreeNode::Internal { .. } =>
                return Err(BTreeError::Corrupt("hermano derecho no es hoja")),
        };
        if left_next != Some(right_id) {
            return Err(BTreeError::Corrupt("enlace entre hojas hermanas no coincide"));
        }
        if left_entries.is_empty() || right_entries.is_empty() {
            return Ok(false);
        }
        if left_entries.last().unwrap().key.as_slice() >= right_entries[0].key.as_slice() {
            return Err(BTreeError::Corrupt("claves de hojas hermanas no están ordenadas"));
        }

        left_entries.extend(right_entries);
        if leaf_encoded_size(&left_entries) <= PAGE_PAYLOAD {
            parent_entries.remove(separator_index);
            let root_id = overlay.payload(0).map(decode_meta).transpose()?
                .map(|meta| meta.root_id).unwrap_or(self.root.root_id);
            let contracts_root = location.parent_id == root_id && parent_entries.is_empty();
            if !contracts_root {
                let parent_generation = self.generation_from_overlay(location.parent_id, overlay)?;
                overlay.stage_payload(
                    location.parent_id,
                    parent_generation,
                    encode_node(&BTreeNode::Internal {
                        level: parent_level,
                        first_child: parent_first,
                        entries: parent_entries.clone(),
                    })?,
                )?;
            }
            let left_generation = self.generation_from_overlay(left_id, overlay)?;
            overlay.stage_payload(
                left_id,
                left_generation,
                encode_node(&BTreeNode::Leaf {
                    next_leaf: right_next,
                    entries: left_entries,
                })?,
            )?;
            let right_generation = self.generation_from_overlay(right_id, overlay)?;
            overlay.stage_free_page(right_id, right_generation, free_head)?;
            if contracts_root {
                self.stage_root_contraction_overlay(
                    location.parent_id, parent_level, left_id, overlay, free_head,
                )?;
            }
            return Ok(true);
        }

        let original_left = match self.read_node_from_overlay(left_id, overlay)? {
            BTreeNode::Leaf { entries, .. } => entries,
            _ => return Err(BTreeError::Corrupt("hermano izquierdo dejó de ser hoja")),
        };
        let original_right = match self.read_node_from_overlay(right_id, overlay)? {
            BTreeNode::Leaf { entries, .. } => entries,
            _ => return Err(BTreeError::Corrupt("hermano derecho dejó de ser hoja")),
        };
        let Some(plan) = plan_leaf_redistribution(
            &left_entries, PAGE_PAYLOAD, MIN_DIAGNOSTIC_OCCUPANCY_BYTES,
        ) else {
            return Ok(false);
        };
        let new_left = left_entries[..plan.split_index].to_vec();
        let new_right = left_entries[plan.split_index..].to_vec();
        if plan.underfilled_pages >= 2
            || (new_left == original_left && new_right == original_right)
        {
            return Ok(false);
        }
        parent_entries[separator_index].separator = new_right[0].key.clone();
        if internal_encoded_size(&parent_entries) > PAGE_PAYLOAD {
            return Ok(false);
        }

        let left_generation = self.generation_from_overlay(left_id, overlay)?;
        overlay.stage_payload(
            left_id, left_generation,
            encode_node(&BTreeNode::Leaf { next_leaf: Some(right_id), entries: new_left })?,
        )?;
        let right_generation = self.generation_from_overlay(right_id, overlay)?;
        overlay.stage_payload(
            right_id, right_generation,
            encode_node(&BTreeNode::Leaf { next_leaf: right_next, entries: new_right })?,
        )?;
        let parent_generation = self.generation_from_overlay(location.parent_id, overlay)?;
        overlay.stage_payload(
            location.parent_id, parent_generation,
            encode_node(&BTreeNode::Internal {
                level: parent_level, first_child: parent_first, entries: parent_entries,
            })?,
        )?;
        Ok(true)
    }

    fn repair_descending_leaf_underflow(
        &mut self,
        candidate_id: u64,
        overlay: &mut PageOverlay,
        free_head: &mut Option<u64>,
    ) -> Result<(bool, Option<u64>), BTreeError> {
        if overlay.is_freed(candidate_id) || overlay.is_reusable(candidate_id) {
            return Ok((false, None));
        }
        let Some(location) = self.resolve_parent_with_overlay(candidate_id, overlay)? else {
            return Ok((false, None));
        };
        let (next_leaf, mut leaf_entries) = match self.read_node_from_overlay(candidate_id, overlay)? {
            BTreeNode::Leaf { next_leaf, entries } => (next_leaf, entries),
            BTreeNode::Internal { .. } => return Ok((false, None)),
        };
        if !leaf_entries.is_empty() { return Ok((false, None)); }

        let (parent_level, parent_first, mut parent_entries) =
            match self.read_node_from_overlay(location.parent_id, overlay)? {
                BTreeNode::Internal { level, first_child, entries } => (level, first_child, entries),
                BTreeNode::Leaf { .. } => return Err(BTreeError::Corrupt("el padre de hoja resuelto no es interno")),
            };
        if parent_level != 1 || location.parent_level != 1 {
            return Err(BTreeError::Corrupt("una hoja vacía no está bajo un padre de nivel uno"));
        }
        let mut children = Vec::with_capacity(parent_entries.len() + 1);
        children.push(parent_first);
        children.extend(parent_entries.iter().map(|entry| entry.right_child));
        if children.get(location.child_index) != Some(&candidate_id) {
            return Err(BTreeError::Corrupt("la posición actual de la hoja vacía cambió"));
        }

        if location.child_index > 0 {
            let left_id = children[location.child_index - 1];
            let (left_next, mut left_entries) = match self.read_node_from_overlay(left_id, overlay)? {
                BTreeNode::Leaf { next_leaf, entries } => (next_leaf, entries),
                BTreeNode::Internal { .. } => return Err(BTreeError::Corrupt("hermano izquierdo de hoja no es hoja")),
            };
            if left_next != Some(candidate_id) {
                return Err(BTreeError::Corrupt("enlace del hermano izquierdo no apunta a la hoja vacía"));
            }
            if left_entries.len() > 1 {
                let borrowed = left_entries.pop().ok_or(BTreeError::Corrupt("hermano izquierdo vacío"))?;
                parent_entries[location.child_index - 1].separator = borrowed.key.clone();
                leaf_entries.push(borrowed);
                let left_generation = self.generation_from_overlay(left_id, overlay)?;
                overlay.stage_payload(
                    left_id, left_generation,
                    encode_node(&BTreeNode::Leaf { next_leaf: left_next, entries: left_entries })?,
                )?;
                let leaf_generation = self.generation_from_overlay(candidate_id, overlay)?;
                overlay.stage_payload(
                    candidate_id, leaf_generation,
                    encode_node(&BTreeNode::Leaf { next_leaf, entries: leaf_entries })?,
                )?;
                let parent_generation = self.generation_from_overlay(location.parent_id, overlay)?;
                overlay.stage_payload(
                    location.parent_id, parent_generation,
                    encode_node(&BTreeNode::Internal { level: parent_level, first_child: parent_first, entries: parent_entries })?,
                )?;
                return Ok((true, None));
            }

            parent_entries.remove(location.child_index - 1);
            let retry_candidate = if left_entries.is_empty() { Some(left_id) } else { None };
            let left_generation = self.generation_from_overlay(left_id, overlay)?;
            overlay.stage_payload(
                left_id, left_generation,
                encode_node(&BTreeNode::Leaf { next_leaf, entries: left_entries })?,
            )?;
            let parent_generation = self.generation_from_overlay(location.parent_id, overlay)?;
            overlay.stage_payload(
                location.parent_id, parent_generation,
                encode_node(&BTreeNode::Internal {
                    level: parent_level, first_child: parent_first, entries: parent_entries.clone(),
                })?,
            )?;
            let leaf_generation = self.generation_from_overlay(candidate_id, overlay)?;
            overlay.stage_free_page(candidate_id, leaf_generation, free_head)?;
            let root_id = overlay.payload(0).map(decode_meta).transpose()?
                .map(|meta| meta.root_id).unwrap_or(self.root.root_id);
            if location.parent_id == root_id && parent_entries.is_empty() {
                self.stage_root_contraction_overlay(
                    location.parent_id, parent_level, left_id, overlay, free_head,
                )?;
            }
            return Ok((true, retry_candidate));
        }

        if location.child_index < parent_entries.len() {
            let right_id = children[location.child_index + 1];
            let (right_next, mut right_entries) = match self.read_node_from_overlay(right_id, overlay)? {
                BTreeNode::Leaf { next_leaf, entries } => (next_leaf, entries),
                BTreeNode::Internal { .. } => return Err(BTreeError::Corrupt("hermano derecho de hoja no es hoja")),
            };
            if next_leaf != Some(right_id) {
                return Err(BTreeError::Corrupt("enlace de hoja derecha no coincide con el hermano"));
            }
            if right_entries.len() > 1 {
                let borrowed = right_entries.remove(0);
                parent_entries[location.child_index].separator = right_entries.first()
                    .ok_or(BTreeError::Corrupt("hermano derecho quedó vacío tras redistribuir"))?.key.clone();
                leaf_entries.push(borrowed);
                let leaf_generation = self.generation_from_overlay(candidate_id, overlay)?;
                overlay.stage_payload(
                    candidate_id, leaf_generation,
                    encode_node(&BTreeNode::Leaf { next_leaf, entries: leaf_entries })?,
                )?;
                let right_generation = self.generation_from_overlay(right_id, overlay)?;
                overlay.stage_payload(
                    right_id, right_generation,
                    encode_node(&BTreeNode::Leaf { next_leaf: right_next, entries: right_entries })?,
                )?;
                let parent_generation = self.generation_from_overlay(location.parent_id, overlay)?;
                overlay.stage_payload(
                    location.parent_id, parent_generation,
                    encode_node(&BTreeNode::Internal { level: parent_level, first_child: parent_first, entries: parent_entries })?,
                )?;
                return Ok((true, None));
            }

            if next_leaf != Some(right_id) {
                return Err(BTreeError::Corrupt("enlace de hoja derecha no coincide con el hermano"));
            }
            parent_entries.remove(location.child_index);
            leaf_entries.extend(right_entries);
            let retry_candidate = if leaf_entries.is_empty() { Some(candidate_id) } else { None };
            let leaf_generation = self.generation_from_overlay(candidate_id, overlay)?;
            overlay.stage_payload(
                candidate_id, leaf_generation,
                encode_node(&BTreeNode::Leaf { next_leaf: right_next, entries: leaf_entries })?,
            )?;
            let parent_generation = self.generation_from_overlay(location.parent_id, overlay)?;
            overlay.stage_payload(
                location.parent_id, parent_generation,
                encode_node(&BTreeNode::Internal {
                    level: parent_level, first_child: parent_first, entries: parent_entries.clone(),
                })?,
            )?;
            let right_generation = self.generation_from_overlay(right_id, overlay)?;
            overlay.stage_free_page(right_id, right_generation, free_head)?;
            let root_id = overlay.payload(0).map(decode_meta).transpose()?
                .map(|meta| meta.root_id).unwrap_or(self.root.root_id);
            if location.parent_id == root_id && parent_entries.is_empty() {
                self.stage_root_contraction_overlay(
                    location.parent_id, parent_level, candidate_id, overlay, free_head,
                )?;
            }
            return Ok((true, retry_candidate));
        }
        Ok((false, None))
    }

    fn repair_descending_underflows(
        &mut self,
        internal_candidates: &[u64],
        leaf_candidate: u64,
        overlay: &mut PageOverlay,
        free_head: &mut Option<u64>,
    ) -> Result<usize, BTreeError> {
        let mut total = 0usize;
        let mut current_leaf_candidate = leaf_candidate;
        for _pass in 0..=internal_candidates.len() + 1 {
            let internal = self.repair_descending_internal_underflows(
                internal_candidates, overlay, free_head,
            )?;
            let (leaf_changed, retry_candidate) = self.repair_descending_leaf_underflow(
                current_leaf_candidate, overlay, free_head,
            )?;
            if let Some(next_candidate) = retry_candidate {
                current_leaf_candidate = next_candidate;
            }
            total += internal + usize::from(leaf_changed);
            if internal == 0 && !leaf_changed {
                return Ok(total);
            }
        }
        Err(BTreeError::Corrupt("la reparación descendente combinada no converge"))
    }

    /// Crea un recorrido incremental [start_inclusive, end_exclusive). Cada llamada
    /// a next() carga como máximo una hoja y devuelve una entrada propia.
    pub fn range_iter<'a>(
        &'a mut self,
        start_inclusive: Option<&[u8]>,
        end_exclusive: Option<&[u8]>,
    ) -> Result<BPlusTreeRange<'a>, BTreeError> {
        if start_inclusive.is_some_and(|k| k.is_empty()) || end_exclusive.is_some_and(|k| k.is_empty()) {
            return Err(BTreeError::Invalid("los límites de rango no pueden ser claves vacías"));
        }
        if let (Some(start), Some(end)) = (start_inclusive, end_exclusive) {
            if start >= end { return Err(BTreeError::Invalid("el límite inicial debe ser menor que el final")); }
        }
        let mut page_id = self.root.root_id;
        let mut expected_level = self.root.level;
        loop {
            let page = self.pages.read(page_id)?;
            match BTreeNode::decode(&page.payload)? {
                BTreeNode::Leaf { .. } if expected_level == 0 => break,
                BTreeNode::Leaf { .. } => return Err(BTreeError::Corrupt("hoja en nivel inesperado al iniciar iterador")),
                BTreeNode::Internal { level, first_child, entries } => {
                    if level != expected_level || level == 0 { return Err(BTreeError::Corrupt("nivel interno inconsistente al iniciar iterador")); }
                    page_id = match start_inclusive { Some(key) => child_for(&entries, first_child, key), None => first_child };
                    expected_level -= 1;
                }
            }
        }
        let mut iterator = BPlusTreeRange {
            tree: self,
            page_id: Some(page_id),
            next_leaf: None,
            entries: Vec::new(),
            index: 0,
            end_exclusive: end_exclusive.map(|key| key.to_vec()),
            visited: BTreeSet::new(),
            previous_key: None,
            loaded: false,
            failed: false,
        };
        if let Some(start) = start_inclusive {
            let page = iterator.tree.pages.read(page_id)?;
            let BTreeNode::Leaf { entries, .. } = BTreeNode::decode(&page.payload)? else {
                return Err(BTreeError::Corrupt("página inicial del iterador no es hoja"));
            };
            iterator.index = entries.partition_point(|entry| entry.key.as_slice() < start);
        }
        Ok(iterator)
    }

    /// Devuelve entradas en [start_inclusive, end_exclusive), ordenadas por clave.
    /// Cualquiera de los límites puede omitirse. El resultado se materializa en memoria.
    pub fn range(
        &mut self,
        start_inclusive: Option<&[u8]>,
        end_exclusive: Option<&[u8]>,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, BTreeError> {
        if start_inclusive.is_some_and(|k| k.is_empty()) || end_exclusive.is_some_and(|k| k.is_empty()) {
            return Err(BTreeError::Invalid("los límites de rango no pueden ser claves vacías"));
        }
        if let (Some(start), Some(end)) = (start_inclusive, end_exclusive) {
            if start >= end { return Err(BTreeError::Invalid("el límite inicial debe ser menor que el final")); }
        }

        let mut page_id = self.root.root_id;
        let mut expected_level = self.root.level;
        loop {
            let page = self.pages.read(page_id)?;
            match BTreeNode::decode(&page.payload)? {
                BTreeNode::Leaf { .. } if expected_level == 0 => break,
                BTreeNode::Leaf { .. } => return Err(BTreeError::Corrupt("hoja en nivel inesperado al iniciar rango")),
                BTreeNode::Internal { level, first_child, entries } => {
                    if level != expected_level || level == 0 { return Err(BTreeError::Corrupt("nivel interno inconsistente al iniciar rango")); }
                    page_id = match start_inclusive {
                        Some(key) => child_for(&entries, first_child, key),
                        None => first_child,
                    };
                    expected_level -= 1;
                }
            }
        }

        let mut result = Vec::new();
        let mut visited = BTreeSet::new();
        let mut previous_key: Option<Vec<u8>> = None;
        loop {
            if !visited.insert(page_id) { return Err(BTreeError::Corrupt("ciclo en enlaces de hojas")); }
            let page = self.pages.read(page_id)?;
            let BTreeNode::Leaf { next_leaf, entries } = BTreeNode::decode(&page.payload)? else {
                return Err(BTreeError::Corrupt("enlace de hoja apunta a nodo interno"));
            };
            for entry in entries {
                if previous_key.as_ref().is_some_and(|previous| previous.as_slice() >= entry.key.as_slice()) {
                    return Err(BTreeError::Corrupt("orden global de hojas inválido"));
                }
                previous_key = Some(entry.key.clone());
                if start_inclusive.is_some_and(|start| entry.key.as_slice() < start) { continue; }
                if end_exclusive.is_some_and(|end| entry.key.as_slice() >= end) {
                    return Ok(result);
                }
                result.push((entry.key, entry.value));
            }
            match next_leaf {
                Some(next) => {
                    if next >= self.pages.page_count() { return Err(BTreeError::Corrupt("enlace next_leaf fuera del archivo")); }
                    page_id = next;
                }
                None => return Ok(result),
            }
        }
    }

    /// Recorre la estructura completa, comprueba niveles, referencias, límites
    /// separadores, ausencia de ciclos y concordancia de la cadena de hojas.
    pub fn validate(&mut self) -> Result<ValidationReport, BTreeError> {
        let page_count = self.pages.page_count();
        if page_count < 2 || self.root.root_id == 0 || self.root.root_id >= page_count {
            return Err(BTreeError::Corrupt("metadata o raíz fuera de rango"));
        }
        let mut visited = BTreeSet::new();
        let mut leaves: Vec<(u64, Option<u64>)> = Vec::new();
        let mut entries = 0usize;
        validate_subtree(
            &mut self.pages,
            self.root.root_id,
            self.root.level,
            page_count,
            &mut visited,
            &mut leaves,
            &mut entries,
        )?;
        let mut free_pages = BTreeSet::new();
        let mut free_id = self.root.free_head;
        while let Some(id) = free_id {
            if id == 0 || id >= page_count {
                return Err(BTreeError::Corrupt("free_head o enlace libre fuera de rango"));
            }
            if visited.contains(&id) {
                return Err(BTreeError::Corrupt("una página aparece en el árbol y en la lista libre"));
            }
            if !free_pages.insert(id) {
                return Err(BTreeError::Corrupt("ciclo o página duplicada en la lista libre"));
            }
            let page = self.pages.read(id)?;
            let free = crate::page_reuse::FreePage::decode(&page.payload)
                .map_err(|_| BTreeError::Corrupt("página de lista libre MBFR inválida"))?;
            free_id = free.next;
        }
        if visited.len() as u64 + free_pages.len() as u64 != page_count - 1 {
            return Err(BTreeError::Corrupt("hay páginas huérfanas fuera del árbol y de la lista libre"));
        }
        for (index, (page_id, next)) in leaves.iter().enumerate() {
            let expected = leaves.get(index + 1).map(|(id, _)| *id);
            if *next != expected {
                return Err(BTreeError::Corrupt("cadena next_leaf no coincide con el recorrido del árbol"));
            }
            if !visited.contains(page_id) { return Err(BTreeError::Corrupt("hoja ausente del conjunto visitado")); }
        }
        Ok(ValidationReport {
            pages_visited: visited.len() + free_pages.len() + 1,
            leaf_pages: leaves.len(),
            free_pages: free_pages.len(),
            entries,
            height: self.root.level,
        })
    }

    /// Informa déficits de ocupación que validate() permite por ahora para
    /// conservar árboles alcanzables durante la etapa experimental.
    pub fn occupancy_diagnostics(&mut self) -> Result<OccupancyDiagnostics, BTreeError> {
        let mut report = OccupancyDiagnostics {
            minimum_diagnostic_occupancy_bytes: MIN_DIAGNOSTIC_OCCUPANCY_BYTES,
            ..OccupancyDiagnostics::default()
        };
        let page_count = self.pages.page_count();
        let mut visited = BTreeSet::new();
        inspect_occupancy(
            &mut self.pages,
            self.root.root_id,
            self.root.level,
            true,
            page_count,
            &mut visited,
            &mut report,
        )?;
        Ok(report)
    }

    /// Recorre todo el árbol y repara hojas vacías, nodos internos unarios y
    /// páginas no raíz subocupadas por bytes dentro de una única MutationSession.
    /// Redistribuye páginas hermanas cuando ambas deben permanecer separadas y
    /// las fusiona cuando su carga combinada cabe en una sola página. Actualiza
    /// separadores, enlaces de hojas, lista libre y contracciones de raíz sobre
    /// el mismo overlay, antes de publicar una única transacción WAL.
    ///
    /// Devuelve la cantidad de acciones de rebalanceo, fusión y contracción.
    /// La ocupación se mide por bytes lógicos codificados, sin el padding físico.
    pub fn repair_occupancy(&mut self) -> Result<usize, BTreeError> {
        let mut session = MutationSession::new(
            self.root.clone(),
            self.meta_generation,
            self.pages.page_count(),
        );
        let mut internal_candidates = Vec::new();
        let mut leaf_candidates = Vec::new();
        let mut stack = vec![(session.root.root_id, session.root.level, false)];
        let mut visited = BTreeSet::new();

        while let Some((page_id, expected_level, expanded)) = stack.pop() {
            if expanded {
                if let BTreeNode::Internal { entries, .. } =
                    self.read_node_from_overlay(page_id, &session.overlay)?
                {
                    if entries.is_empty()
                        || (page_id != session.root.root_id
                            && internal_encoded_size(&entries) < MIN_DIAGNOSTIC_OCCUPANCY_BYTES)
                    {
                        internal_candidates.push(page_id);
                    }
                }
                continue;
            }
            if !visited.insert(page_id) {
                return Err(BTreeError::Corrupt("ciclo o hijo compartido al recorrer ocupación"));
            }
            match self.read_node_from_overlay(page_id, &session.overlay)? {
                BTreeNode::Leaf { entries, .. } => {
                    if expected_level != 0 {
                        return Err(BTreeError::Corrupt("hoja a nivel incorrecto al reparar ocupación"));
                    }
                    if page_id != session.root.root_id
                        && (entries.is_empty()
                            || leaf_encoded_size(&entries) < MIN_DIAGNOSTIC_OCCUPANCY_BYTES)
                    {
                        leaf_candidates.push(page_id);
                    }
                }
                BTreeNode::Internal { level, first_child, entries } => {
                    if level != expected_level || level == 0 {
                        return Err(BTreeError::Corrupt("nivel interno incorrecto al reparar ocupación"));
                    }
                    stack.push((page_id, expected_level, true));
                    for child_id in entries.iter().rev().map(|entry| entry.right_child) {
                        stack.push((child_id, expected_level - 1, false));
                    }
                    stack.push((first_child, expected_level - 1, false));
                }
            }
        }

        if internal_candidates.is_empty() && leaf_candidates.is_empty() {
            return Ok(0);
        }

        let max_passes = internal_candidates.len()
            .saturating_add(leaf_candidates.len())
            .saturating_add(session.root.level as usize)
            .saturating_add(4);
        let mut total_repaired = 0usize;
        let mut converged = false;
        for _ in 0..max_passes {
            let mut internal_repaired = self.repair_descending_internal_underflows(
                &internal_candidates,
                &mut session.overlay,
                &mut session.free_head,
            )?;
            let mut retry_internal_candidates = Vec::new();
            for candidate_id in internal_candidates.iter().copied() {
                if session.overlay.is_freed(candidate_id)
                    || session.overlay.is_reusable(candidate_id)
                {
                    continue;
                }
                let parent_id_before = self.resolve_parent_with_overlay(
                    candidate_id, &session.overlay,
                )?.map(|location| location.parent_id);
                let byte_repaired = self.repair_underfilled_internal_by_bytes(
                    candidate_id, &mut session.overlay, &mut session.free_head,
                )?;
                internal_repaired += usize::from(byte_repaired);
                if byte_repaired {
                    if let Some(parent_id) = parent_id_before {
                        if self.is_underfilled_internal_node_candidate(
                            parent_id, &session.overlay,
                        )? && !internal_candidates.contains(&parent_id)
                            && !retry_internal_candidates.contains(&parent_id)
                        {
                            retry_internal_candidates.push(parent_id);
                        }
                    }
                }
            }
            let mut leaf_repaired = 0usize;
            let mut retry_candidates = Vec::new();
            for candidate_id in leaf_candidates.iter().copied() {
                if session.overlay.is_freed(candidate_id)
                    || session.overlay.is_reusable(candidate_id)
                {
                    continue;
                }
                let parent_id_before = self.resolve_parent_with_overlay(
                    candidate_id, &session.overlay,
                )?.map(|location| location.parent_id);
                let (changed, retry) = self.repair_descending_leaf_underflow(
                    candidate_id,
                    &mut session.overlay,
                    &mut session.free_head,
                )?;
                leaf_repaired += usize::from(changed);
                if !session.overlay.is_freed(candidate_id)
                    && !session.overlay.is_reusable(candidate_id)
                {
                    let byte_repaired = self.repair_underfilled_leaf_by_bytes(
                        candidate_id, &mut session.overlay, &mut session.free_head,
                    )?;
                    leaf_repaired += usize::from(byte_repaired);
                }
                if let Some(retry_id) = retry {
                    if !retry_candidates.contains(&retry_id) {
                        retry_candidates.push(retry_id);
                    }
                }
                if let Some(parent_id) = parent_id_before {
                    if self.is_underfilled_internal_node_candidate(
                        parent_id, &session.overlay,
                    )? && !internal_candidates.contains(&parent_id)
                        && !retry_internal_candidates.contains(&parent_id)
                    {
                        retry_internal_candidates.push(parent_id);
                    }
                }
            }
            for retry_id in retry_candidates {
                if !leaf_candidates.contains(&retry_id) {
                    leaf_candidates.push(retry_id);
                }
            }
            for retry_id in retry_internal_candidates {
                if !internal_candidates.contains(&retry_id) {
                    internal_candidates.push(retry_id);
                }
            }

            let repaired_this_pass = internal_repaired.saturating_add(leaf_repaired);
            total_repaired = total_repaired.saturating_add(repaired_this_pass);
            if let Some(metadata) = session.overlay.payload(0) {
                session.root = decode_meta(metadata)?;
                session.free_head = session.root.free_head;
            }
            if repaired_this_pass == 0 {
                converged = true;
                break;
            }
        }
        if !converged {
            return Err(BTreeError::Corrupt("la reparación global de ocupación no converge"));
        }

        if total_repaired > 0 {
            session.changed = true;
            self.commit_mutation_session(session)?;
        }
        Ok(total_repaired)
    }

    /// Vuelve a localizar un nodo dentro del árbol actualmente confirmado.
    /// Recorre los punteros vigentes desde la raíz y rechaza ciclos, hijos
    /// compartidos, niveles incorrectos o una segunda aparición del candidato.
    /// La raíz no tiene padre y devuelve None.
    fn resolve_parent(&mut self, target_id: u64) -> Result<Option<ParentLocation>, BTreeError> {
        if target_id == self.root.root_id { return Ok(None); }
        let page_count = self.pages.page_count();
        if target_id == 0 || target_id >= page_count {
            return Err(BTreeError::Corrupt("candidato de padre fuera del rango de páginas"));
        }

        let target_page = self.pages.read(target_id)?;
        let target_level = match BTreeNode::decode(&target_page.payload)? {
            BTreeNode::Leaf { .. } => 0,
            BTreeNode::Internal { level, .. } => level,
        };
        let mut stack = vec![(self.root.root_id, self.root.level)];
        let mut visited = BTreeSet::new();
        let mut found: Option<ParentLocation> = None;

        while let Some((node_id, expected_level)) = stack.pop() {
            if node_id == 0 || node_id >= page_count {
                return Err(BTreeError::Corrupt("puntero fuera de rango al resolver padre"));
            }
            if !visited.insert(node_id) {
                return Err(BTreeError::Corrupt("ciclo o hijo compartido al resolver padre"));
            }
            let page = self.pages.read(node_id)?;
            match BTreeNode::decode(&page.payload)? {
                BTreeNode::Leaf { .. } if expected_level == 0 => {}
                BTreeNode::Leaf { .. } => {
                    return Err(BTreeError::Corrupt("hoja en nivel inesperado al resolver padre"));
                }
                BTreeNode::Internal { level, first_child, entries } => {
                    if level != expected_level || level == 0 {
                        return Err(BTreeError::Corrupt("nivel interno incorrecto al resolver padre"));
                    }
                    let mut children = Vec::with_capacity(entries.len() + 1);
                    children.push(first_child);
                    children.extend(entries.iter().map(|entry| entry.right_child));

                    for (child_index, child_id) in children.iter().copied().enumerate() {
                        if child_id == target_id {
                            if target_level.checked_add(1) != Some(level) {
                                return Err(BTreeError::Corrupt("nivel del candidato incompatible con su padre"));
                            }
                            if found.replace(ParentLocation {
                                parent_id: node_id,
                                parent_level: level,
                                child_index,
                            }).is_some() {
                                return Err(BTreeError::Corrupt("candidato aparece más de una vez en el árbol"));
                            }
                        }
                        stack.push((child_id, level - 1));
                    }
                }
            }
        }
        found.ok_or(BTreeError::Corrupt("candidato no alcanzable desde la raíz vigente")).map(Some)
    }

    pub fn root_page_id(&self) -> u64 { self.root.root_id }
    pub fn height(&self) -> u16 { self.root.level }
    pub fn paths(&self) -> (&Path, &Path) {
        (self.pages.pages_path(), self.pages.wal_path())
    }

    pub fn page_count(&self) -> u64 { self.pages.page_count() }
    #[cfg(test)]
    pub(crate) fn inject_apply_failure_after_images(&mut self, count: usize) {
        self.pages.inject_apply_failure_after_images(count);
    }
    pub(crate) fn attach_session_lock_validator(
        &mut self,
        validator: crate::bundle::SessionLockValidator,
    ) -> Result<(), BTreeError> {
        self.pages.attach_session_lock_validator(validator)?;
        Ok(())
    }

    pub fn checkpoint(&mut self) -> Result<(), BTreeError> { self.pages.checkpoint()?; Ok(()) }


}

fn inspect_occupancy(
    pages: &mut DurablePages,
    page_id: u64,
    expected_level: u16,
    is_root: bool,
    page_count: u64,
    visited: &mut BTreeSet<u64>,
    report: &mut OccupancyDiagnostics,
) -> Result<(), BTreeError> {
    if page_id == 0 || page_id >= page_count {
        return Err(BTreeError::Corrupt("referencia fuera de rango en diagnóstico de ocupación"));
    }
    if !visited.insert(page_id) {
        return Err(BTreeError::Corrupt("ciclo o hijo compartido en diagnóstico de ocupación"));
    }
    let page = pages.read(page_id)?;
    match BTreeNode::decode(&page.payload)? {
        BTreeNode::Leaf { entries, .. } => {
            // Node::encode rellena el payload hasta PAGE_PAYLOAD; medir entradas evita contar ese padding.
            let used_bytes = leaf_encoded_size(&entries);
            if expected_level != 0 {
                return Err(BTreeError::Corrupt("hoja a nivel incorrecto en diagnóstico de ocupación"));
            }
            if !is_root {
                if entries.is_empty() {
                    report.empty_non_root_leaves += 1;
                }
                report.non_root_leaf_pages += 1;
                report.non_root_pages += 1;
                report.non_root_payload_bytes = report.non_root_payload_bytes
                    .checked_add(used_bytes)
                    .ok_or(BTreeError::Corrupt("contador total de bytes de ocupación desbordado"))?;
                if used_bytes < MIN_DIAGNOSTIC_OCCUPANCY_BYTES {
                    report.underfilled_non_root_leaf_pages += 1;
                    report.underfilled_non_root_pages += 1;
                }
                report.non_root_leaf_payload_bytes = report.non_root_leaf_payload_bytes
                    .checked_add(used_bytes)
                    .ok_or(BTreeError::Corrupt("contador de bytes de hojas desbordado"))?;
                report.smallest_non_root_leaf_payload_bytes = Some(
                    report.smallest_non_root_leaf_payload_bytes
                        .map_or(used_bytes, |current| current.min(used_bytes))
                );
                report.largest_non_root_leaf_payload_bytes = Some(
                    report.largest_non_root_leaf_payload_bytes
                        .map_or(used_bytes, |current| current.max(used_bytes))
                );
            }
        }
        BTreeNode::Internal { level, first_child, entries } => {
            let used_bytes = internal_encoded_size(&entries);
            if level != expected_level || level == 0 {
                return Err(BTreeError::Corrupt("nivel interno incorrecto en diagnóstico de ocupación"));
            }
            if entries.is_empty() {
                if is_root {
                    report.root_is_unary_internal = true;
                } else {
                    report.unary_non_root_internal_nodes += 1;
                }
            }
            if !is_root {
                report.non_root_internal_pages += 1;
                report.non_root_pages += 1;
                report.non_root_payload_bytes = report.non_root_payload_bytes
                    .checked_add(used_bytes)
                    .ok_or(BTreeError::Corrupt("contador total de bytes de ocupación desbordado"))?;
                if used_bytes < MIN_DIAGNOSTIC_OCCUPANCY_BYTES {
                    report.underfilled_non_root_internal_pages += 1;
                    report.underfilled_non_root_pages += 1;
                }
                report.non_root_internal_payload_bytes = report.non_root_internal_payload_bytes
                    .checked_add(used_bytes)
                    .ok_or(BTreeError::Corrupt("contador de bytes internos desbordado"))?;
                report.smallest_non_root_internal_payload_bytes = Some(
                    report.smallest_non_root_internal_payload_bytes
                        .map_or(used_bytes, |current| current.min(used_bytes))
                );
                report.largest_non_root_internal_payload_bytes = Some(
                    report.largest_non_root_internal_payload_bytes
                        .map_or(used_bytes, |current| current.max(used_bytes))
                );
            }
            inspect_occupancy(pages, first_child, level - 1, false, page_count, visited, report)?;
            for entry in entries {
                inspect_occupancy(pages, entry.right_child, level - 1, false, page_count, visited, report)?;
            }
        }
    }
    Ok(())
}

fn validate_subtree(
    pages: &mut DurablePages,
    page_id: u64,
    expected_level: u16,
    page_count: u64,
    visited: &mut BTreeSet<u64>,
    leaves: &mut Vec<(u64, Option<u64>)>,
    entry_count: &mut usize,
) -> Result<SubtreeBounds, BTreeError> {
    if page_id == 0 || page_id >= page_count { return Err(BTreeError::Corrupt("referencia a página fuera de rango")); }
    if !visited.insert(page_id) { return Err(BTreeError::Corrupt("ciclo o hijo compartido en el árbol")); }
    let page = pages.read(page_id)?;
    match BTreeNode::decode(&page.payload)? {
        BTreeNode::Leaf { next_leaf, entries } => {
            if expected_level != 0 { return Err(BTreeError::Corrupt("hoja a profundidad incorrecta")); }
            *entry_count = (*entry_count).checked_add(entries.len()).ok_or(BTreeError::Corrupt("contador de entradas desbordado"))?;
            let min = entries.first().map(|e| e.key.clone());
            let max = entries.last().map(|e| e.key.clone());
            leaves.push((page_id, next_leaf));
            Ok(SubtreeBounds { min, max })
        }
        BTreeNode::Internal { level, first_child, entries } => {
            if expected_level == 0 || level != expected_level { return Err(BTreeError::Corrupt("nivel interno incorrecto")); }
            let mut child_ids = Vec::with_capacity(entries.len() + 1);
            child_ids.push(first_child);
            child_ids.extend(entries.iter().map(|e| e.right_child));
            let mut bounds = Vec::with_capacity(child_ids.len());
            for child in child_ids {
                bounds.push(validate_subtree(pages, child, expected_level - 1, page_count, visited, leaves, entry_count)?);
            }
            for (index, separator) in entries.iter().enumerate() {
                if bounds[index].max.as_ref().is_some_and(|max| max.as_slice() >= separator.separator.as_slice()) {
                    return Err(BTreeError::Corrupt("clave del hijo izquierdo cruza el separador"));
                }
                if bounds[index + 1].min.as_ref().is_some_and(|min| min.as_slice() < separator.separator.as_slice()) {
                    return Err(BTreeError::Corrupt("clave del hijo derecho queda antes del separador"));
                }
            }
            let min = bounds.iter().find_map(|b| b.min.clone());
            let max = bounds.iter().rev().find_map(|b| b.max.clone());
            Ok(SubtreeBounds { min, max })
        }
    }
}


#[derive(Debug, Clone)]
struct InternalRebalancePlan {
    parent_entries: Vec<InternalEntry>,
    changed_nodes: Vec<(u64, BTreeNode)>,
    surviving_page_id: u64,
    freed_page_id: Option<u64>,
}

// Planifica un único nivel interno sin I/O ni mutaciones persistentes.
// Los donantes deben conservar al menos un separador después de prestar.
// La codificación previa garantiza que una fusión que no cabe no produzca
// un plan parcial que el llamador pueda confirmar accidentalmente.
fn plan_internal_rebalance(
    parent_first_child: u64,
    mut parent_entries: Vec<InternalEntry>,
    child_index: usize,
    node_id: u64,
    node_level: u16,
    node_first_child: u64,
    node_entries: Vec<InternalEntry>,
    left: Option<(u64, u64, Vec<InternalEntry>)>,
    right: Option<(u64, u64, Vec<InternalEntry>)>,
) -> Result<InternalRebalancePlan, BTreeError> {
    if child_index > parent_entries.len() {
        return Err(BTreeError::Corrupt("índice de hijo fuera del padre interno"));
    }
    let expected_node = if child_index == 0 {
        parent_first_child
    } else {
        parent_entries[child_index - 1].right_child
    };
    if expected_node != node_id {
        return Err(BTreeError::Corrupt("el nodo deficitario no coincide con el hijo del padre"));
    }
    if node_level == 0 {
        return Err(BTreeError::Corrupt("rebalanceo interno solicitado para nivel cero"));
    }

    if child_index > 0 {
        let (left_id, left_first, left_entries) =
            left.ok_or(BTreeError::Corrupt("falta el hermano interno izquierdo"))?;
        let expected_left = if child_index == 1 {
            parent_first_child
        } else {
            parent_entries[child_index - 2].right_child
        };
        if left_id != expected_left {
            return Err(BTreeError::Corrupt("hermano izquierdo no coincide con el padre"));
        }
        if left_entries.len() > 1 {
            let separator = parent_entries[child_index - 1].separator.clone();
            let (new_separator, new_left_first, new_left_entries, new_node_first, new_node_entries) =
                borrow_internal_from_left(separator, left_first, left_entries, node_first_child, node_entries)?;
            parent_entries[child_index - 1].separator = new_separator;
            let left_node = BTreeNode::Internal { level: node_level, first_child: new_left_first, entries: new_left_entries };
            let current_node = BTreeNode::Internal { level: node_level, first_child: new_node_first, entries: new_node_entries };
            encode_node(&left_node)?;
            encode_node(&current_node)?;
            return Ok(InternalRebalancePlan {
                parent_entries,
                changed_nodes: vec![(left_id, left_node), (node_id, current_node)],
                surviving_page_id: node_id,
                freed_page_id: None,
            });
        }
    }

    if child_index < parent_entries.len() {
        let (right_id, right_first, right_entries) =
            right.ok_or(BTreeError::Corrupt("falta el hermano interno derecho"))?;
        if right_id != parent_entries[child_index].right_child {
            return Err(BTreeError::Corrupt("hermano derecho no coincide con el padre"));
        }
        if right_entries.len() > 1 {
            let separator = parent_entries[child_index].separator.clone();
            let (new_separator, new_node_first, new_node_entries, new_right_first, new_right_entries) =
                borrow_internal_from_right(separator, node_first_child, node_entries, right_first, right_entries)?;
            parent_entries[child_index].separator = new_separator;
            let current_node = BTreeNode::Internal { level: node_level, first_child: new_node_first, entries: new_node_entries };
            let right_node = BTreeNode::Internal { level: node_level, first_child: new_right_first, entries: new_right_entries };
            encode_node(&current_node)?;
            encode_node(&right_node)?;
            return Ok(InternalRebalancePlan {
                parent_entries,
                changed_nodes: vec![(node_id, current_node), (right_id, right_node)],
                surviving_page_id: node_id,
                freed_page_id: None,
            });
        }
    }

    if child_index > 0 {
        let (left_id, left_first, left_entries) =
            left.ok_or(BTreeError::Corrupt("falta hermano para fusionar nodo interno"))?;
        let separator = parent_entries.remove(child_index - 1).separator;
        let (merged_first, merged_entries) =
            merge_internal_with_left(separator, left_first, left_entries, node_first_child, node_entries);
        let merged = BTreeNode::Internal { level: node_level, first_child: merged_first, entries: merged_entries };
        encode_node(&merged)?;
        Ok(InternalRebalancePlan {
            parent_entries,
            changed_nodes: vec![(left_id, merged)],
            surviving_page_id: left_id,
            freed_page_id: Some(node_id),
        })
    } else if child_index < parent_entries.len() {
        let (right_id, right_first, right_entries) =
            right.ok_or(BTreeError::Corrupt("falta hermano derecho para fusionar nodo interno"))?;
        let separator = parent_entries.remove(child_index).separator;
        let (merged_first, merged_entries) =
            merge_internal_with_right(separator, node_first_child, node_entries, right_first, right_entries);
        let merged = BTreeNode::Internal { level: node_level, first_child: merged_first, entries: merged_entries };
        encode_node(&merged)?;
        Ok(InternalRebalancePlan {
            parent_entries,
            changed_nodes: vec![(node_id, merged)],
            surviving_page_id: node_id,
            freed_page_id: Some(right_id),
        })
    } else {
        Err(BTreeError::Corrupt("nodo interno deficitario sin hermano en el padre"))
    }
}

// Rotaciones internas puras. El llamador valida niveles/generaciones y prepara
// todas las imágenes antes de incluirlas en una única transacción MLPJ.
fn borrow_internal_from_left(
    parent_separator: Vec<u8>, left_first_child: u64, mut left_entries: Vec<InternalEntry>,
    node_first_child: u64, mut node_entries: Vec<InternalEntry>,
) -> Result<(Vec<u8>, u64, Vec<InternalEntry>, u64, Vec<InternalEntry>), BTreeError> {
    let moved = left_entries.pop().ok_or(BTreeError::Corrupt("hermano interno izquierdo sin separadores para donar"))?;
    let new_parent_separator = moved.separator;
    node_entries.insert(0, InternalEntry { separator: parent_separator, right_child: node_first_child });
    Ok((new_parent_separator, left_first_child, left_entries, moved.right_child, node_entries))
}

fn borrow_internal_from_right(
    parent_separator: Vec<u8>, node_first_child: u64, mut node_entries: Vec<InternalEntry>,
    right_first_child: u64, mut right_entries: Vec<InternalEntry>,
) -> Result<(Vec<u8>, u64, Vec<InternalEntry>, u64, Vec<InternalEntry>), BTreeError> {
    let moved = right_entries.first().cloned().ok_or(BTreeError::Corrupt("hermano interno derecho sin separadores para donar"))?;
    node_entries.push(InternalEntry { separator: parent_separator, right_child: right_first_child });
    right_entries.remove(0);
    Ok((moved.separator, node_first_child, node_entries, moved.right_child, right_entries))
}

fn merge_internal_with_left(
    parent_separator: Vec<u8>, left_first_child: u64, mut left_entries: Vec<InternalEntry>,
    node_first_child: u64, node_entries: Vec<InternalEntry>,
) -> (u64, Vec<InternalEntry>) {
    left_entries.push(InternalEntry { separator: parent_separator, right_child: node_first_child });
    left_entries.extend(node_entries);
    (left_first_child, left_entries)
}

fn merge_internal_with_right(
    parent_separator: Vec<u8>, node_first_child: u64, mut node_entries: Vec<InternalEntry>,
    right_first_child: u64, right_entries: Vec<InternalEntry>,
) -> (u64, Vec<InternalEntry>) {
    node_entries.push(InternalEntry { separator: parent_separator, right_child: right_first_child });
    node_entries.extend(right_entries);
    (node_first_child, node_entries)
}

fn child_for(entries: &[InternalEntry], first_child: u64, key: &[u8]) -> u64 {
    let index = entries.partition_point(|e| key >= e.separator.as_slice());
    if index == 0 { first_child } else { entries[index - 1].right_child }
}

fn encode_node(node: &BTreeNode) -> Result<Vec<u8>, BTreeError> {
    node.encode(PAGE_PAYLOAD).map_err(|e| match e {
        NodeError::NoSpace => BTreeError::NoSpace,
        other => BTreeError::Node(other),
    })
}

fn split_leaf(
    entries: Vec<LeafEntry>,
    right_id: u64,
    old_next: Option<u64>,
) -> Result<(BTreeNode, BTreeNode, Vec<u8>), BTreeError> {
    let mut best: Option<(usize, usize)> = None;
    for mid in 1..entries.len() {
        let left = BTreeNode::Leaf { next_leaf: Some(right_id), entries: entries[..mid].to_vec() };
        let right = BTreeNode::Leaf { next_leaf: old_next, entries: entries[mid..].to_vec() };
        if let (Ok(l), Ok(r)) = (left.encode(PAGE_PAYLOAD), right.encode(PAGE_PAYLOAD)) {
            let imbalance = leaf_encoded_size(&entries[..mid]).abs_diff(leaf_encoded_size(&entries[mid..]));
            if best.map_or(true, |(_, score)| imbalance < score) { best = Some((mid, imbalance)); }
        }
    }
    let (mid, _) = best.ok_or(BTreeError::NoSpace)?;
    let separator = entries[mid].key.clone();
    Ok((
        BTreeNode::Leaf { next_leaf: Some(right_id), entries: entries[..mid].to_vec() },
        BTreeNode::Leaf { next_leaf: old_next, entries: entries[mid..].to_vec() },
        separator,
    ))
}

fn split_internal(
    level: u16,
    first_child: u64,
    entries: Vec<InternalEntry>,
) -> Result<(BTreeNode, BTreeNode, Vec<u8>), BTreeError> {
    let mut best: Option<(usize, usize)> = None;
    for mid in 0..entries.len() {
        let left = BTreeNode::Internal { level, first_child, entries: entries[..mid].to_vec() };
        let right = BTreeNode::Internal {
            level,
            first_child: entries[mid].right_child,
            entries: entries[mid + 1..].to_vec(),
        };
        if let (Ok(l), Ok(r)) = (left.encode(PAGE_PAYLOAD), right.encode(PAGE_PAYLOAD)) {
            let imbalance = internal_encoded_size(&entries[..mid]).abs_diff(internal_encoded_size(&entries[mid + 1..]));
            if best.map_or(true, |(_, score)| imbalance < score) { best = Some((mid, imbalance)); }
        }
    }
    let (mid, _) = best.ok_or(BTreeError::NoSpace)?;
    let separator = entries[mid].separator.clone();
    Ok((
        BTreeNode::Internal { level, first_child, entries: entries[..mid].to_vec() },
        BTreeNode::Internal {
            level,
            first_child: entries[mid].right_child,
            entries: entries[mid + 1..].to_vec(),
        },
        separator,
    ))
}

fn leaf_encoded_size(entries: &[LeafEntry]) -> usize {
    20 + entries.iter().map(|e| 6 + e.key.len() + e.value.len()).sum::<usize>()
}
fn internal_encoded_size(entries: &[InternalEntry]) -> usize {
    28 + entries.iter().map(|e| 10 + e.separator.len()).sum::<usize>()
}

/// Plan puro de rotación de un separador padre entre dos nodos internos.
/// El separador elegido se promueve al padre; cada lado conserva al menos
/// dos hijos (un separador local), evitando producir nodos internos unarios.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct InternalRedistributionPlan {
    promoted_index: usize,
    left_bytes: usize,
    right_bytes: usize,
    underfilled_pages: usize,
}

fn plan_internal_redistribution(
    entries_with_parent_separator: &[InternalEntry],
    capacity: usize,
    minimum_occupancy: usize,
) -> Option<InternalRedistributionPlan> {
    if entries_with_parent_separator.len() < 3 || capacity < 28 {
        return None;
    }

    let mut best: Option<((usize, usize, usize), InternalRedistributionPlan)> = None;
    for promoted_index in 1..entries_with_parent_separator.len() - 1 {
        let left_bytes = internal_encoded_size(&entries_with_parent_separator[..promoted_index]);
        let right_bytes = internal_encoded_size(&entries_with_parent_separator[promoted_index + 1..]);
        if left_bytes > capacity || right_bytes > capacity {
            continue;
        }

        let underfilled_pages = usize::from(left_bytes < minimum_occupancy)
            + usize::from(right_bytes < minimum_occupancy);
        let imbalance = left_bytes.abs_diff(right_bytes);
        let score = (underfilled_pages, imbalance, promoted_index);
        let plan = InternalRedistributionPlan {
            promoted_index,
            left_bytes,
            right_bytes,
            underfilled_pages,
        };
        if best.as_ref().map_or(true, |(best_score, _)| score < *best_score) {
            best = Some((score, plan));
        }
    }
    best.map(|(_, plan)| plan)
}

/// Plan puro para redistribuir una secuencia ordenada de entradas entre dos hojas.
/// El índice indica la primera entrada que pasará a la hoja derecha.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LeafRedistributionPlan {
    split_index: usize,
    left_bytes: usize,
    right_bytes: usize,
    underfilled_pages: usize,
}

/// Elige el corte válido que minimiza primero la cantidad de hojas bajo el
/// umbral diagnóstico y después el desequilibrio de bytes. No modifica nodos,
/// enlaces ni separadores: esos cambios deben staged juntos por la transacción.
fn plan_leaf_redistribution(
    entries: &[LeafEntry],
    capacity: usize,
    minimum_occupancy: usize,
) -> Option<LeafRedistributionPlan> {
    if entries.len() < 2 || capacity < 20 {
        return None;
    }

    let mut best: Option<((usize, usize, usize), LeafRedistributionPlan)> = None;
    for split_index in 1..entries.len() {
        let left_bytes = leaf_encoded_size(&entries[..split_index]);
        let right_bytes = leaf_encoded_size(&entries[split_index..]);
        if left_bytes > capacity || right_bytes > capacity {
            continue;
        }

        let underfilled_pages = usize::from(left_bytes < minimum_occupancy)
            + usize::from(right_bytes < minimum_occupancy);
        let imbalance = left_bytes.abs_diff(right_bytes);
        let score = (underfilled_pages, imbalance, split_index);
        let plan = LeafRedistributionPlan {
            split_index,
            left_bytes,
            right_bytes,
            underfilled_pages,
        };
        if best.as_ref().map_or(true, |(best_score, _)| score < *best_score) {
            best = Some((score, plan));
        }
    }
    best.map(|(_, plan)| plan)
}

fn encode_meta(meta: &RootMeta) -> Vec<u8> {
    crate::page_reuse::TreeMetadata {
        root_id: meta.root_id,
        level: meta.level,
        free_head: meta.free_head,
    }.encode()
}
fn decode_meta(data: &[u8]) -> Result<RootMeta, BTreeError> {
    let meta = crate::page_reuse::TreeMetadata::decode(data)
        .map_err(|_| BTreeError::Corrupt("metadata de raíz inválida"))?;
    Ok(RootMeta { root_id: meta.root_id, level: meta.level, free_head: meta.free_head })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    fn paths() -> (std::path::PathBuf, std::path::PathBuf) {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("mbtree-{}-{n}", std::process::id()));
        (base.with_extension("pages"), base.with_extension("wal"))
    }
    fn cleanup(p: &std::path::Path, w: &std::path::Path) {
        for path in [p, w] {
            let _ = std::fs::remove_file(path);
            let mut name = path.file_name().unwrap().to_os_string();
            name.push(".mldb-lock");
            let _ = std::fs::remove_file(path.with_file_name(name));
        }
    }

    fn assert_occupancy_accounts_for_tree(tree: &mut PersistentBPlusTree) {
        let validation = tree.validate().unwrap();
        let diagnostics = tree.occupancy_diagnostics().unwrap();
        let non_root_tree_pages = validation.pages_visited
            .checked_sub(validation.free_pages)
            .and_then(|pages| pages.checked_sub(2))
            .expect("el reporte incluye metadata y raíz");
        assert_eq!(
            diagnostics.non_root_leaf_pages + diagnostics.non_root_internal_pages,
            non_root_tree_pages,
            "el diagnóstico debe contabilizar todas las páginas de árbol salvo la raíz"
        );
        let root_leaf_pages = if tree.root.level == 0 { 1 } else { 0 };
        assert_eq!(
            diagnostics.non_root_leaf_pages,
            validation.leaf_pages - root_leaf_pages,
            "las hojas no raíz deben coincidir con el recorrido validado"
        );
        assert!(diagnostics.empty_non_root_leaves <= diagnostics.non_root_leaf_pages);
        assert!(diagnostics.unary_non_root_internal_nodes <= diagnostics.non_root_internal_pages);
        assert!(diagnostics.underfilled_non_root_leaf_pages <= diagnostics.non_root_leaf_pages);
        assert!(diagnostics.underfilled_non_root_internal_pages <= diagnostics.non_root_internal_pages);
        assert_eq!(
            diagnostics.non_root_pages,
            diagnostics.non_root_leaf_pages + diagnostics.non_root_internal_pages
        );
        assert_eq!(
            diagnostics.underfilled_non_root_pages,
            diagnostics.underfilled_non_root_leaf_pages + diagnostics.underfilled_non_root_internal_pages
        );
        assert_eq!(
            diagnostics.non_root_payload_bytes,
            diagnostics.non_root_leaf_payload_bytes + diagnostics.non_root_internal_payload_bytes
        );
        assert_eq!(
            diagnostics.smallest_non_root_leaf_payload_bytes.is_some(),
            diagnostics.non_root_leaf_pages > 0
        );
        assert_eq!(
            diagnostics.smallest_non_root_internal_payload_bytes.is_some(),
            diagnostics.non_root_internal_pages > 0
        );
        if let (Some(min), Some(max)) = (
            diagnostics.smallest_non_root_leaf_payload_bytes,
            diagnostics.largest_non_root_leaf_payload_bytes,
        ) {
            assert!(min <= max);
        }
        if let (Some(min), Some(max)) = (
            diagnostics.smallest_non_root_internal_payload_bytes,
            diagnostics.largest_non_root_internal_payload_bytes,
        ) {
            assert!(min <= max);
        }
    }
    #[test]
    fn leaf_redistribution_planner_balances_bytes_and_respects_capacity() {
        let entries = vec![
            LeafEntry { key: b"a".to_vec(), value: vec![1; 900] },
            LeafEntry { key: b"b".to_vec(), value: vec![2; 900] },
            LeafEntry { key: b"c".to_vec(), value: vec![3; 900] },
            LeafEntry { key: b"d".to_vec(), value: vec![4; 900] },
        ];
        let plan = plan_leaf_redistribution(&entries, PAGE_PAYLOAD, MIN_DIAGNOSTIC_OCCUPANCY_BYTES)
            .expect("debe existir un corte válido");
        assert_eq!(plan.split_index, 2);
        assert_eq!(plan.left_bytes, plan.right_bytes);
        assert_eq!(plan.underfilled_pages, 0);
        assert!(plan.left_bytes <= PAGE_PAYLOAD);
        assert!(plan.right_bytes <= PAGE_PAYLOAD);
    }

    #[test]
    fn leaf_redistribution_planner_prefers_avoiding_underfilled_sibling() {
        let entries = vec![
            LeafEntry { key: b"a".to_vec(), value: vec![1; 500] },
            LeafEntry { key: b"b".to_vec(), value: vec![2; 500] },
            LeafEntry { key: b"c".to_vec(), value: vec![3; 500] },
            LeafEntry { key: b"d".to_vec(), value: vec![4; 700] },
        ];
        let plan = plan_leaf_redistribution(&entries, PAGE_PAYLOAD, MIN_DIAGNOSTIC_OCCUPANCY_BYTES)
            .expect("el corte original sigue siendo válido");
        assert_eq!(plan.underfilled_pages, 1);
        assert!(plan.left_bytes >= MIN_DIAGNOSTIC_OCCUPANCY_BYTES);
        assert!(plan.right_bytes < MIN_DIAGNOSTIC_OCCUPANCY_BYTES);
    }

    #[test]
    fn leaf_redistribution_planner_returns_none_when_no_two_page_split_fits() {
        let entries = vec![
            LeafEntry { key: b"a".to_vec(), value: vec![1; PAGE_PAYLOAD] },
            LeafEntry { key: b"b".to_vec(), value: vec![2; PAGE_PAYLOAD] },
        ];
        assert!(plan_leaf_redistribution(&entries, PAGE_PAYLOAD, MIN_DIAGNOSTIC_OCCUPANCY_BYTES).is_none());
        assert!(plan_leaf_redistribution(&entries[..1], PAGE_PAYLOAD, MIN_DIAGNOSTIC_OCCUPANCY_BYTES).is_none());
    }

    #[test]
    fn internal_redistribution_planner_balances_bytes_without_unary_nodes() {
        let entries = (0..4).map(|index| InternalEntry {
            separator: vec![b'a' + index; 900],
            right_child: index as u64 + 2,
        }).collect::<Vec<_>>();
        let plan = plan_internal_redistribution(
            &entries, PAGE_PAYLOAD, MIN_DIAGNOSTIC_OCCUPANCY_BYTES
        ).expect("debe existir un separador promovible");
        assert_eq!(plan.promoted_index, 1);
        assert_eq!(plan.left_bytes.abs_diff(plan.right_bytes), 910);
        assert_eq!(plan.underfilled_pages, 1);
        assert!(plan.left_bytes <= PAGE_PAYLOAD);
        assert!(plan.right_bytes <= PAGE_PAYLOAD);
    }

    #[test]
    fn internal_redistribution_planner_chooses_byte_balanced_promotion() {
        let entries = vec![500usize, 500, 500, 500, 700]
            .into_iter()
            .enumerate()
            .map(|(index, size)| InternalEntry {
                separator: vec![b'a' + index as u8; size],
                right_child: index as u64 + 2,
            })
            .collect::<Vec<_>>();
        let plan = plan_internal_redistribution(
            &entries, PAGE_PAYLOAD, MIN_DIAGNOSTIC_OCCUPANCY_BYTES
        ).expect("debe existir una promoción que respete capacidad");
        assert_eq!(plan.promoted_index, 3);
        assert_eq!(plan.underfilled_pages, 1);
        assert!(plan.left_bytes >= MIN_DIAGNOSTIC_OCCUPANCY_BYTES);
        assert!(plan.right_bytes < MIN_DIAGNOSTIC_OCCUPANCY_BYTES);
        assert!(plan.left_bytes <= PAGE_PAYLOAD);
        assert!(plan.right_bytes <= PAGE_PAYLOAD);
    }

    #[test]
    fn internal_redistribution_planner_requires_two_local_children_per_side() {
        let entries = vec![
            InternalEntry { separator: b"a".to_vec(), right_child: 2 },
            InternalEntry { separator: b"b".to_vec(), right_child: 3 },
        ];
        assert!(plan_internal_redistribution(
            &entries, PAGE_PAYLOAD, MIN_DIAGNOSTIC_OCCUPANCY_BYTES
        ).is_none());
        let oversized = vec![
            InternalEntry { separator: vec![b'a'; PAGE_PAYLOAD], right_child: 2 },
            InternalEntry { separator: b"b".to_vec(), right_child: 3 },
            InternalEntry { separator: b"c".to_vec(), right_child: 4 },
            InternalEntry { separator: vec![b'd'; PAGE_PAYLOAD], right_child: 5 },
        ];
        assert!(plan_internal_redistribution(
            &oversized, PAGE_PAYLOAD, MIN_DIAGNOSTIC_OCCUPANCY_BYTES
        ).is_none());
    }

    #[test]
    fn repair_occupancy_redistributes_underfilled_leaf_entries_by_bytes() {
        let (pages, wal) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let left_id = tree.root.root_id;
            let right_id = 2;
            let root_id = 3;
            let left = BTreeNode::Leaf {
                next_leaf: Some(right_id),
                entries: vec![LeafEntry { key: b"a".to_vec(), value: vec![1; 1_000] }],
            };
            let right = BTreeNode::Leaf {
                next_leaf: None,
                entries: vec![
                    LeafEntry { key: b"b".to_vec(), value: vec![2; 1_000] },
                    LeafEntry { key: b"c".to_vec(), value: vec![3; 1_000] },
                    LeafEntry { key: b"d".to_vec(), value: vec![4; 1_000] },
                ],
            };
            let root = BTreeNode::Internal {
                level: 1,
                first_child: left_id,
                entries: vec![InternalEntry { separator: b"b".to_vec(), right_child: right_id }],
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            overlay.stage_payload(left_id, 1, encode_node(&left).unwrap()).unwrap();
            overlay.stage_allocate(right_id, 1, encode_node(&right).unwrap()).unwrap();
            overlay.stage_allocate(root_id, 1, encode_node(&root).unwrap()).unwrap();
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id, level: 1, free_head: None }),
            ).unwrap();
            tree.pages.transaction(overlay.into_changes()).unwrap();
            tree.root = RootMeta { root_id, level: 1, free_head: None };
            tree.meta_generation += 1;

            assert_eq!(tree.occupancy_diagnostics().unwrap().underfilled_non_root_leaf_pages, 1);
            assert_eq!(tree.repair_occupancy().unwrap(), 1);
            tree.validate().unwrap();
            let diagnostics = tree.occupancy_diagnostics().unwrap();
            assert_eq!(diagnostics.underfilled_non_root_leaf_pages, 0);
            assert_eq!(diagnostics.non_root_leaf_pages, 2);
            for key in [b"a".as_slice(), b"b", b"c", b"d"] {
                assert!(tree.get(key).unwrap().is_some(), "se conserva la clave {:?}", key);
            }
            let left_after = match BTreeNode::decode(&tree.pages.read(left_id).unwrap().payload).unwrap() {
                BTreeNode::Leaf { entries, .. } => entries,
                _ => panic!("la página izquierda debe seguir siendo hoja"),
            };
            let right_after = match BTreeNode::decode(&tree.pages.read(right_id).unwrap().payload).unwrap() {
                BTreeNode::Leaf { entries, .. } => entries,
                _ => panic!("la página derecha debe seguir siendo hoja"),
            };
            assert_eq!(left_after.len(), 2);
            assert_eq!(right_after.len(), 2);
            assert_eq!(left_after.last().unwrap().key, b"b".to_vec());
            assert_eq!(right_after.first().unwrap().key, b"c".to_vec());
        }
        {
            let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
            reopened.validate().unwrap();
            assert_eq!(reopened.occupancy_diagnostics().unwrap().underfilled_non_root_leaf_pages, 0);
            for key in [b"a".as_slice(), b"b", b"c", b"d"] {
                assert!(reopened.get(key).unwrap().is_some());
            }
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn repair_occupancy_redistributes_from_left_sibling_when_right_leaf_is_underfilled() {
        let (pages, wal) = paths();
        let root_id = 3;
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let left_id = tree.root.root_id;
            let right_id = 2;
            let left = BTreeNode::Leaf {
                next_leaf: Some(right_id),
                entries: vec![
                    LeafEntry { key: b"a".to_vec(), value: vec![1; 1_000] },
                    LeafEntry { key: b"b".to_vec(), value: vec![2; 1_000] },
                    LeafEntry { key: b"c".to_vec(), value: vec![3; 1_000] },
                ],
            };
            let right = BTreeNode::Leaf {
                next_leaf: None,
                entries: vec![LeafEntry { key: b"d".to_vec(), value: vec![4; 1_000] }],
            };
            let root = BTreeNode::Internal {
                level: 1,
                first_child: left_id,
                entries: vec![InternalEntry { separator: b"d".to_vec(), right_child: right_id }],
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            overlay.stage_payload(left_id, 1, encode_node(&left).unwrap()).unwrap();
            overlay.stage_allocate(right_id, 1, encode_node(&right).unwrap()).unwrap();
            overlay.stage_allocate(root_id, 1, encode_node(&root).unwrap()).unwrap();
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id, level: 1, free_head: None }),
            ).unwrap();
            tree.pages.transaction(overlay.into_changes()).unwrap();
            tree.root = RootMeta { root_id, level: 1, free_head: None };
            tree.meta_generation += 1;

            assert_eq!(tree.occupancy_diagnostics().unwrap().underfilled_non_root_leaf_pages, 1);
            tree.inject_apply_failure_after_images(1);
            assert!(matches!(
                tree.repair_occupancy(),
                Err(BTreeError::Journal(JournalError::Page(_)))
            ));
            assert!(matches!(
                tree.validate(),
                Err(BTreeError::Journal(JournalError::Invalid(
                    "se requiere cerrar y reabrir para completar recovery"
                )))
            ));
        }
        {
            let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
            reopened.validate().unwrap();
            assert_eq!(reopened.occupancy_diagnostics().unwrap().underfilled_non_root_leaf_pages, 0);
            for key in [b"a".as_slice(), b"b", b"c", b"d"] {
                assert!(reopened.get(key).unwrap().is_some());
            }
            let parent = match BTreeNode::decode(&reopened.pages.read(root_id).unwrap().payload).unwrap() {
                BTreeNode::Internal { entries, .. } => entries,
                _ => panic!("la raíz debe seguir siendo interna"),
            };
            assert_eq!(parent[0].separator, b"c".to_vec());
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn repair_occupancy_redistributes_underfilled_internal_entries_by_bytes() {
        let (pages, wal) = paths();
        let root_id = 10;
        let left_internal_id = 8;
        let right_internal_id = 9;
        let long_key = |prefix: u8| {
            let mut key = vec![prefix];
            key.resize(700, 0);
            key
        };
        let keys = vec![
            b"a".to_vec(),
            b"b".to_vec(),
            long_key(b'c'),
            long_key(b'd'),
            long_key(b'e'),
            long_key(b'f'),
            long_key(b'g'),
        ];
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            for index in 0..7usize {
                let page_id = index as u64 + 1;
                let leaf = BTreeNode::Leaf {
                    next_leaf: if index < 6 { Some(page_id + 1) } else { None },
                    entries: vec![LeafEntry {
                        key: keys[index].clone(),
                        value: vec![index as u8; if index < 2 { 1_400 } else { 700 }],
                    }],
                };
                let payload = encode_node(&leaf).unwrap();
                if page_id == 1 {
                    overlay.stage_payload(page_id, 1, payload).unwrap();
                } else {
                    overlay.stage_allocate(page_id, 1, payload).unwrap();
                }
            }
            let left_internal = BTreeNode::Internal {
                level: 1,
                first_child: 1,
                entries: vec![InternalEntry { separator: keys[1].clone(), right_child: 2 }],
            };
            let right_internal = BTreeNode::Internal {
                level: 1,
                first_child: 3,
                entries: vec![
                    InternalEntry { separator: keys[3].clone(), right_child: 4 },
                    InternalEntry { separator: keys[4].clone(), right_child: 5 },
                    InternalEntry { separator: keys[5].clone(), right_child: 6 },
                    InternalEntry { separator: keys[6].clone(), right_child: 7 },
                ],
            };
            let root = BTreeNode::Internal {
                level: 2,
                first_child: left_internal_id,
                entries: vec![InternalEntry {
                    separator: keys[2].clone(),
                    right_child: right_internal_id,
                }],
            };
            overlay.stage_allocate(left_internal_id, 1, encode_node(&left_internal).unwrap()).unwrap();
            overlay.stage_allocate(right_internal_id, 1, encode_node(&right_internal).unwrap()).unwrap();
            overlay.stage_allocate(root_id, 1, encode_node(&root).unwrap()).unwrap();
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id, level: 2, free_head: None }),
            ).unwrap();
            tree.pages.transaction(overlay.into_changes()).unwrap();
            tree.root = RootMeta { root_id, level: 2, free_head: None };
            tree.meta_generation += 1;

            let before = tree.occupancy_diagnostics().unwrap();
            assert_eq!(before.underfilled_non_root_internal_pages, 1);
            assert_eq!(before.underfilled_non_root_leaf_pages, 0);
            assert_eq!(tree.repair_occupancy().unwrap(), 1);
            tree.validate().unwrap();
            let after = tree.occupancy_diagnostics().unwrap();
            assert_eq!(after.underfilled_non_root_internal_pages, 0);
            assert_eq!(after.non_root_internal_pages, 2);
            for key in &keys {
                assert!(tree.get(key).unwrap().is_some());
            }
            let left_after = match BTreeNode::decode(&tree.pages.read(left_internal_id).unwrap().payload).unwrap() {
                BTreeNode::Internal { entries, .. } => entries,
                _ => panic!("el nodo izquierdo debe seguir siendo interno"),
            };
            let right_after = match BTreeNode::decode(&tree.pages.read(right_internal_id).unwrap().payload).unwrap() {
                BTreeNode::Internal { entries, .. } => entries,
                _ => panic!("el nodo derecho debe seguir siendo interno"),
            };
            let root_after = match BTreeNode::decode(&tree.pages.read(root_id).unwrap().payload).unwrap() {
                BTreeNode::Internal { entries, .. } => entries,
                _ => panic!("la raíz debe seguir siendo interna"),
            };
            assert_eq!(left_after.len(), 3);
            assert_eq!(right_after.len(), 2);
            assert_eq!(root_after[0].separator, keys[4]);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
            reopened.validate().unwrap();
            assert_eq!(reopened.occupancy_diagnostics().unwrap().underfilled_non_root_internal_pages, 0);
            for key in &keys {
                assert!(reopened.get(key).unwrap().is_some());
            }
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn repair_occupancy_merges_leaf_siblings_when_combined_payload_fits() {
        let (pages, wal) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let left_id = tree.root.root_id;
            let right_id = 2;
            let root_id = 3;
            let left = BTreeNode::Leaf {
                next_leaf: Some(right_id),
                entries: vec![LeafEntry { key: b"a".to_vec(), value: vec![1; 300] }],
            };
            let right = BTreeNode::Leaf {
                next_leaf: None,
                entries: vec![LeafEntry { key: b"b".to_vec(), value: vec![2; 300] }],
            };
            let root = BTreeNode::Internal {
                level: 1,
                first_child: left_id,
                entries: vec![InternalEntry { separator: b"b".to_vec(), right_child: right_id }],
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            overlay.stage_payload(left_id, 1, encode_node(&left).unwrap()).unwrap();
            overlay.stage_allocate(right_id, 1, encode_node(&right).unwrap()).unwrap();
            overlay.stage_allocate(root_id, 1, encode_node(&root).unwrap()).unwrap();
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id, level: 1, free_head: None }),
            ).unwrap();
            tree.pages.transaction(overlay.into_changes()).unwrap();
            tree.root = RootMeta { root_id, level: 1, free_head: None };
            tree.meta_generation += 1;

            assert_eq!(tree.repair_occupancy().unwrap(), 1);
            tree.validate().unwrap();
            assert_eq!(tree.root.root_id, left_id);
            assert_eq!(tree.root.level, 0);
            assert_eq!(tree.get(b"a").unwrap(), Some(vec![1; 300]));
            assert_eq!(tree.get(b"b").unwrap(), Some(vec![2; 300]));
            assert_eq!(
                tree.range(None, None).unwrap(),
                vec![(b"a".to_vec(), vec![1; 300]), (b"b".to_vec(), vec![2; 300])],
                "la fusión debe conservar el recorrido ordenado"
            );
            assert_eq!(tree.occupancy_diagnostics().unwrap().non_root_pages, 0);
            assert_eq!(tree.validate().unwrap().free_pages, 2);

            // Una segunda pasada ya convergida debe ser un no-op durable:
            // no puede escribir otro COMMIT ni alterar páginas/WAL.
            let wal_after_repair = std::fs::read(&wal).unwrap();
            assert_eq!(tree.repair_occupancy().unwrap(), 0);
            assert_eq!(std::fs::read(&wal).unwrap(), wal_after_repair);
            assert_eq!(tree.validate().unwrap().entries, 2);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
            reopened.validate().unwrap();
            assert_eq!(reopened.root.level, 0);
            assert_eq!(reopened.get(b"a").unwrap(), Some(vec![1; 300]));
            assert_eq!(reopened.get(b"b").unwrap(), Some(vec![2; 300]));
            let wal_after_reopen = std::fs::read(&wal).unwrap();
            assert_eq!(reopened.repair_occupancy().unwrap(), 0);
            assert_eq!(std::fs::read(&wal).unwrap(), wal_after_reopen);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn repair_occupancy_merges_internal_siblings_and_contracts_root() {
        let (pages, wal) = paths();
        let left_internal_id = 5;
        let right_internal_id = 6;
        let root_id = 7;
        let keys = [b"a".to_vec(), b"b".to_vec(), b"c".to_vec(), b"d".to_vec()];
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            for index in 0..4usize {
                let page_id = index as u64 + 1;
                let leaf = BTreeNode::Leaf {
                    next_leaf: if index < 3 { Some(page_id + 1) } else { None },
                    entries: vec![LeafEntry {
                        key: keys[index].clone(),
                        value: vec![index as u8; 1_500],
                    }],
                };
                let payload = encode_node(&leaf).unwrap();
                if page_id == 1 {
                    overlay.stage_payload(page_id, 1, payload).unwrap();
                } else {
                    overlay.stage_allocate(page_id, 1, payload).unwrap();
                }
            }
            let left_internal = BTreeNode::Internal {
                level: 1,
                first_child: 1,
                entries: vec![InternalEntry { separator: keys[1].clone(), right_child: 2 }],
            };
            let right_internal = BTreeNode::Internal {
                level: 1,
                first_child: 3,
                entries: vec![InternalEntry { separator: keys[3].clone(), right_child: 4 }],
            };
            let root = BTreeNode::Internal {
                level: 2,
                first_child: left_internal_id,
                entries: vec![InternalEntry {
                    separator: keys[2].clone(),
                    right_child: right_internal_id,
                }],
            };
            overlay.stage_allocate(left_internal_id, 1, encode_node(&left_internal).unwrap()).unwrap();
            overlay.stage_allocate(right_internal_id, 1, encode_node(&right_internal).unwrap()).unwrap();
            overlay.stage_allocate(root_id, 1, encode_node(&root).unwrap()).unwrap();
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id, level: 2, free_head: None }),
            ).unwrap();
            tree.pages.transaction(overlay.into_changes()).unwrap();
            tree.root = RootMeta { root_id, level: 2, free_head: None };
            tree.meta_generation += 1;

            assert_eq!(tree.repair_occupancy().unwrap(), 1);
            tree.validate().unwrap();
            assert_eq!(tree.root.root_id, left_internal_id);
            assert_eq!(tree.root.level, 1);
            for key in &keys {
                assert!(tree.get(key).unwrap().is_some());
            }
            let ordered = tree.range(None, None).unwrap();
            assert_eq!(ordered.iter().map(|(key, _)| key.clone()).collect::<Vec<_>>(), keys);
            let merged = match BTreeNode::decode(&tree.pages.read(left_internal_id).unwrap().payload).unwrap() {
                BTreeNode::Internal { level, first_child, entries } => {
                    assert_eq!(level, 1);
                    assert_eq!(first_child, 1);
                    entries
                }
                _ => panic!("la página superviviente debe seguir siendo interna"),
            };
            assert_eq!(merged.len(), 3);
            assert_eq!(tree.validate().unwrap().free_pages, 2);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
            reopened.validate().unwrap();
            assert_eq!(reopened.root.root_id, left_internal_id);
            assert_eq!(reopened.root.level, 1);
            for key in &keys {
                assert!(reopened.get(key).unwrap().is_some());
            }
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn occupancy_diagnostics_classifies_underfilled_payloads_by_node_type() {
        let (pages, wal) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let left_id = tree.root.root_id;
            let right_id = 2;
            let root_id = 3;
            let left = BTreeNode::Leaf {
                next_leaf: Some(right_id),
                entries: vec![LeafEntry { key: b"a".to_vec(), value: b"small".to_vec() }],
            };
            let right = BTreeNode::Leaf {
                next_leaf: None,
                entries: vec![LeafEntry { key: b"z".to_vec(), value: vec![7; MIN_DIAGNOSTIC_OCCUPANCY_BYTES - 27] }],
            };
            let root = BTreeNode::Internal {
                level: 1,
                first_child: left_id,
                entries: vec![InternalEntry { separator: b"z".to_vec(), right_child: right_id }],
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            overlay.stage_payload(left_id, 1, encode_node(&left).unwrap()).unwrap();
            overlay.stage_allocate(right_id, 1, encode_node(&right).unwrap()).unwrap();
            overlay.stage_allocate(root_id, 1, encode_node(&root).unwrap()).unwrap();
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id, level: 1, free_head: None }),
            ).unwrap();
            tree.pages.transaction(overlay.into_changes()).unwrap();
            tree.root = RootMeta { root_id, level: 1, free_head: None };
            tree.meta_generation += 1;

            let diagnostics = tree.occupancy_diagnostics().unwrap();
            assert_eq!(diagnostics.minimum_diagnostic_occupancy_bytes, MIN_DIAGNOSTIC_OCCUPANCY_BYTES);
            assert_eq!(diagnostics.non_root_leaf_pages, 2);
            assert_eq!(diagnostics.non_root_pages, 2);
            assert_eq!(diagnostics.underfilled_non_root_leaf_pages, 1);
            assert_eq!(diagnostics.underfilled_non_root_pages, 1);
            assert_eq!(
                diagnostics.largest_non_root_leaf_payload_bytes,
                Some(MIN_DIAGNOSTIC_OCCUPANCY_BYTES)
            );
            assert_eq!(
                diagnostics.non_root_payload_bytes,
                diagnostics.non_root_leaf_payload_bytes
            );
            assert!(diagnostics.non_root_leaf_payload_bytes < PAGE_PAYLOAD * diagnostics.non_root_leaf_pages);
            assert_eq!(diagnostics.underfilled_non_root_internal_pages, 0);
            assert_eq!(diagnostics.empty_non_root_leaves, 0);
            assert_eq!(tree.validate().unwrap().entries, 2);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn occupancy_diagnostics_classifies_underfilled_internal_payloads() {
        let (pages, wal) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let leaf_a_id = tree.root.root_id;
            let leaf_m_id = 2;
            let leaf_z_id = 3;
            let left_internal_id = 4;
            let right_internal_id = 5;
            let root_id = 6;
            let long_key = vec![b'z'; MIN_DIAGNOSTIC_OCCUPANCY_BYTES - 38];
            let leaf_a = BTreeNode::Leaf {
                next_leaf: Some(leaf_m_id),
                entries: vec![LeafEntry { key: b"a".to_vec(), value: b"a".to_vec() }],
            };
            let leaf_m = BTreeNode::Leaf {
                next_leaf: Some(leaf_z_id),
                entries: vec![LeafEntry { key: b"m".to_vec(), value: b"m".to_vec() }],
            };
            let leaf_z = BTreeNode::Leaf {
                next_leaf: None,
                entries: vec![LeafEntry { key: long_key.clone(), value: vec![b'z'; 50] }],
            };
            let left_internal = BTreeNode::Internal {
                level: 1, first_child: leaf_a_id, entries: Vec::new(),
            };
            let right_internal = BTreeNode::Internal {
                level: 1,
                first_child: leaf_m_id,
                entries: vec![InternalEntry { separator: long_key.clone(), right_child: leaf_z_id }],
            };
            let root = BTreeNode::Internal {
                level: 2,
                first_child: left_internal_id,
                entries: vec![InternalEntry { separator: b"m".to_vec(), right_child: right_internal_id }],
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            overlay.stage_payload(leaf_a_id, 1, encode_node(&leaf_a).unwrap()).unwrap();
            for (id, node) in [
                (leaf_m_id, &leaf_m),
                (leaf_z_id, &leaf_z),
                (left_internal_id, &left_internal),
                (right_internal_id, &right_internal),
                (root_id, &root),
            ] {
                overlay.stage_allocate(id, 1, encode_node(node).unwrap()).unwrap();
            }
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id, level: 2, free_head: None }),
            ).unwrap();
            tree.pages.transaction(overlay.into_changes()).unwrap();
            tree.root = RootMeta { root_id, level: 2, free_head: None };
            tree.meta_generation += 1;

            let diagnostics = tree.occupancy_diagnostics().unwrap();
            assert_eq!(diagnostics.non_root_internal_pages, 2);
            assert_eq!(diagnostics.non_root_pages, 5);
            assert!(diagnostics.non_root_internal_payload_bytes < PAGE_PAYLOAD * diagnostics.non_root_internal_pages);
            assert_eq!(diagnostics.non_root_internal_payload_bytes, MIN_DIAGNOSTIC_OCCUPANCY_BYTES + 28);
            assert_eq!(
                diagnostics.largest_non_root_internal_payload_bytes,
                Some(MIN_DIAGNOSTIC_OCCUPANCY_BYTES)
            );
            assert_eq!(diagnostics.underfilled_non_root_internal_pages, 1);
            assert_eq!(diagnostics.underfilled_non_root_pages, 3);
            assert_eq!(
                diagnostics.non_root_payload_bytes,
                diagnostics.non_root_leaf_payload_bytes + diagnostics.non_root_internal_payload_bytes
            );
            assert_eq!(diagnostics.unary_non_root_internal_nodes, 1);
            assert_eq!(tree.validate().unwrap().entries, 3);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn batch_image_limit_accepts_exact_capacity() {
        assert!(ensure_transaction_image_limit(3, 3).is_ok());
        assert!(ensure_transaction_image_limit(0, 3).is_ok());
    }

    #[test]
    fn batch_image_limit_rejects_one_over_capacity_before_journal_commit() {
        let error = ensure_transaction_image_limit(4, 3).unwrap_err();
        assert!(matches!(error, BTreeError::Journal(JournalError::Invalid("demasiadas imágenes en una transacción"))));
    }

    #[test]
    fn internal_split_balances_encoded_size_with_unequal_separators() {
        let entries = vec![
            InternalEntry { separator: vec![b'a'; 3000], right_child: 2 },
            InternalEntry { separator: vec![b'm'; 100], right_child: 3 },
            InternalEntry { separator: vec![b'z'; 3000], right_child: 4 },
        ];
        let (left, right, promoted) = split_internal(1, 1, entries).unwrap();
        assert_eq!(promoted, vec![b'm'; 100]);
        let left_bytes = left.encode(PAGE_PAYLOAD).unwrap();
        let right_bytes = right.encode(PAGE_PAYLOAD).unwrap();
        assert_eq!(left_bytes.len(), 3038);
        assert_eq!(right_bytes.len(), 3038);
        assert_eq!(BTreeNode::decode(&left_bytes).unwrap(), left);
        assert_eq!(BTreeNode::decode(&right_bytes).unwrap(), right);
    }

    #[test]
    fn internal_merge_with_maximum_parent_separator_fits_exactly_in_both_directions() {
        let separator = vec![b'm'; MAX_TREE_KEY_LEN];
        let (left_first, merged_left) = merge_internal_with_left(
            separator.clone(), 10, Vec::new(), 20, Vec::new(),
        );
        assert_eq!(left_first, 10);
        let left_node = BTreeNode::Internal { level: 1, first_child: left_first, entries: merged_left };
        let left_bytes = left_node.encode(PAGE_PAYLOAD).unwrap();
        assert_eq!(left_bytes.len(), PAGE_PAYLOAD);
        assert_eq!(BTreeNode::decode(&left_bytes).unwrap(), left_node);

        let (right_first, merged_right) = merge_internal_with_right(
            separator, 10, Vec::new(), 20, Vec::new(),
        );
        assert_eq!(right_first, 10);
        let right_node = BTreeNode::Internal { level: 1, first_child: right_first, entries: merged_right };
        let right_bytes = right_node.encode(PAGE_PAYLOAD).unwrap();
        assert_eq!(right_bytes.len(), PAGE_PAYLOAD);
        assert_eq!(BTreeNode::decode(&right_bytes).unwrap(), right_node);
    }

    #[test]
    fn internal_borrow_from_left_rotates_parent_separator_and_child() {
        let left = vec![InternalEntry { separator: b"m".to_vec(), right_child: 12 }];
        let node = vec![InternalEntry { separator: b"t".to_vec(), right_child: 20 }];
        let (parent, left_first, left_after, node_first, node_after) =
            borrow_internal_from_left(b"p".to_vec(), 10, left, 18, node).unwrap();
        assert_eq!(parent, b"m");
        assert_eq!(left_first, 10);
        assert!(left_after.is_empty());
        assert_eq!(node_first, 12);
        assert_eq!(node_after[0].separator, b"p");
        assert_eq!(node_after[0].right_child, 18);
        assert_eq!(node_after[1].separator, b"t");
    }

    #[test]
    fn internal_borrow_from_right_rotates_parent_separator_and_child() {
        let node = vec![InternalEntry { separator: b"m".to_vec(), right_child: 12 }];
        let right = vec![
            InternalEntry { separator: b"t".to_vec(), right_child: 20 },
            InternalEntry { separator: b"z".to_vec(), right_child: 26 },
        ];
        let (parent, node_first, node_after, right_first, right_after) =
            borrow_internal_from_right(b"p".to_vec(), 10, node, 18, right).unwrap();
        assert_eq!(parent, b"t");
        assert_eq!(node_first, 10);
        assert_eq!(node_after.last().unwrap().separator, b"p");
        assert_eq!(node_after.last().unwrap().right_child, 18);
        assert_eq!(right_first, 20);
        assert_eq!(right_after.len(), 1);
        assert_eq!(right_after[0].separator, b"z");
    }

    #[test]
    fn internal_merge_includes_parent_separator_between_child_ranges() {
        let left = vec![InternalEntry { separator: b"m".to_vec(), right_child: 12 }];
        let right = vec![InternalEntry { separator: b"z".to_vec(), right_child: 26 }];
        let (first, merged) = merge_internal_with_left(b"t".to_vec(), 10, left, 18, right.clone());
        assert_eq!(first, 10);
        assert_eq!(merged.iter().map(|e| e.separator.as_slice()).collect::<Vec<_>>(), vec![b"m".to_vec(), b"t".to_vec(), b"z".to_vec()]);
        let (first_r, merged_r) = merge_internal_with_right(
            b"t".to_vec(), 10, vec![InternalEntry { separator: b"m".to_vec(), right_child: 12 }], 18, right,
        );
        assert_eq!(first_r, 10);
        assert_eq!(merged_r.iter().map(|e| e.separator.as_slice()).collect::<Vec<_>>(), vec![b"m".as_slice(), b"t".as_slice(), b"z".as_slice()]);
    }




    #[test]
    fn one_mutation_session_observes_prior_inserts_across_leaf_and_root_splits() {
        let (pages, wal) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let value = vec![b'v'; 1800];
            let mut session = MutationSession::new(
                tree.root.clone(),
                tree.meta_generation,
                tree.pages.page_count(),
            );

            // La tercera inserción divide la hoja raíz. La siguiente debe atravesar
            // el nuevo root y modificar una hoja ya staged en el overlay.
            tree.insert_in_session(b"a", &value, &mut session).unwrap();
            tree.insert_in_session(b"z", &value, &mut session).unwrap();
            tree.insert_in_session(b"m", &value, &mut session).unwrap();
            tree.insert_in_session(b"b", &value, &mut session).unwrap();
            tree.insert_in_session(b"b", b"replacement", &mut session).unwrap();

            assert!(session.root.level >= 1);
            session.root.free_head = session.free_head;
            tree.commit_mutation_session(session).unwrap();

            for key in [b"a".as_slice(), b"m".as_slice(), b"z".as_slice()] {
                assert_eq!(tree.get(key).unwrap(), Some(value.clone()));
            }
            assert_eq!(tree.get(b"b").unwrap(), Some(b"replacement".to_vec()));
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 4);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
            assert_eq!(reopened.validate().unwrap().entries, 4);
            for key in [b"a".as_slice(), b"m".as_slice(), b"z".as_slice()] {
                assert_eq!(reopened.get(key).unwrap(), Some(vec![b'v'; 1800]));
            }
            assert_eq!(reopened.get(b"b").unwrap(), Some(b"replacement".to_vec()));
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn abandoned_mutation_session_leaves_physical_pages_unchanged() {
        let (pages, wal) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let root_id = tree.root.root_id;
            let before = tree.pages.read(root_id).unwrap();
            let page_count = tree.pages.page_count();
            let mut session = MutationSession::new(
                tree.root.clone(),
                tree.meta_generation,
                page_count,
            );
            tree.insert_in_session(b"staged", b"not-committed", &mut session).unwrap();

            // Una entrada individual que no cabe no puede dividirse: el error
            // abandona la sesión completa, incluida la inserción previa.
            let oversized = vec![b'x'; PAGE_PAYLOAD];
            assert!(matches!(
                tree.insert_in_session(b"too-large", &oversized, &mut session),
                Err(BTreeError::NoSpace)
            ));
            drop(session);

            assert_eq!(tree.pages.page_count(), page_count);
            let after = tree.pages.read(root_id).unwrap();
            assert_eq!(after.generation, before.generation);
            assert_eq!(after.payload, before.payload);
            assert_eq!(tree.get(b"staged").unwrap(), None);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
            assert_eq!(reopened.get(b"staged").unwrap(), None);
            assert_eq!(reopened.validate().unwrap().entries, 0);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn overlay_page_reader_prefers_staged_overwrite_to_physical_page() {
        let (pages, wal) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let physical = tree.pages.read(tree.root.root_id).unwrap();
            let original = BTreeNode::decode(&physical.payload).unwrap();
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            let replacement = encode_node(&BTreeNode::Leaf {
                next_leaf: None,
                entries: vec![LeafEntry { key: b"staged".to_vec(), value: b"value".to_vec() }],
            }).unwrap();
            overlay.stage_overwrite(
                tree.root.root_id, physical.generation, physical.generation + 1,
                replacement.clone(),
            ).unwrap();

            let (generation, payload) = tree.read_page_overlay(&overlay, tree.root.root_id).unwrap();
            assert_eq!(generation, physical.generation + 1);
            assert_eq!(payload, replacement);
            assert_ne!(BTreeNode::decode(&payload).unwrap(), original);
            assert_eq!(tree.pages.read(tree.root.root_id).unwrap().payload, physical.payload);
            let (node_generation, staged_node) = tree.read_node_overlay(&overlay, tree.root.root_id).unwrap();
            assert_eq!(node_generation, physical.generation + 1);
            assert!(matches!(staged_node, BTreeNode::Leaf { entries, .. }
                if entries.len() == 1 && entries[0].key == b"staged"));

            // Una segunda operación sobre la misma página sustituye el payload
            // staged sin incrementar otra vez la generación física esperada.
            let final_payload = encode_node(&BTreeNode::Leaf {
                next_leaf: None,
                entries: vec![LeafEntry { key: b"final".to_vec(), value: b"second-op".to_vec() }],
            }).unwrap();
            overlay.stage_payload(tree.root.root_id, physical.generation, final_payload.clone()).unwrap();
            let (final_generation, final_node) = tree.read_node_overlay(&overlay, tree.root.root_id).unwrap();
            assert_eq!(final_generation, physical.generation + 1);
            assert!(matches!(final_node, BTreeNode::Leaf { entries, .. }
                if entries.len() == 1 && entries[0].key == b"final" && entries[0].value == b"second-op"));
            assert_eq!(tree.pages.read(tree.root.root_id).unwrap().payload, physical.payload);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn overlay_page_reader_resolves_allocations_and_rejects_freed_pages() {
        let (pages, wal) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let base = tree.pages.page_count();
            let mut overlay = PageOverlay::new(base);
            let allocated = encode_node(&BTreeNode::Leaf { next_leaf: None, entries: Vec::new() }).unwrap();
            overlay.stage_allocate(base, 1, allocated.clone()).unwrap();
            let (generation, payload) = tree.read_page_overlay(&overlay, base).unwrap();
            assert_eq!(generation, 1);
            assert_eq!(payload, allocated);

            let root = tree.pages.read(tree.root.root_id).unwrap();
            let mut freed = PageOverlay::new(base);
            freed.stage_overwrite(
                tree.root.root_id,
                root.generation,
                root.generation + 1,
                crate::page_reuse::FreePage { next: None }.encode(),
            ).unwrap();
            assert!(matches!(
                tree.read_page_overlay(&freed, tree.root.root_id),
                Err(BTreeError::Corrupt("lectura de nodo sobre página libre en overlay"))
            ));
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn overwrite_set_coalesces_repeated_updates_to_one_page() {
        let mut staged = PageOverwriteSet::default();
        staged.stage(7, 3, 4, b"first".to_vec()).unwrap();
        staged.stage(7, 3, 4, b"final".to_vec()).unwrap();
        let changes = staged.into_changes();
        assert_eq!(changes.len(), 1);
        assert!(matches!(&changes[0], PageChange::Overwrite {
            page_id: 7, expected_generation: 3, new_generation: 4, payload,
        } if payload == b"final"));
    }


    #[test]
    fn overwrite_set_accepts_metadata_page_zero() {
        let mut staged = PageOverwriteSet::default();
        staged.stage(0, 8, 9, b"metadata".to_vec()).unwrap();
        let changes = staged.into_changes();
        assert!(matches!(&changes[..], [PageChange::Overwrite {
            page_id: 0, expected_generation: 8, new_generation: 9, payload,
        }] if payload == b"metadata"));
    }

    #[test]
    fn overwrite_set_rejects_incompatible_generation_for_same_page() {
        let mut staged = PageOverwriteSet::default();
        staged.stage(7, 3, 4, b"first".to_vec()).unwrap();
        assert!(matches!(
            staged.stage(7, 4, 5, b"second".to_vec()),
            Err(BTreeError::Corrupt(_))
        ));
    }


    #[test]
    fn internal_left_borrow_preserves_child_order_and_separator_order() {
        let left = vec![
            InternalEntry { separator: b"m".to_vec(), right_child: 12 },
            InternalEntry { separator: b"t".to_vec(), right_child: 13 },
        ];
        let node = vec![InternalEntry { separator: b"z".to_vec(), right_child: 20 }];
        let (parent_separator, left_first, left_after, node_first, node_after) =
            borrow_internal_from_left(b"w".to_vec(), 10, left, 21, node).unwrap();
        assert_eq!(parent_separator, b"t");
        assert_eq!(left_first, 10);
        assert_eq!(left_after.len(), 1);
        assert_eq!(left_after[0].right_child, 12);
        assert_eq!(node_first, 13);
        assert_eq!(node_after.len(), 2);
        assert_eq!(node_after[0].separator, b"w");
        assert_eq!(node_after[0].right_child, 21);
        assert_eq!(node_after[1].separator, b"z");
        assert_eq!(node_after[1].right_child, 20);
    }

    #[test]
    fn internal_right_borrow_preserves_child_order_and_separator_order() {
        let node = vec![InternalEntry { separator: b"m".to_vec(), right_child: 12 }];
        let right = vec![
            InternalEntry { separator: b"t".to_vec(), right_child: 22 },
            InternalEntry { separator: b"z".to_vec(), right_child: 23 },
        ];
        let (parent_separator, node_first, node_after, right_first, right_after) =
            borrow_internal_from_right(b"p".to_vec(), 10, node, 21, right).unwrap();
        assert_eq!(parent_separator, b"t");
        assert_eq!(node_first, 10);
        assert_eq!(node_after.len(), 2);
        assert_eq!(node_after[0].separator, b"m");
        assert_eq!(node_after[0].right_child, 12);
        assert_eq!(node_after[1].separator, b"p");
        assert_eq!(node_after[1].right_child, 21);
        assert_eq!(right_first, 22);
        assert_eq!(right_after.len(), 1);
        assert_eq!(right_after[0].separator, b"z");
        assert_eq!(right_after[0].right_child, 23);
    }

    #[test]
    fn internal_merges_preserve_every_child_in_order() {
        let left_entries = vec![InternalEntry { separator: b"m".to_vec(), right_child: 12 }];
        let node_entries = vec![InternalEntry { separator: b"z".to_vec(), right_child: 23 }];
        let (left_first, merged_left) = merge_internal_with_left(
            b"t".to_vec(), 10, left_entries.clone(), 20, node_entries.clone(),
        );
        assert_eq!(left_first, 10);
        assert_eq!(merged_left.iter().map(|e| e.right_child).collect::<Vec<_>>(), vec![12,20,23]);
        assert_eq!(merged_left.iter().map(|e| e.separator.clone()).collect::<Vec<_>>(), vec![b"m".to_vec(),b"t".to_vec(),b"z".to_vec()]);

        let (right_first, merged_right) = merge_internal_with_right(
            b"t".to_vec(), 10, left_entries, 20, node_entries,
        );
        assert_eq!(right_first, 10);
        assert_eq!(merged_right.iter().map(|e| e.right_child).collect::<Vec<_>>(), vec![12,20,23]);
        assert_eq!(merged_right.iter().map(|e| e.separator.clone()).collect::<Vec<_>>(), vec![b"m".to_vec(),b"t".to_vec(),b"z".to_vec()]);
    }


    #[test]
    fn internal_rebalance_planner_borrows_from_left_and_updates_parent() {
        let parent = vec![
            InternalEntry { separator: b"w".to_vec(), right_child: 20 },
        ];
        let left = vec![
            InternalEntry { separator: b"m".to_vec(), right_child: 12 },
            InternalEntry { separator: b"t".to_vec(), right_child: 13 },
        ];
        let plan = plan_internal_rebalance(
            10, parent, 1, 20, 1, 21, Vec::new(),
            Some((10, 11, left)), None,
        ).unwrap();
        assert_eq!(plan.parent_entries[0].separator, b"t");
        assert_eq!(plan.surviving_page_id, 20);
        assert_eq!(plan.freed_page_id, None);
        assert_eq!(plan.changed_nodes.len(), 2);
        let BTreeNode::Internal { first_child, entries, .. } = &plan.changed_nodes[1].1 else { panic!("nodo actual no interno") };
        assert_eq!(*first_child, 13);
        assert_eq!(entries[0].separator, b"w");
        assert_eq!(entries[0].right_child, 21);
    }

    #[test]
    fn internal_rebalance_planner_borrows_from_right_and_updates_parent() {
        let parent = vec![
            InternalEntry { separator: b"p".to_vec(), right_child: 20 },
        ];
        let right = vec![
            InternalEntry { separator: b"t".to_vec(), right_child: 22 },
            InternalEntry { separator: b"z".to_vec(), right_child: 23 },
        ];
        let plan = plan_internal_rebalance(
            10, parent, 0, 10, 1, 11, Vec::new(),
            None, Some((20, 21, right)),
        ).unwrap();
        assert_eq!(plan.parent_entries[0].separator, b"t");
        assert_eq!(plan.surviving_page_id, 10);
        assert_eq!(plan.freed_page_id, None);
        let BTreeNode::Internal { entries, .. } = &plan.changed_nodes[0].1 else { panic!("nodo actual no interno") };
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].separator, b"p");
        assert_eq!(entries[0].right_child, 21);
    }

    #[test]
    fn internal_rebalance_planner_merges_into_left_and_removes_parent_separator() {
        let parent = vec![
            InternalEntry { separator: b"w".to_vec(), right_child: 20 },
        ];
        let plan = plan_internal_rebalance(
            10, parent, 1, 20, 1, 21, Vec::new(),
            Some((10, 11, vec![InternalEntry { separator: b"m".to_vec(), right_child: 12 }])),
            None,
        ).unwrap();
        assert!(plan.parent_entries.is_empty());
        assert_eq!(plan.surviving_page_id, 10);
        assert_eq!(plan.freed_page_id, Some(20));
        let BTreeNode::Internal { first_child, entries, .. } = &plan.changed_nodes[0].1 else { panic!("nodo fusionado no interno") };
        assert_eq!(*first_child, 11);
        assert_eq!(entries.iter().map(|e| e.separator.clone()).collect::<Vec<_>>(), vec![b"m".to_vec(), b"w".to_vec()]);
        assert_eq!(entries.iter().map(|e| e.right_child).collect::<Vec<_>>(), vec![12, 21]);
    }

    #[test]
    fn internal_rebalance_planner_merges_right_into_first_child() {
        let parent = vec![
            InternalEntry { separator: b"p".to_vec(), right_child: 20 },
        ];
        let plan = plan_internal_rebalance(
            10, parent, 0, 10, 1, 11, Vec::new(),
            None, Some((20, 21, vec![InternalEntry { separator: b"z".to_vec(), right_child: 22 }])),
        ).unwrap();
        assert!(plan.parent_entries.is_empty());
        assert_eq!(plan.surviving_page_id, 10);
        assert_eq!(plan.freed_page_id, Some(20));
        let BTreeNode::Internal { first_child, entries, .. } = &plan.changed_nodes[0].1 else { panic!("nodo fusionado no interno") };
        assert_eq!(*first_child, 11);
        assert_eq!(entries.iter().map(|e| e.separator.clone()).collect::<Vec<_>>(), vec![b"p".to_vec(), b"z".to_vec()]);
        assert_eq!(entries.iter().map(|e| e.right_child).collect::<Vec<_>>(), vec![21, 22]);
    }

    #[test]
    fn internal_rebalance_planner_rejects_merge_that_does_not_fit() {
        let huge = vec![b'x'; PAGE_PAYLOAD];
        let parent = vec![InternalEntry { separator: huge.clone(), right_child: 20 }];
        let left = vec![InternalEntry { separator: b"m".to_vec(), right_child: 12 }];
        let result = plan_internal_rebalance(
            10, parent, 1, 20, 1, 21, Vec::new(),
            Some((10, 11, left)), None,
        );
        assert!(matches!(result, Err(BTreeError::NoSpace)));
    }



    #[test]
    fn overwrite_set_stages_free_page_and_links_previous_head() {
        let mut set = PageOverwriteSet::default();
        let mut free_head = Some(7);
        set.stage_free_page(12, 4, &mut free_head).unwrap();
        assert_eq!(free_head, Some(12));
        let changes = set.into_changes();
        assert_eq!(changes.len(), 1);
        let PageChange::Overwrite { page_id, expected_generation, new_generation, payload } = &changes[0] else {
            panic!("se esperaba una sobrescritura");
        };
        assert_eq!(*page_id, 12);
        assert_eq!(*expected_generation, 4);
        assert_eq!(*new_generation, 5);
        let free = crate::page_reuse::FreePage::decode(payload).unwrap();
        assert_eq!(free.next, Some(7));
    }

    #[test]
    fn overwrite_set_rejects_freeing_a_page_already_staged_as_live() {
        let mut set = PageOverwriteSet::default();
        set.stage(12, 4, 5, vec![1, 2, 3]).unwrap();
        let mut free_head = None;
        assert!(matches!(set.stage_free_page(12, 4, &mut free_head), Err(BTreeError::Corrupt(_))));
        assert_eq!(free_head, None);
        assert_eq!(set.pages.len(), 1);
    }

    #[test]
    fn overwrite_set_rejects_freeing_metadata_page() {
        let mut set = PageOverwriteSet::default();
        let mut free_head = None;
        assert!(matches!(set.stage_free_page(0, 4, &mut free_head), Err(BTreeError::Corrupt(_))));
        assert!(set.pages.is_empty());
    }


    #[test]
    fn internal_borrow_from_left_rejects_empty_donor() {
        let result = borrow_internal_from_left(
            b"p".to_vec(), 10, Vec::new(), 18, Vec::new(),
        );
        assert!(matches!(result, Err(BTreeError::Corrupt(_))));
    }

    #[test]
    fn internal_borrow_from_right_rejects_empty_donor() {
        let result = borrow_internal_from_right(
            b"p".to_vec(), 10, Vec::new(), 18, Vec::new(),
        );
        assert!(matches!(result, Err(BTreeError::Corrupt(_))));
    }

    #[test]
    fn internal_merge_result_roundtrips_through_node_codec() {
        let left = vec![InternalEntry { separator: b"m".to_vec(), right_child: 12 }];
        let right = vec![InternalEntry { separator: b"z".to_vec(), right_child: 26 }];
        let (first_child, entries) =
            merge_internal_with_left(b"t".to_vec(), 10, left, 18, right);
        let node = BTreeNode::Internal { level: 2, first_child, entries };
        let encoded = encode_node(&node).unwrap();
        assert_eq!(BTreeNode::decode(&encoded).unwrap(), node);
    }

    #[test]
    fn internal_borrow_results_roundtrip_through_node_codec() {
        let left = vec![InternalEntry { separator: b"m".to_vec(), right_child: 12 }];
        let (parent_separator, left_first, left_entries, node_first, node_entries) =
            borrow_internal_from_left(b"p".to_vec(), 10, left, 18, vec![
                InternalEntry { separator: b"t".to_vec(), right_child: 20 },
            ]).unwrap();
        let left_node = BTreeNode::Internal {
            level: 2, first_child: left_first, entries: left_entries,
        };
        let node = BTreeNode::Internal {
            level: 2, first_child: node_first, entries: node_entries,
        };
        assert_eq!(BTreeNode::decode(&encode_node(&left_node).unwrap()).unwrap(), left_node);
        assert_eq!(BTreeNode::decode(&encode_node(&node).unwrap()).unwrap(), node);
        assert_eq!(parent_separator, b"m");
    }


    #[test]
    fn internal_right_borrow_results_roundtrip_through_node_codec() {
        let node = vec![InternalEntry { separator: b"m".to_vec(), right_child: 12 }];
        let right = vec![
            InternalEntry { separator: b"t".to_vec(), right_child: 20 },
            InternalEntry { separator: b"z".to_vec(), right_child: 26 },
        ];
        let (parent_separator, node_first, node_entries, right_first, right_entries) =
            borrow_internal_from_right(b"p".to_vec(), 10, node, 18, right).unwrap();
        let node = BTreeNode::Internal { level: 2, first_child: node_first, entries: node_entries };
        let right = BTreeNode::Internal { level: 2, first_child: right_first, entries: right_entries };
        assert_eq!(BTreeNode::decode(&encode_node(&node).unwrap()).unwrap(), node);
        assert_eq!(BTreeNode::decode(&encode_node(&right).unwrap()).unwrap(), right);
        assert_eq!(parent_separator, b"t");
    }

    #[test]
    fn internal_merge_with_right_roundtrips_through_node_codec() {
        let (first_child, entries) = merge_internal_with_right(
            b"t".to_vec(),
            10,
            vec![InternalEntry { separator: b"m".to_vec(), right_child: 12 }],
            18,
            vec![InternalEntry { separator: b"z".to_vec(), right_child: 26 }],
        );
        let node = BTreeNode::Internal { level: 2, first_child, entries };
        assert_eq!(BTreeNode::decode(&encode_node(&node).unwrap()).unwrap(), node);
    }

    #[test]
    fn parent_resolution_uses_current_page_ids_and_child_positions() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            for key in [b"a".as_slice(), b"b".as_slice(), b"c".as_slice()] {
                tree.insert(key.to_vec(), vec![7; 1500]).unwrap();
            }
            assert!(tree.height() >= 1);
            let root_id = tree.root_page_id();
            assert_eq!(tree.resolve_parent(root_id).unwrap(), None);

            let root_page = tree.pages.read(root_id).unwrap();
            let BTreeNode::Internal { level, first_child, entries } =
                BTreeNode::decode(&root_page.payload).unwrap() else {
                    panic!("la raíz de prueba debe ser interna");
                };
            let mut children = vec![first_child];
            children.extend(entries.iter().map(|entry| entry.right_child));
            for (index, child_id) in children.into_iter().enumerate() {
                let location = tree.resolve_parent(child_id).unwrap().unwrap();
                assert_eq!(location.parent_id, root_id);
                assert_eq!(location.parent_level, level);
                assert_eq!(location.child_index, index);
            }
        }
        cleanup(&p, &w);
    }

    #[test]
    fn overlay_parent_resolution_prefers_staged_root_and_rejects_freed_pages() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            for key in [b"a".as_slice(), b"b".as_slice(), b"c".as_slice()] {
                tree.insert(key.to_vec(), vec![5; 1500]).unwrap();
            }
            let root_id = tree.root_page_id();
            let root_page = tree.pages.read(root_id).unwrap();
            let BTreeNode::Internal { level, first_child, mut entries } =
                BTreeNode::decode(&root_page.payload).unwrap() else {
                    panic!("la raíz de prueba debe ser interna");
                };
            assert!(!entries.is_empty());
            let original_first = first_child;
            let original_second = entries[0].right_child;
            entries[0].right_child = original_first;
            let staged_root = BTreeNode::Internal {
                level,
                first_child: original_second,
                entries,
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            overlay.stage_overwrite(
                root_id,
                root_page.generation,
                root_page.generation + 1,
                encode_node(&staged_root).unwrap(),
            ).unwrap();

            let location = tree.resolve_parent_with_overlay(
                original_first, &overlay,
            ).unwrap().unwrap();
            assert_eq!(location.parent_id, root_id);
            assert_eq!(location.child_index, 1);

            let mut free_head = None;
            let child_page = tree.pages.read(original_first).unwrap();
            overlay.stage_free_page(original_first, child_page.generation, &mut free_head).unwrap();
            assert!(matches!(
                tree.resolve_parent_with_overlay(original_first, &overlay),
                Err(BTreeError::Corrupt("página liberada referenciada en overlay"))
            ));
        }
        cleanup(&p, &w);
    }

    #[test]
    fn overlay_resolves_newly_allocated_child_with_logical_page_count() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            for key in [b"a".as_slice(), b"b".as_slice(), b"c".as_slice()] {
                tree.insert(key.to_vec(), vec![9; 1500]).unwrap();
            }
            let root_id = tree.root_page_id();
            let root_page = tree.pages.read(root_id).unwrap();
            let BTreeNode::Internal { level, first_child: _, entries } =
                BTreeNode::decode(&root_page.payload).unwrap() else {
                    panic!("la raíz de prueba debe ser interna");
                };
            let allocated_id = tree.pages.page_count();
            let staged_root = BTreeNode::Internal {
                level,
                first_child: allocated_id,
                entries,
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            overlay.stage_allocate(
                allocated_id,
                1,
                encode_node(&BTreeNode::Leaf { next_leaf: None, entries: Vec::new() }).unwrap(),
            ).unwrap();
            overlay.stage_overwrite(
                root_id,
                root_page.generation,
                root_page.generation + 1,
                encode_node(&staged_root).unwrap(),
            ).unwrap();

            assert_eq!(overlay.logical_page_count(), allocated_id + 1);
            let location = tree.resolve_parent_with_overlay(allocated_id, &overlay).unwrap().unwrap();
            assert_eq!(location.parent_id, root_id);
            assert_eq!(location.child_index, 0);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn overlay_reuses_registered_free_page_with_one_generation_step() {
        let mut overlay = PageOverlay::new(5);
        overlay.register_free_page(3, 8, Some(2)).unwrap();
        assert!(overlay.payload(3).is_none());
        assert_eq!(overlay.stage_reuse(3, b"live-node".to_vec()).unwrap(), Some(2));
        assert_eq!(overlay.payload(3), Some(b"live-node".as_slice()));
        let changes = overlay.into_changes();
        assert!(matches!(&changes[..], [PageChange::Overwrite {
            page_id: 3, expected_generation: 8, new_generation: 9, payload,
        }] if payload == b"live-node"));
    }

    #[test]
    fn overlay_rejects_double_free_and_live_write_after_free() {
        let mut overlay = PageOverlay::new(4);
        let mut free_head = None;
        overlay.stage_free_page(2, 6, &mut free_head).unwrap();
        assert_eq!(free_head, Some(2));
        assert!(matches!(
            overlay.stage_free_page(2, 6, &mut free_head),
            Err(BTreeError::Corrupt("página ausente, libre o liberada dos veces en overlay"))
        ));
        assert!(matches!(
            overlay.stage_overwrite(2, 6, 7, b"resurrect".to_vec()),
            Err(BTreeError::Corrupt("transición de estado o generación incompatible en overlay"))
        ));
    }

    #[test]
    fn overlay_single_state_rejects_writes_after_freeing_a_page() {
        let mut overlay = PageOverlay::new(4);
        let mut free_head = None;
        overlay.stage_free_page(2, 6, &mut free_head).unwrap();
        assert!(overlay.is_freed(2));
        assert!(matches!(
            overlay.stage_payload(2, 6, b"resurrect".to_vec()),
            Err(BTreeError::Corrupt("no se puede escribir una página libre en overlay"))
        ));
        assert!(overlay.validate().is_ok());
    }

    #[test]
    fn overlay_imports_mbfr_as_an_explicit_freed_state() {
        let mut overlay = PageOverlay::new(4);
        overlay.stage_overwrite(
            2, 6, 7,
            crate::page_reuse::FreePage { next: None }.encode(),
        ).unwrap();
        assert!(overlay.is_freed(2));
        assert!(overlay.payload(2).is_none());
        assert!(overlay.validate().is_ok());
    }

    #[test]
    fn overlay_validation_accepts_a_newly_allocated_page_then_freed() {
        let mut overlay = PageOverlay::new(4);
        let mut free_head = None;
        overlay.stage_allocate(4, 1, b"new-live-node".to_vec()).unwrap();
        overlay.stage_free_page(4, 1, &mut free_head).unwrap();
        assert_eq!(free_head, Some(4));
        assert!(overlay.validate().is_ok());
        assert!(matches!(
            overlay.into_changes().as_slice(),
            [PageChange::Allocate { generation: 1, payload }]
                if payload.starts_with(b"MBFR")
        ));
    }

    #[test]
    fn overlay_reuse_rejects_a_free_marker_as_the_new_live_image() {
        let mut overlay = PageOverlay::new(5);
        overlay.register_free_page(3, 8, None).unwrap();
        assert!(matches!(
            overlay.stage_reuse(3, crate::page_reuse::FreePage { next: None }.encode()),
            Err(BTreeError::Corrupt("una página reutilizada debe recibir una imagen viva, no MBFR"))
        ));
    }

    #[test]
    fn overlay_consumes_a_registered_free_head_and_advances_generation_once() {
        let mut overlay = PageOverlay::new(5);
        overlay.register_free_page(2, 7, Some(3)).unwrap();
        overlay.register_free_page(3, 4, None).unwrap();
        let mut free_head = Some(2);
        assert_eq!(overlay.stage_consume_free_head(&mut free_head, b"live-2".to_vec()).unwrap(), 2);
        assert_eq!(free_head, Some(3));
        assert!(overlay.is_live(2));
        assert!(overlay.validate().is_ok());
        assert!(matches!(
            overlay.into_changes().as_slice(),
            [PageChange::Overwrite { page_id: 2, expected_generation: 7, new_generation: 8, payload }]
                if payload == b"live-2"
        ));
    }

    #[test]
    fn overlay_reuses_a_page_freed_earlier_in_the_same_transaction_without_double_increment() {
        let mut overlay = PageOverlay::new(5);
        let mut free_head = None;
        overlay.stage_overwrite(2, 7, 8, b"old-node".to_vec()).unwrap();
        overlay.stage_free_page(2, 7, &mut free_head).unwrap();
        assert_eq!(free_head, Some(2));
        assert_eq!(overlay.stage_consume_free_head(&mut free_head, b"replacement".to_vec()).unwrap(), 2);
        assert_eq!(free_head, None);
        assert!(overlay.validate().is_ok());
        assert!(matches!(
            overlay.into_changes().as_slice(),
            [PageChange::Overwrite { page_id: 2, expected_generation: 7, new_generation: 8, payload }]
                if payload == b"replacement"
        ));
    }

    #[test]
    fn overlay_free_head_reuse_rejects_generation_overflow_without_mutation() {
        let mut overlay = PageOverlay::new(5);
        overlay.register_free_page(2, u64::MAX, None).unwrap();
        let mut free_head = Some(2);
        assert!(matches!(
            overlay.stage_consume_free_head(&mut free_head, b"live".to_vec()),
            Err(BTreeError::Invalid("generación agotada al reutilizar página"))
        ));
        assert_eq!(free_head, Some(2));
        assert!(overlay.is_reusable(2));
        assert!(overlay.validate().is_ok());
    }

    #[test]
    fn overlay_reuses_a_new_allocation_freed_and_consumed_in_one_transaction() {
        let mut overlay = PageOverlay::new(5);
        let mut free_head = None;
        overlay.stage_allocate(5, 1, b"temporary".to_vec()).unwrap();
        overlay.stage_free_page(5, 1, &mut free_head).unwrap();
        assert_eq!(free_head, Some(5));
        assert_eq!(overlay.stage_consume_free_head(&mut free_head, b"final-node".to_vec()).unwrap(), 5);
        assert_eq!(free_head, None);
        assert!(overlay.validate().is_ok());
        assert!(matches!(
            overlay.into_changes().as_slice(),
            [PageChange::Allocate { generation: 1, payload }]
                if payload == b"final-node"
        ));
    }

    #[test]
    fn overlay_rejects_consuming_an_unregistered_free_head() {
        let mut overlay = PageOverlay::new(5);
        let mut free_head = Some(3);
        assert!(matches!(
            overlay.stage_consume_free_head(&mut free_head, b"live".to_vec()),
            Err(BTreeError::Corrupt("free_head no identifica una página libre registrada en overlay"))
        ));
        assert_eq!(free_head, Some(3));
    }

    #[test]
    fn overlay_validation_rejects_cycles_in_staged_free_pages() {
        let mut overlay = PageOverlay::new(5);
        overlay.register_free_page(2, 4, Some(3)).unwrap();
        overlay.register_free_page(3, 5, Some(2)).unwrap();
        assert!(matches!(
            overlay.validate(),
            Err(BTreeError::Corrupt("ciclo en enlaces de páginas libres staged"))
        ));
    }

    #[test]
    fn overlay_rejects_a_free_list_link_to_a_reused_live_page() {
        let mut overlay = PageOverlay::new(5);
        overlay.register_free_page(2, 4, None).unwrap();
        overlay.register_free_page(3, 5, Some(2)).unwrap();
        overlay.stage_reuse(2, b"live-node".to_vec()).unwrap();
        assert!(matches!(
            overlay.validate(),
            Err(BTreeError::Corrupt("estado de página reutilizable inválido"))
        ));
    }

    #[test]
    fn free_list_validation_rejects_staged_link_to_unstaged_physical_live_page() {
        let (p, w) = paths();
        let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
        let mut overlay = PageOverlay::new(3);
        // La página libre staged 2 enlaza con la raíz hoja física 1.
        // El overlay por sí solo no puede saber que el destino es una hoja.
        overlay.register_free_page(2, 1, Some(1)).unwrap();
        assert!(matches!(
            tree.validate_free_list_overlay(&overlay, Some(2)),
            Err(BTreeError::Corrupt("enlace libre no apunta a una página MBFR válida"))
        ));
        drop(tree);
        cleanup(&p, &w);
    }

    #[test]
    fn overlay_rejects_metadata_free_head_that_points_to_a_live_page() {
        let mut overlay = PageOverlay::new(4);
        overlay.stage_overwrite(
            0, 1, 2,
            encode_meta(&RootMeta { root_id: 1, level: 0, free_head: Some(2) }),
        ).unwrap();
        overlay.stage_overwrite(2, 3, 4, b"live-node".to_vec()).unwrap();
        assert!(matches!(
            overlay.validate(),
            Err(BTreeError::Corrupt("metadata staged referencia raíz o free_head inválidos"))
        ));
    }

    #[test]
    fn overlay_rejects_incompatible_generations_for_the_same_page() {
        let mut overlay = PageOverlay::new(4);
        overlay.stage_overwrite(2, 6, 7, b"first-image".to_vec()).unwrap();
        assert!(matches!(
            overlay.stage_overwrite(2, 7, 8, b"second-image".to_vec()),
            Err(BTreeError::Corrupt("transición de estado o generación incompatible en overlay"))
        ));
        assert!(overlay.validate().is_ok());
    }

    #[test]
    fn overlay_allocations_must_be_contiguous_and_start_at_generation_one() {
        let mut overlay = PageOverlay::new(4);
        assert!(matches!(
            overlay.stage_allocate(5, 1, b"gap".to_vec()),
            Err(BTreeError::Corrupt("asignación staged no contigua o con generación inicial inválida"))
        ));
        assert!(matches!(
            overlay.stage_allocate(4, 2, b"bad-generation".to_vec()),
            Err(BTreeError::Corrupt("asignación staged no contigua o con generación inicial inválida"))
        ));
        overlay.stage_overwrite(1, 3, 4, b"updated-existing".to_vec()).unwrap();
        overlay.stage_allocate(4, 1, b"first".to_vec()).unwrap();
        overlay.stage_allocate(5, 1, b"second".to_vec()).unwrap();
        assert_eq!(overlay.logical_page_count(), 6);
        let changes = overlay.into_changes();
        assert!(matches!(&changes[..], [
            PageChange::Overwrite { page_id: 1, expected_generation: 3, new_generation: 4, payload },
            PageChange::Allocate { generation: 1, payload: first },
            PageChange::Allocate { generation: 1, payload: second },
        ] if payload == b"updated-existing" && first == b"first" && second == b"second"));
    }

    #[test]
    fn overlay_uses_staged_metadata_to_follow_a_new_root() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let old_root = tree.root_page_id();
            let allocated_root = tree.pages.page_count();
            let root_node = BTreeNode::Internal {
                level: 1,
                first_child: old_root,
                entries: Vec::new(),
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            overlay.stage_allocate(allocated_root, 1, encode_node(&root_node).unwrap()).unwrap();
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta {
                    root_id: allocated_root,
                    level: 1,
                    free_head: tree.root.free_head,
                }),
            ).unwrap();

            let location = tree.resolve_parent_with_overlay(old_root, &overlay).unwrap().unwrap();
            assert_eq!(location.parent_id, allocated_root);
            assert_eq!(location.parent_level, 1);
            assert_eq!(location.child_index, 0);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn overlay_parent_resolution_rejects_registered_free_child() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            for key in [b"a".as_slice(), b"b".as_slice(), b"c".as_slice()] {
                tree.insert(key.to_vec(), vec![3; 1500]).unwrap();
            }
            let root_id = tree.root_page_id();
            let root_page = tree.pages.read(root_id).unwrap();
            let BTreeNode::Internal { first_child, .. } =
                BTreeNode::decode(&root_page.payload).unwrap() else {
                    panic!("la raíz de prueba debe ser interna");
                };
            let child_page = tree.pages.read(first_child).unwrap();
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            overlay.register_free_page(first_child, child_page.generation, None).unwrap();
            assert!(matches!(
                tree.resolve_parent_with_overlay(first_child, &overlay),
                Err(BTreeError::Corrupt("página ausente o libre referenciada en overlay"))
            ));
            assert!(matches!(
                overlay.register_free_page(first_child, child_page.generation, None),
                Err(BTreeError::Corrupt("registro MBFR inválido en overlay"))
            ));
        }
        cleanup(&p, &w);
    }

    #[test]
    fn internal_rebalance_plan_stages_all_nodes_and_parent_in_one_overlay() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            let deficient_id = 2;
            let donor_id = 3;
            let parent_id = 4;
            let deficient = BTreeNode::Internal {
                level: 1,
                first_child: 10,
                entries: Vec::new(),
            };
            let donor_entries = vec![
                InternalEntry { separator: b"m".to_vec(), right_child: 20 },
                InternalEntry { separator: b"z".to_vec(), right_child: 30 },
            ];
            let donor = BTreeNode::Internal {
                level: 1,
                first_child: 11,
                entries: donor_entries.clone(),
            };
            let parent = BTreeNode::Internal {
                level: 2,
                first_child: deficient_id,
                entries: vec![InternalEntry { separator: b"h".to_vec(), right_child: donor_id }],
            };
            overlay.stage_allocate(deficient_id, 1, encode_node(&deficient).unwrap()).unwrap();
            overlay.stage_allocate(donor_id, 1, encode_node(&donor).unwrap()).unwrap();
            overlay.stage_allocate(parent_id, 1, encode_node(&parent).unwrap()).unwrap();

            let plan = plan_internal_rebalance(
                deficient_id,
                vec![InternalEntry { separator: b"h".to_vec(), right_child: donor_id }],
                0,
                deficient_id,
                1,
                10,
                Vec::new(),
                None,
                Some((donor_id, 11, donor_entries)),
            ).unwrap();

            let mut free_head = None;
            tree.stage_internal_rebalance_plan_overlay(
                parent_id,
                2,
                deficient_id,
                plan,
                &mut overlay,
                &mut free_head,
            ).unwrap();
            let changes = overlay.into_changes();
            assert_eq!(changes.len(), 3);
            let PageChange::Allocate { payload: parent_payload, .. } = &changes[2] else {
                panic!("el padre staged debe conservar su asignación");
            };
            let BTreeNode::Internal { entries, .. } = BTreeNode::decode(parent_payload).unwrap() else {
                panic!("la imagen del padre debe ser interna");
            };
            assert_eq!(entries[0].separator, b"m");
            assert_eq!(free_head, None);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn overlay_coalesces_live_updates_before_freeing_the_same_page() {
        let mut overlay = PageOverlay::new(4);
        overlay.stage_payload(2, 6, b"intermediate-node".to_vec()).unwrap();
        overlay.stage_payload(2, 6, b"final-node".to_vec()).unwrap();
        let mut free_head = None;
        overlay.stage_free_page(2, 6, &mut free_head).unwrap();
        let changes = overlay.into_changes();
        assert_eq!(free_head, Some(2));
        assert!(matches!(&changes[..], [PageChange::Overwrite {
            page_id: 2, expected_generation: 6, new_generation: 7, payload,
        }] if crate::page_reuse::FreePage::decode(payload).unwrap().next.is_none()));
    }

    #[test]
    fn internal_merge_plan_stages_survivor_parent_and_freed_page_atomically() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let deficient_id = 2;
            let donor_id = 3;
            let parent_id = 4;
            let deficient = BTreeNode::Internal {
                level: 1,
                first_child: 10,
                entries: Vec::new(),
            };
            let donor_entries = vec![
                InternalEntry { separator: b"m".to_vec(), right_child: 20 },
            ];
            let donor = BTreeNode::Internal {
                level: 1,
                first_child: 11,
                entries: donor_entries.clone(),
            };
            let parent = BTreeNode::Internal {
                level: 2,
                first_child: deficient_id,
                entries: vec![InternalEntry { separator: b"h".to_vec(), right_child: donor_id }],
            };
            tree.pages.transaction(vec![
                PageChange::Allocate { generation: 1, payload: encode_node(&deficient).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&donor).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&parent).unwrap() },
            ]).unwrap();

            let mut overlay = PageOverlay::new(tree.pages.page_count());
            let plan = plan_internal_rebalance(
                deficient_id,
                vec![InternalEntry { separator: b"h".to_vec(), right_child: donor_id }],
                0,
                deficient_id,
                1,
                10,
                Vec::new(),
                None,
                Some((donor_id, 11, donor_entries)),
            ).unwrap();
            let mut free_head = None;
            tree.stage_internal_rebalance_plan_overlay(
                parent_id, 2, deficient_id, plan, &mut overlay, &mut free_head,
            ).unwrap();

            let changes = overlay.into_changes();
            assert_eq!(changes.len(), 3);
            assert_eq!(free_head, Some(donor_id));
            let PageChange::Overwrite { payload: freed_payload, .. } = &changes[1] else {
                panic!("la página donante debe quedar liberada");
            };
            assert_eq!(crate::page_reuse::FreePage::decode(freed_payload).unwrap().next, None);
            let PageChange::Overwrite { payload: survivor_payload, .. } = &changes[0] else {
                panic!("el superviviente debe quedar actualizado");
            };
            let BTreeNode::Internal { entries, .. } = BTreeNode::decode(survivor_payload).unwrap() else {
                panic!("el superviviente debe seguir siendo interno");
            };
            assert_eq!(entries.len(), 2);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn descending_repair_borrows_from_right_internal_sibling_and_updates_parent() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let deficient_id = 6;
            let donor_id = 7;
            let parent_id = 8;
            let deficient = BTreeNode::Internal {
                level: 1,
                first_child: 2,
                entries: Vec::new(),
            };
            let donor = BTreeNode::Internal {
                level: 1,
                first_child: 3,
                entries: vec![
                    InternalEntry { separator: b"m".to_vec(), right_child: 4 },
                    InternalEntry { separator: b"z".to_vec(), right_child: 5 },
                ],
            };
            let parent = BTreeNode::Internal {
                level: 2,
                first_child: deficient_id,
                entries: vec![InternalEntry { separator: b"h".to_vec(), right_child: donor_id }],
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            for leaf_id in 2..=5 {
                overlay.stage_allocate(
                    leaf_id, 1,
                    encode_node(&BTreeNode::Leaf { next_leaf: None, entries: Vec::new() }).unwrap(),
                ).unwrap();
            }
            overlay.stage_allocate(deficient_id, 1, encode_node(&deficient).unwrap()).unwrap();
            overlay.stage_allocate(donor_id, 1, encode_node(&donor).unwrap()).unwrap();
            overlay.stage_allocate(parent_id, 1, encode_node(&parent).unwrap()).unwrap();
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id: parent_id, level: 2, free_head: None }),
            ).unwrap();

            let mut free_head = None;
            assert_eq!(
                tree.repair_descending_internal_underflows(&[deficient_id], &mut overlay, &mut free_head).unwrap(),
                1
            );
            assert_eq!(free_head, None);
            let BTreeNode::Internal { entries: parent_entries, .. } =
                BTreeNode::decode(overlay.payload(parent_id).unwrap()).unwrap() else {
                    panic!("el padre staged debe ser interno");
                };
            assert_eq!(parent_entries[0].separator, b"m");
            let BTreeNode::Internal { first_child, entries: repaired_entries, .. } =
                BTreeNode::decode(overlay.payload(deficient_id).unwrap()).unwrap() else {
                    panic!("el nodo reparado debe ser interno");
                };
            assert_eq!(first_child, 2);
            assert_eq!(repaired_entries.len(), 1);
            assert_eq!(repaired_entries[0].separator, b"h");
            assert_eq!(repaired_entries[0].right_child, 3);
            let BTreeNode::Internal { first_child: donor_first, entries: donor_after, .. } =
                BTreeNode::decode(overlay.payload(donor_id).unwrap()).unwrap() else {
                    panic!("el donante debe seguir siendo interno");
                };
            assert_eq!(donor_first, 4);
            assert_eq!(donor_after.len(), 1);
            assert_eq!(donor_after[0].separator, b"z");
        }
        cleanup(&p, &w);
    }

    #[test]
    fn descending_repair_borrows_from_right_for_middle_child_and_preserves_left_sibling() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let left_id = 8;
            let deficient_id = 9;
            let donor_id = 10;
            let parent_id = 11;
            let left = BTreeNode::Internal {
                level: 1,
                first_child: 2,
                entries: vec![InternalEntry { separator: b"d".to_vec(), right_child: 3 }],
            };
            let deficient = BTreeNode::Internal {
                level: 1,
                first_child: 4,
                entries: Vec::new(),
            };
            let donor = BTreeNode::Internal {
                level: 1,
                first_child: 5,
                entries: vec![
                    InternalEntry { separator: b"m".to_vec(), right_child: 6 },
                    InternalEntry { separator: b"z".to_vec(), right_child: 7 },
                ],
            };
            let parent = BTreeNode::Internal {
                level: 2,
                first_child: left_id,
                entries: vec![
                    InternalEntry { separator: b"h".to_vec(), right_child: deficient_id },
                    InternalEntry { separator: b"t".to_vec(), right_child: donor_id },
                ],
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            for leaf_id in 2..=7 {
                overlay.stage_allocate(
                    leaf_id, 1,
                    encode_node(&BTreeNode::Leaf { next_leaf: None, entries: Vec::new() }).unwrap(),
                ).unwrap();
            }
            overlay.stage_allocate(left_id, 1, encode_node(&left).unwrap()).unwrap();
            overlay.stage_allocate(deficient_id, 1, encode_node(&deficient).unwrap()).unwrap();
            overlay.stage_allocate(donor_id, 1, encode_node(&donor).unwrap()).unwrap();
            overlay.stage_allocate(parent_id, 1, encode_node(&parent).unwrap()).unwrap();
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id: parent_id, level: 2, free_head: None }),
            ).unwrap();

            let mut free_head = None;
            assert_eq!(
                tree.repair_descending_internal_underflows(
                    &[deficient_id], &mut overlay, &mut free_head,
                ).unwrap(),
                1
            );
            assert_eq!(free_head, None);

            let BTreeNode::Internal { entries: parent_after, .. } =
                BTreeNode::decode(overlay.payload(parent_id).unwrap()).unwrap() else {
                    panic!("el padre debe seguir siendo interno");
                };
            assert_eq!(parent_after.len(), 2);
            assert_eq!(parent_after[0].separator, b"h");
            assert_eq!(parent_after[1].separator, b"m");

            let BTreeNode::Internal { first_child, entries: repaired, .. } =
                BTreeNode::decode(overlay.payload(deficient_id).unwrap()).unwrap() else {
                    panic!("el hijo medio debe quedar reparado");
                };
            assert_eq!(first_child, 4);
            assert_eq!(repaired.len(), 1);
            assert_eq!(repaired[0].separator, b"t");
            assert_eq!(repaired[0].right_child, 5);

            let BTreeNode::Internal { first_child: donor_first, entries: donor_after, .. } =
                BTreeNode::decode(overlay.payload(donor_id).unwrap()).unwrap() else {
                    panic!("el donante derecho debe seguir siendo interno");
                };
            assert_eq!(donor_first, 6);
            assert_eq!(donor_after.len(), 1);
            assert_eq!(donor_after[0].separator, b"z");

            let BTreeNode::Internal { entries: left_after, .. } =
                BTreeNode::decode(overlay.payload(left_id).unwrap()).unwrap() else {
                    panic!("el hermano izquierdo debe permanecer interno");
                };
            assert_eq!(left_after, vec![InternalEntry {
                separator: b"d".to_vec(), right_child: 3,
            }]);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn descending_repair_borrows_from_left_for_middle_child_and_preserves_right_sibling() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let left_id = 8;
            let deficient_id = 9;
            let right_id = 10;
            let parent_id = 11;
            let donor = BTreeNode::Internal {
                level: 1,
                first_child: 2,
                entries: vec![
                    InternalEntry { separator: b"d".to_vec(), right_child: 3 },
                    InternalEntry { separator: b"m".to_vec(), right_child: 4 },
                ],
            };
            let deficient = BTreeNode::Internal {
                level: 1,
                first_child: 5,
                entries: Vec::new(),
            };
            let right = BTreeNode::Internal {
                level: 1,
                first_child: 6,
                entries: vec![InternalEntry { separator: b"z".to_vec(), right_child: 7 }],
            };
            let parent = BTreeNode::Internal {
                level: 2,
                first_child: left_id,
                entries: vec![
                    InternalEntry { separator: b"h".to_vec(), right_child: deficient_id },
                    InternalEntry { separator: b"t".to_vec(), right_child: right_id },
                ],
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            for leaf_id in 2..=7 {
                overlay.stage_allocate(
                    leaf_id, 1,
                    encode_node(&BTreeNode::Leaf { next_leaf: None, entries: Vec::new() }).unwrap(),
                ).unwrap();
            }
            overlay.stage_allocate(left_id, 1, encode_node(&donor).unwrap()).unwrap();
            overlay.stage_allocate(deficient_id, 1, encode_node(&deficient).unwrap()).unwrap();
            overlay.stage_allocate(right_id, 1, encode_node(&right).unwrap()).unwrap();
            overlay.stage_allocate(parent_id, 1, encode_node(&parent).unwrap()).unwrap();
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id: parent_id, level: 2, free_head: None }),
            ).unwrap();

            let mut free_head = None;
            assert_eq!(
                tree.repair_descending_internal_underflows(
                    &[deficient_id], &mut overlay, &mut free_head,
                ).unwrap(),
                1
            );
            assert_eq!(free_head, None);

            let BTreeNode::Internal { entries: parent_after, .. } =
                BTreeNode::decode(overlay.payload(parent_id).unwrap()).unwrap() else {
                    panic!("el padre debe seguir siendo interno");
                };
            assert_eq!(parent_after[0].separator, b"m");
            assert_eq!(parent_after[1].separator, b"t");

            let BTreeNode::Internal { first_child, entries: repaired, .. } =
                BTreeNode::decode(overlay.payload(deficient_id).unwrap()).unwrap() else {
                    panic!("el hijo medio debe quedar reparado");
                };
            assert_eq!(first_child, 4);
            assert_eq!(repaired.len(), 1);
            assert_eq!(repaired[0].separator, b"h");
            assert_eq!(repaired[0].right_child, 5);

            let BTreeNode::Internal { entries: left_after, .. } =
                BTreeNode::decode(overlay.payload(left_id).unwrap()).unwrap() else {
                    panic!("el donante izquierdo debe seguir siendo interno");
                };
            assert_eq!(left_after, vec![InternalEntry {
                separator: b"d".to_vec(), right_child: 3,
            }]);

            let BTreeNode::Internal { first_child: right_first, entries: right_after, .. } =
                BTreeNode::decode(overlay.payload(right_id).unwrap()).unwrap() else {
                    panic!("el hermano derecho debe permanecer interno");
                };
            assert_eq!(right_first, 6);
            assert_eq!(right_after, vec![InternalEntry {
                separator: b"z".to_vec(), right_child: 7,
            }]);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn descending_repair_merges_middle_internal_child_into_left_sibling() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let left_id = 8;
            let deficient_id = 9;
            let right_id = 10;
            let parent_id = 11;
            let left = BTreeNode::Internal {
                level: 1,
                first_child: 2,
                entries: vec![InternalEntry { separator: b"d".to_vec(), right_child: 3 }],
            };
            let deficient = BTreeNode::Internal {
                level: 1,
                first_child: 4,
                entries: Vec::new(),
            };
            let right = BTreeNode::Internal {
                level: 1,
                first_child: 5,
                entries: vec![InternalEntry { separator: b"z".to_vec(), right_child: 6 }],
            };
            let parent = BTreeNode::Internal {
                level: 2,
                first_child: left_id,
                entries: vec![
                    InternalEntry { separator: b"h".to_vec(), right_child: deficient_id },
                    InternalEntry { separator: b"t".to_vec(), right_child: right_id },
                ],
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            for leaf_id in 2..=6 {
                overlay.stage_allocate(
                    leaf_id, 1,
                    encode_node(&BTreeNode::Leaf { next_leaf: None, entries: Vec::new() }).unwrap(),
                ).unwrap();
            }
            overlay.stage_allocate(left_id, 1, encode_node(&left).unwrap()).unwrap();
            overlay.stage_allocate(deficient_id, 1, encode_node(&deficient).unwrap()).unwrap();
            overlay.stage_allocate(right_id, 1, encode_node(&right).unwrap()).unwrap();
            overlay.stage_allocate(parent_id, 1, encode_node(&parent).unwrap()).unwrap();
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id: parent_id, level: 2, free_head: None }),
            ).unwrap();

            let mut free_head = None;
            assert_eq!(
                tree.repair_descending_internal_underflows(
                    &[deficient_id], &mut overlay, &mut free_head,
                ).unwrap(),
                1
            );
            assert_eq!(free_head, Some(deficient_id));
            assert!(overlay.payload(deficient_id).is_none());

            let BTreeNode::Internal { entries: parent_after, .. } =
                BTreeNode::decode(overlay.payload(parent_id).unwrap()).unwrap() else {
                    panic!("el padre debe seguir siendo interno");
                };
            assert_eq!(parent_after, vec![InternalEntry {
                separator: b"t".to_vec(), right_child: right_id,
            }]);

            let BTreeNode::Internal { entries: merged, .. } =
                BTreeNode::decode(overlay.payload(left_id).unwrap()).unwrap() else {
                    panic!("el superviviente izquierdo debe seguir siendo interno");
                };
            assert_eq!(merged, vec![
                InternalEntry { separator: b"d".to_vec(), right_child: 3 },
                InternalEntry { separator: b"h".to_vec(), right_child: 4 },
            ]);

            let BTreeNode::Internal { entries: right_after, .. } =
                BTreeNode::decode(overlay.payload(right_id).unwrap()).unwrap() else {
                    panic!("el hermano derecho debe permanecer interno");
                };
            assert_eq!(right_after, vec![InternalEntry {
                separator: b"z".to_vec(), right_child: 6,
            }]);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn descending_repair_merges_first_internal_child_into_right_and_contracts_root() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let left_leaf = BTreeNode::Leaf {
                next_leaf: Some(3),
                entries: vec![LeafEntry { key: b"a".to_vec(), value: b"left".to_vec() }],
            };
            let right_leaf = BTreeNode::Leaf {
                next_leaf: None,
                entries: vec![LeafEntry { key: b"z".to_vec(), value: b"right".to_vec() }],
            };
            let deficient = BTreeNode::Internal {
                level: 1,
                first_child: 2,
                entries: Vec::new(),
            };
            let right = BTreeNode::Internal {
                level: 1,
                first_child: 3,
                entries: Vec::new(),
            };
            let root = BTreeNode::Internal {
                level: 2,
                first_child: 4,
                entries: vec![InternalEntry { separator: b"h".to_vec(), right_child: 5 }],
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            for (id, node) in [
                (2, &left_leaf),
                (3, &right_leaf),
                (4, &deficient),
                (5, &right),
                (6, &root),
            ] {
                overlay.stage_allocate(id, 1, encode_node(node).unwrap()).unwrap();
            }
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id: 6, level: 2, free_head: None }),
            ).unwrap();

            let mut free_head = None;
            // La hoja raíz inicial (página 1) deja de pertenecer al árbol
            // artificial del escenario y debe quedar contabilizada en MBFR.
            overlay.stage_free_page(1, 1, &mut free_head).unwrap();
            assert_eq!(
                tree.repair_descending_internal_underflows(&[4], &mut overlay, &mut free_head).unwrap(),
                1
            );
            assert_eq!(free_head, Some(6));
            let metadata = decode_meta(overlay.payload(0).unwrap()).unwrap();
            assert_eq!(metadata.root_id, 4);
            assert_eq!(metadata.level, 1);
            assert_eq!(metadata.free_head, Some(6));

            let BTreeNode::Internal { level, first_child, entries } =
                BTreeNode::decode(overlay.payload(4).unwrap()).unwrap() else {
                    panic!("el primer hijo debe sobrevivir como nodo interno");
                };
            assert_eq!(level, 1);
            assert_eq!(first_child, 2);
            assert_eq!(entries, vec![InternalEntry {
                separator: b"h".to_vec(),
                right_child: 3,
            }]);
            assert!(overlay.is_freed(5));
            assert!(overlay.is_freed(6));
            assert!(matches!(
                overlay.pages.get(&6),
                Some(OverlayPageState::FreedAllocated { next: Some(5), .. })
            ));
            assert!(matches!(
                overlay.pages.get(&5),
                Some(OverlayPageState::FreedAllocated { next: Some(1), .. })
            ));
            assert!(matches!(
                overlay.pages.get(&1),
                Some(OverlayPageState::FreedExisting { next: None, .. })
            ));
            overlay.validate().unwrap();

            let changes = overlay.into_changes();
            tree.pages.transaction(changes).unwrap();
            tree.root = RootMeta { root_id: 4, level: 1, free_head };
            tree.meta_generation += 1;
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 2);
            assert_eq!(report.free_pages, 3);
            assert_eq!(tree.get(b"a").unwrap(), Some(b"left".to_vec()));
            assert_eq!(tree.get(b"z").unwrap(), Some(b"right".to_vec()));
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.height(), 1);
            assert_eq!(reopened.get(b"a").unwrap(), Some(b"left".to_vec()));
            assert_eq!(reopened.get(b"z").unwrap(), Some(b"right".to_vec()));
            let report = reopened.validate().unwrap();
            assert_eq!(report.entries, 2);
            assert_eq!(report.free_pages, 3);
            assert_eq!(reopened.root.free_head, Some(6));

            // La primera página liberada debe reutilizarse al dividir una hoja,
            // sin ampliar el archivo y conservando el resto de la cadena MBFR.
            let page_count = reopened.page_count();
            let large_value = vec![0x6b; 4039];
            reopened.insert(b"b".to_vec(), large_value.clone()).unwrap();
            assert_eq!(reopened.page_count(), page_count);
            assert_eq!(reopened.get(b"b").unwrap(), Some(large_value));
            let after_reuse = reopened.validate().unwrap();
            assert_eq!(after_reuse.entries, 3);
            assert_eq!(after_reuse.free_pages, 2);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.get(b"a").unwrap(), Some(b"left".to_vec()));
            assert_eq!(reopened.get(b"b").unwrap(), Some(vec![0x6b; 4039]));
            assert_eq!(reopened.get(b"z").unwrap(), Some(b"right".to_vec()));
            assert_eq!(reopened.validate().unwrap().free_pages, 2);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn descending_repair_chains_multiple_internal_merges_in_one_free_list() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let internal_ids = [6, 7, 8, 9];
            let root_id = 10;
            let internals = internal_ids.iter().enumerate().map(|(index, _)| BTreeNode::Internal {
                level: 1,
                first_child: 2 + index as u64,
                entries: Vec::new(),
            }).collect::<Vec<_>>();
            let root = BTreeNode::Internal {
                level: 2,
                first_child: internal_ids[0],
                entries: vec![
                    InternalEntry { separator: b"b".to_vec(), right_child: internal_ids[1] },
                    InternalEntry { separator: b"g".to_vec(), right_child: internal_ids[2] },
                    InternalEntry { separator: b"m".to_vec(), right_child: internal_ids[3] },
                ],
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            let leaf_specs = [
                (2, b"a".as_slice(), Some(3)),
                (3, b"b".as_slice(), Some(4)),
                (4, b"g".as_slice(), Some(5)),
                (5, b"m".as_slice(), None),
            ];
            for (leaf_id, key, next_leaf) in leaf_specs {
                overlay.stage_allocate(
                    leaf_id, 1,
                    encode_node(&BTreeNode::Leaf {
                        next_leaf,
                        entries: vec![LeafEntry { key: key.to_vec(), value: vec![1] }],
                    }).unwrap(),
                ).unwrap();
            }
            for (id, node) in internal_ids.into_iter().zip(internals.iter()) {
                overlay.stage_allocate(id, 1, encode_node(node).unwrap()).unwrap();
            }
            overlay.stage_allocate(root_id, 1, encode_node(&root).unwrap()).unwrap();
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id, level: 2, free_head: None }),
            ).unwrap();

            let mut free_head = None;
            overlay.stage_free_page(1, 1, &mut free_head).unwrap();
            assert_eq!(
                tree.repair_descending_internal_underflows(
                    &[internal_ids[0], internal_ids[2]],
                    &mut overlay,
                    &mut free_head,
                ).unwrap(),
                2
            );
            assert_eq!(free_head, Some(internal_ids[2]));
            assert!(overlay.is_freed(internal_ids[1]));
            assert!(overlay.is_freed(internal_ids[2]));

            let metadata_generation = overlay.expected_generation(0).unwrap();
            overlay.stage_payload(
                0,
                metadata_generation,
                encode_meta(&RootMeta {
                    root_id,
                    level: 2,
                    free_head,
                }),
            ).unwrap();
            overlay.validate().unwrap();

            let base_page_count = tree.pages.page_count();
            let changes = overlay.into_changes();
            let mut free_images = BTreeMap::new();
            let mut payloads = BTreeMap::new();
            let mut next_allocated_id = base_page_count;
            for change in &changes {
                let (page_id, payload) = match change {
                    PageChange::Overwrite { page_id, payload, .. } => (*page_id, payload.clone()),
                    PageChange::Allocate { payload, .. } => {
                        let page_id = next_allocated_id;
                        next_allocated_id += 1;
                        (page_id, payload.clone())
                    }
                };
                if payload.starts_with(b"MBFR") {
                    let free = crate::page_reuse::FreePage::decode(&payload).unwrap();
                    free_images.insert(page_id, free.next);
                }
                payloads.insert(page_id, payload);
            }
            assert_eq!(free_images.get(&internal_ids[2]), Some(&Some(internal_ids[1])));
            assert_eq!(free_images.get(&internal_ids[1]), Some(&Some(1)));
            assert_eq!(free_images.get(&1), Some(&None));

            let BTreeNode::Internal { entries: root_entries, .. } =
                BTreeNode::decode(payloads.get(&root_id).unwrap()).unwrap() else {
                    panic!("la raíz debe seguir siendo interna");
                };
            assert_eq!(root_entries, vec![InternalEntry {
                separator: b"m".to_vec(),
                right_child: internal_ids[3],
            }]);

            let BTreeNode::Internal { entries: survivor_entries, .. } =
                BTreeNode::decode(payloads.get(&internal_ids[0]).unwrap()).unwrap() else {
                    panic!("el primer nodo debe sobrevivir a ambas fusiones");
                };
            assert_eq!(survivor_entries, vec![
                InternalEntry { separator: b"b".to_vec(), right_child: 3 },
                InternalEntry { separator: b"g".to_vec(), right_child: 4 },
            ]);

            tree.pages.transaction(changes).unwrap();
            tree.root = RootMeta { root_id, level: 2, free_head };
            tree.meta_generation += 1;
            assert_eq!(tree.validate().unwrap().entries, 4);
            assert_eq!(tree.validate().unwrap().free_pages, 3);
            let page_count_before_reuse = tree.pages.page_count();
            let large_value = vec![9; 4039];
            tree.insert(b"0".to_vec(), large_value.clone()).unwrap();
            assert_eq!(tree.pages.page_count(), page_count_before_reuse);
            assert_eq!(tree.root.free_head, Some(internal_ids[1]));
            assert_eq!(tree.get(b"0").unwrap(), Some(large_value));
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 5);
            assert_eq!(report.free_pages, 2);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.get(b"0").unwrap(), Some(vec![9; 4039]));
            assert_eq!(reopened.get(b"a").unwrap(), Some(vec![1]));
            assert_eq!(reopened.get(b"b").unwrap(), Some(vec![1]));
            assert_eq!(reopened.get(b"g").unwrap(), Some(vec![1]));
            assert_eq!(reopened.get(b"m").unwrap(), Some(vec![1]));
            let report = reopened.validate().unwrap();
            assert_eq!(report.entries, 5);
            assert_eq!(report.free_pages, 2);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn descending_repair_cascades_three_levels_and_reuses_freed_root_after_reopen() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let leaf_a = 2;
            let leaf_g = 3;
            let leaf_m = 4;
            let node_a = 5;
            let node_b = 6;
            let node_c = 7;
            let parent_p = 8;
            let parent_q = 9;
            let root_id = 10;
            let leaf = |key: &[u8], next_leaf| BTreeNode::Leaf {
                next_leaf,
                entries: vec![LeafEntry { key: key.to_vec(), value: vec![1] }],
            };
            let node = |first_child| BTreeNode::Internal {
                level: 1,
                first_child,
                entries: Vec::new(),
            };
            let parent = BTreeNode::Internal {
                level: 2,
                first_child: node_a,
                entries: vec![InternalEntry { separator: b"g".to_vec(), right_child: node_b }],
            };
            let sibling_parent = BTreeNode::Internal {
                level: 2,
                first_child: node_c,
                entries: Vec::new(),
            };
            let root = BTreeNode::Internal {
                level: 3,
                first_child: parent_p,
                entries: vec![InternalEntry { separator: b"m".to_vec(), right_child: parent_q }],
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            for (id, payload) in [
                (leaf_a, encode_node(&leaf(b"a", Some(leaf_g))).unwrap()),
                (leaf_g, encode_node(&leaf(b"g", Some(leaf_m))).unwrap()),
                (leaf_m, encode_node(&leaf(b"m", None)).unwrap()),
                (node_a, encode_node(&node(leaf_a)).unwrap()),
                (node_b, encode_node(&node(leaf_g)).unwrap()),
                (node_c, encode_node(&node(leaf_m)).unwrap()),
                (parent_p, encode_node(&parent).unwrap()),
                (parent_q, encode_node(&sibling_parent).unwrap()),
                (root_id, encode_node(&root).unwrap()),
            ] {
                overlay.stage_allocate(id, 1, payload).unwrap();
            }
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id, level: 3, free_head: None }),
            ).unwrap();

            let mut free_head = None;
            overlay.stage_free_page(1, 1, &mut free_head).unwrap();
            assert_eq!(
                tree.repair_descending_internal_underflows(
                    &[root_id, parent_p, node_a, parent_q, node_b, node_a, root_id],
                    &mut overlay,
                    &mut free_head,
                ).unwrap(),
                2
            );
            assert_eq!(free_head, Some(root_id));
            assert!(overlay.is_freed(node_b));
            assert!(overlay.is_freed(parent_q));
            assert!(overlay.is_freed(root_id));
            assert!(!overlay.is_live(node_b));
            assert!(!overlay.is_live(parent_q));
            assert!(!overlay.is_live(root_id));

            let metadata_generation = overlay.expected_generation(0).unwrap();
            overlay.stage_payload(
                0,
                metadata_generation,
                encode_meta(&RootMeta { root_id: parent_p, level: 2, free_head }),
            ).unwrap();
            overlay.validate().unwrap();

            let base_page_count = tree.pages.page_count();
            let changes = overlay.into_changes();
            let mut next_allocated_id = base_page_count;
            let mut payloads = BTreeMap::new();
            for change in &changes {
                let (id, payload) = match change {
                    PageChange::Overwrite { page_id, payload, .. } => (*page_id, payload.clone()),
                    PageChange::Allocate { payload, .. } => {
                        let id = next_allocated_id;
                        next_allocated_id += 1;
                        (id, payload.clone())
                    }
                };
                payloads.insert(id, payload);
            }
            assert_eq!(
                crate::page_reuse::FreePage::decode(payloads.get(&root_id).unwrap()).unwrap().next,
                Some(parent_q)
            );
            assert_eq!(
                crate::page_reuse::FreePage::decode(payloads.get(&parent_q).unwrap()).unwrap().next,
                Some(node_b)
            );
            assert_eq!(
                crate::page_reuse::FreePage::decode(payloads.get(&node_b).unwrap()).unwrap().next,
                Some(1)
            );
            assert_eq!(
                crate::page_reuse::FreePage::decode(payloads.get(&1).unwrap()).unwrap().next,
                None
            );

            let BTreeNode::Internal { level, first_child, entries } =
                BTreeNode::decode(payloads.get(&parent_p).unwrap()).unwrap() else {
                    panic!("el padre superviviente debe ser interno");
                };
            assert_eq!(level, 2);
            assert_eq!(first_child, node_a);
            assert_eq!(entries, vec![
                InternalEntry { separator: b"m".to_vec(), right_child: node_c },
            ]);

            tree.pages.inject_apply_failure_after_images(2);
            assert!(tree.pages.transaction(changes).is_err());
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.height(), 2);
            assert_eq!(reopened.get(b"a").unwrap(), Some(vec![1]));
            assert_eq!(reopened.get(b"g").unwrap(), Some(vec![1]));
            assert_eq!(reopened.get(b"m").unwrap(), Some(vec![1]));
            let report = reopened.validate().unwrap();
            assert_eq!(report.entries, 3);
            assert_eq!(report.free_pages, 4);

            let page_count_before_reuse = reopened.pages.page_count();
            let large_value = vec![9; 4039];
            reopened.insert(b"0".to_vec(), large_value.clone()).unwrap();
            assert_eq!(reopened.pages.page_count(), page_count_before_reuse);
            assert_eq!(reopened.root.free_head, Some(parent_q));
            assert_eq!(reopened.get(b"0").unwrap(), Some(large_value));
            let report = reopened.validate().unwrap();
            assert_eq!(report.entries, 4);
            assert_eq!(report.free_pages, 3);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.height(), 2);
            assert_eq!(reopened.get(b"0").unwrap(), Some(vec![9; 4039]));
            assert_eq!(reopened.get(b"a").unwrap(), Some(vec![1]));
            assert_eq!(reopened.get(b"g").unwrap(), Some(vec![1]));
            assert_eq!(reopened.get(b"m").unwrap(), Some(vec![1]));
            let report = reopened.validate().unwrap();
            assert_eq!(report.entries, 4);
            assert_eq!(report.free_pages, 3);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn descending_repair_rebalances_unary_internal_node_after_parent_merge() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let deficient_id = 6;
            let donor_id = 7;
            let parent_id = 8;
            let deficient = BTreeNode::Internal {
                level: 1,
                first_child: 2,
                entries: Vec::new(),
            };
            let donor = BTreeNode::Internal {
                level: 1,
                first_child: 3,
                entries: vec![
                    InternalEntry { separator: b"m".to_vec(), right_child: 4 },
                    InternalEntry { separator: b"z".to_vec(), right_child: 5 },
                ],
            };
            let parent = BTreeNode::Internal {
                level: 2,
                first_child: deficient_id,
                entries: vec![InternalEntry { separator: b"h".to_vec(), right_child: donor_id }],
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            for leaf_id in 2..=5 {
                overlay.stage_allocate(
                    leaf_id, 1,
                    encode_node(&BTreeNode::Leaf { next_leaf: None, entries: Vec::new() }).unwrap(),
                ).unwrap();
            }
            overlay.stage_allocate(deficient_id, 1, encode_node(&deficient).unwrap()).unwrap();
            overlay.stage_allocate(donor_id, 1, encode_node(&donor).unwrap()).unwrap();
            overlay.stage_allocate(parent_id, 1, encode_node(&parent).unwrap()).unwrap();
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id: parent_id, level: 2, free_head: None }),
            ).unwrap();

            let mut free_head = None;
            assert_eq!(
                tree.repair_descending_internal_underflows(&[deficient_id], &mut overlay, &mut free_head).unwrap(),
                1
            );
            assert_eq!(free_head, None);
            let BTreeNode::Internal { entries: parent_entries, .. } =
                BTreeNode::decode(overlay.payload(parent_id).unwrap()).unwrap() else {
                    panic!("el padre staged debe ser interno");
                };
            assert_eq!(parent_entries[0].separator, b"m");
            let BTreeNode::Internal { entries: repaired_entries, .. } =
                BTreeNode::decode(overlay.payload(deficient_id).unwrap()).unwrap() else {
                    panic!("el nodo reparado debe ser interno");
                };
            assert_eq!(repaired_entries.len(), 1);
            let BTreeNode::Internal { entries: donor_after, .. } =
                BTreeNode::decode(overlay.payload(donor_id).unwrap()).unwrap() else {
                    panic!("el donante debe seguir siendo interno");
                };
            assert_eq!(donor_after.len(), 1);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn descending_repair_merges_and_frees_a_newly_allocated_sibling() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let deficient_id = 6;
            let donor_id = 7;
            let parent_id = 8;
            let deficient = BTreeNode::Internal {
                level: 1,
                first_child: 2,
                entries: Vec::new(),
            };
            let donor = BTreeNode::Internal {
                level: 1,
                first_child: 3,
                entries: vec![InternalEntry { separator: b"m".to_vec(), right_child: 4 }],
            };
            let parent = BTreeNode::Internal {
                level: 2,
                first_child: deficient_id,
                entries: vec![InternalEntry { separator: b"h".to_vec(), right_child: donor_id }],
            };
            let mut physical_changes = vec![
                PageChange::Overwrite {
                    page_id: 0,
                    expected_generation: tree.meta_generation,
                    new_generation: tree.meta_generation + 1,
                    payload: encode_meta(&RootMeta { root_id: parent_id, level: 2, free_head: None }),
                },
            ];
            for leaf_id in 2..=5 {
                physical_changes.push(PageChange::Allocate {
                    generation: 1,
                    payload: encode_node(&BTreeNode::Leaf { next_leaf: None, entries: Vec::new() }).unwrap(),
                });
            }
            physical_changes.push(PageChange::Allocate { generation: 1, payload: encode_node(&deficient).unwrap() });
            physical_changes.push(PageChange::Allocate { generation: 1, payload: encode_node(&donor).unwrap() });
            physical_changes.push(PageChange::Allocate { generation: 1, payload: encode_node(&parent).unwrap() });
            tree.pages.transaction(physical_changes).unwrap();
            tree.root = RootMeta { root_id: parent_id, level: 2, free_head: None };
            tree.meta_generation += 1;
            let mut overlay = PageOverlay::new(tree.pages.page_count());

            let mut free_head = None;
            assert_eq!(
                tree.repair_descending_internal_underflows(&[deficient_id], &mut overlay, &mut free_head).unwrap(),
                1
            );
            assert_eq!(free_head, Some(parent_id));
            assert!(overlay.payload(donor_id).is_none());
            assert!(overlay.payload(parent_id).is_none());
            let metadata = decode_meta(overlay.payload(0).unwrap()).unwrap();
            assert_eq!(metadata.root_id, deficient_id);
            assert_eq!(metadata.level, 1);
            assert_eq!(metadata.free_head, Some(parent_id));
            let BTreeNode::Internal { entries: merged_entries, .. } =
                BTreeNode::decode(overlay.payload(deficient_id).unwrap()).unwrap() else {
                    panic!("el superviviente debe seguir siendo interno");
                };
            assert_eq!(merged_entries.len(), 2);
            let changes = overlay.into_changes();
            assert_eq!(changes.len(), 4);
            let PageChange::Overwrite { payload: retired_donor, .. } = &changes[2] else {
                panic!("el donante debe quedar sobrescrito como MBFR");
            };
            assert_eq!(crate::page_reuse::FreePage::decode(retired_donor).unwrap().next, None);
            let PageChange::Overwrite { payload: retired_root, .. } = &changes[3] else {
                panic!("la raíz contraída debe quedar sobrescrita como MBFR");
            };
            assert_eq!(crate::page_reuse::FreePage::decode(retired_root).unwrap().next, Some(donor_id));
        }
        cleanup(&p, &w);
    }

    #[test]
    fn remove_imports_ascending_changes_into_overlay_before_commit() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            for key in [b"a".as_slice(), b"b".as_slice(), b"c".as_slice()] {
                tree.insert(key.to_vec(), vec![6; 1500]).unwrap();
            }
            assert_eq!(tree.height(), 1);
            assert!(tree.remove(b"a").unwrap());
            assert_eq!(tree.get(b"a").unwrap(), None);
            assert_eq!(tree.get(b"b").unwrap(), Some(vec![6; 1500]));
            assert_eq!(tree.get(b"c").unwrap(), Some(vec![6; 1500]));
            tree.validate().unwrap();
        }
        cleanup(&p, &w);
    }

    #[test]
    fn descending_repair_repeats_sweeps_when_child_merge_makes_parent_unary() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let deficient = BTreeNode::Internal { level: 1, first_child: 2, entries: Vec::new() };
            let leaf_donor = BTreeNode::Internal {
                level: 1,
                first_child: 3,
                entries: vec![InternalEntry { separator: b"d".to_vec(), right_child: 4 }],
            };
            let q_left = BTreeNode::Internal { level: 1, first_child: 5, entries: Vec::new() };
            let q_middle = BTreeNode::Internal { level: 1, first_child: 6, entries: Vec::new() };
            let q_right = BTreeNode::Internal { level: 1, first_child: 7, entries: Vec::new() };
            let parent_p = BTreeNode::Internal {
                level: 2,
                first_child: 8,
                entries: vec![InternalEntry { separator: b"h".to_vec(), right_child: 9 }],
            };
            let parent_q = BTreeNode::Internal {
                level: 2,
                first_child: 10,
                entries: vec![
                    InternalEntry { separator: b"m".to_vec(), right_child: 11 },
                    InternalEntry { separator: b"z".to_vec(), right_child: 12 },
                ],
            };
            let root = BTreeNode::Internal {
                level: 3,
                first_child: 13,
                entries: vec![InternalEntry { separator: b"t".to_vec(), right_child: 14 }],
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            for leaf_id in 2..=7 {
                overlay.stage_allocate(
                    leaf_id, 1,
                    encode_node(&BTreeNode::Leaf { next_leaf: None, entries: Vec::new() }).unwrap(),
                ).unwrap();
            }
            let mut next_node_id = 8;
            for node in [&deficient, &leaf_donor, &q_left, &q_middle, &q_right, &parent_p, &parent_q, &root] {
                overlay.stage_allocate(next_node_id, 1, encode_node(node).unwrap()).unwrap();
                next_node_id += 1;
            }
            overlay.stage_overwrite(
                0, tree.meta_generation, tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id: 15, level: 3, free_head: None }),
            ).unwrap();

            let mut free_head = None;
            assert_eq!(
                tree.repair_descending_internal_underflows(
                    &[15, 13, 8], &mut overlay, &mut free_head,
                ).unwrap(),
                2
            );
            assert_eq!(free_head, Some(9));
            let BTreeNode::Internal { entries: root_entries, .. } =
                BTreeNode::decode(overlay.payload(15).unwrap()).unwrap() else {
                    panic!("la raíz debe seguir siendo interna");
                };
            assert_eq!(root_entries[0].separator, b"m");
            let BTreeNode::Internal { entries: p_entries, .. } =
                BTreeNode::decode(overlay.payload(13).unwrap()).unwrap() else {
                    panic!("el padre inferior debe seguir siendo interno");
                };
            assert_eq!(p_entries.len(), 1);
            assert_eq!(p_entries[0].separator, b"t");
            let BTreeNode::Internal { entries: merged_entries, .. } =
                BTreeNode::decode(overlay.payload(8).unwrap()).unwrap() else {
                    panic!("el superviviente inferior debe seguir siendo interno");
                };
            assert_eq!(merged_entries.len(), 2);
            assert!(overlay.payload(9).is_none());
        }
        cleanup(&p, &w);
    }

    #[test]
    fn descending_repair_fixes_empty_leaf_after_internal_borrow_exposes_sibling() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let leaf_empty = BTreeNode::Leaf { next_leaf: Some(3), entries: Vec::new() };
            let leaf_right = BTreeNode::Leaf {
                next_leaf: Some(4),
                entries: vec![
                    LeafEntry { key: b"b".to_vec(), value: b"B".to_vec() },
                    LeafEntry { key: b"c".to_vec(), value: b"C".to_vec() },
                ],
            };
            let leaf_next = BTreeNode::Leaf {
                next_leaf: Some(5),
                entries: vec![LeafEntry { key: b"d".to_vec(), value: b"D".to_vec() }],
            };
            let leaf_last = BTreeNode::Leaf {
                next_leaf: None,
                entries: vec![LeafEntry { key: b"e".to_vec(), value: b"E".to_vec() }],
            };
            let internal_empty = BTreeNode::Internal { level: 1, first_child: 2, entries: Vec::new() };
            let internal_donor = BTreeNode::Internal {
                level: 1,
                first_child: 3,
                entries: vec![
                    InternalEntry { separator: b"m".to_vec(), right_child: 4 },
                    InternalEntry { separator: b"z".to_vec(), right_child: 5 },
                ],
            };
            let root = BTreeNode::Internal {
                level: 2,
                first_child: 6,
                entries: vec![InternalEntry { separator: b"h".to_vec(), right_child: 7 }],
            };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            for node in [&leaf_empty, &leaf_right, &leaf_next, &leaf_last,
                &internal_empty, &internal_donor, &root]
            {
                let id = overlay.logical_page_count();
                overlay.stage_allocate(id, 1, encode_node(node).unwrap()).unwrap();
            }
            overlay.stage_overwrite(
                0, tree.meta_generation, tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id: 8, level: 2, free_head: None }),
            ).unwrap();

            let mut free_head = None;
            assert_eq!(
                tree.repair_descending_underflows(&[8, 6], 2, &mut overlay, &mut free_head).unwrap(),
                2
            );
            assert_eq!(free_head, None);
            let BTreeNode::Internal { entries: root_entries, .. } =
                BTreeNode::decode(overlay.payload(8).unwrap()).unwrap() else {
                    panic!("la raíz debe seguir siendo interna");
                };
            assert_eq!(root_entries[0].separator, b"m");
            let BTreeNode::Internal { entries: parent_entries, .. } =
                BTreeNode::decode(overlay.payload(6).unwrap()).unwrap() else {
                    panic!("el padre de hojas debe seguir siendo interno");
                };
            assert_eq!(parent_entries[0].separator, b"c");
            let BTreeNode::Leaf { entries: left_entries, .. } =
                BTreeNode::decode(overlay.payload(2).unwrap()).unwrap() else {
                    panic!("la hoja vacía debe recibir una entrada");
                };
            assert_eq!(left_entries[0].key, b"b");
            let BTreeNode::Leaf { entries: right_entries, .. } =
                BTreeNode::decode(overlay.payload(3).unwrap()).unwrap() else {
                    panic!("la hoja donante debe seguir siendo hoja");
                };
            assert_eq!(right_entries.len(), 1);
            assert_eq!(right_entries[0].key, b"c");
        }
        cleanup(&p, &w);
    }

    #[test]
    fn remove_repairs_internal_and_empty_leaf_after_upper_level_merge() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let leaves = vec![
                BTreeNode::Leaf {
                    next_leaf: Some(3),
                    entries: vec![LeafEntry { key: b"a".to_vec(), value: b"A".to_vec() }],
                },
                BTreeNode::Leaf {
                    next_leaf: Some(4),
                    entries: vec![
                        LeafEntry { key: b"b".to_vec(), value: b"B".to_vec() },
                        LeafEntry { key: b"c".to_vec(), value: b"C".to_vec() },
                    ],
                },
                BTreeNode::Leaf {
                    next_leaf: Some(5),
                    entries: vec![LeafEntry { key: b"d".to_vec(), value: b"D".to_vec() }],
                },
                BTreeNode::Leaf {
                    next_leaf: Some(6),
                    entries: vec![LeafEntry { key: b"e".to_vec(), value: b"E".to_vec() }],
                },
                BTreeNode::Leaf {
                    next_leaf: Some(7),
                    entries: vec![LeafEntry { key: b"f".to_vec(), value: b"F".to_vec() }],
                },
                BTreeNode::Leaf {
                    next_leaf: None,
                    entries: vec![LeafEntry { key: b"g".to_vec(), value: b"G".to_vec() }],
                },
            ];
            let internal_a = BTreeNode::Internal { level: 1, first_child: 2, entries: Vec::new() };
            let internal_b = BTreeNode::Internal {
                level: 1,
                first_child: 3,
                entries: vec![
                    InternalEntry { separator: b"d".to_vec(), right_child: 4 },
                    InternalEntry { separator: b"e".to_vec(), right_child: 5 },
                ],
            };
            let internal_c = BTreeNode::Internal { level: 1, first_child: 6, entries: Vec::new() };
            let internal_d = BTreeNode::Internal { level: 1, first_child: 7, entries: Vec::new() };
            let parent_p = BTreeNode::Internal { level: 2, first_child: 8, entries: Vec::new() };
            let parent_q = BTreeNode::Internal {
                level: 2,
                first_child: 9,
                entries: vec![
                    InternalEntry { separator: b"f".to_vec(), right_child: 10 },
                    InternalEntry { separator: b"g".to_vec(), right_child: 11 },
                ],
            };
            let root = BTreeNode::Internal {
                level: 3,
                first_child: 12,
                entries: vec![InternalEntry { separator: b"b".to_vec(), right_child: 13 }],
            };

            let mut changes = vec![
                PageChange::Overwrite {
                    page_id: 0,
                    expected_generation: tree.meta_generation,
                    new_generation: tree.meta_generation + 1,
                    payload: encode_meta(&RootMeta { root_id: 14, level: 3, free_head: Some(1) }),
                },
                PageChange::Overwrite {
                    page_id: 1,
                    expected_generation: 1,
                    new_generation: 2,
                    payload: crate::page_reuse::FreePage { next: None }.encode(),
                },
            ];
            for node in leaves.iter().chain([
                &internal_a, &internal_b, &internal_c, &internal_d, &parent_p, &parent_q, &root,
            ]) {
                changes.push(PageChange::Allocate { generation: 1, payload: encode_node(node).unwrap() });
            }
            tree.pages.transaction(changes).unwrap();
            tree.root = RootMeta { root_id: 14, level: 3, free_head: Some(1) };
            tree.meta_generation += 1;

            assert!(tree.remove(b"a").unwrap());
            assert_eq!(tree.get(b"a").unwrap(), None);
            for (key, value) in [
                (b"b".as_slice(), b"B".as_slice()),
                (b"c".as_slice(), b"C".as_slice()),
                (b"d".as_slice(), b"D".as_slice()),
                (b"e".as_slice(), b"E".as_slice()),
                (b"f".as_slice(), b"F".as_slice()),
                (b"g".as_slice(), b"G".as_slice()),
            ] {
                assert_eq!(tree.get(key).unwrap(), Some(value.to_vec()));
            }
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 6);
            assert_eq!(report.free_pages, 1);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn initializes_and_reopens_empty_tree() {
        let (p,w)=paths();
        { let mut t=PersistentBPlusTree::open(&p,&w).unwrap(); assert_eq!(t.height(),0); assert_eq!(t.get(b"missing").unwrap(),None); }
        { let mut t=PersistentBPlusTree::open(&p,&w).unwrap(); assert_eq!(t.get(b"missing").unwrap(),None); }
        cleanup(&p,&w);
    }
    #[test]
    fn inserts_and_reopens_values() {
        let (p,w)=paths();
        { let mut t=PersistentBPlusTree::open(&p,&w).unwrap(); t.insert(b"alpha".to_vec(),b"A".to_vec()).unwrap(); t.insert(b"beta".to_vec(),b"B".to_vec()).unwrap(); assert_eq!(t.get(b"alpha").unwrap(),Some(b"A".to_vec())); }
        { let mut t=PersistentBPlusTree::open(&p,&w).unwrap(); assert_eq!(t.get(b"beta").unwrap(),Some(b"B".to_vec())); }
        cleanup(&p,&w);
    }
    #[test]
    fn replaces_existing_value_without_duplicate_key() {
        let (p,w)=paths();
        let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
        t.insert(b"k".to_vec(),b"old".to_vec()).unwrap();
        t.insert(b"k".to_vec(),b"new".to_vec()).unwrap();
        assert_eq!(t.get(b"k").unwrap(),Some(b"new".to_vec()));
        drop(t);
        cleanup(&p,&w);
    }
    #[test]
    fn splits_leaf_and_preserves_ordered_lookup() {
        let (p,w)=paths();
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            for i in 0..160 {
                let key=format!("key-{i:04}");
                t.insert(key.as_bytes().to_vec(),vec![b'v';80]).unwrap();
            }
            assert!(t.height()>=1);
            for i in 0..160 {
                let key=format!("key-{i:04}");
                assert_eq!(t.get(key.as_bytes()).unwrap(),Some(vec![b'v';80]));
            }
        }
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            assert!(t.height()>=1);
            assert_eq!(t.get(b"key-0159").unwrap(),Some(vec![b'v';80]));
        }
        cleanup(&p,&w);
    }
    #[test]
    fn internal_split_promotes_middle_separator() {
        let entries = vec![
            InternalEntry { separator: b"b".to_vec(), right_child: 2 },
            InternalEntry { separator: b"d".to_vec(), right_child: 4 },
            InternalEntry { separator: b"f".to_vec(), right_child: 6 },
        ];
        let (left, right, promoted) = split_internal(1, 1, entries).unwrap();
        assert_eq!(promoted, b"d");
        assert!(matches!(left, BTreeNode::Internal { first_child: 1, ref entries, .. } if entries.len() == 1));
        assert!(matches!(right, BTreeNode::Internal { first_child: 4, ref entries, .. } if entries.len() == 1));
    }

    #[test]
    fn leaf_split_keeps_sibling_chain() {
        let entries = vec![
            LeafEntry { key: b"a".to_vec(), value: vec![1; 1900] },
            LeafEntry { key: b"b".to_vec(), value: vec![2; 1900] },
        ];
        let (left, right, separator) = split_leaf(entries, 9, Some(12)).unwrap();
        assert_eq!(separator, b"b");
        assert!(matches!(left, BTreeNode::Leaf { next_leaf: Some(9), .. }));
        assert!(matches!(right, BTreeNode::Leaf { next_leaf: Some(12), .. }));
    }

    #[test]
    fn splits_internal_root_and_reopens_multilevel_tree() {
        let (p,w)=paths();
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            let mut keys=Vec::new();
            for i in 0u32..8 {
                let mut key=vec![b'x';1800];
                key[..4].copy_from_slice(&i.to_be_bytes());
                t.insert(key.clone(),i.to_le_bytes().to_vec()).unwrap();
                keys.push(key);
            }
            assert!(t.height()>=2);
            for (i,key) in keys.iter().enumerate() {
                assert_eq!(t.get(key).unwrap(),Some((i as u32).to_le_bytes().to_vec()));
            }
        }
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            assert!(t.height()>=2);
            let mut key=vec![b'x';1800];
            key[..4].copy_from_slice(&7u32.to_be_bytes());
            assert_eq!(t.get(&key).unwrap(),Some(7u32.to_le_bytes().to_vec()));
        }
        cleanup(&p,&w);
    }

    #[test]
    fn range_returns_inclusive_start_and_exclusive_end_across_leaves() {
        let (p,w)=paths();
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            for i in 0..100 {
                let key=format!("k{i:03}");
                t.insert(key.as_bytes().to_vec(),vec![i as u8;70]).unwrap();
            }
            let got=t.range(Some(b"k020"),Some(b"k035")).unwrap();
            assert_eq!(got.len(),15);
            assert_eq!(got.first().unwrap().0,b"k020");
            assert_eq!(got.last().unwrap().0,b"k034");
            assert_eq!(t.range(None,Some(b"k003")).unwrap().len(),3);
            assert_eq!(t.range(Some(b"k098"),None).unwrap().len(),2);
        }
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            assert_eq!(t.range(Some(b"k050"),Some(b"k053")).unwrap().len(),3);
        }
        cleanup(&p,&w);
    }

    #[test]
    fn range_rejects_reversed_or_empty_bounds() {
        let (p,w)=paths();
        let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
        assert!(matches!(t.range(Some(b"z"),Some(b"a")),Err(BTreeError::Invalid(_))));
        assert!(matches!(t.range(Some(b""),None),Err(BTreeError::Invalid(_))));
        drop(t);
        cleanup(&p,&w);
    }

    #[test]
    fn internal_split_handles_two_maximum_size_separators() {
        let key_a = vec![b'a'; MAX_TREE_KEY_LEN];
        let key_z = vec![b'z'; MAX_TREE_KEY_LEN];
        let entries = vec![
            InternalEntry { separator: key_a.clone(), right_child: 2 },
            InternalEntry { separator: key_z.clone(), right_child: 3 },
        ];

        let (left, right, promoted) = split_internal(1, 1, entries).unwrap();
        assert_eq!(promoted, key_a);
        assert!(matches!(left, BTreeNode::Internal { first_child: 1, ref entries, .. } if entries.is_empty()));
        assert!(matches!(right, BTreeNode::Internal { first_child: 2, ref entries, .. } if entries.len() == 1 && entries[0].separator == key_z));

        let left_bytes = left.encode(PAGE_PAYLOAD).unwrap();
        let right_bytes = right.encode(PAGE_PAYLOAD).unwrap();
        assert_eq!(right_bytes.len(), PAGE_PAYLOAD);
        assert_eq!(BTreeNode::decode(&left_bytes).unwrap(), left);
        assert_eq!(BTreeNode::decode(&right_bytes).unwrap(), right);

        let new_root = BTreeNode::Internal {
            level: 2,
            first_child: 10,
            entries: vec![InternalEntry { separator: promoted, right_child: 11 }],
        };
        let root_bytes = new_root.encode(PAGE_PAYLOAD).unwrap();
        assert_eq!(root_bytes.len(), PAGE_PAYLOAD);
        assert_eq!(BTreeNode::decode(&root_bytes).unwrap(), new_root);
    }

    #[test]
    fn internal_split_can_promote_first_separator() {
        let entries = vec![
            InternalEntry { separator: b"a".to_vec(), right_child: 2 },
            InternalEntry { separator: b"z".to_vec(), right_child: 3 },
        ];
        let (left, right, promoted) = split_internal(1, 1, entries).unwrap();
        assert_eq!(promoted,b"a");
        assert!(matches!(left,BTreeNode::Internal { ref entries, .. } if entries.is_empty()));
        assert!(matches!(right,BTreeNode::Internal { first_child: 2, ref entries, .. } if entries.len()==1));
        let left_bytes = left.encode(PAGE_PAYLOAD).unwrap();
        let right_bytes = right.encode(PAGE_PAYLOAD).unwrap();
        assert_eq!(BTreeNode::decode(&left_bytes).unwrap(), left);
        assert_eq!(BTreeNode::decode(&right_bytes).unwrap(), right);
    }

    #[test]
    fn removes_keys_without_breaking_search_or_leaf_chain() {
        let (p,w)=paths();
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            for i in 0..90 {
                let key=format!("r{i:03}");
                t.insert(key.as_bytes().to_vec(),vec![i as u8;80]).unwrap();
            }
            for i in (0..90).step_by(2) {
                let key=format!("r{i:03}");
                assert!(t.remove(key.as_bytes()).unwrap());
                assert!(!t.remove(key.as_bytes()).unwrap());
            }
            for i in 0..90 {
                let key=format!("r{i:03}");
                assert_eq!(t.get(key.as_bytes()).unwrap().is_some(),i%2==1);
            }
            assert_eq!(t.range(None,None).unwrap().len(),45);
        }
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            assert_eq!(t.range(None,None).unwrap().len(),45);
            for i in 1..90 {
                let key=format!("r{i:03}");
                assert!(t.get(key.as_bytes()).unwrap().is_some());
            }
        }
        cleanup(&p,&w);
    }

    #[test]
    fn validates_multilevel_tree_after_deletions_and_reopen() {
        let (p,w)=paths();
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            for i in 0..120 {
                let key=format!("v{i:04}");
                t.insert(key.as_bytes().to_vec(),vec![i as u8;90]).unwrap();
            }
            for i in (0..120).step_by(3) {
                let key=format!("v{i:04}");
                t.remove(key.as_bytes()).unwrap();
            }
            let report=t.validate().unwrap();
            assert_eq!(report.entries,80);
            assert!(report.leaf_pages>1);
        }
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            assert_eq!(t.validate().unwrap().entries,80);
        }
        cleanup(&p,&w);
    }

    #[test]
    fn shuffled_insertions_preserve_search_range_and_validation() {
        let (p,w)=paths();
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            for n in 0u32..200 {
                let i=(n*73)%200;
                let key=format!("s{i:04}");
                t.insert(key.as_bytes().to_vec(),i.to_be_bytes().to_vec()).unwrap();
            }
            for i in 0u32..200 {
                let key=format!("s{i:04}");
                assert_eq!(t.get(key.as_bytes()).unwrap(),Some(i.to_be_bytes().to_vec()));
            }
            let range=t.range(Some(b"s0070"),Some(b"s0090")).unwrap();
            assert_eq!(range.len(),20);
            assert_eq!(range.first().unwrap().0,b"s0070");
            assert_eq!(t.validate().unwrap().entries,200);
        }
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            assert_eq!(t.validate().unwrap().entries,200);
        }
        cleanup(&p,&w);
    }

    #[test]
    fn incremental_range_iterator_yields_in_order_without_materializing_all() {
        let (p,w)=paths();
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            for i in 0..75 {
                let key=format!("it{i:03}");
                t.insert(key.as_bytes().to_vec(),vec![i as u8;100]).unwrap();
            }
            let mut iter=t.range_iter(Some(b"it030"),Some(b"it050")).unwrap();
            assert_eq!(iter.next().unwrap().unwrap().0,b"it030");
            assert_eq!(iter.next().unwrap().unwrap().0,b"it031");
            assert_eq!(iter.next().unwrap().unwrap().0,b"it032");
            assert_eq!(iter.next().unwrap().unwrap().0,b"it033");
            assert!(iter.next().is_none());
        }
        cleanup(&p,&w);
    }

    #[test]
    fn incremental_iterator_rejects_two_leaf_cycle_and_stops_after_error() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            for i in 0..120 {
                let key = format!("cycle{i:03}");
                tree.insert(key.into_bytes(), vec![i as u8; 120]).unwrap();
            }

            let root_page = tree.pages.read(tree.root.root_id).unwrap();
            let mut leaf_id = match BTreeNode::decode(&root_page.payload).unwrap() {
                BTreeNode::Leaf { .. } => tree.root.root_id,
                BTreeNode::Internal { first_child, .. } => first_child,
            };
            let first_leaf = tree.pages.read(leaf_id).unwrap();
            let second_leaf_id = match BTreeNode::decode(&first_leaf.payload).unwrap() {
                BTreeNode::Leaf { next_leaf: Some(next), .. } => next,
                _ => panic!("la prueba necesita al menos dos hojas"),
            };
            let second_leaf = tree.pages.read(second_leaf_id).unwrap();
            let second_node = match BTreeNode::decode(&second_leaf.payload).unwrap() {
                BTreeNode::Leaf { entries, .. } => BTreeNode::Leaf {
                    next_leaf: Some(leaf_id),
                    entries,
                },
                BTreeNode::Internal { .. } => panic!("el enlace de hoja debe apuntar a una hoja"),
            };
            let payload = second_node.encode(PAGE_PAYLOAD).unwrap();
            tree.pages.overwrite(
                second_leaf_id,
                second_leaf.generation,
                second_leaf.generation + 1,
                &payload,
            ).unwrap();

            let mut iterator = tree.range_iter(None, None).unwrap();
            let mut yielded = 0usize;
            let mut found_cycle = false;
            while let Some(item) = iterator.next() {
                match item {
                    Ok(_) => yielded += 1,
                    Err(BTreeError::Corrupt("ciclo en enlaces de hojas")) => {
                        found_cycle = true;
                        break;
                    }
                    Err(error) => panic!("error inesperado del iterador: {error:?}"),
                }
            }
            assert!(yielded > 0);
            assert!(found_cycle);
            assert!(iterator.next().is_none());
        }
        cleanup(&p, &w);
    }

    #[test]
    fn incremental_iterator_rejects_out_of_range_leaf_link_and_stops_after_error() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            for i in 0..120 {
                let key = format!("outside{i:03}");
                tree.insert(key.into_bytes(), vec![i as u8; 120]).unwrap();
            }

            let root_page = tree.pages.read(tree.root.root_id).unwrap();
            let first_leaf_id = match BTreeNode::decode(&root_page.payload).unwrap() {
                BTreeNode::Leaf { .. } => tree.root.root_id,
                BTreeNode::Internal { first_child, .. } => first_child,
            };
            let first_leaf = tree.pages.read(first_leaf_id).unwrap();
            let entries = match BTreeNode::decode(&first_leaf.payload).unwrap() {
                BTreeNode::Leaf { entries, .. } => entries,
                BTreeNode::Internal { .. } => panic!("el primer hijo debe ser una hoja"),
            };
            let invalid_target = tree.pages.page_count() + 3;
            let corrupt_leaf = BTreeNode::Leaf {
                next_leaf: Some(invalid_target),
                entries,
            };
            let payload = corrupt_leaf.encode(PAGE_PAYLOAD).unwrap();
            tree.pages.overwrite(
                first_leaf_id,
                first_leaf.generation,
                first_leaf.generation + 1,
                &payload,
            ).unwrap();

            let mut iterator = tree.range_iter(None, None).unwrap();
            let mut yielded = 0usize;
            let mut found_invalid_link = false;
            while let Some(item) = iterator.next() {
                match item {
                    Ok(_) => yielded += 1,
                    Err(BTreeError::Corrupt("enlace de hoja fuera del archivo")) => {
                        found_invalid_link = true;
                        break;
                    }
                    Err(error) => panic!("error inesperado del iterador: {error:?}"),
                }
            }
            assert!(yielded > 0);
            assert!(found_invalid_link);
            assert!(iterator.next().is_none());
        }
        cleanup(&p, &w);
    }

    #[test]
    fn incremental_iterator_crosses_leaf_boundaries_and_stops_at_end() {
        let (p,w)=paths();
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            for i in 0..90 {
                let key=format!("cross{i:03}");
                t.insert(key.as_bytes().to_vec(),vec![i as u8;120]).unwrap();
            }
            let got=t.range_iter(Some(b"cross030"),Some(b"cross070")).unwrap()
                .map(|item| item.unwrap().0).collect::<Vec<_>>();
            assert_eq!(got.len(),40);
            assert_eq!(got.first().unwrap(),b"cross030");
            assert_eq!(got.last().unwrap(),b"cross069");
        }
        cleanup(&p,&w);
    }

    #[test]
    fn deleting_every_key_keeps_tree_reusable_and_valid() {
        let (p,w)=paths();
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            for i in 0u32..160 {
                let key=format!("life{i:04}");
                t.insert(key.as_bytes().to_vec(),i.to_le_bytes().to_vec()).unwrap();
            }
            for i in 0u32..160 {
                let key=format!("life{i:04}");
                assert!(t.remove(key.as_bytes()).unwrap());
            }
            assert!(t.range(None,None).unwrap().is_empty());
            assert_eq!(t.validate().unwrap().entries,0);
            for i in (0u32..160).rev() {
                let key=format!("life{i:04}");
                t.insert(key.as_bytes().to_vec(),i.to_le_bytes().to_vec()).unwrap();
            }
            assert_eq!(t.validate().unwrap().entries,160);
        }
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            assert_eq!(t.validate().unwrap().entries,160);
            assert_eq!(t.range(Some(b"life0000"),Some(b"life0003")).unwrap().len(),3);
        }
        cleanup(p,w);
    }

    #[test]
    fn deleting_last_key_in_leaf_redistributes_from_right_sibling_atomically() {
        let (p,w)=paths();
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            for key in [b"a".as_slice(),b"b".as_slice(),b"c".as_slice()] {
                t.insert(key.to_vec(),vec![7;1500]).unwrap();
            }
            assert!(t.remove(b"a").unwrap());
            assert!(t.get(b"a").unwrap().is_none());
            assert!(t.get(b"b").unwrap().is_some());
            assert!(t.get(b"c").unwrap().is_some());
            assert_eq!(t.validate().unwrap().entries,2);
        }
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            assert_eq!(t.validate().unwrap().entries,2);
            assert!(t.get(b"b").unwrap().is_some());
        }
        cleanup(p,w);
    }

    #[test]
    fn deleting_empty_middle_leaf_redistributes_from_left_sibling() {
        let (p,w)=paths();
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            for key in [b"a".as_slice(),b"b".as_slice(),b"c".as_slice()] {
                t.insert(key.to_vec(),vec![9;1500]).unwrap();
            }
            t.insert(b"aa".to_vec(),vec![8;1500]).unwrap();
            assert!(t.remove(b"b").unwrap());
            assert!(t.remove(b"c").unwrap());
            assert!(t.get(b"a").unwrap().is_some());
            assert!(t.get(b"aa").unwrap().is_some());
            assert_eq!(t.validate().unwrap().entries,2);
        }
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            assert_eq!(t.validate().unwrap().entries,2);
            assert!(t.get(b"aa").unwrap().is_some());
        }
        cleanup(p,w);
    }

    #[test]
    fn deterministic_mixed_operations_match_reference_map() {
        use std::collections::BTreeMap;
        let (p,w)=paths();
        let mut model=BTreeMap::<Vec<u8>,Vec<u8>>::new();
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            let mut state=0x9e37_79b9u32;
            for step in 0..360u32 {
                state=state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let id=(state>>8)%96;
                let key=format!("mix{id:04}").into_bytes();
                if state&3==0 {
                    assert_eq!(t.remove(&key).unwrap(),model.remove(&key).is_some());
                } else {
                    let value=vec![(step%251) as u8; (state as usize%180)+1];
                    t.insert(key.clone(),value.clone()).unwrap();
                    model.insert(key,value);
                }
                if step%12==0 {
                    let report=t.validate().unwrap();
                    assert_eq!(report.entries,model.len());
                    let actual=t.range(None,None).unwrap();
                    let expected=model.iter().map(|(k,v)|(k.clone(),v.clone())).collect::<Vec<_>>();
                    assert_eq!(actual,expected);
                }
            }
            assert_eq!(t.validate().unwrap().entries,model.len());
        }
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            let actual=t.range(None,None).unwrap();
            let expected=model.iter().map(|(k,v)|(k.clone(),v.clone())).collect::<Vec<_>>();
            assert_eq!(actual,expected);
            assert_eq!(t.validate().unwrap().entries,model.len());
        }
        cleanup(&p,&w);
    }

    #[test]
    fn exhaustive_multilevel_deletion_reopen_and_reuse_matches_reference() {
        use std::collections::BTreeMap;
        let (p, w) = paths();
        let mut model = BTreeMap::<Vec<u8>, Vec<u8>>::new();
        let mut keys = Vec::new();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            for i in 0u32..160 {
                let key = format!("exhaustive-{i:04}").into_bytes();
                let value = vec![(i % 239) as u8; 96 + (i as usize % 47)];
                tree.insert(key.clone(), value.clone()).unwrap();
                model.insert(key.clone(), value);
                keys.push(key);
            }
            assert!(tree.height() >= 2, "la prueba debe crear un árbol multinivel");
            let mut order = (0..keys.len()).collect::<Vec<_>>();
            let mut state = 0x6d2b_79f5u32;
            for i in (1..order.len()).rev() {
                state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                order.swap(i, (state as usize) % (i + 1));
            }
            for (step, index) in order.into_iter().enumerate() {
                let key = keys[index].clone();
                if model.remove(&key).is_some() {
                    assert!(tree.remove(&key).unwrap());
                } else {
                    assert!(!tree.remove(&key).unwrap());
                }

                let report = tree.validate().unwrap();
                assert_eq!(report.entries, model.len(), "contador tras borrado {step}");
                let expected = model.iter().map(|(k, v)| (k.clone(), v.clone())).collect::<Vec<_>>();
                assert_eq!(tree.range(None, None).unwrap(), expected, "rango tras borrado {step}");

                if step % 19 == 0 {
                    drop(tree);
                    let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
                    assert_eq!(reopened.validate().unwrap().entries, model.len());
                    assert_eq!(reopened.range(None, None).unwrap(), expected);
                    tree = reopened;
                }
            }
            assert_eq!(tree.height(), 0, "el árbol vacío debe contraerse a una hoja raíz");
            assert_eq!(tree.validate().unwrap().entries, 0);

            // Reinsertar después de la secuencia fuerza el uso de páginas MBFR
            // liberadas por las fusiones anteriores.
            for (i, key) in keys.iter().enumerate() {
                let value = vec![0xA7; 120 + (i % 31)];
                tree.insert(key.clone(), value.clone()).unwrap();
                model.insert(key.clone(), value);
            }
            let expected = model.iter().map(|(k, v)| (k.clone(), v.clone())).collect::<Vec<_>>();
            assert_eq!(tree.range(None, None).unwrap(), expected);
            assert_eq!(tree.validate().unwrap().entries, model.len());
        }
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let expected = model.iter().map(|(k, v)| (k.clone(), v.clone())).collect::<Vec<_>>();
            assert_eq!(tree.range(None, None).unwrap(), expected);
            assert_eq!(tree.validate().unwrap().entries, model.len());
        }
        cleanup(&p, &w);
    }

    #[test]
    fn multilevel_large_separator_deletions_match_reference_after_reopen() {
        use std::collections::BTreeMap;
        let (p,w)=paths();
        let mut model=BTreeMap::<Vec<u8>,Vec<u8>>::new();
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            for i in 0u32..28 {
                let mut key=vec![b'k';1600];
                key[..4].copy_from_slice(&i.to_be_bytes());
                let value=vec![(i%251) as u8;1100];
                t.insert(key.clone(),value.clone()).unwrap();
                model.insert(key,value);
            }
            assert!(t.height()>=2, "la prueba debe alcanzar al menos tres niveles contando hojas");
            for i in (0u32..28).step_by(3) {
                let mut key=vec![b'k';1600];
                key[..4].copy_from_slice(&i.to_be_bytes());
                assert_eq!(t.remove(&key).unwrap(),model.remove(&key).is_some());
                let report=t.validate().unwrap();
                assert_eq!(report.entries,model.len());
            }
            let actual=t.range(None,None).unwrap();
            let expected=model.iter().map(|(k,v)|(k.clone(),v.clone())).collect::<Vec<_>>();
            assert_eq!(actual,expected);
        }
        {
            let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
            let actual=t.range(None,None).unwrap();
            let expected=model.iter().map(|(k,v)|(k.clone(),v.clone())).collect::<Vec<_>>();
            assert_eq!(actual,expected);
            assert_eq!(t.validate().unwrap().entries,model.len());
            for i in 0u32..28 {
                let mut key=vec![b'k';1600];
                key[..4].copy_from_slice(&i.to_be_bytes());
                if i%3==0 {
                    t.insert(key.clone(),vec![0xA5;900]).unwrap();
                    model.insert(key,vec![0xA5;900]);
                }
            }
            let actual=t.range(None,None).unwrap();
            let expected=model.iter().map(|(k,v)|(k.clone(),v.clone())).collect::<Vec<_>>();
            assert_eq!(actual,expected);
            assert_eq!(t.validate().unwrap().entries,model.len());
        }
        cleanup(&p,&w);
    }

    #[test]
    fn rejects_empty_key() {
        let (p,w)=paths();
        let mut t=PersistentBPlusTree::open(&p,&w).unwrap();
        assert!(matches!(t.insert(vec![],vec![]),Err(BTreeError::Invalid(_))));
        drop(t);
        cleanup(&p,&w);
    }

    #[test]
    fn root_metadata_writes_v2_and_reads_legacy_v1() {
        let current = RootMeta { root_id: 7, level: 2, free_head: Some(4) };
        let encoded = encode_meta(&current);
        assert_eq!(&encoded[..4], b"MBTR");
        assert_eq!(u16::from_le_bytes(encoded[4..6].try_into().unwrap()), 2);
        assert_eq!(decode_meta(&encoded).unwrap(), current);

        let mut legacy = vec![0u8; 24];
        legacy[..4].copy_from_slice(b"MBTR");
        legacy[4..6].copy_from_slice(&1u16.to_le_bytes());
        legacy[8..16].copy_from_slice(&9u64.to_le_bytes());
        legacy[16..18].copy_from_slice(&1u16.to_le_bytes());
        assert_eq!(decode_meta(&legacy).unwrap(), RootMeta { root_id: 9, level: 1, free_head: None });
    }


    #[test]
    fn validate_accounts_for_persisted_free_pages() {
        let (p, w) = paths();
        let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
        let free_id = tree.pages.page_count();
        let new_meta = RootMeta { root_id: tree.root.root_id, level: tree.root.level, free_head: Some(free_id) };
        tree.pages.transaction(vec![
            PageChange::Allocate {
                generation: 1,
                payload: crate::page_reuse::FreePage { next: None }.encode(),
            },
            PageChange::Overwrite {
                page_id: 0,
                expected_generation: tree.meta_generation,
                new_generation: tree.meta_generation + 1,
                payload: encode_meta(&new_meta),
            },
        ]).unwrap();
        tree.root = new_meta;
        tree.meta_generation += 1;
        let report = tree.validate().unwrap();
        assert_eq!(report.free_pages, 1);
        assert_eq!(report.pages_visited as u64, tree.page_count());
        drop(tree);
        cleanup(&p, &w);
    }

    #[test]
    fn validate_rejects_cycles_in_free_page_chain() {
        let (p, w) = paths();
        let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
        let free_id = tree.pages.page_count();
        let new_meta = RootMeta { root_id: tree.root.root_id, level: tree.root.level, free_head: Some(free_id) };
        tree.pages.transaction(vec![
            PageChange::Allocate {
                generation: 1,
                payload: crate::page_reuse::FreePage { next: Some(free_id) }.encode(),
            },
            PageChange::Overwrite {
                page_id: 0,
                expected_generation: tree.meta_generation,
                new_generation: tree.meta_generation + 1,
                payload: encode_meta(&new_meta),
            },
        ]).unwrap();
        tree.root = new_meta;
        tree.meta_generation += 1;
        assert!(matches!(tree.validate(), Err(BTreeError::Corrupt("ciclo o página duplicada en la lista libre"))));
        drop(tree);
        cleanup(&p, &w);
    }



    #[test]
    fn insert_reuses_free_page_for_leaf_split_atomically() {
        let (p, w) = paths();
        let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
        let free_id = tree.page_count();
        let new_root = RootMeta {
            root_id: tree.root.root_id,
            level: tree.root.level,
            free_head: Some(free_id),
        };
        tree.pages.transaction(vec![
            PageChange::Allocate {
                generation: 1,
                payload: crate::page_reuse::FreePage { next: None }.encode(),
            },
            PageChange::Overwrite {
                page_id: 0,
                expected_generation: tree.meta_generation,
                new_generation: tree.meta_generation + 1,
                payload: encode_meta(&new_root),
            },
        ]).unwrap();
        tree.root = new_root;
        tree.meta_generation += 1;
        let before = tree.page_count();
        for i in 0..40u32 {
            tree.insert(format!("key-{i:04}").into_bytes(), vec![b'x'; 100]).unwrap();
        }
        assert_eq!(tree.page_count(), before + 1, "la hoja derecha debe reutilizar free_head; solo la nueva raíz añade una página");
        assert_eq!(tree.root.free_head, None);
        assert_eq!(tree.validate().unwrap().free_pages, 0);
        for i in 0..40u32 {
            assert_eq!(tree.get(format!("key-{i:04}").as_bytes()).unwrap(), Some(vec![b'x'; 100]));
        }
        drop(tree);
        cleanup(&p, &w);
    }



    #[test]
    fn empty_leaf_merge_frees_pages_contracts_root_and_reuses_them() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let left_key = [b'a'; 1500].to_vec();
            let right_key = [b'z'; 1500].to_vec();
            tree.insert(left_key.clone(), vec![1; 1000]).unwrap();
            tree.insert(right_key.clone(), vec![2; 1000]).unwrap();
            assert_eq!(tree.height(), 1, "dos entradas grandes deben dividir la hoja raíz");
            let before = tree.page_count();
            assert!(tree.remove(&left_key).unwrap());
            assert_eq!(tree.height(), 0, "la raíz interna unaria debe contraerse");
            assert_eq!(tree.get(&right_key).unwrap(), Some(vec![2; 1000]));
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 1);
            assert_eq!(report.free_pages, 2, "la hoja retirada y la antigua raíz deben quedar libres");
            assert_eq!(tree.page_count(), before);
        }
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(tree.height(), 0);
            assert_eq!(tree.validate().unwrap().free_pages, 2);
            let before = tree.page_count();
            tree.insert(vec![b'b'; 1500], vec![3; 1000]).unwrap();
            tree.insert(vec![b'z'; 1500], vec![4; 1000]).unwrap();
            assert_eq!(tree.page_count(), before, "la división debe consumir las dos páginas liberadas");
            assert_eq!(tree.validate().unwrap().free_pages, 0);
            assert_eq!(tree.get(&[b'b'; 1500]).unwrap(), Some(vec![3; 1000]));
            assert_eq!(tree.get(&[b'z'; 1500]).unwrap(), Some(vec![4; 1000]));
        }
        cleanup(&p, &w);
    }



    #[test]
    fn empty_rightmost_leaf_merges_into_left_sibling() {
        let (p, w) = paths();
        let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
        let keys = [vec![b'a'; 1500], vec![b'm'; 1500], vec![b'z'; 1500]];
        for (index, key) in keys.iter().enumerate() {
            tree.insert(key.clone(), vec![index as u8; 1000]).unwrap();
        }
        assert_eq!(tree.height(), 1);
        assert!(tree.remove(&keys[2]).unwrap());
        let report = tree.validate().unwrap();
        assert_eq!(report.entries, 2);
        assert_eq!(report.free_pages, 1);
        assert_eq!(tree.get(&keys[0]).unwrap(), Some(vec![0; 1000]));
        assert_eq!(tree.get(&keys[1]).unwrap(), Some(vec![1; 1000]));
        assert_eq!(tree.get(&keys[2]).unwrap(), None);
        drop(tree);
        let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
        assert_eq!(reopened.validate().unwrap().free_pages, 1);
        cleanup(&p, &w);
    }



    #[test]
    fn deleting_last_key_from_unary_root_contracts_and_survives_reopen() {
        let (p, w) = paths();
        let key = b"only-key".to_vec();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            tree.insert(key.clone(), b"value".to_vec()).unwrap();
            let leaf_id = tree.root.root_id;
            let leaf_page_count = tree.page_count();
            let root_id = leaf_page_count;
            let unary_root = BTreeNode::Internal {
                level: 1,
                first_child: leaf_id,
                entries: Vec::new(),
            };
            let new_meta = RootMeta {
                root_id,
                level: 1,
                free_head: tree.root.free_head,
            };
            tree.pages.transaction(vec![
                PageChange::Allocate {
                    generation: 1,
                    payload: encode_node(&unary_root).unwrap(),
                },
                PageChange::Overwrite {
                    page_id: 0,
                    expected_generation: tree.meta_generation,
                    new_generation: tree.meta_generation + 1,
                    payload: encode_meta(&new_meta),
                },
            ]).unwrap();
            tree.root = new_meta;
            tree.meta_generation += 1;

            let before = tree.occupancy_diagnostics().unwrap();
            assert_eq!(before.empty_non_root_leaves, 0);
            assert_eq!(before.unary_non_root_internal_nodes, 2);
            assert!(before.root_is_unary_internal);

            assert!(tree.remove(&key).unwrap());
            assert_eq!(tree.height(), 0);
            assert_eq!(tree.root_page_id(), leaf_id);
            assert_eq!(tree.get(&key).unwrap(), None);
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 0);
            assert_eq!(report.free_pages, 1);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.height(), 0);
            assert_eq!(reopened.get(&key).unwrap(), None);
            assert_eq!(reopened.validate().unwrap().free_pages, 1);
            reopened.insert(key.clone(), b"again".to_vec()).unwrap();
            assert_eq!(reopened.get(&key).unwrap(), Some(b"again".to_vec()));
            assert_eq!(reopened.validate().unwrap().free_pages, 0);
        }
        cleanup(&p, &w);
    }



    #[test]
    fn deleting_last_key_merges_internal_siblings_and_contracts_root() {
        let (p, w) = paths();
        let key = b"a".to_vec();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let left_leaf_id = tree.root.root_id;
            let middle_leaf_id = 2;
            let right_leaf_id = 3;
            let right_internal_id = 4;
            let left_internal_id = 5;
            let root_id = 6;

            let left_leaf = BTreeNode::Leaf {
                next_leaf: Some(middle_leaf_id),
                entries: vec![LeafEntry { key: key.clone(), value: b"left".to_vec() }],
            };
            let middle_leaf = BTreeNode::Leaf {
                next_leaf: Some(right_leaf_id),
                entries: vec![LeafEntry { key: b"m".to_vec(), value: b"middle".to_vec() }],
            };
            let right_leaf = BTreeNode::Leaf {
                next_leaf: None,
                entries: vec![LeafEntry { key: b"z".to_vec(), value: b"right".to_vec() }],
            };
            let left_internal = BTreeNode::Internal {
                level: 1,
                first_child: left_leaf_id,
                entries: Vec::new(),
            };
            let right_internal = BTreeNode::Internal {
                level: 1,
                first_child: middle_leaf_id,
                entries: vec![InternalEntry { separator: b"z".to_vec(), right_child: right_leaf_id }],
            };
            let root = BTreeNode::Internal {
                level: 2,
                first_child: left_internal_id,
                entries: vec![InternalEntry { separator: b"m".to_vec(), right_child: right_internal_id }],
            };
            let new_meta = RootMeta { root_id, level: 2, free_head: None };
            tree.pages.transaction(vec![
                PageChange::Overwrite {
                    page_id: left_leaf_id,
                    expected_generation: 1,
                    new_generation: 2,
                    payload: encode_node(&left_leaf).unwrap(),
                },
                PageChange::Allocate { generation: 1, payload: encode_node(&middle_leaf).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&right_leaf).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&right_internal).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&left_internal).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&root).unwrap() },
                PageChange::Overwrite {
                    page_id: 0,
                    expected_generation: tree.meta_generation,
                    new_generation: tree.meta_generation + 1,
                    payload: encode_meta(&new_meta),
                },
            ]).unwrap();
            tree.root = new_meta;
            tree.meta_generation += 1;

            assert!(tree.remove(&key).unwrap());
            assert_eq!(tree.height(), 1, "la raíz debe contraerse tras fusionar los nodos internos");
            assert_eq!(tree.root_page_id(), left_internal_id);
            assert_eq!(tree.get(&key).unwrap(), None);
            assert_eq!(tree.get(b"m").unwrap(), Some(b"middle".to_vec()));
            assert_eq!(tree.get(b"z").unwrap(), Some(b"right".to_vec()));
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 2);
            assert_eq!(report.leaf_pages, 2);
            assert_eq!(report.free_pages, 3, "el nodo interno derecho, la raíz anterior y la hoja vacía deben liberarse");
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.height(), 1);
            assert_eq!(reopened.get(&key).unwrap(), None);
            assert_eq!(reopened.get(b"m").unwrap(), Some(b"middle".to_vec()));
            assert_eq!(reopened.get(b"z").unwrap(), Some(b"right".to_vec()));
            assert_eq!(reopened.validate().unwrap().free_pages, 3);
            let page_count_before_reuse = reopened.page_count();
            reopened.insert(b"aa".to_vec(), vec![1; 3000]).unwrap();
            reopened.insert(b"ab".to_vec(), vec![2; 3000]).unwrap();
            assert_eq!(reopened.page_count(), page_count_before_reuse,
                "la división de hoja debe reutilizar una página interna liberada");
            assert_eq!(reopened.get(b"aa").unwrap(), Some(vec![1; 3000]));
            assert_eq!(reopened.get(b"ab").unwrap(), Some(vec![2; 3000]));
            assert_eq!(reopened.validate().unwrap().free_pages, 1);
        }
        cleanup(&p, &w);
    }



    #[test]
    fn deleting_last_key_borrows_child_from_right_internal_sibling() {
        let (p, w) = paths();
        let key = b"a".to_vec();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let left_leaf_id = tree.root.root_id;
            let z_leaf_id = 2;
            let zz_leaf_id = 3;
            let zzz_leaf_id = 4;
            let right_internal_id = 5;
            let left_internal_id = 6;
            let root_id = 7;

            let leaf = |key: &[u8], value: &[u8], next_leaf| BTreeNode::Leaf {
                next_leaf,
                entries: vec![LeafEntry { key: key.to_vec(), value: value.to_vec() }],
            };
            let left_leaf = leaf(&key, b"left", Some(z_leaf_id));
            let z_leaf = leaf(b"z", b"z-value", Some(zz_leaf_id));
            let zz_leaf = leaf(b"zz", b"zz-value", Some(zzz_leaf_id));
            let zzz_leaf = leaf(b"zzz", b"zzz-value", None);
            let left_internal = BTreeNode::Internal {
                level: 1,
                first_child: left_leaf_id,
                entries: Vec::new(),
            };
            let right_internal = BTreeNode::Internal {
                level: 1,
                first_child: z_leaf_id,
                entries: vec![
                    InternalEntry { separator: b"zz".to_vec(), right_child: zz_leaf_id },
                    InternalEntry { separator: b"zzz".to_vec(), right_child: zzz_leaf_id },
                ],
            };
            let root = BTreeNode::Internal {
                level: 2,
                first_child: left_internal_id,
                entries: vec![InternalEntry { separator: b"z".to_vec(), right_child: right_internal_id }],
            };
            tree.pages.transaction(vec![
                PageChange::Overwrite {
                    page_id: left_leaf_id,
                    expected_generation: 1,
                    new_generation: 2,
                    payload: encode_node(&left_leaf).unwrap(),
                },
                PageChange::Allocate { generation: 1, payload: encode_node(&z_leaf).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&zz_leaf).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&zzz_leaf).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&right_internal).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&left_internal).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&root).unwrap() },
                PageChange::Overwrite {
                    page_id: 0,
                    expected_generation: tree.meta_generation,
                    new_generation: tree.meta_generation + 1,
                    payload: encode_meta(&RootMeta { root_id, level: 2, free_head: None }),
                },
            ]).unwrap();
            tree.root = RootMeta { root_id, level: 2, free_head: None };
            tree.meta_generation += 1;

            assert!(tree.remove(&key).unwrap());
            assert_eq!(tree.height(), 1, "la reparación de la hoja y la fusión posterior contraen la raíz");
            assert_eq!(tree.get(&key).unwrap(), None);
            assert_eq!(tree.get(b"z").unwrap(), Some(b"z-value".to_vec()));
            assert_eq!(tree.get(b"zz").unwrap(), Some(b"zz-value".to_vec()));
            assert_eq!(tree.get(b"zzz").unwrap(), Some(b"zzz-value".to_vec()));
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 3);
            assert_eq!(report.leaf_pages, 3);
            assert_eq!(report.free_pages, 3);
            let occupancy = tree.occupancy_diagnostics().unwrap();
            assert_eq!(occupancy.empty_non_root_leaves, 0);
            assert_eq!(occupancy.unary_non_root_internal_nodes, 0);
            assert!(!occupancy.root_is_unary_internal);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.height(), 1);
            assert_eq!(reopened.get(&key).unwrap(), None);
            assert_eq!(reopened.get(b"zzz").unwrap(), Some(b"zzz-value".to_vec()));
            assert_eq!(reopened.validate().unwrap().entries, 3);
        }
        cleanup(&p, &w);
    }


    #[test]
    fn deleting_last_key_borrows_child_from_left_internal_sibling() {
        let (p, w) = paths();
        let key = b"zz".to_vec();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let a_leaf_id = tree.root.root_id;
            let m_leaf_id = 2;
            let z_leaf_id = 3;
            let zz_leaf_id = 4;
            let left_internal_id = 5;
            let right_internal_id = 6;
            let root_id = 7;
            let leaf = |key: &[u8], value: &[u8], next_leaf| BTreeNode::Leaf {
                next_leaf,
                entries: vec![LeafEntry { key: key.to_vec(), value: value.to_vec() }],
            };
            let a_leaf = leaf(b"a", b"a-value", Some(m_leaf_id));
            let m_leaf = leaf(b"m", b"m-value", Some(z_leaf_id));
            let z_leaf = leaf(b"z", b"z-value", Some(zz_leaf_id));
            let zz_leaf = leaf(&key, b"zz-value", None);
            let left_internal = BTreeNode::Internal {
                level: 1,
                first_child: a_leaf_id,
                entries: vec![
                    InternalEntry { separator: b"m".to_vec(), right_child: m_leaf_id },
                    InternalEntry { separator: b"z".to_vec(), right_child: z_leaf_id },
                ],
            };
            let right_internal = BTreeNode::Internal {
                level: 1,
                first_child: zz_leaf_id,
                entries: Vec::new(),
            };
            let root = BTreeNode::Internal {
                level: 2,
                first_child: left_internal_id,
                entries: vec![InternalEntry { separator: b"zz".to_vec(), right_child: right_internal_id }],
            };
            let new_meta = RootMeta { root_id, level: 2, free_head: None };
            tree.pages.transaction(vec![
                PageChange::Overwrite {
                    page_id: a_leaf_id,
                    expected_generation: 1,
                    new_generation: 2,
                    payload: encode_node(&a_leaf).unwrap(),
                },
                PageChange::Allocate { generation: 1, payload: encode_node(&m_leaf).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&z_leaf).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&zz_leaf).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&left_internal).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&right_internal).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&root).unwrap() },
                PageChange::Overwrite {
                    page_id: 0,
                    expected_generation: tree.meta_generation,
                    new_generation: tree.meta_generation + 1,
                    payload: encode_meta(&new_meta),
                },
            ]).unwrap();
            tree.root = new_meta;
            tree.meta_generation += 1;

            assert!(tree.remove(&key).unwrap());
            assert_eq!(tree.height(), 1);
            assert_eq!(tree.get(b"a").unwrap(), Some(b"a-value".to_vec()));
            assert_eq!(tree.get(b"m").unwrap(), Some(b"m-value".to_vec()));
            assert_eq!(tree.get(b"z").unwrap(), Some(b"z-value".to_vec()));
            assert_eq!(tree.get(&key).unwrap(), None);
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 3);
            assert_eq!(report.leaf_pages, 3);
            assert_eq!(report.free_pages, 3);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.height(), 1);
            assert_eq!(reopened.get(b"z").unwrap(), Some(b"z-value".to_vec()));
            assert_eq!(reopened.get(&key).unwrap(), None);
            assert_eq!(reopened.validate().unwrap().entries, 3);
        }
        cleanup(&p, &w);
    }


    #[test]
    fn deleting_last_key_propagates_through_multiple_unary_ancestors() {
        let (p, w) = paths();
        let key = b"a".to_vec();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let a_leaf_id = tree.root.root_id;
            let z_leaf_id = 2;
            let zz_leaf_id = 3;
            let zzz_leaf_id = 4;
            let right_l1a_id = 5;
            let right_l1b_id = 6;
            let right_l1c_id = 7;
            let right_l2_id = 8;
            let left_l1_id = 9;
            let left_l2_id = 10;
            let root_id = 11;
            let leaf = |key: &[u8], value: &[u8], next_leaf| BTreeNode::Leaf {
                next_leaf,
                entries: vec![LeafEntry { key: key.to_vec(), value: value.to_vec() }],
            };
            let a_leaf = leaf(&key, b"a-value", Some(z_leaf_id));
            let z_leaf = leaf(b"z", b"z-value", Some(zz_leaf_id));
            let zz_leaf = leaf(b"zz", b"zz-value", Some(zzz_leaf_id));
            let zzz_leaf = leaf(b"zzz", b"zzz-value", None);
            let unary = |first_child| BTreeNode::Internal {
                level: 1,
                first_child,
                entries: Vec::new(),
            };
            let right_l2 = BTreeNode::Internal {
                level: 2,
                first_child: right_l1a_id,
                entries: vec![
                    InternalEntry { separator: b"zz".to_vec(), right_child: right_l1b_id },
                    InternalEntry { separator: b"zzz".to_vec(), right_child: right_l1c_id },
                ],
            };
            let left_l2 = BTreeNode::Internal {
                level: 2,
                first_child: left_l1_id,
                entries: Vec::new(),
            };
            let root = BTreeNode::Internal {
                level: 3,
                first_child: left_l2_id,
                entries: vec![InternalEntry { separator: b"z".to_vec(), right_child: right_l2_id }],
            };
            let new_meta = RootMeta { root_id, level: 3, free_head: None };
            tree.pages.transaction(vec![
                PageChange::Overwrite {
                    page_id: a_leaf_id,
                    expected_generation: 1,
                    new_generation: 2,
                    payload: encode_node(&a_leaf).unwrap(),
                },
                PageChange::Allocate { generation: 1, payload: encode_node(&z_leaf).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&zz_leaf).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&zzz_leaf).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&unary(z_leaf_id)).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&unary(zz_leaf_id)).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&unary(zzz_leaf_id)).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&right_l2).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&unary(a_leaf_id)).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&left_l2).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&root).unwrap() },
                PageChange::Overwrite {
                    page_id: 0,
                    expected_generation: tree.meta_generation,
                    new_generation: tree.meta_generation + 1,
                    payload: encode_meta(&new_meta),
                },
            ]).unwrap();
            tree.root = new_meta;
            tree.meta_generation += 1;

            assert!(tree.remove(&key).unwrap());
            assert_eq!(tree.height(), 2);
            assert_eq!(tree.get(&key).unwrap(), None);
            assert_eq!(tree.get(b"z").unwrap(), Some(b"z-value".to_vec()));
            assert_eq!(tree.get(b"zz").unwrap(), Some(b"zz-value".to_vec()));
            assert_eq!(tree.get(b"zzz").unwrap(), Some(b"zzz-value".to_vec()));
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 3);
            assert_eq!(report.leaf_pages, 3);
            assert_eq!(report.free_pages, 5);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.height(), 2);
            assert_eq!(reopened.get(&key).unwrap(), None);
            assert_eq!(reopened.get(b"zz").unwrap(), Some(b"zz-value".to_vec()));
            assert_eq!(reopened.validate().unwrap().entries, 3);
            let reopened_occupancy = reopened.occupancy_diagnostics().unwrap();
            assert_eq!(reopened_occupancy.empty_non_root_leaves, 0);
            assert_eq!(reopened_occupancy.unary_non_root_internal_nodes, 1);
            assert!(!reopened_occupancy.root_is_unary_internal);
        }
        cleanup(&p, &w);
    }


    #[test]
    fn deleting_last_key_collapses_a_chain_of_unary_roots() {
        let (p, w) = paths();
        let key = b"chain-key".to_vec();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            tree.insert(key.clone(), b"chain-value".to_vec()).unwrap();
            let leaf_id = tree.root.root_id;
            let inner_l1_id = tree.page_count();
            let inner_l2_id = inner_l1_id + 1;
            let root_id = inner_l2_id + 1;
            let unary = |level, first_child| BTreeNode::Internal {
                level,
                first_child,
                entries: Vec::new(),
            };
            let new_meta = RootMeta { root_id, level: 3, free_head: tree.root.free_head };
            tree.pages.transaction(vec![
                PageChange::Allocate { generation: 1, payload: encode_node(&unary(1, leaf_id)).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&unary(2, inner_l1_id)).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&unary(3, inner_l2_id)).unwrap() },
                PageChange::Overwrite {
                    page_id: 0,
                    expected_generation: tree.meta_generation,
                    new_generation: tree.meta_generation + 1,
                    payload: encode_meta(&new_meta),
                },
            ]).unwrap();
            tree.root = new_meta;
            tree.meta_generation += 1;

            assert!(tree.remove(&key).unwrap());
            assert_eq!(tree.height(), 0);
            assert_eq!(tree.root_page_id(), leaf_id);
            assert_eq!(tree.get(&key).unwrap(), None);
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 0);
            assert_eq!(report.free_pages, 3);
            assert_eq!(tree.occupancy_diagnostics().unwrap(), OccupancyDiagnostics::default());
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.height(), 0);
            assert_eq!(reopened.get(&key).unwrap(), None);
            assert_eq!(reopened.validate().unwrap().free_pages, 3);
            assert_eq!(reopened.occupancy_diagnostics().unwrap(), OccupancyDiagnostics::default());
        }
        cleanup(&p, &w);
    }


    #[test]
    fn deleting_last_key_merges_internal_node_into_left_sibling() {
        let (p, w) = paths();
        let key = b"zz".to_vec();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let a_leaf_id = tree.root.root_id;
            let m_leaf_id = 2;
            let zz_leaf_id = 3;
            let left_internal_id = 4;
            let right_internal_id = 5;
            let root_id = 6;
            let leaf = |key: &[u8], value: &[u8], next_leaf| BTreeNode::Leaf {
                next_leaf,
                entries: vec![LeafEntry { key: key.to_vec(), value: value.to_vec() }],
            };
            let a_leaf = leaf(b"a", b"a-value", Some(m_leaf_id));
            let m_leaf = leaf(b"m", b"m-value", Some(zz_leaf_id));
            let zz_leaf = leaf(&key, b"zz-value", None);
            let left_internal = BTreeNode::Internal {
                level: 1,
                first_child: a_leaf_id,
                entries: vec![InternalEntry { separator: b"m".to_vec(), right_child: m_leaf_id }],
            };
            let right_internal = BTreeNode::Internal {
                level: 1,
                first_child: zz_leaf_id,
                entries: Vec::new(),
            };
            let root = BTreeNode::Internal {
                level: 2,
                first_child: left_internal_id,
                entries: vec![InternalEntry { separator: b"zz".to_vec(), right_child: right_internal_id }],
            };
            let new_meta = RootMeta { root_id, level: 2, free_head: None };
            tree.pages.transaction(vec![
                PageChange::Overwrite {
                    page_id: a_leaf_id,
                    expected_generation: 1,
                    new_generation: 2,
                    payload: encode_node(&a_leaf).unwrap(),
                },
                PageChange::Allocate { generation: 1, payload: encode_node(&m_leaf).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&zz_leaf).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&left_internal).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&right_internal).unwrap() },
                PageChange::Allocate { generation: 1, payload: encode_node(&root).unwrap() },
                PageChange::Overwrite {
                    page_id: 0,
                    expected_generation: tree.meta_generation,
                    new_generation: tree.meta_generation + 1,
                    payload: encode_meta(&new_meta),
                },
            ]).unwrap();
            tree.root = new_meta;
            tree.meta_generation += 1;

            assert!(tree.remove(&key).unwrap());
            assert_eq!(tree.height(), 1);
            assert_eq!(tree.root_page_id(), left_internal_id);
            assert_eq!(tree.get(b"a").unwrap(), Some(b"a-value".to_vec()));
            assert_eq!(tree.get(b"m").unwrap(), Some(b"m-value".to_vec()));
            assert_eq!(tree.get(&key).unwrap(), None);
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 2);
            assert_eq!(report.leaf_pages, 2);
            assert_eq!(report.free_pages, 3);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.height(), 1);
            assert_eq!(reopened.get(b"m").unwrap(), Some(b"m-value".to_vec()));
            assert_eq!(reopened.get(&key).unwrap(), None);
            assert_eq!(reopened.validate().unwrap().free_pages, 3);
        }
        cleanup(&p, &w);
    }


    #[test]
    fn mutation_session_observes_staged_insertions_when_removing() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let mut session = MutationSession::new(
                tree.root.clone(), tree.meta_generation, tree.pages.page_count(),
            );
            tree.insert_in_session(b"alpha", b"one", &mut session).unwrap();
            tree.insert_in_session(b"beta", b"two", &mut session).unwrap();
            assert!(tree.remove_in_session(b"alpha", &mut session).unwrap());
            assert!(!tree.remove_in_session(b"missing", &mut session).unwrap());
            assert_eq!(
                tree.read_node_overlay(&session.overlay, session.root.root_id).unwrap().1,
                BTreeNode::Leaf {
                    next_leaf: None,
                    entries: vec![LeafEntry { key: b"beta".to_vec(), value: b"two".to_vec() }],
                }
            );
            tree.commit_mutation_session(session).unwrap();
            assert_eq!(tree.get(b"alpha").unwrap(), None);
            assert_eq!(tree.get(b"beta").unwrap(), Some(b"two".to_vec()));
            assert_eq!(tree.validate().unwrap().entries, 1);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.get(b"alpha").unwrap(), None);
            assert_eq!(reopened.get(b"beta").unwrap(), Some(b"two".to_vec()));
            assert_eq!(reopened.validate().unwrap().entries, 1);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn mutation_session_can_reinsert_a_key_after_staged_removal() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            tree.insert(b"same".to_vec(), b"disk".to_vec()).unwrap();
            let mut session = MutationSession::new(
                tree.root.clone(), tree.meta_generation, tree.pages.page_count(),
            );
            assert!(tree.remove_in_session(b"same", &mut session).unwrap());
            tree.insert_in_session(b"same", b"staged-again", &mut session).unwrap();
            let (_, node) = tree.read_node_overlay(&session.overlay, session.root.root_id).unwrap();
            match node {
                BTreeNode::Leaf { entries, .. } => {
                    assert_eq!(entries.len(), 1);
                    assert_eq!(entries[0].key, b"same");
                    assert_eq!(entries[0].value, b"staged-again");
                }
                _ => panic!("la raíz debería seguir siendo hoja"),
            }
            tree.commit_mutation_session(session).unwrap();
            assert_eq!(tree.get(b"same").unwrap(), Some(b"staged-again".to_vec()));
            assert_eq!(tree.validate().unwrap().entries, 1);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.get(b"same").unwrap(), Some(b"staged-again".to_vec()));
        }
        cleanup(&p, &w);
    }

    #[test]
    fn mutation_session_repairs_empty_leaf_using_staged_overlay() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            for index in 0..48u8 {
                tree.insert(vec![index + 1], vec![b'x'; 180]).unwrap();
            }

            let mut leaf_id = tree.root.root_id;
            let mut expected_level = tree.root.level;
            let first_leaf_keys = loop {
                let page = tree.pages.read(leaf_id).unwrap();
                match BTreeNode::decode(&page.payload).unwrap() {
                    BTreeNode::Leaf { entries, .. } if expected_level == 0 => {
                        break entries.into_iter().map(|entry| entry.key).collect::<Vec<_>>();
                    }
                    BTreeNode::Internal { level, first_child, .. } if level == expected_level => {
                        leaf_id = first_child;
                        expected_level -= 1;
                    }
                    _ => panic!("estructura inesperada al localizar primera hoja"),
                }
            };
            assert!(!first_leaf_keys.is_empty());
            assert!(tree.root.level > 0);

            let mut session = MutationSession::new(
                tree.root.clone(), tree.meta_generation, tree.pages.page_count(),
            );
            for key in &first_leaf_keys {
                assert!(tree.remove_in_session(key, &mut session).unwrap());
            }
            tree.commit_mutation_session(session).unwrap();

            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 48 - first_leaf_keys.len());
            assert_eq!(tree.range(None, None).unwrap().len(), report.entries);
            for key in &first_leaf_keys {
                assert_eq!(tree.get(key).unwrap(), None);
            }
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            let report = reopened.validate().unwrap();
            assert_eq!(report.entries, reopened.range(None, None).unwrap().len());
        }
        cleanup(&p, &w);
    }

    #[test]
    fn mutation_session_removes_after_staged_root_and_leaf_splits() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let mut session = MutationSession::new(
                tree.root.clone(), tree.meta_generation, tree.pages.page_count(),
            );
            let keys = (0..64u8).map(|n| vec![n + 1]).collect::<Vec<_>>();
            for key in &keys {
                tree.insert_in_session(key, &vec![b'v'; 180], &mut session).unwrap();
            }
            assert!(session.root.level > 0);

            let mut first_leaf = session.root.root_id;
            let mut level = session.root.level;
            let first_keys = loop {
                let (_, node) = tree.read_node_overlay(&session.overlay, first_leaf).unwrap();
                match node {
                    BTreeNode::Internal { level: node_level, first_child, .. } if node_level == level => {
                        first_leaf = first_child;
                        level -= 1;
                    }
                    BTreeNode::Leaf { entries, .. } if level == 0 => {
                        break entries.into_iter().map(|entry| entry.key).collect::<Vec<_>>();
                    }
                    _ => panic!("estructura staged inesperada"),
                }
            };
            assert!(!first_keys.is_empty());
            for key in &first_keys {
                assert!(tree.remove_in_session(key, &mut session).unwrap());
            }
            tree.commit_mutation_session(session).unwrap();

            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 64 - first_keys.len());
            for key in &first_keys {
                assert_eq!(tree.get(key).unwrap(), None);
            }
            assert_eq!(tree.range(None, None).unwrap().len(), report.entries);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            let report = reopened.validate().unwrap();
            assert_eq!(report.entries, reopened.range(None, None).unwrap().len());
        }
        cleanup(&p, &w);
    }

    #[test]
    fn mutation_session_can_insert_delete_all_and_reuse_pages_atomically() {
        let (p, w) = paths();
        let keys = (0..48u8).map(|n| vec![n + 1]).collect::<Vec<_>>();
        let initial_page_count;
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            initial_page_count = tree.page_count();
            let mut session = MutationSession::new(
                tree.root.clone(), tree.meta_generation, tree.pages.page_count(),
            );
            for key in &keys {
                tree.insert_in_session(key, &vec![b'q'; 180], &mut session).unwrap();
            }
            assert!(session.root.level > 0);
            for key in &keys {
                assert!(tree.remove_in_session(key, &mut session).unwrap());
            }
            tree.commit_mutation_session(session).unwrap();

            assert_eq!(tree.height(), 0);
            assert_eq!(tree.validate().unwrap().entries, 0);
            assert!(tree.validate().unwrap().free_pages > 0);
        }
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let free_before = tree.validate().unwrap().free_pages;
            assert!(free_before > 0);
            let before_reuse = tree.page_count();
            tree.insert(vec![250], vec![b'r'; 180]).unwrap();
            assert_eq!(tree.page_count(), before_reuse);
            assert_eq!(tree.get(&[250]).unwrap(), Some(vec![b'r'; 180]));
            assert!(tree.validate().unwrap().free_pages < free_before);
            assert!(tree.page_count() >= initial_page_count);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn mixed_mutations_in_one_session_match_reference_map_after_reopen() {
        use std::collections::BTreeMap;

        let (p, w) = paths();
        let mut model = BTreeMap::<Vec<u8>, Vec<u8>>::new();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let mut session = MutationSession::new(
                tree.root.clone(), tree.meta_generation, tree.pages.page_count(),
            );
            let mut state = 0x7f4a_7c15u32;

            for step in 0..720u32 {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let id = (state >> 9) % 180;
                let key = format!("session-{id:04}").into_bytes();

                if state & 3 == 0 {
                    assert_eq!(
                        tree.remove_in_session(&key, &mut session).unwrap(),
                        model.remove(&key).is_some(),
                        "resultado de eliminación en paso {step}",
                    );
                } else {
                    let value_len = 72 + ((state >> 16) as usize % 210);
                    let value = vec![(step % 251) as u8; value_len];
                    tree.insert_in_session(&key, &value, &mut session).unwrap();
                    model.insert(key, value);
                }
            }

            tree.commit_mutation_session(session).unwrap();
            let expected = model.iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<Vec<_>>();
            assert_eq!(tree.range(None, None).unwrap(), expected);
            assert_eq!(tree.validate().unwrap().entries, model.len());
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            let expected = model.iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<Vec<_>>();
            assert_eq!(reopened.range(None, None).unwrap(), expected);
            assert_eq!(reopened.validate().unwrap().entries, model.len());
        }
        cleanup(&p, &w);
    }

    #[test]
    fn generated_committed_mutations_match_reference_and_survive_reopen() {
        use std::collections::BTreeMap;

        let (p, w) = paths();
        let mut model = BTreeMap::<Vec<u8>, Vec<u8>>::new();
        let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();

        for seed in [0x1357_9bdfu32, 0x2468_ace1, 0x91e1_0da5, 0x7f4a_7c15] {
            let mut state = seed;
            for step in 0..180u32 {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let id = (state >> 8) % 128;
                let key = format!("generated-{id:04}").into_bytes();

                if state & 3 == 0 {
                    assert_eq!(
                        tree.remove(&key).unwrap(),
                        model.remove(&key).is_some(),
                        "resultado de remove con seed {seed:#x}, paso {step}",
                    );
                } else {
                    let value_len = 24 + ((state >> 16) as usize % 480);
                    let value = vec![((state >> 24) as u8).wrapping_add(step as u8); value_len];
                    tree.insert(key.clone(), value.clone()).unwrap();
                    model.insert(key, value);
                }

                let expected = model.iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<Vec<_>>();
                assert_eq!(
                    tree.range(None, None).unwrap(),
                    expected,
                    "contenido tras seed {seed:#x}, paso {step}",
                );
                let report = tree.validate().unwrap();
                assert_eq!(report.entries, model.len());

                if step % 45 == 44 {
                    drop(tree);
                    tree = PersistentBPlusTree::open(&p, &w).unwrap();
                    assert_eq!(tree.range(None, None).unwrap(), expected);
                    assert_eq!(tree.validate().unwrap().entries, model.len());
                }
            }
        }

        drop(tree);
        let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
        let expected = model.iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Vec<_>>();
        assert_eq!(reopened.range(None, None).unwrap(), expected);
        assert_eq!(reopened.validate().unwrap().entries, model.len());
        cleanup(&p, &w);
    }

    #[test]
    fn generated_public_deletions_rebalance_and_survive_periodic_reopen() {
        use std::collections::BTreeMap;

        let (p, w) = paths();
        let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
        let mut model = BTreeMap::<Vec<u8>, Vec<u8>>::new();

        for seed in [0xdead_beefu32, 0x3141_5926, 0x2718_2818] {
            let keys = (0..112u32)
                .map(|id| format!("delete-{seed:08x}-{id:04}").into_bytes())
                .collect::<Vec<_>>();
            for (index, key) in keys.iter().enumerate() {
                let value = vec![((index as u8).wrapping_mul(13)).wrapping_add(seed as u8); 176];
                tree.insert(key.clone(), value.clone()).unwrap();
                model.insert(key.clone(), value);
            }
            assert!(tree.height() >= 1);

            let mut order = (0..keys.len()).collect::<Vec<_>>();
            let mut state = seed;
            for i in (1..order.len()).rev() {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                order.swap(i, (state as usize) % (i + 1));
            }

            for (position, index) in order.into_iter().enumerate() {
                let key = &keys[index];
                assert!(tree.remove(key).unwrap(), "clave ausente en seed {seed:#x}, posición {position}");
                assert!(model.remove(key).is_some());

                let expected = model.iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<Vec<_>>();
                assert_eq!(tree.range(None, None).unwrap(), expected);
                let report = tree.validate().unwrap();
                assert_eq!(report.entries, model.len());
                // Contrasta el inventario y los payloads del diagnóstico en cada
                // estado intermedio, no solo al final de cada lote de borrados.
                assert_occupancy_accounts_for_tree(&mut tree);

                if position % 28 == 27 {
                    drop(tree);
                    tree = PersistentBPlusTree::open(&p, &w).unwrap();
                    assert_eq!(tree.range(None, None).unwrap(), expected);
                    assert_eq!(tree.validate().unwrap().entries, model.len());
                    assert_occupancy_accounts_for_tree(&mut tree);
                }
            }

            assert!(model.is_empty());
            assert_eq!(tree.height(), 0);
            let report = tree.validate().unwrap();
            assert_eq!(report.leaf_pages, 1);
            assert!(report.free_pages > 0);
            let occupancy = tree.occupancy_diagnostics().unwrap();
            assert_eq!(occupancy.empty_non_root_leaves, 0);
            assert_eq!(occupancy.unary_non_root_internal_nodes, 0);
            assert!(!occupancy.root_is_unary_internal);
        }

        drop(tree);
        let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
        assert_eq!(reopened.validate().unwrap().entries, 0);
        assert_eq!(reopened.height(), 0);
        cleanup(&p, &w);
    }

    #[test]
    fn exact_leaf_payload_boundary_is_accepted_and_one_byte_over_is_atomic() {
        let (pages, wal) = paths();
        let exact_value = vec![b'e'; PAGE_PAYLOAD - 27];
        let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();

        // Header (20) + longitud de clave/valor (6) + clave (1)
        // + valor (4039) ocupa exactamente los 4066 bytes disponibles.
        tree.insert(b"k".to_vec(), exact_value.clone()).unwrap();
        assert_eq!(tree.get(b"k").unwrap(), Some(exact_value.clone()));
        assert_eq!(tree.validate().unwrap().entries, 1);

        // La segunda entrada fuerza un split; la entrada de tamaño límite
        // debe permanecer íntegra en una de las dos hojas.
        tree.insert(b"z".to_vec(), b"small".to_vec()).unwrap();
        assert_eq!(tree.get(b"k").unwrap(), Some(exact_value.clone()));
        assert_eq!(tree.get(b"z").unwrap(), Some(b"small".to_vec()));
        assert_eq!(tree.height(), 1);
        assert_eq!(tree.validate().unwrap().entries, 2);

        // Un byte adicional no cabe. El rechazo no debe sustituir el valor
        // confirmado ni dejar una mutación parcial en páginas/WAL.
        let too_large = vec![b'x'; PAGE_PAYLOAD - 26];
        assert!(matches!(
            tree.insert(b"k".to_vec(), too_large),
            Err(BTreeError::NoSpace)
        ));
        assert_eq!(tree.get(b"k").unwrap(), Some(exact_value.clone()));
        assert_eq!(tree.get(b"z").unwrap(), Some(b"small".to_vec()));
        assert_eq!(tree.validate().unwrap().entries, 2);

        drop(tree);
        let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
        assert_eq!(reopened.get(b"k").unwrap(), Some(exact_value));
        assert_eq!(reopened.get(b"z").unwrap(), Some(b"small".to_vec()));
        assert_eq!(reopened.validate().unwrap().entries, 2);
        cleanup(&pages, &wal);
    }

    #[test]
    fn maximum_tree_key_fits_internal_separator_after_leaf_split() {
        let (pages, wal) = paths();
        let key_a = vec![b'a'; MAX_TREE_KEY_LEN];
        let key_z = vec![b'z'; MAX_TREE_KEY_LEN];
        let value = b"v".to_vec();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            tree.insert(key_a.clone(), value.clone()).unwrap();
            tree.insert(key_z.clone(), value.clone()).unwrap();

            assert_eq!(tree.height(), 1);
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 2);
            assert_eq!(report.leaf_pages, 2);
            assert_eq!(tree.get(&key_a).unwrap(), Some(value.clone()));
            assert_eq!(tree.get(&key_z).unwrap(), Some(value.clone()));
        }
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            assert_eq!(tree.height(), 1);
            assert_eq!(tree.get(&key_a).unwrap(), Some(value.clone()));
            assert_eq!(tree.get(&key_z).unwrap(), Some(value));
            assert_eq!(tree.validate().unwrap().entries, 2);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn three_maximum_size_keys_split_internal_root_and_survive_reopen() {
        let (pages, wal) = paths();
        let keys = [b'a', b'm', b'z']
            .into_iter()
            .map(|byte| vec![byte; MAX_TREE_KEY_LEN])
            .collect::<Vec<_>>();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            for (index, key) in keys.iter().enumerate() {
                tree.insert(key.clone(), vec![index as u8]).unwrap();
            }

            assert_eq!(tree.height(), 2);
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 3);
            assert_eq!(report.leaf_pages, 3);
            for (index, key) in keys.iter().enumerate() {
                assert_eq!(tree.get(key).unwrap(), Some(vec![index as u8]));
            }
        }
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            assert_eq!(tree.height(), 2);
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 3);
            assert_eq!(report.leaf_pages, 3);
            for (index, key) in keys.iter().enumerate() {
                assert_eq!(tree.get(key).unwrap(), Some(vec![index as u8]));
            }
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn five_maximum_size_keys_force_height_three_and_survive_reopen() {
        let (pages, wal) = paths();
        let keys = [0x10u8, 0x20, 0x30, 0x40, 0x50]
            .into_iter()
            .map(|byte| vec![byte; MAX_TREE_KEY_LEN])
            .collect::<Vec<_>>();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            for (index, key) in keys.iter().enumerate() {
                tree.insert(key.clone(), vec![index as u8]).unwrap();
                if index == 3 {
                    assert_eq!(tree.height(), 2, "cuatro claves máximas deben crear una raíz interna sobre dos niveles");
                }
            }
            assert_eq!(tree.height(), 3, "la quinta clave máxima debe dividir también la raíz interna");
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 5);
            assert_eq!(report.leaf_pages, 5);
            for (index, key) in keys.iter().enumerate() {
                assert_eq!(tree.get(key).unwrap(), Some(vec![index as u8]));
            }
        }
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            assert_eq!(tree.height(), 3);
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 5);
            assert_eq!(report.leaf_pages, 5);
            for (index, key) in keys.iter().enumerate() {
                assert_eq!(tree.get(key).unwrap(), Some(vec![index as u8]));
            }
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn height_three_maximum_key_tree_rebalances_after_each_delete_and_reopens() {
        let (pages, wal) = paths();
        let keys = [0x10u8, 0x20, 0x30, 0x40, 0x50]
            .into_iter()
            .map(|byte| vec![byte; MAX_TREE_KEY_LEN])
            .collect::<Vec<_>>();
        let order = [2usize, 0, 4, 1, 3];
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            for (index, key) in keys.iter().enumerate() {
                tree.insert(key.clone(), vec![index as u8]).unwrap();
            }
            assert_eq!(tree.height(), 3);
            for (remaining, index) in order.iter().enumerate() {
                assert_eq!(tree.remove(&keys[*index]).unwrap(), true);
                let report = tree.validate().unwrap();
                assert_eq!(report.entries, keys.len() - remaining - 1);
                for (key_index, key) in keys.iter().enumerate() {
                    let expected = if order[..=remaining].contains(&key_index) {
                        None
                    } else {
                        Some(vec![key_index as u8])
                    };
                    assert_eq!(tree.get(key).unwrap(), expected);
                }
                drop(tree);
                let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
                assert_eq!(reopened.validate().unwrap().entries, keys.len() - remaining - 1);
                for (key_index, key) in keys.iter().enumerate() {
                    let expected = if order[..=remaining].contains(&key_index) {
                        None
                    } else {
                        Some(vec![key_index as u8])
                    };
                    assert_eq!(reopened.get(key).unwrap(), expected);
                }
                tree = reopened;
            }
            assert_eq!(tree.height(), 0);
            assert_eq!(tree.validate().unwrap().entries, 0);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn batch_preparation_error_after_staged_changes_leaves_disk_and_wal_unchanged() {
        let (pages, wal) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            for id in 0..48u32 {
                tree.insert(format!("batch-rollback-{id:04}").into_bytes(), vec![id as u8; 80]).unwrap();
            }
            let before = tree.range(None, None).unwrap();
            let page_count = tree.page_count();
            let wal_len = std::fs::metadata(&wal).unwrap().len();
            let operations = vec![
                TreeMutation::Put { key: b"batch-rollback-new".to_vec(), value: b"must-not-persist".to_vec() },
                TreeMutation::Delete { key: b"batch-rollback-0007".to_vec() },
                TreeMutation::Put { key: vec![b'x'; MAX_TREE_KEY_LEN + 1], value: b"invalid-late-key".to_vec() },
            ];
            assert!(matches!(
                tree.apply_batch(operations),
                Err(BTreeError::Invalid("clave no cabe como separador interno"))
            ));
            assert_eq!(tree.page_count(), page_count);
            assert_eq!(std::fs::metadata(&wal).unwrap().len(), wal_len);
            assert_eq!(tree.range(None, None).unwrap(), before);
            assert_eq!(tree.get(b"batch-rollback-new").unwrap(), None);
            assert_eq!(tree.get(b"batch-rollback-0007").unwrap(), Some(vec![7; 80]));
            assert_eq!(tree.validate().unwrap().entries, 48);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
            assert_eq!(reopened.validate().unwrap().entries, 48);
            assert_eq!(reopened.get(b"batch-rollback-new").unwrap(), None);
            assert_eq!(reopened.get(b"batch-rollback-0007").unwrap(), Some(vec![7; 80]));
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn generated_batches_match_reference_model_and_survive_reopen() {
        use std::collections::BTreeMap;

        let (pages, wal) = paths();
        let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
        let mut model = BTreeMap::<Vec<u8>, Vec<u8>>::new();

        for seed in [0x1020_3040u32, 0x5566_7788, 0x9abc_def0, 0xfedc_ba98] {
            let mut state = seed;
            for batch_index in 0..20u32 {
                let mut operations = Vec::new();
                let mut expected_results = Vec::new();
                for operation_index in 0..12u32 {
                    state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    let id = (state >> 9) % 160;
                    let key = format!("batch-model-{id:04}").into_bytes();
                    if state & 3 == 0 {
                        let deleted = model.remove(&key).is_some();
                        operations.push(TreeMutation::Delete { key });
                        expected_results.push(TreeMutationResult::Delete { deleted });
                    } else {
                        let value_len = 16 + ((state >> 17) as usize % 240);
                        let value = vec![
                            ((state >> 24) as u8).wrapping_add(operation_index as u8)
                        ; value_len];
                        model.insert(key.clone(), value.clone());
                        operations.push(TreeMutation::Put { key, value });
                        expected_results.push(TreeMutationResult::Put);
                    }
                }

                assert_eq!(
                    tree.apply_batch(operations).unwrap(),
                    expected_results,
                    "resultados con seed {seed:#x}, lote {batch_index}"
                );
                let expected = model.iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<Vec<_>>();
                assert_eq!(
                    tree.range(None, None).unwrap(),
                    expected,
                    "contenido con seed {seed:#x}, lote {batch_index}"
                );
                assert_eq!(tree.validate().unwrap().entries, model.len());

                if batch_index % 5 == 4 {
                    drop(tree);
                    tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
                    assert_eq!(tree.range(None, None).unwrap(), expected);
                    assert_eq!(tree.validate().unwrap().entries, model.len());
                }
            }
        }

        drop(tree);
        let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
        let expected = model.iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Vec<_>>();
        assert_eq!(reopened.range(None, None).unwrap(), expected);
        assert_eq!(reopened.validate().unwrap().entries, model.len());
        assert_occupancy_accounts_for_tree(&mut reopened);
        cleanup(&pages, &wal);
    }

    #[test]
    fn batch_reuses_pages_freed_earlier_in_the_same_batch() {
        let (pages, wal) = paths();
        let old_keys = (0..96u32)
            .map(|id| format!("batch-reuse-old-{id:04}").into_bytes())
            .collect::<Vec<_>>();
        let new_keys = (0..96u32)
            .map(|id| format!("batch-reuse-new-{id:04}").into_bytes())
            .collect::<Vec<_>>();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            for (index, key) in old_keys.iter().enumerate() {
                tree.insert(key.clone(), vec![(index % 251) as u8; 160]).unwrap();
            }
            let page_count_before = tree.page_count();
            let mut operations = old_keys.iter()
                .cloned()
                .map(|key| TreeMutation::Delete { key })
                .collect::<Vec<_>>();
            operations.extend(new_keys.iter().enumerate().map(|(index, key)| {
                TreeMutation::Put {
                    key: key.clone(),
                    value: vec![(index % 239) as u8; 160],
                }
            }));

            let results = tree.apply_batch(operations).unwrap();
            assert_eq!(results.len(), 192);
            assert!(results[..96].iter().all(|result| *result == TreeMutationResult::Delete { deleted: true }));
            assert!(results[96..].iter().all(|result| *result == TreeMutationResult::Put));
            assert_eq!(
                tree.page_count(),
                page_count_before,
                "las inserciones deben consumir las páginas MBFR liberadas en el mismo lote"
            );
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, new_keys.len());
            for (index, key) in new_keys.iter().enumerate() {
                assert_eq!(tree.get(key).unwrap(), Some(vec![(index % 239) as u8; 160]));
            }
            for key in &old_keys {
                assert_eq!(tree.get(key).unwrap(), None);
            }
        }
        {
            let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
            assert_eq!(reopened.validate().unwrap().entries, new_keys.len());
            for (index, key) in new_keys.iter().enumerate() {
                assert_eq!(reopened.get(key).unwrap(), Some(vec![(index % 239) as u8; 160]));
            }
            for key in &old_keys {
                assert_eq!(reopened.get(key).unwrap(), None);
            }
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn deep_tree_batch_mixes_rebalance_insertions_and_deletions_across_reopen() {
        let (pages, wal) = paths();
        let initial = [0x10u8, 0x20, 0x30, 0x40, 0x50]
            .into_iter()
            .map(|byte| vec![byte; MAX_TREE_KEY_LEN])
            .collect::<Vec<_>>();
        let added = [0x00u8, 0x60, 0x70]
            .into_iter()
            .map(|byte| vec![byte; MAX_TREE_KEY_LEN])
            .collect::<Vec<_>>();
        let operations = vec![
            TreeMutation::Delete { key: initial[2].clone() },
            TreeMutation::Put { key: added[0].clone(), value: b"new-low".to_vec() },
            TreeMutation::Delete { key: initial[0].clone() },
            TreeMutation::Put { key: added[1].clone(), value: b"new-high".to_vec() },
            TreeMutation::Delete { key: initial[4].clone() },
            TreeMutation::Put { key: added[2].clone(), value: b"new-top".to_vec() },
            TreeMutation::Delete { key: vec![0x99; MAX_TREE_KEY_LEN] },
        ];
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            for (index, key) in initial.iter().enumerate() {
                tree.insert(key.clone(), vec![index as u8]).unwrap();
            }
            assert_eq!(tree.height(), 3, "el escenario inicial debe tener cuatro niveles contando hojas");

            let results = tree.apply_batch(operations).unwrap();
            assert_eq!(results, vec![
                TreeMutationResult::Delete { deleted: true },
                TreeMutationResult::Put,
                TreeMutationResult::Delete { deleted: true },
                TreeMutationResult::Put,
                TreeMutationResult::Delete { deleted: true },
                TreeMutationResult::Put,
                TreeMutationResult::Delete { deleted: false },
            ]);

            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 5);
            let expected = [
                (added[0].clone(), b"new-low".to_vec()),
                (initial[1].clone(), vec![1]),
                (initial[3].clone(), vec![3]),
                (added[1].clone(), b"new-high".to_vec()),
                (added[2].clone(), b"new-top".to_vec()),
            ];
            assert_eq!(tree.range(None, None).unwrap(), expected);
            for (key, value) in &expected {
                assert_eq!(tree.get(key).unwrap(), Some(value.clone()));
            }
            for key in [&initial[0], &initial[2], &initial[4]] {
                assert_eq!(tree.get(key).unwrap(), None);
            }
        }
        {
            let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let report = reopened.validate().unwrap();
            assert_eq!(report.entries, 5);
            assert_eq!(reopened.range(None, None).unwrap(), vec![
                (added[0].clone(), b"new-low".to_vec()),
                (initial[1].clone(), vec![1]),
                (initial[3].clone(), vec![3]),
                (added[1].clone(), b"new-high".to_vec()),
                (added[2].clone(), b"new-top".to_vec()),
            ]);
            for key in [&initial[0], &initial[2], &initial[4]] {
                assert_eq!(reopened.get(key).unwrap(), None);
            }
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn key_too_large_for_internal_separator_is_rejected_without_mutation() {
        let (pages, wal) = paths();
        let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
        let page_count = tree.pages.page_count();
        let oversized_key = vec![b'x'; MAX_TREE_KEY_LEN + 1];

        assert!(matches!(
            tree.insert(oversized_key, b"value".to_vec()),
            Err(BTreeError::Invalid("clave no cabe como separador interno"))
        ));
        assert_eq!(tree.pages.page_count(), page_count);
        assert_eq!(tree.height(), 0);
        assert_eq!(tree.validate().unwrap().entries, 0);

        drop(tree);
        let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
        assert_eq!(reopened.height(), 0);
        assert_eq!(reopened.validate().unwrap().entries, 0);
        assert_eq!(reopened.pages.page_count(), page_count);
        cleanup(&pages, &wal);
    }

    #[test]
    fn large_staged_insertions_split_internal_root_and_survive_reopen() {
        let (pages, wal) = paths();
        let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
        let value = vec![b'd'; 1800];
        let mut session = MutationSession::new(
            tree.root.clone(),
            tree.meta_generation,
            tree.pages.page_count(),
        );

        // Con entradas grandes se generan muchas hojas; el número de
        // separadores termina forzando también el split del nodo raíz interno.
        for index in 0..450u32 {
            let key = format!("deep-staged-{index:05}").into_bytes();
            tree.insert_in_session(&key, &value, &mut session).unwrap();
        }
        assert!(session.root.level >= 2, "se esperaba una raíz de al menos nivel 2");
        tree.commit_mutation_session(session).unwrap();

        let report = tree.validate().unwrap();
        assert_eq!(report.entries, 450);
        assert!(report.height >= 2);
        assert!(report.leaf_pages > 150);

        for index in [0, 1, 73, 224, 449] {
            let key = format!("deep-staged-{index:05}").into_bytes();
            assert_eq!(tree.get(&key).unwrap(), Some(value.clone()));
        }

        drop(tree);
        let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
        let reopened_report = reopened.validate().unwrap();
        assert_eq!(reopened_report.entries, 450);
        assert!(reopened_report.height >= 2);
        assert_eq!(reopened.range(None, None).unwrap().len(), 450);
        for index in [0, 1, 73, 224, 449] {
            let key = format!("deep-staged-{index:05}").into_bytes();
            assert_eq!(reopened.get(&key).unwrap(), Some(value.clone()));
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn abandoned_session_after_staged_delete_keeps_physical_tree_unchanged() {
        let (p, w) = paths();
        let keys = (0..48u32)
            .map(|n| format!("abort-delete-{n:04}").into_bytes())
            .collect::<Vec<_>>();
        let expected = keys.iter().enumerate()
            .map(|(i, key)| (key.clone(), vec![(i % 251) as u8; 120]))
            .collect::<Vec<_>>();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            for (key, value) in &expected {
                tree.insert(key.clone(), value.clone()).unwrap();
            }
            let before_pages = tree.page_count();
            let before_root = tree.root_page_id();
            let mut session = MutationSession::new(
                tree.root.clone(), tree.meta_generation, tree.pages.page_count(),
            );
            assert!(tree.remove_in_session(&keys[17], &mut session).unwrap());
            assert!(session.changed);
            assert!(matches!(
                tree.insert_in_session(b"", b"invalid", &mut session),
                Err(BTreeError::Invalid(_)),
            ));
            drop(session);

            assert_eq!(tree.page_count(), before_pages);
            assert_eq!(tree.root_page_id(), before_root);
            assert_eq!(tree.range(None, None).unwrap(), expected);
            assert_eq!(tree.validate().unwrap().entries, expected.len());
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.range(None, None).unwrap(), expected);
            assert_eq!(reopened.validate().unwrap().entries, expected.len());
        }
        cleanup(&p, &w);
    }

    #[test]
    fn shuffled_full_deletion_in_one_session_leaves_a_valid_empty_tree() {
        let (p, w) = paths();
        let keys = (0..168u32)
            .map(|n| format!("shuffle-delete-{n:04}").into_bytes())
            .collect::<Vec<_>>();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            for (index, key) in keys.iter().enumerate() {
                tree.insert(key.clone(), vec![(index % 239) as u8; 128]).unwrap();
            }
            assert!(tree.height() >= 1);

            let mut order = (0..keys.len()).collect::<Vec<_>>();
            let mut state = 0x91e1_0da5u32;
            for i in (1..order.len()).rev() {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                order.swap(i, (state as usize) % (i + 1));
            }

            let mut session = MutationSession::new(
                tree.root.clone(), tree.meta_generation, tree.pages.page_count(),
            );
            for index in order {
                assert!(
                    tree.remove_in_session(&keys[index], &mut session).unwrap(),
                    "la clave {index} debe existir antes de eliminarse",
                );
            }
            tree.commit_mutation_session(session).unwrap();

            assert_eq!(tree.height(), 0);
            assert!(tree.range(None, None).unwrap().is_empty());
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 0);
            assert_eq!(report.leaf_pages, 1);
            assert!(report.free_pages > 0);
            let occupancy = tree.occupancy_diagnostics().unwrap();
            assert_eq!(occupancy.empty_non_root_leaves, 0);
            assert_eq!(occupancy.unary_non_root_internal_nodes, 0);
            assert!(!occupancy.root_is_unary_internal);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            let report = reopened.validate().unwrap();
            assert_eq!(report.entries, 0);
            assert_eq!(report.leaf_pages, 1);
            assert!(report.free_pages > 0);
            assert_eq!(reopened.height(), 0);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn mutation_session_reuses_pages_freed_earlier_in_the_same_session() {
        let (p, w) = paths();
        let keys = (0..96u32)
            .map(|n| format!("reuse-session-{n:04}").into_bytes())
            .collect::<Vec<_>>();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            for (index, key) in keys.iter().enumerate() {
                tree.insert(key.clone(), vec![(index % 251) as u8; 160]).unwrap();
            }
            let page_count_before = tree.page_count();
            let mut session = MutationSession::new(
                tree.root.clone(), tree.meta_generation, tree.pages.page_count(),
            );

            for key in &keys {
                assert!(tree.remove_in_session(key, &mut session).unwrap());
            }
            assert!(session.free_head.is_some(), "la eliminación debe liberar páginas para reutilizar");

            for (index, key) in keys.iter().enumerate() {
                tree.insert_in_session(key, &vec![(index % 239) as u8; 160], &mut session).unwrap();
            }
            tree.commit_mutation_session(session).unwrap();

            assert_eq!(tree.page_count(), page_count_before, "la reinserción debe consumir páginas libres staged");
            assert_eq!(tree.validate().unwrap().entries, keys.len());
            for (index, key) in keys.iter().enumerate() {
                assert_eq!(tree.get(key).unwrap(), Some(vec![(index % 239) as u8; 160]));
            }
        }
        {
            let mut reopened = PersistentBPlusTree::open(&p, &w).unwrap();
            assert_eq!(reopened.validate().unwrap().entries, keys.len());
            for (index, key) in keys.iter().enumerate() {
                assert_eq!(reopened.get(key).unwrap(), Some(vec![(index % 239) as u8; 160]));
            }
        }
        cleanup(&p, &w);
    }

    #[test]
    fn removing_missing_key_does_not_mark_mutation_session_changed() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let mut session = MutationSession::new(
                tree.root.clone(), tree.meta_generation, tree.pages.page_count(),
            );
            assert!(!tree.remove_in_session(b"absent", &mut session).unwrap());
            assert!(!session.changed);
            tree.commit_mutation_session(session).unwrap();
            assert_eq!(tree.validate().unwrap().entries, 0);
        }
        cleanup(&p, &w);
    }

    #[test]
    fn missing_public_remove_is_noop_in_a_deep_multilevel_tree() {
        let (pages, wal) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let mut session = MutationSession::new(
                tree.root.clone(),
                tree.meta_generation,
                tree.pages.page_count(),
            );
            let mut expected = Vec::new();
            for id in 0..450u32 {
                let key = format!("deep-noop-{id:05}").into_bytes();
                let value = vec![(id % 251) as u8; 1800];
                tree.insert_in_session(&key, &value, &mut session).unwrap();
                expected.push((key, value));
            }
            assert!(session.root.level >= 2);
            tree.commit_mutation_session(session).unwrap();
            tree.checkpoint().unwrap();

            let before = tree.range(None, None).unwrap();
            assert_eq!(before, expected);
            let pages_len = std::fs::metadata(&pages).unwrap().len();
            let wal_len = std::fs::metadata(&wal).unwrap().len();
            let page_count = tree.page_count();
            let root_id = tree.root_page_id();
            let height = tree.height();
            let diagnostics = tree.occupancy_diagnostics().unwrap();

            assert!(!tree.remove(b"deep-noop-00225-missing").unwrap());

            assert_eq!(std::fs::metadata(&pages).unwrap().len(), pages_len);
            assert_eq!(std::fs::metadata(&wal).unwrap().len(), wal_len);
            assert_eq!(tree.page_count(), page_count);
            assert_eq!(tree.root_page_id(), root_id);
            assert_eq!(tree.height(), height);
            assert_eq!(tree.range(None, None).unwrap(), before);
            assert_eq!(tree.occupancy_diagnostics().unwrap(), diagnostics);
            assert_eq!(tree.validate().unwrap().entries, expected.len());
        }
        {
            let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
            assert_eq!(reopened.range(None, None).unwrap().len(), 450);
            assert_eq!(reopened.get(b"deep-noop-00225-missing").unwrap(), None);
            assert_eq!(reopened.validate().unwrap().entries, 450);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn public_remove_of_missing_key_preserves_pages_wal_and_generations() {
        let (pages, wal) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            tree.insert(b"alpha".to_vec(), b"left-value".to_vec()).unwrap();
            tree.insert(b"omega".to_vec(), b"right-value".to_vec()).unwrap();
            tree.checkpoint().unwrap();

            let pages_len = std::fs::metadata(&pages).unwrap().len();
            let wal_len = std::fs::metadata(&wal).unwrap().len();
            let page_count = tree.page_count();
            let root_id = tree.root_page_id();
            let height = tree.height();
            let metadata_generation = tree.pages.read(0).unwrap().generation;
            let root_generation = tree.pages.read(root_id).unwrap().generation;

            assert!(!tree.remove(b"middle").unwrap());

            assert_eq!(std::fs::metadata(&pages).unwrap().len(), pages_len);
            assert_eq!(std::fs::metadata(&wal).unwrap().len(), wal_len);
            assert_eq!(tree.page_count(), page_count);
            assert_eq!(tree.root_page_id(), root_id);
            assert_eq!(tree.height(), height);
            assert_eq!(tree.pages.read(0).unwrap().generation, metadata_generation);
            assert_eq!(tree.pages.read(root_id).unwrap().generation, root_generation);
            assert_eq!(tree.get(b"alpha").unwrap(), Some(b"left-value".to_vec()));
            assert_eq!(tree.get(b"omega").unwrap(), Some(b"right-value".to_vec()));
            assert_eq!(tree.validate().unwrap().entries, 2);
        }
        {
            let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
            assert_eq!(reopened.get(b"alpha").unwrap(), Some(b"left-value".to_vec()));
            assert_eq!(reopened.get(b"omega").unwrap(), Some(b"right-value".to_vec()));
            assert_eq!(reopened.get(b"middle").unwrap(), None);
            assert_eq!(reopened.validate().unwrap().entries, 2);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn occupancy_diagnostics_excludes_root_only_leaf_from_non_root_metrics() {
        let (pages, wal) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            assert_eq!(tree.validate().unwrap().entries, 0);
            let diagnostics = tree.occupancy_diagnostics().unwrap();
            assert_eq!(diagnostics.empty_non_root_leaves, 0);
            assert_eq!(diagnostics.unary_non_root_internal_nodes, 0);
            assert!(!diagnostics.root_is_unary_internal);
            assert_eq!(diagnostics.non_root_leaf_pages, 0);
            assert_eq!(diagnostics.non_root_internal_pages, 0);
            assert_eq!(diagnostics.non_root_leaf_payload_bytes, 0);
            assert_eq!(diagnostics.non_root_internal_payload_bytes, 0);
            assert_eq!(diagnostics.smallest_non_root_leaf_payload_bytes, None);
            assert_eq!(diagnostics.largest_non_root_leaf_payload_bytes, None);
            assert_eq!(diagnostics.smallest_non_root_internal_payload_bytes, None);
            assert_eq!(diagnostics.largest_non_root_internal_payload_bytes, None);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn occupancy_diagnostics_rejects_cycles_in_corrupt_tree() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            let root_id = tree.root.root_id;
            let corrupt_root = BTreeNode::Internal {
                level: 1,
                first_child: root_id,
                entries: Vec::new(),
            };
            let corrupt_meta = RootMeta {
                root_id,
                level: 1,
                free_head: tree.root.free_head,
            };
            tree.pages.transaction(vec![
                PageChange::Overwrite {
                    page_id: root_id,
                    expected_generation: 1,
                    new_generation: 2,
                    payload: encode_node(&corrupt_root).unwrap(),
                },
                PageChange::Overwrite {
                    page_id: 0,
                    expected_generation: tree.meta_generation,
                    new_generation: tree.meta_generation + 1,
                    payload: encode_meta(&corrupt_meta),
                },
            ]).unwrap();
            tree.root = corrupt_meta;
            tree.meta_generation += 1;

            assert!(matches!(
                tree.occupancy_diagnostics(),
                Err(BTreeError::Corrupt("ciclo o hijo compartido en diagnóstico de ocupación"))
            ));
        }
        cleanup(&p, &w);
    }


    #[test]
    fn occupancy_diagnostics_reports_reachable_empty_non_root_leaf() {
        let (p, w) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&p, &w).unwrap();
            tree.insert(b"a".to_vec(), vec![0x41; 3000]).unwrap();
            tree.insert(b"b".to_vec(), vec![0x42; 3000]).unwrap();

            let root_page = tree.pages.read(tree.root.root_id).unwrap();
            let (left_id, right_id) = match BTreeNode::decode(&root_page.payload).unwrap() {
                BTreeNode::Internal { level: 1, first_child, entries } if entries.len() == 1 => {
                    (first_child, entries[0].right_child)
                }
                other => panic!("se esperaba una raíz interna de dos hojas, se obtuvo {other:?}"),
            };
            let left_page = tree.pages.read(left_id).unwrap();
            let next_leaf = match BTreeNode::decode(&left_page.payload).unwrap() {
                BTreeNode::Leaf { next_leaf, entries } => {
                    assert_eq!(entries.len(), 1);
                    next_leaf
                }
                _ => panic!("el primer hijo debe ser hoja"),
            };
            assert_eq!(next_leaf, Some(right_id));

            // El árbol recién dividido no debe contener hojas vacías; además el
            // diagnóstico expone la ocupación lógica de las hojas no raíz.
            let baseline = tree.occupancy_diagnostics().unwrap();
            assert_eq!(baseline.empty_non_root_leaves, 0);
            assert_eq!(baseline.non_root_leaf_pages, 2);
            assert_eq!(baseline.non_root_internal_pages, 0);
            assert!(baseline.smallest_non_root_leaf_payload_bytes.is_some());
            assert!(baseline.largest_non_root_leaf_payload_bytes
                >= baseline.smallest_non_root_leaf_payload_bytes);
            let right_page = tree.pages.read(right_id).unwrap();
            let left_entries = match BTreeNode::decode(&left_page.payload).unwrap() {
                BTreeNode::Leaf { entries, .. } => entries,
                _ => unreachable!(),
            };
            let right_entries = match BTreeNode::decode(&right_page.payload).unwrap() {
                BTreeNode::Leaf { entries, .. } => entries,
                _ => unreachable!(),
            };
            assert_eq!(
                baseline.non_root_leaf_payload_bytes,
                leaf_encoded_size(&left_entries) + leaf_encoded_size(&right_entries)
            );
            assert!(baseline.non_root_leaf_payload_bytes < PAGE_PAYLOAD * baseline.non_root_leaf_pages);

            // Simula un underflow todavía alcanzable: la hoja queda vacía, pero
            // conserva el enlace al siguiente leaf y el separador sigue siendo válido.
            tree.pages.transaction(vec![PageChange::Overwrite {
                page_id: left_id,
                expected_generation: left_page.generation,
                new_generation: left_page.generation + 1,
                payload: encode_node(&BTreeNode::Leaf {
                    next_leaf: Some(right_id),
                    entries: Vec::new(),
                }).unwrap(),
            }]).unwrap();

            let validation = tree.validate().unwrap();
            assert_eq!(validation.entries, 1);
            assert_eq!(validation.leaf_pages, 2);
            let diagnostics = tree.occupancy_diagnostics().unwrap();
            assert_eq!(diagnostics.empty_non_root_leaves, 1);
            assert_eq!(diagnostics.unary_non_root_internal_nodes, 0);
            assert!(!diagnostics.root_is_unary_internal);
            assert_eq!(diagnostics.non_root_leaf_pages, 2);
            assert_eq!(diagnostics.non_root_internal_pages, 0);
            assert_eq!(diagnostics.underfilled_non_root_leaf_pages, 1);
            assert_eq!(diagnostics.underfilled_non_root_pages, 1);
            let empty_leaf_bytes = leaf_encoded_size(&[]);
            assert_eq!(diagnostics.smallest_non_root_leaf_payload_bytes, Some(empty_leaf_bytes));
            assert!(diagnostics.largest_non_root_leaf_payload_bytes.unwrap() > empty_leaf_bytes);
            assert_eq!(
                diagnostics.non_root_leaf_payload_bytes,
                empty_leaf_bytes + {
                    let right_page = tree.pages.read(right_id).unwrap();
                    match BTreeNode::decode(&right_page.payload).unwrap() {
                        BTreeNode::Leaf { entries, .. } => leaf_encoded_size(&entries),
                        _ => unreachable!(),
                    }
                }
            );
        }
        cleanup(&p, &w);
    }

    #[test]
    fn recovery_replays_batch_that_frees_and_reuses_mbfr_pages_after_partial_apply() {
        let (pages, wal) = paths();
        let old_keys = (0..96u32)
            .map(|id| format!("recover-mbfr-old-{id:04}").into_bytes())
            .collect::<Vec<_>>();
        let new_keys = (0..96u32)
            .map(|id| format!("recover-mbfr-new-{id:04}").into_bytes())
            .collect::<Vec<_>>();
        let page_count_before;
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            for (index, key) in old_keys.iter().enumerate() {
                tree.insert(key.clone(), vec![(index % 251) as u8; 160]).unwrap();
            }
            page_count_before = tree.page_count();
            let mut operations = old_keys.iter().cloned()
                .map(|key| TreeMutation::Delete { key })
                .collect::<Vec<_>>();
            operations.extend(new_keys.iter().enumerate().map(|(index, key)| {
                TreeMutation::Put {
                    key: key.clone(),
                    value: vec![(index % 239) as u8; 160],
                }
            }));

            tree.inject_apply_failure_after_images(1);
            assert!(matches!(
                tree.apply_batch(operations),
                Err(BTreeError::Journal(JournalError::Page(_)))
            ));
            assert!(matches!(
                tree.validate(),
                Err(BTreeError::Journal(JournalError::Invalid(
                    "se requiere cerrar y reabrir para completar recovery"
                )))
            ));
        }
        {
            let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let report = reopened.validate().unwrap();
            assert_eq!(report.entries, new_keys.len());
            assert_eq!(reopened.page_count(), page_count_before, "el lote debe reutilizar las páginas liberadas sin ampliar el archivo");
            for key in &old_keys {
                assert_eq!(reopened.get(key).unwrap(), None);
            }
            for (index, key) in new_keys.iter().enumerate() {
                assert_eq!(reopened.get(key).unwrap(), Some(vec![(index % 239) as u8; 160]));
            }
            assert_eq!(reopened.validate().unwrap().entries, new_keys.len());
        }
        cleanup(&pages, &wal);
    }


    #[test]
    fn generated_deep_batches_with_large_values_match_model_after_reopen() {
        use std::collections::BTreeMap;

        let (pages, wal) = paths();
        let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
        let mut model = BTreeMap::<Vec<u8>, Vec<u8>>::new();

        // Preparar una estructura profunda en un solo overlay para que los
        // lotes siguientes ejerciten divisiones y rebalanceos multinivel.
        let mut session = MutationSession::new(
            tree.root.clone(),
            tree.meta_generation,
            tree.pages.page_count(),
        );
        for id in 0..450u32 {
            let key = format!("deep-batch-stress-{id:05}").into_bytes();
            let value = vec![(id.wrapping_mul(17) % 251) as u8; 1800];
            tree.insert_in_session(&key, &value, &mut session).unwrap();
            model.insert(key, value);
        }
        assert!(session.root.level >= 2);
        tree.commit_mutation_session(session).unwrap();
        assert!(tree.height() >= 2);
        assert_eq!(tree.validate().unwrap().entries, model.len());
        let deep_diagnostics = tree.occupancy_diagnostics().unwrap();
        assert!(deep_diagnostics.non_root_leaf_pages > 0);
        assert!(deep_diagnostics.non_root_internal_pages > 0);
        assert!(deep_diagnostics.non_root_leaf_payload_bytes > 0);
        assert!(deep_diagnostics.non_root_internal_payload_bytes > 0);
        assert!(deep_diagnostics.smallest_non_root_leaf_payload_bytes
            <= deep_diagnostics.largest_non_root_leaf_payload_bytes);
        assert!(deep_diagnostics.smallest_non_root_internal_payload_bytes
            <= deep_diagnostics.largest_non_root_internal_payload_bytes);

        let mut state = 0x7a31_9d2bu32;
        for batch_index in 0..40u32 {
            let mut operations = Vec::new();
            let mut expected_results = Vec::new();
            for operation_index in 0..16u32 {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let id = (state >> 7) % 720;
                let key = format!("deep-batch-stress-{id:05}").into_bytes();
                if state & 7 < 3 {
                    let deleted = model.remove(&key).is_some();
                    operations.push(TreeMutation::Delete { key });
                    expected_results.push(TreeMutationResult::Delete { deleted });
                } else {
                    let value_len = 300 + ((state >> 15) as usize % 1900);
                    let value = vec![
                        ((state >> 23) as u8).wrapping_add(operation_index as u8);
                        value_len
                    ];
                    model.insert(key.clone(), value.clone());
                    operations.push(TreeMutation::Put { key, value });
                    expected_results.push(TreeMutationResult::Put);
                }
            }

            assert_eq!(
                tree.apply_batch(operations).unwrap(),
                expected_results,
                "resultados del lote profundo {batch_index}"
            );
            let expected = model.iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<Vec<_>>();
            assert_eq!(
                tree.range(None, None).unwrap(),
                expected,
                "modelo del lote profundo {batch_index}"
            );
            assert_eq!(tree.validate().unwrap().entries, model.len());
            assert_occupancy_accounts_for_tree(&mut tree);

            if batch_index % 5 == 4 {
                drop(tree);
                tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
                assert_eq!(tree.range(None, None).unwrap(), expected);
                assert_eq!(tree.validate().unwrap().entries, model.len());
                assert_occupancy_accounts_for_tree(&mut tree);
            }
        }

        drop(tree);
        let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
        let expected = model.iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Vec<_>>();
        assert_eq!(reopened.range(None, None).unwrap(), expected);
        assert_eq!(reopened.validate().unwrap().entries, model.len());
        cleanup(&pages, &wal);
    }


    #[test]
    fn generated_deep_insert_delete_cycles_rebalance_reopen_and_match_model() {
        use std::collections::BTreeMap;

        let (pages, wal) = paths();
        let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
        let mut model = BTreeMap::<Vec<u8>, Vec<u8>>::new();

        for round in 0..3u32 {
            // Valores grandes fuerzan varias hojas y niveles internos.
            for id in 0..180u32 {
                let key = format!("cycle-{round:02}-base-{id:04}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx").into_bytes();
                let value = vec![((id.wrapping_mul(19) + round) % 251) as u8; 1500];
                tree.insert(key.clone(), value.clone()).unwrap();
                model.insert(key, value);
            }
            assert!(tree.height() >= 2, "la ronda debe construir al menos tres niveles");

            let mut order = (0..180u32).collect::<Vec<_>>();
            let mut state = 0x9e37_79b9u32 ^ round.wrapping_mul(0x85eb_ca6b);
            for index in (1..order.len()).rev() {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                order.swap(index, (state as usize) % (index + 1));
            }

            for (step, id) in order.into_iter().enumerate() {
                let old_key = format!("cycle-{round:02}-base-{id:04}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx").into_bytes();
                assert_eq!(tree.remove(&old_key).unwrap(), model.remove(&old_key).is_some());

                // Intercalar nuevas claves con las eliminaciones provoca splits
                // y rebalanceos mientras todavía quedan ramas antiguas.
                let new_key = format!("cycle-{round:02}-replacement-{id:04}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx").into_bytes();
                let value_len = 900 + ((id as usize * 37 + step * 13) % 1100);
                let value = vec![(id as u8).wrapping_add(step as u8); value_len];
                tree.insert(new_key.clone(), value.clone()).unwrap();
                model.insert(new_key, value);

                if step % 3 == 0 {
                    let absent = format!("cycle-{round:02}-absent-{step:04}").into_bytes();
                    assert!(!tree.remove(&absent).unwrap());
                }

                let expected = model.iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<Vec<_>>();
                assert_eq!(tree.range(None, None).unwrap(), expected,
                    "contenido en ronda {round}, paso {step}");
                let report = tree.validate().unwrap();
                assert_eq!(report.entries, model.len());
                assert_occupancy_accounts_for_tree(&mut tree);

                if step % 12 == 11 {
                    drop(tree);
                    tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
                    assert_eq!(tree.range(None, None).unwrap(), expected);
                    assert_eq!(tree.validate().unwrap().entries, model.len());
                    assert_occupancy_accounts_for_tree(&mut tree);
                }
            }

            // Vaciar el conjunto de reemplazos en orden inverso y volver a
            // poblarlo: fuerza contracciones y nuevas expansiones de raíz.
            let replacement_keys = model.keys()
                .filter(|key| key.starts_with(format!("cycle-{round:02}-replacement-").as_bytes()))
                .cloned()
                .collect::<Vec<_>>();
            for (index, key) in replacement_keys.into_iter().rev().enumerate() {
                assert!(tree.remove(&key).unwrap());
                assert!(model.remove(&key).is_some());
                assert_occupancy_accounts_for_tree(&mut tree);
                if index % 12 == 11 {
                    drop(tree);
                    tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
                    assert_eq!(tree.range(None, None).unwrap(),
                        model.iter().map(|(k, v)| (k.clone(), v.clone())).collect::<Vec<_>>());
                    tree.validate().unwrap();
                    assert_occupancy_accounts_for_tree(&mut tree);
                }
            }
            assert!(model.is_empty());
            assert_eq!(tree.height(), 0);
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 0);
            assert_eq!(report.leaf_pages, 1);
            assert!(report.free_pages > 0);
            assert_occupancy_accounts_for_tree(&mut tree);
        }

        drop(tree);
        let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
        assert_eq!(reopened.validate().unwrap().entries, 0);
        assert_eq!(reopened.height(), 0);
        cleanup(&pages, &wal);
    }


    #[test]
    fn global_occupancy_repair_contracts_a_persisted_unary_root_chain() {
        let (pages, wal) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let leaf = BTreeNode::Leaf { next_leaf: None, entries: Vec::new() };
            let level_one = BTreeNode::Internal { level: 1, first_child: 2, entries: Vec::new() };
            let level_two = BTreeNode::Internal { level: 2, first_child: 3, entries: Vec::new() };
            let level_three = BTreeNode::Internal { level: 3, first_child: 4, entries: Vec::new() };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            for (id, node) in [(2, &leaf), (3, &level_one), (4, &level_two), (5, &level_three)] {
                overlay.stage_allocate(id, 1, encode_node(node).unwrap()).unwrap();
            }
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id: 5, level: 3, free_head: None }),
            ).unwrap();
            let mut free_head = None;
            overlay.stage_free_page(1, 1, &mut free_head).unwrap();
            overlay.validate().unwrap();
            tree.pages.transaction(overlay.into_changes()).unwrap();
        }

        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let before = tree.occupancy_diagnostics().unwrap();
            assert!(before.root_is_unary_internal);
            assert_eq!(before.unary_non_root_internal_nodes, 2);
            assert_eq!(before.empty_non_root_leaves, 1);

            let repaired = tree.repair_occupancy().unwrap();
            assert!(repaired > 0);
            assert_eq!(tree.height(), 0);
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 0);
            assert_eq!(report.leaf_pages, 1);
            assert_eq!(report.free_pages, 4);
            let after = tree.occupancy_diagnostics().unwrap();
            assert_eq!(after.empty_non_root_leaves, 0);
            assert_eq!(after.unary_non_root_internal_nodes, 0);
            assert!(!after.root_is_unary_internal);
        }

        {
            let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
            assert_eq!(reopened.height(), 0);
            assert_eq!(reopened.validate().unwrap().free_pages, 4);
            assert_eq!(reopened.repair_occupancy().unwrap(), 0);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn global_occupancy_repair_recovers_after_partial_page_apply() {
        let (pages, wal) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let leaf = BTreeNode::Leaf { next_leaf: None, entries: Vec::new() };
            let one = BTreeNode::Internal { level: 1, first_child: 2, entries: Vec::new() };
            let two = BTreeNode::Internal { level: 2, first_child: 3, entries: Vec::new() };
            let three = BTreeNode::Internal { level: 3, first_child: 4, entries: Vec::new() };
            let mut overlay = PageOverlay::new(tree.pages.page_count());
            for (id, node) in [(2, &leaf), (3, &one), (4, &two), (5, &three)] {
                overlay.stage_allocate(id, 1, encode_node(node).unwrap()).unwrap();
            }
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id: 5, level: 3, free_head: None }),
            ).unwrap();
            let mut free_head = None;
            overlay.stage_free_page(1, 1, &mut free_head).unwrap();
            tree.pages.transaction(overlay.into_changes()).unwrap();
        }

        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            tree.inject_apply_failure_after_images(1);
            assert!(matches!(
                tree.repair_occupancy(),
                Err(BTreeError::Journal(JournalError::Page(_)))
            ));
            assert!(matches!(
                tree.validate(),
                Err(BTreeError::Journal(JournalError::Invalid(
                    "se requiere cerrar y reabrir para completar recovery"
                )))
            ));
        }

        {
            let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
            assert_eq!(reopened.height(), 0);
            let report = reopened.validate().unwrap();
            assert_eq!(report.entries, 0);
            assert_eq!(report.leaf_pages, 1);
            assert_eq!(report.free_pages, 4);
            let diagnostics = reopened.occupancy_diagnostics().unwrap();
            assert_eq!(diagnostics.empty_non_root_leaves, 0);
            assert_eq!(diagnostics.unary_non_root_internal_nodes, 0);
            assert!(!diagnostics.root_is_unary_internal);
        }
        cleanup(&pages, &wal);
    }

    #[test]
    fn unary_root_chain_contracts_multiple_levels_and_reuses_each_page() {
        let (pages, wal) = paths();
        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            let leaf = BTreeNode::Leaf { next_leaf: None, entries: Vec::new() };
            let level_one = BTreeNode::Internal { level: 1, first_child: 2, entries: Vec::new() };
            let level_two = BTreeNode::Internal { level: 2, first_child: 3, entries: Vec::new() };
            let level_three = BTreeNode::Internal { level: 3, first_child: 4, entries: Vec::new() };
            let mut overlay = PageOverlay::new(tree.pages.page_count());

            for (id, node) in [(2, &leaf), (3, &level_one), (4, &level_two), (5, &level_three)] {
                overlay.stage_allocate(id, 1, encode_node(node).unwrap()).unwrap();
            }
            overlay.stage_overwrite(
                0,
                tree.meta_generation,
                tree.meta_generation + 1,
                encode_meta(&RootMeta { root_id: 5, level: 3, free_head: None }),
            ).unwrap();
            let mut free_head = None;
            overlay.stage_free_page(1, 1, &mut free_head).unwrap();

            tree.stage_root_contraction_overlay(5, 3, 4, &mut overlay, &mut free_head).unwrap();
            assert_eq!(free_head, Some(3));
            let metadata = decode_meta(overlay.payload(0).unwrap()).unwrap();
            assert_eq!(metadata.root_id, 2);
            assert_eq!(metadata.level, 0);
            assert_eq!(metadata.free_head, Some(3));
            assert!(matches!(
                overlay.pages.get(&3),
                Some(OverlayPageState::FreedAllocated { next: Some(4), .. })
            ));
            assert!(matches!(
                overlay.pages.get(&4),
                Some(OverlayPageState::FreedAllocated { next: Some(5), .. })
            ));
            assert!(matches!(
                overlay.pages.get(&5),
                Some(OverlayPageState::FreedAllocated { next: Some(1), .. })
            ));
            assert!(matches!(
                overlay.pages.get(&1),
                Some(OverlayPageState::FreedExisting { next: None, .. })
            ));
            overlay.validate().unwrap();

            tree.pages.transaction(overlay.into_changes()).unwrap();
        }

        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            assert_eq!(tree.height(), 0);
            let report = tree.validate().unwrap();
            assert_eq!(report.entries, 0);
            assert_eq!(report.leaf_pages, 1);
            assert_eq!(report.free_pages, 4);

            let page_count = tree.page_count();
            let large = vec![0x5a; 4039];
            tree.insert(b"m".to_vec(), large.clone()).unwrap();
            tree.insert(b"z".to_vec(), b"small".to_vec()).unwrap();
            assert_eq!(tree.page_count(), page_count);
            assert_eq!(tree.height(), 1);
            assert_eq!(tree.get(b"m").unwrap(), Some(large));
            assert_eq!(tree.get(b"z").unwrap(), Some(b"small".to_vec()));
            assert_eq!(tree.validate().unwrap().free_pages, 2);
        }

        {
            let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
            assert_eq!(tree.height(), 1);
            assert_eq!(tree.get(b"m").unwrap(), Some(vec![0x5a; 4039]));
            assert_eq!(tree.get(b"z").unwrap(), Some(b"small".to_vec()));
            assert_eq!(tree.validate().unwrap().free_pages, 2);
        }
        cleanup(&pages, &wal);
    }


    #[test]
    fn single_remove_recovers_atomically_after_each_partial_apply_position() {
        // Repite el mismo borrado con fallos inyectados después de 0..=8 imágenes.
        // Los valores bajos recorren prefijos parciales; los altos también cubren
        // el caso ambiguo en que todas las imágenes llegaron a páginas antes del Err.
        for applied_images in 0..=8 {
            let (pages, wal) = paths();
            {
                let mut tree = PersistentBPlusTree::open(&pages, &wal).unwrap();
                tree.insert(b"a".to_vec(), vec![0x41; 3000]).unwrap();
                tree.insert(b"b".to_vec(), vec![0x42; 3000]).unwrap();

                assert_eq!(tree.height(), 1, "las dos entradas deben forzar una raíz interna");
                assert_eq!(tree.validate().unwrap().entries, 2);

                // El borrado fusiona hojas, contrae la raíz y libera dos páginas.
                tree.inject_apply_failure_after_images(applied_images);
                assert!(
                    matches!(
                        tree.remove(b"a"),
                        Err(BTreeError::Journal(JournalError::Page(_)))
                    ),
                    "el fallo inyectado después de {applied_images} imágenes debe propagarse"
                );
                assert!(matches!(
                    tree.validate(),
                    Err(BTreeError::Journal(JournalError::Invalid(
                        "se requiere cerrar y reabrir para completar recovery"
                    )))
                ));
            }

            {
                let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
                assert_eq!(reopened.height(), 0, "la raíz debe quedar contraída tras recovery");
                assert_eq!(reopened.get(b"a").unwrap(), None);
                assert_eq!(reopened.get(b"b").unwrap(), Some(vec![0x42; 3000]));
                let report = reopened.validate().unwrap();
                assert_eq!(report.entries, 1);
                assert_eq!(report.leaf_pages, 1);
                assert_eq!(
                    report.free_pages, 2,
                    "la hoja fusionada y la raíz anterior deben quedar en MBFR"
                );
            }

            {
                let mut reopened = PersistentBPlusTree::open(&pages, &wal).unwrap();
                assert_eq!(reopened.height(), 0);
                assert_eq!(reopened.get(b"b").unwrap(), Some(vec![0x42; 3000]));
                assert_eq!(reopened.validate().unwrap().free_pages, 2);
            }
            cleanup(&pages, &wal);
        }
    }

}
