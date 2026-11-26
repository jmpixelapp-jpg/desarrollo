/**
 * Observaciones de acciones narrativas respaldadas por frases del manuscrito.
 *
 * Extrae señales léxicas explícitas vinculadas a personajes ya identificados.
 * No pretende resolver por sí solo el sujeto gramatical ni la causalidad:
 * cuando una frase menciona varios personajes, conserva todos como participantes
 * y conserva la mención sin atribuir el papel sintáctico.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

export const MAX_NARRATIVE_OBSERVATION_TEXT_UNITS = 2_000_000;
export const MAX_NARRATIVE_OBSERVATION_CANDIDATES = 200;

export interface NarrativeObservationCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly kind: "action";
  readonly action: string;
  readonly surface: string;
  /** Único personaje mencionado, si lo hay; nunca equivale a sujeto o agente confirmado. */
  readonly singleMentionedCharacterId?: string;
  /** Personajes mencionados; no implica que todos ejecuten la acción. */
  readonly mentionedCharacterIds: readonly string[];
  /** Otras entidades mencionadas; no se interpreta su papel semántico. */
  readonly mentionedEntityIds: readonly string[];
  readonly polarity: "affirmed" | "negated";
  readonly confidence: "medium";
  readonly reviewStatus: "candidate";
  readonly evidence: TextEvidence;
}

export interface NarrativeObservationDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
}

interface ActionSignal {
  readonly action: string;
  readonly expression: RegExp;
}

const ACTION_SIGNALS: readonly ActionSignal[] = [
  { action: "cruzar", expression: /\bcruz(?:ó|aba|aron|aron|a|an|ar|ado|ando)\b/giu },
  { action: "entrar", expression: /\bentr(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "salir", expression: /\bsal(?:ió|ía|ieron|e|en|ir|ido|iendo)\b/giu },
  { action: "llegar", expression: /\blleg(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "huir", expression: /\bhu(?:yó|ía|yeron|ye|yen|ir|ido|endo)\b/giu },
  { action: "correr", expression: /\bcorr(?:ió|ía|ieron|e|en|er|ido|iendo)\b/giu },
  { action: "caminar", expression: /\bcamin(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "mirar", expression: /\bmir(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "decir", expression: /\b(?:dijo|decía|dijeron|dice|dicen|decir|dicho)\b/giu },
  { action: "responder", expression: /\brespond(?:ió|ía|ieron|e|en|er|ido|iendo)\b/giu },
  { action: "preguntar", expression: /\bpregunt(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "gritar", expression: /\bgrit(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "tomar", expression: /\btom(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "abrir", expression: /\babri(?:ó|ía|eron|r|erto|endo)\b/giu },
  { action: "cerrar", expression: /\bcerr(?:ó|aba|aron|ó|ar|ado|ando)\b/giu },
  { action: "encontrar", expression: /\bencontr(?:ó|aba|aron|ó|ar|ado|ando)\b/giu },
  { action: "perder", expression: /\bperd(?:ió|ía|ieron|er|ido|iendo)\b/giu },
  { action: "entregar", expression: /\bentreg(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "recibir", expression: /\brecibi(?:ó|ía|eron|r|do|endo)\b/giu },
  { action: "atacar", expression: /\batac(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "ayudar", expression: /\bayud(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "salvar", expression: /\bsalv(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "proteger", expression: /\bproteg(?:ió|ía|ieron|e|en|er|ido|iendo)\b/giu },
  { action: "traicionar", expression: /\btraicion(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "buscar", expression: /\bbusc(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "descubrir", expression: /\bdescubri(?:ó|ía|eron|r|erto|endo)\b/giu },
  { action: "recordar", expression: /\brecord(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "olvidar", expression: /\bolvid(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "decidir", expression: /\bdecidi(?:ó|ía|eron|r|do|endo)\b/giu },
  { action: "intentar", expression: /\bintent(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "regresar", expression: /\bregres(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "volver", expression: /\bvolvi(?:ó|a|eron|ó|er|do|endo)\b/giu },
  { action: "golpear", expression: /\bgolpe(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "abrazar", expression: /\babraz(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "matar", expression: /\bmat(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "morir", expression: /\bmur(?:ió|ió|ieron|iera|ieron|ir|iendo)\b/giu },
  { action: "despertar", expression: /\bdespert(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "observar", expression: /\bobserv(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "escuchar", expression: /\bescuch(?:ó|aba|aron|a|an|ar|ado|ando)\b/giu },
  { action: "sentir", expression: /\bsinti(?:ó|ó|a|eron|r|ó|endo)\b/giu },
  { action: "pensar", expression: /\bpens(?:ó|aba|aron|ó|ar|ado|ando)\b/giu },
  { action: "creer", expression: /\bcre(?:yó|ía|yeron|e|en|er|ído|yendo)\b/giu }
];

function validateInput(input: NarrativeObservationDiscoveryInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" ||
      input.text.length > MAX_NARRATIVE_OBSERVATION_TEXT_UNITS ||
      !Array.isArray(input.entities) ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para descubrir observaciones narrativas.");
  }
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() ||
        typeof entity.kind !== "string" ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        !Array.isArray(entity.aliases)) {
      throw new Error("La lista de entidades contiene registros inválidos o de otro proyecto.");
    }
  }
}

function splitSentences(text: string): readonly { start: number; end: number }[] {
  const result: { start: number; end: number }[] = [];
  const expression = /[^\n]+/gu;
  for (const line of text.matchAll(expression)) {
    const sentenceExpression = /[^.!?]+(?:[.!?]+|$)/gu;
    for (const sentence of line[0].matchAll(sentenceExpression)) {
      const leading = sentence[0].search(/\S/u);
      const end = sentence[0].trimEnd().length;
      if (leading < 0 || end <= leading) continue;
      result.push({
        start: line.index + sentence.index + leading,
        end: line.index + sentence.index + end
      });
    }
  }
  return result;
}

function includesName(sentence: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])" + escaped +
    "(?![\\p{L}\\p{M}\\p{N}_])", "iu").test(sentence);
}

/**
 * Devuelve acciones explícitas de frases que mencionan personajes ya conocidos.
 * La función no atribuye sujeto cuando aparecen dos o más personajes.
 */
export function discoverNarrativeObservationCandidates(
  input: NarrativeObservationDiscoveryInput
): readonly NarrativeObservationCandidate[] {
  validateInput(input);
  const baseOffset = input.baseOffset ?? 0;
  const characters = input.entities.filter(entity => entity.kind === "character");
  const otherEntities = input.entities.filter(entity => entity.kind !== "character");
  const results = new Map<string, NarrativeObservationCandidate>();

  for (const segment of splitSentences(input.text)) {
    const sentence = input.text.slice(segment.start, segment.end);
    const mentionedCharacters = characters.filter(entity =>
      [entity.canonicalName, ...entity.aliases].some(name => includesName(sentence, name))
    );
    if (mentionedCharacters.length === 0) continue;
    const mentionedOthers = otherEntities.filter(entity =>
      [entity.canonicalName, ...entity.aliases].some(name => includesName(sentence, name))
    );
    const lineStart = input.text.lastIndexOf("\n", segment.start - 1) + 1;
    const lineBreak = input.text.indexOf("\n", segment.end);
    const lineEnd = lineBreak < 0 ? input.text.length : lineBreak;
    const excerpt = input.text.slice(lineStart, lineEnd);

    for (const signal of ACTION_SIGNALS) {
      signal.expression.lastIndex = 0;
      for (const match of sentence.matchAll(signal.expression)) {
        const surface = match[0];
        const localStart = baseOffset + segment.start + match.index;
        const start = baseOffset + segment.start;
        const end = baseOffset + segment.end;
        const before = sentence.slice(0, match.index).match(/(?:\bno|\bnunca|\bjamás)\s*$/iu);
        const id = `observation:${input.documentId}:${localStart}:${signal.action}`;
        results.set(id, {
          id,
          projectId: input.projectId,
          documentId: input.documentId,
          revision: input.revision,
          kind: "action",
          action: signal.action,
          surface,
          ...(mentionedCharacters.length === 1
            ? { singleMentionedCharacterId: mentionedCharacters[0]!.id } : {}),
          mentionedCharacterIds: mentionedCharacters.map(entity => entity.id).sort(),
          mentionedEntityIds: mentionedOthers.map(entity => entity.id).sort(),
          polarity: before ? "negated" : "affirmed",
          confidence: "medium",
          reviewStatus: "candidate",
          evidence: {
            documentId: input.documentId,
            revision: input.revision,
            start,
            end,
            excerpt
          }
        });
      }
    }
  }

  return [...results.values()]
    .sort((a, b) => a.evidence.start - b.evidence.start ||
      a.action.localeCompare(b.action) || a.id.localeCompare(b.id))
    .slice(0, MAX_NARRATIVE_OBSERVATION_CANDIDATES);
}
