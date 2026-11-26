# Integridad determinista de payloads para sincronización narrativa

**Estado:** implementación en TypeScript/JavaScript puro sobre `main`.  
**Módulo:** `typescript/src/narrative-sync-integrity.ts`.  
**Objetivo:** ofrecer una representación canónica y una huella reproducible de payloads JSON para comparar operaciones narrativas entre dispositivos y reintentos.

## 1. Contrato implementado

El módulo exporta tres funciones:

- `canonicalizeNarrativeSyncPayload(payload, limits?)`: serializa JSON con propiedades de objetos ordenadas por unidades de código UTF-16. Conserva el orden de arrays y los valores de texto Unicode exactamente como se recibieron.
- `fingerprintNarrativeSyncPayload(payload, limits?)`: calcula FNV-1a de 64 bits sobre los bytes UTF-8 de la representación canónica.
- `areNarrativeSyncPayloadsEquivalent(left, right, limits?)`: compara las representaciones canónicas, sin depender del orden de inserción de las claves.

Los límites configurables son profundidad máxima (64), nodos visitados (100.000) y tamaño UTF-8 (1 MiB). Los tres valores deben ser enteros positivos.

## 2. Reglas de canonicalización

1. Los objetos deben tener `Object.prototype` o prototipo nulo.
2. Las claves propias enumerables se ordenan de forma determinista.
3. Los arrays conservan su orden y deben ser densos, sin propiedades adicionales.
4. Se rechazan ciclos, getters/setters, propiedades Symbol, propiedades no enumerables y prototipos personalizados.
5. Se rechazan `undefined`, funciones, símbolos, BigInt y números no finitos. No se permite que JSON los omita o convierta silenciosamente.
6. `-0` adopta la representación JSON `0`.
7. No se aplica normalización Unicode: NFC y NFD permanecen distintos para no alterar el texto original.

## 3. Uso previsto

La representación canónica permite comprobar equivalencia exacta de payloads y la huella permite comparar rápidamente candidatos de igual contenido antes de una reconciliación. En una colisión de huella, el consumidor que necesite certeza debe comparar también el JSON canónico.

La huella es un checksum de consistencia, no una firma ni un mecanismo de autenticación. FNV-1a no es criptográfico: no debe utilizarse para verificar identidad de usuarios, permisos, integridad adversarial, firmas de servidor ni secretos. La autorización y la validación definitiva deben ocurrir en el servidor.

## 4. Límites funcionales

Este módulo no implementa transporte HTTP, autenticación, autorización, almacenamiento de operaciones, secuencias de dispositivo, reintentos, acuses ni resolución de conflictos. Tampoco declara terminada la sincronización multidispositivo. Proporciona una primitiva determinista reutilizable por el protocolo de sincronización.

La canonicalización solo acepta valores JSON estrictos. No ejecuta métodos `toJSON`, getters ni conversiones implícitas, y no modifica el objeto de entrada.

## 5. Pruebas

La suite `tests/narrative-sync-integrity.test.mjs` cubre:

- independencia del orden de claves;
- preservación del orden de arrays y de las formas Unicode;
- estabilidad de huellas y detección de cambios;
- objetos de prototipo nulo y normalización de `-0`;
- rechazo de valores no JSON, ciclos y arrays dispersos;
- rechazo de accessors sin ejecutar getters y de claves Symbol;
- límites de profundidad, nodos y bytes UTF-8.

Ejecutar desde `base de datos/Motor-Literario/typescript`:

```bash
npm test
```

La suite general compila el paquete, valida el esquema MLDB y ejecuta las pruebas Node. La incorporación del test no equivale por sí misma a una ejecución aprobada de CI; el resultado debe verificarse en GitHub Actions para el commit correspondiente.
