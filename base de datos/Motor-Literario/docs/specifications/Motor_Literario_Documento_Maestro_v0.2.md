# MOTOR LITERARIO
## Documento Maestro de Especificaciones
**Versión:** 0.2 — reconstrucción consolidada para implementación  
**Estado:** Especificación funcional y arquitectónica para Codex

---

## 1. Propósito

Motor Literario es un motor independiente de análisis, corrección y asistencia literaria. Tendrá una edición independiente y otra integrada en una aplicación anfitriona mediante una API propia. El anfitrión administra interfaz, editor, navegación y presentación; el motor administra análisis, conocimiento narrativo, persistencia y sincronización.

Principio rector: **el motor advierte; el escritor decide**. Nunca modificar el manuscrito automáticamente.

## 2. Principios obligatorios

- Desarrollo original desde cero. No incorporar código, bibliotecas, frameworks, motores lingüísticos, modelos de IA, diccionarios, gramáticas ni bases lingüísticas de terceros.
- Coste de licencias, servicios y funcionamiento: 0 USD.
- Se permiten herramientas de desarrollo, compiladores, SDK oficiales y APIs nativas documentadas, previa revisión de sus condiciones.
- No implementar criptografía propia: utilizar APIs criptográficas nativas.
- El procesamiento literario ordinario es local. No enviar manuscritos ni datos privados a servicios externos.
- No uniformar el estilo ni simplificar la voz del autor.
- No confundir contradicciones con errores: pueden ser misterios, mentiras, secretos, recuerdos, narradores no fiables, paradojas o decisiones artísticas.
- El anfitrión proporciona la identidad del proyecto; el motor no inventa IDs ni nombres.

## 3. Propiedad y privacidad

El propietario del Motor Literario es dueño del motor, código, arquitectura, algoritmos y mejoras generales. Cada escritor conserva la propiedad de su manuscrito y de toda información específica de sus obras: personajes, tramas, ideas, universos, idiomas, diccionarios, hechos y secretos.

El motor procesa las obras para asistir al escritor. No utiliza textos para entrenar sistemas externos ni los comparte. Las mejoras generales no pueden contener información privada que permita reconstruir o identificar una obra. Si no puede garantizarse la separación, la contribución no se transmite.

## 4. Ediciones y plataformas

- Edición independiente, gratuita y con interfaz propia.
- Edición integrada en una aplicación anfitriona.
- Ambas comparten el mismo núcleo literario.
- Plataformas objetivo: Windows, Linux, macOS, Android e iOS.
- En escritorio puede utilizarse un proceso independiente con comunicación local. En móviles se respetan las restricciones del sistema; no prometer procesos persistentes independientes donde la plataforma no los permita.
- Rust fue considerado como candidato, pero no debe tratarse como decisión irrevocable sin validar compatibilidad, herramientas y plataformas.

## 5. Arquitectura y responsabilidades

### Motor
Administra análisis lingüístico y literario, correcciones, sugerencias, conocimiento narrativo, entidades, relaciones, cronologías, universos, perfiles lingüísticos, recursos propios, bases de datos, sincronización, tareas, eventos y actualizaciones.

### Aplicación anfitriona
Administra creación y nombre del libro, editor, interfaz, vistas, navegación, búsquedas, presentación y aceptación/rechazo de sugerencias. Crea el proyecto y transmite al motor el identificador y nombre.

### Integración
API propia; JSON es el formato externo inicial. Parser y serializador propios, sin bibliotecas externas. Cada contrato debe definir parámetros, tipos, límites, respuestas, errores, permisos, efectos, idempotencia y compatibilidad.

Operaciones iniciales: initialize, status, get_capabilities, create_project, open_project, close_project, update_project, analyze, correct, review, generate, language, universe, get_job, cancel_job y shutdown. Ampliar para sesiones, sincronización, eventos, audio, SCN, fichas, cronología, evidencias, diccionarios y biblioteca de ideas.

Documentación requerida: API_REFERENCE.md, REQUEST_FORMAT.md, RESPONSE_FORMAT.md, ERROR_CODES.md, INTEGRATION_GUIDE.md, PLATFORM_GUIDE.md, VERSIONING.md, EXAMPLES.md, CHANGELOG.md y SECURITY.md.

## 6. Corrector lingüístico y literario

### Comprensión
Analizar desde una palabra hasta un libro completo: significado contextual, narración, diálogos, descripciones, pensamientos, ironía, metáforas, ambigüedad, dobles sentidos y evolución narrativa.

### Corrección en vivo
Ortografía, tildes, gramática, concordancia, puntuación, sintaxis, uso de palabras, tiempos verbales, mayúsculas, convenciones, repeticiones, vocabulario, claridad, fluidez y naturalidad.

### Revisión editorial
Diálogos, narración, descripción, ritmo, voz del autor, capítulos, transiciones, tipografía y preparación editorial.

### Multilingüismo
Varios idiomas simultáneos; detección automática; variantes regionales; perfiles por idioma; convenciones editoriales; palabras extranjeras, inventadas y nombres propios no deben marcarse automáticamente como errores. No traducir todo a una lengua intermedia. La cobertura de cada idioma crece progresivamente y se valida; no prometer nivel profesional universal desde el inicio.

### Diccionarios e idiomas propios
Perfiles por libro con idioma principal/secundarios, variante, normativa, preferencias editoriales, idiolecto y conlangs. Diccionarios propios por libro e idioma con escritura, significado, pronunciación, categoría gramatical y atributos. Palabras nuevas provisionales; al confirmarlas el escritor, dejan de marcarse como desconocidas. Admitir idiomas ficticios ocasionales o completos.

### Estilo
Sinónimos contextuales, antónimos, expresiones y alternativas. Análisis de diálogos, voces, narración, punto de vista, tiempos, género y estructura sin uniformar el estilo ni reescribir automáticamente.

### Presentación
El motor devuelve fragmentos y posiciones exactas; el anfitrión dibuja las marcas. Referencia visual sugerida: rojo para ortografía, azul para gramática y marcas diferenciadas para puntuación y sintaxis. Correcciones sencillas discretas; hallazgos complejos agrupados, sin sonidos ni ventanas intrusivas.

## 7. SCN: conocimiento narrativo universal

No utilizar un catálogo cerrado de tipos, atributos o relaciones. Admitir personajes, lugares, objetos, tramas, naciones, mundos, especies, culturas, religiones, organizaciones, idiomas y cualquier clase futura.

Cada entidad tiene ID único, proyecto, nombre, tipo dinámico, atributos, relaciones, evidencias, ubicaciones, procedencia, confianza, historial y estado. Las relaciones son registros independientes con ID, tipo, origen, destino, atributos, evidencias, ubicaciones e historial.

### Etiquetas y estados
Etiquetas:
- **IDEA:** elemento planificado o creado sin correspondencia confirmada en el manuscrito.
- **REGISTRADO EN LA OBRA:** correspondencia confirmada en el manuscrito.

Cada registro tiene exactamente un estado: **abierto** o **cerrado**. Comienza abierto; solo el escritor cambia el estado. Etiqueta y estado son independientes. Una IDEA puede permanecer así indefinidamente; nunca se elimina automáticamente.

Una posible coincidencia con el manuscrito solo se vincula tras confirmación cuando exista duda. Si pierde toda evidencia manuscrita, vuelve a IDEA, se limpian ubicaciones actuales y se conserva información e historial. Si conserva evidencia válida, permanece registrado.

### Identidades y transformaciones
No fusionar identidades por semejanza. Alias simples pueden compartir ID. Identidades ocultas o diferenciadas pueden tener IDs separados vinculados, por ejemplo identidad civil e identidad secreta. No transferir automáticamente hechos, relaciones o conocimientos.

Cambios de cuerpo, intercambio, posesión, reencarnación, clonación, fusión o división se representan mediante eventos y vínculos, no mediante fusiones automáticas.

### Perspectivas
Separar conocimiento del escritor, narrador y personajes. Registrar testimonios, mentiras, recuerdos, sospechas, pistas falsas, coartadas, secretos y revelaciones. No asumir que un personaje conoce todo lo que sabe el escritor.

## 8. Cronología, acontecimientos y universos

Distinguir orden del manuscrito, tiempo narrativo y tiempo del relato. Admitir saltos temporales, líneas paralelas, viajes temporales, bucles, paradojas, ramificaciones, convergencias, universos paralelos, dimensiones y planos. No confundir sucesión con causalidad. Conservar contradicciones y versiones sin resolverlas automáticamente.

Los acontecimientos pueden tener participantes y papeles dinámicos, causalidad múltiple, desconocida, engañosa, circular o simultánea. Los personajes pueden tener trayectorias temporales, ubicaciones y conocimientos propios.

Cada libro posee un universo privado con reglas físicas, geográficas, biológicas, culturales, religiosas, políticas, sociales, tecnológicas o mágicas. Las reglas y excepciones tienen alcance, condiciones, herencia, transmisión, cambios y consecuencias. No imponer lógica de otros libros o géneros. El futuro posible permanece como IDEA hasta confirmarse en el manuscrito.

## 9. Sincronización en vivo

Prioridad máxima. El anfitrión envía sincronización inicial y cambios incrementales: inserciones, eliminaciones, reemplazos, movimientos, deshacer/rehacer y pegado de bloques.

- Cada cambio lleva secuencia o revisión.
- Cambios duplicados, fuera de orden o inconsistentes provocan resincronización; no se adivina.
- Los análisis pequeños se procesan localmente y se propagan al contexto necesario.
- Cada sugerencia queda ligada al ID y revisión del fragmento; si cambia, se marca obsoleta.
- Al abrir un libro se inicia sesión y sincronización; al cerrar se cierra sesión y se liberan recursos.
- Ante cierre inesperado, terminar de forma segura.
- Un usuario trabaja con un libro abierto a la vez en el anfitrión.
- Cada instalación conserva copia local; no hay servidores centrales de manuscritos.
- El motor no controla el editor sin adaptador y nunca modifica el manuscrito.
- IDs de fragmentos/anclajes son estables; capítulo, página y línea son ubicaciones recalculables, no claves permanentes.

## 10. Bases de datos y persistencia

### Organización
- El motor crea, administra y mantiene las bases; el anfitrión consulta y envía modificaciones autorizadas.
- Persistencia local permanente y aislamiento estricto por proyecto.
- Una base principal narrativa con proyectos aislados, no una base por personaje o categoría.
- La base principal contiene información vigente, optimizada para consultas habituales.
- La base histórica conserva cambios, procedencia, momento y evolución; se consulta al revisar o restaurar.
- Ambas se coordinan transaccionalmente y tienen backups y recuperación.
- Sistemas especializados grandes (idiomas, gramáticas, diccionarios) pueden tener bases independientes bajo control del motor y referenciadas desde la principal.
- Crecimiento sin límite fijo de categorías, atributos o relaciones.
- Cachés e índices derivados son reconstruibles; no constituyen memoria narrativa paralela.

### Almacenamiento propio
La decisión del proyecto es almacenamiento propio, sin motores de bases de datos de terceros. No sustituir por SQLite, PostgreSQL, DuckDB u otro motor externo. Codex debe diseñar e implementar un formato y motor propios con páginas/registros, índices, transacciones, recuperación, integridad, bloqueos, backups y migraciones.

El archivo inicial MLDB v0.1 es un contenedor prototipo del esquema, **no un motor transaccional de producción**. No almacenar obras reales hasta implementar y probar el almacenamiento completo.

### Identidad y evolución
El anfitrión proporciona el identificador y nombre del proyecto. Codex debe detectar la base inicial, validar versión e integridad y evolucionarla mediante migraciones. No sustituirla, reiniciarla ni crear silenciosamente otra base principal.

## 11. Biblioteca personal de ideas

Al finalizar una obra, registros que sigan como IDEA pueden pasar a la biblioteca personal del escritor, organizados bajo el título de la obra de origen y conservando historial, relaciones y procedencia. Lo incorporado permanece en el libro como REGISTRADO EN LA OBRA.

La biblioteca personal está separada del conocimiento de cada libro. Reutilizar un elemento en otro libro requiere acción expresa y conserva procedencia. No crear relaciones entre proyectos por inferencia.

## 12. Aprendizaje colectivo y actualizaciones

Cada dispositivo puede producir propuestas de mejoras generales sin extraer contenido privado. Un recolector genera propuesta técnica y pruebas; el filtrado de privacidad ocurre en el dispositivo. Si no puede garantizarse la separación, no se envía.

Un repositorio central recibe contribuciones técnicas; un integrador compara, deduplica, resuelve conflictos y valida. Solo el propietario aprueba y publica. Canales: experimental, candidata y estable. Cada dispositivo conserva estable mientras prueba experimental aislada.

Las actualizaciones oficiales verifican autenticidad e integridad mediante APIs criptográficas nativas, admiten rollback y backups y respetan compatibilidad por plataforma. El propietario decide cuándo distribuir. Las actualizaciones no modifican la base narrativa.

## 13. Rendimiento y experiencia

Analizar señales observables de escritura (velocidad, duración, pausas, continuidad), no inferir emociones como hechos. Análisis profundos bajo demanda o en segundo plano, cancelables y no bloqueantes. Si el dispositivo se sobrecarga, reducir análisis secundarios, nunca la integridad de sincronización. Agrupar hallazgos menores durante escritura rápida. El motor decide cuándo enviar sugerencias; el anfitrión cómo mostrarlas. Tareas con progreso, cancelación, prioridades y backpressure.

## 14. Seguridad y compatibilidad

Aislamiento estricto por proyecto; permisos por operación y procedencia; validar entradas, referencias, integridad y autorización; logs técnicos sin texto privado; transacciones, backups y recuperación ante apagones; detección de corrupción y migraciones verificables; compatibilidad versionada entre API, módulos, bases y plataformas. No realizar cambios incompatibles silenciosos.

Cada módulo tendrá ID, versión, responsabilidades, interfaces, dependencias, capacidades, requisitos y pruebas.

## 15. Pruebas y aceptación

Codex debe crear pruebas automatizadas de:
- aislamiento entre proyectos y ausencia de relaciones cruzadas no autorizadas;
- sincronización inicial e incremental, duplicados, secuencias fuera de orden y resincronización;
- obsolescencia de sugerencias al cambiar fragmentos;
- persistencia, cierre seguro y recuperación ante interrupciones;
- transacciones, índices, referencias e integridad;
- backup, restauración, corrupción y migraciones;
- conservación de IDEA y REGISTRADO EN LA OBRA;
- confirmaciones del escritor y ausencia de modificaciones automáticas;
- identidades separadas, alias y transformaciones;
- cronologías no lineales y causalidad indeterminada;
- idiomas simultáneos, palabras inventadas y diccionarios privados;
- privacidad de logs y contribuciones colectivas;
- rendimiento, cancelación y regresiones por idioma.

Métricas lingüísticas: precisión, cobertura, falsas advertencias, consistencia, rendimiento y regresiones. No afirmar cobertura profesional sin pruebas suficientes.

## 16. Instrucciones obligatorias para Codex

1. Leer este documento y todos los archivos de la base inicial antes de programar.
2. Respetar decisiones cerradas; no pedir aprobación repetida.
3. No inventar requisitos ni sustituir decisiones por preferencias técnicas propias.
4. No incorporar dependencias de terceros prohibidas.
5. No introducir datos ficticios en bases reales de escritores.
6. No tratar el prototipo MLDB como motor de producción.
7. Diseñar contratos, formato de almacenamiento, integridad y migraciones antes de almacenar obras.
8. Mantener módulos documentados y probados.
9. No modificar automáticamente el manuscrito.
10. Detenerse y documentar conflictos reales con restricciones; no resolverlos silenciosamente.
11. Entregar instrucciones ejecutables y pruebas reproducibles para un usuario que no programa.
12. Diferenciar lo especificado, implementado, probado y pendiente. No declarar una función terminada sin evidencia.

## 17. Estado de esta especificación

Este documento consolida las decisiones funcionales y arquitectónicas conservadas del proyecto. Es una base de trabajo para Codex, no código implementado ni certificación de que las funciones ya estén construidas.

La implementación deberá completar contratos detallados de API, formato transaccional propio, bases histórica y especializadas, protocolos de sincronización, módulos lingüísticos y planes de pruebas.

**Principio final:** proteger la obra, respetar la intención del escritor y ayudar sin tomar decisiones artísticas en su lugar.
