# Búfer de texto Rope AVL

## Estado actual

`RopeText` ya está integrado como almacenamiento interno de `LiveSession` en `main`. La integración conserva la API del anfitrión, las revisiones, las secuencias, la invalidación de sugerencias y el registro durable de deltas. La extracción de párrafos y la validación de fragmentos operan sobre el Rope; el texto completo se materializa únicamente cuando se solicita un `DocumentSnapshot`.

La integración está implementada, pero todavía no se declara validada para producción: los workflows de GitHub Actions disponibles terminan antes de asignar runners y no ejecutan pasos de compilación ni pruebas. Los benchmarks tampoco tienen resultados medidos disponibles.

## Estructura

Rope AVL implícito, con hojas UTF-8 de hasta `ROPE_LEAF_BYTES` (4 KiB) y nodos internos con metadatos agregados:

- longitud total en bytes;
- altura AVL;
- número de hojas;
- cantidad de saltos de línea LF.

El orden del documento es el recorrido in-order. No se usan claves de posición global que deban actualizarse al insertar o borrar texto.

### Operaciones

- **Buscar offset y validar UTF-8:** descenso por longitudes de subárbol y comprobación dentro de la hoja correspondiente.
- **Dividir:** desciende hasta el offset, divide solo la hoja afectada y recompone el camino AVL.
- **Reemplazar:** divide en `end_byte`, divide el prefijo en `start_byte`, descarta el tramo intermedio y concatena prefijo, reemplazo y sufijo.
- **Leer rango:** visita las hojas que intersectan el rango y materializa únicamente sus bytes.
- **Buscar LF hacia delante/atrás:** poda al entrar cualquier subárbol cuyo contador agregado sea cero; solo recorre las ramas candidatas y el fragmento hoja donde puede estar el resultado.
- **Concatenar:** mantiene el balance AVL y fusiona hojas adyacentes cuando ambas caben en 4 KiB.

Las cotas de árbol se refieren al número de nodos visitados. Materializar un rango grande sigue costando proporcionalmente al texto que se devuelve.

## Integración en LiveSession

`LiveSession.text` es `RopeText`, no `String`.

- `open` construye el Rope a partir del snapshot autoritativo que entrega el anfitrión.
- `validate_change` comprueba longitud y límites UTF-8 directamente sobre el Rope.
- `apply_change` aplica el delta recibido mediante `RopeText::replace_range`.
- `fragment_matches` y `validate_evidence_excerpt` consultan solo el rango solicitado.
- `affected_paragraph` usa `affected_paragraph_range_rope` y copia únicamente el texto del párrafo afectado.
- `snapshot` reconstruye un `String` completo solo cuando el anfitrión solicita expresamente esa operación.

La persistencia sigue escribiendo los deltas y la cabecera durable antes de modificar la sesión viva. La recuperación vuelve a abrir el snapshot autoritativo y reproduce los deltas en orden sobre Rope. No se ha cambiado el protocolo ni se han inventado identidades de proyecto/documento.

## Segmentación localizada

`affected_paragraph_range_rope` replica la semántica de `affected_paragraph_range` sobre `String`: selección dentro de párrafo, selección que cruza párrafos, edición de separadores, indentación inicial, espacios en blanco y documentos LF/CRLF. Devuelve offsets absolutos en bytes UTF-8. `segment_rope_range` permite segmentar un rango ya conocido y conserva offsets absolutos para párrafos y oraciones.

Los métodos `find_byte_forward` y `find_byte_backward` son genéricos para bytes ASCII. Para LF podan subárboles mediante los metadatos agregados; para otros bytes recorren las hojas pertinentes sin materializar el documento.

## Pruebas incorporadas

- equivalencia diferencial Rope vs `String` en rangos y ediciones Unicode;
- búsquedas LF comparadas con `String` en todos los offsets de documentos con varias hojas;
- comprobación de metadatos AVL y saltos de línea tras ediciones repetidas;
- equivalencia de rangos de párrafo para todas las parejas de límites UTF-8 de documentos de prueba;
- documentos mixtos generados determinísticamente con LF, CRLF, Unicode, líneas vacías, indentación y espacios;
- documentos extensos, párrafos largos y líneas de más de 12 KiB;
- `LiveSession` con cambios UTF-8, revisiones y snapshots;
- persistencia WAL: aplicar deltas secuenciales, cerrar, recuperar desde el snapshot anterior y volver a extraer el párrafo correcto.

Las pruebas están escritas, pero no se afirma que hayan pasado hasta obtener una ejecución válida.

## Benchmark

`engine/benches/rope_edits.rs` compara `RopeText` y `String` para:

- inserción y borrado en inicio, centro y final;
- extracción de párrafo en el centro del documento;
- búsquedas LF hacia delante y atrás en documentos sin saltos y con un único salto al final;
- tamaños aproximados de 100 KiB, 1 MiB, 10 MiB y 50 MiB;
- percentiles p50, p95 y p99;
- latencia end-to-end del worker desde `try_submit_change` hasta la confirmación durable en MLDB, con reemplazos puntuales en documentos de 100 KiB, 1 MiB, 10 MiB y 50 MiB;
- ráfagas de cambios con solicitudes simultáneas de extracción analítica en su cola independiente, incluyendo backpressure, latencia por delta, profundidad máxima de cola, rechazos y p95 de espera/confirmación.

Ejecutar desde `Motor-Literario/`:

`cargo bench -p motor-literario-core --bench rope_edits`

`ROPE_BENCH_ITERATIONS` controla las muestras de Rope/String (por defecto 25), `ROPE_WORKER_BENCH_ITERATIONS` las confirmaciones individuales (por defecto 10) y `ROPE_WORKER_BURST_ITERATIONS` las ráfagas bajo carga analítica (por defecto 256). No hay cifras publicadas porque el benchmark aún no se ha ejecutado en un entorno de referencia.

## Automatización de verificación

El workflow existente `.github/workflows/motor-literario.yml` ejecuta `cargo test --workspace --all-targets` y compila el benchmark con `cargo bench -p motor-literario-core --bench rope_edits --no-run`. También existen workflows del workspace y de MLDB con cobertura adicional. En las ejecuciones consultadas, GitHub marcó los jobs como fallidos antes de asignar un runner (`runner_id=0`, sin pasos ejecutados); por tanto, ese estado no demuestra un fallo del código ni una compilación correcta.

## Criterios pendientes para aceptar la integración

1. Obtener una ejecución válida de CI con compilación y suite completa.
2. Corregir cualquier fallo de compilación, pruebas diferenciales, persistencia o recuperación que aparezca.
3. Ejecutar el benchmark en un entorno de referencia y conservar configuración y resultados p50/p95/p99.
4. Ejecutar los escenarios end-to-end del worker, tanto confirmaciones individuales como ráfagas bajo solicitudes analíticas, y medir además la latencia percibida por el anfitrión.
5. Confirmar que los resultados justifican la integración frente a `String` para los tamaños de manuscrito objetivo.

Hasta completar estos controles, la integración permanece en `main` como implementación experimental pendiente de validación ejecutable. `ChunkedText` se conserva como experimento independiente y no participa en el almacenamiento vivo.