import type { NarrativeTimeReference, TextEvidence, NarrativeEntity } from "./narrative-knowledge";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\export interface NarrativeAssertion {");
}

export interface NarrativeAssertion {
  readonly projectId: string;
  readonly id: string;
  readonly entityId: string;
  readonly entityName: string;
  readonly attribute: "age" | "location" | "role";
  readonly value: string | number;
  readonly evidence: TextEvidence;
  readonly timeReference?: NarrativeTimeReference;
  readonly capturedAt: number;
}

export function extractNarrativeAssertions(
  projectId: string, documentId: string, revision: number, text: string,
  entities: readonly NarrativeEntity[], baseOffset = 0, now = Date.now()
): readonly NarrativeAssertion[] {
  if (typeof projectId !== "string" || !projectId.trim() ||
      typeof documentId !== "string" || !documentId.trim() ||
      !Number.isSafeInteger(revision) || revision < 0 ||
      typeof text !== "string" ||
      !Number.isSafeInteger(baseOffset) || baseOffset < 0 ||
      baseOffset > Number.MAX_SAFE_INTEGER - text.length ||
      !Number.isFinite(now) || now < 0 ||
      !Array.isArray(entities)) {
    throw new Error("Contexto de afirmaciones narrativas inválido.");
  }
  const validatedEntities = entities as readonly NarrativeEntity[];
  for (const entity of validatedEntities) {
    if (!entity || entity.projectId !== projectId ||
        typeof entity.id !== "string" || !entity.id.trim() ||
        (typeof entity.kind !== "string" || !entity.kind.trim()) ||
        typeof entity.canonicalName !== "string" || !entity.canonicalName.trim() ||
        typeof entity.normalizedName !== "string" || !entity.normalizedName.trim() ||
        !Array.isArray(entity.aliases) ||
        entity.aliases.some((alias: unknown) => typeof alias !== "string" || !alias.trim())) {
      throw new Error("Colección de entidades inválida o perteneciente a otro proyecto.");
    }
  }
  const definitions: {
    readonly attribute: NarrativeAssertion["attribute"];
    readonly suffix: string;
    readonly capture: (match: RegExpExecArray) => string | number;
  }[] = [];
  if (/\b(?:tiene|tenía|tendrá)\s+\d{1,3}\s+años?\b/iu.test(text)) {
    definitions.push({
      attribute: "age" as const,
      suffix: "\\s+(?:tiene|tenía|tendrá)\\s+(\\d{1,3})\\s+años?\\b",
      capture: (m: RegExpExecArray) => Number(m[1])
    });
  }
  if (/\b(?:vive|vivía|reside|residía|se encuentra|está)\s+en\s+[^,.!?;\n]+/iu.test(text)) {
    definitions.push({
      attribute: "location" as const,
      suffix: "(?:\\s+(?:tiene|tenía|tendrá)\\s+\\d{1,3}\\s+años?\\s+y)?\\s+(?:vive|vivía|reside|residía|se encuentra|está)\\s+en\\s+([^,.!?;\\n]+?)(?=\\s+(?:y|pero|aunque|porque|mientras)\\s+|[,.!?;\\n]|$)",
      capture: (m: RegExpExecArray) => (m[1] ?? "").trim()
    });
  }
  if (/\b(?:es|era|será)\s+(?:el|la|un|una)?\s*(?:rey|reina|príncipe|princesa|emperador|emperatriz|capitán|capitana|general|alcalde|alcaldesa|caballero|guardiana|guardián)\b/iu.test(text)) {
    definitions.push({
      attribute: "role" as const,
      suffix: "(?:\\s+(?:tiene|tenía|tendrá)\\s+\\d{1,3}\\s+años?\\s+y)?\\s+(?:es|era|será)\\s+(?:el|la|un|una)?\\s*(rey|reina|príncipe|princesa|emperador|emperatriz|capitán|capitana|general|alcalde|alcaldesa|caballero|guardiana|guardián)\\b",
      capture: (m: RegExpExecArray) => (m[1] ?? "").toLocaleLowerCase("es")
    });
  }
  if (definitions.length === 0) return [];

  const characters = validatedEntities.filter(entity => entity.projectId === projectId && entity.kind === "character");
  const output: NarrativeAssertion[] = [];
  for (const entity of characters) {
    const names = [entity.canonicalName, ...entity.aliases];
    for (const definition of definitions) {
      for (const name of names) {
      const escapedName = escapeRegExp(name);
      const expression = new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])" + escapedName + "(?![\\p{L}\\p{M}\\p{N}_])" + definition.suffix, "giu");
      for (const match of text.matchAll(expression)) {
        const value = definition.capture(match);
        if (typeof value === "string" && !value) continue;
        const localStart = match.index;
        const localEnd = localStart + match[0].length;
        const lineStart = text.lastIndexOf("\n", localStart - 1) + 1;
        const lineBreak = text.indexOf("\n", localEnd);
        const lineEnd = lineBreak < 0 ? text.length : lineBreak;
        const start = baseOffset + localStart;
        const excerpt = text.slice(lineStart, lineEnd);
        const evidence: TextEvidence = { documentId, revision, start, end: baseOffset + localEnd, excerpt };
        const timeReference = explicitTimeReference(excerpt, localStart - lineStart);
        output.push({
          projectId, id: "assertion:" + entity.id + ":" + documentId + ":" + revision + ":" + start + ":" + definition.attribute,
          entityId: entity.id, entityName: entity.canonicalName, attribute: definition.attribute,
          value, evidence, ...(timeReference ? { timeReference } : {}), capturedAt: now
        });
      }
      }
    }
  }
  return output;
}

function explicitTimeReference(
  text: string, anchorOffset = 0
): NarrativeTimeReference | undefined {
  const candidates: { readonly index: number; readonly reference: NarrativeTimeReference }[] = [];
  const addCalendarDate = (raw: string, index: number, year: number, month: number, day: number) => {
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day) return;
    const orderValue = Math.floor(date.getTime() / 86400000);
    if (Number.isFinite(orderValue)) {
      candidates.push({
        index,
        reference: { basis: "calendar", precision: "date", raw, orderValue }
      });
    }
  };

  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/gu)) {
    addCalendarDate(match[0], match.index, Number(match[1]), Number(match[2]), Number(match[3]));
  }
  for (const match of text.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/gu)) {
    addCalendarDate(match[0], match.index, Number(match[3]), Number(match[2]), Number(match[1]));
  }
  for (const match of text.matchAll(/\b(?:día|jornada)\s+(\d{1,6})\b/giu)) {
    const orderValue = Number(match[1]);
    if (orderValue > 0) {
      candidates.push({
        index: match.index,
        reference: { basis: "story-day", precision: "day-index", raw: match[0], orderValue }
      });
    }
  }
  for (const match of text.matchAll(/\baño\s+(\d{1,6})\b/giu)) {
    const year = Number(match[1]);
    if (year <= 0) continue;
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, 0, 1);
    const orderValue = Math.floor(date.getTime() / 86400000);
    if (Number.isFinite(orderValue)) {
      candidates.push({
        index: match.index,
        reference: { basis: "calendar", precision: "year", raw: match[0], orderValue }
      });
    }
  }

  candidates.sort((a, b) =>
    Math.abs(a.index - anchorOffset) - Math.abs(b.index - anchorOffset) ||
    Number(b.index <= anchorOffset) - Number(a.index <= anchorOffset) ||
    a.index - b.index
  );
  return candidates[0]?.reference;
}
