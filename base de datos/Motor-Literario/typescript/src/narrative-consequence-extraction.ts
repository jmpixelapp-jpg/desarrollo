/**
 * Detecta conectores lingüísticos explícitos que presentan un acontecimiento
 * como consecuencia de otro. El resultado siempre es candidato revisable:
 * no prueba causalidad objetiva ni sustituye el juicio del escritor.
 */
import type { NarrativeEventCandidate } from "./narrative-event-extraction";

export interface NarrativeConsequenceExtractionInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly events: readonly NarrativeEventCandidate[];
}

export interface NarrativeConsequenceCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly sourceEventId: string;
  readonly consequenceEventId: string;
  readonly relationType: "explicit-consequence-marker";
  readonly marker: string;
  readonly reviewStatus: "candidate";
  readonly evidence: {
    readonly documentId: string;
    readonly revision: number;
    /** Rango UTF-16 absoluto del conector dentro del documento. */
    readonly start: number;
    readonly end: number;
    readonly excerpt: string;
  };
}

export const MAX_NARRATIVE_CONSEQUENCES = 200;
const MAX_TEXT_UNITS = 2_000_000;

const CONNECTORS = [
  "como consecuencia de ello",
  "a consecuencia de ello",
  "como resultado de ello",
  "por consiguiente",
  "en consecuencia",
  "como consecuencia",
  "a consecuencia",
  "como resultado",
  "por lo tanto",
  "por esa razón",
  "por ese motivo",
  "por eso",
  "por ello",
  "de ahí que",
  "así que"
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function validate(input: NarrativeConsequenceExtractionInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_TEXT_UNITS ||
      !Array.isArray(input.events) || input.events.length > 1000) {
    throw new Error("Contexto inválido para extraer consecuencias narrativas.");
  }
  for (const event of input.events) {
    if (!event || !event.evidence || event.projectId !== input.projectId ||
        event.evidence.documentId !== input.documentId ||
        event.evidence.revision !== input.revision ||
        !Number.isSafeInteger(event.evidence.start) ||
        !Number.isSafeInteger(event.evidence.end) ||
        event.evidence.start < 0 || event.evidence.end < event.evidence.start ||
        event.evidence.end > input.text.length ||
        input.text.slice(event.evidence.start, event.evidence.end) !== event.evidence.excerpt) {
      throw new Error("Los acontecimientos deben pertenecer al mismo documento y revisión.");
    }
  }
}

/**
 * Vincula acontecimientos consecutivos solo cuando el segundo comienza con
 * un conector explícito de consecuencia. No resuelve pronombres ni causalidad
 * implícita y nunca confirma automáticamente la relación.
 */
export function extractNarrativeConsequenceCandidates(
  input: NarrativeConsequenceExtractionInput
): readonly NarrativeConsequenceCandidate[] {
  validate(input);
  const events = [...input.events].sort((a, b) =>
    a.evidence.start - b.evidence.start || a.id.localeCompare(b.id)
  );
  const connectorPattern = new RegExp(
    "^\\s*(?:[«(]+\\s*)?(" +
      [...CONNECTORS].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|") +
      ")(?=\\s|[,;:.!?—–-]|$)",
    "iu"
  );
  const results: NarrativeConsequenceCandidate[] = [];
  for (let index = 1; index < events.length && results.length < MAX_NARRATIVE_CONSEQUENCES; index++) {
    const source = events[index - 1];
    const consequence = events[index];
    if (source.evidence.end > consequence.evidence.start) continue;
    // Un salto de párrafo suele marcar cambio de escena o bloque narrativo;
    // no se debe enlazar a través de ese límite aunque aparezca un conector.
    const gap = input.text.slice(source.evidence.end, consequence.evidence.start);
    if (/\\r?\\n[\\t ]*\\r?\\n/u.test(gap)) continue;
    const match = connectorPattern.exec(consequence.evidence.excerpt);
    if (!match) continue;
    const excerpt = match[1];
    const local = consequence.evidence.excerpt.indexOf(excerpt);
    const start = consequence.evidence.start + local;
    const end = start + excerpt.length;
    results.push({
      id: "consequence:" + input.documentId + ":" + start + ":" +
        source.id + ":" + consequence.id,
      projectId: input.projectId,
      sourceEventId: source.id,
      consequenceEventId: consequence.id,
      relationType: "explicit-consequence-marker",
      marker: excerpt,
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
  return results;
}
