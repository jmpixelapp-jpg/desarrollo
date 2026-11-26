# Atribución prudente de discurso referido — 26 de noviembre de 2026

## Objetivo
Separar el contenido comunicado del personaje que potencialmente lo enuncia. Una acción dentro de «Ana dijo que Bruno llegó» no debe convertirse en un hecho confirmado ni atribuirse a Bruno como hablante.

## Cambio
Las observaciones bajo el marco `reported-speech` pueden incluir `epistemicSourceCandidate`, con:
- ID de una entidad de personaje conocida.
- Evidencia literal de su mención anterior al marcador de discurso.
- Documento, revisión y offsets absolutos.

El emisor se propone solo cuando la mención de personaje más próxima al marcador es inequívoca. En ausencia de emisor conocido o ante empate entre entidades distintas, el campo se omite.

## Límites
Es una heurística local: no resuelve diálogos con guiones, comillas, turnos sin verbo dicendi, discurso indirecto libre, citas anidadas ni atribución entre oraciones. La entidad es un emisor candidato, no una voz confirmada. La frase subordinada permanece como contenido referido, no como hecho objetivo.

## Regresión
Se añaden casos para emisor explícito, construcción impersonal sin emisor y atribución ambigua. Se comprueban los offsets de evidencia.
