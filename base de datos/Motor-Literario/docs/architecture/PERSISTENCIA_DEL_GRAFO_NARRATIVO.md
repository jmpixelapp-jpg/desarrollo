# Persistencia del grafo de conocimiento narrativo

## API

`typescript/src/narrative-knowledge-graph-persistence.ts` exporta:

`persistNarrativeKnowledgeGraphSnapshot(store, snapshot)`

La función integra los snapshots incrementales con el contrato `ProjectStore` y exige las operaciones de lectura y escritura CAS para entidades, relaciones, acontecimientos, ideas y afirmaciones.

## Orden y concurrencia

La persistencia se ejecuta secuencialmente en este orden:
1. entidades;
2. relaciones;
3. acontecimientos;
4. ideas;
5. afirmaciones.

Cada escritura usa `save*IfUnchanged` con la versión previamente leída. Si otra pestaña modifica el registro entre lectura y escritura, la operación CAS debe rechazarla; el llamador puede reconstruir el snapshot desde el estado vigente y reintentar.

Antes de fusionar, la persistencia retira de cada registro la evidencia de los documentos incluidos en el snapshot entrante y la sustituye por la evidencia de sus revisiones actuales. La evidencia de documentos que no forman parte del snapshot se conserva. Esto evita acumular evidencia de revisiones anteriores para los documentos reenviados. Los registros sin cambios se omiten, haciendo idempotente la repetición de una misma proyección.

## Recuperación tras reinicio

El anfitrión puede recuperar los documentos con `ProjectStore.loadDocument` (y su propia lista de IDs documentales), reconstruir un snapshot mediante `createNarrativeKnowledgeGraphSnapshot` y volver a ejecutar esta persistencia. La proyección se deriva de los manuscritos; el snapshot incremental en memoria no se serializa como autoridad durable.

## Manifiestos documentales y tombstones (IndexedDB v25)

`ProjectStore` incorpora `loadNarrativeDocumentProjectionManifest` y `saveNarrativeDocumentProjectionManifestIfUnchanged`. `createNarrativeDocumentProjectionManifest(snapshot, documentId, generation, updatedAt)` construye el inventario desde la contribución individual del documento; `createNarrativeDocumentProjectionTombstone(...)` crea el registro de retirada con inventarios vacíos. `commitNarrativeDocumentProjectionManifest(store, candidate)` lee el manifiesto actual, asigna la siguiente generación y aplica reglas de monotonía: reintento idéntico en la misma revisión se reutiliza, revisiones antiguas y resultados divergentes para una misma revisión se rechazan. El adaptador IndexedDB guarda un manifiesto por `(projectId, documentId)` con revisión, generación monotónica, inventario de IDs por colección y estado `active`/`deleted`. La escritura se realiza en una transacción `readwrite` y compara la generación observada dentro de esa misma transacción; dos escritores que compiten por la misma generación no pueden confirmarse ambos. Un tombstone requiere inventarios vacíos y permanece como registro durable.

Este manifiesto establece un punto de recuperación y permite identificar qué registros derivan de cada documento. **No convierte todavía `persistNarrativeKnowledgeGraphSnapshot` en una operación atómica**: las cinco colecciones del grafo siguen guardándose secuencialmente y el manifiesto no se actualiza automáticamente desde esa función. El anfitrión debe coordinar ambas operaciones hasta que se implemente el reemplazo transaccional integral.

## Garantías y límites

- No hay transacción global para las cinco colecciones. Un error puede ocurrir después de guardar algunos registros; reintentar es seguro para las mismas entradas, pero no es una escritura atómica. La transacción CAS del manifiesto solo protege su propia generación.
- El contrato actual no expone borrado de entidades, relaciones, acontecimientos, ideas o afirmaciones. El tombstone registra la retirada documental, pero todavía no elimina sus contribuciones de las cinco colecciones.
- La fusión preserva evidencia cruzada, pero puede conservar evidencia obsoleta de revisiones anteriores. No se debe presentar el resultado persistido como una reconstrucción autoritativa: faltan tombstones, borrado seguro y reconciliación de afirmaciones.
- Las decisiones manuales sobre el estado de las ideas se conservan mediante `mergeNarrativeIdea`; la persistencia no sustituye decisiones editoriales.

La operación actual sigue siendo secuencial: si falla a mitad, puede quedar una proyección parcial hasta reintentar. La siguiente evolución necesaria es conectar los manifiestos con una operación de reemplazo por documento que actualice en una sola transacción el manifiesto y todas las colecciones afectadas.


### Enumeración de manifiestos documentales

`ProjectStore.loadNarrativeDocumentProjectionManifests(projectId)` permite recuperar el inventario completo de proyecciones de un libro, incluidos los tombstones. La implementación IndexedDB consulta el índice `by-project`, espera a que finalice la transacción de lectura y valida el aislamiento del proyecto, la identidad documental y la ausencia de duplicados. Esta lectura habilita la reconciliación tras reinicio y la detección de documentos retirados; por sí sola no elimina contribuciones ni sustituye la futura transacción atómica de reemplazo.


## Envolturas de operaciones de sincronización (SHA-256)

`narrative-sync-integrity.ts` añade `createNarrativeSyncOperationEnvelope` y `verifyNarrativeSyncOperationEnvelope`. Cada operación transporta versión de esquema, algoritmo, ID de operación, proyecto, escritor declarado, secuencia positiva, instante de creación, tipo, payload JSON y digest SHA-256 calculado sobre la representación canónica de todos los campos salvo el propio digest. La canonicalización mantiene orden de claves determinista, orden de arrays y límites de profundidad, nodos y bytes.

El digest se calcula mediante Web Crypto (`crypto.subtle`) y la creación falla explícitamente si SHA-256 no está disponible: no degrada silenciosamente a FNV. Las huellas FNV existentes siguen disponibles para comparaciones locales no criptográficas y no deben confundirse con este digest.

**Límite de seguridad:** SHA-256 sin clave detecta corrupción o modificaciones no acompañadas de un nuevo digest, pero no autentica al escritor: cualquier actor que pueda modificar el payload puede recalcular el digest. Tampoco evita replay ni garantiza orden global. El receptor debe autenticar y autorizar al escritor, persistir IDs de operación ya aplicados y validar secuencias por escritor/proyecto antes de aceptar efectos. La envoltura es un contrato de integridad de transporte, no un protocolo completo de replicación.


## Diario durable de recepción de operaciones

`IndexedDbNarrativeSyncJournal` usa una base IndexedDB separada (`motor-literario-sync-journal`) para no mezclar la recepción del transporte con las transacciones del grafo. Cada aceptación verifica primero el digest SHA-256 y, en una sola transacción `readwrite`, consulta `operationId` y el cursor `(projectId, writerId)`, inserta la operación y avanza la secuencia. La secuencia comienza en 1 y debe ser contigua; los huecos y operaciones antiguas se rechazan. Un `operationId` ya recibido con el mismo digest se trata como duplicado idempotente; el mismo ID con otro digest se rechaza. Los cursores se aíslan por proyecto y escritor y sobreviven al cierre/reapertura de la base local.

**Límite actual:** el diario confirma recepción ordenada, no aplicación al grafo. Aún no existe una transacción que combine el registro del sobre, la actualización de cursor y la mutación de entidades/relaciones/eventos/ideas/afirmaciones. El consumidor debe aplicar la operación mediante una fase posterior y recuperable; no debe asumir que `accepted` significa que el contenido narrativo ya fue aplicado. `writerId` es una declaración del sobre, no una identidad autenticada: el anfitrión debe vincularlo a una sesión autorizada antes de aceptar operaciones de red.

El diario expone `loadOperations(projectId, writerId?)` y `loadOperation(projectId, operationId)` para recuperar el contenido durable después de un reinicio. La enumeración se ordena por escritor y secuencia, y permite al consumidor reanudar el procesamiento. Estas lecturas no marcan operaciones como aplicadas ni alteran el cursor.


## Reproducción recuperable del diario (entrega al menos una vez)

El diario incorpora `loadPendingOperations`, `markApplied` y `replayPendingNarrativeSyncOperations`. El replay entrega las operaciones pendientes en orden por escritor/secuencia, ejecuta un callback de aplicación y marca cada entrada como aplicada únicamente después de que el callback finaliza. Si el callback falla, la entrada permanece pendiente y la reproducción se detiene para permitir reintento. La confirmación comprueba el digest esperado y es idempotente.

**Semántica y límites:** esto implementa entrega al menos una vez, no exactamente una vez. Si el proceso cae después de que el callback modifique el grafo y antes de guardar `appliedAt`, el callback volverá a recibir la operación. Por tanto, el callback debe ser idempotente y usar IDs de operación como clave de deduplicación en sus escrituras. El diario y las colecciones del grafo siguen en bases/transacciones distintas; `appliedAt` solo certifica que el callback terminó, no que exista atomicidad entre todas las proyecciones. La autenticación/autorización del escritor sigue fuera del diario.


El replay también vuelve a verificar el SHA-256 de cada entrada recuperada inmediatamente antes de invocar el callback. Si el registro almacenado fue alterado o quedó corrupto después de su recepción, no se entrega al consumidor, permanece pendiente y el resultado identifica `failure: "invalid-envelope"`. Los fallos del callback o del acuse se distinguen como `apply-or-ack-failed`.


### Exclusión de consumidores concurrentes en el mismo runtime

`replayPendingNarrativeSyncOperations` serializa llamadas simultáneas por proyecto dentro del mismo runtime JavaScript. Una segunda llamada concurrente devuelve `failure: "consumer-already-running"` sin ejecutar callbacks. El callback recibe la envoltura validada sin los metadatos locales del diario. Esta protección no coordina pestañas, workers ni dispositivos distintos; el anfitrión debe mantener un único consumidor por proyecto o aportar coordinación distribuida/lease con fencing antes de habilitar múltiples consumidores.
