# Validación de emparejamiento beforeinput/input — 2026-11-26

## Objetivo

Evitar que el adaptador de captura nativa asocie un evento `input` con una selección anterior cuando el navegador/editor produce un segundo `beforeinput` antes de completar el primero.

## Cambio implementado

En `typescript/src/live-author-monitor-textarea-source.ts`:

- Se añadió el código de diagnóstico `missing-input`.
- Antes de aceptar un nuevo `beforeinput`, el adaptador comprueba que no quede un `beforeinput` previo pendiente.
- Si existe uno, suspende la captura, descarta el estado pendiente y exige resincronización.
- No emite un delta especulativo ni permite que el segundo evento sobrescriba silenciosamente el rango original.

Esto cubre una secuencia ambigua que también puede aparecer cuando un `beforeinput` fue cancelado por otro listener después de que el adaptador lo observó: si no llega el `input` correspondiente, el siguiente `beforeinput` detecta el emparejamiento incompleto.

## Prueba añadida

En `typescript/tests/live-author-monitor-textarea-source.test.mjs`:

- Nuevo caso: `exige resincronización si llega otro beforeinput sin completar el input anterior`.
- Simula dos `beforeinput` consecutivos, seguidos de un único `input`.
- Verifica que no se emite ningún cambio, que `needsResync` pasa a `true` y que el diagnóstico es `missing-input`.

## Prueba de integración Chromium

Se amplió `tests/live-author-monitor-browser.test.mjs` para ejecutar el adaptador sobre un `HTMLTextAreaElement` real en Chromium y despachar eventos `InputEvent` del navegador:

- Comprueba que un par `beforeinput`/`input` válido produce un delta con offset y reemplazo exactos.
- Comprueba que dos `beforeinput` consecutivos suspenden la captura con `missing-input` y sin publicar un segundo delta.
- Esta prueba valida el comportamiento de los eventos DOM reales, pero no simula un teclado físico ni sustituye pruebas manuales/automatizadas con IME del sistema operativo.

## Criterio de seguridad

La captura solo publica cambios cuando puede asociar el evento posterior con el estado previo inmediato. Ante pérdida de emparejamiento, prefiere perder temporalmente continuidad y recuperar desde un snapshot autoritativo antes que inventar offsets o texto.

## Commits

- Adaptador: `d335584f9414819ab135189ca397da56c0b194e7`
- Prueba unitaria: `81d09653bc9d4fa80f0382621653ecc46578216a`
- Integración Chromium: `99237414236e03f649cb72cdf401949067e9a4cf`

## Estado de validación

La ejecución CI anterior `45778453905` finalizó con éxito en type-check, build, pruebas automatizadas, instalación de Chromium y benchmark. La nueva modificación genera una ejecución independiente; su resultado debe comprobarse antes de considerar validada esta iteración.

## Límites conocidos

- Si un `beforeinput` queda pendiente y no ocurre ningún otro evento observable, el adaptador no puede determinar por sí solo si fue cancelado o si el navegador aún está procesando la edición. No se introduce un timeout especulativo.
- Los eventos nativos no revelan siempre la intención semántica del autor.
- La integración de un editor enriquecido debe usar su proveedor de transacciones autoritativas cuando esté disponible.


## Corrección de orden IME compositionend/input

En algunos navegadores el evento `compositionend` puede llegar antes del `input` que completa el último `beforeinput` de composición. El adaptador anterior interpretaba esa separación como una composición truncada y descartaba el cambio final.

Se corrigió `handleCompositionEnd` para cerrar el indicador de composición sin invalidar un `beforeinput` pendiente. El delta solo se publica cuando llega el `input` asociado; si no llega y aparece otro `beforeinput`, continúa aplicándose el diagnóstico `missing-input`. Así se tolera el orden de eventos sin debilitar la regla de emparejamiento.

Regresión añadida en `live-author-monitor-textarea-source.test.mjs`: `acepta el input final cuando compositionend precede al input en el navegador`.

Commits:
- Corrección: `11dc5a86032f38cfe313c390769daf46ba5bf193`
- Prueba: `ed2482015f1e558b5d1c2ed78e4202f755e01f36`

**Estado de validación actualizado:** la compilación, la suite específica del monitor y la integración Chromium ya se completaron en los workflows `45786484345` y `45786484481`, ambos sobre el commit `1838d242d5ceabbe964dbcbe541bb8ebcf7bf240`; los resultados completos se registran al final de este documento. La matriz con sesiones IME físicas de distintos sistemas operativos, navegadores e idiomas permanece pendiente.


## Verificación exacta del contexto fuera del rango editado

Se detectó que comparar solo longitudes permite aceptar una mutación programática concurrente de igual tamaño en una zona ajena a la selección anunciada por `beforeinput`. Por ejemplo, con `abcde`, una edición iniciada en el offset 2 no debe atribuirse como escritura válida si el valor final es `aZcde`: cambió el prefijo, aunque la longitud siga siendo cinco.

El adaptador ahora mantiene `previousText` únicamente en memoria mientras está montado y verifica, antes de publicar:
- que el prefijo anterior a `start` permanezca idéntico;
- que el sufijo posterior a `end` permanezca idéntico y alineado después del reemplazo;
- que las operaciones `delete*` no introduzcan texto de reemplazo;
- que el snapshot efímero, la longitud capturada y el estado previo coincidan.

Ante una diferencia fuera del rango, no emite el delta, informa `inconsistent-length` y exige resincronización. El snapshot se actualiza solo después de validar una edición y se reemplaza por el texto del snapshot autoritativo al resincronizar. No se persiste en IndexedDB ni se envía como diagnóstico.

Regresiones añadidas:
- mutación externa de igual longitud fuera del rango anunciado: debe rechazarse;
- inserción legítima entre caracteres repetidos: debe aceptarse.

Si el navegador proporciona `beforeinput.data`, una segunda barrera compara ese valor con el segmento real del textarea tras la operación. Se probó tanto el caso coincidente (se acepta) como una mutación externa de igual longitud **dentro** de la selección (se rechaza con `input-data-mismatch`). Los eventos que entregan `data=null` conservan el comportamiento estructural anterior; no se inventa un payload esperado. El valor esperado (`inputData`) se mantiene únicamente en el estado pendiente hasta completar el par `beforeinput`/`input`; se libera al consumirlo, fallar o disponer el adaptador y nunca se incluye en logs, diagnósticos ni checkpoints.

**Límite conocido tras la validación del payload:** el contexto completo fuera del rango detecta cambios ajenos a la selección. Cuando `beforeinput.data` está disponible como string y el `inputType` es de inserción, el adaptador también exige que coincida exactamente con el texto realmente insertado; ante contradicción no emite el delta, informa `input-data-mismatch` y exige resincronización. Si el navegador expone `data=null`, esa comprobación de contenido no es posible: una mutación programática de igual longitud dentro del rango podría seguir siendo indistinguible. Ninguna de estas señales demuestra intención humana; el anfitrión debe controlar las mutaciones del editor y proporcionar transacciones/origen verificables para una garantía superior.

## Clasificación de actividad basada en inputType observable

Se corrigió una atribución de métricas: una sustitución normal de selección hecha con `insertText` podía terminar como `correction`, porque el monitor infería la categoría a partir de que el rango anterior fuera reemplazado. La geometría del delta no demuestra una autocorrección.

El adaptador ahora establece siempre una categoría explícita para los eventos aceptados:

- `insertText`, `insertLineBreak` e `insertParagraph` → `typing` (entrada de texto declarada por el navegador);
- `insertCompositionText` → `composition` (actualización de composición IME; no se suma a escritura ordinaria);
- `insertFromPaste` y `insertFromPasteAsQuotation` → `paste`;
- `insertReplacementText` → `correction` (señal específica de reemplazo del navegador);
- los tipos `delete*` → `deletion`;
- `insertFromDrop`, `insertFromYank` y tipos no reconocidos → `other`.

La categoría `typing` no prueba que se haya usado un teclado físico, y `correction` no prueba la intención subjetiva del autor. Son clasificaciones técnicas del evento declarado por el navegador. Para mayor precisión, no se deduce una categoría a partir de la longitud o forma del delta.

Se añadió una regresión que compara tres casos: sustitución de selección con `insertText` (typing), sustitución con `insertReplacementText` (correction) y mecanismo de inserción no reconocido (other).

También se corrigió la documentación del adaptador: la copia sombra completa introducida para comprobar prefijo/sufijo es efímera y reside en memoria mientras la instancia está montada. No se guarda en IndexedDB ni se envía en diagnósticos; la memoria se libera al disponer la instancia.

## Fallback conservador del monitor central

La misma protección se aplica ahora a cualquier adaptador, no solo al textarea: si un `EditorChange` llega sin `activityKind`, el monitor central lo cuenta como `other`. Ya no deduce `typing`, `correction` o `deletion` por la forma del rango y del reemplazo. Un reemplazo de selección puede proceder de escritura, pegado, dictado, autocorrección o una transacción programática; sin metadatos de origen no hay evidencia suficiente para distinguirlos.

Los adaptadores que sí conocen el evento deben proporcionar `activityKind` explícitamente. El adaptador nativo del textarea lo hace usando el `inputType` observado. Esta decisión es deliberadamente conservadora: puede dejar parte de la actividad en `other`, pero evita presentar como hecho una categoría que el motor no observó.

Se añadió una prueba para tres deltas sin procedencia (inserción, sustitución y eliminación); los tres deben incrementar solo `otherChanges`. Los casos de takeover que esperan métricas de escritura ahora declaran `activityKind: "typing"` expresamente.

## Resultado de validación CI de esta iteración

En la ejecución `45780942285` asociada al commit `49007e0716b551683da87ed7026d11c3dc9ed88a`, se verificó que terminaron correctamente:

- type-check aislado del monitor y su UI;
- bundle aislado de pruebas del monitor;
- regresiones aisladas de recuperación de diagnósticos;
- validación de esquema MLDB y mapeo físico;
- suite aislada de pruebas unitarias y diagnósticas del monitor.

La construcción del bundle general falló antes de la integración host/editor, en `src/narrative-action-link-discovery.ts:46`, un archivo ajeno al cambio de captura. El workflow de monitor continuaba instalando Chromium en la última consulta; por ello, el resultado final de ciclo de vida, integración navegador y benchmark de esta ejecución queda **pendiente**. No se declara aprobada la integración completa ni el pipeline global a partir de los pasos aislados que sí terminaron correctamente.

Las fallas iniciales de expectativas que aparecieron en ejecuciones anteriores se corrigieron en los tests del adaptador nativo, la integración HostEngineApi y Chromium. La ejecución `45780942285` confirmó la suite aislada corregida en verde.

## Reparación de validación global posterior

Al ejecutar la suite completa, se aislaron problemas en pruebas de descubrimiento narrativo que bloqueaban la validación general:
- Los ejemplos nuevos de vínculos entre acciones utilizaban verbos que el inventario de acciones no reconoce. Se sustituyeron por formas ya presentes en el extractor (entrar, correr, buscar, llegar, perder, recibir, caminar y responder), manteniendo cada marcador temporal/causal/adversativo entre dos acciones observables.
- Un caso temporal había sido incorporado con secuencias `\\n` literales dentro de una línea JavaScript; se restituyó el formato multilínea del test.

Estos cambios corrigen fixtures y formato de pruebas, no amplían el clasificador lingüístico. La validación global debe repetirse sobre el commit resultante; todavía no se declara aprobada.
Se afinó una última fixture de conectores concesivos para usar el mismo par de formas verbales ya comprobado por las pruebas base (`entró`/`corrió`). Así, esos casos aíslan el reconocimiento del conector y no dependen de variaciones en el inventario morfológico de acciones.


## Procedencia del evento DOM: rechazo de eventos sintéticos

El adaptador de `textarea` exige ahora `Event.isTrusted === true` en `beforeinput`, `input`, `compositionstart` y `compositionend`. Los eventos creados por código mediante `dispatchEvent()` no son evidencia de que el navegador haya recibido una acción real del usuario; el adaptador detiene el stream con el código `untrusted-event` y requiere un snapshot autoritativo para reanudarlo.

Esto evita que un script simule una edición enviando un `InputEvent` con `inputType: "insertText"`. Los editores que actualicen el texto mediante transacciones programáticas deben conectarse por el adaptador transaccional y aportar origen explícito, no falsificar eventos DOM confiables.

La prueba unitaria verifica que se rechacen tanto un `beforeinput` sintético como un `input` sintético posterior a un `beforeinput` confiable. La prueba Chromium ahora escribe una tecla mediante la automatización real del teclado del navegador y, por separado, intenta un `dispatchEvent()` sintético que debe bloquearse. La prueba de Chromium aún debe terminar en CI antes de considerar esta capa validada.

## Límites Unicode en marcadores discursivos

La suite detectó que el conector `Aun así` no era encontrado: los límites `\b` de JavaScript no separan de forma fiable ciertas palabras que terminan en letras acentuadas como `í`. Se reemplazaron en los tres grupos de marcadores (temporales, causales y adversativos) por lookbehind/lookahead con `\p{L}`, `\p{M}`, `\p{N}` y `_`, para no reconocer subcadenas dentro de palabras y sí respetar letras acentuadas y marcas combinantes. El test adversativo `Aun así` permanece como regresión del defecto.

## Filtro de infinitivos en transiciones de estado

La suite global reveló que `Ana no pudo activar la Espada Solar` generaba una transición `activated` aunque estuviera marcada como `effectStatus: not-applied`. La causa era que `discoverNarrativeObjectTransitionCandidates` publicaba el candidato antes de excluir la forma infinitiva subordinada. Ahora los infinitivos no generan transiciones de estado; permanecen en el flujo de observaciones como evidencia textual. Se conservan candidatos para formas finitas negadas (`not-applied`) y futuras (`prospective`), sin aplicarlos al estado actual.

## Validación integrada del monitor — ejecución 45782184179

La ejecución GitHub Actions **45782184179** terminó con conclusión `success` en el commit `3e84390ac3ca3d3ec6426878c42414b84208aae5`, que ya incluía la validación `isTrusted`, sus pruebas y la captura de teclado en Chromium.

Pasaron todos los pasos del workflow específico:
- type-check aislado del monitor y UI;
- bundle aislado de pruebas;
- regresiones de recuperación de diagnósticos;
- validación del esquema MLDB y mapeo físico;
- build runtime;
- suite unitaria y diagnóstica;
- instalación Chromium y prueba de Page Lifecycle;
- integración host/editor/navegador, incluida captura confiable de teclado y rechazo de `dispatchEvent()`;
- benchmark de memoria.

La suite combinada de integración informó **196 pruebas aprobadas y 0 fallidas**. El benchmark informado por el runner (Node v22.23.5) ejecutó 100.000 commits: 8 documentos, 1.048.576 unidades UTF-16 iniciales por documento y 12.500 cambios por documento. Midió 642,39 ms (155.669,68 commits/s), 0 MB de crecimiento adicional del heap entre media y carga completa, 0,5 MB retenidos por las sesiones abiertas y 70,43 MB de RSS. Son medidas de ese runner y de ese escenario, no una garantía de rendimiento idéntica en todos los equipos.

**Estado:** el workflow específico de monitoreo está validado de extremo a extremo en esa revisión. La suite general del repositorio es independiente y sigue verificándose tras los cambios recientes del módulo narrativo; no se infiere que esté aprobada a partir de este workflow.

## Normalización de adjetivo emocional singular

La suite global detectó que el patrón emocional incluía `felices?`, que no cubría el singular español `feliz`. Se explicitó `feliz|felices`, conservando la frontera Unicode existente para impedir coincidencias parciales.

## Liberación de la copia temporal durante suspensión

La referencia `previousText` se limpia ahora inmediatamente cuando el adaptador entra en `needsResync` y también en `dispose()`. La instancia ya no retiene el contenido completo mientras espera un snapshot autoritativo o cuando el anfitrión mantiene una referencia a una instancia desmontada. Solo `resynchronize()` puede volver a cargar el texto desde un snapshot verificado. Se añadió una regresión que comprueba suspensión, recuperación y disposición.

## Validación global completa — ejecución 45783004619

En el commit `28afb9067c17a3b8e5d4d720cc0c819569f2dbdc`, el workflow general **Motor Literario TypeScript** (ejecución **45783004619**) terminó en `success`: type-check, build y suite automatizada. Resultado de la suite: **1.118 pruebas aprobadas, 0 fallidas**. El benchmark global también terminó correctamente.

## Validación final del monitor con liberación del snapshot — ejecución 45783004474

En el mismo commit `28afb9067c17a3b8e5d4d720cc0c819569f2dbdc`, el workflow **Live Author Monitor** (ejecución **45783004474**) terminó en `success` en todos sus pasos: type-check aislado, bundle, recuperación de diagnósticos, esquema, runtime, suite unitaria/diagnóstica, Chromium Page Lifecycle, integración host/editor/navegador y benchmark.

- Suite de integración: **197 pruebas aprobadas, 0 fallidas**.
- Prueba Chromium: teclado real de navegador aceptado y `dispatchEvent()` sintético rechazado por `untrusted-event`.
- Prueba de privacidad: la copia temporal del manuscrito se limpia al suspender y al disponer; solo se vuelve a cargar desde snapshot autoritativo.
- Benchmark del monitor: 8 documentos; 1.048.576 unidades UTF-16 iniciales por documento; 12.500 cambios por documento; 100.000 commits; 496,77 ms; 201.298,76 commits/s; 0,5 MB retenidos por las sesiones abiertas; 0 MB de crecimiento adicional del heap de media a carga completa; RSS 71,73 MB.

**Límite de interpretación del benchmark:** mide el núcleo `LiveAuthorMonitor` y sus sesiones/contadores; no es una medición aislada del costo de comparación de texto del adaptador `textarea`. Las cifras son específicas de ese runner Node v22.23.5 y no deben generalizarse como latencia garantizada por pulsación.


## Separación de actividad IME y escritura ordinaria

El adaptador clasifica ahora `insertCompositionText` como `composition`, nunca como `typing`. La categoría representa una actualización de composición observada por el navegador (por ejemplo, la sustitución de una forma candidata por otra en un IME); no representa una pulsación de tecla ni confirma por sí sola que el texto sea definitivo.

La nueva métrica `compositionChanges` se propaga por:
- `EditorChangeActivityKind` y los deltas del adaptador;
- la sesión y los snapshots inmutables de `LiveAuthorMonitor`;
- checkpoints v1 y restauración tras reinicio;
- el panel de capítulo y las tarjetas del workspace, con la métrica visible **Composición IME**.

La propiedad del checkpoint es opcional para mantener compatibilidad con checkpoints v1 anteriores. Cuando no existe, la recuperación la inicializa en cero; no se puede reclasificar retroactivamente la actividad histórica que las versiones anteriores ya contabilizaron como escritura u otras categorías. El validador sí rechaza un contador nuevo negativo, fraccionario o no entero.

Se añadieron regresiones que verifican dos actualizaciones provisionales japonesas consecutivas, su categoría distinta de escritura ordinaria, la conservación del contador después de checkpoint/restauración y el rechazo de un checkpoint manipulado. El panel también incluye la categoría independiente.

### Límite semántico que permanece explícito

Cada actualización IME aceptada sigue siendo un delta real del documento y avanza revisión/secuencia como cualquier otra edición. Si el candidato cambia de `に` a `日本`, el stream contiene dos operaciones de composición, aunque el texto final conserve solo `日本`. Por eso:
- `compositionChanges` cuenta actualizaciones observadas, no composiciones finales ni caracteres únicos;
- `insertedCharacters` y `deletedCharacters` siguen siendo volúmenes brutos acumulados de los payloads/rangos de cada delta;
- los ritmos derivados de esos volúmenes también son brutos y pueden elevarse durante una composición con sustituciones provisionales.

El panel y el workspace de capítulos ahora lo indican con etiquetas de métricas brutas (UTF-16) para que el dato no parezca una medida de caracteres finales únicos. No se afirma que estos contadores midan caracteres finales únicos ni una tasa humana exacta. Para medir texto de composición consolidado sin sobreconteo haría falta una señal de ciclo de composición autoritativa del editor que delimite inicio, actualizaciones, cancelación y commit final; el evento DOM aislado no ofrece una garantía uniforme suficiente para inventar esa conclusión.



### Base del ciclo IME y alcance de las pruebas

El borrador vigente de [Input Events Level 2 del W3C](https://www.w3.org/TR/2026/WD-input-events-2-20261120/) describe, durante una sesión de composición, una secuencia de `compositionupdate` seguida de pares `beforeinput`/`input` con `inputType="insertCompositionText"`; `compositionend` marca el final de la sesión. El adaptador conserva el emparejamiento de cada par y tolera el orden `compositionend`/último `input` que ya tiene regresión específica.

Las pruebas unitarias cubren varias actualizaciones candidatas y el orden de los eventos de composición, pero no equivalen a una sesión física de IME con un teclado/servicio de entrada del sistema operativo. La suite de Chromium ahora prueba dos vías: teclado nativo para `insertText` y candidatos IME mediante `Input.imeSetComposition`, con persistencia IndexedDB y rechazo de eventos sintéticos; una matriz de IME físicos por navegador, sistema operativo e idioma sigue pendiente.


## Validación completa de esta iteración — 26 de noviembre de 2026

Los dos workflows siguientes terminaron correctamente sobre el mismo commit `1838d242d5ceabbe964dbcbe541bb8ebcf7bf240`:

- **[Live Author Monitor — run 45786484345](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45786484345):** type-check aislado; 17/17 pruebas del primer grupo; 180/180 pruebas unitarias/diagnósticas; Chromium Page Lifecycle; integración IndexedDB real entre dos páginas; integración de capítulos/workspace. El resultado integrado fue **198/198 pruebas, 0 fallos**.
- **[Motor Literario TypeScript — run 45786484481](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45786484481):** type-check global, build, validación de esquema y bundle; suite completa **1.145/1.145 pruebas, 0 fallos**; las pruebas Chromium de IndexedDB, Page Lifecycle y capítulos también terminaron correctamente.

### Benchmark de memoria del monitor

La ejecución global reportó el escenario `live-author-monitor-bounded-heap` con 8 documentos, 1.048.576 unidades UTF-16 iniciales por documento, 12.500 cambios por documento y 100.000 commits totales. En esa ejecución: 383,63 ms, 260.667,99 commits/s, 0,5 MB retenidos por sesiones abiertas, 0 MB de crecimiento de heap entre media carga y carga completa y 71,79 MB de RSS final. El workflow dedicado del monitor observó 649,01 ms y 154.080,69 commits/s para el mismo volumen; ambos resultados son mediciones de ejecución, no garantías de rendimiento.

**Alcance del benchmark:** mide el núcleo `LiveAuthorMonitor` (sesiones, commits y contadores), no el coste aislado ni el heap de la copia de texto del adaptador `TextArea`. La comprobación `beforeinput.data` añade una comparación del segmento insertado cuando el navegador entrega un dato no nulo; la extracción usa esa misma cadena validada, evitando una segunda copia del segmento.

### Límites que siguen abiertos

- Las pruebas de IME cubren secuencias de eventos y sustitución de candidatos con fixtures de prueba. La integración Chromium confirma teclado nativo para `insertText`, pero no simula una sesión física de IME del sistema operativo.
- Hace falta una matriz real de idiomas, IME, navegadores y sistemas operativos para medir diferencias de `compositionstart`, `compositionupdate`, pares `beforeinput`/`input` y `compositionend`.
- Cuando `beforeinput.data` y `input.data` no proporcionan contenido (`null`), el adaptador no puede contrastar el texto dentro del rango editado; solo aplica las verificaciones estructurales y del contexto exterior descritas antes.
- Los contadores de composición representan actualizaciones observadas, no cadenas finales únicas; los volúmenes de caracteres y los ritmos se mantienen explícitamente como métricas brutas UTF-16.


### Prueba de candidatos IME con Chromium DevTools Protocol

El test de navegador `Chromium captura candidatos IME y separa la confirmación de texto por CDP` usa el comando experimental `Input.imeSetComposition` para aplicar el candidato `に` y sustituirlo por `日本`. El test comprueba en el textarea y en el stream:
- el texto del candidato anterior se sustituye, no se concatena;
- los pares confiables `beforeinput`/`input` con `inputType="insertCompositionText"` originan al menos dos deltas `composition`;
- los eventos `compositionstart` y `compositionupdate` del pipeline de candidatos aparecen y la fuente permanece sincronizada durante la composición.

La confirmación de texto CDP se verifica por separado después de disponer la fuente. En este runner, `Input.insertText` deja el texto final correcto pero genera un `compositionend` que el adaptador clasifica como no confiable y rechaza. No se relajó `isTrusted` para hacer pasar el test: ese rechazo protege la captura frente a eventos que no prueban una entrada confiable. La prueba deja explícito que este comando de automatización no puede sustituir la validación de un commit realizado por un IME físico.

**Límite de automatización:** `Input.imeSetComposition` es un comando experimental del protocolo de Chromium; la prueba verifica el pipeline de edición del navegador, no el comportamiento de un proveedor IME concreto ni del sistema operativo. La API CDP tampoco garantiza estabilidad entre versiones. Referencias: [definición de Input.imeSetComposition](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-imeSetComposition), [Input Events Level 2: orden de eventos durante la composición](https://www.w3.org/TR/input-events-2/#event-order-during-composition) y [Chrome DevTools Protocol: alcance y estabilidad](https://chromedevtools.github.io/devtools-protocol/).


## Validación Chromium IME y cierre de CI — 26 de noviembre de 2026

La prueba de candidatos por CDP terminó correctamente en ambos flujos:

- **[Live Author Monitor — run 45787445618](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45787445618)**, sobre el commit `5b67ce0f3abdf63f02bc9e015f52c1d09d016b4c`: type-check aislado, build del bundle del monitor, pruebas de recuperación/diagnóstico y almacenamiento; Chromium Page Lifecycle; test nuevo de composición IME; integración anfitrión/editor/navegador. Resultado final: **199/199 pruebas, 0 fallos**.
- **[Motor Literario TypeScript — run 45787488579](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45787488579)**, en el commit descendiente `1db3ff013b151d875d9dd20d41561535df1f238c` que conserva el test IME: type-check, build y suite global **1.156/1.156 pruebas, 0 fallos**. El log confirma explícitamente `Chromium captura candidatos IME y separa la confirmación de texto por CDP` como aprobado.

### Benchmark del monitor en la validación dedicada

Escenario `live-author-monitor-bounded-heap`: 8 documentos, 1.048.576 unidades UTF-16 iniciales por documento, 12.500 cambios por documento y 100.000 commits. Resultado observado: 388,61 ms, 257.324,3 commits/s, heap retenido por sesiones abiertas de 0,5 MB, crecimiento de heap media carga→carga completa de 0 MB y RSS final de 70,43 MB. Es una medición del núcleo `LiveAuthorMonitor` (sesiones, commits y contadores), no del coste completo de comparar el texto en `TextArea`; no debe interpretarse como garantía de rendimiento ni como benchmark aislado del adaptador.

### Interpretación conjunta

Queda cubierto en CI que Chromium:
1. inicia una composición y emite eventos confiables de actualización de candidato;
2. emite pares confiables `beforeinput`/`input` de tipo `insertCompositionText`;
3. sustituye el candidato `に` por `日本` sin concatenarlo;
4. produce deltas `composition` mientras el monitor permanece sincronizado;
5. conserva el texto final después de la operación de confirmación de CDP, tratada aparte por la diferencia de confianza observada.

La prueba no convierte esa confirmación de CDP en una edición capturada; el adaptador mantiene el rechazo de `compositionend` no confiable. Sigue pendiente validar commits con IME físicos en sistemas operativos, idiomas y navegadores reales. Esta es una limitación de cobertura de dispositivo, no un test fallido.


## Corroboración doble del payload y validación manual de IME físicos

### Comparación de `beforeinput.data` y `input.data`

La fuente conserva el dato de `beforeinput` solo mientras espera el evento `input` asociado. Al recibir este último:
- si ambos eventos proporcionan texto, los dos valores deben coincidir exactamente;
- si solo uno proporciona texto, ese valor se compara con el segmento realmente insertado en el textarea;
- si ambos proporcionan `null`, no se inventa contenido esperado y se mantienen las verificaciones de rango, longitud, prefijo y sufijo.

Una discrepancia produce `input-data-mismatch`, suspende la fuente y exige un snapshot autoritativo. El diagnóstico no contiene el texto ni los payloads. La implementación y las regresiones cubren: ambos payloads iguales, solo `input.data` disponible, payloads de ambos eventos contradictorios y texto insertado que contradice únicamente `input.data`.

Esta corroboración es conservadora. Si un navegador entrega valores diferentes por una peculiaridad de implementación, la fuente suspende la captura en lugar de adivinar cuál es correcto. La matriz manual permitirá decidir si se necesita una excepción documentada para un motor concreto; no se debe agregar una excepción sin un caso reproducible y versionado.

### Página de validación manual

Se añadió `tests/browser/live-author-monitor-ime-manual.html`, accesible con Vite en:

`http://127.0.0.1:5173/tests/browser/live-author-monitor-ime-manual.html`

Arranque desde `base de datos/Motor-Literario/typescript`:

```bash
npm ci
npx vite --host 127.0.0.1 --port 5173
```

Procedimiento:
1. Abre la URL en el mismo equipo donde está instalado y configurado el IME que vas a validar.
2. Escribe una frase de referencia en el textarea **antes** de iniciar la captura. La frase es la base autoritativa y no se exporta.
3. Pulsa **Iniciar captura** y realiza una composición con el IME real: escribe, cambia entre candidatos, confirma y repite una composición que canceles.
4. Comprueba visualmente el contenido final del textarea. Revisa los contadores de inicio/actualización/fin, los pares `beforeinput`/`input`, los deltas `composition` y el estado `needsResync`.
5. Pulsa **Exportar traza sin contenido**. El JSON se descarga localmente y no se envía a ningún endpoint.

El export contiene marca temporal, navegador/plataforma/idioma declarados por el navegador, longitudes UTF-16, offsets, `inputType`, `isTrusted`, `isComposing`, presencia/longitud de `data`, categorías de delta y códigos de error. **No contiene el manuscrito, letras del teclado, texto de candidatos ni valores de `InputEvent.data`.** La traza conserva como máximo 2.000 entradas; si se supera el límite, elimina las más antiguas y registra cuántas se descartaron. La página no usa IndexedDB ni almacenamiento local para guardar el informe.

### Matriz de dispositivos pendiente de ejecutar

La página permite recopilar evidencia reproducible; no simula el proveedor de IME. Ejecuta la misma secuencia en cada combinación disponible y guarda una traza separada:

| Sistema / navegador | IME e idioma a probar | Cobertura mínima |
|---|---|---|
| Windows 11 / Chrome o Edge | IME japonés y/o Microsoft Pinyin | candidatos sucesivos, commit, cancelación, selección |
| macOS / Safari y Chrome | IME japonés o chino del sistema | candidatos, commit, cancelación, cambio de foco |
| Linux / Firefox y Chromium | IBus con Mozc o motor chino disponible | candidatos, commit, cancelación, suspensión/reanudación |

Anota también las versiones exactas del sistema operativo, navegador y proveedor IME. Las filas son una matriz sugerida; no implican que esas combinaciones ya se hayan probado ni que todos los proveedores estén instalados.

### Criterios de aceptación por traza

- Cada `beforeinput` aceptado debe tener su `input` asociado, con `inputType` coherente.
- Cuando ambos valores `data` sean strings, deben coincidir; cuando alguno sea string, debe coincidir con el segmento insertado.
- Los eventos nativos observados deben tener `isTrusted=true`. Un evento no confiable no se acepta como edición.
- Las actualizaciones `insertCompositionText` deben producir deltas `composition`, no `typing`.
- El candidato nuevo debe sustituir el anterior donde el IME así lo indique; el contenido final debe coincidir con lo que el usuario confirmó.
- La cancelación no debe inventar texto confirmado. Registra los eventos y revisa el valor final; no presupongas que todos los IME cancelan de idéntica forma.
- No debe aparecer `needsResync` en una secuencia válida y completamente emparejada. Si aparece, conserva la traza y el código de error; no desactives la barrera para forzar aceptación.

### Validación de privacidad del export

Se añadió una prueba Playwright que introduce un sentinel de manuscrito y una letra de prueba, inicia la captura, exporta el JSON y verifica que ambos contenidos están ausentes. A la vez verifica que el informe conserva longitudes, `inputType`, metadatos de confianza y longitud de reemplazo. La existencia de datos suficientes para diagnosticar el evento no requiere registrar el contenido literal.


## Validación de corroboración doble y banco manual — 26 de noviembre de 2026

Los dos workflows terminaron en `success` sobre el commit `917d46351d0c86af54ec208a38dcd3e92de3b138`:

- **[Live Author Monitor — run 45789096960](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45789096960):** type-check aislado; 17/17 pruebas de recuperación iniciales; 180/180 pruebas unitarias/diagnósticas; Page Lifecycle Chromium; integración de navegador y anfitrión. Resultado final: **200/200 pruebas, 0 fallos**. Se aprobaron explícitamente el test de candidatos IME por CDP y el test de exportación manual sin contenido del manuscrito.
- **[Motor Literario TypeScript — run 45789096966](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45789096966):** type-check, build y suite global. Resultado: **1.170/1.170 pruebas, 0 fallos**. Pasaron además la prueba de exportación IME y las dos regresiones de nombres con metacaracteres del detector de sujetos elípticos.

### Benchmark del núcleo en estos workflows

- Workflow dedicado: 100.000 commits, 617,21 ms, 162.019,24 commits/s, 0,5 MB retenidos por sesiones abiertas, 0 MB de crecimiento del heap entre media carga y carga completa, RSS 70,73 MB.
- Workflow global: 100.000 commits, 371,20 ms, 269.396,07 commits/s, 0,5 MB retenidos, 0 MB de crecimiento del heap entre media carga y carga completa, RSS 71,82 MB.

Son resultados del benchmark `live-author-monitor-bounded-heap` sobre el núcleo `LiveAuthorMonitor`; no miden el coste total del adaptador de texto y no representan garantías de rendimiento en otros equipos.

### Estado de validación del banco manual

La página manual está compilada y su exportación de metadatos se prueba en Chromium con texto sentinel y entrada de teclado nativa. El JSON descargado no incluye ni el texto sentinel ni el carácter introducido; sí conserva longitudes, offsets y metadatos suficientes para investigar la secuencia. El buffer de eventos y el de deltas se limitan a 2.000 entradas cada uno, con contadores de descartes.

**Pendiente fuera de CI:** todavía no se han ejecutado sesiones con IME físicos ni se han recibido trazas de los equipos de Windows, macOS y Linux descritos en la matriz anterior. No se debe marcar esa matriz como aprobada hasta probar cada combinación real. La página ya está disponible en `tests/browser/live-author-monitor-ime-manual.html` para realizar esa validación en los dispositivos correspondientes.


## Trazas IME v2: correlación de eventos y contadores de vida de sesión

El banco manual exporta ahora el formato `live-author-monitor-ime-trace-v2`.

### Correlación `beforeinput`/`input`

Cada `beforeinput` no cancelado recibe un `pairId`. El evento `input` siguiente consume ese identificador y ambos registros reciben el estado de pareja. El resumen de sesión distingue:
- `pairedInputCount`: pares asociados y completados;
- `pairedWithoutInputTypeCount`: pares en los que `input` no informó un `inputType` utilizable;
- `pendingBeforeInputCount`: operación cuyo `input` todavía no llegó;
- `unmatchedBeforeInputCount`: un nuevo `beforeinput` reemplazó uno pendiente;
- `orphanInputCount`: `input` sin un `beforeinput` pendiente;
- `interruptedBeforeInputCount`: pares pendientes interrumpidos por error del monitor o disposición de la página;
- `inputTypeMismatchCount`: los dos eventos informaron tipos incompatibles;
- `defaultPreventedBeforeInputCount`: el navegador notificó que la operación estaba cancelada antes del cambio por defecto.

El par no se cierra en `compositionend`: el `input` final puede llegar después, tal como se comprobó con el flujo Chromium. Los estados individuales también quedan en los registros cuando aún están dentro del buffer.

### Comparación de `data` sin exportar contenido

Durante el par, el banco compara los strings `beforeinput.data` y `input.data` solo en memoria. En la traza quedan únicamente estos resultados:
- `match`: ambos strings estaban disponibles y eran idénticos;
- `mismatch`: ambos estaban disponibles y diferían;
- `one-sided`: solo uno estaba disponible;
- `unavailable`: ninguno estaba disponible;
- `not-applicable`: no se esperaba un `input` porque el `beforeinput` estaba cancelado.

Los valores literales no se copian a los objetos de eventos, al resumen ni al JSON exportado. El string temporal del evento anterior se libera al emparejar el `input`, al ser reemplazado por otro `beforeinput`, cuando el monitor informa un error o al abandonar la página. En caso de error con un par pendiente, el banco marca ese `beforeinput` como interrumpido, aumenta `interruptedBeforeInputCount` y descarta el payload en memoria. La sustitución por otro `beforeinput` se contabiliza por separado en `unmatchedBeforeInputCount`. Esto permite contrastar exactamente los datos de ambos eventos sin incluir el manuscrito ni los candidatos en la traza.

### Contadores acumulativos y límite del buffer

Los contadores de eventos, confianza, composición, deltas, errores y parejas ahora se incrementan durante toda la sesión y no se calculan filtrando el buffer visible. El buffer de eventos conserva como máximo 2.000 entradas y el de deltas como máximo 2.000; los contadores `droppedEventCount` y `droppedDeltaCount` informan cuántas entradas antiguas se descartaron. Por tanto, una sesión larga puede seguir reportando totales completos aunque su traza detallada cubra solo el tramo más reciente.

La lógica de correlación vive ahora en `tests/browser/live-author-monitor-ime-pairing.js` y se cubre con pruebas unitarias de pares coincidentes, datos contradictorios, datos ausentes/de un solo lado, `inputType` discordante o ausente, cancelación, eventos huérfanos, sustitución de operaciones y liberación por error/disposición. La prueba Playwright amplía la prueba de privacidad: realiza una escritura nativa, verifica un par de eventos completo, despacha 2.010 `compositionupdate` sintéticos solo para estresar el límite del registrador, y comprueba que:
- los contadores registran las 2.010 actualizaciones aunque solo se retengan 2.000 entradas;
- el número de parejas y deltas no cambia cuando se descartan eventos antiguos;
- los valores centinela privados del manuscrito y de los candidatos no aparecen en el JSON;
- la clasificación de confianza identifica los eventos sintéticos del test como no confiables.

**Importante:** esos 2.010 eventos sintéticos no representan una sesión IME ni son consumidos por el adaptador; solo prueban la retención y los contadores del banco manual. La evidencia del pipeline IME del navegador sigue procediendo de la prueba específica con `Input.imeSetComposition`, y la evidencia de IME físicos sigue pendiente de la matriz de dispositivos.


## Correlador aislado y validación final de liberación de payload — 26 de noviembre de 2026

La lógica de emparejamiento del banco manual se extrajo en `tests/browser/live-author-monitor-ime-pairing.js`. Esta separación deja claro el límite entre el monitor real del adaptador y la instrumentación de diagnóstico del banco. El correlador conserva temporalmente el dato anterior solo en su estado privado; los registros contienen el resultado de comparación y el identificador de pareja, nunca el string literal.

### Regresiones unitarias del correlador

El archivo `tests/live-author-monitor-ime-pairing.test.mjs` cubre nueve escenarios:
1. pareja completa y datos idénticos;
2. datos contradictorios sin serializar sus valores;
3. solo un lado con dato disponible y ambos datos nulos;
4. discrepancia de `inputType` entre los dos eventos;
5. `input` sin `inputType` utilizable;
6. `beforeinput` cancelado y `input` huérfano;
7. nuevo `beforeinput` que sustituye uno pendiente;
8. interrupción por error y liberación del dato;
9. disposición de la página, liberación y rechazo de eventos tardíos.

La integración manual también cubre un orden delicado del navegador: el `onError` del adaptador puede ejecutarse dentro de la misma propagación antes de que el listener de diagnóstico vea el mismo `beforeinput`. El banco marca ese error como pendiente de aplicar al siguiente evento observado y lo interrumpe después de que el listener registre el evento, evitando que el payload rechazado quede retenido.

### CI final del correlador — commit `4c11338c640c38f8f801e4e14fd96412ae2b3445`

Ambos workflows finalizaron en `success` sobre el mismo commit:

- **[Live Author Monitor — run 45791748059](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45791748059):** type-check aislado, bundle, validación de esquema/almacenamiento, pruebas de recuperación, Page Lifecycle, integración Chromium y anfitrión/editor. Resultado: **209/209 pruebas, 0 fallos**. Las dos pruebas de navegador IME (candidatos CDP y exportación manual privada) aparecen aprobadas.
- **[Motor Literario TypeScript — run 45791748116](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45791748116):** type-check global, build y suite completa **1.206/1.206 pruebas, 0 fallos**. Incluye las nueve pruebas de correlación y el test Playwright del banco manual.

### Benchmark del núcleo en la validación final

El escenario `live-author-monitor-bounded-heap` procesó 100.000 commits en 8 documentos, con 1.048.576 unidades UTF-16 iniciales por documento y 12.500 cambios por documento. Resultado del workflow dedicado: 644,21 ms, 155.229,35 commits/s, 0,5 MB retenidos por sesiones abiertas, 0 MB de crecimiento de heap entre media carga y carga completa y 71,71 MB de RSS. El workflow global observó 385,58 ms, 259.352,01 commits/s, los mismos 0,5 MB retenidos y 0 MB de crecimiento de heap, con 72,94 MB de RSS.

Este benchmark mide el núcleo `LiveAuthorMonitor` (sesiones, commits y métricas), no el coste integral de comparar el manuscrito en el adaptador `TextArea`; los números son observaciones de CI, no garantías de rendimiento.

### Alcance que sigue pendiente

La validación de CI cubre automatización Chromium y el banco de metadatos. No hemos recibido todavía trazas de IME físicos en Windows, macOS o Linux. La matriz real de proveedores/idiomas/dispositivos sigue abierta; no se debe inferir su aprobación a partir de `Input.imeSetComposition` ni de eventos sintéticos usados para probar límites de retención.


## Preflight íntegro del snapshot y cierre seguro de la observación — 26 de noviembre de 2026

Se añadió una barrera anterior a cada `beforeinput` confiable: antes de capturar selección, longitud, `inputType` o payload, el valor completo actual del textarea debe ser idéntico a la copia sombra efímera del último cambio aceptado, y su longitud debe seguir coincidiendo con `documentLength`.

Esto cierra un hueco de atribución que las validaciones posteriores de prefijo/sufijo no podían cerrar por sí solas. Si una mutación programática de igual longitud ocurre dentro de la selección que el autor va a reemplazar, el contenido modificado podría desaparecer bajo la edición legítima y no dejar rastro en el prefijo ni en el sufijo. La comparación íntegra se hace antes de iniciar la edición, por lo que el adaptador suspende el stream con `resync-required` sin emitir un delta especulativo.

También se endureció el ciclo de vida de `subscribeChanges`:

- La primera suscripción valida que el textarea todavía coincida con el snapshot con el que se construyó el adaptador.
- Al retirar la última suscripción, se desconectan los listeners y se invalida la continuidad. Si había un `beforeinput` pendiente, se informa `missing-input`; en otro caso se informa `resync-required`.
- La copia sombra completa se libera al cerrar la observación. Una suscripción posterior permanece suspendida hasta recibir un snapshot autoritativo.
- Para recuperar un stream interrumpido, primero se registra de nuevo el observador y luego se llama a `resynchronize(snapshot)`. La API rechaza intentar esa recuperación con cero observadores activos, evitando que la lectura del snapshot y la reanudación queden separadas por otra ventana sin captura.

### Regresiones nuevas

`live-author-monitor-textarea-source.test.mjs` añade cobertura para:

1. mutación programática de igual longitud dentro del mismo rango que el autor pretende reemplazar;
2. modificación del textarea entre la construcción y la primera suscripción;
3. edición no observada durante la retirada de la última suscripción;
4. rechazo de resincronización cuando no existe observador activo;
5. recuperación válida tras volver a suscribir, obtener el snapshot vigente y reanudar.

Estas pruebas verifican tanto la ausencia de deltas falsos como la liberación del snapshot temporal y la continuidad de `revision`/`sequence` después de la recuperación.

**Estado:** los cambios de código y pruebas se han enviado a `main`. Esta documentación registra la nueva política; la ejecución de CI correspondiente a estos commits todavía debe confirmarse. Los resultados 209/209 y 1.206/1.206 de la sección anterior corresponden a la revisión anterior y no se atribuyen a esta iteración.


## Suspensión de captura ante Page Lifecycle y restauración BFCache — 26 de noviembre de 2026

Se conectó el adaptador de captura del textarea a las señales de ciclo de vida y foco:

- pagehide se escucha en element.ownerDocument.defaultView.
- freeze y visibilitychange se escuchan en element.ownerDocument.
- blur se escucha en el textarea.
- Los listeners se instalan al iniciar la primera suscripción y se retiran al terminar la última o al disponer el adaptador.

Ante pagehide o freeze, el adaptador suspende siempre la captura. Ante visibilitychange a oculto o blur, la suspende solo si existe un beforeinput pendiente o una composición activa; perder el foco o esconder una pestaña sin una operación abierta no rompe por sí solo la continuidad. Si el evento interrumpe un beforeinput/input pendiente, el diagnóstico es missing-input; si interrumpe solo una composición abierta, es resync-required. En todos los casos se cierran los estados incompletos y se libera la copia sombra previousText.

**No hay reanudación automática en pageshow ni resume.** La vista y su polling pueden volver a estar activos, pero la fuente del documento permanece suspendida hasta que el anfitrión obtenga un snapshot autoritativo que coincida con el contenido visible y llame a resynchronize(snapshot) con el observador activo. Esto evita tratar una restauración BFCache o un regreso al foco como prueba de que no hubo cambios fuera de la secuencia observada.

### Regresión añadida

live-author-monitor-textarea-source.test.mjs cubre:

1. composición activa al recibir pagehide y freeze;
2. ocultación de la pestaña durante una composición abierta;
3. blur durante una composición y durante un par beforeinput/input incompleto;
4. no interrumpir la continuidad cuando blur ocurre sin operación abierta;
5. liberación de previousText y descarte del estado pendiente;
6. eventos repetidos sin duplicar diagnósticos;
7. edición ignorada hasta recibir un snapshot que coincide con el textarea visible;
8. aceptación de una edición posterior con sequence y baseRevision consecutivos;
9. retirada de listeners blur, visibilitychange, pagehide y freeze al cerrar la suscripción.

Las pruebas unitarias de esta máquina usan EventTargets controlados. Además, live-author-monitor-browser.test.mjs ahora ejecuta una regresión en Chromium con automatización de teclado: observa un beforeinput confiable, un listener posterior cancela la acción por defecto, verifica que no aparece input y luego provoca blur real del textarea. El adaptador debe emitir missing-input, conservar cero deltas y suspenderse. Esta prueba acredita el pipeline DOM de Chromium bajo automatización, no un teclado físico ni un proveedor IME del sistema operativo. Tampoco simula un congelamiento físico del proceso ni una entrada real en BFCache; pagehide/freeze siguen cubiertos por pruebas de estado separadas.

**Estado de validación:** el código y la regresión se publicaron en main; la ejecución CI sobre estos commits no está confirmada todavía. No se extrapolan aquí los resultados de CI de revisiones anteriores.

## Cancelación posterior del beforeinput y liberación del par provisional — 26 de noviembre de 2026

El listener del adaptador puede ejecutarse antes que otro listener de la aplicación sobre el mismo textarea. Por eso, comprobar defaultPrevented solo al entrar en handleBeforeInput no es suficiente: un listener posterior todavía puede cancelar el evento y evitar la acción por defecto.

Después de crear el estado pendiente, el adaptador programa una microtarea que observa el resultado final de la propagación síncrona. Si defaultPrevented terminó siendo true y ese mismo estado continúa pendiente, libera el par provisional. No emite delta, no marca needsResync y no espera un input que la edición cancelada no debe producir.

La comparación se protege por identidad del estado pendiente: si input ya consumió el par, la fuente se suspendió o una operación posterior lo sustituyó, la microtarea tardía no modifica el estado nuevo.

### Regresiones

- Prueba unitaria: un listener posterior cancela beforeinput; tras la microtarea no quedan datos pendientes, no se emite error, blur no invalida el stream y la siguiente edición válida se admite.
- Prueba Chromium: Playwright produce beforeinput confiable mediante teclado; un listener posterior llama a preventDefault; se comprueba defaultPrevented=true, que no aparece input y que blur posterior no genera missing-input ni suspende una fuente que sigue sincronizada.

Esta distinción es importante: un beforeinput cancelado no representa una edición perdida. En cambio, si el evento no fue cancelado y se pierde el input esperado, se conservan los diagnósticos missing-input/resync-required que protegen contra deltas inventados.

La prueba Chromium ejecuta automatización del pipeline DOM del navegador. No equivale a un teclado físico, a la matriz IME de sistemas operativos ni a BFCache físico.

## Blur síncrono dentro de la propagación de beforeinput — 26 de noviembre de 2026

También se cerró el orden reentrante en que un listener posterior cancela beforeinput y desenfoca el textarea antes de que termine la propagación. Si handleBlur emitiera missing-input inmediatamente, se adelantaría a la microtarea que confirma defaultPrevented y produciría un falso positivo.

Para operaciones de texto ordinarias, handleBlur no declara por sí solo missing-input: el estándar HTML permite que el input de textarea se entregue como una tarea posterior. La fuente conserva el par y expone pendingInput=true en getState(), de modo que un input tardío todavía puede completar y publicar el delta. Si llega otro beforeinput sin completar el anterior, se confirma missing-input; pagehide, ocultación, freeze o retirada de la última suscripción invalidan la continuidad y liberan el estado. Cuando compositionActive sigue true, la fuente se suspende inmediatamente con resync-required porque una composición abierta no se conserva tras blur.

Las pruebas cubren:
- cancelación tardía y blur dentro del mismo listener posterior, sin error ni pérdida de continuidad;
- beforeinput no cancelado seguido de blur y luego input tardío, que se acepta con el delta correcto;
- beforeinput no cancelado seguido de blur y un segundo beforeinput sin input intermedio, que confirma missing-input;
- composición activa que pierde el foco, suspendida de inmediato;
- Chromium con teclado automatizado: el listener llama preventDefault() y element.blur() dentro de la misma propagación, verifica un blur y cero input, y confirma que la microtarea libera pendingInput sin diagnóstico.

