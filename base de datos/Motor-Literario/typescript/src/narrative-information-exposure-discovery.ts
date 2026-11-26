/**
 * Detecta señales explícitas de exposición de información en la voz narrativa.
 * No estima el estado mental real del lector ni resuelve por sí solo la focalización.
 */
import type { NarrativeEntity, TextEvidence } from "./narrative-knowledge";

export type NarrativeInformationExposureSignal =
  | "secret-is-that"
  | "truth-is-that"
  | "character-unaware-that";
export interface NarrativeInformationExposureCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly signal: NarrativeInformationExposureSignal;
  readonly propositionEvidence: TextEvidence;
  readonly triggerEvidence: TextEvidence;
  readonly evidence: TextEvidence;
  readonly subjectEntityId?: string;
  readonly subjectEvidence?: TextEvidence;
  readonly presentation: "proposition-explicitly-presented-in-narrative-text";
  readonly readerKnowledge: "not-established";
  readonly focalization: "unresolved";
  readonly reviewStatus: "candidate";
}
export interface NarrativeInformationExposureDiscoveryInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly entities: readonly NarrativeEntity[];
  readonly baseOffset?: number;
  /** Rangos de discurso directo ya identificados; se excluyen para no atribuirlos a la voz narrativa. */
  readonly excludedDialogueEvidence?: readonly TextEvidence[];
}
export const MAX_NARRATIVE_INFORMATION_EXPOSURE_TEXT_UNITS = 2_000_000;
export const MAX_NARRATIVE_INFORMATION_EXPOSURE_ENTITIES = 5_000;
export const MAX_NARRATIVE_INFORMATION_EXPOSURE_CANDIDATES = 1_000;
export const MAX_NARRATIVE_INFORMATION_EXPOSURE_ALIASES = 100;
export const MAX_NARRATIVE_INFORMATION_EXPOSURE_NAME_UNITS = 256;
export const MAX_NARRATIVE_INFORMATION_EXPOSURE_PROPOSITION_UNITS = 500;
export const MAX_NARRATIVE_INFORMATION_EXPOSURE_SCAN_UNITS = 25_000_000;

interface Match {
  readonly signal: NarrativeInformationExposureSignal;
  readonly triggerStart: number;
  readonly triggerEnd: number;
  readonly propositionStart: number;
  readonly propositionEnd: number;
  readonly subject?: NarrativeEntity;
  readonly subjectStart?: number;
  readonly subjectEnd?: number;
}
function evidence(input: NarrativeInformationExposureDiscoveryInput, start: number, end: number): TextEvidence {
  const base = input.baseOffset ?? 0;
  return { documentId: input.documentId, revision: input.revision,
    start: base + start, end: base + end, excerpt: input.text.slice(start, end) };
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$|[\]\\{}()]/gu, "\\$&");
}
function validate(input: NarrativeInformationExposureDiscoveryInput): void {
  if (!input || typeof input !== "object" || typeof input.projectId !== "string" ||
      !input.projectId.trim() || typeof input.documentId !== "string" ||
      !input.documentId.trim() || !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.text !== "string" || input.text.length > MAX_NARRATIVE_INFORMATION_EXPOSURE_TEXT_UNITS ||
      !Array.isArray(input.entities) || input.entities.length > MAX_NARRATIVE_INFORMATION_EXPOSURE_ENTITIES ||
      (input.baseOffset !== undefined && (!Number.isSafeInteger(input.baseOffset) ||
        input.baseOffset < 0 || input.baseOffset > Number.MAX_SAFE_INTEGER - input.text.length)) ||
      (input.excludedDialogueEvidence !== undefined && !Array.isArray(input.excludedDialogueEvidence))) {
    throw new Error("Contexto inválido para descubrir exposición de información narrativa.");
  }
  const ids = new Set<string>();
  for (const entity of input.entities) {
    if (!entity || entity.projectId !== input.projectId || typeof entity.id !== "string" ||
        !entity.id.trim() || ids.has(entity.id) || typeof entity.canonicalName !== "string" ||
        !entity.canonicalName.trim() || entity.canonicalName.length > MAX_NARRATIVE_INFORMATION_EXPOSURE_NAME_UNITS ||
        !Array.isArray(entity.aliases) || entity.aliases.length > MAX_NARRATIVE_INFORMATION_EXPOSURE_ALIASES ||
        entity.aliases.some(alias => typeof alias !== "string" || !alias.trim() ||
          alias.length > MAX_NARRATIVE_INFORMATION_EXPOSURE_NAME_UNITS)) {
      throw new Error("Entidades inválidas, duplicadas o ajenas al proyecto.");
    }
    ids.add(entity.id);
  }
  for (const item of input.excludedDialogueEvidence ?? []) {
    if (!item || item.documentId !== input.documentId || item.revision !== input.revision ||
        !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) ||
        item.start < (input.baseOffset ?? 0) ||
        item.end > (input.baseOffset ?? 0) + input.text.length ||
        item.end <= item.start || typeof item.excerpt !== "string" ||
        item.excerpt.length !== item.end - item.start ||
        item.excerpt !== input.text.slice(item.start - (input.baseOffset ?? 0), item.end - (input.baseOffset ?? 0)) ||
        item.status === "stale") {
      throw new Error("La evidencia de diálogo excluida no pertenece al fragmento actual.");
    }
  }
}
function isExcluded(start: number, end: number, excluded: readonly TextEvidence[]): boolean {
  return excluded.some(item => start < item.end && item.start < end);
}
function sentenceBounds(text: string, start: number, end: number): {start:number;end:number} {
  let left = start, right = end;
  while (left > 0 && !/[.!?;\n]/u.test(text[left - 1]!)) left--;
  while (right < text.length && !/[.!?;\n]/u.test(text[right]!)) right++;
  while (left < right && /\s/u.test(text[left]!)) left++;
  while (right > left && /\s/u.test(text[right - 1]!)) right--;
  return { start: left, end: right };
}
function cleanProposition(text: string, start: number, end: number): {start:number;end:number} | undefined {
  while (start < end && /\s/u.test(text[start]!)) start++;
  while (end > start && /[\s,;:]+/u.test(text[end - 1]!)) end--;
  return end > start && end - start <= MAX_NARRATIVE_INFORMATION_EXPOSURE_PROPOSITION_UNITS
    ? {start,end} : undefined;
}
/**
 * Solo acepta marcadores léxicos explícitos: «el secreto era que», «la verdad
 * era que» y «sin que [personaje] supiera que». No transforma ausencia de
 * mención en desconocimiento ni diálogos en narración.
 */
export function discoverNarrativeInformationExposureCandidates(
  input: NarrativeInformationExposureDiscoveryInput
): readonly NarrativeInformationExposureCandidate[] {
  validate(input);
  const excluded = input.excludedDialogueEvidence ?? [];
  const characters = input.entities.filter(entity => entity.kind === "character");
  const nameCount = characters.reduce((sum, entity) => sum + 1 + entity.aliases.length, 0);
  const scanCost = input.text.length * Math.max(1, nameCount);
  if (!Number.isSafeInteger(scanCost) || scanCost > MAX_NARRATIVE_INFORMATION_EXPOSURE_SCAN_UNITS) {
    throw new Error("La búsqueda de exposición supera el presupuesto; divide el manuscrito por capítulos.");
  }
  const matches: Match[] = [];
  const globalPatterns: readonly {
    signal: NarrativeInformationExposureSignal; expression: RegExp;
  }[] = [
    { signal: "secret-is-that", expression: /\b(?:el\s+secreto|su\s+secreto)\s+(?:era|es)\s+que\s+/giu },
    { signal: "truth-is-that", expression: /\b(?:la\s+verdad|lo\s+cierto)\s+(?:era|es)\s+que\s+/giu }
  ];
  for (const {signal,expression} of globalPatterns) {
    expression.lastIndex = 0;
    for (const match of input.text.matchAll(expression)) {
      const triggerStart = match.index!;
      const proposition = cleanProposition(input.text, triggerStart + match[0].length,
        sentenceBounds(input.text, triggerStart, triggerStart + match[0].length).end);
      if (!proposition) continue;
      matches.push({signal,triggerStart,triggerEnd:triggerStart+match[0].length,
        propositionStart:proposition.start,propositionEnd:proposition.end});
    }
  }
  for (const entity of characters) {
    for (const name of new Set([entity.canonicalName,...entity.aliases])) {
      const expression = new RegExp("\\bsin\\s+que\\s+("+escapeRegExp(name)+
        ")\\s+(?:supiera|supiese|sab[ií]a|conociera|conociese)\\s+que\\s+","giu");
      expression.lastIndex = 0;
      for (const match of input.text.matchAll(expression)) {
        const start = match.index!;
        const subjectStart = start + match[0].indexOf(match[1]!);
        const propositionStartRaw = start + match[0].length;
        const bounds = sentenceBounds(input.text,start,propositionStartRaw);
        const proposition = cleanProposition(input.text,propositionStartRaw,bounds.end);
        if (!proposition) continue;
        matches.push({signal:"character-unaware-that",triggerStart:start,
          triggerEnd:propositionStartRaw,propositionStart:proposition.start,
          propositionEnd:proposition.end,subject:entity,subjectStart,
          subjectEnd:subjectStart+match[1]!.length});
      }
    }
  }
  const output: NarrativeInformationExposureCandidate[] = [];
  const seen = new Set<string>();
  for (const match of matches.sort((a,b)=>a.triggerStart-b.triggerStart||a.signal.localeCompare(b.signal))) {
    const bounds = sentenceBounds(input.text,match.triggerStart,match.propositionEnd);
    if (isExcluded(bounds.start,bounds.end,excluded)) continue;
    const key = [match.signal,match.triggerStart,match.propositionStart,match.subject?.id ?? ""].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    if (output.length >= MAX_NARRATIVE_INFORMATION_EXPOSURE_CANDIDATES) {
      throw new Error("La extracción supera el límite de exposición; divide el manuscrito por capítulos.");
    }
    const base = input.baseOffset ?? 0;
    output.push({
      id:"information-exposure:"+input.documentId+":"+input.revision+":"+(base+match.triggerStart)+":"+match.signal,
      projectId:input.projectId,documentId:input.documentId,revision:input.revision,signal:match.signal,
      propositionEvidence:evidence(input,match.propositionStart,match.propositionEnd),
      triggerEvidence:evidence(input,match.triggerStart,match.triggerEnd),
      evidence:evidence(input,bounds.start,bounds.end),
      ...(match.subject ? {subjectEntityId:match.subject.id,
        subjectEvidence:evidence(input,match.subjectStart!,match.subjectEnd!)} : {}),
      presentation:"proposition-explicitly-presented-in-narrative-text",
      readerKnowledge:"not-established",focalization:"unresolved",reviewStatus:"candidate"
    });
  }
  return output.sort((a,b)=>a.evidence.start-b.evidence.start||a.id.localeCompare(b.id));
}
