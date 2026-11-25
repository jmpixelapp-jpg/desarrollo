# Esquema inicial de conocimiento narrativo — v0.1

**Estado:** estructuras y persistencia implementadas; extracción automática y compilación aún no verificadas.  
**Ámbito:** cada registro se escribe y consulta con el `project_id` que entrega el anfitrión.  
**Codificación:** binaria versionada, UTF-8, longitudes explícitas little-endian. Cada campo de texto admite hasta 1 MiB y cada registro hasta 8 MiB.  
**Almacenamiento:** tablas separadas en un ProjectStore local de conocimiento, independiente del diario de cambios del editor.

## Tablas

| Tabla | Clave | Contenido |
|---|---|---|
| `narrative.entity.v1` | entity_id | Nombre canónico, tipo, atributos y estado |
| `narrative.relation.v1` | relation_id | sujeto, predicado, objeto y estado |
| `narrative.event.v1` | event_id | etiqueta, orden cronológico opcional y estado |
| `narrative.evidence.v1` | evidence_id | destino, documento, revisión, offsets, extracto y procedencia |
| `narrative.fragment_analysis.v1` | analysis_id | documento, revisión, rango UTF-8, métricas descriptivas y palabras repetidas con offsets |

## Métricas de fragmento

Los conteos actuales son descriptivos y deterministas: character_count cuenta valores escalares Unicode (no grafemas visuales); word_count usa la tokenización básica del motor; long_word_count considera largas las palabras con más de 12 caracteres alfanuméricos; average_word_length_milli es la longitud media de palabra multiplicada por 1.000. Los decimales con punto y apóstrofos internos se conservan como parte del token; los guiones se eliminan solo en la forma normalizada. No hay normalización Unicode canónica ni análisis morfológico por idioma.

## Estados

- `proposed`: hipótesis o extracción aún no confirmada.
- `confirmed`: confirmada por el proceso autorizado del proyecto.
- `rejected`: descartada; no debe tratarse como hecho.
- `superseded`: reemplazada por una versión o dato posterior.

El almacenamiento no promueve estados automáticamente ni infiere confirmación a partir de frecuencia textual.

## Procedencia y evidencia

Cada evidencia referencia un `target_kind` (entity, relation o event), `target_id`, `document_id`, `revision`, `start_byte`, `end_byte`, `excerpt` y `source_kind`. Los offsets son bytes UTF-8 dentro de la revisión indicada; no son índices UTF-16 ni posiciones visuales.

La capa actual valida que start_byte no supere end_byte, pero no puede comprobar el rango contra el documento porque el manuscrito pertenece al anfitrión y no se almacena en esta base. El anfitrión/analizador deberá validar la revisión y el extracto antes de crear la evidencia.

## API

`NarrativeKnowledgeStore` ofrece escritura y lectura individual de entidades, relaciones, eventos, evidencias y análisis de fragmentos, eliminación explícita de métricas de fragmento obsoletas y enumeración de IDs por tabla (hasta 50.000 por respuesta; la paginación queda pendiente). `HostEngineApi::open_with_knowledge` permite abrir el motor con una base narrativa dedicada. JSON-RPC añade put/get y listado para entidades, relaciones, eventos, evidencias y análisis de fragmentos; `initialize` habilita esos métodos solo cuando recibe ambas rutas locales de conocimiento.

## Límites conocidos

- No existe extracción automática desde el texto.
- No existe todavía historial de versiones/auditoría de cambios de cada registro; un upsert reemplaza la fila actual.
- Las relaciones solo se guardan si existen sus entidades sujeto y objeto; las evidencias solo se guardan si existe el destino referenciado. Antes de persistir una evidencia, el worker comprueba en la revisión viva exacta que los offsets sean límites UTF-8 válidos y que el extracto coincida byte por byte con el texto; la validación no clona el manuscrito.
- Las evidencias no se invalidan ni reubican automáticamente cuando cambia la revisión del documento; el analizador deberá detectar evidencia obsoleta y proponer reanclaje.
- Las métricas de fragmento se guardan como observaciones de una revisión concreta; no sustituyen el manuscrito ni se consideran conocimiento semántico.
- No hay resolución de alias, identidad de personajes, canon, cronología inferida, contradicciones ni certeza probabilística.
- No hay biblioteca de ideas ni transferencia de ideas no utilizadas.
- Los datos son locales y separados por project_id; no se envían a terceros.
- No usar con manuscritos reales hasta compilar y ejecutar las pruebas en los sistemas objetivo.

