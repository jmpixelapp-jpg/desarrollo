

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


### Fase E: atribución de acciones a referencias pronominales

Se añade `typescript/src/narrative-pronoun-action-link.ts`, que conecta el resultado del resolver pronominal con el extractor de acciones explícitas. Esto permite representar casos como «Mara entró. Ella no protegió a Elian» sin exigir que el escritor repita el nombre en cada oración.

Reglas de seguridad:
- Solo consume referencias y resoluciones previamente validadas.
- Solo reconoce un verbo del vocabulario de acciones existente inmediatamente después del pronombre.
- Una identidad única genera una acción candidata, nunca un hecho confirmado.
- Una resolución ambigua genera una acción ambigua con todos los actores posibles y sin actor definitivo.
- Una referencia no resuelta no genera una acción atribuida.
- Conserva negación, documento, revisión, offsets y evidencia literal.
- No completa objetos, no interpreta complementos complejos y no deduce causalidad.

Se añadieron pruebas de integración para atribución única, ambigüedad, referencias sin resolver, estructuras verbales no compatibles y entradas inconsistentes.

**Límite:** el vocabulario verbal sigue siendo deliberadamente acotado. La capa no es un analizador sintáctico general ni debe atribuir automáticamente verbos separados del pronombre por incisos o estructuras subordinadas.

### Validación de Fase E

Módulo, exportación, cinco pruebas y documentación publicados en la rama de la PR 63. No se ha confirmado aún una ejecución CI sobre el head actual; type-check, build y suite completa siguen pendientes.


### Fase F: evolución observable de interacciones entre personajes

Se añade `typescript/src/narrative-character-interaction-evolution.ts`. La capa toma acciones actor → objetivo ya extraídas y limita el análisis a pares donde ambas entidades están tipadas como personajes.

Produce señales direccionales de interacción:
- Vocabulario explícito de apoyo: acompañar, proteger, rescatar, ayudar y salvar.
- Vocabulario explícito de hostilidad: traicionar, destruir, atacar y matar.
- Acciones fuera de esos vocabularios: señal neutral/desconocida.
- Acciones negadas: no se convierten en la valencia opuesta; quedan como neutral/desconocida, porque «no lo protegió» no demuestra que lo atacara.

Después puede señalar un cambio de señal entre acciones del mismo actor hacia el mismo objetivo, únicamente dentro del mismo documento y revisión. Cada cambio conserva las dos evidencias originales y queda como candidato revisable.

Se agregan cinco pruebas para dirección actor/objetivo, exclusión de objetos, negación, cambio explícito, neutralidad, aislamiento entre revisiones y validación de duplicados.

**Límite:** estas señales no representan estados confirmados de amistad, confianza, amor u odio. Tampoco deducen emociones, intenciones, reciprocidad ni causalidad. Son indicios léxicos cronológicamente ordenados que el escritor puede revisar.

### Validación de Fase F

Módulo, exportación pública, cinco pruebas y documentación publicados en la rama de la PR 63. No hay aún una ejecución CI observada para el head actual; la compilación y la suite siguen pendientes de confirmación.


### Fase G: orquestación de comprensión de fragmentos

Se incorpora `typescript/src/narrative-understanding-pipeline.ts` como punto de entrada único: `understandNarrativeFragment(input)`.

En una ejecución coordinada sobre un documento y revisión, reúne:
- candidatos de ideas;
- acciones explícitas entre entidades;
- acontecimientos agrupados por oración;
- conectores explícitos de consecuencia;
- escenas reconocidas por encabezados;
- interacciones y cambios de señal entre personajes;
- asignaciones de ideas, acciones y acontecimientos a escenas.

Todos los extractores reciben el mismo proyecto, documento, revisión, texto y `baseOffset`. El resultado expone también el rango analizado, de modo que una ventana parcial conserva offsets absolutos coherentes. Las evidencias no se reescriben ni se parafrasean.

Se agregan tres pruebas de integración para la coordinación de extractores, propagación de offsets y rechazo de entidades de otros proyectos.

**Límite:** esta capa coordina capacidades existentes; no es un modelo semántico general ni resuelve referencias pronominales por sí sola. La ausencia de encabezados explícitos deja candidatos sin escena. Los resultados siguen siendo candidatos y no modifican automáticamente la biblioteca canónica.


### Fase H: integración de referencias pronominales en la comprensión coordinada

La entrada `understandNarrativeFragment(input)` ahora admite `characterMentions` y `pronounReferences` previamente detectadas por un componente lingüístico. Ambas colecciones usan offsets UTF-16 absolutos y deben corresponder al mismo proyecto, documento, revisión y ventana de texto.

La orquestación:
- Convierte temporalmente los offsets absolutos a offsets locales para el resolver existente.
- Resuelve cada referencia como identidad única, ambigua o no resuelta; no fuerza una elección.
- Extrae acciones solo cuando existe una referencia compatible y un verbo explícito reconocido inmediatamente después.
- Devuelve acciones pronominales con offsets absolutos restaurados y evidencia original.
- Asigna esas acciones a escenas explícitas cuando su evidencia queda dentro de una escena reconocida.
- Comprueba que la superficie del pronombre coincide exactamente con el texto y limita menciones/referencias para evitar entradas desproporcionadas.

Se agregan dos pruebas de integración: resolución y atribución con `baseOffset` distinto de cero, y rechazo de una superficie pronominal que no coincide.

**Límite importante:** el motor no descubre todavía por sí mismo todos los pronombres ni sus rasgos gramaticales. Un detector lingüístico debe proporcionar menciones y referencias; si faltan, el pipeline no inventa sujetos. Las acciones pronominales se conservan separadas de las acciones actor-objetivo con nombres explícitos.


### Fase I: detección léxica inicial de menciones y pronombres en español

Se añade `typescript/src/narrative-pronoun-detection.ts`, que el pipeline ejecuta automáticamente cuando no se proporcionan colecciones externas.

Cobertura deliberadamente acotada:
- Busca nombres canónicos y alias ya registrados de personajes, respetando límites Unicode y offsets UTF-16.
- Detecta los pronombres sujeto singulares `él` y `ella`.
- Omite nombres que pertenecen a más de una identidad, registrándolos en `skippedAmbiguousCharacterNames`.
- Acepta perfiles gramaticales explícitos por personaje. Sin perfil, la mención queda con género `unknown` y no puede confirmar una referencia marcada.
- Conserva documento, revisión y offsets absolutos, también al analizar ventanas parciales.

Se agregan cuatro pruebas directas del detector y dos pruebas de integración que comprueban resolución automática y el comportamiento seguro cuando falta el género.

**Límites:** no detecta todavía plurales, clíticos (`lo/la/le/se`), pronombres relativos ni sujetos omitidos. Tampoco deduce género por terminaciones de nombres. La detección léxica no sustituye un analizador sintáctico; cuando haya varios antecedentes compatibles, la resolución permanece ambigua.
