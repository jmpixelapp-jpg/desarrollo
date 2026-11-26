/**
 * Vincula acciones pronominales con objetivos nominales explícitos.
 * Solo acepta un objetivo único escrito después del verbo; nunca completa objetos omitidos.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";
import type { NarrativeActionCandidate } from "./narrative-action-extraction";
import type { NarrativePronounActionCandidate } from "./narrative-pronoun-action-link";

const MAX_LINKS = 200;
const MAX_ALIASES = 20;

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es");
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Produce acciones completas actor-verbo-objetivo únicamente si el objetivo
 * aparece explícitamente en la misma cláusula y pertenece a una entidad única.
 */
export function linkNarrativePronounActionTargets(
  text: string,
  pronounActions: readonly NarrativePronounActionCandidate[],
  entities: readonly NarrativeEntity[],
  projectId: string,
  baseOffset = 0
): readonly NarrativeActionCandidate[] {
  if (typeof text !== "string" || !Array.isArray(pronounActions) ||
      !Array.isArray(entities) || !projectId.trim() ||
      !Number.isSafeInteger(baseOffset) || baseOffset < 0) {
    throw new Error("Entradas inválidas para vincular objetivos de acciones pronominales.");
  }
  const owners = new Map<string, NarrativeEntity | null>();
  for (const entity of entities) {
    if (!entity || entity.projectId !== projectId ||
        typeof entity.id !== "string" || !entity.id.trim() ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        !Array.isArray(entity.aliases) || entity.aliases.length > MAX_ALIASES) {
      throw new Error("Entidad inválida al vincular objetivos pronominales.");
    }
    if (entity.kind !== "character") continue;
    for (const rawName of [entity.canonicalName, ...entity.aliases]) {
      const key = normalize(rawName);
      const previous = owners.get(key);
      owners.set(key, previous === undefined || previous?.id === entity.id ? entity : null);
    }
  }
  const names = [...owners.entries()].filter((entry): entry is [string, NarrativeEntity] => entry[1] !== null)
    .map(([name, entity]) => ({ name, entity }))
    .sort((a,b) => b.name.length-a.name.length);
  if (!names.length) return [];

  const results: NarrativeActionCandidate[] = [];
  const seen = new Set<string>();
  for (const item of pronounActions) {
    if (!item || item.status !== "candidate" || !item.actorEntityId ||
        !item.evidence || item.evidence.documentId.length === 0 ||
        !Number.isSafeInteger(item.evidence.end)) continue;
    const localEnd = item.evidence.end - baseOffset;
    if (localEnd < 0 || localEnd > text.length) continue;
    const lineEndOffset = text.slice(localEnd).search(/[\r\n.!?;:]/u);
    const suffix = text.slice(localEnd, lineEndOffset < 0 ? text.length : localEnd + lineEndOffset);
    const matches: {entity: NarrativeEntity; index: number; end: number}[] = [];
    for (const {name, entity} of names) {
      const pattern = new RegExp("^\\s+(?:(?:a|al|con|contra|para|por|de|del)\\s+)?(?:(?:el|la|los|las|un|una)\\s+)?" +
        escapeRegExp(name) + "(?![\\p{L}\\p{M}\\p{N}_])", "iu");
      const match = pattern.exec(suffix);
      if (match) matches.push({entity, index: match.index, end: match[0].length});
    }
    const unique = [...new Map(matches.map(match => [match.entity.id, match])).values()];
    if (unique.length !== 1 || unique[0]!.entity.id === item.actorEntityId) continue;
    const target = unique[0]!.entity;
    const evidence: TextEvidence = {
      documentId: item.evidence.documentId,
      revision: item.evidence.revision,
      start: item.evidence.start,
      end: item.evidence.end + unique[0]!.end,
      excerpt: text.slice(
        Math.max(0, text.lastIndexOf("\n", item.evidence.start-baseOffset-1)+1),
        Math.min(text.length, localEnd + unique[0]!.end)
      )
    };
    const id = "pronoun-target-action:" + item.id + ":" + target.id;
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({
      id, projectId, actorEntityId: item.actorEntityId,
      action: item.action, targetEntityId: target.id,
      polarity: item.polarity, reviewStatus: "candidate", evidence
    });
    if (results.length >= MAX_LINKS) break;
  }
  return results;
}
