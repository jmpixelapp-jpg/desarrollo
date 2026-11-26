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

- `insertText`, `insertLineBreak`, `insertParagraph` e `insertCompositionText` → `typing` (entrada de texto declarada por el navegador);
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
