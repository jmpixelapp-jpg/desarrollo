# MLPJ — diario de imágenes de página v2

**Estado:** coordinador experimental con transacciones atómicas multi-página, recuperación redo y checkpoint básico. No es un motor de almacenamiento de producción.

## Archivos y versión

- Archivo de páginas MLPG v1: páginas fijas de 4096 bytes.
- Diario MLPJ v2: cabecera de 8 bytes `MLPJNL\r\n` y versión u32 little-endian igual a `2`.
- Frame: magic `MPJF`, tipo u8, txid u64, longitud u32, checksum FNV-1a u32 y payload.
- Tipos: BEGIN=1, IMAGE=2, COMMIT=3.
- Una IMAGE contiene page_id u64, generación esperada u64 (u64::MAX para asignación), nueva generación u64, longitud u32 y payload completo de la página.
- Una transacción contiene un BEGIN, una o más IMAGE y un COMMIT. Cada transacción admite como máximo 8192 imágenes y 32 MiB de tamaño codificado total, incluidas las cabeceras BEGIN/COMMIT y los metadatos de cada IMAGE; cada payload no puede superar 4066 bytes.

La versión 2 amplía la cardinalidad de imágenes por transacción. Los diarios v1 no se abren con este lector; no existe migrador automático v1→v2. Mantener respaldos de cualquier archivo experimental anterior.

## Garantías de escritura

1. Se validan todos los cambios antes de escribir frames: generaciones, tamaños, IDs duplicados y asignaciones contiguas.
2. Se serializan las imágenes completas.
3. Se escriben BEGIN, todas las IMAGE y COMMIT.
4. Se ejecuta `sync_all` del WAL una sola vez.
5. Solo después del COMMIT durable se aplican todas las imágenes a MLPG.
6. Se sincroniza el archivo de páginas.

Si falla la aplicación después del COMMIT, la transacción no se revoca: el objeto bloquea nuevas lecturas/escrituras y exige cerrarse y reabrirse para completar redo.

## Recuperación

- Solo se reproducen transacciones completas con BEGIN, al menos una IMAGE y COMMIT válidos.
- La primera pasada valida el WAL completo antes de modificar páginas y conserva solo la última generación/longitud/huella por página, más una huella compacta por transacción. No retiene los payloads históricos.
- La segunda pasada vuelve a leer y validar cada frame, reconstruye una transacción por vez y la aplica al llegar al COMMIT. Contrasta la huella completa de cada transacción con la primera pasada antes de aplicar esa transacción.
- Una transacción se rechaza si supera 8192 imágenes o 32 MiB; el lector deja de acumular imágenes cuando una transacción pendiente excede esos límites. Si esa cola nunca llega a COMMIT, se descarta como incompleta; si llega a COMMIT, el diario se considera corrupto.
- Antes del redo se validan los IDs duplicados y la secuencia de asignaciones.
- El redo es idempotente: reconoce imágenes ya aplicadas, continúa asignaciones parciales y no revierte generaciones posteriores que estén respaldadas por commits posteriores del mismo WAL.
- Durante la recuperación se conserva la última imagen confirmada de cada página. Al terminar, la página física debe coincidir exactamente con esa imagen; una generación física superior sin respaldo en el WAL provoca fallo cerrado.
- Una página dañada puede repararse con una imagen comprometida. Una generación física válida pero ajena a la secuencia confirmada no se acepta como si fuera un redo completado.
- Solo una cola final incompleta (frame parcial, payload truncado o transacción sin COMMIT) se descarta hasta el último COMMIT válido. Si el WAL cambia o se trunca entre las dos pasadas, redo puede fallar después de aplicar transacciones anteriores; una nueva apertura vuelve a validar el diario tal como quedó y completa únicamente los commits que sigan íntegros.
- Una cabecera de WAL truncada durante su inicialización solo se reconstruye si todos los bytes presentes coinciden con un prefijo exacto de la cabecera esperada; cualquier prefijo distinto se rechaza sin modificarlo. Un frame completo con magic, tipo, checksum, secuencia o contenido inválido es corrupción y provoca fallo cerrado sin truncar el WAL.
- Después del redo se validan todas las páginas antes de entregar el objeto.

## Checkpoint y compactación del WAL

`DurablePages::checkpoint()` sincroniza primero el archivo MLPG completo y después reduce MLPJ a su cabecera de 12 bytes, sincronizando el diario al final. Las imágenes de transacciones anteriores ya están incorporadas de forma durable en MLPG; por eso el WAL puede reiniciarse sin perder el estado confirmado. El contador txid vuelve a 1 para el nuevo ciclo del diario.

El orden es deliberado: **primero páginas durables, después truncado del WAL**. Si el proceso se interrumpe durante el truncado, la cabecera queda preservada y las páginas ya contienen el estado comprometido; una cola parcial se descarta en la siguiente apertura. Esto no reemplaza pruebas de crash sobre sistemas de archivos reales.

Este checkpoint compacta únicamente el WAL MLPJ. No compacta el archivo de páginas ni el WAL de registros, no elimina páginas libres y no genera un snapshot portable.

## API experimental

- `DurablePages::open(pages_path, wal_path)`
- `DurablePages::transaction(Vec<PageChange>)`: transacción multi-página; devuelve los IDs creados por operaciones Allocate, en orden.
- `DurablePages::checkpoint()`: sincroniza MLPG y compacta MLPJ a la cabecera.
- `PageChange::Allocate { generation, payload }`
- `PageChange::Overwrite { page_id, expected_generation, new_generation, payload }`
- `allocate` y `overwrite` permanecen como envoltorios de compatibilidad para una sola página.
- `read(page_id)`

Una misma página no puede aparecer dos veces en la misma transacción. Las nuevas páginas reciben IDs contiguos asignados por el diario. No se admiten operaciones sobre una página recién asignada dentro de la misma transacción.

## Límites pendientes

No hay checkpoint del WAL de registros, compactación de páginas, límites de crecimiento total, buffer pool, transacciones coordinadas con el WAL de registros ni validación MLDB/FK. Existe un guard de bloqueo interproceso experimental para Unix y Windows, pero todavía no se ha compilado ni validado en runners nativos; no declarar soporte de producción ni de sistemas de archivos de red. El checksum FNV-1a detecta daños accidentales; no ofrece autenticación ni seguridad criptográfica.

No habilitar manuscritos reales hasta compilar, ejecutar la matriz de fallos y completar las garantías pendientes.
