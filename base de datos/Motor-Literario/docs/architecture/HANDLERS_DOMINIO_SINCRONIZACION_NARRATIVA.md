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

Las fábricas públicas son `createNarrativeEntityUpsertHandler`, `createNarrativeIdeaUpsertHandler`, `createNarrativeAssertionUpsertHandler`, `createNarrativeRelationUpsertHandler` y `createNarrativeEventUpsertHandler`. `createNarrativeSyncDomainHandlers(store)` las registra juntas y valida al inicializar que el almacén ofrezca todos los métodos CAS requeridos.

## Validación del dominio

Todos los handlers comprueban que el proyecto del registro coincide con el proyecto del sobre antes de escribir. Las validaciones limitan longitud y cardinalidad de campos, verifican IDs, y rechazan evidencia con revisiones o rangos UTF-16 inválidos.

Las entidades comprueban coherencia de nombre canónico normalizado, alias únicos, tiempos de primera/última aparición y versión de extracción. Este handler no fusiona identidades: la consolidación debe usar la operación atómica de identidad del store para redirigir referencias y conservar snapshots archivados.

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

- No hay resolución automática de conflictos ni fusión de ediciones de texto.
- No hay cliente HTTP predeterminado ni autorización remota por proyecto; el anfitrión proporciona y autentica el transporte.
- El diario no autentica `writerId`; la identidad debe proceder de una sesión validada por el anfitrión/servidor.
- SHA-256 verifica integridad, no identidad del emisor.
- No hay exactamente-una-vez ni atomicidad distribuida entre diario y proyecciones.
- La reconciliación de tombstones y la eliminación segura de afirmaciones/documentos requieren un flujo específico; no se simulan mediante upserts.

## Pruebas

- `tests/narrative-sync-domain-handlers.test.mjs`: ideas, registro agregado, CAS, reintentos y conflictos.
- `tests/narrative-sync-entity-handler.test.mjs`: entidades, normalización canónica, CAS y reintentos.
- `tests/narrative-sync-assertion-handler.test.mjs`: afirmaciones, evidencia, referencias temporales y reintentos.
- `tests/narrative-sync-relation-event-handlers.test.mjs`: relaciones, acontecimientos y validación temporal.
- `tests/narrative-sync-writer-concurrency.test.mjs`: replay paralelo entre escritores y exclusión de replay completo.
