# Registro de desarrollo — Monitoreo en tiempo real mientras escribe el autor

**Módulo:** Live Author Monitor  
**Runtime:** TypeScript / JavaScript  
**Ubicación:** `base de datos/Motor-Literario/typescript/`  
**Rama de integración:** `main`  
**Especificación técnica:** [LIVE_AUTHOR_MONITOR_V0.1.md](../specifications/LIVE_AUTHOR_MONITOR_V0.1.md)

Este documento es el registro acumulativo de cambios del módulo. Cada nueva entrega debe añadir una entrada con alcance, archivos, pruebas, commit y estado de CI. No reemplaza la especificación: registra la evolución verificable del trabajo.

## 1. Alcance y reglas de integración

El monitor registra actividad de escritura y métricas de sesión sin exponer el manuscrito en el panel. La captura debe respetar la secuencia autoritativa del documento, admitir contrapresión y detenerse cuando no puede demostrar coherencia.

Reglas de trabajo del módulo:

- Mantener los cambios en `main` y limitar las modificaciones a los archivos propios de `live-author-monitor*`, sus pruebas y documentación, salvo que una integración anfitriona concreta requiera una modificación revisada.
- Leer la versión actual de cada archivo antes de actualizarla porque otros agentes trabajan en paralelo.
- No modificar `literary-analysis.ts` ni áreas narrativas ajenas a este módulo.
- No inferir operaciones de undo/redo a partir de teclas o eventos DOM ambiguos. El editor anfitrión debe entregar la transacción ya aplicada y su delta exacto.
- No declarar una integración de producción mientras no exista un adaptador conectado al editor real de la aplicación.
- No declarar pruebas aprobadas hasta consultar la ejecución y sus resultados en GitHub Actions.

## 2. Capacidades implementadas

### 2.1 Motor de métricas y actividad

- Sesiones de monitoreo por documento.
- Tiempo de sesión, tiempo activo, tiempo inactivo y pausas detectadas.
- Caracteres insertados/eliminados, ritmo estimado y revisiones.
- Cambios aceptados/rechazados, commits, pendientes y fallos.
- Latencias de guardado y distribución de muestras.
- Suscripción a snapshots y refresco de métricas para panel y workspace.

### 2.2 Captura nativa de textarea

- Captura de `beforeinput` e `input` para representar inserción, pegado, reemplazo y borrado.
- Offsets UTF-16 y secuencias/revisiones consecutivas.
- Manejo de composición IME y actualizaciones provisionales.
- Suspensión y resincronización cuando falta el evento previo, el historial del navegador es ambiguo o el estado del editor no puede verificarse.
- No mantiene una segunda copia permanente del manuscrito.

### 2.3 Entrega FIFO y contrapresión

- Los deltas rechazados o fallidos se conservan en una cola FIFO.
- Los cambios posteriores no adelantan a los anteriores mientras haya backlog.
- Reintento explícito y señal de reintento desde HostEngineApi.
- Estado observable de contrapresión sin publicar el texto del manuscrito.
- El desmontaje se rechaza mientras existan cambios sin admitir.
- El backlog solo puede descartarse después de una resincronización con snapshot autoritativo coincidente.

### 2.4 Historial transaccional del editor

Se incorporaron el contrato `LiveAuthorMonitorEditorTransactionProvider`, la fuente `LiveAuthorMonitorEditorTransactionSource` y la integración `mountLiveAuthorMonitorEditorTransactions`.

El proveedor debe entregar operaciones `edit`, `undo` y `redo` ya aplicadas, con identificador de transacción único y delta exacto. La fuente valida documento, rango, revisión, secuencia, snapshot y duplicados. Mantiene una ventana acotada de IDs y no conserva una copia completa del texto.

### 2.5 Recuperación segura

- Rechaza montaje si editor y motor no comparten un snapshot idéntico.
- Pausa el stream ante errores no recuperables o imposibilidad de leer el snapshot.
- Reactiva la suscripción solo después de validar un snapshot común.
- Descarta el backlog anterior antes de reactivar al proveedor, para no eliminar transacciones nuevas reproducidas sincrónicamente durante la suscripción.
- Protege el cierre del adaptador cuando existen deltas no admitidos.

### 2.6 Panel y workspace

El panel por documento y el workspace multi-documento muestran métricas del snapshot, incluidos tiempo en pausa y cantidad de pausas. Las vistas no leen ni transmiten el contenido del manuscrito.

### 2.7 Reentrada y límites de memoria

Se implementó procesamiento serializado de transacciones y despacho FIFO para que, durante una notificación de secuencia N, todos los consumidores observen el estado N. Una transacción generada de forma reentrante se procesa después de terminar la notificación actual.

La cola reentrante se limita con `maxQueuedTransactions`:

- Predeterminado: 4096.
- Rango permitido: 1 a 65536, entero seguro.
- Al superar el límite se emite `transaction-backlog-overflow`, se suspende la fuente y se requiere resincronización. No se sigue aceptando una cola ilimitada ni se descarta el evento de forma silenciosa.

## 3. Registro de entregas verificadas

| Entrega | Cambio principal | Evidencia |
|---|---|---|
| Núcleo inicial | Métricas por documento, sesión y latencia; integración con HostEngineApi | Código `live-author-monitor.ts`, panel, workspace y pruebas del módulo |
| Captura textarea | Eventos de entrada, offsets UTF-16, composición IME y recuperación | `live-author-monitor-textarea-source.ts` y pruebas dedicadas |
| Backpressure | Cola FIFO, reintentos, estados de contrapresión y protección de desmontaje | `live-author-monitor-change-binding.ts` y pruebas del binding/adaptadores |
| Historial nativo | Contrato transaccional para edición, undo y redo | [Commit de integración transaccional](https://github.com/jmpixelapp-jpg/desarrollo/commit/fcd7cbeb40b4cd5513c38265a3747f4f10eae074) |
| Recuperación/replay | Limpieza de backlog viejo antes de reactivar el proveedor; conserva eventos nuevos durante la resuscripción | [Commit de regresión del replay](https://github.com/jmpixelapp-jpg/desarrollo/commit/d3c86ba687b1f758cf64ca7626aa9b75b7c9aeb6) |
| Desmontaje protegido | Impide cerrar adaptadores con deltas sin admitir | [Commit documentado](https://github.com/jmpixelapp-jpg/desarrollo/commit/8b180d19c6542df8a48a666491321df8dd38c0b6) |
| Cola reentrante | Serializa callbacks para que todos los suscriptores reciban los cambios en el mismo orden | [Commit de despacho FIFO](https://github.com/jmpixelapp-jpg/desarrollo/commit/db782e0146f6108bc8f305c4127fd76383570776) |
| Estado coherente | Serializa también el procesamiento; el estado consultado dentro de un callback no se adelanta | [Commit de procesamiento serializado](https://github.com/jmpixelapp-jpg/desarrollo/commit/5f2f08d2eead87a5269197f089d0b3f8b4ed671b) |
| Cola limitada | Límite configurable, error explícito y pausa segura ante desbordamiento | [Commit de límite de cola](https://github.com/jmpixelapp-jpg/desarrollo/commit/cfb1b9a1d2139fd68ed5f9f88ef3b9d60f4c4e18) |
| Prueba de desbordamiento | Comprueba la pausa y retirada de suscripción cuando se rebasa el límite | [Commit de prueba](https://github.com/jmpixelapp-jpg/desarrollo/commit/9ffbd131420b714a7f28587c887838a74ea6352f) |

## 4. Validaciones de CI

Las siguientes son ejecuciones observadas, no estimaciones:

| Ejecución | Commit probado | Resultado |
|---|---|---|
| [45719287374](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45719287374) | Integración textarea/IME | Build y 69 pruebas aprobadas |
| [45719731344](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45719731344) | Recuperación de lifecycle y snapshot | Se informó build correcto y 72 pruebas aprobadas |
| [45720544576](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45720544576) | Desmontaje protegido | Se informó build correcto y 74 pruebas aprobadas |
| [45720849538](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45720849538) | Replay síncrono al resincronizar | Se informó build correcto y 75 pruebas aprobadas |
| [45721171012](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45721171012) | Despacho FIFO reentrante | Ejecución específica exitosa |
| [45721420996](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45721420996) | Procesamiento y estado coherente ante reentrada | Build correcto; 76 pruebas aprobadas, 0 fallidas, 0 omitidas |
| [45721545786](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45721545786) | Cola reentrante limitada | Build correcto; 76 pruebas aprobadas, 0 fallidas, 0 omitidas |
| [45721556577](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45721556577) | Prueba de desbordamiento de cola | Build correcto; 77 pruebas aprobadas, 0 fallidas, 0 omitidas |
| [45721703791](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45721703791) | Validación de configuración de la cola | Build correcto; 78 pruebas aprobadas, 0 fallidas, 0 omitidas |
| [45721849829](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45721849829) | Recuperación completa tras desbordamiento reentrante | Build correcto; 78 pruebas aprobadas, 0 fallidas, 0 omitidas |

**Cobertura más reciente:** el commit `4f74096c8ce17e70a3c88aa1519ec2be81585d38` añade validación del rango de `maxQueuedTransactions` (valores inválidos, límites 1 y 65536 y valor predeterminado). La CI específica [45721703791](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45721703791) terminó correctamente con 78/78 pruebas aprobadas.

## 5. Estado y limitaciones conocidas

### Listo en el motor

- Captura textarea e IME.
- Métricas del monitor y superficies de panel/workspace.
- Binding FIFO, contrapresión, reintentos y cierre protegido.
- Contrato genérico para transacciones nativas de edición, undo y redo.
- Verificación de snapshots, resincronización, replay síncrono, procesamiento serializado y límite de cola reentrante.

### Pendiente de integración de producción

La inspección del árbol TypeScript de la aplicación anfitriona no encontró todavía una implementación concreta del editor de producción ni una API nativa de transacciones de historial a la que conectar el proveedor. Por eso, `LiveAuthorMonitorEditorTransactionProvider` y `mountLiveAuthorMonitorEditorTransactions` son un contrato y una integración genérica probada con editores de prueba; **no se afirma que undo/redo ya esté conectado a la interfaz de producción**.

Para completar esa fase, el anfitrión debe exponer:
1. API de lectura de snapshot local por documento;
2. suscripción a transacciones ya aplicadas, con ID, tipo y delta UTF-16 exacto;
3. cancelación de suscripción y orden garantizado entre actualización del snapshot y notificación.

### CI general

La ejecución general [45721556553](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45721556553) falló en el chequeo de tipos de `src/literary-analysis.ts` (errores en nodos del grafo, predicados nullable, estados de ideas y relaciones causales). El log no señaló los archivos del monitor. Este módulo conserva su workflow aislado para no confundir un bloqueo de otro trabajo paralelo con sus propias pruebas.

## 6. Próximas etapas

1. Conectar el proveedor transaccional al editor anfitrión real, una vez que su API concreta esté disponible.
2. Diseñar recuperación de sesión persistente con identificadores de sesión y snapshots durables, sin guardar el texto en el monitor.
3. Verificar cierres/cambios de capítulo y lifecycle de pestañas en la aplicación anfitriona real.
4. Añadir pruebas integradas de extremo a extremo en el entorno real de edición, además de las pruebas unitarias actuales.
5. Registrar cada nuevo cambio en esta bitácora y en la sección técnica correspondiente antes de darlo por terminado.

---
**Regla de mantenimiento:** toda entrega futura del monitor debe actualizar esta bitácora en el mismo avance que el código y las pruebas, indicar el commit exacto y registrar el enlace/resultado de CI.


## 7. Nueva entrega — validación y registro acumulativo (25 de noviembre de 2026)

**Objetivo:** que el nuevo límite de cola no dependa solo de que el caso de desbordamiento funcione, sino que también rechace de forma temprana cualquier configuración inválida.

**Cambio implementado:** se añadió una prueba que comprueba `0`, negativos, fracciones, valores superiores a 65536, `NaN` e infinito. Los límites 1 y 65536 y el valor predeterminado también se construyen correctamente. La prueba verifica que un constructor rechazado no deje listeners instalados.

**Archivos:**
- `typescript/tests/live-author-monitor-editor-transaction-source.test.mjs`
- `docs/specifications/LIVE_AUTHOR_MONITOR_V0.1.md`, sección 22
- `docs/README.md`, índice de documentación
- Este registro acumulativo

**Commits:** [4f74096 — prueba de validación](https://github.com/jmpixelapp-jpg/desarrollo/commit/4f74096c8ce17e70a3c88aa1519ec2be81585d38), [8420a7b — especificación](https://github.com/jmpixelapp-jpg/desarrollo/commit/8420a7beef44d7197d78c9382b5e6b86a7989628), [b46fc0c — creación de bitácora](https://github.com/jmpixelapp-jpg/desarrollo/commit/b46fc0ce0384e54322f51339d1a4b4bddbea609e), [5a9a70a — índice](https://github.com/jmpixelapp-jpg/desarrollo/commit/5a9a70acc5a64137fd2c0689b7e1409d3f35ba2b).

**Resultado verificado:** la ejecución [45721703791](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45721703791) terminó con build Vite correcto, 78 pruebas aprobadas, 0 fallidas y 0 omitidas.

**CI general:** la ejecución [45721703703](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45721703703) sigue fallando antes de las pruebas generales por errores de TypeScript en `src/literary-analysis.ts`; no son errores reportados en el monitor y ese archivo no se modificó.

A partir de esta entrega, cualquier avance nuevo del monitor debe actualizar esta bitácora en el mismo lote de trabajo que el código y la especificación.


## 8. Nueva entrega — recuperación verificada tras desbordamiento (25 de noviembre de 2026)

**Objetivo:** comprobar que el monitor no solo se pausa con seguridad al rebasar el límite de eventos reentrantes, sino que puede volver a trabajar después de una reconciliación correcta.

**Prueba ampliada:** tras producir una ráfaga superior al límite, el source queda suspendido en la secuencia 1 y se retira del proveedor. La prueba toma el snapshot local del editor, que ya incluye las secuencias 2 y 3, lo pasa por `resynchronize()`, confirma que se reanuda en secuencia 3 y aplica una nueva edición. El monitor captura la secuencia 4. Los consumidores ven `[1, 4]`: los cambios 2 y 3 están cubiertos por el snapshot reconciliado y no se reproducen como deltas desordenados.

**Archivos:** prueba `typescript/tests/live-author-monitor-editor-transaction-source.test.mjs`; especificación técnica sección 23; esta bitácora.

**Commits:** [a9093da — prueba de recuperación tras overflow](https://github.com/jmpixelapp-jpg/desarrollo/commit/a9093daeac9b25bed3b2f5638f5c25fecb6d8efe), [16fcbb3 — documentación técnica de recuperación](https://github.com/jmpixelapp-jpg/desarrollo/commit/16fcbb3a44c74031d993c08c578d3b7449017af3).

**Resultado verificado:** [CI específica 45721849829](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45721849829), build Vite correcto, 78/78 pruebas aprobadas, 0 fallidas y 0 omitidas.

La ejecución general [45721849896](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45721849896), correspondiente al mismo commit `a9093daeac9b25bed3b2f5638f5c25fecb6d8efe`, sigue fallando en `src/literary-analysis.ts` (errores TS2322, TS2677, TS18047 y TS2345). El workflow específico del monitor terminó correctamente; no se modificó el archivo narrativo.



## 9. Nueva entrega — checkpoints persistentes de sesión (25 de noviembre de 2026)

**Objetivo:** conservar las métricas agregadas del autor entre reinicios sin guardar ni duplicar el texto del manuscrito.

**Modelo de checkpoint:** se añadió `StoredLiveAuthorMonitorCheckpoint`, versión 1. Contiene identidad de proyecto/documento/sesión, duraciones activa e inactiva, edad de la última actividad, contadores, revisión/secuencia y la ventana reciente de latencias. No contiene texto, reemplazos, deltas ni tickets pendientes.

**Reglas de seguridad:** el monitor solo crea un checkpoint cuando no existen commits pendientes, la sesión no requiere resincronización y la revisión/secuencia durable coincide con la más reciente. La restauración exige coincidencia exacta de proyecto, documento, longitud, revisión y secuencia. Un checkpoint inválido u obsoleto no bloquea la recuperación del documento: se elimina y se inicia una sesión de métricas nueva.

**Persistencia:** `ProjectStore` tiene operaciones opcionales `save/load/deleteLiveAuthorMonitorCheckpoint`. `IndexedDbProjectStore` implementa el almacenamiento compuesto `live-author-monitor-checkpoints`; la versión IndexedDB aumenta de 22 a 23. La escritura no bloquea el flujo de edición. El tiempo fuera del proceso se suma al tiempo inactivo, nunca al tiempo activo.

**Ciclo de vida del anfitrión:** `HostEngineApi` programa checkpoints después de commits durables y al recuperar documentos; `closeLiveAuthorMonitorDocumentSafely` espera al motor, valida durabilidad, persiste y cierra; `disposeSafely` espera las escrituras programadas antes de liberar la instancia.

**IDs de sesión:** incluyen un nonce para no reutilizar identificadores después de reiniciar la aplicación.

**Archivos modificados en esta entrega:**
- `typescript/src/contracts.ts`: contrato durable y métodos opcionales de `ProjectStore`.
- `typescript/src/live-author-monitor.ts`: creación/restauración de checkpoint y accounting de downtime.
- `typescript/src/persistence/indexeddb-store.ts`: almacén IndexedDB version 23, validación y operaciones CRUD.
- `typescript/src/host-api.ts`: guardado después de commit, recuperación, cierre seguro y disposición segura.
- `typescript/tests/live-author-monitor.test.mjs`: restauración, downtime, mismatch y validación de checkpoint.
- `typescript/tests/live-author-monitor-host-api.test.mjs`: persistencia, recuperación, descarte de checkpoint obsoleto y renovación.
- `.github/workflows/live-author-monitor.yml`: incluye la persistencia IndexedDB en los filtros de CI.
- `docs/specifications/LIVE_AUTHOR_MONITOR_V0.1.md`: sección 24.

**Commits de implementación:** [50f9e5b — contrato de checkpoint](https://github.com/jmpixelapp-jpg/desarrollo/commit/50f9e5b1d811168b01e36e5e357f5751e7196a68), [925f246 — checkpoint en el monitor](https://github.com/jmpixelapp-jpg/desarrollo/commit/925f2465d0589bd32d950bf3c4863d29cea1e0e0), [3233438 — esquema IndexedDB](https://github.com/jmpixelapp-jpg/desarrollo/commit/323343872d4307ea38d1789b971649dd6c44e5a7), [f4f2803 — CRUD IndexedDB](https://github.com/jmpixelapp-jpg/desarrollo/commit/f4f2803dd9614c6a1b94a36e5380c06fa5d4fb5a), [6451748 — integración HostEngineApi](https://github.com/jmpixelapp-jpg/desarrollo/commit/64517483dad494f1f081ab20a248efdf6a9fc1c9), [a6b7946 — espera de checkpoints al cerrar](https://github.com/jmpixelapp-jpg/desarrollo/commit/a6b7946643ab53309b69254a0e5c15008a767cb5), [9711cb9 — contabilidad activa/inactiva](https://github.com/jmpixelapp-jpg/desarrollo/commit/9711cb978fdad81ea8fff865f93d86613aae1836), [f19ee72 — IDs únicos](https://github.com/jmpixelapp-jpg/desarrollo/commit/f19ee72464cbf15171cf938857a7fc66146c2f79), [604780e — pruebas de HostEngineApi](https://github.com/jmpixelapp-jpg/desarrollo/commit/604780e7d245292c3f8a3cf04476f708ba6887bb), [a2e8f26 — checkpoint obsoleto](https://github.com/jmpixelapp-jpg/desarrollo/commit/a2e8f266d88f45ee3842e40f26383ff1b9c0208d), [da638e2 — persistencia automática al disponer](https://github.com/jmpixelapp-jpg/desarrollo/commit/da638e2c835a7e5fcf8b2aa25192d4fea83145c3), [8c25781 — corrección de tipo en onCommit](https://github.com/jmpixelapp-jpg/desarrollo/commit/8c2578174e002a7ba55447a607b5ea07b4a73c61), [456961f — conservar checkpoint ante error de lectura](https://github.com/jmpixelapp-jpg/desarrollo/commit/456961fda617bf513022506fb8730dbc0cc811c9).

**Pruebas añadidas:** cobertura de creación/restauración en `LiveAuthorMonitor`; persistencia vía contrato del almacén, recuperación de un documento con métricas anteriores, descarte de checkpoint obsoleto y persistencia automática al disponer de forma segura.

**CI específica verificada:** [45722890027](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45722890027), commit `8c2578174e002a7ba55447a607b5ea07b4a73c61`: build Vite correcto; **84/84 pruebas aprobadas, 0 fallidas y 0 omitidas**. Incluye los casos de persistencia automática y recuperación de checkpoints obsoletos. La validación de tipos general [45722890012](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45722890012) ya no reporta errores en los archivos del monitor, contratos, HostEngineApi ni IndexedDB; permanece bloqueada exclusivamente por errores TS2322, TS2677, TS18047 y TS2345 en `src/literary-analysis.ts`. Una ejecución intermedia detectó el error de tipo `CommitResult.documentId`, que fue corregido en `8c25781`.

**Limitación pendiente:** IndexedDB guarda los checkpoints por proyecto/documento, pero todavía no se implementó lease/fencing token entre dos pestañas que editen simultáneamente el mismo documento. Esto no sustituye el journal durable del manuscrito ni ofrece sincronización multi-pestaña de métricas.


## 10. Nueva entrega — errores de checkpoint en cierre seguro (25 de noviembre de 2026)

**Objetivo:** distinguir entre guardado automático no bloqueante y confirmación explícita de persistencia durante el cierre de la aplicación.

**Cambio:** los fallos de escritura del checkpoint ahora permanecen registrados por documento hasta que una escritura posterior finalice correctamente. Los callbacks del motor siguen aislados: el autor puede continuar escribiendo aunque IndexedDB esté temporalmente indisponible. En cambio, `closeLiveAuthorMonitorDocumentSafely` y `disposeSafely` esperan las operaciones pendientes y no anuncian un cierre seguro si queda un error de persistencia sin resolver.

**Prueba añadida:** un almacén de prueba fuerza `quota_exceeded`; la llamada a `disposeSafely()` debe rechazar la operación y la sesión de métricas debe seguir disponible en memoria. Se comprueba que no hay desmontaje silencioso tras un guardado fallido.

**Archivos:**
- `typescript/src/host-api.ts`: retención del error por documento, retry posterior y propagación al lifecycle seguro.
- `typescript/tests/live-author-monitor-host-api.test.mjs`: regresión de fallo de almacenamiento.
- `docs/specifications/LIVE_AUTHOR_MONITOR_V0.1.md`: sección 25.

**Commits:** [5db2c51 — propagar fallos de checkpoint](https://github.com/jmpixelapp-jpg/desarrollo/commit/5db2c51a7e8981b0f24e300c8e931beb2d27852f), [a260ca4 — retener error hasta escritura correcta](https://github.com/jmpixelapp-jpg/desarrollo/commit/a260ca486c835a8f06b616a3709a269c564df3d0), [dde974d — prueba de no desmontaje](https://github.com/jmpixelapp-jpg/desarrollo/commit/dde974d98cd5b0c9b9dacc9c86a35ab26e4b0d95), [e4011c1 — especificación del lifecycle](https://github.com/jmpixelapp-jpg/desarrollo/commit/e4011c1686fd6c91006bea93d1dc2f1154341af8).

**Resultado verificado:** CI aislada [45723191692](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45723191692): build Vite correcto; **85/85 pruebas aprobadas, 0 fallidas y 0 omitidas**. La CI general [45723191936](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45723191936) sigue fallando solo por errores TS2322, TS2677, TS18047 y TS2345 en `src/literary-analysis.ts`; no reporta errores del módulo del monitor ni de IndexedDB.


## 11. Nueva entrega — manifiesto físico y auditoría del checkpoint IndexedDB (25 de noviembre de 2026)

**Hallazgo:** el adaptador IndexedDB ya creaba `live-author-monitor-checkpoints` y utilizaba la base versión 23, pero el manifiesto activo `storage_mapping_v0.4.2.json` todavía declaraba versión 22 y no describía este almacén operativo. El audit script ya apuntaba a v0.4.2, mientras una prueba leía de forma obsoleta v0.4.1 y esperaba 24 tablas.

**Corrección del alcance:** se preservó el manifiesto histórico `storage_mapping_v0.4.1.json` sin cambios. La definición actualizada se aplicó al manifiesto activo `storage_mapping_v0.4.2.json`. El audit estático confirma que el almacén y sus índices también figuran en la rutina `ensureIndex` de las migraciones.

**Cambios:**
- Se actualizó `runtime.database_version` de 22 a 23 en el manifiesto activo y `mapping_version` de 12 a 13.
- Se agregó el descriptor `live-author-monitor-checkpoints`, keyPath compuesto `[projectId, documentId]` e índice `by-project`.
- Se corrigió la prueba de auditoría para leer v0.4.2 y comparar dinámicamente la cantidad de tablas; ya no depende del literal de versión 21 ni de un número de tablas obsoleto.
- El workflow aislado ejecuta `npm run validate:schema` antes del build y las pruebas, y ejecuta además `tests/storage-implementation-audit.test.mjs`.
- Los filtros de push y pull request incluyen el manifiesto activo, el adaptador IndexedDB y la prueba de auditoría.

**Commits:** [daa6f22 — restaurar el manifiesto histórico v0.4.1](https://github.com/jmpixelapp-jpg/desarrollo/commit/daa6f22e40aa32787db80094a339a65d0015ee09), [32b1ebf — registrar almacén y versión en v0.4.2](https://github.com/jmpixelapp-jpg/desarrollo/commit/32b1ebf148658190637de8ecdf1bae42f4d89172), [2eec62d — alinear prueba con v0.4.2](https://github.com/jmpixelapp-jpg/desarrollo/commit/2eec62d0ff03ab15d2057a4868f348e9055642ea), [85e4b42 — validar manifiesto activo en CI](https://github.com/jmpixelapp-jpg/desarrollo/commit/85e4b42546d7ef7ba281c37eee8c998e2a8f316a).

**Ejecuciones anteriores:** las ejecuciones [45723541249](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45723541249) y [45723473909](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45723473909) fallaron porque sus commits todavía auditaban el manifiesto anterior al ajuste del manifiesto activo. No se toman como validación de esta corrección. La nueva ejecución debe probar el commit posterior a `85e4b42` y correr tanto validación física como las pruebas.

**Resultado verificado:** CI específica [45723969106](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45723969106) aprobó esquema y auditoría física (25 tablas del motor, 33 almacenes), build Vite y 98/98 pruebas después de alinear manifiesto, índices y tests de auditoría.


**Corrección adicional del audit estático:** `audit-storage-implementation.mjs` deriva los índices esperados desde las llamadas `ensureIndex` de la rutina de migración, no solamente desde los `createIndex` que se ejecutan al crear el almacén. Se añadió `ensureIndex(LIVE_AUTHOR_MONITOR_CHECKPOINTS, "by-project", "projectId")` para que el índice permanezca declarado y se valide también en las migraciones. Commit: [c83e27f — registrar índice del checkpoint en migraciones](https://github.com/jmpixelapp-jpg/desarrollo/commit/c83e27f5721c7fe774ecdd2cb119b02d88575d9a). La nueva ejecución de CI está en curso; el resultado se añadirá cuando concluya.


## 12. Nueva entrega — prueba de persistencia del adaptador IndexedDB (25 de noviembre de 2026)

**Objetivo:** verificar las operaciones reales del adaptador de checkpoints, no limitar la confianza a un almacén simulado usado por las pruebas de HostEngineApi.

**Implementación:** se añadió `IndexedDbProjectStore.close()`. Espera a que finalice una apertura pendiente, cierra la conexión y libera el canal de notificaciones de la instancia; las operaciones posteriores pueden abrir nuevamente la base.

**Prueba de runtime:** nuevo archivo `typescript/tests/live-author-monitor-indexeddb.test.mjs`. Usa `fake-indexeddb@6.2.8`, dependencia solo de desarrollo, para instalar la API IndexedDB en memoria en Node. La prueba ejercita:
- guardar y recuperar un checkpoint;
- comprobar aislamiento de objetos y muestras de latencia;
- rechazar timestamps antiguos;
- sustituir con un checkpoint más reciente;
- aislar otro proyecto;
- eliminar el registro y confirmar que ya no existe;
- cerrar la conexión en el bloque `finally`.

**Transparencia de alcance:** `fake-indexeddb` replica la API en memoria; no es IndexedDB nativo de un navegador y no conserva datos entre procesos. Esta prueba valida el comportamiento del adaptador y sus transacciones, pero queda pendiente una prueba E2E en navegador para confirmar persistencia física entre reinicios.

**Archivos:** `typescript/src/persistence/indexeddb-store.ts`, `typescript/tests/live-author-monitor-indexeddb.test.mjs`, `typescript/package.json`, `docs/specifications/LIVE_AUTHOR_MONITOR_V0.1.md`.

**Commits:** [a552b00 — lifecycle explícito de IndexedDB](https://github.com/jmpixelapp-jpg/desarrollo/commit/a552b009902206357502bd78099baea028f6e0b2), [273e0b9 — prueba de operaciones de checkpoint](https://github.com/jmpixelapp-jpg/desarrollo/commit/273e0b9ec2493b12dca2dfbf1d82bf2cd775df4c), [64bbebe — dependencia de prueba](https://github.com/jmpixelapp-jpg/desarrollo/commit/64bbebeab6bee38d1910932b877d2d9f79d332fe), [2dca17b — polyfill en el test](https://github.com/jmpixelapp-jpg/desarrollo/commit/2dca17b54eb2454026a298a6409f325e6dd1035e).

**Validación verificada:** CI específica [45724325962](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45724325962), commit `2dca17b54eb2454026a298a6409f325e6dd1035e`: MLDB 0.4.2 válido, auditoría física correcta (25 tablas, 33 almacenes), build Vite y **99/99 pruebas aprobadas, 0 fallidas y 0 omitidas**. La primera prueba sin polyfill falló porque el runner Node no expuso `indexedDB` global; `fake-indexeddb/auto` resolvió ese límite en la prueba, sin cambiar el runtime de producción. La CI general [45724345892](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45724345892) continúa fallando exclusivamente en `src/literary-analysis.ts` por errores TS2322, TS2677, TS18047 y TS2345; no reporta errores en el monitor ni en IndexedDB.

**Ampliación de la prueba de migración:** el test ahora crea una base v22 con los almacenes existentes, inserta un documento, dispara la migración a v23, verifica el nuevo almacén/keyPath/índice, persiste un checkpoint y confirma que el documento previo no perdió texto ni revisión. Commit: [623a339 — probar la migración v22 a v23](https://github.com/jmpixelapp-jpg/desarrollo/commit/623a3397588ca135ab781d0a0a597a2f7ef53958).

**Resultado CI actualizado:** ejecución [45724540335](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45724540335), commit `623a3397588ca135ab781d0a0a597a2f7ef53958`: schema 0.4.2 válido, 25 tablas del motor y 33 almacenes físicos, build Vite correcto y **100/100 pruebas aprobadas, 0 fallidas y 0 omitidas**. La validación global [45724540283](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45724540283) sigue fallando solo por los errores TS2322, TS2677, TS18047 y TS2345 en `src/literary-analysis.ts`; el log no reporta errores del monitor, HostEngineApi, contratos ni IndexedDB.


## 13. Nueva entrega — migración IndexedDB v22 a v23 (25 de noviembre de 2026)

**Objetivo:** verificar que la incorporación del almacén de checkpoints no elimina ni altera documentos existentes durante la actualización de la base local.

**Prueba añadida:** live-author-monitor-indexeddb.test.mjs crea una base v22 con todos los almacenes previos del manifiesto, guarda un documento antes de la migración y abre la base con IndexedDbProjectStore, provocando el upgrade a v23. Comprueba que la base termina en versión 23, que el almacén de checkpoints tiene la keyPath compuesta correcta y el índice by-project, que el checkpoint se puede escribir y leer y que el documento previo conserva su texto/revisión.

**Archivos:** typescript/tests/live-author-monitor-indexeddb.test.mjs; se amplía la cobertura de la sección 27 y añade la sección 28 de la especificación.

**Commit:** [623a339 — prueba de migración v22 a v23](https://github.com/jmpixelapp-jpg/desarrollo/commit/623a3397588ca135ab781d0a0a597a2f7ef53958).

**Resultado verificado:** CI aislada [45724540335](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45724540335), build Vite correcto, MLDB 0.4.2 válido, auditoría física correcta (25 tablas, 33 almacenes) y **100/100 pruebas aprobadas, 0 fallidas, 0 omitidas**.

**Límite:** el escenario utiliza fake-indexeddb en memoria. La prueba de navegador real con cierre/reapertura física sigue pendiente.



## 14. Nueva entrega — reapertura del almacén tras cierre explícito (25 de noviembre de 2026)

**Objetivo:** demostrar que IndexedDbProjectStore.close() libera la conexión, pero no inutiliza la instancia ni pierde los checkpoints ya escritos.

**Prueba ampliada:** tras guardar y actualizar un checkpoint, el test cierra la conexión; a continuación usa la misma instancia para leer el checkpoint. La siguiente operación debe abrir una conexión nueva y devolver datos idénticos. Después borra el checkpoint y comprueba que ya no existe. El caso de migración v22→v23 también sigue incluido en el mismo archivo.

**Archivo:** typescript/tests/live-author-monitor-indexeddb.test.mjs.

**Commit:** [1a48078 — probar reapertura tras close()](https://github.com/jmpixelapp-jpg/desarrollo/commit/1a48078743c450bb7c90e4dd78c75b1eac902fbc).

**Resultado verificado:** CI aislada [45724732118](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45724732118), build Vite correcto, esquema 0.4.2 válido, auditoría física correcta (25 tablas, 33 almacenes) y 100/100 pruebas aprobadas, 0 fallidas, 0 omitidas.

**Límite:** fake-indexeddb valida el comportamiento del adaptador en memoria; la prueba de navegador real con almacenamiento físico y reinicio del navegador sigue pendiente.



## 15. Nueva entrega — rechazo de checkpoints atrasados y protección de métricas monotónicas (25 de noviembre de 2026)

**Objetivo:** evitar que una pestaña o instancia con una escritura retrasada sobrescriba métricas más avanzadas solo porque su reloj local produjo un timestamp mayor.

**Implementación:** la transacción readwrite de IndexedDbProjectStore ahora valida el checkpoint existente y rechaza candidatos con revisión/secuencia anteriores. Si ambos usan la misma sessionId, exige que duraciones acumuladas, pausas, contadores aceptados/rechazados/commit/fallo, caracteres acumulados, resincronizaciones y latencia total no retrocedan. Una nueva sessionId puede reiniciar las métricas sobre el mismo snapshot durable si el timestamp avanza y no disminuyen revisión/secuencia.

**Pruebas añadidas:** una escritura con timestamp nuevo pero revisión/secuencia antigua es rechazada; también se rechazan métricas regresivas en la misma sesión. Se verifica que el checkpoint previo permanece intacto y que una nueva identidad puede sustituirlo sin retroceder el snapshot.

**Archivos:** typescript/src/persistence/indexeddb-store.ts; typescript/tests/live-author-monitor-indexeddb.test.mjs; sección 30 de la especificación.

**Commits:** [b16f048 — bloquear checkpoints atrasados](https://github.com/jmpixelapp-jpg/desarrollo/commit/b16f048cf38cc07f22a0e7f15021347509794d9d), [8a58427 — pruebas de orden y métricas monotónicas](https://github.com/jmpixelapp-jpg/desarrollo/commit/8a584270842aca3d65f635a5b4ec0bd98ad84038).

**Resultado verificado:** CI específica [45724891204](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45724891204): auditoría de MLDB y almacenes válida, build Vite y **102/102 pruebas aprobadas, 0 fallidas, 0 omitidas**.

**Limitación:** esta protección de escritura no es un lease de edición ni sincroniza cursores/operaciones entre dos editores concurrentes. Impide regresiones del checkpoint, pero no sustituye la coordinación del journal durable.



## 16. Nueva entrega — reserva de titularidad entre pestañas con fencing token (26 de noviembre de 2026)

**Objetivo:** impedir que dos instancias del monitor publiquen checkpoints compartidos en paralelo y, especialmente, evitar que una pestaña antigua sobrescriba métricas después de que otra haya tomado la titularidad.

**Esquema:** IndexedDB sube de v23 a **v24**. El manifiesto activo `storage_mapping_v0.4.2.json` sube a `mapping_version: 14` y registra `live-author-monitor-leases`, keyPath `[projectId, documentId]`, índice `by-project`. El almacén de checkpoints permanece separado.

**Contrato:** `StoredLiveAuthorMonitorLease` guarda identidad de proyecto/documento, ownerId de la instancia, fencingToken creciente, acquiredAt, expiresAt y updatedAt. `ProjectStore` define acquire/renew/release; `saveLiveAuthorMonitorCheckpoint` recibe también el lease.

**Persistencia atómica:** la adquisición, renovación y liberación se serializan con transacciones IndexedDB readwrite. La escritura del checkpoint abre una única transacción que incluye ambos almacenes, vuelve a leer el lease actual y compara ownerId/token/expiración antes de escribir. La fila liberada se conserva como expirada para que el próximo dueño reciba un token superior.

**HostEngineApi:** genera un ownerId por instancia, adquiere titularidad al abrir/recuperar el documento, renueva cada 10 segundos con TTL de 30 segundos, restaura/publica métricas solo cuando es titular y reintenta la adquisición en el próximo punto seguro de checkpoint o al cerrar. `closeLiveAuthorMonitorDocumentSafely()` y `disposeSafely()` guardan el estado final y liberan la reserva. Si la transacción de liberación falla, el anfitrión conserva su lease local y reanuda el heartbeat para permitir el reintento.

**Pruebas añadidas/ampliadas:** actualización de IndexedDB v22 a v24 preservando el documento previo y creando los dos almacenes nuevos; competencia atómica entre pestañas; renovación; incremento del fencing token; rechazo de escritura de un token anterior; continuidad con snapshot de lease local antiguo tras renovación; handoff entre dos HostEngineApi; y reintento si falla la transacción de liberación.

**Archivos:** `typescript/src/contracts.ts`, `typescript/src/persistence/indexeddb-store.ts`, `typescript/src/host-api.ts`, `typescript/tests/live-author-monitor-indexeddb.test.mjs`, `typescript/tests/live-author-monitor-host-api.test.mjs`, `MLDB/storage_mapping_v0.4.2.json`, `docs/specifications/LIVE_AUTHOR_MONITOR_V0.1.md`.

**Commits principales:** [f8b1432 — contrato de lease](https://github.com/jmpixelapp-jpg/desarrollo/commit/f8b14322da2727d4673320e3059f6e59e8d8e6e4), [8b1f6dd — almacén IndexedDB](https://github.com/jmpixelapp-jpg/desarrollo/commit/8b1f6ddb5421d1c5c044233736481ea7e700eb55), [fa2aa4a — operaciones atómicas de lease](https://github.com/jmpixelapp-jpg/desarrollo/commit/fa2aa4a3db4325dcbc6c37be51f567f0ced7c458), [1777b28 — fencing de checkpoints](https://github.com/jmpixelapp-jpg/desarrollo/commit/1777b28da2229530fbb9f365b7eac5e484f1d02c), [324f94b — mapeo MLDB v24](https://github.com/jmpixelapp-jpg/desarrollo/commit/324f94b76dc8ef8c6731aa7d65692846ce8f5b22), [eb69a53 — integración HostEngineApi](https://github.com/jmpixelapp-jpg/desarrollo/commit/eb69a53a0a09a812d7a48fb54611bf9fd4db2973), [d54c085 — handoff en siguiente punto seguro](https://github.com/jmpixelapp-jpg/desarrollo/commit/d54c085d3f0217bc9403bf815603b22be7c3f402), [9091ee7 — prueba de handoff entre pestañas](https://github.com/jmpixelapp-jpg/desarrollo/commit/9091ee77c28973fa610bc0161595f81f74d04074), [da8bc4f — snapshot de lease renovado](https://github.com/jmpixelapp-jpg/desarrollo/commit/da8bc4f023c58145a4be179fb97c99bd17a7515c), [5d1919a — retener lease ante fallo de liberación](https://github.com/jmpixelapp-jpg/desarrollo/commit/5d1919acd9eb13bfe0eb3cfd6fd23e024448f399), [56f7269 — prueba de reintento de liberación](https://github.com/jmpixelapp-jpg/desarrollo/commit/56f7269ba27afcd1883c3232c0968eef19ba76f2).

**Resultado final verificado:** CI específica [45726102805](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45726102805), commit `56f7269ba27afcd1883c3232c0968eef19ba76f2`: build Vite correcto, MLDB 0.4.2 válido, auditoría física correcta (25 tablas, 34 almacenes) y **107/107 pruebas aprobadas, 0 fallidas, 0 omitidas**. Incluye la prueba de fallo temporal al liberar y reintento exitoso de la misma instancia.

**CI general:** [45726102624](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45726102624) sigue fallando exclusivamente por errores TypeScript en `src/literary-analysis.ts` (TS2322, TS2677, TS18047 y TS2345); no reporta errores en el monitor, contratos, HostEngineApi o IndexedDB.

**Límites:** el lease coordina checkpoints de métricas, no bloquea ni sincroniza la edición del manuscrito. La prueba usa `fake-indexeddb` en memoria; la validación E2E en navegador real sigue pendiente. Los almacenes de anfitrión antiguos sin los métodos de lease mantienen compatibilidad, pero carecen de fencing multi-pestaña.



## 17. Nueva entrega — E2E real de dos pestañas Chromium (26 de noviembre de 2026)

**Objetivo:** verificar la contienda, liberación, takeover y fencing del lease sobre IndexedDB real del navegador, no solo sobre el polyfill de Node.

**Harness y test:**
- `typescript/tests/browser/live-author-monitor-lease.html`: fixture exclusiva de tests que carga `IndexedDbProjectStore` desde Vite. No forma parte de la UI ni del bundle de producción.
- `typescript/tests/live-author-monitor-browser.test.mjs`: inicia Vite, lanza Chromium con Playwright y abre dos páginas del mismo origen, con instancias independientes del store.
- Las páginas compiten por el mismo lease; exactamente una gana. La página perdedora no puede adquirir mientras el lease está activo. Tras la liberación, esa página recibe un fencing token superior; el token anterior es rechazado y la página antigua puede leer el checkpoint que guardó la nueva titular.
- El workflow `.github/workflows/live-author-monitor.yml` instala Chromium usando `npx playwright install --with-deps chromium` antes de ejecutar las pruebas.

**Dependencia:** Playwright `1.65.1` añadida en `typescript/package.json` como dependencia de desarrollo.

**Archivos:** `typescript/package.json`, `.github/workflows/live-author-monitor.yml`, `typescript/tests/browser/live-author-monitor-lease.html`, `typescript/tests/live-author-monitor-browser.test.mjs`, sección 32 de la especificación.

**Commits:** [6dc6e2d — Playwright para E2E](https://github.com/jmpixelapp-jpg/desarrollo/commit/6dc6e2de0a95afc7baa31a340e579e39b8daac41), [1aced3d — instalar Chromium en CI](https://github.com/jmpixelapp-jpg/desarrollo/commit/1aced3d1053a74b1a09123bf129b25ed53287848), [42b8e9d — fixture de navegador](https://github.com/jmpixelapp-jpg/desarrollo/commit/42b8e9df2eeb13a04b62da1b737e957f9c89a31c), [0d1448e — prueba E2E de dos pestañas](https://github.com/jmpixelapp-jpg/desarrollo/commit/0d1448e8aa1d635cdd4cee8568c4b19e74738729).

**Resultado verificado:** CI específica [45726598052](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45726598052), build Vite correcto, esquema MLDB 0.4.2 válido, auditoría física de 25 tablas y 34 almacenes y **108/108 pruebas aprobadas, 0 fallidas, 0 omitidas**. Incluye la prueba Chromium sobre dos páginas con IndexedDB del navegador.

**CI general:** [45726594065](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45726594065) sigue señalando únicamente errores TS2322, TS2677, TS18047 y TS2345 en `src/literary-analysis.ts`; no reporta errores de monitor ni de IndexedDB.

**Límite de producción:** el harness E2E no es una UI de escritura. El repositorio no contiene un editor anfitrión concreto ni su historial de transacciones, de modo que aún no se puede conectar `LiveAuthorMonitorEditorTransactionProvider` a eventos nativos de edición/undo/redo. Mantener la fuente textarea en modo resync para `historyUndo/historyRedo` sigue siendo más seguro que inferir deltas desde DOM.



## 18. Ampliación E2E — persistencia tras recargar la página (26 de noviembre de 2026)

Se amplió `live-author-monitor-browser.test.mjs`: tras el takeover y guardado del checkpoint en la segunda página, esta página se recarga. El reload elimina su contexto JavaScript y crea un nuevo IndexedDbProjectStore; el test vuelve a leer el checkpoint compartido y verifica que los datos permanecen intactos. Así se cubre la continuidad del almacenamiento entre instancias del adaptador en una misma sesión/perfil Chromium.

**Commit:** [702846e — probar checkpoint tras reload](https://github.com/jmpixelapp-jpg/desarrollo/commit/702846e433654611343fbfc143b0b0ea2475d2a5).

**Resultado CI verificado:** [45726777208](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45726777208), commit `702846e433654611343fbfc143b0b0ea2475d2a5`: build Vite correcto, MLDB 0.4.2 válido, auditoría física correcta (25 tablas, 34 almacenes) y **108/108 pruebas aprobadas, 0 fallidas, 0 omitidas**. Incluye la recarga real de una página Chromium y recuperación del checkpoint tras instanciar de nuevo el adaptador.



## 19. Nueva entrega — carreras de heartbeat, dispose terminal y recuperación por expiración (26 de noviembre de 2026)

**Objetivo:** evitar que callbacks asíncronos del lease restauren titularidad después del cierre y evitar que las pestañas observadoras queden esperando indefinidamente si la pestaña propietaria desaparece sin liberar.

**Correcciones del HostEngineApi:**
- las generaciones de heartbeat usan identidad de objeto, invalidada antes de una liberación; una respuesta tardía se ignora si cambió la generación, el owner/fencing token o el estado del ciclo de vida;
- se impide que un heartbeat solapado ejecute más de una renovación simultánea por documento;
- `dispose()` pasa a ser terminal e idempotente; si una adquisición iniciada previamente se confirma después de dispose, el anfitrión la libera sin instalar un heartbeat;
- las pestañas observadoras conservan un heartbeat de sondeo a 10 s incluso sin lease. Al vencer la reserva de 30 s de una pestaña caída, adquieren el token siguiente sin depender de una nueva pulsación del autor.

**Pruebas añadidas:** renovación demorada que vuelve después del cierre seguro; dispose durante adquisición pendiente y confirmación posterior del lease; toma automática de titularidad por una pestaña observadora después de expirar el TTL sin release del propietario anterior.

**Archivos:** `typescript/src/host-api.ts`, `typescript/tests/live-author-monitor-host-api.test.mjs`; especificación sección 33.

**Commits:** [50f09f4 — corregir comparación de generación](https://github.com/jmpixelapp-jpg/desarrollo/commit/50f09f460819f328dafceca2dbb5fb9e474c61c3), [4d378f9 — proteger heartbeat tras liberación](https://github.com/jmpixelapp-jpg/desarrollo/commit/4d378f9eedb3424cb915cf6ff2cbdc38fd231681), [5216f80 — probar respuesta tardía](https://github.com/jmpixelapp-jpg/desarrollo/commit/5216f80ca42886dd76e1194ea3bc3481c92dd7c5), [ddf5950 — dispose terminal](https://github.com/jmpixelapp-jpg/desarrollo/commit/ddf595034ece884d3a403ebb33cfa72b7d328df0), [f9bf957 — probar adquisición durante dispose](https://github.com/jmpixelapp-jpg/desarrollo/commit/f9bf957fea18998c6d78858a7534db5f9a8f4cff), [cc270c6 — recuperar tras expiración](https://github.com/jmpixelapp-jpg/desarrollo/commit/cc270c62f1f892e06455b0f9c0f9cde5a8371344), [2f78c0b — probar takeover automático](https://github.com/jmpixelapp-jpg/desarrollo/commit/2f78c0b542b8146a8924b5b980c05cc090ddc986).

**Resultado verificado:** CI específica [45727622443](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45727622443), build Vite correcto, MLDB 0.4.2 válido, auditoría de 25 tablas/34 almacenes y **112/112 pruebas aprobadas, 0 fallidas, 0 omitidas**.

**CI general:** [45727622233](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45727622233) solo reporta errores TS2322, TS2677, TS18047 y TS2345 en `src/literary-analysis.ts`, fuera del alcance del monitor.

**Alcance:** la recuperación al expirar protege únicamente la titularidad del checkpoint de métricas. No resuelve conflictos de edición concurrente ni sincroniza los textos locales de dos editores; el journal y el motor anfitrión siguen siendo la autoridad del manuscrito.



## 20. Nueva entrega — cancelar restauración cuando dispose() gana la carrera (26 de noviembre de 2026)

**Objetivo:** impedir que la lectura asíncrona de un checkpoint restaure o reabra métricas después de que el HostEngineApi ya fue dispuesto.

**Implementación:** después de `loadLiveAuthorMonitorCheckpoint`, `afterDocumentRecovery` vuelve a comprobar `disposed` antes de ejecutar `restoreCheckpoint()` o `openDocument()` del monitor. Si el cierre ganó la carrera, abandona la restauración.

**Regresión:** un store de prueba demora intencionadamente la lectura. La prueba inicia `recoverDocument`, dispone el HostEngineApi mientras la promesa sigue pendiente, libera después la lectura y confirma que no reaparecen el snapshot del monitor ni el heartbeat.

**Archivos:** `typescript/src/host-api.ts`, `typescript/tests/live-author-monitor-host-api.test.mjs`, especificación sección 34.

**Commits:** [e1ce19c — detener restauración tras dispose](https://github.com/jmpixelapp-jpg/desarrollo/commit/e1ce19ceffc9675dd03ed3ca42979f52b80e7f25), [351f223 — probar lectura de checkpoint en carrera con dispose](https://github.com/jmpixelapp-jpg/desarrollo/commit/351f2232822a8a7005ff5df7675f044537db7cab).

**Resultado verificado:** CI específica [45727834409](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45727834409): build Vite correcto, MLDB 0.4.2 válido, auditoría de 25 tablas y 34 almacenes y **113/113 pruebas aprobadas, 0 fallidas, 0 omitidas**.

**CI general:** [45727834577](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45727834577) sigue fallando exclusivamente por errores TS2322, TS2677, TS18047 y TS2345 en `src/literary-analysis.ts`; no reporta errores en el módulo de monitoreo.



## 21. Nueva entrega — proveedor transaccional reusable y validación ligera (26 de noviembre de 2026)

**Objetivo:** simplificar la conexión del editor anfitrión y evitar lecturas completas del texto en cada evento de escritura.

**Implementación:**
- Nuevo `LiveAuthorMonitorEditorTransactionBridge`, proveedor reusable con lectores nativos de snapshot/metadatos y publicación explícita de transacciones aplicadas.
- El contrato `LiveAuthorMonitorEditorTransactionProvider` admite `getDocumentState(documentId)` con revisión, secuencia y longitud UTF-16. El source lo usa por transacción; `getSnapshot` queda para montaje y resincronización. Se conserva fallback compatible para proveedores antiguos.
- El puente protege el orden de entrega mediante cola FIFO incluso ante publicaciones reentrantes, captura los listeners asociados a cada publicación y aísla errores de cada suscriptor.
- Export público desde `src/index.ts`.
- Nueva guía de integración para el editor anfitrión, con reglas para deltas, undo/redo, transacciones compuestas, backpressure y cierre.

**Pruebas:** metadata-only por transacción sin lectura del manuscrito completo; metadatos inválidos; edit/undo/redo a través del puente; listeners que fallan; aislamiento por documento; FIFO reentrante; disposer idempotente.

**Archivos:** `typescript/src/live-author-monitor-editor-transaction-source.ts`, `typescript/src/live-author-monitor-editor-transaction-bridge.ts`, `typescript/src/index.ts`, `typescript/tests/live-author-monitor-editor-transaction-source.test.mjs`, `typescript/tests/live-author-monitor-editor-transaction-bridge.test.mjs`, `docs/development/LIVE_AUTHOR_MONITOR_EDITOR_ADAPTER_GUIDE.md`.

**Commits:** [7b1fe0b — validación por metadatos](https://github.com/jmpixelapp-jpg/desarrollo/commit/7b1fe0b95eaf359e3e2ff647ff9d227baaee9324), [897f68f — crear puente de editor](https://github.com/jmpixelapp-jpg/desarrollo/commit/897f68f43bf5aea6b53a9e5100252aa594c9355f), [e916d3c — pruebas de puente](https://github.com/jmpixelapp-jpg/desarrollo/commit/e916d3cefb8d4ad8fcb2817677f15ef14fbda382), [843ebfd — export público](https://github.com/jmpixelapp-jpg/desarrollo/commit/843ebfd4699fb95289452774625f0c5426bfa84e), [3c8cd79 — FIFO reentrante](https://github.com/jmpixelapp-jpg/desarrollo/commit/3c8cd794cd65f2b5931089366c2d6a65b69f7270), [dc9bf15 — prueba FIFO](https://github.com/jmpixelapp-jpg/desarrollo/commit/dc9bf15dbdf1aa730b4945b7390d7d69252f4035), [c589613 — guía del anfitrión](https://github.com/jmpixelapp-jpg/desarrollo/commit/c5896131e4e9e02a441c24b91c644aad822c255d), [608f8e2 — contrato del retorno y prueba](https://github.com/jmpixelapp-jpg/desarrollo/commit/608f8e2a45a7bdff95db2e829dfa4eedb6a2050b).

**Resultado CI:** [45728632431](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45728632431): build Vite correcto, esquema MLDB 0.4.2 válido, auditoría física de 25 tablas/34 almacenes y **120/120 pruebas aprobadas, 0 fallidas, 0 omitidas**.

**CI general:** [45728632512](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45728632512) sigue mostrando errores TypeScript únicamente en `src/literary-analysis.ts` (TS2322, TS2677, TS18047 y TS2345).

**Límite transparente:** el puente es código reusable probado con un editor falso controlado por tests. No equivale a una integración de producción. La app aún debe conectar el callback real de transacciones del editor anfitrión.



## 22. Nueva entrega — huellas de transacción para deduplicación segura (26 de noviembre de 2026)

**Problema corregido:** la deduplicación anterior ignoraba cualquier segundo evento con el mismo transactionId y secuencia, incluso si el proveedor enviaba por error un delta distinto.

**Implementación:** el source conserva una firma compacta acotada por transactionId: secuencia, tipo, revisión base, rango, longitud del reemplazo y dos hashes de 32 bits sobre el reemplazo. Los duplicados exactos se descartan; una reutilización con otra secuencia o payload genera `transaction-id-reused` y suspende el source. No se conserva el manuscrito ni el reemplazo original.

Se valida que replacement sea una cadena antes de firmarlo. Un duplicado malformado produce `invalid-change-range` sin excepción no controlada hacia el callback nativo.

**Pruebas:** objeto clonado con la misma transacción se ignora; misma identidad con otro delta obliga a resincronizar; reemplazo malformado no interrumpe el editor.

**Archivos:** `typescript/src/live-author-monitor-editor-transaction-source.ts`, `typescript/tests/live-author-monitor-editor-transaction-source.test.mjs`; especificación sección 36.

**Commits:** [b59a567 — huella compacta](https://github.com/jmpixelapp-jpg/desarrollo/commit/b59a567f6b39bebc48f00cc7d7ff9e067f7d34e8), [0776234 — validar reemplazo antes de firmar](https://github.com/jmpixelapp-jpg/desarrollo/commit/07762345d7c1ad41def908404bd921b5e802399b), [e1022ae — prueba de payload distinto](https://github.com/jmpixelapp-jpg/desarrollo/commit/e1022ae19518a4fa74c974277220a0c5048ce926), [d8642c6 — prueba de evento malformado](https://github.com/jmpixelapp-jpg/desarrollo/commit/d8642c6b83faa63959ca26e9775fae83ab0b1fdc).

**Resultado CI:** [45729007367](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45729007367): build Vite correcto, MLDB 0.4.2 válido, auditoría física de 25 tablas/34 almacenes y **124/124 pruebas aprobadas, 0 fallidas, 0 omitidas**.



## 23. Nueva entrega — cuarentena de payloads inválidos del editor (26 de noviembre de 2026)

**Objetivo:** impedir que eventos runtime malformados (aunque el adaptador esté tipado en TypeScript) interrumpan el callback nativo de edición o sean ignorados silenciosamente.

**Implementación:**
- `LiveAuthorMonitorEditorTransactionBridge.freezeTransaction()` crea un evento inmutable para payloads válidos y transforma `null`, primitivos o getters que lanzan en un evento centinela inválido que activa la pausa del source.
- `LiveAuthorMonitorEditorTransactionSource.drainTransactionQueue()` captura excepciones por transacción, procesa explícitamente eventos `null` y convierte cualquier payload no validable en `invalid-transaction`, desconectando el proveedor.
- `replacement` se comprueba como cadena antes de generar el fingerprint, de modo que un evento repetido malformado detiene el stream con `invalid-change-range` sin excepción no controlada.

**Pruebas añadidas:** provider directo que emite null; Proxy con getter defectuoso en provider directo; bridge que recibe null; Proxy con getter defectuoso a través del bridge. Se mantiene también la prueba del duplicate con replacement no textual.

**Archivos:** `typescript/src/live-author-monitor-editor-transaction-bridge.ts`, `typescript/src/live-author-monitor-editor-transaction-source.ts`, `typescript/tests/live-author-monitor-editor-transaction-bridge.test.mjs`, `typescript/tests/live-author-monitor-editor-transaction-source.test.mjs`; especificación sección 37.

**Commits:** [991b1cb — contener eventos malformados en el bridge](https://github.com/jmpixelapp-jpg/desarrollo/commit/991b1cbe52ddbd50e76c8d8bde0132262eabf443), [a132a32 — probar null/Proxy en el bridge](https://github.com/jmpixelapp-jpg/desarrollo/commit/a132a32adbcc80418f6198de400b55a000d84db4), [183fc53 — contener payloads del proveedor directo](https://github.com/jmpixelapp-jpg/desarrollo/commit/183fc53c4aaeafa7c1dec107c60cdbfd746bf947), [b323c9a — probar null/getters en el source](https://github.com/jmpixelapp-jpg/desarrollo/commit/b323c9ab03abe6e3a7b7491280cdd118e3000e1d), [12a7542 — probar getters defectuosos también a través del bridge](https://github.com/jmpixelapp-jpg/desarrollo/commit/12a754203130e82bea7808763319143243898fc1).

**Resultado CI:** [45729346603](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45729346603): build Vite correcto, esquema MLDB 0.4.2 válido, auditoría de 25 tablas/34 almacenes y **128/128 pruebas aprobadas, 0 fallidas, 0 omitidas**.


## 24. Backlog FIFO acotado y pausa segura por desbordamiento (25 de noviembre de 2026)

**Problema:** el enlace `bindLiveAuthorMonitorEditorChanges` conservaba en memoria todos los deltas posteriores a un `queue_full` o error de envío. Si el motor permanecía sin capacidad mientras el autor seguía escribiendo, el array `pending` podía crecer sin límite. Además de consumir memoria, un buffer sin límite no podía garantizar retención indefinida.

**Implementación:**
- Nuevo parámetro `maxPendingChanges`, predeterminado en 4096 y validado entre 1 y 65536.
- Cuando el siguiente delta excedería el límite, el enlace conserva el backlog ya aceptado en su buffer, no añade el evento que desbordó, emite `LiveAuthorMonitorBackpressureOverflowError` (`pending-buffer-overflow`) y publica un snapshot `resync-required` con `overflowSequence`.
- La fuente se pausa mediante `requireResynchronization()` cuando soporta ese método y la suscripción se cancela. Las señales automáticas de retry no pueden reanudar el envío durante esta condición.
- Después de que el anfitrión reconcilia editor y motor con el mismo snapshot durable, `discardPendingAfterResynchronization()` limpia el backlog anterior y vuelve a suscribir la fuente.
- La interfaz conserva compatibilidad con fuentes antiguas: `requireResynchronization` es opcional, pero la cancelación y la reanudación tras snapshot común siguen aplicándose.

**Pruebas:** buffer de tamaño dos sin crecimiento adicional; evento excedente identificado; pausa/desuscripción; retry bloqueado durante la resincronización; limpieza y re-suscripción tras snapshot común; validación de límites antes de instalar listeners; emisión síncrona durante el montaje sin dejar un listener residual.

**Archivos:** `typescript/src/live-author-monitor-change-binding.ts`, `typescript/tests/live-author-monitor-change-binding.test.mjs`, `docs/development/LIVE_AUTHOR_MONITOR_EDITOR_ADAPTER_GUIDE.md`, `docs/specifications/LIVE_AUTHOR_MONITOR_V0.1.md`.

**Estado de validación:** se añadieron 3 regresiones a la suite de enlace editor→motor (15 pruebas totales en ese archivo).

**Commits del avance:** [475dd63 — limitar el backlog FIFO](https://github.com/jmpixelapp-jpg/desarrollo/commit/475dd639231229b86666ba0b8cdf5499b37f5b3a), [1f97dce — verificar la recuperación del buffer](https://github.com/jmpixelapp-jpg/desarrollo/commit/1f97dce81838a512dfdd37b8c78debd8d5a4a5b2), [4ca4897 — cubrir emisiones síncronas durante el montaje](https://github.com/jmpixelapp-jpg/desarrollo/commit/4ca4897e12dc2b5769a2faa57ff9b3abafddab88).

**CI:** la consulta de checks del último commit 4ca4897e12dc2b5769a2faa57ff9b3abafddab88 todavía no devuelve resultados. No se declara validación CI aprobada para esta entrega. La última validación registrada antes de estos cambios fue 128/128 pruebas del monitor, en el commit 12a754203130e82bea7808763319143243898fc1.

**Límite importante:** el evento que excede el buffer ya fue aplicado por el editor y no se conserva como delta individual; se recupera desde el snapshot común. El código no afirma que ese delta se haya admitido ni se haya persistido de forma incremental.


## 25. Configuración pública y recuperación extremo a extremo del backlog (25 de noviembre de 2026)

**Cambio de API:** `maxPendingChanges` queda expuesto en las opciones de montaje de ambos adaptadores públicos: `mountLiveAuthorMonitorEditorTransactions()` y `mountLiveAuthorMonitorTextArea()`. El valor se propaga al enlace FIFO común; el predeterminado sigue siendo 4096.

**Regresión transaccional de extremo a extremo:** se fuerza `queue_full` en la primera edición y se produce un segundo delta mientras el buffer está ocupado. Al llegar el siguiente límite, el source nativo se pausa y retira el listener del editor. Después de reconciliar motor y editor desde el snapshot durable que ya contiene ambos cambios, `resynchronize()` limpia la generación anterior, vuelve a suscribir el editor y admite una edición nueva en la secuencia siguiente.

**Regresión textarea:** el mismo límite se configura desde la API pública; la captura se suspende durante el desbordamiento y vuelve a funcionar después de reconciliar el texto y la revisión del motor.

**Regresiones de configuración:** ambos montajes rechazan `maxPendingChanges: 0` antes de consultar HostEngineApi o instalar listeners, evitando inicializaciones parciales.

**Archivos:** `typescript/src/live-author-monitor-editor-transaction-integration.ts`, `typescript/tests/live-author-monitor-editor-transaction-integration.test.mjs`, `typescript/src/live-author-monitor-textarea-integration.ts`, `typescript/tests/live-author-monitor-textarea-integration.test.mjs` y guía del adaptador; especificación sección 39.

**Commits:** [8622b618 — exponer el límite configurable en ambos montajes](https://github.com/jmpixelapp-jpg/desarrollo/commit/8622b61856c32f5f62dd3aa416fe6c69b5509894), [c002ebb0 — validar el límite antes del montaje](https://github.com/jmpixelapp-jpg/desarrollo/commit/c002ebb04a4b33d632ef155b05edb2776bc2a949), [e4d58b3d — probar configuración inválida](https://github.com/jmpixelapp-jpg/desarrollo/commit/e4d58b3de1f140dd75b90fe4e3b95ebcd9e5345a).

**Validación del monitor — commit `e4d58b3de1f140dd75b90fe4e3b95ebcd9e5345a`:** GitHub Actions [45733243548](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45733243548) terminó correctamente. Build Vite aprobado; MLDB 0.4.2 válido (26 tablas); auditoría física correcta (25 tablas del motor y 34 almacenes IndexedDB definidos y creados); prueba Chromium de dos páginas completada; **138/138 pruebas aprobadas, 0 fallidas y 0 omitidas**. Se incluyen las pruebas de desbordamiento, configuración pública, pausa del proveedor y recuperación tras snapshot común.

**CI general — mismo commit:** [45733243591](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45733243591) aprobó `Type-check`, pero falló al ejecutar la suite completa: 712 pruebas, 691 aprobadas, 12 fallidas y 9 omitidas. Los fallos quedaron en `tests/idea-synchronization.test.mjs`, `tests/literary-analysis-graph-determinism.test.mjs` y `tests/literary-analysis.test.mjs`, fuera de los archivos del monitor. El benchmark general se omitió por el fallo de la suite.


**Validación preventiva de configuración:** los montajes transaccional y textarea validan `maxPendingChanges` antes de consultar/reservar la sesión de monitoreo o instalar listeners. Un límite inválido (no entero seguro o fuera de 1–65536) falla de inmediato y no deja recursos parcialmente montados.


## 26. Aplicación de referencia de escritura real en navegador (25 de noviembre de 2026)

**Entrega funcional:** se añade `typescript/examples/live-author-monitor/index.html`, una página ejecutable que conecta un textarea nativo con `HostEngineApi`, `IndexedDbProjectStore`, `mountLiveAuthorMonitorTextArea` y `mountLiveAuthorMonitorPanel`. La página recupera documentos existentes, representa las métricas de actividad y ofrece un cierre seguro que vacía la cola, persiste el checkpoint, libera el lease y dispone recursos.

**Prueba Chromium de extremo a extremo:** se añade `tests/live-author-monitor-writing-browser.test.mjs`. El caso escribe texto mediante eventos reales de teclado, comprueba admisiones, commits y secuencia durable, cierra la sesión, recarga la página, verifica restauración del texto y del checkpoint y continúa escribiendo en la sesión recuperada.

**Workflow:** el workflow específico del monitor ahora también se ejecuta cuando cambia la aplicación de referencia.

**Límite explícito:** esta página es una aplicación real de referencia sobre textarea, no la aplicación final de producción ni un editor enriquecido. Los editores con historial propio deben conectar sus callbacks nativos mediante el adaptador transaccional. La conexión de un editor anfitrión ausente no se declara completada.

**Validación CI final de la aplicación de referencia — commit `ce2413194e1f02ce21fcc232c3f43a1ee036452a`:** workflow [45734476285](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45734476285) completado con éxito. Vite build correcto; esquema MLDB 0.4.2 válido (26 tablas); auditoría física correcta (25 tablas del motor y 34 almacenes IndexedDB); Chromium instalado y ejecutado; **139/139 pruebas aprobadas, 0 fallidas y 0 omitidas**. La prueba nueva verificó escritura real con teclado, métricas visibles y confirmadas, cierre seguro mediante `HostEngineApi.disposeSafely()`, recarga, restauración del texto y checkpoint y una segunda edición después de recuperar la sesión.

**Concordancia con main:** al registrar este resultado, los hashes de la página de referencia, su prueba Chromium, el adaptador textarea, el enlace de contrapresión y el workflow en `main` coinciden exactamente con los archivos del commit validado `ce241319...`.

**CI general del mismo commit:** workflow [45734476273](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45734476273): `Type-check` correcto; suite general con 713 pruebas, 702 aprobadas, 2 fallidas y 9 omitidas. Los dos fallos están fuera del monitoreo: `tests/idea-synchronization.test.mjs` (conteo esperado 4, obtenido 6 en reconciliación de ideas entre anfitriones) y `tests/literary-analysis.test.mjs` (una validación esperaba una excepción que no se produjo). Se dejan intactos para no interferir con la línea de análisis literario.



**CI de la aplicación de referencia:** el filtro del workflow específico contempla las rutas de `examples/live-author-monitor/**` tanto en `push` como en `pull_request`; el test de escritura se ejecuta junto con los demás archivos `live-author-monitor*.test.mjs`.


**Verificación general posterior:** el workflow TypeScript [45734599092](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45734599092), sobre el commit `8855c23ed7d56c7041785150355835d38d42dc83`, completó correctamente Type-check, build, suite completa y benchmark. La suite general registró **713 pruebas: 704 aprobadas, 0 fallidas y 9 omitidas**.

**Benchmark de escritura (40 ediciones por tamaño, runner CI):**
- Manuscrito de 10.000 palabras: latencia p95 de commit 5,06 ms; extremo a extremo 5,49 ms; incremento de heap 0,75 MB.
- Manuscrito de 100.000 palabras: commit p95 2,21 ms; extremo a extremo 2,63 ms; heap +1,83 MB.
- Manuscrito de 500.000 palabras: commit p95 3,54 ms; extremo a extremo 4,04 ms; heap +3,61 MB.
- Línea única de 20.000 palabras y 5 ediciones: commit p95 61,59 ms; extremo a extremo 61,80 ms.
- Cuatro documentos con diez ediciones cada uno: 40 ediciones concurrentes; p95 extremo a extremo 1,21 ms.

Los valores son mediciones del runner de CI y no una garantía universal de latencia en todos los navegadores o equipos. La CI específica sigue siendo la validación directa del adaptador y navegador: 139/139 aprobadas en [45734476285](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45734476285).

## 27. Integración multi-documento en la aplicación de referencia (25 de noviembre de 2026)

**Cambio funcional:** la aplicación de referencia deja de limitarse a un único manuscrito. Mantiene dos documentos abiertos dentro del mismo proyecto, permite cambiar el textarea activo sin cerrar la sesión del documento anterior, vacía y confirma la cola antes de cambiar de capítulo y muestra un tablero global con tarjetas independientes junto al panel detallado del capítulo activo.

**Integración de componentes existentes:** se conecta `mountLiveAuthorMonitorEditorIntegration()` al contrato de selección de documentos del anfitrión. El tablero puede activar un capítulo y las pestañas del editor actualizan el panel activo; el motor no abre ni cierra documentos como efecto secundario de la navegación.

**Persistencia y recuperación:** al iniciar se recuperan los dos documentos desde IndexedDB o se crean si todavía no existen. El cierre usa `HostEngineApi.disposeSafely()` para confirmar y guardar las sesiones bajo lease antes de liberar recursos. La recarga debe restaurar texto y métricas de cada capítulo de manera independiente.

**Prueba Chromium ampliada:** el test end-to-end escribe en ambos capítulos, cambia de uno a otro, confirma métricas separadas, verifica que el primer texto permanece intacto, cierra, recarga, comprueba ambos checkpoints y vuelve a escribir tras la recuperación.

**Validación:** pendiente de la ejecución del workflow `Live Author Monitor` generada por esta entrega. No se anticipa el resultado.

**Límite:** es una integración multi-documento real de referencia con textarea. El callback de un editor enriquecido de producción externo sigue dependiendo de su anfitrión, ausente del repositorio.


## 28. Carrera de secuencia pendiente durante persistencia asíncrona (25 de noviembre de 2026)

**Defecto reproducido con Chromium multi-documento:** al persistir el primer delta, el motor preparaba el siguiente estado del documento antes de esperar `appendChange()`. Mientras IndexedDB resolvía, el editor podía admitir otras ediciones y elevar `pendingSequence`; al finalizar el primer commit, el motor instalaba una copia antigua que retrocedía el contador de admisiones. La prueba de navegador reprodujo el estado imposible `sequence: 39, pendingSequence: 2`.

**Corrección:** el motor calcula el buffer y la revisión siguiente antes de persistir, pero instala el nuevo `LiveDocument` después del `await`. En ese momento toma el `pendingSequence` vivo de la instancia actual del documento, preservando todas las ediciones ya admitidas mientras la escritura durable estaba pendiente. Se mantiene un solo commit activo por documento y no se relaja ninguna validación de sincronización.

**Regresión añadida:** `live-author-monitor-engine-pending-sequence.test.mjs` bloquea deliberadamente la primera escritura del journal, admite 40 ediciones consecutivas mientras está pendiente y verifica que `pendingSequence` no retroceda, que los 40 commits se completen y que el texto final sea íntegro.

**Validación CI:** pendiente para este commit.


## 29. Restauración inmediata sin edad de actividad anterior al inicio de sesión (25 de noviembre de 2026)

**Defecto reproducido:** al restaurar un checkpoint de una sesión muy reciente, `restoreCheckpoint()` elevaba artificialmente `lastActivityAgeMs` hasta `idleAfterMs + 1`. Si la sesión completa era más corta que ese umbral y la interrupción entre procesos era breve, la última actividad quedaba fechada antes del inicio de la sesión. El checkpoint siguiente era rechazado por IndexedDB.

**Corrección:** la edad restaurada ahora es exactamente `checkpoint.lastActivityAgeMs + downtime`. El downtime ya se incorpora íntegramente a `idleDurationMs`; no se necesita alterar la antigüedad de la última pulsación ni fabricar tiempo anterior al inicio de sesión.

**Regresión:** se crea una sesión de 3 ms con umbral de inactividad de 10 ms, se restaura tras 1 ms y se crea un segundo checkpoint. La prueba verifica que la última actividad (3 ms de antigüedad) sigue dentro de la sesión (4 ms), y que el checkpoint posterior es válido.


## 30. Validación final multi-documento y regresiones de persistencia (26 de noviembre de 2026)

**Carrera de admisión/persistencia corregida:** al terminar un `appendChange()` lento, el motor ahora instala el buffer/revisión confirmados conservando el `pendingSequence` más reciente de la instancia viva. La regresión bloquea la primera escritura, admite 40 deltas y confirma que la secuencia pendiente no retrocede y que todos los commits quedan aplicados.

**Restauración inmediata corregida:** `restoreCheckpoint()` ya no fuerza la última actividad a ser más antigua que `idleAfterMs` cuando la sesión restaurada dura menos que ese umbral. El downtime se contabiliza en `idleDurationMs` y la antigüedad de actividad permanece dentro de la duración real de la sesión. La regresión crea una sesión de 3 ms, restaura después de 1 ms y confirma que el siguiente checkpoint sigue siendo válido.

**Prueba real Chromium multi-documento:** dos capítulos abiertos en paralelo mantienen textos y métricas independientes; la navegación vacía la cola anterior, actualiza el editor/panel activo, conserva ambas sesiones, cierra de forma durable, recarga y restaura ambos checkpoints y permite seguir escribiendo después de la recuperación.

**CI específica del monitor:** [45736377764](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45736377764), commit `d728593bd4f9758e85a4b16ce5ab1480d330f4bc`: build Vite correcto, esquema MLDB 0.4.2 válido (26 tablas), auditoría física correcta (25 tablas y 34 almacenes IndexedDB), Chromium completado y **141/141 pruebas aprobadas, 0 fallidas y 0 omitidas**.

**CI general TypeScript:** [45736377738](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45736377738), mismo commit: Type-check, build, validación MLDB y benchmark completados; **718/718 pruebas aprobadas, 0 fallidas y 0 omitidas**.

**Benchmark del runner CI:** 40 ediciones a 10.000 palabras: commit p95 5,76 ms / extremo a extremo p95 6,29 ms; 100.000 palabras: 2,69 ms / 3,35 ms; 500.000 palabras: 4,11 ms / 4,71 ms. Línea única de 20.000 palabras: extremo a extremo p95 65,15 ms. Cuatro documentos con diez ediciones por documento: extremo a extremo p95 1,39 ms. Son mediciones de este runner, no garantías universales.

## 31. Nueva entrega — diagnóstico operativo visible (25 de noviembre de 2026)

- Se añade el contrato LiveAuthorMonitorPersistenceDiagnostics, consultable por documento desde HostEngineApi.
- El estado de checkpoint diferencia almacén no compatible, no guardado, espera de durabilidad, guardado en curso, éxito y error.
- El estado del lease diferencia coordinación no compatible, inicialización pendiente, titular, observador, pérdida, expiración, liberación y error.
- Se registran los timestamps de checkpoints confirmados y se detecta explícitamente cuándo una renovación pierde el fencing token.
- El panel individual muestra ambos estados con anuncios accesibles.
- Los errores se reducen al nombre de su clase (por ejemplo, QuotaExceededError). No se publica el mensaje del error ni contenido del manuscrito.
- Se añaden pruebas de panel, cuota de almacenamiento y sustitución del fencing token.
- Archivos modificados limitados al monitor y su bitácora; no se modifican módulos narrativos ni archivos ajenos al módulo.

**Validación:** pendiente de GitHub Actions para este commit. El resultado se añadirá en una entrada posterior tras comprobar el workflow.

## 32. Nueva entrega — pruebas de resistencia y recuperación de almacenamiento (25 de noviembre de 2026)

- Se incorpora una prueba de sesión prolongada determinista: 8 documentos de 256 KiB iniciales, 40.000 commits confirmados y más de 8 horas simuladas. Se comprueba que cada documento termina sin pendientes, con ventana acotada de 32 muestras de latencia y sin filtrar el texto privado a los snapshots.
- Se añade una prueba de recuperación tras una apertura de IndexedDB bloqueada por otra conexión. Primero se espera el error explícito; después de cerrar el bloqueo, una operación nueva debe abrir la base.
- La prueba Chromium de coordinación ahora cierra la página propietaria sin ejecutar release, expira el lease en el almacén de prueba y comprueba que la pestaña superviviente toma el siguiente fencing token. El vencimiento se acelera en la prueba, no se esperan 30 segundos reales.
- El workspace multi-documento muestra el estado de persistencia y lease por capítulo, con anuncios accesibles y sin exponer contenido del manuscrito.

**Limitaciones de la prueba de soak:** simula el tiempo y el volumen de eventos de forma determinista; verifica límites de las muestras y ausencia de retención del manuscrito en snapshots. No se presenta como una medición de consumo de memoria del navegador ni como una sesión física de ocho horas.

**Validación en [Live Author Monitor — run 45756749489](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45756749489):** aprobada para la comprobación aislada. `npx tsc --noEmit --project tsconfig.live-author-monitor.json` terminó correctamente; también pasaron el build Vite reducido, 17/17 regresiones diagnósticas y 59/59 pruebas del núcleo, panel, workspace y diagnósticos. El benchmark completó 100.000 commits en 580,44 ms (~172.282 commits/s), con heap de 4,26 MiB al 50 % y 100 % de carga, 0 MiB de crecimiento medido, 0,50 MiB retenidos por sesiones abiertas y cero tickets pendientes. Node.js 22.23.5, ocho documentos de 1.048.576 unidades UTF-16 cada uno.

La lane completa permanece en `failure` por la auditoría de persistencia y el bundle general ajenos al monitor: desajuste de versión IndexedDB, dos almacenes de reparación no declarados y error de sintaxis en `indexeddb-store.ts:2560`. Las integraciones que requieren el bundle completo/editor/navegador siguen omitidas; la comprobación estricta independiente del monitor queda aprobada. El workflow vigente también está bloqueado por un error de sintaxis ajeno al monitor en `src/narrative-history.ts` (TS1002); no se modifica ese archivo porque pertenece a trabajo paralelo.

## 33. Nueva entrega — clasificación de actividad de escritura (25 de noviembre de 2026)

- Se añade la clasificación tipada `EditorChange.activityKind`: escritura, pegado, borrado, corrección, deshacer, rehacer y otras operaciones.
- El adaptador textarea identifica pegado, borrado y algunos tipos de reemplazo desde `InputEvent.inputType`; los editores nativos pueden informar categorías adicionales.
- El adaptador transaccional conserva explícitamente los tipos reales `undo` y `redo` del historial.
- El monitor agrega siete contadores por sesión (seis categorías específicas y `otherChanges`), los presenta en panel y workspace, y los conserva en checkpoints.
- Los campos nuevos son opcionales en checkpoints v1 antiguos. La validación exige enteros no negativos y que la suma de categorías coincida con los cambios aceptados cuando esos campos están presentes.
- Se añaden pruebas para las seis categorías, pegado desde textarea, historial nativo y recuperación desde checkpoint.

**Validación:** pendiente de CI. La compilación sigue condicionada por el error TS1002 de `src/narrative-history.ts`, fuera del ámbito de este módulo.

- Compatibilidad adicional: los checkpoints v1 anteriores a las categorías restauran sus ediciones históricas como `otherChanges`; así, los nuevos totales siguen cuadrando al volver a guardar.

- La restauración también admite checkpoints intermedios con los seis contadores clasificados pero todavía sin `otherChanges`; el residual se infiere como `acceptedChanges - suma(clasificados)`.

## 34. Nueva entrega — recuperación inmediata al volver de suspensión (25 de noviembre de 2026)

- HostEngineApi escucha `visibilitychange` y `pageshow`; al regresar una pestaña a estado visible, revalida de inmediato los leases de documentos monitoreados.
- Si el lease expiró mientras el navegador suspendió o limitó los temporizadores, intenta adquirirlo de nuevo en ese mismo ciclo. Si otra pestaña gana la carrera, el heartbeat periódico conserva los reintentos.
- Los listeners se retiran en `dispose()`; el listener no interviene cuando la página pasa a segundo plano.
- Se añade una prueba determinista que expira el lease mientras la pestaña está oculta, dispara el regreso a visible y verifica la adquisición con el siguiente fencing token.

**Validación:** pendiente de CI.

## 35. Nueva entrega — retención configurable y limpieza segura (25 de noviembre de 2026)

- Se añade `liveAuthorMonitorCheckpointRetentionMs` a `HostEngineOptions`. El valor predeterminado es 90 días; `0` desactiva la limpieza automática y manual; el rango aceptado es de 0 a 3650 días.
- `initializeProject()` programa una limpieza local no bloqueante y reporta errores mediante el callback de diagnóstico existente.
- `HostEngineApi.cleanupLiveAuthorMonitorCheckpoints(now?)` permite ejecutar la limpieza manual y devuelve solo el número de checkpoints eliminados.
- `IndexedDbProjectStore.cleanupLiveAuthorMonitorCheckpoints()` recorre únicamente los registros del proyecto, elimina solo checkpoints anteriores al umbral y protege los que tengan lease vigente o malformado.
- Nunca se eliminan registros de lease, incluso si expiraron: se conservan como tombstones para que el siguiente propietario obtenga un fencing token superior.
- Se añaden pruebas de retención multi-proyecto, protección por lease activo, eliminación del checkpoint expirado, preservación del fencing token y validación temporal.

**Privacidad:** el job de retención opera sobre IDs, timestamps y metadatos de lease/checkpoint; no materializa ni inspecciona el contenido del manuscrito.

**Validación en [Live Author Monitor — run 45756913002](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45756913002), checkout `df627586`:** aprobada para la lane aislada. `tsc --noEmit --project tsconfig.live-author-monitor.json` pasó; también el build Vite reducido, 17/17 pruebas diagnósticas y 59/59 pruebas de núcleo, panel y workspace. El test existente de checkpoint confirmó que dos errores del suscriptor permanecen en la sesión actual, no aparecen en el registro durable y vuelven a cero tras `restoreCheckpoint()`. El benchmark procesó 100.000 commits en 589,71 ms (~169.576 commits/s), con heap de 4,26 MiB al 50 % y al 100 % de carga, crecimiento medido de 0 MiB, 0,50 MiB retenidos y cero tickets pendientes.

La lane completa permanece en `failure` por la auditoría MLDB (desajuste de versión IndexedDB y almacenes de reparación sin mapear) y el bundle runtime general, que sigue fallando en `indexeddb-store.ts:2560`. Las integraciones que dependen de ese bundle se omitieron; la validación estricta del núcleo/panel/workspace queda aprobada.

- Se amplía la cobertura de retención en HostEngineApi: valor configurable, limpieza automática al iniciar, llamada manual, desactivación con `0` y rechazo de límites inválidos. La fixture de lease vencido conserva fechas internamente válidas para probar expiración real y no corrupción.

## 36. Resultado de CI y protección conservadora (25 de noviembre de 2026)

La ejecución asociada al commit `ac86d54472e982148a3e7a818ac01b2b6024fc69` terminó con estos bloqueos:

- [Live Author Monitor — run 45742276468](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45742276468): el paso `Build runtime bundle` se detuvo antes de ejecutar pruebas por `src/narrative-history.ts:7:40 — Unterminated string literal`.
- [Motor Literario TypeScript — run 45742276528](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45742276528): `Type-check` se detuvo por el mismo error `TS1002`.
- En el workflow específico, el paso de pruebas del monitor quedó omitido porque la compilación previa no produjo el bundle. No hay evidencia de aprobación ni de fallo de las pruebas nuevas.

El archivo que bloquea la compilación pertenece al área de historial narrativo y no se modifica en esta entrega para evitar interferir con el trabajo paralelo. Se añade además una prueba fail-safe: si el lease de un checkpoint es malformado, la limpieza conserva ese checkpoint en lugar de inferir que puede borrarlo.

- Ajuste del harness Chromium: el lease expirado conserva `acquiredAt <= updatedAt <= expiresAt`; se simula un lease válido pero vencido, no una estructura malformada.

 
## 37. Consolidación de fase 3 y documentación operativa (25 de noviembre de 2026)

**Estado de rama:** `main` quedó en `481b0dde05b7878dce428b4778d7b828fa49af73` antes de esta consolidación. La entrega de fase 3 en esta serie incluye diagnósticos de checkpoint/lease, estrés multi-documento, clasificación de operaciones, recuperación al volver de suspensión, retención segura y pruebas de leases inválidos/cierre abrupto.

**Cambios incluidos en la secuencia de commits del módulo:**

| Commit | Alcance |
|---|---|
| `85a7ea9` | Diagnóstico de persistencia y coordinación visible en el panel. |
| `053f455` | Soak determinista, IndexedDB bloqueado y recuperación con dos pestañas. |
| `57bfbd0` | Clasificación de escritura, pegado, borrado, corrección, undo y redo. |
| `8350190`, `45eae87` | Compatibilidad de checkpoints antiguos e intermedios. |
| `976d2b2` | Recuperación del lease en `visibilitychange` y `pageshow`. |
| `61cd0ef`, `ac86d54` | Retención configurable, protección por leases y pruebas de política. |
| `f992787`, `481b0dd` | Protección de datos ante lease inválido y fixture Chromium de expiración válida. |

**Validación real observada:**

- [Motor Literario TypeScript — run 45742493582](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45742493582), sobre `481b0dde`: terminó en fallo en `Type-check` por `src/narrative-history.ts(7,41): TS1002 — Unterminated string literal`.
- [Live Author Monitor — run 45742415506](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45742415506), sobre `f992787`: terminó en fallo en `Build runtime bundle` por `src/narrative-history.ts:7:40 — Unterminated string literal`.
- Las pruebas específicas del monitor fueron omitidas después de fallar la compilación previa; no se deben interpretar como aprobadas ni como fallidas.
- La última referencia verde anterior a esta fase sigue siendo [CI específica 45736377764](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45736377764) (141/141) y [CI general 45736377738](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45736377738) (718/718), ambas sobre el commit anterior a estas nuevas mejoras. No validan los commits de esta fase.

**Corrección del disparador:** se añade `typescript/tests/browser/**` a los filtros `push` y `pull_request` del workflow dedicado. Así, modificar el HTML del harness Chromium dispara la misma suite específica que su test Playwright.

**Cobertura implementada frente a medición pendiente:**

- Automatizado: error de cuota simulado con `QuotaExceededError`, apertura IndexedDB bloqueada y reintento, cierre de una página propietaria sin `release()`, expiración de lease, takeover mediante fencing token, recuperación al volver a visible, limpieza segura y prueba de 40.000 commits en 8 documentos.
- Aún pendiente de validación CI: ejecutar todos esos tests después de corregir el error TypeScript externo.
- Aún pendiente como medición física: cuota realmente agotada en un perfil de navegador, suspensión del sistema operativo durante horas y medición de heap/RAM real durante un soak prolongado. El test de ocho horas es simulado y no acredita por sí solo consumo de memoria en navegador.
- Aún pendiente de integración: conectar el callback transaccional, historial y selección del editor enriquecido real de producción, que no se encuentra en este repositorio.

**Documentación:** se añade `LIVE_AUTHOR_MONITOR_OPERATIONS.md` como guía operativa consolidada; el contrato v0.1 y la guía de adaptadores incorporan las nuevas garantías, parámetros y límites.

## 38. Nueva entrega — verificación visual de métricas clasificadas (25 de noviembre de 2026)

Se añaden dos regresiones de presentación DOM:

- El panel individual del capítulo debe mostrar los contadores de escritura, pegado, borrado, corrección, deshacer, rehacer y otras operaciones.
- El workspace debe mostrar esos mismos siete valores en la tarjeta del documento correcto, sin trasladarlos a otro capítulo ni exponer el texto privado.

Las pruebas crean operaciones válidas, admiten y confirman cada cambio, montan el panel después de generar las métricas y verifican los siete valores visibles. La validación CI queda pendiente de la ejecución del nuevo commit.

## 39. Nueva entrega — selección configurable de métricas en panel y workspace (25 de noviembre de 2026)

Se incorpora `visibleMetrics` en el montaje del panel individual y del workspace. El anfitrión puede mostrar solo las métricas relevantes para una vista reducida o para la lectura de capítulos. Si omite la opción, se mantiene la presentación completa.

- Se exportan los tipos `LiveAuthorMonitorPanelMetric` y `LiveAuthorMonitorWorkspaceMetric`.
- Las selecciones personalizadas se validan antes de crear o insertar el DOM. Claves desconocidas y duplicadas producen error explícito sin dejar un contenedor parcialmente montado.
- Los paneles conservan roles semánticos de lista y elemento de lista para accesibilidad.
- La opción solo controla la presentación; no modifica contadores, checkpoints ni el motor.
- Se añaden pruebas de selección, ocultación de métricas no solicitadas y rechazo de configuración inválida para ambos componentes.

**Validación:** aprobada en ambas lanes sobre `4ce9672`: [Live Author Monitor — run 45752680391](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45752680391) y [Motor Literario TypeScript — run 45752680363](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45752680363).

- Ajuste de tipado preventivo: los mapas de claves visibles se construyen mediante `Map.set()` explícito para mantener la inferencia de tuplas estable en TypeScript estricto.

## 40. Nueva entrega — benchmark de heap reproducible para sesiones de monitor (25 de noviembre de 2026)

- Se añade `bench/live-author-monitor-memory-benchmark.mjs`, con ocho sesiones predeterminadas, documentos iniciales de 1.048.576 unidades UTF-16 y 12.500 commits por documento (100.000 en total).
- El script fuerza GC antes de sus lecturas y captura heap inicial, después de abrir sesiones, a mitad de carga y al finalizar. Reporta heap retenido por sesiones, crecimiento de mitad a carga completa, RSS y throughput del runner.
- Verifica por documento que los 12.500 commits se confirmaron, no quedan pendientes/fallos y la ventana de latencias se mantiene en 64 muestras.
- Se añade `npm run bench:monitor`; el benchmark general `npm run bench` lo ejecuta después del benchmark de edición y el workflow específico lo ejecuta tras los tests.
- Las dimensiones del benchmark son configurables mediante variables de entorno y el script valida sus límites.

**Límite de medición:** esta medición es heap/RSS del proceso Node en CI, no heap de Chromium ni RAM del editor en producción. No se fija un umbral global arbitrario; se publica el valor observado y se conserva la verificación estructural de las ventanas acotadas.

**Validación:** [Live Author Monitor — run 45753400038](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45753400038) aprobó build aislado, Chromium, auditoría MLDB, build runtime, suite específica y benchmark de memoria. El type-check de [Motor Literario TypeScript — run 45753400053](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45753400053) pasó; la suite general ejecutó 849 pruebas, con 847 aprobadas y dos fallos en handlers de sincronización narrativa ajenos al monitor (`narrative-sync-assertion-handler.test.mjs` y `narrative-sync-entity-handler.test.mjs`).

- Precisión de unidades: el tamaño de documento del benchmark se expresa en unidades UTF-16 (la misma convención de offsets del motor), no como bytes físicos de RAM. El resultado `initialCodeUnitsPerDocument` evita atribuir al heap un tamaño de almacenamiento que depende del runtime.

## 41. Precisión de medición y disparadores de benchmark (25 de noviembre de 2026)

- El benchmark usa `DOCUMENT_CODE_UNITS` y reporta `initialCodeUnitsPerDocument`, para no confundir longitud UTF-16 con bytes físicos de almacenamiento. El texto inicial se libera tras abrir las sesiones y el monitor conserva únicamente longitud y métricas.
- Se incluyen `typescript/bench/**` y `typescript/package.json` en los filtros `push` y `pull_request` del workflow específico; los cambios en benchmarks/scripts ya no quedan fuera de la CI directa del monitor.
- La lectura de heap se hace con GC explícito en el proceso Node del runner. No se fija un presupuesto global no calibrado; el reporte servirá para establecer una línea base y detectar regresiones relativas. No sustituye una medición de heap de Chromium.

**Validación:** el commit que incorpora el benchmark quedó sujeto a CI; el resultado debe registrarse cuando termine el workflow.

## 42. Resultado de CI para el benchmark de heap y estado de pruebas (25 de noviembre de 2026)

La ejecución del commit `b2ef1ecc48b9d30e02634755c125e3adbf7eb810` confirma:

- [Live Author Monitor — run 45743414420](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45743414420): setup, instalación de Chromium y auditoría de esquema físico aprobados; `Build runtime bundle` bloqueado por `src/narrative-history.ts:7:40 — Unterminated string literal`. Los tests y `bench:monitor` quedaron omitidos.
- [Motor Literario TypeScript — run 45743414450](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45743414450): `Type-check` bloqueado por `src/narrative-history.ts(7,41): TS1002`.

Por este motivo no existe todavía una cifra medida por `live-author-monitor-memory-benchmark.mjs`. El benchmark quedó enlazado al workflow específico y al comando `npm run bench`, pero debe ejecutarse una vez que el build previo pueda completarse. El archivo externo que bloquea la compilación no se modifica para no intervenir en el módulo narrativo paralelo.

## 43. Resultado de la CI posterior a la consolidación documental (25 de noviembre de 2026)

Las ejecuciones más recientes completadas verificadas:

- [Motor Literario TypeScript — run 45743597639](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45743597639), commit `8112df6fcf6976817520253d0e75496e3470394b`: falló el paso `Type-check` por `src/narrative-history.ts(7,41): TS1002 — Unterminated string literal`.
- [Live Author Monitor — run 45743497335](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45743497335), commit `ab624b7a6b5e9bd393aaf42624335ee66b02ed6d`: completó setup, instalación de Chromium y validación del esquema físico; falló en `Build runtime bundle` por `src/narrative-history.ts:7:40 — Unterminated string literal`.

El monitor y los tests del panel, workspace y benchmark siguen sin una ejecución completa posterior a estas entregas. El bloqueo es anterior a esos pasos y pertenece al archivo narrativo externo; no se modificó para no interferir con el trabajo paralelo.


## 44. Aislamiento de fallos de telemetría del monitor (25 de noviembre de 2026)

**Objetivo:** impedir que un error al leer diagnósticos operativos bloquee la actualización de las métricas de escritura.

**Cambios:**
- Se incorpora `readLiveAuthorMonitorPersistenceDiagnosticsSafely()` en la capa de panel.
- El panel individual y el workspace aíslan excepciones de `getLiveAuthorMonitorPersistenceDiagnostics`; los errores internos no se propagan ni se imprimen.
- Las respuestas asociadas a otro `documentId` se descartan para evitar mezclar diagnósticos de capítulos.
- Los diagnósticos ausentes pasan a nivel visual de advertencia; las métricas y el progreso durable continúan actualizándose.
- La recuperación del proveedor restablece los mensajes de checkpoint y lease sin remontar las vistas.
- Se añade una suite independiente con tres regresiones: error/recuperación del panel, aislamiento multi-documento y rechazo de diagnósticos cruzados.

**Archivos:** `src/live-author-monitor-panel.ts`, `src/live-author-monitor-workspace.ts`, `tests/live-author-monitor-diagnostics-isolation.test.mjs`, esta guía y la guía operativa.

**Commit de implementación:** [`c392f923566cda725b995e952a17690db6455909`](https://github.com/jmpixelapp-jpg/desarrollo/commit/c392f923566cda725b995e952a17690db6455909).

**Ejecuciones de CI del commit:**
- [Live Author Monitor — run 45744134650](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45744134650): falló en `Build runtime bundle` por `src/narrative-history.ts:7:40 — Unterminated string literal`. La auditoría física del esquema y los pasos de instalación/Chromium sí terminaron correctamente. La suite específica y el benchmark fueron omitidos.
- [Motor Literario TypeScript — run 45744134762](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45744134762): falló en `Type-check` por `src/narrative-history.ts(7,41): TS1002`. La suite completa y el benchmark fueron omitidos.

**Interpretación:** el código nuevo quedó publicado, pero sus tres regresiones no llegaron a ejecutarse en CI. El resultado no permite afirmar que estén aprobadas ni que hayan fallado. El bloqueo está en un archivo narrativo ajeno a esta entrega y no se modificó para evitar interferir con ese trabajo paralelo.

**Coordinación:** revisión del PR #56 confirma que no incluye ninguno de los cinco archivos de esta entrega; el cambio de workspace en ese PR se limita a su prueba preexistente. Se mantiene la separación de áreas. `main` conserva el commit de implementación como ancestro directo.

**Validación:** pendiente de CI. El baseline documentado sigue bloqueado antes de las pruebas del monitor por el error sintáctico externo `src/narrative-history.ts(7,41): TS1002`. No se modifica ese módulo ni se atribuye aprobación a tests que el workflow no haya ejecutado.


## 45. Lane independiente de compilación y regresión del monitor (25 de noviembre de 2026)

**Objetivo:** evitar que un error sintáctico en un módulo ajeno bloquee todas las pruebas focalizadas del monitor.

**Cambios:**
- Se crea `src/live-author-monitor-test-entry.ts`, que exporta únicamente motor de métricas, panel y workspace.
- Se crea `tsconfig.live-author-monitor.json` con TypeScript estricto y alcance limitado al punto de entrada del monitor y sus imports.
- Se crea `vite.monitor.config.ts`, que genera `dist-monitor/live-author-monitor.js` sin limpiar el bundle general `dist/`.
- La suite `live-author-monitor-diagnostics-isolation.test.mjs` importa el bundle aislado.
- El workflow ejecuta typecheck, build aislado y las tres regresiones antes de intentar el build general.
- Los filtros de `push` y `pull_request` incluyen los tres archivos nuevos para que la lane se dispare ante cambios en su configuración.

**Límites:** la lane aislada verifica tipos del monitor y sus módulos importados, más las regresiones DOM del aislamiento de diagnósticos. No reemplaza las pruebas de host, IndexedDB, leases multi-pestaña, editor real ni benchmark prolongado. La compilación general sigue siendo obligatoria y conserva el reporte de cualquier bloqueo externo.

**Validación:** pendiente de CI para este commit. Se conserva como antecedente el bloqueo de compilación general por `src/narrative-history.ts(7,41): TS1002`; la lane aislada debe ejecutarse antes de ese paso y reportar su resultado por separado.

## 46. Ajuste de la lane aislada tras el primer resultado de CI (25 de noviembre de 2026)

El primer intento de añadir `tsc --project tsconfig.live-author-monitor.json` falló antes de compilar el monitor con el mismo `src/narrative-history.ts(7,41): TS1002`. Aunque `live-author-monitor.ts` importa `contracts.ts` solo mediante `import type`, TypeScript incorpora el grafo transitivo de esos contratos al análisis del programa. Este proyecto no puede declarar que el typecheck quedó aislado mientras esa dependencia siga presente.

**Corrección:** se retira el tsconfig focalizado y se conserva una lane estrictamente de runtime: Vite/esbuild compila el entrypoint reducido (eliminando imports de tipo) y ejecuta las tres regresiones DOM del panel/workspace antes de instalar Chromium y antes del bundle general. La configuración se ordena para que los tests de runtime no dependan del navegador.

**CI observada en el intento inicial:** [Live Author Monitor — run 45744464290](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45744464290) superó instalación, Chromium y auditoría de esquema; falló al intentar el typecheck aislado por TS1002 en `narrative-history.ts`. La compilación aislada y las regresiones no se ejecutaron en ese intento.

**Precisión:** el bundle Vite no equivale a un typecheck TypeScript. El typecheck estricto de los módulos del monitor continúa pendiente hasta desacoplar de manera segura los contratos compartidos o resolver el error narrativo en el trabajo paralelo. No se modifican `contracts.ts`, `live-author-monitor.ts` ni `narrative-history.ts` en esta corrección, porque están dentro de áreas compartidas/paralelas.

## 47. Resultado de la lane de runtime aislada (25 de noviembre de 2026)

**Commit validado:** `e7e44eb1373777bd1b447c9b0d143d62074d68ca`.

**Resultado de [Live Author Monitor — run 45744690399](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45744690399):**
- `Build isolated live author monitor test bundle`: aprobado.
- `Run isolated diagnostic recovery regressions`: aprobado, 3 pruebas, 3 aprobadas, 0 fallidas (79,19 ms).
- Instalación de Chromium: aprobada.
- Auditoría de esquema y mapeo físico: aprobada.
- `Build runtime bundle`: bloqueado por `src/narrative-history.ts:7:40 — Unterminated string literal`.
- Suite monitor completa y benchmark: omitidos porque el build general no terminó.

**Resultado de [Motor Literario TypeScript — run 45744690397](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45744690397):** el typecheck general falló por `src/narrative-history.ts(7,41): TS1002`; suite general y benchmark omitidos.

**Conclusión:** las tres regresiones específicas incorporadas para aislar errores de diagnóstico pasan sobre un bundle ejecutable separado. No se atribuye aprobación a las suites de IndexedDB, leases, navegador multi-pestaña ni benchmark; no alcanzaron sus pasos de ejecución. El bloqueo de integración global continúa abierto y se mantiene fuera de esta área para no modificar el archivo narrativo que trabaja en paralelo.

**Orden de CI:** el workflow se reorganizó para ejecutar el bundle y las regresiones aisladas antes de instalar Chromium, validar el esquema y compilar el entrypoint global. Se retiró el intento de typecheck separado porque el grafo transitivo de `contracts.ts` vuelve a incorporar el módulo narrativo.

## 48. Hallazgo al intentar ampliar pruebas del núcleo de métricas (25 de noviembre de 2026)

Se probó temporalmente ejecutar `tests/live-author-monitor.test.mjs` desde el bundle aislado para validar restauración de checkpoints y estrés prolongado antes del build global. El intento ejecutó 20 casos: 17 aprobados y 3 fallidos.

Los tres fallos se concentran en `restoreCheckpoint()` y devuelven `ReferenceError: activityCountTotal is not defined`. En `main`, la variable local se llama `classifiedCountTotal`, pero una condición sigue referenciando `activityCountTotal`. La suite deja así expuesta una regresión real de restauración de checkpoints, no un fallo del bundle aislado.

**Coordinación con el trabajo paralelo:** el archivo `src/live-author-monitor.ts` también está siendo modificado por el PR #56 (`feat/narrative-sync-coordinator-v3`), cuyo diff ya incluye la corrección de esa condición para depender de `validActivityCounts`. No se modifica ni se fuerza una actualización de ese archivo desde esta área.

**Ajuste de alcance:** se restauró el import original de la suite unitaria (`dist/motor-literario.js`) para no romper `npm test` ni el workflow general. La lane aislada vuelve a ejecutar únicamente las tres regresiones de panel/workspace ya aprobadas. La suite de 20 casos se mantiene en el workflow general y podrá validar la corrección cuando el cambio paralelo llegue a `main` y el build general esté disponible.

**Resultado de esta prueba exploratoria:** 17/20 casos pasan; los 3 fallos quedan documentados como un bloqueo de checkpoint en el archivo compartido. El caso de soak de más de ocho horas y 40.000 cambios sí pasó (140,32 ms en el runner de CI). No se afirma que la restauración de checkpoint esté validada.

## 49. Validación estricta de métricas visibles (25 de noviembre de 2026)

**Problema:** `Array.prototype.map()` omite posiciones vacías de arreglos dispersos. Una opción `visibleMetrics` con huecos podía superar la validación inicial y generar una lista incompleta o fallar más tarde durante el montaje.

**Cambios:**
- El panel y el workspace recorren cada índice y exigen una propiedad propia del arreglo.
- Las posiciones vacías se rechazan con `TypeError` antes de crear nodos DOM.
- Los valores explícitos `undefined`, las claves desconocidas y los duplicados siguen siendo rechazados.
- Se añaden dos regresiones al bundle aislado: arreglos dispersos y valores `undefined` explícitos; ambas vistas deben dejar el contenedor sin cambios.

**Archivos:** `src/live-author-monitor-panel.ts`, `src/live-author-monitor-workspace.ts`, `tests/live-author-monitor-diagnostics-isolation.test.mjs`, guía operativa y registro de progreso.

**Validación:** pendiente de CI para el commit de esta entrega.

## 50. Resultado de validación de métricas visibles (25 de noviembre de 2026)

**Commit validado:** `0ae59c239ac4326334729b7307cd2fb91b64d26f`.

**Resultado de [Live Author Monitor — run 45745968724](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45745968724):**
- Bundle aislado del monitor: aprobado.
- Suite focalizada de panel/workspace: 5 pruebas, 5 aprobadas, 0 fallidas; duración reportada 105,97 ms.
- Instalación de Chromium: aprobada.
- Auditoría de esquema y mapeo físico: aprobada.
- Build global: bloqueado por `src/narrative-history.ts:7:40 — Unterminated string literal`.
- Suite completa del monitor y benchmark: omitidos porque el build global no terminó.

**Resultado de [Motor Literario TypeScript — run 45745968749](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45745968749):** el typecheck global falló por `src/narrative-history.ts(7,41): TS1002`; la suite general y el benchmark fueron omitidos.

**Conclusión:** el rechazo de arreglos dispersos y de valores `undefined` explícitos queda verificado en ambas vistas mediante las cinco regresiones de la lane aislada. La compilación global, los tests que dependen de `dist/motor-literario.js`, la integración IndexedDB/leases y el benchmark prolongado siguen sin certificación por el bloqueo narrativo externo.

**Coordinación:** después de esta entrega, `main` recibió los commits `2f1820c`, `de8675e`, `9f7f94f`, `0b6fe55` y `d57a445` de sincronización narrativa. Esta documentación se añade sobre el HEAD actual para conservar esos cambios; no se modifica ningún archivo de esa área.

## 51. Normalización defensiva de diagnósticos del anfitrión (25 de noviembre de 2026)

**Problema:** el lector seguro anterior capturaba excepciones durante la invocación del proveedor y la lectura de `documentId`, pero devolvía el objeto original. Getters/proxies defectuosos podían lanzar posteriormente al consultar `checkpointState`, `leaseState` o campos opcionales; además, el anfitrión podía mutar el objeto después de la lectura.

**Cambios:**
- Validación de los estados de checkpoint y lease contra las uniones admitidas.
- Validación de timestamp, fencing token y códigos de error opcionales, incluidos límites de longitud.
- Copia explícita de los campos primitivos en un nuevo objeto y congelación del resultado.
- Captura de excepciones de getters/proxies, devolviendo diagnóstico no disponible sin propagar mensajes internos.
- Tres regresiones nuevas: inmutabilidad/copia, getter defectuoso durante el refresco del panel y valores/estados fuera de contrato.

**Archivos:** `src/live-author-monitor-panel.ts`, `tests/live-author-monitor-diagnostics-isolation.test.mjs`, guía operativa y registro de progreso.

**Validación:** pendiente de CI para el commit de esta entrega.

## 52. Compatibilidad de las pruebas aisladas con npm test (25 de noviembre de 2026)

**Problema:** la suite de regresiones diagnósticas importaba de forma estática `dist-monitor/live-author-monitor.js`. La lane focalizada genera ese archivo, pero el flujo general `npm test` solo genera `dist/motor-literario.js`; por ello Node marcaba el archivo de pruebas completo como fallido por no encontrar el bundle aislado.

**Corrección:** la suite usa importación dinámica con fallback: primero intenta `dist-monitor` y, si no existe, importa `dist/motor-literario.js`. No se duplican tests ni se modifica el comando general.

**Resultado de CI anterior a este ajuste:** en [Live Author Monitor — run 45746448030](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45746448030), el bundle aislado y sus 8 pruebas pasaron; la suite general del monitor terminó con 163/167 aprobadas y 4 fallidas: dos pruebas de fencing/recuperación del lease y dos pruebas de conteo de tarjetas del workspace. El benchmark fue omitido tras fallar la suite.

En [Motor Literario TypeScript — run 45746447994](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45746447994), el typecheck pasó, pero la suite general terminó con 748/754 aprobadas y 6 fallidas: las cuatro anteriores, el archivo de regresiones de diagnóstico por la ruta del bundle y una regresión del módulo de integridad narrativa.

**Coordinación:** después de esa ejecución, `main` recibió `df9750c` (revalidación de fencing y leases) y `daeb8bd` (conteo correcto de tarjetas frente a elementos de métricas). No se modifican esos archivos desde esta entrega. Esta corrección restaura compatibilidad de la misma suite de diagnóstico con `npm test`.

## 53. Endurecimiento de diagnósticos y validación integral verde (25 de noviembre de 2026)

**Entrega de código:** `cea6c545c4771d31dc07b17fffe1c3ec192973d0` (normalización defensiva de diagnósticos); `1edb3e8277462ded6793f505bfcc852d19538b23` (corrección de fixture de regresión); `71d6144c820512ce5989be17d03e6cdc88d6ccdb` (fallback de importación para compatibilidad entre las lanes).

**Cambios funcionales verificados:**
- El lector del panel copia y congela los diagnósticos recibidos del anfitrión; no conserva proxies ni objetos mutables externos.
- Estados de checkpoint/lease, timestamps, fencing token y códigos de error se validan antes de presentar la información.
- Getters/proxies que fallan se reducen a diagnóstico no disponible y no interrumpen las métricas.
- La suite de regresiones usa `dist-monitor` en la lane focalizada y recurre a `dist` durante `npm test`, evitando duplicar archivos o cambiar scripts generales.

**CI específica del monitor:** [run 45746701123](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45746701123), commit `71d6144`: terminó en éxito. Bundle aislado y sus 8 pruebas aprobados; instalación de Chromium y auditoría de esquema aprobadas; build general aprobado; suite del monitor **167/167**, 0 fallidas; benchmark de heap aprobado.

**CI general TypeScript:** [run 45746700879](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45746700879), el mismo commit `71d6144`: terminó en éxito. Typecheck aprobado; suite completa **761/761**, 0 fallidas; benchmark general y benchmark del monitor aprobados.

**Medición del benchmark del monitor (Node.js v22.23.5, runner CI):**
- 8 documentos; 1.048.576 unidades UTF-16 iniciales por documento.
- 12.500 cambios confirmados por documento; 100.000 commits en total.
- 167.437,39 commits/s; tiempo total 597,24 ms.
- Heap: 5,21 MB antes; 5,58 MB tras abrir sesiones; 5,69 MB a mitad y al final de la carga.
- Heap retenido por sesiones abiertas: 0,48 MB; crecimiento de mitad a carga completa: 0 MB.
- RSS al final: 75,33 MB; los ocho documentos terminaron con 12.500 commits y 0 pendientes.

**Límite:** las cifras de heap/RSS son del proceso Node del runner, no medición física de Chromium ni del editor en producción. El resultado confirma que el estado del monitor permanece acotado en el escenario de carga medido; no sustituye un soak físico de navegador durante horas.

## 52. Reparación del fencing, reanudación y validación integral (26 de noviembre de 2026)

**Cambios en el runtime y las regresiones:**
- Se conserva el valor `undefined` al capturar la generación de un lease. Sustituirlo por `0` hacía que la respuesta de renovación se descartara por una comparación de generación aunque siguiera siendo válida.
- Las revalidaciones que llegan mientras hay un heartbeat activo comparten una promesa de seguimiento; al terminar el heartbeat se ejecuta una revalidación posterior y los callers esperan su resultado.
- El diagnóstico prioriza el estado de lease perdido cuando la titularidad ya no existe.
- El helper de pruebas del workspace identifica tarjetas por `data-document-id`, sin contar los `role=listitem` usados por las métricas accesibles.
- El pipeline general genera el bundle aislado del monitor antes de ejecutar la suite completa.

**Correcciones adicionales de tipado estricto:** se tiparon explícitamente los acumuladores de métricas y se definió el total de actividad clasificada en los caminos de restauración de checkpoint.

**Validación confirmada:** los workflows **Motor Literario TypeScript** y **Live Author Monitor** terminaron en `success` para el commit `71d6144c820512ce5989be17d03e6cdc88d6ccdb`. Se aprobaron typecheck, build, suite automatizada, regresiones de monitor, validación MLDB y benchmarks. Los commits posteriores `7a75e0e` (configuración del entrypoint aislado) y `f7dfabb` (distinción de arrays dispersos y propiedades adicionales) están sometidos a una nueva ejecución CI; su estado debe consultarse por separado.

**Alcance:** las mejoras del lease corrigen la coordinación local entre pestañas del navegador. No sustituyen un servidor remoto ni constituyen por sí solas sincronización multidispositivo.


## 54. Polling visual consciente de la visibilidad del navegador (25 de noviembre de 2026)

**Objetivo:** reducir intervalos de refresco innecesarios cuando la pestaña del editor queda suspendida/oculta y evitar que el panel se muestre desactualizado al volver a primer plano.

**Implementación:** nuevo módulo `src/live-author-monitor-visibility.ts` exporta `scheduleLiveAuthorMonitorWhileVisible()`. Panel y workspace conectan su scheduler mediante ese helper. `visibilitychange` a hidden cancela el intervalo; a visible ejecuta refresco inmediato y programa uno nuevo. Al desmontar, elimina listeners y cancela el intervalo activo.

**Aislamiento:** solo controla el polling de presentación. No pausa ni cancela checkpoints, actividad, escrituras, heartbeats o leases. La orquestación de persistencia y coordinación sigue perteneciendo al motor anfitrión.

**Regresiones:** montaje oculto no crea intervalos; volver a visible actualiza y reprograma ambas vistas; ocultar cancela; desmontar elimina listener y no permite reactivar; cancelación idempotente.

**Archivos:** nuevo `src/live-author-monitor-visibility.ts`, panel, workspace, suite de diagnóstico aislada y esta guía.

**Validación:** pendiente de los workflows CI disparados por este commit.

## 55. Descarte de ticks encolados después de suspender o desmontar (25 de noviembre de 2026)

**Endurecimiento adicional:** el scheduler de visibilidad ya no entrega el callback de la vista directamente al timer. Usa una envoltura que comprueba `document.hidden` y el flag `disposed` en el instante de ejecución. Esto descarta ticks que el event loop hubiera encolado antes de cancelar el intervalo y que lleguen tras ocultar o desmontar.

**Regresión:** se invocan deliberadamente callbacks guardados del intervalo después de ocultar y después de desmontar; ninguno puede actualizar métricas.

**Validación:** pendiente de CI para esta corrección.

## 56. CI del polling visible y descarte de ticks retrasados (25 de noviembre de 2026)

**Commit de comportamiento:** `37282e3b50b19047f656084474cb7dae7337beb3` introduce el scheduler visible para panel/workspace. **Commit de endurecimiento:** `0a21f341ae1787a4ae82255295e4fdc79e3182cd` agrega una envoltura que descarta ticks que se ejecuten después de ocultar la pestaña o desmontar la vista.

**CI de monitor aprobada:** [Live Author Monitor — run 45747598005](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45747598005), `success` sobre `0a21f34`. Bundle focalizado, 10/10 regresiones aisladas, Chromium, validación MLDB, build runtime, **169/169 pruebas del monitor** y benchmark en verde.

**Benchmark específico:** Node.js v22.23.5; 8 documentos de 1.048.576 unidades UTF-16; 100.000 commits; 274.897,17 commits/s; 363,77 ms; heap 5,23 MB antes de carga y 5,71 MB a mitad/final; heap retenido por sesiones abiertas 0,48 MB; crecimiento de mitad a carga completa 0 MB; RSS final 73,89 MB; 12.500 commits confirmados y cero pendientes en cada documento.

**CI general:** [Motor Literario TypeScript — run 45747598008](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45747598008) seguía `in_progress` en la instalación de Chromium cuando se registró este avance (última actualización del run: 03:14:12 UTC, 26 de noviembre). No se atribuye resultado de typecheck ni suite general a esta ejecución mientras ese paso no termine.

**Alcance:** el scheduler opera solo sobre timers de refresco visual. Los checkpoints, los heartbeats y la propiedad del lease siguen activos independientemente de la visibilidad.

## 57. Verificación general completa en commit descendiente (26 de noviembre de 2026)

**CI de monitor en el commit exacto del endurecimiento:** [Live Author Monitor — run 45747598005](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45747598005), `success` para `0a21f341ae1787a4ae82255295e4fdc79e3182cd`. Pasaron 10/10 regresiones aisladas, 169/169 pruebas del monitor, Chromium, auditoría MLDB, build runtime y benchmark.

**CI general en su descendiente directo:** [Motor Literario TypeScript — run 45747608045](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45747608045), `success` para `c90fa1ad3b3174b205564cd71a60f91ace30c4b7`. La comparación GitHub confirma que `c90fa1a` está un commit por delante de `0a21f34`, sin divergencia. Por tanto incluye el scheduler de visibilidad y el guard contra ticks retrasados. Typecheck aprobado, suite general **775/775**, 0 fallidas, benchmarks general y del monitor aprobados.

**Benchmark del monitor en el workflow general:** Node.js v22.23.5; 8 documentos; 100.000 commits; 200.274 commits/s; heap retenido 0,48 MB; crecimiento de mitad a final 0 MB; RSS final 75,32 MB; todos los documentos finalizaron con 12.500 commits y cero pendientes.

El workflow específico en `0a21f34` midió 274.897,17 commits/s y RSS final 73,89 MB. Las diferencias entre ejecuciones reflejan variación del runner; no deben interpretarse como una regresión entre mediciones.

El run general original `45747598008` permaneció sin actualizar durante la instalación de Chromium. Su validación fue superada por el run descendiente `45747608045`, que finalizó correctamente.

## 58. Page Lifecycle: restauración BFCache y congelación de pestaña (25 de noviembre de 2026)

**Motivación:** Page Visibility cubre el cambio visible/oculto, pero Chromium también puede congelar una página o conservarla en Back/Forward Cache. La interfaz necesita revalidar sus métricas al recibir señales del ciclo de vida, sin despertar mientras siga oculta.

**Implementación:** `scheduleLiveAuthorMonitorWhileVisible()` escucha `pagehide/pageshow` en la ventana propietaria y `freeze/resume` en el documento, además de `visibilitychange`. Las transiciones comparten un estado activo que impide doble cancelación/reanudación; la restauración ejecuta una lectura inmediata y solo rearma el intervalo si el documento está visible.

**Regresiones:** pagehide cancela e invalida ticks encolados; pageshow refresca y rearma; freeze/resume repite el ciclo; pageshow/resume no reactivan un documento oculto; al desmontar se eliminan todos los listeners de documento y ventana.

**Archivos:** `src/live-author-monitor-visibility.ts`, `tests/live-author-monitor-diagnostics-isolation.test.mjs`, guía operativa y progreso.

**Validación:** pendiente de CI para esta entrega.

## 59. Integración de Page Lifecycle en Chromium (25 de noviembre de 2026)

**Cobertura nueva:** se añade un harness HTML servido por Vite y una prueba Playwright dedicada que importa el módulo TypeScript real en Chromium. Se prueban `pagehide/pageshow`, `freeze/resume` y `visibilitychange` sobre EventTarget nativos, con intervalos inyectados deterministas.

**Invariantes probadas:** `pagehide` detiene el intervalo; `pageshow` refresca exactamente una vez; `freeze/resume` comparte la misma máquina de estados; una señal de reanudación no inicia el polling mientras el documento sigue oculto; ticks anteriores y callbacks posteriores al desmontaje se descartan.

**Alcance:** la prueba despacha las señales del navegador de forma controlada. No equivale a forzar una congelación física del proceso ni garantiza BFCache real en todos los entornos.

**Archivos:** `tests/live-author-monitor-lifecycle-browser.test.mjs`, `tests/browser/live-author-monitor-lifecycle.html` y documentación operativa.

**Validación:** pendiente de CI para esta entrega.

## 60. Fallback seguro cuando Page Visibility no está disponible (25 de noviembre de 2026)

**Problema:** el scheduler tenía dos caminos distintos. Con una API `Document` completa, los callbacks periódicos quedaban protegidos por `disposed`; en el fallback (entornos sin `document.hidden` o sin listeners de visibilidad), se devolvía directamente la cancelación del temporizador. Un tick ya encolado podía ejecutarse después del desmontaje, aunque el intervalo se hubiera cancelado.

**Cambio:** el fallback ahora envuelve el callback con un indicador de disposición, valida que el planificador devuelva una función de cancelación y expone una cancelación idempotente. No intenta simular Page Visibility cuando el navegador no ofrece esa API: mantiene el polling normal mientras la vista está montada.

**Regresiones añadidas:** dos pruebas cubren (1) callback atrasado después del desmontaje y cancelación idempotente; (2) rechazo de un planificador sin función de cancelación y desactivación de su callback pendiente.

**Archivos:** `typescript/src/live-author-monitor-visibility.ts`, `typescript/tests/live-author-monitor-diagnostics-isolation.test.mjs`, esta bitácora y `LIVE_AUTHOR_MONITOR_OPERATIONS.md`.

**Validación:** las regresiones quedan incorporadas a la lane específica del monitor y a `npm test`. No se declara ejecución aprobada en el momento de crear este commit; se registrará el resultado real de GitHub Actions cuando finalice.

**Aislamiento:** no se modifican `HostEngineApi`, persistencia IndexedDB, leases, contratos narrativos ni archivos incluidos en el PR #56.


## 61. Fencing de ticks entre suspensiones y reanudaciones (26 de noviembre de 2026)

**Hallazgo:** el scheduler protegía un tick mientras la vista estaba suspendida, pero la guarda solo comprobaba `active`. Si un tick del intervalo A quedaba encolado, la página se suspendía y luego volvía a activarse, ese callback antiguo podía ejecutarse cuando `active` volvía a `true`, aunque ya existiera un intervalo B.

**Corrección:** cada intervalo obtiene una generación monotónica. Suspender, cancelar, fallar al programar o desmontar invalida la generación anterior. Un callback solo puede refrescar cuando pertenece a la generación vigente. Si el scheduler dispara una transición síncrona antes de devolver su cancelación, el intervalo recién creado se cancela inmediatamente.

**Recuperación ante errores del scheduler:** un fallo al rearmar deja la máquina inactiva y permite que otra señal `pageshow`, `resume` o `visibilitychange` intente programar de nuevo. Si el montaje inicial falla después de encolar un callback, se invalidan los ticks antes de limpiar los listeners.

**Regresiones añadidas:** tres pruebas cubren ticks antiguos después de reanudar; fallo durante el rearmado con callback huérfano y reintento; y fallo durante el montaje con limpieza de listeners.

**CI anterior:** el cambio de fallback del commit `31bd3b0124026cfa1512a1615b745ac253216277` terminó correctamente en [Live Author Monitor — run 45750290858](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45750290858) y [Motor Literario TypeScript — run 45750290828](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45750290828). La nueva corrección de generaciones queda pendiente de sus propias ejecuciones.

**Archivos:** `typescript/src/live-author-monitor-visibility.ts`, `typescript/tests/live-author-monitor-diagnostics-isolation.test.mjs`, esta bitácora y `LIVE_AUTHOR_MONITOR_OPERATIONS.md`.

**Aislamiento:** no se modifican HostEngineApi, persistencia, IndexedDB, leases ni archivos del PR #56.


## 62. Limpieza completa ante errores al desmontar (26 de noviembre de 2026)

**Hallazgo:** la liberación de listeners y el intervalo estaban protegidos parcialmente. Si `removeEventListener` lanzaba al retirar un listener de `window`, la ejecución salía antes de retirar los listeners de `document` y antes de cancelar el timer. Un error individual podía dejar recursos del panel montados.

**Corrección:** el desmontaje intenta retirar cada listener de manera independiente, intenta siempre cancelar el intervalo y conserva el primer error de limpieza para comunicarlo al llamador después de completar los intentos. La bandera `disposed` se establece antes de limpiar, por lo que los callbacks encolados quedan invalidados incluso cuando alguna operación de limpieza falla.

**Regresión:** se fuerza un error al retirar `pagehide` y otro al retirar `freeze`. La prueba verifica que se intentan los cinco listeners, que el intervalo siempre se cancela, que no quedan listeners en el harness y que una segunda llamada a `dispose` no repite la limpieza.

**Validación:** pendiente de GitHub Actions para este commit. La corrección anterior de generaciones ya está cubierta por los workflows aprobados del commit `de4f2001ddbd0c9e60850abeeb3acfcbc70edc69`.

**Archivos:** `typescript/src/live-author-monitor-visibility.ts`, `typescript/tests/live-author-monitor-diagnostics-isolation.test.mjs`, esta bitácora y `LIVE_AUTHOR_MONITOR_OPERATIONS.md`.


## 63. Recuperación de desuscripciones fallidas sin duplicar la fuente (26 de noviembre de 2026)

**Hallazgo:** `detachSource()` borraba la referencia al disposer antes de invocarlo. Si el editor lanzaba durante la cancelación de la fuente al producirse un overflow, el listener podía seguir instalado pero el enlace perdía la única referencia para volver a cerrarlo. Al confirmar después el snapshot común, `discardPendingAfterResynchronization()` podía abrir una segunda suscripción y recibir cada edición dos veces.

**Corrección:** el enlace conserva el disposer hasta que la fuente confirma la desuscripción. La resincronización vuelve a intentar cerrar el listener anterior y no abre otro mientras la operación siga fallando. `attachSource()` guarda el disposer antes de procesar los eventos síncronos que pueda emitir el proveedor; esto también permite cerrar de forma verificable una suscripción que desborda durante su propio montaje.

**Cierre manual:** `stop()` intenta liberar tanto la fuente como la señal de reintento. Si falla alguna operación, informa el primer error, mantiene el disposer pendiente y permite que una llamada posterior vuelva a intentarlo. Los callbacks quedan bloqueados en cuanto el enlace se dispone.

**Regresiones añadidas:** (1) desuscripción transitoriamente fallida durante overflow, con verificación de que solo exista un listener después de resincronizar y de que la siguiente edición llegue una vez; (2) desuscripción fallida durante stop, con callback tardío ignorado y segundo intento exitoso.

**Validación:** pendiente de CI para este commit. No se cambia la política FIFO ni se descartan datos salvo después del snapshot autoritativo que exige el contrato.

**Archivos:** `typescript/src/live-author-monitor-change-binding.ts`, `typescript/tests/live-author-monitor-change-binding.test.mjs`, esta bitácora y `LIVE_AUTHOR_MONITOR_OPERATIONS.md`.


## 64. Snapshot de backlog inmutable a nivel de cada delta (26 de noviembre de 2026)

**Hallazgo:** `getPendingChanges()` congelaba el arreglo devuelto, pero sus elementos seguían siendo referencias a los objetos internos de la cola. Un consumidor JavaScript podía modificar `snapshot[0].replacement` y alterar el cambio que se reenviaría al anfitrión, pese a que la API prometía una copia inmutable.

**Corrección:** la consulta devuelve un nuevo arreglo congelado y crea una copia simple de cada campo permitido de `EditorChange`; cada objeto resultante también queda congelado. La copia no expone propiedades añadidas por el proveedor y no comparte referencias con el delta original ni con la cola interna.

**Regresión:** se comprueba que el arreglo y cada delta estén congelados, que el objeto sea distinto del original, que los campos coincidan y que un intento de mutación lance sin cambiar el contenido que sigue pendiente.

**Validación verificada:** [Live Author Monitor — run 45751188342](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45751188342) y [Motor Literario TypeScript — run 45751188331](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45751188331) finalizaron en `success` para el commit `eebb84d`. La lane específica completó bundle aislado, regresiones, Chromium, auditoría MLDB, build runtime, suite completa del monitor y benchmark. El workflow general completó type-check, build, suite automatizada y benchmark.

**Validación previa de recuperación FIFO:** el commit `e85f5302bc37eafa9af762734b28cf87633c07cc` también pasó en [Live Author Monitor — run 45751018096](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45751018096) y [Motor Literario TypeScript — run 45751018120](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45751018120).

**Archivos:** `typescript/src/live-author-monitor-change-binding.ts`, `typescript/tests/live-author-monitor-change-binding.test.mjs`, esta bitácora y `LIVE_AUTHOR_MONITOR_OPERATIONS.md`.


## 65. Inmutabilidad de los deltas retenidos en la cola FIFO (26 de noviembre de 2026)

**Hallazgo:** aunque `EditorChange` declara campos `readonly`, el runtime JavaScript no impide que la fuente o un callback de observabilidad modifique el objeto. El enlace retenía la misma referencia después de un rechazo o error de envío. Una mutación posterior podía cambiar el reemplazo, offsets o metadatos antes del reintento FIFO.

**Corrección:** cada delta que entra en el backlog se copia a un objeto plain-data con los campos definidos por `EditorChange` y se congela inmediatamente. Esto se aplica al primer rechazo, a errores del sink y a los deltas posteriores que llegan mientras existe backlog. El sink recibe esas copias congeladas durante los reintentos. `getPendingChanges()` reutiliza el mismo copiador para producir instantáneas independientes.

**Regresión:** el primer delta es rechazado y el callback `onAdmission` altera el objeto externo; el segundo delta se conserva y luego la fuente altera su objeto original. En ambos casos el backlog retiene el reemplazo original y el sink reintenta copias congeladas en el orden 1, 2.

**Validación:** pendiente de CI para este commit. La protección de las instantáneas de diagnóstico del commit `eebb84da3fff3acc5d92b565892d8789401f7d70` pasó la lane del monitor [run 45751188342](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45751188342); el workflow general aprobó type-check, build y suite, con benchmark incluido en [run 45751188331](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45751188331).

**Archivos:** `typescript/src/live-author-monitor-change-binding.ts`, `typescript/tests/live-author-monitor-change-binding.test.mjs`, esta bitácora y `LIVE_AUTHOR_MONITOR_OPERATIONS.md`.


## 66. Separación entre contrapresión recuperable y rechazo que exige resincronización (26 de noviembre de 2026)

**Hallazgo:** el binding retenía cualquier `ChangeAdmission` rechazado en la cola FIFO y asignaba a casi todos el motivo genérico `rejected`. Sin embargo, el motor distingue `queue_full` (transitorio) de `invalid_change`, `unknown_document`, `change_too_large` y `resync_required`. Reintentar estos últimos sin reconciliar no corrige su causa; además, mantiene bloqueadas las ediciones posteriores detrás del primer delta imposible de admitir.

**Corrección:** solo `queue_full` permanece en estado `backpressured` y puede resolverse con `retryPending()`. Los demás rechazos detienen la fuente y pasan a `resync-required`; el backlog existente se conserva sin reordenarlo hasta que el anfitrión confirme un snapshot autoritativo y llame `discardPendingAfterResynchronization()`. Un rechazo terminal de la primera edición se conserva como copia congelada dentro del backlog acotado para que la integración lo inspeccione; no se reintenta y solo se elimina al confirmar el snapshot común. Su secuencia se informa mediante `resyncSequence`.

**Diagnóstico:** `LiveAuthorMonitorBackpressureSnapshot.reason` conserva el motivo real y agrega `resyncSequence`; `overflowSequence` queda reservado para desbordamientos del buffer. Se añade `LiveAuthorMonitorAdmissionResynchronizationError` con código estable y sin contenido del manuscrito.

**Regresiones:** rechazos permanentes en la admisión inicial para las cuatro razones; pausa de fuente y rearme solo tras snapshot; y rechazo permanente al reintentar la cabeza FIFO, comprobando que se conserva toda la cola.

**Validación:** pendiente de CI para este commit. La validación general del commit `eebb84d` pasó type-check, build, suite y benchmark; la lane específica del monitor también aprobó su suite y benchmark en [run 45751188342](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45751188342).

**Archivos:** `typescript/src/live-author-monitor-change-binding.ts`, `typescript/tests/live-author-monitor-change-binding.test.mjs`, esta bitácora y `LIVE_AUTHOR_MONITOR_OPERATIONS.md`.


## 67. Pausa antes de notificar rechazos para evitar reentrancia del editor (26 de noviembre de 2026)

**Hallazgo:** al recibir un rechazo permanente, el binding notificaba primero `onAdmission` y pausaba la fuente después. Un callback de observabilidad podía provocar una emisión síncrona de la fuente antes de que se activara `resyncRequired`; esa nueva edición podía admitirse detrás de la secuencia rechazada, violando el orden de captura.

**Corrección:** la transición a `resync-required` y la desuscripción de la fuente ocurren antes de ejecutar `onAdmission`, tanto en la primera admisión como durante `retryPending()`. El callback conserva su notificación, pero ya no puede introducir eventos en el stream pausado.

**Regresiones:** dos pruebas fuerzan emisiones reentrantes desde `onAdmission`: una para el rechazo inicial y otra para el rechazo permanente de la cabeza FIFO durante el reintento. Ambas comprueban que no se intenta admitir la secuencia reentrante y que la fuente se reactiva solo después del snapshot común.

**Validación:** pendiente de CI para el commit que incorpore esta corrección.


## 68. Conservación del delta rechazado hasta confirmar el snapshot (26 de noviembre de 2026)

**Corrección de integración:** la validación de `785e778` detectó que la nueva pausa para rechazos permanentes retiraba la fuente, pero no conservaba el delta que originó el rechazo. La integración transaccional necesita inspeccionar ese backlog y verificar que el snapshot autoritativo realmente lo cubre antes de reanudar el editor.

**Ajuste:** los rechazos permanentes iniciales se copian al backlog acotado y congelado antes de pausar. El binding no reintenta ese delta ni procesa eventos posteriores; el anfitrión puede consultar la secuencia y solo elimina el backlog al completar `discardPendingAfterResynchronization()` después de validar el snapshot común. El caso distinto de overflow sigue sin guardar el delta que excedió el límite, porque no cabe en el buffer.

**Reentrancia:** la fuente queda pausada antes de notificar `onAdmission`, por lo que callbacks síncronos no pueden adelantar una nueva transacción.

**Validación previa:** [Live Author Monitor — run 45751720044](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45751720044) ejecutó build, Chromium y auditoría correctamente, pero falló una prueba de integración transaccional porque esperaba el delta rechazado en el backlog. La corrección conserva explícitamente ese contrato; el nuevo commit queda pendiente de CI.


## 69. Notificación única después de pausar durante retry FIFO (26 de noviembre de 2026)

**Fallo detectado en CI:** la regresión reentrante mostró que `retryPending()` notificaba `onAdmission` dos veces para un rechazo permanente: una vez antes de pausar y otra después. La primera notificación todavía permitía que una emisión síncrona del callback se incorporara al backlog detrás del delta bloqueado.

**Corrección:** el camino `queue_full` notifica una sola vez y mantiene el estado recuperable. Para los rechazos permanentes, primero ejecuta la transición `resync-required` y desacopla la fuente, y luego notifica `onAdmission` una única vez. El cambio conserva el delta rechazado y el resto del backlog hasta el snapshot común.

**Regresión:** el test `un onAdmission reentrante no puede adelantar cambios al rechazo permanente durante retryPending` falla con la implementación duplicada y valida el orden de notificación después de esta corrección.

**CI (corrección validada):** las ejecuciones posteriores al ajuste del fixture, sobre el commit `9bcfd478`, aprobaron ambas lanes: [Live Author Monitor — run 45752316925](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45752316925) y [Motor Literario TypeScript — run 45752316941](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45752316941). Las pruebas confirman el rechazo permanente notificado una sola vez después de pausar y la preservación del backlog.


## 70. Fixture de recuperación reentrante: admisión válida después del snapshot (26 de noviembre de 2026)

**Ajuste de prueba tras CI:** la regresión de reentrancia dejaba al sink configurado para devolver `unknown_document` a cualquier secuencia después de liberar capacidad. Por eso el cambio nuevo posterior al snapshot también se rechazaba y el test intentaba detenerse con backlog pendiente. El fixture ahora rechaza terminalmente solo la cabeza `sequence=1`, devuelve `queued` para la nueva `sequence=4` después de reconciliar y comprueba que `unknown_document` se notifica exactamente una vez.

**Evidencia:** [Motor Literario TypeScript — run 45752135449](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45752135449) pasó type-check y ejecutó 819/820 pruebas; la única fallida fue este fixture con un sink de prueba que rechazaba también la edición posterior. La lane específica [Live Author Monitor — run 45752135425](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45752135425) ya había completado las regresiones aisladas; el conjunto de monitor seguía avanzando en Chromium al último chequeo.

**Validación:** aprobada en ambas lanes sobre `9bcfd478`: [Live Author Monitor — run 45752316925](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45752316925) y [Motor Literario TypeScript — run 45752316941](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45752316941).


## 71. Snapshot inmutable de eventos transaccionales reentrantes (26 de noviembre de 2026)

**Hallazgo:** `handleTransaction()` colocaba en `pendingTransactions` la referencia original del proveedor. Cuando un suscriptor del monitor provoca otra transacción sincrónicamente, el segundo evento queda en cola hasta terminar la primera entrega; un proveedor que reutiliza o modifica el objeto después de `publish()` podía alterar el reemplazo, rango o revisión que finalmente procesaba el monitor.

**Corrección:** al entrar en la frontera del proveedor se copia una sola vez el identificador, tipo y todos los campos del contrato `EditorChange`. Tanto el contenedor de transacción como el delta retenido se congelan. Si la lectura de un getter/proxy falla durante la copia, el source entra en `invalid-transaction` y desacopla el proveedor sin propagar la excepción al editor.

**Regresión:** un suscriptor del source provoca una segunda transacción mientras se procesa la primera y modifica el reemplazo del objeto original antes de que se drene la cola. El monitor debe entregar el texto original (`B`), conservar la longitud UTF-16 y seguir sincronizado.

**Validación:** aprobada en ambas lanes sobre `71cf0d13`: [Live Author Monitor — run 45752453251](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45752453251) completó el build aislado, regresiones diagnósticas, Chromium, auditoría MLDB, build de runtime, suite específica y benchmark de memoria; [Motor Literario TypeScript — run 45752453216](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45752453216) completó type-check, build, suite y benchmark.


## 72. Validación runtime de categorías de actividad del editor (26 de noviembre de 2026)

**Hallazgo:** `EditorChange.activityKind` declara siete valores (`typing`, `paste`, `deletion`, `correction`, `undo`, `redo`, `other`), pero el source transaccional aceptaba sin validar cualquier valor procedente del proveedor. Un editor defectuoso podía propagar objetos o etiquetas ajenas al contrato hacia el anfitrión y las métricas.

**Corrección:** el source valida la categoría opcional antes de aceptar la transacción. Los valores desconocidos provocan `invalid-transaction`, pausan y desacoplan el proveedor, sin emitir el delta al monitor. La ausencia del campo sigue siendo válida y las transacciones nativas `undo`/`redo` conservan su actividad derivada del tipo de transacción.

**Regresión:** se cubren una cadena desconocida, un objeto mutable y un número, verificando que ninguno alcanza los suscriptores y que el source exige resincronización.

**Validación:** pendiente de CI para este commit.


## 73. Reintento seguro al cerrar listeners del proveedor transaccional (26 de noviembre de 2026)

**Hallazgo:** `detachProvider()` borraba `unsubscribeProvider` antes de llamar al proveedor. Si el editor lanzaba una excepción, el handle quedaba perdido y el listener podía seguir activo; una resincronización posterior podía abrir otro listener, y `dispose()` repetido no podía liberar el primero.

**Corrección:** el source conserva el disposer hasta que la llamada de cancelación termina correctamente. `attachProvider()` intenta cerrar cualquier handle anterior y rechaza abrir una segunda suscripción si el anterior todavía no se ha liberado. `dispose()` reintentado vuelve a ejecutar la limpieza aunque la instancia ya esté marcada como dispuesta. La integración pública también permite repetir `dispose()` para reintentar tanto el binding como el proveedor.

**Regresiones:** una cancelación que falla una vez se reintenta antes de reanudar el proveedor; otra prueba confirma que un `dispose()` posterior termina de retirar el listener; una prueba de integración fuerza dos fallos transitorios y verifica que la segunda llamada pública libera el único listener restante.

**Validación:** pendiente de CI para este commit.


## 74. Distinguir cancelador activo de cancelador que falló (26 de noviembre de 2026)

**Fallo detectado en CI:** la primera implementación conservaba correctamente el handle cuando `unsubscribe()` lanzaba, pero `attachProvider()` trataba cualquier handle presente como si el cierre hubiera fallado. Durante `resynchronize()`, el callback `beforeResume` puede volver a registrar la fuente; una segunda llamada a `attachProvider()` retiraba el listener recién creado y lo suscribía otra vez, elevando el contador de suscripciones de 2 a 3. Además, TypeScript detectó una comprobación redundante del handle después de llamar al método.

**Corrección:** se introduce `providerDetachFailed`, que solo se activa al capturar una excepción de cancelación. Si hay disposer y no existe fallo registrado, la suscripción ya está activa y `attachProvider()` retorna sin alterarla. Solo se vuelve a intentar un handle marcado como fallido; al cerrarlo con éxito se limpia el estado. La comprobación posterior usa el flag explícito, evitando el estrechamiento de tipos redundante.

**Regresión:** la prueba de resincronización transaccional confirma que se crea exactamente una nueva suscripción tras retirar la anterior; las pruebas de cancelación fallida siguen verificando reintento y `dispose()` repetido.

**Validación:** [Live Author Monitor — run 45753400038](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45753400038) aprobó todas las pruebas específicas del monitor y el benchmark. [Motor Literario TypeScript — run 45753400053](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45753400053) pasó type-check; su suite global registró 847/849 pruebas aprobadas y falló solo en las dos pruebas de sincronización narrativa indicadas en la sección 73. La corrección de listener activo/failed-detach pasó la lane específica.


## 75. Propagar fallos de limpieza al llamador sin perder el cancelador (26 de noviembre de 2026)

**Hallazgo:** el source ya retenía el disposer después de una excepción del proveedor y una llamada posterior a `dispose()` podía reintentarla, pero la primera llamada devolvía éxito aunque el listener siguiera registrado. El consumidor no tenía una señal síncrona fiable de que debía repetir la limpieza.

**Corrección:** `dispose()` ahora comprueba `providerDetachFailed` después del intento de cancelación y lanza un error explícito si el listener no pudo retirarse. El objeto queda marcado como dispuesto, borra sus colas internas y conserva el handle fallido. Una segunda llamada vuelve a intentar el mismo cancelador; si tiene éxito, `dispose()` vuelve a ser idempotente. La integración pública propaga ese error, pero también permite repetir su propio `dispose()` para finalizar la liberación.

**Regresiones:** la prueba de source exige que la primera llamada lance cuando el proveedor falla una vez y que la segunda complete la retirada; la prueba de integración fuerza dos fallos transitorios (binding y source), exige el error al llamador y verifica que la segunda llamada pública elimina el último listener.

**Validación:** [Live Author Monitor — run 45753736832](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45753736832) aprobó build aislado, regresiones diagnósticas, Chromium, auditoría MLDB, build runtime, suite completa del monitor y benchmark de memoria. La lane posterior [Live Author Monitor — run 45753916861](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45753916861) también terminó correctamente con las aserciones de error visibles en ambos niveles (`source.dispose()` e integración). [Motor Literario TypeScript — run 45753916798](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45753916798) pasó type-check y ejecutó 857 pruebas: 855 aprobadas y 2 fallidas en los handlers de sincronización narrativa `assertion-upsert` y `entity-upsert`, fuera de los archivos del monitor.


## 76. Incluir `activityKind` en la firma de deduplicación (26 de noviembre de 2026)

**Hallazgo:** la ventana de deduplicación comparaba ID, secuencia, tipo de transacción, revisión, offsets y hash del reemplazo, pero omitía `activityKind`. Una retransmisión con el mismo `transactionId` y delta textual, pero con categoría diferente (`typing` frente a `paste`, por ejemplo), se trataba como duplicado idéntico y la categoría que alcanzaba las métricas dependía del primer evento.

**Corrección:** la firma compacta incluye ahora la categoría efectiva del delta. Para transacciones normales conserva `change.activityKind`; para `undo` y `redo` usa el tipo nativo porque esa es la categoría que realmente publica el adaptador. La comparación rechaza una reutilización semánticamente distinta del mismo ID y exige resincronización.

**Regresión:** el mismo transactionId, secuencia y texto retransmitidos con `activityKind: "paste"` después de la transacción original sin categoría dejan de pasar como duplicado; el source pausa con `transaction-id-reused`.

**Validación:** aprobada en [Live Author Monitor — run 45753916861](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45753916861), que completó build, suite específica, Chromium y benchmark. [Motor Literario TypeScript — run 45753916798](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45753916798) pasó type-check; la suite general mantiene los dos fallos ajenos al monitor indicados en la sección 75.


## 77. Presupuesto de texto para la cola reentrante del editor (26 de noviembre de 2026)

**Hallazgo:** el source limitaba la cantidad de transacciones reentrantes (4096), pero no la cantidad total de unidades de reemplazo que podía retener. Una ráfaga de pocos pegados muy grandes podía ocupar una cantidad desproporcionada de memoria mientras esperaba a que terminara el callback que estaba procesando una transacción anterior.

**Corrección:** se añade `maxQueuedTextUnits` (predeterminado `4_194_304`, alineado con `EngineOptions.maxQueuedTextUnits`). El contador solo aplica a deltas realmente reentrantes en espera; un pegado grande que llega con el source en reposo sigue procesándose y no se rechaza por un límite de backlog que no está usando. Si un evento reentrante excede el presupuesto restante, el source pausa el proveedor y exige un snapshot común con `transaction-backlog-overflow`. El contador se reduce al sacar cada evento de la cola y se reinicia al disponer o al limpiar una resincronización fallida.

**Configuración:** el límite se puede fijar tanto en `LiveAuthorMonitorEditorTransactionSourceOptions` como en `LiveAuthorMonitorEditorTransactionIntegrationOptions`; se valida antes de consultar o suscribir el anfitrión/editor.

**Regresiones:** una prueba provoca un pegado reentrante individual de dos unidades con un presupuesto de una; otra encola dos ediciones reentrantes de una unidad cada una para comprobar que el límite es agregado. Ambas verifican que el delta que desborda no llega al monitor y que el source se pausa. También se comprueba que un pegado de cinco unidades en reposo se admite pese al presupuesto de backlog igual a uno, y que la integración rechaza un límite cero antes de consultar el anfitrión.

**Validación de la implementación base:** [Live Author Monitor — run 45754354474](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45754354474) aprobó build aislado, regresiones diagnósticas, Chromium, auditoría MLDB, build runtime, suite del monitor y benchmark. [Motor Literario TypeScript — run 45754354266](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45754354266) pasó type-check y ejecutó 863 pruebas: 861 aprobadas y 2 fallidas en los handlers ajenos al monitor `assertion-upsert` y `entity-upsert`, documentados en la sección 75. **Cobertura agregada adicional:** la prueba que encola dos eventos reentrantes pequeños y verifica el presupuesto acumulado se añadió en `eae1281`; sus nuevas ejecuciones [Live Author Monitor — run 45754532122](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45754532122) y [Motor Literario TypeScript — run 45754532101](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45754532101) siguen en curso al momento de esta anotación.


## 78. Entrega FIFO de snapshots ante callbacks reentrantes (26 de noviembre de 2026)

**Hallazgo:** `publish()` recorría el conjunto de listeners directamente. Si un panel provocaba otra admisión síncrona durante la notificación del primer snapshot, la publicación anidada recorría todos los listeners antes de que terminara la publicación exterior. Un segundo panel podía recibir la secuencia 2 y después la secuencia 1, haciendo retroceder visualmente sus métricas aunque el motor estuviera correcto.

**Corrección:** las publicaciones se serializan mediante una cola FIFO de snapshots inmutables. Cada snapshot conserva los destinatarios que estaban suscritos al publicarse; las altas no reciben estados pasados y las bajas se comprueban antes de invocar cada callback. Las excepciones siguen aisladas. `dispose()` limpia la cola y la colección de suscriptores, evitando entregas pendientes tras el desmontaje.

**Regresiones:** se añaden pruebas para (1) admisión reentrante y orden monotónico observado por un segundo panel, (2) alta/baja de suscriptores durante una notificación y (3) `dispose()` durante una publicación con una segunda notificación encolada.

**Validación observada en el commit \`7f167c93\`:** el build aislado del monitor pasó y las 17 regresiones de recuperación diagnóstica aprobaron. La lane se detuvo en la auditoría de almacenamiento antes de ejecutar el bundle runtime, las pruebas específicas nuevas y el benchmark: detectó \`DATABASE_VERSION_MISMATCH\` y el almacén \`narrative-reference-repair-audits\` sin mapear. El workflow general falló el type-check por tres errores en \`narrative-knowledge-graph-persistence.ts\` (líneas 434, 796 y 797), archivo ajeno al monitor. La cobertura de las nuevas tres pruebas queda pendiente de ejecutar en la lane dedicada.


## 79. No bloquear las regresiones del monitor por fallos de auditoría compartida (26 de noviembre de 2026)

**Hallazgo de CI:** el workflow del monitor ejecuta la auditoría de esquema antes de las pruebas del runtime. Un fallo simultáneo en el manifiesto IndexedDB impide ejecutar la suite específica y el benchmark del monitor, aun cuando el build aislado y la suite diagnóstica ya hayan pasado.

**Cambio de CI:** los pasos de bundle runtime, pruebas del monitor y benchmark se ejecutan con \`if: \${{ !cancelled() }}\`. Una auditoría fallida conserva la conclusión global de fallo, pero ya no bloquea evidencia independiente de la implementación del monitor. La condición no continúa tras una cancelación y no convierte los fallos de auditoría en éxito.

**Causa externa observada en \`7f167c93\`:** la auditoría reportó \`DATABASE_VERSION_MISMATCH\` y el almacén \`narrative-reference-repair-audits\` fuera de \`runtime.object_stores\`; el type-check global reportó errores en \`narrative-knowledge-graph-persistence.ts\`. Esos errores no pertenecen a los archivos modificados por la mejora FIFO.

**Validación:** pendiente de la nueva ejecución de la lane disparada por el cambio del workflow.


## 80. Ejecutar regresiones FIFO y benchmark desde el bundle aislado (26 de noviembre de 2026)

**Hallazgo:** la lane ampliada continuó tras fallos previos, pero el bundle runtime general falló por un error de sintaxis concurrente en `src/persistence/indexeddb-store.ts`. Las suites que importaban `dist/motor-literario.js` y el benchmark no podían usar ese artefacto, por lo que las tres regresiones FIFO nuevas todavía no habían sido ejecutadas.

**Corrección:** el test principal de `LiveAuthorMonitor` y el benchmark cargan primero `dist-monitor/live-author-monitor.js`, generado por el entrypoint reducido, y usan el bundle general solo como fallback. La lane ejecuta las pruebas unitarias y diagnósticas incluso cuando la compilación global falla. Las pruebas que dependen de HostEngineApi/editor/Chromium quedan condicionadas al resultado correcto del bundle runtime; la auditoría MLDB conserva su resultado propio.

**Validación en [Live Author Monitor — run 45755687906](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45755687906):**
- Build aislado: correcto.
- Recuperación diagnóstica: 17/17 aprobadas.
- Suite principal + diagnósticos: 37/37 aprobadas, incluidas las tres pruebas de snapshots FIFO, cambios de suscripción durante notificaciones y `dispose()` reentrante.
- Benchmark de memoria: correcto sobre Node.js 22.23.5, 8 documentos de 1.048.576 unidades UTF-16 cada uno, 12.500 cambios por documento y 100.000 commits totales. Tiempo: 507,42 ms; rendimiento: 197.074 commits/s; heap tras GC: 4,26 MiB al 50 % y 4,26 MiB al 100 %; heap retenido por sesiones abiertas: 0,49 MiB; cambios pendientes al cierre: 0 en los ocho documentos. La privacidad del benchmark confirma que solo se conservan métricas y longitudes, no el texto.
- Integraciones de host/editor/browser: omitidas correctamente porque el bundle runtime general falló antes.
- La lane completa conserva estado fallido por controles compartidos: `DATABASE_VERSION_MISMATCH`, dos almacenes de reparación fuera de `runtime.object_stores` y un error de sintaxis en `src/persistence/indexeddb-store.ts` durante el bundle general. No se atribuyen esos fallos al núcleo de monitoreo.

**Límite de responsabilidad:** no se modifica `indexeddb-store.ts` ni el manifiesto físico que otro trabajo está actualizando. La comprobación independiente del núcleo de monitoreo queda aprobada; la integración completa sigue pendiente de esos arreglos externos.



## 81. No bloquear pruebas puras del monitor instalando Chromium antes de tiempo (26 de noviembre de 2026)

**Hallazgo:** Chromium se instalaba antes de la auditoría y del bundle runtime, aunque las pruebas unitarias de `LiveAuthorMonitor` y el benchmark de heap no usan navegador. El coste de instalar el navegador demoraba evidencia independiente en un escenario donde el bundle runtime podía fallar por módulos externos al monitor.

**Ajuste:** se mueve la instalación de Chromium después de `runtime-build` y se condiciona a su resultado `success`. Las pruebas unitarias FIFO y el benchmark ocurren antes, independientemente del fallo de auditoría o del runtime; las pruebas de integración multi-pestaña conservan Chromium cuando realmente pueden ejecutarse.

**Validación:** comprobada en [Live Author Monitor — run 45755687906](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45755687906): como `runtime-build` falló, la instalación de Chromium y las pruebas host/editor/browser se omitieron; la suite aislada (37/37) y el benchmark se ejecutaron y aprobaron.


## 82. Drenaje FIFO bajo una ráfaga de 1.000 ediciones reentrantes (26 de noviembre de 2026)

**Motivación:** las tres pruebas anteriores verificaban una única edición reentrante, altas/bajas de listeners y desmontaje durante la publicación. Se añade una regresión de carga para evitar que una futura implementación vuelva a introducir drenaje recursivo o invierta el orden bajo una ráfaga síncrona.

**Prueba:** el primer suscriptor genera 999 admisiones adicionales durante la notificación de la secuencia 1. El segundo debe recibir exactamente 1.000 snapshots, desde secuencia 1 hasta secuencia 1.000, sin saltos ni retrocesos. Se verifican también 1.000 admisiones aceptadas y 1.000 tickets pendientes al terminar; el test no simula commits ni limpieza que pudieran esconder pérdidas de eventos.

**Validación en [Live Author Monitor — run 45755953392](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45755953392):** aprobada. El nuevo caso terminó en 2,31 ms y recibió exactamente las 1.000 secuencias esperadas en orden. La suite combinada terminó con 38/38 pruebas aprobadas. El benchmark ejecutó 100.000 commits en 355,86 ms (~281.013 commits/s), con heap de 4,26 MiB a mitad y al final de la carga, 0 MiB de crecimiento entre ambas mediciones, 0,49 MiB retenidos por sesiones abiertas y cero tickets pendientes. La lane completa conserva fallo ajeno al monitor: la auditoría física detecta versión IndexedDB distinta y dos almacenes de reparación no declarados; el bundle general falla al analizar `indexeddb-store.ts` en `NarrativeReferenceRepairPendingEntry`.


## 83. Diagnóstico visible de errores de suscriptores y vistas (26 de noviembre de 2026)

**Hallazgo:** el monitor aislaba excepciones de suscriptores para proteger la escritura, pero las descartaba silenciosamente. En el panel, el helper de refresco también aislaba fallos de renderizado sin ofrecer una señal visible. Esto impedía distinguir un monitor sano de una vista que había dejado de actualizarse.

**Corrección:** se añade el contador efímero `listenerErrors` al snapshot y a la sesión por documento. Cada excepción de un suscriptor directo incrementa únicamente el documento cuyo snapshot se estaba entregando; no se conserva el mensaje de error. `subscribeLiveAuthorMonitorWithRefresh` acepta `onListenerError(snapshot)` como callback seguro y no entrega el objeto Error. El panel y el workspace muestran el diagnóstico en un nodo `data-diagnostic="listeners"`.

**Privacidad y ciclo de vida:** los contadores no se persisten en checkpoints, no incluyen mensajes internos ni texto del manuscrito y comienzan en cero al abrir/restaurar una sesión. Siguen siendo contadores de observabilidad local, no errores del motor de edición.

**Regresiones:** se cubren errores directos por documento, validación de suscriptores, callbacks de vista durante evento y polling, advertencia accesible en el panel y aislamiento por capítulo en el workspace. El workflow específico incluye ahora los tests del núcleo, panel y workspace en su lane aislada.

**Corrección tras primera ejecución:** CI detectó un separador `;` accidental en la inicialización del contador de sesión nueva, en `live-author-monitor.ts:222`. Se corrigió en el commit `29c0b351`; la validación se está repitiendo con ese ajuste.

**Validación en [Live Author Monitor — run 45756516860](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45756516860), checkout `29c0b351`:** aprobada para la lane aislada. El build reducido pasó; las regresiones diagnósticas aprobaron 17/17; el conjunto del núcleo, panel, workspace y diagnóstico aprobó 59/59, incluidas las cinco pruebas nuevas de error visible por suscriptor/vista y aislamiento por documento. El benchmark de 100.000 commits en ocho documentos de 1 MiB terminó en 499,17 ms (~200.332 commits/s); heap de 4,26 MiB al 50 % y 100 % de la carga, crecimiento 0 MiB, 0,50 MiB retenidos por las sesiones abiertas y cero tickets pendientes. El benchmark se ejecutó en Node.js 22.23.5 y no conserva texto del manuscrito.

La conclusión global de la lane sigue siendo `failure` por controles compartidos ajenos al monitor: la auditoría MLDB informa desajuste de versión IndexedDB y almacenes de reparación pendientes de mapear; el bundle runtime general todavía falla al analizar `NarrativeReferenceRepairPendingEntry` en `indexeddb-store.ts:2560`. Por esa razón las pruebas que dependen del motor completo/editor/navegador siguen omitidas.


## 84. Type-check estricto independiente para el monitor (26 de noviembre de 2026)

**Motivación:** el build aislado de Vite transpila el entrypoint reducido y permite ejecutar pruebas aunque falle el motor general, pero por sí solo no ejecuta el análisis semántico completo de TypeScript. El `tsc --noEmit` global está bloqueado por errores en módulos de persistencia paralelos, por lo que no ofrece una señal aislada de los tipos del monitor.

**Cambio:** se añade `tsconfig.live-author-monitor.json`, que extiende las opciones estrictas del proyecto y limita `include` al entrypoint `live-author-monitor-test-entry.ts`. Sus importaciones transitivas incluyen el núcleo, el panel y el workspace. La lane de Live Author Monitor ejecuta `npx tsc --noEmit --project tsconfig.live-author-monitor.json` antes del build Vite.

**Validación en [Live Author Monitor — run 45756913002](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45756913002):** aprobada. En el test `crea y restaura checkpoint durable conservando métricas y contando la interrupción como inactividad`, el monitor acumuló dos fallos de suscriptor en la sesión, confirmó que `createCheckpoint()` no escribe `listenerErrors` y restauró una sesión nueva con el contador en cero. La ejecución completó 59/59 pruebas aisladas; type-check estricto independiente aprobado. La lane completa conserva los bloqueos externos de auditoría/compilación descritos en la sección 84.


## 85. Los errores de suscriptores no forman parte del checkpoint durable (26 de noviembre de 2026)

**Motivación:** `listenerErrors` describe fallos de vistas de la instancia actual, no fallos de edición ni estado durable del manuscrito. Debe sobrevivir mientras una sesión está viva para ayudar al diagnóstico, pero no convertirse en deuda de observabilidad heredada después de una recuperación.

**Regresión:** el test de checkpoint instala un suscriptor que falla durante una admisión y un commit; comprueba que la sesión informa dos errores, que el checkpoint no contiene la propiedad `listenerErrors` y que `restoreCheckpoint()` comienza en cero. Las métricas de escritura y durabilidad se restauran sin contaminar la sesión nueva con fallos antiguos de UI.

**Validación CI:** en la misma ejecución dedicada [run 45763663440](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45763663440), la regresión de respuestas fuera de orden aprobó como test 104. El pipeline terminó `success`: **167/167** pruebas aisladas, Chromium Page Lifecycle 1/1 y **170/170** pruebas host/editor/browser. El orden invertido conservó los máximos de `expiresAt` y `updatedAt`; no se observaron fallos ni tickets pendientes al completar el benchmark.

**Estado de la suite general del repositorio:** [Motor Literario TypeScript — run 45763688872](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45763688872), sobre el checkout `4dd7673234dde77bbfc8df9cbb1c2055e5f5fd49`, terminó con **945/946** pruebas. El único fallo fue `tests/narrative-unicode-boundaries.test.mjs:107` (extracción de entidades con marcas combinantes, expectativa 1 y resultado 0), fuera de `host-api.ts` y del monitor. Type-check y build aprobaron; no se modificó el trabajo paralelo de extracción. La lane dedicada del monitor indicada arriba está completamente verde.


## 86. Aislamiento visible de fallos de reconciliación del workspace (26 de noviembre de 2026)

**Hallazgo:** el workspace protegía el conjunto de tarjetas con un `catch` general durante la reconciliación. Si un callback de presentación como `getDocumentLabel()` lanzaba una excepción, el refresco conservaba la última vista pero no indicaba qué capítulo había fallado. El fallo quedaba oculto y podía repetirse en cada pulso.

**Corrección:** cada `upsert` del workspace se ejecuta mediante `upsertSafely`; las excepciones se cuentan en un mapa efímero por documento y se muestran en el nodo de diagnóstico de la tarjeta afectada. La reconciliación continúa con los demás documentos, conserva la alerta después de que el callback se recupere y elimina el contador cuando se cierra la tarjeta o se desmonta el workspace. No se conserva el mensaje de excepción ni se incrementa el contador de errores de listeners del motor, porque se trata de un fallo local del renderer.

**Regresión:** dos documentos están abiertos; el callback de etiqueta lanza una vez para el primero y funciona para el segundo. El test comprueba aviso sólo en la tarjeta afectada, ausencia del mensaje privado, recuperación de la etiqueta en el siguiente pulso y persistencia de la alerta local sin contaminar `snapshot.listenerErrors`.

**Validación en [Live Author Monitor — run 45757281903](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45757281903):** aprobada para la lane aislada. El type-check estricto, el bundle reducido y las 17 pruebas diagnósticas pasaron. La suite del núcleo, panel y workspace terminó con 61/61 pruebas aprobadas, incluida la nueva regresión `getDocumentLabel()` que falla una vez durante la reconciliación y se recupera en el siguiente pulso. La advertencia queda sólo en la tarjeta afectada, no filtra el mensaje privado y el contador local no modifica `snapshot.listenerErrors`. El benchmark procesó 100.000 commits en 511,50 ms (~195.503 commits/s), con heap de 4,26 MiB a mitad y al final de la carga, crecimiento de 0 MiB, 0,49 MiB retenidos por sesiones abiertas y cero tickets pendientes.

La lane global sigue en `failure` por controles compartidos de persistencia: `DATABASE_VERSION_MISMATCH`, dos almacenes no mapeados y el error de sintaxis de `indexeddb-store.ts:2560`. No se han modificado esos archivos; las integraciones que requieren el bundle general siguen pendientes.


## 87. Regresiones aisladas del scheduler de visibilidad y ciclo de vida (26 de noviembre de 2026)

**Motivación:** las regresiones previas de `visibilitychange`, `pagehide/pageshow`, `freeze/resume` estaban cubiertas en Chromium, pero se ejecutaban junto a las integraciones que dependen del bundle completo del motor. Cuando persistencia impide compilar dicho bundle, faltaba una señal independiente sobre el scheduler visual.

**Prueba añadida:** `tests/live-author-monitor-visibility.test.mjs` usa targets DOM controlados y un scheduler manual para validar: suspensión y reanudación con visibilidad/ciclo de vida; rechazo de `pageshow/resume` mientras `document.hidden` continúa activo; invalidación de callbacks de intervalos antiguos; transición `pagehide` síncrona durante la instalación del scheduler; rollback si falla el registro parcial de listeners; invalidación de callbacks cuando el scheduler no devuelve cancelación; y limpieza completa incluso si un `removeEventListener` aislado falla.

**CI:** se incluye el archivo en el comando aislado de pruebas junto al núcleo, panel, workspace y pruebas de diagnóstico. No necesita Chromium ni importar el almacenamiento general.

**Validación en [Live Author Monitor — run 45757854690](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45757854690), checkout `efc4db4a`:** aprobada para la lane aislada. Type-check estricto, build Vite reducido y 17/17 pruebas diagnósticas correctos. La suite combinada terminó en **69/69** sin fallos; se ejecutaron las ocho regresiones nuevas de visibilidad/ciclo de vida, incluida la compatibilidad sin Page Visibility y el rollback cuando el scheduler lanza. El benchmark de 100.000 commits en ocho documentos de 1 MiB terminó en 660,83 ms (~151.325 commits/s), con heap de 4,27 MiB a mitad y 4,26 MiB al finalizar (0 MiB de crecimiento medido), 0,50 MiB retenidos por sesiones abiertas y cero tickets pendientes.

La conclusión global permanece en `failure` por el desajuste de versión IndexedDB, los dos almacenes de reparación sin mapear y el error sintáctico compartido en `indexeddb-store.ts:2560`. Se omitieron las integraciones que requieren el bundle general/editor/Chromium; la validación aislada del monitor está aprobada.


## 88. Pruebas aisladas de integración de editor, transacciones y textarea (26 de noviembre de 2026)

**Motivación:** el bundle general del Motor Literario sigue bloqueado por un error sintáctico en persistencia. Varias integraciones del monitor importaban exclusivamente sus propios adaptadores, contratos de tipos y el núcleo, pero sus pruebas dependían innecesariamente de `dist/motor-literario.js`. Esto dejaba sin ejecutar pruebas de la frontera editor-monitor cuando fallaba un módulo ajeno.

**Cambio:** se amplía `live-author-monitor-test-entry.ts` con exports de `live-author-monitor-change-binding`, fuente/puente/integración de transacciones nativas, integración del panel con pestaña activa y fuentes/integración de textarea. Las siete suites correspondientes ahora cargan `dist-monitor/live-author-monitor.js`, con fallback al bundle general para entornos completos. El workflow aislado ejecuta además `change-binding`, `editor-integration`, `editor-transaction-bridge`, `editor-transaction-integration`, `editor-transaction-source`, `textarea-integration` y `textarea-source`.

**Cobertura ejecutada:** eventos únicos del editor; orden edit/undo/redo; deduplicación de IDs y secuencias; FIFO bajo reentrada; queue_full, contrapresión y recuperación; buffer acotado por cantidad y unidades UTF-16; resincronización contra snapshot común; cleanup idempotente; integración de pestaña activa y workspace; beforeinput/input y selección UTF-16; composición IME; rechazo de undo/redo sin deltas autoritativos. El type-check estricto incorpora transitivamente estos adaptadores sin errores.

**Validación en [Live Author Monitor — run 45758057459](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45758057459), checkout `4671a7c0`:** type-check estricto y bundle Vite reducido aprobados; 17/17 pruebas diagnósticas y 161/161 pruebas combinadas aprobadas. El benchmark procesó 100.000 commits en 656,27 ms (~152.377 commits/s), con heap estable de 4,39 MiB al 50 % y 100 % de carga, 0 MiB de crecimiento medido, 0,50 MiB retenidos por sesiones abiertas y cero tickets pendientes.

La lane global continúa en `failure` por los controles compartidos de IndexedDB y el error sintáctico en `indexeddb-store.ts:2560`; las pruebas que requieren el runtime general y Chromium se omitieron. Las siete suites de adaptadores del monitor sí pasaron dentro del bundle aislado.


## 89. Primera validación integral en verde con Chromium (26 de noviembre de 2026)

**Evidencia:** [Live Author Monitor — run 45758096783](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45758096783), checkout `948408ae9e9519495dc8df97f48abcf20a38020e`, terminó `success` en todos los pasos. En ese commit pasaron el type-check aislado, bundle monitor, auditoría MLDB (`27 tablas`), bundle runtime general, instalación de Chromium, la suite aislada (`161/161`) y las integraciones host/editor/browser (`167/167`).

**Cobertura real de navegador:** dos páginas Chromium compartieron IndexedDB y validaron exclusión y fencing del lease; el harness de Page Lifecycle recuperó polling después de `pagehide/pageshow` y `freeze/resume`; y dos capítulos conservaron métricas independientes a través de escritura, cambio de documento, guardado durable y recuperación.

**Rendimiento:** 100.000 commits en 513,67 ms (~194.676 commits/s), heap de 4,39 MiB tanto a mitad como al final de carga, 0 MiB de crecimiento medido, 0,50 MiB retenidos por sesiones abiertas y cero tickets pendientes.

**Alcance temporal:** esta evidencia pertenece exactamente al checkout `948408ae`. Los commits de sincronización posteriores modificaron la ruta compartida de persistencia; en el HEAD actual el workflow vuelve a informar un error sintáctico en `indexeddb-store.ts:2560`. Por tanto, la ejecución integral es un hito verificado, pero no se declara como estado verde del HEAD actual. Se mantiene abierta la repetición sobre el HEAD actual una vez que terminen los cambios paralelos de persistencia.


## 90. Chromium independiente para Page Lifecycle cuando falla el runtime general (26 de noviembre de 2026)

**Motivación:** el harness `tests/browser/live-author-monitor-lifecycle.html` importa directamente `src/live-author-monitor-visibility.ts`; no necesita `indexeddb-store.ts`, el bundle de producción ni los adaptadores del editor. Sin embargo, la instalación de Chromium y todas las pruebas de navegador estaban condicionadas al éxito de `runtime-build`, impidiendo validar esta parte independiente cuando persistencia fallaba.

**Cambio CI:** Chromium se instala después de las pruebas aisladas con una condición `!cancelled()` independiente del resultado de `runtime-build`. A continuación se ejecuta `live-author-monitor-lifecycle-browser.test.mjs` cuando la instalación termina correctamente. Las pruebas host/editor/IndexedDB completas permanecen condicionadas al éxito del runtime y de la instalación del navegador.

**Validación en [Live Author Monitor — run 45758203803](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45758203803), checkout `d31055f1`:** instalación Chromium aprobada y prueba aislada `Chromium recupera el polling tras pagehide/pageshow y freeze/resume` aprobada (1/1). En ese mismo run pasaron 17/17 diagnósticos, 161/161 pruebas aisladas del monitor y el benchmark de 100.000 commits (638,91 ms, ~156.516 commits/s, heap 4,39 MiB a mitad y al final, 0 MiB de crecimiento, 0,50 MiB retenidos, cero pendientes). La lane global siguió roja por persistencia, pero la prueba de ciclo de vida en Chromium se ejecutó y pasó.


## 91. Revalidación integral en verde y estado comprobado de main (26 de noviembre de 2026)

**Ejecución integral más reciente del monitor:** [Live Author Monitor — run 45759321606](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45759321606), checkout `e951f9a01d3e01ef23a8b00d8748f245a99bba2a`, terminó con `success` en todos los pasos. La auditoría MLDB 0.4.2 pasó con 27 tablas; el bundle general y el bundle aislado pasaron; type-check estricto; 17/17 diagnósticos; 161/161 unitarias/aisladas; prueba Page Lifecycle independiente en Chromium 1/1; suite host/editor/browser 167/167; benchmark de 100.000 commits en 347,94 ms (~287.406 commits/s), heap de 4,39 MiB tanto a mitad como al final de carga, 0 MiB de crecimiento, 0,50 MiB retenidos por sesiones abiertas y cero tickets pendientes.

**Equivalencia respecto al HEAD comprobado:** en `main` (`54a3e88e0fc9a287cea624151f1a4fdc43c0c25a` al momento de esta inspección), los SHA blob de diez rutas relevantes —núcleo, panel, workspace, scheduler de visibilidad, entrypoint aislado, pruebas de visibilidad, suites de transacciones/textarea y workflow— coinciden exactamente con los SHA de `e951f9a`. Las commits posteriores fueron de sincronización/almacenamiento, no cambios en esos diez archivos del monitor. La validación integral es por tanto evidencia válida del mismo contenido de monitor que está en el HEAD revisado, aunque no equivale a una ejecución del commit combinado exacto.

**CI general del HEAD:** la ejecución [Motor Literario TypeScript — run 45759492198](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45759492198) aún falla en `tests/core.test.mjs:2163`, donde la expectativa de esquema inicial no incluye/concuerda con los almacenes `narrative-reference-repair-audits` y `narrative-reference-repair-pending`; el runner cancela después 235 pruebas dependientes. Es una expectativa de migración/almacenamiento, fuera de este módulo. No se cambió ese test ni la implementación IndexedDB desde la tarea del monitor.

**Conclusión de esta tanda:** el monitor tiene validación integral verde sobre el contenido idéntico actualmente en `main`; el bloqueo restante para tener todo el repositorio verde se encuentra en la suite de almacenamiento general y debe resolverse por el trabajo paralelo responsable de DB27.

## 92. Estrés FIFO del puente de transacciones nativas (26 de noviembre de 2026)

**Motivación:** la prueba existente cubría dos publicaciones reentrantes, suficientes para verificar orden lógico pero no para estresar una ráfaga larga emitida sincrónicamente desde un listener del propio puente.

**Regresión nueva:** un listener genera 999 publicaciones adicionales mientras se procesa la secuencia 1. El segundo listener y el primero deben recibir exactamente las secuencias 1..1000, en FIFO, sin saltos ni duplicaciones. El test también comprueba que cada llamada reentrante selecciona los dos listeners y que el proveedor nativo termina en la secuencia 1000.

**Validación en [Live Author Monitor — run 45759874190](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45759874190), checkout `d92f09267bb1835a05a9259b197e2fef0f95cd87`:** pipeline completo `success`. Type-check estricto y bundle aislado aprobados; auditoría MLDB 0.4.2 válida (27 tablas); bundle runtime aprobado; 17/17 diagnósticos; **162/162 pruebas aisladas**; Chromium Page Lifecycle 1/1; **168/168 pruebas host/editor/browser**; benchmark 100.000 commits aprobado. La prueba de estrés nueva pasó dos veces en el pipeline (test 50 de la suite aislada y test 51 de la suite de integración): ambos listeners recibieron las secuencias 1..1000 en FIFO.

El benchmark terminó en 655,47 ms (~152.563 commits/s), con heap de 4,39 MiB a mitad y al 100 % de la carga, 0 MiB de crecimiento medido, 0,50 MiB retenidos por sesiones abiertas y cero tickets pendientes. La prueba Chromium de Page Lifecycle y las pruebas de dos pestañas/IndexedDB con fencing de lease también pasaron.



## 93. Continuidad de métricas entre recuperaciones sucesivas (26 de noviembre de 2026)

**Objetivo:** comprobar que varios ciclos consecutivos de cierre abrupto y recuperación mantienen una única sesión lógica, sin duplicar métricas históricas ni contar dos veces el tiempo de inactividad. La prueba se limita al núcleo del monitor y a snapshots/checkpoints deterministas; no modifica almacenamiento, leases ni la lógica de persistencia compartida.

**Regresión añadida:** tests/live-author-monitor.test.mjs crea una sesión, confirma una edición y genera un checkpoint durable; restaura en una segunda instancia, deja transcurrir inactividad, registra y confirma una segunda edición y genera otro checkpoint; finalmente restaura en una tercera instancia. Se verifica identidad de sesión, secuencia/revisión durable, categorías, caracteres, número de commits, ausencia de pendientes y la suma exacta de tiempo activo/inactivo en ambos handoffs. La interrupción se suma a inactividad una sola vez por cada intervalo entre checkpoints.

**Cambio publicado:** commit [04632f8b](https://github.com/jmpixelapp-jpg/desarrollo/commit/04632f8b1e454a9c951ae8f6de58dbc9979c8fbf), sobre main. Solo se modificó la suite de pruebas del monitor.

**Validación CI:** [Live Author Monitor — run 45760625214](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45760625214), checkout exacto `04632f8b1e454a9c951ae8f6de58dbc9979c8fbf`, terminó `success`. Type-check estricto aislado, bundle focalizado, build del runtime y auditoría MLDB 0.4.2 (27 tablas) aprobados; diagnósticos 17/17; núcleo, panel, workspace y adaptadores 163/163; Page Lifecycle independiente en Chromium 1/1; host/editor/browser 168/168. La regresión nueva pasó como test 159 de la suite de 163. El benchmark procesó 100.000 commits en 503,05 ms (~198.786 commits/s), con heap de 4,39 MiB tanto a mitad como al final, 0 MiB de crecimiento medido, 0,50 MiB retenidos por sesiones abiertas y cero tickets pendientes. La prueba confirma continuidad entre checkpoints con reloj determinista; no simula IndexedDB real, pérdida de fencing ni cierres físicos del navegador.


**Validación adicional del motor general:** [Motor Literario TypeScript — run 45760625242](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45760625242), también sobre el checkout exacto 04632f8b1e454a9c951ae8f6de58dbc9979c8fbf, terminó success: type-check y build general aprobados; suite completa **926/926**, cero fallos y cero cancelaciones. La regresión de tres instancias pasó como test 751 de esa ejecución. El benchmark general procesó 100.000 commits en 533,53 ms (~187.431 commits/s), heap de 4,39 MiB a mitad y carga completa, 0 MiB de crecimiento medido y 0,50 MiB retenidos. La lane dedicada del monitor y la lane global del motor están ambas verdes para este commit de código; las validaciones se ejecutaron antes de los commits posteriores que solo actualizaron documentación.


## 94. Validación defensiva del snapshot antes de recuperar (26 de noviembre de 2026)

**Hallazgo:** restoreCheckpoint comparaba checkpoint.documentId con snapshot.documentId antes de comprobar que snapshot fuera un objeto. Una llamada inválida con null/undefined podía escapar como TypeError de acceso a propiedad, en lugar de un error de contrato explícito. No afectaba al flujo tipado normal, pero dejaba sin ejecutar la validación defensiva que el método ya pretendía ofrecer.

**Corrección:** se valida snapshot === null o typeof snapshot !== "object" antes de leer cualquier propiedad. La nueva regresión entrega null y exige un TypeError claro; además comprueba que no se crea una sesión parcial en el monitor. La validación existente de identidad del proyecto, documento y snapshot durable se mantiene después del guard.

**Cambios publicados en main:** núcleo 37f5563878c236417bb34aa7aeb1362b53cab6c6 y test ce1b71bb56eb66ab4ec4c26fc4c76a205aac3da2. No se cambió el contrato persistido ni el esquema IndexedDB.

**Validación CI:** [Live Author Monitor — run 45760911836](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45760911836), checkout `ce1b71bb56eb66ab4ec4c26fc4c76a205aac3da2`, terminó `success`: type-check aislado y bundle focalizado aprobados; auditoría MLDB 0.4.2 con 27 tablas; runtime build aprobado; diagnósticos 17/17; monitor/panel/workspace/adaptadores 163/163; Page Lifecycle Chromium 1/1; host/editor/browser 168/168. El test existente de validación de checkpoints ejecutó y aprobó el caso de snapshot `null`, y confirmó que no se crea una sesión parcial. [Motor Literario TypeScript — run 45760911868](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45760911868), sobre el mismo checkout, terminó `success` con **927/927 pruebas generales**, cero fallos y cero cancelaciones; type-check, build y benchmark general también pasaron. El benchmark de monitor procesó 100.000 commits en 495,92 ms (~201.647 commits/s), con 4,39 MiB de heap a mitad y al final, 0 MiB de crecimiento, 0,50 MiB retenidos y cero tickets pendientes.


## 95. Integridad de outcomes y muestras de latencia en checkpoints (26 de noviembre de 2026)

**Hallazgo:** restoreCheckpoint comprobaba que los resultados de commit no superaran acceptedChanges y que la suma de muestras de latencia fuera razonable, pero aceptaba dos registros imposibles: una edición aceptada sin resultado durable (commit aplicado o fallido), y una última latencia distinta del último elemento de la ventana guardada. También podía aceptar una ventana vacía con commits previos.

**Corrección:** un checkpoint ahora exige committedChanges + failedChanges === acceptedChanges; las muestras no pueden superar el número de resultados; si hay resultados debe existir al menos una muestra y su último valor debe coincidir exactamente con lastCommitLatencyMs; si no hay resultados, la latencia total/última y la ventana deben estar vacías/cero. Se conserva el límite configurado de la ventana y el control de suma total.

**Regresión:** tests/live-author-monitor.test.mjs genera un checkpoint válido y luego prueba tres variantes corruptas: outcome ausente, última latencia incongruente y ventana eliminada. Cada variante debe rechazarse sin crear una sesión parcial.

**Cambios publicados:** núcleo d096087f30d6065405f8662304fec5f54c44753d y pruebas dc8e6102338f24969640b9784749c52709b15708, ambos en main. No se modifica el formato ni la versión del checkpoint.

**Validación CI:** [Live Author Monitor — run 45761138764](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45761138764), checkout `dc8e6102338f24969640b9784749c52709b15708` (incluye el núcleo `d096087f`), terminó `success`: type-check aislado, build focalizado, auditoría MLDB 0.4.2 (27 tablas), runtime build, diagnósticos 17/17, núcleo/panel/workspace/adaptadores 164/164, Page Lifecycle Chromium 1/1 y host/editor/browser 168/168. La nueva regresión aprobó como test 161. El benchmark procesó 100.000 commits en 644,98 ms (~155.044 commits/s), con heap de 4,39 MiB a mitad y al final, 0 MiB de crecimiento, 0,50 MiB retenidos y cero tickets pendientes. La validación general [Motor Literario TypeScript — run 45761138762](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45761138762), sobre el mismo checkout, terminó `success` con **928/928 pruebas**, 0 fallos y 0 cancelaciones; type-check, build y benchmark global aprobados.


## 96. Rechazo de ventanas de latencia dispersas durante la recuperación (26 de noviembre de 2026)

**Hallazgo:** la validación de `commitLatencies` usaba `Array.prototype.some()`. Ese método, al igual que `reduce()`, omite huecos de arrays dispersos. Un checkpoint con tres resultados y una ventana de tres posiciones que contuviera una posición vacía podía superar la comprobación de valores finitos, la longitud y la suma parcial, pese a no representar tres muestras reales.

**Corrección:** la comprobación materializa la ventana con `Array.from()` antes de validar cada valor. Los huecos se convierten en `undefined` y se rechazan mediante la validación numérica existente. No cambia el formato, la versión ni las métricas generadas por el monitor; endurece exclusivamente la entrada de recuperación.

**Regresión:** se generan tres admisiones y tres commits reales, se crea un checkpoint válido y se elimina deliberadamente la segunda posición de la ventana de latencia. La restauración debe rechazarlo y dejar el documento sin sesión parcial.

**Validación CI:** [Live Author Monitor — run 45761935065](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45761935065), checkout exacto `a0d2aa925f311d77f66f1e20d687b10adec792d9` (incluye la corrección del núcleo `e5a79866f2677b8613f577c48ad4f7cb57aa8859`), terminó `success`. Type-check estricto, bundle aislado, auditoría MLDB/almacenamiento, bundle runtime y las 17/17 pruebas diagnósticas aprobaron. La suite focalizada del monitor terminó con **165/165 pruebas**, incluida la nueva regresión (test 162); Page Lifecycle en Chromium, 1/1; integraciones host/editor/browser, **168/168**. El benchmark de 100.000 commits en ocho documentos de 1 MiB terminó en **509,51 ms** (~196.267 commits/s), con heap de 4,39 MiB a mitad y al final, crecimiento medido de 0 MiB, 0,50 MiB retenidos por sesiones abiertas y cero tickets pendientes.


## 97. Rechazo de contadores de pausa incompatibles con las admisiones (26 de noviembre de 2026)

**Hallazgo:** `pauseCount` se incrementa únicamente al registrar una nueva admisión (aceptada o rechazada) después de un intervalo de inactividad. Por tanto, el número acumulado de pausas nunca puede superar la cantidad total de admisiones registradas (`acceptedChanges + rejectedChanges`). La restauración validaba que el contador fuera entero y no negativo, pero no comprobaba esta relación entre métricas.

**Corrección:** `restoreCheckpoint()` rechaza un checkpoint cuyo `pauseCount` exceda la suma de admisiones aceptadas y rechazadas. La validación no restringe sesiones válidas: una sesión sin admisiones tiene cero pausas, y cada pausa exige una admisión previa que la origine.

**Regresión:** se genera un checkpoint real recién abierto (cero admisiones y cero pausas), se altera únicamente `pauseCount` a uno y se comprueba que la restauración falla sin crear una sesión parcial.

**Validación automatizada:** [Motor Literario TypeScript — run 45762277077](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45762277077), checkout `319aa56970c68e9ebac341e6a040508457ee91fd`, terminó `success` con **940/940 pruebas**, cero fallos y cero cancelaciones. La regresión `rechaza checkpoints con más pausas que admisiones registradas` aprobó como test 756. Type-check, build general y benchmark finalizaron correctamente; el benchmark del monitor procesó 100.000 commits en 520,76 ms (~192.026 commits/s), con heap de 4,39 MiB a mitad y al final, crecimiento de 0 MiB, 0,50 MiB retenidos y cero tickets pendientes.

La lane dedicada del monitor para el código fuente con este guard, [run 45762234186](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45762234186), también terminó `success`: 165/165 pruebas, Page Lifecycle Chromium 1/1, host/editor/browser 168/168 y benchmark de 100.000 commits en 495,39 ms (~201.862 commits/s). Esa ejecución es anterior a la incorporación del nuevo test de pausa. La ejecución dedicada que sí incluye la nueva regresión, [run 45762250404](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45762250404), ya aprobó type-check, build aislado, diagnósticos, auditoría MLDB, runtime build y la suite aislada del monitor; al redactar esta nota todavía estaba en curso la instalación de Chromium, por lo que no se declara como pipeline dedicado completo.


## 98. Consistencia del balance de caracteres en checkpoints (26 de noviembre de 2026)

**Hallazgo:** la recuperación debe verificar que los contadores acumulados puedan corresponder a una longitud inicial real del documento. La longitud inicial implícita se obtiene de la longitud actual, las inserciones y los borrados; debe ser un entero no negativo.

**Invariante correcto:** `initialLength = currentDocumentLength + deletedCharacters - insertedCharacters`. Por tanto, debe cumplirse `insertedCharacters <= currentDocumentLength + deletedCharacters`.

**Corrección aritmética:** la primera implementación publicada de esta comprobación invirtió la desigualdad y podía rechazar secuencias válidas de borrado. Se corrigió en el núcleo y en IndexedDB el 26 de noviembre de 2026. La validación ahora rechaza únicamente los registros cuya longitud inicial implícita sería negativa.

**Regresión corregida:** se parte de un documento actual de cinco caracteres, sin borrados, y se manipula `insertedCharacters` a seis; la longitud inicial reconstruida sería −1. Tanto la restauración como el guardado durable deben rechazar ese checkpoint sin dejar una sesión ni un registro parcial.

**Evidencia anterior:** [Live Author Monitor — run 45762924927](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45762924927) validó la primera iteración, pero no certifica la desigualdad corregida. No se reutiliza esa ejecución como evidencia del criterio actual.

**Validación CI dedicada de la fórmula corregida:** [Live Author Monitor — run 45764587913](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45764587913), checkout exacto `94ca02416c626a7b5a7340252a8754f6e1b457ab`, terminó `success`. La regresión de longitud inicial negativa aprobó como test 164/167 en la suite aislada. También pasaron diagnósticos 17/17, auditoría MLDB/almacenamiento, Page Lifecycle Chromium 1/1 e integración host/editor/browser **174/174**. El benchmark de 100.000 commits terminó en **641,12 ms** (~155.978 commits/s), heap de 4,39 MiB a mitad y al 100 % de la carga, crecimiento medido 0 MiB, 0,50 MiB retenidos por sesiones abiertas y cero tickets pendientes.

**Suite general:** [Motor Literario TypeScript — run 45764587878](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45764587878) terminó 949/950. El único fallo fue el test de marcas combinantes del extractor narrativo en `tests/narrative-unicode-boundaries.test.mjs:107`; es ajeno al monitor y a la persistencia IndexedDB. Type-check aprobó. No se modificó esa área paralela.

## 99. Respuestas asíncronas de lease cercadas por generación (26 de noviembre de 2026)

**Hallazgo:** el heartbeat ya protegía sus respuestas tardías con una generación y comprobaba si seguía siendo titular. Sin embargo, la ruta compartida `acquireOrRenewLiveAuthorMonitorLease()`, utilizada también por guardados automáticos y cierres seguros, podía recibir una renovación después de que otro flujo hubiera liberado el lease. Al no comprobar la generación, podía volver a insertar en memoria el lease anterior y reactivar el heartbeat después del cierre.

**Corrección:** cada operación genérica captura la generación de ciclo de vida vigente (e inicializa una si aún no existe). Las renovaciones legítimas concurrentes comparten esa misma generación; una liberación o pérdida de titularidad la cambia. Antes de publicar el resultado o informar un error, la operación comprueba que la generación siga vigente y que no haya comenzado una liberación. Una respuesta invalidada devuelve `undefined` y no restaura la titularidad local.

**Regresión:** un almacén determinista confirma la renovación, pero demora la entrega de su respuesta. Mientras tanto, el cierre seguro completa el checkpoint y libera el lease. Al desbloquear la respuesta antigua, se exige que no se repongan el lease local ni el heartbeat y que el registro persistido permanezca vencido.

**Validación CI:** [Live Author Monitor — run 45763663440](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45763663440), checkout `26fc325ceb66d57b4bd9cfa642bb166ccd0710d4` (incluye el código de `host-api.ts` del commit `e0312b4536f3c7eaef3d91d565aba58dc817f86f`), terminó `success`. Type-check estricto, bundle aislado, 17/17 diagnósticos, auditoría MLDB/almacenamiento y runtime build aprobados; monitor/panel/workspace/adaptadores **167/167**; Page Lifecycle Chromium 1/1; host/editor/browser **170/170**. La regresión de renovación genérica tardía pasó como test 103. El benchmark de 100.000 commits terminó en **645,71 ms** (~154.868 commits/s), heap de 4,39 MiB a mitad y al 100 % de carga, crecimiento de 0 MiB, 0,50 MiB retenidos por sesiones abiertas y cero tickets pendientes.


## 100. Monotonía de metadatos ante respuestas de renovación fuera de orden (26 de noviembre de 2026)

**Hallazgo:** al permitir que renovaciones válidas compartan una generación de ciclo de vida, dos respuestas podían terminar fuera de orden. Una renovación antigua que regresara después de otra más nueva podía sustituir localmente un `expiresAt` y `updatedAt` mayores por valores anteriores, acortando innecesariamente la titularidad que la instancia cree tener.

**Corrección:** al publicar una renovación con el mismo owner y fencing token, se conservan los máximos de `expiresAt` y `updatedAt`. Si el lease local ya tiene un fencing token mayor, la respuesta vieja se descarta; un token igual de otro owner también se rechaza.

**Regresión:** se demora la respuesta de la primera renovación después de que el almacén la confirma; se completa una segunda renovación más reciente y luego se libera la respuesta antigua. El estado local debe conservar la expiración y actualización más nuevas.

**Validación CI dedicada:** [Live Author Monitor — run 45764124473](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45764124473), checkout `63f7ac27ad9491be76a1448b3415a62f06b2ae18` (incluye la validación de IndexedDB `e66ba8ea` y la suite `6691fae7`), terminó `success`. Type-check estricto, bundle aislado, diagnósticos 17/17, auditoría MLDB/almacenamiento, runtime build y monitor/panel/workspace/adaptadores **167/167** aprobaron. Page Lifecycle Chromium, 1/1; integración host/editor/browser, **173/173**, con las tres nuevas regresiones aprobadas (tests 112, 115 y 116). El benchmark procesó 100.000 commits en **493,40 ms** (~202.677 commits/s), heap 4,39 MiB a mitad y final, crecimiento medido 0 MiB, 0,50 MiB retenidos y cero tickets pendientes.

La suite general del motor se valida por separado; este resultado certifica la lane completa del monitor y su persistencia IndexedDB, no sustituye el estado global de todas las áreas del repositorio.


## 101. Integridad de muestras y clasificación al persistir checkpoints (26 de noviembre de 2026)

**Hallazgo A — arrays dispersos:** el validador de la capa IndexedDB usaba `some()` y `reduce()` directamente sobre `commitLatencies`. Ambos omiten posiciones vacías, por lo que una ventana dispersa podía superar la validación de escritura aunque la restauración del monitor ya la rechazara.

**Corrección A:** la validación materializa las muestras con `Array.from()` antes de comprobar sus valores. Un hueco se convierte en `undefined` y provoca el rechazo antes de abrir la transacción de escritura.

**Hallazgo B — desglose de actividad:** el guard de monotonía comparaba duración y contadores globales, pero no impedía que un checkpoint posterior de la misma sesión redujera `typingChanges`, `pasteChanges`, `deletionChanges`, `correctionChanges`, `undoChanges`, `redoChanges` u `otherChanges` manteniendo el mismo `acceptedChanges`.

**Corrección B:** los siete contadores también son monótonos dentro de la misma identidad de sesión. Para checkpoints v1 históricos que no incluyan el desglose opcional, los cambios anteriores se interpretan como `otherChanges = acceptedChanges`; la comparación calcula ese valor implícito y permite que la sesión siga creciendo sin reclasificar el pasado.

**Regresiones:** (1) IndexedDB rechaza una ventana de latencia con una posición vacía y no persiste ningún registro; (2) rechaza una reclasificación retroactiva aunque el total aceptado permanezca igual; (3) permite actualizar un checkpoint v1 histórico sin desglose, conservando su contador `other` implícito.

**Compatibilidad:** no cambia la versión ni la forma almacenada de los checkpoints; no requiere migración. Los campos de actividad continúan siendo opcionales en v1 para leer registros históricos.
 
**Validación CI dedicada:** [Live Author Monitor — run 45764587913](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45764587913), checkout `94ca02416c626a7b5a7340252a8754f6e1b457ab`, terminó `success`. Las regresiones de muestras dispersas, retroceso de categorías y compatibilidad de checkpoints históricos aprobaron (tests 112, 116 y 117 de la suite host/editor/browser). La suite aislada del monitor quedó 167/167; Page Lifecycle Chromium 1/1; integraciones host/editor/browser **174/174**.


## 102. Reglas de métricas completas antes de persistir checkpoints (26 de noviembre de 2026)

**Hallazgo:** la recuperación ya exigía varias relaciones entre métricas, pero el validador de IndexedDB todavía podía aceptar checkpoints incompletos o matemáticamente imposibles. En concreto: pausas superiores al número de admisiones; longitud inicial implícita negativa; cambios aceptados sin resultado de commit; más muestras de latencia que resultados, ausencia de muestras cuando ya había resultados, o una última muestra distinta de `lastCommitLatencyMs`.

**Corrección:** la validación previa a la transacción exige `pauseCount <= acceptedChanges + rejectedChanges`; `committedChanges + failedChanges === acceptedChanges`; `insertedCharacters <= currentDocumentLength + deletedCharacters`; y coherencia de cantidad, suma y última muestra de latencia. Se conserva la regla de rechazo de arrays dispersos mediante `Array.from()`.

**Regresión:** IndexedDB recibe cinco variantes inválidas (pausas excesivas, balance de caracteres imposible, commit sin outcome, última latencia incongruente y ventana sin muestras). Todas deben rechazarse antes de persistir y la lectura posterior debe seguir sin encontrar checkpoint.

**Compatibilidad:** son guards de lectura/escritura sobre la versión v1 existente; no cambian el formato ni exigen migración. Los checkpoints generados por `createCheckpoint()` cumplen estos invariantes porque solo se crean al no haber tickets pendientes.

**Validación CI dedicada:** la misma ejecución [run 45764587913](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45764587913) terminó `success`. La regresión conjunta de pausas, balance de caracteres, resultados de commit y coherencia de latencias aprobó como test 113. La prueba de balance de caracteres en restauración aprobó como test 164. No hubo fallos en las suites específicas ni en las integraciones Chromium.

**Límite de validación global:** la suite general del mismo checkout, [run 45764587878](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45764587878), registró 949/950 por un único fallo preexistente y ajeno al monitor en `tests/narrative-unicode-boundaries.test.mjs:107` (marcas combinantes).


## 103. Propagación de errores de escritura IndexedDB y agotamiento de cuota (26 de noviembre de 2026)

**Hallazgo:** `saveLiveAuthorMonitorCheckpoint()` capturaba excepciones síncronas de `put()`, pero no almacenaba expresamente `IDBRequest.error` cuando la escritura fallaba de forma asíncrona. En ese caso, el caller dependía solo de `transaction.error`, pudiendo perder el código exacto de la solicitud que falló.

**Corrección:** se conserva el request devuelto por `checkpointStore.put()` y se instala su handler `onerror`. El error original (por ejemplo, `QuotaExceededError` o `DataCloneError`) se captura y se aborta la transacción; `onabort` rechaza con ese mismo error en vez de sustituirlo por uno genérico. Las excepciones síncronas siguen pasando por el guard existente.

**Regresión:** una solicitud de escritura simulada entrega un `QuotaExceededError` asíncrono. La transacción debe abortarse, la promesa debe rechazar conservando `error.name`, y el checkpoint durable anterior debe permanecer intacto. El test no llena físicamente el disco ni pretende medir el límite real de cuota del navegador; simula la interfaz de error del request para verificar la ruta de propagación. Una segunda regresión encola el put y aborta la transacción antes del commit; comprueba que el snapshot anterior sobrevive y que la misma instancia vuelve a persistir tras el aborto.

**Diagnóstico de host:** la prueba existente `publica el error de cuota del checkpoint sin exponer el texto interno` verifica que el anfitrión muestre `checkpointState: error` y `checkpointErrorCode: QuotaExceededError` sin serializar el mensaje privado ni contenido del manuscrito.

**Compatibilidad:** no modifica el esquema IndexedDB ni el formato del checkpoint v1. La transacción completa (lease y checkpoint) se aborta como unidad; ningún checkpoint parcial se considera guardado.

**Validación CI dedicada:** [Live Author Monitor — run 45765001413](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45765001413), checkout `01b7eb3927a920cea809cc5cd7949a2ab6c4e9bf`, terminó `success`. La regresión `IndexedDB propaga QuotaExceededError del request y aborta sin reemplazar el checkpoint anterior` pasó como test 114. Type-check estricto, bundle aislado, diagnósticos 17/17, auditoría MLDB/almacenamiento, runtime build y monitor/panel/workspace/adaptadores **167/167** aprobados; Page Lifecycle Chromium 1/1; integración host/editor/browser **175/175**. El benchmark procesó 100.000 commits en **649,99 ms** (~153.848 commits/s), heap de 4,39 MiB a mitad y al final, 0 MiB de crecimiento medido, 0,50 MiB retenidos por sesiones abiertas y cero tickets pendientes.

La suite general [run 45765001099](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45765001099) terminó 950/951 por el mismo fallo aislado de extracción de marcas combinantes en `tests/narrative-unicode-boundaries.test.mjs:107`. Type-check general aprobó. No se alteró el código Unicode paralelo.



**Validación del aborto:** [Live Author Monitor — run 45765202154](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45765202154), checkout `7ccf5f74df0081818df0f868b9c69dff540b42ab`, terminó `success`. La regresión de aborto después de encolar el put pasó como test 115; host/editor/browser 176/176, monitor aislado 167/167, diagnósticos 17/17 y Page Lifecycle Chromium 1/1. El benchmark de 100.000 commits terminó en 653,43 ms, con heap estable de 4,38 MiB desde mitad hasta el final y cero tickets pendientes.

## 104. Recuperación tras abortar transacciones y cerrar conexiones externamente (26 de noviembre de 2026)

**Objetivo:** verificar el comportamiento después de validar el lease y comenzar la escritura, cuando el navegador aborta la transacción o cierra la conexión IndexedDB fuera del ciclo normal del almacén.

**Regresión A — aborto antes del commit:** la prueba encola el `put` y aborta la transacción antes de que complete. La operación debe rechazar, el checkpoint durable previo debe conservarse y una escritura posterior debe funcionar en la misma instancia.

**Regresión B — cierre externo:** se cierra una conexión obtenida del almacén y se invoca el handler `onclose` que el adaptador registró; `fake-indexeddb` no permite despachar un evento sintético `close` sobre una conexión cerrada. El listener `IDBDatabase.onclose` debe invalidar la promesa de conexión cacheada; las lecturas posteriores deben abrir otra conexión, recuperar el checkpoint y reutilizar la nueva conexión.

**Alcance:** ambas pruebas usan `fake-indexeddb` para controlar de forma determinista abortos/eventos. No sustituyen las pruebas de crash real de proceso o pérdida física del perfil en Chromium/OS.

**Validación de la regresión A (aborto):** aprobada en [run 45765202154](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45765202154), test 115. **Validación de la regresión B (evento close externo):** pendiente en la ejecución que incluye el commit `6734780a`.
