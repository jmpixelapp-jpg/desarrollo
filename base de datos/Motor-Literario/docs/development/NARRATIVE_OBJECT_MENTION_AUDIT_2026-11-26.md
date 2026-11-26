# Auditoría de cobertura de menciones de objetos

## Objetivo

`auditNarrativeObjectMentionCoverage` compara todas las menciones explícitas de entidades `object` recogidas por observaciones con las evidencias de objeto de las transiciones extraídas.

## Resultados

- `transition-evidence-matched`: una transición coincide con la misma entidad y el mismo fragmento.
- `object-mention-without-transition`: hay mención explícita, pero ninguna transición enlazada con evidencia idéntica.
- `ambiguous-transition-match`: más de una transición coincide con esa mención.

Cada salida conserva documento, revisión, offsets, extracto, observación y transiciones coincidentes.

## Interpretación

Un hueco es una oportunidad de revisar la extracción, no prueba de que el objeto no haya cambiado de estado. La identidad de entidad por sí sola no basta: se exige coincidencia exacta de entidad y rango probatorio. Tampoco se resuelven pronombres ni descripciones no enlazadas previamente a una entidad.

## Límites

Texto máximo 2 millones de unidades UTF-16; 20.000 observaciones y transiciones; 50.000 menciones de objeto. Los offsets pueden expresarse con `baseOffset`.
