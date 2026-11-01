import { describe, expect, test } from "bun:test";
import { checkModel, shouldFailover } from "../src/provider-health";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceFile, resolveWorkspacePath, writeWorkspaceFile, listWorkspaceDirectories } from "../src/workspace";

describe("provider health", () => {
  test("accepts a model that returns a first token", async () => {
    const client = { async *streamChat() { yield "OK"; } };
    expect(await checkModel(client)).toEqual({ ok: true });
  });
  test("rejects empty responses", async () => {
    const client = { async *streamChat() { yield ""; } };
    expect((await checkModel(client)).ok).toBe(false);
  });
  test("marks authentication failures permanent and transient failures retryable", async () => {
    const unauthorized = { async *streamChat() { throw Object.assign(new Error("Unauthorized"), { status: 401 }); } };
    const overloaded = { async *streamChat() { throw Object.assign(new Error("Overloaded"), { status: 503 }); } };
    expect((await checkModel(unauthorized)).retryable).toBe(false);
    expect((await checkModel(overloaded)).retryable).toBe(true);
  });
  test("does not fail over on authentication or invalid request errors", () => {
    expect(shouldFailover({ status: 401 })).toBe(false);
    expect(shouldFailover({ status: 400 })).toBe(false);
  });
  test("fails over on rate limits and transient outages", () => {
    expect(shouldFailover({ status: 429 })).toBe(true);
    expect(shouldFailover({ status: 503 })).toBe(true);
    expect(shouldFailover(new Error("connection reset"))).toBe(true);
  });
});

describe("workspace boundaries", () => {
  test("reads and writes files only inside the chosen workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "akane-workspace-"));
    try {
      await writeWorkspaceFile(root, "src/main.ts", "hello");
      expect(await readWorkspaceFile(root, "src/main.ts")).toBe("hello");
      await expect(resolveWorkspacePath(root, "../outside.txt")).rejects.toThrow("outside");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("refuses symlinks and lists only real directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "akane-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "akane-outside-"));
    try {
      await mkdir(join(root, "project"));
      await symlink(outside, join(root, "escape"));
      expect((await listWorkspaceDirectories(root)).map((entry) => entry.name)).toEqual(["project"]);
      await expect(resolveWorkspacePath(root, "escape/file")).rejects.toThrow("Symbolic");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
