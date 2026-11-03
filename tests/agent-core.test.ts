import { describe, expect, test } from "bun:test";
import { buildAgentSystemPrompt, createToolCallGuard } from "../src/agent-core";

describe("Akane Agent Core", () => {
  test("builds operational instructions with workspace and safety boundaries", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: "/tmp/project" });
    expect(prompt).toContain("/tmp/project");
    expect(prompt).toContain("dependency order");
    expect(prompt).toContain("verify the result");
    expect(prompt).toContain("Never claim a file was changed");
    expect(prompt).toContain("Do not expose hidden chain-of-thought");
  });

  test("counts calls and blocks a third identical call regardless of key order", () => {
    const guard = createToolCallGuard({ maxCalls: 8, maxRepeatedCalls: 2 });
    expect(guard.check("read_file", { path: "a.ts", mode: "text" }).allowed).toBe(true);
    expect(guard.check("read_file", { mode: "text", path: "a.ts" }).allowed).toBe(true);
    const blocked = guard.check("read_file", { path: "a.ts", mode: "text" });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("Repeated identical");
    expect(guard.stats()).toEqual({ totalCalls: 3, uniqueCalls: 1, maxCalls: 8, maxRepeatedCalls: 2 });
  });

  test("stops tool calls after the response-wide limit", () => {
    const guard = createToolCallGuard({ maxCalls: 2 });
    expect(guard.check("list_files", {}).allowed).toBe(true);
    expect(guard.check("read_file", { path: "a" }).allowed).toBe(true);
    const blocked = guard.check("search_files", { query: "x" });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("limit reached");
  });
});
