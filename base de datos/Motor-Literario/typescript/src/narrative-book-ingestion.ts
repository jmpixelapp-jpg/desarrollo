import {
  extractNarrativeEntities,
  extractNarrativeEvents,
  type NarrativeEntity,
  type NarrativeEvent
} from "./narrative-knowledge";
import {
  discoverNarrativeObservationCandidates,
  MAX_NARRATIVE_OBSERVATION_TEXT_UNITS,
  type NarrativeObservationCandidate
} from "./narrative-observation-discovery";
import {
  discoverNarrativeActionLinks,
  type NarrativeActionLinkCandidate
} from "./narrative-action-link-discovery";

/**
 * Ingesta estructural de texto de libros para el Motor Literario.
 *
 * Recibe texto ya decodificado por el anfitrión (TXT/EPUB/PDF/DOCX deben
 * resolverse en sus adaptadores de entrada). No inventa hechos: cada señal
 * conserva el fragmento literal y offsets UTF-16 absolutos del texto fuente.
 */
export const MAX_NARRATIVE_BOOK_TEXT_UNITS = 5_000_000;
export const MAX_NARRATIVE_BOOK_CHAPTERS = 2_000;
export const MAX_NARRATIVE_BOOK_PARAGRAPHS = 100_000;
export const MAX_NARRATIVE_BOOK_SIGNALS = 20_000;

export interface NarrativeBookIngestionInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly title?: string;
  readonly language?: string;
  readonly baseOffset?: number;
  /** Fichas ya identificadas del mismo libro para enriquecer acciones con menciones verificables. */
  readonly entities?: readonly NarrativeEntity[];
}

export interface NarrativeBookEvidence {
  readonly documentId: string;
  readonly revision: number;
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
}

export interface NarrativeBookChapter {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly heading: string | null;
  readonly start: number;
  readonly end: number;
  readonly paragraphCount: number;
  readonly wordCount: number;
  readonly evidence: NarrativeBookEvidence;
}

export interface NarrativeBookParagraph {
  readonly id: string;
  readonly chapterId: string;
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly kind: "narration" | "dialogue" | "mixed";
}

export interface NarrativeBookSignal {
  readonly id: string;
  readonly chapterId: string;
  readonly paragraphId: string;
  readonly kind: "action" | "temporal-reference" | "causal-marker" | "contrast-marker";
  readonly label: string;
  readonly surface: string;
  readonly polarity: "affirmed" | "negated" | "unknown";
  readonly evidence: NarrativeBookEvidence;
  /** Señal lingüística candidata; no equivale a un acontecimiento confirmado. */
  readonly requiresReview: true;
}

export interface NarrativeBookIngestionResult {
  readonly version: 1;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly title: string;
  readonly language: string;
  readonly sourceLength: number;
  readonly chapters: readonly NarrativeBookChapter[];
  readonly paragraphs: readonly NarrativeBookParagraph[];
  readonly signals: readonly NarrativeBookSignal[];
  /** Acontecimientos declarados explícitamente con ACONTECIMIENTO:/EVENTO:; no inferidos. */
  readonly eventCandidates: readonly NarrativeEvent[];
  /** Entidades nombradas explícitamente con etiquetas como «Personaje Ana»; candidatas, no confirmadas. */
  readonly entityCandidates: readonly NarrativeEntity[];
  /** Acciones vinculadas a entidades conocidas; siguen siendo candidatos revisables. */
  readonly observations: readonly NarrativeObservationCandidate[];
  /** Vínculos temporales/causales/contrastivos explícitos entre acciones; requieren revisión. */
  readonly actionLinks: readonly NarrativeActionLinkCandidate[];
  readonly observationStatus: "extracted" | "no-entities" | "omitted-text-budget";
  readonly coverage: {
    readonly chapterCount: number;
    readonly paragraphCount: number;
    readonly wordCount: number;
    readonly signalCount: number;
    readonly omittedSignals: number;
    readonly truncated: boolean;
  };
}

interface Span { start: number; end: number; text: string; }

const CHAPTER_HEADING = /^\s*(?:#{1,6}\s*)?(?:(?:cap[ií]tulo|chapter|parte|part|libro|book)\s+(?:[ivxlcdm]+|\d+|[a-záéíóúñ-]+)(?:\s*[:.—-]\s*.*)?|pr[oó]logo|ep[ií]logo|introducci[oó]n|interludio)\s*$/iu;
const ACTIONS: readonly { label: string; expression: RegExp }[] = [
  { label: "death", expression: /(?<![\p{L}\p{M}\p{N}_])(?:muri[oó]|falleci[oó]|mat[oó]|asesin[oó]|pereci[oó])(?![\p{L}\p{M}\p{N}_])/giu },
  { label: "arrival", expression: /(?<![\p{L}\p{M}\p{N}_])(?:lleg(?:o|as|a|an|amos|ué|aste|ó|aron|aba|abas|ábamos|aban|aré|ará|arás|aremos|arán|aría|arías|aríamos|arían|ar|ando|ado)|arrib(?:o|as|a|an|amos|é|ó|aron|aba|aban|ará|arán|ar|ando|ado)|regres(?:o|as|a|an|amos|é|ó|aste|aron|aba|aban|ará|arán|ar|ando|ado)|volv(?:ió|ieron|ía|ías|íamos|ían|er|erá|erán|ería|erían|iendo|ido))(?![\p{L}\p{M}\p{N}_])/giu },
  { label: "departure", expression: /(?<![\p{L}\p{M}\p{N}_])(?:parti[oó]|sali[oó]|huy[oó]|escap[oó])(?![\p{L}\p{M}\p{N}_])/giu },
  { label: "discovery", expression: /(?<![\p{L}\p{M}\p{N}_])(?:descubri[oó]|encontr[oó]|hall[oó]|revel[oó])(?![\p{L}\p{M}\p{N}_])/giu },
  { label: "decision", expression: /(?<![\p{L}\p{M}\p{N}_])(?:decidi[oó]|resolvi[oó]|acept[oó]|rechaz[oó])(?![\p{L}\p{M}\p{N}_])/giu },
  { label: "conflict", expression: /(?<![\p{L}\p{M}\p{N}_])(?:atac[oó]|golpe[oó]|luch[oó]|combati[oó]|traicion[oó])(?![\p{L}\p{M}\p{N}_])/giu },
  { label: "communication", expression: /(?<![\p{L}\p{M}\p{N}_])(?:dijo|declar[oó]|confes[oó]|pregunt[oó]|respondi[oó]|advirti[oó])(?![\p{L}\p{M}\p{N}_])/giu },
  { label: "movement", expression: /(?<![\p{L}\p{M}\p{N}_])(?:entr(?:o|as|a|an|amos|é|ó|aste|aron|aba|abas|ábamos|aban|ará|arán|ar|ando|ado)|cruz(?:o|as|a|an|amos|é|ó|aste|aron|aba|abas|ábamos|aban|ará|arán|ar|ando|ado)|camin(?:o|as|a|an|amos|é|ó|aste|aron|aba|abas|ábamos|aban|ará|arán|ar|ando|ado)|corr(?:o|es|e|en|emos|í|ió|iste|ieron|ía|ías|íamos|ían|er|erá|erán|iendo|ido)|sub(?:o|es|e|en|imos|í|ió|iste|ieron|ía|ías|íamos|ían|ir|irá|irán|iendo|ido)|baj(?:o|as|a|an|amos|é|ó|aste|aron|aba|abas|ábamos|aban|ará|arán|ar|ando|ado))(?![\p{L}\p{M}\p{N}_])/giu }
];
const TEMPORAL: readonly { label: string; expression: RegExp }[] = [
  { label: "explicit-date", expression: /\b(?:el\s+)?\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/giu },
  { label: "year", expression: /\b(?:en\s+)?(?:1[0-9]{3}|20[0-9]{2})\b/gu },
  { label: "relative-time", expression: /\b(?:antes|despu[eé]s|mientras|entonces|luego|posteriormente|al\s+d[ií]a\s+siguiente|esa\s+noche|a\s+la\s+ma[nñ]ana\s+siguiente|una\s+semana\s+despu[eé]s)\b/giu }
];
const CAUSAL: readonly { label: string; expression: RegExp }[] = [
  { label: "cause", expression: /\b(?:porque|ya\s+que|puesto\s+que|debido\s+a|a\s+causa\s+de)\b/giu },
  { label: "consequence", expression: /\b(?:por\s+eso|por\s+lo\s+tanto|por\s+consiguiente|as[ií]\s+que|de\s+modo\s+que|en\s+consecuencia)\b/giu },
  { label: "condition", expression: /\b(?:si|a\s+menos\s+que|siempre\s+que)\b/giu }
];
const CONTRAST: readonly { label: string; expression: RegExp }[] = [
  { label: "contrast", expression: /\b(?:pero|sin\s+embargo|no\s+obstante|aunque|en\s+cambio|por\s+el\s+contrario)\b/giu }
];

function validate(input: NarrativeBookIngestionInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_NARRATIVE_BOOK_TEXT_UNITS ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
         input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length)) ||
      (input.title !== undefined && typeof input.title !== "string") ||
      (input.language !== undefined && typeof input.language !== "string") ||
      (input.entities !== undefined && !Array.isArray(input.entities))) {
    throw new Error("Entrada inválida para la ingesta del libro.");
  }
  for (const entity of input.entities ?? []) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() ||
        typeof entity.kind !== "string" ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        !Array.isArray(entity.aliases)) {
      throw new Error("La ingesta recibió entidades inválidas o pertenecientes a otro libro.");
    }
  }
}

function evidence(input: NarrativeBookIngestionInput, start: number, end: number): NarrativeBookEvidence {
  const base = input.baseOffset ?? 0;
  return {
    documentId: input.documentId,
    revision: input.revision,
    start: base + start,
    end: base + end,
    excerpt: input.text.slice(start, end)
  };
}

function splitLines(text: string): Span[] {
  const result: Span[] = [];
  const expression = /[^\r\n]+/gu;
  for (const match of text.matchAll(expression)) {
    const start = match.index ?? 0;
    const value = match[0];
    if (value.trim()) result.push({ start, end: start + value.length, text: value });
  }
  return result;
}

function countWords(text: string): number {
  return (text.match(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}]+)*/gu) ?? []).length;
}

function classifyParagraph(text: string): NarrativeBookParagraph["kind"] {
  const hasDialogue = /[«»“”„]|(?:^|\s)[—–-]\s*\p{Lu}/mu.test(text);
  const withoutDialogue = text.replace(/[«“„][^»”]+[»”]/gu, "").replace(/(?:^|\n)\s*[—–-].*$/gmu, "");
  const hasNarration = /\p{L}/u.test(withoutDialogue);
  return hasDialogue && hasNarration ? "mixed" : hasDialogue ? "dialogue" : "narration";
}

function isActionNegated(text: string, actionStart: number, paragraphStart: number): boolean {
  const prefix = text.slice(paragraphStart, actionStart);
  const boundary = Math.max(
    prefix.lastIndexOf("."),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf("\n")
  );
  const clausePrefix = prefix.slice(boundary + 1);
  return /(?:^|[\s(])(?:no|nunca|jamás|tampoco)(?:\s+[\p{L}\p{M}]+){0,2}\s*$/iu.test(clausePrefix);
}

function collectSignals(
  input: NarrativeBookIngestionInput,
  chapterId: string,
  paragraph: NarrativeBookParagraph,
  output: NarrativeBookSignal[]
): number {
  const matches: { index: number; end: number; kind: NarrativeBookSignal["kind"]; label: string; surface: string }[] = [];
  const groups = [
    { kind: "action" as const, entries: ACTIONS },
    { kind: "temporal-reference" as const, entries: TEMPORAL },
    { kind: "causal-marker" as const, entries: CAUSAL },
    { kind: "contrast-marker" as const, entries: CONTRAST }
  ];
  for (const group of groups) for (const item of group.entries) {
    item.expression.lastIndex = 0;
    for (const match of paragraph.text.matchAll(item.expression)) {
      const surface = match[0];
      const index = match.index ?? 0;
      matches.push({ index, end: index + surface.length, kind: group.kind, label: item.label, surface });
    }
  }
  matches.sort((a, b) => a.index - b.index || a.end - b.end || a.kind.localeCompare(b.kind));
  let omitted = 0;
  for (const match of matches) {
    if (output.length >= MAX_NARRATIVE_BOOK_SIGNALS) { omitted++; continue; }
    const start = paragraph.start + match.index;
    const end = paragraph.start + match.end;
    const contextStart = Math.max(paragraph.start, start - 100);
    const contextEnd = Math.min(paragraph.end, end + 100);
    const negated = match.kind === "action" && isActionNegated(input.text, start, paragraph.start);
    output.push({
      id: "nbs-" + input.documentId + "-" + input.revision + "-" + (input.baseOffset ?? 0) + "-" + start + "-" + match.kind,
      chapterId,
      paragraphId: paragraph.id,
      kind: match.kind,
      label: match.label,
      surface: match.surface,
      polarity: negated ? "negated" : match.kind === "action" ? "affirmed" : "unknown",
      evidence: evidence(input, contextStart, contextEnd),
      requiresReview: true
    });
  }
  return omitted;
}

export const MAX_NARRATIVE_BOOK_FILE_BYTES = 20_000_000;

export interface NarrativeBookFileInput {
  readonly name: string;
  readonly type?: string;
  readonly size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface NarrativeBookTextSource {
  readonly fileName: string;
  readonly mediaType: "text/plain" | "text/markdown";
  readonly byteLength: number;
  readonly text: string;
}

/**
 * Lee archivos TXT/Markdown reales usando APIs estándar del entorno.
 * No intenta interpretar formatos binarios ni sustituye adaptadores EPUB/PDF/DOCX.
 */
export async function readNarrativeBookFile(file: NarrativeBookFileInput): Promise<NarrativeBookTextSource> {
  if (!file || typeof file !== "object" ||
      typeof file.name !== "string" || !file.name.trim() ||
      typeof file.arrayBuffer !== "function" ||
      (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 0))) {
    throw new Error("Archivo de libro inválido.");
  }
  const normalizedName = file.name.trim().toLowerCase();
  const markdown = /\.(?:md|markdown)$/u.test(normalizedName);
  const plainText = /\.txt$/u.test(normalizedName);
  if (!markdown && !plainText) {
    throw new Error("Formato no admitido: esta etapa acepta archivos TXT y Markdown.");
  }
  const mediaType = markdown ? "text/markdown" : "text/plain";
  const declaredType = (file.type ?? "").split(";")[0]!.trim().toLowerCase();
  const acceptedTypes = new Set(["", "text/plain", "text/markdown", "text/x-markdown", "application/octet-stream"]);
  if (!acceptedTypes.has(declaredType)) {
    throw new Error("El tipo MIME del archivo no coincide con un documento de texto admitido.");
  }
  if (file.size !== undefined && file.size > MAX_NARRATIVE_BOOK_FILE_BYTES) {
    throw new Error("El archivo supera el límite de tamaño de la ingesta.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_NARRATIVE_BOOK_FILE_BYTES) {
    throw new Error("El archivo supera el límite de tamaño de la ingesta.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("El archivo no contiene texto UTF-8 válido.");
  }
  if (text.includes("\u0000")) {
    throw new Error("El archivo contiene bytes nulos y no parece ser texto.");
  }
  return { fileName: file.name, mediaType, byteLength: bytes.byteLength, text };
}

/**
 * Convierte texto de libro en unidades estructurales y señales revisables.
 * No afirma quién ejecutó una acción ni transforma marcadores causales en
 * relaciones causales confirmadas: entrega evidencia para etapas posteriores.
 */
export function ingestNarrativeBookText(input: NarrativeBookIngestionInput): NarrativeBookIngestionResult {
  validate(input);
  const lines = splitLines(input.text);
  const headings = lines.filter(line => CHAPTER_HEADING.test(line.text.trim()));
  const chapterStarts = headings.length ? headings : [];
  const chapters: NarrativeBookChapter[] = [];
  const paragraphs: NarrativeBookParagraph[] = [];
  const signals: NarrativeBookSignal[] = [];
  let omittedSignals = 0;
  let paragraphIndex = 0;

  const boundaries = chapterStarts.length
    ? chapterStarts.map((line, index) => ({ line, index })).map(({ line, index }) => ({
        start: line.start,
        end: chapterStarts[index + 1]?.start ?? input.text.length,
        heading: line.text.trim().replace(/^#{1,6}\s*/u, ""),
        contentStart: line.end
      }))
    : [{ start: 0, end: input.text.length, heading: "", contentStart: 0 }];

  if (boundaries.length > MAX_NARRATIVE_BOOK_CHAPTERS) {
    throw new Error("El libro supera el máximo de capítulos admitido.");
  }

  for (let chapterIndex = 0; chapterIndex < boundaries.length; chapterIndex++) {
    const boundary = boundaries[chapterIndex]!;
    const chapterId = "nbc-" + input.documentId + "-" + input.revision + "-" + chapterIndex;
    const chapterLines = lines.filter(line => line.start >= boundary.contentStart && line.start < boundary.end);
    const chapterParagraphs: NarrativeBookParagraph[] = [];
    let pending: Span | undefined;
    const flush = () => {
      if (!pending) return;
      if (paragraphs.length >= MAX_NARRATIVE_BOOK_PARAGRAPHS) return;
      const paragraph: NarrativeBookParagraph = {
        id: "nbp-" + input.documentId + "-" + input.revision + "-" + paragraphIndex++,
        chapterId,
        index: chapterParagraphs.length,
        start: (input.baseOffset ?? 0) + pending.start,
        end: (input.baseOffset ?? 0) + pending.end,
        text: pending.text,
        kind: classifyParagraph(pending.text)
      };
      chapterParagraphs.push(paragraph);
      paragraphs.push(paragraph);
      omittedSignals += collectSignals(input, chapterId, { ...paragraph, start: pending.start, end: pending.end }, signals);
      pending = undefined;
    };
    for (const line of chapterLines) {
      if (pending && /(?:\r?\n)[ \t]*(?:\r?\n)/u.test(input.text.slice(pending.end, line.start))) flush();
      if (!pending) pending = { ...line };
      else pending = { start: pending.start, end: line.end, text: pending.text + "\n" + line.text };
    }
    flush();
    const contentText = input.text.slice(boundary.contentStart, boundary.end);
    const heading = boundary.heading || (boundaries.length === 1 ? (input.title?.trim() || "Texto completo") : "Capítulo " + (chapterIndex + 1));
    const start = boundary.start;
    const end = boundary.end;
    chapters.push({
      id: chapterId,
      index: chapterIndex,
      title: heading,
      heading: boundary.heading || null,
      start: (input.baseOffset ?? 0) + start,
      end: (input.baseOffset ?? 0) + end,
      paragraphCount: chapterParagraphs.length,
      wordCount: countWords(contentText),
      evidence: evidence(input, start, end)
    });
  }

  const totalWords = countWords(input.text);
  // Solo promueve nombres a candidatos cuando el propio texto aporta una etiqueta explícita.
  // No intenta adivinar nombres propios a partir de mayúsculas aisladas.
  const entityCandidates = (input.entities?.length ?? 0) === 0 &&
      input.text.length <= MAX_NARRATIVE_OBSERVATION_TEXT_UNITS
    ? extractNarrativeEntities(
        input.projectId,
        input.documentId,
        input.revision,
        input.text,
        Date.now(),
        input.baseOffset ?? 0
      )
    : [];
  const entitiesForObservation = (input.entities?.length ?? 0) > 0
    ? input.entities!
    : entityCandidates;
  const hasEntities = entitiesForObservation.length > 0;
  const observationStatus = input.text.length > MAX_NARRATIVE_OBSERVATION_TEXT_UNITS
    ? "omitted-text-budget" as const
    : !hasEntities ? "no-entities" as const
    : "extracted" as const;
  const observations = observationStatus === "extracted"
    ? discoverNarrativeObservationCandidates({
        projectId: input.projectId,
        documentId: input.documentId,
        revision: input.revision,
        text: input.text,
        entities: entitiesForObservation,
        baseOffset: input.baseOffset ?? 0
      })
    : [];
  const actionLinks = observations.length > 1
    ? discoverNarrativeActionLinks({
        projectId: input.projectId,
        documentId: input.documentId,
        revision: input.revision,
        text: input.text,
        observations,
        baseOffset: input.baseOffset ?? 0
      })
    : [];
  // Los acontecimientos se extraen solo cuando el escritor usa una etiqueta explícita.
  // Las entidades locales sirven para sugerir participantes, nunca para confirmar roles.
  const eventCandidates = input.text.length <= MAX_NARRATIVE_BOOK_TEXT_UNITS
    ? extractNarrativeEvents(
        input.projectId,
        input.documentId,
        input.revision,
        input.text,
        entitiesForObservation,
        input.baseOffset ?? 0
      )
    : [];
  return {
    version: 1,
    projectId: input.projectId,
    documentId: input.documentId,
    revision: input.revision,
    title: input.title?.trim() || "Libro sin título",
    language: input.language?.trim() || "und",
    sourceLength: input.text.length,
    chapters,
    paragraphs,
    signals,
    entityCandidates,
    observations,
    actionLinks,
    eventCandidates,
    observationStatus,
    coverage: {
      chapterCount: chapters.length,
      paragraphCount: paragraphs.length,
      wordCount: totalWords,
      signalCount: signals.length,
      omittedSignals,
      truncated: paragraphs.length >= MAX_NARRATIVE_BOOK_PARAGRAPHS || omittedSignals > 0
    }
  };
}
