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

**Validación:** pendiente de GitHub Actions. El workflow vigente también está bloqueado por un error de sintaxis ajeno al monitor en `src/narrative-history.ts` (TS1002); no se modifica ese archivo porque pertenece a trabajo paralelo.

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

**Validación:** pendiente de GitHub Actions.

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

**Validación:** pendiente de CI para este commit.

- Ajuste de tipado preventivo: los mapas de claves visibles se construyen mediante `Map.set()` explícito para mantener la inferencia de tuplas estable en TypeScript estricto.

## 40. Nueva entrega — benchmark de heap reproducible para sesiones de monitor (25 de noviembre de 2026)

- Se añade `bench/live-author-monitor-memory-benchmark.mjs`, con ocho sesiones predeterminadas, documentos iniciales de 1.048.576 unidades UTF-16 y 12.500 commits por documento (100.000 en total).
- El script fuerza GC antes de sus lecturas y captura heap inicial, después de abrir sesiones, a mitad de carga y al finalizar. Reporta heap retenido por sesiones, crecimiento de mitad a carga completa, RSS y throughput del runner.
- Verifica por documento que los 12.500 commits se confirmaron, no quedan pendientes/fallos y la ventana de latencias se mantiene en 64 muestras.
- Se añade `npm run bench:monitor`; el benchmark general `npm run bench` lo ejecuta después del benchmark de edición y el workflow específico lo ejecuta tras los tests.
- Las dimensiones del benchmark son configurables mediante variables de entorno y el script valida sus límites.

**Límite de medición:** esta medición es heap/RSS del proceso Node en CI, no heap de Chromium ni RAM del editor en producción. No se fija un umbral global arbitrario; se publica el valor observado y se conserva la verificación estructural de las ventanas acotadas.

**Validación:** pendiente de CI para este commit.

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

**Commit de implementación:** se incorporará en la nota de verificación posterior a la creación del commit.

**Validación:** pendiente de CI. El baseline documentado sigue bloqueado antes de las pruebas del monitor por el error sintáctico externo `src/narrative-history.ts(7,41): TS1002`. No se modifica ese módulo ni se atribuye aprobación a tests que el workflow no haya ejecutado.
