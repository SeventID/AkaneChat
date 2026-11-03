import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyWorkspaceWrite, getAvailableWorkspaceToolDefinitions, getUnsupportedWorkspaceTool, listWorkspaceFiles, prepareWorkspaceWrite, readWorkspaceText, safeWorkspacePath, searchWorkspaceText, WORKSPACE_TOOL_DEFINITIONS } from "../src/workspace-tools";
import { tmpdir } from "node:os";

describe("workspace tool capability handling", () => {
  test("detects only explicitly named unsupported workspace tools", () => {
    expect(getUnsupportedWorkspaceTool(new Error("No endpoints found that support tool use. Try disabling 'list_files'."))).toBe("list_files");
    expect(getUnsupportedWorkspaceTool(new Error("No endpoints found that support tool use."))).toBeUndefined();
  });

  test("disables one tool without removing other tool definitions", () => {
    const remaining = getAvailableWorkspaceToolDefinitions(new Set(["list_files"])) as Array<{ function: { name: string } }>;
    expect(remaining.map((tool) => tool.function.name)).toEqual(["read_file", "search_files", "write_file"]);
    expect(WORKSPACE_TOOL_DEFINITIONS).toHaveLength(4);
  });
});

describe("workspace agent tools", () => {
  test("lists, reads, and searches workspace text", async () => {
    const root = await mkdtemp(join(tmpdir(), "akane-agent-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "app.ts"), "export const hello = 'world';\n");
      expect(await listWorkspaceFiles(root)).toEqual(["src/app.ts"]);
      expect(await readWorkspaceText(root, "src/app.ts")).toContain("hello");
      expect((await searchWorkspaceText(root, "world"))[0]).toContain("src/app.ts:1");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("blocks traversal, absolute paths, secrets, and symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "akane-agent-"));
    const outside = await mkdtemp(join(tmpdir(), "akane-agent-out-"));
    try {
      await writeFile(join(root, ".env"), "SECRET=hidden");
      await symlink(outside, join(root, "escape"));
      await expect(safeWorkspacePath(root, "../outside" )).rejects.toThrow("outside");
      await expect(safeWorkspacePath(root, "/etc/passwd")).rejects.toThrow("relative");
      await expect(readWorkspaceText(root, ".env")).rejects.toThrow("sensitive");
      await expect(readWorkspaceText(root, "escape/file")).rejects.toThrow("Symbolic");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("requires an explicit approval payload before applying file writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "akane-agent-"));
    try {
      const pending = await prepareWorkspaceWrite(root, "new/file.txt", "hello");
      expect(pending.existed).toBe(false);
      await applyWorkspaceWrite(root, pending);
      expect(await readFile(join(root, "new", "file.txt"), "utf8")).toBe("hello");
      const replacement = await prepareWorkspaceWrite(root, "new/file.txt", "updated");
      expect(replacement.existed).toBe(true);
      const result = await applyWorkspaceWrite(root, replacement);
      expect(await readFile(join(root, "new", "file.txt"), "utf8")).toBe("updated");
      expect(result.backupPath).toBeDefined();
      expect(await readFile(join(root, result.backupPath!), "utf8")).toBe("hello");
      await expect(listWorkspaceFiles(root)).resolves.toEqual(["new/file.txt"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
