# Grafo unificado de conocimiento narrativo

## Propósito

`typescript/src/narrative-knowledge-graph.ts` reúne en una sola vista de proyecto los resultados de los extractores existentes: entidades, relaciones, acontecimientos, ideas y afirmaciones. También calcula señales de consistencia de afirmaciones.

## API

`buildNarrativeKnowledgeGraph(projectId, documents, options)` recibe documentos identificados por `documentId`, `revision` y texto. Admite `baseOffset` para ventanas de texto y las opciones `sourceProjectName` y `now`.

La salida contiene:
- revisiones documentales procesadas, ordenadas por ID y revisión;
- entidades consolidadas por identidad estable, con evidencia combinada;
- relaciones explícitas entre entidades reconocidas;
- eventos declarados mediante `EVENTO:` o `ACONTECIMIENTO:`;
- ideas marcadas explícitamente con `IDEA:`;
- afirmaciones tipadas de edad, ubicación y rol;
- hallazgos de consistencia temporal derivados de las afirmaciones.

## Reglas de integridad

- Todos los extractores reciben el mismo `projectId`; no se mezclan datos de otros proyectos.
- Se exige una única revisión seleccionada por `documentId` en cada construcción. Si se entregan dos revisiones del mismo documento, se rechaza la entrada: no se mezclan snapshots ni se adivina cuál es la versión vigente.
- Los offsets siguen siendo UTF-16 absolutos y respetan `baseOffset`.
- El tiempo de extracción se calcula una vez por construcción y se propaga a las ideas, evitando marcas temporales distintas entre documentos de una misma ejecución.
- Los resultados se ordenan por identidad para facilitar comparación y pruebas.
- No se inventan relaciones ni eventos a partir de proximidad textual; se mantienen las condiciones explícitas de cada extractor.

## Alcance y límites

El grafo es una vista calculada en memoria. No persiste cambios, no selecciona automáticamente revisiones canónicas, no resuelve identidades ambiguas y no sincroniza dispositivos. El llamador debe proporcionar las revisiones que considere pertinentes. Los extractores siguen siendo lexicales y conservadores; cada resultado conserva evidencia para revisión editorial.

La consistencia temporal es una señal, no una decisión editorial. Para sincronización remota todavía hacen falta transporte, autenticación/autorización, API versionada, idempotencia, reintentos y reconciliación de conflictos.

## Validación

`tests/narrative-knowledge-graph.test.mjs` comprueba composición de tipos de conocimiento, consolidación de evidencias, orden de documentos, offsets absolutos y validación de entradas.
