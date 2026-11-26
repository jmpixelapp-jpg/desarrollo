/**
 * Extrae referencias temporales explícitas sin resolver cronología relativa
 * cuando falta un ancla narrativa verificable.
 */
import type { TextEvidence } from "./narrative-knowledge";

export type NarrativeTemporalReferenceKind =
  | "calendar-date"
  | "ambiguous-numeric-date"
  | "calendar-year"
  | "relative-order"
  | "relative-duration"
  | "day-period"
  | "clock-time";

export type NarrativeTemporalRelation =
  | "before"
  | "after"
  | "simultaneous"
  | "next-day-after"
  | "time-of-day"
  | "duration"
  | "unspecified";

export interface NarrativeTemporalReferenceCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly kind: NarrativeTemporalReferenceKind;
  readonly surface: string;
  readonly relation: NarrativeTemporalRelation;
  readonly normalizedDate?: string;
  readonly numericDateAmbiguity?: "day-month-order-not-established";
  readonly anchorRequired: boolean;
  readonly absoluteResolution: "explicit-calendar-value" | "unresolved-relative" | "ambiguous";
  readonly evidence: TextEvidence;
  readonly reviewStatus: "candidate";
}

export interface NarrativeTemporalReferenceDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly baseOffset?: number;
}

export const MAX_NARRATIVE_TEMPORAL_REFERENCE_CANDIDATES = 500;
export const MAX_NARRATIVE_TEMPORAL_TEXT_UNITS = 2_000_000;

interface Match {
  readonly start: number;
  readonly end: number;
  readonly kind: NarrativeTemporalReferenceKind;
  readonly relation: NarrativeTemporalRelation;
  readonly normalizedDate?: string;
  readonly numericDateAmbiguity?: "day-month-order-not-established";
  readonly anchorRequired: boolean;
  readonly absoluteResolution: NarrativeTemporalReferenceCandidate["absoluteResolution"];
  readonly priority: number;
}

const MONTHS: Readonly<Record<string, number>> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12
};

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function validate(input: NarrativeTemporalReferenceDiscoveryInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.projectId !== "string" || !input.projectId.trim() ||
      typeof input.documentId !== "string" || !input.documentId.trim() ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" ||
      input.text.length > MAX_NARRATIVE_TEMPORAL_TEXT_UNITS ||
      (input.baseOffset !== undefined &&
        (!Number.isSafeInteger(input.baseOffset) || input.baseOffset < 0 ||
         input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length))) {
    throw new Error("Contexto inválido para extraer referencias temporales.");
  }
}

function discoverMatches(text: string): readonly Match[] {
  const matches: Match[] = [];
  const add = (
    expression: RegExp,
    build: (match: RegExpMatchArray) => Omit<Match, "start" | "end">[]
  ) => {
    for (const match of text.matchAll(expression)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      for (const item of build(match)) matches.push({ start, end, ...item });
    }
  };

  add(/(?<![\p{L}\p{M}\p{N}_])(?<year>[0-9]{4})-(?<month>0?[1-9]|1[0-2])-(?<day>0?[1-9]|[12][0-9]|3[01])(?![\p{L}\p{M}\p{N}_])/gu, match => {
    const year = Number(match.groups!.year);
    const month = Number(match.groups!.month);
    const day = Number(match.groups!.day);
    return validDate(year, month, day) ? [{
      kind: "calendar-date", relation: "unspecified",
      normalizedDate: year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0"),
      anchorRequired: false, absoluteResolution: "explicit-calendar-value", priority: 100
    }] : [];
  });

  add(/(?<![\p{L}\p{M}\p{N}_])(?<day>0?[1-9]|[12][0-9]|3[01])\s+de\s+(?<month>enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+de\s+(?<year>[0-9]{4})(?![\p{L}\p{M}\p{N}_])/giu, match => {
    const day = Number(match.groups!.day);
    const month = MONTHS[match.groups!.month!.toLocaleLowerCase("es")]!;
    const year = Number(match.groups!.year);
    return validDate(year, month, day) ? [{
      kind: "calendar-date", relation: "unspecified",
      normalizedDate: year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0"),
      anchorRequired: false, absoluteResolution: "explicit-calendar-value", priority: 95
    }] : [];
  });

  add(/(?<![\p{L}\p{M}\p{N}_])(?:el\s+)?\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?![\p{L}\p{M}\p{N}_])/gu, () => [{
    kind: "ambiguous-numeric-date", relation: "unspecified",
    numericDateAmbiguity: "day-month-order-not-established",
    anchorRequired: false, absoluteResolution: "ambiguous", priority: 90
  }]);

  add(/(?<![\p{L}\p{M}\p{N}_])(?:en\s+)?(?<year>[0-9]{4})(?![\p{L}\p{M}\p{N}_])/gu, match =>
    Number(match.groups!.year) > 0 ? [{
      kind: "calendar-year", relation: "unspecified",
      anchorRequired: false, absoluteResolution: "explicit-calendar-value", priority: 40
    }] : []
  );

  const relative: readonly {
    expression: RegExp;
    relation: NarrativeTemporalRelation;
    kind: NarrativeTemporalReferenceKind;
    priority: number;
  }[] = [
    { expression: /\b(?:al\s+d[ií]a\s+siguiente|a\s+la\s+ma[nñ]ana\s+siguiente|el\s+d[ií]a\s+despu[eé]s)\b/giu, relation: "next-day-after", kind: "relative-order", priority: 85 },
    { expression: /\b(?:una|dos|tres|cuatro|cinco|varios?)\s+(?:d[ií]as?|semanas?|meses?|a[nñ]os?)\s+(?:despu[eé]s|m[aá]s\s+tarde|antes)\b/giu, relation: "duration", kind: "relative-duration", priority: 80 },
    { expression: /\b(?:desde\s+hace|durante|por)\s+(?:un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta|cuarenta|cincuenta|cien|varios?|\d+)\s+(?:d[ií]as?|semanas?|meses?|a[nñ]os?)\b/giu, relation: "duration", kind: "relative-duration", priority: 78 },
    { expression: /\b(?:al\s+cabo\s+de|dentro\s+de|hace)\s+(?:un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta|cuarenta|cincuenta|cien|varios?|\d+)\s+(?:d[ií]as?|semanas?|meses?|a[nñ]os?)\b/giu, relation: "after", kind: "relative-duration", priority: 78 },
    { expression: /\b(?:antes|previamente|con\s+anterioridad)\b/giu, relation: "before", kind: "relative-order", priority: 50 },
    { expression: /\b(?:despu[eé]s|luego|posteriormente|m[aá]s\s+tarde)\b/giu, relation: "after", kind: "relative-order", priority: 50 },
    { expression: /\b(?:mientras|al\s+mismo\s+tiempo|simult[aá]neamente)\b/giu, relation: "simultaneous", kind: "relative-order", priority: 50 },
    { expression: /\b(?:al\s+amanecer|al\s+atardecer|al\s+anochecer|al\s+mediod[ií]a|a\s+medianoche|por\s+la\s+ma[nñ]ana|por\s+la\s+tarde|por\s+la\s+noche|esa\s+noche|aquella\s+ma[nñ]ana)\b/giu, relation: "time-of-day", kind: "day-period", priority: 70 }
  ];
  for (const item of relative) {
    add(item.expression, match => [{
      kind: item.kind,
      relation: item.kind === "relative-duration"
        ? /^(?:desde\s+hace|durante|por)\s+/iu.test(match[0]) ? "duration"
          : /^(?:hace)\s+|antes$/iu.test(match[0]) ? "before" : "after"
        : item.relation,
      anchorRequired: true, absoluteResolution: "unresolved-relative", priority: item.priority
    }]);
  }

  add(/\b(?:a\s+las?\s+)?(?:[01]?[0-9]|2[0-3]):[0-5][0-9]\b/gu, () => [{
    kind: "clock-time", relation: "time-of-day",
    anchorRequired: true, absoluteResolution: "unresolved-relative", priority: 75
  }]);

  return matches.sort((a, b) =>
    a.start - b.start || b.priority - a.priority || (b.end - b.start) - (a.end - a.start)
  );
}

/**
 * Extrae referencias literales. Las expresiones relativas permanecen sin
 * fecha absoluta hasta que una capa de cronología aporte un ancla fiable.
 */
export function discoverNarrativeTemporalReferenceCandidates(
  input: NarrativeTemporalReferenceDiscoveryInput
): readonly NarrativeTemporalReferenceCandidate[] {
  validate(input);
  const baseOffset = input.baseOffset ?? 0;
  const accepted: Match[] = [];
  for (const match of discoverMatches(input.text)) {
    if (accepted.some(item => match.start < item.end && match.end > item.start)) continue;
    accepted.push(match);
    if (accepted.length >= MAX_NARRATIVE_TEMPORAL_REFERENCE_CANDIDATES) break;
  }
  return accepted.map(match => {
    const start = baseOffset + match.start;
    const end = baseOffset + match.end;
    const surface = input.text.slice(match.start, match.end);
    return {
      id: "temporal:" + input.documentId + ":" + input.revision + ":" + start + ":" + match.kind,
      projectId: input.projectId,
      documentId: input.documentId,
      revision: input.revision,
      kind: match.kind,
      surface,
      relation: match.relation,
      ...(match.normalizedDate ? { normalizedDate: match.normalizedDate } : {}),
      ...(match.numericDateAmbiguity ? { numericDateAmbiguity: match.numericDateAmbiguity } : {}),
      anchorRequired: match.anchorRequired,
      absoluteResolution: match.absoluteResolution,
      evidence: {
        documentId: input.documentId,
        revision: input.revision,
        start,
        end,
        excerpt: surface
      },
      reviewStatus: "candidate" as const
    };
  });
}
