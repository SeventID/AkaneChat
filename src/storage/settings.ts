import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AppSettings {
  version: 1;
  provider: string;
  model: string;
  baseUrl?: string;
  councilModels?: string[];
  fallbackModels?: string[];
  workspace?: string;
}

export async function loadSettings(path: string): Promise<AppSettings | undefined> {
  try {
    const value = JSON.parse(await Bun.file(path).text()) as Partial<AppSettings>;
    if (value.version !== 1 || typeof value.provider !== "string" || typeof value.model !== "string") return undefined;
    return {
      version: 1,
      provider: value.provider,
      model: value.model,
      ...(typeof value.baseUrl === "string" ? { baseUrl: value.baseUrl } : {}),
      ...(Array.isArray(value.councilModels) && value.councilModels.every((item) => typeof item === "string") ? { councilModels: value.councilModels.slice(0, 4) } : {}),
      ...(Array.isArray(value.fallbackModels) && value.fallbackModels.every((item) => typeof item === "string") ? { fallbackModels: value.fallbackModels.slice(0, 3) } : {}),
      ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Stores non-secret preferences only; API keys must remain in environment variables. */
export async function saveSettings(path: string, settings: AppSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
