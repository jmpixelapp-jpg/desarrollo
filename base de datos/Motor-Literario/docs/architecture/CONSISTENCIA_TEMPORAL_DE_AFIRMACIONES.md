# Consistencia temporal de afirmaciones narrativas

## Objetivo

Comparar observaciones explícitas extraídas del manuscrito sin convertir cambios de continuidad legítimos en errores automáticos. El módulo `typescript/src/narrative-consistency.ts` expone `analyzeNarrativeConsistency`.

## Contrato de comparación

La unidad de comparación es la tupla proyecto + entidad + atributo. Solo se comparan afirmaciones vigentes (la evidencia marcada `stale` queda fuera) y con valores diferentes. Cada hallazgo conserva dos evidencias completas y una explicación legible.

| Clasificación | Condición | Interpretación |
| --- | --- | --- |
| `same-time-conflict` | Mismo calendario/contador, misma precisión y mismo valor ordinal temporal | Candidato a contradicción simultánea; requiere revisión |
| `temporal-change` | Ambas referencias comparten escala y tienen distinto orden | Cambio potencialmente legítimo entre momentos |
| `time-incomparable` | Falta tiempo, las escalas difieren o la precisión no coincide | No hay base suficiente para decidir |

## Reglas de prudencia

- No se infiere cronología a partir del orden de capítulos, posición de párrafos o tiempo verbal.
- Calendario y contador de día narrativo son escalas independientes.
- Un año y una fecha concreta no se consideran el mismo instante aunque compartan ordinal de inicio.
- No se elige un valor canónico ni se modifica la historia; el resultado es una señal explicable para el autor.
- La salida es determinista para el mismo conjunto de afirmaciones y conserva la procedencia de ambas pruebas.

## Complejidad y límites

La comparación por pares es cuadrática dentro de cada grupo entidad/atributo. Conviene agrupar y filtrar antes de comparar; si los manuscritos generan historiales masivos, una futura optimización podrá particionar por referencia temporal sin cambiar el contrato.

El módulo solo procesa afirmaciones tipadas como edad, ubicación y rol que ya hayan sido extraídas. No resuelve negación compleja, ironía, paráfrasis ni identidad ambigua. No sustituye la revisión editorial.

## Pruebas

`tests/narrative-consistency.test.mjs` cubre simultaneidad, evolución, precisión desigual, escalas incompatibles, ausencia de fecha, aislamiento de proyecto, evidencia obsoleta y validación de entradas.
