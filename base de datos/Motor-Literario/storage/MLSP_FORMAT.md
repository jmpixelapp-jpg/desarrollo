# MLSP — formato lógico de página slotted v1

**Estado:** implementación experimental en `src/slotted_page.rs`. Se serializa dentro del payload de una página MLPG; todavía no hay mutación in-place ni recuperación WAL integrada.

## Layout

El payload tiene capacidad fija suministrada por el contenedor (actualmente 4066 bytes en MLPG v1).

| Campo | Bytes | Descripción |
|---|---:|---|
| magic | 4 | `SLT1` |
| version | 2 | u16 little-endian, valor 1 |
| slot_count | 2 | número de slots, incluidos tombstones |
| free_start | 2 | primer byte libre después de la tabla |
| free_end | 2 | límite inferior de la región de registros |
| slot directory | 6 × N | offset u16, length u16, flags u16 |
| records | variable | bytes opacos, empaquetados desde el final |

Flags 1 significa registro activo; flags 0 con offset/length 0 significa tombstone. Los slots no se renumeran al borrar. El número de slot se mantiene estable dentro de esta imagen lógica.

## Validaciones

El decoder verifica magic/versión, límites, tabla de slots, flags, longitudes, rangos fuera de límites y solapamiento entre registros. El encoder rechaza falta de espacio y registros que excedan u16.

## Límites

- Los registros son bytes opacos; la codificación de filas MLDB se especificará aparte.
- El borrado es lógico; no hay compactación ni reutilización de tombstones.
- No existe inserción/actualización concurrente.
- No es una página B-tree y no define claves ni orden.
- La estabilidad de slot no se extiende aún a compactación/reorganización.
- El formato queda sujeto a pruebas ejecutadas y revisión antes de declararse estable.
