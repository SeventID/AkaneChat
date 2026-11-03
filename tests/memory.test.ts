import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMemory, createEmptyMemory, forgetMemory, formatMemoryContext, loadMemory, saveMemory, selectRelevantMemories } from "../src/storage/memory";

describe("persistent memory", () => {
  test("requires explicit add, saves with private permissions, and reloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "akane-memory-")); const path = join(dir, "nested", "memory.json");
    try {
      const store = createEmptyMemory(); const entry = addMemory(store, "AkaneChat runs on Android Termux ARM64.");
      await saveMemory(path, store);
      expect((await loadMemory(path)).entries[0]?.text).toContain("Termux");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await readFile(path, "utf8"))).not.toContain("apiKey");
      expect(entry.id.length).toBeGreaterThan(8);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("blocks sensitive values and oversized notes", () => {
    const store = createEmptyMemory();
    expect(() => addMemory(store, "My API key is abc123")).toThrow();
    expect(() => addMemory(store, "My diagnosis is private")).toThrow();
    expect(() => addMemory(store, "x".repeat(501))).toThrow();
    expect(store.entries).toHaveLength(0);
  });
  test("selects relevant notes and formats bounded context", () => {
    const store = createEmptyMemory();
    addMemory(store, "Project AkaneChat targets Android Termux ARM64.");
    addMemory(store, "User prefers concise Indonesian answers.");
    expect(selectRelevantMemories(store, "Termux Android", 3)).toHaveLength(1);
    expect(formatMemoryContext(selectRelevantMemories(store, "Termux"))).toContain("User-approved");
    expect(selectRelevantMemories(store, "unrelated topic")).toHaveLength(0);
  });
  test("forget requires unique prefix and malformed files start empty", async () => {
    const store = createEmptyMemory(); const a = addMemory(store, "First note");
    expect(forgetMemory(store, "missing")).toBe(false);
    expect(forgetMemory(store, a.id.slice(0, 8))).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "akane-memory-bad-")); const path = join(dir, "memory.json");
    try { await Bun.write(path, "not-json"); expect((await loadMemory(path)).entries).toHaveLength(0); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
});
