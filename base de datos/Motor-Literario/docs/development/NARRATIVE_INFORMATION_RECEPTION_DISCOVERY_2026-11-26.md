# Descubrimiento de recepción de información

## Objetivo

`narrative-information-reception-discovery.ts` separa cuatro etapas que no deben confundirse: exposición o contacto, comprensión explícita, aceptación/creencia y malentendido explícito. Cada resultado es una señal textual candidata con evidencia y revisión humana.

## Reglas interpretativas

- «Oyó que…», «escuchó que…», «leyó que…» y «recibió la noticia/información de que…» producen exposición. No prueban atención, comprensión, recuerdo ni aceptación.
- «Entendió que…» y «comprendió que…» registran comprensión afirmada, pero no aceptación.
- «No entendió que…» y «no comprendió que…» conservan una señal explícita de no comprensión.
- La negación previa («no creyó», «nunca oyó») se conserva como polaridad negada y no se transforma en aceptación o exposición afirmada.
- «Creyó que…» y «aceptó que…» se registran como aceptación/creencia, sin convertirla en verdad objetiva.
- «Interpretó erróneamente que…» registra malentendido textual, sin decidir cuál era la interpretación verdadera.

## Atribución y límites

Se exige un personaje identificado por nombre canónico o alias confirmado antes del desencadenante dentro de la misma oración. No se resuelven pronombres, sujetos omitidos ni menciones de varios personajes. La proposición se conserva literalmente; no se resuelven paráfrasis ni correferencias. Las expresiones no cubiertas quedan sin extraer, no se completan mediante inferencia.

La API conserva documento, revisión, offsets UTF-16 absolutos, extractos y polaridad. Límites: 2.000.000 unidades de texto, 5.000 entidades, 100 alias por entidad, 256 unidades por nombre, 500 por proposición, 25.000.000 unidades de coste de búsqueda y 1.000 candidatos. Ante exceso se detiene con error explícito para procesar por bloques.

## Integración prevista

Este módulo debe cruzarse posteriormente con transferencia de conocimiento y atribución de diálogo. Una intervención dirigida a un personaje no demuestra que la oyó; una recepción no demuestra comprensión; comprensión no demuestra creencia. La secuencia solo podrá proponerse cuando exista evidencia independiente y cronología compatible. No se declara recepción, comprensión o engaño como hecho definitivo.
