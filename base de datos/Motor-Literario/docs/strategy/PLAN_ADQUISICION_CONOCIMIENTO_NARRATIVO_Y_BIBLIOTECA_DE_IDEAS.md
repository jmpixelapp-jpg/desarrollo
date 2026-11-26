

### Fase B: segmentación explícita y contexto de escena

Se incorpora `typescript/src/narrative-scene-context.ts` para reconocer límites de escena declarados por el escritor, sin deducirlos por proximidad o estilo. La primera versión acepta encabezados `ESCENA`, encabezados Markdown `## Escena ...` y encabezados de guion `INT.`, `EXT.` e `INT./EXT.`.

Cada segmento conserva proyecto, documento, revisión, ordinal, encabezado literal, rango del encabezado y rango del cuerpo con offsets UTF-16. El texto anterior al primer encabezado permanece sin asignar. Los saltos de párrafo y los cambios de personaje o lugar no crean escenas por sí solos.

Se añade `assignNarrativeEvidenceToScene`: asigna una evidencia solo cuando su rango completo queda dentro del cuerpo de exactamente una escena. Si atraviesa un límite, devuelve `crosses-boundary`; si no coincide con una escena explícita, devuelve `unassigned`. Esta salida permite que acciones, eventos e ideas incorporen contexto de escena sin modificar sus extractores ni convertir una suposición en estructura confirmada.

Se añadieron seis pruebas para encabezados explícitos, guion, offsets, ausencia de inferencias, asignación y evidencia que cruza límites. **Estado de validación:** código y pruebas publicados en la rama; no se ha confirmado todavía una ejecución CI para este último commit. No se declara type-check ni suite aprobados hasta disponer del resultado real.


### Fase C: continuidad observable entre escenas

Se añade `buildNarrativeCharacterSceneContinuity` en `typescript/src/narrative-scene-context.ts`. El índice relaciona personajes con varias escenas únicamente cuando ya aparecen como participantes explícitos en acontecimientos extraídos y toda la evidencia de cada acontecimiento queda dentro de una única escena explícita.

La continuidad resultante conserva IDs de personaje, escenas, acontecimientos, cantidad de apariciones y ordinal de primera/última escena. La asociación exige coincidencia de proyecto, documento y revisión; por tanto, no mezcla offsets de manuscritos distintos ni revisiones diferentes. Eventos sin evidencia, sin participantes, fuera de escenas o que atraviesan límites no crean continuidad. Los pronombres todavía no se resuelven: esta fase mide apariciones verificadas, no presencia inferida.

Se agregaron pruebas para personajes que reaparecen, varios participantes, evidencia que cruza escenas, documentos diferentes y eventos duplicados.

### Corrección de robustez Unicode

Se corrigió el patrón de nombres del extractor de entidades para utilizar propiedades Unicode `Lu`, `L` y `M`, incluyendo nombres con marcas combinantes descompuestas. La expectativa de la prueba se mantiene: no se relaja ni se elimina.

### Validación pendiente

El último CI disponible corresponde a un SHA anterior y no valida estos commits. El conector de GitHub no ha generado una ejecución para el nuevo head; por ello, type-check, build y suite completa siguen pendientes de ejecución en GitHub Actions. No se declara esta fase validada hasta obtener un resultado asociado al head actual.


### Fase D: referencias pronominales conservadoras

Se incorpora `typescript/src/narrative-pronoun-resolution.ts` y se exporta desde el punto de entrada público. La API recibe menciones de personajes y referencias pronominales con rangos explícitos, documento, revisión y rasgos gramaticales aportados por un extractor lingüístico.

El resolver:
- Solo considera antecedentes anteriores dentro del mismo documento y revisión.
- Aplica límites configurables de distancia y, opcionalmente, de oración.
- Comprueba número gramatical y género cuando está disponible.
- Agrupa menciones repetidas de la misma identidad para no generar falsos duplicados.
- Devuelve `resolved` solo si queda un único personaje compatible.
- Devuelve `ambiguous` cuando hay varios personajes compatibles, sin desempatar por cercanía.
- Devuelve `unresolved` cuando no hay evidencia compatible.
- No deduce género a partir de nombres propios; si el antecedente tiene género desconocido y el pronombre está marcado, no confirma la relación.

Se agregaron pruebas para resolución única, ambigüedad, desacuerdo gramatical, aislamiento entre documentos/revisiones, distancia máxima, límite de oración, offsets inválidos y rasgos desconocidos.

**Límite de esta fase:** todavía no existe un extractor sintáctico que identifique automáticamente pronombres y sus rasgos dentro de prosa arbitraria. Esta API es la capa de decisión segura que podrá consumir dicho extractor; no debe confundirse con comprensión completa del lenguaje natural.

### Validación de Fase D

El código, exportación, pruebas y documentación están publicados en la rama de la PR 63. Aún no se ha observado una ejecución CI asociada al último commit. Build, type-check y suite completa siguen pendientes de confirmación.
