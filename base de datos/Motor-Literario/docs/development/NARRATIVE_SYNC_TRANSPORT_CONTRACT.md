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
