/**
 * Ingesta estructural de libros desde adaptadores de lectura.
 *
 * Este módulo no presupone EPUB/PDF ni altera contenido editorial: los lectores
 * de formato entregan bloques ordenados y la ingesta valida, agrupa y conserva
 * la procedencia antes de entregar capítulos al motor narrativo.
 */

export type BookReaderBlockKind =
  | "book-title" | "chapter-heading" | "section-heading"
  | "paragraph" | "poem-line" | "footnote" | "page-break";

export interface BookReaderLocation {
  readonly locator: string;
  readonly pageNumber?: number;
  readonly spineIndex?: number;
  readonly sectionIndex?: number;
}

export interface BookReaderBlock {
  /** Identidad estable dentro de la fuente; permite detectar duplicados. */
  readonly blockId: string;
  /** Orden de lectura entregado por el adaptador, estrictamente creciente. */
  readonly sequence: number;
  readonly kind: BookReaderBlockKind;
  readonly text: string;
  readonly chapterId?: string;
  readonly location?: BookReaderLocation;
}

export interface BookReaderMetadata {
  readonly sourceId: string;
  readonly sourceFormat: string;
  readonly title?: string;
  readonly author?: string;
  readonly language?: string;
  /** Revisión del documento anfitrión representada por este snapshot, si está versionado. */
  readonly revision?: number;
}

export interface BookReaderAdapter<TSource = unknown> {
  readonly format: string;
  read(source: TSource, signal?: AbortSignal): AsyncIterable<BookReaderBlock>;
}

export interface BookIngestionOptions {
  readonly maxBlocks?: number;
  readonly maxBlockCharacters?: number;
  readonly maxChapterCharacters?: number;
  readonly maxTotalCharacters?: number;
  readonly signal?: AbortSignal;
}

export interface BookSourceSpan {
  readonly blockId: string;
  readonly sequence: number;
  readonly kind: BookReaderBlockKind;
  readonly start: number;
  readonly end: number;
  readonly location?: BookReaderLocation;
}

export interface IngestedBookChapter {
  readonly documentId: string;
  readonly title: string;
  readonly heading?: string;
  readonly text: string;
  readonly sourceSpans: readonly BookSourceSpan[];
  readonly headingSource?: BookSourceSpan;
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export interface IngestedBook {
  readonly metadata: BookReaderMetadata;
  readonly chapters: readonly IngestedBookChapter[];
  readonly statistics: {
    readonly blocksRead: number;
    readonly charactersRead: number;
    readonly chaptersCreated: number;
    };
}

const DEFAULT_MAX_BLOCKS = 200_000;
const DEFAULT_MAX_BLOCK_CHARACTERS = 1_000_000;
const DEFAULT_MAX_CHAPTER_CHARACTERS = 2_000_000;
const DEFAULT_MAX_TOTAL_CHARACTERS = 100_000_000;

function nonBlank(value: unknown, label: string, max = 512): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TypeError(label + " debe ser un texto no vacío de hasta " + max + " caracteres.");
  }
}

function validateLocation(location: BookReaderLocation): void {
  if (!location || typeof location !== "object") {
    throw new TypeError("La ubicación de origen del bloque es inválida.");
  }
  nonBlank(location.locator, "El localizador de origen", 2048);
  for (const [name, value] of [
    ["pageNumber", location.pageNumber],
    ["spineIndex", location.spineIndex],
    ["sectionIndex", location.sectionIndex]
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError("La coordenada " + name + " debe ser un entero no negativo.");
    }
  }
}

function normalizeReaderText(value: string): string {
  // Solo se unifican finales de línea y BOM inicial. No se eliminan guiones,
  // encabezados repetidos, notas ni caracteres que puedan ser autorales.
  return value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

interface MutableChapter {
  documentId: string;
  title: string;
  heading?: string;
  chunks: string[];
  sourceSpans: BookSourceSpan[];
  headingSource?: BookSourceSpan;
  length: number;
  firstSequence: number;
  lastSequence: number;
}

function makeChapter(documentId: string, title: string, heading: string | undefined, sequence: number): MutableChapter {
  return {
    documentId, title, ...(heading ? { heading } : {}),
    chunks: [], sourceSpans: [], length: 0,
    firstSequence: sequence, lastSequence: sequence
  };
}

function appendBlock(chapter: MutableChapter, block: BookReaderBlock, text: string): void {
  if (!text.length) return;
  const separator = chapter.length === 0 ? "" :
    (block.kind === "poem-line" ? "\n" : "\n\n");
  const start = chapter.length + separator.length;
  chapter.chunks.push(separator, text);
  chapter.length = start + text.length;
  chapter.lastSequence = block.sequence;
  chapter.sourceSpans.push({
    blockId: block.blockId,
    sequence: block.sequence,
    kind: block.kind,
    start,
    end: chapter.length,
    ...(block.location ? { location: structuredClone(block.location) } : {})
  });
}

/**
 * Convierte un flujo del lector en capítulos con evidencia de procedencia.
 * Los límites de capítulo solo se crean con chapterId o encabezados explícitos.
 */
export async function ingestBookReaderBlocks(
  metadata: BookReaderMetadata,
  blocks: AsyncIterable<BookReaderBlock> | Iterable<BookReaderBlock>,
  options: BookIngestionOptions = {}
): Promise<IngestedBook> {
  nonBlank(metadata?.sourceId, "sourceId", 1024);
  nonBlank(metadata?.sourceFormat, "sourceFormat", 128);
  if (metadata.revision !== undefined && (!Number.isSafeInteger(metadata.revision) || metadata.revision < 0)) {
    throw new RangeError("La revisión del libro debe ser un entero no negativo.");
  }
  for (const [name, value] of [["title", metadata.title], ["author", metadata.author], ["language", metadata.language]] as const) {
    if (value !== undefined && (typeof value !== "string" || value.length > 1024)) {
      throw new TypeError("El metadato " + name + " no es válido.");
    }
  }
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const maxBlockCharacters = options.maxBlockCharacters ?? DEFAULT_MAX_BLOCK_CHARACTERS;
  const maxChapterCharacters = options.maxChapterCharacters ?? DEFAULT_MAX_CHAPTER_CHARACTERS;
  const maxTotalCharacters = options.maxTotalCharacters ?? DEFAULT_MAX_TOTAL_CHARACTERS;
  for (const [name, value] of [["maxBlocks", maxBlocks], ["maxBlockCharacters", maxBlockCharacters],
    ["maxChapterCharacters", maxChapterCharacters], ["maxTotalCharacters", maxTotalCharacters]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(name + " debe ser un entero positivo.");
  }

  const chapters: MutableChapter[] = [];
  const seenBlockIds = new Set<string>();
  const seenChapterDocumentIds = new Set<string>();
  let current: MutableChapter | undefined;
  let previousSequence = -1;
  let blocksRead = 0;
  let charactersRead = 0;
  let titleFromReader = metadata.title?.trim() ?? "";

  const iterable = Symbol.asyncIterator in Object(blocks)
    ? blocks as AsyncIterable<BookReaderBlock>
    : (async function* () { yield* blocks as Iterable<BookReaderBlock>; })();

  for await (const block of iterable) {
    if (options.signal?.aborted) throw new DOMException("La ingesta del libro fue cancelada.", "AbortError");
    if (blocksRead >= maxBlocks) throw new RangeError("El libro supera el máximo de bloques permitido.");
    if (!block || typeof block !== "object") throw new TypeError("El lector entregó un bloque inválido.");
    nonBlank(block.blockId, "blockId", 1024);
    if (seenBlockIds.has(block.blockId)) {
      throw new Error("El lector repitió el blockId " + block.blockId + "; la ingesta se detuvo para evitar duplicar texto.");
    }
    if (!Number.isSafeInteger(block.sequence) || block.sequence < 0 || block.sequence <= previousSequence) {
      throw new Error("El orden del lector debe ser estrictamente creciente; bloque " + block.blockId + ".");
    }
    if (!["book-title", "chapter-heading", "section-heading", "paragraph", "poem-line", "footnote", "page-break"].includes(block.kind)) {
      throw new TypeError("Tipo de bloque de lectura no admitido.");
    }
    if (typeof block.text !== "string") throw new TypeError("El texto del bloque debe ser una cadena.");
    if (block.text.length > maxBlockCharacters) throw new RangeError("Un bloque supera el máximo de caracteres permitido.");
    if (block.chapterId !== undefined) nonBlank(block.chapterId, "chapterId", 1024);
    if (block.location !== undefined) validateLocation(block.location);

    const text = normalizeReaderText(block.text);
    if (charactersRead > maxTotalCharacters - text.length) {
      throw new RangeError("El libro supera el máximo total de caracteres permitido.");
    }
    seenBlockIds.add(block.blockId);
    previousSequence = block.sequence;
    blocksRead++;
    charactersRead += text.length;

    if (block.kind === "book-title") {
      if (!titleFromReader && text.trim()) titleFromReader = text.trim();
      continue;
    }
    if (block.kind === "page-break") continue;

    const explicitNewChapter = block.kind === "chapter-heading" ||
      (block.chapterId !== undefined && current !== undefined &&
        current.documentId !== "chapter:" + encodeURIComponent(block.chapterId));
    if (!current || explicitNewChapter) {
      const chapterId = block.chapterId ??
        (block.kind === "chapter-heading" ? "heading-" + block.sequence : "main");
      const documentId = "chapter:" + encodeURIComponent(chapterId);
      if (seenChapterDocumentIds.has(documentId)) {
        throw new Error("El lector reutilizó el identificador de capítulo " + chapterId + ".");
      }
      seenChapterDocumentIds.add(documentId);
      const heading = block.kind === "chapter-heading" ? text.trim() : undefined;
      if (block.kind === "chapter-heading" && !heading) {
        throw new Error("El lector entregó un encabezado de capítulo vacío.");
      }
      current = makeChapter(documentId, heading || "Capítulo " + (chapters.length + 1), heading, block.sequence);
      if (heading !== undefined) current.headingSource = {
        blockId: block.blockId, sequence: block.sequence, kind: block.kind,
        start: 0, end: 0,
        ...(block.location ? { location: structuredClone(block.location) } : {})
      };
      chapters.push(current);
    }
    if (block.chapterId !== undefined && current.documentId !== "chapter:" + encodeURIComponent(block.chapterId)) {
      throw new Error("El chapterId cambió sin un encabezado o límite explícito de capítulo.");
    }
    if (block.kind === "chapter-heading") {
      if (current.length > 0) throw new Error("El encabezado de capítulo no puede insertarse después del cuerpo del capítulo.");
      continue;
    }
    appendBlock(current, block, text);
    if (current.length > maxChapterCharacters) {
      throw new RangeError("El capítulo " + current.title + " supera el máximo analizable de " + maxChapterCharacters + " caracteres.");
    }
  }

  const finalized = chapters
    .filter(chapter => chapter.length > 0 || chapter.heading !== undefined)
    .map(chapter => ({
      documentId: chapter.documentId,
      title: chapter.title,
      ...(chapter.heading ? { heading: chapter.heading } : {}),
      text: chapter.chunks.join(""),
      sourceSpans: chapter.sourceSpans.map(span => structuredClone(span)),
      ...(chapter.headingSource ? { headingSource: structuredClone(chapter.headingSource) } : {}),
      firstSequence: chapter.firstSequence,
      lastSequence: chapter.lastSequence
    }));

  return {
    metadata: { ...metadata, ...(titleFromReader ? { title: titleFromReader } : {}) },
    chapters: finalized,
    statistics: {
      blocksRead,
      charactersRead,
      chaptersCreated: finalized.length
    }
  };
}

/** Ejecuta un adaptador concreto sin acoplar el núcleo a EPUB, PDF o Node. */
export async function ingestBookWithReader<TSource>(
  adapter: BookReaderAdapter<TSource>,
  source: TSource,
  metadata: Omit<BookReaderMetadata, "sourceFormat">,
  options: BookIngestionOptions = {}
): Promise<IngestedBook> {
  nonBlank(adapter?.format, "El formato del lector", 128);
  return ingestBookReaderBlocks(
    { ...metadata, sourceFormat: adapter.format },
    adapter.read(source, options.signal),
    options
  );
}
