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

## Base de datos MLDB

La versión lógica vigente es **MLDB 0.4.1**. Define 25 tablas: 24 pertenecen al motor y están implementadas; `projects` pertenece a la aplicación anfitriona y no se duplica en la base narrativa. La correspondencia física declara **31 almacenes IndexedDB**, con versión de base **21**.

La persistencia incluye documentos y journal incremental, diagnósticos por revisión, fragmentos, fichas, nombres y alias, atributos extensibles, relaciones, evidencias, acontecimientos, ocurrencias cronológicas, perfiles de idioma y estilo, diccionarios, sugerencias, autorizaciones de importación, historiales append-only, migraciones y biblioteca personal de ideas por escritor. Las ideas no incorporadas se transfieren con su historial, procedencia y contexto; las incorporadas o descartadas permanecen en el proyecto de origen.

El aislamiento por proyecto y escritor se aplica en claves, índices, validaciones y transacciones. La identidad del proyecto no se inventa en el motor. La especificación de almacenamiento documenta qué datos pertenecen al anfitrión y cuáles al motor.

## Ejecutar y verificar

Desde `typescript/`:

```sh
npm install
npm run typecheck
npm run build
npm test
npm run bench
```

La CI de GitHub Actions ejecuta typecheck, compilación, validación del esquema y almacenamiento, suite automatizada y benchmark. En la ejecución registrada el **25 de noviembre de 2026**, commit `c0f1e011baab6666f06dc9549fcd53a037465440`, todos los pasos terminaron correctamente: **293 pruebas, 284 aprobadas, 0 fallidas y 9 omitidas**.

[Consultar la ejecución de CI](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45563427372).

El benchmark de CI usa escenarios sintéticos y un adaptador en memoria. Sus latencias no representan mediciones de disco ni sustituyen pruebas en los equipos y adaptadores del programa anfitrión.

## Límites que permanecen

La base de datos y su persistencia están implementadas, pero eso no significa que el motor literario completo esté terminado. Siguen fuera del alcance de la base de datos la comprensión semántica general, la inferencia fiable de acontecimientos y cronologías no explícitos, la resolución literaria completa de contradicciones y la clasificación semántica de afirmaciones que quedaron obsoletas al reescribirse el texto.

También falta validar en el programa anfitrión un ciclo real de copia de seguridad y restauración y medir el comportamiento de IndexedDB en los sistemas objetivo. Hasta completar esa validación externa, se deben mantener copias de seguridad independientes de los manuscritos importantes.
