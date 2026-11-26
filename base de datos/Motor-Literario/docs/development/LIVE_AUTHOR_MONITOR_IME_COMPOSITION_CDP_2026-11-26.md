# Validación de composición IME mediante Chromium CDP — 2026-11-26

## Objetivo

Probar que la fuente de referencia `LiveAuthorMonitorTextAreaSource` observa candidatos IME aplicados, conserva deltas reconstruibles y no acepta como confiable un cierre de composición que el navegador exponga como no confiable.

## Mecanismo

La prueba `typescript/tests/live-author-monitor-ime-composition-browser.test.mjs` utiliza Chromium headless y la sesión Chrome DevTools Protocol de Playwright:

1. `Input.imeSetComposition` instala un primer candidato.
2. Una segunda llamada sustituye el candidato por otro de longitud UTF-16 diferente.
3. Una llamada con `text: ""` cancela la composición, conforme al contrato documentado de CDP.
4. Se verifica que el valor final vuelve al snapshot anterior y que la secuencia de deltas reproduce el mismo valor.
5. Se comprueba la señal de fin de composición, la pausa conservadora, la resincronización desde snapshot y una escritura ordinaria posterior.

La prueba no registra valores del candidato en la traza exportada: conserva tipo de evento, confianza, `isComposing`, longitud, selección, rangos de delta y códigos de error.

## Resultado observado

En Chromium 159.0.8154.6 de CI se observó:

- `compositionstart`, `compositionupdate`, `beforeinput` e `input` de los candidatos con `isTrusted === true`.
- Los cambios de candidato llegan como `insertCompositionText` y el adaptador emite deltas de clase `composition`.
- Al cancelar, Chromium restaura el valor del textarea; la secuencia de deltas reproduce exactamente el valor original.
- El evento `compositionend` emitido por esta vía de automatización tiene `isTrusted === false`. El adaptador lo rechaza con `untrusted-event` y suspende la captura.
- Tras entregar un snapshot del texto visible, `resynchronize()` reanuda la fuente y una pulsación confiable posterior produce un delta `typing` consecutivo sin errores nuevos.

**CI focalizada:** [run 45810197232](https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45810197232), commit `37d4e3ea26389a1ed2ac16bc51a23c174bbbc3fc`, resultado `success`: cancelación `beforeinput` 1/1 e IME CDP 1/1.

## Interpretación y límites

Esta prueba valida el comportamiento del navegador ante comandos CDP, no un IME instalado en Windows, macOS, Linux o ChromeOS. No valida la ventana real de candidatos, el teclado del sistema, autocorrección del proveedor ni diferencias entre idiomas. La ruta CDP puede producir un `compositionend` no confiable incluso cuando las actualizaciones y los inputs fueron confiables; esa diferencia se conserva como evidencia y no se oculta relajando la validación.

La página `tests/browser/live-author-monitor-ime-manual.html` sigue siendo necesaria para la matriz con IME físico y debe ejecutarse en cada sistema operativo/navegador que se declare compatible.

### Métricas durante candidatos provisionales

El adaptador referencia publica cada cambio textual que el textarea aplica durante la composición, con `activityKind: "composition"`. El motor conserva cada delta para mantener el texto sincronizado. Actualmente los acumulados `insertedCharacters` y `deletedCharacters` suman también esas revisiones de candidatos. Por tanto, varias sustituciones de candidato pueden aumentar el recuento de unidades insertadas/eliminadas aunque el texto final tenga una longitud menor o la composición se cancele.

No se debe interpretar `estimatedWordsPerMinute` como velocidad de palabras finales confirmadas durante sesiones con actividad de composición. Es una estimación derivada de unidades UTF-16 de cambios aplicados, no un recuento de texto IME confirmado. La normalización de una composición a una operación final requeriría un contrato explícito de inicio/fin/commit/cancel y sincronización con el historial/editor anfitrión; no se debe inferir a partir de `compositionend` aislado.

## Siguiente paso

1. Ejecutar la prueba manual con IME físico y adjuntar trazas sin contenido para cada SO/navegador/idioma.
2. Definir y probar el contrato de commit/cancelación de composición en el adaptador transaccional real del editor.
3. Separar en métricas los cambios provisionales de candidatos y las unidades del texto final confirmado, manteniendo la secuencia de deltas necesaria para persistencia.
