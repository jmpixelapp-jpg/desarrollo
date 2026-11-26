# Auditoría de arquitectura y mapa del motor literario

**Fecha de inspección:** 2026-11-26  
**Rama inspeccionada:** `main`  
**HEAD inspeccionado:** `12c3f700e6b33676fff9b0bea93eac2a38ee7bdc`  
**Alcance:** inventario estático del repositorio, lectura de contratos y código fuente, identificación de flujos y contraste con pruebas/documentación.  
**Estado:** auditoría inicial documentada; no equivale a auditoría exhaustiva línea por línea ni a validación de ejecución de todos los módulos.

## 1. Conclusión ejecutiva

El motor de interpretación está repartido, pero existe una línea de producto identificable: **el runtime vigente es TypeScript/JavaScript bajo `base de datos/Motor-Literario/typescript`**. El punto de entrada público es `src/index.ts`; el núcleo de sesiones y cambios está en `engine.ts`; la coordinación con la aplicación anfitriona está en `host-api.ts`; la persistencia de navegador está en `persistence/indexeddb-store.ts`; y la interpretación narrativa se distribuye en `literary-analysis.ts`, `narrative-knowledge.ts`, `narrative-book-ingestion.ts` y numerosos extractores especializados.

El repositorio contiene además:
- una capa Rust en `engine/` que conserva una implementación anterior/de referencia y no es el runtime TypeScript vigente descrito por el README de TypeScript;
- un crate `storage/` con MLDB y componentes de almacenamiento persistente experimentales;
- un puente JSON-RPC entre procesos y un adaptador SQLite en `typescript/bridge/`;
- documentación técnica extensa distribuida entre `base de datos/Motor-Literario/docs/`, README de cada componente y el registro superior `docs/ANALISIS-LITERARIO-ESTADO.md`.

**Hallazgo central:** hay una base sustancial de extracción narrativa determinista y respaldada por evidencia, pero no existe todavía una ingesta universal de libros ni una comprensión lingüística general. La entrada binaria real implementada acepta TXT y Markdown UTF-8. EPUB, PDF, DOCX, OCR y reconstrucción del orden de lectura siguen siendo adaptadores/etapas pendientes. Muchas salidas son candidatos heurísticos, no hechos interpretados o confirmados.

## 2. Inventario verificable del repositorio

En el árbol recursivo de GitHub del HEAD inspeccionado se observaron **386 entradas** y, entre otras, estas concentraciones:
- 76 rutas bajo `typescript/src/` (incluye un directorio interno; la mayoría son módulos TypeScript).
- 99 archivos de prueba `.test.mjs` bajo `typescript/tests/`.
- 14 fuentes Rust en `engine/src/`.
- 13 fuentes Rust en `storage/src/`.

Estos números describen archivos, no número de capacidades completas ni resultados de ejecución.

### Mapa de alto nivel

| Capa | Ubicación | Responsabilidad comprobada | Estado |
|---|---|---|---|
| API pública | `typescript/src/index.ts` | Reexporta contratos, motor, API anfitriona, ingesta, análisis, conocimiento, grafos, sincronización y monitor | Implementada como punto de entrada |
| Sesión/editor | `typescript/src/engine.ts`, `text-buffer.ts` | Admisión de deltas, tabla de piezas, cola acotada, secuencias, recuperación y métricas | Implementada |
| Integración anfitriona | `typescript/src/host-api.ts`, `contracts.ts` | Identidad de proyecto, documentos, análisis, consultas narrativas y persistencia | Implementada; depende del anfitrión |
| Ingesta de libros | `typescript/src/narrative-book-ingestion.ts` | TXT/Markdown, capítulos, párrafos, señales, candidatos y auditoría de cobertura | Parcial y heurística |
| Análisis literario | `typescript/src/literary-analysis.ts` | Métricas, estructura, ritmo, diálogo, señales retóricas, continuidad y grafos | Amplia implementación determinista |
| Conocimiento narrativo | `typescript/src/narrative-knowledge.ts`, `narrative-history.ts` | Entidades, relaciones, acontecimientos, ideas, afirmaciones, evidencia e historial | Parcial/conservadora |
| Extractores especializados | `typescript/src/narrative-*-discovery.ts` | Acciones, pronombres, diálogo, estados, objetos, lugares, tiempo, relaciones, información | Implementados por familias; cobertura limitada por reglas |
| Grafos y trayectorias | `narrative-knowledge-graph*.ts`, `narrative-location-trajectory.ts`, `narrative-object-trajectory.ts` | Construcción, actualización, persistencia y proyección de relaciones/recorridos | Implementada con límites explícitos |
| Revisión textual | `typescript/src/proofreading.ts` | Reglas locales deterministas iniciales | Básica; no es corrector lingüístico integral |
| Persistencia web | `typescript/src/persistence/indexeddb-store.ts` | Almacenamiento local IndexedDB, journal, snapshots y migraciones | Implementada; probar navegadores reales |
| Puente de procesos | `typescript/bridge/stdio-server.mjs`, `bridge-client.ts` | JSON-RPC 2.0 sobre stdin/stdout y modo de proceso separado | Implementado |
| Persistencia puente | `typescript/bridge/sqlite-project-store.mjs` | Adaptador SQLite local para modo puente | Implementado; validar equivalencia y límites frente a IndexedDB |
| MLDB Rust | `engine/`, `storage/` | Motor persistente y almacenamiento propio en Rust | Experimental / no runtime TypeScript vigente |
| Contratos y documentación | `docs/`, `MLDB/`, README de carpetas | Especificaciones, evolución, protocolos, límites y estado | Repartida; requiere índice único |

## 3. Dónde está el motor de interpretación

### 3.1 Orquestación y entrada pública

- `typescript/src/index.ts`: superficie pública. Reexporta explícitamente las familias principales; un módulo que no esté exportado puede existir y probarse, pero no necesariamente es accesible como API pública.
- `typescript/src/host-api.ts`: fachada que reúne operaciones de proyecto, documento, extracción, consulta y persistencia.
- `typescript/src/contracts.ts`: contratos y tipos compartidos.
- `typescript/src/engine.ts`: motor de sesión de edición, cola, revisión, secuencia y recuperación.
- `typescript/src/text-buffer.ts`: representación editable incremental.

**Interpretación:** el motor no es una única función. La fachada anfitriona coordina servicios especializados que producen resultados y evidencias.

### 3.2 Interpretación literaria global

- `typescript/src/literary-analysis.ts` (7.142 líneas en el HEAD inspeccionado): archivo de análisis extenso con contratos para personajes, acontecimientos, relaciones, ideas, escenas, continuidad, ritmo, señales, cronologías y grafos.
- `typescript/src/narrative-consistency.ts`: comprobaciones de coherencia.
- `typescript/src/narrative-history.ts`: afirmaciones e historial.
- `typescript/src/narrative-knowledge.ts`: modelo de conocimiento y extracción conservadora.
- `typescript/src/narrative-knowledge-graph.ts`, `-incremental.ts`, `-persistence.ts`: grafo global, actualización y persistencia.

La amplitud de tipos y resultados no debe confundirse con comprensión semántica general. El código declara límites de texto, catálogos y muestras; conserva heurísticas y evidencia. La calidad de interpretación depende de la precisión y cobertura de los extractores que alimentan estas capas.

### 3.3 Extractores repartidos por dominio

Los módulos especializados identificados incluyen:
- Ideas y observaciones: `narrative-idea-discovery.ts`, `narrative-observation-discovery.ts`.
- Acciones, afirmaciones y cadenas de eventos: `narrative-action-link-discovery.ts`, `narrative-action-state-link-discovery.ts`, `narrative-action-claim-comparison.ts`, `narrative-event-chain-discovery.ts`.
- Personajes y conocimiento: `narrative-character-state-discovery.ts`, `narrative-character-state-transition-discovery.ts`, `narrative-character-knowledge-discovery.ts`, `narrative-character-knowledge-comparison.ts`, `narrative-character-knowledge-timeline.ts`.
- Referencia lingüística: `narrative-pronoun-reference-discovery.ts`, `narrative-pronoun-knowledge-discovery.ts`, `narrative-elliptical-subject-discovery.ts`, `narrative-dialogue-speaker-discovery.ts`, `narrative-descriptive-reference-discovery.ts`.
- Relaciones e información: `narrative-relationship-discovery.ts`, `narrative-relationship-transition-discovery.ts`, `narrative-information-asymmetry.ts`, `narrative-information-concealment-discovery.ts`, `narrative-information-exposure-discovery.ts`, `narrative-information-reception-discovery.ts`, `narrative-deception-evidence-link.ts`.
- Objetos: `narrative-object-attribute-discovery.ts`, `narrative-object-description-reference-discovery.ts`, `narrative-object-identity-candidate-discovery.ts`, `narrative-object-mention-audit.ts`, `narrative-object-state-discovery.ts`, `narrative-object-trajectory.ts`.
- Espacio y tiempo: `narrative-location-presence-discovery.ts`, `narrative-location-transition-discovery.ts`, `narrative-location-trajectory.ts`, `narrative-temporal-reference-discovery.ts`.
- Evidencia y cobertura: `narrative-evidence-context-expansion.ts`, `narrative-extraction-audit.ts`, `narrative-domain-extraction-audit.ts`.

**Riesgo arquitectónico a vigilar:** la fragmentación por dominio es razonable, pero hay que demostrar que todos los extractores relevantes están orquestados desde la ingesta/API, que comparten contratos de evidencia y que los resultados se proyectan al mismo modelo de conocimiento. La mera presencia de un archivo y su test no demuestra integración end-to-end.

## 4. Auditoría de adquisición de libros: el punto más importante

### 4.1 Flujo real observado

1. El anfitrión entrega un objeto de archivo.
2. `readNarrativeBookFile(file)` lee bytes mediante `arrayBuffer()`.
3. Comprueba extensión, MIME, tamaño, UTF-8 estricto y bytes nulos.
4. Solo acepta `.txt`, `.md` y `.markdown`; límite binario de 20.000.000 bytes.
5. `ingestNarrativeBookText(input)` segmenta texto decodificado en capítulos y párrafos, calcula palabras y produce señales con offsets UTF-16.
6. La ingesta ejecuta familias de descubrimiento disponibles: entidades explícitas, observaciones/acciones, vínculos de acciones, cambios de objetos, estados de personajes, presencia y transiciones de lugares, referencias temporales, acontecimientos etiquetados, ideas candidatas y auditoría de frases no cubiertas.
7. Devuelve candidatos, evidencias, presupuestos, contadores y estados de omisión; no modifica el manuscrito.

### 4.2 Lo que sí está implementado

- Lectura real de TXT y Markdown UTF-8, con validaciones de extensión/MIME, bytes nulos y límite de tamaño.
- Segmentación de capítulos a partir de encabezados explícitos reconocidos (Capítulo/Chapter/Parte/Libro/Prólogo/Epílogo y otros patrones definidos).
- Segmentación de párrafos, clasificación heurística de narración/diálogo/mixto y offsets UTF-16.
- Detección lexical de acciones, marcadores temporales, causales y contrastivos.
- Descubrimiento de ideas temáticas candidatas, observaciones ligadas a entidades, pronombres pendientes y señales espaciales/temporales.
- Evidencia textual navegable por documento, revisión y rangos.
- Presupuestos y auditoría de cobertura para exponer pasajes que los extractores actuales no cubren.

### 4.3 Lo que no debe darse por implementado

- **EPUB:** no hay decodificador ZIP/OPF/XHTML comprobado en la ruta de ingesta.
- **PDF digital:** no hay extractor de texto, estructura de bloques, columnas, notas o orden de lectura comprobado.
- **PDF escaneado/imágenes:** no hay OCR ni reconstrucción de página comprobados.
- **DOCX:** no hay lector OOXML/ZIP ni preservación de estilos, tablas, notas, imágenes o relaciones comprobados.
- **HTML complejo:** no hay un adaptador completo documentado para limpiar DOM y preservar estructura editorial.
- **Calidad editorial/layout:** la ingesta actual no reconstruye márgenes, tipografía, paginación, índices ni elementos visuales.
- **Detección universal de idioma:** el campo `language` se recibe del anfitrión o queda como `und`; esta ruta no demuestra detección automática ni análisis multilingüe profundo.
- **Comprensión semántica total:** una frase sin evidencia en los extractores se registra como no cubierta; no significa que sea irrelevante ni que el motor la haya comprendido.
- **Extracción general de personajes sin etiquetas:** la propia implementación evita inferir entidades solo por mayúsculas. La extracción inicial se apoya en indicadores explícitos o fichas conocidas.
- **Agente/paciente/causalidad confirmados:** la mayor parte de las salidas son candidatos y requieren revisión; un marcador causal no prueba causa.
- **Lectura de libros completos sin pérdidas:** los límites por texto, señales, capítulos y familias de extractores pueden producir truncamiento u omisiones declaradas. La aplicación debe mostrar estos estados y no presentar una salida parcial como completa.

### 4.4 Brecha principal

El flujo actual es más preciso describiéndolo como **ingesta de texto plano/Markdown y extracción estructural heurística con evidencia**, no como lector universal de libros. Para alcanzar el objetivo del producto, el mayor salto de calidad no es añadir más módulos de interpretación aislados: es construir adaptadores de adquisición fieles, normalización estructural y una canalización de lectura que preserve el origen de cada bloque.

## 5. Persistencia, sincronización y distribución

### TypeScript / navegador
`engine.ts` mantiene sesiones, secuencias y colas de edición; `indexeddb-store.ts` implementa persistencia local. El README describe journal incremental, snapshots y recuperación. Las pruebas de IndexedDB en Node usan `fake-indexeddb`, por lo que no sustituyen validaciones en Chrome/Firefox/Safari, cuotas reales, suspensión, corrupción y migración de perfiles.

### Modo de proceso separado
`bridge/stdio-server.mjs` implementa JSON-RPC 2.0 por stdin/stdout. `bridge-client.ts` es el cliente. `sqlite-project-store.mjs` usa `node:sqlite`. La guía de integración declara dos modalidades: mismo runtime con IndexedDB y proceso separado con puente/SQLite. Deben mantenerse contratos equivalentes, migraciones y resultados de recuperación entre ambos adaptadores.

### Rust y MLDB
`engine/` y `storage/` contienen código Rust y protocolos MLDB propios. Sin embargo:
- el README de `typescript/` declara que TypeScript es la implementación vigente y que Rust queda como referencia histórica;
- el README de `storage/` califica MLDB Storage como experimental y advierte que no es una base lista para manuscritos;
- el README de `engine/` condiciona su uso a validación CI nativa y describe límites pendientes.

Por tanto, no se debe presentar MLDB Rust como almacenamiento de producción integrado al runtime TypeScript sin una decisión arquitectónica, puente probado y pruebas nativas completas.

## 6. Revisión textual y capacidades amplias

`proofreading.ts` es un módulo pequeño de reglas deterministas. El README TypeScript enumera reglas iniciales como palabras repetidas, espacios junto a puntuación, espacios dobles y comienzo de oración en minúscula. No es todavía un corrector integral de ortografía, gramática, sintaxis, estilo y semántica para múltiples idiomas.

La documentación de alcance global incorporada en `docs/ANALISIS-LITERARIO-ESTADO.md` contempla traducción editorial, generación visual, mapas, lenguas ficticias, predicción de finales, evaluación literaria y otros módulos. Esta auditoría no encontró evidencia suficiente para clasificarlos como implementados en el runtime actual. Deben permanecer etiquetados como **alcance aprobado para diseño / pendiente de implementación**, hasta que existan código, contratos, integración y pruebas correspondientes.

## 7. Pruebas y estado de CI

- Hay 99 archivos de prueba `.test.mjs` en la carpeta TypeScript; el número de archivos no equivale al número de casos ni demuestra que se ejecuten todos en cada workflow.
- `package.json` define `typecheck`, `build`, `test`, `bench` y validación de esquemas. El comando `test` construye, valida y ejecuta `node --test tests/*.test.mjs test/*.test.mjs`.
- El workflow activo del repositorio está en `.github/workflows/motor-literario-typescript.yml` y ejecuta Node 22, typecheck, pruebas y benchmark.
- En la consulta del 2026-11-26, la ejecución **45818042422** del HEAD `12c3f700e6b33676fff9b0bea93eac2a38ee7bdc` aparecía **in_progress**. No se declara aprobada ni fallida hasta que termine: https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45818042422
- El registro histórico de 718 pruebas aprobadas en el commit `347301ca...` es evidencia de ese commit y esa ejecución, no certifica automáticamente los cambios posteriores ni las nuevas capacidades.

## 8. Documentación duplicada y mapa documental

Los documentos principales están repartidos:
- Alcance/registro superior: `docs/ANALISIS-LITERARIO-ESTADO.md`.
- Estado técnico extenso: `base de datos/Motor-Literario/docs/analysis/ESTADO_ANALISIS_LITERARIO_E_INTELIGENCIA_NARRATIVA.md`.
- Ingesta: `base de datos/Motor-Literario/docs/analysis/INGESTA_Y_COMPRENSION_ESTRUCTURAL_DE_LIBROS.md`.
- Integración: `base de datos/Motor-Literario/docs/integration/GUIA_INTEGRACION_ANFITRION_V1.md` y `BRIDGE_PROCESS_PROTOCOL_V1.md`.
- Esquema/persistencia: `MLDB/`, `database/` y `storage/`.
- Monitor de escritura: `LIVE_AUTHOR_MONITOR_PROGRESS.md`, `LIVE_AUTHOR_MONITOR_OBSERVABILITY_ACCURACY.md` y documentación del paquete.

No son necesariamente duplicados byte a byte: tienen objetivos distintos, pero el estado puede divergir. La guía de integración, por ejemplo, indica una versión de IndexedDB y un esquema lógico concretos; los README y el código deben verificarse en cada actualización. Se recomienda un índice maestro con enlaces y una regla de autoridad por tema, no fusionar documentos extensos sin reconciliar versiones.

## 9. Riesgos y huecos prioritarios

| Prioridad | Hueco | Consecuencia | Trabajo requerido |
|---|---|---|---|
| P0 | Lectura real de EPUB/PDF/DOCX/OCR ausente | Muchos libros no se pueden adquirir fielmente | Adaptadores por formato y corpus de fixtures |
| P0 | Normalización estructural editorial incompleta | Pérdida de orden, notas, tablas, imágenes y jerarquía | Modelo intermedio de documento con bloques y procedencia |
| P0 | Integración end-to-end de todos los extractores no demostrada | Módulos aislados pueden no alimentar el mismo conocimiento | Grafo de llamadas, orquestador único y pruebas de flujo completo |
| P1 | Cobertura lingüística dependiente de reglas y lexicones | Falsos positivos/negativos y sesgo por idioma | Inventario de patrones por idioma, perfiles y evaluación con corpus |
| P1 | Resolución sintáctica y correferencia general limitadas | Roles, pronombres, sujeto elíptico e identidad ambiguos | Resolución por etapas con confianza, alternativas y evidencia |
| P1 | Revisión ortográfica/gramatical demasiado básica | No cumple la amplitud editorial aprobada | Capas separadas de ortografía, morfosintaxis y estilo |
| P1 | Estados de truncamiento/presupuesto deben propagarse a UI/API | El usuario puede interpretar salida parcial como completa | Contrato de completitud por capítulo, familia y documento |
| P1 | Diferencias entre IndexedDB y SQLite puente | Riesgo de comportamiento divergente | Suite de contrato común para adaptadores |
| P1 | MLDB Rust experimental y no integrado al runtime TypeScript | Confusión sobre el almacenamiento real | Decisión explícita: mantener separado o plan de integración |
| P2 | Índice documental disperso | Dificulta localizar autoridad y pendientes | Índice maestro y matriz de autoridad |
| P2 | Alcance visual/lingüístico avanzado sin runtime | Expectativas mayores que la implementación | Marcar cada capacidad como diseñada, prototipo, integrada o validada |

## 10. Plan de auditoría y desarrollo por frentes

### Frente A — Adquisición y lectura (máxima prioridad)
1. Definir un modelo intermedio de libro: archivo, contenedor, secciones, bloques, párrafos, runs, notas, tablas, imágenes, pies, encabezados, orden de lectura y coordenadas/página cuando existan.
2. Crear adaptadores independientes para TXT/Markdown, EPUB, DOCX, PDF digital y PDF escaneado/OCR.
3. Preservar para cada bloque: formato/origen, identificador, capítulo, página/índice, offsets del texto normalizado, offsets originales cuando sean recuperables, hash y evidencia de transformación.
4. Añadir detección de codificación, BOM, normalización Unicode controlada, orden de lectura y diagnóstico de elementos no extraídos.
5. Crear corpus de libros de prueba con casos multicolumna, notas, tablas, imágenes, capítulos sin encabezado, diálogos, poesía, idiomas y documentos corruptos.
6. Verificar integridad: páginas/capítulos/bloques esperados vs extraídos; nunca declarar lectura completa si hay elementos omitidos.

### Frente B — Extracción y comprensión
1. Construir un orquestador explícito de extractores por fase, idioma y presupuesto.
2. Unificar contratos de evidencia, procedencia, confianza, hipótesis, alternativas, negación, modalidad y estado de revisión.
3. Separar detección lexical, análisis morfológico, sintaxis, correferencia, semántica y consolidación de conocimiento.
4. Añadir evaluación de precisión/recobrado por dominio e idioma con corpus etiquetados.
5. Propagar omisiones y cobertura por capítulo y extractor; una cobertura alta no debe denominarse comprensión semántica total.

### Frente C — Modelo de conocimiento y continuidad
1. Auditar las rutas de persistencia de entidades, relaciones, acontecimientos, ideas, afirmaciones, objetos, lugares y cronologías.
2. Comprobar que cada candidato llega a revisión humana y solo se consolida con autorización.
3. Construir pruebas end-to-end de menciones a fichas, pronombres, acciones, cambios de estado, causalidad, cronología y cabos sueltos.
4. Comprobar invalidación y rebase de evidencias cuando cambia una revisión del libro.

### Frente D — Integración y operación
1. Comparar IndexedDB y SQLite con una misma suite de contrato.
2. Probar recuperación en navegadores reales y en modo proceso separado.
3. Definir backup/restore, exportación/importación y migraciones soportadas.
4. Resolver la autoridad entre TypeScript vigente y crates Rust/MLDB experimentales.
5. Verificar el workflow actual y añadir matrices de ejecución que hagan visibles suites omitidas.

### Frente E — Documentación y producto
1. Crear índice maestro y matriz de estado por capacidad.
2. Mantener separados alcance aprobado, implementación, integración, pruebas y validación real.
3. Documentar las acciones explícitas que el usuario solicita: el motor no inicia traducciones, correcciones, ilustraciones, mapas ni generación de contenido por iniciativa propia.
4. Toda operación de análisis debe ser no destructiva por defecto; cualquier modificación del original requiere una acción explícita.

## 11. Criterio de clasificación obligatorio

Cada capacidad se clasificará con uno de estos estados:
- **Diseñada:** existe requisito/contrato/documentación, pero no implementación demostrada.
- **Implementada aislada:** hay código y pruebas unitarias, pero no se demuestra el flujo completo del producto.
- **Integrada:** la API/orquestador la invoca y el resultado llega al modelo/consumidor previsto.
- **Validada:** typecheck/build/pruebas pertinentes ejecutadas y aprobadas en un commit identificado.
- **Limitada:** funciona solo bajo condiciones, idiomas, formatos o presupuestos declarados.
- **Pendiente / no encontrada:** no hay evidencia suficiente en el repositorio inspeccionado.

No se asignarán porcentajes globales de avance a partir del número de archivos o pruebas. Primero debe existir una matriz de requisitos con pesos y criterios de aceptación verificables.

## 12. Próxima acción técnica

La siguiente auditoría debe recorrer `narrative-book-ingestion.ts` desde sus entradas hasta cada extractor, revisar las implementaciones de cada familia y rastrear las llamadas desde `host-api.ts`. Después debe hacer lo mismo con los adaptadores de archivos y la persistencia. El primer entregable de código recomendado es el **modelo intermedio de libro y el contrato de adaptadores de adquisición**, sin añadir dependencias de ejecución hasta que se aprueben sus límites y proveedores.

---

**Nota de rigor:** este documento registra hallazgos verificables del árbol, fuentes y documentación inspeccionados. Donde no se ejecutó código o no se rastreó un flujo completo, se indica como pendiente de validación; no convierte planes o comentarios de README en capacidades operativas.
