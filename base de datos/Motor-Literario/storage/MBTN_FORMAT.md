# MBTN — formato de nodos B+Tree v1

**Estado:** codec experimental de nodos, ahora utilizado por un primer B+Tree persistente en `src/btree.rs`. El árbol implementa búsqueda exacta, inserción/reemplazo, eliminación con redistribución limitada cuando una hoja queda vacía, splits, consultas por rango semiabierto, iterador incremental y validación integral de estructura; no implementa merges ni buffer pool. No está validado para producción.

## Cabecera (20 bytes)

| Campo | Bytes | Descripción |
|---|---:|---|
| magic | 4 | `MBTN` |
| version | 2 | u16 little-endian, 1 |
| kind | 1 | 1 hoja, 2 interno |
| flags | 1 | reservado, debe ser 0 |
| count | 2 | número de entradas |
| level | 2 | 0 en hojas; nivel positivo en internos |
| next_leaf | 8 | page_id siguiente en hojas; 0 en internos |

## Hoja

Cada entrada: key_len u16, value_len u32, key bytes, value bytes. Las claves se ordenan estrictamente por comparación lexicográfica de bytes. `next_leaf=u64::MAX` significa que no hay siguiente hoja; cualquier otro valor, incluido 0, es un page_id.

## Nodo interno

Después de la cabecera: first_child u64. Cada entrada contiene separator_len u16, separator bytes y right_child u64. La clave separadora representa el límite entre el hijo izquierdo y el derecho. Las claves deben estar estrictamente ordenadas. Se admite un nodo interno sin separadores (un solo hijo) para representar divisiones por bytes que promueven el primer separador; el recorrido y la validación deben conservar ese único hijo.

## Reglas y límites

- El codec recibe y devuelve un payload de capacidad fija; no hace I/O.
- Claves opacas: la codificación de la tupla `(project_id, table, record_id)` y su orden total deberán fijarse antes de construir el árbol.
- El valor de hoja es opaco; su representación de fila se definirá por separado.
- Los IDs de página y la metadata de raíz no se validan aquí.
- El relleno posterior a las entradas debe ser cero.
- No hay checksum propio: al almacenarse como payload MLPG, lo cubre el checksum de página.
- La metadata de raíz usa una página separada `MBTR` v1 en el page_id 0; los nodos MBTN comienzan en page_id 1.
- Cada inserción confirma los nodos afectados y la metadata de raíz (si cambia) en una única transacción MLPJ.
- La eliminación modifica la hoja y, si queda vacía, intenta tomar una entrada de un hermano inmediato que tenga más de una; hoja, hermano y separador padre se actualizan en una única transacción MLPJ.
- Esta redistribución es limitada: no aplica un umbral general de ocupación mínima, no fusiona páginas ni reduce la altura de la raíz. Las hojas vacías que no pueden recibir préstamo permanecen en el árbol; no se liberan ni reutilizan IDs de página.
- `range(start_inclusive, end_exclusive)` recorre enlaces de hojas y materializa los resultados; `range_iter(...)` expone un iterador incremental que carga hoja a hoja.
- El iterador incremental devuelve claves y valores propios, y detecta ciclos y enlaces a páginas inválidas.
- `validate()` recorre todos los nodos alcanzables, comprueba niveles, referencias, límites de separadores, páginas huérfanas y concordancia de los enlaces entre hojas.
- Este formato no se declara estable hasta compilar y ejecutar pruebas, revisar límites y completar validación de integridad del árbol. Hay una prueba multinivel con claves separadoras grandes que compara borrados y reinserciones contra un mapa de referencia; también se prueba el roundtrip del nodo interno unario generado al promover el primer separador. Las pruebas están escritas, pero aún no ejecutadas.
