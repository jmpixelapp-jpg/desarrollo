# Registro de progreso: análisis literario e inteligencia narrativa

**Ámbito:** `base de datos/Motor-Literario`  
**Runtime:** TypeScript / JavaScript puro.  
**Rama de integración:** `main`.  
**Última actualización:** 26 de noviembre de 2026.

## 1. Entregas de esta tanda

### Integridad de sincronización

- `typescript/src/narrative-sync-integrity.ts`: canonicalización determinista de payloads JSON, huella FNV-1a de 64 bits y comparación por representación canónica.
- Límites de profundidad, nodos y bytes UTF-8.
- Rechazo de ciclos, getters, símbolos, prototipos personalizados, valores no JSON, arrays dispersos y propiedades adicionales.
- Exportación pública desde `src/index.ts`.
- Regresiones en `tests/narrative-sync-integrity.test.mjs`.

**Límite:** FNV-1a sirve para consistencia y comparación, no es una firma criptográfica ni sustituye la autenticación.

### Afirmaciones narrativas con evidencia

- `typescript/src/narrative-history.ts`: extracción conservadora de edad, ubicación y rol a partir de patrones explícitos en español.
- Reconocimiento de nombre canónico y aliases, limitado a entidades de tipo personaje.
- Conservación de proyecto, entidad, documento, revisión, offsets UTF-16, fragmento de evidencia y timestamp.
- Referencias temporales explícitas de calendario y día narrativo, validadas antes de convertirse en valores ordinales.
- Regresiones en `tests/narrative-assertions.test.mjs`.

**Límite:** el extractor es lexical y heurístico. No resuelve paráfrasis, pronombres, negación compleja ni contradicciones semánticas generales. Los resultados son observaciones revisables, no hechos canónicos automáticos.

### Estabilidad del monitor y persistencia local

- Reparación de la comparación de generaciones del lease.
- Seguimiento de revalidaciones concurrentes al volver de suspensión.
- Corrección de acumuladores de métricas y tipado estricto.
- Selector de tarjetas de documento separado de los elementos accesibles de métricas.
- Bundle de prueba aislado del monitor incorporado al pipeline completo.

## 2. Documentación técnica

- [Análisis de afirmaciones narrativas](../architecture/ANALISIS_DE_AFIRMACIONES_NARRATIVAS.md).
- [Integridad de payloads y sincronización narrativa](../architecture/INTEGRIDAD_DE_PAYLOADS_Y_SINCRONIZACION_NARRATIVA.md).
- [Registro del monitor de autor](LIVE_AUTHOR_MONITOR_PROGRESS.md).

## 3. Validación observada

- **Motor Literario TypeScript:** [run 45746700879](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45746700879), commit `71d6144c820512ce5989be17d03e6cdc88d6ccdb`: typecheck, build, suite completa y benchmark aprobados.
- **Live Author Monitor:** [run 45746701123](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45746701123), mismo commit: bundle aislado, regresiones, esquema MLDB, build, suite del monitor y benchmark de memoria aprobados.
- **Motor Literario TypeScript:** [run 45746807836](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45746807836), commit `7a75e0e38353ab01041bd5e3773e4f0fc5ea9c23`: typecheck, build, suite automatizada y benchmark aprobados después de actualizar el entrypoint del bundle aislado.

Los documentos añadidos después de estas ejecuciones no modifican código ejecutable. Cualquier cambio posterior de runtime requiere su propia validación CI.

## 4. Estado que no debe sobredeclararse

La canonicalización y las pruebas locales de bandeja no equivalen a sincronización remota. La sincronización multidispositivo todavía necesita transporte remoto, autenticación/autorización, API versionada, idempotencia de servidor, política de reintentos y reconciliación interactiva de conflictos. El PR #56 continúa separado y no se considera fusionado por este registro.


## 5. Consistencia temporal de afirmaciones

- Nuevo módulo `typescript/src/narrative-consistency.ts`, exportado desde el índice público.
- `analyzeNarrativeConsistency` compara valores distintos del mismo atributo y entidad dentro de un proyecto.
- Distingue conflicto en el mismo instante, evolución entre referencias ordenables y tiempo no comparable.
- Ignora evidencia obsoleta y preserva las dos evidencias junto con una explicación.
- Pruebas en `tests/narrative-consistency.test.mjs` para fechas, día narrativo, precisión, aislamiento y validación.
- Contrato detallado: [Consistencia temporal de afirmaciones](../architecture/CONSISTENCIA_TEMPORAL_DE_AFIRMACIONES.md).

**Límite:** los conflictos son candidatos para revisión humana; el motor no decide qué versión es verdadera. La comparación por pares es cuadrática por grupo entidad/atributo. Este módulo tampoco completa sincronización remota multidispositivo.


## 6. Grafo unificado de conocimiento narrativo

- Nuevo `typescript/src/narrative-knowledge-graph.ts` y exportación pública `buildNarrativeKnowledgeGraph`.
- Compone entidades, relaciones, acontecimientos, ideas, afirmaciones y hallazgos de consistencia en una vista por proyecto.
- Consolida evidencias de entidades repetidas, ordena las salidas y rechaza revisiones documentales duplicadas.
- Conserva offsets UTF-16 absolutos cuando se procesan ventanas mediante `baseOffset`.
- El reloj de extracción se fija una sola vez por construcción y se comparte con las ideas, haciendo reproducibles las marcas temporales si se proporciona `options.now`.
- Pruebas: `tests/narrative-knowledge-graph.test.mjs`.
- Arquitectura: [Grafo unificado de conocimiento narrativo](../architecture/GRAFO_CONOCIMIENTO_NARRATIVO.md).

**Límite operativo:** es una proyección en memoria y no persiste ni sincroniza. El llamador debe seleccionar las revisiones documentales que desea analizar; no se decide automáticamente cuál es la versión canónica.


## 7. Snapshots incrementales del grafo

- Nuevo módulo `typescript/src/narrative-knowledge-graph-incremental.ts`.
- API pública para crear snapshots por documento y actualizarlos reutilizando contribuciones no modificadas.
- La invalidación compara ID, revisión, texto y offset base; cambios en el nombre de proyecto de origen invalidan el extractor de ideas.
- Los documentos retirados desaparecen del grafo agregado y se informan separadamente.
- Se recalculan los hallazgos de consistencia sobre el conjunto completo de afirmaciones después de combinar contribuciones.
- Pruebas: `tests/narrative-knowledge-graph-incremental.test.mjs`.
- Contrato y límites: [Actualización incremental del grafo narrativo](../architecture/GRAFO_CONOCIMIENTO_NARRATIVO_INCREMENTAL.md).

**Límite:** el snapshot retiene texto en memoria y no se persiste ni transmite. La extracción se limita a documentos invalidados, pero la agregación y la consistencia global siguen recorriendo el snapshot completo.


## 8. Integración inicial con persistencia

- Nuevo módulo `typescript/src/narrative-knowledge-graph-persistence.ts`.
- API `persistNarrativeKnowledgeGraphSnapshot(store, snapshot)` que integra el snapshot incremental con `ProjectStore`.
- Exige lecturas y escrituras compare-and-swap para las cinco colecciones; ordena dependencias guardando entidades antes de relaciones, eventos e ideas.
- Conserva evidencias cruzadas mediante las funciones de fusión del dominio y evita escrituras idénticas.
- Las operaciones son secuenciales e idempotentes ante reintento, pero no constituyen una transacción global.
- Pruebas: `tests/narrative-knowledge-graph-persistence.test.mjs`.
- Contrato: [Persistencia del grafo narrativo](../architecture/PERSISTENCIA_DEL_GRAFO_NARRATIVO.md).

**Limitación crítica documentada:** el contrato actual no ofrece borrado ni reemplazo transaccional por documento. La persistencia inicial puede conservar evidencias antiguas tras una revisión y no elimina registros que desaparecen del análisis. No se afirma reconciliación completa hasta implementar tombstones y reemplazo atómico por documento.


## 9. Reconciliación de evidencia por revisión documental

- La persistencia ahora retira las evidencias previas de cada documento incluido en el snapshot entrante y las reemplaza por las de la revisión actual.
- La reconciliación se aplica a entidades, relaciones, acontecimientos, ideas y afirmaciones, usando CAS para cada escritura.
- La evidencia de documentos no incluidos en el snapshot se conserva.
- Si una entidad deja de aparecer en el texto revisado, se elimina su evidencia de ese documento; el registro sin evidencia se conserva porque el contrato no permite borrado seguro.
- Pruebas de regresión para revisión actualizada, evidencia de otro documento y repetición idempotente.

**Límites vigentes:** la persistencia continúa siendo secuencial, no atómica entre colecciones. Los documentos retirados del proyecto deben declararse explícitamente; omitirlos del snapshot no autoriza su eliminación. La siguiente fase debe incorporar manifiestos de documentos, tombstones y reemplazo transaccional.

### Ajuste de alcance de reconciliación

- Corregido el acceso al ID documental desde `snapshot.documents[].input.documentId` según el contrato real del snapshot incremental.
- Las afirmaciones narrativas contienen una única evidencia (`TextEvidence`), no una lista. La persistencia actualiza afirmaciones entrantes por CAS, pero conserva las antiguas que no aparecen en el snapshot; no se declara reconciliación de afirmaciones hasta disponer de tombstones/borrado transaccional.
- La reconciliación de evidencias por colección queda limitada a entidades, relaciones, acontecimientos e ideas.

## 10. Manifiestos durables de proyección documental

- Añadido `NarrativeDocumentProjectionManifest` al contrato `ProjectStore`: proyecto/documento, revisión, generación CAS, estado activo/eliminado e inventarios de IDs por colección.
- IndexedDB sube a versión 25 y crea `narrative-document-projection-manifests`, indexado por proyecto.
- Lectura aislada por proyecto/documento y escritura `readwrite` con comparación de generación dentro de la transacción. Dos escritores que compiten por la misma generación no pueden confirmar ambos.
- Tombstones persistentes con inventarios vacíos; validación de IDs duplicados, generaciones y estados.
- Actualizado el mapa físico MLDB y agregadas pruebas de CAS, aislamiento, tombstone y concurrencia.

**Alcance real:** el manifiesto es durable y su propia escritura es atómica, pero aún no coordina automáticamente las cinco colecciones del grafo. No se afirma reemplazo transaccional integral ni borrado de proyecciones; ese es el siguiente bloque.

- Añadidas funciones puras para construir manifiestos a partir de la contribución de un documento y generar tombstones explícitos; pruebas cubren sus inventarios y validación de documento ausente.

- Registrada la tabla lógica `narrative_document_projection_manifests` en el esquema declarativo MLDB 0.4.2; se detectó y resolvió el requisito del validador de no declarar tablas físicas fuera del esquema lógico.

- Añadido `commitNarrativeDocumentProjectionManifest`: coordina lectura y escritura CAS, asigna generación, hace idempotentes los reintentos de una misma revisión y rechaza revisiones obsoletas o manifiestos divergentes para una revisión ya confirmada. Se añadieron pruebas específicas de estas reglas.

- Corrección posterior a CI: se actualizaron las expectativas de versión IndexedDB 25 y de las 27 tablas declarativas MLDB. En la reconciliación del grafo se elimina cada ID de la colección entrante al encontrar su registro actual, incluso si la fusión no produce cambios; así se evita volver a insertar con CAS vacío una entidad ya existente durante reintentos idempotentes. Se aclaró el error de generación como conflicto CAS.

- CI (run 45749401711) confirmó que el primer fallo restante era una expectativa incompleta del esquema en `core.test.mjs`: faltaba declarar en el arreglo esperado el object store `narrative-document-projection-manifests` y su índice `by-project`. Se incorporaron ambos al test para que valide el esquema real v25, en lugar de omitir el nuevo almacén. La ejecución previa también confirmó que el chequeo de tipos terminaba correctamente; la suite contabilizó 554 pruebas aprobadas y una falla raíz de esquema, con las posteriores canceladas por esa falla.

- Segunda revisión de CI (run 45749542630): el esquema nuevo ya pasaba la prueba de creación, pero el fixture de migración que repara índices en una base anterior simulaba el almacén de manifiestos como inexistente y mantenía la versión esperada 24. Se actualizó el fixture a v25 y se añadió el almacén y su índice a la lista simulada; de lo contrario, la migración intentaba crear un almacén en un mock que no implementa `createObjectStore`, provocando cancelación en cascada de 235 pruebas. La corrección está en `1b2a1be`.

- CI run 45749712740: la reparación del fixture anterior quedó validada (prueba 82 pasa). La siguiente prueba de migración usaba un segundo mock de base antigua con el mismo inventario incompleto de almacenes; la migración intentaba crear el object store de manifiestos y el mock no ofrecía `createObjectStore`. Se añadió el almacén a ese fixture también. Corrección en `2328681`.

- CI run 45749835622 sobre el commit `2328681` completó correctamente: type-check, build, 790/790 pruebas automatizadas (0 fallos, 0 canceladas) y benchmark de edición en vivo finalizaron con éxito. La ejecución anterior `45749799142` falló porque se ejecutó antes de la corrección del segundo fixture; no representa el estado de `2328681`.

- Nueva capa de integridad de transporte: `createNarrativeSyncOperationEnvelope` y `verifyNarrativeSyncOperationEnvelope` generan/verifican sobres versionados con SHA-256 Web Crypto sobre payloads JSON canónicos; incluyen `operationId`, `projectId`, `writerId`, secuencia, fecha y tipo. Se añadieron pruebas de alteración de payload/metadatos, versión/algoritmo, secuencia inválida y del límite explícito entre integridad y autenticación. La huella FNV anterior se conserva solo como comparación local no criptográfica.
- Límite documentado: el digest SHA-256 sin clave no autentica escritores, no evita replay y no implementa por sí solo sincronización distribuida. Quedan pendientes autenticación/autorización del receptor, deduplicación durable de `operationId`, secuencias por escritor y aplicación transaccional de operaciones.

- Implementado `IndexedDbNarrativeSyncJournal` en una base IndexedDB separada. La recepción verifica SHA-256 y registra sobre + cursor de escritor en una única transacción local; exige secuencias contiguas desde 1, deduplica `operationId` con digest idéntico, rechaza colisiones, huecos y replay, y mantiene aislamiento por proyecto/escritor. Añadidas pruebas de persistencia tras reapertura, deduplicación, rechazos y aislamiento.
- Límite: el diario hace durable la recepción, pero todavía no aplica operaciones al grafo ni comparte transacción con las colecciones narrativas. El estado `accepted` significa registrado en el diario, no aplicado al manuscrito/grafo. La autenticación de `writerId` sigue siendo responsabilidad del anfitrión.

- Ampliado el diario con recuperación explícita (`loadOperations` y `loadOperation`), ordenación de operaciones por escritor/secuencia y pruebas de lectura tras reapertura. Añadida además una prueba de admisión concurrente para confirmar que dos operaciones distintas no pueden ocupar la misma secuencia del mismo escritor.

- Añadido replay recuperable del diario: `loadPendingOperations`, confirmación `markApplied` ligada al digest y `replayPendingNarrativeSyncOperations`. El consumidor procesa operaciones secuencialmente, confirma tras éxito y deja pendiente la operación fallida para reintento. Se documenta explícitamente entrega al menos una vez y el requisito de callback idempotente ante caídas entre la mutación y la confirmación.

- Añadida prueba de ventana de caída: el callback puede ejecutar un efecto externo y fallar antes del acuse; el diario conserva la operación pendiente y la vuelve a entregar. La prueba demuestra por qué el consumidor debe deduplicar efectos mediante `operationId` y no asumir exactamente-una-vez.

- Endurecido el replay: verifica nuevamente el SHA-256 desde el registro recuperado antes de ejecutar el callback. Una entrada alterada no se entrega al consumidor, queda pendiente y se informa `invalid-envelope`; fallos de aplicación/acuse se distinguen por separado. Añadida prueba de manipulación del payload persistido.

- Ajuste de verificación del replay: al recalcular SHA-256 se reconstruye la envoltura original y se excluyen los metadatos locales `receivedAt` y `appliedAt`, que no forman parte del contenido firmado por digest. Esto evita falsos rechazos de entradas válidas almacenadas en el diario.

- La verificación de replay normaliza el payload recuperado de IndexedDB al subconjunto JSON antes de recalcular el digest, excluyendo los metadatos locales. Si el payload persistido no puede normalizarse, la operación se conserva pendiente y se informa como envoltura inválida.

- El replay serializa consumidores simultáneos del mismo proyecto dentro del runtime y devuelve `consumer-already-running` al segundo intento. El callback recibe solo la envoltura verificada, sin `receivedAt`/`appliedAt`. La exclusión es local al runtime; no constituye coordinación entre pestañas o dispositivos.

## Continuación: despacho explícito de operaciones (2026-11-25)

Se añadió `narrative-sync-dispatcher.ts` y su exportación pública. El dispatcher
usa una lista cerrada de handlers por `kind`, exige un validador de payload y
solo invoca la aplicación cuando el contrato se cumple. Rechaza tipos sin
handler, handlers duplicados y payloads inválidos; permite auditar el motivo
del rechazo sin volcar el contenido narrativo.

Se añadieron pruebas para ejecución válida, kind desconocido, payload inválido,
handler duplicado y validador que lanza. La arquitectura documenta que este
componente no autentica ni persiste: se conecta al diario verificado y cada
handler debe ser idempotente por `operationId`. La mutación concreta del grafo
aún requiere handlers de dominio y coordinación transaccional; no se presenta
como sincronización automática ni exactamente-una-vez.


## Continuación: consumidor integrado del diario durable (2026-11-26)

Se añadió `typescript/src/narrative-sync-consumer.ts` y su exportación pública.

- `createNarrativeSyncJournalConsumer` conecta `IndexedDbNarrativeSyncJournal`, `replayPendingNarrativeSyncOperations` y `createNarrativeSyncOperationDispatcher`.
- La entrada pasa por la verificación de integridad del diario; el dispatcher aplica únicamente handlers registrados cuyo validador acepte el payload.
- El acuse durable ocurre después de que el handler termina correctamente. Si la validación o aplicación falla, el replay se detiene y la operación permanece pendiente.
- Permite filtrar por proyecto y, opcionalmente, por escritor.
- Se añadieron pruebas de integración para recepción → despacho → acuse, rechazo y reintento, y aislamiento entre escritores/proyectos.

**Límites preservados:** este consumidor integra el pipeline local, pero no implementa transporte remoto, autenticación/autorización del escritor, coordinación entre pestañas/dispositivos ni una transacción atómica entre el diario y las proyecciones narrativas. Los handlers de dominio deben ser idempotentes por `operationId` y aplicar sus mutaciones con CAS/transacciones propias. La entrega sigue siendo al menos una vez.

**Validación:** los cambios de runtime y las nuevas pruebas están publicados en `main`; la ejecución de typecheck, build y suite completa queda pendiente de los checks de CI asociados al HEAD posterior a esta tanda. No se declara verde hasta observar esos resultados.


## Continuación paralela: handlers de dominio y concurrencia por escritor (2026-11-26)

### Frente A — persistencia real de ideas

- Añadido `typescript/src/narrative-sync-domain-handlers.ts`.
- `createNarrativeIdeaUpsertHandler` valida el payload, comprueba el aislamiento de `projectId`, carga el registro actual y aplica inserción/actualización mediante `saveIdeaIfUnchanged`.
- La repetición de una operación ya aplicada se convierte en no-op si el registro persistido coincide exactamente. Esto cubre la ventana de caída entre el CAS de dominio y el acuse del diario.
- Los conflictos CAS se propagan: el diario mantiene la operación pendiente y no se sobrescribe silenciosamente una edición concurrente.
- Exportado desde `src/index.ts`.
- Pruebas en `tests/narrative-sync-domain-handlers.test.mjs`: CAS, idempotencia ante reintento, conflicto y payload inválido.

### Frente B — concurrencia de escritores

- El replay ya no bloquea indiscriminadamente todo un proyecto cuando se procesan escritores diferentes.
- Se serializa por pareja proyecto/escritor; escritores distintos pueden avanzar en paralelo.
- Un replay de proyecto completo excluye cualquier replay específico del proyecto, evitando solapamientos ambiguos.
- Las escrituras de dominio permanecen protegidas por CAS. Los locks solo existen en el runtime actual; no coordinan pestañas o dispositivos.
- Pruebas en `tests/narrative-sync-writer-concurrency.test.mjs`.

### Frente C — contrato y documentación

- Añadido `docs/architecture/HANDLERS_DOMINIO_SINCRONIZACION_NARRATIVA.md` con payload, semántica CAS, reintentos, conflictos y límites de seguridad.
- Se documenta que SHA-256 verifica integridad, no identidad del escritor, y que el handler implementado cubre ideas, no todas las entidades narrativas.

**Validación pendiente:** estos cambios se han publicado en `main`, pero todavía no hay ejecuciones CI asociadas al commit de esta tanda. No se declaran typecheck, build ni suite aprobados hasta comprobarlos.


### Ajuste de tipos para handlers heterogéneos

La integración reveló que un handler tipado como `NarrativeSyncOperationHandler<NarrativeIdeaUpsertPayload>` no debe forzarse al tipo genérico por defecto `NarrativeSyncOperationHandler<unknown>`: bajo `strictFunctionTypes`, el parámetro de `apply` es más específico. Se añadió el alias explícito `AnyNarrativeSyncOperationHandler` para el registro heterogéneo y se utilizó tanto en el dispatcher como en el consumidor. El tipo concreto del handler de ideas se conserva en su fábrica; el borrado de tipo queda limitado al registro interno.


### Frente D — validación de manifiestos de proyección

- Añadida `validateNarrativeDocumentProjectionManifest` y conectada a la confirmación CAS.
- Verifica identidad, revisión, generación, fecha, inventarios acotados, IDs no vacíos y ausencia de duplicados.
- Un manifiesto `deleted` debe tener inventarios vacíos; se rechazan tombstones que pretendan mantener referencias activas.
- Pruebas añadidas a `tests/narrative-knowledge-graph-persistence.test.mjs`.

### Corrección de compatibilidad TypeScript

- El handler tipado de ideas se mantiene compatible con el registro heterogéneo del dispatcher mediante `AnyNarrativeSyncOperationHandler`.
- Se ajustó la validación de estado para preservar el estrechamiento literal de TypeScript sin ensanchar la unión a `string`.

**CI del HEAD observado:** GitHub devuelve listas vacías tanto para workflow runs asociados al commit como para estados de commit. El typecheck, build y suite de estas modificaciones continúan pendientes de ejecución automatizada; no se infiere aprobación por el hecho de que los commits estén publicados.


## Continuación: ampliación de handlers de dominio (2026-11-26)

### Frente E — afirmaciones narrativas

- Añadido `createNarrativeAssertionUpsertHandler` para `assertion-upsert`.
- Valida identidad, atributo, valor, evidencia textual y referencias temporales explícitas.
- Persiste con `saveAssertionIfUnchanged`, comprueba el proyecto del sobre y soporta reintentos idempotentes tras la escritura previa al acuse.
- Pruebas en `tests/narrative-sync-assertion-handler.test.mjs`.

### Frente F — relaciones y acontecimientos

- Añadidos `createNarrativeRelationUpsertHandler` y `createNarrativeEventUpsertHandler`.
- Ambos aplican mutaciones CAS y rechazan payloads de otro proyecto.
- Se validan IDs, tipo/etiqueta, participantes únicos, evidencia no vacía, rangos UTF-16 y referencias temporales sin mezclar calendario con contador de día narrativo.
- Pruebas en `tests/narrative-sync-relation-event-handlers.test.mjs`.

### Cobertura actual del dispatcher de dominio

Handlers implementados para `idea-upsert`, `assertion-upsert`, `relation-upsert` y `event-upsert`. El handler de entidades y la reconciliación/borrado seguro de contribuciones documentales siguen pendientes.

**Límites:** estas operaciones siguen siendo entrega al menos una vez; CAS protege cada registro, no forma una transacción entre varias entidades. Los IDs referenciados deben validarse también contra el proyecto en la capa de aplicación o store, antes de habilitar el transporte remoto. La validación SHA-256 no sustituye autenticación.

**Validación automatizada:** se añadieron pruebas de integración, pero GitHub no ha reportado todavía workflow runs ni estados para los commits nuevos. No se declara build/typecheck/suite en verde.


## Continuación: handler de entidades narrativas (2026-11-26)

### Frente G — fichas de identidad

- Añadido `createNarrativeEntityUpsertHandler` para la operación `entity-upsert`.
- Usa `loadEntities` y `saveEntityIfUnchanged`; comprueba el aislamiento por proyecto y la idempotencia del replay.
- Valida tipo de entidad, ID, nombre canónico, coherencia con `normalizeEntityName`, alias no duplicados, evidencia, marcas de primera/última aparición y versión de extracción.
- Añadidas pruebas de aplicación CAS, caída antes del acuse y rechazo de payloads incoherentes en `tests/narrative-sync-entity-handler.test.mjs`.
- Actualizado el contrato de handlers para incluir `entity-upsert`.

**Límite deliberado:** el upsert no consolida identidades ni redirige referencias. La consolidación requiere el flujo atómico ya definido por el store, pues una fusión afecta relaciones, afirmaciones, vínculos y snapshots archivados. No se sustituye esa operación compleja por un merge superficial.

**Validación automatizada:** commits recientes aún sin workflow runs ni estados de CI reportados. No se declara typecheck/build/tests ejecutados.


## Sincronización de consolidación de identidades

Se añadió `createNarrativeEntityMergeHandler` y el kind `entity-merge`. El handler valida IDs de origen/destino y delega la operación completa en `ProjectStore.mergeNarrativeEntityIdentity`; no intenta reconstruir la fusión con upserts separados.

La implementación IndexedDB existente ejecuta la consolidación en una única transacción sobre entidades, relaciones, acontecimientos, afirmaciones, ideas y biblioteca personal. Antes de mutar, valida integridad referencial del grafo, compatibilidad de tipo de entidad y colisiones de alias. Si el escritor no se proporciona, detecta la presencia de ideas archivadas que exigirían actualizar snapshots y rechaza la operación cuando no puede mantenerlas coherentes.

También se corrigió la validación de `mergedFromIds`: son identificadores (comparación exacta y límite de 512 caracteres), no nombres que deban normalizarse como alias. La prueba nueva cubre delegación atómica, rechazo de payloads inválidos y ausencia de soporte en el store.

**Límite de verificación:** el cambio se publicó en `main`, pero no se ejecutó localmente `npm test` ni `npm run typecheck` en esta sesión. No se debe considerar CI aprobado hasta observar una ejecución real.


### Reintento seguro de `entity-merge`

Se detectó y corrigió una condición de entrega al menos una vez: si la transacción de fusión confirmaba pero el diario fallaba antes de registrar el acuse, un replay encontraba ausente la entidad de origen y rechazaba la operación ya completada. Ahora IndexedDB reconoce el caso cuando el destino contiene el ID de origen en `mergedFromIds` y completa el replay como no-op. Si falta el origen sin esa prueba durable, la operación sigue rechazándose.

Se amplió `narrative-sync-entity-merge-handler.test.mjs` con una prueba de integración sobre `fake-indexeddb`: ejecuta la fusión dos veces, verifica que el segundo intento no falle y confirma que sólo queda el destino con el origen registrado. La prueba está añadida al repositorio; todavía no se ha ejecutado en este entorno.


## Publicación de manifiestos y retirada documental

Se añadió `persistNarrativeKnowledgeGraphSnapshotWithManifests`: guarda primero las proyecciones narrativas mediante CAS por registro y publica después los manifiestos activos por documento mediante CAS por generación. La secuencia evita anunciar una proyección antes de persistir sus datos; un fallo intermedio conserva el manifiesto anterior y permite reintentar.

Se añadió `retireNarrativeDocumentProjection`, que genera tombstones con inventarios vacíos, exige una revisión posterior a la vigente y admite replay idempotente de la misma retirada. El tombstone no elimina registros compartidos: el borrado físico queda deliberadamente fuera hasta implementar reconciliación referencial y retención segura.

Pruebas añadidas a `narrative-knowledge-graph-persistence.test.mjs`: publicación y replay de manifiestos, retirada, idempotencia y rechazo de revisiones obsoletas. Pendiente ejecutar suite y typecheck.


## Diagnóstico de reconciliación documental

Se añadió `reconcileNarrativeDocumentProjections(store, projectId)`, una operación de sólo lectura que compara inventarios de manifiestos con evidencia de las cinco familias de registros narrativos. Detecta manifiestos ausentes, IDs de inventario sin evidencia, evidencia no inventariada y tombstones con evidencia residual.

El diagnóstico no modifica datos ni intenta adivinar reparaciones. Esta separación evita que una rutina automática borre o restaure contenido editorialmente válido después de una caída. Las pruebas cubren un proyecto coherente, inventarios divergentes, tombstones con evidencia residual y documentos sin manifiesto, comprobando que el diagnóstico no muta las tablas.

**Pendiente:** ejecutar `npm test` y `npm run typecheck` en el entorno del proyecto; no se ha observado CI en esta sesión.


## Reparación CAS de inventarios activos

Se incorporó `repairNarrativeDocumentProjectionManifest(store, projectId, documentId)`. Reconstruye los inventarios de entidades, relaciones, eventos, ideas y afirmaciones a partir de la evidencia actualmente persistida y publica el resultado con compare-and-swap de generación. No cambia los registros narrativos. Si no hay discrepancias, la operación es idempotente y no escribe.

Por seguridad, rechaza manifiestos inexistentes y tombstones: no inventa revisiones fuente ni reactiva documentos retirados. Se añadieron pruebas para reparar inventarios divergentes, comprobar que las tablas narrativas permanecen intactas, verificar el reintento sin cambios y rechazar casos que requieren decisión editorial.

**Pendiente de verificación en entorno Node 22+:** `npm run typecheck` y `npm test`.


## Integridad de referencias cruzadas

Se amplió `reconcileNarrativeDocumentProjections` para detectar relaciones cuyos extremos no existen, participantes de acontecimientos inexistentes, afirmaciones sin entidad y vínculos inválidos de ideas con entidades u otras ideas. Los diagnósticos conservan el ID del registro y el documento de evidencia cuando existe; si no hay evidencia documental, `documentId` vacío representa un problema de alcance de proyecto.

Se añadieron pruebas con datos deliberadamente inconsistentes y una comprobación de que el diagnóstico no modifica ninguna tabla. Estas referencias no se reparan automáticamente porque no existe una identidad fuente fiable para decidir cómo resolverlas.

**Pendiente:** ejecutar typecheck y suite completa en Node 22+.


## Propuestas conservadoras de reparación

Se añadió `proposeNarrativeReferenceRepairs(store, report)`. La función sólo propone redirigir referencias a entidades cuando el ID perdido aparece como origen de fusión en exactamente una entidad del mismo proyecto (`mergedFromIds`). Sin coincidencia o con coincidencias ambiguas, exige revisión manual. No modifica el grafo y no aplica heurísticas para resolver vínculos entre ideas.

Se añadieron pruebas para correspondencia explícita, ausencia de correspondencia y ausencia de mutaciones. **Pendiente:** ejecutar typecheck y suite completa en Node 22+; todavía no se dispone de resultado de CI.


## Aplicación controlada de referencias

Se implementó `applyNarrativeReferenceRepair`: exige aprobación explícita, revalida la procedencia de fusión, lee el registro vigente y aplica la sustitución mediante CAS para relaciones, acontecimientos, afirmaciones e ideas. Reconoce reintentos idempotentes y rechaza cambios incompatibles o propuestas obsoletas.

La operación devuelve un registro de auditoría con valores anterior/nuevo, campo modificado, IDs y fecha. **La persistencia durable de ese registro aún corresponde al llamador**, porque el contrato actual de `ProjectStore` no define un almacén de auditoría genérico. Se añadieron pruebas para aprobación, CAS, replay y procedencia obsoleta.

**Pendiente:** ejecutar `npm run typecheck` y `npm test` en Node 22.13+ y, después, incorporar almacenamiento durable de auditoría al contrato del repositorio.


## Auditoría durable de reparaciones

Se amplió `ProjectStore` con operaciones append-only para guardar y consultar auditorías de reparación. IndexedDB incorpora el almacén `narrative-reference-repair-audits`, indexado por proyecto, y migra el esquema a versión 26. La inserción es idempotente por `operationId`; una reutilización del ID con contenido operativo distinto se rechaza.

La API pública `applyNarrativeReferenceRepair` ahora exige soporte de auditoría durable, asigna un ID determinista a la operación y guarda el registro antes de devolver éxito. La escritura de la referencia y la auditoría no son una única transacción; si falla la auditoría después del CAS, el reintento completa el registro pendiente.

Se añadieron pruebas de persistencia y consulta de la auditoría usando el almacén de memoria. **Pendiente:** validar typecheck, suite completa y migración IndexedDB real en navegador/Node 22.13+.


## Precisión de reparaciones por campo

Se corrigió una ambigüedad importante del flujo de reparación: un hallazgo ahora conserva el campo exacto donde se detectó la referencia ausente. Las propuestas exigen ese campo y la aplicación valida exclusivamente la referencia correspondiente. Una relación ya no se considera reparada sólo porque la entidad candidata aparezca en el extremo contrario. El ID de operación de auditoría incorpora el campo para distinguir reparaciones independientes; las relaciones reflexivas pueden producir dos propuestas separadas.

Se ampliaron las pruebas para comprobar el campo emitido por el reconciliador, rechazar un falso replay en el extremo opuesto y distinguir ambos extremos de una relación reflexiva. **Pendiente de validación:** typecheck, suite completa y pruebas de IndexedDB real; no se dispone de resultados CI para este lote.


La prueba de relación reflexiva ahora también aplica ambas propuestas, verifica que los dos extremos quedan reparados y comprueba que cada operación genera una auditoría distinta. Se confirma en GitHub el código y las pruebas modificadas; el estado de CI sigue sin reportar ejecuciones para el commit actual.


## Verificación de integridad del historial de reparaciones

Se añadió `verifyNarrativeReferenceRepairAuditIntegrity(store, projectId)`. La verificación comprueba la estructura de cada entrada, la correspondencia del identificador determinista con los datos operativos, la coherencia de las referencias anterior y posterior, y la unicidad de las operaciones. Además compara el destino registrado con la ficha actual. Los cambios posteriores y las fichas ausentes se presentan como estados históricos diferenciados, sin clasificarlos automáticamente como corrupción del registro.

IndexedDB también valida el tipo de campo, los valores anterior/posterior y el ID determinista antes de aceptar una entrada. Se añadieron pruebas para auditoría íntegra, cambio posterior legítimo del registro y manipulación del ID de operación. **Pendiente:** ejecutar typecheck, suite completa y pruebas de migración IndexedDB en entorno compatible.


La verificación también estrecha explícitamente el tipo de las entradas después de validarlas, evitando propagar campos opcionales al análisis de registros. La función queda exportada por el punto de entrada TypeScript existente.


## Recuperación de reparaciones interrumpidas

Se introdujo un registro durable de intenciones pendientes para reparaciones aprobadas. La intención se guarda antes del CAS; la auditoría append-only se confirma después del CAS; solo entonces se elimina la intención. La función pública `recoverNarrativeReferenceRepairs(store, projectId)` reanuda los casos pendientes con revalidación del vínculo de fusión y del estado actual. Los conflictos permanecen registrados para revisión, sin forzar escrituras.

IndexedDB incorpora el almacén `narrative-reference-repair-pending` mediante migración a versión 27. La persistencia de intenciones es idempotente para la misma operación incluso si el reintento llega con otro timestamp. Se añadió una prueba de fallo simulado en la escritura de auditoría: la recuperación reconoce la mutación ya confirmada, no la repite y completa el registro durable. **Pendiente de validación:** typecheck, suite completa y prueba de migración IndexedDB en navegador/runtime compatible.
