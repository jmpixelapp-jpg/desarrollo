# Secuenciación de afirmaciones de conocimiento

## Propósito

`narrative-character-knowledge-timeline.ts` agrupa afirmaciones cognitivas extraídas y les asigna una posición textual. No resuelve la cronología diegética ni convierte una fecha relativa en fecha absoluta.

## Asociación temporal

Una referencia temporal solo se adjunta si pertenece al mismo proyecto, documento y revisión y su evidencia completa está contenida en el fragmento de evidencia de la afirmación cognitiva. No se propagan anclas entre frases, capítulos o revisiones. Si hay más de una referencia temporal en el mismo fragmento, el módulo evita elegir arbitrariamente y deja la asociación sin resolver.

## Orden de lectura

El orden entre documentos solo se considera explícito si el proyecto entrega `documentOrder`, con identificadores y posiciones únicas. Sin ese dato, se ordena por ID documental, revisión y offset local; esto es un orden técnico determinista, no una afirmación sobre el orden narrativo de los capítulos. Dentro de un documento, el offset establece orden textual, no necesariamente orden de los acontecimientos narrados.

## Integridad

Se validan proyecto, identificadores, revisión, rangos UTF-16, longitud del excerpt y contención de evidencias auxiliares dentro del fragmento principal. Los límites son 10.000 candidatos, 20.000 referencias temporales y 5.000 documentos en el orden explícito.

## Salida y límites

Cada entrada conserva el candidato original, la evidencia y la referencia temporal explícita opcional. `chronologyResolved` permanece en `false`: la capa no deduce qué ocurrió antes en la historia a partir del orden de exposición. Tampoco concluye que un personaje desconoce una proposición cuando no aparece una señal de conocimiento.

## Continuación

La siguiente integración deberá comparar proposiciones con criterios lingüísticos revisables, distinguir cambios de creencia de adquisición de datos y enlazar las secuencias con eventos narrativos explícitos sin fusionar perspectivas incompatibles.
