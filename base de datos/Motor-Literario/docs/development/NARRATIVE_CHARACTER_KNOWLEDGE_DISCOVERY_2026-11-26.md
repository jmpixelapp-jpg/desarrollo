# Descubrimiento de conocimiento de personajes

## Objetivo

El módulo `narrative-character-knowledge-discovery.ts` identifica afirmaciones textuales de adquisición, descubrimiento, sospecha, creencia, recuerdo, olvido y transferencia explícita de información. No construye por sí solo una base de hechos conocidos ni decide si una proposición es verdadera.

## Contrato y trazabilidad

Cada candidato incluye proyecto, documento, revisión, personaje receptor, disparador verbal, proposición literal y fragmento completo. En una transferencia conserva emisor y receptor, ambos respaldados por menciones nominales explícitas. Los offsets son UTF-16 absolutos e incorporan `baseOffset`.

## Prudencia

- No resuelve pronombres como «le», «él» o «ella» para asignar destinatarios o emisores.
- No atribuye una afirmación si hay más de una identidad candidata antes del disparador.
- «Creyó» y «sospechó» se etiquetan como inciertos, no como conocimiento objetivo.
- «Bruno reveló a Ana que...» registra comunicación textual; no demuestra que Ana comprendiera, aceptara o recordara la información.
- La proposición se limita a 500 unidades UTF-16 y se conserva literalmente.
- La ausencia de una señal no demuestra ignorancia; no se deduce quién desconoce un secreto.

## Límites operativos

Texto máximo: 2.000.000 unidades UTF-16; 5.000 entidades; 100 alias por entidad; 256 unidades por nombre/alias; presupuesto de búsqueda de 25.000.000 unidades; máximo de 500 candidatos. El exceso produce error explícito, nunca truncamiento silencioso.

## Límites lingüísticos

La detección usa patrones léxicos en español y límites aproximados de oración. No resuelve subordinación compleja, discurso libre indirecto, ironía, elipsis, correferencia pronominal, citas anidadas ni alcance completo de negación. La transferencia, el descubrimiento, la creencia y el recuerdo permanecen diferenciados.

## Siguiente capa

Una capa posterior deberá enlazar candidatos con eventos, referencias temporales, hablantes de diálogo y evidencia de fuente; después podrá proponer cronologías de recepción y cambios de creencia, manteniendo cada inferencia revisable y separada de la evidencia literal.
