/** Contratos y validación de diccionarios privados por proyecto. */

export type DictionaryJsonValue =
  | null | boolean | number | string
  | readonly DictionaryJsonValue[]
  | { readonly [key: string]: DictionaryJsonValue };

export interface ProjectDictionary {
  readonly projectId: string;
  readonly id: string;
  readonly languageIdentifier: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly description?: string;
  readonly kind: string;
  readonly provenanceKind: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProjectDictionaryInput {
  readonly id: string;
  readonly languageIdentifier: string;
  readonly name: string;
  readonly description?: string;
  readonly kind: string;
  readonly provenanceKind: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}


/** Vínculo explícito entre una entrada de diccionario y una ficha del mismo libro. */
export interface DictionaryEntryEntityLink {
  readonly projectId: string;
  readonly entryId: string;
  readonly recordId: string;
  readonly linkKind: string;
  readonly provenanceKind: string;
  readonly createdAt: number;
}

export function validateDictionaryEntryEntityLink(
  value: unknown,
  expectedProjectId?: string,
  expectedEntryId?: string
): asserts value is DictionaryEntryEntityLink {
  if (!value || typeof value !== "object") {
    throw new Error("Vínculo de entrada y ficha inválido.");
  }
  const item = value as Record<string, unknown>;
  if (!validIdentifier(item.projectId) ||
      (expectedProjectId !== undefined && item.projectId !== expectedProjectId) ||
      !validIdentifier(item.entryId) ||
      (expectedEntryId !== undefined && item.entryId !== expectedEntryId) ||
      !validIdentifier(item.recordId) ||
      !validIdentifier(item.linkKind) ||
      !validIdentifier(item.provenanceKind) ||
      !validTimestamp(item.createdAt)) {
    throw new Error("Vínculo de diccionario malformado: proyecto, entrada, ficha, tipo, procedencia o fecha inválidos.");
  }
}

export const cloneDictionaryEntryEntityLink = (
  item: DictionaryEntryEntityLink
): DictionaryEntryEntityLink => structuredClone(item);

export interface DictionaryEntry {
  readonly projectId: string;
  readonly id: string;
  readonly dictionaryId: string;
  readonly surfaceForm: string;
  readonly normalizedForm: string;
  readonly definition: string;
  readonly pronunciation?: string;
  readonly grammaticalCategory?: string;
  readonly attributes: { readonly [key: string]: DictionaryJsonValue };
  readonly status: string;
  readonly provenanceKind: string;
  readonly relatedEntityIds: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DictionaryEntryInput {
  readonly id: string;
  readonly dictionaryId: string;
  readonly surfaceForm: string;
  readonly definition: string;
  readonly pronunciation?: string;
  readonly grammaticalCategory?: string;
  readonly attributes?: { readonly [key: string]: DictionaryJsonValue };
  readonly status: string;
  readonly provenanceKind: string;
  readonly relatedEntityIds?: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function normalizeDictionaryName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function normalizeDictionarySurface(value: string): string {
  return normalizeDictionaryName(value);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateJsonValue(value: unknown, depth: number, seen: Set<object>): value is DictionaryJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 32 || seen.has(value)) return false;
  seen.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    valid = value.length <= 10_000 &&
      value.every(item => validateJsonValue(item, depth + 1, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) valid = false;
    else {
      const entries = Object.entries(value as Record<string, unknown>);
      valid = entries.length <= 10_000 && entries.every(([key, item]) =>
        key !== "__proto__" && key !== "prototype" && key !== "constructor" &&
        validateJsonValue(item, depth + 1, seen)
      );
    }
  }
  seen.delete(value);
  return valid;
}

export function validateDictionaryAttributes(
  value: unknown,
  label = "atributos del diccionario"
): asserts value is { readonly [key: string]: DictionaryJsonValue } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !validateJsonValue(value, 0, new Set()) || Object.keys(value).length > 10_000) {
    throw new Error(`Registro de ${label} inválido: debe ser un objeto JSON plano y finito.`);
  }
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch { throw new Error(`Registro de ${label} inválido: no se puede serializar como JSON.`); }
  if (serialized.length > 262_144) {
    throw new Error(`Registro de ${label} inválido: supera el límite de 256 KiB.`);
  }
}

export function validateProjectDictionary(value: unknown, label = "diccionario"): asserts value is ProjectDictionary {
  if (!value || typeof value !== "object") throw new Error(`Registro de ${label} inválido.`);
  const item = value as Record<string, unknown>;
  if (!validIdentifier(item.projectId) || !validIdentifier(item.id) ||
      !validIdentifier(item.languageIdentifier) || !validIdentifier(item.name) ||
      item.name.length > 512 || typeof item.normalizedName !== "string" ||
      item.normalizedName !== normalizeDictionaryName(item.name) ||
      !validIdentifier(item.kind) || !validIdentifier(item.provenanceKind) ||
      (item.description !== undefined &&
        (typeof item.description !== "string" || item.description.length > 16_384)) ||
      !validTimestamp(item.createdAt) || !validTimestamp(item.updatedAt) ||
      item.updatedAt < item.createdAt) {
    throw new Error(`Registro de ${label} malformado: identidad, idioma, nombre, procedencia o fechas inválidas.`);
  }
}

export function validateDictionaryEntry(value: unknown, label = "entrada de diccionario"): asserts value is DictionaryEntry {
  if (!value || typeof value !== "object") throw new Error(`Registro de ${label} inválido.`);
  const item = value as Record<string, unknown>;
  if (!validIdentifier(item.projectId) || !validIdentifier(item.id) ||
      !validIdentifier(item.dictionaryId) ||
      typeof item.surfaceForm !== "string" || !item.surfaceForm.trim() || item.surfaceForm.length > 1_024 ||
      typeof item.normalizedForm !== "string" ||
      item.normalizedForm !== normalizeDictionarySurface(item.surfaceForm) ||
      typeof item.definition !== "string" || !item.definition.trim() || item.definition.length > 1_048_576 ||
      (item.pronunciation !== undefined &&
        (typeof item.pronunciation !== "string" || item.pronunciation.length > 4_096)) ||
      (item.grammaticalCategory !== undefined &&
        (typeof item.grammaticalCategory !== "string" || item.grammaticalCategory.length > 256)) ||
      !validIdentifier(item.status) || !validIdentifier(item.provenanceKind) ||
      !Array.isArray(item.relatedEntityIds) ||
      item.relatedEntityIds.some(id => !validIdentifier(id)) ||
      new Set(item.relatedEntityIds).size !== item.relatedEntityIds.length ||
      !validTimestamp(item.createdAt) || !validTimestamp(item.updatedAt) ||
      item.updatedAt < item.createdAt) {
    throw new Error(`Registro de ${label} malformado: campos, vínculos o fechas inválidas.`);
  }
  validateDictionaryAttributes(item.attributes, label);
}
