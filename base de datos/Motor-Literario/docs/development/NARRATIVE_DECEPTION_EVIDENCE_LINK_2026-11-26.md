# Enlace entre conocimiento previo y ocultación narrativa

## Propósito

`narrative-deception-evidence-link.ts` conecta afirmaciones cognitivas de personajes con señales explícitas de ocultación, mentira, fingimiento o inducción de creencias. El resultado es una relación probatoria candidata, nunca un veredicto de engaño.

## Requisitos del enlace

- Mismo proyecto e identidad explícita del actor/personaje que conoce.
- Proposición literal coincidente tras normalización NFC, minúsculas españolas, eliminación de puntuación y compactación de espacios. No se resuelven paráfrasis, sinónimos ni correferencias.
- Conocimiento afirmado, explícito y atribuido mediante modo `asserted-cognition`; se excluyen sospechas, creencias, olvidos, negaciones y transferencias comunicativas.
- La señal de ocultación debe ser afirmada, no negada.
- La afirmación de conocimiento debe preceder al desencadenante de ocultación dentro de la misma revisión, o en un documento anterior según orden documental explícito, único y no ambiguo.

## Cronología y límites interpretativos

No se ordenan revisiones diferentes del mismo documento ni documentos sin orden explícito. El orden de lectura no se convierte en tiempo diegético. Los enlaces preservan evidencia de ambas afirmaciones y declaran `deceptionEstablished=false` e `intentEstablished=false`: saber algo antes y ocultarlo no demuestra por sí solo falsedad, intención maliciosa ni que el destinatario haya recibido una proposición engañosa.

## Presupuestos

10.000 afirmaciones cognitivas, 5.000 señales de ocultación, 50.000 parejas examinadas y 5.000 enlaces. Al exceder un límite se produce error explícito; se recomienda procesar por capítulos conservando offsets y revisiones.

## Uso

Ejecutar después de la extracción de conocimiento y ocultación. Entregar los resultados a revisión humana y, en una fase posterior, cruzarlos con atribución de diálogo, recepción explícita, negaciones y revelaciones, sin sustituir evidencia original por conclusiones derivadas.
