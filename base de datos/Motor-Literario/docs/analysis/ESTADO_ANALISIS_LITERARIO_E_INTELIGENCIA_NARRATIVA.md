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

La rama de trabajo sigue siendo `main`. El HEAD observado durante esta actualización es `df1a10ab423f222d652349453d2a496cb1a206f3` (26 de noviembre de 2026). La consulta de checks y de ejecuciones de workflow para ese SHA devolvió colecciones vacías. Por tanto, **los commits de esta tanda están publicados, pero no hay evidencia de CI ni de ejecución local de la suite para el HEAD observado**. Las pruebas de Unicode, límites de nombres y offsets UTF-16 están escritas en el repositorio; su presencia no demuestra que se hayan ejecutado.

El PR #50 propone una base durable de bandeja de salida para sincronización remota, inspección del almacenamiento y nuevas regresiones de cronología. Sigue siendo trabajo en revisión: no debe describirse como sincronización multidispositivo completa ni como funcionalidad integrada en `main`. Sus límites declarados incluyen transporte, autenticación, protocolo de conflictos remotos y pruebas de integración entre dispositivos.

La documentación debe seguir separando tres estados: implementación presente, cobertura de pruebas escrita y ejecución de pruebas confirmada. Son evidencias distintas.


## 10. Coordinador de sincronización narrativa y correcciones de monitor (26 de noviembre de 2026)

Se trasladó la implementación a `feat/narrative-sync-coordinator-v3`, basada en el `main` actualizado (`6747a93e3a88a52d6ef089543d39eeea0472bfaf)), porque la rama anterior había quedado cuatro commits detrás.

La tanda incluye:
- Coordinador `NarrativeSyncCoordinator` y puertos `SyncOutboxPort` / `SyncTransport`, desacoplados del proveedor remoto.
- Lotes acotados, aislamiento por proyecto, coalescencia por proyecto y concurrencia entre proyectos.
- Validación estricta de cada operación y payload JSON antes del envío.
- Respuesta remota exhaustiva y disjunta: cada operación debe quedar aceptada, en conflicto o reintentable; solo los acuses explícitos permiten retirar datos.
- Ocho pruebas para acuses, conflictos, reintentos, aislamiento, concurrencia, fallos y payload malformado.
- Reparación de la declaración vacía/malformada de `NarrativeAssertion` y de los acumuladores de actividad del monitor y IndexedDB.
- Corrección de una condición de carrera del heartbeat: las revalidaciones que llegan mientras existe otra operación activa comparten una promesa de seguimiento y esperan su resultado.
- Corrección de la causa raíz del fencing: se preserva `undefined` al capturar la generación del lease, en lugar de sustituirlo por `0`. La comparación anterior `undefined !== 0` descartaba la respuesta válida de renovación antes de detectar pérdida o recuperar el lease.

**Estado de validación:** la ejecución anterior confirmó que el typecheck pasa, pero falló en dos pruebas de lease. La cola de seguimiento, por sí sola, no resolvió esas pruebas; la corrección de generación en `1cfe39d` aborda el origen confirmado. Se trasladaron los cambios a esta rama nueva para incorporar el `main` reciente. Aún falta una ejecución CI sobre el nuevo HEAD para validar conjuntamente typecheck, suite y pruebas de navegador.

**Límite funcional:** la bandeja durable de IndexedDB del PR #52 todavía no está integrada en `main`. El coordinador define el puerto compatible con ella, pero la integración final exige incorporar esa bandeja y un transporte remoto real. Siguen pendientes autenticación/autorización, API versionada, idempotencia del servidor, backoff y resolución explícita de conflictos. No se declara sincronización multidispositivo terminada.


### Ajuste de regresión del workspace tras cambios de accesibilidad

La ejecución de CI sobre el merge commit confirmó que los dos tests de fencing ya no fallan. El job del monitor encontró, en cambio, que el helper `findCards` de `live-author-monitor-workspace.test.mjs` contaba todos los nodos `role=listitem`, incluidos los elementos de la lista accesible de métricas. El test ahora identifica tarjetas de documento por la presencia de `data-document-id`, manteniendo la semántica accesible de las métricas y verificando el número real de capítulos. Corrección añadida en `4682e21`; requiere nueva ejecución CI.


### Validación CI confirmada de la corrección integrada

La ejecución de CI del commit de código/pruebas `4682e21c9f29a61f803c0877f4cf1952b8e48422` terminó correctamente en ambos workflows:
- **Motor Literario TypeScript:** typecheck, build y suite automatizada aprobados; benchmark de edición aprobado.
- **Live Author Monitor:** validación de esquema/almacenamiento, build, pruebas específicas del monitor y benchmark de heap aprobados.

La suite completa ya no reproduce los fallos de fencing ni el recuento erróneo de tarjetas del workspace. Después de ese commit se añadió únicamente documentación de seguimiento (`054e1b5`); no se modificó código ni pruebas. El PR #56 permanece abierto como borrador y no se ha fusionado.


### Integración de bandeja durable con el coordinador (IndexedDB v25)

Se incorporó a esta rama la implementación de `StoredSyncOperation` y los métodos de `IndexedDbProjectStore`:
- `enqueueSyncOperation`: inserción idempotente por `operationId`, rechazo de colisiones y unicidad de secuencia por proyecto/dispositivo.
- `loadPendingSyncOperations`: lectura ordenada sin retirar operaciones.
- `recordSyncOperationAttempt`: persistencia de intentos y último error.
- `acknowledgeSyncOperation`: retirada únicamente tras acuse remoto.
- Migración de IndexedDB v24 a v25 con almacén `sync-outbox` e índices por proyecto/fecha y proyecto/dispositivo/secuencia.
- MLDB 0.4.3 y manifiesto físico actualizados; el contrato de puerto del coordinador es estructuralmente compatible con `IndexedDbProjectStore`.

Se añadieron pruebas de bandeja real, idempotencia, conservación hasta acuse, aislamiento, validación de payload, inspección de almacenamiento y una prueba de integración que usa el coordinador contra IndexedDB: acepta una operación, conserva el conflicto, registra el intento y lo retira solo después del segundo acuse.

**Límite:** sigue sin existir transporte remoto real, autenticación/autorización, política de backoff ni reconciliación de conflictos. La bandeja es durable y está conectada al coordinador en el núcleo; la sincronización entre dispositivos aún depende del adaptador remoto.


### CI verde tras integrar la bandeja durable (26 de noviembre de 2026)

La ejecución sobre el commit `7777e16cc5a86a1f4dc99130ea8186df9aa84516` terminó con ambos workflows en `success`:
- **Motor Literario TypeScript:** typecheck, build, suite completa y benchmark de edición aprobados.
- **Live Author Monitor:** validación de MLDB/almacenamiento, build, pruebas específicas y benchmark de heap aprobados.

Se corrigió además el pipeline de pruebas: la suite completa incluye `live-author-monitor-diagnostics-isolation.test.mjs`, que importa el bundle `dist-monitor`. El script `test` ahora ejecuta `build:monitor-test` antes de descubrir todos los tests, evitando depender del orden o de que otro workflow haya construido ese artefacto. Los fixtures de migración v25 también incluyen el almacén `sync-outbox` en sus modelos de IndexedDB anterior.

La prueba de integración real `indexeddb-sync-outbox.test.mjs` confirma que el coordinador y `IndexedDbProjectStore` trabajan juntos: un acuse elimina una operación, un conflicto permanece pendiente con su intento persistido y un acuse posterior la retira.


### Tanda 26-11-2026 — límites de metadatos en respuestas de sincronización

- La validación del resultado remoto ahora limita el código de cada conflicto a 128 caracteres, además del límite existente de 2.048 caracteres para el mensaje.
- Una respuesta con un código excesivo se considera malformada: no confirma ni elimina la operación, registra el intento fallido y propaga el error para que el anfitrión pueda observarlo y reintentar según el backoff.
- Se añadió una regresión del coordinador que comprueba rechazo del código de 129 caracteres, conservación durable de la operación y ausencia de acuse.
- Se actualizó el contrato del transporte para documentar ambos límites.
- **Validación:** cambio y regresión publicados en la rama de integración; typecheck y suite deben volver a ejecutarse en CI antes de marcarlo como verificado.


### Tanda adicional — fronteras del contrato de conflictos remotos

- Se añadió una regresión que acepta un código de conflicto de exactamente 128 caracteres y confirma que el conflicto sigue pendiente, con su error registrado.
- Se añadió una regresión que rechaza un mensaje de conflicto de 2.049 caracteres, sin retirar la operación ni emitir un acuse.
- Estas pruebas complementan el rechazo ya incorporado para códigos de 129 caracteres.
- **Validación:** pruebas escritas y publicadas; todavía requieren ejecución CI sobre el HEAD actualizado.

### Tanda — idempotencia estable de la bandeja tras reintentos

- Se corrigió `enqueueSyncOperation`: el reencolado ya no compara el registro IndexedDB completo, porque los metadatos de reintento cambian después de un intento fallido.
- La identidad ahora se determina por proyecto, dispositivo, secuencia, tipo, fecha de creación y payload. El payload se compara con claves de objeto ordenadas recursivamente; el orden de arrays se conserva.
- Una repetición equivalente no sobrescribe el registro existente ni reinicia contador, último error o fecha del próximo intento.
- Se añadió una prueba de integración IndexedDB que reencola la misma operación después de un fallo, con claves del payload reordenadas, y comprueba que se conserva el backoff.
- **Validación:** cambios y regresión publicados; falta ejecutar typecheck y pruebas en CI sobre el nuevo HEAD.

### Tanda — orden causal de recuperación por dispositivo

- La lectura de pendientes utilizaba `by-project-created-at`. Esto podía invertir operaciones del mismo dispositivo cuando `createdAt` se veía afectado por un reloj ajustado o por marcas temporales no monótonas.
- Se cambió la recuperación al índice único `by-project-device-sequence`, que ordena por dispositivo y secuencia ascendente.
- Se añadió una regresión con dos operaciones del mismo dispositivo cuyas fechas están deliberadamente invertidas, además de una operación de otro dispositivo; la expectativa verifica secuencia causal sin fingir que existe un reloj global entre dispositivos.
- **Validación:** prueba añadida y cambio publicado; ejecución CI pendiente.

### Tanda — aislamiento del backoff por escritor

- Se corrigió el bloqueo global del coordinador: una operación retrasada de un dispositivo ya no detiene a todos los demás dispositivos del proyecto.
- Se mantiene la barrera causal por dispositivo: una secuencia posterior del mismo escritor no adelanta a una operación anterior que aún espera reintento.
- Se añadió una prueba con dos escritores: el flujo A queda en backoff y conserva ambas operaciones; el flujo B envía y confirma sus dos operaciones.
- **Validación:** código, prueba y contrato publicados; ejecución de CI pendiente.

### Tanda — recuperación de acuses parciales

- Se añadió una prueba que simula una interrupción de IndexedDB al borrar el segundo acuse de un lote ya aceptado por el servidor.
- La recuperación confirma que la primera operación, ya retirada localmente, no se reenvía; solo se reintenta la que permanece en la bandeja.
- El contrato ahora explicita entrega al menos una vez: una interrupción entre aceptación remota y borrado local puede provocar reenvío, por lo que el servidor debe deduplicar por `operationId`.
- No se presenta la sincronización como entrega exactamente una vez.
- **Validación:** prueba y documentación publicadas; ejecución de CI pendiente.

### Tanda — auditoría de concurrencia entre contextos

- Verificada la coalescencia actual: `inFlight` protege solo una instancia del coordinador, no varias pestañas o workers.
- Se documenta explícitamente el riesgo de doble envío y la obligación de deduplicación atómica del servidor por `(projectId, operationId)`.
- Se evita introducir un lease superficial sin migración durable, vencimiento y pruebas multi-contexto. La base IndexedDB sigue en versión 25 en esta rama.
- **Pendiente técnico identificado:** reclamación durable/lease compartido para reducir envíos redundantes entre contextos. No es una garantía implementada.
- **Validación:** auditoría de código y documentación publicadas; CI sigue pendiente.


### Tanda — puerto de exclusión compartida

- Añadido `SyncExecutionLock` como puerto opcional y agnóstico del entorno en el coordinador.
- Cada sincronización solicita exclusión con clave estable `narrative-sync:<projectId>`; los coordinadores que comparten proveedor pueden serializar la lectura, el envío y la confirmación de la bandeja.
- Se conserva la coalescencia `inFlight` por instancia y el paralelismo entre proyectos con claves distintas.
- Añadida prueba de dos coordinadores concurrentes con proveedor de lock compartido: una única operación llega al transporte y el segundo coordinador observa la bandeja ya confirmada.
- El núcleo no afirma tener bloqueo multi-pestaña por defecto. La integración debe inyectar un adaptador real (Web Locks o lease IndexedDB); sin él, la protección sigue siendo local a la instancia.
- CI y ejecución local de pruebas no verificados desde esta operación.


### Tanda — adaptador compartido respaldado por IndexedDB

- Implementado y exportado `IndexedDbSyncExecutionLock`, que adapta los leases transaccionales existentes de IndexedDB al puerto `SyncExecutionLock`.
- Reutiliza el almacén `live-author-monitor-leases` y el esquema existente; no añade migración de base de datos.
- Adquiere un lease por proyecto, renueva durante tareas largas, libera verificando propietario y fencing token, y espera con sondeo cuando otro contexto tiene la titularidad.
- Añadida cola local por clave para impedir reentrada concurrente cuando una misma instancia reutiliza el mismo `ownerId`.
- Añadidas pruebas de integración con dos instancias de IndexedDB y propietarios distintos, y de reentrada local.
- Cada contexto debe usar un `ownerId` único. Los leases pueden expirar si una pestaña queda suspendida; no eliminan la necesidad de deduplicación remota por `operationId`.
- **Validación:** pruebas añadidas al repositorio; no se ha ejecutado npm/TypeScript ni se dispone de resultados de CI desde esta operación.

- Ampliación de pruebas: recuperación de un lease vencido cuyo propietario anterior dejó de ejecutarse; el nuevo contexto puede reclamarlo mediante el mecanismo transaccional y avanzar el fencing token.


### Tanda — integración real y fencing

- Añadida prueba end-to-end de dos coordinadores completos, dos instancias de almacén IndexedDB y propietarios independientes: se comparte la misma bandeja, se serializa el acceso y solo se produce un envío.
- Añadida prueba de fencing takeover: un propietario nuevo adquiere un lease vencido con token superior; el propietario antiguo ya no puede renovarlo ni liberarlo.
- Corregida la documentación que todavía describía la ausencia de leases; ahora refleja el adaptador opcional disponible, la configuración por contexto y la semántica de resultado incierto al perder titularidad.
- Se mantiene la exigencia de idempotencia remota por `operationId`.
- No se ha ejecutado el conjunto de pruebas ni se dispone de resultados de CI en esta sesión.


### Tanda — heartbeat y liberación en fallos

- Añadida prueba multi-contexto donde la primera tarea dura más que el lease inicial; el segundo propietario debe esperar mientras el heartbeat renueva la titularidad.
- Añadida prueba de excepción de tarea que verifica liberación y adquisición posterior por otro propietario.
- Ampliado el contrato con el ciclo de vida de renovación, espera de renovaciones en vuelo, liberación y límites ante suspensión del navegador.
- Pruebas añadidas al repositorio; ejecución local y CI no verificados desde esta sesión.


### Tanda — acuses locales atómicos

- Extendido `SyncOutboxPort` con capacidad opcional para confirmar lotes.
- El coordinador prefiere la confirmación por lote cuando el almacén la implementa y conserva fallback compatible para adaptadores antiguos.
- IndexedDB retira todas las operaciones confirmadas en una sola transacción `readwrite`; los errores revierten la transacción completa.
- Añadidas pruebas de idempotencia, IDs duplicados, lista vacía y uso real del camino atómico desde el coordinador.
- La atomicidad local no elimina la necesidad de deduplicación remota: una interrupción entre aceptación del servidor y commit local puede provocar reenvío seguro.
- Pruebas incorporadas, pero no ejecutadas/verificadas en CI desde esta sesión.


### Tanda — aceptación remota ambigua y recuperación local

- Añadida prueba del coordinador donde el servidor simulado confirma durablemente una operación, pero la respuesta se pierde por desconexión; el reintento conserva exactamente el mismo `operationId`.
- Añadida prueba con IndexedDB real donde el servidor simulado acepta el lote y falla la transacción local de acuses; la operación permanece en la outbox y se retira correctamente en el ciclo siguiente.
- Documentado que timeout no equivale a rechazo, que el servidor debe deduplicar durablemente por proyecto y `operationId`, y que la garantía no es una transacción distribuida.
- Las pruebas están escritas y publicadas; no se ha podido ejecutar el runner ni verificar CI en esta sesión.


### Tanda — aislamiento causal de conflictos

- Añadida prueba de conflicto en un dispositivo y operación independiente en otro.
- Verificado que el conflicto permanece en outbox con código/mensaje y backoff.
- Verificado que las operaciones posteriores del mismo dispositivo quedan retenidas hasta vencer el backoff.
- Verificado que el dispositivo independiente puede progresar sin esperar la reconciliación del primero.
- Documentado que el backoff no equivale a resolución de conflicto; la reconciliación semántica sigue requiriendo un contrato de dominio explícito.
- Prueba publicada, pendiente de ejecución en entorno Node/IndexedDB y de CI.

### Tanda — recuperación de conflicto tras backoff

- Añadida una regresión del ciclo completo: el primer envío recibe un conflicto de revisión y conserva la operación con nextAttemptAt.
- Un ciclo ejecutado un milisegundo antes del vencimiento no llama al transporte.
- Al vencer el backoff, se reenvía la misma operación con el mismo operationId y el mismo payload; solo una nueva clasificación explícita de aceptación permite retirarla.
- La prueba verifica que el contador de intentos avanza y que la operación desaparece únicamente después del acuse.
- El contrato aclara que el tiempo no resuelve el conflicto, que el coordinador no altera el payload y que la prueba usa un transporte simulado.
- **Validación:** prueba y documentación publicadas. Aún no se ha ejecutado la suite ni se dispone de resultados CI para estos commits.

### Tanda — recuperación de conflictos sobre IndexedDB real

- Añadida una prueba de integración del ciclo de conflicto y recuperación usando `IndexedDbProjectStore`, no solo una outbox en memoria.
- Verifica persistencia del código/mensaje, contador de intentos y fecha de backoff tras cerrar el primer ciclo.
- Comprueba que no hay envío un milisegundo antes del vencimiento y que al vencer se reenvían exactamente el mismo `operationId` y payload.
- La operación solo desaparece después del acuse explícito del segundo ciclo.
- **Validación:** regresión y documentación publicadas; no se ha ejecutado localmente la suite ni se han recibido resultados CI para este commit.


### Tanda — identidad inmutable ante sustitución manual de conflictos

- Añadida regresión sobre IndexedDB real: una propuesta local nueva utiliza un `operationId` distinto y una secuencia posterior; la operación que originó el conflicto permanece en la bandeja.
- La prueba verifica que el payload original, el error persistido y el backoff no se alteran al insertar la operación nueva.
- Documentado el contrato de reconciliación explícita: no reutilizar IDs con contenido distinto, no retirar la operación original por una decisión local sin validar, preservar causalidad y exigir comprobaciones transaccionales frente a decisiones concurrentes.
- Separadas las decisiones conceptuales `accept-remote`, reemplazo local y fusión manual. No se implementa todavía ninguna API operativa de resolución, porque faltan modelo versionado de conflictos, autoridad formal de secuencias, transacción atómica y recibo remoto verificable.
- **Validación:** test y documentación publicados en la rama de trabajo. No se ha ejecutado la suite local ni se dispone de resultados CI; no se declara la regresión aprobada.


### Tanda — concurrencia de secuencias por dispositivo

- Inspeccionado el almacenamiento IndexedDB y el contrato público: la bandeja recibe la secuencia ya asignada; no existe en el contrato actual un asignador durable del siguiente número por proyecto/dispositivo.
- Confirmado que el índice único `by-project-device-sequence` protege la integridad y rechaza dos inserciones concurrentes con la misma secuencia, pero no asigna el siguiente número ni permite calcularlo de forma segura desde una lectura previa.
- Añadida regresión con dos instancias de IndexedDB que intentan insertar simultáneamente secuencias iguales para el mismo dispositivo: exactamente una inserción debe persistir.
- Documentado el requisito previo para reconciliación: contador durable compartido y asignación+inserción atómicas, o autoridad externa confiable. No se introdujo un contador parcial ni una migración especulativa.
- **Validación:** regresión y documentación publicadas; no se ejecutaron localmente las pruebas ni se recibieron resultados CI.


### Tanda — asignador local de secuencias en IndexedDB

- Implementado `IndexedDbProjectStore.enqueueNextSyncOperation(draft)`: asigna la siguiente secuencia por proyecto/dispositivo y encola en una única transacción `readwrite`.
- La transacción comprueba primero la idempotencia por `operationId`, consulta el último registro del índice `by-project-device-sequence` en orden inverso y añade la nueva operación con secuencia consecutiva.
- Los reintentos con la misma identidad devuelven la secuencia ya persistida; el mismo ID con proyecto, dispositivo, tipo, fecha o payload diferentes se rechaza. El payload se compara en forma JSON canónica.
- Expuesto como método opcional de `ProjectStore` para mantener compatibilidad con adaptadores anteriores. No se añade store ni migración: el índice único existente se reutiliza.
- Añadida regresión con dos instancias IndexedDB concurrentes, una operación legacy previa, secuencias consecutivas, reintento idempotente y colisión de payload.
- **Alcance:** la asignación es compartida entre conexiones IndexedDB del mismo origen; no coordina dispositivos físicos distintos ni reemplaza un orden global asignado por servidor.
- **Validación:** cambios y prueba publicados. Falta ejecutar build/typecheck y suite; CI aún no confirmado.


### Continuación — integración del asignador en el contrato de sincronización

- `SyncOutboxPort` expone ahora `enqueueNextSyncOperation(draft)` como capacidad opcional, con la misma forma de operación que el almacén IndexedDB. Esto hace visible la asignación atómica en el puerto de salida, sin forzar a adaptadores externos antiguos a implementarla.
- README actualizado: los nuevos escritores deben preferir `enqueueNextSyncOperation`; `enqueueSyncOperation` queda para compatibilidad con productores que ya suministran secuencia.
- Nueva prueba entre dos instancias que solicitan simultáneamente el mismo `operationId`, con payloads JSON equivalentes pero distinto orden de claves. Ambas recuperan la misma secuencia y solo queda una operación.
- La búsqueda de llamadas en el repositorio no permitió identificar un productor de dominio que genere actualmente operaciones para la outbox; el coordinador consume la interfaz, pero no crea operaciones. Por ello no se ha conectado artificialmente un flujo de escritura que no existe. El nuevo método queda expuesto en los contratos `ProjectStore` y `SyncOutboxPort`, listo para el próximo productor real.
- **Validación pendiente:** no se ha ejecutado `npm test` ni `npm run typecheck` en este entorno. No hay checks/workflows reportados para los commits recientes.


### Continuación — productor explícito en HostEngineApi

- Implementado `HostEngineApi.enqueueNarrativeSyncOperation(input)`: obtiene el proyecto del contexto activo, exige `operationId` y `deviceId` proporcionados por el anfitrión, serializa el payload JSON y usa el asignador atómico del almacén.
- El método falla de forma explícita si el adaptador no soporta asignación atómica; no utiliza `max(sequence)+1` fuera de la transacción.
- Pruebas nuevas: operación de proyecto activo asignada con secuencia 1; repetición del mismo ID recupera la misma secuencia y deja un solo registro; adaptador sin asignador rechaza la operación.
- README y contrato de transporte documentan que el anfitrión invoca el método después de confirmar el cambio local. La outbox y el journal del documento aún no comparten una transacción; la recuperación debe reconstruir la operación con el mismo ID estable. No se afirma atomicidad entre ambos.
- **Pendiente:** integrar un productor concreto con los eventos/cambios del dominio y definir payloads versionados por tipo; resolver la ventana de fallo entre commit del journal y enqueue; probar recuperación end-to-end.
- **Validación:** pruebas escritas; aún no ejecutadas. CI no confirmado.

### Captura automática atómica de cambios del manuscrito

- Se añadió la opción opt-in `syncDeviceId` a `EngineOptions` y se transmite desde `HostEngineApi` al motor.
- Cuando está activa, cada edición confirmada construye una operación `narrative-document-change.v1` con payload `schemaVersion: 1`, delta de texto, revisiones y offsets UTF-16.
- `IndexedDbProjectStore.appendChange(change, syncDraft)` realiza en una transacción `readwrite` la validación de continuidad del journal, la inserción del delta, la asignación de secuencia por dispositivo y la inserción en `sync-outbox`.
- La transacción abarca `documents`, `changes` y `sync-outbox`. Una colisión de `operationId` o fallo de inserción aborta la transacción completa; el delta no queda persistido sin su operación.
- Se derivó un `operationId` estable de proyecto/documento/secuencia para permitir correlación y recuperación.
- Pruebas añadidas para commit conjunto y rollback cuando existe colisión de identidad en outbox.
- Privacidad: la función está desactivada por defecto porque el payload incluye texto editado; habilitarla implica autorizar el envío de esos deltas mediante el transporte del anfitrión.
- Límite: atomicidad local IndexedDB únicamente. No hay confirmación remota exactamente-una-vez; el servidor debe deduplicar por `operationId`.
- **Validación pendiente:** typecheck y suite todavía no ejecutados; CI sin resultados confirmados.


### Endurecimiento del contrato de captura atómica

- Se hizo explícita la capacidad opcional `ProjectStore.appendChangeAndEnqueueSyncOperation(change, syncDraft)`, separada de `appendChange` para que un adaptador antiguo que ignore argumentos adicionales no pueda aparentar sincronización atómica.
- El motor exige esa capacidad cuando `syncDeviceId` está configurado. Si falta el journal durable o el método atómico, rechaza el commit en vez de guardar silenciosamente solo el snapshot.
- `IndexedDbProjectStore` implementa la capacidad usando una transacción `readwrite` que incluye los tres stores `documents`, `changes` y `sync-outbox`.
- Se corrigió y verificó por inspección el alcance de la transacción: el store de outbox forma parte de la misma transacción antes de leer/asignar secuencia e insertar la operación.
- La prueba de colisión deliberada de `operationId` verifica que el delta del journal no queda persistido cuando falla la outbox.
- **No se ha ejecutado aún** `npm test` ni `npm run typecheck`; no se declara validación de runtime.

### Validación de esquema para operaciones narrativas salientes

- Se añadió el tipo exportado `NarrativeDocumentChangePayloadV1` y el validador `validateNarrativeDocumentChangePayloadV1`.
- `NarrativeSyncCoordinator` aplica el validador a las operaciones `narrative-document-change.v1` al recuperarlas de la outbox, antes de transmitirlas.
- Se comprueban versión de esquema, documento, secuencia, continuidad de revisiones, offsets UTF-16 y reemplazo textual.
- Los tipos de operación existentes conservan validación JSON genérica; el cambio es compatible con otros productores.
- Se añadió una prueba unitaria para payload válido y casos inválidos de versión, revisión, offsets, secuencia y objeto nulo.
- Se actualizó el contrato de transporte.
- **Validación de ejecución pendiente:** no se ha ejecutado `npm run typecheck` ni `npm test`. El repositorio no ha devuelto checks ni workflow runs para los commits inspeccionados.


## Cambio de prioridad — obtención y lectura de libros

Se corrige el foco del desarrollo: la calidad de la sincronización no sustituye la necesidad primaria de obtener texto y estructura fiables desde los libros. El siguiente frente prioritario pasa a ser la ingesta y lectura de fuentes, y la sincronización queda como infraestructura posterior.

### Primera capa de ingesta estructural implementada

- Nuevo módulo `typescript/src/book-ingestion.ts`, exportado desde `src/index.ts`.
- Contrato `BookReaderAdapter<TSource>` con lectura asíncrona y cancelable; los lectores concretos entregan bloques en orden de lectura.
- Bloques tipados para título, encabezado de capítulo, encabezado de sección, párrafo, verso, nota y salto de página.
- Metadatos y localizadores de origen por bloque: identificador, página, spine y sección.
- Ensamblado de capítulos con límites explícitos, IDs estables y rechazo de secuencias o identidades duplicadas.
- Rangos UTF-16 por bloque para devolver evidencias del análisis al pasaje original.
- Límites de tamaño por bloque, capítulo y libro; cancelación mediante AbortSignal.
- Normalización conservadora de BOM y finales de línea. No se eliminan guiones, notas, encabezados ni contenido que pueda ser autoral.
- Pruebas nuevas en `tests/book-ingestion.test.mjs` para orden, capítulos, offsets, procedencia, límites, duplicados, adaptadores y cancelación.
- README actualizado con el contrato y sus límites.

### Brecha reconocida y siguiente trabajo prioritario

Esta primera capa todavía no decodifica por sí misma archivos EPUB, PDF, DOCX ni libros escaneados. No se afirma que el lector de formatos esté terminado. El siguiente desarrollo debe implementar lectores concretos, comenzando por EPUB (estructura OPF/spine, XHTML, orden de lectura, navegación y metadatos), después PDF con extracción por página y coordenadas, y luego OCR como ruta diferenciada para documentos escaneados. Cada adaptador debe preservar localizadores, orden, notas, encabezados y texto original; debe detectar extracción vacía, páginas ausentes, codificación defectuosa y contenido duplicado sin corregir silenciosamente el original.

También falta conectar el resultado validado de ingesta con una operación de importación de libro que cree/actualice documentos de forma controlada y recupere la lectura tras interrupciones. Esa conexión debe evitar importaciones parciales invisibles y conservar el vínculo entre cada capítulo y su fuente.

### Validación

Las pruebas de ingesta están escritas, pero todavía no se han ejecutado `npm run typecheck` ni `npm test`. No hay CI confirmado para esta tanda.


### Segundo avance de lectura — lector EPUB concreto

Se implementó el primer adaptador real de formato, `typescript/src/epub-reader.ts`:

- `EpubBookReader` y `createEpubBookReader` aceptan bytes de archivo y exponen lectura e inspección de metadatos.
- Analiza el contenedor EPUB, resuelve el OPF, manifest y spine; el orden de extracción respeta el spine.
- Recupera título, autor, idioma e identificador cuando están presentes.
- Extrae XHTML en bloques de capítulo, sección, párrafo, verso y nota al pie, con localizadores a archivo interno/spine/bloque.
- Excluye scripts, estilos, SVG y MathML del contenido textual.
- Valida estructura ZIP, rutas seguras, entradas duplicadas, cifrado, métodos stored/deflate, límites de tamaño/ratio, cabeceras locales y CRC32.
- Añade pruebas de EPUB sintético: metadatos, orden, texto, notas, localizadores, exclusión de scripts, mimetype inválido, path traversal y corrupción CRC.
- Exporta la API pública y documenta sus límites.

**Limitaciones conocidas:** ZIP64 y ZIP multi-volumen no están soportados; deflate requiere `DecompressionStream("deflate-raw")`; codificaciones XML distintas de UTF-8, navegación NCX/nav, semántica CSS de contenido oculto y corpus EPUB complejos requieren trabajo adicional. El parser XHTML actual es deliberadamente acotado y no sustituye un parser HTML5 completo.

**Validación pendiente:** los tests nuevos se han añadido pero no se han ejecutado; typecheck/build y suite completa siguen pendientes. Se necesita validar con libros EPUB reales y comparar la extracción con lectores de referencia antes de considerar completa la lectura EPUB.


### Control de calidad de extracción EPUB

La API `EpubBookReader.inspect(source)` ahora recorre el spine, además de inspeccionar los metadatos. Informa el número de bloques obtenidos, documentos del spine sin texto y advertencias por título/autor ausentes. Se añadieron fixtures para documentos vacíos y límites de archivo/entradas. Esto permite detectar un EPUB formalmente válido que no produjo contenido textual; todavía no se calcula un porcentaje de integridad porque falta una medida verificable del contenido esperado.

### Tanda actual — resumen de archivos

- Nuevo `typescript/src/epub-reader.ts`: lector ZIP/OPF/spine/XHTML.
- Actualizado `typescript/src/index.ts`: exporta la API EPUB.
- Nuevo `typescript/tests/epub-reader.test.mjs`: pruebas de metadatos, orden, contenido, notas, límites, rutas y CRC.
- Actualizado `typescript/README.md`.
- Actualizado `docs/development/BOOK_READER_ADAPTER_DESIGN.md`.
- Actualizado este estado de desarrollo.

La lectura EPUB ya tiene una implementación concreta, pero su madurez aún es inicial. Falta validación con corpus real y cobertura completa de HTML5, nav/NCX, codificaciones XML alternativas, EPUB cifrados/protegidos, CSS de visibilidad, recursos complejos y más casos de notas. El siguiente lector será PDF por página, pero primero se debe ejecutar y corregir el typecheck y los fixtures EPUB.


### Ajustes de fidelidad textual en EPUB

- La inspección ahora recorre los documentos del spine y reporta bloques extraídos y documentos sin texto.
- Se conservan límites de documento del spine incluso cuando el XHTML no incluye encabezados `h1`; no se mezclan silenciosamente archivos editoriales independientes en un solo capítulo.
- El texto preformateado/versificado conserva saltos de línea, en lugar de colapsarlos como espacios.
- Se añadió fixture para comprobar la preservación de versos.
- Se exige que `mimetype` sea la primera entrada ZIP y esté almacenada sin compresión; también se valida la longitud del comentario ZIP final.

Los cambios anteriores amplían la calidad de extracción, pero todavía requieren ejecución de typecheck y pruebas. La fidelidad debe comprobarse con EPUB reales, incluyendo poesía, notas, tablas, nav/NCX, XHTML heterogéneo y codificaciones distintas de UTF-8.


### Tercera tanda — evidencia narrativa enlazada a la fuente

Se implementó `typescript/src/book-evidence.ts` y se exportó desde `src/index.ts`. La función `resolveBookEvidence(book, chapter, start, end)` resuelve rangos UTF-16 del texto analizado hacia los bloques de origen del lector. Devuelve citas exactas por bloque, localizadores, secuencias, offsets locales y datos de libro/capítulo. Si la evidencia cruza párrafos, produce varios fragmentos; los separadores añadidos por la ingesta no se adjudican a ninguna fuente.

Se añadieron `tests/book-evidence.test.mjs` para rangos multibloque, offsets locales, localizadores, separadores sintéticos y rangos inválidos. Esto construye la unión necesaria entre análisis literario y libro primario sin inventar evidencia ni cambiar el modelo persistido actual.

Validación automatizada todavía pendiente: los nuevos tests y el typecheck no se han ejecutado en esta tanda. El siguiente paso es conectar esta resolución en los resultados/consultas de conocimiento narrativo y construir el lector PDF con evidencia por página.


### Cuarta tanda — navegación EPUB y precisión de extracción

Se amplió `EpubBookReader.inspect()` para leer tablas de contenidos EPUB 3 `nav` y EPUB 2 `NCX`, con etiqueta, destino interno y profundidad. El spine sigue siendo la autoridad del orden de lectura. Se añadieron pruebas para ambos mecanismos de navegación.

Se corrigieron saltos XHTML `br`, elementos XML con prefijo, validación de flags ZIP y límites para impedir que datos de entradas se solapen con el directorio central. También se valida la consistencia de entradas del directorio ZIP entre volúmenes.

La capa de resolución de evidencias se incorporó como módulo independiente, con tests que verifican citas de varios bloques y offsets locales. El análisis ya dispone de una ruta técnica para volver a los pasajes de origen; aún falta integrar esta referencia en las respuestas/consultas de entidades, ideas, relaciones y acontecimientos.


La ingesta admite ahora `metadata.revision` para identificar el snapshot exacto del documento anfitrión. `resolveNarrativeTextEvidence()` exige que esa revisión coincida con la evidencia persistida, además de comprobar que la cita coincide carácter por carácter con el rango. Rechaza snapshots sin versión, revisiones distintas, citas modificadas y evidencias marcadas como obsoletas. Esta verificación evita enlazar accidentalmente una evidencia histórica a una edición actual que contenga texto parecido.


### Quinta tanda — enlace seguro de evidencias persistidas

- La metadata de ingesta admite `revision`, que identifica el snapshot del documento anfitrión.
- `resolveNarrativeTextEvidence()` enlaza una evidencia persistida sólo si su revisión coincide con el snapshot, el documento pertenece al libro y el excerpt coincide exactamente con el rango UTF-16.
- Se rechazan evidencias obsoletas, snapshots sin revisión, revisiones distintas y citas que no coinciden.
- `resolveNarrativeEvidenceCollection()` resuelve colecciones de evidencias de forma integral: si un elemento falla, no entrega un resultado parcial.
- Se amplió la batería de pruebas de procedencia con casos de revisión, cita exacta y colección completa.

Esto deja una interfaz utilizable para enlazar evidencias de personajes, relaciones, acontecimientos e ideas al libro importado. Todavía no se han modificado las entidades persistidas ni la salida de análisis para incluir automáticamente los fragmentos; esa integración debe respetar el versionado de cada documento y no mezclar revisiones.


## Estado consolidado y documentación técnica

El registro técnico detallado se encuentra en `docs/analysis/REGISTRO_TECNICO_LECTURA_Y_TRAZABILIDAD_NARRATIVA.md`. Ese documento es la referencia operativa para arquitectura, contratos, límites, archivos, pruebas, riesgos y plan de trabajo.

**Corrección del estado EPUB:** ya están implementadas la navegación EPUB 3 `nav` y EPUB 2 `NCX`, la conservación de saltos XHTML `br`, el reconocimiento de elementos XML con prefijo y controles adicionales del ZIP. Las menciones anteriores que las enumeraban como pendientes corresponden a etapas históricas y no al estado actual.

**Estado de evidencia:** además de resolver rangos a bloques, la API acepta snapshots con `metadata.revision`, valida coincidencia de revisión y cita exacta para evidencias persistidas y resuelve colecciones completas sin resultados parciales. La integración automática en las consultas y salidas del conocimiento narrativo sigue pendiente.

**Validación:** las pruebas están escritas, pero no se ha ejecutado typecheck, build ni suite completa en esta tanda. No se declara CI aprobado. El lector EPUB sigue siendo una implementación inicial pendiente de corpus real y de cierre de compatibilidad.

**Hallazgo de integración documentado:** `TextEvidence.excerpt` conserva la línea completa y `start/end` delimitan la ocurrencia dentro de ella. El resolver ahora verifica esa línea contextual. También se identificó que los IDs sintéticos de capítulo de la ingesta no son automáticamente equivalentes a los `documentId` del anfitrión; el mapeo y la base de offsets deben definirse explícitamente antes de integrar las evidencias al conocimiento narrativo.


### Auditoría adicional de procedencia

Se corrigió el salto XHTML `br` para emitir un LF real y se ajustaron los tests. También se alineó la validación de `TextEvidence` con su contrato real: rango de ocurrencia más excerpt de línea completa. Se identificó un bloqueo de integración aún abierto: los IDs `chapter:<id>` y offsets locales de ingesta no equivalen automáticamente a `TextEvidence.documentId` y offsets absolutos del anfitrión. El registro técnico detalla el mapeo requerido; la integración automática permanece desactivada hasta resolverlo.
