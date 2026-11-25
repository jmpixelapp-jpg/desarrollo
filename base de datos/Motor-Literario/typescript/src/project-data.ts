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
