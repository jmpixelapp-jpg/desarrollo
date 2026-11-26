# Contrato de transporte para sincronización narrativa

**Implementación:** `typescript/src/narrative-sync.ts`  
**Estado:** coordinador local implementado; adaptadores de almacenamiento y transporte aún deben integrarse  
**Formato:** TypeScript/JavaScript puro, sin dependencias de runtime

## Responsabilidades

`NarrativeSyncCoordinator` conecta dos puertos:

- `SyncOutboxPort`: lee operaciones pendientes, registra intentos y elimina una operación únicamente después de un acuse explícito.
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
8. Ante error de red o respuesta inválida, registra el intento y propaga el error. No confirma operaciones.

## Contrato de respuesta remota

- `acknowledgedOperationIds`: el servidor ha aceptado durablemente la operación y puede deduplicarla por `operationId`.
- `conflicts`: el servidor reconoce la operación, pero requiere reconciliación explícita; debe permanecer pendiente.
- `retryableOperationIds`: no se ha completado el procesamiento y puede reintentarse.

Una respuesta debe clasificar exactamente una vez cada operación enviada: no puede omitir IDs, clasificar dos veces el mismo ID ni incluir IDs que no fueron enviados. El servidor debe tratar `operationId` como clave de idempotencia para soportar reenvíos tras timeouts en los que el cliente no pudo conocer el resultado.

## Límites deliberados

Este módulo **no completa la sincronización multidispositivo**. Todavía faltan:

- Adaptador concreto del almacenamiento durable de la bandeja para la rama principal.
- Transporte remoto y contrato versionado de API.
- Autenticación y autorización por escritor/proyecto.
- Firma o verificación de integridad del lote y límites del payload en el servidor.
- Resolución interactiva de conflictos, con revisión de base y cambios concurrentes.
- Política de backoff, jitter, límites de frecuencia y reanudación.
- Pruebas de integración contra un servidor y pruebas entre dos dispositivos.

El anfitrión no debe borrar una operación por timeout, respuesta ambigua o conflicto. Solo un acuse explícito y validado permite retirarla.

## Pruebas añadidas

`tests/narrative-sync.test.mjs` cubre acuse selectivo, conservación de conflictos/reintentos, rechazo de IDs ajenos, respuestas parciales, coalescencia concurrente por proyecto, ejecución paralela entre proyectos, persistencia del intento ante fallo de transporte, aislamiento de proyecto y validación del tamaño de lote.

La existencia de estos tests acredita cobertura escrita, no ejecución satisfactoria. La validación requiere `npm run typecheck` y `npm test` desde `typescript/`.
