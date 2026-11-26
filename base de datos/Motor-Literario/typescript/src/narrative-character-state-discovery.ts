/**
 * Afirmaciones explícitas de condición de personajes.
 *
 * Solo reconoce nombre de personaje seguido de una construcción copulativa
 * y un predicado de estado conocido. No deduce estados desde acciones,
 * pronombres, diálogos indirectos ni adjetivos sin cópula.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

export type NarrativeCharacterState =
  | "injured" | "alive" | "dead" | "conscious" | "unconscious"
  | "bound" | "free" | "sick" | "healthy" | "missing" | "present"
  | "asleep" | "awake" | "exhausted" | "afraid" | "angry" | "calm"
  | "pregnant" | "imprisoned" | "poisoned" | "blind" | "deaf" | "mute"
  | "paralyzed" | "transformed" | "trapped" | "absent" | "lost" | "protected"
  | "confused" | "disoriented" | "worried" | "hopeful" | "sad" | "happy" | "surprised";

export type NarrativeCharacterStateCategory =
  | "vital" | "physical" | "cognitive" | "emotional" | "social" | "location" | "other";

export interface NarrativeCharacterStateCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly entityId: string;
  readonly state: NarrativeCharacterState;
  readonly category: NarrativeCharacterStateCategory;
  readonly polarity: "affirmed" | "negated";
  readonly grammaticalTense: "present" | "past" | "future" | "unknown";
  readonly aspect: "ordinary" | "ongoing" | "recurrent" | "ceased";
  readonly assertionMode: "copular" | "perceptual";
  readonly epistemicFrame: "narrator-asserted" | "character-belief" | "character-memory" | "character-desire" | "reported-speech" | "hypothetical";
  readonly epistemicFrameEvidence?: TextEvidence;
  readonly epistemicSourceCandidate?: { readonly entityId: string; readonly evidence: TextEvidence };
  readonly reviewStatus: "candidate";
  readonly entityEvidence: TextEvidence;
  readonly stateEvidence: TextEvidence;
  readonly predicateEvidence: TextEvidence;
  readonly evidence: TextEvidence;
}

export interface NarrativeCharacterStateDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
}

export const MAX_NARRATIVE_CHARACTER_STATE_CANDIDATES = 200;

const STATE_EPISTEMIC_SIGNALS: readonly {
  readonly frame: Exclude<NarrativeCharacterStateCandidate["epistemicFrame"], "narrator-asserted">;
  readonly expression: RegExp;
}[] = [
  { frame: "character-belief", expression: /\b(?:creyó|creía|creyeron|pensó|pensaba|imaginó|imaginaba|supuso|suponía)\s+que\s+/giu },
  { frame: "character-memory", expression: /\b(?:recordó|recordaba|rememoró|rememoraba|olvidó|olvidaba)\s+que\s+/giu },
  { frame: "character-desire", expression: /\b(?:deseó|deseaba|quería|quiso|esperaba|esperó|anhelaba|anheló)\s+que\s+/giu },
  { frame: "reported-speech", expression: /\b(?:dijo|decía|afirmó|afirmaba|aseguró|aseguraba|contó|relató|advirtió|anunció)\s+que\s+/giu },
  { frame: "hypothetical", expression: /\b(?:quizá|quizás|tal vez|acaso|como si)\s+/giu }
];

function classifyStateEpistemicFrame(
  sentence: string, assertionStart: number, characters: readonly NarrativeEntity[],
  input: NarrativeCharacterStateDiscoveryInput, sentenceStart: number
): Pick<NarrativeCharacterStateCandidate, "epistemicFrame" | "epistemicFrameEvidence" | "epistemicSourceCandidate"> {
  let selected: { frame: NarrativeCharacterStateCandidate["epistemicFrame"]; start: number; end: number; excerpt: string } | undefined;
  for (const signal of STATE_EPISTEMIC_SIGNALS) {
    signal.expression.lastIndex = 0;
    for (const match of sentence.matchAll(signal.expression)) {
      if (match.index! >= assertionStart) break;
      const current = { frame: signal.frame, start: match.index!, end: match.index! + match[0].length, excerpt: match[0] };
      if (!selected || current.start > selected.start) selected = current;
    }
  }
  if (!selected) return { epistemicFrame: "narrator-asserted" };
  const frameEvidence = evidence(input, sentenceStart + selected.start, sentenceStart + selected.end, selected.excerpt);
  if (selected.frame !== "reported-speech") {
    return { epistemicFrame: selected.frame, epistemicFrameEvidence: frameEvidence };
  }
  const possible = characters.flatMap(entity => [entity.canonicalName, ...entity.aliases].flatMap(name => {
    const escaped = escapeRegExp(name);
    const expression = new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])" + escaped + "(?![\\p{L}\\p{M}\\p{N}_])", "giu");
    return [...sentence.slice(0, selected!.start).matchAll(expression)].map(match => ({
      entityId: entity.id, start: match.index!, end: match.index! + match[0].length, excerpt: match[0]
    }));
  })).sort((a,b) => b.end-a.end || b.start-a.start);
  const nearest = possible[0];
  const tied = nearest ? possible.filter(item => item.end === nearest.end) : [];
  const unambiguous = nearest && tied.every(item => item.entityId === nearest.entityId) ? nearest : undefined;
  return {
    epistemicFrame: selected.frame,
    epistemicFrameEvidence: frameEvidence,
    ...(unambiguous ? { epistemicSourceCandidate: {
      entityId: unambiguous.entityId,
      evidence: evidence(input, sentenceStart + unambiguous.start, sentenceStart + unambiguous.end, unambiguous.excerpt)
    }} : {})
  };
}

const STATE_PATTERNS: readonly {
  readonly state: NarrativeCharacterState;
  readonly category: NarrativeCharacterStateCategory;
  readonly expression: RegExp;
}[] = [
  { state: "injured", category: "physical", expression: /^(?:herid[oa]s?|lesionad[oa]s?|malherid[oa]s?)(?![\p{L}\p{M}])/iu },
  { state: "alive", category: "vital", expression: /^viv[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "dead", category: "vital", expression: /^muert[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "conscious", category: "cognitive", expression: /^conscientes?(?![\p{L}\p{M}])/iu },
  { state: "unconscious", category: "cognitive", expression: /^inconscientes?(?![\p{L}\p{M}])/iu },
  { state: "asleep", category: "cognitive", expression: /^dormid[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "awake", category: "cognitive", expression: /^despiert[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "bound", category: "social", expression: /^(?:atad[oa]s?|encadenad[oa]s?)(?![\p{L}\p{M}])/iu },
  { state: "free", category: "social", expression: /^libres?(?![\p{L}\p{M}])/iu },
  { state: "imprisoned", category: "social", expression: /^(?:pres[oa]s?|encarcelad[oa]s?)(?![\p{L}\p{M}])/iu },
  { state: "trapped", category: "location", expression: /^atrapad[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "sick", category: "physical", expression: /^enferm[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "healthy", category: "physical", expression: /^san[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "exhausted", category: "physical", expression: /^(?:agotad[oa]s?|exhaust[oa]s?)(?![\p{L}\p{M}])/iu },
  { state: "poisoned", category: "physical", expression: /^envenenad[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "pregnant", category: "physical", expression: /^embarazad[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "blind", category: "physical", expression: /^cieg[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "deaf", category: "physical", expression: /^sord[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "mute", category: "physical", expression: /^mud[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "paralyzed", category: "physical", expression: /^paralizad[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "transformed", category: "other", expression: /^transformad[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "afraid", category: "emotional", expression: /^(?:asustad[oa]s?|aterrorizad[oa]s?|temeros[oa]s?)(?![\p{L}\p{M}])/iu },
  { state: "angry", category: "emotional", expression: /^(?:enfadad[oa]s?|enojad[oa]s?|furios[oa]s?)(?![\p{L}\p{M}])/iu },
  { state: "calm", category: "emotional", expression: /^(?:tranquil[oa]s?|calmad[oa]s?)(?![\p{L}\p{M}])/iu },
  { state: "missing", category: "location", expression: /^desaparecid[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "present", category: "location", expression: /^presentes?(?![\p{L}\p{M}])/iu },
  { state: "absent", category: "location", expression: /^(?:ausentes?|alejad[oa]s?)(?![\p{L}\p{M}])/iu },
  { state: "lost", category: "location", expression: /^perdid[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "protected", category: "social", expression: /^protegid[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "confused", category: "cognitive", expression: /^confundid[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "disoriented", category: "cognitive", expression: /^desorientad[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "worried", category: "emotional", expression: /^preocupad[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "hopeful", category: "emotional", expression: /^esperanzad[oa]s?(?![\p{L}\p{M}])/iu },
  { state: "sad", category: "emotional", expression: /^tristes?(?![\p{L}\p{M}])/iu },
  { state: "happy", category: "emotional", expression: /^(?:feliz|felices|content[oa]s?)(?![\p{L}\p{M}])/iu },
  { state: "surprised", category: "emotional", expression: /^sorprendid[oa]s?(?![\p{L}\p{M}])/iu }
];

const COPULA = /^(?<marker>volvi[oó]\s+a\s+|dej[oó]\s+de\s+|ya\s+no\s+|todav[ií]a\s+no\s+|a[uú]n\s+no\s+|nunca\s+|jam[aá]s\s+|no\s+)?(?<copula>est[aá]s?|est[aá]n?|estaba(?:n)?|estuv(?:o|ieron)|estar|estar[aá]n?|er(?:a|an)|fu(?:e|eron)|ser[aá]n?|es|son|sigu(?:e|en|i[oó]|ieron)|permanece(?:n)?|contin[uú](?:a|an|ó)|se\s+encuentra|se\s+encontraba|se\s+siente|se\s+sentía|se\s+sintió|se\s+ve|se\s+veía|se\s+mostraba|qued[oó]|parece(?:n)?)\s+(?<adverb>(?:(?:muy|bastante|gravemente|ligeramente)\s+)?)(?<adjective>[\p{L}\p{M}]+)(?![\p{L}\p{M}])/iu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sentenceSpans(text: string): readonly { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const lines = /[^\n]+/gu;
  for (const line of text.matchAll(lines)) {
    const sentencePattern = /[^.!?]+(?:[.!?]+|$)/gu;
    for (const sentence of line[0].matchAll(sentencePattern)) {
      const leading = sentence[0].search(/\S/u);
      const end = sentence[0].trimEnd().length;
      if (leading < 0 || end <= leading) continue;
      spans.push({
        start: line.index + sentence.index + leading,
        end: line.index + sentence.index + end
      });
    }
  }
  return spans;
}

function tenseOf(copula: string, marker: string): NarrativeCharacterStateCandidate["grammaticalTense"] {
  const form = copula.toLocaleLowerCase("es");
  if (/(?:volvi[oó]\s+a|dej[oó]\s+de)/u.test(marker)) return "past";
  if (/(?:estar[aá]n?|ser[aá]n?)$/u.test(form)) return "future";
  if (/(?:aba|aban|ía|ían|era|eran|fue|fueron|estuvo|estuvieron|sigui[oó]|siguieron|qued[oó]|encontraba|se sentía|se sintió|se veía|se mostraba)$/u.test(form)) return "past";
  if (/^(?:est[aá]s?|est[aá]n?|es|son|sigue|siguen|permanece|permanecen|contin[uú]a|contin[uú]an|se encuentra|se siente|se ve|parece|parecen)$/u.test(form)) return "present";
  return "unknown";
}

function evidence(
  input: NarrativeCharacterStateDiscoveryInput,
  start: number,
  end: number,
  excerpt: string
): TextEvidence {
  return {
    documentId: input.documentId,
    revision: input.revision,
    start: (input.baseOffset ?? 0) + start,
    end: (input.baseOffset ?? 0) + end,
    excerpt
  };
}

function validate(input: NarrativeCharacterStateDiscoveryInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" ||
      input.text.length > 2_000_000 ||
      !Array.isArray(input.entities) ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0))) {
    throw new Error("Contexto inválido para descubrir estados de personajes.");
  }
  const ids = new Set<string>();
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() || ids.has(entity.id) ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        !Array.isArray(entity.aliases) ||
        entity.aliases.some((alias: unknown) => typeof alias !== "string")) {
      throw new Error("La lista de entidades contiene identidades inválidas o ajenas al proyecto.");
    }
    ids.add(entity.id);
  }
}

export function discoverNarrativeCharacterStateCandidates(
  input: NarrativeCharacterStateDiscoveryInput
): readonly NarrativeCharacterStateCandidate[] {
  validate(input);
  const characters = input.entities.filter(entity => entity.kind === "character");
  const nameOwners = new Map<string, Set<string>>();
  for (const entity of characters) {
    for (const name of new Set([entity.canonicalName, ...entity.aliases])) {
      if (typeof name !== "string" || !name.trim()) continue;
      const normalized = name.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es");
      const owners = nameOwners.get(normalized) ?? new Set<string>();
      owners.add(entity.id);
      nameOwners.set(normalized, owners);
    }
  }
  const results: NarrativeCharacterStateCandidate[] = [];
  const seen = new Set<string>();

  for (const span of sentenceSpans(input.text)) {
    const sentence = input.text.slice(span.start, span.end);
    for (const entity of characters) {
      const names = [...new Set([entity.canonicalName, ...entity.aliases]
        .filter(name => typeof name === "string" && name.trim())
        .flatMap(name => [name, name.normalize("NFC"), name.normalize("NFD")])
        .sort((a, b) => b.length - a.length))];
      const matches: { name: string; index: number; end: number }[] = [];
      for (const name of names) {
        const normalizedName = name.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es");
        if ((nameOwners.get(normalizedName)?.size ?? 0) > 1) continue;
        const expression = new RegExp(
          "(?<![\\p{L}\\p{M}\\p{N}_])" + escapeRegExp(name) +
          "(?![\\p{L}\\p{M}\\p{N}_])", "giu"
        );
        for (const match of sentence.matchAll(expression)) {
          matches.push({ name, index: match.index, end: match.index + match[0].length });
        }
      }
      matches.sort((a, b) => a.index - b.index || (b.end - b.index) - (a.end - a.index));
      for (const match of matches) {
        const tail = sentence.slice(match.end);
        const leadingWhitespace = tail.match(/^\s*/u)?.[0].length ?? 0;
        const predicateTail = tail.slice(leadingWhitespace);
        const predicate = COPULA.exec(predicateTail);
        if (!predicate?.groups) continue;
        const adjective = predicate.groups.adjective!;
        const stateMatch = STATE_PATTERNS
          .map(pattern => ({ pattern, match: pattern.expression.exec(adjective) }))
          .find(item => item.match?.index === 0);
        if (!stateMatch) continue;

        const duplicateKey = entity.id + ":" + (span.start + match.index) + ":" + stateMatch.pattern.state;
        if (seen.has(duplicateKey)) continue;
        seen.add(duplicateKey);

        const marker = predicate.groups.marker ?? "";
        const copula = predicate.groups.copula!;
        const adjectiveOffset = predicateTail.indexOf(adjective);
        const predicateStart = span.start + match.end + leadingWhitespace + predicate.index;
        const predicateEnd = span.start + match.end + leadingWhitespace + adjectiveOffset + adjective.length;
        const nameStart = span.start + match.index;
        const nameEnd = span.start + match.end;
        const assertionEnd = span.end;
        const predicateText = sentence.slice(
          match.end + leadingWhitespace + predicate.index,
          match.end + leadingWhitespace + adjectiveOffset + adjective.length
        );
        const stateStart = span.start + match.end + leadingWhitespace + adjectiveOffset;
        const stateEnd = stateStart + adjective.length;
        const polarity = /(?:\bno\b|\bnunca\b|\bjam[aá]s\b|dej[oó]\s+de)/iu.test(marker) ? "negated" : "affirmed";
        const aspect = /volvi[oó]\s+a/iu.test(marker) ? "recurrent"
          : /dej[oó]\s+de/iu.test(marker) ? "ceased"
          : /sigu|permanece|contin[uú]/iu.test(copula) ? "ongoing"
          : "ordinary";
        const mode = /^(?:parece|se siente|se ve)/iu.test(copula) ? "perceptual" : "copular";
        const base = input.baseOffset ?? 0;

        if (results.length >= MAX_NARRATIVE_CHARACTER_STATE_CANDIDATES) {
          throw new Error("La extracción supera el límite de estados; divide el manuscrito por bloques o capítulos.");
        }
        results.push({
          id: "character-state:" + input.documentId + ":" + (base + nameStart) + ":" + stateMatch.pattern.state,
          projectId: input.projectId,
          documentId: input.documentId,
          revision: input.revision,
          entityId: entity.id,
          state: stateMatch.pattern.state,
          category: stateMatch.pattern.category,
          polarity,
          grammaticalTense: tenseOf(copula, marker),
          aspect,
          assertionMode: mode,
          ...classifyStateEpistemicFrame(sentence, match.index, characters, input, span.start),
          reviewStatus: "candidate",
          entityEvidence: evidence(input, nameStart, nameEnd, sentence.slice(match.index, match.end)),
          stateEvidence: evidence(input, stateStart, stateEnd, adjective),
          predicateEvidence: evidence(input, predicateStart, predicateEnd, predicateText),
          evidence: evidence(input, nameStart, assertionEnd, sentence.slice(match.index, assertionEnd - span.start))
        });
      }
    }
  }
  return results.sort((a, b) => a.evidence.start - b.evidence.start || a.entityId.localeCompare(b.entityId));
}
