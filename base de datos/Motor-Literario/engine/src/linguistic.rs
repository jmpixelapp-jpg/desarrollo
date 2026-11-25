//! Tokenización y métricas lingüísticas locales de bajo coste.
//!
//! No clasifica significado, no detecta hechos ni produce correcciones.
//! Su entrada recomendada es el párrafo devuelto por segmentation::affected_paragraph_range.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::segmentation::{segment_fragment, segment_fragment_cancellable, FragmentKind};

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct WordToken {
    pub normalized: String,
    pub start_byte: usize,
    pub end_byte: usize,
    pub character_count: usize,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct WordFrequency {
    pub normalized: String,
    pub count: usize,
    pub first_start_byte: usize,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct FragmentMetrics {
    pub start_byte: usize,
    pub end_byte: usize,
    pub character_count: usize,
    pub word_count: usize,
    pub unique_word_count: usize,
    pub sentence_count: usize,
    pub paragraph_count: usize,
    pub long_word_count: usize,
    /// Longitud media de palabra multiplicada por 1.000; evita floats en persistencia.
    pub average_word_length_milli: u64,
    pub repeated_words: Vec<WordFrequency>,
}

pub fn tokenize_words(text: &str, base_byte: usize) -> Vec<WordToken> {
    tokenize_words_inner(text, base_byte, None).unwrap_or_default()
}

/// Tokeniza un fragmento y permite abandonar trabajo obsoleto durante la lectura.
pub fn tokenize_words_cancellable(
    text: &str,
    base_byte: usize,
    cancelled: &AtomicBool,
) -> Option<Vec<WordToken>> {
    tokenize_words_inner(text, base_byte, Some(cancelled))
}

fn tokenize_words_inner(
    text: &str,
    base_byte: usize,
    cancelled: Option<&AtomicBool>,
) -> Option<Vec<WordToken>> {
    let mut chars = text.char_indices().peekable();
    let mut tokens = Vec::new();
    let mut scanned = 0usize;

    while let Some((start_local, first)) = chars.next() {
        if scanned % 256 == 0 && cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return None;
        }
        scanned += 1;
        if !is_word_char(first) { continue; }
        let mut end_local = start_local + first.len_utf8();
        let mut previous = first;

        loop {
            let Some((next_offset, next_char)) = chars.peek().copied() else { break; };
            if is_word_char(next_char) {
                chars.next();
                end_local = next_offset + next_char.len_utf8();
                previous = next_char;
                scanned += 1;
                if scanned % 256 == 0 && cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                    return None;
                }
                continue;
            }

            let following = chars.clone().nth(1).map(|(_, ch)| ch);
            let decimal_separator = next_char == '.'
                && previous.is_ascii_digit()
                && following.is_some_and(|ch| ch.is_ascii_digit());
            let joiner = is_joiner(next_char)
                && is_word_char(previous)
                && following.is_some_and(is_word_char);
            if decimal_separator || joiner {
                chars.next();
                end_local = next_offset + next_char.len_utf8();
                previous = next_char;
                scanned += 1;
                continue;
            }
            break;
        }

        let raw = &text[start_local..end_local];
        let mut normalized = String::with_capacity(raw.len());
        let mut character_count = 0usize;
        for (index, ch) in raw.chars().enumerate() {
            if index % 256 == 0
                && cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                return None;
            }
            if is_word_char(ch) { character_count += 1; }
            if !is_hyphen(ch) {
                let canonical = if matches!(ch, '’' | '‘' | 'ʼ') { char::from(39) } else { ch };
                normalized.extend(canonical.to_lowercase());
            }
        }
        tokens.push(WordToken {
            normalized,
            start_byte: base_byte.saturating_add(start_local),
            end_byte: base_byte.saturating_add(end_local),
            character_count,
        });
    }
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) { return None; }
    Some(tokens)
}

pub fn analyze_fragment(text: &str, base_byte: usize) -> FragmentMetrics {
    analyze_fragment_inner(text, base_byte, None).expect("el análisis no es cancelable")
}

/// Analiza un fragmento sin bloquear la escritura y permite descartar trabajo
/// obsoleto durante tokenización, recuentos y segmentación.
pub fn analyze_fragment_cancellable(
    text: &str,
    base_byte: usize,
    cancelled: &AtomicBool,
) -> Option<FragmentMetrics> {
    analyze_fragment_inner(text, base_byte, Some(cancelled))
}

fn analyze_fragment_inner(
    text: &str,
    base_byte: usize,
    cancelled: Option<&AtomicBool>,
) -> Option<FragmentMetrics> {
    let tokens = tokenize_words_inner(text, base_byte, cancelled)?;
    let mut frequencies: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut total_word_chars = 0usize;
    let mut long_word_count = 0usize;

    for (index, token) in tokens.iter().enumerate() {
        if index % 128 == 0 && cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return None;
        }
        total_word_chars = total_word_chars.saturating_add(token.character_count);
        if token.character_count > 12 { long_word_count += 1; }
        if let Some(entry) = frequencies.get_mut(token.normalized.as_str()) {
            entry.0 += 1;
        } else {
            frequencies.insert(token.normalized.clone(), (1, token.start_byte));
        }
    }

    let fragments = match cancelled {
        Some(flag) => segment_fragment_cancellable(text, base_byte, flag)?,
        None => segment_fragment(text, base_byte),
    };
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) { return None; }

    let sentence_count = fragments.iter()
        .filter(|fragment| fragment.kind == FragmentKind::Sentence).count();
    let paragraph_count = fragments.iter()
        .filter(|fragment| fragment.kind == FragmentKind::Paragraph).count();
    let unique_word_count = frequencies.len();
    let mut repeated_words = Vec::new();
    for (index, (normalized, (count, first_start_byte))) in frequencies.into_iter().enumerate() {
        if index % 128 == 0 && cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return None;
        }
        if count > 1 {
            repeated_words.push(WordFrequency { normalized, count, first_start_byte });
        }
    }
    let mut character_count = 0usize;
    for (index, _) in text.chars().enumerate() {
        if index % 1024 == 0 && cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return None;
        }
        character_count += 1;
    }

    Some(FragmentMetrics {
        start_byte: base_byte,
        end_byte: base_byte.saturating_add(text.len()),
        character_count,
        word_count: tokens.len(),
        unique_word_count,
        sentence_count,
        paragraph_count,
        long_word_count,
        average_word_length_milli: if tokens.is_empty() {
            0
        } else {
            (u64::try_from(total_word_chars).unwrap_or(u64::MAX).saturating_mul(1000)) / tokens.len() as u64
        },
        repeated_words,
    })
}

fn is_joiner(ch: char) -> bool {
    matches!(ch, '\'' | '’' | '-' | '‐' | '‑')
}

fn is_hyphen(ch: char) -> bool {
    matches!(ch, '-' | '‐' | '‑')
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || is_combining_mark(ch)
}

fn is_combining_mark(ch: char) -> bool {
    matches!(ch as u32,
        0x0300..=0x036F |
        0x1AB0..=0x1AFF |
        0x1DC0..=0x1DFF |
        0x20D0..=0x20FF |
        0xFE20..=0xFE2F
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellable_analysis_matches_regular_analysis_and_stops_when_cancelled() {
        let text = "Ana llegó. Ana sonrió.\n\nEl viaje terminó.";
        let cancelled = AtomicBool::new(false);
        assert_eq!(
            analyze_fragment_cancellable(text, 17, &cancelled),
            Some(analyze_fragment(text, 17)),
        );
        cancelled.store(true, Ordering::Release);
        assert_eq!(analyze_fragment_cancellable(text, 17, &cancelled), None);
    }

    #[test]
    fn tokenizes_spanish_accents_and_internal_apostrophes() {
        let text = "¡El niño llegó! L’amour no es fácil.";
        let tokens = tokenize_words(text, 100);
        let words: Vec<_> = tokens.iter().map(|token| token.normalized.as_str()).collect();
        assert_eq!(words, vec!["el", "niño", "l’amour", "no", "es", "fácil"]);
        assert!(tokens.iter().all(|token| token.start_byte >= 100));
        assert_eq!(&text[tokens[1].start_byte - 100..tokens[1].end_byte - 100], "niño");
    }

    #[test]
    fn normalizes_typographic_apostrophes_to_the_same_word() {
        let text = "L’amour l'amour L’amour";
        let metrics = analyze_fragment(text, 0);
        assert_eq!(metrics.word_count, 3);
        assert_eq!(metrics.unique_word_count, 1);
        assert_eq!(metrics.repeated_words.len(), 1);
        assert_eq!(metrics.repeated_words[0].normalized, "l'amour");
        assert_eq!(metrics.repeated_words[0].count, 3);
        let tokens = tokenize_words(text, 0);
        assert_eq!(tokens[0].normalized, tokens[1].normalized);
        assert_eq!(tokens[1].normalized, tokens[2].normalized);
        assert_eq!(&text[tokens[0].start_byte..tokens[0].end_byte], "L’amour");
    }

    #[test]
    fn tokenizer_keeps_combining_diacritical_marks_inside_words() {
        let text = "Cafe\u{301}";
        let tokens = tokenize_words(text, 0);
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].normalized, "cafe\u{301}");
        assert_eq!(tokens[0].character_count, 5);
    }

    #[test]
    fn normalizes_unicode_hyphen_variants_without_changing_source_offsets() {
        let text = "arco-iris arco‐iris arco‑iris";
        let tokens = tokenize_words(text, 20);
        assert_eq!(tokens.len(), 3);
        assert!(tokens.iter().all(|token| token.normalized == "arcoiris"));
        assert_eq!(&text[tokens[1].start_byte - 20..tokens[1].end_byte - 20], "arco‐iris");
        let metrics = analyze_fragment(text, 20);
        assert_eq!(metrics.unique_word_count, 1);
        assert_eq!(metrics.repeated_words[0].count, 3);
    }

    #[test]
    fn metrics_count_sentences_paragraphs_and_repetitions() {
        let text = "Ana llegó. Ana sonrió.\n\nEl viaje terminó.";
        let metrics = analyze_fragment(text, 0);
        assert_eq!(metrics.word_count, 7);
        assert_eq!(metrics.unique_word_count, 6);
        assert_eq!(metrics.sentence_count, 3);
        assert_eq!(metrics.paragraph_count, 2);
        assert_eq!(metrics.repeated_words.len(), 1);
        assert_eq!(metrics.repeated_words[0].normalized, "ana");
        assert_eq!(metrics.repeated_words[0].count, 2);
    }

    #[test]
    fn decimal_and_hyphenated_words_are_not_split_incorrectly() {
        let text = "La cifra 3.14 y el arco-iris.";
        let tokens = tokenize_words(text, 0);
        let words: Vec<_> = tokens.iter().map(|token| token.normalized.as_str()).collect();
        assert_eq!(words, vec!["la", "cifra", "3.14", "y", "el", "arcoiris"]);
    }

    #[test]
    fn empty_fragment_has_zero_average_without_division() {
        let metrics = analyze_fragment("", 0);
        assert_eq!(metrics.word_count, 0);
        assert_eq!(metrics.average_word_length_milli, 0);
        assert_eq!(metrics.sentence_count, 0);
    }
}
