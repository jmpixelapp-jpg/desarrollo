# Puente entre procesos — Motor Literario v1

**Estado:** implementado y probado en CI  
**Protocolo:** JSON-RPC 2.0, una solicitud JSON por línea (JSONL)  
**Transporte:** stdin/stdout del proceso hijo; no abre puertos ni escucha en la red  
**Versión del puente:** 1.0.0  
**API del motor:** 0.1.0  
**Runtime del proceso compañero:** Node.js 22.13.0 o posterior  
**Almacenamiento del proceso:** SQLite local mediante node:sqlite

Esta es la conexión oficial para que la aplicación anfitriona y el Motor Literario funcionen como procesos separados. La aplicación anfitriona inicia el proceso compañero, intercambia mensajes JSON-RPC por sus pipes y recibe eventos de análisis y confirmación. El proceso compañero ejecuta HostEngineApi y conserva la base local SQLite.

No es el antiguo protocolo JSON-RPC del prototipo Rust. No utiliza sockets TCP, HTTP ni WebSocket.

## 1. Archivos que se distribuyen

Incluir juntos, manteniendo su estructura relativa:

- typescript/dist/motor-literario.js — bundle ESM del núcleo y del cliente TypeScript.
- typescript/bridge/stdio-server.mjs — proceso servidor.
- typescript/bridge/sqlite-project-store.mjs — adaptador SQLite local.
- El runtime Node.js 22.13.0 o posterior instalado en la máquina.

No se requiere instalar paquetes npm en tiempo de ejecución para el puente. SQLite se obtiene de la biblioteca integrada node:sqlite de Node.js. En Node.js 22.13 ya no se necesita la opción `--experimental-sqlite`, pero el módulo sigue clasificado como experimental (Stability 1.1, Active Development); conviene fijar la versión de Node utilizada y volver a ejecutar las pruebas antes de actualizarla. [Documentación oficial de Node.js 22.13](https://nodejs.org/download/release/v22.23.0/docs/api/sqlite.html).

Para preparar el runtime desde la carpeta typescript:

~~~sh
npm install
npm run build
~~~

El comando de desarrollo del proceso es:

~~~sh
node bridge/stdio-server.mjs --db "RUTA_ABSOLUTA/motor-literario.sqlite"
~~~

También puede configurarse la variable de entorno MOTOR_LITERARIO_DB y ejecutar node bridge/stdio-server.mjs sin argumento.

La ruta de la base se debe elegir dentro del directorio privado de datos de la aplicación anfitriona, no dentro de la carpeta temporal, de instalación ni del repositorio. El servidor crea el directorio padre si hace falta.

## 2. Ejemplo de arranque desde el programa anfitrión

Ejemplo para la parte Node/Electron del programa anfitrión. El proceso editor no importa ni ejecuta HostEngineApi directamente: inicia el servidor y usa el cliente del puente.

~~~ts
import { spawn } from "node:child_process";
import { join } from "node:path";
import { MotorLiterarioBridgeClient } from "./motor-literario/dist/motor-literario.js";

const bridgeScript = join(
  app.getAppPath(),
  "motor-literario",
  "bridge",
  "stdio-server.mjs"
);

const databasePath = join(
  app.getPath("userData"),
  "MotorLiterario",
  "motor-literario.sqlite"
);

const child = spawn(
  process.execPath,
  [bridgeScript, "--db", databasePath],
  {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  }
);

const motor = new MotorLiterarioBridgeClient(child, {
  requestTimeoutMs: 30_000,
  onStderr(text) {
    hostLogger.warn("Motor Literario: " + text);
  }
});

const hello = await motor.hello();
if (hello.bridgeProtocolVersion !== "1.0.0" ||
    hello.motorApiVersion !== "0.1.0") {
  throw new Error("Versión incompatible del Motor Literario.");
}

await motor.openProject({
  projectId: hostProject.id,
  projectName: hostProject.title,
  writerId: authenticatedUser.stableWriterId
});
~~~

Las identidades siguen perteneciendo al anfitrión. No generar projectId, projectName, documentId ni writerId en el proceso del motor. writerId debe ser el identificador estable de la sesión autenticada y nunca un campo editable por el usuario.

En una aplicación sin Electron se usa el mismo patrón con el mecanismo de creación de procesos del sistema anfitrión. El contrato del cliente recibe un objeto compatible con ChildProcess de Node.

## 3. Apertura, edición y confirmación

Primero abrir el documento con el snapshot autoritativo que tiene el editor:

~~~ts
await motor.openDocument(projectId, {
  documentId,
  text: editorText,
  revision: editorRevision,
  sequence: editorSequence
});
~~~

Para recuperar un documento existente después de reiniciar el proceso:

~~~ts
const recovered = await motor.recoverDocument(projectId, documentId);
~~~

El anfitrión debe decidir cómo incorporar el snapshot recuperado a su editor y a su propio mecanismo de guardado. No sustituir silenciosamente un texto que tenga cambios locales sin resolver.

Registrar las notificaciones antes de enviar cambios:

~~~ts
motor.onNotification("engine.analysis", message => {
  if (message.projectId !== activeProjectId) return;
  if (editor.getRevision(message.documentId) !== message.revision) return;
  editor.setDiagnostics(message.documentId, message.diagnostics);
});

motor.onNotification("engine.commit", message => {
  if (message.projectId !== activeProjectId) return;
  editor.handleDurableMotorCommit(message.result);
});

motor.onNotification("engine.knowledgeError", message => {
  hostLogger.error(message.error.message);
});
~~~

Enviar cada operación de edición como un reemplazo:

~~~ts
const admission = await motor.submitChange(projectId, {
  documentId,
  sequence,
  baseRevision,
  start,
  end,
  replacement
});

if (admission.status === "queued") {
  // Guardar ticketId: queued todavía no significa confirmación durable.
  pendingMotorTickets.set(admission.ticketId, change);
} else {
  // No descartar. Retener el delta y los posteriores y resolver el motivo.
  retainAndHandleRejectedChange(change, admission.reason);
}
~~~

start y end son offsets UTF-16, igual que los índices habituales de JavaScript. No enviar bytes UTF-8, puntos de código, columnas visuales ni índices de grafemas. Cada cambio aplicado aumenta revisión y secuencia en una unidad.

La admisión queued significa que el motor aceptó el cambio en su cola local; no significa que SQLite lo haya confirmado. La confirmación durable llega como notificación engine.commit con result.status = applied. Como alternativa, consultar el ticket:

~~~ts
const result = await motor.request("document.commit", {
  projectId,
  ticketId
});
~~~

El anfitrión debe conservar y reintentar en orden los deltas rechazados por queue_full. Los motivos posibles de admisión son queue_full, change_too_large, unknown_document, invalid_change y resync_required. No enviar una secuencia posterior dejando un hueco.

## 4. Métodos JSON-RPC disponibles

Todas las solicitudes usan JSON-RPC 2.0 y una línea JSON completa por mensaje. El ID se devuelve sin cambios. Las respuestas pueden llegar en distinto orden; el cliente las correlaciona por ID.

| Método | Parámetros | Resultado |
|---|---|---|
| bridge.hello | {} | Versiones, transporte, almacenamiento y límites |
| bridge.health | {} | Estado rápido de SQLite, proyectos abiertos y solicitudes en curso |
| project.open | projectId, projectName, writerId opcional | Abre la instancia del libro y devuelve capacidades |
| project.close | projectId | Vacía colas y cierra esa instancia del proyecto |
| document.open | projectId, snapshot | Abre con snapshot autoritativo |
| document.recover | projectId, documentId | Recupera snapshot y journal locales |
| document.change | projectId, change | Admisión síncrona: queued o rejected |
| document.commit | projectId, ticketId | Resultado terminal del ticket o null si sigue pendiente/no existe |
| document.snapshot | projectId, documentId | Snapshot actual del motor |
| document.syncState | projectId, documentId | Revisión, secuencia, pendingSequence y needsResync |
| document.diagnostics | projectId, documentId | Diagnósticos vigentes de la revisión actual |
| engine.flush | projectId | Espera cambios, diagnósticos y conocimiento pendientes |
| engine.metrics | projectId | Métricas de cola, latencia y análisis en vivo |
| engine.capabilities | projectId | Funciones disponibles en esta instancia |
| project.call | projectId, method, args | Invoca un método público autorizado de HostEngineApi |
| bridge.shutdown | {} | Vacía todos los proyectos y cierra el proceso |

project.call recibe argumentos posicionales en args, un arreglo JSON. Solo permite métodos públicos incluidos en la lista blanca del servidor; un nombre arbitrario no se ejecuta.

Entre las consultas y operaciones autorizadas están getNarrativeEntities, getNarrativeRelations, getNarrativeEvents, getNarrativeIdeas, getNarrativeAssertions, getNarrativeTimeline, getNarrativeContradictions, getNarrativeEntityHistory, getProjectRecords, getRecordNames, getProjectRelations, getProjectEvidences, getTimelineOccurrences, getProjectDictionaries, getDictionaryEntries, setNarrativeIdeaStatus, setNarrativeIdeaEntityLink, setNarrativeIdeaLink, archiveUnincorporatedIdeas y getPersonalIdeaLibrary. El código del servidor contiene la lista exacta vigente.

La consolidación transaccional de identidades narrativas no se ofrece en este adaptador SQLite y no está habilitada en la lista del puente. Las capacidades se consultan mediante engine.capabilities; el anfitrión no debe mostrar como disponibles funciones que el adaptador indique como false.

## 5. Notificaciones que envía el proceso compañero

Las notificaciones son mensajes JSON-RPC sin id y pueden intercalarse con respuestas normales:

- engine.analysis — resultado incremental, revisión, rango afectado y diagnósticos.
- engine.commit — resultado de persistencia del ticket; params contiene projectId y result.
- engine.knowledgeError — error de extracción o persistencia del conocimiento narrativo; params contiene projectId y mensaje de error.

El anfitrión debe ignorar diagnósticos de revisiones que ya no sean la revisión visible del documento. El motor no cambia el texto que contiene el editor y no aplica correcciones automáticamente.

## 6. Errores y límites de transporte

- -32700: JSON inválido.
- -32600: solicitud JSON-RPC inválida, ID duplicado o línea demasiado grande.
- -32601: método desconocido o fuera de la lista permitida.
- -32000: error del motor, del proyecto o del almacenamiento.

Una respuesta de admisión rejected no es un error JSON-RPC: es un resultado válido que exige la acción correspondiente del anfitrión.

El límite de solicitud y respuesta es 16 MiB por línea. El proceso escribe exclusivamente JSON-RPC y notificaciones en stdout. Los diagnósticos de arranque y errores de proceso van por stderr; no leer stdout como si fueran mensajes de texto o logs.

El proceso compañero se ejecuta como hijo local con pipes privados. No abre puertos ni acepta conexiones remotas. El anfitrión debe usar una ruta de script absoluta, no permitir que el usuario sustituya el ejecutable ni la ruta de base por valores no confiables.

## 7. Persistencia SQLite en el modo de procesos separados

El proceso compañero usa SQLite integrado de Node.js, con modo WAL, synchronous = FULL, foreign keys habilitadas y espera de bloqueo de 5 segundos. El archivo y sus archivos auxiliares WAL/SHM quedan en el directorio de datos local del escritor.

Este es un adaptador físico diferente de IndexedDbProjectStore:

- La base SQLite del puente tiene metadatos de esquema del adaptador versionados como 1.
- Los registros lógicos se guardan localmente en bridge_records y se indexan por colección, proyecto, escritor, documento y secuencia.
- La cabecera de secuencia/longitud del documento se mantiene en bridge_document_heads para validar el journal sin recorrerlo completo en cada pulsación.
- Se conservan los contratos y las estructuras lógicas MLDB 0.4.1; el archivo SQLite no es una base IndexedDB versión 21.
- El archivo SQLite del puente y la IndexedDB del navegador son almacenes separados. No se sincronizan automáticamente ni comparten sus archivos.

Si ya existen datos en una instalación que usó IndexedDB directamente, no cambiar a SQLite suponiendo que el nuevo proceso encontrará esos registros. Antes debe realizarse una exportación/migración explícita y verificada; este puente no contiene un importador automático de una base IndexedDB existente.

No abrir el mismo archivo SQLite desde dos instancias del servidor para el mismo proyecto como si fueran dos escritores independientes. Centralizar el proceso compañero por perfil de aplicación. No modificar bridge_records directamente desde el anfitrión.

La aplicación debe proteger el directorio mediante permisos del sistema operativo y mantener copias de seguridad. Para una copia simple y coherente, apagar el puente con bridge.shutdown y esperar a que el proceso termine antes de copiar el archivo SQLite. No copiar solo el archivo principal mientras SQLite está activo: puede haber transacciones aún en WAL. El puente no expone todavía una API integral de backup/restore.

## 8. Cierre ordenado y recuperación

Al cambiar de libro o cerrar una ventana, vaciar primero las colas del proyecto:

~~~ts
await motor.flushProject(projectId);
await motor.closeProject(projectId);
~~~

Al cerrar por completo el proceso compañero:

~~~ts
await motor.shutdown();
~~~

El servidor vacía todas las instancias antes de cerrar SQLite. Si el proceso se cae inesperadamente, la siguiente instancia debe abrir el mismo archivo y llamar document.recover con el ID del documento. Si el journal es discontinuo o falta su snapshot base, el motor rechaza la recuperación y exige un snapshot autoritativo del anfitrión; no borrar el archivo para superar el error.

## 9. Prueba de aceptación del puente

La suite tests/bridge.test.mjs inicia dos procesos reales del servidor en secuencia y comprueba:
- intercambio JSON-RPC y versión de protocolo;
- apertura de proyecto/documento;
- admisión y notificación de confirmación durable;
- snapshot correcto después de una edición;
- cierre ordenado;
- recuperación del mismo documento desde el archivo SQLite después de reiniciar el proceso;
- aislamiento de dos proyectos que usan el mismo documentId.

Ejecutar desde typescript:

~~~sh
npm test
~~~

La CI también ejecuta typecheck, build, validación de esquema, todas las pruebas y el benchmark de edición. La aceptación final de la integración requiere además conectarlo al editor y probar contrapresión, recuperación y copia de seguridad en la instalación real del programa anfitrión.
