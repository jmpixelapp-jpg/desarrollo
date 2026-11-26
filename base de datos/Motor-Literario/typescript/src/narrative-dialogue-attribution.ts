/**
 * Atribución conservadora de intervenciones de diálogo en español.
 * Solo asigna hablante cuando una etiqueta explícita de habla y un nombre
 * único aparecen en una de las estructuras reconocidas.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

export type NarrativeDialogueAttributionForm =
  | "dash-after-dialogue"
  | "quote-after-dialogue"
  | "speaker-before-dialogue";

export interface NarrativeDialogueAttribution {
  readonly id: string;
  readonly projectId: string;
  readonly speakerEntityId: string;
  readonly speech: string;
  readonly attributionForm: NarrativeDialogueAttributionForm;
  readonly reviewStatus: "candidate";
  readonly evidence: TextEvidence;
  readonly speechEvidence: TextEvidence;
  readonly speakerEvidence: TextEvidence;
}

export interface NarrativeDialogueAttributionInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
}

export const MAX_NARRATIVE_DIALOGUE_ATTRIBUTIONS = 300;
const MAX_TEXT_UNITS = 2_000_000;
const SPEECH_VERBS = [
  "dijo", "dice", "dij[oó]", "preguntó", "pregunta", "respondió",
  "responde", "exclamó", "exclama", "susurró", "susurra", "gritó",
  "grita", "murmuró", "murmura", "contestó", "contesta", "añadió",
  "añade", "replicó", "replica", "ordenó", "ordena"
].join("|");

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function evidence(
  input: NarrativeDialogueAttributionInput,
  start: number,
  end: number,
  excerpt: string
): TextEvidence {
  const base = input.baseOffset ?? 0;
  return {
    documentId: input.documentId,
    revision: input.revision,
    start: base + start,
    end: base + end,
    excerpt
  };
}

function validate(input: NarrativeDialogueAttributionInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_TEXT_UNITS ||
      !Array.isArray(input.entities) ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para atribuir diálogos narrativos.");
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

/**
 * No utiliza turnos alternos ni proximidad entre párrafos para adivinar
 * hablantes. Las líneas sin etiqueta explícita quedan sin atribución.
 */
export function extractNarrativeDialogueAttributions(
  input: NarrativeDialogueAttributionInput
): readonly NarrativeDialogueAttribution[] {
  validate(input);
  const owners = new Map<string, NarrativeEntity | null>();
  for (const entity of input.entities.filter(item => item.kind === "character")) {
    for (const name of [entity.canonicalName, ...entity.aliases]) {
      const key = normalizeName(name);
      const owner = owners.get(key);
      owners.set(key, owner === undefined || owner?.id === entity.id ? entity : null);
    }
  }
  const names = [...owners.entries()]
    .filter((entry): entry is [string, NarrativeEntity] => entry[1] !== null)
    .map(([normalized, entity]) => ({
      entity,
      name: [entity.canonicalName, ...entity.aliases]
        .find(value => normalizeName(value) === normalized)!
    }))
    .sort((a, b) => b.name.length - a.name.length);
  if (!names.length) return [];

  const results = new Map<string, NarrativeDialogueAttribution>();
  const add = (
    entity: NarrativeEntity,
    form: NarrativeDialogueAttributionForm,
    lineStart: number,
    line: string,
    speechStart: number,
    speechEnd: number,
    speakerStart: number,
    speakerEnd: number
  ) => {
    const speech = input.text.slice(speechStart, speechEnd);
    if (!speech.trim() || speech.length > 10_000) return;
    const absoluteStart = (input.baseOffset ?? 0) + lineStart + speakerStart;
    const id = `dialogue:${input.documentId}:${absoluteStart}:${entity.id}`;
    results.set(id, {
      id,
      projectId: input.projectId,
      speakerEntityId: entity.id,
      speech,
      attributionForm: form,
      reviewStatus: "candidate",
      evidence: evidence(input, lineStart, lineStart + line.length, line),
      speechEvidence: evidence(input, lineStart + speechStart, lineStart + speechEnd, speech),
      speakerEvidence: evidence(
        input, lineStart + speakerStart, lineStart + speakerEnd,
        input.text.slice(lineStart + speakerStart, lineStart + speakerEnd)
      )
    });
  };

  for (const lineMatch of input.text.matchAll(/[^\n]+/gu)) {
    if (results.size >= MAX_NARRATIVE_DIALOGUE_ATTRIBUTIONS) break;
    const line = lineMatch[0].replace(/\r$/u, "");
    const lineStart = lineMatch.index ?? 0;
    for (const { entity, name } of names) {
      const escapedName = escapeRegExp(name);
      const verbs = SPEECH_VERBS;
      const patterns: readonly {
        form: NarrativeDialogueAttributionForm;
        regex: RegExp;
        speechGroup: number;
        nameGroup: number;
      }[] = [
        {
          form: "dash-after-dialogue",
          regex: new RegExp(
            String.raw`^[\\t ]*[—–-][\\t ]*(.+?)[\\t ]+[—–-][\\t ]*(?:${verbs})[\\t ]+${escapedName}[.!?…]?[\\t ]*$`,
            "iu"
          ),
          speechGroup: 1, nameGroup: 0
        },
        {
          form: "quote-after-dialogue",
          regex: new RegExp(
            String.raw`[«“"](.+?)[»”"][,]?[\\t ]+(?:${verbs})[\\t ]+(${escapedName})(?=[.!?…]?[\\t ]*$)`,
            "iu"
          ),
          speechGroup: 1, nameGroup: 2
        },
        {
          form: "speaker-before-dialogue",
          regex: new RegExp(
            String.raw`(^|[.!?][\\t ]+)(${escapedName})[\\t ]+(?:${verbs})[\\t ]*:[\\t ]*[«“"](.+?)[»”"]`,
            "iu"
          ),
          speechGroup: 3, nameGroup: 2
        }
      ];

      for (const pattern of patterns) {
        const match = pattern.regex.exec(line);
        if (!match) continue;
        const speech = match[pattern.speechGroup] ?? "";
        const speechIndex = match.index + match[0].indexOf(speech);
        const nameIndex = pattern.form === "dash-after-dialogue"
          ? line.toLocaleLowerCase("es").lastIndexOf(name.toLocaleLowerCase("es"))
          : pattern.form === "quote-after-dialogue"
            ? match.index + match[0].lastIndexOf(name)
            : match.index + match[0].indexOf(name, match[0].indexOf(":"));
        if (nameIndex < 0) continue;
        add(
          entity, pattern.form, lineStart, line,
          speechIndex + (pattern.form === "speaker-before-dialogue" ? 0 : 0),
          speechIndex + speech.length,
          nameIndex, nameIndex + name.length
        );
        if (results.size >= MAX_NARRATIVE_DIALOGUE_ATTRIBUTIONS) break;
      }
    }
  }
  return [...results.values()].sort((a, b) =>
    a.speechEvidence.start - b.speechEvidence.start || a.id.localeCompare(b.id)
  );
}
