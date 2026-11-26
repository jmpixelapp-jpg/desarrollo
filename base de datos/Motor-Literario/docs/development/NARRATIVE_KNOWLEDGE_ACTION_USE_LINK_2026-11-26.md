# Enlace entre conocimiento y acción

## Objetivo

`narrative-knowledge-action-use-link.ts` identifica pasajes en los que una acción aparece dentro de una oración con un marcador explícito de conocimiento o memoria y la misma proposición que una afirmación cognitiva previa. Es una relación contextual candidata, no una explicación causal.

## Evidencia requerida

- Afirmación cognitiva explícita, afirmada y no incierta.
- Titular del conocimiento idéntico al sujeto gramatical activo explícito de la acción.
- La oración de acción contiene un marcador («sabiendo que», «consciente de que», «recordando que», «sin olvidar que»).
- La proposición del candidato aparece literalmente normalizada después del marcador.

La proximidad entre una afirmación de conocimiento y una acción no basta. Tampoco bastan pronombres, sujeto omitido, sujeto pasivo, creencias inciertas ni afirmaciones negadas.

## Interpretación

El enlace significa únicamente que el texto sitúa una acción en un contexto explícito de conocimiento. No demuestra que el personaje utilizara deliberadamente esa información, que la información causara la acción, que el personaje actuara racionalmente ni que la proposición sea verdadera. Los campos `knowledgeUseEstablished` y `actionCausationEstablished` permanecen en `false`.

## Límites

10.000 afirmaciones cognitivas, 10.000 observaciones, 50.000 parejas examinadas y 5.000 enlaces. Todas las evidencias deben pertenecer al documento y revisión de su candidato y conservar offsets y extractos coherentes.
