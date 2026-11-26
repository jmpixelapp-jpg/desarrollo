# Comparación de asimetrías de información narrativa

## Propósito

`narrative-information-asymmetry.ts` compara una señal explícita de desconocimiento de un personaje (`character-unaware-that`) con afirmaciones cognitivas de ese mismo personaje sobre la misma proposición literal. Su función es detectar tensiones para revisión, no decidir cuál afirmación es verdadera.

## Coincidencia

Se requiere el mismo proyecto, personaje, proposición normalizada y evidencia vigente. La normalización aplica Unicode NFC, minúsculas españolas, eliminación de puntuación y compactación de espacios. No resuelve paráfrasis, sinónimos, correferencia ni implicaturas. No usa exposiciones genéricas de secretos o verdades como si nombraran un personaje ignorante.

## Orden

Dentro del mismo documento y revisión se comparan los rangos de evidencia: antes, después o solapados. Entre documentos solo se compara si el proyecto proporciona un orden documental explícito, único y no ambiguo. La secuencia resultante no equivale a cronología diegética; `chronologyResolved=false` siempre.

## Interpretación

Los resultados son `candidate-tension-only`. Se conservan el tipo cognitivo y la polaridad original. Una afirmación de sospecha, creencia, recuerdo o negación no se equipara a conocimiento cierto. Ningún resultado certifica contradicción, mentira, engaño, error narrativo ni estado mental real. La focalización y el conocimiento efectivo del lector permanecen fuera del alcance de este comparador.

## Validación y límites

Valida proyecto, IDs únicos, tipos de exposición, rangos de evidencia vigentes y contenidos en el fragmento, y orden documental sin duplicados. Límites: 5.000 exposiciones, 10.000 afirmaciones cognitivas, 50.000 pares examinados y 5.000 resultados. El exceso produce error explícito; no hay truncamiento silencioso.

## Integración

Consume los resultados de `discoverNarrativeInformationExposureCandidates` y `discoverNarrativeCharacterKnowledgeCandidates`. Puede ejecutarse por capítulo sin orden global; para comparar capítulos, el orden debe venir del proyecto y no deducirse de nombres de archivo o IDs.
