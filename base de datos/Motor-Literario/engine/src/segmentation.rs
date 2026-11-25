//! Segmentación determinista y ligera para análisis incremental.
//!
//! No interpreta significado ni corrige texto. Produce rangos UTF-8 estables
//! para que etapas posteriores procesen únicamente el párrafo afectado.

use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum FragmentKind { Paragraph, Sentence }

/// Segmenta un rango leído directamente desde RopeText, sin materializar el
/// documento completo. Los offsets emitidos permanecen absolutos en el libro.
pub fn segment_rope_range(
    rope: &crate::RopeText,
    start_byte: usize,
    end_byte: usize,
) -> Option<(String, Vec<TextFragment>)> {
    let fragment = rope.get(start_byte..end_byte)?;
    let segments = segment_fragment(&fragment, start_byte);
    Some((fragment, segments))
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct TextFragment {
    pub kind: FragmentKind,
    pub start_byte: usize,
    pub end_byte: usize,
    pub base_byte: usize,
}

impl TextFragment {
    pub fn slice<'a>(&self, text: &'a str) -> Option<&'a str> {
        let start = self.start_byte.checked_sub(self.base_byte)?;
        let end = self.end_byte.checked_sub(self.base_byte)?;
        text.get(start..end)
    }
}

/// Extrae el rango de párrafo afectado directamente desde RopeText.
/// Solo materializa las líneas y párrafos próximos a la selección.
pub fn affected_paragraph_range_rope(
    rope: &crate::RopeText,
    start_byte: usize,
    end_byte: usize,
) -> Option<(usize, usize)> {
    let text_len = rope.len();
    if start_byte > end_byte || end_byte > text_len
        || !rope.is_char_boundary(start_byte) || !rope.is_char_boundary(end_byte) {
        return None;
    }
    if text_len == 0 { return Some((0, 0)); }

    let scan_start = paragraph_scan_start_rope(rope, start_byte)?;
    let mut selected: Option<(usize, usize)> = None;
    let mut previous: Option<(usize, usize)> = None;
    let mut first: Option<(usize, usize)> = None;
    let mut last: Option<(usize, usize)> = None;
    let mut paragraph_start = scan_start;
    let mut offset = scan_start;
    let mut has_content = false;

    while offset < text_len {
        let line_end = rope.find_byte_forward(b'\n', offset)
            .map_or(text_len, |at| at + 1);
        let line = rope.get(offset..line_end)?;
        let content = line.strip_suffix('\n').unwrap_or(&line).trim_end_matches('\r');
        if content.trim().is_empty() {
            if has_content {
                let raw = rope.get(paragraph_start..offset)?;
                let leading = raw.len() - raw.trim_start().len();
                let trimmed_end = raw.trim_end().len();
                let current = (paragraph_start + leading, paragraph_start + trimmed_end);
                if let Some(prior) = previous {
                    let gap = (prior.1, current.0);
                    let intersects_gap = if start_byte == end_byte {
                        start_byte > gap.0 && start_byte < gap.1
                    } else {
                        start_byte < gap.1 && end_byte > gap.0
                    };
                    if intersects_gap {
                        merge_range(&mut selected, prior);
                        merge_range(&mut selected, current);
                    }
                }
                if selection_intersects(start_byte, end_byte, current) {
                    merge_range(&mut selected, current);
                }
                first.get_or_insert(current);
                last = Some(current);
                previous = Some(current);
                has_content = false;
                if end_byte <= current.1 { break; }
            }
            paragraph_start = line_end;
        } else {
            has_content = true;
        }
        offset = line_end;
    }

    if has_content {
        let raw = rope.get(paragraph_start..text_len)?;
        let leading = raw.len() - raw.trim_start().len();
        let trimmed_end = raw.trim_end().len();
        let current = (paragraph_start + leading, paragraph_start + trimmed_end);
        if let Some(prior) = previous {
            let gap = (prior.1, current.0);
            let intersects_gap = if start_byte == end_byte {
                start_byte > gap.0 && start_byte < gap.1
            } else {
                start_byte < gap.1 && end_byte > gap.0
            };
            if intersects_gap {
                merge_range(&mut selected, prior);
                merge_range(&mut selected, current);
            }
        }
        if selection_intersects(start_byte, end_byte, current) {
            merge_range(&mut selected, current);
        }
        first.get_or_insert(current);
        last = Some(current);
    }

    let (first_paragraph, last_paragraph) = match (first, last) {
        (Some(first), Some(last)) => (first, last),
        _ => return Some((0, text_len)),
    };
    if start_byte == end_byte && start_byte <= first_paragraph.0 {
        merge_range(&mut selected, first_paragraph);
    }
    if start_byte == end_byte && start_byte >= last_paragraph.1 {
        merge_range(&mut selected, last_paragraph);
    }
    if start_byte < first_paragraph.0 && end_byte <= first_paragraph.0 {
        merge_range(&mut selected, first_paragraph);
    }
    if start_byte >= last_paragraph.1 {
        merge_range(&mut selected, last_paragraph);
    }
    selected
}

fn paragraph_scan_start_rope(rope: &crate::RopeText, offset: usize) -> Option<usize> {
    let len = rope.len();
    let mut line_start = if offset == len
        && len > 0
        && rope.get(len - 1..len).as_deref() == Some("\n") {
        rope.find_byte_backward(b'\n', len - 1).map_or(0, |at| at + 1)
    } else {
        rope.find_byte_backward(b'\n', offset).map_or(0, |at| at + 1)
    };

    let current_line_end = rope.find_byte_forward(b'\n', line_start).unwrap_or(len);
    let current_line = rope.get(line_start..current_line_end)?;
    let current_is_blank = current_line.trim_end_matches('\r').trim().is_empty();
    let content_line = current_line.trim_end_matches('\r');
    let content_start = line_start + content_line.len() - content_line.trim_start().len();
    let selection_in_leading_indent = offset < content_start;

    if current_is_blank || selection_in_leading_indent {
        loop {
            let Some(previous_start) = rope_previous_line_start(rope, line_start) else {
                return Some(0);
            };
            line_start = previous_start;
            let previous_end = rope.find_byte_forward(b'\n', line_start).unwrap_or(len);
            let previous_line = rope.get(line_start..previous_end)?;
            if !previous_line.trim_end_matches('\r').trim().is_empty() { break; }
        }
    }
    loop {
        let Some(previous_start) = rope_previous_line_start(rope, line_start) else {
            return Some(line_start);
        };
        let previous_end = rope.find_byte_forward(b'\n', previous_start).unwrap_or(len);
        let previous_line = rope.get(previous_start..previous_end)?;
        if previous_line.trim_end_matches('\r').trim().is_empty() {
            return Some(line_start);
        }
        line_start = previous_start;
    }
}

fn rope_previous_line_start(rope: &crate::RopeText, line_start: usize) -> Option<usize> {
    if line_start == 0 { return None; }
    rope.find_byte_backward(b'\n', line_start - 1).map(|at| at + 1).or(Some(0))
}

/// Devuelve el tramo de párrafo afectado. Si la edición toca un separador
/// entre párrafos, incluye ambos vecinos. Los offsets son bytes UTF-8.
pub fn affected_paragraph_range(
    text: &str,
    start_byte: usize,
    end_byte: usize,
) -> Option<(usize, usize)> {
    if start_byte > end_byte || end_byte > text.len()
        || !text.is_char_boundary(start_byte) || !text.is_char_boundary(end_byte) {
        return None;
    }

    if text.is_empty() {
        return Some((0, 0));
    }

    // Localiza hacia atrás el inicio del párrafo que contiene la selección.
    // Si el cursor cae en una línea separadora, retrocede hasta el párrafo
    // anterior para poder invalidar ambos lados del separador.
    let scan_start = paragraph_scan_start(text, start_byte);
    let mut selected: Option<(usize, usize)> = None;
    let mut previous: Option<(usize, usize)> = None;
    let mut first: Option<(usize, usize)> = None;
    let mut last: Option<(usize, usize)> = None;
    let mut paragraph_start = scan_start;
    let mut offset = scan_start;
    let mut has_content = false;

    for line in text[scan_start..].split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line).trim_end_matches('\r');
        if content.trim().is_empty() {
            if has_content {
                let raw = &text[paragraph_start..offset];
                let leading = raw.len() - raw.trim_start().len();
                let trimmed_end = raw.trim_end().len();
                let current = (paragraph_start + leading, paragraph_start + trimmed_end);
                if let Some(prior) = previous {
                    let gap = (prior.1, current.0);
                    let intersects_gap = if start_byte == end_byte {
                        start_byte > gap.0 && start_byte < gap.1
                    } else {
                        start_byte < gap.1 && end_byte > gap.0
                    };
                    if intersects_gap {
                        merge_range(&mut selected, prior);
                        merge_range(&mut selected, current);
                    }
                }
                if selection_intersects(start_byte, end_byte, current) {
                    merge_range(&mut selected, current);
                }
                first.get_or_insert(current);
                last = Some(current);
                previous = Some(current);
                has_content = false;
                if end_byte <= current.1 {
                    break;
                }
            }
            paragraph_start = offset + line.len();
        } else {
            has_content = true;
        }
        offset += line.len();
    }

    if has_content {
        let raw = &text[paragraph_start..text.len()];
        let leading = raw.len() - raw.trim_start().len();
        let trimmed_end = raw.trim_end().len();
        let current = (paragraph_start + leading, paragraph_start + trimmed_end);
        if let Some(prior) = previous {
            let gap = (prior.1, current.0);
            let intersects_gap = if start_byte == end_byte {
                start_byte > gap.0 && start_byte < gap.1
            } else {
                start_byte < gap.1 && end_byte > gap.0
            };
            if intersects_gap {
                merge_range(&mut selected, prior);
                merge_range(&mut selected, current);
            }
        }
        if selection_intersects(start_byte, end_byte, current) {
            merge_range(&mut selected, current);
        }
        first.get_or_insert(current);
        last = Some(current);
    }

    let (first_paragraph, last_paragraph) = match (first, last) {
        (Some(first), Some(last)) => (first, last),
        _ => return Some((0, text.len())),
    };

    if start_byte == end_byte && start_byte <= first_paragraph.0 {
        merge_range(&mut selected, first_paragraph);
    }
    if start_byte == end_byte && start_byte >= last_paragraph.1 {
        merge_range(&mut selected, last_paragraph);
    }
    if start_byte < first_paragraph.0 && end_byte <= first_paragraph.0 {
        merge_range(&mut selected, first_paragraph);
    }
    if start_byte >= last_paragraph.1 {
        merge_range(&mut selected, last_paragraph);
    }

    selected
}

/// Devuelve el comienzo de la línea del párrafo que debe recorrer el buscador.
/// El retroceso se detiene en el separador anterior, no en el inicio del libro.
fn paragraph_scan_start(text: &str, offset: usize) -> usize {
    let mut line_start = if offset == text.len() && text.ends_with('\n') {
        text[..text.len().saturating_sub(1)]
            .rfind('\n').map_or(0, |index| index + 1)
    } else {
        text[..offset].rfind('\n').map_or(0, |index| index + 1)
    };

    let current_line_end = text[line_start..].find('\n')
        .map_or(text.len(), |relative| line_start + relative);
    let current_line = text[line_start..current_line_end].trim_end_matches('\r');
    let current_is_blank = current_line.trim().is_empty();
    let content_start = line_start + current_line.len() - current_line.trim_start().len();
    let selection_in_leading_indent = offset < content_start;

    if current_is_blank || selection_in_leading_indent {
        // La selección está dentro de un separador: incluye el párrafo previo.
        loop {
            let Some(previous_start) = previous_line_start(text, line_start) else {
                return 0;
            };
            line_start = previous_start;
            let end = text[line_start..].find('\n')
                .map_or(text.len(), |relative| line_start + relative);
            if !text[line_start..end].trim_end_matches('\r').trim().is_empty() {
                break;
            }
        }
    }

    loop {
        let Some(previous_start) = previous_line_start(text, line_start) else {
            return line_start;
        };
        let end = text[previous_start..].find('\n')
            .map_or(text.len(), |relative| previous_start + relative);
        if text[previous_start..end].trim_end_matches('\r').trim().is_empty() {
            return line_start;
        }
        line_start = previous_start;
    }
}

fn previous_line_start(text: &str, line_start: usize) -> Option<usize> {
    if line_start == 0 {
        return None;
    }
    Some(text[..line_start - 1].rfind('\n').map_or(0, |index| index + 1))
}

fn selection_intersects(start: usize, end: usize, range: (usize, usize)) -> bool {
    if start == end {
        start >= range.0 && start <= range.1
    } else {
        start < range.1 && end > range.0
    }
}

fn merge_range(selected: &mut Option<(usize, usize)>, range: (usize, usize)) {
    *selected = Some(match *selected {
        Some(current) => (current.0.min(range.0), current.1.max(range.1)),
        None => range,
    });
}

/// Segmenta un fragmento de texto sin modificarlo. Los espacios exteriores
/// no forman parte de los rangos, pero los saltos internos se conservan.
pub fn segment_fragment(text: &str, base_byte: usize) -> Vec<TextFragment> {
    segment_fragment_inner(text, base_byte, None).unwrap_or_default()
}

/// Variante cancelable para análisis en segundo plano. Comprueba la señal
/// periódicamente y no devuelve resultados parciales.
pub fn segment_fragment_cancellable(
    text: &str,
    base_byte: usize,
    cancelled: &AtomicBool,
) -> Option<Vec<TextFragment>> {
    segment_fragment_inner(text, base_byte, Some(cancelled))
}

fn segment_fragment_inner(
    text: &str,
    base_byte: usize,
    cancelled: Option<&AtomicBool>,
) -> Option<Vec<TextFragment>> {
    let mut fragments = Vec::new();
    let mut paragraph_start = 0;
    let mut offset = 0;
    for (index, line) in text.split_inclusive('\n').enumerate() {
        if index % 128 == 0 && cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return None;
        }
        let content = line.strip_suffix('\n').unwrap_or(line).trim_end_matches('\r');
        if content.trim().is_empty() {
            push_trimmed(&mut fragments, FragmentKind::Paragraph, text, paragraph_start, offset, base_byte);
            paragraph_start = offset + line.len();
        }
        offset += line.len();
    }
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) { return None; }
    push_trimmed(&mut fragments, FragmentKind::Paragraph, text, paragraph_start, text.len(), base_byte);

    let mut sentences = Vec::new();
    for paragraph in fragments.iter().copied() {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) { return None; }
        let Some(local_start) = paragraph.start_byte.checked_sub(base_byte) else { continue; };
        let Some(local_end) = paragraph.end_byte.checked_sub(base_byte) else { continue; };
        if !split_sentences(text, local_start, local_end, base_byte, &mut sentences, cancelled) {
            return None;
        }
    }
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) { return None; }
    fragments.extend(sentences);
    Some(fragments)
}

fn push_trimmed(
    output: &mut Vec<TextFragment>,
    kind: FragmentKind,
    text: &str,
    start: usize,
    end: usize,
    base: usize,
) {
    let slice = &text[start..end];
    let leading = slice.len() - slice.trim_start().len();
    let trimmed_end = slice.trim_end().len();
    if leading >= trimmed_end { return; }
    let Some(absolute_start) = base.checked_add(start).and_then(|value| value.checked_add(leading)) else {
        return;
    };
    let Some(absolute_end) = base.checked_add(start).and_then(|value| value.checked_add(trimmed_end)) else {
        return;
    };
    output.push(TextFragment {
        kind,
        start_byte: absolute_start,
        end_byte: absolute_end,
        base_byte: base,
    });
}

fn is_common_abbreviation(token: &str) -> bool {
    // Ninguna abreviatura admitida supera cinco caracteres (20 bytes UTF-8).
    if token.len() > 20 { return false; }
    let token = token.to_lowercase();
    matches!(token.as_str(),
        "dr" | "dra" | "sr" | "sra" | "srta" | "prof" | "profa"
        | "lic" | "ing" | "ud" | "uds" | "pág" | "pag" | "núm"
        | "num" | "av" | "dpto" | "tel" | "ej" | "mr" | "mrs"
        | "ms" | "st" | "jr" | "vs" | "mme" | "mlle" | "p" | "ee" | "uu"
    )
}

fn split_sentences(
    text: &str,
    start: usize,
    end: usize,
    base: usize,
    output: &mut Vec<TextFragment>,
    cancelled: Option<&AtomicBool>,
) -> bool {
    let mut sentence_start = start;
    let mut cursor = start;
    let mut previous_char: Option<char> = None;
    let mut last_word_start: Option<usize> = None;
    let mut last_word_end: Option<usize> = None;
    let mut after_whitespace = false;
    let mut scanned = 0usize;
    while cursor < end {
        if scanned % 256 == 0 && cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return false;
        }
        let ch = text[cursor..end].chars().next().unwrap();
        let next = cursor + ch.len_utf8();
        if matches!(ch, '.' | '!' | '?' | '…') {
            let decimal_point = ch == '.'
                && cursor > start
                && next < end
                && previous_char.is_some_and(|c| c.is_ascii_digit())
                && text[next..].chars().next().is_some_and(|c| c.is_ascii_digit());
            let abbreviation = ch == '.' && match (last_word_start, last_word_end) {
                (Some(word_start), Some(word_end)) =>
                    is_common_abbreviation(&text[word_start..word_end]),
                _ => false,
            };
            if !decimal_point && !abbreviation {
                let mut boundary = next;
                let mut boundary_last = ch;
                let mut boundary_scanned = 0usize;
                while boundary < end {
                    if boundary_scanned % 256 == 0
                        && cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                        return false;
                    }
                    let following = text[boundary..end].chars().next().unwrap();
                    if matches!(following, '.' | '!' | '?' | '…' | '"' | '\'' | '»' | ')' | ']') {
                        boundary_last = following;
                        boundary += following.len_utf8();
                        boundary_scanned += 1;
                    } else { break; }
                }
                let is_sentence_boundary = boundary == end
                    || text[boundary..end].chars().next().is_some_and(char::is_whitespace);
                if is_sentence_boundary {
                    push_trimmed(output, FragmentKind::Sentence, text, sentence_start, boundary, base);
                    sentence_start = boundary;
                }
                if boundary_scanned > 0 {
                    if after_whitespace || last_word_start.is_none() {
                        last_word_start = None;
                        last_word_end = None;
                        after_whitespace = false;
                    }
                    previous_char = Some(boundary_last);
                    cursor = boundary;
                    scanned = scanned.saturating_add(boundary_scanned + 1);
                    continue;
                }
            }
        }
        if ch.is_whitespace() {
            after_whitespace = true;
        } else if after_whitespace || last_word_start.is_none() {
            last_word_start = if ch.is_alphanumeric() { Some(cursor) } else { None };
            last_word_end = if ch.is_alphanumeric() { Some(next) } else { None };
            after_whitespace = false;
        } else if ch.is_alphanumeric() {
            last_word_end = Some(next);
        }
        previous_char = Some(ch);
        cursor = next;
        scanned += 1;
    }
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) { return false; }
    push_trimmed(output, FragmentKind::Sentence, text, sentence_start, end, base);
    true
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn cancellable_segmentation_stops_without_returning_partial_results() {
        let cancelled = AtomicBool::new(true);
        assert!(segment_fragment_cancellable("Uno. Dos.", 0, &cancelled).is_none());
        let complete = segment_fragment("Uno. Dos.", 0);
        assert_eq!(
            complete.iter().filter(|fragment| fragment.kind == FragmentKind::Sentence).count(),
            2,
        );
    }

    #[test]
    fn long_closing_punctuation_runs_are_consumed_once() {
        let text = format!("Hola{} Después.", "!".repeat(12_000));
        let fragments = segment_fragment(&text, 0);
        let sentences: Vec<_> = fragments.iter()
            .filter(|fragment| fragment.kind == FragmentKind::Sentence)
            .map(|fragment| fragment.slice(&text).unwrap())
            .collect();
        assert_eq!(sentences.len(), 2);
        assert_eq!(sentences[0], format!("Hola{}", "!".repeat(12_000)));
        assert_eq!(sentences[1], "Después.");

        let joined = format!("Hola{}mundo.", "!".repeat(12_000));
        let joined_fragments = segment_fragment(&joined, 0);
        assert_eq!(
            joined_fragments.iter()
                .filter(|fragment| fragment.kind == FragmentKind::Sentence).count(),
            1,
        );
    }

    #[test]
    fn dense_internal_periods_do_not_rescan_the_entire_sentence_prefix() {
        let text = format!("{}fin.", "a.".repeat(12_000));
        let fragments = segment_fragment(&text, 0);
        let sentences: Vec<_> = fragments.iter()
            .filter(|fragment| fragment.kind == FragmentKind::Sentence)
            .collect();
        assert_eq!(sentences.len(), 1);
        assert_eq!(sentences[0].end_byte, text.len());
    }

    #[test]
    fn sentence_abbreviation_check_uses_current_sentence_start() {
        let text = format!("{} Dr. Ana llegó. {} Dr. Luis salió.", "palabra ".repeat(200), "otra ".repeat(200));
        let fragments = segment_fragment(&text, 0);
        let sentences: Vec<_> = fragments.iter().filter(|f| f.kind == FragmentKind::Sentence).collect();
        assert_eq!(sentences.len(), 2);
    }

    #[test]
    fn rope_affected_ranges_match_string_reference_for_every_character_boundary() {
        let samples = [
            "Primero.\n\nEl niño llegó.\n\nTercero.",
            "  Uno.\r\n\r\n   Dos.  \r\nTres.",
            "\n\nInicio\nmedio\n\nFinal\n",
            "Un solo párrafo sin saltos",
            "\t \n\r\n\n   ",
        ];
        for source in samples {
            let rope = crate::RopeText::new(source);
            let boundaries: Vec<usize> = (0..=source.len())
                .filter(|offset| source.is_char_boundary(*offset)).collect();
            for &start in &boundaries {
                for &end in boundaries.iter().filter(|end| **end >= start) {
                    let expected = affected_paragraph_range(source, start, end);
                    let actual = affected_paragraph_range_rope(&rope, start, end);
                    assert_eq!(actual, expected, "selección {start}..{end} en {source:?}");
                }
            }
        }
    }

    #[test]
    fn rope_paragraph_ranges_match_reference_for_deterministic_mixed_documents() {
        let pieces = [
            "Uno.", "  Dos.  ", "El niño.", "", " ", "\t", "ñandú.",
            "línea extensa", "A\r", "B", "🐈", "fin.",
        ];
        let separators = ["\n", "\n\n", "\r\n", "\r\n\r\n", "\n \n"];
        let mut seed = 0x91e1_0da5u64;
        for case in 0..48 {
            let mut source = String::new();
            for index in 0..(case % 11 + 1) {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                source.push_str(pieces[(seed as usize) % pieces.len()]);
                if index + 1 < case % 11 + 1 {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                    source.push_str(separators[(seed as usize) % separators.len()]);
                }
            }
            let rope = crate::RopeText::new(source.clone());
            let boundaries: Vec<usize> = (0..=source.len())
                .filter(|offset| source.is_char_boundary(*offset)).collect();
            for &start in &boundaries {
                for &end in boundaries.iter().filter(|end| **end >= start) {
                    assert_eq!(
                        affected_paragraph_range_rope(&rope, start, end),
                        affected_paragraph_range(&source, start, end),
                        "caso {case}, selección {start}..{end}, texto {source:?}",
                    );
                }
            }
        }
    }

    #[test]
    fn rope_affected_range_handles_large_documents_and_long_lines() {
        let prefix = "Párrafo inicial.\n\n".repeat(2_000);
        let middle = format!("{}fin.", "x".repeat(12_000));
        let source = format!("{prefix}{middle}\n\nÚltimo.");
        let rope = crate::RopeText::new(source.clone());
        let start = source.find("fin.").unwrap();
        let expected = affected_paragraph_range(&source, start, start + 2).unwrap();
        assert_eq!(affected_paragraph_range_rope(&rope, start, start + 2), Some(expected));
    }

    #[test]
    fn affected_range_expands_to_complete_paragraph_and_keeps_utf8_boundaries() {
        let text = "Primero.\n\nEl niño llegó.\n\nTercero.";
        let at = text.find("niño").unwrap() + 1;
        let (start, end) = affected_paragraph_range(text, at, at).unwrap();
        assert_eq!(&text[start..end], "El niño llegó.");
        assert!(text.is_char_boundary(start));
        assert!(text.is_char_boundary(end));
    }

    #[test]
    fn changing_a_blank_line_invalidates_both_adjacent_paragraphs() {
        let text = "Primero.\n\nSegundo.";
        let separator = text.find("\n\n").unwrap() + 1;
        let (start, end) = affected_paragraph_range(text, separator, separator).unwrap();
        assert_eq!(&text[start..end], text);
    }

    #[test]
    fn nonempty_edit_inside_a_paragraph_separator_invalidates_both_neighbors() {
        let text = "Primero.\n\nSegundo.";
        let separator_start = text.find("\n\n").unwrap();
        let (start, end) = affected_paragraph_range(text, separator_start, separator_start + 2).unwrap();
        assert_eq!(&text[start..end], text);
    }

    #[test]
    fn editing_at_the_start_of_a_paragraph_does_not_pull_in_its_predecessor() {
        let text = "Primero.\n\nSegundo.";
        let start = text.find("Segundo").unwrap();
        let (range_start, range_end) = affected_paragraph_range(text, start, start + 1).unwrap();
        assert_eq!(&text[range_start..range_end], "Segundo.");
    }

    #[test]
    fn whitespace_only_document_has_a_safe_empty_analysis_range() {
        let text = " \n\t ";
        assert_eq!(affected_paragraph_range(text, 1, 1), Some((0, text.len())));
    }

    #[test]
    fn affected_range_handles_crlf_blank_lines_and_trailing_paragraph() {
        let text = "Primero.\r\n\r\nSegundo.\r\n";
        let second = text.find("Segundo").unwrap();
        let (start, end) = affected_paragraph_range(text, second, second + 3).unwrap();
        assert_eq!(&text[start..end], "Segundo.");
        let (tail_start, tail_end) = affected_paragraph_range(text, text.len(), text.len()).unwrap();
        assert_eq!(&text[tail_start..tail_end], "Segundo.");
    }

    #[test]
    fn fragment_offsets_remain_absolute_when_base_is_nonzero() {
        let text = "Uno.\n\nDos.";
        let fragments = segment_fragment(text, 500);
        let second = fragments.iter()
            .find(|fragment| fragment.kind == FragmentKind::Paragraph && fragment.slice(text) == Some("Dos."))
            .unwrap();
        assert_eq!(second.start_byte, 506);
        assert_eq!(second.end_byte, 510);
        assert_eq!(second.slice(text), Some("Dos."));
    }

    #[test]
    fn overflowing_absolute_base_does_not_panic_or_emit_invalid_ranges() {
        let fragments = segment_fragment("texto", usize::MAX - 1);
        assert!(fragments.is_empty());
    }

    #[test]
    fn invalid_or_non_boundary_offsets_are_rejected() {
        let text = "niño";
        assert_eq!(affected_paragraph_range(text, 3, 3), None);
        assert_eq!(affected_paragraph_range(text, 0, 99), None);
        assert_eq!(affected_paragraph_range(text, 3, 2), None);
    }

    #[test]
    fn sentence_segmentation_preserves_source_and_utf8_offsets() {
        let text = "¿Vienes? ¡Sí! El niño llegó… Luego.";
        let fragments = segment_fragment(text, 40);
        let sentences: Vec<_> = fragments.iter()
            .filter(|f| f.kind == FragmentKind::Sentence)
            .map(|f| f.slice(text).unwrap())
            .collect();
        assert_eq!(sentences, vec!["¿Vienes?", "¡Sí!", "El niño llegó…", "Luego."]);
        for fragment in fragments {
            assert!(text.is_char_boundary(fragment.start_byte - 40));
            assert!(text.is_char_boundary(fragment.end_byte - 40));
        }
    }

    #[test]
    fn common_english_and_portuguese_titles_do_not_create_false_boundaries() {
        let text = "Mr. Smith chegou. A Sra. Costa respondeu. Then they left.";
        let fragments = segment_fragment(text, 0);
        let sentences: Vec<_> = fragments.iter()
            .filter(|fragment| fragment.kind == FragmentKind::Sentence)
            .map(|fragment| fragment.slice(text).unwrap())
            .collect();
        assert_eq!(sentences, vec![
            "Mr. Smith chegou.",
            "A Sra. Costa respondeu.",
            "Then they left.",
        ]);
    }

    #[test]
    fn common_spanish_titles_do_not_create_false_sentence_boundaries() {
        let text = "La Dra. Ana llegó. El Sr. Pérez la saludó. Luego hablaron.";
        let fragments = segment_fragment(text, 0);
        let sentences: Vec<_> = fragments.iter()
            .filter(|fragment| fragment.kind == FragmentKind::Sentence)
            .map(|fragment| fragment.slice(text).unwrap())
            .collect();
        assert_eq!(sentences, vec![
            "La Dra. Ana llegó.",
            "El Sr. Pérez la saludó.",
            "Luego hablaron.",
        ]);
    }

    #[test]
    fn spanish_example_abbreviation_does_not_split_the_sentence() {
        let text = "Puede verse, p. ej. en este capítulo. Después continúa.";
        let fragments = segment_fragment(text, 0);
        let sentences: Vec<_> = fragments.iter()
            .filter(|fragment| fragment.kind == FragmentKind::Sentence)
            .map(|fragment| fragment.slice(text).unwrap())
            .collect();
        assert_eq!(sentences, vec![
            "Puede verse, p. ej. en este capítulo.",
            "Después continúa.",
        ]);
    }

    #[test]
    fn spanish_country_initialism_does_not_split_sentences() {
        let text = "Viajó a EE.UU. Luego regresó.";
        let fragments = segment_fragment(text, 0);
        let sentences: Vec<_> = fragments.iter()
            .filter(|fragment| fragment.kind == FragmentKind::Sentence)
            .map(|fragment| fragment.slice(text).unwrap())
            .collect();
        assert_eq!(sentences, vec!["Viajó a EE.UU.", "Luego regresó."]);
    }

    #[test]
    fn decimal_points_do_not_split_sentences() {
        let text = "Mide 3.14 metros. Después salió.";
        let fragments = segment_fragment(text, 0);
        let sentences: Vec<_> = fragments.iter()
            .filter(|f| f.kind == FragmentKind::Sentence)
            .map(|f| f.slice(text).unwrap())
            .collect();
        assert_eq!(sentences, vec!["Mide 3.14 metros.", "Después salió."]);
    }

    #[test]
    fn empty_lines_are_not_emitted_as_fragments() {
        let text = "  Uno.\n\n   Dos.  ";
        let fragments = segment_fragment(text, 0);
        let paragraphs: Vec<_> = fragments.iter()
            .filter(|f| f.kind == FragmentKind::Paragraph)
            .map(|f| f.slice(text))
            .collect();
        assert_eq!(paragraphs, vec!["Uno.", "Dos."]);
    }

    #[test]
    fn paragraph_lookup_starts_at_nearest_paragraph_instead_of_document_start() {
        let text = (0..2_000)
            .map(|index| format!("Párrafo {index}"))
            .collect::<Vec<_>>()
            .join("\n\n");
        let target = text.find("Párrafo 1999").unwrap();
        assert_eq!(paragraph_scan_start(&text, target), target);
        let (start, end) = affected_paragraph_range(&text, target, target + 4).unwrap();
        assert_eq!(&text[start..end], "Párrafo 1999");
    }

    #[test]
    fn paragraph_lookup_in_separator_includes_previous_paragraph() {
        let text = "Anterior.\n\n\nSiguiente.";
        let separator = text.find("\n\n").unwrap() + 1;
        let scan_start = paragraph_scan_start(text, separator);
        assert_eq!(text[scan_start..].split('\n').next().unwrap().trim(), "Anterior.");
        let (start, end) = affected_paragraph_range(text, separator, separator).unwrap();
        assert_eq!(&text[start..end], text);
    }

    #[test]
    fn paragraph_lookup_preserves_crlf_and_whitespace_separator_behavior() {
        let text = "Primero.\r\n   \r\nSegundo.\r\nTercero.";
        let second = text.find("Segundo").unwrap();
        let (start, end) = affected_paragraph_range(text, second, second + 2).unwrap();
        assert_eq!(&text[start..end], "Segundo.");
    }

    #[test]
    fn paragraph_lookup_handles_selection_spanning_multiple_paragraphs() {
        let text = "Uno.\n\nDos.\n\nTres.\n\nCuatro.";
        let start = text.find("Dos").unwrap();
        let end = text.find("Cuatro").unwrap() + 2;
        let (range_start, range_end) = affected_paragraph_range(text, start, end).unwrap();
        assert_eq!(&text[range_start..range_end], "Dos.\n\nTres.\n\nCuatro.");
    }


    #[test]
    fn editing_leading_indentation_after_a_separator_includes_both_paragraphs() {
        let text = "Anterior.\n\n   Siguiente.";
        let indentation = text.find("   Siguiente").unwrap() + 1;
        let (start, end) = affected_paragraph_range(text, indentation, indentation + 1).unwrap();
        assert_eq!(&text[start..end], text);
    }

    #[test]
    fn rope_range_segmentation_keeps_absolute_offsets_and_unicode() {
        let text = format!("{}\n\nEl niño llegó. Otra frase.\n\n{}", "x".repeat(8 * 1024), "z".repeat(8 * 1024));
        let rope = crate::RopeText::new(text.clone());
        let start = text.find("El niño").unwrap();
        let end = text.find("Otra frase.").unwrap() + "Otra frase.".len();
        let (fragment, segments) = segment_rope_range(&rope, start, end).unwrap();
        assert_eq!(fragment, "El niño llegó. Otra frase.");
        let paragraph = segments.iter().find(|item| item.kind == FragmentKind::Paragraph).unwrap();
        assert_eq!((paragraph.start_byte, paragraph.end_byte), (start, end));
        assert_eq!(paragraph.slice(&fragment), Some("El niño llegó. Otra frase."));
        assert!(segments.iter().all(|item| item.start_byte >= start && item.end_byte <= end));
    }

    #[test]
    fn rope_range_segmentation_rejects_invalid_ranges_and_utf8_boundaries() {
        let rope = crate::RopeText::new("Año\ntexto");
        assert!(segment_rope_range(&rope, 2, 5).is_none());
        assert!(segment_rope_range(&rope, 7, 3).is_none());
        assert!(segment_rope_range(&rope, 0, rope.len() + 1).is_none());
    }

}
