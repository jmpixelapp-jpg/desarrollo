# Estado de desarrollo: análisis literario e inteligencia narrativa

**Implementación:** `base de datos/Motor-Literario/typescript/`  
**Módulo central:** `src/literary-analysis.ts`  
**Rama de trabajo:** `main`  
**Última actualización documentada:** 25 de noviembre de 2026

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

Los hashes anteriores son referencias abreviadas; cada cambio debe revisarse en su commit de GitHub para conocer su diff exacto. El trabajo concurrente de otros colaboradores puede intercalar commits en `main`; no atribuir esos cambios a esta línea de trabajo.

## 7. Pendientes y siguiente secuencia de trabajo

1. Añadir una prueba de estrés que fuerce de forma controlada el límite de un millón de expansiones de dos saltos y confirme el estado `truncated-by-work-budget`. Verificar que no se interpreten los contadores parciales como resultados completos.
2. Completar casos límite de catálogo vacío, nodos sin referencias, referencias externas y snapshots con omisiones.
3. Auditar los presupuestos de memoria y tiempo de cada fase del análisis, no solo del grafo y del texto léxico.
4. Revisar el comportamiento de muestras y truncamiento en cada colección pública: totales, muestras, omitidos y estado de completitud deben ser coherentes.
5. Ampliar las pruebas de sincronización concurrente de ideas: conflictos CAS repetidos, destino eliminado entre lectura y reintento, idempotencia y aislamiento entre proyectos.
6. Añadir pruebas de regresión para los análisis por escena y sus offsets UTF-16 en cambios de revisión y rangos parciales.
7. Ejecutar y registrar `npm run typecheck`, `npm test` y `npm run bench` en un entorno de proyecto; no declarar verde una verificación sin resultados observables.
8. Validar la experiencia desde el programa anfitrión con manuscritos reales de prueba, manteniendo datos sintéticos o autorizados y confirmando que el motor nunca edita el texto por sí solo.

## 8. Estado de validación al actualizar este documento

La rama de trabajo es `main`. Para el commit de pruebas `b681a9c97b5fc425373d25badbd3cbb8fcf0eb02`, la consulta disponible no devolvió checks de estado ni ejecuciones de workflow asociadas. Por tanto, **los cambios están publicados, pero esta consulta no acredita una ejecución de CI para ese commit**. No se afirma aquí que la suite completa se haya ejecutado después de las últimas tandas.

La documentación debe seguir separando tres estados: implementación presente, cobertura de pruebas escrita y ejecución de pruebas confirmada. Son evidencias distintas.
