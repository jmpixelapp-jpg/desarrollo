# Endurecimiento de marcos epistémicos en observaciones — 26 de noviembre de 2026

## Objetivo

Las observaciones narrativas no deben confundirse con hechos objetivos. La extracción distingue narración afirmada, creencia, memoria, deseo, discurso referido e hipótesis, y conserva evidencia del marcador textual.

## Correcciones

- Se reconstruyó la función de clasificación del marco epistémico y de atribución del emisor. La implementación conserva el marcador y, para discurso referido, busca la mención explícita de personaje más próxima antes del marcador.
- Se corrigieron los límites léxicos de las expresiones regulares: los marcadores ahora usan límites de palabra y espacios reales, no secuencias de barra invertida literales. Esto permite detectar «Ana pensó que Bruno llegó» y evita confundir coincidencias dentro de otras palabras.
- Si varias fichas distintas quedan igualmente próximas al marcador, no se asigna un emisor.
- La clasificación sigue siendo una señal textual local; no prueba que el contenido referido sea verdadero ni resuelve ironía, narrador no fiable o discurso indirecto libre.

## Regresión

Se mantienen pruebas para creencia, memoria, deseo, discurso referido, hipótesis, emisor explícito, ausencia de emisor y ambigüedad de atribución. Se agregan pruebas para límites léxicos y coincidencias parciales.

## Alcance pendiente

La próxima integración debe aplicar el mismo marco epistémico a candidatos de transición relacional, sin copiar ni consolidar automáticamente afirmaciones de personajes como hechos del mundo narrativo. También debe distinguir negación, modalidad e incertidumbre con evidencia independiente.
