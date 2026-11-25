# Evolución del esquema MLDB 0.4.2

**Estado:** esquema lógico declarativo y mapeo físico implementados; validación automática disponible.  
**Versión IndexedDB:** 22  
**Cambio lógico:** historial append-only de cambios explícitos de acontecimientos.

## Línea de versiones

| Versión | Contenido |
|---|---|
| 0.2.0 | Base lógica con 18 tablas, claves compuestas y aislamiento por proyecto |
| 0.3.0 | Añade diccionarios por proyecto, entradas y vínculos tipados con entidades (21 tablas) |
| 0.4.0 | Añade historiales de entidades/relaciones y biblioteca privada del escritor con recibos de finalización (25 tablas) |
| 0.4.1 | Endurece coordenadas de evidencia, referencias documentales y jerarquía de fragmentos (25 tablas) |
| 0.4.2 | Añade el historial inmutable de etiqueta y participantes de acontecimientos (26 tablas lógicas, incluida `projects`) |

## Cambio de 0.4.2: `event_lifecycles`

La nueva tabla `event_lifecycles` registra cada cambio explícito de la etiqueta y del conjunto de participantes de un acontecimiento. Su ámbito es `project`; toda fila requiere `project_id` y conserva:

- `event_id` y una `revision` monotónica dentro del acontecimiento y del proyecto.
- `previous_label` y `new_label`.
- `previous_participants` y `new_participants`, como instantáneas JSON de los identificadores participantes.
- `changed_by`, `change_reason` opcional y `changed_at` explícito.

La tabla establece unicidad para `(project_id, lifecycle_id)` y para `(project_id, event_id, revision)`. La clave foránea de proyecto impide trasladar historiales entre libros. Los índices de proyecto/acontecimiento/revisión permiten recuperar la secuencia histórica sin recorrer otros proyectos.

## Reglas de integridad

1. El historial es append-only: una transición nueva no sustituye las transiciones anteriores.
2. La escritura de la ficha vigente y la transición histórica se realiza de forma atómica en el adaptador. Si falla una de las dos, no debe quedar solo una mitad del cambio.
3. La revisión esperada de la ficha debe seguir vigente antes de escribir. Una actualización obsoleta se rechaza en lugar de sobrescribir una transición de otra instancia.
4. Los participantes anteriores y nuevos son instantáneas explícitas de la transición. Las menciones del manuscrito no se convierten automáticamente en altas o bajas de participantes.
5. No se fabrican historiales anteriores. Los acontecimientos existentes no reciben una línea base, fechas ni transiciones retroactivas. La primera fila refleja el primer cambio explícito registrado después de incorporar esta capacidad.

## Persistencia física

- `schema_v0.4.2.json` define el contrato lógico.
- `storage_mapping_v0.4.2.json` declara la correspondencia de las 25 tablas propiedad del motor y la tabla `projects`, cuya identidad sigue bajo responsabilidad del anfitrión.
- `PHYSICAL_STORAGE_MAPPING_v0.4.2.md` describe los 32 object stores de IndexedDB, sus claves e índices.
- La base `motor-literario-local` usa IndexedDB versión 22. La migración agrega el almacén del historial sin vaciar los almacenes anteriores.

Los object stores operativos adicionales no representan tablas lógicas nuevas: soportan snapshots, journal, diagnósticos, biblioteca y recibos.

## Validación

Desde `base de datos/Motor-Literario/typescript`:

```sh
npm run validate:schema
```

El validador comprueba el contrato JSON; la auditoría física contrasta nombre y versión de IndexedDB, tablas lógicas, object stores, claves e índices declarados con el adaptador. Esta validación estática no sustituye las pruebas de ejecución en navegador ni las pruebas transaccionales del runtime.
