# Comparación de afirmaciones sobre acciones narrativas

Fecha: 2026-11-26

## Alcance

Se incorpora `compareNarrativeActionClaims` para localizar desacuerdos de polaridad entre observaciones de acciones. Es una capa posterior a la extracción: no vuelve a leer el manuscrito ni sustituye el análisis sintáctico.

## Criterios estrictos de emparejamiento

Solo se comparan observaciones del mismo proyecto que comparten:
- sujeto gramatical activo explícito e idéntico por ID de entidad;
- lema verbal extraído idéntico;
- tiempo gramatical idéntico;
- objeto explícito idéntico, o ausencia de objeto en ambas.

No se equiparan sujetos pasivos, personajes meramente mencionados, pronombres sin resolver, verbos sinónimos ni objetos omitidos con objetos expresos. Las evidencias deben estar vigentes, tener offsets coherentes y pertenecer al mismo documento/revisión que la observación.

## Interpretación

Una pareja afirmada/negada produce `polarity-disagreement-candidate`, nunca una contradicción confirmada. Se marca:
- `same-epistemic-frame`: mismo marco y misma fuente candidata (o ausencia de fuente);
- `different-epistemic-frame`: marco o fuente distintos; debe tratarse como posible diferencia de perspectiva.

La implementación no contiene todavía una resolución temporal de estas acciones. Por ello, incluso el mismo marco epistémico no demuestra que ambas frases describan el mismo instante: la revisión humana debe comprobar cronología, alcance, correferencias y contexto. No se elige una versión canónica ni se descarta evidencia.

## Límites y protección

- Máximo 10.000 observaciones de entrada.
- Máximo 2.000 discrepancias devueltas; la salida se ordena por ID para hacerla determinista.
- IDs duplicados, proyecto ajeno, polaridad inválida y evidencias obsoletas o incoherentes provocan error.
- Las dos pruebas completas se conservan en cada resultado.

## Pruebas añadidas

Se cubren discrepancia afirmada/negada, diferencia de marco epistémico, sujetos ambiguos, objetos no equivalentes y validación de identidad/evidencia. La ejecución de CI no se da por confirmada hasta disponer de un resultado de workflow.
