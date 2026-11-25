# Auditoría de implementación física de MLDB

**Fecha de verificación:** 25 de noviembre de 2026  
**Rama:** `main`  
**Base lógica:** MLDB 0.4.1  
**Almacenamiento:** IndexedDB nativo, versión 21

## Alcance

El manifiesto `MLDB/storage_mapping_v0.4.1.json` declara 25 tablas lógicas. La tabla `projects` pertenece al anfitrión: el motor recibe la identidad del libro y no crea una copia narrativa de ella. Las otras 24 tablas pertenecen al motor y están marcadas como `implemented`.

El manifiesto declara 31 almacenes IndexedDB físicos, incluidos los almacenes operativos de diagnósticos y recibos de finalización. Algunas colecciones se comparten entre tablas lógicas, por lo que el número de almacenes no equivale al número de tablas.

## Verificación automatizada

El script `typescript/scripts/audit-storage-implementation.mjs` contrasta el manifiesto con `typescript/src/persistence/indexeddb-store.ts`. Comprueba que:

- `projects` sea la única tabla `host-owned` y no tenga almacenes narrativos duplicados.
- Cada tabla propiedad del motor tenga estado `implemented` y declare almacenes físicos.
- Cada almacén del manifiesto tenga constante y llamada de creación en IndexedDB.
- Coincidan el `keyPath`, los nombres y los `keyPath` de índices y la regla de unicidad.
- No existan almacenes ni índices de runtime sin declarar en el manifiesto.
- No se repitan entradas de tabla o nombres de almacén dentro de una tabla.

Ejecución local desde `typescript/`:

```sh
npm run validate:schema
npm test
npm run bench
```

## Resultado de CI comprobado

La ejecución de GitHub Actions del **25 de noviembre de 2026** para el commit `c0f1e011baab6666f06dc9549fcd53a037465440` finalizó con conclusión **success**.

- Typecheck: correcto.
- Build: correcto.
- Validación de esquema y auditoría de almacenamiento: correcto.
- Suite Node: **293 pruebas, 284 aprobadas, 0 fallidas y 9 omitidas**.
- Benchmark de edición en vivo: correcto.

[Ver ejecución, pasos y logs](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45562960002).

## Benchmark registrado en CI

Resultados del runner de GitHub Actions, con adaptador de persistencia en memoria:

| Escenario | p50 integral | p95 integral |
|---|---:|---:|
| 10.000 palabras, 40 ediciones | 6,77 ms | 6,81 ms |
| 100.000 palabras, 40 ediciones | 4,56 ms | 4,71 ms |
| 500.000 palabras, 40 ediciones | 3,72 ms | 3,94 ms |
| Línea única, 20.000 palabras, 5 ediciones | 40,00 ms | 65,21 ms |

El escenario concurrente procesó cuatro documentos en paralelo, con 40 ediciones totales y máximo de cuatro documentos activos. Estas cifras caracterizan ese runner y el adaptador en memoria; no son mediciones de disco ni compromisos de latencia para el equipo del escritor.

## Estado comprobado y límites externos

Las 24 tablas propiedad del motor están implementadas; `projects` permanece correctamente bajo propiedad del anfitrión. Los 31 almacenes, sus claves e índices coinciden con el manifiesto y el runtime, y la suite automatizada y el benchmark pasaron en el commit indicado.

La CI no valida por sí sola la instalación final del programa anfitrión, el comportamiento de IndexedDB en todos los sistemas objetivo ni un ciclo de copia de seguridad/restauración desde la interfaz anfitriona. Esa validación externa sigue siendo necesaria antes de confiar manuscritos irremplazables a una instalación concreta.
