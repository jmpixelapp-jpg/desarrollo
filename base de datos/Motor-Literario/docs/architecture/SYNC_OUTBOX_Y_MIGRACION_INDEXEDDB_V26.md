# Bandeja durable de sincronización narrativa (IndexedDB DB26)

## Objetivo y alcance

DB26 incorpora una bandeja local de salida (`sync-outbox`) y un cursor monotónico por proyecto/dispositivo (`sync-device-sequences`). Su función es conservar operaciones que un adaptador de transporte podrá enviar y retirar únicamente tras recibir un acuse remoto durable. Esta entrega mejora la persistencia local y prepara la sincronización; **no implementa por sí sola un servidor ni sincronización multidispositivo completa**.

## Migración segura

- Base: `motor-literario-local`.
- Migración: IndexedDB 25 → 26; no se rebaja ni recrea la base.
- `sync-outbox`: clave primaria `operationId`; índice por proyecto/fecha y restricción única por proyecto/dispositivo/secuencia.
- `sync-device-sequences`: clave compuesta `[projectId, deviceId]` y campo `lastSequence`.
- La creación de almacenes es condicional para tolerar ejecuciones repetidas de la rutina de upgrade y no elimina almacenes existentes.
- El manifiesto `storage_mapping_v0.4.2.json` mantiene los almacenes previos y declara la versión física 26.

## Contrato de operación

`StoredSyncOperation` identifica una operación con `operationId`, `projectId`, `deviceId`, `sequence`, tipo `kind`, payload JSON, fecha de creación y metadatos de reintento. El payload no puede ser texto JSON inválido ni un array/valor escalar; los campos tienen límites de tamaño y rango.

`enqueueSyncOperation` realiza en una sola transacción:

1. comprobar si `operationId` ya existe;
2. aceptar como idempotente solo el mismo contenido e identidad;
3. rechazar colisiones de ID y secuencias ausentes, antiguas o fuera de orden;
4. insertar la operación y avanzar `lastSequence` juntos.

`loadPendingSyncOperations` devuelve pendientes paginados por proyecto sin borrarlos. `recordSyncOperationAttempt` conserva contador, hora y código de error no sensible. `acknowledgeSyncOperation` retira únicamente la operación indicada; el cursor no retrocede, de modo que un acuse no permite reutilizar secuencias.

## Reglas del anfitrión/transporte

- El anfitrión debe asignar un `deviceId` estable por instalación y generar `operationId` único antes del primer intento.
- Debe serializar el payload de forma determinista y no incluir contraseñas, tokens, secretos ni texto no necesario.
- Debe enviar la misma operación en cada reintento, sin cambiar su ID, secuencia ni payload.
- Solo debe llamar a `acknowledgeSyncOperation` después de validar que el servidor confirmó la persistencia de esa misma operación.
- Si el resultado del envío es ambiguo, la operación permanece en la bandeja y se reintenta idempotentemente.

## Límites conocidos

Esta fase no conecta todavía todas las mutaciones de manuscritos, fichas, relaciones, acontecimientos e ideas con `enqueueSyncOperation`. Tampoco define autenticación remota, autorización por proyecto, endpoint HTTP, cursor de descarga, aplicación del diario remoto, reconciliación ni resolución de conflictos entre escritores. No debe presentarse como sincronización de dos dispositivos terminada hasta incorporar y probar esas capas.

## Validación

El workflow `Motor Literario TypeScript` ejecuta TypeScript typecheck, build, validación del esquema y auditoría del mapeo físico, suite completa y benchmark. El test `indexeddb-sync-outbox.test.mjs` cubre la migración DB25→DB26, idempotencia, colisiones, aislamiento de secuencia, paginación, reintentos, validación del payload y acuse sin reutilización del cursor.
