//! Chunked UTF-8 document storage for localized edits.
//!
//! Edits split and splice bounded string chunks. Bytes after the edited region
//! are not shifted or recopied; only the chunk index (a Vec of String handles)
//! may move. Lookup is currently linear in the number of chunks.

use std::ops::Range;

pub const MAX_TEXT_CHUNK_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextBufferError {
    InvalidRange,
    InvalidUtf8Boundary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkedText {
    chunks: Vec<String>,
    len_bytes: usize,
}

impl ChunkedText {
    pub fn new(text: impl Into<String>) -> Self {
        let text = text.into();
        let len_bytes = text.len();
        let mut chunks = Vec::new();
        let mut start = 0;
        while start < text.len() {
            let mut end = (start + MAX_TEXT_CHUNK_BYTES).min(text.len());
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            chunks.push(text[start..end].to_owned());
            start = end;
        }
        Self { chunks, len_bytes }
    }

    pub fn len(&self) -> usize { self.len_bytes }

    pub fn is_empty(&self) -> bool { self.len_bytes == 0 }

    pub fn chunk_count(&self) -> usize { self.chunks.len() }

    pub fn is_char_boundary(&self, offset: usize) -> bool {
        if offset > self.len_bytes { return false; }
        if offset == 0 || offset == self.len_bytes { return true; }
        let mut cursor = 0;
        for chunk in &self.chunks {
            let end = cursor + chunk.len();
            if offset == cursor || offset == end { return true; }
            if offset < end { return chunk.is_char_boundary(offset - cursor); }
            cursor = end;
        }
        false
    }

    pub fn get(&self, range: Range<usize>) -> Option<String> {
        if range.start > range.end || range.end > self.len_bytes
            || !self.is_char_boundary(range.start) || !self.is_char_boundary(range.end)
        {
            return None;
        }
        if range.is_empty() { return Some(String::new()); }
        let mut result = String::with_capacity(range.end - range.start);
        let mut cursor = 0;
        for chunk in &self.chunks {
            let chunk_end = cursor + chunk.len();
            let overlap_start = range.start.max(cursor);
            let overlap_end = range.end.min(chunk_end);
            if overlap_start < overlap_end {
                result.push_str(&chunk[overlap_start - cursor..overlap_end - cursor]);
            }
            if chunk_end >= range.end { break; }
            cursor = chunk_end;
        }
        Some(result)
    }

    pub fn to_string(&self) -> String {
        let mut text = String::with_capacity(self.len_bytes);
        for chunk in &self.chunks { text.push_str(chunk); }
        text
    }

    /// Replaces a UTF-8 range without copying the untouched suffix bytes.
    pub fn replace_range(
        &mut self,
        range: Range<usize>,
        replacement: &str,
    ) -> Result<(), TextBufferError> {
        if range.start > range.end || range.end > self.len_bytes {
            return Err(TextBufferError::InvalidRange);
        }
        if !self.is_char_boundary(range.start) || !self.is_char_boundary(range.end) {
            return Err(TextBufferError::InvalidUtf8Boundary);
        }

        // Splitting the end first and then the start preserves both logical offsets.
        let _end_index = self.split_at_byte(range.end)?;
        let start_index = self.split_at_byte(range.start)?;
        let end_index = self.split_at_byte(range.end)?;
        let inserted = Self::split_owned(replacement);
        let inserted_bytes = replacement.len();
        self.chunks.splice(start_index..end_index, inserted);
        self.len_bytes = self.len_bytes - (range.end - range.start) + inserted_bytes;
        self.coalesce_near(start_index);
        debug_assert_eq!(self.chunks.iter().map(String::len).sum::<usize>(), self.len_bytes);
        debug_assert!(self.chunks.iter().all(|chunk| chunk.len() <= MAX_TEXT_CHUNK_BYTES));
        Ok(())
    }

    fn split_owned(text: &str) -> Vec<String> {
        let mut chunks = Vec::new();
        let mut start = 0;
        while start < text.len() {
            let mut end = (start + MAX_TEXT_CHUNK_BYTES).min(text.len());
            while !text.is_char_boundary(end) { end -= 1; }
            chunks.push(text[start..end].to_owned());
            start = end;
        }
        chunks
    }

    /// Returns the chunk index at a logical byte offset, splitting one chunk if needed.
    fn split_at_byte(&mut self, offset: usize) -> Result<usize, TextBufferError> {
        if offset > self.len_bytes { return Err(TextBufferError::InvalidRange); }
        let mut cursor = 0;
        for index in 0..self.chunks.len() {
            let end = cursor + self.chunks[index].len();
            if offset == cursor { return Ok(index); }
            if offset < end {
                let local = offset - cursor;
                if !self.chunks[index].is_char_boundary(local) {
                    return Err(TextBufferError::InvalidUtf8Boundary);
                }
                let right = self.chunks[index].split_off(local);
                self.chunks.insert(index + 1, right);
                return Ok(index + 1);
            }
            if offset == end { return Ok(index + 1); }
            cursor = end;
        }
        Ok(self.chunks.len())
    }

    /// Merge only neighboring pieces around the edit; never rebuild the whole text.
    fn coalesce_near(&mut self, around: usize) {
        if self.chunks.len() < 2 { return; }
        let first = around.saturating_sub(1).min(self.chunks.len() - 2);
        let last = (around + 1).min(self.chunks.len() - 2);
        let mut index = first;
        while index <= last && index + 1 < self.chunks.len() {
            if self.chunks[index].len() + self.chunks[index + 1].len()
                <= MAX_TEXT_CHUNK_BYTES
            {
                let right = self.chunks.remove(index + 1);
                self.chunks[index].push_str(&right);
                if index > first { index -= 1; }
            } else {
                index += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_small_text_round_trip() {
        for source in ["", "hola", "El niño llegó."] {
            let text = ChunkedText::new(source);
            assert_eq!(text.to_string(), source);
            assert_eq!(text.len(), source.len());
        }
    }

    #[test]
    fn edits_at_start_middle_and_end_match_string_semantics() {
        let mut chunked = ChunkedText::new("0123456789");
        let mut plain = String::from("0123456789");
        for (range, replacement) in [(0..0, "A"), (4..6, "XYZ")] {
            chunked.replace_range(range.clone(), replacement).unwrap();
            plain.replace_range(range, replacement);
            assert_eq!(chunked.to_string(), plain);
        }
        let end = plain.len();
        chunked.replace_range(end..end, "!").unwrap();
        plain.replace_range(end..end, "!");
        assert_eq!(chunked.to_string(), plain);
    }

    #[test]
    fn utf8_edits_preserve_character_boundaries() {
        let mut text = ChunkedText::new("Año: niño 🐈");
        text.replace_range(6..12, "gato").unwrap();
        assert_eq!(text.to_string(), "Año: gato 🐈");
        assert_eq!(text.get(0..3).as_deref(), Some("Año"));
        assert_eq!(text.replace_range(2..3, "x"), Err(TextBufferError::InvalidUtf8Boundary));
    }

    #[test]
    fn invalid_ranges_leave_text_unchanged() {
        let mut text = ChunkedText::new("texto");
        assert_eq!(text.replace_range(4..2, "x"), Err(TextBufferError::InvalidRange));
        assert_eq!(text.replace_range(0..99, "x"), Err(TextBufferError::InvalidRange));
        assert_eq!(text.to_string(), "texto");
    }

    #[test]
    fn edits_cross_chunk_boundaries_without_changing_untouched_text() {
        let source = "a".repeat(MAX_TEXT_CHUNK_BYTES * 3) + "niño" + &"z".repeat(MAX_TEXT_CHUNK_BYTES * 2);
        let mut chunked = ChunkedText::new(source.clone());
        let mut plain = source;
        let start = MAX_TEXT_CHUNK_BYTES * 3 - 2;
        let end = MAX_TEXT_CHUNK_BYTES * 3 + 6;
        chunked.replace_range(start..end, "XYZ").unwrap();
        plain.replace_range(start..end, "XYZ");
        assert_eq!(chunked.to_string(), plain);
        assert!(chunked.chunk_count() >= 2);
    }

    #[test]
    fn repeated_local_insertions_and_deletions_remain_equivalent() {
        let mut chunked = ChunkedText::new("base");
        let mut plain = String::from("base");
        for index in 0..300 {
            let boundaries: Vec<usize> = plain.char_indices().map(|(i, _)| i)
                .chain(std::iter::once(plain.len())).collect();
            let at = boundaries[index % boundaries.len()];
            chunked.replace_range(at..at, "ñ").unwrap();
            plain.insert_str(at, "ñ");
            if plain.len() > 80 {
                let deletion_end = plain.char_indices().nth(1).map(|(i, _)| i)
                    .unwrap_or(plain.len());
                chunked.replace_range(0..deletion_end, "").unwrap();
                plain.replace_range(0..deletion_end, "");
            }
            assert_eq!(chunked.to_string(), plain);
        }
    }

    #[test]
    fn range_reads_only_requested_content_and_checks_utf8() {
        let text = ChunkedText::new("a".repeat(MAX_TEXT_CHUNK_BYTES) + "niño" + &"z".repeat(20));
        let start = MAX_TEXT_CHUNK_BYTES;
        assert_eq!(text.get(start..start + 6).as_deref(), Some("niño"));
        assert_eq!(text.get(start + 1..start + 6), None);
        assert_eq!(text.get(100..99), None);
    }

    #[test]
    fn range_reads_can_cross_chunk_boundaries() {
        let source = "a".repeat(MAX_TEXT_CHUNK_BYTES) + "niño" + &"z".repeat(10);
        let text = ChunkedText::new(source);
        let start = MAX_TEXT_CHUNK_BYTES - 2;
        assert_eq!(text.get(start..MAX_TEXT_CHUNK_BYTES + 2).as_deref(), Some("aañ"));
    }

    #[test]
    fn large_replacement_is_split_into_bounded_chunks() {
        let replacement = "ñ".repeat(MAX_TEXT_CHUNK_BYTES * 3);
        let mut text = ChunkedText::new("inicio-fin");
        text.replace_range(6..7, &replacement).unwrap();
        assert_eq!(text.len(), 10 - 1 + replacement.len());
        assert!(text.chunks.iter().all(|chunk| chunk.len() <= MAX_TEXT_CHUNK_BYTES));
        assert_eq!(text.to_string(), format!("inicio{replacement}fin"));
    }

    #[test]
    fn deterministic_unicode_edit_sequence_matches_standard_string() {
        let mut chunked = ChunkedText::new("Inicio: niño, café, acción, 🐈. Fin.");
        let mut plain = String::from("Inicio: niño, café, acción, 🐈. Fin.");
        let insertions = ["x", "ñ", "áé", "🐈", " ", "\\n", "palabra"];
        let mut seed = 0x5eed_u64;
        for step in 0..1_000 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let boundaries: Vec<usize> = plain.char_indices().map(|(i, _)| i)
                .chain(std::iter::once(plain.len())).collect();
            let start_index = (seed as usize) % boundaries.len();
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let end_index = start_index + ((seed as usize) % (boundaries.len() - start_index));
            let start = boundaries[start_index];
            let end = boundaries[end_index];
            let replacement = insertions[step % insertions.len()];
            chunked.replace_range(start..end, replacement).unwrap();
            plain.replace_range(start..end, replacement);
            assert_eq!(chunked.len(), plain.len());
            assert_eq!(chunked.to_string(), plain);
        }
    }

    #[test]
    fn localized_edits_do_not_rechunk_the_entire_untouched_suffix() {
        let source = "a".repeat(MAX_TEXT_CHUNK_BYTES * 20);
        let mut text = ChunkedText::new(source);
        let before = text.chunk_count();
        text.replace_range(10..11, "b").unwrap();
        assert_eq!(text.chunk_count(), before);
        assert_eq!(text.get(11..20).as_deref(), Some("aaaaaaaaa"));
    }


    #[test]
    fn initial_chunking_never_splits_a_multibyte_character() {
        let source = "a".repeat(MAX_TEXT_CHUNK_BYTES - 1) + "ñ" + "z";
        let text = ChunkedText::new(source.clone());
        assert_eq!(text.to_string(), source);
        assert!(text.chunks.iter().all(|chunk| chunk.len() <= MAX_TEXT_CHUNK_BYTES));
        assert_eq!(text.get(MAX_TEXT_CHUNK_BYTES - 1..MAX_TEXT_CHUNK_BYTES + 1).as_deref(), Some("ñ"));
    }

    #[test]
    fn deleting_entire_document_and_inserting_again_is_supported() {
        let mut text = ChunkedText::new("contenido 🐈");
        let end = text.len();
        text.replace_range(0..end, "").unwrap();
        assert!(text.is_empty());
        assert_eq!(text.chunk_count(), 0);
        text.replace_range(0..0, "nuevo ñ").unwrap();
        assert_eq!(text.to_string(), "nuevo ñ");
    }


    #[test]
    fn every_utf8_range_matches_string_after_mixed_edits() {
        let mut chunked = ChunkedText::new("Año 🐈\nUna frase con café.\nFin.");
        let mut plain = String::from("Año 🐈\nUna frase con café.\nFin.");

        let title_end = plain.find("Año").unwrap() + "Año".len();
        chunked.replace_range(0..title_end, "Capítulo").unwrap();
        plain.replace_range(0..title_end, "Capítulo");

        let coffee_start = plain.find("café").unwrap();
        let coffee_end = coffee_start + "café".len();
        chunked.replace_range(coffee_start..coffee_end, "té").unwrap();
        plain.replace_range(coffee_start..coffee_end, "té");

        let end = plain.len();
        chunked.replace_range(end..end, " ¡final!").unwrap();
        plain.replace_range(end..end, " ¡final!");

        assert_eq!(chunked.to_string(), plain);
        let boundaries: Vec<usize> = plain.char_indices().map(|(i, _)| i)
            .chain(std::iter::once(plain.len())).collect();
        for &a in &boundaries {
            for &b in boundaries.iter().filter(|&&b| b >= a) {
                assert_eq!(chunked.get(a..b).as_deref(), plain.get(a..b));
            }
        }
    }

    #[test]
    fn ten_thousand_deterministic_edits_preserve_chunk_invariants() {
        let mut chunked = ChunkedText::new("Comienzo: texto inicial 🐈");
        let mut plain = String::from("Comienzo: texto inicial 🐈");
        let replacements = ["", "x", "ñ", "acción", "🐈", "\\n", " palabra "];
        let mut seed = 0x9e37_79b9_u64;

        for step in 0..10_000 {
            let boundaries: Vec<usize> = plain.char_indices().map(|(i, _)| i)
                .chain(std::iter::once(plain.len())).collect();
            seed = seed.wrapping_mul(2862933555777941757).wrapping_add(3037000493);
            let start_index = (seed as usize) % boundaries.len();
            seed = seed.wrapping_mul(2862933555777941757).wrapping_add(3037000493);
            let end_index = start_index + ((seed as usize) % (boundaries.len() - start_index));
            let start = boundaries[start_index];
            let end = boundaries[end_index];
            let replacement = replacements[step % replacements.len()];

            chunked.replace_range(start..end, replacement).unwrap();
            plain.replace_range(start..end, replacement);

            assert_eq!(chunked.len(), plain.len(), "longitud en paso {step}");
            assert_eq!(chunked.to_string(), plain, "contenido en paso {step}");
            assert!(chunked.chunks.iter().all(|chunk| {
                !chunk.is_empty() && chunk.len() <= MAX_TEXT_CHUNK_BYTES
            }), "bloques inválidos en paso {step}");

            if step % 113 == 0 {
                let boundaries: Vec<usize> = plain.char_indices().map(|(i, _)| i)
                    .chain(std::iter::once(plain.len())).collect();
                for &offset in &boundaries {
                    assert!(chunked.is_char_boundary(offset));
                }
                assert!(!chunked.is_char_boundary(plain.len().saturating_add(1)));
            }
        }
    }

}
