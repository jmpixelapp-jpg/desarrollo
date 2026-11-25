# Análisis literario descriptivo — v0.1

**Estado:** módulo implementado en TypeScript; análisis determinista y local.  
**Rama:** `main`  
**Ámbito:** fragmento de un documento abierto, ligado a `projectId`, `documentId` y revisión.  
**Offsets:** UTF-16, compatibles con el editor JavaScript.

## Alcance

El análisis entrega métricas de longitud, mediana y dispersión de oraciones, variación entre oraciones consecutivas, ritmo de párrafo, diversidad léxica superficial, densidad estimada de diálogo, señales gramaticales explícitas de persona, palabras y frases literales recurrentes de 2 a 4 términos, aperturas de oración recurrentes, candidatos a anáfora en oraciones consecutivas, vocabulario sensorial explícito por modalidad y puntuación expresiva.

Las señales gramaticales excluyen tramos de diálogo reconocidos por comillas o líneas que empiezan con raya. Las ocurrencias devuelven offsets absolutos. El motor limita las muestras gramaticales a 40, los términos repetidos a 12 y las aperturas a 8; limita también los offsets visibles por patrón.

## Integración

`HostEngineApi.analyzeLiteraryDocument(documentId, start?, end?)` termina primero las ediciones admitidas y luego analiza el rango solicitado de la instantánea vigente. No escribe en IndexedDB, no altera el texto y no crea diagnósticos de corrección. Cada resultado queda ligado a proyecto, documento y revisión.

Desde `typescript/`:

```sh
npm run typecheck
npm test
```

## Límites metodológicos

- El perfil de ritmo usa promedio, mediana, dispersión y umbrales; los saltos entre longitudes son candidatos de contraste, no una valoración estética de la prosa.
- La detección de diálogo reconoce comillas angulares, curvas, rectas y líneas con raya. Otros estilos editoriales pueden no detectarse.
- La perspectiva gramatical cuenta pronombres explícitos fuera del diálogo; no identifica narrador, focalización ni persona verbal implícita.
- La diversidad léxica usa formas normalizadas y no desambigua homónimos, flexiones ni función sintáctica.
- Las aperturas recurrentes se calculan con las dos primeras palabras de cada oración y pueden reflejar conectores frecuentes.
- Las frases recurrentes exigen coincidencia literal de 2 a 4 términos dentro de la misma oración y al menos dos palabras de contenido; son candidatos de repetición textual, no motivos semánticos.
- La anáfora es un candidato cuando coinciden literalmente las dos primeras palabras de al menos dos oraciones consecutivas.
- El vocabulario sensorial usa listas explícitas de palabras por modalidad; no reconoce sentidos implícitos, metáforas ni sinestesias.
- El análisis acepta como máximo 2.000.000 de unidades UTF-16 por operación; manuscritos más extensos deben consultarse por rangos y revisión.

Estas métricas son indicios para inspección del escritor. No son correcciones obligatorias y nunca autorizan cambios automáticos en el manuscrito.


## Ritmo y transiciones

La distribución clasifica las oraciones en cortas (hasta 8 palabras), medias (9–24) y largas (25 o más). La mediana y la desviación estándar describen el conjunto sin depender solo del promedio. Se propone un contraste entre dos oraciones consecutivas cuando la más larga tiene al menos 16 palabras, supera a la otra por 10 palabras o más y duplica su longitud. El resultado marca aceleración o desaceleración según el sentido del cambio y devuelve ambos rangos UTF-16. Es un indicio para revisar cadencia, no una conclusión sobre intención narrativa.
