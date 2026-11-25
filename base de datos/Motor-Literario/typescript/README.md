# Motor Literario — núcleo TypeScript inicial

Esta carpeta contiene la implementación definitiva en TypeScript. El código Rust anterior queda como referencia histórica y no forma parte del runtime del producto.

**Integración con el programa anfitrión:** consulte la [Guía de integración TypeScript](../docs/integration/GUIA_INTEGRACION_ANFITRION_V1.md), que define el contrato público y los pasos de conexión.

## Principios

- Sin motores lingüísticos, correctores, servicios ni bibliotecas de terceros en tiempo de ejecución.
- El anfitrión proporciona la identidad del proyecto y los snapshots del editor.
- La admisión de cambios es síncrona, breve y acotada; el guardado y el análisis ocurren en segundo plano. El texto activo usa una tabla de piezas para evitar reconstruir el manuscrito completo en cada edición.
- El texto original nunca se modifica automáticamente.
- La persistencia utiliza IndexedDB nativo del entorno y no transmite datos. Los cambios se registran incrementalmente y se consolidan en snapshots periódicos.
- La apertura de IndexedDB se recupera ante errores o bloqueos: un intento fallido no queda cacheado como conexión permanente, las conexiones cerradas por cambios de versión se descartan y una apertura que se desbloquea tarde se cierra para no dejar conexiones huérfanas.\n
- Los checkpoints del journal en IndexedDB guardan el snapshot y eliminan los deltas ya incorporados dentro de una única transacción de escritura sobre ambos almacenes. Si la transacción se aborta, permanecen el snapshot anterior y el journal anterior; si confirma, ambos cambios quedan visibles juntos. El contrato de almacenamiento exige una lectura atómica de snapshot y journal (`loadDocumentWithChanges`); los adaptadores que no implementen checkpoints atómicos pueden conservar la ruta de guardado y compactación separadas, siempre que ambas operaciones mantengan las garantías de durabilidad del contrato.
- Los offsets del editor son unidades UTF-16, compatibles con las API habituales de JavaScript.
- Todas las lecturas IndexedDB de snapshots, deltas y conocimiento narrativo (entidades, relaciones, acontecimientos, ideas, afirmaciones y biblioteca personal) solo entregan resultados después de que sus transacciones readonly completan correctamente. Los snapshots se validan también al leerlos. Los registros narrativos exigen projectId e id no vacíos antes de persistirse; la biblioteca personal valida escritor, proyecto de origen y procedencia antes de entregar ideas. La migración de IndexedDB versión 11 verifica y reconstruye índices faltantes incluso cuando el object store ya existía, y la compactación compatible exige metadatos íntegros además de coincidencia exacta de secuencia, y valida continuidad de secuencias y revisiones antes de entregar el journal al motor; un hueco o registro malformado fuerza resincronización en lugar de una recuperación parcial. El guardado compatible de snapshots tampoco puede adelantar un documento ni inicializarlo sobre un journal no vacío: esos casos requieren el checkpoint atómico, que puede reconstruir y verificar el texto antes de compactar. La escritura de deltas también exige que exista un snapshot durable de base: el journal nunca puede inaugurarse con una edición huérfana. La compactación compatible no atómica solo elimina registros cuando existe un snapshot durable cuya secuencia coincide exactamente con el límite solicitado; la lectura, comprobación y eliminación se serializan en una transacción compartida.

## Desarrollo

Requiere Node.js y npm como herramientas de desarrollo. Vite y TypeScript son herramientas de compilación, no motores externos del producto.

```sh
npm install
npm run typecheck
npm run build
npm test
npm run bench
```

## Primera entrega implementada

- Contratos TypeScript para proyecto, documento, cambios, diagnósticos y almacenamiento.
- Vinculación explícita a la identidad suministrada por el anfitrión.
- Sesiones de documento con revisión y secuencia.
- Cola acotada y admisión no bloqueante para cambios del editor. La API valida primero la identidad documental, el estado de resincronización y la secuencia/revisión esperadas; solo después aplica el límite de capacidad. Así, `invalid_change` y `resync_required` no quedan ocultos por `queue_full`, y los contadores por motivo reflejan la causa efectiva del rechazo. Ante `queue_full`, el anfitrión debe conservar el cambio y reintentarlo tras recibir capacidad disponible o después de aplicar su propia contrapresión; no debe descartarlo silenciosamente. La validación de offsets usa la longitud UTF-16 proyectada tras todos los cambios ya admitidos para ese documento, no solo la longitud del último snapshot confirmado. Así se rechazan durante la admisión los rangos que ya son imposibles después de inserciones o eliminaciones en cola, sin confundirlos con cambios válidos que usan offsets de revisiones intermedias. Si una edición admitida falla al persistir o exige resincronización, se descarta la proyección y se bloquean nuevas admisiones hasta recibir el snapshot autoritativo.
- Presupuesto de memoria para reemplazos pendientes: `maxQueuedTextUnits` limita por defecto a 4.194.304 unidades UTF-16 el texto total retenido en la cola. El control se actualiza en O(1) al admitir y retirar cada cambio; no vuelve a medir ni copiar el manuscrito en cada pulsación. Una edición individual que supera todo el presupuesto se rechaza como `change_too_large`; si el presupuesto agregado está ocupado, se devuelve `queue_full`. Las métricas `queuedTextUnits`, `maxQueuedTextUnits` y `changeTooLargeRejections` permiten observar el uso y distinguir un pegado individual excesivo de una cola temporalmente saturada. El anfitrión debe conservar el cambio rechazado y aplicar contrapresión o resincronización según corresponda; nunca descartarlo silenciosamente.\n- Procesamiento concurrente acotado entre documentos independientes (`maxConcurrentDocuments`, predeterminado 2 y configurable entre 1 y 8), manteniendo estrictamente el orden FIFO de las revisiones de cada documento. Un documento con análisis o persistencia lenta no detiene los cambios de los demás documentos. La cola global reserva hasta `maxConcurrentDocuments - 1` posiciones cuando una sola identidad documental intenta ocuparla, de modo que una ráfaga de un capítulo no consuma toda la capacidad antes de que otro capítulo pueda entrar. El límite global sigue siendo estricto; al agotarse la capacidad, el anfitrión recibe `queue_full` y debe aplicar contrapresión. Las métricas distinguen `queueFullRejections`, `resyncRequiredRejections`, `invalidChangeRejections` y `unknownDocumentRejections`, además del contador agregado `rejectedChanges`, para que el anfitrión diferencie saturación temporal de errores de sincronización o validación.
- Texto activo mediante tabla de piezas con fragmentos originales y añadidos; compactación interna para limitar fragmentos retenidos.
- Persistencia local mediante IndexedDB con journal de cambios, reproducción ordenada del journal al reiniciar y snapshots cada 64 ediciones; las ediciones normales guardan deltas en lugar del manuscrito completo.
- Reglas deterministas iniciales: palabras repetidas, espacios antes/después de puntuación, espacios dobles e inicio de oración en minúscula.
- Resultados asociados a proyecto, documento y revisión.
- Diagnósticos persistidos en IndexedDB por proyecto, documento y revisión; al reabrir un documento, se reutiliza el resultado exacto o se recalcula la revisión recuperada y se guarda.
- El anfitrión consulta los diagnósticos vigentes mediante `getDocumentDiagnostics(documentId)`; `flushPendingChanges()` también espera la recuperación y persistencia de diagnósticos.
- Análisis de todas las líneas afectadas, incluso en inserciones y eliminaciones multilínea.
- Validación de entradas del anfitrión y bloqueo de carreras entre apertura, resincronización y persistencia.
- Estado de sincronización consultable; si falla un guardado o hay conflicto de revisión, el documento exige que el anfitrión reenvíe un snapshot autoritativo antes de aceptar más cambios.
- Barrera `flushPendingChanges()` para que el anfitrión espere la finalización de los cambios admitidos antes de cerrar o suspender el editor.
- Pruebas Node iniciales para flujo de cambios, saturación, aislamiento de identidad, fallos de persistencia, ediciones multilínea, journal incremental, compactación y reemplazos sobre fragmentos.



#
## Conocimiento narrativo por proyecto

El módulo `narrative-knowledge.ts` incorpora la primera capa de conocimiento estructurado:

- Reconoce personajes, lugares y objetos solo cuando aparecen junto a indicadores explícitos; no clasifica automáticamente cualquier palabra con mayúscula.
- Conserva evidencia de cada mención: documento, revisión, rangos UTF-16 y fragmento literal. Los extractores validan los identificadores, revisiones, fechas y offsets de entrada antes de procesar texto; también comprueban que el cálculo del offset final no supere el rango entero seguro de JavaScript.
- Las entidades entregadas a extractores de relaciones, acontecimientos y afirmaciones deben pertenecer al proyecto solicitado y tener estructura válida; una colección cruzada o malformada se rechaza completa, sin producir resultados parciales.
- Agrupa menciones y evita duplicar evidencias. Las extracciones se serializan para no perder datos cuando llegan capítulos en paralelo.
- Registra relaciones entre personajes solo cuando ambos extremos ya están identificados y la frase contiene una construcción explícita (por ejemplo, parentesco, alianza o una acción como ayudar, salvar o traicionar).
- Captura acontecimientos únicamente si el escritor o el anfitrión los marca en una línea con `ACONTECIMIENTO:` o `EVENTO:`. Los participantes se vinculan con personajes previamente identificados.
- Captura ideas únicamente desde líneas marcadas con `IDEA:`. Cada idea conserva el documento de origen, el título del libro proporcionado por el anfitrión, evidencia e historial de revisiones. El anfitrión puede cambiar su estado a `IDEA`, `incorporated` o `discarded`; las transiciones quedan registradas por separado con fecha y motivo (`writer` o `text-revised`), sin duplicar entradas cuando se repite el mismo estado. Si el texto cambia, la versión nueva vuelve a `IDEA` y conserva el historial anterior. La transferencia final de ideas `IDEA` a una biblioteca personal aislada por escritor está implementada mediante una transacción local; requiere que el anfitrión suministre `writerId` al inicializar el proyecto.
- Todas las colecciones se aíslan mediante el `projectId` proporcionado por la aplicación anfitriona.

La base IndexedDB está en versión 21 y conserva las colecciones previas, con entidades, relaciones, acontecimientos, ideas, afirmaciones históricas y la biblioteca personal de ideas local. La migración verifica y reconstruye índices faltantes en almacenes existentes, sin reemplazar ni vaciar las colecciones.

La API del anfitrión expone `extractNarrativeKnowledge(documentId, revision, text)`, `getNarrativeEntities()`, `getNarrativeRelations()`, `getNarrativeEvents()`, `getNarrativeIdeas()`, `setNarrativeIdeaStatus(ideaId, status)`, `getNarrativeAssertions()` y `getNarrativeEntityHistory(entityId)`.

La extracción inicial se programa al abrir cada documento. Si una interrupción ocurre entre escrituras de registros narrativos, la siguiente apertura vuelve a extraer el documento completo; las fusiones de entidades, relaciones, acontecimientos e ideas deduplican evidencias para hacer recuperable una extracción parcial sin duplicar registros. La persistencia de cada registro es durable por separado, no una transacción global de todas las colecciones. Después, cada resultado de análisis incluye el fragmento de líneas afectadas y sus offsets absolutos; el anfitrión lo procesa en segundo plano. Los errores de persistencia narrativa se notifican mediante `callbacks.onKnowledgeError` y no revierten una edición confirmada ni impiden abrir el documento. La reconciliación de offsets guarda cada registro antes de actualizar sus índices en memoria. Si un cierre interrumpe el desplazamiento de una línea, la reapertura puede recuperar la identidad de acontecimientos e ideas mediante coincidencia exacta de la evidencia de línea dentro del mismo documento, y la de afirmaciones mediante entidad, atributo, valor y evidencia exacta; las ocurrencias repetidas se emparejan una sola vez y por cercanía de posición. El extractor nunca modifica el manuscrito. Los offsets de evidencia se mantienen absolutos respecto del documento. Los nombres que todavía se están escribiendo al final de una línea se aplazan hasta que aparece un delimitador, evitando registrar palabras incompletas. Los acontecimientos requieren una marca explícita y las ideas requieren `IDEA:`; el motor todavía no infiere acontecimientos, cronología ni contradicciones de forma semántica. La biblioteca personal de ideas al cerrar un libro usa la identidad estable del escritor que el anfitrión entrega mediante `ProjectIdentity.writerId`; la API no acepta un identificador alternativo al consultar o archivar. Cada instancia de `HostEngineApi` queda ligada a una única identidad de proyecto: para trabajar con otro libro, incluso del mismo escritor, el anfitrión crea otra instancia y reutiliza únicamente el `writerId` autenticado.

## Medición de rendimiento

`npm run bench` genera manuscritos sintéticos de 10.000, 100.000 y 500.000 palabras, además de un escenario de línea única extensa (20.000 palabras por defecto). Mide apertura, lote de ediciones, latencias p50/p95 de confirmación, latencias p50/p95 integrales hasta completar el análisis y la persistencia del conocimiento narrativo, y variación aproximada del heap. El adaptador en memoria implementa la persistencia mínima de entidades para que el benchmark recorra también la ruta de análisis narrativo en vivo. El escenario de línea única verifica el coste de fragmentación del análisis y sus cesiones del hilo. Un escenario adicional aplica ediciones sostenidas a varios documentos y registra el máximo de documentos activos para verificar la concurrencia acotada. El benchmark no introduce latencia de disco: mide el núcleo de edición, análisis y cola más el procesamiento narrativo con almacenamiento en memoria, no el rendimiento real de IndexedDB. Los resultados dependen del equipo y del entorno; deben ejecutarse y conservarse antes de establecer objetivos de latencia. Se pueden ajustar los escenarios con `EDITS_PER_SIZE=100`, `LONG_LINE_WORDS=50000`, `LONG_LINE_EDITS=10`, `CONCURRENT_DOCUMENTS=4` o `CONCURRENT_EDITS_PER_DOCUMENT=20` antes de ejecutar `npm run bench`.

## Recuperación después de un cierre inesperado

Al abrir un documento, el motor compara el snapshot local con el snapshot autoritativo del anfitrión. Si ambos coinciden exactamente, lee y reproduce los cambios durables posteriores, verificando secuencia, revisión base, rangos y documento. Si detecta un journal corrupto o discontinuo (secuencias duplicadas, saltos, orden incorrecto, revisiones incompatibles o rangos inválidos), detiene la apertura y conserva sin modificaciones el snapshot y todos los deltas. No descarta ni compacta parcialmente un journal que podría contener ediciones ya confirmadas. El anfitrión debe resolver el conflicto y entregar una base autoritativa más reciente; hasta entonces el documento no se publica en memoria. Guarda el estado reconstruido antes de publicarlo y después compacta el journal mediante checkpoint atómico cuando el adaptador lo admite. Un snapshot entrante nunca puede retroceder la revisión o secuencia ya persistidas, ni avanzar ambos contadores en cantidades distintas: cada edición confirmada incrementa revisión y secuencia exactamente una vez. Tampoco puede cambiar el texto manteniendo ambos contadores iguales. Estos casos se rechazan antes de escribir o compactar, para impedir que una entrega atrasada o desalineada del anfitrión revierta ediciones ya confirmadas. Si el anfitrión aporta un snapshot distinto con revisión y secuencia más recientes, ese estado puede reemplazar la base anterior y descartar el journal previo de ese documento.

## Integración del editor

- Abrir cada documento con un snapshot autoritativo del anfitrión.
- Enviar cada operación del editor mediante `onEditorChange`, con secuencia creciente, revisión base y rangos UTF-16.
- Si el anfitrión necesita limitar la concurrencia entre documentos, configurar `maxConcurrentDocuments` al crear `HostEngineApi`; el valor predeterminado es 2. La opción admite de 1 a 8 documentos simultáneos. Las operaciones de un mismo documento nunca se ejecutan en paralelo y conservan su orden de secuencia. Los adaptadores que no admitan escrituras concurrentes pueden configurar el valor en `1`.
- No reconstruir ni reenviar el manuscrito completo en cada pulsación: el motor aplica las operaciones sobre su tabla de piezas y registra deltas.
- Consultar `getSnapshot` solo cuando el anfitrión necesite una copia completa; esa operación materializa el texto.
- Antes de cerrar o suspender, esperar `flushPendingChanges()`.
- Si `getDocumentSyncState` indica `needsResync`, detener el envío de deltas y reabrir con el snapshot completo actual del editor.
- Para recuperar una sesión ya guardada después de reiniciar la aplicación, inicializar la identidad del proyecto y llamar `await api.recoverDocument(documentId)`. El método recupera el snapshot local y reproduce los deltas durables; no requiere volver a enviar el texto completo. Solo funciona cuando existe una base durable válida.

## Esquema lógico MLDB 0.4.1 y correspondencia física

El contrato lógico de la base se versiona como JSON declarativo en `../MLDB/`, y se valida con JavaScript puro mediante `scripts/validate-mldb-schema.mjs`. La versión vigente define 25 tablas lógicas, claves compuestas, ámbitos `global`, `project` y `writer`, propiedad de proyectos y referencias que no pueden cruzar libros o escritores.

- `../MLDB/schema_v0.4.1.json`: esquema lógico vigente.
- `../MLDB/schema_v0.4.0.json`, `schema_v0.3.0.json` y `schema_v0.2.0.json`: versiones anteriores verificadas para compatibilidad.
- `../MLDB/storage_mapping_v0.4.1.json`: correspondencia entre las 25 tablas lógicas y el almacenamiento local IndexedDB.
- `../MLDB/PHYSICAL_STORAGE_MAPPING_v0.4.1.md`: explicación de almacenes, claves, índices y estado real de implementación.

El mapa físico distingue capacidades implementadas, parciales y pendientes; una tabla lógica declarada no se presenta como persistida cuando aún no existe su almacén o contrato TypeScript. El modelo actual usa IndexedDB nativo, sin SQL, servicios remotos ni código Rust en el runtime. `npm test` ejecuta ahora también el validador y los casos de compatibilidad del esquema, además de las pruebas del núcleo.

### Diccionarios propios por libro

La API TypeScript guarda y consulta diccionarios privados por proyecto, con idioma real o ficticio, nombre normalizado, procedencia y atributos JSON extensibles. Las entradas conservan forma literal, definición, pronunciación, categoría gramatical, estado y vínculos explícitos con fichas del mismo libro. La normalización usa NFKC, espacios colapsados y minúsculas; no traduce ni modifica la forma literal.

Las actualizaciones se comparan con la versión leída para rechazar escrituras obsoletas de otra instancia. IndexedDB comprueba en una sola transacción la existencia del diccionario padre y de las entidades enlazadas. Los índices únicos impiden nombres duplicados para el mismo idioma y formas normalizadas repetidas dentro de un diccionario. La migración IndexedDB versión 13 agrega los dos almacenes sin borrar los anteriores.

Métodos del anfitrión: `saveProjectDictionary`, `getProjectDictionaries`, `saveDictionaryEntry`, `getDictionaryEntries` y `setDictionaryEntryEntityLink`.

## Límites deliberados

La implementación del producto se desarrolla exclusivamente en TypeScript/JavaScript. Las carpetas Rust del repositorio son material histórico y no forman parte del runtime ni deben ampliarse.

El núcleo TypeScript ya incluye monitoreo incremental, cola no bloqueante con límites de presión, journal durable, checkpoints atómicos, recuperación desde almacenamiento local, diagnósticos por revisión, extracción narrativa explícita, entidades y relaciones, acontecimientos, ideas, cronología explícita, candidatos de contradicción, historial de afirmaciones y biblioteca privada del escritor. La suite automatizada y el benchmark están conectados a GitHub Actions; el estado de cada ejecución debe consultarse en CI y no inferirse por la mera existencia de los tests.

La recuperación local mediante `recoverDocument(documentId)` funciona cuando existe un snapshot durable y un journal continuo. Si nunca se guardó un snapshot base, o el journal está corrupto, el motor no inventa ni elimina datos: exige una copia autoritativa del anfitrión y conserva la información en conflicto.

Siguen siendo límites deliberados la comprensión semántica general, la inferencia automática y fiable de acontecimientos y cronología no explícita, la resolución literaria completa de contradicciones, la clasificación automática de afirmaciones históricas que quedaron obsoletas al cambiar el texto, y las mediciones de latencia en equipos y adaptadores reales de cada plataforma. La CI registrada el 25 de noviembre de 2026 pasó typecheck, build, validación, 293 pruebas (284 aprobadas, 0 fallidas y 9 omitidas) y benchmark. Esto no sustituye la validación de un ciclo real de copia de seguridad y restauración en el programa anfitrión ni las pruebas de IndexedDB en los sistemas objetivo; hasta completar esa validación externa, deben mantenerse copias independientes de los manuscritos importantes.


## Cronología narrativa explícita (primera capa)

Los acontecimientos marcados con `ACONTECIMIENTO:` o `EVENTO:` ahora pueden incluir referencias temporales reconocibles en su propio texto: fechas `AAAA-MM-DD`, fechas `DD/MM/AAAA`, años escritos como `año 1999` y contadores como `día 7` o `jornada 7`. La API `getNarrativeTimeline()` ofrece una vista ordenada por esas referencias explícitas. Fechas/años de calendario y contadores de día del mundo narrativo se mantienen en grupos separados; los eventos sin referencia quedan al final. No se deduce cronología a partir del orden de capítulos, de la posición del texto ni de suposiciones semánticas. Cada acontecimiento conserva la evidencia textual original.


## Contradicciones explícitas (primera capa)

La API `getNarrativeContradictions()` compara afirmaciones dentro de los acontecimientos marcados y detecta candidatos incompatibles sobre el estado vital de personajes previamente identificados (por ejemplo, una afirmación explícita de que está vivo frente a otra de que murió). Cada candidato conserva las dos evidencias originales, sus documentos y rangos. El estado queda `unresolved`: el motor no elige qué versión es correcta ni modifica el manuscrito. Esta función no equivale todavía a una comprensión semántica general ni detecta contradicciones arbitrarias de argumento.


### Precaución cronológica en conflictos de estado

La primera detección de estado vital distingue una transición posible de una incompatibilidad: si hay referencias temporales explícitas comparables y el personaje aparece vivo antes de morir después, no genera por ese solo motivo una contradicción. Si falta una cronología comparable, conserva el caso como candidato sin resolver. Esto sigue siendo una regla limitada al estado vital explícito, no una conclusión semántica general.


## Evolución histórica explícita de personajes

La capa `narrative-history.ts` registra afirmaciones textuales sobre edad, ubicación y cargo/rol de personajes previamente identificados. Cada registro conserva el proyecto, entidad, atributo, valor, documento, revisión, offsets UTF-16, fragmento literal y, cuando aparece en esa misma línea, una referencia temporal explícita. Se conserva cada revisión como evidencia independiente; la API `getNarrativeEntityHistory(entityId)` devuelve el historial de una entidad y `getNarrativeAssertions()` permite consultar las afirmaciones del proyecto.

La persistencia usa el almacén IndexedDB `narrative-assertions`, con índices por proyecto y entidad. La migración a la versión 6 agregó ese almacén sin eliminar datos previos; la versión 7 añade la biblioteca personal de ideas. Las afirmaciones se aíslan por `projectId`. El extractor no inventa atributos ni fechas, y solo funciona para personajes ya reconocidos mediante indicadores explícitos.

Alcance actual: esta es una primera cronología de afirmaciones positivas observadas, no una resolución semántica completa. Si el escritor elimina o cambia una afirmación en una edición posterior, la evidencia anterior se conserva como historial de esa revisión; todavía falta clasificar automáticamente afirmaciones obsoletas frente al estado narrativo vigente y ampliar los atributos reconocidos.


### Defensa adicional del aislamiento por proyecto

La fachada TypeScript valida los registros devueltos por el adaptador antes de incorporarlos a las cachés o utilizarlos durante la extracción; además de proyecto e identificador, comprueba la estructura obligatoria de entidades, relaciones, acontecimientos, ideas y afirmaciones, incluidas sus evidencias y referencias temporales cuando corresponden; también rechaza identificadores vacíos o repetidos dentro de una misma colección, para impedir que dos registros distintos se sobrescriban silenciosamente en los mapas internos. El adaptador IndexedDB aplica la misma defensa en su propia frontera: las lecturas de entidades, relaciones, acontecimientos, ideas y afirmaciones rechazan colecciones mal formadas, identificadores vacíos o duplicados y registros cuyo `projectId` no coincide con el proyecto consultado. Las ideas se validan además en su estructura narrativa completa tanto al guardar como al leer, incluidos estado, texto, documento de origen, evidencias, referencias e historial. Los vínculos deben ser únicos y una idea no puede enlazarse consigo misma. La API comprueba que una nueva relación entre ideas conecte registros del mismo libro; después de archivar, conserva referencias a ideas trasladadas a la biblioteca personal, sin tratarlas como datos huérfanos; también permite retirar posteriormente ese vínculo histórico sin exigir que la idea archivada siga en el proyecto. El adaptador IndexedDB comprueba, mediante búsquedas por clave compuesta y dentro de la misma transacción de escritura, que las entidades relacionadas existan en el mismo proyecto, sin recorrer la colección completa en cada actualización. Las transiciones deben comenzar con `initial`, mantener marcas temporales no decrecientes y terminar en el estado actual de la idea; la API aplica la misma regla a las entradas de biblioteca. El archivo de ideas recorre `narrative-ideas` mediante el cursor del índice `by-project`; valida por adelantado el grafo completo de referencias y la propiedad de los IDs históricos de todas las fichas enlazadas antes de encolar la primera escritura. Después prepara el contexto de una idea a la vez, inserta con `add()` (nunca sobrescribe silenciosamente una entrada ya archivada) y elimina su registro de origen dentro de la misma transacción. Los contextos amplios se recorren con lecturas puntuales por clave; no se conserva un mapa de todas las ideas ni de todas las fichas del libro. El adaptador SQLite del puente usa páginas de 128 registros, cursores exclusivos sobre la clave primaria y tablas temporales indexadas para resolver los conjuntos globales de IDs sin materializar las colecciones completas. Si encuentra un registro ajeno, malformado o un estado desconocido, aborta el conjunto. La transferencia fija el nombre de origen entregado por el anfitrión, incluso si el libro fue renombrado tras capturar la idea. La API serializa el archivo con las demás mutaciones narrativas, hace que las lecturas de la biblioteca esperen a que termine una transferencia en curso e invalida la caché incluso si un adaptador confirma la transferencia pero devuelve una respuesta inválida, para no mostrar ideas que ya no están en el proyecto. Las lecturas también ocupan esa misma cola, de modo que una transferencia iniciada inmediatamente después de una consulta no puede solaparse con una lectura aún pendiente en adaptadores externos. Estas comprobaciones complementan el aislamiento de los índices y las claves de IndexedDB; no dependen únicamente de ellos.

#### Límites actuales del cierre por cursor

El recorrido por cursor de IndexedDB y el recorrido paginado SQLite mantienen la transferencia en una única transacción de escritura para conservar la atomicidad ya existente: ante un error o cierre antes de confirmar, no queda una biblioteca parcialmente publicada ni ideas eliminadas a medias. No son todavía un protocolo de checkpoints entre varias transacciones; el tiempo de bloqueo sigue creciendo con el trabajo total del libro. Además, `archiveUnincorporatedIdeas()` devuelve la lista completa de entradas y el recibo conserva la lista completa de IDs archivados. Por ello se han eliminado las grandes colecciones auxiliares del proceso, pero el tamaño de la respuesta y del recibo sigue siendo proporcional a las ideas transferidas. La salida paginada/streaming y la recuperación de una finalización dividida en lotes durables quedan pendientes; no deben darse por implementadas.


## Coherencia de evidencias durante la escritura

Cada análisis en vivo comunica el rango UTF-16 reemplazado, la longitud insertada y los límites de las líneas afectadas en la revisión anterior. Antes de extraer el fragmento nuevo, la API reubica evidencias posteriores en el mismo documento y marca como `stale` las evidencias de líneas modificadas. Se aplica a entidades, relaciones, acontecimientos, ideas y afirmaciones históricas; las evidencias de otros documentos no cambian. El campo `status` es opcional para mantener compatibilidad con registros previos. Las evidencias históricas no se eliminan ni se presentan como actuales después de editar su línea.


La cronología y el detector de contradicciones utilizan únicamente evidencias vigentes. Cuando un acontecimiento conserva varias referencias de distintas revisiones, una referencia histórica obsoleta no oculta las actuales ni altera el orden de la cronología; los offsets se comparan usando la evidencia vigente.


## Resolución explícita de alias entre capítulos

La API `addNarrativeEntityAlias(entityId, alias)` permite al escritor o anfitrión confirmar que dos nombres identifican a la misma entidad. El alias queda persistido en la ficha canónica y se utiliza al extraer relaciones, participantes de acontecimientos y afirmaciones históricas en otros capítulos. La operación rechaza alias que ya pertenecen a otra entidad del mismo tipo. No se fusionan automáticamente nombres por similitud ortográfica, apodos supuestos ni coincidencias parciales: las coincidencias dudosas requieren confirmación humana. La identidad del registro canónico y su historial se conservan.


## Detección conservadora de posibles identidades duplicadas

La API `getNarrativeEntityIdentityCandidates()` devuelve pares de entidades del mismo tipo que comparten exactamente un nombre canónico normalizado o un nombre/alias ya registrado. Es una lista de revisión, no una fusión: no altera fichas, relaciones, acontecimientos ni afirmaciones. No usa similitud ortográfica, fonética ni coincidencias parciales para proponer identidades. Los resultados permanecen dentro del proyecto activo. La consolidación definitiva requiere una operación explícita y transaccional que actualice todas las referencias y conserve el historial; esto incluye los vínculos de ideas a entidades, que se redirigen a la identidad canónica y eliminan duplicados. La transacción valida también que esos vínculos no apunten a entidades inexistentes y aborta sin escrituras si encuentra referencias huérfanas; no se ejecuta automáticamente. Si el libro ya tiene ideas archivadas en la biblioteca, la consolidación exige el `writerId` estable del anfitrión: sin esa identidad no modifica fichas ni referencias, para no dejar snapshots de biblioteca apuntando a una ficha eliminada. IndexedDB localiza las entradas por proyecto de origen mediante un índice migrado, dentro de la misma transacción; proyectos de otros escritores no se actualizan.


Cuando el extractor encuentra una mención etiquetada que coincide con un alias confirmado de una única entidad del proyecto, agrega la nueva evidencia a la ficha canónica en vez de crear otra ficha. Si el mismo nombre coincide con más de una ficha, no elige: conserva el caso para revisión mediante `getNarrativeEntityIdentityCandidates()`.


## Consolidación explícita y transaccional de identidades

La API `mergeNarrativeEntities(targetEntityId, sourceEntityId)` permite confirmar que dos fichas de la misma clase representan una sola entidad. El adaptador IndexedDB ejecuta la operación en una transacción única que actualiza la ficha canónica, conserva el nombre y las evidencias de origen, redirige relaciones, participantes de acontecimientos y afirmaciones históricas, y elimina la ficha duplicada. Antes de modificar cualquier registro, valida la identidad de proyecto y los identificadores de todas las colecciones leídas; si encuentra una colección mal formada o un registro ajeno, aborta la transacción completa. Cuando varias relaciones quedan duplicadas tras la fusión, conserva como registro principal el que ya pertenecía a la identidad canónica antes de reescribir los extremos, y combina sus evidencias sin perder procedencia. `mergedFromIds` conserva los identificadores absorbidos como procedencia. Si el adaptador no implementa la operación atómica, la API la rechaza sin realizar escrituras parciales.

Cuando el proyecto tiene un `writerId`, la misma operación también lee y actualiza, dentro de esa transacción, las entradas de biblioteca de ese escritor correspondientes al proyecto de origen. Redirige a la identidad canónica los enlaces de entidad de la idea archivada y de sus instantáneas contextuales, incluidos los IDs históricos absorbidos por fusiones anteriores; sustituye las fichas de origen/canónica duplicadas y sus snapshots históricos por la ficha fusionada, combinando sus alias, IDs absorbidos, fechas de primera/última aparición y evidencias sin duplicados. El texto de las ideas, sus evidencias, historial de estados, documento de origen, categoría, título y fecha de archivo permanecen intactos. La consulta usa el índice compuesto `by-writer-source`, de modo que no lee ni modifica bibliotecas de otros escritores. Las entradas antiguas sin instantáneas de contexto también actualizan el ID absorbido cuando es posible, pero siguen identificadas como contexto histórico ausente: no se les inventa una ficha retrospectiva. Esta extensión utiliza el índice ya existente y no requiere migrar ni aumentar la versión de IndexedDB.


La extracción de nombres compuestos conserva partículas internas frecuentes (por ejemplo, «Mar del Plata», «Juan de la Cruz» y «Luz de Luna») en personajes, lugares y objetos. La consolidación también rechaza una fusión que haría que un nombre o alias confirmado coincidiera con una tercera ficha del mismo tipo, para no crear identidades ambiguas.


Los identificadores absorbidos siguen siendo consultables: `resolveNarrativeEntityId(id)` devuelve la identidad canónica vigente y `getNarrativeEntityHistory(id)` acepta tanto el ID canónico como cualquiera de sus IDs de origen, sin perder el acceso al historial tras una consolidación. La API y IndexedDB rechazan que un ID histórico se repita, se reclame desde dos fichas o coincida con el ID propio de una ficha; así se evita que una consulta histórica resuelva a una identidad arbitraria.


### Biblioteca personal de ideas

Al finalizar un libro, el anfitrión debe invocar explícitamente `archiveUnincorporatedIdeas()`. La operación espera a que terminen las ediciones y el análisis narrativo pendientes, y transfiere únicamente las ideas cuyo estado vigente siga siendo `IDEA`. Las ideas incorporadas o descartadas permanecen en el conocimiento del libro.

Cada entrada conserva el texto completo de la idea, su historial de estados, evidencias, documento de origen, ID del proyecto y título del libro. También conserva vínculos explícitos a fichas narrativas y a otras ideas del mismo libro. El campo `context` versión 1 acompaña cada transferencia con instantáneas de las ideas relacionadas que permanecieron en el libro y de todas las fichas de entidad enlazadas por la idea archivada o por esas ideas contextuales. Las referencias entre ideas que se trasladan juntas conservan sus IDs originales y se resuelven mediante sus propias entradas de biblioteca; el contexto recorre además los enlaces de ideas relacionadas para no dejar sus vínculos siguientes sin destino. Así, el cierre o eliminación posterior del proyecto no rompe los enlaces ni elimina el historial de las ideas relacionadas. Las instantáneas se guardan dentro de la misma transacción que transfiere las ideas. Las entradas antiguas sin `context` siguen siendo legibles por compatibilidad, pero no contienen las instantáneas de contexto de esta versión; la API las identifica con `contextStatus: "missing-legacy-context"` para que la aplicación no presente sus enlaces históricos como si fueran resolubles. El anfitrión puede crear o quitar esos vínculos mediante `setNarrativeIdeaEntityLink(ideaId, entityId, linked)` y `setNarrativeIdeaLink(ideaId, relatedIdeaId, linked)`; ambas operaciones validan que los registros pertenezcan al proyecto activo y se serializan con el análisis narrativo. El motor no inventa relaciones por semejanza textual. La categoría inicial de la biblioteca es el título del proyecto proporcionado por el anfitrión. En IndexedDB, la escritura en la biblioteca privada y la eliminación de la idea del proyecto se ejecutan en una única transacción. Antes de transferir o devolver una idea, el adaptador valida su identidad, texto, estado, documento de origen, evidencias, referencias, historial de decisiones y contexto relacionado. La transferencia valida además el conjunto completo de fichas capturadas por todas las ideas pendientes: un ID histórico no puede pertenecer a dos entidades, aunque aparezcan en entradas distintas. Si un registro está malformado, una referencia no puede resolverse o las identidades son ambiguas, aborta el archivo completo antes de escribir la biblioteca o eliminar ideas del libro, o rechaza la lectura. La API anfitriona vuelve a validar cada entrada recibida de cualquier adaptador: escritor y proyecto de origen, categoría, título de procedencia, estado `IDEA`, marcas temporales, evidencias, referencias e historial. La clave y el índice de lectura incluyen `writerId`; `getPersonalIdeaLibrary()` lee solo la biblioteca del escritor autenticado ligado al contexto del proyecto. IndexedDB también rechaza al recuperar una biblioteca dos entradas con el mismo par de proyecto de origen e ID de idea, incluso si difieren en su fecha de archivo. También comprueba que el resultado recuperado sea una colección antes de iterarlo. Verifica además que el título de origen de la idea coincida con el título conservado en su entrada de biblioteca. El anfitrión debe suministrar el identificador estable del escritor autenticado en `initializeProject({ projectId, projectName, writerId })`; el motor no lo inventa, no lo deduce y no permite elegir otro escritor como argumento de consulta. La API también rechaza entradas duplicadas con el mismo par proyecto de origen/ID de idea, evitando que un adaptador externo presente varias versiones ambiguas de una misma idea archivada. Las actualizaciones de una idea existente usan `updateIdeaIfUnchanged(idea, expectedCurrent)`: el almacén comprueba en una transacción que la idea todavía exista y que coincida con la versión leída. Así, una segunda instancia no puede volver a insertar en el libro una idea que la primera ya transfirió a la biblioteca ni sobrescribir silenciosamente una actualización concurrente. Si detecta que la caché quedó obsoleta, la API la invalida y exige una nueva lectura. Los adaptadores que no proporcionan esta operación no anuncian captura ni edición de ideas como capacidad disponible. La identidad de una entrada de biblioteca se delimita por la combinación `writerId`, `sourceProjectId` e ID de idea: el mismo escritor puede tener dos libros con IDs de idea iguales sin colisiones, pero una referencia entre ideas solo se resuelve dentro de su libro de origen. Las fusiones de entidades consultan y actualizan únicamente las entradas del escritor y del libro afectados; si no se proporciona `writerId` y existe biblioteca archivada para ese libro, la operación se rechaza antes de modificar datos.

### Consulta paginada de la biblioteca personal

La API anfitriona ofrece `getPersonalIdeaLibraryPage(cursor?, limit?)`: devuelve 50 entradas por defecto y admite límites de 1 a 200. El cursor estable contiene `sourceProjectId` e `ideaId`; `writerId` siempre se obtiene de la identidad autenticada del proyecto. Cada página valida escritor, proyecto de origen, unicidad, orden y contexto archivado. Los vínculos a ideas fuera de la página se verifican en grupos de hasta 128 referencias; un destino huérfano o perteneciente a otro escritor invalida la respuesta.

IndexedDB usa el índice `by-writer` y salta con la clave primaria compuesta mediante `continuePrimaryKey`. SQLite usa `sort_key`, orden UTF-16 compatible e índice parcial `bridge_records_personal_library_page`. Las bases existentes añaden y reconstruyen esa clave en lotes repetibles de 128 filas. El cliente JSON-RPC expone `MotorLiterarioBridgeClient.getPersonalIdeaLibraryPage(projectId, cursor, limit)`. Los adaptadores antiguos mantienen una ruta de compatibilidad con lectura completa; no anuncian que esa ruta sea paginada.

La biblioteca pertenece al escritor y se comparte entre sus libros, pero nunca entre escritores. IndexedDB publica un aviso local por `writerId` después de confirmar el archivo de ideas o la consolidación de entidades. SQLite mantiene una versión durable por escritor; el puente detecta commits externos y envía `engine.personalIdeaLibraryChanged` a todos los proyectos abiertos con esa misma identidad. El aviso contiene solo `projectId` y `writerId`, nunca el contenido de las ideas. La aplicación anfitriona lo recibe mediante `HostCallbacks.onPersonalIdeaLibraryChanged` o `MotorLiterarioBridgeClient.onNotification("engine.personalIdeaLibraryChanged", ...)` y vuelve a consultar las páginas. Los otros escritores no reciben el aviso.

### Métricas de monitoreo en vivo

El anfitrión puede consultar `getLiveAnalysisMetrics()` sin esperar a que termine la cola. Devuelve cambios admitidos y rechazados, cambios aplicados y fallidos, profundidad actual y máxima de cola, documentos con una edición activa (`activeDocuments`) y máximo de documentos procesados simultáneamente (`maxActiveDocuments`). Se mantienen `activeChanges` y `maxActiveChanges` como alias de compatibilidad; ambos representan documentos activos, no deltas individuales, análisis narrativos pendientes/completados/fallidos y tiempos acumulados/máximos de espera, aplicación y persistencia del conocimiento. `totalAnalysisQueueWaitMs/maxAnalysisQueueWaitMs` separan el tiempo esperando turno en la cola serial narrativa de `totalAnalysisExecutionMs/maxAnalysisExecutionMs`, que miden reconciliación, extracción y persistencia efectivas. `totalKnowledgeMs/maxKnowledgeMs` conservan el tiempo total de punta a punta de esa etapa, incluida la espera. `queueWaitP50Ms/P95Ms` y `applyP50Ms/P95Ms` muestran además percentiles de las últimas 256 operaciones para distinguir congestión de cola de coste de aplicación; sus contadores de ventana indican cuántas muestras contienen. Los tiempos se miden con reloj monotónico; las métricas son acumuladas durante la vida de la instancia y no intervienen en la admisión ni bloquean el editor. `endToEndSamples`, `totalEndToEndMs` y `maxEndToEndMs` miden, para cada edición con análisis narrativo, desde su admisión hasta que terminan el análisis incremental y la persistencia del conocimiento. Esta latencia integral incluye espera de cola, aplicación y trabajo narrativo; no debe confundirse con `totalApplyMs` ni con `totalKnowledgeMs` por separado. `endToEndP50Ms` y `endToEndP95Ms` muestran los percentiles 50 y 95 de una ventana móvil de las últimas 512 ediciones; `endToEndWindowSamples` indica cuántas muestras contiene esa ventana. Los acumuladores siguen cubriendo toda la sesión, mientras que los percentiles usan una ventana acotada para no retener memoria indefinidamente. El benchmark informa estos percentiles integrales por separado de la latencia de confirmación del cambio.

La reconciliación de evidencias y la recuperación de identidad de acontecimientos e ideas usan índices por documento y línea. Los índices se actualizan al incorporar registros y al desplazar evidencias después de una edición, evitando búsquedas lineales sobre todo el conocimiento del libro en cada fragmento.

### Análisis incremental de fragmentos extensos

La revisión ortográfica divide líneas o bloques afectados de más de 16.384 unidades UTF-16 en fragmentos con contexto solapado. Cada diagnóstico se asigna a un único fragmento para evitar duplicados y se conserva el límite total de 1.024 diagnósticos por edición. Entre fragmentos extensos, el análisis cede el hilo principal mediante una tarea programada para que la interfaz pueda atender entrada y repintado; la edición ya confirmada no se revierte ni se bloquea esperando el análisis completo.


Las fusiones de fichas, relaciones, acontecimientos e ideas identifican cada evidencia por documento, revisión, rango, fragmento y estado. Por eso, una evidencia marcada como histórica no se sobrescribe cuando una nueva revisión vuelve a confirmar el mismo texto en la misma posición.


Los extractores de entidades, relaciones y afirmaciones aplican primero filtros literales baratos para descartar fragmentos que no contienen sus indicadores lingüísticos. Así evitan construir mapas de personajes y expresiones regulares por atributo en cada edición ordinaria que no puede producir conocimiento de esas categorías.

### Checkpoints concurrentes
La escritura del snapshot y la compactación del journal se validan dentro de la misma transacción IndexedDB. Un checkpoint atrasado no puede reemplazar un snapshot más reciente; también se rechazan avances desalineados de revisión/secuencia y textos distintos con los mismos contadores. El aborto conserva intactos el snapshot y los deltas.

### Resincronización sin borrar deltas posteriores
Cuando el anfitrión aporta un snapshot más reciente, la compactación elimina únicamente los deltas con secuencia incluida en ese snapshot. Los deltas de secuencia posterior se conservan para una recuperación posterior, evitando borrar cambios concurrentes aún no reflejados en la copia autoritativa.

### Validación del journal en persistencia
El adaptador IndexedDB valida cada edición antes de escribirla: identidad de proyecto/documento, secuencias y revisiones consecutivas, offsets UTF-16 y marca temporal. Las lecturas y compactaciones rechazan parámetros fuera de rango. El checkpoint atómico exige que el límite de borrado coincida exactamente con la secuencia del snapshot, para impedir borrar deltas que el snapshot no contiene.

### Lecturas defensivas y recuperación del almacenamiento
El registro incremental comprueba también que cada delta existente y la nueva edición respeten la longitud UTF-16 resultante del documento. Un rango que exceda el texto durable aborta la transacción antes de insertar el cambio. Los checkpoints con la misma secuencia y el mismo contenido también eliminan los deltas antiguos ya cubiertos, conservando cualquier delta posterior.



Las lecturas IndexedDB solo entregan resultados después de completar correctamente su transacción y rechazan si la solicitud no produjo un resultado. El journal se valida dentro de un bloque protegido: una colección recuperada que no sea una lista, registros malformados, identidades de documento ajenas, huecos de secuencia o revisiones discontinuas producen un error de resincronización en lugar de dejar una promesa pendiente o propagar una excepción fuera del flujo asíncrono. Los guardados y checkpoints también verifican la estructura del snapshot ya almacenado antes de usarlo como base; un snapshot corrupto no puede ser reemplazado silenciosamente por una escritura posterior.

### Escrituras concurrentes del journal
Cada append de IndexedDB valida, dentro de la misma transacción de escritura, el snapshot durable y la cadena completa de deltas posteriores. Comprueba que no existan huecos ni saltos de revisión y que la nueva edición continúe exactamente la última secuencia y revisión confirmadas. Si otra instancia ya avanzó el documento o el journal está discontinuo, la escritura se aborta con un conflicto que obliga a resincronizar; no se permite crear una rama paralela ni prolongar una cadena incompleta.
El método de guardado de snapshots de compatibilidad también lee y valida el estado actual dentro de su transacción `readwrite`: rechaza secuencias o revisiones regresivas, saltos desalineados y textos divergentes para una misma revisión. De este modo, una escritura antigua que llegue tarde no puede sobrescribir un snapshot más reciente ni reemplazar otra rama que haya confirmado la misma secuencia.
El checkpoint atómico no confía únicamente en la secuencia declarada por quien lo solicita: cuando existe un snapshot base, reproduce dentro de la transacción cada delta contiguo hasta el límite pedido y compara revisión, secuencia y texto reconstruido con el snapshot candidato. Si falta un delta, hay offsets inválidos o el texto no coincide, aborta y conserva tanto el snapshot anterior como el journal. Si no existe snapshot base, el checkpoint exige que el journal del documento esté completamente vacío: incluso los deltas posteriores al límite se consideran no verificables y bloquean la operación, porque no es posible demostrar que continúen desde el snapshot entrante. Ningún registro huérfano se elimina ni queda asociado a una base que no puede probarse.
Tanto el guardado simple como el checkpoint atómico validan además la estructura del snapshot (identificadores, texto, revisión, secuencia y marca temporal) antes de abrir la base o iniciar la transacción.

Cuando una edición admitida encuentra ese conflicto, la sesión marca el documento `needsResync`, restablece su secuencia pendiente a la última revisión local confirmada y rechaza también los cambios posteriores que ya estaban en cola porque dependen de la rama obsoleta. La cola se drena sin aplicar esos deltas. Una vez que `flushPendingChanges()` termina, el anfitrión puede reenviar el snapshot autoritativo actual mediante `openDocument`; la sesión vuelve a admitir cambios desde la secuencia recibida. El anfitrión debe conservar y reconciliar los cambios rechazados con el texto autoritativo, no reproducirlos ciegamente sobre una revisión distinta.

### Integridad referencial del conocimiento narrativo
Las relaciones solo se guardan si sus dos entidades existen en el mismo proyecto y sus fichas superan la validación estructural; los acontecimientos requieren que existan todos sus participantes y las afirmaciones deben apuntar a una ficha de entidad válida. La comprobación y la escritura comparten una transacción `readwrite` sobre las colecciones implicadas, de modo que una referencia inexistente o una ficha corrupta no se persiste ni puede quedar validada contra otro proyecto. La comprobación y la escritura comparten una transacción `readwrite` sobre las colecciones implicadas, de modo que una referencia inexistente no se persiste ni puede quedar validada contra otro proyecto.

### Validación de cambios no confiables del editor
La admisión comprueba que secuencia, revisión base y offsets sean enteros seguros antes de hacer cálculos con ellos. Esto evita coerciones de objetos externos y excepciones ante valores de runtime malformados (incluidos `Symbol`), y garantiza que un rechazo no consuma la secuencia pendiente.

### Análisis inicial después de recuperar el journal
Al abrir un documento, el análisis narrativo inicial utiliza el snapshot efectivo de la sesión después de reconstruir los deltas durables. No utiliza el texto anterior enviado por el anfitrión cuando el journal contiene revisiones confirmadas posteriores.


## Integridad al cargar conocimiento narrativo

La API valida también las referencias al recuperar conocimiento persistido, no solo al guardar registros nuevos. Antes de exponer relaciones, acontecimientos o afirmaciones comprueba que todas las entidades referenciadas existan dentro del mismo proyecto. Si una base heredada contiene referencias huérfanas, la lectura falla de forma explícita y no entrega una vista parcial o engañosa; los registros originales se conservan para su diagnóstico o reparación.

### Serialización de consultas y cambios del conocimiento

Las consultas de entidades, relaciones, acontecimientos, ideas, afirmaciones e historial de una entidad se incorporan a la misma cola serial que las mutaciones narrativas. Una lectura que ya comenzó no puede solaparse con una escritura posterior ni completar después de ella una caché antigua. Las operaciones compuestas usan cargadores internos que no vuelven a encolarse, evitando esperas circulares entre consultas relacionadas. La asignación manual de alias también se ejecuta dentro de esa cola; no basta con esperar la cola una sola vez y continuar fuera de ella. Las consultas derivadas (cronología, contradicciones e identidad histórica) consumen resultados de lecturas serializadas.


### Aislamiento defensivo de lecturas narrativas

Las consultas públicas y las operaciones que devuelven entidades, ideas o entradas de biblioteca entregan copias profundas de sus resultados. Esto incluye extracción, asignación de alias, consolidación, cambios de estado y vínculos entre ideas. El anfitrión puede ordenar, editar o conservar esas respuestas sin alterar por accidente las cachés internas ni afectar análisis posteriores. La copia se realiza en el límite de salida de la API; no añade escrituras ni trabajo al ciclo de monitoreo mientras el escritor edita.


### Apertura y resincronización concurrentes

Cada apertura reserva sincrónicamente el identificador del documento antes de iniciar lecturas o escrituras asíncronas. Mientras la reserva está activa, otra apertura/resincronización del mismo documento se rechaza y el editor no puede admitir deltas para una sesión que todavía no está publicada. La reserva se libera tanto al completar la apertura como ante cualquier error; un fallo de persistencia inicial no deja una sesión parcial ni impide reintentar. Documentos distintos conservan su independencia y pueden abrirse en paralelo.


La tabla lógica `timeline_occurrences` está embebida en los acontecimientos: cada evento puede conservar su referencia temporal explícita y el `timelineTrackId` que el escritor le asigne. El vínculo se valida en la misma transacción de IndexedDB contra una pista del mismo proyecto. La API `setNarrativeEventTimelineTrack(eventId, trackId)` asocia una pista; enviar `undefined` retira la asociación. El motor no elige una pista por similitud ni transforma una fecha ausente en fecha inventada.

### Historial de etiquetas y estados

Los historiales de fichas y relaciones se guardan como registros append-only, separados de la ficha vigente. Cada transición conserva el valor anterior y el nuevo, la revisión consecutiva, el motivo y el momento del cambio. El anfitrión deriva el autor del `writerId` de la sesión autenticada; el motor no acepta que una petición se atribuya a otro escritor.

Las escrituras comprueban dentro de una transacción que la ficha o relación exista en el mismo proyecto, que la revisión continúe la cadena anterior y que los valores previos coincidan con la última transición durable. Las lecturas validan la continuidad completa antes de devolver el historial. La base local usa los almacenes `record-lifecycles` y `relation-lifecycles`, con índices únicos por entidad/relación y revisión.

API: `getRecordLifecycleHistory()`, `appendRecordLifecycle()`, `getRelationLifecycleHistory()` y `appendRelationLifecycle()`.

### Perfiles de estilo y pistas cronológicas

Los perfiles de estilo guardan observaciones y preferencias de voz, punto de vista, diálogos y otros rasgos mediante JSON extensible y procedencia. No reescriben el manuscrito ni uniforman automáticamente la voz del escritor.

Las pistas cronológicas permiten definir calendarios, contadores y reglas propias de universos ficticios. Su existencia organiza fechas y acontecimientos explícitos; no autoriza al motor a inventar fechas ni a deducir cronologías sin evidencia. Ambos almacenes se aíslan por proyecto y sus actualizaciones usan comparación optimista.

API: `getStyleProfiles()`, `saveStyleProfile()`, `getTimelineTracks()` y `saveTimelineTrack()`.

### Perfiles lingüísticos y referencias de recursos

Cada libro puede mantener perfiles de idioma con identificador flexible (BCP-47 cuando corresponde, y también códigos propios para lenguas ficticias), nombre visible, variante regional, tipo, preferencias editoriales JSON, estado de cobertura verificada e indicador activo. El estado de cobertura describe las reglas realmente probadas; no representa una promesa de corrección profesional completa.

Las referencias de recursos conservan el ID de la base local, tipo, versión de esquema y estado. Pueden asociarse a un perfil del mismo proyecto o quedar generales para el libro. Registrar una referencia no descarga ni incorpora recursos externos. La persistencia valida el vínculo de perfil y conserva el aislamiento por `projectId`.

API: `getLanguageProfiles()`, `saveLanguageProfile()`, `getLanguageResourceRefs()` y `saveLanguageResourceRef()`.



### Historiales inmutables de fichas y relaciones

Cada cambio de etiqueta o estado se conserva como evento append-only, separado de la ficha o relación actual. El historial comienza en revisión 1; las revisiones posteriores deben ser consecutivas, declarar exactamente la etiqueta y el estado previos y mantener una fecha no regresiva. La ficha o relación debe existir en el mismo libro antes de aceptar el evento. Los eventos históricos no se editan ni se eliminan.

La API ofrece `getRecordLifecycleHistory`, `appendRecordLifecycle`, `getRelationLifecycleHistory` y `appendRelationLifecycle`. El anfitrión entrega la autoría y el motivo cuando estén disponibles; el motor no inventa esos datos. IndexedDB serializa escrituras concurrentes y rechaza revisiones duplicadas o discontinuas.



### Tablas MLDB generales y autorizaciones

La base local también persiste fichas genéricas de tipo abierto, nombres principales y alias separados, relaciones genéricas, evidencias con anclajes documentales, ocurrencias cronológicas, fragmentos de manuscrito con offsets UTF-16, atributos JSON extensibles, sugerencias con revisión de documento, autorizaciones de importación y recibos de migraciones. Todos los registros de proyecto se aíslan mediante `projectId`; las autorizaciones se aíslan por `writerId`.

La API del anfitrión expone `getProjectRecords`/`saveProjectRecord`, `getRecordNames`/`saveRecordName`, `getProjectRelations`/`saveProjectRelation`, `getProjectEvidences`/`saveProjectEvidence`, `getTimelineOccurrences`/`saveTimelineOccurrence`, `getManuscriptFragments`/`saveManuscriptFragment`, `getRecordAttributes`/`saveRecordAttribute`, `getRelationAttributes`/`saveRelationAttribute`, `getActiveSuggestions`/`saveActiveSuggestion`, `getImportAuthorizations`/`authorizeImportBetweenProjects` y `getSchemaMigrations`. Las importaciones no se autorizan por semejanza ni por IDs coincidentes: el anfitrión debe proporcionar ambas identidades verificadas para el mismo escritor autenticado. La migración IndexedDB 21 crea estos almacenes sin eliminar datos anteriores y registra cada upgrade posterior.



### Historial de acontecimientos (IndexedDB 22)

El almacén `event-lifecycles` conserva revisiones append-only de etiqueta y participantes de acontecimientos. Sus índices aíslan proyecto, acontecimiento y revisión. La actualización versionada comprueba el snapshot esperado y escribe la ficha vigente y su transición histórica en una transacción única. Los registros anteriores no reciben baselines ni fechas reconstruidas: la primera revisión documenta el primer cambio explícito realizado después de esta ampliación.

El adaptador SQLite del puente conserva el mismo contrato: `getEventLifecycleHistory(eventId)` recupera y valida la cadena completa, y `updateNarrativeEvent(input)` confirma la ficha vigente y su transición histórica en una única transacción. Se validan revisiones consecutivas, continuidad de etiquetas y participantes, IDs únicos y marcas temporales no regresivas. Los cambios incrementan la versión narrativa del proyecto para que otros procesos puedan detectarlos y notificar a las instancias abiertas.

### Vínculos de diccionario con metadatos propios (IndexedDB 21)

Todos los vínculos se guardan en `dictionary-entry-entities`, con `linkKind`, `provenanceKind` y `createdAt` por cada par entrada/ficha. `setDictionaryEntryEntityLink` actualiza en una misma transacción el registro del vínculo y la proyección de IDs de la entrada; `getDictionaryEntryEntityLinks` permite recuperar y validar los metadatos. La API permite proporcionar el tipo de vínculo, la procedencia y la fecha; la acción manual usa `RELATED` y `WRITER` como valores predeterminados explícitos.

La migración DB21 materializa los vínculos heredados que solo contenían IDs: usa `RELATED` como tipo genérico, `MIGRATION` como procedencia explícita y la fecha real de migración como `createdAt`. No presenta esa fecha como si fuera la fecha histórica original. La tabla queda completamente implementada y las asociaciones anteriores no se pierden.

\n\nLa auditoría física del manifiesto `MLDB/storage_mapping_v0.4.2.json` verifica las 25 tablas propiedad del motor, la tabla `projects` bajo control del anfitrión, la versión/nombre de IndexedDB y los 32 almacenes declarados, incluidos historiales de acontecimientos, diagnósticos y recibos operativos. Se ejecuta junto con la validación del esquema mediante `npm run validate:schema`.\n

## Análisis literario descriptivo

El módulo `src/literary-analysis.ts` incorpora una lectura cuantitativa, local y determinista del fragmento seleccionado:

- Longitud media y mediana de oraciones y párrafos, dispersión de la longitud oracional y distribución de oraciones cortas/medias/largas.
- Candidatos a cambios bruscos de ritmo entre dos oraciones consecutivas, con rangos para inspección.
- Estimación de diálogo a partir de comillas y líneas que comienzan con raya.
- Repeticiones de palabras de contenido y aperturas de oración recurrentes, con ocurrencias acotadas para inspección.
- Ecos léxicos entre escenas explícitas: formas de contenido repetidas en al menos tres ocasiones y dos escenas, con conteos completos y hasta doce offsets UTF-16 por escena; separa menciones de narración y diálogo reconocido, sin interpretarlas como motivos semánticos.
- Señales de primera, segunda y tercera persona basadas en pronombres explícitos fuera de los tramos de diálogo.
- Candidatos a anáfora en comienzos de oraciones consecutivas.
- Vocabulario sensorial explícito clasificado por modalidad visual, auditiva, táctil, olfativa y gustativa.
- Conteos de interrogaciones, exclamaciones y elipsis.
- Encabezados explícitos de parte, capítulo, acto y escena, además de separadores de escena.
- Segmentos de escena únicamente cuando el texto incorpora un encabezado o separador explícito; no se deducen transiciones por contenido.
- Presencia literal de personajes conocidos del proyecto en cada escena, usando nombres y alias no ambiguos con evidencias UTF-16.
- Señales gramaticales de primera, segunda y tercera persona por escena explícita, excluyendo los tramos de diálogo reconocidos y conservando muestras UTF-16.
- Perfil de ritmo para cada escena: media, mediana, dispersión, distribución de longitudes y contrastes entre oraciones consecutivas con offsets UTF-16.
- Indicadores de cadencia por escena: bandas de longitud, transiciones entre bandas y patrones estables, alternantes o progresivos, con muestras de oraciones y ocurrencias UTF-16.
- Comparación de cadencia entre escenas contiguas: deltas de distribución, transiciones de bandas, cantidades por tipo de patrón y tipos que aparecen o dejan de detectarse.
- Detección de firmas de cadencia que reaparecen en distintas escenas, agrupadas por secuencia exacta de bandas y tipo de patrón, con evidencias independientes por escena.
- Perfil de diálogo por escena explícita: proporción de palabras dialogadas, densidad, longitud media y máxima de segmentos, formatos reconocidos y muestras con offsets UTF-16, sin atribuir hablantes. Compara además densidad, proporción, cantidad de segmentos, palabras, longitud media y máxima de intervención, formatos y palabras dialogadas por cada 1.000 palabras narrativas, para comparar escenas de distinta extensión. El flujo por párrafos distingue bloques narrativos, dialogados y mixtos, cuenta sus transiciones y conserva muestras UTF-16. También compara entre escenas contiguas las variaciones en el número y proporción de párrafos con diálogo, las clases y sus secuencias. El resumen agregado informa totales ponderados por párrafo, cobertura de escenas con diálogo y métricas acumuladas sin mezclar transiciones entre límites de escena; también suma los tramos narrativos y con diálogo por escena y conserva las longitudes máximas sin unir bloques entre escenas. La comparación entre escenas contiguas también expone deltas en cantidades de tramos y longitudes máximas, sin conectar tramos a través del límite. Cada perfil también agrupa tramos consecutivos de párrafos narrativos o con diálogo reconocido, con longitudes máximas, conteos por clase y hasta 40 muestras con offsets UTF-16.
- Comparación de variaciones métricas de ritmo entre escenas contiguas, separada de las comparaciones gramaticales y sin inferir por sí sola tensión o cambio de voz.
- Comparación de variaciones entre escenas contiguas: cambio de clasificación, diferencias de conteos por persona y categorías modificadas, sin diagnosticar cambios de narrador.
- Perfil agregado de señales por escena: totales por categoría, distribución de clasificaciones, cobertura y secuencia de instantáneas en orden textual.
- Tasas normalizadas de señales gramaticales por cada 1.000 palabras de narración fuera del diálogo reconocido, tanto por escena como en el agregado, para comparar escenas de distinta longitud.
- Detección de secuencias estables (tres escenas o más) y alternancias (cuatro escenas o más) de clasificaciones gramaticales únicas; las señales mixtas o indeterminadas interrumpen los tramos y cada patrón conserva sus instantáneas.
- Acontecimientos vinculados a escenas solo mediante evidencia del mismo documento y revisión; participantes declarados separados de las menciones literales. Cronología global por ID, motivos de secuencias de dos y tres escenas y transiciones de conteos/menciones con estados de truncamiento. Historial append-only de cambios explícitos de etiqueta y participantes, con escritura transaccional, atribución, motivo, fecha, revisiones consecutivas y comparación entre última instantánea registrada y ficha vigente. El análisis informa adiciones y retiros de participantes sin deducirlos de menciones del manuscrito; las divergencias de historial quedan visibles y no se explican automáticamente.
- Candidatos de dependencia causal entre acontecimientos, basados en dos evidencias de una misma oración y conectores causales literales. Conservan conector, dirección convencional, oración, offsets UTF-16 y participantes explícitos compartidos; requieren revisión y no persisten causalidades automáticamente.
- Señales de continuidad entre escenas explícitas contiguas: personajes mencionados en ambas, solo en la anterior o solo en la siguiente; y acontecimientos con evidencia en ambas o en una sola escena.
- Patrones de co-mención de personajes conocidos en escenas compartidas, ordenados por frecuencia y sin inferir relaciones entre ellos.
- Distribución de menciones literales de personajes conocidos por escena: cobertura, primera y última mención, intervalos sin coincidencia, rachas consecutivas y tasas por cada 1.000 palabras para comparar escenas de distinta longitud. Cuenta todas las coincidencias detectadas y distingue esos conteos de los ejemplos UTF-16 y formas de nombre limitados por escena.
- Perfiles de evidencia de personajes por escena: separan mención nominal literal y participación declarada en acontecimientos con evidencia vigente de la misma revisión. Conservan series por escena, IDs de acontecimientos y estados desconocidos cuando los límites de muestras impiden concluir ausencia.
- Evolución de atributos explícitos entre escenas: compara afirmaciones de edad, ubicación y rol de la revisión vigente, distingue valores sin cambio, cambios observados y múltiples valores en una escena, y conserva fragmentos UTF-16 y contadores de evidencia obsoleta o fuera de alcance. También construye una cronología intercapítulos cuando existen referencias temporales explícitas de la misma base y precisión; no ordena afirmaciones sin fecha comparable.
- Trayectorias narrativas integradas por personaje: consolidan por ID canónico atributos históricos, relaciones dirigidas persistidas, ideas vinculadas con decisiones de estado registradas, participación en acontecimientos y candidatos causales, junto con una instantánea por escena. Separan mención, participación, evidencia activa/obsoleta y decisiones explícitas del escritor; limitan las muestras y declaran los registros omitidos. Incluyen cronología intercapítulos solo con referencias temporales explícitas, agrupadas por pista, base y precisión; no infieren motivaciones, arcos psicológicos ni causalidad definitiva.

La API `analyzeLiteraryDocument(documentId, start?, end?)` espera a que terminen los cambios admitidos y analiza el rango UTF-16 solicitado en la revisión vigente. Es una operación de solo lectura, no persiste sugerencias ni modifica el manuscrito. Los resultados identifican proyecto, documento, revisión y rango; las ocurrencias usan offsets UTF-16 absolutos.

Los perfiles de ritmo son umbrales descriptivos de longitud de oración, no juicios de calidad. Las señales gramaticales no identifican por sí solas al narrador: los pronombres tácitos, el estilo indirecto y los formatos de diálogo no reconocidos pueden cambiar el resultado. El motor expone estas limitaciones en cada respuesta. La anáfora requiere coincidencia literal de las dos primeras palabras en oraciones consecutivas. Los cambios de escena solo se reconocen mediante encabezados y separadores explícitos; los saltos de párrafo no se convierten automáticamente en escenas. La presencia de personajes se vincula solo mediante nombres y alias del catálogo del proyecto, omitiendo los alias ambiguos. Los acontecimientos requieren evidencia vigente de la misma revisión y solapamiento con la escena; la falta de mención de un participante no se considera contradicción. La continuidad compara únicamente escenas explícitas contiguas y conserva las ocurrencias literales: una mención que no se repite no implica que el personaje esté ausente, y la cobertura de evidencia de un acontecimiento no establece cronología ni contradicción. La co-mención agrupa apariciones literales de dos personajes conocidos en una escena explícita; no implica interacción, vínculo, diálogo ni presencia física conjunta. Se devuelven hasta 100 pares, priorizando los que aparecen en más escenas. El vocabulario sensorial es un léxico explícito: no interpreta metáforas, sinestesias ni imágenes implícitas.

El análisis acepta hasta 2.000.000 de unidades UTF-16 por operación. Los documentos mayores deben analizarse por rangos y conservar su revisión al comparar resultados.

