# Monitoreo de actividad del autor en vivo — contrato v0.1

- **Estado:** primera implementación aislada, lista para integración en el anfitrión.
- **Runtime:** TypeScript/JavaScript puro; sin dependencias externas ni servicios remotos.
- **Ubicación:** **typescript/src/live-author-monitor.ts**.
- **Alcance:** métricas por sesión y documento, eventos de admisión/commit, pausas, ritmo estimado, resincronización y suscripciones.

## 1. Responsabilidad y límites

**LiveAuthorMonitor** observa la actividad que el editor anfitrión ya entrega al motor. No sustituye **LiteraryEngine**, no aplica deltas, no persiste snapshots y no ejecuta análisis literario. La identidad del proyecto y el snapshot inicial continúan siendo responsabilidad del anfitrión.

El monitor no conserva el texto del manuscrito ni las cadenas de reemplazo. En la apertura solo lee **text.length**; en cada edición utiliza longitudes y referencias de revisión/secuencia. Las métricas son contadores temporales por sesión en memoria y desaparecen al cerrar la sesión o disponer la instancia. Este módulo no envía telemetría a Internet.

## 2. Integración con HostEngineApi

~~~ts
import {
  HostEngineApi,
  LiveAuthorMonitor
} from "./motor-literario";

const authorMonitor = new LiveAuthorMonitor({ idleAfterMs: 10_000 });

const api = new HostEngineApi({
  store,
  callbacks: {
    onCommit(result) {
      authorMonitor.recordCommit(result);
    }
  }
});

api.initializeProject({ projectId, projectName, writerId });
await api.openDocument(snapshot);
authorMonitor.openDocument(snapshot, projectId);

// En el mismo manejador que envía el delta desde el editor:
const admission = api.onEditorChange(change);
authorMonitor.recordAdmission(change, admission);

// El panel consulta una instantánea sin detener ni esperar al motor:
const liveStatus = authorMonitor.getSnapshot(change.documentId);

// Tras una resincronización autoritativa del anfitrión:
await api.openDocument(authoritativeSnapshot);
authorMonitor.resynchronizeDocument(authoritativeSnapshot);

// Antes de cerrar la vista/documento:
await api.flushPendingChanges();
authorMonitor.closeDocument(documentId);
~~~

El callback **onCommit** puede ejecutarse en una microtarea posterior a **onEditorChange**; por eso el anfitrión registra primero la admisión devuelta y deja que el callback confirme después el ticket. Cada admisión debe registrarse una sola vez.

**subscribe(listener, documentId?)** permite que un panel reciba nuevas instantáneas cuando se abre un documento, se registra un delta o se resuelve un commit. Los errores de un suscriptor se aíslan para que no interrumpan la ruta de escritura.

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

Pruebas específicas en **typescript/tests/live-author-monitor.test.mjs**: apertura y edición; tiempo activo y pausas; rechazos; tickets y latencias p50/p95; commit fallido y resincronización; cierre bloqueado con pendientes; aislamiento entre documentos y suscriptores; validación de secuencia, límite de sesiones y reloj monotónico.

La suite aislada pasa 8/8 pruebas y TypeScript compila en modo estricto. La integración con una interfaz de autor real y la ejecución de la suite completa del repositorio deben validarse en el entorno anfitrión/CI; este avance no afirma que exista ya un panel visual conectado.

## 6. Próximo tramo

Conectar esta API al ciclo de vida real del editor anfitrión y presentar el estado en un panel de observabilidad, sin duplicar el texto ni bloquear el hilo de edición. Añadir pruebas de integración de extremo a extremo para apertura, escritura sostenida, saturación, recuperación y cierre.