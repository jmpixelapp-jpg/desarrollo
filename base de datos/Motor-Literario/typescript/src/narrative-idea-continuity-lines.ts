import type { NarrativeIdeaOccurrenceReference } from "./narrative-idea-cross-document-relations";
import type {
  NarrativeIdeaEvolutionEvent,
  NarrativeIdeaEvolutionResult
} from "./narrative-idea-evolution";

export type NarrativeIdeaContinuityLineType =
  | "exact-recurrence-line"
  | "lexical-resonance-line"
  | "mixed-signal-line";

export type NarrativeIdeaContinuityTopology =
  | "linear"
  | "branching"
  | "converging"
  | "network"
  | "undirected";

export type NarrativeIdeaContinuityChronology = "complete" | "partial" | "unknown";

export interface NarrativeIdeaContinuityLine {
  readonly id: string;
  readonly projectId: string;
  readonly lineType: NarrativeIdeaContinuityLineType;
  readonly topology: NarrativeIdeaContinuityTopology;
  readonly chronology: NarrativeIdeaContinuityChronology;
  /** Solo existe cuando todas las relaciones están ordenadas y el orden total es único. */
  readonly orderedOccurrenceIds?: readonly string[];
  readonly occurrences: readonly NarrativeIdeaOccurrenceReference[];
  readonly relations: readonly NarrativeIdeaEvolutionEvent[];
  readonly exactRecurrenceCount: number;
  readonly lexicalResonanceCount: number;
  readonly modalityChangeCount: number;
  readonly ideaKindChangeCount: number;
  /** Señala una estructura de vínculos, no una división conceptual confirmada. */
  readonly hasBranchingEvidence: boolean;
  /** Señala varias relaciones entrantes, no una convergencia semántica confirmada. */
  readonly hasConvergingEvidence: boolean;
}

export interface NarrativeIdeaContinuityLinesSummary {
  readonly projectId: string;
  readonly lineCount: number;
  readonly occurrenceCount: number;
  readonly relationCount: number;
  readonly exactOnlyLineCount: number;
  readonly lexicalOnlyLineCount: number;
  readonly mixedSignalLineCount: number;
  readonly chronologyCompleteCount: number;
  readonly chronologyPartialCount: number;
  readonly chronologyUnknownCount: number;
  readonly branchingEvidenceCount: number;
  readonly convergingEvidenceCount: number;
  readonly networkTopologyCount: number;
  readonly sourceAnalysisTruncated: boolean;
}

export interface NarrativeIdeaContinuityLinesResult {
  readonly summary: NarrativeIdeaContinuityLinesSummary;
  readonly lines: readonly NarrativeIdeaContinuityLine[];
}

export interface NarrativeIdeaContinuityLinesInput {
  readonly projectId: string;
  readonly evolution: NarrativeIdeaEvolutionResult;
}

const MAX_EVENTS = 10_000;
const MAX_OCCURRENCES = 200;
const MAX_TEXT_UNITS = 500;
const MAX_EVIDENCE_UNITS = 2_000_000;

interface DisjointSet {
  find(id: string): string;
  union(a: string, b: string): void;
}

function createDisjointSet(): DisjointSet {
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();

  return {
    find(id: string): string {
      const current = parent.get(id);
      if (current === undefined) {
        parent.set(id, id);
        rank.set(id, 0);
        return id;
      }
      if (current === id) return id;
      const root = this.find(current);
      parent.set(id, root);
      return root;
    },
    union(a: string, b: string): void {
      let rootA = this.find(a);
      let rootB = this.find(b);
      if (rootA === rootB) return;
      const rankA = rank.get(rootA) ?? 0;
      const rankB = rank.get(rootB) ?? 0;
      if (rankA < rankB) [rootA, rootB] = [rootB, rootA];
      parent.set(rootB, rootA);
      if (rankA === rankB) rank.set(rootA, rankA + 1);
    }
  };
}

function containsTextWithWhitespace(excerpt: string, text: string): boolean {
  const normalizedExcerpt = excerpt.replace(/\\s+/gu, " ").trim();
  const normalizedText = text.replace(/\\s+/gu, " ").trim();
  return normalizedText.length > 0 && normalizedExcerpt.includes(normalizedText);
}

function validateOccurrence(occurrence: NarrativeIdeaOccurrenceReference): void {
  if (!occurrence || typeof occurrence !== "object" ||
      typeof occurrence.ideaCandidateId !== "string" || !occurrence.ideaCandidateId.trim() ||
      typeof occurrence.documentId !== "string" || !occurrence.documentId.trim() ||
      !Number.isSafeInteger(occurrence.revision) || occurrence.revision < 0 ||
      typeof occurrence.text !== "string" || !occurrence.text.trim() ||
      occurrence.text.length > MAX_TEXT_UNITS ||
      !["theme", "premise", "conflict", "goal", "motivation", "dilemma", "question", "hypothesis", "motif"].includes(occurrence.kind) ||
      !["affirmed", "negated", "conditional", "hypothetical"].includes(occurrence.polarity) ||
      !occurrence.evidence || occurrence.evidence.documentId !== occurrence.documentId ||
      occurrence.evidence.revision !== occurrence.revision ||
      typeof occurrence.evidence.excerpt !== "string" ||
      occurrence.evidence.excerpt.length > MAX_EVIDENCE_UNITS ||
      !containsTextWithWhitespace(occurrence.evidence.excerpt, occurrence.text) ||
      !Number.isSafeInteger(occurrence.evidence.start) ||
      !Number.isSafeInteger(occurrence.evidence.end) ||
      occurrence.evidence.start < 0 || occurrence.evidence.end <= occurrence.evidence.start) {
    throw new Error("La línea de continuidad contiene una aparición inválida.");
  }
}

function occurrenceSignature(occurrence: NarrativeIdeaOccurrenceReference): string {
  return JSON.stringify({
    documentId: occurrence.documentId,
    revision: occurrence.revision,
    kind: occurrence.kind,
    polarity: occurrence.polarity,
    text: occurrence.text,
    evidence: occurrence.evidence
  });
}

function validateEvent(event: NarrativeIdeaEvolutionEvent, projectId: string): void {
  if (!event || typeof event !== "object" ||
      event.projectId !== projectId ||
      typeof event.id !== "string" || !event.id.trim() ||
      event.reviewStatus !== "candidate" ||
      !["reappeared", "echoed", "observed-without-order"].includes(event.eventKind) ||
      !["ordered", "unknown"].includes(event.chronology) ||
      !event.supportingRelation ||
      typeof event.supportingRelation.relationId !== "string" ||
      !event.supportingRelation.relationId.trim() ||
      !["exact-recurrence", "lexical-resonance"].includes(event.supportingRelation.relationType) ||
      !Array.isArray(event.supportingRelation.sharedTerms) ||
      event.supportingRelation.sharedTerms.length > 500 ||
      event.supportingRelation.sharedTerms.some(term => typeof term !== "string" || !term.trim()) ||
      typeof event.supportingRelation.normalizedSimilarity !== "number" ||
      !Number.isFinite(event.supportingRelation.normalizedSimilarity) ||
      event.supportingRelation.normalizedSimilarity < 0 || event.supportingRelation.normalizedSimilarity > 1 ||
      typeof event.supportingRelation.overlapCoefficient !== "number" ||
      !Number.isFinite(event.supportingRelation.overlapCoefficient) ||
      event.supportingRelation.overlapCoefficient < 0 || event.supportingRelation.overlapCoefficient > 1 ||
      !Array.isArray(event.signals) ||
      new Set(event.signals).size !== event.signals.length ||
      event.signals.some(signal => ![
        "exact-wording-recurrence", "lexical-resonance", "modality-change", "idea-kind-change"
      ].includes(signal))) {
    throw new Error("El evento de evolución de idea es inválido.");
  }

  validateOccurrence(event.firstOccurrence);
  validateOccurrence(event.secondOccurrence);
  if (event.firstOccurrence.ideaCandidateId === event.secondOccurrence.ideaCandidateId ||
      event.firstOccurrence.documentId === event.secondOccurrence.documentId) {
    throw new Error("Una relación de continuidad necesita dos apariciones documentales distintas.");
  }

  const expectedKind = event.chronology === "unknown"
    ? "observed-without-order"
    : event.supportingRelation.relationType === "exact-recurrence" ? "reappeared" : "echoed";
  if (event.eventKind !== expectedKind) {
    throw new Error("La clase del evento no coincide con su relación y cronología.");
  }

  const expectedBaseSignal = event.supportingRelation.relationType === "exact-recurrence"
    ? "exact-wording-recurrence" : "lexical-resonance";
  const expectedModalitySignal = event.firstOccurrence.polarity !== event.secondOccurrence.polarity;
  const expectedKindSignal = event.firstOccurrence.kind !== event.secondOccurrence.kind;
  if (!event.signals.includes(expectedBaseSignal) ||
      event.signals.includes(expectedBaseSignal === "exact-wording-recurrence" ? "lexical-resonance" : "exact-wording-recurrence") ||
      event.signals.includes("modality-change") !== expectedModalitySignal ||
      event.signals.includes("idea-kind-change") !== expectedKindSignal) {
    throw new Error("Las señales del evento no corresponden a las apariciones y a la relación.");
  }

  if (event.chronology === "ordered") {
    if (!event.earlierOccurrence || !event.laterOccurrence ||
        event.earlierOccurrence.ideaCandidateId === event.laterOccurrence.ideaCandidateId ||
        event.earlierOccurrence.documentId === event.laterOccurrence.documentId) {
      throw new Error("El evento ordenado no conserva ambos extremos cronológicos.");
    }
    if (event.earlierOccurrence.ideaCandidateId !== event.firstOccurrence.ideaCandidateId &&
        event.earlierOccurrence.ideaCandidateId !== event.secondOccurrence.ideaCandidateId) {
      throw new Error("La aparición anterior no coincide con los extremos de la relación.");
    }
    if (event.laterOccurrence.ideaCandidateId !== event.firstOccurrence.ideaCandidateId &&
        event.laterOccurrence.ideaCandidateId !== event.secondOccurrence.ideaCandidateId) {
      throw new Error("La aparición posterior no coincide con los extremos de la relación.");
    }
    const earlierSource = event.earlierOccurrence.ideaCandidateId === event.firstOccurrence.ideaCandidateId
      ? event.firstOccurrence : event.secondOccurrence;
    const laterSource = event.laterOccurrence.ideaCandidateId === event.firstOccurrence.ideaCandidateId
      ? event.firstOccurrence : event.secondOccurrence;
    if (occurrenceSignature(event.earlierOccurrence) !== occurrenceSignature(earlierSource) ||
        occurrenceSignature(event.laterOccurrence) !== occurrenceSignature(laterSource)) {
      throw new Error("Los extremos cronológicos no conservan la misma procedencia de las apariciones.");
    }
  } else if (event.earlierOccurrence !== undefined || event.laterOccurrence !== undefined) {
    throw new Error("Un evento sin orden no puede declarar anterior y posterior.");
  }
}

function compareOccurrence(
  a: NarrativeIdeaOccurrenceReference,
  b: NarrativeIdeaOccurrenceReference
): number {
  return a.documentId.localeCompare(b.documentId) ||
    a.revision - b.revision ||
    a.evidence.start - b.evidence.start ||
    a.ideaCandidateId.localeCompare(b.ideaCandidateId);
}

function uniqueTopologicalOrder(
  occurrenceIds: readonly string[],
  edges: readonly (readonly [string, string])[]
): readonly string[] | undefined {
  const adjacency = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const id of occurrenceIds) {
    adjacency.set(id, new Set());
    indegree.set(id, 0);
  }
  for (const [from, to] of edges) {
    if (from === to || !adjacency.has(from) || !adjacency.has(to)) {
      throw new Error("La línea de continuidad contiene una arista cronológica inválida.");
    }
    const outgoing = adjacency.get(from)!;
    if (outgoing.has(to)) continue;
    outgoing.add(to);
    indegree.set(to, indegree.get(to)! + 1);
  }

  const ready = [...occurrenceIds].filter(id => indegree.get(id) === 0).sort();
  const order: string[] = [];
  let unique = true;
  while (ready.length) {
    if (ready.length !== 1) unique = false;
    const current = ready.shift()!;
    order.push(current);
    for (const next of adjacency.get(current)!) {
      const nextDegree = indegree.get(next)! - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }
  if (order.length !== occurrenceIds.length) {
    throw new Error("La cronología de las relaciones contiene un ciclo imposible.");
  }
  return unique ? order : undefined;
}

function topologyFor(
  occurrenceIds: readonly string[],
  edges: readonly (readonly [string, string])[],
  chronologyComplete: boolean
): {
  readonly topology: NarrativeIdeaContinuityTopology;
  readonly hasBranchingEvidence: boolean;
  readonly hasConvergingEvidence: boolean;
} {
  if (!chronologyComplete) {
    return { topology: "undirected", hasBranchingEvidence: false, hasConvergingEvidence: false };
  }
  const incoming = new Map(occurrenceIds.map(id => [id, 0]));
  const outgoing = new Map(occurrenceIds.map(id => [id, 0]));
  for (const [from, to] of edges) {
    outgoing.set(from, outgoing.get(from)! + 1);
    incoming.set(to, incoming.get(to)! + 1);
  }
  const hasBranchingEvidence = [...outgoing.values()].some(count => count > 1);
  const hasConvergingEvidence = [...incoming.values()].some(count => count > 1);
  const topology = hasBranchingEvidence && hasConvergingEvidence ? "network" :
    hasBranchingEvidence ? "branching" :
    hasConvergingEvidence ? "converging" : "linear";
  return { topology, hasBranchingEvidence, hasConvergingEvidence };
}

/**
 * Reconstruye grupos conectados de apariciones relacionadas.
 *
 * Una línea es una agrupación estructural de señales; no es una identidad
 * semántica confirmada. Los ecos léxicos pueden conectar ideas distintas.
 * La clasificación de bifurcación/convergencia describe la topología de los
 * enlaces ordenados, no que una idea se haya dividido o fusionado realmente.
 */
export function buildNarrativeIdeaContinuityLines(
  input: NarrativeIdeaContinuityLinesInput
): NarrativeIdeaContinuityLinesResult {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !input.evolution || !input.evolution.summary ||
      input.evolution.summary.projectId !== input.projectId ||
      !Array.isArray(input.evolution.events) ||
      input.evolution.events.length > MAX_EVENTS ||
      !Number.isSafeInteger(input.evolution.summary.eventCount) ||
      input.evolution.summary.eventCount !== input.evolution.events.length ||
      typeof input.evolution.summary.sourceAnalysisTruncated !== "boolean") {
    throw new Error("Contexto inválido para reconstruir líneas de continuidad de ideas.");
  }

  const occurrences = new Map<string, NarrativeIdeaOccurrenceReference>();
  const signatures = new Map<string, string>();
  const eventIds = new Set<string>();
  const relationIds = new Set<string>();
  const sets = createDisjointSet();

  for (const event of input.evolution.events) {
    validateEvent(event, input.projectId);
    if (eventIds.has(event.id) || relationIds.has(event.supportingRelation.relationId)) {
      throw new Error("La evolución contiene IDs de evento o relación duplicados.");
    }
    eventIds.add(event.id);
    relationIds.add(event.supportingRelation.relationId);

    for (const occurrence of [event.firstOccurrence, event.secondOccurrence]) {
      const id = occurrence.ideaCandidateId;
      const signature = occurrenceSignature(occurrence);
      const previous = signatures.get(id);
      if (previous !== undefined && previous !== signature) {
        throw new Error("Una aparición cambia de procedencia o contenido entre relaciones.");
      }
      signatures.set(id, signature);
      occurrences.set(id, occurrence);
      sets.find(id);
    }
    sets.union(event.firstOccurrence.ideaCandidateId, event.secondOccurrence.ideaCandidateId);
  }

  if (occurrences.size > MAX_OCCURRENCES) {
    throw new Error("El conjunto de apariciones supera el límite de continuidad.");
  }

  const groupedEvents = new Map<string, NarrativeIdeaEvolutionEvent[]>();
  for (const event of input.evolution.events) {
    const root = sets.find(event.firstOccurrence.ideaCandidateId);
    const bucket = groupedEvents.get(root) ?? [];
    bucket.push(event);
    groupedEvents.set(root, bucket);
  }

  const lines: NarrativeIdeaContinuityLine[] = [];
  for (const [root, events] of groupedEvents) {
    const occurrenceIds = [...new Set(events.flatMap(event => [
      event.firstOccurrence.ideaCandidateId,
      event.secondOccurrence.ideaCandidateId
    ]))];
    const lineOccurrences = occurrenceIds.map(id => occurrences.get(id)!).sort(compareOccurrence);
    const allOrdered = events.every(event => event.chronology === "ordered");
    const directedEdges: [string, string][] = events
      .filter(event => event.chronology === "ordered")
      .map(event => [
        event.earlierOccurrence!.ideaCandidateId,
        event.laterOccurrence!.ideaCandidateId
      ]);
    const totalOrder = allOrdered
      ? uniqueTopologicalOrder(occurrenceIds, directedEdges)
      : undefined;
    const chronology = !allOrdered ? (directedEdges.length ? "partial" : "unknown") :
      totalOrder ? "complete" : "partial";
    const topology = topologyFor(occurrenceIds, directedEdges, chronology === "complete");

    const exactRecurrenceCount = events.filter(event =>
      event.supportingRelation.relationType === "exact-recurrence"
    ).length;
    const lexicalResonanceCount = events.length - exactRecurrenceCount;
    const lineType = exactRecurrenceCount && lexicalResonanceCount
      ? "mixed-signal-line"
      : exactRecurrenceCount ? "exact-recurrence-line" : "lexical-resonance-line";
    const modalityChangeCount = events.filter(event => event.signals.includes("modality-change")).length;
    const ideaKindChangeCount = events.filter(event => event.signals.includes("idea-kind-change")).length;

    lines.push({
      id: "idea-continuity-line:" + encodeURIComponent(input.projectId) + ":" +
        occurrenceIds.map(encodeURIComponent).sort().join("|"),
      projectId: input.projectId,
      lineType,
      topology: topology.topology,
      chronology,
      ...(chronology === "complete" && totalOrder ? { orderedOccurrenceIds: totalOrder } : {}),
      occurrences: chronology === "complete" && totalOrder
        ? totalOrder.map(id => occurrences.get(id)!)
        : lineOccurrences,
      relations: [...events].sort((a, b) => a.id.localeCompare(b.id)),
      exactRecurrenceCount,
      lexicalResonanceCount,
      modalityChangeCount,
      ideaKindChangeCount,
      hasBranchingEvidence: topology.hasBranchingEvidence,
      hasConvergingEvidence: topology.hasConvergingEvidence
    });
  }

  lines.sort((a, b) => a.id.localeCompare(b.id));
  const exactOnlyLineCount = lines.filter(line => line.lineType === "exact-recurrence-line").length;
  const lexicalOnlyLineCount = lines.filter(line => line.lineType === "lexical-resonance-line").length;
  const mixedSignalLineCount = lines.filter(line => line.lineType === "mixed-signal-line").length;
  const chronologyCompleteCount = lines.filter(line => line.chronology === "complete").length;
  const chronologyPartialCount = lines.filter(line => line.chronology === "partial").length;
  const chronologyUnknownCount = lines.filter(line => line.chronology === "unknown").length;

  return {
    summary: {
      projectId: input.projectId,
      lineCount: lines.length,
      occurrenceCount: occurrences.size,
      relationCount: input.evolution.events.length,
      exactOnlyLineCount,
      lexicalOnlyLineCount,
      mixedSignalLineCount,
      chronologyCompleteCount,
      chronologyPartialCount,
      chronologyUnknownCount,
      branchingEvidenceCount: lines.filter(line => line.hasBranchingEvidence).length,
      convergingEvidenceCount: lines.filter(line => line.hasConvergingEvidence).length,
      networkTopologyCount: lines.filter(line => line.topology === "network").length,
      sourceAnalysisTruncated: input.evolution.summary.sourceAnalysisTruncated
    },
    lines
  };
}
