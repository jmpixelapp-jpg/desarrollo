# MLDB 0.2.0 — reglas de integridad y migración

**Estado:** esquema corregido; especificación de implementación. No es todavía un motor de almacenamiento.

## 1. Invariantes obligatorios

1. Toda fila perteneciente a un proyecto tiene `project_id` obligatorio.
2. Toda referencia entre tablas de ámbito proyecto se resuelve mediante una clave foránea compuesta que incluye `project_id`.
3. El motor rechaza referencias cuyo padre exista con otro `project_id`, aunque el identificador global coincida.
4. Los datos globales de identidad de proyecto no contienen contenido narrativo.
5. La reutilización entre libros no crea relaciones directas: exige una autorización explícita del escritor y una operación de importación registrada.
6. El motor no cambia el manuscrito.
7. Los estados y etiquetas narrativas solo cambian mediante una operación autorizada del escritor.

## 2. Cambios del esquema 0.1 a 0.2

- Se exige `project_id NOT NULL` en todas las tablas de ámbito proyecto.
- Se declaran claves únicas compuestas `(project_id, id)` para que puedan ser destino de referencias compuestas.
- Se reemplazan las referencias simples por referencias compuestas que llevan el `project_id` del registro hijo.
- Se declaran referencias de proyecto para todas las tablas de ámbito proyecto.
- Se agregan referencias compuestas para documentos, fragmentos, registros, relaciones, líneas temporales, perfiles lingüísticos y sugerencias.
- Se elimina la referencia polimórfica no verificable `evidences.subject_id`. Ahora una evidencia identifica un registro o una relación mediante dos columnas tipadas y una regla XOR: exactamente una puede estar informada.
- Se explicitan las referencias de `import_authorizations` a los proyectos origen y destino.

## 3. Reglas de integridad que debe ejecutar el motor

La validación se realiza dentro de la transacción, antes de confirmar:

- existencia de todos los padres referenciados;
- igualdad obligatoria de `project_id` en padre e hijo;
- unicidad de claves primarias y compuestas;
- validez de etiquetas y estados;
- exactamente un sujeto tipado por evidencia;
- pertenencia del fragmento al documento y del padre al mismo proyecto;
- ausencia de ciclos en la jerarquía de fragmentos;
- pertenencia de evento y línea temporal al mismo proyecto;
- pertenencia de una sugerencia al documento/fragmento de su proyecto;
- autorización del escritor para cambios de estado, etiqueta e importaciones.

Si falla una sola regla, se revierte la transacción completa. No se permite confirmar parcialmente.

## 4. Protección de las decisiones del escritor

Una petición del motor no puede elevar sus propios permisos. La autorización debe derivarse de la identidad/capacidad de la sesión autenticada por el anfitrión y verificarse dentro de la transacción. Un campo booleano enviado por el cliente no es prueba de autorización.

Las operaciones originadas por el motor pueden proponer cambios y añadir evidencias, pero no alterar `state` ni `label` sin una confirmación explícita del escritor en esa misma operación transaccional.

## 5. Migración de MLDB 0.1

La migración nunca modifica el archivo original en el lugar.

1. Abrir el contenedor en modo lectura y validar firma, longitud, UTF-8, JSON y versiones.
2. Crear una copia de seguridad byte por byte y verificarla.
3. Cargar el esquema y los datos existentes en un área de migración aislada.
4. Comprobar cada referencia simple de 0.1 y resolverla dentro del mismo proyecto.
5. Si una referencia es ambigua, huérfana o cruza proyectos, detener esa migración y producir un informe; no adivinar propietario ni destino.
6. Convertir cada evidencia polimórfica solo si existe exactamente un destino válido del tipo declarado y dentro del mismo proyecto.
7. Construir la estructura 0.2 en un archivo temporal.
8. Validar todas las restricciones y el checksum del resultado.
9. Confirmar el cambio de forma atómica y conservar el original y la copia de seguridad.
10. Registrar versión origen/destino, resultado, fecha y checksum.

La base inicial actual está vacía, por lo que no hay contenido narrativo que migrar. La migración debe, aun así, preservar el esquema y los metadatos originales.

## 6. Estado real

| Componente | Estado |
|---|---|
| Documento Maestro v0.2 | Especificado; preservado sin cambios |
| Esquema MLDB v0.1 | Prototipo inicial |
| Esquema MLDB v0.2 | Corregido en estructura y referencias |
| Motor de almacenamiento propio | Pendiente de implementación |
| Transacciones y recuperación | Pendiente de implementación y pruebas |
| Índices físicos y consultas | Pendiente |
| Migrador ejecutable 0.1 → 0.2 | Pendiente |
| Pruebas automatizadas de aislamiento | Pendientes de ejecución en el motor |

**Prohibición vigente:** no almacenar manuscritos reales hasta que el motor propio y sus pruebas de integridad, transacciones, recuperación y concurrencia estén implementados y superados.
