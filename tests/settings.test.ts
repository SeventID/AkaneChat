import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, saveSettings } from "../src/storage/settings";

describe("app settings", () => {
  test("persists provider preferences without a credential field and restricts permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "akane-settings-"));
    const path = join(directory, "nested", "settings.json");
    try {
      await saveSettings(path, { version: 1, provider: "openrouter", model: "some/model", councilModels: ["openai::gpt-test", "gemini::flash-test"], fallbackModels: ["groq::llama-test"] });
      const raw = await readFile(path, "utf8");
      expect(raw).not.toContain("apiKey");
      expect((await loadSettings(path))?.provider).toBe("openrouter");
      expect((await loadSettings(path))?.councilModels).toEqual(["openai::gpt-test", "gemini::flash-test"]);
      expect((await loadSettings(path))?.fallbackModels).toEqual(["groq::llama-test"]);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("ignores malformed or unsupported settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "akane-settings-"));
    const path = join(directory, "settings.json");
    try {
      await Bun.write(path, '{"version":99,"provider":"x","model":"y"}');
      expect(await loadSettings(path)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
