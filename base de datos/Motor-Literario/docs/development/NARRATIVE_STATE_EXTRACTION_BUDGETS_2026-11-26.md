# Presupuestos y validación de extracción de estados

La extracción de estados ahora valida el tamaño de la lista de entidades, el número y longitud de alias por entidad y el coste agregado estimado de recorrer las frases contra los nombres disponibles. El presupuesto de búsqueda es de 25.000.000 unidades de análisis; si se excede, se produce un error explícito y no se devuelven resultados parciales.

Los límites configurados son: 5.000 entidades, 100 alias por entidad, 256 unidades UTF-16 por nombre o alias y 200 candidatos de estado. Se rechazan alias vacíos y entradas fuera de límites antes de iniciar el análisis.

La reconstrucción de transiciones valida además que la evidencia de la fuente epistémica pertenezca al mismo documento y revisión y esté contenida en el fragmento probatorio de la afirmación. También valida el vocabulario del marco epistémico.

Las pruebas añadidas cubren alias inválidos, exceso de entidades, presupuesto agregado y evidencia de emisor fuera del pasaje. Los límites son defensas operativas; no convierten las heurísticas lingüísticas en análisis sintáctico ni garantizan exhaustividad semántica.
