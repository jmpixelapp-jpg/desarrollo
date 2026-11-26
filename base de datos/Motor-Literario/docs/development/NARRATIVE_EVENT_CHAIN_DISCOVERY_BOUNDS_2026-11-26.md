# Límites de reconstrucción de cadenas de acontecimientos — 26 de noviembre de 2026

El reconstruidor de cadenas ordena las observaciones y compara acciones adyacentes para encontrar conectores temporales, causales o de contraste. La entrada validaba cada observación, pero no acotaba el tamaño del array antes de ordenarlo.

Se añade `MAX_NARRATIVE_EVENT_CHAIN_OBSERVATIONS = 10_000`. Las entradas que exceden el límite se rechazan antes de recorrer, validar o ordenar la colección. Se conserva el límite de 500 enlaces emitidos y el hueco máximo de 5.000 unidades UTF-16 entre acciones.

La restricción evita que una colección arbitrariamente grande fuerce ordenaciones y validaciones costosas. Los enlaces continúan siendo candidatos textuales: un conector causal no demuestra por sí solo causalidad real.
