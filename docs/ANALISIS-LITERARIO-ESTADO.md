# Registro de desarrollo: análisis literario e inteligencia narrativa

## Objetivo

Mantener el análisis literario y la sincronización del conocimiento narrativo en TypeScript/JavaScript puro dentro de `base de datos/Motor-Literario/typescript`.

## Avance incremental

### Robustez del grafo profundo

Se añadió `tests/literary-analysis-graph-depth.test.mjs`, una regresión de estrés determinista que construye una cadena dirigida de 10.500 ideas y comprueba:

- Conteos completos de nodos, referencias, ciclos y componentes débiles.
- Identificación de los nodos fuente y terminal.
- Alcanzabilidad de terminales y distancia mínima dirigida desde el inicio.
- Detección de puntos de articulación y número de componentes resultantes al retirar un nodo intermedio.
- Procesamiento de una profundidad superior a los límites habituales de recursión, coherente con las DFS iterativas del analizador.

La prueba usa el contrato público `analyzeLiteraryFragment`; no sustituye ni modifica los algoritmos de producción.

## Registro Git

- Rama de trabajo: `main`.
- Base observada antes de este cambio: `4fd46386b318d1258306d61f6bd1144761af00a2`.
- Commit del test: `298cc8ad875066322ac73cb9c6f654feeb4e621e`.
- Archivo añadido: `base de datos/Motor-Literario/typescript/tests/literary-analysis-graph-depth.test.mjs`.

## Verificación pendiente

El test quedó incorporado al patrón `tests/*.test.mjs` ejecutado por `npm test` en el paquete. No se declara aprobado hasta que se ejecute en CI.

Comandos de validación del paquete:

```bash
npm run typecheck
npm run build
npm test
npm run bench
```

## Coordinación

Los cambios de esta etapa se limitaron a un archivo de prueba nuevo en `main`. No se modificaron las ramas ni los archivos de las revisiones abiertas #42 y #43. Esas revisiones siguen siendo trabajo separado y sus resultados de CI deben comprobarse antes de considerar completo el estado global del proyecto.

### Presupuestos de muestras frente a métricas completas

Se amplió la prueba de grafos profundos con un catálogo de 6.002 ideas en cadena. La regresión comprueba que los límites de exposición de muestras no recortan las métricas globales:

- 6.001 referencias contabilizadas aunque solo se expongan 5.000 muestras.
- Conteo completo de puntos de articulación (6.000), aunque solo se devuelvan 100 identificadores de muestra.
- Conteo de nodos con terminal alcanzable y conectividad débil del catálogo completo.
- Contadores explícitos de referencias y puntos de articulación omitidos por presupuesto.

Commit de ampliación: `32e493d2bcc7c70f350b9a427b4f5d667b188c2f`.

La regresión sigue pendiente de ejecución mediante `npm test` en el entorno del paquete/CI; el commit no se considera validación de ejecución.

### Muestreo determinista de ciclos

Se añadió una segunda regresión de presupuesto con 120 auto-ciclos independientes. Comprueba que el analizador:

- Cuenta los 120 ciclos, aunque expone solo 100 muestras.
- Informa los 20 ciclos omitidos por límite.
- Mantiene 120 componentes débiles independientes.
- Produce exactamente el mismo resultado cuando el catálogo de entrada se entrega en orden inverso.

Commit: `a11415208d05db535f68307adb8ebffb066ad312`.

La validación de ejecución continúa pendiente: los commits están registrados en GitHub, pero los estados de CI consultables no muestran checks para estos cambios.

### Concurrencia entre instancias independientes

Se amplió `tests/idea-synchronization.test.mjs` para compartir un mismo almacén entre dos instancias independientes de `HostEngineApi`. Ambas parten de la misma instantánea, intentan añadir vínculos distintos y fuerzan una colisión CAS realista en el adaptador de prueba. La segunda operación debe recargar y fusionar el vínculo externo; después, una mutación editorial desde la primera instancia debe detectar su instantánea obsoleta, reintentar y conservar ambos vínculos.

La prueba comprueba el estado persistido, los resultados de ambas operaciones, la conservación de asociaciones y el número esperado de lecturas/escrituras. No modifica el motor de producción.

Commit del test: `b6c18488f969f27670ca5d4b2f525c6baa553247`.
Ajuste posterior para validar reconciliación de instantánea obsoleta: `6086907ccb11ba346e41cf23a95efb2482eeb0a7`.

La prueba debe ejecutarse con `npm test` en el paquete TypeScript; todavía no se declara aprobada porque no hay un resultado de CI asociado disponible.

### Matriz de cobertura de sincronización y recuperación

Se revisaron las suites existentes para evitar duplicar pruebas y orientar la siguiente fase sobre huecos reales. El estado confirmado de los archivos es:

| Suite | Casos | Cobertura principal |
|---|---:|---|
| `tests/idea-synchronization.test.mjs` | 31 | Vínculos unitarios, idempotencia, conflictos CAS, validación de destinos, límites, concurrencia y caché entre instancias |
| `tests/idea-batch-synchronization.test.mjs` | 13 | Reemplazo atómico de conjuntos de vínculos, orden, instantáneas antiguas, carreras, destinos inválidos y lotes concurrentes |
| `tests/indexeddb-idea-transaction.test.mjs` | 3 | Rollback de referencias inválidas y CAS concurrente en el adaptador IndexedDB |
| `tests/crash-recovery-analysis.test.mjs` | 6 | Recuperación desde journal durable, reanudación de extracción y persistencia/reconciliación de diagnósticos |

**Total revisado: 53 pruebas declaradas** en estas cuatro suites. Es un recuento estático de bloques `test(...)`, no un resultado de ejecución.

**Conclusión técnica:** la cobertura de conflictos CAS, sincronización por lote y recuperación del journal ya es extensa. La prioridad siguiente no debe ser añadir más casos redundantes, sino ejecutar las suites en Node 22.13 o superior, obtener resultados de CI y revisar los límites de atomicidad del adaptador IndexedDB con pruebas de integración que realmente se ejecuten en un runtime con IndexedDB.

Comandos de validación del paquete:

```bash
npm run typecheck
npm test
npm run bench
```

En el momento de redactar esta matriz todavía no había resultados de ejecución asociados a estas suites; la primera ejecución integral queda registrada en la sección siguiente.

### Primera validación integral en GitHub Actions

Ejecución real del workflow **Motor Literario TypeScript** sobre el commit `0c935de034c211cef90468d17db65ae6bffd2bbc`:

- Instalación de dependencias y Chromium: aprobadas.
- `npm run typecheck`: aprobado.
- `npm test`: falló en la suite general; el comando alcanzó la ejecución de pruebas tras completar compilación y validación de esquemas.
- Resultado de Node Test Runner: **707 pruebas, 680 aprobadas, 18 fallidas y 9 omitidas**.
- Benchmark: no se ejecutó porque la suite de pruebas devolvió código de error.
- Las tres pruebas de `indexeddb-idea-transaction.test.mjs` que antes podían omitirse se ejecutaron y aprobaron usando `fake-indexeddb`.

Ejecución: https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45732604278

**Lectura del resultado:** el chequeo de tipos está verde y el adaptador IndexedDB dispone ahora de pruebas de transacción activas en CI. El producto aún no supera la validación integral: los 18 fallos restantes incluyen contratos de integridad de ideas, expectativas de sincronización CAS, límites del catálogo y varios escenarios del análisis de grafos/cronología. No se deben ocultar ni rebajar estos fallos para conseguir un verde artificial. La siguiente fase debe resolverlos por grupos, empezando por reproducir y clasificar cada fallo contra el contrato vigente.

### Correcciones guiadas por CI y validación integral aprobada

La ejecución integral del workflow **Motor Literario TypeScript** sobre el commit `bf6d3f559bb045120bf5fb04aa37ae72985af0ba` terminó correctamente:

- `npm run typecheck`: aprobado.
- Compilación, validación de esquemas y `npm test`: aprobados.
- Resultado de Node Test Runner: **714 pruebas, 714 aprobadas, 0 fallidas y 0 omitidas**.
- `npm run bench`: aprobado.
- Ejecución CI: https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45734900028

Correcciones incorporadas durante la depuración:

1. La API descarta cachés parciales de ideas y entidades cuando falla la validación de referencias, permitiendo que la siguiente consulta vuelva a leer el almacenamiento durable.
2. El analizador admite catálogos globales de hasta **20.000 ideas** y hasta **2.000 encabezados/escenas explícitas** por fragmento. El límite de lectura preserva catálogos históricos; las operaciones de escritura mantienen sus límites propios.
3. La detección de conectores causales utiliza límites Unicode de letras y marcas, evitando que conectores acentuados como `provocó`, `causó` y `desencadenó` queden fuera por el comportamiento ASCII de `\b`. Se añadieron pruebas de conectores acentuados y de falsos positivos dentro de palabras.
4. Las métricas de convergencia a dos saltos conservan la distinción entre retornos cíclicos, destinos compartidos y ramas exclusivas.
5. Las pruebas transaccionales de ideas y las nueve pruebas de persistencia del motor usan `fake-indexeddb`; así se ejecutan en Node sin depender de IndexedDB nativo.
6. Las expectativas de sincronización y de catálogos históricos se ajustaron a los contratos actuales: revalidación de referencias, historiales importados parciales y contadores explícitamente inválidos.

#### Resultados del benchmark de edición en vivo

Métricas observadas en esta ejecución de CI; son mediciones de ese runner y no garantías universales:

| Tamaño del documento | Ediciones | P95 commit | P95 extremo a extremo | Delta de heap |
|---:|---:|---:|---:|---:|
| 10.000 palabras | 40 | 7,22 ms | 7,88 ms | +0,76 MB |
| 100.000 palabras | 40 | 3,25 ms | 3,84 ms | +1,82 MB |
| 500.000 palabras | 40 | 5,69 ms | 6,38 ms | +3,63 MB |
| 20.000 palabras, una sola línea | 5 | 69,74 ms | 70,07 ms | -9,65 MB |

Escenario concurrente: 4 documentos, 10 ediciones por documento, 40 ediciones totales; P95 extremo a extremo de 1,68 ms y máximo de 4 documentos activos.

**Estado de esta fase:** todas las pruebas configuradas en el workflow se ejecutaron y aprobaron en el commit citado. No quedaron pruebas omitidas en esa ejecución.


### Ampliación de límites y estado del HEAD posterior

Se añadieron pruebas de frontera para el límite de **12.000 ideas** y el máximo de **2.000 escenas explícitas**. Ambas pruebas pasan en la validación del commit `124067748796bdbc015068ed8a1b1488bfff607c`.

La ejecución del workflow en ese HEAD contabilizó **716 pruebas: 715 aprobadas, 1 fallida y 0 omitidas**. El único fallo registrado pertenece a la prueba de navegador del monitor de escritura multiproyecto (`live-author-monitor-writing-browser.test.mjs`): al cambiar al segundo capítulo, el montaje informa que el documento sigue pendiente o requiere resincronización. No corresponde a las suites de análisis literario, grafos ni sincronización de ideas.

Ejecución: https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45735421770

En ese HEAD, TypeScript y la compilación completan; el paso de pruebas falla por ese escenario de navegador y, por ello, el benchmark queda omitido. La validación integral verde anterior sigue registrada en el commit `bf6d3f5`; la siguiente tarea de integración global es resolver ese único fallo del monitor y repetir el workflow completo.

### Cierre de validación integral y compatibilidad de persistencia

Validación posterior sobre el commit `347301ca1ba09b4c159d6bc654cd8ad81d2d4aec` (rama `main`):

- Workflow: [Motor Literario TypeScript, ejecución 45736809722](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45736809722).
- Type-check: aprobado.
- Build, validación de esquemas y suite automatizada: aprobados.
- Node Test Runner: **718 pruebas, 718 aprobadas, 0 fallidas y 0 omitidas**.
- Benchmark de edición en vivo: aprobado.

La suite de navegador también se ejecutó en este workflow (instalación de Chromium completada); por tanto, el fallo multiproyecto que constaba en el registro anterior ya no bloquea esta validación integral.

El commit incorpora además compatibilidad de lectura para catálogos de ideas e historiales editoriales importados de versiones anteriores, clasifica posiciones temporales no finitas como no verificadas y documenta el límite de lectura de 20.000 ideas. Se conserva la distinción entre límites de lectura/análisis y límites de escritura: no se debe inferir que admitir un catálogo histórico grande autoriza una escritura de igual tamaño.

#### Benchmark observado en la ejecución final

| Escenario | Ediciones | P95 commit | P95 extremo a extremo | Delta de heap |
|---|---:|---:|---:|---:|
| 10.000 palabras | 40 | 7,18 ms | 7,83 ms | +0,76 MB |
| 100.000 palabras | 40 | 3,27 ms | 4,13 ms | +1,84 MB |
| 500.000 palabras | 40 | 4,54 ms | 5,30 ms | +3,67 MB |
| 20.000 palabras en una línea | 5 | 61,41 ms | 61,66 ms | -9,65 MB |
| 4 documentos concurrentes | 40 totales | — | 1,69 ms | — |

Son mediciones del runner de GitHub Actions de esa ejecución, no garantías universales de rendimiento.

**Estado verificado de esta entrega:** el HEAD indicado supera el workflow configurado completo. Esto acredita el conjunto de pruebas, compilación, validación de esquemas y benchmark del paquete; no equivale a una garantía de ausencia de defectos ni a una auditoría editorial humana de resultados narrativos. Las suites IndexedDB usan `fake-indexeddb` en Node y no sustituyen pruebas en todos los navegadores y dispositivos de producción.

### Auditoría de alcance funcional y criterios de aceptación

Esta sección delimita qué significa que el núcleo de análisis literario e inteligencia narrativa esté implementado y qué no debe prometerse a partir de las pruebas automatizadas.

#### Capacidades verificadas en el código TypeScript

- **Análisis de fragmento no destructivo:** `analyzeLiteraryFragment` recibe texto, proyecto, documento, revisión y offset base; calcula métricas y señales descriptivas sin mutar el manuscrito ni persistir por sí mismo. Las ocurrencias devuelven rangos UTF-16 absolutos.
- **Estructura y ritmo:** segmentación de oraciones y párrafos, diálogo, marcadores explícitos de capítulo/parte/acto/escena, cadencia y transiciones de ritmo, con muestras acotadas y contadores globales.
- **Señales léxicas y retóricas:** repeticiones, frases recurrentes, aperturas, anáforas candidatas, ecos entre escenas, modalidades sensoriales y señales de voz. Son indicadores heurísticos y no dictámenes estéticos.
- **Conocimiento narrativo con evidencia:** extracción conservadora de entidades, relaciones, acontecimientos, ideas y afirmaciones explícitas; normalización de nombres; fusión de evidencia sin duplicar ocurrencias; candidatos de identidad que no fusionan automáticamente personajes; y detección de contradicciones explícitas sin decidir cuál versión es verdadera.
- **Cronología y evolución:** referencias temporales explícitas, pistas de línea temporal, perfiles de cambios de acontecimientos, historial de estados de ideas y separación entre evidencia vigente y obsoleta.
- **Grafo global de ideas:** vínculos declarados, ciclos, convergencia, alcanzabilidad, conectividad y muestras deterministas; los límites de entrada y de exposición se informan y no deben confundirse con el tamaño real del catálogo.
- **Sincronización y persistencia desde la API anfitriona:** aislamiento por proyecto, validación de registros y referencias, colas de operaciones, recuperación de cachés, concurrencia optimista/CAS, reconciliación de snapshots obsoletos, persistencia transaccional y recuperación probada por las suites del paquete.

#### Límites explícitos del producto

1. El análisis es **determinista y basado en reglas/lexicones**. No es un modelo generativo, no comprende de forma general la intención del autor y no sustituye interpretación humana, lectura crítica ni edición profesional.
2. Una mención textual no confirma automáticamente una entidad, relación, acontecimiento o hecho canónico. Las identidades ambiguas y las contradicciones requieren decisión editorial; el motor expone evidencia y candidatos.
3. Los offsets públicos de análisis son unidades UTF-16. No son bytes UTF-8, grafemas visuales ni coordenadas de pantalla. Los adaptadores deben convertirlos explícitamente cuando su almacenamiento use otra unidad.
4. El fragmento admite hasta 2.000.000 unidades UTF-16; el catálogo global de ideas admite hasta 20.000 entradas en el analizador; la detección estructural expone como máximo 2.000 marcadores/escenas según el flujo correspondiente. Otros catálogos y muestras tienen presupuestos propios documentados en sus tipos y validadores.
5. Las pruebas de IndexedDB ejecutadas en Node usan `fake-indexeddb`. Acreditan contratos del adaptador en el entorno simulado, pero no certifican todos los motores de navegador, cierres abruptos del sistema operativo, cuotas, migraciones de perfiles reales ni sincronización entre dispositivos.
6. Los benchmarks son mediciones puntuales de GitHub Actions; deben repetirse en hardware y navegadores objetivo antes de fijar SLA o prometer rendimiento de producción.

#### Lista de aceptación antes de desplegar con manuscritos reales

- [ ] Ejecutar el flujo completo en cada navegador y versión que se vaya a soportar, usando IndexedDB nativo y perfiles nuevos y migrados.
- [ ] Probar recuperación tras cierre forzado del navegador/proceso durante escritura, reinicio y reanudación, no solo fallos simulados de adaptador.
- [ ] Validar conversión de offsets entre UTF-16, UTF-8 y el editor anfitrión con emojis, marcas combinantes, CRLF y ediciones en límites de rango.
- [ ] Evaluar precisión y falsos positivos de extractores con corpus editoriales representativos por idioma, género y estilo; ajustar lexicones sin convertir heurísticas en afirmaciones canónicas.
- [ ] Hacer revisión editorial humana de escenas, cronologías, contradicciones y grafos generados en proyectos de prueba con casos conocidos.
- [ ] Medir memoria, latencia y tamaño de almacenamiento con proyectos reales anonimizados y fijar presupuestos operativos.

**Criterio de cierre de ingeniería:** el paquete TypeScript supera su workflow integral en el HEAD documentado (718/718, sin omisiones, build, typecheck, esquemas y benchmark). Los puntos de la lista anterior son aceptación de despliegue e integración en entornos reales; no se declaran satisfechos por el CI actual ni bloquean afirmar que el núcleo de software y sus contratos automatizados están implementados.


---

## Ampliación del alcance: traducción editorial y representación visual de mundos
**Estado: requisitos propuestos en definición; todavía no implementados ni verificados.**

Esta sección registra nuevas capacidades solicitadas para la visión global del producto. Se incorpora como alcance futuro y no debe interpretarse como funcionalidad existente del motor actual.

### 1. Traducción integral de libros con conservación editorial

El sistema deberá poder recibir un libro en un idioma de origen, permitir seleccionar el idioma de destino y producir una edición traducida completa, estructuralmente organizada y lista para revisión o publicación.

#### Entradas y salidas previstas

- Entradas iniciales a evaluar: EPUB, DOCX, PDF, TXT, Markdown y HTML.
- Salidas prioritarias: EPUB, DOCX y PDF; otros formatos podrán añadirse según viabilidad.
- Distinguir PDF con texto seleccionable de PDF escaneado o compuesto por imágenes.
- Para documentos escaneados, prever OCR, detección de orden de lectura y reconstrucción de bloques.
- Conservar los originales y generar una nueva edición; nunca sobrescribir el documento fuente.

#### Estructura y maquetación que se deben preservar o reconstruir

- Partes, capítulos, secciones, títulos y subtítulos.
- Párrafos, saltos, sangrías, espaciado y alineación.
- Jerarquías tipográficas, fuentes disponibles, tamaños y estilos.
- Márgenes, tamaño de página, orientación, encabezados y pies.
- Diálogos, citas, epígrafes, notas al pie y notas finales.
- Índices, tablas de contenido, numeración y referencias cruzadas.
- Imágenes, pies de imagen, tablas, listas, enlaces y elementos gráficos.
- Marcadores, metadatos editoriales y estructura de navegación EPUB.

La paginación puede cambiar al traducir por diferencias de longitud entre idiomas. Por tanto, se debe conservar la configuración editorial cuando sea posible y recalcular correctamente páginas, índice y referencias cuando el nuevo texto lo exija; no se debe prometer identidad exacta de paginación entre idiomas.

#### Calidad de traducción literaria

La traducción deberá usar contexto global y local, no traducir cada segmento de forma aislada. Debe considerar:

- Voz narrativa, tono, registro, época y género literario.
- Voz individual, personalidad y evolución lingüística de cada personaje.
- Modismos, metáforas, humor, ironía, juegos de palabras y dobles sentidos.
- Referencias históricas, sociales y culturales.
- Nombres propios y criterios coherentes para topónimos, títulos y tratamientos.
- Terminología técnica, fantástica o inventada y vocabulario recurrente.
- Continuidad de términos entre capítulos y libros de una misma saga.

Se requiere un glosario por obra/proyecto, una memoria de decisiones terminológicas y reglas configurables para traducir, conservar o adaptar nombres y expresiones. Las decisiones no deben alterar silenciosamente el canon del autor.

#### Control de calidad y trazabilidad

- Registrar idioma detectado, idioma de destino y configuración de traducción.
- Verificar cobertura: ningún capítulo, párrafo, nota o elemento traducible debe desaparecer sin un diagnóstico explícito.
- Detectar segmentos sin traducir, duplicados, alteraciones de orden y errores de estructura.
- Mantener correspondencia entre segmentos originales y traducidos para revisión bilingüe.
- Permitir revisión humana, correcciones y regeneración selectiva sin rehacer todo el libro.
- Informar de elementos no procesables o de fidelidad de maquetación limitada.
- Comprobar que el archivo exportado se abre y conserva su estructura mediante pruebas por formato.

### 2. Creación visual y cartográfica de mundos narrativos

El sistema deberá convertir información narrativa confirmada en representaciones visuales y cartográficas coherentes. Las imágenes serán representaciones de un modelo de mundo compartido, no ilustraciones inconexas.

#### Mapas y geografía

- Planetas, continentes, archipiélagos, regiones y territorios.
- Países, reinos, fronteras políticas e históricas.
- Montañas, cordilleras, volcanes, ríos, lagos, mares, océanos, bosques y desiertos.
- Climas, biomas, recursos naturales y zonas inhabitables.
- Ciudades, pueblos, aldeas, asentamientos y ruinas.
- Caminos, rutas comerciales, rutas marítimas y trayectos narrativos.
- Mapas físicos, políticos, históricos, regionales, urbanos y temáticos.

Cada elemento geográfico deberá disponer, cuando el texto lo permita, de identidad estable, ubicación o relación espacial, escala, fuente textual, nivel de certeza y vínculos con acontecimientos y personajes. Las ubicaciones inferidas deberán distinguirse de las explícitamente descritas por el autor.

#### Asentamientos, arquitectura y espacios

- Ciudades completas, barrios, calles, plazas, mercados y distritos.
- Pueblos, aldeas, puertos, fortalezas y asentamientos temporales.
- Casas de personajes, palacios, castillos, tabernas, bibliotecas, templos, escuelas y edificios públicos.
- Interiores, habitaciones, sótanos, pasadizos, jardines y espacios subterráneos.
- Planos urbanos, vistas aéreas, panorámicas, fachadas, interiores y detalles arquitectónicos.

#### Vehículos, máquinas y objetos construidos

- Carros, carruajes, barcos, trenes y vehículos terrestres.
- Aeronaves, naves espaciales y transportes fantásticos.
- Máquinas, mecanismos, artefactos, herramientas y tecnología propia de cada civilización.
- Vistas generales, detalles, planos y variantes históricas o funcionales cuando sean relevantes.

#### Coherencia visual y continuidad

- Mantener identificadores y fichas canónicas para lugares, edificios, vehículos y objetos.
- Reutilizar rasgos visuales establecidos en nuevas vistas e ilustraciones.
- Respetar época, materiales, clima, cultura, tecnología y recursos disponibles en el mundo.
- Evitar contradicciones entre mapa, distancias, rutas, arquitectura y acontecimientos.
- Permitir varias escalas y perspectivas de un mismo lugar.
- Registrar qué detalles proceden del texto, cuáles son inferencias y cuáles son decisiones creativas aprobadas.
- Permitir al autor corregir, aceptar o descartar propuestas sin modificar automáticamente el canon.

La generación de imágenes, planos o mapas ilustrados requerirá un componente de renderizado o un proveedor gráfico compatible. El núcleo TypeScript/JavaScript deberá orquestar solicitudes, aportar descripciones estructuradas, conservar referencias y validar coherencia; no se debe confundir la orquestación con la capacidad autónoma de dibujar imágenes sin un motor gráfico.

### 3. Modelo compartido de conocimiento

La traducción, los idiomas ficticios, los mapas y las ilustraciones deberán compartir un modelo de conocimiento del proyecto:

- Entidades canónicas con identificadores estables.
- Relaciones entre lugares, personajes, culturas, lenguas, objetos y acontecimientos.
- Cronología e historia de cambios.
- Coordenadas, regiones, escalas y restricciones espaciales cuando existan datos suficientes.
- Glosarios y reglas lingüísticas.
- Evidencias textuales y referencias a capítulos/fragmentos.
- Procedencia y nivel de confianza de cada dato.
- Separación entre hechos explícitos, inferencias y contenido creativo aprobado.
- Versionado, historial de cambios y sincronización.

El modelo compartido deberá evitar que una traducción cambie nombres canónicos sin autorización o que una ilustración introduzca detalles que luego se confundan con hechos establecidos en la obra.

### 4. Criterios generales de aceptación futuros

Una capacidad no se considerará terminada por generar una muestra atractiva. Deberá contar con:

1. Contrato de entrada y salida documentado.
2. Implementación integrada en la arquitectura existente.
3. Pruebas unitarias, de integración y de regresión.
4. Casos de prueba con libros y mundos de complejidad creciente.
5. Métricas de cobertura, fidelidad, consistencia y errores.
6. Manejo explícito de incertidumbre y revisión humana.
7. Documentación de limitaciones, dependencias y formatos compatibles.
8. Verificación reproducible en CI cuando corresponda.

### 5. Decisiones pendientes para cerrar el alcance

Estas cuestiones quedan abiertas para la conversación de definición:

- ¿La traducción deberá ser literal, literaria/adaptativa o permitir elegir entre ambas por obra?
- ¿Se desea conservar exactamente el diseño original o permitir una maquetación editorial mejorada?
- ¿Qué formatos deben ser obligatorios en la primera versión?
- ¿Los mapas deben ser principalmente ilustraciones, mapas editables con capas y coordenadas, o ambas cosas?
- ¿Se desea que ciudades, casas y vehículos puedan generarse también como planos técnicos o modelos 3D, además de ilustraciones?
- ¿El autor deberá aprobar toda inferencia visual antes de incorporarla al canon?
- ¿Qué nivel de edición manual y exportación se espera para los resultados?

**Nota de estado:** los requisitos de esta ampliación se documentan para definir el producto. No acreditan que existan ya los motores de traducción editorial, OCR, cartografía, generación visual o modelado 3D. Su implementación deberá planificarse por etapas y validarse individualmente.


---

## Ampliación del alcance: ilustración consistente de personajes, criaturas, animales y objetos
**Estado: requisito propuesto en definición; todavía no implementado ni verificado.**

### 1. Objetivo

El sistema deberá poder generar o coordinar la creación de representaciones visuales de cualquier elemento importante de una historia, a partir de descripciones explícitas del texto, referencias aprobadas por el autor y fichas canónicas del universo narrativo.

No se limitará a retratos: abarcará personajes, rostros, cuerpos, vestuario, animales, mascotas, criaturas, especies, objetos, artefactos, herramientas, armas, vehículos, edificios y otros elementos relevantes.

### 2. Personajes y rostros

Capacidades previstas:

- Retratos de protagonistas, antagonistas y personajes secundarios.
- Rostros desde vistas frontal, perfil y tres cuartos.
- Expresiones y estados emocionales.
- Rasgos faciales, cabello, ojos, marcas, cicatrices y accesorios descritos o aprobados.
- Representación de distintas edades y etapas de vida.
- Cuerpo completo, proporciones, postura, vestimenta y equipamiento.
- Variantes de vestuario vinculadas a escenas, culturas, ocupaciones y épocas.
- Hojas de diseño del personaje y referencias visuales reutilizables.

### 3. Animales, mascotas y criaturas

- Animales reales domésticos y salvajes.
- Mascotas asociadas a personajes concretos.
- Especies fantásticas, mitológicas y extraterrestres.
- Criaturas originales inventadas para una obra.
- Anatomía, dimensiones, locomoción, coloración y rasgos distintivos.
- Comportamiento, hábitat, dieta y relación con otras especies cuando el canon lo establezca.
- Vistas, poses y expresiones coherentes de una misma criatura.

### 4. Objetos y artefactos

- Armas, armaduras, escudos y equipamiento.
- Joyas, reliquias, talismanes y objetos mágicos.
- Libros, manuscritos, mapas e instrumentos.
- Herramientas, utensilios y objetos cotidianos relevantes.
- Dispositivos, máquinas, inventos y tecnología ficticia.
- Objetos únicos con historia, propietario, procedencia y estado de conservación.
- Vistas generales, detalles, escalas y variantes cuando resulten útiles.

### 5. Continuidad e identidad visual

Cada entidad ilustrable deberá poder tener una ficha canónica con:

- Identificador estable y nombre.
- Descripción textual y rasgos visuales aprobados.
- Referencias de origen en capítulos, escenas y fragmentos.
- Atributos explícitos, inferidos y decididos creativamente, claramente diferenciados.
- Imágenes de referencia y versiones generadas.
- Relaciones con personajes, lugares, especies, acontecimientos y objetos.
- Variantes temporales: edad, heridas, cambios de vestuario, deterioro, transformaciones y evolución.
- Historial de versiones y decisiones del autor.

El sistema deberá reutilizar las referencias aprobadas para mantener la identidad visual entre capítulos, escenas, perspectivas y nuevas ilustraciones. Cuando una descripción nueva contradiga una ficha anterior, deberá señalar el conflicto y solicitar o registrar una decisión; no deberá cambiar silenciosamente la identidad canónica.

### 6. Dirección artística y control del autor

- Permitir seleccionar o definir estilos visuales por obra, universo o elemento.
- Mantener coherencia de estilo cuando así se solicite.
- Ofrecer variaciones controladas sin perder rasgos esenciales.
- Distinguir entre representación fiel a lo descrito e interpretación creativa.
- Permitir aprobar, corregir, descartar y versionar ilustraciones.
- Vincular cada imagen a la entidad y a la versión de su descripción.
- Permitir generar conjuntos coordinados: fichas de personaje, bestiarios, catálogos de artefactos y atlas visuales.

### 7. Relación con el resto del motor

La ilustración deberá compartir el modelo de conocimiento narrativo, geográfico y lingüístico. Una mascota debe conservar su aspecto y relación con su dueño; un arma debe conservar sus características y propietario; un personaje debe mantener sus rasgos a través del tiempo, salvo cambios narrativamente justificados.

La extracción del libro debe identificar candidatos a ilustración y aportar evidencias. El motor podrá proponer detalles ausentes, pero deberá marcarlos como propuestas y no presentarlos como hechos del texto sin aprobación del autor.

### 8. Requisitos técnicos y criterios de aceptación

- Mantener contratos de datos independientes del proveedor de generación visual.
- Admitir imágenes de referencia y versiones aprobadas.
- Registrar prompts/configuración, proveedor, fecha, versión y entidad de destino cuando la infraestructura lo permita.
- Verificar que las referencias visuales de una misma entidad se reutilicen correctamente.
- Probar continuidad en distintos ángulos, poses, vestimentas y etapas temporales.
- Medir y documentar limitaciones de consistencia, anatomía, texto dentro de imágenes y fidelidad a descripciones.
- No considerar suficiente una imagen aislada: validar también la gestión de identidad, versiones y vínculos narrativos.

**Nota de estado:** este apartado formaliza el alcance deseado. No acredita que el repositorio ya disponga de un motor de ilustración, generación de imágenes, almacenamiento de referencias visuales o control de consistencia entre imágenes. Esas piezas deberán diseñarse, implementarse e integrarse con pruebas propias.


---

## Ampliación del alcance: revisión editorial, detección de omisiones y verificación de retos
**Estado: requisitos propuestos en definición; todavía no implementados ni verificados.**

### 1. Principio de funcionamiento: capacidades bajo demanda y control del usuario

El producto no debe comportarse como un agente autónomo que decide ejecutar tareas creativas o editoriales por iniciativa propia. Debe ofrecer capacidades que el usuario activa expresamente desde la interfaz del programa, mediante botones, comandos o solicitudes explícitas.

La excepción operativa básica es la recepción del libro y su lectura/preparación interna para que el contenido esté disponible. Esa preparación no autoriza a ejecutar automáticamente traducciones, reescrituras, correcciones, ilustraciones, mapas, ampliaciones ni otras tareas.

Reglas obligatorias:

- Cargar, leer y preparar/indexar el libro para su consulta constituye el flujo inicial permitido.
- Las revisiones, análisis especializados y operaciones adicionales se ejecutan solo cuando el usuario las solicita.
- No generar ilustraciones, mapas, fichas visuales ni otros recursos si no se pulsa la acción correspondiente o se formula la solicitud.
- No traducir el libro ni fragmentos por iniciativa propia.
- No completar, continuar, reescribir ni modificar una obra sin una petición explícita.
- No aplicar correcciones directamente al original. Presentar hallazgos y propuestas; cualquier cambio debe depender de una orden y conservar la posibilidad de revisar o rechazar.
- No confundir que una capacidad esté disponible con que deba ejecutarse automáticamente.
- Mostrar qué operación se va a realizar y sobre qué alcance (libro, capítulo, escena, párrafo o selección) cuando sea pertinente.
- Mantener el original intacto y registrar resultados, decisiones y versiones de las operaciones solicitadas.

La interfaz debe exponer acciones diferenciadas y comprensibles. Por ejemplo: «Revisar ortografía», «Analizar redacción», «Buscar cabos sueltos», «Comprobar continuidad», «Traducir», «Crear retrato», «Generar mapa» o «Verificar reto». La disponibilidad de un botón no implica ejecución hasta que el usuario lo active.

### 2. Revisión de ortografía, gramática y redacción

A petición del usuario, el sistema deberá revisar el texto para detectar y explicar, como mínimo:

- Errores ortográficos, tildes, mayúsculas y signos de puntuación.
- Errores gramaticales, concordancia de género y número, tiempos verbales y construcciones incorrectas.
- Problemas sintácticos, frases incompletas, construcciones confusas y ambigüedades involuntarias.
- Repeticiones innecesarias de palabras, expresiones o ideas.
- Muletillas, redundancias, cacofonías y problemas de fluidez.
- Cambios involuntarios de tiempo verbal, persona narrativa o punto de vista.
- Diálogos poco claros en su atribución, puntuación o formato.
- Inconsistencias de nombres, términos, tratamientos y convenciones internas.
- Frases que puedan resultar difíciles de comprender, señalando el motivo sin imponer una preferencia estilística como si fuera un error objetivo.

Cada hallazgo deberá incluir ubicación precisa, fragmento original, categoría, explicación, gravedad o prioridad estimada y, cuando sea útil, una o más propuestas de corrección. Se distinguirán errores objetivos de sugerencias de estilo: una elección deliberada del autor no debe marcarse como incorrecta solo por apartarse de una preferencia del sistema.

El usuario podrá solicitar una revisión de todo el libro, de un capítulo, de una escena o de un fragmento. También podrá pedir únicamente una categoría concreta. La corrección automática del documento nunca será implícita: deberá existir una acción explícita para aplicar cambios, idealmente con vista previa, aceptación individual o por lote y posibilidad de deshacer.

### 3. Detección de elementos narrativos ausentes o sin resolver

A petición del usuario, el motor deberá revisar la coherencia y el cierre narrativo para señalar posibles omisiones, cabos sueltos y promesas narrativas que no reciben resolución suficiente.

Entre los casos que debe poder investigar:

- Tramas principales o secundarias que se abandonan sin cierre identificable.
- Personajes introducidos como relevantes que desaparecen sin explicación o sin una función narrativa clara.
- Objetivos, conflictos, misterios, amenazas o preguntas planteadas que no reciben respuesta.
- Objetos, pistas, secretos, profecías, promesas o acontecimientos preparados que no vuelven a tener consecuencia.
- Decisiones que parecen producir consecuencias pero cuyo resultado no se muestra.
- Relaciones entre personajes que quedan en un estado aparentemente inconcluso.
- Cambios de personaje que se anuncian pero no se desarrollan o contradicen su evolución posterior.
- Escenas o transiciones que parecen faltar para comprender cómo se llegó de un acontecimiento a otro.
- Información necesaria para entender una resolución que nunca se proporciona.
- Elementos mencionados en una parte y aparentemente olvidados en el resto de la obra.
- Finales que resuelven el conflicto externo, pero dejan sin tratar una pregunta que la propia narración presentó como central.

No debe asumir que todo misterio tiene que resolverse ni que todo personaje necesita un cierre explícito. Debe distinguir entre: cabo suelto probable, misterio intencional, ambigüedad artística, elemento posiblemente olvidado y caso no concluyente. Para justificar una alerta, deberá mostrar la introducción del elemento, sus apariciones o consecuencias posteriores y el motivo por el que considera que podría faltar una resolución.

El sistema no debe inventar una respuesta ni completar la trama. Puede ofrecer alternativas de resolución únicamente si el usuario pulsa o solicita una acción de propuesta creativa. La decisión sobre qué debe permanecer abierto pertenece al autor.

### 4. Continuidad y consistencia de la obra

La revisión solicitada podrá buscar contradicciones o discontinuidades entre capítulos y escenas, incluyendo:

- Cronología, edades, fechas, duración de viajes y orden de acontecimientos.
- Ubicación, desplazamientos, distancias y disponibilidad de personajes.
- Rasgos físicos, heridas, vestuario, posesiones y estados de personajes u objetos.
- Conocimiento de cada personaje: qué sabe, cuándo lo descubre y quién se lo comunicó.
- Relaciones, alianzas, parentescos, motivaciones y objetivos.
- Reglas del mundo, magia, tecnología, geografía, culturas e idiomas ficticios.
- Nombres, títulos, vocabulario y términos recurrentes.
- Causas y consecuencias de acontecimientos, decisiones y acciones.

Cada posible contradicción deberá enlazar las evidencias relevantes y distinguir una contradicción explícita de una inferencia incierta o una variación que podría estar justificada por el paso del tiempo, un narrador no fiable o una decisión deliberada.

### 5. Verificación de retos y consignas de escritura

El programa deberá incorporar una capacidad de comprobación de consignas, ejercicios y retos definidos por el usuario o por la propia aplicación. Su objetivo no será juzgar si un texto es literariamente excelente, sino comprobar de forma rigurosa si satisface las condiciones especificadas.

Ejemplos de retos:

- «Escribe un relato de 10 líneas».
- «Escribe una frase».
- «Escribe un relato de 30 palabras».
- «Escribe un diálogo de dos personajes con seis intervenciones».
- «Escribe un texto que incluya determinadas palabras».
- «Escribe una escena en pasado y en primera persona».
- «Escribe un relato con principio, conflicto y desenlace».
- «Escribe un texto sin superar un límite de palabras».
- «Escribe una historia que contenga una condición temática o narrativa concreta».

#### 5.1. Validación estructural y cuantitativa

El verificador deberá medir las condiciones exactas del reto y explicar el criterio utilizado:

- Recuento de palabras con una política de tokenización definida y documentada.
- Recuento de frases y oraciones, sin confundir automáticamente puntos de abreviaturas, decimales o signos dentro de diálogos.
- Recuento de líneas según una definición explícita: saltos de línea reales, líneas no vacías o líneas editoriales, según indique el reto.
- Recuento de párrafos, intervenciones, personajes hablantes, versos u otros elementos estructurales.
- Límites mínimos, máximos y exactos.
- Presencia y cantidad de términos obligatorios; ausencia de términos prohibidos.
- Idioma, persona gramatical, tiempo verbal y formato cuando sean condiciones verificables.
- Comprobación de que no falten partes obligatorias de la consigna.

El resultado deberá mostrar el valor observado y el valor exigido. Por ejemplo: «30 palabras requeridas; 30 palabras válidas detectadas» o «10 líneas requeridas; 8 líneas no vacías detectadas». La política de conteo debe ser estable, visible y coherente en toda la aplicación.

#### 5.2. Validación de contenido y sentido

No basta con cumplir números. El sistema deberá comprobar, en la medida técnicamente posible, que el texto responde a la consigna y no es una secuencia arbitraria de caracteres.

Por ejemplo, ante el reto «escribe un relato de 30 palabras», una cadena como «ffffsd d sf sdf...» no debe aprobarse por alcanzar un número aparente de tokens. La validación debe buscar señales de contenido lingüístico comprensible, relación con el idioma solicitado y correspondencia semántica con el tipo de texto requerido.

Según el reto, podrá comprobar:

- Que exista texto lingüísticamente interpretable y no solo caracteres aleatorios o repeticiones para inflar el recuento.
- Que las palabras formen enunciados comprensibles, no una lista sin relación cuando se pidió un relato.
- Que haya una secuencia narrativa mínima cuando se solicite una historia: situación, acción o cambio y algún grado de progresión.
- Que se cumplan tema, género, perspectiva, personajes, escenario o acontecimientos exigidos.
- Que los requisitos obligatorios estén presentes y las restricciones se respeten.
- Que el texto no sea una repetición mecánica de una misma palabra o frase para simular cumplimiento.

La validación lingüística no debe convertirse en censura estilística: un poema, un texto experimental, una frase absurda intencional o una obra deliberadamente fragmentaria pueden ser válidos si la consigna lo permite. El verificador debe evaluar contra la consigna concreta, no contra una idea rígida de cómo debe escribirse.

#### 5.3. Resultado verificable y estados

El sistema deberá devolver un informe comprensible con:

- Estado: cumple, no cumple o no se puede determinar con suficiente confianza.
- Requisitos individuales y resultado de cada uno.
- Recuento y método aplicado.
- Evidencias o fragmentos que justifican las comprobaciones semánticas.
- Incumplimientos concretos y explicación.
- Condiciones ambiguas que requieren aclaración.
- Nivel de confianza para comprobaciones interpretativas, sin presentar una estimación como garantía absoluta.

Un reto solo se marcará como cumplido si supera todos los requisitos obligatorios definidos. Si cumple la extensión pero no el contenido, debe figurar como no cumplido, indicando exactamente qué falta. Si el sistema no puede verificar una condición con fiabilidad, deberá indicarlo en vez de aprobarla falsamente.

#### 5.4. Integración con la interfaz y control del usuario

La aplicación podrá ofrecer botones como «Comprobar reto» o «Validar texto». La comprobación se ejecutará únicamente cuando el usuario la solicite, salvo que el usuario configure expresamente otro comportamiento en una función futura. El sistema no deberá reescribir el texto para hacerlo aprobar ni cambiar el reto por su cuenta.

La validación y la generación son operaciones distintas: si el usuario pide ayuda para corregir un reto incumplido, esa asistencia deberá solicitarse por separado. El usuario conserva el control sobre el texto y sobre cualquier cambio.

### 6. Criterios de aceptación futuros

Estas capacidades no se considerarán terminadas solo por mostrar ejemplos o producir alertas. Requerirán:

1. Reglas y contratos documentados para cada tipo de revisión y reto.
2. Localización reproducible de cada hallazgo dentro del documento y su versión.
3. Corpus de prueba con errores reales, usos correctos, excepciones y falsos positivos.
4. Pruebas multilingües y políticas explícitas de conteo por idioma.
5. Casos de tramas intencionalmente abiertas para evitar clasificarlas automáticamente como defectos.
6. Pruebas adversariales de texto aleatorio, repetición, relleno y manipulación de contadores en retos.
7. Separación entre comprobaciones objetivas, inferencias y juicios editoriales.
8. Informes explicables, revisión del usuario y ausencia de modificaciones no autorizadas.
9. Integración real con botones/acciones de la aplicación y pruebas de que ninguna tarea bajo demanda se ejecuta sin activación.
10. Documentación de límites, falsos positivos, falsos negativos y dependencias externas.

**Nota de estado:** esta ampliación registra requisitos funcionales y reglas de interacción solicitadas. No significa que la revisión editorial avanzada, la detección fiable de cabos sueltos ni el verificador semántico de retos estén implementados. Deben diseñarse, implementarse y validarse como capacidades separadas e invocables por el usuario.


---

# Alcance global aprobado para diseño: plataforma integral de inteligencia literaria, narrativa, lingüística, editorial y visual
**Estado: alcance funcional aprobado por el usuario para su incorporación al plan del producto. Las capacidades nuevas aquí enumeradas son requisitos por diseñar e implementar; no se declaran existentes ni verificadas por el hecho de documentarlas.**

## 1. Visión del producto

El objetivo es evolucionar el motor hacia una plataforma modular capaz de leer y preparar libros, recuperar información explícita e implícita con evidencias, analizar obras y proyectos, asistir al escritor, verificar consignas, traducir y producir recursos editoriales y visuales cuando el usuario lo solicite.

No será un agente autónomo que decide qué tarea realizar. Será un conjunto de capacidades invocables desde la aplicación anfitriona mediante botones, comandos o solicitudes expresas. El usuario conserva el control de la operación, su alcance y la aceptación de cualquier cambio.

La lectura, ingesta y preparación interna del libro constituyen el flujo inicial para que el contenido esté disponible. No autorizan por sí mismas la ejecución de traducciones, correcciones, reescrituras, generación de imágenes, mapas, ampliaciones creativas, publicaciones ni otras operaciones.

## 2. Principios transversales obligatorios

1. **Ejecución bajo demanda:** ninguna tarea especializada se inicia sin una acción explícita del usuario. La disponibilidad de una capacidad no implica su ejecución automática.
2. **No destructividad:** conservar el original; generar resultados derivados y aplicar modificaciones solo tras autorización expresa.
3. **Alcance controlable:** permitir operar sobre una selección, párrafo, escena, capítulo, libro, saga o proyecto completo, según el contrato de cada función.
4. **Procedencia:** cada dato, hallazgo, sugerencia e inferencia debe enlazarse con las evidencias y versiones de origen cuando sea posible.
5. **Separación epistemológica:** distinguir hechos explícitos, inferencias, hipótesis, propuestas creativas aprobadas y datos externos.
6. **Incertidumbre honesta:** no presentar una conjetura como certeza; permitir «no concluyente» o «no verificable».
7. **Explicabilidad:** mostrar por qué se generó un resultado, qué fragmentos lo respaldan y cuáles son sus límites.
8. **Control editorial:** el autor puede aceptar, rechazar, corregir, aplazar o versionar propuestas.
9. **Coherencia compartida:** los módulos consultan un modelo común de personajes, lugares, acontecimientos, objetos, conceptos, idiomas, cronología y relaciones.
10. **Aislamiento y seguridad de proyectos:** los datos de una obra no deben contaminar otra; respetar permisos, límites y separación por proyecto.
11. **Trazabilidad de operaciones:** registrar solicitud, parámetros, alcance, versión de entrada, dependencias, resultado y decisión del usuario.
12. **Dependencias explícitas:** identificar proveedores externos necesarios para OCR, modelos lingüísticos, traducción, generación visual, renderizado, audio o investigación.
13. **Calidad medible:** cada módulo necesita pruebas, corpus, métricas, límites conocidos y criterios de aceptación propios.
14. **Sin promesas absolutas:** las evaluaciones literarias y semánticas son interpretativas; deben expresar evidencias y confianza calibrada, no garantías infundadas.

## 3. Módulos principales del producto

### 3.1. Ingesta, lectura y reconstrucción documental

Soportar, por etapas y con matriz explícita de compatibilidad: EPUB, PDF digital, PDF escaneado, DOCX, TXT, HTML y Markdown. Evaluar formatos adicionales sin prometerlos antes de implementar adaptadores.

Funciones requeridas:

- Detectar formato, codificación, idioma, estructura y metadatos.
- Extraer texto y estructura de capítulos, partes, secciones, títulos, subtítulos, párrafos, listas, tablas, notas, citas, encabezados y pies.
- Procesar PDF escaneados mediante OCR, orden de lectura, detección de columnas y reconstrucción de bloques.
- Reconocer texto en imágenes cuando se solicite o sea necesario para la lectura.
- Reconstruir párrafos cortados entre páginas y detectar palabras partidas por guiones de final de línea.
- Distinguir contenido literario de índice, bibliografía, créditos, publicidad y elementos editoriales.
- Reconocer diálogos, cartas, diarios, mensajes, documentos insertados, poemas, versos y formatos mixtos.
- Detectar páginas, capítulos o bloques ausentes, duplicados, corruptos o desordenados.
- Preservar coordenadas de origen: archivo, página, capítulo, bloque, rango y versión.
- Registrar confianza del OCR y permitir corregir errores de reconocimiento.
- Mantener texto original y representación normalizada sin perder correspondencia.
- Admitir libros con estructura irregular, fragmentaria, no lineal o sin capítulos convencionales.

**Criterio clave:** la extracción debe ser verificable y recuperable; no basta con obtener una cadena de texto. Se debe conservar la relación entre texto extraído y ubicación en la fuente.

### 3.2. Comprensión lingüística y semántica

- Detección de idioma y cambios de idioma dentro de una obra.
- Análisis morfológico, gramatical, sintáctico y semántico.
- Identificación de entidades, sujetos, acciones, objetos, atributos y relaciones.
- Resolución de pronombres, elipsis, referencias indirectas, alias, apodos y títulos.
- Desambiguación contextual de palabras y expresiones.
- Interpretación de negación, modalidad, condición, hipótesis, ironía, sarcasmo, metáfora y doble sentido.
- Reconocimiento de modismos, regionalismos, arcaísmos y terminología especializada.
- Detección de términos inventados, nombres propios y vocabulario de universos ficticios.
- Análisis de referencias temporales, espaciales y causales.
- Distinción entre afirmaciones explícitas, implicaciones plausibles y lecturas alternativas.
- Soporte multilingüe incremental, con perfiles de calidad por idioma y variante.

No se prometerá comprensión perfecta de todos los idiomas. Para cada idioma se documentarán recursos, cobertura, limitaciones y resultados de evaluación.

### 3.3. Extracción y recuperación profunda de conocimiento

Extraer y relacionar, con evidencia:

- Personajes, protagonistas, antagonistas, secundarios y menciones incidentales.
- Animales, mascotas, criaturas y especies.
- Lugares, edificios, regiones, países y elementos geográficos.
- Objetos, armas, herramientas, artefactos, vehículos y máquinas.
- Acontecimientos, acciones, decisiones, consecuencias y estados.
- Relaciones familiares, sociales, sentimentales, políticas, económicas y de conflicto.
- Ideas, conceptos, argumentos, temas, símbolos y afirmaciones.
- Objetivos, motivaciones, temores, secretos, promesas y conocimientos.
- Fechas, edades, cantidades, medidas, distancias y duraciones.
- Culturas, costumbres, instituciones, organizaciones, religiones y sistemas políticos.
- Reglas físicas, mágicas, tecnológicas y sociales del mundo narrativo.

La recuperación debe operar desde la mención puntual hasta el contexto global del libro o saga. Debe localizar información distribuida en capítulos distintos, resolver referencias candidatas sin fusionar identidades ambiguas de manera irreversible y permitir consultas que devuelvan evidencia, contexto y grado de confianza.

### 3.4. Inteligencia de personajes

Fichas persistentes y versionadas para identidad, nombres, alias, apariencia, edad, voz, vocabulario, personalidad, historia, relaciones, objetivos, motivaciones, temores, creencias, secretos, conocimientos, habilidades, defectos, virtudes, contradicciones y evolución.

Análisis de:

- Coherencia de conducta con rasgos establecidos.
- Evolución psicológica y emocional.
- Cambios de motivación y decisiones.
- Voz individual y diferenciación de diálogos.
- Conocimiento disponible en cada punto de la cronología.
- Presencia, ausencia, desaparición y función narrativa.
- Relaciones y cambios de vínculo.
- Desarrollo y resolución de arcos personales.

Las inferencias psicológicas se presentarán como interpretaciones basadas en texto, no como diagnósticos clínicos.

### 3.5. Inteligencia de tramas e historias

- Reconstrucción de trama principal, subtramas, historias paralelas y arcos.
- Detección de conflictos internos y externos, objetivos, obstáculos y apuestas.
- Seguimiento de misterios, preguntas, pistas, anticipaciones, secretos y promesas narrativas.
- Identificación de revelaciones, giros, escalamiento, consecuencias y resoluciones.
- Detección de tramas abandonadas, contradictorias o aparentemente incompletas.
- Identificación de finales abiertos, ambiguos, cerrados y alternativos.
- Reconstrucción de historias no lineales a partir del orden de exposición y del orden cronológico.
- Registro de preguntas narrativas y estado de cada una: resuelta, parcialmente resuelta, abierta intencionalmente, aparentemente olvidada o no concluyente.

No se asumirá que todo misterio o personaje requiere cierre. Cada posible cabo suelto debe justificarse con evidencias de su presentación y seguimiento.

### 3.6. Cronología, causalidad y continuidad

- Cronologías globales y por personaje.
- Fechas, edades, intervalos, duración de viajes y secuencia de escenas.
- Relaciones causa-efecto y consecuencias.
- Ubicación, desplazamientos, distancias y tiempos de recorrido.
- Continuidad de heridas, vestuario, posesiones, objetos, estados y transformaciones.
- Continuidad del conocimiento de cada personaje.
- Consistencia de motivaciones, alianzas, parentescos y objetivos.
- Consistencia de geografía, culturas, tecnología, magia e idiomas ficticios.
- Detección de contradicciones temporales, espaciales, lógicas y de estado.
- Tratamiento de narradores no fiables, recuerdos, sueños, flashbacks y versiones contradictorias.

### 3.7. Revisión ortográfica, gramatical y editorial

Revisión bajo demanda de ortografía, tildes, puntuación, gramática, concordancia, sintaxis, frases incompletas, ambigüedad, redundancia, repeticiones, muletillas, cacofonía, fluidez, diálogos, cambios de persona o tiempo verbal, consistencia de nombres y convenciones.

Cada hallazgo deberá incluir ubicación, fragmento, categoría, explicación, prioridad, propuesta opcional y distinción entre error objetivo y preferencia estilística. No se aplicarán correcciones sin autorización.

### 3.8. Evaluación de calidad literaria

Evaluar, cuando se solicite, capacidad de atracción, originalidad, ritmo, tensión, suspenso, escenas, personajes, diálogos, descripciones, mundo, emociones, conflictos, coherencia, estructura, desarrollo temático y desenlace.

Los informes deberán justificar observaciones con fragmentos y capítulos. Las puntuaciones, si se incorporan, tendrán escalas documentadas y no se presentarán como medidas objetivas universales. Incluir fortalezas, debilidades, riesgos y recomendaciones separadas de los hechos observados.

### 3.9. Predicción narrativa

- Hipótesis de posibles desenlaces.
- Anticipación de conflictos, revelaciones y giros.
- Identificación de pistas y anticipaciones.
- Posibles evoluciones de personajes.
- Comparación de finales alternativos y sus consecuencias.
- Explicación de evidencias a favor y en contra de cada hipótesis.

Las probabilidades solo se mostrarán cuando exista calibración empírica con corpus adecuados. De lo contrario se usarán categorías cualitativas o confianza no calibrada claramente etiquetada.

### 3.10. Asistencia creativa y desbloqueo

A petición expresa: lluvia de ideas, alternativas de escenas, conflictos, personajes, diálogos, giros, desenlaces, soluciones a contradicciones, expansión de conceptos y exploración de consecuencias narrativas.

Las propuestas deberán respetar las restricciones seleccionadas por el autor, señalar qué elementos son nuevos y no incorporarse al canon ni al manuscrito sin aprobación.

### 3.11. Verificación de retos y consignas

Validar extensión, palabras, líneas, frases, párrafos, intervenciones, personajes hablantes, términos obligatorios/prohibidos, idioma, persona, tiempo verbal, formato, tema y estructura.

La validación distinguirá:
- Requisitos cuantitativos con política de conteo documentada por idioma.
- Requisitos formales verificables.
- Requisitos semánticos o narrativos evaluados con evidencia y confianza.
- Condiciones ambiguas o no verificables.

Debe resistir texto aleatorio, relleno, repetición mecánica y manipulación de contadores. No aprobará una consigna narrativa solo por cumplir el número de palabras. Tampoco invalidará automáticamente poesía, absurdo deliberado o experimentación si la consigna los admite.

Estados posibles: cumple, no cumple y no verificable/no concluyente. Mostrar requisito, valor exigido, valor observado, método y motivo. La generación o corrección para superar un reto será una operación separada que requiere solicitud.

### 3.12. Traducción literaria y producción editorial multilingüe

- Traducción literal, literaria o adaptativa seleccionable.
- Contexto global y local, voz narrativa y voz de personajes.
- Tratamiento de modismos, humor, metáforas, juegos de palabras y referencias culturales.
- Glosarios y memoria terminológica por obra o saga.
- Reglas para nombres, topónimos, tratamientos y términos inventados.
- Correspondencia bilingüe por segmento.
- Detección de omisiones, duplicados, orden incorrecto y fragmentos sin traducir.
- Revisión humana y regeneración selectiva.
- Conservación/reconstrucción de estructura, estilos, márgenes, notas, imágenes, tablas, encabezados, pies e índice.
- Exportación a EPUB, DOCX y PDF según soporte verificado.
- Recalcular paginación y referencias cuando cambie la longitud del texto.

### 3.13. Inteligencia lingüística y construcción de idiomas ficticios

Comprensión multilingüe progresiva y herramientas para diseñar lenguas construidas: fonología, fonética, pronunciación, morfología, gramática, sintaxis, vocabulario, semántica, escritura, alfabetos, dialectos, registros, evolución histórica y traducción entre lenguas.

Cada idioma ficticio tendrá reglas consistentes y versionadas, vocabulario, excepciones, procedencia cultural y relación con pueblos, épocas y personajes. No se considerará terminado por generar una lista de palabras.

### 3.14. Cartografía y construcción de mundos

Representar planetas, continentes, países, reinos, regiones, islas, fronteras, montañas, ríos, mares, biomas, climas, recursos, asentamientos, rutas y zonas históricas o militares.

Tipos de mapas: físicos, políticos, históricos, climáticos, regionales, urbanos, comerciales, militares, subterráneos y temáticos. Gestionar escalas, coordenadas, orientación, distancias y relaciones espaciales cuando existan datos suficientes. Distinguir ubicaciones textuales, inferidas y creativas aprobadas.

### 3.15. Ilustración y diseño visual

Generación bajo demanda de retratos, cuerpos, expresiones, vestuario, animales, mascotas, criaturas, especies, objetos, armas, artefactos, herramientas, vehículos, máquinas, edificios, interiores, paisajes y escenarios.

Cada entidad visual deberá disponer de identidad estable, rasgos canónicos, referencias aprobadas, vistas, versiones, estilo, contexto temporal y evidencias de origen. Debe gestionar continuidad visual y advertir contradicciones entre nuevas descripciones y referencias existentes. Requiere proveedor gráfico o motor de renderizado integrado; el núcleo TypeScript/JavaScript coordina y valida, no sustituye por sí mismo al generador.

### 3.16. Atlas y enciclopedia de obra

Crear a petición catálogos navegables de personajes, árboles familiares, animales, bestiarios, objetos, armas, mapas, ciudades, arquitectura, vehículos, culturas, religiones, idiomas, cronologías, acontecimientos y relaciones. Cada entrada deberá enlazar con las apariciones y evidencias del libro y con sus versiones aprobadas.

### 3.17. Gestión de proyectos, versiones y sincronización

- Varias obras, sagas y universos aislados.
- Versiones de manuscritos y comparación de cambios.
- Historial de decisiones y propuestas aceptadas/rechazadas.
- Relaciones entre libros y continuidad de saga.
- Identidades persistentes y referencias estables.
- Sincronización, persistencia, recuperación y resolución de conflictos.
- Reejecución selectiva de análisis afectados por cambios, solo cuando corresponda al flujo solicitado o a una política expresamente autorizada.
- Trazabilidad de qué versión originó cada resultado.

### 3.18. Producción y publicación editorial

Bajo solicitud: portadas, contraportadas, sinopsis, índices, interiores, maquetación, EPUB, DOCX, PDF, archivos para impresión, ediciones digitales, fichas editoriales, material promocional y dossiers de presentación. Cada salida debe validarse en el formato correspondiente y conservar el vínculo con la edición fuente.

## 4. Capacidades avanzadas adicionales

El catálogo también contempla módulos especializados, sujetos a diseño y evaluación independientes:

- **Análisis emocional:** emociones, tensión y evolución afectiva.
- **Análisis psicológico literario:** motivaciones, conflictos internos y comportamiento ficticio; sin diagnósticos clínicos.
- **Análisis de diálogos:** naturalidad, subtexto, intención, ritmo y voz individual.
- **Análisis de simbolismo:** símbolos, metáforas recurrentes y posibles interpretaciones.
- **Análisis temático:** temas principales/secundarios y su evolución.
- **Análisis filosófico:** argumentos, dilemas, premisas y contradicciones.
- **Análisis histórico:** coherencia con periodos y acontecimientos, diferenciando ficción deliberada.
- **Análisis científico:** plausibilidad y consistencia interna según disciplinas pertinentes.
- **Análisis cultural:** costumbres, instituciones, referencias y posibles anacronismos.
- **Análisis de escenarios:** legibilidad espacial, continuidad y función dramática.
- **Análisis orientado al lector:** claridad, accesibilidad, ritmo y dificultad de comprensión.
- **Análisis de género literario:** convenciones y expectativas de misterio, terror, fantasía, romance, ciencia ficción, etc., sin imponer fórmulas.
- **Accesibilidad:** estructura semántica, navegación y preparación para tecnologías de asistencia.
- **Adaptación audiovisual:** descomposición en escenas, secuencias y guion para cine/televisión.
- **Narrativa interactiva:** ramificaciones, decisiones, estados y finales múltiples.
- **Diseño de videojuegos:** misiones, personajes, escenarios, objetos, reglas y progresión.
- **Audio y narración:** preparación de audiolibros, pronunciaciones, guiones y recursos de voz.
- **Protección de continuidad:** análisis de impacto antes de aceptar cambios que afecten otras partes.
- **Investigación documental:** contraste con fuentes externas solo cuando se solicite, con citas, fecha y procedencia.
- **Análisis de similitudes:** localizar coincidencias y patrones textuales con fuentes disponibles; no declarar plagio automáticamente ni emitir conclusiones legales.

## 5. Arquitectura conceptual compartida

La arquitectura lógica objetivo se organiza en capas:

1. **Aplicación anfitriona e interfaz:** botones, comandos, selección de obra y alcance.
2. **Coordinador de solicitudes:** valida autorización, parámetros, permisos, dependencias y alcance; despacha solo la operación solicitada.
3. **Ingesta y preparación:** lectores de formatos, OCR, reconstrucción, segmentación, normalización y referencias de origen.
4. **Extracción y recuperación:** análisis lingüístico, detección de entidades, resolución de referencias, extracción de relaciones y evidencias.
5. **Motores especializados:** literario, narrativo, personajes, cronología, continuidad, editorial, retos, traducción, lingüístico, creativo, cartográfico, visual y demás módulos.
6. **Modelo de conocimiento compartido:** entidades, relaciones, eventos, conceptos, cronologías, glosarios, coordenadas, evidencias, confianza y versiones.
7. **Adaptadores externos:** OCR, modelos lingüísticos, traducción, generación de imágenes, renderizado, audio e investigación, cada uno detrás de contratos reemplazables.
8. **Resultados y control del autor:** informes, propuestas, previsualizaciones, aceptación/rechazo, historial y exportaciones.

Los motores no deben mantener versiones contradictorias e independientes del canon. Deben consultar y actualizar el modelo compartido mediante operaciones explícitas, validadas y versionadas. La arquitectura es una dirección de diseño, no una afirmación de que todas estas capas estén implementadas.

## 6. Contrato común de resultados

Siempre que corresponda, los resultados de los módulos deberán compartir campos conceptuales:

- Identificador de operación y módulo.
- Proyecto, documento y versión de entrada.
- Alcance analizado.
- Tipo de resultado: hecho extraído, hallazgo, inferencia, hipótesis, propuesta o artefacto generado.
- Contenido y explicación.
- Evidencias y rangos de origen.
- Confianza y limitaciones.
- Advertencias y conflictos.
- Dependencias/proveedor y versión, si aplica.
- Estado de revisión del usuario.
- Historial de aceptación, rechazo o modificación.

Los contratos concretos deben tiparse en TypeScript, versionarse y validarse en tiempo de ejecución en los límites de entrada/salida.

## 7. Política de ejecución bajo demanda en la aplicación

La aplicación debe presentar acciones explícitas y comprensibles, por ejemplo:

- «Leer y preparar libro» (flujo de ingesta).
- «Revisar ortografía».
- «Analizar redacción».
- «Buscar cabos sueltos».
- «Comprobar continuidad».
- «Evaluar calidad literaria».
- «Predecir posibles finales».
- «Ayudarme con esta escena».
- «Verificar reto».
- «Traducir libro».
- «Crear retrato».
- «Generar mapa».
- «Crear atlas».
- «Preparar edición para publicación».

El botón/orden debe determinar el módulo, el documento y el alcance. No se debe inferir autorización para ejecutar otras tareas relacionadas. Por ejemplo, traducir no autoriza a ilustrar; evaluar no autoriza a reescribir; analizar no autoriza a aplicar correcciones. Si una operación necesita otra, debe declararlo y solicitar la autorización correspondiente.

Las operaciones largas deberán poder mostrar estado, cancelación segura, progreso, errores y recuperación sin duplicar efectos. Los resultados deben quedar separados del manuscrito hasta que el usuario decida incorporarlos.

## 8. Priorización y dependencias propuestas

La implementación debe organizarse por dependencias técnicas y valor:

**Fundación de datos**
- Ingesta robusta y extracción con procedencia.
- Segmentación y referencias estables.
- Recuperación semántica y resolución de entidades.
- Modelo de conocimiento compartido.
- Contratos, versionado, permisos y coordinador bajo demanda.

**Comprensión y análisis**
- Continuidad, cronología y causalidad.
- Personajes, acontecimientos y tramas.
- Revisión editorial y detección de cabos sueltos.
- Evaluación literaria y análisis avanzados.
- Verificación de retos.

**Capacidades de producción**
- Traducción y maquetación.
- Idiomas ficticios.
- Creatividad asistida.
- Cartografía e ilustración.
- Atlas y enciclopedia.
- Adaptaciones, audio y publicación.

Esta secuencia es orientativa. Se podrán trabajar frentes en paralelo cuando las interfaces y dependencias estén definidas; no se debe iniciar una integración que dependa de contratos aún inestables.

## 9. Verificación y criterios de aceptación por módulo

Ningún módulo se declarará terminado por existir una función, una demostración o una imagen de ejemplo. Cada uno deberá contar con:

1. Especificación funcional y límites.
2. Contratos TypeScript documentados y validados.
3. Implementación integrada en el repositorio y en la aplicación anfitriona.
4. Pruebas unitarias, de integración, regresión y casos adversariales.
5. Corpus representativo por idioma, género, formato y complejidad.
6. Métricas de precisión, cobertura, falsos positivos y falsos negativos cuando proceda.
7. Pruebas de rendimiento, memoria, cancelación y recuperación.
8. Pruebas de no ejecución sin autorización y de no modificación del original.
9. Evidencias de CI asociadas al commit exacto.
10. Documentación de dependencias, límites y resultados no concluyentes.
11. Revisión humana en tareas interpretativas y editoriales.
12. Pruebas de interoperabilidad con el modelo de conocimiento y la sincronización.

## 10. Riesgos y controles

- **Extracción incompleta:** medir cobertura, usar OCR cuando proceda, conservar confianza y permitir inspección de fuente.
- **Falsas identidades:** mantener candidatos separados y exigir evidencia suficiente para fusionar.
- **Falsos cabos sueltos:** distinguir misterio intencional, ambigüedad y olvido probable.
- **Evaluación subjetiva:** justificar observaciones y no vender puntuaciones como verdades universales.
- **Traducción con omisiones:** verificar cobertura y correspondencia de segmentos.
- **Deriva visual:** reutilizar referencias aprobadas y registrar versiones.
- **Contaminación del canon:** separar propuestas creativas de hechos aprobados.
- **Acciones no solicitadas:** pruebas explícitas del coordinador y permisos por operación.
- **Dependencia de proveedores:** adaptadores reemplazables, límites documentados y manejo de indisponibilidad.
- **Exceso de alcance:** entregar por módulos, con criterios de cierre y estados verificables.

## 11. Registro de estado y regla de honestidad

Este documento registra el alcance que el usuario ha aprobado para el diseño del producto. No transforma requisitos en código ni amplía retroactivamente el significado de pruebas ya existentes.

El estado de cada capacidad deberá clasificarse por separado, al menos como:
- Propuesta pendiente de definición.
- Especificada.
- En implementación.
- Implementada, pendiente de pruebas.
- Probada en entorno local.
- Validada en CI en un commit identificado.
- Integrada en la aplicación anfitriona.
- Aceptada funcionalmente con corpus y revisión correspondientes.

No se utilizará «completo» para un módulo que solo tenga contratos, documentación, pruebas aisladas o un prototipo. La validación del núcleo existente (incluida la ejecución histórica de 718 pruebas) no acredita las capacidades futuras enumeradas en esta ampliación.

**Resultado de esta actualización:** el catálogo integral queda incorporado como alcance objetivo del producto. El siguiente trabajo de ingeniería debe convertirlo en inventario trazable de módulos, contratos, dependencias, prioridades, archivos responsables y pruebas, y después implementar cada frente sin confundir documentación con funcionalidad.


## Auditoría de arquitectura y mapa del motor

Se incorporó una auditoría inicial del repositorio que identifica la distribución real del motor, sus capas TypeScript, extractores narrativos, ingesta de libros, persistencia, puente JSON-RPC, crates Rust/MLDB y principales brechas entre alcance e implementación.

Documento: [Arquitectura y mapa del motor](../base%20de%20datos/Motor-Literario/docs/architecture/ARQUITECTURA_Y_MAPA_DEL_MOTOR.md).

**Hallazgo prioritario:** la ingesta de archivos comprobada acepta TXT y Markdown UTF-8; EPUB, PDF, DOCX y OCR no están implementados en esa ruta. La auditoría distingue además los módulos existentes de las capacidades integradas y validadas. La ejecución CI del HEAD inspeccionado estaba en curso al redactar el documento.

Commit de la auditoría: `79a630c95e431943fe4e1aca39bc09b3d4fcbc56`.
