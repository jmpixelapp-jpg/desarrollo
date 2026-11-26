# Contrato de transporte para sincronización narrativa

**Implementación:** `typescript/src/narrative-sync.ts`  
**Estado:** coordinador y bandeja durable IndexedDB integrados en esta rama; el transporte remoto sigue siendo un adaptador del anfitrión  
**Formato:** TypeScript/JavaScript puro, sin dependencias de runtime

## Responsabilidades

`NarrativeSyncCoordinator` conecta dos puertos:

- `SyncOutboxPort`: implementado directamente por `IndexedDbProjectStore` (IndexedDB v25); lee operaciones pendientes, registra intentos, cuenta también las operaciones retrasadas y elimina una operación únicamente después de un acuse explícito. `recordSyncOperationAttempt(..., nextAttemptAt)` persiste la próxima fecha; omitirla limpia el backoff anterior.
- `SyncTransport`: envía un lote a un servidor y devuelve tres conjuntos disjuntos: operaciones aceptadas, conflictos y operaciones reintentables.

El coordinador no conoce HTTP, credenciales, proveedor cloud ni formato de API. Esas responsabilidades pertenecen al anfitrión y a un adaptador remoto que deberá validar autenticación, autorización por proyecto, esquema y tamaño del payload.

## Garantías del coordinador

1. Aísla cada ejecución por `projectId`; una operación de otro proyecto se rechaza antes de enviarse.
2. Limita el tamaño del lote a 50 por defecto y 500 como máximo configurable.
3. Valida IDs, secuencias, marcas temporales y contadores recibidos de la bandeja.
4. Coalesce llamadas simultáneas del mismo proyecto dentro de la misma instancia. Proyectos distintos pueden avanzar en paralelo.
5. Exige que cada ID devuelto por el transporte pertenezca al lote y aparezca en una sola clasificación.
6. Registra el intento de todas las operaciones enviadas antes de retirar las aceptadas.
7. Conserva conflictos y operaciones reintentables en la bandeja; no intenta resolverlos ni sobrescribir datos locales.
8. Aplica backoff exponencial local con jitter igual (1 segundo inicial y máximo de 5 minutos por defecto); nextAttemptAt se persiste en IndexedDB.
9. No reenvía operaciones antes de su fecha y no adelanta operaciones posteriores cuando la primera pendiente está en backoff.
10. Cuenta como pendientes también las operaciones que esperan su próxima ventana de reintento.
11. Ante error de red o respuesta inválida, registra el intento, programa el siguiente y propaga el error. No confirma operaciones.

## Contrato de respuesta remota

- `acknowledgedOperationIds`: el servidor ha aceptado durablemente la operación y puede deduplicarla por `operationId`.
- `conflicts`: el servidor reconoce la operación, pero requiere reconciliación explícita; debe permanecer pendiente.
- `retryableOperationIds`: no se ha completado el procesamiento y puede reintentarse.

Una respuesta debe clasificar exactamente una vez cada operación enviada: no puede omitir IDs, clasificar dos veces el mismo ID ni incluir IDs que no fueron enviados. El servidor debe tratar `operationId` como clave de idempotencia para soportar reenvíos tras timeouts en los que el cliente no pudo conocer el resultado.

## Límites deliberados

Este módulo **no completa la sincronización multidispositivo**. Todavía faltan:

- Transporte remoto y contrato versionado de API.
- Autenticación y autorización por escritor/proyecto.
- Firma o verificación de integridad del lote y límites del payload en el servidor.
- Resolución interactiva de conflictos, con revisión de base y cambios concurrentes.
- Política del anfitrión para despertar el coordinador cuando haya conexión o periódicamente; la fecha y el backoff ya se conservan localmente.
- Límites de frecuencia del servidor.
- Pruebas de integración contra un servidor y pruebas entre dos dispositivos.

El coordinador también valida el tamaño y la estructura JSON de cada payload antes de entregarlo al transporte. Las respuestas limitan `code` de conflicto a 128 caracteres y `message` a 2.048, evitando que un adaptador remoto introduzca metadatos de error sin cota. El anfitrión no debe borrar una operación por timeout, respuesta ambigua o conflicto. Solo un acuse explícito y validado permite retirarla.

## Pruebas añadidas

`tests/indexeddb-sync-outbox.test.mjs` verifica la bandeja real con IndexedDB, el conteo durable y la persistencia del próximo intento; `tests/indexeddb-storage-health.test.mjs` cubre diagnósticos de cuota/almacenamiento. `tests/narrative-sync.test.mjs` cubre acuse selectivo, conservación de conflictos/reintentos, rechazo de IDs ajenos, respuestas parciales, coalescencia concurrente, paralelismo por proyecto, backoff exponencial, bloqueo de secuencia mientras una operación espera y validación de payloads/lotes.

La existencia de estos tests acredita cobertura escrita, no ejecución satisfactoria. La validación requiere `npm run typecheck` y `npm test` desde `typescript/`.

## Idempotencia de la bandeja local

La clave `operationId` identifica el contenido inmutable de una operación: proyecto, dispositivo, secuencia, tipo, fecha de creación y payload JSON. Los metadatos locales de reintento (`attemptCount`, `lastAttemptAt`, `lastError` y `nextAttemptAt`) no forman parte de esa identidad. Reencolar una operación ya persistida tras un timeout o un reinicio es idempotente y no debe borrar ni reiniciar su backoff. La comparación del payload normaliza recursivamente las claves de objetos JSON, preservando el orden de los arrays.

## Orden causal durante la recuperación

La recuperación de pendientes usa el índice `by-project-device-sequence`, no el índice temporal. `createdAt` es metadato de auditoría y puede verse afectado por desfases o ajustes del reloj local; no es una fuente fiable del orden causal. El lote queda ordenado por escritor/dispositivo y secuencia ascendente dentro de cada escritor. Las secuencias de dispositivos distintos son flujos independientes y no se interpretan como un reloj global.

## Aislamiento del backoff entre escritores

El orden y el bloqueo por reintento se aplican dentro de cada flujo `(projectId, deviceId)`. Una operación retrasada bloquea las secuencias posteriores de ese mismo dispositivo, pero no impide que otros dispositivos del proyecto envíen sus propios flujos independientes. El servidor sigue siendo responsable de deduplicar `operationId` y aplicar autorización por proyecto.

## Recuperación ante interrupción durante acuses locales

El servidor puede haber aceptado un lote completo aunque el cliente se interrumpa mientras elimina sus acuses locales. La bandeja elimina cada operación confirmada de forma independiente y transaccional: si falla un borrado posterior, las ya retiradas no se reenvían y las restantes se recuperan en el siguiente ciclo. Si la interrupción ocurre antes de retirar una operación ya aceptada remotamente, esta podrá reenviarse; por ello el transporte remoto debe deduplicar por `operationId`. La entrega es, por diseño, al menos una vez, no exactamente una vez.

## Concurrencia entre pestañas e instancias

La coalescencia `inFlight` del coordinador evita envíos simultáneos del mismo proyecto únicamente dentro de una misma instancia JavaScript. No constituye un bloqueo compartido entre pestañas, workers o instancias del coordinador. Dos contextos pueden leer y enviar la misma operación antes de que cualquiera retire su acuse local. Por tanto, el transporte y el servidor deben admitir entregas duplicadas y deduplicar de forma atómica por `(projectId, operationId)`; una clave de idempotencia aislada en memoria no es suficiente.

La bandeja de sincronización dispone ahora de un adaptador opcional de lease compartido respaldado por el almacén IndexedDB de leases ya existente. No requiere una migración adicional de esquema. La exclusión entre contextos solo se activa cuando cada coordinador inyecta un adaptador y cada contexto usa un `ownerId` distinto. Sin esa configuración, `inFlight` sigue protegiendo únicamente una instancia.


## Bloqueo compartido del coordinador

El coordinador admite ahora un puerto opcional `SyncExecutionLock` en sus opciones. Su método `runExclusive(key, task)` recibe una clave estable por proyecto (`narrative-sync:<projectId>`) y debe ejecutar la tarea en exclusión mutua entre todas las instancias que compartan el proveedor. La coalescencia local `inFlight` se mantiene para llamadas repetidas dentro de una instancia.

El núcleo no depende de APIs del navegador. El anfitrión puede adaptar este puerto a Web Locks o a un lease IndexedDB durable. Si no se inyecta un proveedor compartido, se conserva el comportamiento anterior: exclusión solo por instancia. El puerto no convierte por sí solo la entrega en exactamente-una-vez; el servidor sigue obligado a deduplicar `operationId`. Los proveedores de lease deben contemplar vencimiento, liberación condicionada por propietario/fencing token y operaciones que superen la duración inicial del lease.


## Adaptador IndexedDB para bloqueo compartido

La implementación `IndexedDbSyncExecutionLock` conecta el puerto `SyncExecutionLock` con el almacén de leases existente. Usa una identidad de documento reservada por proyecto, adquisición transaccional, propietario por contexto, renovación periódica, liberación condicionada por propietario y fencing token, y espera con sondeo cuando otro contexto mantiene el lease. También serializa las llamadas concurrentes dentro de la misma instancia del adaptador para impedir la reentrada del mismo propietario.

Configuración: cada pestaña/worker debe construir su propio adaptador con un `ownerId` distinto y compartir la misma base IndexedDB. Debe inyectarse como `executionLock` al `NarrativeSyncCoordinator`. El mecanismo es un lease: una pestaña suspendida más allá del vencimiento puede perder la titularidad; para efectos remotos irreversibles el servidor debe seguir deduplicando `operationId` y, cuando proceda, validar fencing tokens. La exclusión compartida reduce duplicados normales, pero no sustituye idempotencia del servidor.


### Integración recomendada

```ts
const store = new IndexedDbProjectStore();
const executionLock = new IndexedDbSyncExecutionLock(store, {
  ownerId: createUniqueContextId()
});
const coordinator = new NarrativeSyncCoordinator(store, transport, {
  executionLock
});
```

El identificador debe ser único por contexto de ejecución y mantenerse estable durante la vida de ese adaptador. No compartir el mismo `ownerId` entre pestañas: el almacén considera que el mismo propietario puede renovar su lease activo. Cerrar el contexto debe cerrar también su conexión al almacén. Si el contexto desaparece sin liberar el lease, otro propietario puede adquirirlo después de `expiresAt`, recibiendo un fencing token superior.

Las tareas que pierdan el lease se consideran de resultado incierto: el transporte puede haber sido aceptado antes de detectar la pérdida. Se debe reconciliar mediante deduplicación remota por `operationId`; nunca asumir exactamente una vez.


### Ciclo de vida del lease y fallos de tarea

El adaptador renueva el lease aproximadamente cada tercio de su duración configurada. Antes de liberar espera cualquier renovación que ya esté en curso, evitando que una renovación tardía compita con la liberación. Si la tarea falla, el lease se libera igualmente y el error original de la tarea se propaga. Si la renovación falla o la titularidad ya no coincide, el adaptador marca el lease como perdido y rechaza el resultado al finalizar la tarea.

La prueba de integración debe cubrir tareas más largas que la duración inicial del lease, la espera de un segundo propietario durante la renovación y la liberación tras una excepción. La renovación reduce la ventana normal de expiración, pero no puede impedir que un navegador suspendido detenga temporizadores durante un periodo prolongado.


### Confirmación local atómica de acuses

El puerto `SyncOutboxPort` permite implementar `acknowledgeSyncOperations(ids)` para retirar varios acuses en una única transacción. El coordinador detecta esta capacidad y la prefiere; los adaptadores anteriores que solo implementan `acknowledgeSyncOperation(id)` conservan compatibilidad mediante el recorrido individual.

La implementación IndexedDB lee y elimina el lote dentro de una transacción `readwrite`. Si la transacción falla, el lote completo se revierte en lugar de dejar una retirada parcial por fallo entre operaciones. Los IDs repetidos se rechazan; una lista vacía devuelve cero; los IDs ya ausentes no cuentan como nuevos acuses. Esta atomicidad solo cubre la persistencia local: no crea una transacción distribuida con el servidor. Si el servidor aceptó el lote y el cliente falla antes del commit local, el lote puede reenviarse y el servidor debe deduplicar cada `operationId`.


### Recuperación ante aceptación remota ambigua

Un timeout o una desconexión no demuestra que el servidor haya rechazado la operación: puede haber confirmado el cambio y perderse únicamente la respuesta. En ese caso el coordinador registra el intento, conserva la operación y la reenvía cuando vence el backoff. El transporte debe enviar el mismo `operationId` en cada repetición y el servidor debe aplicar una deduplicación durable y atómica por proyecto/operación.

También puede ocurrir que el servidor responda con acuses válidos y falle después la transacción local que retira esos acuses. La bandeja conserva entonces las operaciones y el siguiente ciclo vuelve a enviarlas. El acuse remoto repetido debe ser idempotente y permitir que el cliente vuelva a retirar localmente la operación. La nueva prueba simula ambos lados: aceptación remota persistente, fallo de commit local y recuperación posterior sin duplicar el efecto remoto.

Esta garantía no es una transacción distribuida ni una prueba del backend real: el repositorio cliente solo puede exigir y probar el contrato mediante un transporte simulado. La implementación del servidor debe mantener su registro de idempotencia durable durante todo el horizonte de reintentos.


### Conflictos y orden causal por dispositivo

Un conflicto se conserva en la outbox como operación pendiente, con el código y mensaje del conflicto en `lastError` y una fecha de próximo intento. No se elimina ni se interpreta como aceptación. El backoff actúa como barrera causal: las operaciones posteriores del mismo dispositivo no se envían mientras la operación anterior esté bloqueada. Las operaciones de otros dispositivos pueden avanzar porque representan flujos causales independientes.

El backoff no resuelve el conflicto de negocio. Tras vencer, el coordinador puede volver a presentar la operación al transporte; el servidor debe devolver una clasificación actualizada o una aceptación explícita. Una reconciliación real (por ejemplo, rebase, edición o elección entre versiones) requiere una decisión de dominio y un contrato específico; no se simula ni se realiza automáticamente en este coordinador.

### Reintento y reclasificación de un conflicto

Cuando vence nextAttemptAt, el coordinador puede volver a enviar la misma operación, conservando operationId y payload. El resultado del transporte debe clasificarla de nuevo de forma exhaustiva: si el servidor confirma que ahora puede aceptarla, el acuse explícito permite retirarla; si continúa en conflicto, permanece pendiente y recibe un nuevo backoff. El coordinador no modifica el payload, no cambia la revisión de origen y no presupone que el conflicto se haya resuelto por el mero paso del tiempo.

La regresión correspondiente cubre tres momentos: conflicto inicial, ausencia de envío un milisegundo antes del vencimiento y aceptación explícita en el instante de vencimiento. Comprueba que el reintento conserva la identidad y el contenido de la operación. Esta prueba valida el comportamiento del cliente con un transporte simulado; no demuestra que un servidor real haya reconciliado la revisión.

### Regresión de recuperación con la outbox IndexedDB

Además de la prueba del coordinador con una outbox en memoria, la suite de integración cubre el mismo ciclo usando `IndexedDbProjectStore`: el conflicto y su mensaje quedan persistidos, el vencimiento se respeta entre llamadas separadas, y el segundo envío conserva `operationId` y payload. La operación se elimina únicamente tras el acuse posterior. El transporte sigue siendo simulado, por lo que esta regresión verifica la persistencia y la coordinación del cliente, no el comportamiento de un servidor remoto real.


## Sustitución y reconciliación explícita: límites actuales

Una decisión de edición o fusión no puede reutilizar el `operationId` conflictivo con un payload diferente. Debe producir una identidad nueva y una secuencia posterior asignada por la autoridad del escritor. La operación conflictiva no se sobrescribe ni se elimina por una decisión local no confirmada. El registro de conflicto, la operación sustitutiva y cualquier cambio de estado futuro deberán actualizarse en una única transacción IndexedDB con precondiciones verificadas para evitar que dos pestañas apliquen decisiones obsoletas.

La regresión añadida comprueba únicamente la invariante de no sobrescritura: una operación nueva con ID y secuencia diferentes puede coexistir con la original, y la original conserva payload y backoff. Esto no constituye todavía una API de resolución ni una transacción atómica de reconciliación. El modelo versionado de conflictos, la autoridad de secuencias, la migración y el recibo remoto de aceptación siguen pendientes. El diseño completo está en `docs/development/SYNC_CONFLICT_RECONCILIATION_DESIGN.md`.


## Secuencias de dispositivo: integridad frente a asignación

La outbox recibe operaciones con `sequence` ya asignada; `enqueueSyncOperation` no calcula el siguiente valor ni reserva números. El índice único `by-project-device-sequence` impide duplicados para el mismo proyecto y dispositivo, incluso ante inserciones concurrentes, pero no constituye un asignador. Calcular el máximo mediante una lectura y sumar uno no es seguro entre pestañas. Una futura sustitución manual necesita un asignador durable y transaccional o una secuencia reservada por una autoridad externa fiable. La prueba concurrente incorporada comprueba que una colisión de secuencia se rechaza, no que el siguiente número se asigne automáticamente.


### Asignación local de secuencia

Los nuevos escritores pueden usar `ProjectStore.enqueueNextSyncOperation(draft)` / `IndexedDbProjectStore.enqueueNextSyncOperation(draft)`: el borrador omite `sequence` y el almacén devuelve la operación persistida con secuencia asignada. La comprobación idempotente del `operationId`, lectura de la última secuencia del dispositivo e inserción ocurren en una sola transacción `readwrite` sobre `SYNC_OUTBOX`. Dos conexiones IndexedDB competidoras del mismo origen quedan serializadas por el almacén y reciben secuencias consecutivas distintas. Repetir la misma identidad devuelve la secuencia ya asignada; reutilizar el ID con contenido distinto se rechaza.

El método no requiere migración: utiliza el índice único existente y considera también operaciones legacy con secuencia explícita. El método antiguo `enqueueSyncOperation` se mantiene por compatibilidad, pero los nuevos escritores deben preferir el asignador. La garantía se limita a una base IndexedDB compartida en un mismo origen; no coordina dispositivos físicos independientes ni reemplaza la autoridad de secuencia del servidor para orden global.
