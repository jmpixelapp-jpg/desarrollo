/**
 * Reconstruye enlaces textuales entre acciones sucesivas, incluso a través
 * de varios párrafos. Los enlaces son candidatos y no prueban causalidad.
 */
import type { NarrativeObservationCandidate } from "./narrative-observation-discovery";
import type { TextEvidence } from "./narrative-knowledge";

export type NarrativeEventChainMarkerKind = "temporal" | "causal" | "contrast";

export interface NarrativeEventChainLinkCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly fromActionId: string;
  readonly toActionId: string;
  readonly markerKind: NarrativeEventChainMarkerKind;
  readonly marker: string;
  readonly markerEvidence: TextEvidence;
  /** Texto exacto entre las dos acciones; permite inspeccionar el puente completo. */
  readonly bridgeEvidence: TextEvidence;
  /** Personajes nombrados en ambas acciones; mención compartida, no rol sintáctico. */
  readonly sharedCharacterIds: readonly string[];
  readonly paragraphBreakCount: number;
  readonly gapLength: number;
  readonly reviewStatus: "candidate";
}

export interface NarrativeEventChainDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly observations: readonly NarrativeObservationCandidate[];
  readonly baseOffset?: number;
}

export const MAX_NARRATIVE_EVENT_CHAIN_GAP = 5_000;
export const MAX_NARRATIVE_EVENT_CHAIN_LINKS = 500;

const MARKERS: readonly {
  readonly kind: NarrativeEventChainMarkerKind;
  readonly expression: RegExp;
}[] = [
  {
    kind: "temporal",
    expression: /(?<![\p{L}\p{M}\p{N}_])(?:despu[eé]s|luego|entonces|mientras|antes|posteriormente|a\s+continuaci[oó]n|acto\s+seguido|poco\s+despu[eé]s|mucho\s+despu[eé]s|al\s+instante|de\s+inmediato|al\s+mismo\s+tiempo|simult[aá]neamente|al\s+d[ií]a\s+siguiente|esa\s+noche|esa\s+misma\s+tarde|a\s+la\s+ma[nñ]ana\s+siguiente|una\s+semana\s+despu[eé]s)(?![\p{L}\p{M}\p{N}_])/iu
  },
  {
    kind: "causal",
    expression: /(?<![\p{L}\p{M}\p{N}_])(?:porque|ya\s+que|puesto\s+que|debido\s+a|a\s+causa\s+de|por\s+culpa\s+de|gracias\s+a|a\s+ra[ií]z\s+de|por\s+esta\s+raz[oó]n|por\s+esa\s+raz[oó]n|por\s+eso|por\s+lo\s+tanto|por\s+consiguiente|as[ií]\s+que|de\s+ah[ií]\s+que|de\s+modo\s+que|como\s+resultado|en\s+consecuencia)(?![\p{L}\p{M}\p{N}_])/iu
  },
  {
    kind: "contrast",
    expression: /(?<![\p{L}\p{M}\p{N}_])(?:pero|sin\s+embargo|no\s+obstante|aunque|a[uú]n\s+as[ií]|a\s+pesar\s+de\s+ello|pese\s+a\s+ello|con\s+todo|en\s+cambio|por\s+el\s+contrario)(?![\p{L}\p{M}\p{N}_])/iu
  }
];

function evidenceIsExact(
  evidence: TextEvidence,
  input: NarrativeEventChainDiscoveryInput,
  base: number
): boolean {
  return !!evidence &&
    evidence.documentId === input.documentId &&
    evidence.revision === input.revision &&
    Number.isSafeInteger(evidence.start) &&
    Number.isSafeInteger(evidence.end) &&
    evidence.start >= base &&
    evidence.end > evidence.start &&
    evidence.end <= base + input.text.length &&
    typeof evidence.excerpt === "string" &&
    evidence.end - evidence.start === evidence.excerpt.length &&
    input.text.slice(evidence.start - base, evidence.end - base) === evidence.excerpt &&
    evidence.status !== "stale";
}

function validate(input: NarrativeEventChainDiscoveryInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" ||
      input.text.length > MAX_NARRATIVE_EVENT_CHAIN_GAP * MAX_NARRATIVE_EVENT_CHAIN_LINKS ||
      !Array.isArray(input.observations) ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para reconstruir cadenas de acontecimientos.");
  }

  const base = input.baseOffset ?? 0;
  const ids = new Set<string>();
  for (const observation of input.observations) {
    if (!observation ||
        observation.projectId !== input.projectId ||
        observation.documentId !== input.documentId ||
        observation.revision !== input.revision ||
        observation.kind !== "action" ||
        typeof observation.id !== "string" || !observation.id.trim() ||
        ids.has(observation.id) ||
        !evidenceIsExact(observation.actionEvidence, input, base) ||
        !Array.isArray(observation.mentionedCharacterIds) ||
        observation.mentionedCharacterIds.some(id => typeof id !== "string" || !id.trim())) {
      throw new Error("Las acciones deben tener identidad única y evidencia literal verificable en el mismo documento y revisión.");
    }
    ids.add(observation.id);
  }
}

/**
 * Considera acciones consecutivas y busca un conector explícito en el puente.
 * No salta acciones intermedias: cada enlace representa una adyacencia textual.
 */
export function discoverNarrativeEventChainLinks(
  input: NarrativeEventChainDiscoveryInput
): readonly NarrativeEventChainLinkCandidate[] {
  validate(input);
  const base = input.baseOffset ?? 0;
  const ordered = [...input.observations].sort((a, b) =>
    a.actionEvidence.start - b.actionEvidence.start ||
    a.actionEvidence.end - b.actionEvidence.end
  );
  const result: NarrativeEventChainLinkCandidate[] = [];

  for (let index = 0; index + 1 < ordered.length; index++) {
    const from = ordered[index]!;
    const to = ordered[index + 1]!;
    const start = from.actionEvidence.end;
    const end = to.actionEvidence.start;
    const gapLength = end - start;
    if (gapLength <= 0 || gapLength > MAX_NARRATIVE_EVENT_CHAIN_GAP) continue;

    const bridge = input.text.slice(start - base, end - base);
    let selected: { kind: NarrativeEventChainMarkerKind; match: RegExpExecArray } | undefined;
    for (const marker of MARKERS) {
      marker.expression.lastIndex = 0;
      const match = marker.expression.exec(bridge);
      if (match && (!selected || match.index < selected.match.index)) {
        selected = { kind: marker.kind, match };
      }
    }
    if (!selected) continue;

    const markerStart = start + selected.match.index;
    const markerEnd = markerStart + selected.match[0].length;
    const sharedCharacterIds = [...new Set(from.mentionedCharacterIds)]
      .filter(id => to.mentionedCharacterIds.includes(id))
      .sort();
    const paragraphBreakCount = (bridge.match(/\r?\n\s*\r?\n/g) ?? []).length;

    result.push({
      id: "event-chain:" + input.documentId + ":" + input.revision + ":" +
        from.id + ":" + to.id + ":" + markerStart,
      projectId: input.projectId,
      documentId: input.documentId,
      revision: input.revision,
      fromActionId: from.id,
      toActionId: to.id,
      markerKind: selected.kind,
      marker: selected.match[0],
      markerEvidence: {
        documentId: input.documentId,
        revision: input.revision,
        start: markerStart,
        end: markerEnd,
        excerpt: selected.match[0]
      },
      bridgeEvidence: {
        documentId: input.documentId,
        revision: input.revision,
        start,
        end,
        excerpt: bridge
      },
      sharedCharacterIds,
      paragraphBreakCount,
      gapLength,
      reviewStatus: "candidate"
    });
    if (result.length >= MAX_NARRATIVE_EVENT_CHAIN_LINKS) break;
  }
  return result;
}
