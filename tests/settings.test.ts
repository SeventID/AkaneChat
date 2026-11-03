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
      await saveSettings(path, { version: 1, provider: "openrouter", model: "some/model", councilModels: ["openai::gpt-test", "gemini::flash-test"], fallbackModels: ["groq::llama-test"], workspaceTools: false });
      const raw = await readFile(path, "utf8");
      expect(raw).not.toContain("apiKey");
      expect((await loadSettings(path))?.provider).toBe("openrouter");
      expect((await loadSettings(path))?.councilModels).toEqual(["openai::gpt-test", "gemini::flash-test"]);
      expect((await loadSettings(path))?.fallbackModels).toEqual(["groq::llama-test"]);
      expect((await loadSettings(path))?.workspaceTools).toBe(false);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("defaults workspace tools to enabled for older settings and preserves explicit true", async () => {
    const directory = await mkdtemp(join(tmpdir(), "akane-settings-"));
    const path = join(directory, "settings.json");
    try {
      await Bun.write(path, JSON.stringify({ version: 1, provider: "custom", model: "auto/chat" }));
      expect((await loadSettings(path))?.workspaceTools).toBeUndefined();
      await saveSettings(path, { version: 1, provider: "custom", model: "auto/chat", workspaceTools: true });
      expect((await loadSettings(path))?.workspaceTools).toBe(true);
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

test("persists explicit model capability metadata without credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "akane-settings-"));
  const path = join(directory, "settings.json");
  try {
    await saveSettings(path, { version: 1, provider: "custom", model: "chat", modelCapabilities: { "custom::vision-model": ["chat", "vision", "vision"], "custom::image-model": ["image_generation"] } });
    const settings = await loadSettings(path);
    expect(settings?.modelCapabilities?.["custom::vision-model"]).toEqual(["chat", "vision"]);
    expect(settings?.modelCapabilities?.["custom::image-model"]).toEqual(["image_generation"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects invalid capability metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "akane-settings-"));
  const path = join(directory, "settings.json");
  try {
    await Bun.write(path, JSON.stringify({ version: 1, provider: "custom", model: "chat", modelCapabilities: { "x": ["chat", "execute_shell"] } }));
    expect((await loadSettings(path))?.modelCapabilities).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
