# Contrato JSON-RPC del anfitrión — v0.1.0

**Estado:** implementado en el crate Rust; pendiente de compilación y ejecución verificadas.  
**Transporte:** proceso local stdio_json_lines por stdin/stdout, una solicitud JSON por línea y una respuesta JSON por línea.  
**Identidad:** el anfitrión proporciona siempre project_id y document_id.  
**Privacidad:** las rutas MLPG/MLPJ son locales. El proceso no abre sockets, no envía manuscritos a servicios externos y no modifica el documento del anfitrión.

## 1. Sobre el cable

Cada solicitud es un objeto JSON-RPC 2.0:

    {"jsonrpc":"2.0","id":"req-1","method":"get_capabilities","params":{}}

La respuesta conserva el ID:

    {"jsonrpc":"2.0","id":"req-1","result":{"...":"..."}}

Se aceptan IDs string o number. Los métodos implementados son solicitudes (no notificaciones). Las claves duplicadas, números JSON mal formados, escapes Unicode inválidos y contenido sobrante se rechazan.

Límites actuales: 16 MiB por solicitud y respuesta, 64 niveles de anidamiento, 12 MiB por cadena y 4.096 tickets de commit pendientes de consulta. Los offsets del editor son bytes UTF-8, no índices de caracteres UTF-16 ni posiciones visuales. El anfitrión debe convertirlos explícitamente.

El binario no imprime logs en stdout: ese canal queda reservado para JSON-RPC. Los errores de I/O del proceso terminan el proceso con error; EOF cierra el servidor y drena el worker por Drop.

## 2. Métodos

### get_capabilities

No requiere inicialización. Devuelve versión de protocolo, funciones presentes y límites. `native_rule_based_proofreading: true` anuncia las reglas locales deterministas; `semantic_analysis: false` sigue indicando que aún no existe comprensión narrativa automática. `end_to_end_write_latency_metrics: true` anuncia que `status` expone percentiles de latencia desde la admisión del delta hasta el COMMIT durable. `discard_cancelled_queued_analysis: true` anuncia que las tareas analíticas invalidadas se retiran de la cola sin esperar a que un worker las recoja. semantic_analysis es false: este hito implementa sincronización, persistencia de registros narrativos y transporte, no comprensión literaria ni extracción automática.

### initialize

Parámetros obligatorios:

- project_id: ID externo del libro/proyecto.
- pages_path: ruta local del archivo de páginas MLPG.
- journal_path: ruta local del WAL MLPJ.
- queue_capacity: capacidad positiva de la cola asíncrona.
- knowledge_pages_path y knowledge_journal_path: rutas locales opcionales que deben proporcionarse juntas para habilitar las tablas narrativas.

Abre el almacén del proyecto y un worker dedicado. No crea el ID ni el nombre del proyecto. Una segunda inicialización en el mismo proceso se rechaza. Si se omiten las dos rutas de conocimiento, el motor de edición funciona pero los métodos narrativos devuelven error de configuración.

### open_document

Parámetros: document_id, text, revision y sequence.

El texto, revisión y secuencia son el snapshot autoritativo actual del anfitrión. Si el diario tiene eventos posteriores recuperables, el motor los reproduce. Si el snapshot no permite una recuperación segura, devuelve error y exige resincronización explícita.

### editor_change

Parámetros:

- document_id
- sequence
- base_revision
- start_byte
- end_byte
- replacement

No espera al disco. Si el worker acepta el delta, devuelve status=queued y ticket_id. La confirmación durable se consulta con poll_commit.

Si la cola está llena, devuelve error -32020 y data contiene el delta original completo. El anfitrión debe conservarlo y reintentarlo antes de enviar secuencias posteriores. Si el worker está detenido, devuelve -32021 con el delta original.

### poll_commit

Parámetro: ticket_id.

Devuelve status=pending mientras el worker procesa el delta. Cuando termina, devuelve uno de:

- status=applied, revision e invalidated_suggestions.
- status=duplicate y revision.
- status=resync_required, expected_sequence y received_sequence.

Los tickets se consumen al devolver resultado terminal. Un ticket desconocido o ya consumido produce -32040. Para evitar crecimiento ilimitado de memoria, el servidor conserva como máximo 4.096 tickets sin consultar; -32041 devuelve el delta intacto para que el anfitrión consulte los tickets previos y luego reintente.

### snapshot

Parámetro: document_id.

Es una barrera FIFO: el snapshot refleja todos los deltas aceptados antes de esta solicitud. Devuelve project_id, document_id, revision, last_sequence, text y contadores de sugerencias.

La llamada espera a que el worker alcance la barrera; no usar desde el hilo de UI en cada pulsación.

### resynchronize

Parámetros: document_id, text, revision y sequence.

Reemplaza la sesión solo con el snapshot autoritativo que reenvía el anfitrión. Incrementa el epoch del diario para que eventos de una línea temporal anterior no se mezclen con la nueva.

### acknowledge_host_save

Parámetros: document_id, revision y sequence.

Solo debe enviarse después de que el anfitrión haya guardado con éxito exactamente ese snapshot. Avanza el checkpoint y permite retirar eventos incrementales ya incluidos en el archivo del anfitrión. Nunca llamar con una revisión/secuencia que solo esté en memoria del editor pero aún no se haya guardado.

### close_document

Parámetro: document_id. Cierra la sesión en memoria después de los comandos FIFO previos. No crea checkpoint implícito.

### status

No requiere parámetros. Devuelve project_id, backlog, cambios procesados, commits durables, errores, rechazos por backpressure y métricas de latencia. Para escrituras expone tres etapas diferenciadas:

- `last_queue_wait_micros`, `p50_queue_wait_micros`, `p95_queue_wait_micros` y `p99_queue_wait_micros`: tiempo desde que `try_submit_change` inicia la admisión hasta que el worker comienza a procesarlo.
- `last_commit_micros`, `p50_commit_micros`, `p95_commit_micros`, `p99_commit_micros` y `max_commit_micros`: duración de la operación de aplicación y confirmación durable en MLDB.
- `last_submit_to_durable_commit_micros`, `p50_submit_to_durable_commit_micros`, `p95_submit_to_durable_commit_micros`, `p99_submit_to_durable_commit_micros` y `max_submit_to_durable_commit_micros`: tiempo end-to-end desde que `try_submit_change` inicia la admisión hasta que termina el COMMIT durable, justo antes de responder al ticket. `end_to_end_sample_count` indica cuántos commits confirmados componen la ventana.

Las distribuciones usan ventanas móviles de hasta 256 muestras recientes y reportan microsegundos. Solo se incorporan resultados `Applied` confirmados; duplicados y errores no cuentan como commits. Una ventana sin muestras devuelve cero. También informa espera y ejecución de extracciones de párrafos y latencia de análisis asíncrono. Consultar `status` no solicita un snapshot del manuscrito ni bloquea el hilo del editor.

### analyze_affected_paragraph

Recibe document_id, expected_revision y selection_start_byte/selection_end_byte: un rango de selección válido en el texto de la revisión actual, posterior al cambio. expected_revision debe coincidir exactamente con la revisión que devuelve la barrera FIFO; si cambió, responde -32031 con la revisión y secuencia actuales para que el anfitrión recalcule. No se deben reutilizar sin transformación los offsets start_byte/end_byte del delta original si la longitud del reemplazo cambió; para una inserción/reemplazo, el anfitrión puede usar start_byte y start_byte + replacement.len() en bytes UTF-8. El motor toma una barrera FIFO después de los deltas aceptados, extrae el párrafo afectado (sin clonar el manuscrito completo); si el cambio toca un separador, incluye ambos párrafos vecinos, y devuelve texto, offsets UTF-8 absolutos, revisión, secuencia, métricas léxicas descriptivas y diagnósticos de la revisión textual propia. analysis_id es obligatorio y debe ser un ID estable del párrafo asignado por el anfitrión. El motor persiste las métricas y offsets de la revisión actual; un nuevo análisis con el mismo ID reemplaza la observación anterior, no crea historial de versiones. Por eso initialize debe haber configurado las dos rutas de conocimiento antes de llamar este método. El texto del párrafo se devuelve, pero no se duplica en la tabla de métricas. Esta consulta espera la barrera FIFO y el análisis local, por lo que el anfitrión debe ejecutarla en su hilo de análisis/background, nunca dentro del callback que entrega cada pulsación al editor. El callback de escritura debe limitarse a encolar editor_change sin esperar. El anfitrión debe invocarlo después de recibir el commit durable de editor_change; si el rango ya no corresponde a la revisión actual, el método devuelve error y el anfitrión debe recalcular con el último delta/snapshot. Los párrafos mayores de 512 KiB se rechazan para mantener acotada la latencia y memoria.

### request_analyze_affected_paragraph

Encola el análisis incremental en el grupo fijo de 2 trabajadores. Recibe document_id, expected_revision y selection_start_byte/selection_end_byte. Devuelve status=queued y ticket_id sin esperar a que termine la extracción ni el análisis. El servidor admite como máximo 4 tickets analíticos pendientes, incluidos los que ya terminaron pero todavía no fueron consultados; si se alcanza el límite o la cola no admite el trabajo, devuelve -32041. La extracción se programa en la cola de escritura/control para respetar el orden de los deltas.

Una edición aceptada del mismo documento invalida los análisis de revisiones anteriores o iguales. Abrir/reabrir, resincronizar o cerrar cancela todos los análisis de ese documento. Las tareas obsoletas que todavía esperan en la cola analítica se retiran físicamente para liberar capacidad inmediatamente; las que ya se ejecutan se cancelan cooperativamente. El anfitrión debe consultar los tickets invalidados para consumirlos y liberar su plaza lógica.

### poll_analyze_affected_paragraph

Recibe ticket_id y analysis_id. Devuelve status=pending mientras el trabajo sigue activo; status=stale y persisted=false si fue invalidado por una edición u operación de ciclo de vida; o status=ready con métricas, diagnósticos, offsets y revisión cuando el resultado supera la comprobación FIFO de vigencia y las métricas se persisten en el almacén privado del proyecto. Los diagnósticos se devuelven al anfitrión y no modifican el manuscrito. La tokenización, revisión textual y segmentación cooperan con la cancelación de análisis obsoletos. Los tickets se consumen al devolver un resultado terminal. Un análisis obsoleto nunca se guarda como vigente. La caché single-flight solo reutiliza resultados con el mismo proyecto, documento, offset inicial y texto exacto.

### analyze_fragment

Recibe text (puede ser una cadena vacía, máximo 512 KiB) y base_byte. Devuelve métricas descriptivas del fragmento: caracteres, palabras, vocabulario único, oraciones, párrafos, palabras largas, longitud media y palabras repetidas con su primer offset. Los offsets son absolutos UTF-8. El anfitrión debe enviar únicamente el párrafo afectado; este método no lee el manuscrito ni ejecuta comprensión semántica.

### proofread_fragment

Recibe `text` (máximo 512 KiB) y `base_byte`. Devuelve una lista de diagnósticos propios del motor con `code`, `severity`, `start_byte`, `end_byte`, `message` y `replacement` opcional. La primera versión detecta palabras repetidas de forma inmediata, espacios antes de puntuación, falta de espacio después de coma/punto y coma/dos puntos, espacios internos duplicados y comienzos de oración en minúscula. Los offsets son absolutos UTF-8; los rangos vacíos representan una inserción sugerida. Se limita a 4.096 diagnósticos por fragmento. El método no modifica el texto, no persiste cambios y no afirma resolver ambigüedades semánticas ni sustituir una revisión lingüística completa.

### proofread_affected_paragraph

Recibe document_id, expected_revision y selection_start_byte/selection_end_byte. Toma una barrera FIFO, extrae únicamente el párrafo afectado de la revisión exacta y ejecuta las reglas de proofread_fragment sobre ese texto. Devuelve document_id, revision, last_sequence, rango absoluto UTF-8 y diagnósticos. Si la revisión cambió, devuelve el conflicto de revisión; los párrafos mayores de 512 KiB se rechazan. Como la extracción espera una barrera FIFO, el anfitrión debe invocarlo desde su hilo de análisis/background después del commit durable, nunca desde el callback de cada pulsación. No modifica ni persiste el manuscrito.

### tokenize_fragment

Recibe text (puede ser una cadena vacía, máximo 512 KiB) y base_byte. Devuelve hasta 50.000 tokens con forma normalizada, start_byte, end_byte y cantidad de caracteres. Los offsets son absolutos UTF-8. Los apóstrofos se conservan en la forma normalizada y los guiones se eliminan para agrupar palabras compuestas; no se realiza normalización Unicode canónica.

- put_fragment_analysis / get_fragment_analysis / list_fragment_analysis_ids / delete_fragment_analysis: permiten insertar, recuperar, enumerar y eliminar análisis por ID. `source_text` es opcional para compatibilidad, pero los análisis automáticos nuevos lo persisten con el texto UTF-8 exacto (máximo 512 KiB); la codificación durable v2 sigue leyendo registros v1, que no disponen de esta procedencia.
- put_evidence solo acepta documentos abiertos en la revisión exacta; valida el rango UTF-8 y compara el extracto byte por byte con el texto vivo antes de persistirlo. No copia el manuscrito completo.
- delete_evidence elimina una cita por ID, devuelve `deleted: true` si existía y `false` si no estaba, y actualiza los índices derivados por documento; estos se reconstruyen desde los registros restantes al reiniciar.

### Registros de conocimiento narrativo

Los siguientes métodos requieren que initialize haya recibido ambas rutas locales de conocimiento:

- put_entity / get_entity: id, canonical_name, entity_type, attributes (objeto de cadenas) y status (proposed, confirmed, rejected, superseded).
- put_relation / get_relation: id, subject_id, predicate, object_id y status.
- put_event / get_event: id, label, chronology_order (entero o null) y status.
- put_evidence / get_evidence: id, target_kind (entity, relation, event), target_id, document_id, revision, start_byte, end_byte, excerpt y source_kind.
- list_entity_ids_page, list_relation_ids_page, list_event_ids_page, list_evidence_ids_page y list_fragment_analysis_ids_page: enumeran IDs globales en páginas ordenadas. Aceptan offset (0 por defecto) y limit (100 por defecto, máximo 1.000); el anfitrión avanza offset por el número de IDs devueltos. El recorrido del almacén es incremental y solo materializa la página solicitada.
- list_entity_ids, list_relation_ids, list_event_ids, list_evidence_ids y list_fragment_analysis_ids: conservados por compatibilidad; los listados globales sin paginación devuelven hasta 50.000 IDs y requieren usar los métodos *_page para colecciones mayores.
- list_entity_ids, list_relation_ids, list_event_ids y list_evidence_ids: enumeran los IDs almacenados dentro del proyecto activo; list_evidence_ids_for_document recibe document_id y devuelve únicamente las evidencias asociadas a ese capítulo/documento, usando un índice derivado local reconstruible. El método heredado sin paginación y los listados de destinos por documento sin paginación se limitan a 50.000 IDs; para colecciones mayores devuelven un error explícito y el anfitrión debe utilizar las variantes paginadas. list_evidence_ids_for_document_page admite además offset (0 por defecto) y limit (100 por defecto, máximo 1.000) para recuperar páginas ordenadas sin generar una respuesta completa; el anfitrión continúa sumando el número de IDs devueltos al offset. Un limit fuera de 1..1000 se rechaza. list_entity_ids_for_document_page, list_relation_ids_for_document_page y list_event_ids_for_document_page aceptan document_id, offset y limit (1..1000) y devuelven páginas ordenadas de destinos distintos sin clonar la colección completa de IDs de evidencia. Sus variantes `list_entity_ids_for_document_after`, `list_relation_ids_for_document_after` y `list_event_ids_for_document_after` usan `after_id` exclusivo para paginación por cursor. list_entity_ids_for_document, list_relation_ids_for_document y list_event_ids_for_document devuelven, sin duplicados, los destinos narrativos referenciados por esas evidencias; se incluyen también los destinos cuya evidencia quedó obsoleta para conservar su trazabilidad histórica. El anfitrión recupera cada registro con su método get correspondiente. analyze_fragment calcula métricas locales del fragmento y no requiere configurar las rutas de conocimiento. analyze_affected_paragraph obtiene el párrafo afectado directamente del documento en vivo después de los cambios ya encolados.

Los registros se guardan bajo el project_id aportado por el anfitrión. La API verifica que las relaciones apunten a entidades existentes, que las evidencias apunten a destinos existentes del tipo declarado y que los offsets/extractos coincidan byte por byte con la revisión viva exacta. Esta última comprobación se realiza en el worker sin clonar el manuscrito; si la revisión cambió, devuelve -32031.

### shutdown

Drena los cambios aceptados, espera el hilo de escritura y solicita que el proceso termine después de responder.

## 3. Códigos de error de aplicación

| Código | Significado |
|---:|---|
| -32700 | JSON inválido |
| -32600 | Solicitud JSON-RPC inválida |
| -32601 | Método no reconocido |
| -32602 | Parámetros inválidos |
| -32010 | Motor no inicializado |
| -32011 | Motor ya inicializado |
| -32020 | Cola llena; reintentar el delta incluido |
| -32021 | Worker detenido |
| -32030 | Error del motor/almacenamiento |
| -32031 | La revisión cambió antes del análisis o la evidencia; incluye revisión y secuencia actuales |
| -32040 | Ticket inexistente o consumido |
| -32041 | Límite de tickets sin consultar alcanzado; incluye el delta para reintento |
| -32050 | Respuesta JSON supera 16 MiB |

## 4. Secuencia de integración recomendada

1. Iniciar el binario como proceso local y conservar stdin/stdout.
2. Consultar get_capabilities.
3. Enviar initialize con la identidad y las rutas locales de la base del proyecto.
4. Al abrir el libro, enviar open_document para cada documento que se monitoreará.
5. En cada evento del editor, asignar una secuencia monotónica y enviar editor_change con offsets UTF-8 calculados sobre base_revision.
6. Guardar el ticket_id devuelto y consultar poll_commit fuera del hilo de UI.
7. Tras el commit durable, enviar analyze_affected_paragraph desde un hilo de análisis con expected_revision y un analysis_id estable del párrafo.
8. Si se recibe -32020, conservar el delta exacto y reintentarlo antes de enviar una secuencia posterior.
9. Ante resync_required, recuperar el snapshot autoritativo del anfitrión y enviarlo mediante resynchronize.
10. Tras guardar un snapshot, confirmar revision y sequence mediante acknowledge_host_save.
11. Cerrar documentos y enviar shutdown al terminar.

## 5. Garantías y límites

- El motor no modifica el manuscrito.
- Los cambios rechazados por saturación no se descartan: se devuelven al anfitrión.
- Un ticket confirma durabilidad solo cuando poll_commit informa resultado terminal.
- La cola es FIFO dentro de una instancia y un proyecto.
- La persistencia actual usa un diario incremental por documento y project_id.
- El transporte no implementa autenticación entre procesos; el proceso debe ser iniciado y controlado por el anfitrión local.
- La revisión textual inicial mediante proofread_fragment aplica únicamente reglas formales deterministas; todavía no hay extracción semántica automática de personajes, lugares, acontecimientos y relaciones ni corrección lingüística completa. Los registros narrativos continúan siendo CRUD estructurado hasta que se conecte un extractor propio.
- El motor lingüístico y la extracción SCN siguen pendientes. Existe una primera API Rust independiente para persistir entidades, relaciones, acontecimientos y evidencias, pero aún no está expuesta por JSON-RPC ni conectada a la extracción automática. La base histórica, biblioteca de ideas, migrador MLDB 0.1→0.2 y transporte móvil siguen pendientes.
- No utilizar manuscritos reales hasta que la compilación, las pruebas, la recuperación, la concurrencia y el rendimiento hayan sido verificados en plataformas objetivo.


### Proyección de evidencias tras una edición

La API interna `transform_evidence_anchor` proyecta un rango de evidencia UTF-8 a través de un delta: desplaza los offsets cuando la edición termina antes de la cita, los conserva cuando empieza después y marca la evidencia como invalidada cuando el delta toca los bytes citados. Los límites se tratan de forma determinista: insertar exactamente al inicio desplaza la cita; insertar exactamente al final no la modifica. La función es pura y no persiste cambios automáticamente; la actualización de registros y su integración transaccional con el flujo de ediciones siguen pendientes. El motor nunca debe adivinar que una cita conserva su significado si se modificó su texto.


## 6. Actualización automática de evidencias

Cuando el anfitrión consulta `poll_commit`, el protocolo recoge los resultados disponibles de los tickets del documento y actualiza las evidencias en el mismo orden FIFO de los deltas aceptados. La coordinación no depende del orden en que el anfitrión consulte los tickets: los resultados completados se conservan hasta que se devuelve cada respuesta.

Tras un commit aplicado, el motor procesa en lotes pequeños las evidencias que estaban ancladas a la revisión base. Desplaza las citas posteriores al cambio, avanza la revisión de las citas no afectadas y marca explícitamente como obsoletas las citas intersectadas, conservando sus posiciones y revisión originales. Cada lote se confirma de forma durable e idempotente; los reintentos duplicados no vuelven a desplazar las posiciones. Esto limita memoria y tamaño de transacción incluso cuando un documento acumula muchas citas. Los cambios rechazados o que requieren resincronización no se proyectan como ediciones aplicadas.

Antes de sustituir el snapshot autoritativo, la resincronización invalida todas las evidencias del documento, incluso si conserva el mismo número de revisión. Si la resincronización falla después de invalidarlas, el resultado es conservador: las citas requieren revalidación, pero no se muestran como vigentes por error. El formato de evidencia v2 incorpora el indicador persistente `stale` y sigue leyendo registros históricos v1 como vigentes hasta que una edición o resincronización determine lo contrario. El método `get_evidence` devuelve ese indicador para que el anfitrión pueda distinguir una cita conservada históricamente de una cita utilizable en la revisión actual.

El almacén narrativo mantiene un índice derivado en memoria de evidencias por documento. Se reconstruye bajo demanda desde los registros persistentes del proyecto y se actualiza cuando una evidencia se inserta o cambia de documento. Los rebases e invalidaciones consultan ese conjunto específico, evitando recorrer evidencias de capítulos ajenos en cada edición. El índice se descarta al cerrar el proceso y se reconstruye al volver a abrir el almacén; no mezcla proyectos ni sustituye los registros durables.

La cola de coordinación es local al proceso y está limitada por el máximo de tickets pendientes. Si el proceso termina abruptamente después del commit durable y antes de actualizar el almacén narrativo, una consulta posterior a `get_evidence` recupera la secuencia validada de deltas desde el diario durable y reconstruye las posiciones en lotes narrativos pequeños e idempotentes, para limitar el uso de memoria y permitir reintentar si el proceso falla entre lotes. Las secuencias, revisiones y bloques se verifican antes de transformar offsets; además, la rutina de rebase rechaza cadenas con saltos, desorden, revisiones no consecutivas o una revisión destino distinta de la última del historial, antes de modificar cualquier evidencia. La recuperación está limitada a 100.000 cambios por época y a 5.000.000 de transformaciones estimadas, y persiste como máximo ocho evidencias por lote; al superar cualquiera de esos umbrales se conserva la procedencia histórica y se marca la cita como obsoleta, sin intentar reconstruirla parcialmente. Si el historial está incompleto, pertenece a otra época o excede el límite de recuperación, la evidencia se marca conservadoramente como obsoleta. Si todavía hay commits pendientes en el proceso actual, la respuesta tampoco presenta la cita como vigente hasta completar el rebase.


Las operaciones internas de rebase histórico, rebase por edición e invalidación de evidencias recorren directamente el índice ordenado del documento, sin clonar su colección de IDs, y persisten en lotes de ocho registros. El proceso no materializa una lista completa de IDs ni una transacción de escritura proporcional al total de evidencias. Los lotes son idempotentes: si una operación se interrumpe, la recuperación puede continuar desde el estado durable sin desplazar dos veces una cita ya actualizada.


#### Listados globales mediante cursor

Además de los métodos `*_page` basados en offset, están disponibles `list_entity_ids_after`, `list_relation_ids_after`, `list_event_ids_after`, `list_evidence_ids_after` y `list_fragment_analysis_ids_after`. Reciben `limit` (100 por defecto, rango permitido 1..1000). `after_id` es opcional en la primera llamada y, cuando se proporciona, es el último identificador de la página anterior. La búsqueda es exclusiva y se posiciona directamente en el B+Tree. El anfitrión debe repetir la llamada con el último ID devuelto hasta recibir una página vacía.

El cursor evita el coste creciente de recorrer desde el primer registro en cada página, pero no representa una instantánea transaccional: inserciones ordenadas después del cursor pueden aparecer en páginas posteriores y las inserciones anteriores no. Para una vista congelada durante escrituras concurrentes se necesitará un contrato de snapshot separado.


`list_evidence_ids_for_document_after` aplica la misma semántica de cursor exclusivo al índice ordenado de evidencias de un documento. Recibe `document_id`, `limit` (100 por defecto, 1..1000) y `after_id` opcional; la búsqueda comienza directamente después de ese ID dentro del índice del documento.


Los métodos `list_entity_ids_for_document_after`, `list_relation_ids_for_document_after` y `list_event_ids_for_document_after` aceptan `document_id`, `limit` (100 por defecto, 1..1000) y `after_id` opcional. Devuelven destinos distintos ordenados estrictamente después del cursor, sin duplicados. Un índice derivado en memoria por documento y tipo de destino se construye en el mismo recorrido que el índice de evidencias y se actualiza al insertar o reemplazar una evidencia. Las páginas se obtienen directamente de ese índice ordenado, sin recorrer nuevamente todas las citas.

### Eliminación segura de conocimiento narrativo

`delete_entity`, `delete_relation` y `delete_event` rechazan eliminar un registro mientras existan dependencias: las entidades no se eliminan si una relación las usa como sujeto/objeto o si hay evidencias que las citan; las relaciones y acontecimientos no se eliminan mientras tengan evidencias. El anfitrión debe eliminar primero las evidencias y luego las relaciones dependientes. Las operaciones no realizan cascadas destructivas. Si el registro no existe, devuelven `deleted: false`; si se elimina, `deleted: true`.

### Auditoría de integridad narrativa

Método JSON-RPC: `audit_knowledge_integrity`.

Parámetros:
- `table`: `entity`, `relation`, `event`, `evidence` o `fragment_analysis`.
- `after_id`: cursor exclusivo opcional.
- `limit`: cantidad máxima de registros examinados (1..1000; 100 por defecto).

Ejemplo de solicitud:

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "audit_knowledge_integrity",
  "params": {
    "table": "relation",
    "limit": 100
  }
}
```

La respuesta contiene `issues` (incidencias), `scanned` (registros examinados), `next_after` (ID del último registro examinado o `null`) y `has_more`. Para continuar, el anfitrión envía `next_after` como `after_id` en la próxima solicitud. El cursor avanza por registros examinados, no por incidencias; por ello una página sin problemas puede tener `has_more: true`.

Cada incidencia incluye `table`, `record_id`, `code` y `target_id` (o `null`). Los códigos incluyen `malformed_record`, `record_too_large`, `orphan_relation_subject`, `orphan_relation_object`, `orphan_evidence_target`, `invalid_fragment_analysis_fields` e `invalid_fragment_analysis_words`, además de sus variantes de destino no legible. La operación es de solo lectura, limitada a la página solicitada y al proyecto activo. No repara ni elimina datos automáticamente. No forma parte de la ruta caliente de escritura del editor.

#### Auditoría contra el documento vivo

Método JSON-RPC: `audit_document_evidence`.

Parámetros:
- `document_id`: ID del documento abierto en el motor.
- `after_id`: cursor exclusivo opcional dentro de las evidencias de ese documento.
- `limit`: cantidad máxima de evidencias examinadas (1..1000; 100 por defecto).

La auditoría utiliza la validación de evidencia del worker para comprobar revisión, límites UTF-8 y extracto exacto en el texto vivo. No reconstruye el manuscrito completo. Informa `evidence_anchor_stale`, `evidence_revision_mismatch`, `evidence_excerpt_mismatch`, `invalid_evidence_anchor` o `evidence_document_index_mismatch`. Requiere que el documento esté abierto; los errores de almacenamiento, worker o documento no disponible se devuelven como errores, no como incidencias de integridad.

#### Auditoría de análisis lingüísticos persistidos

Método JSON-RPC: `audit_document_fragment_analyses`.

Parámetros:
- `document_id`: documento abierto que se quiere contrastar.
- `after_id`: cursor exclusivo dentro del índice de análisis del documento.
- `limit`: máximo de registros examinados (1..1000; 100 por defecto).

La paginación avanza únicamente por los análisis del documento solicitado; `next_after` se envía como `after_id` en la siguiente llamada. El índice derivado se reconstruye de forma incremental en el primer uso y se mantiene al insertar o eliminar análisis. Los análisis nuevos conservan el texto UTF-8 exacto que produjo sus métricas (campo opcional `source_text`, máximo 512 KiB, en `put_fragment_analysis` y `get_fragment_analysis`); el almacenamiento v2 sigue leyendo registros v1, que quedan identificados como históricos sin procedencia textual verificable. Solo los registros del documento solicitado se contrastan con el documento vivo mediante una barrera FIFO del worker. Se detectan `fragment_analysis_malformed_record`, `fragment_analysis_revision_mismatch`, `fragment_analysis_source_text_mismatch`, `fragment_analysis_source_unavailable`, `fragment_analysis_invalid_range` y `fragment_analysis_invalid_utf8_boundary`. La comprobación compara el texto original persistido con el rango vivo; no recalcula métricas ni modifica registros. También detecta resincronizaciones que conservan el número de revisión pero cambian el contenido, y funciona después de reiniciar cuando el anfitrión vuelve a abrir el documento y el motor reproduce el WAL. La operación no reconstruye el manuscrito. Requiere que el documento esté abierto. La capacidad `fragment_analysis_source_provenance` se anuncia en `get_capabilities`.
