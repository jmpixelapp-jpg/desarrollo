# Monitoreo de actividad del autor en vivo — contrato v0.1

- **Estado:** núcleo, refresco temporal, panel DOM, tablero multi-documento, selección de pestaña activa, enlace tipado del stream y adaptador nativo para textarea disponibles. Los editores con historial propio pueden requerir un adaptador específico.
- **Runtime:** TypeScript/JavaScript puro; sin dependencias externas ni servicios remotos.
- **Ubicación:** **typescript/src/live-author-monitor.ts**, **live-author-monitor-panel.ts**, **live-author-monitor-workspace.ts**, **live-author-monitor-editor-integration.ts** y **live-author-monitor-change-binding.ts**.
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

Pruebas específicas en **typescript/tests/live-author-monitor.test.mjs**, **live-author-monitor-panel.test.mjs**, **live-author-monitor-workspace.test.mjs**, **live-author-monitor-editor-integration.test.mjs**, **live-author-monitor-change-binding.test.mjs** y **live-author-monitor-host-api.test.mjs**: métricas de admisión/commit; tiempo activo y pausas; refresco sin nuevas pulsaciones; privacidad del manuscrito; panel accesible; varios documentos; aperturas/cierres; selección de capítulo; entrega única de deltas; conservación de rechazos para contrapresión; cancelación de suscripción; reanudación idempotente desde el snapshot durable; rechazo de reanudación con cambios pendientes.

**Validación específica de monitoreo e integración de editor:** las 30 pruebas de los seis archivos dedicados al monitoreo pasaron (30/30). El chequeo estricto de TypeScript, la compilación y la validación estructural del esquema también pasaron. [Ejecución CI 45712143641](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45712143641). La integración con el editor anfitrión sigue requiriendo un adaptador real que implemente la fuente de deltas y la selección de pestaña de la aplicación.

**Validación de la suite completa:** la ejecución terminó con 283 pruebas aprobadas, 26 fallidas, 222 canceladas y 9 omitidas (540 en total). Los 26 fallos se concentran en los módulos de grafo y resonancia de ideas, sincronización CAS de ideas, análisis literario y auditoría de almacenamiento. Ninguno pertenece a los seis archivos de pruebas específicos del monitoreo. El benchmark se omitió porque la suite general terminó con errores; no se declara validación global completa.

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
- Informa excepciones a onError y deja al anfitrión la política de recuperación.
- No registra eventos manuales adicionales en LiveAuthorMonitor, porque HostEngineApi ya incorpora admisiones y commits.

ensureLiveAuthorMonitorDocument(documentId) restaura una sesión de observabilidad que se cerró mientras el documento del motor seguía abierto. Devuelve la sesión existente si ya está activa; en caso contrario, utiliza el snapshot actual del motor. Rechaza si el documento tiene cambios pendientes (pendingSequence !== sequence) o necesita resincronización. La integración con la pestaña activa usa este método automáticamente si la sesión no existe.

## 11. Adaptador nativo para textarea y reintento automático

El módulo `live-author-monitor-textarea-source.ts` conecta un `HTMLTextAreaElement` sin React ni dependencias. Convierte el par nativo `beforeinput`/`input` en un `EditorChange` ordenado y se conecta con `bindLiveAuthorMonitorEditorChanges`.

```ts
import {
  LiveAuthorMonitorTextAreaSource,
  bindLiveAuthorMonitorEditorChanges
} from "./motor-literario";

const snapshot = api.getSnapshot(documentId);
if (!snapshot) throw new Error("El documento no está abierto");

const source = new LiveAuthorMonitorTextAreaSource({
  element: editorTextArea,
  initialSnapshot: snapshot,
  onError: error => reportEditorSynchronizationError(error)
});

const binding = bindLiveAuthorMonitorEditorChanges({
  source,
  sink: api,
  // Los commits y las admisiones publican métricas; el enlace reintenta
  // automáticamente su cola FIFO cuando recibe cualquiera de esas señales.
  subscribeRetrySignal: listener =>
    api.subscribeLiveAuthorMonitor(() => listener()),
  onAdmission: (change, admission) => {
    if (admission.status === "rejected" && admission.reason !== "queue_full") {
      source.requireResynchronization(
        "El motor rechazó un delta que requiere reconciliación."
      );
      reportEditorSynchronizationError(admission, change);
    }
  },
  onError: (error, change) => reportEditorSynchronizationError(error, change)
});

// Al desmontar el editor:
binding();
source.dispose();
```

Reglas del adaptador:

- Comprueba que el texto visible coincida con el snapshot autoritativo al iniciarse y al resincronizarse.
- Usa `selectionStart`, `selectionEnd`, longitud anterior y `inputType`; no mantiene una segunda copia del manuscrito.
- Admite inserción, pegado, reemplazo de selección y borrado hacia atrás/adelante. Los offsets y las longitudes son unidades UTF-16, incluidos los pares sustitutos.
- No inventa rangos si falta `beforeinput`, cambia el valor por código sin una operación equivalente o no puede determinar la dirección de borrado: suspende el stream y notifica `onError`.
- `historyUndo` y `historyRedo` requieren el contrato de historial del editor anfitrión. Tras reconciliar el contenido visible con un snapshot del motor, llamar a `source.resynchronize(snapshot)`.
- El enlace retiene en FIFO cualquier delta rechazado o cuyo envío arroje un error; mientras exista backlog, no envía eventos posteriores.
- `subscribeRetrySignal` permite enlazar los eventos de métricas del anfitrión. Cada commit/admisión genera una señal que intenta vaciar el backlog; si el motor continúa lleno, el delta permanece retenido para la próxima señal.
- `retryPending()` sigue disponible para reintentos explícitos; `getPendingChanges()` permite inspeccionar el backlog.
- `discardPendingAfterResynchronization()` solo se usa después de reconciliar el texto visible y el motor con un snapshot autoritativo. No se usa para resolver un `queue_full` temporal.
- La función devuelta sigue siendo invocable como `binding()`; cancela el stream, la señal de reintento y libera el backlog. `source.dispose()` retira listeners. Ninguno cierra el documento ni dispone `HostEngineApi`.

Las pruebas dedicadas `live-author-monitor-textarea-source.test.mjs` y `live-author-monitor-change-binding.test.mjs` cubren rangos, secuencias, reemplazos, borrados, UTF-16, undo/redo, resincronización, errores, contrapresión FIFO y reintentos automáticos. Los editores que manejan su propio historial/composición deben implementar la misma interfaz `subscribeChanges` con sus operaciones transaccionales nativas.
