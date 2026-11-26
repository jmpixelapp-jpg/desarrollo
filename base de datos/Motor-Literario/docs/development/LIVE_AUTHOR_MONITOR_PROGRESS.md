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

**Pruebas:** buffer de tamaño dos sin crecimiento adicional; evento excedente identificado; pausa/desuscripción; retry bloqueado durante la resincronización; limpieza y re-suscripción tras snapshot común; validación de límites antes de instalar listeners.

**Archivos:** `typescript/src/live-author-monitor-change-binding.ts`, `typescript/tests/live-author-monitor-change-binding.test.mjs`, `docs/development/LIVE_AUTHOR_MONITOR_EDITOR_ADAPTER_GUIDE.md`, `docs/specifications/LIVE_AUTHOR_MONITOR_V0.1.md`.

**Estado de validación:** los tests de regresión quedan incluidos en el workflow específico del Live Author Monitor. La integración se considera pendiente de CI hasta observar el resultado de GitHub Actions sobre este commit.

**Límite importante:** el evento que excede el buffer ya fue aplicado por el editor y no se conserva como delta individual; se recupera desde el snapshot común. El código no afirma que ese delta se haya admitido ni se haya persistido de forma incremental.
