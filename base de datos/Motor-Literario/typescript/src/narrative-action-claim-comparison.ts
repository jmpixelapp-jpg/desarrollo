/**
 * Compara observaciones de acción con sujeto gramatical explícito.
 *
 * Una polaridad distinta es solo una discrepancia textual candidata: sin
 * referencias temporales comparables no demuestra contradicción factual.
 * Las perspectivas epistémicas y las fuentes se conservan por separado.
 */
import type { NarrativeObservationCandidate } from "./narrative-observation-discovery";
import type { TextEvidence } from "./narrative-knowledge";

export const MAX_NARRATIVE_ACTION_CLAIM_INPUTS = 10_000;
export const MAX_NARRATIVE_ACTION_CLAIM_FINDINGS = 2_000;
export const MAX_NARRATIVE_ACTION_CLAIM_PAIR_CHECKS = 50_000;

export interface NarrativeActionClaimDisagreement {
  readonly id: string;
  readonly projectId: string;
  readonly subjectEntityId: string;
  readonly action: string;
  readonly objectEntityId?: string;
  readonly firstObservationId: string;
  readonly secondObservationId: string;
  readonly firstPolarity: "affirmed" | "negated";
  readonly secondPolarity: "affirmed" | "negated";
  readonly interpretation: "same-epistemic-frame" | "different-epistemic-frame";
  readonly firstEpistemicFrame: NarrativeObservationCandidate["epistemicFrame"];
  readonly secondEpistemicFrame: NarrativeObservationCandidate["epistemicFrame"];
  readonly firstSourceEntityId?: string;
  readonly secondSourceEntityId?: string;
  readonly evidence: readonly [TextEvidence, TextEvidence];
  readonly classification: "polarity-disagreement-candidate";
  readonly reviewStatus: "candidate";
}

export interface NarrativeActionClaimComparisonInput {
  readonly projectId: string;
  readonly observations: readonly NarrativeObservationCandidate[];
}

function validEvidence(value: TextEvidence): boolean {
  return !!value && typeof value.documentId === "string" && !!value.documentId.trim() &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    Number.isSafeInteger(value.start) && value.start >= 0 &&
    Number.isSafeInteger(value.end) && value.end > value.start &&
    typeof value.excerpt === "string" && value.excerpt.length === value.end - value.start &&
    value.status !== "stale";
}

function claimKey(item: NarrativeObservationCandidate): string | undefined {
  const subject = item.grammaticalSubjectCandidate;
  if (!subject || subject.voice !== "active" || !subject.entityId.trim()) return undefined;
  const objectId = item.grammaticalObjectCandidate?.entityId;
  // No se equipara una acción con objeto explícito a otra sin objeto.
  return JSON.stringify([
    item.projectId, subject.entityId, item.action, objectId ?? null,
    item.grammaticalTense
  ]);
}

function sameEpistemicPerspective(
  left: NarrativeObservationCandidate,
  right: NarrativeObservationCandidate
): boolean {
  return left.epistemicFrame === right.epistemicFrame &&
    (left.epistemicSourceCandidate?.entityId ?? null) ===
      (right.epistemicSourceCandidate?.entityId ?? null);
}

/**
 * Compara solo acciones con el mismo sujeto activo explícito, lema verbal,
 * objeto explícito (si existe) y tiempo gramatical. No infiere equivalencias
 * entre verbos, sujetos pronominales ni objetos omitidos.
 */
export function compareNarrativeActionClaims(
  input: NarrativeActionClaimComparisonInput
): readonly NarrativeActionClaimDisagreement[] {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !Array.isArray(input.observations) ||
      input.observations.length > MAX_NARRATIVE_ACTION_CLAIM_INPUTS) {
    throw new Error("Contexto inválido para comparar afirmaciones de acciones narrativas.");
  }

  const groups = new Map<string, NarrativeObservationCandidate[]>();
  const ids = new Set<string>();
  for (const item of input.observations) {
    if (!item || item.projectId !== input.projectId ||
        typeof item.id !== "string" || !item.id.trim() || ids.has(item.id) ||
        item.kind !== "action" || typeof item.action !== "string" || !item.action.trim() ||
        !["affirmed", "negated"].includes(item.polarity) ||
        !validEvidence(item.evidence) || !validEvidence(item.actionEvidence) ||
        item.evidence.documentId !== item.actionEvidence.documentId ||
        item.evidence.revision !== item.actionEvidence.revision ||
        (item.grammaticalSubjectCandidate !== undefined &&
          !validEvidence(item.grammaticalSubjectCandidate.evidence)) ||
        (item.grammaticalObjectCandidate !== undefined &&
          !validEvidence(item.grammaticalObjectCandidate.evidence))) {
      throw new Error("Observación inválida: se requiere identidad única y evidencia textual vigente.");
    }
    ids.add(item.id);
    const key = claimKey(item);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const findings: NarrativeActionClaimDisagreement[] = [];
  let pairChecks = 0;
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [, group] of orderedGroups) {
    group.sort((a, b) =>
      a.evidence.documentId.localeCompare(b.evidence.documentId) ||
      a.evidence.revision - b.evidence.revision ||
      a.evidence.start - b.evidence.start || a.id.localeCompare(b.id)
    );
    for (let i = 0; i < group.length; i++) {
      const first = group[i]!;
      for (let j = i + 1; j < group.length; j++) {
        pairChecks++;
        if (pairChecks > MAX_NARRATIVE_ACTION_CLAIM_PAIR_CHECKS) {
          return findings.sort((a, b) => a.id.localeCompare(b.id));
        }
        const second = group[j]!;
        if (first.polarity === second.polarity ||
            (first.evidence.documentId === second.evidence.documentId &&
             first.evidence.revision === second.evidence.revision &&
             first.evidence.start === second.evidence.start &&
             first.evidence.end === second.evidence.end)) continue;
        const ordered = [first, second].sort((a, b) =>
          a.evidence.documentId.localeCompare(b.evidence.documentId) ||
          a.evidence.revision - b.evidence.revision ||
          a.evidence.start - b.evidence.start ||
          a.id.localeCompare(b.id)
        );
        const left = ordered[0]!;
        const right = ordered[1]!;
        const samePerspective = sameEpistemicPerspective(left, right);
        findings.push({
          id: "action-claim-disagreement:" + JSON.stringify([
            left.id, right.id, left.grammaticalSubjectCandidate!.entityId,
            left.action, left.grammaticalObjectCandidate?.entityId ?? null
          ]),
          projectId: input.projectId,
          subjectEntityId: left.grammaticalSubjectCandidate!.entityId,
          action: left.action,
          ...(left.grammaticalObjectCandidate
            ? { objectEntityId: left.grammaticalObjectCandidate.entityId } : {}),
          firstObservationId: left.id,
          secondObservationId: right.id,
          firstPolarity: left.polarity,
          secondPolarity: right.polarity,
          interpretation: samePerspective ? "same-epistemic-frame" : "different-epistemic-frame",
          firstEpistemicFrame: left.epistemicFrame,
          secondEpistemicFrame: right.epistemicFrame,
          ...(left.epistemicSourceCandidate
            ? { firstSourceEntityId: left.epistemicSourceCandidate.entityId } : {}),
          ...(right.epistemicSourceCandidate
            ? { secondSourceEntityId: right.epistemicSourceCandidate.entityId } : {}),
          evidence: [left.evidence, right.evidence],
          classification: "polarity-disagreement-candidate",
          reviewStatus: "candidate"
        });
        if (findings.length >= MAX_NARRATIVE_ACTION_CLAIM_FINDINGS) {
          return findings.sort((a, b) => a.id.localeCompare(b.id));
        }
      }
    }
  }
  return findings.sort((a, b) => a.id.localeCompare(b.id));
}
