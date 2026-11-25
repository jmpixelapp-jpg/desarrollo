# Auditoría de implementación física de MLDB

**Fecha de verificación:** 25 de noviembre de 2026  
**Rama:** `main`  
**Base lógica:** MLDB 0.4.1  
**Almacenamiento:** IndexedDB nativo, versión 21

## Alcance

El manifiesto `MLDB/storage_mapping_v0.4.1.json` declara 25 tablas lógicas. La tabla `projects` pertenece al anfitrión: el motor recibe la identidad del libro y no crea una copia narrativa de ella. Las otras 24 tablas pertenecen al motor y deben permanecer marcadas como `implemented`.

El manifiesto declara 31 almacenes IndexedDB físicos, incluidos los almacenes operativos de diagnósticos y recibos de finalización; las 24 tablas lógicas del motor se corresponden con sus almacenes aunque algunas colecciones se comparten. Algunos almacenes son compartidos por más de una tabla lógica (por ejemplo, las evidencias narrativas y los vínculos de diccionario), por lo que el número de almacenes no equivale al número de tablas.

## Verificación automatizada

El script `typescript/scripts/audit-storage-implementation.mjs` contrasta el manifiesto con `typescript/src/persistence/indexeddb-store.ts`. Comprueba que:

- `projects` sea la única tabla con estado `host-owned` y no tenga almacenes narrativos duplicados.
- Cada tabla restante tenga estado `implemented` y declare al menos un almacén físico.
- Cada almacén nombrado en el manifiesto tenga una constante en el adaptador IndexedDB.
- Cada almacén mapeado se cree mediante `createObjectStore`.
- No existan entradas de tabla o nombres de almacén duplicados dentro de una tabla.

Ejecución desde `typescript/`:

```sh
npm run validate:schema
npm test
```

La auditoría es estática y complementa —no sustituye— las pruebas de comportamiento de IndexedDB, validación de referencias, aislamiento por proyecto/escritor, migraciones y recuperación. La suite de pruebas sigue siendo obligatoria antes de aceptar cambios.

## Estado comprobado

En la inspección estática de los archivos actuales, las 24 tablas propiedad del motor están marcadas `implemented`; los 31 almacenes tienen constantes, `keyPath` e índices coincidentes con el adaptador. Esta comprobación no equivale a ejecutar `npm test`: el CI del último commit todavía debe confirmar typecheck, pruebas automatizadas y benchmark.
