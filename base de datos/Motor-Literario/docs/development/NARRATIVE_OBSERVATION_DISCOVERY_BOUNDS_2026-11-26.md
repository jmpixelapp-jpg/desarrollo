# Límites operativos de extracción de observaciones narrativas — 26 de noviembre de 2026

## Problema detectado

El extractor de acciones validaba la longitud del texto, pero no acotaba el tamaño de la colección de entidades ni la cantidad de alias por entidad. Tampoco limitaba la segmentación de frases antes de recorrer señales verbales. Un documento adversarial con puntuación repetida o un catálogo de entidades excesivo podía disparar trabajo y memoria innecesarios.

## Cambios

- Máximo de 10.000 entidades por invocación.
- Máximo de 100 alias por entidad.
- Máximo de 256 unidades UTF-16 por nombre canónico o alias.
- IDs de entidad únicos y pertenencia obligatoria al proyecto.
- Máximo de 20.000 segmentos de frase materializados.
- Se mantienen los límites existentes de 2.000.000 de unidades de texto y 200 candidatos de observación.

## Precisión y límites

Las entidades duplicadas, alias vacíos/no textuales o nombres excesivos se rechazan; no se normalizan silenciosamente. La segmentación conserva los offsets del texto original. Si un documento excede el presupuesto de segmentos, el extractor procesa el prefijo textual que cabe en el límite; los llamadores que necesiten cobertura exhaustiva deben fragmentar el documento, pasar offsets absolutos y agregar resultados por revisión.

Los límites no convierten candidatos en hechos: la polaridad, roles gramaticales y relaciones continúan sujetos a la evidencia y revisión existentes.

## Pruebas

Se añaden regresiones para IDs duplicados, entidades de otro proyecto, alias inválidos, colecciones excesivas y documentos con más de 20.000 segmentos.
