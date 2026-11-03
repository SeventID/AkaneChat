import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProviderDefinition } from "./providers/registry";

export interface CustomProviderConfig { id: string; name: string; baseUrl: string; apiKey?: string; model: string }
const PREFIX = "AKANECHAT_CUSTOM_";
export function normalizeCustomProviderId(value: string): string {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id) || ["openai", "openrouter", "groq", "ollama", "anthropic", "gemini", "custom"].includes(id)) throw new Error("Provider ID must be 1–40 letters/numbers/hyphens and cannot use a built-in ID.");
  return id;
}
function key(id: string, field: string): string { return `${PREFIX}${id.toUpperCase().replace(/-/g, "_")}_${field}`; }
function quote(value: string): string { return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`; }
export async function saveCustomProvider(envPath: string, input: CustomProviderConfig): Promise<void> {
  const id = normalizeCustomProviderId(input.id);
  const values: Record<string, string> = { [key(id, "NAME")]: input.name, [key(id, "BASE_URL")]: input.baseUrl, [key(id, "MODEL")]: input.model };
  if (input.apiKey) values[key(id, "API_KEY")] = input.apiKey;
  let current = "";
  try { current = await readFile(envPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const lines = current.split(/\r?\n/);
  const updated = new Set<string>();
  const output = lines.map((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/);
    if (!match || !(match[1]! in values)) return line;
    const envName = match[1]!; updated.add(envName); return `${envName}=${quote(values[envName]!)}`;
  });
  for (const [envName, value] of Object.entries(values)) if (!updated.has(envName)) output.push(`${envName}=${quote(value)}`);
  await mkdir(dirname(envPath), { recursive: true, mode: 0o700 });
  const temp = `${envPath}.${process.pid}.tmp`;
  await writeFile(temp, `${output.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, envPath);
  for (const [envName, value] of Object.entries(values)) process.env[envName] = value;
}
export function getCustomProvider(idValue: string, env: NodeJS.ProcessEnv = process.env): CustomProviderConfig | undefined {
  let id: string; try { id = normalizeCustomProviderId(idValue); } catch { return undefined; }
  const baseUrl = env[key(id, "BASE_URL")]; const model = env[key(id, "MODEL")];
  if (!baseUrl || !model) return undefined;
  return { id, name: env[key(id, "NAME")] || id, baseUrl, model, ...(env[key(id, "API_KEY")] ? { apiKey: env[key(id, "API_KEY")] } : {}) };
}
export function listCustomProviders(env: NodeJS.ProcessEnv = process.env): CustomProviderConfig[] {
  const ids = new Set<string>();
  for (const name of Object.keys(env)) { const match = name.match(/^AKANECHAT_CUSTOM_([A-Z0-9_]+)_BASE_URL$/); if (match) ids.add(match[1]!.toLowerCase().replace(/_/g, "-")); }
  return [...ids].map((id) => getCustomProvider(id, env)).filter((item): item is CustomProviderConfig => Boolean(item)).sort((a, b) => a.id.localeCompare(b.id));
}
export function customProviderDefinition(config: CustomProviderConfig): ProviderDefinition {
  return { id: config.id, name: config.name, kind: "openai-compatible", baseUrl: config.baseUrl, requiresApiKey: false, description: "Saved custom OpenAI-compatible endpoint" };
}
