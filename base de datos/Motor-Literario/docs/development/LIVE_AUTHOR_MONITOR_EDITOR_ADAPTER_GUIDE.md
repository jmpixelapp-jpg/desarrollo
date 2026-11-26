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

Los errores de un listener o de una callback de diagnóstico no deben romper el ciclo de edición. Una discrepancia de secuencia, revisión o estado del editor sí detiene la captura para evitar corromper el historial.

## 7. Resincronización y ciclo de vida

Para reanudar, el editor y HostEngineApi deben referirse al mismo snapshot durable: misma identidad de documento, texto, revisión y secuencia. integration.resynchronize() comprueba esta condición antes de descartar backlog y volver a suscribir el proveedor.

Desmontar la integración no cierra el documento ni dispone HostEngineApi. La aplicación decide por separado cuándo abrir, recuperar o cerrar un documento. Para un cierre seguro del monitor, usar el método durable del anfitrión antes de disponer recursos.

## 8. Estado de integración en el repositorio

Implementado:
- Contrato transaccional con edición, undo y redo.
- Validación y deduplicación de eventos.
- Backpressure FIFO, reentrada y recuperación desde snapshot común.
- Puente reusable con lectores de snapshot y metadatos nativos.
- Validación de metadatos por transacción sin volver a materializar el texto.
- Pruebas automatizadas del source, integración y puente.

Pendiente:
- Identificar y conectar el editor de producción que use la aplicación.
- Mapear su callback real de transacción/historial a LiveAuthorMonitorEditorTransaction.
- Validar undo/redo y transacciones agrupadas sobre ese editor concreto en navegador.

La fixture HTML de Chromium prueba almacenamiento y leases entre pestañas; no es el editor de producción. No debe usarse como evidencia de que este último ya está conectado.
