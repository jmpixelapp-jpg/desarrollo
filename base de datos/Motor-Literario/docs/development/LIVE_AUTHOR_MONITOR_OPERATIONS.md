# Guía operativa — Live Author Monitor

**Ruta del módulo:** `base de datos/Motor-Literario/typescript`  
**Runtime:** TypeScript/JavaScript puro; sin React obligatorio, telemetría remota ni dependencias en ejecución para el núcleo.  
**Estado de la entrega:** robustez de módulo implementada en parte; validación CI de los últimos commits bloqueada por un error de sintaxis externo al módulo.

## 1. Alcance y fuente de verdad

El monitor observa las admisiones y commits que ya procesa `HostEngineApi`. No aplica cambios al documento, no conserva el texto del manuscrito y no sustituye al motor de edición.

Los archivos principales son:

- `src/live-author-monitor.ts`: ciclo de sesión, métricas, snapshots y checkpoints.
- `src/host-api.ts`: coordinación, diagnóstico de errores, lease, recuperación tras suspensión y retención.
- `src/persistence/indexeddb-store.ts`: persistencia de checkpoints y leases, validación y limpieza.
- `src/live-author-monitor-panel.ts`: panel DOM de capítulo.
- `src/live-author-monitor-workspace.ts`: tablero multi-documento.
- `src/live-author-monitor-textarea-source.ts`: adaptador de referencia para textarea.
- `src/live-author-monitor-editor-transaction-source.ts`: adaptador genérico de transacciones e historial.

El contrato técnico está en `docs/specifications/LIVE_AUTHOR_MONITOR_V0.1.md`; las reglas para conectar un editor están en `LIVE_AUTHOR_MONITOR_EDITOR_ADAPTER_GUIDE.md`; el historial de entregas está en `LIVE_AUTHOR_MONITOR_PROGRESS.md`.

## 2. Diagnóstico que ve el autor

La consulta pública es:

```ts
const diagnostics = api.getLiveAuthorMonitorPersistenceDiagnostics(documentId);
```

No incluye el contenido del manuscrito. Expone identidad de documento, estados, timestamp del último checkpoint confirmado, fencing token y vencimiento del lease, más el nombre de clase de los errores.

### Estado del checkpoint

| Estado | Significado |
|---|---|
| `unavailable` | El almacén no implementa checkpoints. |
| `not-saved` | No existe aún un guardado confirmado para la sesión. |
| `waiting-for-durability` | Hay cambios pendientes o el documento necesita resincronización. |
| `saving` | Existe un guardado en curso. |
| `saved` | Se confirmó al menos un checkpoint. |
| `error` | Falló la persistencia; se expone solo el código de error. |

Cuando el código sea `QuotaExceededError`, el panel identifica la cuota agotada. Para los demás errores presenta el nombre de clase, nunca el mensaje original.

### Estado del lease

| Estado | Significado |
|---|---|
| `unsupported` | El almacén no implementa coordinación entre pestañas. |
| `uninitialized` | Aún no se ha intentado adquirir/observar el lease. |
| `owner` | Esta instancia conserva el lease vigente. |
| `observer` | Esta instancia no es propietaria y mantiene el heartbeat de observación. |
| `lost` | Se perdió la titularidad o el fencing token cambió. |
| `expired` | El lease local ha vencido. |
| `releasing` | La liberación está en curso. |
| `error` | No se pudo consultar, renovar o liberar el lease. |

El panel y cada tarjeta del workspace renderizan estos estados con regiones accesibles `role="status"` y `aria-live="polite"`.

## 3. Clasificación de operaciones

Cada `EditorChange` puede incluir `activityKind`:

| Categoría | Fuente preferida | Observación |
|---|---|---|
| `typing` | evento de inserción normal | Puede inferirse por delta. |
| `paste` | `InputEvent.inputType` o callback de pegado | El textarea reconoce variantes `insertFromPaste`. |
| `deletion` | `InputEvent.inputType` o delta | También se infiere cuando se elimina sin insertar. |
| `correction` | transacción/reemplazo del editor | Se infiere cuando se reemplaza un rango. |
| `undo` | transacción real del historial | No inferir solo por Ctrl/Cmd+Z. |
| `redo` | transacción real del historial | No inferir solo por Ctrl/Cmd+Y/Shift+Z. |
| `other` | tipo no identificado | Incluye histórico de checkpoints sin clasificación. |

Se conservan siete contadores: seis categorías específicas y `otherChanges`. Su suma debe coincidir con `acceptedChanges`. Los checkpoints v1 antiguos sin estos campos se recuperan como operaciones históricas `other`; los checkpoints intermedios con seis contadores calculan el residual por diferencia.

El monitor no guarda el contenido de las transacciones. Solo recibe las posiciones, longitudes, secuencia, revisión y categoría necesarias para contabilizar.

## 4. Configuración y retención de datos

Al crear `HostEngineApi`:

```ts
const api = new HostEngineApi({
  store,
  liveAuthorMonitorCheckpointRetentionMs: 90 * 24 * 60 * 60 * 1_000
});
```

- Predeterminado: 90 días.
- `0`: desactiva tanto limpieza automática como limpieza manual.
- Rango permitido: 0 a 3650 días.
- `initializeProject()` programa la limpieza de forma no bloqueante y reporta los fallos al canal de errores del anfitrión.
- El anfitrión también puede ejecutar `await api.cleanupLiveAuthorMonitorCheckpoints()`; el resultado es el número de checkpoints eliminados.

La limpieza limita el recorrido al `projectId` actual y verifica el checkpoint y el lease en una transacción IndexedDB común. No elimina checkpoints recientes. Un lease activo protege el checkpoint. Si el registro de lease es malformado, se conserva también el checkpoint por precaución.

Los registros de lease vencidos se mantienen como tombstones. Eliminarlos reiniciaría la secuencia del fencing token y podría permitir que una instancia antigua se presentara con una generación obsoleta. Esta retención intencional afecta únicamente a metadatos pequeños del lease, no al contenido del manuscrito.

## 5. Recuperación y garantías de coordinación

- **Cierre seguro:** el anfitrión debe vaciar la cola y usar `closeLiveAuthorMonitorDocumentSafely()` o `disposeSafely()` para persistir antes de liberar.
- **Cierre abrupto:** la página puede desaparecer sin ejecutar `release()`; el lease expirará y una pestaña observadora podrá intentar el takeover.
- **Pérdida de lease:** una renovación que no devuelve el mismo fencing token elimina la titularidad local y marca el estado como perdido.
- **Suspensión:** al regresar a visible (`visibilitychange`) o recibir `pageshow`, la instancia revalida leases inmediatamente; un lease expirado intenta adquirirse otra vez.
- **Carreras:** el fencing token impide que un propietario antiguo confirme checkpoints después de que otro obtenga una generación nueva.
- **Dispose:** se retiran listeners de lifecycle y heartbeats; las respuestas asíncronas tardías no deben restaurar la titularidad.

## 6. Matriz de pruebas y grado de evidencia

| Escenario | Cobertura actual | Qué demuestra / qué no demuestra |
|---|---|---|
| Cuota de almacenamiento | Error `QuotaExceededError` simulado en el almacén | Demuestra diagnóstico y aislamiento del mensaje. No llena físicamente el perfil del navegador. |
| IndexedDB bloqueado | Prueba con `fake-indexeddb` | Verifica error de apertura y reintento tras retirar la conexión bloqueante. |
| Pestaña propietaria cerrada | Chromium cierra la página sin `release()` y el harness expira el lease | Comprueba takeover con fencing nuevo; el tiempo se acelera en la prueba. |
| Lease perdido | Sustitución del fencing token en pruebas del HostEngineApi | Verifica detección de pérdida y eliminación de la titularidad local. |
| Pestaña suspendida | Prueba determinista de `visibilitychange` | Verifica el camino de reanudación; no simula horas de suspensión real del sistema operativo. |
| Sesión prolongada | 8 documentos × 5.000 cambios, 40.000 commits y más de 8 horas simuladas | Comprueba contadores, ventanas de muestras acotadas y ausencia del texto en snapshots. No mide RAM real ni dura ocho horas físicas. |
| Retención | Pruebas de límites, aislamiento por proyecto, lease activo/expirado/malformado y fencing | Verifica que no se eliminen checkpoints protegidos ni se reinicie el fencing. |
| Privacidad | Snapshots/diagnósticos sin texto y sin mensajes arbitrarios de error | Comprueba la superficie serializada del monitor; no sustituye una auditoría global de toda la aplicación. |

### Mediciones que aún faltan

1. Ejecutar un soak físico en navegador durante varias horas y medir heap/RAM antes, durante y después, con varios manuscritos grandes.
2. Probar agotamiento real de cuota en un perfil Chromium aislado y recuperarlo después de liberar almacenamiento.
3. Simular suspensión/reanudación del navegador o sistema operativo real, no solo los eventos de lifecycle.
4. Verificar los resultados de todos los nuevos tests después de que la compilación global vuelva a pasar.

## 7. Integración de producción pendiente

El repositorio contiene una aplicación de referencia ejecutable con textarea y un contrato genérico para editores transaccionales. No contiene el editor enriquecido final de la aplicación.

Para cerrar la integración se necesita que el host de producción entregue:

- eventos de transacción con documento, secuencia, revisión y delta;
- identificación nativa de undo/redo y agrupación de transacciones;
- ciclo de vida al cambiar, cerrar y restaurar capítulos.

No se debe afirmar que el editor de producción está conectado hasta validar esos callbacks reales. La integración de textarea es una referencia de navegador, no un reemplazo del editor real.

## 8. Comandos de validación

Desde `base de datos/Motor-Literario/typescript`:

```bash
npm install
npm run validate:schema
npm run typecheck
# Build aislado del monitor (no importa los tipos globales de src/index.ts)
npx vite build --config vite.monitor.config.ts
node --test tests/live-author-monitor-diagnostics-isolation.test.mjs

# Validación general del motor y suites completas
npx vite build
node --test tests/live-author-monitor*.test.mjs tests/storage-implementation-audit.test.mjs
```

Para probar el harness de escritura multi-documento:

```bash
npx playwright install chromium
node --test tests/live-author-monitor-writing-browser.test.mjs tests/live-author-monitor-browser.test.mjs
```

Suite completa y benchmark:

```bash
npm test
npm run bench
npm run bench:monitor
```

El workflow específico del monitor valida esquema físico, build, Chromium y tests `live-author-monitor*.test.mjs`. El workflow general ejecuta typecheck, build, suite completa y benchmark.

## 9. Estado de CI conocido al 25 de noviembre de 2026

La última validación integral verde anterior a la fase 3 corresponde al baseline histórico:

- [Live Author Monitor — run 45736377764](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45736377764): 141 pruebas aprobadas, 0 fallidas, 0 omitidas.
- [Motor Literario TypeScript — run 45736377738](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45736377738): 718 pruebas aprobadas, 0 fallidas, 0 omitidas.

Las nuevas entregas siguen sin validación verde. Los resultados más recientes completados consultados son:

- [Motor Literario TypeScript — run 45743597639](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45743597639), commit `8112df6f`: terminó en `Type-check`.
- [Live Author Monitor — run 45743497335](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45743497335), commit `ab624b7a`: terminó en `Build runtime bundle`; los pasos previos de setup, Chromium y auditoría de esquema físico finalizaron correctamente.

Los dos fallos presentan `src/narrative-history.ts(7,41): TS1002 — Unterminated string literal` (en Vite, `src/narrative-history.ts:7:40`). El error se origina en un archivo de otro módulo y no se modifica desde este trabajo. No demuestra ni aprobación ni fallo de las pruebas del monitor ni del benchmark de heap: ambos quedan sin ejecutar tras el bloqueo de compilación.

El workflow específico incluye ahora `tests/browser/**`, `bench/**` y `package.json` en sus filtros de `push` y `pull_request`. Así los tests del harness, el benchmark y los comandos de validación disparan la suite dedicada cuando cambian.

## 10. Regla de cierre de entregas

Cada nueva entrega debe quedar registrada en `LIVE_AUTHOR_MONITOR_PROGRESS.md`, con:

1. archivos del monitor modificados y objetivo;
2. regresiones y pruebas añadidas;
3. commit exacto sobre `main`;
4. runs de CI que realmente se ejecutaron y su resultado;
5. límites de lo simulado frente a medición física;
6. integraciones externas que sigan pendientes.

No marcar una tarea como validada cuando el workflow se haya detenido antes de ejecutarla.

### Presentación comprobada de categorías

Las pruebas `live-author-monitor-panel.test.mjs` y `live-author-monitor-workspace.test.mjs` montan el DOM con las siete categorías (seis operaciones y `other`) y verifican que cada valor se muestre como `1` en el capítulo correcto. También verifican que el texto privado no aparezca en la interfaz.

## 11. Configuración de las métricas visibles del panel

El panel individual y el workspace aceptan `visibleMetrics`. Si no se proporciona, muestran todas las métricas. Una selección personalizada puede reducir la densidad visual:

```ts
mountLiveAuthorMonitorPanel(container, api, {
  documentId,
  visibleMetrics: ["session", "active", "typing", "paste", "undo", "redo", "pending"]
});

mountLiveAuthorMonitorWorkspace(workspaceContainer, api, {
  visibleMetrics: ["typing", "paste", "deletion", "undo", "redo", "pending"]
});
```

Cada tipo exporta su unión de claves permitidas. En runtime, claves desconocidas o duplicadas se rechazan antes de insertar elementos DOM. La selección no cambia las métricas calculadas o persistidas; solo reduce lo que esa vista renderiza. Las métricas se conservan con semántica de lista para tecnologías de asistencia.

## 12. Benchmark reproducible de heap del monitor

El repositorio dispone de `bench/live-author-monitor-memory-benchmark.mjs`, ejecutable después del build:

```bash
npm run bench:monitor
```

El escenario predeterminado crea ocho sesiones con documentos de 1.048.576 unidades UTF-16 y confirma 12.500 cambios por documento (100.000 commits). Ejecuta GC explícito antes de tomar muestras y reporta heap/RSS del proceso Node antes y después de la carga, además del crecimiento entre la mitad y el total de cambios. También verifica que cada documento termina con todos los commits, sin pendientes y con una ventana de latencia limitada.

Las dimensiones pueden variarse con `MONITOR_BENCH_DOCUMENTS`, `MONITOR_BENCH_CHANGES_PER_DOCUMENT`, `MONITOR_BENCH_DOCUMENT_CODE_UNITS` y `MONITOR_BENCH_SAMPLE_WINDOW`. Los rangos admitidos están validados por el script.

Este benchmark mide el heap del proceso Node del runner, no memoria de Chromium ni consumo de la aplicación de producción. Reporta la medición sin umbral universal fijo para evitar fallos por diferencias de V8/runner. El job del monitor lo ejecuta después de la suite automatizada, y el benchmark general lo incluye como parte de `npm run bench`.

El benchmark `bench:monitor` requiere que `npm run build` haya generado `dist/`; emite un único JSON con longitudes UTF-16, total de commits, heap/RSS, throughput y la ventana acotada. El campo de tamaño es `initialCodeUnitsPerDocument`, no una afirmación de bytes físicos por documento.


## 13. Aislamiento de fallos al consultar diagnósticos

La lectura de `getLiveAuthorMonitorPersistenceDiagnostics(documentId)` es observabilidad auxiliar y no debe convertirse en una dependencia del flujo de eventos del monitor. Los adaptadores del anfitrión pueden fallar temporalmente al consultar IndexedDB, el estado del checkpoint o la coordinación entre pestañas.

El panel y cada tarjeta del workspace usan `readLiveAuthorMonitorPersistenceDiagnosticsSafely()`:

- captura excepciones del proveedor de diagnósticos sin propagar mensajes internos;
- descarta una respuesta cuyo `documentId` no coincide con la tarjeta solicitada;
- muestra checkpoint y coordinación como **no disponibles** con nivel visual de advertencia;
- continúa actualizando estado de actividad, cambios pendientes, revisiones y métricas de cada documento;
- permite recuperar la visualización normal cuando vuelve a funcionar el proveedor, sin desmontar el panel.

La regresión `tests/live-author-monitor-diagnostics-isolation.test.mjs` cubre excepciones, recuperación, aislamiento entre documentos y rechazo de diagnósticos cruzados. No valida por sí sola la persistencia durable del checkpoint ni sustituye las pruebas de IndexedDB y leases.


## 14. Validación de runtime aislada del monitor

El workflow dedicado construye un bundle focalizado antes de instalar Chromium o compilar el entrypoint general:

1. `vite.monitor.config.ts` construye `src/live-author-monitor-test-entry.ts` en `dist-monitor/`, sin limpiar ni sobrescribir `dist/`.
2. `tests/live-author-monitor-diagnostics-isolation.test.mjs` ejecuta las regresiones de telemetría del panel/workspace sobre ese bundle. Las pruebas completas de `LiveAuthorMonitor`, incluidos checkpoints y estrés determinista multi-documento, continúan en el workflow general después del build principal.
3. Después se instalan las herramientas de navegador, se valida el esquema y se intenta la compilación general del motor.

**Límite de tipos:** no se afirma que este bundle realice un typecheck estricto. Aunque el monitor importa los contratos solo como tipos, `contracts.ts` forma parte de un grafo de imports de tipos del motor; el intento de compilarlo como proyecto TypeScript aislado volvió a alcanzar `src/narrative-history.ts(7,41): TS1002`. La comprobación Vite/esbuild elimina esos imports de tipo al generar JavaScript y permite ejecutar las regresiones de runtime. El typecheck estricto de todo el proyecto sigue a cargo del workflow general.

Esta separación permite verificar la ejecución del panel y workspace aun cuando un módulo independiente del bundle general esté roto. No certifica integración completa con `HostEngineApi`, persistencia real IndexedDB, leases multi-pestaña ni editor de producción.

## 15. Validación de listas de métricas visibles

Los resolvers del panel y workspace recorren `visibleMetrics` por índice y verifican que cada posición sea una propiedad propia del arreglo. Las posiciones dispersas (`new Array(n)`) se rechazan con un `TypeError` explícito en lugar de ser omitidas silenciosamente por `Array.map()`. Los valores explícitos `undefined`, claves desconocidas y claves duplicadas también se rechazan.

La validación se completa antes de insertar el panel o workspace en el contenedor DOM. Las regresiones se ejecutan en `tests/live-author-monitor-diagnostics-isolation.test.mjs` sobre el bundle aislado y comprueban que el contenedor permanece intacto ante ambas configuraciones inválidas.

## 16. Copia y validación de diagnósticos del anfitrión

`readLiveAuthorMonitorPersistenceDiagnosticsSafely()` no devuelve el objeto recibido del adaptador. Lee cada campo dentro del bloque protegido, valida los estados conocidos de checkpoint/lease y los metadatos opcionales, construye un objeto nuevo y lo congela con `Object.freeze()`.

Se rechazan estados desconocidos, timestamps negativos/no finitos, fencing tokens que no sean enteros seguros no negativos y códigos de error vacíos o mayores de 64 caracteres. Una excepción de getter/proxy devuelve `undefined`; el panel y el workspace presentan diagnóstico no disponible y mantienen las métricas de actividad.

La regresión aislada valida copia inmutable frente a mutación del origen, getter que lanza excepción, estado futuro y metadatos fuera de rango. Los valores se renderizan con `textContent`; no se interpretan como HTML.

## 17. Ejecución de las regresiones de diagnóstico en ambos flujos

`tests/live-author-monitor-diagnostics-isolation.test.mjs` intenta importar primero `dist-monitor/live-author-monitor.js`, creado por la lane focalizada. Si ese bundle no está presente (por ejemplo, durante `npm test`, que solo construye `dist/`), la suite cae al bundle general `dist/motor-literario.js`.

Así se conserva una única fuente de regresiones sin exigir a `npm test` que altere sus artefactos o scripts. En CI focalizada, el primer import debe funcionar; en CI general se usa la salida principal.

## 18. Última validación verde y línea base de heap

Las ejecuciones [Live Author Monitor — run 45746701123](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45746701123) y [Motor Literario TypeScript — run 45746700879](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45746700879) terminaron en éxito sobre `71d6144`. La suite específica pasó 167/167; la suite general pasó 761/761. Ambos workflows completaron sus pasos de compilación/typecheck y benchmarks.

El benchmark específico informó, en Node.js v22.23.5: 8 documentos de 1.048.576 unidades UTF-16, 100.000 commits, 167.437,39 commits/s, 0,48 MB retenidos por sesiones abiertas, 0 MB de crecimiento de heap entre mitad y carga completa y 75,33 MB de RSS final. Todos los documentos quedaron con 12.500 commits y 0 pendientes.

Estos valores describen el runner Node y deben usarse como línea base comparativa del mismo entorno. No equivalen al heap ni al RSS del navegador Chromium/host de producción.

## 19. Polling adaptado a la visibilidad de la pestaña

El panel individual y el workspace global utilizan `scheduleLiveAuthorMonitorWhileVisible()` para su refresco visual periódico. Al pasar el documento a `hidden`, cancelan los intervalos de la vista; al recibir `visibilitychange` y volver a visible, ejecutan una reconciliación inmediata y vuelven a programar el intervalo configurado.

Este scheduler afecta exclusivamente a la actualización visual de métricas y diagnósticos. No pausa el motor de escritura, los checkpoints, los heartbeats ni la renovación de leases. Esos procesos permanecen bajo control de `HostEngineApi` y sus coordinadores.

Si el entorno no ofrece Page Visibility API, mantiene el polling convencional. Las opciones `schedule` permiten inyectar relojes deterministas y también se someten al ciclo visible/oculto. La regresión verifica montaje con la pestaña oculta, pausa, refresco inmediato al volver, reprogramación y cancelación al desmontar.

La envoltura del callback también comprueba visibilidad y estado de desmontaje al ejecutarse. Así, un tick que ya estaba encolado en el event loop y llega después de `clearInterval()` no actualiza una vista oculta ni una instancia ya desmontada. La prueba invoca deliberadamente ambos callbacks antiguos para verificar que se descartan.

## 20. CI del scheduler de visibilidad

El commit `0a21f341ae1787a4ae82255295e4fdc79e3182cd` pasó el workflow [Live Author Monitor — run 45747598005](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45747598005): 10/10 regresiones aisladas y 169/169 pruebas del monitor. Chromium, esquema, build runtime y benchmark también se completaron correctamente.

El benchmark de esta ejecución informó 274.897,17 commits/s para 100.000 cambios en 8 documentos; heap retenido de 0,48 MB, crecimiento de 0 MB entre mitad y final y RSS final de 73,89 MB. Valores medidos en el proceso Node del runner, no en Chromium.

El workflow general [Motor Literario TypeScript — run 45747598008](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45747598008) permanecía en curso durante la instalación de Chromium al momento del registro. Consultar su estado antes de afirmar typecheck, suite general o benchmark general aprobados.

## 21. Validación general del scheduler y guard de ticks retrasados

Para el commit `0a21f341ae1787a4ae82255295e4fdc79e3182cd`, la lane específica [45747598005](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45747598005) terminó en éxito con 169/169 pruebas del monitor y 10/10 regresiones aisladas.

El workflow general [45747608045](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45747608045) también terminó en éxito en el commit descendiente `c90fa1ad3b3174b205564cd71a60f91ace30c4b7`, que contiene íntegro `0a21f34`: typecheck correcto, 775/775 tests aprobados, build y benchmarks completados.

Benchmark de monitor en ese runner general: 100.000 commits, 200.274 commits/s, 0,48 MB retenidos por sesiones, 0 MB de crecimiento de heap entre mitad y final, RSS 75,32 MB y cero pendientes en los ocho documentos.

## 22. Recuperación mediante Page Lifecycle y BFCache

Además de `visibilitychange`, el scheduler escucha `pagehide`/`pageshow` en `document.defaultView` y `freeze`/`resume` en el documento. Al recibir `pagehide` o `freeze`, detiene el intervalo y marca la vista inactiva. `pageshow` o `resume` ejecuta un refresco inmediato y rearma el intervalo solo si `document.hidden` ya es `false`.

El estado activo evita dobles reanudaciones cuando el navegador emite varios eventos para una transición. Un evento `pageshow`/`resume` no puede reactivar el polling mientras el documento siga oculto. Los callbacks de intervalos anteriores se mantienen protegidos por la comprobación `active`.

Las pruebas deterministas simulan pagehide/pageshow, freeze/resume, ticks encolados, eventos duplicados y la condición hidden durante una señal de reanudación. No se modifica la actividad del motor ni la persistencia.

## 23. Prueba de ciclo de vida con Chromium real

`tests/live-author-monitor-lifecycle-browser.test.mjs` abre un Chromium real contra `tests/browser/live-author-monitor-lifecycle.html`. El harness importa el scheduler transformado por Vite desde TypeScript y lo conecta a los `EventTarget` nativos de `document` y `window`.

La prueba despacha `PageTransitionEvent` (`pagehide/pageshow`) y `Event` (`freeze/resume`, `visibilitychange`). Usa un scheduler de intervalos inyectado para observar programaciones y cancelaciones sin depender de cronómetros reales. Comprueba callbacks antiguos, eventos duplicados, señal de reanudación mientras `document.hidden` es verdadero, refresco inmediato al volver y que después del desmontaje no se producen reactivaciones.

Esta prueba verifica integración con DOM/EventTarget de Chromium, pero los eventos se despachan desde el harness: no afirma que el runner haya congelado físicamente el proceso ni que haya provocado una entrada real en BFCache.

## 16. Fallback del polling en entornos sin Page Visibility

Cuando el objeto `Document` no expone `hidden` booleano o los listeners de visibilidad, el scheduler mantiene el refresco periódico normal. Este camino no puede suspenderse automáticamente al ocultar la pestaña, porque el entorno no ofrece una señal fiable de visibilidad.

La cancelación conserva las mismas garantías de ciclo de vida que el camino completo:

- el callback periódico queda envuelto por un indicador de disposición;
- un tick que ya estaba encolado no refresca después de desmontar la vista;
- la cancelación es idempotente;
- se rechaza un scheduler que no devuelva una función de cancelación.

Las regresiones están en `tests/live-author-monitor-diagnostics-isolation.test.mjs`. Cubren el fallback y el callback atrasado mediante un scheduler determinista; no simulan ni afirman disponibilidad de Page Visibility.


## 17. Generaciones de intervalos y recuperación de fallos de programación

Cada intervalo del polling visual tiene una generación monotónica. Al suspenderse o desmontarse la vista, la generación cambia antes de llamar a la cancelación del timer. Los callbacks ya encolados de generaciones anteriores no se ejecutan aunque la vista vuelva a estar activa.

La protección también cubre dos fallos del scheduler:

- Si el montaje inicial falla después de encolar un callback, el módulo invalida ese callback y elimina los listeners registrados.
- Si la reanudación no puede crear un nuevo intervalo, la vista vuelve al estado inactivo. Una señal posterior de ciclo de vida puede reintentar el refresco y la programación sin revalidar callbacks huérfanos.

Un scheduler que provoque una transición síncrona mientras crea un intervalo recibe cancelación inmediata cuando devuelve su función de cancelación, siempre que esa programación haya quedado obsoleta antes de finalizar la llamada.

Las regresiones deterministas están en `tests/live-author-monitor-diagnostics-isolation.test.mjs`. La generación protege únicamente el polling del panel/workspace; no controla persistencia, heartbeat ni fencing del lease de datos.


## 18. Desmontaje resistente a fallos de cleanup

La disposición de panel y workspace invalida primero los callbacks pendientes. Después intenta retirar cada listener de `window` y `document` de forma independiente y cancela siempre el intervalo.

Si una operación de limpieza lanza, el módulo continúa con las demás. Al finalizar, propaga el primer error observado para que el anfitrión pueda diagnosticar el problema; no oculta el fallo ni deja de intentar liberar recursos posteriores.

La operación sigue siendo idempotente: una segunda llamada no vuelve a ejecutar la limpieza, incluso si la primera tuvo que informar un error. La regresión específica simula errores de retirada en listeners distintos y comprueba el intento de liberar los cinco listeners y el timer.

Esta protección afecta al polling visual del monitor. No cambia el ciclo de vida de checkpoints, heartbeat ni leases.


## 19. Reintento seguro de la desuscripción de la fuente del editor

El enlace de cambios conserva la función de cancelación de la fuente hasta que esta termina correctamente. Si el proveedor lanza al desuscribirse durante un overflow, el monitor sigue en estado `resync-required` y no abre una segunda suscripción sobre el listener anterior.

Después de obtener y validar un snapshot común, `discardPendingAfterResynchronization()` reintenta la desuscripción previa antes de volver a conectar la fuente. Si falla otra vez, conserva el estado de resincronización y permite repetir la operación; no mezcla dos streams.

El desmontaje también permite repetir `stop()` cuando una cancelación falló. Las notificaciones tardías no llegan al sink porque el enlace marca `disposed` antes de iniciar los intentos de liberación.

Las pruebas `live-author-monitor-change-binding.test.mjs` cubren cancelación transitoria fallida durante overflow y durante stop. Se comprueban la ausencia de suscripciones duplicadas, la entrega única de la siguiente edición y el bloqueo de callbacks de una instancia dispuesta.


## 20. Snapshot profundo e inmutable del backlog

`getPendingChanges()` devuelve una instantánea de diagnóstico, no referencias a los objetos que el enlace reenviará al motor. Cada entrada es una copia plain-data limitada a los campos del contrato `EditorChange`, y tanto las entradas como el arreglo están congelados.

Esta protección evita que un consumidor de JavaScript modifique accidentalmente un delta pendiente a través de la consulta de backlog. No modifica el objeto original que entregó el editor ni altera el orden FIFO. La regresión correspondiente intenta cambiar el reemplazo de una copia y comprueba que el delta pendiente original permanece intacto.


## 21. Aislamiento del backlog respecto de objetos externos mutables

Cada cambio que se retiene por contrapresión o error de admisión se copia inmediatamente a un objeto con solo los campos del contrato `EditorChange` y se congela. Los deltas posteriores que llegan mientras hay backlog siguen la misma regla.

De esta manera, si el proveedor reutiliza o modifica después su objeto, o si un callback de observabilidad altera el argumento que recibió, el contenido pendiente no cambia. Al reintentar, el sink recibe la copia congelada y conserva la secuencia y los offsets originales.

La consulta `getPendingChanges()` devuelve además nuevas copias congeladas para diagnóstico, sin compartir referencias con la cola interna. La regresión del módulo altera deliberadamente tanto el objeto entregado al callback como el objeto original del segundo delta, y comprueba que el reintento sigue enviando los dos reemplazos originales en orden.


## 22. Rechazos permanentes del motor y pausa para resincronización

La cola externa distingue el único rechazo transitorio de capacidad (`queue_full`) de los rechazos que no se reparan esperando espacio:

- `invalid_change`
- `unknown_document`
- `change_too_large`
- `resync_required`

Estos rechazos detienen la captura de la fuente y publican un estado `resync-required` con el motivo real y `resyncSequence`. No se reintentan automáticamente ni se permite que deltas posteriores adelanten al rechazado. Si ya existía backlog, se conserva íntegro y en orden. La cola solo se limpia después de que el anfitrión haya reconciliado editor y motor con el mismo snapshot autoritativo.

`overflowSequence` se reserva para el caso distinto en que el buffer alcanza su límite. `LiveAuthorMonitorAdmissionResynchronizationError` identifica los rechazos permanentes sin incluir texto del manuscrito. La regresión de admisión inicial cubre las cuatro causas; otra prueba cubre el mismo rechazo al reintentar la cabeza de una cola FIFO.


## 23. Orden de pausa y callbacks reentrantes

Al producirse un rechazo permanente, el binding primero marca `resync-required`, solicita la reconciliación y desacopla la fuente; después notifica `onAdmission`. Este orden es intencional porque los callbacks de observabilidad pueden emitir o causar trabajo síncrono. Si la notificación ocurriera antes de pausar, un nuevo delta podría adelantarse a la secuencia que exige un snapshot común.

La misma regla se aplica cuando el rechazo aparece al reintentar la cabeza FIFO. Las pruebas reentrantes comprueban que una emisión disparada desde `onAdmission` no llega al sink mientras la fuente está pausada.


## 24. Delta permanente rechazado retenido hasta el snapshot autoritativo

Un rechazo permanente no se reintenta, pero el delta causante sí queda en el backlog congelado y acotado para que la integración del editor pueda inspeccionar la secuencia que requiere reconciliación. La fuente se pausa de inmediato y no se aceptan deltas posteriores.

El anfitrión compara el snapshot durable del motor con el editor. Solo después de confirmar que el snapshot común cubre la transacción rechazada llama a `discardPendingAfterResynchronization()`; entonces el binding limpia el delta y rearma el listener. El delta que desbordaría un buffer ya lleno sigue fuera de la cola y se identifica mediante `overflowSequence`.

Esta distinción permite conservar la trazabilidad sin reintentar una edición que el motor ya clasificó como inválida/no recuperable mediante capacidad.


## 25. Una sola notificación de admisión tras pausar un rechazo permanente

Durante `retryPending()`, `queue_full` informa el rechazo una sola vez y conserva la cola para otro intento cuando haya capacidad. Un motivo permanente primero pausa y desuscribe la fuente, y solo después emite `onAdmission` una vez. Esto es necesario porque el callback de la aplicación puede provocar emisiones síncronas; nunca debe ejecutarse una vez antes y otra después de entrar en `resync-required`.


## 26. Criterio del fixture de reentrancia tras recuperación

La prueba de reentrancia debe modelar la recuperación completa: la primera secuencia queda en `queue_full`, el reintento de esa cabeza devuelve `unknown_document`, la fuente se pausa antes del callback y el callback no consigue introducir la secuencia siguiente. Tras validar el snapshot, el sink del fixture vuelve a admitir secuencias nuevas; no debe simular un rechazo permanente para siempre. La notificación `unknown_document` se verifica como exactamente una.


## 27. Inmutabilidad de eventos retenidos del editor

Cada evento que cruza `subscribeTransactions` se convierte en una copia plana y congelada con solo `transactionId`, `kind` y los campos definidos de `EditorChange`. Esto es importante para eventos reentrantes: permanecen esperando mientras se termina de notificar una transacción anterior, por lo que no deben depender de un objeto que el proveedor pueda reutilizar o mutar.

Los getters fallidos y proxies hostiles se convierten en un error `invalid-transaction` y provocan la pausa del source. El monitor no permite que una excepción del proveedor escape al callback nativo del editor. El test de reentrancia verifica que la mutación posterior del objeto original no cambia el delta procesado.


## 28. Categorías de actividad admitidas por el editor

El proveedor puede omitir `activityKind`, o usar exactamente una de las siete etiquetas del contrato: `typing`, `paste`, `deletion`, `correction`, `undo`, `redo` u `other`. Cualquier valor distinto (incluidos objetos o números) se rechaza como `invalid-transaction`; el source se pausa para que el anfitrión no mezcle categorías arbitrarias en las métricas de escritura. Para transacciones nativas `undo` y `redo`, el tipo de transacción sigue teniendo precedencia sobre la metadata opcional.


## 29. Cierre reintentable del proveedor transaccional

El handle de cancelación del proveedor se conserva hasta que `unsubscribe()` termina correctamente. Si falla, no se crea una segunda suscripción sobre la anterior y `attachProvider()` exige completar primero la retirada pendiente. Las llamadas repetidas a `source.dispose()` y a `integration.dispose()` reintentan la limpieza. Esto evita ocultar listeners todavía activos y evita que una reanudación abra duplicados tras un fallo transitorio del proveedor.


## 30. Diferenciar listener activo de cancelación pendiente

Un disposer presente no implica por sí solo que haya fallado: normalmente representa el listener activo del proveedor. `attachProvider()` no lo cancela ni crea otro. Solo cuando el último intento a `unsubscribe()` lanzó una excepción se activa `providerDetachFailed`, y en la siguiente reanudación se reintenta ese mismo handle antes de abrir una suscripción nueva. Un cierre correcto borra el handle y el flag; un fallo conserva ambos.


## 31. Errores de `dispose()` visibles y reintentables

Si la cancelación del listener del proveedor lanza una excepción, `dispose()` no devuelve éxito silencioso: lanza `No se pudo retirar el listener del proveedor; repita dispose() para reintentar.`. La instancia permanece marcada como dispuesta, sus colas y suscriptores internos se limpian, y el handle fallido se conserva. Una llamada posterior a `dispose()` intenta cerrar ese handle; al completarse, las siguientes llamadas son idempotentes. La integración de editor conserva esta misma semántica para que el anfitrión pueda detectar y reintentar la limpieza pendiente.


## 32. Categoría efectiva en la deduplicación de transacciones

La firma compacta de una transacción incluye también la categoría que recibirá el monitor. Para `edit`, procede de `EditorChange.activityKind`; para `undo`/`redo`, procede del tipo nativo de transacción, que prevalece en el delta publicado. Si el mismo `transactionId` vuelve con la misma edición textual, pero otra categoría efectiva, ya no se considera duplicado idéntico y el source exige resincronización.


## 33. Presupuesto de texto para eventos reentrantes

La cola reentrante queda limitada simultáneamente por cantidad (`maxQueuedTransactions`, predeterminado 4096) y por tamaño agregado del texto de reemplazo (`maxQueuedTextUnits`, predeterminado 4 194 304 unidades UTF-16, alineado con el motor). Este presupuesto se consume solo mientras un evento espera detrás de otro que está siendo procesado; no limita un pegado grande que llega cuando el source está en reposo. Al agotar el presupuesto, se detiene la captura y se exige snapshot para evitar retener una cola de tamaño impredecible.


## 34. Entrega FIFO de snapshots a los suscriptores

Las notificaciones de `LiveAuthorMonitor` se entregan de forma serializada. Si un callback provoca una nueva admisión durante la publicación de un snapshot, el nuevo estado queda en cola y se entrega después de terminar todos los destinatarios del snapshot anterior; así ningún panel puede observar primero la revisión más nueva y después una más antigua.

La lista de destinatarios se fija para cada publicación. Un suscriptor añadido durante una notificación no recibe retroactivamente ese snapshot, y uno retirado antes de su turno ya no se invoca. Las excepciones de un panel siguen aisladas. `dispose()` vacía la cola y la lista de suscriptores, por lo que tampoco se entregan avisos reentrantes pendientes después de la limpieza.


## 35. Continuar las pruebas del monitor cuando falla una auditoría compartida

La lane conserva como fallos reales los errores de auditoría MLDB y de mapeo físico, pero no deja que estos impidan ejecutar la compilación runtime, las pruebas específicas del monitor y el benchmark de heap. Esos tres pasos usan \`if: \${{ !cancelled() }}\`, para continuar después de una falla previa sin ejecutar si el workflow fue cancelado.

Esto separa el diagnóstico del monitor de errores de infraestructura compartida: la lane seguirá en rojo si falla la auditoría, pero ofrecerá evidencia adicional sobre el código de monitoreo. No se usa \`continue-on-error\` para ocultar o convertir en éxito la auditoría.


## 36. Pruebas unitarias independientes del bundle completo del motor

El entrypoint aislado `live-author-monitor-test-entry.ts` exporta el núcleo, el panel y el workspace sin importar la persistencia narrativa. El test principal del monitor y el benchmark intentan cargar primero `dist-monitor/live-author-monitor.js`, y solo usan `dist/motor-literario.js` como fallback cuando el bundle aislado no existe. Así se puede ejecutar el comportamiento puro de `LiveAuthorMonitor` aunque otro módulo ajeno impida compilar el motor completo.

La lane ahora separa tres grupos:
- pruebas unitarias del monitor y recuperación diagnóstica, siempre después del build aislado;
- integración con HostEngineApi, editor y Chromium, únicamente cuando el bundle runtime general se construyó correctamente;
- benchmark de heap del núcleo, usando el bundle aislado si está disponible.

La auditoría MLDB continúa ejecutándose como control independiente. Sus errores siguen dejando la lane en rojo y no se ocultan con `continue-on-error`.


## 37. Preparar Chromium solo para pruebas de integración

La instalación de Chromium se ejecuta después del bundle runtime y únicamente si ese bundle terminó correctamente. Las pruebas unitarias del núcleo, recuperación diagnóstica y benchmark no dependen del navegador y deben ejecutarse antes, incluso cuando una dependencia compartida rompa la compilación completa. Si el runtime compila, Chromium se instala antes de los tests de editor, host y múltiples pestañas.


## 38. Evidencia de validación FIFO y rendimiento (run 45755687906)

La ejecución del 26 de noviembre de 2026 aprobó 37/37 pruebas combinadas del núcleo y diagnósticos, incluidas las tres regresiones de notificación FIFO. El benchmark de memoria procesó 100.000 commits en ocho documentos grandes en 507,42 ms (~197.074 commits/s). Después de GC, el heap observado fue 4,26 MiB tanto a mitad como al final de la carga; las sesiones abiertas retuvieron 0,49 MiB y no quedó ningún ticket pendiente.

Estos datos son una medición de CI en Node.js 22.23.5, no una garantía universal de latencia en todos los navegadores o equipos. La misma ejecución dejó constancia de que la auditoría MLDB y el bundle completo fallaron por cambios compartidos en persistencia, por lo que no se considera validada todavía la integración completa del motor.


## 39. Ráfaga síncrona de notificaciones reentrantes

La suite incluye un caso de carga que hace que el primer suscriptor produzca 999 admisiones adicionales durante la entrega del snapshot inicial. Un segundo suscriptor debe recibir exactamente 1.000 snapshots con secuencias consecutivas, sin invertir el orden ni desbordar la pila. Esta regresión valida que el drenaje FIFO es iterativo y no se implementa mediante llamadas recursivas anidadas.


**Validación de carga adicional:** [Live Author Monitor — run 45755953392](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45755953392) aprobó 38/38 pruebas. La ráfaga de 1.000 snapshots se drenó en 2,31 ms y el benchmark de 100.000 commits terminó en 355,86 ms (~281.013 commits/s), con heap de 4,26 MiB al 50 % y al 100 % de carga y cero tickets pendientes. La conclusión global de Actions sigue siendo `failure` únicamente por controles de infraestructura/compilación compartidos fuera del núcleo del monitor.


## 40. Diagnóstico visible de fallos de suscriptores y vistas

El monitor cuenta por documento las excepciones de callbacks de suscriptores sin conservar sus mensajes. El snapshot expone `listenerErrors`; la escritura, la admisión y los demás suscriptores siguen funcionando. El contador es operativo de la instancia: se reinicia al restaurar la sesión y no se incluye en checkpoints.

`subscribeLiveAuthorMonitorWithRefresh` acepta `onListenerError(snapshot)` para avisar de fallos del callback de una vista sin entregar el objeto Error. El panel muestra tanto los fallos registrados por el monitor como los fallos locales de su propio renderizado. El workspace presenta el contador del monitor en la tarjeta del capítulo correspondiente.

Los avisos son genéricos, accesibles y no muestran mensajes internos ni texto del manuscrito. La prueba del núcleo verifica el aislamiento entre documentos; las pruebas de panel y workspace fuerzan fallos de visualización y comprueban que la escritura sigue admitiéndose y que la alerta se muestra en la tarjeta correcta.


## 41. Validación de diagnóstico de errores de vistas (run 45756516860)

El 26 de noviembre de 2026, la lane aislada pasó el bundle reducido, 17/17 pruebas diagnósticas y 59/59 pruebas del núcleo, panel y workspace. Las regresiones nuevas verifican que (a) un listener defectuoso incrementa el contador solo del documento afectado, (b) el texto de excepción no se presenta ni se retiene, (c) un fallo del callback de la vista se expone mediante `onListenerError(snapshot)` y (d) el panel/workspace muestran un estado de advertencia accesible sin interrumpir la admisión de escritura.

El benchmark procesó 100.000 commits en 499,17 ms (~200.332 commits/s). Tras GC, el heap fue 4,26 MiB a mitad y al final de la carga; 0,50 MiB quedaron retenidos por las sesiones abiertas y no hubo cambios pendientes. La lectura corresponde a Node.js 22.23.5 y ocho documentos con 1.048.576 unidades UTF-16 cada uno.

La lane completa mantiene fallo porque la auditoría de esquema y la compilación del bundle runtime general detectan problemas en la línea de persistencia concurrente. No se modificaron esos archivos desde el desarrollo del monitor; las integraciones dependientes del motor completo siguen pendientes.


## 42. Type-check aislado del núcleo y de las vistas

El archivo `tsconfig.live-author-monitor.json` extiende la configuración estricta del proyecto, pero incluye solo el entrypoint reducido `src/live-author-monitor-test-entry.ts`. TypeScript sigue resolviendo y comprobando sus dependencias transitivas (monitor, panel, workspace y contratos utilizados) sin cargar módulos de persistencia que no forman parte de esta lane. La comprobación se ejecuta antes del bundle Vite y de las regresiones; no sustituye el type-check global, que permanece como control separado del proyecto completo.
