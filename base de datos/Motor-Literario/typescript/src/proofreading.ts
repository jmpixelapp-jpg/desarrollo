import type { Diagnostic } from "./contracts";

const WORD = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu;

/**
 * Primera capa de corrección determinista, original y explicable.
 * Nunca modifica el texto: devuelve diagnósticos y reemplazos opcionales.
 */
export function proofreadFragment(
  text: string,
  absoluteOffset = 0,
  revision = 0,
  maxDiagnostics = 256
): Diagnostic[] {
  if (!Number.isSafeInteger(maxDiagnostics) || maxDiagnostics < 1) {
    throw new RangeError("maxDiagnostics debe ser un entero positivo.");
  }
  const found: Diagnostic[] = [];
  const add = (ruleId: string, message: string, start: number, end: number, replacement?: string) => {
    found.push({
      id: `${ruleId}:${revision}:${absoluteOffset + start}`,
      ruleId,
      severity: "warning",
      message,
      start: absoluteOffset + start,
      end: absoluteOffset + end,
      revision,
      ...(replacement === undefined ? {} : { replacement })
    });
  };

  // Palabras consecutivas repetidas.
  const words = [...text.matchAll(WORD)];
  for (let i = 1; i < words.length; i++) {
    const previous = words[i - 1];
    const current = words[i];
    if (!previous || !current || previous.index === undefined || current.index === undefined) continue;
    if (previous[0].toLocaleLowerCase() === current[0].toLocaleLowerCase()) {
      const between = text.slice(previous.index + previous[0].length, current.index);
      if (/^\s+$/.test(between)) {
        add("repeated-word", `Posible repetición de «${current[0]}».`, current.index, current.index + current[0].length, "");
      }
    }
  }

  // Espacio antes de signos de puntuación.
  for (const match of text.matchAll(/ +([,.;:!?])/g)) {
    if (match.index === undefined) continue;
    const punctuation = match[1] ?? "";
    add("space-before-punctuation", "No suele escribirse un espacio antes de este signo de puntuación.", match.index, match.index + match[0].length, punctuation);
  }

  // Falta de espacio después de coma, punto y coma o dos puntos.
  for (const match of text.matchAll(/([,;:])(?=\S)/g)) {
    if (match.index === undefined) continue;
    const sign = match[1] ?? "";
    add("missing-space-after-punctuation", "Puede faltar un espacio después del signo de puntuación.", match.index + 1, match.index + 1, " ");
  }

  // Espacios dobles dentro de una línea.
  for (const match of text.matchAll(/[^\S\r\n]{2,}/g)) {
    if (match.index === undefined) continue;
    add("multiple-spaces", "Hay varios espacios consecutivos.", match.index, match.index + match[0].length, " ");
  }

  // Inicio de oración en minúscula: heurística conservadora.
  for (const match of text.matchAll(/(?:^|[.!?]\s+)([a-záéíóúüñ])/g)) {
    if (match.index === undefined) continue;
    const letterOffset = match.index + match[0].length - 1;
    const letter = match[1] ?? "";
    add("lowercase-sentence-start", "La oración podría comenzar con mayúscula.", letterOffset, letterOffset + 1, letter.toLocaleUpperCase());
  }

  return found.slice(0, maxDiagnostics);
}
