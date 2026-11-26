/**
 * Detecta cambios observables en la conducta de un personaje hacia el mismo
 * objetivo. El resultado describe secuencias documentadas, no rasgos de carácter
 * ni causas psicológicas.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";
import type { NarrativeActionCandidate } from "./narrative-action-extraction";
import type { NarrativeKnowledgeActionLink } from "./narrative-knowledge-action-links";
import type { NarrativeDecisionContextCandidate } from "./narrative-decision-context";
import type { NarrativeMemoryActionLink } from "./narrative-memory-action-links";
import type { NarrativeCharacterIntentEvolution } from "./narrative-character-intent-evolution";

export type NarrativeBehaviorValence = "supportive" | "hostile" | "neutral-or-unknown";
export type NarrativeBehaviorShiftKind =
  | "supportive-to-hostile"
  | "hostile-to-supportive"
  | "supportive-to-neutral"
  | "hostile-to-neutral"
  | "neutral-to-supportive"
  | "neutral-to-hostile"
  | "action-pattern-change";

export interface NarrativeBehaviorShiftCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly characterEntityId: string;
  readonly targetEntityId: string;
  readonly previousActionId: string;
  readonly currentActionId: string;
  readonly previousAction: string;
  readonly currentAction: string;
  readonly fromValence: NarrativeBehaviorValence;
  readonly toValence: NarrativeBehaviorValence;
  readonly shift: NarrativeBehaviorShiftKind;
  readonly chronology: "same-document-position" | "explicit-document-order";
  readonly previousEvidence: TextEvidence;
  readonly currentEvidence: TextEvidence;
  /** Referencias a señales contextuales del segundo comportamiento; no son causas asumidas. */
  readonly context: {
    readonly knowledgeActionLinkIds: readonly string[];
    readonly decisionContextIds: readonly string[];
    readonly memoryActionLinkIds: readonly string[];
    readonly intentEvolution: readonly {
      readonly id: string;
      readonly transition: NarrativeCharacterIntentEvolution["transition"];
    }[];
    readonly interpretation: "explicit-memory-connector-present" | "memory-link-present" |
      "decision-context-present" | "knowledge-context-present" | "no-linked-context";
  };
  readonly reviewStatus: "candidate";
}

export interface NarrativeBehaviorEvolutionInput {
  readonly projectId: string;
  readonly entities: readonly NarrativeEntity[];
  readonly priorActions?: readonly NarrativeActionCandidate[];
  readonly currentActions: readonly NarrativeActionCandidate[];
  readonly orderedDocumentIds?: readonly string[];
  readonly knowledgeActionLinks?: readonly NarrativeKnowledgeActionLink[];
  readonly decisionContexts?: readonly NarrativeDecisionContextCandidate[];
  readonly memoryActionLinks?: readonly NarrativeMemoryActionLink[];
  readonly intentEvolution?: readonly NarrativeCharacterIntentEvolution[];
}

const MAX_RECORDS = 10_000;
const MAX_RESULTS = 2_000;
const SUPPORTIVE = new Set([
  "acompañó", "acompaña", "acompañaba", "protegió", "protege", "protegía",
  "rescató", "rescata", "rescataba", "ayudó", "ayuda", "ayudaba",
  "salvó", "salva", "salvaba"
]);
const HOSTILE = new Set([
  "traicionó", "traiciona", "traicionaba", "destruyó", "destruye", "destruía",
  "atacó", "ataca", "atacaba", "mató", "mata", "mataba"
]);

function valence(action: string): NarrativeBehaviorValence {
  const normalized = action.normalize("NFKC").trim().toLocaleLowerCase("es");
  return SUPPORTIVE.has(normalized) ? "supportive"
    : HOSTILE.has(normalized) ? "hostile" : "neutral-or-unknown";
}
function sameEvidence(left: TextEvidence, right: TextEvidence): boolean {
  return left.documentId === right.documentId && left.revision === right.revision &&
    left.start === right.start && left.end === right.end && left.excerpt === right.excerpt;
}
function validEvidence(value: TextEvidence): boolean {
  return !!value && typeof value.documentId === "string" && !!value.documentId.trim() &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    Number.isSafeInteger(value.start) && value.start >= 0 &&
    Number.isSafeInteger(value.end) && value.end > value.start &&
    typeof value.excerpt === "string" && !!value.excerpt.trim();
}
function shiftKind(from: NarrativeBehaviorValence, to: NarrativeBehaviorValence,
                   previousAction: string, currentAction: string): NarrativeBehaviorShiftKind | undefined {
  const previousNormalized = previousAction.normalize("NFKC").trim().toLocaleLowerCase("es");
  const currentNormalized = currentAction.normalize("NFKC").trim().toLocaleLowerCase("es");
  if (from === to && previousNormalized === currentNormalized) return undefined;
  if (from === "supportive" && to === "hostile") return "supportive-to-hostile";
  if (from === "hostile" && to === "supportive") return "hostile-to-supportive";
  if (from === "supportive" && to === "neutral-or-unknown") return "supportive-to-neutral";
  if (from === "hostile" && to === "neutral-or-unknown") return "hostile-to-neutral";
  if (from === "neutral-or-unknown" && to === "supportive") return "neutral-to-supportive";
  if (from === "neutral-or-unknown" && to === "hostile") return "neutral-to-hostile";
  return "action-pattern-change";
}
function validate(input: NarrativeBehaviorEvolutionInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !Array.isArray(input.entities) || !Array.isArray(input.currentActions) ||
      (input.priorActions !== undefined && !Array.isArray(input.priorActions)) ||
      (input.orderedDocumentIds !== undefined &&
        (!Array.isArray(input.orderedDocumentIds) ||
         input.orderedDocumentIds.some(id => typeof id !== "string" || !id.trim()) ||
         new Set(input.orderedDocumentIds).size !== input.orderedDocumentIds.length)) ||
      (input.knowledgeActionLinks !== undefined && !Array.isArray(input.knowledgeActionLinks)) ||
      (input.decisionContexts !== undefined && !Array.isArray(input.decisionContexts)) ||
      (input.memoryActionLinks !== undefined && !Array.isArray(input.memoryActionLinks)) ||
      (input.intentEvolution !== undefined && !Array.isArray(input.intentEvolution)) ||
      (input.priorActions?.length ?? 0) + input.currentActions.length +
        (input.knowledgeActionLinks?.length ?? 0) +
        (input.decisionContexts?.length ?? 0) +
        (input.memoryActionLinks?.length ?? 0) +
        (input.intentEvolution?.length ?? 0) > MAX_RECORDS) {
    throw new Error("Contexto inválido para analizar la evolución de conducta.");
  }
  const entities = new Map<string, NarrativeEntity>();
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() || entities.has(entity.id)) {
      throw new Error("Las entidades deben ser únicas y pertenecer al proyecto.");
    }
    entities.set(entity.id, entity);
  }
  const actionIds = new Set<string>();
  const actionById = new Map<string, NarrativeActionCandidate>();
  for (const action of [...(input.priorActions ?? []), ...input.currentActions]) {
    if (!action || action.projectId !== input.projectId ||
        typeof action.id !== "string" || !action.id.trim() || actionIds.has(action.id) ||
        !entities.has(action.actorEntityId) || entities.get(action.actorEntityId)?.kind !== "character" ||
        !entities.has(action.targetEntityId) || action.actorEntityId === action.targetEntityId ||
        typeof action.action !== "string" || !action.action.trim() ||
        !["affirmed", "negated"].includes(action.polarity) ||
        action.reviewStatus !== "candidate" || !validEvidence(action.evidence)) {
      throw new Error("Las acciones deben tener IDs únicos, actores/personajes, objetivos y evidencia válidos.");
    }
    actionIds.add(action.id);
    actionById.set(action.id, action);
  }
  const knowledgeIds = new Set<string>();
  for (const link of input.knowledgeActionLinks ?? []) {
    if (!link || link.projectId !== input.projectId ||
        typeof link.id !== "string" || !link.id.trim() || knowledgeIds.has(link.id) ||
        !actionIds.has(link.actionId) || !entities.has(link.characterEntityId) ||
        !validEvidence(link.knowledgeEvidence) || !validEvidence(link.actionEvidence)) {
      throw new Error("Los enlaces de conocimiento deben referir acciones válidas del proyecto.");
    }
    knowledgeIds.add(link.id);
    const action = actionById.get(link.actionId)!;
    if (action.actorEntityId !== link.characterEntityId || !sameEvidence(action.evidence, link.actionEvidence)) {
      throw new Error("El enlace de conocimiento no coincide con la evidencia de su acción.");
    }
  }
  const contextIds = new Set<string>();
  for (const context of input.decisionContexts ?? []) {
    if (!context || context.projectId !== input.projectId ||
        typeof context.id !== "string" || !context.id.trim() || contextIds.has(context.id) ||
        !actionIds.has(context.actionId) || !validEvidence(context.knowledgeEvidence) ||
        !validEvidence(context.intentEvidence) || !validEvidence(context.actionEvidence)) {
      throw new Error("El contexto de decisión debe referir una acción válida del proyecto.");
    }
    contextIds.add(context.id);
    const action = actionById.get(context.actionId)!;
    if (action.actorEntityId !== context.characterEntityId || !sameEvidence(action.evidence, context.actionEvidence)) {
      throw new Error("El contexto de decisión no coincide con la evidencia de su acción.");
    }
  }
  const memoryLinkIds = new Set<string>();
  for (const link of input.memoryActionLinks ?? []) {
    if (!link || link.projectId !== input.projectId ||
        typeof link.id !== "string" || !link.id.trim() || memoryLinkIds.has(link.id) ||
        !link.actionId || !actionIds.has(link.actionId) ||
        !entities.has(link.characterEntityId) || !Array.isArray(link.memoryEventIds) ||
        !Array.isArray(link.memoryEvidence) || !link.memoryEvidence.every(validEvidence) ||
        !validEvidence(link.actionEvidence!) ||
        !["explicit-causal-link", "temporal-cooccurrence", "unresolved"].includes(link.relation) ||
        (link.connectorEvidence !== undefined && !validEvidence(link.connectorEvidence))) {
      throw new Error("El enlace de memoria debe referir una acción válida y evidencia.");
    }
    memoryLinkIds.add(link.id);
    const action = actionById.get(link.actionId)!;
    if (action.actorEntityId !== link.characterEntityId || !sameEvidence(action.evidence, link.actionEvidence!)) {
      throw new Error("El enlace de memoria no coincide con la evidencia de su acción.");
    }
  }
  const evolutionIds = new Set<string>();
  for (const evolution of input.intentEvolution ?? []) {
    if (!evolution || evolution.projectId !== input.projectId ||
        typeof evolution.id !== "string" || !evolution.id.trim() || evolutionIds.has(evolution.id) ||
        typeof evolution.currentIntentId !== "string" || !evolution.currentIntentId.trim() ||
        !entities.has(evolution.characterEntityId) ||
        !["maintained", "withdrawn", "replaced", "conditional", "coexisting",
          "ambiguous-predecessor", "chronology-unresolved"].includes(evolution.transition)) {
      throw new Error("La evolución de intenciones debe pertenecer al proyecto y tener IDs únicos.");
    }
    evolutionIds.add(evolution.id);
  }
}

/**
 * Compara acciones afirmadas dirigidas al mismo objetivo. Solo relaciona
 * posiciones del mismo documento/revisión o documentos con orden declarado.
 */
export function detectNarrativeBehaviorEvolution(
  input: NarrativeBehaviorEvolutionInput
): readonly NarrativeBehaviorShiftCandidate[] {
  validate(input);
  const allActions = [...(input.priorActions ?? []), ...input.currentActions]
    .filter(action => action.polarity === "affirmed");
  const groups = new Map<string, NarrativeActionCandidate[]>();
  for (const action of allActions) {
    const key = action.actorEntityId + "\u0000" + action.targetEntityId;
    const group = groups.get(key) ?? [];
    group.push(action);
    groups.set(key, group);
  }
  const documentOrder = new Map((input.orderedDocumentIds ?? []).map((id, index) => [id, index]));
  const output: NarrativeBehaviorShiftCandidate[] = [];
  const addShift = (previous: NarrativeActionCandidate, current: NarrativeActionCandidate,
                    chronology: NarrativeBehaviorShiftCandidate["chronology"]) => {
    const from = valence(previous.action), to = valence(current.action);
    const shift = shiftKind(from, to, previous.action, current.action);
    if (!shift || output.length >= MAX_RESULTS) return;
    const currentKnowledge = (input.knowledgeActionLinks ?? []).filter(item => item.actionId === current.id);
    const currentContexts = (input.decisionContexts ?? []).filter(item => item.actionId === current.id);
    const currentMemory = (input.memoryActionLinks ?? []).filter(item => item.actionId === current.id);
    const evolutions = (input.intentEvolution ?? []).flatMap(evolution => {
      const matches = currentContexts.some(context =>
        context.characterEntityId === evolution.characterEntityId &&
        context.intentId === evolution.currentIntentId
      );
      return matches ? [{id: evolution.id, transition: evolution.transition}] : [];
    });
    const interpretation: NarrativeBehaviorShiftCandidate["context"]["interpretation"] =
      currentMemory.some(item => item.relation === "explicit-causal-link" && item.connectorEvidence)
        ? "explicit-memory-connector-present"
        : currentMemory.length ? "memory-link-present"
        : currentContexts.length ? "decision-context-present"
        : currentKnowledge.length ? "knowledge-context-present"
        : "no-linked-context";
    output.push({
      id: "behavior-shift:" + previous.id + ":" + current.id,
      projectId: input.projectId,
      characterEntityId: current.actorEntityId,
      targetEntityId: current.targetEntityId,
      previousActionId: previous.id,
      currentActionId: current.id,
      previousAction: previous.action,
      currentAction: current.action,
      fromValence: from,
      toValence: to,
      shift,
      chronology,
      previousEvidence: previous.evidence,
      currentEvidence: current.evidence,
      context: {
        knowledgeActionLinkIds: currentKnowledge.map(item => item.id),
        decisionContextIds: currentContexts.map(item => item.id),
        memoryActionLinkIds: currentMemory.map(item => item.id),
        intentEvolution: evolutions,
        interpretation
      },
      reviewStatus: "candidate"
    });
  };

  for (const group of groups.values()) {
    // Dentro de cada documento/revisión, las acciones se ordenan por posición.
    const localGroups = new Map<string, NarrativeActionCandidate[]>();
    for (const action of group) {
      const key = action.evidence.documentId + "\u0000" + action.evidence.revision;
      const local = localGroups.get(key) ?? [];
      local.push(action);
      localGroups.set(key, local);
    }
    for (const local of localGroups.values()) {
      const ordered = [...local].sort((a, b) =>
        a.evidence.start - b.evidence.start || a.id.localeCompare(b.id)
      );
      for (let index = 1; index < ordered.length; index++) {
        const previous = ordered[index - 1]!, current = ordered[index]!;
        if (previous.evidence.end <= current.evidence.start) {
          addShift(previous, current, "same-document-position");
        }
      }
    }
    // Entre documentos solo se conectan el último acto de un capítulo y el
    // primero del siguiente cuando ambos aparecen en una secuencia declarada.
    if (input.orderedDocumentIds) {
      const byDocument = new Map<string, NarrativeActionCandidate[]>();
      for (const action of group) {
        const values = byDocument.get(action.evidence.documentId) ?? [];
        values.push(action);
        byDocument.set(action.evidence.documentId, values);
      }
      const activeDocuments = input.orderedDocumentIds.filter(id => byDocument.has(id));
      for (let index = 1; index < activeDocuments.length; index++) {
        const previousDocument = activeDocuments[index - 1]!;
        const currentDocument = activeDocuments[index]!;
        const previousSet = byDocument.get(previousDocument)!;
        const currentSet = byDocument.get(currentDocument)!;
        const previousRevisions = new Set(previousSet.map(item => item.evidence.revision));
        const currentRevisions = new Set(currentSet.map(item => item.evidence.revision));
        // Varias revisiones del mismo documento no tienen orden narrativo garantizado.
        if (previousRevisions.size !== 1 || currentRevisions.size !== 1) continue;
        const previousOrdered = [...previousSet].sort((a,b) =>
          a.evidence.start-b.evidence.start || a.id.localeCompare(b.id)
        );
        const currentOrdered = [...currentSet].sort((a,b) =>
          a.evidence.start-b.evidence.start || a.id.localeCompare(b.id)
        );
        const previous = previousOrdered[previousOrdered.length - 1]!;
        const current = currentOrdered[0]!;
        addShift(previous, current, "explicit-document-order");
      }
    }
  }
  return output.sort((a,b) =>
    a.currentEvidence.documentId.localeCompare(b.currentEvidence.documentId) ||
    a.currentEvidence.start-b.currentEvidence.start || a.id.localeCompare(b.id)
  );
}
