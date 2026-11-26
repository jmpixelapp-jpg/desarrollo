# Corrección de expectativa de admisión FIFO — 2026-11-26

## Hallazgo

La suite aislada del monitor registró una diferencia entre el comportamiento contractual de `onAdmission` y la expectativa de una regresión en `live-author-monitor-change-binding.test.mjs`.

El contrato del enlace declara que `onAdmission` se invoca una vez por cada intento real de admisión, incluidas las respuestas `queue_full`. La implementación ya aplicaba ese contrato: notificaba el rechazo de la secuencia 1, retenía el delta FIFO y, después de una resincronización autoritativa, notificaba la admisión `queued` de la secuencia 3.

La prueba solo esperaba la segunda notificación, por lo que su expectativa omitía el rechazo legítimamente informado.

## Corrección

En `typescript/tests/live-author-monitor-change-binding.test.mjs`, la expectativa pasó a comprobar las dos notificaciones, en orden:

- Secuencia 1: `rejected` por `queue_full`; el cambio permanece retenido.
- Secuencia 2: desborda el límite del buffer externo, no se somete al motor y exige snapshot común.
- Tras resincronizar el documento en secuencia 2, secuencia 3: `queued` y admitida.

No se modificó el código de producción, no se omitió el callback de rechazo y no se relajaron las garantías FIFO o de contrapresión.

## Evidencia de CI previa

La ejecución de Live Author Monitor **45805734080** presentó 190/191 pruebas aisladas aprobadas; la única falla fue esta expectativa incompleta, en la línea 451 del test. El build runtime de esa misma ejecución falló además por una cadena sin cerrar en `src/narrative-observation-discovery.ts:373`, archivo ajeno al módulo de monitoreo.

La corrección de la expectativa genera una nueva ejecución del workflow específico. El resultado posterior debe comprobarse antes de marcar la suite como verde.
