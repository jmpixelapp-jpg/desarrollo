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
