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
