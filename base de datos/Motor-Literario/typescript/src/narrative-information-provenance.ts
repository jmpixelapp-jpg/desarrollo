/**
 * Procedencia epistemológica explícita de información narrativa.
 *
 * Distingue al personaje que recibe/conserva información, su canal de acceso
 * y, cuando el texto lo nombra inequívocamente, la fuente que se la transmite.
 * No determina si el contenido es verdadero.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

export type NarrativeInformationChannel =
  | "visual-observation"
  | "auditory-observation"
  | "written-source"
  | "reported-speech"
  | "rumor";

export type NarrativeInformationStatus = "observed" | "reported" | "rumored";

export interface NarrativeInformationProvenance {
  readonly id: string;
  readonly projectId: string;
  /** Personaje que percibe, recibe o conoce la información; ausente en rumor impersonal. */
  readonly informationHolderEntityId?: string;
  /** Personaje que comunica la información; solo cuando aparece explícitamente. */
  readonly sourceEntityId?: string;
  readonly channel: NarrativeInformationChannel;
  readonly status: NarrativeInformationStatus;
  readonly content: string;
  readonly reviewStatus: "candidate";
  readonly evidence: TextEvidence;
  readonly contentEvidence: TextEvidence;
  readonly holderEvidence?: TextEvidence;
  readonly sourceEvidence?: TextEvidence;
}

export interface NarrativeInformationProvenanceInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
}

export const MAX_NARRATIVE_INFORMATION_PROVENANCE = 200;
const MAX_TEXT_UNITS = 2_000_000;
const MAX_CONTENT_UNITS = 1000;

interface NamedCharacter {
  readonly entity: NarrativeEntity;
  readonly name: string;
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es");
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function evidence(
  input: NarrativeInformationProvenanceInput,
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
function validate(input: NarrativeInformationProvenanceInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_TEXT_UNITS ||
      !Array.isArray(input.entities) ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para extraer procedencia de información narrativa.");
  }
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        !Array.isArray(entity.aliases) ||
        entity.aliases.some(alias => typeof alias !== "string" || !alias.trim())) {
      throw new Error("Las entidades deben ser válidas y pertenecer al proyecto.");
    }
  }
}
function uniqueCharacters(entities: readonly NarrativeEntity[]): readonly NamedCharacter[] {
  const owners = new Map<string, NarrativeEntity | null>();
  for (const entity of entities.filter(item => item.kind === "character")) {
    for (const name of [entity.canonicalName, ...entity.aliases]) {
      const key = normalizeName(name);
      const current = owners.get(key);
      owners.set(key, current === undefined || current.id === entity.id ? entity : null);
    }
  }
  return [...owners.entries()]
    .filter((entry): entry is [string, NarrativeEntity] => entry[1] !== null)
    .map(([key, entity]) => ({
      entity,
      name: [entity.canonicalName, ...entity.aliases]
        .find(name => normalizeName(name) === key)!
    }))
    .sort((a, b) => b.name.length - a.name.length);
}

/**
 * Solo reconoce construcciones explícitas en una misma oración.
 * La ausencia de fuente nombrada se conserva como ausencia, nunca se adivina.
 */
export function extractNarrativeInformationProvenance(
  input: NarrativeInformationProvenanceInput
): readonly NarrativeInformationProvenance[] {
  validate(input);
  const names = uniqueCharacters(input.entities);
  const found = new Map<string, NarrativeInformationProvenance>();

  const add = (
    channel: NarrativeInformationChannel,
    status: NarrativeInformationStatus,
    sentenceStart: number,
    sentenceEnd: number,
    contentStart: number,
    contentEnd: number,
    holder?: { entity: NarrativeEntity; start: number; end: number },
    source?: { entity: NarrativeEntity; start: number; end: number }
  ) => {
    const content = input.text.slice(contentStart, contentEnd).trim();
    if (!content || content.length > MAX_CONTENT_UNITS) return;
    const leadingTrim = input.text.slice(contentStart, contentEnd).length -
      input.text.slice(contentStart, contentEnd).trimStart().length;
    const actualContentStart = contentStart + leadingTrim;
    const actualContentEnd = actualContentStart + content.length;
    const absoluteStart = (input.baseOffset ?? 0) + sentenceStart;
    const id = `information:${input.documentId}:${absoluteStart}:${channel}:${holder?.entity.id ?? "impersonal"}`;
    const sentence = input.text.slice(sentenceStart, sentenceEnd);
    found.set(id, {
      id,
      projectId: input.projectId,
      ...(holder ? { informationHolderEntityId: holder.entity.id } : {}),
      ...(source ? { sourceEntityId: source.entity.id } : {}),
      channel,
      status,
      content,
      reviewStatus: "candidate",
      evidence: evidence(input, sentenceStart, sentenceEnd, sentence),
      contentEvidence: evidence(input, actualContentStart, actualContentEnd, content),
      ...(holder ? {
        holderEvidence: evidence(input, holder.start, holder.end,
          input.text.slice(holder.start, holder.end))
      } : {}),
      ...(source ? {
        sourceEvidence: evidence(input, source.start, source.end,
          input.text.slice(source.start, source.end))
      } : {})
    });
  };

  // Split only at terminal punctuation; offsets remain tied to the original text.
  const sentenceExpression = /[^.!?\n]+(?:[.!?]+|$)/gu;
  for (const sentenceMatch of input.text.matchAll(sentenceExpression)) {
    if (found.size >= MAX_NARRATIVE_INFORMATION_PROVENANCE) break;
    const sentence = sentenceMatch[0];
    const sentenceStart = sentenceMatch.index ?? 0;
    const sentenceEnd = sentenceStart + sentence.length;
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const trimStart = sentence.indexOf(trimmed);
    const localStart = sentenceStart + trimStart;
    const localEnd = localStart + trimmed.length;
    const scoped = input.text.slice(localStart, localEnd);

    // Impersonal rumor: no holder and no source are invented.
    const rumor = /^(?:según los rumores[, ]+)?se rumorea que\s+(.+?)[.!?]*$/iu.exec(scoped);
    if (rumor) {
      const content = rumor[1] ?? "";
      const contentStart = localStart + rumor[0].indexOf(content);
      add("rumor", "rumored", sentenceStart, sentenceEnd, contentStart,
        contentStart + content.length);
    }

    for (const { entity, name } of names) {
      const escaped = escapeRegExp(name);
      const patterns: readonly {
        regex: RegExp;
        channel: NarrativeInformationChannel;
        status: NarrativeInformationStatus;
        contentGroup: number;
        sourceGroup?: number;
      }[] = [
        {
          regex: new RegExp(String.raw`(?<![\\p{L}\\p{M}\\p{N}_])(${escaped})(?![\\p{L}\\p{M}\\p{N}_])\\s+(?:vio|observó|observo)\\s+que\\s+(.+?)[.!?]*$`, "iu"),
          channel: "visual-observation", status: "observed", contentGroup: 2
        },
        {
          regex: new RegExp(String.raw`(?<![\\p{L}\\p{M}\\p{N}_])(${escaped})(?![\\p{L}\\p{M}\\p{N}_])\\s+(?:oyó|oyo|escuchó|escucho)\\s+que\\s+(.+?)[.!?]*$`, "iu"),
          channel: "auditory-observation", status: "observed", contentGroup: 2
        },
        {
          regex: new RegExp(String.raw`(?<![\\p{L}\\p{M}\\p{N}_])(${escaped})(?![\\p{L}\\p{M}\\p{N}_])\\s+(?:leyó|leyo)\\s+que\\s+(.+?)[.!?]*$`, "iu"),
          channel: "written-source", status: "reported", contentGroup: 2
        }
      ];
      for (const pattern of patterns) {
        const match = pattern.regex.exec(scoped);
        if (!match) continue;
        const holderName = match[1] ?? "";
        const content = match[pattern.contentGroup] ?? "";
        const holderStart = localStart + match.index + match[0].indexOf(holderName);
        const contentStart = localStart + match.index + match[0].lastIndexOf(content);
        add(pattern.channel, pattern.status, sentenceStart, sentenceEnd,
          contentStart, contentStart + content.length,
          { entity, start: holderStart, end: holderStart + holderName.length });
      }
    }

    // Explicit report: source tells recipient. Both identities must be unique.
    for (const sourceName of names) {
      for (const holderName of names) {
        const expression = new RegExp(
          String.raw`(?<![\\p{L}\\p{M}\\N_])(${escapeRegExp(sourceName.name)})(?![\\p{L}\\p{M}\\N_])\\s+(?:le contó|le conto|le dijo|le explicó|le explico)\\s+a\\s+(${escapeRegExp(holderName.name)})(?![\\p{L}\\p{M}\\N_])\\s+que\\s+(.+?)[.!?]*$`,
          "iu"
        );
        const match = expression.exec(scoped);
        if (!match) continue;
        const sourceText = match[1] ?? "";
        const holderText = match[2] ?? "";
        const content = match[3] ?? "";
        const sourceStart = localStart + match.index + match[0].indexOf(sourceText);
        const holderStart = localStart + match.index + match[0].indexOf(holderText, match[0].indexOf(sourceText) + sourceText.length);
        const contentStart = localStart + match.index + match[0].lastIndexOf(content);
        add("reported-speech", "reported", sentenceStart, sentenceEnd,
          contentStart, contentStart + content.length,
          { entity: holderName.entity, start: holderStart, end: holderStart + holderText.length },
          { entity: sourceName.entity, start: sourceStart, end: sourceStart + sourceText.length });
      }
    }
  }
  return [...found.values()].sort((a, b) =>
    a.evidence.start - b.evidence.start || a.id.localeCompare(b.id)
  );
}
