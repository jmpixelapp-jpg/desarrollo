//! Parser y serializador JSON propio, sin dependencias externas.
//!
//! Se usa únicamente en la frontera de integración. El núcleo de análisis no
//! necesita convertir el manuscrito completo a JSON.

use std::collections::BTreeMap;

pub const MAX_JSON_BYTES: usize = 16 * 1024 * 1024;
const MAX_DEPTH: usize = 64;
const MAX_STRING_BYTES: usize = 12 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Array(Vec<JsonValue>),
    Object(BTreeMap<String, JsonValue>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonError {
    pub offset: usize,
    pub message: &'static str,
}

impl std::fmt::Display for JsonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "JSON inválido en byte {}: {}", self.offset, self.message)
    }
}

impl std::error::Error for JsonError {}

pub fn parse(input: &str) -> Result<JsonValue, JsonError> {
    if input.len() > MAX_JSON_BYTES {
        return Err(JsonError { offset: MAX_JSON_BYTES, message: "el mensaje supera 16 MiB" });
    }
    let mut parser = Parser { bytes: input.as_bytes(), offset: 0 };
    parser.skip_whitespace();
    let value = parser.value(0)?;
    parser.skip_whitespace();
    if parser.offset != parser.bytes.len() {
        return Err(parser.error("contenido sobrante después del valor JSON"));
    }
    Ok(value)
}

pub fn stringify(value: &JsonValue) -> String {
    let mut output = String::new();
    write_value(value, &mut output);
    output
}

impl JsonValue {
    pub fn get(&self, key: &str) -> Option<&JsonValue> {
        match self {
            Self::Object(object) => object.get(key),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Self::Number(value) => value.parse().ok(),
            _ => None,
        }
    }

    pub fn as_usize(&self) -> Option<usize> {
        self.as_u64().and_then(|value| usize::try_from(value).ok())
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(value) => Some(*value),
            _ => None,
        }
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl Parser<'_> {
    fn error(&self, message: &'static str) -> JsonError {
        JsonError { offset: self.offset, message }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.offset).copied()
    }

    fn take(&mut self) -> Option<u8> {
        let byte = self.peek()?;
        self.offset += 1;
        Some(byte)
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.offset += 1;
        }
    }

    fn value(&mut self, depth: usize) -> Result<JsonValue, JsonError> {
        if depth > MAX_DEPTH {
            return Err(self.error("profundidad JSON excesiva"));
        }
        self.skip_whitespace();
        match self.peek() {
            Some(b'n') => { self.keyword(b"null")?; Ok(JsonValue::Null) }
            Some(b't') => { self.keyword(b"true")?; Ok(JsonValue::Bool(true)) }
            Some(b'f') => { self.keyword(b"false")?; Ok(JsonValue::Bool(false)) }
            Some(b'"') => self.string().map(JsonValue::String),
            Some(b'[') => self.array(depth + 1),
            Some(b'{') => self.object(depth + 1),
            Some(b'-' | b'0'..=b'9') => self.number().map(JsonValue::Number),
            Some(_) => Err(self.error("token JSON inesperado")),
            None => Err(self.error("se esperaba un valor JSON")),
        }
    }

    fn keyword(&mut self, keyword: &[u8]) -> Result<(), JsonError> {
        if self.bytes.get(self.offset..self.offset + keyword.len()) == Some(keyword) {
            self.offset += keyword.len();
            Ok(())
        } else {
            Err(self.error("literal JSON inválido"))
        }
    }

    fn array(&mut self, depth: usize) -> Result<JsonValue, JsonError> {
        self.offset += 1;
        self.skip_whitespace();
        let mut values = Vec::new();
        if self.peek() == Some(b']') {
            self.offset += 1;
            return Ok(JsonValue::Array(values));
        }
        loop {
            values.push(self.value(depth)?);
            self.skip_whitespace();
            match self.take() {
                Some(b',') => {
                    self.skip_whitespace();
                    if self.peek() == Some(b']') {
                        return Err(self.error("coma final no permitida en array"));
                    }
                }
                Some(b']') => break,
                _ => return Err(self.error("se esperaba coma o cierre de array")),
            }
        }
        Ok(JsonValue::Array(values))
    }

    fn object(&mut self, depth: usize) -> Result<JsonValue, JsonError> {
        self.offset += 1;
        self.skip_whitespace();
        let mut values = BTreeMap::new();
        if self.peek() == Some(b'}') {
            self.offset += 1;
            return Ok(JsonValue::Object(values));
        }
        loop {
            if self.peek() != Some(b'"') {
                return Err(self.error("la clave de objeto debe ser una cadena"));
            }
            let key = self.string()?;
            self.skip_whitespace();
            if self.take() != Some(b':') {
                return Err(self.error("se esperaba dos puntos después de la clave"));
            }
            let value = self.value(depth)?;
            if values.insert(key, value).is_some() {
                return Err(self.error("clave duplicada en objeto JSON"));
            }
            self.skip_whitespace();
            match self.take() {
                Some(b',') => {
                    self.skip_whitespace();
                    if self.peek() == Some(b'}') {
                        return Err(self.error("coma final no permitida en objeto"));
                    }
                }
                Some(b'}') => break,
                _ => return Err(self.error("se esperaba coma o cierre de objeto")),
            }
        }
        Ok(JsonValue::Object(values))
    }

    fn string(&mut self) -> Result<String, JsonError> {
        if self.take() != Some(b'"') {
            return Err(self.error("se esperaba cadena"));
        }
        let mut output = String::new();
        loop {
            let byte = self.take().ok_or_else(|| self.error("cadena sin cierre"))?;
            match byte {
                b'"' => return Ok(output),
                b'\\' => {
                    let escape = self.take().ok_or_else(|| self.error("escape incompleto"))?;
                    match escape {
                        b'"' => output.push('"'),
                        b'\\' => output.push('\\'),
                        b'/' => output.push('/'),
                        b'b' => output.push('\u{0008}'),
                        b'f' => output.push('\u{000c}'),
                        b'n' => output.push('\n'),
                        b'r' => output.push('\r'),
                        b't' => output.push('\t'),
                        b'u' => {
                            let first = self.hex_quad()?;
                            let scalar = if (0xD800..=0xDBFF).contains(&first) {
                                if self.take() != Some(b'\\') || self.take() != Some(b'u') {
                                    return Err(self.error("par sustituto Unicode incompleto"));
                                }
                                let second = self.hex_quad()?;
                                if !(0xDC00..=0xDFFF).contains(&second) {
                                    return Err(self.error("par sustituto Unicode inválido"));
                                }
                                0x10000 + (((first - 0xD800) as u32) << 10)
                                    + (second - 0xDC00) as u32
                            } else if (0xDC00..=0xDFFF).contains(&first) {
                                return Err(self.error("sustituto Unicode aislado"));
                            } else {
                                first as u32
                            };
                            output.push(char::from_u32(scalar)
                                .ok_or_else(|| self.error("punto Unicode inválido"))?);
                        }
                        _ => return Err(self.error("secuencia de escape inválida")),
                    }
                }
                0x00..=0x1f => return Err(self.error("carácter de control sin escapar")),
                0x20..=0x7f => output.push(byte as char),
                _ => {
                    let start = self.offset - 1;
                    let tail = std::str::from_utf8(&self.bytes[start..])
                        .map_err(|_| self.error("UTF-8 inválido en cadena"))?;
                    let character = tail.chars().next()
                        .ok_or_else(|| self.error("UTF-8 incompleto"))?;
                    self.offset = start + character.len_utf8();
                    output.push(character);
                }
            }
            if output.len() > MAX_STRING_BYTES {
                return Err(self.error("cadena JSON supera el límite de 12 MiB"));
            }
        }
    }

    fn hex_quad(&mut self) -> Result<u16, JsonError> {
        let mut value = 0u16;
        for _ in 0..4 {
            let byte = self.take().ok_or_else(|| self.error("escape Unicode incompleto"))?;
            let digit = match byte {
                b'0'..=b'9' => (byte - b'0') as u16,
                b'a'..=b'f' => (byte - b'a' + 10) as u16,
                b'A'..=b'F' => (byte - b'A' + 10) as u16,
                _ => return Err(self.error("dígito hexadecimal inválido")),
            };
            value = (value << 4) | digit;
        }
        Ok(value)
    }

    fn number(&mut self) -> Result<String, JsonError> {
        let start = self.offset;
        if self.peek() == Some(b'-') {
            self.offset += 1;
        }
        match self.peek() {
            Some(b'0') => {
                self.offset += 1;
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(self.error("cero inicial no permitido"));
                }
            }
            Some(b'1'..=b'9') => {
                self.offset += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.offset += 1;
                }
            }
            _ => return Err(self.error("parte entera del número inválida")),
        }
        if self.peek() == Some(b'.') {
            self.offset += 1;
            let fraction_start = self.offset;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
            if self.offset == fraction_start {
                return Err(self.error("fracción decimal vacía"));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.offset += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.offset += 1;
            }
            let exponent_start = self.offset;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
            if self.offset == exponent_start {
                return Err(self.error("exponente vacío"));
            }
        }
        Ok(std::str::from_utf8(&self.bytes[start..self.offset])
            .expect("los números JSON son ASCII").to_owned())
    }
}

fn write_value(value: &JsonValue, output: &mut String) {
    match value {
        JsonValue::Null => output.push_str("null"),
        JsonValue::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        JsonValue::Number(value) => output.push_str(value),
        JsonValue::String(value) => write_string(value, output),
        JsonValue::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 { output.push(','); }
                write_value(value, output);
            }
            output.push(']');
        }
        JsonValue::Object(values) => {
            output.push('{');
            for (index, (key, value)) in values.iter().enumerate() {
                if index != 0 { output.push(','); }
                write_string(key, output);
                output.push(':');
                write_value(value, output);
            }
            output.push('}');
        }
    }
}

fn write_string(value: &str, output: &mut String) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{0008}' => output.push_str("\\b"),
            '\u{000c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character <= '\u{001f}' => {
                use std::fmt::Write as _;
                let _ = write!(output, "\\u{:04x}", character as u32);
            }
            character => output.push(character),
        }
    }
    output.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_serializes_nested_unicode_json() {
        let input = r#"{"name":"Niño 🙂","line":"uno\n二","items":[null,true,false,-12,3.5,1e+2]}"#;
        let parsed = parse(input).unwrap();
        let serialized = stringify(&parsed);
        assert_eq!(parse(&serialized).unwrap(), parsed);
    }

    #[test]
    fn decodes_surrogate_pairs_and_rejects_isolated_surrogates() {
        assert_eq!(parse(r#""\ud83d\ude42""#).unwrap(), JsonValue::String("🙂".into()));
        assert!(parse(r#""\ud83d""#).is_err());
        assert!(parse(r#""\ude42""#).is_err());
    }

    #[test]
    fn rejects_duplicate_keys_and_trailing_content() {
        assert!(parse(r#"{"id":1,"id":2}"#).is_err());
        assert!(parse("true false").is_err());
        assert!(parse(r#"{"x":1,}"#).is_err());
    }

    #[test]
    fn validates_json_number_grammar() {
        for invalid in ["01", "-", "1.", "1e", "+1", ".1", "1e+"] {
            assert!(parse(invalid).is_err(), "accepted {invalid}");
        }
        for valid in ["0", "-0", "12", "-4.25", "1e9", "2.3E-4"] {
            assert!(matches!(parse(valid), Ok(JsonValue::Number(_))));
        }
    }

    #[test]
    fn enforces_input_size_and_nesting_limits() {
        assert!(parse(&" ".repeat(MAX_JSON_BYTES + 1)).is_err());
        let nested = format!("{}0{}", "[".repeat(MAX_DEPTH + 2), "]".repeat(MAX_DEPTH + 2));
        assert!(parse(&nested).is_err());
    }

    #[test]
    fn preserves_embedded_nul_as_escaped_json_data() {
        let parsed = parse(r#""a\u0000b""#).unwrap();
        assert_eq!(parsed, JsonValue::String("a\0b".into()));
        assert_eq!(parse(&stringify(&parsed)).unwrap(), parsed);
    }
}
