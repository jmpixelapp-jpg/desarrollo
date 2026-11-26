# Handlers de dominio para sincronización narrativa

## Propósito

Los handlers conectan las envolturas verificadas del diario con el almacenamiento del dominio. El dispatcher no conoce las tablas MLDB y el diario no aplica cambios al proyecto; esta capa realiza la transición explícita entre ambos.

## Operaciones implementadas

| Tipo | Payload | Almacenamiento CAS |
|---|---|---|
| `idea-upsert` | `{ idea: NarrativeIdea }` | `loadIdeas` / `saveIdeaIfUnchanged` |
| `entity-upsert` | `{ entity: NarrativeEntity }` | `loadEntities` / `saveEntityIfUnchanged` |
| `assertion-upsert` | `{ assertion: NarrativeAssertion }` | `loadAssertions` / `saveAssertionIfUnchanged` |
| `relation-upsert` | `{ relation: NarrativeRelation }` | `loadRelations` / `saveRelationIfUnchanged` |
| `event-upsert` | `{ event: NarrativeEvent }` | `loadEvents` / `saveEventIfUnchanged` |
| `entity-merge` | `{ targetEntityId, sourceEntityId, writerId? }` | `mergeNarrativeEntityIdentity` (transacción atómica del store) |

Las fábricas públicas son `createNarrativeIdeaUpsertHandler`, `createNarrativeEntityUpsertHandler`, `createNarrativeAssertionUpsertHandler`, `createNarrativeRelationUpsertHandler`, `createNarrativeEventUpsertHandler` y `createNarrativeEntityMergeHandler`, en `typescript/src/narrative-sync-domain-handlers.ts`.

## Validación del dominio

Todos los handlers comprueban que el proyecto del registro coincide con el proyecto del sobre antes de escribir. Las validaciones limitan longitud y cardinalidad de campos, verifican IDs, y rechazan evidencia con revisiones o rangos UTF-16 inválidos.

Las entidades comprueban coherencia de nombre canónico normalizado, alias únicos, tiempos de primera/última aparición y versión de extracción. Este handler no fusiona identidades: la consolidación se procesa por `entity-merge`, que delega exclusivamente en la operación atómica del store para redirigir referencias y conservar snapshots archivados. El validador de `mergedFromIds` comprueba IDs como identificadores, no como nombres normalizados.

Las relaciones requieren evidencia no vacía. Los acontecimientos validan participantes únicos y referencias temporales explícitas. Una referencia `calendar` no puede usar precisión `day-index`; una referencia `story-day` debe usarla. Las afirmaciones validan atributo, valor, evidencia y la misma distinción temporal.

## Conflictos

Cada handler carga el registro actual del proyecto y ejecuta el método CAS con la versión observada como `expectedCurrent`. Si el registro cambia entre lectura y escritura, el store debe rechazar el CAS. El error detiene el replay y la operación permanece pendiente.

No se elige silenciosamente entre dos ediciones concurrentes ni se sobrescribe una versión no observada. El anfitrión debe presentar el conflicto para reconciliación editorial y, una vez resuelto, generar una operación nueva. No se debe editar el payload de una envoltura ya sellada: cualquier cambio invalida su digest.

## Entrega e idempotencia

El diario ofrece entrega al menos una vez. Cada handler trata como no-op una repetición cuyo registro persistido coincide exactamente, cubriendo la caída posterior a la escritura de dominio y anterior al acuse del diario.

Esta garantía es por registro. No convierte el diario y el almacén de dominio en una transacción única ni hace atómica una operación que afecte varias entidades.

## Concurrencia del replay

Los replays del mismo escritor/proyecto se serializan dentro del runtime. Escritores diferentes pueden reproducirse en paralelo porque mantienen cursores separados. Un replay de proyecto completo excluye los replays específicos de escritor. Los locks son locales al runtime; pestañas y dispositivos necesitan coordinación adicional y siguen dependiendo de CAS en el store.

## Alcance no implementado

- No existe todavía handler de `entity-upsert`.
- No hay resolución automática de conflictos ni fusión de ediciones de texto.
- No hay transporte remoto ni autorización por proyecto.
- El diario no autentica `writerId`; la identidad debe proceder de una sesión validada por el anfitrión/servidor.
- SHA-256 verifica integridad, no identidad del emisor.
- No hay exactamente-una-vez ni atomicidad distribuida entre diario y proyecciones.
- La reconciliación de tombstones y la eliminación segura de afirmaciones/documentos requieren un flujo específico; no se simulan mediante upserts.

## Pruebas

- `tests/narrative-sync-domain-handlers.test.mjs`: ideas, CAS, reintentos y conflictos.
- `tests/narrative-sync-entity-handler.test.mjs`: entidades, normalización canónica, CAS y reintentos.
- `tests/narrative-sync-entity-merge-handler.test.mjs`: delegación atómica, validación de IDs y soporte obligatorio del store.
- `tests/narrative-sync-assertion-handler.test.mjs`: afirmaciones, evidencia, referencias temporales y reintentos.
- `tests/narrative-sync-relation-event-handlers.test.mjs`: relaciones, acontecimientos y validación temporal.
- `tests/narrative-sync-writer-concurrency.test.mjs`: replay paralelo entre escritores y exclusión de replay completo.


## Manifiestos documentales y tombstones

`persistNarrativeKnowledgeGraphSnapshotWithManifests` coordina dos fases ordenadas: primero persiste el grafo con CAS por registro; después publica el manifiesto activo de cada documento con CAS por generación. El manifiesto nunca se adelanta a los registros. Si falla una publicación, el grafo parcial permanece reintentable y el manifiesto anterior continúa siendo la referencia durable.

`retireNarrativeDocumentProjection` publica un tombstone con inventarios vacíos y exige una revisión estrictamente posterior a la vigente. Repetir el mismo tombstone y revisión es idempotente; una retirada obsoleta se rechaza.

El tombstone no borra entidades ni afirmaciones del proyecto. Esos registros pueden tener evidencia compartida con otros documentos y su eliminación requiere reconciliación referencial y política explícita de retención. El manifiesto enumera contribuciones por documento; no autoriza por sí solo un borrado físico.


## Reconciliación de proyecciones tras reinicios

`reconcileNarrativeDocumentProjections(store, projectId)` compara los manifiestos durables con la evidencia real de entidades, relaciones, acontecimientos, ideas y afirmaciones. Informa de manifiestos ausentes, IDs omitidos o sobrantes en inventarios y tombstones que todavía conservan evidencia del documento.

La reconciliación es deliberadamente de sólo lectura. No infiere si una discrepancia debe resolverse restaurando un manifiesto, reextrayendo el documento o retirando evidencia; esa decisión depende del estado fuente y de la política editorial. El informe proporciona códigos, documento, tipo de registro e ID para que una capa de reparación aplique CAS explícito.


### Reparación limitada de inventarios activos

`repairNarrativeDocumentProjectionManifest(store, projectId, documentId)` reconstruye los cinco inventarios de un manifiesto **activo** usando exclusivamente la evidencia persistida. La actualización conserva la revisión documental, incrementa la generación y exige CAS sobre la generación previamente leída. Si el inventario ya coincide, devuelve un resultado idempotente sin escribir.

La operación no repara manifiestos ausentes (no hay revisión fuente confiable), no reactiva tombstones y no modifica entidades, relaciones, eventos, ideas, afirmaciones ni sus evidencias. Los tombstones con evidencia residual deben pasar por una decisión explícita de recuperación o retirada; no se resuelven automáticamente.


### Integridad de referencias cruzadas del grafo

La reconciliación también verifica referencias internas: extremos de relaciones, participantes de acontecimientos, entidad propietaria de afirmaciones y vínculos explícitos entre ideas y entidades/otras ideas. Los códigos `missing-relation-entity`, `missing-event-participant`, `missing-assertion-entity`, `missing-related-entity` y `missing-related-idea` identifican la clase de inconsistencia.

Cuando el registro no tiene evidencia documental, el diagnóstico usa `documentId: ""` para indicar alcance de proyecto y no atribuye el problema a un capítulo arbitrario. Estas incidencias no se reparan automáticamente: sin una fuente autoritativa no es seguro inventar, fusionar o reasignar identidades.


### Propuestas conservadoras de reparación de referencias

`proposeNarrativeReferenceRepairs(store, report)` transforma incidencias de referencias a entidades en propuestas no mutantes. Sólo propone un destino automático cuando exactamente una entidad del mismo proyecto declara el ID perdido dentro de `mergedFromIds`, evidencia explícita de una fusión anterior. Cero o varias coincidencias producen `manual-review`. Los enlaces a ideas no se resuelven por heurística. La función no guarda cambios ni sustituye la confirmación editorial.


### Aplicación aprobada de reparaciones

`applyNarrativeReferenceRepair(store, proposal, approved, appliedAt)` aplica una propuesta de entidad sólo tras aprobación explícita. Revalida que el ID perdido siga documentado en `mergedFromIds` de una única identidad destino, vuelve a leer el registro y usa el método CAS específico de relaciones, acontecimientos, afirmaciones o ideas. Una repetición reconocible es idempotente; una referencia que cambió de forma incompatible se rechaza.

La función exige persistencia durable de auditoría e intención pendiente. Guarda la intención antes del CAS, confirma la auditoría append-only después del CAS y elimina la intención al final. Si falla cualquier frontera, la operación puede reanudarse mediante `recoverNarrativeReferenceRepairs(store, projectId)`; los conflictos permanecen pendientes para revisión.


### Auditoría durable de reparaciones

El contrato `ProjectStore` incorpora `appendNarrativeReferenceRepairAudit` y `loadNarrativeReferenceRepairAudits`. IndexedDB almacena los registros en `narrative-reference-repair-audits`, aislados por proyecto y operación, con inserción append-only e idempotente. La base avanzó a la versión 26 para la auditoría y a la versión 27 para las intenciones pendientes; las bases existentes crean ambos almacenes durante sus migraciones sin alterar los registros previos.

La API pública de aplicación exige que el almacenamiento ofrezca auditoría durable antes de iniciar una reparación. Después del CAS del registro, añade la auditoría antes de devolver éxito. Si la escritura de auditoría falla tras el CAS, el llamador puede reintentar la misma propuesta: la aplicación reconoce el estado ya actualizado y completa el registro pendiente. La mutación del grafo y la escritura de auditoría son dos transacciones, no una transacción IndexedDB conjunta.


### Reparación vinculada al campo de referencia exacto

Los hallazgos de referencias cruzadas incluyen ahora `referenceField`: `fromEntityId`, `toEntityId`, `participants`, `entityId` o `relatedEntityIds`. Las propuestas conservan ese campo y la aplicación lo vuelve a validar antes del CAS. En relaciones se modifica exclusivamente el extremo indicado; el hecho de que la entidad candidata aparezca en el otro extremo no se considera replay. Las relaciones reflexivas pueden producir dos propuestas independientes, una por extremo. El identificador determinista de auditoría incorpora también el campo.


### Verificación de integridad del historial de reparaciones

`verifyNarrativeReferenceRepairAuditIntegrity(store, projectId)` revisa las entradas persistidas, valida su estructura, la correspondencia entre `operationId` y los campos de la operación, y la coherencia de los valores `before`/`after`. También contrasta cada reparación con el estado actual de la ficha. Un registro ausente o modificado después se informa como estado histórico distinto, no como corrupción automática: la integridad del evento y el estado vivo son dimensiones separadas. La escritura IndexedDB aplica las mismas invariantes antes de insertar una entrada.


### Recuperación de reparaciones interrumpidas

La reparación aprobada se registra primero en `narrative-reference-repair-pending`, con identidad determinista de operación y propuesta suficiente para revalidar la correspondencia de fusión. Después se ejecuta el CAS del registro, se inserta la auditoría append-only y finalmente se elimina la intención. La secuencia no es una transacción única, pero cada frontera deja un estado recuperable: si falla el CAS, la intención permite reintentar; si falla la auditoría, el replay reconoce que el campo ya contiene la candidata y completa la auditoría; si falla el borrado, la auditoría idempotente evita duplicados.

`recoverNarrativeReferenceRepairs(store, projectId)` procesa las intenciones pendientes, vuelve a validar identidad y CAS, y conserva los conflictos como pendientes con su error para revisión. La migración IndexedDB crea el almacén `narrative-reference-repair-pending` (versión 27). La intención se conserva hasta que la auditoría durable queda confirmada.


### Integración con el ciclo de carga del proyecto

`loadNarrativeProjectAfterRepairRecovery(store, projectId, loadProject)` ofrece el punto de entrada para la hidratación del proyecto: primero inspecciona y recupera la cola durable; sólo después ejecuta el callback de carga/hidratación. Si no puede inspeccionar IndexedDB, rechaza la operación y no entrega un proyecto parcialmente inicializado. Los conflictos de reparación no fuerzan escrituras ni impiden consultar el proyecto: quedan en `recovery.pending` para que la interfaz los presente como incidencias revisables.

El anfitrión debe utilizar esta función en su límite de apertura/selección de proyecto en lugar de invocar directamente su hidratador. La biblioteca no contiene un arranque global de aplicación que permita imponer esa sustitución desde el motor; por ello, la función constituye el contrato público de integración, no una afirmación de que todas las aplicaciones consumidoras ya lo estén invocando.


### Sincronización entrante protegida por recuperación

`createRecoveryFirstNarrativeSyncConsumer(store, journal, handlers, options)` compone la recuperación de referencias con el consumidor del diario de sincronización. Para cada proyecto, procesa primero las intenciones locales pendientes y sólo inicia el replay remoto si la cola queda sin conflictos. Cuando hay una intención inválida u obsoleta, devuelve `blockedByPendingRepairs: true`, conserva las operaciones remotas sin aplicar y expone el detalle en `recovery.pending`; el anfitrión puede presentar el conflicto y reintentar tras su resolución.

Esta compuerta no convierte el diario y el grafo en una transacción distribuida ni sustituye la idempotencia de los handlers. El diario mantiene entrega al menos una vez y la exclusión de replay no debe interpretarse como un mutex global entre pestañas o dispositivos. La garantía añadida es de orden dentro de este punto de entrada: recuperación durable antes de despacho remoto.


### Concurrencia de recuperación por proyecto

Las llamadas concurrentes a `recoverNarrativeReferenceRepairs` para el mismo proyecto dentro de un mismo runtime comparten una única promesa. Así, dos consumidores locales no leen y procesan simultáneamente la misma cola ni compiten innecesariamente por el CAS de una misma intención. La coordinación se libera tanto si la recuperación termina correctamente como si falla, permitiendo reintentos posteriores.

El bloqueo es deliberadamente local al runtime: no coordina pestañas, procesos ni dispositivos. La persistencia IndexedDB conserva la protección CAS para escrituras concurrentes externas; un conflicto entre contextos puede quedar pendiente y requerir un nuevo intento.


### Inspección previa de conflictos pendientes

`inspectNarrativeReferenceRepairPending(store, projectId)` ofrece un diagnóstico de solo lectura de cada intención durable. Clasifica las entradas como `ready-to-recover`, `already-applied`, `record-missing`, `record-changed`, `replacement-not-proven` o `invalid-intent`. Contrasta el registro actual y la procedencia `mergedFromIds` de la entidad sustituta. No modifica el grafo, no escribe auditorías y no elimina intenciones; la resolución sigue siendo una acción explícita del flujo de recuperación o del anfitrión.


### Verificación de durabilidad entre instancias IndexedDB

Se añadieron pruebas con dos instancias independientes de `IndexedDbProjectStore` sobre la misma base de datos. Ambas intentan guardar la misma intención y la misma auditoría; el resultado esperado es una única entrada durable e idéntica al leer desde cualquiera de las instancias. También se prueba la eliminación idempotente concurrente de la intención.

Estas pruebas verifican coordinación a través de la transacción compartida de IndexedDB para las operaciones cubiertas; no prueban un bloqueo global del proceso de recuperación ni sustituyen los CAS de cada registro narrativo.


### Exclusión de recuperación entre pestañas

La entrada pública de recuperación usa Web Locks API cuando está disponible. Solicita un bloqueo exclusivo con nombre determinista por proyecto (`motor-literario:narrative-reference-repair:<projectId>`) y mantiene dentro del bloqueo la lectura de intenciones, revalidación, CAS, auditoría y eliminación de cada intención. Así, pestañas del mismo origen que compartan el gestor Web Locks no ejecutan simultáneamente el replay de un mismo proyecto.

La API Web Locks es una mejora de coordinación, no un requisito para la persistencia: si el entorno no la expone, se conserva la serialización dentro del runtime y el CAS por registro. En ese fallback no se afirma exclusión entre pestañas. Si el gestor existe pero rechaza la solicitud, el error se propaga; no se degrada silenciosamente a una recuperación sin bloqueo.
