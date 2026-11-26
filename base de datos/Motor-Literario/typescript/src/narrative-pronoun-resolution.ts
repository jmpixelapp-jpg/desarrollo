/**
 * Resolución conservadora de referencias pronominales.
 *
 * No deduce género gramatical a partir del nombre ni interpreta prosa libre.
 * El extractor lingüístico que llama a este módulo debe proporcionar menciones
 * y rasgos gramaticales explícitos. Este módulo solo compara evidencia,
 * proximidad y compatibilidad; nunca convierte una ambigüedad en identidad.
 */

export type NarrativeGrammaticalNumber = "singular" | "plural";
export type NarrativeGrammaticalGender = "masculine" | "feminine" | "neutral" | "unknown";

export interface NarrativeCharacterMention {
  readonly characterId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly start: number;
  readonly end: number;
  readonly grammaticalNumber: NarrativeGrammaticalNumber;
  readonly grammaticalGender: NarrativeGrammaticalGender;
}

export interface NarrativePronounReference {
  readonly id: string;
  readonly documentId: string;
  readonly revision: number;
  readonly start: number;
  readonly end: number;
  readonly surface: string;
  readonly grammaticalNumber: NarrativeGrammaticalNumber;
  readonly grammaticalGender: NarrativeGrammaticalGender;
}

export interface NarrativePronounResolution {
  readonly referenceId: string;
  readonly status: "resolved" | "ambiguous" | "unresolved";
  readonly characterId?: string;
  readonly candidateCharacterIds: readonly string[];
  readonly antecedentEvidence: readonly {
    readonly documentId: string;
    readonly revision: number;
    readonly start: number;
    readonly end: number;
  }[];
  readonly reason:
    | "unique-compatible-antecedent"
    | "multiple-compatible-antecedents"
    | "no-compatible-antecedent";
}

export interface NarrativePronounResolutionOptions {
  /** Distancia máxima en unidades UTF-16 entre antecedente y referencia. */
  readonly maxDistance?: number;
  /** Cuando true, solo considera menciones anteriores en la misma oración. */
  readonly sameSentenceOnly?: boolean;
}

const DEFAULT_MAX_DISTANCE = 1200;
const MAX_MAX_DISTANCE = 100_000;

function isValidMention(item: NarrativeCharacterMention): boolean {
  return !!item && typeof item.characterId === "string" && !!item.characterId.trim() &&
    typeof item.documentId === "string" && !!item.documentId.trim() &&
    Number.isSafeInteger(item.revision) && item.revision >= 0 &&
    Number.isSafeInteger(item.start) && item.start >= 0 &&
    Number.isSafeInteger(item.end) && item.end > item.start &&
    ["singular", "plural"].includes(item.grammaticalNumber) &&
    ["masculine", "feminine", "neutral", "unknown"].includes(item.grammaticalGender);
}

function isValidReference(item: NarrativePronounReference): boolean {
  return !!item && typeof item.id === "string" && !!item.id.trim() &&
    typeof item.documentId === "string" && !!item.documentId.trim() &&
    Number.isSafeInteger(item.revision) && item.revision >= 0 &&
    Number.isSafeInteger(item.start) && item.start >= 0 &&
    Number.isSafeInteger(item.end) && item.end > item.start &&
    typeof item.surface === "string" && !!item.surface.trim() &&
    ["singular", "plural"].includes(item.grammaticalNumber) &&
    ["masculine", "feminine", "neutral", "unknown"].includes(item.grammaticalGender);
}

function compatible(
  reference: NarrativePronounReference,
  mention: NarrativeCharacterMention
): boolean {
  if (reference.grammaticalNumber !== mention.grammaticalNumber) return false;
  // Un rasgo desconocido en la referencia no permite filtrar candidatos.
  // Pero un antecedente desconocido no puede confirmar un pronombre marcado.
  if (reference.grammaticalGender === "unknown") return true;
  if (mention.grammaticalGender === "unknown") return false;
  // "Neutral" es una clase explícita distinta: no se equipara automáticamente
  // con masculino o femenino.
  return reference.grammaticalGender === mention.grammaticalGender;
}

function sameSentence(text: string, leftEnd: number, rightStart: number): boolean {
  if (leftEnd > rightStart || rightStart > text.length) return false;
  const between = text.slice(leftEnd, rightStart);
  return !/[.!?;\n\r]/u.test(between);
}

/**
 * Resuelve referencias usando solo menciones previas verificadas en el mismo
 * documento y revisión. Si más de un personaje sigue siendo compatible,
 * devuelve ambiguous; si ninguno, unresolved.
 */
export function resolveNarrativePronounReferences(
  text: string,
  mentions: readonly NarrativeCharacterMention[],
  references: readonly NarrativePronounReference[],
  options: NarrativePronounResolutionOptions = {}
): readonly NarrativePronounResolution[] {
  if (typeof text !== "string" || !Array.isArray(mentions) ||
      !Array.isArray(references) || !options || typeof options !== "object") {
    throw new Error("Entrada inválida para resolver referencias narrativas.");
  }
  const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const sameSentenceOnly = options.sameSentenceOnly ?? false;
  if (!Number.isSafeInteger(maxDistance) || maxDistance < 1 ||
      maxDistance > MAX_MAX_DISTANCE || typeof sameSentenceOnly !== "boolean") {
    throw new Error("Opciones inválidas para resolver referencias narrativas.");
  }
  if (mentions.some(item => !isValidMention(item) || item.end > text.length) ||
      references.some(item => !isValidReference(item) || item.end > text.length)) {
    throw new Error("Mención o referencia fuera del texto o con estructura inválida.");
  }
  const seenIds = new Set<string>();
  for (const reference of references) {
    if (seenIds.has(reference.id)) throw new Error("Identificador de referencia duplicado.");
    seenIds.add(reference.id);
  }

  return references.map(reference => {
    const inScope = mentions.filter(mention =>
      mention.documentId === reference.documentId &&
      mention.revision === reference.revision &&
      mention.end <= reference.start &&
      reference.start - mention.end <= maxDistance &&
      compatible(reference, mention) &&
      (!sameSentenceOnly || sameSentence(text, mention.end, reference.start))
    );
    if (inScope.length === 0) {
      return {
        referenceId: reference.id,
        status: "unresolved" as const,
        candidateCharacterIds: [],
        antecedentEvidence: [],
        reason: "no-compatible-antecedent" as const
      };
    }

    // Agrupa las menciones repetidas del mismo personaje: varias repeticiones
    // del mismo antecedente no deben producir una falsa ambigüedad.
    const byCharacter = new Map<string, NarrativeCharacterMention[]>();
    for (const mention of inScope) {
      const list = byCharacter.get(mention.characterId) ?? [];
      list.push(mention);
      byCharacter.set(mention.characterId, list);
    }

    // Solo la mención más cercana de cada identidad aporta evidencia para
    // comparar candidatos; las menciones más antiguas quedan como historial.
    const nearest = [...byCharacter.entries()].map(([characterId, items]) => ({
      characterId,
      mention: items.sort((a, b) => b.end - a.end || b.start - a.start)[0]!
    })).sort((a, b) => b.mention.end - a.mention.end);

    if (nearest.length === 1) {
      return {
        referenceId: reference.id,
        status: "resolved" as const,
        characterId: nearest[0]!.characterId,
        candidateCharacterIds: [nearest[0]!.characterId],
        antecedentEvidence: [{
          documentId: nearest[0]!.mention.documentId,
          revision: nearest[0]!.mention.revision,
          start: nearest[0]!.mention.start,
          end: nearest[0]!.mention.end
        }],
        reason: "unique-compatible-antecedent" as const
      };
    }

    // La proximidad ordena candidatos, pero no desempata: sin un modelo
    // sintáctico fiable no se afirma que el más cercano sea el sujeto.
    return {
      referenceId: reference.id,
      status: "ambiguous" as const,
      candidateCharacterIds: nearest.map(item => item.characterId).sort(),
      antecedentEvidence: nearest.map(item => ({
        documentId: item.mention.documentId,
        revision: item.mention.revision,
        start: item.mention.start,
        end: item.mention.end
      })).sort((a, b) => a.start - b.start),
      reason: "multiple-compatible-antecedents" as const
    };
  });
}
