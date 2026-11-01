import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConversation,
  createEmptyStore,
  getActiveConversation,
  loadConversationStore,
  saveConversationStore,
  switchConversation,
} from "../src/storage/conversations";

let directory = "";
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
});

async function tempFile(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "akanechat-store-"));
  return join(directory, "history.json");
}

describe("conversation store", () => {
  test("creates and switches between conversations without losing messages", () => {
    const store = createEmptyStore();
    const first = getActiveConversation(store);
    first.messages.push({ role: "user", content: "keep me" });
    const second = createConversation(store);
    expect(second.id).not.toBe(first.id);
    expect(switchConversation(store, first.id.slice(0, 8))?.messages[0]?.content).toBe("keep me");
    expect(store.conversations).toHaveLength(2);
  });

  test("persists store atomically with restrictive file permissions", async () => {
    const path = await tempFile();
    const store = createEmptyStore();
    getActiveConversation(store).messages.push({ role: "assistant", content: "saved" });
    await saveConversationStore(path, store);
    const loaded = await loadConversationStore(path);
    expect(getActiveConversation(loaded).messages[0]?.content).toBe("saved");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("migrates the legacy single-conversation history format", async () => {
    const path = await tempFile();
    await Bun.write(path, JSON.stringify({ messages: [{ role: "user", content: "legacy" }], updatedAt: "2026-01-01T00:00:00.000Z" }));
    const loaded = await loadConversationStore(path);
    expect(loaded.conversations).toHaveLength(1);
    expect(getActiveConversation(loaded).title).toBe("Imported conversation");
    expect(getActiveConversation(loaded).messages[0]?.content).toBe("legacy");
  });

  test("does not switch when an id prefix is ambiguous or missing", () => {
    const store = createEmptyStore();
    const original = store.activeId;
    expect(switchConversation(store, "missing")).toBeUndefined();
    expect(store.activeId).toBe(original);
  });
});
