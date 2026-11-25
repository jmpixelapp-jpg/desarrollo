# Evolución del esquema MLDB 0.4.0

## Cambios respecto a 0.3.0

La versión 0.4.0 completa tres grupos de información que ya son necesarios en el Motor Literario y estaban ausentes o insuficientemente representados en el esquema anterior.

### 1. Biblioteca personal de ideas

- `writer_library_ideas`: conserva cada idea que sigue marcada como `IDEA` al finalizar una obra. La categoría de origen se identifica con el título del libro.
- `writer_library_finalization_receipts`: conserva el recibo idempotente del cierre y la lista de ideas archivadas.
- Las dos tablas usan ámbito `writer`, no `project`. La biblioteca pertenece al escritor.
- Las referencias compuestas comprueban que el escritor sea propietario del proyecto de origen y que la entidad archivada exista en ese mismo proyecto.
- `archive_json` conserva el paquete de conocimiento asociado: entidad, historial, evidencias, relaciones, atributos, cronología, nombres, fragmentos, diccionarios y procedencia.

Las ideas que pasan a `REGISTERED_IN_WORK` no se trasladan a la biblioteca de ideas no utilizadas: permanecen en el conocimiento del libro.

### 2. Historiales explícitos

- `record_lifecycles` conserva las revisiones de etiquetas y estados de las entidades.
- `relation_lifecycles` conserva las revisiones de las relaciones.
- Ambas usan claves compuestas con `project_id`; el historial no puede quedar asociado a un registro de otro libro.

### 3. Ámbitos de propiedad

El modelo declara tres ámbitos: `global`, `project` y `writer`. El validador exige `project_id` o `writer_id` obligatorio según corresponda y comprueba referencias de propiedad para evitar cruces de libros o escritores.

## Correspondencia con el almacenamiento actual

El almacenamiento real sigue siendo journal-first y clave/valor, no una base SQL de 25 tablas físicas. La correspondencia entre tablas lógicas, prefijos reales, índices derivados y estructuras JSON embebidas está documentada en `PHYSICAL_STORAGE_MAPPING_v0.4.0.md`.

La versión declarativa 0.4.0 no incrementa por sí misma la versión de migraciones lógicas del motor (actualmente 5) ni la versión del formato binario (actualmente 1). No ejecuta ninguna conversión de datos.

## Validación

El validador estructural revisa claves primarias y compuestas, índices, unicidad de destinos, claves foráneas, propiedad de proyecto/escritor y aislamiento. La suite contiene 15 casos automatizados; la ejecución Node en CI/runner queda pendiente de confirmación.
