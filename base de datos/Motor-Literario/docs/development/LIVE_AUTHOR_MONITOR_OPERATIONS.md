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


## 43. Evidencia del type-check aislado (run 45756749489)

La lane específica ejecutó `npx tsc --noEmit --project tsconfig.live-author-monitor.json` y aprobó el chequeo estricto de los módulos transitivos del monitor, panel y workspace. El build aislado Vite, 17 pruebas diagnósticas y 59 pruebas combinadas también pasaron. El benchmark procesó 100.000 commits en 580,44 ms (~172.282 commits/s), manteniendo 4,26 MiB de heap tras GC tanto a mitad como al final de la carga y cero pendientes.

La conclusión global de la lane sigue siendo fallo por la auditoría IndexedDB y un error de sintaxis en `indexeddb-store.ts:2560`, fuera del alcance del monitor. La nueva comprobación no sustituye el type-check global ni la integración real con el runtime/editor.


## 44. Ciclo de vida de los contadores de errores de vistas

`listenerErrors` pertenece a la instancia de observabilidad y no al checkpoint durable. Se incrementa por sesión/documento mientras la instancia está viva; al serializar métricas durables se omite deliberadamente y `restoreCheckpoint()` lo inicializa a cero. Así, un panel que falló antes de un cierre forzado no hace que una vista nueva parezca defectuosa al recuperar el documento. Las regresiones de checkpoint verifican el contador previo, la ausencia de la propiedad en el registro durable y el cero tras la restauración.


## 45. Restauración sin heredar fallos de vistas de la instancia anterior

La ejecución [Live Author Monitor — run 45756913002](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45756913002) aprobó la regresión de checkpoint: tras provocar dos fallos de suscriptor, el snapshot local cuenta ambos; el checkpoint durable no declara ni serializa `listenerErrors`; y `restoreCheckpoint()` inicia el documento recuperado con cero fallos de vistas. La suite completa aislada terminó en 59/59 y el type-check estricto independiente pasó. Esto evita que un error de DOM o de un panel antes de un cierre forzado se arrastre como alerta de la sesión recuperada.


## 46. Fallos de renderización y reconciliación por capítulo

El workspace no deja que una excepción de actualización de una tarjeta detenga la reconciliación de las demás. Los fallos locales del renderer se cuentan por documento en memoria y se presentan junto al diagnóstico de listeners, con mensajes genéricos. El contador se elimina cuando desaparece el documento o se desmonta el workspace; no se guarda en checkpoints y no altera los contadores del motor. La prueba fuerza un `getDocumentLabel()` que falla una vez, comprueba la alerta en la tarjeta correcta y verifica que el siguiente refresco recupera la etiqueta sin borrar el aviso histórico de esa instancia.


**Validación de la reconciliación del workspace:** [Live Author Monitor — run 45757281903](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45757281903) aprobó 61/61 pruebas del núcleo, panel, workspace y diagnósticos, con type-check estricto y build aislado correctos. La prueba de etiqueta transitoriamente defectuosa mostró que el refresco conserva el aviso sólo en la tarjeta afectada y se recupera en el pulso siguiente. El benchmark midió 100.000 commits en 511,50 ms (~195.503 commits/s), heap estable de 4,26 MiB y cero pendientes. La lane completa continúa roja sólo por la auditoría y la compilación general de la persistencia concurrente.


## 47. Scheduler de visibilidad: contrato de suspensión y limpieza

El refresco visual debe existir solamente mientras el documento está visible y no suspendido por Page Lifecycle. `visibilitychange` consulta el valor autoritativo `document.hidden`; por ello `pageshow` o `resume` no reactivan polling mientras permanezca oculto. Cada intervalo tiene una generación: callbacks de intervalos cancelados o de instalaciones síncronas invalidadas no se ejecutan aunque ya estén encolados.

La inicialización es transaccional respecto de los listeners: si el registro parcial o la función de cancelación falla, se invalidan callbacks y se intenta retirar todos los handlers. El desmontaje intenta todos los `removeEventListener` y cancela el intervalo aun si una limpieza aislada falla; comunica al final el primer error de limpieza. La nueva suite pura de `live-author-monitor-visibility.test.mjs` fija estos comportamientos sin iniciar Chromium.


## 48. Validación aislada del scheduler de visibilidad (run 45757854690)

La lane de Live Author Monitor aprobó el type-check estricto, build aislado, 17/17 pruebas de recuperación y 69/69 pruebas combinadas. Las ocho pruebas dedicadas a visibilidad/Page Lifecycle cubren `visibilitychange`, `pagehide/pageshow`, `freeze/resume`, ticks obsoletos, transiciones síncronas durante el montaje, rollback por alta de listeners o scheduler defectuoso, limpieza parcial, modo sin Page Visibility y desmontaje idempotente.

El benchmark midió 100.000 commits en 660,83 ms (~151.325 commits/s); el heap tras GC quedó en 4,27 MiB a mitad y 4,26 MiB al final, 0,50 MiB retenidos por sesiones abiertas y cero tickets pendientes. La ejecución global sigue roja por la auditoría IndexedDB y el error de compilación de la ruta de persistencia compartida; las pruebas aisladas del monitor sí pasaron.


## 49. Integración del editor validada sin el runtime narrativo completo

Las suites de los adaptadores del editor se ejecutan desde el bundle aislado del monitor, no desde el bundle principal del motor. El entrypoint de pruebas exporta ahora el binding de cambios, la fuente transaccional nativa, su bridge y su integración, la integración del panel de pestaña activa y las fuentes/integración del textarea. TypeScript estricto comprueba sus dependencias transitivas, y Vite genera el bundle reducido antes de ejecutar las pruebas.

La evidencia del run 45758057459 es 161/161 pruebas y type-check estricto aprobados. Esto valida contratos y comportamiento determinista de los adaptadores con editores fake que emiten eventos nativos controlados; no sustituye aún las pruebas de navegador con IndexedDB real ni demuestra compatibilidad con una implementación externa concreta de editor. Las integraciones browser/host siguen condicionadas a que el bundle completo y la auditoría de persistencia pasen.


## 50. Hito de integración end-to-end alcanzado en commit 948408ae

La ejecución [Live Author Monitor — run 45758096783](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45758096783) pasó todos los pasos: type-check estricto, bundle monitor, MLDB 0.4.2 con 27 tablas, runtime bundle, Chromium, 161/161 pruebas unitarias/aisladas y 167/167 al incluir host/editor/browser. En Chromium pasaron el lease entre dos páginas con IndexedDB real y fencing token, el ciclo de vida de pestaña y escritura/guardado/recuperación de dos capítulos.

Se documenta como evidencia válida del checkout `948408ae9e9519495dc8df97f48abcf20a38020e`. No se extrapola al HEAD actual: commits de sincronización posteriores modificaron persistencia y una validación posterior reporta sintaxis inválida en `indexeddb-store.ts:2560`. El próximo gate es repetir el pipeline integral sobre un commit actual cuando las modificaciones de persistencia queden estables.


## 51. Prueba Page Lifecycle en Chromium desacoplada del runtime

El único harness Chromium que importa exclusivamente `live-author-monitor-visibility.ts` se ejecuta aunque falle la compilación general. Así se obtiene evidencia real de `pagehide/pageshow`, `freeze/resume` y `visibilitychange` en navegador incluso durante una regresión de persistencia. El workflow instala Chromium después de la suite de unidad; el browser test aislado no abre IndexedDB ni carga el motor narrativo. Las integraciones browser que requieren persistencia/editor siguen detrás de `runtime-build == success`.

El paso Chromium independiente debe considerarse validado solo cuando `Run isolated Page Lifecycle regression in Chromium` termine con `success`; la ejecución inicial queda registrada por separado.


## 52. Estado de validación cruzada del HEAD actual

La ejecución integral verde [45759321606](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45759321606) aprobó los 17 diagnósticos, 161 tests aislados y 167 tests host/editor/browser; además, Chromium aprobó Page Lifecycle y las pruebas de dos pestañas/IndexedDB, y el benchmark de 100.000 commits dejó heap estable de 4,39 MiB y cero pendientes. Los SHA de núcleo, panel, workspace, visibility scheduler, entrypoint, suites de integración editor y workflow se compararon con `main` y son idénticos al checkout `e951f9a` usado por ese run.

La validación general posterior del HEAD actual falla por una aserción de `tests/core.test.mjs:2163` que aún espera el esquema inicial anterior a los dos almacenes DB27; después de esa primera falla el runner cancela 235 tests. Esto no es un error del monitor y no se parchea desde este módulo. La prueba aislada de Page Lifecycle también pasó de manera independiente en el run 45758203803, pese a que aquel checkout sí tenía el runtime general bloqueado.


## 53. Ráfagas reentrantes del puente de eventos del editor

`LiveAuthorMonitorEditorTransactionBridge` serializa publicaciones reentrantes mediante una cola FIFO y un guard `dispatching`, evitando recursión y reordenamientos. La prueba de estrés crea 1.000 transacciones: el primer listener genera 999 emisiones adicionales al recibir la primera; ambos observadores deben ver las mismas secuencias y en el mismo orden. La prueba se ejecuta dentro de la suite aislada del editor y no requiere el runtime narrativo completo.


**Validación del estrés FIFO:** [run 45759874190](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45759874190) terminó con todos los pasos aprobados. La suite aislada terminó en 162/162; la suite host/editor/browser, en 168/168. La regresión de 1.000 publicaciones reentrantes pasó en ambos comandos. También pasaron el build de runtime, type-check, auditoría MLDB y Page Lifecycle/IndexedDB en Chromium. El benchmark registró 100.000 commits en 655,47 ms, heap estable de 4,39 MiB y cero pendientes.


## 54. Recuperaciones sucesivas y continuidad de una sesión

Un takeover puede ocurrir más de una vez durante la vida de un documento. Cada restauración debe partir de un checkpoint cuyo revision, sequence y currentDocumentLength coincidan exactamente con el snapshot durable del motor. La sesión conserva su sessionId, contadores acumulados, clasificación de cambios y ventana acotada de latencias. No se reconstituyen tickets pendientes: los checkpoints solo se crean cuando todas las admisiones están durables.

En cada recuperación, restoredAt - savedAt se añade una única vez a sessionDurationMs e idleDurationMs; nunca a activeDurationMs. El checkpoint siguiente registra el nuevo total, de modo que la siguiente instancia suma únicamente el intervalo desde ese checkpoint y no vuelve a contabilizar interrupciones previas. La primera edición posterior al takeover debe continuar desde la secuencia y revisión durables, y puede incrementar pauseCount si el último evento supera idleAfterMs.

La regresión "encadena dos recuperaciones tras cierres abruptos sin duplicar métricas ni tiempo inactivo" cubre tres instancias consecutivas, dos intervalos de recuperación, una nueva edición entre handoffs y los invariantes anteriores. Es una prueba determinista del contrato de LiveAuthorMonitor.restoreCheckpoint(); las pruebas de dos pestañas, IndexedDB y fencing siguen siendo responsables de demostrar la coordinación real entre propietarios.


**Validación comprobada:** [Live Author Monitor — run 45760625214](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45760625214), sobre el commit 04632f8b, pasó type-check aislado, build focalizado, auditoría de esquema/almacenamiento, runtime build, 17/17 diagnósticos, 163/163 pruebas aisladas del núcleo y adaptadores, Page Lifecycle Chromium 1/1 y host/editor/browser 168/168. La prueba de tres instancias consecutivas quedó aprobada dentro de la suite aislada. El benchmark de 100.000 commits terminó en 503,05 ms (~198.786 commits/s), heap de 4,39 MiB a mitad y carga completa, 0 MiB de crecimiento medido, 0,50 MiB retenidos y cero pendientes. Esta ejecución certifica la lane dedicada del monitor en ese checkout; no debe confundirse con el estado de la suite general del motor ni con una medición de producción.


**Comprobación adicional de la suite general:** [Motor Literario TypeScript — run 45760625242](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45760625242) terminó correctamente sobre el commit de código 04632f8b: 926/926 pruebas, 0 fallidas, 0 canceladas; type-check y build global aprobados. La regresión de recuperaciones consecutivas pasó también en esta suite (test 751). Esta evidencia complementa, pero no sustituye, las comprobaciones específicas de Chromium/IndexedDB y fencing.


## 55. Validación previa del snapshot de recuperación

restoreCheckpoint recibe un snapshot durable tipado, pero valida también la frontera de runtime. Antes de leer documentId, text, revision o sequence, debe rechazar null y valores no objeto con un TypeError de contrato. Esta comprobación se ejecuta antes de insertar una nueva DocumentSession, por lo que un argumento inválido no deja estado parcial en el monitor.

Después de este guard se mantienen las validaciones de correspondencia exacta de projectId/documentId y de revision/sequence/longitud del snapshot. El rechazo de un snapshot malformado no modifica las sesiones existentes ni las métricas acumuladas.


**Validación CI del guard:** [Live Author Monitor — run 45760911836](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45760911836) terminó success en el commit ce1b71bb: type-check/build aislados, 17 diagnósticos, 163/163 pruebas del monitor, Chromium Page Lifecycle 1/1 y host/editor/browser 168/168. La regresión de snapshot nulo quedó aprobada dentro de la prueba de rechazo de checkpoints malformados. La suite global [run 45760911868](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45760911868) también pasó 927/927, sin fallos ni cancelaciones, con type-check y build completos.


## 56. Invariantes de integridad de checkpoints de escritura

Un checkpoint se crea únicamente cuando no quedan tickets pendientes. Por tanto, cada cambio aceptado debe haber terminado en exactamente uno de dos resultados: commit aplicado o commit fallido. La restauración exige committedChanges + failedChanges = acceptedChanges; un registro con outcomes faltantes no representa un estado durable completo.

La ventana de latencia es una cola de las últimas muestras confirmadas: nunca puede superar el número total de commits resueltos ni el máximo configurado. Cuando hay commits resueltos, la ventana debe contener al menos una muestra y su último elemento debe ser exactamente lastCommitLatencyMs. Sin commits resueltos, la ventana y ambas latencias (última y total) deben ser cero. El total de la ventana no puede superar la latencia acumulada histórica (con tolerancia numérica de 1 ms ya aplicada por el validador).

Estos invariantes protegen solo la lectura/recuperación de checkpoint. No cambian el cálculo de métricas en escritura ni los registros históricos ya válidos generados por el monitor.


**Validación CI de los invariantes:** [Live Author Monitor — run 45761138764](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45761138764) terminó success con 164/164 pruebas aisladas, Page Lifecycle Chromium 1/1 y 168/168 pruebas host/editor/browser; el test de outcomes y latencias incoherentes pasó como test 161. La suite general [run 45761138762](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45761138762) aprobó 928/928, cero fallos y cero cancelaciones. El benchmark de 100.000 commits dejó heap estable de 4,39 MiB y cero tickets pendientes.


## 57. Integridad densa de las muestras de latencia

La ventana `commitLatencies` es una secuencia ordenada de muestras, no solo un array cuya propiedad `length` sea correcta. Cada posición entre cero y `length - 1` debe contener un número finito no negativo. No se aceptan arrays dispersos: los métodos nativos `some()` y `reduce()` omiten huecos y pueden validar accidentalmente una suma incompleta. La restauración materializa los elementos con `Array.from()`, convirtiendo cada hueco en `undefined` para que falle la validación numérica.

La regresión asociada crea tres commits confirmados y un checkpoint correcto, elimina una muestra intermedia y exige que `restoreCheckpoint()` lo rechace sin registrar una sesión. Este guard es de solo lectura; no cambia la versión ni la estructura durable del checkpoint.


## 58. Consistencia entre pausas y admisiones

`pauseCount` solo aumenta al procesar una admisión aceptada o rechazada cuando ya existía actividad y el intervalo desde ella supera `idleAfterMs`. Por ello, un checkpoint válido siempre satisface:

`pauseCount <= acceptedChanges + rejectedChanges`

La restauración aplica este límite junto con las validaciones enteras de ambos contadores. No se impone un mínimo de pausas: una sesión puede tener muchas admisiones consecutivas y ninguna pausa. Un valor superior al número de admisiones indica corrupción o una combinación de métricas que el monitor nunca habría producido.

La prueba asociada altera el contador de un checkpoint real sin actividad y exige rechazo sin crear una sesión parcial. La regla no cambia el formato v1 ni requiere migración.


## 59. Balance de caracteres recuperado

El checkpoint conserva los totales acumulados insertados, borrados y la longitud actual, pero no copia el texto inicial. La longitud inicial implícita se reconstruye así:

`initialLength = currentDocumentLength + deletedCharacters - insertedCharacters`

La longitud inicial no puede ser negativa. La condición equivalente es `insertedCharacters <= currentDocumentLength + deletedCharacters`. La primera versión de esta comprobación invirtió la desigualdad; la corrección quedó aplicada en `restoreCheckpoint()` y en el validador IndexedDB el 26 de noviembre de 2026. La prueba ahora usa seis caracteres insertados sobre una longitud actual de cinco, sin borrados, lo que implicaría una longitud inicial de −1.

Este balance no requiere leer el manuscrito original y permite borrados completos, reemplazos y cualquier secuencia válida de deltas. No cambia el formato v1 ni requiere migración.


**Validación:** fórmula correcta y regresión de longitud inicial negativa aprobadas en [run 45764587913](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45764587913), test 164 de la suite específica, junto con 174/174 integraciones y Chromium Page Lifecycle.
## 60. Generaciones para renovaciones y adquisiciones asíncronas

Las rutas genéricas de adquisición/renovación pueden solaparse con checkpoints automáticos, cierres seguros y revalidaciones del heartbeat. Cada operación captura la generación de ciclo de vida vigente e inicializa una si todavía no existe. Las renovaciones normales concurrentes comparten esa época; solo una pérdida o liberación incrementa la generación. Una operación puede publicar su lease o error únicamente si la época sigue vigente y no comenzó una liberación.

Un cierre seguro incrementa la generación antes de liberar el registro. Cualquier renovación que devuelva después queda invalidada: no repuebla `liveMonitorLeases`, no reactiva el heartbeat y devuelve `undefined`. La regla también evita que un error tardío de una operación antigua sobrescriba el diagnóstico de una operación posterior.

La regresión usa un almacén que completa la renovación pero retrasa la respuesta. El cierre libera el lease mientras la respuesta está suspendida; al reanudarla, la prueba verifica que no reaparezcan la titularidad local ni el temporizador, y que el registro persistido siga vencido.


## 61. Monotonía de expiración y actualización del lease

Dos llamadas de renovación pueden completarse en orden distinto al de su inicio. Cuando pertenecen al mismo propietario y al mismo fencing token, la publicación local combina `expiresAt` y `updatedAt` con el máximo de la respuesta y del estado ya publicado. Una respuesta con fencing token menor que el estado local se descarta; un token igual asociado a otro propietario no puede reemplazarlo.

Esta regla evita que una respuesta atrasada reduzca el plazo local de titularidad. No modifica el token de fencing ni extiende artificialmente el lease persistido: solo conserva la información más reciente ya confirmada por el almacén. La prueba retrasa la primera respuesta hasta después de que una segunda renovación haya sido publicada y exige que los dos metadatos permanezcan monótonos.


## 62. Contrato de persistencia para muestras densas y categorías de actividad

La capa IndexedDB valida los checkpoints antes de iniciar una transacción. Las muestras `commitLatencies` deben formar una secuencia densa: cada índice entre cero y `length - 1` contiene una latencia finita no negativa. Se materializa el array con `Array.from()` para que los huecos se validen como `undefined`, ya que `some()`, `every()` y `reduce()` omiten posiciones ausentes.

Dentro de la misma `sessionId`, los contadores de tipo de actividad no pueden retroceder aunque `acceptedChanges` permanezca igual. Se comparan tecleo, pegado, borrado, corrección, deshacer, rehacer y otros cambios. Para un checkpoint v1 histórico que no tenga ninguno de esos campos, el total aceptado anterior se interpreta como `otherChanges`; la comparación usa esa cantidad derivada. Esto evita falsos rechazos al guardar la primera versión nueva de una sesión antigua y, al mismo tiempo, impide reclasificar actividad histórica.

Las pruebas trabajan sobre IndexedDB y verifican que una escritura inválida no deje checkpoint persistido, que una reclasificación se rechace preservando el registro anterior y que la evolución desde un checkpoint histórico siga permitida. No se modifica el esquema ni la versión v1.




**Validación:** muestras dispersas, monotonía de categorías y compatibilidad histórica v1 aprobadas en [run 45764587913](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45764587913), tests 112, 116 y 117.## 63. Validación integral de métricas antes de guardar un checkpoint

Antes de abrir la transacción IndexedDB, el validador comprueba que las métricas describan una sesión completa y alcanzable:

- `pauseCount <= acceptedChanges + rejectedChanges`.
- `committedChanges + failedChanges === acceptedChanges`, porque no se guarda un checkpoint con tickets pendientes.
- `insertedCharacters <= currentDocumentLength + deletedCharacters`, para que la longitud inicial implícita no sea negativa.
- La ventana de latencias no supera el número de outcomes, contiene una muestra si existen outcomes, termina exactamente en `lastCommitLatencyMs` y tiene suma no superior a la latencia histórica acumulada.

Los arrays de muestras también deben ser densos. La validación con `Array.from()` convierte los huecos en valores inválidos antes de persistir. Cualquier incumplimiento aborta la entrada antes de la escritura del checkpoint; no se modifica el lease ni se deja un registro durable parcial.


**Validación:** los cinco balances imposibles se rechazaron antes de persistir en [run 45764587913](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45764587913), test 113. La suite dedicada completó 167/167, Chromium 1/1, host/editor/browser 174/174 y benchmark de 100.000 commits; heap 4,39 MiB estable desde mitad a fin y cero tickets pendientes.

## 64. Errores asíncronos de escritura y presión de cuota

El guardado de checkpoints debe preservar el error del request que escribe en `live-author-monitor-checkpoints`. Si `IDBRequest.onerror` informa un error, el adaptador lo guarda como causa original y aborta la transacción completa. El rechazo de `saveLiveAuthorMonitorCheckpoint()` conserva el nombre del error, por ejemplo `QuotaExceededError`, para que `HostEngineApi` lo publique como código de diagnóstico seguro.

El aborto afecta conjuntamente a la verificación del lease y a la escritura del checkpoint; por tanto, no debe quedar un snapshot parcial. Un checkpoint anterior se conserva. El host expone solamente el código de clase del error y no su mensaje, que podría contener texto privado.

La regresión de cuota inyecta un error request-level asíncrono en el límite de almacenamiento y verifica rechazo con el nombre original y conservación del checkpoint previo. Es una simulación determinista de la ruta de error; no equivale a agotar físicamente la cuota del navegador. Para pruebas de cuota real hacen falta perfiles/dispositivos controlados con límites de almacenamiento distintos.


**Validación CI:** [run 45765001413](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45765001413) aprobó el request-level `QuotaExceededError` como test 114 y la suite host/editor/browser 175/175. La ruta conserva el checkpoint previo y no expone el mensaje de error del manuscrito. La simulación no sustituye una prueba física de cuota agotada en navegador.

La prueba de aborto fuerza `transaction.abort()` después de que el adaptador haya encolado el `put`, antes de completar la transacción. Se comprueba que el commit de checkpoint sea atómico (el registro previo permanece) y que una escritura nueva funcione después de restaurar el método nativo.

## 65. Recuperación después de aborto de transacción y cierre externo de IndexedDB

Un aborto después de `checkpointStore.put()` debe revertir toda la transacción `readwrite`; no se puede anunciar éxito ni dejar un checkpoint nuevo a medias. El error del request se conserva y una operación posterior debe poder escribir normalmente. La prueba deja un checkpoint anterior, aborta la siguiente escritura tras encolarla y comprueba tanto el rollback como la recuperación de una escritura posterior.

Cuando el navegador notifica `IDBDatabase.onclose`, el almacén elimina la promesa de conexión cacheada. Sin esa invalidación, operaciones futuras podrían seguir usando una conexión cerrada. La regresión de cierre externo cierra la conexión e invoca el handler `onclose` que el adaptador registró (el simulador no admite un `dispatchEvent` sintético después del cierre); lee dos veces el checkpoint y verifica que la primera lectura haya reabierto la base y la segunda reutilice la conexión nueva.

Estas pruebas deterministas no equivalen a un apagado forzado de sistema operativo ni a pérdida real del almacenamiento; esos casos requieren pruebas de navegador/dispositivo adicionales.


**Validación del aborto:** [run 45765202154](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45765202154) aprobó el rollback después de encolar el put (test 115); el checkpoint previo y la capacidad de escritura posterior quedaron verificados.

**Validación CI dedicada:** [run 45765482739](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45765482739) aprobó el aborto transaccional (test 115) y la reapertura por `onclose` (test 116), con 177/177 integraciones, Chromium Page Lifecycle 1/1 y benchmark de 100.000 commits.

## 66. Recuperación de diagnóstico después de liberar cuota

Un error de persistencia no debe dejar el panel en estado de error después de que una escritura posterior se complete correctamente. El anfitrión conserva el código de la última falla mientras no haya un checkpoint guardado; al confirmar una escritura durable, elimina el error previo y registra el nuevo `lastCheckpointAt`.

La regresión simula una cuota llena en el primer intento y una recuperación del almacenamiento antes de la siguiente edición. Debe observarse la transición `error / QuotaExceededError → saved / sin error`, con la misma sesión del monitor y la revisión durable nueva. La ruta no borra el diagnóstico solo por reintentar ni al programar el checkpoint; lo hace cuando el almacén confirma la escritura.


**Validación CI:** [run 45765718734](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45765718734) aprobó la recuperación observable como test 108, junto a la prueba de privacidad de error como test 107; 178/178 integraciones host/editor/browser y benchmark de 100.000 commits también aprobaron.

## 67. Takeover cuando una escritura del antiguo propietario sigue en vuelo

El fencing se valida en el punto de escritura durable, no solo al iniciar el trabajo ni al renovar el heartbeat. Una llamada antigua puede haber obtenido un snapshot local del lease y permanecer suspendida mientras otra pestaña toma el control. Al reanudarse, el almacén debe volver a comparar `ownerId` y `fencingToken` con el registro vigente.

La regresión pausa una escritura del propietario A, deja expirar su lease, permite que el observador B adquiera el siguiente token y confirme su checkpoint, y luego reanuda A. La escritura de A debe rechazarse y nunca sustituir el checkpoint de B. Este escenario verifica el orden adverso en la capa del anfitrión; las transacciones IndexedDB reales conservan adicionalmente el bloqueo serializable de su transacción readwrite.



**Validación CI:** [run 45766086566](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45766086566) aprobó la transferencia con escritura antigua en vuelo como test 106 y completó 179/179 integraciones host/editor/browser.


**Validación:** [run 45766548438](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45766548438) aprobó el aislamiento IndexedDB A/B y la independencia de cierre/heartbeat del host: tests 126 y 100; suite 181/181.## 68. Aislamiento del fencing por documento

Los leases se direccionan por la clave compuesta `(projectId, documentId)`. En un proyecto con varios capítulos abiertos, el cambio de propietario de A no debe cambiar el fencing token de B. El lease de B puede renovarse y su checkpoint puede persistirse mientras A pertenece a otra pestaña.

La prueba real de IndexedDB adquiere dos leases, deja expirar A y hace takeover con el siguiente token; luego renueva B usando su snapshot original, intenta guardar con el token antiguo de A y guarda el checkpoint B. Se comprueba que A no escriba, B siga siendo durable y la liberación de A con el token obsoleto no afecte la titularidad de B.




**Validación:** [run 45766548438](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45766548438) aprobó el test 100 y la suite host/editor/browser 181/181.## 69. Cerrar un documento no altera la titularidad de los demás

El host mantiene mapas de leases, heartbeats, generaciones, errores y colas de checkpoints indexados por `documentId`. Al cerrar un documento, solo deben limpiarse los recursos correspondientes a esa clave. Un segundo documento del mismo proyecto sigue siendo propietario, conserva su heartbeat y puede continuar guardando nuevas revisiones.

La prueba abre dos capítulos, verifica dos leases/checkpoints, cierra A y después escribe otra edición en B. Se comprueba que A queda liberado con su snapshot final, B conserva el propietario y el fencing token, su checkpoint avanza y la sesión de B no cambia.




**Validación CI:** [run 45766785514](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45766785514) aprobó la reanudación parcial A/B como test 113 y completó 182/182 integraciones, Page Lifecycle Chromium 1/1.## 70. Reanudación parcial de leases en varios documentos

Al volver la página a primer plano, el host revalida todas las claves de documento que mantienen heartbeat. La expiración puede afectar solo a uno de ellos: ese documento compite por un nuevo fencing token; los demás renuevan su lease existente, conservando propietario y token.

La prueba abre dos documentos, simula la suspensión expirando A y reduciendo el vencimiento de B a un segundo sin perder su validez, y dispara `visibilitychange`. B debe recibir una extensión real de expiración sin cambiar owner/token. Comprueba que A avanza exactamente un token, B conserva el suyo y ambos preservan la sesión y el heartbeat. El ciclo no debe provocar un takeover innecesario para documentos que mantuvieron una titularidad válida.



**Cobertura en navegador:** [run 45766901884](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45766901884) también verificó aislamiento A/B con dos páginas Chromium, cierre abrupto de la propietaria y recarga real de la pestaña superviviente.
## 71. Dos documentos y dos páginas Chromium

La prueba de navegador mantiene dos leases de documento en una misma pestaña propietaria. La otra página no puede adquirir ninguno. Tras cerrar abruptamente la propietaria, solo se expira A: la página superviviente toma A con el siguiente fencing token, pero B permanece ocupado y su checkpoint no cambia.

La prueba persiste el checkpoint actualizado de A, recarga realmente la página observadora y comprueba que ambos checkpoints sobreviven a la recarga. También vuelve a intentar la adquisición de B para verificar que el takeover de A no alteró el lease durable del segundo documento.


**Validación CI:** [run 45766901884](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45766901884) aprobó el escenario de dos documentos en dos páginas Chromium; suite 182/182 y benchmark 100.000 commits.

## 72. Coalescencia de eventos de reanudación

`visibilitychange` y `pageshow` pueden ocurrir en una ventana breve al volver de background o BFCache. El host permite una renovación en vuelo por documento y coalesce eventos posteriores en un solo follow-up. Con varios documentos, cada clave conserva su propia renovación/follow-up; no hay un único mutex global que retrase capítulos no relacionados.

La prueba demora las renovaciones iniciales de dos documentos, dispara ambos tipos de evento repetidamente, comprueba un solo follow-up por capítulo y después libera las respuestas. Cada documento debe registrar exactamente dos llamadas de renovación y conservar owner, fencing token y un único timer de heartbeat.


**Validación CI:** [run 45767262316](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45767262316) aprobó el test 114 (un follow-up por documento), suites 183/183, Chromium Page Lifecycle 1/1 y benchmark de 100.000 commits.

## 73. Disposición segura multi-documento

`disposeSafely()` espera el motor y las colas existentes, persiste el último checkpoint de cada documento que conserva un lease, vuelve a esperar las escrituras y después libera cada lease antes de disponer el host. Una falla de persistencia debe impedir declarar un cierre seguro.

La regresión abre cuatro capítulos, admite una edición en cada uno y llama a `disposeSafely()`. Debe comprobar cuatro checkpoints finales con las nuevas revisiones, cuatro leases liberados con sus owner/fencing tokens, cero heartbeats activos, cero leases locales y cero errores.


**Validación general:** [run 45767527107](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45767527107) aprobó el nuevo test `disposeSafely` multi-documento (test 677); el único fallo de las 960 pruebas fue la prueba Unicode narrativa ajena al monitor. La lane dedicada permanece pendiente de completar Chromium.

## 25. Orden obligatorio para recuperar el adaptador nativo después de overflow

El binding FIFO y LiveAuthorMonitorTextAreaSource tienen estados de recuperación distintos. discardPendingAfterResynchronization() vuelve a conectar la suscripción del binding, pero no debe interpretarse como una autorización para que el adaptador nativo vuelva a capturar. El adaptador conserva needsResync hasta validar explícitamente el snapshot recibido.

Para una fuente LiveAuthorMonitorTextAreaSource, el anfitrión debe completar este orden síncrono:

1. Obtener un snapshot autoritativo del motor y reconciliar el textarea visible con ese mismo texto, revisión y secuencia.
2. Llamar a discardPendingAfterResynchronization() una vez confirmada la reconciliación común. El binding limpia el backlog y vuelve a suscribir la fuente, que continúa suspendida.
3. Llamar inmediatamente a source.resynchronize(snapshot) con ese mismo snapshot y con la suscripción ya activa. La API comprueba que el valor visible coincida exactamente y que exista un observador; solo entonces restablece revision, sequence, longitud y copia sombra.
4. Rehabilitar la edición normal únicamente después de que resynchronize() termine correctamente.

No se debe llamar a source.resynchronize(snapshot) antes de discardPendingAfterResynchronization(): el adaptador rechaza la recuperación sin observador activo. Tampoco se debe asumir que discardPendingAfterResynchronization() reanuda por sí solo la captura. Entre el paso 2 y el 3, los eventos se ignoran de forma deliberada; si el contenido visible cambia y deja de coincidir con el snapshot, resynchronize() falla con document-mismatch y el anfitrión debe repetir la reconciliación.

La regresión integrada en live-author-monitor-change-binding.test.mjs utiliza el adaptador de textarea real: provoca queue_full y overflow, confirma la liberación de la copia sombra, rearma el binding, comprueba que el adaptador continúa bloqueado, aplica el snapshot común mediante resynchronize() y verifica que el siguiente delta admitido conserva la secuencia/revisión esperadas.

**Evidencia:** prueba automatizada añadida al repositorio. La ejecución CI correspondiente a este cambio permanece pendiente de confirmación.

## 26. Desmontaje terminal sin diagnóstico de discontinuidad recuperable

El cierre definitivo de mountLiveAuthorMonitorTextArea() no equivale a pausar temporalmente una fuente que podría volver a suscribirse. La integración dispone primero LiveAuthorMonitorTextAreaSource y después detiene el binding; de ese modo, la función de cancelación del binding reconoce que la fuente ya es terminal y no genera un resync-required artificial.

Las pausas por overflow, rechazo permanente, pérdida de foco o ciclo de vida conservan el comportamiento contrario: la fuente no se dispone, libera su copia temporal, marca needsResync y espera una reconciliación autoritativa. El anfitrión debe usar integration.dispose() para el desmontaje definitivo y integration.resynchronize() para recuperar una fuente viva.

La regresión de live-author-monitor-textarea-integration.test.mjs verifica que un montaje y edición válidos se pueden desmontar sin errores de captura adicionales, y que quedan retirados tanto los listeners DOM como las suscripciones de reintento.

## 27. Cancelación de beforeinput por un listener posterior

La fuente registra provisionalmente selección, inputType y datos cuando observa beforeinput. Otros listeners del editor pueden ejecutarse después y llamar a preventDefault(). Por ese motivo, el estado inicial de defaultPrevented visto dentro del listener del monitor no siempre representa la decisión final.

El adaptador programa una microtarea de comprobación. Si, al terminar la propagación síncrona, defaultPrevented es true y la misma operación sigue pendiente, descarta ese estado provisional. No publica delta ni solicita snapshot, porque la acción por defecto fue cancelada. Si input ya consumió el par, la operación cambió o la fuente se suspendió, la comprobación tardía no altera el estado.

No confundir:
- beforeinput cancelado después de que el monitor lo observa: se libera sin error ni delta.
- beforeinput no cancelado seguido de input ausente: se mantiene el diagnóstico missing-input.
- input sin beforeinput: se mantiene missing-beforeinput.

La regresión unitaria y el test Chromium de teclado automatizado cubren el primer caso. Chromium verifica además defaultPrevented=true, ausencia de input y que blur posterior no marque needsResync. La prueba no sustituye la matriz de teclado físico/IME ni una validación física de Page Lifecycle.

## 28. Blur reentrante mientras beforeinput sigue propagándose

Un listener del editor puede cancelar beforeinput y desenfocar el textarea sincrónicamente dentro de la misma propagación. Para operaciones de texto normales, el adaptador no decide missing-input dentro de handleBlur: captura la identidad de la pareja pendiente y difiere la decisión una microtarea. La comprobación defaultPrevented, encolada por handleBeforeInput, se ejecuta antes y puede liberar una operación cancelada; si la misma pareja sigue pendiente, el blur se considera una interrupción real y exige snapshot.

La excepción es una composición activa: perder el foco cierra de inmediato esa continuidad y exige resync-required, aunque exista un beforeinput provisional. Una composición abierta no se conserva como válida tras blur.

La prueba Chromium genera un beforeinput confiable por teclado automatizado; un listener posterior llama a preventDefault() y blur() antes de finalizar la propagación. Comprueba que se observa un solo blur, no aparece input, pendingInput queda vacío y no hay falso missing-input. La prueba unitaria separada confirma que un beforeinput no cancelado que pierde el foco sí produce missing-input.
