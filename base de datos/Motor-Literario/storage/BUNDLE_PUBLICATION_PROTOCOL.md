# MLDB — publicación atómica de bundle narrativo

## Estado

Diseño de protocolo para coordinar los dos almacenes que hoy usa `HostEngineApi`:
- estado vivo del editor (`PersistentLiveEngine`);
- conocimiento narrativo (`NarrativeKnowledgeStore`).

**Estado parcial avanzado:** `bundle.rs` contiene codecs, selector raíz `BundlePublicationStore`, verificación de ambos miembros, `PublishedBundle`, creación/reapertura de `WorkingBundle` y `publish_working_bundle()` con un único commit de selector. `HostEngineApi::open_working_bundle()` conserva el lock de sesión y `into_working_bundle()` cierra el worker y devuelve la sesión para publicación. Se añadieron regresiones para exclusión de sesiones de anfitrión, permisos privados Unix, temporales de creación abandonados y fallos inyectados antes del hard link, inmediatamente después, tras retirar el temporal y después de sincronizar el directorio raíz: la reapertura debe recuperar respectivamente la generación anterior o el bundle nuevo completo. Se añadió `inspect_unreferenced_generations()`: inventaría directorios sin referencia desde ambos slots y desde las bases de working bundles válidas, sin borrar nada; ante metadatos ambiguos falla cerrado. También comprueba el lock de cada working bundle y separa las sesiones activas de las inactivas en el inventario. Esa clasificación es solo una observación puntual: no autoriza borrado, porque una sesión podría abrirse inmediatamente después. El inventario exige que el archivo de lock exista y sea regular/privado; si falta o es ambiguo, falla cerrado sin recrearlo. También valida el manifiesto, los directorios `live/` y `knowledge/` y los cuatro archivos MLPG/MLPJ de cada working bundle definitiva; un miembro ausente, no regular, no privado o con hardlinks invalida el inventario completo y nunca se reconstruye. Además, rechaza entradas con nombres no reconocidos dentro de `working/` y `generations/`, en lugar de ignorarlas y producir un inventario potencialmente incompleto. Al clasificar una generación completa como huérfana, el inventario captura la identidad y metadatos del directorio y los vuelve a comprobar después de verificar sus receipts y miembros; si detecta sustitución o cambios durante la inspección, falla cerrado. Esta comprobación reduce ventanas de carrera, pero no sustituye una futura recolección basada en descriptores y locks adecuados. Los temporales de selector también se leen bajo una comprobación de identidad y metadatos antes/después; una sustitución concurrente hace fallar el inventario. Se permite el hardlink temporal esperado con un slot durante la recuperación, pero nunca se adopta como autoridad ni se elimina automáticamente. Antes y después del recorrido se capturan y revalidan además la identidad y los metadatos de los contenedores `working/` y `generations/`; se detectan entradas añadidas/eliminadas, sustituciones y cambios de existencia durante la inspección. Si cualquiera cambia, el inventario completo falla cerrado. Esta protección de contenedor complementa —no sustituye— la verificación individual de cada working bundle, generación y archivo. Para cada working bundle, el inventario captura además identidad y metadatos de su directorio, `live/`, `knowledge/`, manifiesto, cuatro archivos MLPG/MLPJ y lock de sesión; vuelve a validarlos al terminar la clasificación de la sesión. Una sustitución o modificación detectada invalida el inventario completo, sin reparar ni modificar la sesión. Los directorios temporales de working bundle también quedan sujetos a una comprobación de identidad y metadatos después del recorrido; su nombre y tipo iniciales no bastan para clasificarlos si fueron sustituidos durante la inspección. La eliminación física sigue deshabilitada hasta definir retención y confirmación explícita. Sigue pendiente la validación real con `cargo test`/`cargo check`.

## Decisión

Mantener dos `ProjectStore` físicos e independientes y añadir una raíz de publicación de bundle con un único selector durable. No compartirlos mediante un `Arc<Mutex<ProjectStore>>`: el worker de edición y la API de conocimiento tienen ciclos de ejecución distintos; un mutex común podría introducir contención de conocimiento en el camino crítico de persistencia de deltas.

Un bundle contiene exactamente dos miembros obligatorios:
1. `live`: páginas y WAL del estado vivo;
2. `knowledge`: páginas y WAL del conocimiento narrativo.

Ambos miembros pertenecen al mismo `project_id`, `generation_id` y `working_id`. Los namespaces/tablas internos no se mezclan ni se reescriben.

## Estructura lógica

```text
bundle-root/
  LOCK
  CURRENT.0
  CURRENT.1
  generations/
    bundle-gen-N-<id>/
      BUNDLE.MANIFEST
      live/
        store.pages
        store.mlpj
        GENERATION.MANIFEST
      knowledge/
        store.pages
        store.mlpj
        GENERATION.MANIFEST
  working/
    <working-id>/
      WORKING.MANIFEST
      live/store.pages
      live/store.mlpj
      knowledge/store.pages
      knowledge/store.mlpj
```

Los nombres son ilustrativos; la implementación debe validar cada componente como directorio/archivo regular y rechazar symlinks, traversal, duplicación de rutas e identidades inconsistentes.

## Invariantes obligatorias

- Solo `CURRENT.0` y `CURRENT.1` determinan qué bundle está publicado. No hay selectores independientes para `live` y `knowledge`.
- Un selector referencia una generación completa cuyo manifiesto enumera ambos miembros, sus identidades, tamaños y hashes.
- Cada receipt individual debe identificar el mismo `generation_id` que el manifiesto del bundle.
- Ambos miembros deben declarar el mismo `project_id` esperado por el anfitrión.
- Ambos WAL deben estar checkpointed antes de publicar; no se publica una copia con transacciones pendientes.
- El selector nuevo solo se crea después de copiar, sincronizar, reabrir, validar y comparar ambos miembros.
- Un error al preparar o validar cualquiera de los miembros deja intacto el selector activo.
- El selector anterior permanece disponible como slot anterior; la recuperación no elige una generación anterior si un selector existente está corrupto. Cada slot se lee verificando la identidad y los metadatos del archivo antes y después de obtener sus bytes; una sustitución concurrente invalida la apertura. Si sobrevive un único slot, su generación se verifica íntegramente: la ausencia o corrupción de cualquier manifiesto, receipt, página o WAL hace fallar la apertura sin reconstruir el miembro ni recurrir a otra generación. Si faltan ambos slots, ninguna generación huérfana se infiere como actual.
- Las generaciones publicadas son inmutables y solo lectura. El motor nunca recibe rutas mutables de una generación publicada. La apertura usa descriptores del sistema operativo sin permiso de escritura, exige WAL limitado a la cabecera checkpointed, no ejecuta recovery ni sincronización sobre la generación y bloquea también `transaction()`/`checkpoint()` en la capa DurablePages.
- Las working copies son independientes de los archivos publicados y de otros working bundles.
- Publicar consume la sesión de trabajo; una working copy basada en una generación que ya no es la activa se rechaza como obsoleta.
- La apertura de una working copy exige los cuatro archivos existentes. No se recrea silenciosamente ningún miembro ausente.
- No se permite publicar solo el miembro vivo ni solo el narrativo desde la API del anfitrión.

## Protocolo de creación de working bundle

1. Adquirir el lock exclusivo de la raíz y capturar el selector activo.
2. Abrir ambos miembros publicados mediante descriptores verificados y read-only.
3. Crear un directorio temporal privado para el working bundle.
4. Copiar cada miembro en streaming a su propio ProjectStore mutable; no compartir inodes, páginas ni WAL con el origen.
5. Comprobar conteos, validar cada árbol y checkpointar ambos.
6. Escribir el manifiesto de trabajo con `working_id`, `project_id`, `base_generation_id` y huellas de ambos orígenes.
7. Sincronizar archivos y directorios; renombrar el directorio temporal al nombre definitivo y sincronizar `working/`.
8. Reabrir ambos miembros con `ProjectStore::open_existing`. Si falta uno, fallar cerrado.

Un temporal abandonado nunca se trata como working bundle completo.

## Protocolo de publicación conjunta

1. Adquirir el lock exclusivo de la raíz.
2. Verificar que la generación activa coincide exactamente con la generación base del working bundle.
3. Validar identidad, manifiesto, rutas y archivos de ambos miembros.
4. Checkpointar y validar los dos ProjectStore; verificar que ambos WAL quedaron en estado checkpointed.
5. Crear un directorio de generación nuevo y copiar ambos miembros a subdirectorios separados.
6. Sincronizar los archivos temporales, renombrarlos a nombres finales y sincronizar cada subdirectorio.
7. Escribir receipts individuales inmutables y un `BUNDLE.MANIFEST` inmutable que vincule los dos receipts, `project_id` y `generation_id`.
8. Reabrir cada miembro desde el destino publicado mediante descriptores verificados; validar y comparar contenido registro por registro con su working member.
9. Sincronizar el directorio de generación y `generations/`.
10. Escribir el selector de bundle en el slot inactivo mediante temporal + `sync_all` + creación atómica sin reemplazo + sincronización de la raíz.
11. Actualizar el estado en memoria únicamente después de confirmar la sincronización del selector.

No se invoca `PublicationStore::publish` para cada miembro: eso produciría dos puntos de commit y permitiría estados mixtos.

## Recuperación ante interrupciones

| Punto de interrupción | Resultado obligatorio |
|---|---|
| Durante la copia de cualquiera de los miembros | La generación activa no cambia; el temporal no es visible como generación publicada |
| Después de copiar un miembro, antes de completar el segundo | La generación activa no cambia |
| Durante receipts/manifiesto | La generación activa no cambia; staging incompleto no se selecciona |
| Después de verificar ambos, antes del selector | La generación activa no cambia; queda una generación huérfana inspeccionable |
| Durante escritura del selector temporal | Se conserva el slot activo anterior; el temporal no se considera selector |
| Después de enlazar el nuevo selector, antes de sincronizar raíz | La apertura debe reconciliar slots con las reglas existentes; cualquier ambigüedad falla cerrado |
| Después de confirmar selector | Ambos miembros se abren desde la misma generación |

La recuperación no debe completar un bundle a partir de archivos que no estén cubiertos por el manifiesto y receipts verificados.

## Integración con el motor anfitrión

La API final debe recibir una sesión/bundle único, no cuatro rutas libres:
- apertura nueva o reanudación de `WorkingBundle`;
- `HostEngineApi` abre el motor vivo y el conocimiento desde los dos miembros del mismo bundle;
- el worker conserva su hilo y colas independientes;
- la API narrativa sigue operando fuera del hilo de escritura, sobre su propio almacén;
- el anfitrión publica el bundle completo con una sola operación;
- no se exponen métodos públicos que permitan publicar uno de los miembros de forma aislada.

La identidad `project_id` procede siempre del programa anfitrión. La apertura debe comprobarla en el manifiesto antes de iniciar el worker, para no dejar un hilo vivo si el segundo miembro no puede abrirse.

## Secuencia de implementación

1. [Hecho] Codecs versionados y checksums para puntero, manifiesto y working manifest.
2. [Hecho] Selector raíz único, verificación de receipts/archivos y `PublishedBundle` read-only.
3. [Hecho] `WorkingBundle` persistente, copia independiente de ambos miembros, lock de sesión, reapertura y permisos privados.
4. [Hecho] `publish_working_bundle` checkpointa y valida ambos almacenes y conmuta un único selector; rechaza working bundles obsoletas y cambios de `project_id`.
5. [Hecho parcial] `HostEngineApi` puede abrir la working bundle, conservar el lock mientras trabaja y devolverla tras cerrar el worker.
6. [En curso] Extender la inyección de fallos a todas las fronteras de sincronización; pruebas adicionales de symlinks/concurrencia. Ya se cubren exclusión del lock raíz y rechazo fail-closed ante corrupción de cualquiera de los dos selectores. El inventario de huérfanos ya protege slots y working bases; al validar una generación candidata conserva los bytes e identidad del `BUNDLE.MANIFEST` usados para derivar su pointer y vuelve a leerlos después de `verify_generation`. Si el manifiesto se sustituye o cambia durante la verificación (aunque cada lectura aislada haya sido estable), el inventario falla cerrado en lugar de combinar identidades de dos observaciones; el inventario informa temporales de working bundles y selectores abandonados, y separa directorios de generación incompletos de generaciones huérfanas completas verificadas sin adoptar ni eliminar artefactos; un retry solo retira un temporal de selector si su puntero coincide exactamente con el que intenta publicar; la eliminación física permanece deshabilitada hasta definir retención.
7. Ejecutar `cargo test` y `cargo check` en runner real antes de afirmar validación.

## Restricción operativa

Mientras falten los pasos anteriores, las APIs de dos almacenes existentes son útiles para desarrollo en working copies, pero no constituyen una publicación atómica conjunta ni deben usarse para promover una revisión coherente del libro.


## Cobertura de recuperación y límites actuales

La suite incluye una matriz de interrupciones del selector en tres fronteras: temporal sincronizado antes del hard link, hard link creado antes de retirar el temporal y raíz sincronizada. Cada caso cierra y reabre el almacén y comprueba el contenido de ambos miembros usando datos distintos por generación. Un temporal residual se informa en el inventario, pero nunca se promueve ni elimina automáticamente.

La integridad de la generación activa se prueba dañando por separado BUNDLE.MANIFEST, los dos GENERATION.MANIFEST, ambos store.pages y ambos store.mlpj. Aunque el slot anterior permanezca disponible, la apertura debe fallar cerrada y no seleccionar una generación anterior por fallback. En Windows, la apertura de miembros publicados compara volumen e índice de archivo entre descriptor y ruta, exige un único hard link y comprueba estabilidad de metadatos; existe una regresión específica para un miembro con hardlink.

**Límite de verificación:** estas son pruebas escritas, no resultados de ejecución. Los hooks simulan interrupciones del proceso en límites deterministas; no simulan una pérdida de energía ni una pérdida de caché física. sync_bundle_directory sincroniza directorios en Unix. En Windows, el helper actual no ejecuta un flush de directorio, por lo que todavía no se debe prometer durabilidad ante corte eléctrico en esa plataforma. Se requiere CI nativo y validación sobre sistemas de archivos soportados antes de elevar esa garantía.


## Verificación de copias y receipts

La creación y validación de receipts del protocolo de publicación de ProjectStore ahora comprueba la identidad real del descriptor frente a la ruta también en Windows (volumen e índice de archivo). Rechaza receipts con hardlinks en Unix y Windows, valida de nuevo el descriptor y la ruta después de leer, y conserva el requisito de permisos privados en Unix.

El hash de archivos de generación abre sin seguir symlinks en Linux/Android, comprueba identidad de descriptor/ruta, exclusividad de enlaces y permisos privados, y vuelve a validar después del recorrido completo. La verificación de bundles vuelve a leer al final el `BUNDLE.MANIFEST` y ambos `GENERATION.MANIFEST`, comparando bytes, identidad y metadatos con las capturas iniciales; así, la validación de un miembro no puede quedar separada de un receipt sustituido mientras se recorría el otro. Además, conserva snapshots de `generations/`, el directorio de generación, `live/`, `knowledge/` y los siete archivos de manifiesto/almacén implicados; al terminar revalida identidad y metadatos de cada ruta. La verificación falla cerrada si se sustituye un directorio o archivo entre la apertura de ambos miembros y el cierre de la inspección. La copia de working copies aplica verificaciones equivalentes a origen y destino: archivos regulares, descriptor estable, ruta no sustituida, un solo enlace y privacidad Unix. Hay regresiones para hardlinks en ambas familias de plataformas.

Estas ampliaciones permanecen pendientes de ejecución en CI nativo. No deben confundirse las pruebas añadidas con resultados de ejecución.


## Identidad del bloqueo raíz

La instancia de BundlePublicationStore ahora revalida que el archivo de bloqueo raíz siga apuntando al descriptor bloqueado. La comprobación se ejecuta al abrir, verificar, inspeccionar inventarios, abrir o crear working bundles y en las fronteras críticas de publicación del selector. Si el lockfile se sustituye durante una sesión, las operaciones de lectura y escritura fallan cerradas; si la sustitución se detecta después de enlazar el selector, la instancia queda marcada para recuperación y exige cerrarse y reabrirse.

Se incorporaron regresiones para Unix y Windows que sustituyen el lockfile raíz y comprueban que no se permitan nuevas lecturas verificadas, inventarios, working bundles ni publicaciones desde la instancia afectada. Las pruebas todavía requieren ejecución en CI nativo.


## Consistencia del publicador de generación individual

El protocolo individual `PublicationStore` también revalida la identidad del lockfile raíz (descriptor frente a ruta) al abrir el selector, verificar generaciones, abrir almacenes publicados, crear/reabrir working copies, resolver rutas y publicar slots. Las comprobaciones se repiten antes de renombrar working copies y archivos de generación, y alrededor del enlace del selector. Una sustitución detectada antes del cambio del selector detiene la operación; una detectada después del enlace deja la instancia en estado de recuperación obligatoria.

Las pruebas Unix y Windows cubren la sustitución del lockfile raíz, incluyendo lectura de generación, resolución de rutas, reapertura de working copy, creación de una nueva copia y publicación. Estas pruebas están añadidas, pero no se consideran ejecutadas hasta que CI nativo las informe.
