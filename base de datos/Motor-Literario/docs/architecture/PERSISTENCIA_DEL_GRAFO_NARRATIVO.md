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

Las fusiones de entidades, relaciones, acontecimientos e ideas preservan evidencias procedentes de otros documentos. Los registros sin cambios se omiten, haciendo idempotente la repetición de una misma proyección.

## Recuperación tras reinicio

El anfitrión puede recuperar los documentos con `ProjectStore.loadDocument` (y su propia lista de IDs documentales), reconstruir un snapshot mediante `createNarrativeKnowledgeGraphSnapshot` y volver a ejecutar esta persistencia. La proyección se deriva de los manuscritos; el snapshot incremental en memoria no se serializa como autoridad durable.

## Garantías y límites

- No hay transacción global para las cinco colecciones. Un error puede ocurrir después de guardar algunos registros; reintentar es seguro para las mismas entradas, pero no es una escritura atómica.
- El contrato actual no expone borrado de entidades, relaciones, acontecimientos, ideas o afirmaciones. Por tanto, esta versión no elimina registros que hayan dejado de aparecer en una revisión ni retira evidencia antigua del documento modificado.
- La fusión preserva evidencia cruzada, pero puede conservar evidencia obsoleta de revisiones anteriores. No se debe presentar el resultado persistido como una reconstrucción autoritativa sin una fase posterior de reconciliación/tombstones.
- Las decisiones manuales sobre el estado de las ideas se conservan mediante `mergeNarrativeIdea`; la persistencia no sustituye decisiones editoriales.

La siguiente evolución necesaria para reconciliación completa es una operación de reemplazo por documento, con tombstones y actualización transaccional de todas las colecciones afectadas.
