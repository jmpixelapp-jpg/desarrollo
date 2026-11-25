# Motor Literario

## Implementación oficial

La implementación vigente del producto está en `typescript/`, desarrollada en TypeScript y JavaScript. Esta es la única línea que debe ampliarse para el runtime del producto.

- `typescript/src/`: núcleo, contratos de integración, monitoreo, análisis y conocimiento narrativo.
- `typescript/src/persistence/`: persistencia local mediante IndexedDB nativo.
- `MLDB/`: esquema lógico versionado y correspondencia del almacenamiento físico.
- `docs/specifications/`: contratos y decisiones técnicas.
- `database/legacy/`: formatos históricos preservados como referencia.

Las carpetas `engine/` y `storage/` contienen un prototipo histórico en Rust. No forman parte del runtime definitivo y no deben ampliarse como implementación del producto.

## Principios no negociables

- El motor lingüístico, la corrección, la extracción y el análisis literario son desarrollo propio.
- No se incorporan motores lingüísticos especializados ni servicios externos en tiempo de ejecución.
- Los manuscritos y el conocimiento de cada obra permanecen localmente y aislados por proyecto.
- La aplicación anfitriona proporciona la identidad del proyecto, el título del libro y la identidad autenticada del escritor.
- El motor analiza y sugiere; nunca modifica el manuscrito por iniciativa propia.
- El monitoreo continuo del escritor es la prioridad arquitectónica número uno.

## Integración con la aplicación anfitriona

La integración dispone de dos modalidades: [guía general del anfitrión](docs/integration/GUIA_INTEGRACION_ANFITRION_V1.md) y [puente JSON-RPC entre procesos](docs/integration/BRIDGE_PROCESS_PROTOCOL_V1.md). El puente ejecuta un proceso compañero por stdin/stdout y persiste en SQLite local. La antigua especificación JSON-RPC bajo `docs/specifications/` pertenece al prototipo Rust y no es el protocolo actual.

## Base de datos MLDB

La versión lógica vigente es **MLDB 0.4.1**. Define 25 tablas: 24 pertenecen al motor y están implementadas; `projects` pertenece a la aplicación anfitriona y no se duplica en la base narrativa. La modalidad dentro del mismo runtime utiliza **31 almacenes IndexedDB**, con versión de base **21**. Para procesos separados está disponible el puente JSON-RPC local, cuyo proceso compañero usa SQLite (`node:sqlite`) con esquema físico propio versión 1. Ambos modos mantienen los contratos lógicos MLDB, pero los archivos IndexedDB y SQLite son independientes y no se convierten ni sincronizan automáticamente. Consulta el [protocolo del puente](docs/integration/BRIDGE_PROCESS_PROTOCOL_V1.md) antes de elegir o migrar una instalación.

La persistencia incluye documentos y journal incremental, diagnósticos por revisión, fragmentos, fichas, nombres y alias, atributos extensibles, relaciones, evidencias, acontecimientos, ocurrencias cronológicas, perfiles de idioma y estilo, diccionarios, sugerencias, autorizaciones de importación, historiales append-only, migraciones y biblioteca personal de ideas por escritor. Las ideas no incorporadas se transfieren con su historial, procedencia y contexto; las incorporadas o descartadas permanecen en el proyecto de origen.

El aislamiento por proyecto y escritor se aplica en claves, índices, validaciones y transacciones. La identidad del proyecto no se inventa en el motor. La especificación de almacenamiento documenta qué datos pertenecen al anfitrión y cuáles al motor.

## Ejecutar y verificar

Desde `typescript/`, preparar el núcleo y el puente:

```sh
npm install
npm run build
```

Para iniciar el proceso compañero durante el desarrollo:

```sh
node bridge/stdio-server.mjs --db "/ruta/privada/motor-literario.sqlite"
```

En producción, la aplicación anfitriona inicia ese servidor como proceso hijo y utiliza `MotorLiterarioBridgeClient`. Se requiere Node.js 22.13.0 o posterior. El módulo SQLite integrado de Node está disponible sin la bandera experimental desde 22.13, aunque sigue clasificado como experimental; por ello se debe fijar la versión usada y probar las actualizaciones del runtime.

Verificaciones del núcleo:

```sh
npm run typecheck
npm test
npm run bench
```

La CI de GitHub Actions ejecuta typecheck, compilación, validación del esquema y almacenamiento, suite automatizada y benchmark. En el commit `e7181ba25e1e79c9acbcf4df4a7269001b2b4ad3`, el 25 de noviembre de 2026, pasaron **312 pruebas: 303 aprobadas, 0 fallidas y 9 omitidas**; también pasaron build y benchmark. [Ver ejecución completa](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45567766129).

El benchmark de CI usa escenarios sintéticos y un adaptador en memoria. Sus latencias no representan mediciones de disco ni sustituyen pruebas en los equipos y adaptadores del programa anfitrión.
## Análisis literario e inteligencia de ideas

El núcleo TypeScript incorpora un análisis determinista del catálogo de ideas del proyecto:

- El grafo global conserva ideas independientes y vínculos explícitos, y distingue referencias internas, externas al snapshot y ausentes.
- Calcula componentes débiles y fuertemente conexos, ciclos (incluidas auto-referencias), reciprocidad, fuentes, terminales y nodos aislados. El recorrido de componentes fuertemente conexos es iterativo para evitar desbordamientos de pila en grafos profundos.
- Produce métricas globales y perfiles por estado editorial en una sola pasada de agregación.
- Detecta resonancias léxicas mediante términos literales normalizados Unicode, filtrado adaptativo de términos ubicuos y medidas de solapamiento. La salida está limitada a los pares mejor clasificados y nunca convierte una coincidencia de palabras en una relación semántica o causal.
- Aplica presupuestos explícitos de catálogo, texto y resultados. La omisión de texto por presupuesto queda identificada y no se confunde con la ausencia de texto.
- La memoización usa una clave exacta de la instantánea y devuelve copias aisladas; los cambios de contenido, estado, historial, evidencia, vínculos o alcance invalidan el resultado anterior.

La sincronización de ideas utiliza escrituras condicionales por versión (CAS), reintentos acotados para conflictos concurrentes de vínculos, serialización de mutaciones dentro de una instancia, operaciones idempotentes y limpieza de referencias heredadas a destinos eliminados. Las altas de vínculos a fichas o a otras ideas vuelven a comprobar el catálogo durable, incluso después de conflictos CAS; las lecturas de ideas vinculadas revalidan las fichas. Así se rechazan destinos eliminados por otra instancia, también cuando desaparecen durante un reintento de escritura. Los cambios de estado editorial no se fusionan automáticamente cuando hay decisiones concurrentes incompatibles.

Estas capacidades son análisis estructural y lexical explicable, no comprensión semántica general. Las coincidencias léxicas no prueban equivalencia, intención, causalidad ni continuidad narrativa; las decisiones editoriales siguen perteneciendo al escritor.

## Límites que permanecen

La base de datos y su persistencia están implementadas, pero eso no significa que el motor literario completo esté terminado. Siguen fuera del alcance de la base de datos la comprensión semántica general, la inferencia fiable de acontecimientos y cronologías no explícitos, la resolución literaria completa de contradicciones y la clasificación semántica de afirmaciones que quedaron obsoletas al reescribirse el texto.

También falta validar en el programa anfitrión un ciclo real de copia de seguridad y restauración y medir el comportamiento de IndexedDB en los sistemas objetivo. Hasta completar esa validación externa, se deben mantener copias de seguridad independientes de los manuscritos importantes.
