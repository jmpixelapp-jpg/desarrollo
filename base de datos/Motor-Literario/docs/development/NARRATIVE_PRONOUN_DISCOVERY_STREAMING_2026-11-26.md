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


## Corrección de segmentación y escape de nombres — 26 de noviembre de 2026

La revisión del código detectó dos errores en expresiones regulares que podían comprometer la extracción previa a la resolución: la clase de caracteres de `sentenceSpans` trataba los caracteres `\\` y `n` como separadores en lugar de reconocer el salto de línea, y el escape de nombres no cubría correctamente todos los metacaracteres. Se corrigieron ambas expresiones.

Se añaden regresiones para una oración separada únicamente por salto de línea y para un nombre canónico con paréntesis. Esto protege la detección de pronombres iniciales y evita que signos presentes en nombres se interpreten como sintaxis de expresión regular.

**Alcance:** el cambio corrige segmentación y búsqueda literal. No introduce concordancia morfológica ni afirma que el candidato más cercano sea el antecedente correcto. La salida sigue siendo una hipótesis para revisión.
