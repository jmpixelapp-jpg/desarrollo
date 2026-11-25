# B+Tree — plan de rebalanceo interno y borrado multinivel

Estado: propagación ascendente y reparación descendente acotada integradas en `remove()`. Incluye redistribución/fusión interna, reparación posterior de nodos unarios y hojas vacías desbloqueados por fusiones superiores, contracción de raíces y una transacción MLPJ única. No garantiza ocupación mínima global. Las pruebas están escritas, pero no se han ejecutado por falta de runners funcionales.

## Objetivo

Consolidar y verificar `PersistentBPlusTree::remove()` para que una eliminación pueda propagarse desde una hoja hasta la raíz y reparar los déficits desbloqueados por las fusiones superiores, sin perder claves ni publicar estados parciales.

Todas las escrituras de una eliminación deben formar una sola transacción MLPJ. La metadata MBTR (raíz y `free_head`) se actualiza en esa misma transacción.

## Representación que debe respetarse

Un nodo interno contiene `level`, `first_child` y una lista ordenada de entradas `(separator, right_child)`. Para N separadores hay N+1 hijos. El separador de índice i es el límite inferior del hijo derecho correspondiente. Las hojas enlazan sus sucesoras mediante `next_leaf`.

Un nodo interno unario tiene cero separadores y un único hijo (`first_child`). Es estructuralmente decodificable, pero no debe convertirse en el estado final normal de un nodo no raíz después de un borrado.

## Propagación requerida

1. Buscar la clave y conservar el camino completo desde la raíz hasta la hoja: ID, generación, nivel, hijo inicial, separadores y posición del hijo elegido.
2. Eliminar la entrada en memoria. Si la hoja conserva entradas, escribir solo la hoja y confirmar.
3. Si la hoja queda vacía, intentar redistribuir desde un hermano inmediato del mismo padre:
   - Izquierda: mover la última entrada de la hoja izquierda a la hoja vacía y reemplazar el separador del padre por la nueva primera clave del hijo derecho.
   - Derecha: mover la primera entrada de la hoja derecha a la hoja vacía y actualizar el separador del padre a la nueva primera clave de la hoja derecha.
4. Si ningún hermano puede donar, fusionar con un hermano inmediato del mismo padre, corregir `next_leaf`, retirar el separador y marcar la página descartada como MBFR.
5. Si el padre queda con al menos un separador, escribirlo y terminar. Si queda sin separadores:
   - Si es la raíz, contraerla a su único hijo, liberar la antigua raíz y actualizar MBTR.
   - Si no es la raíz, propagar el underflow al nivel interno superior.

## Redistribución de nodos internos

La redistribución debe mover un hijo y un separador, no solo una clave:

- **Donación desde la izquierda:** el último separador del hermano izquierdo sube al padre; el separador antiguo del padre baja al inicio del nodo deficitario. El antiguo `right_child` del último separador izquierdo pasa a ser el `first_child` del nodo deficitario.
- **Donación desde la derecha:** el primer separador del hermano derecho baja al final del nodo deficitario junto con el `first_child` anterior del hermano derecho como hijo derecho; el separador del padre se reemplaza por el primer separador antiguo del hermano derecho y el `first_child` del hermano derecho pasa a ser el `right_child` de ese separador que subió.
- Validar nivel idéntico, generaciones esperadas, orden estricto de separadores y que ningún hijo quede duplicado o huérfano.

## Fusión de nodos internos

Para fusionar un nodo interno deficitario con un hermano del mismo padre, el separador que estaba en el padre debe insertarse entre las entradas de ambos nodos. No se puede concatenar únicamente las listas de separadores:

- Fusión hacia izquierda: `left.entries + parent_separator + underflow.entries`; el `first_child` permanece el del hermano izquierdo.
- Fusión hacia derecha: `underflow.entries + parent_separator + right.entries`; el `first_child` permanece el del nodo superviviente izquierdo.
- Retirar del padre la entrada que separaba ambos nodos, liberar la página descartada en MBFR y propagar el posible underflow del padre.
- Comprobar que el nodo fusionado cabe en una página antes de modificar el conjunto de cambios. Si no cabe, debe redistribuirse o devolverse un error sin escribir.

## Estado del código auxiliar

`plan_internal_rebalance()` implementa la decisión local para un nodo interno deficitario: valida que el ID coincida con la posición del hijo, intenta préstamo desde izquierda/derecha solo si el donante conserva al menos un separador, y si no puede prestar prepara una fusión hacia izquierda o derecha. Devuelve las imágenes lógicas de nodos afectados, los separadores del padre actualizados, la página superviviente y la página candidata a liberar. Codifica los nodos antes de devolver el plan para detectar fusiones que exceden el tamaño de página.

El planificador no lee páginas ni confirma transacciones. `stage_internal_rebalance_plan_overlay()` integra las imágenes de nodos y padre en `PageOverlay`, valida niveles, referencias actuales, superviviente y página liberada, y permite coalescer una página modificada previamente y liberarla con una única imagen MBFR final. `PageOverlay` representa cada ID mediante una sola entrada `OverlayPageState` en un `BTreeMap`, con estados mutuamente excluyentes para páginas existentes vivas/libres, libres reutilizables y asignaciones nuevas vivas/libres. `PageOverlay::validate()` se ejecuta antes del commit y comprueba continuidad de asignaciones, generaciones, tamaños, coherencia MBFR, enlaces a páginas staged vivas y consistencia de `root_id`/`free_head`. El reparador vuelve a resolver los padres contra la vista staged, no contra índices capturados antes de las fusiones.

## Cruce de límites de padre

Un nodo puede carecer de hermano local porque su padre solo tiene un hijo. No se debe intentar buscar un hermano de hoja fuera de ese padre de forma aislada. Primero se debe rebalancear/fusionar el padre con un hermano del nivel superior; al combinar los nodos internos, sus hijos pasan a compartir un mismo padre y entonces puede resolverse el underflow inferior. Este proceso puede repetirse hacia la raíz.

La implementación debe modelar el camino completo como nodos mutables en memoria y propagar desde abajo hacia arriba, o usar un plan explícito de cambios que reconstruya el tramo afectado. No debe escribir cambios parciales mientras todavía puede fallar una validación de capacidad o de estructura.

## Atomicidad y páginas libres

- Preparar todos los nodos modificados y liberados antes de llamar a `DurablePages::transaction`.
- Rechazar IDs repetidos en el plan, páginas liberadas que sigan referenciadas, ciclos en `free_head` y generaciones agotadas.
- Cada página reutilizada/liberada cambia generación conforme al protocolo MBFR.
- Escribir raíz, nodos, enlaces de hojas y lista libre en una sola transacción.
- Actualizar el estado en memoria solo después del COMMIT exitoso.
- Tras reabrir, `validate()` debe confirmar árbol, enlaces y cobertura exacta de páginas vivas/libres.

## Pruebas de aceptación obligatorias

1. [x] Eliminar hasta vaciar una hoja cuyo padre es unario y tiene hermano interno disponible en el nivel superior; hay pruebas de fusión y donación.
2. [x] Cubrir las rutas de redistribución desde izquierda y derecha, además de fusiones hacia ambos lados.
3. [x] Redistribuir nodos internos desde ambos lados, verificando hijos y separadores mediante pruebas de integración y validación estructural.
4. [x] Fusionar nodos internos incorporando el separador del padre y comprobar la contracción de raíz.
5. [x] Ascender por varios ancestros unarios y contraer cadenas de raíces; hay pruebas de propagación multinivel y contracción de una cadena de raíces.
6. [x] Escribir secuencias deterministas de inserción/borrado contra un mapa ordenado de referencia, comparando las entradas y ejecutando `validate()` después de cada borrado; incluye una permutación de borrado multinivel con reaperturas periódicas.
7. [x] Cerrar y reabrir después de fusiones/redistribuciones; verificar claves y lista libre. Una prueba fuerza una división de hoja posterior y comprueba que reutiliza una página interna liberada sin ampliar el archivo.
8. [x] Cobertura escrita de fallos antes del primer byte y en límites parciales/completos de BEGIN, cabecera/payload de varios IMAGE y cabecera COMMIT; sync fallido después del COMMIT completo; apply parcial; y fallos de checkpoint antes y después del truncado. La nueva prueba multi-página recorre 18 cortes de WAL sobre dos sobrescrituras y exige conservar ambas versiones anteriores o recuperar el COMMIT completo, nunca una mezcla. Pendiente ejecutar la matriz en CI.

Las marcas indican cobertura de pruebas escritas, no ejecución exitosa. GitHub Actions está creando los jobs, pero en las ejecuciones observadas Windows y Ubuntu terminan antes de iniciar un runner (runner_id=0 y cero pasos); macOS queda en cola. Por ello todavía no hay resultado de compilación ni de tests.

## Integración parcial de propagación ascendente

El método que procesa una fusión de hoja ahora recibe el camino restante de ancestros. Si el padre de la hoja queda unario y no es raíz, asciende por los ancestros unarios hasta encontrar un padre con hermano interno del mismo nivel. En ese punto usa `plan_internal_rebalance()` para redistribuir desde izquierda/derecha o fusionar incorporando el separador del padre. Si la fusión deja al padre sin separadores, continúa ascendiendo. Cuando la raíz queda unaria, la contrae; en la ruta de ancestros unarios también colapsa la cadena de raíces internas vacías.

Las páginas internas supervivientes, páginas MBFR liberadas y metadata de raíz/free_head se agregan a la misma lista de cambios que la hoja y se confirman con una única transacción MLPJ. Si una validación, lectura, codificación o fusión por capacidad falla antes del COMMIT, no se publican cambios parciales.

Pruebas de integración escritas cubren fusión interna con contracción de raíz, donación desde el hermano interno izquierdo y derecho, y ascenso a través de varios ancestros unarios hasta un hermano superior, incluyendo reapertura y `validate()`.

**Reparación descendente incorporada:** después de la propagación ascendente, `remove()` importa las imágenes a `PageOverlay`, vuelve a resolver los padres de los IDs capturados en el camino y repara nodos internos unarios que ahora tienen hermanos del mismo nivel. Después intenta reparar la hoja vacía, siguiendo la hoja superviviente si una fusión crea otro candidato vacío. Repite barridos acotados hasta que no haya cambios. Las referencias, enlaces `next_leaf`, páginas liberadas y metadata se mantienen en la misma transacción MLPJ. La reparación se limita al camino afectado; no garantiza ocupación mínima global ni compactación completa.

## Comportamiento de hojas vacías y límite de compactación

Se retiró la restricción artificial que impedía eliminar hojas situadas bajo padres de nivel mayor que 1. El borrado local de hoja puede ejecutarse en cualquier nivel. Si el padre es un nodo interno unario no raíz y no existe hermano local para la hoja, se conserva la hoja vacía mientras el underflow interno asciende por los ancestros. Cuando el nivel superior se redistribuye o fusiona, la hoja vacía continúa alcanzable, pero todavía no se ejecuta una pasada descendente para compactar todos los niveles afectados.

Una hoja vacía sigue siendo válida temporalmente mientras se planifica la propagación ascendente. La pasada descendente vuelve a localizarla en el overlay y, si aparece un hermano hoja bajo el mismo padre, redistribuye o fusiona; valida `next_leaf` antes de modificar enlaces y no libera páginas todavía referenciadas. Si no aparece un hermano local válido, conserva la hoja vacía para mantener el árbol alcanzable. La compactación global y la ocupación mínima completa siguen pendientes.

## Límite actual

El código integra redistribución/fusión local de hojas, propagación ascendente de underflow interno y una segunda pasada descendente acotada, con liberación de páginas y contracción de raíz en una transacción MLPJ. `PageOverlay::validate()` comprueba el plan lógico antes de persistirlo. Permanecen pendientes la ocupación mínima global, la compactación y el buffer pool. La matriz de fallos MLPJ ya tiene cobertura escrita para BEGIN/IMAGE/COMMIT, apply y checkpoint; falta ejecutarla en CI y corregir cualquier fallo real que aparezca. Este documento describe trabajo integrado y límites pendientes; las pruebas están escritas, pero no se han ejecutado.

## Diagnóstico explícito de ocupación

`occupancy_diagnostics()` informa hojas no raíz vacías, internos no raíz unarios y raíces internas unarias sin modificar el árbol. Añade conteo de nodos no raíz por tipo, bytes totales de payload codificado y tamaños mínimo/máximo por tipo, sin imponer un umbral de ocupación arbitrario a entradas de longitud variable. La prueba dirigida comprueba primero que un árbol sano de dos hojas no tiene déficits y que sus tamaños/bytes coinciden con las páginas reales; luego deja vacía la hoja izquierda mediante una imagen de página válida y verifica que `validate()` aún acepta la estructura alcanzable, el diagnóstico detecta exactamente una hoja vacía y los tamaños/bytes reflejan el cambio. Esto mejora la medición de la deuda de compactación, pero no completa la reparación ni garantiza ocupación mínima global. La prueba está escrita y pendiente de ejecución en CI.


### Contraste del diagnóstico con el recorrido validado

El estrés multinivel de 40 lotes mixtos ahora contrasta tras cada lote y reapertura el inventario de páginas no raíz de `occupancy_diagnostics()` con `validate()`: descuenta explícitamente la metadata, la raíz y las páginas MBFR, y comprueba que los tamaños mínimo/máximo estén presentes exactamente cuando existe cada tipo de nodo. Esto valida la contabilidad del diagnóstico a través de splits, fusiones, reutilización y recovery; no establece todavía una ocupación mínima por bytes ni reemplaza la reparación global.


### Eliminación pública de una clave ausente

Se añadió una regresión de `remove()` público sobre un árbol con dos claves: una búsqueda ausente situada entre ambas debe devolver `false` sin cambiar longitudes de MLPG/MLPJ, cantidad de páginas, raíz, altura ni generaciones de metadata/raíz. La prueba vuelve a abrir el árbol y verifica que ambas claves originales permanecen y que la ausente sigue sin existir. Esto protege la propiedad de que una operación sin efecto no emite escrituras durables ni consume generaciones.
