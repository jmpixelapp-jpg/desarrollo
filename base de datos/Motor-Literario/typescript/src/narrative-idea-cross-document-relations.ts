import type { NarrativeIdeaCandidate } from "./narrative-idea-discovery";

export interface NarrativeIdeaCrossDocumentAnalysisInput {
  readonly projectId: string;
  /** Candidatos actuales y anteriores del mismo proyecto. */
  readonly ideaCandidates: readonly NarrativeIdeaCandidate[];
  /** Orden editorial explícito. Sin él, las relaciones permanecen no direccionales. */
  readonly orderedDocumentIds?: readonly string[];
}

export interface NarrativeIdeaOccurrenceReference {
  readonly ideaCandidateId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly kind: NarrativeIdeaCandidate["kind"];
  readonly polarity: NarrativeIdeaCandidate["polarity"];
  readonly text: string;
  readonly evidence: NarrativeIdeaCandidate["evidence"];
}

export interface NarrativeIdeaCrossDocumentRelation {
  readonly id: string;
  readonly projectId: string;
  readonly relationType: "exact-recurrence" | "lexical-resonance";
  readonly reviewStatus: "candidate";
  /** Señala cambios de modalidad sin elevarlos a contradicción objetiva. */
  readonly polarityRelation: "consistent" | "changed";
  readonly first: NarrativeIdeaOccurrenceReference;
  readonly second: NarrativeIdeaOccurrenceReference;
  /** Solo indica si el proyecto suministró un orden documental inequívoco. */
  readonly chronology: "ordered" | "unknown";
  readonly earlierDocumentId?: string;
  readonly laterDocumentId?: string;
  readonly normalizedSimilarity: number;
  readonly overlapCoefficient: number;
  /** Términos de contenido coincidentes; no son una paráfrasis ni una equivalencia semántica. */
  readonly sharedTerms: readonly string[];
}

export interface NarrativeIdeaCrossDocumentAnalysis {
  readonly projectId: string;
  readonly analyzedCandidateCount: number;
  readonly comparedCrossDocumentPairs: number;
  readonly truncated: boolean;
  readonly relations: readonly NarrativeIdeaCrossDocumentRelation[];
}

/** La comparación por pares está acotada para no crecer cuadráticamente sin límite. */
export const MAX_NARRATIVE_IDEA_CROSS_DOCUMENT_CANDIDATES = 200;
export const MAX_NARRATIVE_IDEA_CROSS_DOCUMENT_RELATIONS = 10_000;
export const MAX_NARRATIVE_IDEA_CROSS_DOCUMENT_TEXT_UNITS = 500;

const STOP_WORDS = new Set([
  "a", "al", "algo", "algunas", "algunos", "ante", "antes", "como", "con",
  "contra", "cual", "cuando", "de", "del", "desde", "donde", "dos", "durante",
  "e", "el", "ella", "ellas", "ello", "ellos", "en", "entre", "era", "eran",
  "es", "esa", "esas", "ese", "eso", "esos", "esta", "estaba", "estaban",
  "estan", "estar", "este", "esto", "estos", "fue", "fueron", "ha", "habia",
  "han", "hasta", "hay", "la", "las", "le", "les", "lo", "los", "mas", "me",
  "mi", "mis", "muy", "ni", "no", "nos", "o", "otra", "otras", "otro", "otros",
  "para", "pero", "por", "porque", "que", "quien", "se", "sin", "sobre", "su",
  "sus", "tambien", "te", "tiene", "tienen", "todo", "todos", "tu", "tus",
  "un", "una", "unas", "uno", "unos", "y", "ya",
  "about", "after", "all", "also", "an", "and", "are", "as", "at", "be",
  "been", "before", "being", "but", "by", "for", "from", "had", "has", "have",
  "he", "her", "hers", "him", "his", "how", "i", "if", "in", "into", "is",
  "it", "its", "me", "more", "most", "my", "no", "not", "of", "on", "or",
  "our", "she", "so", "than", "that", "the", "their", "them", "there",
  "these", "they", "this", "those", "to", "was", "we", "were", "what",
  "when", "where", "which", "who", "will", "with", "you", "your"
]);

interface NormalizedIdeaText {
  readonly phrase: string;
  readonly tokens: ReadonlySet<string>;
}

function normalizeText(value: string): NormalizedIdeaText {
  const phrase = value.normalize("NFKD")
    .replace(/\\p{M}/gu, "")
    .toLocaleLowerCase("es")
    .replace(/[\\p{P}\\p{S}]+/gu, " ")
    .replace(/\\s+/gu, " ")
    .trim()
    .normalize("NFKC");
  const tokens = new Set(
    (phrase.match(/[\\p{L}\\p{N}]{3,}/gu) ?? [])
      .filter(token => !STOP_WORDS.has(token))
  );
  return { phrase, tokens };
}

function validateInput(input: NarrativeIdeaCrossDocumentAnalysisInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      !Array.isArray(input.ideaCandidates) ||
      input.ideaCandidates.length > MAX_NARRATIVE_IDEA_CROSS_DOCUMENT_CANDIDATES ||
      (input.orderedDocumentIds !== undefined &&
        (!Array.isArray(input.orderedDocumentIds) || input.orderedDocumentIds.length > 10_000))) {
    throw new Error("Contexto inválido para relacionar ideas entre documentos.");
  }

  const candidateIds = new Set<string>();
  for (const candidate of input.ideaCandidates) {
    if (!candidate || candidate.projectId !== input.projectId ||
        typeof candidate.id !== "string" || !candidate.id.trim() ||
        candidateIds.has(candidate.id) ||
        typeof candidate.documentId !== "string" || !candidate.documentId.trim() ||
        !Number.isSafeInteger(candidate.revision) || candidate.revision < 0 ||
        typeof candidate.text !== "string" || !candidate.text.trim() ||
        candidate.text.length > MAX_NARRATIVE_IDEA_CROSS_DOCUMENT_TEXT_UNITS ||
        !["theme", "premise", "conflict", "goal", "motivation", "dilemma", "question", "hypothesis", "motif"].includes(candidate.kind) ||
        !["affirmed", "negated", "conditional", "hypothetical"].includes(candidate.polarity) ||
        !["high", "medium"].includes(candidate.confidence) || candidate.reviewStatus !== "candidate" ||
        !candidate.evidence ||
        candidate.evidence.documentId !== candidate.documentId ||
        candidate.evidence.revision !== candidate.revision ||
        !Number.isSafeInteger(candidate.evidence.start) ||
        !Number.isSafeInteger(candidate.evidence.end) ||
        candidate.evidence.start < 0 || candidate.evidence.end <= candidate.evidence.start ||
        typeof candidate.evidence.excerpt !== "string" ||
        candidate.evidence.excerpt.length > 2_000_000 ||
        !candidate.evidence.excerpt.includes(candidate.text)) {
      throw new Error("Candidato de idea inválido, duplicado o ajeno al proyecto.");
    }
    candidateIds.add(candidate.id);
  }

  if (input.orderedDocumentIds) {
    const documentIds = new Set<string>();
    for (const documentId of input.orderedDocumentIds) {
      if (typeof documentId !== "string" || !documentId.trim() || documentIds.has(documentId)) {
        throw new Error("El orden documental contiene IDs vacíos o repetidos.");
      }
      documentIds.add(documentId);
    }
  }
}

function occurrence(candidate: NarrativeIdeaCandidate): NarrativeIdeaOccurrenceReference {
  return {
    ideaCandidateId: candidate.id,
    documentId: candidate.documentId,
    revision: candidate.revision,
    kind: candidate.kind,
    polarity: candidate.polarity,
    text: candidate.text,
    evidence: candidate.evidence
  };
}

function compareCandidateOrder(
  a: NarrativeIdeaCandidate,
  b: NarrativeIdeaCandidate
): number {
  return a.documentId.localeCompare(b.documentId) ||
    a.evidence.start - b.evidence.start ||
    a.id.localeCompare(b.id);
}

/**
 * Propone recurrencias exactas y resonancias léxicas entre documentos distintos.
 * No identifica paráfrasis ni declara que dos candidatos expresen la misma idea.
 */
export function analyzeNarrativeIdeaCrossDocumentRelations(
  input: NarrativeIdeaCrossDocumentAnalysisInput
): NarrativeIdeaCrossDocumentAnalysis {
  validateInput(input);

  const candidates = [...input.ideaCandidates].sort(compareCandidateOrder);
  const normalized = candidates.map(candidate => normalizeText(candidate.text));
  const documentIds = new Set(candidates.map(candidate => candidate.documentId));
  const documentFrequency = new Map<string, Set<string>>();

  for (let index = 0; index < candidates.length; index++) {
    const documentId = candidates[index]!.documentId;
    for (const token of normalized[index]!.tokens) {
      const documents = documentFrequency.get(token) ?? new Set<string>();
      documents.add(documentId);
      documentFrequency.set(token, documents);
    }
  }

  const maximumCommonDocumentFrequency = Math.max(
    2,
    Math.min(40, Math.ceil(documentIds.size * 0.4))
  );
  const commonTerms = new Set(
    [...documentFrequency]
      .filter(([, documents]) => documents.size > maximumCommonDocumentFrequency)
      .map(([token]) => token)
  );
  const filteredTokens = normalized.map(item =>
    new Set([...item.tokens].filter(token => !commonTerms.has(token)))
  );

  const documentOrder = new Map<string, number>();
  for (const [index, documentId] of (input.orderedDocumentIds ?? []).entries()) {
    documentOrder.set(documentId, index);
  }

  const relations: NarrativeIdeaCrossDocumentRelation[] = [];
  let comparedCrossDocumentPairs = 0;

  for (let firstIndex = 0; firstIndex < candidates.length; firstIndex++) {
    const firstCandidate = candidates[firstIndex]!;
    const firstNormalized = normalized[firstIndex]!;
    const firstTokens = filteredTokens[firstIndex]!;

    for (let secondIndex = firstIndex + 1; secondIndex < candidates.length; secondIndex++) {
      const secondCandidate = candidates[secondIndex]!;
      if (firstCandidate.documentId === secondCandidate.documentId) continue;
      comparedCrossDocumentPairs++;

      const secondNormalized = normalized[secondIndex]!;
      const secondTokens = filteredTokens[secondIndex]!;
      const exactRecurrence = firstNormalized.phrase.length > 0 &&
        firstNormalized.phrase === secondNormalized.phrase;

      const sharedTerms = [...firstTokens]
        .filter(token => secondTokens.has(token))
        .sort((a, b) => a.localeCompare(b));

      let normalizedSimilarity = 0;
      let overlapCoefficient = 0;
      let relationType: NarrativeIdeaCrossDocumentRelation["relationType"];

      if (exactRecurrence) {
        relationType = "exact-recurrence";
        normalizedSimilarity = 1;
        overlapCoefficient = 1;
      } else {
        if (sharedTerms.length < 2) continue;
        const unionSize = firstTokens.size + secondTokens.size - sharedTerms.length;
        const smallerSize = Math.min(firstTokens.size, secondTokens.size);
        if (unionSize === 0 || smallerSize === 0) continue;
        normalizedSimilarity = sharedTerms.length / unionSize;
        overlapCoefficient = sharedTerms.length / smallerSize;

        // Señal exploratoria amplia, pero siempre explicable por términos visibles.
        if (normalizedSimilarity < 0.12 && overlapCoefficient < 0.4) continue;
        relationType = "lexical-resonance";
      }

      const earlierIndex = documentOrder.get(firstCandidate.documentId);
      const laterIndex = documentOrder.get(secondCandidate.documentId);
      const chronologyKnown = earlierIndex !== undefined && laterIndex !== undefined &&
        earlierIndex !== laterIndex;
      const earlierDocumentId = chronologyKnown
        ? (earlierIndex! < laterIndex! ? firstCandidate.documentId : secondCandidate.documentId)
        : undefined;
      const laterDocumentId = chronologyKnown
        ? (earlierIndex! < laterIndex! ? secondCandidate.documentId : firstCandidate.documentId)
        : undefined;
      const idParts = [firstCandidate.id, secondCandidate.id].map(encodeURIComponent);

      relations.push({
        id: "idea-cross-document:" + idParts[0] + ":" + idParts[1] + ":" + relationType,
        projectId: input.projectId,
        relationType,
        reviewStatus: "candidate",
        polarityRelation: firstCandidate.polarity === secondCandidate.polarity ? "consistent" : "changed",
        first: occurrence(firstCandidate),
        second: occurrence(secondCandidate),
        chronology: chronologyKnown ? "ordered" : "unknown",
        ...(earlierDocumentId && laterDocumentId ? {
          earlierDocumentId,
          laterDocumentId
        } : {}),
        normalizedSimilarity,
        overlapCoefficient,
        sharedTerms
      });
    }
  }

  relations.sort((a, b) =>
    (a.relationType === b.relationType ? 0 : a.relationType === "exact-recurrence" ? -1 : 1) ||
    b.normalizedSimilarity - a.normalizedSimilarity ||
    a.first.ideaCandidateId.localeCompare(b.first.ideaCandidateId) ||
    a.second.ideaCandidateId.localeCompare(b.second.ideaCandidateId)
  );

  const truncated = relations.length > MAX_NARRATIVE_IDEA_CROSS_DOCUMENT_RELATIONS;
  return {
    projectId: input.projectId,
    analyzedCandidateCount: candidates.length,
    comparedCrossDocumentPairs,
    truncated,
    relations: relations.slice(0, MAX_NARRATIVE_IDEA_CROSS_DOCUMENT_RELATIONS)
  };
}
