# Transacciones atómicas de dominio en ProjectStore

Estado: primera API batch pública implementada en `ProjectStore::apply_batch`, con commit único MLPJ para lotes que producen cambios. La implementación y sus pruebas siguen pendientes de ejecución real en CI; no existe coordinación con el WAL legado.

## Objetivo

Permitir que el anfitrión envíe un conjunto ordenado de operaciones sobre claves compuestas `(project_id, table, record_id)` y que todas queden confirmadas o ninguna quede visible después de recuperación. Una llamada exitosa que produce cambios debe corresponder a un único COMMIT MLPJ; una secuencia formada solo por eliminaciones ausentes es un no-op sin COMMIT vacío. Una llamada fallida antes del COMMIT no debe modificar páginas ni metadata.

## Contratos que no se pueden relajar

1. El anfitrión sigue siendo la única autoridad para `project_id`; el motor no crea ni deduce identidades.
2. Las claves mantienen el byte de versión y la codificación actual. Un lote no puede mezclar proyectos de forma implícita: cada operación incluye su ámbito explícito y se valida antes de staging.
3. No se escribe ninguna página durante la preparación del lote. Toda lectura posterior a una operación staged debe observar el estado staged, no el disco anterior.
4. Una página aparece como máximo una vez en el vector final de imágenes MLPJ. Las sobrescrituras repetidas se coalescen conservando la generación física inicial y emitiendo una sola generación final válida.
5. Las asignaciones nuevas usan IDs contiguos; la reutilización MBFR, la actualización de `free_head`, enlaces de hojas, raíz y metadata forman parte de la misma transacción.
6. La cantidad final de imágenes debe respetar `MAX_IMAGES_PER_TX`. Si se supera, se rechaza el lote completo antes de tocar WAL.
7. La memoria pública del árbol (`root`, `meta_generation`) solo se actualiza después de que `DurablePages::transaction` confirma y aplica correctamente. Ante fallo ambiguo, la instancia se considera no reutilizable y debe reabrirse mediante el mecanismo existente. El llamador no debe reintentar el lote sobre la misma instancia ni asumir que un `Err` significa que el COMMIT no existe: debe cerrarla y reabrirla para que MLPJ determine el estado durable.
8. No se afirma coordinación con el WAL legado `Store`: el primer alcance es una transacción atómica exclusivamente sobre ProjectStore/MLPJ.

## API pública implementada

La API pública implementada usa `ProjectOperation` y `ProjectBatchResult`:

- `Put { project_id, table, record_id, value }`
- `Delete { project_id, table, record_id }`

La entrada `ProjectStore::apply_batch(operations)` devuelve resultados por operación solo después del commit. Todas las identidades se validan y codifican antes de crear la sesión del árbol. Un lote compuesto únicamente por eliminaciones de claves ausentes se define como no-op y no escribe un COMMIT vacío. La semántica de operaciones repetidas sobre la misma clave es secuencial dentro del lote: put reemplaza el valor staged; delete posterior lo elimina; put posterior lo recrea. El resultado de cada delete refleja el estado inmediatamente anterior de esa clave dentro del mismo lote.

La API está publicada, pero no debe considerarse validada para producción hasta que la suite se ejecute en CI y se completen las pruebas de límite y fallos indicadas abajo.

## Estado de implementación

- [x] Lector de páginas overlay-aware: resuelve primero `LiveExisting`/`LiveAllocated`, usa disco solo cuando no hay estado staged y rechaza páginas liberadas/reutilizables.
- [x] Lector de nodos overlay-aware: decodifica el nodo desde esa misma vista.
- [x] Pruebas de resolución de sobrescritura staged, asignación nueva, rechazo de página liberada y preservación del disco físico.
- [x] Prueba de dos modificaciones staged sobre una misma página: conserva la generación física inicial y expone el payload final.
- [x] Sesión de mutación compartida con raíz, generación metadata, overlay único y free_head staged.
- [x] Refactor de inserción: las lecturas recursivas consultan el overlay; splits, páginas nuevas y raíz staged se conservan entre operaciones de una misma sesión.
- [x] Commit de sesión centralizado: valida el overlay/lista libre y confirma una sola transacción MLPJ antes de publicar la metadata.
- [x] Prueba de varias inserciones en una sesión que atraviesan splits de hoja y raíz, seguida de validación y reapertura.
- [x] Prueba de abandono tras un error tardío: los cambios staged anteriores no alteran páginas físicas ni aparecen después de reabrir.
- [x] Integración de `remove()` público con `MutationSession`, overlay compartido, validación final y commit único MLPJ.
- [x] Primera etapa de eliminación overlay-aware: búsqueda sobre nodos staged, borrado de clave insertada en la misma sesión, coalescencia de escritura y commit único para hojas que conservan entradas.
- [x] Prueba de delete de clave ausente sin marcar la sesión como modificada.
- [x] Pruebas de remove→put sobre la misma clave, coalescencia y persistencia tras reopen.
- [x] Primera integración de underflow/hoja vacía, redistribución/fusión local, reparación descendente acotada, liberación MBFR y contracción staged de raíz.
- [x] Prueba integrada: borrar todas las claves y reutilizar páginas MBFR liberadas anteriormente en la misma sesión, sin aumentar el page_count; validar y reabrir.
- [x] Integrar reparación staged de hojas vacías y nodos internos unarios: donación desde ambos lados, fusiones con separador del padre, propagación por niveles, re-resolución de ancestros, contracción de raíz y liberación MBFR en el mismo overlay.
- [x] Cubrir mediante pruebas los casos dirigidos de redistribución izquierda/derecha de hojas e internos, fusiones a izquierda/derecha, raíz multinivel y reutilización de páginas liberadas en la misma sesión.
- [x] Añadir borrado total pseudoaleatorio de 168 claves en una única sesión, con validación de árbol vacío, ausencia de déficits no raíz, lista MBFR y reapertura.
- [x] Verificar que abandonar una sesión después de eliminar una clave staged y provocar un error de validación no modifica páginas, raíz ni datos físicos, incluso después de reabrir.
- [x] Exponer `ProjectStore::apply_batch` con operaciones `Put`/`Delete` de ámbito explícito y resultados por operación.
- [x] Prevalidar todas las identidades antes de staging; ejecutar operaciones repetidas secuencialmente en un overlay compartido y confirmar con una única llamada MLPJ.
- [x] Probar put-put-delete-put sobre la misma clave y comprobar exactamente un COMMIT; cubrir put-delete, delete-put, delete ausente, lote vacío, error de identidad tardío, valor demasiado grande después de un put staged, ámbitos intercalados y persistencia tras reopen.
- [x] Comparar un lote generado de 240 operaciones con un modelo `BTreeMap` y verificar scans por proyecto/tabla y reapertura.

- [ ] Ampliar pruebas generativas para permutaciones de borrado, límites de capacidad y árboles profundos; ejecutar y corregir cualquier fallo real que aparezca en CI. Ya se fuerza una estructura de cuatro niveles con claves máximas; se añadió una prueba batch mixta que combina eliminaciones, inserciones y una eliminación ausente sobre ese árbol, valida el resultado y comprueba la reapertura. La cobertura generativa ejecuta 720 mutaciones públicas deterministas con cuatro semillas, compara el estado completo con `BTreeMap` después de cada operación y reabre el almacén cada 45 operaciones; además, prueba 336 eliminaciones públicas en tres órdenes pseudoaleatorios, compara y valida después de cada borrado, reabre periódicamente y exige terminar con una sola hoja raíz y sin déficits no raíz. Se añadió además una prueba de capacidad exacta: una entrada ocupa los 4066 bytes de payload, se divide correctamente al insertar otra clave y se rechaza sin alterar datos un valor un byte mayor, con comprobación tras reopen. Se añadió también una sesión de 450 inserciones staged con valores de 1800 bytes que fuerza el split de la raíz interna, exige altura mínima 2 y valida/reabre el árbol completo. El codec MBTN ahora prueba además un nodo interno que ocupa exactamente 64 bytes y el rechazo de un separador que requiere 65 bytes en esa misma capacidad. El B+Tree limita ahora las claves nuevas a 4028 bytes, el máximo que puede almacenarse como separador interno en un payload de 4066 bytes; las pruebas cubren el split real de una hoja con esa clave límite, reapertura y rechazo atómico de una clave de 4029 bytes. `ProjectStore` reutiliza el mismo límite al validar las claves compuestas, antes de cualquier operación del árbol. Se amplió la cobertura para dividir un nodo interno con dos separadores máximos y para insertar tres claves máximas en el árbol: la raíz interna debe dividirse, alcanzar altura 2 y conservar búsquedas y validación tras reabrir. Se añadieron pruebas para `split_internal()` con separadores de 3000/100/3000 bytes, comprobando que se promocione el separador corto y que ambas mitades queden equilibradas por tamaño codificado; también se verifican fusiones internas izquierda/derecha con separador máximo, ocupando exactamente 4066 bytes. En MLPJ se añadieron pruebas de redo idempotente cuando el disco ya contiene una generación posterior a la primera imagen del WAL y de descarte de un frame COMMIT truncado tras BEGIN e IMAGE completos. El límite de imágenes ahora se preflighta antes de WAL; sigue pendiente la prueba de integración que exceda el millón de imágenes. Se añadió un caso de estrés estructural con cinco claves de tamaño máximo que fuerza divisiones internas sucesivas hasta una raíz de nivel 3 (cuatro niveles contando las hojas), con validación y reapertura. Se añadió además el borrado de las cinco claves máximas en orden mixto, validando y reabriendo después de cada eliminación hasta contraer la raíz. Queda ampliar la cobertura profunda con lotes mixtos mayores y más permutaciones de eliminación.
- [ ] Garantizar ocupación mínima en todos los casos o documentar explícitamente los estados deficitarios admitidos por el diseño.
- [ ] Commit único del lote y pruebas de recuperación de extremo a extremo.

La sesión permite inserciones secuenciales y eliminaciones mixtas que leen y modifican el mismo overlay, incluidas claves insertadas previamente. `remove()` público delega en `remove_in_session()` y confirma mediante el commit único de la sesión. La eliminación captura ancestros; si una hoja queda vacía, intenta redistribución/fusión local, libera páginas MBFR y actualiza separadores. La reparación descendente vuelve a resolver nodos internos unarios del camino y contrae raíces staged en los casos cubiertos. La reparación ya cubre los patrones estructurales dirigidos descritos en las pruebas, pero todavía no tiene cobertura generativa exhaustiva ni garantiza ocupación mínima global. Hay pruebas de eliminación después de splits, cambios de raíz staged, secuencias mixtas de 720 operaciones en una sesión comparadas con `BTreeMap`, y otras 720 mutaciones públicas generadas con cuatro semillas, verificadas operación por operación y con reaperturas periódicas; también borrado total pseudoaleatorio de 168 claves en una sesión, abandono seguro tras delete staged y reutilización MBFR dentro de la misma sesión, con commit único y reapertura. La API pública `ProjectStore::apply_batch` ya existe. Todavía no coordina el WAL legado ni tiene validación de CI confirmada.

## Arquitectura de implementación

### 1. Separar preparación de confirmación

Crear una sesión de mutación interna del B+Tree que capture:
- raíz y generación de metadata iniciales;
- `base_page_count` físico;
- `next_page_id` lógico;
- `free_head` staged;
- un `PageOverlay` único para todo el lote;
- un lector de páginas que resuelva primero el overlay y luego MLPG.

La sesión no puede llamar a `DurablePages::transaction` ni modificar los campos de raíz publicados.

### 2. Hacer que el algoritmo de inserción lea el overlay

El actual `insert_recursive` lee directamente `self.pages`. Debe refactorizarse para recibir la sesión y leer nodos staged cuando ya fueron modificados por operaciones previas. Esto es imprescindible: repetir la inserción actual sobre el disco produce separadores y splits incorrectos cuando varias operaciones afectan la misma ruta.

El algoritmo debe stagear hojas, padres, enlaces `next_leaf`, nodos nuevos y metadata. Las asignaciones deben consumir la misma lista libre staged durante todo el lote; no se puede reconstruir el overlay y perder el estado entre operaciones.

### 3. Integrar eliminaciones en la misma sesión

`remove_in_session()` ya recorre y modifica el overlay compartido, y puede borrar una clave insertada antes en la misma sesión sin que haya existido en disco. La reparación estructural se ejecuta sobre esa vista staged; aún falta ampliar la cobertura de casos límite antes de exponer la API batch.

### 4. Validar el estado final

Antes de producir imágenes:
- validar transiciones de estado de cada página y generaciones;
- comprobar continuidad de IDs asignados y límites de payload;
- validar raíz, nivel y metadata;
- validar cabeza y enlaces inmediatos MBFR, además de referencias staged;
- comprobar que ninguna página viva esté en la lista libre y ninguna página libre sea alcanzable desde la raíz;
- verificar enlaces de hojas afectados y orden/separadores en las rutas modificadas;
- rechazar claves/valores inválidos y lotes vacíos;
- rechazar el lote completo si excede el límite MLPJ.

La validación global del árbol puede permanecer como diagnóstico/test separado; no debe añadirse accidentalmente un recorrido O(n) a cada lote.

### 5. Commit único

Convertir el overlay validado en un único `Vec<PageChange>` sin IDs duplicados y llamar exactamente una vez a `DurablePages::transaction`. Solo tras éxito publicar la nueva raíz y generación de metadata en `PersistentBPlusTree`. Si falla la persistencia o aplicación, respetar `recovery_required`: no intentar rollback manual ni reutilizar la instancia.

## Cobertura añadida para la sesión de inserción

Además de las pruebas existentes de inserción individual, la sesión compartida ya tiene cobertura para:
- varias inserciones secuenciales que producen un split de hoja y un nuevo root dentro del mismo overlay;
- una operación posterior que atraviesa ese root staged y modifica una hoja ya staged;
- dos puts de la misma clave dentro de la sesión, donde prevalece el último valor;
- abandono de la sesión después de un error tardío, comprobando que páginas, generaciones, page_count y lectura tras reopen permanecen sin cambios.

Se añadió una secuencia determinista de 720 operaciones mixtas put/delete sobre una única sesión, comparada con `BTreeMap` y verificada tras commit y reapertura. Otra prueba añade 720 mutaciones públicas con cuatro semillas: compara el resultado completo con `BTreeMap` después de cada commit y cierra/reabre el almacén cada 45 operaciones. Una tercera prueba elimina 336 claves mediante `remove()` público en tres órdenes pseudoaleatorios, valida el modelo tras cada borrado, reabre cada 28 eliminaciones y comprueba la contracción completa a una hoja raíz sin déficits no raíz. Estas pruebas no sustituyen las pruebas pendientes de fallos WAL/COMMIT y recuperación.

## Pruebas obligatorias antes de declarar terminada la función

1. [x] Lote put-put sobre la misma clave: último valor visible; el test de integración confirma un único COMMIT MLPJ para la secuencia completa.
2. [x] put-delete de clave nueva: ausente al finalizar, sin página intermedia visible.
3. [x] delete-put de clave existente: nuevo valor visible.
4. [x] Secuencias mixtas sobre varias hojas con splits y enlaces de hojas; `generated_batch_matches_sequential_reference_and_survives_reopen` contrasta el lote de 240 operaciones con el modelo y `interleaved_namespaces_survive_multileaf_deletes_checkpoint_and_reopen` comprueba recorrido por ámbitos, checkpoint y reapertura.
5. [x] Lotes que provocan reutilización MBFR y crecimiento de raíz; `recovery_replays_project_batch_that_deletes_and_reuses_mbfr_pages` elimina 96 claves y vuelve a insertar 96 en el mismo lote, con recuperación después de COMMIT/apply parcial.
6. [x] Lotes con fusiones, redistribución y contracción de raíz; la secuencia de 96 eliminaciones seguida de 96 inserciones fuerza el vaciado y reconstrucción del árbol, y `validate()` comprueba el estado recuperado.
7. [x] Operaciones intercaladas de varios proyectos/tablas con IDs iguales: aislamiento exacto.
8. [x] Error de validación de identidad o de capacidad de valor en una operación tardía: cero cambios físicos y cero frames WAL nuevos.
9. [x] Guard de producción rechaza el recuento final de imágenes por encima de `MAX_IMAGES_PER_TX` antes de escribir WAL; la prueba unitaria cubre el límite exacto y +1 con un máximo reducido. Falta la prueba de integración con más de un millón de imágenes reales.
10. [x] Fallo inyectado antes del COMMIT durante la preparación, después del COMMIT durable y durante apply: las pruebas de error tardío comprueban que no se publica nada antes del commit; las pruebas de recuperación de `ProjectStore` comprueban que un commit durable se rehace completo tras fallo parcial de apply.
11. [x] Modelo determinista comparado con `BTreeMap`, incluyendo operaciones repetidas sobre la misma clave y reaperturas.
12. [x] `validate()` antes y después de checkpoint/reopen; cubierto por `interleaved_namespaces_survive_multileaf_deletes_checkpoint_and_reopen`.

## Orden de trabajo

1. [x] Extraer un lector de nodos overlay-aware y probar resolución staged/física.
2. [x] Refactorizar inserción para usar la sesión común; verificar varias inserciones y splits dentro de una sola sesión.
3. [x] Integrar la reparación staged acotada al camino afectado, con redistribución/fusión de hojas e internos en ambos lados, propagación multinivel, contracción de raíz y MBFR compartido. [ ] Ampliar la cobertura generativa y de límites; la reparación todavía no garantiza ocupación mínima global.
4. Añadir `apply_batch` solo cuando insert/remove individuales usen el mismo motor de staging.
5. Añadir pruebas de fallo y modelo; actualizar README y recuentos tras contar los tests reales.
6. Ejecutar CI nativa Windows/Linux/macOS antes de declarar la característica validada.

## Fuera de alcance

- Atomicidad coordinada entre MLPJ y el WAL legado `Store`.
- Cambios al formato persistido de claves o páginas.
- Compartir datos entre proyectos.
- Guardar manuscritos reales antes de superar pruebas y garantías de recuperación.


### Lotes generados y atomicidad ante error tardío

Se añadieron dos pruebas al B+Tree: 80 lotes deterministas de 12 operaciones cada uno, comparados operación por operación y en recorrido completo con `BTreeMap`, con validación y reaperturas periódicas; y un lote que modifica el overlay antes de encontrar una clave inválida, verificando que el archivo de páginas, la longitud del WAL, las lecturas y la reapertura permanecen sin cambios. Pruebas escritas, aún sin ejecución confirmada.

La cobertura de `apply_batch` también incluye ahora una operación de reemplazo de conjunto: elimina 96 registros para liberar páginas y, en el mismo lote, inserta otros 96 registros. La prueba exige que no aumente el número de páginas, valida las búsquedas y comprueba la reapertura. Aún pendiente de ejecución real.


### Recuperación del lote desde la API ProjectStore

Se incorporó un punto de fallo exclusivo de tests que deja aplicar una imagen de página después de que MLPJ haya confirmado el COMMIT durable y luego devuelve un error de apply. Una prueba invoca `ProjectStore::apply_batch` con 48 registros, comprueba que la instancia queda bloqueada y que, al cerrar y reabrir, MLPJ rehace la transacción completa y los 48 registros están disponibles. El punto de fallo no existe en compilaciones no-test. Prueba escrita, aún sin ejecución confirmada.


### Frontera de escritura del frame COMMIT

Se añadió una prueba de fallo de escritura exactamente después de persistir BEGIN e IMAGE completos y al comenzar COMMIT. La instancia activa queda bloqueada; al reabrir, la transacción incompleta se descarta, la cola se trunca a la cabecera y la siguiente transacción se confirma y sobrevive a otra reapertura. Prueba escrita, pendiente de ejecución en CI.


### Matriz ampliada de fallos MLPJ y checkpoint

Se añadieron dos pruebas MLPJ. La primera recorre cortes de escritura en BEGIN, en la cabecera y payload de IMAGE, y justo al terminar IMAGE y en distintos bytes de la cabecera COMMIT. Para cada corte verifica que el lote completo se descarta, la cola se trunca, el siguiente ID de transacción se reutiliza y una transacción posterior sobrevive a otra reapertura. La segunda inyecta un fallo de seek antes de modificar el WAL durante checkpoint: el WAL permanece byte por byte intacto, pero la instancia se bloquea conservadoramente hasta reabrir; después, el checkpoint puede completarse.

La prueba previa de checkpoint posterior al truncado ahora inyecta un fallo en la sincronización durable (`sync_all`) en vez de devolver un error artificial inmediatamente después de `set_len`. Se mantiene la verificación de que la instancia requiere reapertura y que las páginas confirmadas siguen disponibles.

Conteo actualizado: 224 pruebas unitarias escritas; 35 pertenecen a MLPJ. Son pruebas escritas y revisadas estáticamente, todavía sin ejecución confirmada.


### Recuperación de asignaciones con página final truncada

Se añadió una prueba MLPJ para una transacción confirmada de varias páginas en la que la primera página permanece íntegra y la segunda queda físicamente truncada a mitad de bloque. Al reabrir, el WAL confirmado reconstruye la última página asignada, conserva la primera y restaura el tamaño alineado del archivo. Esta cobertura complementa la recuperación de sobrescrituras confirmadas con una página truncada y la recuperación de aplicación parcial. Prueba escrita, aún pendiente de ejecución en CI.


### Recuperación de colas físicas truncadas y WAL corrupto

Se amplió la matriz de redo de páginas. Una transacción multipágina de sobrescritura actualiza dos páginas; al truncar físicamente la última, la reapertura debe conservar la primera, reconstruir la última desde la imagen WAL confirmada y mantener ambas generaciones/datos tras una segunda reapertura. Además, si una página final está truncada pero el checksum de la imagen WAL confirmada está corrupto, la apertura falla cerrada y conserva byte por byte el WAL corrupto y la cola física parcial: no repara ni trunca datos basándose en un diario no validado.

El conteo verificado en los nueve módulos es de 227 pruebas escritas, 38 en MLPJ. No existe ejecución satisfactoria confirmada todavía.


## Cobertura adicional de recuperación y exclusión

Se añadieron pruebas MLPJ para tres fronteras que faltaban en la matriz:

- Dos transacciones confirmadas seguidas por una tercera incompleta: al abrir, se rehacen los dos commits anteriores, se descarta solo la cola final incompleta y se reutiliza el siguiente ID de transacción sin perder los commits previos.
- Corrupción del COMMIT de una tercera transacción después de dos commits válidos: la apertura falla cerrada; el WAL corrupto y el archivo físico de páginas permanecen byte por byte intactos.
- Dos checkpoints consecutivos intercalados con commits: cada checkpoint deja el WAL en su cabecera, el contador se reinicia y las transacciones posteriores sobreviven a reapertura.

También se añadió una prueba B+Tree de recuperación después de COMMIT durable y apply parcial para un lote que elimina 96 claves, libera páginas MBFR y reutiliza esas páginas para 96 claves nuevas. La instancia fallida queda inutilizable; al reabrir, MLPJ rehace el lote completo, el árbol valida, las claves antiguas están ausentes y las nuevas están presentes sin crecimiento del archivo.

El guard de bloqueo ahora tiene una prueba con procesos hijos separados: el proceso hijo no puede adquirir el lock mientras el proceso padre lo mantiene y sí puede hacerlo después de que el padre libera el guard.

Conteo estático actualizado desde los nueve módulos: 232 pruebas escritas (14 WAL legado, 7 MLPG, 3 slotted pages, 9 codecs MBTN, 123 B+Tree, 24 ProjectStore, 41 MLPJ, 8 MBTR/MBFR y 3 de bloqueo interproceso). Todas siguen pendientes de compilación y ejecución verificables; el recuento no implica que compilen.


## Recovery a través de la fachada ProjectStore

Se añadió una prueba de extremo a extremo que primero crea 96 registros y después ejecuta un lote único con 96 eliminaciones seguidas por 96 inserciones. El failpoint detiene la aplicación física después del COMMIT durable y de la primera imagen; la instancia queda bloqueada hasta reabrir. La reapertura rehace el lote completo: los 96 IDs antiguos ya no existen, los 96 nuevos conservan sus valores y validate() confirma el árbol. Esta prueba complementa la prueba directa del B+Tree y comprueba el mismo caso desde la API de dominio que utilizará el motor.


## Revisión de redo y rutas de bloqueo

Se añadió una prueba MLPJ con cuatro transacciones confirmadas sobre tres páginas. Antes de recovery, una página física ya está en la generación final, otra permanece en una generación intermedia y una tercera está corrupta. El redo debe saltar generaciones antiguas sin retroceder la página más nueva, reparar la página corrupta desde imágenes confirmadas y llevar todas a la generación final; una segunda reapertura comprueba idempotencia.

La revisión del guard de bloqueo detectó que lock_path_for() intentaba canonicalizar el directorio padre antes de crearlo, por lo que las rutas bajo directorios nuevos fallaban aunque acquire_for() intentara crear esos directorios después. Se corrigió el orden: crear el padre antes de canonicalizar. Se añadieron pruebas para directorios anidados inexistentes, rutas equivalentes con .., deduplicación de rutas equivalentes en acquire_many(), rechazo de enlaces simbólicos en Unix y liberación del lock tras terminación abrupta del proceso propietario.

Conteo estático verificado en los nueve módulos: 241 pruebas escritas (14 WAL legado, 7 MLPG, 3 slotted pages, 9 codecs MBTN, 124 B+Tree, 25 ProjectStore, 44 MLPJ, 8 MBTR/MBFR y 7 de bloqueo interproceso). La prueba de enlaces simbólicos está condicionada a Unix; las pruebas siguen sin compilación ni ejecución confirmada.


También se añadió una prueba de integración que abre y reabre DurablePages usando rutas bajo directorios padre que todavía no existen. Comprueba que la adquisición de locks crea la jerarquía necesaria antes de canonicalizar y que la página confirmada sobrevive a la reapertura.


### Estrés de lotes multinivel con valores grandes

Se añadió una prueba generativa que prepara 450 registros con valores de 1800 bytes en un único overlay y exige una raíz de nivel al menos 2. Después ejecuta 40 lotes de 16 operaciones mixtas sobre un universo de 720 claves, con valores variables de 300 a 2199 bytes, reemplazos y eliminaciones repetidas/ausentes. Cada lote compara resultados y recorrido completo con BTreeMap, valida el árbol y reabre cada cinco lotes. La prueba está escrita, pero pendiente de compilación y ejecución.


### Validación final de generaciones durante recovery MLPJ

La recuperación ahora registra la última imagen confirmada de cada página mientras reproduce el WAL. Al terminar, comprueba que el estado físico coincide exactamente con esa última imagen. Esto conserva el redo idempotente cuando una transacción posterior ya estaba aplicada, pero rechaza una página con una generación superior a todas las transacciones confirmadas del diario: antes ese estado podía hacer que recovery omitiera imágenes antiguas y aceptara silenciosamente una escritura no respaldada por el WAL.

Se añadió una prueba que prepara un WAL válido con una asignación de generación 1 y una página física válida con generación 9, sin transacción que la justifique. La apertura debe fallar cerrada y conservar byte por byte tanto páginas como WAL. La prueba sigue pendiente de compilación y ejecución.


### Cobertura multi-página de fallos WAL

`page_journal.rs` añade una matriz de 18 cortes de escritura sobre una transacción que sobrescribe dos páginas existentes: antes del primer byte, dentro y en el límite de BEGIN, dentro de las cabeceras y payloads de ambos IMAGE, y dentro de la cabecera COMMIT. En cada corte se comprueba que ninguna de las dos páginas publica la nueva generación, que el WAL incompleto se descarta y que una transacción completa posterior puede confirmarse y recuperarse tras otra reapertura. La cobertura total de MLPJ también incluye el COMMIT completo con fallo de sync, apply parcial y fallos de checkpoint. Son pruebas escritas; no equivalen a ejecución confirmada.
