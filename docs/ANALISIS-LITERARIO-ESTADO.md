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

La ejecución integral del workflow **Motor Literario TypeScript** sobre el commit `8855c23ed7d56c7041785150355835d38d42dc83` terminó correctamente:

- `npm run typecheck`: aprobado.
- Compilación, validación de esquemas y `npm test`: aprobados.
- Resultado de Node Test Runner: **713 pruebas, 704 aprobadas, 0 fallidas y 9 omitidas**.
- `npm run bench`: aprobado.
- Ejecución CI: https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45734599092

Correcciones incorporadas durante la depuración:

1. La API descarta cachés parciales de ideas y entidades cuando falla la validación de referencias, permitiendo que la siguiente consulta vuelva a leer el almacenamiento durable.
2. El analizador admite catálogos globales de hasta **12.000 ideas** y hasta **2.000 encabezados/escenas explícitas** por fragmento.
3. La detección de conectores causales utiliza límites Unicode de letras y marcas, evitando que conectores acentuados como `provocó`, `causó` y `desencadenó` queden fuera por el comportamiento ASCII de `\b`.
4. Las métricas de convergencia a dos saltos conservan la distinción entre retornos cíclicos, destinos compartidos y ramas exclusivas.
5. Las pruebas transaccionales de ideas usan `fake-indexeddb` y ya no dependen de que el runtime exponga IndexedDB nativo.
6. Las expectativas de sincronización y de catálogos históricos se ajustaron a los contratos actuales: revalidación de referencias, historiales importados parciales y contadores explícitamente inválidos.

#### Resultados del benchmark de edición en vivo

Métricas observadas en la ejecución de CI; son mediciones de ese runner y no garantías universales:

| Tamaño del documento | Ediciones | P95 commit | P95 extremo a extremo | Delta de heap |
|---:|---:|---:|---:|---:|
| 10.000 palabras | 40 | 5,06 ms | 5,49 ms | +0,75 MB |
| 100.000 palabras | 40 | 2,21 ms | 2,63 ms | +1,83 MB |
| 500.000 palabras | 40 | 3,54 ms | 4,04 ms | +3,61 MB |
| 20.000 palabras, una sola línea | 5 | 61,59 ms | 61,80 ms | -9,65 MB |

Escenario concurrente: 4 documentos, 10 ediciones por documento, 40 ediciones totales; P95 extremo a extremo de 1,21 ms y máximo de 4 documentos activos.

**Estado de esta fase:** las comprobaciones automatizadas configuradas en el workflow pasan en el commit citado. Las 9 pruebas omitidas siguen contabilizadas como omitidas, no como aprobadas.
