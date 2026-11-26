# Enlace entre transferencia de conocimiento y diálogo

## Propósito

`narrative-knowledge-dialogue-link.ts` conecta candidatos de transferencia explícita (emisor, destinatario y proposición) con segmentos de discurso directo que se solapan en el mismo documento y revisión. La conexión es probatoria y revisable; no declara que el destinatario haya oído, entendido, aceptado o recordado el contenido.

## Criterios

- Solo procesa candidatos con `kind=reported`, `mode=reported-transfer`, emisor explícito y proposición identificada.
- Exige coincidencia de documento y revisión y solapamiento entre el fragmento de transferencia y el segmento dialogal.
- Compara hablante atribuido con emisor declarado.
- Comprueba repetición literal normalizada de la proposición en el turno. La normalización solo uniforma Unicode NFC, caja, puntuación y espacios; no resuelve paráfrasis ni sinónimos.
- Conserva hablantes ambiguos y no atribuidos como estados diferenciados.

## Estados

`speaker-matches-source`, `speaker-conflicts-with-source`, `speaker-ambiguous`, `speaker-unattributed` y `utterance-does-not-repeat-proposition`. Los segmentos sin relación de solapamiento no producen enlace. Los candidatos de cognición no expresados como transferencia quedan fuera.

## Límites interpretativos

Un hablante que coincide con el emisor no demuestra que el receptor esté presente, que haya escuchado el turno ni que comprenda la proposición. El módulo fija expresamente `recipientComprehension=not-established`. Tampoco establece lo que sabe el lector ni convierte un diálogo en verdad objetiva.

## Integridad y límites

Valida IDs únicos, proyecto, revisión, rangos UTF-16, extractos de evidencia, contención de fragmentos y consistencia entre el estado de atribución y los candidatos de hablante. Límites: 10.000 transferencias, 10.000 segmentos y 5.000 enlaces; al excederlos informa error en lugar de truncar.

## Próximas etapas

Para evaluar presencia/recepción del destinatario habrá que combinar marcas de turno, acciones de escucha, escena y continuidad de interlocución. Para separar conocimiento del lector se necesitará una capa específica de exposición narrativa y focalización; no debe deducirse de los diálogos de los personajes.
