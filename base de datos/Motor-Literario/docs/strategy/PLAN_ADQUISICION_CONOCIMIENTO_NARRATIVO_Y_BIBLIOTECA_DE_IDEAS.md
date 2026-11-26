# Plan de trabajo: adquisición de conocimiento narrativo y biblioteca de ideas

**Estado:** hoja de ruta activa de implementación  
**Prioridad:** máxima para el siguiente ciclo de desarrollo  
**Implementación:** TypeScript / JavaScript puro en `base de datos/Motor-Literario/typescript/`  
**Rama inicial:** `feat/narrative-idea-discovery-v1`  
**Regla de alcance:** primero aprender a obtener y organizar conocimiento del texto; almacenamiento y sincronización quedan subordinados a esa necesidad.

## 1. Qué problema estamos resolviendo

El objetivo principal no es guardar más datos. Es conseguir que el motor pueda leer el material narrativo que escribe o incorpora el usuario, reconocer qué información contiene, separar lo explícito de lo interpretado y convertirlo en conocimiento útil para el proyecto.

La biblioteca de ideas debe poder alimentarse del manuscrito, notas, fragmentos, conversaciones de trabajo y material de referencia que el usuario incorpore. No debe depender de que el usuario recuerde escribir etiquetas como `IDEA:`, `EVENTO:` o `PERSONAJE:`.

El motor no debe limitarse a buscar palabras clave. Debe construir una representación trazable de lo leído y relacionar sus hallazgos con el contexto del proyecto.

## 2. Resultado que queremos conseguir

Al analizar un texto, el sistema deberá poder:

1. Reconocer menciones de personajes, lugares, objetos, grupos y conceptos.
2. Detectar acciones, acontecimientos, estados, objetivos, intenciones, motivaciones y conflictos.
3. Identificar ideas narrativas: temas, premisas, preguntas, hipótesis, giros posibles, motivos y propuestas.
4. Reconocer relaciones entre entidades y entre ideas, indicando qué evidencia respalda cada vínculo.
5. Situar acontecimientos en el tiempo cuando el texto aporte referencias suficientes, sin inventar fechas ni ordenar lo que no pueda ordenarse.
6. Detectar repeticiones, variaciones, desarrollos, contradicciones y posibles conexiones entre fragmentos o documentos.
7. Distinguir lo que el autor afirma, lo que un personaje cree, lo que se pregunta, lo que se supone y lo que el motor solo propone como interpretación.
8. Incorporar hallazgos a una biblioteca consultable, agrupable y revisable, conservando su origen y su historial.

## 3. Principios que no se pueden romper

- **Evidencia primero:** cada hallazgo debe apuntar al documento, revisión, rango y fragmento que lo respalda.
- **No inventar:** una asociación probable no se presenta como hecho; una coincidencia de palabras no demuestra que dos ideas sean iguales.
- **Separar voces:** lo que dice o cree un personaje no se convierte automáticamente en verdad del mundo narrativo ni en opinión del autor.
- **Certeza explícita:** clasificar los resultados como explícitos, inferidos/candidatos, ambiguos o desconocidos. La confianza expresa claridad de la señal, no verdad objetiva.
- **Revisión humana:** el sistema propone; el usuario confirma, corrige, descarta o fusiona. No reescribe el manuscrito ni decide el canon por su cuenta.
- **No perder contradicciones:** conservar afirmaciones incompatibles con sus fuentes y fechas; no borrar una para hacer que la historia parezca coherente.
- **Contexto de proyecto:** evitar mezclar libros, proyectos, versiones, personajes homónimos o notas de distinto origen.
- **Determinismo y límites:** misma entrada y misma versión del analizador deben producir resultados reproducibles; procesar documentos grandes con límites explícitos y resultados parciales identificados.
- **Tecnología:** TypeScript/JavaScript puro, sin depender de servicios externos, APIs de IA ni infraestructura remota para que la lectura básica funcione.

## 4. Arquitectura lógica prevista

El flujo de adquisición será:

`fuente → segmentación → extracción → interpretación tipada → resolución de identidad → relaciones → biblioteca → revisión del usuario`

### 4.1 Fuentes y segmentación

Entradas: manuscritos completos, capítulos, escenas, notas, fichas, resúmenes y textos importados. Cada entrada conserva proyecto, documento, revisión, tipo de fuente y ubicación.

La segmentación debe respetar párrafos, oraciones, encabezados y escenas explícitas. Los fragmentos analizados deben conservar offsets que permitan volver al texto exacto. No se inventarán límites de escena por cambios vagos de tema.

### 4.2 Extracción de señales

Detectores especializados identificarán:
- entidades y alias;
- acciones y acontecimientos;
- relaciones y participantes;
- atributos y estados;
- expresiones temporales;
- objetivos, deseos, intenciones y motivaciones;
- temas, premisas, conflictos, preguntas e hipótesis;
- motivos, símbolos y recurrencias.

Cada detector debe declarar qué patrones reconoce, qué no puede reconocer y sus posibles falsos positivos. La extracción léxica actual es una base inicial, no la meta final.

### 4.3 Interpretación y clasificación

Cada afirmación debe llevar tipo, sujeto, predicado, objeto/valor cuando corresponda, voz o fuente de atribución, polaridad, modalidad, temporalidad, estado de revisión y evidencia.

Ejemplos de distinciones obligatorias:
- “El rey murió” = afirmación narrativa explícita.
- “El rey podría estar vivo” = hipótesis o posibilidad.
- “Mara cree que el rey murió” = creencia atribuida a Mara, no hecho confirmado.
- “¿Y si el rey fuera el padre?” = pregunta/idea candidata.
- “El rey no murió” = afirmación que puede contradecir otra; ambas deben conservarse.

### 4.4 Resolución de identidad y contexto

El motor propondrá si “Mara”, “la capitana” y “ella” se refieren a la misma entidad solo cuando exista evidencia contextual suficiente. Las resoluciones ambiguas deben permanecer separadas o pendientes de revisión. Nunca fusionar automáticamente dos personajes solo porque comparten nombre.

### 4.5 Biblioteca de ideas

La biblioteca no será una lista plana de frases. Cada elemento tendrá:
- identidad estable;
- título o formulación original;
- categoría (tema, premisa, conflicto, personaje, mundo, escena, giro, pregunta, hipótesis, motivo u otra categoría extensible);
- descripción y variantes originales;
- estado (candidata, aceptada, descartada, incorporada, en pausa o sustituida);
- procedencia y evidencias;
- documentos y escenas relacionadas;
- relaciones con otras ideas;
- historial de cambios y decisiones del usuario.

Debe permitir descubrir ideas repetidas o similares, agruparlas como familia y mostrar diferencias. La similitud nunca implica fusión automática. Una idea descartada debe seguir recuperable y no reaparecer como nueva sin explicar por qué.

## 5. Fases de implementación y criterios de aceptación

### Fase A — Descubrimiento de ideas desde prosa natural

**Trabajo:** ampliar el primer módulo `narrative-idea-discovery.ts` para detectar señales naturales en español y, posteriormente, patrones configurables por idioma. Añadir pruebas con prosa realista, frases negativas, preguntas, diálogos, citas y ambigüedad.

**Se acepta cuando:**
- no exige etiquetas manuales;
- conserva offsets y fragmentos exactos;
- distingue pregunta, hipótesis, tema, premisa, conflicto y objetivo;
- no clasifica una frase sin señal suficiente como idea;
- documenta límites y falsos positivos;
- pruebas nuevas y suite completa pasan.

### Fase B — Lectura de entidades y acontecimientos en contexto

**Trabajo:** mejorar la extracción de nombres, alias, pronombres, acciones, participantes, estados y acontecimientos en prosa corriente. Incorporar atribución de voz y contexto de escena.

**Se acepta cuando:**
- las menciones y las identidades consolidadas son conceptos separados;
- una creencia de personaje no se convierte en hecho;
- negación, condicional, pregunta y cita se conservan;
- cada resultado tiene evidencia trazable;
- los casos ambiguos se marcan, no se resuelven por adivinación.

### Fase C — Relaciones, motivaciones y causalidad

**Trabajo:** identificar relaciones explícitas y candidatas entre personajes, ideas y acontecimientos; detectar objetivos, deseos, obstáculos, decisiones y consecuencias expresadas.

**Se acepta cuando:**
- se distingue relación explícita de relación inferida;
- se distingue sucesión temporal de causalidad;
- se conservan actor, acción, objeto, polaridad y atribución cuando estén disponibles;
- no se declara causa por simple proximidad entre dos frases;
- contradicciones y evidencia opuesta permanecen consultables.

### Fase D — Biblioteca inteligente de ideas

**Trabajo:** convertir candidatos revisados en elementos de biblioteca; agrupar temas y variantes, enlazar ideas con personajes/escenas/eventos y facilitar búsqueda por significado estructural y evidencia.

**Se acepta cuando:**
- existe flujo candidato → aceptar/corregir/descartar/fusionar;
- la fusión conserva fuentes e historial;
- las ideas relacionadas no se confunden con ideas idénticas;
- el usuario puede rastrear cada elemento hasta el texto fuente;
- las ideas descartadas no se eliminan silenciosamente.

### Fase E — Evolución del conocimiento narrativo

**Trabajo:** comparar revisiones y documentos para detectar desarrollo, cambios, contradicciones, duplicados probables y cabos sueltos.

**Se acepta cuando:**
- se informa qué cambió y en qué revisión;
- se conserva el estado anterior;
- se diferencia contradicción real de cambio deliberado en la historia;
- el motor puede señalar preguntas abiertas sin inventar respuestas;
- el análisis parcial o limitado se declara como tal.

### Fase F — Integración y rendimiento

**Trabajo:** conectar el motor de lectura y la biblioteca con la persistencia existente, y después con sincronización. Optimizar análisis incremental sin cambiar el significado de los resultados.

**Se acepta cuando:**
- la lógica funciona antes de activar sincronización remota;
- la persistencia almacena hallazgos con procedencia y versión del analizador;
- reanalizar un documento no duplica conocimiento;
- una revisión nueva invalida o revalida evidencia de forma explícita;
- pruebas de regresión, integración, rendimiento y recuperación pasan.

## 6. Qué no se hará todavía

- No se priorizará añadir más tablas, índices o mecanismos de sincronización por sí solos.
- No se declarará “comprensión semántica completa” por añadir expresiones regulares.
- No se enviará el manuscrito a servicios externos ni se requerirán claves/API para la lectura local.
- No se fusionarán ideas, entidades o personajes automáticamente por similitud superficial.
- No se marcará como completada una fase sin código, pruebas y validación CI verificables.
- No se abrirán nuevas líneas de almacenamiento hasta que la fase lógica activa tenga criterios de aceptación satisfechos, salvo correcciones necesarias para ejecutar esa lógica.

## 7. Estado inicial y siguiente trabajo concreto

La rama de trabajo incorpora un primer descubridor de candidatos de ideas desde frases declarativas y preguntas en español, con evidencia y offsets. Es solo un prototipo funcional inicial de la Fase A.

La ejecución CI observada para esa rama completó el type-check, pero falló la suite global: 965 de 966 pruebas pasaron. El fallo corresponde a una prueba existente de extracción de entidades con marcas Unicode combinantes (`narrative-unicode-boundaries.test.mjs`), no a las seis pruebas nuevas del descubridor. Por tanto, la rama no debe considerarse validada ni lista para fusionar.

**Siguiente orden de trabajo obligatorio:**
1. Aislar y corregir el fallo Unicode sin debilitar la prueba.
2. Volver a ejecutar CI y exigir suite completa aprobada.
3. Revisar la cobertura de Fase A con casos narrativos naturales más amplios.
4. Ampliar la lectura contextual para entidades, acciones, atribución, negación y acontecimientos.
5. Continuar con relaciones/motivaciones y, después, biblioteca de ideas.
6. Actualizar este documento con cada cambio real, pruebas y límites observados.

## 8. Avance de la Fase A: señales de intención y modalidad

La primera implementación ya no se limita a tema/premisa/conflicto declarados. Se amplió el descubrimiento de prosa natural para reconocer:
- objetivos expresados mediante verbos como querer, desear, pretender, intentar y buscar;
- motivaciones declaradas mediante “su motivación/razón es…” o construcciones “lo hace porque…”;
- semillas creativas en expresiones como “me gustaría explorar…”, “sería interesante que…” e “imagina una historia…”;
- temas planteados mediante “la trama/la historia gira en torno a…”;
- objetivos y deseos expresados mediante “necesita…” y “sueña con…”;
- dilemas expresados mediante elecciones entre alternativas;
- modalidad lingüística: afirmada, negada, condicional o hipotética.

La propiedad `polarity` describe la forma lingüística detectada; no certifica que el contenido sea verdad ni que sea canon. En particular, una negación no debe convertirse en un deseo afirmado (la detección contempla negadores separados del verbo de intención), y una hipótesis no debe convertirse en hecho. Los detectores siguen siendo conservadores y no resuelven por sí solos quién es el sujeto de cada intención ni si el deseo pertenece al autor o a un personaje. Esa atribución contextual corresponde a la Fase B.

Se añadieron pruebas para objetivos, motivaciones, dilemas, negación y modalidad hipotética. La suite anterior detectó un defecto real en el extractor de entidades: el pre-filtro de marcadores era sensible a mayúsculas y rechazaba encabezados como “Personaje Aná”; además, el prefijo opcional podía consumir la primera letra del nombre cuando se hacía insensible a mayúsculas. Se corrigieron ambos problemas manteniendo los límites de nombre sensibles a mayúsculas y aceptando variantes de capitalización únicamente en los marcadores. La prueba Unicode existente cubre el caso afectado. La validación completa de esta corrección y de los nuevos detectores sigue pendiente de una ejecución CI verde.

### Protección de recursos del descubridor

El análisis detiene la exploración al alcanzar el máximo de 100 candidatos, en lugar de recorrer todo el documento y limitar únicamente el resultado final. Así, el límite también controla el trabajo y la memoria dedicados a señales repetidas. La salida conserva el orden de aparición para el mismo contenido y versión del analizador.

Se añadieron pruebas para objetivos dentro de condiciones y para el límite de candidatos. La suite completa todavía debe ejecutarse en CI antes de considerar validada esta mejora.

### Fase B: extracción explícita de acciones

Se añadió `extractNarrativeActionCandidates` en `typescript/src/narrative-action-extraction.ts`. Identifica patrones explícitos y conservadores de **actor → acción → objetivo**, siempre que el actor y el objetivo ya existan como entidades del mismo proyecto.

Cada candidato conserva:
- ID del personaje que realiza la acción;
- forma verbal detectada y entidad objetivo;
- polaridad afirmada o negada;
- fragmento literal, documento, revisión y offsets UTF-16;
- estado `candidate`, pendiente de revisión.

La primera cobertura incluye formas frecuentes en español (por ejemplo, ayudar, salvar, proteger, atacar, buscar, encontrar, entregar, rescatar, abrir y destruir). Los nombres y alias ambiguos se excluyen para evitar atribuciones inventadas. Se limita la entrada a 2 millones de unidades UTF-16, a 500 entidades, 20 alias por entidad y 120 unidades por nombre; la salida se limita a 200 candidatos. La búsqueda se agrupa por personaje y conjunto de objetivos para evitar recorrer todas las parejas de entidades.

**Límites deliberados:** todavía no interpreta pronombres, sujetos tácitos, voz pasiva, coordinación compleja ni objetos implícitos. No deduce causalidad a partir del orden de las frases. Una acción detectada es una propuesta basada en evidencia, no un hecho confirmado.

Se añadieron pruebas para actor/acción/objetivo, negación, alias, offsets, ambigüedad y ausencia de inferencias implícitas. Pendiente de validación integral en CI.

### Fase B: atribución explícita de afirmaciones

Se incorporó `extractNarrativeAttributedClaims` en `typescript/src/narrative-claim-extraction.ts`. Esta primera pieza detecta construcciones explícitas en las que un personaje ya identificado cree, piensa, supone, sospecha, afirma, asegura, recuerda, teme o dice algo.

Cada resultado conserva:
- ID de la entidad que habla, resuelto únicamente contra personajes del mismo proyecto;
- tipo de atribución (creencia, afirmación, recuerdo, temor o habla);
- contenido literal atribuido, sin paráfrasis;
- polaridad afirmada/negada;
- evidencia, documento, revisión y offsets UTF-16;
- estado de revisión `candidate`, nunca hecho confirmado.

Los alias solo se utilizan si resuelven a una única identidad. Si dos personajes comparten un nombre/alias, el extractor omite esa atribución en vez de adivinar. La función tiene límites de tamaño y máximo de 200 resultados.

**Límite conocido:** todavía no resuelve citas indirectas complejas, cambios de hablante entre turnos, pronombres (“él dijo…”) ni distingue automáticamente narrador de personaje. Tampoco infiere quién realiza una acción descrita sin un verbo de atribución explícito. Esas capacidades requieren contexto de discurso y análisis de eventos en pasos separados.

Se añadieron pruebas para atribución, tipos de voz, negación, offsets, alias ambiguos y aislamiento por proyecto. La implementación queda pendiente de validación integral en CI. El workflow del repositorio está configurado para pull requests, pero no hay una ejecución/check nuevo asociado al último head; no se considera validada.


### Fase B: agrupación de acciones en acontecimientos candidatos

Se añadió `extractNarrativeEventCandidates` en `typescript/src/narrative-event-extraction.ts`. Agrupa acciones explícitas ya extraídas cuando aparecen dentro de la misma oración y construye un candidato de acontecimiento con:
- fragmento de la oración como etiqueta provisional;
- participantes identificados a partir de actores y objetivos de las acciones;
- referencias a los candidatos de acción que forman el grupo;
- evidencia, documento, revisión y offsets UTF-16;
- estado `candidate`, pendiente de revisión humana.

La agrupación es deliberadamente estructural: compartir oración no significa que dos acciones ocurran simultáneamente, que una cause la otra ni que pertenezcan a una única escena. No se inventan fechas, orden narrativo ni relaciones causales. Si una oración no contiene acciones reconocidas, no se crea un acontecimiento.

También se reforzó el prefiltrado del extractor de acciones para normalizar Unicode NFKC antes de comparar nombres, evitando descartar prematuramente menciones con formas Unicode equivalentes. La normalización solo se usa como filtro; los offsets y fragmentos siguen calculándose sobre el texto original.

## 9. Cómo informar el progreso

Cada entrega debe indicar claramente:
- archivos y funciones modificados;
- comportamiento nuevo que ya existe;
- pruebas añadidas;
- pruebas ejecutadas y resultado exacto;
- fallos pendientes y su causa;
- qué criterio de aceptación se cumplió y cuál no;
- siguiente cambio concreto.

No usar porcentajes estimados como sustituto de estos datos. Distinguir siempre código escrito, pruebas aprobadas, CI aprobado y cambios fusionados en `main`.


### Fase B: referencias temporales explícitas en acontecimientos

El extractor de acontecimientos ahora reconoce referencias temporales conservadoras dentro de la oración que contiene la acción:
- fechas ISO completas (`AAAA-MM-DD`) y fechas numéricas españolas (`DD/MM/AAAA`), validadas contra el calendario real;
- años aislados entre 1000 y 2999, sin inventar mes ni día;
- contadores explícitos del mundo narrativo como `día 12`, conservados como escala `story-day` independiente del calendario real.

Cada referencia conserva el texto original, su precisión y un valor ordinal determinista (días UTC desde epoch para calendario; entero explícito para día interno). No se comparan escalas distintas como si fueran equivalentes. Si una oración contiene más de una referencia temporal distinta, el extractor deja el campo vacío en lugar de escoger una arbitrariamente. Una fecha ausente, inválida o ambigua no se completa por contexto.

Se añadieron pruebas para año bisiesto, fecha inválida, año aislado, día interno y referencias múltiples. Estas pruebas están escritas pero todavía requieren ejecución en CI; no se declara validación hasta que el workflow complete la suite.
