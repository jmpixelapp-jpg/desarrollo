# Segmentación incremental de referencias pronominales — 26 de noviembre de 2026

## Hallazgo
El detector limitaba la salida a 2.000 referencias, pero materializaba previamente todos los segmentos del documento. En textos largos con puntuación densa, el coste intermedio podía ser alto aunque se alcanzase pronto el límite de resultados.

## Cambio
`sentenceSpans` pasa a ser un generador iterable. El consumidor procesa un segmento cada vez y se detiene al alcanzar `MAX_NARRATIVE_PRONOUN_REFERENCES`. No se introduce un límite artificial de segmentos ni se trunca el texto.

## Garantías
- Mantiene el orden textual.
- Conserva offsets absolutos y evidencia literal.
- Mantiene el límite de 2.000 referencias.
- Mantiene la ventana máxima de antecedentes y la ordenación determinista.
- No resuelve correferencias automáticamente.

## Prueba
Se añade un documento con más de 2.000 oportunidades de referencia y se comprueba el límite de salida y la correspondencia de los offsets emitidos con el texto fuente.
