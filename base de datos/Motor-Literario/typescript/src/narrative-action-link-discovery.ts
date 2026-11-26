import type { TextEvidence } from "./narrative-knowledge";
import type { NarrativeObservationCandidate } from "./narrative-observation-discovery";

/** Máxima distancia entre verbos para aceptar un marcador explícito intermedio. */
export const MAX_NARRATIVE_ACTION_LINK_GAP = 1_200;
export const MAX_NARRATIVE_ACTION_LINK_CANDIDATES = 200;

export interface NarrativeActionLinkCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly fromActionId: string;
  readonly toActionId: string;
  /** Describe el marcador observado; no afirma causalidad ni orden temporal del mundo narrado. */
  readonly markerKind: "temporal" | "causal" | "contrast";
  readonly marker: string;
  readonly evidence: TextEvidence;
  readonly reviewStatus: "candidate";
}

export interface NarrativeActionLinkDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly observations: readonly NarrativeObservationCandidate[];
  readonly baseOffset?: number;
}

const MARKERS: readonly {
  kind: NarrativeActionLinkCandidate["markerKind"];
  expression: RegExp;
}[] = [
  {
    kind: "temporal",
    expression: /\b(?:despu[eé]s|luego|entonces|mientras|antes|posteriormente|a\s+continuaci[oó]n|acto\s+seguido|poco\s+despu[eé]s|mucho\s+despu[eé]s|al\s+instante|de\s+inmediato|al\s+mismo\s+tiempo|simult[aá]neamente|al\s+d[ií]a\s+siguiente|esa\s+noche|esa\s+misma\s+tarde|a\s+la\s+ma[nñ]ana\s+siguiente|una\s+semana\s+despu[eé]s)\b/iu
  },
  {
    kind: "causal",
    expression: /\b(?:porque|ya\s+que|puesto\s+que|debido\s+a|a\s+causa\s+de|por\s+culpa\s+de|gracias\s+a|a\s+ra[ií]z\s+de|por\s+esta\s+raz[oó]n|por\s+esa\s+raz[oó]n|por\s+eso|por\s+lo\s+tanto|por\s+consiguiente|as[ií]\s+que|de\s+ah[ií]\s+que|de\s+modo\s+que|como\s+resultado|en\s+consecuencia)\b/iu
  },
  {
    kind: "contrast",
    expression: /\b(?:pero|sin\s+embargo|no\s+obstante|aunque|a[uú]n\s+as[ií]|a\s+pesar\s+de\s+ello|pese\s+a\s+ello|con\s+todo|en\s+cambio|por\s+el\s+contrario)\b/iu
  }
];

function validate(input: NarrativeActionLinkDiscoveryInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || !Array.isArray(input.observations) ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para descubrir vínculos entre acciones.");
  }
  const base = input.baseOffset ?? 0;
  const seenIds = new Set<string>();
  for (const item of input.observations) {
    const actionEvidence = item && typeof item === "object" ? item.actionEvidence : undefined;
    if (!item || typeof item !== "object" ||
        item.projectId !== input.projectId ||
        item.documentId !== input.documentId || item.revision !== input.revision ||
        item.kind !== "action" || typeof item.id !== "string" || !item.id.trim() ||
        seenIds.has(item.id) ||
        !actionEvidence || typeof actionEvidence !== "object" ||
        actionEvidence.documentId !== input.documentId ||
        actionEvidence.revision !== input.revision ||
        !Number.isSafeInteger(actionEvidence.start) ||
        !Number.isSafeInteger(actionEvidence.end) ||
        typeof actionEvidence.excerpt !== "string" ||
        actionEvidence.start < base ||
        actionEvidence.end > base + input.text.length ||
        actionEvidence.end <= actionEvidence.start ||
        input.text.slice(actionEvidence.start - base, actionEvidence.end - base) !==
          actionEvidence.excerpt) {
      throw new Error("Las observaciones deben pertenecer al mismo documento y revisión y conservar offsets verificables y únicos.");
    }
    seenIds.add(item.id);
  }
}

/**
 * Relaciona únicamente acciones consecutivas separadas por un marcador explícito.
 * La salida es una pista para revisión: «porque» no prueba qué acción causó cuál.
 */
export function discoverNarrativeActionLinks(
  input: NarrativeActionLinkDiscoveryInput
): readonly NarrativeActionLinkCandidate[] {
  validate(input);
  const base = input.baseOffset ?? 0;
  const ordered = [...input.observations].sort((a, b) =>
    a.actionEvidence.start - b.actionEvidence.start ||
    a.actionEvidence.end - b.actionEvidence.end
  );
  const result: NarrativeActionLinkCandidate[] = [];
  for (let index = 0; index + 1 < ordered.length; index++) {
    const from = ordered[index]!;
    const to = ordered[index + 1]!;
    const gapStart = from.actionEvidence.end;
    const gapEnd = to.actionEvidence.start;
    const gapLength = gapEnd - gapStart;
    if (gapLength <= 0 || gapLength > MAX_NARRATIVE_ACTION_LINK_GAP) continue;
    const gap = input.text.slice(gapStart - base, gapEnd - base);
    let selected: { kind: NarrativeActionLinkCandidate["markerKind"]; match: RegExpExecArray } | undefined;
    for (const marker of MARKERS) {
      marker.expression.lastIndex = 0;
      const match = marker.expression.exec(gap);
      if (match && (!selected || match.index < selected.match.index)) {
        selected = { kind: marker.kind, match };
      }
    }
    if (!selected) continue;
    const start = gapStart + selected.match.index;
    const end = start + selected.match[0].length;
    result.push({
      id: `action-link:${input.documentId}:${input.revision}:${from.id}:${to.id}:${start}`,
      projectId: input.projectId,
      documentId: input.documentId,
      revision: input.revision,
      fromActionId: from.id,
      toActionId: to.id,
      markerKind: selected.kind,
      marker: selected.match[0],
      evidence: {
        documentId: input.documentId,
        revision: input.revision,
        start,
        end,
        excerpt: selected.match[0]
      },
      reviewStatus: "candidate"
    });
    if (result.length >= MAX_NARRATIVE_ACTION_LINK_CANDIDATES) break;
  }
  return result;
}
