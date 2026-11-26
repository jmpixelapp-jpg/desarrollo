# Avance 115 — coherencia de eventos nativos

Fecha: 26 de noviembre de 2026

## Cambio ejecutable

El adaptador textarea compara `InputEvent.inputType` del evento `input` con el tipo capturado en `beforeinput`. Si ambos están presentes y difieren, no emite delta, marca `needsResync` y reporta `input-type-mismatch`. Si el navegador no expone `inputType` en `input`, se mantiene compatibilidad.

## Prueba

`rechaza input cuyo inputType no coincide con el beforeinput asociado`: simula `beforeinput` como `insertText` y `input` como `insertFromPaste`; verifica que no se emite delta y que se exige resincronización.

## Commits

- https://github.com/jmpixelapp-jpg/desarrollo/commit/d289d437a3ad787429d655973137cfbad0e79968
- https://github.com/jmpixelapp-jpg/desarrollo/commit/8bc61f9a6b88dbccb779ef7df6b0dd0f83388cfe

## CI

- https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45778450560
- https://github.com/jmpixelapp-jpg/desarrollo/actions/runs/45778453905

Las ejecuciones se encontraban en curso/cola al documentar este avance. No se declara aprobación hasta obtener conclusión `success`.

## Límite

Esta comprobación detecta contradicciones explícitas entre ambos eventos, pero no demuestra por sí sola que el delta de textarea coincida en todos los prefijos/sufijos ante mutaciones externas simultáneas. Para garantía fuerte, usar transacciones autoritativas del editor con revisión y delta aplicados.

## Próximo paso

Revisar CI y ampliar pruebas reales de Chromium para composición, pegado y cancelación de `beforeinput`; mantener el contrato transaccional como fuente de verdad para undo/redo y editores enriquecidos.