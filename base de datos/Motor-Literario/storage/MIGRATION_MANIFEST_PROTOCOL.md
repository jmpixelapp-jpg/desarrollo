# Protocolo de manifiesto durable de migración MLWAL → ProjectStore

**Estado:** codec, máquina de estados, persistencia en dos slots, importación reanudable con checkpoints y verificación integral independiente implementados. La publicación segura sigue pendiente. La implementación aún no está validada por compilación/ejecución multiplataforma.

## Objetivo y regla de seguridad

La importación puede abarcar muchos commits MLPJ. El manifiesto registra el prefijo confirmado y permite continuar después de una interrupción. Los lotes no forman una transacción global. Un destino solo puede publicarse cuando la fase independiente lo verifica y el manifiesto llega a `Verified`; la verificación está implementada y la publicación sigue pendiente.

El WAL legado no se modifica. `Store` mantiene su bloqueo interproceso durante la vida de la instancia. Cada recorrido bloquea además el mutex interno. La importación hace dos pasadas separadas: una para calcular el fingerprint y otra para verificar/importar. Una escritura concurrente desde otra referencia del mismo proceso entre ambas pasadas puede producir un destino parcial; la segunda pasada compara nuevamente el fingerprint y aborta la migración si detecta cambios. No se presenta esto como un snapshot inmutable entre pasadas.

## Identidad inmutable

Cada migración registra:

- `migration_id` de 128 bits;
- generación monotónica del manifiesto;
- rutas de origen y destino temporal y versiones de formato;
- fingerprint del origen, cantidad de registros y bytes lógicos;
- tamaño y presupuesto lógico de lote;
- secuencia y tamaño del último lote confirmado;
- contadores acumulados, cursor de la última clave y fingerprint del prefijo importado.

El manifiesto rechaza cambios de identidad, rutas y versiones entre generaciones. El importador también exige que la ruta de origen coincida con la ruta abierta por `Store`, que la ruta de páginas coincida con el `ProjectStore` abierto y que la identidad suministrada por el llamador coincida con el manifiesto existente.

**Integridad:** el fingerprint del snapshot y del prefijo usa SHA-256 incremental, con vectores de prueba estándar. El formato de manifiesto v2 fija SHA-256 como algoritmo de esos campos; un cambio futuro de algoritmo requiere una nueva versión de formato o un identificador explícito. El checksum del contenedor del manifiesto sigue siendo FNV-1a de 64 bits: detecta corrupción accidental, pero no es criptográfico, no autentica el manifiesto y no resiste manipulación deliberada. SHA-256 tampoco autentica el origen: solo permite comparar de forma robusta su contenido.

## Estados

1. `Created`: manifiesto creado; sin progreso.
2. `SourceScanned`: snapshot contado y fingerprint calculado.
3. `Importing`: importación por lotes en curso.
4. `ImportComplete`: todos los registros están importados y el destino supera la validación estructural/recuento actual.
5. `Verifying`: verificación independiente en curso o pendiente de reintento.
6. `Verified`: verificación integral completa confirmada.
7. `Published`: reservado para publicación confirmada.
8. `Aborted`: migración abandonada; destino parcial no publicable.

La máquina de estados impide retrocesos y cambios desde estados terminales. La ruta actual de importación reanudable solo acepta `Created`, `SourceScanned` o `Importing`; no reabre una migración ya completada.

## Persistencia del manifiesto: dos slots alternos

`ManifestStore` usa dos archivos generacionales `.slot0` y `.slot1`, y un archivo de bloqueo auxiliar estable `.mldb-lock`.

- El primer manifiesto se escribe en el slot 0.
- Cada generación posterior se escribe en el slot inactivo; el slot seleccionado anterior no se trunca.
- El archivo nuevo se escribe completo y se ejecuta `sync_all()` antes de actualizar la generación activa en memoria.
- En Unix también se sincroniza el directorio. En Windows la sincronización del directorio todavía no está implementada.
- El lector valida checksum, formato, identidad y generación. Si un slot está dañado y el otro es válido, usa el válido. Si ambos son inválidos, falla.
- Los dos slots válidos deben pertenecer a la misma identidad de migración; generaciones iguales con contenido divergente se rechazan.
- Los archivos nuevos usan permisos Unix `0600`; se rechazan slots que sean enlaces simbólicos.

La recuperación puede seleccionar una generación anterior si el slot más reciente está dañado. El importador no acepta ciegamente el retroceso: compara el recuento real del destino con el checkpoint y verifica registro por registro el posible sufijo durable que quedó sin checkpoint. La escritura de slots y su comportamiento ante pérdida abrupta de energía requieren pruebas nativas en cada plataforma.

## Orden durable de cada lote y ventana de crash

Para cada lote:

1. Leer claves en orden determinista, respetando cursor, límite de registros y presupuesto lógico.
2. Aplicar el lote completo mediante un único `ProjectStore::apply_batch()` MLPJ.
3. Leer de vuelta cada clave/valor y compararlo byte por byte.
4. Actualizar cursor, contadores y fingerprint del prefijo.
5. Guardar una nueva generación en el slot alterno y sincronizarla según las capacidades actuales de plataforma.
6. Solo entonces continuar con el lote siguiente.

**Crash después del COMMIT MLPJ y antes del checkpoint:** el destino puede tener más registros que el manifiesto. Al reanudar, el importador verifica que ese sufijo coincide exactamente con los siguientes registros del origen, actualiza el checkpoint sin volver a insertar ese lote y continúa. Si el destino tiene registros adicionales no presentes en el origen, valores distintos o menos registros que los declarados, rechaza la reanudación.

El importador también vuelve a comprobar el prefijo declarado por el cursor contra el destino. No avanza el cursor ante una discrepancia. Un error durante apply/sync del MLPJ puede dejar el resultado ambiguo; el llamador debe cerrar y reabrir el almacén para que su recuperación WAL resuelva el estado antes de reintentar.

## Importador reanudable implementado

La API `import_legacy_snapshot_resumable()`:

- calcula en una primera pasada el fingerprint, recuento y bytes del origen;
- crea o valida el manifiesto y transiciona a `Importing`;
- recorre el origen en orden determinista, verifica el prefijo ya importado y aplica los lotes pendientes;
- verifica cada registro después del COMMIT;
- guarda un checkpoint durable después de cada lote;
- reconcilia un lote ya confirmado cuyo checkpoint se perdió por una caída;
- recalcula el fingerprint completo durante la segunda pasada y aborta si el origen cambió;
- termina en `ImportComplete` y valida el recuento/estructura del destino.

La importación sigue siendo parcial respecto de la migración completa. La verificación independiente se realiza en la fase siguiente y usa SHA-256 para comparar el snapshot; la publicación segura todavía no está implementada y no se elimina ni reemplaza ningún archivo.

## Verificación independiente implementada

La función `verify_legacy_snapshot_migration()` implementa esta verificación incremental: compara los dos almacenes en orden de clave, byte por byte, detecta faltantes y sobrantes, vuelve a comprobar contadores y fingerprint, y persiste `Verified` solo al completar todos los controles. Si falla, deja el estado `Verifying` para permitir reparación y reintento. El recorrido global del destino se hace con `ProjectStore::scan_all_iter()` sin materializar el almacén completo. La validación por lote y el recuento final de importación no sustituyen esta fase.

## Publicación pendiente

La publicación será una operación separada. El destino temporal debe estar en el mismo volumen que el definitivo. Se preferirá un rename atómico de directorio o un puntero de generación activa. Nunca se borrará primero una base existente.

La recuperación tendrá que inspeccionar el puntero activo y `migration_id` si ocurre un crash entre publicar y guardar `Published`. Esta lógica no está implementada.

## Pruebas pendientes

- Compilación y ejecución verificables de toda la suite en Windows, Linux y macOS.
- Crash/kill en cada frontera de COMMIT MLPJ, checkpoint y sincronización de slot.
- Corrupción y truncado de cada slot, incluyendo pérdida de energía durante escritura.
- Reanudación con lote durable sin checkpoint, destino divergente y origen modificado.
- Pruebas nativas de sincronización de directorio en Windows y Unix.
- Publicación y recuperación del puntero activo.
- Hash criptográfico versionado y pruebas de compatibilidad del formato.

No guardar manuscritos reales ni publicar destinos migrados hasta completar estas garantías y obtener resultados verificables de compilación y pruebas.
