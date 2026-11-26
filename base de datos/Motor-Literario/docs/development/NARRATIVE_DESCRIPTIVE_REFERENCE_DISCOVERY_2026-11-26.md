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

 
## Endurecimiento de validación y exhaustividad — 26 de noviembre de 2026

La extracción de aposiciones ahora rechaza IDs duplicados, alias vacíos, alias equivalentes tras normalización y alias que exceden 256 unidades UTF-16. Se limita a 100 alias por entidad. Los nombres canónicos también deben respetar ese máximo de longitud. Antes, los alias inválidos se filtraban silenciosamente, lo que podía ocultar datos defectuosos del perfil.

Se elimina el truncamiento silencioso por `maxCandidates`: si aparece una propuesta adicional al límite, la función lanza un error explícito y no devuelve una muestra que pudiera confundirse con el conjunto completo. La ordenación final es textual (inicio, fin y luego ID de entidad), independiente del orden de entrada de las entidades.

Se añaden regresiones para IDs duplicados, alias inválidos/equivalentes, exceso de resultados y orden cronológico determinista. Estas pruebas quedan incorporadas al archivo de test; su ejecución debe verificarse en CI.


## Descubrimiento de cláusulas relativas — 26 de noviembre de 2026

Se añade `discoverNarrativeRelativeClauseCandidates` para localizar incisos relativos explícitos anclados a una entidad nombrada: «Ana, que conocía la ciudad, abrió la puerta». La salida conserva el texto de la cláusula y dos evidencias separadas (ancla y cláusula), con relación `relative-clause` y estado `candidate`.

La detección exige: nombre canónico o alias explícito; coma después del nombre; inicio con «que»; una forma verbal finita reconocida por una lista conservadora/terminaciones frecuentes; coma de cierre; y ausencia de puntuación de cierre de oración dentro del inciso. El límite predeterminado de cláusula es 240 caracteres (máximo configurable: 600). Conserva offsets UTF-16 y aplica el presupuesto agregado de exploración de 25.000.000 de unidades.

**Límite semántico importante:** esto no es análisis sintáctico completo ni determina si la cláusula expresa verdad, creencia, memoria, hipótesis o discurso referido. Tampoco infiere propiedades a partir del contenido. Las formas verbales se reconocen mediante heurística morfológica acotada; por ello se requiere revisión editorial y evaluación con corpus literarios antes de usar los resultados como datos confirmados.

Se incorporan pruebas para una relativa explícita, offsets con emoji, rechazo de cláusula sin verbo finito, límites de oración y exceso de resultados. La ejecución debe confirmarse en CI.


## Extracción de aposiciones relacionales — 26 de noviembre de 2026

Se añade `discoverNarrativeRelationalAppositionCandidates` para localizar relaciones explícitas con un referente nominal registrado, por ejemplo «Bruno, hermano menor de Ana, volvió». La función conserva tres evidencias: la entidad ancla, la frase relacional completa y la mención del objetivo.

El objetivo solo se vincula si su texto coincide con un nombre canónico o alias registrado. Si la misma forma nominal corresponde a varias entidades, se conservan todos los IDs candidatos; no se selecciona uno arbitrariamente. Si no hay coincidencia registrada, no se emite una propuesta. Se excluye la entidad ancla de los posibles objetivos.

El vocabulario inicial cubre parentesco, vínculos sociales y algunos roles/títulos (hermano, hija, padre, compañera, amigo, maestro, jefe, capitán, rey, etc.). Admite hasta dos palabras modificadoras entre el núcleo relacional y «de» (por ejemplo, «hermano menor de»). Requiere coma de cierre del inciso. No interpreta por sí mismo la dirección social, el grado de parentesco, la verdad de la afirmación ni su vigencia temporal.

Límites: máximo 2.000 entidades, 100 alias por entidad, 256 unidades UTF-16 por nombre/alias, texto máximo 2.000.000, 2.000 propuestas y presupuesto de exploración agregado de 25.000.000. La extracción conserva offsets UTF-16 absolutos y falla explícitamente ante exceso de resultados.

Pruebas añadidas para parentesco explícito, objetivo ambiguo, objetivo no registrado y exceso de resultados. Pendiente de confirmación de ejecución en CI.
