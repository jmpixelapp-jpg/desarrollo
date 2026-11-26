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
  for (const profile of input.profiles) {
    const entity = profile && entities.get(profile.entityId);
    if (!profile || !entity || entity.kind !== "character" ||
        profileIds.has(profile.entityId) || !Array.isArray(profile.labels) ||
        profile.labels.length > MAX_NARRATIVE_DESCRIPTIVE_LABELS_PER_PROFILE) {
      throw new Error("Cada perfil descriptivo debe pertenecer a un personaje único del proyecto.");
    }
    profileIds.add(profile.entityId);
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

  for (const profile of input.profiles) {
    const entity = entities.get(profile.entityId)!;
    for (const label of profile.labels) {
      // Evidencia histórica marcada como obsoleta no autoriza una nueva asociación.
      if (label.evidence.status === "stale") continue;
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
