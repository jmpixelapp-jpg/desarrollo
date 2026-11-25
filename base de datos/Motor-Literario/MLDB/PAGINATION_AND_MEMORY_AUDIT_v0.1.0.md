# Auditoría de paginación y consumo de memoria — MLDB

**Estado:** auditoría de código completada; no modifica datos ni formatos persistidos.  
**Alcance:** `src/sync.ts`, `src/storage.ts` y pruebas de `tests/mldb-database.test.mjs`.

## Hallazgo principal

Las migraciones incrementales de índices ya usan lotes durables y cursores exclusivos. No corresponde reemplazarlas por una migración nueva ni duplicar su mecanismo:

- Índices narrativos: `INDEX_MIGRATION_PAGE_SIZE = 128`, checkpoint por fase y cursor, marcador de finalización separado.
- Índice léxico: procesa páginas de hasta 128 entradas, verifica claves, diccionario y perfil lingüístico, y persiste el checkpoint junto con el lote.
- Importación: tiene lotes de 32 elementos, límites de 1.024 elementos y 8 MiB, además de estado durable para reanudación.
- Escaneos genéricos: el puerto impone un máximo de 512 elementos por página y cursores exclusivos.

Estas características ya cuentan con pruebas de recuperación para el índice léxico y con lectura de 129 entradas a través de varias páginas.

## Problema real pendiente: operaciones que materializan el proyecto completo

El cierre de una obra (`finalizeProject`) todavía reúne en memoria colecciones completas de entidades, historiales, evidencias, relaciones, atributos, cronología, documentos, fragmentos, diccionarios, perfiles lingüísticos y otros metadatos. La validación previa también materializa conjuntos completos de fragmentos y sugerencias.

La exportación del conocimiento y algunas verificaciones de índices también llaman a `scanAll`, que acumula todas las páginas en un único array. Por tanto, que el almacenamiento lea en páginas no significa que el proceso completo tenga memoria acotada.

## Orden de trabajo seguro

1. Introducir un iterador interno de páginas que mantenga las validaciones actuales de prefijo, orden y cursor, sin acumular resultados.
2. Refactorizar primero verificaciones de índices y validaciones que solo necesitan comparar/contar registros; usar conjuntos pequeños o recorridos ordenados cuando sea posible.
3. Diseñar el cierre de obra como una operación por etapas: bloquear escrituras, validar por páginas, preparar archivos de ideas por lotes, verificar cobertura y publicar el recibo final. El recibo debe seguir siendo el único punto de publicación visible.
4. Mantener checkpoints durables, reanudación idempotente y recuperación tras cierre inesperado. Nunca borrar ni marcar FINALIZED antes de comprobar que todos los lotes están completos.
5. Añadir pruebas con miles de registros y adaptadores que devuelvan páginas parciales, cursores ausentes o fallos entre lotes. Medir el máximo de registros retenidos por etapa.

## Restricciones que no se deben romper

- No cambiar el formato binario MLDB v1 ni convertir el almacenamiento a SQL por esta refactorización.
- No cargar ni transmitir el manuscrito; solo metadatos y offsets UTF-8.
- Mantener aislamiento físico por `project` y `writer`.
- El contenido archivado debe seguir invisible hasta que exista el recibo final válido.
- No degradar la prioridad del monitoreo en tiempo real: el trabajo de cierre/importación debe ser cooperativo y fuera del camino crítico de edición.

## Verificación

Esta auditoría es una inspección estática del código. No se declara que las pruebas se hayan ejecutado. Los últimos workflows consultados terminaron antes de iniciar los runners (cero pasos), por lo que no aportan evidencia de compilación o ejecución.
