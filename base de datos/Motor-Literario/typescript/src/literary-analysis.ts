/**
 * Análisis literario descriptivo y determinista.
 * No afirma intención autoral, identidad del narrador ni calidad estética.
 * Las ocurrencias conservan offsets UTF-16 absolutos para inspección editorial.
 */
export const MAX_LITERARY_ANALYSIS_TEXT_UNITS = 2_000_000;

export interface LiteraryAnalysisKnownCharacter {
  readonly entityId: string;
  readonly canonicalName: string;
  readonly aliases?: readonly string[];
}
export interface LiteraryAnalysisKnownEventEvidence {
  readonly documentId: string;
  readonly revision: number;
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
  readonly status?: "stale";
}
export interface LiteraryAnalysisKnownEvent {
  readonly eventId: string;
  readonly label: string;
  readonly participants: readonly string[];
  readonly evidence: readonly LiteraryAnalysisKnownEventEvidence[];
}
export interface LiteraryAnalysisInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly baseOffset?: number;
  /** Identidades de personajes conocidas por el proyecto; nunca se infieren desde el fragmento. */
  readonly knownCharacters?: readonly LiteraryAnalysisKnownCharacter[];
  /** Acontecimientos del proyecto con evidencia versionada; solo se enlaza evidencia del documento/revisión analizados. */
  readonly knownEvents?: readonly LiteraryAnalysisKnownEvent[];
}
export interface LiteraryAnalysisOccurrence { readonly start: number; readonly end: number; }
export interface LiteraryRepeatedWord {
  readonly word: string;
  readonly count: number;
  readonly occurrences: readonly LiteraryAnalysisOccurrence[];
}
export interface LiteraryRepeatedPhrase {
  readonly phrase: string;
  readonly wordCount: number;
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
export type LiteraryDialogueSegmentFormat = "quotation" | "dialogue-dash" | "mixed";
export interface LiteraryDialogueSegment {
  readonly segmentIndex: number;
  readonly format: LiteraryDialogueSegmentFormat;
  readonly wordCount: number;
  readonly occurrence: LiteraryAnalysisOccurrence;
}
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
  readonly dialogueSegmentCount: number;
  readonly averageWordsPerDialogueSegment: number;
  readonly longestDialogueSegmentWords: number;
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
export type LiterarySentenceLengthBand = "short" | "medium" | "long";
export type LiterarySceneCadencePatternType =
  | "stable-length-band-run"
  | "alternating-length-band-run"
  | "ascending-length-run"
  | "descending-length-run";
export interface LiterarySceneCadencePattern {
  readonly patternType: LiterarySceneCadencePatternType;
  readonly fromSentenceIndex: number;
  readonly toSentenceIndex: number;
  readonly sentenceCount: number;
  /** Muestras alineadas y limitadas a las primeras 40 oraciones del patrón. */
  readonly sentenceWordCounts: readonly number[];
  readonly lengthBands: readonly LiterarySentenceLengthBand[];
  readonly occurrences: readonly LiteraryAnalysisOccurrence[];
  readonly evidenceTruncated: boolean;
}
export interface LiterarySceneCadenceProfile {
  readonly sentenceCount: number;
  readonly sentenceBandCounts: {
    readonly short: number;
    readonly medium: number;
    readonly long: number;
  };
  readonly bandTransitionCounts: {
    readonly shortToShort: number;
    readonly shortToMedium: number;
    readonly shortToLong: number;
    readonly mediumToShort: number;
    readonly mediumToMedium: number;
    readonly mediumToLong: number;
    readonly longToShort: number;
    readonly longToMedium: number;
    readonly longToLong: number;
  };
  readonly patternCount: number;
  /** Patrones ordenados por posición; se devuelven como máximo 20. */
  readonly patterns: readonly LiterarySceneCadencePattern[];
}
export interface LiterarySceneRhythmProfile {
  readonly sentenceCount: number;
  readonly cadence: LiterarySceneCadenceProfile;
  readonly averageWordsPerSentence: number;
  readonly medianWordsPerSentence: number;
  /** Desviación estándar poblacional de la longitud de las oraciones de esta escena. */
  readonly sentenceLengthStandardDeviation: number;
  readonly shortestSentenceWords: number;
  readonly longestSentenceWords: number;
  readonly shortSentenceCount: number;
  readonly mediumSentenceCount: number;
  readonly longSentenceCount: number;
  readonly rhythmProfile: LiteraryRhythmProfile;
  /** Contrastes entre oraciones consecutivas dentro de esta escena, con offsets UTF-16 absolutos. */
  readonly transitions: readonly LiteraryRhythmTransition[];
}
export type LiteraryDialogueDensity = "none" | "low" | "moderate" | "high";

export type LiteraryStructureMarkerType =
  | "part-heading" | "chapter-heading" | "act-heading" | "scene-heading" | "scene-divider";
export interface LiteraryStructureMarker {
  readonly markerType: LiteraryStructureMarkerType;
  readonly label: string;
  readonly lineIndex: number;
  readonly occurrence: LiteraryAnalysisOccurrence;
}
export interface LiterarySceneCharacterMention {
  readonly entityId: string;
  readonly canonicalName: string;
  readonly matchedNames: readonly string[];
  readonly occurrences: readonly LiteraryAnalysisOccurrence[];
}
export interface LiterarySceneEventParticipant {
  readonly entityId: string;
  /** Indica solo si el nombre/alias aparece literalmente dentro de la escena. */
  readonly mentionedByName: boolean;
}
export interface LiterarySceneEventLink {
  readonly eventId: string;
  readonly label: string;
  readonly matchingEvidence: readonly LiteraryAnalysisOccurrence[];
  readonly participants: readonly LiterarySceneEventParticipant[];
}
export type LiterarySceneCharacterContinuityStatus =
  | "mentioned-in-both-scenes"
  | "not-mentioned-in-next-scene"
  | "mentioned-only-in-next-scene";
export interface LiterarySceneCharacterContinuitySignal {
  readonly entityId: string;
  readonly status: LiterarySceneCharacterContinuityStatus;
  readonly previousMentions: readonly LiteraryAnalysisOccurrence[];
  readonly nextMentions: readonly LiteraryAnalysisOccurrence[];
}
export type LiterarySceneEventContinuityStatus =
  | "evidence-in-both-scenes"
  | "evidence-only-in-previous-scene"
  | "evidence-only-in-next-scene";
export interface LiterarySceneEventContinuitySignal {
  readonly eventId: string;
  readonly label: string;
  readonly status: LiterarySceneEventContinuityStatus;
  readonly previousEvidence: readonly LiteraryAnalysisOccurrence[];
  readonly nextEvidence: readonly LiteraryAnalysisOccurrence[];
}
export interface LiterarySceneContinuityTransition {
  readonly fromSceneIndex: number;
  readonly toSceneIndex: number;
  readonly characterSignals: readonly LiterarySceneCharacterContinuitySignal[];
  readonly eventSignals: readonly LiterarySceneEventContinuitySignal[];
}
export interface LiteraryCharacterCoMentionPattern {
  /** IDs de dos personajes conocidos, ordenados de forma estable. */
  readonly characterIds: readonly [string, string];
  readonly sharedSceneCount: number;
  readonly sceneIndexes: readonly number[];
}
export interface LiterarySceneRhythmTransition {
  readonly fromSceneIndex: number;
  readonly toSceneIndex: number;
  readonly previousRhythmProfile: LiteraryRhythmProfile;
  readonly nextRhythmProfile: LiteraryRhythmProfile;
  readonly rhythmProfileChanged: boolean;
  readonly previousAverageWordsPerSentence: number;
  readonly nextAverageWordsPerSentence: number;
  readonly averageWordsPerSentenceDelta: number;
  readonly previousSentenceCount: number;
  readonly nextSentenceCount: number;
  readonly sentenceCountDelta: number;
  readonly previousTransitionCount: number;
  readonly nextTransitionCount: number;
  readonly transitionCountDelta: number;
}
export interface LiterarySceneVoiceTransition {
  readonly fromSceneIndex: number;
  readonly toSceneIndex: number;
  readonly previousClassification: LiteraryVoiceSignalClassification;
  readonly nextClassification: LiteraryVoiceSignalClassification;
  readonly classificationChanged: boolean;
  /** Diferencia next - previous de conteos de pronombres explícitos fuera del diálogo. */
  readonly countDelta: LiteraryVoiceSignalCounts;
  readonly changedCategories: readonly (keyof LiteraryVoiceSignalCounts)[];
}
export interface LiterarySceneVoiceSnapshot {
  readonly sceneIndex: number;
  readonly classification: LiteraryVoiceSignalClassification;
  readonly counts: LiteraryVoiceSignalCounts;
  readonly totalSignals: number;
  readonly narrativeWordCount: number;
  /** Conteos normalizados por cada 1.000 palabras fuera del diálogo reconocido. */
  readonly ratesPer1000Words: LiteraryVoiceSignalCounts;
  readonly totalRatePer1000Words: number;
}
export interface LiterarySceneVoiceCategoryCoverage {
  readonly category: keyof LiteraryVoiceSignalCounts;
  readonly occurrences: number;
  readonly scenesWithOccurrences: number;
  /** Fracción entre 0 y 1 de escenas explícitas con al menos una señal de esta categoría. */
  readonly sceneShare: number;
}
export type LiterarySceneVoiceSequencePatternType =
  | "stable-classification-run"
  | "alternating-classification-run";
export interface LiterarySceneVoiceSequencePattern {
  readonly patternType: LiterarySceneVoiceSequencePatternType;
  readonly fromSceneIndex: number;
  readonly toSceneIndex: number;
  /** Clasificación explícita por escena, en orden textual. */
  readonly classifications: readonly LiteraryVoiceSignalClassification[];
  /** Instantáneas de las escenas que forman el patrón, incluidas sus tasas y conteos. */
  readonly sceneSnapshots: readonly LiterarySceneVoiceSnapshot[];
}
export interface LiterarySceneVoiceProfile {
  readonly sceneCount: number;
  readonly totalSignals: number;
  readonly totalNarrativeWordCount: number;
  readonly categoryTotals: LiteraryVoiceSignalCounts;
  /** Conteos acumulados normalizados por cada 1.000 palabras fuera del diálogo reconocido. */
  readonly categoryRatesPer1000Words: LiteraryVoiceSignalCounts;
  readonly totalRatePer1000Words: number;
  readonly classificationSceneCounts: {
    readonly firstPerson: number;
    readonly secondPerson: number;
    readonly thirdPerson: number;
    readonly mixed: number;
    readonly undetermined: number;
  };
  readonly categoryCoverage: readonly LiterarySceneVoiceCategoryCoverage[];
  /** Instantáneas en orden textual; conservan una referencia por índice a explicitScenes. */
  readonly sceneSnapshots: readonly LiterarySceneVoiceSnapshot[];
}
export interface LiteraryExplicitSceneSegment {
  readonly sceneIndex: number;
  readonly markerType: "scene-heading" | "scene-divider";
  readonly heading: string;
  readonly markerOccurrence: LiteraryAnalysisOccurrence;
  readonly contentRange: LiteraryAnalysisOccurrence;
  readonly wordCount: number;
  /** Palabras de narración fuera de los rangos de diálogo reconocidos. */
  readonly narrativeWordCount: number;
  /** Ritmo de las oraciones completas de la escena; incluye diálogo y mantiene evidencia propia. */
  readonly rhythmSignals: LiterarySceneRhythmProfile;
  /** Menciones literales de personajes conocidos y no ambiguos dentro de esta escena. */
  readonly characterMentions: readonly LiterarySceneCharacterMention[];
  readonly eventLinks: readonly LiterarySceneEventLink[];
  /** Señales de pronombres explícitos fuera del diálogo, limitadas al contenido de esta escena. */
  readonly voiceSignals: LiteraryVoiceSignal;
}
export interface LiteraryAnalysisResult {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly range: LiteraryAnalysisOccurrence;
  readonly metrics: LiteraryAnalysisMetrics;
  readonly rhythmProfile: LiteraryRhythmProfile;
  readonly rhythmTransitions: readonly LiteraryRhythmTransition[];
  readonly dialogueDensity: LiteraryDialogueDensity;
  readonly dialogueSegments: readonly LiteraryDialogueSegment[];
  readonly structuralMarkers: readonly LiteraryStructureMarker[];
  readonly explicitScenes: readonly LiteraryExplicitSceneSegment[];
  /** Comparaciones descriptivas entre escenas explícitas contiguas, nunca diagnósticos de contradicción. */
  readonly sceneContinuity: readonly LiterarySceneContinuityTransition[];
  /** Variaciones métricas del ritmo entre escenas contiguas, independientes de las señales gramaticales. */
  readonly sceneRhythmTransitions: readonly LiterarySceneRhythmTransition[];
  /** Variaciones de señales gramaticales entre escenas contiguas; no demuestra cambio de narrador. */
  readonly sceneVoiceTransitions: readonly LiterarySceneVoiceTransition[];
  /** Resumen cuantitativo de señales gramaticales a lo largo de las escenas explícitas. */
  readonly sceneVoiceProfile: LiterarySceneVoiceProfile;
  /** Tramos estables o alternantes de clasificaciones gramaticales en escenas contiguas. */
  readonly sceneVoiceSequences: readonly LiterarySceneVoiceSequencePattern[];
  /** Pares de personajes mencionados en las mismas escenas; no implica interacción o relación. */
  readonly characterCoMentions: readonly LiteraryCharacterCoMentionPattern[];
  readonly voiceSignals: LiteraryVoiceSignal;
  readonly repeatedWords: readonly LiteraryRepeatedWord[];
  readonly repeatedPhrases: readonly LiteraryRepeatedPhrase[];
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

interface LocalLiteraryStructureMarker extends LocalRange {
  readonly markerType: LiteraryStructureMarkerType;
  readonly label: string;
  readonly lineIndex: number;
}
function detectLiteraryStructure(text: string): LocalLiteraryStructureMarker[] {
  const markers: LocalLiteraryStructureMarker[] = [];
  const headingLimit = 100;
  let cursor = 0;
  let lineIndex = 0;
  while (cursor < text.length && markers.length < headingLimit) {
    const lineStart = cursor;
    while (cursor < text.length && text[cursor] !== "\n" && text[cursor] !== "\r") cursor++;
    const lineEnd = cursor;
    const line = text.slice(lineStart,lineEnd);
    if (cursor < text.length && text[cursor] === "\r") cursor++;
    if (cursor < text.length && text[cursor] === "\n") cursor++;
    lineIndex++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = trimmed.match(/^(?:#{1,6}[ \t]*)?(cap[ií]tulo|chapter|parte|part|libro|book|acto|act|escena|scene)\b(.*)$/iu);
    if (heading) {
      const keyword = (heading[1] ?? "").toLocaleLowerCase("es");
      const markerType: LiteraryStructureMarkerType =
        /^(?:cap[ií]tulo|chapter)$/u.test(keyword) ? "chapter-heading" :
        /^(?:parte|part|libro|book)$/u.test(keyword) ? "part-heading" :
        /^(?:acto|act)$/u.test(keyword) ? "act-heading" : "scene-heading";
      markers.push({
        markerType,
        label:trimmed.replace(/^#{1,6}[ \t]*/u,""),
        lineIndex,
        start:lineStart,
        end:lineEnd
      });
      continue;
    }
    const compact = trimmed.replace(/[ \t]/gu,"");
    if (/^(?:\*{3,}|-{3,}|_{3,}|={3,}|·{3,}|•{3,})$/u.test(compact)) {
      markers.push({
        markerType:"scene-divider",
        label:"Separador de escena",
        lineIndex,
        start:lineStart,
        end:lineEnd
      });
    }
  }
  return markers;
}
function normalizeSceneCharacterName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu," ").toLocaleLowerCase("es");
}
function escapeSceneCharacterPattern(value: string): string {
  let escaped = "";
  for (const character of value) {
    if ("\\^$.*+?()[]{}|".includes(character)) escaped += "\\";
    escaped += character;
  }
  return escaped;
}
function findSceneCharacterMentions(
  text: string,
  contentRange: LocalRange,
  baseOffset: number,
  characters: readonly LiteraryAnalysisKnownCharacter[]
): LiterarySceneCharacterMention[] {
  const nameOwners = new Map<string, Array<{
    readonly entityId: string;
    readonly canonicalName: string;
    readonly sourceName: string;
  }>>();
  for (const character of characters) {
    const names = [character.canonicalName,...(character.aliases ?? [])];
    const seenForCharacter = new Set<string>();
    for (const sourceName of names) {
      const normalized = normalizeSceneCharacterName(sourceName);
      if (!normalized || seenForCharacter.has(normalized)) continue;
      seenForCharacter.add(normalized);
      const owners = nameOwners.get(normalized) ?? [];
      owners.push({
        entityId:character.entityId,
        canonicalName:character.canonicalName,
        sourceName
      });
      nameOwners.set(normalized,owners);
    }
  }
  const grouped = new Map<string,{
    readonly entityId: string;
    readonly canonicalName: string;
    matchedNames: Map<string, number>;
    occurrences: LocalRange[];
  }>();
  const excerpt = text.slice(contentRange.start,contentRange.end);
  for (const owners of nameOwners.values()) {
    const distinctOwners = new Map(owners.map(owner => [owner.entityId,owner]));
    // Nombres o alias en conflicto no se asignan a una identidad automáticamente.
    if (distinctOwners.size !== 1) continue;
    const owner = [...distinctOwners.values()][0]!;
    const escaped = owner.sourceName.trim().replace(/\s+/gu," ").split(" ")
      .map(escapeSceneCharacterPattern).join("\\s+");
    const expression = new RegExp(
      "(?<![\\p{L}\\p{N}_])"+escaped+"(?![\\p{L}\\p{N}_])","giu"
    );
    const group = grouped.get(owner.entityId) ?? {
      entityId:owner.entityId,
      canonicalName:owner.canonicalName,
      matchedNames:new Map<string,number>(),
      occurrences:[]
    };
    for (const match of excerpt.matchAll(expression)) {
      const matchedName = match[0];
      const start = contentRange.start + (match.index ?? 0);
      const previousMatch = group.matchedNames.get(matchedName);
      if (previousMatch === undefined || start < previousMatch) {
        group.matchedNames.set(matchedName,start);
      }
      group.occurrences.push({
        start:baseOffset+start,
        end:baseOffset+start+matchedName.length
      });
      group.occurrences.sort((a,b) => a.start-b.start || a.end-b.end);
      if (group.occurrences.length > 20) group.occurrences.pop();
    }
    if (group.occurrences.length > 0) grouped.set(owner.entityId,group);
  }
  return [...grouped.values()]
    .sort((a,b) => (a.occurrences[0]?.start ?? 0)-(b.occurrences[0]?.start ?? 0))
    .slice(0,40)
    .map(group => ({
      entityId:group.entityId,
      canonicalName:group.canonicalName,
      matchedNames:[...group.matchedNames.entries()]
        .sort((a,b) => a[1]-b[1] || a[0].localeCompare(b[0],"es"))
        .slice(0,10).map(([name]) => name),
      occurrences:group.occurrences
    }));
}
function findSceneEventLinks(
  contentRange: LocalRange,
  baseOffset: number,
  documentId: string,
  revision: number,
  characters: readonly LiterarySceneCharacterMention[],
  events: readonly LiteraryAnalysisKnownEvent[]
): LiterarySceneEventLink[] {
  const sceneStart = baseOffset + contentRange.start;
  const sceneEnd = baseOffset + contentRange.end;
  const characterIds = new Set(characters.map(character => character.entityId));
  const links: LiterarySceneEventLink[] = [];
  for (const event of events) {
    const matchingEvidence = event.evidence
      .filter(evidence =>
        evidence.status !== "stale" &&
        evidence.documentId === documentId &&
        evidence.revision === revision &&
        evidence.end > sceneStart &&
        evidence.start < sceneEnd &&
        evidence.end > evidence.start
      )
      .map(evidence => ({
        start:Math.max(sceneStart,evidence.start),
        end:Math.min(sceneEnd,evidence.end)
      }))
      .sort((a,b) => a.start-b.start || a.end-b.end);
    if (matchingEvidence.length === 0) continue;
    links.push({
      eventId:event.eventId,
      label:event.label,
      matchingEvidence:matchingEvidence.slice(0,20),
      participants:[...new Set(event.participants)].sort((a,b) => a.localeCompare(b,"en")).map(entityId => ({
        entityId,
        mentionedByName:characterIds.has(entityId)
      }))
    });
    if (links.length >= 100) break;
  }
  return links;
}

function analyzeExplicitScenes(
  text: string,
  tokens: readonly WordToken[],
  baseOffset: number,
  markers: readonly LocalLiteraryStructureMarker[],
  knownCharacters: readonly LiteraryAnalysisKnownCharacter[],
  knownEvents: readonly LiteraryAnalysisKnownEvent[],
  dialogueRanges: readonly LocalRange[],
  documentId: string,
  revision: number
): LiteraryExplicitSceneSegment[] {
  const sceneMarkers = markers.filter(marker =>
    marker.markerType === "scene-heading" || marker.markerType === "scene-divider"
  );
  const localRanges: LocalRange[] = [];
  const sceneDrafts: Array<{
    marker: LocalLiteraryStructureMarker;
    contentRange: LocalRange;
  }> = [];
  for (const marker of sceneMarkers) {
    const markerIndex = markers.indexOf(marker);
    const nextMarker = markers[markerIndex+1];
    const contentEnd = nextMarker?.start ?? text.length;
    const contentRange = trimRange(text,marker.end,contentEnd);
    if (!contentRange) continue;
    localRanges.push(contentRange);
    sceneDrafts.push({marker,contentRange});
  }
  const boundedScenes = sceneDrafts.slice(0,100);
  const boundedRanges = boundedScenes.map(scene => scene.contentRange);
  const wordCounts = countTokensPerRange(tokens,boundedRanges);
  const narrativeWordCounts = countTokensOutsideRangesPerRange(tokens,boundedRanges,dialogueRanges);
  return boundedScenes.map((scene,index) => {
    const sceneText = text.slice(scene.contentRange.start,scene.contentRange.end);
    const sceneSentenceRanges = findSentenceRanges(sceneText).map(range => ({
      start:scene.contentRange.start+range.start,
      end:scene.contentRange.start+range.end
    }));
    const sceneSentenceWordCounts = countTokensPerRange(tokens,sceneSentenceRanges);
    const characterMentions = findSceneCharacterMentions(
      text,scene.contentRange,baseOffset,knownCharacters
    );
    return ({
    sceneIndex:index+1,
    markerType:scene.marker.markerType as "scene-heading" | "scene-divider",
    heading:scene.marker.label,
    markerOccurrence:{
      start:baseOffset+scene.marker.start,
      end:baseOffset+scene.marker.end
    },
    contentRange:{
      start:baseOffset+scene.contentRange.start,
      end:baseOffset+scene.contentRange.end
    },
    wordCount:wordCounts[index] ?? 0,
    narrativeWordCount:narrativeWordCounts[index] ?? 0,
    rhythmSignals:summarizeSceneRhythm(sceneSentenceRanges,sceneSentenceWordCounts,baseOffset),
    characterMentions,
    eventLinks:findSceneEventLinks(
      scene.contentRange,baseOffset,documentId,revision,characterMentions,knownEvents
    ),
    voiceSignals:classifyVoiceSignals(tokens,dialogueRanges,baseOffset,scene.contentRange)
  });});
}

function buildSceneRhythmTransitions(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneRhythmTransition[] {
  const transitions: LiterarySceneRhythmTransition[] = [];
  for (let index = 1; index < scenes.length; index++) {
    const previous = scenes[index - 1]!;
    const next = scenes[index]!;
    transitions.push({
      fromSceneIndex:previous.sceneIndex,
      toSceneIndex:next.sceneIndex,
      previousRhythmProfile:previous.rhythmSignals.rhythmProfile,
      nextRhythmProfile:next.rhythmSignals.rhythmProfile,
      rhythmProfileChanged:previous.rhythmSignals.rhythmProfile !== next.rhythmSignals.rhythmProfile,
      previousAverageWordsPerSentence:previous.rhythmSignals.averageWordsPerSentence,
      nextAverageWordsPerSentence:next.rhythmSignals.averageWordsPerSentence,
      averageWordsPerSentenceDelta:roundMetric(
        next.rhythmSignals.averageWordsPerSentence-previous.rhythmSignals.averageWordsPerSentence
      ),
      previousSentenceCount:previous.rhythmSignals.sentenceCount,
      nextSentenceCount:next.rhythmSignals.sentenceCount,
      sentenceCountDelta:next.rhythmSignals.sentenceCount-previous.rhythmSignals.sentenceCount,
      previousTransitionCount:previous.rhythmSignals.transitions.length,
      nextTransitionCount:next.rhythmSignals.transitions.length,
      transitionCountDelta:next.rhythmSignals.transitions.length-previous.rhythmSignals.transitions.length
    });
  }
  return transitions;
}

function buildSceneContinuity(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneContinuityTransition[] {
  const transitions: LiterarySceneContinuityTransition[] = [];
  for (let index = 1; index < scenes.length; index++) {
    const previous = scenes[index - 1]!;
    const next = scenes[index]!;

    const previousCharacters = new Map(
      previous.characterMentions.map(mention => [mention.entityId, mention.occurrences] as const)
    );
    const nextCharacters = new Map(
      next.characterMentions.map(mention => [mention.entityId, mention.occurrences] as const)
    );
    const characterIds = [...new Set([
      ...previousCharacters.keys(), ...nextCharacters.keys()
    ])].sort((a,b) => a.localeCompare(b,"en"));
    const characterSignals: LiterarySceneCharacterContinuitySignal[] = characterIds.map(entityId => {
      const previousMentions = previousCharacters.get(entityId) ?? [];
      const nextMentions = nextCharacters.get(entityId) ?? [];
      const status: LiterarySceneCharacterContinuityStatus =
        previousMentions.length > 0 && nextMentions.length > 0
          ? "mentioned-in-both-scenes"
          : previousMentions.length > 0
            ? "not-mentioned-in-next-scene"
            : "mentioned-only-in-next-scene";
      return {
        entityId,
        status,
        previousMentions: previousMentions.map(item => ({start:item.start,end:item.end})),
        nextMentions: nextMentions.map(item => ({start:item.start,end:item.end}))
      };
    });

    const previousEvents = new Map(previous.eventLinks.map(event => [event.eventId,event] as const));
    const nextEvents = new Map(next.eventLinks.map(event => [event.eventId,event] as const));
    const eventIds = [...new Set([
      ...previousEvents.keys(), ...nextEvents.keys()
    ])].sort((a,b) => a.localeCompare(b,"en"));
    const eventSignals: LiterarySceneEventContinuitySignal[] = eventIds.map(eventId => {
      const previousEvent = previousEvents.get(eventId);
      const nextEvent = nextEvents.get(eventId);
      const previousEvidence = previousEvent?.matchingEvidence ?? [];
      const nextEvidence = nextEvent?.matchingEvidence ?? [];
      const status: LiterarySceneEventContinuityStatus =
        previousEvidence.length > 0 && nextEvidence.length > 0
          ? "evidence-in-both-scenes"
          : previousEvidence.length > 0
            ? "evidence-only-in-previous-scene"
            : "evidence-only-in-next-scene";
      return {
        eventId,
        label: previousEvent?.label ?? nextEvent!.label,
        status,
        previousEvidence: previousEvidence.map(item => ({start:item.start,end:item.end})),
        nextEvidence: nextEvidence.map(item => ({start:item.start,end:item.end}))
      };
    });

    transitions.push({
      fromSceneIndex:previous.sceneIndex,
      toSceneIndex:next.sceneIndex,
      characterSignals,
      eventSignals
    });
  }
  return transitions;
}

function compareSceneVoiceSignals(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneVoiceTransition[] {
  const categories: readonly (keyof LiteraryVoiceSignalCounts)[] = [
    "firstPerson","secondPerson","thirdPerson"
  ];
  const transitions: LiterarySceneVoiceTransition[] = [];
  for (let index = 1; index < scenes.length; index++) {
    const previous = scenes[index - 1]!;
    const next = scenes[index]!;
    const countDelta: LiteraryVoiceSignalCounts = {
      firstPerson:next.voiceSignals.counts.firstPerson-previous.voiceSignals.counts.firstPerson,
      secondPerson:next.voiceSignals.counts.secondPerson-previous.voiceSignals.counts.secondPerson,
      thirdPerson:next.voiceSignals.counts.thirdPerson-previous.voiceSignals.counts.thirdPerson
    };
    const changedCategories = categories.filter(category => countDelta[category] !== 0);
    transitions.push({
      fromSceneIndex:previous.sceneIndex,
      toSceneIndex:next.sceneIndex,
      previousClassification:previous.voiceSignals.classification,
      nextClassification:next.voiceSignals.classification,
      classificationChanged:
        previous.voiceSignals.classification !== next.voiceSignals.classification,
      countDelta,
      changedCategories
    });
  }
  return transitions;
}

function buildSceneVoiceProfile(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneVoiceProfile {
  const categories: readonly (keyof LiteraryVoiceSignalCounts)[] = [
    "firstPerson","secondPerson","thirdPerson"
  ];
  const categoryTotals = {firstPerson:0,secondPerson:0,thirdPerson:0};
  const scenesWithOccurrences: Record<keyof LiteraryVoiceSignalCounts,number> = {
    firstPerson:0,secondPerson:0,thirdPerson:0
  };
  const classificationSceneCounts = {
    firstPerson:0,secondPerson:0,thirdPerson:0,mixed:0,undetermined:0
  };
  let totalSignals = 0;
  let totalNarrativeWordCount = 0;

  for (const scene of scenes) {
    const counts = scene.voiceSignals.counts;
    totalNarrativeWordCount += scene.narrativeWordCount;
    for (const category of categories) {
      categoryTotals[category] += counts[category];
      if (counts[category] > 0) scenesWithOccurrences[category]++;
    }
    totalSignals += counts.firstPerson + counts.secondPerson + counts.thirdPerson;
    switch (scene.voiceSignals.classification) {
      case "first-person-signals": classificationSceneCounts.firstPerson++; break;
      case "second-person-signals": classificationSceneCounts.secondPerson++; break;
      case "third-person-signals": classificationSceneCounts.thirdPerson++; break;
      case "mixed-signals": classificationSceneCounts.mixed++; break;
      case "undetermined": classificationSceneCounts.undetermined++; break;
    }
  }

  const categoryRatesPer1000Words: LiteraryVoiceSignalCounts = {
    firstPerson:totalNarrativeWordCount > 0
      ? roundMetric(categoryTotals.firstPerson/totalNarrativeWordCount*1000) : 0,
    secondPerson:totalNarrativeWordCount > 0
      ? roundMetric(categoryTotals.secondPerson/totalNarrativeWordCount*1000) : 0,
    thirdPerson:totalNarrativeWordCount > 0
      ? roundMetric(categoryTotals.thirdPerson/totalNarrativeWordCount*1000) : 0
  };
  return {
    sceneCount:scenes.length,
    totalSignals,
    totalNarrativeWordCount,
    categoryTotals,
    categoryRatesPer1000Words,
    totalRatePer1000Words:totalNarrativeWordCount > 0
      ? roundMetric(totalSignals/totalNarrativeWordCount*1000) : 0,
    classificationSceneCounts,
    categoryCoverage:categories.map(category => ({
      category,
      occurrences:categoryTotals[category],
      scenesWithOccurrences:scenesWithOccurrences[category],
      sceneShare:scenes.length > 0
        ? roundMetric(scenesWithOccurrences[category]/scenes.length)
        : 0
    })),
    sceneSnapshots:scenes.map(scene => {
      const counts = scene.voiceSignals.counts;
      const narrativeWordCount = scene.narrativeWordCount;
      const ratesPer1000Words: LiteraryVoiceSignalCounts = {
        firstPerson:narrativeWordCount > 0
          ? roundMetric(counts.firstPerson/narrativeWordCount*1000) : 0,
        secondPerson:narrativeWordCount > 0
          ? roundMetric(counts.secondPerson/narrativeWordCount*1000) : 0,
        thirdPerson:narrativeWordCount > 0
          ? roundMetric(counts.thirdPerson/narrativeWordCount*1000) : 0
      };
      const totalSignals = counts.firstPerson + counts.secondPerson + counts.thirdPerson;
      return {
        sceneIndex:scene.sceneIndex,
        classification:scene.voiceSignals.classification,
        counts:{...counts},
        totalSignals,
        narrativeWordCount,
        ratesPer1000Words,
        totalRatePer1000Words:narrativeWordCount > 0
          ? roundMetric(totalSignals/narrativeWordCount*1000) : 0
      };
    })
  };
}

function buildSceneVoiceSequences(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiterarySceneVoiceSequencePattern[] {
  const snapshots: LiterarySceneVoiceSnapshot[] = scenes.map(scene => {
    const counts = scene.voiceSignals.counts;
    const narrativeWordCount = scene.narrativeWordCount;
    const ratesPer1000Words: LiteraryVoiceSignalCounts = {
      firstPerson:narrativeWordCount > 0
        ? roundMetric(counts.firstPerson/narrativeWordCount*1000) : 0,
      secondPerson:narrativeWordCount > 0
        ? roundMetric(counts.secondPerson/narrativeWordCount*1000) : 0,
      thirdPerson:narrativeWordCount > 0
        ? roundMetric(counts.thirdPerson/narrativeWordCount*1000) : 0
    };
    const totalSignals = counts.firstPerson + counts.secondPerson + counts.thirdPerson;
    return {
      sceneIndex:scene.sceneIndex,
      classification:scene.voiceSignals.classification,
      counts:{...counts},
      totalSignals,
      narrativeWordCount,
      ratesPer1000Words,
      totalRatePer1000Words:narrativeWordCount > 0
        ? roundMetric(totalSignals/narrativeWordCount*1000) : 0
    };
  });
  const isSinglePersonClassification = (
    value: LiteraryVoiceSignalClassification
  ): boolean => value === "first-person-signals" ||
    value === "second-person-signals" || value === "third-person-signals";
  const patterns: LiterarySceneVoiceSequencePattern[] = [];

  // Un tramo estable requiere tres escenas consecutivas con la misma señal única.
  let index = 0;
  while (index < scenes.length) {
    const classification = scenes[index]!.voiceSignals.classification;
    if (!isSinglePersonClassification(classification)) {
      index++;
      continue;
    }
    let end = index + 1;
    while (end < scenes.length &&
      scenes[end]!.voiceSignals.classification === classification) end++;
    if (end - index >= 3) {
      patterns.push({
        patternType:"stable-classification-run",
        fromSceneIndex:scenes[index]!.sceneIndex,
        toSceneIndex:scenes[end-1]!.sceneIndex,
        classifications:scenes.slice(index,end).map(scene => scene.voiceSignals.classification),
        sceneSnapshots:snapshots.slice(index,end)
      });
    }
    index = end;
  }

  // Una alternancia exige cuatro escenas y dos clasificaciones únicas diferentes.
  for (let start = 0; start + 3 < scenes.length;) {
    const first = scenes[start]!.voiceSignals.classification;
    const second = scenes[start+1]!.voiceSignals.classification;
    if (!isSinglePersonClassification(first) ||
        !isSinglePersonClassification(second) || first === second) {
      start++;
      continue;
    }
    // Evita publicar un subtramo si la alternancia ya comenzó en la escena previa.
    if (start > 0 && scenes[start-1]!.voiceSignals.classification === second) {
      start++;
      continue;
    }
    let end = start + 2;
    while (end < scenes.length) {
      const expected = (end-start) % 2 === 0 ? first : second;
      if (scenes[end]!.voiceSignals.classification !== expected) break;
      end++;
    }
    if (end - start >= 4) {
      patterns.push({
        patternType:"alternating-classification-run",
        fromSceneIndex:scenes[start]!.sceneIndex,
        toSceneIndex:scenes[end-1]!.sceneIndex,
        classifications:scenes.slice(start,end).map(scene => scene.voiceSignals.classification),
        sceneSnapshots:snapshots.slice(start,end)
      });
      start = end;
    } else start++;
  }

  return patterns.sort((a,b) =>
    a.fromSceneIndex-b.fromSceneIndex ||
    a.toSceneIndex-b.toSceneIndex ||
    a.patternType.localeCompare(b.patternType,"en")
  );
}

function findCharacterCoMentionPatterns(
  scenes: readonly LiteraryExplicitSceneSegment[]
): LiteraryCharacterCoMentionPattern[] {
  const groups = new Map<string,{
    readonly characterIds: readonly [string,string];
    sceneIndexes: number[];
  }>();
  for (const scene of scenes) {
    const entityIds = [...new Set(
      scene.characterMentions.map(mention => mention.entityId)
    )].sort((a,b) => a.localeCompare(b,"en"));
    for (let left = 0; left < entityIds.length; left++) {
      for (let right = left + 1; right < entityIds.length; right++) {
        const first = entityIds[left]!;
        const second = entityIds[right]!;
        const key = JSON.stringify([first,second]);
        const group = groups.get(key) ?? {
          characterIds:[first,second] as const,
          sceneIndexes:[]
        };
        group.sceneIndexes.push(scene.sceneIndex);
        groups.set(key,group);
      }
    }
  }
  return [...groups.values()]
    .sort((a,b) =>
      b.sceneIndexes.length-a.sceneIndexes.length ||
      a.characterIds[0].localeCompare(b.characterIds[0],"en") ||
      a.characterIds[1].localeCompare(b.characterIds[1],"en")
    )
    .slice(0,100)
    .map(group => ({
      characterIds:group.characterIds,
      sharedSceneCount:group.sceneIndexes.length,
      sceneIndexes:[...group.sceneIndexes]
    }));
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
function findDialogueSegments(text: string): Array<LocalRange & {
  readonly format: LiteraryDialogueSegmentFormat;
}> {
  const segments: Array<LocalRange & { readonly format: LiteraryDialogueSegmentFormat }> = [];
  const quoted = /«([^»]+)»|“([^”]+)”|"([^"]+)"/gu;
  for (const match of text.matchAll(quoted)) {
    const content = match[1] ?? match[2] ?? match[3] ?? "";
    if (!content) continue;
    const start = (match.index ?? 0) + match[0].indexOf(content);
    segments.push({ start, end: start + content.length, format: "quotation" });
  }
  const dashDialogue = /^[ \t]*[—–][ \t]*(.+)$/gmu;
  for (const match of text.matchAll(dashDialogue)) {
    const content = match[1] ?? "";
    if (!content) continue;
    const start = (match.index ?? 0) + match[0].indexOf(content);
    segments.push({ start, end: start + content.length, format: "dialogue-dash" });
  }
  const ordered = segments.sort((a,b) => a.start-b.start || a.end-b.end);
  const merged: Array<LocalRange & { readonly format: LiteraryDialogueSegmentFormat }> = [];
  for (const segment of ordered) {
    const previous = merged[merged.length-1];
    if (previous && segment.start < previous.end) {
      merged[merged.length-1] = {
        start:previous.start,
        end:Math.max(previous.end,segment.end),
        format:previous.format === segment.format ? previous.format : "mixed"
      };
    } else merged.push(segment);
  }
  return merged;
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

function countTokensOutsideRangesPerRange(
  tokens: readonly WordToken[],
  scopes: readonly LocalRange[],
  excludedRanges: readonly LocalRange[]
): number[] {
  const counts = scopes.map(() => 0);
  let scopeIndex = 0;
  let excludedIndex = 0;
  for (const token of tokens) {
    while (scopeIndex < scopes.length && scopes[scopeIndex]!.end <= token.start) scopeIndex++;
    if (scopeIndex >= scopes.length) break;
    const scope = scopes[scopeIndex]!;
    if (token.end <= scope.start || token.start >= scope.end) continue;
    while (excludedIndex < excludedRanges.length &&
      excludedRanges[excludedIndex]!.end <= token.start) excludedIndex++;
    const excluded = excludedRanges[excludedIndex];
    if (excluded && token.start < excluded.end && token.end > excluded.start) continue;
    counts[scopeIndex] = (counts[scopeIndex] ?? 0) + 1;
  }
  return counts;
}
function classifyVoiceSignals(
  tokens: readonly WordToken[],
  dialogueRanges: readonly LocalRange[],
  baseOffset: number,
  scope?: LocalRange
): LiteraryVoiceSignal {
  const counts = { firstPerson: 0, secondPerson: 0, thirdPerson: 0 };
  const samples: LiteraryVoiceSignal["samples"][number][] = [];
  const start = scope?.start ?? 0;
  const end = scope?.end ?? Number.POSITIVE_INFINITY;
  let tokenIndex = 0;
  while (tokenIndex < tokens.length && tokens[tokenIndex]!.end <= start) tokenIndex++;
  let rangeIndex = 0;
  while (rangeIndex < dialogueRanges.length && dialogueRanges[rangeIndex]!.end <= start) rangeIndex++;
  for (; tokenIndex < tokens.length && tokens[tokenIndex]!.start < end; tokenIndex++) {
    const token = tokens[tokenIndex]!;
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



function findRepeatedPhrases(
  text: string,
  tokens: readonly WordToken[],
  sentenceRanges: readonly LocalRange[],
  baseOffset: number
): LiteraryRepeatedPhrase[] {
  const groups = new Map<string, {
    readonly phrase: string;
    readonly wordCount: number;
    count: number;
    occurrences: LocalRange[];
  }>();
  let sentenceTokenCursor = 0;
  for (const sentence of sentenceRanges) {
    while (sentenceTokenCursor < tokens.length &&
      tokens[sentenceTokenCursor]!.end <= sentence.start) sentenceTokenCursor++;
    const indexes: number[] = [];
    let cursor = sentenceTokenCursor;
    while (cursor < tokens.length && tokens[cursor]!.start < sentence.end) {
      if (tokens[cursor]!.end <= sentence.end) indexes.push(cursor);
      cursor++;
    }
    for (let start = 0; start < indexes.length; start++) {
      for (let size = 2; size <= 4 && start + size <= indexes.length; size++) {
        const phraseTokens = indexes.slice(start,start+size).map(index => tokens[index]!);
        const hasHardBreak = phraseTokens.slice(1).some((token,index) => {
          const previous = phraseTokens[index]!;
          return /[,;:.!?…\r\n]/u.test(text.slice(previous.end,token.start));
        });
        if (hasHardBreak) break;
        const contentWords = phraseTokens.filter(token =>
          !STOP_WORDS.has(token.normalized) && token.normalized.length > 2
        ).length;
        if (contentWords < 2) continue;
        const key = phraseTokens.map(token => token.normalized).join(" ");
        const first = phraseTokens[0]!;
        const last = phraseTokens[phraseTokens.length-1]!;
        let group = groups.get(key);
        if (!group) {
          group = {
            phrase: phraseTokens.map(token => token.text).join(" "),
            wordCount:size,
            count:0,
            occurrences:[]
          };
          groups.set(key,group);
        }
        group.count++;
        if (group.occurrences.length < 20) {
          group.occurrences.push({start:first.start,end:last.end});
        }
      }
    }
    sentenceTokenCursor = cursor;
  }
  return [...groups.values()]
    .filter(group => group.count >= 2)
    .sort((a,b) => b.count-a.count || b.wordCount-a.wordCount ||
      a.phrase.localeCompare(b.phrase,"es"))
    .slice(0,12)
    .map(group => ({
      phrase:group.phrase,
      wordCount:group.wordCount,
      count:group.count,
      occurrences:group.occurrences.map(item => ({
        start:baseOffset+item.start,
        end:baseOffset+item.end
      }))
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

function summarizeSceneRhythm(
  sentenceRanges: readonly LocalRange[],
  sentenceWordCounts: readonly number[],
  baseOffset: number
): LiterarySceneRhythmProfile {
  const sentenceCount = sentenceWordCounts.length;
  const totalWords = sentenceWordCounts.reduce((total,count) => total + count,0);
  const average = sentenceCount > 0 ? totalWords / sentenceCount : 0;
  const ordered = [...sentenceWordCounts].sort((a,b) => a-b);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length === 0 ? 0 : ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
  const variance = sentenceCount > 0
    ? sentenceWordCounts.reduce((sum,count) => sum + (count-average)**2,0) / sentenceCount
    : 0;
  const shortest = sentenceCount > 0
    ? sentenceWordCounts.reduce((minimum,count) => Math.min(minimum,count),Number.POSITIVE_INFINITY)
    : 0;
  const longest = sentenceCount > 0
    ? sentenceWordCounts.reduce((maximum,count) => Math.max(maximum,count),0)
    : 0;
  let rhythmProfile: LiteraryRhythmProfile = "insufficient-text";
  if (totalWords >= 20 && sentenceCount >= 2) {
    if (average < 9) rhythmProfile = "fragmented";
    else if (average >= 22) rhythmProfile = "extended";
    else rhythmProfile = "balanced";
  }
  return {
    sentenceCount,
    averageWordsPerSentence:roundMetric(average),
    medianWordsPerSentence:roundMetric(median),
    sentenceLengthStandardDeviation:roundMetric(Math.sqrt(variance)),
    shortestSentenceWords:shortest,
    longestSentenceWords:longest,
    shortSentenceCount:sentenceWordCounts.filter(count => count <= 8).length,
    mediumSentenceCount:sentenceWordCounts.filter(count => count >= 9 && count <= 24).length,
    longSentenceCount:sentenceWordCounts.filter(count => count >= 25).length,
    rhythmProfile,
    transitions:findRhythmTransitions(sentenceRanges,sentenceWordCounts,baseOffset),
    cadence:buildSceneCadence(sentenceRanges,sentenceWordCounts,baseOffset)
  };
}

function getSentenceLengthBand(wordCount: number): LiterarySentenceLengthBand {
  if (wordCount <= 8) return "short";
  if (wordCount <= 24) return "medium";
  return "long";
}

function buildSceneCadence(
  sentenceRanges: readonly LocalRange[],
  sentenceWordCounts: readonly number[],
  baseOffset: number
): LiterarySceneCadenceProfile {
  const bands = sentenceWordCounts.map(getSentenceLengthBand);
  const sentenceBandCounts = {
    short:bands.filter(band => band === "short").length,
    medium:bands.filter(band => band === "medium").length,
    long:bands.filter(band => band === "long").length
  };
  const bandTransitionCounts = {
    shortToShort:0, shortToMedium:0, shortToLong:0,
    mediumToShort:0, mediumToMedium:0, mediumToLong:0,
    longToShort:0, longToMedium:0, longToLong:0
  };
  for (let index=0; index+1<bands.length; index++) {
    const previous = bands[index]!;
    const next = bands[index+1]!;
    const key = `${previous}To${next[0]!.toLocaleUpperCase("en")}${next.slice(1)}` as keyof typeof bandTransitionCounts;
    bandTransitionCounts[key]++;
  }

  const patterns: LiterarySceneCadencePattern[] = [];
  const addPattern = (
    patternType: LiterarySceneCadencePatternType,
    start: number,
    end: number
  ) => {
    const sampleEnd = Math.min(end,start+40);
    patterns.push({
      patternType,
      fromSentenceIndex:start+1,
      toSentenceIndex:end,
      sentenceCount:end-start,
      sentenceWordCounts:sentenceWordCounts.slice(start,sampleEnd),
      lengthBands:bands.slice(start,sampleEnd),
      occurrences:sentenceRanges.slice(start,sampleEnd).map(range => ({
        start:baseOffset+range.start,
        end:baseOffset+range.end
      })),
      evidenceTruncated:end-start>40
    });
  };

  let index=0;
  while (index<bands.length) {
    let end=index+1;
    while (end<bands.length && bands[end]===bands[index]) end++;
    if (end-index>=3) addPattern("stable-length-band-run",index,end);
    index=end;
  }

  index=0;
  while (index+3<bands.length) {
    if (bands[index]===bands[index+1]) { index++; continue; }
    let end=index+2;
    while (end<bands.length && bands[end]===bands[end-2]) end++;
    if (end-index>=4) {
      addPattern("alternating-length-band-run",index,end);
      index=end;
    } else index++;
  }

  for (const direction of [1,-1] as const) {
    index=0;
    while (index+2<sentenceWordCounts.length) {
      const firstStep=(sentenceWordCounts[index+1]??0)-(sentenceWordCounts[index]??0);
      if (direction*firstStep<2) { index++; continue; }
      let end=index+2;
      while (end<sentenceWordCounts.length) {
        const step=(sentenceWordCounts[end]??0)-(sentenceWordCounts[end-1]??0);
        if (direction*step<2) break;
        end++;
      }
      const totalChange=(sentenceWordCounts[end-1]??0)-(sentenceWordCounts[index]??0);
      if (end-index>=3 && direction*totalChange>=8) {
        addPattern(direction===1?"ascending-length-run":"descending-length-run",index,end);
        index=end;
      } else index++;
    }
  }

  patterns.sort((a,b) =>
    a.fromSentenceIndex-b.fromSentenceIndex ||
    a.toSentenceIndex-b.toSentenceIndex ||
    a.patternType.localeCompare(b.patternType,"en")
  );
  return {
    sentenceCount:sentenceWordCounts.length,
    sentenceBandCounts,
    bandTransitionCounts,
    patternCount:patterns.length,
    patterns:patterns.slice(0,20)
  };
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
      baseOffset > Number.MAX_SAFE_INTEGER - input.text.length ||
      (input.knownCharacters !== undefined &&
        (!Array.isArray(input.knownCharacters) || input.knownCharacters.length > 500)) ||
      (input.knownEvents !== undefined &&
        (!Array.isArray(input.knownEvents) || input.knownEvents.length > 2_000))) {
    throw new Error("Contexto de análisis literario inválido o fragmento demasiado grande.");
  }
  const knownCharacterIds = new Set<string>();
  for (const character of input.knownCharacters ?? []) {
    if (!character || typeof character.entityId !== "string" || !character.entityId.trim() ||
        knownCharacterIds.has(character.entityId) ||
        typeof character.canonicalName !== "string" || !character.canonicalName.trim() ||
        (character.aliases !== undefined &&
          (!Array.isArray(character.aliases) || character.aliases.some((alias: string) =>
            typeof alias !== "string" || !alias.trim()
          ))) ||
        [character.canonicalName,...(character.aliases ?? [])].some(name => name.length > 120)) {
      throw new Error("El catálogo de personajes del análisis literario es inválido.");
    }
    knownCharacterIds.add(character.entityId);
  }
  const knownEventIds = new Set<string>();
  for (const event of input.knownEvents ?? []) {
    if (!event || typeof event.eventId !== "string" || !event.eventId.trim() ||
        knownEventIds.has(event.eventId) ||
        typeof event.label !== "string" || !event.label.trim() ||
        !Array.isArray(event.participants) || event.participants.length > 500 ||
        event.participants.some((participant: string) => typeof participant !== "string" || !participant.trim()) ||
        !Array.isArray(event.evidence) || event.evidence.length > 200) {
      throw new Error("El catálogo de acontecimientos del análisis literario es inválido.");
    }
    knownEventIds.add(event.eventId);
    for (const evidence of event.evidence) {
      if (!evidence || typeof evidence.documentId !== "string" || !evidence.documentId.trim() ||
          !Number.isSafeInteger(evidence.revision) || evidence.revision < 0 ||
          !Number.isSafeInteger(evidence.start) || evidence.start < 0 ||
          !Number.isSafeInteger(evidence.end) || evidence.end <= evidence.start ||
          typeof evidence.excerpt !== "string" ||
          (evidence.status !== undefined && evidence.status !== "stale")) {
        throw new Error("La evidencia de acontecimiento del análisis literario es inválida.");
      }
    }
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
  const dialogueSegments = findDialogueSegments(text);
  const dialogueRanges = dialogueSegments.map(({start,end}) => ({start,end}));
  const localStructureMarkers = detectLiteraryStructure(text);
  const structuralMarkers: LiteraryStructureMarker[] = localStructureMarkers.map(marker => ({
    markerType:marker.markerType,
    label:marker.label,
    lineIndex:marker.lineIndex,
    occurrence:{start:baseOffset+marker.start,end:baseOffset+marker.end}
  }));
  const explicitScenes = analyzeExplicitScenes(
    text,tokens,baseOffset,localStructureMarkers,input.knownCharacters ?? [],
    input.knownEvents ?? [],dialogueRanges,input.documentId,input.revision
  );
  const sceneContinuity = buildSceneContinuity(explicitScenes);
  const sceneRhythmTransitions = buildSceneRhythmTransitions(explicitScenes);
  const sceneVoiceTransitions = compareSceneVoiceSignals(explicitScenes);
  const sceneVoiceProfile = buildSceneVoiceProfile(explicitScenes);
  const sceneVoiceSequences = buildSceneVoiceSequences(explicitScenes);
  const characterCoMentions = findCharacterCoMentionPatterns(explicitScenes);
  const dialogueSegmentWordCounts = countTokensPerRange(tokens,dialogueRanges);
  const sentenceWordCounts = countTokensPerRange(tokens,sentenceRanges).filter(Boolean);
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
  const dialogueWordCount = dialogueSegmentWordCounts.reduce((total,count) => total+count,0);
  const averageWordsPerDialogueSegment = dialogueSegmentWordCounts.length > 0
    ? dialogueWordCount/dialogueSegmentWordCounts.length : 0;
  const longestDialogueSegmentWords = dialogueSegmentWordCounts.length > 0
    ? dialogueSegmentWordCounts.reduce((maximum,count) => Math.max(maximum,count),0) : 0;
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
    dialogueSegmentCount:dialogueSegments.length,
    averageWordsPerDialogueSegment:roundMetric(averageWordsPerDialogueSegment),
    longestDialogueSegmentWords,
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
    dialogueSegments:dialogueSegments.slice(0,40).map((segment,index) => ({
      segmentIndex:index+1,
      format:segment.format,
      wordCount:dialogueSegmentWordCounts[index] ?? 0,
      occurrence:{start:baseOffset+segment.start,end:baseOffset+segment.end}
    })),
    structuralMarkers,
    explicitScenes,
    sceneContinuity,
    sceneRhythmTransitions,
    sceneVoiceTransitions,
    sceneVoiceProfile,
    sceneVoiceSequences,
    characterCoMentions,
    voiceSignals:classifyVoiceSignals(tokens,dialogueRanges,baseOffset),
    repeatedWords,
    repeatedPhrases:findRepeatedPhrases(text,tokens,sentenceRanges,baseOffset),
    repeatedSentenceOpenings,
    anaphoraCandidates,
    sensorySignals:collectSensorySignals(tokens,baseOffset),
    caveats:[
      "El ritmo usa umbrales de longitud de oración; no mide calidad, tensión ni musicalidad.",
      "Los segmentos de diálogo son señales de formato; una línea o cita no equivale siempre a un turno completo ni permite identificar al hablante.",
      "La estructura de escenas solo se segmenta cuando hay encabezados o separadores explícitos; no infiere cambios de escena a partir del contenido.",
      "La presencia de personajes se basa en nombres y alias literales no ambiguos del catálogo del proyecto; no implica que el personaje actúe, hable o sea el punto de vista de la escena.",
      "Los acontecimientos se vinculan a escenas solo cuando la evidencia vigente coincide en documento y revisión y se solapa con el rango de la escena. Que un participante declarado no sea mencionado por nombre no demuestra que esté ausente.",
      "La continuidad compara solo escenas explícitas contiguas: las menciones literales y la evidencia por ID de acontecimiento describen cobertura textual, no presencia física, cronología ni contradicciones.",
      "Las variaciones métricas del ritmo comparan longitud y cambios entre oraciones completas de escenas explícitas; incluyen diálogo y no implican por sí solas tensión, intención ni calidad narrativa.",
      "Las variaciones gramaticales entre escenas comparan conteos de pronombres explícitos fuera del diálogo reconocido; no demuestran un cambio de narrador, focalización ni voz autoral.",
      "El perfil de voz agrega señales y clasificaciones por escena explícita; la cobertura indica en cuántas escenas aparece una categoría, no la identidad ni continuidad de una voz narrativa.",
      "Los tramos estables requieren tres escenas con la misma clasificación única y las alternancias requieren cuatro escenas con dos clasificaciones únicas que se turnan; las señales mixtas o indeterminadas interrumpen los patrones y estos no identifican narradores.",
      "La co-mención agrupa nombres de personajes conocidos que aparecen en una misma escena explícita; no demuestra interacción, relación, diálogo ni presencia física compartida.",
      "Las señales de persona cuentan pronombres explícitos fuera del diálogo y no identifican por sí solas al narrador.",
      "La diversidad léxica usa formas normalizadas; no desambigua homónimos ni funciones gramaticales.",
      "La anáfora se propone por coincidencia literal de las dos primeras palabras en oraciones consecutivas.",
      "Las frases recurrentes requieren coincidencia literal de 2 a 4 palabras dentro de una oración y no prueban un motivo temático.",
      "Las señales sensoriales usan un vocabulario explícito y no detectan metáforas ni sentidos implícitos."
    ]
  };
}
