# Actualización incremental del grafo narrativo

## API

El módulo `typescript/src/narrative-knowledge-graph-incremental.ts` añade:

- `createNarrativeKnowledgeGraphSnapshot(projectId, documents, options)`
- `updateNarrativeKnowledgeGraphSnapshot(previous, documents, options)`

Un snapshot conserva en memoria una contribución por documento y el grafo agregado. La actualización compara identidad documental, revisión, texto y offset. Reutiliza la contribución cuando los cuatro elementos no han cambiado; vuelve a ejecutar extractores solo para documentos nuevos o modificados, y elimina contribuciones de documentos retirados.

## Resultado de actualización

La función devuelve el snapshot nuevo y tres listas ordenadas:

- `reusedDocumentIds`: contribuciones reutilizadas sin extracción.
- `rebuiltDocumentIds`: documentos que se analizaron de nuevo.
- `removedDocumentIds`: documentos retirados del snapshot.

El agregado vuelve a calcular las señales de consistencia a partir de todas las afirmaciones vigentes del snapshot. Esto es necesario porque una edición en un capítulo puede cambiar la relación temporal entre afirmaciones de capítulos distintos.

## Invalidación

Se reconstruyen las contribuciones cuando cambia:
- el número de revisión;
- el contenido textual, incluso si por error no cambió la revisión;
- el offset base;
- el nombre de proyecto de origen utilizado por el extractor de ideas.

El ID de proyecto no puede cambiar durante una actualización: un proyecto distinto requiere crear un snapshot nuevo.

## Memoria, seguridad y límites

El snapshot retiene el texto de los documentos en memoria para comparar cambios exactos. No lo escribe en IndexedDB, no lo transmite y no debe persistirse sin una decisión explícita de privacidad/retención. La API no es un sustituto de la persistencia del proyecto.

La consolidación final combina contribuciones ya calculadas. La extracción lexical se limita a documentos invalidados, pero la agregación y el análisis global de consistencia recorren el conjunto de contribuciones. Esto evita afirmar que toda la operación es O(1) ante una edición.

## Validación

`tests/narrative-knowledge-graph-incremental.test.mjs` cubre reutilización, revisión modificada, retirada de documentos, cambios de texto/offset, invalidación por nombre de proyecto y entradas inválidas.
