# Extracción de atributos físicos de objetos

## API

`discoverNarrativeObjectAttributeCandidates(input)` extrae descriptores literales próximos a nombres canónicos y alias explícitos de objetos.

## Taxonomía inicial

- `color`: rojo, azul, dorado, plateado, etc.
- `material`: oro, plata, hierro, acero, madera, cuero, cristal, etc.
- `condition`: roto, intacto, dañado, oxidado, abierto, cerrado, etc.
- `shape`: circular, cuadrado, ovalado, curvo, afilado, etc.
- `size`: pequeño, grande, enorme, largo, corto, ancho, etc.

## Interpretación conservadora

Cada atributo conserva evidencia independiente del objeto y del contexto. La negación local explícita se registra como polaridad. El resultado no implica que el atributo sea permanente, verdadero en el mundo narrativo, ni que se mantenga entre capítulos. No se resuelven sinónimos, metáforas, concordancias complejas, atributos separados por cláusulas ni correferencias.

## Límites

Texto: 2.000.000 unidades UTF-16; 5.000 entidades; 100 alias por entidad; nombres de hasta 256 caracteres; exploración: 25.000.000 unidades; resultados: 5.000. Los offsets son UTF-16 absolutos y admiten `baseOffset`.
