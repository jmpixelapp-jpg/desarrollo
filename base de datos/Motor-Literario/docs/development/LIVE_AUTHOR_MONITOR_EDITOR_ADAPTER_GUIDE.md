# Guía de integración del proveedor transaccional del editor

Estado: contrato implementado; conexión al editor anfitrión concreto pendiente.

## 1. Responsabilidad de cada capa

- El editor anfitrión es la autoridad del texto, su historial y el orden de las transacciones aplicadas.
- LiveAuthorMonitorEditorTransactionBridge publica eventos ya aplicados y delega las lecturas de snapshot/metadatos al editor. No conserva el manuscrito.
- LiveAuthorMonitorEditorTransactionSource valida IDs, documento, secuencia, revisión base, rango UTF-16 y estado posterior a cada transacción. Ante discrepancias, suspende la captura.
- mountLiveAuthorMonitorEditorTransactions conecta los deltas aceptados con HostEngineApi y su cola FIFO/backpressure.
- HostEngineApi mantiene el motor, la persistencia y el ciclo de vida del documento.

El puente es independiente de bibliotecas como ProseMirror, CodeMirror, Monaco, Lexical o Tiptap. No declara que alguna esté instalada en el repositorio ni instala una dependencia de editor.

## 2. Adaptador mínimo requerido

El anfitrión proporciona dos lectores:

1. getSnapshot(documentId): snapshot completo con documentId, text, revision y sequence. Se consulta al montar y al resincronizar.
2. getDocumentState(documentId): metadatos ligeros con documentId, revision, sequence y documentLength. La longitud es string.length, es decir, unidades UTF-16.

El segundo lector debe ser O(1) o equivalente y no copiar ni serializar el manuscrito. Se consulta después de cada evento para comprobar que el editor ya aplicó la transacción anunciada. Proveedores antiguos pueden omitirlo y el source conserva el fallback a getSnapshot; los adaptadores de producción deben implementarlo.

## 3. Flujo de montaje

Ejemplo agnóstico a una biblioteca de edición. nativeEditor representa la API real que debe suministrar la aplicación:

\`\`\`ts
import {
  LiveAuthorMonitorEditorTransactionBridge,
  mountLiveAuthorMonitorEditorTransactions
} from "./motor-literario";

const bridge = new LiveAuthorMonitorEditorTransactionBridge({
  getSnapshot: documentId => nativeEditor.getSnapshot(documentId),
  getDocumentState: documentId => nativeEditor.getDocumentState(documentId),
  onListenerError: (error, documentId) => {
    reportEditorIntegrationError(error, documentId);
  }
});

const monitor = mountLiveAuthorMonitorEditorTransactions({
  documentId,
  editor: bridge,
  hostApi,
  onAdmission: (change, admission) => {
    updateMonitorAdmissionState(change, admission);
  },
  onBackpressure: state => {
    updateEditorBackpressureState(state);
  },
  onError: error => {
    reportEditorIntegrationError(error, documentId);
  }
});

// Conectar el callback nativo después de que el puente esté montado.
const stopNativeEvents = nativeEditor.subscribeAppliedTextTransactions(
  documentId,
  event => {
    bridge.publishAppliedTransaction(documentId, {
      transactionId: event.transactionId,
      kind: event.historyKind, // "edit", "undo" o "redo"
      change: {
        documentId,
        sequence: event.sequence,
        baseRevision: event.baseRevision,
        start: event.start,
        end: event.end,
        replacement: event.replacement
      }
    });
  }
);

// Al desmontar el editor/panel:
stopNativeEvents();
monitor.dispose();
bridge.dispose();
\`\`\`

Los nombres getSnapshot, getDocumentState y subscribeAppliedTextTransactions del objeto de ejemplo representan el contrato que debe adaptar el anfitrión; no son APIs que el repositorio afirme que existen actualmente.

## 4. Reglas de publicación

- Publicar solo después de que la transacción haya sido aplicada al estado nativo. Si la suscripción emite antes de actualizar el snapshot, el source detecta la discrepancia y suspende el stream.
- transactionId identifica establemente una transacción concreta. La retransmisión conserva el mismo ID.
- sequence aumenta exactamente una vez por cada cambio de texto aceptado; baseRevision coincide con la revisión inmediatamente anterior.
- getDocumentState debe reflejar la revisión, secuencia y longitud posteriores al delta recién publicado.
- start y end son offsets en el texto anterior a la transacción, medidos en unidades UTF-16. replacement contiene exactamente el texto insertado.
- kind distingue el evento de historial real. Undo publica el delta inverso efectivamente aplicado; redo publica el delta efectivamente reejecutado. No inferirlo de teclas, botones ni comparación de snapshots.
- No publicar cambios de selección, foco, scroll o formato que no puedan representarse como modificación textual. La política de revisión del anfitrión debe contar solo transacciones cubiertas por este contrato.

## 5. Transacciones con varios cambios internos

EditorChange representa un reemplazo contiguo por evento. Algunos editores agrupan varios pasos en una transacción. El adaptador debe producir un delta equivalente exacto del estado textual resultante:

- Si los pasos pueden expresarse como un único rango, combinar desde el primer offset afectado hasta el último y entregar el segmento final exacto, incluidos los caracteres que permanezcan intactos dentro del intervalo.
- Si el editor expone una lista de cambios ordenados, normalizarlos a un único reemplazo equivalente solo cuando respete offsets del texto anterior y el fragmento final exacto.
- Si no puede construir un reemplazo exacto, no publicar un delta parcial. Suspender y solicitar resincronización desde un snapshot común y durable.

No enviar varios EditorChange con una misma revisión base: el motor exige secuencia y revisiones consecutivas. Tampoco emitir una transacción de texto ficticia para operaciones que no modifican texto.

## 6. Reentrada, errores y contrapresión

Las publicaciones del puente son síncronas y FIFO. Si un listener provoca una publicación reentrante, la nueva transacción queda en cola para que todos los listeners vean primero la transacción exterior. El retorno de publishAppliedTransaction cuenta los listeners seleccionados al encolar; no garantiza que todos hayan terminado sin error.

El source acota la cola de transacciones reentrantes. Si supera su límite, pausa de forma explícita y requiere resincronización; nunca descarta cambios silenciosamente. La integración conserva el backlog FIFO cuando HostEngineApi aplica contrapresión.

El enlace también limita su propio buffer con `maxPendingChanges` (predeterminado: 4096; rango permitido: 1–65536). Si llega un nuevo delta cuando el buffer ya está completo, no lo añade ni continúa consumiendo eventos: solicita `requireResynchronization()` a la fuente cuando está disponible, cancela la suscripción y publica el estado `resync-required` con la secuencia que provocó el desbordamiento. El backlog conservado queda inspeccionable, pero `retryPending()` no lo reenvía.

Para reanudar, el anfitrión debe obtener y aplicar el mismo snapshot durable en editor y motor. Solo después llama a `discardPendingAfterResynchronization()`: el método limpia los deltas obsoletos y vuelve a suscribir la fuente. No usar ese método como atajo para liberar un `queue_full` temporal.

Los errores de un listener o de una callback de diagnóstico no deben romper el ciclo de edición. Una discrepancia de secuencia, revisión o estado del editor sí detiene la captura para evitar corromper el historial.

## 7. Resincronización y ciclo de vida

Para reanudar, el editor y HostEngineApi deben referirse al mismo snapshot durable: misma identidad de documento, texto, revisión y secuencia. integration.resynchronize() comprueba esta condición antes de descartar backlog y volver a suscribir el proveedor.

Desmontar la integración no cierra el documento ni dispone HostEngineApi. La aplicación decide por separado cuándo abrir, recuperar o cerrar un documento. Para un cierre seguro del monitor, usar el método durable del anfitrión antes de disponer recursos.

## 8. Estado de integración en el repositorio

Implementado:
- Contrato transaccional con edición, undo y redo.
- Validación y deduplicación de eventos.
- Backpressure FIFO, reentrada y recuperación desde snapshot común.
- Buffer externo acotado con pausa obligatoria al desbordarse y re-suscripción posterior a snapshot común.
- Puente reusable con lectores de snapshot y metadatos nativos.
- Validación de metadatos por transacción sin volver a materializar el texto.
- Pruebas automatizadas del source, integración y puente.

Pendiente:
- Identificar y conectar el editor de producción que use la aplicación.
- Mapear su callback real de transacción/historial a LiveAuthorMonitorEditorTransaction.
- Validar undo/redo y transacciones agrupadas sobre ese editor concreto en navegador.

La fixture HTML de Chromium prueba almacenamiento y leases entre pestañas; no es el editor de producción. No debe usarse como evidencia de que este último ya está conectado.


## 9. Configuración del límite de contrapresión en el montaje

Tanto `mountLiveAuthorMonitorEditorTransactions()` como `mountLiveAuthorMonitorTextArea()` aceptan `maxPendingChanges`. El valor se entrega al enlace FIFO común; si se omite se mantiene 4096. La misma política de pausa y reanudación por snapshot durable se aplica a ambos adaptadores.

Las pruebas de integración recorren ahora el ciclo completo: primera admisión rechazada por `queue_full`, acumulación acotada del siguiente delta, desbordamiento, desuscripción del proveedor, reconciliación con un snapshot que ya incluye el texto y entrega correcta de una nueva edición después de reanudar.


La opción `maxPendingChanges` se valida al inicio de cada función de montaje, antes de inicializar una sesión o listeners. Valores que no sean enteros seguros entre 1 y 65536 se rechazan con `RangeError`; no se permite que una configuración inválida abra parcialmente recursos del monitor.


## 10. Aplicación ejecutable de referencia

El repositorio incorpora `typescript/examples/live-author-monitor/index.html`. La página demuestra el montaje completo sobre un textarea nativo: crea el `HostEngineApi`, abre o recupera el documento desde `IndexedDbProjectStore`, conecta `mountLiveAuthorMonitorTextArea` y renderiza `mountLiveAuthorMonitorPanel`. El botón de cierre ejecuta el cierre durable y la liberación de lease.

Para ejecutarla, consulta `typescript/examples/live-author-monitor/README.md`. El test `tests/live-author-monitor-writing-browser.test.mjs` escribe mediante Chromium, valida los contadores, cierra, recarga y confirma la recuperación del documento y sus métricas.

Esta referencia proporciona una integración de navegador reproducible. No sustituye el callback transaccional específico de un editor enriquecido ausente del repositorio; ese anfitrión debe seguir las reglas de esta guía para preservar el historial real.


**Nota de operación:** el workflow específico incluye la ruta `examples/live-author-monitor/**` en los filtros de push y pull request. Así cualquier modificación de la página de referencia vuelve a ejecutar la suite Chromium del monitor.


## 11. Resultado de validación de la aplicación de referencia

El workflow específico del monitor [45734476285](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45734476285), ejecutado sobre el commit `ce2413194e1f02ce21fcc232c3f43a1ee036452a`, aprobó build, esquema MLDB 0.4.2, auditoría física de 25 tablas y 34 almacenes IndexedDB y **139/139 pruebas (0 fallidas, 0 omitidas)**. La prueba Chromium escribió texto real, confirmó métricas y durabilidad, cerró mediante `disposeSafely()`, recargó la página, restauró texto/checkpoint y volvió a editar.

El chequeo de tipos de la suite general también pasó. Esa suite completa todavía presenta dos fallos en módulos fuera del monitor: reconciliación de ideas entre anfitriones y validación de catálogo del análisis literario. No se atribuyen al adaptador de escritura.


**Rendimiento general verificado:** el benchmark del workflow general [45734599092](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45734599092) ejecutó 40 ediciones sobre manuscritos de 10k, 100k y 500k palabras, además de línea única y cuatro documentos concurrentes. En el caso de 500k palabras midió commit p95 de 3,54 ms y extremo a extremo p95 de 4,04 ms en el runner CI. Son referencias de esa máquina, no garantías universales.


## 12. Integración multi-documento del workspace

La aplicación de referencia ahora conecta `mountLiveAuthorMonitorEditorIntegration()` con una selección de documento implementada por el anfitrión. El contrato es simple: `getActiveDocumentId()`, `subscribeActiveDocument(listener)` y `activateDocument(documentId)`.

El anfitrión mantiene la responsabilidad sobre apertura, recuperación y cambio del editor. Antes de cambiar el textarea activo, confirma los deltas pendientes y desmonta solo el adaptador anterior; las sesiones de métricas de los otros capítulos permanecen vivas. La integración de paneles muestra el resumen global y cambia el panel detallado con el documento seleccionado.

La prueba de navegador de referencia valida dos documentos persistidos en IndexedDB, métricas separadas y recuperación en ambos. El patrón puede reutilizarse con un editor enriquecido, siempre que su anfitrión conecte el callback real de transacciones para cada documento.


## 13. Consistencia de la secuencia admitida durante escrituras asíncronas

El motor puede recibir nuevas pulsaciones mientras el almacenamiento confirma el delta anterior. Al reemplazar el estado del documento tras cada commit, debe conservar el `pendingSequence` más reciente de la instancia viva, no el valor capturado antes de `appendChange()`. Una regresión bloquea la primera escritura del journal, admite 40 deltas y verifica que la secuencia pendiente permanezca monótona y que todos los commits se apliquen.

Esta regla es esencial cuando el editor cambia de capítulo: el anfitrión debe poder comprobar que `pendingSequence === sequence` después de vaciar la cola sin que un commit atrasado reescriba un contador antiguo.


## 14. Restauración de sesiones de duración inferior al umbral de inactividad

Al recuperar un checkpoint, sumar el downtime a `idleDurationMs` ya garantiza que el tiempo fuera del proceso nunca se contabilice como tiempo escribiendo. No se debe forzar `lastActivityAgeMs` a `idleAfterMs + 1`: para sesiones recién abiertas puede superar la duración total y volver inválido el siguiente checkpoint. Se conserva `edadAnterior + downtime`, sin inventar actividad anterior al inicio de la sesión.


## 15. Validación final del motor y workspace multi-documento

En el commit `d728593bd4f9758e85a4b16ce5ab1480d330f4bc`, la CI específica [45736377764](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45736377764) aprobó **141/141 pruebas**, con Chromium real, MLDB 0.4.2 y auditoría IndexedDB (25 tablas / 34 almacenes). Se cubren el cambio entre dos capítulos, sus checkpoints independientes, recuperación inmediata y recuperación posterior al cierre.

La suite general [45736377738](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45736377738) también quedó verde: Type-check, build, **718/718 pruebas** y benchmark completos. Las mediciones de CI no sustituyen el benchmark en el equipo final del autor.

## 9. Clasificación de operaciones para estadísticas

`EditorChange.activityKind` es metadato opcional para enriquecer las métricas; el motor sigue validando y aplicando el delta textual autoritativo.

- `typing`: escritura normal; también se infiere para inserciones simples.
- `paste`: pegado desde portapapeles; textarea lo reconoce por `InputEvent.inputType` y el editor nativo puede asignarlo.
- `deletion`: borrado sin texto de reemplazo; también se infiere por el delta.
- `correction`: reemplazo de un rango por texto; también se infiere cuando el delta elimina e inserta contenido.
- `undo` / `redo`: únicamente desde la transacción real del historial del editor, nunca desde atajos de teclado.
- `other`: operación textual no clasificable.

Los seis contadores se conservan en checkpoints versión 1 como campos opcionales compatibles con checkpoints anteriores. Los checkpoints antiguos restauran los nuevos contadores a cero; los nuevos validan que la suma de categorías coincida con las ediciones admitidas. Las métricas no guardan texto del manuscrito.
