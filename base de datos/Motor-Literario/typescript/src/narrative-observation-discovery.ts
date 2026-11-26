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
  readonly grammaticalTense: "past-preterite" | "past-imperfect" | "present" | "future" | "infinitive" | "gerund" | "participle" | "unknown";
  /** Único personaje mencionado, si lo hay; nunca equivale a sujeto o agente confirmado. */
  readonly singleMentionedCharacterId?: string;
  /** Sujeto gramatical candidato solo ante un patrón local inequívoco; no implica agente semántico. */
  readonly grammaticalSubjectCandidate?: {
    readonly entityId: string;
    readonly voice: "active" | "passive";
    readonly evidence: TextEvidence;
  };
  /** Agente explícito de una pasiva con complemento «por + entidad»; candidato, no hecho confirmado. */
  readonly passiveAgentCandidate?: {
    readonly entityId: string;
    readonly marker: "por";
    readonly evidence: TextEvidence;
  };
  /** Complemento personal explícito «a + personaje» tras el verbo; candidato sintáctico, no relación semántica. */
  readonly personalObjectCandidate?: {
    readonly entityId: string;
    readonly marker: "a";
    readonly evidence: TextEvidence;
  };
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
  /** Primera mención literal de cada entidad de la frase; no asigna roles semánticos. */
  readonly entityMentionEvidence: readonly {
    readonly entityId: string;
    readonly entityKind: NarrativeEntity["kind"];
    readonly evidence: TextEvidence;
  }[];
  readonly polarity: "affirmed" | "negated";
  readonly confidence: "medium";
  readonly reviewStatus: "candidate";
  /** Evidencia exacta del verbo; evidence conserva el contexto completo de la oración. */
  readonly actionEvidence: TextEvidence;
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

const FUTURE_ENDINGS = "(?:é|ás|á|emos|éis|án)";
const IRREGULAR_FUTURE_STEMS: Readonly<Record<string, string>> = {
  decir: "dir",
  salir: "saldr"
};

function futureActionExpression(action: string): RegExp {
  const stem = IRREGULAR_FUTURE_STEMS[action] ?? action;
  return new RegExp(
    "(?<![\\p{L}\\p{M}\\p{N}_])" + stem + FUTURE_ENDINGS +
    "(?![\\p{L}\\p{M}\\p{N}_])",
    "giu"
  );
}

const ACTION_SIGNALS: readonly ActionSignal[] = [
  { action: "cruzar", expression: /(?<![\p{L}\p{M}\p{N}_])(?:cruzar|cruz(?:ó|aba|aban|ábamos|abas|aron|a|an|amos|ar|ad[oa]s?|ando|aré|arás|ará|aremos|arán))(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "entrar", expression: /(?<![\p{L}\p{M}\p{N}_])entr(?:ó|aba|aron|a|an|ar|ado|ando|aré|arás|ará|aremos|arán)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "salir", expression: /(?<![\p{L}\p{M}\p{N}_])sal(?:ió|ía|ieron|e|en|ir|ido|iendo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "llegar", expression: /(?<![\p{L}\p{M}\p{N}_])lleg(?:ó|aba|aron|a|an|ar|ado|ando|aré|arás|ará|aremos|arán)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "huir", expression: /(?<![\p{L}\p{M}\p{N}_])hu(?:yó|ía|yeron|ye|yen|ir|ido|endo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "correr", expression: /(?<![\p{L}\p{M}\p{N}_])corr(?:ió|ía|ieron|e|en|er|ido|iendo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "caminar", expression: /(?<![\p{L}\p{M}\p{N}_])camin(?:ó|aba|aron|a|an|ar|ado|ando|aré|arás|ará|aremos|arán)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "mirar", expression: /(?<![\p{L}\p{M}\p{N}_])mir(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "decir", expression: /(?<![\p{L}\p{M}\p{N}_])(?:dijo|decía|dijeron|dice|dicen|decir|dicho)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "responder", expression: /(?<![\p{L}\p{M}\p{N}_])respond(?:ió|ía|ieron|e|en|er|ido|iendo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "preguntar", expression: /(?<![\p{L}\p{M}\p{N}_])pregunt(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "gritar", expression: /(?<![\p{L}\p{M}\p{N}_])grit(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "tomar", expression: /(?<![\p{L}\p{M}\p{N}_])tom(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "abrir", expression: /(?<![\p{L}\p{M}\p{N}_])(?:abri(?:ó|ía|aban|ábamos|abas|eron|r|endo)|abiert[oa]s?)(?![\p{L}\p{M}\p{N}_])/giu },
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
  if (/(?:aré|arás|ará|aremos|aréis|arán|eré|erás|erá|eremos|eréis|erán|iré|irás|irá|iremos|iréis|irán|diré|dirás|dirá|diremos|diréis|dirán|saldré|saldrás|saldrá|saldremos|saldréis|saldrán)$/u.test(form)) return "future";
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

function findNameMatch(sentence: string, name: string): { start: number; end: number; excerpt: string } | undefined {
  const escaped = name.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
  const expression = new RegExp(
    "(?<![\\p{L}\\p{M}\\p{N}_])" + escaped +
    "(?![\\p{L}\\p{M}\\p{N}_])",
    "iu"
  );
  const match = expression.exec(sentence);
  if (!match) return undefined;
  return { start: match.index, end: match.index + match[0].length, excerpt: match[0] };
}

function includesName(sentence: string, name: string): boolean {
  return findNameMatch(sentence, name) !== undefined;
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
    const entityMentionEvidence = input.entities.flatMap(entity => {
      const matches = [entity.canonicalName, ...entity.aliases]
        .map(name => findNameMatch(sentence, name))
        .filter((match): match is NonNullable<typeof match> => match !== undefined)
        .sort((a, b) => a.start - b.start || b.end - a.end);
      const match = matches[0];
      if (!match) return [];
      return [{
        entityId: entity.id,
        entityKind: entity.kind,
        evidence: {
          documentId: input.documentId,
          revision: input.revision,
          start: baseOffset + segment.start + match.start,
          end: baseOffset + segment.start + match.end,
          excerpt: match.excerpt
        }
      }];
    }).sort((a, b) => a.evidence.start - b.evidence.start || a.evidence.end - b.evidence.end);
    const lineStart = input.text.lastIndexOf("\n", segment.start - 1) + 1;
    const lineBreak = input.text.indexOf("\n", segment.end);
    const lineEnd = lineBreak < 0 ? input.text.length : lineBreak;
    const excerpt = input.text.slice(lineStart, lineEnd);

    for (const signal of ACTION_SIGNALS) {
      const expressions = [signal.expression, futureActionExpression(signal.action)];
      for (const expression of expressions) {
      expression.lastIndex = 0;
      for (const match of sentence.matchAll(expression)) {
        const surface = match[0];
        const localStart = baseOffset + segment.start + match.index;
        const start = baseOffset + segment.start;
        const end = baseOffset + segment.end;
        const subjectCandidates = characters.filter(entity =>
          [entity.canonicalName, ...entity.aliases].some(name =>
            sentence.toLocaleLowerCase("es").startsWith(name.toLocaleLowerCase("es")) &&
            (sentence.length === name.length || !/[\\p{L}\\p{M}\\p{N}_]/u.test(sentence[name.length]!))
          )
        );
        const subjectCandidate = subjectCandidates.length === 1
          ? (() => {
              const entity = subjectCandidates[0]!;
              const names = [entity.canonicalName, ...entity.aliases]
                .filter(name => name.trim().length > 0)
                .sort((a, b) => b.length - a.length);
              for (const name of names) {
                if (!sentence.toLocaleLowerCase("es").startsWith(name.toLocaleLowerCase("es"))) continue;
                const afterName = sentence.slice(name.length, match.index);
                const activePattern = /^\s*(?:(?:no|nunca|jamás)\s+)?$/iu;
                const passivePattern = /^\s+(?:(?:no|nunca|jamás)\s+)?(?:fue|fueron|era|eran|es|son|será|serán|ha sido|han sido|había sido|habían sido)\s+$/iu;
                const voice = activePattern.test(afterName) ? "active" as const
                  : passivePattern.test(afterName) && classifyGrammaticalTense(surface) === "participle"
                    ? "passive" as const : undefined;
                if (!voice) continue;
                return {
                  entityId: entity.id,
                  voice,
                  evidence: {
                    documentId: input.documentId,
                    revision: input.revision,
                    start: baseOffset + segment.start,
                    end: baseOffset + segment.start + name.length,
                    excerpt: sentence.slice(0, name.length)
                  }
                };
              }
              return undefined;
            })()
          : undefined;
        const passiveAgentCandidate = subjectCandidate?.voice === "passive"
          ? (() => {
              const afterVerb = sentence.slice(match.index + surface.length);
              const agentMatch = /\bpor\s+([\p{Lu}ÁÉÍÓÚÜÑ][\p{L}\p{M}]+(?:[ \u00a0]+(?:de[ \u00a0]+(?:la|las|los)|de|del|la|las|los|el|y|san|santa)?[ \u00a0]*[\p{Lu}ÁÉÍÓÚÜÑ][\p{L}\p{M}]+){0,3})/u.exec(afterVerb);
              if (!agentMatch) return undefined;
              const matchedName = agentMatch[1]!;
              const candidates = characters.filter(entity =>
                [entity.canonicalName, ...entity.aliases].some(name =>
                  name.toLocaleLowerCase("es") === matchedName.toLocaleLowerCase("es")
                )
              );
              if (candidates.length !== 1) return undefined;
              const nameStart = match.index + surface.length + agentMatch.index + agentMatch[0].lastIndexOf(matchedName);
              return {
                entityId: candidates[0]!.id,
                marker: "por" as const,
                evidence: {
                  documentId: input.documentId,
                  revision: input.revision,
                  start: baseOffset + segment.start + nameStart,
                  end: baseOffset + segment.start + nameStart + matchedName.length,
                  excerpt: matchedName
                }
              };
            })()
          : undefined;
        const personalObjectCandidate = (() => {
          const afterVerb = sentence.slice(match.index + surface.length);
          const objectMarker = /^\\s+a\\s+([\\p{Lu}ÁÉÍÓÚÜÑ][\\p{L}\\p{M}]+(?:[ \\u00a0]+(?:de[ \\u00a0]+(?:la|las|los)|de|del|la|las|los|el|y|san|santa)?[ \\u00a0]*[\\p{Lu}ÁÉÍÓÚÜÑ][\\p{L}\\p{M}]+){0,3})/u.exec(afterVerb);
          if (!objectMarker) return undefined;
          const matchedName = objectMarker[1]!;
          const candidates = characters.filter(entity =>
            [entity.canonicalName, ...entity.aliases].some(name =>
              name.toLocaleLowerCase("es") === matchedName.toLocaleLowerCase("es")
            )
          );
          if (candidates.length !== 1) return undefined;
          const nameStart = match.index + surface.length + objectMarker.index + objectMarker[0].lastIndexOf(matchedName);
          return {
            entityId: candidates[0]!.id,
            marker: "a" as const,
            evidence: {
              documentId: input.documentId,
              revision: input.revision,
              start: baseOffset + segment.start + nameStart,
              end: baseOffset + segment.start + nameStart + matchedName.length,
              excerpt: matchedName
            }
          };
        })();
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
          ...(subjectCandidate ? { grammaticalSubjectCandidate: subjectCandidate } : {}),
          ...(passiveAgentCandidate ? { passiveAgentCandidate } : {}),
          ...(personalObjectCandidate ? { personalObjectCandidate } : {}),
          ...(mentionedCharacters.length === 1
            ? { singleMentionedCharacterId: mentionedCharacters[0]!.id } : {}),
          mentionedCharacterIds: mentionedCharacters.map(entity => entity.id).sort(),
          ...(unresolvedReferences.length > 0 ? { unresolvedReferences } : {}),
          mentionedEntityIds: mentionedOthers.map(entity => entity.id).sort(),
          entityMentionEvidence,
          polarity: before ? "negated" : "affirmed",
          confidence: "medium",
          reviewStatus: "candidate",
          actionEvidence: {
            documentId: input.documentId,
            revision: input.revision,
            start: localStart,
            end: localStart + surface.length,
            excerpt: surface
          },
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
  }

  return [...results.values()]
    .sort((a, b) => a.actionEvidence.start - b.actionEvidence.start ||
      a.actionEvidence.end - b.actionEvidence.end)
    .slice(0, MAX_NARRATIVE_OBSERVATION_CANDIDATES);
}
