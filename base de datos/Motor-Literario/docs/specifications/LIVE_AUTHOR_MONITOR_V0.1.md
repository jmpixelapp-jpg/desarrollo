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
- El handle de desmontaje no descarta cambios retenidos: si la cola FIFO todavía contiene deltas, detener el enlace lanza un error y conserva las suscripciones para permitir el reintento o una resincronización autoritativa.
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
- `dispose()` retira los listeners del textarea y la suscripción de reintento solo cuando no queda backlog. Si hay deltas sin admitir, lanza un error y mantiene viva la integración; primero debe ejecutarse `retryPending()` o una `resynchronize()` válida. No cierra el documento ni dispone `HostEngineApi`.

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

`resynchronize()` solo se permite cuando el motor está durable, sin cambios pendientes, y el snapshot actual del editor coincide exactamente con el del motor. La fuente acepta primero ese snapshot común, limpia el backlog antiguo antes de volver a suscribirse al editor y solo después procesa las transacciones nuevas que el proveedor pudiera reproducir sincrónicamente durante la reconexión. Así, los deltas ya incluidos en el snapshot se descartan, pero los eventos posteriores se entregan como nuevos cambios. `dispose()` retira las suscripciones solo si el backlog está vacío; si quedan transacciones sin admitir, lanza un error y mantiene la integración montada para que se pueda reintentar o resincronizar. No cierra el documento ni dispone `HostEngineApi`.

La fuente conserva únicamente longitud, revisión, secuencia, tipo de última transacción y los IDs de la ventana de deduplicación. No conserva copias del manuscrito ni cadenas de reemplazo. Los editores que no expongan transacciones nativas deben seguir usando el adaptador `textarea`; para ellos, las operaciones undo/redo sin un delta autoritativo siguen exigiendo resincronización.

Pruebas: `live-author-monitor-editor-transaction-source.test.mjs` y `live-author-monitor-editor-transaction-integration.test.mjs`, que verifican edición/undo/redo, IDs duplicados o reutilizados, huecos de secuencia, montaje, reintentos FIFO, recuperación y desmontaje.

## 13. Validación CI aislada del monitor

El workflow `.github/workflows/live-author-monitor.yml` construye el bundle de runtime con Vite y ejecuta exclusivamente las pruebas `tests/live-author-monitor*.test.mjs`. Esta validación separada permite verificar el monitor y su integración con el editor aunque una comprobación de tipos de otro módulo del motor interrumpa el workflow general. No reemplaza el chequeo TypeScript estricto ni la suite completa: ambos deben volver a quedar verdes antes de declarar validación global.

**Ejecución aislada del 25 de noviembre de 2026:** el bundle Vite y las pruebas específicas del monitor finalizaron correctamente: **75 aprobadas, 0 fallidas y 0 omitidas**. [Ejecución CI 45720849538](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45720849538), sobre el commit `87b60c1`. Vite completó el build. Esta ejecución cubre el montaje directo del textarea, composición IME, transacciones nativas de edición/undo/redo, validación de snapshots, contrato `LiveAuthorMonitorEditorHostApi`, contrapresión, cola FIFO, reintentos automáticos, deduplicación, resincronización durable, desmontaje seguro sin pérdida de cambios y preservación de nuevas transacciones reproducidas sincrónicamente durante la reconexión.

**Estado de la CI general:** la ejecución más reciente disponible, [45720917701](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45720917701), sobre el commit documental `820841e`, volvió a fallar en el chequeo de tipos por errores confinados a `typescript/src/literary-analysis.ts`: incompatibilidad de `LiteraryIdeaGraphNode[]`, manejo de valores potencialmente nulos en predicados, estados de ideas con entradas `null` y una relación causal sin todas las propiedades requeridas. No aparecen errores TypeScript en los archivos del monitor. La suite general y el benchmark quedan omitidos por el fallo previo del typecheck; la validación aislada no reemplaza la CI completa.

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

## 17. Desmontaje seguro y protección del backlog

Una cola FIFO con deltas aún no admitidos forma parte del estado necesario para completar la sincronización del documento. Por tanto, detener el enlace mientras `getPendingChanges()` no está vacío ya no limpia esos deltas silenciosamente.

- La función de parada devuelta por `bindLiveAuthorMonitorEditorChanges` lanza un error antes de cambiar el estado o retirar suscripciones si todavía hay cambios pendientes.
- `dispose()` de los adaptadores textarea y transaccional aplica la misma comprobación antes de marcar la integración como dispuesta. Un desmontaje rechazado conserva listeners del editor y la señal automática de reintento.
- El anfitrión puede resolver el backlog con `retryPending()`. Para descartarlo, debe ejecutar una `resynchronize()` que demuestre que el snapshot actual del editor y el snapshot autoritativo durable del motor coinciden exactamente; solo entonces se permite limpiar la cola y desmontar.
- Los errores de desmontaje deben mostrarse al anfitrión como una condición de sincronización pendiente, no ignorarse. La pestaña o editor debe permanecer montado hasta admitir los deltas o completar la resincronización.

Las pruebas de regresión verifican el enlace base, la integración textarea y el proveedor transaccional: un desmontaje prematuro se rechaza, conserva el backlog y mantiene los listeners activos; una vez admitidos los cambios en FIFO, el desmontaje se completa y retira las suscripciones. Esto protege deltas capturados por el monitor frente a una pérdida silenciosa durante el cambio de pestaña o cierre de la vista.

**Validación de regresión:** los casos de desmontaje seguro están incluidos en la ejecución aislada `45720544576`: build Vite correcto y **74 pruebas aprobadas, 0 fallidas y 0 omitidas**.

**CI general después de la protección de desmontaje:** la ejecución [45720566629](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45720566629) vuelve a detenerse en el chequeo estricto de `literary-analysis.ts` (nodos del grafo, predicado nullable, estados de ideas y relación causal). El log de esta ejecución no reporta errores en los archivos del monitor; las pruebas generales y el benchmark se omiten por el fallo previo del typecheck.

## 18. Resincronización con replay síncrono del proveedor

La recuperación del adaptador transaccional usa una barrera de orden explícita. Tras comprobar que el motor está durable y que el snapshot local del editor coincide con el snapshot autoritativo, `LiveAuthorMonitorEditorTransactionSource.resynchronize` actualiza la base de revisión/secuencia y ejecuta su callback `beforeResume` antes de registrar de nuevo el listener del editor.

La integración conecta ese callback con `binding.discardPendingAfterResynchronization()`. El snapshot compartido ya contiene los cambios antiguos del backlog, por lo que es correcto retirarlos en ese punto. La suscripción se registra después, con la cola limpia: cualquier transacción nueva que el proveedor reproduzca de forma síncrona durante `subscribeTransactions` se valida contra el snapshot recién aceptado y se entrega inmediatamente a `HostEngineApi`, no se mezcla con el backlog antiguo.

Una prueba de regresión configura un editor que, en la segunda suscripción, aplica y emite una nueva transacción antes de devolver el callback de cancelación. La secuencia comprobada es: rechazo no recuperable de la transacción 1, reconciliación durable que ya incluye la transacción 1, resincronización, replay síncrono de la transacción 2 y confirmación de que el motor termina en secuencia/revisión 2 con el texto actualizado. El backlog termina vacío y el desmontaje retira las suscripciones normalmente.

**Validación de replay síncrono:** el caso de regresión descrito en la sección 18 se ejecutó en la CI aislada [45720849538](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45720849538), sobre el commit `87b60c1`: build Vite correcto y **75 pruebas aprobadas, 0 fallidas y 0 omitidas**.


## 19. Despacho FIFO ante transacciones reentrantes

La fuente transaccional serializa la notificación a suscriptores mediante una cola de despacho interna. Esto cubre un caso de reentrancia posible en editores anfitriones: un suscriptor puede ejecutar código que provoque otra transacción síncrona mientras todavía se está notificando la anterior.

- Cada delta validado se añade a la cola de despacho en orden de secuencia.
- Si ya existe un despacho en curso, una transacción reentrante se encola y espera a que todos los suscriptores reciban el delta actual.
- Los suscriptores observan así la misma secuencia FIFO; ninguno recibe la transacción 2 antes que la transacción 1.
- Las excepciones de un suscriptor siguen aisladas y no interrumpen la notificación a los demás.
- Al disponer la fuente se limpia la cola y no se entregan notificaciones posteriores.

La prueba de regresión instala dos suscriptores. El primero genera la transacción 2 desde el callback de la transacción 1; ambos deben observar exactamente [1, 2]. Esta garantía evita que consumidores distintos del mismo stream construyan estados divergentes por una reentrada síncrona.


## 20. Serialización del procesamiento ante reentrada

La cola FIFO anterior serializaba los callbacks, pero la revisión posterior identificó una sutileza: una transacción reentrante podía actualizar el snapshot interno antes de que todos los suscriptores terminasen de observar el delta previo. Aunque el orden de los argumentos era correcto, un consumidor que consultase `getState()` dentro del callback podía observar una secuencia adelantada.

La fuente ahora serializa también el procesamiento de las transacciones nativas:

- `handleTransaction` incorpora cada evento a una cola de transacciones pendientes.
- Un único bucle valida cada transacción, actualiza revisión/secuencia y completa su despacho a todos los suscriptores antes de procesar la siguiente.
- Las emisiones síncronas provocadas desde un callback se aplazan hasta finalizar la notificación actual.
- Durante el callback de la secuencia N, `getState().sequence` permanece en N; la secuencia N+1 solo se vuelve visible cuando empieza su propio procesamiento.
- Una resincronización requerida o un desmontaje vacía las transacciones aplazadas para evitar procesar eventos de un stream suspendido.

La prueba reentrante verifica tanto el orden como la coherencia de estado: dos suscriptores generan/observan el evento anidado y ambos deben observar `[[1, 1], [2, 2]]`, donde cada pareja contiene la secuencia del delta y la secuencia consultada al propio source durante el callback.


## 21. Límite de seguridad para eventos reentrantes

La serialización de transacciones ahora tiene un límite configurable de memoria mediante `maxQueuedTransactions` (valor predeterminado: 4096; rango permitido: 1–65536). Si el proveedor genera una ráfaga reentrante mayor que ese límite, el source no descarta eventos y continúa como si nada: emite `transaction-backlog-overflow`, suspende la suscripción y exige resincronizar contra un snapshot autoritativo.

El límite solo aplica a transacciones que se acumulan mientras otra transacción está siendo notificada. El procesamiento normal secuencial no consume esta cola de espera. Al entrar en estado de resincronización, los eventos aplazados se limpian y no vuelven a alimentar el motor; el snapshot local actualizado permite reconciliar lo que realmente aplicó el editor.

La prueba fija el límite en un evento, provoca dos ediciones síncronas reentrantes y verifica que solo se admite el primer delta, la fuente queda pausada con `transaction-backlog-overflow` y la suscripción nativa se retira. La recuperación debe hacerse con el snapshot reconciliado, no reintentando eventos parciales fuera de orden.


## 22. Validación de configuración del backlog reentrante

`maxQueuedTransactions` se valida al construir la fuente antes de registrar cualquier suscripción. Solo se aceptan enteros seguros entre 1 y 65536; `undefined` utiliza el valor predeterminado 4096. Cero, negativos, fracciones, valores mayores al máximo, `NaN` e infinitos producen `RangeError`.

La prueba de configuración cubre los valores inválidos y confirma que los límites 1 y 65536, además del valor predeterminado, pueden construirse. También verifica que una configuración inválida no registre listeners en el proveedor.

**Validación CI:** ejecución aislada [45721703791](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45721703791), commit `4f74096c8ce17e70a3c88aa1519ec2be81585d38`: build Vite correcto; **78 pruebas aprobadas, 0 fallidas y 0 omitidas**.


## 23. Recuperación después del desbordamiento reentrante

La prueba de desbordamiento se amplió para validar también el ciclo completo de recuperación. Al superar el límite, el source conserva el estado de pausa y se desuscribe; no intenta aplicar los eventos parciales que quedaron en espera. El editor sí puede haber aplicado esas transacciones localmente, de modo que el anfitrión debe reconciliar primero su snapshot durable con el snapshot actual del editor.

Una vez aceptado el snapshot local reconciliado, `resynchronize()` actualiza la revisión y secuencia de referencia, limpia los eventos aplazados y registra de nuevo el proveedor. La prueba fuerza dos eventos reentrantes por encima de un límite de uno: el source primero pausa en la secuencia 1, después acepta el snapshot que ya contiene hasta la secuencia 3 y finalmente captura la nueva edición de secuencia 4. Los consumidores observan `[1, 4]`; las secuencias 2 y 3 quedan incorporadas en el snapshot reconciliado, no reproducidas como deltas parciales.

**Validación CI:** ejecución específica [45721849829](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45721849829), commit `a9093daeac9b25bed3b2f5638f5c25fecb6d8efe`: build Vite correcto; **78 pruebas aprobadas, 0 fallidas y 0 omitidas**.


## 24. Checkpoints durables de sesión

El monitor incorpora un checkpoint versionado de métricas, definido por `StoredLiveAuthorMonitorCheckpoint` (versión 1). El registro guarda identidad de proyecto/documento y sesión, timestamp de guardado, duración acumulada, actividad/inactividad, edad de la última actividad, contadores de cambios y muestras de latencia. **No guarda texto del manuscrito, reemplazos, selección, deltas ni tickets de edición pendientes.**

Solo se puede crear cuando:
- no existen tickets pendientes de commit;
- la sesión no está marcada `needsResync`;
- revisión y secuencia más recientes coinciden con las durables.

### Persistencia IndexedDB

`ProjectStore` ofrece tres operaciones opcionales:
- `saveLiveAuthorMonitorCheckpoint(checkpoint)`
- `loadLiveAuthorMonitorCheckpoint(projectId, documentId)`
- `deleteLiveAuthorMonitorCheckpoint(projectId, documentId)`

`IndexedDbProjectStore` las implementa mediante el almacén compuesto `live-author-monitor-checkpoints`, aislado por `projectId/documentId`. La base local sube de versión 22 a **23** para crear este almacén sin alterar los documentos ni el journal existentes. Las escrituras rechazan un checkpoint cuyo timestamp sea más antiguo que el ya guardado y las lecturas validan identidad, versión, contadores, duraciones y muestras de latencia.

### Guardado, cierre y restauración

- `HostEngineApi` programa un guardado no bloqueante cuando la sesión llega a un estado durable después de un commit; los fallos de persistencia se reportan sin interrumpir la edición.
- `closeLiveAuthorMonitorDocumentSafely(documentId)` espera a que el motor quede inactivo, comprueba el estado durable, persiste un checkpoint y solo después cierra la sesión de métricas.
- `disposeSafely()` espera a la cola del motor y los checkpoints ya programados antes de liberar la instancia.
- Durante `openDocument/recoverDocument`, el anfitrión intenta cargar el checkpoint y restaurarlo sobre el snapshot recuperado. La restauración requiere identidad, longitud, revisión y secuencia exactamente coincidentes.
- Si el checkpoint está corrupto, obsoleto o no coincide con el snapshot durable, se elimina y se inicia una sesión nueva desde el estado real recuperado. Así no se atribuyen a las métricas cambios que el checkpoint no describe.
- El intervalo entre `savedAt` y la restauración se suma al tiempo de sesión y al tiempo inactivo; nunca se contabiliza como tiempo escribiendo. La sesión restaurada comienza en estado inactivo y la siguiente edición contabiliza la pausa correspondiente.
- Los IDs de sesión incluyen un nonce para no reutilizar la identidad de una sesión anterior tras reiniciar la aplicación.

Los checkpoints conservan métricas agregadas y muestras recientes, no el historial completo del escritor. Los almacenes anfitriones que no implementen los métodos opcionales pueden seguir usando el monitor en memoria; el cierre seguro con persistencia exige `saveLiveAuthorMonitorCheckpoint`.

**Límite de concurrencia:** la persistencia por clave evita mezclar documentos, pero todavía no implementa un lease/fencing token entre dos instancias de la aplicación que editen simultáneamente el mismo documento. La coordinación multi-pestaña de sesiones de monitoreo queda como trabajo separado; el checkpoint no debe considerarse un bloqueo de edición ni un mecanismo de sincronización del manuscrito.


**Validación de la implementación:** la ejecución aislada [45722890027](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45722890027), sobre el commit `8c2578174e002a7ba55447a607b5ea07b4a73c61`, terminó correctamente: build Vite y **84 pruebas aprobadas, 0 fallidas y 0 omitidas**. Incluye pruebas del contrato del monitor y del ciclo de recuperación en `HostEngineApi` mediante un almacén de prueba. La CI general de ese commit solo conserva errores ajenos en `src/literary-analysis.ts`; no reporta errores de tipos en los archivos del monitor, HostEngineApi, contratos o persistencia.


## 25. Propagación de errores de persistencia en lifecycle seguro

Los guardados automáticos de checkpoint son no bloqueantes durante la escritura: un fallo se reporta a la observabilidad del anfitrión y no se lanza dentro del callback del motor. Sin embargo, el error no se elimina del estado operativo de la instancia.

- Los errores de guardado quedan asociados al documento hasta que un guardado posterior se complete correctamente.
- `closeLiveAuthorMonitorDocumentSafely` espera el trabajo automático en curso y realiza un guardado final nuevo antes de cerrar. Si el guardado final falla, rechaza el cierre y conserva la sesión en memoria.
- `disposeSafely` espera las colas de checkpoint y rechaza el desmontaje si queda algún error de persistencia sin resolver. No elimina la sesión como si el guardado hubiera terminado bien.
- Un commit durable posterior o un guardado final que tenga éxito limpia el error retenido.

La prueba de HostEngineApi utiliza un almacén que falla al guardar y comprueba que `disposeSafely` rechaza la operación mientras el snapshot de métricas sigue disponible. Esto separa la observabilidad no bloqueante del estado real de persistencia: el autor puede seguir escribiendo, pero el anfitrión no recibe una falsa confirmación de cierre seguro.


**Validación de lifecycle seguro:** ejecución aislada [45723191692](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45723191692), commit `dde974d98cd5b0c9b9dacc9c86a35ab26e4b0d95`: build Vite correcto; **85 pruebas aprobadas, 0 fallidas y 0 omitidas**. Incluye el caso donde el almacenamiento falla y se comprueba que `disposeSafely()` no libera falsamente la instancia.


## 26. Correspondencia del almacén IndexedDB con el manifiesto físico

El checkpoint y el lease del monitor forman parte del esquema físico y deben figurar en el manifiesto activo `MLDB/storage_mapping_v0.4.2.json`. La base local se encuentra en versión **24** y el manifiesto activo en `mapping_version: 14`.

Los dos almacenes operativos se aíslan por la clave compuesta `[projectId, documentId]` y declaran el índice `by-project`:

- `live-author-monitor-checkpoints`: métricas agregadas de la sesión; nunca texto ni deltas del manuscrito.
- `live-author-monitor-leases`: propietario temporal, fechas de reserva y fencing token monotónico.

El manifiesto histórico `storage_mapping_v0.4.1.json` se mantiene sin alterar. La tabla funcional de documentos y el journal de cambios no se modifican. El lease coordina exclusivamente la escritura de métricas y no bloquea la edición.

El workflow específico del monitor ejecuta `npm run validate:schema` antes del build y las pruebas. También ejecuta `tests/storage-implementation-audit.test.mjs` contra el manifiesto activo para detectar almacenes o índices físicos no declarados.

**Validaciones anteriores:** las ejecuciones [45723969106](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45723969106) y [45724540335](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45724540335) validaron la etapa anterior con 33 almacenes en versión 23. La etapa actual amplía el esquema con el almacén de leases y lo eleva a versión 24/34 almacenes; su resultado específico se actualizará tras verificar la ejecución de esta entrega.

## 27. Prueba de runtime de IndexedDB para checkpoints

La persistencia ya no se valida solo por la interfaz `ProjectStore` en memoria y la auditoría estática. Se añadió `tests/live-author-monitor-indexeddb.test.mjs`, que ejecuta `IndexedDbProjectStore` contra `fake-indexeddb` (polyfill de desarrollo, versión 6.2.8). El polyfill implementa la API IndexedDB en memoria para Node; no escribe en disco ni persiste entre procesos.

La prueba verifica:
- guardar y leer un checkpoint por proyecto/documento;
- que la lectura devuelve copias independientes del objeto y de las muestras de latencia;
- rechazo de una escritura con `savedAt` anterior al registro persistido;
- aceptación de una escritura más nueva y sustitución del checkpoint;
- aislamiento de claves de otros proyectos y eliminación del registro;
- cierre de conexión mediante `IndexedDbProjectStore.close()` al finalizar.

`close()` espera una apertura pendiente, cierra la conexión IndexedDB y cierra el canal de notificaciones de la instancia. Una operación posterior puede abrir una nueva conexión. `fake-indexeddb` es dependencia de desarrollo; la implementación de producción sigue usando el IndexedDB nativo del navegador.

**Límite de validación:** esta prueba ejercita las transacciones y operaciones del adaptador contra el polyfill en memoria. No sustituye una prueba de navegador real ni demuestra persistencia física entre cierres y reinicios del navegador. Esa prueba E2E de navegador queda pendiente.


**Validación CI verificada:** ejecución [45724325962](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45724325962), commit `2dca17b54eb2454026a298a6409f325e6dd1035e`: esquema 0.4.2 válido, 25 tablas del motor y 33 almacenes IndexedDB, build Vite correcto y **99 pruebas aprobadas, 0 fallidas y 0 omitidas**. Incluye el test del adaptador IndexedDB contra `fake-indexeddb@6.2.8`.


## 28. Migración de base v22 a v24 sin pérdida de documentos

La prueba de runtime incluye una actualización desde una base IndexedDB versión 22 que contiene los almacenes previos del manifiesto v0.4.2 y un documento guardado. Al abrirla mediante `IndexedDbProjectStore`, la migración crea los almacenes de checkpoint y lease hasta alcanzar la versión **24**.

La prueba comprueba:
- la versión final de la base es 24;
- existen `live-author-monitor-checkpoints` y `live-author-monitor-leases`;
- ambos almacenes usan keyPath `[projectId, documentId]` e índice `by-project`;
- se puede adquirir un lease, guardar y recuperar un checkpoint protegido por ese lease;
- el documento anterior de `documents` conserva su texto y revisión originales.

El test usa `fake-indexeddb` en memoria. Verifica el código de migración, las transacciones y la preservación de registros durante la actualización, pero no sustituye una prueba E2E en navegador con IndexedDB físico y reinicio real.

## 29. Reapertura de IndexedDbProjectStore después de close()

La prueba de ciclo de vida ahora cierra explícitamente una conexión del almacén después de guardar el checkpoint y vuelve a leerlo usando la misma instancia IndexedDbProjectStore. La lectura posterior debe abrir una nueva conexión y devolver el mismo checkpoint sin modificaciones. Después se ejecuta el borrado normal y se confirma que la clave ya no existe.

Esto verifica que close() libera la conexión actual, pero no vuelve inutilizable la instancia. El estado persistido permanece en IndexedDB y la siguiente operación puede crear una conexión nueva.

**Validación CI:** ejecución [45724732118](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45724732118), commit 1a48078743c450bb7c90e4dd78c75b1eac902fbc: MLDB 0.4.2 válido; auditoría física correcta con 25 tablas del motor y 33 almacenes IndexedDB; build Vite correcto; 100 pruebas aprobadas, 0 fallidas y 0 omitidas.



## 30. Protección frente a escrituras de checkpoints atrasados

El guardado del checkpoint se realiza en una transacción IndexedDB readwrite por clave de proyecto/documento. Antes de sustituir el registro existente, el adaptador valida su estructura y comprueba el orden del candidato:
- el checkpoint entrante no puede tener un timestamp de guardado anterior al ya persistido;
- la revisión y la secuencia entrantes no pueden retroceder respecto del checkpoint almacenado, aunque el reloj de la otra pestaña indique un timestamp posterior;
- cuando ambos checkpoints pertenecen a la misma sessionId, tampoco pueden retroceder las duraciones acumuladas, pausas, contadores de cambios, caracteres insertados/eliminados, resincronizaciones ni latencia total acumulada;
- una sessionId nueva puede iniciar contadores nuevos sobre el mismo snapshot durable cuando su timestamp es posterior y la revisión/secuencia no retroceden.

Si el candidato está atrasado, se aborta la transacción readwrite y el checkpoint anterior permanece intacto. Los campos que pueden variar de forma no monótona dentro de una misma sesión, como la edad de última actividad, la longitud actual del documento o la última latencia individual, no se usan como contadores acumulativos.

Las pruebas cubren un guardado de revisión/secuencia anterior con timestamp mayor, el retroceso de métricas de la misma sesión, la conservación del checkpoint existente y el inicio de una nueva identidad sobre el mismo snapshot.

**Alcance:** esta barrera impide que checkpoints obsoletos reemplacen métricas más avanzadas; no constituye un lease ni un fencing token de edición. La coordinación de dos escritores activos sobre el mismo documento sigue dependiendo del journal/HostEngine compartido y queda fuera de este control de checkpoint.

**Validación CI:** ejecución [45724891204](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45724891204), commit 8a584270842aca3d65f635a5b4ec0bd98ad84038: MLDB 0.4.2 válido, auditoría física correcta (25 tablas/33 almacenes), build Vite y **102 pruebas aprobadas, 0 fallidas y 0 omitidas**.



## 31. Lease de titularidad y fencing token entre pestañas

### Contrato y almacenamiento

Cada instancia HostEngineApi crea un ownerId único. IndexedDbProjectStore mantiene un registro por proyecto/documento en live-author-monitor-leases. El registro incluye ownerId, acquiredAt, expiresAt y fencingToken. La reserva por defecto dura 30 segundos y el anfitrión la renueva cada 10 segundos mientras conserva la sesión.

El token aumenta cuando una reserva expira o se libera y otro propietario la adquiere. Una renovación válida del mismo propietario conserva el token. La fila liberada se mantiene como registro expirado para que la siguiente titularidad incremente el token en vez de reiniciarlo.

### Atomicidad y seguridad de escritura

- La adquisición, renovación y liberación usan transacciones IndexedDB readwrite por proyecto/documento. Dos pestañas que compiten por una reserva activa no pueden adquirirla ambas.
- saveLiveAuthorMonitorCheckpoint requiere un StoredLiveAuthorMonitorLease. En una sola transacción readwrite que incluye los almacenes de leases y checkpoints, el adaptador vuelve a leer el registro vigente y comprueba ownerId, fencingToken y expiración antes de guardar.
- Si una pestaña antigua intenta escribir después de que otra haya adquirido un token superior, la transacción se aborta. La comparación no depende de que el objeto de lease local sea reciente: una copia antigua del mismo token sigue siendo válida si el registro persistido se renovó y no cambió la titularidad.
- La barrera monotónica de revisión, secuencia y métricas de la sección 30 sigue activa dentro de la misma transacción.

### Comportamiento del HostEngineApi

- Al abrir o recuperar un documento, el anfitrión intenta adquirir la reserva antes de restaurar el checkpoint compartido. Solo el titular lee/restaura y publica métricas persistentes.
- La pestaña sin lease puede mantener métricas locales en memoria y continuar editando, pero no escribe checkpoints compartidos mientras otra instancia conserve la titularidad.
- Una pestaña observadora vuelve a intentar adquirir el lease en el siguiente punto seguro de checkpoint o durante el cierre seguro. Si el propietario anterior lo liberó, obtiene un fencing token superior y comienza a persistir su sesión local sobre el snapshot durable.
- closeLiveAuthorMonitorDocumentSafely guarda un último checkpoint y libera el lease. disposeSafely guarda las sesiones que aún poseen lease, espera las escrituras y libera las reservas antes de disponer el anfitrión.
- Si la liberación falla, se conserva la reserva local y se reanuda el heartbeat para permitir un reintento. dispose() síncrono detiene el heartbeat pero no libera la reserva; esta expira de forma natural, por lo que el anfitrión debe preferir disposeSafely() cuando requiere una liberación confirmada.
- Los almacenes anfitriones antiguos que no implementan las operaciones de lease siguen siendo compatibles, pero no proporcionan coordinación entre pestañas; la garantía de fencing corresponde a IndexedDbProjectStore y a almacenes que implementen el contrato completo.

### Alcance

El lease protege exclusivamente los checkpoints de métricas. No bloquea el editor, no decide qué pestaña puede modificar el manuscrito y no sustituye el journal durable, la resolución de conflictos ni la sincronización de cursores. Dos editores pueden seguir necesitando la coordinación del motor anfitrión para los cambios del documento.

Las pruebas cubren contienda de dos propietarios, renovación, incremento del token después de liberación/expiración, rechazo de escritura del propietario anterior, handoff en HostEngineApi, renovación con snapshot local antiguo y fallo temporal de liberación.

**Validación CI verificada:** ejecución específica [45726102805](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45726102805), commit `56f7269ba27afcd1883c3232c0968eef19ba76f2`: esquema MLDB 0.4.2 válido, auditoría física correcta (25 tablas y 34 almacenes), build Vite y **107 pruebas aprobadas, 0 fallidas y 0 omitidas**. Incluye la regresión que fuerza un fallo de liberación y verifica que se conserva la reserva para reintentar.



## 32. Prueba E2E de titularidad entre dos pestañas con Chromium

Se añadió una prueba de navegador real para que la coordinación no dependa únicamente de `fake-indexeddb` en memoria:
- `tests/browser/live-author-monitor-lease.html` es un harness exclusivo de pruebas. Carga directamente el adaptador TypeScript `IndexedDbProjectStore` desde Vite y no se copia al bundle de producción.
- `tests/live-author-monitor-browser.test.mjs` inicia un servidor Vite de prueba, arranca Chromium mediante Playwright y abre dos páginas independientes dentro del mismo contexto/origen. Cada página crea su propia instancia de `IndexedDbProjectStore`; ambas comparten la base IndexedDB real del navegador.
- Las dos páginas compiten simultáneamente por el mismo proyecto/documento. La prueba exige que solo una adquiera el lease inicial y que la otra no pueda adquirirlo mientras siga activo.
- La primera página libera; la segunda adquiere el token siguiente. La escritura del checkpoint con el objeto de lease antiguo debe ser rechazada por fencing, mientras la nueva titularidad puede guardar y la página anterior lee el checkpoint compartido.
- El workflow instala Chromium con `npx playwright install --with-deps chromium` antes de ejecutar la suite.

Esta E2E valida el comportamiento de la capa IndexedDB y el fencing entre pestañas en un navegador real; no simula ni acredita un editor de manuscritos de producción. El HTML del harness es una fixture de tests, no una UI distribuida.

**Validación CI verificada:** ejecución [45726598052](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45726598052), commit `0d1448e8aa1d635cdd4cee8568c4b19e74738729`: MLDB 0.4.2 válido, auditoría física correcta (25 tablas, 34 almacenes), build Vite y **108 pruebas aprobadas, 0 fallidas y 0 omitidas**. Incluye la ejecución de la prueba en Chromium.

**Límite pendiente de integración:** el árbol actual del repositorio no contiene páginas HTML de la aplicación, componentes de edición, ni dependencias de un editor como Monaco, CodeMirror, ProseMirror o Lexical. Por tanto, `LiveAuthorMonitorEditorTransactionProvider` sigue siendo el contrato correcto para el anfitrión, pero todavía no existe una API de transacciones de producción a la que conectar el adaptador. No se debe reconstruir undo/redo a partir de `input`/DOM ni presentar el harness como editor real.



**Extensión de ciclo de vida:** después de que la segunda página guarda el checkpoint y la primera puede leerlo, la prueba recarga la segunda página. La recarga destruye el contexto JavaScript y crea una instancia nueva de IndexedDbProjectStore; se vuelve a leer la misma clave y se comprueba que el checkpoint permanece. Esto valida persistencia ante una recarga de página dentro del perfil Chromium de prueba, no un reinicio del navegador/proceso ni almacenamiento de perfil persistente.

**CI de la recarga verificada:** ejecución [45726777208](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45726777208), commit `702846e433654611343fbfc143b0b0ea2475d2a5`: esquema MLDB 0.4.2 válido, auditoría física correcta (25 tablas, 34 almacenes), build Vite y **108 pruebas aprobadas, 0 fallidas y 0 omitidas**. La prueba recargó una página Chromium y recuperó el checkpoint con una nueva instancia del adaptador.



## 33. Robustez del heartbeat, descarte tras dispose y takeover por expiración

### Respuestas tardías y liberación

El heartbeat renueva la titularidad en segundo plano, pero una respuesta asíncrona puede terminar después de que el anfitrión haya empezado a liberar el lease. Para evitar que una renovación tardía vuelva a poblar el estado local:
- cada ciclo de heartbeat captura un token de generación por identidad de objeto; release/dispose lo invalida antes de continuar;
- se serializa el trabajo de heartbeat por documento para no solapar varios intentos lentos;
- al volver la operación IndexedDB, solo actualiza el estado local si el token de generación sigue siendo exactamente el mismo, el documento conserva el mismo ownerId/fencingToken y la instancia no está liberando ni dispuesta;
- las respuestas de generaciones anteriores no pueden restaurar el lease, recrear timers ni marcar de nuevo la pestaña como titular.

### dispose mientras hay adquisiciones pendientes

`HostEngineApi.dispose()` es terminal e idempotente. Si una adquisición o renovación empezó antes de disponer la instancia y el almacén responde después, el anfitrión detecta el estado `disposed`, no crea un heartbeat y libera el lease recién confirmado. La recuperación del documento también se interrumpe antes de abrir métricas nuevas cuando la instancia ya fue dispuesta.

El método síncrono `dispose()` no puede esperar transacciones ni garantizar una liberación confirmada; detiene timers y deja que cualquier reserva ya confirmada expire. `disposeSafely()` sigue siendo el método de cierre recomendado porque persiste, espera y libera antes de disponer.

### Recuperación de una pestaña observadora cuando el dueño desaparece

Una instancia que no posee el lease conserva un heartbeat de sondeo cada 10 segundos. Mientras el propietario siga activo, la adquisición falla sin alterar el checkpoint. Si el dueño se cierra abruptamente y no ejecuta release, la pestaña observadora vuelve a intentar la adquisición al siguiente heartbeat; una vez vencido el TTL de 30 segundos obtiene el fencing token siguiente y puede guardar su checkpoint. No requiere que el autor vuelva a teclear ni que exista un evento de liberación.

### Regresiones cubiertas

- renovación de heartbeat demorada que responde después del cierre seguro: no restaura el lease local;
- adquisición IndexedDB pendiente mientras se ejecuta dispose(): la reserva se libera cuando se confirma y no se crea timer;
- pérdida del propietario sin release(): el heartbeat de la instancia observadora adquiere al expirar el TTL y guarda el checkpoint con el nuevo fencing token.

**Validación CI verificada:** ejecución específica [45727622443](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45727622443), commit `2f78c0b542b8146a8924b5b980c05cc090ddc986`: MLDB 0.4.2 válido, auditoría física correcta (25 tablas/34 almacenes), build Vite y **112 pruebas aprobadas, 0 fallidas y 0 omitidas**. La CI general [45727622233](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45727622233) continúa bloqueada solo por errores TypeScript en `src/literary-analysis.ts`; no reporta errores del monitor.



## 34. Cancelación de restauración cuando dispose() gana la carrera

Además de evitar adquisiciones tardías, la recuperación vuelve a comprobar el ciclo de vida después de cargar el checkpoint compartido. Una lectura IndexedDB puede terminar después de que la instancia haya sido dispuesta; en ese caso se abandona la restauración antes de llamar a restoreCheckpoint/openDocument sobre LiveAuthorMonitor.

La regresión usa un almacén de prueba que retiene la promesa de loadLiveAuthorMonitorCheckpoint: el HostEngineApi inicia recoverDocument, la prueba llama dispose() mientras la lectura está pendiente y luego libera la promesa. Al finalizar la recuperación no debe existir snapshot de métricas ni heartbeat local.

**Validación CI:** ejecución [45727834409](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45727834409), commit `351f2232822a8a7005ff5df7675f044537db7cab`: build Vite, MLDB 0.4.2 válido, auditoría física correcta (25 tablas/34 almacenes) y **113 pruebas aprobadas, 0 fallidas y 0 omitidas**.
