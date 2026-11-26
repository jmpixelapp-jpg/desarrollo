# Aplicación de referencia — Live Author Monitor

Esta página ejecutable conecta el `HostEngineApi`, `IndexedDbProjectStore`, los adaptadores de escritura y la integración multi-documento del panel.

## Ejecutar

Desde `base de datos/Motor-Literario/typescript`:

```bash
npm install
npx playwright install chromium
npx vite --host 127.0.0.1
```

Abrir `http://127.0.0.1:5173/examples/live-author-monitor/index.html`.

La aplicación mantiene abiertos dos capítulos de un mismo proyecto. Se puede escribir en cualquiera, cambiar entre ellos y observar las métricas por separado. Los identificadores `project` y `document` pueden pasarse como parámetros de URL para aislar sesiones de prueba; el segundo capítulo utiliza el ID base seguido de `-chapter-2`.

## Qué verifica

- Edición real mediante teclado en dos documentos abiertos simultáneamente.
- Cola de cambios durable independiente por documento.
- Cambio de capítulo después de vaciar los deltas del editor anterior.
- Tablero global con una tarjeta por sesión y panel detallado del capítulo activo.
- Persistencia IndexedDB y recuperación de ambos manuscritos y checkpoints tras recargar.
- Continuación de escritura después de recuperar una sesión.
- Cierre seguro que persiste todos los checkpoints y libera los leases.

El botón **Guardar todas las sesiones y cerrar monitoreo** vacía la cola activa y llama a `HostEngineApi.disposeSafely()`, que guarda los checkpoints de las sesiones bajo lease y libera la coordinación entre pestañas.

## Límites deliberados

El ejemplo usa textarea nativo para que pueda ejecutarse sin dependencias de editores externos. Para un editor enriquecido con historial propio, se debe conectar `mountLiveAuthorMonitorEditorTransactions()` o `LiveAuthorMonitorEditorTransactionBridge` a sus callbacks reales de transacción, undo y redo.

La aplicación anfitriona final del proyecto y el editor enriquecido de producción no están presentes en este repositorio. Esta página demuestra una integración real de referencia de dos documentos en el navegador; no afirma que ese editor externo esté conectado.

## Prueba automatizada

`tests/live-author-monitor-writing-browser.test.mjs` inicia Vite y Chromium, edita dos capítulos, verifica métricas independientes, cambia entre documentos, cierra de forma durable, recarga, restaura ambas sesiones y vuelve a escribir en una de ellas.


## Validación CI de la entrega multi-documento

La CI específica [45736377764](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45736377764) aprobó **141/141 pruebas** y la suite general [45736377738](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45736377738) aprobó **718/718 pruebas**, con benchmark completado. Se incluyen las pruebas Chromium de dos capítulos, restauración independiente, continuidad tras recuperar y checkpoints inmediatos válidos.

 
## Diagnóstico, clasificación y retención

El panel individual y el tablero por capítulos muestran el estado de checkpoint y coordinación de pestañas. También ofrecen contadores separados de escritura, pegado, borrado, corrección, deshacer, rehacer y otras operaciones. Para las categorías que dependen del historial real (`undo`/`redo`), el editor anfitrión debe proporcionar transacciones reales.

La política de retención configurable se explica en `docs/development/LIVE_AUTHOR_MONITOR_OPERATIONS.md`. Por defecto se conservan 90 días de checkpoints; el anfitrión puede cambiarlo mediante `liveAuthorMonitorCheckpointRetentionMs` o desactivar la limpieza con `0`. Los registros de fencing no se eliminan.

La última CI integral aprobada corresponde al baseline anterior, no a las mejoras recientes. Los workflows más nuevos se detuvieron antes de ejecutar tests por `TS1002` en `src/narrative-history.ts:7`; consulta el registro de fase 3 y la guía operativa para ver los runs exactos.
