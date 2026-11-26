/**
 * Segmentación conservadora de escenas usando únicamente encabezados explícitos.
 *
 * No deduce cambios de escena por párrafos, personajes, lugares o cambios de tono.
 * Los rangos son UTF-16 absolutos y el cuerpo de una escena comienza después
 * de su encabezado. El texto anterior al primer encabezado queda sin asignar.
 */

export const MAX_NARRATIVE_SCENES = 500;
const MAX_TEXT_UNITS = 2_000_000;
const MAX_HEADING_UNITS = 200;

export interface NarrativeSceneSegmentationInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly baseOffset?: number;
}

export interface NarrativeSceneSegment {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly ordinal: number;
  readonly heading: string;
  readonly headingKind: "scene-marker" | "screenplay";
  readonly headingEvidence: {
    readonly start: number;
    readonly end: number;
    readonly excerpt: string;
  };
  /** Cuerpo, sin el encabezado. */
  readonly content: {
    readonly start: number;
    readonly end: number;
    readonly excerpt: string;
  };
}

export interface NarrativeSceneAssignment {
  readonly sceneId?: string;
  readonly sceneAssignment: "explicit" | "unassigned" | "crosses-boundary";
}

function validate(input: NarrativeSceneSegmentationInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_TEXT_UNITS ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para segmentar escenas narrativas.");
  }
}

/**
 * Reconoce encabezados deliberados:
 * - ESCENA, ESCENA 3, ESCENA: La llegada
 * - encabezados Markdown ## Escena ...
 * - encabezados de guion INT./EXT. ...
 */
export function segmentNarrativeScenes(
  input: NarrativeSceneSegmentationInput
): readonly NarrativeSceneSegment[] {
  validate(input);
  const base = input.baseOffset ?? 0;
  const headings: Array<{start:number; end:number; heading:string; kind:"scene-marker"|"screenplay"}> = [];
  const linePattern = /[^\r\n]*(?:\r?\n|$)/gu;
  for (const lineMatch of input.text.matchAll(linePattern)) {
    const line = lineMatch[0];
    if (!line) continue;
    const content = line.replace(/\r?\n$/u, "");
    const leading = content.search(/\S/u);
    if (leading < 0) continue;
    const trimmed = content.trim();
    const marker = /^(?:#{1,6}\s*)?ESCENA(?:\s+\d+)?(?:\s*[:—-]\s*.*)?$/iu.test(trimmed);
    const screenplay = /^(?:INT\.|EXT\.|INT\/EXT\.)\s+.{1,180}$/iu.test(trimmed);
    if (!marker && !screenplay) continue;
    if (trimmed.length > MAX_HEADING_UNITS) continue;
    const start = lineMatch.index + leading;
    const end = lineMatch.index + content.length;
    headings.push({
      start, end, heading: trimmed,
      kind: screenplay ? "screenplay" : "scene-marker"
    });
    if (headings.length >= MAX_NARRATIVE_SCENES) break;
  }

  return headings.map((heading, index) => {
    const next = headings[index + 1];
    const contentStart = heading.end + (input.text[heading.end] === "\r" ? 2 :
      input.text[heading.end] === "\n" ? 1 : 0);
    const contentEnd = next?.start ?? input.text.length;
    const id = "scene:" + input.documentId + ":" + (base + heading.start);
    return {
      id, projectId: input.projectId, documentId: input.documentId,
      revision: input.revision, ordinal: index + 1,
      heading: heading.heading, headingKind: heading.kind,
      headingEvidence: {
        start: base + heading.start, end: base + heading.end,
        excerpt: input.text.slice(heading.start, heading.end)
      },
      content: {
        start: base + contentStart, end: base + contentEnd,
        excerpt: input.text.slice(contentStart, contentEnd)
      }
    };
  });
}

/**
 * Asigna una evidencia solo si queda completamente dentro del cuerpo de una
 * única escena explícita. Una evidencia que cruza encabezados queda sin asignar.
 */
export function assignNarrativeEvidenceToScene<
  T extends { readonly evidence: { readonly start: number; readonly end: number; readonly excerpt: string } }
>(
  candidate: T,
  scenes: readonly NarrativeSceneSegment[]
): T & NarrativeSceneAssignment {
  const { start, end } = candidate.evidence;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new Error("Rango de evidencia inválido para asignar escena.");
  }
  const matches = scenes.filter(scene =>
    start >= scene.content.start && end <= scene.content.end
  );
  if (matches.length === 1) {
    return { ...candidate, sceneId: matches[0]!.id, sceneAssignment: "explicit" };
  }
  const overlaps = scenes.some(scene => start < scene.content.end && end > scene.content.start);
  return {
    ...candidate,
    sceneAssignment: overlaps ? "crosses-boundary" : "unassigned"
  };
}
