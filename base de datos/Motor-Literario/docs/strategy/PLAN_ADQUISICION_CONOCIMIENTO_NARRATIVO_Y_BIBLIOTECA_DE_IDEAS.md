

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


## Fase T: interpretación y deformación explícita de información

Se añadió `narrative-information-interpretation.ts` para registrar interpretaciones declaradas por personajes y compararlas con la información que ya tenían atribuida.

Se reconocen construcciones explícitas como:
- `Mara entendió que...`
- `Mara interpretó que...`
- `Mara entendió mal que...`
- `Mara interpretó erróneamente que...`

La salida distingue:
- `understood`: el texto declara que el personaje entendió una proposición.
- `interpreted`: el texto declara una interpretación, sin calificarla como correcta o incorrecta.
- `explicit-misinterpretation`: el texto califica expresamente la interpretación como equivocada.

La comparación con la memoria previa del personaje produce:
- `exact-content-match`: contenido igual tras normalización conservadora.
- `different-content`: el contenido expresado difiere del contenido previo asociado al personaje.
- `no-prior-information`: no hay registro previo para comparar.
- `ambiguous-prior-information`: existen varios antecedentes posibles.

El módulo se integra en el pipeline como `informationInterpretations` y recibe los antecedentes mediante `priorInformationProvenance`. Se añadieron seis pruebas unitarias y una de integración.

**Precaución epistemológica:** una diferencia de texto no demuestra por sí misma una interpretación falsa. Incluso la señal explícita de malentendido se registra como lo que el texto declara, no como una verdad objetiva. No se infieren paráfrasis equivalentes, intención de engañar, motivos ni fiabilidad del personaje.


## Fase U: estado de conocimiento individual por personaje

Se añadió `narrative-character-knowledge-state.ts` con `buildNarrativeCharacterKnowledgeStates`. El módulo construye una vista revisable por personaje a partir de procedencias, interpretaciones y evaluaciones explícitas.

Cada elemento conserva:
- Identificador de la información y su contenido.
- Canal de adquisición, estado y fuente comunicadora si está explícita.
- Evidencia original.
- Interpretaciones asociadas, incluso cuando el personaje interpreta algo distinto, siempre que exista un enlace explícito a la información previa.
- Evaluaciones del personaje asociadas por coincidencia textual conservadora.

El resumen separa información registrada, interpretaciones, malentendidos expresamente calificados y evaluaciones. No transforma estos recuentos en un indicador de verdad ni de fiabilidad.

La cronología entre documentos solo se ordena cuando el proyecto proporciona `orderedDocumentIds`. Sin ese dato, los documentos distintos se marcan como `cross-document-order-unknown`; dentro de un mismo documento se conserva la posición textual. Los rumores impersonales no se asignan artificialmente a ningún personaje y las entidades que no son personajes no bloquean la construcción.

Integración: el pipeline devuelve `characterKnowledgeStates` y acepta `priorInformationInterpretations` y `orderedDocumentIds`. Se añadieron cuatro pruebas unitarias y una de integración.

**Límites:** un registro de información no demuestra que el personaje lo acepte, lo recuerde indefinidamente o lo comprenda. La ausencia de registro no demuestra ignorancia. El estado es una reconstrucción de lo que el texto documenta, no una simulación omnisciente de la mente del personaje.


## Fase V: evolución temporal de la valoración de información

Se amplió la reconstrucción del estado individual para conservar evaluaciones de capítulos anteriores mediante `priorKnowledgeEvolution` en el pipeline. Las evaluaciones previas y actuales se adjuntan al registro de información correspondiente cuando coinciden el personaje evaluador y el contenido normalizado.

Cada elemento incorpora `currentAssessment`, que distingue:
- `unassessed`: no existe evaluación aplicable posterior a la recepción.
- `confirmed-by-character`: el personaje expresó confirmación.
- `refuted-by-character`: el personaje expresó refutación.
- `uncertain`: el personaje expresó duda.
- `concealed-by-character`: el texto atribuye ocultamiento.
- `chronology-unresolved`: existen evaluaciones, pero no se puede demostrar cuál es posterior.

La selección de la evaluación vigente exige que la evidencia sea posterior a la recepción. En un mismo documento se compara posición solo dentro de la misma revisión. Entre documentos se exige `orderedDocumentIds`; tampoco se mezclan revisiones diferentes de un mismo documento como si fueran capítulos cronológicos.

Se añadieron pruebas para historial acumulado, cambio de duda a refutación, cronología desconocida y evaluación anterior a la recepción. El pipeline acepta y conserva `priorKnowledgeEvolution`.

**Límite semántico:** confirmar o refutar significa que el personaje lo expresó; no establece la verdad objetiva. El sistema no deduce olvido por falta de menciones ni pérdida de memoria a partir del silencio narrativo.


## Fase W: eventos explícitos de memoria individual

Se incorpora `typescript/src/narrative-memory-events.ts` con `extractNarrativeMemoryEvents(input)`. Detecta señales léxicas explícitas atribuidas a personajes nombrados:

- `forgetting`: olvidó, olvido, olvidaba, había olvidado y dejó de recordar.
- `remembering`: recordó, recordo, recordaba y rememoró.
- `memory-recovery`: recuperó el recuerdo/la memoria de.

Cada evento conserva personaje, contenido, proyecto, documento, revisión y evidencia con offsets UTF-16 absolutos. Los nombres/alias ambiguos no se atribuyen. Se rechazan entidades ajenas al proyecto y se aplican límites de texto y resultados.

El pipeline publica los candidatos como `memoryEvents`; la API se exporta desde el índice público. Se agregan pruebas para olvido explícito, recuerdo, recuperación, negación de olvido, nombres ambiguos, offsets y validación de proyecto, además de una prueba de integración.

**Límites deliberados:** no deduce olvido por silencio, falta de mención, paso del tiempo o contradicción. No concluye que un recuerdo sea verdadero, que se haya borrado de forma permanente ni que un personaje haya recuperado toda la memoria. La negación simple `no olvidó` y `nunca olvidó` no se clasifica como olvido. Los patrones son un primer detector léxico en español, no un analizador semántico general.

**Validación:** los archivos y pruebas están publicados en la rama; no se afirma que TypeScript, build o suite hayan pasado hasta ejecutar comprobaciones reales sobre el head actualizado.


## Fase X: línea temporal de memoria autobiográfica explícita

Se añade `typescript/src/narrative-memory-timeline.ts` y la API `buildNarrativeMemoryTimeline(input)`. La proyección agrupa los eventos explícitos por personaje y contenido normalizado, conserva todos los eventos originales y calcula un estado candidato:

- `remembered`: el último evento comparable es un recuerdo explícito.
- `forgotten`: el último evento comparable declara olvido.
- `memory-recovered`: el último evento comparable declara recuperación de memoria.
- `chronology-unresolved`: existen eventos, pero no hay base suficiente para determinar cuál ocurrió después.

La cronología se establece únicamente con offsets dentro de la misma revisión documental o con un orden de documentos entregado expresamente. No se ordenan revisiones distintas de un mismo documento por su número ni se infiere orden por nombre de archivo. Si hay eventos comparables y no comparables mezclados, el estado permanece sin resolver.

El pipeline acepta `priorMemoryEvents` y devuelve `characterMemoryTimelines`; el módulo se exporta desde el índice público. Se añaden seis pruebas unitarias y una integración para olvido posterior, recuperación, cronología desconocida, orden explícito, revisiones distintas y validación de proyecto/personaje.

**Límites:** la línea temporal solo proyecta expresiones léxicas detectadas; no diagnostica pérdida de memoria, no demuestra la veracidad del recuerdo, no infiere qué información quedó borrada ni interpreta el silencio como olvido. El historial original permanece intacto aunque la proyección actual cambie.

**Validación:** los cambios y pruebas están publicados; no se afirma que build, TypeScript o suite hayan pasado sin ejecución real en el head.

## Fase Y: vínculos explícitos entre memoria y acción

Se incorpora `typescript/src/narrative-memory-action-links.ts` con `linkNarrativeMemoryToActions(input)`. El módulo relaciona un evento de memoria con una acción posterior únicamente cuando ambos pertenecen al mismo personaje, proyecto, documento y revisión, y están dentro de una ventana textual acotada.

La salida distingue:
- `explicit-causal-link`: existe un conector causal literal entre el recuerdo y la acción (por ejemplo, «por eso», «por ello», «debido a que» o «porque»).
- `temporal-cooccurrence`: existe una marca de secuencia temporal («después», «entonces», «luego», «más tarde») o ambos hechos aparecen en la misma oración sin un conector causal reconocido.
- `unresolved`: la proximidad no permite establecer una relación más precisa.

Se conservan por separado la evidencia del recuerdo, la acción y el conector. Solo se enlazan acciones afirmadas y recuerdos/recuperaciones explícitos del mismo actor; los eventos de olvido no se reinterpretan como recuerdos. El pipeline publica el resultado como `memoryActionLinks`, valida el tamaño de `priorMemoryEvents` y el módulo se exporta desde el índice público.

Se añaden pruebas de integración para causalidad explícita, secuencia temporal, actor distinto, recuerdo negado, offsets absolutos y proximidad entre oraciones sin conector causal. También se prueba el caso de varios recuerdos candidatos: se conservan todos y la relación queda `unresolved`, sin escoger arbitrariamente el más cercano.

**Límites:** no se deduce causalidad a partir de la mera sucesión. Una relación temporal o una coincidencia en la misma oración no prueba que el recuerdo haya motivado la acción. La detección depende de conectores españoles explícitos y del extractor actual de acciones actor → verbo → objetivo; no cubre acciones intransitivas ni sujetos omitidos. La salida sigue siendo candidata y revisable.

**Validación:** los cambios y pruebas están publicados en la rama. No se afirma que TypeScript, build o suite hayan pasado sin ejecutar comprobaciones reales sobre el head actualizado.

## Fase Z: integración de objetivos y motivaciones en el pipeline

Se detectó que el extractor `narrative-character-intent-extraction.ts` existía, pero no se ejecutaba desde `understandNarrativeFragment`. Se integró para que la comprensión coordinada incluya `characterIntents` sin requerir una llamada separada.

- Se devuelven objetivos y motivaciones explícitos atribuidos a personajes nombrados inequívocamente.
- Se conserva la polaridad `affirmed`, `negated` o `conditional`, el texto capturado y la evidencia con offsets UTF-16 absolutos.
- Los candidatos se asignan a escenas solo cuando su evidencia queda dentro de una escena explícita; los demás quedan sin asignar.
- Se añadieron pruebas de integración para objetivo afirmado, objetivo negado, offsets absolutos y asignación de escena.

**Límites:** el extractor sigue usando patrones léxicos españoles acotados y exige el personaje nombrado en la misma oración. No interpreta automáticamente deseos implícitos, objetivos compartidos, contradicciones entre metas, jerarquías de objetivos ni cambios de motivación. La detección de un objetivo no demuestra que el personaje actúe para cumplirlo.

**Validación:** los cambios y pruebas están publicados en la rama. No se afirma que el build, type-check o suite se hayan ejecutado correctamente; se requiere CI sobre el head actualizado.

## Fase AA: evolución conservadora de objetivos y motivaciones

Se incorpora `narrative-character-intent-evolution.ts` con `evolveNarrativeCharacterIntents(input)`, conectado a `understandNarrativeFragment` como `characterIntentEvolution`. La entrada opcional `priorCharacterIntents` permite comparar objetivos y motivaciones conservados por la biblioteca entre capítulos.

La clasificación distingue:
- `maintained`: el mismo objetivo afirmado vuelve a aparecer y existe un antecedente único.
- `withdrawn`: el mismo objetivo previo aparece explícitamente negado, o una frase de abandono nombra literalmente la meta anterior.
- `replaced`: la frase actual contiene un marcador explícito de sustitución y menciona literalmente el objetivo anterior.
- `conditional`: la intención actual está expresada como condición.
- `coexisting`: hay una meta anterior, pero el texto no demuestra que haya sido abandonada o sustituida.
- `ambiguous-predecessor`: existen varios antecedentes compatibles; se conservan todos.
- `chronology-unresolved`: falta un orden documental fiable para comparar capítulos.

Se validan proyecto, identidad del personaje, estructura de evidencias y límites de entrada. La cronología entre documentos solo se utiliza cuando el proyecto entrega `orderedDocumentIds`; dentro del mismo documento se exige misma revisión y orden de offsets. Se conserva evidencia del objetivo actual y de todos los antecedentes seleccionados.

Se añaden nueve pruebas unitarias y una prueba de integración del pipeline, incluida la ambigüedad entre revisiones y el abandono explícito de una meta anterior.

**Límites deliberados:** una meta diferente no sustituye por sí sola a una anterior; se considera coexistencia salvo marcador explícito. La retirada se detecta cuando el mismo objetivo aparece negado, no por inferencia psicológica. La señal de reemplazo requiere que el texto de la meta anterior aparezca en la misma evidencia. El sistema no jerarquiza metas, no deduce metas implícitas ni decide si una motivación es sincera. Los resultados siguen siendo candidatos revisables.

**Validación:** cambios, exportación pública, pruebas y documentación publicados en la rama. No se afirma que build, type-check o suite hayan pasado; deben verificarse mediante CI sobre el head actual.

## Fase AB: contraste entre objetivos expresos y acciones observables

Se añade `narrative-intent-action-consistency.ts` con `compareNarrativeIntentsWithActions(input)`, integrado en `understandNarrativeFragment` como `intentActionConsistency`.

La comparación:
- Exige el mismo personaje como titular de la intención y actor de la acción.
- Exige mismo proyecto, documento y revisión; además, la acción debe aparecer después del rango textual de la intención.
- Busca un objetivo/personaje destinatario explícito en la frase de intención y lo contrasta con el objetivo de la acción.
- Clasifica `supports-intent`, `opposes-intent`, `unrelated-action`, `intent-negated`, `conditional-intent`, `ambiguous-target` y `not-comparable`.
- Usa un vocabulario limitado de equivalencias y oposiciones verbales expresas. No generaliza una contradicción a partir de verbos sin relación demostrable.
- Conserva la evidencia de intención y acción por separado y deja todos los resultados como candidatos.

Se agregan diez pruebas unitarias y una prueba de integración del pipeline para un objetivo de protección seguido por una acción explícita de traición. Las pruebas cubren además objetivos no coincidentes y evidencias obsoletas.

**Límites:** una acción opuesta no demuestra engaño, hipocresía, intención oculta ni que el personaje haya abandonado su meta. Una acción negada no se trata como realizada. La comparación no cruza capítulos ni revisiones en esta fase; tampoco evalúa acciones pronominales todavía. Type-check, build y suite completa requieren ejecución CI sobre el head actualizado.

## Fase AC: contraste de objetivos con acciones pronominales y continuidad entre capítulos

Se amplía `compareNarrativeIntentsWithActions` para recibir `priorIntents` y `orderedDocumentIds`. El pipeline entrega los objetivos históricos mediante `priorCharacterIntents` y combina las acciones nominales con las acciones pronominales que ya fueron resueltas y vinculadas a un objetivo explícito.

Dos vías quedan habilitadas:
1. **Acción pronominal en el mismo fragmento:** una referencia como «Ella traicionó a Elian» solo participa si la resolución pronominal identifica un único personaje y el vínculo posterior identifica un único destinatario.
2. **Objetivo histórico frente a acción posterior:** un objetivo de otro capítulo se compara con acciones del capítulo actual únicamente si ambos documentos aparecen en el orden declarado por `orderedDocumentIds`.

Se conserva la regla de cronología local: dentro del mismo documento se exige misma revisión y que la acción aparezca después del objetivo. Entre documentos se exige orden explícito. Si no existe orden fiable, no se crea una comparación.

Se añaden seis pruebas unitarias nuevas en total: dos de cronología entre capítulos, dos de validación de duplicados y dos salvaguardas adicionales de integración; además, dos pruebas de integración del pipeline para acción pronominal y objetivo histórico.

**Límites:** las referencias pronominales ambiguas o sin resolver no se convierten en acciones atribuidas; los objetos omitidos no se inventan; una oposición sigue sin demostrar engaño, hipocresía o cambio psicológico. La biblioteca debe suministrar los objetivos anteriores y el orden documental. Build, type-check y suite completa aún requieren validación ejecutada.

### Nota de validación Unicode
La ejecución anterior de CI falló en la prueba que extrae un nombre con marca combinante después del indicador capitalizado «Personaje». El fallo se originaba en el filtro preliminar, que buscaba los indicadores sin modo insensible a mayúsculas. En el código actual, ese filtro usa `iu`, y la prueba existente cubre la forma capitalizada. Esta corrección está presente en la rama, pero todavía necesita una ejecución nueva de CI para considerarse verificada.

## Fase AD: adquisición de motivaciones indirectas explícitas

Se amplía `extractNarrativeCharacterIntentCandidates` para reconocer construcciones causales y de propósito aunque no utilicen verbos directos como «quiere» o «desea».

- Motivos causales expresos: «por miedo a», «por temor a», «por amor a», «por lealtad a», «por venganza contra», «por deber hacia», «por culpa de», «por compasión hacia» y formas verbales explícitas como «porque teme».
- Propósitos expresos: «para», «a fin de» y «con el fin de».
- Cada candidato incluye `evidenceBasis`: `explicit-goal-verb`, `explicit-causal-motive` o `explicit-purpose`.
- Los rangos de evidencia conservan el texto que expresa el motivo o propósito; la evidencia de contexto conserva la oración completa.
- Los propósitos se clasifican como objetivos, no como motivaciones psicológicas.
- Una acción sin marcador causal o de propósito no genera una motivación inventada.
- Se añaden tres pruebas unitarias y una prueba de integración en el pipeline.

**Límite deliberado:** el sistema registra la relación causal o final expresada por el narrador/personaje, pero no decide si es verdadera, sincera, la causa principal o una racionalización. Tampoco infiere motivaciones a partir de conductas aisladas. Los candidatos siguen sujetos a revisión.

## Fase AE: evolución explícita de motivaciones

Se refuerza la continuidad de motivaciones entre capítulos sin interpretar automáticamente cada diferencia como un cambio interno.

- La evolución conserva la clase `motivation` y puede reconocer una motivación idéntica como mantenida.
- Una motivación distinta solo se marca como reemplazada cuando el texto aporta una señal explícita de cambio (por ejemplo, «cambió de motivación») y menciona la motivación anterior.
- Se conserva por separado la evidencia de la motivación previa, la motivación actual y el marcador textual de transición.
- Sin marcador explícito, dos motivaciones diferentes coexisten como candidatas; no se presupone que una haya eliminado a la otra.
- La comparación entre capítulos sigue exigiendo `orderedDocumentIds`; no se infiere cronología a partir del nombre o número de capítulo.

Durante esta fase también se corrigieron dos expresiones regulares de la fase AD que tenían escapes duplicados y no reconocían límites de palabra. Se añadieron pruebas para motivos causales, propósitos compuestos, continuidad y sustitución explícita de motivaciones, incluida una integración completa del pipeline.

**Límite:** «reemplazada» describe una relación textual entre candidatos, no demuestra que el personaje haya dejado de sentir realmente la motivación anterior. Todos los resultados continúan como candidatos revisables.

## Fase AF: integridad de cláusulas motivacionales causales

- Se corrigió el patrón de extracción de construcciones «porque quiere/desea/teme/necesita…» para conservar el verbo que expresa el estado motivacional.
- Ejemplo: «Mara actúa porque teme perder a su familia» produce el contenido «teme perder a su familia», no solo «perder a su familia».
- La evidencia continúa delimitando exactamente la cláusula extraída en offsets UTF-16 del documento.
- Se añadió una prueba de integración del pipeline para impedir que futuras modificaciones eliminen el verbo causal.
- Esta corrección no amplía la inferencia psicológica: solo conserva íntegra la formulación explícita del narrador.
- La ejecución CI para el head actualizado sigue pendiente; no se declara aprobada la suite.

 
## Fase AG: separación de metas, motivos y propósitos en cláusulas coordinadas

Se corrigió una pérdida de precisión detectada en oraciones con más de una relación narrativa explícita. Antes, una captura de objetivo podía absorber la cláusula causal o final completa («quiere proteger a Elian porque teme perderlo»).

- El extractor separa la meta principal de una cláusula introducida por «porque», «ya que» o «puesto que».
- También separa el objetivo del propósito introducido por «para», «a fin de» o «con el fin de».
- Cada candidato conserva su propia clase, señal de evidencia y rango literal UTF-16.
- Se permite más de un candidato por oración cuando el texto expresa relaciones distintas; candidatos duplicados con el mismo ID se consolidan.
- Se agregan pruebas unitarias para meta + motivación y meta + propósito, además de integración en el pipeline.

Ejemplos esperados:
- «Mara quiere proteger a Elian porque teme perderlo»: objetivo «proteger a Elian» y motivación «teme perderlo».
- «Mara quiere proteger a Elian para salvar el reino»: objetivo «proteger a Elian» y propósito «salvar el reino».

Límite: la separación es lingüística y conservadora. No decide si el motivo declarado es verdadero, sincero, principal o suficiente; tampoco deduce motivos que no estén expresados.

Validación: pruebas añadidas y publicadas; build, type-check y suite completa aún deben ejecutarse sobre el head actualizado.

 
### Corrección de atribución actor–objetivo (incluida en Fase AG)

La validación de la fase reveló que el extractor podía confundir la mención del personaje objetivo con una segunda identidad actora. Ahora el candidato actor se determina por su posición anterior al marcador de intención: en «Mara desea ayudar a Elian», Mara es el actor y Elian el objetivo. Si dos personajes aparecen antes del marcador, el extractor se abstiene. Se actualizó la prueba de ambigüedad y se añadió una prueba específica actor/objetivo.


## Fase AH: ampliación de evidencia causal explícita entre acontecimientos

Se amplió el vocabulario de conectores que permite proponer una relación de consecuencia entre acontecimientos consecutivos. Se reconocen ahora, además de los conectores existentes, «debido a ello», «debido a eso», «a causa de ello» y «por esa causa».

- La relación solo se propone cuando el conector aparece al inicio del acontecimiento consecuente.
- Se conserva el fragmento literal del conector y sus offsets UTF-16.
- La relación sigue siendo un candidato revisable (explicit-consequence-marker), nunca una causalidad confirmada por el sistema.
- La mera sucesión temporal («después», «más tarde») no produce una relación causal.
- Se mantiene la barrera de párrafo: no se enlazan acontecimientos a través de un salto de párrafo en blanco.

Se añadieron cuatro casos de prueba para las variantes nuevas. La validación completa del proyecto debe ejecutarse sobre el último commit; no se declara CI aprobado.


## Fase AI: hipótesis de asociación temporal sin afirmar causalidad

Se amplió el análisis de relaciones entre acontecimientos para conservar una señal débil que antes se descartaba: dos acontecimientos consecutivos pueden compartir un participante y estar unidos por un marcador temporal («poco después», «inmediatamente después», «al instante», «acto seguido», «a continuación», «después» o «entonces»).

El motor puede registrar esa relación como:
- `relationType: "temporal-association-hypothesis"`
- `causalStatus: "unproven-hypothesis"`

Condiciones: mismo documento y revisión, participante compartido, marcador temporal al inicio del segundo acontecimiento y ausencia de salto de párrafo en blanco. No duplica un vínculo explícito para el mismo par.

Los vínculos causales expresos mantienen `relationType: "explicit-consequence-marker"` y `causalStatus: "explicitly-signaled-candidate"`. Ninguno confirma causalidad objetiva: la primera categoría es solo proximidad temporal con participante compartido; la segunda es una señal lingüística expresa todavía revisable.

Se añadieron tres pruebas para detección, abstención sin participante compartido y separación entre sucesión temporal y causalidad explícita.


### Corrección de robustez de Fase AI

La revisión posterior detectó que las expresiones regulares de la hipótesis temporal debían comprobarse con pruebas específicas de los escapes y los límites de párrafo. Se normalizaron para reconocer espacios y saltos de línea reales, y se añadieron salvaguardas de entrada: IDs de acontecimientos no vacíos y únicos, participantes como colección válida de identificadores y evidencia textual coincidente. Se agregaron pruebas para impedir hipótesis que crucen párrafos y para rechazar eventos duplicados o malformados.

Esta corrección fortalece la abstención: una hipótesis no se crea si el contexto estructural o la identidad de los participantes no es fiable.


### Precisión adicional: identidad de personajes frente a objetos compartidos

La hipótesis temporal ya no utiliza cualquier entidad compartida como si fuera un participante humano. Los acontecimientos conservan ahora dos conjuntos distintos:
- `participantEntityIds`: todos los participantes explícitos (personajes y otras entidades).
- `characterParticipantEntityIds`: únicamente entidades cuyo tipo en el catálogo del proyecto es `character`.

La asociación temporal débil exige coincidencia en el segundo conjunto. Así, dos acontecimientos que mencionan la misma puerta, arma o ciudad, pero personajes distintos, no generan una hipótesis de continuidad entre personajes. La extracción deriva esta lista del catálogo de entidades y valida que cada personaje incluido también pertenezca al conjunto general de participantes.

Se añadieron pruebas para el caso de objeto compartido y para listas de personajes incoherentes. La prueba de salto de párrafo fue corregida para utilizar saltos reales, no los caracteres literales `\\n`.


La clasificación de IDs de personajes se calcula una sola vez por extracción de eventos y se reutiliza al construir cada acontecimiento, evitando repetir el recorrido del catálogo para cada oración. La prueba de extracción de eventos verifica explícitamente que los personajes se separen de los objetos.


### Fase AJ: procedencia doble y explicación de relaciones narrativas

Las relaciones entre acontecimientos ahora conservan la evidencia de ambos extremos, no solo el texto del conector. Cada candidato incluye:
- `supportingEvidence.sourceEvent`: documento, revisión, rango UTF-16 y fragmento literal del acontecimiento de origen.
- `supportingEvidence.consequenceEvent`: los mismos datos para el acontecimiento posterior.
- `hypothesisBasis`: distingue `explicit-linguistic-connector` de `temporal-marker-and-shared-character`.
- `sharedCharacterEntityIds`: personajes concretos que sustentan una asociación temporal débil; para conectores explícitos se mantiene vacío, porque la señal principal es el conector escrito.

La evidencia original se conserva sin reconstruir ni parafrasear. Esto permite que una interfaz explique por qué se propuso una relación, muestre los dos fragmentos y permita al escritor aceptar, rechazar o corregir el candidato sin perder su procedencia.

La validación rechaza identidades duplicadas en los conjuntos de participantes y exige que los personajes pertenezcan al conjunto general de participantes. Se añadieron pruebas para la procedencia exacta de ambos acontecimientos y para participantes duplicados.

**Límite:** ni un conector explícito ni una marca temporal prueban causalidad objetiva. Los dos tipos siguen siendo candidatos revisables; el campo `hypothesisBasis` explica la señal detectada, no una conclusión sobre el mundo narrativo.


### Fase AK: relaciones conectadas con las acciones que las componen

Los candidatos de relación entre acontecimientos incorporan ahora `supportingActionCandidateIds`, con dos listas separadas: acciones explícitas del acontecimiento de origen y acciones explícitas del acontecimiento posterior. Los IDs se conservan como referencias a los candidatos de acción ya extraídos; no se reinterpretan ni se convierten en una afirmación causal.

Esto permite que el siguiente nivel de razonamiento consulte, para una relación propuesta, qué hizo explícitamente cada personaje y qué evidencia textual respalda esas acciones. También evita perder la conexión entre el grafo de acontecimientos y el grafo actor-acción-objetivo.

La validación de acontecimientos exige que los IDs de acción sean cadenas no vacías y únicas, igual que las listas de participantes. Se añadieron pruebas para comprobar la conservación de las acciones de ambos extremos y para rechazar IDs de acción duplicados o mal formados.

**Límite de inferencia:** disponer de acciones en ambos extremos no significa que una acción haya causado la otra. Esta fase únicamente preserva referencias estructuradas para análisis posterior y revisión humana.


### Fase AL: cruce entre objetivos, acciones y relaciones de acontecimientos

El pipeline incorpora `consequenceIntentActionLinks`, una capa de enlaces que cruza:
1. una relación candidata entre dos acontecimientos;
2. la acción explícita de uno de esos acontecimientos;
3. la comparación ya existente entre un objetivo/motivación y esa acción;
4. las evidencias literales del objetivo y de la acción.

Cada enlace identifica el acontecimiento de origen o el posterior (`eventRole`), el candidato de relación, la comparación objetivo-acción, el personaje, la intención, la acción y el tipo de consistencia (por ejemplo, `supports-intent` u `opposes-intent`). No recalcula ni modifica la clasificación de consistencia: conserva su resultado y sus evidencias.

Esto permite consultas como: «¿Qué relación entre acontecimientos contiene una acción que respalda un objetivo declarado por este personaje?» o «¿Qué acción contradice ese objetivo?». La respuesta es una conexión entre evidencias existentes, no una afirmación de que el objetivo causó el acontecimiento ni de que el personaje actuó sinceramente.

Se añadió una prueba de integración que recorre un ejemplo completo: objetivo explícito, primera acción, segunda acción, conector entre acontecimientos y enlaces a las dos comparaciones objetivo-acción. Comprueba que cada ID enlazado exista en los resultados del pipeline y que se conserve el tipo de consistencia.


### Fase AM: precedencia entre conocimiento atribuido y acciones del personaje

Se incorpora el módulo `narrative-knowledge-action-links.ts` y su salida integrada `knowledgeActionLinks`. Cada enlace relaciona un elemento de conocimiento atribuido explícitamente a un personaje con una acción afirmativa posterior del mismo personaje.

La precedencia solo se acepta cuando puede demostrarse:
- dentro del mismo documento y revisión, si el final de la evidencia del conocimiento precede al inicio de la acción;
- entre documentos distintos, únicamente si el proyecto proporciona `orderedDocumentIds` y el documento de la acción aparece después.

No se enlazan evidencias obsoletas, acciones negadas, acciones de otros personajes ni documentos cuya cronología sea desconocida. Cada enlace conserva los IDs, la evaluación epistemológica disponible, el canal y estado de la información, y las evidencias literales de conocimiento y acción. Los canales y evaluaciones se preservan como datos, no como garantía de verdad o comprensión.

La relación se denomina `knowledge-precedes-action`: indica precedencia verificable, no que el personaje haya usado esa información para decidir ni que esta haya causado la acción. Se añadieron pruebas unitarias para cronología local y entre documentos, abstención ante orden desconocido, evidencia obsoleta, negación, actor distinto y entradas duplicadas; también una prueba de integración del pipeline principal.


**Endurecimiento de la Fase AM:** la validación también exige un único estado por personaje e IDs de información globalmente únicos, para impedir colisiones en los identificadores de enlace. El límite de trabajo se aplica al total de elementos de conocimiento más acciones, no solo al número de estados. Las pruebas cubren estados de personaje duplicados e IDs repetidos entre personajes.


### Fase AN: triangulación de contexto de decisión

Se añade `narrative-decision-context.ts` y la salida integrada `decisionContexts`. Esta capa cruza tres referencias independientes:
- información atribuida al personaje que precede a una acción (`knowledgeActionLinks`);
- intención explícita del mismo personaje comparada con esa acción (`intentActionConsistency`);
- la acción exacta compartida por ambos análisis.

El candidato conserva las tres evidencias textuales, los IDs de información, intención, acción y personaje, además de la alineación obtenida por el comparador existente: `supports-intent`, `opposes-intent`, `conditional-intent` u `other-or-undetermined`.

La triangulación exige coincidencia exacta de proyecto, personaje y acción. No combina conocimiento de un personaje con acciones de otro ni comparaciones de una acción distinta. La cronología de intención-acción procede de la comparación existente, que solo acepta posición posterior en la misma revisión o un orden explícito entre documentos.

**Límite semántico:** el resultado es un contexto de decisión documentado, no una decisión mental confirmada. No afirma que el personaje recordara conscientemente la información, que la considerara verdadera, que deliberara sobre ella ni que esta causara la acción. La etiqueta de alineación describe la comparación lingüística ya existente, no una evaluación moral o psicológica.

Se añadieron pruebas unitarias para alineación favorable, oposición, condición, coincidencia de actor y acción, referencias inválidas y duplicadas; además de una prueba de integración que recorre el pipeline principal desde conocimiento e intención hasta la acción.

**Endurecimiento de trazabilidad de Fase AN:** cuando dos análisis declaran compartir el mismo ID de acción, el módulo exige que documento, revisión, rango y fragmento textual de la evidencia de esa acción sean idénticos. Si no coinciden, rechaza la triangulación en lugar de fusionar referencias posiblemente distintas. Se agregó una prueba específica para esta condición.


### Fase AO: evolución observable de la conducta

Se incorpora `src/narrative-behavior-evolution.ts` y la salida `behaviorShifts` del pipeline. La entrada admite `priorActions` para conservar acciones de capítulos o fragmentos anteriores. El módulo compara acciones afirmadas del mismo actor hacia el mismo objetivo, con dos reglas cronológicas:
- dentro del mismo documento y revisión, por posición textual no solapada;
- entre documentos, solo cuando `orderedDocumentIds` declara el orden. Si hay varias revisiones de un mismo documento dentro de la comparación interdocumental, esa transición no se fuerza.

Se distinguen inversiones de valencia léxica (apoyo-hostilidad y sus variantes) de cambios de patrón entre verbos. La valencia es una clasificación tentativa del verbo, no el estado emocional, la personalidad ni la relación real entre personajes. Las acciones negadas no se tratan como conducta afirmada.

Cada cambio conserva las dos acciones, sus IDs y evidencias, y puede adjuntar al comportamiento nuevo referencias a conocimiento previo, contexto de decisión, enlaces de memoria y evolución de objetivos. Se validan proyecto, actores, objetivos, unicidad de IDs y coincidencia exacta de la evidencia de acción compartida.

**Límite de interpretación:** detectar que alguien pasó de atacar a ayudar no explica por qué lo hizo. Un enlace de memoria con conector explícito se conserva como señal textual, pero el conjunto de contextos se presenta como material de revisión; no se asigna causalidad psicológica, arrepentimiento, engaño ni cambio de personalidad. La falta de antecedentes o de orden documental produce abstención, no una secuencia inventada.

Las pruebas cubren cambios dentro de una revisión, orden entre capítulos, ausencia de orden, acciones negadas, repetición, cambio de patrón, señales contextuales, evidencia incompatible, IDs duplicados y ambigüedad entre revisiones. Se añadió además una prueba de integración desde `understandNarrativeFragment`.

**Endurecimiento adicional de Fase AO:** las referencias contextuales deben tener IDs únicos y pertenecer al mismo proyecto; sus evidencias de acción deben coincidir exactamente con la acción comparada. Se validan también el tipo de relación, los fragmentos de memoria y las transiciones de objetivos. Una señal de memoria meramente temporal se etiqueta como enlace de memoria, nunca como conector explícito. El pipeline valida el tamaño y la forma de `priorActions` antes de iniciar el análisis.


### Fase AP: atribución explícita de candidatos de idea a fichas narrativas

Se incorpora `narrative-idea-entity-attribution.ts` y se integra en `understandNarrativeFragment` como `ideaEntityAttributions`.

La capa conecta cada idea candidata con las fichas del mismo proyecto únicamente cuando el nombre canónico o un alias aparece literalmente antes del fragmento que expresa la idea, dentro de la misma evidencia oracional. Esta regla evita atribuir al personaje que aparece como objetivo («Mara desea ayudar a Elian») la intención que el texto atribuye a Mara.

Estados publicados:
- `attributed`: una sola identidad explícita; incluye `entityId`.
- `ambiguous`: dos o más identidades compatibles; conserva todos los IDs y no elige una.
- `unattributed`: no hay titular explícito o la evidencia no permite localizar de forma inequívoca el texto candidato.

Cada resultado conserva el ID de la idea, proyecto, documento, revisión, nombres coincidentes y evidencia original. La salida es una propuesta de asociación: no escribe `relatedEntityIds`, no modifica la biblioteca y no convierte la idea en canon.

Se validan límites de ideas, entidades, alias y evidencia; se rechazan proyectos cruzados, IDs duplicados y entradas malformadas. Se añadieron pruebas para atribución del titular, exclusión del objetivo, ambigüedad entre personajes, alias compartidos, ausencia de titular, coincidencias repetidas e integración del pipeline.

**Límite deliberado:** la atribución exige que el nombre aparezca antes de la idea en la misma oración. No resuelve pronombres, sujetos omitidos, coreferencia entre oraciones ni titulares implícitos. En esos casos se abstiene; no intenta deducir la autoría por cercanía.


### Fase AQ: relaciones explicables entre ideas de distintos capítulos

Se añade `narrative-idea-cross-document-relations.ts` y el resultado `ideaCrossDocumentAnalysis` al pipeline `understandNarrativeFragment`. El anfitrión puede aportar hasta 100 candidatos previos mediante `priorIdeaCandidates`; el fragmento actual aporta sus propios candidatos. La comparación conjunta admite hasta 200 elementos por ejecución.

Se separan dos señales:
- `exact-recurrence`: texto equivalente tras normalizar Unicode NFKD, mayúsculas/minúsculas, diacríticos, puntuación y espacios.
- `lexical-resonance`: coincidencia de al menos dos términos de contenido que supera un umbral de Jaccard o de solapamiento. Se excluyen palabras funcionales en español e inglés y términos presentes en demasiados documentos del lote.

Cada relación conserva los dos candidatos, documento, revisión, tipo de idea, modalidad, texto y evidencias originales. Añade `polarityRelation` para señalar si la modalidad cambió entre apariciones, sin etiquetar el cambio como contradicción objetiva. Expone los términos compartidos y las métricas para que el resultado sea explicable. Los pares del mismo documento no se relacionan, incluso si pertenecen a revisiones distintas. Los IDs y el orden de salida son deterministas.

La cronología solo se orienta cuando ambos documentos figuran en `orderedDocumentIds`; de lo contrario queda como `unknown`. La salida permanece en estado `candidate`, no crea enlaces canónicos, no fusiona ideas y no escribe en IndexedDB ni en la biblioteca personal. La resonancia léxica no demuestra que dos expresiones sean paráfrasis, sinónimos o la misma idea. La revisión humana sigue siendo necesaria para esa decisión.

Límites de recursos: máximo 200 candidatos, 500 unidades UTF-16 por texto de idea, 10.000 relaciones publicadas y señal explícita `truncated` si el límite de resultados recorta la lista. Se cuentan los pares comparados entre documentos para permitir diagnóstico del coste.

Se agregan trece pruebas para recurrencia normalizada, resonancia, coincidencia insuficiente, aislamiento por documento, cronología explícita/desconocida, filtrado de términos frecuentes, determinismo, cambios de modalidad, entradas inválidas, truncamiento, procedencia de evidencia, normalización de espacios e integración con candidatos previos en el pipeline.


### Fase AR: reconstrucción de la evolución de ideas

Se incorpora `narrative-idea-evolution.ts` y el resultado `ideaEvolution` al pipeline coordinado. La capa convierte las relaciones entre capítulos en eventos explícitos y resumidos:

- `reappeared`: recurrencia de formulación normalizada con cronología documental explícita.
- `echoed`: resonancia léxica con cronología documental explícita.
- `observed-without-order`: relación comprobable entre dos apariciones, pero sin orden suficiente para afirmar cuál ocurrió primero.

Cada evento conserva las dos apariciones, sus IDs, documentos, revisiones, textos y evidencias. Cuando existe orden explícito, publica `earlierOccurrence` y `laterOccurrence`. Los cambios de modalidad y de clase expresiva se muestran como señales separadas; no se denominan contradicción, sustitución ni cambio de significado confirmado.

El resumen cuenta recurrencias, ecos, relaciones sin cronología, cambios de modalidad y cambios de clase. También propaga la señal de truncamiento del análisis de relaciones para que una vista parcial no se presente como historia completa.

La capa solo lee candidatos y relaciones. No cambia el estado editorial `IDEA / incorporated / discarded`, no escribe `statusHistory`, no archiva ni elimina entradas y no modifica la biblioteca personal. La ausencia de una relación tampoco demuestra que una idea sea nueva, abandonada o inexistente: la memoria previa suministrada puede ser parcial.

Se endureció la validación de relaciones para comprobar proyectos, IDs únicos, documentos diferentes, evidencia compatible, métricas y coherencia entre la modalidad de cada extremo y `polarityRelation`. Se agregaron trece pruebas para reaparición exacta, eco léxico, cronología desconocida, modalidad, tipo expresivo, truncamiento, determinismo, aislamiento de proyecto, referencias incoherentes, texto normalizado incompatible, modalidad inconsistente, conservación de espacios literales e integración con el pipeline.
