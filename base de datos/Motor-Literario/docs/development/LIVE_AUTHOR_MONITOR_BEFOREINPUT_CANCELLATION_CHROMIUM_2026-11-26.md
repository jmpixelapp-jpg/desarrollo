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

