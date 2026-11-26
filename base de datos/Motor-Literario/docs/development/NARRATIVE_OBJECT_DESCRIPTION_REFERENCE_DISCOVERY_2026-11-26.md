# Referencias descriptivas de objetos

## Objetivo

`discoverNarrativeObjectDescriptionReferences` busca en el texto las etiquetas descriptivas registradas para entidades de tipo `object`. Permite recuperar menciones como «el arma», «la reliquia» o «el volumen» cuando esas expresiones ya han sido asociadas explícitamente al perfil del objeto mediante evidencia revisable.

## No realiza sinonimia automática

El módulo no deduce que «espada» equivale a «arma», ni que «joya» equivale a «reliquia». La equivalencia debe llegar como etiqueta validada en el perfil. Si dos objetos comparten una descripción, se devuelven ambos candidatos con estado `ambiguous`; no se selecciona uno por proximidad.

## Procedencia

Cada resultado conserva evidencia literal de la mención y evidencia histórica de la etiqueta descriptiva. Las evidencias obsoletas no autorizan nuevas asociaciones. La identidad del objeto no se fusiona ni se modifica.

## Límites

Texto máximo 2 millones de unidades UTF-16; 5.000 perfiles; 100 etiquetas por perfil; 20.000 etiquetas agregadas; 25 millones de unidades de exploración; 5.000 resultados. Los offsets se expresan en unidades UTF-16 y admiten `baseOffset`.
