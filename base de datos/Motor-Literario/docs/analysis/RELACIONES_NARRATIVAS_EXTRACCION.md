# Extracción conservadora de relaciones narrativas

**Implementación:** `typescript/src/narrative-relationship-discovery.ts`  
**Exportación:** `typescript/src/index.ts`  
**Fecha:** 26 de noviembre de 2026

## Propósito

Recuperar candidatos de relaciones explícitas entre personajes a partir del texto del manuscrito, sin convertir automáticamente las detecciones en hechos confirmados ni alterar fichas persistentes.

## Contrato de extracción

Cada candidato conserva:
- Proyecto, documento y revisión de origen.
- Entidades de origen y destino y tipo relacional normalizado.
- Expresión relacional y tres evidencias independientes: relación, origen y destino.
- Rangos UTF-16 absolutos, aplicando `baseOffset`.
- Estado de ambigüedad y estado editorial `candidate`.

Las relaciones iniciales contemplan parentesco parental, filiación, hermandad, matrimonio, amistad, enemistad y acompañamiento. La dirección se conserva; no se generan hechos inversos implícitos.

## Resolución y abstención

Se aceptan construcciones nominales explícitas entre dos entidades. Los descriptores como «el hermano» solo pueden vincularse a una entidad cuando existe un perfil descriptivo validado y con evidencia vigente. Los posesivos sin antecedente resuelto se excluyen.

No se infieren relaciones por apellidos, proximidad textual, convivencia, género ni plausibilidad narrativa. Los perfiles con evidencia obsoleta no autorizan asociaciones. Cuando varios personajes respaldados pueden explicar el mismo descriptor y destino, todos los candidatos afectados se marcan como ambiguos.

## Identidad y determinismo

El identificador del candidato incorpora documento, revisión, rango de la expresión, entidades de origen y destino y tipo de relación. Así, candidatos distintos que comparten fragmento y destino no colisionan. El orden de entrada de las entidades no debe alterar los identificadores ni el orden canónico de salida.

## Límites operativos

- Texto máximo: 2.000.000 unidades UTF-16.
- Resultados por defecto: 1.000.
- Máximo configurable: 3.000.
- Las entidades deben ser únicas y pertenecer al proyecto indicado.
- Los perfiles deben referir entidades del mismo conjunto y no duplicarse por entidad.

## Pruebas

La suite cubre relaciones nominales, perfiles descriptivos, posesivos no resueltos, perfiles ausentes u obsoletos, autorrelaciones, offsets Unicode, aislamiento de proyecto, perfiles duplicados, límites, ambigüedad, dirección parental e identidad única y determinista.

## Límites conocidos y trabajo siguiente

La extracción es deliberadamente conservadora y basada en patrones explícitos. No constituye análisis sintáctico completo ni resolución general de correferencias. Próximas mejoras deben priorizar:
1. Validación de límites y offsets de la evidencia de perfiles antes de confiar en ellos.
2. Cobertura de variantes morfológicas y construcciones relacionales sin ampliar falsos positivos.
3. Resolución de referencias pronominales solo cuando el módulo de correferencia entregue un antecedente inequívoco y evidencia trazable.
4. Integración incremental con el grafo narrativo, manteniendo candidatos separados de relaciones confirmadas.
5. Pruebas de precisión/recuperación con corpus anotados y casos negativos, sin presentar métricas no medidas.

**Validación:** la modificación del identificador y su regresión se han registrado en `main`; la suite completa y CI deben confirmarse por separado antes de declarar el cambio validado.
