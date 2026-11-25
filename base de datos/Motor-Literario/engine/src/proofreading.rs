//! Revisión textual determinista desarrollada íntegramente en el Motor Literario.
//!
//! Estas reglas detectan patrones formales verificables. No sustituyen el juicio
//! editorial ni presentan una ambigüedad lingüística como error cierto.

use crate::linguistic::tokenize_words;
use crate::segmentation::{segment_fragment, segment_fragment_cancellable, FragmentKind};

const MAX_DIAGNOSTICS: usize = 4_096;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Suggestion,
}

impl DiagnosticSeverity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
            Self::Suggestion => "suggestion",
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct TextDiagnostic {
    pub code: &'static str,
    pub severity: DiagnosticSeverity,
    pub start_byte: usize,
    pub end_byte: usize,
    pub message: &'static str,
    pub replacement: Option<String>,
}

/// Ejecuta reglas locales conservadoras sobre un fragmento UTF-8.
/// Los offsets devueltos son absolutos respecto del documento mediante base_byte.
pub fn review_fragment(text: &str, base_byte: usize) -> Vec<TextDiagnostic> {
    review_fragment_inner(text, base_byte, None).unwrap_or_default()
}

/// Variante cancelable para que una edición nueva pueda descartar análisis obsoletos.
pub fn review_fragment_cancellable(
    text: &str,
    base_byte: usize,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Option<Vec<TextDiagnostic>> {
    review_fragment_inner(text, base_byte, Some(cancelled))
}

fn review_fragment_inner(
    text: &str,
    base_byte: usize,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Option<Vec<TextDiagnostic>> {
    use std::sync::atomic::Ordering;

    if base_byte.checked_add(text.len()).is_none() {
        return Some(Vec::new());
    }
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return None;
    }

    let mut diagnostics = Vec::new();
    let tokens = match cancelled {
        Some(flag) => crate::linguistic::tokenize_words_cancellable(text, base_byte, flag)?,
        None => tokenize_words(text, base_byte),
    };

    // Repetición inmediata: solo palabras idénticas separadas por espacios,
    // dentro de la misma línea; no se confunde con frecuencias del párrafo.
    for (pair_index, pair) in tokens.windows(2).take(MAX_DIAGNOSTICS).enumerate() {
        if pair_index % 128 == 0
            && cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return None;
        }
        if pair[0].normalized == pair[1].normalized
            && text.get(pair[0].end_byte.saturating_sub(base_byte)..pair[1].start_byte.saturating_sub(base_byte))
                .is_some_and(|gap| gap.chars().all(char::is_whitespace) && !gap.contains('\n') && !gap.contains('\r'))
        {
            diagnostics.push(TextDiagnostic {
                code: "repeated_adjacent_word",
                severity: DiagnosticSeverity::Warning,
                start_byte: pair[1].start_byte,
                end_byte: pair[1].end_byte,
                message: "La misma palabra aparece dos veces seguidas.",
                replacement: None,
            });
        }
    }

    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut index = 0usize;
    let mut scanned = 0usize;
    let mut line_has_content = false;
    while index < chars.len() && diagnostics.len() < MAX_DIAGNOSTICS {
        if scanned % 256 == 0
            && cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return None;
        }
        scanned += 1;
        let (offset, ch) = chars[index];
        if matches!(ch, '\n' | '\r') {
            line_has_content = false;
            index += 1;
            continue;
        }

        if matches!(ch, ' ' | '\t') {
            let run_start = index;
            while index < chars.len() && matches!(chars[index].1, ' ' | '\t') {
                index += 1;
                scanned += 1;
                if scanned % 256 == 0
                    && cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                    return None;
                }
            }
            let run_end = chars.get(index).copied();
            if let Some((punct_offset, punct)) = run_end {
                if matches!(punct, ',' | '.' | ';' | ':' | '!' | '?') {
                    diagnostics.push(TextDiagnostic {
                        code: "space_before_punctuation",
                        severity: DiagnosticSeverity::Warning,
                        start_byte: base_byte + offset,
                        end_byte: base_byte + punct_offset,
                        message: "Hay un espacio antes del signo de puntuación.",
                        replacement: Some(String::new()),
                    });
                }
            }
            if index - run_start >= 2 && line_has_content {
                let end_byte = chars[index - 1].0 + chars[index - 1].1.len_utf8();
                diagnostics.push(TextDiagnostic {
                    code: "multiple_internal_spaces",
                    severity: DiagnosticSeverity::Suggestion,
                    start_byte: base_byte + offset,
                    end_byte: base_byte + end_byte,
                    message: "Hay varios espacios consecutivos dentro de la línea.",
                    replacement: Some(" ".to_owned()),
                });
            }
            continue;
        }

        if matches!(ch, ',' | ';' | ':') {
            if let Some((next_offset, next_char)) = chars.get(index + 1).copied() {
                let previous_is_digit = index.checked_sub(1)
                    .and_then(|previous_index| chars.get(previous_index))
                    .is_some_and(|(_, previous_char)| previous_char.is_ascii_digit());
                let decimal_or_clock_separator = previous_is_digit && next_char.is_ascii_digit();
                if next_char.is_alphanumeric() && !decimal_or_clock_separator {
                    diagnostics.push(TextDiagnostic {
                        code: "missing_space_after_punctuation",
                        severity: DiagnosticSeverity::Suggestion,
                        start_byte: base_byte + next_offset,
                        end_byte: base_byte + next_offset,
                        message: "Conviene separar el signo de puntuación de la palabra siguiente.",
                        replacement: Some(" ".to_owned()),
                    });
                }
            }
        }

        line_has_content = true;
        index += 1;
    }

    if diagnostics.len() < MAX_DIAGNOSTICS {
        let fragments = match cancelled {
            Some(flag) => segment_fragment_cancellable(text, base_byte, flag)?,
            None => segment_fragment(text, base_byte),
        };
        for (fragment_index, fragment) in fragments.iter()
            .filter(|fragment| fragment.kind == FragmentKind::Sentence)
            .enumerate()
        {
            if fragment_index % 64 == 0
                && cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                return None;
            }
            let local_start = fragment.start_byte.checked_sub(base_byte)?;
            let local_end = fragment.end_byte.checked_sub(base_byte)?;
            let sentence = text.get(local_start..local_end)?;
            let first_non_whitespace = sentence.chars().find(|ch| !ch.is_whitespace());
            if first_non_whitespace.is_some_and(|ch| ch.is_ascii_digit()) {
                continue;
            }
            if let Some((relative_start, first_letter)) = sentence.char_indices()
                .find(|(_, ch)| ch.is_alphabetic())
            {
                if first_letter.is_lowercase() {
                    let start_byte = fragment.start_byte + relative_start;
                    diagnostics.push(TextDiagnostic {
                        code: "lowercase_sentence_start",
                        severity: DiagnosticSeverity::Suggestion,
                        start_byte,
                        end_byte: start_byte + first_letter.len_utf8(),
                        message: "La oración comienza con una letra minúscula.",
                        replacement: Some(first_letter.to_uppercase().collect()),
                    });
                }
            }
            if diagnostics.len() >= MAX_DIAGNOSTICS {
                break;
            }
        }
    }

    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return None;
    }
    diagnostics.sort_by_key(|item| (item.start_byte, item.end_byte, item.code));
    diagnostics.dedup_by(|left, right| {
        left.code == right.code && left.start_byte == right.start_byte && left.end_byte == right.end_byte
    });
    diagnostics.truncate(MAX_DIAGNOSTICS);
    Some(diagnostics)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_adjacent_repetition_with_absolute_utf8_offsets() {
        let source = "El niño niño llegó.";
        let result = review_fragment(source, 120);
        let item = result.iter().find(|item| item.code == "repeated_adjacent_word").unwrap();
        assert_eq!(&source[item.start_byte - 120..item.end_byte - 120], "niño");
        assert_eq!(item.start_byte, 129);
        assert_eq!(item.severity, DiagnosticSeverity::Warning);
    }

    #[test]
    fn detects_spacing_around_punctuation_without_rewriting_source() {
        let source = "Hola ,mundo  feliz.";
        let result = review_fragment(source, 10);
        assert!(result.iter().any(|item| item.code == "space_before_punctuation"));
        assert!(result.iter().any(|item| item.code == "missing_space_after_punctuation"));
        assert!(result.iter().any(|item| item.code == "multiple_internal_spaces"));
        assert_eq!(source, "Hola ,mundo  feliz.");
    }

    #[test]
    fn does_not_flag_repetition_across_lines_or_normal_word_frequency() {
        let result = review_fragment("Ana llegó. Ana llegó.\nAna", 0);
        assert_eq!(result.iter().filter(|item| item.code == "repeated_adjacent_word").count(), 0);
    }

    #[test]
    fn preserves_byte_boundaries_for_unicode_and_empty_text() {
        assert!(review_fragment("", 0).is_empty());
        let result = review_fragment("¡niño,perro!", 50);
        let item = result.iter().find(|item| item.code == "missing_space_after_punctuation").unwrap();
        assert_eq!(item.start_byte, 58);
        assert_eq!(item.start_byte, item.end_byte);
    }

    #[test]
    fn suggests_sentence_initial_capitalization_after_opening_punctuation() {
        let source = "¿qué pasó? después llegó Ana. ¿Todo bien?";
        let result = review_fragment(source, 30);
        let starts: Vec<_> = result.iter()
            .filter(|item| item.code == "lowercase_sentence_start")
            .collect();
        assert_eq!(starts.len(), 2);
        assert_eq!(starts[0].replacement.as_deref(), Some("Q"));
        assert_eq!(starts[1].replacement.as_deref(), Some("D"));
        assert!(starts.iter().all(|item| item.start_byte >= 30));
    }

    #[test]
    fn does_not_insert_spaces_inside_decimal_numbers_or_clock_times() {
        let result = review_fragment("El precio es 3,14 y son las 10:30.", 0);
        assert!(!result.iter().any(|item| item.code == "missing_space_after_punctuation"));
    }

    #[test]
    fn cancellable_review_matches_and_stops_for_obsolete_work() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let source = "El niño niño llegó,perro.";
        let active = AtomicBool::new(false);
        assert_eq!(review_fragment_cancellable(source, 20, &active), Some(review_fragment(source, 20)));
        let cancelled = AtomicBool::new(true);
        assert_eq!(review_fragment_cancellable(source, 20, &cancelled), None);
        cancelled.store(false, Ordering::Release);
    }

    #[test]
    fn caps_diagnostics_to_a_bounded_response() {
        let text = "eco eco ".repeat(5_000);
        let diagnostics = review_fragment(&text, 0);
        assert_eq!(diagnostics.len(), MAX_DIAGNOSTICS);
    }

    #[test]
    fn rejects_absolute_offset_overflow_without_panicking() {
        assert!(review_fragment("texto", usize::MAX - 1).is_empty());
    }
}
