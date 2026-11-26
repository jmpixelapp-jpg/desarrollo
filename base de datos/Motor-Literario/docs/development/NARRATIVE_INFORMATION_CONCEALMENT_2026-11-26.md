# Descubrimiento de afirmaciones de ocultación e información engañosa

## Objetivo

El módulo `narrative-information-concealment-discovery.ts` extrae construcciones textuales explícitas que atribuyen a un personaje ocultación, mentira, fingimiento o inducción de una creencia. Es un extractor de afirmaciones del texto, no un detector de mentiras verdaderas.

## Señales reconocidas

- `concealed-proposition`: «Ana ocultó a Bruno que…», «Ana escondió que…» o «Ana calló que…».
- `lied-to-recipient`: «Ana mintió a Bruno diciendo que…».
- `feigned-proposition`: «Ana fingió que…» o «Ana simuló que…».
- `induced-belief`: «Ana hizo creer a Bruno que…».

Actor y destinatario deben resolverse mediante nombres o alias explícitos de entidades de tipo personaje. No se resuelven pronombres ni se adivinan participantes por contexto. Un nombre que coincide con más de una entidad queda sin atribuir y no genera candidato.

## Evidencia y semántica

Cada candidato conserva evidencia separada para actor, verbo desencadenante, proposición y destinatario cuando existe, además de la polaridad textual afirmada o negada. `assertionStatus=textually-asserted` indica que la construcción aparece en el texto. `deceptionEstablished=false` e `intentEstablished=false` impiden interpretar la señal como prueba de falsedad, engaño efectivo, voluntad de engañar o recepción por parte del destinatario. Incluso «mintió» se registra como afirmación narrativa pendiente de revisión.

## Límites

Texto: 2.000.000 unidades UTF-16; entidades: 5.000; alias por entidad: 100; longitud de nombre/alias: 256; proposición: 500; coste estimado de búsqueda: 25.000.000; candidatos: 1.000. El exceso produce error explícito. Se procesa por oraciones delimitadas por puntuación; construcciones que cruzan límites, voz pasiva, discurso indirecto complejo y formas pronominales no quedan cubiertas.

## Uso

Ejecutar después de construir entidades de personajes y antes de análisis de distribución de información. Los candidatos pueden cruzarse posteriormente con conocimiento, diálogo y afirmaciones de acciones, siempre conservando los marcos epistémicos y las evidencias originales. No debe transformarse automáticamente en un veredicto de engaño.
