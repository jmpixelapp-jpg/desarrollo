# Handlers de dominio para sincronización narrativa

## Propósito

Los handlers conectan las envolturas verificadas del diario con el almacenamiento del dominio. El dispatcher no conoce las tablas MLDB y el diario no aplica cambios al proyecto; esta capa realiza la transición explícita entre ambos.

## Operación implementada: `idea-upsert`

El payload tiene esta forma:

```ts
{
  idea: NarrativeIdea
}
```

El handler `createNarrativeIdeaUpsertHandler(store)`:

1. exige `loadIdeas` y `saveIdeaIfUnchanged` en el `ProjectStore`;
2. valida la estructura básica de la idea y exige que `idea.projectId` coincida con `operation.projectId`;
3. carga la idea actual dentro del proyecto;
4. no escribe cuando el registro ya coincide exactamente, haciendo inocuo el reintento tras una caída posterior al CAS y anterior al acuse del diario;
5. inserta o actualiza con compare-and-swap, entregando la versión observada como `expectedCurrent`.

## Conflictos

Si la idea cambia después de la lectura, el store debe rechazar el CAS. El error detiene el replay y la operación permanece pendiente. El handler no elige silenciosamente entre dos ediciones concurrentes ni sobrescribe una versión que no observó.

El anfitrión debe presentar el conflicto para reconciliación editorial y, una vez resuelto, generar una operación nueva o una política explícita de resolución. No se debe editar manualmente el payload de una envoltura ya sellada: cualquier cambio invalida su digest.

## Entrega e idempotencia

El diario ofrece entrega al menos una vez. La idempotencia de este handler se basa en la igualdad del estado persistido antes de escribir, además del CAS. La garantía solo cubre la mutación de la idea; no convierte el diario y el almacén de ideas en una transacción única.

## Concurrencia del replay

Los replays del mismo escritor/proyecto se serializan dentro del runtime. Escritores diferentes pueden reproducirse en paralelo porque mantienen cursores separados. Un replay de proyecto completo excluye los replays específicos de escritor. Los locks son locales al runtime; pestañas y dispositivos necesitan coordinación adicional y siguen dependiendo de CAS en el store.

## Alcance no implementado

- No autentica `writerId`; la identidad debe proceder de una sesión validada por el anfitrión/servidor.
- No implementa transporte remoto ni autorización por proyecto.
- No fusiona automáticamente ediciones de texto concurrentes.
- No ofrece exactamente-una-vez ni atomicidad distribuida entre el diario y las proyecciones.
- Los handlers de entidades, relaciones, acontecimientos y afirmaciones siguen pendientes.

## Pruebas

`tests/narrative-sync-domain-handlers.test.mjs` cubre persistencia CAS, repetición tras fallo antes del acuse, conflicto CAS y validación de payload.

`tests/narrative-sync-writer-concurrency.test.mjs` cubre replay concurrente de escritores diferentes y exclusión entre replay de proyecto completo y replay de escritor.
