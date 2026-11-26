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

### Acciones narrativas candidatas

Módulo: `src/narrative-observation-discovery.ts`

Reconoce un vocabulario controlado de acciones en frases que mencionan personajes previamente identificados. Devuelve verbo normalizado, forma superficial, evidencia exacta del verbo (`actionEvidence`) y evidencia contextual de toda la oración (`evidence`), clasificación morfológica del tiempo verbal (pretérito, imperfecto, presente, infinitivo, gerundio o participio), personajes y otras entidades mencionadas, polaridad afirmada/negada y frase probatoria. El tiempo verbal no se convierte en fecha ni en orden cronológico global.

Reglas de prudencia:
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

## Limitaciones conocidas que deben guiar el siguiente trabajo

- El vocabulario verbal es deliberadamente finito y debe ampliarse con pruebas por idioma y morfología.
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
