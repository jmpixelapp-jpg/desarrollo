# Diseño de reconciliación explícita de conflictos de sincronización

**Estado:** contrato de diseño; no implementado como operación de dominio  
**Alcance:** outbox local IndexedDB y coordinador de sincronización narrativa  
**Objetivo:** permitir que una persona decida cómo reconciliar una operación en conflicto sin perder la identidad, el historial ni el orden causal.

## 1. Problema actual

El coordinador clasifica los conflictos y conserva la operación original en `SYNC_OUTBOX`. Persiste el código/mensaje y programa un backoff. Cuando vence, puede volver a enviar exactamente la misma operación. Esto es recuperación de transporte, no resolución semántica: no cambia el payload, no rebasa revisiones y no elige entre versiones.

La bandeja usa `operationId` como clave primaria y un índice único por `(projectId, deviceId, sequence)`. La identidad inmutable incluye proyecto, dispositivo, secuencia, tipo, fecha de creación y payload normalizado. Los metadatos de reintento son mutables y no forman parte de esa identidad.

## 2. Decisiones e invariantes obligatorios

1. **Nunca reutilizar un `operationId` con contenido diferente.** Una edición, rebase o fusión crea una operación nueva.
2. **Nunca borrar una operación conflictiva por una decisión local no confirmada.** La operación original permanece recuperable hasta que exista un resultado remoto verificable o una transacción local de reconciliación definida.
3. **No confundir tiempo con resolución.** El vencimiento de `nextAttemptAt` solo habilita otro intento de transporte.
4. **Preservar causalidad por dispositivo.** Una operación sustitutiva debe recibir una secuencia nueva, asignada por la autoridad de secuenciación del escritor, y no puede adelantarse a una secuencia ya asignada.
5. **Vincular la sustitución con su origen.** El modelo futuro debe conservar `supersedesOperationId` y el identificador del conflicto que motivó la decisión, sin mutar la operación original.
6. **Proteger frente a concurrencia.** La decisión debe comprobar que el conflicto y la operación esperada siguen en el estado/versionado observado por la interfaz. Si cambiaron, se rechaza y se vuelve a leer; no se aplica una escritura basada en datos obsoletos.
7. **Persistir historial y outbox de forma atómica.** Crear el registro de reconciliación, insertar la operación nueva y actualizar/archivar el conflicto deben compartir una transacción IndexedDB. No se ha implementado todavía.
8. **El servidor conserva la autoridad remota.** Una decisión local no sustituye autenticación, autorización, validación de revisión base ni deduplicación remota.

## 3. Decisiones conceptuales

### Aceptar versión remota

No equivale a recibir un acuse cualquiera. Debe existir una respuesta de dominio autenticada que identifique proyecto, operación/conflicto, revisión remota aceptada y decisión aplicada. El cliente debe verificar que esa respuesta corresponde al conflicto vigente antes de retirar la operación original. El protocolo actual no define ese recibo ni su verificación; por tanto, no se expone aún una API `accept-remote`.

### Reemplazar localmente

Una edición o rebase manual produce un nuevo `operationId`, un payload nuevo, una secuencia posterior y una referencia a la operación conflictiva. La operación original no se sobrescribe. La política exacta para liberar la barrera causal del flujo debe formar parte de la transacción de reconciliación, no de un borrado improvisado.

### Fusión manual

La fusión se trata como una operación nueva, con procedencia explícita de sus entradas y revisión base. El motor no debe inventar una fusión automática ni declarar que dos versiones son compatibles sin evidencia de dominio.

## 4. Protección contra cambios concurrentes

La futura API de almacenamiento debe aceptar precondiciones observadas por el cliente, como mínimo:

- `projectId`, `conflictedOperationId`, `deviceId` y `sequence` esperados;
- huella/versionado del registro de conflicto observado;
- identidad completa de la operación nueva;
- token/versión de revisión remota cuando el protocolo de servidor lo defina.

Dentro de una única transacción `readwrite`, el almacén volverá a leer los registros y comparará las precondiciones. Cualquier discrepancia abortará la transacción sin retirar la operación ni insertar parcialmente la sustituta. La mera comparación de `operationId` no basta para detectar una resolución concurrente si no existe un registro de conflicto versionado.

## 5. Prueba de invariantes disponible

La regresión en `tests/indexeddb-sync-outbox.test.mjs` inserta una operación nueva con ID y secuencia distintos mientras la original conserva un conflicto. Comprueba que ambas permanecen en IndexedDB, que el payload original no cambia y que los metadatos de backoff no se pierden. Es una prueba de no sobrescritura e identidad, no una prueba de reconciliación atómica ni de resolución remota.

## 6. Trabajo pendiente antes de implementar la API

- Definir el modelo persistente de conflictos y su versionado.
- Localizar y formalizar la autoridad actual que asigna secuencias por dispositivo; no generar secuencias desde una vista o un cliente concurrente sin coordinación.
- Diseñar la transacción atómica de reconciliación y una estrategia de migración de IndexedDB compatible.
- Versionar el contrato del servidor para revisión base, recibos de aceptación remota y deduplicación.
- Añadir pruebas de dos escritores concurrentes, dos resoluciones simultáneas, rollback de transacción y recuperación tras cierre de pestaña.
- Ejecutar `npm run typecheck` y `npm test` en el paquete TypeScript y verificar CI.

**No se debe presentar la reconciliación como implementada hasta completar esos puntos.**


## 7. Hallazgo de implementación: secuencia asignada fuera de la bandeja

La inspección del almacenamiento actual confirma que `enqueueSyncOperation` **no asigna** secuencias: recibe una `StoredSyncOperation` ya numerada y la inserta. La bandeja valida la secuencia y el índice único `by-project-device-sequence` impide que dos operaciones del mismo proyecto/dispositivo ocupen el mismo número. No se encontró en el contrato público actual un asignador durable de secuencias por dispositivo.

Por ello, la unicidad del índice es una defensa de integridad, no una autoridad para generar el siguiente número. Un llamador no debe calcular `max(sequence) + 1` desde una lectura previa y asumir que es seguro entre pestañas: dos contextos pueden observar el mismo máximo. Antes de habilitar sustituciones automáticas se necesita un asignador transaccional compartido, con contador durable por `(projectId, deviceId)`, que reserve el siguiente número en la misma transacción que inserta la operación (o un mecanismo equivalente con exclusión/fencing verificable).

La nueva regresión crea dos instancias de `IndexedDbProjectStore` y trata de insertar concurrentemente dos operaciones distintas con la misma secuencia para el mismo dispositivo. Comprueba que el índice único deja persistir exactamente una. Esta prueba valida el rechazo de colisión; no implementa ni demuestra asignación automática, y no determina cuál pestaña debe ganar.

## 8. Siguiente decisión de arquitectura

No añadir un contador aislado ni inferir el siguiente número en la interfaz. Diseñar conjuntamente:
- almacén durable de contadores por proyecto/dispositivo;
- asignación e inserción atómicas, con rollback completo si la inserción falla;
- idempotencia de solicitudes de asignación ante reintentos;
- recuperación ante huecos de secuencia (permitidos o prohibidos, decisión explícita);
- pruebas concurrentes con dos conexiones y cierre/reapertura;
- migración compatible con IndexedDB v25 y datos existentes.

Hasta entonces, la reconciliación debe recibir una secuencia reservada por una autoridad externa confiable o permanecer deshabilitada.


## 9. Asignación atómica de secuencia implementada

Se incorpora `IndexedDbProjectStore.enqueueNextSyncOperation(draft)` y su contrato opcional en `ProjectStore`. El llamador entrega la operación sin `sequence`; el almacén:

1. abre una transacción `readwrite` sobre `SYNC_OUTBOX`;
2. comprueba primero si el `operationId` ya existe y, si su identidad inmutable coincide, devuelve la operación ya asignada (reintento idempotente);
3. consulta en orden inverso el índice único `by-project-device-sequence` para el mismo proyecto/dispositivo;
4. asigna `última secuencia + 1` (o 1 si no hay operaciones);
5. inserta la operación dentro de esa misma transacción.

Como las dos operaciones de lectura y escritura se realizan dentro de una transacción `readwrite` que abarca el mismo object store, IndexedDB serializa las transacciones competidoras entre conexiones. No se añade contador ni se incrementa la versión de base de datos: el índice existente es suficiente para calcular el siguiente valor bajo exclusión transaccional. El método rechaza el agotamiento del entero seguro y las colisiones de identidad. El encolado legado con secuencia explícita se conserva por compatibilidad; los nuevos escritores deben preferir el método asignador.

La regresión con dos instancias verifica que, partiendo de una operación legacy en secuencia 4, dos inserciones simultáneas obtienen 5 y 6, el reintento del mismo ID devuelve la misma secuencia y un payload diferente para ese ID se rechaza. La prueba está escrita pero requiere ejecutar build y suite para validar el artefacto compilado.

**Límite:** esto garantiza asignación local serializada dentro de una base IndexedDB compartida en el mismo origen. No coordina dispositivos físicos distintos ni sustituye secuencias asignadas por un servidor para un registro global.
