import type { NarrativeEntity } from "./narrative-knowledge";

export interface NarrativeCharacterIntentInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
}

export interface NarrativeCharacterIntentCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly characterEntityId: string;
  readonly kind: "goal" | "motivation";
  readonly text: string;
  readonly polarity: "affirmed" | "negated" | "conditional";
  /** Señal lingüística literal; no confirma una motivación psicológica. */
  readonly evidenceBasis?: "explicit-goal-verb" | "explicit-causal-motive" | "explicit-purpose";
  readonly reviewStatus: "candidate";
  readonly evidence: {
    readonly documentId: string;
    readonly revision: number;
    readonly start: number;
    readonly end: number;
    readonly excerpt: string;
  };
}

const MAX_TEXT = 2_000_000;
const MAX_ENTITIES = 500;
const MAX_RESULTS = 200;
const MAX_NAME = 120;
const MAX_INTENT = 500;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^\${}()|[\]\\]/gu, "\\$&");
}

/** Solo atribuye intenciones cuando el personaje está nombrado en la misma oración. */
export function extractNarrativeCharacterIntentCandidates(
  input: NarrativeCharacterIntentInput
): readonly NarrativeCharacterIntentCandidate[] {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_TEXT ||
      !Array.isArray(input.entities) || input.entities.length > MAX_ENTITIES ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
          input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para extraer intenciones de personajes.");
  }

  const entities = input.entities.filter(entity =>
    entity && entity.projectId === input.projectId && entity.kind === "character"
  );
  const base = input.baseOffset ?? 0;
  const results = new Map<string, NarrativeCharacterIntentCandidate>();
  const goal = /\b(?:quiere|desea|pretende|intenta|busca|necesita|sueña\s+con)\s+(.+?)\s*$/iu;
  const motive = /\b(?:actúa|actua|lo\s+hace|decide\s+hacerlo)\s+porque\s+(.+?)\s*$/iu;
  const because = /\bporque\s+((?:quiere|desea|teme|necesita)\s+.+?)\s*$/iu;
  // Motivos indirectos: solo se extraen cuando el texto nombra la causa
  // mediante una construcción explícita; nunca se deducen por la acción sola.
  const causalMotive = /\bpor\s+((?:miedo|temor|amor|lealtad|venganza|deber|culpa|compasión|compasion)\s+(?:a|de|hacia|contra)\s+.+?)\s*$/iu;
  const purpose = /\b(?:para|a\s+fin\s+de|con\s+el\s+fin\s+de)\s+(.+?)\s*$/iu;
  const patterns = [
    {kind:"goal" as const, evidenceBasis:"explicit-goal-verb" as const, expression:goal},
    {kind:"motivation" as const, evidenceBasis:"explicit-causal-motive" as const, expression:motive},
    {kind:"motivation" as const, evidenceBasis:"explicit-causal-motive" as const, expression:because},
    {kind:"motivation" as const, evidenceBasis:"explicit-causal-motive" as const, expression:causalMotive},
    {kind:"goal" as const, evidenceBasis:"explicit-purpose" as const, expression:purpose}
  ];

  for (const line of input.text.matchAll(/[^\n]+/gu)) {
    const lineStart = line.index;
    for (const sentence of line[0].matchAll(/[^.!?]+(?:[.!?]+|$)/gu)) {
      if (results.size >= MAX_RESULTS) break;
      const raw = sentence[0];
      const leading = raw.search(/\S/u);
      const endTrimmed = raw.trimEnd().length;
      if (leading < 0 || endTrimmed <= leading) continue;
      const segmentStart = lineStart + sentence.index + leading;
      const excerpt = input.text.slice(segmentStart, lineStart + sentence.index + endTrimmed);
      const actorMatches = new Map<string, {entity:NarrativeEntity; end:number}>();
      for (const entity of entities) {
        const names = [...new Set([entity.canonicalName, ...entity.aliases]
          .filter(name => typeof name === "string" && name.trim() && name.length <= MAX_NAME))];
        for (const name of names) {
          const expression = new RegExp("(^|[^\\p{L}\\p{M}\\p{N}_])(" + escapeRegExp(name) + ")(?=$|[^\\p{L}\\p{M}\\p{N}_])", "giu");
          for (const match of excerpt.matchAll(expression)) {
            const end = match.index + match[0].lastIndexOf(match[2]) + match[2].length;
            actorMatches.set(entity.id, {entity, end});
          }
        }
      }
      // Si hay más de una identidad posible, no se asigna la intención a ninguna.
      if (actorMatches.size !== 1) continue;
      const actor = [...actorMatches.values()][0]!;
      const afterActor = excerpt.slice(actor.end);
      if (afterActor.length > 180) continue;
      for (const pattern of patterns) {
        const match = pattern.expression.exec(afterActor);
        if (!match?.[1]) continue;
        const capture = match[1];
        // Separa cláusulas coordinadas: una meta no debe absorber su causa
        // («quiere protegerlo porque teme perderlo») ni su propósito («quiere
        // protegerlo para salvarlo»). Cada cláusula conserva su propio rango.
        const clauseBoundary = pattern.kind === "goal"
          ? /\s+\b(?:porque|ya\s+que|puesto\s+que|para|a\s+fin\s+de|con\s+el\s+fin\s+de)\b/iu.exec(capture)
          : undefined;
        const boundedCapture = clauseBoundary ? capture.slice(0, clauseBoundary.index) : capture;
        const clean = boundedCapture.replace(/[.!?;,:]+$/u, "").trim();
        if (!clean || clean.length > MAX_INTENT) continue;
        const captureStart = match.index + match[0].indexOf(capture) + boundedCapture.search(/\S/u);
        const captureEnd = match.index + match[0].indexOf(capture) + boundedCapture.trimEnd().length;
        const prefix = excerpt.slice(0, actor.end + captureStart);
        const polarity = /\b(?:no|nunca|jamás)\b(?:\s+[\p{L}\p{M}]+){0,3}\s*$/iu.test(prefix)
          ? "negated"
          : /\b(?:si|cuando|en\s+caso\s+de)\b(?:\s+[\p{L}\p{M}]+){0,4}\s*$/iu.test(prefix)
            ? "conditional" : "affirmed";
        const start = base + segmentStart + actor.end + captureStart;
        const end = base + segmentStart + actor.end + captureEnd;
        const id = "character-intent:" + input.documentId + ":" + actor.entity.id + ":" + pattern.kind + ":" + start;
        results.set(id, {
          id, projectId: input.projectId, characterEntityId: actor.entity.id,
          kind: pattern.kind, text: clean, polarity, evidenceBasis: pattern.evidenceBasis, reviewStatus: "candidate",
          evidence: {documentId:input.documentId,revision:input.revision,start,end,excerpt}
        });
      }
    }
    if (results.size >= MAX_RESULTS) break;
  }
  return [...results.values()].sort((a,b)=>a.evidence.start-b.evidence.start || a.id.localeCompare(b.id));
}
