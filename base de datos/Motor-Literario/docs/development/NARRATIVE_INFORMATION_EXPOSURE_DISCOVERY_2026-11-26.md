# Descubrimiento de exposición de información narrativa

## Propósito y alcance

El módulo `narrative-information-exposure-discovery.ts` detecta tres construcciones explícitas en el texto: `secret-is-that` («el secreto era que»), `truth-is-that` («la verdad era que», «lo cierto era que») y `character-unaware-that` («sin que Ana supiera que»). Son señales de presentación textual, no un modelo completo de focalización ni una medición del estado cognitivo del lector.

## Separaciones epistemológicas obligatorias

- `presentation`: la proposición aparece explícitamente presentada en el texto narrativo.
- `readerKnowledge=not-established`: el sistema no afirma que el lector haya entendido, retenido o conocido la proposición.
- `focalization=unresolved`: no se deduce omnisciencia, narrador fiable, perspectiva interna ni acceso mental.
- `subjectEntityId`: solo aparece en el patrón de desconocimiento cuando un nombre/alias de entidad coincide inequívocamente con el sujeto explícito. La ausencia de una mención cognitiva no equivale a ignorancia.

## Exclusión de diálogo

Se pueden suministrar rangos de evidencia de diálogo directo para excluir las frases que se solapan con ellos. La evidencia excluida debe pertenecer al mismo documento y revisión, ser actual y reproducir exactamente el fragmento del texto. No se adivina si una frase no marcada es diálogo; la integración debe proporcionar segmentos identificados por el detector de hablantes.

## Límites

Texto: 2.000.000 unidades UTF-16; entidades: 5.000; nombres/alias: 256 unidades y 100 alias por entidad; coste de búsqueda: 25.000.000 unidades; candidatos: 1.000; proposición: 500 unidades. Se produce error explícito al superar el presupuesto. Las evidencias usan offsets UTF-16 absolutos y conservan documento/revisión.

## Limitaciones deliberadas

La lista de marcadores es pequeña y española. No detecta de forma exhaustiva ironía, estilo indirecto libre, analepsis, narradores no fiables, metáforas, elipsis, implicaturas ni cambios de focalización. «La verdad era que» es un marcador retórico, no una garantía de verdad extratextual. Los resultados requieren revisión humana.

## Próximas integraciones

La capa siguiente debe relacionar estas exposiciones con la secuencia de conocimiento de personajes y las escenas/segmentos narrativos, manteniendo separados: proposición expuesta al lector como texto, personaje explícitamente descrito como ignorante, personaje que ya la conoce y focalización aún no resuelta.
