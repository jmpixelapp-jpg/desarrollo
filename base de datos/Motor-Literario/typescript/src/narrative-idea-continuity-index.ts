import type { NarrativeIdeaOccurrenceReference } from "./narrative-idea-cross-document-relations";
import type { NarrativeIdeaEvolutionEvent } from "./narrative-idea-evolution";
import type { NarrativeIdeaContinuityLine, NarrativeIdeaContinuityLinesResult, NarrativeIdeaContinuityLinesSummary } from "./narrative-idea-continuity-lines";
import type { ProjectStore } from "./contracts";
import {
  createNarrativeSyncOperationEnvelope,
  canonicalizeNarrativeSyncPayload,
  fingerprintNarrativeSyncPayload,
  type CreateNarrativeSyncOperationEnvelopeInput,
  type NarrativeSyncOperationEnvelope
} from "./narrative-sync-integrity";

export interface NarrativeIdeaContinuitySourceRevision {
  readonly documentId: string;
  readonly revision: number;
  readonly status: "active" | "deleted";
}

export type StoredNarrativeIdeaContinuityEvent =
  Omit<NarrativeIdeaEvolutionEvent,
    "firstOccurrence" | "secondOccurrence" | "earlierOccurrence" | "laterOccurrence"
  > & {
    readonly firstOccurrenceId: string;
    readonly secondOccurrenceId: string;
    readonly earlierOccurrenceId?: string;
    readonly laterOccurrenceId?: string;
  };

export type StoredNarrativeIdeaContinuityLine =
  Omit<NarrativeIdeaContinuityLine, "occurrences" | "relations" | "orderedOccurrenceIds"> & {
    readonly occurrenceIds: readonly string[];
    readonly relationIds: readonly string[];
    readonly orderedOccurrenceIds?: readonly string[];
  };

/**
 * Snapshot derivado y reconstruible. No es una idea canónica ni sustituye
 * NarrativeIdea: conserva un único ejemplar de cada evidencia y enlaces por ID.
 */
export interface NarrativeIdeaContinuityIndex {
  readonly version: 1;
  readonly projectId: string;
  /** Token CAS local del índice; no es una revisión editorial del manuscrito. */
  readonly generation: number;
  readonly updatedAt: number;
  readonly sourceRevisions: readonly NarrativeIdeaContinuitySourceRevision[];
  readonly summary: NarrativeIdeaContinuityLinesSummary;
  readonly occurrences: readonly NarrativeIdeaOccurrenceReference[];
  readonly events: readonly StoredNarrativeIdeaContinuityEvent[];
  readonly lines: readonly StoredNarrativeIdeaContinuityLine[];
  /** FNV-1a para consistencia accidental; no es autenticación ni firma criptográfica. */
  readonly fingerprint: string;
}

export interface CreateNarrativeIdeaContinuityIndexInput {
  readonly projectId: string;
  readonly generation: number;
  readonly updatedAt: number;
  readonly sourceRevisions: readonly NarrativeIdeaContinuitySourceRevision[];
  readonly result: NarrativeIdeaContinuityLinesResult;
}

export interface CommitNarrativeIdeaContinuityIndexResult {
  readonly index: NarrativeIdeaContinuityIndex;
  readonly reused: boolean;
}

const MAX_DOCUMENTS = 10_000;
const MAX_OCCURRENCES = 200;
const MAX_EVENTS = 10_000;
const MAX_EVIDENCE_UNITS = 8_000_000;
const FINGERPRINT_LIMITS = {
  maxDepth: 64,
  maxNodes: 500_000,
  maxBytes: 40_000_000
} as const;

/**
 * Límites compartidos por el emisor y receptor al transportar el índice
 * compacto. Los anfitriones deben configurar el diario con esta misma
 * política para que las operaciones grandes no se rechacen al recibirse.
 */
export const NARRATIVE_IDEA_CONTINUITY_SYNC_LIMITS = FINGERPRINT_LIMITS;

function equalOccurrence(
  left: NarrativeIdeaOccurrenceReference,
  right: NarrativeIdeaOccurrenceReference
): boolean {
  return left.ideaCandidateId === right.ideaCandidateId &&
    left.documentId === right.documentId &&
    left.revision === right.revision &&
    left.kind === right.kind &&
    left.polarity === right.polarity &&
    left.text === right.text &&
    left.evidence.documentId === right.evidence.documentId &&
    left.evidence.revision === right.evidence.revision &&
    left.evidence.start === right.evidence.start &&
    left.evidence.end === right.evidence.end &&
    left.evidence.excerpt === right.evidence.excerpt;
}

function normalizeExactPhrase(value: string): string {
  return value.normalize("NFKD")
    .replace(/\\p{M}/gu, "")
    .toLocaleLowerCase("es")
    .replace(/[\\p{P}\\p{S}]+/gu, " ")
    .replace(/\\s+/gu, " ")
    .trim()
    .normalize("NFKC");
}

function validateOccurrence(value: NarrativeIdeaOccurrenceReference): void {
  if (!value || typeof value !== "object" ||
      typeof value.ideaCandidateId !== "string" || !value.ideaCandidateId.trim() ||
      value.ideaCandidateId.length > 256 ||
      typeof value.documentId !== "string" || !value.documentId.trim() ||
      value.documentId.length > 256 ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.text !== "string" || !value.text.trim() || value.text.length > 500 ||
      !["theme", "premise", "conflict", "goal", "motivation", "dilemma", "question", "hypothesis", "motif"].includes(value.kind) ||
      !["affirmed", "negated", "conditional", "hypothetical"].includes(value.polarity) ||
      !value.evidence || value.evidence.documentId !== value.documentId ||
      value.evidence.revision !== value.revision ||
      !value.evidence.excerpt.replace(/\\s+/gu, " ").trim().includes(value.text.replace(/\\s+/gu, " ").trim()) ||
      !Number.isSafeInteger(value.evidence.start) || value.evidence.start < 0 ||
      !Number.isSafeInteger(value.evidence.end) || value.evidence.end <= value.evidence.start ||
      typeof value.evidence.excerpt !== "string" ||
      value.evidence.excerpt.length > 2_000_000) {
    throw new Error("El índice de continuidad contiene una aparición o evidencia inválida.");
  }
}

function fingerprintContent(value: {
  readonly version: 1;
  readonly projectId: string;
  readonly sourceRevisions: readonly NarrativeIdeaContinuitySourceRevision[];
  readonly summary: NarrativeIdeaContinuityLinesSummary;
  readonly occurrences: readonly NarrativeIdeaOccurrenceReference[];
  readonly events: readonly StoredNarrativeIdeaContinuityEvent[];
  readonly lines: readonly StoredNarrativeIdeaContinuityLine[];
}): string {
  return fingerprintNarrativeSyncPayload(value, FINGERPRINT_LIMITS);
}

function contentOf(index: NarrativeIdeaContinuityIndex) {
  return {
    version: index.version,
    projectId: index.projectId,
    sourceRevisions: index.sourceRevisions,
    summary: index.summary,
    occurrences: index.occurrences,
    events: index.events,
    lines: index.lines
  } as const;
}

export function areNarrativeIdeaContinuityIndexesEquivalent(
  left: NarrativeIdeaContinuityIndex,
  right: NarrativeIdeaContinuityIndex
): boolean {
  if (!left || !right || left.fingerprint !== right.fingerprint) return false;
  return canonicalizeNarrativeSyncPayload(contentOf(left), FINGERPRINT_LIMITS) ===
    canonicalizeNarrativeSyncPayload(contentOf(right), FINGERPRINT_LIMITS);
}

function normalizeSourceRevisions(
  values: readonly NarrativeIdeaContinuitySourceRevision[]
): NarrativeIdeaContinuitySourceRevision[] {
  if (!Array.isArray(values) || values.length > MAX_DOCUMENTS) {
    throw new Error("El vector de revisiones documentales supera el límite permitido.");
  }
  const seen = new Set<string>();
  const revisions = values.map(value => {
    if (!value || typeof value.documentId !== "string" || !value.documentId.trim() ||
        value.documentId.length > 256 ||
        !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        (value.status !== "active" && value.status !== "deleted") ||
        seen.has(value.documentId)) {
      throw new Error("El vector de revisiones contiene documentos inválidos o duplicados.");
    }
    seen.add(value.documentId);
    return { documentId: value.documentId, revision: value.revision, status: value.status };
  });
  return revisions.sort((a, b) => a.documentId.localeCompare(b.documentId));
}

function compactResult(result: NarrativeIdeaContinuityLinesResult): {
  readonly summary: NarrativeIdeaContinuityLinesSummary;
  readonly occurrences: readonly NarrativeIdeaOccurrenceReference[];
  readonly events: readonly StoredNarrativeIdeaContinuityEvent[];
  readonly lines: readonly StoredNarrativeIdeaContinuityLine[];
} {
  if (!result || !result.summary || !Array.isArray(result.lines) ||
      result.summary.lineCount !== result.lines.length ||
      !Array.isArray(result.lines)) {
    throw new Error("La proyección de continuidad está malformada.");
  }
  const occurrences = new Map<string, NarrativeIdeaOccurrenceReference>();
  const events = new Map<string, StoredNarrativeIdeaContinuityEvent>();
  const lines: StoredNarrativeIdeaContinuityLine[] = [];
  let evidenceUnits = 0;

  for (const line of result.lines) {
    if (!line || !Array.isArray(line.occurrences) || !Array.isArray(line.relations)) {
      throw new Error("Una línea de continuidad no contiene listas válidas.");
    }
    for (const occurrence of line.occurrences) {
      validateOccurrence(occurrence);
      const existing = occurrences.get(occurrence.ideaCandidateId);
      if (existing && !equalOccurrence(existing, occurrence)) {
        throw new Error("Una aparición tiene contenidos distintos en dos líneas.");
      }
      if (!existing) {
        evidenceUnits += occurrence.text.length + occurrence.evidence.excerpt.length;
        if (evidenceUnits > MAX_EVIDENCE_UNITS || occurrences.size >= MAX_OCCURRENCES) {
          throw new Error("El índice supera el presupuesto de apariciones o evidencia.");
        }
        occurrences.set(occurrence.ideaCandidateId, occurrence);
      }
    }
    for (const event of line.relations) {
      if (!event || typeof event.id !== "string" || events.has(event.id)) {
        throw new Error("El índice contiene eventos duplicados o inválidos.");
      }
      const stored: StoredNarrativeIdeaContinuityEvent = {
        id: event.id,
        projectId: event.projectId,
        eventKind: event.eventKind,
        reviewStatus: event.reviewStatus,
        chronology: event.chronology,
        signals: [...event.signals],
        supportingRelation: event.supportingRelation,
        firstOccurrenceId: event.firstOccurrence.ideaCandidateId,
        secondOccurrenceId: event.secondOccurrence.ideaCandidateId,
        ...(event.earlierOccurrence ? { earlierOccurrenceId: event.earlierOccurrence.ideaCandidateId } : {}),
        ...(event.laterOccurrence ? { laterOccurrenceId: event.laterOccurrence.ideaCandidateId } : {})
      };
      events.set(event.id, stored);
    }
    const {
      occurrences: lineOccurrences,
      relations: lineRelations,
      orderedOccurrenceIds,
      ...metadata
    } = line;
    lines.push({
      ...metadata,
      occurrenceIds: lineOccurrences.map(item => item.ideaCandidateId),
      relationIds: lineRelations.map(item => item.id),
      ...(orderedOccurrenceIds ? { orderedOccurrenceIds: [...orderedOccurrenceIds] } : {})
    });
  }

  if (events.size > MAX_EVENTS) throw new Error("El índice supera el límite de eventos.");
  return {
    summary: result.summary,
    occurrences: [...occurrences.values()].sort((a, b) =>
      a.ideaCandidateId.localeCompare(b.ideaCandidateId)),
    events: [...events.values()].sort((a, b) => a.id.localeCompare(b.id)),
    lines: lines.sort((a, b) => a.id.localeCompare(b.id))
  };
}

function hydrateCompactIndex(
  index: NarrativeIdeaContinuityIndex
): NarrativeIdeaContinuityLinesResult {
  const occurrenceById = new Map(index.occurrences.map(item => [item.ideaCandidateId, item]));
  const eventById = new Map<string, NarrativeIdeaEvolutionEvent>();
  for (const stored of index.events) {
    const firstOccurrence = occurrenceById.get(stored.firstOccurrenceId);
    const secondOccurrence = occurrenceById.get(stored.secondOccurrenceId);
    if (!firstOccurrence || !secondOccurrence) {
      throw new Error("El índice contiene una relación a una aparición inexistente.");
    }
    const earlierOccurrence = stored.earlierOccurrenceId
      ? occurrenceById.get(stored.earlierOccurrenceId) : undefined;
    const laterOccurrence = stored.laterOccurrenceId
      ? occurrenceById.get(stored.laterOccurrenceId) : undefined;
    if ((stored.earlierOccurrenceId && !earlierOccurrence) ||
        (stored.laterOccurrenceId && !laterOccurrence)) {
      throw new Error("El índice contiene extremos cronológicos inexistentes.");
    }
    eventById.set(stored.id, {
      id: stored.id,
      projectId: stored.projectId,
      eventKind: stored.eventKind,
      reviewStatus: stored.reviewStatus,
      chronology: stored.chronology,
      ...(earlierOccurrence ? { earlierOccurrence } : {}),
      ...(laterOccurrence ? { laterOccurrence } : {}),
      firstOccurrence,
      secondOccurrence,
      signals: [...stored.signals],
      supportingRelation: stored.supportingRelation
    });
  }

  const lines: NarrativeIdeaContinuityLine[] = index.lines.map(stored => {
    const occurrences = stored.occurrenceIds.map(id => occurrenceById.get(id));
    const relations = stored.relationIds.map(id => eventById.get(id));
    if (occurrences.some(value => !value) || relations.some(value => !value)) {
      throw new Error("Una línea contiene referencias huérfanas en el índice.");
    }
    const {
      occurrenceIds: _occurrenceIds,
      relationIds: _relationIds,
      orderedOccurrenceIds,
      ...metadata
    } = stored;
    return {
      ...metadata,
      occurrences: occurrences as NarrativeIdeaOccurrenceReference[],
      relations: relations as NarrativeIdeaEvolutionEvent[],
      ...(orderedOccurrenceIds ? { orderedOccurrenceIds: [...orderedOccurrenceIds] } : {})
    };
  });

  return { summary: index.summary, lines };
}

export function validateNarrativeIdeaContinuityIndex(
  value: NarrativeIdeaContinuityIndex
): void {
  if (!value || typeof value !== "object" ||
      value.version !== 1 ||
      typeof value.projectId !== "string" || !value.projectId.trim() || value.projectId.length > 256 ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      !Number.isFinite(value.updatedAt) || value.updatedAt < 0 ||
      typeof value.fingerprint !== "string" || !/^fnv1a64:[0-9a-f]{16}$/u.test(value.fingerprint) ||
      !Array.isArray(value.sourceRevisions) || value.sourceRevisions.length > MAX_DOCUMENTS ||
      !Array.isArray(value.occurrences) || value.occurrences.length > MAX_OCCURRENCES ||
      !Array.isArray(value.events) || value.events.length > MAX_EVENTS ||
      !Array.isArray(value.lines) || value.lines.length > MAX_EVENTS ||
      !value.summary || value.summary.projectId !== value.projectId) {
    throw new Error("El índice persistente de continuidad tiene metadatos inválidos.");
  }

  const revisions = normalizeSourceRevisions(value.sourceRevisions);
  const revisionByDocument = new Map(revisions.map(item => [item.documentId, item]));
  const occurrenceById = new Map<string, NarrativeIdeaOccurrenceReference>();
  let evidenceUnits = 0;
  for (const occurrence of value.occurrences) {
    validateOccurrence(occurrence);
    const source = revisionByDocument.get(occurrence.documentId);
    if (!source || source.status !== "active" || occurrence.revision > source.revision ||
        occurrenceById.has(occurrence.ideaCandidateId)) {
      throw new Error("Una aparición no coincide con el vector vigente de revisiones documentales.");
    }
    evidenceUnits += occurrence.text.length + occurrence.evidence.excerpt.length;
    if (evidenceUnits > MAX_EVIDENCE_UNITS) throw new Error("El índice supera el presupuesto de evidencia.");
    occurrenceById.set(occurrence.ideaCandidateId, occurrence);
  }

  const eventById = new Map<string, StoredNarrativeIdeaContinuityEvent>();
  for (const event of value.events) {
    if (!event || typeof event.id !== "string" || !event.id.trim() || event.id.length > 1024 ||
        event.projectId !== value.projectId ||
        eventById.has(event.id) ||
        !occurrenceById.has(event.firstOccurrenceId) ||
        !occurrenceById.has(event.secondOccurrenceId) ||
        event.firstOccurrenceId === event.secondOccurrenceId ||
        !Array.isArray(event.signals) || new Set(event.signals).size !== event.signals.length ||
        event.signals.some(signal => ![
          "exact-wording-recurrence", "lexical-resonance", "modality-change", "idea-kind-change"
        ].includes(signal)) ||
        !event.supportingRelation ||
        typeof event.supportingRelation.relationId !== "string" ||
        !event.supportingRelation.relationId.trim() || event.supportingRelation.relationId.length > 1024 ||
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
        event.reviewStatus !== "candidate" ||
        !["ordered", "unknown"].includes(event.chronology) ||
        !["reappeared", "echoed", "observed-without-order"].includes(event.eventKind)) {
      throw new Error("El inventario persistente de relaciones de continuidad es inválido.");
    }
    const first = occurrenceById.get(event.firstOccurrenceId)!;
    const second = occurrenceById.get(event.secondOccurrenceId)!;
    const expectedKind = event.chronology === "unknown" ? "observed-without-order" :
      event.supportingRelation.relationType === "exact-recurrence" ? "reappeared" : "echoed";
    const expectedBaseSignal = event.supportingRelation.relationType === "exact-recurrence"
      ? "exact-wording-recurrence" : "lexical-resonance";
    const relation = event.supportingRelation;
    if (first.documentId === second.documentId ||
        (relation.relationType === "exact-recurrence" &&
          (relation.normalizedSimilarity !== 1 || relation.overlapCoefficient !== 1 ||
            normalizeExactPhrase(first.text) !== normalizeExactPhrase(second.text))) ||
        (relation.relationType === "lexical-resonance" && relation.sharedTerms.length < 2) ||
        event.eventKind !== expectedKind ||
        !event.signals.includes(expectedBaseSignal) ||
        event.signals.includes(expectedBaseSignal === "exact-wording-recurrence"
          ? "lexical-resonance" : "exact-wording-recurrence") ||
        event.signals.includes("modality-change") !== (first.polarity !== second.polarity) ||
        event.signals.includes("idea-kind-change") !== (first.kind !== second.kind)) {
      throw new Error("La relación persistida contradice la procedencia o señales de sus apariciones.");
    }
    if (event.chronology === "ordered") {
      if (!event.earlierOccurrenceId || !event.laterOccurrenceId ||
          event.earlierOccurrenceId === event.laterOccurrenceId ||
          ![event.firstOccurrenceId, event.secondOccurrenceId].includes(event.earlierOccurrenceId) ||
          ![event.firstOccurrenceId, event.secondOccurrenceId].includes(event.laterOccurrenceId)) {
        throw new Error("La relación ordenada perdió sus referencias cronológicas.");
      }
    } else if (event.earlierOccurrenceId !== undefined || event.laterOccurrenceId !== undefined) {
      throw new Error("Una relación sin orden no puede conservar extremos cronológicos.");
    }
    eventById.set(event.id, event);
  }

  const lineIds = new Set<string>();
  const seenEvents = new Set<string>();
  const seenOccurrences = new Set<string>();
  for (const line of value.lines) {
    if (!line || typeof line.id !== "string" || !line.id.trim() ||
        line.projectId !== value.projectId || lineIds.has(line.id) ||
        !Array.isArray(line.occurrenceIds) || !Array.isArray(line.relationIds) ||
        line.occurrenceIds.length < 2 || line.relationIds.length < 1 ||
        line.occurrenceIds.some(id => typeof id !== "string" || !id.trim()) ||
        line.relationIds.some(id => typeof id !== "string" || !id.trim()) ||
        new Set(line.occurrenceIds).size !== line.occurrenceIds.length ||
        new Set(line.relationIds).size !== line.relationIds.length ||
        typeof line.hasBranchingEvidence !== "boolean" ||
        typeof line.hasConvergingEvidence !== "boolean") {
      throw new Error("El inventario persistente de líneas de continuidad es inválido.");
    }
    lineIds.add(line.id);
    const localOccurrences = new Set(line.occurrenceIds);
    if (line.occurrenceIds.some(id => !occurrenceById.has(id) || seenOccurrences.has(id))) {
      throw new Error("Una línea contiene apariciones inexistentes o asignadas a dos componentes.");
    }
    for (const id of line.occurrenceIds) seenOccurrences.add(id);
    for (const relationId of line.relationIds) {
      const event = eventById.get(relationId);
      if (!event || seenEvents.has(relationId) ||
          !localOccurrences.has(event.firstOccurrenceId) ||
          !localOccurrences.has(event.secondOccurrenceId)) {
        throw new Error("Una línea contiene relaciones huérfanas o asignadas a dos componentes.");
      }
      seenEvents.add(relationId);
    }
    const lineEvents = line.relationIds.map(id => eventById.get(id)!);
    const exactCount = lineEvents.filter(event =>
      event.supportingRelation.relationType === "exact-recurrence").length;
    const lexicalCount = lineEvents.length - exactCount;
    const expectedLineType = exactCount && lexicalCount ? "mixed-signal-line" :
      exactCount ? "exact-recurrence-line" : "lexical-resonance-line";
    const modalityCount = lineEvents.filter(event => event.signals.includes("modality-change")).length;
    const kindChangeCount = lineEvents.filter(event => event.signals.includes("idea-kind-change")).length;
    if (line.chronology === "complete" && !Array.isArray(line.orderedOccurrenceIds)) {
      throw new Error("Una línea con cronología completa debe conservar su orden total.");
    }    if (line.chronology === "complete") {
      const orderPosition = new Map(line.orderedOccurrenceIds!.map((id, index) => [id, index]));
      for (const event of lineEvents) {
        if (orderPosition.get(event.earlierOccurrenceId!)! >= orderPosition.get(event.laterOccurrenceId!)!) {
          throw new Error("El orden total de una línea contradice una relación dirigida.");
        }
      }
    }

    if (line.chronology !== "complete" && line.orderedOccurrenceIds !== undefined) {
      throw new Error("Una cronología parcial o desconocida no puede publicar un orden total.");
    }
    const orderedEvents = lineEvents.filter(event => event.chronology === "ordered");
    const allEventsOrdered = orderedEvents.length === lineEvents.length;
    const incoming = new Map(line.occurrenceIds.map(id => [id, 0]));
    const outgoing = new Map(line.occurrenceIds.map(id => [id, 0]));
    for (const event of orderedEvents) {
      const from = event.earlierOccurrenceId!;
      const to = event.laterOccurrenceId!;
      outgoing.set(from, (outgoing.get(from) ?? 0) + 1);
      incoming.set(to, (incoming.get(to) ?? 0) + 1);
    }
    const expectedBranching = allEventsOrdered && [...outgoing.values()].some(count => count > 1);
    const expectedConverging = allEventsOrdered && [...incoming.values()].some(count => count > 1);
    const expectedTopology = !allEventsOrdered ? "undirected" :
      expectedBranching && expectedConverging ? "network" :
      expectedBranching ? "branching" :
      expectedConverging ? "converging" : "linear";
    if (line.lineType !== expectedLineType ||
        line.exactRecurrenceCount !== exactCount ||
        line.lexicalResonanceCount !== lexicalCount ||
        line.modalityChangeCount !== modalityCount ||
        line.ideaKindChangeCount !== kindChangeCount ||
        line.hasBranchingEvidence !== expectedBranching ||
        line.hasConvergingEvidence !== expectedConverging ||
        line.topology !== expectedTopology ||
        (line.chronology === "complete" && lineEvents.some(event => event.chronology !== "ordered")) ||
        (line.chronology === "unknown" && lineEvents.some(event => event.chronology !== "unknown"))) {
      throw new Error("Los metadatos de continuidad no coinciden con sus relaciones.");
    }
    if (line.orderedOccurrenceIds !== undefined &&
        (!Array.isArray(line.orderedOccurrenceIds) ||
          line.chronology !== "complete" ||
          line.orderedOccurrenceIds.length !== line.occurrenceIds.length ||
          line.orderedOccurrenceIds.some((id, index) => id !== line.occurrenceIds[index]))) {
      throw new Error("El orden total persistido no coincide con sus apariciones.");
    }
    if (!["exact-recurrence-line", "lexical-resonance-line", "mixed-signal-line"].includes(line.lineType) ||
        !["linear", "branching", "converging", "network", "undirected"].includes(line.topology) ||
        !["complete", "partial", "unknown"].includes(line.chronology)) {
      throw new Error("La clasificación de una línea persistente es inválida.");
    }
  }
  if (seenOccurrences.size !== occurrenceById.size || seenEvents.size !== eventById.size ||
      value.summary.lineCount !== value.lines.length ||
      value.summary.occurrenceCount !== value.occurrences.length ||
      value.summary.relationCount !== value.events.length ||
      typeof value.summary.sourceAnalysisTruncated !== "boolean") {
    throw new Error("Los totales del índice de continuidad son inconsistentes.");
  }

  const expectedCounts = {
    exactOnlyLineCount: value.lines.filter(line => line.lineType === "exact-recurrence-line").length,
    lexicalOnlyLineCount: value.lines.filter(line => line.lineType === "lexical-resonance-line").length,
    mixedSignalLineCount: value.lines.filter(line => line.lineType === "mixed-signal-line").length,
    chronologyCompleteCount: value.lines.filter(line => line.chronology === "complete").length,
    chronologyPartialCount: value.lines.filter(line => line.chronology === "partial").length,
    chronologyUnknownCount: value.lines.filter(line => line.chronology === "unknown").length,
    branchingEvidenceCount: value.lines.filter(line => line.hasBranchingEvidence).length,
    convergingEvidenceCount: value.lines.filter(line => line.hasConvergingEvidence).length,
    networkTopologyCount: value.lines.filter(line => line.topology === "network").length
  };
  for (const [key, expected] of Object.entries(expectedCounts)) {
    if (value.summary[key as keyof typeof expectedCounts] !== expected) {
      throw new Error("Los contadores de clasificación del índice no coinciden: " + key);
    }
  }

  const hydrated = hydrateCompactIndex(value);
  const checked = compactResult(hydrated);
  if (JSON.stringify(checked.summary) !== JSON.stringify(value.summary) ||
      JSON.stringify(checked.lines) !== JSON.stringify(value.lines) ||
      JSON.stringify(checked.events) !== JSON.stringify(value.events) ||
      JSON.stringify(checked.occurrences) !== JSON.stringify(value.occurrences)) {
    throw new Error("El índice persistente no conserva una representación compacta consistente.");
  }
  if (fingerprintContent(contentOf(value)) !== value.fingerprint) {
    throw new Error("La huella del índice persistente no coincide con su contenido.");
  }
}

export function createNarrativeIdeaContinuityIndex(
  input: CreateNarrativeIdeaContinuityIndexInput
): NarrativeIdeaContinuityIndex {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !Number.isSafeInteger(input.generation) || input.generation < 1 ||
      !Number.isFinite(input.updatedAt) || input.updatedAt < 0 ||
      !input.result || input.result.summary.projectId !== input.projectId) {
    throw new Error("Contexto inválido para crear el índice persistente de continuidad.");
  }
  const compact = compactResult(input.result);
  const content = {
    version: 1 as const,
    projectId: input.projectId,
    sourceRevisions: normalizeSourceRevisions(input.sourceRevisions),
    summary: compact.summary,
    occurrences: compact.occurrences,
    events: compact.events,
    lines: compact.lines
  };
  const index: NarrativeIdeaContinuityIndex = {
    ...content,
    generation: input.generation,
    updatedAt: input.updatedAt,
    fingerprint: fingerprintContent(content)
  };
  validateNarrativeIdeaContinuityIndex(index);
  return index;
}

export function hydrateNarrativeIdeaContinuityIndex(
  index: NarrativeIdeaContinuityIndex
): NarrativeIdeaContinuityLinesResult {
  validateNarrativeIdeaContinuityIndex(index);
  return hydrateCompactIndex(index);
}

export async function commitNarrativeIdeaContinuityIndex(
  store: ProjectStore,
  input: Omit<CreateNarrativeIdeaContinuityIndexInput, "generation">
): Promise<CommitNarrativeIdeaContinuityIndexResult> {
  if (!store || typeof store.loadNarrativeIdeaContinuityIndex !== "function" ||
      typeof store.saveNarrativeIdeaContinuityIndexIfUnchanged !== "function") {
    throw new Error("El almacenamiento no implementa persistencia CAS del índice de continuidad.");
  }
  const current = await store.loadNarrativeIdeaContinuityIndex(input.projectId);
  const generation = (current?.generation ?? 0) + 1;
  const candidate = createNarrativeIdeaContinuityIndex({ ...input, generation });
  if (current && areNarrativeIdeaContinuityIndexesEquivalent(current, candidate)) {
    return { index: current, reused: true };
  }
  await store.saveNarrativeIdeaContinuityIndexIfUnchanged(candidate, current?.generation);
  return { index: candidate, reused: false };
}


/** Payload versionado del handler de réplica para la proyección derivada. */
export interface NarrativeIdeaContinuityIndexSyncPayload {
  readonly index: NarrativeIdeaContinuityIndex;
  readonly expectedGeneration?: number;
}

/**
 * Crea la envoltura SHA-256 del índice con los mismos límites amplios que
 * deberán configurarse en el diario receptor mediante
 * NARRATIVE_IDEA_CONTINUITY_SYNC_LIMITS. No cambia la política por defecto
 * para el resto de operaciones narrativas.
 */
export function createNarrativeIdeaContinuityIndexSyncEnvelope(
  input: Omit<CreateNarrativeSyncOperationEnvelopeInput<NarrativeIdeaContinuityIndexSyncPayload>, "kind"> 
): Promise<NarrativeSyncOperationEnvelope<NarrativeIdeaContinuityIndexSyncPayload>> {
  if (!input || !input.payload ||
      input.payload.index.projectId !== input.projectId) {
    throw new Error("La envoltura de continuidad debe usar el mismo proyecto que el índice.");
  }
  validateNarrativeIdeaContinuityIndex(input.payload.index);
  if (input.payload.expectedGeneration !== undefined &&
      (!Number.isSafeInteger(input.payload.expectedGeneration) ||
        input.payload.expectedGeneration < 0 ||
        input.payload.index.generation !== input.payload.expectedGeneration + 1)) {
    throw new Error("La generación base del índice de continuidad no es válida.");
  }
  if (input.payload.index.generation !== (input.payload.expectedGeneration ?? 0) + 1) {
    throw new Error("La primera generación del índice debe ser uno y las siguientes consecutivas.");
  }
  return createNarrativeSyncOperationEnvelope({
    ...input,
    kind: "idea-continuity-index-upsert"
  }, NARRATIVE_IDEA_CONTINUITY_SYNC_LIMITS);
}
