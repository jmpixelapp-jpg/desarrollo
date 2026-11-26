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


## Señales estructurales de contexto para antecedentes — 26 de noviembre de 2026

Cada candidato incorpora ahora dos medidas reproducibles: `sentenceDistance`, cantidad de límites de oración entre la mención y el pronombre, y `paragraphDistance`, cantidad de separadores de párrafo en ese intervalo. Se exponen separadas de la distancia UTF-16.

Estas señales no alteran la ordenación principal por recencia, no descartan candidatos y no prueban correferencia. Una mención cercana puede ser irrelevante y una distante puede seguir siendo el antecedente correcto. Se añaden pruebas para varios párrafos y antecedentes competidores.

**Límite actual:** el modelo de entidades no contiene atributos gramaticales fiables de género y número. Esta etapa no inventa concordancias ni penaliza nombres por género aparente. La concordancia requiere una fuente explícita y versionada de esos atributos.


## Presupuesto agregado de exploración de nombres — 26 de noviembre de 2026

La búsqueda de antecedentes recorría la ventana de texto por cada entidad y por cada nombre/alias. Aunque cada dimensión tenía un límite individual, su producto podía producir un coste excesivo cuando coincidían muchos personajes, alias y una ventana amplia.

Se incorpora `MAX_NARRATIVE_PRONOUN_SCAN_UNITS = 25_000_000`. Antes de ejecutar la búsqueda de cada entidad se estima el trabajo como longitud de ventana multiplicada por cantidad de nombres (nombre canónico más alias). Si el presupuesto agregado se supera, la operación falla explícitamente; no devuelve un resultado parcial que pudiera confundirse con una extracción completa.

La prueba combina 100 entidades, 100 alias por entidad y la ventana máxima. El límite es una cota conservadora del trabajo estimado, no una medición exacta de operaciones de motor de expresiones regulares. La optimización futura apropiada sería un índice de menciones reutilizable por documento/revisión, en vez de repetir búsquedas por entidad.


## Descripciones nominales confirmadas como menciones — 26 de noviembre de 2026

Se amplía `NarrativeEntity` con `descriptions?`, una colección opcional de descripciones nominales explícitamente confirmadas por el escritor (por ejemplo, «la joven» o «la heredera»). El descubridor de antecedentes busca esas descripciones junto al nombre canónico y los alias.

Cada candidato expone `mentionType`: `canonical-name`, `alias` o `description`. Así se conserva la procedencia lingüística de la mención y se evita confundir una descripción con un nombre propio. Si dos entidades comparten la misma descripción, ambas permanecen como candidatas y el resultado sigue siendo ambiguo.

Las descripciones se validan con el mismo límite de longitud de 256 unidades y un máximo de 100 por entidad. También se incluyen en el presupuesto agregado de exploración. No se generan descripciones automáticamente: «la joven» solo puede vincularse a una identidad si fue registrada/confirmada previamente. La ausencia de una descripción registrada no se interpreta como evidencia negativa sobre el texto.
