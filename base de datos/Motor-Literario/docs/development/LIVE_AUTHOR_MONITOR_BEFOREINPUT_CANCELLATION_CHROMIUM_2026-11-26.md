# Regresión Chromium: cancelación tardía de beforeinput — 2026-11-26

## Objetivo

Demostrar en un navegador real que la fuente nativa del Live Author Monitor no confunde un `beforeinput` cancelado por un listener posterior del editor anfitrión con una edición aplicada.

La regresión cubre un caso de orden de listeners: el monitor recibe primero `beforeinput`, captura de forma provisional la selección y programa la comprobación de `defaultPrevented`; después, otro listener síncrono del mismo `textarea` cancela el evento.

## Prueba añadida

Archivo:

- `typescript/tests/live-author-monitor-beforeinput-cancellation-browser.test.mjs`

La prueba inicia Vite y Chromium headless, importa la implementación TypeScript real y utiliza `page.keyboard.type()` para producir eventos de teclado del navegador.

Secuencia comprobada:

1. Se crea un `textarea` con snapshot inicial `abc`, revisión 0 y secuencia 0.
2. Se monta `LiveAuthorMonitorTextAreaSource` y se suscribe la captura de deltas.
3. Se registra después un listener anfitrión que cancela la primera inserción `insertText`.
4. Se escribe `x` con el teclado de Playwright. El `beforeinput` observado debe ser confiable y quedar cancelado.
5. Se comprueba que el valor permanece `abc`, no se emite ningún delta, no aparece error, no queda `pendingInput` y no se solicita resincronización.
6. Se escribe `y` con una segunda pulsación confiable.
7. Se comprueba que se emite exactamente un delta: secuencia 1, revisión base 0, rango UTF-16 [3, 3], reemplazo de longitud 1 y categoría `typing`. El valor final es `abcy`.

## Invariantes protegidos

- Un evento cancelado no equivale a un cambio aplicado.
- No se publican deltas basados únicamente en la intención anunciada por `beforeinput`.
- La cancelación tardía dentro de la misma propagación síncrona se resuelve antes de aceptar otra operación.
- Una cancelación voluntaria no debe generar un error ni bloquear la captura.
- La siguiente edición aplicada debe conservar secuencia y revisión consecutivas.
- La prueba no guarda ni imprime contenido del manuscrito en logs; las aserciones sobre el valor permanecen dentro de Chromium y solo los resultados técnicos se devuelven al runner.

## Alcance y límites

Esta prueba valida el orden real de eventos DOM y teclado confiable en Chromium headless. No simula un IME del sistema operativo, selección de candidatos, idioma de entrada ni cancelación mediante el software de composición. La matriz de IME físicos por SO, navegador, versión e idioma continúa pendiente y debe informarse por separado.

La prueba no sustituye el proveedor de transacciones autoritativas del editor enriquecido. Ese proveedor sigue siendo la fuente preferida para operaciones que el DOM no expone con suficiente precisión.

## CI

El archivo sigue el patrón `tests/live-author-monitor-*.test.mjs`, por lo que queda incluido en el paso de integración host/editor/navegador del workflow `Live Author Monitor`. La ejecución disparada por este commit debe consultarse antes de marcar la regresión como aprobada.

## Validación independiente de la regresión

Se añadió `.github/workflows/live-author-monitor-beforeinput-cancellation.yml` para ejecutar esta prueba en un job aislado de Chromium. Instala Node 22, dependencias del paquete y Chromium, y corre exclusivamente:

```sh
node --test tests/live-author-monitor-beforeinput-cancellation-browser.test.mjs
```

Esta separación evita que un fallo de compilación global en módulos narrativos ajenos impida ejecutar la regresión DOM específica. No sustituye el workflow integral del monitor: ambos resultados deben informarse por separado. El nuevo workflow debe terminar correctamente antes de marcar aprobada la prueba.

## Integración en el workflow habitual del monitor

Además del workflow focalizado, `.github/workflows/live-author-monitor.yml` ejecuta ahora este mismo test inmediatamente después de instalar Chromium y de la prueba Page Lifecycle, con una condición basada únicamente en que Chromium se haya instalado correctamente y el job no esté cancelado. Por tanto, se ejecuta aunque el build runtime general haya fallado en un módulo independiente.

La prueba sigue aislada en su propio proceso Node/Vite y no depende de que el bundle general se haya generado. La suite host/editor/browser completa permanece condicionada al build runtime porque sus pruebas sí necesitan el bundle general.

En consecuencia, hay dos observaciones distintas:
- validación focalizada del único test de cancelación;
- validación integrada del workflow habitual del monitor.

Ninguna de ellas demuestra IME físico de todas las plataformas ni sustituye la conexión al editor enriquecido de producción.
## Hallazgo reproducido en Chromium y corrección

**Primera ejecución:** el test falló porque `pendingInput` seguía activo después de que el listener anfitrión cancelara el evento.

**Traza de Chromium:** el evento fue `beforeinput`, `inputType=insertText`, `isTrusted=true`, `cancelable=true` y `defaultPrevented=true`. Una microtarea programada desde un listener posterior también observó `defaultPrevented=true`, pero el monitor todavía conservaba `pendingInput`. La evidencia muestra que la microtarea del listener inicial del monitor se ejecutó antes de que terminara la propagación y de que el anfitrión cancelara el evento.

**Corrección de producción:** `LiveAuthorMonitorTextAreaSource` mantiene una comprobación rápida mediante `queueMicrotask`. Si el candidato sigue pendiente y el evento es cancelable, programa una comprobación adicional con `setTimeout(..., 0)`. La tarea posterior limpia únicamente si sigue siendo el mismo candidato y `defaultPrevented` quedó activado. Si el evento se aplica normalmente, el `input` asociado cierra el candidato antes y el fallback no altera la edición.

**Propiedades conservadas:** la cancelación no incrementa secuencia/revisión, no publica un delta vacío ni exige resincronización. La siguiente edición aplicada sigue siendo admisible.

El test mantiene la traza de evento, microtarea y tarea para que una futura regresión identifique el orden real del navegador. La validación CI de esta corrección está pendiente; no se marca todavía como aprobada.
## Resultado validado en CI — 26 de noviembre de 2026

- [Workflow focalizado, run 45808557947](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45808557947): `success`, test Chromium 1/1.
- [Workflow habitual del monitor, run 45808558036](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45808558036): el paso de cancelación tardía concluyó `success`, 1/1.

Ambos runs usaron el commit `b52e8d2130197b7656da01ce6033652a15556ca9`, con espera explícita de `pendingInput === false` y de la señal de la tarea posterior del navegador. El run habitual también aprobó la suite unitaria/diagnóstica 191/191, Page Lifecycle Chromium 1/1, type-check aislado, bundle aislado, esquema y benchmark.

El workflow habitual conserva resultado global `failure` por el build runtime general, que se detiene en `src/narrative-observation-discovery.ts:373:67` con `Unterminated string literal`. La integración host/editor/browser completa queda omitida por depender de ese bundle. Este fallo pertenece a un módulo narrativo ajeno; el paso Chromium específico de esta regresión sí se ejecutó y pasó.

Alcance pendiente: las pruebas cubren teclado confiable y propagación DOM en Chromium headless, no IME físico en cada sistema operativo/idioma. Tampoco demuestran que un editor enriquecido de producción esté conectado; esa integración debe suministrar transacciones nativas aplicadas y su historial real.