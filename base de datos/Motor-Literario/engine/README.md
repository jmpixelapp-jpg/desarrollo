# Motor Literario — núcleo inicial

Este crate implementa el núcleo de sincronización incremental, el coordinador de sesiones en vivo y un adaptador durable de eventos del editor sobre MLDB.

## Requisitos

- Rust estable con soporte para edición 2021.
- Sin dependencias de terceros; `mldb-storage` es un crate local del mismo workspace.

## Pruebas

Desde la carpeta `Motor-Literario/` para ejecutar ambos crates y todas sus pruebas:

```sh
cargo test --workspace --all-targets --locked
```

Para ejecutar únicamente el núcleo:

```sh
cargo test -p motor-literario-core
```

## Alcance de esta primera versión

- Recibe la identidad del proyecto y documento desde el anfitrión.
- `LiveEngine` admite un único proyecto activo, identificado por el anfitrión, y varias sesiones de documento dentro de ese proyecto.
- Abre/cierra proyectos y documentos, rechaza IDs duplicados y evita accesos desde otro proyecto.
- `LiveSession` mantiene la revisión, secuencia y snapshot incremental de cada documento.
- Ante huecos o conflictos de secuencia, `resynchronize_document` reemplaza la sesión solo con el snapshot autoritativo reenviado por el anfitrión; no reconstruye cambios perdidos ni conserva sugerencias de la revisión anterior.
- Aplica únicamente cambios incrementales explícitos enviados por el editor.
- Detecta secuencias duplicadas, conflictos y huecos; los huecos/conflictos requieren resincronización.
- Rechaza offsets que rompen límites UTF-8.
- La segmentación de oraciones evita cortes falsos tras abreviaturas frecuentes en español, portugués e inglés (por ejemplo, Dra., Sr., Sra., Mr., p. ej. y EE.UU.); es una heurística conservadora, no un modelo lingüístico completo.
- Invalida sugerencias ancladas a revisiones anteriores.
- Incluye pruebas unitarias de estos invariantes y de la coordinación/aislamiento de sesiones.


## Integración durable con MLDB

`PersistentLiveEngine` vincula una instancia al `project_id` suministrado por el anfitrión y persiste cada cambio incremental en el `ProjectStore` mediante una única transacción MLPJ que incluye el evento y el high-water mark del documento.

- No escribe el manuscrito completo por cada pulsación: conserva deltas de reemplazo, revisión base, offsets UTF-8 y secuencia.
- Los reemplazos grandes se dividen en registros de hasta 3.000 bytes, confirmados en la misma transacción, con un máximo de 4.096 bloques por evento.
- Al reabrir, el anfitrión puede enviar un snapshot anterior; el motor reproduce los eventos durables posteriores y verifica revisión/secuencia contra el high-water mark.
- Si el anfitrión ya tiene un snapshot más reciente, ese snapshot se convierte en la nueva base autoritativa.
- `checkpoint_document` solo permite podar eventos cuando el anfitrión confirma explícitamente que guardó la misma revisión/secuencia. La limpieza ocurre en lotes acotados.
- Si una escritura MLPJ devuelve un error potencialmente ambiguo, la instancia queda en cuarentena y exige cerrar/reabrir para ejecutar recovery antes de continuar.
- Los eventos y las cabeceras están siempre bajo el `project_id` del anfitrión. Cada documento usa un epoch de eventos propio; una resincronización inicia un epoch nuevo para que no se mezclen secuencias reutilizadas.
- La sesión valida el delta sin clonar el texto completo; el cambio se aplica en memoria después del COMMIT durable.

El adaptador no sustituye al anfitrión como propietario del archivo/documento: el snapshot inicial y los checkpoints deben proceder de un estado que el anfitrión considere autoritativo. No se debe marcar un checkpoint antes de que el anfitrión haya guardado ese snapshot. Las sugerencias siguen siendo estado de sesión y todavía no se persisten en este adaptador.

Pruebas escritas para replay después de reinicio, replay desde snapshot intermedio, evitar doble aplicación cuando el anfitrión ya tiene el snapshot actual, checkpoint explícito, aislamiento de proyecto, cambio de epoch y división UTF-8 de reemplazos grandes. El resultado de compilación/ejecución debe confirmarse en CI nativo antes de usar manuscritos reales.


### Ingestión asíncrona

`LiveEngineWorker` ejecuta las escrituras MLDB en un hilo dedicado y ofrece `try_submit_change` para que el hilo del editor no espere al `sync_all`. La cola es acotada y FIFO; `PendingChange` se conserva intacto cuando `try_send` devuelve `QueueFull`, de modo que el anfitrión debe reintentarlo antes de encolar secuencias posteriores, sin perder ni reordenar deltas. Cada envío aceptado devuelve un `ChangeTicket` consultable sin bloqueo (`try_result`) o con espera explícita fuera del hilo de escritura (`wait`/`wait_timeout`). `pending_changes` aproxima los cambios en cola o en confirmación. Durante una llamada concurrente a `try_submit_change`, el contador se reserva antes de intentar el envío para evitar que el worker reste antes de que el productor registre el pendiente; por ello, una lectura tomada justo en esa ventana también puede incluir intentos todavía no admitidos. `max_pending_changes` puede capturar esa misma ventana. `queue_capacity` informa la capacidad configurada de cada canal acotado y `pending_load_percent` expresa `pending_changes / queue_capacity` en porcentaje entero. Como los pendientes incluyen también el cambio que está confirmándose y, transitoriamente, reservas de admisión concurrentes, el porcentaje puede superar 100%; es una señal de presión aproximada, no una lectura exacta de ocupación física del canal. Ambos campos se exponen en JSON-RPC `status`. `metrics()` ofrece commits durables, errores y percentiles p50/p95/p99 de las últimas 256 escrituras exitosas. También separa espera de cola, tiempo de ejecución durable y latencia end-to-end desde el inicio de `try_submit_change` hasta el COMMIT durable, con p50/p95/p99/máximo sobre una ventana acotada a 256 deltas `Applied`; los duplicados y errores no se cuentan como commits. El método JSON-RPC `status` expone esas métricas para que el anfitrión pueda observar la latencia sin bloquear el hilo del editor. `snapshot`, resincronización autoritativa, checkpoint y cierre son barreras FIFO.

La cola no convierte por sí sola una edición en durable al instante: la durabilidad llega cuando el ticket informa el COMMIT. El anfitrión debe conservar sus deltas pendientes y no descartar los que reciban `QueueFull`; también debe vigilar el backlog. Si el proceso termina antes del COMMIT, la recuperación depende del snapshot autoritativo del anfitrión más los eventos que sí llegaron a confirmarse. No se afirma todavía una latencia máxima ni una garantía de cero pérdida si el anfitrión ignora los tickets o descarta deltas rechazados.

**Benchmark de transacciones durables:** `cargo bench -p motor-literario-core --bench durable_change_batches` compara lotes de 1, 2, 4, 8 y 16 deltas. Cada delta sintético genera una escritura de evento y una actualización repetida de la cabecera del documento; cada lote se confirma inmediatamente en una única transacción MLPJ. Informa tiempo total y nanosegundos amortizados por delta. No introduce esperas artificiales ni mide el worker completo, la serialización JSON-RPC o el rendimiento de discos de producción. Sirve para cuantificar el coste de agrupar operaciones ya disponibles en `ProjectStore::apply_batch`; sus resultados deben obtenerse en cada plataforma objetivo antes de decidir una política de micro-lotes.

**Límite de rendimiento actual:** `apply_change` confirma cada delta con una transacción MLPJ síncrona. Ya no copia el manuscrito entero por pulsación, pero el `sync_all` durable puede añadir latencia al hilo que llama. La cola asíncrona ya está implementada; siguen pendientes las mediciones de referencia p50/p95/p99 en equipos/destinos reales, los umbrales de aceptación y la política de agrupación con garantías de pérdida cero. El worker reduce el bloqueo del hilo editor, pero todavía no se ha medido su rendimiento en equipos reales.

Contrato de registros, recuperación y backpressure: [LIVE_CHANGE_JOURNAL_V0.1.md](../docs/specifications/LIVE_CHANGE_JOURNAL_V0.1.md).


### Integración con el anfitrión

La fachada tipada para integrar el editor está en `host_api.rs` y se expone como `HostEngineApi`. El anfitrión crea el proyecto y aporta su ID; abre cada documento con su snapshot/revisión/secuencia; y llama a `on_editor_change(EditorChange)` por cada delta. Esa ruta usa `try_send` y no espera al disco. Para abrir workspaces MLDB ya creados desde `PublicationStore`, existen `HostEngineApi::open_existing` y `open_existing_with_knowledge`; ambas variantes usan `ProjectStore::open_existing` y fallan si falta cualquier archivo, sin inicializarlo silenciosamente. Las rutas deben corresponder a copias de trabajo mutables, nunca a una generación publicada. Un resultado aceptado devuelve un ticket que confirma el commit durable; un delta rechazado por cola llena debe conservarse y reintentarse antes de secuencias posteriores. `snapshot` es una barrera FIFO. `acknowledge_host_save` solo se llama después de que el anfitrión haya guardado exactamente esa revisión y secuencia. La API no accede al widget/editor ni modifica el manuscrito.

Ejemplo mínimo de secuencia de integración:

1. `HostEngineApi::open(host_project_id, pages_path, journal_path, queue_capacity)`.
2. `open_document(host_document_id, host_snapshot, revision, sequence)`.
3. En cada evento, `on_editor_change(EditorChange { ... })`; conservar el ticket y confirmar su resultado fuera del hilo UI.
4. Ante hueco/conflicto, obtener el snapshot actual del anfitrión y llamar a `resynchronize`.
5. Después del guardado confirmado del anfitrión, llamar a `acknowledge_host_save` con revisión y secuencia exactas.
6. Al cerrar, `shutdown` drena la cola aceptada.

`open_existing_with_knowledge` abre primero el almacén narrativo y luego el motor vivo para no dejar un worker iniciado si la segunda apertura falla. Para el ciclo coordinado, `mldb_storage::bundle::BundlePublicationStore` crea/reabre una `WorkingBundle`; `HostEngineApi::open_working_bundle(host_project_id, working_bundle, queue_capacity)` verifica el `project_id`, abre los dos miembros existentes y conserva el lock de sesión mientras trabaja. El almacén narrativo y `PersistentLiveEngine` reciben el mismo `SessionLockValidator` dentro de sus `ProjectStore`: la validación se ejecuta antes de recovery y dentro de cada mutación durable, incluso si se invoca el motor persistente sin pasar por el worker. Una prueba Unix sustituye el lock con el motor abierto y comprueba que el almacenamiento vivo rechaza el siguiente delta sin alterar el snapshot. Al cerrar, `into_working_bundle()` drena y apaga el worker, cierra el almacén narrativo y devuelve la sesión. El anfitrión pasa esa sesión a `BundlePublicationStore::publish_working_bundle`, que checkpointa y valida ambos almacenes y activa ambos con un único selector. Nunca se debe publicar cada almacén por separado. Esta ruta tipada ya está integrada; el protocolo JSON-RPC aún no ofrece operaciones para crear/reanudar/publicar bundles.


### Protocolo JSON-RPC 2.0

El módulo `protocol.rs` expone `JsonRpcServer::handle_line`: recibe una solicitud JSON-RPC 2.0 y devuelve una respuesta JSON. El módulo `json.rs` incluye parser/serializador propio, sin dependencias externas, con límites de 16 MiB por mensaje, profundidad 64, cadenas de hasta 12 MiB, rechazo de claves duplicadas, validación de números y soporte de pares sustitutos Unicode. El binario motor-literario-core ya conecta el protocolo a stdin/stdout mediante una solicitud JSON por línea; stdout queda reservado a respuestas JSON-RPC y el proceso termina tras shutdown o EOF. No abre puertos ni inicia servicios de red.

Métodos implementados: `get_capabilities`, `initialize`, `open_document`, `editor_change`, `poll_commit`, `snapshot`, `resynchronize`, `acknowledge_host_save`, `close_document`, `put_entity`/`get_entity`, `put_relation`/`get_relation`, `put_event`/`get_event`, `put_evidence`/`get_evidence`/`delete_evidence`, `list_entity_ids`, `list_relation_ids`, `list_event_ids`, `list_evidence_ids`, `list_entity_ids_page`, `list_relation_ids_page`, `list_event_ids_page`, `list_evidence_ids_page` y `list_fragment_analysis_ids_page` (paginación con `offset` y `limit` de 1 a 1000), además de sus variantes `list_*_after` con cursor exclusivo `after_id`, `put_fragment_analysis`/`get_fragment_analysis`, `list_fragment_analysis_ids`, `delete_fragment_analysis`, `analyze_fragment`, `tokenize_fragment`, `analyze_affected_paragraph`, `status` y `shutdown`. `initialize` acepta opcionalmente `knowledge_pages_path` y `knowledge_journal_path` juntos para habilitar la API de conocimiento. `editor_change` responde al encolar y devuelve un ticket; `poll_commit` informa cuándo se confirmó durablemente. Ante cola llena, el error incluye el delta original para reintento. No se debe enviar una secuencia posterior hasta reintentar el delta rechazado. `status` incluye p50/p95/p99 de las últimas 256 ejecuciones exitosas de `analyze_affected_paragraph`, contando barrera FIFO, extracción, métricas y persistencia local; también expone por separado espera de cola de escritura, ejecución del commit durable y latencia end-to-end de admisión a commit.

Contrato detallado de métodos, parámetros, errores y ciclo de sincronización: [HOST_JSONRPC_PROTOCOL_V0.1.md](../docs/specifications/HOST_JSONRPC_PROTOCOL_V0.1.md).

### Segmentación incremental del texto

El módulo `segmentation.rs` ofrece segmentación determinista de párrafos (separados por líneas en blanco) y oraciones, además de `affected_paragraph_range` para ampliar un delta al párrafo que requiere reanálisis. Todos los rangos son bytes UTF-8 y se validan contra límites de caracteres. La segmentación conserva el texto fuente y no realiza corrección ni inferencia semántica. Es una primitiva para el analizador incremental; todavía no está conectada al ciclo de cambios ni persiste fragmentos.

### Métricas lingüísticas locales

El módulo `linguistic.rs` tokeniza palabras con soporte básico para letras Unicode, marcas diacríticas, apóstrofos, palabras compuestas y decimales. `analyze_fragment` calcula palabras, vocabulario único, oraciones, párrafos, palabras largas, longitud media y repeticiones dentro del fragmento recibido. `analyze_affected_paragraph` toma una barrera FIFO del documento vivo y copia solo el párrafo que contiene un rango UTF-8 ya confirmado (no clona el manuscrito completo); devuelve el fragmento junto con sus métricas y revisión/secuencia exactas. Es una medición descriptiva, no una evaluación de calidad literaria ni un corrector. No realiza normalización Unicode canónica ni comprende contexto; debe ejecutarse sobre el párrafo afectado, no sobre todo el libro en cada pulsación.

### Revisión textual propia

Los métodos JSON-RPC `proofread_fragment` y `proofread_affected_paragraph` ejecutan reglas deterministas implementadas en el propio motor, sin dependencias ni servicios externos. El segundo extrae el párrafo afectado desde la revisión viva exacta tras una barrera FIFO y debe invocarse desde el hilo de análisis del anfitrión, nunca desde el callback de escritura. Además, el flujo asíncrono existente `request_analyze_affected_paragraph` / `poll_analyze_affected_paragraph` y el método síncrono `analyze_affected_paragraph` ya incluyen estos diagnósticos en sus respuestas; la comprobación se ejecuta en el grupo analítico, no en el hilo de escritura, y puede cancelarse cooperativamente cuando una edición vuelve obsoleto el análisis. La primera versión detecta repeticiones inmediatas de palabras separadas solo por espacios, espacios antes de signos de puntuación, ausencia de espacio después de coma/punto y coma/dos puntos, dobles espacios internos y comienzos de oración en minúscula. Devuelve código, severidad, mensaje, propuesta opcional y offsets absolutos UTF-8; nunca modifica el manuscrito. El análisis está limitado a 512 KiB y 4.096 diagnósticos por fragmento. Son reglas formales conservadoras, no una corrección ortográfica/gramatical completa ni una evaluación de estilo; los casos ambiguos se dejan al escritor.

### Registros de conocimiento narrativo por proyecto

El módulo `knowledge.rs` incorpora una primera capa de persistencia estructurada, independiente del diario de edición. Usa tablas versionadas bajo `project_id` explícito y ofrece registros de entidades, relaciones, acontecimientos y evidencias. Las entidades conservan atributos clave/valor y estado; relaciones enlazan IDs; acontecimientos admiten orden cronológico opcional; evidencias conservan documento, revisión, rango UTF-8, fragmento citado y tipo de procedencia.

Los estados son `Proposed`, `Confirmed`, `Rejected` y `Superseded`. No se promueve automáticamente una hipótesis a hecho confirmado. La capa no extrae conocimiento del texto todavía: los registros deben ser aportados por una futura etapa de análisis o por el anfitrión. El almacenamiento narrativo se abre mediante rutas locales dedicadas y no comparte registros entre project_id. La prueba `project_scope_prevents_cross_book_record_reads` cubre ahora las cinco tablas (entidades, relaciones, acontecimientos, evidencias y análisis de fragmento): crea los mismos IDs y el mismo ID de documento en dos proyectos, verifica que listados, índices y auditoría no revelen registros del otro proyecto, permite valores distintos bajo IDs coincidentes y comprueba que ambos contenidos sobreviven a reaperturas. La API tipada y los métodos JSON-RPC permiten al anfitrión consultar y actualizar esos registros. `analyze_affected_paragraph` exige un `analysis_id` estable del párrafo, aportado por el anfitrión, y guarda en la tabla `narrative.fragment_analysis.v1` las métricas de la revisión actual y la procedencia UTF-8; un nuevo análisis con el mismo ID actualiza el registro en lugar de crear historial. el texto UTF-8 exacto del párrafo se conserva como procedencia privada en esa tabla, con un límite de 512 KiB por registro y validación de que su longitud coincida con el rango persistido.


Especificación de las tablas, estados, procedencia y límites actuales: [NARRATIVE_KNOWLEDGE_SCHEMA_V0.1.md](../docs/specifications/NARRATIVE_KNOWLEDGE_SCHEMA_V0.1.md).

## Límites deliberados

Esto todavía no es un motor completo. MLDB es un almacenamiento experimental separado; el adaptador persistente guarda el diario incremental y las cabeceras, pero no sustituye al sistema de documentos del anfitrión. El estado de sesión y las sugerencias viven en memoria; aún falta persistir los resultados de análisis y el historial narrativo consolidado. No debe usarse con manuscritos reales ni conectarse a un editor de producción. No incluye todavía análisis lingüístico semántico, extracción automática de conocimiento, historial de versiones/auditoría, biblioteca de ideas ni interfaz de usuario.

Se eligió Rust solo para esta primera prueba ejecutable del núcleo, no como cierre irreversible de la decisión multiplataforma. Antes de ampliar la implementación se validará su compilación para los destinos definidos por el proyecto.


### Análisis lingüístico local

El tokenizador conserva los offsets UTF-8 del texto original y normaliza únicamente la clave usada para comparar palabras: convierte apóstrofos tipográficos en apóstrofo recto, elimina guiones internos y aplica minúsculas. Así, variantes como `L’amour`/`l'amour` y `arco-iris`/`arco‐iris` se agrupan en frecuencias, sin modificar ni reconstruir el texto fuente. Esta normalización no realiza todavía normalización Unicode NFC/NFKC, lematización ni análisis morfológico; no debe interpretarse como equivalencia lingüística completa.


### Benchmark JSON-RPC de escritura en vivo

El benchmark `cargo bench -p motor-literario-core --bench rope_edits` incluye un recorrido integral por el protocolo JSON-RPC: abre el documento, envía un delta, espera su confirmación durable, solicita el análisis del párrafo afectado y espera su persistencia. Informa p50/p95/p99 de extremo a extremo y separa extracción, análisis lingüístico y persistencia. Comprueba que cada delta se confirmó, que cada análisis quedó persistido, que no hubo aciertos de caché en los marcadores únicos y que las colas/tickets terminaron vacíos.

La fase JSON-RPC usa documentos de 100 KiB, 1 MiB y 10 MiB. No incluye 50 MiB porque el protocolo actual limita cada cadena JSON a 12 MiB y cada mensaje a 16 MiB; el snapshot inicial se transmite como una sola cadena en `open_document`. La cantidad de iteraciones se configura con `ROPE_JSONRPC_BENCH_ITERATIONS` (1 a 10.000; predeterminado 5). Este límite corresponde al transporte actual y no reduce los tamaños mayores usados por los benchmarks internos de Rope y del worker.

Estas pruebas están implementadas, pero sus resultados deben obtenerse ejecutándolas en un entorno Rust/CI operativo; no se deben interpretar como mediciones ya realizadas.


### Paginación de registros narrativos

Los listados globales de IDs ahora disponen de métodos JSON-RPC paginados: `list_entity_ids_page`, `list_relation_ids_page`, `list_event_ids_page`, `list_evidence_ids_page` y `list_fragment_analysis_ids_page`. Aceptan `offset` (predeterminado 0) y `limit` (predeterminado 100, máximo 1000). Las páginas mantienen el orden estable del almacén y solo materializan los IDs devueltos; la lectura recorre incrementalmente el iterador persistente. Las interfaces anteriores sin paginación se conservan por compatibilidad y siguen limitadas a 50.000 resultados. Para proyectos grandes, el anfitrión debe utilizar las variantes `*_page` y avanzar el offset por el número de IDs recibidos.

Los listados de destinos narrativos por documento también ofrecen variantes `list_entity_ids_for_document_page`, `list_relation_ids_for_document_page` y `list_event_ids_for_document_page`, con `offset` y `limit` de 1 a 1000.


Los listados de destinos por documento también admiten paginación: `list_entity_ids_for_document_page`, `list_relation_ids_for_document_page` y `list_event_ids_for_document_page`. Reciben `document_id`, `offset` y `limit`; el offset se aplica a los IDs de destino distintos y ordenados, no a las evidencias. El motor consulta el índice del documento y lee las evidencias individualmente, sin clonar la colección completa de IDs de evidencia.


Los listados heredados sin paginación de evidencias y destinos por documento también se limitan a 50.000 IDs; para colecciones mayores devuelven un error explícito y deben sustituirse por sus variantes `*_page`. Los procesos de rebase histórico, rebase por edición e invalidación recorren directamente el índice ordenado de evidencias del documento, sin clonar su colección de IDs, y confirman escrituras en lotes de ocho registros. Así, una recuperación o resincronización grande no conserva todos los IDs ni todas las operaciones de escritura simultáneamente en memoria.


Para recorrer colecciones grandes sin que cada página vuelva a atravesar todos los registros anteriores, el anfitrión debe preferir `list_entity_ids_after`, `list_relation_ids_after`, `list_event_ids_after`, `list_evidence_ids_after` y `list_fragment_analysis_ids_after`, `list_evidence_ids_for_document_after`, `list_entity_ids_for_document_after`, `list_relation_ids_for_document_after` y `list_event_ids_for_document_after`. Envían `limit` (1..1000) y, desde la segunda página, `after_id` con el último ID recibido. El cursor es exclusivo y el B+Tree busca directamente su posición; no depende de un offset creciente. Si se insertan IDs posteriores al cursor entre llamadas, pueden aparecer en páginas siguientes; IDs insertados antes del cursor no se incluyen en ese recorrido. Para una instantánea estable durante escrituras concurrentes se requiere una futura API de snapshot/cursor con revisión.


Las evidencias de un documento también admiten `list_evidence_ids_for_document_after`, que recibe `document_id`, `limit` y el `after_id` exclusivo opcional. Su índice BTreeSet permite saltar directamente al cursor en lugar de recorrer el offset anterior.


Los destinos narrativos distintos de un documento también admiten `list_entity_ids_for_document_after`, `list_relation_ids_for_document_after` y `list_event_ids_for_document_after`. El cursor se aplica al ID del destino, no al ID de evidencia; cada página conserva el orden y elimina duplicados. Un índice derivado en memoria por documento y tipo de destino se reconstruye en el primer acceso y se mantiene al insertar o reemplazar evidencias; las páginas siguientes hacen búsqueda ordenada directa sin volver a recorrer todas las citas.

### Integridad referencial y eliminaciones seguras

La API JSON-RPC ofrece `delete_entity`, `delete_relation`, `delete_event` y `delete_evidence`. Las entidades no se eliminan mientras alguna relación las utilice como sujeto u objeto, ni mientras existan evidencias dirigidas a ellas. Las relaciones y los acontecimientos tampoco se eliminan si conservan evidencias asociadas. El anfitrión debe eliminar primero las evidencias dependientes y después las relaciones antes de sus entidades. Las operaciones son idempotentes cuando el registro ya no existe; si hay dependencias, devuelven un error explícito y no modifican los datos. Las comprobaciones de dependencias se realizan en operaciones de eliminación, no en la ruta caliente de escritura del editor.

### Auditoría de integridad narrativa

El anfitrión puede ejecutar `audit_knowledge_integrity` para revisar las tablas `entity`, `relation`, `event`, `evidence` y `fragment_analysis`. La auditoría es explícita, de solo lectura y aislada por el `project_id` activo. Informa registros malformados, referencias huérfanas y análisis de fragmentos con identidad de documento, métricas o palabras repetidas incoherentes. No repara, elimina ni modifica registros.

La operación pagina por registros examinados, no por incidencias: recibe `table`, `limit` (1..1000, 100 por defecto) y `after_id` opcional. Devuelve `issues`, `scanned`, `next_after` y `has_more`. El cursor identifica el último registro examinado, incluso si esa página no encontró incidencias; debe enviarse como `after_id` en la siguiente llamada. Cada página materializa como máximo el límite solicitado más un registro para detectar continuación. La auditoría no se ejecuta en el flujo de cambios del editor.

Para verificar además el anclaje real de las citas contra el texto vivo, el anfitrión dispone de `audit_document_evidence`. Recibe `document_id`, `limit` y `after_id`; revisa solo las evidencias de ese documento mediante la validación de rango del worker, sin reconstruir ni copiar el manuscrito completo. Informa citas marcadas como obsoletas, revisiones que ya no coinciden, extractos distintos y rangos inválidos. La operación requiere que el documento esté abierto en el motor.

Para los análisis lingüísticos persistidos existe `audit_document_fragment_analyses`. Recibe `document_id`, `limit` y `after_id`; pagina el índice derivado de análisis del documento con cursor exclusivo y contrasta los registros del documento solicitado con su revisión viva y los límites UTF-8. Informa revisiones desactualizadas, rangos fuera del documento y offsets que cortan caracteres. El cursor avanza únicamente por los análisis del documento solicitado. El índice se reconstruye de forma incremental en el primer uso y se mantiene al insertar o eliminar análisis. Informa también registros malformados cuando su ID puede asociarse al documento. La operación requiere que el documento esté abierto. No recalcula métricas ni modifica análisis.
