# Unificación del almacenamiento de registros y páginas

Estado: análisis y plan de transición. **No se ha activado una escritura dual ni se ha cambiado la fuente de verdad en producción.** El WAL legado `Store` y `ProjectStore` siguen siendo almacenes separados.

## 1. Problema actual

El crate contiene dos sistemas que aceptan escrituras para el mismo dominio lógico:

- `Store` (en `src/lib.rs`) persiste operaciones `PUT/DELETE` en un WAL MLWAL v1 y reconstruye un `BTreeMap` en memoria.
- `ProjectStore` (en `src/project_store.rs`) persiste claves compuestas en un B+Tree de páginas MLPG y confirma sus mutaciones mediante el WAL de imágenes MLPJ.

Ambos exigen `project_id`, tabla e identificador, pero tienen formatos, archivos, bloqueos, recuperación y límites distintos. No comparten una transacción ni un coordinador.

## 2. Invariante obligatorio: no escribir en ambos

No se debe implementar una operación que confirme primero MLWAL y después MLPJ (ni al revés) como si fuera atómica. Una caída después del primer COMMIT y antes del segundo deja estados divergentes. Reintentar tampoco resuelve de forma general el problema: PUT puede ser idempotente para algunos valores, pero DELETE, orden de operaciones y resultados observables requieren un protocolo de coordinación durable.

Hasta que exista una migración controlada:

1. Cada instancia de almacenamiento tiene un único backend de escritura.
2. No se replican cambios en segundo plano entre MLWAL y MLPJ.
3. No se abren ambos backends para escribir el mismo conjunto de datos.
4. Los consumidores deben declarar qué backend utilizan; no se debe hacer fallback silencioso de uno al otro.

## 3. Arquitectura objetivo recomendada

La recomendación técnica para el almacenamiento nuevo es que `ProjectStore` + B+Tree + MLPJ sea el backend canónico de registros:

- Las claves siguen aisladas por `(project_id, table, record_id)`.
- Las operaciones individuales y los lotes pasan por la misma sesión transaccional del B+Tree.
- Un lote con cambios produce un único COMMIT MLPJ; un lote sin cambios no crea un COMMIT vacío.
- MLPG contiene el estado actual de páginas y MLPJ permite rehacer commits confirmados.
- El WAL legado `Store` queda como formato de origen para importación/compatibilidad histórica, no como segundo destino de escritura.

Esta recomendación **no equivale a declarar listo el backend**. La compilación y ejecución de la suite, la recuperación, el bloqueo y las migraciones siguen pendientes de validación real. La adopción debe esperar esos hitos.

## 4. Contrato de migración MLWAL v1 → ProjectStore

La migración debe ser un proceso explícito, repetible y verificable; nunca una conversión destructiva al abrir la base.

### Fase A — inventario y protección

1. Abrir el WAL legado con su bloqueo exclusivo habitual.
2. Ejecutar recovery completo. Si el WAL tiene corrupción interior o una transacción ambigua, abortar sin modificar el origen.
3. Mantener el origen sin escrituras durante el snapshot. No permitir que otra instancia lo abra para escritura.
4. Registrar ruta, versión de formato, tamaño, cantidad de registros y un identificador de migración. No registrar contenido privado en logs.

### Fase B — extracción

1. Extraer cada registro como la tupla exacta `(project_id, table, record_id, value)`.
2. Preservar bytes de valor exactamente; no interpretar ni reescribir el contenido del escritor.
3. No inferir, normalizar, renombrar ni generar identidades de proyecto.
4. Ordenar de forma determinista por la clave lógica para que la misma instantánea produzca la misma secuencia de importación.
5. No cargar todo el contenido en una segunda copia en memoria si el volumen puede ser grande; implementar lectura paginada o un cursor de snapshot antes de usar el migrador con bases grandes.

### Fase C — construcción aislada

1. Crear un destino ProjectStore nuevo en rutas temporales exclusivas, distinto del origen.
2. Importar en lotes limitados por `MAX_IMAGES_PER_TX` y por memoria disponible. Cada lote es atómico en MLPJ, pero la migración completa no se considera publicada todavía.
3. Si el proceso se interrumpe, descartar o reanudar únicamente el destino temporal mediante un manifiesto de progreso verificable. Nunca alterar el origen.
4. No permitir que el programa anfitrión consulte parcialmente el destino mientras se importa.

### Fase D — verificación

Antes de publicar el destino, comparar contra la instantánea del origen:

- cantidad total de registros;
- claves completas y exactas, incluyendo Unicode y NUL;
- bytes y longitud de cada valor;
- ausencia de claves duplicadas o registros omitidos;
- aislamiento por proyecto y tabla;
- `ProjectStore::validate()`, recorridos por proyecto/tabla y reapertura en frío.

La verificación debe detectar diferencias por registro, no limitarse a comparar cantidad de filas. Un digest por registro y un digest global determinista pueden acelerar la comparación, pero no sustituyen la comprobación de claves/valores ante una discrepancia.

### Fase E — publicación y reversión

1. Sincronizar y cerrar ambos archivos del destino temporal.
2. Conservar el WAL legado original como respaldo inmutable.
3. Publicar el destino mediante un cambio explícito de configuración/manifiesto del anfitrión, no mediante fallback automático.
4. Abrir el destino publicado, ejecutar recovery y una validación final antes de habilitar escrituras.
5. Si falla cualquier paso antes de habilitar escrituras, volver a seleccionar el origen intacto.
6. Después de la primera escritura nueva, el origen antiguo queda obsoleto. No se debe volver a él como si estuviera actualizado. La reversión requiere restaurar una copia consistente o repetir una migración inversa diseñada y verificada.

La publicación debe considerar que renombrar dos archivos por separado no es una operación atómica conjunta. Se necesita un manifiesto/versionado o un directorio de generación con un único puntero de activación; el mecanismo concreto debe validarse en Windows, Linux y macOS.

## 5. Protocolo de recuperación y fallos

- Error de validación/extracción: cancelar; el origen no cambia.
- Error durante un lote de importación antes del COMMIT MLPJ: ese lote no debe aparecer en el destino.
- Error ambiguo después del COMMIT MLPJ: cerrar y reabrir el destino temporal; dejar que MLPJ determine el estado. No reintentar sobre la instancia bloqueada.
- Caída entre lotes: reabrir el destino temporal y validar el manifiesto de migración antes de continuar. No asumir que el último lote falló o tuvo éxito sin consultar MLPJ.
- Fallo de verificación: no publicar; conservar evidencia técnica sin volcar valores privados.
- Caída durante publicación: resolver el manifiesto de activación antes de aceptar nuevas escrituras. Nunca elegir backend por mera existencia de archivos.

## 6. API requerida antes de implementar el migrador

El WAL legado reconstruye sus registros en un `BTreeMap` privado. Se añadió `Store::visit_records`, un visitante que expone las identidades y bytes exactos sin clonar el conjunto completo. Mantiene adquirido el mutex del `Store` durante todo el recorrido, rechaza instancias con resultado de escritura ambiguo y propaga el error del visitante. El orden del `BTreeMap` hace determinista la extracción. El visitante no debe reentrar en el mismo `Store`.

La función `migration::import_legacy_snapshot` implementa la importación inicial: exige un destino lógicamente vacío, limita cada lote a 256 registros y 256 KiB aproximados de claves/valores, rechaza un registro individual que supere ese presupuesto antes de copiarlo y mantiene bloqueado el origen durante el recorrido, confirma lotes independientes mediante `ProjectStore::apply_batch`, vuelve a leer y compara cada clave/valor importado y valida el recuento/estructura del destino al finalizar. Devuelve registros/lotes importados y el informe de validación. Si falla después de confirmar lotes previos, el destino queda parcial y debe descartarse; no debe publicarse ni reutilizarse. El WAL de origen no se modifica. Las pruebas importan tres registros en lotes de dos, preservan bytes binarios/UTF-8/NUL, reabren ambos almacenes y comprueban que el origen sigue intacto; también cubren origen vacío, tamaño inválido, rechazo de destino no vacío, exceso del presupuesto de memoria de un registro, división por bytes antes del límite de operaciones y fallo en un segundo lote después de que el primero ya fue confirmado. Este último escenario verifica que el destino queda parcial (y por contrato debe descartarse), mientras el origen permanece intacto. La comprobación de cada registro importado y el recuento del destino están implementados. Todavía faltan manifiesto durable, interrupción/reanudación entre lotes, comparación final independiente de ambos recorridos y publicación segura. Para snapshots que deban sobrevivir al cierre del proceso, el manifiesto debe guardar la última clave confirmada y el destino temporal debe validarse antes de continuar; no se debe tratar un cursor como prueba de que el lote fue aplicado.

También se necesita un manifiesto de migración durable en el destino temporal, con versión de formato, identidad del origen, última clave confirmada, contadores y estado. El manifiesto no puede sustituir la verificación final.

## 7. Pruebas obligatorias del migrador

1. Importación de varios proyectos con el mismo `record_id`.
2. Unicode y bytes NUL en los tres componentes de clave.
3. Valores binarios vacíos, grandes y con todos los bytes posibles.
4. Origen vacío y origen con muchas claves.
5. Fallo antes de comenzar, durante un lote, después de COMMIT durable y entre lotes.
6. Reapertura del destino temporal y reanudación sin duplicar ni omitir registros.
7. Discrepancia deliberada de clave, valor, cantidad y digest: la publicación debe abortar.
8. Origen bloqueado contra escrituras concurrentes durante la extracción.
9. Publicación interrumpida y recuperación inequívoca del manifiesto.
10. Reapertura del backend publicado y validación de todos los registros.
11. Prueba de que el WAL legado permanece byte por byte intacto durante todo el proceso.
12. Pruebas nativas en Windows, Linux y macOS.

## 8. Fuera de alcance de esta etapa

- No borrar ni truncar automáticamente WAL legado.
- No mantener replicación dual en tiempo real.
- No convertir automáticamente al abrir una base.
- No cambiar IDs de proyectos ni metadatos de obras.
- No migrar ni interpretar contenido narrativo; solo bytes de registros.
- No declarar compatibilidad hacia atrás del formato MLPJ v2 con MLPJ v1 sin un migrador específico.

## 9. Criterio de cierre

La unificación no se considera terminada hasta que exista un único backend de escritura seleccionado explícitamente por el anfitrión, el migrador haya pasado la matriz de fallos y recuperación, la verificación de origen/destino sea completa y la suite se haya compilado y ejecutado en plataformas nativas. Hasta entonces, MLWAL y ProjectStore permanecen separados y el crate no debe almacenar manuscritos reales.
