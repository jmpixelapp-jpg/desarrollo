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