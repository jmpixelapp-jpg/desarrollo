# Protocolo de publicación segura de generaciones MLDB

**Estado:** implementados el selector durable de dos slots y las API de publicación/reconciliación en `publication.rs` y `migration.rs`. La integración con el backend anfitrión, la política de retención y las pruebas nativas multiplataforma siguen pendientes.

## Objetivo

Hacer visible una generación completa de ProjectStore sin sustituir primero los archivos activos ni exponer una pareja incompleta de MLPG/MLPJ. El almacén publicado se considera inmutable durante el proceso de publicación; una aplicación que lo abra para escritura deberá hacerlo después de resolver la generación activa y respetar los bloqueos interproceso.

## Estructura propuesta

Un directorio raíz de almacenamiento contiene generaciones inmutables y dos selectores:

- `generations/gen-<generation>-<migration_id>/store.pages`
- `generations/gen-<generation>-<migration_id>/store.mlpj`
- `CURRENT.0`
- `CURRENT.1`
- `GENERATION.MANIFEST` en cada generación, con tamaños y SHA-256 de ambos archivos y checksum del propio receipt;
- temporales de escritura del selector/receipt, ignorados por los lectores.

Cada selector implementado contiene magic, versión, número de generación monotónico, `migration_id`, nombre relativo exacto del directorio y checksum SHA-256. Cada directorio contiene un receipt `MLGEN001` con tamaños y SHA-256 independientes de `store.pages` y `store.mlpj`, además del checksum del receipt. La resolución simple comprueba identidad y tamaños; `resolve_current_paths`, la publicación y `verify_generation` recalculan y comparan las dos huellas completas. Los nombres de archivos son fijos: `store.pages` y `store.mlpj`. No admite rutas absolutas, separadores, segmentos `..`, NUL ni nombres arbitrarios.

## Selección y política de corrupción

El selector activo es el válido con mayor generación. Si ambos están presentes y válidos, deben pertenecer a la misma raíz de almacenamiento y la generación mayor debe ser estrictamente superior. Dos selectores de igual generación con distinto contenido son corrupción.

La publicación no puede degradar silenciosamente a una generación anterior si un selector existente es inválido: puede representar una generación publicada que recibió escrituras posteriores. El `PublicationStore` implementado falla cerrado si encuentra un selector existente pero corrupto, aunque el otro sea válido. También rechaza saltos de generación entre dos slots válidos. Un selector ausente sí es admisible durante la primera publicación o mientras se prepara el slot inactivo.

## Orden de publicación

Precondición: manifiesto en `Verified`, verificación integral completada, origen y destino abiertos por esta operación bajo sus bloqueos exclusivos. Como la copia se hace en streaming, no se exige que el destino temporal comparta volumen con la raíz.

1. Tomar un bloqueo exclusivo estable del directorio raíz.
2. Resolver y validar el selector actual; calcular la siguiente generación.
3. Crear el directorio de generación con nombre derivado de generación y `migration_id`; nunca reutilizar un nombre existente.
4. Ejecutar checkpoint y validación del ProjectStore temporal. La API de publicación recibe un préstamo mutable exclusivo, por lo que no puede haber escrituras concurrentes seguras durante la copia.
5. Copiar MLPG y MLPJ en streaming a archivos temporales dentro del directorio de generación, calcular SHA-256 de origen y copia, ejecutar `sync_all` y renombrar los temporales a los nombres definitivos. Los archivos temporales originales no se mueven ni se sustituyen.
6. Escribir `GENERATION.MANIFEST` con los tamaños y hashes SHA-256 de los dos archivos, sincronizar el receipt y el directorio.
7. Sincronizar ambos archivos y el directorio de generación; sincronizar también el directorio padre en plataformas que lo permitan.
8. Reabrir la pareja copiada como ProjectStore, validar el B+Tree y comparar todas las claves y valores byte por byte con el WAL de origen. Exigir que recuentos, bytes lógicos y fingerprint coincidan también con el manifiesto `Verified`.
9. Construir el selector completo en un archivo temporal único, escribirlo, ejecutar `sync_all`, y renombrarlo al slot inactivo, cuyo destino debe estar ausente. No reemplazar el slot activo.
10. Sincronizar el directorio raíz. Desde este punto la nueva generación está publicada.
11. Transicionar el manifiesto de `Verified` a `Published` y guardar una nueva generación durable del manifiesto.

## Recuperación de interrupciones

- Antes del paso 7: el selector anterior sigue activo; el directorio de generación incompleto es un huérfano y puede limpiarse solo después de comprobar que ningún selector lo referencia.
- Durante escritura del temporal: los lectores ignoran temporales; el selector anterior permanece activo.
- Después del rename del selector y antes de guardar `Published`: la nueva generación ya está publicada. Al reabrir, `reconcile_legacy_snapshot_publication` compara `migration_id`, resuelve la generación, la reabre, valida su estructura y compara todos sus registros contra el origen y el fingerprint/contadores del manifiesto `Verified`; si coinciden, completa la transición a `Published`. Nunca debe volver a seleccionar la generación anterior.
- Si el selector nuevo existe pero está corrupto: fallar cerrado; no retroceder automáticamente.
- Si el manifiesto indica `Published` pero el selector no referencia esa migración: corrupción; detener la apertura.
- Si existe un directorio huérfano no referenciado: no es visible. Un reintento de la misma migración puede limpiarlo únicamente después de adquirir los bloqueos de páginas/WAL, validar que no contiene nombres inesperados ni enlaces simbólicos y conservar los lockfiles persistentes.

## Compatibilidad multiplataforma

No borrar primero el selector activo. El temporal debe estar en el mismo directorio/volumen que el slot inactivo para que rename sea atómico. El reemplazo se hace solo hacia un destino ausente, evitando depender de la semántica distinta de rename sobre archivos existentes en Windows. Se requieren pruebas nativas de Windows, Linux y macOS para rename, flush, sync de directorio, bloqueo y terminación abrupta.

## Apertura del almacén publicado

La apertura verificada por descriptor está implementada y `PublicationStore::open_current_project_store()` expone una fachada pública `PublishedProjectStore` de solo lectura. Las API de working copy también están disponibles en storage, pero el `HostEngineApi` actual todavía abre sus almacenes por rutas directas. Su integración está pendiente: `PersistentLiveEngine` y `NarrativeKnowledgeStore` mantienen hoy ProjectStore separados, por lo que no se debe activar una publicación parcial ni introducir escritura dual hasta definir cómo se coordinan ambos. Una verificación previa por ruta seguida de una segunda apertura deja una ventana TOCTOU y no satisface este protocolo.

Orden obligatorio para implementar esa API:

1. Adquirir los bloqueos exclusivos de MLPG y MLPJ en orden estable antes de abrir los archivos. El bloqueo del selector debe mantenerse mientras se resuelve la generación y se adquieren ambos bloqueos de datos, para impedir que una publicación/limpieza concurrente invalide la selección.
2. Leer y validar ambos selectores, resolver solo el nombre relativo exacto permitido y leer el receipt de esa generación.
3. Abrir una sola vez los descriptores de páginas y WAL, rechazando symlinks y archivos no regulares. No cerrar ni reabrir esos descriptores entre verificación y recuperación.
4. Calcular en streaming longitud y SHA-256 leyendo esos descriptores ya abiertos. Comparar ambas huellas con el receipt antes de ejecutar cualquier operación que pueda escribir o truncar archivos.
5. Rebobinar esos mismos descriptores y transferir su propiedad a `PageFile` y `DurablePages`. La implementación no reabre los paths después de hashear.
6. Solo después de la verificación se valida la cabecera WAL y se leen/validan las páginas. Como la generación publicada exige MLPJ de 12 bytes, no se ejecuta redo ni se trunca el WAL; una cola pendiente es rechazada antes de abrir.
7. Mantener los bloqueos de datos durante toda la sesión. El `PublicationStore` conserva el bloqueo del selector/root mientras vive; el flujo interno de reconciliación mantiene ambas protecciones durante la verificación lógica.

La receipt representa exactamente el snapshot físico que se abre. La publicación ejecuta checkpoint del ProjectStore temporal antes de copiarlo; `PublicationStore::verify_generation()` y la apertura descriptor-verificada rechazan cualquier generación cuyo MLPJ no mida exactamente 12 bytes (cabecera), o cuyo MLPG no contenga al menos las dos páginas completas de metadata y raíz. Así no se puede publicar un WAL con COMMIT pendiente de redo ni un archivo vacío que provocaría inicialización y escritura al abrir. La apertura verificada rechaza cualquier WAL publicado que no cumpla ese tamaño antes de ejecutar recovery, de modo que abrir una generación inmutable no debe modificar páginas ni diario. Un almacén de trabajo que sí contenga COMMIT durable pendiente de redo debe recuperarse fuera de la generación publicada y después producir una nueva generación verificada; nunca se debe hacer redo directamente sobre una generación ya publicada. Si en el futuro se necesita publicar WAL pendiente, habrá que diseñar un protocolo explícito de recuperación a una generación nueva, conservando intacta la generación original. La generación publicada sigue siendo inmutable para escritores normales: las escrituras requieren una generación de trabajo separada y una nueva receipt.

La verificación de descriptor no evita que un actor externo con acceso de escritura ignore los bloqueos advisory y modifique el mismo inode después del hash. El directorio y los archivos de generación deben tener permisos/ACL que impidan esas escrituras no autorizadas; en sistemas que permitan compartir el archivo con escritores no cooperativos, la API debe fallar de forma segura o usar un mecanismo de snapshot/aislamiento del sistema de archivos.

No se permite que el anfitrión adivine rutas ni abra directamente archivos bajo `generations`.

## Generaciones de trabajo mutables

`PublicationStore::create_working_copy(working_id)` crea una copia lógica independiente de la generación activa bajo `working/work-<id hexadecimal>/`. El ID opaco de 16 bytes lo aporta el anfitrión; no es el `project_id` de los registros ni se interpreta como ruta. La copia se construye en un directorio temporal privado, recorriendo la generación publicada en streaming y copiando cada registro al ProjectStore nuevo. Incluye todos los espacios `project_id` de esa generación y conserva las claves compuestas sin mezclarlos. No comparte páginas, WAL ni inodes con la generación publicada.

La copia se valida, se checkpointa y recibe un `WORKING.MANIFEST` con su ID y la identidad exacta de la generación base. Solo después se cierra el almacén temporal y se renombra el directorio completo a su nombre definitivo. Un fallo antes del rename no hace visible una copia parcial; un temporal dejado por una interrupción no se reutiliza automáticamente. `open_working_copy(working_id)` valida el directorio, el manifiesto y los archivos antes de reabrir el ProjectStore mutable mediante `ProjectStore::open_existing`, que nunca crea un archivo ausente y recupera únicamente el WAL propio de esa copia. `open_or_create_working_copy(working_id)` reanuda la copia completa si existe o crea una nueva desde la generación activa; nunca interpreta un temporal abandonado como una copia válida. El anfitrión debe conservar el ID opaco para reanudar la misma copia.

`WorkingProjectStore` permite mutaciones y checkpoint exclusivamente sobre esa copia. La generación base sigue siendo inmutable. `PublicationStore::publish_working_copy(working, publication_id)` consume la sesión, exige que su generación base siga siendo exactamente la activa, checkpointa y valida la copia, crea una nueva generación inmutable, verifica el receipt y compara todos los registros byte por byte antes de avanzar `CURRENT`. Una working copy basada en una generación anterior se rechaza como obsoleta; no hay merge ni rebase automático. Tras publicar, debe crearse una nueva working copy desde la generación activa para continuar trabajando. La política de eliminación/retención sigue pendiente; las generaciones de trabajo no se borran automáticamente.

## Limpieza y retención

La limpieza de generaciones antiguas es una operación separada. Debe conservar al menos la generación activa y la anterior hasta contar con política explícita de backup/retención. Antes de eliminar una generación, comprobar que ningún selector válido la referencia y que no hay procesos con sus archivos abiertos. Nunca borrar automáticamente un destino porque la importación haya fallado.

## Pruebas obligatorias antes de habilitar

- publicación inicial y actualización de generación;
- crash antes/después de cada sync y rename;
- selector temporal truncado, selector inactivo ausente y selector existente corrupto;
- corrupción de la generación activa: fail-closed, sin rollback;
- crash entre publicación y transición `Published`, seguido de reconciliación;
- manifiesto `Published` sin selector correspondiente;
- rutas maliciosas, symlinks y archivos no regulares;
- bloqueo entre procesos y apertura concurrente;
- pruebas de filesystem nativas Windows/Linux/macOS;
- pruebas de que una generación nunca queda visible con solo uno de los dos archivos.

La API de publicación implementada mantiene un guard de snapshot del WAL de origen durante toda la comparación y transición, evitando escrituras concurrentes del mismo Store. Cada generación lleva un receipt con tamaños y SHA-256 de páginas/WAL; el selector comprueba la identidad y tamaños y la publicación vuelve a calcular los hashes completos. Copia (no mueve) el destino temporal y solo activa el selector después de validar íntegramente la copia. Si se reintenta una generación huérfana, toma los bloqueos de sus archivos, elimina únicamente los archivos de datos/temporales conocidos y conserva los lockfiles persistentes. El backend anfitrión todavía debe integrarse con la resolución del selector; no debe abrir archivos temporales por su cuenta. Hasta completar esa integración y las pruebas multiplataforma, no activar ni sustituir bases fuera de esta API.
