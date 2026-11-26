# Marcos epistémicos en la extracción de acciones — 26 de noviembre de 2026

## Objetivo
Evitar que el motor convierta automáticamente en hechos del mundo narrativo acciones que aparecen dentro de pensamientos, recuerdos, deseos, hipótesis o afirmaciones de personajes.

## Implementación
Cada observación de acción incorpora `epistemicFrame`:
- `narrator-asserted`: no se detecta un introductor epistémico local.
- `character-belief`: contenido tras marcadores como «creyó que» o «pensó que».
- `character-memory`: contenido tras «recordó que».
- `character-desire`: contenido tras «deseaba que» o «quería que».
- `reported-speech`: contenido tras «dijo que» o «afirmó que».
- `hypothetical`: contenido introducido por «si», «quizá», «tal vez» y señales próximas.

Cuando existe un disparador se conserva `epistemicFrameEvidence` con offsets absolutos y fragmento literal.

## Límites semánticos
La clasificación es una señal local basada en patrones léxicos, no un análisis completo de subordinación, alcance, modalidad o atribución de voz. El marco más próximo puede ser incorrecto en frases complejas, ironía, discurso indirecto libre o citas anidadas. Por eso las observaciones siguen siendo candidatas revisables; el marco no confirma ni niega que el acontecimiento ocurriera.

## Cobertura de regresión
Se añaden casos para creencia, memoria, deseo, discurso referido, hipótesis y narración sin introductor. Se verifica la correspondencia exacta de la evidencia del disparador con el texto.
