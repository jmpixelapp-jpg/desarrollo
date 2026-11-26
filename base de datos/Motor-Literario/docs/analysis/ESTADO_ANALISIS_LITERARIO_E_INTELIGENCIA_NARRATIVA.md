# Estado de desarrollo: análisis literario e inteligencia narrativa

**Implementación:** `base de datos/Motor-Literario/typescript/`  
**Módulo central:** `src/literary-analysis.ts`  
**Rama de trabajo:** `main`  
**Última actualización documentada:** 26 de noviembre de 2026

Este documento es el registro técnico vivo del alcance, las garantías, los límites y las tandas de trabajo del análisis literario y la inteligencia narrativa de ideas. Debe actualizarse en cada tanda que cambie contratos, comportamiento, pruebas o límites. No sustituye los contratos TypeScript ni los tests: explica qué existe, qué significa y qué falta verificar.

## 1. Objetivo y principios

El motor aporta análisis literario local, reproducible y explicable sobre el manuscrito y el conocimiento narrativo explícito del proyecto. Debe ayudar al escritor a observar estructura, ritmo, recurrencias, relaciones y evolución editorial, sin apropiarse de decisiones creativas.

Principios obligatorios:

- TypeScript/JavaScript es la implementación de producto. No ampliar los prototipos Rust históricos.
- No incorporar servicios remotos ni motores lingüísticos de terceros en tiempo de ejecución.
- No modificar el manuscrito ni convertir una sugerencia en una decisión editorial automática.
- No inventar relaciones causales, cronologías, participantes, escenas o hechos que no estén declarados o respaldados por evidencia.
- Diferenciar siempre ausencia comprobada, dato desconocido, muestra incompleta y truncamiento por presupuesto.
- Mantener aislamiento por proyecto y conservar la procedencia de los datos.
- Hacer los resultados deterministas para una misma instantánea, y proteger la caché frente a mutaciones del consumidor.

## 2. Alcance implementado

### 2.1 Análisis descriptivo del manuscrito

El módulo `src/literary-analysis.ts` expone análisis de fragmentos y documentos con rangos UTF-16. Entre las familias de señales implementadas se encuentran:

- Ritmo: longitud media y mediana de oraciones y párrafos, dispersión, bandas de longitud, cambios entre oraciones y perfiles por escena.
- Diálogo: detección de formatos reconocidos, proporción y densidad, segmentos y párrafos dialogados, bloques mixtos y comparaciones entre escenas. No atribuye hablantes cuando no hay evidencia explícita.
- Escenas: solo se segmentan a partir de encabezados o separadores explícitos; no se infieren escenas por cambios de contenido.
- Voz y gramática: señales de primera, segunda y tercera persona, por escena y en el agregado, con exclusión de diálogo reconocido y muestras con offsets. No identifican por sí solas al narrador.
- Ecos y recurrencias: repeticiones literales, aperturas, anáforas bajo reglas explícitas y vocabulario sensorial reconocible.
- Personajes y acontecimientos: menciones nominales no ambiguas, participación declarada, evidencias vinculadas a documento y revisión, perfiles por escena y trayectorias integradas. Mención, participación y evidencia de atributos permanecen como conceptos distintos.
- Cronología y causalidad: se muestran únicamente referencias temporales, conectores y participantes explícitos; los candidatos requieren revisión y no se convierten automáticamente en hechos persistentes.

Los resultados conservan rangos UTF-16 para permitir que el anfitrión navegue a la evidencia. Las métricas descriptivas no equivalen a una evaluación estética ni a una interpretación semántica completa.

### 2.2 Catálogo e inteligencia estructural de ideas

El resultado `ideaGraph` analiza el catálogo global del proyecto cuando el adaptador permite obtenerlo. El modo heredado `character-linked-fallback` se declara por separado y nunca se presenta como catálogo exhaustivo.

El contrato `LiteraryIdeaGraphAnalysis` incluye, entre otras, estas dimensiones:

- Alcance, exhaustividad, cantidad de ideas y cantidad de ideas omitidas.
- Distribución por estado editorial (`IDEA`, `incorporated`, `discarded`) y perfiles de transición entre estados.
- Consistencia entre el estado vigente y el historial visible: ideas consistentes, divergentes, desconocidas, verificables y cobertura de verificación.
- Referencias explícitas totales, incluidas, fuera del snapshot y ausentes de un catálogo de proyecto que sí sea completo.
- Referencias recíprocas, auto-referencias, nodos fuente, terminales, bifurcaciones, convergencias y nodos aislados.
- Componentes débiles, componentes fuertemente conexos, ciclos, puntos de articulación y muestras limitadas.
- Distancia dirigida mínima hasta un terminal y cobertura de alcanzabilidad terminal dentro del snapshot.
- Convergencia a dos saltos, destinos compartidos/exclusivos y estado explícito de completitud del cálculo.

Las relaciones del grafo son exclusivamente las declaradas en `relatedIdeaIds`. Una arista no significa causalidad, dependencia, orden temporal, equivalencia semántica ni aprobación editorial.

### 2.3 Semántica de las referencias y del snapshot

Cada referencia se clasifica según el alcance real recibido:

- `included-in-snapshot`: origen y destino están presentes.
- `not-in-snapshot`: destino no está en el snapshot, pero el catálogo puede estar incompleto.
- `missing-from-project`: destino ausente de un catálogo de proyecto declarado completo.

`projectCatalogComplete` solo es verdadero con `catalogScope === "project"` y cero ideas omitidas. No se debe interpretar un destino externo al snapshot como inexistente cuando la muestra es parcial.

Las referencias repetidas siguen siendo aristas explícitas y cuentan en los totales de referencias. Las métricas de vecindad, ramas y convergencia usan destinos únicos cuando así lo define el contrato. Las auto-referencias se cuentan por separado y también constituyen ciclos unitarios; no se confunden con pares recíprocos entre dos ideas distintas.

Los nodos terminales y las distancias se definen dentro del snapshot. Un nodo sin salidas internas puede ser terminal dentro de la muestra aunque conserve referencias externas; el resultado no afirma que sea terminal en todo el proyecto si el catálogo es incompleto.

### 2.4 Historial editorial

Los perfiles por idea resumen los cambios de estado visibles, los retornos a estados anteriores, los motivos y las marcas temporales comparables. Los registros omitidos reducen lo que puede afirmarse: los conteos derivados del historial visible se interpretan como mínimos cuando el historial está truncado.

Las marcas temporales válidas son finitas y no negativas. La consistencia entre estado vigente e historial se informa como `consistent`, `mismatch` o `unknown`; no se repara silenciosamente una divergencia ni se inventa una transición ausente.

### 2.5 Resonancia léxica entre ideas

El grafo incluye `lexicalResonances`, una capa descriptiva separada de las aristas explícitas. Usa normalización Unicode, vocabularios funcionales por idioma, frecuencia documental adaptativa, límites por idea y un presupuesto agregado de texto. La implementación admite varias lenguas mediante sus listas de palabras funcionales.

La resonancia exige solapamiento literal suficiente y presenta medidas de similitud y muestras limitadas. No lematiza ni demuestra sinonimia, intención, equivalencia, continuidad temática o causalidad. Nunca crea ni modifica `relatedIdeaIds`.

## 3. Algoritmos, determinismo y protección de recursos

- Los IDs se ordenan de forma canónica antes de construir el grafo. Las permutaciones del catálogo y de las listas de referencias no deben alterar el resultado.
- La estructura usa índices numéricos y listas de adyacencia; las componentes fuertemente conexas se calculan con recorrido iterativo para evitar desbordamientos de pila en grafos profundos.
- Las componentes débiles se calculan ignorando la dirección. Los puntos de articulación se calculan sobre esa estructura no dirigida.
- La alcanzabilidad mínima a terminales se obtiene mediante recorrido inverso multi-origen.
- El análisis de convergencia a dos saltos tiene un presupuesto de **1.000.000 de expansiones**. Si se excede, `twoHopConvergenceAnalysisStatus` pasa a `truncated-by-work-budget`. En ese caso los contadores de convergencia son parciales y no deben presentarse como totales completos.
- Se conservan hasta **5.000 muestras de referencias**, **100 muestras de ciclos** y **100 muestras de componentes débiles**; los totales globales y contadores de omitidos se mantienen separados de las muestras.
- La memoización estructural se limita a snapshots de hasta **2.000 ideas** y hasta **2.000.000 de unidades UTF-16 de texto**. La clave incluye el alcance, las omisiones y los registros completos de ideas. Si se supera el límite, no se usa esa caché.
- La caché devuelve copias profundas mediante `structuredClone`; mutar una respuesta anterior no debe contaminar llamadas posteriores.
- El presupuesto agregado público de texto léxico es `MAX_LITERARY_IDEA_LEXICAL_TEXT_UNITS = 2_000_000` unidades UTF-16. El resultado debe distinguir texto omitido por presupuesto de texto sin contenido.

Los límites anteriores son parte del contrato operativo: al cambiar uno, actualizar este documento y los tests que lo cubren.

## 4. Sincronización y persistencia de ideas

La sincronización del catálogo no debe sobrescribir decisiones concurrentes:

- Las escrituras de ideas usan comparación y escritura condicional por versión (CAS), con reintentos acotados ante conflictos compatibles.
- Las mutaciones dentro de una instancia se serializan; las operaciones idempotentes no deben duplicar efectos.
- Los vínculos a fichas y a otras ideas se revalidan contra el catálogo durable, incluso después de un conflicto CAS.
- Las sustituciones conjuntas de vínculos comparan contra una instantánea base explícita y rechazan una base obsoleta en vez de borrar cambios concurrentes.
- Las bajas permiten limpiar referencias heredadas a destinos eliminados; las altas no aceptan destinos que otra instancia haya eliminado.
- Las decisiones editoriales concurrentes incompatibles no se fusionan automáticamente.
- Las respuestas públicas entregan copias aisladas y no exponen referencias mutables a las cachés internas.

El motor analiza y sincroniza conocimiento declarado; no debe transformar similitud léxica en enlaces persistentes.

## 5. Cobertura de pruebas añadida para el grafo

El archivo `typescript/tests/literary-analysis-graph-determinism.test.mjs` concentra pruebas de contrato para el grafo. Las tandas recientes incluyen:

| Área | Garantía cubierta |
|---|---|
| Determinismo | Permutar ideas y referencias conserva el resultado canónico. |
| Caché | Mutar respuestas anteriores no contamina snapshots posteriores. |
| Invalidación | Cambios en referencias y alcance invalidan la instantánea memoizada. |
| Catálogo parcial/completo | Se distingue un destino omitido de uno ausente del proyecto. |
| Historial | Se prueban reversiones, marcas temporales, truncamiento y divergencias entre estado e historial. |
| Referencias repetidas | Los totales de aristas se distinguen de vecinos únicos. |
| Auto-referencias | Se cuentan ciclos unitarios sin inflar pares recíprocos. |
| Terminales | Se comprueba distancia mínima y cobertura dentro del snapshot. |
| Componentes | Se verifican componentes débiles desconectados y puntos de articulación. |
| Muestras acotadas | Con 103 componentes y 103 ciclos se mantienen los totales, 100 muestras y 3 omitidos. |
| Dos saltos | Se comprueban destinos compartidos/exclusivos, deduplicación y conservación de ciclos. |
| Presupuesto de dos saltos | Un catálogo sintético de 1.503 ideas fuerza el límite de 1.000.000 de expansiones y comprueba el estado de truncamiento y los agregados de las fuentes completas anteriores. |
| Catálogo vacío | Se comprueban los contadores cero, las colecciones vacías y la cobertura terminal neutral de 1 para un snapshot sin nodos. |
| Offsets Unicode | Un fragmento con emojis antes de las evidencias comprueba que los offsets absolutos de las recurrencias siguen la semántica UTF-16 de JavaScript y respetan el desplazamiento base. |
| Evidencia de acontecimientos y revisiones | Se verifica el anclaje UTF-16 absoluto con prefijos Unicode, el desplazamiento base, y la exclusión de evidencias obsoletas o de otra revisión al construir candidatos de dependencia. |
| Sincronización por lote y eliminación concurrente de destinos | Una carrera entre la validación y la escritura CAS elimina el destino (idea o ficha); el lote debe abortar y preservar la modificación concurrente del registro de origen, sin guardar vínculos colgantes. |
| Aislamiento de proyectos en vínculos por lote | Un identificador de destino existente únicamente en otro proyecto no se considera válido, tanto para ideas como para fichas; la operación rechaza ambos casos sin escribir. |
| Recuperación explícita tras conflicto CAS en lote | La primera sincronización rechaza una instantánea obsoleta y conserva la mutación concurrente; tras refrescar el catálogo, una segunda llamada con la nueva instantánea aplica el lote sin perder el estado ni el historial editorial concurrentes. |
| Operaciones paralelas sobre registros distintos | Dos instancias del anfitrión sincronizan ideas de origen distintas en paralelo; ambas escrituras CAS se confirman y cada conjunto de vínculos permanece aislado en su registro. |
| Conflicto entre lotes sobre el mismo registro | Dos instancias intentan reemplazar simultáneamente los vínculos de la misma idea a partir de la misma instantánea; exactamente una escritura prevalece y la otra operación falla por conflicto CAS, sin sobrescritura silenciosa. |
| Contrato transaccional IndexedDB de referencias | Pruebas estáticas de la implementación verifican que la lectura CAS y las validaciones de ideas/fichas se ejecutan dentro del mismo alcance `readwrite`, que el `put` espera todas las comprobaciones y que una referencia inválida aborta la transacción. Estas pruebas inspeccionan el código fuente; no sustituyen una prueba de integración con IndexedDB real. |
| Persistencia IndexedDB nativa de ideas | Una prueba de integración abre el almacén real del adaptador, intenta guardar una referencia inexistente y comprueba que el registro original permanece intacto; después confirma un vínculo válido y rechaza una escritura basada en una instantánea CAS obsoleta. Se omite explícitamente si el runtime no proporciona IndexedDB nativo. |
| CAS concurrente en IndexedDB nativo | Dos instancias independientes intentan guardar ediciones distintas de la misma idea a partir de la misma versión; se exige exactamente un commit, un conflicto CAS y un único estado durable ganador. |
| Agotamiento de reintentos CAS de vínculos | Inyecta tres conflictos consecutivos de otras instancias, verifica que la mutación local no sobrescribe ninguno, que el límite de tres intentos se respeta y que la siguiente lectura recarga el estado durable tras el último conflicto. |
| Eliminación concurrente del destino durante un reintento | Simula que una idea o ficha destino desaparece justo cuando otra instancia modifica la idea de origen. Tras el conflicto CAS, el motor recarga el catálogo, rechaza el alta y conserva la modificación concurrente sin persistir una referencia colgante. |
| Integridad y atomicidad de referencias en IndexedDB nativo | Una misma escritura combina un destino de entidad válido con un destino idea inválido: la transacción aborta y conserva intacta la idea. También se rechazan ideas destino inexistentes o pertenecientes a otro proyecto; el guardado combinado de destinos válidos del mismo proyecto sí se confirma. |
| Snapshot parcial y referencias externas repetidas | Comprueba que cada arista explícita se contabiliza, que los destinos ausentes no se clasifican como inexistentes del proyecto cuando hay ideas omitidas y que la alineación de estados permanece desconocida. También confirma que los estados observados como mixtos conservan esa conclusión aunque existan destinos fuera del snapshot. |
| Truncamiento exacto de muestras de referencias | Construye 5.001 referencias externas y verifica que el grafo conserva los contadores completos, expone exactamente 5.000 muestras, informa una omitida y marca `referencesTruncated` sin clasificar destinos externos como ausentes del proyecto en un snapshot parcial. |
| Truncamiento de cronología de acontecimientos | Construye 202 puntos y 201 transiciones; verifica que se conservan los totales, se exponen exactamente 200 muestras por colección y se informan dos puntos y una transición omitidos. |
| Muestras de identificadores en puntos temporales | Construye 55 acontecimientos en un mismo punto y verifica que el total permanece en 55, se exponen 50 identificadores ordenados y se informa que cinco quedaron fuera de la muestra. |
| Memoria de muestras de evidencia temporal | El constructor mantiene durante la agregación solo las 20 mejores evidencias ordenadas, sin acumular la colección completa; una prueba invierte 200 evidencias y verifica que el top 20 sigue siendo determinista, y una auditoría estática protege el límite de memoria. |
| Evidencia de acontecimientos por escena | Una escena con 35 rangos de evidencia para un acontecimiento conserva el contador completo, expone solo las 20 primeras muestras ordenadas y marca el truncamiento; la acumulación intermedia también queda limitada a 20. |
| Memoria de evolución de atributos | Los buckets locales por escena y por punto temporal se ordenan in situ; la auditoría estática impide reintroducir copias completas de las colecciones de aserciones antes de limitar las muestras visibles. |
| Localización de escenas para afirmaciones | La asignación de evidencia a escenas explícitas usa búsqueda binaria sobre los rangos ordenados, reduciendo la búsqueda por afirmación de lineal a logarítmica; una regresión con 1.200 escenas y una auditoría estática protegen el comportamiento. |
| Snapshots dispersos de evolución de atributos | Cada perfil materializa únicamente las escenas con afirmaciones y ordena sus índices explícitamente, evitando recorrer todas las escenas por cada combinación personaje/atributo; una regresión invierte las afirmaciones y verifica que el resultado conserve el orden documental. |
| Continuidad de eventos entre documentos | Se indexan acontecimientos por ID y se cuentan evidencias activas externas mediante un recorrido incremental, sin `flatMap` ni arreglos intermedios; la auditoría estática protege el recorrido y la búsqueda por ID. |
| Truncamiento de resonancias léxicas | Genera 102 pares candidatos independientes y verifica que el motor conserva el total, expone las 100 mejores resonancias y declara dos pares omitidos. |
| Truncamiento de términos compartidos | Construye una resonancia con 15 términos comunes y verifica que la muestra conserva 12, informa tres omitidos y mantiene frecuencias literales de ambos textos. |
| Presupuesto léxico de ideas omitidas por el anfitrión | Verifica que las ideas marcadas `textOmitted: budget` se contabilizan como omitidas, no como ideas sin texto, no consumen presupuesto de tokenización y no impiden analizar ideas posteriores incluidas en la misma instantánea. |
| Presupuesto agregado de texto léxico | Auditoría estática conjunta del anfitrión y analizador comprueba que el texto de ideas enlazadas también reserva presupuesto, porque se incorpora al grafo desde `knownIdeas`, aunque no se duplique en el catálogo global. |
| Límite léxico agregado en el anfitrión | Una prueba de integración crea 21 ideas de 100.000 unidades UTF-16, una enlazada a personaje; exige que el texto enlazado reserve su parte del presupuesto, que se analicen exactamente 20 ideas y que el total tokenizado no supere 2.000.000. Pendiente de ejecución en el entorno del proyecto. |

Estas pruebas describen contratos, no demuestran por sí mismas que la suite se haya ejecutado. La verificación automatizada completa se realiza desde `typescript/` con `npm test`, que primero compila, valida el esquema y almacenamiento, y después ejecuta las suites Node. También existen `npm run typecheck`, `npm run build` y `npm run bench`.

## 6. Registro de tandas recientes

Registro de commits de la línea de trabajo del análisis de ideas en `main`:

- `890c37f`: prueba de determinismo del grafo.
- `ef9ffe5`: protección de caché frente a mutaciones de respuestas.
- `06fbe8d`: invalidación de caché por cambios de referencia y alcance completo/parcial.
- `9f474ed`, `c8e0631`, `4979890`, `35d65b3`: historial de estados, timestamps, reversiones, truncamiento y consistencia agregada.
- `d486467`: referencias repetidas y separación entre aristas y destinos únicos.
- `151647e`: resolución de referencias según catálogo completo/parcial y perfiles por estado.
- `3e0f3db`: auto-referencias, ciclos unitarios y pares recíprocos.
- `45e9e91`: distancia a terminales y cobertura de alcanzabilidad.
- `4353945`: puntos de articulación en componentes débiles desconectados.
- `95d8f50`: límites de muestras de componentes y ciclos con totales y omitidos.
- `b681a9c`: deduplicación de caminos de dos saltos y preservación de ciclos en el fixture de prueba.
- `0974302`: invariantes del catálogo vacío y métricas de cobertura.
- `492753b`: prueba de estrés que fuerza el presupuesto de un millón de expansiones de convergencia a dos saltos.
- `997b810`: incorpora la regresión de offsets UTF-16 absolutos tras caracteres Unicode suplementarios en evidencias entre escenas.
- `39d73c9`: corrige el fixture Unicode para separar escenas con saltos de línea reales, de modo que el test ejercite efectivamente la segmentación explícita.
- `2be9631`: verifica anclajes de evidencia de acontecimientos con offsets absolutos UTF-16 y excluye evidencia marcada obsoleta o perteneciente a otra revisión.
- `8603f7b`: cubre la desaparición concurrente de destinos (idea y ficha) durante la sincronización por lote y comprueba que el CAS no sobrescriba la actualización concurrente ni persista vínculos colgantes.
- `25a1291`: verifica que una idea o ficha con el mismo ID en otro proyecto no pueda convertirse en destino de un vínculo del proyecto activo.
- `9f6802a`: prueba que una sincronización rechazada por CAS puede reintentarse explícitamente con la instantánea refrescada y preservar los cambios editoriales concurrentes.
- `0235361`: comprueba que dos instancias pueden sincronizar en paralelo ideas de origen distintas sin mezclar ni perder sus vínculos.
- `41bc0dd`: comprueba que dos lotes concurrentes sobre la misma idea no se pisan: uno confirma y el otro recibe un conflicto de versión.
- `00196e6`: añade auditorías de contrato para el alcance transaccional IndexedDB, la barrera previa al `put`, el aborto ante referencias inválidas y la inclusión del almacén de entidades.
- `424f3d6`: incorpora una prueba de integración con IndexedDB nativo para comprobar rollback de referencias inválidas, persistencia de vínculos válidos y rechazo de CAS obsoleto.
- `60b0282`: añade una carrera real entre dos instancias IndexedDB que comprueba que dos CAS simultáneos sobre la misma idea producen un único ganador durable.

Los hashes anteriores son referencias abreviadas; cada cambio debe revisarse en su commit de GitHub para conocer su diff exacto. El trabajo concurrente de otros colaboradores puede intercalar commits en `main`; no atribuir esos cambios a esta línea de trabajo.

- `02f03a5`: amplía la integración IndexedDB nativa para comprobar referencias a ideas inexistentes, aislamiento de IDs entre proyectos y aceptación de destinos válidos del mismo proyecto.
- `e4f0870`: amplía la integración IndexedDB para probar el carácter atómico de una escritura que combina referencias a entidades e ideas: un destino idea inválido revierte también el vínculo de entidad válido.

- `1e155b1`: añade regresión del grafo para referencias externas repetidas en snapshots parciales, verificando contadores por arista y semántica de incertidumbre.
- `808b7aa`: añade el caso mixto de alineación de estados: destinos incluidos con estados diferentes mantienen `mixed-status` aunque haya además referencias no resueltas en un catálogo parcial.
- `b8e59a5`: añade una regresión del análisis léxico para comprobar la contabilidad de ideas omitidas por presupuesto y la conservación de resonancias entre ideas que sí fueron analizadas.
- `dcecf54`: cubre el agotamiento de los tres intentos CAS de un vínculo, preservación de las tres mutaciones concurrentes y recarga posterior de la caché.
- `40f3a10`: verifica que las altas de vínculos a ideas y fichas se vuelven a validar si el destino desaparece durante el conflicto CAS; `d0c6913` ajusta el recuento de lecturas de catálogo de la prueba.
- `69cfe64`: añade una regresión de 5.001 referencias para comprobar el límite exacto de 5.000 muestras y la separación entre contadores completos y muestras truncadas.
- `389411d`: añade una regresión de cronología con 202 puntos y 201 transiciones para comprobar el límite de 200 muestras y los contadores de omisiones.
- `eaa2614`: añade una regresión del límite de cien resonancias léxicas con 102 pares candidatos y dos omitidos.
- `e42b287`: verifica que cada resonancia contabiliza términos compartidos más allá de su muestra de doce y conserva las frecuencias de los términos expuestos.
- `f3e23fe`: cambio intermedio de contabilidad del presupuesto léxico, posteriormente revertido al comprobar que el analizador incorpora las ideas enlazadas desde `knownIdeas`.
- `8efd07c`: restaura la reserva presupuestaria para textos enlazados, que también entran en el grafo léxico aunque no se dupliquen en el catálogo global.
- `845b2bc`: amplía la auditoría estática para verificar conjuntamente la reserva del anfitrión y la incorporación del texto enlazado al grafo.
- `62881c6`: añade una prueba de integración del anfitrión con 21 textos de 100.000 unidades para forzar el límite agregado de dos millones.
- `d4f714d`: ajusta la longitud exacta del fixture de estrés a 100.000 unidades UTF-16 por idea.
- `4e73f4f`: completa el store de documentos de prueba para que la integración ejercite `analyzeLiteraryDocument` a través del anfitrión.
- `56cb870`: añade cobertura del límite de 50 identificadores de acontecimientos por punto de cronología, manteniendo el contador total y el número omitido.
- `e22b6c5`: corrige el separador de escena del fixture de cronología para que el texto de prueba contenga un salto de línea real.
- `21793ad`: limita la memoria temporal del constructor de cronología a veinte muestras de evidencia por punto, manteniendo por separado los contadores completos.
- `1e626c4`: verifica que el top 20 de evidencias permanece ordenado y estable aunque las 200 evidencias lleguen en orden inverso.
- `79b380a`: añade auditoría estática del límite de acumulación de evidencia temporal.
- `d5faab8`: corrige el delimitador de función de la auditoría estática.
- `6b0767e`: limita la acumulación de evidencia coincidente por vínculo de escena a veinte rangos ordenados, sin perder el contador total.
- `b4a03f4`: añade una regresión con 35 rangos de evidencia en orden inverso.
- `6079eeb`: corrige el separador de líneas del fixture de escena.
- `29a3ef0`: añade auditoría estática del límite de veinte rangos durante la agregación.
- `8076c46`: corrige el delimitador de función de la auditoría estática de vínculos.
- `e4e7b66`: ordena in situ los buckets locales de aserciones por escena y por punto temporal, evitando copias completas innecesarias.
- `0ccc036`: añade auditoría estática para evitar regresiones que vuelvan a duplicar esos buckets.
- `5335e5b`: corrige el delimitador de la auditoría de evolución de atributos.
- `6693c59`: indexa acontecimientos por ID y cuenta evidencias externas directamente, evitando escanear el catálogo completo por cada decisión y materializar arreglos de evidencia.
- `95daff5`: añade una prueba de estrés autocontenida con cinco fuentes, quinientos intermediarios y quinientos destinos; cuatro fuentes completan un millón de expansiones y la quinta activa el truncamiento.
- `f9af2b0`: añade auditoría estática del recorrido acotado de continuidad entre documentos.
- `98f31e0`: corrige el delimitador de la auditoría de continuidad.
- `d79b5aa`: simplifica las aserciones estáticas de continuidad para comparar fragmentos literales del código.
- `2e4e5c1`: corrige los escapes de salto de línea en la auditoría estática.
- `88e2c09`: sustituye el recorrido lineal de escenas por afirmación de atributo por una búsqueda binaria sobre rangos documentales ordenados.
- `9d5f2c2`: añade una regresión funcional con 1.200 escenas y 1.200 afirmaciones para verificar la asignación y el orden de la evolución de atributos.
- `b3cb92b`: añade auditoría estática para impedir que la búsqueda binaria vuelva a convertirse en un recorrido lineal.
- `47de3f9` y `931ff61`: corrigen los separadores de escena del fixture y el límite de extracción de la auditoría.
- `f98295e`: los snapshots de evolución de atributos recorren solo las escenas con evidencia del perfil, en vez de escanear todas las escenas por cada atributo.
- `d7e789d`: invierte el orden de las afirmaciones en la regresión de 1.200 escenas y comprueba que los snapshots continúan ordenados documentalmente.
- `eb3b2e3`: añade auditoría estática para proteger la materialización dispersa y el orden de escenas.
- `6217c45`: corrige el delimitador de la auditoría de snapshots dispersos.
- `704c6fb`: añade cobertura de offsets UTF-16 en afirmaciones narrativas con nombres Unicode suplementarios y emoji.
- `eee3423`: comprueba los offsets de afirmaciones vinculadas a ideas y acontecimientos.
- `5956655`: verifica explícitamente que los offsets de afirmaciones usan unidades UTF-16, coherentes con los índices de JavaScript.
- `b3a8302`: corrige el fixture para usar saltos CRLF reales y comprobar el cálculo de rangos de evidencia.
- `87c57d4`: refuerza los límites Unicode al reconocer nombres narrativos, evitando coincidencias parciales dentro de palabras.
- `4461a68`: corrige el escape de expresiones regulares y los límites Unicode de los nombres.
- `ee0464d`: añade regresiones para evitar coincidencias parciales con marcas combinantes.
- `df1a10a`: corrige el fixture para incluir una marca combinante Unicode real, no una secuencia literal escapada.

Esta tanda se concentra en la integridad de la evidencia textual: los rangos deben permanecer en unidades UTF-16, respetar saltos LF/CRLF y no aceptar prefijos de nombres cuando el carácter siguiente sea una marca combinante. Los commits están publicados en `main`; no se atribuyen a esta tanda cambios de otras ramas ni se consideran validados por CI sin checks observables.
## 7. Pendientes y siguiente secuencia de trabajo

1. Ejecutar la prueba de estrés que fuerza el límite de un millón de expansiones de dos saltos y confirma `truncated-by-work-budget`; el fixture autocontenido comprueba que cuatro fuentes completan un millón de expansiones y que la quinta se interrumpe, conservando contadores parciales explícitos.
2. Completar casos límite adicionales de catálogo vacío, nodos sin referencias, referencias externas y snapshots con omisiones; ya hay cobertura para catálogo vacío, omisiones y referencias externas repetidas.
3. Auditar los presupuestos de memoria y tiempo de cada fase del análisis, no solo del grafo y del texto léxico; la reserva del presupuesto para ideas enlazadas ya tiene auditoría estática conjunta y una prueba de integración con 21 textos de 100.000 unidades UTF-16. La cronología y los vínculos de acontecimientos limitan sus muestras intermedias; la evolución de atributos localiza escenas en tiempo logarítmico por afirmación y materializa snapshots solo para escenas con evidencia; la continuidad entre documentos cuenta evidencias sin materializar colecciones y resuelve acontecimientos mediante un índice por ID. Falta ejecutar y medir las pruebas en el entorno del proyecto y continuar la auditoría de las demás colecciones públicas.
4. Revisar el comportamiento de muestras y truncamiento en cada colección pública: el grafo tiene regresión para 5.001 referencias y muestras exactas de componentes y ciclos; la cronología verifica 202 puntos y 201 transiciones con muestras de 200, 55 identificadores de eventos con muestra de 50 y 35 rangos de evidencia por vínculo con muestra de 20; las resonancias léxicas verifican 102 candidatos con muestras de 100 y 15 términos compartidos con muestras de 12; falta extender la auditoría sistemática a las demás colecciones públicas.
5. Ampliar las pruebas de sincronización concurrente de ideas: el agotamiento de tres intentos CAS y la eliminación de destinos durante un reintento ya tienen regresión; quedan intercalado de eliminaciones y escrituras de varios registros, y revalidación de catálogos cuando cambian repetidamente durante una operación.
6. Ampliar las pruebas de regresión de offsets UTF-16 por escena, evento y afirmación en cambios de revisión, rangos parciales y límites de fragmento. La extracción de afirmaciones ya tiene casos para emoji, nombres Unicode, marcas combinantes y CRLF; falta extender los casos a fragmentos concatenados y a cambios de revisión con evidencia parcialmente obsoleta.
7. Ejecutar y registrar `npm run typecheck`, `npm test` y `npm run bench` en un entorno de proyecto; no declarar verde una verificación sin resultados observables.
8. Validar la experiencia desde el programa anfitrión con manuscritos reales de prueba, manteniendo datos sintéticos o autorizados y confirmando que el motor nunca edita el texto por sí solo. Esta validación externa no se sustituye por las pruebas unitarias del motor.
9. Ejecutar la nueva prueba de IndexedDB nativo en Node 22.13 o superior y ampliar la integración a transacciones solapadas, orden de escrituras y carreras entre altas/bajas de entidades y guardados CAS; las pruebas añadidas cubren rollback, CAS obsoleto, CAS concurrente entre dos instancias y validación transaccional de destinos idea, pero no agotan los escenarios de altas/bajas concurrentes de entidades.

## 8. Estado de validación al actualizar este documento

La rama de trabajo sigue siendo `main`. `57e3d56efd6a6dc210d38990ef1f4643ad7d3dd4` es el HEAD de la tanda anterior. En los avances siguientes se publicaron `2f9a941` y `e650d12` (recuperación canónica del cursor y regresión IndexedDB), `ff73710` y `16c2312` (límites Unicode y pruebas de eventos), `56ae149` y `159351a` (captura Unicode de entidades/relaciones y límites de prefijo), `ee069fa` (tres regresiones adicionales), `dec152f` (documentación actualizada) y `768fbc9` (registro de validación). Las consultas de checks y workflows para los commits de código más recientes devolvieron colecciones vacías; por tanto, **los cambios y pruebas están publicados, pero no se declaran verificados**.

La PR #59 propone integrar la outbox saliente con mutaciones CAS y migrar IndexedDB DB27→DB28. Sigue en revisión y no equivale a sincronización multidispositivo completa: la descarga remota incremental, el cursor del servidor, la resolución de conflictos y el transporte autenticado siguen siendo responsabilidades pendientes.

La documentación debe seguir separando tres estados: implementación presente, cobertura de pruebas escrita y ejecución de pruebas confirmada. Son evidencias distintas.


### Tanda 26-11-2026 — idempotencia canónica del replay de dominio

- `narrative-sync-domain-handlers.ts` compara ahora los snapshots existentes y entrantes mediante `areNarrativeSyncPayloadsEquivalent`, que canonicaliza el JSON por orden de claves, en lugar de depender del orden de inserción de `JSON.stringify`.
- La corrección se aplica a los cinco handlers de upsert: ideas, afirmaciones, relaciones, acontecimientos y entidades.
- Un replay cuyo contenido JSON es equivalente no vuelve a ejecutar la escritura CAS por una mera diferencia en el orden de propiedades. Esto evita escrituras innecesarias y conserva la idempotencia tras reintentos y recuperación de operaciones.
- Se añadió una regresión de `idea-upsert` que invierte deliberadamente el orden de las propiedades y comprueba que no se invoca la escritura.
- Commits publicados en `main`: `bffa0bd` (implementación) y `d466c34` (regresión).
- **Validación pendiente:** el cambio y la prueba están publicados; todavía no se declara que typecheck, build o suite completa hayan pasado hasta observar GitHub Actions o ejecutar las órdenes en el entorno Node del proyecto.

### Tanda 26-11-2026 — recuperación durable e integridad de nombres Unicode

**Frente A — sincronización y recuperación**
- `applyCursorRecoveryProposal` compara la instantánea releída del diario mediante `areNarrativeSyncPayloadsEquivalent`, evitando falsos cambios de diario por el mero orden de propiedades JSON.
- Se añadió una prueba con IndexedDB simulado que reordena deliberadamente las propiedades del registro persistido y exige que la recuperación lo reconozca como `already-consistent`.
- Esto complementa la comparación canónica de los cinco handlers de dominio y cierra otra ruta de comparación sensible al orden de claves.

**Frente B — análisis de acontecimientos y continuidad de personajes**
- Los límites de nombre de `unicodeNamePattern` incluyen ahora `\\p{M}` además de letras, números y guion bajo. Una marca combinante ya no permite que el nombre base coincida falsamente como prefijo.
- Se incorporaron siete regresiones: límites de participantes, contradicciones vitales, extracción de entidades, extracción de relaciones, aceptación de nombres descompuestos y rechazo de prefijos falsos.
- La corrección conserva el texto original y los offsets UTF-16; la normalización se limita a comparar identidades, nunca modifica el manuscrito.

**Frentes en curso**
- La PR #59 trabaja en la integración de la outbox saliente con mutaciones CAS y migración IndexedDB DB27→DB28; sigue separada de la descarga remota y de la resolución de conflictos.
- Continúan pendientes la reconciliación de escrituras concurrentes entre dispositivos, el transporte autenticado proporcionado por el anfitrión y las pruebas de integración extremo a extremo.
- La suite completa, typecheck, build y benchmarks deben ejecutarse y observarse antes de marcar estos avances como verificados.


**Extensión del frente Unicode:** los extractores de entidades y relaciones también incluyen marcas combinantes dentro de los nombres y las tratan como parte de los límites. Así se evita que `Ana` se asocie falsamente a `Ana` seguido de una marca combinante y se permite reconocer el nombre descompuesto completo.


### Tanda 26-11-2026 — primera capa de ingesta estructural de libros

**Objetivo del frente:** reforzar la adquisición de información desde el texto real de las obras, antes de ampliar el grafo, la causalidad o la sincronización.

- Se añadió `typescript/src/narrative-book-ingestion.ts` y se exportó desde `src/index.ts`.
- La API `ingestNarrativeBookText` recibe texto ya decodificado e identidad de proyecto/documento/revisión; produce capítulos, párrafos, clasificación inicial de narración/diálogo/mixto y señales candidatas de acciones, referencias temporales, marcadores causales y contrastes.
- Cada capítulo y señal conserva evidencia literal, documento, revisión y offsets UTF-16 absolutos. Se admiten offsets base para texto que procede de fragmentos de un documento mayor.
- Los límites de entrada y salida son explícitos: 5.000.000 unidades UTF-16, 2.000 capítulos, 100.000 párrafos y 20.000 señales. El resultado declara omisiones y truncamiento.
- Las señales no se elevan automáticamente a hechos: no asignan agente, participante, identidad de personaje, causa confirmada ni fecha absoluta.
- Se añadió `tests/narrative-book-ingestion.test.mjs` con casos de capítulos, evidencia/offsets, marcadores, cautela semántica, límites y determinismo.
- Se documentó el alcance, garantías, límites y hoja de ruta en `INGESTA_Y_COMPRENSION_ESTRUCTURAL_DE_LIBROS.md`; el README de TypeScript enlaza esa guía.
- Commits publicados en `main`: `1f2bcfb` (módulo), `1d68923` (pruebas), `67ada3e` (documentación inicial), `409ce93` (exportación), `7bf443f` (límites de párrafo), `d73bffe` (enlace README) y `ce5756c` (ajuste de regresión de offsets).

**Validación:** la prueba automatizada está escrita, pero no se declara ejecutada. No se dispone todavía de resultado observable de `npm run typecheck`, `npm run build` o `npm test` para esta tanda. Los adaptadores binarios EPUB/PDF/DOCX y OCR no forman parte de esta entrega: la API actual ingiere texto ya decodificado.

**Siguiente trabajo prioritario:** conectar adaptadores reales de lectura de formatos con un mapa de procedencia entre texto extraído y ubicación original; después, resolver menciones y referencias entre párrafos, construir acontecimientos con roles explícitos, y contrastar continuidad y causalidad entre capítulos sin perder evidencia ni incertidumbre.


### Tanda 26-11-2026 — lector TXT/Markdown, encabezados Markdown y precisión de señales

- Se añadió `readNarrativeBookFile(file)` al módulo `narrative-book-ingestion.ts`: lectura de archivos TXT y Markdown mediante `arrayBuffer` y `TextDecoder` nativos, UTF-8 estricto, comprobación de extensión/MIME, rechazo de NUL y límite de 20 MB.
- La segmentación de capítulos reconoce encabezados Markdown con uno a seis signos `#` y conserva el título sin el prefijo de formato.
- Los extractores de acciones del módulo de ingesta usan límites Unicode de letras/marcas/números; esto evita perder verbos españoles con terminaciones acentuadas por el comportamiento ASCII de `\\b` en JavaScript.
- La extracción de observaciones mantiene el orden de los verbos por sus offsets exactos de evidencia de acción, no por orden alfabético de etiquetas.
- Las pruebas de ingesta cubren capítulos, párrafos, offsets, señales candidatas, determinismo, lectura TXT/Markdown, encabezados Markdown, MIME y UTF-8 inválido.
- Commits de esta extensión publicados en `main`: `721a4d2` (lector de archivos), `595667f` (validación NUL), `2e472d9` (pruebas de lector), `ed6ba50` (corrección de pruebas), `ed14a00` (límites Unicode de acciones), `f1a8593` (límites Unicode de observaciones), `f4f3c0d` (orden por offsets), `d06ed8c` y `1c78237` (encabezados Markdown), `d3d931e` y `94b1230` (regresiones Markdown), `06ef12b` y `ce669da` (documentación).
- **Verificación observada en GitHub Actions, ejecución 2753:** `Type-check` completado correctamente; compilación Vite completada; las pruebas específicas nuevas de ingesta estructural, TXT/Markdown y validación UTF-8 pasaron. La suite general registró 949 aprobadas y 39 fallidas de 988; por tanto, no se declara `npm test` verde. Los fallos incluyen rutas de entidades, relaciones, acontecimientos y proyecciones narrativas tras cambios concurrentes en `narrative-knowledge.ts`; ese frente requiere diagnóstico coordinado y no se considera resuelto por esta tanda.

**Pendiente inmediato:** revisar junto con la línea de extracción de entidades el conjunto de 39 regresiones de la ejecución 2753, sin sobrescribir trabajo concurrente; mantener el lector TXT/Markdown y el analizador estructural aislados; después diseñar adaptadores EPUB/PDF/DOCX con procedencia por bloque y página antes de añadir inferencias narrativas de mayor nivel.


### Tanda 26-11-2026 — integración de ingesta con observaciones ligadas a entidades

- `NarrativeBookIngestionInput.entities` acepta fichas previamente identificadas del mismo proyecto; la validación rechaza entidades de otros libros.
- `ingestNarrativeBookText` ahora devuelve `observations`: acciones detectadas en frases que mencionan personajes conocidos, con candidatos pronominales, roles no confirmados y evidencia exacta del verbo.
- `observationStatus` distingue `extracted`, `no-entities` y `omitted-text-budget`. El descubrimiento de observaciones respeta el presupuesto de 2.000.000 unidades UTF-16 del extractor; no presenta una muestra parcial como análisis completo.
- Se añadieron regresiones de extremo a extremo para «Ana cruzó el puente», offsets absolutos del verbo, asociación con la ficha de Ana y aislamiento de entidades por proyecto.
- Se ajustó `HostEngineApi.extractNarrativeKnowledge` para diferenciar fragmentos de edición en vivo de extracciones completas: el flujo incremental aplaza nombres que todavía terminan en el borde del fragmento, mientras la extracción completa puede aceptar el último nombre del documento. El centinela de borde no se conserva en la evidencia publicada.
- Commits de código y pruebas: `fc51727` (observaciones vinculadas), `9b580a1` (pruebas), `7d87458` (protección de nombres parciales en edición viva). Documentación: `288158c`, `f287202` y `a110eec`.
- **Verificación:** en la ejecución 2767, TypeScript y build pasaron; 990 de 991 pruebas pasaron y la única regresión restante era la conservación de nombres incompletos durante edición viva. Se publicó la corrección `7d87458`; la ejecución 2768 está en curso y debe confirmar el resultado antes de declarar la suite completa verde.

**Siguiente frente:** completar el diagnóstico de extracción de entidades con la línea de trabajo paralela sin sobrescribirla; después, implementar adaptadores EPUB/PDF/DOCX con trazabilidad de página, sección y bloque, y ampliar la resolución de participantes, causalidad y continuidad entre capítulos.


### Tanda adicional 26-11-2026 — corrección de dos regresiones de extracción

La ejecución 2775 de CI permitió aislar dos defectos concretos, no relacionados con la ingesta de archivos:

1. **Límite Unicode en acciones:** dos expresiones regulares (acciones `cruzar` y `abrir`) tenían barras invertidas duplicadas en clases Unicode. El motor podía aceptar prefijos incompletos de verbos; por ejemplo, la forma infinitiva podía perder la `r` final y clasificarse incorrectamente. Se normalizaron las clases a propiedades Unicode reales (`\\p{L}`, `\\p{M}`, `\\p{N}`) y se comprobó que no quedan expresiones con el escape duplicado.
2. **Nombre parcial al abrir documento:** el análisis inicial de snapshots recuperados trataba el final del snapshot como un límite definitivo de palabra. Ahora el flujo de recuperación aplaza la entidad que toca el borde final, igual que el análisis de edición viva, para no persistir un nombre mientras el escritor aún lo está completando.

- Commits publicados: `de73579` (límites Unicode de señales de acción) y `511e1d9` (aplazamiento de nombres terminales en recuperación).
- Diagnóstico de CI 2775: Type-check correcto; 995 pruebas aprobadas y 2 fallidas. Los dos casos fallidos se vincularon a los defectos anteriores.
- La ejecución 2778, sobre el primer commit correctivo, está en curso; la ejecución 2779, que incluye ambas correcciones, está en cola. No se afirma todavía que la suite completa esté verde.

**Criterio de aceptación inmediato:** Type-check, build, pruebas completas y benchmark de edición viva deben finalizar sin regresiones antes de pasar a nuevos formatos. Mantener la regla de no convertir una forma verbal en fecha cronológica y no persistir nombres incompletos en bordes de fragmentos.


### Tanda 26-11-2026 — alcance correcto de la negación en señales de acción

- Se reemplazó la detección por proximidad fija de 36 caracteres por una detección acotada a la cláusula/oración actual. Así, «Ana no cruzó. Pedro llegó» conserva «cruzó» como negada y «llegó» como afirmada; una negación anterior no contamina la siguiente acción.
- La negación solo modifica la polaridad de señales de tipo acción. Los marcadores temporales, causales y de contraste no heredan una polaridad negativa por mera cercanía.
- Se añadió una prueba de regresión con acción negada, acción afirmada en la oración siguiente y otra acción negada con «nunca».
- La guía de ingesta documenta el alcance de polaridad y su prueba.
- Commits: `9489407` (lógica de alcance), `2470f36` (prueba de regresión), `13841e4` (documentación).
- GitHub Actions inició ejecuciones 2782 (cambio de lógica), 2783 (pruebas) y 2784 (documentación). En la última consulta, 2782 y 2783 estaban instalando Chromium y aún no habían llegado a Type-check ni a la suite; 2784 estaba en preparación. No se declara validación verde hasta ver sus conclusiones.

**Siguiente paso:** ampliar cobertura verbal del español con pruebas positivas y negativas (presente, pretérito, imperfecto, futuro, infinitivo y formas compuestas) sin introducir coincidencias parciales; después abordar extracción de menciones y participantes con separación entre personaje mencionado y sujeto/ agente gramatical.


### Tanda 26-11-2026 — ampliación de cobertura verbal y pruebas contra prefijos espurios

- Se amplió el reconocimiento léxico de acciones de llegada y movimiento para incluir formas frecuentes del presente, pretérito, imperfecto, futuro, infinitivo, gerundio y participio en verbos regulares seleccionados.
- La ampliación conserva límites Unicode de palabra, por lo que formas nominales como «caminante» y «llegada» no deben confundirse con las acciones «camina» y «llegará».
- Se añadió una prueba con «Ana camina», «Mañana llegará» y los falsos positivos potenciales «caminante/llegada».
- Se mantiene el alcance de negación por cláusula implementado en la tanda anterior.
- Commits: `7322eb4` (cobertura verbal), `5d24d0e` (prueba de tiempos y límites), `21dd464` (documentación).
- CI: las ejecuciones 2782–2784 estaban en curso o cola antes de esta tanda; las nuevas modificaciones generan validaciones posteriores. La suite completa aún no se declara aprobada.

**Límite explícito:** el inventario verbal sigue siendo léxico y parcial, no un analizador morfológico completo del español. No se debe inferir el tiempo de la historia solo a partir de una forma verbal aislada. La siguiente ampliación debe incluir pruebas por verbo y variedad, así como resolución contextual de sujeto y participantes.


### Tanda 26-11-2026 — corrección de falsos positivos en menciones de personajes

- El análisis de CI 2784 encontró dos regresiones en referencias pronominales. La causa raíz estaba en `includesName`: una expresión regular construida desde una cadena usaba `\\p` con escape insuficiente, por lo que JavaScript no interpretaba las propiedades Unicode como límites de letra.
- Efecto reproducible: el nombre «Ana» podía coincidir dentro de «ventana». Esto podía asociar falsamente una acción al personaje Ana y, en consecuencia, impedir que «Ella» se conservara como referencia pronominal pendiente.
- Se corrigió el escape de la expresión regular construida dinámicamente, de forma que el motor recibe las propiedades Unicode reales `\\p{L}`, `\\p{M}` y `\\p{N}`.
- Se añadió una regresión explícita para «La ventana se abrió» y se espera que los dos casos de pronombres vuelvan a conservar candidatos de antecedente sin resolverlos automáticamente.
- Commits: `db82b9e` (primer intento de corrección), `1edc636` (escape final correcto), `f2883f4` (prueba anti-subcadena), `e39c227` (documentación). El commit `db82b9e` fue seguido por `1edc636` porque la primera escritura dejó un literal de plantilla mal formado; la versión vigente es la segunda.
- CI 2784: Type-check correcto; 996 pruebas aprobadas y 2 fallidas, ambas de pronombres, lo que permitió aislar esta causa. La suite del commit correctivo y la nueva prueba anti-subcadena están pendientes de CI.

**Implicación de calidad:** el reconocimiento de entidades debe ser por token Unicode, nunca por subcadena; los pronombres deben permanecer referencias sin resolver hasta que un componente contextual aporte evidencia suficiente. Esta regla es prioritaria para evitar contaminación del grafo narrativo.
