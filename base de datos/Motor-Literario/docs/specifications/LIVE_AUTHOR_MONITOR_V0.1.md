# Monitoreo de actividad del autor en vivo — contrato v0.1

- **Estado:** núcleo, refresco temporal, panel DOM, tablero multi-documento, selección de pestaña activa, enlace tipado del stream, adaptador nativo para textarea y seguimiento de composición IME disponibles. Los editores con historial propio pueden requerir un adaptador específico.
- **Runtime:** TypeScript/JavaScript puro; sin dependencias externas ni servicios remotos.
- **Ubicación:** **typescript/src/live-author-monitor.ts**, **live-author-monitor-panel.ts**, **live-author-monitor-workspace.ts**, **live-author-monitor-editor-integration.ts**, **live-author-monitor-change-binding.ts**, **live-author-monitor-textarea-source.ts** y **live-author-monitor-textarea-integration.ts**.
- **Alcance:** métricas por sesión y documento, eventos de admisión/commit, pausas, ritmo estimado, resincronización y suscripciones.

## 1. Responsabilidad y límites

**LiveAuthorMonitor** observa la actividad que el editor anfitrión ya entrega al motor. No sustituye **LiteraryEngine**, no aplica deltas, no persiste snapshots y no ejecuta análisis literario. La identidad del proyecto y el snapshot inicial continúan siendo responsabilidad del anfitrión.

El monitor no conserva el texto del manuscrito ni las cadenas de reemplazo. En la apertura solo lee **text.length**; en cada edición utiliza longitudes y referencias de revisión/secuencia. Las métricas son contadores temporales por sesión en memoria y desaparecen al cerrar la sesión o disponer la instancia. Este módulo no envía telemetría a Internet.

## 2. Integración automática con HostEngineApi

El monitor ya forma parte del flujo de **HostEngineApi**. No se debe crear otra instancia ni registrar manualmente los mismos eventos:

~~~ts
import { HostEngineApi } from "./motor-literario";

const api = new HostEngineApi({
  store,
  liveAuthorMonitor: { idleAfterMs: 10_000 },
  callbacks: {
    onCommit(result) {
      // Callback opcional del anfitrión; el monitor ya recibió el commit.
      console.info("Commit:", result.status);
    }
  }
});

api.initializeProject({ projectId, projectName, writerId });
await api.openDocument(snapshot);

// El evento normal del editor alimenta también el monitor.
const admission = api.onEditorChange(change);

// Panel de observabilidad: snapshot actual y actualizaciones.
const current = api.getLiveAuthorMonitorSnapshot(change.documentId);
const unsubscribe = api.subscribeLiveAuthorMonitor(snapshot => {
  renderAuthorActivity(snapshot);
}, change.documentId);

// Antes de cerrar el documento:
await api.flushPendingChanges();
api.closeLiveAuthorMonitorDocument(documentId);
unsubscribe();
api.dispose();
~~~

La integración automática realiza lo siguiente:

1. **openDocument/recoverDocument:** abre la sesión con el snapshot efectivamente recuperado y el `projectId` activo.
2. **onEditorChange:** registra exactamente una vez la admisión devuelta por el motor; los rechazos se cuentan sin alterar la longitud proyectada.
3. **onCommit:** correlaciona automáticamente los tickets aplicados o rechazados, sin reemplazar el callback original del anfitrión.
4. **consultas y ciclo de vida:** expone `getLiveAuthorMonitorSnapshot(documentId)`, `getLiveAuthorMonitorSnapshots()`, `subscribeLiveAuthorMonitor(listener, documentId?)`, `resynchronizeLiveAuthorMonitor(snapshot)` y `closeLiveAuthorMonitorDocument(documentId)`.
5. **aislamiento:** los errores internos del monitor no interrumpen la admisión, la persistencia ni los callbacks del anfitrión.

No llamar manualmente a `recordAdmission` ni a `recordCommit` cuando se usa `HostEngineApi`: hacerlo duplicaría las métricas.

## 3. Métricas expuestas

- **Actividad:** estado (**active**, **idle**, **needs-resync**), última actividad, duración de sesión, tiempo activo/inactivo, tiempo de inactividad actual y número de pausas.
- **Edición:** cambios aceptados/rechazados/confirmados/fallidos/pendientes, caracteres insertados/eliminados, delta neto y longitud proyectada del documento.
- **Ritmo:** caracteres por minuto y palabras por minuto estimadas. Las palabras por minuto son una aproximación de cinco caracteres por palabra; cuentan inserciones, no una segmentación lingüística del manuscrito. Pegados extensos también influyen en el ritmo.
- **Durabilidad:** última revisión/secuencia observada y confirmada, latencia del último commit, promedio y percentiles p50/p95 sobre una ventana acotada de commits recientes.
- **Recuperación:** necesidad de resincronización y número de resincronizaciones autoritativas.

Los tiempos se calculan con **performance.now()** cuando está disponible. El reloj puede inyectarse mediante **now** para pruebas deterministas. Un retroceso del reloj se rechaza.

## 4. Reglas de consistencia

1. **openDocument** inicia una sesión nueva a partir del snapshot autoritativo. Por defecto se admiten ocho documentos observados en paralelo; el límite puede configurarse entre 1 y 64.
2. Cada cambio admitido debe tener secuencia y revisión base consecutivas respecto de los cambios ya observados por este monitor. Los offsets siguen la convención UTF-16 de los editores JavaScript.
3. **recordAdmission** se invoca después de **HostEngineApi.onEditorChange**. Los rechazos se cuentan como actividad intentada, pero no aumentan los caracteres aceptados ni la longitud proyectada.
4. **recordCommit** correlaciona el ticket. Un commit aplicado incrementa la durabilidad; uno rechazado marca **needsResync**. El monitor no intenta reparar ni reejecutar cambios.
5. **resynchronizeDocument** solo se permite cuando no quedan tickets pendientes y recibe el snapshot autoritativo actualizado. Reinicia la base proyectada y conserva las métricas de la sesión.
6. **closeDocument** requiere que todos los tickets hayan terminado. El anfitrión debe ejecutar primero **flushPendingChanges()**.
7. **dispose** borra sesiones, tickets y suscriptores en memoria.

## 5. Validación

Las pruebas específicas del monitor cubren métricas de admisión/commit, actividad y pausas, privacidad del manuscrito, panel accesible, varios documentos, selección de capítulo, deltas UTF-16, pegado y reemplazo, operaciones ambiguas, ciclo de composición IME, contrapresión FIFO, reintentos automáticos, limpieza de suscripciones y resincronización durable.

La validación automatizada más reciente, el recuento exacto de pruebas y las limitaciones pendientes del chequeo global se registran en la sección 12. La CI aislada del monitor permite verificar este componente sin interferir con módulos narrativos paralelos, pero no reemplaza el typecheck estricto ni la suite completa.

## 6. Refresco continuo del panel

Las suscripciones directas notifican admisiones y commits, pero el estado puede cambiar de `active` a `idle` únicamente por el paso del tiempo. Para que el panel no quede mostrando actividad antigua, el módulo ofrece `subscribeLiveAuthorMonitorWithRefresh`:

~~~ts
import { subscribeLiveAuthorMonitorWithRefresh } from "./live-author-monitor";

const stopMonitoring = subscribeLiveAuthorMonitorWithRefresh(
  api,
  snapshot => renderAuthorActivity(snapshot),
  { documentId, intervalMs: 1_000 }
);

// Al ocultar o desmontar el panel:
stopMonitoring();
~~~

- Entrega un snapshot inicial y conserva las notificaciones inmediatas de admisión/commit.
- Refresca métricas temporales con el intervalo configurado; por defecto, cada segundo.
- Puede limitarse a un documento o consultar todos los documentos observados.
- Usa temporizadores nativos del runtime, sin dependencias. El anfitrión decide cuándo iniciar y cancelar el refresco.
- Aísla excepciones de la interfaz y de una lectura de observabilidad para no interrumpir la escritura.
- No recibe ni almacena texto del manuscrito; reutiliza únicamente los snapshots de métricas ya expuestos por `HostEngineApi`.

## 7. Panel DOM del autor

El núcleo incluye un panel visual independiente de React, Vue y otros frameworks. Se monta dentro de un contenedor proporcionado por la aplicación anfitriona:

~~~ts
import { mountLiveAuthorMonitorPanel } from "./motor-literario";

const unmount = mountLiveAuthorMonitorPanel(
  document.querySelector("#author-activity")!,
  api,
  { documentId, intervalMs: 1_000 }
);

// Al desmontar el editor:
unmount();
~~~

El panel muestra actividad, pausa o necesidad de resincronización; duración de sesión y tiempo activo; ritmo estimado; caracteres insertados/eliminados; ediciones aceptadas, guardadas, pendientes y fallidas; revisión durable/actual y latencia p95. Una barra resume el avance de la secuencia durable.

- Construye nodos mediante APIs DOM y asigna valores con textContent; no interpola contenido del manuscrito en HTML.
- Incluye estructura semántica, estado accesible y estilos autocontenidos con adaptación a tema oscuro.
- Solo recibe LiveAuthorMonitorSnapshot; nunca recibe ni muestra el manuscrito.
- La función de desmontaje cancela el refresco, retira la suscripción y el elemento DOM. No cierra el documento ni dispone la API anfitriona.
- El intervalo y el planificador se pueden configurar desde el anfitrión y se pueden probar con un reloj y temporizador deterministas.

## 8. Espacio de trabajo para varios documentos

El panel individual observa un solo documento. Para un editor que mantiene varios capítulos abiertos, se incorpora un espacio de trabajo que concilia todas las sesiones activas y elimina tarjetas cuando una sesión se cierra:

~~~ts
import { mountLiveAuthorMonitorWorkspace } from "./motor-literario";

const unmountWorkspace = mountLiveAuthorMonitorWorkspace(
  document.querySelector("#author-monitoring")!,
  api,
  {
    intervalMs: 1_000,
    getDocumentLabel: documentId => chapterTitles.get(documentId) ?? documentId,
    onSelectDocument: documentId => editorTabs.activate(documentId)
  }
);

// Al cerrar el editor:
unmountWorkspace();
~~~

- Una tarjeta por documento observado; cada una muestra estado, ritmo, caracteres insertados, pendientes, revisión durable/actual y latencia p95.
- Las admisiones y commits actualizan la tarjeta correspondiente inmediatamente.
- Un refresco global reconcilia la lista autoritativa: detecta aperturas nuevas y elimina las sesiones cerradas, incluso si el cierre no emite un evento de escritura.
- La callback opcional `onSelectDocument` solicita al anfitrión cambiar de capítulo; el componente no abre, cierra ni altera documentos.
- La etiqueta del documento se obtiene opcionalmente del anfitrión. El componente no consulta el texto del capítulo.
- El desmontaje cancela el temporizador, retira la suscripción y elimina las tarjetas. No dispone `HostEngineApi`.

## 9. Integración con la selección del editor

Para mostrar el panel detallado del capítulo activo y mantener el tablero general visible, el anfitrión implementa un adaptador pequeño de selección:

~~~ts
import { mountLiveAuthorMonitorEditorIntegration } from "./motor-literario";

const stopAuthorMonitoring = mountLiveAuthorMonitorEditorIntegration({
  hostApi: api,
  workspaceContainer: document.querySelector("#author-monitoring")!,
  activeDocumentContainer: document.querySelector("#active-chapter-monitor")!,
  editor: {
    getActiveDocumentId: () => editorTabs.activeDocumentId,
    subscribeActiveDocument: listener => editorTabs.subscribeActive(listener),
    activateDocument: documentId => editorTabs.activate(documentId)
  },
  getDocumentLabel: documentId => chapterTitles.get(documentId) ?? documentId,
  intervalMs: 1_000
});

// Al desmontar la ventana del editor:
stopAuthorMonitoring();
~~~

- El tablero general mantiene todas las sesiones abiertas.
- El panel detallado se reemplaza al cambiar de pestaña y desaparece cuando no hay documento activo.
- El botón Abrir documento del tablero delega en activateDocument del anfitrión.
- La conexión solo observa la selección y las métricas; el flujo de cambios sigue pasando una única vez por HostEngineApi.onEditorChange.
- El desmontaje retira la suscripción a selección, el panel activo, el tablero y los temporizadores. No dispone HostEngineApi ni cierra capítulos.

## 10. Enlace de deltas y reanudación de sesiones

El anfitrión puede conectar su fuente nativa de cambios mediante bindLiveAuthorMonitorEditorChanges. La fuente debe entregar un EditorChange ya calculado por el adaptador específico del editor; el enlace no sintetiza offsets ni intercepta eventos DOM.

- Llama a HostEngineApi.onEditorChange exactamente una vez por delta.
- Devuelve el resultado queued o rejected a onAdmission. El enlace conserva automáticamente los rechazos y puede reintentarlos en FIFO mediante retryPending o subscribeRetrySignal.
- Publica transiciones de contrapresión mediante onBackpressure: estado clear/backpressured, cantidad pendiente, primera/última secuencia y causa (queue_full, rejected o sink_error). Cada snapshot es inmutable, no contiene texto del manuscrito y solo se emite cuando cambia el estado observable; los errores del callback visual quedan aislados.
- Informa excepciones de envío a onError y deja al anfitrión la política de recuperación. Los errores de la callback visual onBackpressure quedan aislados para no interrumpir la escritura.
- No registra eventos manuales adicionales en LiveAuthorMonitor, porque HostEngineApi ya incorpora admisiones y commits.

ensureLiveAuthorMonitorDocument(documentId) restaura una sesión de observabilidad que se cerró mientras el documento del motor seguía abierto. Devuelve la sesión existente si ya está activa; en caso contrario, utiliza el snapshot actual del motor. Rechaza si el documento tiene cambios pendientes (pendingSequence !== sequence) o necesita resincronización. La integración con la pestaña activa usa este método automáticamente si la sesión no existe.

## 11. Integración directa con textarea y HostEngineApi

Para el editor anfitrión basado en `HTMLTextAreaElement`, la función `mountLiveAuthorMonitorTextArea` reúne el adaptador nativo, el enlace de deltas, las métricas por documento y los reintentos FIFO. El anfitrión ya no necesita ensamblar esos componentes por separado:

```ts
import { mountLiveAuthorMonitorTextArea } from "./motor-literario";

const authorMonitor = mountLiveAuthorMonitorTextArea({
  element: editorTextArea,
  documentId,
  hostApi: api,
  onBackpressure: state => renderEditorQueueState(state),
  onAdmission: (change, admission) => {
    if (admission.status === "rejected" && admission.reason !== "queue_full") {
      reportEditorSynchronizationError(admission, change);
    }
  },
  onError: (error, change) => reportEditorSynchronizationError(error, change)
});

// Tras resolver una divergencia y restaurar el snapshot autoritativo:
authorMonitor.resynchronize();

// Indicadores del editor: estado local, cola pendiente y botón de reintento.
const state = authorMonitor.getState();
const pending = authorMonitor.getPendingChanges();

// Al cerrar/desmontar el editor:
authorMonitor.dispose();
```

El montaje:

- Exige que el documento ya esté abierto en `HostEngineApi`, durable y sin cambios pendientes.
- Comprueba que el texto visible coincida con el snapshot del motor antes de instalar listeners.
- Asegura una sesión de métricas para el documento cuando todavía no existe.
- Envía cada delta una sola vez a `HostEngineApi.onEditorChange`; las admisiones y commits se registran automáticamente.
- Escucha `subscribeLiveAuthorMonitor` para reintentar automáticamente el backlog FIFO cuando el motor publica nuevas métricas.
- `onBackpressure` permite actualizar un indicador visual sin consultar ni almacenar el manuscrito. Informa `status`, `pendingCount`, `firstPendingSequence`, `lastPendingSequence` y `reason`; al vaciarse la cola emite `{ status: "clear", pendingCount: 0 }`.
- En `queue_full`, conserva el delta rechazado y todos los siguientes. Si otra señal encuentra todavía la cola llena, no elimina ni reordena nada.
- Suspende la fuente ante rechazos no recuperables o entradas ambiguas.
- `resynchronize()` exige que el motor no tenga cambios pendientes ni necesite resincronización, que el textarea coincida con el snapshot autoritativo y que las métricas puedan reconciliarse; solo entonces elimina el backlog antiguo.
- `dispose()` retira tanto los listeners del textarea como la suscripción de reintento. No cierra el documento ni dispone `HostEngineApi`.

El adaptador `LiveAuthorMonitorTextAreaSource` usa `selectionStart`, `selectionEnd`, longitud anterior e `inputType`; no mantiene una copia sombra del manuscrito. Admite inserciones, pegados, reemplazos de selección y eliminaciones hacia atrás/adelante, con offsets UTF-16. Si falta `beforeinput`, el tipo de operación es desconocido, el valor cambia fuera del flujo de eventos o el rango no puede reconstruirse sin ambigüedad, suspende el stream y notifica `onError`.

`historyUndo` y `historyRedo` requieren un adaptador del historial nativo del editor. Después de restaurar el snapshot autoritativo en el textarea y en el motor, se puede llamar a `authorMonitor.resynchronize()`. Para composición IME, el adaptador escucha `compositionstart` y `compositionend`, expone `compositionActive` en `getState()` y acepta `insertCompositionText` solo dentro de una composición activa o cuando `InputEvent.isComposing` lo confirma. Cada pareja válida `beforeinput`/`input` produce un delta consecutivo; las sustituciones provisionales del IME se entregan en FIFO y no se consolidan ni se pierden. Si la composición comienza o termina con un `beforeinput` sin su `input`, o cambia el estado entre ambos eventos, se suspende el stream y se exige resincronización. Los editores con historial o transacciones de composición no representables con los eventos nativos del textarea deben implementar `LiveAuthorMonitorEditorChangeSource` con sus transacciones autoritativas.

Las pruebas `live-author-monitor-textarea-source.test.mjs`, `live-author-monitor-change-binding.test.mjs` y `live-author-monitor-textarea-integration.test.mjs` verifican rangos, secuencias, UTF-16, actualizaciones IME consecutivas, estados de composición incompletos, operaciones ambiguas, contrapresión FIFO, reintentos automáticos, ciclo de vida y resincronización durable.


## 12. Integración con el historial nativo del editor (undo/redo)

Los editores que exponen transacciones nativas deben usar `LiveAuthorMonitorEditorTransactionSource` y `mountLiveAuthorMonitorEditorTransactions`. Este camino no intenta convertir `historyUndo` o `historyRedo` de un `textarea` en deltas por inferencia: el editor anfitrión entrega el cambio que su propio historial ya aplicó.

El contrato del adaptador es. El montaje usa la interfaz compartida `LiveAuthorMonitorEditorHostApi`, también utilizada por el adaptador `textarea`; el alias histórico `LiveAuthorMonitorTextAreaHostApi` se conserva por compatibilidad:

- `getSnapshot(documentId)` devuelve el snapshot local actual del editor: texto, revisión y secuencia. Al montar debe coincidir exactamente con el snapshot durable de `HostEngineApi`.
- `subscribeTransactions(documentId, listener)` escucha operaciones locales ya aplicadas y las entrega en orden. El proveedor debe cancelar la suscripción cuando se invoque el callback de desmontaje.
- Cada transacción incluye un `transactionId` estable y único, `kind` (`edit`, `undo` o `redo`) y un `change` completo con `documentId`, `sequence`, `baseRevision`, `start`, `end` y `replacement`.
- Undo debe emitir el delta inverso real producido por el historial; redo debe emitir el delta realmente reaplicado. Las secuencias pertenecen al flujo de cambios del documento y siempre avanzan, incluso al deshacer. No se reutilizan la secuencia ni la revisión anteriores del estado que se restauró.
- Los rangos usan offsets UTF-16. Una transacción de varios rangos debe normalizarse en el adaptador a un delta contiguo equivalente o a una secuencia de cambios atómicos con revisiones/secuencias consecutivas.

Ejemplo de montaje, una vez que el anfitrión ha implementado el proveedor sobre la API transaccional de su editor:

```ts
import {
  mountLiveAuthorMonitorEditorTransactions,
  type LiveAuthorMonitorEditorTransactionProvider
} from "./motor-literario";

// El adaptador del anfitrión convierte el evento nativo ya aplicado
// en { transactionId, kind, change }. No simula beforeinput/input.
const editorProvider: LiveAuthorMonitorEditorTransactionProvider = {
  getSnapshot: documentId => nativeEditor.getDocumentSnapshot(documentId),
  subscribeTransactions: (documentId, listener) =>
    nativeEditor.subscribeTransactions(documentId, transaction => {
      listener({
        transactionId: transaction.id,
        kind: transaction.historyAction, // edit | undo | redo
        change: transaction.appliedDelta
      });
    })
};

const stopAuthorMonitor = mountLiveAuthorMonitorEditorTransactions({
  documentId,
  editor: editorProvider,
  hostApi: api,
  onBackpressure: state => renderEditorQueueState(state),
  onAdmission: (change, admission) =>
    renderEditorAdmission(change, admission),
  onError: (error, change) =>
    reportEditorSynchronizationError(error, change)
});

// Indicadores de historial y del stream, sin leer el manuscrito desde el monitor.
const state = stopAuthorMonitor.getState();
const pending = stopAuthorMonitor.getPendingChanges();

// Antes de desmontar la pestaña:
stopAuthorMonitor.dispose();
```

El montaje verifica antes de escuchar transacciones que:

1. el documento está abierto en `HostEngineApi`;
2. el motor está durable y no tiene cambios pendientes;
3. el snapshot local del editor coincide con el snapshot autoritativo;
4. existe una sesión de métricas para el documento.

Cada transacción se entrega una sola vez a `HostEngineApi.onEditorChange`. El monitor no registra admisiones ni commits por segunda vez. El enlace usa las mismas señales automáticas de reintento y contrapresión FIFO descritas en la sección 10.

La fuente mantiene una ventana acotada de identificadores de transacción (512 por defecto; configurable entre 1 y 4096). Una notificación repetida con el mismo ID y secuencia se descarta. Si el editor reutiliza el ID en otra secuencia, emite un hueco o presenta una revisión base incorrecta, el stream se suspende y solicita resincronización.

`resynchronize()` solo se permite cuando el motor está durable, sin cambios pendientes, y el snapshot actual del editor coincide exactamente con el del motor. Entonces se reconcilian las métricas, se restablece la fuente de transacciones y se limpia el backlog antiguo. `dispose()` retira tanto la suscripción del editor como la del monitor, sin cerrar el documento ni disponer `HostEngineApi`.

La fuente conserva únicamente longitud, revisión, secuencia, tipo de última transacción y los IDs de la ventana de deduplicación. No conserva copias del manuscrito ni cadenas de reemplazo. Los editores que no expongan transacciones nativas deben seguir usando el adaptador `textarea`; para ellos, las operaciones undo/redo sin un delta autoritativo siguen exigiendo resincronización.

Pruebas: `live-author-monitor-editor-transaction-source.test.mjs` y `live-author-monitor-editor-transaction-integration.test.mjs`, que verifican edición/undo/redo, IDs duplicados o reutilizados, huecos de secuencia, montaje, reintentos FIFO, recuperación y desmontaje.

## 13. Validación CI aislada del monitor

El workflow `.github/workflows/live-author-monitor.yml` construye el bundle de runtime con Vite y ejecuta exclusivamente las pruebas `tests/live-author-monitor*.test.mjs`. Esta validación separada permite verificar el monitor y su integración con el editor aunque una comprobación de tipos de otro módulo del motor interrumpa el workflow general. No reemplaza el chequeo TypeScript estricto ni la suite completa: ambos deben volver a quedar verdes antes de declarar validación global.

**Ejecución aislada del 25 de noviembre de 2026:** el bundle Vite y las pruebas específicas del monitor finalizaron correctamente: **72 aprobadas, 0 fallidas y 0 omitidas**. [Ejecución CI 45719731344](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45719731344), sobre el commit `612eb1e`. Vite transformó 23 módulos y completó el build. Esta ejecución cubre el montaje directo del textarea, el ciclo de composición IME, las transacciones nativas de edición/undo/redo, la verificación de snapshot tras cada transacción, el contrato compartido `LiveAuthorMonitorEditorHostApi`, el estado observable de contrapresión, la cola FIFO, los reintentos automáticos, la deduplicación, la resincronización durable y los tres nuevos escenarios de ciclo de vida síncrono.

**Estado de la CI general:** la ejecución [45719731442](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45719731442), sobre el mismo commit `612eb1e`, pasó instalación, pero falló en el chequeo estricto por errores localizados en `typescript/src/literary-analysis.ts`: incompatibilidad del arreglo de nodos del grafo (línea 3853), propiedades duplicadas (4403–4404), predicado y valores potencialmente nulos (4948–4950 y 4999), y un objeto de relación causal incompatible (5063). No aparecen errores TypeScript en los archivos del monitor. El archivo narrativo no se modificó para evitar interferir con el trabajo paralelo. La suite general y el benchmark quedaron omitidos por el fallo previo del typecheck; la CI aislada no sustituye la validación global.

## 14. Robustez del ciclo de vida de transacciones

El registro de suscripciones ahora contempla editores que reproducen eventos de forma síncrona dentro de `subscribeTransactions`. El adaptador conserva el callback de cancelación una vez que el proveedor lo devuelve y, acto seguido, comprueba si la emisión reentrante provocó una resincronización, un desmontaje o la eliminación del último listener. En esos casos retira de inmediato la suscripción, evitando dejar un listener huérfano.

No se abre una nueva suscripción si la fuente ya está dispuesta, requiere resincronización o no tiene listeners. Si un callback de observación dispone la fuente durante la entrega de un delta, la distribución se detiene y no se notifica a los listeners restantes.

La comprobación del snapshot posterior a una transacción está protegida frente a excepciones del proveedor. Si `getSnapshot` falla durante la captura, la fuente marca `needsResync`, emite el código `editor-state-unavailable`, desuscribe el proveedor y no propaga la excepción hacia el editor. La captura solo se reanuda tras una resincronización explícita con el snapshot autoritativo común.

Las pruebas de regresión agregadas a `live-author-monitor-editor-transaction-source.test.mjs` verifican: (1) una transacción inválida emitida sincrónicamente al suscribirse, (2) el desmontaje de la fuente desde un listener durante esa misma fase y (3) un error al leer el snapshot durante una edición. En los tres casos se comprueba la ausencia de listeners residuales o de excepciones que interrumpan el flujo de edición.

**Validación:** estos casos forman parte de las 72 pruebas aprobadas en la ejecución aislada `45719731344`; el build Vite finalizó correctamente.

## 15. Conexión concreta con el editor anfitrión

**Estado tras auditar el árbol del repositorio el 25 de noviembre de 2026:** el proyecto contiene el núcleo `Motor-Literario/typescript`, sus contratos, el motor y las pruebas del monitor. No contiene una aplicación de edición anfitriona ni un módulo concreto que exponga el historial/transacciones nativas de un editor. El archivo `package.json` del núcleo declara TypeScript y Vite como herramientas de desarrollo, pero no una dependencia de editor visual que permita implementar un adaptador específico.

Por tanto, `LiveAuthorMonitorEditorTransactionProvider` es actualmente el contrato de integración y `mountLiveAuthorMonitorEditorTransactions` es la conexión genérica ya implementada y probada con proveedores de prueba. **No debe describirse como una conexión ya instalada en la interfaz de producción.** La integración nativa real queda pendiente de que el anfitrión exponga su editor y su API transaccional concreta.

Para completar esa conexión, el anfitrión deberá proporcionar, por documento:
1. un snapshot local coherente con el snapshot durable de `HostEngineApi` (texto, revisión y secuencia);
2. una suscripción a transacciones ya aplicadas, con ID único, tipo `edit/undo/redo` y delta exacto UTF-16;
3. una función de cancelación de la suscripción y una lectura de snapshot actualizada antes de notificar la transacción.

No se sustituirá esta integración por inferencias a partir de teclas, eventos `historyUndo/historyRedo` o comparaciones de texto retenidas en memoria. Mientras el anfitrión use un `HTMLTextAreaElement`, puede montar el adaptador nativo `mountLiveAuthorMonitorTextArea`; las operaciones de historial que no entreguen un delta exacto seguirán necesitando resincronización segura.

## 16. Métricas visibles de pausas

El snapshot del monitor ya contabiliza `idleDurationMs` y `pauseCount`; a partir de esta actualización ambos valores se muestran también en las vistas de usuario:

- El panel del capítulo activo presenta el tiempo acumulado en pausa y el número de pausas detectadas.
- Cada tarjeta del tablero multi-documento presenta esos mismos indicadores, de modo que el estado de varios capítulos se puede comparar sin abrirlos.
- El tiempo en pausa se calcula con el umbral `idleAfterMs`; una pausa queda contabilizada cuando llega una nueva edición después de superar ese umbral. El paso a inactividad se refresca por el planificador sin exigir nuevas pulsaciones.
- Las cifras proceden del snapshot de métricas; las vistas no leen el manuscrito ni modifican el historial de edición.

Las pruebas del panel y del workspace avanzan el reloj controlado, registran una edición, dejan transcurrir el umbral y registran otra edición. Comprueban que aparece una pausa y que el tiempo acumulado se representa correctamente como duración.
