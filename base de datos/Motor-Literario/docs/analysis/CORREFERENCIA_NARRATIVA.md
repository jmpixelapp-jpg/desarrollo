# Correferencia narrativa: recuperación conservadora de antecedentes

**Módulos:** `typescript/src/narrative-pronoun-reference-discovery.ts`, `narrative-elliptical-subject-discovery.ts`, `narrative-descriptive-reference-discovery.ts`  
**Fecha de revisión:** 26 de noviembre de 2026

## Objetivo

Recuperar menciones que podrían apuntar a personajes, objetos u otras entidades ya identificadas, sin convertir la proximidad textual en identidad confirmada. La salida de estos extractores es una hipótesis revisable; no fusiona entidades, no crea relaciones definitivas y no modifica el manuscrito.

## Fuentes de evidencia

1. **Mención nominal:** nombre canónico o alias literal ya registrado.
2. **Pronombre personal:** referencia personal de tercera persona al inicio de una oración (`él`, `ella`, `ellos`, `ellas`, `usted`, `ustedes`). Se buscan menciones anteriores dentro de una ventana acotada.
3. **Sujeto elíptico:** posible continuidad entre acciones adyacentes cuando la acción anterior contiene sujeto gramatical explícito en voz activa y no aparece otra mención de personaje en el intervalo.
4. **Referencia descriptiva:** descripción literal previamente validada por el escritor o por extracción revisada.

Cada evidencia conserva proyecto, documento, revisión y offsets UTF-16 absolutos. La evidencia del pronombre se conserva separada de la evidencia del antecedente; la evidencia de una etiqueta descriptiva conserva su procedencia original y no se confunde con la mención actual.

## Reglas de abstención

- La cercanía solo ordena candidatos: nunca selecciona automáticamente el más cercano.
- Dos o más antecedentes posibles producen estado `ambiguous`.
- La ausencia de una mención anterior produce `no-antecedent`.
- Los candidatos mantienen estado editorial `candidate`; no son correferencias confirmadas.
- La recuperación de sujeto omitido no propaga una hipótesis anterior: el antecedente debe ser un sujeto explícito.
- Saltos de párrafo, menciones intermedias de personajes, voz pasiva o falta de evidencia sintáctica provocan abstención.
- No se infiere género gramatical a partir del nombre ni se usa plausibilidad narrativa para decidir identidad.
- Las referencias descriptivas repetidas entre personajes permanecen ambiguas; las etiquetas con evidencia obsoleta no se utilizan.

## Límites de entrada de pronombres

El descubridor pronominal limita el texto a 2.000.000 unidades UTF-16, la colección a 10.000 entidades, los alias a 100 por entidad y cada nombre/alias a 256 unidades UTF-16. También valida proyecto, identificadores únicos, tipo de entidad y alias no vacíos antes de buscar menciones. Estos topes controlan el coste de escaneo y evitan que entradas patológicas degraden el procesamiento.

## Límites lingüísticos actuales

La detección pronominal actual cubre pronombres personales al inicio de oración, no todas las posiciones sintácticas, clíticos, demostrativos, relativos, posesivos ni referencias discursivas largas. El sujeto omitido solo se propone a partir de observaciones de acción ya extraídas; por tanto, su calidad depende de la calidad de ese extractor y de su análisis del sujeto gramatical.

La segmentación por signos de puntuación es heurística y puede fallar ante abreviaturas, diálogo, puntuación literaria, títulos, citas y estructuras sin puntuación convencional. Los extractores no implementan todavía análisis morfosintáctico completo ni modelos de entidades mencionadas por descripciones libres.

## Próximas mejoras técnicas

1. Introducir segmentación robusta por párrafo, diálogo, citas y abreviaturas con offsets preservados.
2. Ampliar la cobertura a pronombres no iniciales y clíticos, manteniendo candidatos y abstención.
3. Añadir compatibilidad morfosintáctica solo cuando proceda de un análisis lingüístico explícito y versionado; no inferir género por nombres.
4. Modelar cadenas de correferencia como grafos de menciones, con aristas candidatas y confirmaciones editoriales separadas.
5. Incorporar resolución intercapítulo con límites de escena y señales de cambio de foco narrativo.
6. Construir un corpus de evaluación anotado por humanos para medir precisión, recuperación, cobertura y abstención por fenómeno y por idioma.
7. Integrar el resultado con el grafo incremental únicamente como nodo/arista provisional, preservando procedencia y versión del extractor.

## Validación y pruebas

Las pruebas existentes cubren antecedentes únicos y ambiguos, orden por recencia, ausencia de antecedente, exclusión de menciones posteriores, offsets Unicode, alias, referentes no humanos, continuidad de sujeto elíptico, saltos de párrafo, menciones intermedias y metacaracteres literales. Se agregaron regresiones de límites para texto, cantidad de entidades, alias y nombres.

No se declara precisión estadística ni ejecución local de la suite a partir de la mera existencia de estos casos. La suite completa debe ejecutarse en el entorno del proyecto y sus resultados deben quedar vinculados al commit correspondiente.
