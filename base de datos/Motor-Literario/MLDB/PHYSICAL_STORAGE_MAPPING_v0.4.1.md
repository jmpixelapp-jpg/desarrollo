# Correspondencia física MLDB 0.4.1

## Modelo de almacenamiento vigente

La implementación de ejecución es TypeScript/JavaScript puro sobre IndexedDB nativo. No se emplea SQL ni se incorporan motores externos. La base local se denomina `motor-literario-local`, actualmente en versión IndexedDB `18`.

El almacenamiento es journal-first: el snapshot durable del documento se conserva en `documents`; las operaciones aceptadas se escriben como deltas ordenados en `changes`. La confirmación de snapshot y compactación usa una misma transacción cuando el adaptador ofrece `saveDocumentAndCompactChanges`. La identidad del libro siempre incluye `projectId`; la biblioteca personal incluye además `writerId`.

## Almacenes IndexedDB actuales

| Object store | Clave primaria | Índices relevantes | Contenido |
|---|---|---|---|
| `language-profiles` | `[projectId, id]` | `by-project`, `by-project-language`, `by-project-active` | Perfiles lingüísticos reales o ficticios y preferencias editoriales |
| `language-resource-refs` | `[projectId, id]` | `by-project`, `by-profile`, `by-resource-database` | Referencias locales a recursos lingüísticos declarados |
| `project-settings` | `[projectId, key]` | `by-project` | Preferencias del libro y valores JSON |
| `documents` | `[projectId, documentId]` | `by-project` | Snapshot UTF-16 por documento |
| `changes` | `[projectId, documentId, sequence]` | `by-document-sequence` único | Journal durable de ediciones |
| `narrative-entities` | `[projectId, id]` | `by-project` | Fichas de entidades y evidencias |
| `narrative-relations` | `[projectId, id]` | `by-project` | Relaciones y evidencias |
| `narrative-events` | `[projectId, id]` | `by-project` | Acontecimientos y referencias temporales explícitas |
| `narrative-ideas` | `[projectId, id]` | `by-project` | Ideas del libro, estado e historial |
| `personal-idea-library` | `[writerId, sourceProjectId, idea.id]` | `by-writer`, `by-writer-source`, `by-source-project` | Ideas no incorporadas archivadas con contexto |
| `narrative-assertions` | `[projectId, id]` | `by-project`, `by-entity` | Afirmaciones históricas explícitas |
| `document-diagnostics` | `[projectId, documentId]` | `by-project` | Diagnósticos asociados a revisión |
| `project-dictionaries` | `[projectId, id]` | `by-project`, `by-project-language-name` único | Diccionarios por proyecto e idioma |
| `dictionary-entries` | `[projectId, id]` | `by-project`, `by-dictionary`, `by-dictionary-normalized` único | Entradas, atributos JSON y vínculos con entidades |
| `manuscript-fragments` | `[projectId, id]` | `by-project`, `by-document-revision`, `by-parent` | Fragmentos con offsets UTF-16, revisión y jerarquía |
| `record-attributes` | `[projectId, id]` | `by-project`, `by-record-key` | Atributos JSON extensibles de fichas |
| `relation-attributes` | `[projectId, id]` | `by-project`, `by-relation-key` | Atributos JSON extensibles de relaciones |
| `active-suggestions` | `[projectId, id]` | `by-project`, `by-document-revision`, `by-status-priority` | Sugerencias versionadas ligadas a documento/fragmento |
| `import-authorizations` | `[writerId, sourceProjectId, targetProjectId, authorizationId]` | `by-writer`, `by-source-target`, `by-target` | Autorizaciones append-only del escritor |
| `schema-migrations` | `migrationId` | `by-to-version`, `by-applied-at` | Historial durable de migraciones nativas |
| `style-profiles` | `[projectId, id]` | `by-project`, `by-project-name` | Perfiles de estilo por libro y preferencias editoriales JSON |
| `timeline-tracks` | `[projectId, id]` | `by-project`, `by-project-name` | Pistas cronológicas explícitas y reglas JSON |
| `record-lifecycles` | `[projectId, id]` | `by-project`, `by-subject`, `by-subject-revision` único | Historial append-only de fichas |
| `relation-lifecycles` | `[projectId, id]` | `by-project`, `by-subject`, `by-subject-revision` único | Historial append-only de relaciones |

Los almacenes y sus índices se crean/migran desde `IndexedDbProjectStore.open()`. Las lecturas deben esperar a que complete su transacción readonly; las colecciones y registros se validan antes de incorporarse a la API o a sus cachés.

## Mapeo de las 25 tablas lógicas

| Tabla lógica | Representación física | Estado actual |
|---|---|---|
| `projects` | Identidad entregada por el anfitrión | Anfitrión; no se duplica en el contenido narrativo |
| `project_settings` | `project-settings` | Implementado; JSON validado, origen WRITER/HOST y actualización optimista |
| `manuscript_documents` | `documents` + `changes` | Implementado |
| `manuscript_fragments` | `manuscript-fragments` | Implementado; offsets UTF-16, revisión y referencias a documento/padre validadas |
| `records` | `narrative-entities` | Parcial; actualmente character/place/object |
| `record_names` | `canonicalName` y `aliases` embebidos en entidad | Implementado |
| `record_attributes` | `record-attributes` | Implementado; valores JSON extensibles enlazados a fichas del mismo libro |
| `relations` | `narrative-relations` | Implementado |
| `relation_attributes` | `relation-attributes` | Implementado; valores JSON extensibles enlazados a relaciones del mismo libro |
| `evidences` | `TextEvidence` embebido en registros | Implementado |
| `timeline_tracks` | `timeline-tracks` | Implementado; pistas temporales explícitas sin inferencia automática |
| `timeline_occurrences` | `timeReference` y `timelineTrackId` embebidos en `narrative-events` | Implementado; asociación explícita validada transaccionalmente contra `timeline-tracks` |
| `language_profiles` | `language-profiles` | Implementado; perfiles reales/ficticios, preferencias JSON y cobertura declarada |
| `language_resource_refs` | `language-resource-refs` | Implementado; referencias ligadas opcionalmente a perfiles del mismo proyecto |
| `style_profiles` | `style-profiles` | Implementado; perfil de voz y preferencias editoriales del libro |
| `active_suggestions` | `active-suggestions` | Implementado; sugerencias JSON con documento, fragmento, revisión y estado |
| `import_authorizations` | `import-authorizations` | Implementado; append-only, ambos proyectos verificados por escritor autenticado |
| `schema_migrations` | `schema-migrations` | Implementado desde DB18; cada actualización escribe un recibo con versiones y checksum |
| `project_dictionaries` | `project-dictionaries` | Implementado; unicidad por proyecto, idioma y nombre normalizado |
| `dictionary_entries` | `dictionary-entries` | Implementado; actualización comparada y forma normalizada única |
| `dictionary_entry_entities` | `DictionaryEntry.relatedEntityIds` embebido | Implementado; referencias verificadas transaccionalmente dentro del libro |
| `record_lifecycles` | `record-lifecycles` | Implementado; historial append-only con continuidad de revisión |
| `relation_lifecycles` | `relation-lifecycles` | Implementado; historial append-only con continuidad de revisión |
| `writer_library_ideas` | `personal-idea-library` | Implementado con transacción de transferencia |
| `writer_library_finalization_receipts` | `writer-library-finalization-receipts` | Implementado; recibo idempotente con checksum y transferencia en la misma transacción |

El archivo `storage_mapping_v0.4.1.json` es la fuente verificable del mapeo: contiene todas las tablas, el ámbito lógico, el ámbito físico, prefijos, representación, contrato TypeScript y estado de implementación. El validador falla cuando falta una tabla, hay una tabla extra, se repite una entrada o el ámbito/contrato/representación es inválido.

## Límites que no deben ocultarse

El esquema lógico declara el modelo completo de 25 tablas, pero la implementación IndexedDB aún no materializa todas esas tablas por separado. Los estados `partial` y `not-implemented` son deliberados y explícitos. La versión IndexedDB 18 materializa todas las tablas lógicas salvo `records`, que permanece parcial porque su esquema permite `primary_name` nulo mientras la ficha narrativa actual exige un nombre canónico. `projects` permanece correctamente bajo propiedad del anfitrión y no se duplica en el contenido del libro. El historial de migraciones empieza a registrar upgrades desde la versión 18; las versiones anteriores no se reconstruyen retroactivamente.

La implementación conserva la privacidad local y el aislamiento por libro/escritor. No mueve ni comparte contenido entre proyectos por semejanza; una importación entre libros necesita autorización explícita del escritor.
