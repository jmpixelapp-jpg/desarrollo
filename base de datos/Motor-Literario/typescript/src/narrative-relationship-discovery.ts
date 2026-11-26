import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";
import type { NarrativeDescriptiveReferenceProfile } from "./narrative-descriptive-reference-discovery";

export type NarrativeRelationshipStatus = "single-candidate" | "ambiguous";

export interface NarrativeRelationshipCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  /** Etiqueta textual normalizada a una familia semántica conservadora. */
  readonly relationType: "parent-of" | "child-of" | "sibling-of" | "spouse-of" | "friend-of" | "enemy-of" | "companion-of";
  readonly surface: string;
  readonly relationEvidence: TextEvidence;
  readonly fromEvidence: TextEvidence;
  readonly toEvidence: TextEvidence;
  readonly status: NarrativeRelationshipStatus;
  readonly reviewStatus: "candidate";
}

export interface NarrativeRelationshipDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly descriptiveProfiles?: readonly NarrativeDescriptiveReferenceProfile[];
  readonly baseOffset?: number;
  readonly maxCandidates?: number;
}

export const DEFAULT_NARRATIVE_RELATIONSHIP_CANDIDATES = 1_000;
export const MAX_NARRATIVE_RELATIONSHIP_CANDIDATES = 3_000;
export const MAX_NARRATIVE_RELATIONSHIP_TEXT_UNITS = 2_000_000;

interface RelationLexeme {
  readonly expression: string;
  readonly relationType: NarrativeRelationshipCandidate["relationType"];
  readonly direction: "descriptor-to-name" | "name-to-name";
}

const RELATIONS: readonly RelationLexeme[] = [
  { expression: "padre|madre", relationType: "parent-of", direction: "descriptor-to-name" },
  { expression: "hijo|hija", relationType: "child-of", direction: "descriptor-to-name" },
  { expression: "hermano|hermana", relationType: "sibling-of", direction: "descriptor-to-name" },
  { expression: "esposo|esposa|marido|mujer", relationType: "spouse-of", direction: "descriptor-to-name" },
  { expression: "amigo|amiga", relationType: "friend-of", direction: "descriptor-to-name" },
  { expression: "enemigo|enemiga", relationType: "enemy-of", direction: "descriptor-to-name" },
  { expression: "compañero|compañera", relationType: "companion-of", direction: "descriptor-to-name" }
];

function escapeRegExp(value: string): string {
  return Array.from(value, c => /[.*+?^\${}()|[\]\\]/u.test(c) ? "\\" + c : c).join("");
}
function normalize(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("es").trim().replace(/\s+/gu, " ");
}
function evidence(documentId: string, revision: number, base: number, start: number, end: number, excerpt: string): TextEvidence {
  return { documentId, revision, start: base + start, end: base + end, excerpt };
}
function validate(input: NarrativeRelationshipDiscoveryInput): void {
  const max = input?.maxCandidates ?? DEFAULT_NARRATIVE_RELATIONSHIP_CANDIDATES;
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_NARRATIVE_RELATIONSHIP_TEXT_UNITS ||
      !Array.isArray(input.entities) ||
      (input.descriptiveProfiles !== undefined && !Array.isArray(input.descriptiveProfiles)) ||
      !Number.isSafeInteger(max) || max < 1 || max > MAX_NARRATIVE_RELATIONSHIP_CANDIDATES ||
      (input.baseOffset !== undefined && (!Number.isSafeInteger(input.baseOffset) ||
        input.baseOffset < 0 || input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para descubrir relaciones narrativas.");
  }
  const ids = new Set<string>();
  const entitiesById = new Map<string, NarrativeEntity>();
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId ||
        typeof entity.id !== "string" || !entity.id.trim() ||
        ids.has(entity.id) || typeof entity.canonicalName !== "string" ||
        !entity.canonicalName.trim() || !Array.isArray(entity.aliases) ||
        entity.aliases.some(alias => typeof alias !== "string" || !alias.trim())) {
      throw new Error("Las entidades deben ser únicas, válidas y pertenecer al mismo proyecto.");
    }
    ids.add(entity.id);
    entitiesById.set(entity.id, entity);
  }
  const profiles = input.descriptiveProfiles ?? [];
  if (profiles.length > 2_000) {
    throw new Error("Se excedió el máximo de perfiles descriptivos.");
  }
  const profileIds = new Set<string>();
  for (const profile of profiles) {
    const entity = profile && entitiesById.get(profile.entityId);
    if (!profile || !entity || entity.kind !== "character" ||
        profileIds.has(profile.entityId) || !Array.isArray(profile.labels) ||
        profile.labels.length > 100) {
      throw new Error("Perfil descriptivo inválido: debe pertenecer a un personaje único.");
    }
    profileIds.add(profile.entityId);
    const labels = new Set<string>();
    for (const label of profile.labels) {
      const ev = label?.evidence;
      if (!label || typeof label.text !== "string" || !label.text.trim() ||
          label.text.length > 120 || !ev ||
          typeof ev.documentId !== "string" || !ev.documentId.trim() ||
          !Number.isSafeInteger(ev.revision) || ev.revision < 0 ||
          !Number.isSafeInteger(ev.start) || ev.start < 0 ||
          !Number.isSafeInteger(ev.end) || ev.end <= ev.start ||
          typeof ev.excerpt !== "string" || !ev.excerpt.trim() ||
          (ev.status !== undefined && ev.status !== "stale")) {
        throw new Error("Cada etiqueta descriptiva debe tener texto y evidencia de procedencia válidos.");
      }
      const normalized = normalize(label.text);
      if (labels.has(normalized)) {
        throw new Error("Un perfil no puede repetir descripciones equivalentes.");
      }
      labels.add(normalized);
    }
  }
}

/**
 * Descubre relaciones expresadas en el texto, sin convertirlas en hechos confirmados.
 * Admite «el hermano de Ana» si «el hermano» está vinculado a un personaje por
 * un perfil descriptivo validado, y «Ana es hermana de Bruno» con dos nombres.
 * Los posesivos «su» se excluyen: requieren resolver primero su antecedente.
 */
export function discoverNarrativeRelationships(
  input: NarrativeRelationshipDiscoveryInput
): readonly NarrativeRelationshipCandidate[] {
  validate(input);
  const base = input.baseOffset ?? 0;
  const max = input.maxCandidates ?? DEFAULT_NARRATIVE_RELATIONSHIP_CANDIDATES;
  const entityById = new Map(input.entities.map(e => [e.id, e]));
  const found = new Map<string, NarrativeRelationshipCandidate>();
  const add = (from: NarrativeEntity, to: NarrativeEntity, type: NarrativeRelationshipCandidate["relationType"],
    surface: string, relStart: number, relEnd: number, fromStart: number, fromEnd: number,
    toStart: number, toEnd: number, fromText: string, toText: string) => {
    if (from.id === to.id) return;
    const key = [from.id, to.id, type, relStart, relEnd].join(":");
    found.set(key, {
      id: "relationship-candidate:" + JSON.stringify([input.documentId, input.revision, base + relStart, base + relEnd, from.id, to.id, type]),
      projectId: input.projectId, documentId: input.documentId, revision: input.revision,
      fromEntityId: from.id, toEntityId: to.id, relationType: type, surface,
      relationEvidence: evidence(input.documentId, input.revision, base, relStart, relEnd, surface),
      fromEvidence: evidence(input.documentId, input.revision, base, fromStart, fromEnd, fromText),
      toEvidence: evidence(input.documentId, input.revision, base, toStart, toEnd, toText),
      status: "single-candidate", reviewStatus: "candidate"
    });
  };

  // Patrón nominal: «Ana es hermana de Bruno», «Bruno era amigo de Ana».
  const names = input.entities.flatMap(entity =>
    [entity.canonicalName, ...entity.aliases].filter(Boolean).map(name => ({ entity, name }))
  ).sort((a,b) => b.name.length-a.name.length);
  for (const left of names) for (const right of names) {
    if (left.entity.id === right.entity.id) continue;
    const pattern = new RegExp(
      "(?<![\\p{L}\\p{M}\\p{N}_])" + escapeRegExp(left.name) +
      "\\s+(?:es|era|fue|será)\\s+(" +
      RELATIONS.map(r => r.expression).join("|") +
      ")\\s+de\\s+(?:" + escapeRegExp(right.name) + ")(?![\\p{L}\\p{M}\\p{N}_])",
      "giu"
    );
    for (const match of input.text.matchAll(pattern)) {
      const rel = match[1]!;
      const relStart = match.index! + match[0].indexOf(rel);
      const relType = RELATIONS.find(r => r.expression.split("|").includes(rel.toLocaleLowerCase("es")))!.relationType;
      const leftStart = match.index!;
      const leftEnd = leftStart + left.name.length;
      const rightStart = match.index! + match[0].lastIndexOf(right.name);
      add(left.entity, right.entity, relType, rel, relStart, relStart + rel.length,
        leftStart, leftEnd, rightStart, rightStart + right.name.length, left.name, right.name);
    }
  }

  // Descriptor vinculado a personaje + complemento «de + nombre».
  for (const profile of input.descriptiveProfiles ?? []) {
    const from = entityById.get(profile.entityId)!;
    for (const label of profile.labels) {
      if (label.evidence.status === "stale") continue;
      const rel = RELATIONS.find(r => new RegExp("^(?:el |la |los |las )?(?:" + r.expression + ")$", "iu").test(label.text.trim()));
      if (!rel) continue;
      const descriptor = new RegExp(
        "(?<![\\p{L}\\p{M}\\p{N}_])" + escapeRegExp(label.text) +
        "\\s+de\\s+(" + names.map(n => escapeRegExp(n.name)).join("|") +
        ")(?![\\p{L}\\p{M}\\p{N}_])", "giu"
      );
      for (const match of input.text.matchAll(descriptor)) {
        const targetText = match[1]!;
        const targetStart = match.index! + match[0].lastIndexOf(targetText);
        const matching = names.filter(n => normalize(n.name) === normalize(targetText));
        for (const target of matching) {
          add(from, target.entity, rel.relationType, label.text,
            match.index!, match.index! + label.text.length,
            match.index!, match.index! + label.text.length,
            targetStart, targetStart + targetText.length, label.text, targetText);
        }
      }
    }
  }
  const values = [...found.values()];
  const ambiguity = new Map<string, Set<string>>();
  for (const item of values) {
    const key = [item.relationEvidence.start, item.relationEvidence.end,
      item.toEntityId, item.relationType].join(":");
    const ids = ambiguity.get(key) ?? new Set<string>();
    ids.add(item.fromEntityId);
    ambiguity.set(key, ids);
  }
  return values.map(item => {
    const key = [item.relationEvidence.start, item.relationEvidence.end,
      item.toEntityId, item.relationType].join(":");
    return { ...item, status: ambiguity.get(key)!.size > 1 ? "ambiguous" as const : "single-candidate" as const };
  }).sort((a,b) => a.relationEvidence.start-b.relationEvidence.start ||
    a.fromEntityId.localeCompare(b.fromEntityId) || a.toEntityId.localeCompare(b.toEntityId)).slice(0,max);
}
