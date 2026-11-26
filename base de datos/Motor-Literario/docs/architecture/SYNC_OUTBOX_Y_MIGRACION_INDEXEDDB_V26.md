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

`loadPendingSyncOperations` devuelve pendientes paginados por proyecto, ordenados por dispositivo y secuencia, sin borrarlos. `recordSyncOperationAttempt` conserva contador, hora y código de error no sensible. `acknowledgeSyncOperation` retira únicamente la operación indicada; el cursor no retrocede, de modo que un acuse no permite reutilizar secuencias.

## Despacho saliente y acuses

`dispatchPendingNarrativeSyncOperations` conecta la outbox con el transporte que proporciona el anfitrión. Para cada registro:

1. convierte el payload JSON en una envoltura `NarrativeSyncOperationEnvelope` versionada;
2. calcula la huella SHA-256 del contenido canónico;
3. envía el mismo `operationId`, proyecto, stream de dispositivo y secuencia;
4. valida el acuse del servidor: `status` accepted/duplicate, `durable: true`, mismo proyecto, operationId, writerId, secuencia y digest;
5. registra el intento y elimina localmente solo la operación confirmada.

El `writerId` de la envoltura identifica aquí el stream de origen y coincide con `deviceId`, porque el cursor de secuencia es por instalación. No autentica a una persona. El transporte debe autenticar al anfitrión y el servidor debe verificar que el dispositivo está autorizado para el escritor/proyecto correspondiente. La huella SHA-256 detecta alteraciones; tampoco autentica al emisor.

La función no incorpora un cliente HTTP ni envía datos automáticamente: el anfitrión proporciona `transport.send`. Si el envío falla, el acuse no coincide o el resultado es ambiguo, el registro sigue pendiente y se reenvía con la misma identidad. La entrega es al menos una vez; el receptor debe deduplicar por `operationId` y digest.

La lectura de outbox usa el índice compuesto proyecto/dispositivo/secuencia, no el reloj del equipo, para mantener el orden FIFO incluso si `createdAt` coincide o el reloj retrocede. Los lotes se limitan y pueden drenarse en llamadas sucesivas.
## Reglas del anfitrión/transporte

- El anfitrión debe asignar y persistir un `deviceId` estable por instalación (UUID aleatorio; no regenerarlo en cada sesión ni derivarlo de datos personales).
- Para ediciones del editor, el motor genera un `operationId` UUID y guarda el reemplazo de texto en el payload `document.change`; ese payload contiene contenido del manuscrito y debe tratarse como dato privado.
- El adaptador de transporte debe proteger el payload en tránsito y en el destino. Nunca debe incorporar contraseñas, tokens ni secretos.
- Debe reenviar el mismo registro pendiente en cada reintento, sin cambiar su ID, secuencia ni payload.
- Solo debe llamar a `acknowledgeSyncOperation` después de validar que el servidor confirmó la persistencia de esa misma operación.
- Si el resultado del envío es ambiguo, la operación permanece en la bandeja y se reintenta idempotentemente.

## Límites conocidos

La integración automática de salida cubre las ediciones de texto confirmadas mediante IndexedDB y un `ProjectIdentity.deviceId`; el anfitrión debe proporcionar el transporte y autenticarlo. Las mutaciones de fichas, relaciones, acontecimientos e ideas todavía no se registran automáticamente en la outbox. `main` ya incluye el diario de recepción, el dispatcher y el consumidor genérico de operaciones entrantes; los handlers de aplicación deben ser idempotentes y coordinar sus escrituras con CAS/atomicidad. No existe aún un cliente HTTP predeterminado, cursor incremental de descarga por proyecto, reconciliación automática de snapshots ni resolución de conflictos entre escritores. El adaptador SQLite del puente entre procesos no implementa la escritura atómica de journal/outbox; no configurar `deviceId` en esa modalidad. No se declara sincronización multidispositivo completa.

## Validación

El workflow `Motor Literario TypeScript` ejecuta TypeScript typecheck, build, validación del esquema y auditoría del mapeo físico, suite completa y benchmark. `indexeddb-sync-outbox.test.mjs` cubre la migración DB25→DB26, idempotencia, colisiones, aislamiento de secuencia, paginación FIFO por dispositivo, reintentos, validación del payload, acuses, atomicidad journal/outbox, conexión desde `HostEngineApi` y despacho saliente con digest/acuse remoto.
