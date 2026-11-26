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
  /** Forma verbal morfológica; no equivale a una fecha ni fija cronología global. */
  readonly grammaticalTense: "past-preterite" | "past-imperfect" | "present" | "infinitive" | "gerund" | "participle" | "unknown";
  /** Único personaje mencionado, si lo hay; nunca equivale a sujeto o agente confirmado. */
  readonly singleMentionedCharacterId?: string;
  /** Referencia pronominal pendiente: nunca fusiona automáticamente el pronombre con una identidad. */
  readonly unresolvedReferences?: readonly {
    readonly pronoun: string;
    readonly candidateEntityIds: readonly string[];
    readonly evidence: TextEvidence;
    readonly antecedentEvidence?: TextEvidence;
  }[];
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
  { action: "cruzar", expression: /(?<![\p{L}\p{M}\p{N}_])cruz(?:ó|aba|aron|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "entrar", expression: /(?<![\p{L}\p{M}\p{N}_])entr(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "salir", expression: /(?<![\p{L}\p{M}\p{N}_])sal(?:ió|ía|ieron|e|en|ir|ido|iendo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "llegar", expression: /(?<![\p{L}\p{M}\p{N}_])lleg(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "huir", expression: /(?<![\p{L}\p{M}\p{N}_])hu(?:yó|ía|yeron|ye|yen|ir|ido|endo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "correr", expression: /(?<![\p{L}\p{M}\p{N}_])corr(?:ió|ía|ieron|e|en|er|ido|iendo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "caminar", expression: /(?<![\p{L}\p{M}\p{N}_])camin(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "mirar", expression: /(?<![\p{L}\p{M}\p{N}_])mir(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "decir", expression: /(?<![\p{L}\p{M}\p{N}_])(?:dijo|decía|dijeron|dice|dicen|decir|dicho)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "responder", expression: /(?<![\p{L}\p{M}\p{N}_])respond(?:ió|ía|ieron|e|en|er|ido|iendo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "preguntar", expression: /(?<![\p{L}\p{M}\p{N}_])pregunt(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "gritar", expression: /(?<![\p{L}\p{M}\p{N}_])grit(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "tomar", expression: /(?<![\p{L}\p{M}\p{N}_])tom(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "abrir", expression: /(?<![\p{L}\p{M}\p{N}_])abri(?:ó|ía|eron|r|erto|endo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "cerrar", expression: /(?<![\p{L}\p{M}\p{N}_])cerr(?:ó|aba|aron|ó|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "encontrar", expression: /(?<![\p{L}\p{M}\p{N}_])encontr(?:ó|aba|aron|ar|ad[oa]s?|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "perder", expression: /(?<![\p{L}\p{M}\p{N}_])perd(?:ió|ía|ieron|er|ido|iendo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "entregar", expression: /(?<![\p{L}\p{M}\p{N}_])entreg(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "recibir", expression: /(?<![\p{L}\p{M}\p{N}_])recibi(?:ó|ía|eron|r|do|endo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "atacar", expression: /(?<![\p{L}\p{M}\p{N}_])atac(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "ayudar", expression: /(?<![\p{L}\p{M}\p{N}_])ayud(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "salvar", expression: /(?<![\p{L}\p{M}\p{N}_])salv(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "proteger", expression: /(?<![\p{L}\p{M}\p{N}_])proteg(?:ió|ía|ieron|e|en|er|ido|iendo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "traicionar", expression: /(?<![\p{L}\p{M}\p{N}_])traicion(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "buscar", expression: /(?<![\p{L}\p{M}\p{N}_])busc(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "descubrir", expression: /(?<![\p{L}\p{M}\p{N}_])descubri(?:ó|ía|eron|r|erto|endo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "recordar", expression: /(?<![\p{L}\p{M}\p{N}_])record(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "olvidar", expression: /(?<![\p{L}\p{M}\p{N}_])olvid(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "decidir", expression: /(?<![\p{L}\p{M}\p{N}_])decidi(?:ó|ía|eron|r|do|endo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "intentar", expression: /(?<![\p{L}\p{M}\p{N}_])intent(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "regresar", expression: /(?<![\p{L}\p{M}\p{N}_])regres(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "volver", expression: /(?<![\p{L}\p{M}\p{N}_])volvi(?:ó|a|eron|ó|er|do|endo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "golpear", expression: /(?<![\p{L}\p{M}\p{N}_])golpe(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "abrazar", expression: /(?<![\p{L}\p{M}\p{N}_])abraz(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "matar", expression: /(?<![\p{L}\p{M}\p{N}_])mat(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "morir", expression: /(?<![\p{L}\p{M}\p{N}_])mur(?:ió|ió|ieron|iera|ieron|ir|iendo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "despertar", expression: /(?<![\p{L}\p{M}\p{N}_])despert(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "observar", expression: /(?<![\p{L}\p{M}\p{N}_])observ(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "escuchar", expression: /(?<![\p{L}\p{M}\p{N}_])escuch(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "sentir", expression: /(?<![\p{L}\p{M}\p{N}_])sinti(?:ó|ó|a|eron|r|ó|endo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "pensar", expression: /(?<![\p{L}\p{M}\p{N}_])pens(?:ó|aba|aron|ó|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "creer", expression: /(?<![\p{L}\p{M}\p{N}_])cre(?:yó|ía|yeron|e|en|er|ído|yendo)(?![\p{L}\p{M}\p{N}_])/giu }
];

function classifyGrammaticalTense(surface: string): NarrativeObservationCandidate["grammaticalTense"] {
  const form = surface.toLocaleLowerCase("es");
  if (/(?:ando|iendo|yendo)$/u.test(form)) return "gerund";
  if (/(?:ar|er|ir)$/u.test(form)) return "infinitive";
  if (/(?:aba|abas|ábamos|aban|ía|ías|íamos|ían)$/u.test(form)) return "past-imperfect";
  if (/(?:ó|ió|aron|ieron|yó|yeron|dijo|dijeron)$/u.test(form)) return "past-preterite";
  if (/(?:ad[oa]s?|id[oa]s?|to|cho|so|abiert[oa]s?|muert[oa]s?|vist[oa]s?|puest[oa]s?|hech[oa]s?|escrit[oa]s?)$/u.test(form)) return "participle";
  if (/(?:a|an|e|en|o|es)$/u.test(form)) return "present";
  return "unknown";
}

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

  const segments = splitSentences(input.text);
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex]!;
    const sentence = input.text.slice(segment.start, segment.end);
    const mentionedCharacters = characters.filter(entity =>
      [entity.canonicalName, ...entity.aliases].some(name => includesName(sentence, name))
    );
    const pronounMatch = sentence.match(/^\s*(él|ella|ellos|ellas)\b/iu);
    let unresolvedReferences: NonNullable<NarrativeObservationCandidate["unresolvedReferences"]> = [];
    if (mentionedCharacters.length === 0 && pronounMatch) {
      // Solo se inspecciona la frase inmediatamente anterior. Incluso con un único
      // candidato, el enlace queda pendiente: el género/número y la sintaxis pueden
      // no concordar o existir referentes fuera de esta ventana.
      const previous = segments[segmentIndex - 1];
      if (previous) {
        const previousText = input.text.slice(previous.start, previous.end);
        const possibleAntecedents = characters.filter(entity =>
          [entity.canonicalName, ...entity.aliases].some(name => includesName(previousText, name))
        );
        unresolvedReferences = [{
          pronoun: pronounMatch[1]!,
          candidateEntityIds: possibleAntecedents.map(entity => entity.id).sort(),
          evidence: {
            documentId: input.documentId,
            revision: input.revision,
            start: baseOffset + segment.start + sentence.indexOf(pronounMatch[1]!),
            end: baseOffset + segment.start + sentence.indexOf(pronounMatch[1]!) + pronounMatch[1]!.length,
            excerpt: pronounMatch[1]!
          },
          ...(possibleAntecedents.length > 0 ? {
            antecedentEvidence: {
              documentId: input.documentId,
              revision: input.revision,
              start: baseOffset + previous.start,
              end: baseOffset + previous.end,
              excerpt: previousText
            }
          } : {})
        }];
      } else {
        unresolvedReferences = [{
          pronoun: pronounMatch[1]!,
          candidateEntityIds: [],
          evidence: {
            documentId: input.documentId,
            revision: input.revision,
            start: baseOffset + segment.start + sentence.indexOf(pronounMatch[1]!),
            end: baseOffset + segment.start + sentence.indexOf(pronounMatch[1]!) + pronounMatch[1]!.length,
            excerpt: pronounMatch[1]!
          }
        }];
      }
    }
    if (mentionedCharacters.length === 0 && unresolvedReferences.length === 0) continue;
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
          grammaticalTense: classifyGrammaticalTense(surface),
          ...(mentionedCharacters.length === 1
            ? { singleMentionedCharacterId: mentionedCharacters[0]!.id } : {}),
          mentionedCharacterIds: mentionedCharacters.map(entity => entity.id).sort(),
          ...(unresolvedReferences.length > 0 ? { unresolvedReferences } : {}),
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
