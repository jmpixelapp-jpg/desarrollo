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


## Presencia de personajes en escenas

La API anfitriona entrega al analizador las fichas de personajes del proyecto activo (nombre canónico y alias). En cada escena explícita se localizan coincidencias literales completas, sin distinguir mayúsculas y minúsculas, y se devuelven los IDs de identidad, variantes de nombre y offsets UTF-16. Se exige identidad única del nombre o alias: si dos personajes reclaman la misma forma, esa coincidencia se omite en vez de asignarse por conjetura. El análisis no usa pronombres para atribuir presencia ni interpreta mención como participación, diálogo o focalización. El catálogo acepta hasta 500 fichas por análisis, hasta 40 personajes por escena y hasta 20 ocurrencias por personaje.


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

La API anfitriona aporta acontecimientos persistidos del proyecto activo. Una escena solo recibe un vínculo cuando existe evidencia no obsoleta del mismo documento y de la revisión exacta analizada cuyo rango UTF-16 se solapa con el contenido de la escena. Cada vínculo conserva el ID y etiqueta del acontecimiento, los rangos coincidentes y sus participantes declarados. Para cada participante se informa por separado si también aparece por nombre/alias en las menciones literales de esa escena. La falta de mención no se interpreta como ausencia ni contradicción. La evidencia de otras revisiones, otros documentos o marcada como obsoleta se descarta. El catálogo admite hasta 2.000 acontecimientos, 500 participantes y 200 evidencias por acontecimiento; cada escena devuelve como máximo 100 vínculos y 20 rangos por vínculo.

### Comparaciones de continuidad entre escenas contiguas

La propiedad `sceneContinuity` compara cada par de escenas explícitas consecutivas del fragmento, sin saltar escenas ni inferir transiciones implícitas. Para cada identidad conocida devuelve los rangos de mención en ambas escenas y clasifica la señal como mencionada en ambas, no mencionada en la siguiente o mencionada solo en la siguiente. Para cada acontecimiento con evidencia enlazada devuelve sus rangos de evidencia por escena y si esa evidencia aparece en ambas o solo en una de ellas. Las listas se ordenan por ID y los offsets siguen siendo absolutos UTF-16.

Estas etiquetas describen exclusivamente la cobertura textual disponible. «No mencionado en la siguiente escena» no significa que el personaje esté ausente, haya abandonado el lugar o haya desaparecido de la historia. Del mismo modo, evidencia exclusiva en una escena no demuestra que el acontecimiento termine allí, ni establece orden cronológico entre acontecimientos. Los pares se limitan a las escenas explícitas contiguas y no generan juicios de contradicción ni modifican el manuscrito.

### Co-mención de personajes conocidos

La propiedad `characterCoMentions` agrupa pares de identidades del catálogo cuyos nombres o alias no ambiguos aparecen literalmente dentro de una misma escena explícita. Cada patrón contiene los dos IDs en orden estable, la cantidad de escenas compartidas y sus índices. Los resultados se ordenan por frecuencia descendente y después por IDs, y se limitan a los 100 pares más frecuentes.

La co-mención describe únicamente una coincidencia textual en la misma escena. No acredita que los personajes se encuentren físicamente, interactúen, conversen, mantengan una relación ni compartan el punto de vista narrativo. La evidencia de cada mención permanece disponible en `explicitScenes` para inspección.


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
