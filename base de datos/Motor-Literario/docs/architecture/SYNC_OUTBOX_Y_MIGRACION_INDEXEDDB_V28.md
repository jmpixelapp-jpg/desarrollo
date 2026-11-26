# Persistencia narrativa, outbox y sincronización — IndexedDB DB28

## Alcance

Este documento describe la infraestructura local de persistencia saliente del Motor Literario TypeScript. IndexedDB DB28 conserva los almacenes anteriores y añade los almacenes operativos para sincronización y recuperación de reparaciones. La escritura local no realiza llamadas de red: el anfitrión proporciona cualquier transporte externo.

## Almacenes nuevos

| Almacén | Clave | Función |
|---|---|---|
| `sync-outbox` | `operationId` | Operaciones salientes pendientes y metadatos de reintento |
| `sync-device-sequences` | `[projectId, deviceId]` | Secuencia monotónica por proyecto e instalación |
| `narrative-reference-repair-audits` | `[projectId, operationId]` | Recibos append-only de reparaciones confirmadas |
| `narrative-reference-repair-pending` | `[projectId, operationId]` | Intenciones durables para reanudar reparaciones incompletas |

El manifiesto `storage_mapping_v0.4.2.json` y `PHYSICAL_STORAGE_MAPPING_v0.4.2.md` declaran estos almacenes, claves e índices. La migración es ascendente desde DB27 a DB28; crea los almacenes que falten y no borra las tablas ni los datos anteriores.

## Escritura local sin pérdida entre dominio y outbox

El anfitrión identifica cada instalación con un `ProjectIdentity.deviceId` UUID estable. No se regenera por sesión ni se deriva de datos personales. Al configurar esa identidad, el adaptador debe anunciar `supportsAtomicNarrativeSyncOutbox === true`.

Las ediciones del editor usan `appendChangeAndEnqueueSyncOperation`: el delta de `changes`, el registro `sync-outbox` y el cursor del dispositivo se escriben en la misma transacción `readwrite`.

Las mutaciones CAS de entidades, ideas, afirmaciones, relaciones, acontecimientos y fusiones de entidades aceptan un `SyncOperationDraft`. Cuando se proporciona, la escritura del registro de dominio, la operación saliente y el avance de secuencia comparten transacción. Una colisión, error de índice o error de escritura aborta todo el conjunto.

El cierre de libro mediante `archiveUnincorporatedIdeas()` también puede ser saliente. Con `deviceId` activo, el store confirma en una única transacción el traslado de ideas a la biblioteca personal, la eliminación de las entradas del proyecto, el recibo de finalización, la operación `personal-idea-archive` y la secuencia del dispositivo. El payload conserva el escritor, el título de origen, la fecha, la lista ordenada de IDs y el checksum. En el receptor, el handler solo se registra con `resolveAuthorizedWriterId`; antes de confirmar valida que el conjunto local de ideas `IDEA` y el recibo coincidan exactamente. Si el libro cambió, el replay se detiene y permanece pendiente.

Las operaciones recibidas desde otro dispositivo no se reencolan al aplicar el handler. El consumidor entrante usa CAS sin `SyncOperationDraft`, evitando ecos de sincronización.

Si el adaptador no puede ofrecer atomicidad, el anfitrión no debe configurar `deviceId`; la API rechaza de forma segura las mutaciones sincronizables en vez de confirmar cambios que no podrá replicar.

## Orden, idempotencia y reintentos

`loadPendingSyncOperations` lee en FIFO por proyecto/dispositivo/secuencia, sin depender del reloj local. Cada operación tiene `operationId` estable y una secuencia asignada por el almacén. Los intentos guardan solo timestamp y un código de error no sensible; nunca guardan mensajes de excepción que puedan contener secretos.

La entrega es al menos una vez. El receptor deduplica por `operationId` y compara el digest de la envoltura. Las operaciones permanecen en la outbox hasta que un acuse remoto durable coincide exactamente en proyecto, operación, stream de dispositivo, secuencia y digest.

## Despacho saliente

`dispatchPendingNarrativeSyncOperations` transforma cada payload JSON en una envoltura versionada y calcula SHA-256 sobre su representación canónica. El anfitrión suministra `transport.send`; no se incluye cliente HTTP predeterminado ni se envían datos automáticamente.

El campo `writerId` de la envoltura identifica el stream de instalación y coincide con `deviceId`; no autentica a una persona. El transporte debe autenticar al anfitrión y el servidor debe autorizar la relación usuario/dispositivo/proyecto. SHA-256 verifica integridad, pero no sustituye autenticación ni autorización.

Los payloads `document.change` y los payloads de registros narrativos contienen información del manuscrito. Deben tratarse como contenido privado y protegerse en tránsito y en el servidor de destino.

## Recuperación durable de reparaciones del grafo

Las reparaciones de referencias se registran primero en `narrative-reference-repair-pending`, con un ID determinista por proyecto, tipo de registro, campo y referencias. Después se ejecuta la reparación CAS, se escribe el recibo append-only en `narrative-reference-repair-audits` y finalmente se elimina la intención pendiente.

Si el proceso se cierra entre etapas, la intención permanece y `repairNarrativeProjection` puede reanudarla de forma idempotente. Si la aplicación del cambio ya ocurrió, la reconciliación reconoce las referencias ya reparadas y completa la auditoría antes de retirar la intención.

## Validación

Las suites relevantes cubren migración DB27→DB28 con datos anteriores preservados, creación de almacenes, CAS/outbox atómico para editor y grafo, rechazo por colisión, envío y acuse durable, replay idempotente de fusiones y recuperación de intenciones de reparación. También verifican la transferencia de biblioteca personal y su recibo exacto durante la sincronización. La CI ejecuta typecheck, build, validación física del esquema, pruebas y benchmarks.

## Límites actuales

Esta capa implementa persistencia saliente local y contratos de transporte. No configura un servidor remoto, credenciales, sincronización incremental de descargas ni resolución automática de conflictos de edición entre escritores. Esas responsabilidades deben integrarse en el anfitrión y en el servicio remoto; no se declara sincronización multidispositivo completa solo por disponer de la outbox.
