# Validación de emparejamiento beforeinput/input — 2026-11-26

## Objetivo

Evitar que el adaptador de captura nativa asocie un evento `input` con una selección anterior cuando el navegador/editor produce un segundo `beforeinput` antes de completar el primero.

## Cambio implementado

En `typescript/src/live-author-monitor-textarea-source.ts`:

- Se añadió el código de diagnóstico `missing-input`.
- Antes de aceptar un nuevo `beforeinput`, el adaptador comprueba que no quede un `beforeinput` previo pendiente.
- Si existe uno, suspende la captura, descarta el estado pendiente y exige resincronización.
- No emite un delta especulativo ni permite que el segundo evento sobrescriba silenciosamente el rango original.

Esto cubre una secuencia ambigua que también puede aparecer cuando un `beforeinput` fue cancelado por otro listener después de que el adaptador lo observó: si no llega el `input` correspondiente, el siguiente `beforeinput` detecta el emparejamiento incompleto.

## Prueba añadida

En `typescript/tests/live-author-monitor-textarea-source.test.mjs`:

- Nuevo caso: `exige resincronización si llega otro beforeinput sin completar el input anterior`.
- Simula dos `beforeinput` consecutivos, seguidos de un único `input`.
- Verifica que no se emite ningún cambio, que `needsResync` pasa a `true` y que el diagnóstico es `missing-input`.

## Criterio de seguridad

La captura solo publica cambios cuando puede asociar el evento posterior con el estado previo inmediato. Ante pérdida de emparejamiento, prefiere perder temporalmente continuidad y recuperar desde un snapshot autoritativo antes que inventar offsets o texto.

## Commits

- Adaptador: `d335584f9414819ab135189ca397da56c0b194e7`
- Prueba: `81d09653bc9d4fa80f0382621653ecc46578216a`

## Estado de validación

La ejecución CI anterior `45778453905` finalizó con éxito en type-check, build, pruebas automatizadas, instalación de Chromium y benchmark. La nueva modificación genera una ejecución independiente; su resultado debe comprobarse antes de considerar validada esta iteración.

## Límites conocidos

- Si un `beforeinput` queda pendiente y no ocurre ningún otro evento observable, el adaptador no puede determinar por sí solo si fue cancelado o si el navegador aún está procesando la edición. No se introduce un timeout especulativo.
- Los eventos nativos no revelan siempre la intención semántica del autor.
- La integración de un editor enriquecido debe usar su proveedor de transacciones autoritativas cuando esté disponible.
