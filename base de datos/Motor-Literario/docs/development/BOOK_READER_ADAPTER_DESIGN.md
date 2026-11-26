# Arquitectura de lectores e ingesta de libros

## Objetivo

La fuente primaria del análisis es el contenido que realmente se consigue extraer del libro. El motor no debe depender de que el anfitrión le entregue texto ya preparado y sin procedencia. Cada lector de formato debe producir una secuencia verificable de bloques y un informe de calidad de extracción.

La capa común está implementada en `typescript/src/book-ingestion.ts`. Este documento define la siguiente fase: lectores concretos y su conexión con el motor.

## Flujo objetivo

```text
Archivo / fuente
    |
    v
Lector de formato (EPUB, PDF, DOCX, TXT, OCR)
    |
    v
Bloques ordenados + metadatos + localizadores + advertencias
    |
    v
Ingesta común (validación, límites, capítulos, offsets)
    |
    v
Documentos por capítulo + mapa de procedencia
    |
    v
Motor literario (conocimiento narrativo y análisis por rangos)
    |
    v
Evidencias navegables hasta el pasaje y la página originales
```

## Contrato común ya implementado

- `BookReaderAdapter<TSource>` lee una fuente mediante un flujo asíncrono.
- `BookReaderBlock` incluye ID estable, secuencia de lectura, clase de bloque, texto, ID de capítulo opcional y localizador.
- `ingestBookWithReader` valida el flujo y entrega capítulos.
- `BookSourceSpan` conserva offsets UTF-16 y ubicación de origen.
- Los encabezados o IDs explícitos son los únicos límites de capítulo aceptados.
- Límites de recursos y cancelación están disponibles en `BookIngestionOptions`.

## Requisitos para cada lector de formato

### EPUB — primer adaptador concreto

1. Validar el contenedor ZIP antes de extraer: límites de tamaño comprimido y expandido, número de entradas, ratios de expansión, nombres de rutas y entradas duplicadas.
2. Leer `META-INF/container.xml`, resolver el OPF, metadatos, manifest y spine.
3. Respetar el orden del spine, no el orden alfabético de los XHTML.
4. Resolver navegación NCX/nav para títulos y jerarquía de capítulos; usar spine como orden autoritativo cuando la navegación falte o esté incompleta.
5. Extraer XHTML en orden de documento y preservar títulos, párrafos, listas, versos, notas, enlaces y separadores semánticos.
6. Resolver entidades XML/HTML sin ejecutar scripts, estilos ni contenido activo.
7. Conservar archivo interno, fragmento, href y orden como localizador de origen.
8. Detectar recursos ausentes, referencias rotas, documentos vacíos y capítulos repetidos; reportar advertencias en vez de inventar contenido.

### PDF

1. Extraer página por página y conservar número de página, cajas/posición cuando el parser lo permita.
2. Distinguir texto seleccionable de páginas sin capa textual.
3. Detectar orden de lectura dudoso en columnas; no reordenar por coordenadas sin conservar diagnóstico.
4. Preservar encabezados, pies, notas y guiones hasta que una fase explícita de limpieza presente sugerencias revisables.
5. Informar páginas vacías, fuentes no decodificables y caracteres de sustitución.
6. Para escaneos, derivar a OCR con confianza por bloque y coordenadas; no presentar OCR como texto original verificado.

### DOCX y TXT

- DOCX: conservar párrafos, estilos de encabezado, tablas, notas y orden XML; registrar advertencias de elementos no soportados.
- TXT: detectar BOM/codificación mediante reglas explícitas, no asumir UTF-8 silenciosamente; permitir que el usuario elija codificación si la detección es ambigua.
- No convertir saltos de página en capítulos por sí solos.

## Calidad y trazabilidad

Cada lector debe producir un informe de calidad separado del texto:

- bloques esperados/leídos y páginas/partes esperadas/leídas;
- bloques vacíos, duplicados, omitidos o no decodificables;
- advertencias de orden, codificación y estructura;
- porcentaje de texto extraído solo cuando el denominador sea verificable;
- OCR y confianza por página/bloque cuando aplique.

No eliminar encabezados repetidos, números de página, notas, guiones de fin de línea ni caracteres sospechosos de forma silenciosa. Las transformaciones deben ser políticas versionadas, reversibles o acompañadas por el texto original y sus offsets.

## Integración con el motor

La importación debe ser de dos fases:

1. **Preparar:** leer, validar, ensamblar, presentar resumen de calidad y detectar IDs ya existentes.
2. **Confirmar:** crear los documentos/capítulos y registrar la procedencia. Una interrupción no debe dejar un libro parcialmente importado sin un estado recuperable.

Cada capítulo debe conservar su fuente y mapa de spans. El análisis literario usa offsets UTF-16 dentro del documento, mientras que la interfaz debe poder traducirlos a página/archivo interno/fracción original. Si se vuelve a extraer una versión nueva, no reutilizar evidencia antigua como si correspondiera a la nueva revisión.

## Pruebas de aceptación

- Corpus pequeño de EPUBs reales con spine desordenado, nav ausente, notas, versos, tablas, entidades y recursos rotos.
- PDF con texto, columnas, notas, páginas rotadas, fuentes embebidas y páginas escaneadas.
- DOCX con encabezados, tablas, notas y listas.
- TXT UTF-8, BOM, UTF-16, CRLF, CR y codificaciones ambiguas.
- Comparación de conteos y localizadores contra extracción de referencia.
- Archivos maliciosos o patológicos: ZIP bomb, path traversal, XML expansivo, entradas duplicadas, páginas enormes y flujos truncados.
- Repetir importación: no duplicar capítulos ni evidencias.
- Cancelación a mitad de lectura y reanudación segura.
- Confirmación transaccional: fallo en un capítulo no deja una importación completa aparente.

## Estado

La ingesta estructural común está implementada y probada a nivel de código. Ningún lector binario EPUB/PDF/DOCX ni OCR se declara terminado todavía. La prioridad inmediata es implementar EPUB con su validación ZIP/OPF/spine y pruebas de corpus; después PDF y OCR.


## Primera implementación EPUB

Se ha añadido `typescript/src/epub-reader.ts` con `EpubBookReader` y `createEpubBookReader`.

- Acepta `ArrayBuffer` y `Uint8Array`.
- Lee `META-INF/container.xml`, OPF, metadatos, manifest y spine; respeta el orden del spine.
- Extrae XHTML en bloques con encabezados, secciones, párrafos, versos y notas al pie.
- Conserva localizadores por archivo interno, spine y bloque.
- Valida rutas internas, duplicados, cifrado, métodos ZIP, límites de expansión, CRC32 y consistencia de cabeceras locales.
- Rechaza ZIP64 y archivos multi-volumen en esta iteración.
- No ejecuta scripts ni incorpora estilos, SVG o MathML al texto.
- Usa UTF-8 estricto y DecompressionStream para deflate-raw.

Las pruebas de fixture cubren metadatos, orden, extracción de texto, notas, localizadores, rutas inseguras, mimetype incorrecto y corrupción CRC. Aún falta ejecutar la suite en el entorno del proyecto y contrastar con un corpus de EPUB reales. La extracción XHTML es estructural y conservadora, pero todavía no implementa todos los casos de HTML5, codificaciones XML alternativas, nav/NCX para jerarquía editorial, CSS de contenido oculto, overlays ni recursos remotos.


La inspección del EPUB ahora recorre los documentos del spine y devuelve número de bloques extraídos, lista de documentos sin texto y advertencias por metadatos ausentes o documentos vacíos. Esto permite una etapa previa de control de calidad en la importación. No equivale todavía a un porcentaje de integridad del libro: para calcularlo se necesita una medida de contenido esperado que el formato realmente permita verificar.
