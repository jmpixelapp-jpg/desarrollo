# Registro de progreso: análisis literario e inteligencia narrativa

**Ámbito:** `base de datos/Motor-Literario`  
**Runtime:** TypeScript / JavaScript puro.  
**Rama de integración:** `main`.  
**Última actualización:** 26 de noviembre de 2026.

## 1. Entregas de esta tanda

### Integridad de sincronización

- `typescript/src/narrative-sync-integrity.ts`: canonicalización determinista de payloads JSON, huella FNV-1a de 64 bits y comparación por representación canónica.
- Límites de profundidad, nodos y bytes UTF-8.
- Rechazo de ciclos, getters, símbolos, prototipos personalizados, valores no JSON, arrays dispersos y propiedades adicionales.
- Exportación pública desde `src/index.ts`.
- Regresiones en `tests/narrative-sync-integrity.test.mjs`.

**Límite:** FNV-1a sirve para consistencia y comparación, no es una firma criptográfica ni sustituye la autenticación.

### Afirmaciones narrativas con evidencia

- `typescript/src/narrative-history.ts`: extracción conservadora de edad, ubicación y rol a partir de patrones explícitos en español.
- Reconocimiento de nombre canónico y aliases, limitado a entidades de tipo personaje.
- Conservación de proyecto, entidad, documento, revisión, offsets UTF-16, fragmento de evidencia y timestamp.
- Referencias temporales explícitas de calendario y día narrativo, validadas antes de convertirse en valores ordinales.
- Regresiones en `tests/narrative-assertions.test.mjs`.

**Límite:** el extractor es lexical y heurístico. No resuelve paráfrasis, pronombres, negación compleja ni contradicciones semánticas generales. Los resultados son observaciones revisables, no hechos canónicos automáticos.

### Estabilidad del monitor y persistencia local

- Reparación de la comparación de generaciones del lease.
- Seguimiento de revalidaciones concurrentes al volver de suspensión.
- Corrección de acumuladores de métricas y tipado estricto.
- Selector de tarjetas de documento separado de los elementos accesibles de métricas.
- Bundle de prueba aislado del monitor incorporado al pipeline completo.

## 2. Documentación técnica

- [Análisis de afirmaciones narrativas](../architecture/ANALISIS_DE_AFIRMACIONES_NARRATIVAS.md).
- [Integridad de payloads y sincronización narrativa](../architecture/INTEGRIDAD_DE_PAYLOADS_Y_SINCRONIZACION_NARRATIVA.md).
- [Registro del monitor de autor](LIVE_AUTHOR_MONITOR_PROGRESS.md).

## 3. Validación observada

- **Motor Literario TypeScript:** [run 45746700879](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45746700879), commit `71d6144c820512ce5989be17d03e6cdc88d6ccdb`: typecheck, build, suite completa y benchmark aprobados.
- **Live Author Monitor:** [run 45746701123](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45746701123), mismo commit: bundle aislado, regresiones, esquema MLDB, build, suite del monitor y benchmark de memoria aprobados.
- **Motor Literario TypeScript:** [run 45746807836](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45746807836), commit `7a75e0e38353ab01041bd5e3773e4f0fc5ea9c23`: typecheck, build, suite automatizada y benchmark aprobados después de actualizar el entrypoint del bundle aislado.

Los documentos añadidos después de estas ejecuciones no modifican código ejecutable. Cualquier cambio posterior de runtime requiere su propia validación CI.

## 4. Estado que no debe sobredeclararse

La canonicalización y las pruebas locales de bandeja no equivalen a sincronización remota. La sincronización multidispositivo todavía necesita transporte remoto, autenticación/autorización, API versionada, idempotencia de servidor, política de reintentos y reconciliación interactiva de conflictos. El PR #56 continúa separado y no se considera fusionado por este registro.


## 5. Consistencia temporal de afirmaciones

- Nuevo módulo `typescript/src/narrative-consistency.ts`, exportado desde el índice público.
- `analyzeNarrativeConsistency` compara valores distintos del mismo atributo y entidad dentro de un proyecto.
- Distingue conflicto en el mismo instante, evolución entre referencias ordenables y tiempo no comparable.
- Ignora evidencia obsoleta y preserva las dos evidencias junto con una explicación.
- Pruebas en `tests/narrative-consistency.test.mjs` para fechas, día narrativo, precisión, aislamiento y validación.
- Contrato detallado: [Consistencia temporal de afirmaciones](../architecture/CONSISTENCIA_TEMPORAL_DE_AFIRMACIONES.md).

**Límite:** los conflictos son candidatos para revisión humana; el motor no decide qué versión es verdadera. La comparación por pares es cuadrática por grupo entidad/atributo. Este módulo tampoco completa sincronización remota multidispositivo.
