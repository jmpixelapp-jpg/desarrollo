# Guía de integración del Motor Literario con la aplicación anfitriona

**Estado:** contrato vigente para integración TypeScript/JavaScript  
**Versión de API:** `0.1.0` (`MOTOR_LITERARIO_API_VERSION`)  
**Esquema lógico:** MLDB `0.4.2`  
**Persistencia incluida:** IndexedDB `motor-literario-local`, versión `22`  
**Punto de entrada público:** `typescript/src/index.ts`

Esta guía describe cómo conectar el Motor Literario con el programa que crea los libros, administra usuarios y contiene el editor. La aplicación anfitriona conserva la propiedad de los proyectos, documentos y texto original. El motor recibe su identidad y los cambios del editor; devuelve confirmaciones, diagnósticos y conocimiento estructurado. Nunca reescribe el texto del anfitrión por iniciativa propia.

## 1. Arquitectura y modalidad soportada

La línea vigente del producto es TypeScript/JavaScript. El contrato de integración es la clase `HostEngineApi`, usando el adaptador `IndexedDbProjectStore` para persistencia local.

Hay dos modalidades soportadas. Cuando el motor se ejecuta dentro del mismo runtime JavaScript que el editor, el anfitrión importa `HostEngineApi` y usa el adaptador `IndexedDbProjectStore`. Cuando la aplicación anfitriona y el motor deben ejecutarse como procesos separados, se usa el **puente de procesos JSON-RPC v1**, que ya está implementado: [Contrato del puente entre procesos](BRIDGE_PROCESS_PROTOCOL_V1.md). El anfitrión inicia el proceso compañero y se comunica con él por stdin/stdout mediante `MotorLiterarioBridgeClient`. En ambas modalidades, el anfitrión debe transmitir cada cambio del editor; el motor no observa la interfaz por sí solo.

**No usar como contrato vigente el documento JSON-RPC histórico.** `specifications/HOST_JSONRPC_PROTOCOL_V0.1.md` describe un prototipo anterior en Rust, con almacenamiento y offsets distintos. No es el transporte TypeScript actual.

### Distribución del módulo

El punto de entrada público es `typescript/src/index.ts`. Expone `HostEngineApi`, `IndexedDbProjectStore`, `MotorLiterarioBridgeClient`, `MOTOR_LITERARIO_API_VERSION` y los contratos tipados. Para procesos separados, distribuir además `typescript/bridge/stdio-server.mjs`, `typescript/bridge/sqlite-project-store.mjs` y el bundle `typescript/dist/motor-literario.js`.

El paquete TypeScript del repositorio sigue marcado como privado (`private: true`) y no declara todavía metadatos de publicación, `exports` ni un paquete npm distribuible. Para integración dentro del mismo runtime, se puede incluir `typescript/src/` en la compilación del anfitrión y apuntar a `src/index.ts`. Para integración entre procesos, el anfitrión importa `MotorLiterarioBridgeClient` desde el bundle ESM `typescript/dist/motor-literario.js` y ejecuta el servidor compañero incluido en `typescript/bridge/`. No instalar `motor-literario-core` desde npm: no es un paquete publicado.

## 2. Responsabilidades de cada programa

| Responsabilidad | Aplicación anfitriona | Motor Literario |
|---|---|---|
| Crear, nombrar y eliminar un proyecto | Responsable | Recibe `projectId` y `projectName`; no crea la identidad |
| Autenticar al escritor | Responsable | Recibe el `writerId` estable cuando se integra |
| Crear y nombrar documentos | Responsable | Recibe el `documentId` |
| Contener y mostrar el manuscrito | Autoridad del texto | Mantiene una sesión y una copia local recuperable |
| Detectar cada edición | Envía el delta del editor | Lo admite, valida, persiste y analiza |
| Aplicar cambios al manuscrito | Responsable | No escribe sobre el editor ni cambia el texto original |
| Mostrar diagnósticos | Responsable | Devuelve diagnósticos asociados a una revisión concreta |
| Conservar conocimiento narrativo | Puede consultarlo y presentarlo | Extrae y persiste registros aislados por proyecto |
| Respaldo local SQLite e IndexedDB | Motor + anfitrión | APIs de almacenamiento implementadas; escritura/lectura de archivo y aceptación real corresponden al anfitrión |

El anfitrión debe usar la misma identidad externa de proyecto en todas las llamadas de un libro. No debe crear un proyecto paralelo en la base del motor.

## 3. Inicialización

Crear una instancia de `HostEngineApi` por proyecto/libro activo. La identidad de una instancia es inmutable: para abrir otro libro, incluso del mismo escritor, se crea otra instancia. No se debe reutilizar una instancia cambiando su `projectId`.

Ejemplo de integración (los objetos `hostProject`, `authenticatedUser` y `hostEditor` representan servicios propios de la aplicación anfitriona):

```ts
import {
  HostEngineApi,
  IndexedDbProjectStore,
  MOTOR_LITERARIO_API_VERSION
} from "./ruta-local/Motor-Literario/typescript/src/index";

const motor = new HostEngineApi({
  store: new IndexedDbProjectStore(),
  // Opcionales; estos son también los valores predeterminados.
  queueCapacity: 256,
  maxConcurrentDocuments: 2,
  maxQueuedTextUnits: 4_194_304,
  callbacks: {
    onAnalysis(result) {
      // Mostrar solo si el editor todavía está en esa revisión.
      if (hostEditor.getRevision(result.documentId) === result.revision) {
        hostEditor.setDiagnostics(result.documentId, result.diagnostics);
      }
    },
    onCommit(result) {
      hostEditor.handleMotorCommit(result);
    },
    onKnowledgeError(error) {
      hostEditor.reportBackgroundEngineError(error);
    }
  }
});

if (MOTOR_LITERARIO_API_VERSION !== "0.1.0") {
  throw new Error("Versión de API del Motor Literario no reconocida.");
}

motor.initializeProject({
  projectId: hostProject.id,
  projectName: hostProject.title,
  writerId: authenticatedUser.stableWriterId
});
```

Reglas de identidad:

- `projectId`: ID estable que ya asigna el programa anfitrión al libro.
- `projectName`: título vigente suministrado por el anfitrión; se conserva como procedencia cuando se archivan ideas.
- `writerId`: ID estable del escritor autenticado, no el nombre visible ni un valor enviado libremente desde la interfaz. Es opcional para las funciones generales, pero obligatorio para usar la biblioteca personal de ideas y la finalización de un libro.
- `documentId`: ID estable que asigna el anfitrión a cada documento o capítulo.

No se deben derivar estas identidades del título, nombre de usuario, ruta del archivo ni texto del manuscrito.

### Entorno de persistencia

`IndexedDbProjectStore` requiere que exista IndexedDB en el runtime. La base se abre de forma diferida y aplica las migraciones al abrirla. En el navegador, IndexedDB pertenece al origen y al perfil local donde corre la aplicación; no es una base compartida entre dominios, perfiles o dispositivos. El anfitrión no debe modificar directamente los almacenes internos ni duplicar sus migraciones.

Para procesos separados no se usa IndexedDB: el proceso compañero utiliza el adaptador SQLite local incorporado, basado en `node:sqlite`, sin dependencias npm adicionales en runtime. El archivo SQLite y el almacén IndexedDB de una ejecución dentro del navegador son bases físicas diferentes y no se sincronizan automáticamente. El contrato, la identidad y las estructuras lógicas MLDB se mantienen; la guía del puente documenta su esquema físico, versión y procedimiento de inicio. No se debe conectar una base remota o un servicio externo sin una decisión de arquitectura y privacidad expresa.

## 4. Apertura y recuperación de documentos

El anfitrión mantiene el snapshot autoritativo del editor: texto completo, revisión y secuencia. En una apertura normal, envía ese snapshot:

```ts
await motor.openDocument({
  documentId: hostDocument.id,
  text: hostDocument.text,
  revision: hostDocument.revision,
  sequence: hostDocument.sequence
});
```

El motor lee el snapshot durable y el journal desde una vista transaccional consistente. Si el snapshot coincide con la base guardada, reproduce los deltas durables posteriores en orden. Si el anfitrión entrega una copia más reciente válida, esa copia puede convertirse en la nueva base. El motor rechaza snapshots regresivos, contadores desalineados o cambios de texto que reutilicen la misma revisión y secuencia.

Cuando el programa anfitrión no dispone de su snapshot pero quiere recuperar la última sesión local, puede usar:

```ts
await motor.recoverDocument(hostDocumentId);
const recovered = motor.getSnapshot(hostDocumentId);
if (recovered) {
  // El anfitrión decide cómo incorporar esta recuperación a su editor
  // y a su propio mecanismo de guardado.
  hostEditor.restoreDocument(recovered);
}
```

`recoverDocument()` necesita que exista un snapshot durable base. Si solo hay deltas sin snapshot base, o el journal está corrupto/discontinuo, la recuperación falla de forma conservadora y conserva los datos en conflicto. En ese caso el anfitrión debe resolver la situación y reenviar un snapshot autoritativo válido mediante `openDocument()`; no debe borrar la base ni reiniciar revisión/secuencia a cero para forzar la apertura.

Al abrir o recuperar un documento, el motor restaura los diagnósticos de la revisión y programa la extracción narrativa inicial en segundo plano. `flushPendingChanges()` permite esperar también a ese trabajo pendiente.

## 5. Contrato obligatorio de edición en vivo

La prioridad de integración es el flujo de cambios del editor. Cada operación enviada representa un solo reemplazo de rango:

```ts
interface EditorChange {
  documentId: string;
  sequence: number;
  baseRevision: number;
  start: number;
  end: number;
  replacement: string;
}
```

**Los offsets `start` y `end` son unidades UTF-16**, como los índices de JavaScript y muchos editores web. No son bytes UTF-8, puntos de código Unicode, columnas visuales ni índices de grafemas. No convertirlos a bytes antes de llamar al motor.

Cada cambio confirmado incrementa `revision` y `sequence` en uno. Para construir la siguiente operación, usar el estado de sincronización que entrega el propio motor:

```ts
function sendReplacement(
  documentId: string,
  start: number,
  end: number,
  replacement: string
) {
  const sync = motor.getDocumentSyncState(documentId);

  if (sync.needsResync) {
    hostEditor.pauseMotorSubmission(documentId);
    hostEditor.requestAuthoritativeResync(documentId);
    return;
  }

  const change = {
    documentId,
    sequence: sync.pendingSequence + 1,
    baseRevision: sync.revision + (sync.pendingSequence - sync.sequence),
    start,
    end,
    replacement
  };

  const admission = motor.onEditorChange(change);

  if (admission.status === "queued") {
    hostEditor.markMotorChangeQueued(documentId, admission.ticketId);
    return;
  }

  // No descartar el delta rechazado. Mantenerlo junto con los posteriores
  // y reintentarlo en orden cuando el motivo permita continuar.
  hostEditor.retainMotorChange(documentId, change, admission.reason);
}
```

Los rangos de una operación deben corresponder al texto que resulta de las operaciones anteriores ya aceptadas para ese documento. El cálculo anterior obtiene la próxima secuencia y revisión base de la cola local del motor, incluso cuando hay cambios anteriores pendientes.

### Admisión y contrapresión

`onEditorChange()` es síncrono y no espera a IndexedDB. Devuelve una de estas respuestas:

| Respuesta | Significado | Acción del anfitrión |
|---|---|---|
| `{ status: "queued", ticketId }` | Aceptado en la cola; todavía no significa que la persistencia haya terminado | Conservar la relación ticket/cambio y esperar `onCommit` |
| `queue_full` | Cola o presupuesto agregado temporalmente ocupado | Retener el cambio y reintentar el mismo cambio antes de enviar los posteriores |
| `change_too_large` | El reemplazo supera el presupuesto individual | Retenerlo y manejarlo de forma explícita; no descartarlo |
| `unknown_document` | El documento no está abierto en esta instancia | Abrir/recuperar el documento y luego volver a sincronizar |
| `invalid_change` | Campos, rangos, secuencia o revisión no válidos | Corregir el contrato o reconstruir el delta; no reintentar sin cambios |
| `resync_required` | El documento necesita una base autoritativa nueva | Detener el envío de deltas y ejecutar el procedimiento de resincronización |

Cuando una edición recibe `queue_full`, el motor no la incorpora ni avanza `pendingSequence`. El anfitrión debe conservarla y reintentarla antes de cualquier operación posterior del mismo documento. Puede aplicar contrapresión temporal al editor o mantener una cola propia ordenada. Nunca debe descartar silenciosamente una edición ni enviar una secuencia posterior dejando un hueco.

Valores predeterminados de admisión: `queueCapacity = 256`, `maxConcurrentDocuments = 2` (configurable de 1 a 8) y `maxQueuedTextUnits = 4.194.304` unidades UTF-16 de texto de reemplazo pendiente. Los cambios de un mismo documento se aplican FIFO; documentos distintos pueden avanzar en paralelo hasta el límite configurado.

### Confirmación durable

La aceptación `queued` no es confirmación de guardado. La persistencia del delta ocurre antes de que el motor informe `status: "applied"` en `onCommit`.

```ts
callbacks: {
  onCommit(result) {
    if (result.status === "applied") {
      hostEditor.markMotorCommitDurable(result.ticketId, result.revision);
    } else {
      hostEditor.handleMotorCommitFailure(result.ticketId, result.reason);
    }
  }
}
```

También existe `pollCommit(ticketId)`, que devuelve `CommitResult` si el ticket ya terminó o `undefined` si no hay resultado disponible. Usar `onCommit` como mecanismo principal: el motor conserva un historial de tickets acotado a los 4.096 resultados más recientes, no como historial permanente.

### Diagnósticos

`onAnalysis(result)` entrega el fragmento de líneas afectadas, la revisión y diagnósticos con offsets absolutos UTF-16. El anfitrión debe comprobar que la revisión siga siendo la visible antes de pintar subrayados o marcas. Para consultar el estado consolidado de la sesión se usa:

```ts
const diagnostics = motor.getDocumentDiagnostics(documentId);
```

Este método solo devuelve los diagnósticos de la revisión actualmente abierta; si aún no hay un conjunto vigente, devuelve una lista vacía. El motor no acepta que el anfitrión aplique automáticamente los reemplazos sugeridos: la decisión editorial pertenece al escritor.

## 6. Resincronización, cierre y suspensión

Si `getDocumentSyncState(documentId).needsResync` es `true`:

1. Detener el envío de cambios para ese documento.
2. Conservar los deltas del anfitrión que todavía no fueron confirmados y resolverlos contra el texto actual del editor.
3. Esperar a que terminen las operaciones en curso con `await motor.flushPendingChanges()`.
4. Obtener del editor anfitrión un snapshot completo, autoritativo y con revisión/secuencia coherentes y no regresivas.
5. Reabrir esa sesión con `await motor.openDocument(snapshot)`.
6. Reanudar el envío solo cuando la apertura termine correctamente.

No llamar `openDocument()` mientras el documento todavía tenga cambios en cola o en aplicación. No limpiar a mano el journal para evitar el error. Si la apertura sigue fallando, conservar la base y el journal y presentar el conflicto para resolución; no sacrificar ediciones confirmadas.

Antes de suspender o cerrar la aplicación, cambiar de libro o terminar una sesión de edición:

```ts
await motor.flushPendingChanges();
```

Esta barrera espera la cola de cambios, el análisis en vivo, la persistencia de diagnósticos, la recuperación de diagnósticos y las operaciones de conocimiento narrativo en cola. El motor ya escribe deltas de forma durable y crea snapshots periódicos; el anfitrión no necesita reconstruir el manuscrito completo en cada pulsación.

## 7. Consultas de conocimiento y módulos disponibles

La API expone consultas y operaciones tipadas para que el anfitrión construya su propia interfaz. Las listas que siguen son métodos públicos de `HostEngineApi`; los detalles exactos de cada objeto se definen en los tipos TypeScript enlazados al final de esta sección.

Cuando el motor se ejecuta como proceso separado, `MotorLiterarioBridgeClient` ofrece una API tipada para el conocimiento narrativo y la biblioteca: extracción (`extractNarrativeKnowledge`), consulta de fichas, relaciones, acontecimientos, afirmaciones, cronología y contradicciones, alias y consolidación de identidades, historiales y análisis del documento (`analyzeLiteraryDocument`); además de consulta y enlace de ideas, cambio de estado, finalización y lectura paginada de biblioteca (`getPersonalIdeaLibraryPage`). Los métodos llevan el `projectId` como primer argumento; el escritor se deriva de la identidad autenticada que el puente abrió para ese proyecto y no se envía libremente desde la interfaz. El detalle de los métodos y sus tipos está en `typescript/src/bridge-client.ts`.

Ejemplo de flujo recomendado para una biblioteca grande:

~~~ts
const ideas = await bridge.getNarrativeIdeas(projectId);
const updated = await bridge.setNarrativeIdeaLink(
  projectId, ideaSourceId, ideaTargetId, true
);
const summary = await bridge.finalizeProjectToIdeaLibrary(projectId);
let page = await bridge.getPersonalIdeaLibraryPage(projectId, null, 100);
// Continuar leyendo con page.nextCursor hasta que sea null.
~~~

`archiveUnincorporatedIdeas(projectId)` y `getPersonalIdeaLibrary(projectId)` se conservan para compatibilidad y devuelven colecciones completas en memoria. Para bibliotecas extensas, usar la finalización resumida y la lectura por páginas.

### Conocimiento narrativo

- `getNarrativeEntities()`, `getNarrativeRelations()`, `getNarrativeEvents()`, `getNarrativeIdeas()` y `getNarrativeAssertions()`.
- `getNarrativeTimeline()` y `getNarrativeContradictions()`: la cronología y las contradicciones son vistas/candidatos conservadores, no una resolución semántica completa.
- `getNarrativeEntityHistory(entityId)`, `resolveNarrativeEntityId(entityId)` y `getNarrativeEntityIdentityCandidates()`.
- `setNarrativeIdeaStatus(ideaId, status)`, `setNarrativeIdeaEntityLink(...)` y `setNarrativeIdeaLink(...)`.

Cada idea admite hasta 500 vínculos explícitos a fichas y hasta 500 vínculos a otras ideas. El anfitrión y los adaptadores IndexedDB/SQLite usan `MAX_NARRATIVE_IDEA_REFERENCES` y rechazan por separado cualquier categoría que supere ese límite.

La extracción narrativa inicial se programa al abrir/recuperar el documento y continúa de manera incremental con las ediciones. Su alcance es deliberadamente conservador: usa indicadores textuales explícitos; los acontecimientos requieren `ACONTECIMIENTO:` o `EVENTO:`, y las ideas requieren `IDEA:`. No atribuir al motor inferencias semánticas que todavía no realiza.

### Biblioteca privada de ideas

- `finalizeProjectToIdeaLibrary()`: ruta recomendada para finalizar un libro. Transfiere solo las ideas cuyo estado vigente siga siendo `IDEA` y devuelve un resumen compacto con recibo durable, sin devolver ni acumular los textos transferidos.
- `getPersonalIdeaLibraryPage(cursor, limit)`: leer el contenido por páginas con cursor estable; el límite permitido es de 1 a 200 entradas.
- `getProjectFinalizationReceipt()`: volver a comprobar el recibo y el checksum del contenido archivado antes de dar por verificada la transferencia.
- `archiveUnincorporatedIdeas()` y `getPersonalIdeaLibrary()`: rutas de compatibilidad que devuelven colecciones completas en memoria; no se recomiendan para libros o bibliotecas grandes.

La biblioteca requiere que `writerId` se haya proporcionado al inicializar. La transferencia guarda procedencia, historial y contexto relacionado en una transacción local. Las ideas incorporadas o descartadas permanecen en el conocimiento del libro. La aplicación debe llamar a la finalización solo cuando el escritor haya decidido terminar esa obra, no en cada cierre de ventana. El recibo conserva un checksum de los IDs y un checksum incremental FNV-1a de las entradas completas; este último detecta alteraciones accidentales, pero no es una firma ni sustituye el cifrado o el control de acceso.

### Datos MLDB y configuración

La API también proporciona métodos de lectura/escritura para:

- Configuraciones por libro: `getProjectSettings()`, `setProjectSetting(...)`.
- Perfiles lingüísticos y referencias: `getLanguageProfiles()`, `saveLanguageProfile(...)`, `getLanguageResourceRefs(...)`, `saveLanguageResourceRef(...)`.
- Perfiles de estilo y pistas cronológicas: `getStyleProfiles()`, `saveStyleProfile(...)`, `getTimelineTracks()`, `saveTimelineTrack(...)`.
- Fichas, nombres, relaciones, evidencias, atributos, fragmentos y ocurrencias: `getProjectRecords()`, `saveProjectRecord(...)`, `getRecordNames(...)`, `saveRecordName(...)`, `getProjectRelations()`, `saveProjectRelation(...)`, `getProjectEvidences(...)`, `saveProjectEvidence(...)`, `getRecordAttributes(...)`, `saveRecordAttribute(...)`, `getRelationAttributes(...)`, `saveRelationAttribute(...)`, `getManuscriptFragments(...)`, `saveManuscriptFragment(...)`, `getTimelineOccurrences(...)`, `saveTimelineOccurrence(...)`.
- Sugerencias y autorizaciones: `getActiveSuggestions(...)`, `saveActiveSuggestion(...)`, `getImportAuthorizations()`, `authorizeImportBetweenProjects(...)`.
- Diccionarios: `getProjectDictionaries()`, `saveProjectDictionary(...)`, `getDictionaryEntries(...)`, `saveDictionaryEntry(...)`, `getDictionaryEntryEntityLinks(...)`, `setDictionaryEntryEntityLink(...)`.
- Historial y migraciones: `getRecordLifecycleHistory(...)`, `appendRecordLifecycle(...)`, `getRelationLifecycleHistory(...)`, `appendRelationLifecycle(...)`, `getSchemaMigrations()`.

Antes de mostrar una pestaña o habilitar una función opcional, consultar `motor.getCapabilities()`. Esta respuesta identifica capacidades del adaptador actual; no asumir que todo adaptador futuro implementará las mismas funciones. La capacidad `semanticContradictionAnalysis` es `false` y `externalRuntimeServices` es `false`.

Para presentar el grafo de ideas como una vista del libro completo, comprobar `projectWideNarrativeIdeaGraph`. Solo se anuncia cuando el adaptador puede leer tanto `loadIdeas` como `loadEntities`, para validar los vínculos explícitos. El análisis sigue devolviendo `ideaGraph` en modo de compatibilidad cuando esa capacidad no está disponible, pero `catalogScope: "character-linked-fallback"` indica que su catálogo procede únicamente del subconjunto ligado a personajes; la interfaz no debe llamarlo grafo global.

`projectCatalogComplete` es el indicador directo de exhaustividad: solo es `true` cuando `catalogScope` es `project` y `omittedIdeaCount` es cero. Cuando es `false`, los conteos de entrada y conectividad solo describen las aristas que parten de nodos incluidos.

Cuando `catalogScope: "project"`, `omittedIdeaCount` indica cuántas ideas quedaron fuera del snapshot de hasta 2.000. Las referencias `not-in-snapshot` no deben mostrarse como vínculos rotos porque su destino podría estar entre las ideas omitidas. Solo `missingFromProjectReferenceCount`, con catálogo global completo y cero ideas omitidas, confirma referencias sin destino en el proyecto. Las muestras visibles están limitadas: hasta 5.000 referencias y 100 ciclos o componentes conexos; presentar sus contadores de omisión para no sugerir exhaustividad. El grafo refleja únicamente vínculos declarados por el escritor, no inferencias semánticas.

Análisis descriptivo de un rango abierto:

```ts
const analysis = await motor.analyzeLiteraryDocument(documentId, startUtf16, endUtf16);
```

Este análisis no modifica el manuscrito ni sustituye la corrección en vivo. Los offsets de su entrada también son UTF-16.

### Tipos fuente autoritativos

El anfitrión debe importar los tipos públicos en vez de copiar o recrear estructuras por su cuenta:

| Contratos | Archivo |
|---|---|
| `ProjectIdentity`, `DocumentSnapshot`, `EditorChange`, `ChangeAdmission`, `CommitResult`, `AnalysisResult`, métricas y `ProjectStore` | `typescript/src/contracts.ts` |
| Entidades, relaciones, acontecimientos, ideas y biblioteca personal | `typescript/src/narrative-knowledge.ts` |
| Afirmaciones e historial narrativo | `typescript/src/narrative-history.ts` |
| Diccionarios y entradas | `typescript/src/dictionaries.ts` |
| Fichas MLDB, nombres, evidencias, atributos, fragmentos y sugerencias | `typescript/src/mldb-records.ts` |
| Ajustes, perfiles, pistas e historiales de ciclo de vida | `typescript/src/project-data.ts` |
| Análisis literario descriptivo | `typescript/src/literary-analysis.ts` |
| Fachada de integración | `typescript/src/host-api.ts` |
| Persistencia IndexedDB | `typescript/src/persistence/indexeddb-store.ts` |

## 8. Capacidades, métricas y errores

Consultar:

- `getCapabilities()`: versión y módulos disponibles.
- `getLiveAnalysisMetrics()`: admisión, rechazos, profundidad de cola, concurrencia, tiempos de espera/aplicación, análisis terminados/fallidos y percentiles end-to-end.
- `getDocumentSyncState(documentId)`: revisión y secuencia confirmadas, secuencia pendiente y necesidad de resincronización.
- `getDocumentDiagnostics(documentId)`: diagnósticos vigentes de la revisión actual.

Los errores de persistencia o extracción narrativa se notifican mediante `onKnowledgeError`. Un error de conocimiento no revierte una edición cuyo delta ya se confirmó durablemente; el anfitrión debe registrarlo y decidir cómo informar o reintentar. Los callbacks de interfaz deben ser rápidos y no lanzar excepciones que puedan detener el trabajo. Los callbacks `onAnalysis` y `onCommit` están aislados para que una excepción de la UI no rompa la cola.

No interpretar `queued` como `applied`, ni un diagnóstico de una revisión anterior como vigente. Registrar por separado la admisión, confirmación durable, análisis y errores.

## 9. Privacidad, almacenamiento y copias de seguridad

- En modo mismo proceso, el adaptador incluido utiliza IndexedDB local. En modo de procesos separados, el puente utiliza SQLite local y pipes privados del proceso hijo; no abre puertos ni envía manuscritos a servicios de terceros.
- Todas las consultas narrativas están limitadas al `projectId` de la instancia; la biblioteca personal está limitada al `writerId` autenticado.
- No compartir IDs de proyecto entre escritores distintos ni permitir que la interfaz elija un `writerId` arbitrario.
- No escribir directamente en `motor-literario-local`, sus object stores, claves o índices, ni en `bridge_records`/`bridge_document_heads`. Las migraciones pertenecen a cada adaptador.
- IndexedDB está ligado al origen y perfil local. El archivo SQLite del puente está ligado a la ruta local proporcionada al proceso compañero. Son bases físicas independientes y no se fusionan automáticamente.
- Al copiar el archivo SQLite para una copia de seguridad, detener antes el puente con `bridge.shutdown` y esperar el cierre del proceso; no copiar solo el archivo principal mientras SQLite está activo y puede tener datos en WAL.
- El puente Node incluye `bridge/database-snapshot.mjs` para crear, verificar y restaurar copias completas de SQLite; exige detener el puente y conserva la base anterior y sus sidecars.
- `HostEngineApi.exportDatabaseBackup()` y `restoreDatabaseBackup(backup)` son la superficie pública de respaldo; delegan en `IndexedDbProjectStore`, que cubre todos los object stores del navegador. La restauración se rechaza si la instancia ya ejecutó `initializeProject()`. La exportación lee una instantánea en una transacción readonly y genera un paquete JSON versionado con checksum. La restauración valida versión, catálogo de almacenes y checksum, y reemplaza todos los almacenes dentro de una transacción readwrite; un aborto conserva el estado anterior y un commit publica invalidaciones de proyecto y escritor.
- El anfitrión aún debe implementar el selector/guardado/lectura del archivo de respaldo con el mecanismo de archivos del entorno. `HostEngineApi.exportDatabaseBackup()` espera automáticamente a que el motor vacíe journal, análisis, diagnósticos y conocimiento pendientes. Restaurar con una instancia nueva en modo de mantenimiento, antes de ejecutar `initializeProject()` y abrir libros o documentos. Probar el flujo en el navegador real y definir cifrado en reposo sigue siendo parte de la aceptación de la aplicación. Ninguno de los dos respaldos copia object stores en caliente ni debe confundirse con el archivo de texto visible del manuscrito.

El anfitrión debe proporcionar copias de seguridad independientes tanto del manuscrito autoritativo como de los datos locales de conocimiento que decida conservar.

## 10. Lista de aceptación de la integración

La integración no debe declararse terminada hasta comprobar, en el programa anfitrión real, todos estos puntos:

- [ ] Elige y documenta la modalidad de ejecución: `HostEngineApi` en el mismo runtime, o el puente JSON-RPC de `BRIDGE_PROCESS_PROTOCOL_V1.md` para procesos separados.
- [ ] En modalidad de procesos separados, inicia el servidor por stdin/stdout, verifica `bridge.hello` y recibe `engine.analysis`/`engine.commit`.
- [ ] En modalidad de procesos separados, asigna una ruta privada al archivo SQLite, confirma recuperación después de reiniciar el proceso y aplica permisos del sistema operativo.
- [ ] Importa el motor o el cliente mediante `typescript/src/index.ts` y verifica `MOTOR_LITERARIO_API_VERSION`.
- [ ] Crea una instancia por proyecto y proporciona `projectId`, `projectName` y el `writerId` autenticado.
- [ ] Abre un documento con snapshot, revisión y secuencia autoritativos.
- [ ] Envía inserciones, eliminaciones, reemplazos y ediciones multilínea con offsets UTF-16.
- [ ] Prueba una ráfaga superior a la capacidad y comprueba que `queue_full` conserva/reintenta cambios en orden sin perder secuencias.
- [ ] Espera confirmaciones durables y no confunde `queued` con `applied`.
- [ ] Muestra diagnósticos solo en la revisión vigente y no aplica reemplazos automáticamente.
- [ ] Cierra/suspende después de `flushPendingChanges()`.
- [ ] Reinicia la aplicación y verifica recuperación con snapshot del anfitrión y con `recoverDocument()`.
- [ ] Fuerza una resincronización y comprueba que el anfitrión resuelve conflictos sin borrar deltas ni reiniciar contadores.
- [ ] Verifica aislamiento entre dos proyectos y dos escritores en el mismo perfil local.
- [ ] Comprueba extracción, consulta e historial narrativo; prueba la transferencia de ideas no incorporadas en un libro de ensayo.
- [ ] Ejecuta pruebas de cuota, bloqueo/cierre de IndexedDB, actualización de versión y cierre inesperado.
- [ ] Integra el paquete JSON de `exportDatabaseBackup()`/`restoreDatabaseBackup()` con archivos privados del anfitrión; prueba exportación, restauración y fallo/aborto en el navegador real.
- [ ] Define protección/cifrado en reposo y automatización de copias de seguridad según la política del anfitrión.
- [ ] Registra la versión de API, versión MLDB, navegador/runtime, sistema operativo, resultados y límites observados.

## 11. Validación del núcleo

Desde `base de datos/Motor-Literario/typescript/`:

```sh
npm install
npm run typecheck
npm test
npm run bench
```

La CI automatizada ejecuta typecheck, build, validación de esquema/almacenamiento, suite de pruebas y benchmark. El benchmark predeterminado usa un adaptador en memoria; sus latencias no sustituyen las mediciones de IndexedDB y del editor en el equipo anfitrión. Para aceptar la integración se necesitan pruebas adicionales con el runtime, editor y persistencia reales del programa anfitrión.
