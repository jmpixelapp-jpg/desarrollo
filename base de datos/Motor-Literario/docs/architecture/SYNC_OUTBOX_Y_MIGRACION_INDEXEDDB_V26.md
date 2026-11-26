# Bandeja durable de sincronización narrativa (IndexedDB DB26)

## Objetivo y alcance

DB26 incorpora una bandeja local de salida (`sync-outbox`) y un cursor monotónico por proyecto/dispositivo (`sync-device-sequences`). Cuando el anfitrión configura un `deviceId` estable, cada edición confirmada del editor se registra automáticamente como operación `document.change`. El delta del journal, la operación pendiente y el avance del cursor se confirman en una sola transacción IndexedDB. La bandeja conserva operaciones que un adaptador de transporte podrá enviar y retirar únicamente tras recibir un acuse remoto durable. Esto implementa persistencia de salida local, no un servidor ni sincronización multidispositivo completa.

## Migración segura

- Base: `motor-literario-local`.
- Migración: IndexedDB 25 → 26; no se rebaja ni recrea la base.
- `sync-outbox`: clave primaria `operationId`; índice por proyecto/fecha y restricción única por proyecto/dispositivo/secuencia.
- `sync-device-sequences`: clave compuesta `[projectId, deviceId]` y campo `lastSequence`.
- La creación de almacenes es condicional para tolerar ejecuciones repetidas de la rutina de upgrade y no elimina almacenes existentes.
- El manifiesto `storage_mapping_v0.4.2.json` mantiene los almacenes previos y declara la versión física 26.

## Contrato de operación

`SyncOperationDraft` identifica una operación antes de asignar la secuencia: `operationId`, `projectId`, `deviceId`, `kind`, payload JSON y fecha de creación. `IndexedDbProjectStore` asigna `sequence` de forma atómica al escribir. `StoredSyncOperation` añade ese cursor y los metadatos de reintento. El payload debe ser un objeto JSON válido y los campos tienen límites de tamaño y rango.

`enqueueSyncOperation` permite encolar operaciones ya numeradas. Para ediciones, `appendChangeAndEnqueueSyncOperation` realiza en una sola transacción:

1. verificar snapshot y continuidad del journal del documento;
2. leer el cursor global del proyecto/dispositivo dentro de la transacción `readwrite`;
3. crear la operación con la siguiente secuencia, insertar outbox y delta, y avanzar `lastSequence`;
4. abortar toda la transacción ante colisión de `operationId`, error de escritura o discontinuidad del journal.

El identificador de dispositivo debe ser único y estable por instalación. Las secuencias son globales para ese proyecto/dispositivo, incluso cuando las ediciones pertenecen a capítulos distintos.

`loadPendingSyncOperations` devuelve pendientes paginados por proyecto sin borrarlos. `recordSyncOperationAttempt` conserva contador, hora y código de error no sensible. `acknowledgeSyncOperation` retira únicamente la operación indicada; el cursor no retrocede, de modo que un acuse no permite reutilizar secuencias.

## Reglas del anfitrión/transporte

- El anfitrión debe asignar y persistir un `deviceId` estable por instalación (UUID aleatorio; no regenerarlo en cada sesión ni derivarlo de datos personales).
- Para ediciones del editor, el motor genera un `operationId` UUID y guarda el reemplazo de texto en el payload `document.change`; ese payload contiene contenido del manuscrito y debe tratarse como dato privado.
- El adaptador de transporte debe proteger el payload en tránsito y en el destino. Nunca debe incorporar contraseñas, tokens ni secretos.
- Debe reenviar el mismo registro pendiente en cada reintento, sin cambiar su ID, secuencia ni payload.
- Solo debe llamar a `acknowledgeSyncOperation` después de validar que el servidor confirmó la persistencia de esa misma operación.
- Si el resultado del envío es ambiguo, la operación permanece en la bandeja y se reintenta idempotentemente.

## Límites conocidos

La integración automática cubre las ediciones de texto confirmadas mediante IndexedDB y un `ProjectIdentity.deviceId`. Las mutaciones de fichas, relaciones, acontecimientos e ideas todavía no se registran automáticamente en la outbox. Tampoco están implementados autenticación/autorización remotas, endpoint de transporte, cursor de descarga, aplicación del diario remoto, reconciliación ni resolución de conflictos entre escritores. El adaptador SQLite usado por el puente entre procesos todavía no implementa esta operación atómica; no configurar `deviceId` en esa modalidad hasta que exista ese soporte. No se declara sincronización multidispositivo completa.

## Validación

El workflow `Motor Literario TypeScript` ejecuta TypeScript typecheck, build, validación del esquema y auditoría del mapeo físico, suite completa y benchmark. `indexeddb-sync-outbox.test.mjs` cubre la migración DB25→DB26, idempotencia, colisiones, aislamiento de secuencia, paginación, reintentos, validación del payload, acuses, atomicidad journal/outbox y conexión desde `HostEngineApi`.
