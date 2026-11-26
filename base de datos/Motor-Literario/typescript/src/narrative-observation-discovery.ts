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
export const MAX_NARRATIVE_OBSERVATION_ENTITIES = 10_000;
export const MAX_NARRATIVE_OBSERVATION_ALIASES_PER_ENTITY = 100;
export const MAX_NARRATIVE_OBSERVATION_NAME_LENGTH = 256;
export const MAX_NARRATIVE_OBSERVATION_SEGMENTS = 20_000;
export const MAX_NARRATIVE_ENTITY_MENTION_OCCURRENCES = 20_000;

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
  /** Objeto directo textual tras el verbo; solo entidades kind=object con mención explícita, sin inferir posesión ni cambio de estado. */
  readonly grammaticalObjectCandidate?: {
    readonly entityId: string;
    readonly evidence: TextEvidence;
  };
  /** Complemento personal explícito «a + personaje» tras el verbo; candidato sintáctico, no relación semántica. */
  readonly personalObjectCandidate?: {
    readonly entityId: string;
    readonly marker: "a";
    readonly evidence: TextEvidence;
  };
  /** Relación de transferencia explícita candidata; solo se emite con sujeto activo, objeto y destinatario inequívocos. */
  readonly directedRelationCandidate?: {
    readonly relation: "transfers-to";
    readonly fromEntityId: string;
    readonly toEntityId: string;
    readonly objectEntityId: string;
    readonly subjectEvidence: TextEvidence;
    readonly objectEvidence: TextEvidence;
    readonly recipientEvidence: TextEvidence;
    readonly actionEvidence: TextEvidence;
  };
  /** Interacción dirigida candidata: los roles se limitan a patrones verbales explícitos y siguen sin confirmar. */
  readonly directedInteractionCandidate?: {
    readonly relation: "attacks" | "helps" | "protects" | "saves";
    readonly fromEntityId: string;
    readonly toEntityId: string;
    readonly targetRole: "target" | "beneficiary" | "protected";
    readonly subjectEvidence: TextEvidence;
    readonly targetEvidence: TextEvidence;
    readonly actionEvidence: TextEvidence;
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
  /** Primera mención literal de cada entidad; se conserva por compatibilidad. */
  readonly entityMentionEvidence: readonly {
    readonly entityId: string;
    readonly entityKind: NarrativeEntity["kind"];
    readonly evidence: TextEvidence;
  }[];
  /** Todas las menciones literales no solapadas por entidad dentro de la frase; las colisiones entre entidades se conservan como ambigüedad. */
  readonly entityMentionOccurrences: readonly {
    readonly entityId: string;
    readonly entityKind: NarrativeEntity["kind"];
    readonly evidence: TextEvidence;
  }[];
  /** Marco epistémico textual más próximo; no convierte el contenido en hecho objetivo. */
  readonly epistemicFrame: "narrator-asserted" | "character-belief" | "character-memory" | "character-desire" | "reported-speech" | "hypothetical";
  /** Evidencia literal del disparador del marco, cuando existe. */
  readonly epistemicFrameEvidence?: TextEvidence;
  /** Emisor candidato de discurso referido, solo si una entidad aparece inequívocamente antes del disparador. */
  readonly epistemicSourceCandidate?: { readonly entityId: string; readonly evidence: TextEvidence };
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
  { action: "atravesar", expression: /(?<![\p{L}\p{M}\p{N}_])atraves(?:ó|aba|aban|amos|aron|a|an|ar|ado|ando|aré|arás|ará|aremos|arán)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "pasar", expression: /(?<![\p{L}\p{M}\p{N}_])pas(?:ó|aba|aban|amos|aron|a|an|ar|ado|ando|aré|arás|ará|aremos|arán)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "recorrer", expression: /(?<![\p{L}\p{M}\p{N}_])recorr(?:ió|ía|ían|imos|ieron|e|en|er|ido|iendo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "entrar", expression: /(?<![\p{L}\p{M}\p{N}_])entr(?:ó|aba|aron|a|an|ar|ado|ando|aré|arás|ará|aremos|arán)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "salir", expression: /(?<![\p{L}\p{M}\p{N}_])sal(?:ió|ía|ieron|e|en|ir|ido|iendo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "llegar", expression: /(?<![\p{L}\p{M}\p{N}_])lleg(?:ó|aba|aron|a|an|ar|ado|ando|aré|arás|ará|aremos|arán)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "huir", expression: /(?<![\p{L}\p{M}\p{N}_])hu(?:yó|ía|yeron|ye|yen|ir|ido|endo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "correr", expression: /(?<![\p{L}\p{M}\p{N}_])corr(?:ió|ía|ieron|e|en|er|ido|iendo|iera|ieras|iéramos|ieran|iese|ieses|iésemos|iesen)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "caminar", expression: /(?<![\p{L}\p{M}\p{N}_])camin(?:ó|aba|aron|a|an|ar|ado|ando|aré|arás|ará|aremos|arán)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "mirar", expression: /(?<![\p{L}\p{M}\p{N}_])mir(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "decir", expression: /(?<![\p{L}\p{M}\p{N}_])(?:dijo|decía|dijeron|dice|dicen|decir|dicho)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "responder", expression: /(?<![\p{L}\p{M}\p{N}_])respond(?:ió|ía|ieron|e|en|er|ido|iendo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "preguntar", expression: /(?<![\p{L}\p{M}\p{N}_])pregunt(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "gritar", expression: /(?<![\p{L}\p{M}\p{N}_])grit(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "tomar", expression: /(?<![\p{L}\p{M}\p{N}_])tom(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "abrir", expression: /(?<![\p{L}\p{M}\p{N}_])(?:abri(?:ó|ía|aban|ábamos|abas|eron|r|endo)|abiert[oa]s?)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "cerrar", expression: /(?<![\p{L}\p{M}\p{N}_])cerr(?:ó|aba|aron|ó|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "romper", expression: /(?<![\p{L}\p{M}\p{N}_])(?:romp(?:ió|ía|ieron|e|en|er|iendo)|rot[oa]s?)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "reparar", expression: /(?<![\p{L}\p{M}\p{N}_])repar(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "destruir", expression: /(?<![\p{L}\p{M}\p{N}_])(?:destruy(?:ó|eron|e|en|endo)|destru(?:ía|ir|ido))(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "activar", expression: /(?<![\p{L}\p{M}\p{N}_])activ(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "desactivar", expression: /(?<![\p{L}\p{M}\p{N}_])desactiv(?:ó|aba|aron|a|an|ar|ado|ando)(?![\p{L}\p{M}\p{N}_])/giu },
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
  { action: "creer", expression: /(?<![\p{L}\p{M}\p{N}_])cre(?:yó|ía|yeron|e|en|er|ído|yendo)(?![\p{L}\p{M}\p{N}_])/giu },
  // Formas irregulares de verbos de acontecimiento/percepción. Se excluyen
  // auxiliares y modales frecuentes (ser, estar, haber, poder, querer) para
  // no convertir perífrasis o estados en acciones independientes.
  { action: "hacer", expression: /(?<![\p{L}\p{M}\p{N}_])(?:hizo|hicieron|hice|hiciste|hicimos|hacía|hacían|hace|hacen|hacer|hecho|haciendo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "venir", expression: /(?<![\p{L}\p{M}\p{N}_])(?:vino|vinieron|vine|viniste|vinimos|venía|venían|viene|vienen|venir|venido|viniendo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "ver", expression: /(?<![\p{L}\p{M}\p{N}_])(?:vio|vieron|vi|viste|vimos|veía|veían|ve|ven|ver|visto|viendo)(?![\p{L}\p{M}\p{N}_])/giu },
  { action: "poner", expression: /(?<![\p{L}\p{M}\p{N}_])(?:puso|pusieron|puse|pusiste|pusimos|ponía|ponían|pone|ponen|poner|puesto|poniendo)(?![\p{L}\p{M}\p{N}_])/giu }
];

const EPISTEMIC_FRAME_SIGNALS: readonly {
  readonly frame: Exclude<NarrativeObservationCandidate["epistemicFrame"], "narrator-asserted">;
  readonly expression: RegExp;
}[] = [
  { frame: "character-belief", expression: /\\b(?:creyó|creía|creyeron|pensó|pensaba|imag[iní]ó|imaginaba|supuso|suponía)\\s+que\\s+/giu },
  { frame: "character-memory", expression: /\\b(?:recordó|recordaba|rememoró|rememoraba|olvidó|olvidaba)\\s+que\\s+/giu },
  { frame: "character-desire", expression: /\\b(?:deseó|deseaba|quería|quiso|esperaba|esperó|anhelaba|anheló)\\s+que\\s+/giu },
  { frame: "reported-speech", expression: /\\b(?:dijo|decía|afirmó|afirmaba|aseguró|aseguraba|contó|relató|advirtió|anunció)\\s+que\\s+/giu },
  { frame: "hypothetical", expression: /\\b(?:si|quizá|quizás|tal vez|acaso|como si)\\s+/giu }
];

function classifyEpistemicFrame(
  sentence: string,
  actionStart: number,
  characters: readonly NarrativeEntity[]
): {
  frame: NarrativeObservationCandidate["epistemicFrame"];
  cue?: { start: number; end: number; excerpt: string };
  source?: { entityId: string; start: number; end: number; excerpt: string };
} {
  let selected: { frame: NarrativeObservationCandidate["epistemicFrame"]; start: number; end: number; excerpt: string } | undefined;
  for (const signal of EPISTEMIC_FRAME_SIGNALS) {
    signal.expression.lastIndex = 0;
    for (const match of sentence.matchAll(signal.expression)) {
      if (match.index! >= actionStart) break;
      const candidate = { frame: signal.frame, start: match.index!, end: match.index! + match[0].length, excerpt: match[0] };
      if (!selected || candidate.start > selected.start) selected = candidate;
    }
  }
  if (!selected) return { frame: "narrator-asserted" };
  if (selected.frame !== "reported-speech") return { frame: selected.frame, cue: selected };

  const possibleSources = characters.flatMap(entity =>
    [entity.canonicalName, ...entity.aliases].flatMap(name => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  sentence: string,
  actionStart: number
): { frame: NarrativeObservationCandidate["epistemicFrame"]; cue?: { start: number; end: number; excerpt: string } } {
  let selected: { frame: NarrativeObservationCandidate["epistemicFrame"]; start: number; end: number; excerpt: string } | undefined;
  for (const signal of EPISTEMIC_FRAME_SIGNALS) {
    signal.expression.lastIndex = 0;
    for (const match of sentence.matchAll(signal.expression)) {
      if (match.index! >= actionStart) break;
      const candidate = { frame: signal.frame, start: match.index!, end: match.index! + match[0].length, excerpt: match[0] };
      if (!selected || candidate.start > selected.start) selected = candidate;
    }
  }
  return selected ? { frame: selected.frame, cue: selected } : { frame: "narrator-asserted" };
}");
      const expression = new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])" + escaped +
        "(?![\\p{L}\\p{M}\\p{N}_])", "giu");
      return [...sentence.slice(0, selected!.start).matchAll(expression)].map(match => ({
        entityId: entity.id, start: match.index!, end: match.index! + match[0].length,
        excerpt: match[0]
      }));
    })
  ).sort((a, b) => b.end - a.end || b.start - a.start);
  const nearest = possibleSources[0];
  const equallyNear = nearest ? possibleSources.filter(item => item.end === nearest.end) : [];
  return {
    frame: selected.frame,
    cue: selected,
    ...(nearest && equallyNear.every(item => item.entityId === nearest.entityId)
      ? { source: nearest } : {})
  };
}

function classifyGrammaticalTense(surface: string): NarrativeObservationCandidate["grammaticalTense"] {
  const form = surface.toLocaleLowerCase("es");
  if (/(?:ando|iendo|yendo)$/u.test(form)) return "gerund";
  if (/(?:ar|er|ir)$/u.test(form)) return "infinitive";
  if (/(?:aba|abas|ábamos|aban|ía|ías|íamos|ían)$/u.test(form)) return "past-imperfect";
  if (/(?:aré|arás|ará|aremos|aréis|arán|eré|erás|erá|eremos|eréis|erán|iré|irás|irá|iremos|iréis|irán|diré|dirás|dirá|diremos|diréis|dirán|saldré|saldrás|saldrá|saldremos|saldréis|saldrán)$/u.test(form)) return "future";
  if (/(?:ó|ió|aron|ieron|yó|yeron|dijo|dijeron|hizo|hicieron|hice|hiciste|hicimos|vino|vinieron|vine|viniste|vinimos|vio|vieron|vi|viste|vimos|puso|pusieron|puse|pusiste|pusimos)$/u.test(form)) return "past-preterite";
  if (/(?:ad[oa]s?|id[oa]s?|to|cho|so|abiert[oa]s?|muert[oa]s?|vist[oa]s?|puest[oa]s?|hech[oa]s?|escrit[oa]s?)$/u.test(form)) return "participle";
  if (/(?:a|an|e|en|o|es)$/u.test(form)) return "present";
  return "unknown";
}

const NEGATED_AUXILIARY_PREFIX = /(?:^|[^\p{L}\p{M}\p{N}_])(?:no|nunca|jamás)\s+(?:(?:ha|han|había|habían|habrá|habrán|habría|habrían|está|están|estaba|estaban|estuvo|estuvieron|fue|fueron|era|eran|es|son|será|serán|puede|pueden|podía|podían|pudo|pudieron|quiere|quieren|quería|querían)\s+){1,3}$/iu;

function hasNegationBeforeAction(sentence: string, actionStart: number): boolean {
  const prefix = sentence.slice(0, actionStart);
  return /(?:^|[^\p{L}\p{M}\p{N}_])(?:no|nunca|jamás)\s*$/iu.test(prefix) ||
    NEGATED_AUXILIARY_PREFIX.test(prefix);
}

function validateInput(input: NarrativeObservationDiscoveryInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" ||
      input.text.length > MAX_NARRATIVE_OBSERVATION_TEXT_UNITS ||
      !Array.isArray(input.entities) || input.entities.length > MAX_NARRATIVE_OBSERVATION_ENTITIES ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para descubrir observaciones narrativas.");
  }
  const ids = new Set<string>();
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() || ids.has(entity.id) ||
        typeof entity.kind !== "string" || !entity.kind.trim() ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        entity.canonicalName.length > MAX_NARRATIVE_OBSERVATION_NAME_LENGTH ||
        !Array.isArray(entity.aliases) ||
        entity.aliases.length > MAX_NARRATIVE_OBSERVATION_ALIASES_PER_ENTITY ||
        entity.aliases.some((alias: unknown) => typeof alias !== "string" || !alias.trim() ||
          alias.length > MAX_NARRATIVE_OBSERVATION_NAME_LENGTH)) {
      throw new Error("La lista de entidades debe contener registros únicos, válidos y del mismo proyecto.");
    }
    ids.add(entity.id);
  }
}

function splitSentences(text: string): readonly { start: number; end: number }[] {
  const result: { start: number; end: number }[] = [];
  const expression = /[^\n]+/gu;
  for (const line of text.matchAll(expression)) {
    if (result.length >= MAX_NARRATIVE_OBSERVATION_SEGMENTS) break;
    const sentenceExpression = /[^.!?]+(?:[.!?]+|$)/gu;
    for (const sentence of line[0].matchAll(sentenceExpression)) {
      if (result.length >= MAX_NARRATIVE_OBSERVATION_SEGMENTS) break;
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

function findAllNameMatches(sentence: string, name: string): { start: number; end: number; excerpt: string }[] {
  const escaped = name.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
  const expression = new RegExp(
    "(?<![\\p{L}\\p{M}\\p{N}_])" + escaped +
    "(?![\\p{L}\\p{M}\\p{N}_])",
    "giu"
  );
  return [...sentence.matchAll(expression)].map(match => ({
    start: match.index!,
    end: match.index! + match[0].length,
    excerpt: match[0]
  }));
}

function includesName(sentence: string, name: string): boolean {");
  const expression = new RegExp(
    "(?<![\\p{L}\\p{M}\\p{N}_])" + escaped +
    "(?![\\p{L}\\p{M}\\p{N}_])",
    "giu"
  );
  return [...sentence.matchAll(expression)].map(match => ({
    start: match.index!,
    end: match.index! + match[0].length,
    excerpt: match[0]
  }));
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
    let mentionOccurrenceCount = 0;
    const entityMentionOccurrences = input.entities.flatMap(entity => {
      const bySpan = new Map<string, { start: number; end: number; excerpt: string }>();
      for (const name of [entity.canonicalName, ...entity.aliases]) {
        for (const match of findAllNameMatches(sentence, name)) {
          const key = match.start + ":" + match.end;
          const previous = bySpan.get(key);
          if (!previous || match.excerpt.length > previous.excerpt.length) bySpan.set(key, match);
        }
      }
      const entityMatches = [...bySpan.values()];
      mentionOccurrenceCount += entityMatches.length;
      if (mentionOccurrenceCount > MAX_NARRATIVE_ENTITY_MENTION_OCCURRENCES) {
        throw new Error("La frase supera el límite de menciones de entidades; procesa el texto en fragmentos menores.");
      }
      return entityMatches.map(match => ({
        entityId: entity.id,
        entityKind: entity.kind,
        evidence: {
          documentId: input.documentId,
          revision: input.revision,
          start: baseOffset + segment.start + match.start,
          end: baseOffset + segment.start + match.end,
          excerpt: match.excerpt
        }
      }));
    }).sort((a, b) =>
      a.evidence.start - b.evidence.start ||
      a.evidence.end - b.evidence.end ||
      a.entityId.localeCompare(b.entityId)
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
            (sentence.length === name.length || !/[\p{L}\p{M}\p{N}_]/u.test(sentence[name.length]!))
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
                const activePattern = /^\s*(?:(?:no|nunca|jamás)\s+)?(?:(?:ha|han|había|habían|habrá|habrán|habría|habrían|está|están|estaba|estaban|estuvo|estuvieron|puede|pueden|podía|podían|pudo|pudieron|quiere|quieren|quería|querían)\s+){0,3}$/iu;
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
          const matches = characters.flatMap(entity => {
            const names = [entity.canonicalName, ...entity.aliases];
            return names.flatMap(name => {
              const mention = findNameMatch(afterVerb, name);
              if (!mention) return [];
              const beforeMention = afterVerb.slice(0, mention.start);
              const directPersonalObject = /^\s+a\s+$/u.test(beforeMention);
              const followsExplicitObject = otherEntities
                .filter(candidate => candidate.kind === "object")
                .some(object => [object.canonicalName, ...object.aliases].some(objectName => {
                  const objectMention = findNameMatch(afterVerb, objectName);
                  if (!objectMention || objectMention.end > mention.start) return false;
                  const beforeObject = afterVerb.slice(0, objectMention.start);
                  const betweenObjectAndPerson = afterVerb.slice(objectMention.end, mention.start);
                  return /^\s+(?:(?:el|la|los|las|un|una|unos|unas)\s+)?$/iu.test(beforeObject) &&
                    /^\s+a\s+$/iu.test(betweenObjectAndPerson);
                }));
              if (!directPersonalObject && !followsExplicitObject) return [];
              return [{ entity, mention }];
            });
          });
          const distinct = new Map(matches.map(item => [item.entity.id, item]));
          if (distinct.size !== 1) return undefined;
          const selected = [...distinct.values()][0]!;
          const nameStart = match.index + surface.length + selected.mention.start;
          return {
            entityId: selected.entity.id,
            marker: "a" as const,
            evidence: {
              documentId: input.documentId,
              revision: input.revision,
              start: baseOffset + segment.start + nameStart,
              end: baseOffset + segment.start + nameStart + selected.mention.excerpt.length,
              excerpt: selected.mention.excerpt
            }
          };
        })();
        const grammaticalObjectCandidate = (() => {
          const afterVerb = sentence.slice(match.index + surface.length);
          const matches = otherEntities.filter(entity => entity.kind === "object").flatMap(entity => {
            const names = [entity.canonicalName, ...entity.aliases];
            return names.flatMap(name => {
              const mention = findNameMatch(afterVerb, name);
              if (!mention || !/^\s+(?:(?:el|la|los|las|un|una|unos|unas)\s+)?$/iu.test(afterVerb.slice(0, mention.start))) return [];
              return [{ entity, mention }];
            });
          });
          const distinct = new Map(matches.map(item => [item.entity.id, item]));
          if (distinct.size !== 1) return undefined;
          const selected = [...distinct.values()][0]!;
          const nameStart = match.index + surface.length + selected.mention.start;
          return {
            entityId: selected.entity.id,
            evidence: {
              documentId: input.documentId,
              revision: input.revision,
              start: baseOffset + segment.start + nameStart,
              end: baseOffset + segment.start + nameStart + selected.mention.excerpt.length,
              excerpt: selected.mention.excerpt
            }
          };
        })();
        const epistemic = classifyEpistemicFrame(sentence, match.index, characters);
        const epistemicFrameEvidence = epistemic.cue ? {
          documentId: input.documentId,
          revision: input.revision,
          start: baseOffset + segment.start + epistemic.cue.start,
          end: baseOffset + segment.start + epistemic.cue.end,
          excerpt: epistemic.cue.excerpt
        } : undefined;
        const epistemicSourceCandidate = epistemic.source ? {
          entityId: epistemic.source.entityId,
          evidence: {
            documentId: input.documentId,
            revision: input.revision,
            start: baseOffset + segment.start + epistemic.source.start,
            end: baseOffset + segment.start + epistemic.source.end,
            excerpt: epistemic.source.excerpt
          }
        } : undefined;
        const isNegated = hasNegationBeforeAction(sentence, match.index);
        const directedRelationCandidate = signal.action === "entregar" &&
          !isNegated &&
          subjectCandidate?.voice === "active" &&
          grammaticalObjectCandidate && personalObjectCandidate &&
          subjectCandidate.entityId !== personalObjectCandidate.entityId
          ? {
              relation: "transfers-to" as const,
              fromEntityId: subjectCandidate.entityId,
              toEntityId: personalObjectCandidate.entityId,
              objectEntityId: grammaticalObjectCandidate.entityId,
              subjectEvidence: subjectCandidate.evidence,
              objectEvidence: grammaticalObjectCandidate.evidence,
              recipientEvidence: personalObjectCandidate.evidence,
              actionEvidence: {
                documentId: input.documentId,
                revision: input.revision,
                start: localStart,
                end: localStart + surface.length,
                excerpt: surface
              }
            }
          : undefined;
        const interactionRoles = {
          atacar: { relation: "attacks", targetRole: "target" },
          ayudar: { relation: "helps", targetRole: "beneficiary" },
          proteger: { relation: "protects", targetRole: "protected" },
          salvar: { relation: "saves", targetRole: "beneficiary" }
        } as const;
        const interactionRole = interactionRoles[signal.action as keyof typeof interactionRoles];
        const directedInteractionCandidate = interactionRole &&
          !isNegated &&
          subjectCandidate?.voice === "active" &&
          personalObjectCandidate &&
          subjectCandidate.entityId !== personalObjectCandidate.entityId
          ? {
              relation: interactionRole.relation,
              fromEntityId: subjectCandidate.entityId,
              toEntityId: personalObjectCandidate.entityId,
              targetRole: interactionRole.targetRole,
              subjectEvidence: subjectCandidate.evidence,
              targetEvidence: personalObjectCandidate.evidence,
              actionEvidence: {
                documentId: input.documentId,
                revision: input.revision,
                start: localStart,
                end: localStart + surface.length,
                excerpt: surface
              }
            }
          : undefined;
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
          ...(grammaticalObjectCandidate ? { grammaticalObjectCandidate } : {}),
          ...(directedRelationCandidate ? { directedRelationCandidate } : {}),
          ...(directedInteractionCandidate ? { directedInteractionCandidate } : {}),
          ...(mentionedCharacters.length === 1
            ? { singleMentionedCharacterId: mentionedCharacters[0]!.id } : {}),
          mentionedCharacterIds: mentionedCharacters.map(entity => entity.id).sort(),
          ...(unresolvedReferences.length > 0 ? { unresolvedReferences } : {}),
          mentionedEntityIds: mentionedOthers.map(entity => entity.id).sort(),
          entityMentionEvidence,
          entityMentionOccurrences,
          epistemicFrame: epistemic.frame,
          ...(epistemicFrameEvidence ? { epistemicFrameEvidence } : {}),
          ...(epistemicSourceCandidate ? { epistemicSourceCandidate } : {}),
          polarity: isNegated ? "negated" : "affirmed",
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
            start: baseOffset + lineStart,
            end: baseOffset + lineEnd,
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
