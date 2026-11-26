# Aplicación de referencia — Live Author Monitor

Esta página es una integración ejecutable del módulo, no una maqueta: utiliza el `HostEngineApi`, el almacén local `IndexedDbProjectStore`, el adaptador de escritura nativo y el panel de métricas.

## Ejecutar

Desde `base de datos/Motor-Literario/typescript`:

```bash
npm install
npx playwright install chromium
npx vite --host 127.0.0.1
```

Abrir `http://127.0.0.1:5173/examples/live-author-monitor/index.html`.

La primera carga crea un proyecto y un documento de demostración. Las siguientes cargas de la misma URL recuperan el snapshot, el journal y el checkpoint local. Los identificadores `project` y `document` pueden pasarse como parámetros de URL para aislar sesiones de prueba.

## Qué verifica

- Escritura real en un `textarea` del navegador y captura de deltas mediante `beforeinput`/`input`.
- Admisión y confirmación de cambios por `HostEngineApi`.
- Métricas visibles sin exponer el texto en el panel.
- Persistencia en IndexedDB y recuperación tras recargar.
- Cierre seguro de la sesión, persistencia final del checkpoint y liberación del lease.

El botón **Guardar sesión y cerrar monitoreo** vacía la cola, guarda el checkpoint, libera la coordinación entre pestañas y dispone la instancia. Después se puede recargar la misma URL para verificar la restauración.

## Límites deliberados

El ejemplo utiliza un `textarea` nativo para que pueda ejecutarse sin instalar un editor externo. El adaptador textarea monitoriza inserción, borrado y pegado; cuando una operación de historial nativa no puede producir un delta verificable, exige resincronización en vez de inventar una transacción. Para un editor enriquecido con historial propio, se debe conectar `mountLiveAuthorMonitorEditorTransactions()` o `LiveAuthorMonitorEditorTransactionBridge` a sus callbacks reales de transacción, undo y redo, siguiendo `docs/development/LIVE_AUTHOR_MONITOR_EDITOR_ADAPTER_GUIDE.md`.

La aplicación anfitriona final del proyecto no está presente en este repositorio. Esta página demuestra la integración real con el navegador y el almacenamiento local, pero no afirma que un editor de producción distinto ya esté conectado.

## Prueba automatizada

`tests/live-author-monitor-writing-browser.test.mjs` arranca Vite y Chromium, escribe texto en la página, verifica métricas y durabilidad, cierra de forma segura, recarga el documento y comprueba que tanto el manuscrito como las métricas se restauran.
