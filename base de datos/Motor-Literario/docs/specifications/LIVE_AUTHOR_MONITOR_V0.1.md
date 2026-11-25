# Monitoreo de actividad del autor en vivo — contrato v0.1

- **Estado:** núcleo implementado e integrado en `HostEngineApi`; adaptador de suscripción con refresco temporal disponible; panel visual del editor anfitrión pendiente.
- **Runtime:** TypeScript/JavaScript puro; sin dependencias externas ni servicios remotos.
- **Ubicación:** **typescript/src/live-author-monitor.ts**.
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

Pruebas específicas en **typescript/tests/live-author-monitor.test.mjs**, **typescript/tests/live-author-monitor-panel.test.mjs** y **typescript/tests/live-author-monitor-workspace.test.mjs**: apertura y edición; tiempo activo y pausas; rechazos; tickets y latencias p50/p95; commit fallido y resincronización; cierre bloqueado con pendientes; aislamiento entre documentos y suscriptores; transición a inactividad sin nuevas pulsaciones; refresco global; montaje y desmontaje del panel accesible; privacidad del manuscrito; sesiones múltiples; aperturas y cierres dinámicos; selección de capítulo y cancelación de suscripciones.

**Validación específica del monitor, panel y espacio de trabajo:** las 11 pruebas del núcleo, las 4 del panel individual y las 4 del espacio de trabajo multi-documento pasaron (19/19 en las ejecuciones focalizadas). El chequeo estricto de TypeScript, la compilación y la validación estructural previa a la suite también pasaron. [CI del espacio multi-documento](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45710569993), [CI del panel individual](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45710084925).

**Validación de la suite completa:** la ejecución más reciente terminó con 268 pruebas aprobadas, 30 fallidas, 222 canceladas y 9 omitidas (529 en total). Los fallos identificados pertenecen a otras áreas del repositorio, incluidas IndexedDB/migraciones, sincronización CAS de ideas, análisis literario y auditoría del esquema de almacenamiento. Las 19 pruebas focalizadas del monitoreo no registraron fallos. El benchmark se omitió porque la suite general falló. Por tanto, el módulo de monitoreo queda validado por sus pruebas focalizadas, pero la suite global y la integración visual en el editor anfitrión continúan pendientes.

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

## 9. Próximo tramo

Conectar el panel individual y el espacio de trabajo al editor real del anfitrión; validar escritura sostenida, varios documentos abiertos, saturación, recuperación, navegación entre capítulos y desmontaje de vistas en los runtimes objetivo.
