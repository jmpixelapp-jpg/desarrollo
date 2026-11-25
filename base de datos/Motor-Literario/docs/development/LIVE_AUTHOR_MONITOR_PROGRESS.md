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

**Corrección del alcance:** se preservó el manifiesto histórico `storage_mapping_v0.4.1.json` sin cambios. La definición actualizada se aplicó al manifiesto activo `storage_mapping_v0.4.2.json`.

**Cambios:**
- Se actualizó `runtime.database_version` de 22 a 23 en el manifiesto activo y `mapping_version` de 12 a 13.
- Se agregó el descriptor `live-author-monitor-checkpoints`, keyPath compuesto `[projectId, documentId]` e índice `by-project`.
- Se corrigió la prueba de auditoría para leer v0.4.2 y comparar dinámicamente la cantidad de tablas; ya no depende del literal de versión 21 ni de un número de tablas obsoleto.
- El workflow aislado ejecuta `npm run validate:schema` antes del build y las pruebas, y ejecuta además `tests/storage-implementation-audit.test.mjs`.
- Los filtros de push y pull request incluyen el manifiesto activo, el adaptador IndexedDB y la prueba de auditoría.

**Commits:** [daa6f22 — restaurar el manifiesto histórico v0.4.1](https://github.com/jmpixelapp-jpg/desarrollo/commit/daa6f22e40aa32787db80094a339a65d0015ee09), [32b1ebf — registrar almacén y versión en v0.4.2](https://github.com/jmpixelapp-jpg/desarrollo/commit/32b1ebf148658190637de8ecdf1bae42f4d89172), [2eec62d — alinear prueba con v0.4.2](https://github.com/jmpixelapp-jpg/desarrollo/commit/2eec62d0ff03ab15d2057a4868f348e9055642ea), [85e4b42 — validar manifiesto activo en CI](https://github.com/jmpixelapp-jpg/desarrollo/commit/85e4b42546d7ef7ba281c37eee8c998e2a8f316a).

**Ejecuciones anteriores:** las ejecuciones [45723541249](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45723541249) y [45723473909](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45723473909) fallaron porque sus commits todavía auditaban el manifiesto anterior al ajuste del manifiesto activo. No se toman como validación de esta corrección. La nueva ejecución debe probar el commit posterior a `85e4b42` y correr tanto validación física como las pruebas.

**Estado de CI:** pendiente de la nueva ejecución. No se marca como aprobado hasta verificar auditoría, build y pruebas.


**Corrección adicional del audit estático:** `audit-storage-implementation.mjs` deriva los índices esperados desde las llamadas `ensureIndex` de la rutina de migración, no solamente desde los `createIndex` que se ejecutan al crear el almacén. Se añadió `ensureIndex(LIVE_AUTHOR_MONITOR_CHECKPOINTS, "by-project", "projectId")` para que el índice permanezca declarado y se valide también en las migraciones. Commit: [c83e27f — registrar índice del checkpoint en migraciones](https://github.com/jmpixelapp-jpg/desarrollo/commit/c83e27f5721c7fe774ecdd2cb119b02d88575d9a). La nueva ejecución de CI está en curso; el resultado se añadirá cuando concluya.
