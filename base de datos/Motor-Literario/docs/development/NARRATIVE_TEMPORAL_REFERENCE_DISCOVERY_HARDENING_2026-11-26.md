# Endurecimiento de extracción de referencias temporales — 26 de noviembre de 2026

## Cambio

El descubrimiento temporal ya limitaba el texto de entrada a 2.000.000 de unidades UTF-16 y la salida aceptada a 500 candidatos. Sin embargo, las expresiones regulares podían acumular una cantidad mucho mayor de coincidencias intermedias antes de aplicar el límite público.

Se introduce `MAX_NARRATIVE_TEMPORAL_DISCOVERY_MATCHES = 20_000` como presupuesto interno de coincidencias. Cada patrón deja de acumular coincidencias al alcanzar el presupuesto. El límite público de 500 candidatos y las reglas de prioridad/solapamiento se conservan.

## Garantías preservadas

- No se resuelven fechas relativas sin un ancla narrativa.
- Se mantienen los offsets UTF-16 absolutos y la evidencia literal.
- No se altera el texto fuente.
- Se conserva la validación de contexto y el límite de 2.000.000 de unidades.
- La salida continúa limitada a 500 candidatos.

## Validación

Se añade una regresión con un texto artificial densamente poblado de referencias numéricas. Comprueba el límite público y la correspondencia exacta entre offsets, superficie y texto original.

**Nota:** el presupuesto interno limita memoria y trabajo intermedio en entradas adversariales o muy repetitivas; no equivale a una garantía de exhaustividad cuando se supera el presupuesto. Para corpus que requieran exhaustividad total, se deberá procesar por segmentos con offsets absolutos y agregación determinista.
