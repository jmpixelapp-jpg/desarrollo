# Persistencia narrativa, biblioteca de ideas y sincronización

**Versión documental:** 1.7  
**Revisión de código de referencia:** `main` en `f99278768abb4fd0ad2fbb01dcc4bf4c49f1ed1f`  
**Ámbito:** núcleo `base de datos/Motor-Literario/typescript`  
**Lenguaje de implementación:** TypeScript/JavaScript puro  
**Estado:** guía de arquitectura y plan de endurecimiento; incluye diagnóstico local y bandeja outbox implementados en esta rama, sin declarar terminado el transporte remoto.

> Esta guía se ha redactado contrastando los contratos TypeScript, el adaptador IndexedDB, el esquema MLDB y los scripts de validación de la rama indicada. Cuando una capacidad no está conectada o no existe en ese código, se identifica como pendiente.

## 1. Objetivo

Establecer un diseño durable, verificable y explicable para:

- conservar manuscritos y sus revisiones;
- mantener el conocimiento narrativo asociado a cada proyecto;
- administrar una biblioteca de ideas personal y bibliotecas vinculadas a libros;
- conservar evidencias y relaciones sin referencias cruzadas entre proyectos;
- permitir recuperación local después de cierres inesperados;
- preparar sincronización segura entre dispositivos sin pérdida silenciosa de cambios.

La capa de persistencia no decide la verdad literaria. Conserva datos, revisiones, procedencia y referencias para que las herramientas de análisis puedan presentar resultados auditables al escritor.

## 2. Límites y vocabulario

**Proyecto:** espacio de trabajo/libro identificado por `projectId`.  
**Escritor:** propietario lógico identificado por `writerId`.  
**Ficha/registro:** entidad estructurada de MLDB, identificada dentro de un proyecto.  
**Idea personal:** elemento de la biblioteca personal del escritor, que puede proceder de un proyecto sin dejar de pertenecer al ámbito personal.  
**Evidencia:** referencia a un fragmento documental que respalda una afirmación o relación.  
**Revisión:** versión del contenido o registro frente a la que se validan cambios.  
**Operación de sincronización:** unidad idempotente que representa una mutación confirmada y transportable.

No deben confundirse:
- orden de lectura con cronología de la historia;
- una coincidencia de texto con identidad de una ficha;
- una idea personal con una idea ya incorporada a un libro;
- una notificación entre pestañas con almacenamiento durable;
- la persistencia local con respaldo externo;
- una bandeja local de salida con sincronización remota terminada.

## 3. Mapa de módulos

| Módulo | Ruta | Responsabilidad |
|---|---|---|
| Contratos de almacenamiento | `typescript/src/contracts.ts` | Interfaz `ProjectStore` y contratos almacenados |
| Adaptador IndexedDB | `typescript/src/persistence/indexeddb-store.ts` | Apertura, migraciones, transacciones y consultas locales |
| Conocimiento narrativo | `typescript/src/narrative-knowledge.ts` | Entidades, relaciones, acontecimientos, ideas y validaciones |
| Historial narrativo | `typescript/src/narrative-history.ts` | Afirmaciones e historial relacionado |
| Registros MLDB | `typescript/src/mldb-records.ts` | Fichas, nombres, relaciones, evidencias y ocurrencias temporales |
| Datos de proyecto | `typescript/src/project-data.ts` | Configuración, perfiles y ciclos de vida |
| Monitor de autoría | `typescript/src/live-author-monitor.ts` | Checkpoints, leases y coordinación del análisis en vivo |
| Esquema lógico | `MLDB/schema_v0.4.2.json` | Contrato de datos MLDB |
| Mapa físico | `MLDB/storage_mapping_v0.4.2.json` | Object stores, keyPaths e índices IndexedDB |
| Validación | `typescript/scripts/validate-mldb-schema.mjs` | Coherencia del esquema lógico |
| Auditoría física | `typescript/scripts/audit-storage-implementation.mjs` | Coherencia entre mapa de almacenamiento e implementación |

El nombre de archivo `schema_v0.4.2.json` y `storage_mapping_v0.4.2.json` es histórico. En esta revisión, el descriptor declara `schema_version: "0.4.2"` y el mapa físico `mapping_version: 14`; no se debe actualizar un número de versión solo por cambiar la documentación.

## 4. Modelo de datos y aislamiento

### 4.1 Datos de proyecto

Los registros del libro se aíslan por `projectId`. En los almacenes compuestos, la clave debe incluir el proyecto para que dos libros puedan tener IDs locales iguales sin colisionar. Los índices de búsqueda también deben incluir `projectId` cuando consultan entidades pertenecientes a un libro.

Algunas familias presentes en el mapa de almacenamiento:
- documentos y cambios;
- entidades, relaciones, acontecimientos e ideas narrativas;
- afirmaciones y diagnósticos;
- fichas, nombres, relaciones y evidencias MLDB;
- ocurrencias de cronología;
- fragmentos de manuscrito y atributos;
- sugerencias activas;
- diccionarios, perfiles de idioma y estilo;
- ciclos de vida de fichas, relaciones y acontecimientos;
- checkpoints y leases del monitor.

### 4.2 Biblioteca personal de ideas

El almacén `personal-idea-library` utiliza clave compuesta `[writerId, sourceProjectId, idea.id]`. El ámbito del escritor y el proyecto de origen forman parte de la identidad de almacenamiento.

Reglas:
1. una idea personal no se convierte automáticamente en contenido del libro;
2. la procedencia de una idea debe conservarse;
3. importar o transferir una idea a otro libro requiere autorización explícita y validación de destino;
4. una relación entre ideas debe comprobar que el destino existe en el mismo ámbito permitido;
5. borrar o archivar un elemento debe tratar referencias entrantes para evitar enlaces colgantes;
6. las búsquedas globales de biblioteca deben filtrar por escritor antes de presentar resultados;
7. no inferir propiedad a partir de nombres, etiquetas o coincidencias textuales.

### 4.3 Evidencia y cronología

Las evidencias deben referenciar el proyecto, documento y fragmento pertinentes. Al cambiar el manuscrito, los anclajes deben validarse frente a la revisión actual. Una referencia antigua no debe presentarse como evidencia vigente sin comprobar su estado.

La cronología narrativa se almacena separada del orden del manuscrito. Las ocurrencias temporales deben preservar la referencia temporal, pista/track y orden narrativo que el contrato establezca; una reordenación de capítulos no debe alterar silenciosamente el tiempo de la historia.

## 5. Persistencia local

### 5.1 IndexedDB actual

En la revisión base `main` usada para iniciar esta línea:
- base: `motor-literario-local`;
- versión de IndexedDB: **24**;
- esquema lógico MLDB: **0.4.2**;
- mapa físico: **mapping_version 14**.

**Migración incorporada en esta rama:** IndexedDB **25**, mapa físico **mapping_version 15** y los almacenes internos `sync-outbox` y `sync-device-sequences`. El esquema lógico MLDB permanece en 0.4.2 porque la outbox es infraestructura interna de transporte, no una tabla narrativa exportable.

La versión real se obtiene del código y del mapa físico, no de una suposición. Cualquier migración debe incrementar la versión de IndexedDB y actualizar en el mismo cambio el mapa físico, los validadores y las pruebas.

### 5.2 Reglas de migración

Una migración segura debe:
1. ser aditiva siempre que sea posible;
2. crear únicamente almacenes/índices ausentes;
3. no borrar datos previos para resolver una colisión;
4. ser idempotente respecto de una base ya migrada;
5. mantener claves y nombres históricos compatibles;
6. validar los almacenes creados al terminar;
7. conservar los datos si la migración falla, dejando que IndexedDB revierta la transacción de actualización;
8. tener pruebas desde las versiones anteriores que el producto declare soportadas.

No se debe reutilizar un número de versión para dos esquemas físicos distintos.

### 5.3 Transacciones

Las operaciones que actualizan un registro y su historial deben ejecutarse en una misma transacción IndexedDB cuando el contrato requiera atomicidad. No dividir una actualización y su registro de ciclo de vida en dos transacciones independientes: una caída entre ambas dejaría un estado imposible de auditar.

No mantener una transacción abierta mientras se realizan operaciones de red, temporizadores o trabajo asíncrono no compatible con el ciclo de vida de IndexedDB. Preparar y validar el payload antes de abrir la transacción; completar rápidamente las lecturas/escrituras; confirmar o abortar.

### 5.4 Respaldo y recuperación

IndexedDB no equivale a una copia de seguridad. El navegador puede limitar, limpiar o eliminar almacenamiento. La solicitud de persistencia del origen, cuando se implemente, tampoco garantiza recuperación ante pérdida del perfil o del dispositivo.

El anfitrión debe ofrecer exportación/restauración con:
- formato versionado y validación antes de importar;
- integridad de contenido y metadatos;
- confirmación del proyecto de destino;
- estrategia de colisión de IDs;
- previsualización de elementos que se crearán, actualizarán o ignorarán;
- operación de restauración transaccional o por lotes reanudables;
- prueba de restauración en un perfil limpio;
- nunca reemplazar silenciosamente un proyecto existente.

## 6. Diagnóstico de almacenamiento

La futura API de salud local debe devolver, como mínimo:
- nombre y versión de base;
- almacenes detectados y conteos;
- cuota y uso estimados si `navigator.storage.estimate()` está disponible;
- estado de persistencia si `navigator.storage.persisted()` está disponible;
- advertencias cuando las APIs no existan o devuelvan valores nulos.

El diagnóstico debe ser de solo lectura. Las cifras de cuota son estimaciones y no prometen espacio disponible en el futuro. La solicitud de almacenamiento persistente debe ser una acción explícita de la aplicación anfitriona, y el resultado depende del navegador.

**Implementación añadida en esta rama:** `IndexedDbProjectStore.inspectStorageHealth()` cuenta registros por object store en una transacción de solo lectura y consulta `estimate()` y `persisted()` cuando están disponibles. `requestPersistentStorage()` solicita persistencia y devuelve el resultado del navegador; si la API no existe o falla, devuelve `false`. La inspección no incluye contenido del manuscrito y no modifica el esquema v24. Los tests cubren cuota disponible/no disponible, persistencia concedida/ausente y no mutación del documento. Esta capacidad está en la rama de PR y no debe atribuirse a `main` hasta su integración.

## 7. Contrato de sincronización propuesto

La sincronización debe construirse sobre operaciones inmutables, no sobre snapshots completos enviados sin control de revisión.

### 7.1 Operación durable

Contrato recomendado:

| Campo | Tipo/propósito |
|---|---|
| `operationId` | ID global estable para idempotencia |
| `writerId` | Propietario autenticado |
| `projectId` | Proyecto al que pertenece |
| `deviceId` | Identidad lógica del dispositivo |
| `sequence` | Secuencia creciente por proyecto y dispositivo |
| `kind` | Tipo de operación con versión |
| `payload` | Datos mínimos para aplicar la mutación |
| `baseRevision` | Revisión que el autor esperaba modificar |
| `createdAt` | Marca temporal informativa, no orden causal |
| `attemptCount` | Número de intentos de transporte |
| `lastAttemptAt` | Último intento |
| `lastErrorCode` | Código no sensible del último error |

El tiempo de reloj del dispositivo no debe usarse como único criterio de orden causal. La secuencia del dispositivo y las revisiones del servidor determinan el orden de aplicación.

### 7.2 Almacén local de salida

La migración v25 crea dos almacenes internos:

- `sync-outbox`, clave primaria `operationId`;
- `sync-device-sequences`, clave compuesta `[projectId, deviceId]`, que conserva `lastSequence` aun después de retirar operaciones confirmadas.

Índices de `sync-outbox`:

- `by-project-created-at`: `[projectId, createdAt]`, para lectura paginada y ordenada;
- `by-project-device-sequence`: `[projectId, deviceId, sequence]`, único entre operaciones pendientes.

La escritura de una operación en `sync-outbox` y el avance de `lastSequence` se realizan en la misma transacción IndexedDB. La secuencia debe ser exactamente la siguiente a la última guardada. Así se evita reutilizar secuencias después del acuse y no se consume una secuencia si la inserción aborta. Si dos pestañas leen el mismo cursor, solo una podrá encolar esa secuencia; la otra debe volver a leer el cursor y reintentar.

**Métodos disponibles en `IndexedDbProjectStore`:**

1. `loadLastSyncOperationSequence(projectId, deviceId)`: devuelve el cursor durable o cero.
2. `enqueueSyncOperation(operation)`: valida e inserta idempotentemente y avanza la secuencia de forma atómica.
3. `loadPendingSyncOperations(projectId, limit)`: lee pendientes paginadas sin borrarlas.
4. `recordSyncOperationAttempt(operationId, attemptedAt, error?)`: registra contador, fecha y código de error no sensible.
5. `acknowledgeSyncOperation(operationId)`: retira la operación después del acuse remoto durable; el cursor de secuencia se conserva.

Ejemplo de uso local (no realiza transporte de red):

```ts
const lastSequence = await store.loadLastSyncOperationSequence(projectId, deviceId);
await store.enqueueSyncOperation({
  operationId: crypto.randomUUID(),
  projectId,
  deviceId,
  sequence: lastSequence + 1,
  kind: "narrative.record.updated",
  payload: JSON.stringify({ recordId, expectedRevision, nextRevision }),
  createdAt: Date.now(),
  attemptCount: 0
});
const pending = await store.loadPendingSyncOperations(projectId, 50);
```

Tras un error temporal, el anfitrión registra `recordSyncOperationAttempt(operationId, Date.now(), errorCode)` usando un código estable y no sensible, nunca el texto completo de una excepción. Solo cuando el servidor confirma que la operación quedó almacenada durablemente debe llamarse a `acknowledgeSyncOperation(operationId)`. No se guardan tokens ni credenciales dentro del payload.

La outbox es infraestructura local: todavía no integra automáticamente todas las mutaciones de documentos, fichas, relaciones e ideas. Por ello aún no garantiza sincronización completa ni pérdida cero de todas las escrituras del dominio. La escritura de dominio y su operación outbox deberán incorporarse en una misma transacción para obtener esa garantía.

### 7.3 Cobertura de mutaciones

Antes de conectar transporte, inventariar todas las escrituras mutables:
- documentos y revisiones;
- fichas y nombres;
- relaciones y atributos;
- evidencias;
- ideas personales y del libro;
- ciclos de vida;
- cronologías y pistas;
- diccionarios y perfiles;
- preferencias del proyecto;
- importaciones, finalizaciones y acciones de biblioteca.

Para cada método de escritura, definir si:
1. se sincroniza;
2. es derivado y se reconstruye localmente;
3. es efímero y no se sincroniza;
4. requiere permiso especial o queda fuera del protocolo.

No incluir diagnósticos efímeros, cachés o checkpoints del monitor por defecto: su sincronización debe justificarse explícitamente.

## 8. Protocolo remoto

### 8.1 Flujo de subida

1. leer lote pendiente del proyecto;
2. obtener credencial desde el anfitrión; no persistir token en la outbox;
3. enviar envelope con versión de protocolo;
4. servidor autentica usuario y autoriza acceso al proyecto;
5. validar tamaño, tipo, versión, secuencia, baseRevision y payload;
6. aplicar operación idempotente y persistir resultado;
7. responder con acuse durable, duplicado ya aplicado o conflicto;
8. solo con acuse durable eliminar la operación local;
9. ante error temporal, registrar intento y reintentar con backoff exponencial y jitter;
10. ante error permanente, mantener la operación y mostrar un estado accionable al usuario.

### 8.2 Flujo de descarga

El servidor debe exponer un cursor monotónico por proyecto o una versión equivalente. El cliente:
- solicita cambios posteriores al cursor guardado;
- valida el envelope;
- aplica cada cambio con transacciones locales;
- avanza el cursor solo después de aplicar durablemente el lote;
- puede repetir un lote sin duplicar efectos;
- detecta huecos de secuencia y solicita reconciliación.

### 8.3 Recuperación en el límite del acuse

Caso crítico: el servidor guarda una operación y el cliente se cierra antes de borrar la outbox. En el siguiente intento, el cliente reenvía el mismo `operationId`; el servidor debe devolver el resultado ya guardado, sin aplicar dos veces, y el cliente retira la entrada. Esta es la razón de que el ID de operación sea estable y de que el servidor mantenga un registro de idempotencia.

## 9. Conflictos y consistencia

No aplicar “última escritura gana” a texto narrativo ni a decisiones editoriales.

Clases mínimas:
- cambios independientes sobre fragmentos distintos;
- ediciones solapadas del mismo fragmento;
- ficha modificada en dos dispositivos;
- eliminación concurrente con actualización;
- relación cuyo destino se eliminó;
- cambios de ciclo de vida incompatibles;
- cambio de biblioteca personal y transferencia a libro;
- secuencia de dispositivo duplicada, saltada o antigua;
- operación válida basada en una revisión obsoleta.

La respuesta de conflicto debe incluir IDs, revisiones base/local/remota y tipo de conflicto. Se conservan las versiones para que el usuario pueda comparar. Una resolución editorial produce una nueva operación explícita; nunca reescribe el historial como si el conflicto no hubiera existido.

Para ediciones de texto, evaluar diff de fragmentos y estrategia de merge consciente de límites Unicode/UTF-16, CRLF, offsets y estructura de párrafos. No usar un CRDT sin especificar primero el modelo de identidad de fragmentos, borrados, formato y compatibilidad.

## 10. Seguridad y privacidad

- El servidor es autoridad para identidad y permisos.
- No confiar en `writerId`, `projectId` o `deviceId` aportados por cliente sin contrastarlos con la sesión autenticada.
- Nunca incluir tokens, contraseñas ni secretos en payload, logs o diagnósticos.
- Validar tipo, profundidad, tamaño y versión de cada payload en cliente y servidor.
- Limitar logs para no copiar texto privado del manuscrito.
- Restringir consultas y operaciones al proyecto autorizado.
- Mantener separada la biblioteca personal de los proyectos compartidos.
- Definir revocación de dispositivo, exportación, borrado y retención antes de habilitar nube.
- Cifrado en tránsito obligatorio; cifrado en reposo y gestión de claves se especifican en el diseño del servicio.

## 11. Notificaciones entre pestañas

Los eventos entre instancias locales son avisos, no fuente de verdad. Al recibir un aviso:
1. validar el ID del proyecto;
2. invalidar cachés;
3. volver a leer IndexedDB;
4. tolerar duplicados, mensajes perdidos y orden distinto;
5. no incluir manuscrito ni datos sensibles en el mensaje.

La aplicación debe seguir siendo correcta aunque no llegue ninguna notificación.

## 12. Pruebas requeridas

Scripts de paquete existentes en la revisión de referencia:
- `npm run typecheck`;
- `npm run build`;
- `npm run validate:schema`;
- `npm test`;
- `npm run bench`.

La suite actual ejecuta validación de esquema, auditoría de almacenamiento y pruebas Node. Añadir o ampliar cobertura para:

### Persistencia local
- apertura desde base nueva;
- migración desde cada versión soportada;
- conservación de todos los stores y registros anteriores;
- aborto de migración ante error;
- transacción atómica de registro + historial;
- cuota no disponible y persistencia denegada;
- exportar/restaurar y verificar conteos y relaciones.

### Biblioteca
- aislamiento entre escritores y proyectos;
- idea personal que procede de un libro;
- transferencia autorizada;
- destino inexistente o eliminado;
- referencias duplicadas, ciclos y límites;
- concurrencia de ediciones y borrados.

### Outbox
- migración desde IndexedDB v24 conserva todos los stores anteriores;
- inserción idempotente y colisión de ID;
- índice único de secuencia por proyecto/dispositivo;
- lectura paginada y ordenada;
- registro de intentos;
- acuse y borrado;
- inserción atómica con la mutación;
- idempotencia por ID;
- colisión de ID con contenido distinto;
- secuencia única y huecos;
- paginación estable;
- retry y backoff;
- acuse y borrado;
- caída antes y después de acuse;
- proyecto sin permisos o revocado.

### Multi-dispositivo
- dos dispositivos editando el mismo fragmento;
- ediciones independientes;
- conflicto solapado;
- eliminación frente a actualización;
- reenvío tras perder respuesta;
- cursor de descarga repetido o discontinuo;
- credencial expirada/revocada;
- dispositivo desconectado durante días;
- restauración de un backup y reconciliación.

## 13. Criterios para declarar cada fase terminada

| Fase | Criterio de aceptación |
|---|---|
| Persistencia | migraciones soportadas, atomicidad, diagnóstico, exportación/restauración probada |
| Biblioteca | aislamiento completo, referencias válidas, transferencias autorizadas y pruebas de concurrencia |
| Outbox | toda mutación sincronizable se registra atómicamente, con IDs y secuencias estables |
| Transporte | autenticación, envío, idempotencia del servidor, acuses durables y reintentos |
| Descarga | cursor durable, aplicación idempotente y recuperación de huecos |
| Conflictos | tipos definidos, versiones conservadas y resolución editorial verificable |
| E2E | dos dispositivos reales, fallos de red, cierres y recuperación sin pérdida |
| Documentación | contratos, esquema, migraciones, API y ejemplos actualizados junto con código |

## 14. Estado real en la revisión de referencia

| Capacidad | Estado |
|---|---|
| Núcleo TypeScript/JavaScript sin runtime Rust | Presente |
| Persistencia IndexedDB | Presente; versión 25 en esta rama (24 en main de referencia) |
| Biblioteca personal de ideas y procedencia | Presente en el modelo/almacén |
| Registros MLDB, relaciones, evidencias y cronología | Presentes |
| Ciclos de vida append-only | Presentes |
| Checkpoints y leases del monitor | Presentes |
| Outbox durable de sincronización | Implementada en IndexedDB v25 en esta rama |
| Cursor monotónico por proyecto/dispositivo | Implementado; se conserva después del acuse |
| Encolado automático/atómico de todas las mutaciones de dominio | Pendiente |
| Diagnóstico de cuota y solicitud de persistencia | Implementado y cubierto por prueba IndexedDB; CI global aún tiene fallos ajenos a esta API |
| Transporte remoto y autenticación | Pendiente |
| Descarga y reconciliación | Pendiente |
| Resolución de conflictos multidispositivo | Pendiente |
| E2E real entre dispositivos | Pendiente |
| Exportación/restauración E2E del anfitrión | Pendiente de validar |

## 15. Orden recomendado de implementación

1. Congelar contratos y generar inventario de todos los métodos de escritura.
2. Añadir pruebas de integridad y recuperación de la persistencia actual.
3. Definir el contrato de operación versionado y la identidad estable del dispositivo.
4. Crear outbox y migración aditiva.
5. Hacer atómica cada mutación sincronizable con su operación outbox.
6. Añadir diagnóstico de almacenamiento y flujo de respaldo/restauración.
7. Definir el API de transporte como interfaz inyectada por el anfitrión.
8. Implementar servidor con autorización, idempotencia y cursor.
9. Añadir descarga y reconciliación.
10. Diseñar resolución explícita de conflictos.
11. Validar dos dispositivos, fallos y recuperación.
12. Actualizar este documento y el esquema en cada cambio.

**Regla de mantenimiento:** no marcar una capacidad como terminada por existir solo un tipo, interfaz, almacén o test aislado. Se considera implementada cuando el flujo real está conectado, probado, documentado y cubierto por CI.
