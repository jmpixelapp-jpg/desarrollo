# Bloqueo exclusivo entre procesos — implementación experimental v0.1

**Estado:** implementado en el código para targets cfg(unix) y Windows, con pruebas unitarias escritas. Todavía no existe una compilación/ejecución nativa verificable en CI; por tanto, no se declara validado para producción ni se habilita el almacenamiento de manuscritos reales.

## Contrato implementado

- El guard mantiene abierto el archivo auxiliar .mldb-lock durante toda la vida del almacén.
- La adquisición es exclusiva y no bloqueante. Si otro proceso mantiene el lock, devuelve AlreadyLocked.
- El kernel libera el bloqueo al cerrar el handle, también cuando el proceso termina sin ejecutar destructores.
- El archivo auxiliar no se elimina al cerrar: borrar el lockfile podría permitir que procesos distintos bloqueen objetos de archivo diferentes.
- El bloqueo es asesor y cooperativo. No protege contra herramientas externas que ignoren el protocolo.
- Store::open adquiere el lock de su WAL antes de abrirlo o recuperarlo.
- DurablePages::open adquiere los locks de MLPG y MLPJ en orden estable antes de abrir o recuperar esos archivos.
- Si falla una adquisición múltiple, los guards anteriores se liberan automáticamente.

## API y rutas

La implementación expone internamente InterprocessLock::acquire_for(path) y InterprocessLock::acquire_many(paths).

La ruta compañera se construye con el directorio padre canonicalizado y el nombre final del archivo seguido por .mldb-lock. El directorio padre se crea si no existe, antes de canonicalizarlo.

Tratamiento actual:
- Rutas relativas y componentes ..: el directorio padre se canonicaliza para obtener una identidad estable.
- Enlaces simbólicos en el archivo de datos o en el propio lockfile: se rechazan.
- Enlaces simbólicos en directorios padre: se resuelven al canonicalizar el directorio.
- acquire_many: ordena y deduplica rutas de lock equivalentes antes de adquirirlas.
- Enlaces duros (hard links): **no se detectan ni deduplican**. Dos nombres distintos que apunten al mismo inode/archivo pueden producir lockfiles distintos; no usar hard links como alias de un almacén.
- Alias de volumen, junctions y puntos de montaje: no se declara que se deduplican en todas las plataformas; requieren pruebas nativas.

El archivo auxiliar se crea con los permisos predeterminados del sistema de archivos, sujetos a umask/ACL. Todavía no se implementó una política explícita de permisos restrictivos.

## Backends

### Unix

Usa flock(fd, LOCK_EX | LOCK_NB) para adquirir y LOCK_UN al destruir el guard. EWOULDBLOCK/EAGAIN se traducen a AlreadyLocked; otros errores se conservan como io::Error.

### Windows

Usa LockFileEx con LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, offset cero y un rango de 64 bits. El estado OVERLAPPED se conserva en el guard y se reutiliza al llamar a UnlockFileEx. ERROR_LOCK_VIOLATION se traduce a AlreadyLocked.

No se declara soporte nativo para Android, iOS u otros targets Unix hasta compilar y probar sus toolchains concretos.

## Cobertura escrita

Hay pruebas para:
1. Exclusión entre dos aperturas en el mismo proceso.
2. Exclusión entre procesos hijos reales.
3. Liberación normal del guard.
4. Liberación del lock después de que un proceso hijo termina inmediatamente mediante process::exit, sin ejecutar destructores Rust. Esto no equivale todavía a una prueba con kill/terminación forzada por señal.
5. Liberación de los locks ya adquiridos cuando falla una adquisición múltiple.
6. Creación de directorios padre inexistentes.
7. Normalización de rutas con ..
8. Deduplicación de rutas equivalentes dentro de acquire_many.
9. Rechazo de enlaces simbólicos en Unix.

El conteo anterior incluye siete funciones #[test]; una de ellas agrupa varios escenarios. Estas pruebas están escritas, pero no tienen resultado de compilación o ejecución verificable.

## Pendiente antes de declarar soporte

- Compilar y ejecutar en Windows, Linux y macOS con runners nativos.
- Añadir terminación forzada real (kill/señal o terminación equivalente) en cada plataforma.
- Probar dos aperturas concurrentes con orden inverso de rutas y comprobar ausencia de deadlock.
- Probar alias de volumen, junctions, enlaces duros y semántica de volúmenes locales.
- Decidir e implementar permisos restrictivos para el lockfile.
- Probar los backends en sistemas de archivos soportados y declarar explícitamente que NFS/SMB, carpetas sincronizadas y otros sistemas no validados no están soportados.

El estado de GitHub Actions actual termina antes de publicar pasos o logs útiles. No se debe interpretar ese fallo como aprobación o rechazo de la implementación Rust: la compilación y ejecución siguen sin verificarse.
