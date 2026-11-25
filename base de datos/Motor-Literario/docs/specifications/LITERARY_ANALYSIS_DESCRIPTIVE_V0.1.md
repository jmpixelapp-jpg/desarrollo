# Análisis literario descriptivo — v0.1

**Estado:** módulo implementado en TypeScript; análisis determinista y local.  
**Rama:** `main`  
**Ámbito:** fragmento de un documento abierto, ligado a `projectId`, `documentId` y revisión.  
**Offsets:** UTF-16, compatibles con el editor JavaScript.

## Alcance

El análisis entrega métricas de longitud, mediana y dispersión de oraciones, variación entre oraciones consecutivas, ritmo de párrafo, diversidad léxica superficial, densidad estimada de diálogo, segmentos de diálogo con longitud y formato, señales gramaticales explícitas de persona, palabras y frases literales recurrentes de 2 a 4 términos, aperturas de oración recurrentes, candidatos a anáfora en oraciones consecutivas, vocabulario sensorial explícito por modalidad y puntuación expresiva.

Las señales gramaticales excluyen tramos de diálogo reconocidos por comillas o líneas que empiezan con raya. Las ocurrencias devuelven offsets absolutos. El motor limita las muestras gramaticales a 40, los términos repetidos a 12 y las aperturas a 8; limita también los offsets visibles por patrón.

## Integración

`HostEngineApi.analyzeLiteraryDocument(documentId, start?, end?)` termina primero las ediciones admitidas y luego analiza el rango solicitado de la instantánea vigente. No escribe en IndexedDB, no altera el texto y no crea diagnósticos de corrección. Cada resultado queda ligado a proyecto, documento y revisión.

Desde `typescript/`:

```sh
npm run typecheck
npm test
```

## Límites metodológicos

- El perfil de ritmo usa promedio, mediana, dispersión y umbrales; los saltos entre longitudes son candidatos de contraste, no una valoración estética de la prosa.
- La detección de diálogo reconoce comillas angulares, curvas, rectas y líneas con raya. Otros estilos editoriales pueden no detectarse.
- La perspectiva gramatical cuenta pronombres explícitos fuera del diálogo; no identifica narrador, focalización ni persona verbal implícita.
- La diversidad léxica usa formas normalizadas y no desambigua homónimos, flexiones ni función sintáctica.
- Las aperturas recurrentes se calculan con las dos primeras palabras de cada oración y pueden reflejar conectores frecuentes.
- Las frases recurrentes exigen coincidencia literal de 2 a 4 términos dentro de la misma oración y al menos dos palabras de contenido; son candidatos de repetición textual, no motivos semánticos.
- La anáfora es un candidato cuando coinciden literalmente las dos primeras palabras de al menos dos oraciones consecutivas.
- El vocabulario sensorial usa listas explícitas de palabras por modalidad; no reconoce sentidos implícitos, metáforas ni sinestesias.
- El análisis acepta como máximo 2.000.000 de unidades UTF-16 por operación; manuscritos más extensos deben consultarse por rangos y revisión.

Estas métricas son indicios para inspección del escritor. No son correcciones obligatorias y nunca autorizan cambios automáticos en el manuscrito.


## Ritmo y transiciones

La distribución clasifica las oraciones en cortas (hasta 8 palabras), medias (9–24) y largas (25 o más). La mediana y la desviación estándar describen el conjunto sin depender solo del promedio. Se propone un contraste entre dos oraciones consecutivas cuando la más larga tiene al menos 16 palabras, supera a la otra por 10 palabras o más y duplica su longitud. El resultado marca aceleración o desaceleración según el sentido del cambio y devuelve ambos rangos UTF-16. Es un indicio para revisar cadencia, no una conclusión sobre intención narrativa.


## Segmentación descriptiva del diálogo

El análisis reconoce contenido entre comillas angulares, curvas o rectas, además de líneas que comienzan con raya. Los rangos solapados se fusionan para evitar contar dos veces una misma intervención. Para cada segmento se informa formato, longitud en palabras y rango UTF-16; las métricas resumen número de segmentos, promedio y longitud máxima. No se asigna un hablante automáticamente: las atribuciones del tipo «dijo Ana» no se convierten en identidad sin un proceso explícito de resolución.


## Estructura explícita de capítulos y escenas

Se reconocen encabezados de parte/libro, capítulo, acto y escena cuando aparecen al inicio de una línea, con o sin prefijo Markdown de encabezado. También se detectan líneas separadoras formadas por tres o más asteriscos, guiones, guiones bajos, signos igual o puntos decorativos. Cada marcador conserva línea y rango UTF-16. Los segmentos de escena comienzan después de un encabezado de escena o separador y terminan ante el siguiente marcador estructural explícito. No se generan escenas desde párrafos, cambios de diálogo, cambios de lugar mencionados en la prosa ni inferencias semánticas. Se devuelven hasta 100 marcadores y 100 segmentos por operación.


## Recurrencia léxica entre escenas

La propiedad `sceneLexicalEchoes` identifica palabras de contenido cuya misma forma normalizada aparece al menos tres veces y está distribuida entre dos o más escenas explícitas. Cada candidato informa la forma literal observada, su forma normalizada, el número de escenas y el total de coincidencias. El desglose por escena conserva el conteo completo y hasta doce ocurrencias UTF-16 absolutas; `evidenceTruncated` señala cuándo el número de muestras es menor que el conteo real.

El análisis recorre las escenas y los tokens en orden textual y limita la salida a veinte candidatos, priorizando cobertura entre escenas y después frecuencia. Solo utiliza las escenas explícitas detectadas en el fragmento, por lo que no rellena escenas ausentes ni compara rangos fuera de la revisión analizada. Para cada palabra expone además conteos separados de narración y diálogo reconocido por escena. `contextClassification` vale `narrative-only`, `dialogue-only` o `mixed`; cada ocurrencia de muestra identifica su contexto. La clasificación depende exclusivamente de los rangos detectados por el reconocedor de diálogo y no atribuye hablantes.

La coincidencia es ortográfica tras normalización Unicode NFKC y conversión a minúsculas. No hay lematización, traducción, agrupación de sinónimos ni inferencia semántica. Una palabra que reaparece puede deberse al vocabulario habitual del texto; el resultado es una pista para inspección, no una afirmación de símbolo, tema, motivo recurrente, intención o relación causal.

## Presencia de personajes en escenas

La API anfitriona entrega al analizador las fichas de personajes del proyecto activo (nombre canónico y alias). En cada escena explícita se localizan coincidencias literales completas, sin distinguir mayúsculas y minúsculas, y se devuelven los IDs de identidad, variantes de nombre y offsets UTF-16. Se exige identidad única del nombre o alias: si dos personajes reclaman la misma forma, esa coincidencia se omite en vez de asignarse por conjetura. El análisis no usa pronombres para atribuir presencia ni interpreta mención como participación, diálogo o focalización. El catálogo acepta hasta 500 fichas por análisis, hasta 40 personajes por escena y hasta 20 ocurrencias por personaje.


## Evidencia de personajes a lo largo de escenas

La propiedad `characterSceneEvidence` construye una serie por personaje y escena explícita a partir de dos fuentes independientes:

- **Mención nominal:** coincidencia literal no ambigua con el nombre canónico o un alias conocido del proyecto dentro del contenido de la escena.
- **Participación documentada:** el ID del personaje figura como participante declarado de un acontecimiento cuya evidencia vigente pertenece al mismo documento y revisión y se solapa con el rango de esa escena.

Cada instantánea conserva ambos estados por separado, los conteos de menciones, los IDs de acontecimientos enlazados y el número de rangos de evidencia coincidentes. El perfil agregado informa escenas con mención, escenas con participación documentada, primera y última escena observadas y cobertura de evidencia por acontecimiento. Una escena puede contener mención sin participación documentada, participación documentada sin mención nominal, ambas o ninguna.

La ausencia de una mención no prueba que el personaje esté ausente. La ausencia de un vínculo de participación significa únicamente que no se encontró una asociación en la evidencia disponible para ese documento y revisión; no demuestra que el personaje no intervino. El vínculo de participante tampoco demuestra presencia física, acción individual, causalidad, diálogo ni transformación psicológica. El perfil describe cobertura documental; no genera automáticamente un arco de personaje ni un juicio sobre su evolución.

Los estados `unknown-due-to-mention-truncation` y `unknown-due-to-event-truncation` se usan cuando los límites de cuarenta menciones expuestas por escena o cien vínculos de acontecimientos impiden concluir que no hay evidencia. `sourceTruncatedSceneIndexes` identifica esas escenas. Los perfiles se limitan a cien y priorizan escenas con participación documentada, después cobertura nominal, frecuencia e ID estable.

## Comparación de atributos explícitos entre escenas

La propiedad `characterAttributeEvolution` compara afirmaciones de edad, ubicación y rol conservadas en el historial narrativo del proyecto. El anfitrión suministra las afirmaciones persistidas y el analizador solo asigna a una escena aquellas cuya evidencia no está marcada como obsoleta y coincide exactamente con el documento y la revisión analizados, además de solaparse con el rango de contenido de la escena.

Cada perfil agrupa una identidad y un atributo. Sus instantáneas por escena muestran los valores observados, el número de afirmaciones y hasta veinte fragmentos de evidencia UTF-16. Las transiciones comparan las escenas consecutivas que sí contienen una afirmación de ese atributo; `interveningSceneCount` informa cuántas escenas explícitas quedan entre ambas. Los estados posibles son `unchanged-value`, `changed-value` y `multiple-values-in-scene`. Los valores textuales se comparan tras normalización NFKC, recorte de espacios y minúsculas; los valores numéricos se comparan exactamente.

Las afirmaciones obsoletas se cuentan como `staleAssertionCount`; las de otros documentos o revisiones como `outOfScopeAssertionCount`; y las de la revisión actual que no se solapan con una escena explícita como `unmappedCurrentAssertionCount`. Estas categorías no se fusionan. El límite es de veinte mil afirmaciones de entrada, doscientos perfiles de salida y veinte muestras de evidencia por escena y atributo.

Un valor diferente se informa como cambio observado, no como contradicción demostrada: puede reflejar paso del tiempo, corrección editorial, una forma distinta de describir el mismo atributo o una incoherencia. Varios valores dentro de una escena se conservan como `multiple-values-in-scene` sin escoger uno. La ausencia de afirmación no prueba que el atributo se mantuviera igual.

Además, `projectTimeline` reúne afirmaciones no obsoletas de todos los capítulos del proyecto que conservan una referencia temporal explícita. Los puntos se agrupan por base (`calendar` o `story-day`), precisión y valor de orden, por lo que las transiciones solo comparan puntos de la misma base y precisión. `projectTimelineTransitions` informa valores sin cambio, cambio observado o varios valores para el mismo punto temporal. Los fragmentos de evidencia conservan documento, revisión y offsets originales; los registros de capítulos distintos del abierto no se asignan a sus escenas actuales.

Las afirmaciones de otros capítulos sin referencia temporal comparable se contabilizan como fuera de alcance y no se ordenan por nombre de archivo, revisión, fecha de captura o posición de guardado. Los años no se mezclan con fechas completas y los contadores de día del mundo narrativo no se mezclan con fechas de calendario. Una referencia temporal explícita organiza la comparación, pero no demuestra por sí sola causalidad ni resuelve contradicciones.

## Grafo global de ideas del proyecto

La propiedad `ideaGraph` resume el catálogo global de ideas del libro a partir de sus referencias dirigidas `relatedIdeaIds`. El anfitrión proyecta el catálogo en `knownProjectIdeas`, con un máximo de 2.000 entradas e informando el excedente mediante `knownProjectIdeasOmittedCount`, independientemente de que cada idea tenga o no un vínculo a un personaje. El subconjunto `knownIdeas` sigue reservado para integrar decisiones en las trayectorias de personajes; esta separación evita que una idea independiente desaparezca del grafo por no estar asociada a una ficha de personaje.

Cada nodo informa su estado editorial, referencias entrantes y salientes dentro de la muestra, referencias salientes cuyo destino no está incluido, historial visible de estados, decisiones del escritor y recuentos de evidencias activas y obsoletas. Cuando `knownProjectIdeasOmittedCount` es mayor que cero, una referencia cuyo destino no está en la muestra se marca como `not-in-snapshot`: puede apuntar a una idea válida omitida y no se declara rota. Cuando no se omitió ninguna idea, la misma situación se marca como `missing-from-project`, porque el catálogo suministrado es completo. `notIncludedReferenceCount` cuenta ambos tipos y `missingFromProjectReferenceCount` aísla las referencias sin destino en un catálogo completo. `knownProjectIdeasOmittedCount` declara cuántas ideas del catálogo global no se transfirieron.

El resumen distingue referencias incluidas y no incluidas, pares recíprocos, nodos de origen, terminales y aislados dentro de la muestra. También identifica ciclos dirigidos (componentes fuertemente conexos) y componentes débilmente conexos, que ignoran la dirección de los vínculos para mostrar grupos de ideas conectadas. `ideaCount`, `statusProfiles` y los recuentos de referencias, ciclos y componentes describen únicamente el snapshot recibido; cuando el catálogo supera las 2.000 ideas, `omittedIdeaCount` declara las ideas no transferidas y el motor no infiere conexiones a través de esos nodos omitidos. Los listados de referencias, ciclos y componentes tienen límites de muestra deterministas; `omittedReferenceSampleCount`, `omittedCycleCount` y `omittedWeakComponentCount` identifican las entradas no visibles por esos límites.

El grafo describe únicamente relaciones declaradas por el escritor. Un ciclo no demuestra contradicción, dependencia causal, secuencia de escritura ni calidad literaria; una idea aislada tampoco implica que carezca de valor. El motor no crea vínculos semánticos ni modifica estados automáticamente.

## Trayectorias narrativas integradas por personaje

La propiedad `characterNarrativeTrajectories` reúne en una sola ficha las señales documentales conocidas de cada personaje del catálogo suministrado al análisis. La integración se realiza por ID estable de entidad, nunca por coincidencia aproximada de nombres. Para cada personaje combina los perfiles de atributos explícitos, las asociaciones participante/acontecimiento con evidencia vigente y los candidatos causales encontrados en el fragmento.

Cada trayectoria expone `attributes` con valores, transiciones y cronologías temporales explícitas por atributo; `eventParticipation` con los acontecimientos declarados y sus escenas de evidencia; y `causalRelations` con candidatos en los que el personaje figura como participante del acontecimiento causal, del acontecimiento consecuencia o de ambos. Cada relación conserva el candidato completo, su ID estable, conector, dirección convencional, evidencia y estado `candidate-needs-review`. La participación en una de las fichas no atribuye por sí sola acción, responsabilidad, intención ni efecto al personaje.

`relationships` incluye los registros actuales de `NarrativeRelation` donde el personaje es origen o destino. Expone dirección (`outgoing`, `incoming` o `self`), ficha contraparte cuando se conoce, tipo de relación, total de evidencias activas y obsoletas, y hasta veinte muestras con documento, revisión y offset UTF-16. `evidenceStatus` distingue evidencia activa, solo obsoleta o inexistente. `historyStatus: current-record-only` deja claro que este modelo aún no dispone de un historial versionado de cambios de relación: no se comparan tipos, inicios, rupturas ni reconciliaciones entre fechas. La ficha actual no debe interpretarse como prueba de que la relación se mantuvo inalterada a lo largo de toda la obra.

`documentedDecisions` reúne las ideas vinculadas explícitamente al personaje mediante `relatedEntityIds`. Conserva texto, estado (`IDEA`, `incorporated` o `discarded`), proyecto y documento de origen, IDs de ideas relacionadas, evidencia y el historial de estados. `writerDecisionCount` cuenta solo transiciones cuyo motivo registrado es `writer`; cada transición conserva su fecha si existe y el motivo (`initial`, `writer` o `text-revised`). Una idea marcada como `incorporated` expresa el estado registrado por el escritor, no una verificación automática de que su contenido aparezca literalmente en el manuscrito. Los registros descartados permanecen visibles como decisiones históricas, no como decisiones vigentes.

En cada instantánea de escena, `relationshipIds` y `documentedDecisionIdeaIds` solo incluyen registros cuya evidencia activa coincide exactamente con el documento y revisión analizados y se solapa con el contenido de esa escena. La existencia de una relación o idea a nivel de proyecto, sin evidencia local coincidente, no la atribuye artificialmente a una escena. `incompleteReasons` puede señalar truncamiento de muestras de evidencia de relaciones o ideas cuando afecta a una escena con evidencia coincidente.


`relationships` incluye los registros actuales de `NarrativeRelation` donde el personaje es origen o destino. Expone dirección (`outgoing`, `incoming` o `self`), contraparte cuando se conoce, tipo de relación, evidencia activa y obsoleta, y hasta veinte muestras con documento, revisión y offsets UTF-16. `evidenceStatus` distingue evidencia activa, solo obsoleta o inexistente. `historyStatus: current-record-only` indica que el modelo aún no dispone de historial versionado de transiciones de relaciones; no compara cambios de tipo, rupturas, reconciliaciones ni fechas de inicio o cierre. La ficha vigente no prueba que la relación se mantuviera inalterada durante toda la obra.

`documentedDecisions` reúne las ideas vinculadas explícitamente al personaje mediante `relatedEntityIds`. Conserva texto, estado (`IDEA`, `incorporated` o `discarded`), documento de origen, ideas relacionadas, evidencia y el historial de estados. `writerDecisionCount` cuenta el total de cambios registrados con motivo `writer`, incluso cuando el historial visible se limita a cien transiciones; `omittedStatusHistoryCount` informa cuántas transiciones no se muestran. Cada entrada conserva su fecha si existe y su motivo (`initial`, `writer` o `text-revised`). Una idea marcada como `incorporated` expresa el estado registrado por el escritor, no verifica automáticamente que el contenido aparezca literalmente en el manuscrito. Las ideas descartadas permanecen visibles como decisiones históricas.

En cada instantánea de escena, `relationshipIds` y `documentedDecisionIdeaIds` solo incluyen registros con evidencia activa que coincide exactamente con el documento y revisión analizados y se solapa con el contenido de la escena. Una relación o idea global sin evidencia local coincidente no se atribuye artificialmente a una escena. `incompleteReasons` puede señalar truncamiento de muestras de evidencia de relaciones o ideas cuando afecta a una escena con evidencia coincidente.

El resumen informa `relationshipRecordCount`, `omittedRelationshipCount`, `linkedIdeaCount` y `omittedIdeaCount`; cada trayectoria informa por separado su total de decisiones de escritor. Las relaciones e ideas se vinculan por ID estable, no por parecido textual entre nombres o descripciones.
`projectEventTimeline` agrega los acontecimientos globales del proyecto en los que el personaje figura como participante declarado. Solo construye puntos cuando la ficha contiene una referencia temporal explícita y al menos una evidencia activa. Los puntos se agrupan por `timelineTrackId`, base temporal, precisión y valor de orden; así, no mezcla fechas de calendario con días del mundo narrativo ni pistas distintas. Las transiciones se generan únicamente cuando existe una pista temporal declarada y comparan puntos de la misma pista, base y precisión. Los eventos con evidencia activa pero sin referencia temporal se contabilizan en `untimedEventCount`; los eventos sin evidencia activa y con evidencia obsoleta en `staleEventCount`; y los registros sin evidencia alguna en `unverifiedEventCount`. Ninguno recibe una posición temporal inventada. Cuando `timelineTrackId` es `null`, el punto queda visible como no asignado a pista, pero no se enlaza a otros puntos mediante transiciones.

Cada punto informa el número total de acontecimientos y evidencias activas, los documentos fuente, referencias temporales originales y muestras inspeccionables. `eventIds` muestra hasta cincuenta IDs por punto y `evidenceSamples` hasta veinte fragmentos; `omittedEventIdCount`, `omittedEvidenceCount` y `evidenceTruncated` reflejan recortes. La cronología admite hasta dos mil acontecimientos de entrada, doscientos puntos y doscientas transiciones por personaje. El anfitrión transfiere como máximo doscientas evidencias activas por acontecimiento sin perder sus contadores globales; `staleEvidenceCount` mantiene aparte la evidencia obsoleta. Si el catálogo del proyecto supera el límite de entrada, `omittedProjectEventCount` informa cuántos acontecimientos con participantes declarados no se incluyeron; por tanto, las trayectorias no se presentan como catálogo exhaustivo en ese caso.


La serie `scenes` ofrece una instantánea por escena explícita. Distingue `mentionStatus` de `participationStatus`, informa los IDs de acontecimientos vinculados, rangos de evidencia, valores de atributos y candidatos causales localizados en esa escena. `evidenceStatus` distingue `documented`, `no-known-evidence` y `unknown-due-to-truncation`. Un estado sin evidencia conocida describe el material y los vínculos disponibles, no la ausencia del personaje en la ficción. `incompleteReasons` y `incompleteSceneIndexes` identifican escenas con límites de menciones o vínculos de acontecimientos; una coincidencia positiva puede coexistir con una fuente parcialmente truncada.

`observedSceneIndexes` reúne escenas con alguna señal documental positiva. Los conteos separados de menciones, participación, afirmaciones de atributos y candidatos causales evitan colapsar fenómenos distintos en una sola medida de protagonismo. Los atributos de otros capítulos solo aportan al historial del personaje cuando tienen referencias temporales explícitas comparables; no se crean escenas ni posiciones narrativas ficticias para esos capítulos.

El resumen limita las trayectorias a doscientos personajes y declara `omittedCharacterCount`. También conserva `sourceTruncatedSceneIndexes`, `omittedAttributeProfileCount`, `omittedEventAssociationCount` y `omittedCausalCandidateCount`, para que los recortes de las fuentes no se oculten. El catálogo de entrada admite hasta quinientos personajes. Las escenas siguen limitadas a las cien primeras explícitas; las relaciones causales visibles conservan el límite de cincuenta candidatos definido por `eventDependencyAnalysis`.

La trayectoria es una síntesis de evidencia del proyecto y del fragmento analizado, no una línea biográfica completa ni un arco psicológico inferido. No determina motivaciones, evolución emocional, protagonismo, presencia física, simultaneidad, causalidad definitiva ni continuidad del personaje entre pasajes que carecen de evidencia enlazada. Los cambios, huecos y candidatos deben interpretarse consultando los registros fuente y sus offsets.

## Señales gramaticales por escena

Cada escena explícita incluye `voiceSignals`, calculado sobre sus tokens y fuera de los rangos de diálogo reconocidos. Devuelve conteos de pronombres explícitos de primera, segunda y tercera persona, una clasificación descriptiva y hasta 40 muestras con offsets UTF-16 absolutos. La clasificación es `undetermined` cuando no hay señales, y `mixed-signals` cuando aparecen varias categorías.

Estas señales no identifican al narrador ni la focalización: pueden corresponder a narración citada, estilo indirecto u otros usos gramaticales. La exclusión del diálogo depende de los formatos que reconoce el detector y no garantiza separar todas las voces de un texto.

### Perfil agregado de señales gramaticales por escena

La propiedad `sceneVoiceProfile` resume las escenas explícitas incluidas en el fragmento: cantidad de escenas, total de señales, total de palabras de narración, conteos acumulados por categoría, tasas por cada 1.000 palabras de narración, distribución de escenas por clasificación y cobertura de cada categoría. `sceneShare` es una fracción entre 0 y 1 que expresa la proporción de escenas con al menos una señal de la categoría, no su peso narrativo. `sceneSnapshots` conserva una entrada por escena en orden textual, con índice, clasificación y conteos; el índice remite a `explicitScenes`, donde están las muestras y offsets inspeccionables.

Cada escena informa también `narrativeWordCount`, palabras de su contenido una vez excluidas las palabras dentro de segmentos de diálogo reconocidos. `sceneSnapshots` ofrece tasas de cada categoría y tasa total normalizadas por 1.000 palabras de narración; el agregado usa el total de palabras narrativas de las escenas, no el promedio simple de tasas, para conservar una ponderación coherente por longitud. Cuando el denominador es cero, la tasa correspondiente es 0.

El perfil agrega únicamente pronombres explícitos detectados fuera de los rangos de diálogo reconocidos. Una categoría más frecuente o presente en más escenas no permite atribuir la narración a una persona gramatical, identificar un narrador ni concluir que la voz permanece o cambia entre escenas. Con cero escenas explícitas, los totales, distribuciones y coberturas son cero y la secuencia queda vacía.

### Variaciones de señales gramaticales entre escenas

La propiedad `sceneVoiceTransitions` compara las señales `voiceSignals` de cada par de escenas explícitas contiguas. Informa la clasificación anterior y siguiente, si la clasificación cambió, la diferencia de conteos por categoría (siguiente menos anterior) y las categorías cuyo conteo varió. Los índices se corresponden con los de `explicitScenes`; no se comparan escenas no contiguas ni se inventan transiciones implícitas.

Las diferencias son descriptivas y dependen del léxico de pronombres explícitos y de la detección de diálogo disponible. Un cambio de categoría no acredita cambio de narrador, focalización, persona verbal ni voz autoral; tampoco una categoría estable acredita continuidad de narrador.

### Secuencias de señales gramaticales entre escenas

La propiedad `sceneVoiceSequences` busca dos patrones descriptivos entre escenas explícitas consecutivas. Un tramo estable requiere al menos tres escenas seguidas con la misma clasificación única (primera, segunda o tercera persona). Una alternancia requiere al menos cuatro escenas seguidas que alternen entre dos clasificaciones únicas distintas (A-B-A-B). Los tramos se informan de forma maximal, en orden textual, con índices inicial/final, secuencia de clasificaciones e instantáneas de conteos y tasas por escena.

Las clasificaciones `mixed-signals` y `undetermined` interrumpen la detección; no se saltan para unir escenas distantes. Los patrones solo resumen los pronombres explícitos fuera del diálogo reconocido. No identifican narradores, no demuestran continuidad o cambio de focalización y no describen por sí solos alternancia de hablantes.

## Ritmo narrativo por escena

Cada objeto de `explicitScenes` incluye `rhythmSignals`, un perfil calculado a partir de las oraciones completas que quedan dentro del rango de contenido de esa escena. El perfil informa cantidad de oraciones, promedio y mediana de palabras por oración, desviación estándar poblacional, mínimos y máximos, distribución corta (hasta 8 palabras), media (9–24) y larga (25 o más), y la clasificación (`fragmented`, `balanced`, `extended` o `insufficient-text`). Se aplican los mismos umbrales del perfil global: al menos 20 palabras y dos oraciones; promedio inferior a 9 para `fragmented`, igual o superior a 22 para `extended` y el intervalo restante para `balanced`.

La propiedad `rhythmSignals.transitions` contiene contrastes entre pares de oraciones consecutivas dentro de la misma escena. Se conserva el criterio global: la oración mayor debe alcanzar 16 palabras, aventajar a la otra por al menos 10 y duplicar su longitud. Cada contraste mantiene índices locales a la escena, dirección (`acceleration` o `deceleration`) y los dos rangos UTF-16 absolutos. No se crean contrastes que atraviesen límites de escena y se devuelven como máximo 20 por escena.

La propiedad de resultado `sceneRhythmTransitions` compara cada par de escenas explícitas contiguas mediante el perfil, el promedio de longitud oracional, la cantidad de oraciones y el número de contrastes detectados. Los deltas se calculan como escena siguiente menos escena anterior. Los índices `fromSceneIndex` y `toSceneIndex` coinciden con los empleados por `sceneVoiceTransitions`, por lo que ambas dimensiones pueden consultarse en paralelo sin fusionar sus evidencias.

El perfil de ritmo cuenta todas las oraciones de la escena, incluido el diálogo reconocido; en cambio, `voiceSignals` excluye los rangos de diálogo reconocidos. Esta diferencia se declara deliberadamente para evitar presentar ambas mediciones como si compartieran el mismo universo textual. Un cambio del perfil o del promedio de longitud no demuestra tensión, aceleración subjetiva, intención del autor ni calidad estética; una variación gramatical simultánea tampoco demuestra cambio de narrador o focalización. Los rangos de ritmo y las muestras gramaticales permanecen separados e inspeccionables.

### Cadencia y patrones de longitud dentro de cada escena

El objeto `rhythmSignals.cadence` resume las longitudes de las oraciones en bandas cortas (hasta 8 palabras), medias (9–24) y largas (25 o más), además de contar las transiciones entre cada par de bandas en orden textual. Busca cuatro patrones de forma independiente: rachas de al menos tres oraciones dentro de la misma banda; alternancias máximas de al menos cuatro oraciones entre dos bandas distintas (A-B-A-B); y secuencias de al menos tres oraciones con longitudes estrictamente ascendentes o descendentes, donde cada paso difiere al menos dos palabras y el cambio total alcanza ocho palabras.

Cada patrón conserva índices de oración locales a la escena, conteos y bandas de las primeras 40 oraciones y sus rangos UTF-16. `evidenceTruncated` indica que el patrón continúa más allá de esas muestras. Se informa el número total de patrones detectados y se exponen como máximo 20, ordenados por posición. Los patrones pueden solaparse cuando describen propiedades distintas; son descripciones mecánicas de la secuencia de longitudes, no categorías retóricas ni evaluaciones estéticas.

Estas mediciones se calculan exclusivamente desde las oraciones y sus longitudes. No usan pronombres ni la clasificación `voiceSignals`; por tanto, una cadencia estable o alternante no prueba estabilidad o alternancia de perspectiva, narrador o focalización. A la inversa, una variación gramatical no implica cambio de cadencia.

### Comparación de cadencia entre escenas contiguas

La propiedad `sceneCadenceTransitions` compara las bandas de longitud y patrones entre cada par de escenas explícitas contiguas. Los deltas de bandas y de transiciones se calculan como escena siguiente menos escena anterior. También informa el cambio de cantidad total de patrones, el delta por tipo (racha estable, alternancia, progresión ascendente y progresión descendente), los tipos que aparecen y los que dejan de detectarse. Sus índices remiten a las mismas escenas utilizadas por `sceneRhythmTransitions` y `sceneVoiceTransitions`.

Los conteos por tipo se calculan sobre todos los patrones detectados, no sobre la lista de evidencias limitada a 20 por escena. Así, el límite de muestras no altera la comparación. Una transición ausente puede significar que la escena tiene menos de dos oraciones; sus deltas describen conteos observados y no se interpretan como una cadencia narrativa nula. Esta comparación sigue basada exclusivamente en longitudes oracionales, incluye diálogo reconocido y no permite deducir perspectiva, narrador ni focalización.

### Firmas de cadencia recurrentes entre escenas

La propiedad `sceneCadenceMotifs` agrupa patrones locales de cadencia con la misma clase y la misma secuencia ordenada de bandas cuando aparecen en al menos dos escenas explícitas distintas. Cada motivo registra las escenas cubiertas, la cantidad de instancias y hasta 40 evidencias de ocurrencia con conteos de palabras, índices locales a la escena y rangos UTF-16 absolutos. `instancesTruncated` informa si hay más instancias que las expuestas.

El resumen diferencia los patrones candidatos totales de las muestras inspeccionadas por escena: `candidatePatternCount` cuenta todos los patrones locales, `sampledPatternCount` cuenta los que entran en la lista limitada a 20 por escena y `omittedPatternCount` señala los candidatos fuera de esa muestra. Por ello, la detección de motivos recurrentes se realiza sobre las muestras visibles; el recuento de omitidos hace explícito que el resultado no es exhaustivo cuando se alcanza el límite. Se devuelven como máximo 20 motivos, ordenados por escenas cubiertas y frecuencia.

Una firma recurrente significa únicamente que una secuencia idéntica de bandas y tipo de patrón aparece en varias escenas del fragmento analizado. No acredita repetición de tema, emoción, estructura dramática, intención estilística ni autoría; tampoco se combina con señales gramaticales o de diálogo.

### Perfil de diálogo dentro de cada escena

Cada escena explícita incluye `dialogueSignals`, calculado a partir de los segmentos reconocidos por el detector global y recortados al rango de contenido de esa escena. Informa el número de segmentos, palabras dialogadas, proporción sobre las palabras totales de la escena, densidad según los mismos umbrales globales (ninguna, baja, moderada o alta), media y máximo de palabras por segmento, y conteos por formato (comillas, raya de diálogo o segmento mixto). Se exponen hasta 20 segmentos por escena, con formato, longitud y ocurrencia UTF-16 absoluta; `evidenceTruncated` indica si hay más segmentos de los visibles.

El diálogo de una escena se calcula sobre el contenido, sin incluir su encabezado ni el separador que la delimita. Si un segmento reconocido cruza un límite estructural, su rango y conteo se recortan al contenido de cada escena que intersecta; por tanto, los perfiles reflejan la cobertura textual local y no reescriben la segmentación original. Los conteos resumen todos los segmentos intersectados aunque la evidencia visible esté limitada a 20.

El detector conserva sus límites de formato: reconoce texto entre comillas angulares, curvas o rectas y líneas iniciadas por raya. Una intervención puede quedar sin detectar si utiliza otra convención editorial. El perfil no infiere hablantes, turnos conversacionales, destinatarios, intención, calidad del diálogo ni relación entre personajes.

## Acontecimientos y continuidad entre escenas

La API anfitriona aporta acontecimientos persistidos del proyecto activo. Una escena solo recibe un vínculo cuando existe evidencia no obsoleta del mismo documento y de la revisión exacta analizada cuyo rango UTF-16 se solapa con el contenido de la escena. Cada vínculo conserva el ID y etiqueta del acontecimiento, los rangos coincidentes y sus participantes declarados. Para cada participante se informa por separado si también aparece por nombre/alias en las menciones literales de esa escena. La falta de mención no se interpreta como ausencia ni contradicción. La evidencia de otras revisiones, otros documentos o marcada como obsoleta se descarta. Cada vínculo expone `matchingEvidenceCount`, el total de registros coincidentes antes del límite, y `matchingEvidenceTruncated`, que indica si los rangos visibles fueron recortados. El catálogo admite hasta 2.000 acontecimientos, 500 participantes y 200 evidencias por acontecimiento; cada escena devuelve como máximo 100 vínculos y 20 rangos por vínculo.

### Candidatos de dependencia causal entre acontecimientos

La propiedad `eventDependencyAnalysis` compara pares de acontecimientos con evidencia vigente del mismo documento y revisión. Solo considera dos anclas de evidencia ubicadas dentro de una misma oración y busca entre ellas conectores causales literales reconocidos, como `provocó`, `causó`, `desencadenó`, `por eso`, `por lo tanto`, `porque`, `debido a` o `a causa de`.

Cada candidato conserva los IDs y etiquetas de ambos acontecimientos, el conector y su offset UTF-16, los rangos de evidencia de cada evento y la oración completa que contiene la relación. `causeEventId` y `consequenceEventId` reflejan la dirección convencional del conector; `direction` distingue causa antes de consecuencia y consecuencia antes de causa. También expone por separado los participantes declarados de cada acontecimiento y `sharedParticipantIds`, la intersección de esos IDs explícitos. La intersección ayuda a localizar personajes relacionados con ambos registros, pero no afirma que hayan causado o sufrido el resultado. Cuando ambas evidencias pertenecen al contenido de una escena explícita, se informa también `sceneIndex`; de lo contrario, el valor es `null`.

Se expone como máximo una ancla por acontecimiento y oración, se examinan como máximo 2.000 anclas de evidencia y se devuelven hasta cincuenta candidatos. `evidenceAnchorCount`, `omittedEvidenceAnchorCount`, `candidateCount` y `omittedCandidateCount` informan los límites de entrada y salida. Las anclas fuera del fragmento, de otra revisión o marcadas como obsoletas no se utilizan.

Los resultados llevan el estado `candidate-needs-review`: el conector puede referirse a otra relación, contener ironía, negación, una explicación hipotética o una causalidad atribuida por un personaje. La dirección es una lectura gramatical local, no una conclusión sobre el mundo narrativo. Una secuencia de acontecimientos, una coincidencia en la misma escena o la aparición de un conector por sí solas no prueban causa suficiente, efecto, responsabilidad ni cronología completa. La ausencia de candidato tampoco prueba que no exista una relación causal. El motor no crea ni modifica enlaces persistidos.

### Historial versionado de acontecimientos y cambios de participantes

El proyecto puede conservar cambios explícitos de etiqueta y conjunto de participantes mediante registros `EventLifecycle` append-only. `updateNarrativeEvent` recibe el ID del acontecimiento, los campos que se desean modificar, la identidad del escritor que registra el cambio y, cuando están disponibles, motivo y fecha. Los participantes se normalizan como IDs únicos ordenados y se comprueba que cada ficha exista en el mismo proyecto. Una petición sin cambio efectivo no crea una transición.

Cada entrada conserva la revisión, la etiqueta anterior y nueva, las listas anteriores y nuevas de participantes, autor, motivo y marca temporal. La primera revisión (`revision: 1`) registra el primer cambio explícito que se realiza desde la incorporación de esta capacidad; sus campos `previousLabel` y `previousParticipants` capturan el estado real inmediatamente anterior. No se inventa un registro histórico inicial ni se atribuye una fecha retrospectiva a acontecimientos antiguos. Las revisiones siguientes deben continuar exactamente la etiqueta y el conjunto de participantes de la transición anterior, sin retroceder en la fecha.

La API `getEventLifecycleHistory(eventId)` recupera la cadena y rechaza revisiones duplicadas, saltos, instantáneas anteriores que no coinciden con el estado previo o fechas regresivas. En IndexedDB 22, el almacén `event-lifecycles` aísla cada entrada por proyecto y usa un índice único por acontecimiento/revisión. `saveEventAndAppendLifecycleIfUnchanged` actualiza la ficha vigente y agrega la transición en una sola transacción, comprobando que la versión leída siga siendo la actual; si otra instancia cambió el acontecimiento, no se confirma ninguna de las dos escrituras.

La propiedad `eventLifecycleAnalysis` incorpora al resultado del análisis los historiales de los acontecimientos que tienen evidencia vigente dentro del documento, revisión y rango analizados. Cada perfil compara la última revisión registrada con la ficha vigente: `latestRecordedLabel` y `latestRecordedParticipantIds` reflejan la instantánea histórica, mientras `currentLabel` y `currentParticipantIds` reflejan el registro actual. `currentStateMatchesLatestRevision` indica si ambos estados coinciden. Un valor `false` señala una divergencia que necesita inspección; no atribuye su causa ni inventa una transición faltante. El resumen cuenta revisiones, cambios de etiqueta y modificaciones del conjunto de participantes. En cada transición, `addedParticipantIds` y `removedParticipantIds` se calculan comparando los dos conjuntos de IDs, no las menciones del manuscrito.

Se informa también `changedBy`, `changeReason` y `changedAt` cuando están disponibles. El motor expone como máximo cien perfiles de acontecimiento y las cien transiciones más recientes por perfil; los contadores se calculan sobre la cadena validada completa y `changesTruncated` indica el recorte de muestras.

El historial registra operaciones explícitas del anfitrión. No convierte la aparición o desaparición literal de un nombre en una modificación de participantes, ni presupone que toda actualización antigua o automática haya generado una revisión. Los perfiles describen cambios registrados en la ficha narrativa; no prueban presencia física, acción, interacción ni que el acontecimiento sucediera de una forma determinada en la ficción.

### Cronología de recurrencia por acontecimiento

La propiedad `sceneEventEvidenceProfiles` agrupa los vínculos de evidencia por ID de acontecimiento a través de todas las escenas explícitas, independientemente de que el acontecimiento declare participantes. Por ello, también incluye acontecimientos cuyo arreglo `participants` está vacío. Cada perfil registra las escenas vinculadas, el número de escenas, la primera y última escena, los intervalos sin evidencia entre ambas, la mayor racha de escenas consecutivas con evidencia y el total de rangos coincidentes.

La serie `scenes` conserva una entrada por escena explícita. `evidenceRangeCount` cuenta todos los rangos coincidentes antes de limitar las muestras UTF-16 a veinte; `evidenceSamplesTruncated` indica si se aplicó ese límite. Ambos campos son `null` cuando no existe vínculo de evidencia para ese acontecimiento en la escena. Los perfiles se ordenan por cobertura, racha consecutiva, cantidad de evidencia e ID, y se exponen como máximo cien. `eventCount` cuenta los IDs distintos representados por los vínculos visibles y `omittedEventCount` informa cuántos perfiles superan ese límite. `sourceTruncatedSceneIndexes` identifica escenas donde la lista original superó los cien vínculos por escena; los acontecimientos omitidos por ese límite no pueden atribuirse a perfiles específicos.

El perfil describe la distribución de referencias de evidencia asociadas al mismo ID persistido. Que un acontecimiento tenga evidencia en varias escenas no demuestra que el suceso ocurra varias veces, que sean sucesos distintos, ni establece causalidad, orden temporal o continuidad factual. Tampoco determina presencia, acción o participación de personajes. Es una herramienta para localizar recurrencias documentales y discontinuidades que requieren revisión editorial.

### Secuencias recurrentes de acontecimientos entre escenas

La propiedad `sceneEventSequenceMotifs` compara ventanas móviles de dos y tres escenas explícitas contiguas. Para cada posición conserva el conjunto de IDs de acontecimientos que tienen evidencia enlazada en esa escena, ordenados por ID para que el orden del catálogo no altere la firma. Un conjunto vacío indica que no hubo vínculos de acontecimientos reconocidos en esa escena; no demuestra que no ocurriera ningún suceso.

Cada motivo reúne firmas idénticas observadas en al menos dos ventanas. `sceneSequence` describe los IDs por posición relativa y `instances` informa los índices inicial y final de cada ventana coincidente. Se permiten ventanas solapadas. Se exponen como máximo veinte instancias por motivo y cincuenta motivos; `instancesTruncated` y `omittedMotifCount` muestran los recortes respectivos.

El resumen informa `candidateWindowCount` (todas las ventanas contiguas posibles de dos o tres escenas), `analyzedWindowCount` (ventanas no vacías y con fuente completa), `emptyWindowCount` (ventanas sin ningún vínculo conocido) y `sourceTruncatedWindowCount` (ventanas que incluyen al menos una escena con más de cien vínculos). Las ventanas con alguna escena marcada `eventLinksTruncated` se excluyen, ya que los acontecimientos omitidos podrían cambiar la firma. Una ventana vacía se distingue de una ventana excluida por truncamiento.

La firma representa conjuntos de IDs por escena, no el orden textual de los acontecimientos dentro de una misma escena. Por tanto, una coincidencia indica repetición de una estructura de vínculos de evidencia entre escenas; no prueba repetición material de sucesos, causalidad, secuencia temporal intradiegética, simultaneidad, interacción ni relación dramática. La ausencia de un vínculo conocido tampoco prueba ausencia del acontecimiento. Los IDs y las evidencias originales deben inspeccionarse antes de cualquier interpretación editorial.

### Variaciones de evidencia y menciones nominales de participantes

La propiedad `sceneEventAssociationTransitions` compara cada par de escenas explícitas contiguas para los IDs de acontecimientos que tienen evidencia enlazada en al menos una de las dos escenas. Informa el estado de cobertura del acontecimiento, el número total de rangos de evidencia en la escena anterior y siguiente y el delta (siguiente menos anterior). Un conteo cero significa que la escena fue examinada sin encontrar un vínculo para ese ID; un valor `null` significa que no puede asegurarse esa ausencia porque la lista de vínculos de la escena se truncó. El delta también queda en `null` cuando alguno de los dos conteos es desconocido.

Para cada acontecimiento se comparan por separado los participantes declarados por el proyecto. La serie `participants` muestra si el nombre o alias de cada participante aparece literalmente en el contenido completo de cada escena vinculada. El estado diferencia menciones en ambas escenas, solo en una, ausencia nominal en ambas escenas vinculadas, falta de evidencia del acontecimiento en una escena y fuente truncada que impide determinarlo. Los valores `previousMentionedByName` y `nextMentionedByName` son `null` cuando no existe un vínculo verificable del acontecimiento en esa escena. Los participantes declarados proceden del mismo registro persistido; esta comparación no demuestra que sus asociaciones declaradas hayan cambiado entre escenas.

Cuando una escena supera el límite de cien vínculos, los eventos no expuestos no se interpretan como ausentes: el estado pasa a indicar truncamiento y el conteo y mención nominal correspondientes se conservan como desconocidos. Si el evento sí está visible en ambas escenas, la evidencia positiva de ambos lados puede compararse aunque haya otros eventos omitidos. Los resultados se ordenan por índice de escena y por ID de acontecimiento/participante.

Estas transiciones describen variación en la localización de evidencias y menciones literales. No demuestran que un participante entre o salga de la acción, que ejecute el acontecimiento, que cambie su relación con él ni que exista contradicción narrativa. Un cambio de cantidad de rangos puede reflejar más o menos referencias documentales, no una transformación del suceso. Para evaluar un cambio en la asociación persistida entre personaje y acontecimiento haría falta un historial versionado de participantes, que no se infiere de la ficha vigente.

### Cronología de evidencia de acontecimientos por participante

La propiedad `characterEventEvidenceProfiles` agrupa, por ID de participante y de acontecimiento, las asociaciones declaradas en los vínculos de evidencia de las escenas explícitas. Cada perfil expone el número de escenas con evidencia, sus índices, la primera y última escena, los intervalos intermedios sin evidencia, el total de rangos de evidencia y en cuántas escenas vinculadas el nombre del participante también aparece literalmente. `canonicalName` usa el nombre conocido por el catálogo cuando existe en alguna escena del fragmento; si el participante solo está declarado por ID y nunca se reconoce su nombre, devuelve `null`.

La serie `scenes` contiene una entrada para cada escena explícita. `evidenceRangeCount` informa cuántos registros de evidencia del acontecimiento coinciden con esa escena; `participantMentionedByName` es `true` o `false` únicamente cuando existe evidencia del acontecimiento en esa escena. La búsqueda del nombre se realiza en el contenido completo de la escena, no exige que la mención se solape con el rango de evidencia. Se contrasta con el catálogo completo de personajes conocido por el análisis y no con la muestra pública de hasta 40 menciones por escena; por ello, una identidad fuera de esa muestra puede conservar una coincidencia nominal positiva en el vínculo del acontecimiento. Ambos campos son `null` cuando no hay un vínculo de evidencia para ese acontecimiento en la escena, para no confundir la falta de enlace con un resultado negativo de mención. El total de rangos cuenta todos los registros coincidentes antes de limitar a 20 las muestras UTF-16 del vínculo. `eventLinksTruncated` marca en cada escena si existían más de 100 acontecimientos con evidencia coincidente; el resumen publica `sourceTruncatedSceneCount` y `sourceTruncatedSceneIndexes` para señalar escenas cuya fuente quedó recortada. `associationCount` cuenta los pares participante/acontecimiento derivados de los vínculos expuestos y `omittedAssociationCount` informa cuántos perfiles de esos pares quedan fuera del límite de 200. Por ello, los indicadores de truncamiento de escena deben revisarse junto con los límites del resumen: los pares no expuestos por un límite de 100 vínculos no forman parte de `associationCount`.

Estos perfiles describen asociaciones explícitas guardadas por el proyecto y evidencia localizada en una revisión exacta. No demuestran por sí solos que el participante esté físicamente presente, ejecute la acción, hable, interactúe con otra persona o sea el foco narrativo. Una mención nominal negativa significa solo que no se reconoció el nombre o alias en el texto de esa escena vinculada; un valor `null` significa que no se encontró evidencia del acontecimiento en esa escena. Las listas de evidencia UTF-16 de `explicitScenes[].eventLinks` siguen siendo la fuente para inspeccionar los rangos originales.

### Comparaciones de continuidad entre escenas contiguas

La propiedad `sceneContinuity` compara cada par de escenas explícitas consecutivas del fragmento, sin saltar escenas ni inferir transiciones implícitas. Para cada identidad conocida devuelve los rangos de mención en ambas escenas y clasifica la señal como mencionada en ambas, no mencionada en la siguiente o mencionada solo en la siguiente. Para cada acontecimiento con evidencia enlazada devuelve sus rangos de evidencia por escena y si esa evidencia aparece en ambas o solo en una de ellas. Las listas se ordenan por ID y los offsets siguen siendo absolutos UTF-16.

Estas etiquetas describen exclusivamente la cobertura textual disponible. «No mencionado en la siguiente escena» no significa que el personaje esté ausente, haya abandonado el lugar o haya desaparecido de la historia. Del mismo modo, evidencia exclusiva en una escena no demuestra que el acontecimiento termine allí, ni establece orden cronológico entre acontecimientos. Los pares se limitan a las escenas explícitas contiguas y no generan juicios de contradicción ni modifican el manuscrito.

### Co-mención de personajes conocidos

La propiedad `characterCoMentions` agrupa pares de identidades del catálogo cuyos nombres o alias no ambiguos aparecen literalmente dentro de una misma escena explícita. Cada patrón contiene los dos IDs en orden estable, la cantidad de escenas compartidas y sus índices. Los resultados se ordenan por frecuencia descendente y después por IDs, y se limitan a los 100 pares más frecuentes.

La co-mención describe únicamente una coincidencia textual en la misma escena. No acredita que los personajes se encuentren físicamente, interactúen, conversen, mantengan una relación ni compartan el punto de vista narrativo. La evidencia de cada mención permanece disponible en `explicitScenes` para inspección.

### Distribución de menciones de personajes entre escenas

La propiedad `characterMentionDistributions` resume la distribución de menciones literales no ambiguas de personajes conocidos en las escenas explícitas del fragmento. Cada perfil expone los índices de las escenas donde aparece una coincidencia, el número de escenas cubiertas, la primera y la última escena observadas, la cantidad de escenas intermedias sin coincidencia literal, la mayor racha de escenas consecutivas con mención y la cobertura relativa (`sceneCoverageRatio`), calculada como escenas con mención divididas por el total de escenas explícitas y redondeada a tres decimales. También expone `totalMentionCount` y `mentionCountByScene`, que acumulan el número de coincidencias literales contadas para cada personaje y su distribución por escena. La serie incluye todas las escenas explícitas, también las que tienen cero coincidencias; cada entrada informa `sceneWordCount` y `mentionRatePer1000Words`, calculada como menciones divididas por las palabras de esa escena y multiplicadas por 1.000. El perfil incluye `totalSceneWordCount` y una tasa agregada ponderada por todas las palabras de las escenas explícitas, no una media simple de las tasas locales.

Cada mención de `explicitScenes[].characterMentions` informa `mentionCount`, el número total de coincidencias detectadas para esa identidad en esa escena antes de limitar las muestras. `occurrences` conserva como máximo 20 rangos UTF-16 y `occurrencesTruncated` indica si el total supera las muestras. De forma independiente, `matchedNameCount` cuenta las formas literales observadas, `matchedNames` conserva como máximo diez y `matchedNamesTruncated` indica si se omitieron formas adicionales. Los conteos no se reducen por esos límites de evidencia.

Solo se incluyen identidades con al menos una mención literal detectada. Los perfiles se ordenan por número de escenas cubiertas, longitud de la mayor racha consecutiva e ID estable; se exponen como máximo 100. `characterCount` informa cuántas identidades tuvieron coincidencias y `omittedCharacterCount` cuántas quedaron fuera de esa muestra. La fuente son las menciones de personaje ya calculadas por escena, limitadas a 40 identidades por escena; por tanto, el resumen respeta ese límite previo y no reevalúa los nombres descartados por la muestra local. Si no hay escenas explícitas o ninguna coincidencia válida, la colección queda vacía y los conteos correspondientes son cero.

Los intervalos sin mención describen únicamente escenas sin coincidencia textual en el catálogo disponible. No demuestran que el personaje esté ausente, haya entrado o salido de la historia, ni permiten inferir protagonismo, importancia, participación, desarrollo psicológico o arco narrativo. La distribución no reemplaza las ocurrencias UTF-16 visibles en `explicitScenes`; facilita localizar recurrencias y discontinuidades para inspección editorial.


### Variaciones de diálogo entre escenas

La propiedad `sceneDialogueTransitions` compara cada par de escenas explícitas contiguas. Informa densidad anterior y siguiente, si la categoría cambia, proporción de palabras dialogadas y su diferencia (siguiente menos anterior), cantidad de segmentos, palabras dialogadas y diferencias por formato reconocido (comillas, raya y mixto). Los valores de proporción se redondean a tres decimales; las diferencias de conteos son enteros con signo. Cada transición referencia los índices 1-based de `explicitScenes`.

La comparación depende exclusivamente de los formatos reconocidos por el detector y de los límites explícitos de escena. Un cambio de densidad no prueba un cambio de hablante, interlocutor, intención, tensión ni función dramática. No se generan transiciones si existe menos de una pareja de escenas explícitas, y no se saltan escenas intermedias.


La transición también expone la longitud media y la longitud máxima de los segmentos dialogados en cada escena, junto con sus deltas (siguiente menos anterior). La media se redondea a tres decimales; el máximo es un conteo entero. Cuando no hay segmentos reconocidos, ambas métricas son cero. Estas medidas describen el tamaño textual de los segmentos detectados, no la duración oral ni el turno real de una persona.


### Tasa de diálogo normalizada por narración

Cada perfil `dialogueSignals` de escena incluye `dialogueWordsPer1000NarrativeWords`: palabras de diálogo reconocidas por cada 1.000 palabras de narración fuera de los rangos de diálogo detectados. Se calcula como `dialogueWordCount / narrativeWordCount * 1000`, con redondeo a tres decimales; si no hay palabras narrativas, el valor es cero. No sustituye a `dialogueRatio`, cuyo denominador son todas las palabras de la escena.

La transición `sceneDialogueTransitions` expone la tasa anterior, la siguiente y el delta (siguiente menos anterior). La tasa permite comparar escenas con distintas cantidades de narración, pero depende de la precisión del detector de diálogo y no representa duración, número de turnos ni cantidad de hablantes.


### Flujo de diálogo por párrafos

Cada escena explícita expone `dialogueFlowSignals`, que clasifica los párrafos con palabras reconocidas como `narrative-only` (sin diálogo detectado), `dialogue-only` (todas sus palabras pertenecen a segmentos de diálogo reconocidos) o `mixed` (contienen palabras dialogadas y no dialogadas). El perfil informa la cantidad de párrafos por clase, la cantidad y proporción de párrafos que contienen diálogo, las transiciones entre clases de párrafos consecutivos y el número de cambios de clase.

Los párrafos de solo puntuación, sin palabras reconocidas, no entran en el denominador. Los índices de párrafo siguen el orden de los rangos de párrafo detectados dentro de la escena; cada muestra conserva su rango UTF-16 absoluto. Se exponen hasta 40 muestras iniciales y `evidenceTruncated` indica si hay más. Los conteos y transiciones se calculan sobre todos los párrafos con palabras, no solo sobre las muestras visibles.

Esta clasificación es estructural y léxica: depende de los segmentos de diálogo reconocidos y del separador de párrafos (líneas en blanco). Un párrafo mixto no identifica qué persona habla ni distingue narración indirecta, citas no reconocidas o voz del narrador. La proporción de párrafos dialogados no equivale a la proporción de palabras dialogadas ni al número de turnos conversacionales.


### Tramos consecutivos del flujo de diálogo

Cada perfil `dialogueFlowSignals` añade `runs`, que agrupa los párrafos con palabras en tramos consecutivos de dos clases: `narrative-only-run` (solo párrafos `narrative-only`) y `dialogue-bearing-run` (párrafos `dialogue-only` o `mixed`). Por ello, un cambio entre diálogo exclusivo y párrafo mixto no divide el tramo; sí lo hace el paso entre un párrafo con diálogo reconocido y uno sin él.

Cada muestra informa `runIndex`, los índices inicial y final de párrafo, la cantidad de párrafos, el desglose por las tres clasificaciones y el rango UTF-16 absoluto desde el comienzo del primer párrafo hasta el final del último. El perfil también expone `runCount`, `dialogueBearingRunCount`, `narrativeOnlyRunCount`, las longitudes máximas de ambos tipos de tramo y hasta 40 muestras iniciales; `runsTruncated` indica si se superó ese límite. Las métricas se calculan sobre todos los párrafos con palabras, aunque las muestras estén limitadas.

Los tramos describen únicamente la continuidad textual de las clases detectadas. No representan turnos conversacionales, hablantes, duración, ritmo dramático ni calidad narrativa.



### Comparación del flujo de diálogo entre escenas

La propiedad `sceneDialogueFlowTransitions` compara el perfil de párrafos de cada par de escenas explícitas contiguas. Expone el número de párrafos, la cantidad y proporción de párrafos con diálogo reconocido, y las diferencias (siguiente menos anterior) para esas medidas. Incluye deltas por clase (`narrative-only`, `dialogue-only`, `mixed`), por cada transición entre clases consecutivas y para el número de cambios de clase.

Los deltas de conteo son enteros con signo; el delta de proporción se redondea a tres decimales. Además de las cantidades por clase y sus transiciones, cada comparación expone los conteos anterior y siguiente y el delta de tramos narrativos y con diálogo, así como las longitudes máximas de ambos tipos de tramo. Las transiciones solo comparan escenas contiguas disponibles y no saltan escenas intermedias. Si hay menos de dos escenas explícitas, la lista queda vacía. Los conteos de tramos y sus longitudes se calculan independientemente dentro de cada escena; no se conectan ni fusionan bloques a través del límite. Estas diferencias describen la distribución de párrafos que contienen palabras reconocidas y no permiten inferir hablantes, turnos conversacionales, intención, tensión ni calidad narrativa.


### Resumen agregado del flujo de diálogo

La propiedad `sceneDialogueFlowSummary` agrega los perfiles de todas las escenas explícitas analizadas. Informa el total de párrafos con palabras, conteos acumulados para las clases narrativa, dialogada y mixta, la cantidad y proporción global de párrafos con diálogo reconocido y la cantidad y fracción de escenas que contienen al menos un párrafo dialogado o mixto. También acumula `totalRunCount`, `dialogueBearingRunCount` y `narrativeOnlyRunCount`, y expone la mayor longitud observada para cada tipo de tramo dentro de una escena.

La proporción global se calcula como el total de párrafos con diálogo dividido por el total de párrafos con palabras; es una medida ponderada por número de párrafos y no el promedio de las proporciones de cada escena. Las matrices de transición y el número de cambios se suman dentro de cada escena, sin crear enlaces entre el último párrafo de una escena y el primero de la siguiente. Los tramos también se suman por escena y nunca se fusionan en los límites; las longitudes máximas representan el tramo más largo dentro de cualquiera de las escenas, no una secuencia concatenada. `sceneSnapshots` conserva los conteos de tramos y sus máximos de forma independiente y en orden de escena. Si no existen escenas explícitas, todos los conteos y proporciones son cero y la lista de instantáneas queda vacía.
