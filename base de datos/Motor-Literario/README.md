# Motor Literario

## Implementación oficial

La implementación definitiva del producto se desarrolla en `typescript/` con TypeScript y JavaScript. Esta es la única línea de implementación que debe ampliarse para el producto.

- `typescript/src/`: núcleo propio, contratos de integración, monitoreo y análisis.
- `typescript/src/persistence/`: persistencia local mediante API nativa de la plataforma.
- `typescript/package.json`: herramientas de compilación y desarrollo.
- `docs/specifications/`: decisiones y contratos históricos que deben adaptarse a TypeScript antes de considerarse vigentes.
- `database/legacy/`: formatos y paquetes históricos preservados como referencia.

## Estado del código Rust anterior

Las carpetas `engine/` y `storage/` contienen un prototipo histórico desarrollado en Rust. No forman parte del runtime definitivo, no deben recibir nuevas funcionalidades del producto y no deben presentarse como implementación final. Sus decisiones de diseño solo pueden utilizarse como referencia para implementaciones propias en TypeScript.

## Principios no negociables

- El motor lingüístico, la corrección, la extracción y el análisis literario son desarrollo propio.
- No se incorporan motores, bibliotecas especializadas ni servicios externos en tiempo de ejecución.
- TypeScript/Vite, Capacitor y Electron son herramientas de construcción y empaquetado, no dependencias intelectuales del motor.
- Los manuscritos y el conocimiento de cada obra permanecen localmente y aislados por proyecto.
- La identidad del proyecto la proporciona la aplicación anfitriona.
- El motor analiza y sugiere; nunca modifica el manuscrito por iniciativa propia.
- El monitoreo continuo del escritor es la prioridad arquitectónica número uno.

## Núcleo TypeScript inicial

Desde `typescript/`:

```sh
npm install
npm run typecheck
npm run build
```

La primera entrega TypeScript incluye contratos tipados, admisión de cambios mediante cola acotada, sesiones de documentos con revisión/secuencia, persistencia local IndexedDB y reglas deterministas iniciales de corrección.

## Límites actuales

El núcleo inicial todavía no equivale al producto completo. Faltan pruebas automatizadas amplias, mediciones reales de latencia, recuperación transaccional avanzada, adaptadores nativos específicos, extracción narrativa automática, resolución de entidades, cronología, contradicciones, historial de conocimiento y biblioteca personal de ideas. No utilizar todavía con manuscritos importantes sin copias de seguridad y validación de recuperación.
