import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

export interface NarrativeDescriptiveLabel {
  /** Descripción literal validada por el escritor o por una extracción revisada. */
  readonly text: string;
  /** Procedencia de la descripción; no se usa como evidencia de la mención actual. */
  readonly evidence: TextEvidence;
}

export interface NarrativeDescriptiveReferenceProfile {
  readonly entityId: string;
  readonly labels: readonly NarrativeDescriptiveLabel[];
}

export type NarrativeDescriptiveReferenceStatus = "single-candidate" | "ambiguous";

export interface NarrativeDescriptiveReferenceCandidate {
  readonly entityId: string;
  readonly entityKind: NarrativeEntity["kind"];
  readonly label: string;
  readonly labelEvidence: TextEvidence;
}

export interface NarrativeDescriptiveReferenceMatch {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly mentionEvidence: TextEvidence;
  readonly candidates: readonly NarrativeDescriptiveReferenceCandidate[];
  readonly status: NarrativeDescriptiveReferenceStatus;
  readonly reviewStatus: "candidate";
}

export interface NarrativeDescriptiveReferenceDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly profiles: readonly NarrativeDescriptiveReferenceProfile[];
  readonly baseOffset?: number;
  readonly maxMatches?: number;
}

export const DEFAULT_NARRATIVE_DESCRIPTIVE_REFERENCE_MATCHES = 2_000;
export const MAX_NARRATIVE_DESCRIPTIVE_REFERENCE_MATCHES = 5_000;
export const MAX_NARRATIVE_DESCRIPTIVE_REFERENCE_TEXT_UNITS = 2_000_000;
export const MAX_NARRATIVE_DESCRIPTIVE_REFERENCE_SCAN_UNITS = 25_000_000;
export const MAX_NARRATIVE_DESCRIPTIVE_REFERENCE_TOTAL_LABELS = 20_000;
export const MAX_NARRATIVE_DESCRIPTIVE_PROFILES = 2_000;
export const MAX_NARRATIVE_DESCRIPTIVE_LABELS_PER_PROFILE = 100;
export const MAX_NARRATIVE_DESCRIPTIVE_LABEL_LENGTH = 120;

function escapeRegExp(value: string): string {
  const metacharacters = new Set([".", "+", "*", "?", "^", "$", "(", ")", "|", "[", "]", "{", "}"]);
  return Array.from(value, character =>
    metacharacters.has(character) || character.charCodeAt(0) === 92
      ? String.fromCharCode(92) + character
      : character
  ).join("");
}

function normalizeLabel(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("es").trim().replace(/\s+/gu, " ");
}

function validEvidence(value: TextEvidence): boolean {
  return !!value && typeof value.documentId === "string" && !!value.documentId.trim() &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    Number.isSafeInteger(value.start) && value.start >= 0 &&
    Number.isSafeInteger(value.end) && value.end > value.start &&
    typeof value.excerpt === "string" && !!value.excerpt.trim();
}

function validate(input: NarrativeDescriptiveReferenceDiscoveryInput): void {
  const maxMatches = input?.maxMatches ?? DEFAULT_NARRATIVE_DESCRIPTIVE_REFERENCE_MATCHES;
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" ||
      input.text.length > MAX_NARRATIVE_DESCRIPTIVE_REFERENCE_TEXT_UNITS ||
      !Array.isArray(input.entities) || !Array.isArray(input.profiles) ||
      input.profiles.length > MAX_NARRATIVE_DESCRIPTIVE_PROFILES ||
      !Number.isSafeInteger(maxMatches) || maxMatches < 1 ||
      maxMatches > MAX_NARRATIVE_DESCRIPTIVE_REFERENCE_MATCHES ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para descubrir referencias descriptivas.");
  }

  const entities = new Map<string, NarrativeEntity>();
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() || entities.has(entity.id) ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        !Array.isArray(entity.aliases)) {
      throw new Error("Las entidades deben ser únicas, válidas y pertenecer al mismo proyecto.");
    }
    entities.set(entity.id, entity);
  }

  const profileIds = new Set<string>();
  let totalLabels = 0;
  for (const profile of input.profiles) {
    const entity = profile && entities.get(profile.entityId);
    if (!profile || !entity || entity.kind !== "character" ||
        profileIds.has(profile.entityId) || !Array.isArray(profile.labels) ||
        profile.labels.length > MAX_NARRATIVE_DESCRIPTIVE_LABELS_PER_PROFILE) {
      throw new Error("Cada perfil descriptivo debe pertenecer a un personaje único del proyecto.");
    }
    profileIds.add(profile.entityId);
    totalLabels += profile.labels.length;
    if (totalLabels > MAX_NARRATIVE_DESCRIPTIVE_REFERENCE_TOTAL_LABELS) {
      throw new Error("Los perfiles descriptivos superan el límite agregado de etiquetas.");
    }
    const labels = new Set<string>();
    for (const label of profile.labels) {
      if (!label || typeof label.text !== "string" || !label.text.trim() ||
          label.text.length > MAX_NARRATIVE_DESCRIPTIVE_LABEL_LENGTH ||
          !validEvidence(label.evidence)) {
        throw new Error("Cada descripción debe incluir texto y evidencia de procedencia válidos.");
      }
      const normalized = normalizeLabel(label.text);
      if (labels.has(normalized)) {
        throw new Error("Un perfil no puede repetir descripciones equivalentes.");
      }
      labels.add(normalized);
    }
  }
}

/**
 * Busca descripciones literales previamente validadas.
 * No deduce atributos a partir de nombres, pronombres ni contexto ambiental.
 * Si varios personajes comparten una etiqueta, devuelve todos los candidatos.
 */
export function discoverNarrativeDescriptiveReferences(
  input: NarrativeDescriptiveReferenceDiscoveryInput
): readonly NarrativeDescriptiveReferenceMatch[] {
  validate(input);
  const base = input.baseOffset ?? 0;
  const maxMatches = input.maxMatches ?? DEFAULT_NARRATIVE_DESCRIPTIVE_REFERENCE_MATCHES;
  const entities = new Map(input.entities.map(entity => [entity.id, entity]));
  const occurrences = new Map<string, {
    start: number;
    end: number;
    excerpt: string;
    candidates: Map<string, NarrativeDescriptiveReferenceCandidate>;
  }>();

  let scanUnits = 0;
  for (const profile of input.profiles) {
    const entity = entities.get(profile.entityId)!;
    for (const label of profile.labels) {
      // Evidencia histórica marcada como obsoleta no autoriza una nueva asociación.
      if (label.evidence.status === "stale") continue;
      scanUnits += input.text.length;
      if (scanUnits > MAX_NARRATIVE_DESCRIPTIVE_REFERENCE_SCAN_UNITS) {
        throw new Error("La búsqueda de referencias descriptivas supera el presupuesto operativo de exploración.");
      }
      const expression = new RegExp(
        "(?<![\\p{L}\\p{M}\\p{N}_])" + escapeRegExp(label.text) +
        "(?![\\p{L}\\p{M}\\p{N}_])",
        "giu"
      );
      for (const match of input.text.matchAll(expression)) {
        const start = match.index!;
        const end = start + match[0].length;
        const key = start + ":" + end;
        let occurrence = occurrences.get(key);
        if (!occurrence) {
          occurrence = { start, end, excerpt: match[0], candidates: new Map() };
          occurrences.set(key, occurrence);
        }
        const candidateKey = entity.id + ":" + normalizeLabel(label.text);
        occurrence.candidates.set(candidateKey, {
          entityId: entity.id,
          entityKind: entity.kind,
          label: label.text,
          labelEvidence: label.evidence
        });
      }
    }
  }

  return [...occurrences.values()]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .slice(0, maxMatches)
    .map(occurrence => {
      const candidates = [...occurrence.candidates.values()]
        .sort((a, b) => a.entityId.localeCompare(b.entityId) || a.label.localeCompare(b.label));
      return {
        id: "descriptive-reference:" + input.documentId + ":" + input.revision + ":" +
          (base + occurrence.start),
        projectId: input.projectId,
        documentId: input.documentId,
        revision: input.revision,
        mentionEvidence: {
          documentId: input.documentId,
          revision: input.revision,
          start: base + occurrence.start,
          end: base + occurrence.end,
          excerpt: occurrence.excerpt
        },
        candidates,
        status: candidates.length === 1 ? "single-candidate" as const : "ambiguous" as const,
        reviewStatus: "candidate" as const
      };
    });
}

export interface NarrativeDescriptiveLabelCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly proposedLabel: string;
  readonly labelEvidence: TextEvidence;
  readonly anchorEntityId: string;
  readonly anchorEvidence: TextEvidence;
  readonly relation: "appositive-description";
  readonly reviewStatus: "candidate";
}

export interface NarrativeDescriptiveLabelCandidateInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
  readonly maxCandidates?: number;
}

export const MAX_NARRATIVE_DESCRIPTIVE_LABEL_CANDIDATES = 2_000;
export const MAX_NARRATIVE_DESCRIPTIVE_LABEL_SCAN_UNITS = 25_000_000;
export const MAX_NARRATIVE_DESCRIPTIVE_LABEL_ENTITIES = 10_000;
export const MAX_NARRATIVE_DESCRIPTIVE_LABEL_ALIASES_PER_ENTITY = 100;
export const MAX_NARRATIVE_DESCRIPTIVE_LABEL_ALIAS_LENGTH = 256;

/**
 * Extrae etiquetas descriptivas en aposición inmediata a una entidad nombrada:
 * «Ana, la heredera del reino». No confirma que la descripción sea verdadera
 * ni la incorpora a la ficha; entrega ambas evidencias para revisión.
 */
export function discoverNarrativeDescriptiveLabelCandidates(
  input: NarrativeDescriptiveLabelCandidateInput
): readonly NarrativeDescriptiveLabelCandidate[] {
  const maxCandidates = input?.maxCandidates ?? MAX_NARRATIVE_DESCRIPTIVE_LABEL_CANDIDATES;
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_NARRATIVE_DESCRIPTIVE_REFERENCE_TEXT_UNITS ||
      !Array.isArray(input.entities) || input.entities.length > MAX_NARRATIVE_DESCRIPTIVE_LABEL_ENTITIES || !Number.isSafeInteger(maxCandidates) ||
      maxCandidates < 1 || maxCandidates > MAX_NARRATIVE_DESCRIPTIVE_LABEL_CANDIDATES ||
      (input.baseOffset !== undefined && (!Number.isSafeInteger(input.baseOffset) ||
        input.baseOffset < 0 || input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para extraer etiquetas descriptivas candidatas.");
  }
  const base = input.baseOffset ?? 0;
  const results = new Map<string, NarrativeDescriptiveLabelCandidate>();
  const entityIds = new Set<string>();
  let scanUnits = 0;
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId || typeof entity.id !== "string" ||
        !entity.id.trim() || entityIds.has(entity.id) || typeof entity.canonicalName !== "string" ||
        !entity.canonicalName.trim() || entity.canonicalName.length > MAX_NARRATIVE_DESCRIPTIVE_LABEL_ALIAS_LENGTH ||
        !Array.isArray(entity.aliases) || entity.aliases.length > MAX_NARRATIVE_DESCRIPTIVE_LABEL_ALIASES_PER_ENTITY) {
      throw new Error("Las entidades deben ser únicas, válidas y pertenecer al mismo proyecto.");
    }
    entityIds.add(entity.id);
    const aliasKeys = new Set<string>();
    for (const alias of entity.aliases) {
      if (typeof alias !== "string" || !alias.trim() ||
          alias.length > MAX_NARRATIVE_DESCRIPTIVE_LABEL_ALIAS_LENGTH ||
          aliasKeys.has(alias.normalize("NFC").toLocaleLowerCase("es").trim())) {
        throw new Error("Los alias deben ser textos válidos, únicos y estar dentro del límite de longitud.");
      }
      aliasKeys.add(alias.normalize("NFC").toLocaleLowerCase("es").trim());
    }
    const names = [entity.canonicalName, ...entity.aliases];
    for (const name of names) {
      scanUnits += input.text.length;
      if (scanUnits > MAX_NARRATIVE_DESCRIPTIVE_LABEL_SCAN_UNITS) {
        throw new Error("La extracción de etiquetas descriptivas supera el presupuesto operativo de exploración.");
      }
      const expression = new RegExp(
        "(?<![\\p{L}\\p{M}\\p{N}_])" + escapeRegExp(name) +
        "(?![\\p{L}\\p{M}\\p{N}_])\\s*,\\s*((?:el|la|los|las|un|una)\\s+[\\p{L}][\\p{L}\\p{M}-]*(?:\\s+(?:de la|de los|de las|del|de|con|sin|en)\\s+[\\p{L}][\\p{L}\\p{M}-]*){0,2})",
        "giu"
      );
      for (const match of input.text.matchAll(expression)) {
        const anchorStart = match.index!;
        const anchorEnd = anchorStart + name.length;
        const labelStart = anchorStart + match[0].lastIndexOf(match[1]!);
        const labelEnd = labelStart + match[1]!.length;
        const key = entity.id + ":" + labelStart + ":" + labelEnd;
        if (results.has(key)) continue;
        results.set(key, {
          id: "descriptive-label-candidate:" + input.documentId + ":" + input.revision + ":" + (base + labelStart) + ":" + entity.id,
          projectId: input.projectId, documentId: input.documentId, revision: input.revision,
          proposedLabel: match[1]!,
          labelEvidence: { documentId: input.documentId, revision: input.revision, start: base + labelStart, end: base + labelEnd, excerpt: match[1]! },
          anchorEntityId: entity.id,
          anchorEvidence: { documentId: input.documentId, revision: input.revision, start: base + anchorStart, end: base + anchorEnd, excerpt: match[0].slice(0, match[0].indexOf(",")) },
          relation: "appositive-description", reviewStatus: "candidate"
        });
        if (results.size > maxCandidates) {
          throw new Error("La extracción supera el máximo de propuestas; no se devuelve un resultado parcial.");
        }
      }
    }
  }
  return [...results.values()].sort((a,b) =>
    a.labelEvidence.start - b.labelEvidence.start ||
    a.labelEvidence.end - b.labelEvidence.end ||
    a.anchorEntityId.localeCompare(b.anchorEntityId)
  );
}


export interface NarrativeRelativeClauseCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly clauseText: string;
  readonly clauseEvidence: TextEvidence;
  readonly anchorEntityId: string;
  readonly anchorEvidence: TextEvidence;
  readonly relation: "relative-clause";
  readonly reviewStatus: "candidate";
}

export interface NarrativeRelativeClauseCandidateInput extends NarrativeDescriptiveLabelCandidateInput {
  readonly maxClauseLength?: number;
}

export const DEFAULT_NARRATIVE_RELATIVE_CLAUSE_LENGTH = 240;
export const MAX_NARRATIVE_RELATIVE_CLAUSE_LENGTH = 600;
export const MAX_NARRATIVE_RELATIVE_CLAUSE_CANDIDATES = 2_000;

/**
 * Detecta incisos relativos explícitos del tipo «Ana, que conocía la ciudad, ...».
 * Conserva la cláusula como texto literal: no interpreta su contenido como hecho
 * ni lo incorpora a la ficha de la entidad.
 */
export function discoverNarrativeRelativeClauseCandidates(
  input: NarrativeRelativeClauseCandidateInput
): readonly NarrativeRelativeClauseCandidate[] {
  const maxCandidates = input?.maxCandidates ?? MAX_NARRATIVE_RELATIVE_CLAUSE_CANDIDATES;
  const maxClauseLength = input?.maxClauseLength ?? DEFAULT_NARRATIVE_RELATIVE_CLAUSE_LENGTH;
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_NARRATIVE_DESCRIPTIVE_REFERENCE_TEXT_UNITS ||
      !Array.isArray(input.entities) || input.entities.length > MAX_NARRATIVE_DESCRIPTIVE_LABEL_ENTITIES ||
      !Number.isSafeInteger(maxCandidates) || maxCandidates < 1 ||
      maxCandidates > MAX_NARRATIVE_RELATIVE_CLAUSE_CANDIDATES ||
      !Number.isSafeInteger(maxClauseLength) || maxClauseLength < 20 ||
      maxClauseLength > MAX_NARRATIVE_RELATIVE_CLAUSE_LENGTH ||
      (input.baseOffset !== undefined && (!Number.isSafeInteger(input.baseOffset) ||
        input.baseOffset < 0 || input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para descubrir cláusulas relativas candidatas.");
  }

  const base = input.baseOffset ?? 0;
  const results = new Map<string, NarrativeRelativeClauseCandidate>();
  const entityIds = new Set<string>();
  let scanUnits = 0;
  // Requiere una forma verbal finita reconocible; evita tratar cualquier «que»
  // como relativa. Es una heurística de alta precisión, no un analizador sintáctico.
  const finiteVerb = String.raw`(?:es|son|era|eran|fue|fueron|ha|han|había|habían|habrá|habrán|está|están|estaba|estaban|estuvo|estuvieron|puede|pueden|podía|podían|quiere|quieren|quería|querían|debe|deben|debía|debían|tiene|tienen|tenía|tenían|hace|hacen|hacía|hacían|dijo|dijeron|llegó|llegaron|vivía|vivían|conocía|conocían|llevaba|llevaban|guardaba|guardaban|(?:[\\p{L}\\p{M}]+(?:aba|aban|ía|ían|aron|ieron|ó|ió|ará|erá|irá|arán|erán|irán)))`;
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId || typeof entity.id !== "string" ||
        !entity.id.trim() || entityIds.has(entity.id) || typeof entity.canonicalName !== "string" ||
        !entity.canonicalName.trim() || entity.canonicalName.length > MAX_NARRATIVE_DESCRIPTIVE_LABEL_ALIAS_LENGTH ||
        !Array.isArray(entity.aliases) || entity.aliases.length > MAX_NARRATIVE_DESCRIPTIVE_LABEL_ALIASES_PER_ENTITY) {
      throw new Error("Las entidades deben ser únicas, válidas y pertenecer al mismo proyecto.");
    }
    entityIds.add(entity.id);
    const aliasKeys = new Set<string>();
    for (const alias of entity.aliases) {
      if (typeof alias !== "string" || !alias.trim() ||
          alias.length > MAX_NARRATIVE_DESCRIPTIVE_LABEL_ALIAS_LENGTH ||
          aliasKeys.has(alias.normalize("NFC").toLocaleLowerCase("es").trim())) {
        throw new Error("Los alias deben ser textos válidos, únicos y estar dentro del límite de longitud.");
      }
      aliasKeys.add(alias.normalize("NFC").toLocaleLowerCase("es").trim());
    }
    for (const name of [entity.canonicalName, ...entity.aliases]) {
      scanUnits += input.text.length;
      if (scanUnits > MAX_NARRATIVE_DESCRIPTIVE_LABEL_SCAN_UNITS) {
        throw new Error("La extracción de cláusulas relativas supera el presupuesto operativo de exploración.");
      }
      const expression = new RegExp(
        "(?<![\\p{L}\\p{M}\\p{N}_])" + escapeRegExp(name) +
        "(?![\\p{L}\\p{M}\\p{N}_])\\s*,\\s*(que\\s+(?:(?!" + // no cruzar cierre
        "[.!?;])[^,]){1," + maxClauseLength + "}?)\\s*,",
        "giu"
      );
      for (const match of input.text.matchAll(expression)) {
        const clause = match[1]!;
        if (!new RegExp("\\b" + finiteVerb + "\\b", "iu").test(clause)) continue;
        const anchorStart = match.index!;
        const anchorEnd = anchorStart + name.length;
        const clauseStart = anchorStart + match[0].indexOf(clause);
        const clauseEnd = clauseStart + clause.length;
        const key = entity.id + ":" + clauseStart + ":" + clauseEnd;
        if (results.has(key)) continue;
        results.set(key, {
          id: "relative-clause-candidate:" + input.documentId + ":" + input.revision + ":" + (base + clauseStart) + ":" + entity.id,
          projectId: input.projectId, documentId: input.documentId, revision: input.revision,
          clauseText: clause,
          clauseEvidence: { documentId: input.documentId, revision: input.revision, start: base + clauseStart, end: base + clauseEnd, excerpt: clause },
          anchorEntityId: entity.id,
          anchorEvidence: { documentId: input.documentId, revision: input.revision, start: base + anchorStart, end: base + anchorEnd, excerpt: name },
          relation: "relative-clause", reviewStatus: "candidate"
        });
        if (results.size > maxCandidates) {
          throw new Error("La extracción supera el máximo de cláusulas; no se devuelve un resultado parcial.");
        }
      }
    }
  }
  return [...results.values()].sort((a, b) =>
    a.clauseEvidence.start - b.clauseEvidence.start ||
    a.clauseEvidence.end - b.clauseEvidence.end ||
    a.anchorEntityId.localeCompare(b.anchorEntityId)
  );
}


export interface NarrativeRelationalAppositionCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly relationText: string;
  readonly relationEvidence: TextEvidence;
  readonly anchorEntityId: string;
  readonly anchorEvidence: TextEvidence;
  readonly targetMentionEvidence: TextEvidence;
  readonly targetEntityCandidates: readonly string[];
  readonly relation: "relational-apposition";
  readonly reviewStatus: "candidate";
}

export interface NarrativeRelationalAppositionCandidateInput extends NarrativeDescriptiveLabelCandidateInput {
  readonly maxCandidates?: number;
}

export const MAX_NARRATIVE_RELATIONAL_APPOSITION_CANDIDATES = 2_000;
export const MAX_NARRATIVE_RELATIONAL_APPOSITION_ENTITIES = 2_000;

/**
 * Detecta aposiciones relacionales con objetivo nominal explícito:
 * «Bruno, hermano menor de Ana, volvió». El objetivo se resuelve solo contra
 * nombres/alias registrados y conserva todas las coincidencias ambiguas.
 */
export function discoverNarrativeRelationalAppositionCandidates(
  input: NarrativeRelationalAppositionCandidateInput
): readonly NarrativeRelationalAppositionCandidate[] {
  const maxCandidates = input?.maxCandidates ?? MAX_NARRATIVE_RELATIONAL_APPOSITION_CANDIDATES;
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_NARRATIVE_DESCRIPTIVE_REFERENCE_TEXT_UNITS ||
      !Array.isArray(input.entities) || input.entities.length > MAX_NARRATIVE_RELATIONAL_APPOSITION_ENTITIES ||
      !Number.isSafeInteger(maxCandidates) || maxCandidates < 1 ||
      maxCandidates > MAX_NARRATIVE_RELATIONAL_APPOSITION_CANDIDATES ||
      (input.baseOffset !== undefined && (!Number.isSafeInteger(input.baseOffset) ||
        input.baseOffset < 0 || input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para descubrir aposiciones relacionales.");
  }
  const base = input.baseOffset ?? 0;
  const entities = new Map<string, NarrativeEntity>();
  const nameToEntities = new Map<string, Set<string>>();
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId || typeof entity.id !== "string" ||
        !entity.id.trim() || entities.has(entity.id) || typeof entity.canonicalName !== "string" ||
        !entity.canonicalName.trim() || entity.canonicalName.length > MAX_NARRATIVE_DESCRIPTIVE_LABEL_ALIAS_LENGTH ||
        !Array.isArray(entity.aliases) || entity.aliases.length > MAX_NARRATIVE_DESCRIPTIVE_LABEL_ALIASES_PER_ENTITY) {
      throw new Error("Las entidades deben ser únicas, válidas y pertenecer al mismo proyecto.");
    }
    entities.set(entity.id, entity);
    const aliases = new Set<string>();
    for (const name of [entity.canonicalName, ...entity.aliases]) {
      if (typeof name !== "string" || !name.trim() ||
          name.length > MAX_NARRATIVE_DESCRIPTIVE_LABEL_ALIAS_LENGTH) {
        throw new Error("Los nombres y alias deben ser textos válidos y estar dentro del límite de longitud.");
      }
      const normalized = normalizeLabel(name);
      if (aliases.has(normalized)) continue;
      aliases.add(normalized);
      const ids = nameToEntities.get(normalized) ?? new Set<string>();
      ids.add(entity.id);
      nameToEntities.set(normalized, ids);
    }
  }

  const relationHeads = "(?:hermano|hermana|hermanos|hermanas|hijo|hija|hijos|hijas|padre|madre|esposo|esposa|marido|mujer|compañero|compañera|amigo|amiga|primo|prima|tío|tía|abuelo|abuela|sobrino|sobrina|maestro|maestra|discípulo|discípula|jefe|jefa|capitán|capitana|rey|reina|duque|duquesa|conde|condesa)";
  const results = new Map<string, NarrativeRelationalAppositionCandidate>();
  let scanUnits = 0;
  for (const anchor of input.entities) {
    for (const anchorName of [anchor.canonicalName, ...anchor.aliases]) {
      scanUnits += input.text.length;
      if (scanUnits > MAX_NARRATIVE_DESCRIPTIVE_LABEL_SCAN_UNITS) {
        throw new Error("La extracción de aposiciones relacionales supera el presupuesto operativo de exploración.");
      }
      const expression = new RegExp(
        "(?<![\\p{L}\\p{M}\\p{N}_])" + escapeRegExp(anchorName) +
        "(?![\\p{L}\\p{M}\\p{N}_])\\s*,\\s*(" + relationHeads +
        "(?:\\s+[\\p{L}][\\p{L}\\p{M}-]*){0,2}\\s+de\\s+([^,;.!?]+?))\\s*,",
        "giu"
      );
      for (const match of input.text.matchAll(expression)) {
        const relationText = match[1]!.trim();
        const targetName = match[2]!.trim();
        const targetIds = [...(nameToEntities.get(normalizeLabel(targetName)) ?? [])]
          .filter(id => id !== anchor.id)
          .sort((a, b) => a.localeCompare(b));
        if (targetIds.length === 0) continue;
        const anchorStart = match.index!;
        const anchorEnd = anchorStart + anchorName.length;
        const relationStart = anchorStart + match[0].indexOf(match[1]!);
        const relationEnd = relationStart + match[1]!.length;
        const targetStart = relationStart + match[1]!.lastIndexOf(match[2]!);
        const targetEnd = targetStart + match[2]!.length;
        const key = anchor.id + ":" + relationStart + ":" + relationEnd;
        if (results.has(key)) {
          const existing = results.get(key)!;
          const merged = [...new Set([...existing.targetEntityCandidates, ...targetIds])].sort();
          results.set(key, { ...existing, targetEntityCandidates: merged });
          continue;
        }
        results.set(key, {
          id: "relational-apposition-candidate:" + input.documentId + ":" + input.revision + ":" + (base + relationStart) + ":" + anchor.id,
          projectId: input.projectId, documentId: input.documentId, revision: input.revision,
          relationText,
          relationEvidence: { documentId: input.documentId, revision: input.revision, start: base + relationStart, end: base + relationEnd, excerpt: relationText },
          anchorEntityId: anchor.id,
          anchorEvidence: { documentId: input.documentId, revision: input.revision, start: base + anchorStart, end: base + anchorEnd, excerpt: anchorName },
          targetMentionEvidence: { documentId: input.documentId, revision: input.revision, start: base + targetStart, end: base + targetEnd, excerpt: match[2]! },
          targetEntityCandidates: targetIds,
          relation: "relational-apposition",
          reviewStatus: "candidate"
        });
        if (results.size > maxCandidates) {
          throw new Error("La extracción supera el máximo de aposiciones relacionales; no se devuelve un resultado parcial.");
        }
      }
    }
  }
  return [...results.values()].sort((a, b) =>
    a.relationEvidence.start - b.relationEvidence.start ||
    a.relationEvidence.end - b.relationEvidence.end ||
    a.anchorEntityId.localeCompare(b.anchorEntityId)
  );
}
