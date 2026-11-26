# Descubrimiento de identidades candidatas de objetos

## Propósito

`discoverNarrativeObjectIdentityCandidates` compara perfiles descriptivos revisados de objetos distintos. Cuando dos fichas comparten una etiqueta descriptiva literal normalizada, propone una hipótesis de identidad para revisión humana.

Ejemplo: una ficha registra «el arma legendaria» en un capítulo y otra ficha registra «El arma legendaria» en otro. Se conserva la evidencia de ambas procedencias y se propone revisar si representan el mismo objeto.

## Ambigüedad y límites semánticos

- Una descripción compartida por dos fichas produce una hipótesis de par.
- Si tres o más fichas comparten la descripción, cada par queda marcado como ambiguo y se conserva el conjunto completo de entidades implicadas.
- No se deducen sinónimos, atributos equivalentes, continuidad física ni identidad por similitud textual.
- No se fusionan entidades ni se modifica el grafo.
- Las etiquetas obsoletas se excluyen.

## Evidencia y operación

Cada resultado conserva las dos evidencias históricas, la descripción normalizada y todos los IDs que comparten la etiqueta. La coincidencia es una señal para revisión, no una afirmación ontológica.

Límites: 10.000 entidades, 10.000 perfiles, 100 etiquetas por perfil, 50.000 etiquetas agregadas y 20.000 candidatos. La entrada debe pertenecer a un único proyecto.
