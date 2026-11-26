# Extracción de conocimiento con sujeto pronominal

## Objetivo

`discoverNarrativePronounKnowledgeCandidates` amplía la extracción de conocimiento a oraciones cuyo sujeto aparece como pronombre personal inicial («él», «ella», «ellos», «ellas», «usted», «ustedes»), usando candidatos producidos por `discoverNarrativePronounReferences`.

## Regla conservadora

Solo procesa una referencia con estado `single-candidate`, exactamente un antecedente y tipo `character`. Si la referencia es ambigua, no tiene antecedente o apunta a otro tipo de entidad, no atribuye conocimiento. La cercanía y la resolución previa son indicios revisables, no prueba definitiva de correferencia.

## Señales

Recupera saber, creer, pensar, sospechar, intuir, recordar y olvidar con proposición subordinada introducida por «que». Preserva polaridad negativa y marcos cognitivos inciertos.

## Procedencia y límites

La evidencia del titular señala el pronombre; la del antecedente permanece en el registro de referencia suministrado. Las evidencias se validan contra documento, revisión, offsets UTF-16 y texto exacto. Límites: 2 millones de unidades de texto, 2.000 referencias y 500 candidatos.
