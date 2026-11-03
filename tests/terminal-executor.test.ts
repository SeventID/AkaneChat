import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTerminalCheck, TERMINAL_CHECKS } from "../src/terminal-executor";

describe("restricted terminal executor", () => {
  test("exposes only fixed safe project checks", () => {
    expect(TERMINAL_CHECKS).toEqual(["typecheck", "test", "build", "diff"]);
  });
  test("rejects shell syntax, arbitrary commands, and arguments", async () => {
    for (const value of ["rm -rf /", "test; whoami", "typecheck --watch", "../typecheck", ""]) {
      await expect(runTerminalCheck("/tmp", value)).rejects.toThrow("Unsupported check");
    }
  });
  test("runs the selected fixed check in the requested workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "akane-terminal-"));
    try {
      await mkdir(join(dir, "tests"));
      await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "node -e \"process.stdout.write('ok')\"" } }));
      const result = await runTerminalCheck(dir, "typecheck");
      expect(result.command).toBe("bun run typecheck");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("ok");
      expect(result.timedOut).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
