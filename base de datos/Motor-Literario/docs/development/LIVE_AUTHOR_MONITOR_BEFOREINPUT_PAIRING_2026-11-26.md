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

**Validación pendiente:** ejecutar el build aislado del monitor, suite específica y prueba de integración Chromium sobre este HEAD. La prueba unitaria nueva cubre el orden de eventos; no equivale a una prueba con IME real del sistema operativo.


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

**Límite conocido:** esta comprobación detecta cambios fuera del rango declarado, pero no puede demostrar la intención humana ni diferenciar una modificación programática que ocurra exactamente dentro del rango seleccionado. Para esa garantía, el anfitrión debe controlar las mutaciones del editor y proporcionar transacciones/origen de operación verificables.

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

Las pruebas unitarias cubren varias actualizaciones candidatas y el orden de los eventos de composición, pero no equivalen a una sesión física de IME con un teclado/servicio de entrada del sistema operativo. La prueba Chromium actual valida teclado nativo para `insertText`, persistencia IndexedDB y rechazo de eventos sintéticos; una matriz de IME reales por navegador, sistema operativo e idioma sigue siendo una validación de dispositivo pendiente.
