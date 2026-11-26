import {
  buildNarrativeIdeaContinuityLines,
  type NarrativeIdeaContinuityLinesResult
} from "./narrative-idea-continuity-lines";
import type { NarrativeIdeaEvolutionEvent, NarrativeIdeaEvolutionResult } from "./narrative-idea-evolution";

export interface NarrativeIdeaContinuityIncrementalInput {
  readonly projectId: string;
  readonly previous: NarrativeIdeaContinuityLinesResult;
  readonly nextEvolution: NarrativeIdeaEvolutionResult;
  /** Documentos cuya revisión/contenido se ha recalculado, incluidos los retirados. */
  readonly changedDocumentIds: readonly string[];
}

export interface NarrativeIdeaContinuityIncrementalResult {
  readonly result: NarrativeIdeaContinuityLinesResult;
  /** IDs anteriores afectados; incluye líneas que se conservaron con nuevo contenido. */
  readonly changedLineIds: readonly string[];
  /** Líneas que desaparecieron o quedaron absorbidas por componentes mayores. */
  readonly removedLineIds: readonly string[];
  /** Componentes intactos que se reutilizaron sin reconstruir sus relaciones. */
  readonly reusedLineIds: readonly string[];
  readonly rebuiltLineCount: number;
  readonly scannedEventCount: number;
}

const MAX_EVENTS = 10_000;
const MAX_CHANGED_DOCUMENTS = 10_000;

function eventSignature(event: NarrativeIdeaEvolutionEvent): string {
  return JSON.stringify(event);
}

function endpointIds(event: NarrativeIdeaEvolutionEvent): readonly string[] {
  return [event.firstOccurrence.ideaCandidateId, event.secondOccurrence.ideaCandidateId];
}

function endpointDocuments(event: NarrativeIdeaEvolutionEvent): readonly string[] {
  return [event.firstOccurrence.documentId, event.secondOccurrence.documentId];
}

function assertEvolution(
  value: NarrativeIdeaEvolutionResult,
  projectId: string
): void {
  if (!value || !value.summary || value.summary.projectId !== projectId ||
      !Array.isArray(value.events) || value.events.length > MAX_EVENTS ||
      value.summary.eventCount !== value.events.length ||
      value.summary.relationCount !== value.events.length ||
      !Number.isSafeInteger(value.summary.eventCount) || value.summary.eventCount < 0 ||
      typeof value.summary.sourceAnalysisTruncated !== "boolean") {
    throw new Error("El análisis de evolución no puede actualizar el índice incremental.");
  }
  const eventIds = new Set<string>();
  for (const event of value.events) {
    if (!event || typeof event.id !== "string" || !event.id.trim() ||
        event.projectId !== projectId ||
        !event.firstOccurrence || !event.secondOccurrence) {
      throw new Error("El análisis incremental contiene un evento malformado.");
    }
    if (eventIds.has(event.id)) throw new Error("El análisis incremental contiene IDs de evento duplicados.");
    eventIds.add(event.id);
  }
}

function summarizeEvents(
  projectId: string,
  events: readonly NarrativeIdeaEvolutionEvent[],
  sourceAnalysisTruncated: boolean
): NarrativeIdeaEvolutionResult {
  return {
    summary: {
      projectId,
      relationCount: events.length,
      eventCount: events.length,
      reappearedCount: events.filter(event => event.eventKind === "reappeared").length,
      echoedCount: events.filter(event => event.eventKind === "echoed").length,
      withoutOrderCount: events.filter(event => event.eventKind === "observed-without-order").length,
      modalityChangeCount: events.filter(event => event.signals.includes("modality-change")).length,
      ideaKindChangeCount: events.filter(event => event.signals.includes("idea-kind-change")).length,
      sourceAnalysisTruncated
    },
    events
  };
}

function aggregateLines(
  projectId: string,
  lines: readonly NarrativeIdeaContinuityLinesResult["lines"][number][],
  relationCount: number,
  sourceAnalysisTruncated: boolean
): NarrativeIdeaContinuityLinesResult {
  const occurrenceIds = new Set<string>();
  for (const line of lines) {
    for (const occurrence of line.occurrences) occurrenceIds.add(occurrence.ideaCandidateId);
  }
  const count = (predicate: (line: NarrativeIdeaContinuityLinesResult["lines"][number]) => boolean) =>
    lines.filter(predicate).length;
  return {
    summary: {
      projectId,
      lineCount: lines.length,
      occurrenceCount: occurrenceIds.size,
      relationCount,
      exactOnlyLineCount: count(line => line.lineType === "exact-recurrence-line"),
      lexicalOnlyLineCount: count(line => line.lineType === "lexical-resonance-line"),
      mixedSignalLineCount: count(line => line.lineType === "mixed-signal-line"),
      chronologyCompleteCount: count(line => line.chronology === "complete"),
      chronologyPartialCount: count(line => line.chronology === "partial"),
      chronologyUnknownCount: count(line => line.chronology === "unknown"),
      branchingEvidenceCount: count(line => line.hasBranchingEvidence),
      convergingEvidenceCount: count(line => line.hasConvergingEvidence),
      networkTopologyCount: count(line => line.topology === "network"),
      sourceAnalysisTruncated
    },
    lines
  };
}

/**
 * Actualiza solo los componentes afectados por cambios documentales.
 *
 * Se recorre el inventario de eventos para detectar diferencias, pero la
 * reconstrucción de componentes queda limitada a los subgrafos conectados a
 * documentos/eventos modificados. Las líneas ajenas al cambio se reutilizan.
 * La detección de divisiones se resuelve reconstruyendo todo el subgrafo
 * afectado, no intentando retirar aristas de un union-find irreversible.
 */
export function updateNarrativeIdeaContinuityLinesIncrementally(
  input: NarrativeIdeaContinuityIncrementalInput
): NarrativeIdeaContinuityIncrementalResult {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !input.previous || input.previous.summary.projectId !== input.projectId ||
      !Array.isArray(input.previous.lines) ||
      input.previous.summary.lineCount !== input.previous.lines.length ||
      !Number.isSafeInteger(input.previous.summary.relationCount) ||
      input.previous.summary.relationCount < 0 ||
      !Array.isArray(input.changedDocumentIds) ||
      input.changedDocumentIds.length > MAX_CHANGED_DOCUMENTS) {
    throw new Error("Contexto inválido para la actualización incremental de continuidad.");
  }
  assertEvolution(input.nextEvolution, input.projectId);

  const changedDocuments = new Set<string>();
  for (const documentId of input.changedDocumentIds) {
    if (typeof documentId !== "string" || !documentId.trim() ||
        documentId.length > 256 || changedDocuments.has(documentId)) {
      throw new Error("La lista de documentos cambiados contiene IDs inválidos o repetidos.");
    }
    changedDocuments.add(documentId);
  }

  const previousEvents = new Map<string, NarrativeIdeaEvolutionEvent>();
  const previousEventLines = new Map<string, string>();
  for (const line of input.previous.lines) {
    if (!line || line.projectId !== input.projectId || !Array.isArray(line.relations)) {
      throw new Error("El índice anterior contiene una línea malformada.");
    }
    for (const event of line.relations) {
      if (!event || typeof event.id !== "string" || previousEvents.has(event.id)) {
        throw new Error("El índice anterior contiene eventos duplicados o inválidos.");
      }
      previousEvents.set(event.id, event);
      previousEventLines.set(event.id, line.id);
    }
  }
  if (previousEvents.size !== input.previous.summary.relationCount) {
    throw new Error("El recuento de relaciones del índice anterior es inconsistente.");
  }

  const nextEvents = new Map(input.nextEvolution.events.map(event => [event.id, event]));
  const affectedOldEventIds = new Set<string>();
  const affectedNewEventIds = new Set<string>();
  const seedOccurrenceIds = new Set<string>();

  for (const [id, previousEvent] of previousEvents) {
    const current = nextEvents.get(id);
    const changedByDocument = endpointDocuments(previousEvent).some(documentId =>
      changedDocuments.has(documentId));
    if (!current || eventSignature(previousEvent) !== eventSignature(current) || changedByDocument) {
      affectedOldEventIds.add(id);
      for (const occurrenceId of endpointIds(previousEvent)) seedOccurrenceIds.add(occurrenceId);
    }
  }
  for (const [id, currentEvent] of nextEvents) {
    const previous = previousEvents.get(id);
    const changedByDocument = endpointDocuments(currentEvent).some(documentId =>
      changedDocuments.has(documentId));
    if (!previous || eventSignature(previous) !== eventSignature(currentEvent) || changedByDocument) {
      affectedNewEventIds.add(id);
      for (const occurrenceId of endpointIds(currentEvent)) seedOccurrenceIds.add(occurrenceId);
    }
  }

  const impactedPreviousLineIds = new Set<string>();
  for (const eventId of affectedOldEventIds) {
    const lineId = previousEventLines.get(eventId);
    if (lineId) impactedPreviousLineIds.add(lineId);
  }
  for (const line of input.previous.lines) {
    if (line.occurrences.some(occurrence => seedOccurrenceIds.has(occurrence.ideaCandidateId))) {
      impactedPreviousLineIds.add(line.id);
    }
  }

  const adjacency = new Map<string, NarrativeIdeaEvolutionEvent[]>();
  for (const event of input.nextEvolution.events) {
    for (const occurrenceId of endpointIds(event)) {
      const connected = adjacency.get(occurrenceId) ?? [];
      connected.push(event);
      adjacency.set(occurrenceId, connected);
    }
  }

  const queue = [...seedOccurrenceIds].sort();
  const visitedOccurrences = new Set<string>();
  const selectedEventIds = new Set<string>();
  const selectedEvents: NarrativeIdeaEvolutionEvent[] = [];
  while (queue.length) {
    const occurrenceId = queue.shift()!;
    if (visitedOccurrences.has(occurrenceId)) continue;
    visitedOccurrences.add(occurrenceId);
    for (const event of adjacency.get(occurrenceId) ?? []) {
      if (!selectedEventIds.has(event.id)) {
        selectedEventIds.add(event.id);
        selectedEvents.push(event);
        for (const connectedId of endpointIds(event)) {
          if (!visitedOccurrences.has(connectedId)) queue.push(connectedId);
        }
      }
    }
  }

  const rebuilt = buildNarrativeIdeaContinuityLines({
    projectId: input.projectId,
    evolution: summarizeEvents(
      input.projectId,
      selectedEvents,
      input.nextEvolution.summary.sourceAnalysisTruncated
    )
  });

  const reusedLines = input.previous.lines.filter(line => !impactedPreviousLineIds.has(line.id));
  const combinedLines = [...reusedLines, ...rebuilt.lines]
    .sort((a, b) => a.id.localeCompare(b.id));
  const result = aggregateLines(
    input.projectId,
    combinedLines,
    reusedLines.reduce((sum, line) => sum + line.relations.length, 0) +
      rebuilt.summary.relationCount,
    input.nextEvolution.summary.sourceAnalysisTruncated
  );
  const currentLineIds = new Set(combinedLines.map(line => line.id));
  const removedLineIds = [...impactedPreviousLineIds]
    .filter(id => !currentLineIds.has(id))
    .sort((a, b) => a.localeCompare(b));
  const rebuiltLineIds = rebuilt.lines.map(line => line.id);
  const changedLineIds = [...new Set([...impactedPreviousLineIds, ...rebuiltLineIds])]
    .sort((a, b) => a.localeCompare(b));
  const reusedLineIds = reusedLines.map(line => line.id).sort((a, b) => a.localeCompare(b));

  return {
    result,
    changedLineIds,
    removedLineIds,
    reusedLineIds,
    rebuiltLineCount: rebuilt.lines.length,
    scannedEventCount: previousEvents.size + nextEvents.size
  };
}
