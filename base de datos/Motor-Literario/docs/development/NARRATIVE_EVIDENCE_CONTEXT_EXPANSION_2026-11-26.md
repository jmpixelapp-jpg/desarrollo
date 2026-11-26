# Ampliación de contexto probatorio entre oraciones

## Propósito

`expandNarrativeEvidenceContext` recupera oraciones contiguas alrededor de una evidencia extraída. Permite que lectores y módulos posteriores consulten el contexto discursivo de un hallazgo sin reducir el manuscrito a fragmentos aislados.

## Contrato epistemológico

El módulo no concatena las oraciones en una proposición, no asigna pronombres, no identifica sujetos omitidos, no establece causalidad y no convierte proximidad textual en continuidad temporal diegética. Devuelve por separado evidencia ancla, contexto precedente y contexto posterior.

## Límites y trazabilidad

Valida proyecto por contrato, documento, revisión, offsets UTF-16 y coincidencia exacta del extracto con el texto fuente. Respeta límites de párrafo y presupuestos de contexto. Valores predeterminados: una oración anterior y posterior, hasta 5.000 unidades de contexto; máximos de cinco oraciones por lado y 20.000 unidades.

## Integración

Los módulos de conocimiento, recepción, acciones, eventos y estados pueden suministrar sus evidencias como anclas. El resultado es una capa de recuperación contextual, no un sustituto del análisis especializado.
