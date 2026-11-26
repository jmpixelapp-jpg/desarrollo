import type { NarrativeAssertion } from "./narrative-history";
import type { NarrativeTimeReference, TextEvidence } from "./narrative-knowledge";

/** Resultado explicable al comparar dos afirmaciones explícitas del mismo atributo. */
export interface NarrativeConsistencyFinding {
  readonly projectId: string;
  readonly id: string;
  readonly entityId: string;
  readonly entityName: string;
  readonly attribute: NarrativeAssertion["attribute"];
  readonly firstValue: string | number;
  readonly secondValue: string | number;
  readonly classification: "same-time-conflict" | "temporal-change" | "time-incomparable";
  readonly firstTimeReference?: NarrativeTimeReference;
  readonly secondTimeReference?: NarrativeTimeReference;
  readonly evidence: readonly [TextEvidence, TextEvidence];
  readonly explanation: string;
}

function sameValue(left: string | number, right: string | number): boolean {
  if (typeof left === "number" || typeof right === "number") return Object.is(left, right);
  return left.normalize("NFKC").trim().toLocaleLowerCase("es") ===
    right.normalize("NFKC").trim().toLocaleLowerCase("es");
}

function sameEvidence(left: TextEvidence, right: TextEvidence): boolean {
  return left.documentId === right.documentId &&
    left.revision === right.revision &&
    left.start === right.start &&
    left.end === right.end;
}

function sameInstant(
  left: NarrativeTimeReference,
  right: NarrativeTimeReference
): boolean {
  return left.basis === right.basis &&
    left.precision === right.precision &&
    left.orderValue === right.orderValue;
}

function comparableOrder(
  left: NarrativeTimeReference,
  right: NarrativeTimeReference
): number | undefined {
  if (left.basis !== right.basis) return undefined;
  return left.orderValue === right.orderValue ? 0 :
    left.orderValue < right.orderValue ? -1 : 1;
}

/**
 * Compara únicamente afirmaciones explícitas del mismo proyecto, entidad y atributo.
 *
 * - Mismo instante y distinto valor: conflicto candidato.
 * - Instantes comparables y distintos: evolución temporal, no contradicción.
 * - Referencias ausentes o calendarios incompatibles: requiere revisión; no se
 *   convierte automáticamente en contradicción.
 *
 * La función no resuelve cuál versión es canónica ni modifica el historial.
 */
export function analyzeNarrativeConsistency(
  projectId: string,
  assertions: readonly NarrativeAssertion[]
): readonly NarrativeConsistencyFinding[] {
  if (typeof projectId !== "string" || !projectId.trim() || !Array.isArray(assertions)) {
    throw new Error("Contexto de consistencia narrativa inválido.");
  }

  const scoped = assertions.filter(assertion => {
    if (!assertion || assertion.projectId !== projectId) return false;
    if (typeof assertion.entityId !== "string" || !assertion.entityId.trim() ||
        typeof assertion.entityName !== "string" || !assertion.entityName.trim() ||
        !["age", "location", "role"].includes(assertion.attribute) ||
        (typeof assertion.value !== "string" && typeof assertion.value !== "number") ||
        (typeof assertion.value === "number" && !Number.isFinite(assertion.value)) ||
        !assertion.evidence || typeof assertion.evidence.documentId !== "string" ||
        !Number.isSafeInteger(assertion.evidence.revision) ||
        !Number.isSafeInteger(assertion.evidence.start) ||
        !Number.isSafeInteger(assertion.evidence.end) ||
        assertion.evidence.start < 0 || assertion.evidence.end <= assertion.evidence.start ||
        typeof assertion.evidence.excerpt !== "string") {
      throw new Error("Afirmación narrativa inválida.");
    }
    return true;
  });

  const groups = new Map<string, NarrativeAssertion[]>();
  for (const assertion of scoped) {
    if (assertion.evidence.status === "stale") continue;
    const key = JSON.stringify([assertion.entityId, assertion.attribute]);
    const group = groups.get(key) ?? [];
    group.push(assertion);
    groups.set(key, group);
  }

  const findings: NarrativeConsistencyFinding[] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      const first = group[i]!;
      for (let j = i + 1; j < group.length; j++) {
        const second = group[j]!;
        if (sameEvidence(first.evidence, second.evidence) ||
            sameValue(first.value, second.value)) continue;

        const firstTime = first.timeReference;
        const secondTime = second.timeReference;
        let classification: NarrativeConsistencyFinding["classification"];
        let explanation: string;
        if (firstTime && secondTime && sameInstant(firstTime, secondTime)) {
          classification = "same-time-conflict";
          explanation = "Dos valores distintos se atribuyen a la misma entidad y atributo en la misma referencia temporal explícita.";
        } else if (firstTime && secondTime) {
          const order = comparableOrder(firstTime, secondTime);
          if (order === 0) {
            // Precisión distinta: por ejemplo, año frente a día. No se asume
            // que ambos registros describan exactamente el mismo instante.
            classification = "time-incomparable";
            explanation = "Las referencias temporales tienen distinta precisión y no permiten afirmar simultaneidad.";
          } else if (order !== undefined) {
            classification = "temporal-change";
            explanation = "Los valores difieren en referencias temporales ordenables; puede tratarse de una evolución narrativa legítima.";
          } else {
            classification = "time-incomparable";
            explanation = "Las referencias pertenecen a escalas temporales distintas y no se pueden ordenar entre sí.";
          }
        } else {
          classification = "time-incomparable";
          explanation = "Falta una referencia temporal explícita en al menos una afirmación; no se puede determinar si los valores coexisten.";
        }

        const ordered = [first, second].sort((a, b) =>
          a.evidence.documentId.localeCompare(b.evidence.documentId) ||
          a.evidence.revision - b.evidence.revision ||
          a.evidence.start - b.evidence.start
        );
        const left = ordered[0]!;
        const right = ordered[1]!;
        findings.push({
          projectId,
          id: "consistency:" + JSON.stringify([
            left.entityId, left.attribute, left.evidence.documentId,
            left.evidence.revision, left.evidence.start,
            right.evidence.documentId, right.evidence.revision, right.evidence.start
          ]),
          entityId: left.entityId,
          entityName: left.entityName,
          attribute: left.attribute,
          firstValue: left.value,
          secondValue: right.value,
          classification,
          ...(left.timeReference ? { firstTimeReference: left.timeReference } : {}),
          ...(right.timeReference ? { secondTimeReference: right.timeReference } : {}),
          evidence: [left.evidence, right.evidence],
          explanation
        });
      }
    }
  }
  return findings.sort((a, b) => a.id.localeCompare(b.id));
}
