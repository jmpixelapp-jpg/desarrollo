# Matriz de exactitud y cobertura de observación — Live Author Monitor

Estado: especificación de observabilidad; no declara capacidades de un editor anfitrión que aún no haya implementado su adaptador.

## 1. Objetivo

El monitor debe describir lo que el editor realmente aplicó al documento, no adivinar lo que el autor quiso hacer. Cada métrica debe poder rastrearse hasta una señal, una revisión y una secuencia concretas. Si falta evidencia suficiente, el estado correcto es «desconocido», «inferido» o «requiere resincronización», nunca una cifra presentada como exacta.

La fuente de verdad del contenido y del historial es siempre el editor anfitrión. El monitor recibe deltas ya aplicados, los valida y calcula métricas. No debe convertirse en un segundo editor ni mantener una copia paralela permanente del manuscrito.

## 2. Niveles de evidencia

| Nivel | Evidencia disponible | Qué puede afirmarse | Qué no debe afirmarse |
|---|---|---|---|
| A — transacción autoritativa | ID estable, tipo edit/undo/redo, delta exacto aplicado, revisión base, secuencia y estado posterior coincidente | Cambio textual exacto, orden, rango UTF-16, reemplazo, revisión y clase de historial declarada por el editor | Intención psicológica, autor humano único o motivo de la edición |
| B — evento nativo de edición | beforeinput/input, inputType, selección/rango y valor anterior/posterior verificables | Tipo de operación indicado por el navegador y delta reconstruido cuando ambos estados concuerdan | Historial completo si el navegador omite, agrupa o reordena eventos |
| C — reconciliación por snapshot | Snapshot autoritativo antes/después, misma identidad de documento y revisiones conocidas | Diferencia neta entre snapshots y punto desde el que se recuperó la sincronización | Secuencia exacta de operaciones intermedias, pulsaciones, orden interno o undo/redo |
| D — señal indirecta | Teclas, foco, clipboard, selección, temporizadores o cambios DOM sin transacción verificable | Solo el hecho observable de esa señal, con su fuente | Que la señal produjo necesariamente un cambio textual |

El sistema debe preferir A, luego B y usar C para recuperar coherencia. D puede complementar el diagnóstico, pero no sustituye un delta aplicado. Una comparación de snapshots nunca debe inventar el historial intermedio.

## 3. Contrato de un evento exacto

Cada transacción textual aceptada debe conservar, como mínimo:

- documentId estable;
- transactionId único e idempotente;
- sequence estrictamente consecutiva por documento;
- baseRevision igual a la revisión inmediatamente anterior;
- start/end como offsets UTF-16 sobre el texto anterior;
- replacement exacto;
- kind edit/undo/redo emitido por el historial real del editor;
- confirmación de que el estado posterior del editor refleja la transacción;
- cancelación de suscripción y propagación FIFO.

El delta debe representar exactamente el cambio aplicado. Si una transacción contiene varios pasos, solo se normaliza a un reemplazo contiguo cuando el intervalo y el fragmento resultante son equivalentes. Si no se puede demostrar esa equivalencia, se detiene la captura y se solicita un snapshot común. Nunca se envía un delta parcial para conservar artificialmente la continuidad.

Los offsets UTF-16 son la unidad de interoperabilidad del motor JavaScript. No equivalen necesariamente a caracteres percibidos por una persona: un emoji, una letra con marcas combinantes y ciertos grafemas pueden ocupar varias unidades UTF-16. Los nombres de métricas que usen «caracteres» deben documentar esta unidad y no presentarla como conteo de grafemas.

## 4. Cobertura de operaciones que debe verificarse

| Operación | Evidencia preferida | Regla de exactitud |
|---|---|---|
| Escritura de texto | transacción aplicada / beforeinput + input | contar el delta aplicado, no cada keydown |
| Borrado hacia atrás/adelante | transacción o inputType de borrado | rango eliminado exacto; distinguir dirección solo si el editor la informa |
| Selección y reemplazo | transacción con rango anterior | una sustitución, no una inserción y borrado ficticios |
| Pegado | transacción aplicada; clipboard como metadato auxiliar | el contenido insertado proviene del delta, no del clipboard que pudo ser transformado |
| Cortar | delta aplicado y evento de corte | solo contar borrado cuando el editor confirme el cambio |
| Arrastrar y soltar | transacción aplicada | distinguir movimiento interno de inserción externa solo si el editor lo informa |
| Deshacer/rehacer | historial nativo con kind y delta exacto | no inferir por Ctrl/Cmd+Z, botones ni inputType aislado |
| IME/composición | ciclo compositionstart/update/end más estado aplicado | no contar estados provisionales como cambios finales; verificar commit y cancelación |
| Autocorrección/sustitución del sistema | transacción o inputType y delta verificado | registrar el reemplazo real, no atribuirlo automáticamente a intención manual |
| Reemplazo múltiple/edición por lotes | transacción compuesta normalizable | si no es normalizable exactamente, snapshot y resincronización |
| Formato sin cambio textual | evento de formato del editor, si se decide instrumentarlo | no incrementar secuencia textual ni caracteres |
| Cambio externo/colaborativo | transacción remota identificada por el anfitrión | separar origen local/remoto solo con metadatos fiables |
| Restaurar/autocompletar | transacción o snapshot | no reconstruir pulsaciones que no existieron |

## 5. Tiempo: qué significa cada instante

Deben mantenerse separados los conceptos siguientes:

- instante de aplicación en el editor: cuando el estado nativo incorpora el cambio;
- instante de recepción por el adaptador: cuando el monitor recibe el evento;
- instante de admisión: cuando HostEngineApi acepta o rechaza el delta;
- instante de commit durable: cuando el almacenamiento confirma la revisión;
- instante de análisis: cuando termina el trabajo derivado, si existe.

La latencia de commit no es latencia de escritura. La hora de recepción no debe presentarse como hora física exacta de pulsación. Para duraciones dentro de una misma ejecución se prefiere un reloj monotónico; los timestamps de pared sirven para correlación externa y no deben mezclarse directamente con performance.now(). Tras suspender o reanudar una pestaña, el sistema debe reconocer que los temporizadores pueden haberse retrasado.

## 6. Integridad y detección de lagunas

La captura solo puede declararse sincronizada si coinciden documento, revisión, secuencia y longitud esperada. Deben distinguirse:

- evento duplicado idéntico: ignorar idempotentemente;
- ID reutilizado con contenido distinto: detener y diagnosticar;
- salto de secuencia o revisión base incorrecta: detener y resincronizar;
- rango UTF-16 fuera del documento anterior: rechazar;
- estado posterior del editor no coincidente: detener;
- snapshot inaccesible: detener sin inventar estado;
- cola llena: retener FIFO, aplicar contrapresión y nunca descartar silenciosamente;
- overflow del buffer externo: pausar la fuente y exigir snapshot común;
- pérdida de lease/fencing: impedir escrituras del propietario obsoleto;
- cierre abrupto o suspensión: recuperar solo desde el último estado durable verificable.

Un contador de eventos recibidos no demuestra por sí solo que no hubo eventos perdidos. La garantía de continuidad procede de secuencia/revisión y de la comparación con el estado autoritativo.

## 7. Interpretación de actividad: límites epistemológicos

El monitor puede medir cambios, ritmo de cambios, pausas entre cambios recibidos, revisiones, commits, fallos y latencias. No puede deducir con certeza:

- quién estaba físicamente frente al dispositivo;
- si una pausa significa reflexión, distracción o abandono;
- si una corrección fue gramatical, estilística o factual sin análisis adicional;
- la intención detrás de una operación;
- palabras «pensadas» pero no escritas;
- pulsaciones que el navegador/editor nunca expuso;
- actividad ocurrida mientras la aplicación no tenía una fuente de eventos activa.

Las etiquetas typing/paste/deletion/correction/undo/redo deben proceder del editor cuando exista metadato nativo. Si se infieren por la forma del delta, la UI y la documentación deben identificar esa clasificación como inferida. No se debe presentar una clasificación inferida como observación directa.

La velocidad en palabras por minuto derivada de unidades de texto es una estimación, no un conteo lingüístico exacto. Para un conteo real de palabras se necesita definir idioma, tokenización, tratamiento de contracciones, guiones, números, puntuación y escrituras sin espacios. No se debe convertir automáticamente cinco unidades UTF-16 en una palabra real.

## 8. Indicadores mínimos de calidad que debe exponer el diagnóstico

- nivel de evidencia de la fuente activa;
- documento, revisión y secuencia actuales;
- última secuencia admitida y última durable;
- diferencia pendiente entre ambas;
- eventos aceptados, rechazados, duplicados y reintentados;
- causas de rechazo desglosadas;
- profundidad y máximo histórico de las colas;
- estado de contrapresión y motivo;
- número de resincronizaciones y causa de cada una;
- edad del último evento recibido y del último commit;
- estado de lease, owner y fencing token cuando aplique;
- disponibilidad del snapshot y resultado de la última verificación;
- errores de listeners y callbacks de diagnóstico;
- tiempo de recepción, admisión, commit y análisis, medidos por separado.

Los diagnósticos no deben incluir replacement, texto del manuscrito, portapapeles ni contenido sensible. Se pueden conservar hashes compactos para deduplicación si están acotados y no se exponen como contenido recuperable.

## 9. Plan de pruebas de exactitud

### Unitarias deterministas
- Inserción, borrado, sustitución, selección y reemplazo.
- Unicode: pares sustitutos, emoji, marcas combinantes, ZWJ y límites UTF-16.
- Deltas de longitud cero y operaciones que no cambian texto.
- Secuencia duplicada, salto, inversión y revisión obsoleta.
- IDs repetidos idénticos y reutilizados con delta distinto.
- Undo/redo real con rangos que cambian de longitud.
- Transacciones compuestas equivalentes y no equivalentes.
- Excepciones en lectores, suscriptores y callbacks.
- Reloj monotónico que retrocede, se detiene o salta por suspensión.
- Contrapresión, overflow, reintento FIFO y snapshot de recuperación.

### Navegador real
- Chromium con escritura rápida, selección, pegar, cortar, arrastrar, IME y autocorrección.
- Cerrar pestaña abruptamente mientras hay deltas en cola.
- Suspender/reanudar, pageshow, visibilitychange y pagehide.
- Dos pestañas compitiendo por el mismo documento y documentos distintos.
- IndexedDB bloqueado, cuota agotada, transacción abortada y almacenamiento temporalmente inaccesible.
- Comparar secuencia final del editor con secuencia admitida y durable.

### Criterios de aceptación
- Cero cambios silenciosamente perdidos.
- Orden FIFO y secuencias monótonas.
- Ningún delta se declara exacto sin validación de estado.
- Toda discontinuidad produce diagnóstico y pausa/resincronización.
- Las métricas separan cambios observados de commits durables.
- Los casos de navegador se reportan por motor/versión y no se extrapolan a navegadores no probados.
- Los resultados de benchmark incluyen tamaño de documento, número de eventos, entorno, percentiles y carga concurrente.

## 10. Estado de implementación frente a esta matriz

Ya existen contratos y pruebas para deltas transaccionales, revisión/secuencia, offsets UTF-16, deduplicación, estado posterior, cola reentrante, contrapresión, snapshots comunes, leases, recuperación y una aplicación de referencia textarea en Chromium.

Sigue siendo necesario conectar el proveedor de transacciones del editor enriquecido de producción. La aplicación de referencia demuestra el flujo con textarea y navegador; no demuestra por sí misma que todos los editores, IME, operaciones de arrastre o historiales nativos estén cubiertos.

Esta matriz es una guía de aceptación. Cada fila debe marcarse como verificada solo después de añadir una prueba reproducible y enlazar el resultado de CI. No se debe declarar «100 % de precisión» en abstracto: la precisión se acredita por operación, fuente, navegador y escenario.

## 11. Composición IME: estados provisionales frente a texto confirmado

Una composición puede aplicar varios candidatos al mismo rango. Cada actualización puede ser un cambio real del control de edición y debe conservarse en la secuencia textual cuando el objetivo sea mantener el snapshot sincronizado. Sin embargo, esas actualizaciones no equivalen a varias piezas de texto final escritas por el autor.

La fuente textarea identifica estos deltas como `activityKind: "composition"`. El motor conserva cada operación aplicada en la secuencia y mantiene los acumulados brutos `insertedCharacters` y `deletedCharacters`. Ahora separa además unidades por procedencia:

- `typingInsertedCharacters`: unidades UTF-16 insertadas por operaciones identificadas explícitamente como `typing`.
- `compositionInsertedCharacters`: suma de unidades insertadas por cada delta IME aplicado, incluidos todos los candidatos provisionales.
- `compositionDeletedCharacters`: suma de las unidades sustituidas por cada delta IME aplicado.
- `activityUnitMetricsComplete`: false después de restaurar un checkpoint histórico sin desglose por procedencia, después de resincronizar desde snapshot o cuando se admite una edición sin `activityKind` reconocida explícitamente. El snapshot confirma el texto actual, pero no permite reconstruir los tipos/rangos de deltas que pudieron faltar; una operación sin procedencia no debe atribuirse como escritura normal ni como composición.

Estas métricas no representan longitud final confirmada: reemplazar varios candidatos puede sumar las mismas posiciones más de una vez, y una cancelación puede restaurar el texto original después de varios deltas. El total bruto no se cambia, porque cada operación aplicada forma parte de la secuencia que sincroniza el documento.

`estimatedWordsPerMinute` y `insertedCharactersPerMinute` usan solo las unidades `typing` en el numerador. Dividen por el tiempo activo total de la sesión, que puede incluir también pegados, correcciones y composición; por eso no son una medición pura del tiempo de teclado ni un recuento de palabras finales confirmadas.

La longitud y los rangos siguen expresados en unidades UTF-16, no en grafemas o palabras lingüísticas.

Para producir una métrica exacta de composición confirmada hace falta un contrato de grupo con identidad de composición, rango inicial, actualizaciones provisionales y resultado final (commit/cancel). Ese cierre debe proceder del editor anfitrión o de una secuencia nativa validada; no se debe deducir solo de un temporizador ni de un `compositionend` aislado.

**Evidencia Chromium:** `tests/live-author-monitor-ime-composition-browser.test.mjs` usa CDP para aplicar dos candidatos y cancelar. Las actualizaciones `compositionstart/update/beforeinput/input` se observaron confiables; el `compositionend` producido por CDP llegó con `isTrusted=false`, por lo que la fuente suspende y exige snapshot. Esto valida la política conservadora, no un IME físico del sistema operativo.
La correlación manual compara de forma independiente `inputType` además de la disponibilidad/comparación de `InputEvent.data`. Si los dos eventos anuncian tokens no vacíos distintos, ambos reciben `pairStatus: inputtype-mismatch` y se incrementa `inputTypeMismatchCount`; no se incrementa `pairedInputCount`. Por eso una comparación de datos textuales `match` no convierte un par de procedencia contradictoria en una operación válida. Si el evento `input` carece del token, la traza distingue `paired-inputtype-unavailable` y `pairedWithoutInputTypeCount`.

## 12. Procedencia nativa inputType y traza manual v3

`EditorChange.inputType` conserva el identificador exacto de `InputEvent.inputType` cuando existe. Está limitado a 128 caracteres y rechaza caracteres de control. Es un identificador de operación que declara el navegador, no una prueba de intención ni de teclado físico: `insertText` puede proceder de distintas formas de entrada; `insertFromDictation`, `insertFromDrop` y `insertFromYank` no se clasifican como escritura manual ni como pegado sin evidencia adicional.

La fuente textarea emite además la categoría agregada `activityKind` solo cuando el `inputType` permite una clasificación conservadora. Si está vacío o ausente, el textarea suspende y pide snapshot porque no puede validar con seguridad si fue una inserción o eliminación. Un proveedor transaccional puede entregar un delta exacto sin `activityKind`, pero la cobertura de unidades se marca parcial.

El adaptador transaccional conserva `inputType` en su cambio inmutable y lo incluye en la firma de deduplicación. Reutilizar un mismo `transactionId` con otro `inputType` se trata como identidad de transacción reutilizada, no como retransmisión idéntica.

`inputType` no lleva `InputEvent.data` ni texto del manuscrito. No se escribe en checkpoints, snapshots ni diagnósticos persistentes. La página local de prueba puede incluirlo en el informe descargable por el usuario: el formato se elevó a `live-author-monitor-ime-trace-v3`; cada delta exporta categoría y `inputType`, mientras que `InputEvent.data` se representa únicamente mediante su longitud UTF-16. El informe sigue excluyendo texto, candidatos IME, contenido tecleado y cargas de eventos.

Esta evidencia local permite comparar `beforeinput`/`input`, tipos nativos y deltas aplicados por navegador/SO sin registrar el manuscrito. No reemplaza el test con IME físico del sistema operativo ni la conexión al editor enriquecido de producción.