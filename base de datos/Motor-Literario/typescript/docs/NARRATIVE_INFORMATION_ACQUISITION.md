# Adquisición de información narrativa en tiempo real

## Objetivo del subsistema

El monitor debe convertir cambios del manuscrito en información narrativa útil y verificable. No basta con contar ediciones, guardar checkpoints o detectar palabras clave. La salida principal debe describir qué información aparece en el texto y mostrar exactamente dónde aparece.

## Contrato epistemológico obligatorio

Cada resultado debe pertenecer a una de estas capas, sin mezclarlas:

1. **Observado:** texto literal, revisión, documento y rango UTF-16.
2. **Extraído:** señal reconocida por una regla explícita y reproducible.
3. **Interpretado:** hipótesis sobre intención, emoción, causalidad, motivación o significado.
4. **Confirmado:** decisión explícita del autor o usuario.

Una regla automática no puede elevar un candidato a hecho confirmado. Toda afirmación debe enlazar evidencia; si no hay evidencia, no se presenta como dato.

## Flujo de adquisición actual

1. El editor anfitrión entrega `EditorChange` con offsets UTF-16 y secuencia.
2. El motor confirma y analiza el fragmento de líneas afectadas.
3. `HostEngineApi` publica resultados por revisión.
4. La extracción de conocimiento reconoce entidades, relaciones, acontecimientos y afirmaciones con reglas explícitas.
5. Los descubrimientos ligeros se entregan por callbacks para que la interfaz los represente sin confundirlos con registros confirmados.

## Descubrimientos implementados

### Ideas narrativas candidatas

Módulo: `src/narrative-idea-discovery.ts`

Reconoce señales lingüísticas explícitas para premisa, tema, conflicto, objetivo, pregunta hipotética, hipótesis y motivo. Conserva el texto literal capturado, categoría, confianza de la señal y evidencia. No pretende descubrir cualquier tema implícito ni resumir semánticamente una escena.

Callback: `onNarrativeIdeaCandidates(analysis, candidates)`.

### Contexto de análisis incremental

El análisis de acciones usa el snapshot del documento abierto cuando su revisión coincide exactamente con la revisión del resultado. Examina hasta 12.000 unidades UTF-16 a cada lado del fragmento afectado, conserva offsets absolutos y no mezcla revisiones. Si no existe un snapshot coherente, analiza solo el fragmento afectado. Esta ventana aporta contexto local y permite registrar algunos pronombres iniciales como referencias pendientes, pero todavía no resuelve identidad, concordancia ni referencias anafóricas complejas.

### Entidades explícitamente etiquetadas durante la ingesta

Cuando el anfitrión todavía no aporta fichas de entidades, la ingesta reconoce únicamente nombres precedidos por etiquetas explícitas del manuscrito, como «Personaje Ana», «Ciudad de Liria» u «Objeto Espada». Los resultados se devuelven en `entityCandidates` y se usan como contexto local para descubrir acciones en el mismo texto. No se persisten ni se consideran identidades confirmadas. Un nombre propio aislado como «Ana» no basta para crear una entidad. Si el anfitrión ya entrega entidades conocidas, estas conservan prioridad y no se generan duplicados automáticos.

### Complemento personal explícito

En patrones acotados como «Ana encontró a Bruno», la extracción puede señalar a Bruno como `personalObjectCandidate` cuando el nombre coincide exactamente con una entidad conocida y aparece inmediatamente después del verbo con la marca personal `a`. Se registra solo el complemento personal candidato, el marcador y la evidencia literal. No se afirma que el personaje sea ayudado, atacado, acompañado ni que exista otra relación semántica concreta: el verbo y el contexto completo siguen disponibles para revisión. La regla no intenta resolver complementos con nombres desconocidos, pronombres o construcciones más complejas.

La comprobación del límite entre el nombre conocido y el texto siguiente usa límites Unicode de letras, marcas y números. Esto evita aceptar un prefijo como «Ana» dentro de «Anabel» como sujeto. La regresión está cubierta junto con un segundo personaje mencionado en la misma frase.

### Roles gramaticales y agente explícito en voz pasiva

Las observaciones pueden conservar un sujeto gramatical candidato cuando el patrón local es inequívoco. En una pasiva como «Ana fue encontrada por Bruno», Ana es el sujeto gramatical paciente; no se etiqueta como quien ejecutó la acción. Si Bruno figura entre las entidades conocidas y coincide exactamente con el complemento «por Bruno», se expone `passiveAgentCandidate` con evidencia del nombre y el marcador `por`. La propuesta no se convierte en hecho confirmado. Si el agente no coincide con una entidad registrada, queda sin resolver. La construcción «por» no se interpreta fuera de este patrón pasivo.

### Acontecimientos declarados explícitamente

La ingesta expone `eventCandidates` usando `extractNarrativeEvents`. Solo reconoce líneas etiquetadas `ACONTECIMIENTO:` o `EVENTO:`; no transforma automáticamente una secuencia de acciones en un acontecimiento. Los participantes se sugieren por coincidencia textual con entidades conocidas o entidades etiquetadas en el mismo texto. La coincidencia no determina quién actuó, quién sufrió la acción ni quién presenció el hecho. Cada acontecimiento conserva su evidencia y sus offsets absolutos. La etiqueta y los participantes siguen sujetos a revisión.

### Acciones narrativas candidatas

Módulo: `src/narrative-observation-discovery.ts`

Reconoce un vocabulario controlado de acciones en frases que mencionan personajes previamente identificados. Devuelve verbo normalizado, forma superficial, evidencia exacta del verbo (`actionEvidence`) y evidencia contextual de toda la oración (`evidence`), clasificación morfológica del tiempo verbal (pretérito, imperfecto, presente, infinitivo, gerundio o participio), personajes y otras entidades mencionadas, polaridad afirmada/negada y frase probatoria. El tiempo verbal no se convierte en fecha ni en orden cronológico global.

Reglas de prudencia:
- Las etiquetas de clasificación (por ejemplo, «Personaje» o «Ciudad») admiten mayúscula inicial; los nombres propios extraídos siguen exigiendo inicial mayúscula para evitar convertir sustantivos comunes en identidades.
- Solo vincula nombres canónicos o alias confirmados.
- Si aparece un solo personaje conocido, conserva su ID como única mención. Solo propone sujeto gramatical cuando el nombre abre la frase y el patrón inmediato antes del verbo es explícito; conserva evidencia del nombre y distingue voz activa/pasiva. Este candidato sintáctico no equivale a agente semántico ni a hecho confirmado.
- No atribuye sujeto cuando el personaje aparece como complemento, después del verbo o en estructuras que el patrón limitado no reconoce.
- Si aparecen varios personajes, conserva todos como mencionados y deja el actor sin resolver.
- La presencia de una entidad en una frase no demuestra que sea objeto directo o destinatario.
- La negación explícita se conserva; "no abrió" nunca se transforma en una acción afirmada.
- La clasificación morfológica verbal describe solo la forma escrita; no deduce fechas, orden de acontecimientos ni tiempo del mundo narrativo.
- Los pronombres iniciales explícitos (él/ella/ellos/ellas) se registran como referencias pendientes; se conserva el tramo literal del pronombre con offsets exactos, la frase anterior como evidencia y los posibles antecedentes como candidatos, sin resolver identidad automáticamente.
- No se infieren emociones, motivaciones, causalidad ni cronología.

Callback: `onNarrativeObservationCandidates(analysis, candidates)`.

### Relaciones candidatas entre acciones

Módulo: `src/narrative-action-link-discovery.ts`

Relaciona únicamente dos observaciones consecutivas del mismo documento y revisión cuando entre sus verbos aparece un marcador textual explícito temporal, causal o de contraste. Conserva los IDs de ambas acciones y el tramo exacto del conector. Limita la distancia entre verbos y valida que cada evidencia del verbo coincida con el texto fuente.

Un marcador como «porque» se registra como `markerKind: "causal"`, pero el módulo no decide qué acción es causa o consecuencia. Sin conector explícito no crea vínculo, aunque las acciones aparezcan próximas. Los resultados permanecen como candidatos para revisión. La ingesta de libro los expone en `result.actionLinks` junto con las observaciones de acción, sin exigir una fase de persistencia ni confirmar relaciones.

## Limitaciones conocidas que deben guiar el siguiente trabajo

- El vocabulario verbal es deliberadamente finito y debe ampliarse con pruebas por idioma y morfología. Se han cubierto algunas formas de imperfecto plural y participios irregulares («abierta/abierto»), pero no existe todavía conjugación completa ni análisis morfológico general.
- La extracción actual de entidades nuevas depende de expresiones de identificación explícitas (por ejemplo, "personaje Ana"). Una mención aislada de nombre propio no basta para crear una ficha automáticamente.
- El callback de acciones consulta una ventana contextual de hasta 12.000 unidades UTF-16 alrededor del cambio, únicamente si el snapshot abierto coincide con la revisión analizada; mantiene offsets absolutos y usa el fragmento afectado como fallback.
- El callback de acciones se ejecuta después de la extracción de conocimiento en el flujo que requiere un adaptador con `saveEntity` y `loadEntities`; sin ese contrato de almacenamiento, el flujo actual de extracción narrativa no se activa.
- Los eventos de la base actual requieren marcadores explícitos `EVENTO:` o `ACONTECIMIENTO:`; no se debe confundir esa extracción editorial con comprensión libre de acontecimientos narrados.
- Las relaciones se reconocen con patrones explícitos limitados; la ausencia de una relación extraída no prueba que no exista.
- El análisis de estados emocionales, objetivos implícitos, causalidad y evolución psicológica requiere candidatos separados, evidencias múltiples y validación humana.

## Próximas fases prioritarias

1. **Contexto coherente de escena:** aportar a cada análisis un contexto acotado de frases anteriores/posteriores del snapshot de la misma revisión, sin perder los offsets globales.
2. **Menciones de personajes:** generar candidatos de nombres propios no registrados, resolver ambigüedades y solicitar confirmación antes de crear identidades.
3. **Referencias pronominales:** ampliar resolución de él/ella/ellos/ellas y pronombres clíticos con concordancia, distancia, diálogo y ambigüedad; nunca enlazar identidades sin evidencia suficiente.
4. **Acciones con sujeto gramatical:** ampliar patrones conservadores para concordancia, coordinación, diálogo y voz pasiva; el patrón inicial actual es deliberadamente limitado y no asigna agente semántico.
5. **Acontecimientos narrados:** detectar secuencias de acciones y participantes sin exigir etiquetas editoriales, manteniendo cada evento como candidato con evidencia.
6. **Estados y emociones:** distinguir percepción, pensamiento, emoción, diálogo y acción; preservar negación, modalidad, tiempo y punto de vista.
7. **Continuidad y contradicciones:** comparar afirmaciones explícitas entre revisiones/documentos y presentar pares de evidencia incompatibles, nunca un veredicto automático.
8. **Evaluación real:** corpus de escenas en español con casos positivos, negativos, diálogo, nombres ambiguos, pronombres, negaciones, tiempos verbales y ediciones parciales; medir precisión y recall por categoría antes de ampliar automatismos.

## Criterios de aceptación

- Toda salida tiene proyecto, documento, revisión y evidencia literal.
- Los rangos son offsets UTF-16 absolutos y se prueban con caracteres acentuados y emojis.
- Las entidades se aíslan por proyecto.
- No se inventan sujetos, destinatarios, estados mentales ni causas.
- Una revisión posterior puede retirar o reemplazar candidatos obsoletos.
- La escritura y la persistencia durable nunca dependen de que un descubrimiento narrativo tenga éxito.
- La interfaz distingue visualmente observado, candidato, interpretación y confirmado.
- Las pruebas de extracción se ejecutan junto con la suite principal del paquete.

## Regla de producto

El éxito del monitor no se mide por cuántos registros guarda. Se mide por cuánta información narrativa correcta puede obtener del texto que el autor acaba de escribir, con evidencia que permita comprobar cada resultado.

### Offsets exactos de acciones durante la ingesta

Las observaciones de acción del módulo de descubrimiento conservan un campo `actionEvidence` con el rango exacto del token verbal. Las señales generales de ingesta mantienen una ventana contextual alrededor del verbo; esa evidencia contextual permite ubicar el token dentro del texto fuente original, incluido un BOM UTF-8. No deben confundirse ambos contratos: uno sirve para atribución precisa de la acción y el otro para revisión contextual.

## Relaciones dirigidas explícitas: transferencia

En `src/narrative-observation-discovery.ts`, las acciones de transferencia `entregar` pueden producir `directedRelationCandidate` únicamente cuando coinciden todas estas condiciones en la misma oración:

- sujeto gramatical candidato con patrón activo inequívoco;
- una entidad de tipo objeto mencionada como complemento directo;
- un personaje identificado como destinatario mediante el complemento explícito `a + nombre`;
- emisor y destinatario distintos.

La relación se etiqueta como `transfers-to` y conserva evidencias separadas del sujeto, objeto, destinatario y verbo. Sigue siendo candidata y nunca se confirma automáticamente. No se genera con sujeto pasivo, destinatario ausente, objeto no identificado o roles ambiguos. La negación se conserva en la observación y no debe interpretarse como una transferencia afirmada; la relación candidata requiere una acción no negada.

Esta primera regla es deliberadamente estrecha: no generaliza el patrón a verbos como ayudar, atacar o hablar. Tampoco resuelve destinatarios implícitos ni referencias anafóricas. Los tests cubren el caso afirmativo y rechazan negación y estructuras incompletas/pasivas.

## Detección incremental en fragmentos mientras se escribe

El descubrimiento de acciones analiza también el último fragmento aunque todavía no tenga punto, signo de interrogación o cierre de párrafo. Una forma verbal completa puede producir un candidato provisional inmediatamente; una forma incompleta (por ejemplo, `corri`) no debe convertirse en acción. La evidencia mantiene offsets UTF-16 absolutos, incluidos los desplazamientos de `baseOffset`.

Esta detección no afirma que la oración esté terminada. La interfaz debe presentar el resultado como candidato revisable y sustituirlo al llegar una revisión posterior del texto. Se añadieron pruebas para una forma verbal completa sin puntuación y para un verbo todavía incompleto.

## Interacciones dirigidas entre personajes

El descubrimiento de observaciones puede proponer `directedInteractionCandidate` para cuatro patrones activos y explícitos:

| Verbo | Relación candidata | Papel del segundo personaje |
|---|---|---|
| atacar | `attacks` | objetivo |
| ayudar | `helps` | beneficiario |
| proteger | `protects` | protegido |
| salvar | `saves` | beneficiario |

La regla exige un sujeto gramatical activo identificado al inicio de la oración y un segundo personaje explícito en el complemento `a + nombre`. Emisor y destino deben ser distintos. Cada candidato conserva evidencia separada del sujeto, destino y forma verbal. No se emite con negación, pasiva, destino ausente o identidad coincidente.

Estos papeles son etiquetas operativas de extracción, no conclusiones definitivas sobre motivaciones, consentimiento, éxito o consecuencias. Por ejemplo, `Ana intentó salvar a Bruno` no demuestra que Bruno haya sido salvado: el patrón léxico actual solo registra la acción verbal y el participante como beneficiario candidato. Todas las relaciones siguen con `reviewStatus: candidate`.

### Transiciones candidatas de objetos en la ingesta

La ingesta de libro ahora publica `objectTransitionCandidates`, calculadas a partir de las observaciones de acciones de la misma revisión. Se reutiliza el módulo `src/narrative-object-state-discovery.ts` y su vocabulario deliberadamente limitado: encontrar, perder, entregar y recibir, siempre con una entidad de objeto identificada en el complemento directo y los roles gramaticales exigidos por cada patrón.

Esto conecta la extracción de acciones con información útil de escena: qué objeto aparece en una acción de descubrimiento, pérdida, entrega o recepción y qué personajes están explícitamente identificados como actor o receptor. No crea un inventario ni afirma quién conserva el objeto después de la acción. La negación se marca como `not-applied`, el futuro como `prospective` y el resto como `candidate`; ninguna de esas salidas se confirma automáticamente.

La ingesta conserva las evidencias exactas del verbo, objeto y participantes con documento, revisión y offsets UTF-16 absolutos. Si no hay una entidad de objeto reconocida, no se inventa una transición a partir de un nombre común aislado. Los tests cubren una entrega con emisor y receptor explícitos, offsets desplazados por `baseOffset` y ausencia de transición cuando falta una ficha de objeto.

### Cambios explícitos de condición de objetos

La detección de trayectorias distingue ahora cambios de condición, además de descubrimiento, pérdida, entrega y recepción. Con una entidad de tipo objeto identificada y un sujeto activo candidato, reconoce estas clases verbales:

| Verbo explícito | Transición candidata |
|---|---|
| abrir / cerrar | `opened` / `closed` |
| romper / reparar | `broken` / `repaired` |
| destruir | `destroyed` |
| activar / desactivar | `activated` / `deactivated` |

La extracción conserva la forma verbal exacta, el objeto identificado, el sujeto candidato y el contexto completo. Mantiene la polaridad y el tiempo gramatical: una acción negada produce `not-applied`; una forma futura produce `prospective`. No convierte automáticamente un participio adjetival aislado (por ejemplo, «la puerta está rota») en una acción ejecutada por un personaje.

Estas etiquetas describen el tipo de cambio expresado por el verbo, no un estado global confirmado. «Intentó romper la espada» no demuestra que la espada se rompiera; «reparó la espada» no demuestra que quedara completamente funcional. Los resultados permanecen como candidatos y necesitan validación contextual. Se añadieron pruebas para los siete verbos, evidencia exacta y offsets, negación y futuro.

#### Protección frente a intentos, deseos y posibilidades

La presencia de un verbo de cambio no basta para concluir que el cambio se ejecutó. Las construcciones subordinadas como «Ana intentó romper la espada», «Ana quiso abrirla», «Ana podría destruirla» o «Ana no pudo activarla» no deben convertirse en una transición consumada: el sujeto de la acción subordinada no se atribuye como si el verbo principal no existiera. Se añadieron casos negativos para evitar esa falsa actualización.

El clasificador de efecto también conserva estados no concluyentes para formas no finitas o en desarrollo (`attempted`, `intended`, `hypothetical`, `in-progress`, `unresolved`) cuando el contexto de evidencia permite identificarlas. Solo `candidate` representa una acción finita afirmada pendiente de revisión; no equivale a éxito ni a estado confirmado. La negación y el futuro mantienen prioridad (`not-applied` y `prospective`).

## Afirmaciones explícitas de condición de personajes

Se incorpora `narrative-character-state-discovery.ts` para capturar estados descritos directamente por el autor. La regla requiere una ficha de personaje conocida, una mención nominal inequívoca y una construcción copulativa explícita con un predicado incluido en el vocabulario controlado. La primera cobertura incluye: herido, vivo, muerto, consciente, inconsciente, atado, libre, enfermo, sano, desaparecido y presente.

El resultado `characterStateCandidates` se integra en la ingesta del libro. Cada candidato conserva por separado:

- identidad mencionada;
- predicado de estado;
- cópula y modificadores;
- fragmento completo de evidencia;
- polaridad afirmada o negada;
- tiempo gramatical;
- aspecto ordinario, continuo, recurrente o cesativo;
- modo copulativo o perceptual.

Ejemplos de distinciones preservadas:

| Texto | Interpretación candidata |
|---|---|
| Ana está herida | estado herido afirmado, presente |
| Ana ya no está herida | estado herido negado, presente |
| Ana dejó de estar enferma | estado enfermo negado, cesación |
| Ana volvió a estar herida | estado herido afirmado, recurrencia |
| Ana estaba viva | estado vivo afirmado, pasado |
| Ana estará libre | estado libre afirmado, futuro |
| Ana parece consciente | percepción, no certeza objetiva |

La extracción no confunde «Bruno encontró a Ana herida» con «Ana está herida»: exige la cópula junto al nombre. Tampoco resuelve «ella», ni selecciona arbitrariamente entre dos fichas que comparten el mismo nombre. Un adjetivo aislado o el estado de un objeto no genera una afirmación de personaje.

Los estados no se consolidan ni se sobrescriben entre sí. Dos afirmaciones distintas pueden corresponder a momentos diferentes, una corrección del autor o una contradicción real; decidirlo exige cronología y contexto narrativo. Los offsets UTF-16 absolutos y la revisión de origen permiten reconstruir esa procedencia. La cobertura es deliberadamente explícita y extensible: los estados no incluidos no se inventan ni se fuerzan a una categoría aproximada.

La taxonomía se amplió para separar estados vitales, físicos, cognitivos, emocionales, sociales, de ubicación y otros cambios descritos explícitamente. La cobertura inicial incluye también dormido/despierto, agotado, asustado, enfadado, tranquilo, embarazada, encarcelado, envenenado, ciego, sordo, mudo, paralizado, transformado, atrapado, ausente, perdido y protegido. Cada salida incorpora `category`; el vocabulario es extensible y no pretende reducir todos los estados posibles a una lista cerrada.

La categoría no se usa para inferir estados ausentes. Por ejemplo, que un personaje haya sido atacado no basta para clasificarlo como herido: hace falta una afirmación copulativa explícita respaldada por el texto. Las formas masculinas/femeninas y singulares/plurales contempladas se reconocen sin alterar el fragmento original de evidencia.

### Publicación por revisión durante la escritura

La extracción de condiciones de personajes ya no queda limitada a la ingesta de un libro. `HostEngineApi` la ejecuta también dentro del flujo de análisis de cada edición admitida, después de reconciliar el conocimiento y de construir una ventana contextual coherente con la revisión analizada. La ventana y sus evidencias mantienen offsets absolutos mediante `baseOffset`.

La aplicación anfitriona recibe `onNarrativeCharacterStateCandidates(analysis, candidates)`. El callback se emite por revisión, incluso cuando la lista queda vacía, para que la interfaz pueda retirar candidatos de una frase que el autor corrigió. Un error del callback no bloquea la escritura, la cola del motor ni la publicación de observaciones de acciones. No se entrega una revisión mezclada: si no existe snapshot con la misma revisión, se usa únicamente el fragmento afectado.

