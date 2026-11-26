# Registro técnico de desarrollo — lectura y trazabilidad narrativa

> Estado del trabajo en la rama `feat/narrative-sync-coordinator-v3`.
> Este documento es el registro operativo de la línea de trabajo «Análisis literario e inteligencia narrativa de ideas y sincronización». Su foco actual es lectura real de libros, conservación de estructura y procedencia, y enlace verificable entre análisis y fuente primaria.

## 1. Objetivo funcional

Construir una ruta verificable desde un archivo de libro hasta las conclusiones del motor narrativo:

1. Leer el archivo con un adaptador específico del formato.
2. Extraer contenido en bloques estructurados y ordenados.
3. Conservar la ubicación original de cada bloque.
4. Agrupar bloques en documentos/capítulos sin inventar límites editoriales.
5. Analizar texto con offsets UTF-16 consistentes.
6. Resolver cada evidencia narrativa contra los bloques originales.
7. Permitir que la interfaz o una consulta abra el pasaje de origen y explique de dónde sale una afirmación.

Principio rector: **ninguna conclusión debe aparentar estar respaldada por un pasaje que no pueda localizarse y verificarse en la fuente**. Cuando la procedencia o la revisión no se puede demostrar, la API debe fallar explícitamente o marcar la limitación; no debe adivinar.

## 2. Arquitectura implementada

### 2.1 Frontera de lectura e ingesta común

Archivo: `typescript/src/book-ingestion.ts`

API principal:

- `BookReaderAdapter<TSource>`: adaptador asíncrono de un formato.
- `BookReaderBlock`: unidad de texto estructurada.
- `BookReaderLocation`: localizador original, página, índice de spine y sección.
- `ingestBookReaderBlocks(metadata, blocks, options)`: valida y agrupa bloques.
- `ingestBookWithReader(adapter, source, metadata, options)`: ejecuta el adaptador y entrega sus bloques a la ingesta.

Tipos de bloque admitidos:

- `book-title`
- `chapter-heading`
- `section-heading`
- `paragraph`
- `poem-line`
- `footnote`
- `page-break`

Validaciones y decisiones:

- IDs de bloque únicos y secuencias estrictamente crecientes.
- Validación de metadatos, clase de bloque, texto, IDs de capítulo y localizadores.
- Rechazo de IDs de capítulo reutilizados de forma incompatible y encabezados vacíos.
- Capítulos creados por encabezados explícitos o cambios explícitos de `chapterId`; no se deducen por salto de página o intuición textual.
- Normalización conservadora: BOM inicial y CRLF/CR a LF. No se eliminan guiones, encabezados repetidos, notas ni texto posiblemente autoral.
- Soporte para `Iterable` y `AsyncIterable`, cancelación mediante `AbortSignal` y límites de recursos configurables.

Límites predeterminados actuales:

| Límite | Valor |
|---|---:|
| Bloques por libro | 200.000 |
| Unidades UTF-16 por bloque | 1.000.000 |
| Unidades UTF-16 por capítulo | 2.000.000 |
| Unidades UTF-16 por libro | 100.000.000 |

La salida `IngestedBook` conserva metadatos, capítulos, spans de origen y estadísticas. Los offsets son unidades UTF-16 de JavaScript, compatibles con `String.slice` y con los rangos del motor.

### 2.2 Lector EPUB

Archivo: `typescript/src/epub-reader.ts`

API pública:

- `EpubBookReader`
- `createEpubBookReader`
- `EpubReaderLimits`
- `EpubInspection`
- `EpubNavigationItem`

Flujo de lectura:

1. Lee el contenedor `META-INF/container.xml`.
2. Resuelve el paquete OPF.
3. Recupera metadatos, manifest y spine.
4. Recorre el spine en su orden de lectura.
5. Extrae XHTML a bloques estructurados.
6. Conserva localizadores por documento interno, spine y sección.
7. Informa cobertura y advertencias mediante inspección.

Estructura textual reconocida: títulos/encabezados, secciones, párrafos, versos/preformateado, notas al pie y saltos de línea XHTML `br`. Se excluyen scripts, estilos, SVG y MathML del contenido textual. Los nombres de elementos con prefijos XML se contemplan en la extracción.

Navegación editorial:

- EPUB 3: recuperación de `nav`.
- EPUB 2: recuperación de `NCX`.
- Cada entrada expone etiqueta, href, ruta interna resuelta y profundidad.
- La navegación es un índice editorial; **no reemplaza el orden del spine**.
- Se generan advertencias cuando no hay navegación utilizable o hay destinos que no se resuelven.

Seguridad y límites ZIP:

- Valida directorio central, cabeceras locales y coherencia de flags.
- Rechaza rutas inseguras, entradas duplicadas, entradas cifradas y métodos no admitidos.
- Comprueba CRC32 y límites de tamaño, expansión, ratio y cantidad de entradas.
- Comprueba `mimetype` inicial y almacenado sin compresión.
- Rechaza ZIP64 y archivos ZIP divididos en varios volúmenes.
- Impide que rangos de datos de entradas invadan el directorio central.
- Para entradas deflate usa `DecompressionStream("deflate-raw")`; si el entorno no lo ofrece, falla de forma explícita.

La inspección devuelve metadatos, número de documentos del spine, bloques extraídos, documentos vacíos y advertencias. Un archivo ZIP/EPUB válido no implica que el contenido textual esté completo.

### 2.3 Procedencia de bloques y resolución de evidencia

Archivo: `typescript/src/book-evidence.ts`

API:

- `resolveBookEvidence(book, chapter, start, end)`
- `resolveNarrativeTextEvidence(book, evidence)`
- `resolveNarrativeEvidenceCollection(book, evidences)`

`resolveBookEvidence` traduce un rango UTF-16 de capítulo a uno o varios fragmentos de origen. Cada fragmento conserva ID y secuencia de bloque, tipo, offsets dentro del capítulo y del bloque, cita exacta y localizador disponible (archivo interno, página, spine o sección).

Reglas importantes:

- Una evidencia que cruza párrafos produce varios fragmentos.
- Los separadores sintéticos añadidos entre bloques no se adjudican a ningún bloque de origen.
- Los rangos vacíos, invertidos, no enteros o fuera del capítulo se rechazan.
- Los offsets de salida se mantienen en UTF-16.

### 2.4 Seguridad de revisión de evidencias persistidas

El metadato `BookReaderMetadata.revision` identifica el snapshot exacto del documento anfitrión, cuando está versionado.

`resolveNarrativeTextEvidence` exige:

1. Evidencia no marcada como `stale`.
2. Revisión de evidencia válida y no negativa.
3. Revisión declarada en el snapshot.
4. Igualdad exacta entre revisión de evidencia y revisión del libro.
5. Documento/capítulo presente en el libro.
6. Rango válido y coincidencia carácter por carácter entre `excerpt` y el texto del rango.

Una evidencia obsoleta debe resolverse contra la revisión histórica correspondiente, no contra el texto actual. No se usa una cita parecida como sustituto de la verificación exacta.

`resolveNarrativeEvidenceCollection` resuelve una colección completa contra un único snapshot. Si un elemento falla, la llamada falla; no entrega un resultado parcial que pueda interpretarse como una ficha completamente respaldada.

**Importante:** este módulo ya proporciona la ruta de resolución para registros narrativos persistidos que compartan el contrato de `TextEvidence`. Aún no se ha añadido una propiedad nueva de fragmentos EPUB a las entidades ni se ha cambiado el almacenamiento. La integración de presentación/consulta del conocimiento narrativo sigue pendiente.

## 3. Relación con el análisis literario y el conocimiento narrativo

El repositorio ya cuenta con modelos de conocimiento narrativo y análisis literario:

- `typescript/src/narrative-knowledge.ts`: entidades, relaciones, acontecimientos, ideas y evidencias textuales persistidas.
- `typescript/src/literary-analysis.ts`: análisis descriptivo, ocurrencias con offsets UTF-16, proyecciones de conocimiento del proyecto y resultados derivados.
- `typescript/src/narrative-history.ts`: historial de afirmaciones.
- `typescript/src/host-api.ts`: frontera de integración con el anfitrión (revisar contratos antes de cambiarla).

La evidencia persistida utiliza `documentId`, `revision`, `start`, `end`, `excerpt` y estado opcional `stale`. La nueva resolución de libro adapta esa evidencia a los bloques/localizadores del libro, sin sustituir el contrato de persistencia.

### Próxima integración prevista

1. Inspeccionar las rutas de lectura y consulta del conocimiento narrativo.
2. Identificar dónde se presentan evidencias de entidades, relaciones, acontecimientos e ideas.
3. Añadir una capa de enriquecimiento opcional que resuelva evidencia sólo cuando se dispone del snapshot del libro correcto.
4. Mantener intacta la evidencia persistida original; los fragmentos del libro serán una proyección derivada.
5. Definir comportamiento explícito cuando el libro no está cargado, la revisión no coincide o el localizador no existe.
6. Cubrir el enriquecimiento con pruebas que demuestren que ninguna evidencia cruza documentos o revisiones.

No se deben cambiar IDs, esquemas persistidos ni contratos de API pública hasta terminar ese inventario.

## 4. Inventario de archivos

| Archivo | Función | Estado |
|---|---|---|
| `src/book-ingestion.ts` | Contrato común, validación, agrupación y spans | Implementado |
| `src/epub-reader.ts` | ZIP/OPF/spine/XHTML y navegación EPUB | Implementación inicial |
| `src/book-evidence.ts` | Resolución de rangos a fuente y revisión | Implementado; integración de consumo pendiente |
| `src/index.ts` | Exportación de módulos públicos | Exporta los tres módulos |
| `tests/book-ingestion.test.mjs` | Pruebas de ingesta | Escritas; ejecución pendiente |
| `tests/epub-reader.test.mjs` | Fixtures EPUB y extracción | Escritas; ejecución pendiente |
| `tests/book-evidence.test.mjs` | Pruebas de resolución y revisión | Escritas; ejecución pendiente |
| `README.md` | Guía de uso y alcance | Actualizado |
| `docs/development/BOOK_READER_ADAPTER_DESIGN.md` | Diseño de adaptadores y formatos | Actualizado; revisar sincronización con este registro |
| `docs/analysis/ESTADO_ANALISIS_LITERARIO_E_INTELIGENCIA_NARRATIVA.md` | Resumen ejecutivo de progreso | Actualizado |
| Este documento | Registro técnico detallado y plan | Actualizado |

## 5. Pruebas y validación

Se han escrito pruebas para:

- Validación de metadatos, bloques, orden y límites de ingesta.
- Conservación de encabezados, capítulos, spans y conteos UTF-16.
- Extracción EPUB, orden spine, metadatos, notas y localizadores.
- Rechazo de rutas inseguras, entradas ZIP corruptas, CRC inválido y límites excedidos.
- Navegación EPUB 3 `nav` y EPUB 2 `NCX`.
- Conservación de saltos `br`, versos y elementos XML con prefijo.
- Evidencia que cruza bloques, offsets locales y separadores sintéticos.
- Revisión coincidente, revisión divergente, snapshot sin revisión, evidencia obsoleta y excerpt no coincidente.
- Resolución de colecciones sin resultado parcial.

**Estado de ejecución:** estas pruebas se han añadido al repositorio, pero en esta sesión no se ha ejecutado `npm test`, `npm run typecheck` ni el build. Por tanto, no se afirma que compilen o pasen. El próximo paso de validación es ejecutar primero typecheck, después los tests focalizados y finalmente la suite completa.

## 6. Limitaciones conocidas y riesgos abiertos

### EPUB

- ZIP64 y ZIP multi-volumen no soportados.
- Deflate depende de `DecompressionStream("deflate-raw")`.
- El extractor XHTML es deliberadamente acotado; no equivale a un parser HTML5 completo.
- Codificaciones XML no UTF-8 requieren soporte/decisión explícita.
- CSS de visibilidad, tablas complejas, overlays, recursos remotos, fuentes, contenido protegido/cifrado y estructuras editoriales raras requieren corpus y trabajo adicional.
- La jerarquía nav/NCX se recupera, pero aún hay que contrastar destinos/fragmentos con corpus diverso.
- La cobertura informada no es un porcentaje de integridad: no existe todavía un denominador fiable de todo el texto esperado.

### Evidencia y análisis

- El resolver no reconstruye una revisión histórica por sí solo: necesita el snapshot correcto.
- El enlazado con el conocimiento narrativo está disponible como función, pero aún no se integra automáticamente en todas las consultas/salidas.
- Deben preservarse las distinciones entre evidencia activa y obsoleta.
- Las transformaciones futuras de texto deben mantener mapas de offsets o registrar que la procedencia ya no es directa.

### Formatos aún no implementados

- PDF: lector por página, con coordenadas/cajas cuando estén disponibles; escaneos deben declararse como OCR, no como texto nativo.
- DOCX: párrafos, estilos, tablas, listas y notas.
- TXT: detección explícita de codificación y conservación de estructura de líneas.
- OCR: fase separada, con confianza y coordenadas por página/bloque.

No se debe improvisar un parser binario casero para PDF/DOCX ni afirmar soporte antes de implementar y validar un adaptador real.

## 7. Plan de trabajo ordenado

### Fase A — cerrar calidad de la base actual
- Ejecutar typecheck y tests.
- Corregir errores de compilación, imports, fixtures y comportamiento real.
- Revisar regex/parser EPUB y validar nav/NCX y saltos XHTML.
- Incorporar corpus EPUB real representativo y documentar los casos no soportados.
- Corregir contradicciones entre README, diseño de adaptadores y estado.

### Fase B — conectar evidencias al conocimiento narrativo
- Auditar `narrative-knowledge.ts`, `literary-analysis.ts` y `host-api.ts`.
- Implementar proyección de evidencia a localizadores del libro sin modificar persistencia.
- Integrar entidades, relaciones, acontecimientos e ideas.
- Añadir tests para varias evidencias, capítulos y revisiones.
- Documentar cómo una consulta puede abrir la cita fuente.

### Fase C — lector PDF real
- Elegir una biblioteca compatible con el proyecto y registrar dependencia/licencia.
- Extraer por página y conservar coordenadas cuando la API las proporcione.
- Informar páginas sin texto seleccionable y errores de extracción.
- Separar OCR y conservar confianza/procedencia.
- Añadir fixtures PDF y corpus real.

### Fase D — DOCX/TXT y flujo de importación
- Implementar adaptadores específicos.
- Incorporar preparación, informe de calidad y confirmación de importación.
- Asegurar cancelación, repetición idempotente y recuperación ante fallos.
- Añadir documentación de formatos y límites.

### Fase E — integración de producto
- Exponer al usuario pasajes fuente desde resultados narrativos.
- Mostrar edición/revisión, capítulo, página/ubicación y cita.
- Diferenciar texto original, texto normalizado y OCR.
- Permitir inspección de advertencias y cobertura de lectura.

## 8. Criterios de aceptación de esta línea

La línea de lectura y trazabilidad no debe considerarse cerrada hasta que:

- El lector procese un corpus de libros reales de cada formato soportado.
- Typecheck y suite de pruebas pasen en CI.
- La importación conserve orden y estructura con localizadores verificables.
- Los rangos del análisis regresen al fragmento exacto del libro.
- Las evidencias de revisiones antiguas no se atribuyan a snapshots nuevos.
- Las salidas de entidades, escenas, acontecimientos, relaciones e ideas permitan inspeccionar sus fuentes.
- Las limitaciones de extracción se comuniquen sin ocultarlas.
- La documentación y los contratos públicos describan el comportamiento real.

## 9. Estado del repositorio y disciplina de publicación

- Repositorio: `jmpixelapp-jpg/desarrollo`.
- Rama de trabajo: `feat/narrative-sync-coordinator-v3`.
- PR #56: abierto, en borrador; no fusionado.
- No se ha rebasado ni fusionado la rama con `main`.
- La rama se encontraba divergida respecto de `main`; comprobar el estado de comparación antes de cualquier integración.
- Los commits publicados documentan cambios incrementales; este registro debe actualizarse en cada tanda que modifique contratos, alcance, pruebas o prioridades.

**Regla de comunicación:** distinguir siempre entre código escrito, pruebas escritas, pruebas ejecutadas y validación CI. Nunca describir un test como aprobado sólo porque exista un fixture.

## 10. Registro de cambios

| Tanda | Cambio |
|---|---|
| Ingesta común | Contrato de adaptador, bloques, capítulos y spans UTF-16 |
| Lector EPUB | ZIP/OPF/spine/XHTML con límites y localizadores |
| Calidad EPUB | Inspección de bloques, spine vacío y advertencias |
| Fidelidad | Notas, versos, saltos de línea y límites de documento |
| Navegación | EPUB 3 nav y EPUB 2 NCX |
| Evidencia fuente | Resolver de rangos a bloques originales |
| Evidencia versionada | Snapshot revisionado, cita exacta y colecciones atómicas |
| Registro actual | Arquitectura, inventario, límites, validación y plan de cierre |

---
