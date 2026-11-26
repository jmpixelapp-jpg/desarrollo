/**
 * Compara afirmaciones cognitivas del mismo personaje sobre la misma
 * proposición literal normalizada. Produce discrepancias y cambios de estado
 * candidatos; no infiere mentira, verdad, causalidad ni cronología diegética.
 */
import type { TextEvidence } from "./narrative-knowledge";
import type { NarrativeCharacterKnowledgeCandidate } from "./narrative-character-knowledge-discovery";
import type { NarrativeKnowledgeDocumentOrder } from "./narrative-character-knowledge-timeline";

export type NarrativeKnowledgeComparisonKind =
  | "polarity-disagreement"
  | "epistemic-status-shift"
  | "knowledge-kind-shift";
export interface NarrativeCharacterKnowledgeComparisonInput {
  readonly projectId: string;
  readonly candidates: readonly NarrativeCharacterKnowledgeCandidate[];
  /** Si falta, no se compara entre documentos distintos. */
  readonly documentOrder?: readonly NarrativeKnowledgeDocumentOrder[];
}
export interface NarrativeCharacterKnowledgeFinding {
  readonly id: string;
  readonly projectId: string;
  readonly holderEntityId: string;
  readonly propositionKey: string;
  readonly firstCandidateId: string;
  readonly secondCandidateId: string;
  readonly kind: NarrativeKnowledgeComparisonKind;
  readonly firstKnowledgeKind: NarrativeCharacterKnowledgeCandidate["kind"];
  readonly secondKnowledgeKind: NarrativeCharacterKnowledgeCandidate["kind"];
  readonly firstMode: NarrativeCharacterKnowledgeCandidate["mode"];
  readonly secondMode: NarrativeCharacterKnowledgeCandidate["mode"];
  readonly firstPolarity: NarrativeCharacterKnowledgeCandidate["polarity"];
  readonly secondPolarity: NarrativeCharacterKnowledgeCandidate["polarity"];
  readonly ordering: "same-document-text-order" | "explicit-document-order" | "unordered";
  readonly firstEvidence: TextEvidence;
  readonly secondEvidence: TextEvidence;
  readonly firstPropositionEvidence?: TextEvidence;
  readonly secondPropositionEvidence?: TextEvidence;
  readonly interpretation: "candidate-only";
  readonly reviewStatus: "candidate";
}
export const MAX_NARRATIVE_KNOWLEDGE_COMPARISON_INPUTS = 10_000;
export const MAX_NARRATIVE_KNOWLEDGE_COMPARISON_FINDINGS = 2_000;
export const MAX_NARRATIVE_KNOWLEDGE_COMPARISON_PAIR_CHECKS = 50_000;
function validEvidence(value: TextEvidence, item: NarrativeCharacterKnowledgeCandidate): boolean {
  return !!value && value.documentId === item.documentId && value.revision === item.revision &&
    Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) &&
    value.start >= 0 && value.end > value.start && typeof value.excerpt === "string" &&
    value.excerpt.length === value.end - value.start && value.status !== "stale";
}
function propositionKey(item: NarrativeCharacterKnowledgeCandidate): string | undefined {
  const value = item.propositionEvidence?.excerpt;
  if (typeof value !== "string" || !value.trim()) return undefined;
  // Normalización deliberadamente superficial: no traduce sinónimos ni resuelve correferencia.
  return value.normalize("NFC").toLocaleLowerCase("es")
    .replace(/[.,;:!?¿¡]+$/gu, "").replace(/\s+/gu, " ").trim();
}
function validate(input: NarrativeCharacterKnowledgeComparisonInput): void {
  if (!input || typeof input !== "object" || typeof input.projectId !== "string" ||
      !input.projectId.trim() || !Array.isArray(input.candidates) ||
      input.candidates.length > MAX_NARRATIVE_KNOWLEDGE_COMPARISON_INPUTS ||
      (input.documentOrder !== undefined &&
        (!Array.isArray(input.documentOrder) ||
         input.documentOrder.length > 5_000))) {
    throw new Error("Entrada inválida para comparar afirmaciones de conocimiento.");
  }
  const ids = new Set<string>();
  for (const item of input.candidates) {
    if (!item || item.projectId !== input.projectId || typeof item.id !== "string" ||
        !item.id.trim() || ids.has(item.id) || typeof item.holderEntityId !== "string" ||
        !item.holderEntityId.trim() || !validEvidence(item.evidence, item) ||
        !validEvidence(item.holderEvidence, item) || !validEvidence(item.triggerEvidence, item) ||
        item.holderEvidence.start < item.evidence.start || item.holderEvidence.end > item.evidence.end ||
        item.triggerEvidence.start < item.evidence.start || item.triggerEvidence.end > item.evidence.end ||
        (item.propositionEvidence !== undefined &&
          (!validEvidence(item.propositionEvidence, item) ||
           item.propositionEvidence.start < item.evidence.start ||
           item.propositionEvidence.end > item.evidence.end)) ||
        (item.sourceEvidence !== undefined &&
          (!validEvidence(item.sourceEvidence, item) ||
           item.sourceEvidence.start < item.evidence.start || item.sourceEvidence.end > item.evidence.end))) {
      throw new Error("Afirmación cognitiva inválida, duplicada o con evidencia no vigente.");
    }
    ids.add(item.id);
  }
  const docs = new Set<string>(), orders = new Set<number>();
  for (const item of input.documentOrder ?? []) {
    if (!item || typeof item.documentId !== "string" || !item.documentId.trim() ||
        !Number.isSafeInteger(item.order) || item.order < 0 ||
        docs.has(item.documentId) || orders.has(item.order)) {
      throw new Error("El orden documental contiene valores duplicados o inválidos.");
    }
    docs.add(item.documentId); orders.add(item.order);
  }
}
function orderPair(
  a: NarrativeCharacterKnowledgeCandidate,
  b: NarrativeCharacterKnowledgeCandidate,
  order: ReadonlyMap<string, number>
): { first: NarrativeCharacterKnowledgeCandidate; second: NarrativeCharacterKnowledgeCandidate;
     ordering: NarrativeCharacterKnowledgeFinding["ordering"] } {
  if (a.documentId === b.documentId && a.revision === b.revision) {
    const sorted = [a, b].sort((x, y) =>
      x.evidence.start - y.evidence.start || x.id.localeCompare(y.id));
    return { first: sorted[0]!, second: sorted[1]!, ordering: "same-document-text-order" };
  }
  const ao = order.get(a.documentId), bo = order.get(b.documentId);
  if (ao !== undefined && bo !== undefined && ao !== bo) {
    return ao < bo
      ? { first: a, second: b, ordering: "explicit-document-order" }
      : { first: b, second: a, ordering: "explicit-document-order" };
  }
  const sorted = [a, b].sort((x, y) =>
    x.documentId.localeCompare(y.documentId) || x.revision - y.revision ||
    x.evidence.start - y.evidence.start || x.id.localeCompare(y.id));
  return { first: sorted[0]!, second: sorted[1]!, ordering: "unordered" };
}
export function compareNarrativeCharacterKnowledge(
  input: NarrativeCharacterKnowledgeComparisonInput
): readonly NarrativeCharacterKnowledgeFinding[] {
  validate(input);
  const order = new Map((input.documentOrder ?? []).map(x => [x.documentId, x.order]));
  const groups = new Map<string, NarrativeCharacterKnowledgeCandidate[]>();
  for (const item of input.candidates) {
    const proposition = propositionKey(item);
    if (!proposition) continue;
    const key = JSON.stringify([item.holderEntityId, proposition]);
    const group = groups.get(key) ?? [];
    group.push(item); groups.set(key, group);
  }
  const pairs = [...groups.values()].reduce((sum, group) => sum + group.length * (group.length - 1) / 2, 0);
  if (pairs > MAX_NARRATIVE_KNOWLEDGE_COMPARISON_PAIR_CHECKS) {
    throw new Error("La comparación supera el presupuesto de parejas; divide el manuscrito por bloques o capítulos.");
  }
  const findings: NarrativeCharacterKnowledgeFinding[] = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const a = group[i]!, b = group[j]!;
      if (a.documentId === b.documentId && a.revision === b.revision &&
          a.evidence.start === b.evidence.start && a.evidence.end === b.evidence.end) continue;
      const polarityDisagreement = a.polarity !== b.polarity;
      const statusShift = a.mode !== b.mode;
      const kindShift = a.kind !== b.kind;
      if (!polarityDisagreement && !statusShift && !kindShift) continue;
      // Un orden técnico no basta para describir un cambio direccional entre capítulos.
      const pair = orderPair(a, b, order);
      const kind: NarrativeKnowledgeComparisonKind = polarityDisagreement
        ? "polarity-disagreement" : statusShift ? "epistemic-status-shift" : "knowledge-kind-shift";
      if (findings.length >= MAX_NARRATIVE_KNOWLEDGE_COMPARISON_FINDINGS) {
        throw new Error("La comparación supera el límite de hallazgos; divide el manuscrito por bloques o capítulos.");
      }
      const proposition = propositionKey(a)!;
      findings.push({
        id: "character-knowledge-comparison:" + JSON.stringify([pair.first.id, pair.second.id, kind]),
        projectId: input.projectId, holderEntityId: a.holderEntityId, propositionKey: proposition,
        firstCandidateId: pair.first.id, secondCandidateId: pair.second.id, kind,
        firstKnowledgeKind: pair.first.kind, secondKnowledgeKind: pair.second.kind,
        firstMode: pair.first.mode, secondMode: pair.second.mode,
        firstPolarity: pair.first.polarity, secondPolarity: pair.second.polarity,
        ordering: pair.ordering, firstEvidence: pair.first.evidence, secondEvidence: pair.second.evidence,
        ...(pair.first.propositionEvidence ? { firstPropositionEvidence: pair.first.propositionEvidence } : {}),
        ...(pair.second.propositionEvidence ? { secondPropositionEvidence: pair.second.propositionEvidence } : {}),
        interpretation: "candidate-only", reviewStatus: "candidate"
      });
    }
  }
  return findings.sort((a, b) => a.id.localeCompare(b.id));
}
