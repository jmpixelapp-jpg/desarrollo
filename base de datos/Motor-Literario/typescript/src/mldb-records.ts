/** Contratos de almacenamiento para las tablas MLDB de uso general. */
import type { ProjectJsonValue } from "./project-data";


export type ProjectRecordLabel = "IDEA" | "REGISTRADO EN LA OBRA";
export type ProjectRecordState = "abierto" | "cerrado";

/** Registro genérico MLDB. primaryName puede ser null: el motor no inventa nombres. */
export interface ProjectRecord {
  readonly projectId: string;
  readonly id: string;
  readonly recordType: string;
  readonly primaryName: string | null;
  readonly description: string | null;
  readonly label: ProjectRecordLabel;
  readonly state: ProjectRecordState;
  readonly confidence: string;
  readonly confirmationKind: string;
  readonly provenanceKind: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly currentVersion: number;
}

export interface ProjectRecordInput {
  readonly id: string;
  readonly recordType: string;
  readonly primaryName?: string | null;
  readonly description?: string | null;
  readonly label: ProjectRecordLabel;
  readonly state: ProjectRecordState;
  readonly confidence: string;
  readonly confirmationKind: string;
  readonly provenanceKind: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RecordName {
  readonly projectId: string;
  readonly id: string;
  readonly recordId: string;
  readonly name: string;
  readonly nameKind: string;
  readonly languageCode?: string | null;
  readonly isPrimary: boolean;
  readonly provenanceKind: string;
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateProjectRecord(item: ProjectRecord, expectedProjectId?: string): void {
  if (!item || typeof item !== "object") throw new Error("Ficha MLDB inválida.");
  projectId(item.projectId, expectedProjectId);
  nonBlank(item.id, "El ID de ficha", 256);
  nonBlank(item.recordType, "El tipo de ficha", 128);
  if (item.primaryName !== null &&
      (typeof item.primaryName !== "string" || !item.primaryName.trim() || item.primaryName.length > 1_024)) {
    throw new Error("El nombre principal debe ser texto no vacío o null.");
  }
  if (item.description !== null &&
      (typeof item.description !== "string" || item.description.length > 65_536)) {
    throw new Error("La descripción de la ficha debe ser texto o null y no superar 64 KiB.");
  }
  if (item.label !== "IDEA" && item.label !== "REGISTRADO EN LA OBRA") {
    throw new Error("La etiqueta de ficha debe ser IDEA o REGISTRADO EN LA OBRA.");
  }
  if (item.state !== "abierto" && item.state !== "cerrado") {
    throw new Error("El estado de ficha debe ser abierto o cerrado.");
  }
  nonBlank(item.confidence, "La confianza de ficha", 128);
  nonBlank(item.confirmationKind, "La clase de confirmación", 128);
  nonBlank(item.provenanceKind, "La procedencia de ficha", 128);
  if (!finiteTimestamp(item.createdAt) || !finiteTimestamp(item.updatedAt) ||
      item.updatedAt < item.createdAt ||
      !Number.isSafeInteger(item.currentVersion) || item.currentVersion < 1) {
    throw new Error("Las fechas o la versión vigente de la ficha son inválidas.");
  }
}

export function validateRecordName(item: RecordName, expectedProjectId?: string): void {
  if (!item || typeof item !== "object") throw new Error("Nombre alternativo de ficha inválido.");
  projectId(item.projectId, expectedProjectId);
  nonBlank(item.id, "El ID del nombre", 256);
  nonBlank(item.recordId, "La ficha del nombre", 256);
  nonBlank(item.name, "El nombre alternativo", 1_024);
  nonBlank(item.nameKind, "El tipo de nombre", 128);
  if (item.languageCode !== undefined && item.languageCode !== null) {
    nonBlank(item.languageCode, "El código de idioma", 64);
  }
  if (typeof item.isPrimary !== "boolean") throw new Error("El indicador de nombre principal debe ser booleano.");
  nonBlank(item.provenanceKind, "La procedencia del nombre", 128);
}

export const cloneProjectRecord = (item: ProjectRecord): ProjectRecord => structuredClone(item);
export const cloneRecordName = (item: RecordName): RecordName => structuredClone(item);

export interface ManuscriptFragment {
  readonly projectId: string;
  readonly id: string;
  readonly documentId?: string | null;
  readonly parentFragmentId?: string | null;
  readonly fragmentKind: string;
  readonly currentText?: string | null;
  readonly startOffset?: number | null;
  readonly endOffset?: number | null;
  readonly revision: number;
  readonly isCurrent: boolean;
}

export interface RecordAttribute {
  readonly projectId: string;
  readonly id: string;
  readonly recordId: string;
  readonly attributeKey: string;
  readonly value: ProjectJsonValue;
  readonly valueStatus: string;
  readonly provenanceKind: string;
  readonly confidence: string;
}

export interface RelationAttribute {
  readonly projectId: string;
  readonly id: string;
  readonly relationId: string;
  readonly attributeKey: string;
  readonly value: ProjectJsonValue;
  readonly provenanceKind: string;
  readonly confidence: string;
}

export type ActiveSuggestionStatus =
  | "ACTIVE" | "OBSOLETE" | "ACCEPTED" | "REJECTED" | "IGNORED" | "EXPIRED";

export interface ActiveSuggestion {
  readonly projectId: string;
  readonly id: string;
  readonly moduleId: string;
  readonly documentId?: string | null;
  readonly fragmentId?: string | null;
  readonly documentRevision?: number | null;
  readonly suggestionKind: string;
  readonly priority: string;
  readonly confidence: string;
  readonly payload: ProjectJsonValue;
  readonly status: ActiveSuggestionStatus;
  readonly createdAt: number;
}

export interface ImportAuthorization {
  readonly authorizationId: string;
  readonly writerId: string;
  readonly sourceProjectId: string;
  readonly targetProjectId: string;
  readonly authorizedBy: "WRITER";
  /** Alcance exacto, explícito y revisable por el anfitrión. */
  readonly scope: ProjectJsonValue;
  readonly authorizedAt: number;
}

export interface SchemaMigration {
  readonly migrationId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly appliedAt: number;
  readonly result: string;
  readonly checksum: string;
}

function isJsonValue(value: unknown, depth = 0, seen = new Set<object>()): value is ProjectJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 32 || seen.has(value)) return false;
  seen.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = value.length <= 10_000 && value.every(item => isJsonValue(item, depth + 1, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    valid = (prototype === Object.prototype || prototype === null) &&
      Object.entries(value as Record<string, unknown>).every(([key, item]) =>
        key !== "__proto__" && key !== "constructor" && key !== "prototype" &&
        isJsonValue(item, depth + 1, seen)
      );
  }
  seen.delete(value);
  return valid;
}

function nonBlank(value: unknown, label: string, max = 512): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label} debe ser un texto no vacío de hasta ${max} caracteres.`);
  }
}

function projectId(value: unknown, expected?: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 ||
      (expected !== undefined && value !== expected)) {
    throw new Error("El identificador o ámbito del proyecto es inválido.");
  }
}

function validateJson(value: unknown, label: string): asserts value is ProjectJsonValue {
  if (!isJsonValue(value) || JSON.stringify(value).length > 1_048_576) {
    throw new Error(`${label} debe ser JSON finito, serializable y de hasta 1 MiB.`);
  }
}

export function validateManuscriptFragment(
  item: ManuscriptFragment,
  expectedProjectId?: string
): void {
  if (!item || typeof item !== "object") throw new Error("Fragmento de manuscrito inválido.");
  projectId(item.projectId, expectedProjectId);
  nonBlank(item.id, "El ID del fragmento", 256);
  nonBlank(item.fragmentKind, "El tipo de fragmento", 128);
  if (item.documentId !== undefined && item.documentId !== null) nonBlank(item.documentId, "El documento", 256);
  if (item.parentFragmentId !== undefined && item.parentFragmentId !== null) {
    nonBlank(item.parentFragmentId, "El fragmento padre", 256);
    if (item.parentFragmentId === item.id) throw new Error("Un fragmento no puede ser su propio padre.");
  }
  if (item.currentText !== undefined && item.currentText !== null && typeof item.currentText !== "string") {
    throw new Error("El texto actual del fragmento debe ser texto o null.");
  }
  const start = item.startOffset ?? null;
  const end = item.endOffset ?? null;
  if ((start === null) !== (end === null) ||
      (start !== null && (!Number.isSafeInteger(start) || start < 0)) ||
      (end !== null && (!Number.isSafeInteger(end) || end < (start as number))) ||
      !Number.isSafeInteger(item.revision) || item.revision < 0 ||
      typeof item.isCurrent !== "boolean") {
    throw new Error("Los offsets, revisión o estado actual del fragmento son inválidos.");
  }
}

export function validateRecordAttribute(item: RecordAttribute, expectedProjectId?: string): void {
  if (!item || typeof item !== "object") throw new Error("Atributo de ficha inválido.");
  projectId(item.projectId, expectedProjectId);
  nonBlank(item.id, "El ID del atributo", 256);
  nonBlank(item.recordId, "La ficha del atributo", 256);
  nonBlank(item.attributeKey, "La clave del atributo", 256);
  nonBlank(item.valueStatus, "El estado del valor", 128);
  nonBlank(item.provenanceKind, "La procedencia del atributo", 128);
  nonBlank(item.confidence, "La confianza del atributo", 128);
  validateJson(item.value, "El valor del atributo");
}

export function validateRelationAttribute(item: RelationAttribute, expectedProjectId?: string): void {
  if (!item || typeof item !== "object") throw new Error("Atributo de relación inválido.");
  projectId(item.projectId, expectedProjectId);
  nonBlank(item.id, "El ID del atributo relacional", 256);
  nonBlank(item.relationId, "La relación del atributo", 256);
  nonBlank(item.attributeKey, "La clave del atributo relacional", 256);
  nonBlank(item.provenanceKind, "La procedencia del atributo relacional", 128);
  nonBlank(item.confidence, "La confianza del atributo relacional", 128);
  validateJson(item.value, "El valor del atributo relacional");
}

export function validateActiveSuggestion(item: ActiveSuggestion, expectedProjectId?: string): void {
  if (!item || typeof item !== "object") throw new Error("Sugerencia activa inválida.");
  projectId(item.projectId, expectedProjectId);
  nonBlank(item.id, "El ID de la sugerencia", 256);
  nonBlank(item.moduleId, "El módulo de la sugerencia", 128);
  if (item.documentId !== undefined && item.documentId !== null) nonBlank(item.documentId, "El documento de la sugerencia", 256);
  if (item.fragmentId !== undefined && item.fragmentId !== null) nonBlank(item.fragmentId, "El fragmento de la sugerencia", 256);
  if (item.documentRevision !== undefined && item.documentRevision !== null &&
      (!Number.isSafeInteger(item.documentRevision) || item.documentRevision < 0)) {
    throw new Error("La revisión del documento de la sugerencia es inválida.");
  }
  if (item.fragmentId != null && item.documentId == null) {
    throw new Error("Una sugerencia asociada a un fragmento debe identificar también el documento.");
  }
  nonBlank(item.suggestionKind, "El tipo de sugerencia", 128);
  nonBlank(item.priority, "La prioridad de la sugerencia", 128);
  nonBlank(item.confidence, "La confianza de la sugerencia", 128);
  if (!["ACTIVE", "OBSOLETE", "ACCEPTED", "REJECTED", "IGNORED", "EXPIRED"].includes(item.status)) {
    throw new Error("El estado de la sugerencia es inválido.");
  }
  if (!Number.isFinite(item.createdAt) || item.createdAt < 0) {
    throw new Error("La fecha de creación de la sugerencia es inválida.");
  }
  validateJson(item.payload, "El contenido de la sugerencia");
}

export function validateImportAuthorization(item: ImportAuthorization, expectedWriterId?: string): void {
  if (!item || typeof item !== "object") throw new Error("Autorización de importación inválida.");
  nonBlank(item.authorizationId, "El ID de la autorización", 256);
  nonBlank(item.writerId, "El escritor de la autorización", 256);
  if (expectedWriterId !== undefined && item.writerId !== expectedWriterId) {
    throw new Error("La autorización no pertenece al escritor autenticado.");
  }
  nonBlank(item.sourceProjectId, "El proyecto de origen", 256);
  nonBlank(item.targetProjectId, "El proyecto de destino", 256);
  if (item.sourceProjectId === item.targetProjectId || item.authorizedBy !== "WRITER") {
    throw new Error("La autorización debe ser explícita, escrita y entre proyectos distintos.");
  }
  if (!Number.isFinite(item.authorizedAt) || item.authorizedAt < 0) {
    throw new Error("La fecha de autorización es inválida.");
  }
  validateJson(item.scope, "El alcance de la autorización");
  if (!item.scope || typeof item.scope !== "object" || Array.isArray(item.scope)) {
    throw new Error("El alcance de importación debe ser un objeto JSON explícito.");
  }
}

export function validateSchemaMigration(item: SchemaMigration): void {
  if (!item || typeof item !== "object") throw new Error("Registro de migración inválido.");
  nonBlank(item.migrationId, "El ID de la migración", 256);
  nonBlank(item.fromVersion, "La versión de origen", 64);
  nonBlank(item.toVersion, "La versión de destino", 64);
  nonBlank(item.result, "El resultado de la migración", 64);
  nonBlank(item.checksum, "La huella de la migración", 256);
  if (!Number.isFinite(item.appliedAt) || item.appliedAt < 0) {
    throw new Error("La fecha de aplicación de la migración es inválida.");
  }
}

export const cloneManuscriptFragment = (item: ManuscriptFragment): ManuscriptFragment => structuredClone(item);
export const cloneRecordAttribute = (item: RecordAttribute): RecordAttribute => structuredClone(item);
export const cloneRelationAttribute = (item: RelationAttribute): RelationAttribute => structuredClone(item);
export const cloneActiveSuggestion = (item: ActiveSuggestion): ActiveSuggestion => structuredClone(item);
export const cloneImportAuthorization = (item: ImportAuthorization): ImportAuthorization => structuredClone(item);
export const cloneSchemaMigration = (item: SchemaMigration): SchemaMigration => structuredClone(item);
