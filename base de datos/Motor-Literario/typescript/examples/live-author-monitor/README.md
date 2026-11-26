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
