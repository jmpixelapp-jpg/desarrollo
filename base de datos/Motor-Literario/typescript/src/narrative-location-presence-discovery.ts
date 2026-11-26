/**
 * Descubre afirmaciones explícitas de presencia de personajes en lugares.
 *
 * Requiere un personaje nombrado, una construcción locativa explícita y un
 * lugar tipado. No resuelve pronombres, no infiere ubicación actual y no
 * transforma una negación o hipótesis en presencia efectiva.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

export type NarrativeLocationPresenceTense =
  | "present" | "past" | "future" | "conditional" | "unknown";

export type NarrativeLocationPresenceStatus =
  | "candidate" | "prospective" | "not-applied" | "hypothetical";

export interface NarrativeLocationPresenceCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly characterEntityId: string;
  readonly locationEntityId: string;
  readonly polarity: "affirmed" | "negated";
  readonly grammaticalTense: NarrativeLocationPresenceTense;
  readonly effectStatus: NarrativeLocationPresenceStatus;
  readonly assertionMode: "copular" | "perceptual" | "modal";
  readonly characterEvidence: TextEvidence;
  readonly predicateEvidence: TextEvidence;
  readonly relationEvidence: TextEvidence;
  readonly locationEvidence: TextEvidence;
  readonly evidence: TextEvidence;
  readonly reviewStatus: "candidate";
}

export interface NarrativeLocationPresenceDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
}

export const MAX_NARRATIVE_LOCATION_PRESENCE_CANDIDATES = 200;
export const MAX_NARRATIVE_LOCATION_PRESENCE_TEXT_UNITS = 2_000_000;

interface Span { readonly start: number; readonly end: number; }
interface Mention { readonly entity: NarrativeEntity; readonly start: number; readonly end: number; readonly surface: string; }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sentenceSpans(text: string): readonly Span[] {
  const spans: Span[] = [];
  const expression = /[^.!?\r\n]+(?:[.!?]+|$)/gu;
  for (const match of text.matchAll(expression)) {
    const raw = match[0];
    const leading = raw.search(/\S/u);
    const trailing = raw.trimEnd().length;
    if (leading < 0 || trailing <= leading || !/[\p{L}\p{N}]/u.test(raw)) continue;
    spans.push({
      start: (match.index ?? 0) + leading,
      end: (match.index ?? 0) + trailing
    });
  }
  return spans;
}

function validate(input: NarrativeLocationPresenceDiscoveryInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" ||
      input.text.length > MAX_NARRATIVE_LOCATION_PRESENCE_TEXT_UNITS ||
      !Array.isArray(input.entities) ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
         input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para descubrir presencia explícita en lugares.");
  }
  const ids = new Set<string>();
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() || ids.has(entity.id) ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        !Array.isArray(entity.aliases) ||
        entity.aliases.some((alias: unknown) => typeof alias !== "string")) {
      throw new Error("Las entidades contienen identidades o alias inválidos.");
    }
    ids.add(entity.id);
  }
}

function evidence(
  input: NarrativeLocationPresenceDiscoveryInput,
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

function findMentions(
  sentence: string,
  start: number,
  entities: readonly NarrativeEntity[],
  ambiguousNames: ReadonlySet<string>
): readonly Mention[] {
  const mentions: Mention[] = [];
  for (const entity of entities) {
    const names = [...new Set([entity.canonicalName, ...entity.aliases]
      .filter((name): name is string => typeof name === "string" && !!name.trim())
      .flatMap(name => [name, name.normalize("NFC"), name.normalize("NFD")]))]
      .sort((a, b) => b.length - a.length);
    for (const name of names) {
      const normalized = name.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es");
      if (ambiguousNames.has(normalized)) continue;
      const expression = new RegExp(
        "(?<![\\p{L}\\p{M}\\p{N}_])" + escapeRegExp(name) +
        "(?![\\p{L}\\p{M}\\p{N}_])", "giu"
      );
      for (const match of sentence.matchAll(expression)) {
        mentions.push({
          entity, start: start + match.index,
          end: start + match.index + match[0].length,
          surface: match[0]
        });
      }
    }
  }
  const unique = new Map<string, Mention>();
  for (const mention of mentions) {
    const key = mention.entity.id + ":" + mention.start + ":" + mention.end;
    if (!unique.has(key)) unique.set(key, mention);
  }
  return [...unique.values()].sort((a, b) =>
    a.start - b.start || (b.end - b.start) - (a.end - a.start)
  );
}

const LOCATION_ASSERTION = /(?<marker>ya\s+no\s+|no\s+|nunca\s+|jam[aá]s\s+)?(?<copula>parece\s+estar|parecía\s+estar|podr[ií]a\s+estar|estar[ií]a|est[aá](?:n|s)?|estaba(?:n)?|estuv(?:o|ieron)|estar[aá]n?|se\s+encuentra|se\s+encontraba|se\s+encontrar[aá]|permanece|permanec[ií]a|permanecer[aá]|vive|viv[ií]a|vivir[aá]|habita|habitaba|habitar[aá])\s+(?<relation>en|dentro\s+de|dentro\s+del|sobre|bajo|cerca\s+de|junto\s+a|al\s+lado\s+de|frente\s+a|lejos\s+de)\s+(?:(?:el|la|los|las|un|una|unos|unas)\s+)?/iu;

function tenseOf(copula: string): NarrativeLocationPresenceTense {
  const value = copula.toLocaleLowerCase("es");
  if (/(?:estar[aá]n?|se encontrar[aá]|permanecer[aá]|vivir[aá]|habitar[aá])$/u.test(value)) return "future";
  if (/(?:estar[ií]a|podr[ií]a\s+estar)$/u.test(value)) return "conditional";
  if (/(?:parec[ií]a|estaba(?:n)?|estuvo|estuvieron|se encontraba|permanec[ií]a|viv[ií]a|habitaba)$/u.test(value)) return "past";
  if (/^(?:parece\s+estar|est[aá](?:n|s)?|se encuentra|permanece|vive|habita)$/u.test(value)) return "present";
  return "unknown";
}

/**
 * Solo asocia un personaje con un lugar si es el único personaje nombrado en
 * la oración y la cópula locativa aparece inmediatamente después de su nombre.
 * Los lugares deben estar tipados como kind=location y ser inequívocos.
 */
export function discoverNarrativeLocationPresenceCandidates(
  input: NarrativeLocationPresenceDiscoveryInput
): readonly NarrativeLocationPresenceCandidate[] {
  validate(input);
  const characters = input.entities.filter(entity => entity.kind === "character");
  const locations = input.entities.filter(entity => entity.kind === "location");
  const nameOwners = new Map<string, Set<string>>();
  for (const entity of [...characters, ...locations]) {
    for (const name of new Set([entity.canonicalName, ...entity.aliases])) {
      const normalized = name.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es");
      const owners = nameOwners.get(normalized) ?? new Set<string>();
      owners.add(entity.id);
      nameOwners.set(normalized, owners);
    }
  }
  const ambiguousNames = new Set(
    [...nameOwners].filter(([, owners]) => owners.size > 1).map(([name]) => name)
  );
  const results: NarrativeLocationPresenceCandidate[] = [];
  const seen = new Set<string>();

  for (const span of sentenceSpans(input.text)) {
    const sentence = input.text.slice(span.start, span.end);
    const mentions = findMentions(sentence, span.start, [...characters, ...locations], ambiguousNames);
    const characterMentions = mentions.filter(item => item.entity.kind === "character");
    const locationMentions = mentions.filter(item => item.entity.kind === "location");
    if (characterMentions.length !== 1 || locationMentions.length === 0) continue;
    const character = characterMentions[0]!;
    for (const location of locationMentions) {
      if (location.start <= character.end) continue;
      const tail = sentence.slice(character.end - span.start);
      const leading = tail.match(/^\s*/u)?.[0].length ?? 0;
      const assertion = LOCATION_ASSERTION.exec(tail.slice(leading));
      if (!assertion?.groups) continue;
      const assertionStart = character.end - span.start + leading + assertion.index;
      const relationStart = predicateEnd;
      const locationRelative = location.start - span.start;
      const locationStartInSentence = locationRelative;
      const relationText = sentence.slice(relationStart, locationStartInSentence);
      if (locationStartInSentence < relationStart ||
          !/^(?:\s+(?:en|dentro\s+de|dentro\s+del|sobre|bajo|cerca\s+de|junto\s+a|al\s+lado\s+de|frente\s+a|lejos\s+de)\s+(?:(?:el|la|los|las|un|una|unos|unas)\s+)?)$/iu.test(relationText)) {
        continue;
      }

      const copula = assertion.groups.copula!;
      const marker = assertion.groups.marker ?? "";
      const predicateEnd = assertionStart + marker.length + copula.length;
      const polarity = /(?:\bno\b|\bnunca\b|\bjam[aá]s\b)/iu.test(marker)
        ? "negated" as const : "affirmed" as const;
      const tense = tenseOf(copula);
      const mode = /parec|podr[ií]a/iu.test(copula)
        ? /podr[ií]a/iu.test(copula) ? "modal" as const : "perceptual" as const
        : "copular" as const;
      const status: NarrativeLocationPresenceStatus = polarity === "negated"
        ? "not-applied"
        : tense === "future" ? "prospective"
        : tense === "conditional" ? "hypothetical"
        : "candidate";
      const id = "location-presence:" + input.documentId + ":" +
        input.revision + ":" + (input.baseOffset ?? 0) + ":" +
        character.start + ":" + location.entity.id;
      if (seen.has(id)) continue;
      seen.add(id);

      const assertionEnd = location.end - span.start;
      results.push({
        id,
        projectId: input.projectId,
        documentId: input.documentId,
        revision: input.revision,
        characterEntityId: character.entity.id,
        locationEntityId: location.entity.id,
        polarity,
        grammaticalTense: tense,
        effectStatus: status,
        assertionMode: mode,
        characterEvidence: evidence(input, character.start, character.end, character.surface),
        predicateEvidence: evidence(
          input,
          span.start + assertionStart,
          span.start + relationStart,
          sentence.slice(assertionStart, relationStart)
        ),
        relationEvidence: evidence(
          input,
          span.start + relationStart,
          location.start,
          relationText
        ),
        locationEvidence: evidence(input, location.start, location.end, location.surface),
        evidence: evidence(
          input,
          character.start,
          span.start + assertionEnd,
          sentence.slice(character.start - span.start, assertionEnd)
        ),
        reviewStatus: "candidate"
      });
      if (results.length >= MAX_NARRATIVE_LOCATION_PRESENCE_CANDIDATES) return results;
    }
  }
  return results.sort((a, b) => a.evidence.start - b.evidence.start);
}
