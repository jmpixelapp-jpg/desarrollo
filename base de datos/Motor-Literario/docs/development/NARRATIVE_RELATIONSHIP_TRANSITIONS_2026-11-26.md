# Descubrimiento de transiciones relacionales — 26 de noviembre de 2026

## Propósito
El descubrimiento de relaciones existente identifica vínculos nominales. Este módulo añade una capa distinta: detecta expresiones que narran cambios en esos vínculos. No modifica ni reemplaza la relación base.

## API
discoverNarrativeRelationshipTransitionCandidates devuelve candidatos con dos entidades explícitamente nombradas, familia relacional, tipo de transición, disparador y evidencias separadas para ambas entidades, el disparador y el contexto.

Familias iniciales: amistad, enemistad, matrimonio, confianza y alianza. Transiciones: formed, ended y reconciled. La cobertura léxica es acotada y ampliable mediante corpus y pruebas.

## Salvaguardas
- Requiere dos nombres/alias registrados en la misma oración y dentro de una ventana local máxima de 180 unidades.
- Los resultados son siempre candidatos; no alteran automáticamente el grafo.
- Conserva offsets UTF-16 absolutos y evidencia literal.
- Valida proyecto, IDs, alias, longitud de nombres, límites de texto, candidatos y presupuesto de exploración.
- Ante exceso de candidatos o presupuesto, lanza error y no devuelve una lista truncada.

## Interpretación
«Ana y Bruno se hicieron amigos» propone el inicio de una amistad; «Ana rompió su amistad con Bruno» propone su terminación; «se reconciliaron» propone reconciliación. Los rótulos describen el disparador textual, no prueban que el cambio sea objetivo, permanente o aceptado por ambos. El marco epistémico y la temporalidad global deben combinarse después desde los extractores correspondientes antes de consolidar una cronología relacional.

## Pruebas
Pruebas para inicio y ruptura de amistad, reconciliación, matrimonio, offsets Unicode, límites de oración, autorrelaciones, validación, exhaustividad y orden determinista. No se declara ejecución satisfactoria sin CI verificable.


## Corrección de orden y desambiguación

La búsqueda se reorganizó por oración: primero recoge las menciones explícitas de personajes y después localiza los disparadores de transición. Así admite tanto «Ana se casó con Bruno» como «Bruno y Ana se reconciliaron», sin exigir que el verbo aparezca entre los dos nombres ni que el orden de mención coincida con el orden gramatical del sujeto.

Si una misma forma nominal pertenece a más de una ficha de personaje, esa forma se excluye de la resolución automática para esa pasada. No se elige arbitrariamente una identidad. También se exige que las fichas de entrada sean de tipo \`character\`.

La ventana máxima de contexto sigue siendo de 180 unidades UTF-16. El presupuesto de exploración contabiliza la longitud de cada oración multiplicada por el número de nombres elegibles y por los patrones de transición inspeccionados. Se amplió la regresión para cubrir disparador posterior a ambos nombres, verbo antes de la segunda mención, orden inverso y colisión de nombres.


## Reducción de asociaciones incidentales

Cuando una oración menciona más de dos personajes, el extractor ya no genera todas las combinaciones posibles. Para cada disparador selecciona el par cuyo fragmento conjunto —dos menciones y disparador— ocupa la menor ventana textual, con desempate determinista por ID. Esto reduce falsos vínculos con personajes que solo aparecen como testigos o en una cláusula lateral. Sigue siendo una heurística de proximidad, no un análisis sintáctico; por ello los resultados permanecen como candidatos revisables.
