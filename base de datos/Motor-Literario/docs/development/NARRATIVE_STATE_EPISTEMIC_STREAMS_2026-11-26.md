# Flujos epistémicos de estados de personajes

## Objetivo

Evitar que el motor mezcle en una misma trayectoria una condición afirmada por la voz narradora con una condición que un personaje cree, recuerda, desea o transmite mediante discurso referido.

## Cambios

- Los candidatos de estado conservan `epistemicFrame` y la evidencia literal del marcador.
- En discurso referido se propone una fuente solo cuando una mención de personaje anterior al marcador es inequívoca.
- Las trayectorias se particionan por personaje, estado, documento, revisión, marco epistémico y fuente explícita.
- Las transiciones resultantes conservan la perspectiva y las evidencias epistémicas anterior y actual.
- No se deduce cronología entre documentos ni se eleva una creencia a hecho objetivo.

## Límites

La clasificación es léxica y local. No resuelve estilo indirecto libre, alcance de negación complejo, pronombres como fuente, ironía ni conocimiento efectivo de un personaje. Los patrones requieren una mención nominal explícita para atribuir el estado; no deben interpretarse como análisis sintáctico completo.

## Pruebas añadidas

Se cubren la separación narrador/creencia, la atribución de discurso referido, la ausencia de emisor en construcciones impersonales y la reconstrucción aislada de transiciones dentro de una misma perspectiva.
