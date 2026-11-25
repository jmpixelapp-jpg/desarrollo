# Evolución del esquema MLDB 0.4.1

**Estado:** esquema lógico JSON versionado; el mapa físico distingue persistencia disponible de capacidades aún pendientes.

## Línea de versiones

| Versión | Contenido |
|---|---|
| 0.2.0 | Base lógica con 18 tablas, claves compuestas y aislamiento por proyecto |
| 0.3.0 | Añade diccionarios por proyecto, entradas y vínculos tipados con entidades (21 tablas) |
| 0.4.0 | Añade historiales de entidades/relaciones y biblioteca privada del escritor con recibos de finalización (25 tablas) |
| 0.4.1 | Endurece coordenadas de evidencia, referencias documentales y jerarquía de fragmentos (25 tablas) |

## Propiedad e aislamiento

- La aplicación anfitriona proporciona `project_id`, nombre del libro y la identidad autenticada `writer_id`; el motor no inventa estas identidades.
- Las tablas de ámbito `project` requieren `project_id` no nulo y referencias compuestas que conservan ese ID.
- Las tablas de ámbito `writer` enlazan conjuntamente `writer_id` y `source_project_id` con el propietario real del proyecto.
- Las autorizaciones de importación registran al mismo escritor como propietario de los proyectos de origen y destino.
- Las ideas que siguen en estado `IDEA` al finalizar un libro se archivan bajo la biblioteca privada del escritor, en la categoría del título de origen. Las ideas incorporadas o descartadas permanecen en el conocimiento de su libro.

## Tablas añadidas

### Diccionarios (0.3.0)

`project_dictionaries`, `dictionary_entries` y `dictionary_entry_entities` representan diccionarios propios por proyecto, entradas extensibles y vínculos con entidades del mismo libro. Los nombres y atributos no forman un catálogo cerrado.

### Historial y biblioteca personal (0.4.0)

`record_lifecycles` y `relation_lifecycles` conservan transiciones históricas sin sobrescribir el estado anterior. `writer_library_ideas` conserva las ideas no incorporadas y su paquete de contexto/procedencia. `writer_library_finalization_receipts` permite identificar una finalización idempotente por escritor y proyecto de origen.

### Integridad de evidencias (0.4.1)

Las evidencias con fragmento requieren documento; los offsets de inicio y fin se informan en pareja, son no negativos y mantienen orden; páginas y líneas comienzan en 1; la revisión documental no puede ser negativa. Los fragmentos prohíben la autorreferencia como padre y exigen rangos completos y ordenados.

## Archivos

- `schema_v0.2.0.json`, `schema_v0.3.0.json`, `schema_v0.4.0.json`, `schema_v0.4.1.json`: contratos lógicos versionados.
- `storage_mapping_v0.4.1.json`: correspondencia comprobable con el modelo físico.
- `PHYSICAL_STORAGE_MAPPING_v0.4.1.md`: explicación legible de esa correspondencia.

Estos archivos son contratos declarativos JSON. No equivalen por sí solos a una implementación SQL ni afirman que las 25 tablas estén materializadas ya en IndexedDB.
