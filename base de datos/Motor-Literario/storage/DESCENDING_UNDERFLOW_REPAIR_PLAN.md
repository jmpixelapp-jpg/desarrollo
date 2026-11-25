# Plan de reparación descendente de underflow en el B+Tree

Estado: reparación local staged integrada en `remove_in_session()` y reparación global explícita mediante `PersistentBPlusTree::repair_occupancy()`. La antigua ruta de eliminación por `Vec<PageChange>` fue retirada. No habilita el uso del almacenamiento para manuscritos; faltan cobertura generativa exhaustiva, pruebas de recuperación del mantenimiento global y ejecución real de la suite.

## 1. Situación confirmada en el código

`PersistentBPlusTree::remove()` público crea una `MutationSession` y delega en `remove_in_session()`. La eliminación stagea la hoja en el `PageOverlay`; si queda vacía, ejecuta reparación local de hoja y una pasada acotada sobre los nodos internos del camino original. La reparación resuelve padres de nuevo contra la raíz staged, puede redistribuir o fusionar nodos internos, liberar páginas MBFR y contraer raíces unarias en la misma sesión. La rutina anterior `stage_parent_after_leaf_merge()` y su helper privado de liberación fueron retirados para que no quede una segunda implementación disk-only que contradiga la ruta pública actual.

La reparación local durante cada borrado sigue sin garantizar ocupación mínima global. La nueva operación `repair_occupancy()` recorre todos los nodos, captura candidatos en orden postorden, vuelve a resolver sus padres sobre un único overlay y repite las reparaciones hasta converger; todas las páginas y metadata se publican en un único commit MLPJ. Si la preparación falla, el overlay se descarta. `validate()` comprueba referencias, niveles, separadores y cadena de hojas, mientras `occupancy_diagnostics()` permite medir los déficits antes y después del mantenimiento.

## 2. Separación entre borrado local y mantenimiento global

`remove()` no ejecuta una compactación global: su reparación sigue limitada al camino afectado y a los hermanos inmediatos.

`repair_occupancy()` es una operación explícita de mantenimiento. Recorre el árbol completo, recoge hojas vacías y nodos internos unarios, procesa primero los candidatos internos en orden postorden, vuelve a resolver los padres después de cada cambio y repite hasta que una pasada completa no produzca reparaciones. Toda la operación comparte un `MutationSession` y un único commit MLPJ; no hay publicación parcial de las páginas staged.

## 3. Información que debe conservar el borrado

Durante el descenso inicial, registrar para cada nivel:
- page_id del nodo visitado;
- nivel esperado;
- hijo elegido;
- si el nodo estaba unario;
- page_id del hijo deficitario o potencialmente deficitario;
- generación original observada.

Los identificadores de página son la identidad estable durante la operación. No conservar como autoridad los índices de hijo originales: una rotación o fusión superior puede cambiar los índices y separadores.

Al terminar la fase ascendente, conservar una lista ordenada de page_id que requieren revisión descendente. La lista debe deduplicarse y no incluir páginas que hayan sido liberadas.

## 4. Resolución de padres después de la fase ascendente

Antes de reparar cada candidato:
1. Comprobar que el page_id sigue dentro del rango físico.
2. Comprobar que no aparece en la lista libre staged.
3. Resolver de nuevo su padre recorriendo el árbol desde la raíz vigente de la operación, usando los child pointers actuales.
4. Verificar que el candidato aparece exactamente una vez como hijo.
5. Verificar que padre e hijo tienen niveles consecutivos.
6. Si el candidato ya no es deficitario o es la raíz, omitirlo.

No reutilizar el padre ni el child_index capturados antes de las fusiones. Una fusión superior puede haber cambiado la ruta.

## 5. Reparación local descendente

Para un nodo interno candidato:
- Si tiene al menos un separador, no requiere reparación por unariedad.
- Si es unario y tiene hermano izquierdo o derecho bajo el padre recién resuelto, intentar préstamo de un hermano con más de un separador.
- Preferir una política determinista: izquierdo primero y derecho después, consistente con el planificador actual.
- Si ningún hermano puede donar, fusionar con el hermano adyacente que produzca un nodo codificable.
- Incorporar siempre el separador del padre entre los rangos de hijos.
- Si el nodo fusionado no cabe en una página, no confirmar una fusión parcial. Devolver un error de planificación antes de escribir el WAL.
- Si el padre pierde un separador, marcarlo como nuevo candidato ascendente y procesarlo antes de continuar hacia niveles inferiores.

Para una hoja vacía:
- Solo fusionar si ahora tiene un hermano hoja bajo el mismo padre y el enlace `next_leaf` confirma el orden físico-lógico.
- Si un hermano tiene entradas, redistribuir una entrada cuando eso restablezca el mínimo definido.
- Si ambos no pueden donar, fusionar y actualizar el enlace de hojas.
- Nunca dejar una referencia de hoja apuntando a una página liberada.

## 6. Orden de ejecución

La operación debe tratarse como un plan sobre una imagen lógica staged:

1. Leer y validar el camino original.
2. Preparar la eliminación y la fusión/redistribución de hoja.
3. Ejecutar propagación ascendente.
4. Construir el conjunto de candidatos descendentes que quedaron desbloqueados por las fusiones superiores.
5. Resolver cada candidato contra la estructura lógica resultante, no contra el disco original.
6. Reparar de arriba hacia abajo dentro de los subárboles afectados, recalculando la ruta después de cada cambio de padre.
7. Contraer raíces unarias al final y actualizar `root_id`/nivel.
8. Validar el plan completo en memoria: unicidad de page_id, generaciones, referencias, separadores, niveles, enlaces de hojas y lista libre.
9. Escribir BEGIN, imágenes y COMMIT MLPJ una sola vez.
10. Aplicar imágenes y actualizar el estado en memoria solo tras el commit durable.

La dirección descendente significa que la reparación parte del nivel más alto que acaba de cambiar y se propaga hacia los descendientes afectados. Si una reparación inferior vuelve a quitar un separador de un padre, ese padre debe volver a la cola de trabajo ascendente antes de finalizar.

## 6.1. Primera primitiva incorporada: resolución estable de padre

Se añadió a `PersistentBPlusTree` el helper privado `resolve_parent(target_id)`. Recorre desde la raíz confirmada usando los punteros actuales y devuelve `parent_id`, nivel del padre e índice actual del hijo. La búsqueda rechaza candidatos fuera de rango, nodos no alcanzables, ciclos/hijos compartidos, niveles incorrectos y más de una aparición del mismo page_id. La raíz devuelve `None` porque no tiene padre.

Esta primitiva evita depender de un `child_index` capturado antes de fusiones. Se añadió además `resolve_parent_with_overlay()`: consulta primero `PageOverwriteSet`, admite metadata de raíz staged, comprueba el nivel del candidato y rechaza cualquier ID incluido en el conjunto explícito de páginas liberadas. Una prueba cambia la posición de un hijo solo en la imagen staged y demuestra que el resolver usa esa imagen, no la raíz antigua de disco; también comprueba el rechazo de una página liberada.

Se incorporó `PageOverlay` como vista lógica transaccional con un único `BTreeMap<page_id, OverlayPageState>` y estados mutuamente excluyentes (`LiveExisting`, `FreedExisting`, `ReusableExisting`, `LiveAllocated`, `FreedAllocated`): representa sobrescrituras coalescidas, páginas liberadas, páginas MBFR registradas después de validar su codec y asignaciones nuevas contiguas. Permite reutilizar una MBFR registrada avanzando exactamente una generación, informa el siguiente elemento de la lista libre y genera una lista unificada de `PageChange`. El resolver de padres consume esta vista, admite candidatos recién asignados y usa el límite lógico de páginas, no solo el tamaño físico anterior. Para limitar el coste, recorre los niveles superiores necesarios y se detiene al alcanzar el nivel de los padres candidatos; no desciende por los subárboles inferiores después de encontrar ese límite. También se añadió `stage_internal_rebalance_plan_overlay()`: incorpora al overlay los nodos modificados y el padre, mantiene una única imagen por página, valida los niveles físicos/staged, exige que los nodos del plan sean hijos actuales del padre, rechaza IDs hijos duplicados y exige que el padre resultante apunte al superviviente. Puede coalescer una página previamente modificada y liberarla como una sola imagen MBFR final. Sobre esa base se implementó `repair_descending_internal_underflows()`, una segunda pasada acotada a IDs candidatos: vuelve a resolver cada padre en el overlay vigente, inspecciona hermanos del mismo nivel y aplica préstamo o fusión solo cuando el candidato interno sigue unario. Una prueba cubre el caso de un nodo unario que ahora tiene un hermano donante bajo el padre actualizado. Dos pruebas construyen un padre con tres hijos y fuerzan, por separado, la redistribución desde el hermano derecho y desde el izquierdo para el hijo central. Verifican que el hermano no donante permanece intacto, que el separador correcto del padre se sustituye por el del donante y que el separador anterior desciende al nodo reparado. Una tercera prueba cubre la fusión del hijo central hacia el hermano izquierdo cuando ninguno de los hermanos puede donar: el separador izquierdo del padre baja al nodo superviviente, el separador derecho permanece en el padre y la página retirada se registra en MBFR. Esto cubre el índice intermedio en ambas direcciones de préstamo y en la fusión hacia la izquierda. Se añadió además un escenario con cuatro nodos internos unarios bajo el mismo padre: dos candidatos distintos se fusionan en una sola pasada, el padre conserva la estructura esperada y las dos páginas retiradas forman una cadena MBFR encadenada en orden LIFO (`segunda liberada → primera liberada → fin`). El overlay se valida con la nueva cabeza de lista libre antes de extraer las imágenes finales. Otro escenario integrado fuerza una cascada de tres niveles: una fusión de nodos internos deja un padre unario, este se fusiona con su hermano y la raíz se contrae. Comprueba la cadena MBFR (raíz retirada → padre hermano retirado → nodo inferior retirado → antigua raíz inicial), confirma una sola transacción y simula un fallo después de aplicar solo dos imágenes tras el COMMIT durable. Al reabrir, MLPJ debe completar la recuperación, validar los registros y reutilizar la antigua página raíz como nueva hoja sin aumentar el archivo; una segunda reapertura comprueba el resultado. Otras pruebas cubren préstamo staged y fusión staged que libera al donante. Si esa fusión deja a la raíz con un solo hijo, el adaptador staged convierte la raíz antigua en MBFR, encadena correctamente las páginas liberadas y actualiza `root_id`, nivel y `free_head` en la misma vista transaccional; se añadió una prueba con raíz y páginas ya persistidas. Las transiciones de estado incompatibles o generaciones distintas para el mismo `page_id` se rechazan al stagear; una prueba cubre ese conflicto. La vista ahora expone `validate()` y `remove()` la ejecuta inmediatamente antes del commit: verifica que las asignaciones cubran un rango contiguo desde `base_page_count`, que tengan generación inicial 1, que los payloads respeten el tamaño de página, que cada estado marcado libre tenga una imagen MBFR final válida, que ninguna imagen MBFR se presente como viva y que los enlaces MBFR no sean cero, autorreferentes, no apunten a páginas staged vivas, no formen ciclos entre páginas staged ni salgan del rango lógico. También valida que la metadata staged no sitúe la raíz en una página libre, que `free_head` no apunte a una página staged viva y que raíz y cabeza de lista libre no sean el mismo ID. Se añadieron trece pruebas específicas para transiciones contradictorias, asignación liberada dentro de la misma transacción, reutilización de páginas previamente liberadas y de asignaciones nuevas, rechazo de MBFR como imagen viva, generaciones incompatibles, enlaces libres a páginas reutilizadas, metadata con `free_head` inválido ciclos en cadenas MBFR staged y desbordamiento de generación al consumir `free_head`. La lista de candidatos incluye además nodos que se liberan durante la propia pasada y repite IDs ya procesados; la reparación debe omitirlos sin volver a escribirlos ni liberar dos veces la misma página.

**Límites actuales:** `remove()` conserva los IDs del camino original, importa las imágenes de la pasada inicial a `PageOverlay` y ejecuta la reparación descendente de nodos internos y de la hoja vacía cuando hay candidatos; todas las eliminaciones, incluso las que no requieren reparación, validan el overlay final antes de confirmar una sola transacción MLPJ. El conjunto de candidatos se limita a los nodos internos visitados originalmente y a la hoja eliminada. La primera pasada de reparación todavía prepara algunos cambios antes de importarlos al overlay, por lo que la arquitectura no es aún un motor batch general. `allocate_node()` integra ahora el overlay en `insert()`: importa los cambios recursivos existentes, verifica el contador lógico de páginas, registra el MBFR persistido de `free_head` cuando corresponde, consume la cabeza y vuelve a emitir el conjunto coalescido de `PageChange`. Antes del commit MLPJ, `insert()` importa nuevamente todas las imágenes finales, incluida MBTR, y valida la metadata de raíz/lista libre junto con los estados de página. Las pruebas existentes de split con reutilización cubren esta ruta; las pruebas específicas del overlay cubren reutilización de páginas liberadas dentro de la misma transacción y de asignaciones nuevas. El overlay usa una única tabla de estado por `page_id`; `remove()` importa en ella las imágenes de su primera pasada y `insert()` la utiliza al reservar nodos. La primera pasada de reparación aún prepara inicialmente algunos cambios con `Vec<PageChange>` antes de importarlos al overlay. Hay pruebas escritas de modelo de referencia, borrados multinivel, reaperturas y reutilización, pero no se han ejecutado por falta de runners funcionales. Faltan pruebas de recuperación con fallos inyectados, pruebas profundas adicionales de ocupación y ejecución real en Windows, Linux y macOS. No debe invocarse aún como almacenamiento de producción.

## 7. Acumulador único de imágenes

La implementación actual de `PageOverwriteSet` ya coalesce varias imágenes de una página conservando la generación original esperada. La segunda pasada debe convertirlo en el acumulador de toda la eliminación, no crear un segundo conjunto de escrituras.

Reglas obligatorias:
- Cada page_id aparece una sola vez en `PageChange`.
- Todas las reescrituras de una página usan generación esperada original y generación nueva original + 1.
- Una página no puede ser simultáneamente nodo vivo y MBFR.
- Una página liberada más de una vez es un error.
- `free_head` se actualiza en orden determinista; cada nueva página libre apunta al head previo.
- La metadata de página 0 se coalesce en el overlay y se confirma con las demás imágenes.
- Ningún plan parcial se entrega a `DurablePages::transaction()`.

No leer una página liberada desde disco para decidir su estado staged. El plan debe mantener un mapa de estado lógico para páginas vivas, liberadas y reutilizadas.

## 8. Pruebas obligatorias antes de aceptar la implementación

### Estructura
- Árbol de altura 2, 3 y al menos 4 con cadenas de ancestros unarios.
- Déficit inferior que inicialmente no tiene hermano local, pero sí obtiene hermano después de una fusión superior.
- Casos simétricos: candidato en hijo izquierdo, central y derecho.
- Préstamo desde ambos lados y fusión hacia ambos lados.
- Separadores grandes y nodos cercanos al límite de 4066 bytes.
- Varias reparaciones descendentes en una misma eliminación.
- Contracción de más de un nivel de raíz.

### Integridad observable
Después de cada borrado:
- `validate()` sin páginas huérfanas, duplicadas ni referencias cruzadas.
- `get()` coincide con un mapa de referencia.
- `range_iter()` coincide exactamente con el mapa, en orden.
- La cadena `next_leaf` coincide con el recorrido in-order.
- Todas las páginas físicas pertenecen al árbol o a la lista libre.

### Persistencia y reutilización
- Cerrar y reabrir después de cada caso estructural.
- Insertar después del borrado para reutilizar páginas liberadas.
- Ejecutar secuencias deterministas largas de insertar/borrar/reinsertar comparadas operación por operación con `BTreeMap`.
- Inyectar fallos antes de BEGIN, durante IMAGE, después de COMMIT y durante apply; tras reabrir, el resultado debe ser el estado anterior o el posterior completo, nunca uno parcial.

### Plataformas
La suite debe compilar y ejecutarse realmente en Windows, Linux y macOS. Un job creado pero sin runner asignado no es una prueba ejecutada.

## 9. Criterios de cierre

La segunda pasada no se considera terminada por el mero hecho de reducir el número de páginas vacías. Debe demostrarse:
- que ningún candidato afectado queda unario cuando tiene un hermano válido con el que puede redistribuirse o fusionarse;
- que todas las mutaciones de una eliminación se confirman en una única transacción;
- que no hay escrituras duplicadas ni generaciones inconsistentes;
- que los tests de modelo de referencia, recuperación y reapertura pasan en las tres plataformas.

Hasta entonces, el B+Tree sigue siendo experimental. No almacenar manuscritos reales.

- Se añadió un ciclo público generado de tres rondas con 180 claves largas y valores grandes por ronda: fuerza árbol de al menos tres niveles, mezcla eliminación e inserción mientras conviven ramas antiguas y nuevas, elimina claves ausentes, contrasta cada paso con `BTreeMap`, reabre periódicamente y vacía las páginas hasta contraer la raíz y comprobar MBFR.
- Se añadió un caso dirigido de tres raíces internas unarias encadenadas: una sola contracción debe bajar tres niveles, liberar las tres raíces en orden MBFR, preservar la hoja superviviente, persistir y reabrir; después se reutilizan dos páginas liberadas para dividir la hoja sin ampliar el archivo.
- Se añadió un caso dirigido para el primer hijo interno deficitario: al no tener hermano izquierdo ni poder recibir préstamo del hermano derecho, se fusiona hacia la derecha conservando el primer page_id; al quedar la raíz padre sin separadores, se contrae sobre el nodo superviviente. La prueba verifica el orden MBFR (raíz antigua → hermano derecho), `validate()`, búsquedas y reapertura.
- La prueba del primer hijo deficitario ahora también reabre el árbol, inserta una clave cuyo valor fuerza la división de la hoja superviviente y comprueba que se consume la cabeza MBFR sin aumentar `page_count`; una segunda reapertura confirma la persistencia de la nueva entrada y de las páginas libres restantes.
- Se añadió una prueba de recuperación del `remove()` público aislado: dos entradas grandes fuerzan una raíz interna; borrar la primera vacía una hoja, fusiona con la hermana y contrae la raíz. La prueba inyecta un fallo tras aplicar parcialmente una imagen del commit durable, exige cuarentena de la instancia, reabre dos veces y verifica el estado posterior completo, la clave superviviente, la raíz hoja y las dos páginas retiradas en MBFR. Esta cobertura complementa la prueba previa de recuperación de `apply_batch` con liberación y reutilización de páginas.

## Cobertura de recuperación añadida

Se amplió la prueba del borrado público que vacía una hoja, fusiona con su hermana, contrae la raíz y libera dos páginas. La misma secuencia ahora inyecta el fallo de apply después de 0 a 8 imágenes; cada variante exige que la instancia original quede bloqueada hasta reabrir, que redo complete el COMMIT durable y que dos reaperturas consecutivas conserven una sola clave, altura cero y las dos páginas MBFR. Esta es cobertura de prefijos de aplicación, no sustituye la matriz completa de fallos en BEGIN/IMAGE/COMMIT, sincronización ni checkpoint. La prueba está escrita; sigue pendiente ejecutarla en un runner real.


## Regresión: borrado ausente en árbol multinivel

Se añadió una prueba pública con 450 entradas grandes que fuerza al menos tres niveles. Después de checkpoint, borrar una clave ausente situada entre claves existentes debe conservar el archivo de páginas, el WAL, la cantidad de páginas, la raíz, la altura, el rango completo y todas las métricas de ocupación. `validate()` debe seguir contando las 450 entradas y, tras reabrir, la clave ausente debe continuar ausente. La prueba está escrita y pendiente de ejecución real.


## Reparación global explícita incorporada

`PersistentBPlusTree::repair_occupancy()` está implementada y cuenta con una regresión dirigida que construye y persiste una cadena de tres raíces internas unarias, además de una hoja vacía no raíz. La prueba verifica los diagnósticos previos, ejecuta el mantenimiento, comprueba la contracción hasta la hoja superviviente, cuenta cuatro páginas MBFR, reabre el árbol y confirma que una segunda ejecución es no-op. La prueba está escrita; todavía no existe resultado verificable de compilación o ejecución.
