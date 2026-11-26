# Ingesta y comprensión estructural de libros

## Objetivo

La adquisición de información literaria es una etapa propia del Motor Literario, anterior a la construcción del conocimiento narrativo. El motor debe partir del texto real de la obra, preservar su procedencia y convertir observaciones verificables en material utilizable por las capas de entidades, relaciones, acontecimientos, causalidad, cronología y continuidad.

## Entrega inicial: ingesta estructural basada en evidencia

Módulo: `typescript/src/narrative-book-ingestion.ts`

API pública: `ingestNarrativeBookText(input)`

La función recibe texto Unicode ya decodificado por el anfitrión y produce:

- Segmentación de capítulos a partir de encabezados explícitos (Capítulo/Chapter/Parte/Libro/Prólogo/Epílogo y variantes reconocidas).
- Segmentación de párrafos con offsets UTF-16 y clasificación inicial de narración, diálogo o contenido mixto.
- Conteo de palabras y métricas de cobertura.
- Señales candidatas de acciones, referencias temporales, marcadores causales y marcadores de contraste.
- Evidencia literal para cada capítulo y señal, con documento, revisión y offsets absolutos.
- IDs deterministas dentro de la misma identidad de documento, revisión y posición de origen.
- Límites explícitos para evitar crecimiento descontrolado de memoria.

## Garantías y límites

1. La ingesta no modifica el manuscrito.
2. Los fragmentos y offsets se refieren al texto de entrada; los offsets son unidades UTF-16 de JavaScript.
3. Las acciones detectadas son señales léxicas, no acontecimientos confirmados.
4. Un marcador como «porque» no demuestra por sí solo causalidad; se conserva como candidato revisable.
5. Una referencia como «después» no fija una fecha absoluta ni resuelve por sí sola el orden global de la historia.
6. No se asigna agente, paciente, sujeto gramatical ni identidad de personaje sin una etapa posterior de resolución.
7. La clasificación de diálogo es heurística y debe poder revisarse.
8. La entrada debe ser texto decodificado. La lectura binaria de EPUB, PDF o DOCX y la extracción OCR son adaptadores de adquisición separados; esta entrega no afirma implementar esos decodificadores.

## Límites de procesamiento

- Texto de entrada: 5.000.000 unidades UTF-16.
- Capítulos: 2.000.
- Párrafos: 100.000.
- Señales: 20.000; el resultado informa cuántas se omitieron.
- No se trunca silenciosamente: `coverage.truncated` y `coverage.omittedSignals` exponen la cobertura limitada.

## Próximas etapas técnicas

1. Adaptadores de lectura para TXT/Markdown y formatos de libro, preservando el mapa entre texto extraído y ubicación original.
2. Resolución de capítulos y secciones con encabezados no convencionales, numeración y metadatos.
3. Resolución de menciones a entidades con alias, pronombres y referencias entre párrafos, manteniendo candidatos y evidencia.
4. Extracción de acontecimientos con participantes y roles gramaticales separados de los personajes meramente mencionados.
5. Normalización temporal por línea narrativa, distinguiendo tiempo del discurso, tiempo de la historia, duración e incertidumbre.
6. Relaciones causales tipadas (causa, condición, consecuencia, motivación) con soporte textual y estado de revisión.
7. Continuidad entre capítulos: estado de personajes, ubicación, posesiones, objetivos, conocimiento y cambios de estado; detección de contradicciones con evidencia en ambos extremos.
8. Persistencia incremental e idempotente de resultados por revisión, con invalidación cuando cambian los fragmentos fuente.

## Verificación

La suite `tests/narrative-book-ingestion.test.mjs` cubre segmentación, offsets, señales, cautela semántica, límites y determinismo. Ejecutar desde esta carpeta:

```sh
npm test
```

La implementación debe considerarse una primera capa de adquisición y estructuración, no una comprensión literaria completa ni un parser universal de formatos.
