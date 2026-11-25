# Documentación

## Integración con la aplicación anfitriona

- [Guía de integración TypeScript v1](integration/GUIA_INTEGRACION_ANFITRION_V1.md): arquitectura, identidades, edición en vivo, recuperación y consultas.
- [Puente entre procesos v1](integration/BRIDGE_PROCESS_PROTOCOL_V1.md): servidor compañero, cliente TypeScript, JSON-RPC por stdin/stdout, eventos, almacenamiento SQLite y cierre ordenado.
- [Especificaciones](specifications/): decisiones de arquitectura, contratos de almacenamiento y antecedentes técnicos.

La guía TypeScript es la referencia para el producto actual. El documento JSON-RPC de `specifications/` describe únicamente un prototipo histórico Rust; no usarlo como protocolo del runtime TypeScript.
