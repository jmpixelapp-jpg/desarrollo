# Documentación

## Desarrollo y seguimiento

- [Registro acumulativo del monitor de autor](development/LIVE_AUTHOR_MONITOR_PROGRESS.md): historial de avances, commits, validaciones CI, estado y pendientes del monitoreo en tiempo real.\n- [Matriz de exactitud de observación](development/LIVE_AUTHOR_MONITOR_OBSERVABILITY_ACCURACY.md): niveles de evidencia, cobertura de operaciones, límites de inferencia, integridad de eventos y plan de pruebas de precisión.
- [Progreso del análisis literario e inteligencia narrativa](development/NARRATIVE_ANALYSIS_PROGRESS.md): entregas de análisis, integridad de sincronización, cobertura de pruebas y validación CI.
- [Integridad de payloads y sincronización narrativa](architecture/INTEGRIDAD_DE_PAYLOADS_Y_SINCRONIZACION_NARRATIVA.md): canonicalización JSON determinista, huellas de consistencia, límites de entrada y límites de seguridad.
- [Análisis de afirmaciones narrativas](architecture/ANALISIS_DE_AFIRMACIONES_NARRATIVAS.md): extracción conservadora de atributos con evidencia, offsets, revisiones y referencias temporales explícitas.\n- [Consistencia temporal de afirmaciones](architecture/CONSISTENCIA_TEMPORAL_DE_AFIRMACIONES.md): clasificación explicable de conflictos, evolución temporal y referencias incomparables.\n- [Grafo unificado de conocimiento narrativo](architecture/GRAFO_CONOCIMIENTO_NARRATIVO.md): composición de entidades, relaciones, eventos, ideas, afirmaciones y evidencias por proyecto.
- [Actualización incremental del grafo narrativo](architecture/GRAFO_CONOCIMIENTO_NARRATIVO_INCREMENTAL.md): snapshots por documento, invalidación selectiva y reutilización de contribuciones.
- [Persistencia del grafo narrativo](architecture/PERSISTENCIA_DEL_GRAFO_NARRATIVO.md): escritura CAS, recuperación desde documentos y límites de reconciliación.

## Integración con la aplicación anfitriona

- [Guía de integración TypeScript v1](integration/GUIA_INTEGRACION_ANFITRION_V1.md): arquitectura, identidades, edición en vivo, recuperación y consultas.
- [Puente entre procesos v1](integration/BRIDGE_PROCESS_PROTOCOL_V1.md): servidor compañero, cliente TypeScript, JSON-RPC por stdin/stdout, eventos, almacenamiento SQLite y cierre ordenado.
- [Especificaciones](specifications/): decisiones de arquitectura, contratos de almacenamiento y antecedentes técnicos.

La guía TypeScript es la referencia para el producto actual. El documento JSON-RPC de `specifications/` describe únicamente un prototipo histórico Rust; no usarlo como protocolo del runtime TypeScript.
