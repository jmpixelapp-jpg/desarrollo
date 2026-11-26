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

## Ejemplo de uso desde el anfitrión

```ts
const source = await readNarrativeBookFile(file);
const knownEntities = await api.getNarrativeEntities();

const book = ingestNarrativeBookText({
  projectId,
  documentId,
  revision,
  title: source.fileName,
  language: "es",
  text: source.text,
  entities: knownEntities
});

// book.chapters / book.paragraphs: estructura con offsets y evidencia.
// book.signals: señales lingüísticas revisables.
// book.observations: acciones relacionadas con fichas conocidas.
// book.observationStatus: declara si el análisis de observaciones fue completo.
```

La búsqueda de menciones de entidades usa límites de palabra basados en propiedades Unicode reales; no debe reconocer un nombre como subcadena de otra palabra (por ejemplo, «Ana» dentro de «ventana»). Las referencias pronominales permanecen sin resolver y solo proponen antecedentes locales con evidencia.

Las observaciones de acción ligadas a personajes distinguen ahora el futuro gramatical en formas seleccionadas (por ejemplo, «cruzará», «llegará», «caminará» y «entrará»). Esta clasificación describe la forma verbal; no convierte por sí sola una promesa, predicción o intención en un acontecimiento sucedido ni establece la cronología global de la obra.

El descubrimiento de vínculos entre acciones valida también la forma de cada observación de entrada: exige evidencia de acción con offsets enteros, fragmento literal coincidente, documento y revisión correctos, e IDs únicos. Las entradas malformadas se rechazan con un error de validación controlado en vez de provocar una excepción interna por acceso a propiedades ausentes.

La detección de futuro en observaciones de personajes se generalizó al inventario léxico de acciones: genera formas regulares a partir del infinitivo y contempla los futuros irregulares frecuentes de «decir» y «salir». Las expresiones mantienen límites Unicode de palabra para no aceptar coincidencias como prefijos. El resultado sigue siendo una clasificación morfológica candidata, no una fecha ni una afirmación de que el hecho ocurra.

Cada observación conserva ahora `entityMentionEvidence`: para cada personaje, objeto, lugar u otra entidad detectada en la frase, registra el ID, el tipo de entidad y la primera coincidencia literal con offsets UTF-16 exactos. La evidencia de mención no asigna por sí sola el papel de agente, paciente, destino ni propietario; solo permite verificar dónde aparece la entidad y sirve como base para un análisis sintáctico posterior.

En construcciones pasivas, el extractor puede conservar por separado el sujeto paciente y un candidato a agente explícito introducido por «por». El agente solo se propone cuando el nombre propio coincide exactamente con una entidad conocida; el fragmento y sus offsets se guardan como evidencia. La ausencia de una entidad coincidente no se completa por inferencia.

## Garantías y límites

1. La ingesta no modifica el manuscrito.
2. Los fragmentos y offsets se refieren al texto de entrada; los offsets son unidades UTF-16 de JavaScript.
3. Las acciones detectadas son señales léxicas, no acontecimientos confirmados.
4. Un marcador como «porque» no demuestra por sí solo causalidad; se conserva como candidato revisable.
5. La polaridad negativa de una acción se determina dentro de su cláusula/oración, para evitar que un «no» de una oración anterior contamine la siguiente. Las señales no accionarias no heredan polaridad negativa por mera proximidad.
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

### Decodificación y BOM UTF-8

El lector acepta TXT y Markdown UTF-8 estricto. La decodificación conserva explícitamente un BOM UTF-8 inicial (`U+FEFF`) en el texto devuelto (`ignoreBOM: true`). La segmentación lo omite al reconocer el primer encabezado, pero conserva el desplazamiento de una unidad UTF-16 para que las evidencias posteriores sigan apuntando al texto decodificado original. Así, los offsets son coherentes con la cadena exacta que devuelve el lector.

### Objeto directo de entidades conocidas

Para entidades de tipo `object`, el descubrimiento de observaciones puede proponer `grammaticalObjectCandidate` cuando una mención literal única aparece inmediatamente después del verbo con un patrón nominal explícito (por ejemplo, «Ana perdió la Espada Solar»). Se conserva el ID y la evidencia exacta del nombre con offsets absolutos. Esto identifica un candidato a objeto gramatical, no confirma posesión, transferencia, pérdida efectiva ni estado del objeto. Si falta el marcador nominal o la entidad es ambigua, no se asigna candidato.

Además, cada evidencia específica (acción, objeto, actor y destinatario) debe quedar contenida en el fragmento contextual de la misma transición. Se verifica tanto el rango como la coincidencia literal del subfragmento. Esto evita aceptar una mención de participante que esté fuera de la oración/línea aportada como contexto o que no coincida con el texto fuente.

La comparación entre frases y evidencias utiliza intervalos ordenados y un recorrido lineal, evitando comparar cada frase contra toda la colección de evidencias. El procesamiento mantiene límites explícitos y offsets UTF-16 para que la auditoría siga siendo viable en manuscritos extensos.

### Extracción de referencias temporales

Módulo: `typescript/src/narrative-temporal-reference-discovery.ts`

La extracción distingue fechas ISO y fechas escritas en español (validadas con calendario), años, fechas numéricas ambiguas, relaciones de orden (`antes`, `después`, `mientras`, `al día siguiente`), duraciones relativas, franjas del día y horas explícitas. Las fechas válidas se normalizan a `YYYY-MM-DD`; una fecha numérica como `12/03/1945` no se interpreta como día/mes o mes/día sin una configuración de idioma inequívoca.

Las expresiones relativas conservan su superficie textual, clase de relación y requisito de ancla. No se convierten en fechas absolutas ni se ordenan globalmente sin una referencia temporal verificable. Horas y franjas del día tampoco reciben fecha por inferencia. Cada candidato conserva offsets y evidencia literal; el procesamiento se omite explícitamente si el texto supera el presupuesto de dos millones de unidades UTF-16.

### Presencia explícita de personajes en lugares

Módulo: `typescript/src/narrative-location-presence-discovery.ts`

La ingesta detecta afirmaciones como «Ana está en el castillo», «Ana se encontraba dentro de la torre», «Ana vive en París» o «Ana parece estar cerca del puerto» cuando el personaje y el lugar tienen fichas explícitas y no ambiguas. Conserva evidencias separadas para personaje, cópula/predicado, relación espacial, lugar y afirmación completa. Distingue presente, pasado, futuro, condicional, negación y modo perceptual/modal.

La detección es deliberadamente conservadora: exige un único personaje nombrado en la oración y un lugar tipado como `location`; no resuelve pronombres ni atribuye automáticamente una ubicación a varios personajes coordinados. Futuro y condicional se mantienen como prospectivo/hipotético; una negación no se transforma en presencia. La salida nunca consolida «ubicación actual»: cada afirmación sigue siendo candidata revisable.

### Trayectorias de ubicación derivadas del texto

Módulo: `typescript/src/narrative-location-transition-discovery.ts`

La ingesta puede proponer movimientos cuando coinciden tres elementos explícitos dentro de una misma evidencia: una acción reconocida, una entidad clasificada como `location` y la relación preposicional entre ambas. Se reconocen, de forma conservadora, llegada (`llegar a/al/hasta/en`), salida (`salir de/desde`), entrada (`entrar en/a/al/hacia`), tránsito (`cruzar por/a través de/a lo largo de`) y regreso (`regresar/volver a/al/hacia/hasta`).

Cada propuesta conserva IDs, revisión, acción, lugar, sujeto gramatical activo si se pudo identificar, fragmento de relación preposicional y contexto literal. La negación se marca como `not-applied`, el futuro como `prospective` y las formas verbales no resueltas no se convierten en movimientos consolidados. Toda salida permanece como candidata revisable.

**Límites deliberados:** no se infiere ubicación actual, coordenadas, distancia, ruta, dirección geográfica, estancia continua ni presencia posterior. Una mención cercana no basta: si falta la preposición esperada o la entidad no está tipada como lugar, no se crea una transición. Los movimientos con pronombres o sujeto ambiguo pueden conservar el lugar y la acción, pero no reciben actor inventado.

Módulo complementario: `typescript/src/narrative-location-trajectory.ts`

`buildNarrativeLocationTrajectories()` agrupa movimientos por personaje y los ordena exclusivamente con un mapa de orden editorial de capítulos suministrado por el proyecto. Puede señalar una secuencia textual de salida seguida de llegada cuando ambas transiciones son afirmadas y candidatas. La secuencia conserva las dos evidencias y las ubicaciones de origen/destino mencionadas; no infiere trayecto directo, transporte, distancia, continuidad del viaje ni paradas intermedias. Los capítulos entre dos movimientos sin candidatos se muestran como huecos de cobertura, nunca como prueba de que el personaje no se movió.

### Auditoría de cobertura: localizar lo que el extractor todavía no comprende

Módulo: `typescript/src/narrative-extraction-audit.ts`

La ingesta incorpora `extractionAudit`, que divide el texto en unidades de frase operativas y contrasta cada una con evidencias exactas de acciones, acontecimientos y otros extractores estructurados (por ejemplo, estados explícitos de personajes y transiciones de ubicación). Informa por separado la cobertura de acciones/acontecimientos, la cobertura adicional y la cobertura global. Las frases sin solapamiento con ninguna evidencia se devuelven como `uncoveredSentences`, cada una con fragmento literal, offsets UTF-16 absolutos, documento, revisión, ID estable y estado `unreviewed`.

La auditoría informa cantidad total de frases, frases cubiertas por cada familia de extractores, cobertura global, frases pendientes, proporción global de cobertura, pendientes omitidos por límite y truncamiento. Los encabezados estructurales de capítulo no se cuentan como frases pendientes. La salida tiene límites explícitos para no permitir que textos enormes creen colas ilimitadas.

**Interpretación obligatoria:** `coverageRatio` mide cobertura de los extractores actuales, no comprensión semántica total ni calidad literaria. Una frase pendiente puede contener una acción, un cambio de estado, una descripción, una relación, una emoción, una pista o cualquier información que el inventario de patrones aún no reconoce. Por eso la cola es una herramienta para descubrir omisiones, no una clasificación de irrelevancia. La auditoría valida que toda evidencia aportada pertenezca al documento/revisión y coincida literalmente con el texto fuente.

### Corroboración textual de entrega y recepción

La trayectoria ahora puede emitir `continuitySignals` de tipo `transfer-reception-corroboration` cuando dos transiciones consecutivas del mismo objeto contienen: una entrega afirmada, seguida por una recepción afirmada, y ambas identifican explícitamente al mismo destinatario. El vínculo conserva las dos evidencias de destinatario y los IDs de las transiciones relacionadas.

Este vínculo es únicamente una corroboración candidata: no prueba que la transferencia haya ocurrido materialmente, que el receptor haya conservado el objeto ni que no existan acontecimientos omitidos entre ambos pasajes. No se crea si la entrega está negada, es futura/prospectiva, carece de evidencia del destinatario o el destinatario de la recepción es distinto. Tampoco se enlazan transiciones no consecutivas.

### Ordenación de trayectorias de objetos entre capítulos

Módulo: `typescript/src/narrative-object-trajectory.ts`

`buildNarrativeObjectTrajectories(input)` agrupa las transiciones candidatas por identidad de objeto y las ordena mediante `documentOrder`, que debe proporcionar el proyecto con una posición editorial explícita por documento. Dentro del mismo capítulo se usa el offset de la evidencia de acción. No se deduce el orden por nombre de archivo, fecha de modificación ni orden accidental de llegada de los datos.

Cada entrada conserva la transición completa y su evidencia. Si entre dos capítulos con transiciones hay documentos intermedios sin otra transición candidata para ese objeto, sus identificadores se muestran en `interveningDocumentsWithoutTransitionCandidate`. Esto no significa que el objeto no aparezca en esos capítulos: solo indica que el motor no encontró una transición de las cuatro clases implementadas.

La cobertura se declara como `candidate-transitions-only`; el resultado no confirma posesión, custodia, causalidad, ubicación ni continuidad física. Se rechazan capítulos con posiciones duplicadas, documentos no ordenados, IDs de transición duplicados, evidencias con rangos incoherentes y revisiones mezcladas dentro de un mismo documento. La función no modifica entidades ni consolida estados.

### Trayectoria de objetos y cambios de estado candidatos

Módulo: `typescript/src/narrative-object-state-discovery.ts`

La función `discoverNarrativeObjectTransitionCandidates(input)` consume observaciones ya extraídas y propone cuatro clases limitadas de transición:

- `discovered`: «Ana encontró la Espada Solar». Identifica quién encontró el objeto, pero no concluye que lo conserve.
- `lost`: «Ana perdió la Espada Solar». Identifica al personaje y al objeto, pero no inventa el nuevo poseedor ni la ubicación.
- `transferred`: «Ana entregó la Espada Solar a Bruno». Exige sujeto activo, objeto directo y receptor explícito. El extractor reconoce al receptor incluso cuando el sintagma del objeto aparece entre el verbo y «a + personaje».
- `received`: «Ana recibió la Espada Solar». Identifica al receptor, pero deja desconocido al emisor.

Cada candidato enlaza la observación original y conserva evidencia separada de acción, objeto, actor, receptor y contexto. La función no modifica fichas ni consolida inventarios. `effectStatus` distingue `candidate`, `prospective` (futuro) y `not-applied` (negación); por tanto, ni una promesa futura ni una frase negada pueden convertirse en posesión actual. Las evidencias obsoletas, de otra revisión o de otro documento se rechazan. También se comprueba que la longitud UTF-16 de cada fragmento coincida con su rango y que la evidencia del verbo esté contenida en el contexto de la observación. Cuando una línea contiene varias oraciones, el rango del contexto abarca la línea completa que se conserva en `excerpt`, mientras que la evidencia de la acción mantiene su rango exacto.

La cobertura es deliberadamente limitada: no se infieren transferencias por coocurrencia, verbos no contemplados, poseedores posteriores, custodia, propiedad legal ni ubicación. Las salidas requieren revisión y futuras etapas deberán enlazar transiciones entre capítulos sin convertir incertidumbres en hechos.

### Complemento personal explícito

El descubrimiento de observaciones puede conservar un candidato sintáctico para el patrón local «verbo + a + nombre de personaje conocido». Se guarda el ID de la entidad y la evidencia literal del nombre con offsets del documento. Esto no afirma por sí solo una relación semántica de víctima, destinatario, receptor o paciente. La coincidencia exige una entidad única registrada; una mención anterior al verbo no se reutiliza como objeto. Las pruebas cubren «Ana encontró a Bruno» y «Bruno encontró a Ana» para evitar invertir los participantes.

## Próximas etapas técnicas

1. Adaptadores de lectura para EPUB, PDF y DOCX, preservando el mapa entre texto extraído y ubicación original; TXT/Markdown ya dispone de lector estándar.
2. Resolución de capítulos y secciones con encabezados no convencionales, numeración y metadatos.
3. Ampliar progresivamente el inventario verbal por idioma y variedad lingüística, validando cada forma con casos positivos y negativos para evitar prefijos espurios.
4. Resolución de menciones a entidades con alias, pronombres y referencias entre párrafos, manteniendo candidatos y evidencia.
4. Extracción de acontecimientos con participantes y roles gramaticales separados de los personajes meramente mencionados.
5. Normalización temporal por línea narrativa, distinguiendo tiempo del discurso, tiempo de la historia, duración e incertidumbre.
6. Relaciones causales tipadas (causa, condición, consecuencia, motivación) con soporte textual y estado de revisión.
7. Continuidad entre capítulos: estado de personajes, ubicación, posesiones, objetivos, conocimiento y cambios de estado; detección de contradicciones con evidencia en ambos extremos.
8. Persistencia incremental e idempotente de resultados por revisión, con invalidación cuando cambian los fragmentos fuente.

## Verificación

La suite `tests/narrative-book-ingestion.test.mjs` cubre segmentación, offsets, señales, cautela semántica, alcance de negación entre oraciones, formas verbales de llegada/movimiento en presente y futuro, límites y determinismo. Ejecutar desde esta carpeta:

```sh
npm test
```

La implementación debe considerarse una primera capa de adquisición y estructuración, no una comprensión literaria completa ni un parser universal de formatos.
