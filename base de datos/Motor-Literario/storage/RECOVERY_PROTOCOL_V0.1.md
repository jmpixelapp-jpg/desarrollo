# Protocolo de recuperación WAL + páginas — diseño v0.1

**Estado:** especificación de diseño; todavía no está implementada ni habilita almacenamiento de manuscritos.

## 1. Regla de durabilidad

Ninguna página de datos puede modificarse en disco antes de que el WAL contenga y haya sincronizado la información necesaria para rehacer esa modificación. El orden obligatorio es:

1. Construir en memoria la nueva imagen completa de página.
2. Añadir al WAL el registro de imagen de página (page ID, generación anterior, generación nueva, longitud e imagen completa).
3. Añadir COMMIT de la transacción.
4. Ejecutar `sync_all` sobre el WAL.
5. Solo entonces aplicar las imágenes a los archivos de páginas.
6. Ejecutar `sync_all` sobre cada archivo de páginas modificado.
7. Registrar el avance del checkpoint mediante un mecanismo atómico y durable.

Un error antes del paso 4 significa que la transacción no está confirmada. Un error después del paso 4 no revoca el commit: la recuperación debe rehacerlo.

## 2. WAL de páginas

La futura versión del WAL incorporará un tipo de frame específico para imágenes de página. No se reutilizarán PUT/DELETE de registros para simular escrituras físicas.

Cada imagen debe identificar:
- archivo/espacio de páginas;
- page_id;
- generación esperada anterior;
- generación nueva;
- imagen completa de 4096 bytes;
- checksum de la imagen y checksum del frame.

El límite de tamaño de frame deberá permitir la imagen completa más sus metadatos. La versión de formato se incrementará; no se reinterpretará silenciosamente WAL v1.

## 3. Recuperación (redo)

Al abrir:
1. Validar cabecera y secuencia de frames.
2. Identificar transacciones completas y confirmadas.
3. Ignorar operaciones de transacciones sin COMMIT.
4. Para cada imagen confirmada posterior al checkpoint, comparar la generación de la página:
   - si coincide con la generación anterior, aplicar la imagen nueva;
   - si ya coincide con la generación nueva, considerar la operación aplicada;
   - si es mayor, no sobrescribir: investigar checkpoint/orden;
   - si no coincide con ninguna, detener la apertura con error de integridad.
5. Sincronizar páginas recuperadas antes de publicar el almacenamiento como listo.

El redo debe ser idempotente: repetir la recuperación no cambia el resultado ni duplica efectos.

## 4. Checkpoint

Un checkpoint solo puede avanzar hasta una transacción cuyos cambios estén aplicados y sincronizados en todos los archivos de páginas implicados.

El marcador de checkpoint debe escribirse con reemplazo atómico y sincronización del archivo y directorio cuando la plataforma lo permita. Si el marcador queda incompleto, se conserva el checkpoint anterior y se repite redo.

No truncar ni compactar el WAL hasta que el checkpoint nuevo sea verificable y exista una política probada de recuperación ante caída durante la compactación.

## 5. Escrituras parciales y páginas dañadas

La escritura directa de una página de 4096 bytes puede quedar rasgada por una caída. El WAL de imágenes completas permite rehacer una página si el commit está confirmado. Si la página no puede validarse, no se debe inventar ni reconstruir contenido a partir de bytes parciales: se recupera desde la imagen confirmada o se detiene con error.

El checksum actual FNV-1a es solo detector de daños accidentales; no aporta autenticidad ni resistencia criptográfica.

## 6. Concurrencia y aislamiento

Antes de permitir dos procesos sobre el mismo almacén se implementará un bloqueo interproceso exclusivo y se probarán aperturas concurrentes. El mutex actual solo coordina clones de un mismo objeto dentro de un proceso.

Las transacciones deberán validar todas las restricciones MLDB 0.2 (incluidas claves foráneas compuestas y límites de project_id) antes del COMMIT. Un fallo rechaza la transacción completa.

## 7. Pruebas obligatorias antes de producción

- caída simulada después de cada escritura de frame;
- caída antes y después del COMMIT durable;
- caída durante cada escritura de página;
- caída durante checkpoint y compactación;
- redo repetido e idempotente;
- corrupción de WAL, página y marcador de checkpoint;
- dos procesos intentando abrir el mismo almacén;
- aislamiento entre proyectos con identificadores locales repetidos;
- transacciones con múltiples páginas y múltiples proyectos;
- pruebas de estrés y fuzzing del parser de formatos.

**Criterio de salida:** no habilitar datos reales hasta implementar el protocolo, ejecutar la matriz de fallos en Windows/Linux/macOS y verificar recuperación reproducible.


## Relación con la implementación experimental actual

Este documento conserva el diseño general de coordinación WAL + páginas y no describe por sí solo el estado del código. Actualmente existe MLPJ v2 con redo de imágenes completas, checkpoint básico, bloqueo interproceso experimental y validaciones adicionales de generaciones. La implementación todavía no cumple todo este protocolo: no coordina atómicamente el WAL legado con MLPJ, no tiene marcador de checkpoint independiente ni compactación del archivo de páginas, y carece de ejecución verificable de la matriz de fallos en CI nativo. Consultar MLPJ_FORMAT.md e INTERPROCESS_LOCKING.md para el comportamiento implementado y sus límites actuales.
