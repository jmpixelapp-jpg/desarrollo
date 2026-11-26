# Persistencia del conocimiento narrativo, biblioteca de ideas y sincronización

**Documento:** arquitectura y operación  
**Versión:** 1.0  
**Estado:** describe el código TypeScript disponible en la rama de trabajo; distingue explícitamente lo implementado de lo pendiente.  
**Ámbito:** `base de datos/Motor-Literario/typescript`  
**Restricción de implementación:** TypeScript/JavaScript puro. El código Rust histórico no forma parte del runtime y no se modifica en esta línea de trabajo.

## 1. Propósito y alcance

Este documento reúne el contrato conceptual, la persistencia, las garantías, las migraciones, la operación de la biblioteca de ideas, la bandeja local de sincronización y el plan para completar la sincronización entre dispositivos.

Los objetivos son:

1. conservar documentos y conocimiento narrativo estructurado sin mezclar proyectos;
2. mantener entidades, relaciones, acontecimientos, evidencias, afirmaciones, cronologías e ideas como registros recuperables;
3. permitir que la biblioteca de ideas conserve su identidad y sus vínculos con el libro;
4. evitar pérdidas por reintentos, escrituras obsoletas o cambios concurrentes;
5. preparar una salida durable para sincronizar operaciones con un servidor;
6. documentar con precisión qué garantías existen hoy y cuáles requieren todavía un servicio remoto.

Este documento no promete comprensión semántica general. Los análisis lexicales y estructurales son ayudas explicables; la interpretación y decisión editorial final corresponden al escritor.

## 2. Mapa del código

| Área | Ubicación | Responsabilidad |
|---|---|---|
| Contratos | `typescript/src/contracts.ts` | Tipos de documentos, registros narrativos, relaciones y operaciones de sincronización |
| API anfitriona | `typescript/src/host-api.ts` | Superficie de integración del programa que incorpora el motor |
| Persistencia IndexedDB | `typescript/src/persistence/indexeddb-store.ts` | Transacciones locales, migración, consultas y bandeja de salida |
| Historial narrativo | `typescript/src/narrative-history.ts` | Historiales de cambios narrativos y sus revisiones |
| Conocimiento narrativo | `typescript/src/narrative-knowledge.ts` | Entidades, relaciones, afirmaciones, evidencias, cronología y validaciones |
| Monitor de autoría | `typescript/src/live-author-monitor.ts` | Checkpoints, leases y métricas de sesión del monitor |
| Esquema lógico | `MLDB/schema_v0.4.2.json` | Declaración lógica MLDB; su campo `schema_version` indica 0.4.3 |
| Mapa físico | `MLDB/storage_mapping_v0.4.2.json` | Correspondencia entre tablas lógicas y almacenes IndexedDB |
| Pruebas | `typescript/tests/` y `typescript/test/` | Contratos, migraciones, regresiones y auditorías |

Los nombres de archivo MLDB conservan el sufijo histórico `v0.4.2`; la versión lógica declarada dentro de ambos documentos es `0.4.3`. No se debe deducir la versión lógica únicamente del nombre de archivo.

## 3. Principios de diseño

### 3.1 Aislamiento

Los registros pertenecen a un proyecto. Las claves e índices de los almacenes usan el identificador de proyecto cuando el registro es proyectual. Las lecturas y escrituras deben conservar ese ámbito; nunca se debe resolver una relación consultando un destino de otro proyecto.

### 3.2 Fuente durable

Las estructuras en memoria y las notificaciones entre pestañas son mecanismos auxiliares. No sustituyen el registro durable. Una notificación informa que puede haber cambios; el consumidor debe volver a leer el almacén.

### 3.3 Escrituras verificables

Las escrituras que dependen de una versión previa deben validar la revisión esperada y rechazar conflictos incompatibles. No se debe convertir una colisión editorial en una fusión automática silenciosa.

### 3.4 Idempotencia

Una repetición causada por reintento no debe duplicar una operación ya aceptada. Los identificadores de operación deben ser estables y el mismo identificador no puede representar dos contenidos diferentes.

### 3.5 Conservación

Los datos pendientes de sincronización no se eliminan al leerlos ni al intentar enviarlos. Solo se retiran después de una confirmación remota verificable. La exportación de respaldo sigue siendo necesaria: IndexedDB y la persistencia solicitada al navegador no equivalen a una copia de seguridad.

### 3.6 Separación de responsabilidades

El motor TypeScript conserva y valida el conocimiento. La aplicación anfitriona aporta interfaz, identidad del usuario, permisos y, cuando se implemente, transporte remoto. No se deben introducir credenciales dentro de la base local ni acoplar el motor a un proveedor de nube concreto.

## 4. Modelo conceptual del conocimiento

El proyecto mantiene separadas las siguientes clases de información:

- **Documento:** contenido escrito y su secuencia de cambios.
- **Entidad narrativa:** personaje, lugar, objeto, organización u otro sujeto identificable.
- **Relación:** vínculo tipado entre entidades o ideas, dentro del mismo ámbito de proyecto/libro.
- **Acontecimiento:** evento narrativo con participantes, etiquetas, estado y referencias temporales.
- **Afirmación:** proposición atribuida a un sujeto o fuente.
- **Evidencia:** anclaje documental que permite localizar y revisar el fragmento que respalda una afirmación.
- **Ocurrencia de cronología:** referencia temporal estructurada para ordenar hechos, sin confundir el orden de exposición con el orden de la historia.
- **Idea:** elemento de la biblioteca, que puede estar asociado a un proyecto/libro o conservarse en el espacio personal según su ámbito.

Las referencias documentales deben poder revisarse cuando el manuscrito cambia. Un anclaje no debe tratarse como prueba vigente solo porque alguna vez apuntó a un texto: su estado y su correspondencia con la revisión actual importan.

La detección de contradicciones es una ayuda para revisión. Por ejemplo, una transición de muerto a vivo puede dejar de ser contradictoria si existe una resurrección explícita y temporalmente pertinente; evidencia obsoleta no basta para justificarla. La ausencia de contradicción automática no demuestra que el relato sea semánticamente correcto.

## 5. Biblioteca de ideas

La biblioteca no debe confundirse con el manuscrito ni con el grafo de entidades del libro.

Reglas de integridad:

1. cada idea tiene identidad estable y ámbito explícito;
2. los vínculos a fichas o a otras ideas deben comprobar que el destino existe en el catálogo durable;
3. una idea personal no se convierte en contenido de un libro por compartir una etiqueta o texto;
4. una idea eliminada no debe seguir siendo un destino válido de nuevas relaciones;
5. los reintentos de escritura deben volver a validar los destinos, porque otra instancia pudo eliminarlos entre intentos;
6. las decisiones editoriales concurrentes incompatibles no se fusionan automáticamente;
7. una consulta de biblioteca debe paginar resultados cuando el volumen lo requiera; no se debe cargar una biblioteca ilimitada en memoria.

La lógica de relaciones debe preservar la separación entre biblioteca personal y contenido del libro. Antes de implementar una operación de transferencia o vinculación, el anfitrión debe expresar claramente el ámbito de origen y destino y el usuario debe poder revisar el efecto.

## 6. Persistencia local e IndexedDB

### 6.1 Base y migración

El adaptador IndexedDB declara:

- nombre de base: `motor-literario-local`;
- versión actual de base: **25**;
- nueva object store: `sync-outbox`;
- clave primaria de la bandeja: `operationId`.

La migración de esquema agrega el almacén faltante y sus índices sin borrar los almacenes narrativos existentes. La migración debe ser aditiva y conservar documentos, cambios, ideas, relaciones, evidencias, cronologías, checkpoints y leases preexistentes.

Índices de `sync-outbox`:

- `by-project-created-at`: `[projectId, createdAt]`, para recuperar operaciones de un proyecto en orden temporal;
- `by-project-device-sequence`: `[projectId, deviceId, sequence]`, único, para impedir repetir una secuencia dentro del mismo proyecto y dispositivo.

### 6.2 Diagnóstico del almacenamiento

`IndexedDbProjectStore.inspectStorageHealth()` devuelve:

- nombre y versión de base;
- conteos por almacén;
- uso y cuota estimados cuando `navigator.storage.estimate()` está disponible;
- estado de persistencia cuando `navigator.storage.persisted()` está disponible.

Es una inspección de solo lectura. Los valores de cuota son aproximados, pueden no estar disponibles y no garantizan que el navegador nunca elimine los datos.

`IndexedDbProjectStore.requestPersistentStorage()` solicita al navegador almacenamiento persistente. El navegador decide si concede la solicitud. La aplicación anfitriona debe ofrecer esta acción de forma explícita y explicar su finalidad.

### 6.3 Copias de seguridad

La persistencia del navegador no reemplaza una exportación de respaldo. El anfitrión debe ofrecer un flujo separado para exportar, guardar fuera del origen y restaurar los datos. Antes de considerar completa la recuperación se deben probar:

- exportación de un proyecto con documentos y biblioteca;
- validación de integridad del archivo exportado;
- restauración en un perfil/navegador limpio;
- comparación de conteos, revisiones, relaciones y anclajes;
- manejo de una restauración interrumpida;
- confirmación visible al usuario de qué proyecto se reemplaza o incorpora.

No se debe sobrescribir silenciosamente un proyecto existente al restaurar.

## 7. Contrato de la bandeja de salida

El contrato `StoredSyncOperation` contiene:

| Campo | Significado |
|---|---|
| `operationId` | Identificador estable e idempotente |
| `projectId` | Proyecto propietario |
| `deviceId` | Identidad lógica del dispositivo de origen |
| `sequence` | Secuencia positiva por proyecto y dispositivo |
| `kind` | Tipo/versionado de operación |
| `payload` | JSON serializado de la operación |
| `createdAt` | Marca temporal local |
| `attemptCount` | Número de intentos registrados |
| `lastAttemptAt` | Momento del último intento, opcional |
| `lastError` | Último error de transporte, opcional |

Validaciones actuales de entrada:

- identificadores no vacíos y límites de longitud;
- secuencia entera segura mayor o igual que 1;
- tipo de operación no vacío;
- payload JSON válido y objeto JSON, no array ni valor primitivo;
- tamaño del payload limitado a 2.000.000 caracteres;
- operación nueva entra con contador cero y sin metadatos de intento;
- secuencia única por proyecto/dispositivo;
- un `operationId` repetido con el mismo contenido es idempotente;
- reutilizar un `operationId` con contenido distinto produce colisión.

Métodos disponibles en `IndexedDbProjectStore`:

1. `enqueueSyncOperation(operation)`: valida y persiste una operación pendiente.
2. `loadPendingSyncOperations(projectId, limit = 100)`: recupera operaciones del proyecto, ordenadas por `createdAt`, sin retirarlas; el límite aceptado está entre 1 y 1000.
3. `recordSyncOperationAttempt(operationId, attemptedAt, error?)`: incrementa el contador y conserva el último intento/error.
4. `acknowledgeSyncOperation(operationId)`: elimina la operación si existe y devuelve si había un registro que retirar.

Los métodos están declarados como capacidades opcionales en `ProjectStore` para no romper adaptadores que aún no implementen la bandeja. La aplicación debe comprobar la disponibilidad de la capacidad antes de depender de ella.

**Importante:** la bandeja es una infraestructura local. No demuestra que todas las mutaciones del manuscrito o biblioteca se estén encolando automáticamente, ni implementa por sí sola HTTP, autenticación, servidor, sincronización entre dispositivos o resolución de conflictos. No se debe anunciar sincronización remota funcional hasta completar y probar ese flujo integral.

## 8. Protocolo remoto que falta implementar

La implementación remota debe mantener estas fases separadas:

1. **Preparación:** leer un lote pendiente de un único proyecto y dispositivo; no modificar ni borrar los registros.
2. **Autenticación:** obtener credenciales de corta duración desde el anfitrión; nunca guardar tokens en el payload ni en logs.
3. **Envío:** transmitir un envelope versionado con `operationId`, proyecto, dispositivo, secuencia, tipo, payload y metadatos necesarios.
4. **Validación del servidor:** comprobar usuario, autorización, pertenencia al proyecto, esquema, tamaño, secuencia e idempotencia.
5. **Aplicación remota:** aplicar de forma transaccional o devolver conflicto explícito. El servidor debe almacenar el resultado idempotente para que un reintento no duplique efectos.
6. **Acuse:** devolver aceptación durable, duplicado ya aplicado o conflicto. El cliente solo llama a `acknowledgeSyncOperation` cuando el servidor confirma que la operación está guardada de forma durable.
7. **Reintento:** errores temporales mantienen la operación en la bandeja y registran el intento; se debe añadir backoff exponencial con jitter y límite operativo, sin descartar el dato.
8. **Conflicto:** conservar las dos versiones, mostrar el conflicto y pedir una decisión editorial cuando no exista una regla segura de fusión.
9. **Descarga:** obtener cambios remotos desde un cursor/versionado del servidor y aplicarlos con validación de revisiones, idempotencia y transacciones locales.
10. **Recuperación:** si el cliente cae después de que el servidor aceptó pero antes del acuse local, reenvía la misma operación; el servidor responde como duplicado aceptado y el cliente puede retirar la entrada.

### 8.1 Envelope recomendado

El protocolo deberá definir un envelope versionado, por ejemplo:

```json
{
  "protocolVersion": 1,
  "operationId": "uuid-estable",
  "projectId": "project-id",
  "deviceId": "device-id",
  "sequence": 42,
  "kind": "narrative.entity.updated",
  "createdAt": 1795651200000,
  "payload": {
    "entityId": "entity-id",
    "expectedRevision": 8,
    "nextRevision": 9
  }
}
```

Este ejemplo es una propuesta documental, no un endpoint ni una implementación existente. El contrato final debe definir catálogo de tipos, validadores por tipo, tamaño máximo en bytes, reglas de versión y compatibilidad hacia atrás.

### 8.2 Conflictos

No se debe usar “última escritura gana” para texto narrativo o decisiones editoriales. Como mínimo deben distinguirse:

- cambios independientes que pueden combinarse sin solapamiento;
- cambios sobre el mismo fragmento/documento;
- edición concurrente de una entidad o relación;
- eliminación frente a actualización;
- cambio de estado editorial incompatible;
- destino de relación eliminado en otro dispositivo;
- operación repetida ya aplicada;
- dispositivo que reanuda una secuencia antigua.

El protocolo debe devolver un conflicto tipado, con las revisiones base/local/remota y datos suficientes para una resolución visible. La resolución confirmada genera una nueva operación; no reescribe el historial como si el conflicto nunca hubiese ocurrido.

## 9. Notificaciones entre instancias locales

Las notificaciones entre pestañas o instancias sirven para avisar que cambió un proyecto. No deben transportar manuscritos completos ni considerarse una fuente de verdad. Al recibir una notificación:

1. validar el identificador del proyecto;
2. invalidar las cachés locales relacionadas;
3. volver a consultar el almacenamiento durable;
4. manejar mensajes repetidos o perdidos sin corrupción;
5. no exponer contenido privado en el canal de notificaciones.

La ausencia de notificación no puede significar ausencia de cambios; se requieren lecturas durables y mecanismos de reconciliación.

## 10. Seguridad y privacidad

- Los permisos del proyecto se verifican en servidor, no solo en el cliente.
- No confiar en `projectId`, `deviceId`, `kind` o payload recibidos desde el cliente sin validarlos.
- No incluir contraseñas, tokens, secretos o datos de autenticación en la bandeja.
- Limitar tamaño y profundidad de payload en cliente y servidor.
- Evitar registrar contenido del manuscrito en logs de red o diagnóstico.
- Aplicar autorización por proyecto antes de devolver datos o confirmar operaciones.
- Mantener separación entre biblioteca personal y datos compartidos de un libro.
- Documentar exportación, eliminación y retención de datos antes de habilitar sincronización remota.

## 11. Pruebas y criterios de aceptación

Comandos definidos en `typescript/package.json`:

- `npm run typecheck`: comprobación TypeScript sin emitir archivos;
- `npm run build`: typecheck y build;
- `npm run validate:schema`: validación MLDB y auditoría del mapa físico;
- `npm test`: build, validaciones y suite Node;
- `npm run bench`: benchmark de edición en vivo.

Pruebas específicas agregadas en esta línea de trabajo:

- `tests/indexeddb-storage-health.test.mjs`: conteos, no mutación y contrato de capacidades del navegador;
- `tests/indexeddb-sync-outbox.test.mjs`: idempotencia, colisión, unicidad, orden, aislamiento, reintentos y acuse;
- `tests/narrative-knowledge-chronology.test.mjs`: resurrección explícita, evidencia obsoleta y contradicción sin evidencia;
- `tests/live-author-monitor-indexeddb.test.mjs`: migración de IndexedDB y preservación de almacenes anteriores;
- `test/mldb-schema-validation.test.mjs`: contrato del esquema MLDB.

Criterios mínimos antes de cerrar la entrega local:

- typecheck y build verdes;
- validador MLDB y auditoría de almacenes verdes;
- suite completa sin fallos;
- migración desde las versiones soportadas con datos reales de prueba;
- reintentos y colisiones de outbox probados en IndexedDB real;
- monitor de autoría y pruebas de varias pestañas sin regresiones;
- benchmark comparado con la rama base;
- documentación y código coherentes con la versión de esquema y de base.

Criterios adicionales antes de declarar sincronización remota terminada:

- pruebas de dos dispositivos independientes;
- caída antes/después de aceptación remota;
- reenvío idempotente;
- autenticación caducada y revocada;
- conflicto concurrente;
- recuperación tras pérdida de red;
- servidor que rechaza un payload inválido;
- acuse que solo se emite tras persistencia remota durable;
- verificación de que ninguna operación pendiente se pierde.

## 12. Estado de implementación al redactar este documento

| Capacidad | Estado |
|---|---|
| Persistencia narrativa local | Implementada en el adaptador TypeScript existente |
| Almacenes de biblioteca/relaciones y validaciones | Implementados en el núcleo; revisar cobertura al integrar anfitrión |
| Diagnóstico de almacenamiento | Implementado en IndexedDB |
| Solicitud de persistencia del origen | Implementada; decisión final del navegador |
| Bandeja local durable | Implementada en IndexedDB v25 |
| Idempotencia y reintentos locales de outbox | Implementados |
| Encolado automático de toda mutación de dominio | Pendiente de integración/verificación |
| Transporte remoto y autenticación | Pendiente |
| Servicio de sincronización del servidor | Pendiente |
| Descarga/reconciliación de cambios remotos | Pendiente |
| Resolución de conflictos multidispositivo | Pendiente |
| Pruebas E2E entre dispositivos reales | Pendiente |
| Exportación/restauración validada desde el anfitrión | Pendiente |

El CI de la rama ha mostrado fallos de typecheck y regresiones del monitor durante la integración de los cambios. Por tanto, este documento no declara que la rama esté validada ni que la entrega esté lista para fusionarse. El resultado final debe actualizar esta tabla con los enlaces y SHA de las ejecuciones verdes reales.

## 13. Secuencia de trabajo recomendada

1. estabilizar typecheck, pruebas y auditoría de esquema en la rama;
2. verificar que las mutaciones de documentos, entidades, relaciones e ideas produzcan operaciones outbox completas, con secuencia por dispositivo;
3. definir validadores y catálogo versionado de operaciones;
4. implementar el cliente de transporte como módulo independiente inyectado por el anfitrión;
5. implementar idempotencia, persistencia y control de secuencias en servidor;
6. añadir cursor de descarga y reconciliación;
7. diseñar conflictos tipados y resolución editorial explícita;
8. ejecutar pruebas de dos dispositivos y de recuperación ante fallos;
9. documentar el contrato del servidor y la guía de integración;
10. actualizar el estado de implementación y cerrar la entrega solo con CI verde.

---

**Regla de mantenimiento:** cada cambio en contratos, almacenes, índices, migraciones, protocolo o garantías debe actualizar este documento, el README del núcleo, el esquema MLDB y sus pruebas en el mismo cambio. No documentar como implementada una capacidad que solo esté propuesta.
