

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


### Fase J: referencias enfáticas y endurecimiento del pipeline

Se amplía el detector para reconocer las formas explícitas `él mismo` y `ella misma` como una sola referencia, conservando el género gramatical de la forma pronominal y el rango completo de la expresión. El vínculo con acciones sigue exigiendo un verbo del catálogo y conserva negación explícita.

También se corrige el orden de validación del pipeline: las entidades se validan antes de recorrerlas para comprobar menciones. Así, una colección malformada produce un error controlado en vez de una excepción accidental por acceso a una propiedad.

Se agregan pruebas de integración para `Ella misma protegió` y para colecciones de entidades nulas.


### Fase K: completar acciones pronominales con objetivos expresos

Se incorpora `typescript/src/narrative-pronoun-target-link.ts`. Cuando el sujeto ya fue resuelto de forma inequívoca, el módulo busca un objetivo personaje escrito inmediatamente después del verbo y dentro de la misma cláusula.

- Produce una acción actor-verbo-objetivo compatible con el extractor de interacciones.
- Solo acepta objetivos de personaje con nombre canónico o alias no ambiguo.
- No completa objetos omitidos, no elige entre objetivos ambiguos y no convierte objetos no personales en relaciones entre personajes.
- Conserva polaridad, documento, revisión y evidencia textual.
- El pipeline integra estas acciones con las interacciones y los candidatos de cambio de señal.

Se agregan pruebas para el recorrido «Mara llegó. Ella protegió a Elian. Después, Ella traicionó a Elian», y para comprobar que «Ella protegió» no genera un objetivo inventado.


## Fase L: memoria narrativa entre fragmentos

- El pipeline acepta `priorAssertions` procedentes de capítulos o fragmentos anteriores del mismo proyecto.
- Extrae afirmaciones explícitas de edad, ubicación y rol del fragmento actual y las compara con esa memoria previa.
- Devuelve `assertions` y `consistencyFindings` en el resultado coordinado.
- Distingue cambios temporales ordenables, conflictos en el mismo instante y casos temporalmente incomparables.
- Conserva las dos evidencias originales para que el escritor pueda revisar la evolución.
- Rechaza memoria previa de otro proyecto, referencias a personajes desconocidos y limita la colección de entrada a 5.000 afirmaciones.
- No decide qué versión es canónica, no corrige el texto y no interpreta automáticamente un cambio como error: una edad o ubicación diferente puede ser evolución legítima.

**Límite:** la memoria anterior debe ser suministrada por la capa de biblioteca/persistencia; el pipeline no consulta ni modifica almacenes por su cuenta. La extracción sigue limitada a patrones lingüísticos explícitos de los atributos soportados.


## Fase M: atribución temporal conservadora de afirmaciones

La revisión de precisión detectó un riesgo: una fecha presente en cualquier parte de una línea podía terminar asociada a una afirmación de otro personaje o de otra oración.

Correcciones:
- La referencia temporal de una afirmación ahora se busca únicamente dentro de su misma oración.
- Si no hay fecha o índice temporal explícito en esa oración, la afirmación queda sin referencia temporal.
- Si hay más de una referencia temporal en la misma oración, el extractor no elige por proximidad: deja la atribución temporal sin resolver.
- Se mantiene el fragmento de evidencia y los offsets UTF-16 absolutos de la afirmación original.
- Se añadieron pruebas para fechas de oraciones vecinas, múltiples fechas ambiguas, offsets absolutos y aislamiento de proyecto.

**Criterio de precisión:** es preferible conservar una afirmación sin fecha antes que inventar una asociación temporal. La falta de fecha no significa que el hecho carezca de tiempo; significa que el texto analizado no permite asignárselo con seguridad.

**Límite pendiente:** el extractor de afirmaciones continúa cubriendo solo edad, ubicación y determinados cargos explícitos. No debe confundirse esta mejora de atribución temporal con una cobertura completa de hechos narrativos, ni con una comprensión semántica general.


## Fase N: alcance independiente de la negación en afirmaciones atribuidas

Se corrigió una ambigüedad semántica importante en el modelo de afirmaciones:

- `attributionPolarity` representa si el personaje realiza o niega el acto de creer, afirmar, recordar, temer o decir.
- `contentPolarity` representa si la proposición atribuida contiene un marcador explícito inicial de negación (`no`, `nunca`, `jamás`, `tampoco`).
- `polarity` se conserva por compatibilidad y mantiene el significado histórico de negación del verbo atributivo.

Ejemplos:
- «Mara no cree que Elian sea culpable»: atribución negada; contenido afirmado.
- «Mara cree que Elian no es culpable»: atribución afirmada; contenido negado.

Esto impide tratar ambas frases como si expresaran la misma estructura lógica.

**Límites deliberados:** el detector de polaridad proposicional es léxico y reconoce marcadores al comienzo del contenido extraído. No resuelve todavía alcance de negación subordinada, doble negación, ironía, litotes, presuposiciones ni negación implícita. Los resultados siguen siendo candidatos y requieren revisión contextual.


## Fase O: integración de atribuciones en el pipeline de comprensión

- `understandNarrativeFragment` ahora ejecuta `extractNarrativeAttributedClaims` junto con los demás extractores y devuelve `attributedClaims`.
- Las afirmaciones atribuidas quedan disponibles en el resultado coordinado con documento, revisión, evidencia y offsets compartidos.
- La polaridad del acto de atribuir y la polaridad de la proposición se mantienen separadas también en la salida integrada.
- Se añadió una prueba de integración con dos personajes y negaciones de distinto alcance.

Esto evita que el extractor de atribuciones exista como capacidad aislada que la aplicación principal nunca consulta.

**Límite actual:** los verbos y patrones de atribución siguen siendo un catálogo español acotado; la atribución de citas anidadas, discurso indirecto libre, ironía, narrador no fiable, diálogos sin etiqueta y cambios de hablante todavía requiere módulos específicos y no se debe inferir por proximidad.


## Fase P: atribución explícita de hablantes en diálogos

Se incorporó `narrative-dialogue-attribution.ts` para detectar intervenciones con etiqueta de habla explícita en tres estructuras españolas:

1. Diálogo con raya seguido de atribución: `—No volveré —dijo Mara.`
2. Cita seguida de atribución: `«La puerta está abierta», respondió Elian.`
3. Personaje antes de la cita: `Mara preguntó: «¿Quién ha entrado?»`

Cada candidato conserva por separado:
- identidad del hablante;
- texto exacto de la intervención;
- evidencia completa de la línea;
- rango exacto de la intervención;
- rango exacto del nombre que identifica al hablante;
- documento, revisión y offsets UTF-16 absolutos.

La resolución de nombres aplica alias y rechaza nombres compartidos por varias identidades. Se integra el resultado como `dialogueAttributions` en `understandNarrativeFragment` y se exporta desde el índice público.

**Límites deliberados:** no se infieren turnos alternos, voces por proximidad entre párrafos, hablantes omitidos, vocativos, ni etiquetas sin verbo de habla reconocido. No se resuelven todavía diálogos multilínea, atribuciones intercaladas dentro de una misma línea, estilo indirecto libre, narrador no fiable ni citas anidadas. Los candidatos no son hechos canónicos y requieren revisión.

Se añadieron pruebas para las tres estructuras, offsets absolutos, procedencia, hablantes ambiguos, ausencia de etiqueta y la integración del pipeline.


## Fase Q: procedencia epistemológica explícita de la información

Se añadió `narrative-information-provenance.ts` para conservar cómo llega una información a un personaje, sin convertir automáticamente su contenido en verdad narrativa.

Canales reconocidos de forma conservadora:

- `visual-observation`: «Mara vio que el puente había caído».
- `auditory-observation`: «Mara escuchó que Elian había escapado».
- `written-source`: «Elian leyó que la ciudad estaba sitiada».
- `reported-speech`: «Elian le contó a Mara que el puente había caído».
- `rumor`: «Se rumorea que el rey ha muerto».

El modelo separa:
- titular/receptor de la información (`informationHolderEntityId`);
- fuente comunicadora (`sourceEntityId`), únicamente si está nombrada;
- canal de acceso y estado epistemológico;
- contenido y evidencia exacta;
- evidencia independiente del receptor y de la fuente;
- documento, revisión y offsets UTF-16 absolutos.

La extracción solo atribuye identidades resueltas de forma única. Un rumor impersonal no recibe un personaje inventado como fuente o receptor. El resultado se integra en `understandNarrativeFragment` como `informationProvenance` y se exporta desde el índice público.

**Límites:** catálogo limitado a construcciones explícitas en español; no identifica todavía fuentes implícitas, narrador, documentos citados como entidades, fuentes múltiples, ironía, mentira, fiabilidad del testigo ni contradicción entre percepción y realidad. «Vio» se registra como canal de observación, no como garantía de que la interpretación del personaje sea correcta. Los resultados son candidatos revisables, no hechos canónicos.

Se añadieron pruebas para observación visual/auditiva, lectura, transmisión entre personajes, rumor impersonal, offsets, ambigüedad de nombres y la integración en el pipeline.


## Fase R: evolución explícita del conocimiento y evaluación de afirmaciones

Se incorporó `narrative-knowledge-evolution.ts` para detectar cuándo un personaje confirma, comprueba, verifica, desmiente, refuta, descarta, duda, cuestiona u oculta explícitamente una proposición.

El modelo registra:
- personaje que evalúa la información;
- evaluación explícita (`confirmed`, `refuted`, `uncertain`, `concealed`);
- contenido de la proposición;
- evidencia del capítulo/revisión actual;
- vínculo a una afirmación previa y su evidencia original, si existe una coincidencia textual exacta y única.

La asociación entre capítulos es intencionalmente estricta: compara el contenido normalizado, sin inferir paráfrasis. Si no hay antecedente o existen varios antecedentes con el mismo contenido, conserva `no-prior-match` o `ambiguous-prior-match`; no elige arbitrariamente.

Se integra en `understandNarrativeFragment` mediante `priorClaims` y devuelve `knowledgeEvolution`. Las afirmaciones previas se mantienen intactas; una confirmación o refutación es un nuevo registro de evolución, no una edición destructiva del historial.

**Límites importantes:** esta fase detecta señales lingüísticas explícitas, no determina verdad objetiva ni fiabilidad. «Mara confirmó que X» se registra como evaluación de Mara, no como validación del narrador. «Ocultó que X» indica ocultamiento explícito, pero no permite inferir por qué, a quién ni si X es verdadero. No se resuelven todavía paráfrasis, contradicciones semánticas, mentiras, ironía, cambios de opinión implícitos ni cadena de transmisión de una fuente a otra.

Se añadieron pruebas de confirmación, refutación, paráfrasis no enlazada, antecedentes duplicados, ausencia de señal, offsets y validación de proyecto, además de integración en el pipeline.


## Fase S: reconstrucción de cadenas explícitas de transmisión de información

Se añadió `narrative-information-chain.ts` para enlazar adquisiciones y transmisiones entre capítulos o dentro de un mismo fragmento.

Ejemplo de cadena:
1. Elian ve que el puente cayó: el conocimiento queda asociado a Elian como titular, sin inventar un emisor.
2. Elian le cuenta a Mara que el puente cayó: la transmisión se enlaza con la adquisición anterior si el titular anterior es Elian y el contenido coincide exactamente.
3. Mara le cuenta a Ivo lo mismo: puede enlazarse con la transmisión anterior porque Mara pasa a ser titular y luego emisor.

Cada paso conserva emisor, receptor, canal, contenido y evidencia. La relación entre pasos requiere identidad coincidente y contenido normalizado exacto. La búsqueda dentro del fragmento respeta el orden textual; la memoria de capítulos anteriores se recibe explícitamente por `priorInformationProvenance`.

Estados de enlace:
- `linked`: existe un único antecedente compatible.
- `no-predecessor`: no existe antecedente demostrable o el emisor no está identificado.
- `ambiguous-predecessor`: más de un antecedente coincide; no se elige arbitrariamente.

El pipeline devuelve `informationChain`; el módulo se exporta desde `src/index.ts`. Se añadieron pruebas para dos transmisiones sucesivas, enlaces en el mismo capítulo, paráfrasis no enlazadas, antecedentes duplicados, rumores sin fuente inventada, procedencia y proyecto.

**Límites:** esta reconstrucción no infiere paráfrasis, fuentes implícitas, intención de engañar, confianza, comprensión correcta ni verdad objetiva. La coincidencia literal solo demuestra compatibilidad textual e identitaria, no que el receptor haya entendido o aceptado la información. Los registros previos deben suministrarse desde la biblioteca/persistencia; el pipeline no consulta el almacén por sí solo.
