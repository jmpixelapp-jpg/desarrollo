# Protocolo de páginas reutilizables — borrador v0.1

**Estado:** protocolo experimental parcialmente implementado; no es todavía un contrato estable ni habilita el uso de MLDB para manuscritos reales.

## Objetivo

Permitir que el B+Tree recicle páginas de nodos eliminados sin truncar el archivo, sin reutilizar un ID antes de que la eliminación esté confirmada y sin perder la recuperación redo de MLPJ.

La lista libre pertenece al árbol, no a un índice global. La metadata de la página 0 es su única raíz persistente.

## Formato propuesto

### Metadata MBTR v2

La metadata mantiene el magic `MBTR` y añade un puntero `free_head`:

| Offset | Bytes | Campo |
|---:|---:|---|
| 0 | 4 | magic `MBTR` |
| 4 | 2 | versión 2 |
| 6 | 2 | reservado, cero |
| 8 | 8 | root_id |
| 16 | 2 | nivel de raíz |
| 18 | 2 | reservado, cero |
| 20 | 8 | free_head; `u64::MAX` significa lista vacía |
| 28 | 4 | reservado, cero |

Longitud exacta: 32 bytes. El lector deberá aceptar MBTR v1 (24 bytes) como `free_head=None`; toda escritura posterior emitirá v2. No se reinterpretarán bytes reservados de v1.

### Página libre MBFR v1

Una página liberada conserva su page_id físico y su generación MLPG. Su payload se reemplaza por un registro fijo:

| Offset | Bytes | Campo |
|---:|---:|---|
| 0 | 4 | magic `MBFR` |
| 4 | 2 | versión 1 |
| 6 | 2 | reservado, cero |
| 8 | 8 | siguiente page_id; `u64::MAX` significa fin |

Longitud exacta: 16 bytes. Una página MBFR no es un nodo MBTN y no puede ser referenciada por root, por un hijo interno ni por next_leaf.

## Reglas transaccionales obligatorias

### Liberar una página

1. Comprobar que el page_id no sea 0, no sea la raíz vigente y no esté duplicado en el conjunto de cambios.
2. Comprobar que el nodo haya sido retirado de la estructura alcanzable en el mismo cambio lógico.
3. Escribir MBFR con `next = free_head` y generación incrementada.
4. Actualizar MBTR con `free_head = page_id` y generación incrementada.
5. Confirmar ambas imágenes en una única transacción MLPJ.

Nunca se debe publicar el nuevo free_head antes de que la imagen MBFR esté incluida en el mismo COMMIT. Tampoco se debe sobrescribir una página viva con MBFR en una transacción separada de la modificación de sus padres.

### Reutilizar una página

1. Leer y validar MBFR en `free_head`.
2. Validar que el siguiente ID sea `u64::MAX` o apunte a una página física existente que también sea MBFR.
3. En la misma transacción que publica el nuevo nodo, sobrescribir la página libre con el payload MBTN y generación incrementada, y actualizar MBTR para retirar el primer elemento.
4. Si la transacción no llega a COMMIT, redo no publica ni el nodo ni el nuevo free_head. Si llega a COMMIT y la aplicación queda incompleta, MLPJ repite todas las imágenes.
5. No reiniciar generaciones al reutilizar IDs. Una página reciclada conserva monotonía de generación para ese ID.

La asignación de varias páginas en una operación debe consumir una cadena temporal de free_head y producir una única imagen final de metadata. No se permite reutilizar dos veces el mismo ID dentro de una transacción.

## Invariantes de validación

`validate()` deberá recorrer el árbol y la lista libre como dos conjuntos disjuntos:

- Ningún ID puede estar simultáneamente alcanzable desde la raíz y presente en la lista libre.
- La lista libre no puede contener ciclos, IDs duplicados, page_id 0 ni referencias fuera del archivo.
- Cada página física entre 1 y page_count-1 debe pertenecer exactamente a uno de estos conjuntos: árbol alcanzable o lista libre.
- Toda página del conjunto libre debe decodificar como MBFR v1.
- Toda página alcanzable debe decodificar como MBTN.
- La cadena next_leaf debe incluir solo hojas alcanzables, nunca páginas libres.
- La raíz nunca puede estar libre.
- La cantidad de páginas libres y visitadas debe sumar page_count-1 sin desbordamiento.

Las páginas que no pertenezcan a ninguno de los dos conjuntos son huérfanas y deben causar error; no se deben adoptar automáticamente como libres.

## Compatibilidad y recuperación

- MBTR v1 se interpreta como lista libre vacía.
- MBTR v2 exige longitud exacta y bytes reservados en cero.
- MBFR se valida estrictamente; un marcador inválido no se interpreta como página libre.
- MLPJ permanece como autoridad de recuperación. El formato no añade un segundo WAL ni una escritura fuera de transacción.
- Un checkpoint MLPJ no modifica MBTR, MBFR ni las generaciones.
- No se permite truncar el archivo de páginas en esta etapa; la reutilización solo cambia el contenido de páginas ya asignadas.

## Orden de implementación

1. Añadir codec MBTR v2 con lectura compatible de v1 y codec MBFR v1.
2. Añadir pruebas de codec, longitudes, reservados, sentinelas y corrupción.
3. Integrar asignación reutilizable en inserciones y splits, consumiendo free_head transaccionalmente. (Implementado para las inserciones y divisiones de hojas/nodos.)
4. Ampliar pruebas de recuperación para las transiciones de asignación y liberación.
5. Implementar merge de hojas e internos; retirar nodos y encadenarlos como MBFR en la misma transacción que actualiza padres, raíz y enlaces de hojas.
6. Implementar reducción de altura y pruebas de recuperación/reapertura en cada transición.
7. Solo después evaluar compactación física del archivo.

## Límites explícitos

Este documento no demuestra que la estrategia esté completamente implementada ni probada. El código escribe MBTR v2 y lee MBTR v1/v2; `insert()` consume páginas MBFR y `remove()` puede redistribuir/fusionar hojas e internos, liberar nodos, propagar underflows multinivel y contraer raíces. `validate()` comprueba que árbol y lista libre sean conjuntos disjuntos y cubran todas las páginas físicas. Siguen pendientes la compactación, las pruebas reales de crash/recuperación y la validación multiplataforma. El formato deberá revisarse junto con el código y los tests antes de declararse estable.


**Estado actualizado:** `insert()` consume `free_head` para asignar páginas de nodos, incrementa la generación y actualiza MBTR en la misma transacción MLPJ. `remove()` ahora libera páginas descartadas por fusiones de hojas e internos, mantiene la lista MBFR y puede contraer raíces; los cambios de árbol y metadata se confirman juntos. `validate()` detecta ciclos/duplicados de la lista libre y exige cobertura exacta de páginas alcanzables y libres. La ruta de inserción conserva su asignador propio; las primitivas `PageOverlay::register_free_page()` y `stage_reuse()` aún no son el asignador de producción. Las pruebas están escritas, pero no ejecutadas.


**Implementación parcial añadida:** al quedar una hoja vacía, `remove()` redistribuye si un hermano tiene más de una entrada; si el hermano solo tiene una, fusiona las hojas y añade la página descartada a MBFR. Si el padre inmediato es la raíz y pierde su único separador, la raíz se contrae al hijo superviviente y la antigua página raíz también se libera. Todos los cambios, incluida MBTR, se registran en una transacción MLPJ. El soporte no se extiende aún a fusiones de nodos internos ni a propagación de underflow en varios niveles.
