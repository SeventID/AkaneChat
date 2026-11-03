import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getCustomProvider, listCustomProviders, normalizeCustomProviderId, saveCustomProvider } from "../src/custom-providers";
describe("multiple persistent custom providers", () => {
 test("stores independent endpoints and credentials in a private env file", async () => {
  const dir = await mkdtemp(join(import.meta.dir, "custom-providers-")); const path = join(dir, ".env");
  try {
   await saveCustomProvider(path, { id: "omni-route", name: "OmniRoute", baseUrl: "http://127.0.0.1:20128/v1", apiKey: "secret-one", model: "auto" });
   await saveCustomProvider(path, { id: "local-ai", name: "Local AI", baseUrl: "http://127.0.0.1:11434/v1", model: "llama" });
   const env = Object.fromEntries((await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => { const i = line.indexOf("="); return [line.slice(0,i), JSON.parse(line.slice(i+1))]; }));
   expect(getCustomProvider("omni-route", env)?.apiKey).toBe("secret-one");
   expect(getCustomProvider("local-ai", env)?.model).toBe("llama");
   expect(listCustomProviders(env).length).toBe(2);
   expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
 });
 test("rejects built-in IDs and unsafe identifiers", () => { expect(() => normalizeCustomProviderId("openai")).toThrow(); expect(() => normalizeCustomProviderId("../")).toThrow(); });
});
