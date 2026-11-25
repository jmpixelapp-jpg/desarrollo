//! Rope AVL implícito para texto UTF-8, utilizado por LiveSession.
use std::ops::Range;

pub const ROPE_LEAF_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RopeError { InvalidRange, InvalidUtf8Boundary }

#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
    Leaf(String),
    Branch { left: Box<Node>, right: Box<Node>, bytes: usize, height: u16, leaves: usize, newlines: usize },
}
use Node::*;

impl Node {
    fn bytes(&self) -> usize { match self { Leaf(s) => s.len(), Branch { bytes, .. } => *bytes } }
    fn height(&self) -> u16 { match self { Leaf(_) => 1, Branch { height, .. } => *height } }
    fn leaves(&self) -> usize { match self { Leaf(_) => 1, Branch { leaves, .. } => *leaves } }
    fn newlines(&self) -> usize {
        match self {
            Leaf(text) => text.as_bytes().iter().filter(|byte| **byte == b'\n').count(),
            Branch { newlines, .. } => *newlines,
        }
    }
    fn branch(left: Node, right: Node) -> Node {
        Branch {
            bytes: left.bytes() + right.bytes(),
            height: 1 + left.height().max(right.height()),
            leaves: left.leaves() + right.leaves(),
            newlines: left.newlines() + right.newlines(),
            left: Box::new(left), right: Box::new(right),
        }
    }
    fn into_children(self) -> (Node, Node) {
        match self { Branch { left, right, .. } => (*left, *right), Leaf(_) => unreachable!() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RopeText { root: Option<Box<Node>> }

impl RopeText {
    pub fn new(text: impl Into<String>) -> Self {
        let text = text.into();
        let mut leaves = Vec::new();
        let mut start = 0;
        while start < text.len() {
            let mut end = (start + ROPE_LEAF_BYTES).min(text.len());
            while !text.is_char_boundary(end) { end -= 1; }
            leaves.push(Leaf(text[start..end].to_owned()));
            start = end;
        }
        Self { root: build_balanced(leaves).map(Box::new) }
    }
    pub fn len(&self) -> usize { self.root.as_deref().map_or(0, Node::bytes) }
    pub fn is_empty(&self) -> bool { self.root.is_none() }
    pub fn leaf_count(&self) -> usize { self.root.as_deref().map_or(0, Node::leaves) }
    pub fn height(&self) -> u16 { self.root.as_deref().map_or(0, Node::height) }
    pub fn is_char_boundary(&self, offset: usize) -> bool {
        if offset > self.len() { return false; }
        if offset == 0 || offset == self.len() { return true; }
        boundary_at(self.root.as_deref().unwrap(), offset)
    }
    pub fn get(&self, range: Range<usize>) -> Option<String> {
        if range.start > range.end || range.end > self.len()
            || !self.is_char_boundary(range.start) || !self.is_char_boundary(range.end) { return None; }
        let mut out = String::with_capacity(range.end - range.start);
        if let Some(root) = &self.root { collect_range(root, 0, &range, &mut out); }
        Some(out)
    }

    /// Busca un byte ASCII desde un offset, sin materializar el documento.
    /// Devuelve el offset absoluto del primer resultado.
    pub fn find_byte_forward(&self, byte: u8, from: usize) -> Option<usize> {
        if from > self.len() { return None; }
        find_byte_forward_node(self.root.as_deref()?, 0, byte, from)
    }

    /// Busca hacia atrás un byte ASCII antes de `before` (límite exclusivo).
    /// Devuelve el offset absoluto del último resultado.
    pub fn find_byte_backward(&self, byte: u8, before: usize) -> Option<usize> {
        if before > self.len() { return None; }
        find_byte_backward_node(self.root.as_deref()?, 0, byte, before)
    }
    pub fn to_string(&self) -> String {
        let mut out = String::with_capacity(self.len());
        if let Some(root) = &self.root { flatten(root, &mut out); }
        out
    }
    pub fn replace_range(&mut self, range: Range<usize>, replacement: &str) -> Result<(), RopeError> {
        if range.start > range.end || range.end > self.len() { return Err(RopeError::InvalidRange); }
        if !self.is_char_boundary(range.start) || !self.is_char_boundary(range.end) {
            return Err(RopeError::InvalidUtf8Boundary);
        }
        let root = self.root.take().map(|n| *n);
        let (prefix_and_removed, suffix) = split(root, range.end);
        let (prefix, _removed) = split(prefix_and_removed, range.start);
        let middle = Self::new(replacement).root.map(|n| *n);
        self.root = join(join(prefix, middle), suffix).map(Box::new);
        Ok(())
    }
    pub fn validate(&self) -> bool {
        self.root.as_deref().map_or(true, |n| validate_node(n).is_some())
    }
}

fn build_balanced(nodes: Vec<Node>) -> Option<Node> {
    if nodes.is_empty() { return None; }
    fn rec(nodes: &mut std::vec::IntoIter<Node>, count: usize) -> Node {
        if count == 1 { return nodes.next().expect("cantidad de hojas coherente"); }
        let left_count = count / 2;
        let right_count = count - left_count;
        let left = rec(nodes, left_count);
        let right = rec(nodes, right_count);
        Node::branch(left, right)
    }
    let count = nodes.len();
    let mut nodes = nodes.into_iter();
    Some(rec(&mut nodes, count))
}
fn boundary_at(node: &Node, offset: usize) -> bool {
    match node {
        Leaf(s) => offset <= s.len() && s.is_char_boundary(offset),
        Branch { left, right, .. } => {
            let l = left.bytes();
            if offset < l { boundary_at(left, offset) }
            else if offset == l { true }
            else { boundary_at(right, offset - l) }
        }
    }
}

fn find_byte_forward_node(node: &Node, base: usize, byte: u8, from: usize) -> Option<usize> {
    let end = base + node.bytes();
    if from >= end || (byte == b'\n' && node.newlines() == 0) { return None; }
    match node {
        Leaf(text) => {
            let local_start = from.saturating_sub(base);
            text.as_bytes()[local_start..].iter().position(|value| *value == byte)
                .map(|relative| base + local_start + relative)
        }
        Branch { left, right, .. } => {
            let left_end = base + left.bytes();
            if from < left_end {
                find_byte_forward_node(left, base, byte, from)
                    .or_else(|| find_byte_forward_node(right, left_end, byte, from.max(left_end)))
            } else {
                find_byte_forward_node(right, left_end, byte, from)
            }
        }
    }
}

fn find_byte_backward_node(node: &Node, base: usize, byte: u8, before: usize) -> Option<usize> {
    if before <= base || (byte == b'\n' && node.newlines() == 0) { return None; }
    let end = base + node.bytes();
    match node {
        Leaf(text) => {
            let local_end = before.min(end) - base;
            text.as_bytes()[..local_end].iter().rposition(|value| *value == byte)
                .map(|relative| base + relative)
        }
        Branch { left, right, .. } => {
            let left_end = base + left.bytes();
            if before > left_end {
                find_byte_backward_node(right, left_end, byte, before)
                    .or_else(|| find_byte_backward_node(left, base, byte, before.min(left_end)))
            } else {
                find_byte_backward_node(left, base, byte, before)
            }
        }
    }
}

fn flatten(node: &Node, out: &mut String) {
    match node { Leaf(s) => out.push_str(s), Branch { left, right, .. } => { flatten(left, out); flatten(right, out); } }
}
fn collect_range(node: &Node, base: usize, range: &Range<usize>, out: &mut String) {
    let end = base + node.bytes();
    if range.start >= end || range.end <= base { return; }
    match node {
        Leaf(s) => {
            let a = range.start.max(base) - base;
            let b = range.end.min(end) - base;
            if a < b { out.push_str(&s[a..b]); }
        }
        Branch { left, right, .. } => {
            collect_range(left, base, range, out);
            collect_range(right, base + left.bytes(), range, out);
        }
    }
}
fn split(node: Option<Node>, offset: usize) -> (Option<Node>, Option<Node>) {
    let Some(node) = node else { return (None, None); };
    if offset == 0 { return (None, Some(node)); }
    if offset == node.bytes() { return (Some(node), None); }
    match node {
        Leaf(s) => {
            let a = s[..offset].to_owned();
            let b = s[offset..].to_owned();
            (if a.is_empty() { None } else { Some(Leaf(a)) },
             if b.is_empty() { None } else { Some(Leaf(b)) })
        }
        Branch { left, right, .. } => {
            let (left, right) = (*left, *right);
            if offset < left.bytes() {
                let (a, b) = split(Some(left), offset);
                (a, join(b, Some(right)))
            } else if offset == left.bytes() { (Some(left), Some(right)) }
            else {
                let (a, b) = split(Some(right), offset - left.bytes());
                (join(Some(left), a), b)
            }
        }
    }
}
fn join(left: Option<Node>, right: Option<Node>) -> Option<Node> {
    match (left, right) {
        (None, r) => r, (l, None) => l,
        (Some(l), Some(r)) => {
            match (l, r) {
                (Leaf(mut left), Leaf(right))
                    if left.len() + right.len() <= ROPE_LEAF_BYTES =>
                {
                    left.push_str(&right);
                    Some(Leaf(left))
                }
                (l, r) if l.height() > r.height() + 1 => {
                    let (ll, lr) = l.into_children();
                    Some(balance(ll, join(Some(lr), Some(r)).unwrap()))
                }
                (l, r) if r.height() > l.height() + 1 => {
                    let (rl, rr) = r.into_children();
                    Some(balance(join(Some(l), Some(rl)).unwrap(), rr))
                }
                (l, r) => Some(Node::branch(l, r)),
            }
        }
    }
}
fn balance(left: Node, right: Node) -> Node {
    if left.height() > right.height() + 1 {
        let (ll, lr) = left.into_children();
        if ll.height() >= lr.height() {
            let new_right = Node::branch(lr, right);
            Node::branch(ll, new_right)
        } else {
            let (lrl, lrr) = lr.into_children();
            Node::branch(Node::branch(ll, lrl), Node::branch(lrr, right))
        }
    } else if right.height() > left.height() + 1 {
        let (rl, rr) = right.into_children();
        if rr.height() >= rl.height() {
            Node::branch(Node::branch(left, rl), rr)
        } else {
            let (rll, rlr) = rl.into_children();
            Node::branch(Node::branch(left, rll), Node::branch(rlr, rr))
        }
    } else { Node::branch(left, right) }
}
fn validate_node(node: &Node) -> Option<(usize, u16, usize, usize)> {
    match node {
        Leaf(s) if !s.is_empty() && s.len() <= ROPE_LEAF_BYTES => Some((
            s.len(), 1, 1, s.as_bytes().iter().filter(|byte| **byte == b'\n').count(),
        )),
        Leaf(_) => None,
        Branch { left, right, bytes, height, leaves, newlines } => {
            let (lb, lh, ln, lnewlines) = validate_node(left)?;
            let (rb, rh, rn, rnewlines) = validate_node(right)?;
            let h = 1 + lh.max(rh);
            if *bytes != lb + rb || *height != h || *leaves != ln + rn
                || *newlines != lnewlines + rnewlines || lh.abs_diff(rh) > 1 {
                None
            } else { Some((*bytes, h, *leaves, *newlines)) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn empty_and_unicode_round_trip() {
        for s in ["", "Año 🐈\ntexto", "acción, café y corazón"] {
            let r = RopeText::new(s); assert_eq!(r.to_string(), s); assert!(r.validate());
        }
    }
    #[test] fn edits_match_string_and_keep_avl() {
        let source = "a".repeat(ROPE_LEAF_BYTES * 30) + "niño 🐈" + &"z".repeat(ROPE_LEAF_BYTES * 20);
        let mut rope = RopeText::new(source.clone()); let mut plain = source;
        let mut seed = 0x1234_5678_u64;
        for i in 0..3_000 {
            let bounds: Vec<usize> = plain.char_indices().map(|(p, _)| p).chain(std::iter::once(plain.len())).collect();
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let a = seed as usize % bounds.len();
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let b = a + seed as usize % (bounds.len() - a);
            let replacement = ["", "ñ", "🐈", "palabra", "acción"][i % 5];
            rope.replace_range(bounds[a]..bounds[b], replacement).unwrap();
            plain.replace_range(bounds[a]..bounds[b], replacement);
            assert_eq!(rope.to_string(), plain);
            assert!(rope.validate(), "AVL inválido en iteración {i}");
        }
    }
    #[test] fn invalid_utf8_boundary_does_not_mutate() {
        let mut r = RopeText::new("niño 🐈");
        assert_eq!(r.replace_range(2..3, "x"), Err(RopeError::InvalidUtf8Boundary));
        assert_eq!(r.to_string(), "niño 🐈");
    }
    #[test] fn repeated_edge_insertions_keep_tree_balanced() {
        let mut rope = RopeText::new("centro");
        let mut plain = String::from("centro");
        for i in 0..2_500 {
            let at = if i % 2 == 0 { 0 } else { plain.len() };
            rope.replace_range(at..at, "ñ").unwrap();
            plain.insert_str(at, "ñ");
            assert!(rope.validate(), "AVL inválido en inserción {i}");
            assert_eq!(rope.len(), plain.len());
        }
        assert_eq!(rope.to_string(), plain);
        let leaves = rope.leaf_count().max(1) as f64;
        let theoretical = (2.0 * (leaves + 1.0).log2()).ceil() as u16 + 1;
        assert!(rope.height() <= theoretical, "altura {} para {leaves} hojas", rope.height());
    }
    #[test] fn deleting_large_middle_range_preserves_prefix_suffix() {
        let prefix = "Año 🐈".to_owned();
        let middle = "contenido ".repeat(ROPE_LEAF_BYTES);
        let suffix = " final café";
        let source = format!("{prefix}{middle}{suffix}");
        let mut rope = RopeText::new(source.clone());
        let mut plain = source;
        let start = prefix.len();
        let end = start + middle.len();
        rope.replace_range(start..end, "").unwrap();
        plain.replace_range(start..end, "");
        assert_eq!(rope.to_string(), plain);
        assert!(rope.validate());
        assert!(rope.leaf_count() <= 2);
    }
    #[test] fn range_reads_match_string() {
        let s = "x".repeat(ROPE_LEAF_BYTES) + "niño" + &"z".repeat(ROPE_LEAF_BYTES);
        let r = RopeText::new(s.clone());
        for (a,b) in [(0,4),(ROPE_LEAF_BYTES-2,ROPE_LEAF_BYTES+2),(ROPE_LEAF_BYTES,ROPE_LEAF_BYTES+6),(s.len()-4,s.len())] {
            assert_eq!(r.get(a..b), s.get(a..b).map(str::to_owned));
        }
    }
    #[test]
    fn adjacent_small_leaves_are_coalesced_after_local_edits() {
        let mut rope = RopeText::new("x".repeat(ROPE_LEAF_BYTES * 4));
        let mut plain = "x".repeat(ROPE_LEAF_BYTES * 4);
        for index in 0..2_000 {
            let mut at = (index * 37) % (plain.len() + 1);
            while !plain.is_char_boundary(at) { at -= 1; }
            rope.replace_range(at..at, "ñ").unwrap();
            plain.insert_str(at, "ñ");
            if index % 3 == 0 {
                let start = at.min(plain.len());
                let end = (start + 2).min(plain.len());
                if plain.is_char_boundary(start) && plain.is_char_boundary(end) {
                    rope.replace_range(start..end, "").unwrap();
                    plain.replace_range(start..end, "");
                }
            }
            assert_eq!(rope.to_string(), plain, "contenido en paso {index}");
            assert!(rope.validate(), "AVL inválido en paso {index}");
        }
    }

    #[test]
    fn repeated_insert_delete_at_same_boundary_does_not_leave_tiny_leaf_per_edit() {
        let mut rope = RopeText::new("a".repeat(ROPE_LEAF_BYTES * 8));
        let offset = ROPE_LEAF_BYTES * 4;
        for _ in 0..1_000 {
            rope.replace_range(offset..offset, "ñ").unwrap();
            rope.replace_range(offset..offset + 2, "").unwrap();
            assert!(rope.validate());
        }
        assert_eq!(rope.leaf_count(), 8);
        assert_eq!(rope.len(), ROPE_LEAF_BYTES * 8);
    }

    #[test]
    fn byte_search_crosses_rope_branches_without_materializing_text() {
        let source = format!("{}\n{}\n{}", "a".repeat(ROPE_LEAF_BYTES), "b".repeat(ROPE_LEAF_BYTES), "c".repeat(ROPE_LEAF_BYTES));
        let rope = RopeText::new(source.clone());
        let newlines: Vec<usize> = source.match_indices('\n').map(|(at, _)| at).collect();
        assert_eq!(rope.find_byte_forward(b'\n', 0), newlines.first().copied());
        assert_eq!(rope.find_byte_forward(b'\n', newlines[0] + 1), newlines.get(1).copied());
        assert_eq!(rope.find_byte_forward(b'\n', source.len()), None);
        assert_eq!(rope.find_byte_backward(b'\n', source.len()), newlines.last().copied());
        assert_eq!(rope.find_byte_backward(b'\n', newlines[1]), newlines.first().copied());
        assert_eq!(rope.find_byte_backward(b'\n', 0), None);
        assert_eq!(rope.find_byte_forward(b'x', 0), None);
        assert_eq!(rope.find_byte_backward(b'x', source.len()), None);
    }

    #[test]
    fn newline_metadata_and_search_stay_consistent_after_random_edits() {
        let mut plain = String::new();
        for index in 0..900 {
            plain.push_str(&format!("línea {index}\n"));
        }
        let mut rope = RopeText::new(plain.clone());
        let mut seed = 0x7a31_5d29u64;
        for step in 0..96 {
            let boundaries: Vec<usize> = plain.char_indices().map(|(offset, _)| offset)
                .chain(std::iter::once(plain.len())).collect();
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let a = seed as usize % boundaries.len();
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let b = a + seed as usize % (boundaries.len() - a);
            let replacement = ["", "ñ\n", "texto", "\n\n"][step % 4];
            let start = boundaries[a];
            let end = boundaries[b];
            rope.replace_range(start..end, replacement).unwrap();
            plain.replace_range(start..end, replacement);
            assert!(rope.validate(), "metadatos AVL/newlines inválidos en {step}");
            let expected: Vec<usize> = plain.match_indices('\n').map(|(at, _)| at).collect();
            for &offset in &boundaries_for_test(&plain) {
                let index = expected.partition_point(|at| *at < offset);
                let forward = expected.get(index).copied();
                let backward = index.checked_sub(1).and_then(|previous| expected.get(previous).copied());
                assert_eq!(rope.find_byte_forward(b'\n', offset), forward);
                assert_eq!(rope.find_byte_backward(b'\n', offset), backward);
            }
        }
    }

    fn boundaries_for_test(text: &str) -> Vec<usize> {
        text.char_indices().map(|(offset, _)| offset)
            .chain(std::iter::once(text.len())).collect()
    }

    #[test]
    fn newline_pruning_handles_large_empty_subtrees_and_edge_edits() {
        let source = "x".repeat(ROPE_LEAF_BYTES * 16) + "fin";
        let mut rope = RopeText::new(source.clone());
        assert_eq!(rope.find_byte_forward(b'\n', 0), None);
        assert_eq!(rope.find_byte_backward(b'\n', rope.len()), None);

        let insertion = ROPE_LEAF_BYTES * 8;
        rope.replace_range(insertion..insertion, "\n").unwrap();
        assert_eq!(rope.find_byte_forward(b'\n', 0), Some(insertion));
        assert_eq!(rope.find_byte_forward(b'\n', insertion + 1), None);
        assert_eq!(rope.find_byte_backward(b'\n', insertion + 1), Some(insertion));
        assert_eq!(rope.find_byte_backward(b'\n', insertion), None);
        assert!(rope.validate());

        rope.replace_range(insertion..insertion + 1, "").unwrap();
        assert_eq!(rope.find_byte_forward(b'\n', 0), None);
        assert_eq!(rope.find_byte_backward(b'\n', rope.len()), None);
        assert!(rope.validate());
    }

    #[test]
    fn byte_search_handles_empty_and_invalid_offsets() {
        let empty = RopeText::new("");
        assert_eq!(empty.find_byte_forward(b'\n', 0), None);
        assert_eq!(empty.find_byte_backward(b'\n', 0), None);
        let rope = RopeText::new("uno\ndos");
        assert_eq!(rope.find_byte_forward(b'\n', rope.len() + 1), None);
        assert_eq!(rope.find_byte_backward(b'\n', rope.len() + 1), None);
    }

    #[test]
    fn byte_search_matches_string_for_every_offset_across_many_leaves() {
        let source = format!("{}\n{}\r\n{}\nfin", "a".repeat(ROPE_LEAF_BYTES + 3), "b".repeat(ROPE_LEAF_BYTES * 2), "c".repeat(ROPE_LEAF_BYTES + 7));
        let rope = RopeText::new(source.clone());
        for from in 0..=source.len() {
            let expected_forward = source.as_bytes()[from..].iter().position(|byte| *byte == b'\n')
                .map(|relative| from + relative);
            let expected_backward = source.as_bytes()[..from].iter().rposition(|byte| *byte == b'\n');
            assert_eq!(rope.find_byte_forward(b'\n', from), expected_forward, "forward desde {from}");
            assert_eq!(rope.find_byte_backward(b'\n', from), expected_backward, "backward antes de {from}");
        }
    }

}
