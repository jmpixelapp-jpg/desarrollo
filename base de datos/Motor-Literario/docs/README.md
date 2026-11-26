# Documentación

## Desarrollo y seguimiento

- [Registro acumulativo del monitor de autor](development/LIVE_AUTHOR_MONITOR_PROGRESS.md): historial de avances, commits, validaciones CI, estado y pendientes del monitoreo en tiempo real.
- [Integridad de payloads y sincronización narrativa](architecture/INTEGRIDAD_DE_PAYLOADS_Y_SINCRONIZACION_NARRATIVA.md): canonicalización JSON determinista, huellas de consistencia, límites de entrada y límites de seguridad.

## Integración con la aplicación anfitriona

- [Guía de integración TypeScript v1](integration/GUIA_INTEGRACION_ANFITRION_V1.md): arquitectura, identidades, edición en vivo, recuperación y consultas.
- [Puente entre procesos v1](integration/BRIDGE_PROCESS_PROTOCOL_V1.md): servidor compañero, cliente TypeScript, JSON-RPC por stdin/stdout, eventos, almacenamiento SQLite y cierre ordenado.
- [Especificaciones](specifications/): decisiones de arquitectura, contratos de almacenamiento y antecedentes técnicos.

La guía TypeScript es la referencia para el producto actual. El documento JSON-RPC de `specifications/` describe únicamente un prototipo histórico Rust; no usarlo como protocolo del runtime TypeScript.
