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
