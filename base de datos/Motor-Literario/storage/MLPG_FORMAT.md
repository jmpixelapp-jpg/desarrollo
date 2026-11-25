# MLPG v1 — archivo físico de páginas

- Tamaño fijo: 4096 bytes.
- Cabecera: magic (4), versión (2), page_id (8), generación (8), longitud útil (4), checksum (4).
- Carga útil máxima: 4066 bytes.
- Las páginas se direccionan por posición física y el identificador almacenado debe coincidir.
- Al abrir, se comprueba que el tamaño total sea múltiplo de 4096 y se validan todas las páginas.
- El checksum FNV-1a detecta corrupción accidental; no es criptografía.

Este módulo es una primitiva física inicial. Todavía no implementa asignación/liberación reutilizable, buffer pool, B-tree, slotted pages, WAL redo/undo integrado ni checkpoint. La escritura de páginas aún no se confirma como segura ante pérdida de energía: la atomicidad de páginas requiere integración con el WAL y pruebas de fallos.
