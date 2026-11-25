# Diario durable de cambios en vivo — contrato experimental v0.1

## Propósito

El anfitrión es propietario del proyecto, de sus identificadores y del snapshot completo del documento. El Motor Literario recibe del anfitrión cambios incrementales y conserva un diario durable para recuperación y análisis posterior. El motor no observa el editor por sí mismo ni reescribe el documento.

La identidad `project_id` y `document_id` siempre procede del anfitrión. Todas las claves MLDB incluyen explícitamente `project_id`; los eventos de un documento usan una tabla derivada de su ID y del epoch vigente.

## Escritura atómica

Cada edición aceptada produce una sola transacción `ProjectStore::apply_batch` / MLPJ que contiene:

1. Uno o más registros con el delta UTF-8 del editor.
2. La nueva cabecera durable del documento (revisión y secuencia máximas).

El motor valida el cambio sin clonar el texto completo. Solo después del COMMIT durable aplica el delta a la sesión en memoria. Si la escritura devuelve un error ambiguo, la instancia se pone en cuarentena; debe cerrarse y reabrirse para que MLDB ejecute recovery antes de continuar.

Los deltas se dividen en fragmentos UTF-8 de hasta 3.000 bytes. El primer fragmento incluye la cabecera del evento; los restantes contienen bytes de reemplazo. Se admiten hasta 4.096 fragmentos por evento (aprox. 12 MiB). Todos los fragmentos y la cabecera high-water se confirman juntos.

## Registros

### Cabecera MLHD

- Magic: `MLHD`.
- Versión de formato: `1`.
- Epoch: u64 little-endian.
- Secuencia base: u64 little-endian.
- Última secuencia durable: u64 little-endian.
- Última revisión durable: u64 little-endian.

La versión actual ocupa 37 bytes. Se acepta la cabecera experimental anterior de 29 bytes como epoch 0 para recuperación compatible; esos documentos siguen leyendo y escribiendo en la tabla de eventos heredada sin sufijo de epoch hasta que una resincronización explícita abre una nueva época.

### Evento MLEV

- Magic: `MLEV`.
- Versión: `1`.
- Revisión base: u64 little-endian.
- Offset inicial UTF-8: u64 little-endian.
- Offset final UTF-8: u64 little-endian.
- Longitud total del reemplazo en bytes: u64 little-endian.
- Cantidad de fragmentos: u32 little-endian.
- Bytes del reemplazo, distribuidos en fragmentos.

El ID de registro es la secuencia decimal de 20 dígitos, dos puntos y el índice de fragmento de 6 dígitos. El orden lexicográfico coincide con el orden de secuencia/fragmento.

## Recuperación

Al abrir un documento, el anfitrión entrega texto, revisión y secuencia:

- Si no hay cabecera MLHD, esos valores crean la base inicial.
- Si la secuencia del anfitrión coincide con la última durable, la revisión también debe coincidir.
- Si el anfitrión está por detrás, el motor reproduce los eventos posteriores a su secuencia y comprueba continuidad, revisión y secuencia final.
- Si el anfitrión está por delante, su snapshot se acepta como nueva base autoritativa y comienza un epoch nuevo.
- Si el anfitrión está por detrás de la secuencia base confirmada, se exige resincronización; el motor no inventa ni reconstruye un snapshot que ya no conserva.

Una resincronización explícita incrementa el epoch. Esto evita mezclar eventos de dos líneas temporales que reutilicen números de secuencia. Los eventos del epoch anterior se eliminan después de confirmar la nueva cabecera.

## Checkpoint y retención

`checkpoint_document` solo puede ejecutarse cuando el anfitrión confirma que ya guardó el snapshot cuya revisión y secuencia coinciden exactamente con la cabecera durable. Primero se confirma la nueva secuencia base y después se eliminan los eventos cubiertos en lotes acotados. Si la limpieza se interrumpe, los eventos restantes quedan por debajo de la base y no se reproducen.

Cerrar una sesión no crea un checkpoint automáticamente: el anfitrión puede necesitar recuperar deltas todavía no incorporados a su snapshot guardado.

## Ingestión asíncrona

`LiveEngineWorker` posee una cola FIFO acotada y un hilo dedicado para las escrituras MLDB. `try_submit_change` no espera al disco. Devuelve un ticket para consultar/esperar el COMMIT. Si la cola está llena, devuelve el `PendingChange` original; el anfitrión debe conservarlo y reintentarlo antes de encolar secuencias posteriores, para mantener el orden. `pending_changes` informa cambios en cola o en curso. `metrics()` expone el conteo de commits durables/errores y percentiles p50/p95/p99 móviles sobre las últimas 256 confirmaciones exitosas; los valores de referencia en hardware real siguen pendientes.

El worker reduce el bloqueo del hilo de escritura, pero la durabilidad solo se confirma al recibir el resultado exitoso del ticket. El anfitrión no debe descartar cambios pendientes ni los rechazados por saturación. La barrera de snapshot, checkpoint, resincronización y cierre respeta el orden FIFO.

## Privacidad y límites

- Los datos permanecen en el almacén local MLDB y separados por `project_id`.
- Los eventos contienen el texto de los fragmentos editados; no se envían a otros proyectos ni se comparten con otros escritores.
- El anfitrión conserva el snapshot completo y sigue siendo la autoridad del documento.
- Las sugerencias y el conocimiento narrativo derivado todavía no se persisten en este adaptador.
- El commit síncrono puede tardar; la cola asíncrona evita esperar desde el hilo editor, pero no elimina el retraso hasta la durabilidad.
- No se han validado compilación, pruebas nativas ni latencias p50/p95/p99 en esta sesión. No usar con manuscritos reales hasta superar las matrices de pruebas y recuperación.

