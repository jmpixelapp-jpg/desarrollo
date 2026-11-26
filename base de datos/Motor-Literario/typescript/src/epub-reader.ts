import type {
  BookReaderAdapter, BookReaderBlock, BookReaderLocation
} from "./book-ingestion";

export interface EpubReaderLimits {
  readonly maxArchiveBytes?: number;
  readonly maxExpandedBytes?: number;
  readonly maxEntryBytes?: number;
  readonly maxEntries?: number;
  readonly maxCompressionRatio?: number;
}

export interface EpubMetadata {
  readonly title?: string;
  readonly author?: string;
  readonly language?: string;
  readonly identifier?: string;
}

export interface EpubInspection {
  readonly metadata: EpubMetadata;
  readonly spineItems: number;
  readonly warnings: readonly string[];
}

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly expandedSize: number;
  readonly localOffset: number;
}

const DEFAULT_LIMITS: Required<EpubReaderLimits> = {
  maxArchiveBytes: 100 * 1024 * 1024,
  maxExpandedBytes: 300 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  maxEntries: 20_000,
  maxCompressionRatio: 200
};

function fail(message: string): never { throw new Error("EPUB: " + message); }

function safePath(path: string): string {
  const normalized = path.replace(/\\/gu, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized) ||
      normalized.split("/").some(part => part === ".." || part === ".")) {
    return fail("ruta interna no segura: " + path);
  }
  return normalized;
}

function resolvePath(baseFile: string, relative: string): string {
  const joined = relative.startsWith("/")
    ? relative.slice(1)
    : baseFile.slice(0, baseFile.lastIndexOf("/") + 1) + relative;
  const parts: string[] = [];
  for (const part of joined.replace(/\\/gu, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) fail("una referencia intenta salir del contenedor EPUB.");
      parts.pop();
    } else parts.push(part);
  }
  return safePath(parts.join("/"));
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)) return "\uFFFD";
    return String.fromCodePoint(code);
  });
}

function attributes(source: string): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = /([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/gu;
  for (const match of source.matchAll(pattern)) {
    result.set(match[1].toLowerCase(), decodeEntities(match[2].slice(1, -1)));
  }
  return result;
}

function xmlText(xml: string, localName: string): string | undefined {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp("<(?:[\\w.-]+:)?" + escaped + "\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?" + escaped + "\\s*>", "iu").exec(xml);
  return match ? decodeEntities(match[1].replace(/<[^>]+>/gu, "").trim()) : undefined;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    return fail("este entorno no ofrece DecompressionStream para entradas ZIP comprimidas.");
  }
  try {
    const stream = new Blob([data]).stream().pipeThrough(
      new DecompressionStream("deflate-raw" as CompressionFormat)
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return fail("no se pudo descomprimir una entrada ZIP; el archivo puede estar dañado.");
  }
}

class EpubArchive {
  private readonly entries = new Map<string, ZipEntry>();
  private readonly limits: Required<EpubReaderLimits>;

  private constructor(private readonly bytes: Uint8Array, limits: EpubReaderLimits) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  static async open(input: ArrayBuffer | Uint8Array, limits: EpubReaderLimits = {}): Promise<EpubArchive> {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const archive = new EpubArchive(bytes, limits);
    await archive.parseDirectory();
    return archive;
  }

  private async parseDirectory(): Promise<void> {
    const { bytes, limits } = this;
    if (bytes.byteLength < 22 || bytes.byteLength > limits.maxArchiveBytes) fail("tamaño del archivo fuera de los límites.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const min = Math.max(0, bytes.length - 65_557);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= min; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) fail("no se encontró el directorio central ZIP.");
    if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) {
      fail("no se admiten archivos ZIP divididos en varios volúmenes.");
    }
    const count = view.getUint16(eocd + 10, true);
    const directorySize = view.getUint32(eocd + 12, true);
    const directoryOffset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      fail("ZIP64 todavía no está admitido por este lector.");
    }
    if (count > limits.maxEntries || directoryOffset + directorySize > eocd) fail("directorio central inválido o excesivo.");
    let offset = directoryOffset;
    let expandedTotal = 0;
    for (let index = 0; index < count; index++) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) fail("entrada del directorio central truncada.");
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const expandedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const end = offset + 46 + nameLength + extraLength + commentLength;
      if (end > bytes.length) fail("nombre o metadatos ZIP truncados.");
      if (flags & 1) fail("no se admiten entradas cifradas.");
      if (method !== 0 && method !== 8) fail("método de compresión ZIP no admitido: " + method);
      const name = safePath(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength)));
      if (this.entries.has(name)) fail("entrada duplicada: " + name);
      if (expandedSize > limits.maxEntryBytes) fail("entrada demasiado grande: " + name);
      if (expandedSize > 0 && (compressedSize === 0 || expandedSize / compressedSize > limits.maxCompressionRatio)) {
        fail("ratio de compresión sospechoso en " + name);
      }
      expandedTotal += expandedSize;
      if (expandedTotal > limits.maxExpandedBytes) fail("tamaño expandido total excesivo.");
      this.entries.set(name, { name, method, compressedSize, expandedSize, localOffset });
      offset = end;
    }
    if (offset !== directoryOffset + directorySize) fail("longitud del directorio central inconsistente.");
  }

  has(path: string): boolean { return this.entries.has(path); }

  async text(path: string): Promise<string> {
    const entry = this.entries.get(path);
    if (!entry) return fail("falta el recurso " + path);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const at = entry.localOffset;
    if (at + 30 > this.bytes.length || view.getUint32(at, true) !== 0x04034b50) fail("cabecera local inválida para " + path);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const start = at + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > this.bytes.length) fail("datos truncados para " + path);
    const compressed = this.bytes.subarray(start, end);
    const raw = entry.method === 0 ? compressed : await inflateRaw(compressed);
    if (raw.byteLength !== entry.expandedSize) fail("longitud descomprimida inconsistente para " + path);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(raw); }
    catch { return fail("texto UTF-8 inválido en " + path); }
  }

  paths(): string[] { return [...this.entries.keys()]; }
}

function blocksFromXhtml(xhtml: string, path: string, spineIndex: number, startSequence: number): BookReaderBlock[] {
  const result: BookReaderBlock[] = [];
  const stack: string[] = [];
  let current: string[] = [];
  let currentKind: "paragraph" | "poem-line" | "footnote" | "chapter-heading" | "section-heading" | undefined;
  let blockNumber = 0;
  const emit = () => {
    const text = decodeEntities(current.join("").replace(/\s+/gu, " ").trim());
    if (text && currentKind) {
      const sequence = startSequence + result.length;
      const location: BookReaderLocation = {
        locator: path + "#block-" + blockNumber,
        spineIndex, sectionIndex: blockNumber
      };
      result.push({
        blockId: "epub:" + path + ":" + blockNumber,
        sequence,
        kind: currentKind,
        text,
        location
      });
    }
    current = [];
    currentKind = undefined;
    blockNumber++;
  };
  const tokens = xhtml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<[^>]+>|[^<]+/gu) ?? [];
  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<!")) continue;
    if (!token.startsWith("<")) {
      if (currentKind) current.push(token);
      continue;
    }
    const closing = /^<\s*\//u.test(token);
    const tagMatch = /^<\s*\/?\s*([\w:-]+)/u.exec(token);
    if (!tagMatch) continue;
    const tag = tagMatch[1].toLowerCase();
    if (closing) {
      if (["p","div","li","blockquote","pre","h1","h2","h3","h4","h5","h6"].includes(tag)) emit();
      if (["aside","footer"].includes(tag)) emit();
      const pos = stack.lastIndexOf(tag);
      if (pos >= 0) stack.splice(pos, 1);
      continue;
    }
    const attrs = attributes(token);
    if (["script","style","svg","math"].includes(tag)) { stack.push(tag); continue; }
    if (stack.some(item => ["script","style","svg","math"].includes(item))) {
      if (!token.endsWith("/>")) stack.push(tag);
      continue;
    }
    const role = (attrs.get("epub:type") ?? attrs.get("role") ?? "").toLowerCase();
    const classes = (attrs.get("class") ?? "").toLowerCase();
    if (["p","div","li","blockquote","pre"].includes(tag) ||
        /^h[1-6]$/u.test(tag) || tag === "br") {
      emit();
      currentKind = /^h1$/u.test(tag) ? "chapter-heading" :
        /^h[2-6]$/u.test(tag) ? "section-heading" :
        (role.includes("footnote") || classes.includes("footnote") ? "footnote" :
          (tag === "pre" || role.includes("verse") || classes.includes("verse") ? "poem-line" : "paragraph"));
      if (tag === "br") emit();
    }
    if (!token.endsWith("/>") && !["meta","link","img","br","hr","input","source","wbr"].includes(tag)) stack.push(tag);
  }
  emit();
  return result;
}

export class EpubBookReader implements BookReaderAdapter<ArrayBuffer | Uint8Array> {
  readonly format = "epub";
  private readonly limits: EpubReaderLimits;

  constructor(limits: EpubReaderLimits = {}) { this.limits = limits; }

  private async archive(source: ArrayBuffer | Uint8Array): Promise<{ zip: EpubArchive; opfPath: string; opf: string; spine: string[]; metadata: EpubMetadata; warnings: string[] }> {
    const zip = await EpubArchive.open(source, this.limits);
    if (!zip.has("mimetype")) fail("falta la entrada mimetype.");
    const mime = (await zip.text("mimetype")).trim();
    if (mime !== "application/epub+zip") fail("mimetype no identifica un EPUB.");
    const container = await zip.text("META-INF/container.xml");
    const rootfile = /<rootfile\b([^>]*)\/?\s*>/iu.exec(container);
    if (!rootfile) fail("container.xml no declara rootfile.");
    const rootAttrs = attributes(rootfile[1]);
    const opfPath = safePath(rootAttrs.get("full-path") ?? "");
    const opf = await zip.text(opfPath);
    const manifest = new Map<string, string>();
    const itemPattern = /<item\b([^>]*)\/?\s*>/giu;
    for (const match of opf.matchAll(itemPattern)) {
      const attrs = attributes(match[1]);
      const id = attrs.get("id"), href = attrs.get("href");
      if (id && href) {
        if (manifest.has(id)) fail("ID duplicado en manifest: " + id);
        manifest.set(id, resolvePath(opfPath, href));
      }
    }
    const spineSection = /<spine\b[^>]*>([\s\S]*?)<\/spine\s*>/iu.exec(opf)?.[1];
    if (!spineSection) fail("el OPF no contiene spine.");
    const spine: string[] = [];
    for (const match of spineSection.matchAll(/<itemref\b([^>]*)\/?\s*>/giu)) {
      const idref = attributes(match[1]).get("idref");
      if (!idref || !manifest.has(idref)) fail("itemref no resuelto: " + (idref ?? "(vacío)"));
      spine.push(manifest.get(idref)!);
    }
    if (!spine.length) fail("el spine está vacío.");
    const warnings: string[] = [];
    const uniqueSpine = new Set(spine);
    if (uniqueSpine.size !== spine.length) warnings.push("El spine referencia documentos repetidos.");
    const metadata: EpubMetadata = {
      ...(xmlText(opf, "title") ? { title: xmlText(opf, "title") } : {}),
      ...(xmlText(opf, "creator") ? { author: xmlText(opf, "creator") } : {}),
      ...(xmlText(opf, "language") ? { language: xmlText(opf, "language") } : {}),
      ...(xmlText(opf, "identifier") ? { identifier: xmlText(opf, "identifier") } : {})
    };
    return { zip, opfPath, opf, spine, metadata, warnings };
  }

  async inspect(source: ArrayBuffer | Uint8Array): Promise<EpubInspection> {
    const data = await this.archive(source);
    return { metadata: data.metadata, spineItems: data.spine.length, warnings: data.warnings };
  }

  async *read(source: ArrayBuffer | Uint8Array, signal?: AbortSignal): AsyncIterable<BookReaderBlock> {
    const data = await this.archive(source);
    let sequence = 0;
    if (data.metadata.title) {
      yield { blockId: "epub:book-title", sequence: sequence++, kind: "book-title", text: data.metadata.title };
    }
    for (let index = 0; index < data.spine.length; index++) {
      if (signal?.aborted) throw new DOMException("La lectura EPUB fue cancelada.", "AbortError");
      const path = data.spine[index];
      if (!data.zip.has(path)) fail("falta un documento del spine: " + path);
      const xhtml = await data.zip.text(path);
      for (const block of blocksFromXhtml(xhtml, path, index, sequence)) {
        yield block;
        sequence = block.sequence + 1;
      }
    }
  }
}

export const createEpubBookReader = (limits: EpubReaderLimits = {}): EpubBookReader =>
  new EpubBookReader(limits);
