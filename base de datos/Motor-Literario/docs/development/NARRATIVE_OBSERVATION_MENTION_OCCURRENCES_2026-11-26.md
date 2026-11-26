# Extracción exhaustiva de menciones de entidades en observaciones narrativas

Fecha: 2026-11-26

## Cambio

El descubridor de observaciones conserva ahora `entityMentionOccurrences`: todas las apariciones literales de nombres canónicos y alias reconocidos dentro de la frase que respalda cada acción.

El campo previo `entityMentionEvidence` se mantiene sin cambios para compatibilidad y sigue representando la primera mención de cada entidad.

## Reglas de extracción

- Se usa coincidencia Unicode con límites de palabra para evitar nombres incrustados dentro de otras palabras.
- Se registran todas las apariciones, no solo la primera.
- Los alias de una misma entidad que cubren exactamente el mismo intervalo se deduplican.
- Si dos entidades diferentes comparten un alias, ambas menciones se conservan. La colisión no se resuelve por orden ni se fusionan las entidades.
- Cada aparición conserva documento, revisión, offsets absolutos UTF-16 y fragmento literal.
- Se limita a 20.000 menciones por frase; superar el límite produce un error explícito en vez de truncar silenciosamente los resultados.
- La presencia de una entidad no asigna sujeto, agente, objeto ni causalidad.

## Cobertura de pruebas

Se añaden pruebas para menciones repetidas con offsets exactos y colisiones de alias entre entidades. Las pruebas no elevan automáticamente estas menciones a relaciones semánticas.

## Siguiente mejora

La extracción de todas las menciones proporciona una base más completa para resolver correferencias y roles a nivel de oración/párrafo. La siguiente etapa debe considerar contexto discursivo, concordancia, distancia, competencia entre antecedentes y cambios de escena, manteniendo hipótesis alternativas cuando no exista evidencia suficiente.
