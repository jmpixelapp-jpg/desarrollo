import type { IngestedBook, IngestedBookChapter, BookSourceSpan } from "./book-ingestion";

/** Fragmento de una evidencia literaria enlazado al bloque y localizador del libro original. */
export interface BookEvidenceSourceFragment {
  readonly blockId: string;
  readonly sequence: number;
  readonly kind: BookSourceSpan["kind"];
  /** Rango UTF-16 dentro del capítulo. */
  readonly chapterStart: number;
  readonly chapterEnd: number;
  /** Rango UTF-16 dentro del bloque de origen. */
  readonly blockStart: number;
  readonly blockEnd: number;
  readonly quote: string;
  readonly locator?: string;
  readonly pageNumber?: number;
  readonly spineIndex?: number;
  readonly sectionIndex?: number;
}

export interface ResolvedBookEvidence {
  readonly sourceId: string;
  readonly sourceFormat: string;
  readonly bookTitle?: string;
  readonly author?: string;
  readonly chapterId: string;
  readonly chapterTitle: string;
  readonly start: number;
  readonly end: number;
  /** Texto exacto de la evidencia en el documento analizado. */
  readonly excerpt: string;
  /** Bloques de origen que cubren el rango; separadores sintéticos no se atribuyen a ningún bloque. */
  readonly fragments: readonly BookEvidenceSourceFragment[];
}

/**
 * Resuelve un rango UTF-16 producido por el análisis hacia sus bloques originales.
 * Los offsets usan la misma convención que String.slice y el resto del motor.
 */
export function resolveBookEvidence(
  book: IngestedBook,
  chapter: IngestedBookChapter,
  start: number,
  end: number
): ResolvedBookEvidence {
  if (!book || !chapter || !Array.isArray(chapter.sourceSpans)) {
    throw new TypeError("El libro o capítulo no contiene procedencia válida.");
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end <= start || end > chapter.text.length) {
    throw new RangeError("El rango de evidencia debe ser UTF-16, no vacío y estar dentro del capítulo.");
  }

  const fragments: BookEvidenceSourceFragment[] = [];
  for (const span of chapter.sourceSpans) {
    const overlapStart = Math.max(start, span.start);
    const overlapEnd = Math.min(end, span.end);
    if (overlapStart >= overlapEnd) continue;
    const location = span.location;
    fragments.push({
      blockId: span.blockId,
      sequence: span.sequence,
      kind: span.kind,
      chapterStart: overlapStart,
      chapterEnd: overlapEnd,
      blockStart: overlapStart - span.start,
      blockEnd: overlapEnd - span.start,
      quote: chapter.text.slice(overlapStart, overlapEnd),
      ...(location ? {
        locator: location.locator,
        ...(location.pageNumber !== undefined ? { pageNumber: location.pageNumber } : {}),
        ...(location.spineIndex !== undefined ? { spineIndex: location.spineIndex } : {}),
        ...(location.sectionIndex !== undefined ? { sectionIndex: location.sectionIndex } : {})
      } : {})
    });
  }

  return {
    sourceId: book.metadata.sourceId,
    sourceFormat: book.metadata.sourceFormat,
    ...(book.metadata.title ? { bookTitle: book.metadata.title } : {}),
    ...(book.metadata.author ? { author: book.metadata.author } : {}),
    chapterId: chapter.documentId,
    chapterTitle: chapter.title,
    start,
    end,
    excerpt: chapter.text.slice(start, end),
    fragments
  };
}

/**
 * Resuelve directamente una evidencia persistida por el conocimiento narrativo.
 * Solo acepta evidencia activa cuya cita coincida exactamente con el texto de la
 * revisión importada; las evidencias obsoletas requieren recuperar su revisión histórica.
 */
export function resolveNarrativeTextEvidence(
  book: IngestedBook,
  evidence: {
    readonly documentId: string;
    readonly revision: number;
    readonly start: number;
    readonly end: number;
    readonly excerpt: string;
    readonly status?: "stale";
  }
): ResolvedBookEvidence {
  if (evidence.status === "stale") {
    throw new Error("La evidencia está obsoleta; debe resolverse contra la revisión histórica correspondiente.");
  }
  if (!Number.isSafeInteger(evidence.revision) || evidence.revision < 0 ||
      typeof evidence.excerpt !== "string" || !evidence.excerpt.length) {
    throw new TypeError("La evidencia narrativa no tiene revisión o cita válidas.");
  }
  const chapter = book.chapters.find(item => item.documentId === evidence.documentId);
  if (!chapter) {
    throw new Error("El documento de la evidencia no pertenece al libro importado.");
  }
  if (!Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) ||
      evidence.start < 0 || evidence.end <= evidence.start ||
      evidence.end > chapter.text.length ||
      chapter.text.slice(evidence.start, evidence.end) !== evidence.excerpt) {
    throw new Error("La cita no coincide con el rango de texto de la fuente importada.");
  }
  return resolveBookEvidence(book, chapter, evidence.start, evidence.end);
}
