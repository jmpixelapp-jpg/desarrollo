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


/** Evento con participantes ya extraídos explícitamente; no resuelve pronombres. */
export interface NarrativeSceneContinuityEvent {
  readonly projectId: string;
  readonly id: string;
  readonly participants: readonly string[];
  readonly evidence: readonly {
    readonly documentId: string;
    readonly revision: number;
    readonly start: number;
    readonly end: number;
    readonly excerpt: string;
  }[];
}

/** Apariciones verificadas de un personaje a través de escenas explícitas. */
export interface NarrativeCharacterSceneContinuity {
  readonly projectId: string;
  readonly characterId: string;
  readonly sceneIds: readonly string[];
  readonly eventIds: readonly string[];
  readonly appearanceCount: number;
  readonly firstSceneOrdinal: number;
  readonly lastSceneOrdinal: number;
}

/**
 * Construye continuidad observable entre escenas a partir de participantes
 * explícitos de eventos. Un evento solo cuenta si toda su evidencia queda en
 * una misma escena; nunca se infiere identidad a partir de pronombres.
 */
export function buildNarrativeCharacterSceneContinuity(
  events: readonly NarrativeSceneContinuityEvent[],
  scenes: readonly NarrativeSceneSegment[]
): readonly NarrativeCharacterSceneContinuity[] {
  if (!Array.isArray(events) || !Array.isArray(scenes)) {
    throw new Error("Eventos o escenas inválidos para continuidad narrativa.");
  }
  const sceneById = new Map<string, NarrativeSceneSegment>();
  for (const scene of scenes) {
    if (!scene || typeof scene.id !== "string" || !scene.id ||
        typeof scene.projectId !== "string" || !scene.projectId ||
        typeof scene.documentId !== "string" || !scene.documentId ||
        !Number.isSafeInteger(scene.revision) || scene.revision < 0 ||
        !Number.isSafeInteger(scene.ordinal) || scene.ordinal < 1 ||
        sceneById.has(scene.id)) {
      throw new Error("La colección contiene una escena inválida o duplicada.");
    }
    sceneById.set(scene.id, scene);
  }

  const appearances = new Map<string, {
    projectId: string;
    characterId: string;
    sceneIds: Set<string>;
    eventIds: Set<string>;
    ordinals: number[];
  }>();
  const seenEvents = new Set<string>();

  for (const event of events) {
    if (!event || typeof event.projectId !== "string" || !event.projectId ||
        typeof event.id !== "string" || !event.id ||
        !Array.isArray(event.participants) ||
        event.participants.some(id => typeof id !== "string" || !id) ||
        !Array.isArray(event.evidence)) {
      throw new Error("Evento inválido para continuidad narrativa.");
    }
    const eventKey = event.projectId + ":" + event.id;
    if (seenEvents.has(eventKey)) throw new Error("Evento duplicado en continuidad narrativa.");
    seenEvents.add(eventKey);
    if (event.evidence.length === 0 || event.participants.length === 0) continue;

    const assignments = event.evidence.map(evidence =>
      assignNarrativeEvidenceToScene({ evidence }, scenes)
    );
    if (assignments.some(item => item.sceneAssignment !== "explicit")) continue;
    const sceneIds = new Set(assignments.map(item => item.sceneId!));
    if (sceneIds.size !== 1) continue;
    const scene = sceneById.get([...sceneIds][0]!);
    if (!scene || scene.projectId !== event.projectId ||
        event.evidence.some(evidence =>
          evidence.documentId !== scene.documentId || evidence.revision !== scene.revision
        )) continue;

    for (const characterId of new Set(event.participants)) {
      const key = event.projectId + ":" + characterId;
      const current = appearances.get(key) ?? {
        projectId: event.projectId,
        characterId,
        sceneIds: new Set<string>(),
        eventIds: new Set<string>(),
        ordinals: []
      };
      if (!current.eventIds.has(event.id)) {
        current.eventIds.add(event.id);
        current.sceneIds.add(scene.id);
        current.ordinals.push(scene.ordinal);
      }
      appearances.set(key, current);
    }
  }

  return [...appearances.values()]
    .map(item => {
      const orderedSceneIds = [...item.sceneIds].sort((a, b) =>
        (sceneById.get(a)?.ordinal ?? 0) - (sceneById.get(b)?.ordinal ?? 0)
      );
      const ordinals = [...item.ordinals].sort((a, b) => a - b);
      return {
        projectId: item.projectId,
        characterId: item.characterId,
        sceneIds: orderedSceneIds,
        eventIds: [...item.eventIds],
        appearanceCount: item.eventIds.size,
        firstSceneOrdinal: ordinals[0]!,
        lastSceneOrdinal: ordinals[ordinals.length - 1]!
      };
    })
    .sort((a, b) => a.projectId.localeCompare(b.projectId) ||
      a.characterId.localeCompare(b.characterId));
}
