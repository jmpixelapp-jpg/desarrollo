/**
 * Análisis literario descriptivo y determinista.
 * No afirma intención autoral, identidad del narrador ni calidad estética.
 * Las ocurrencias conservan offsets UTF-16 absolutos para inspección editorial.
 */
export const MAX_LITERARY_ANALYSIS_TEXT_UNITS = 2_000_000;

export interface LiteraryAnalysisInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly baseOffset?: number;
}
export interface LiteraryAnalysisOccurrence { readonly start: number; readonly end: number; }
export interface LiteraryRepeatedWord {
  readonly word: string;
  readonly count: number;
  readonly occurrences: readonly LiteraryAnalysisOccurrence[];
}
export interface LiterarySentenceOpening {
  readonly opening: string;
  readonly count: number;
  readonly occurrences: readonly LiteraryAnalysisOccurrence[];
}
export interface LiteraryAnaphoraCandidate {
  readonly phrase: string;
  /** Índices 1-based de las oraciones consecutivas dentro del fragmento. */
  readonly sentenceIndexes: readonly number[];
  readonly occurrences: readonly LiteraryAnalysisOccurrence[];
}
export type LiterarySensoryModality = "visual" | "auditory" | "tactile" | "olfactory" | "gustatory";
export interface LiterarySensorySignal {
  readonly modality: LiterarySensoryModality;
  readonly count: number;
  readonly occurrences: readonly LiteraryAnalysisOccurrence[];
}
export interface LiteraryVoiceSignalCounts {
  readonly firstPerson: number;
  readonly secondPerson: number;
  readonly thirdPerson: number;
}
export type LiteraryVoiceSignalClassification =
  | "first-person-signals" | "second-person-signals" | "third-person-signals"
  | "mixed-signals" | "undetermined";
export interface LiteraryVoiceSignal {
  readonly classification: LiteraryVoiceSignalClassification;
  readonly counts: LiteraryVoiceSignalCounts;
  readonly samples: readonly {
    readonly category: "firstPerson" | "secondPerson" | "thirdPerson";
    readonly term: string;
    readonly start: number;
    readonly end: number;
  }[];
}
export interface LiteraryAnalysisMetrics {
  readonly characterCount: number;
  readonly letterCount: number;
  readonly wordCount: number;
  readonly sentenceCount: number;
  readonly paragraphCount: number;
  readonly averageWordsPerSentence: number;
  readonly medianWordsPerSentence: number;
  /** Desviación estándar poblacional de la longitud de las oraciones. */
  readonly sentenceLengthStandardDeviation: number;
  readonly averageWordsPerParagraph: number;
  readonly lexicalDiversity: number;
  readonly dialogueWordCount: number;
  readonly dialogueRatio: number;
  readonly questionMarkCount: number;
  readonly exclamationMarkCount: number;
  readonly ellipsisCount: number;
  readonly shortestSentenceWords: number;
  readonly longestSentenceWords: number;
  readonly shortSentenceCount: number;
  readonly mediumSentenceCount: number;
  readonly longSentenceCount: number;
}
export interface LiteraryRhythmTransition {
  readonly beforeSentenceIndex: number;
  readonly afterSentenceIndex: number;
  readonly beforeWordCount: number;
  readonly afterWordCount: number;
  readonly direction: "acceleration" | "deceleration";
  /** Rango UTF-16 completo de ambas oraciones, ya desplazado al documento. */
  readonly occurrences: readonly [LiteraryAnalysisOccurrence, LiteraryAnalysisOccurrence];
}
export type LiteraryRhythmProfile = "fragmented" | "balanced" | "extended" | "insufficient-text";
export type LiteraryDialogueDensity = "none" | "low" | "moderate" | "high";
export interface LiteraryAnalysisResult {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly range: LiteraryAnalysisOccurrence;
  readonly metrics: LiteraryAnalysisMetrics;
  readonly rhythmProfile: LiteraryRhythmProfile;
  readonly rhythmTransitions: readonly LiteraryRhythmTransition[];
  readonly dialogueDensity: LiteraryDialogueDensity;
  readonly voiceSignals: LiteraryVoiceSignal;
  readonly repeatedWords: readonly LiteraryRepeatedWord[];
  readonly repeatedSentenceOpenings: readonly LiterarySentenceOpening[];
  readonly anaphoraCandidates: readonly LiteraryAnaphoraCandidate[];
  readonly sensorySignals: readonly LiterarySensorySignal[];
  readonly caveats: readonly string[];
}
interface LocalRange { readonly start: number; readonly end: number; }
interface WordToken extends LocalRange {
  readonly text: string;
  readonly normalized: string;
}
interface OccurrenceGroup {
  readonly key: string;
  readonly label: string;
  occurrences: LocalRange[];
}

const WORD_PATTERN = /[\p{L}\p{M}\p{N}]+(?:[’'][\p{L}\p{M}]+)?/gu;
const LETTER_PATTERN = /\p{L}/gu;
const SENTENCE_BOUNDARY_PATTERN = /[.!?…]+(?:["»”’)}\]]*)?(?=\s|$)/gu;
const PARAGRAPH_SEPARATOR_PATTERN = /\r?\n(?:[ \t]*\r?\n)+/gu;
const STOP_WORDS = new Set([
  "a","al","algo","algunas","algunos","ambos","ante","antes","aquel","aquella","aquellas",
  "aquello","aquellos","aqui","aquí","asi","así","aun","aunque","bajo","bien","cada","casi",
  "como","con","contra","cual","cuando","cuanta","cuantas","cuanto","cuantos","de","del",
  "desde","donde","dos","durante","e","el","ella","ellas","ello","ellos","en","entre","era",
  "erais","eran","eras","eres","es","esa","esas","ese","eso","esos","esta","estaba","estaban",
  "estado","estais","estamos","estan","estar","estas","este","esto","estos","estoy","fue",
  "fueron","ha","hace","hacia","han","hasta","hay","la","las","le","les","lo","los","mas",
  "más","me","mi","mis","mismo","misma","mucho","muy","nada","ni","no","nos","nosotras",
  "nosotros","nuestra","nuestras","nuestro","nuestros","o","os","otra","otras","otro","otros",
  "para","pero","poco","por","porque","que","qué","quien","quién","quienes","se","sea","ser",
  "si","sí","sin","sobre","sois","somos","son","soy","su","sus","tambien","también","tan",
  "tanto","te","tiene","tienen","todo","toda","todas","todos","tu","tú","tus","un","una",
  "unas","uno","unos","usted","ustedes","va","vais","vamos","van","varias","varios","y","ya"
]);
const FIRST_PERSON = new Set([
  "yo","me","mí","conmigo","nos","nosotros","nosotras","nuestro","nuestra","nuestros",
  "nuestras","mío","mía","míos","mías"
]);
const SECOND_PERSON = new Set([
  "tú","te","ti","contigo","vos","usted","ustedes","vosotros","vosotras","os",
  "vuestro","vuestra","vuestros","vuestras"
]);
const THIRD_PERSON = new Set(["él","ella","ellos","ellas"]);
const ABBREVIATIONS = new Set(["sr","sra","srta","dr","dra","prof","profa","etc","ej","núm","núms"]);

const SENSORY_LEXICON: Readonly<Record<LiterarySensoryModality, ReadonlySet<string>>> = {
  visual: new Set([
    "luz","brillo","brillaba","brillante","resplandor","sombra","oscuro","oscura",
    "claro","clara","ver","vio","mirar","miró","miraba","observó","observaba",
    "contempló","contemplaba","vista","ojo","ojos","color","colores"
  ]),
  auditory: new Set([
    "sonido","ruido","voz","voces","silencio","susurro","susurró","susurraba",
    "grito","gritó","gritaba","eco","resonó","resonaba","escuchó","escuchaba",
    "oyó","oía","oír","oir","escuchar","sonó","sonaba","murmuró","murmuraba"
  ]),
  tactile: new Set([
    "piel","frío","fria","fría","calor","caliente","helado","helada","suave",
    "áspero","áspera","aspero","aspera","rugoso","rugosa","textura","tocó",
    "tocaba","acarició","acariciaba","dolor","ardor","húmedo","húmeda","humedo","humeda"
  ]),
  olfactory: new Set([
    "olor","aroma","perfume","fragancia","hedor","apestaba","olió","olia","olía",
    "oler","olfato","huele","olía"
  ]),
  gustatory: new Set([
    "sabor","dulce","amargo","amarga","salado","salada","ácido","ácida","acido",
    "acida","agrio","agria","saboreó","saboreaba","saborear","degustó","degustaba"
  ])
};
const SENSORY_MODALITIES: readonly LiterarySensoryModality[] = [
  "visual","auditory","tactile","olfactory","gustatory"
];


function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
function tokenize(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    const value = match[0];
    const start = match.index ?? 0;
    tokens.push({
      start, end: start + value.length, text: value,
      normalized: value.normalize("NFKC").toLocaleLowerCase("es")
    });
  }
  return tokens;
}
function trimRange(text: string, start: number, end: number): LocalRange | undefined {
  while (start < end && /\s/u.test(text[start] ?? "")) start++;
  while (end > start && /\s/u.test(text[end - 1] ?? "")) end--;
  return start < end ? { start, end } : undefined;
}
function isAbbreviationBoundary(text: string, sentenceStart: number, punctuationIndex: number): boolean {
  const before = text.slice(sentenceStart, punctuationIndex + 1);
  const token = before.match(/([\p{L}]+)\.$/u)?.[1]?.toLocaleLowerCase("es");
  return (token !== undefined && ABBREVIATIONS.has(token)) || /\b\p{Lu}\.$/u.test(before);
}
function isDecimalPoint(text: string, index: number): boolean {
  return /\p{N}/u.test(text[index - 1] ?? "") && /\p{N}/u.test(text[index + 1] ?? "");
}
function findSentenceRanges(text: string): LocalRange[] {
  const ranges: LocalRange[] = [];
  let cursor = 0;
  for (const match of text.matchAll(SENTENCE_BOUNDARY_PATTERN)) {
    const boundaryStart = match.index ?? 0;
    const punctuation = match[0].match(/[.!?…]+/u)?.[0] ?? "";
    if (punctuation === "." &&
        (isAbbreviationBoundary(text, cursor, boundaryStart) ||
         (punctuation.length === 1 && isDecimalPoint(text, boundaryStart)))) continue;
    const end = boundaryStart + match[0].length;
    const range = trimRange(text, cursor, end);
    if (range && tokenize(text.slice(range.start, range.end)).length > 0) ranges.push(range);
    cursor = end;
  }
  const tail = trimRange(text, cursor, text.length);
  if (tail && tokenize(text.slice(tail.start, tail.end)).length > 0) ranges.push(tail);
  return ranges;
}
function findParagraphRanges(text: string): LocalRange[] {
  const ranges: LocalRange[] = [];
  let cursor = 0;
  for (const match of text.matchAll(PARAGRAPH_SEPARATOR_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const range = trimRange(text, cursor, start);
    if (range) ranges.push(range);
    cursor = end;
  }
  const tail = trimRange(text, cursor, text.length);
  if (tail) ranges.push(tail);
  return ranges;
}
function mergeRanges(ranges: readonly LocalRange[]): LocalRange[] {
  const ordered = [...ranges].filter(range => range.end > range.start)
    .sort((a,b) => a.start - b.start || a.end - b.end);
  const merged: LocalRange[] = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
    } else merged.push(range);
  }
  return merged;
}
function findDialogueRanges(text: string): LocalRange[] {
  const ranges: LocalRange[] = [];
  const quoted = /«([^»]+)»|“([^”]+)”|"([^"]+)"/gu;
  for (const match of text.matchAll(quoted)) {
    const content = match[1] ?? match[2] ?? match[3] ?? "";
    if (!content) continue;
    const start = (match.index ?? 0) + match[0].indexOf(content);
    ranges.push({ start, end: start + content.length });
  }
  const dashDialogue = /^[ \t]*[—–][ \t]*(.+)$/gmu;
  for (const match of text.matchAll(dashDialogue)) {
    const content = match[1] ?? "";
    if (!content) continue;
    const start = (match.index ?? 0) + match[0].indexOf(content);
    ranges.push({ start, end: start + content.length });
  }
  return mergeRanges(ranges);
}
function countTokensPerRange(tokens: readonly WordToken[], ranges: readonly LocalRange[]): number[] {
  let tokenIndex = 0;
  const counts: number[] = [];
  for (const range of ranges) {
    while (tokenIndex < tokens.length && tokens[tokenIndex]!.end <= range.start) tokenIndex++;
    let cursor = tokenIndex;
    let count = 0;
    while (cursor < tokens.length && tokens[cursor]!.start < range.end) {
      if (tokens[cursor]!.end > range.start) count++;
      cursor++;
    }
    counts.push(count);
    tokenIndex = cursor;
  }
  return counts;
}
function countTokensInRanges(tokens: readonly WordToken[], ranges: readonly LocalRange[]): number {
  return countTokensPerRange(tokens, ranges).reduce((total, count) => total + count, 0);
}
function classifyVoiceSignals(
  tokens: readonly WordToken[], dialogueRanges: readonly LocalRange[], baseOffset: number
): LiteraryVoiceSignal {
  const counts = { firstPerson: 0, secondPerson: 0, thirdPerson: 0 };
  const samples: LiteraryVoiceSignal["samples"][number][] = [];
  let rangeIndex = 0;
  for (const token of tokens) {
    while (rangeIndex < dialogueRanges.length && dialogueRanges[rangeIndex]!.end <= token.start) rangeIndex++;
    const activeRange = dialogueRanges[rangeIndex];
    if (activeRange && token.start < activeRange.end && token.end > activeRange.start) continue;
    let category: "firstPerson" | "secondPerson" | "thirdPerson" | undefined;
    if (FIRST_PERSON.has(token.normalized)) category = "firstPerson";
    else if (SECOND_PERSON.has(token.normalized)) category = "secondPerson";
    else if (THIRD_PERSON.has(token.normalized)) category = "thirdPerson";
    if (!category) continue;
    counts[category]++;
    if (samples.length < 40) samples.push({
      category, term: token.text, start: baseOffset + token.start, end: baseOffset + token.end
    });
  }
  const active = Object.entries(counts).filter(([,count]) => count > 0).map(([key]) => key);
  let classification: LiteraryVoiceSignalClassification = "undetermined";
  if (active.length > 1) classification = "mixed-signals";
  else if (active[0] === "firstPerson") classification = "first-person-signals";
  else if (active[0] === "secondPerson") classification = "second-person-signals";
  else if (active[0] === "thirdPerson") classification = "third-person-signals";
  return { classification, counts, samples };
}
function toAbsoluteOccurrences(
  ranges: readonly LocalRange[], baseOffset: number, limit: number
): LiteraryAnalysisOccurrence[] {
  return ranges.slice(0, limit).map(item => ({
    start: baseOffset + item.start, end: baseOffset + item.end
  }));
}


function findRhythmTransitions(
  sentenceRanges: readonly LocalRange[],
  sentenceWordCounts: readonly number[],
  baseOffset: number
): LiteraryRhythmTransition[] {
  const candidates: LiteraryRhythmTransition[] = [];
  for (let index = 0; index + 1 < sentenceWordCounts.length; index++) {
    const before = sentenceWordCounts[index] ?? 0;
    const after = sentenceWordCounts[index + 1] ?? 0;
    const shorter = Math.min(before, after);
    const longer = Math.max(before, after);
    if (longer < 16 || longer - shorter < 10 || longer < shorter * 2) continue;
    const beforeRange = sentenceRanges[index]!;
    const afterRange = sentenceRanges[index + 1]!;
    candidates.push({
      beforeSentenceIndex: index + 1,
      afterSentenceIndex: index + 2,
      beforeWordCount: before,
      afterWordCount: after,
      direction: after < before ? "acceleration" : "deceleration",
      occurrences: [
        { start: baseOffset + beforeRange.start, end: baseOffset + beforeRange.end },
        { start: baseOffset + afterRange.start, end: baseOffset + afterRange.end }
      ]
    });
  }
  return candidates.slice(0, 20);
}

function collectSensorySignals(
  tokens: readonly WordToken[], baseOffset: number
): LiterarySensorySignal[] {
  return SENSORY_MODALITIES.map(modality => {
    const vocabulary = SENSORY_LEXICON[modality];
    const matches = tokens.filter(token => vocabulary.has(token.normalized));
    return {
      modality,
      count: matches.length,
      occurrences: matches.slice(0, 20).map(token => ({
        start: baseOffset + token.start,
        end: baseOffset + token.end
      }))
    };
  });
}

function validateInput(input: LiteraryAnalysisInput): number {
  const baseOffset = input?.baseOffset ?? 0;
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" ||
      input.text.length > MAX_LITERARY_ANALYSIS_TEXT_UNITS ||
      !Number.isSafeInteger(baseOffset) || baseOffset < 0 ||
      baseOffset > Number.MAX_SAFE_INTEGER - input.text.length) {
    throw new Error("Contexto de análisis literario inválido o fragmento demasiado grande.");
  }
  return baseOffset;
}

/** Analiza un fragmento sin mutar el texto ni persistir información. */
export function analyzeLiteraryFragment(input: LiteraryAnalysisInput): LiteraryAnalysisResult {
  const baseOffset = validateInput(input);
  const text = input.text;
  const tokens = tokenize(text);
  const sentenceRanges = findSentenceRanges(text);
  const paragraphRanges = findParagraphRanges(text);
  const dialogueRanges = findDialogueRanges(text);
  const sentenceWordCounts = countTokensPerRange(tokens, sentenceRanges).filter(Boolean);
  const paragraphWordCounts = countTokensPerRange(tokens, paragraphRanges).filter(Boolean);

  const wordGroups = new Map<string, WordToken[]>();
  for (const token of tokens) {
    if (STOP_WORDS.has(token.normalized) || token.normalized.length < 3) continue;
    const group = wordGroups.get(token.normalized) ?? [];
    group.push(token);
    wordGroups.set(token.normalized, group);
  }
  const repeatedWords: LiteraryRepeatedWord[] = [...wordGroups.entries()]
    .filter(([,items]) => items.length >= 3)
    .map(([word,items]) => ({
      word, count: items.length,
      occurrences: items.slice(0,20).map(item => ({
        start: baseOffset + item.start, end: baseOffset + item.end
      }))
    }))
    .sort((a,b) => b.count - a.count || a.word.localeCompare(b.word,"es"))
    .slice(0,12);

  const openingGroups = new Map<string, OccurrenceGroup>();
  let openingTokenCursor = 0;
  for (const range of sentenceRanges) {
    while (openingTokenCursor < tokens.length &&
      tokens[openingTokenCursor]!.end <= range.start) openingTokenCursor++;
    const first = tokens[openingTokenCursor];
    const second = tokens[openingTokenCursor + 1];
    if (!first || !second || first.start < range.start || second.end > range.end) continue;
    const key = first.normalized + " " + second.normalized;
    const group = openingGroups.get(key) ?? {
      key, label: first.text + " " + second.text, occurrences: []
    };
    group.occurrences.push({ start:first.start, end:second.end });
    openingGroups.set(key,group);
  }
  const repeatedSentenceOpenings: LiterarySentenceOpening[] = [...openingGroups.values()]
    .filter(group => group.occurrences.length >= 2)
    .sort((a,b) => b.occurrences.length - a.occurrences.length || a.key.localeCompare(b.key,"es"))
    .slice(0,8)
    .map(group => ({
      opening:group.label, count:group.occurrences.length,
      occurrences:toAbsoluteOccurrences(group.occurrences,baseOffset,12)
    }));


  const anaphoraCandidates: LiteraryAnaphoraCandidate[] = [];
  const sentenceOpeningRecords: {
    readonly key: string;
    readonly label: string;
    readonly occurrence: LocalRange;
  }[] = [];
  let anaphoraTokenCursor = 0;
  for (const range of sentenceRanges) {
    while (anaphoraTokenCursor < tokens.length &&
      tokens[anaphoraTokenCursor]!.end <= range.start) anaphoraTokenCursor++;
    const first = tokens[anaphoraTokenCursor];
    const second = tokens[anaphoraTokenCursor + 1];
    if (!first || !second || first.start < range.start || second.end > range.end) {
      sentenceOpeningRecords.push({ key: "", label: "", occurrence: { start: range.start, end: range.start } });
      continue;
    }
    sentenceOpeningRecords.push({
      key: first.normalized + " " + second.normalized,
      label: first.text + " " + second.text,
      occurrence: { start: first.start, end: second.end }
    });
  }
  let runStart = 0;
  while (runStart < sentenceOpeningRecords.length) {
    const record = sentenceOpeningRecords[runStart]!;
    let runEnd = runStart + 1;
    if (record.key) {
      while (runEnd < sentenceOpeningRecords.length &&
        sentenceOpeningRecords[runEnd]!.key === record.key) runEnd++;
    }
    if (record.key && runEnd - runStart >= 2) {
      const run = sentenceOpeningRecords.slice(runStart, runEnd);
      anaphoraCandidates.push({
        phrase: record.label,
        sentenceIndexes: run.map((_, index) => runStart + index + 1),
        occurrences: run.map(item => ({
          start: baseOffset + item.occurrence.start,
          end: baseOffset + item.occurrence.end
        }))
      });
    }
    runStart = runEnd;
  }

  const wordCount = tokens.length;
  const uniqueWordCount = new Set(tokens.map(token => token.normalized)).size;
  const dialogueWordCount = countTokensInRanges(tokens,dialogueRanges);
  const averageWordsPerSentence = sentenceWordCounts.length > 0 ? wordCount / sentenceWordCounts.length : 0;
  const orderedSentenceLengths = [...sentenceWordCounts].sort((a,b) => a-b);
  const middle = Math.floor(orderedSentenceLengths.length / 2);
  const medianWordsPerSentence = orderedSentenceLengths.length === 0 ? 0 :
    orderedSentenceLengths.length % 2 === 0
      ? (orderedSentenceLengths[middle - 1]! + orderedSentenceLengths[middle]!) / 2
      : orderedSentenceLengths[middle]!;
  const sentenceLengthVariance = sentenceWordCounts.length > 0
    ? sentenceWordCounts.reduce((sum,count) => sum + (count-averageWordsPerSentence)**2,0) / sentenceWordCounts.length
    : 0;
  const sentenceLengthStandardDeviation = Math.sqrt(sentenceLengthVariance);
  const averageWordsPerParagraph = paragraphWordCounts.length > 0 ? wordCount / paragraphWordCounts.length : 0;
  const shortestSentenceWords = sentenceWordCounts.length > 0
    ? sentenceWordCounts.reduce((minimum, count) => Math.min(minimum, count), Number.POSITIVE_INFINITY)
    : 0;
  const longestSentenceWords = sentenceWordCounts.length > 0
    ? sentenceWordCounts.reduce((maximum, count) => Math.max(maximum, count), 0)
    : 0;

  let rhythmProfile: LiteraryRhythmProfile = "insufficient-text";
  if (wordCount >= 20 && sentenceWordCounts.length >= 2) {
    if (averageWordsPerSentence < 9) rhythmProfile = "fragmented";
    else if (averageWordsPerSentence >= 22) rhythmProfile = "extended";
    else rhythmProfile = "balanced";
  }
  const dialogueRatio = wordCount > 0 ? dialogueWordCount / wordCount : 0;
  let dialogueDensity: LiteraryDialogueDensity = "none";
  if (dialogueRatio > 0) {
    if (dialogueRatio < 0.1) dialogueDensity = "low";
    else if (dialogueRatio < 0.3) dialogueDensity = "moderate";
    else dialogueDensity = "high";
  }
  const metrics: LiteraryAnalysisMetrics = {
    characterCount:[...text].length,
    letterCount:[...text.matchAll(LETTER_PATTERN)].length,
    wordCount,
    sentenceCount:sentenceRanges.length,
    paragraphCount:paragraphRanges.length,
    averageWordsPerSentence:roundMetric(averageWordsPerSentence),
    medianWordsPerSentence:roundMetric(medianWordsPerSentence),
    sentenceLengthStandardDeviation:roundMetric(sentenceLengthStandardDeviation),
    averageWordsPerParagraph:roundMetric(averageWordsPerParagraph),
    lexicalDiversity:wordCount > 0 ? roundMetric(uniqueWordCount / wordCount) : 0,
    dialogueWordCount,
    dialogueRatio:roundMetric(dialogueRatio),
    questionMarkCount:[...text.matchAll(/\?/gu)].length,
    exclamationMarkCount:[...text.matchAll(/!/gu)].length,
    ellipsisCount:[...text.matchAll(/…|\.{3,}/gu)].length,
    shortestSentenceWords,
    longestSentenceWords,
    shortSentenceCount:sentenceWordCounts.filter(count => count <= 8).length,
    mediumSentenceCount:sentenceWordCounts.filter(count => count >= 9 && count <= 24).length,
    longSentenceCount:sentenceWordCounts.filter(count => count >= 25).length
  };
  return {
    projectId:input.projectId,
    documentId:input.documentId,
    revision:input.revision,
    range:{start:baseOffset,end:baseOffset+text.length},
    metrics,
    rhythmProfile,
    rhythmTransitions:findRhythmTransitions(sentenceRanges,sentenceWordCounts,baseOffset),
    dialogueDensity,
    voiceSignals:classifyVoiceSignals(tokens,dialogueRanges,baseOffset),
    repeatedWords,
    repeatedSentenceOpenings,
    anaphoraCandidates,
    sensorySignals:collectSensorySignals(tokens,baseOffset),
    caveats:[
      "El ritmo usa umbrales de longitud de oración; no mide calidad, tensión ni musicalidad.",
      "El diálogo se estima por comillas y líneas iniciadas con raya; otros formatos pueden quedar fuera.",
      "Las señales de persona cuentan pronombres explícitos fuera del diálogo y no identifican por sí solas al narrador.",
      "La diversidad léxica usa formas normalizadas; no desambigua homónimos ni funciones gramaticales.",
      "La anáfora se propone por coincidencia literal de las dos primeras palabras en oraciones consecutivas.",
      "Las señales sensoriales usan un vocabulario explícito y no detectan metáforas ni sentidos implícitos."
    ]
  };
}
