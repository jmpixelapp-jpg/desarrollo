/**
 * Detección léxica acotada de menciones nominales y pronombres sujeto en español.
 *
 * Solo reconoce nombres canónicos/alias ya registrados y formas él/ella.
 * No deduce género por el nombre, no agrupa plurales y no interpreta clíticos.
 */
import type { NarrativeEntity } from "./narrative-knowledge";
import type {
  NarrativeCharacterMention,
  NarrativePronounReference,
  NarrativeGrammaticalGender
} from "./narrative-pronoun-resolution";

export interface NarrativeCharacterPronounProfile {
  readonly characterId: string;
  /** Debe proceder de metadatos explícitos, nunca del nombre. */
  readonly grammaticalGender: Exclude<NarrativeGrammaticalGender, "unknown"> | "unknown";
}

export interface NarrativePronounDetectionResult {
  readonly mentions: readonly NarrativeCharacterMention[];
  readonly references: readonly NarrativePronounReference[];
  readonly skippedAmbiguousNames: readonly string[];
}

const MAX_TEXT_UNITS = 2_000_000;
const MAX_ENTITIES = 500;
const MAX_MENTIONS = 2_000;
const MAX_REFERENCES = 500;
const MAX_ALIASES = 20;

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es");
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Los perfiles de género son opcionales. Sin perfil, la mención queda unknown
 * y no podrá resolver él/ella: es preferible perder cobertura a inventar género.
 */
export function detectNarrativePronounInputs(
  text: string,
  entities: readonly NarrativeEntity[],
  documentId: string,
  revision: number,
  baseOffset = 0,
  profiles: readonly NarrativeCharacterPronounProfile[] = []
): NarrativePronounDetectionResult {
  if (typeof text !== "string" || text.length > MAX_TEXT_UNITS ||
      !Array.isArray(entities) || entities.length > MAX_ENTITIES ||
      typeof documentId !== "string" || !documentId.trim() ||
      !Number.isSafeInteger(revision) || revision < 0 ||
      !Number.isSafeInteger(baseOffset) || baseOffset < 0 ||
      baseOffset > Number.MAX_SAFE_INTEGER - text.length ||
      !Array.isArray(profiles) || profiles.length > MAX_ENTITIES) {
    throw new Error("Contexto inválido para detectar referencias pronominales.");
  }

  const characterEntities = entities.filter(entity => entity?.kind === "character");
  const entityIds = new Set<string>();
  for (const entity of entities) {
    if (!entity || typeof entity.id !== "string" || !entity.id.trim() ||
        typeof entity.projectId !== "string" || !entity.projectId.trim() ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        !Array.isArray(entity.aliases) || entity.aliases.length > MAX_ALIASES ||
        entity.aliases.some(alias => typeof alias !== "string" || !alias.trim())) {
      throw new Error("Entidad inválida para detección pronominal.");
    }
    if (entityIds.has(entity.id)) throw new Error("Identificador de entidad duplicado.");
    entityIds.add(entity.id);
  }
  const profileById = new Map<string, NarrativeGrammaticalGender>();
  for (const profile of profiles) {
    if (!profile || !entityIds.has(profile.characterId) ||
        !characterEntities.some(entity => entity.id === profile.characterId) ||
        !["masculine", "feminine", "neutral", "unknown"].includes(profile.grammaticalGender) ||
        profileById.has(profile.characterId)) {
      throw new Error("Perfil gramatical inválido o duplicado.");
    }
    profileById.set(profile.characterId, profile.grammaticalGender);
  }

  const owners = new Map<string, string | null>();
  for (const entity of characterEntities) {
    for (const rawName of [entity.canonicalName, ...entity.aliases]) {
      const name = rawName.normalize("NFKC").trim().replace(/\s+/gu, " ");
      const key = normalize(name);
      const previous = owners.get(key);
      owners.set(key, previous === undefined || previous === entity.id ? entity.id : null);
    }
  }
  const names = [...owners.entries()]
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([normalized, characterId]) => {
      const entity = characterEntities.find(item => item.id === characterId)!;
      const rawName = [entity.canonicalName, ...entity.aliases]
        .find(item => normalize(item) === normalized)!;
      return { normalized, characterId, rawName };
    })
    .sort((a,b) => b.rawName.length-a.rawName.length || a.normalized.localeCompare(b.normalized));
  const skippedAmbiguousNames = [...owners.entries()]
    .filter((entry): entry is [string, null] => entry[1] === null)
    .map(([name]) => name).sort();

  const mentions: NarrativeCharacterMention[] = [];
  const mentionRanges: { start: number; end: number }[] = [];
  for (const item of names) {
    const expression = new RegExp(
      "(?<![\\p{L}\\p{M}\\p{N}_])" + escapeRegExp(item.rawName) +
      "(?![\\p{L}\\p{M}\\p{N}_])", "giu"
    );
    for (const match of text.matchAll(expression)) {
      const start = baseOffset + (match.index ?? 0);
      const end = start + match[0].length;
      mentions.push({
        characterId: item.characterId, documentId, revision, start, end,
        grammaticalNumber: "singular",
        grammaticalGender: profileById.get(item.characterId) ?? "unknown"
      });
      mentionRanges.push({ start: start-baseOffset, end: end-baseOffset });
      if (mentions.length >= MAX_MENTIONS) break;
    }
    if (mentions.length >= MAX_MENTIONS) break;
  }
  mentions.sort((a,b) => a.start-b.start || a.end-b.end || a.characterId.localeCompare(b.characterId));

  const references: NarrativePronounReference[] = [];
  const pronounPattern = /(?<![\p{L}\p{M}\p{N}_])(él|ella)(?![\p{L}\p{M}\p{N}_])/giu;
  for (const match of text.matchAll(pronounPattern)) {
    const localStart = match.index ?? 0;
    const localEnd = localStart + match[0].length;
    if (mentionRanges.some(range => localStart < range.end && localEnd > range.start)) continue;
    const surface = match[0];
    const grammaticalGender: NarrativeGrammaticalGender =
      normalize(surface) === "él" ? "masculine" : "feminine";
    const start = baseOffset + localStart;
    references.push({
      id: "pronoun:" + documentId + ":" + revision + ":" + start,
      documentId, revision, start, end: baseOffset + localEnd,
      surface, grammaticalNumber: "singular", grammaticalGender
    });
    if (references.length >= MAX_REFERENCES) break;
  }

  return { mentions, references, skippedAmbiguousNames };
}
