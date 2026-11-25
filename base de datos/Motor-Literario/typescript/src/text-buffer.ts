/**
 * Tabla de piezas para aplicar cambios locales sin reconstruir el manuscrito
 * completo en cada pulsación. Los fragmentos añadidos se conservan por bloques.
 */
interface Piece {
  readonly source: number;
  readonly start: number;
  readonly length: number;
}

export class PieceTable {
  private sources: string[];
  private pieces: Piece[];
  private lengthValue: number;

  constructor(text: string) {
    this.sources = [text];
    this.pieces = text.length ? [{ source: 0, start: 0, length: text.length }] : [];
    this.lengthValue = text.length;
  }

  get length(): number {
    return this.lengthValue;
  }

  clone(): PieceTable {
    const copy = new PieceTable("");
    // El pool solo crece; compartirlo evita copiar miles de referencias en cada edición.
    // compact() reemplaza el array local sin mutar el pool que usan otras versiones.
    copy.sources = this.sources;
    copy.pieces = this.pieces.slice();
    copy.lengthValue = this.lengthValue;
    return copy;
  }

  replace(start: number, end: number, replacement: string): void {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end < start || end > this.lengthValue) {
      throw new RangeError("Rango de edición fuera del documento.");
    }
    const left = this.splitAt(start);
    const right = this.splitAt(end);
    const inserted: Piece[] = [];
    if (replacement.length) {
      const source = this.sources.push(replacement) - 1;
      inserted.push({ source, start: 0, length: replacement.length });
    }
    this.pieces.splice(left, right - left, ...inserted);
    this.lengthValue += replacement.length - (end - start);
    this.coalesceAround(left, inserted.length);

    // Evita que la tabla de piezas crezca indefinidamente. La compactación es
    // ocasional, no se paga en cada cambio del editor.
    if (this.pieces.length > 2048 || this.sources.length > 2048) this.compact();
  }

  slice(start = 0, end = this.lengthValue): string {
    const from = Math.max(0, Math.min(this.lengthValue, start));
    const to = Math.max(from, Math.min(this.lengthValue, end));
    if (from === to) return "";
    const output: string[] = [];
    let position = 0;
    for (const piece of this.pieces) {
      const pieceEnd = position + piece.length;
      if (pieceEnd > from && position < to) {
        const localStart = Math.max(0, from - position);
        const localEnd = Math.min(piece.length, to - position);
        output.push(this.sources[piece.source]!.slice(
          piece.start + localStart, piece.start + localEnd
        ));
      }
      if (pieceEnd >= to) break;
      position = pieceEnd;
    }
    return output.join("");
  }

  toString(): string {
    return this.slice(0, this.lengthValue);
  }

  lastIndexOfNewline(fromIndex: number): number {
    const limit = Math.min(this.lengthValue - 1, fromIndex);
    if (limit < 0) return -1;
    let position = this.lengthValue;
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const piece = this.pieces[i]!;
      const pieceStart = position - piece.length;
      if (pieceStart <= limit) {
        const allowed = Math.min(piece.length, limit - pieceStart + 1);
        const found = this.sources[piece.source]!.lastIndexOf(
          "\n", piece.start + allowed - 1
        );
        if (found >= piece.start) return pieceStart + found - piece.start;
      }
      position = pieceStart;
    }
    return -1;
  }

  indexOfNewline(fromIndex: number): number {
    const from = Math.max(0, fromIndex);
    if (from >= this.lengthValue) return -1;
    let position = 0;
    for (const piece of this.pieces) {
      const pieceEnd = position + piece.length;
      if (pieceEnd > from) {
        const localStart = Math.max(0, from - position);
        const found = this.sources[piece.source]!.indexOf(
          "\n", piece.start + localStart
        );
        if (found >= piece.start && found < piece.start + piece.length) {
          return position + found - piece.start;
        }
      }
      position = pieceEnd;
    }
    return -1;
  }

  private splitAt(offset: number): number {
    if (offset <= 0) return 0;
    if (offset >= this.lengthValue) return this.pieces.length;
    let position = 0;
    for (let i = 0; i < this.pieces.length; i++) {
      const piece = this.pieces[i]!;
      const pieceEnd = position + piece.length;
      if (offset === position) return i;
      if (offset === pieceEnd) return i + 1;
      if (offset < pieceEnd) {
        const leftLength = offset - position;
        const left: Piece = { ...piece, length: leftLength };
        const right: Piece = {
          source: piece.source,
          start: piece.start + leftLength,
          length: piece.length - leftLength
        };
        this.pieces.splice(i, 1, left, right);
        return i + 1;
      }
      position = pieceEnd;
    }
    return this.pieces.length;
  }

  /** Solo pueden aparecer nuevas piezas contiguas junto al rango reemplazado. */
  private coalesceAround(index: number, insertedCount: number): void {
    if (this.pieces.length < 2) return;
    const first = Math.max(0, index - 1);
    let cursor = first;
    let end = Math.min(this.pieces.length, index + insertedCount + 2);
    while (cursor + 1 < end) {
      const previous = this.pieces[cursor]!;
      const current = this.pieces[cursor + 1]!;
      if (previous.source === current.source &&
          previous.start + previous.length === current.start) {
        this.pieces.splice(cursor, 2, {
          source: previous.source,
          start: previous.start,
          length: previous.length + current.length
        });
        end--;
        if (cursor > first) cursor--;
      } else {
        cursor++;
      }
    }
  }

  private compact(): void {
    const text = this.toString();
    this.sources = [text];
    this.pieces = text.length ? [{ source: 0, start: 0, length: text.length }] : [];
  }
}
