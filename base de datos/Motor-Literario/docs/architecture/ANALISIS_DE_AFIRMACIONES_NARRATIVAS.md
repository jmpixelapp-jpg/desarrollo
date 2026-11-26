# Análisis de afirmaciones narrativas con evidencia

**Estado:** extractor heurístico implementado y cubierto por pruebas en TypeScript.  
**Runtime:** JavaScript/TypeScript puro; sin servicios externos ni modelos remotos.  
**Código:** `typescript/src/narrative-history.ts`.  
**Pruebas:** `typescript/tests/narrative-assertions.test.mjs`.

## 1. Objetivo

Convertir algunas afirmaciones explícitas del manuscrito en registros estructurados que conserven su procedencia textual. El extractor facilita revisar continuidad de personajes y localizar evidencia; no decide por el escritor si una afirmación es verdadera dentro de la obra.

## 2. Contrato de entrada

`extractNarrativeAssertions(projectId, documentId, revision, text, entities, baseOffset?, now?)` recibe:

- identidad del proyecto y documento;
- revisión del documento;
- texto de la porción analizada;
- entidades narrativas conocidas;
- offset UTF-16 absoluto del fragmento, opcional;
- instante de captura, opcional.

El contexto se valida antes de analizar. Las entidades deben pertenecer al proyecto solicitado y tener identidad, tipo, nombre canónico, nombre normalizado y aliases válidos. Una entidad ajena al proyecto invalida la entrada en lugar de mezclarse silenciosamente.

## 3. Afirmaciones reconocidas

La implementación actual busca patrones explícitos en español:

- **Edad:** construcciones como `Mara tiene 27 años`.
- **Ubicación:** construcciones como `Mara vive en Puerto Azul`, `reside en`, `se encuentra en` o `está en`.
- **Rol:** construcciones como `Mara es la capitana`, `era reina` o `será general`, dentro del vocabulario declarado por el extractor.

La búsqueda se limita a entidades de tipo `character` y utiliza el nombre canónico y aliases. No crea identidades nuevas, no fusiona personajes y no interpreta similitud difusa como identidad.

## 4. Evidencia y cronología

Cada afirmación conserva:

- `projectId`, `entityId` y nombre canónico;
- atributo y valor extraído;
- identificador de documento y revisión;
- offsets absolutos UTF-16 de la coincidencia;
- fragmento de línea como evidencia legible;
- instante de captura.

Cuando la misma línea contiene una referencia temporal explícita cercana, el extractor puede asociarla como pista: fecha ISO, fecha `DD/MM/YYYY`, índice `día N` / `jornada N` o `año N`. Las fechas de calendario se validan antes de convertirse a ordinal UTC. Si no hay referencia reconocible, el campo temporal queda ausente; no se inventa una fecha.

## 5. Límites y uso editorial

Este componente es un extractor lexical de patrones acotados, no un analizador semántico general ni un sistema de resolución de contradicciones. Puede omitir paráfrasis, idiomas distintos, construcciones pasivas, pronombres, elipsis, negaciones complejas, ironía, hipótesis y referencias temporales implícitas. Una coincidencia puede requerir revisión humana.

La referencia temporal se elige por proximidad dentro del fragmento de evidencia; proximidad no demuestra causalidad ni asociación semántica. El valor extraído debe tratarse como una observación con procedencia, no como un hecho canónico confirmado.

No se debe usar el resultado para reescribir el manuscrito automáticamente. La confirmación, corrección o descarte pertenece al flujo editorial y debe conservar la evidencia original.

## 6. Cobertura de regresión

`narrative-assertions.test.mjs` verifica:

1. extracción de edad, ubicación y rol;
2. aliases y exclusión de entidades no-personaje;
3. offsets absolutos, revisión, fragmento y timestamp;
4. selección de fecha explícita cercana;
5. aislamiento por proyecto y validación de contexto;
6. ausencia de atributos y fechas inventados cuando el texto no aporta patrones explícitos.

Ejecutar desde `typescript/`:

```bash
npm test
```

La prueba completa requiere que el bundle principal esté construido; la suite del repositorio realiza ese paso automáticamente.
