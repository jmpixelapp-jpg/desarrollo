# Protocolo de sobres de sincronización narrativa v1

**Estado:** contrato de intercambio implementado en TypeScript/JavaScript puro.  
**Módulo:** `typescript/src/narrative-sync-envelope.ts`.  
**Objetivo:** representar una operación narrativa de forma versionada, verificable y reproducible antes de entregarla a un transporte remoto.

## Formato del sobre

Cada operación v1 contiene:

| Campo | Regla |
|---|---|
| `protocol` | `motor-literario-sync` |
| `protocolVersion` | `1` |
| `operationId` | Identificador idempotente, no vacío, máximo 256 caracteres |
| `projectId` | Identidad del libro/proyecto, máximo 256 caracteres |
| `deviceId` | Identidad estable asignada por el anfitrión, máximo 256 caracteres |
| `sequence` | Entero seguro positivo y creciente por dispositivo |
| `kind` | Identificador ASCII en minúsculas, máximo 128 caracteres |
| `createdAt` | Marca temporal Unix en milisegundos, entero no negativo |
| `payload` | Objeto JSON canónico; sujeto a límites de profundidad, nodos y bytes |
| `envelopeSha256` | SHA-256 hexadecimal de todos los campos anteriores en forma canónica |

El payload se copia desde su forma canónica. El orden de propiedades de los objetos no afecta la huella; el orden de arrays y la representación Unicode sí se conservan exactamente. El sobre no ejecuta getters ni conversiones implícitas y rechaza propiedades adicionales, valores no JSON, ciclos y prototipos personalizados.

## API exportada

- `createNarrativeSyncEnvelope(input, limits?)`: valida una operación local, copia el payload y devuelve su sobre v1 firmado con un digest SHA-256 de contenido.
- `verifyNarrativeSyncEnvelope(candidate, limits?)`: valida una entrada no confiable, exige el protocolo/versión exactos, rechaza propiedades extra y vuelve a calcular SHA-256 antes de devolver una copia.
- `validateNarrativeSyncEnvelopeBatch(candidates, options?)`: verifica cada sobre y aplica límites, proyecto único, IDs de operación únicos y secuencias estrictamente crecientes por dispositivo dentro del lote.

El tamaño predeterminado del lote es 100 y el máximo configurable es 500. La verificación SHA-256 usa Web Crypto; si el entorno no dispone de `crypto.subtle`, falla explícitamente y no sustituye el digest por un checksum débil.

## Garantías y límites de seguridad

SHA-256 detecta alteraciones del contenido o diferencias de canonicalización, pero **no autentica al emisor**: cualquier persona que pueda fabricar un sobre puede recalcular su digest. El servidor remoto sigue obligado a autenticar al usuario/dispositivo, autorizar el acceso a `projectId`, validar el esquema y tamaño, aplicar idempotencia por `operationId` y mantener la secuencia durable por dispositivo.

El sobre no cifra contenido, no contiene credenciales y no implica que haya transporte HTTP o sincronización multidispositivo activa. El anfitrión decide cómo asignar `deviceId`, conserva su contador de secuencia durable y solo transmite el sobre después de una operación local confirmada. La aplicación remota debe tratar `operationId` como clave idempotente y rechazar cambios de contenido para un ID ya aceptado.

El orden de secuencia se comprueba dentro de cada lote; el servidor debe contrastarlo también con el último número durable que haya aceptado para el dispositivo. La llegada repetida de un mismo `operationId` debe devolver el resultado anterior, no aplicar el efecto otra vez.

## Pruebas

`tests/narrative-sync-envelope.test.mjs` cubre SHA-256 independiente, verificación y alteración del contenido, independencia del orden de claves, rechazo de versiones/campos inesperados, validación de identidad, lotes mezclados, IDs repetidos, secuencias fuera de orden, arrays dispersos, límites y ausencia de Web Crypto.
