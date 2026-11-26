# Descubrimiento de referencias descriptivas: presupuesto operativo — 26 de noviembre de 2026

## Hallazgo

El módulo ya separa la mención literal actual de la etiqueta descriptiva histórica y mantiene varias entidades candidatas cuando comparten una etiqueta. Sin embargo, sus límites previos acotaban texto, perfiles y resultados, pero no el trabajo agregado de exploración. En el peor caso, miles de etiquetas podían recorrer repetidamente un documento de hasta dos millones de unidades UTF-16.

## Cambio

Se añade un presupuesto acumulado conservador: cada etiqueta activa consume el tamaño completo del texto y el análisis se detiene al superar 25.000.000 de unidades estimadas. La función lanza un error explícito y no devuelve una colección parcial que pudiera confundirse con un resultado exhaustivo. Se añade además un máximo agregado de 20.000 etiquetas entre perfiles.

El límite estima ventanas de búsqueda, no mide el coste exacto del motor de expresiones regulares. Es deliberadamente conservador y evita que límites individuales aparentemente razonables se multipliquen sin control.

## Regresión

La prueba de carga construye un documento de dos millones de unidades y trece perfiles con una etiqueta cada uno: la operación debe detenerse por presupuesto. Se conservan las pruebas de ambigüedad, evidencia histórica obsoleta, límites Unicode y procedencia de etiqueta.

## Alcance semántico

Este módulo sigue buscando solo etiquetas previamente revisadas y asociadas a perfiles de personaje. No extrae por sí solo descripciones nuevas ni decide a quién se refiere una descripción. La asociación continúa siendo candidata y requiere revisión.

## Extracción de descripciones en aposición — 26 de noviembre de 2026

Se incorpora `discoverNarrativeDescriptiveLabelCandidates` al módulo. Detecta una forma acotada de aposición nominal inmediatamente posterior a una entidad conocida: «Ana, la heredera del reino» o «Ana, la mujer con cicatriz». La extracción reconoce determinantes españoles comunes y hasta dos complementos preposicionales.

Cada propuesta conserva dos evidencias independientes: la mención del nombre/alias que sirve de ancla y el fragmento descriptivo. El resultado indica `appositive-description` y `reviewStatus: candidate`. No escribe la etiqueta en `NarrativeEntity`, no afirma que sea verdadera y no convierte la aposición en identidad confirmada.

### Límites y precisión

- Texto de hasta 2.000.000 de unidades UTF-16.
- Máximo de 10.000 entidades y 2.000 propuestas por llamada.
- Presupuesto agregado de 25.000.000 de unidades estimadas de exploración.
- Solo se consideran nombre canónico y alias explícitos como ancla.
- Etiquetas limitadas a determinante + núcleo nominal + hasta dos complementos preposicionales.
- Los offsets se expresan en UTF-16 y respetan `baseOffset`.

La gramática es deliberadamente conservadora: no intenta resolver aposiciones libres, relativas como «la mujer que llegó del norte», ni descripciones separadas del nombre por varias cláusulas. Esas construcciones requieren análisis sintáctico/contextual más amplio.

### Pruebas añadidas

Se añaden pruebas para «Ana, la heredera del reino», offsets absolutos con caracteres suplementarios y rechazo de frases descriptivas sin una entidad explícita como ancla. La ejecución del conjunto de pruebas debe confirmarse en el entorno CI; el commit por sí solo no equivale a una ejecución satisfactoria.

### Próximo paso

Ampliar la extracción a aposiciones con incisos y complementos relativos, manteniendo separadas la extracción de frase, la atribución candidata y la confirmación editorial. También será necesario evaluar falsos positivos sobre prosa literaria real antes de ampliar la gramática.
