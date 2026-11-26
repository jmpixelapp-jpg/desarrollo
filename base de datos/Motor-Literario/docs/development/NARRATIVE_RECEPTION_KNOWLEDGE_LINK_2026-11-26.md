# Enlace entre recepción explícita y conocimiento de personajes

## Propósito

`narrative-reception-knowledge-link.ts` conecta señales de recepción con afirmaciones de conocimiento cuando coinciden el identificador explícito del personaje y la proposición literal normalizada. Preserva los dos fragmentos probatorios y la dimensión de cada extractor.

## Reglas

- Coincidencia literal conservadora: NFC, minúsculas españolas, puntuación delimitadora y espacios. No resuelve sinónimos, paráfrasis, pronombres ni correferencias.
- El personaje que recibe y el titular de la afirmación de conocimiento deben compartir el mismo ID de entidad.
- Solo se enlazan candidatos con proposición probatoria presente.
- Las polaridades se conservan por separado; una afirmación negada y otra afirmada no se resuelven automáticamente.
- No se equiparan etapas: exposición no significa comprensión, y comprensión no significa aceptación.
- La posición textual solo se determina dentro de la misma revisión. Revisiones distintas no se ordenan. Entre documentos, el orden explícito solo informa orden documental, no cronología diegética.

## Resultado y límites

Cada enlace declara `comprehensionInferred=false`, `acceptanceInferred=false` y `knowledgeTruthEstablished=false`. El resultado es una pista de correspondencia probatoria para revisión, no una conclusión sobre estados mentales o verdad narrativa.

Límites: 10.000 candidatos de recepción, 10.000 afirmaciones de conocimiento, 50.000 parejas examinadas y 5.000 enlaces. Se rechazan IDs duplicados, evidencias inconsistentes y órdenes documentales ambiguos.

## Integración

Ejecutar después de ambos extractores. En una fase posterior se podrá cruzar el enlace con diálogo atribuido, transferencia explícita, memoria y olvido. Ninguna intervención dialogada se tratará como recepción salvo que exista evidencia textual independiente.
