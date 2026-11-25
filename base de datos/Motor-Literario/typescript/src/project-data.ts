/** Datos configurables del proyecto. Todos los valores son JSON local y aislado por projectId. */

export type ProjectJsonValue =
  | null
  | string
  | number
  | boolean
  | readonly ProjectJsonValue[]
  | { readonly [key: string]: ProjectJsonValue };

export type ProjectSettingSource = "WRITER" | "HOST";

export interface ProjectSetting {
  readonly projectId: string;
  readonly key: string;
  readonly value: ProjectJsonValue;
  readonly source: ProjectSettingSource;
  readonly updatedAt: number;
}

function validateJsonValue(
  value: unknown,
  depth: number,
  seen: Set<object>
): value is ProjectJsonValue {
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
    valid = (prototype === Object.prototype || prototype === null) &&
      Object.keys(value).length <= 10_000 &&
      Object.entries(value).every(([key, item]) =>
        key !== "__proto__" &&
        key !== "constructor" &&
        validateJsonValue(item, depth + 1, seen)
      );
  }
  seen.delete(value);
  return valid;
}

export function validateProjectSetting(
  setting: ProjectSetting,
  expectedProjectId?: string
): void {
  if (!setting ||
      typeof setting.projectId !== "string" || !setting.projectId.trim() ||
      (expectedProjectId !== undefined && setting.projectId !== expectedProjectId) ||
      typeof setting.key !== "string" || !setting.key.trim() || setting.key.length > 256 ||
      (setting.source !== "WRITER" && setting.source !== "HOST") ||
      typeof setting.updatedAt !== "number" || !Number.isFinite(setting.updatedAt) || setting.updatedAt < 0 ||
      !validateJsonValue(setting.value, 0, new Set())) {
    throw new Error("Configuración del proyecto inválida: identidad, origen, fecha o valor JSON incorrectos.");
  }
  const encoded = JSON.stringify(setting.value);
  if (typeof encoded !== "string" || encoded.length > 1_048_576) {
    throw new Error("Configuración del proyecto demasiado grande: máximo 1 MiB por valor.");
  }
}

export function cloneProjectSetting(setting: ProjectSetting): ProjectSetting {
  return structuredClone(setting);
}

export interface LanguageProfile {
  readonly projectId: string;
  readonly id: string;
  readonly languageIdentifier: string;
  readonly languageName: string;
  readonly regionalVariant?: string;
  /** REAL, FICTIONAL_DEVELOPED, FICTIONAL_OCCASIONAL u otro tipo futuro. */
  readonly profileKind: string;
  readonly editorialPreferences: ProjectJsonValue;
  /** Cobertura realmente verificada; no representa una promesa de corrección completa. */
  readonly coverageStatus: string;
  readonly isActive: boolean;
}

export interface LanguageResourceRef {
  readonly projectId: string;
  readonly id: string;
  readonly profileId?: string;
  readonly resourceDatabaseId: string;
  readonly resourceKind: string;
  readonly resourceSchemaVersion: string;
  readonly resourceStatus: string;
}

function requireNonBlank(value: unknown, label: string, maxLength = 512): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} debe ser un texto no vacío de hasta ${maxLength} caracteres.`);
  }
}

export function validateLanguageProfile(
  profile: LanguageProfile,
  expectedProjectId?: string
): void {
  if (!profile || typeof profile !== "object" ||
      typeof profile.projectId !== "string" || !profile.projectId.trim() ||
      (expectedProjectId !== undefined && profile.projectId !== expectedProjectId) ||
      typeof profile.id !== "string" || !profile.id.trim() || profile.id.length > 256 ||
      typeof profile.isActive !== "boolean") {
    throw new Error("Perfil lingüístico inválido: identidad, proyecto o indicador activo incorrectos.");
  }
  requireNonBlank(profile.languageIdentifier, "El identificador del idioma", 128);
  requireNonBlank(profile.languageName, "El nombre del idioma");
  requireNonBlank(profile.profileKind, "El tipo de perfil", 128);
  requireNonBlank(profile.coverageStatus, "El estado de cobertura", 256);
  if (profile.regionalVariant !== undefined &&
      (typeof profile.regionalVariant !== "string" || profile.regionalVariant.length > 256)) {
    throw new Error("La variante regional del perfil lingüístico es inválida.");
  }
  if (!validateJsonValue(profile.editorialPreferences, 0, new Set()) ||
      profile.editorialPreferences === null ||
      typeof profile.editorialPreferences !== "object" ||
      Array.isArray(profile.editorialPreferences)) {
    throw new Error("Las preferencias editoriales deben ser un objeto JSON válido.");
  }
  const encoded = JSON.stringify(profile.editorialPreferences);
  if (typeof encoded !== "string" || encoded.length > 1_048_576) {
    throw new Error("Las preferencias editoriales superan el máximo de 1 MiB.");
  }
}

export function validateLanguageResourceRef(
  resource: LanguageResourceRef,
  expectedProjectId?: string
): void {
  if (!resource || typeof resource !== "object" ||
      typeof resource.projectId !== "string" || !resource.projectId.trim() ||
      (expectedProjectId !== undefined && resource.projectId !== expectedProjectId) ||
      typeof resource.id !== "string" || !resource.id.trim() || resource.id.length > 256) {
    throw new Error("Referencia de recurso lingüístico inválida: identidad o proyecto incorrectos.");
  }
  requireNonBlank(resource.resourceDatabaseId, "El ID de base de recurso", 256);
  requireNonBlank(resource.resourceKind, "El tipo de recurso", 128);
  requireNonBlank(resource.resourceSchemaVersion, "La versión de esquema del recurso", 128);
  requireNonBlank(resource.resourceStatus, "El estado del recurso", 128);
  if (resource.profileId !== undefined &&
      (typeof resource.profileId !== "string" || !resource.profileId.trim() || resource.profileId.length > 256)) {
    throw new Error("El perfil asociado a la referencia de recurso es inválido.");
  }
}

export function cloneLanguageProfile(profile: LanguageProfile): LanguageProfile {
  return structuredClone(profile);
}

export function cloneLanguageResourceRef(resource: LanguageResourceRef): LanguageResourceRef {
  return structuredClone(resource);
}

export interface StyleProfile {
  readonly projectId: string;
  readonly id: string;
  readonly profileName: string;
  readonly styleData: ProjectJsonValue;
  readonly provenanceKind: string;
  readonly updatedAt: number;
}

export interface TimelineTrack {
  readonly projectId: string;
  readonly id: string;
  readonly trackName: string;
  readonly trackKind: string;
  readonly rules: ProjectJsonValue;
  readonly provenanceKind: string;
}

export function validateStyleProfile(
  profile: StyleProfile,
  expectedProjectId?: string
): void {
  if (!profile || typeof profile !== "object" ||
      typeof profile.projectId !== "string" || !profile.projectId.trim() ||
      (expectedProjectId !== undefined && profile.projectId !== expectedProjectId) ||
      typeof profile.id !== "string" || !profile.id.trim() || profile.id.length > 256 ||
      typeof profile.updatedAt !== "number" || !Number.isFinite(profile.updatedAt) || profile.updatedAt < 0) {
    throw new Error("Perfil de estilo inválido: identidad, proyecto o fecha incorrectos.");
  }
  requireNonBlank(profile.profileName, "El nombre del perfil de estilo");
  requireNonBlank(profile.provenanceKind, "La procedencia del perfil de estilo", 128);
  if (!validateJsonValue(profile.styleData, 0, new Set()) ||
      profile.styleData === null || typeof profile.styleData !== "object" ||
      Array.isArray(profile.styleData)) {
    throw new Error("Los datos del perfil de estilo deben ser un objeto JSON válido.");
  }
  if (JSON.stringify(profile.styleData).length > 1_048_576) {
    throw new Error("Los datos del perfil de estilo superan el máximo de 1 MiB.");
  }
}

export function validateTimelineTrack(
  track: TimelineTrack,
  expectedProjectId?: string
): void {
  if (!track || typeof track !== "object" ||
      typeof track.projectId !== "string" || !track.projectId.trim() ||
      (expectedProjectId !== undefined && track.projectId !== expectedProjectId) ||
      typeof track.id !== "string" || !track.id.trim() || track.id.length > 256) {
    throw new Error("Pista cronológica inválida: identidad o proyecto incorrectos.");
  }
  requireNonBlank(track.trackName, "El nombre de la pista cronológica");
  requireNonBlank(track.trackKind, "El tipo de pista cronológica", 128);
  requireNonBlank(track.provenanceKind, "La procedencia de la pista cronológica", 128);
  if (!validateJsonValue(track.rules, 0, new Set()) ||
      track.rules === null || typeof track.rules !== "object" || Array.isArray(track.rules)) {
    throw new Error("Las reglas de una pista cronológica deben ser un objeto JSON válido.");
  }
  if (JSON.stringify(track.rules).length > 1_048_576) {
    throw new Error("Las reglas de la pista cronológica superan el máximo de 1 MiB.");
  }
}

export function cloneStyleProfile(profile: StyleProfile): StyleProfile {
  return structuredClone(profile);
}

export function cloneTimelineTrack(track: TimelineTrack): TimelineTrack {
  return structuredClone(track);
}


/** Cambio inmutable de etiqueta o estado de una ficha narrativa. */
export interface RecordLifecycle {
  readonly projectId: string;
  readonly id: string;
  readonly recordId: string;
  /** Secuencia monotónica que comienza en 1 para cada ficha. */
  readonly revision: number;
  readonly previousLabel: string | null;
  readonly newLabel: string;
  readonly previousState: string | null;
  readonly newState: string;
  readonly changedBy: string;
  readonly changeReason?: string | null;
  readonly changedAt: number;
}

/** Cambio inmutable de etiqueta o estado de una relación narrativa. */
export interface RelationLifecycle {
  readonly projectId: string;
  readonly id: string;
  readonly relationId: string;
  readonly revision: number;
  readonly previousLabel: string | null;
  readonly newLabel: string;
  readonly previousState: string | null;
  readonly newState: string;
  readonly changedBy: string;
  readonly changeReason?: string | null;
  readonly changedAt: number;
}

function validateLifecycleShape(
  item: Record<string, unknown>,
  expectedProjectId: string | undefined,
  subjectKey: "recordId" | "relationId",
  label: string
): void {
  const subjectId = item[subjectKey];
  if (typeof item.projectId !== "string" || !item.projectId.trim() ||
      (expectedProjectId !== undefined && item.projectId !== expectedProjectId) ||
      typeof item.id !== "string" || !item.id.trim() || item.id.length > 256 ||
      typeof subjectId !== "string" || !subjectId.trim() || subjectId.length > 256 ||
      !Number.isSafeInteger(item.revision) || (item.revision as number) < 1 ||
      (item.previousLabel !== null &&
        (typeof item.previousLabel !== "string" || !item.previousLabel.trim() || item.previousLabel.length > 512)) ||
      typeof item.newLabel !== "string" || !item.newLabel.trim() || item.newLabel.length > 512 ||
      (item.previousState !== null &&
        (typeof item.previousState !== "string" || !item.previousState.trim() || item.previousState.length > 128)) ||
      typeof item.newState !== "string" || !item.newState.trim() || item.newState.length > 128 ||
      typeof item.changedBy !== "string" || !item.changedBy.trim() || item.changedBy.length > 256 ||
      (item.changeReason !== undefined && item.changeReason !== null &&
        (typeof item.changeReason !== "string" || item.changeReason.length > 4_096)) ||
      typeof item.changedAt !== "number" || !Number.isFinite(item.changedAt) || item.changedAt < 0) {
    throw new Error(`Registro de ciclo de vida de ${label} inválido: identidad, transición o fecha incorrectas.`);
  }
}

export function validateRecordLifecycle(
  item: RecordLifecycle,
  expectedProjectId?: string
): void {
  if (!item || typeof item !== "object") throw new Error("Registro de ciclo de vida de ficha inválido.");
  validateLifecycleShape(item as unknown as Record<string, unknown>, expectedProjectId, "recordId", "ficha");
}

export function validateRelationLifecycle(
  item: RelationLifecycle,
  expectedProjectId?: string
): void {
  if (!item || typeof item !== "object") throw new Error("Registro de ciclo de vida de relación inválido.");
  validateLifecycleShape(item as unknown as Record<string, unknown>, expectedProjectId, "relationId", "relación");
}

export function cloneRecordLifecycle(item: RecordLifecycle): RecordLifecycle {
  return structuredClone(item);
}

export function cloneRelationLifecycle(item: RelationLifecycle): RelationLifecycle {
  return structuredClone(item);
}
