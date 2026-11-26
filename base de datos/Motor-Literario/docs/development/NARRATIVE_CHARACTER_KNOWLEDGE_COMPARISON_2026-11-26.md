# Comparación de afirmaciones de conocimiento de personajes

## Objetivo

El módulo `narrative-character-knowledge-comparison.ts` localiza discrepancias y cambios de estado cognitivo candidatos cuando el mismo personaje aparece asociado a la misma proposición literal. La salida es evidencia para revisión editorial, no un veredicto psicológico o factual.

## Comparación conservadora

La clave de proposición aplica NFC, minúsculas en español, eliminación de puntuación final y compactación de espacios. No resuelve sinónimos, paráfrasis, negación semántica, correferencias, ironía ni cambios de referente. Dos frases distintas pueden expresar la misma idea y no serán comparadas; esta limitación es preferible a unir proposiciones diferentes por semejanza débil.

## Hallazgos

- `polarity-disagreement`: una afirmación afirmada y otra negada sobre la misma proposición normalizada.
- `epistemic-status-shift`: cambia el modo entre cognición incierta y afirmación cognitiva explícita.
- `knowledge-kind-shift`: cambia el tipo de señal (por ejemplo, recordar frente a olvidar).

Si coinciden varias diferencias, la polaridad tiene prioridad clasificatoria; los campos conservan los tipos y modos originales para que la interfaz pueda presentar la información completa. No se infiere que el personaje miente, que la proposición sea verdadera o que haya ocurrido un cambio mental real.

## Orden y perspectiva

Dentro del mismo documento y revisión, se conserva el orden de offsets. Entre documentos, solo se establece dirección si el proyecto entrega un orden documental explícito. En otro caso, el par queda `unordered`; el orden determinista de salida no significa anterioridad. La comparación exige el mismo personaje titular y no mezcla sus afirmaciones con las de otros personajes.

## Integridad y límites

Se validan identidad de proyecto, IDs únicos, revisión, rangos UTF-16, longitud de excerpt y contención de evidencias auxiliares. Límites: 10.000 afirmaciones, 50.000 parejas examinadas y 2.000 hallazgos; al excederlos se informa error y no se trunca silenciosamente.

## Próxima integración

Una etapa posterior puede vincular hallazgos a eventos, fuentes de información y turnos de diálogo. Debe mantener separados los hechos narrados, lo que un personaje cree, lo que afirma a otros y lo que el lector puede conocer.
