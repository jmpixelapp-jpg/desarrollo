# Ingesta y comprensión estructural de libros

## Objetivo

La adquisición de información literaria es una etapa propia del Motor Literario, anterior a la construcción del conocimiento narrativo. El motor debe partir del texto real de la obra, preservar su procedencia y convertir observaciones verificables en material utilizable por las capas de entidades, relaciones, acontecimientos, causalidad, cronología y continuidad.

## Entrega inicial: ingesta estructural basada en evidencia

Módulo: `typescript/src/narrative-book-ingestion.ts`

API pública: `ingestNarrativeBookText(input)`

La función asíncrona `readNarrativeBookFile(file)` adquiere archivos TXT y Markdown UTF-8 mediante `arrayBuffer` y `TextDecoder` estándar, sin bibliotecas de terceros. Su texto se entrega a `ingestNarrativeBookText(input)`, que lo convierte en unidades estructurales y señales candidatas respaldadas por evidencia. La detección de acciones conserva el orden real de los verbos mediante offsets específicos de cada superficie. 

- Segmentación de capítulos a partir de encabezados explícitos (Capítulo/Chapter/Parte/Libro/Prólogo/Epílogo y variantes reconocidas), incluidos encabezados Markdown con prefijos `#`.
- Segmentación de párrafos con offsets UTF-16 y clasificación inicial de narración, diálogo o contenido mixto.
- Conteo de palabras y métricas de cobertura.
- Señales candidatas de acciones, referencias temporales, marcadores causales y marcadores de contraste; los límites de palabras reconocen letras y marcas Unicode, incluidas terminaciones acentuadas del español.
- Si el anfitrión entrega fichas de entidades del mismo libro, la ingesta también ejecuta el descubrimiento de observaciones: acciones ligadas a menciones de personajes, pronombres pendientes y evidencia exacta del verbo. La salida declara si se extrajeron observaciones, si faltan entidades o si se omitieron por el presupuesto de texto.
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

- Archivos TXT/Markdown: 20.000.000 bytes como máximo; UTF-8 estricto, extensiones y MIME validados, bytes nulos rechazados.
- Observaciones ligadas a entidades: 2.000.000 unidades UTF-16 por análisis; cuando el libro supera ese presupuesto, `observationStatus: "omitted-text-budget"` informa la omisión en vez de presentar una extracción parcial como completa.
- Texto de entrada: 5.000.000 unidades UTF-16.
- Capítulos: 2.000.
- Párrafos: 100.000.
- Señales: 20.000; el resultado informa cuántas se omitieron.
- No se trunca silenciosamente: `coverage.truncated` y `coverage.omittedSignals` exponen la cobertura limitada.

## Próximas etapas técnicas

1. Adaptadores de lectura para EPUB, PDF y DOCX, preservando el mapa entre texto extraído y ubicación original; TXT/Markdown ya dispone de lector estándar.
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
