# Auditoría de cobertura por dominio de extracción

## Propósito

`auditNarrativeExtractionByDomain` permite medir por separado qué oraciones tienen evidencia registrada para acciones, eventos, conocimiento de personajes, recepción de información, ocultación, estados, relaciones, ubicaciones y objetos.

## Interpretación

Una oración cubierta solo tiene solapamiento con evidencia de ese dominio. Una oración sin cobertura es una cola de revisión: puede contener información que el extractor no reconoce, una descripción, diálogo, texto estructural u otro contenido. No se etiqueta como irrelevante ni como prueba de fallo semántico.

Los nueve dominios se devuelven siempre, incluso si no se han conectado extractores. Por tanto, un dominio vacío puede significar que aún no se suministró evidencia, no que el libro carezca de ese fenómeno.

## Integridad

Cada evidencia debe pertenecer al documento y revisión indicados, no estar obsoleta, conservar longitud coherente y coincidir exactamente con el fragmento fuente en offsets UTF-16. Se admiten offsets absolutos mediante `baseOffset`.

## Límites

Texto máximo 2.000.000 unidades UTF-16, 100.000 oraciones y 50.000 evidencias por dominio. La cola conserva hasta 1.000 huecos por dominio e informa cuántos quedaron omitidos.
