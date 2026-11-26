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
```

El workflow específico del monitor valida esquema físico, build, Chromium y tests `live-author-monitor*.test.mjs`. El workflow general ejecuta typecheck, build, suite completa y benchmark.

## 9. Estado de CI conocido al 25 de noviembre de 2026

La última validación integral verde anterior a la fase 3 corresponde al baseline histórico:

- [Live Author Monitor — run 45736377764](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45736377764): 141 pruebas aprobadas, 0 fallidas, 0 omitidas.
- [Motor Literario TypeScript — run 45736377738](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45736377738): 718 pruebas aprobadas, 0 fallidas, 0 omitidas.

Las nuevas entregas no tienen aún validación verde. Las ejecuciones más recientes verificadas:

- [Motor Literario TypeScript — run 45742493582](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45742493582), commit `481b0dde`: fallo en typecheck por `src/narrative-history.ts(7,41): TS1002 — Unterminated string literal`.
- [Live Author Monitor — run 45742415506](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45742415506), commit `f992787`: fallo en Build runtime bundle por el mismo literal sin cerrar en `src/narrative-history.ts:7:40`.

Ambos fallos se producen antes de ejecutar las pruebas nuevas. No indican que las pruebas del monitor hayan pasado ni que hayan fallado. El archivo `src/narrative-history.ts` pertenece a otro módulo y no se cambia desde este trabajo. El workflow específico ahora incluye `tests/browser/**` en sus filtros para que la modificación del harness HTML vuelva a dispararlo.

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

## Configuración de las métricas visibles del panel

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
