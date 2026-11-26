/** Conocimiento narrativo aislado por proyecto y respaldado por evidencia textual. */

/** Tipo abierto: la extracción automática reconoce algunos tipos, pero el escritor puede registrar otros. */
export type NarrativeEntityType = string;
export type NarrativeKnowledgeKind = NarrativeEntityType | "event" | "relationship" | "idea";

/** Máximo de vínculos explícitos por idea, tanto a fichas como a otras ideas. */
export const MAX_NARRATIVE_IDEA_REFERENCES = 500;

export interface TextEvidence {
  readonly documentId: string;
  readonly revision: number;
  /** Rangos UTF-16 absolutos dentro del documento. */
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
  /** Evidencia histórica cuyo fragmento de línea fue afectado por una edición posterior. */
  readonly status?: "stale";
}

/** Clave de evidencia completa: las revisiones y el estado histórico nunca se colapsan entre sí. */
function evidenceIdentityKey(item: TextEvidence): string {
  return JSON.stringify([
    item.documentId, item.revision, item.start, item.end, item.excerpt, item.status ?? null
  ]);
}

export interface NarrativeEntity {
  readonly projectId: string;
  readonly id: string;
  readonly kind: NarrativeEntityType;
  readonly canonicalName: string;
  readonly normalizedName: string;
  readonly aliases: readonly string[];
  /** IDs de fichas consolidadas en esta identidad; preserva procedencia. */
  readonly mergedFromIds?: readonly string[];
  readonly evidence: readonly TextEvidence[];
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly extractionVersion: 1;
}

export interface NarrativeEntityIdentityCandidate {
  readonly projectId: string;
  readonly firstEntityId: string;
  readonly secondEntityId: string;
  readonly kind: NarrativeEntityType;
  readonly reason: "same-canonical-name" | "confirmed-name-overlap";
  readonly matchedName: string;
}

/**
 * Señala posibles duplicados solo por igualdad normalizada de nombres explícitos.
 * No fusiona registros ni usa semejanza fonética/ortográfica.
 */
export function findNarrativeEntityIdentityCandidates(
  projectId: string,
  entities: readonly NarrativeEntity[]
): readonly NarrativeEntityIdentityCandidate[] {
  const scoped = entities.filter(entity => entity.projectId === projectId);
  const candidates = new Map<string, NarrativeEntityIdentityCandidate>();
  for (let i = 0; i < scoped.length; i++) {
    const first = scoped[i]!;
    for (let j = i + 1; j < scoped.length; j++) {
      const second = scoped[j]!;
      if (first.id === second.id || first.kind !== second.kind) continue;
      const firstCanonical = normalizeEntityName(first.canonicalName);
      const secondCanonical = normalizeEntityName(second.canonicalName);
      let reason: NarrativeEntityIdentityCandidate["reason"] | undefined;
      let matchedName = "";
      if (firstCanonical === secondCanonical) {
        reason = "same-canonical-name";
        matchedName = first.canonicalName;
      } else {
        const firstNames = new Set([first.canonicalName, ...first.aliases].map(normalizeEntityName));
        const overlap = [second.canonicalName, ...second.aliases]
          .find(name => firstNames.has(normalizeEntityName(name)));
        if (overlap) {
          reason = "confirmed-name-overlap";
          matchedName = overlap;
        }
      }
      if (!reason) continue;
      const sortedEntityIds = [first.id, second.id].sort();
      const firstEntityId = sortedEntityIds[0]!;
      const secondEntityId = sortedEntityIds[1]!;
      const key = [firstEntityId, secondEntityId].join(":");
      candidates.set(key, {
        projectId, firstEntityId, secondEntityId, kind: first.kind, reason, matchedName
      });
    }
  }
  return [...candidates.values()].sort((a, b) =>
    a.firstEntityId.localeCompare(b.firstEntityId) || a.secondEntityId.localeCompare(b.secondEntityId)
  );
}


export interface NarrativeRelation {
  readonly projectId: string;
  readonly id: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly relationType: string;
  readonly evidence: readonly TextEvidence[];
}

export interface NarrativeTimeReference {
  /** calendar: fecha/año explícitos; story-day: contador de día explícito del mundo narrativo. */
  readonly basis: "calendar" | "story-day";
  readonly precision: "date" | "year" | "day-index";
  readonly raw: string;
  /** Día UTC ordinal para calendar o número de día para story-day. */
  readonly orderValue: number;
}

export interface NarrativeEvent {
  readonly projectId: string;
  readonly id: string;
  readonly label: string;
  readonly participants: readonly string[];
  readonly evidence: readonly TextEvidence[];
  /** Pista cronológica elegida explícitamente por el escritor; nunca se infiere. */
  readonly timelineTrackId?: string;
  /** Ausente cuando el texto no proporciona una referencia temporal explícita. */
  readonly timeReference?: NarrativeTimeReference;
}

export interface NarrativeIdeaStatusChange {
  readonly status: "IDEA" | "incorporated" | "discarded";
  /** Epoch milliseconds; ausente en estados importados cuyo momento se desconoce. */
  readonly changedAt?: number;
  readonly reason: "initial" | "writer" | "text-revised";
}

/**
 * Devuelve una marca temporal que no retrocede respecto del historial conocido.
 * Es útil al importar decisiones desde equipos con relojes desincronizados.
 */
export function nextNarrativeIdeaStatusChangeAt(
  statusHistory: readonly NarrativeIdeaStatusChange[],
  now = Date.now()
): number {
  if (!Array.isArray(statusHistory) || !Number.isFinite(now) || now < 0) {
    throw new Error("Historial o reloj de decisiones narrativas inválido.");
  }
  let latestKnownAt = 0;
  for (const change of statusHistory) {
    if (!change || typeof change !== "object" ||
        !["IDEA", "incorporated", "discarded"].includes(change.status) ||
        !["initial", "writer", "text-revised"].includes(change.reason)) {
      throw new Error("El historial contiene una decisión narrativa inválida.");
    }
    if (change.changedAt !== undefined) {
      if (typeof change.changedAt !== "number" ||
          !Number.isFinite(change.changedAt) || change.changedAt < 0) {
        throw new Error("El historial contiene una marca temporal inválida.");
      }
      latestKnownAt = Math.max(latestKnownAt, change.changedAt);
    }
  }
  return Math.max(now, latestKnownAt);
}

export interface NarrativeIdea {
  readonly projectId: string;
  readonly id: string;
  readonly text: string;
  readonly status: "IDEA" | "incorporated" | "discarded";
  readonly originDocumentId: string;
  readonly sourceProjectName: string;
  readonly evidence: readonly TextEvidence[];
  /** Referencias explícitas a fichas narrativas del mismo libro; máximo MAX_NARRATIVE_IDEA_REFERENCES. */
  readonly relatedEntityIds?: readonly string[];
  /** Enlaces explícitos a otras ideas del mismo libro; máximo MAX_NARRATIVE_IDEA_REFERENCES. */
  readonly relatedIdeaIds?: readonly string[];
  /** Historial inmutable de transiciones de estado, separado de las revisiones del texto. */
  readonly statusHistory?: readonly NarrativeIdeaStatusChange[];
}

/**
 * Contexto privado que permite resolver los vínculos de una idea archivada
 * aunque el libro de origen ya no esté disponible.
 *
 * Las ideas todavía en IDEA se resuelven mediante sus propias entradas de
 * biblioteca; aquí se conservan instantáneas de las ideas relacionadas que
 * permanecieron en el libro y de las fichas de entidad enlazadas.
 */
export interface PersonalIdeaLibraryContext {
  readonly version: 1;
  readonly relatedIdeas: readonly NarrativeIdea[];
  readonly relatedEntities: readonly NarrativeEntity[];
}

/** Idea no incorporada transferida a la biblioteca privada del escritor. */
export interface PersonalIdeaLibraryEntry {
  readonly writerId: string;
  readonly sourceProjectId: string;
  readonly sourceProjectName: string;
  /** Categoría elegida a partir del título que entregó el anfitrión. */
  readonly category: string;
  readonly idea: NarrativeIdea;
  /**
   * Instantáneas de contexto capturadas junto con la transferencia.
   * Opcional únicamente para leer entradas antiguas creadas antes de esta
   * capacidad; todas las nuevas transferencias deben incluir la versión 1.
   */
  readonly context?: PersonalIdeaLibraryContext;
  /** La API marca explícitamente entradas antiguas cuyos vínculos no tienen instantáneas. */
  readonly contextStatus?: "missing-legacy-context";
  readonly archivedAt: number;
}

export interface NarrativeKnowledgeStore {
  saveEntity(entity: NarrativeEntity): Promise<void>;
  loadEntities(projectId: string): Promise<readonly NarrativeEntity[]>;
}

function validateNarrativeExtractionContext(
  projectId: string,
  documentId: string,
  revision: number,
  text: string,
  baseOffset: number,
  entities?: readonly NarrativeEntity[],
  now?: number
): void {
  if (typeof projectId !== "string" || !projectId.trim() ||
      typeof documentId !== "string" || !documentId.trim() ||
      !Number.isSafeInteger(revision) || revision < 0 ||
      typeof text !== "string" ||
      !Number.isSafeInteger(baseOffset) || baseOffset < 0 ||
      baseOffset > Number.MAX_SAFE_INTEGER - text.length ||
      (now !== undefined && (!Number.isFinite(now) || now < 0)) ||
      (entities !== undefined && !Array.isArray(entities))) {
    throw new Error("Contexto de extracción narrativa inválido.");
  }
  if (!entities) return;
  for (const entity of entities) {
    if (!entity || entity.projectId !== projectId ||
        typeof entity.id !== "string" || !entity.id.trim() ||
        (typeof entity.kind !== "string" || !entity.kind.trim() || entity.kind.length > 128) ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        typeof entity.normalizedName !== "string" || !entity.normalizedName.trim() ||
        !Array.isArray(entity.aliases) ||
        entity.aliases.some((alias: unknown) => typeof alias !== "string" || !alias.trim())) {
      throw new Error("Colección de entidades inválida o perteneciente a otro proyecto.");
    }
  }
}

/** Extractor deliberadamente conservador: solo reconoce nombres tras indicadores explícitos. */
export function extractNarrativeEntities(
  projectId: string,
  documentId: string,
  revision: number,
  text: string,
  now = Date.now(),
  baseOffset = 0
): readonly NarrativeEntity[] {
  validateNarrativeExtractionContext(projectId, documentId, revision, text, baseOffset, undefined, now);

  if (!/\b(?:personaje|protagonista|antagonista|ciudad|pueblo|aldea|reino|castillo|bosque|montaña|lugar|objeto|espada|arma|reliquia|amuleto|anillo|libro)\b/u.test(text)) {
    return [];
  }
  const name = "[A-ZÁÉÍÓÚÜÑ][\\p{L}\\p{M}]+(?:[ \\u00a0]+(?:de[ \\u00a0]+(?:la|las|los)|de|del|la|las|los|el|y|san|santa)?[ \\u00a0]*[A-ZÁÉÍÓÚÜÑ][\\p{L}\\p{M}]+){0,3}";
  const prefixCharacter = String.raw`\b(?:personaje|protagonista|antagonista)\s+(?:el|la|a)?\s*`;
  const prefixPlace = String.raw`\b(?:ciudad|pueblo|aldea|reino|castillo|bosque|montaña|lugar)\s+(?:de|del|de la|de los|de las)?\s*`;
  const prefixObject = String.raw`\b(?:objeto|espada|arma|reliquia|amuleto|anillo|libro)\s+(?:llamado|llamada)?\s*`;
  const suffix = String.raw`(?=$|[^\p{L}\p{N}_])`;
  const patterns: readonly { kind: NarrativeEntityType; expression: RegExp }[] = [
    { kind: "character", expression: new RegExp(prefixCharacter + "(" + name + ")" + suffix, "gu") },
    { kind: "place", expression: new RegExp(prefixPlace + "(" + name + ")" + suffix, "gu") },
    { kind: "object", expression: new RegExp(prefixObject + "(" + name + ")" + suffix, "gu") }
  ];
  const scanText = text + "_";
  const grouped = new Map<string, { kind: NarrativeEntityType; name: string; evidence: TextEvidence[] }>();
  for (const { kind, expression } of patterns) {
    expression.lastIndex = 0;
    for (const match of scanText.matchAll(expression)) {
      const name = match[1]?.trim();
      if (!name) continue;
      const relativeStart = match.index + match[0].lastIndexOf(name);
      const start = baseOffset + relativeStart;
      const end = start + name.length;
      const normalizedName = normalizeEntityName(name);
      const key = kind + ":" + normalizedName;
      const entry = grouped.get(key) ?? { kind, name, evidence: [] };
      const localStart = start - baseOffset;
      const localEnd = end - baseOffset;
      const lineStart = text.lastIndexOf("\n", localStart - 1) + 1;
      const lineBreak = text.indexOf("\n", localEnd);
      const lineEnd = lineBreak < 0 ? text.length : lineBreak;
      entry.evidence.push({
        documentId, revision, start, end, excerpt: text.slice(lineStart, lineEnd)
      });
      grouped.set(key, entry);
    }
  }

  return [...grouped.entries()].map(([key, entry]) => ({
    projectId,
    id: "entity:" + key,
    kind: entry.kind,
    canonicalName: entry.name,
    normalizedName: normalizeEntityName(entry.name),
    aliases: [],
    evidence: entry.evidence,
    firstSeenAt: now,
    lastSeenAt: now,
    extractionVersion: 1 as const
  }));
}

export function normalizeEntityName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es");
}

/** Compara un nombre literal con el nombre canónico o un alias confirmado. */
export function entityMatchesName(entity: NarrativeEntity, candidate: string): boolean {
  const normalized = normalizeEntityName(candidate);
  return normalized === entity.normalizedName ||
    entity.aliases.some(alias => normalizeEntityName(alias) === normalized);
}


/** Fusiona evidencias sin duplicar la misma ocurrencia del texto. */
export function mergeNarrativeEntity(
  previous: NarrativeEntity | undefined,
  incoming: NarrativeEntity
): NarrativeEntity {
  if (!previous) return incoming;
  if (previous.projectId !== incoming.projectId || previous.id !== incoming.id) {
    throw new Error("No se pueden fusionar entidades de proyectos o identidades diferentes.");
  }
  const evidence = new Map<string, TextEvidence>();
  for (const item of [...previous.evidence, ...incoming.evidence]) {
    evidence.set(evidenceIdentityKey(item), item);
  }
  return {
    ...previous,
    evidence: [...evidence.values()].sort((a, b) =>
      a.documentId.localeCompare(b.documentId) || a.revision - b.revision || a.start - b.start
    ),
    aliases: [...new Set([...previous.aliases, ...incoming.aliases])],
    lastSeenAt: Math.max(previous.lastSeenAt, incoming.lastSeenAt)
  };
}


const RELATION_TYPES = [
  "padre", "madre", "hijo", "hija", "hermano", "hermana",
  "esposo", "esposa", "enemigo", "enemiga", "aliado", "aliada",
  "mentor", "mentora", "amigo", "amiga"
] as const;

const ACTION_RELATIONS = [
  "ayudó", "salvó", "traicionó", "protegió", "atacó", "buscó", "acompañó"
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function unicodeNamePattern(name: string): string {
  return `(?<![\\p{L}\\p{M}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{M}\\p{N}_])`;
}

/**
 * Reconoce relaciones solo cuando los dos extremos ya existen como entidades
 * del mismo proyecto y la frase contiene una construcción lingüística explícita.
 */
export function extractNarrativeRelations(
  projectId: string,
  documentId: string,
  revision: number,
  text: string,
  entities: readonly NarrativeEntity[],
  baseOffset = 0
): readonly NarrativeRelation[] {
  validateNarrativeExtractionContext(projectId, documentId, revision, text, baseOffset, entities);
  const relationSignal = new RegExp(
    `\\b(?:es|era|fue)\\s+(?:el|la)?\\s*(?:${RELATION_TYPES.join("|")})\\s+de\\b|\\b(?:${ACTION_RELATIONS.join("|")})\\s+a\\b`,
    "iu"
  );
  if (!relationSignal.test(text)) return [];
  const characters = new Map<string, NarrativeEntity>();
  for (const entity of entities) {
    if (entity.projectId === projectId && entity.kind === "character") {
      characters.set(entity.normalizedName, entity);
      for (const alias of entity.aliases) {
        const normalizedAlias = normalizeEntityName(alias);
        const existing = characters.get(normalizedAlias);
        if (!existing || existing.id === entity.id) characters.set(normalizedAlias, entity);
      }
    }
  }
  const nameCapture = "[A-ZÁÉÍÓÚÜÑ][\\p{L}\\p{M}]+(?:[ \\u00a0]+(?:de[ \\u00a0]+(?:la|las|los)|de|del|la|las|los|el|y|san|santa)?[ \\u00a0]*[A-ZÁÉÍÓÚÜÑ][\\p{L}\\p{M}]+){0,3}";
  const prefix = "(?<![\\p{L}\\p{M}\\p{N}_])";
  const suffix = "(?![\\p{L}\\p{M}\\p{N}_])";
  const scanText = text;
  const patterns = [
    {
      expression: new RegExp(
        `${prefix}(${nameCapture})\\s+(?:es|era|fue)\\s+(?:el|la)?\\s*(${RELATION_TYPES.join("|")})\\s+de\\s+(${nameCapture})${suffix}`,
        "gu"
      ),
      relationType: (match: RegExpExecArray) => (match[2] ?? "").toLocaleLowerCase("es"),
      fromName: (match: RegExpExecArray) => match[1] ?? "",
      toName: (match: RegExpExecArray) => match[3] ?? ""
    },
    {
      expression: new RegExp(
        `${prefix}(${nameCapture})\\s+(${ACTION_RELATIONS.join("|")})\\s+a\\s+(${nameCapture})${suffix}`,
        "gu"
      ),
      relationType: (match: RegExpExecArray) => (match[2] ?? "").toLocaleLowerCase("es"),
      fromName: (match: RegExpExecArray) => match[1] ?? "",
      toName: (match: RegExpExecArray) => match[3] ?? ""
    }
  ];

  const found = new Map<string, NarrativeRelation>();
  for (const pattern of patterns) {
    pattern.expression.lastIndex = 0;
    for (const match of scanText.matchAll(pattern.expression)) {
      const from = characters.get(normalizeEntityName(pattern.fromName(match)));
      const to = characters.get(normalizeEntityName(pattern.toName(match)));
      if (!from || !to || from.id === to.id) continue;

      const relationType = pattern.relationType(match);
      const localStart = match.index;
      const localEnd = localStart + match[0].length;
      const start = baseOffset + localStart;
      const end = baseOffset + localEnd;
      const lineStart = text.lastIndexOf("\n", localStart - 1) + 1;
      const lineBreak = text.indexOf("\n", localEnd);
      const lineEnd = lineBreak < 0 ? text.length : lineBreak;
      const id = `relation:${from.id}:${relationType}:${to.id}`;
      const evidence: TextEvidence = {
        documentId, revision, start, end,
        excerpt: text.slice(lineStart, lineEnd)
      };
      const previous = found.get(id);
      const evidenceByKey = new Map(
        (previous?.evidence ?? []).map(item => [
          `${item.documentId}:${item.start}`, item
        ])
      );
      evidenceByKey.set(`${documentId}:${start}`, evidence);
      found.set(id, {
        projectId, id, fromEntityId: from.id, toEntityId: to.id,
        relationType, evidence: [...evidenceByKey.values()]
      });
    }
  }
  return [...found.values()];
}

export function mergeNarrativeRelation(
  previous: NarrativeRelation | undefined,
  incoming: NarrativeRelation
): NarrativeRelation {
  if (!previous) return incoming;
  if (previous.projectId !== incoming.projectId || previous.id !== incoming.id) {
    throw new Error("No se pueden fusionar relaciones de proyectos o identidades diferentes.");
  }
  const evidence = new Map<string, TextEvidence>();
  for (const item of [...previous.evidence, ...incoming.evidence]) {
    evidence.set(evidenceIdentityKey(item), item);
  }
  return { ...previous, evidence: [...evidence.values()] };
}


/**
 * Lee únicamente referencias temporales escritas de forma explícita.
 * No convierte el orden de capítulos, la posición del párrafo ni tiempos verbales
 * en fechas o secuencias inventadas.
 */
export function extractExplicitTimeReference(text: string): NarrativeTimeReference | undefined {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/u);
  const dmy = text.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/u);
  const year = text.match(/\baño\s*(\d{1,6})\b/iu);
  const storyDay = text.match(/\b(?:día|jornada)\s*(?:n(?:º|°|o)?\s*)?(\d{1,6})\b/iu);

  if (iso || dmy) {
    const raw = iso?.[0] ?? dmy?.[0] ?? "";
    const y = Number(iso?.[1] ?? dmy?.[3]);
    const month = Number(iso?.[2] ?? dmy?.[2]);
    const day = Number(iso?.[3] ?? dmy?.[1]);
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(y, month - 1, day);
    if (date.getUTCFullYear() === y && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return { basis: "calendar", precision: "date", raw, orderValue: Math.floor(date.getTime() / 86_400_000) };
    }
  }
  if (year) {
    const value = Number(year[1]);
    if (value > 0) {
      const firstDay = new Date(0);
      firstDay.setUTCHours(0, 0, 0, 0);
      firstDay.setUTCFullYear(value, 0, 1);
      const orderValue = Math.floor(firstDay.getTime() / 86_400_000);
      // Date limita el calendario UTC a un rango finito; un año fuera de ese
      // rango no debe introducir NaN en un registro narrativo persistente.
      if (Number.isFinite(orderValue)) {
        return { basis: "calendar", precision: "year", raw: year[0], orderValue };
      }
    }
  }
  if (storyDay) {
    const value = Number(storyDay[1]);
    if (value > 0) return { basis: "story-day", precision: "day-index", raw: storyDay[0], orderValue: value };
  }
  return undefined;
}

/** Captura acontecimientos solo cuando el manuscrito los marca explícitamente. */
export function extractNarrativeEvents(
  projectId: string,
  documentId: string,
  revision: number,
  text: string,
  entities: readonly NarrativeEntity[],
  baseOffset = 0
): readonly NarrativeEvent[] {
  validateNarrativeExtractionContext(projectId, documentId, revision, text, baseOffset, entities);
  const events: NarrativeEvent[] = [];
  const expression = /^[ \t]*(?:ACONTECIMIENTO|EVENTO)[ \t]*:[ \t]*(.+?)[ \t]*$/gimu;
  for (const match of text.matchAll(expression)) {
    const label = match[1]?.trim();
    if (!label) continue;
    const start = baseOffset + match.index + match[0].indexOf(label);
    const end = start + label.length;
    const timeReference = extractExplicitTimeReference(label);
    const participants = entities
      .filter((entity: NarrativeEntity) => entity.projectId === projectId && entity.kind === "character")
      .filter(entity => [entity.canonicalName, ...entity.aliases].some(name =>
        new RegExp(unicodeNamePattern(name), "iu").test(label)
      ))
      .map(entity => entity.id);
    const normalized = normalizeEntityName(label);
    const localEnd = end - baseOffset;
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const lineBreak = text.indexOf("\n", localEnd);
    const lineEnd = lineBreak < 0 ? text.length : lineBreak;
    events.push({
      projectId,
      id: "event:" + documentId + ":" + (baseOffset + match.index),
      label,
      participants,
      evidence: [{
        documentId, revision, start, end,
        excerpt: text.slice(lineStart, lineEnd)
      }],
      ...(timeReference ? { timeReference } : {})
    });
  }
  return events;
}

/** Solo reconoce ideas que el escritor o el anfitrión marca con IDEA:. */
export function extractNarrativeIdeas(
  projectId: string,
  documentId: string,
  revision: number,
  text: string,
  baseOffset = 0,
  sourceProjectName = projectId,
  now = Date.now()
): readonly NarrativeIdea[] {
  validateNarrativeExtractionContext(projectId, documentId, revision, text, baseOffset, undefined, now);
  if (typeof sourceProjectName !== "string" || !sourceProjectName.trim()) {
    throw new Error("El nombre del proyecto de origen de la idea es obligatorio.");
  }
  const ideas: NarrativeIdea[] = [];
  const expression = /^[ \t]*IDEA[ \t]*:[ \t]*(.+?)[ \t]*$/gimu;
  for (const match of text.matchAll(expression)) {
    const value = match[1]?.trim();
    if (!value) continue;
    const start = baseOffset + match.index + match[0].indexOf(value);
    const end = start + value.length;
    const localEnd = end - baseOffset;
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const lineBreak = text.indexOf("\n", localEnd);
    const lineEnd = lineBreak < 0 ? text.length : lineBreak;
    ideas.push({
      projectId,
      id: `idea:${documentId}:${baseOffset + match.index}`,
      text: value,
      status: "IDEA",
      originDocumentId: documentId,
      sourceProjectName,
      statusHistory: [{ status: "IDEA", changedAt: now, reason: "initial" }],
      evidence: [{
        documentId, revision, start, end,
        excerpt: text.slice(lineStart, lineEnd)
      }]
    });
  }
  return ideas;
}

export function mergeNarrativeEvent(
  previous: NarrativeEvent | undefined,
  incoming: NarrativeEvent
): NarrativeEvent {
  if (!previous) return incoming;
  if (previous.projectId !== incoming.projectId || previous.id !== incoming.id) {
    throw new Error("No se pueden fusionar acontecimientos de proyectos o identidades diferentes.");
  }
  const evidence = new Map<string, TextEvidence>();
  for (const item of [...previous.evidence, ...incoming.evidence]) {
    evidence.set(evidenceIdentityKey(item), item);
  }
  return {
    ...previous,
    label: incoming.label,
    participants: incoming.participants,
    ...(incoming.timelineTrackId ? { timelineTrackId: incoming.timelineTrackId } : {}),
    ...(incoming.timeReference ? { timeReference: incoming.timeReference } : {}),
    evidence: [...evidence.values()]
  };
}

export function mergeNarrativeIdea(
  previous: NarrativeIdea | undefined,
  incoming: NarrativeIdea
): NarrativeIdea {
  if (!previous) return incoming;
  if (previous.projectId !== incoming.projectId || previous.id !== incoming.id) {
    throw new Error("No se pueden fusionar ideas de proyectos o identidades diferentes.");
  }
  const evidence = new Map<string, TextEvidence>();
  for (const item of [...previous.evidence, ...incoming.evidence]) {
    evidence.set(evidenceIdentityKey(item), item);
  }
  const relatedEntityIds = [...new Set([
    ...(previous.relatedEntityIds ?? []),
    ...(incoming.relatedEntityIds ?? [])
  ])];
  const relatedIdeaIds = [...new Set([
    ...(previous.relatedIdeaIds ?? []),
    ...(incoming.relatedIdeaIds ?? [])
  ])];
  if (relatedEntityIds.length > MAX_NARRATIVE_IDEA_REFERENCES ||
      relatedIdeaIds.length > MAX_NARRATIVE_IDEA_REFERENCES) {
    throw new Error(`Las referencias explícitas de cada categoría superan el límite de ${MAX_NARRATIVE_IDEA_REFERENCES}.`);
  }
  const textChanged = previous.text !== incoming.text;
  const nextStatus = textChanged ? "IDEA" : previous.status;
  const statusHistory = [...(previous.statusHistory ?? [
    { status: previous.status, reason: "initial" as const }
  ])];
  if (textChanged && previous.status !== "IDEA") {
    statusHistory.push({
      status: "IDEA",
      changedAt: nextNarrativeIdeaStatusChangeAt(statusHistory),
      reason: "text-revised"
    });
  }
  return {
    ...previous,
    sourceProjectName: incoming.sourceProjectName,
    text: textChanged ? incoming.text : previous.text,
    status: nextStatus,
    statusHistory,
    ...(relatedEntityIds.length > 0 ? { relatedEntityIds } : {}),
    ...(relatedIdeaIds.length > 0 ? { relatedIdeaIds } : {}),
    evidence: [...evidence.values()]
  };
}


/** Contradicción candidata entre dos afirmaciones explícitas incompatibles. */
export interface NarrativeContradiction {
  readonly projectId: string;
  readonly id: string;
  readonly entityId: string;
  readonly subject: string;
  readonly predicate: "life-state";
  readonly firstValue: "alive" | "dead";
  readonly secondValue: "alive" | "dead";
  readonly evidence: readonly [TextEvidence, TextEvidence];
  readonly status: "unresolved";
}

/**
 * Detecta únicamente afirmaciones explícitas y opuestas sobre el estado vital
 * de un personaje ya identificado. No decide cuál es verdadera ni altera eventos.
 */
export function detectExplicitStateContradictions(
  projectId: string,
  events: readonly NarrativeEvent[],
  entities: readonly NarrativeEntity[]
): readonly NarrativeContradiction[] {
  const characters = entities.filter(entity =>
    entity.projectId === projectId && entity.kind === "character"
  );
  const assertions = new Map<string, { entity: NarrativeEntity; value: "alive" | "dead"; evidence: TextEvidence; timeReference?: NarrativeTimeReference }[]>();
  const patterns = [
    { value: "alive" as const, expression: /(?:^|[^\p{L}\p{N}_])(?:está|sigue|permanece)\s+(?:vivo|viva)(?:$|[^\p{L}\p{N}_])/iu },
    { value: "dead" as const, expression: /(?:^|[^\p{L}\p{N}_])(?:está|permanece)\s+(?:muerto|muerta)(?:$|[^\p{L}\p{N}_])/iu },
    { value: "dead" as const, expression: /(?:^|[^\p{L}\p{N}_])(?:murió|falleció|ha muerto)(?:$|[^\p{L}\p{N}_])/iu }
  ];
  for (const event of events) {
    if (event.projectId !== projectId) continue;
    // Un acontecimiento puede conservar varias revisiones de evidencia.
    // Una referencia histórica obsoleta no debe ocultar otra vigente.
    const currentEvidence = event.evidence.filter(evidence => evidence.status !== "stale");
    if (currentEvidence.length === 0) continue;
    for (const evidence of currentEvidence) {
      for (const entity of characters) {
        const names = [entity.canonicalName, ...entity.aliases];
        if (!names.some(value => new RegExp(unicodeNamePattern(value), "iu").test(event.label))) continue;
        const state = patterns.find(pattern => pattern.expression.test(event.label));
        if (!state) continue;
        const list = assertions.get(entity.id) ?? [];
        if (list.some(claim => claim.evidence.documentId === evidence.documentId &&
            claim.evidence.start === evidence.start)) continue;
        list.push({ entity, value: state.value, evidence, ...(event.timeReference ? { timeReference: event.timeReference } : {}) });
        assertions.set(entity.id, list);
      }
    }
  }
  const results: NarrativeContradiction[] = [];
  for (const [entityId, claims] of assertions) {
    const aliveClaims = claims.filter(claim => claim.value === "alive");
    const deadClaims = claims.filter(claim => claim.value === "dead");
    if (aliveClaims.length === 0 || deadClaims.length === 0) continue;

    // No basta con comparar la primera afirmación de cada tipo: un personaje
    // puede estar vivo, morir y volver a aparecer vivo en otra fecha. Buscamos
    // cualquier pareja que no represente una transición cronológica posible.
    let conflictingPair: [typeof claims[number], typeof claims[number]] | undefined;
    for (const alive of aliveClaims) {
      for (const dead of deadClaims) {
        if (alive.evidence.documentId === dead.evidence.documentId &&
            alive.evidence.start === dead.evidence.start) continue;
        const aliveTime = alive.timeReference;
        const deadTime = dead.timeReference;
        if (aliveTime && deadTime &&
            aliveTime.basis === deadTime.basis &&
            aliveTime.orderValue < deadTime.orderValue) continue;
        conflictingPair = [alive, dead];
        break;
      }
      if (conflictingPair) break;
    }
    if (!conflictingPair) continue;
    const [alive, dead] = conflictingPair;
    const ordered = [alive.evidence, dead.evidence].sort((a, b) =>
      a.documentId.localeCompare(b.documentId) || a.start - b.start
    ) as [TextEvidence, TextEvidence];
    results.push({
      projectId, id: `contradiction:${entityId}:life-state`,
      entityId, subject: alive.entity.canonicalName, predicate: "life-state",
      firstValue: ordered[0] === alive.evidence ? "alive" : "dead",
      secondValue: ordered[1] === alive.evidence ? "alive" : "dead",
      evidence: ordered, status: "unresolved"
    });
  }
  return results;
}
