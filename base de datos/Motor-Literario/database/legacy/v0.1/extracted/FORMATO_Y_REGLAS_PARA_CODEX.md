# Formato inicial MLDB v1

## Estado
Este archivo es una **base principal inicial de esquema**, no un motor de almacenamiento transaccional ya implementado. Contiene las definiciones versionadas y no contiene proyectos ni contenido de escritores.

## Estructura binaria
1. 8 bytes de firma: `MLDB\r\n\x1a\n`.
2. 4 bytes: longitud del payload JSON, entero sin signo little-endian.
3. Exactamente esa cantidad de bytes: JSON UTF-8 autocontenido con el esquema y metadatos.

El archivo debe rechazarse si la firma no coincide, si la longitud excede el tamaño disponible, si hay truncamiento, si el JSON no es válido o si la versión de formato/esquema no está soportada.

## Reglas obligatorias para Codex
- No sustituir, reiniciar ni recrear esta base principal.
- Implementar lectura y validación de este formato antes de cualquier escritura.
- Conservar `schema_version` y `container_version`.
- No aplicar migraciones destructivas automáticamente.
- Crear copia de seguridad antes de cualquier migración.
- No crear un proyecto inicial: el anfitrión suministra `project_id` y nombre.
- Validar claves foráneas y aislamiento por `project_id`.
- Los registros narrativos tienen exactamente `abierto`/`cerrado` como estados y `IDEA`/`REGISTRADO EN LA OBRA` como etiquetas.
- Los cambios históricos completos van a la base histórica separada.
- Las tablas especializadas de idiomas y diccionarios no se duplican aquí; esta base conserva referencias.
- No interpretar el archivo como SQLite ni como otro formato de terceros.

## Limitación importante
El contenedor entregado define el esquema inicial y su serialización de arranque. No proporciona por sí solo transacciones ACID, índices físicos, recuperación ante fallos, bloqueo concurrente, páginas de datos ni motor de consultas. Esas capacidades deben ser implementadas y probadas por Codex conforme al diseño aprobado, antes de usar esta base en producción.
