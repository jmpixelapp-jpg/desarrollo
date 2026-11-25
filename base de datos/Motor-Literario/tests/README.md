# Pruebas del Motor Literario

Las pruebas unitarias de cada módulo viven junto al código Rust. Esta carpeta se reserva para pruebas de integración y validación transversal entre módulos.

Criterios obligatorios antes de habilitar datos reales:
- aislamiento estricto por `project_id`;
- atomicidad y rollback de operaciones;
- recuperación tras cierre abrupto y escrituras parciales;
- concurrencia entre procesos;
- migraciones verificadas y reversibles;
- sincronización incremental e idempotencia;
- orden FIFO, backpressure y confirmación durable de la cola del editor;
- aislamiento de documentos con IDs iguales entre proyectos distintos;
- integración del anfitrión: apertura, envío de deltas, snapshot, resincronización y checkpoint;
- percentiles móviles de latencia de commits exitosos;
- latencia del monitoreo continuo medida en escenarios reales.
