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

La operación devuelve un registro de auditoría con campo, valor anterior, valor nuevo, identidad sustituida y marca temporal. Este registro queda en manos del llamador para persistencia durable: esta función no presupone un almacén de auditoría que el contrato actual de `ProjectStore` todavía no define.


### Auditoría durable de reparaciones

El contrato `ProjectStore` incorpora `appendNarrativeReferenceRepairAudit` y `loadNarrativeReferenceRepairAudits`. IndexedDB almacena los registros en `narrative-reference-repair-audits`, aislados por proyecto y operación, con inserción append-only e idempotente. La base avanza a la versión 26; las bases existentes crean el almacén durante la migración sin alterar los registros previos.

La API pública de aplicación exige que el almacenamiento ofrezca auditoría durable antes de iniciar una reparación. Después del CAS del registro, añade la auditoría antes de devolver éxito. Si la escritura de auditoría falla tras el CAS, el llamador puede reintentar la misma propuesta: la aplicación reconoce el estado ya actualizado y completa el registro pendiente. La mutación del grafo y la escritura de auditoría son dos transacciones, no una transacción IndexedDB conjunta.


### Reparación vinculada al campo de referencia exacto

Los hallazgos de referencias cruzadas incluyen ahora `referenceField`: `fromEntityId`, `toEntityId`, `participants`, `entityId` o `relatedEntityIds`. Las propuestas conservan ese campo y la aplicación lo vuelve a validar antes del CAS. En relaciones se modifica exclusivamente el extremo indicado; el hecho de que la entidad candidata aparezca en el otro extremo no se considera replay. Las relaciones reflexivas pueden producir dos propuestas independientes, una por extremo. El identificador determinista de auditoría incorpora también el campo.
