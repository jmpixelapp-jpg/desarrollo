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

**Nueva cobertura en curso:** commit `4f74096c8ce17e70a3c88aa1519ec2be81585d38` añade validación del rango de `maxQueuedTransactions` (valores inválidos, límites 1 y 65536 y valor predeterminado). La ejecución correspondiente debe registrarse aquí cuando termine; no se marca como aprobada antes de consultar CI.

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
